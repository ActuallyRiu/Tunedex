import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

export const maxDuration = 30

function getTag(xml: string, tag: string): string {
  const open = xml.indexOf('<' + tag)
  if (open === -1) return ''
  const close = xml.indexOf('</' + tag + '>', open)
  if (close === -1) return ''
  const inner = xml.slice(xml.indexOf('>', open) + 1, close)
  return inner.replace('<![CDATA[', '').replace(']]>', '').replace(/&amp;/g, '&').trim()
}

function parseItems(xml: string): Array<{ title: string; url: string; body: string }> {
  const out: Array<{ title: string; url: string; body: string }> = []
  const parts = xml.split('<item')
  for (let i = 1; i < parts.length && out.length < 3; i++) {
    const end = parts[i].indexOf('</item>')
    const chunk = end > -1 ? parts[i].slice(0, end) : parts[i]
    const title = getTag(chunk, 'title')
    let url = getTag(chunk, 'link')
    if (!url || !url.startsWith('http')) url = getTag(chunk, 'guid')
    const body = getTag(chunk, 'description').replace(/<[^>]+>/g, ' ').trim()
    if (title && url && url.startsWith('http')) out.push({ title, url, body })
  }
  return out
}

export async function GET() {
  const log: string[] = []
  const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const db = createClient(SUPA_URL, SUPA_KEY)

  // Step 1: fetch feed
  log.push('fetching pitchfork...')
  const res = await fetch('https://pitchfork.com/rss/news/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tunedex/1.0)', 'Accept': 'application/rss+xml, */*' },
    signal: AbortSignal.timeout(8000),
  })
  log.push('feed status: ' + res.status)
  const xml = await res.text()
  log.push('xml length: ' + xml.length)

  // Step 2: parse
  const items = parseItems(xml)
  log.push('parsed items: ' + items.length)
  if (items[0]) log.push('first title: ' + items[0].title.slice(0, 60))
  if (items[0]) log.push('first url: ' + items[0].url.slice(0, 60))

  if (items.length === 0) return NextResponse.json({ log, error: 'no items parsed' })

  // Step 3: upsert first article
  const { title, url, body } = items[0]
  const hash = createHash('md5').update(url + title).digest('hex').slice(0, 32)
  log.push('hash: ' + hash)

  const upsertRes = await db.from('articles').upsert(
    { source_name: 'Pitchfork', original_url: url, title: title.slice(0, 500), body: body.slice(0, 3000), published_at: new Date().toISOString(), content_hash: hash },
    { onConflict: 'content_hash', ignoreDuplicates: false }
  )
  log.push('upsert error: ' + JSON.stringify(upsertRes.error))

  // Step 4: fetch id
  const { data: art, error: selErr } = await db.from('articles').select('id').eq('content_hash', hash).single()
  log.push('art id: ' + art?.id)
  log.push('select error: ' + JSON.stringify(selErr))

  // Step 5: load artists
  const { data: artistRows, error: artErr } = await db.from('artists').select('id, name').limit(5)
  log.push('artists loaded: ' + artistRows?.length)
  log.push('artist error: ' + JSON.stringify(artErr))
  if (artistRows?.[0]) log.push('first artist: ' + artistRows[0].name)

  return NextResponse.json({ log })
}
