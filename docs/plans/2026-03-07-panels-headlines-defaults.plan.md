# Panel Fixes, Sane Defaults & Headlines Panel

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs (panels not receiving data, AIS flooding all clients), reduce default-enabled panels from 45 to 21, build a new aggregate Latest Headlines panel, and eliminate god-function patterns in touched code.

**Architecture:** The app is a vanilla TypeScript SPA (Vite + Tauri). Panel configuration lives in `src/config/panels.ts` as `DEFAULT_PANELS`. On startup, `src/App.ts` loads settings from localStorage and merges with defaults — but the merge is shallow, losing new properties like `channels`. The relay server (`scripts/ais-relay.cjs`) has a raw AIS message fanout that bypasses the demand-driven channel subscription system. The new Headlines panel aggregates `ctx.allNews` into a reverse-chronological feed.

**Tech Stack:** Vanilla TypeScript, Vite, WebSocket relay (Node.js/Express), CSS

**Worktree:** `.worktrees/fix-panels-headlines` on branch `fix/panels-headlines-defaults`

---

## Key Architecture Notes (read before implementing)

### Panel System

- **Base class:** `Panel` in `src/components/Panel.ts`. Constructor takes `PanelOptions { id, title, showCount?, className?, trackActivity?, infoTooltip? }`.
- **DOM helper imports:** `import { h, text } from '@/utils/dom-utils'` — `h()` creates elements, `text()` creates text nodes. There is **no** `safeText()`. For HTML escaping, use `import { escapeHtml } from '@/utils/sanitize'`.
- **Content area:** `this.content` is a `div.panel-content`. Use `this.content.innerHTML`, `this.content.replaceChildren()`, or `this.content.appendChild()`. `setContent(html)` is debounced (150ms) — avoid for real-time updates.
- **Loading state:** `this.showLoading()` (not `setLoading()`).
- **Show/hide:** `toggle(visible)`, `show()`, `hide()`. Uses CSS class `hidden`.

### Panel Grid & Order

- Panels register in `this.ctx.panels[key]` during `createPanels()` in `src/app/panel-layout.ts`.
- After all panels are created (line 782), the order is resolved:
  - `defaultOrder = Object.keys(DEFAULT_PANELS).filter(k => k !== 'map')` — **order in `DEFAULT_PANELS` determines default display order**.
  - Saved order from localStorage is merged: new panels are inserted after `'politics'`.
  - Panels are appended to `panelsGrid` via `panelOrder.forEach(key => panelsGrid.appendChild(panel.getElement()))` (line 840).
- **Key insight:** Adding `'headlines'` to `DEFAULT_PANELS` at position 3 (after `live-news`) automatically places it there for new users. Existing users get it inserted after `'politics'` (the merge logic at line 797).

### NewsItem Type

```typescript
// src/types/index.ts:23-39
interface NewsItem {
  source: string;       // feed/source name
  title: string;
  link: string;
  pubDate: Date;        // publication date — this is the ONLY time field
  isAlert: boolean;
  tier?: number;
  lat?: number;
  lon?: number;
  locationName?: string;
  lang?: string;
  imageUrl?: string;
  // ... other optional fields
}
```

- **No `fetchedAt` field.** Only `pubDate: Date`.
- **No `category` field.** Category comes from the key in `newsByCategory` map. The `source` field has the feed name.

### Styles

- All panel CSS is centralized in `src/styles/panels.css` (imported via `main.css`).
- No per-panel CSS files.

### Localization

- Panel names use `t('panels.camelCaseKey')` — locale files at `src/locales/*.json`.
- The `panels` section in `en.json` uses camelCase keys (e.g., `"strategicRisk"`, `"gdeltIntel"`).
- New panels need entries in all locale files (at minimum `en.json`).

### Data Flow

- `ctx.allNews` is populated in two places in `src/app/data-loader.ts`:
  - `loadNews()` at line 664: `this.ctx.allNews = collectedNews`
  - `processDigestData()` at line 2149: `this.ctx.allNews = collectedNews`
- After each assignment, these consumers run: `updateHotspotActivity()`, `updateMonitorResults()`, `clusterNews()` → `InsightsPanel`.

### Channel Subscription

