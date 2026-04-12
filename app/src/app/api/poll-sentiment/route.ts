import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE     = SUPA_URL + '/rest/v1'
const SH       = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }

const LASTFM_KEY   = process.env.LASTFM_API_KEY || ''
const YOUTUBE_KEY  = process.env.YOUTUBE_API_KEY || ''

// ── Sentiment helpers ────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)) }

/** Normalise a raw count to 0–1 using log scale */
function logNorm(v: number, ceiling: number) {
  if (v <= 0) return 0
  return clamp(Math.log1p(v) / Math.log1p(ceiling), 0, 1)
}

// ── Last.fm ──────────────────────────────────────────────────────────────────

async function getLastfmSentiment(artistName: string): Promise<{
  listeners: number; playcount: number; score: number
} | null> {
  if (!LASTFM_KEY) return null
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_KEY}&format=json`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const d = await res.json()
    const artist = d.artist
    if (!artist) return null

    const listeners = parseInt(artist.stats?.listeners || '0')
    const playcount = parseInt(artist.stats?.playcount || '0')

    // plays per listener = engagement depth (how much people replay = positive sentiment)
    const playsPerListener = listeners > 0 ? playcount / listeners : 0

    // Score: normalise listeners (ceiling 10M) + plays-per-listener bonus
    const listenerScore   = logNorm(listeners, 10_000_000)
    const engagementScore = clamp(playsPerListener / 20, 0, 1) // 20+ plays per listener = maxed

    // Combined: weighted toward engagement (that's the sentiment signal, not just reach)
    const score = clamp(listenerScore * 0.4 + engagementScore * 0.6, 0, 1)

    return { listeners, playcount, score }
  } catch { return null }
}

// ── YouTube ──────────────────────────────────────────────────────────────────

async function getYoutubeSentiment(artistName: string): Promise<{
  viewVelocity: number; likeRatio: number; score: number
} | null> {
  if (!YOUTUBE_KEY) return null
  try {
    // Search for artist's recent videos
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(artistName)}&type=video&order=date&maxResults=5&key=${YOUTUBE_KEY}`
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) })
    if (!searchRes.ok) return null
    const searchData = await searchRes.json()
    const videoIds = (searchData.items || []).map((v: any) => v.id?.videoId).filter(Boolean).join(',')
    if (!videoIds) return null

    // Get stats for those videos
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${YOUTUBE_KEY}`
    const statsRes = await fetch(statsUrl, { signal: AbortSignal.timeout(5000) })
    if (!statsRes.ok) return null
    const statsData = await statsRes.json()
    const videos = statsData.items || []

    if (videos.length === 0) return null

    // Aggregate: total views, likes across recent videos
    let totalViews = 0, totalLikes = 0, totalComments = 0
    for (const v of videos) {
      totalViews    += parseInt(v.statistics?.viewCount    || '0')
      totalLikes    += parseInt(v.statistics?.likeCount    || '0')
      totalComments += parseInt(v.statistics?.commentCount || '0')
    }

    const avgViews    = totalViews    / videos.length
    const avgLikes    = totalLikes    / videos.length
    const avgComments = totalComments / videos.length

    // Like ratio: likes as proportion of views (comments amplify engagement)
    const likeRatio    = avgViews > 0 ? avgLikes / avgViews : 0
    const commentRatio = avgViews > 0 ? avgComments / avgViews : 0

    // View velocity: log-normalised (ceiling 10M views per video)
    const viewVelocity = logNorm(avgViews, 10_000_000)

    // Score: velocity (reach) + engagement quality
    const score = clamp(
      viewVelocity * 0.5 + clamp(likeRatio * 50, 0, 1) * 0.3 + clamp(commentRatio * 100, 0, 1) * 0.2,
      0, 1
    )

    return { viewVelocity: Math.round(avgViews), likeRatio: Math.round(likeRatio * 1000) / 1000, score }
  } catch { return null }
}

// ── Google Trends — disabled (requires server-side proxy, adding later) ────────

async function getTrendScore(_artistName: string): Promise<number | null> {
  return null // Will enable once server-side proxy is in place
}

// ── Main route ───────────────────────────────────────────────────────────────

export async function GET() {
  const started = Date.now()

  // Load artists
  const artistRows: Array<{ id: string; name: string }> =
    await fetch(BASE + '/artists?select=id,name&limit=2000', { headers: SH }).then(r => r.json())

  let processed = 0, written = 0
  const sentimentBatch: unknown[] = []

  // Process in parallel batches of 10 to stay within timeout
  const BATCH = 10
  for (let i = 0; i < artistRows.length; i += BATCH) {
    if (Date.now() - started > 50000) break // hard deadline

    const batch = artistRows.slice(i, i + BATCH)
    const results = await Promise.allSettled(batch.map(async artist => {
      const [lastfm, youtube, trend] = await Promise.all([
        getLastfmSentiment(artist.name),
        getYoutubeSentiment(artist.name),
        getTrendScore(artist.name),
      ])

      // Build composite sentiment score
      // Weighted: Last.fm engagement 40%, YouTube engagement 40%, Trends 20%
      const scores: number[] = []
      const weights: number[] = []
      if (lastfm)          { scores.push(lastfm.score);   weights.push(0.4) }
      if (youtube)         { scores.push(youtube.score);  weights.push(0.4) }
      if (trend !== null)  { scores.push(trend);          weights.push(0.2) }

      if (scores.length === 0) return null

      const totalWeight  = weights.reduce((a, b) => a + b, 0)
      const weightedSum  = scores.reduce((sum, s, i) => sum + s * weights[i], 0)
      const sentimentRaw = totalWeight > 0 ? weightedSum / totalWeight : 0

      // Map 0–1 to AFINN-like -1 to 1 scale
      // 0.5 = neutral (0), 1.0 = very positive (1), 0.0 = very negative (-1)
      const afinnAvg = clamp((sentimentRaw - 0.5) * 2, -1, 1)

      // Is this a controversy signal? (trend spike + low like ratio = controversy)
      const isControversy = !!(trend && trend > 0.5 && youtube && youtube.likeRatio < 0.01)

      return {
        artist_id:        artist.id,
        captured_at:      new Date().toISOString(),
        afinn_avg:        Math.round(afinnAvg * 1000) / 1000,
        mention_count_7d: lastfm ? Math.round(lastfm.listeners / 1000) : 0, // proxy: listeners in thousands
        sentiment_score:  Math.round(sentimentRaw * 100) / 100,
        is_controversy:   isControversy,
        // Source breakdowns
        afinn_press_comments: youtube ? Math.round((youtube.score - 0.5) * 2 * 1000) / 1000 : null,
        valence_slope_7d:     trend !== null ? Math.round(trend * 1000) / 1000 : null,
      }
    }))

    for (const r of results) {
      processed++
      if (r.status === 'fulfilled' && r.value) {
        sentimentBatch.push(r.value)
      }
    }
  }

  // Batch write to artist_sentiment_signals
  if (sentimentBatch.length > 0) {
    await fetch(BASE + '/artist_sentiment_signals', {
      method: 'POST',
      headers: { ...SH, 'Prefer': 'return=minimal' },
      body: JSON.stringify(sentimentBatch)
    }).catch(() => {})
    written = sentimentBatch.length
  }

  return NextResponse.json({
    ok: true,
    processed,
    written,
    sources: {
      lastfm:  !!LASTFM_KEY,
      youtube: !!YOUTUBE_KEY,
      trends:  false, // re-enable once proxy is ready
    },
    elapsed_ms: Date.now() - started,
  })
}
