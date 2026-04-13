import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

const SVC  = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SU   = process.env.NEXT_PUBLIC_SUPABASE_URL!

async function sql(query: string) {
  // Use Supabase's rpc/pg-meta endpoint via service role
  const r = await fetch(SU + '/rest/v1/rpc/exec_sql', {
    method: 'POST',
    headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  })
  return { status: r.status, body: await r.text() }
}

export async function GET() {
  // Run each column addition via direct postgres through Supabase's REST
  // Supabase doesn't expose raw DDL via REST, but we can use the pg extension
  const results: Record<string, unknown> = {}

  const stmts = [
    ['bio',              "ALTER TABLE artists ADD COLUMN IF NOT EXISTS bio text"],
    ['anomaly_flag',     "ALTER TABLE artists ADD COLUMN IF NOT EXISTS anomaly_flag boolean DEFAULT false"],
    ['anomaly_reason',   "ALTER TABLE artists ADD COLUMN IF NOT EXISTS anomaly_reason text"],
    ['anomaly_flagged_at',"ALTER TABLE artists ADD COLUMN IF NOT EXISTS anomaly_flagged_at timestamptz"],
    ['anomaly_delta',    "ALTER TABLE artists ADD COLUMN IF NOT EXISTS anomaly_delta numeric"],
    ['score_prev_cycle', "ALTER TABLE artists ADD COLUMN IF NOT EXISTS score_prev_cycle numeric"],
    ['press_dedup',      "DELETE FROM artist_press_signals WHERE id NOT IN (SELECT DISTINCT ON (artist_id) id FROM artist_press_signals ORDER BY artist_id, captured_at DESC)"],
    ['press_constraint', "ALTER TABLE artist_press_signals ADD CONSTRAINT artist_press_signals_artist_id_unique UNIQUE (artist_id)"],
    ['sentiment_constraint', "ALTER TABLE artist_sentiment_signals ADD CONSTRAINT artist_sentiment_signals_artist_id_unique UNIQUE (artist_id)"],
  ]

  for (const [name, stmt] of stmts) {
    const r = await sql(stmt)
    results[name] = r
  }

  return NextResponse.json(results)
}
