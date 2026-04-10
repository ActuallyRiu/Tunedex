import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface Artist {
  id: string
  name: string
  rank: number
  heat_score: number
  heat_label: string
  career_stage: string
  last_scored_at: string
  monthly_listeners: number
  delta_24h: number | null
  delta_1h: number | null
}

const STAGE_STYLE: Record<string, string> = {
  established: 'bg-violet-500/15 text-violet-300 border border-violet-500/20',
  breaking:    'bg-orange-500/15 text-orange-300 border border-orange-500/20',
  rising:      'bg-yellow-500/15 text-yellow-300 border border-yellow-500/20',
  emerging:    'bg-slate-700/60 text-slate-400 border border-slate-600/30',
}

const LABEL_COLOUR: Record<string, string> = {
  'Exploding':     'text-orange-400',
  'Rising':        'text-yellow-400',
  'Gaining':       'text-emerald-400',
  'Emerging':      'text-blue-400',
  'Early signals': 'text-slate-500',
}

function DeltaBadge({ value, label }: { value: number | null; label: string }) {
  if (value === null) return null
  const up   = value > 0.05
  const down = value < -0.05
  const colour = down ? 'text-rose-400' : up ? 'text-emerald-400' : 'text-slate-500'
  const bg     = down ? 'bg-rose-500/10 border-rose-500/20' : up ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-slate-800 border-slate-700'
  const sign   = up ? '+' : ''
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border ${bg} ${colour}`}>
      {up && <span className="text-[9px]">â²</span>}
      {down && <span className="text-[9px]">â¼</span>}
      {sign}{value.toFixed(1)}%
      <span className="opacity-50 ml-0.5">{label}</span>
    </span>
  )
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diff < 1) return 'just now'
  if (diff < 60) return diff + 'm ago'
  return Math.floor(diff / 60) + 'h ago'
}

async function getLeaderboard(): Promise<Artist[]> {
  const { data: artists } = await supabase
    .from('artists')
    .select('id, name, heat_score, heat_label, career_stage, last_scored_at, monthly_listeners')
    .gt('heat_score', 0)
    .order('heat_score', { ascending: false })
    .limit(50)

  if (!artists?.length) return []

  const now    = new Date()
  const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const ago1h  = new Date(now.getTime() -  1 * 60 * 60 * 1000).toISOString()
  const ids    = artists.map(a => a.id)

  const [{ data: hist24h }, { data: hist1h }] = await Promise.all([
    supabase.from('artist_heat_history').select('artist_id, final_score').in('artist_id', ids).gte('scored_at', ago24h).order('scored_at', { ascending: true }),
    supabase.from('artist_heat_history').select('artist_id, final_score').in('artist_id', ids).gte('scored_at', ago1h).order('scored_at', { ascending: true }),
  ])

  const first24: Record<string, number> = {}
  const first1:  Record<string, number> = {}
  for (const row of (hist24h || [])) if (!first24[row.artist_id]) first24[row.artist_id] = row.final_score
  for (const row of (hist1h  || [])) if (!first1[row.artist_id])  first1[row.artist_id]  = row.final_score

  return artists.map((a, i) => {
    const p24 = first24[a.id]
    const p1  = first1[a.id]
    return {
      ...a,
      rank: i + 1,
      delta_24h: p24 != null && p24 > 0 ? parseFloat(((a.heat_score - p24) / p24 * 100).toFixed(1)) : null,
      delta_1h:  p1  != null && p1  > 0 ? parseFloat(((a.heat_score - p1)  / p1  * 100).toFixed(1)) : null,
    }
  })
}

export const revalidate = 60

export default async function Home() {
  const artists = await getLeaderboard()

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-10">

        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Tunedex <span className="text-emerald-400">Heat Index</span>
            </h1>
            <p className="text-slate-500 mt-1 text-sm">
               Â· {artists.length} artists Â· updated every 15 min
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-600">last scored</div>
            <div className="text-xs text-slate-400">
              {artists[0]?.last_scored_at ? timeAgo(artists[0].last_scored_at) : 'â'}
            </div>
          </div>
        </div>

        <div className="flex gap-3 mb-5 text-xs text-slate-600 flex-wrap items-center">
          <span className="flex items-center gap-1"><span className="text-emerald-400 text-[10px]">â²</span> gaining</span>
          <span className="flex items-center gap-1"><span className="text-rose-400 text-[10px]">â¼</span> falling</span>
          <span className="ml-1">Â· % vs</span>
          <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] font-medium">1h</span>
          <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] font-medium">24h</span>
        </div>

        <div className="grid grid-cols-[28px_14px_1fr_auto] gap-3 px-3 mb-2 text-[10px] text-slate-600 uppercase tracking-widest">
          <span className="text-right">#</span>
          <span></span>
          <span>Artist</span>
          <span className="text-right">Score</span>
        </div>

        {artists.length === 0 ? (
          <div className="text-slate-600 text-sm py-16 text-center">
            Pipeline warming up â check back in 15 min.
          </div>
        ) : (
          <div className="space-y-1">
            {artists.map((a) => (
              <div key={a.id} className="grid grid-cols-[28px_14px_1fr_auto] gap-3 items-center px-3 py-3 rounded-xl bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.05] transition-colors">

                <span className="text-slate-600 text-xs tabular-nums text-right">{a.rank}</span>

                <span className="text-xs font-bold">
                  {a.delta_24h === null ? <span className="text-slate-700">â</span>
                    : a.delta_24h > 0.05 ? <span className="text-emerald-400">â²</span>
                    : a.delta_24h < -0.05 ? <span className="text-rose-400">â¼</span>
                    : <span className="text-slate-600">â</span>}
                </span>

                <div className="min-w-0">
                  <div className="font-medium text-sm leading-snug truncate">{a.name}</div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STAGE_STYLE[a.career_stage] ?? STAGE_STYLE.emerging}`}>
                      {a.career_stage}
                    </span>
                    <DeltaBadge value={a.delta_1h}  label="1h" />
                    <DeltaBadge value={a.delta_24h} label="24h" />
                  </div>
                </div>

                <div className="text-right flex-shrink-0 pl-2">
                  <div className={`text-[10px] font-semibold ${LABEL_COLOUR[a.heat_label] ?? 'text-slate-500'}`}>
                    {a.heat_label}
                  </div>
                  <div className="text-[22px] font-bold tabular-nums leading-none mt-0.5">
                    {a.heat_score?.toFixed(1)}
                  </div>
                </div>

              </div>
            ))}
          </div>
        )}

        <div className="mt-10 text-center text-xs text-slate-700">
          Signals: streaming Â· press Â· sentiment Â· brand Â· radio
        </div>
      </div>
    </div>
  )
}
