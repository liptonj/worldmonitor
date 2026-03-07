# Panel Fixes, Sane Defaults & Headlines Panel

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs (panels not receiving data, AIS flooding all clients), reduce default-enabled panels from 45 to 21, build a new aggregate Latest Headlines panel, and eliminate god-function patterns in touched code.

**Architecture:** The app is a vanilla TypeScript SPA (Vite + Tauri). Panel configuration lives in `src/config/panels.ts` as `DEFAULT_PANELS`. On startup, `App.ts` loads settings from localStorage and merges with defaults — but the merge is shallow, losing new properties like `channels`. The relay server (`scripts/ais-relay.cjs`) has a raw AIS message fanout that bypasses the demand-driven channel subscription system. The new Headlines panel aggregates `ctx.allNews` into a reverse-chronological feed.

**Tech Stack:** Vanilla TypeScript, Vite, WebSocket relay (Node.js/Express), CSS

**Worktree:** `.worktrees/fix-panels-headlines` on branch `fix/panels-headlines-defaults`

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

Result: `panelSettings['strategic-posture'].channels` is `undefined` for returning users → no channel subscription → no push data.

### Bug 2: AIS data flooding all clients

**Root cause:** `scripts/ais-relay.cjs` lines 2564-2576 — raw AIS message fanout.

Every 50th raw AIS message is sent to **all connected WebSocket clients** (`clients` set) regardless of whether they subscribed to the `ais` channel. The demand-driven system uses `channelSubscribers.get('ais')`, but this fanout uses the global `clients` set.

```javascript
// CURRENT (broken) — ais-relay.cjs:2566
if (clients.size > 0 && messageCount % 50 === 0) {
  const message = raw.toString();
  for (const client of clients) { // ← sends to ALL clients
    if (client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount < 1024 * 1024) {
        client.send(message);
      }
    }
  }
}
```

### Bug 3: Dead code risk

`src/services/maritime/index.ts` line 420 — deprecated `fetchAisSignals()` still calls `startPolling()`. Although unused, it's a trap for future developers.

---

## Task 1: Fix panel settings deep-merge (channels hydration)

**Files:**
- Modify: `src/App.ts:95-104`

**Step 1: Modify the merge logic to backfill new properties**

In `src/App.ts`, replace the shallow merge loop with a deep-merge that always hydrates `channels`, `requiredFeature`, and `priority` from `DEFAULT_PANELS` for existing panels:

```typescript
// FIXED — App.ts:95-110 (replace lines 95-104)
panelSettings = loadFromStorage<Record<string, PanelConfig>>(
  STORAGE_KEYS.panels,
  DEFAULT_PANELS
);
for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
  if (key in panelSettings) {
    // Backfill structural properties that may have been added after
    // the user's settings were saved — never overwrite user's enabled choice
    if (config.channels) panelSettings[key].channels = config.channels;
    if (config.requiredFeature) panelSettings[key].requiredFeature = config.requiredFeature;
    if (config.priority !== undefined) panelSettings[key].priority = config.priority;
  } else {
    panelSettings[key] = { ...config };
  }
}
```

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors

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

Replace the raw message fanout to only send to clients subscribed to the `ais` channel:

```javascript
// FIXED — ais-relay.cjs:2564-2576 (replace entire block)
  // Heavily throttled WS fanout: every 50th message only, AIS subscribers only
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

**Step 2: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "fix(relay): gate raw AIS fanout on channel subscribers only"
```

---

## Task 3: Remove dead `startPolling()` call from deprecated function

**Files:**
- Modify: `src/services/maritime/index.ts:415-430`

**Step 1: Remove `startPolling()` from `fetchAisSignals()`**

The function is marked `@deprecated` and unused. Remove the `startPolling()` call so it doesn't accidentally restart AIS polling if someone calls it:

