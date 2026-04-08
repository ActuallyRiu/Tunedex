import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface HeatRow {
  artist_id: string
  artist_name: string
  final_score: number
  heat_label: string
  career_stage: string
  scored_at: string
}

const labelColour: Record<string, string> = {
  'Exploding':  'text-orange-400',
  'Rising':     'text-yellow-400',
  'Steady':     'text-blue-400',
  'Cooling':    'text-slate-400',
  'Cold':       'text-slate-600',
}

export const revalidate = 60

export default async function Home() {
  const { data, error } = await supabase
    .from('artist_heat_leaderboard')
    .select('*')
    .limit(50)

  const rows: HeatRow[] = data ?? []

  return (
    <main className="max-w-3xl mx-auto px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Tunedex</h1>
        <p className="text-slate-400 mt-1 text-sm">Real-time artist heat scores · updated every 15 min</p>
      </div>
      {error && <p className="text-red-400 text-sm mb-4">Error: {error.message}</p>}
      {rows.length === 0 && !error && (
        <p className="text-slate-500 text-sm">Pipeline warming up — check back soon.</p>
      )}
      <ol className="space-y-2">
        {rows.map((row, i) => (
          <li key={row.artist_id} className="flex items-center justify-between bg-zinc-900 rounded-lg px-4 py-3">
            <div className="flex items-center gap-4">
              <span className="text-slate-600 text-sm w-6 text-right">{i + 1}</span>
              <div>
                <p className="font-medium">{row.artist_name}</p>
                <p className="text-xs text-slate-500 capitalize">{row.career_stage}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold">{Number(row.final_score).toFixed(1)}</p>
              <p className="text-xs text-slate-400">{row.heat_label}</p>
            </div>
          </li>
        ))}
      </ol>
    </main>
  )
}