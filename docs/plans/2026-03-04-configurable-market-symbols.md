# Configurable Market Symbols — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Allow admins to add, remove, and reorder tracked market symbols (stocks, indices, commodities, crypto, sector ETFs) from the admin panel instead of requiring code changes.

**Architecture:** Supabase table stores symbol config, RPCs for read/write, admin UI with tabbed interface and drag-to-reorder, server handlers read from DB with Redis caching, hardcoded config as fallback.

**Tech Stack:** Supabase (PostgreSQL), TypeScript (Vercel Edge Functions), vanilla DOM (admin UI), Redis (Upstash) caching.

**Design Doc:** `docs/plans/2026-03-04-configurable-market-symbols-design.md`

---

### Task 1: Supabase Migration — Table, RPCs, Seed Data

**Files:**
- Create: `supabase/migrations/20260304200000_create_market_symbols.sql`

**Context:**
- Follow the exact pattern from `supabase/migrations/20260304100000_create_display_settings.sql`
- The `wm_admin` schema already exists with `is_admin()` function and `set_updated_at()` trigger function
- `public.get_my_admin_role()` already exists for auth guards
- Apply migration using the Supabase MCP tool (`apply_migration`)

**Step 1: Create the migration file**

```sql
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
```

**Step 2: Apply the migration via Supabase MCP**

Use `apply_migration` with project ref from the existing Supabase project. Verify by calling `get_market_symbols()` and confirming it returns the seeded data.

**Step 3: Commit**

```bash
git add supabase/migrations/20260304200000_create_market_symbols.sql
git commit -m "feat: add market_symbols table with RPCs and seed data"
```

---

### Task 2: Admin API — Market Symbols CRUD Endpoint

**Files:**
- Create: `api/admin/market-symbols.ts`

**Context:**
- Follow the exact pattern from `api/admin/display-settings.ts`
- Uses `requireAdmin`, `errorResponse`, `corsHeaders` from `api/admin/_auth.ts`
- The `client` from `requireAdmin` is a Supabase client authenticated as the admin user

**Step 1: Create the endpoint**

```typescript
import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  let admin;
  try { admin = await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const { client } = admin;

  if (req.method === 'GET') {
    const { data, error } = await client.rpc('get_market_symbols');
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify(data), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    let body: { category?: string; symbols?: Array<{ symbol: string; name: string; display?: string }> };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
    }

    if (!body.category || !Array.isArray(body.symbols)) {
      return new Response(JSON.stringify({ error: 'category and symbols[] required' }), { status: 400, headers });
    }

    const { error } = await client.rpc('admin_update_market_symbols', {
      p_category: body.category,
      p_symbols: body.symbols,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });

    // Invalidate Redis cache so next market data fetch picks up new symbols
    try {
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (redisUrl && redisToken) {
        const keysToDelete = [
          'market:symbols:v1',
          'market:quotes:v1',
          'market:crypto:v1',
          'market:commodities:v1',
          'market:sectors:v1',
        ];
        // Pipeline DEL — delete keys by prefix pattern
        for (const key of keysToDelete) {
          await fetch(`${redisUrl}/DEL/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${redisToken}` },
          }).catch(() => {});
        }
      }
    } catch {
      // Redis clear is best-effort; symbols will refresh on TTL expiry
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
```

**Step 2: Commit**

```bash
git add api/admin/market-symbols.ts
git commit -m "feat: add admin API endpoint for market symbols CRUD"
```

---

### Task 3: Admin API — Symbol Validation Endpoint

**Files:**
- Create: `api/admin/validate-symbol.ts`

**Context:**
- Reuses `fetchYahooQuote` from `server/worldmonitor/market/v1/_shared.ts` for stock/commodity/sector validation
- Uses CoinGecko `/coins/{id}` for crypto validation
- Auth via `requireAdmin`

**Step 1: Create the validation endpoint**

