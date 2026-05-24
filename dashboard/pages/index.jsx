import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import StatCard from '../components/StatCard';
import RangeToggle from '../components/RangeToggle';
import {
  fetchCommunityStats,
  fetchTokensOverTime,
  fetchRateLimitsByDay,
  fetchUsageDistribution,
  fetchModelDistribution,
  fetchActiveReportersByDay,
  fetchResponseTimeOverTime,
} from '../lib/supabase';
import {
  bucketByDay, countByDay, uniqueByDay, modelDistribution, usageHistogram,
} from '../lib/chartUtils';

const POLL_INTERVAL = 60_000;
const COLORS = ['#7ab', '#c77', '#7c7', '#ca7', '#a7c', '#cc7'];

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

export default function Dashboard() {
  const [range, setRange] = useState('7d');
  const [stats, setStats] = useState(null);
  const [tokensData, setTokensData] = useState([]);
  const [limitsData, setLimitsData] = useState([]);
  const [usageData, setUsageData] = useState([]);
  const [modelData, setModelData] = useState([]);
  const [reportersData, setReportersData] = useState([]);
  const [responseData, setResponseData] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const since24h = new Date(Date.now() - 86400000).toISOString();
      const [
        statsResult,
        tokensRaw,
        limitsRaw,
        usageRaw,
        modelsRaw,
        reportersRaw,
        responseRaw,
      ] = await Promise.all([
        fetchCommunityStats(since24h),
        fetchTokensOverTime(range),
        fetchRateLimitsByDay(range),
        fetchUsageDistribution(),
        fetchModelDistribution(range),
        fetchActiveReportersByDay(range),
        fetchResponseTimeOverTime(range),
      ]);

      setStats(statsResult);
      setTokensData(bucketByDay(tokensRaw, 'tokens_out'));
      setLimitsData(countByDay(limitsRaw));
      setUsageData(usageHistogram(usageRaw));
      setModelData(modelDistribution(modelsRaw));
      setReportersData(uniqueByDay(reportersRaw, 'anonymous_id'));
      setResponseData(bucketByDay(responseRaw, 'response_duration_ms'));
      setUpdatedAt(new Date());
    } catch (_) {}
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [load]);

  const tip = { contentStyle: { background: '#1e1e1e', border: '1px solid #333', borderRadius: 6, fontSize: 12 }, labelStyle: { color: '#aaa' } };

  return (
    <div className="page">
      <header className="header">
        <h1 className="logo">ClaudeWatch</h1>
        <nav className="nav">
          <a href="/" className="nav-link active">Dashboard</a>
          <a href="/community" className="nav-link">Community</a>
        </nav>
        <span className="updated">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : ''}</span>
      </header>

      {/* Summary cards */}
      <div className="cards">
        <StatCard label="Total exchanges" value={fmt(stats?.total_exchanges)} />
        <StatCard label="Unique reporters" value={fmt(stats?.total_users)} />
        <StatCard label="Rate limits (24h)" value={fmt(stats?.rate_limit_events)} />
        <StatCard label="Median usage — Pro" value={stats?.median_usage_pro != null ? `${stats.median_usage_pro}%` : '—'} />
        <StatCard label="Median usage — Free" value={stats?.median_usage_free != null ? `${stats.median_usage_free}%` : '—'} />
        <StatCard label="Most used model" value={stats?.most_used_model ?? '—'} />
        <StatCard label="Adaptive mode" value={stats?.adaptive_pct != null ? `${stats.adaptive_pct}%` : '—'} sub="of recent exchanges" />
        <StatCard label="Avg response time" value={stats?.avg_response_ms != null ? `${fmt(stats.avg_response_ms)}ms` : '—'} />
      </div>

      <div className="range-row">
        <span className="section-label">Chart range</span>
        <RangeToggle value={range} onChange={setRange} />
      </div>

      {loading ? (
        <div className="loading">Loading charts…</div>
      ) : (
        <div className="charts">

          {/* Tokens per response over time */}
          <div className="chart-card">
            <h2 className="chart-title">Avg tokens / response over time</h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={tokensData}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#666' }} />
                <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                <Tooltip {...tip} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="pro" stroke="#7ab" dot={false} name="Pro" />
                <Line type="monotone" dataKey="free" stroke="#c77" dot={false} name="Free" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Rate limit events per day */}
          <div className="chart-card">
            <h2 className="chart-title">Rate limit events per day</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={limitsData}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#666' }} />
                <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                <Tooltip {...tip} />
                <Bar dataKey="count" fill="#c77" name="Limit events" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Usage % distribution histogram */}
          <div className="chart-card">
            <h2 className="chart-title">Usage % at time of report</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={usageData}>
                <XAxis dataKey="range" tick={{ fontSize: 10, fill: '#666' }} />
                <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                <Tooltip {...tip} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="pro" fill="#7ab" name="Pro" />
                <Bar dataKey="free" fill="#c77" name="Free" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Active reporters per day */}
          <div className="chart-card">
            <h2 className="chart-title">Active reporters per day</h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={reportersData}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#666' }} />
                <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                <Tooltip {...tip} />
                <Line type="monotone" dataKey="count" stroke="#7c7" dot={false} name="Unique reporters" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Model distribution */}
          <div className="chart-card chart-small">
            <h2 className="chart-title">Model distribution</h2>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={modelData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {modelData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip {...tip} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Avg response time over time */}
          <div className="chart-card">
            <h2 className="chart-title">Avg response time (ms)</h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={responseData}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#666' }} />
                <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                <Tooltip {...tip} />
                <Line type="monotone" dataKey="all" stroke="#ca7" dot={false} name="All tiers" />
              </LineChart>
            </ResponsiveContainer>
          </div>

        </div>
      )}

      <style jsx global>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #111; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; }
        a { color: inherit; text-decoration: none; }
      `}</style>

      <style jsx>{`
        .page { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { display: flex; align-items: center; gap: 24px; margin-bottom: 24px; }
        .logo { font-family: 'Fira Mono', monospace; font-size: 18px; color: #7ab; }
        .nav { display: flex; gap: 16px; }
        .nav-link { color: #888; font-size: 13px; transition: color 0.15s; }
        .nav-link.active, .nav-link:hover { color: #e0e0e0; }
        .updated { margin-left: auto; font-size: 11px; color: #555; font-family: 'Fira Mono', monospace; }
        .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 24px; }
        .range-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
        .section-label { font-size: 11px; color: #666; font-family: 'Fira Mono', monospace; }
        .loading { color: #555; padding: 40px 0; text-align: center; font-size: 13px; }
        .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .chart-card { background: #1a1a1a; border: 1px solid #2d2d2d; border-radius: 8px; padding: 16px; }
        .chart-small { grid-column: span 1; }
        .chart-title { font-size: 12px; color: #888; margin-bottom: 12px; font-family: 'Fira Mono', monospace; }
        @media (max-width: 768px) { .charts { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
