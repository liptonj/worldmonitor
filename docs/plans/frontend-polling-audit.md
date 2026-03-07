# Frontend Polling Audit

> **Purpose:** Audit current polling patterns for the Frontend Relay Migration. Identifies what has been migrated to WebSocket push vs what still uses polling.

**Audit Date:** 2026-03-07  
**Plan Reference:** [2026-03-07-frontend-relay-migration.md](./2026-03-07-frontend-relay-migration.md)

---

## Executive Summary

**Finding:** `src/app/data-loader.ts` contains **zero** `scheduleRefresh` or `registerDeferred` calls. The migration from per-channel polling to relay WebSocket push has already been completed for the data-loader orchestration layer.

- **RefreshScheduler** is exported from `src/app/refresh-scheduler.ts` but is **not instantiated or used** in `App.ts`.
- All dashboard data channels receive updates via `subscribeRelayPush()` in `App.ts` (WebSocket push).
- Remaining polling is limited to: OREF (relay channel with legacy fallback), AIS maritime (relay-proxied), and UI-only intervals.

---

## 1. scheduleRefresh / registerDeferred in data-loader.ts

**Search result:** No matches.

```bash
grep -n "scheduleRefresh\|registerDeferred" src/app/data-loader.ts
# (empty)
```

The plan assumed these calls existed; they have been removed. Data flow is now:

1. **Bootstrap** — initial data on page load
2. **WebSocket push** — real-time updates via `relay-push.ts`
3. **loadDataForLayer** — user-triggered one-time fetches when toggling map layers

---

## 2. Relay Channels (Migrated to WebSocket Push)

All of the following channels are subscribed in `App.ts` via `subscribeRelayPush()` and receive data via WebSocket. **No polling** for these.

| Channel | Handler | Source |
|---------|---------|--------|
| `news:{variant}` | `applyNewsDigest` | relay |
| `markets` | `applyMarkets` | relay |
| `predictions` | `applyPredictions` | relay (polymarket) |
| `fred` | `applyFredData` | relay |
| `oil` | `applyOilData` | relay |
| `bis` | `applyBisData` | relay |
| `intelligence` | `applyIntelligence` | relay |
| `pizzint` | `applyPizzInt` | relay |
| `trade` | `applyTradePolicy` | relay |
| `supply-chain` | `applySupplyChain` | relay |
| `natural` | `applyNatural` | relay |
| `climate` | `applyClimate` | relay |
| `conflict` | `applyConflict` | relay |
| `ucdp-events` | `applyUcdpEvents` | relay |
| `cyber` | `applyCyberThreats` | relay |
| `cables` | `applyCableHealth` | relay |
| `flights` | `applyFlightDelays` | relay |
| `ais` | `applyAisSignals` | relay |
| `weather` | `applyWeatherAlerts` | relay |
| `spending` | `applySpending` | relay |
| `giving` | `applyGiving` | relay |
| `telegram` | `applyTelegramIntel` | relay |
| `oref` | `applyOref` | relay |
| `iran-events` | `applyIranEvents` | relay |
| `tech-events` | `applyTechEvents` | relay |
| `gulf-quotes` | `applyGulfQuotes` | relay |
| `gps-interference` | `applyGpsInterference` | relay |
| `eonet` | `applyEonet` | relay |
| `gdacs` | `applyGdacs` | relay |
| `strategic-posture` | panel `applyPush` | relay |
| `strategic-risk` | panel `applyPush` | relay |
| `stablecoins` | panel `applyPush` | relay |
| `etf-flows` | panel `applyPush` | relay |
| `macro-signals` | panel `applyPush` | relay |
| `service-status` | panel `applyPush` | relay |
| `config:news-sources` | `applyNewsSources` | relay |
| `config:feature-flags` | `applyFeatureFlags` | relay |
| `ai:intel-digest` | digest panel | relay |
| `ai:panel-summary` | state + event | relay |
| `ai:article-summaries` | state + event | relay |
| `ai:classifications` | state + event | relay |
| `ai:country-briefs` | state | relay |
| `ai:posture-analysis` | strategic-posture panel | relay |
| `ai:instability-analysis` | strategic-risk panel | relay |
| `ai:risk-overview` | strategic-risk panel | relay |

**Plan’s relay channel list (for reference):** aviation, markets, gdelt, oref, polymarket, earthquakes, fires, cyber, climate, protests, cables, gps-jamming, advisories, telegram.

**Mapping to current implementation:**
- `aviation` → `flights` (flight delays)
- `markets` → `markets`
- `gdelt` → part of `intelligence` / conflict
- `oref` → `oref`
- `polymarket` → `predictions`
- `earthquakes` → `natural` (eonet/gdacs)
- `fires` → `natural` (eonet)
- `cyber` → `cyber`
- `climate` → `climate`
- `protests` → `conflict` / `ucdp-events`
- `cables` → `cables`
- `gps-jamming` → `gps-interference`
- `advisories` → relay `advisories` channel (if present) or RSS via relay proxy
- `telegram` → `telegram`

---

## 3. Remaining Polling (Non-Relay or Legacy Fallback)

### 3.1 OREF Alerts — Relay Channel with Legacy Polling Fallback

| Location | Line | Interval | Notes |
|----------|------|----------|-------|
| `src/services/oref-alerts.ts` | 295–300 | 120s | `startOrefPolling()` uses `setInterval` |

