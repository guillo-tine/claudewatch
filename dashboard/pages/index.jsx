import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  PieChart, Pie, Cell, ReferenceLine,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import StatCard from '../components/StatCard';
import RangeToggle from '../components/RangeToggle';
import {
  fetchCommunityStats, fetchTokensOverTime, fetchRateLimitsByDay,
  fetchUsageDistribution, fetchModelDistribution, fetchActiveReportersByDay,
  fetchResponseTimeOverTime, fetchLimitThresholds, fetchSpeedOverTime,
} from '../lib/supabase';
import {
  bucketByDay, countByDay, uniqueByDay, modelDistribution,
  usageHistogram, limitThresholdByDay, speedByDay, shortDate,
} from '../lib/chartUtils';

const POLL_INTERVAL = 60_000;

const TIER_COLOR  = { pro: '#7ab3cc', free: '#c77', max: '#a78bfa', all: '#ca7', unknown: '#888' };
const CHART_COLORS = ['#7ab3cc', '#c77', '#a78bfa', '#7c9', '#ca7', '#cc7'];

const TIP = {
  contentStyle: { background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, fontSize: 12 },
  labelStyle:   { color: '#aaa', marginBottom: 4 },
  cursor:       { stroke: '#444' },
};

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

// Custom tooltip for the limit-threshold chart
function LimitTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#aaa', marginBottom: 6 }}>{shortDate(label)}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>{p.value != null ? `${p.value}%` : '—'}</strong>
        </div>
      ))}
      <div style={{ color: '#555', marginTop: 4, fontSize: 11 }}>
        Usage % when rate limit fired
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange]           = useState('30d');
  const [stats, setStats]           = useState(null);
  const [tokensData, setTokensData] = useState([]);
  const [limitsData, setLimitsData] = useState([]);
  const [usageData,  setUsageData]  = useState([]);
  const [modelData,  setModelData]  = useState([]);
  const [reporters,  setReporters]  = useState([]);
  const [responseData, setResponseData] = useState([]);
  const [threshData, setThreshData] = useState([]);
  const [speedData,  setSpeedData]  = useState([]);
  const [updatedAt,  setUpdatedAt]  = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const since24h = new Date(Date.now() - 86400000).toISOString();
      const [
        st, tok, lim, uso, mod, rep, res, thr, spd,
      ] = await Promise.all([
        fetchCommunityStats(since24h),
        fetchTokensOverTime(range),
        fetchRateLimitsByDay(range),
        fetchUsageDistribution(range),
        fetchModelDistribution(range),
        fetchActiveReportersByDay(range),
        fetchResponseTimeOverTime(range),
        fetchLimitThresholds(range),
        fetchSpeedOverTime(range),
      ]);

      setStats(st);
      setTokensData(bucketByDay(tok, 'tokens_out'));
      setLimitsData(countByDay(lim));
      setUsageData(usageHistogram(uso));
      setModelData(modelDistribution(mod));
      setReporters(uniqueByDay(rep, 'anonymous_id'));
      setResponseData(bucketByDay(res, 'response_duration_ms'));
      setThreshData(limitThresholdByDay(thr));
      setSpeedData(speedByDay(spd));
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [load]);

  const hasThreshData = threshData.length > 0;
  const hasSpeedData  = speedData.length  > 0;

  return (
    <div className="page">

      {/* ── Header ─────────────────────────────────────────── */}
      <header className="header">
        <div className="logo-area">
          <img src="/logo.png" alt="ClaudeWatch" className="logo-img" onError={e => e.target.style.display='none'} />
          <span className="logo-text">ClaudeWatch</span>
        </div>
        <nav className="nav">
          <a href="/"          className="nav-link active">Dashboard</a>
          <a href="/community" className="nav-link">Community</a>
          <a href="/me"        className="nav-link">My Stats</a>
        </nav>
        <span className="updated">
          {updatedAt ? `↻ ${updatedAt.toLocaleTimeString()}` : ''}
        </span>
      </header>

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="hero">
        <h1 className="hero-title">Claude's hidden usage limits — tracked in real time</h1>
        <p className="hero-sub">
          Anthropic doesn't publish when or how they adjust Claude's rate limits.
          ClaudeWatch crowdsources anonymous metadata from real users to surface these
          changes as they happen. No message content is ever collected.
        </p>
        <div className="hero-pills">
          <span className="pill">🔒 No message content</span>
          <span className="pill">👤 Anonymous only</span>
          <span className="pill">📡 {fmt(stats?.total_users)} reporters</span>
          <span className="pill">🔄 Updates every 60s</span>
        </div>
      </section>

      {error && (
        <div className="error-bar">⚠ Could not load data: {error}</div>
      )}

      {/* ── Stat cards ─────────────────────────────────────── */}
      <div className="cards">
        <StatCard label="Total exchanges"       value={fmt(stats?.total_exchanges)}   />
        <StatCard label="Unique reporters"      value={fmt(stats?.total_users)}        />
        <StatCard label="Rate limits (24h)"     value={fmt(stats?.rate_limit_events)}  highlight={stats?.rate_limit_events > 0} />
        <StatCard label="Avg tokens / response" value={fmt(stats?.avg_tokens_out)}     />
        <StatCard label="Avg speed"             value={stats?.avg_tokens_per_sec != null ? `${stats.avg_tokens_per_sec} t/s` : '—'} />
        <StatCard label="Avg response time"     value={stats?.avg_response_ms != null  ? `${fmt(stats.avg_response_ms)}ms` : '—'} />
        <StatCard label="Median usage — Pro"    value={stats?.median_usage_pro  != null ? `${stats.median_usage_pro}%`  : '—'} />
        <StatCard label="Median usage — Free"   value={stats?.median_usage_free != null ? `${stats.median_usage_free}%` : '—'} />
      </div>

      {/* ── Range toggle ───────────────────────────────────── */}
      <div className="range-row">
        <span className="section-label">Time range</span>
        <RangeToggle value={range} onChange={setRange} />
        {loading && <span className="loading-inline">loading…</span>}
      </div>

      {!loading && (
        <>
          {/* ════════════════════════════════════════════════════
              KEY CHART — Claude's invisible rate-limit thresholds
              ════════════════════════════════════════════════════ */}
          <div className="chart-card chart-full">
            <div className="chart-header">
              <h2 className="chart-title">
                📉  Claude's rate-limit threshold over time
              </h2>
              <span className="chart-badge">THE CORE SIGNAL</span>
            </div>
            <p className="chart-desc">
              Median usage % at which users first hit Claude's rate limit, by tier.{' '}
              <strong>A downward trend means Anthropic silently lowered limits.</strong>
              {' '}No events = no rate limits reported in this period.
            </p>
            {hasThreshData ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={threshData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#666' }} />
                  <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fill: '#666' }} />
                  <Tooltip content={<LimitTooltip />} />
                  <ReferenceLine y={100} stroke="#333" strokeDasharray="4 4" />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="pro_p50"  stroke={TIER_COLOR.pro}  dot={false} strokeWidth={2} name="Pro"  connectNulls />
                  <Line type="monotone" dataKey="free_p50" stroke={TIER_COLOR.free} dot={false} strokeWidth={2} name="Free" connectNulls />
                  <Line type="monotone" dataKey="max_p50"  stroke={TIER_COLOR.max}  dot={false} strokeWidth={2} name="Max"  connectNulls />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="chart-empty">
                No rate-limit events in this period — or not enough reporters yet.
                Install the extension to contribute data.
              </div>
            )}
          </div>

          <div className="charts">

            {/* ── Speed benchmark ──────────────────────────────── */}
            <div className="chart-card">
              <h2 className="chart-title">⚡ Claude response speed (tokens/sec)</h2>
              <p className="chart-desc-sm">Drops here reflect Anthropic throttling server capacity.</p>
              {hasSpeedData ? (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={speedData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#666' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                    <Tooltip {...TIP} formatter={v => [`${v} t/s`]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="pro"  stroke={TIER_COLOR.pro}  dot={false} name="Pro"  connectNulls />
                    <Line type="monotone" dataKey="free" stroke={TIER_COLOR.free} dot={false} name="Free" connectNulls />
                    <Line type="monotone" dataKey="max"  stroke={TIER_COLOR.max}  dot={false} name="Max"  connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="chart-empty">No speed data yet.</div>
              )}
            </div>

            {/* ── Rate limit events per day ─────────────────────── */}
            <div className="chart-card">
              <h2 className="chart-title">🚫 Rate limit events per day</h2>
              <p className="chart-desc-sm">Count of exchanges where Claude returned a usage-limit message.</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={limitsData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#666' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                  <Tooltip {...TIP} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="pro"  stackId="a" fill={TIER_COLOR.pro}  name="Pro"  />
                  <Bar dataKey="free" stackId="a" fill={TIER_COLOR.free} name="Free" />
                  <Bar dataKey="max"  stackId="a" fill={TIER_COLOR.max}  name="Max"  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* ── Avg tokens per response over time ────────────── */}
            <div className="chart-card">
              <h2 className="chart-title">📊 Avg tokens per response</h2>
              <p className="chart-desc-sm">Changes here reflect output quality or model instruction changes.</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={tokensData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#666' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                  <Tooltip {...TIP} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="pro"  stroke={TIER_COLOR.pro}  dot={false} name="Pro"  connectNulls />
                  <Line type="monotone" dataKey="free" stroke={TIER_COLOR.free} dot={false} name="Free" connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* ── Usage % distribution ─────────────────────────── */}
            <div className="chart-card">
              <h2 className="chart-title">📈 Usage % distribution at time of report</h2>
              <p className="chart-desc-sm">Where users sit on the usage bar when the extension checks.</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={usageData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="range" tick={{ fontSize: 10, fill: '#666' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                  <Tooltip {...TIP} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="pro"  fill={TIER_COLOR.pro}  name="Pro"  />
                  <Bar dataKey="free" fill={TIER_COLOR.free} name="Free" />
                  <Bar dataKey="max"  fill={TIER_COLOR.max}  name="Max"  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* ── Active reporters per day ──────────────────────── */}
            <div className="chart-card">
              <h2 className="chart-title">👥 Active reporters per day</h2>
              <p className="chart-desc-sm">Unique extension installs contributing data.</p>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={reporters} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#666' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                  <Tooltip {...TIP} />
                  <Area type="monotone" dataKey="count" stroke="#7c9" fill="#7c920" fillOpacity={0.15} name="Reporters" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* ── Model distribution ────────────────────────────── */}
            <div className="chart-card">
              <h2 className="chart-title">🤖 Model distribution</h2>
              <p className="chart-desc-sm">Which Claude models people are actually using.</p>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={modelData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={75}
                    label={({ name, percent }) =>
                      percent > 0.04 ? `${name} ${(percent * 100).toFixed(0)}%` : ''
                    }
                    labelLine={false}
                  >
                    {modelData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip {...TIP} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* ── Avg response time over time ───────────────────── */}
            <div className="chart-card">
              <h2 className="chart-title">⏱ Avg response time (ms)</h2>
              <p className="chart-desc-sm">End-to-end latency from send to stream complete.</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={responseData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#666' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#666' }} tickFormatter={v => `${(v/1000).toFixed(1)}s`} />
                  <Tooltip {...TIP} formatter={v => [`${fmt(v)}ms`]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="pro"  stroke={TIER_COLOR.pro}  dot={false} name="Pro"  connectNulls />
                  <Line type="monotone" dataKey="free" stroke={TIER_COLOR.free} dot={false} name="Free" connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>

          </div>
        </>
      )}

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="footer">
        <a href="https://github.com/guillo-tine/claudewatch" target="_blank" rel="noopener" className="footer-link">GitHub</a>
        <span className="footer-sep">·</span>
        <a href="/privacy" className="footer-link">Privacy</a>
        <span className="footer-sep">·</span>
        <a href="/community" className="footer-link">Community</a>
        <span className="footer-sep">·</span>
        <span className="footer-dim">No message content is ever collected</span>
      </footer>

      {/* ── Styles ─────────────────────────────────────────── */}
      <style jsx global>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0e0e0e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; }
        a { color: inherit; text-decoration: none; }
        strong { color: #fff; }
      `}</style>

      <style jsx>{`
        .page { max-width: 1200px; margin: 0 auto; padding: 20px 20px 40px; }

        /* Header */
        .header { display: flex; align-items: center; gap: 20px; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #222; }
        .logo-area { display: flex; align-items: center; gap: 10px; }
        .logo-img { height: 28px; width: auto; }
        .logo-text { font-family: 'Fira Mono', monospace; font-size: 17px; color: #7ab3cc; letter-spacing: -0.3px; }
        .nav { display: flex; gap: 20px; }
        .nav-link { color: #666; font-size: 13px; transition: color 0.15s; }
        .nav-link.active, .nav-link:hover { color: #e0e0e0; }
        .updated { margin-left: auto; font-size: 11px; color: #444; font-family: 'Fira Mono', monospace; }

        /* Hero */
        .hero { margin-bottom: 28px; }
        .hero-title { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 10px; line-height: 1.3; }
        .hero-sub { font-size: 14px; color: #888; max-width: 680px; margin-bottom: 14px; }
        .hero-pills { display: flex; flex-wrap: wrap; gap: 8px; }
        .pill { background: #1a1a1a; border: 1px solid #2d2d2d; border-radius: 20px; font-size: 12px; color: #aaa; padding: 3px 10px; }

        /* Error */
        .error-bar { background: #3a1c1c; border: 1px solid #c77; color: #e99; font-size: 12px; padding: 8px 14px; border-radius: 6px; margin-bottom: 16px; }

        /* Cards */
        .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; }

        /* Range row */
        .range-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
        .section-label { font-size: 11px; color: #555; font-family: 'Fira Mono', monospace; }
        .loading-inline { font-size: 11px; color: #555; font-family: 'Fira Mono', monospace; }

        /* Chart layout */
        .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

        /* Chart card */
        .chart-card { background: #141414; border: 1px solid #252525; border-radius: 10px; padding: 16px 18px; }
        .chart-full { background: #141414; border: 1px solid #252525; border-radius: 10px; padding: 18px 20px; margin-bottom: 14px; }
        .chart-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
        .chart-title { font-size: 13px; color: #ccc; font-weight: 600; }
        .chart-badge { background: #1e3a2a; border: 1px solid #2d6a4f; color: #6fcf97; font-size: 10px; font-family: 'Fira Mono', monospace; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
        .chart-desc { font-size: 12px; color: #666; margin-bottom: 14px; max-width: 680px; }
        .chart-desc-sm { font-size: 11px; color: #555; margin-bottom: 12px; }
        .chart-empty { color: #444; font-size: 12px; padding: 40px 0; text-align: center; font-style: italic; }

        /* Footer */
        .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #1a1a1a; display: flex; align-items: center; gap: 10px; font-size: 12px; color: #444; }
        .footer-link:hover { color: #888; }
        .footer-sep { color: #2a2a2a; }
        .footer-dim { color: #333; }

        /* Responsive */
        @media (max-width: 800px) {
          .charts { grid-template-columns: 1fr; }
          .hero-title { font-size: 18px; }
          .cards { gap: 8px; }
        }
      `}</style>
    </div>
  );
}
