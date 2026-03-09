# Panel Hydration Audit & Fix — Implementation Plan (v2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every enabled panel show data (or a clear error) within 30 seconds of page load. Identify every panel that is missing data today and fix it.

**Architecture:** Bootstrap HTTP → hydrationCache → domain handlers → panel render methods. WebSocket push for live updates after bootstrap.

**Tech Stack:** TypeScript (Vite frontend), vanilla DOM, Node.js CommonJS (gateway)

---

## Why Previous Attempts Failed

Previous plans focused on:
- Fixing WebSocket field name mismatches (`data` vs `payload`) — **Fixed**
- Adding envelope unwrapping to WebSocket path — **Fixed**
- Adding channel registry and channel state machine — **Done**
- Verifying channel wiring — **Done, all 45+ channels are wired**

What was NOT addressed:
1. Bootstrap data sits in cache but nothing reads it for most channels
2. Several handlers are stubs that don't render to panels
3. Complex dependency chains mean some panels can't render even with data
4. Some panels are self-loading but call APIs that may be unavailable
5. Panel `channelKeys` are not declared, so state machine badges don't work

---

## Panel-by-Panel Status

### Category A: Working (data arrives and renders)

These panels work today via self-loading or bootstrap consumption:

| Panel | Why it works |
|---|---|
| **Live News** | Self-loading via IntersectionObserver, news channels from config |
| **Headlines** | `loadNews()` in App.init() → processes digest → calls `renderItems()` |
| **World Clock** | Static, no data dependency |
| **Monitors** | localStorage, no server data |
| **Security Advisories** | Self-loading, RSS-based |

### Category B: Data in Redis, but frontend never reads it from bootstrap

These panels have data available in Redis (from workers) and the data arrives via bootstrap, but no code reads the bootstrap cache and passes it to the panel's render method.

| Panel | Channel | Hydration Key | Handler exists? | Handler renders panel? | What's missing |
|---|---|---|---|---|---|
| **Markets** | `markets` | `markets` | Yes | Yes (`renderMarkets()`) | Nothing calls handler with bootstrap data |
| **Commodities** | `fred`, `oil`, `bis` | `fred`, `oil`, `bis` | Yes | Yes (`renderCommodities()` via `markets` handler) | Markets handler needs the full dashboard payload, not individual channels |
| **Crypto** | `markets` | `markets` | Yes | Yes (part of markets handler) | Same as Markets |
| **Predictions** | `predictions` | `predictions` | Yes | Yes (`renderPredictions()`) | Nothing calls handler with bootstrap data |
| **Strategic Posture** | `strategic-posture` | **`strategicPosture`** | Yes (`forwardToPanel`) | Yes (`applyPush()`) | Hydration alias mismatch + no bootstrap drain |
| **Strategic Risk** | `strategic-risk` | **`strategicRisk`** | Yes (`forwardToPanel`) | Yes (`applyPush()`) | Self-loads via `refresh()` which calls `getCachedRiskScores()` → reads bootstrap ✓ but may fail if data format differs |
| **Telegram Intel** | `telegram` | `telegram` | Yes | Yes (`setData()`) | Nothing calls handler with bootstrap data |
| **Stablecoins** | `stablecoins` | `stablecoins` | Yes (`forwardToPanel`) | Yes (`applyPush()`) | Nothing calls handler with bootstrap data |
| **Gulf Economies** | `gulf-quotes` | `gulf-quotes` | Yes | Yes (`setData()`) | Nothing calls handler with bootstrap data |
| **ETF Flows** | `etf-flows` | **`etfFlows`** | Yes (`forwardToPanel`) | Yes (`applyPush()`) | Panel constructor reads `getHydratedData('etfFlows')` ✓ |
| **Macro Signals** | `macro-signals` | **`macroSignals`** | Yes (`forwardToPanel`) | Yes (`applyPush()`) | Panel constructor reads `getHydratedData('macroSignals')` ✓ |
| **Trade Policy** | `trade` | `trade` | Yes | Yes (`updateRestrictions()` etc.) | Nothing calls handler with bootstrap data |
| **Supply Chain** | `supply-chain` | **`chokepoints`** | Yes | Yes (`updateShippingRates()` etc.) | Hydration alias mismatch + no bootstrap drain |
| **OREF Sirens** | `oref` | `oref` | Yes | Yes (`setData()`) | Nothing calls handler with bootstrap data |
| **UCDP Events** | `ucdp-events` | **`ucdpEvents`** | Yes | Yes (`setEvents()`) | Hydration alias mismatch + no bootstrap drain |
| **Climate** | `climate` | **`climateAnomalies`** | Yes | Yes (`setAnomalies()`) | Hydration alias mismatch + no bootstrap drain |
| **Giving** | `giving` | `giving` | Yes | Yes (`setData()`) | Nothing calls handler with bootstrap data |

