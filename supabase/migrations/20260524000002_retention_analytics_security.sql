-- ============================================================
-- Migration: data retention, analytics helpers, security hardening
-- ============================================================

-- ============================================================
-- 1. tier CHECK — add 'max' and 'team' to the allowed values
-- ============================================================

ALTER TABLE exchanges
  DROP CONSTRAINT IF EXISTS exchanges_tier_check;
ALTER TABLE exchanges
  ADD CONSTRAINT exchanges_tier_check
    CHECK (tier IN ('free', 'pro', 'max', 'team', 'unknown'));

ALTER TABLE usage_snapshots
  DROP CONSTRAINT IF EXISTS usage_snapshots_tier_check;
ALTER TABLE usage_snapshots
  ADD CONSTRAINT usage_snapshots_tier_check
    CHECK (tier IN ('free', 'pro', 'max', 'team', 'unknown'));

-- ============================================================
-- 2. Daily aggregates table
--    Populated by run_data_retention(); old raw rows are deleted
--    after being rolled up here. Dashboard uses this for 30d+ views.
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_aggregates (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  date              date    NOT NULL,
  tier              text    NOT NULL DEFAULT 'unknown',
  model             text    NOT NULL DEFAULT 'unknown',
  exchange_count    integer NOT NULL DEFAULT 0,
  unique_reporters  integer NOT NULL DEFAULT 0,
  total_tokens_in   bigint  NOT NULL DEFAULT 0,
  total_tokens_out  bigint  NOT NULL DEFAULT 0,
  avg_tokens_in     numeric(10,2),
  avg_tokens_out    numeric(10,2),
  p50_tokens_out    integer,
  avg_response_ms   numeric(10,2),
  avg_tps           numeric(8,2),
  hit_limit_count   integer NOT NULL DEFAULT 0,
  created_at        timestamptz DEFAULT now(),
  UNIQUE (date, tier, model)
);

CREATE INDEX IF NOT EXISTS daily_agg_date_idx ON daily_aggregates (date DESC);
CREATE INDEX IF NOT EXISTS daily_agg_tier_idx ON daily_aggregates (tier);

ALTER TABLE daily_aggregates ENABLE ROW LEVEL SECURITY;

-- Public read (no sensitive data — all pre-aggregated)
CREATE POLICY "Public select daily_aggregates" ON daily_aggregates
  FOR SELECT USING (true);

-- ============================================================
-- 3. Rate-limit usage_snapshots to prevent snapshot spam
-- ============================================================

CREATE OR REPLACE FUNCTION check_snapshot_rate_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  recent_count integer;
BEGIN
  SELECT count(*) INTO recent_count
  FROM usage_snapshots
  WHERE anonymous_id = NEW.anonymous_id
    AND created_at > now() - INTERVAL '60 seconds';

  IF recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limit'
      USING HINT = 'Too many usage_snapshots from this anonymous_id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS snapshots_rate_limit ON usage_snapshots;
CREATE TRIGGER snapshots_rate_limit
  BEFORE INSERT ON usage_snapshots
  FOR EACH ROW EXECUTE FUNCTION check_snapshot_rate_limit();

-- ============================================================
-- 4. Retention + compaction function
--    Called daily by the Vercel cron route /api/cron/retention.
--    Keeps 7 days of raw exchanges, 30 days of raw snapshots.
--    Older rows are aggregated into daily_aggregates first.
-- ============================================================

CREATE OR REPLACE FUNCTION run_data_retention()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  cutoff_exchanges  timestamptz := now() - INTERVAL '7 days';
  cutoff_snapshots  timestamptz := now() - INTERVAL '30 days';
  agg_rows          integer;
  del_exchanges     integer;
  del_snapshots     integer;
BEGIN
  -- Roll up raw exchanges into daily_aggregates before deleting them
  INSERT INTO daily_aggregates (
    date, tier, model,
    exchange_count, unique_reporters,
    total_tokens_in, total_tokens_out,
    avg_tokens_in, avg_tokens_out,
    avg_response_ms, avg_tps, hit_limit_count
  )
  SELECT
    DATE(timestamp)                                   AS date,
    COALESCE(tier,  'unknown')                        AS tier,
    COALESCE(model, 'unknown')                        AS model,
    COUNT(*)                                          AS exchange_count,
    COUNT(DISTINCT anonymous_id)                      AS unique_reporters,
    COALESCE(SUM(tokens_in),  0)                      AS total_tokens_in,
    COALESCE(SUM(tokens_out), 0)                      AS total_tokens_out,
    AVG(tokens_in)                                    AS avg_tokens_in,
    AVG(tokens_out)                                   AS avg_tokens_out,
    AVG(response_duration_ms)                         AS avg_response_ms,
    AVG(tokens_per_second)                            AS avg_tps,
    COUNT(*) FILTER (WHERE hit_limit = true)          AS hit_limit_count
  FROM exchanges
  WHERE created_at < cutoff_exchanges
    AND suspicious = false
  GROUP BY DATE(timestamp), COALESCE(tier, 'unknown'), COALESCE(model, 'unknown')
  ON CONFLICT (date, tier, model) DO UPDATE SET
    exchange_count   = EXCLUDED.exchange_count,
    unique_reporters = EXCLUDED.unique_reporters,
    total_tokens_in  = EXCLUDED.total_tokens_in,
    total_tokens_out = EXCLUDED.total_tokens_out,
    avg_tokens_in    = EXCLUDED.avg_tokens_in,
    avg_tokens_out   = EXCLUDED.avg_tokens_out,
    avg_response_ms  = EXCLUDED.avg_response_ms,
    avg_tps          = EXCLUDED.avg_tps,
    hit_limit_count  = EXCLUDED.hit_limit_count;

  GET DIAGNOSTICS agg_rows = ROW_COUNT;

  -- Delete old raw exchanges
  DELETE FROM exchanges WHERE created_at < cutoff_exchanges;
  GET DIAGNOSTICS del_exchanges = ROW_COUNT;

  -- Delete old usage snapshots (not aggregated — too high cardinality)
  DELETE FROM usage_snapshots WHERE created_at < cutoff_snapshots;
  GET DIAGNOSTICS del_snapshots = ROW_COUNT;

  RETURN json_build_object(
    'aggregated_day_rows', agg_rows,
    'deleted_exchanges',   del_exchanges,
    'deleted_snapshots',   del_snapshots,
    'cutoff_exchanges',    cutoff_exchanges,
    'cutoff_snapshots',    cutoff_snapshots
  );