```typescript
import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export const config = { runtime: 'edge' };

const UPSTREAM_TIMEOUT_MS = 10_000;
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function validateYahoo(symbol: string): Promise<{ valid: boolean; name?: string; price?: number }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { valid: false };
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice === 0) return { valid: false };
    return { valid: true, name: meta.shortName || meta.symbol || symbol, price: meta.regularMarketPrice };
  } catch {
    return { valid: false };
  }
}

async function validateCrypto(coinId: string): Promise<{ valid: boolean; name?: string; symbol?: string; price?: number }> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { valid: false };
    const data = await resp.json();
    if (!data?.id) return { valid: false };
    return {
      valid: true,
      name: data.name,
      symbol: (data.symbol || '').toUpperCase(),
      price: data.market_data?.current_price?.usd ?? 0,
    };
  } catch {
    return { valid: false };
  }
}

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try { await requireAdmin(req); } catch (err) { return errorResponse(err); }

  let body: { category?: string; symbol?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  if (!body.category || !body.symbol) {
    return new Response(JSON.stringify({ error: 'category and symbol required' }), { status: 400, headers });
  }

  const { category, symbol } = body;

  if (category === 'crypto') {
    const result = await validateCrypto(symbol.toLowerCase());
    return new Response(JSON.stringify(result), { status: 200, headers });
  }

  if (['stock', 'commodity', 'sector'].includes(category)) {
    const result = await validateYahoo(symbol);
    return new Response(JSON.stringify(result), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Invalid category' }), { status: 400, headers });
}
```

**Step 2: Commit**

```bash
git add api/admin/validate-symbol.ts
git commit -m "feat: add symbol validation endpoint for admin market config"
```

---

### Task 4: Server-Side Helper — Fetch Symbols from Supabase

**Files:**
- Create: `server/_shared/market-symbols.ts`

**Context:**
- Uses `createAnonClient()` from `server/_shared/supabase.ts` to call `get_market_symbols()` RPC
- Caches result in Redis via `cachedFetchJson` from `server/_shared/redis.ts`
- Fallback: hardcoded symbols from `src/config/markets.ts`
- Every server handler will call `getConfiguredSymbols(category)` instead of using hardcoded arrays

**Step 1: Create the helper**

```typescript
import { createAnonClient } from './supabase';
import { cachedFetchJson } from './redis';

interface SymbolEntry {
  symbol: string;
  name: string;
  display: string | null;
  sort_order: number;
}

interface MarketSymbolsConfig {
  stock: SymbolEntry[];
  commodity: SymbolEntry[];
  crypto: SymbolEntry[];
  sector: SymbolEntry[];
}

const REDIS_KEY = 'market:symbols:v1';
const REDIS_TTL = 300; // 5 min — symbol config changes are infrequent

let inMemoryFallback: MarketSymbolsConfig | null = null;

async function fetchFromSupabase(): Promise<MarketSymbolsConfig | null> {
  try {
    const client = createAnonClient();
    const { data, error } = await client.rpc('get_market_symbols');
    if (error || !data) return null;
    return data as MarketSymbolsConfig;
  } catch {
    return null;
  }
}

export async function getAllMarketSymbols(): Promise<MarketSymbolsConfig | null> {
  try {
    const result = await cachedFetchJson<MarketSymbolsConfig>(REDIS_KEY, REDIS_TTL, fetchFromSupabase);
    if (result) {
      inMemoryFallback = result;
      return result;
    }
  } catch {
    // Redis/Supabase failure — fall through
  }
  return inMemoryFallback;
}

export async function getConfiguredSymbols(
  category: 'stock' | 'commodity' | 'crypto' | 'sector',
): Promise<SymbolEntry[] | null> {
  const all = await getAllMarketSymbols();
  return all?.[category] ?? null;
}
```

**Step 2: Commit**

```bash
git add server/_shared/market-symbols.ts
git commit -m "feat: add server-side helper to fetch market symbols from Supabase"
```

---

### Task 5: Server Handler Updates — Read Symbols from DB