### Category C: Handler doesn't render panel (stub or no-op)

| Panel | Channel | Handler does what? | Panel render method | Fix needed |
|---|---|---|---|---|
| **GDELT Intel** | `gdelt` | **Logs only, no panel render** | `loadActiveTopic()` self-loads via `fetchTopicIntelligence()` | Handler must call `gdeltIntelPanel.refresh()` or panel needs to read bootstrap data |
| **Intel Feed** | `intelligence` | Calls `globalDigestPanel.setDigest()` | Intel Feed (`intel`) is a **different panel** — uses news/conflict/telegram/intelligence data. No direct handler calls it | Intel Feed renders from news store (newsStore), not from a push handler. It needs news to load first |
| **Cascade** | `cables`, `cyber`, `supply-chain` | Updates map + stores | `init()` self-loads via `buildDependencyGraph()` | CascadePanel is self-loading and doesn't depend on relay channels for its initial render. Fix: ensure its APIs work |

### Category D: Complex dependency chains

| Panel | Dependencies | Failure chain |
|---|---|---|
| **CII (Country Instability)** | 1. News must cluster → InsightsPanel gets focal points → emits `focal-points-ready` event → CII `refresh(forceLocal=true)`. 2. Also needs: `conflict`, `strategic-risk`, `ai:country-briefs`, `natural`, `oref`, various ingestion feeds. | If news never clusters (no news data) OR InsightsPanel never fires `focal-points-ready`, CII stays loading forever |
| **AI Insights** | Needs either: (a) `ai:panel-summary` via relay/bootstrap, OR (b) news clustering → `updateInsights(clusters)` | If both fail, stays loading |
| **Global Digest** | `intelligence` or `ai:intel-digest` handler | **Panel is never instantiated** in `panel-layout.ts` — `ctx.panels['global-digest']` is always `undefined` — handlers no-op via optional chaining |

### Category F: Panel never instantiated

| Panel | Configured? | Class exists? | Instantiated? | Handlers target it? |
|---|---|---|---|---|
| **Global Digest** (`global-digest`) | Yes, `enabled: true` in `FULL_PANELS` | Yes, `src/components/GlobalDigestPanel.ts` | **No — never created in `panel-layout.ts`** | Yes — `intelligence` handler calls `setDigest()`, `ai:intel-digest` calls `applyAiDigest()` — both silently no-op |

### Category G: Misleading panel channel config

| Panel | Config says | Actually rendered by | Correct dependency |
|---|---|---|---|
| **Commodities** | `channels: ['fred', 'oil', 'bis', 'trade', 'supply-chain']` | `markets` handler → `renderMarketDashboard()` → `commoditiesPanel.renderCommodities()` | `markets` channel |
| **Crypto** | (no channels config) | `markets` handler → `renderMarketDashboard()` → `cryptoPanel.renderCrypto()` | `markets` channel |

Note: `fred`, `oil`, `bis` handlers update **EconomicPanel**, not CommoditiesPanel. The channel registry for `markets` lists `panels: ['markets', 'heatmap']` but should also include `commodities` and `crypto`.

### Category E: Panels with data NOT in Redis (backend/worker issue)

These need backend investigation — no frontend fix will help:

| Panel | Channel | Redis Key | Likely cause |
|---|---|---|---|
| **AI Insights** | `ai:panel-summary` | `ai:panel-summary:v1` | AI engine may not have run or may lack API keys |
| **Strategic Posture** | `strategic-posture` | `theater-posture:sebuf:v1` | Worker may not be scheduled or may be failing |
| **Strategic Risk** | `strategic-risk` | `risk:scores:sebuf:v1` | Worker may not be scheduled or may be failing |
| **All AI channels** | `ai:*` | `ai:*:v1` | AI engine service may be down or unconfigured |

---

## The Fixes

### Task 1: Fix all hydration key aliases in `HYDRATION_ALIASES`

**Problem:** 7 channels are stored under camelCase names in bootstrap cache but `loadChannelWithFallback()` looks up by kebab-case channel key.

**Files:**
- Modify: `src/app/data-loader.ts:97-100`

**Current code:**

```typescript
private static readonly HYDRATION_ALIASES: Record<string, string> = {
  'strategic-posture': 'strategicPosture',
  'strategic-risk': 'strategicRisk',
};
```

**New code:**

```typescript
private static readonly HYDRATION_ALIASES: Record<string, string> = {
  'strategic-posture': 'strategicPosture',
  'strategic-risk': 'strategicRisk',
  'conflict': 'acledEvents',
  'ais': 'aisSnapshot',
  'climate': 'climateAnomalies',
  'gps-interference': 'gpsInterference',
  'ucdp-events': 'ucdpEvents',
  'supply-chain': 'chokepoints',
  'etf-flows': 'etfFlows',
  'macro-signals': 'macroSignals',
  'service-status': 'serviceStatuses',
};
```

**Commit:** `fix(data-loader): add all missing hydration key aliases to match gateway overrides`

---

### Task 2: Make `loadAllData()` drain bootstrap cache through handlers

**Problem:** `loadAllData()` is a no-op (just calls `updateSearchIndex()`). Bootstrap data for ~40 channels is fetched but never consumed.

**Files:**
- Modify: `src/app/data-loader.ts` (the `loadAllData` method, and add import)

**Add import at top:**

```typescript
import { CHANNEL_REGISTRY } from '@/config/channel-registry';
```

**Replace `loadAllData()`:**

```typescript
async loadAllData(): Promise<void> {
  for (const [channel] of Object.entries(CHANNEL_REGISTRY)) {
    const alias = DataLoaderManager.HYDRATION_ALIASES[channel];
    const data = getHydratedData(channel) ?? (alias ? getHydratedData(alias) : undefined);
    if (data !== undefined && data !== null) {
      const handler = this.domainHandlers[channel];
      if (handler) {
        try {
          handler(data);
        } catch (err) {
          console.warn(`[DataLoader] handler error draining "${channel}":`, err);
        }
      }
    }
  }
  this.updateSearchIndex();
}
```

**Commit:** `fix(data-loader): loadAllData drains bootstrap cache through domain handlers`

---

### Task 3: Call `loadAllData()` after bootstrap in `App.init()`

**Problem:** `loadAllData()` is never called after `fetchBootstrapData()`.

**Files:**
- Modify: `src/App.ts` (inside `init()`, after the existing `loadNews()` call)

**Current code (around line 465):**

```typescript
await fetchBootstrapData(SITE_VARIANT || 'full');
void this.dataLoader.loadChannelWithFallback('ai:panel-summary', (data) => {
  this.dataLoader.getHandler('ai:panel-summary')?.(data);
});
void this.dataLoader.loadNews();
loadNewsSources();
loadFeatureFlags();
```

**Add after `loadFeatureFlags()`:**

```typescript
loadNewsSources();
loadFeatureFlags();
const sourcesReady = Promise.resolve();
this.dataLoader.setSourcesReady(sourcesReady);

// Drain all remaining bootstrap data through domain handlers.
// News and ai:panel-summary are already consumed above; getHydratedData
// is delete-on-read so those entries won't be re-processed.
void this.dataLoader.loadAllData();
```

Note: `loadAllData` is already called, but it's a no-op. After Task 2, this existing call will now work. But check if it's called AFTER the `loadNews()` call. Looking at the code more carefully, I see `loadAllData()` is called from `PanelLayoutManager` and `EventHandlerManager` callbacks, not directly in `App.init()`. We need to add an explicit call in `init()`.