- `subscribedChannels` array in `src/services/relay-push.ts` tracks what's subscribed.
- On reconnect, all `subscribedChannels` are re-sent to the relay.
- `subscribeChannel(ch)` / `unsubscribeChannel(ch)` update the array and send WS messages.
- `setupRelayPush()` in `App.ts` (line 573) computes initial channels from `alwaysOn` + `demandChannels` (panels with `config.channels`).

---

## Bug Analysis

### Bug 1: Panels not receiving data

**Root cause:** `src/App.ts` lines 95-104 — shallow merge from localStorage.

When a user's localStorage has panel settings saved (before the `channels` property existed), the stored object overwrites the default. The merge loop (lines 99-104) only adds panels that are **completely missing** — it never backfills new properties on existing panels.

```typescript
// CURRENT (broken) — App.ts:95-104
panelSettings = loadFromStorage<Record<string, PanelConfig>>(
  STORAGE_KEYS.panels,
  DEFAULT_PANELS
);
for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
  if (!(key in panelSettings)) {
    panelSettings[key] = { ...config };
  }
}
```

Result: `panelSettings['strategic-posture'].channels` is `undefined` for returning users → `setupRelayPush()` builds `demandChannels` without these channels → no channel subscription → no push data.

### Bug 2: AIS data flooding all clients

**Root cause:** `scripts/ais-relay.cjs` lines 2564-2576 — raw AIS message fanout.

Every 50th raw AIS message is sent to **all connected WebSocket clients** (`clients` set) regardless of whether they subscribed to the `ais` channel. The demand-driven system uses `channelSubscribers.get('ais')`, but this fanout iterates the global `clients` set.

```javascript
// CURRENT (broken) — ais-relay.cjs:2566
if (clients.size > 0 && messageCount % 50 === 0) {
  const message = raw.toString();
  for (const client of clients) { // ← sends to ALL clients
```

The only other iteration of `clients` is in `gracefulShutdown()` (line 7862) which is correct.

### Bug 3: Dead code risk

`src/services/maritime/index.ts` line 420 — deprecated `fetchAisSignals()` still calls `startPolling()`. Although unused, it's a trap for future developers.

---

## Task 1: Fix panel settings deep-merge (channels hydration)

**Files:**
- Modify: `src/App.ts:95-104`

**Step 1: Replace the shallow merge with a deep-merge that backfills structural properties**

In `src/App.ts`, replace lines 95-104 with:

```typescript
panelSettings = loadFromStorage<Record<string, PanelConfig>>(
  STORAGE_KEYS.panels,
  DEFAULT_PANELS
);
for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
  if (key in panelSettings) {
    if (config.channels) panelSettings[key].channels = config.channels;
    if (config.requiredFeature) panelSettings[key].requiredFeature = config.requiredFeature;
    if (config.priority !== undefined) panelSettings[key].priority = config.priority;
  } else {
    panelSettings[key] = { ...config };
  }
}
```

**Why:** Always hydrate `channels`, `requiredFeature`, and `priority` from `DEFAULT_PANELS` for existing panels. Never overwrite the user's `enabled` choice.

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean (0 errors)

**Step 3: Commit**

```bash
git add src/App.ts
git commit -m "fix: deep-merge panel settings to hydrate channels from defaults"
```

---

## Task 2: Fix AIS relay raw message fanout

**Files:**
- Modify: `scripts/ais-relay.cjs:2564-2576`

**Step 1: Gate the fanout on AIS channel subscribers**

Replace the raw message fanout block (lines 2564-2576 of `scripts/ais-relay.cjs`) with:

```javascript
  // Heavily throttled WS fanout: every 50th message, AIS subscribers only
  if (messageCount % 50 === 0) {
    const aisSubs = channelSubscribers.get('ais');
    if (aisSubs && aisSubs.size > 0) {
      const message = raw.toString();
      for (const ws of aisSubs) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1024 * 1024) {
          ws.send(message);
        }
      }
    }
  }
```

**Why:** Uses `channelSubscribers.get('ais')` instead of `clients`. Only clients that explicitly subscribed to `ais` via `wm-subscribe` receive raw AIS data.

