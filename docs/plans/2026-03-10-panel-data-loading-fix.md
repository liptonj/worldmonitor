# Panel Data Loading Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 13 broken panels so every panel loads data from Redis via WebSocket push-on-subscribe, add AIS disruption/density pipeline, wire Security Advisories to relay, and add schema validation — ensuring two clients always see identical data.

**Architecture:** Workers → Redis → Gateway push-on-subscribe → `relay-push.ts` dispatch → handlers → panels. Handlers must tolerate both wrapped (`payload.data`) and unwrapped (payload IS the data) formats from `unwrapEnvelope`. Late-mounting panels must check `window.__wm*` globals for data that arrived before mount.

**Tech Stack:** TypeScript (Vite frontend), Node.js CommonJS (backend services), Redis (ioredis), gRPC, Zod (schema validation)

---

## Task 1: Fix GDELT `applyRelayData` — accept unwrapped topic map

**Files:**
- Modify: `src/components/GdeltIntelPanel.ts:72-90`

**Step 1: Update `applyRelayData` to handle both wrapped and unwrapped formats**

Current code (lines 72–90):
```typescript
public applyRelayData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      this.refresh();
      return;
    }
    const raw = payload as { data?: Record<string, RelayTopicCache> };
    if (!raw.data || typeof raw.data !== 'object') {
      this.refresh();
      return;
    }
    this._relayCache = raw.data;
    const topicData = this._relayCache[this.activeTopic.id];
    if (topicData && Array.isArray(topicData.articles)) {
      this.renderArticles(topicData.articles);
      this.setCount(topicData.articles.length);
    } else {
      this.refresh();
    }
  }
```

New code:
```typescript
public applyRelayData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      this.refresh();
      return;
    }
    const raw = payload as Record<string, unknown>;
    // unwrapEnvelope may return the topic map directly (no .data wrapper)
    // or wrapped as { data: topicMap }
    const candidate = (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data))
      ? raw.data as Record<string, RelayTopicCache>
      : raw as unknown as Record<string, RelayTopicCache>;

    const hasTopicKeys = Object.keys(candidate).some(k => {
      const v = candidate[k];
      return v && typeof v === 'object' && 'articles' in v;
    });
    if (!hasTopicKeys) {
      console.warn('[wm:gdelt] relay payload has no topic keys, falling back', { keys: Object.keys(candidate).slice(0, 5) });
      this.refresh();
      return;
    }
    this._relayCache = candidate;
    const topicData = this._relayCache[this.activeTopic.id];
    if (topicData && Array.isArray(topicData.articles)) {
      this.renderArticles(topicData.articles);
      this.setCount(topicData.articles.length);
    } else {
      this.refresh();
    }
  }
```

**Step 2: Run build to verify no type errors**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors related to GdeltIntelPanel.

**Step 3: Commit**

```bash
git add src/components/GdeltIntelPanel.ts
git commit -m "fix(gdelt-panel): accept both wrapped and unwrapped relay topic map"
```

---

## Task 2: Fix Giving — tolerate both proto and raw relay formats

**Files:**
- Modify: `src/services/giving/index.ts:69-72`
- Modify: `src/data/economic-handler.ts:219-228`

**Step 1: Update `protoToGivingSummary` to handle raw format**

Current code (`src/services/giving/index.ts` lines 69–72):
```typescript
export function protoToGivingSummary(proto: ProtoResponse): GivingSummary | null {
  if (!proto?.summary) return null;
  return toDisplaySummary(proto);
}
```

New code:
```typescript
export function protoToGivingSummary(proto: unknown): GivingSummary | null {
  if (!proto || typeof proto !== 'object' || Array.isArray(proto)) return null;
  const obj = proto as Record<string, unknown>;

  // Proto format: { summary: { platforms, categories, ... } }
  if (obj.summary && typeof obj.summary === 'object') {
    return toDisplaySummary(proto as ProtoResponse);
  }

  // Raw/unwrapped format: { platforms, categories, generatedAt, ... } (already at summary level)
  if (Array.isArray(obj.platforms)) {
    return {
      generatedAt: String(obj.generatedAt ?? new Date().toISOString()),
      activityIndex: Number(obj.activityIndex ?? 0),
      trend: (obj.trend as 'rising' | 'stable' | 'falling') || 'stable',
      estimatedDailyFlowUsd: Number(obj.estimatedDailyFlowUsd ?? 0),
      platforms: (obj.platforms as ProtoPlatform[]).map(toDisplayPlatform),
      categories: Array.isArray(obj.categories) ? (obj.categories as ProtoCategory[]).map(toDisplayCategory) : [],
      crypto: toDisplayCrypto(obj.crypto as ProtoCrypto | undefined),
      institutional: toDisplayInstitutional(obj.institutional as ProtoInstitutional | undefined),
    };
  }

  return null;
}
```