**Files:**
- Modify: `server/worldmonitor/market/v1/list-market-quotes.ts`
- Modify: `server/worldmonitor/market/v1/list-crypto-quotes.ts`
- Modify: `server/worldmonitor/market/v1/get-sector-summary.ts`
- Modify: `server/worldmonitor/market/v1/list-commodity-quotes.ts`
- Modify: `server/worldmonitor/market/v1/_shared.ts`

**Context:**
- Each handler currently uses hardcoded symbols or `req.symbols` from the client
- After this change, handlers read from DB via `getConfiguredSymbols()`, falling back to `req.symbols` (from client-passed hardcoded config) if DB returns null
- `YAHOO_ONLY_SYMBOLS` in `_shared.ts` becomes a function that derives from the current symbol list
- `CRYPTO_META` in `_shared.ts` becomes dynamic

**Changes per handler:**

**`list-market-quotes.ts`** — At the top of the function, get symbols from DB; fall back to `req.symbols`:
```typescript
import { getConfiguredSymbols } from '../../../_shared/market-symbols';

// Inside listMarketQuotes:
const dbSymbols = await getConfiguredSymbols('stock');
const symbols = dbSymbols ? dbSymbols.map(s => s.symbol) : req.symbols;
```
The Redis cache key must include the actual symbols used (already does via `cacheKey`).

**`list-crypto-quotes.ts`** — Get crypto IDs from DB; fall back to `CRYPTO_META`:
```typescript
import { getConfiguredSymbols } from '../../../_shared/market-symbols';

// Inside listCryptoQuotes:
const dbCrypto = await getConfiguredSymbols('crypto');
const ids = dbCrypto ? dbCrypto.map(s => s.symbol) : (req.ids.length > 0 ? req.ids : Object.keys(CRYPTO_META));
// Build dynamic meta map from DB entries:
const dynamicMeta = dbCrypto
  ? Object.fromEntries(dbCrypto.map(s => [s.symbol, { name: s.name, symbol: s.display || s.symbol.toUpperCase() }]))
  : CRYPTO_META;
```

**`get-sector-summary.ts`** — Get sector symbols from DB; fall back to hardcoded array:
```typescript
import { getConfiguredSymbols } from '../../../_shared/market-symbols';

// Inside getSectorSummary:
const dbSectors = await getConfiguredSymbols('sector');
const sectorSymbols = dbSectors ? dbSectors.map(s => s.symbol) : ['XLK', 'XLF', ...];
```

**`list-commodity-quotes.ts`** — Get commodity symbols from DB; fall back to `req.symbols`:
```typescript
import { getConfiguredSymbols } from '../../../_shared/market-symbols';

// Inside listCommodityQuotes:
const dbCommodities = await getConfiguredSymbols('commodity');
const symbols = dbCommodities ? dbCommodities.map(s => s.symbol) : req.symbols;
```

**`_shared.ts`** — Make `YAHOO_ONLY_SYMBOLS` a function instead of a static set:
```typescript
export function isYahooOnlySymbol(symbol: string): boolean {
  return symbol.startsWith('^') || symbol.includes('=');
}
```
Update references in `list-market-quotes.ts` to use `isYahooOnlySymbol(s)` instead of `YAHOO_ONLY_SYMBOLS.has(s)`.
Keep the old `YAHOO_ONLY_SYMBOLS` set temporarily for backward compatibility but add a deprecation comment.

**Step: Commit**

```bash
git add server/worldmonitor/market/v1/*.ts server/_shared/market-symbols.ts
git commit -m "feat: server handlers read market symbols from Supabase with fallback"
```

---

### Task 6: Client-Side Updates — Remove Hardcoded Symbol Passing

**Files:**
- Modify: `src/config/markets.ts` — Add fallback comments
- Modify: `src/app/data-loader.ts` — Still pass symbols but from config (server will prefer DB)

