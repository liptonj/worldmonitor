# Panel Data Loading Fix — Universal Relay Consistency

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every panel loads data exclusively from Redis via WebSocket push-on-subscribe (initial) and WebSocket broadcast (updates). Two clients opening the page at different times always see identical data. Fix all 13 broken panels, add AIS disruption/density pipeline, wire Security Advisories to relay, and add schema validation for the top channels.

**Architecture:** Workers → Redis → Gateway push-on-subscribe → `relay-push.ts` dispatch → handlers → panels. No direct HTTP fetches for data that exists in Redis.

**Tech Stack:** TypeScript (Vite frontend), Node.js CommonJS (backend services), Redis (ioredis), gRPC

**Prerequisites:** Backend push-on-subscribe plan (`2026-03-10-backend-push-on-subscribe.md`) and frontend handler plan (`2026-03-10-frontend-push-on-subscribe.md`) are already implemented.

**Production Redis:** `10.230.255.80:6379` — all workers are running and populating Redis keys. Telegram ingest is active. AI engine is generating digests.

---

## Critical Context: Why Panels Are Still Broken

The push-on-subscribe plan fixed handler early-returns and channel wiring. But panels still fail because:

1. **GDELT `applyRelayData` expects `payload.data` but receives the topic map directly** — `unwrapEnvelope` strips the `data` wrapper, so the panel's `raw.data` check fails and it falls back to `refresh()` which does a direct HTTP fetch (often fails due to CORS/rate limits)
2. **Giving handler's `protoToGivingSummary` returns null on stale Redis data** — old stub format `{ data: [], status: 'stub' }` unwraps to `[]`, and `[].summary` is undefined
3. **Security Advisories is not in the channel registry** — orchestrator populates `relay:security-advisories:v1` but frontend uses direct RSS fetch instead
4. **AIS processor only sends `{ vessels, count, timestamp }`** — frontend expects `disruptions` and `density` arrays that are never computed server-side
5. **Several panels have no fallback when push-on-subscribe delivers nothing** — Markets, Commodities, Climate stay empty on cold start
6. **AI panels depend on generators having run** — if AI engine hasn't produced output yet, push-on-subscribe has nothing to push
7. **Infrastructure Cascade doesn't consume relay cable/cyber data** — builds from static config only

---

## Shared Contract Addendum

These channels are added or modified from the original shared contract:

| Channel key | Redis key | Unwrapped payload shape |
|---|---|---|
| `ais` | `relay:ais-snapshot:v1` | `{ vessels: [], disruptions: [], density: [], count: N, timestamp: ISO }` |
| `security-advisories` | `relay:security-advisories:v1` | `{ items: [{ title, link, published, description }] }` |

---

## Task 1: Fix GDELT `applyRelayData` — accept unwrapped topic map

**Files:**
- Modify: `src/components/GdeltIntelPanel.ts`

**Bug:** `applyRelayData` expects `payload.data` to be the topic map. But `unwrapEnvelope` already returns `raw.data`, so the frontend receives the topic map directly at the top level. `payload.data` is `undefined`, the check fails, panel falls back to `refresh()`.

**Step 1: Update `applyRelayData` to accept both wrapped and unwrapped formats**

Find the `applyRelayData` method. Current logic:
```typescript
const raw = payload as { data?: Record<string, RelayTopicCache> };
if (!raw.data || typeof raw.data !== 'object') {
  this.refresh();
  return;
}
this._relayCache = raw.data;
```

New logic:
```typescript
const raw = payload as Record<string, unknown>;
const topicMap = (raw && typeof raw === 'object' && 'data' in raw && typeof raw.data === 'object' && raw.data !== null)
  ? raw.data as Record<string, RelayTopicCache>
  : raw as Record<string, RelayTopicCache>;

const hasTopicKeys = Object.keys(topicMap).some(k =>
  typeof topicMap[k] === 'object' && topicMap[k] !== null && 'articles' in (topicMap[k] as Record<string, unknown>)
);
if (!hasTopicKeys) {
  console.warn('[wm:gdelt] no valid topic keys in relay payload, falling back to refresh');
  this.refresh();
  return;
}
this._relayCache = topicMap;
```

