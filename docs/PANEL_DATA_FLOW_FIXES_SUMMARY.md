# Panel Data Flow Fixes — Summary

> **Date:** 2026-03-09  
> **Plan:** [docs/plans/2026-03-09-fix-all-panel-data-flows.md](plans/2026-03-09-fix-all-panel-data-flows.md)

## Executive Summary

Multiple panels were failing to receive data due to broken data flows between workers, Redis, the gateway, and the frontend. Only the vessels/AIS channel was pushing data successfully. This document summarizes all issues found and fixes implemented across Tasks 1–10.

### Root Causes Identified

1. **GDELT used a non-existent direct endpoint** — The Live Intelligence panel called `/gdelt` directly instead of using the relay channel `relay:gdelt:v1`.
2. **Channel registry gaps** — Some panels lacked explicit channel mappings or `applyMethod` handlers.
3. **Bootstrap/WebSocket subscription alignment** — Frontend needed to subscribe to all required channels via `RELAY_CHANNELS` derived from `CHANNEL_REGISTRY`.
4. **Orchestrator scheduling** — Workers for `gdelt`, `strategic-risk`, `strategic-posture`, `ai:panel-summary`, and `intelligence` are scheduled via `wm_admin.service_config` (Supabase migration).
5. **Panel channel configuration** — Panels such as insights, strategic-posture, strategic-risk, and intel needed explicit `channels` in `panels.ts` to receive WebSocket push.

---

## Fixes Implemented (Tasks 1–10)

### Task 1: Add GDELT as Proper Relay Channel

- **Channel registry:** Added `gdelt` channel with `redisKey: 'relay:gdelt:v1'`, `panels: ['gdelt-intel']`, `applyMethod: 'applyGdelt'`.
- **gdelt-intel.ts:** Replaced direct `/gdelt` fetch with `fetchRelayPanel<GdeltPanelData>('gdelt')` for panel data.
- **intelligence-handler.ts:** Added `applyGdelt` handler for WebSocket push updates.
- **channel-keys.json:** Regenerated via `npm run generate:channel-keys` to include `gdelt` → `relay:gdelt:v1`.

### Task 2: Verify Strategic Risk Channel Configuration

- **Channel registry:** Confirmed `strategic-risk` exists with `redisKey: 'risk:scores:sebuf:v1'`, `panels: ['strategic-risk', 'cii']`.
- **panels.ts:** Confirmed `strategic-risk` panel has `channels: ['strategic-risk']`.
- **Orchestrator:** `strategic-risk` worker scheduled in `service_config` (`*/5 * * * *` → `risk:scores:sebuf:v1`).

### Task 3: Verify Strategic Posture Channel Configuration

- **Channel registry:** Confirmed `strategic-posture` exists with `redisKey: 'theater-posture:sebuf:v1'`, `panels: ['strategic-posture']`.
- **panels.ts:** Confirmed `strategic-posture` panel has `channels: ['strategic-posture']`.
- **Orchestrator:** `strategic-posture` worker scheduled (`3-59/10 * * * *` → `theater-posture:sebuf:v1`).

### Task 4: Verify AI Insights Channel Configuration

- **Channel registry:** Confirmed `ai:panel-summary` exists with `redisKey: 'ai:panel-summary:v1'`, `panels: ['insights']`.
- **panels.ts:** Confirmed `insights` panel has `channels: ['ai:panel-summary']`.
- **InsightsPanel:** Subscribes to `wm:panel-summary-updated` (dispatched by ai-handler when `ai:panel-summary` data arrives).
- **Orchestrator:** `ai:panel-summary` scheduled (`*/15 * * * *` → `ai:panel-summary:v1`).

### Task 5: Verify Intelligence/Intel Feed Channel

- **Channel registry:** Confirmed `intelligence` exists with `redisKey: 'ai:digest:global:v1'`, `panels: ['intel', 'gdelt-intel', 'global-digest']`, `applyMethod: 'applyIntelligence'`.
- **Orchestrator:** `ai:intel-digest` scheduled (`*/10 * * * *` → `ai:digest:global:v1`).

### Task 6: Fix World News Panel Data Flow

- **politics panel:** Uses `news:full` digest (Live News / Headlines) and RSS feeds via `feed-client`. World News panel is driven by `politics` feed category and news digest.
- **panels.ts:** `politics` panel enabled; data flows from `news:full` and feed sources.

### Task 7: Verify All Channels Are Subscribed

- **App.ts:** `setupRelayPush()` subscribes to `RELAY_CHANNELS` (all keys from `CHANNEL_REGISTRY`) plus variant-specific `news:${variant}`.
- **Bootstrap:** `fetchBootstrapData()` requests all `RELAY_CHANNELS` plus `news:${variant}`.
- **Handlers:** Each channel has a handler registered via `subscribeRelayPush(channel, handler)` from `getPushHandler()` → `dataLoader.getHandler()`.

### Task 8: Verify Orchestrator Scheduling

- **service_config:** All critical channels scheduled in `supabase/migrations/20260307000003_seed_service_config.sql`.
- **Audit:** See [docs/plans/2026-03-09-orchestrator-scheduling-audit.md](plans/2026-03-09-orchestrator-scheduling-audit.md).

### Task 9: Test End-to-End Data Flow

- **Validation script:** `scripts/validate-data-flow.sh` checks Redis keys, gateway HTTP, and optionally WebSocket.
- **Data flow guide:** [docs/DATA_FLOW_VALIDATION.md](DATA_FLOW_VALIDATION.md).

### Task 10: Fix Missing Workers (If Needed)