**Step 2: Add diagnostic logging to giving handler**

Current code (`src/data/economic-handler.ts` lines 219–228):
```typescript
    giving: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:giving] skipped — invalid payload type:', typeof payload); return; }
      const data = protoToGivingSummary(payload as GetGivingSummaryResponse);
      if (!data || !Array.isArray(data.platforms)) {
        console.error('[wm:giving] malformed payload — platforms is not an array');
        (ctx.panels['giving'] as GivingPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      renderGiving(data);
    },
```

New code:
```typescript
    giving: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:giving] skipped — invalid payload type:', typeof payload); return; }
      if (Array.isArray(payload)) { console.warn('[wm:giving] received array — stale Redis data?'); }
      const data = protoToGivingSummary(payload);
      if (!data || !Array.isArray(data.platforms)) {
        const keys = (payload && typeof payload === 'object') ? Object.keys(payload as Record<string, unknown>) : [];
        console.error('[wm:giving] malformed payload — platforms is not an array', { keys, hasSummary: keys.includes('summary') });
        (ctx.panels['giving'] as GivingPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      renderGiving(data);
    },
```

**Step 3: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add src/services/giving/index.ts src/data/economic-handler.ts
git commit -m "fix(giving): tolerate both proto and raw relay formats, add diagnostic logging"
```

---

## Task 3: Fix AI panels — handle late mount with cached data

**Files:**
- Modify: `src/data/ai-handler.ts:52-59` (posture)
- Modify: `src/data/ai-handler.ts:61-68` (instability)
- Modify: `src/data/ai-handler.ts:70-77` (risk-overview)

**Step 1: Buffer AI payloads so late-mounting panels can retrieve them**

Add buffering at the top of `src/data/ai-handler.ts`. Current code starts at line 7:
```typescript
export function createAiHandlers(ctx: AppContext): Record<string, (payload: unknown) => void> {
  return {
```

New code:
```typescript
const aiPayloadBuffer = new Map<string, unknown>();

export function getBufferedAiPayload(channel: string): unknown | undefined {
  return aiPayloadBuffer.get(channel);
}

export function createAiHandlers(ctx: AppContext): Record<string, (payload: unknown) => void> {
  return {
```

**Step 2: Update posture handler to buffer and retry**

Current code (lines 52–59):
```typescript
    'ai:posture-analysis': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:posture-analysis] null/undefined payload'); return; }
      const posturePanel = ctx.panels['strategic-posture'] as { applyAiAnalysis?: (p: unknown) => void } | undefined;
      if (!posturePanel?.applyAiAnalysis) {
        console.warn('[wm:ai:posture-analysis] panel not mounted or missing applyAiAnalysis');
        return;
      }
      posturePanel.applyAiAnalysis(payload);
    },
```

New code:
```typescript
    'ai:posture-analysis': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:posture-analysis] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:posture-analysis', payload);
      const posturePanel = ctx.panels['strategic-posture'] as { applyAiAnalysis?: (p: unknown) => void } | undefined;
      if (!posturePanel?.applyAiAnalysis) {
        console.debug('[wm:ai:posture-analysis] panel not yet mounted — payload buffered');
        return;
      }
      posturePanel.applyAiAnalysis(payload);
    },
```

**Step 3: Same pattern for instability and risk-overview**

Update `ai:instability-analysis` (lines 61–68):
```typescript
    'ai:instability-analysis': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:instability-analysis] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:instability-analysis', payload);
      const riskPanel = ctx.panels['strategic-risk'] as { applyInstabilityAnalysis?: (p: unknown) => void } | undefined;
      if (!riskPanel?.applyInstabilityAnalysis) {
        console.debug('[wm:ai:instability-analysis] panel not yet mounted — payload buffered');
        return;
      }
      riskPanel.applyInstabilityAnalysis(payload);
    },
