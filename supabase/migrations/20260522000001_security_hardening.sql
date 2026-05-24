-- Security hardening migration: add length constraints + flag dedup table

-- ---- Length constraints on unbounded text columns ----

alter table exchanges
  add constraint exchanges_model_length         check (model is null or char_length(model) <= 100),
  add constraint exchanges_limit_msg_length      check (limit_message is null or char_length(limit_message) <= 500);

alter table community_posts
  add constraint posts_display_name_length       check (display_name is null or char_length(display_name) <= 32);

-- ---- Per-user flag deduplication ----
-- Prevents a single anonymous_id from flagging the same post multiple times.

create table if not exists post_flags (
  post_id      uuid not null references community_posts(id) on delete cascade,
  anonymous_id text not null,
  created_at   timestamptz default now(),
  primary key (post_id, anonymous_id)
);

alter table post_flags enable row level security;

create policy "Allow flag insert" on post_flags
  for insert with check (true);

-- Replace the flag_post RPC with one that enforces per-user uniqueness

create or replace function flag_post(post_id uuid, flagging_anon_id text)
returns void language plpgsql security definer as $$
begin
  -- Insert dedup record; if already flagged by this user, do nothing
  insert into post_flags (post_id, anonymous_id)
  values (flag_post.post_id, flagging_anon_id)
  on conflict (post_id, anonymous_id) do nothing;

  -- Recount actual flags and hide if threshold reached
  update community_posts cp
  set flag_count = (select count(*) from post_flags pf where pf.post_id = cp.id),
      flagged    = (select count(*) from post_flags pf where pf.post_id = cp.id) >= 3
  where cp.id = flag_post.post_id;
end;
$$;
