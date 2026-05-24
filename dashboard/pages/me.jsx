import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import StatCard from '../components/StatCard';
import RangeToggle from '../components/RangeToggle';
import { fetchPersonalStats, fetchCommunityStats } from '../lib/supabase';
import { bucketByDay } from '../lib/chartUtils';

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export default function Me() {
  const [anonymousId, setAnonymousId] = useState('');
  const [range, setRange] = useState('30d');
  const [exchanges, setExchanges] = useState([]);
  const [communityStats, setCommunityStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [inputId, setInputId] = useState('');

  useEffect(() => {
    // Try to pull anonymousId from URL param or localStorage
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get('id');
    if (idFromUrl) {
      setAnonymousId(idFromUrl);
      setInputId(idFromUrl);
    }
  }, []);

  useEffect(() => {
    if (!anonymousId) return;
    load();
  }, [anonymousId, range]);

  async function load() {
    setLoading(true);
    try {
      const since24h = new Date(Date.now() - 86400000).toISOString();
      const [personal, community] = await Promise.all([
        fetchPersonalStats(anonymousId, range),
        fetchCommunityStats(since24h),
      ]);
      setExchanges(personal);
      setCommunityStats(community);
    } finally {
      setLoading(false);
    }
  }

  const totalIn = exchanges.reduce((s, e) => s + (e.tokens_in || 0), 0);
  const totalOut = exchanges.reduce((s, e) => s + (e.tokens_out || 0), 0);
  const rateLimits = exchanges.filter(e => e.hit_limit).length;
  const tokensOutArr = exchanges.map(e => e.tokens_out || 0);
  const tokensOverTime = bucketByDay(exchanges, 'tokens_out');

  const tip = { contentStyle: { background: '#1e1e1e', border: '1px solid #333', borderRadius: 6, fontSize: 12 } };

  return (
    <div className="page">
      <header className="header">
        <a href="/" className="logo">ClaudeWatch</a>
        <nav className="nav">
          <a href="/" className="nav-link">Dashboard</a>
          <a href="/community" className="nav-link">Community</a>
          <a href="/me" className="nav-link active">My Stats</a>
        </nav>
      </header>

      <h2 className="page-title">Personal Stats</h2>
      <p className="page-sub">Your anonymous ID is stored locally in the extension and never linked to your identity.</p>

      <div className="id-input-row">
        <input
          className="id-input"
          value={inputId}
          onChange={e => setInputId(e.target.value)}
          placeholder="Paste your anonymous ID from the extension…"
        />
        <button className="btn" onClick={() => setAnonymousId(inputId.trim())}>Load</button>
      </div>

      {!anonymousId && (
        <div className="empty">Enter your anonymous ID from the extension Settings tab to see your personal stats.</div>
      )}

      {anonymousId && (
        <>
          <div className="range-row">
            <RangeToggle value={range} onChange={setRange} />
          </div>

          {loading ? (
            <div className="loading">Loading…</div>
          ) : (
            <>
              <div className="cards">
                <StatCard label="Messages sent" value={fmt(exchanges.length)} />
                <StatCard label="Tokens in" value={fmt(totalIn)} />
                <StatCard label="Tokens out" value={fmt(totalOut)} />
                <StatCard label="Rate limits hit" value={fmt(rateLimits)} />
              </div>

              <div className="chart-card">
                <h2 className="chart-title">Tokens out per day</h2>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={tokensOverTime}>
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#666' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#666' }} />
                    <Tooltip {...tip} />
                    <Line type="monotone" dataKey="all" stroke="#7ab" dot={false} name="Tokens out" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {communityStats && exchanges.length > 0 && (
                <div className="rank-section">
                  <h3 className="rank-title">How you rank vs same-tier users</h3>
                  <div className="rank-cards">
                    <RankCard label="Messages sent" yours={exchanges.length} />
                    <RankCard label="Tokens out" yours={totalOut} />
                    <RankCard label="Rate limits hit" yours={rateLimits} />
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      <style jsx global>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #111; color: #e0e0e0; font-family: -apple-system, sans-serif; font-size: 14px; }
        a { color: inherit; text-decoration: none; }
      `}</style>

      <style jsx>{`
        .page { max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { display: flex; align-items: center; gap: 24px; margin-bottom: 28px; }
        .logo { font-family: 'Fira Mono', monospace; font-size: 18px; color: #7ab; }
        .nav { display: flex; gap: 16px; }
        .nav-link { color: #888; font-size: 13px; }
        .nav-link.active, .nav-link:hover { color: #e0e0e0; }
        .page-title { font-size: 20px; margin-bottom: 6px; }
        .page-sub { font-size: 13px; color: #666; margin-bottom: 20px; }
        .id-input-row { display: flex; gap: 8px; margin-bottom: 20px; }
        .id-input { flex: 1; background: #1a1a1a; border: 1px solid #2d2d2d; border-radius: 4px; color: #e0e0e0; font-family: 'Fira Mono', monospace; font-size: 12px; padding: 7px 10px; outline: none; }
        .id-input:focus { border-color: #7ab; }
        .btn { background: #7ab; border: none; border-radius: 4px; color: #111; cursor: pointer; font-size: 12px; font-weight: 700; padding: 7px 14px; }
        .range-row { margin-bottom: 16px; }
        .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
        .chart-card { background: #1a1a1a; border: 1px solid #2d2d2d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
        .chart-title { font-size: 12px; color: #888; margin-bottom: 12px; font-family: 'Fira Mono', monospace; }
        .rank-section { margin-top: 8px; }
        .rank-title { font-size: 14px; color: #aaa; margin-bottom: 12px; }
        .rank-cards { display: flex; gap: 12px; flex-wrap: wrap; }
        .loading, .empty { text-align: center; color: #555; padding: 32px 0; font-size: 13px; }
      `}</style>
    </div>
  );
}

function RankCard({ label, yours }) {
  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #2d2d2d', borderRadius: 8, padding: '12px 16px', minWidth: 140 }}>
      <div style={{ fontFamily: 'Fira Mono, monospace', fontSize: 11, color: '#666', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'Fira Mono, monospace', fontSize: 20, color: '#7ab' }}>{Number(yours).toLocaleString()}</div>
    </div>
  );
}
