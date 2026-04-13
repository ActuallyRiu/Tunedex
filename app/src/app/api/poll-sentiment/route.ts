import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE     = SUPA_URL + '/rest/v1'
const SH       = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }

const LASTFM_KEY      = process.env.LASTFM_API_KEY || ''
const YOUTUBE_KEY     = process.env.YOUTUBE_API_KEY || ''
const SPOTIFY_ID      = process.env.SPOTIFY_CLIENT_ID || ''
const SPOTIFY_SECRET  = process.env.SPOTIFY_CLIENT_SECRET || ''

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)) }
function logNorm(v: number, ceiling: number) { return v <= 0 ? 0 : clamp(Math.log1p(v) / Math.log1p(ceiling), 0, 1) }

// ── Spotify ──────────────────────────────────────────────────────────────────

let spotifyToken = ''
let spotifyTokenExpiry = 0

async function getSpotifyToken(): Promise<string> {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(SPOTIFY_ID + ':' + SPOTIFY_SECRET),
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(5000),
  })
  const d = await res.json()
  spotifyToken = d.access_token || ''
  spotifyTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000 - 60000
  return spotifyToken
}

async function getSpotifyData(artistName: string, cachedSpotifyId?: string | null): Promise<{
  spotifyId: string; popularity: number; followers: number; score: number
} | null> {
  if (!SPOTIFY_ID || !SPOTIFY_SECRET) return null
  try {
    const token = await getSpotifyToken()
    if (!token) return null

    let artistData: any = null

    // Use cached Spotify ID if available — faster and more accurate
    if (cachedSpotifyId) {
      const r = await fetch(`https://api.spotify.com/v1/artists/${cachedSpotifyId}`, {
        headers: { 'Authorization': 'Bearer ' + token },
        signal: AbortSignal.timeout(5000),
      })
      if (r.ok) artistData = await r.json()
    }

    // Fall back to search if no cached ID or lookup failed
    if (!artistData) {
      const searchRes = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`,
        { headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(5000) }
      )
      if (!searchRes.ok) return null
      const searchData = await searchRes.json()
      artistData = searchData.artists?.items?.[0]
    }

    if (!artistData) return null

    const popularity = artistData.popularity || 0      // 0-100, Spotify's own momentum-weighted score
    const followers  = artistData.followers?.total || 0

    // Score: popularity is already momentum-weighted (recent streams count more)
    // Normalise popularity to 0-1 and give it 80% weight, follower velocity 20%
    const popScore  = popularity / 100
    const follScore = logNorm(followers, 50_000_000)
    const score     = clamp(popScore * 0.8 + follScore * 0.2, 0, 1)

    return { spotifyId: artistData.id, popularity, followers, score }
  } catch { return null }
}

// ── Last.fm ───────────────────────────────────────────────────────────────────

async function getLastfmData(artistName: string): Promise<{ listeners: number; score: number } | null> {
  if (!LASTFM_KEY) return null
  try {
    const res = await fetch(
      `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_KEY}&format=json`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return null
    const d = await res.json()
    const listeners = parseInt(d.artist?.stats?.listeners || '0')
    const playcount = parseInt(d.artist?.stats?.playcount || '0')
    const playsPerListener = listeners > 0 ? playcount / listeners : 0
    // Cap engagement score — high replay of classic albums ≠ current heat
    const engagementScore = clamp(playsPerListener / 30, 0, 0.5)
    const listenerScore   = logNorm(listeners, 10_000_000) * 0.5
    return { listeners, score: clamp(listenerScore + engagementScore, 0, 0.7) }
  } catch { return null }
}

// ── YouTube ───────────────────────────────────────────────────────────────────

async function getYoutubeData(artistName: string): Promise<{ score: number } | null> {
  if (!YOUTUBE_KEY) return null
  try {
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(artistName)}&type=video&order=date&maxResults=5&key=${YOUTUBE_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!searchRes.ok) return null
    const searchData = await searchRes.json()
    const videoIds = (searchData.items || []).map((v: any) => v.id?.videoId).filter(Boolean).join(',')
    if (!videoIds) return null

    const statsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${YOUTUBE_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!statsRes.ok) return null
    const statsData = await statsRes.json()
    const videos = statsData.items || []
    if (!videos.length) return null

    let totalViews = 0, totalLikes = 0
    for (const v of videos) {
      totalViews += parseInt(v.statistics?.viewCount  || '0')
      totalLikes += parseInt(v.statistics?.likeCount  || '0')
    }
    const avgViews    = totalViews / videos.length
    const likeRatio   = avgViews > 0 ? totalLikes / totalViews : 0
    const viewScore   = logNorm(avgViews, 5_000_000)
    const score       = clamp(viewScore * 0.6 + clamp(likeRatio * 30, 0, 1) * 0.4, 0, 1)
    return { score }
  } catch { return null }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function GET() {
  const started = Date.now()

  const artistRows: Array<{ id: string; name: string; spotify_id: string | null }> =
    await fetch(BASE + '/artists?select=id,name,spotify_id&limit=2000', { headers: SH }).then(r => r.json())

  let processed = 0, sentimentWritten = 0, streamingWritten = 0

  const BATCH = 5
  for (let i = 0; i < artistRows.length; i += BATCH) {
    if (Date.now() - started > 52000) break

    const batch = artistRows.slice(i, i + BATCH)
    await Promise.all(batch.map(async artist => {
      try {
        const [spotify, lastfm, youtube] = await Promise.all([
          getSpotifyData(artist.name, artist.spotify_id),
          getLastfmData(artist.name),
          getYoutubeData(artist.name),
        ])

        // ── Write streaming signal from Spotify ──
        if (spotify) {
          // Cache Spotify ID on artist row if not already set
          if (!artist.spotify_id) {
            await fetch(BASE + '/artists?id=eq.' + artist.id, {
              method: 'PATCH', headers: SH,
              body: JSON.stringify({ spotify_id: spotify.spotifyId })
            }).catch(() => {})
          }

          // Write to artist_streaming_signals
          await fetch(BASE + '/artist_streaming_signals?on_conflict=artist_id', {
            method: 'POST',
            headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({
              artist_id:         artist.id,
              captured_at:       new Date().toISOString(),
              spotify_listeners: spotify.followers,  // using followers as listener proxy
              spotify_popularity: spotify.popularity,
            })
          }).catch(() => {})
          streamingWritten++
        }

        // ── Write sentiment signal ──
        const scores: number[] = []
        const weights: number[] = []
        if (spotify) { scores.push(spotify.score);  weights.push(0.5) }
        if (lastfm)  { scores.push(lastfm.score);   weights.push(0.3) }
        if (youtube) { scores.push(youtube.score);  weights.push(0.2) }

        if (scores.length > 0) {
          const totalW    = weights.reduce((a, b) => a + b, 0)
          const sentScore = scores.reduce((sum, s, i) => sum + s * weights[i], 0) / totalW
          const afinnAvg  = clamp((sentScore - 0.5) * 2, -1, 1)

          await fetch(BASE + '/artist_sentiment_signals?on_conflict=artist_id', {
            method: 'POST',
            headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({
              artist_id:        artist.id,
              captured_at:      new Date().toISOString(),
              afinn_avg:        Math.round(afinnAvg * 1000) / 1000,
              sentiment_score:  Math.round(sentScore * 100) / 100,
              mention_count_7d: lastfm ? Math.round(lastfm.listeners / 1000) : 0,
              is_controversy:   false,
            })
          }).catch(() => {})
          sentimentWritten++
        }

        processed++
      } catch {}
    }))
  }

  return NextResponse.json({
    ok: true, processed, sentiment_written: sentimentWritten, streaming_written: streamingWritten,
    sources: { spotify: !!SPOTIFY_ID, lastfm: !!LASTFM_KEY, youtube: !!YOUTUBE_KEY },
    elapsed_ms: Date.now() - started,
  })
}