```

Update `ai:risk-overview` (lines 70–77):
```typescript
    'ai:risk-overview': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:risk-overview] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:risk-overview', payload);
      const riskPanel = ctx.panels['strategic-risk'] as { applyAiOverview?: (p: unknown) => void } | undefined;
      if (!riskPanel?.applyAiOverview) {
        console.debug('[wm:ai:risk-overview] panel not yet mounted — payload buffered');
        return;
      }
      riskPanel.applyAiOverview(payload);
    },
```

Also update `ai:intel-digest` (lines 9–16):
```typescript
    'ai:intel-digest': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:intel-digest] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:intel-digest', payload);
      const digestPanel = ctx.panels['global-digest'] as { applyAiDigest?: (p: unknown) => void } | undefined;
      if (!digestPanel?.applyAiDigest) {
        console.debug('[wm:ai:intel-digest] panel not yet mounted — payload buffered');
        return;
      }
      digestPanel.applyAiDigest(payload);
    },
```

**Step 4: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/data/ai-handler.ts
git commit -m "fix(ai-handler): buffer payloads for late-mounting panels"
```

---

## Task 4: Panels consume buffered AI data on mount

**Files:**
- Modify: `src/components/InsightsPanel.ts` (constructor, around line 56)
- Determine: `src/components/StrategicPosturePanel.ts` (constructor)
- Determine: `src/components/StrategicRiskPanel.ts` (constructor)
- Determine: `src/components/GlobalDigestPanel.ts` (constructor)

**Step 1: Add buffer consumption to InsightsPanel**

In `src/components/InsightsPanel.ts`, after the event listener registration (line 62), add:

```typescript
    // Check for buffered data that arrived before mount
    const existing = (window as unknown as { __wmLatestPanelSummary?: unknown }).__wmLatestPanelSummary;
    if (existing) {
      this.applyAiPanelSummary(existing);
    }
```

**Step 2: Find StrategicPosturePanel constructor and add buffer check**

Search for the constructor and add after initialization:

```typescript
import { getBufferedAiPayload } from '@/data/ai-handler';

// In constructor, after setup:
const bufferedPosture = getBufferedAiPayload('ai:posture-analysis');
if (bufferedPosture) this.applyAiAnalysis(bufferedPosture);
```

**Step 3: Same for StrategicRiskPanel**

```typescript
import { getBufferedAiPayload } from '@/data/ai-handler';

// In constructor, after setup:
const bufferedInstability = getBufferedAiPayload('ai:instability-analysis');
if (bufferedInstability) this.applyInstabilityAnalysis(bufferedInstability);
const bufferedOverview = getBufferedAiPayload('ai:risk-overview');
if (bufferedOverview) this.applyAiOverview(bufferedOverview);
```

**Step 4: Same for GlobalDigestPanel**

```typescript
import { getBufferedAiPayload } from '@/data/ai-handler';

// In constructor, after setup:
const bufferedDigest = getBufferedAiPayload('ai:intel-digest');
if (bufferedDigest) this.applyAiDigest(bufferedDigest);
```

**Step 5: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 6: Commit**

```bash
git add src/components/InsightsPanel.ts src/components/StrategicPosturePanel.ts src/components/StrategicRiskPanel.ts src/components/GlobalDigestPanel.ts
git commit -m "fix(panels): consume buffered AI data on late mount"
```

---

## Task 5: Fix Telegram — verify relay data path

**Files:**
- Modify: `src/data/intelligence-handler.ts:161-206`

**Step 1: Add diagnostic logging to telegram handler**

The handler (lines 161–206) already maps `items` and `messages` fields. Add a debug log at the start:

After line 162, add:
```typescript
      console.debug('[wm:telegram] payload shape:', { keys: Object.keys(raw), itemCount: Array.isArray(raw.items) ? (raw.items as unknown[]).length : 0, msgCount: Array.isArray(raw.messages) ? (raw.messages as unknown[]).length : 0 });
```

**Step 2: Handle case where ingest-telegram wraps in envelope**

The ingest-telegram service may write with envelope fields. After `unwrapEnvelope`, the handler might receive `{ messages: [...] }` or just the messages array. Add adaptation before line 164:

