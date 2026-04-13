'use client'

import { useEffect, useState, useMemo } from 'react'

interface Artist {
  id: string
  name: string
  rank: number
  heat_score: number
  slug: string
  anomaly_flag?: boolean
  anomaly_reason?: string
  anomaly_delta?: number
  heat_label: string
  career_stage: string
  last_scored_at: string
  monthly_listeners: number
  delta_24h: number | null
  delta_1h: number | null
}

const SU = 'https://lwmzrccvwxbdrrpzojeg.supabase.co'
const SK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3bXpyY2N2d3hiZHJycHpvamVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NTk4NDcsImV4cCI6MjA5MDQzNTg0N30.frFP2f0XrwgOrHAgdcSUwn3HBE2wYnFdhQLiU-7YJ4Y'
const PAGE_SIZE = 75

const STAGE_STYLE: Record<string, string> = {
  established: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
  breaking:    'bg-orange-500/15 text-orange-300 border-orange-500/25',
  rising:      'bg-yellow-500/15 text-yellow-300 border-yellow-500/25',
  emerging:    'bg-slate-700/50 text-slate-400 border-slate-600/30',
}
const LABEL_COLOUR: Record<string, string> = {
  'Exploding': 'text-orange-400', 'Rising': 'text-yellow-400',
  'Gaining': 'text-emerald-400', 'Emerging': 'text-blue-400', 'Early signals': 'text-slate-500',
}
const STAGES = ['all', 'established', 'breaking', 'rising', 'emerging']
const LABELS = ['all', 'Exploding', 'Rising', 'Gaining', 'Emerging', 'Early signals']

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diff < 1) return 'just now'
  if (diff < 60) return diff + 'm ago'
  return Math.floor(diff / 60) + 'h ago'
}

