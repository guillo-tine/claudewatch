/**
 * Data-transformation utilities for dashboard charts.
 * All functions take raw Supabase rows and return Recharts-compatible data arrays.
 */

// ---- Generic bucketing helpers ----

export function bucketByDay(rows, valueKey, dateKey = 'created_at') {
  const map = {};
  rows.forEach(row => {
    const day = row[dateKey].slice(0, 10);
    if (!map[day]) map[day] = { date: day, free: [], pro: [], max: [], all: [] };
    const val = parseFloat(row[valueKey]);
    if (!isNaN(val)) {
      map[day].all.push(val);
      if (row.tier === 'pro')  map[day].pro.push(val);
      if (row.tier === 'free') map[day].free.push(val);
      if (row.tier === 'max')  map[day].max.push(val);
    }
  });
  return Object.values(map)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      date: d.date,
      all:  avg(d.all)  ?? null,
      pro:  avg(d.pro)  ?? null,
      free: avg(d.free) ?? null,
      max:  avg(d.max)  ?? null,
    }));
}

export function countByDay(rows, dateKey = 'created_at') {
  const map = {};
  rows.forEach(row => {
    const day = row[dateKey].slice(0, 10);
    if (!map[day]) map[day] = { pro: 0, free: 0, max: 0, all: 0 };
    map[day].all++;
    const t = row.tier;
    if (t === 'pro' || t === 'free' || t === 'max') map[day][t]++;
  });
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));
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
    const m = (model || 'unknown').replace(/^claude-/i, 'Claude ').replace(/-\d{4}\d*/g, '');
    map[m] = (map[m] || 0) + 1;
  });
  return Object.entries(map)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([name, value]) => ({ name, value }));
}

export function usageHistogram(rows, bins = 10) {
  const byTier = { free: [], pro: [], max: [] };
  rows.forEach(({ usage_percent, tier }) => {
    if (byTier[tier]) byTier[tier].push(usage_percent);
  });

  return Array.from({ length: bins }, (_, i) => {
    const lo = i * (100 / bins);
    const hi = lo + (100 / bins);
    return {
      range: `${Math.round(lo)}–${Math.round(hi)}%`,
      free:  byTier.free.filter(v => v >= lo && v < hi).length  || null,
      pro:   byTier.pro.filter(v => v >= lo && v < hi).length   || null,
      max:   byTier.max.filter(v => v >= lo && v < hi).length   || null,
    };
  });
}

// ---- Limit-threshold chart ----
// Input: rows from fetch_limit_thresholds RPC — { date, tier, p25, p50, p75, n }
// Output: one entry per date, with per-tier p50 values for multi-line chart

export function limitThresholdByDay(rows) {
  const map = {};
  rows.forEach(({ date, tier, p50, p25, p75, n }) => {
    if (!map[date]) map[date] = { date };
    map[date][`${tier}_p50`]  = p50 != null ? Math.round(p50)  : null;
    map[date][`${tier}_p25`]  = p25 != null ? Math.round(p25)  : null;
    map[date][`${tier}_p75`]  = p75 != null ? Math.round(p75)  : null;
    map[date][`${tier}_n`]    = n;
  });
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Speed benchmark chart ----
// Input: rows from fetch_speed_over_time RPC — { date, tier, avg_tps, exchange_count }

export function speedByDay(rows) {
  const map = {};
  rows.forEach(({ date, tier, avg_tps }) => {
    const d = typeof date === 'string' ? date : date?.slice(0, 10) ?? '';
    if (!map[d]) map[d] = { date: d };
    if (avg_tps != null) map[d][tier] = parseFloat(avg_tps);
  });
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Utility ----

function avg(arr) {
  if (!arr || !arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

export function shortDate(dateStr) {
  // '2026-05-24' → 'May 24'
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
