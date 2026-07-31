create table if not exists public.lending_balance_raw (
  date text primary key,
  deal_shares numeric,
  repay_shares numeric,
  balance_shares numeric not null,
  balance_mil numeric not null,
  updated_at timestamptz not null default now()
);
alter table public.lending_balance_raw enable row level security;
create policy "public read lending_balance_raw" on public.lending_balance_raw
  for select using (true);