```typescript
// FIXED — maritime/index.ts:415-430
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
Expected: No errors

**Step 3: Commit**

```bash
git add src/services/maritime/index.ts
git commit -m "fix: remove startPolling from deprecated fetchAisSignals"
```

---

## Task 4: Set sane panel defaults (45 → 21 enabled)

**Files:**
- Modify: `src/config/panels.ts:10-59` (FULL_PANELS)
- Modify: `src/config/panels.ts:611-703` (PANEL_CATEGORY_MAP — add `headlines` to core)

**Step 1: Update FULL_PANELS defaults**

Change `FULL_PANELS` so only 21 panels are `enabled: true` by default. All others become `enabled: false`. The 21 enabled panels are:

```
map, live-news, headlines, insights, strategic-posture, cii, strategic-risk,
intel, gdelt-intel, global-digest, cascade, telegram-intel, politics,
markets, commodities, finance, crypto, trade-policy, security-advisories,
world-clock, monitors
```

Replace lines 10-59 of `src/config/panels.ts`:

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

**Step 2: Add `headlines` to `PANEL_CATEGORY_MAP`**

In `src/config/panels.ts`, add `'headlines'` to the `core` category's `panelKeys` array:

```typescript
core: {
  labelKey: 'header.panelCatCore',
  panelKeys: ['map', 'live-news', 'headlines', 'live-webcams', 'insights', 'strategic-posture'],
},
```

**Step 3: Add a one-time migration for existing users**

In `src/App.ts`, after the deep-merge loop (Task 1), add a one-time migration to reset panel defaults for users who have never seen the new defaults. This ensures existing users get the new sane defaults without losing custom toggles if they've already seen them:

```typescript
const PANEL_DEFAULTS_V2_KEY = 'worldmonitor-panel-defaults-v2';
if (!localStorage.getItem(PANEL_DEFAULTS_V2_KEY)) {
  // Reset to new defaults for existing users — they had 45 panels enabled
  for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
    if (key in panelSettings) {
      panelSettings[key].enabled = config.enabled;
    }
  }
  localStorage.setItem(PANEL_DEFAULTS_V2_KEY, '1');
}
```

**Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/config/panels.ts src/App.ts
git commit -m "feat: reduce default-enabled panels from 45 to 21, add headlines to config"
```

---

## Task 5: Build the Latest Headlines panel

**Files:**
- Create: `src/components/HeadlinesPanel.ts`
- Modify: `src/app/panel-layout.ts` (register in createPanels)
- Modify: `src/app/data-loader.ts` (feed data into Headlines on news load)
- Modify: `src/types/index.ts` (only if `NewsItem` needs a check — likely already has `pubDate`)

### Step 1: Create `src/components/HeadlinesPanel.ts`

The panel extends `Panel` and renders a reverse-chronological list of headlines from `NewsItem[]`. It deduplicates by URL and limits display to the most recent 50. It auto-updates when `renderItems()` is called.

```typescript
import { Panel } from './Panel';
import { h, safeText } from '@/utils/dom';
import type { NewsItem } from '@/types';

const MAX_ITEMS = 50;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export class HeadlinesPanel extends Panel {
  private seenUrls = new Set<string>();
  private items: NewsItem[] = [];

  constructor() {
    super('headlines', {
      title: 'Latest Headlines',
      icon: '📰',
      collapsible: true,
    });
    this.setLoading();
  }

  renderItems(allNews: NewsItem[]): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    this.seenUrls.clear();
    this.items = [];

    const sorted = allNews
      .filter(item => {
        const ts = new Date(item.pubDate ?? item.fetchedAt ?? 0).getTime();
        return ts > cutoff;
      })
      .sort((a, b) => {
        const ta = new Date(a.pubDate ?? a.fetchedAt ?? 0).getTime();
        const tb = new Date(b.pubDate ?? b.fetchedAt ?? 0).getTime();
        return tb - ta;
      });

    for (const item of sorted) {
      const key = item.link || item.title;
      if (this.seenUrls.has(key)) continue;
      this.seenUrls.add(key);
      this.items.push(item);
      if (this.items.length >= MAX_ITEMS) break;
    }

    this.render();
  }

  private render(): void {
    if (this.items.length === 0) {
      this.setContent('<div class="panel-empty">No headlines yet</div>');
      return;
    }

    const list = h('div', { className: 'headlines-list' });

    for (const item of this.items) {
      const ts = new Date(item.pubDate ?? item.fetchedAt ?? 0);
      const ago = this.timeAgo(ts);
      const source = item.source || item.category || '';

      const row = h('div', { className: 'headline-row' });

      const meta = h('div', { className: 'headline-meta' });
      if (source) {
        const badge = h('span', { className: 'headline-source' });
        badge.appendChild(safeText(source));
        meta.appendChild(badge);
      }
      const time = h('span', { className: 'headline-time' });
      time.appendChild(safeText(ago));
      meta.appendChild(time);

      row.appendChild(meta);

      if (item.link) {
        const link = h('a', {
          className: 'headline-title',
          href: item.link,
          target: '_blank',
          rel: 'noopener noreferrer',
        });
        link.appendChild(safeText(item.title));
        row.appendChild(link);
      } else {
        const span = h('span', { className: 'headline-title' });
        span.appendChild(safeText(item.title));
        row.appendChild(span);
      }

      list.appendChild(row);
    }

    this.content.innerHTML = '';
    this.content.appendChild(list);
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

### Step 2: Add CSS for Headlines panel

Add to the existing panel styles file (or create `src/styles/headlines.css` if panel styles are modular). The styles should match the existing panel aesthetic:

```css
.headlines-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

### Step 3: Register the panel in `panel-layout.ts`

In `src/app/panel-layout.ts`, inside `createPanels()`, add the Headlines panel creation. Place it near the other core panels (after the map, before news panels). Use dynamic import to keep bundle lean:

