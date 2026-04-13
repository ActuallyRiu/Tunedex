'use client'
import { useEffect, useState, useCallback } from 'react'

const SVC  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const B    = SURL + '/rest/v1'
const H    = { apikey: SVC, Authorization: 'Bearer ' + SVC }

function ago(iso: string | null) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)  return s + 's ago'
  if (s < 3600) return Math.floor(s/60) + 'm ago'
  if (s < 86400) return Math.floor(s/3600) + 'h ago'
  return Math.floor(s/86400) + 'd ago'
}
function pct(n: number, total: number) { return total ? Math.round(n/total*100) : 0 }
function fmt(n: number) { return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : String(n) }

const LABEL_COLOR: Record<string,string> = {
  Exploding: '#ff4444', Rising: '#ff9500', Gaining: '#34d399', Emerging: '#60a5fa', 'Early signals': '#6b7280'
}
const STAGE_COLOR: Record<string,string> = {
  established: '#a78bfa', breaking: '#fb923c', rising: '#facc15', emerging: '#38bdf8'
}

type OpsData = {
  artists: number
  articles: number
  mentions: number
  streaming: number
  sentiment: number
  pressSigs: number
  spotifyIds: number
  lastScored: string | null
  lastArticle: string | null
  lastSentiment: string | null
  lastStreaming: string | null
  top10: Array<{ name: string; score: number; label: string; stage: string; scored: string }>
  weights: Array<{ stage: string; weight_streaming: number; weight_brand: number; weight_sentiment: number; weight_radio: number; weight_press: number }>
  recentPress: Array<{ title: string; source_name: string; published_at: string }>
  anomalies: Array<{ name: string; delta: number; reason: string; flagged_at: string }>
  scoreDistrib: { exploding: number; rising: number; gaining: number; emerging: number; early: number }
  avgScore: number
}

async function fetchOps(): Promise<OpsData> {
  const hc = { ...H, Prefer: 'count=exact', Range: '0-0' }
  const [
    artists, articles, mentions, streaming, sentiment, pressSigs, spotifyIds,
    lastScored, lastArticle, lastSentiment, lastStreaming,
    top10, weights, recentPress, anomalies, allScores
  ] = await Promise.all([
    fetch(B+'/artists?select=count',               {headers:hc}).then(r=>r.headers.get('content-range')),
    fetch(B+'/articles?select=count',              {headers:hc}).then(r=>r.headers.get('content-range')),
    fetch(B+'/artist_mentions?select=count',       {headers:hc}).then(r=>r.headers.get('content-range')),
    fetch(B+'/artist_streaming_signals?select=count',{headers:hc}).then(r=>r.headers.get('content-range')),
    fetch(B+'/artist_sentiment_signals?select=count',{headers:hc}).then(r=>r.headers.get('content-range')),
    fetch(B+'/artist_press_signals?select=count&article_count_7d=gt.0',{headers:hc}).then(r=>r.headers.get('content-range')),
    fetch(B+'/artists?select=count&spotify_id=not.is.null',{headers:hc}).then(r=>r.headers.get('content-range')),
    fetch(B+'/artists?select=last_scored_at&order=last_scored_at.desc&limit=1',{headers:H}).then(r=>r.json()),
    fetch(B+'/articles?select=published_at&order=published_at.desc&limit=1',{headers:H}).then(r=>r.json()),
    fetch(B+'/artist_sentiment_signals?select=captured_at&order=captured_at.desc&limit=1',{headers:H}).then(r=>r.json()),
    fetch(B+'/artist_streaming_signals?select=captured_at&order=captured_at.desc&limit=1',{headers:H}).then(r=>r.json()),
    fetch(B+'/artists?select=name,heat_score,heat_label,career_stage,last_scored_at&order=heat_score.desc&limit=10',{headers:H}).then(r=>r.json()),
    fetch(B+'/stage_weight_config?select=stage,weight_streaming,weight_brand,weight_sentiment,weight_radio,weight_press&order=listener_min.asc',{headers:H}).then(r=>r.json()),
    fetch(B+'/articles?select=title,source_name,published_at&order=published_at.desc&limit=8',{headers:H}).then(r=>r.json()),
    fetch(B+'/artists?select=name,anomaly_delta,anomaly_reason,anomaly_flagged_at&anomaly_flag=eq.true&order=anomaly_flagged_at.desc&limit=5',{headers:H}).then(r=>r.json()),
    fetch(B+'/artists?select=heat_score,heat_label&limit=2000',{headers:H}).then(r=>r.json()),
  ])

  const parse = (cr: string|null) => parseInt(cr?.split('/')?.[1] || '0')
  const scores = (allScores as any[]).map(a => a.heat_score).filter(Boolean)
  const avg    = scores.length ? Math.round(scores.reduce((a:number,b:number)=>a+b,0)/scores.length*10)/10 : 0
  const labels = (allScores as any[]).map(a => a.heat_label)
  return {
    artists:      parse(artists),
    articles:     parse(articles),
    mentions:     parse(mentions),
    streaming:    parse(streaming),
    sentiment:    parse(sentiment),
    pressSigs:    parse(pressSigs),
    spotifyIds:   parse(spotifyIds),
    lastScored:   (lastScored as any[])[0]?.last_scored_at || null,
    lastArticle:  (lastArticle as any[])[0]?.published_at || null,
    lastSentiment:(lastSentiment as any[])[0]?.captured_at || null,
    lastStreaming:(lastStreaming as any[])[0]?.captured_at || null,
    top10:        (top10 as any[]).map(a=>({name:a.name,score:a.heat_score,label:a.heat_label,stage:a.career_stage,scored:ago(a.last_scored_at)})),
    weights:      weights as any[],
    recentPress:  recentPress as any[],
    anomalies:    anomalies as any[],
    scoreDistrib: {
      exploding: labels.filter((l:string)=>l==='Exploding').length,
      rising:    labels.filter((l:string)=>l==='Rising').length,
      gaining:   labels.filter((l:string)=>l==='Gaining').length,
      emerging:  labels.filter((l:string)=>l==='Emerging').length,
      early:     labels.filter((l:string)=>l==='Early signals').length,
    },
    avgScore: avg,
  }
}

