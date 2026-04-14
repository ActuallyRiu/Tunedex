import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE     = SUPA_URL + '/rest/v1'
const SH       = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }
const SP_ID    = process.env.SPOTIFY_CLIENT_ID!
const SP_SEC   = process.env.SPOTIFY_CLIENT_SECRET!

async function getSpotifyToken(): Promise<string> {
  const creds = SP_ID + ':' + SP_SEC
  const b64 = btoa(creds)
  const res   = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + b64 },
    body:    'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error('token_failed_' + res.status)
  const d = await res.json()
  if (!d.access_token) throw new Error('no_access_token')
  return d.access_token
}

export async function GET(req: Request) {
  const url    = new URL(req.url)
  const offset = parseInt(url.searchParams.get('offset') || '0')
  const limit  = 50
  const started = Date.now()

  if (url.searchParams.get('debug')) {
    try {
      const t = await getSpotifyToken()
      return NextResponse.json({ ok: true, token_ok: true, token_preview: t.slice(0,20), sp_id: !!SP_ID, sp_sec: !!SP_SEC })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message, sp_id: !!SP_ID, sp_sec: !!SP_SEC })
    }
  }

  let token: string
  try { token = await getSpotifyToken() }
  catch (e: any) { return NextResponse.json({ ok: false, error: e.message, sp_id: !!SP_ID, sp_sec: !!SP_SEC }, { status: 500 }) }

  const artists: Array<{ id: string; name: string }> = await fetch(
    BASE + `/artists?select=id,name&spotify_id=is.null&limit=${limit}&offset=${offset}`,
    { headers: SH }
  ).then(r => r.json()).catch(() => [])

  let found = 0, errors = 0, lastError = ''

  for (const artist of artists) {
    try {
      const res = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(artist.name)}&type=artist&limit=1`,
        { headers: { 'Authorization': 'Bearer ' + token } }
      )
      if (res.status === 429) {
        return NextResponse.json({ ok: true, found, errors, processed: found+errors, remaining: 'rate_limited', next_offset: offset+found+errors, elapsed_ms: Date.now()-started })
      }
      if (!res.ok) { errors++; lastError = 'search_' + res.status; continue }
      const d   = await res.json()
      const hit = d.artists?.items?.[0]
      if (!hit?.id) { errors++; lastError = 'no_result:' + artist.name; continue }
      await Promise.all([
        fetch(BASE + '/artists?id=eq.' + artist.id, { method: 'PATCH', headers: SH, body: JSON.stringify({ spotify_id: hit.id }) }),
        fetch(BASE + '/artist_streaming_signals?on_conflict=artist_id', {
          method: 'POST', headers: { ...SH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ artist_id: artist.id, captured_at: new Date().toISOString(), spotify_listeners: hit.followers?.total||0, spotify_popularity: hit.popularity||0 })
        })
      ])
      found++
    } catch(e: any) { errors++; lastError = e.message }
    await new Promise(r => setTimeout(r, 120))
  }

  return NextResponse.json({ ok: true, found, errors, lastError, processed: artists.length, remaining: artists.length===limit?'more':'done', next_offset: offset+artists.length, elapsed_ms: Date.now()-started })
}
