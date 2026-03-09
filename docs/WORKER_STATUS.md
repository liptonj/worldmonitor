# Worker Status

> Generated for Task 10 of [Fix All Panel Data Flows](plans/2026-03-09-fix-all-panel-data-flows.md).  
> Last updated: 2026-03-09

This document lists all channels from `src/config/channel-registry.ts` and their worker implementation status in `services/shared/channels/`.

## Summary

| Status | Count |
|--------|-------|
| ✅ Implemented | 42 |
| ⚠️ Stub/placeholder | 1 |
| ❌ Missing (need implementation) | 0 |

---

## ✅ Implemented Workers

Channels with worker files that fetch real data (or use separate services / AI engine).

| Channel | Worker File | Panels | Notes |
|---------|-------------|--------|-------|
| markets | `markets.cjs` | markets, heatmap | Finnhub API |
| predictions | `predictions.cjs` | polymarket | Polymarket Gamma API |
| fred | `fred.cjs` | commodities, economic | FRED API |
| oil | `oil.cjs` | commodities | Oil price APIs |
| bis | `bis.cjs` | commodities, economic | BIS policy rates |
| flights | `flights.cjs` | map | Flight delay anomalies |
| weather | `weather.cjs` | map | NWS severe weather |
| natural | `natural.cjs` | map | NASA FIRMS |
| eonet | `eonet.cjs` | map | NASA EONET |
| gdacs | `gdacs.cjs` | map | GDACS disaster alerts |
| gps-interference | `gps-interference.cjs` | map | GPS spoofing detection |
| cables | `cables.cjs` | cascade, map | Undersea cable monitoring |
| cyber | `cyber.cjs` | cascade, map | Feodo + URLhaus |
| climate | `climate.cjs` | climate, map | NOAA NCEI |
| conflict | `conflict.cjs` | cii, intel, map | ACLED conflict events |
| ucdp-events | `ucdp-events.cjs` | ucdp-events, map | Uppsala Conflict Data |
| oref | `oref.cjs` | oref-sirens, map | Israel OREF sirens |
| gdelt | `gdelt.cjs` | gdelt-intel | GDELT event data |
| trade | `trade.cjs` | commodities, trade-policy | Trade indicators |
| supply-chain | `supply-chain.cjs` | commodities, supply-chain, cascade | Chokepoint indicators |
| spending | `spending.cjs` | map | USAspending.gov |
| gulf-quotes | `gulf-quotes.cjs` | gulf-economies | Yahoo Finance Gulf |
| tech-events | `tech-events.cjs` | events | Techmeme ICS + RSS |
| strategic-posture | `strategic-posture.cjs` | strategic-posture | OpenSky theater posture |
| strategic-risk | `strategic-risk.cjs` | strategic-risk, cii | ACLED + composite scoring |
| stablecoins | `stablecoins.cjs` | stablecoins | Stablecoin market cap |
| etf-flows | `etf-flows.cjs` | etf-flows | Bitcoin spot ETFs |
| macro-signals | `macro-signals.cjs` | macro-signals | Macro economic signals |
| service-status | `service-status.cjs` | service-status | Service health |
| config:news-sources | `config-news-sources.cjs` | — | News source config |
| config:feature-flags | `config-feature-flags.cjs` | — | Feature flags |
| iran-events | `iran-events.cjs` | map | Redis read (seed script) |
| news:full | `news-full.cjs` | live-news, headlines | Full news digest |
| news:tech | `news-tech.cjs` | live-news, headlines | Tech news digest |
| news:finance | `news-finance.cjs` | live-news, headlines | Finance news digest |
| news:happy | `news-happy.cjs` | live-news, headlines | Happy news digest |
| pizzint | `pizzint.cjs` | intel | PIZZINT intelligence |
| ais | — | map | **Separate service:** `ais-processor` (WebSocket → Redis) |
| telegram | — | telegram-intel, intel | **Separate service:** `ingest-telegram` (persistent session) |
| intelligence | — | intel, gdelt-intel, global-digest | **AI engine:** `ai:digest:global:v1` |
| ai:intel-digest | — | global-digest | **AI engine** |
| ai:panel-summary | — | insights | **AI engine** |
| ai:article-summaries | — | — | **AI engine** |
| ai:classifications | — | — | **AI engine** |
| ai:country-briefs | — | cii | **AI engine** |
| ai:posture-analysis | — | strategic-posture | **AI engine** |
| ai:instability-analysis | — | strategic-risk | **AI engine** |
| ai:risk-overview | — | strategic-risk | **AI engine** |

---

## ⚠️ Workers Returning Stub/Placeholder Data

| Channel | Worker File | Panels | Notes |
|---------|-------------|--------|-------|
| giving | `giving.cjs` | giving | Returns `{ data: [], status: 'stub' }`. TODO: extract from `scripts/ais-relay.cjs` |

---

## ❌ Missing Workers (Need Implementation)

Channels in `channel-registry.ts` with **no worker file** in `services/shared/channels/` and no equivalent separate service or AI engine.

| Channel | Redis Key | Panels | Priority | Suggested Approach |
|---------|-----------|--------|----------|---------------------|
| *(none)* | — | — | — | All registry channels have either a worker, separate service, or AI engine. |

**Note:** `ais` and `telegram` do not have worker files in `shared/channels/` but are implemented as separate Docker services (`ais-processor`, `ingest-telegram`). They are listed under ✅ Implemented.

---

## Stub Implementation Details

### giving

- **Panel:** Global Giving (happy variant)
- **Priority:** Low (giving panel is optional)
- **Current:** Returns empty array with `status: 'stub'`
- **Suggested approach:**
  1. Locate giving/donations logic in `scripts/ais-relay.cjs`
  2. Extract into `giving.cjs` with real API calls (e.g. charitable giving APIs, UN OCHA, etc.)
  3. Return `{ timestamp, source: 'giving', data: [...], status: 'success' }`
  4. Ensure orchestrator `service_config` has `giving` with `giving:summary:v1` (already seeded)

---

## Architecture Notes

- **Orchestrator workers:** Scheduled via `wm_admin.service_config` (Supabase). Worker service loads channel functions from `services/shared/channels/index.cjs`.
- **Separate services:** `ais-processor` and `ingest-telegram` run as standalone containers, publish to Redis, and broadcast via gRPC. They are not in `shared/channels/`.
- **AI engine:** Channels prefixed with `ai:` are routed to the AI engine gRPC service, not the worker.
- **Config channels:** `config:news-sources` and `config:feature-flags` have workers but no panels; they drive app configuration.
