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
  { name: 'Spin',           url: 'https://www.spin.com/feed/' },
  { name: 'The Fader',      url: 'https://www.thefader.com/rss' },
  { name: 'XXL',            url: 'https://www.xxlmag.com/feed/' },
  { name: 'Guardian Music', url: 'https://www.theguardian.com/music/rss' },
  { name: 'Variety Music',  url: 'https://variety.com/v/music/feed/' },
  { name: 'Uproxx Music',   url: 'https://uproxx.com/music/feed/' },
  { name: 'DJBooth',        url: 'https://djbooth.net/feed' },
]

const POSITIVE = new Set(['fire','heat','banger','slap','goat','legend','iconic','amazing','brilliant','masterpiece','love','best','incredible','perfect','outstanding','excellent','great','hot','lit','vibe','classic','underrated','essential','historic','groundbreaking'])
const NEGATIVE = new Set(['trash','mid','flop','disappointing','boring','mediocre','overrated','bad','worst','terrible','awful','skip','weak','dead','irrelevant','garbage','derivative'])

function afinnScore(text: string): number {
  const words = text.toLowerCase().match(/\b\w+\b/g) ?? []
  const pos = words.filter(w => POSITIVE.has(w)).length
  const neg = words.filter(w => NEGATIVE.has(w)).length
  const total = pos + neg
  return total === 0 ? 0 : Math.round(((pos - neg) / total) * 1000) / 1000
}

function hashContent(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 32)
}

function findMentions(text: string, artistIndex: Map<string, string>): Array<[string, string]> {
  const lower = text.toLowerCase()
  const found: Array<[string, string]> = []
  for (const [name, id] of artistIndex) {
    if (lower.includes(name)) found.push([id, name])
  }
  return found
}

function parseItems(xml: string): Array<{ title: string; url: string; body: string }> {
  const items: Array<{ title: string; url: string; body: string }> = []
  const matches = xml.matchAll(/<item[^>]*>([sS]*?)<\/item>/gi)
  for (const [, itemXml] of matches) {
    const title = (itemXml.match(/<title[^>]*>(?:<![CDATA[)?(.*?)(?:]]>)?<\/title>/si)?.[1] ?? '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
    const url = (
      itemXml.match(/<link>(https?:\/\/[^<]+)<\/link>/i)?.[1] ??
      itemXml.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i)?.[1] ?? ''
    ).trim()
    const body = (itemXml.match(/<description[^>]*>(?:<![CDATA[)?([sS]*?)(?:]]>)?<\/description>/si)?.[1] ?? '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (title && url) items.push({ title, url, body })
  }
  return items.slice(0, 25)
}

export const maxDuration = 60

export async function GET() {
  const db = createClient(SUPA_URL, SUPA_KEY)

  const { data: artistRows } = await db.from('artists').select('id, name').limit(2000)
  const artistIndex = new Map<string, string>(
    (artistRows ?? []).map((a: { id: string; name: string }) => [a.name.toLowerCase(), a.id])
  )

  let totalArticles = 0
  let totalMentions = 0
  const pressMap = new Map<string, { scores: number[]; count: number }>()

  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Tunedex/1.0; +https://tunedex.vercel.app)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) { console.warn(`Feed ${feed.name} returned ${res.status}`); continue }

      const xml = await res.text()
      const items = parseItems(xml)
      console.log(`${feed.name}: ${items.length} items`)

      for (const { title, url, body } of items) {
        const text  = (title + ' ' + body).slice(0, 2000)
        const score = afinnScore(text)
        const chash = hashContent(url + title)

        const { data: artData } = await db
          .from('articles')
          .upsert({ source_name: feed.name, original_url: url, title: title.slice(0, 500), body: body.slice(0, 3000), published_at: new Date().toISOString(), content_hash: chash }, { onConflict: 'content_hash' })
          .select('id')
          .single()

        if (!artData?.id) continue
        totalArticles++

        for (const [artistId] of findMentions(text, artistIndex)) {
          await db.from('artist_mentions').insert({ artist_id: artistId, article_id: artData.id, sentiment: score, context_snippet: text.slice(0, 300), afinn_score: score, mention_type: 'press', captured_at: new Date().toISOString() })
          if (!pressMap.has(artistId)) pressMap.set(artistId, { scores: [], count: 0 })
          pressMap.get(artistId)!.scores.push(score)
          pressMap.get(artistId)!.count++
          totalMentions++
        }
      }
    } catch (e) {
      console.error(`Feed error ${feed.name}:`, String(e))
    }
  }

  for (const [artistId, { scores, count }] of pressMap) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length
    const pressScore = Math.min((Math.log1p(count) / Math.log1p(50)) * (1 + avg * 0.2) * 100, 100)
    await db.from('artist_press_signals').upsert({
      artist_id: artistId,
      captured_at: new Date().toISOString(),
      article_count_7d: count,
      press_afinn_avg: Math.round(avg * 1000) / 1000,
      press_score: Math.round(pressScore * 100) / 100,
    }, { onConflict: 'artist_id' })
  }

  return NextResponse.json({ ok: true, articles: totalArticles, mentions: totalMentions, press_signals: pressMap.size })
}