**Step 2: Update the active topic rendering after setting `_relayCache`**

After `this._relayCache = topicMap;`, ensure the active topic is rendered:
```typescript
const topicData = topicMap[this._activeTopicId];
if (topicData?.articles) {
  this.renderArticles(topicData.articles);
  this.setCount(topicData.articles.length);
} else {
  this.refresh();
}
```

**Step 3: Commit**

```bash
git add src/components/GdeltIntelPanel.ts
git commit -m "fix(gdelt-panel): accept both wrapped and unwrapped relay topic map"
```

---

## Task 2: Fix Giving handler — tolerate both proto and raw formats

**Files:**
- Modify: `src/data/economic-handler.ts` (lines 219–228)
- Modify: `src/services/giving/index.ts` (line 69)

**Bug:** `protoToGivingSummary(payload)` returns null when `payload.summary` is falsy. Stale Redis data (old stub `{ data: [], status: 'stub' }`) unwraps to `[]`, and `[].summary === undefined`. The current stub worker returns `{ data: { summary: { ..., platforms: [] } } }` which unwraps correctly, but if the worker hasn't run since the fix, old data persists.

**Step 1: Make `protoToGivingSummary` tolerate the unwrapped format**

In `src/services/giving/index.ts`, update `protoToGivingSummary`:

Current:
```typescript
export function protoToGivingSummary(proto: ProtoResponse): GivingSummary | null {
  if (!proto?.summary) return null;
  return toDisplaySummary(proto);
}
```

New:
```typescript
export function protoToGivingSummary(proto: unknown): GivingSummary | null {
  if (!proto || typeof proto !== 'object') return null;
  const obj = proto as Record<string, unknown>;

  if (obj.summary && typeof obj.summary === 'object') {
    return toDisplaySummary(proto as ProtoResponse);
  }

  if (Array.isArray(obj.platforms)) {
    return {
      generatedAt: (obj.generatedAt as string) || new Date().toISOString(),
      activityIndex: (obj.activityIndex as number) || 0,
      trend: (obj.trend as 'rising' | 'stable' | 'falling') || 'stable',
      estimatedDailyFlowUsd: (obj.estimatedDailyFlowUsd as number) || 0,
      platforms: (obj.platforms as ProtoPlatform[]).map(toDisplayPlatform),
      categories: Array.isArray(obj.categories) ? (obj.categories as ProtoCategory[]).map(toDisplayCategory) : [],
      crypto: toDisplayCrypto(obj.crypto as ProtoCrypto | undefined),
      institutional: toDisplayInstitutional(obj.institutional as ProtoInstitutional | undefined),
    };
  }

  return null;
}
```

**Step 2: Add diagnostic logging to the giving handler**

In `src/data/economic-handler.ts`, update the giving handler:

Current:
```typescript
giving: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') { console.warn('[wm:giving] skipped — invalid payload type:', typeof payload); return; }
  const data = protoToGivingSummary(payload as GetGivingSummaryResponse);
  if (!data || !Array.isArray(data.platforms)) {
    console.error('[wm:giving] malformed payload — platforms is not an array');
```

New:
```typescript
giving: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') { console.warn('[wm:giving] skipped — invalid payload type:', typeof payload); return; }
  if (Array.isArray(payload)) { console.warn('[wm:giving] received array instead of object — stale Redis data?', { length: payload.length }); }
  const data = protoToGivingSummary(payload);
  if (!data || !Array.isArray(data.platforms)) {
    console.error('[wm:giving] malformed payload — platforms is not an array', { keys: Object.keys(payload as object), hasData: 'data' in (payload as object), hasSummary: 'summary' in (payload as object) });
```

**Step 3: Commit**

```bash
git add src/services/giving/index.ts src/data/economic-handler.ts
git commit -m "fix(giving): tolerate both proto and raw relay formats, add diagnostic logging"
```

---

## Task 3: Wire Security Advisories to relay

**Files:**
- Modify: `src/config/channel-registry.ts` — add `security-advisories` channel
- Modify: `src/data/infrastructure-handler.ts` — add `security-advisories` handler
- Modify: `src/app/data-loader.ts` — register the handler
- Run: `npm run generate:channel-keys`

