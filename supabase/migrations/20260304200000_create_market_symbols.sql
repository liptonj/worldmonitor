-- 1. Create market_symbols table
create table wm_admin.market_symbols (
  id          serial primary key,
  category    text not null check (category in ('stock', 'commodity', 'crypto', 'sector')),
  symbol      text not null,
  name        text not null,
  display     text,
  sort_order  int not null default 0,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(category, symbol)
);

comment on table wm_admin.market_symbols is 'Admin-configurable market symbols for stocks, commodities, crypto, and sector ETFs.';

-- 2. Auto-update trigger
create trigger trg_market_symbols_upd
  before update on wm_admin.market_symbols
  for each row execute function wm_admin.set_updated_at();

-- 3. RLS
alter table wm_admin.market_symbols enable row level security;
alter table wm_admin.market_symbols force row level security;

create policy "admins_all_market_symbols"
  on wm_admin.market_symbols for all
  using ((select wm_admin.is_admin()));

-- 4. Seed existing hardcoded symbols (28 stocks, 6 commodities, 4 crypto, 12 sectors)
-- Stocks/Indices
insert into wm_admin.market_symbols (category, symbol, name, display, sort_order) values
  ('stock', '^GSPC', 'S&P 500', 'SPX', 0),
  ('stock', '^DJI', 'Dow Jones', 'DOW', 1),
  ('stock', '^IXIC', 'NASDAQ', 'NDX', 2),
  ('stock', 'AAPL', 'Apple', 'AAPL', 3),
  ('stock', 'MSFT', 'Microsoft', 'MSFT', 4),
  ('stock', 'NVDA', 'NVIDIA', 'NVDA', 5),
  ('stock', 'GOOGL', 'Alphabet', 'GOOGL', 6),
  ('stock', 'AMZN', 'Amazon', 'AMZN', 7),
  ('stock', 'META', 'Meta', 'META', 8),
  ('stock', 'BRK-B', 'Berkshire', 'BRK.B', 9),
  ('stock', 'TSM', 'TSMC', 'TSM', 10),
  ('stock', 'LLY', 'Eli Lilly', 'LLY', 11),
  ('stock', 'TSLA', 'Tesla', 'TSLA', 12),
  ('stock', 'AVGO', 'Broadcom', 'AVGO', 13),
  ('stock', 'WMT', 'Walmart', 'WMT', 14),
  ('stock', 'JPM', 'JPMorgan', 'JPM', 15),
  ('stock', 'V', 'Visa', 'V', 16),
  ('stock', 'UNH', 'UnitedHealth', 'UNH', 17),
  ('stock', 'NVO', 'Novo Nordisk', 'NVO', 18),
  ('stock', 'XOM', 'Exxon', 'XOM', 19),
  ('stock', 'MA', 'Mastercard', 'MA', 20),
  ('stock', 'ORCL', 'Oracle', 'ORCL', 21),
  ('stock', 'PG', 'P&G', 'PG', 22),
  ('stock', 'COST', 'Costco', 'COST', 23),
  ('stock', 'JNJ', 'J&J', 'JNJ', 24),
  ('stock', 'HD', 'Home Depot', 'HD', 25),
  ('stock', 'NFLX', 'Netflix', 'NFLX', 26),
  ('stock', 'BAC', 'BofA', 'BAC', 27);

-- Commodities
insert into wm_admin.market_symbols (category, symbol, name, display, sort_order) values
  ('commodity', '^VIX', 'VIX', 'VIX', 0),
  ('commodity', 'GC=F', 'Gold', 'GOLD', 1),
  ('commodity', 'CL=F', 'Crude Oil', 'OIL', 2),
  ('commodity', 'NG=F', 'Natural Gas', 'NATGAS', 3),
  ('commodity', 'SI=F', 'Silver', 'SILVER', 4),
  ('commodity', 'HG=F', 'Copper', 'COPPER', 5);

-- Crypto
insert into wm_admin.market_symbols (category, symbol, name, display, sort_order) values
  ('crypto', 'bitcoin', 'Bitcoin', 'BTC', 0),
  ('crypto', 'ethereum', 'Ethereum', 'ETH', 1),
  ('crypto', 'solana', 'Solana', 'SOL', 2),
  ('crypto', 'ripple', 'XRP', 'XRP', 3);