**Step 2: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "fix(relay): gate raw AIS fanout on channel subscribers only"
```

---

## Task 3: Remove dead `startPolling()` from deprecated function

**Files:**
- Modify: `src/services/maritime/index.ts:415-430`

**Step 1: Remove `startPolling()` call from `fetchAisSignals()`**

In `src/services/maritime/index.ts`, delete the `startPolling();` call at line 420 inside `fetchAisSignals()`. The function should become:

```typescript
export async function fetchAisSignals(): Promise<{ disruptions: AisDisruptionEvent[]; density: AisDensityZone[] }> {
  if (!aisConfigured) {
    return { disruptions: [], density: [] };
  }

  const shouldRefresh = Date.now() - lastPollAt > SNAPSHOT_STALE_MS;
  if (shouldRefresh) {
    await pollSnapshot(true);
  }

  return {
    disruptions: latestDisruptions,
    density: latestDensity,
  };
}
```

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 3: Commit**

```bash
git add src/services/maritime/index.ts
git commit -m "fix: remove startPolling from deprecated fetchAisSignals"
```

---

## Task 4: Set sane panel defaults (45 → 21 enabled)

**Files:**
- Modify: `src/config/panels.ts:10-59` (FULL_PANELS)
- Modify: `src/config/panels.ts:611-616` (PANEL_CATEGORY_MAP core panelKeys)
- Modify: `src/App.ts` (one-time migration for existing users)
- Modify: `src/locales/en.json` (add `headlines` key)

**Step 1: Update FULL_PANELS defaults**

Replace lines 10-59 of `src/config/panels.ts` with the following. **21 panels** have `enabled: true`; everything else is `enabled: false`. The key order determines default grid display order — `headlines` is placed at position 3:

```typescript
const FULL_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Map', enabled: true, priority: 1 },
  'live-news': { name: 'Live News', enabled: true, priority: 1 },
  headlines: { name: 'Latest Headlines', enabled: true, priority: 1 },
  'live-webcams': { name: 'Live Webcams', enabled: false, priority: 1 },
  insights: { name: 'AI Insights', enabled: true, priority: 1 },
  'strategic-posture': { name: 'AI Strategic Posture', enabled: true, priority: 1, channels: ['strategic-posture'] },
  cii: { name: 'Country Instability', enabled: true, priority: 1 },
  'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1, channels: ['strategic-risk'] },
  intel: { name: 'Intel Feed', enabled: true, priority: 1 },
  'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 1 },
  'global-digest': { name: 'Intelligence Digest', enabled: true, priority: 1 },
  cascade: { name: 'Infrastructure Cascade', enabled: true, priority: 1 },
  politics: { name: 'World News', enabled: true, priority: 1 },
  us: { name: 'United States', enabled: false, priority: 1 },
  europe: { name: 'Europe', enabled: false, priority: 1 },
  middleeast: { name: 'Middle East', enabled: false, priority: 1 },
  africa: { name: 'Africa', enabled: false, priority: 1 },
  latam: { name: 'Latin America', enabled: false, priority: 1 },
  asia: { name: 'Asia-Pacific', enabled: false, priority: 1 },
  energy: { name: 'Energy & Resources', enabled: false, priority: 1 },
  gov: { name: 'Government', enabled: false, priority: 1 },
  thinktanks: { name: 'Think Tanks', enabled: false, priority: 1 },
  polymarket: { name: 'Predictions', enabled: false, priority: 1, channels: ['predictions'] },
  commodities: { name: 'Commodities', enabled: true, priority: 1, channels: ['fred', 'oil', 'bis', 'trade', 'supply-chain'] },
  markets: { name: 'Markets', enabled: true, priority: 1, requiredFeature: 'finnhubMarkets' },
  economic: { name: 'Economic Indicators', enabled: false, priority: 1, requiredFeature: 'economicFred' },
  'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1, requiredFeature: 'wtoTrade' },
  'supply-chain': { name: 'Supply Chain', enabled: false, priority: 1, requiredFeature: 'supplyChain' },
  finance: { name: 'Financial', enabled: true, priority: 1 },
  tech: { name: 'Technology', enabled: false, priority: 2 },
  crypto: { name: 'Crypto', enabled: true, priority: 2 },
  heatmap: { name: 'Sector Heatmap', enabled: false, priority: 2, requiredFeature: 'finnhubMarkets' },
  ai: { name: 'AI/ML', enabled: false, priority: 2 },
  layoffs: { name: 'Layoffs Tracker', enabled: false, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
  'satellite-fires': { name: 'Fires', enabled: false, priority: 2, requiredFeature: 'nasaFirms' },
  'macro-signals': { name: 'Market Radar', enabled: false, priority: 2, channels: ['macro-signals'] },
  'gulf-economies': { name: 'Gulf Economies', enabled: false, priority: 2, channels: ['gulf-quotes'] },
  'etf-flows': { name: 'BTC ETF Tracker', enabled: false, priority: 2, channels: ['etf-flows'] },
  stablecoins: { name: 'Stablecoins', enabled: false, priority: 2, channels: ['stablecoins'] },
  'ucdp-events': { name: 'UCDP Conflict Events', enabled: false, priority: 2 },
  giving: { name: 'Global Giving', enabled: false, priority: 2, channels: ['giving'] },
  displacement: { name: 'UNHCR Displacement', enabled: false, priority: 2 },
  climate: { name: 'Climate Anomalies', enabled: false, priority: 2 },
  'population-exposure': { name: 'Population Exposure', enabled: false, priority: 2 },
  'security-advisories': { name: 'Security Advisories', enabled: true, priority: 2 },
  'oref-sirens': { name: 'Israel Sirens', enabled: false, priority: 2 },
  'telegram-intel': { name: 'Telegram Intel', enabled: true, priority: 2, channels: ['telegram'] },
  'world-clock': { name: 'World Clock', enabled: true, priority: 2 },
};
```

**Step 2: Add `headlines` to `PANEL_CATEGORY_MAP` core category**

In `src/config/panels.ts`, update the `core` entry in `PANEL_CATEGORY_MAP` (around line 613):

```typescript
core: {
  labelKey: 'header.panelCatCore',
  panelKeys: ['map', 'live-news', 'headlines', 'live-webcams', 'insights', 'strategic-posture'],
},
```

**Step 3: Add locale entry for headlines**

In `src/locales/en.json`, inside the `"panels"` section (after line 200), add:

```json
"headlines": "Latest Headlines",
```

**Step 4: Add one-time migration for existing users**

In `src/App.ts`, after the deep-merge loop from Task 1 (and after the existing `PANEL_ORDER_MIGRATION_KEY` migrations), add:

```typescript
const PANEL_DEFAULTS_V2_KEY = 'worldmonitor-panel-defaults-v2';
if (!localStorage.getItem(PANEL_DEFAULTS_V2_KEY)) {
  for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
    if (key in panelSettings) {
      panelSettings[key].enabled = config.enabled;
    }
  }
  localStorage.setItem(PANEL_DEFAULTS_V2_KEY, '1');
}
```

**Why:** Existing users had 45 panels enabled. This one-time migration resets their `enabled` states to the new defaults. The migration key prevents it from running again.

**Step 5: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 6: Commit**

```bash
git add src/config/panels.ts src/App.ts src/locales/en.json
git commit -m "feat: reduce default-enabled panels from 45 to 21, add headlines to config"
```

---

## Task 5: Build the Latest Headlines panel

**Files:**
- Create: `src/components/HeadlinesPanel.ts`
- Modify: `src/styles/panels.css` (add headlines styles)
- Modify: `src/app/panel-layout.ts` (register panel in `createPanels()`)
- Modify: `src/app/data-loader.ts` (feed allNews into Headlines after both assignment points)

### Step 1: Create `src/components/HeadlinesPanel.ts`

```typescript
import { Panel } from './Panel';
import { h, text } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/locales';
import type { NewsItem } from '@/types';

