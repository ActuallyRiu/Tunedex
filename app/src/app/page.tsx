import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface Artist {
  id: string
  name: string
  heat_score: number
  heat_label: string
  career_stage: string
  last_scored_at: string
}

const labelColour: Record<string, string> = {
  'Exploding': 'text-orange-400',
  'Rising':    'text-yellow-400',
  'Gaining':   'text-green-400',
  'Emerging':  'text-blue-400',
  'Early signals': 'text-slate-400',
}

const stageColour: Record<string, string> = {
  'established': 'bg-purple-900/40 text-purple-300',
  'breaking':    'bg-orange-900/40 text-orange-300',
  'rising':      'bg-yellow-900/40 text-yellow-300',
  'emerging':    'bg-slate-800 text-slate-400',
}

export const revalidate = 60

export default async function Home() {
  const { data, error } = await supabase
    .from('artists')
    .select('id, name, heat_score, heat_label, career_stage, last_scored_at')
    .gt('heat_score', 0)
    .order('heat_score', { ascending: false })
    .limit(50)

  const artists: Artist[] = data ?? []

  return (
    <main className="max-w-2xl mx-auto px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Tunedex</h1>
        <p className="text-slate-400 mt-1 text-sm">Real-time artist heat scores · updated every 15 min</p>
      </div>

      {error && (
        <div className="text-red-400 text-sm mb-4">Error loading data: {error.message}</div>
      )}

      {artists.length === 0 ? (
        <div className="text-slate-500 text-sm">Pipeline warming up — check back soon.</div>
      ) : (
        <div className="space-y-2">
          {artists.map((artist, i) => (
            <div key={artist.id} className="flex items-center gap-4 p-3 rounded-lg bg-white/5 hover:bg-white/8 transition-colors">
              <span className="text-slate-600 text-sm w-6 text-right flex-shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{artist.name}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${stageColour[artist.career_stage] ?? 'bg-slate-800 text-slate-400'}`}>
                    {artist.career_stage}
                  </span>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className={`font-semibold ${labelColour[artist.heat_label] ?? 'text-slate-300'}`}>
                  {artist.heat_label}
                </div>
                <div className="text-2xl font-bold tabular-nums">{artist.heat_score?.toFixed(1)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 text-xs text-slate-600 text-center">
        UMG roster · {artists.length} artists scored
      </div>
    </main>
  )
}
