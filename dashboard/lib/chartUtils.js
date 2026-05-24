/**
 * Data-transformation utilities for dashboard charts.
 * All functions take raw Supabase rows and return Recharts-compatible data arrays.
 */

export function bucketByDay(rows, valueKey, dateKey = 'created_at') {
  const map = {};
  rows.forEach(row => {
    const day = row[dateKey].slice(0, 10);
    if (!map[day]) map[day] = { date: day, free: [], pro: [], all: [] };
    const val = parseFloat(row[valueKey]);
    if (!isNaN(val)) {
      map[day].all.push(val);
      if (row.tier === 'pro') map[day].pro.push(val);
      if (row.tier === 'free') map[day].free.push(val);
    }
  });
  return Object.values(map)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      date: d.date,
      all: avg(d.all),
      pro: avg(d.pro),
      free: avg(d.free),
    }));
}

export function countByDay(rows, dateKey = 'created_at') {
  const map = {};
  rows.forEach(row => {
    const day = row[dateKey].slice(0, 10);
    map[day] = (map[day] || 0) + 1;
  });
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
}

export function uniqueByDay(rows, idKey, dateKey = 'created_at') {
  const map = {};
  rows.forEach(row => {
    const day = row[dateKey].slice(0, 10);
    if (!map[day]) map[day] = new Set();
    map[day].add(row[idKey]);
  });
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, set]) => ({ date, count: set.size }));
}

export function modelDistribution(rows) {
  const map = {};
  rows.forEach(({ model }) => {
    const m = model || 'unknown';
    map[m] = (map[m] || 0) + 1;
  });
  return Object.entries(map)
    .sort(([, a], [, b]) => b - a)
    .map(([name, value]) => ({ name, value }));
}

export function usageHistogram(rows, bins = 10) {
  const byTier = { free: [], pro: [] };
  rows.forEach(({ usage_percent, tier }) => {
    if (tier === 'free' || tier === 'pro') byTier[tier].push(usage_percent);
  });

  return Array.from({ length: bins }, (_, i) => {
    const lo = i * (100 / bins);
    const hi = lo + (100 / bins);
    return {
      range: `${Math.round(lo)}-${Math.round(hi)}%`,
      free: byTier.free.filter(v => v >= lo && v < hi).length,
      pro:  byTier.pro.filter(v => v >= lo && v < hi).length,
    };
  });
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