const MAX_ITEMS = 50;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export class HeadlinesPanel extends Panel {
  private seenKeys = new Set<string>();
  private items: NewsItem[] = [];

  constructor() {
    super({
      id: 'headlines',
      title: t('panels.headlines'),
      showCount: true,
      trackActivity: true,
    });
    this.showLoading();
  }

  renderItems(allNews: NewsItem[]): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    this.seenKeys.clear();
    this.items = [];

    const sorted = allNews
      .filter(item => item.pubDate.getTime() > cutoff)
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

    for (const item of sorted) {
      const key = item.link || item.title;
      if (this.seenKeys.has(key)) continue;
      this.seenKeys.add(key);
      this.items.push(item);
      if (this.items.length >= MAX_ITEMS) break;
    }

    this.setCount(this.items.length);
    this.renderList();
  }

  private renderList(): void {
    if (this.items.length === 0) {
      this.content.innerHTML = '<div class="panel-empty">No headlines yet</div>';
      return;
    }

    const list = h('div', { className: 'headlines-list' });

    for (const item of this.items) {
      const ago = this.timeAgo(item.pubDate);

      const row = h('div', { className: 'headline-row' });

      const meta = h('div', { className: 'headline-meta' });
      if (item.source) {
        const badge = h('span', { className: 'headline-source' });
        badge.appendChild(text(item.source));
        meta.appendChild(badge);
      }
      const timeEl = h('span', { className: 'headline-time' });
      timeEl.appendChild(text(ago));
      meta.appendChild(timeEl);
      row.appendChild(meta);

      if (item.link) {
        const link = h('a', {
          className: 'headline-title',
          href: item.link,
          target: '_blank',
          rel: 'noopener noreferrer',
        });
        link.appendChild(text(item.title));
        row.appendChild(link);
      } else {
        const span = h('span', { className: 'headline-title' });
        span.appendChild(text(item.title));
        row.appendChild(span);
      }

      list.appendChild(row);
    }

    this.content.replaceChildren(list);
  }

  private timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