**Commit:** `fix(app): call loadAllData after bootstrap to hydrate all panels`

---

### Task 4: Fix GDELT handler to actually render the panel

**Problem:** The `gdelt` handler in `intelligence-handler.ts` only logs — it doesn't call `GdeltIntelPanel.refresh()`.

**Files:**
- Modify: `src/data/intelligence-handler.ts`

**Current handler (around line 150):**

```typescript
gdelt: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as { data?: Record<string, { articles: GdeltArticle[]; query: string; fetchedAt: string }> };
  console.log('[intelligence-handler] applyGdelt:', { topicCount: Object.keys(data?.data ?? {}).length });
},
```

**New handler:**

```typescript
gdelt: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const gdeltPanel = ctx.panels['gdelt-intel'] as { refresh?: () => void } | undefined;
  gdeltPanel?.refresh?.();
},
```

The panel self-loads via `fetchTopicIntelligence()`. Calling `refresh()` triggers a re-fetch. If bootstrap put the data in Redis (via the relay), the panel's own fetch will get it.

**Commit:** `fix(intelligence-handler): gdelt handler triggers panel refresh instead of logging`

---

### Task 5: Fix CII dependency chain — don't gate on `focal-points-ready`

**Problem:** CII's `refresh()` returns early unless `focalPointsReady` is true. `focalPointsReady` is only set when InsightsPanel emits `focal-points-ready`, which requires news clustering. If news doesn't cluster, CII stays loading forever.

**Files:**
- Modify: `src/components/CIIPanel.ts`

**Current code in `refresh()`:**

```typescript
if (!this.focalPointsReady && !forceLocal) return;
```

**Fix:** After the bootstrap drain runs (Task 2/3), domain handlers will have ingested conflict, strategic-risk, and other CII-relevant data. CII should be able to render with whatever data is available, not gate on focal points.

Add a timeout that calls `refresh(true)` if `focal-points-ready` hasn't fired within 10 seconds:

```typescript
// In constructor or init, add:
setTimeout(() => {
  if (!this.focalPointsReady) {
    this.refresh(true);
  }
}, 10_000);
```

**Commit:** `fix(cii): add timeout fallback so CII renders without waiting for focal points`

---

### Task 5b: Instantiate GlobalDigestPanel in panel-layout.ts

**Problem:** `GlobalDigestPanel` class exists but is never created. `ctx.panels['global-digest']` is always `undefined`, so the `intelligence` and `ai:intel-digest` handlers silently no-op. The panel appears in the grid config (`global-digest: enabled: true`) but has no backing component.

**Files:**
- Modify: `src/app/panel-layout.ts` (in the `SITE_VARIANT === 'full'` block, near other intelligence panels)

**Add after the GdeltIntelPanel creation (around line 471):**

```typescript
const { GlobalDigestPanel } = await import('@/components/GlobalDigestPanel');
this.ctx.panels['global-digest'] = new GlobalDigestPanel();
```

**Commit:** `fix(panel-layout): instantiate GlobalDigestPanel so intelligence handler can render`

---

### Task 5c: Fix channel registry and panel config for CommoditiesPanel

**Problem:** CommoditiesPanel is rendered by the `markets` handler (`renderMarketDashboard` → `commoditiesPanel.renderCommodities()`), NOT by `fred`/`oil`/`bis` handlers. The panel config misleadingly says `channels: ['fred', 'oil', 'bis', 'trade', 'supply-chain']`, and the channel registry for `markets` lists `panels: ['markets', 'heatmap']` but omits `commodities` and `crypto`.

**Files:**
- Modify: `src/config/panels.ts` — change commodities channels to `['markets']`
- Modify: `src/config/channel-registry.ts` — add `commodities` and `crypto` to `markets` channel panels

**In `panels.ts`:**
```typescript
// Change from:
commodities: { name: 'Commodities', enabled: true, priority: 1, channels: ['fred', 'oil', 'bis', 'trade', 'supply-chain'] },
// To:
commodities: { name: 'Commodities', enabled: true, priority: 1, channels: ['markets'] },
```

