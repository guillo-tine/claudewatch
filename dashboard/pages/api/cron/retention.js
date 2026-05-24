/**
 * /api/cron/retention
 *
 * Called daily by Vercel Cron (see vercel.json).
 * Aggregates raw exchanges older than 7 days into daily_aggregates,
 * then deletes the source rows — keeping the database lean indefinitely.
 *
 * Protected by a CRON_SECRET env var so it can't be triggered by
 * arbitrary HTTP requests (Vercel sets the Authorization header automatically
 * for cron invocations; the header can also be set manually for testing).
 */

import { createClient } from '@supabase/supabase-js';

// Use the service role key on the server only — NEVER exposed to clients.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // server-only env var (no NEXT_PUBLIC_ prefix)
);

export default async function handler(req, res) {
  // Verify this came from Vercel Cron or an authorised caller
  const auth = req.headers.authorization || '';
  const secret = process.env.CRON_SECRET || '';
  if (secret && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { data, error } = await supabase.rpc('run_data_retention');
    if (error) throw error;
    console.log('[cron/retention] result:', data);
    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error('[cron/retention] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
