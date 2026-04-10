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
  const up = value > 0
  const flat = value === 0
  const colour = flat ? 'text-slate-500' : up ? 'text-emerald-400' : 'text-rose-400'
  const bg     = flat ? 'bg-slate-800' : up ? 'bg-emerald-500/10' : 'bg-rose-500/10'
  const border = flat ? 'border-slate-700' : up ? 'border-emerald-500/20' : 'border-rose-500/20'
  const sign   = flat ? '' : up ? '+' : ''
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded border ${bg} ${border} ${colour}`}>
      {!flat && <span className="text-[10px]">{up ? '▲' : '▼'}</span>}
      {sign}{value.toFixed(1)}%
      <span className="text-[10px] opacity-60 ml-0.5">{label}</span>
    </span>
  )
}

function RankArrow({ delta }: { delta: number | null }) {
  if (delta === null || delta === 0) return <span className="text-slate-700 text-sm">—</span>
  if (delta > 0) return <span className="text-emerald-400 text-sm font-bold">▲</span>
  return <span className="text-rose-400 text-sm font-bold">▼</span>
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diff < 1) return 'just now'
  if (diff < 60) return `${diff}m ago`
  return `${Math.floor(diff / 60)}h ago`
}

export const revalidate = 60

export default async function Home() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/get_heat_leaderboard`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
    cache: 'no-store',
  }).catch(() => null)

  // Fall back to direct API call
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

  const apiRes = await fetch(`${baseUrl}/api/artists/heat?limit=50`, { cache: 'no-store' })
  const { artists = [] }: { artists: Artist[] } = await apiRes.json().catch(() => ({ artists: [] }))

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-10">

        {/* Header */}
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Tunedex <span className="text-emerald-400">Heat Index</span>
            </h1>
            <p className="text-slate-500 mt-1 text-sm">
              UMG roster · {artists.length} artists · updated every 15 min
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-600">last updated</div>
            <div className="text-xs text-slate-400">
              {artists[0]?.last_scored_at ? timeAgo(artists[0].last_scored_at) : '—'}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex gap-3 mb-5 text-xs text-slate-500 flex-wrap">
          <span className="flex items-center gap-1"><span className="text-emerald-400 text-[10px]">▲</span> rising score</span>
          <span className="flex items-center gap-1"><span className="text-rose-400 text-[10px]">▼</span> falling score</span>
          <span className="flex items-center gap-1 ml-2">badges show % change vs</span>
          <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px]">1h</span>
          <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px]">24h</span>
        </div>

        {/* Table header */}
        <div className="grid grid-cols-[32px_16px_1fr_auto] gap-3 px-3 mb-2 text-xs text-slate-600 uppercase tracking-wider">
          <span>#</span>
          <span></span>
          <span>Artist</span>
          <span className="text-right">Score</span>
        </div>

        {/* Leaderboard */}
        {artists.length === 0 ? (
          <div className="text-slate-600 text-sm py-12 text-center">
            Pipeline warming up — check back in 15 minutes.
          </div>
        ) : (
          <div className="space-y-1.5">
            {artists.map((artist) => (
              <div
                key={artist.id}
                className="grid grid-cols-[32px_16px_1fr_auto] gap-3 items-center px-3 py-3 rounded-xl bg-white/[0.03] border border-white/[0.05] hover:bg-white/[0.06] hover:border-white/[0.08] transition-all"
              >
                {/* Rank */}
                <span className="text-slate-600 text-sm tabular-nums text-right">{artist.rank}</span>

                {/* Arrow */}
                <RankArrow delta={artist.delta_24h} />

                {/* Name + badges */}
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{artist.name}</div>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STAGE_STYLE[artist.career_stage] ?? STAGE_STYLE.emerging}`}>
                      {artist.career_stage}
                    </span>
                    <DeltaBadge value={artist.delta_1h}  label="1h" />
                    <DeltaBadge value={artist.delta_24h} label="24h" />
                  </div>
                </div>

                {/* Score */}
                <div className="text-right flex-shrink-0">
                  <div className={`text-[11px] font-medium ${LABEL_COLOUR[artist.heat_label] ?? 'text-slate-400'}`}>
                    {artist.heat_label}
                  </div>
                  <div className="text-xl font-bold tabular-nums leading-none mt-0.5">
                    {artist.heat_score?.toFixed(1)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 text-center text-xs text-slate-700">
          Scores based on streaming, press, sentiment, brand & radio signals
        </div>
      </div>
    </div>
  )
}
