import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const FEEDS = [
  { name: 'Billboard',      url: 'https://www.billboard.com/feed/' },
  { name: 'Pitchfork',      url: 'https://pitchfork.com/rss/news/' },
  { name: 'Rolling Stone',  url: 'https://www.rollingstone.com/music/music-news/feed/' },
  { name: 'NME',            url: 'https://www.nme.com/feed' },
  { name: 'HotNewHipHop',   url: 'https://www.hotnewhiphop.com/rss.xml' },
  { name: 'HipHopDX',       url: 'https://hiphopdx.com/rss' },
  { name: 'Complex Music',  url: 'https://www.complex.com/music/rss' },
  { name: 'Stereogum',      url: 'https://www.stereogum.com/feed/' },
  { name: 'The Fader',      url: 'https://www.thefader.com/rss' },
  { name: 'XXL',            url: 'https://www.xxlmag.com/feed/' },
  { name: 'Guardian Music', url: 'https://www.theguardian.com/music/rss' },
  { name: 'Variety Music',  url: 'https://variety.com/v/music/feed/' },
  { name: 'Uproxx Music',   url: 'https://uproxx.com/music/feed/' },
  { name: 'DJBooth',        url: 'https://djbooth.net/feed' },
]

const POSITIVE = new Set(['fire','heat','banger','slap','goat','legend','iconic','amazing',
  'brilliant','masterpiece','love','best','incredible','perfect','outstanding','excellent',
  'great','hot','lit','vibe','classic','underrated','essential','historic','groundbreaking'])
const NEGATIVE = new Set(['trash','mid','flop','disappointing','boring','mediocre','overrated',
  'bad','worst','terrible','awful','skip','weak','dead','irrelevant','garbage','derivative'])

function afinnScore(text: string): number {
  const words = text.toLowerCase().match(/w+/g) ?? []
  const pos = words.filter(w => POSITIVE.has(w)).length
  const neg = words.filter(w => NEGATIVE.has(w)).length
  const total = pos + neg
  return total === 0 ? 0 : Math.round(((pos - neg) / total) * 1000) / 1000
}

function hashContent(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 32)
}

function findMentions(text: string, index: Record<string, string>): string[] {
  const lower = text.toLowerCase()
  return Object.keys(index).filter(name => lower.includes(name))
}

function parseItems(xml: string): Array<{ title: string; url: string; body: string }> {
  const items: Array<{ title: string; url: string; body: string }> = []
  const re = new RegExp('<item[^>]*>([\s\S]*?)<\/item>', 'gi')
  let m
  while ((m = re.exec(xml)) !== null) {
    const x = m[1]
    const tm = x.match(new RegExp('<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>', 'i'))
    const title = (tm?.[1] ?? '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim()
    const um = x.match(new RegExp('<link>(https?:\/\/[^<]+)<\/link>', 'i'))
      ?? x.match(new RegExp('<guid[^>]*>(https?:\/\/[^<]+)<\/guid>', 'i'))
    const url = (um?.[1] ?? '').trim()
    const bm = x.match(new RegExp('<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>', 'i'))
    const body = (bm?.[1] ?? '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
    if (title && url) items.push({ title, url, body })
    if (items.length >= 25) break
  }
  return items
}

export const maxDuration = 60

export async function GET() {
  const db = createClient(SUPA_URL, SUPA_KEY)
  const { data: rows } = await db.from('artists').select('id, name').limit(2000)
  const idx: Record<string, string> = {}
  for (const a of (rows ?? [])) idx[a.name.toLowerCase()] = a.id

  let articles = 0
  let mentions = 0
  const scores: Record<string, number[]> = {}
  const counts: Record<string, number> = {}

  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tunedex/1.0)', 'Accept': 'application/rss+xml, application/xml, */*' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) { console.warn(feed.name, res.status); continue }
      const xml = await res.text()
      const items = parseItems(xml)
      console.log(feed.name + ': ' + items.length + ' items')

      for (const { title, url, body } of items) {
        const text  = (title + ' ' + body).slice(0, 2000)
        const score = afinnScore(text)
        const chash = hashContent(url + title)

        const { data: art } = await db.from('articles')
          .upsert({ source_name: feed.name, original_url: url, title: title.slice(0,500), body: body.slice(0,3000), published_at: new Date().toISOString(), content_hash: chash }, { onConflict: 'content_hash' })
          .select('id').single()

        if (!art?.id) continue
        articles++

        const named = findMentions(text, idx)
        for (const name of named) {
          const aid = idx[name]
          await db.from('artist_mentions').insert({ artist_id: aid, article_id: art.id, sentiment: score, context_snippet: text.slice(0,300), afinn_score: score, mention_type: 'press', captured_at: new Date().toISOString() }).then(()=>{}).catch(()=>{})
          if (!scores[aid]) { scores[aid] = []; counts[aid] = 0 }
          scores[aid].push(score)
          counts[aid]++
          mentions++
        }
      }
    } catch(e) { console.error(feed.name, String(e)) }
  }

  const aids = Object.keys(scores)
  for (const aid of aids) {
    const sc = scores[aid]
    const ct = counts[aid]
    const avg = sc.reduce((a,b)=>a+b,0) / sc.length
    const ps  = Math.min((Math.log1p(ct) / Math.log1p(50)) * (1 + avg * 0.2) * 100, 100)
    await db.from('artist_press_signals').upsert({ artist_id: aid, captured_at: new Date().toISOString(), article_count_7d: ct, press_afinn_avg: Math.round(avg*1000)/1000, press_score: Math.round(ps*100)/100 }, { onConflict: 'artist_id' })
  }

  return NextResponse.json({ ok: true, articles, mentions, press_signals: aids.length })
}