**Step 1: Add to CHANNEL_REGISTRY**

In `src/config/channel-registry.ts`, add after the `tech-events` entry:

```typescript
'security-advisories': {
  key: 'security-advisories',
  redisKey: 'relay:security-advisories:v1',
  panels: ['security-advisories'],
  domain: 'infrastructure',
  staleAfterMs: 60 * 60_000,
  timeoutMs: 30_000,
  required: false,
},
```

**Step 2: Add handler in `infrastructure-handler.ts`**

Add to the returned handlers object:

```typescript
'security-advisories': (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const items = Array.isArray(payload)
    ? payload
    : (payload as { items?: unknown[] }).items;
  if (!Array.isArray(items)) {
    console.warn('[wm:security-advisories] malformed payload — no items array');
    return;
  }
  const panel = ctx.panels['security-advisories'] as SecurityAdvisoriesPanel | undefined;
  if (panel?.applyRelayData) {
    panel.applyRelayData(items);
  } else if (panel?.setData) {
    panel.setData(items);
  }
},
```

**Step 3: Add `applyRelayData` to SecurityAdvisoriesPanel if it doesn't exist**

Check `src/components/SecurityAdvisoriesPanel.ts`. If it only has a `refresh()` method that does direct HTTP fetch, add:

```typescript
public applyRelayData(items: SecurityAdvisory[]): void {
  this._items = items;
  this.renderItems(items);
  this.setCount(items.length);
}
```

**Step 4: Regenerate channel-keys.json**

```bash
npm run generate:channel-keys
```

**Step 5: Commit**

```bash
git add src/config/channel-registry.ts src/data/infrastructure-handler.ts src/app/data-loader.ts src/components/SecurityAdvisoriesPanel.ts services/gateway/channel-keys.json
git commit -m "feat(security-advisories): wire to relay channel registry for WebSocket push"
```

---

## Task 4: AIS processor — add disruption detection and density computation

**Files:**
- Modify: `services/ais-processor/index.cjs`

**Context:** `scripts/ais-relay.cjs` contains working `detectDisruptions()` (lines 2717–2776) and `calculateDensityZones()` (lines 2779–2817). Port this logic into the production AIS processor.

**Step 1: Add chokepoint definitions and tracking data structures**

Add after the `MAX_VESSELS` constant:

```javascript
const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, radius: 0.5, region: 'IR' },
  { name: 'Suez Canal', lat: 30.46, lon: 32.35, radius: 0.3, region: 'EG' },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, radius: 1.0, region: 'MY' },
  { name: 'Bab el-Mandeb', lat: 12.58, lon: 43.33, radius: 0.3, region: 'YE' },
  { name: 'Panama Canal', lat: 9.08, lon: -79.68, radius: 0.3, region: 'PA' },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 1.0, region: 'TW' },
  { name: 'South China Sea', lat: 14.5, lon: 114.0, radius: 3.0, region: 'CN' },
  { name: 'Black Sea Straits', lat: 41.0, lon: 29.0, radius: 0.5, region: 'TR' },
];

const GAP_THRESHOLD_MS = 60 * 60 * 1000;
const DENSITY_GRID_SIZE = 2;
const MAX_DENSITY_ZONES = 200;
const vesselHistory = new Map();
const chokepointBuckets = new Map();
const densityGrid = new Map();
```

**Step 2: Update `processAisMessage` to track history and buckets**

After updating the vessel in the `vessels` Map, add:

```javascript
const history = vesselHistory.get(String(mmsi)) || [];
history.push(Date.now());
if (history.length > 10) history.shift();
vesselHistory.set(String(mmsi), history);

const lat = updated.lat;
const lon = updated.lon;
if (typeof lat === 'number' && typeof lon === 'number') {
  for (const cp of CHOKEPOINTS) {
    const dist = Math.sqrt((lat - cp.lat) ** 2 + (lon - cp.lon) ** 2);
    if (dist <= cp.radius) {
      if (!chokepointBuckets.has(cp.name)) chokepointBuckets.set(cp.name, new Set());
      chokepointBuckets.get(cp.name).add(String(mmsi));
    }
  }

  const gridKey = `${Math.floor(lat / DENSITY_GRID_SIZE)}_${Math.floor(lon / DENSITY_GRID_SIZE)}`;
  if (!densityGrid.has(gridKey)) {
    densityGrid.set(gridKey, { lat: Math.floor(lat / DENSITY_GRID_SIZE) * DENSITY_GRID_SIZE + DENSITY_GRID_SIZE / 2, lon: Math.floor(lon / DENSITY_GRID_SIZE) * DENSITY_GRID_SIZE + DENSITY_GRID_SIZE / 2, vessels: new Set(), prevCount: 0 });
  }
  densityGrid.get(gridKey).vessels.add(String(mmsi));
}
```

