-- ============================================================
-- Migration: fix public_exchanges SECURITY DEFINER → SECURITY INVOKER
-- ============================================================
--
-- Root cause:
--   PostgreSQL views default to SECURITY DEFINER behaviour: they execute
--   as the view owner (postgres / superuser) and bypass the calling user's
--   RLS context. Migration 000002 had a comment claiming the view was
--   SECURITY INVOKER but never used the WITH (security_invoker = true)
--   clause, so Postgres silently applied the insecure default.
--
-- Fix:
--   1. Grant column-level SELECT on the underlying exchanges table to
--      anon / authenticated, for exactly the columns the view exposes.
--      This is required so that when the view runs as the invoker (anon),
--      it has permission to read those columns. device_fingerprint and
--      limit_message are intentionally omitted from the grant — they stay
--      invisible even on direct table queries.
--
--   2. Recreate public_exchanges WITH (security_invoker = true) so Postgres
--      evaluates RLS policies as the calling user, not the view owner.
--      The column list is unchanged from migration 000002.
-- ============================================================

-- Step 1: column-level grants (excludes device_fingerprint and limit_message)
GRANT SELECT (
  id,
  anonymous_id,
  timestamp,
  model,
  adaptive_mode,
  tokens_in,
  tokens_out,
  attachment_tokens_estimated,
  response_duration_ms,
  tokens_per_second,
  hit_limit,
  partial,
  tier,
  suspicious,
  created_at
) ON exchanges TO anon, authenticated;

-- Step 2: recreate the view with security_invoker = true
-- (Supabase runs PostgreSQL 15+ which supports this view option)
CREATE OR REPLACE VIEW public_exchanges
  WITH (security_invoker = true)
AS
  SELECT
    id, anonymous_id, timestamp, model, adaptive_mode,
    tokens_in, tokens_out, attachment_tokens_estimated,
    response_duration_ms, tokens_per_second,
    hit_limit, partial, tier, suspicious, created_at
    -- device_fingerprint and limit_message intentionally excluded
  FROM exchanges;

-- Re-apply the SELECT grant on the view itself (belt-and-suspenders)
GRANT SELECT ON public_exchanges TO anon, authenticated;
