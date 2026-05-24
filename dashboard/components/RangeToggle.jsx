export default function RangeToggle({ value, onChange }) {
  const options = ['7d', '30d', 'all'];
  return (
    <div className="range-toggle">
      {options.map(opt => (
        <button
          key={opt}
          className={`range-btn ${value === opt ? 'active' : ''}`}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
      <style jsx>{`
        .range-toggle { display: flex; gap: 4px; }
        .range-btn {
          background: #1e1e1e;
          border: 1px solid #2d2d2d;
          border-radius: 4px;
          color: #888;
          cursor: pointer;
          font-family: 'Fira Mono', monospace;
          font-size: 11px;
          padding: 3px 8px;
          transition: all 0.15s;
        }
        .range-btn.active { background: #2a3d45; border-color: #7ab; color: #7ab; }
        .range-btn:hover:not(.active) { color: #ccc; }
      `}</style>
    </div>
  );
}
