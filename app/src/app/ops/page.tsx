'use client'
import { useEffect, useState, useCallback } from 'react'

function timeAgo(iso: string | null) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)    return s + 's ago'
  if (s < 3600)  return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SUPA_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1'
const SH = { 'apikey': SUPA_ANON, 'Authorization': 'Bearer ' + SUPA_ANON }

const STAGE_COL: Record<string, string> = { established: '#a78bfa', breaking: '#fb923c', rising: '#fbbf24', emerging: '#60a5fa' }
const LABEL_COL: Record<string, string> = { Exploding: '#f87171', Rising: '#fb923c', Gaining: '#34d399', Emerging: '#60a5fa', 'Early signals': '#6b7280' }

type Stats = {
  counts: { artists: number; articles: number; mentions: number; streaming: number; sentiment: number; press: number; heatHistory: number }
  lastRun: { scored: string|null; article: string|null; sentiment: string|null; streaming: string|null; press: string|null }
  spotifyActive: boolean
  pressActive: boolean
}

export default function OpsPage() {
  const [stats, setStats]   = useState<Stats | null>(null)
  const [weights, setWeights] = useState<any[]>([])
  const [top10, setTop10]   = useState<any[]>([])
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [tick, setTick]     = useState(0)

  const load = useCallback(async () => {
    try {
      const [statsRes, weightsRes, top10Res] = await Promise.all([
        fetch('/api/ops-stats').then(r => r.json()),
        fetch(SUPA_BASE + '/stage_weight_config?select=*&order=listener_min.asc', { headers: SH }).then(r => r.json()),
        fetch(SUPA_BASE + '/artists?select=name,heat_score,heat_label,career_stage&order=heat_score.desc&limit=10', { headers: SH }).then(r => r.json()),
      ])
      setStats(statsRes)
      setWeights(Array.isArray(weightsRes) ? weightsRes : [])
      setTop10(Array.isArray(top10Res) ? top10Res : [])
      setLastFetch(new Date())
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(() => { load(); setTick(n => n+1) }, 30000); return () => clearInterval(t) }, [load])
  useEffect(() => { const t = setInterval(() => setTick(n => n+1), 1000); return () => clearInterval(t) }, [])

  const minsSince = (iso: string | null) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 60000) : null

  const scorerMins  = minsSince(stats?.lastRun.scored || null)
  const sentMins    = minsSince(stats?.lastRun.sentiment || null)
  const streamMins  = minsSince(stats?.lastRun.streaming || null)
  const pressMins   = minsSince(stats?.lastRun.press || null)

  const scorerStatus = scorerMins !== null ? (scorerMins <= 20 ? 'ok' : 'warn') : 'unknown'
  const sentStatus   = sentMins   !== null ? (sentMins   <= 15 ? 'ok' : 'warn') : 'unknown'
  const streamStatus = streamMins !== null ? (streamMins <= 60 ? 'ok' : 'warn') : 'unknown'
  const pressStatus  = pressMins  !== null ? (pressMins  <= 60 ? 'ok' : 'warn') : 'unknown'

  const dot = (s: string) => s === 'ok' ? '#34d399' : s === 'warn' ? '#fb923c' : '#6b7280'
  const fmt = (n: number) => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(0)+'K' : n.toString()

  if (!stats) return (
    <div style={{ background: '#080c0e', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#34d399', fontFamily: 'monospace', fontSize: 13, letterSpacing: 2 }}>LOADING OPS...</div>
    </div>
  )

  const total = stats.counts.artists || 1

  return (
    <div style={{ background: '#080c0e', minHeight: '100vh', color: '#e2e8f0', fontFamily: "'IBM Plex Mono','Fira Code',monospace", padding: '24px 20px', maxWidth: 1200, margin: '0 auto' }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 28, borderBottom: '1px solid #1a2530', paddingBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: '#34d399', letterSpacing: 4, textTransform: 'uppercase', marginBottom: 4 }}>Tunedex</div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.5 }}>Operations Dashboard</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 2 }}>LAST REFRESH</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>{lastFetch ? lastFetch.toLocaleTimeString() : '—'}</div>
          <div style={{ fontSize: 10, color: '#34d399', marginTop: 2, letterSpacing: 1 }}>↺ AUTO 30s</div>
        </div>
      </div>

      {/* Pipeline status */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 10 }}>Pipeline Status</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {[
            { label: 'Heat Scorer',        sub: 'cron */15 * * * *', t: stats.lastRun.scored,    status: scorerStatus },
            { label: 'Sentiment / Spotify', sub: 'every ~10 min',    t: stats.lastRun.sentiment, status: sentStatus   },
            { label: 'Streaming',           sub: 'batched per cycle', t: stats.lastRun.streaming, status: streamStatus },
            { label: 'Press / RSS',         sub: 'every 90s',        t: stats.lastRun.press,     status: pressStatus  },
          ].map(s => (
            <div key={s.label} style={{ background: '#0d1519', border: `1px solid ${s.status === 'ok' ? '#1a3a2a' : s.status === 'warn' ? '#3a2a10' : '#1a2530'}`, borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot(s.status), boxShadow: `0 0 6px ${dot(s.status)}`, flexShrink: 0 }} />
                <div style={{ fontSize: 11, fontWeight: 500, color: '#cbd5e1' }}>{s.label}</div>
              </div>
              <div style={{ fontSize: 17, fontWeight: 600, color: s.status === 'ok' ? '#34d399' : s.status === 'warn' ? '#fb923c' : '#6b7280', marginBottom: 3 }}>{timeAgo(s.t)}</div>
              <div style={{ fontSize: 9, color: '#4a6070' }}>{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Signal coverage — 7 tiles including heat history */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 10 }}>Signal Coverage</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
          {[
            { label: 'Artists',      val: stats.counts.artists,     max: total,  color: '#a78bfa' },
            { label: 'Articles',     val: stats.counts.articles,    max: 1000,   color: '#60a5fa' },
            { label: 'Mentions',     val: stats.counts.mentions,    max: 10000,  color: '#60a5fa' },
            { label: 'Streaming',    val: stats.counts.streaming,   max: total,  color: stats.spotifyActive ? '#34d399' : '#fb923c' },
            { label: 'Sentiment',    val: stats.counts.sentiment,   max: total,  color: '#34d399' },
            { label: 'Press Sigs',   val: stats.counts.press,       max: total,  color: stats.pressActive ? '#34d399' : '#fb923c' },
            { label: 'Heat Records', val: stats.counts.heatHistory, max: 500000, color: '#a78bfa' },
          ].map(s => {
            const pct = Math.min(Math.round((s.val / (s.max || 1)) * 100), 100)
            return (
              <div key={s.label} style={{ background: '#0d1519', border: '1px solid #1a2530', borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 9, color: '#4a6070', marginBottom: 5, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: s.color, marginBottom: 6 }}>{fmt(s.val)}</div>
                <div style={{ height: 3, background: '#1a2530', borderRadius: 2 }}>
                  <div style={{ height: '100%', width: pct + '%', background: s.color, borderRadius: 2, transition: 'width 0.6s ease' }} />
                </div>
                <div style={{ fontSize: 9, color: '#4a6070', marginTop: 3 }}>{pct}% of max</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Data sources */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 10 }}>Data Sources</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {[
            { label: 'Spotify',      active: stats.spotifyActive, detail: fmt(stats.counts.streaming) + ' artists with data',    role: 'Streaming primary (pop 0–100)' },
            { label: 'Last.fm',      active: stats.counts.sentiment > 0, detail: fmt(stats.counts.sentiment) + ' artists scored', role: 'Sentiment composite (30%)' },
            { label: 'YouTube',      active: stats.counts.sentiment > 0, detail: 'Recent video engagement',                       role: 'Sentiment composite (20%)' },
            { label: '19 RSS Feeds', active: stats.pressActive,  detail: fmt(stats.counts.articles) + ' articles ingested',       role: 'Press signal — every 90s' },
          ].map(s => (
            <div key={s.label} style={{ background: '#0d1519', border: `1px solid ${s.active ? '#1a3a2a' : '#2a1a1a'}`, borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: s.active ? '#34d399' : '#f87171', boxShadow: `0 0 6px ${s.active ? '#34d399' : '#f87171'}`, flexShrink: 0 }} />
                <div style={{ fontSize: 11, fontWeight: 500 }}>{s.label}</div>
                <div style={{ marginLeft: 'auto', fontSize: 9, color: s.active ? '#34d399' : '#f87171', letterSpacing: 1 }}>{s.active ? 'LIVE' : 'OFFLINE'}</div>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 3 }}>{s.detail}</div>
              <div style={{ fontSize: 9, color: '#4a6070' }}>{s.role}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Weight matrix + top 10 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ background: '#0d1519', border: '1px solid #1a2530', borderRadius: 8, padding: '16px 18px' }}>
          <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 12 }}>Scoring Weight Matrix</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: '#4a6070', fontSize: 9, letterSpacing: 1 }}>
                {['STAGE','STREAM','BRAND','SENT','RADIO','PRESS','∑'].map(h => (
                  <th key={h} style={{ textAlign: h === 'STAGE' ? 'left' : 'right', paddingBottom: 8, fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weights.map(w => {
                const sum = w.weight_streaming + w.weight_brand + w.weight_sentiment + w.weight_radio + w.weight_press
                return (
                  <tr key={w.stage} style={{ borderTop: '1px solid #111c24' }}>
                    <td style={{ padding: '7px 0', color: STAGE_COL[w.stage] || '#94a3b8', fontWeight: 500 }}>{w.stage}</td>
                    {[w.weight_streaming, w.weight_brand, w.weight_sentiment, w.weight_radio, w.weight_press].map((v: number, i: number) => (
                      <td key={i} style={{ textAlign: 'right', color: '#cbd5e1' }}>{v}</td>
                    ))}
                    <td style={{ textAlign: 'right', color: '#4a6070' }}>{sum}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 9, color: '#4a6070', borderTop: '1px solid #111c24', paddingTop: 8 }}>
            Weights normalised at runtime — live from DB each cycle
          </div>
        </div>

        <div style={{ background: '#0d1519', border: '1px solid #1a2530', borderRadius: 8, padding: '16px 18px' }}>
          <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 12 }}>
            Current Top 10
            <span style={{ marginLeft: 10, color: '#34d399', fontSize: 9 }}>scored {timeAgo(stats.lastRun.scored)}</span>
          </div>
          {top10.map((a, i) => (
            <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: i > 0 ? '1px solid #111c24' : undefined }}>
              <div style={{ width: 16, fontSize: 9, color: '#4a6070', textAlign: 'right', flexShrink: 0 }}>{i+1}</div>
              <div style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ fontSize: 9, color: STAGE_COL[a.career_stage] || '#6b7280', flexShrink: 0 }}>{a.career_stage}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: LABEL_COL[a.heat_label] || '#94a3b8', flexShrink: 0, width: 34, textAlign: 'right' }}>{a.heat_score?.toFixed(1)}</div>
              <div style={{ fontSize: 9, color: LABEL_COL[a.heat_label] || '#6b7280', flexShrink: 0, width: 68, textAlign: 'right' }}>{a.heat_label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 20, borderTop: '1px solid #1a2530', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 9, color: '#4a6070', letterSpacing: 2 }}>TUNEDEX OPS · AUTO-REFRESH 30s</div>
        <a href="/" style={{ fontSize: 9, color: '#4a6070', letterSpacing: 2, textDecoration: 'none' }}>← HEAT INDEX</a>
      </div>
    </div>
  )
}
