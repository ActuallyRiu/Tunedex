import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SVC       = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE      = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1'
const H         = { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC, 'Content-Type': 'application/json' }
const LASTFM    = process.env.LASTFM_API_KEY || ''
const ANTHROPIC = process.env.ANTHROPIC_API_KEY || ''

function fmtListeners(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return n.toString()
}

async function generateBio(artist: any, topTracks: any[], articles: any[]): Promise<string> {
  if (!ANTHROPIC) return ''
  const prompt = [
    `Write a concise, engaging artist bio for ${artist.name}.`,
    `Career stage: ${artist.career_stage}. Genres: ${(artist.genres || []).join(', ')}.`,
    `Monthly listeners: ${fmtListeners(artist.monthly_listeners)}.`,
    topTracks.length ? `Top songs include: ${topTracks.map((t: any) => t.name).join(', ')}.` : '',
    articles.length ? `Recent press: ${articles.map((a: any) => a.title).slice(0, 3).join('; ')}.` : '',
    `Write 2-3 sentences. Be factual and specific. Focus on their sound, cultural impact, and current moment in their career.`,
  ].filter(Boolean).join(' ')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(15000),
  })
  const d = await res.json()
  return d.content?.[0]?.text?.trim() || ''
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  // 1. Fetch artist
  const artists: any[] = await fetch(BASE + '/artists?select=*&slug=eq.' + params.slug, { headers: H }).then(r => r.json())
  const artist = artists[0]
  if (!artist) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // 2. Recent press
  const mentions: any[] = await fetch(
    BASE + '/artist_mentions?select=article_id,afinn_score,captured_at&artist_id=eq.' + artist.id + '&order=captured_at.desc&limit=10',
    { headers: H }
  ).then(r => r.json()).catch(() => [])

  const articleIds = Array.isArray(mentions) ? mentions.map((m: any) => m.article_id).filter(Boolean) : []
  const articles: any[] = articleIds.length
    ? await fetch(BASE + '/articles?select=title,source_name,original_url,published_at,sentiment&id=in.(' + articleIds.join(',') + ')', { headers: H })
        .then(r => r.json()).catch(() => [])
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
        name: t.name, playcount: parseInt(t.playcount || '0').toLocaleString(),
        listeners: parseInt(t.listeners || '0').toLocaleString(), url: t.url,
      }))
    } catch {}
  }

  // 4. Bio — use cached, or generate + cache
  let bio: string = artist.bio || ''
  if (!bio) {
    bio = await generateBio(artist, topTracks, articles)
    if (bio) {
      // Cache in DB — fire and forget
      fetch(BASE + '/artists?id=eq.' + artist.id, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify({ bio })
      }).catch(() => {})
    }
  }

  return NextResponse.json({
    artist: {
      id: artist.id, name: artist.name, slug: artist.slug,
      genres: artist.genres || [], monthly_listeners: artist.monthly_listeners,
      career_stage: artist.career_stage, heat_score: artist.heat_score,
      heat_label: artist.heat_label, last_scored_at: artist.last_scored_at, bio,
    },
    articles: articles.slice(0, 5),
    topTracks,
  })
}
