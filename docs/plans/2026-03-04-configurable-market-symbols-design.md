# Configurable Market Symbols — Design

Date: 2026-03-04

## Problem

All tracked market symbols (28 stocks/indices, 6 commodities, 4 cryptos, 12 sector ETFs) are hardcoded in `src/config/markets.ts`. Adding, removing, or reordering symbols requires a code change and deploy. Admins need to manage tracked symbols from the admin panel without touching code.

## Requirements

- Admin-only management — admin configures symbols everyone sees
- All four categories configurable: Stocks/Indices, Commodities, Crypto, Sector ETFs
- Live validation against data sources (Yahoo Finance, CoinGecko) before saving
- Drag-to-reorder within each category
- Max limits per category: 30 stocks, 10 commodities, 10 crypto, 15 sectors
- Existing 50 hardcoded symbols seeded on migration day one
- Hardcoded config remains as fallback if database is unavailable

## Architecture

### 1. Database Schema

Single table `wm_admin.market_symbols`:

| Column | Type | Notes |
|---|---|---|
| `id` | `serial primary key` | Row ID |
| `category` | `text not null` | `'stock'`, `'commodity'`, `'crypto'`, `'sector'` |
| `symbol` | `text not null` | API identifier: `AAPL`, `GC=F`, `bitcoin`, `XLK` |
| `name` | `text not null` | Full name: `Apple`, `Gold`, `Bitcoin`, `Tech` |
| `display` | `text` | Short UI label: `AAPL`, `GOLD`, `BTC` — nullable for sectors |
| `sort_order` | `int not null default 0` | Display order within category |
| `enabled` | `boolean not null default true` | Soft disable without deleting |
| `created_at` | `timestamptz default now()` | |
| `updated_at` | `timestamptz default now()` | Auto-updated via trigger |

Constraints:
- `unique(category, symbol)` — no duplicate tickers per category
- `check(category in ('stock', 'commodity', 'crypto', 'sector'))`
- Max limits enforced at the application level (RPC + admin UI)

### 2. Supabase RPCs

**`public.get_market_symbols()`** — Public, no auth required
- Returns JSON grouped by category with enabled symbols ordered by `sort_order`
- `SECURITY DEFINER`, `STABLE`
- Pattern follows `get_display_settings()`

Response shape:
```json
{
  "stock": [
    {"symbol": "^GSPC", "name": "S&P 500", "display": "SPX", "sort_order": 0},
    {"symbol": "AAPL", "name": "Apple", "display": "AAPL", "sort_order": 1}
  ],
  "commodity": [...],
  "crypto": [...],
  "sector": [...]
}
```

**`public.admin_update_market_symbols(p_category text, p_symbols jsonb)`** — Admin-only
- Replaces all symbols for the given category with the provided array
- Validates max limits (30 stock, 10 commodity, 10 crypto, 15 sector)
- `SECURITY DEFINER` with `get_my_admin_role()` auth guard
- Deletes existing rows for that category, inserts new set with `sort_order` from array index
- Pattern follows `admin_update_display_settings()`

Input `p_symbols` shape:
```json
[
  {"symbol": "AAPL", "name": "Apple", "display": "AAPL"},
  {"symbol": "MSFT", "name": "Microsoft", "display": "MSFT"}
]
```

### 3. Admin API Endpoints

**`api/admin/market-symbols.ts`** — CRUD
- `GET` — Calls `get_market_symbols()` RPC, returns grouped JSON
- `PUT` — Accepts `{ category, symbols: [...] }`, calls `admin_update_market_symbols()` RPC
- Auth via `requireAdmin` (same as `api/admin/display-settings.ts`)

**`api/admin/validate-symbol.ts`** — Live validation
- `POST` — Accepts `{ category, symbol }`
- `stock`/`commodity`/`sector`: Hits Yahoo Finance chart endpoint to verify ticker exists, returns `{ valid, name, price }`
- `crypto`: Hits CoinGecko `/coins/{id}` to verify coin ID exists, returns `{ valid, name, symbol, price }`
- Auth via `requireAdmin`
- Reuses existing `fetchYahooQuote()` and CoinGecko helpers from `server/worldmonitor/market/v1/_shared.ts`

