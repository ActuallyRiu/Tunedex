import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE     = SUPA_URL + '/rest/v1'
const SH       = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }

const LASTFM_KEY     = process.env.LASTFM_API_KEY || ''
const YOUTUBE_KEY    = process.env.YOUTUBE_API_KEY || ''
const SPOTIFY_ID_ENV = process.env.SPOTIFY_CLIENT_ID || ''
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET || ''

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)) }
function logNorm(v: number, ceiling: number) { return v <= 0 ? 0 : clamp(Math.log1p(v) / Math.log1p(ceiling), 0, 1) }

// ── Spotify token (module-level cache) ───────────────────────────────────────
let _spotifyToken = ''
let _spotifyExpiry = 0

async function getSpotifyToken(): Promise<string> {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(SPOTIFY_ID_ENV + ':' + SPOTIFY_SECRET) },
      body: 'grant_type=client_credentials', signal: AbortSignal.timeout(8000),
    })
    const d = await r.json()
    _spotifyToken  = d.access_token || ''
    _spotifyExpiry = Date.now() + ((d.expires_in || 3600) * 1000) - 60000
    return _spotifyToken
  } catch { return '' }
}

// Fetch up to 50 artists by Spotify ID in one batch call
async function fetchSpotifyBatch(ids: string[]): Promise<Map<string, { popularity: number; followers: number }>> {
  const result = new Map<string, { popularity: number; followers: number }>()
  if (!ids.length || !SPOTIFY_ID_ENV) return result
  try {
    const token = await getSpotifyToken()
    if (!token) return result
    const r = await fetch(`https://api.spotify.com/v1/artists?ids=${ids.slice(0, 50).join(',')}`, {
      headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(8000)
    })
    if (!r.ok) return result
    const d = await r.json()
    for (const a of (d.artists || [])) {
      if (a?.id) result.set(a.id, { popularity: a.popularity || 0, followers: a.followers?.total || 0 })
    }
  } catch {}
  return result
}

// Search for a single artist by name to get their Spotify ID
async function searchSpotifyId(name: string): Promise<string | null> {
  if (!SPOTIFY_ID_ENV) return null
  try {
    const token = await getSpotifyToken()
    if (!token) return null
    const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=1`, {
      headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(6000)
    })
    if (!r.ok) return null
    const d = await r.json()
    return d.artists?.items?.[0]?.id || null
  } catch { return null }
}

// ── Last.fm ───────────────────────────────────────────────────────────────────
async function getLastfmScore(name: string): Promise<number> {
  if (!LASTFM_KEY) return 0
  try {
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(name)}&api_key=${LASTFM_KEY}&format=json`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return 0
    const d = await r.json()
    const listeners = parseInt(d.artist?.stats?.listeners || '0')
    const playcount = parseInt(d.artist?.stats?.playcount || '0')
    const ppl = listeners > 0 ? playcount / listeners : 0
    // Cap engagement — catalogue replay ≠ current heat
    return clamp(logNorm(listeners, 10_000_000) * 0.4 + clamp(ppl / 30, 0, 0.3), 0, 0.6)
  } catch { return 0 }
}

