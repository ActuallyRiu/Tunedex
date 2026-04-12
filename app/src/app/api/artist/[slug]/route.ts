import { NextResponse } from 'next/server'

// GET /api/artist/[slug] — returns full artist data + articles + lastfm tracks + bio
export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const SVC  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1'
  const H    = { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC }
  const LASTFM = process.env.LASTFM_API_KEY || ''

  // 1. Fetch artist
  const artists: any[] = await fetch(BASE + '/artists?select=*&slug=eq.' + params.slug, { headers: H }).then(r => r.json())
  const artist = artists[0]
  if (!artist) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // 2. Recent press articles via mentions
  const mentions: any[] = await fetch(
    BASE + '/artist_mentions?select=article_id,afinn_score,captured_at&artist_id=eq.' + artist.id + '&order=captured_at.desc&limit=10',
    { headers: H }
  ).then(r => r.json()).catch(() => [])

  const articleIds = mentions.map((m: any) => m.article_id).filter(Boolean)
  const articles: any[] = articleIds.length
    ? await fetch(BASE + '/articles?select=title,source_name,original_url,published_at,sentiment&id=in.(' + articleIds.join(',') + ')', { headers: H }).then(r => r.json()).catch(() => [])
    : []

  // 3. Last.fm top tracks
  let topTracks: any[] = []
  if (LASTFM) {
    try {
      const lfRes = await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptracks&artist=${encodeURIComponent(artist.name)}&api_key=${LASTFM}&format=json&limit=3`,
        { signal: AbortSignal.timeout(5000) }
      )
      const lfData = await lfRes.json()
      topTracks = (lfData?.toptracks?.track || []).slice(0, 3).map((t: any) => ({
        name:       t.name,
        playcount:  parseInt(t.playcount || '0').toLocaleString(),
        listeners:  parseInt(t.listeners || '0').toLocaleString(),
        url:        t.url,
      }))
    } catch {}
  }

  // 4. Bio — return cached if exists, otherwise return null (frontend will generate via Claude API)
  const bio: string | null = artist.bio || null

  return NextResponse.json({
    artist: {
      id:               artist.id,
      name:             artist.name,
      slug:             artist.slug,
      genres:           artist.genres || [],
      monthly_listeners: artist.monthly_listeners,
      career_stage:     artist.career_stage,
      heat_score:       artist.heat_score,
      heat_label:       artist.heat_label,
      last_scored_at:   artist.last_scored_at,
      bio,
    },
    articles: articles.slice(0, 5),
    topTracks,
  })
}