```typescript
      // ingest-telegram may send { data: { messages: [...] } } which unwrapEnvelope turns to { messages: [...] }
      // or raw { messages: [...], count, timestamp } without envelope
      const raw = (typeof payload === 'object' && payload !== null && 'data' in (payload as Record<string, unknown>) && typeof (payload as Record<string, unknown>).data === 'object')
        ? (payload as Record<string, unknown>).data as Record<string, unknown>
        : payload as Record<string, unknown>;
```

Replace the existing `const raw = payload as Record<string, unknown>;` on line 163.

**Step 3: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add src/data/intelligence-handler.ts
git commit -m "fix(telegram-handler): add diagnostic logging and handle envelope-wrapped payloads"
```

---

## Task 6: Add critical panel fallback after push-on-subscribe timeout

**Files:**
- Modify: `src/App.ts` (after line 501, after `this.setupRelayPush()`)

**Step 1: Add 15s fallback load for critical panels**

After line 501 (`this.setupRelayPush();`), add:

```typescript
    // Fallback: if critical panels still have no data after 15s, attempt HTTP load
    setTimeout(() => {
      if (this.state.isDestroyed) return;
      const criticalChannels = ['markets', 'conflict', 'climate', 'fred', 'oil', 'bis', 'telegram', 'intelligence'];
      for (const ch of criticalChannels) {
        const state = getChannelState(ch);
        if (state.state === 'loading' || state.state === 'idle') {
          console.warn(`[wm:fallback] ${ch} still loading after 15s, attempting HTTP fallback`);
          void this.dataLoader.loadChannelWithFallback(ch, (data) => {
            this.dataLoader.getHandler(ch)?.(data);
          }).catch(() => {});
        }
      }
    }, 15_000);
```

**Step 2: Add import for `getChannelState` at top of App.ts (if not already present)**

```typescript
import { getChannelState } from '@/services/channel-state';
```

**Step 3: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add src/App.ts
git commit -m "fix(app): add 15s HTTP fallback for critical panels missing push data"
```

---

## Task 7: Wire Security Advisories to relay

**Files:**
- Modify: `src/config/channel-registry.ts`
- Modify: `src/data/infrastructure-handler.ts`
- Modify: `src/components/SecurityAdvisoriesPanel.ts`
- Run: `npm run generate:channel-keys`

**Step 1: Add `security-advisories` to CHANNEL_REGISTRY**

In `src/config/channel-registry.ts`, find the `tech-events` entry and add after it:

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

**Step 2: Add handler in infrastructure-handler.ts**

In the returned handlers object (inside `createInfrastructureHandlers`), add:

```typescript
    'security-advisories': (payload: unknown) => {
      if (!payload) return;
      const items = Array.isArray(payload)
        ? payload
        : (payload as Record<string, unknown>).items;
      if (!Array.isArray(items)) {
        console.warn('[wm:security-advisories] no items array in payload');
        return;
      }
      (ctx.panels['security-advisories'] as { setData?: (d: unknown[]) => void } | undefined)?.setData?.(items);
    },
```

**Step 3: Regenerate channel-keys.json**

```bash
npm run generate:channel-keys
```

Verify:
```bash
grep 'security-advisories' services/gateway/channel-keys.json
```

Expected: `"security-advisories": "relay:security-advisories:v1"`

