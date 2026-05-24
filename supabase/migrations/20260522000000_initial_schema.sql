-- ClaudeWatch Supabase Schema
-- Run this in the Supabase SQL editor.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "pgcrypto";
create extension if not exists "pg_stat_statements";

-- ============================================================
-- Tables
-- ============================================================

create table if not exists exchanges (
  id                          uuid primary key default gen_random_uuid(),
  anonymous_id                text not null,
  device_fingerprint          text not null,
  timestamp                   timestamptz not null,
  model                       text,
  adaptive_mode               boolean default false,
  tokens_in                   integer check (tokens_in >= 0 and tokens_in < 500000),
  tokens_out                  integer check (tokens_out >= 0 and tokens_out < 500000),
  attachment_tokens_estimated integer check (attachment_tokens_estimated >= 0),
  response_duration_ms        integer check (response_duration_ms >= 0),
  tokens_per_second           numeric(8,2),
  hit_limit                   boolean default false,
  limit_message               text,
  partial                     boolean default false,
  tier                        text check (tier in ('free', 'pro', 'unknown')),
  suspicious                  boolean default false,
  created_at                  timestamptz default now()
);

create index if not exists exchanges_anon_id_idx      on exchanges (anonymous_id);
create index if not exists exchanges_created_at_idx   on exchanges (created_at desc);
create index if not exists exchanges_tier_idx         on exchanges (tier);
create index if not exists exchanges_device_fp_idx    on exchanges (device_fingerprint);

-- ----

create table if not exists usage_snapshots (
  id               uuid primary key default gen_random_uuid(),
  anonymous_id     text not null,
  usage_percent    integer check (usage_percent >= 0 and usage_percent <= 100),
  resets_in_minutes integer,
  tier             text check (tier in ('free', 'pro', 'unknown')),
  timestamp        timestamptz not null,
  created_at       timestamptz default now()
);

create index if not exists snapshots_anon_id_idx    on usage_snapshots (anonymous_id);
create index if not exists snapshots_created_at_idx on usage_snapshots (created_at desc);

-- ----

create table if not exists community_posts (
  id           uuid primary key default gen_random_uuid(),
  anonymous_id text not null,
  display_name text,
  content      text not null check (char_length(content) <= 280 and content !~ 'https?://|www\.'),
  upvotes      integer default 0,
  downvotes    integer default 0,
  flagged      boolean default false,
  flag_count   integer default 0,
  created_at   timestamptz default now()
);

create index if not exists posts_created_at_idx on community_posts (created_at desc);
create index if not exists posts_anon_id_idx    on community_posts (anonymous_id);

-- ----

