# End-to-End Verification: Panel Hydration Audit Fixes

**Date:** 2026-03-09  
**Plan:** [2026-03-09-panel-hydration-audit.md](./plans/2026-03-09-panel-hydration-audit.md)

## Summary

Verification of Tasks 1–6 from the panel hydration audit plan. All structural fixes compile, tests pass, and the bootstrap drain path is wired correctly.

---

## Build Status

| Check | Result |
|-------|--------|
| `npm run build` | **PASS** |
| `npm run test:data` | **PASS** |

---

## Fixes Verified (Tasks 1–6)

| Task | Fix | Verification |
|------|-----|--------------|
| 1 | 11 hydration key aliases (kebab→camelCase) | `HYDRATION_ALIASES` in data-loader.ts |
| 2 | `loadAllData()` drains bootstrap cache through handlers | Iterates `CHANNEL_REGISTRY`, calls handlers with hydrated data |
| 3 | `loadAllData()` called after bootstrap in `App.init()` | `relay-push-wiring.test.mjs` asserts `void this.dataLoader.loadAllData()` |
| 4 | GDELT handler calls panel refresh | `intelligence-handler.ts` gdelt handler calls `gdeltIntelPanel?.refresh?.()` |
| 5 | CII timeout fallback (10s) | `CIIPanel.ts` has `setTimeout` calling `refresh(true)` |
| 5b | GlobalDigestPanel instantiated | `panel-layout.ts` creates `GlobalDigestPanel` |
| 5c | Commodities/crypto channel mapping | `panels.ts`: commodities/crypto use `['markets']`; `channel-registry.ts`: markets includes commodities, crypto |
| 6 | channelKeys on 25 panels | All relay-dependent panels declare `channelKeys` |

---

## Panel Hydration Status

### Category A: Working (self-loading or bootstrap)

| Panel | Mechanism |
|-------|-----------|
| Live News | IntersectionObserver, news channels |
| Headlines | `loadNews()` → digest → `renderItems()` |
| World Clock | Static |
| Monitors | localStorage |
| Security Advisories | Self-loading RSS |

### Category B: Bootstrap drain (Tasks 1–3)

These panels receive data via `loadAllData()` draining bootstrap cache through domain handlers:

| Panel | Channel(s) | Handler |
|-------|------------|---------|
| Markets | `markets` | `applyMarkets` |
| Commodities | `markets` | `renderCommodities` via markets handler |
| Crypto | `markets` | `renderCrypto` via markets handler |
| Predictions | `predictions` | `applyPredictions` |
| Strategic Posture | `strategic-posture` | `forwardToPanel` |
| Strategic Risk | `strategic-risk` | `forwardToPanel` |
| Telegram Intel | `telegram` | `setData` |
| Stablecoins | `stablecoins` | `forwardToPanel` |
| Gulf Economies | `gulf-quotes` | `setData` |
| ETF Flows | `etf-flows` | `forwardToPanel` |
| Macro Signals | `macro-signals` | `forwardToPanel` |
| Trade Policy | `trade` | `updateRestrictions` |
| Supply Chain | `supply-chain` | `updateShippingRates` |
| OREF Sirens | `oref` | `setData` |
| UCDP Events | `ucdp-events` | `setEvents` |
| Climate | `climate` | `setAnomalies` |
| Giving | `giving` | `setData` |

### Category C/D: Handler or dependency fixes

| Panel | Fix |
|-------|-----|
| GDELT Intel | Handler calls `refresh()` (Task 4) |
| CII | 10s timeout fallback (Task 5) |
| Global Digest | Panel instantiated (Task 5b) |

### Category E: Backend-dependent (Redis/workers)

These panels need Redis data from workers; frontend cannot fix if backend is empty:

- AI Insights (`ai:panel-summary`)
- Strategic Posture/Risk (if workers not scheduled)
- AI channels (`ai:*`)

---

## Manual Verification Steps

1. **Run app with services:**
   ```bash
   cd services && docker-compose up -d
   npm run dev
   ```

2. **Check console for drain logs (with debug logging):**
   - Expect: `[DataLoader] draining "markets": data=true, handler=true` for channels with Redis data
   - Channels without data: `data=false, handler=true` (or `handler=false` if no handler)

3. **Panel behavior:**
   - With Redis data: panels show content within ~5 seconds
   - Without Redis data: panels show "Service unavailable" after 30 seconds (timeout)
   - Stale data: "stale" badge when data exceeds `staleAfterMs`

4. **CII:** Renders within ~15 seconds even without `focal-points-ready` (10s timeout fallback)

5. **GDELT Intel:** Refreshes when relay push arrives (handler calls `refresh()`)

---

## Success Criteria (from plan)

| Criterion | Status |
|-----------|--------|
| Category B panels show data within 5s (when Redis has data) | **Structural fix in place** — manual verification depends on Redis |
| Panels show "Service unavailable" after 30s (when Redis empty) | **Structural fix in place** — channel state machine + `channelKeys` |
| CII renders within 15s without focal-points-ready | **Fix in place** — 10s timeout fallback |
| GDELT Intel refreshes on relay push | **Fix in place** — handler calls `refresh()` |
| Console shows drain logs for channels with data | **Structural fix in place** — `loadAllData` iterates and drains |
| No "Loading..." spinners > 30s | **Structural fix in place** — timeout detection in channel state |

---

## Issues Discovered

- None during build or automated tests.
- Manual verification requires running app with `services` (Redis, gateway, workers) to confirm end-to-end behavior.

---

## Conclusion

All Tasks 1–6 fixes are implemented and verified by build and tests. The bootstrap drain path (`loadAllData` → handlers → panels) is wired correctly. Panels declare `channelKeys` for state machine badges. Success criteria are structurally satisfied; full end-to-end confirmation depends on manual testing with services running and Redis populated.