```typescript
const { HeadlinesPanel } = await import('@/components/HeadlinesPanel');
const headlinesPanel = new HeadlinesPanel();
this.ctx.panels['headlines'] = headlinesPanel;
```

Add the panel element to the grid in the same manner as other panels — it will be attached to `panelsGrid` via the existing `attachPanelsToGrid()` method.

### Step 4: Feed data into the Headlines panel from data-loader

In `src/app/data-loader.ts`, after `this.ctx.allNews = collectedNews;` (appears twice — in `loadNews()` ~line 664 and in `processDigestData()` ~line 2149), add:

```typescript
const headlinesPanel = this.ctx.panels['headlines'];
if (headlinesPanel && 'renderItems' in headlinesPanel) {
  (headlinesPanel as import('@/components/HeadlinesPanel').HeadlinesPanel).renderItems(this.ctx.allNews);
}
```

This ensures the Headlines panel updates both on initial load and when digest data pushes arrive.

### Step 5: Verify type-check and build

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npx vite build`
Expected: Build succeeds

### Step 6: Commit

```bash
git add src/components/HeadlinesPanel.ts src/app/panel-layout.ts src/app/data-loader.ts
git commit -m "feat: add Latest Headlines aggregate panel"
```

---

## Task 6: Refactor `createPanels()` — extract panel registry (god-function fix)

**Files:**
- Modify: `src/app/panel-layout.ts:381-740`

The `createPanels()` method is ~360 lines of repetitive inline panel construction. This task extracts the repetitive `NewsPanel` creation pattern into a data-driven loop.

### Step 1: Create a news panel registry array

At the top of `panel-layout.ts` (or in a new helper), define the list of simple `NewsPanel` instances:

```typescript
const NEWS_PANEL_KEYS = [
  'politics', 'tech', 'finance', 'gov', 'intel', 'energy',
  'africa', 'latam', 'asia', 'us', 'europe', 'middleeast',
  'ai', 'layoffs', 'thinktanks',
  // Tech variant
  'startups', 'vcblogs', 'regionalStartups', 'unicorns',
  'accelerators', 'funding', 'producthunt', 'security',
  'policy', 'hardware', 'cloud', 'dev', 'github', 'ipo',
] as const;
```

### Step 2: Replace repetitive NewsPanel blocks with a loop

Replace the ~25 individual `new NewsPanel(key, t('panels.key'))` blocks with:

```typescript
for (const key of NEWS_PANEL_KEYS) {
  const label = DEFAULT_PANELS[key]?.name ?? t(`panels.${key}`);
  const panel = new NewsPanel(key, label);
  this.attachRelatedAssetHandlers(panel);
  this.ctx.newsPanels[key] = panel;
  this.ctx.panels[key] = panel;
}
```

Keep the specialized panels (MarketPanel, CommoditiesPanel, HeatmapPanel, etc.) as explicit instantiations since they have unique constructors and setup.

### Step 3: Verify no behavioral change

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npx vite build`
Expected: Build succeeds, no regression in panel creation

### Step 4: Commit

```bash
git add src/app/panel-layout.ts
git commit -m "refactor: extract NewsPanel creation into data-driven loop"
```

---

## Task 7: Final verification

**Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Full build**

Run: `npx vite build`
Expected: Build succeeds

**Step 3: Verify panel count**

Manually verify `FULL_PANELS` has exactly 21 panels with `enabled: true` and the rest are `enabled: false`. Count in the source file.

**Step 4: Commit any remaining cleanup**

```bash
git add -A
git commit -m "chore: final verification and cleanup"
```

---

## God-File Assessment (out of scope but documented)

These files warrant future decomposition but are **not** in scope for this plan:

| File | Lines | Issue | Recommended Split |
|------|-------|-------|-------------------|
| `scripts/ais-relay.cjs` | 7,873 | Monolithic relay: Redis, LLM, Telegram, WebSocket, HTTP, 30+ fetchers | Split into `relay-core.cjs`, `relay-llm.cjs`, `relay-telegram.cjs`, `relay-fetchers/` directory |
| `src/app/data-loader.ts` | 2,637 | God class with 170+ methods — all `apply*` + `load*` + `render*` | Split apply handlers into per-domain modules (e.g., `data-loader-markets.ts`, `data-loader-intelligence.ts`) |
| `src/components/LiveNewsPanel.ts` | 1,526 | YouTube API + channel management + drag-drop + HLS all in one | Extract `YouTubePlayer`, `ChannelManager`, `HlsPlayer` |
| `src/app/event-handlers.ts` | 1,012 | All event wiring in one class | Group into domain-specific handler modules |

The refactor in Task 6 (`createPanels()` loop) is the one god-function fix directly relevant to this plan.
