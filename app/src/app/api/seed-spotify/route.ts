import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPA_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE        = SUPA_URL + '/rest/v1'
const SH          = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }
const SPOTIFY_CID = process.env.SPOTIFY_CLIENT_ID || ''
const SPOTIFY_SEC = process.env.SPOTIFY_CLIENT_SECRET || ''

async function getToken(): Promise<string> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CID + ':' + SPOTIFY_SEC).toString('base64') },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(8000),
  })
  const d = await r.json()
  return d.access_token || ''
}

export async function GET(req: Request) {
  const url    = new URL(req.url)
  const offset = parseInt(url.searchParams.get('offset') || '0')
  const limit  = 50
  const started = Date.now()

  if (!SPOTIFY_CID) return NextResponse.json({ error: 'no spotify credentials' }, { status: 500 })

  const token = await getToken()
  if (!token) return NextResponse.json({ error: 'spotify auth failed' }, { status: 500 })

  // Fetch next batch of uncached artists
  const artists: Array<{ id: string; name: string }> = await fetch(
    BASE + `/artists?select=id,name&spotify_id=is.null&limit=${limit}&offset=${offset}`,
    { headers: SH }
  ).then(r => r.json())

  let found = 0, errors = 0

  for (const artist of artists) {
    try {
      const s = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(artist.name)}&type=artist&limit=1`,
        { headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(5000) }
      )
      if (s.status === 429) {
        // Rate limited — stop this batch, return progress
        return NextResponse.json({ ok: true, found, errors, processed: found + errors, offset, rate_limited: true, elapsed_ms: Date.now() - started })
      }
      if (!s.ok) { errors++; continue }
      const d = await s.json()
      const hit = d.artists?.items?.[0]
      if (!hit?.id) { errors++; continue }

      // Write spotify_id to artist + streaming signal in parallel
      await Promise.all([
        fetch(BASE + '/artists?id=eq.' + artist.id, {
          method: 'PATCH', headers: SH,
          body: JSON.stringify({ spotify_id: hit.id })
        }),
        fetch(BASE + '/artist_streaming_signals?on_conflict=artist_id', {
          method: 'POST',
          headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            artist_id:          artist.id,
            captured_at:        new Date().toISOString(),
            spotify_listeners:  hit.followers?.total || 0,
            spotify_popularity: hit.popularity || 0,
          })
        })
      ])
      found++
    } catch { errors++ }
    // 120ms between searches — safe rate
    await new Promise(r => setTimeout(r, 120))
  }

  return NextResponse.json({
    ok: true, found, errors,
    processed: artists.length,
    remaining: artists.length === limit ? 'more' : 'done',
    next_offset: offset + artists.length,
    elapsed_ms: Date.now() - started,
  })
}
