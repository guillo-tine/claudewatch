-- ============================================================
-- Migration: critical bug fixes
-- ============================================================

-- ============================================================
-- Fix 1 (CRITICAL): Restore flag_post deduplication
--
-- Migration 20260524000002 accidentally overwrote the correct
-- flag_post function (with post_flags dedup from 20260522000001)
-- with a naive increment version that had no deduplication.
-- A single anonymous_id could flag the same post unlimited times.
-- This restores the correct post_flags-backed implementation.
-- ============================================================

CREATE OR REPLACE FUNCTION flag_post(post_id uuid, flagging_anon_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Deduplicate: if this anonymous_id has already flagged this post, do nothing.
  -- If flagging_anon_id is NULL (legacy callers), skip the dedup insert so the
  -- post_flags table stays clean and we fall through to the recount.
  IF flagging_anon_id IS NOT NULL THEN
    INSERT INTO post_flags (post_id, anonymous_id)
    VALUES (flag_post.post_id, flagging_anon_id)
    ON CONFLICT (post_id, anonymous_id) DO NOTHING;

    -- If nothing was inserted the user already flagged — bail out to avoid inflating count.
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  -- Recount actual unique flags and auto-hide if threshold reached (3 flags).
  UPDATE community_posts cp
  SET flag_count = (SELECT count(*) FROM post_flags pf WHERE pf.post_id = cp.id),
      flagged    = (SELECT count(*) FROM post_flags pf WHERE pf.post_id = cp.id) >= 3
  WHERE cp.id = flag_post.post_id;
END;
$$;

-- ============================================================
-- Fix 2: fetch_speed_over_time — prevent day-7 boundary overlap
--
-- The previous UNION ALL joined daily_aggregates (compacted rows)
-- with raw exchanges. Both queries used the same date range, so
-- the "boundary day" (the day compaction ran) could appear in
-- BOTH tables, doubling the TPS reading for that day.
-- Fix: explicitly bound daily_aggregates to dates BEFORE the 7-day
-- raw window, and raw exchanges to the last 7 days only.
-- ============================================================

CREATE OR REPLACE FUNCTION fetch_speed_over_time(days_back integer DEFAULT 60)
RETURNS TABLE (date date, tier text, avg_tps numeric, exchange_count integer)
LANGUAGE sql SECURITY DEFINER AS $$
  -- Historical: from daily_aggregates — only days fully outside the raw window
  SELECT date, tier, avg_tps, exchange_count
  FROM daily_aggregates
  WHERE date >= CURRENT_DATE - days_back
    AND date <  CURRENT_DATE - 7   -- hard stop: no overlap with the raw exchange window
    AND avg_tps IS NOT NULL
  UNION ALL
  -- Recent: from raw exchanges — last 7 days only (matches retention cutoff)
  SELECT
    DATE(created_at)                                    AS date,
    COALESCE(tier, 'unknown')                           AS tier,
    ROUND(AVG(tokens_per_second)::numeric, 2)           AS avg_tps,
    COUNT(*)::integer                                   AS exchange_count
  FROM exchanges
  WHERE created_at >= NOW() - INTERVAL '7 days'
    AND tokens_per_second IS NOT NULL
    AND suspicious = false
    AND partial    = false
  GROUP BY DATE(created_at), COALESCE(tier, 'unknown')
  ORDER BY date ASC;
$$;

-- ============================================================
-- Fix 3: Explicit GRANTs for new objects
--
-- Postgres views need explicit GRANT SELECT even when the
-- underlying table has a permissive RLS policy.
-- daily_aggregates was created without a GRANT statement.
-- ============================================================

GRANT SELECT ON public_exchanges  TO anon, authenticated;
GRANT SELECT ON daily_aggregates  TO anon, authenticated;
GRANT SELECT ON post_flags        TO anon, authenticated;

-- ============================================================
-- Fix 4: community_stats — mark STABLE so PostgREST allows GET
--
-- PostgREST only permits HTTP GET on RPC endpoints if the
-- function is marked STABLE or IMMUTABLE. Without this, GET
-- requests (e.g. from the popup's supabaseFetch) return 405.
-- The function is read-only, so STABLE is semantically correct.
-- Also adds median_usage_max (new tier) that was missing from
-- the original schema version.
-- ============================================================

CREATE OR REPLACE FUNCTION community_stats(since timestamptz)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT json_build_object(
    'active_users',       (SELECT count(DISTINCT anonymous_id) FROM exchanges WHERE created_at >= since AND suspicious = false),
    'avg_tokens_out',     (SELECT round(avg(tokens_out))       FROM exchanges WHERE created_at >= since AND suspicious = false AND partial = false),
    'rate_limit_events',  (SELECT count(*)                     FROM exchanges WHERE created_at >= since AND hit_limit = true   AND suspicious = false),
    'median_usage_pro',   (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY usage_percent) FROM usage_snapshots WHERE created_at >= since AND tier = 'pro'),
    'median_usage_free',  (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY usage_percent) FROM usage_snapshots WHERE created_at >= since AND tier = 'free'),
    'median_usage_max',   (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY usage_percent) FROM usage_snapshots WHERE created_at >= since AND tier = 'max'),
    'total_exchanges',    (SELECT count(*)                     FROM exchanges WHERE suspicious = false),
    'total_users',        (SELECT count(DISTINCT anonymous_id) FROM exchanges WHERE suspicious = false),
    'most_used_model',    (SELECT model FROM exchanges WHERE created_at >= since AND suspicious = false GROUP BY model ORDER BY count(*) DESC LIMIT 1),
    'adaptive_pct',       (SELECT round(100.0 * count(*) FILTER (WHERE adaptive_mode = true) / NULLIF(count(*), 0)) FROM exchanges WHERE created_at >= since AND suspicious = false),
    'avg_response_ms',    (SELECT round(avg(response_duration_ms)) FROM exchanges WHERE created_at >= since AND suspicious = false AND partial = false),
    'avg_tokens_per_sec', (SELECT round(avg(tokens_per_second)::numeric, 1) FROM exchanges WHERE created_at >= since AND suspicious = false AND partial = false),
    'install_count',      (SELECT count(*) FROM install_events)
  );
$$;