-- Sector ETFs
insert into wm_admin.market_symbols (category, symbol, name, display, sort_order) values
  ('sector', 'XLK', 'Tech', null, 0),
  ('sector', 'XLF', 'Finance', null, 1),
  ('sector', 'XLE', 'Energy', null, 2),
  ('sector', 'XLV', 'Health', null, 3),
  ('sector', 'XLY', 'Consumer', null, 4),
  ('sector', 'XLI', 'Industrial', null, 5),
  ('sector', 'XLP', 'Staples', null, 6),
  ('sector', 'XLU', 'Utilities', null, 7),
  ('sector', 'XLB', 'Materials', null, 8),
  ('sector', 'XLRE', 'Real Est', null, 9),
  ('sector', 'XLC', 'Comms', null, 10),
  ('sector', 'SMH', 'Semis', null, 11);

-- 5. Public RPC: get_market_symbols (no auth required)
create or replace function public.get_market_symbols()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'stock', coalesce((
      select json_agg(json_build_object(
        'symbol', symbol, 'name', name, 'display', display, 'sort_order', sort_order
      ) order by sort_order)
      from wm_admin.market_symbols where category = 'stock' and enabled = true
    ), '[]'::json),
    'commodity', coalesce((
      select json_agg(json_build_object(
        'symbol', symbol, 'name', name, 'display', display, 'sort_order', sort_order
      ) order by sort_order)
      from wm_admin.market_symbols where category = 'commodity' and enabled = true
    ), '[]'::json),
    'crypto', coalesce((
      select json_agg(json_build_object(
        'symbol', symbol, 'name', name, 'display', display, 'sort_order', sort_order
      ) order by sort_order)
      from wm_admin.market_symbols where category = 'crypto' and enabled = true
    ), '[]'::json),
    'sector', coalesce((
      select json_agg(json_build_object(
        'symbol', symbol, 'name', name, 'display', display, 'sort_order', sort_order
      ) order by sort_order)
      from wm_admin.market_symbols where category = 'sector' and enabled = true
    ), '[]'::json)
  );
$$;

grant execute on function public.get_market_symbols() to anon, authenticated;

-- 6. Admin RPC: admin_update_market_symbols (admin only)
-- Replaces all symbols for a given category with the provided JSONB array.
-- Validates max limits: stock=30, commodity=10, crypto=10, sector=15.
create or replace function public.admin_update_market_symbols(
  p_category text,
  p_symbols  jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max int;
  v_count int;
  v_item jsonb;
  v_idx int := 0;
begin
  if (select public.get_my_admin_role()) is null then
    raise exception 'Access denied: admin role required' using errcode = '42501';
  end if;

  if p_category not in ('stock', 'commodity', 'crypto', 'sector') then
    raise exception 'Invalid category: %', p_category using errcode = '22023';
  end if;

  if jsonb_typeof(p_symbols) is distinct from 'array' then
    raise exception 'p_symbols must be a JSON array' using errcode = '22023';
  end if;

  v_max := case p_category
    when 'stock' then 30
    when 'commodity' then 10
    when 'crypto' then 10
    when 'sector' then 15
  end;

  v_count := jsonb_array_length(p_symbols);
  if v_count > v_max then
    raise exception 'Too many symbols for %: % exceeds max %', p_category, v_count, v_max
      using errcode = '22023';
  end if;

  delete from wm_admin.market_symbols where category = p_category;

  for v_item in select * from jsonb_array_elements(p_symbols)
  loop
    if v_item->>'symbol' is null or v_item->>'name' is null then
      raise exception 'Each symbol must have symbol and name (index %)', v_idx using errcode = '22023';
    end if;

    insert into wm_admin.market_symbols (category, symbol, name, display, sort_order, enabled)
    values (
      p_category,
      v_item->>'symbol',
      v_item->>'name',
      v_item->>'display',
      v_idx,
      true
    );
    v_idx := v_idx + 1;
  end loop;
end;
$$;

grant execute on function public.admin_update_market_symbols(text, jsonb) to authenticated;
revoke execute on function public.admin_update_market_symbols(text, jsonb) from anon, public;