**Step 3: Add `detectDisruptions` function**

```javascript
function detectDisruptions() {
  const disruptions = [];

  for (const cp of CHOKEPOINTS) {
    const bucket = chokepointBuckets.get(cp.name);
    const vesselCount = bucket ? bucket.size : 0;
    if (vesselCount < 5) continue;
    const normalTraffic = cp.radius * 10;
    let severity = 'low';
    let changePct = 0;
    if (normalTraffic > 0) {
      changePct = Math.round(((vesselCount - normalTraffic) / normalTraffic) * 100);
      if (vesselCount > normalTraffic * 1.5) severity = 'high';
      else if (vesselCount > normalTraffic) severity = 'elevated';
    }
    disruptions.push({
      id: `cp-${cp.name.toLowerCase().replace(/\s+/g, '-')}`,
      name: cp.name,
      type: 'chokepoint_congestion',
      lat: cp.lat,
      lon: cp.lon,
      severity,
      changePct,
      windowHours: 1,
      vesselCount,
      region: cp.region,
      description: `${vesselCount} vessels in ${cp.name} (${changePct > 0 ? '+' : ''}${changePct}% vs normal)`,
    });
  }

  let darkShipCount = 0;
  const now = Date.now();
  for (const [mmsi, history] of vesselHistory) {
    if (history.length < 2) continue;
    const gap = history[history.length - 1] - history[history.length - 2];
    if (gap > GAP_THRESHOLD_MS && (now - history[history.length - 1]) < 10 * 60 * 1000) {
      darkShipCount++;
    }
  }
  if (darkShipCount >= 1) {
    let severity = 'low';
    if (darkShipCount >= 10) severity = 'high';
    else if (darkShipCount >= 5) severity = 'elevated';
    disruptions.push({
      id: 'gap-spike-global',
      name: 'AIS Gap Spike',
      type: 'gap_spike',
      lat: 0,
      lon: 0,
      severity,
      changePct: 0,
      windowHours: 1,
      darkShips: darkShipCount,
      region: 'global',
      description: `${darkShipCount} vessels reappeared after extended AIS silence`,
    });
  }

  return disruptions;
}
```

**Step 4: Add `calculateDensityZones` function**

```javascript
function calculateDensityZones() {
  const zones = [];
  for (const [, cell] of densityGrid) {
    if (cell.vessels.size < 2) continue;
    const intensity = Math.min(1.0, 0.2 + Math.log10(cell.vessels.size) * 0.3);
    const deltaPct = cell.prevCount > 0
      ? Math.round(((cell.vessels.size - cell.prevCount) / cell.prevCount) * 100)
      : 0;
    zones.push({
      id: `dz-${cell.lat.toFixed(0)}-${cell.lon.toFixed(0)}`,
      name: `Zone ${cell.lat.toFixed(0)}°, ${cell.lon.toFixed(0)}°`,
      lat: cell.lat,
      lon: cell.lon,
      intensity,
      deltaPct,
      shipsPerDay: cell.vessels.size * 48,
    });
    cell.prevCount = cell.vessels.size;
  }
  zones.sort((a, b) => b.intensity - a.intensity);
  return zones.slice(0, MAX_DENSITY_ZONES);
}
```

**Step 5: Update `getSnapshot` to include disruptions and density**

