# Frontend Refactoring Plan: Kill the God Files

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Break apart god files and introduce a channel registry so data flows are traceable, debuggable, and every panel either shows data or a useful error.

**Tech Stack:** TypeScript (Vite frontend), vanilla DOM (no React)

---

## Current Architecture Problems

### The God Files

| File | Lines | What it does (everything) |
|------|-------|--------------------------|
| `data-loader.ts` | **2,539** | 100+ imports, 40+ `apply*` methods, 20+ `load*` methods, data fetching, data transformation, panel rendering, map updating, signal aggregation, CII ingestion, search indexing, news classification, breaking alerts, military analysis, fire processing — ALL in one class |
| `DeckGLMap.ts` | **4,604** | All map rendering, all layer management, all popups |
| `Map.ts` | **3,660** | Map container wrapper |
| `MapPopup.ts` | **2,675** | All popup types |
| `panel-layout.ts` | **1,160** | All panel creation and layout |
| `event-handlers.ts` | **1,022** | All event handling |
| `panels.ts` | **725** | 4 variants × 3 layer configs = 12 nearly-identical objects |
| `App.ts` | **687** | Init, 95-line `setupRelayPush()` manually wiring 40+ handlers |
| `gateway/index.cjs` | **538** | Channel registry, HTTP routing, WS handling, gRPC, envelope unwrapping |

### The God Object

`AppContext` (135 lines) holds **50+ fields** in one mutable bag. Every module reads and writes from the same object. No domain isolation — markets, intelligence, weather, conflicts all share the same state.

### The "4 Registries" Problem (Root Cause of Missing Data)

A channel must be registered in **4 separate places** that can silently get out of sync:

1. **`RELAY_CHANNELS`** (`bootstrap.ts`) — what to fetch on bootstrap + subscribe via WS
2. **`PHASE4_CHANNEL_KEYS`** (`gateway/index.cjs`) — what the gateway knows about (Redis key mapping)
3. **`setupRelayPush()`** (`App.ts`) — what handlers are wired for incoming WS pushes
4. **`apply*` methods** (`data-loader.ts`) — what actually processes the data
5. **`DEFAULT_PANELS`** (`panels.ts`) — what panels exist and what channels they declare

If **any one** of these is missing or mismatched, the panel shows "No data", "Loading...", or "Failed to load".

### Current Channel Audit

Channels in `RELAY_CHANNELS` (43 total):
```
markets, predictions, fred, oil, bis, flights, weather, natural, eonet, gdacs,
gps-interference, cables, cyber, climate, conflict, ucdp-events, telegram, oref,
ais, intelligence, trade, supply-chain, giving, spending, gulf-quotes, tech-events,
strategic-posture, strategic-risk, stablecoins, etf-flows, macro-signals,
service-status, config:news-sources, config:feature-flags, iran-events,
ai:intel-digest, ai:panel-summary, ai:article-summaries, ai:classifications,
ai:country-briefs, ai:posture-analysis, ai:instability-analysis, ai:risk-overview
```

Channels with handlers in `setupRelayPush()`: **All 43 are wired** — so the handler wiring is actually complete.

Channels in `PHASE4_CHANNEL_KEYS` (gateway): **All present** — gateway knows about all channels.

**So why no data?** The problem isn't missing wiring — it's that:
1. `loadAllData()` is a **no-op** (line 252: just calls `updateSearchIndex()`) — it relies entirely on bootstrap HTTP + WebSocket push
2. If bootstrap returns empty (server returns `{ status: 'pending' }` when Redis has no data), **nothing loads**
3. If WebSocket push hasn't arrived yet, **nothing loads**
4. There is **no retry, no timeout, no "data expected but not received" detection**
5. Panels show "Loading..." forever because there's no mechanism to transition to a useful error state

### Specific Failures Visible in Screenshots

| Panel | What's shown | Root cause |
|-------|-------------|------------|
| Latest Headlines | "No data" | News digest not in Redis → bootstrap returns nothing → no WS push yet |
| AI Insights | "Loading..." forever | `insights` panel has no channel — it's rendered from clustered news, which requires news + intelligence data that never arrived |
| AI Strategic Posture | Spinner | `strategic-posture` channel data missing from Redis |
| Country Instability | "Loading..." | CII depends on ~15 other data sources (conflicts, protests, military, etc.) that all need to arrive first |
| World News | 0 count + Loading | Same as Headlines — news digest not available |
| Commodities | "Failed to load commodities" | `fred`, `oil`, `bis` channels missing from Redis |
| Markets | "Failed to load market data" | `markets` channel data missing from Redis |

---

## Refactoring Plan

### Phase 1: Channel Registry (Single Source of Truth)

**Goal:** One place defines everything about a channel — its Redis key, panel mapping, data type, fallback behavior, and timeout.

#### Task 1.1: Create `src/config/channel-registry.ts`

