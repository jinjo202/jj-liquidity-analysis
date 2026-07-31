create table if not exists public.daily_market (
  date text primary key,
  kospi numeric,
  kosdaq numeric,
  credit_loan numeric,
  forced_sell numeric,
  unpaid numeric,
  kospi_market_cap numeric,
  kosdaq_market_cap numeric,
  kospi_turnover numeric,
  kosdaq_turnover numeric,
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_split_raw (
  date text primary key,
  total numeric not null,
  kospi numeric not null,
  kosdaq numeric not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.analysis_snapshot (
  id bigserial primary key,
  computed_at timestamptz not null default now(),
  last_date text not null,
  is_latest boolean not null default true,
  data jsonb not null
);
create index if not exists analysis_snapshot_latest_idx
  on public.analysis_snapshot (is_latest) where is_latest;

create table if not exists public.ai_commentary (
  id bigserial primary key,
  date text not null unique,
  content text not null,
  model text not null,
  created_at timestamptz not null default now()
);

alter table public.daily_market enable row level security;
alter table public.credit_split_raw enable row level security;
alter table public.analysis_snapshot enable row level security;
alter table public.ai_commentary enable row level security;

create policy "public read daily_market" on public.daily_market
  for select using (true);
create policy "public read credit_split_raw" on public.credit_split_raw
  for select using (true);
create policy "public read analysis_snapshot" on public.analysis_snapshot
  for select using (true);
create policy "public read ai_commentary" on public.ai_commentary
  for select using (true);
