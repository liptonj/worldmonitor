# Eliminate Frontend API Calls — Relay-Only Data Flow

**Date:** 2026-03-11
**Status:** Approved
**Approach:** Big bang (all changes in one pass)

## Problem

Three API endpoints are called directly from the frontend when all data should flow through the WebSocket relay cache:

| Endpoint | Direction | Problem |
|---|---|---|
| `POST /api/news/v1/summarize-article` | Frontend → Server (LLM call) | AI engine already pre-computes summaries via `ai:article-summaries` channel |
| `POST /api/infrastructure/v1/record-baseline-snapshot` | Frontend → Server (write) | Workers already have item counts — frontend shouldn't report metrics back |
| `GET /api/infrastructure/v1/get-temporal-baseline` | Frontend ← Server (read) | Should be computed server-side and pushed via relay |

## Part 1: Article Summaries — Complete Relay-Native Migration

### Current State

The relay path already works end-to-end:
- `ai-engine/generators/article-summaries.cjs` reads news from Redis, calls LLM, produces `{ [fnv1aHash(title)]: { text, title, generatedAt } }`
- Worker runner stores in Redis (`ai:article-summaries:v1`) and broadcasts via gRPC
- Gateway pushes `wm-push` on `ai:article-summaries` channel
- `ai-handler.ts` stores payload in `window.__wmArticleSummaries` and fires `wm:article-summaries-updated` CustomEvent
- `lookupRelaySummary()` in `summarization.ts` checks this cache first

**Problem:** On cache miss, `generateSummary()` falls through to direct API calls (Ollama → Groq → OpenRouter → Browser T5). No component listens to `wm:article-summaries-updated`, so panels never auto-update when new summaries arrive.

### Changes

#### 1. `src/services/summarization.ts` — Remove API fallback

- `generateSummary()` calls `lookupRelaySummary()` only
- On cache miss, return `{ summary: '', provider: 'pending', model: 'relay', cached: false }` (empty summary signals "pending" to callers)
- Remove: `tryApiProvider()`, `runApiChain()`, `tryBrowserT5()`, `generateSummaryInternal()`, `NewsServiceClient` import, circuit breaker, provider definitions, `API_PROVIDERS` array
- Keep: `lookupRelaySummary()`, `fnv1aHash()`, `SummarizationResult` type, `SummarizationProvider` type (add `'pending'`)
- Keep: `translateText()` — still needs API for on-demand translation (different use case from pre-computed summaries)

#### 2. Panels auto-update on `wm:article-summaries-updated`

- **`NewsPanel.ts`**: If summary container shows "pending" state, listen for `wm:article-summaries-updated`, re-run `lookupRelaySummary()`, and update
- **`GoodThingsDigestPanel.ts`**: Re-check relay cache for cards with pending summaries on event
- **`InsightsPanel.ts`**: Re-check relay cache if brief was pending
- **`trending-keywords.ts`**: No change (spike signals are ephemeral, summary is optional)

#### 3. AI engine coverage

- `article-summaries.cjs`: Increase `MAX_ARTICLES` from 10 to 25 to reduce cache miss rate

## Part 2: Temporal Anomalies — New Relay Channel

### Current State

No relay channel exists. Frontend calls `updateAndCheck()` (HTTP round-trips) from 5 data handlers after receiving WebSocket data. Server handlers are already marked `@deprecated`.

### Changes

#### 1. New channel: `services/shared/channels/temporal-anomalies.cjs`

- Reads item counts from Redis keys:
  - `news:digest:v1:full:en` → news count
  - `relay:flights:v1` → military flight count
  - `relay:opensky:v1` → vessel count
  - `relay:cyber:v1` → cyber threat count
  - `relay:climate:v1` → satellite fire count
- Welford's online algorithm (ported from `server/worldmonitor/infrastructure/v1/_shared.ts`) for baseline maintenance
- Stores baselines in Redis: `baseline:{type}:{region}:{weekday}:{month}` (same key pattern)
- Computes z-scores and returns anomaly alerts
- Output: `{ anomalies: [{ type, region, currentCount, expectedCount, zScore, severity, message }] }`