// ── YouTube ───────────────────────────────────────────────────────────────────
async function getYoutubeScore(name: string): Promise<number> {
  if (!YOUTUBE_KEY) return 0
  try {
    const s = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(name)}&type=video&order=date&maxResults=5&key=${YOUTUBE_KEY}`, { signal: AbortSignal.timeout(5000) })
    if (!s.ok) return 0
    const sd = await s.json()
    const ids = (sd.items || []).map((v: any) => v.id?.videoId).filter(Boolean).join(',')
    if (!ids) return 0
    const st = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${YOUTUBE_KEY}`, { signal: AbortSignal.timeout(5000) })
    if (!st.ok) return 0
    const vids = (await st.json()).items || []
    if (!vids.length) return 0
    let views = 0, likes = 0
    for (const v of vids) { views += parseInt(v.statistics?.viewCount || '0'); likes += parseInt(v.statistics?.likeCount || '0') }
    const avgViews  = views / vids.length
    const likeRatio = views > 0 ? likes / views : 0
    return clamp(logNorm(avgViews, 5_000_000) * 0.6 + clamp(likeRatio * 30, 0, 1) * 0.4, 0, 1)
  } catch { return 0 }
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function GET() {
  const started = Date.now()
  const DEADLINE = 52000

  const artists: Array<{ id: string; name: string; spotify_id: string | null }> =
    await fetch(BASE + '/artists?select=id,name,spotify_id&limit=2000', { headers: SH }).then(r => r.json())

  // ── Phase 1: Batch fetch Spotify data for all artists with cached IDs ──
  const withId    = artists.filter(a => a.spotify_id)
  const withoutId = artists.filter(a => !a.spotify_id)
  const spotifyMap = new Map<string, { popularity: number; followers: number }>() // artistId -> data

  // Batch of 50 IDs per call — very fast
  for (let i = 0; i < withId.length; i += 50) {
    if (Date.now() - started > DEADLINE) break
    const chunk      = withId.slice(i, i + 50)
    const spotifyIds = chunk.map(a => a.spotify_id!).filter(Boolean)
    const results    = await fetchSpotifyBatch(spotifyIds)
    // Map back: spotify_id -> artist_id
    for (const a of chunk) {
      if (a.spotify_id && results.has(a.spotify_id)) {
        spotifyMap.set(a.id, results.get(a.spotify_id)!)
      }
    }
    await new Promise(r => setTimeout(r, 100)) // 100ms between batch calls
  }

  // ── Phase 2: Search for artists without a cached Spotify ID (throttled) ──
  // Process up to 50 uncached artists per run — spread across multiple cycles
  const toSearch = withoutId.slice(0, 50)
  const newIds: Array<{ id: string; spotify_id: string }> = []

  for (const artist of toSearch) {
    if (Date.now() - started > DEADLINE) break
    const sid = await searchSpotifyId(artist.name)
    if (sid) {
      // Fetch data immediately
      const data = await fetchSpotifyBatch([sid])
      if (data.has(sid)) spotifyMap.set(artist.id, data.get(sid)!)
      newIds.push({ id: artist.id, spotify_id: sid })
    }
    await new Promise(r => setTimeout(r, 200)) // 200ms between searches
  }

  // Cache new Spotify IDs in artists table
  if (newIds.length > 0) {
    for (const { id, spotify_id } of newIds) {
      await fetch(BASE + '/artists?id=eq.' + id, {
        method: 'PATCH', headers: SH, body: JSON.stringify({ spotify_id })
      }).catch(() => {})
    }
  }

  // ── Phase 3: Write streaming signals for all artists with Spotify data ──
  let streamingWritten = 0
  for (const [artistId, data] of spotifyMap.entries()) {
    if (Date.now() - started > DEADLINE) break
    await fetch(BASE + '/artist_streaming_signals?on_conflict=artist_id', {
      method: 'POST',
      headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        artist_id:          artistId,
        captured_at:        new Date().toISOString(),
        spotify_listeners:  data.followers,
        spotify_popularity: data.popularity,
      })
    }).catch(() => {})
    streamingWritten++
  }

  // ── Phase 4: Sentiment signals (LastFM + YouTube) in parallel batches ──
  let sentimentWritten = 0
  const BATCH = 8
  for (let i = 0; i < artists.length; i += BATCH) {
    if (Date.now() - started > DEADLINE) break
    const batch = artists.slice(i, i + BATCH)
    await Promise.all(batch.map(async artist => {
      try {
        const spotify = spotifyMap.get(artist.id)
        const [lfScore, ytScore] = await Promise.all([
          getLastfmScore(artist.name),
          getYoutubeScore(artist.name),
        ])
        // Composite: Spotify 50%, LastFM 30%, YouTube 20%
        const scores: number[] = []
        const wts: number[]    = []
        if (spotify)    { scores.push(spotify.popularity / 100); wts.push(0.5) }
        if (lfScore > 0){ scores.push(lfScore);                  wts.push(0.3) }
        if (ytScore > 0){ scores.push(ytScore);                  wts.push(0.2) }
        if (!scores.length) return

        const totalW    = wts.reduce((a, b) => a + b, 0)
        const sentScore = clamp(scores.reduce((s, v, i) => s + v * wts[i], 0) / totalW, 0, 1)
        const afinnAvg  = clamp((sentScore - 0.5) * 2, -1, 1)

        await fetch(BASE + '/artist_sentiment_signals?on_conflict=artist_id', {
          method: 'POST',
          headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            artist_id: artist.id, captured_at: new Date().toISOString(),
            afinn_avg: Math.round(afinnAvg * 1000) / 1000,
            sentiment_score: Math.round(sentScore * 100) / 100,
            mention_count_7d: 0, is_controversy: false,
          })
        }).catch(() => {})
        sentimentWritten++
      } catch {}
    }))
  }

  return NextResponse.json({
    ok: true,
    spotify_cached: withId.length, spotify_searched: toSearch.length, new_ids_found: newIds.length,
    streaming_written: streamingWritten, sentiment_written: sentimentWritten,
    sources: { spotify: !!SPOTIFY_ID_ENV, lastfm: !!LASTFM_KEY, youtube: !!YOUTUBE_KEY },
    elapsed_ms: Date.now() - started,
  })
}