### 4. Admin UI Page

New page **"Market Symbols"** in admin sidebar navigation.

Layout:
- 4 tabs: Stocks/Indices | Commodities | Crypto | Sector ETFs
- Counter per tab showing current/max (e.g., "25/30")

Each tab:
- Sortable list of current symbols with drag handles
- Each row: display code, full name, remove (X) button
- "Add Symbol" form at bottom:
  - Text input for ticker/ID
  - Optional display name override
  - "Validate" button → calls validation endpoint → shows green checkmark with name + price or red X
  - "Add" button (disabled until validation passes)
- "Save Changes" button — sends full updated list to PUT endpoint
- Changes batched locally until Save (no auto-save)
- "Saved" confirmation after success

### 5. Server-Side Integration

Current flow:
```
Hardcoded config → data-loader.ts → service client → server handler → external API → Redis → panels
```

New flow:
```
Supabase RPC → server handler (with Redis cache) → external API → Redis → panels
Hardcoded config (fallback only)
```

Changes:
1. Server handlers (`list-market-quotes.ts`, `list-crypto-quotes.ts`, `list-commodity-quotes.ts`, `get-sector-summary.ts`) call `get_market_symbols()` RPC to get symbol lists. Result cached in Redis alongside quote data (same 8-min TTL).
2. `src/config/markets.ts` becomes fallback only — used when RPC fails or returns empty.
3. Client-side `data-loader.ts` no longer passes symbol lists to service calls — server knows what to fetch.
4. Admin PUT endpoint clears relevant Redis cache keys on save so changes take effect immediately.
5. `YAHOO_ONLY_SYMBOLS` set in `_shared.ts` becomes dynamic — derived from the current symbol list (any symbol starting with `^` or containing `=` is Yahoo-only).

### 6. Data Sources by Category

| Category | API | Symbol format | Example |
|---|---|---|---|
| stock | Finnhub + Yahoo Finance | Ticker | `AAPL`, `MSFT` |
| stock (index) | Yahoo Finance | `^` prefix | `^GSPC`, `^DJI` |
| commodity | Yahoo Finance | Futures suffix | `GC=F`, `CL=F` |
| crypto | CoinGecko | Coin ID | `bitcoin`, `ethereum` |
| sector | Finnhub + Yahoo Finance | ETF ticker | `XLK`, `XLF` |

### 7. Migration Seed Data

The migration inserts all 50 current hardcoded symbols:
- 28 stocks/indices from `MARKET_SYMBOLS`
- 6 commodities from `COMMODITIES`
- 4 cryptos from `CRYPTO_IDS` + `CRYPTO_MAP`
- 12 sectors from `SECTORS`

Each with `enabled = true` and `sort_order` matching current array index.

## Files Affected

| File | Change |
|---|---|
| `supabase/migrations/NNNN_create_market_symbols.sql` | New: table, RPCs, seed data |
| `api/admin/market-symbols.ts` | New: GET/PUT endpoint |
| `api/admin/validate-symbol.ts` | New: POST validation endpoint |
| `src/admin/pages/market-symbols.ts` | New: admin UI page |
| `src/admin/dashboard.ts` | Add nav item + route |
| `server/worldmonitor/market/v1/list-market-quotes.ts` | Read symbols from DB |
| `server/worldmonitor/market/v1/list-crypto-quotes.ts` | Read symbols from DB |
| `server/worldmonitor/market/v1/list-commodity-quotes.ts` | Read symbols from DB |
| `server/worldmonitor/market/v1/get-sector-summary.ts` | Read symbols from DB |
| `server/worldmonitor/market/v1/_shared.ts` | Dynamic YAHOO_ONLY_SYMBOLS, remove hardcoded CRYPTO_META |
| `src/app/data-loader.ts` | Remove symbol list arguments |
| `src/config/markets.ts` | Keep as fallback, add "fallback" comments |

## Non-Goals

- Per-user watchlists (admin-only for now)
- Real-time symbol search/autocomplete (admin types the symbol directly)
- Historical data or charting for individual symbols