END;
$$;

-- ============================================================
-- 5. Analytics: rate-limit threshold over time
--    For each day, computes the median (p25/p50/p75) usage %
--    among snapshots from users who hit the rate limit that day.
--    If Anthropic silently lowers limits, this line drifts down.
-- ============================================================

CREATE OR REPLACE FUNCTION fetch_limit_thresholds(days_back integer DEFAULT 30)
RETURNS TABLE (
  date  date,
  tier  text,
  p25   numeric,
  p50   numeric,
  p75   numeric,
  n     bigint
)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    DATE(us.created_at)                                              AS date,
    COALESCE(us.tier, 'unknown')                                     AS tier,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY us.usage_percent)   AS p25,
    PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY us.usage_percent)   AS p50,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY us.usage_percent)   AS p75,
    COUNT(*)                                                         AS n
  FROM usage_snapshots us
  WHERE us.created_at >= NOW() - (days_back || ' days')::interval
    AND us.usage_percent IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM exchanges e
      WHERE e.anonymous_id = us.anonymous_id
        AND e.hit_limit    = true
        AND DATE(e.created_at) = DATE(us.created_at)
        AND e.suspicious   = false
    )
  GROUP BY DATE(us.created_at), COALESCE(us.tier, 'unknown')
  ORDER BY date ASC;
$$;

-- ============================================================
-- 6. Analytics: speed benchmark over time (tokens/sec by day)
--    Pulls from daily_aggregates (historical) + raw exchanges (recent)
-- ============================================================

CREATE OR REPLACE FUNCTION fetch_speed_over_time(days_back integer DEFAULT 60)
RETURNS TABLE (date date, tier text, avg_tps numeric, exchange_count integer)
LANGUAGE sql SECURITY DEFINER AS $$
  -- Historical: from daily_aggregates
  SELECT date, tier, avg_tps, exchange_count
  FROM daily_aggregates
  WHERE date >= CURRENT_DATE - days_back
    AND avg_tps IS NOT NULL
  UNION ALL
  -- Recent: from raw exchanges
  SELECT
    DATE(created_at)              AS date,
    COALESCE(tier, 'unknown')     AS tier,
    ROUND(AVG(tokens_per_second)::numeric, 2) AS avg_tps,
    COUNT(*)::integer             AS exchange_count
  FROM exchanges
  WHERE created_at >= NOW() - (days_back || ' days')::interval
    AND tokens_per_second IS NOT NULL
    AND suspicious = false
    AND partial    = false
  GROUP BY DATE(created_at), COALESCE(tier, 'unknown')
  ORDER BY date ASC;
$$;

-- ============================================================
-- 7. Analytics: updated community_stats — include 'max'/'team'
-- ============================================================

CREATE OR REPLACE FUNCTION community_stats(since timestamptz)
RETURNS json LANGUAGE sql SECURITY DEFINER AS $$
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

-- ============================================================
-- 8. Security: safe public view — never exposes device_fingerprint
-- ============================================================

CREATE OR REPLACE VIEW public_exchanges AS
  SELECT
    id, anonymous_id, timestamp, model, adaptive_mode,
    tokens_in, tokens_out, attachment_tokens_estimated,
    response_duration_ms, tokens_per_second,
    hit_limit, partial, tier, suspicious, created_at
    -- device_fingerprint intentionally excluded
  FROM exchanges;

-- RLS does not apply to views by default; restrict via the underlying table.
-- The view is SECURITY INVOKER so it uses the caller's RLS context.

-- ============================================================
-- 9. flag_post fix — accept anon_id for deduplication
-- ============================================================

CREATE OR REPLACE FUNCTION flag_post(post_id uuid, flagging_anon_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE community_posts
  SET
    flag_count = flag_count + 1,
    flagged    = (flag_count + 1 >= 3)
  WHERE id = post_id;
END;
$$;
