import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')
  const stage = searchParams.get('stage')

  let query = supabase
    .from('artists')
    .select('id, name, heat_score, heat_label, career_stage, last_scored_at, monthly_listeners')
    .gt('heat_score', 0)
    .order('heat_score', { ascending: false })
    .limit(limit)

  if (stage) query = query.eq('career_stage', stage)

  const { data: artists, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!artists?.length) return NextResponse.json({ artists: [] })

  // For each artist fetch score from 24h ago for delta calculation
  const now = new Date()
  const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const ago1h  = new Date(now.getTime() -  1 * 60 * 60 * 1000).toISOString()

  const artistIds = artists.map(a => a.id)

  // Get oldest score in last 24h window per artist (i.e. score at ~24h ago)
  const { data: hist24h } = await supabase
    .from('artist_heat_history')
    .select('artist_id, final_score, scored_at')
    .in('artist_id', artistIds)
    .gte('scored_at', ago24h)
    .order('scored_at', { ascending: true })

  // Get oldest score in last 1h window per artist
  const { data: hist1h } = await supabase
    .from('artist_heat_history')
    .select('artist_id, final_score, scored_at')
    .in('artist_id', artistIds)
    .gte('scored_at', ago1h)
    .order('scored_at', { ascending: true })

  // Build lookup: first record per artist in each window = score at start of window
  const firstIn24h: Record<string, number> = {}
  const firstIn1h:  Record<string, number> = {}

  for (const row of (hist24h || [])) {
    if (!firstIn24h[row.artist_id]) firstIn24h[row.artist_id] = row.final_score
  }
  for (const row of (hist1h || [])) {
    if (!firstIn1h[row.artist_id]) firstIn1h[row.artist_id] = row.final_score
  }

  // Attach deltas and rank
  const enriched = artists.map((artist, idx) => {
    const prev24 = firstIn24h[artist.id]
    const prev1  = firstIn1h[artist.id]
    const delta24h = prev24 != null ? parseFloat(((artist.heat_score - prev24) / prev24 * 100).toFixed(1)) : null
    const delta1h  = prev1  != null ? parseFloat(((artist.heat_score - prev1)  / prev1  * 100).toFixed(1)) : null
    return {
      ...artist,
      rank: idx + 1,
      delta_24h: delta24h,   // % change over 24h
      delta_1h:  delta1h,    // % change over 1h
    }
  })

  return NextResponse.json({ artists: enriched, scored_at: now.toISOString() })
}
