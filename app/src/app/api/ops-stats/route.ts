import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1'
const H    = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY }
const CH   = { ...H, 'Prefer': 'count=exact', 'Range': '0-0' }

const count = (table: string, filter = '') =>
  fetch(`${BASE}/${table}?select=count${filter}`, { headers: CH })
    .then(r => r.headers.get('content-range'))
    .then(cr => parseInt((cr || '0').split('/')[1] || '0'))
    .catch(() => 0)

export async function GET() {
  const [
    artists, articles, mentions, streaming, sentiment, press, heatHistory,
    lastScored, lastArticle, lastSentiment, lastStream, lastPress,
    spotifyActive, pressActive,
  ] = await Promise.all([
    count('artists'),
    count('articles'),
    count('artist_mentions'),
    count('artist_streaming_signals'),
    count('artist_sentiment_signals'),
    count('artist_press_signals'),
    count('artist_heat_history'),
    fetch(BASE + '/artists?select=last_scored_at&order=last_scored_at.desc&limit=1', { headers: H }).then(r => r.json()).then(d => d[0]?.last_scored_at || null).catch(() => null),
    fetch(BASE + '/articles?select=published_at&order=published_at.desc&limit=1', { headers: H }).then(r => r.json()).then(d => d[0]?.published_at || null).catch(() => null),
    fetch(BASE + '/artist_sentiment_signals?select=captured_at&order=captured_at.desc&limit=1', { headers: H }).then(r => r.json()).then(d => d[0]?.captured_at || null).catch(() => null),
    fetch(BASE + '/artist_streaming_signals?select=captured_at&order=captured_at.desc&limit=1', { headers: H }).then(r => r.json()).then(d => d[0]?.captured_at || null).catch(() => null),
    fetch(BASE + '/artist_press_signals?select=captured_at&order=captured_at.desc&limit=1', { headers: H }).then(r => r.json()).then(d => d[0]?.captured_at || null).catch(() => null),
    fetch(BASE + '/artist_streaming_signals?select=spotify_popularity&spotify_popularity=not.is.null&limit=1', { headers: H }).then(r => r.json()).then(d => d.length > 0).catch(() => false),
    fetch(BASE + '/artist_press_signals?select=article_count_7d&article_count_7d=gt.0&limit=1', { headers: H }).then(r => r.json()).then(d => d.length > 0).catch(() => false),
  ])

  return NextResponse.json({
    counts: { artists, articles, mentions, streaming, sentiment, press, heatHistory },
    lastRun: { scored: lastScored, article: lastArticle, sentiment: lastSentiment, streaming: lastStream, press: lastPress },
    spotifyActive, pressActive,
  })
}
