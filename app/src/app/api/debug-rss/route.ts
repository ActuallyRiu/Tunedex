import { NextResponse } from 'next/server'

export const maxDuration = 30

export async function GET() {
  const feeds = [
    { name: 'Pitchfork', url: 'https://pitchfork.com/rss/news/' },
    { name: 'Billboard', url: 'https://www.billboard.com/feed/' },
    { name: 'NME', url: 'https://www.nme.com/feed' },
  ]

  const results = []
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tunedex/1.0)', 'Accept': 'application/rss+xml, */*' },
        signal: AbortSignal.timeout(8000),
      })
      const text = await res.text()
      const itemCount = (text.match(/<item/gi) || []).length
      const hasXml = text.includes('<?xml') || text.includes('<rss') || text.includes('<feed')
      results.push({ name: feed.name, status: res.status, itemCount, hasXml, len: text.length, preview: text.slice(0, 100) })
    } catch(e) {
      results.push({ name: feed.name, error: String(e) })
    }
  }

  return NextResponse.json({ results })
}