**Context:**
- The client still passes symbols via the RPC request for backward compatibility
- If the server finds DB symbols, it uses those instead of client-passed ones
- The hardcoded config in `src/config/markets.ts` is kept as the client-side fallback
- No change to the `fetchMultipleStocks` or `fetchCrypto` signatures

**Step 1: Add fallback comments to `src/config/markets.ts`**

Add a comment at the top:
```typescript
/**
 * Hardcoded market symbol defaults — used as client-side fallback.
 * The server reads configured symbols from Supabase (wm_admin.market_symbols).
 * These are only used when the database is unavailable.
 */
```

**Step 2: Commit**

```bash
git add src/config/markets.ts
git commit -m "docs: mark hardcoded market config as fallback"
```

---

### Task 7: Admin UI Page — Market Symbols Management

**Files:**
- Create: `src/admin/pages/market-symbols.ts`
- Modify: `src/admin/dashboard.ts` — Add nav item + route

**Context:**
- Follow patterns from `src/admin/pages/display-settings.ts` for API calls and styling
- Tabbed interface: 4 tabs for Stocks/Indices, Commodities, Crypto, Sector ETFs
- Each tab: sortable list, counter (current/max), add form with validation, remove button
- Uses native HTML5 drag-and-drop for reordering (no library needed)
- Batched save: changes are local until "Save Changes" button clicked
- Token passed from `dashboard.ts` for authenticated API calls

**Admin UI Requirements:**

1. **Tab bar** — 4 tabs with category name and current/max count badge
2. **Symbol list** — Each row: drag handle (⠿), display code, full name, remove (×) button
3. **Drag-to-reorder** — HTML5 drag and drop on the list items, updates sort_order
4. **Add form** — Input for symbol/ticker, optional display name, Validate button, Add button
5. **Validate button** — Calls `POST /api/admin/validate-symbol`, shows green ✓ with name+price or red ✗
6. **Save Changes button** — Calls `PUT /api/admin/market-symbols` with `{ category, symbols }`, shows "Saved" feedback
7. **Error handling** — Show errors for API failures, validation failures, max limit reached

**Dashboard integration:**

In `src/admin/dashboard.ts`:
- Add `'market-symbols'` to the `PageId` type
- Add `{ id: 'market-symbols', label: 'Market Symbols', icon: '📈' }` to the `NAV` array
- Import `renderMarketSymbolsPage` from `./pages/market-symbols`
- Add `case 'market-symbols'` in the `navigateTo` switch calling `renderMarketSymbolsPage(content, accessToken)`

**Step: Commit**

```bash
git add src/admin/pages/market-symbols.ts src/admin/dashboard.ts
git commit -m "feat: add admin UI page for managing market symbols"
```

---

### Task 8: Integration Testing & Redis Cache Invalidation

**Files:**
- Verify: All endpoints work end-to-end
- Verify: Redis cache is cleared on admin save
- Verify: Server picks up new symbols after cache clear

**Context:**
- The admin PUT endpoint already includes Redis cache invalidation (Task 2)
- The Redis cache keys to invalidate are:
  - `market:symbols:v1` (the symbol config cache from Task 4)
  - Individual quote cache keys are prefixed with `market:quotes:v1:`, `market:crypto:v1:`, etc.
    These are keyed by the actual symbol list, so new symbols will create new cache entries automatically
- The server uses `cachedFetchJson` which checks Redis first, so clearing `market:symbols:v1` forces a fresh DB read

**Verification steps:**
1. Start dev server: `npx vercel dev`
2. Open admin panel → Market Symbols page
3. Verify all 50 seeded symbols appear in correct tabs
4. Add a new stock symbol (e.g., `AMD`) — validate → add → save
5. Refresh main dashboard → verify AMD appears in the Markets panel
6. Remove a symbol → save → verify it disappears from the dashboard
7. Reorder symbols → save → verify new order on dashboard

**Step: Commit (if any fixes needed)**

```bash
git commit -m "fix: address integration issues for configurable market symbols"
```