**Trigger:** `data-loader.ts` line 1087 — called when `loadIntelligenceSignals()` runs (user enables ucdpEvents, displacement, climate, or gpsJamming layer).

**Status:** Relay push subscribes to `oref` in `App.ts`. OREF polling is a **legacy fallback** when relay push is unavailable or as backup. Plan Task 7 targets removing this.

### 3.2 AIS Maritime Snapshot Polling

| Location | Line | Interval | Notes |
|----------|------|----------|-------|
| `src/services/maritime/index.ts` | 339–345 | 5 min | `pollSnapshot()` via `setInterval` |

**Trigger:** `initAisStream()` when AIS layer is enabled.

**Status:** Fetches via relay proxy. **Keep polling** — AIS is a specialized stream; relay may not push full snapshot. Document as non-relay-style polling that stays.

### 3.3 Relay Push Fallback (When WebSocket Unconfigured)

| Location | Line | Notes |
|----------|------|-------|
| `src/services/relay-push.ts` | 167 | Console: "polling fallback active" when `VITE_WS_RELAY_URL` not set |

**Status:** No actual polling in relay-push; message indicates degraded mode. Bootstrap/panel fallbacks may be used instead.

---

## 4. Non-Polling Intervals (Keep As-Is)

These use `setInterval` for UI or housekeeping, not data fetching:

| Location | Purpose | Interval |
|----------|---------|----------|
| `src/app/event-handlers.ts` | Snapshot save | 15 min |
| `src/app/event-handlers.ts` | Header clock tick | 1 s |
| `src/app/desktop-updater.ts` | Update check | — |
| `src/main.ts` | (varies) | — |
| `src/services/relay-push.ts` | WebSocket heartbeat | — |
| `src/components/LiveNewsPanel.ts` | Mute sync | 500 ms |
| `src/components/WorldClockPanel.ts` | Clock tick | 1 s |
| `src/components/DeckGLMap.ts` | Day/night, news pulse | — |
| `src/components/Map.ts` | Health check | 30 s |
| `src/components/StrategicPosturePanel.ts` | Loading elapsed | — |
| `src/components/SummarizeViewModal.ts` | Elapsed timer | — |
| `src/components/IntelligenceGapBadge.ts` | Badge refresh | — |
| `src/components/SecurityAdvisoriesPanel.ts` | Panel refresh | — |
| `src/services/military-vessels.ts` | History cleanup | — |
| `src/services/military-flights.ts` | Flight history cleanup | — |
| `src/services/tv-mode.ts` | Panel rotation | — |

---

## 5. On-Demand Loads (No Polling)

`loadDataForLayer()` triggers one-time fetches when the user enables a map layer. No `scheduleRefresh`; data comes from relay services or relay-proxied endpoints:

| Layer | Load Method | Data Source |
|-------|-------------|-------------|
| `natural` | `loadNatural()` | relay push / eonet, gdacs |
| `fires` | `loadFirmsData()` | relay |
| `weather` | `loadWeatherAlerts()` | relay |
| `outages` | `loadOutages()` | relay |
| `cyberThreats` | `loadCyberThreats()` | relay |
| `ais` | `loadAisSignals()` | relay + maritime polling |
| `cables` | `loadCableActivity()`, `loadCableHealth()` | relay |
| `protests` | `loadProtests()` | relay |
| `flights` | `loadFlightDelays()` | relay |
| `military` | `loadMilitary()` | relay |
| `techEvents` | `loadTechEvents()` | relay |
| `positiveEvents` | `loadPositiveEvents()` | relay |
| `kindness` | `loadKindnessData()` | — |
| `iranAttacks` | `loadIranEvents()` | relay |
| `ucdpEvents`, `displacement`, `climate`, `gpsJamming` | `loadIntelligenceSignals()` | relay + OREF polling |

---

## 6. RefreshScheduler Status

| Item | Status |
|------|--------|
| **Definition** | `src/app/refresh-scheduler.ts` — `scheduleRefresh`, `registerAll`, `registerDeferred` |
| **Export** | `src/app/index.ts` exports `RefreshScheduler` |
| **Usage in App.ts** | **None** — not imported or instantiated |
| **Usage in data-loader.ts** | **None** — no `ctx.refreshScheduler` |

Tests enforce:
- `App.ts` must not import `RefreshScheduler`
- `App.ts` must not call `scheduleRefresh`
- `data-loader.ts` must not contain `fetch()` (data via relay)

---

## 7. Recommendations

1. **Task 1 complete:** Audit confirms no `scheduleRefresh`/`registerDeferred` in data-loader. Migration for orchestration is done.
2. **OREf:** Plan Task 7 — remove `startOrefPolling` once relay push for `oref` is verified in production.
3. **AIS maritime:** Keep 5-min polling; document as non-relay pattern.
4. **RefreshScheduler:** Consider removing or deprecating if no future use; currently dead code.
5. **Security advisories / Telegram:** Confirm whether relay exposes `advisories` and `telegram` channels; if so, prefer push over `loadSecurityAdvisories`/`loadTelegramIntel` fetches.

---

## 8. Verification Commands

```bash
# Confirm no scheduleRefresh/registerDeferred in data-loader
grep -n "scheduleRefresh\|registerDeferred" src/app/data-loader.ts
# (empty)

# Confirm RefreshScheduler not used in App
grep -n "RefreshScheduler\|refreshScheduler" src/App.ts
# (empty)

# List relay subscriptions
grep -n "subscribeRelayPush" src/App.ts
```