```typescript
export interface ChannelDefinition {
  key: string;                          // e.g. 'markets'
  redisKey: string;                     // e.g. 'market:dashboard:v1'
  panels: string[];                     // panels that consume this channel
  domain: DataDomain;                   // for grouping apply* handlers
  staleAfterMs: number;                 // when to show "stale" warning
  timeoutMs: number;                    // when to show error instead of loading
  required: boolean;                    // show error vs silently hide if missing
  mapLayers?: (keyof MapLayers)[];      // which map layers this feeds
}

export type DataDomain =
  | 'news'
  | 'markets'
  | 'economic'
  | 'intelligence'
  | 'geo'           // natural, weather, climate
  | 'military'
  | 'infrastructure' // cables, outages, cyber
  | 'ai'
  | 'config';

export const CHANNEL_REGISTRY: Record<string, ChannelDefinition> = {
  markets: {
    key: 'markets',
    redisKey: 'market:dashboard:v1',
    panels: ['markets', 'heatmap'],
    domain: 'markets',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: true,
  },
  fred: {
    key: 'fred',
    redisKey: 'relay:fred:v1',
    panels: ['commodities', 'economic'],
    domain: 'economic',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
  },
  // ... all channels defined here
};

// Derived constants (replaces RELAY_CHANNELS, PHASE4_CHANNEL_KEYS)
export const RELAY_CHANNELS = Object.keys(CHANNEL_REGISTRY);
export const REDIS_KEY_MAP = Object.fromEntries(
  Object.entries(CHANNEL_REGISTRY).map(([k, v]) => [k, v.redisKey])
);
```