function Bar({ value, total, color = '#34d399' }: { value: number; total: number; color?: string }) {
  const p = pct(value, total)
  return (
    <div className="relative h-1 bg-white/[0.06] rounded-full overflow-hidden mt-2">
      <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-700" style={{ width: p+'%', background: color }} />
    </div>
  )
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? 'bg-emerald-400' : 'bg-red-500'}`} style={ok ? { boxShadow: '0 0 6px #34d399' } : { boxShadow: '0 0 6px #f87171' }} />
}

function SectionLabel({ label }: { label: string }) {
  return <div className="text-[10px] tracking-[0.2em] text-slate-600 font-mono uppercase mb-3">{label}</div>
}

export default function OpsPage() {
  const [data, setData]       = useState<OpsData | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [countdown, setCountdown]     = useState(30)
  const [loading, setLoading]         = useState(true)

  const refresh = useCallback(async () => {
    try {
      const d = await fetchOps()
      setData(d)
      setLastRefresh(new Date())
      setCountdown(30)
    } catch(e) { console.error(e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown(c => { if (c <= 1) { refresh(); return 30 } return c - 1 })
    }, 1000)
    return () => clearInterval(t)
  }, [refresh])

  if (loading) return (
    <div className="min-h-screen bg-[#080808] flex items-center justify-center">
      <div className="font-mono text-emerald-400 text-sm animate-pulse tracking-widest">INITIALISING OPS...</div>
    </div>
  )
  if (!data) return null

  const total = data.artists

  return (
    <div className="min-h-screen bg-[#080808] text-white font-mono" style={{ fontFamily: "'Courier New', monospace" }}>
      {/* Header */}
      <div className="border-b border-white/[0.06] px-6 py-4 flex items-center justify-between">
        <div>
          <div className="text-[10px] tracking-[0.25em] text-emerald-400 mb-1">TUNEDEX</div>
          <div className="text-xl font-bold tracking-tight" style={{ fontFamily: 'inherit' }}>Operations Dashboard</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-slate-600 tracking-widest mb-1">LAST REFRESH</div>
          <div className="text-emerald-400 text-sm">{lastRefresh?.toLocaleTimeString('en-GB', {hour12:false}) || '—'}</div>
          <button onClick={refresh} className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors mt-0.5 tracking-widest">
            ↺ AUTO {countdown}s
          </button>
        </div>
      </div>

      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">

        {/* Pipeline Status */}
        <div>
          <SectionLabel label="Pipeline Status" />
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Heat Scorer',        time: data.lastScored,     schedule: 'cron */15 * * * *',  ok: data.lastScored ? (Date.now()-new Date(data.lastScored).getTime()) < 20*60*1000 : false },
              { label: 'Sentiment / Spotify',time: data.lastSentiment,  schedule: 'every ~10 min',      ok: data.lastSentiment ? (Date.now()-new Date(data.lastSentiment).getTime()) < 20*60*1000 : false },
              { label: 'Streaming Signals',  time: data.lastStreaming,   schedule: 'batched by cycle',   ok: data.lastStreaming ? (Date.now()-new Date(data.lastStreaming).getTime()) < 30*60*1000 : false },
              { label: 'Press / RSS',        time: data.lastArticle,    schedule: 'every 90s',          ok: data.lastArticle ? (Date.now()-new Date(data.lastArticle).getTime()) < 10*60*1000 : false },
            ].map(s => (
              <div key={s.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="flex items-center mb-1">
                  <StatusDot ok={s.ok} />
                  <span className="text-[11px] text-slate-400 tracking-wide">{s.label}</span>
                </div>
                <div className={`text-xl font-bold mt-2 ${s.ok ? 'text-emerald-400' : s.time ? 'text-amber-400' : 'text-red-400'}`}>
                  {ago(s.time)}
                </div>
                <div className="text-[10px] text-slate-700 mt-1">{s.schedule}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Signal Coverage */}
        <div>
          <SectionLabel label="Signal Coverage" />
          <div className="grid grid-cols-6 gap-3">
            {[
              { label: 'Artists',    value: data.artists,   total: 934, color: '#a78bfa' },
              { label: 'Articles',   value: data.articles,  total: 5000, color: '#60a5fa' },
              { label: 'Mentions',   value: data.mentions,  total: 5000, color: '#60a5fa' },
              { label: 'Streaming',  value: data.streaming, total,       color: '#34d399' },
              { label: 'Sentiment',  value: data.sentiment, total,       color: '#34d399' },
              { label: 'Press Sigs', value: data.pressSigs, total,       color: data.pressSigs/total < 0.5 ? '#f59e0b' : '#34d399' },
            ].map(s => (
              <div key={s.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="text-[10px] text-slate-600 tracking-widest mb-1">{s.label.toUpperCase()}</div>
                <div className="text-2xl font-bold" style={{ color: s.color }}>{fmt(s.value)}</div>
                <Bar value={s.value} total={s.total} color={s.color} />
                <div className="text-[10px] text-slate-700 mt-1">{pct(s.value, s.total)}% coverage</div>
              </div>
            ))}
          </div>
        </div>

        {/* Data Sources + Score Distribution */}
        <div className="grid grid-cols-2 gap-6">
          {/* Data Sources */}
          <div>
            <SectionLabel label="Data Sources" />
            <div className="space-y-2">
              {[
                { name: 'Spotify',     detail: `${data.spotifyIds} artists cached · popularity + followers`, sub: 'Streaming primary signal (50% sentiment weight)', ok: data.spotifyIds > 0 },
                { name: 'Last.fm',     detail: `${data.sentiment} artists with sentiment data`,              sub: 'Sentiment composite (30%)',                        ok: data.sentiment > 0 },
                { name: 'YouTube',     detail: 'Recent video engagement scoring',                              sub: 'Sentiment composite (20%)',                        ok: true },
                { name: '19 RSS Feeds',detail: `${data.articles} articles ingested`,                        sub: 'Press signal — every 90s',                         ok: data.articles > 0 },
              ].map(s => (
                <div key={s.name} className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StatusDot ok={s.ok} />
                    <div>
                      <div className="text-sm text-white">{s.name}</div>
                      <div className="text-[10px] text-slate-600">{s.detail}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-[10px] px-2 py-0.5 rounded ${s.ok ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'}`}>
                      {s.ok ? 'LIVE' : 'STALE'}
                    </div>
                    <div className="text-[10px] text-slate-700 mt-1">{s.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Score Distribution */}
          <div>
            <SectionLabel label="Score Distribution" />
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 h-full">
              <div className="flex items-center justify-between mb-4">
                <div className="text-[10px] text-slate-600 tracking-widest">AVERAGE SCORE</div>
                <div className="text-2xl font-bold text-white">{data.avgScore}</div>
              </div>
              <div className="space-y-3">
                {[
                  { label: 'Exploding',     count: data.scoreDistrib.exploding, color: '#ff4444' },
                  { label: 'Rising',        count: data.scoreDistrib.rising,    color: '#ff9500' },
                  { label: 'Gaining',       count: data.scoreDistrib.gaining,   color: '#34d399' },
                  { label: 'Emerging',      count: data.scoreDistrib.emerging,  color: '#60a5fa' },
                  { label: 'Early signals', count: data.scoreDistrib.early,     color: '#6b7280' },
                ].map(d => (
                  <div key={d.label} className="flex items-center gap-3">
                    <div className="text-[10px] w-24 shrink-0" style={{ color: d.color }}>{d.label}</div>
                    <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: pct(d.count, total)+'%', background: d.color }} />
                    </div>
                    <div className="text-[10px] text-slate-500 w-8 text-right tabular-nums">{d.count}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Weight Matrix + Anomalies */}
        <div className="grid grid-cols-2 gap-6">
          {/* Weight Matrix */}
          <div>
            <SectionLabel label="Scoring Weight Matrix" />
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {['STAGE','STREAM','BRAND','SENT','RADIO','PRESS','Σ'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-slate-600 tracking-widest font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.weights.map(w => {
                    const sum = w.weight_streaming + w.weight_brand + w.weight_sentiment + w.weight_radio + w.weight_press
                    return (
                      <tr key={w.stage} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-3 py-2.5" style={{ color: STAGE_COLOR[w.stage] || '#fff' }}>{w.stage}</td>
                        <td className="px-3 py-2.5 text-slate-300">{w.weight_streaming}</td>
                        <td className="px-3 py-2.5 text-slate-300">{w.weight_brand}</td>
                        <td className="px-3 py-2.5 text-slate-300">{w.weight_sentiment}</td>
                        <td className="px-3 py-2.5 text-slate-300">{w.weight_radio}</td>
                        <td className="px-3 py-2.5 text-slate-300">{w.weight_press}</td>
                        <td className="px-3 py-2.5 text-slate-600">{sum}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Anomalies */}
          <div>
            <SectionLabel label={`Spike Alerts (${data.anomalies.length})`} />
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              {data.anomalies.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-700 text-[11px] tracking-widest">NO ACTIVE ANOMALIES</div>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {data.anomalies.map((a, i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-sm font-medium text-amber-400">{a.name}</div>
                        <div className="text-[10px] text-amber-400/70">+{a.delta?.toFixed(1)}pts</div>
                      </div>
                      <div className="text-[10px] text-slate-600 leading-relaxed">{a.reason}</div>
                      <div className="text-[10px] text-slate-700 mt-1">{ago(a.flagged_at)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Top 10 + Recent Press */}
        <div className="grid grid-cols-2 gap-6">
          {/* Top 10 */}
          <div>
            <SectionLabel label="Current Top 10" />
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              <div className="divide-y divide-white/[0.04]">
                {data.top10.map((a, i) => (
                  <div key={a.name} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="text-[11px] text-slate-700 tabular-nums w-4 shrink-0">{i+1}</div>
                    <div className="flex-1 min-w-0">
                      <a href={`/artist/${a.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'')}`}
                         className="text-sm text-white hover:text-emerald-400 transition-colors truncate block">{a.name}</a>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] px-1.5 py-px rounded" style={{ background: (STAGE_COLOR[a.stage]||'#888')+'22', color: STAGE_COLOR[a.stage]||'#888' }}>{a.stage}</span>
                        <span className="text-[10px] text-slate-700">scored {a.scored}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-base font-bold tabular-nums text-white">{a.score?.toFixed(1)}</div>
                      <div className="text-[10px]" style={{ color: LABEL_COLOR[a.label] || '#6b7280' }}>{a.label}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Recent Press */}
          <div>
            <SectionLabel label="Recent Press Ingested" />
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              {data.recentPress.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-700 text-[11px] tracking-widest">NO RECENT ARTICLES</div>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {data.recentPress.map((p, i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="text-[11px] text-slate-300 leading-snug line-clamp-2">{p.title}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-slate-600">{p.source_name}</span>
                        <span className="text-slate-800">·</span>
                        <span className="text-[10px] text-slate-700">{ago(p.published_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