```javascript
function getSnapshot() {
  let vesselArray = Array.from(vessels.values());
  if (vesselArray.length > MAX_VESSELS) {
    vesselArray = vesselArray
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      .slice(0, MAX_VESSELS);
  }
  const disruptions = detectDisruptions();
  const density = calculateDensityZones();
  return {
    vessels: vesselArray,
    disruptions,
    density,
    count: vesselArray.length,
    totalTracked: vessels.size,
    timestamp: new Date().toISOString(),
  };
}
```

**Step 6: Add periodic cleanup of chokepoint buckets and density grid**

In the snapshot write interval, after `writeSnapshot()`, clear stale tracking:

```javascript
for (const [, bucket] of chokepointBuckets) bucket.clear();
for (const [key, cell] of densityGrid) {
  cell.prevCount = cell.vessels.size;
  cell.vessels.clear();
}
```

**Step 7: Commit**

```bash
git add services/ais-processor/index.cjs
git commit -m "feat(ais-processor): add disruption detection and density zone computation"
```

---

## Task 5: Add diagnostic payload logging to all handlers

**Files:**
- Modify: `src/data/intelligence-handler.ts`
- Modify: `src/data/markets-handler.ts`
- Modify: `src/data/economic-handler.ts`
- Modify: `src/data/geo-handler.ts`
- Modify: `src/data/infrastructure-handler.ts`
- Modify: `src/data/ai-handler.ts`

**Step 1: Add a shared diagnostic helper**

In `src/data/handler-utils.ts` (new file):

```typescript
export function logPayloadShape(channel: string, payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    console.warn(`[wm:${channel}] payload is ${payload === null ? 'null' : typeof payload}`);
    return;
  }
  const keys = Object.keys(payload as Record<string, unknown>);
  const isArray = Array.isArray(payload);
  console.debug(`[wm:${channel}] payload shape: ${isArray ? `array[${(payload as unknown[]).length}]` : `{${keys.join(',')}}`}`);
}
```

**Step 2: Add `logPayloadShape(channel, payload)` call at the start of every handler that currently logs errors**

For each handler function in all handler files, add as the first line:
```typescript
logPayloadShape('channel-name', payload);
```

This is a debug-level log, so it won't clutter production unless LOG_LEVEL is set to debug.

**Step 3: Commit**

```bash
git add src/data/handler-utils.ts src/data/*-handler.ts
git commit -m "feat(handlers): add diagnostic payload shape logging to all handlers"
```

---

## Task 6: Fix Telegram handler — ensure messages from relay are rendered

**Files:**
- Modify: `src/data/intelligence-handler.ts` (telegram handler, lines 159–206)

**Context:** Telegram ingest writes `{ messages: [...], count, timestamp }` to Redis. After `unwrapEnvelope` (no envelope fields since ingest-telegram writes without envelope), the frontend receives the same object. The handler looks for `raw.items` OR `raw.messages`.

**Step 1: Verify the handler's field mapping**

Check that the handler correctly maps `messages` → `items`:

```typescript
telegram: (payload: unknown) => {
  logPayloadShape('telegram', payload);
  if (!payload || typeof payload !== 'object') return;
  const raw = payload as Record<string, unknown>;
  const messages = (raw.items ?? raw.messages) as Array<Record<string, unknown>> | undefined;
```

If the `messages` field exists and contains items, this should work. The issue may be that `ingest-telegram` writes its data with an envelope wrapper.

**Step 2: Check if ingest-telegram wraps in an envelope**

Search `services/ingest-telegram/index.cjs` for how it writes to Redis. If it writes:
```javascript
{ timestamp, source: 'telegram', status: 'success', data: { messages, count, timestamp } }
```

Then `unwrapEnvelope` returns `{ messages, count, timestamp }` which the handler should handle.

If it writes directly (no envelope):
```javascript
{ messages: [...], count: N, timestamp: ISO }
```

Then the handler receives this directly — should also work.

**Step 3: Add fallback handling for empty messages**

Ensure the handler calls `setData` even when messages are empty:

```typescript
if (!messages || messages.length === 0) {
  (ctx.panels['telegram-intel'] as TelegramIntelPanel)?.setData({
    source: 'telegram' as const,
    earlySignal: false,
    enabled: true,
    count: 0,
    updatedAt: String(raw.timestamp ?? new Date().toISOString()),
    items: [],
  });
  return;
}
```