**Why:** Eliminates the 4-registry sync problem. Gateway imports this file (or it's duplicated into CJS and kept in sync via tests). Adding a new channel = adding one entry.

#### Task 1.2: Generate gateway channel keys from registry

Update `services/gateway/index.cjs` to read from a shared channel map (or a JSON file generated from the registry at build time) instead of its own hardcoded `PHASE4_CHANNEL_KEYS`.

#### Task 1.3: Replace `RELAY_CHANNELS` in `bootstrap.ts`

Import from registry. Delete the hardcoded array.

#### Task 1.4: Auto-wire `setupRelayPush()` from registry

Replace the 95-line manual wiring in `App.ts` with a loop:

```typescript
for (const [channel, def] of Object.entries(CHANNEL_REGISTRY)) {
  const handler = this.dataLoader.getHandler(channel);
  if (handler) subscribeRelayPush(channel, handler);
}
```

---

### Phase 2: Break Apart `data-loader.ts` (2,539 → ~8 files of 200-400 lines each)

**Goal:** Split by domain. Each domain module owns its `apply*` and `load*` methods.

#### Task 2.1: Create domain handler modules

| New file | Domain | Channels | Lines (est.) |
|----------|--------|----------|-------------|
| `src/data/news-handler.ts` | news | `news:*`, headlines, insights | ~400 |
| `src/data/markets-handler.ts` | markets | markets, predictions, stablecoins, etf-flows, macro-signals, gulf-quotes, crypto | ~300 |
| `src/data/economic-handler.ts` | economic | fred, oil, bis, trade, supply-chain, spending, giving | ~300 |
| `src/data/intelligence-handler.ts` | intelligence | intelligence, conflict, ucdp-events, telegram, oref, iran-events, strategic-posture, strategic-risk | ~350 |
| `src/data/geo-handler.ts` | geo | natural, eonet, gdacs, weather, climate, gps-interference | ~250 |
| `src/data/infrastructure-handler.ts` | infrastructure | cables, cyber, flights, ais, service-status | ~250 |
| `src/data/ai-handler.ts` | ai | ai:intel-digest, ai:panel-summary, ai:article-summaries, ai:classifications, ai:country-briefs, ai:posture-analysis, ai:instability-analysis, ai:risk-overview | ~200 |
| `src/data/config-handler.ts` | config | config:news-sources, config:feature-flags | ~50 |

Each module exports a handler map:

```typescript
// src/data/markets-handler.ts
export function createMarketsHandlers(ctx: AppContext): Record<string, ChannelHandler> {
  return {
    'markets': (payload) => { /* apply markets data */ },
    'predictions': (payload) => { /* apply predictions */ },
    'stablecoins': (payload) => { /* forward to panel */ },
    // ...
  };
}
```

#### Task 2.2: Create `DataLoaderManager` as thin orchestrator

The new `data-loader.ts` becomes ~150 lines: it imports the domain modules, registers handlers, and delegates. It owns `loadChannelWithFallback()` and `loadDataForLayer()` but nothing else.

```typescript
export class DataLoaderManager {
  private handlers: Map<string, ChannelHandler>;

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this.handlers = new Map([
      ...Object.entries(createNewsHandlers(ctx)),
      ...Object.entries(createMarketsHandlers(ctx)),
      ...Object.entries(createEconomicHandlers(ctx)),
      ...Object.entries(createIntelligenceHandlers(ctx)),
      ...Object.entries(createGeoHandlers(ctx)),
      ...Object.entries(createInfrastructureHandlers(ctx)),
      ...Object.entries(createAiHandlers(ctx)),
      ...Object.entries(createConfigHandlers()),
    ]);
  }

  getHandler(channel: string): ChannelHandler | undefined {
    return this.handlers.get(channel);
  }
}
```

#### Task 2.3: Move `loadDataForLayer` switch into domain modules

Each domain module owns its `load*` methods. The `loadDataForLayer` switch statement dispatches to the right module based on `CHANNEL_REGISTRY[channel].domain`.

---

### Phase 3: Channel Data State Machine

**Goal:** Every channel has a known state: `idle | loading | ready | stale | error`. Panels query this state to show appropriate UI.

#### Task 3.1: Create `src/services/channel-state.ts`

```typescript
export type ChannelState = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

export interface ChannelStatus {
  state: ChannelState;
  lastDataAt: number | null;
  error: string | null;
  source: 'bootstrap' | 'websocket' | 'http-fallback' | null;
}

const channelStates = new Map<string, ChannelStatus>();

export function setChannelState(channel: string, state: ChannelState, source?: string): void { ... }
export function getChannelState(channel: string): ChannelStatus { ... }
export function subscribeChannelState(channel: string, cb: (status: ChannelStatus) => void): () => void { ... }
```

#### Task 3.2: Wire state transitions

- Bootstrap marks channels as `loading` before fetch, `ready` or `error` after
- WebSocket push marks channel as `ready` with timestamp
- A periodic check marks channels as `stale` when data is older than `staleAfterMs`
- Panels subscribe to their channels' state and show appropriate UI

#### Task 3.3: Add timeout detection

After `timeoutMs`, if a channel is still `loading`, transition to `error` with message "Service unavailable — data not received". This replaces the forever-spinner.

---

### Phase 4: Slim Down `AppContext`

**Goal:** Replace the god object with domain-specific stores.

#### Task 4.1: Extract domain stores

```typescript
// src/stores/news-store.ts
export const newsStore = {
  allNews: [] as NewsItem[],
  newsByCategory: {} as Record<string, NewsItem[]>,
  latestClusters: [] as ClusteredEvent[],
};

// src/stores/markets-store.ts
export const marketsStore = {
  latestMarkets: [] as MarketData[],
  latestPredictions: [] as PredictionMarket[],
};

// src/stores/intel-store.ts
export const intelStore = {
  intelligenceCache: {} as IntelligenceCache,
  cyberThreatsCache: null as CyberThreat[] | null,
};
```

#### Task 4.2: Slim `AppContext` to UI-only concerns

`AppContext` keeps only: `map`, `panels`, `panelSettings`, `container`, `isMobile`, UI modals. Domain data lives in domain stores.

---

### Phase 5: Panel Self-Registration

**Goal:** Panels declare what channels they need. If data arrives, they render. If not, they show their own loading/error state based on channel state.

#### Task 5.1: Add `channels` to `Panel` base class

```typescript
abstract class Panel {
  abstract readonly channels: string[];

  protected onChannelReady(channel: string, data: unknown): void {
    // Override in subclass
  }

  protected onChannelError(channel: string, error: string): void {
    this.renderError(error);
  }
}
```

#### Task 5.2: Auto-subscribe panels to channel state

When a panel is created, it automatically subscribes to state changes for its declared channels. No more manual wiring needed.

---

## Execution Order

| Phase | Risk | Effort | Impact |
|-------|------|--------|--------|
| **1. Channel Registry** | Low | 1 day | Eliminates sync bugs, makes channel inventory visible |
| **3. Channel State Machine** | Low | 1 day | Fixes "Loading... forever", gives real error messages |
| **2. Split data-loader.ts** | Medium | 2-3 days | Makes each domain debuggable in isolation |
| **4. Slim AppContext** | Medium | 1-2 days | Decouples domain data from UI state |
| **5. Panel Self-Registration** | Medium | 1-2 days | Eliminates manual wiring, panels become autonomous |

**Recommended start:** Phase 1 + Phase 3 together (2 days). This fixes the user-facing problem (panels stuck on "Loading...") and creates the foundation for Phase 2.

---

## What This Does NOT Cover

- **Map refactoring** (`DeckGLMap.ts` at 4,604 lines) — separate effort
- **Backend service issues** (workers not populating Redis) — separate debugging
- **React migration** — not proposed, vanilla TS is fine, the problem is organization not framework
- **Panel layout refactoring** (`panel-layout.ts`) — can happen later

---

## Success Criteria

1. Adding a new channel = adding 1 entry to `CHANNEL_REGISTRY` + 1 handler function
2. Every panel shows "Loading..." for max 30 seconds, then a useful error or "stale" badge
3. `data-loader.ts` is deleted; no file in `src/data/` exceeds 400 lines
4. `AppContext` holds < 15 fields (UI concerns only)
5. `console.warn` in `relay-push.ts` for `hasData: false` drops to zero in normal operation
