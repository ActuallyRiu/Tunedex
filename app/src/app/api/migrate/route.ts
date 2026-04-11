import { NextResponse } from 'next/server'

export const maxDuration = 30

export async function GET() {
  const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const BASE = SUPA_URL + '/rest/v1'
  const H = { 'apikey': SVC_KEY, 'Authorization': 'Bearer ' + SVC_KEY, 'Content-Type': 'application/json' }

  const results: Record<string, unknown> = {}

  // Test: can we insert into artist_press_signals WITHOUT constraint?
  // First get an artist
  const artRes = await fetch(BASE + '/artists?select=id,name&limit=1', { headers: H })
  const artData = await artRes.json()
  const artistId = artData[0]?.id
  const artistName = artData[0]?.name
  results.testArtist = { id: artistId, name: artistName }

  // Insert a press signal row
  const insRes = await fetch(BASE + '/artist_press_signals', {
    method: 'POST',
    headers: { ...H, 'Prefer': 'return=representation' },
    body: JSON.stringify({ artist_id: artistId, captured_at: new Date().toISOString(), article_count_7d: 99, press_afinn_avg: 0.9, press_score: 99 })
  })
  const insData = await insRes.json()
  results.pressInsert = { status: insRes.status, id: insData[0]?.id, err: insData.message }

  // Count press signals for this artist
  const cntRes = await fetch(BASE + '/artist_press_signals?artist_id=eq.' + artistId + '&select=count', {
    headers: { ...H, 'Prefer': 'count=exact', 'Range': '0-0' }
  })
  results.pressCount = cntRes.headers.get('content-range')

  // Total counts
  const [ac, pc] = await Promise.all([
    fetch(BASE + '/articles?select=count', { headers: { ...H, 'Prefer': 'count=exact', 'Range': '0-0' } }).then(r => r.headers.get('content-range')),
    fetch(BASE + '/artist_press_signals?select=count', { headers: { ...H, 'Prefer': 'count=exact', 'Range': '0-0' } }).then(r => r.headers.get('content-range')),
  ])
  results.totals = { articles: ac, press: pc }

  return NextResponse.json(results)
}