**Step 4: Commit**

```bash
git add src/data/intelligence-handler.ts
git commit -m "fix(telegram-handler): ensure relay messages render and handle empty state"
```

---

## Task 7: Fix AI panel handlers — ensure push-on-subscribe data renders

**Files:**
- Modify: `src/data/ai-handler.ts`

**Context:** AI channels (`ai:panel-summary`, `ai:posture-analysis`, `ai:risk-overview`, `ai:intel-digest`, etc.) are always subscribed (`domain === 'ai'`). The handlers forward data to panels. If the AI engine has produced output in Redis, push-on-subscribe should deliver it. If panels still don't render, the issue is in the handler → panel wiring.

**Step 1: Add logging to all AI handlers**

For each handler in `createAiHandlers`:

```typescript
'ai:panel-summary': (payload: unknown) => {
  logPayloadShape('ai:panel-summary', payload);
  if (!payload || typeof payload !== 'object') {
    console.warn('[wm:ai:panel-summary] invalid payload');
    return;
  }
  // ... existing logic
},
```

**Step 2: Ensure AI handlers emit panel events even on partial data**

For `ai:panel-summary`, ensure the event fires even if some fields are missing:

```typescript
'ai:panel-summary': (payload: unknown) => {
  logPayloadShape('ai:panel-summary', payload);
  if (!payload || typeof payload !== 'object') return;
  const data = payload as Record<string, unknown>;
  ctx.latestPanelSummary = data;
  (window as Record<string, unknown>).__wmLatestPanelSummary = data;
  window.dispatchEvent(new CustomEvent('wm:panel-summary-updated', { detail: data }));
},
```

**Step 3: Verify InsightsPanel event listener timing**

In `src/components/InsightsPanel.ts`, ensure the event listener is registered in the constructor BEFORE `setupRelayPush()` runs. If the panel is created lazily after push data arrives, the event is lost.

Add a check in `InsightsPanel` constructor:
```typescript
const existing = (window as Record<string, unknown>).__wmLatestPanelSummary;
if (existing) {
  this.applyData(existing);
}
```

**Step 4: Same pattern for Strategic Posture and Strategic Risk panels**

Ensure `StrategicPosturePanel` and `StrategicRiskPanel` check for existing data in their constructors.

**Step 5: Commit**

```bash
git add src/data/ai-handler.ts src/components/InsightsPanel.ts src/components/StrategicPosturePanel.ts src/components/StrategicRiskPanel.ts
git commit -m "fix(ai-handlers): add logging, handle late panel mount, ensure push data renders"
```

---

## Task 8: Fix Markets and Commodities — add fallback load

**Files:**
- Modify: `src/App.ts` — add fallback in `loadAllData` or after bootstrap

**Context:** Markets data depends on push-on-subscribe delivering data from `market:dashboard:v1`. If the WebSocket connects after the page renders and the bootstrap HTTP fetch returned nothing for markets, the panel stays empty until the next broadcast.

**Step 1: Add fallback load for critical panels after push-on-subscribe timeout**

In `src/App.ts`, after `setupRelayPush()`, add a delayed fallback:

```typescript
setTimeout(() => {
  const criticalChannels = ['markets', 'fred', 'oil', 'bis', 'climate', 'conflict'];
  for (const ch of criticalChannels) {
    const state = getChannelState(ch);
    if (state.state === 'loading' || state.state === 'idle') {
      console.warn(`[wm:fallback] ${ch} still loading after 15s, attempting HTTP fallback`);
      this.dataLoader.loadChannelWithFallback(ch).catch(() => {});
    }
  }
}, 15_000);
```

**Step 2: Commit**

```bash
git add src/App.ts
git commit -m "fix(app): add 15s fallback for critical panels that don't receive push data"
```

---

## Task 9: Fix Infrastructure Cascade — wire relay data into dependency graph

**Files:**
- Modify: `src/components/CascadePanel.ts`

**Step 1: Add method to update dependency graph from relay data**

