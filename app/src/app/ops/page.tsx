'use client'
import { useEffect, useState, useCallback } from 'react'

const SVC  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1'
const H    = { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC }
const CH   = { ...H, 'Prefer': 'count=exact', 'Range': '0-0' }

function timeAgo(iso: string | null) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)   return s + 's ago'
  if (s < 3600) return Math.floor(s/60) + 'm ago'
  if (s < 86400)return Math.floor(s/3600) + 'h ago'
  return Math.floor(s/86400) + 'd ago'
}

function parseCount(cr: string | null): number {
  if (!cr) return 0
  const m = cr.match(/(\d+)$/)
  return m ? parseInt(m[1]) : 0
}

type OpsData = {
  counts:  { artists: number; articles: number; mentions: number; streaming: number; sentiment: number; press: number }
  lastRun: { scored: string|null; article: string|null; sentiment: string|null; streaming: string|null }
  top10:   Array<{ name: string; heat_score: number; heat_label: string; career_stage: string }>
  weights: Array<{ stage: string; weight_streaming: number; weight_brand: number; weight_sentiment: number; weight_radio: number; weight_press: number }>
  spotifyActive: boolean
  pressActive:   boolean
}

async function fetchOpsData(): Promise<OpsData> {
  const count = (table: string, filter = '') =>
    fetch(`${BASE}/${table}?select=count${filter}`, { headers: CH }).then(r => r.headers.get('content-range'))

  const [aC, artC, menC, strC, senC, preC,
         lastScored, lastArt, lastSen, lastStr,
         weights, top10, spotifyCheck, pressCheck] = await Promise.all([
    count('artists'),
    count('articles'),
    count('artist_mentions'),
    count('artist_streaming_signals'),
    count('artist_sentiment_signals'),
    count('artist_press_signals'),
    fetch(BASE + '/artists?select=last_scored_at&order=last_scored_at.desc&limit=1', { headers: H }).then(r => r.json()),
    fetch(BASE + '/articles?select=published_at&order=published_at.desc&limit=1', { headers: H }).then(r => r.json()),
    fetch(BASE + '/artist_sentiment_signals?select=captured_at&order=captured_at.desc&limit=1', { headers: H }).then(r => r.json()),
    fetch(BASE + '/artist_streaming_signals?select=captured_at&order=captured_at.desc&limit=1', { headers: H }).then(r => r.json()),
    fetch(BASE + '/stage_weight_config?select=*&order=listener_min.asc', { headers: H }).then(r => r.json()),
    fetch(BASE + '/artists?select=name,heat_score,heat_label,career_stage&order=heat_score.desc&limit=10', { headers: H }).then(r => r.json()),
    fetch(BASE + '/artist_streaming_signals?select=spotify_popularity&spotify_popularity=not.is.null&limit=1', { headers: H }).then(r => r.json()),
    fetch(BASE + '/artist_press_signals?select=article_count_7d&article_count_7d=gt.0&limit=1', { headers: H }).then(r => r.json()),
  ])

  return {
    counts: {
      artists:   parseCount(aC),
      articles:  parseCount(artC),
      mentions:  parseCount(menC),
      streaming: parseCount(strC),
      sentiment: parseCount(senC),
      press:     parseCount(preC),
    },
    lastRun: {
      scored:    lastScored[0]?.last_scored_at || null,
      article:   lastArt[0]?.published_at || null,
      sentiment: lastSen[0]?.captured_at || null,
      streaming: lastStr[0]?.captured_at || null,
    },
    top10:         Array.isArray(top10) ? top10 : [],
    weights:       Array.isArray(weights) ? weights : [],
    spotifyActive: Array.isArray(spotifyCheck) && spotifyCheck.length > 0,
    pressActive:   Array.isArray(pressCheck) && pressCheck.length > 0,
  }
}

const LABEL_COL: Record<string, string> = {
  Exploding: '#f87171', Rising: '#fb923c', Gaining: '#34d399', Emerging: '#60a5fa', 'Early signals': '#6b7280'
}
const STAGE_COL: Record<string, string> = {
  established: '#a78bfa', breaking: '#fb923c', rising: '#fbbf24', emerging: '#60a5fa'
}

