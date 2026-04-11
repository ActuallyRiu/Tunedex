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
  for (let i = 1; i < parts.length && out.length < 25; i++) {
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

export const maxDuration = 60

export async function GET() {
  const db = createClient(SUPA_URL, SUPA_KEY)
  const { data: rows } = await db.from('artists').select('id, name').limit(2000)
  const idx: Record<string, string> = {}
  for (const a of (rows ?? [])) idx[a.name.toLowerCase()] = a.id

  let arts = 0, ments = 0
  const sc: Record<string, number[]> = {}
  const ct: Record<string, number> = {}

  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Tunedex/1.0)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) { console.warn(feed.name, res.status); continue }
      const xml = await res.text()
      const items = parseItems(xml)
      console.log(feed.name + ': ' + items.length)

      for (const { title, url, body } of items) {
        const text = (title + ' ' + body).slice(0, 2000)
        const s    = afinn(text)
        const hash = md5(url + title)

        // Upsert, then always fetch id (upsert may return null on conflict)
        await db.from('articles').upsert(
          { source_name: feed.name, original_url: url, title: title.slice(0, 500), body: body.slice(0, 3000), published_at: new Date().toISOString(), content_hash: hash },
          { onConflict: 'content_hash', ignoreDuplicates: false }
        )
        const { data: art } = await db.from('articles').select('id').eq('content_hash', hash).single()

        if (!art?.id) continue
        arts++

        const lower = text.toLowerCase()
        for (const [name, aid] of Object.entries(idx)) {
          if (!lower.includes(name)) continue
          try {
            await db.from('artist_mentions').insert({ artist_id: aid, article_id: art.id, sentiment: s, context_snippet: text.slice(0, 300), afinn_score: s, mention_type: 'press', captured_at: new Date().toISOString() })
          } catch (_e) { /* dup */ }
          if (!sc[aid]) { sc[aid] = []; ct[aid] = 0 }
          sc[aid].push(s)
          ct[aid]++
          ments++
        }
      }
    } catch (e) { console.error(feed.name, String(e)) }
  }

  for (const aid of Object.keys(sc)) {
    const avg = sc[aid].reduce((a, b) => a + b, 0) / sc[aid].length
    const ps  = Math.min((Math.log1p(ct[aid]) / Math.log1p(50)) * (1 + avg * 0.2) * 100, 100)
    await db.from('artist_press_signals').upsert({
      artist_id: aid,
      captured_at: new Date().toISOString(),
      article_count_7d: ct[aid],
      press_afinn_avg: Math.round(avg * 1000) / 1000,
      press_score: Math.round(ps * 100) / 100,
    }, { onConflict: 'artist_id' })
  }

  return NextResponse.json({ ok: true, articles: arts, mentions: ments, press_signals: Object.keys(sc).length })
}