```typescript
public applyCableHealth(cables: CableHealth[]): void {
  for (const cable of cables) {
    const node = this._graph.nodes.get(cable.id);
    if (node) {
      node.status = cable.status;
      node.lastUpdated = cable.lastChecked;
    }
  }
  this.render();
}

public applyCyberThreats(threats: CyberThreat[]): void {
  const threatCount = threats.length;
  const node = this._graph.nodes.get('cyber-threats');
  if (node) {
    node.status = threatCount > 10 ? 'critical' : threatCount > 5 ? 'degraded' : 'operational';
    node.lastUpdated = new Date().toISOString();
  }
  this.render();
}
```

**Step 2: Update the infrastructure handler to call these methods**

In `src/data/infrastructure-handler.ts`, after setting cable/cyber map data, also update the cascade panel:

```typescript
cables: (payload: unknown) => {
  // ... existing cable rendering logic ...
  const cascadePanel = ctx.panels['cascade'] as CascadePanel | undefined;
  if (cascadePanel?.applyCableHealth) {
    cascadePanel.applyCableHealth(cables);
  }
},
```

**Step 3: Commit**

```bash
git add src/components/CascadePanel.ts src/data/infrastructure-handler.ts
git commit -m "fix(cascade): wire relay cable/cyber data into dependency graph"
```

---

## Task 10: Add Zod schema validation for top channels

**Files:**
- Create: `src/data/channel-schemas.ts`
- Modify: `src/services/relay-push.ts`

**Step 1: Install Zod**

```bash
npm install zod
```

**Step 2: Define schemas for the top 15 channels**

In `src/data/channel-schemas.ts`:

```typescript
import { z } from 'zod';

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: z.object({ stocks: z.array(z.unknown()) }).passthrough(),
  predictions: z.union([z.array(z.unknown()), z.object({ markets: z.array(z.unknown()) }).passthrough()]),
  telegram: z.object({}).passthrough().refine(obj => 'items' in obj || 'messages' in obj, { message: 'Must have items or messages' }),
  intelligence: z.object({ digest: z.string().optional(), generatedAt: z.string().optional() }).passthrough(),
  conflict: z.object({ events: z.array(z.unknown()) }).passthrough(),
  ais: z.object({ vessels: z.array(z.unknown()).optional(), disruptions: z.array(z.unknown()).optional(), density: z.array(z.unknown()).optional() }).passthrough(),
  giving: z.object({}).passthrough(),
  climate: z.union([z.array(z.unknown()), z.object({ anomalies: z.array(z.unknown()) }).passthrough()]),
  cables: z.union([z.array(z.unknown()), z.object({ cables: z.unknown() }).passthrough()]),
  cyber: z.union([z.array(z.unknown()), z.object({ threats: z.array(z.unknown()) }).passthrough()]),
  fred: z.union([z.array(z.unknown()), z.object({ series: z.array(z.unknown()) }).passthrough()]),
  oil: z.union([z.array(z.unknown()), z.object({ prices: z.array(z.unknown()) }).passthrough()]),
  'ai:panel-summary': z.object({}).passthrough(),
  'ai:risk-overview': z.object({ overview: z.string().optional() }).passthrough(),
  'ai:posture-analysis': z.object({ analyses: z.array(z.unknown()).optional() }).passthrough(),
};
```

**Step 3: Add validation in `relay-push.ts` dispatch**

In the `dispatch` function, after the null check and before calling handlers:

```typescript
import { channelSchemas } from '@/data/channel-schemas';

function dispatch(channel: string, payload: unknown): void {
  if (payload !== undefined && payload !== null) {
    setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });

    const schema = channelSchemas[channel];
    if (schema) {
      const result = schema.safeParse(payload);
      if (!result.success) {
        console.warn(`[relay-push] schema validation failed for ${channel}:`, result.error.issues.map(i => i.message).join(', '), { keys: typeof payload === 'object' && payload ? Object.keys(payload) : typeof payload });
      }
    }
  } else {
    setChannelState(channel, 'error', 'websocket', { error: 'No data available' });
  }
  // ... rest of dispatch
}
```

**Step 4: Commit**

```bash
git add src/data/channel-schemas.ts src/services/relay-push.ts package.json package-lock.json
git commit -m "feat(relay-push): add Zod schema validation for top 15 channels"
```

---