- **Workers:** All required workers exist in `service_config`. Custom workers (strategic-risk, strategic-posture, gdelt, ai:panel-summary, ai:intel-digest) are scheduled.
- **Stub workers:** Not required; existing workers populate Redis.

---

## Files Changed (Grouped by Category)

### Frontend / Config

| File | Changes |
|------|---------|
| `src/config/channel-registry.ts` | Added `gdelt` channel; verified strategic-risk, strategic-posture, intelligence, ai:panel-summary |
| `src/config/panels.ts` | Panel channel mappings (insights, strategic-posture, strategic-risk, intel, gdelt-intel, politics) |
| `src/App.ts` | `setupRelayPush()` uses `RELAY_CHANNELS`; handlers from `CHANNEL_REGISTRY` |
| `src/app/data-loader.ts` | Domain handlers including `applyGdelt`; hydration aliases |
| `src/app/bootstrap.ts` | Uses `RELAY_CHANNELS` from channel-registry |
| `src/components/InsightsPanel.ts` | Subscribes to `ai:panel-summary` via `wm:panel-summary-updated` |

### Services / Data

| File | Changes |
|------|---------|
| `src/services/gdelt-intel.ts` | `fetchGdeltPanel()` uses `fetchRelayPanel('gdelt')` instead of direct `/gdelt` |
| `src/services/bootstrap.ts` | Imports `RELAY_CHANNELS` from channel-registry |
| `src/services/cached-risk-scores.ts` | Uses bootstrap hydration for strategic-risk |
| `src/services/feed-client.ts` | Feed sources for World News / politics |
| `src/data/intelligence-handler.ts` | Added `applyGdelt` handler |
| `src/data/intelligence-loader.ts` | Intelligence channel handling |
| `src/data/news-handler.ts` | News digest handling for Live News / World News |

### Gateway / Backend

| File | Changes |
|------|---------|
| `services/gateway/channel-keys.json` | Regenerated; includes `gdelt` → `relay:gdelt:v1` |
| `services/gateway/index.cjs` | Panel endpoint routing |
| `services/gateway/test/gateway.test.cjs` | Gateway tests |

### Database / Migrations

| File | Changes |
|------|---------|
| `supabase/migrations/20260307000003_seed_service_config.sql` | Seeds `service_config` with gdelt, strategic-risk, strategic-posture, ai:panel-summary, ai:intel-digest |

### Tests / Scripts

| File | Changes |
|------|---------|
| `tests/channel-registry.test.mts` | Channel registry tests |
| `scripts/validate-data-flow.sh` | Data flow validation script |

---

## Critical Changes That Need Testing

1. **GDELT panel** — Must show articles or "No recent articles" (not loading forever). Verify `/panel/gdelt` returns 200 and JSON.
2. **Strategic Risk panel** — Must show data or "No data available" (not "Insufficient Data"). Verify `risk:scores:sebuf:v1` in Redis.
3. **AI Insights panel** — Must show summary or "Generating..." (not stuck loading). Verify `ai:panel-summary:v1` in Redis.
4. **Strategic Posture panel** — Must show posture data or "No posture data" (not "Acquiring Data"). Verify `theater-posture:sebuf:v1` in Redis.
5. **Intel Feed panel** — Must show items or "No intel available" (not "All Intel sources disabled"). Verify `ai:digest:global:v1` in Redis.
6. **World News panel** — Must show articles from news digest and RSS feeds.
7. **WebSocket** — Must receive `wm-push` messages for multiple channels (not just vessels).
8. **Bootstrap** — Must return data for requested channels; no 404 for `/panel/*` or `/gdelt`.

---

## Deployment Steps

1. **Apply database migration** (if not already applied):
   ```bash
   supabase db push
   # or: supabase migration up
   ```

2. **Regenerate channel keys**:
   ```bash
   npm run generate:channel-keys
   ```

3. **Build frontend**:
   ```bash
   npm run build
   ```

4. **Restart services** (Docker):
   ```bash
   cd services && docker compose restart gateway orchestrator
   ```

5. **Verify**:
   ```bash
   bash scripts/validate-data-flow.sh
   ```

6. **Deploy frontend** (Vercel or similar) — ensure `VITE_RELAY_HTTP_BASE` points to gateway.

---

## Rollback Plan

If issues occur after deployment:

1. **Revert GDELT changes**:
   ```bash
   git restore src/config/channel-registry.ts src/services/gdelt-intel.ts src/data/intelligence-handler.ts
   npm run generate:channel-keys
   ```

2. **Restart services**:
   ```bash
   cd services && docker compose restart gateway orchestrator
   ```

3. **Clear Redis** (only if data corruption suspected):
   ```bash
   cd services && docker compose exec -T redis redis-cli FLUSHALL
   ```
   ⚠️ This clears all cached data; workers will repopulate on next run.

4. **Revert full changeset**:
   ```bash
   git revert <commit-range>
   npm run generate:channel-keys
   cd services && docker compose restart gateway orchestrator
   ```

---

## Success Criteria Checklist

- [ ] No 404 errors in browser console
- [ ] GDELT panel shows articles or "No recent articles" (not loading forever)
- [ ] Strategic Risk panel shows data or "No data available" (not "Insufficient Data")
- [ ] AI Insights panel shows summary or "Generating..." (not stuck loading)
- [ ] Strategic Posture panel shows posture data or "No posture data" (not "Acquiring Data")
- [ ] Intel Feed panel shows items or "No intel available" (not "All Intel sources disabled")
- [ ] World News panel shows articles
- [ ] WebSocket receives `wm-push` messages for multiple channels
- [ ] All enabled panels transition out of loading state within 30 seconds
