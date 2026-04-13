'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

const STAGE_STYLE: Record<string, string> = {
  established: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
  breaking:    'bg-orange-500/15 text-orange-300 border-orange-500/25',
  rising:      'bg-yellow-500/15 text-yellow-300 border-yellow-500/25',
  emerging:    'bg-blue-500/15 text-blue-300 border-blue-500/25',
}

const LABEL_COLOUR: Record<string, string> = {
  Exploding:      'text-red-400',
  Rising:         'text-orange-400',
  Gaining:        'text-emerald-400',
  Emerging:       'text-sky-400',
  'Early signals':'text-slate-400',
}

type ArtistData = {
  artist: {
    id: string; name: string; slug: string; genres: string[]
    monthly_listeners: number; career_stage: string
    heat_score: number; heat_label: string; last_scored_at: string; bio: string | null
  }
  articles: Array<{ title: string; source_name: string; original_url: string; published_at: string }>
  topTracks: Array<{ name: string; playcount: string; listeners: string; url: string }>
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return 'just now'
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

function fmtListeners(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return n.toString()
}

export default function ArtistPage() {
  const { slug } = useParams() as { slug: string }
  const [data, setData] = useState<ArtistData | null>(null)
  const [error, setError]  = useState('')

  useEffect(() => {
    if (!slug) return
    fetch('/api/artist/' + slug)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError('Artist not found'); return }
        setData(d)
      })
      .catch(() => setError('Failed to load artist'))
  }, [slug])

  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-slate-500 mb-3">{error}</div>
          <a href="/" className="text-xs text-emerald-400 hover:underline">← Back to Heat Index</a>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
        <div className="text-slate-600 text-sm animate-pulse">Loading...</div>
      </div>
    )
  }

  const { artist, articles, topTracks } = data

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-8">

        <a href="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1 mb-6">← Heat Index</a>

        <div className="mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-3xl font-bold tracking-tight mb-1">{artist.name}</h1>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={'text-[11px] px-2 py-0.5 rounded border font-medium ' + (STAGE_STYLE[artist.career_stage] ?? STAGE_STYLE.emerging)}>{artist.career_stage}</span>
                {artist.genres.map(g => (
                  <span key={g} className="text-[11px] px-2 py-0.5 rounded border border-white/[0.06] text-slate-500">{g}</span>
                ))}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className={'text-xs font-semibold mb-0.5 ' + (LABEL_COLOUR[artist.heat_label] ?? 'text-slate-500')}>{artist.heat_label}</div>
              <div className="text-4xl font-bold tabular-nums leading-none">{artist.heat_score?.toFixed(1)}</div>
              <div className="text-[10px] text-slate-600 mt-1">{fmtListeners(artist.monthly_listeners)} monthly listeners</div>
            </div>
          </div>
        </div>

        <div className="mb-6 bg-white/[0.03] border border-white/[0.05] rounded-xl p-4">
          <div className="text-[10px] text-slate-600 uppercase tracking-widest mb-2">About</div>
          <p className="text-sm text-slate-300 leading-relaxed">{artist.bio || 'No bio available.'}</p>
        </div>

        {topTracks.length > 0 && (
          <div className="mb-6">
            <div className="text-[10px] text-slate-600 uppercase tracking-widest mb-2 px-1">Top songs</div>
            <div className="space-y-1">
              {topTracks.map((t, i) => (
                <a key={t.name} href={t.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.055] hover:border-white/[0.07] transition-all group">
                  <span className="text-slate-700 text-xs tabular-nums w-4 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate group-hover:text-emerald-400 transition-colors">{t.name}</div>
                    <div className="text-[10px] text-slate-600">{t.playcount} plays · {t.listeners} listeners</div>
                  </div>
                  <span className="text-slate-700 text-xs group-hover:text-slate-500 transition-colors">↗</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {articles.length > 0 && (
          <div className="mb-6">
            <div className="text-[10px] text-slate-600 uppercase tracking-widest mb-2 px-1">Recent news</div>
            <div className="space-y-1">
              {articles.map((a, i) => (
                <a key={i} href={a.original_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.055] hover:border-white/[0.07] transition-all group">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium leading-snug group-hover:text-emerald-400 transition-colors line-clamp-2">{a.title}</div>
                    <div className="text-[10px] text-slate-600 mt-0.5">{a.source_name} · {timeAgo(a.published_at)}</div>
                  </div>
                  <span className="text-slate-700 text-xs shrink-0 mt-0.5 group-hover:text-slate-500 transition-colors">↗</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {articles.length === 0 && (
          <div className="text-center py-8 text-slate-700 text-sm">No recent press coverage found.</div>
        )}

      </div>
    </div>
  )
}