create table if not exists install_events (
  id                uuid primary key default gen_random_uuid(),
  anonymous_id      text not null unique,
  device_fingerprint text not null,
  tier              text,
  install_date      timestamptz,
  user_agent_hash   text,
  created_at        timestamptz default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table exchanges        enable row level security;
alter table usage_snapshots  enable row level security;
alter table community_posts  enable row level security;
alter table install_events   enable row level security;

-- INSERT: anyone with anon key
create policy "Allow public insert" on exchanges
  for insert with check (true);

create policy "Allow public insert" on usage_snapshots
  for insert with check (true);

create policy "Allow public insert" on community_posts
  for insert with check (true);

create policy "Allow public insert" on install_events
  for insert with check (true);

-- SELECT: public reads (dashboard)
create policy "Allow public select" on exchanges
  for select using (true);

create policy "Allow public select" on usage_snapshots
  for select using (true);

-- Community posts: hide flagged posts
create policy "Public select non-flagged posts" on community_posts
  for select using (flagged = false);

create policy "Allow public select" on install_events
  for select using (true);

-- UPDATE/DELETE: service role only (no policies = denied by default for anon)


-- ============================================================
-- Anti-abuse: rate-limit trigger on exchanges
-- ============================================================

create or replace function check_exchange_rate_limit()
returns trigger language plpgsql security definer as $$
declare
  recent_count integer;
begin
  select count(*) into recent_count
  from exchanges
  where anonymous_id = new.anonymous_id
    and created_at > now() - interval '30 seconds';

  if recent_count >= 2 then
    raise exception 'rate_limit' using hint = 'Too many inserts from this anonymous_id';
  end if;
  return new;
end;
$$;

create trigger exchanges_rate_limit
  before insert on exchanges
  for each row execute function check_exchange_rate_limit();

-- ----

create or replace function check_post_daily_limit()
returns trigger language plpgsql security definer as $$
declare
  daily_count integer;
begin
  select count(*) into daily_count
  from community_posts
  where anonymous_id = new.anonymous_id
    and created_at > now() - interval '24 hours';

  if daily_count >= 10 then
    raise exception 'rate_limit' using hint = 'Daily post limit reached';
  end if;
  return new;
end;
$$;

create trigger posts_daily_limit
  before insert on community_posts
  for each row execute function check_post_daily_limit();

-- ----

-- Flag suspicious accounts: if same device fingerprint has > 5 different anonymous IDs
create or replace function flag_suspicious_fingerprints()
returns trigger language plpgsql security definer as $$
declare
  id_count integer;
begin
  select count(distinct anonymous_id) into id_count
  from exchanges
  where device_fingerprint = new.device_fingerprint;

  if id_count > 5 then
    update exchanges
      set suspicious = true
      where device_fingerprint = new.device_fingerprint;
  end if;
  return new;
end;
$$;

create trigger suspicious_fingerprint_check
  after insert on exchanges
  for each row execute function flag_suspicious_fingerprints();

-- ============================================================
-- RPC functions (called from popup and dashboard)
-- ============================================================

create or replace function vote_post(post_id uuid, direction text)
returns void language plpgsql security definer as $$
begin
  if direction = 'up' then
    update community_posts set upvotes = upvotes + 1 where id = post_id;
  elsif direction = 'down' then
    update community_posts set downvotes = downvotes + 1 where id = post_id;
  end if;
end;
$$;

create or replace function flag_post(post_id uuid)
returns void language plpgsql security definer as $$
begin
  update community_posts
    set flag_count = flag_count + 1,
        flagged = (flag_count + 1 >= 3)
    where id = post_id;
end;
$$;

-- Community stats aggregate (called by popup and dashboard)
create or replace function community_stats(since timestamptz)
returns json language sql security definer as $$
  select json_build_object(
    'active_users',        (select count(distinct anonymous_id) from exchanges where created_at >= since and suspicious = false),
    'avg_tokens_out',      (select round(avg(tokens_out)) from exchanges where created_at >= since and suspicious = false and partial = false),
    'rate_limit_events',   (select count(*) from exchanges where created_at >= since and hit_limit = true and suspicious = false),
    'median_usage_pro',    (select percentile_cont(0.5) within group (order by usage_percent) from usage_snapshots where created_at >= since and tier = 'pro'),
    'median_usage_free',   (select percentile_cont(0.5) within group (order by usage_percent) from usage_snapshots where created_at >= since and tier = 'free'),
    'total_exchanges',     (select count(*) from exchanges where suspicious = false),
    'total_users',         (select count(distinct anonymous_id) from exchanges where suspicious = false),
    'most_used_model',     (select model from exchanges where created_at >= since and suspicious = false group by model order by count(*) desc limit 1),
    'adaptive_pct',        (select round(100.0 * count(*) filter (where adaptive_mode = true) / nullif(count(*), 0)) from exchanges where created_at >= since and suspicious = false),
    'avg_response_ms',     (select round(avg(response_duration_ms)) from exchanges where created_at >= since and suspicious = false and partial = false),
    'avg_tokens_per_sec',  (select round(avg(tokens_per_second)::numeric, 1) from exchanges where created_at >= since and suspicious = false and partial = false)
  );
$$;