function DeltaBadge({ value, label }: { value: number | null; label: string }) {
  if (value === null) return null
  const up = value > 0.05
  const dn = value < -0.05
  const colour = dn ? 'text-rose-400' : up ? 'text-emerald-400' : 'text-slate-500'
  const bg = dn ? 'bg-rose-500/10 border-rose-500/20' : up ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-slate-800 border-slate-700'
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border ${bg} ${colour}`}>
      {up && <span className="text-[9px]">&#x25b2;</span>}{dn && <span className="text-[9px]">&#x25bc;</span>}
      {up ? '+' : ''}{value.toFixed(1)}%<span className="opacity-50 ml-0.5">{label}</span>
    </span>
  )
}

async function fetchArtists(): Promise<Artist[]> {
  const H = { apikey: SK, Authorization: 'Bearer ' + SK }
  const now    = new Date()
  const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const ago1h  = new Date(now.getTime() -  1 * 60 * 60 * 1000).toISOString()

  // Main artists fetch
  const res = await fetch(SU + '/rest/v1/artists?select=id,name,slug,heat_score,heat_label,career_stage,last_scored_at,monthly_listeners,anomaly_flag,anomaly_reason,anomaly_delta&heat_score=gt.0&order=heat_score.desc&limit=1000', { headers: H })
  const raw: Artist[] = await res.json()
  if (!raw?.length) return []

  // FIX: don't pass IDs in URL — query full history window then join client-side
  // This avoids the 27k-char URL that was causing 400 errors and infinite loading
  const [h24, h1] = await Promise.all([
    fetch(SU + '/rest/v1/artist_heat_history?select=artist_id,final_score&scored_at=gte.' + ago24h + '&order=scored_at.asc&limit=5000', { headers: H }).then(r => r.json()),
    fetch(SU + '/rest/v1/artist_heat_history?select=artist_id,final_score&scored_at=gte.' + ago1h  + '&order=scored_at.asc&limit=5000', { headers: H }).then(r => r.json()),
  ])

  const first24: Record<string, number> = {}
  const first1:  Record<string, number> = {}
  for (const row of (h24 || [])) if (!first24[row.artist_id]) first24[row.artist_id] = row.final_score
  for (const row of (h1  || [])) if (!first1[row.artist_id])  first1[row.artist_id]  = row.final_score

  return raw.map((a, i) => {
    const p24 = first24[a.id], p1 = first1[a.id]
    return {
      ...a, rank: i + 1,
      delta_24h: p24 > 0 ? parseFloat(((a.heat_score - p24) / p24 * 100).toFixed(1)) : null,
      delta_1h:  p1  > 0 ? parseFloat(((a.heat_score - p1)  / p1  * 100).toFixed(1)) : null,
    }
  })
}

export default function Home() {
  const [artists, setArtists]   = useState<Artist[]>([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [stageFilter, setStage] = useState('all')
  const [labelFilter, setLabel] = useState('all')
  const [sortBy, setSort]       = useState<'score' | 'delta_24h' | 'delta_1h' | 'name'>('score')
  const [activeTab, setActiveTab] = useState<'index' | 'compare'>('index')
  const [pinned, setPinned]       = useState<Artist[]>([])
  const [compareSearch, setCompareSearch] = useState('')
  const [page, setPage]         = useState(1)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const data = await fetchArtists()
        if (!cancelled) { setArtists(data); setLoading(false) }
      } catch(e) {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, 90000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  useEffect(() => { setPage(1) }, [search, stageFilter, labelFilter, sortBy])

  const compareResults = useMemo(() => {
    if (!compareSearch.trim()) return []
    const q = compareSearch.toLowerCase()
    return artists.filter(a => a.name.toLowerCase().includes(q)).slice(0, 6)
  }, [artists, compareSearch])

  const filtered = useMemo(() => {
    let list = [...artists]
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter(a => a.name.toLowerCase().includes(q)) }
    if (stageFilter !== 'all') list = list.filter(a => a.career_stage === stageFilter)
    if (labelFilter !== 'all') list = list.filter(a => a.heat_label === labelFilter)
    if (sortBy === 'delta_24h') list.sort((a,b) => {
    if (a.anomaly_flag && !b.anomaly_flag) return 1
    if (!a.anomaly_flag && b.anomaly_flag) return -1
    return (b.delta_24h ?? -999) - (a.delta_24h ?? -999)
  })
    if (sortBy === 'delta_1h')  list.sort((a,b) => {
    if (a.anomaly_flag && !b.anomaly_flag) return 1
    if (!a.anomaly_flag && b.anomaly_flag) return -1
    return (b.delta_1h ?? -999) - (a.delta_1h ?? -999)
  })
    if (sortBy === 'name')      list.sort((a,b) => a.name.localeCompare(b.name))
    return list
  }, [artists, search, stageFilter, labelFilter, sortBy])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages)
  const pageStart  = (safePage - 1) * PAGE_SIZE
  const pageItems  = filtered.slice(pageStart, pageStart + PAGE_SIZE)

  const pageNums = useMemo(() => {
    const nums: number[] = []
    const start = Math.max(1, safePage - 3), end = Math.min(totalPages, safePage + 3)
    for (let i = start; i <= end; i++) nums.push(i)
    return nums
  }, [safePage, totalPages])

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* ── Compare tab ── */}
        {activeTab === 'compare' && (
          <div>
            <div className="mb-2 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold tracking-tight mb-0.5">Artist Compare</h2>
                <p className="text-slate-500 text-sm">Search and pin up to 4 artists to compare their heat scores and momentum side by side.</p>
              </div>
              <button onClick={() => setActiveTab('index')} className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1 mt-1 shrink-0">← Back</button>
            </div>

            {/* Search */}
            <div className="relative mt-4 mb-4">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">🔍</span>
              <input
                value={compareSearch}
                onChange={e => setCompareSearch(e.target.value)}
                placeholder="Search artists to compare..."
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 focus:bg-white/[0.06] transition-all"
              />
            </div>

            {/* Search results dropdown */}
            {compareSearch.trim() && compareResults.length > 0 && (
              <div className="mb-4 border border-white/[0.08] rounded-xl overflow-hidden bg-[#111]">
                {compareResults.map(a => {
                  const already = pinned.some(p => p.id === a.id)
                  const full = pinned.length >= 4 && !already
                  return (
                    <button
                      key={a.id}
                      disabled={full}
                      onClick={() => {
                        if (!already && pinned.length < 4) {
                          setPinned(prev => [...prev, a])
                          setCompareSearch('')
                        }
                      }}
                      className={'w-full flex items-center justify-between px-4 py-2.5 text-left transition-all border-b border-white/[0.04] last:border-0 ' + (full ? 'opacity-30 cursor-not-allowed' : already ? 'bg-emerald-500/10' : 'hover:bg-white/[0.05]')}
                    >
                      <div>
                        <span className="text-sm font-medium text-white">{a.name}</span>
                        <span className={'ml-2 text-[10px] px-1.5 py-0.5 rounded border font-medium ' + (STAGE_STYLE[a.career_stage] ?? STAGE_STYLE.emerging)}>{a.career_stage}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">{a.heat_score?.toFixed(1)}</span>
                        {already ? <span className="text-[10px] text-emerald-400">Added</span> : full ? <span className="text-[10px] text-slate-600">Full</span> : <span className="text-[10px] text-slate-500">+ Add</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {compareSearch.trim() && compareResults.length === 0 && (
              <div className="mb-4 text-sm text-slate-600 px-1">No artists found for "{compareSearch}"</div>
            )}

            {/* Pinned artist cards */}
            {pinned.length === 0 ? (
              <div className="py-16 text-center border border-white/[0.05] rounded-2xl">
                <div className="text-slate-600 text-sm">Search for artists above to start comparing</div>
              </div>
            ) : (
              <div>
                {/* Score bars header */}
                {pinned.length > 1 && (
                  <div className="mb-3 text-[10px] text-slate-600 uppercase tracking-widest px-1">Relative heat score</div>
                )}
                <div className="space-y-2">
                  {(() => {
                    const maxScore = Math.max(...pinned.map(a => a.heat_score || 0))
                    return pinned.map((a, idx) => (
                      <div key={a.id} className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
                        {/* Top row: rank + name + remove */}
                        <div className="flex items-start justify-between gap-2 mb-2.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-slate-600 text-xs tabular-nums w-5 text-right shrink-0">#{a.rank}</span>
                            <div className="min-w-0">
                              <div className="font-medium text-sm truncate">{a.name}</div>
                              <span className={'text-[10px] px-1.5 py-0.5 rounded border font-medium ' + (STAGE_STYLE[a.career_stage] ?? STAGE_STYLE.emerging)}>{a.career_stage}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <div className="text-right">
                              <div className={'text-[10px] font-semibold mb-0.5 ' + (LABEL_COLOUR[a.heat_label] ?? 'text-slate-500')}>{a.heat_label}</div>
                              <div className="text-2xl font-bold tabular-nums leading-none">{a.heat_score?.toFixed(1)}</div>
                            </div>
                            <button
                              onClick={() => setPinned(prev => prev.filter(p => p.id !== a.id))}
                              className="text-slate-700 hover:text-slate-400 transition-colors text-lg leading-none ml-1"
                            >×</button>
                          </div>
                        </div>
                        {/* Delta badges */}
                        <div className="flex items-center gap-1.5 mb-2.5">
                          <DeltaBadge value={a.delta_1h} label="1h" />
                          <DeltaBadge value={a.delta_24h} label="24h" />
                        </div>
                        {/* Score bar */}
                        <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: maxScore > 0 ? ((a.heat_score || 0) / maxScore * 100) + '%' : '0%',
                              background: idx === 0 ? '#34d399' : idx === 1 ? '#60a5fa' : idx === 2 ? '#f472b6' : '#fb923c'
                            }}
                          />
                        </div>
                      </div>
                    ))
                  })()}
                </div>

                {/* Add another prompt */}
                {pinned.length < 4 && (
                  <div className="mt-2 text-center text-xs text-slate-700 py-2">
                    {4 - pinned.length} slot{pinned.length < 3 ? 's' : ''} remaining — search above to add more
                  </div>
                )}

                {/* Clear all */}
                <div className="mt-4 text-center">
                  <button onClick={() => setPinned([])} className="text-xs text-slate-700 hover:text-slate-500 transition-colors">
                    Clear all
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Heat Index tab ── */}
        {activeTab === 'index' && <div>
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Tunedex <span className="text-emerald-400">Heat Index</span></h1>
            <p className="text-sm text-slate-400 mt-1 mb-3 leading-relaxed max-w-lg">
              Real-time artist momentum scoring across streaming, press, sentiment, radio, and brand signals.
              Updated every 15 minutes — the higher the score, the more heat an artist is generating right now.
            </p>
            <p className="text-slate-500 mt-1 text-sm">
              {loading ? 'Loading…' : filtered.length + ' artists · page ' + safePage + ' of ' + totalPages}
              {!loading && artists[0]?.last_scored_at && <span className="ml-2 text-slate-600">· scored {timeAgo(artists[0].last_scored_at)}</span>}
            </p>
          </div>
        </div>

        <div className="flex gap-2 items-center mb-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">&#x1F50D;</span>
          <div className="relative flex-1">
            <input type="text" placeholder="Search artists…" value={search} onChange={e => setSearch(e.target.value)}
              className="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl pl-9 pr-9 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 focus:bg-white/[0.07] transition-all" />
          </div>
          <button
            onClick={() => setActiveTab('compare')}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-medium border transition-all whitespace-nowrap bg-white/[0.04] border-white/[0.08] text-slate-400 hover:text-white hover:bg-white/[0.07]"
          >
            ⇄ Compare
          </button>
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm">✕</button>}
        </div>

        <div className="flex gap-1 mb-2 flex-wrap">
          {STAGES.map(s => (
            <button key={s} onClick={() => setStage(s)}
              className={'text-[11px] px-2.5 py-1 rounded-lg border font-medium transition-all ' + (stageFilter === s ? 'bg-white/10 border-white/20 text-white' : 'border-white/[0.06] text-slate-500 hover:text-slate-300 hover:border-white/10')}>
              {s === 'all' ? 'All stages' : s}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
          <div className="flex gap-1 flex-wrap">
            {LABELS.map(l => (
              <button key={l} onClick={() => setLabel(l)}
                className={'text-[11px] px-2.5 py-1 rounded-lg border font-medium transition-all ' + (labelFilter === l ? 'bg-white/10 border-white/20 text-white' : 'border-white/[0.06] text-slate-500 hover:text-slate-300 hover:border-white/10')}>
                {l === 'all' ? 'All heat' : l}
              </button>
            ))}
          </div>
          <select value={sortBy} onChange={e => setSort(e.target.value as typeof sortBy)}
            className="text-[11px] bg-white/[0.04] border border-white/[0.07] text-slate-400 rounded-lg px-2.5 py-1 focus:outline-none focus:border-white/20 cursor-pointer">
            <option value="score">Sort: Score</option>
            <option value="delta_24h">Sort: 24h change</option>
            <option value="delta_1h">Sort: 1h change</option>
            <option value="name">Sort: A–Z</option>
          </select>
        </div>

        <div className="grid grid-cols-[28px_14px_1fr_auto] gap-3 px-3 mb-2 text-[10px] text-slate-600 uppercase tracking-widest">
          <span className="text-right">#</span><span></span><span>Artist</span><span className="text-right">Score</span>
        </div>

        {loading ? (
          <div className="space-y-1">{[...Array(10)].map((_,i) => <div key={i} className="h-14 rounded-xl bg-white/[0.03] border border-white/[0.04] animate-pulse" />)}</div>
        ) : pageItems.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-slate-500 text-sm">No artists match</div>
            <button onClick={() => { setSearch(''); setStage('all'); setLabel('all') }} className="mt-3 text-xs text-emerald-400 hover:text-emerald-300">Clear all filters</button>
          </div>
        ) : (
          <div className="space-y-1">
            {pageItems.map(a => (
              <a key={a.id} href={'/artist/' + a.slug} className="grid grid-cols-[28px_14px_1fr_auto] gap-3 items-center px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.055] hover:border-white/[0.07] transition-all cursor-pointer">
                <span className="text-slate-600 text-xs tabular-nums text-right">{a.rank}</span>
                <span className="text-xs font-bold">
                  {a.delta_24h === null ? <span className="text-slate-700">—</span> : a.delta_24h > 0.05 ? <span className="text-emerald-400">&#x25b2;</span> : a.delta_24h < -0.05 ? <span className="text-rose-400">&#x25bc;</span> : <span className="text-slate-600">—</span>}
                </span>
                <div className="min-w-0">
                  <div className="font-medium text-sm leading-snug truncate">{a.name}</div>
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    <span className={'text-[10px] px-1.5 py-0.5 rounded border font-medium ' + (STAGE_STYLE[a.career_stage] ?? STAGE_STYLE.emerging)}>{a.career_stage}</span>
                    <DeltaBadge value={a.delta_1h} label="1h" /><DeltaBadge value={a.delta_24h} label="24h" />
                  </div>
                </div>
                <div className="text-right flex-shrink-0 pl-2">
                  {a.anomaly_flag
                    ? <span title={a.anomaly_reason || 'Score spike detected — under review'} className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 cursor-help">⚠ {a.anomaly_delta ? (a.anomaly_delta > 0 ? '+' : '') + a.anomaly_delta.toFixed(1) + 'pts' : 'spike'}</span>
                    : <div className={'text-[10px] font-semibold ' + (LABEL_COLOUR[a.heat_label] ?? 'text-slate-500')}>{a.heat_label}</div>
                  }
                  <div className="text-[22px] font-bold tabular-nums leading-none mt-0.5">{a.heat_score?.toFixed(1)}</div>
                </div>
              </a>
            ))}
          </div>
        )}

        {!loading && totalPages > 1 && (
          <div className="mt-6 flex items-center justify-center gap-1">
            <button onClick={() => { setPage(p => Math.max(1,p-1)); window.scrollTo(0,0) }} disabled={safePage===1}
              className="px-3 py-1.5 rounded-lg text-xs border transition-all disabled:opacity-20 disabled:cursor-not-allowed border-white/[0.07] text-slate-400 hover:bg-white/[0.05] hover:text-white">← Prev</button>
            {pageNums[0] > 1 && <><button onClick={() => { setPage(1); window.scrollTo(0,0) }} className="w-8 h-8 rounded-lg text-xs border border-white/[0.07] text-slate-500 hover:bg-white/[0.05] hover:text-white transition-all">1</button>{pageNums[0] > 2 && <span className="text-slate-700 text-xs px-1">…</span>}</>}
            {pageNums.map(n => (
              <button key={n} onClick={() => { setPage(n); window.scrollTo(0,0) }}
                className={'w-8 h-8 rounded-lg text-xs border transition-all ' + (n===safePage ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400 font-semibold' : 'border-white/[0.07] text-slate-400 hover:bg-white/[0.05] hover:text-white')}>{n}</button>
            ))}
            {pageNums[pageNums.length-1] < totalPages && <>{pageNums[pageNums.length-1] < totalPages-1 && <span className="text-slate-700 text-xs px-1">…</span>}<button onClick={() => { setPage(totalPages); window.scrollTo(0,0) }} className="w-8 h-8 rounded-lg text-xs border border-white/[0.07] text-slate-500 hover:bg-white/[0.05] hover:text-white transition-all">{totalPages}</button></>}
            <button onClick={() => { setPage(p => Math.min(totalPages,p+1)); window.scrollTo(0,0) }} disabled={safePage===totalPages}
              className="px-3 py-1.5 rounded-lg text-xs border transition-all disabled:opacity-20 disabled:cursor-not-allowed border-white/[0.07] text-slate-400 hover:bg-white/[0.05] hover:text-white">Next →</button>
          </div>
        )}

        {!loading && pageItems.length > 0 && (
          <div className="mt-4 text-center text-xs text-slate-700">
            {pageStart+1}–{Math.min(pageStart+PAGE_SIZE,filtered.length)} of {filtered.length} artists · Signals: streaming · press · sentiment · brand · radio
          </div>
        )}
      </div>}

      </div>
    </div>
  )
}