#### 2. Register the channel

- `services/shared/channels/index.cjs`: Add `'temporal-anomalies': require('./temporal-anomalies.cjs')`
- `services/gateway/channel-keys.json`: Add `"temporal-anomalies": "relay:temporal-anomalies:v1"`
- Supabase migration: Add cron schedule (every 5 minutes) to `wm_admin.service_config`

#### 3. Frontend handler

- Add `'temporal-anomalies'` handler (in `ai-handler.ts` or new `temporal-handler.ts`):
  - Parse anomalies from payload
  - Call `signalAggregator.ingestTemporalAnomalies(anomalies)`
  - Call `ingestTemporalAnomaliesForCII(anomalies)`
  - Refresh CII panel

#### 4. Delete frontend temporal baseline code

- Delete `src/services/temporal-baseline.ts`
- Remove `updateAndCheck()` calls from:
  - `src/data/news-handler.ts`
  - `src/data/news-loader.ts`
  - `src/data/infrastructure-handler.ts`
  - `src/data/intelligence-loader.ts`
  - `src/data/geo-handler.ts`
- Remove associated imports (`updateAndCheck`, `InfrastructureServiceClient`, etc.)

## Part 3: Cleanup

- Remove from `RPC_CACHE_TIER` in `server/gateway.ts`:
  - `'/api/infrastructure/v1/get-temporal-baseline'`
  - `'/api/news/v1/summarize-article-cache'` (only if `translateText` no longer uses it)
- Server-side handlers remain as-is (already marked `@deprecated`, kept for rollback)
- Remove unused type exports from `temporal-baseline.ts` consumers

## Data Flow After Migration

```
BEFORE (3 HTTP round-trips per data push):
  Worker → Redis → Gateway → WebSocket → Frontend (data arrives)
  Frontend → HTTP POST record-baseline-snapshot → Server → Redis (report metrics)
  Frontend → HTTP GET get-temporal-baseline → Server → Redis → Frontend (check anomaly)
  Frontend → HTTP POST summarize-article → Server → LLM API → Frontend (get summary)

AFTER (zero HTTP calls):
  Worker → Redis → Gateway → WebSocket → Frontend (data)
  temporal-anomalies worker → Redis (baselines + anomalies) → Gateway → WebSocket → Frontend
  article-summaries AI engine → Redis (summaries) → Gateway → WebSocket → Frontend
```

## Files Changed

### New Files
- `services/shared/channels/temporal-anomalies.cjs`
- `supabase/migrations/XXXXXXXX_temporal_anomalies_channel.sql`

### Modified Files
- `src/services/summarization.ts` — gut API fallback, keep relay cache lookup
- `src/components/NewsPanel.ts` — listen for `wm:article-summaries-updated`
- `src/components/GoodThingsDigestPanel.ts` — listen for `wm:article-summaries-updated`
- `src/components/InsightsPanel.ts` — listen for `wm:article-summaries-updated`
- `src/data/news-handler.ts` — remove `updateAndCheck()` call
- `src/data/news-loader.ts` — remove `updateAndCheck()` call
- `src/data/infrastructure-handler.ts` — remove `updateAndCheck()` call
- `src/data/intelligence-loader.ts` — remove `updateAndCheck()` call
- `src/data/geo-handler.ts` — remove `updateAndCheck()` call
- `src/data/ai-handler.ts` — add `temporal-anomalies` handler
- `services/shared/channels/index.cjs` — register new channel
- `services/gateway/channel-keys.json` — add channel key
- `services/ai-engine/generators/article-summaries.cjs` — increase MAX_ARTICLES
- `server/gateway.ts` — remove deprecated entries from RPC_CACHE_TIER

### Deleted Files
- `src/services/temporal-baseline.ts`

## Verification

- `npm run typecheck` passes
- No `record-baseline-snapshot`, `get-temporal-baseline`, or `summarize-article` calls from frontend (grep verification)
- `temporal-anomalies` channel pushes data via WebSocket
- Article summaries auto-update on panels when relay push arrives
- Signal aggregator and CII panel still receive temporal anomaly data
