import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE     = SUPA_URL + '/rest/v1'
const SH       = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }

// Source registry — loaded from DB at startup, defines prestige weight and tier per outlet
// Tier 1 = prestige >= 2.5 (Billboard, Pitchfork, Rolling Stone, THR, MBW)
// Tier 2 = prestige 1.5–2.4 (NME, Stereogum, XXL, Fader, Vibe, Complex etc)
// Tier 3 = prestige < 1.5  (PR Newswire, Business Wire etc)
type SourceMeta = { prestige: number; tier: 1 | 2 | 3 }

function getTier(prestige: number): 1 | 2 | 3 {
  if (prestige >= 2.5) return 1
  if (prestige >= 1.5) return 2
  return 3
}

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

type ArtistSignal = {
  scores: number[]          // afinn scores per article
  weightedScore: number     // sum of (afinn * prestige_weight) per article
  totalWeight: number       // sum of prestige_weights
  tier1: number             // article count from tier 1 sources
  tier2: number             // article count from tier 2 sources
  tier3: number             // article count from tier 3 sources
  articleCount: number      // raw total count
}

export async function GET() {
  // Load sources from DB — get prestige weight and derive tier
  const sourcesRaw: Array<{name: string; prestige_weight: number; rss_url: string}> =
    await fetch(BASE + '/sources?select=name,prestige_weight,rss_url&active=eq.true', { headers: SH })
      .then(r => r.json()).catch(() => [])

  // Build source lookup: name -> { prestige, tier }
  const sourceMeta: Record<string, SourceMeta> = {}
  const feeds: Array<{ name: string; url: string; prestige: number; tier: 1|2|3 }> = []

  for (const s of sourcesRaw) {
    if (!s.rss_url) continue
    const prestige = s.prestige_weight || 1.0
    const tier = getTier(prestige)
    sourceMeta[s.name] = { prestige, tier }
    feeds.push({ name: s.name, url: s.rss_url, prestige, tier })
  }

  console.log('Loaded ' + feeds.length + ' feeds from sources table')

  // Load artists
  const artistRows: Array<{id: string; name: string}> =
    await fetch(BASE + '/artists?select=id,name&limit=2000', { headers: SH }).then(r => r.json())
  const idx: Record<string, string> = {}
  for (const a of artistRows) idx[a.name.toLowerCase()] = a.id

  // Fetch all feeds in parallel
  const feedResults = await Promise.allSettled(
    feeds.map(async feed => {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tunedex/1.0)', 'Accept': 'application/rss+xml, */*' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(feed.name + ':' + res.status)
      return { feed, items: parseItems(await res.text()) }
    })
  )

  let arts = 0, ments = 0
  const signals: Record<string, ArtistSignal> = {}

  for (const result of feedResults) {
    if (result.status === 'rejected') { console.warn('feed failed:', result.reason); continue }
    const { feed, items } = result.value
    console.log(feed.name + ' [prestige:' + feed.prestige + ' tier:' + feed.tier + ']: ' + items.length + ' items')

    for (const { title, url, body } of items) {
      const text  = (title + ' ' + body).slice(0, 2000)
      const score = afinn(text)
      const hash  = md5(url + title)

      // Upsert article with source prestige metadata
      const upsRes = await fetch(BASE + '/articles?on_conflict=content_hash', {
        method: 'POST',
        headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          source_name:  feed.name,
          original_url: url,
          title:        title.slice(0, 500),
          body:         body.slice(0, 3000),
          published_at: new Date().toISOString(),
          content_hash: hash,
          sentiment:    score,
        })
      })
      const upsData = await upsRes.json().catch(() => [])
      let artId: string | undefined = Array.isArray(upsData) ? upsData[0]?.id : undefined

      if (!artId) {
        const existing: Array<{id: string}> =
          await fetch(BASE + '/articles?content_hash=eq.' + hash + '&select=id', { headers: SH })
            .then(r => r.json()).catch(() => [])
        artId = existing[0]?.id
      }
      if (!artId) continue
      arts++

      // Find artist mentions
      const lower = text.toLowerCase()
      for (const [name, aid] of Object.entries(idx)) {
        if (!lower.includes(name)) continue

        // Write mention with prestige context
        await fetch(BASE + '/artist_mentions', {
          method: 'POST',
          headers: { ...SH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            artist_id:       aid,
            article_id:      artId,
            sentiment:       score,
            context_snippet: text.slice(0, 300),
            afinn_score:     score,
            mention_type:    'press',
            captured_at:     new Date().toISOString(),
          })
        }).catch(() => {})

        // Accumulate weighted signal per artist
        if (!signals[aid]) {
          signals[aid] = { scores: [], weightedScore: 0, totalWeight: 0, tier1: 0, tier2: 0, tier3: 0, articleCount: 0 }
        }
        const sig = signals[aid]
        sig.scores.push(score)
        sig.weightedScore += score * feed.prestige   // prestige-weighted sentiment
        sig.totalWeight   += feed.prestige
        sig.articleCount  += 1
        if      (feed.tier === 1) sig.tier1++
        else if (feed.tier === 2) sig.tier2++
        else                      sig.tier3++
        ments++
      }
    }
  }

  // Write press signals — one row per artist with full tier breakdown and weighted score
  for (const [aid, sig] of Object.entries(signals)) {
    // Weighted average sentiment (prestige-weighted)
    const weightedAfinn = sig.totalWeight > 0
      ? Math.round((sig.weightedScore / sig.totalWeight) * 1000) / 1000
      : 0

    // Press score formula:
    // Tier 1 articles are worth 3x, Tier 2 are 1.5x, Tier 3 are 1x
    // Then log-normalised and sentiment-boosted
    const weightedCount = sig.tier1 * 3 + sig.tier2 * 1.5 + sig.tier3 * 1
    const pressScore = Math.min(
      (Math.log1p(weightedCount) / Math.log1p(50)) * (1 + weightedAfinn * 0.2) * 100,
      100
    )

    await fetch(BASE + '/artist_press_signals', {
      method: 'POST',
      headers: { ...SH, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        artist_id:        aid,
        captured_at:      new Date().toISOString(),
        article_count_7d: sig.articleCount,
        tier1_count_7d:   sig.tier1,
        tier2_count_7d:   sig.tier2,
        tier3_count_7d:   sig.tier3,
        press_afinn_avg:  weightedAfinn,
        press_score:      Math.round(pressScore * 100) / 100,
      })
    }).catch(() => {})
  }

  return NextResponse.json({
    ok:            true,
    feeds_polled:  feeds.length,
    articles:      arts,
    mentions:      ments,
    press_signals: Object.keys(signals).length,
  })
}
