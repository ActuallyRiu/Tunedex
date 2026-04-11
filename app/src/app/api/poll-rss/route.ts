import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1'
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SH   = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }

const FEEDS = [
  { name: 'Billboard',      url: 'https://www.billboard.com/feed/' },
  { name: 'Pitchfork',      url: 'https://pitchfork.com/rss/news/' },
  { name: 'Rolling Stone',  url: 'https://www.rollingstone.com/music/music-news/feed/' },
  { name: 'NME',            url: 'https://www.nme.com/feed' },
  { name: 'HotNewHipHop',   url: 'https://www.hotnewhiphop.com/rss.xml' },
  { name: 'HipHopDX',       url: 'https://hiphopdx.com/rss' },
  { name: 'Stereogum',      url: 'https://www.stereogum.com/feed/' },
  { name: 'The Fader',      url: 'https://www.thefader.com/rss' },
  { name: 'XXL',            url: 'https://www.xxlmag.com/feed/' },
  { name: 'Guardian Music', url: 'https://www.theguardian.com/music/rss' },
  { name: 'DJBooth',        url: 'https://djbooth.net/feed' },
]

const PWORDS = new Set(['fire','heat','banger','slap','goat','legend','iconic','amazing','brilliant','masterpiece','love','best','incredible','perfect','outstanding','excellent','great','hot','lit','vibe','classic','underrated','essential','historic','groundbreaking'])
const NWORDS = new Set(['trash','mid','flop','disappointing','boring','mediocre','overrated','bad','worst','terrible','awful','skip','weak','dead','irrelevant','garbage','derivative'])

function afinn(text: string): number {
  const words = text.toLowerCase().match(/\b\w+\b/g) ?? []
  const p = words.filter(w => PWORDS.has(w)).length
  const n = words.filter(w => NWORDS.has(w)).length
  return p + n === 0 ? 0 : Math.round(((p - n) / (p + n)) * 1000) / 1000
}

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 32)
}

function getTag(xml: string, tag: string): string {
  const open = xml.indexOf('<' + tag)
  if (open === -1) return ''
  const close = xml.indexOf('</' + tag + '>', open)
  if (close === -1) return ''
  const inner = xml.slice(xml.indexOf('>', open) + 1, close)
  return inner.replace('<![CDATA[', '').replace(']]>', '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

function parseItems(xml: string): Array<{ title: string; url: string; body: string }> {
  const out: Array<{ title: string; url: string; body: string }> = []
  const parts = xml.split('<item')
  for (let i = 1; i < parts.length && out.length < 20; i++) {
    const end = parts[i].indexOf('</item>')
    const chunk = end > -1 ? parts[i].slice(0, end) : parts[i]
    const title = getTag(chunk, 'title')
    let url = getTag(chunk, 'link')
    if (!url || !url.startsWith('http')) url = getTag(chunk, 'guid')
    const body = getTag(chunk, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (title && url && url.startsWith('http')) out.push({ title, url, body })
  }
  return out
}

export async function GET() {
  // Load artists once
  const artRes = await fetch(BASE + '/artists?select=id,name&limit=2000', { headers: SH })
  const artistRows: Array<{id: string; name: string}> = await artRes.json()
  const idx: Record<string, string> = {}
  for (const a of artistRows) idx[a.name.toLowerCase()] = a.id

  // Fetch ALL feeds in parallel — completes in ~4s instead of 88s sequentially
  const feedResults = await Promise.allSettled(
    FEEDS.map(async feed => {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tunedex/1.0)', 'Accept': 'application/rss+xml, */*' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(feed.name + ':' + res.status)
      return { feed, items: parseItems(await res.text()) }
    })
  )

  let arts = 0, ments = 0
  const pressScores: Record<string, number[]> = {}
  const pressCounts: Record<string, number> = {}

  // Write articles + mentions for each feed result
  for (const result of feedResults) {
    if (result.status === 'rejected') { console.warn('feed failed:', result.reason); continue }
    const { feed, items } = result.value
    console.log(feed.name + ': ' + items.length + ' items')

    for (const { title, url, body } of items) {
      const text  = (title + ' ' + body).slice(0, 2000)
      const score = afinn(text)
      const hash  = md5(url + title)

      // Upsert article — merge on content_hash
      const upsRes = await fetch(BASE + '/articles?on_conflict=content_hash', {
        method: 'POST',
        headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ source_name: feed.name, original_url: url, title: title.slice(0, 500), body: body.slice(0, 3000), published_at: new Date().toISOString(), content_hash: hash })
      })
      const upsData = await upsRes.json().catch(() => [])
      let artId: string | undefined = Array.isArray(upsData) ? upsData[0]?.id : undefined

      // If upsert returned nothing (duplicate), fetch existing id
      if (!artId) {
        const existing: Array<{id: string}> = await fetch(BASE + '/articles?content_hash=eq.' + hash + '&select=id', { headers: SH }).then(r => r.json()).catch(() => [])
        artId = existing[0]?.id
      }
      if (!artId) continue
      arts++

      // Find artist mentions
      const lower = text.toLowerCase()
      for (const [name, aid] of Object.entries(idx)) {
        if (!lower.includes(name)) continue
        // Insert mention — ignore duplicate errors
        await fetch(BASE + '/artist_mentions', {
          method: 'POST',
          headers: { ...SH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ artist_id: aid, article_id: artId, sentiment: score, context_snippet: text.slice(0, 300), afinn_score: score, mention_type: 'press', captured_at: new Date().toISOString() })
        }).catch(() => {})
        if (!pressScores[aid]) { pressScores[aid] = []; pressCounts[aid] = 0 }
        pressScores[aid].push(score); pressCounts[aid]++; ments++
      }
    }
  }

  // Write press signals — plain INSERT (no unique constraint on artist_id)
  for (const aid of Object.keys(pressScores)) {
    const sc  = pressScores[aid]
    const cnt = pressCounts[aid]
    const avg = sc.reduce((a, b) => a + b, 0) / sc.length
    const ps  = Math.min((Math.log1p(cnt) / Math.log1p(50)) * (1 + avg * 0.2) * 100, 100)
    await fetch(BASE + '/artist_press_signals', {
      method: 'POST',
      headers: { ...SH, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ artist_id: aid, captured_at: new Date().toISOString(), article_count_7d: cnt, press_afinn_avg: Math.round(avg * 1000) / 1000, press_score: Math.round(ps * 100) / 100 })
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true, articles: arts, mentions: ments, press_signals: Object.keys(pressScores).length })
}
