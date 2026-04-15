import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE     = SUPA_URL + '/rest/v1'
const SH       = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }

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

async function dbBatchPost(path: string, rows: unknown[]): Promise<unknown[]> {
  if (rows.length === 0) return []
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  })
  return r.json().catch(() => [])
}

export async function GET() {
  const started = Date.now()
  const deadline = 54000 // leave 6s buffer before Vercel 60s limit

  // 1. Load sources (prestige weights + tiers)
  const sourcesRaw: Array<{ name: string; prestige_weight: number; rss_url: string }> =
    await fetch(BASE + '/sources?select=name,prestige_weight,rss_url&active=eq.true', { headers: SH })
      .then(r => r.json()).catch(() => [])

  const feeds = sourcesRaw
    .filter(s => s.rss_url)
    .map(s => ({ name: s.name, url: s.rss_url, prestige: s.prestige_weight || 1, tier: getTier(s.prestige_weight || 1) }))

  // 2. Load artists
  const artistRows: Array<{ id: string; name: string }> =
    await fetch(BASE + '/artists?select=id,name&limit=2000', { headers: SH }).then(r => r.json())
  const idx: Record<string, string> = {}
  for (const a of artistRows) idx[a.name.toLowerCase()] = a.id

  // 3. Fetch all feeds in parallel
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

  // 4. Build article batch + collect per-artist signals (no DB writes yet)
  const articleBatch: unknown[] = []
  const articleHashMap: Record<string, { feed: typeof feeds[0]; score: number; text: string }> = {}

  for (const result of feedResults) {
    if (result.status === 'rejected') { console.warn('feed failed:', result.reason); continue }
    const { feed, items } = result.value
    console.log(feed.name + ' [t' + feed.tier + ' p' + feed.prestige + ']: ' + items.length)
    for (const { title, url, body } of items) {
      const text  = (title + ' ' + body).slice(0, 2000)
      const score = afinn(text)
      const hash  = md5(url + title)
      articleBatch.push({ source_name: feed.name, original_url: url, title: title.slice(0, 500), body: body.slice(0, 3000), published_at: new Date().toISOString(), content_hash: hash, sentiment: score })
      articleHashMap[hash] = { feed, score, text }
    }
  }

  // 5. Batch upsert all articles in one call
  const upserted = await dbBatchPost('/articles?on_conflict=content_hash', articleBatch) as Array<{ id: string; content_hash: string }>
  let arts = Array.isArray(upserted) ? upserted.length : 0

  // Build hash->id map — upsert only returns new rows in merge mode,
  // so explicitly fetch ALL articles by content_hash to get existing ones too
  const hashToId: Record<string, string> = {}
  const allHashes = Object.keys(articleHashMap)
  if (allHashes.length > 0) {
    // Fetch in chunks of 100 to avoid URL length limits
    for (let i = 0; i < allHashes.length; i += 100) {
      const chunk = allHashes.slice(i, i + 100)
      const rows: Array<{id: string; content_hash: string}> = await fetch(
        BASE + '/articles?select=id,content_hash&content_hash=in.(' + chunk.join(',') + ')',
        { headers: SH }
      ).then(r => r.json()).catch(() => [])
      for (const row of rows) {
        if (row.id && row.content_hash) hashToId[row.content_hash] = row.id
      }
    }
  }

  // 6. Build mentions batch + artist signal aggregation
  type ArtSig = { weightedScore: number; totalWeight: number; tier1: number; tier2: number; tier3: number; count: number }
  const signals: Record<string, ArtSig> = {}
  const mentionBatch: unknown[] = []

  for (const [hash, { feed, score, text }] of Object.entries(articleHashMap)) {
    const artId = hashToId[hash]
    if (!artId) continue

        for (const [name, aid] of Object.entries(idx)) {
      // Word-boundary match. Short/ambiguous names (4 chars or fewer: HER, NF, Eve)
      // require exact uppercase match to prevent pronoun false positives.
      const isShort = name.length <= 4
      const esc = name.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&')
      const pat = isShort
        ? new RegExp('(?<![a-zA-Z])' + esc.toUpperCase() + '(?![a-zA-Z])')
        : new RegExp('(?<![a-zA-Z])' + esc + '(?![a-zA-Z])', 'i')
      if (!pat.test(text)) continue
      mentionBatch.push({ artist_id: aid, article_id: artId, sentiment: score, context_snippet: text.slice(0, 300), afinn_score: score, mention_type: 'press', captured_at: new Date().toISOString() })
      if (!signals[aid]) signals[aid] = { weightedScore: 0, totalWeight: 0, tier1: 0, tier2: 0, tier3: 0, count: 0 }
      const sig = signals[aid]
      sig.weightedScore += score * feed.prestige
      sig.totalWeight   += feed.prestige
      sig.count         += 1
      if      (feed.tier === 1) sig.tier1++
      else if (feed.tier === 2) sig.tier2++
      else                      sig.tier3++
    }
  }

  // Check deadline before heavy writes
  const elapsed = Date.now() - started
  if (elapsed > deadline) {
    return NextResponse.json({ ok: true, articles: arts, mentions: 0, press_signals: 0, timeout: true, elapsed_ms: elapsed })
  }

  // 7. Batch insert mentions (ignore duplicates)
  const mentionChunks = []
  for (let i = 0; i < mentionBatch.length; i += 100) mentionChunks.push(mentionBatch.slice(i, i + 100))
  for (const chunk of mentionChunks) {
    if (Date.now() - started > deadline) break
    await fetch(BASE + '/artist_mentions', {
      method: 'POST', headers: { ...SH, 'Prefer': 'return=minimal' }, body: JSON.stringify(chunk)
    }).catch(() => {})
  }

  // 8. Batch insert press signals
  const pressBatch = Object.entries(signals).map(([aid, sig]) => {
    const avg = sig.totalWeight > 0 ? Math.round((sig.weightedScore / sig.totalWeight) * 1000) / 1000 : 0
    const weighted = sig.tier1 * 3 + sig.tier2 * 1.5 + sig.tier3 * 1 || sig.count
    const ps = Math.min((Math.log1p(weighted) / Math.log1p(50)) * (1 + avg * 0.2) * 100, 100)
    return { artist_id: aid, captured_at: new Date().toISOString(), article_count_7d: sig.count, tier1_count_7d: sig.tier1, tier2_count_7d: sig.tier2, tier3_count_7d: sig.tier3, press_afinn_avg: avg, press_score: Math.round(ps * 100) / 100 }
  })

  if (Date.now() - started < deadline) {
    // Upsert on artist_id — requires UNIQUE constraint on artist_id (one row per artist, always latest)
    await fetch(BASE + '/artist_press_signals?on_conflict=artist_id', {
      method: 'POST', headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(pressBatch)
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true, feeds: feeds.length, articles: arts, mentions: mentionBatch.length, press_signals: pressBatch.length, elapsed_ms: Date.now() - started })
}
