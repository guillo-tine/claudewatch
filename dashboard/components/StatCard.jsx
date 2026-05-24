export default function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}

      <style jsx>{`
        .stat-card {
          background: #1e1e1e;
          border: 1px solid #2d2d2d;
          border-radius: 8px;
          padding: 16px 20px;
          min-width: 140px;
        }
        .stat-value {
          font-family: 'Fira Mono', monospace;
          font-size: 24px;
          font-weight: 700;
          color: #7ab;
          line-height: 1.2;
        }
        .stat-label {
          font-size: 12px;
          color: #888;
          margin-top: 4px;
        }
        .stat-sub {
          font-size: 11px;
          color: #555;
          margin-top: 2px;
        }
      `}</style>
    </div>
  );
}