```

### Step 2: Add CSS to `src/styles/panels.css`

Append to the end of `src/styles/panels.css`:

```css
/* ── Headlines Panel ── */
.headlines-list {
  display: flex;
  flex-direction: column;
  max-height: 500px;
  overflow-y: auto;
}

.headline-row {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.headline-row:hover {
  background: var(--hover-bg, rgba(255,255,255,0.04));
}

.headline-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.7rem;
  opacity: 0.6;
}

.headline-source {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.headline-time {
  white-space: nowrap;
}

.headline-title {
  font-size: 0.82rem;
  line-height: 1.35;
  color: var(--text-primary, #e0e0e0);
  text-decoration: none;
}

a.headline-title:hover {
  text-decoration: underline;
  color: var(--accent-color, #64b5f6);
}
```

### Step 3: Register in `panel-layout.ts` `createPanels()`

In `src/app/panel-layout.ts`, inside `createPanels()`, add the HeadlinesPanel creation. Place it in the `SITE_VARIANT === 'full'` block (after line 583, near the other full-variant panels) since it only applies to the full variant:

```typescript
const { HeadlinesPanel } = await import('@/components/HeadlinesPanel');
const headlinesPanel = new HeadlinesPanel();
this.ctx.panels['headlines'] = headlinesPanel;
```

The panel will be automatically attached to the grid by the existing `panelOrder.forEach` loop (line 840) since `'headlines'` is now a key in `DEFAULT_PANELS`.

### Step 4: Feed allNews into HeadlinesPanel from data-loader

In `src/app/data-loader.ts`, add a helper method to the `DataLoaderManager` class and call it after each `allNews` assignment.

Add the method:

```typescript
private updateHeadlinesPanel(): void {
  const panel = this.ctx.panels['headlines'];
  if (panel && 'renderItems' in panel) {
    (panel as import('@/components/HeadlinesPanel').HeadlinesPanel).renderItems(this.ctx.allNews);
  }
}
```

Call it after `this.updateMonitorResults()` in both places:
- In `loadNews()` (after line 678): add `this.updateHeadlinesPanel();`
- In `processDigestData()` (after line 2163): add `this.updateHeadlinesPanel();`

### Step 5: Verify type-check and build

Run: `npx tsc --noEmit`
Expected: Clean

Run: `npx vite build`
Expected: Build succeeds

### Step 6: Commit

```bash
git add src/components/HeadlinesPanel.ts src/styles/panels.css src/app/panel-layout.ts src/app/data-loader.ts
git commit -m "feat: add Latest Headlines aggregate panel"
```

---

## Task 6: Refactor `createPanels()` — extract NewsPanel registry (god-function fix)

**Files:**
- Modify: `src/app/panel-layout.ts:396-569`

The `createPanels()` method has ~25 identical blocks of:
```typescript
const xxxPanel = new NewsPanel('xxx', t('panels.xxx'));
this.attachRelatedAssetHandlers(xxxPanel);
this.ctx.newsPanels['xxx'] = xxxPanel;
this.ctx.panels['xxx'] = xxxPanel;
```

### Step 1: Define a news panel keys array

Near the top of `src/app/panel-layout.ts` (after imports), add:

```typescript
const NEWS_PANEL_KEYS = [
  'politics', 'tech', 'finance', 'gov', 'intel', 'energy',
  'africa', 'latam', 'asia', 'us', 'europe', 'middleeast',
  'ai', 'layoffs', 'thinktanks',
  'startups', 'vcblogs', 'regionalStartups', 'unicorns',
  'accelerators', 'funding', 'producthunt', 'security',
  'policy', 'hardware', 'cloud', 'dev', 'github', 'ipo',
] as const;
```

### Step 2: Replace repetitive NewsPanel blocks with a loop

Remove the ~25 individual `new NewsPanel(key, ...)` blocks (lines 396-569) and replace with:

```typescript
for (const key of NEWS_PANEL_KEYS) {
  const label = DEFAULT_PANELS[key]?.name ?? t(`panels.${key}`);
  const panel = new NewsPanel(key, label);
  this.attachRelatedAssetHandlers(panel);
  this.ctx.newsPanels[key] = panel;
  this.ctx.panels[key] = panel;
}
```

**Keep the following as explicit instantiations** (they have unique constructors/setup):
- `HeatmapPanel`, `MarketPanel`, `MonitorPanel`, `CommoditiesPanel`, `PredictionPanel`, `CryptoPanel`, `EconomicPanel`, `TradePolicyPanel`, `SupplyChainPanel`

### Step 3: Preserve the dynamic feed-based panel loop (lines 569-581)

The existing loop that creates panels for any feed categories not already registered should remain as-is:

```typescript
for (const key of Object.keys(feeds)) {
  if (this.ctx.newsPanels[key]) continue;
  // ... dynamic panel creation
}
```

### Step 4: Verify no behavioral change

Run: `npx tsc --noEmit`
Expected: Clean

Run: `npx vite build`
Expected: Build succeeds

### Step 5: Commit

```bash
git add src/app/panel-layout.ts
git commit -m "refactor: extract NewsPanel creation into data-driven loop"
```

---

## Task 7: Final verification and deslop

**Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 2: Full build**

Run: `npx vite build`
Expected: Build succeeds

**Step 3: Verify enabled panel count**

Count panels with `enabled: true` in FULL_PANELS. Expected: 21.

**Step 4: Deslop check**

Review all commits for:
- Extra comments that narrate code
- Unnecessary defensive checks
- Casts to `any`
- Deeply nested code that should use early returns

**Step 5: Commit any cleanup**

```bash
git add -A
git commit -m "chore: final verification and cleanup"
```

---

## God-File Assessment (out of scope, documented for future)

| File | Lines | Issue | Recommended Split |
|------|-------|-------|-------------------|
| `scripts/ais-relay.cjs` | 7,873 | Monolithic relay: Redis, LLM, Telegram, WebSocket, HTTP, 30+ fetchers | `relay-core.cjs`, `relay-llm.cjs`, `relay-telegram.cjs`, `relay-fetchers/` |
| `src/app/data-loader.ts` | 2,637 | 170+ methods — all `apply*` + `load*` + `render*` in one class | Per-domain modules: `data-loader-markets.ts`, `data-loader-intelligence.ts`, etc. |
| `src/components/LiveNewsPanel.ts` | 1,526 | YouTube API + channel management + drag-drop + HLS | `YouTubePlayer`, `ChannelManager`, `HlsPlayer` |
| `src/app/event-handlers.ts` | 1,012 | All event wiring in one class | Domain-specific handler modules |

Task 6 (createPanels loop) is the targeted god-function fix in this plan.