**Step 4: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/config/channel-registry.ts src/data/infrastructure-handler.ts services/gateway/channel-keys.json
git commit -m "feat(security-advisories): wire to relay channel for WebSocket push"
```

---

## Task 8: AIS processor — write failing test for disruptions/density

**Files:**
- Modify: `services/ais-processor/test/ais-processor.test.cjs`

**Step 1: Write tests for disruption detection and density zones**

Append to `services/ais-processor/test/ais-processor.test.cjs`:

```javascript
describe('getSnapshot with disruptions and density', () => {
  beforeEach(() => {
    _resetVessels();
  });

  it('snapshot includes disruptions and density arrays', () => {
    // Add vessels near Strait of Hormuz (26.56, 56.25)
    for (let i = 0; i < 10; i++) {
      processAisMessage(JSON.stringify({
        MetaData: { MMSI: 300000 + i, latitude: 26.5 + i * 0.01, longitude: 56.2 + i * 0.01, time_utc: new Date().toISOString(), ShipName: `Tanker ${i}` },
      }));
    }
    const snapshot = getSnapshot();
    assert.ok(Array.isArray(snapshot.disruptions), 'snapshot should have disruptions array');
    assert.ok(Array.isArray(snapshot.density), 'snapshot should have density array');
  });

  it('detects chokepoint congestion when >= 5 vessels in a chokepoint', () => {
    for (let i = 0; i < 6; i++) {
      processAisMessage(JSON.stringify({
        MetaData: { MMSI: 400000 + i, latitude: 26.56 + i * 0.01, longitude: 56.25 + i * 0.01, time_utc: new Date().toISOString() },
      }));
    }
    const snapshot = getSnapshot();
    const hormuz = snapshot.disruptions.find(d => d.name === 'Strait of Hormuz');
    assert.ok(hormuz, 'should detect Strait of Hormuz congestion');
    assert.strictEqual(hormuz.type, 'chokepoint_congestion');
    assert.ok(hormuz.vesselCount >= 5);
  });

  it('calculates density zones for cells with >= 2 vessels', () => {
    processAisMessage(JSON.stringify({
      MetaData: { MMSI: 500001, latitude: 10.5, longitude: 20.5 },
    }));
    processAisMessage(JSON.stringify({
      MetaData: { MMSI: 500002, latitude: 10.6, longitude: 20.6 },
    }));
    const snapshot = getSnapshot();
    assert.ok(snapshot.density.length >= 1, 'should have at least one density zone');
    assert.ok(snapshot.density[0].intensity > 0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd services && node --test ais-processor/test/ais-processor.test.cjs 2>&1
```

Expected: FAIL — `snapshot.disruptions` is undefined (not yet implemented).

**Step 3: Commit failing tests**

```bash
git add services/ais-processor/test/ais-processor.test.cjs
git commit -m "test(ais-processor): add failing tests for disruption detection and density zones"
```

---

## Task 9: AIS processor — implement disruption detection and density computation

**Files:**
- Modify: `services/ais-processor/index.cjs`

**Step 1: Add chokepoint definitions and tracking data structures**

After line 13 (`const REDIS_KEY = ...`), add:

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

**Step 2: Update `processAisMessage` to track history and chokepoint proximity**

After line 44 (`vessels.set(String(mmsi), updated);`), before `return updated;`, add:

```javascript
    const mmsiStr = String(mmsi);
    const history = vesselHistory.get(mmsiStr) || [];
    history.push(Date.now());
    if (history.length > 10) history.shift();
    vesselHistory.set(mmsiStr, history);

    if (typeof updated.lat === 'number' && typeof updated.lon === 'number') {
      for (const cp of CHOKEPOINTS) {
        const dist = Math.sqrt((updated.lat - cp.lat) ** 2 + (updated.lon - cp.lon) ** 2);
        if (dist <= cp.radius) {
          if (!chokepointBuckets.has(cp.name)) chokepointBuckets.set(cp.name, new Set());
          chokepointBuckets.get(cp.name).add(mmsiStr);
        }
      }
      const gLat = Math.floor(updated.lat / DENSITY_GRID_SIZE);
      const gLon = Math.floor(updated.lon / DENSITY_GRID_SIZE);
      const gridKey = `${gLat}_${gLon}`;
      if (!densityGrid.has(gridKey)) {
        densityGrid.set(gridKey, { lat: gLat * DENSITY_GRID_SIZE + DENSITY_GRID_SIZE / 2, lon: gLon * DENSITY_GRID_SIZE + DENSITY_GRID_SIZE / 2, vessels: new Set(), prevCount: 0 });
      }
      densityGrid.get(gridKey).vessels.add(mmsiStr);
    }
```

**Step 3: Add `detectDisruptions` function**

After the updated `processAisMessage`, before `getSnapshot`, add:

```javascript
function detectDisruptions() {
  const disruptions = [];
  for (const cp of CHOKEPOINTS) {
    const bucket = chokepointBuckets.get(cp.name);
    const vesselCount = bucket ? bucket.size : 0;
    if (vesselCount < 5) continue;
    const normalTraffic = Math.max(cp.radius * 10, 1);
    const changePct = Math.round(((vesselCount - normalTraffic) / normalTraffic) * 100);
    let severity = 'low';
    if (vesselCount > normalTraffic * 1.5) severity = 'high';
    else if (vesselCount > normalTraffic) severity = 'elevated';
    disruptions.push({
      id: `cp-${cp.name.toLowerCase().replace(/\s+/g, '-')}`,
      name: cp.name, type: 'chokepoint_congestion',
      lat: cp.lat, lon: cp.lon, severity, changePct, windowHours: 1,
      vesselCount, region: cp.region,
      description: `${vesselCount} vessels in ${cp.name} (${changePct > 0 ? '+' : ''}${changePct}% vs normal)`,
    });
  }
  let darkShipCount = 0;
  const now = Date.now();
  for (const [, history] of vesselHistory) {
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
      id: 'gap-spike-global', name: 'AIS Gap Spike', type: 'gap_spike',
      lat: 0, lon: 0, severity, changePct: 0, windowHours: 1,
      darkShips: darkShipCount, region: 'global',
      description: `${darkShipCount} vessels reappeared after extended AIS silence`,
    });
  }
  return disruptions;
}

function calculateDensityZones() {
  const zones = [];
  for (const [, cell] of densityGrid) {
    if (cell.vessels.size < 2) continue;
    const intensity = Math.min(1.0, 0.2 + Math.log10(cell.vessels.size) * 0.3);
    const deltaPct = cell.prevCount > 0 ? Math.round(((cell.vessels.size - cell.prevCount) / cell.prevCount) * 100) : 0;
    zones.push({
      id: `dz-${cell.lat.toFixed(0)}-${cell.lon.toFixed(0)}`,
      name: `Zone ${cell.lat.toFixed(0)}\u00B0, ${cell.lon.toFixed(0)}\u00B0`,
      lat: cell.lat, lon: cell.lon, intensity, deltaPct,
      shipsPerDay: cell.vessels.size * 48,
    });
  }
  zones.sort((a, b) => b.intensity - a.intensity);
  return zones.slice(0, MAX_DENSITY_ZONES);
}
```

**Step 4: Update `getSnapshot` to include disruptions and density**

Replace lines 52–65 (`function getSnapshot()`) with:

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

**Step 5: Update `_resetVessels` to also clear tracking state**

Replace lines 21–23:
```javascript
function _resetVessels() {
  vessels.clear();
  vesselHistory.clear();
  chokepointBuckets.clear();
  densityGrid.clear();
}
```

**Step 6: Run tests**

```bash
cd services && node --test ais-processor/test/ais-processor.test.cjs 2>&1
```

Expected: All tests PASS, including the new disruption/density tests.

**Step 7: Commit**

```bash
git add services/ais-processor/index.cjs
git commit -m "feat(ais-processor): add disruption detection and density zone computation"
```

---

## Task 10: Fix Climate handler — ensure it handles empty gracefully

**Files:**
- Modify: `src/data/geo-handler.ts:169-187`

**Step 1: Verify climate handler**

Current code (lines 169–187) already handles empty anomalies correctly by calling `setAnomalies([])`. No change needed unless the array adaptation fails. Read the code and verify:

```typescript
    climate: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:climate] skipped — invalid payload type:', typeof payload); return; }
      const resp = (Array.isArray(payload) ? { anomalies: payload } : payload) as ...;
      if (!Array.isArray(resp.anomalies)) {
        console.warn('[wm:climate] malformed payload — anomalies is not an array');
        (ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies([]);
        return;
      }
```

This already works. The panel not loading means the climate worker hasn't run (6-hour interval). The 15s fallback from Task 6 handles this.

**Step 2: Commit (skip if no changes)**

No code change needed — climate handler is already correct. The 15s fallback from Task 6 covers cold start.

---

## Task 11: Add Zod schema validation to relay-push dispatch

**Files:**
- Create: `src/data/channel-schemas.ts`
- Modify: `src/services/relay-push.ts:29-44`

**Step 1: Install Zod**

```bash
npm install zod
```

**Step 2: Create channel schemas file**

Create `src/data/channel-schemas.ts`:

```typescript
import { z } from 'zod';

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: z.object({ stocks: z.array(z.unknown()) }).passthrough(),
  predictions: z.union([z.array(z.unknown()), z.object({ markets: z.array(z.unknown()) }).passthrough()]),
  telegram: z.object({}).passthrough().refine(
    (obj) => 'items' in obj || 'messages' in obj,
    { message: 'Must have items or messages' },
  ),
  intelligence: z.object({}).passthrough(),
  conflict: z.object({ events: z.array(z.unknown()) }).passthrough(),
  ais: z.object({}).passthrough(),
  giving: z.object({}).passthrough(),
  climate: z.union([z.array(z.unknown()), z.object({ anomalies: z.array(z.unknown()) }).passthrough()]),
  fred: z.union([z.array(z.unknown()), z.object({ series: z.array(z.unknown()) }).passthrough()]),
  oil: z.union([z.array(z.unknown()), z.object({ prices: z.array(z.unknown()) }).passthrough()]),
  'ai:panel-summary': z.object({}).passthrough(),
  'ai:risk-overview': z.object({}).passthrough(),
  'ai:posture-analysis': z.object({}).passthrough(),
  gdelt: z.object({}).passthrough(),
  cyber: z.union([z.array(z.unknown()), z.object({ threats: z.array(z.unknown()) }).passthrough()]),
};
```

**Step 3: Add validation in relay-push dispatch**

In `src/services/relay-push.ts`, add import at top:
```typescript
import { channelSchemas } from '@/data/channel-schemas';
```

Then update the `dispatch` function (lines 29–44). After `setChannelState(channel, 'ready', ...)` on line 31, add:

```typescript
    const schema = channelSchemas[channel];
    if (schema) {
      const result = schema.safeParse(payload);
      if (!result.success) {
        console.warn(`[relay-push] schema mismatch (${channel}):`, result.error.issues.map(i => i.message).join('; '));
      }
    }
```

**Step 4: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/data/channel-schemas.ts src/services/relay-push.ts package.json package-lock.json
git commit -m "feat(relay-push): add Zod schema validation for top 15 channels"
```

---

## Task 12: Full build and verify

**Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: Zero errors.

**Step 2: Run full build**

```bash
npm run build
```

Expected: Build succeeds.

**Step 3: Run all backend tests**

```bash
cd services && node --test ais-processor/test/ais-processor.test.cjs && node --test gateway/test/gateway.test.cjs
```

Expected: All tests pass.

**Step 4: Verify no bare returns in handlers**

```bash
rg 'return;' src/data/*-handler.ts | rg -v 'showError|showUnavailable|setData|render|refresh|applyPush|setDigest|setEvents|setAnomalies|update|applyCable|applyCyber|applyRelay|logPayload|typeof payload|console\.' | head -20
```

Every remaining bare `return;` should be the initial type guard only.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors from panel data loading fix"
```

---

## Execution Order

| Task | Effort | Fixes |
|---|---|---|
| **1. GDELT applyRelayData** | 10 min | Live Intelligence panel |
| **2. Giving handler** | 15 min | Global Giving panel |
| **3. AI handler buffering** | 15 min | AI payload buffering |
| **4. Panel buffer consumption** | 20 min | AI Insights, Posture, Risk, Digest |
| **5. Telegram handler** | 10 min | Telegram Intel |
| **6. Fallback loads** | 10 min | Markets, Commodities, Climate |
| **7. Security Advisories** | 20 min | Security Advisories panel |
| **8. AIS failing tests** | 10 min | Test scaffolding |
| **9. AIS implementation** | 30 min | Disruptions + density |
| **10. Climate verify** | 5 min | (Already correct) |
| **11. Zod validation** | 20 min | Schema validation |
| **12. Build + verify** | 15 min | Everything compiles |

**Execute in order: 1→2→3→4→5→6→7→8→9→10→11→12**

---

## Success Criteria

1. All 13 named panels render data from Redis via WebSocket push-on-subscribe
2. Two clients opened at different times show identical data
3. AIS map layer shows disruptions and density zones alongside vessels
4. CII panel ingests AIS disruptions for country instability scoring
5. Security Advisories loads from relay instead of direct RSS fetch
6. Schema validation logs mismatches for top 15 channels without blocking rendering
7. `npm run build` completes with zero errors
8. AIS processor tests pass with disruption/density assertions