**In `channel-registry.ts`:**
```typescript
// Change from:
markets: { key: 'markets', redisKey: 'market:dashboard:v1', panels: ['markets', 'heatmap'], ... },
// To:
markets: { key: 'markets', redisKey: 'market:dashboard:v1', panels: ['markets', 'heatmap', 'commodities', 'crypto'], ... },
```

**Commit:** `fix(config): correct commodities/crypto channel mapping to markets`

---

### Task 6: Add `channelKeys` to all relay-dependent panel subclasses

**Problem:** Only InsightsPanel declares `channelKeys`. Other panels don't subscribe to channel state, so they can't show loading/error/stale badges and the 30-second timeout detection doesn't surface.

**Files:**
- Modify: Each panel file in `src/components/`

**Panels to update:**

```
MarketPanel:              channelKeys = ['markets']
CommoditiesPanel:         channelKeys = ['markets']
CryptoPanel:              channelKeys = ['markets']
HeatmapPanel:             channelKeys = ['markets']
PredictionPanel:          channelKeys = ['predictions']
HeadlinesPanel:           channelKeys = ['news:full'] (use SITE_VARIANT)
StrategicPosturePanel:    channelKeys = ['strategic-posture']
StrategicRiskPanel:       channelKeys = ['strategic-risk']
CIIPanel:                 channelKeys = ['conflict', 'strategic-risk']
TelegramIntelPanel:       channelKeys = ['telegram']
GdeltIntelPanel:          channelKeys = ['gdelt']
GulfEconomiesPanel:       channelKeys = ['gulf-quotes']
StablecoinPanel:          channelKeys = ['stablecoins']
ETFFlowsPanel:            channelKeys = ['etf-flows']
MacroSignalsPanel:        channelKeys = ['macro-signals']
UcdpEventsPanel:          channelKeys = ['ucdp-events']
TradePolicyPanel:         channelKeys = ['trade']
SupplyChainPanel:         channelKeys = ['supply-chain']
CascadePanel:             channelKeys = ['cables', 'cyber']
OrefSirensPanel:          channelKeys = ['oref']
GlobalDigestPanel:        channelKeys = ['intelligence']
GivingPanel:              channelKeys = ['giving']
ClimateAnomalyPanel:      channelKeys = ['climate']
SatelliteFiresPanel:      channelKeys = ['natural']
ServiceStatusPanel:       channelKeys = ['service-status']
```

Pattern for each:

```typescript
export class MarketPanel extends Panel {
  override readonly channelKeys = ['markets'];
  // ... rest
```

**Commit:** `feat(panels): add channelKeys to all panel subclasses for state machine`

---

### Task 7: Verify Redis has data — backend diagnosis

**Problem:** If workers aren't running or Redis keys are empty, no amount of frontend fixes will help.

**Step 1: Check which Redis keys have data**

```bash
cd services && docker-compose exec -T redis redis-cli KEYS '*' | sort
```

**Step 2: Check specific critical keys**

```bash
cd services && docker-compose exec -T redis redis-cli EXISTS \
  "market:dashboard:v1" \
  "relay:conflict:v1" \
  "risk:scores:sebuf:v1" \
  "theater-posture:sebuf:v1" \
  "ai:panel-summary:v1" \
  "news:digest:v1:full:en" \
  "relay:predictions:v1" \
  "relay:telegram:v1" \
  "relay:fred:v1" \
  "relay:oil:v1" \
  "relay:bis:v1"
```

**Step 3: Check orchestrator is scheduling workers**

```bash
cd services && docker-compose logs orchestrator 2>&1 | tail -50
```

**Step 4: Check worker execution**

```bash
cd services && docker-compose logs worker 2>&1 | tail -100
```

**Step 5: Check AI engine**

```bash
cd services && docker-compose logs ai-engine 2>&1 | tail -50
```

**Output:** Create a table of which Redis keys exist and which don't. Frontend fixes only help for keys that HAVE data.

---

