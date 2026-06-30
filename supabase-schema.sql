-- Run this once in Supabase SQL Editor: https://supabase.com/dashboard → SQL Editor → New Query

create table if not exists scores (
  id         bigint generated always as identity primary key,
  player     text        not null,
  country    text        not null check (country in ('UK','FR','DE','ES')),
  deaths     integer     not null,
  co2_pct    real        not null,
  econ_loss  real        not null,
  approval   integer     not null,
  ending     text        not null,
  score      integer     not null,
  player_ip  text,
  created_at timestamptz not null default now()
);

create index if not exists idx_score   on scores (score desc);
create index if not exists idx_country on scores (country);
create index if not exists idx_ip_time on scores (player_ip, created_at);

-- Row Level Security: public can read, only service role can write
alter table scores enable row level security;

create policy "public read"
  on scores for select
  to anon
  using (true);

-- Writes come only from the Netlify Function (service role key), so no INSERT policy needed for anon.