export default function OpsPage() {
  const [data, setData]       = useState<OpsData | null>(null)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [tick, setTick]       = useState(0)

  const load = useCallback(async () => {
    try {
      const d = await fetchOpsData()
      setData(d)
      setLastFetch(new Date())
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(() => { load(); setTick(n => n+1) }, 30000); return () => clearInterval(t) }, [load])
  useEffect(() => { const t = setInterval(() => setTick(n => n+1), 1000); return () => clearInterval(t) }, [])

  const scoredAgo  = data?.lastRun.scored    ? Math.floor((Date.now() - new Date(data.lastRun.scored).getTime()) / 60000) : null
  const sentAgo    = data?.lastRun.sentiment ? Math.floor((Date.now() - new Date(data.lastRun.sentiment).getTime()) / 60000) : null
  const streamAgo  = data?.lastRun.streaming ? Math.floor((Date.now() - new Date(data.lastRun.streaming).getTime()) / 60000) : null
  const articleAgo = data?.lastRun.article   ? Math.floor((Date.now() - new Date(data.lastRun.article).getTime()) / 60000) : null

  const scorerStatus  = scoredAgo  !== null ? (scoredAgo  <= 20 ? 'ok' : 'warn') : 'unknown'
  const sentStatus    = sentAgo    !== null ? (sentAgo    <= 15 ? 'ok' : 'warn') : 'unknown'
  const streamStatus  = streamAgo  !== null ? (streamAgo  <= 30 ? 'ok' : 'warn') : 'unknown'
  const pressStatus   = articleAgo !== null ? (articleAgo <= 60 ? 'ok' : 'warn') : 'unknown'

  const dot = (s: string) => s === 'ok' ? '#34d399' : s === 'warn' ? '#fb923c' : '#6b7280'

  if (!data) return (
    <div style={{ background: '#080c0e', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#34d399', fontFamily: 'monospace', fontSize: 13, letterSpacing: 2 }}>LOADING OPS...</div>
    </div>
  )

  return (
    <div style={{ background: '#080c0e', minHeight: '100vh', color: '#e2e8f0', fontFamily: "'IBM Plex Mono', 'Fira Code', monospace", padding: '24px 20px' }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 32, borderBottom: '1px solid #1a2530', paddingBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: '#34d399', letterSpacing: 4, textTransform: 'uppercase', marginBottom: 4 }}>Tunedex</div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.5 }}>Operations Dashboard</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 2 }}>LAST REFRESH</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>{lastFetch ? lastFetch.toLocaleTimeString() : '—'}</div>
          <div style={{ fontSize: 10, color: '#34d399', marginTop: 2, letterSpacing: 1 }}>↺ AUTO 30s</div>
        </div>
      </div>

      {/* Pipeline status row */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 12 }}>Pipeline Status</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {[
            { label: 'Heat Scorer',       sub: 'cron */15 * * * *', when: data.lastRun.scored,    status: scorerStatus,  detail: scoredAgo !== null ? scoredAgo + 'm ago' : '—' },
            { label: 'Sentiment / Spotify', sub: 'every ~10 min',     when: data.lastRun.sentiment, status: sentStatus,    detail: sentAgo   !== null ? sentAgo   + 'm ago' : '—' },
            { label: 'Streaming',          sub: 'batched by cycle',   when: data.lastRun.streaming, status: streamStatus,  detail: streamAgo !== null ? streamAgo + 'm ago' : '—' },
            { label: 'Press / RSS',        sub: 'every 90s',          when: data.lastRun.article,   status: pressStatus,   detail: articleAgo !== null ? articleAgo + 'm ago' : '—' },
          ].map(s => (
            <div key={s.label} style={{ background: '#0d1519', border: `1px solid ${s.status === 'ok' ? '#1a3a2a' : s.status === 'warn' ? '#3a2a10' : '#1a2530'}`, borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot(s.status), boxShadow: `0 0 6px ${dot(s.status)}` }} />
                <div style={{ fontSize: 11, fontWeight: 500, color: '#cbd5e1' }}>{s.label}</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, color: s.status === 'ok' ? '#34d399' : s.status === 'warn' ? '#fb923c' : '#6b7280', marginBottom: 4 }}>{s.detail}</div>
              <div style={{ fontSize: 10, color: '#4a6070' }}>{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Signal coverage */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 12 }}>Signal Coverage</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
          {[
            { label: 'Artists',   val: data.counts.artists,   max: data.counts.artists,   color: '#a78bfa' },
            { label: 'Articles',  val: data.counts.articles,  max: 500,                    color: '#60a5fa' },
            { label: 'Mentions',  val: data.counts.mentions,  max: 5000,                   color: '#60a5fa' },
            { label: 'Streaming', val: data.counts.streaming, max: data.counts.artists,    color: data.spotifyActive ? '#34d399' : '#fb923c' },
            { label: 'Sentiment', val: data.counts.sentiment, max: data.counts.artists,    color: '#34d399' },
            { label: 'Press Sigs',val: data.counts.press,     max: data.counts.artists,    color: data.pressActive  ? '#34d399' : '#fb923c' },
          ].map(s => {
            const pct = Math.min(Math.round((s.val / (s.max || 1)) * 100), 100)
            return (
              <div key={s.label} style={{ background: '#0d1519', border: '1px solid #1a2530', borderRadius: 8, padding: '14px 16px' }}>
                <div style={{ fontSize: 10, color: '#4a6070', marginBottom: 6, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
                <div style={{ fontSize: 20, fontWeight: 600, color: s.color, marginBottom: 8 }}>{s.val.toLocaleString()}</div>
                <div style={{ height: 3, background: '#1a2530', borderRadius: 2 }}>
                  <div style={{ height: '100%', width: pct + '%', background: s.color, borderRadius: 2, transition: 'width 0.6s ease' }} />
                </div>
                <div style={{ fontSize: 9, color: '#4a6070', marginTop: 4 }}>{pct}% coverage</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Data sources */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 12 }}>Data Sources</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {[
            { label: 'Spotify',  active: data.spotifyActive, detail: data.counts.streaming + ' artists with popularity data', role: 'Streaming primary signal' },
            { label: 'Last.fm',  active: true,               detail: data.counts.sentiment + ' artists with sentiment data',   role: 'Sentiment composite (30%)' },
            { label: 'YouTube',  active: true,               detail: 'Recent video engagement scoring',                        role: 'Sentiment composite (20%)' },
            { label: '19 RSS Feeds', active: data.pressActive, detail: data.counts.articles + ' articles ingested',             role: 'Press signal — every 90s' },
          ].map(s => (
            <div key={s.label} style={{ background: '#0d1519', border: `1px solid ${s.active ? '#1a3a2a' : '#2a1a1a'}`, borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: s.active ? '#34d399' : '#f87171', boxShadow: `0 0 6px ${s.active ? '#34d399' : '#f87171'}` }} />
                <div style={{ fontSize: 12, fontWeight: 500 }}>{s.label}</div>
                <div style={{ marginLeft: 'auto', fontSize: 9, color: s.active ? '#34d399' : '#f87171', letterSpacing: 1 }}>{s.active ? 'LIVE' : 'OFFLINE'}</div>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>{s.detail}</div>
              <div style={{ fontSize: 9, color: '#4a6070' }}>{s.role}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Weight matrix + top 10 side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>

        {/* Weight matrix */}
        <div style={{ background: '#0d1519', border: '1px solid #1a2530', borderRadius: 8, padding: '18px 20px' }}>
          <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 14 }}>Scoring Weight Matrix</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: '#4a6070', fontSize: 9, letterSpacing: 1 }}>
                {['STAGE','STREAM','BRAND','SENT','RADIO','PRESS','∑'].map(h => (
                  <th key={h} style={{ textAlign: h === 'STAGE' ? 'left' : 'right', paddingBottom: 8, fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.weights.map(w => {
                const sum = w.weight_streaming + w.weight_brand + w.weight_sentiment + w.weight_radio + w.weight_press
                return (
                  <tr key={w.stage} style={{ borderTop: '1px solid #111c24' }}>
                    <td style={{ padding: '7px 0', color: STAGE_COL[w.stage] || '#94a3b8', fontWeight: 500 }}>{w.stage}</td>
                    {[w.weight_streaming, w.weight_brand, w.weight_sentiment, w.weight_radio, w.weight_press].map((v, i) => (
                      <td key={i} style={{ textAlign: 'right', color: '#cbd5e1' }}>{v}</td>
                    ))}
                    <td style={{ textAlign: 'right', color: '#4a6070' }}>{sum}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 12, fontSize: 9, color: '#4a6070', borderTop: '1px solid #111c24', paddingTop: 10 }}>
            Weights normalised at runtime — scorer reads live from DB each cycle
          </div>
        </div>

        {/* Top 10 */}
        <div style={{ background: '#0d1519', border: '1px solid #1a2530', borderRadius: 8, padding: '18px 20px' }}>
          <div style={{ fontSize: 10, color: '#4a6070', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 14 }}>Current Top 10</div>
          {data.top10.map((a, i) => (
            <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderTop: i > 0 ? '1px solid #111c24' : undefined }}>
              <div style={{ width: 18, fontSize: 9, color: '#4a6070', textAlign: 'right', flexShrink: 0 }}>{i+1}</div>
              <div style={{ flex: 1, fontSize: 11, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ fontSize: 9, color: STAGE_COL[a.career_stage] || '#6b7280', flexShrink: 0 }}>{a.career_stage}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: LABEL_COL[a.heat_label] || '#94a3b8', flexShrink: 0, width: 36, textAlign: 'right' }}>{a.heat_score?.toFixed(1)}</div>
              <div style={{ fontSize: 9, color: LABEL_COL[a.heat_label] || '#6b7280', flexShrink: 0, width: 70, textAlign: 'right' }}>{a.heat_label}</div>
            </div>
          ))}
          <div style={{ marginTop: 10, fontSize: 9, color: '#4a6070', borderTop: '1px solid #111c24', paddingTop: 10 }}>
            Scored {timeAgo(data.lastRun.scored)} · updates every 15 min
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1px solid #1a2530', paddingTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 9, color: '#4a6070', letterSpacing: 2 }}>TUNEDEX OPS · REFRESHES EVERY 30S</div>
        <a href="/" style={{ fontSize: 9, color: '#4a6070', letterSpacing: 2, textDecoration: 'none' }}>← HEAT INDEX</a>
      </div>
    </div>
  )
}