### Task 8: Verify end-to-end after all fixes

**Step 1: Build and test**

```bash
npm run build
```

**Step 2: Check console for bootstrap data**

Add temporary debug logging to `loadAllData()`:

```typescript
console.log(`[DataLoader] draining "${channel}": data=${!!data}, handler=${!!handler}`);
```

**Step 3: Check that panels transition out of loading**

For each panel, verify:
- Shows data within 5 seconds (if Redis has data)
- Shows "Service unavailable" error badge after 30 seconds (if Redis is empty)
- Shows "stale" badge for old data

**Step 4: Remove debug logging and commit**

---

## Execution Order

| Task | Risk | Effort | Impact |
|---|---|---|---|
| **7. Redis diagnosis** | None | 10 min | Tells us which panels CAN be fixed by frontend |
| **1. Hydration aliases** | Low | 5 min | Fixes 7 channels with wrong cache keys |
| **2. loadAllData drain** | Low | 10 min | Core fix — drains ~40 channels through handlers |
| **3. Wire loadAllData** | Low | 5 min | Activates Task 2 |
| **4. Fix GDELT handler** | Low | 5 min | GdeltIntelPanel stops being dead |
| **5. Fix CII timeout** | Low | 5 min | CII doesn't wait forever for focal points |
| **5b. Instantiate GlobalDigestPanel** | Low | 5 min | Intelligence Digest panel can now receive data |
| **5c. Fix commodities/crypto channel mapping** | Low | 5 min | Correct channel→panel mapping in config and registry |
| **6. Panel channelKeys** | Low | 30 min | Loading/error/stale badges on all panels |
| **8. E2E verify** | None | 15 min | Confirms everything works |

**Start with Task 7** to know which panels have data to work with. Then do Tasks 1-6 (all frontend changes). Then Task 8 to verify.

---

## What This Plan Covers That Previous Plans Didn't

| Issue | Previous plans | This plan |
|---|---|---|
| `loadAllData()` is a no-op | Mentioned but not implemented | Task 2: Implements it |
| `loadAllData()` never called after bootstrap | Not addressed | Task 3: Adds the call |
| 7 hydration key mismatches | Only 2 aliases existed | Task 1: All 11 aliases |
| GDELT handler is a stub | Added to registry but handler logs only | Task 4: Handler triggers refresh |
| CII depends on focal-points-ready | Not addressed | Task 5: Timeout fallback |
| GlobalDigestPanel never instantiated | Not discovered | Task 5b: Creates the panel |
| CommoditiesPanel mapped to wrong channels | Not discovered | Task 5c: Correct channel→panel mapping |
| Panels don't declare channelKeys | Mentioned in refactor plan | Task 6: Actually adds them |
| Redis may be empty | Assumed data exists | Task 7: Diagnose backend |
| Data format mismatches | Not considered | Handlers use proto types; bootstrap unwraps envelopes to same format as WS push |

---

## Panels That Are Self-Loading (No Fix Needed for Bootstrap)

These panels load their own data and don't depend on the bootstrap → handler → render path:

| Panel | Self-load mechanism |
|---|---|
| StrategicPosturePanel | `fetchAndRender()` in constructor via `init()` |
| StrategicRiskPanel | `refresh()` in constructor via `init()` |
| CascadePanel | `buildDependencyGraph()` in constructor via `init()` |
| GdeltIntelPanel | `loadActiveTopic()` in constructor |
| LiveNewsPanel | IntersectionObserver → `triggerInit()` |

These will work as long as their APIs respond. They ALSO benefit from relay push (handlers call `applyPush` or `refresh`), but don't need bootstrap drain for initial render.

---

## Success Criteria

1. All Category B panels show data within 5 seconds of page load (when Redis has data)
2. All panels show "Service unavailable" error after 30 seconds (when Redis has no data)
3. CII renders within 15 seconds even without focal-points-ready
4. GDELT Intel panel refreshes on relay push (not just on self-load)
5. Console shows `[DataLoader] draining "markets": data=true, handler=true` for all channels with Redis data
6. No "Loading..." spinners lasting longer than 30 seconds
