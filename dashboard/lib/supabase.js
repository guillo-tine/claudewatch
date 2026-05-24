import { createClient } from '@supabase/supabase-js';

// Strip any leading BOM (U+FEFF) that Windows clipboard / some editors can silently prepend.
// Without this, Headers.set throws "Cannot convert argument to ByteString" at runtime.
const SUPABASE_URL      = (process.env.NEXT_PUBLIC_SUPABASE_URL      || '').replace(/^﻿/, '');
const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').replace(/^﻿/, '');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[ClaudeWatch] Supabase env vars missing — dashboard will not load data.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- Range helpers ----

export function sinceTs(range) {
  const now = Date.now();
  if (range === '24h')  return new Date(now - 86400000).toISOString();
  if (range === '7d')   return new Date(now - 7 * 86400000).toISOString();
  if (range === '30d')  return new Date(now - 30 * 86400000).toISOString();
  if (range === '90d')  return new Date(now - 90 * 86400000).toISOString();
  return '1970-01-01T00:00:00.000Z'; // all
}

export function rangeToDays(range) {
  if (range === '24h')  return 1;
  if (range === '7d')   return 7;
  if (range === '30d')  return 30;
  if (range === '90d')  return 90;
  return 365;
}

// ---- Community / aggregate stats ----

export async function fetchCommunityStats(since) {
  const { data, error } = await supabase.rpc('community_stats', { since });
  if (error) throw error;
  return data;
}

// ---- Raw exchange queries (recent data < 7 days) ----

export async function fetchTokensOverTime(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('public_exchanges')
    .select('created_at, tokens_out, tier')
    .gte('created_at', since)
    .eq('suspicious', false)
    .eq('partial', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchRateLimitsByDay(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('public_exchanges')
    .select('created_at, tier')
    .gte('created_at', since)
    .eq('hit_limit', true)
    .eq('suspicious', false);
  if (error) throw error;
  return data || [];
}

export async function fetchUsageDistribution(range) {
  const since = sinceTs(range || '30d');
  const { data, error } = await supabase
    .from('usage_snapshots')
    .select('usage_percent, tier')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10000);
  if (error) throw error;
  return data || [];
}

export async function fetchModelDistribution(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('public_exchanges')
    .select('model')
    .gte('created_at', since)
    .eq('suspicious', false);
  if (error) throw error;
  return data || [];
}

export async function fetchActiveReportersByDay(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('public_exchanges')
    .select('created_at, anonymous_id')
    .gte('created_at', since)
    .eq('suspicious', false);
  if (error) throw error;
  return data || [];
}

export async function fetchResponseTimeOverTime(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('public_exchanges')
    .select('created_at, response_duration_ms, tokens_per_second, tier')
    .gte('created_at', since)
    .eq('suspicious', false)
    .eq('partial', false)
    .not('response_duration_ms', 'is', null);
  if (error) throw error;
  return data || [];
}

// ---- The key chart: where do rate limits actually trigger? ----
// Returns day-by-day p25/p50/p75 usage % at which rate limits fired.
// A downward trend means Anthropic silently lowered limits.

export async function fetchLimitThresholds(range) {
  const days = rangeToDays(range);
  const { data, error } = await supabase.rpc('fetch_limit_thresholds', { days_back: days });
  if (error) throw error;
  return data || [];
}

// ---- Speed benchmark (combines daily_aggregates + recent raw) ----

export async function fetchSpeedOverTime(range) {
  const days = rangeToDays(range);
  const { data, error } = await supabase.rpc('fetch_speed_over_time', { days_back: days });
  if (error) throw error;
  return data || [];
}

// ---- Daily aggregates (historical 30d+ charts) ----

export async function fetchDailyAggregates(range) {
  const days = rangeToDays(range);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('daily_aggregates')
    .select('*')
    .gte('date', since)
    .order('date', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ---- Community posts ----

export async function fetchCommunityPosts(sort = 'newest') {
  let q = supabase
    .from('community_posts')
    .select('*')
    .eq('flagged', false)
    .limit(50);
  if (sort === 'newest') q = q.order('created_at', { ascending: false });
  else                   q = q.order('upvotes',     { ascending: false });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ---- Personal stats (me page) ----

export async function fetchPersonalStats(anonymousId, range) {
  const since = sinceTs(range);
  // Uses public_exchanges view — device_fingerprint is never returned
  const { data, error } = await supabase
    .from('public_exchanges')
    .select('*')
    .eq('anonymous_id', anonymousId)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchPersonalUsage(anonymousId, range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('usage_snapshots')
    .select('usage_percent, tier, timestamp, resets_in_minutes')
    .eq('anonymous_id', anonymousId)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}