## Task 11: Fix Climate Anomalies panel — handle cold start

**Files:**
- Modify: `src/data/geo-handler.ts`

**Context:** Climate worker runs every 6 hours. On cold start, Redis may be empty. The handler already adapts arrays to `{ anomalies }`, but needs to render empty state.

**Step 1: Ensure the handler renders even with zero anomalies**

Verify the handler calls `setAnomalies([])` when data is empty:

```typescript
climate: (payload: unknown) => {
  logPayloadShape('climate', payload);
  const adapted = Array.isArray(payload) ? { anomalies: payload } : payload;
  if (!adapted || typeof adapted !== 'object') return;
  const data = adapted as { anomalies?: unknown[] };
  const anomalies = Array.isArray(data.anomalies) ? data.anomalies : [];
  (ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies(anomalies);
},
```

**Step 2: Commit**

```bash
git add src/data/geo-handler.ts
git commit -m "fix(climate-handler): render empty anomalies instead of staying in loading"
```

---

## Task 12: Build, verify, and test consistency

**Step 1: Build**

```bash
npm run build
```

**Step 2: Regenerate channel-keys.json**

```bash
npm run generate:channel-keys
```

**Step 3: Verify all handlers call panel methods**

```bash
grep -n 'return;' src/data/*-handler.ts | grep -v 'showError\|showUnavailable\|setData\|render\|refresh\|applyPush\|setDigest\|setEvents\|setAnomalies\|update\|applyCable\|applyCyber\|applyRelay\|logPayloadShape\|typeof payload'
```

Every remaining bare `return;` should be the initial type guard only.

**Step 4: Verify consistency between clients**

Open two browser tabs. Both should:
- Receive the same `wm-push` messages on connect
- Show identical panel data
- Update simultaneously when a worker broadcasts

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors from comprehensive panel data loading fix"
```

---

## Execution Order

| Task | Risk | Effort | What it fixes |
|---|---|---|---|
| **1. GDELT applyRelayData** | Low | 10 min | Live Intelligence panel |
| **2. Giving handler** | Low | 15 min | Global Giving panel |
| **5. Diagnostic logging** | None | 15 min | All future debugging |
| **6. Telegram handler** | Low | 10 min | Telegram Intel panel |
| **7. AI panel handlers** | Low | 20 min | AI Insights, Strategic Posture, Risk Overview, Intelligence Digest |
| **8. Markets fallback** | Low | 10 min | Markets, Commodities |
| **11. Climate handler** | Low | 5 min | Climate Anomalies |
| **3. Security Advisories** | Medium | 30 min | Security Advisories panel |
| **9. Cascade wiring** | Medium | 20 min | Infrastructure Cascade |
| **4. AIS pipeline** | Medium | 60 min | AIS disruptions + density on map and CII panel |
| **10. Zod validation** | Low | 30 min | Schema validation for all channels |
| **12. Build + verify** | None | 15 min | Everything compiles and works |

**Do Tasks 1→2→5→6→7→8→11 first** (fix all handler bugs). Then 3→9→4 (new features). Then 10→12 (validation + verify).

---

## Success Criteria

1. **All 13 named panels render data** from Redis via WebSocket push-on-subscribe
2. **Two clients opened at different times show identical data** — both receive the same push-on-subscribe payloads from Redis
3. **AIS map layer shows disruptions and density zones** alongside vessels
4. **CII panel ingests AIS disruptions** for country instability scoring
5. **Security Advisories loads from relay** instead of direct RSS fetch
6. **Infrastructure Cascade updates from relay** cable/cyber data
7. **Schema validation logs mismatches** for the top 15 channels without blocking rendering
8. **All diagnostic logging** shows payload shapes for debugging future issues
9. **Build succeeds:** `npm run build` completes with zero errors
10. **No handler has a bare `return;`** that leaves a panel in loading state

---

## Security Note

`services/.env.production` contains live API keys, session tokens, and secrets committed to the repository. These should be:
1. Added to `.gitignore` immediately
2. Rotated (especially `SUPABASE_SERVICE_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `TELEGRAM_SESSION`, `RELAY_SHARED_SECRET`)
3. Moved to a secrets manager or environment-specific deployment config
