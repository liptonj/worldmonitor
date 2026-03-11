# Yahoo Finance Replacement — Design Document

**Date:** 2026-03-11
**Status:** Approved

## Problem

Yahoo Finance API is aggressively rate-limiting our worker (HTTP 429). The system makes ~80 individual Yahoo requests every 10-minute window across 4 channels, each with independent rate-limit gates that allow concurrent flooding.

## Decision

Maximize Finnhub (already integrated, 60 calls/min free) and CoinGecko (already integrated) to eliminate most Yahoo calls. Keep Yahoo only for commodities and Gulf quotes where no free alternative covers the symbols.

## Provider Assignment

| Data | Current | New Provider | Endpoint |
|---|---|---|---|
| US stocks (25) | Finnhub + Yahoo fallback | Finnhub only | `/quote` |
| US indices (3) | Yahoo (^GSPC, ^DJI, ^IXIC) | Finnhub via ETF proxies (SPY, DIA, QQQ) | `/quote` |
| Sector ETFs (12) | Finnhub + Yahoo fallback | Finnhub only | `/quote` |
| BTC spot ETFs (10) | Yahoo | Finnhub | `/stock/candle` (5-day daily) |
| Macro: QQQ, XLP history | Yahoo (1yr candles) | Finnhub | `/stock/candle` (1yr daily) |
| Macro: JPY=X history | Yahoo (1yr candles) | Finnhub | `/forex/candle` (`OANDA:USD_JPY`, 1yr daily) |
| Macro: BTC-USD history | Yahoo (1yr candles) | CoinGecko | `/coins/bitcoin/market_chart` (365 days) |
| Commodities (6) | Yahoo | Yahoo (keep) | `/v8/finance/chart` |
| Gulf quotes (14) | Yahoo | Yahoo (keep) | `/v8/finance/chart` |

**Net result:** Yahoo calls drop from ~80/10min to ~20/10min.

## Shared Yahoo Rate Limiter

Create `services/shared/yahoo-gate.cjs` — single global gate shared by all channels. Gap increases from 350ms to 500ms. All channels import from this module instead of declaring independent gates.

## Index Symbol Mapping

Map indices to ETF proxies in code (not Supabase):

```
^GSPC → SPY, ^DJI → DIA, ^IXIC → QQQ
```

Fetch using proxy ticker, return data with original symbol and display name. Frontend sees no change. Percent changes are identical.

## Error Handling

- Finnhub returns no data: log warning, do not fall back to Yahoo (prevents accidental flood)
- Finnhub API key missing: markets channel degrades to Yahoo-only mode (existing behavior)
- CoinGecko BTC failure: macro signal degrades to `UNKNOWN` status (existing pattern)
- Finnhub candle `s: "no_data"` response: treat as empty, log warning

## Files Changed

| File | Action |
|---|---|
| `services/shared/yahoo-gate.cjs` | Create — shared rate limiter |
| `services/shared/channels/markets.cjs` | Modify — Finnhub proxies, drop Yahoo sector fallback |
| `services/shared/channels/macro-signals.cjs` | Modify — Finnhub candles + CoinGecko, eliminate Yahoo |
| `services/shared/channels/etf-flows.cjs` | Modify — Finnhub candles, eliminate Yahoo |
| `services/shared/channels/gulf-quotes.cjs` | Modify — import shared Yahoo gate |

No Supabase migrations. No frontend changes. No new API keys.
