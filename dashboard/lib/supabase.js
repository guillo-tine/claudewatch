import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SINCE_24H = () => new Date(Date.now() - 86400000).toISOString();
const SINCE_7D  = () => new Date(Date.now() - 7 * 86400000).toISOString();
const SINCE_30D = () => new Date(Date.now() - 30 * 86400000).toISOString();

export function sinceTs(range) {
  if (range === '7d')  return SINCE_7D();
  if (range === '30d') return SINCE_30D();
  return '1970-01-01T00:00:00.000Z'; // all
}

export async function fetchCommunityStats(since) {
  const { data, error } = await supabase.rpc('community_stats', { since });
  if (error) throw error;
  return data;
}

export async function fetchTokensOverTime(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('exchanges')
    .select('created_at, tokens_out, tier')
    .gte('created_at', since)
    .eq('suspicious', false)
    .eq('partial', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function fetchRateLimitsByDay(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('exchanges')
    .select('created_at')
    .gte('created_at', since)
    .eq('hit_limit', true)
    .eq('suspicious', false);
  if (error) throw error;
  return data;
}

export async function fetchUsageDistribution() {
  const { data, error } = await supabase
    .from('usage_snapshots')
    .select('usage_percent, tier')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  return data;
}

export async function fetchModelDistribution(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('exchanges')
    .select('model')
    .gte('created_at', since)
    .eq('suspicious', false);
  if (error) throw error;
  return data;
}

export async function fetchActiveReportersByDay(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('exchanges')
    .select('created_at, anonymous_id')
    .gte('created_at', since)
    .eq('suspicious', false);
  if (error) throw error;
  return data;
}

export async function fetchResponseTimeOverTime(range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('exchanges')
    .select('created_at, response_duration_ms, tokens_per_second')
    .gte('created_at', since)
    .eq('suspicious', false)
    .eq('partial', false)
    .not('response_duration_ms', 'is', null);
  if (error) throw error;
  return data;
}

export async function fetchCommunityPosts(sort = 'newest') {
  let query = supabase
    .from('community_posts')
    .select('*')
    .eq('flagged', false)
    .limit(50);

  if (sort === 'newest') query = query.order('created_at', { ascending: false });
  else query = query.order('upvotes', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function fetchPersonalStats(anonymousId, range) {
  const since = sinceTs(range);
  const { data, error } = await supabase
    .from('exchanges')
    .select('*')
    .eq('anonymous_id', anonymousId)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}
