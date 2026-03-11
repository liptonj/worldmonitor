# Eliminate Frontend API Calls — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove three frontend-to-server API calls (`summarize-article`, `record-baseline-snapshot`, `get-temporal-baseline`) and replace them with relay-only WebSocket data flow.

**Architecture:** Article summaries already flow via `ai:article-summaries` WebSocket channel — just remove the API fallback. Temporal anomalies get a new `temporal-anomalies` channel that reads item counts from Redis, computes baselines with Welford's algorithm, and pushes anomaly alerts.

**Tech Stack:** TypeScript frontend, Node.js CJS workers, ioredis, gRPC broadcast, WebSocket relay

---

### Task 1: Gut Article Summary API Fallback

**Files:**
- Modify: `src/services/summarization.ts`

**Step 1: Strip the API fallback chain from `summarization.ts`**

Remove all provider-related code. Keep `lookupRelaySummary()`, `fnv1aHash()`, types, and `translateText()`. Replace `generateSummary()` with a relay-cache-only version.

```typescript
/**
 * Article Summarization — Relay Cache Only
 *
 * Summaries are pre-computed server-side by the AI engine and pushed
 * via the ai:article-summaries WebSocket channel. This module looks
 * them up from window.__wmArticleSummaries.
 *
 * translateText() still uses the SummarizeArticle RPC for on-demand
 * translation (different use case from pre-computed summaries).
 */

import { SITE_VARIANT } from '@/config';
import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';
import { trackLLMUsage } from './analytics';
import { NewsServiceClient, type SummarizeArticleResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { createCircuitBreaker } from '@/utils';

export type SummarizationProvider = 'ollama' | 'groq' | 'openrouter' | 'browser' | 'cache' | 'pending';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  model: string;
  cached: boolean;
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

export interface SummarizeOptions {
  skipCloudProviders?: boolean;
  skipBrowserFallback?: boolean;
}

function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function lookupRelaySummary(headlines: string[]): SummarizationResult | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = (window as any).__wmArticleSummaries as Record<string, { text?: string }> | undefined;
  if (!cache) return null;
  for (const title of headlines) {
    const entry = cache[fnv1aHash(title.toLowerCase())];
    if (entry?.text) return { summary: entry.text, provider: 'cache', model: 'relay', cached: true };
  }
  return null;
}

const PENDING_RESULT: SummarizationResult = {
  summary: '',
  provider: 'pending',
  model: 'relay',
  cached: false,
};

/**
 * Look up a pre-computed summary from the relay cache.
 * Returns a "pending" result (empty summary) if not yet available.
 * Panels should listen for 'wm:article-summaries-updated' to re-check.
 */
export function generateSummary(
  headlines: string[],
  _onProgress?: ProgressCallback,
  _geoContext?: string,
  _lang?: string,
  _options?: SummarizeOptions,
): SummarizationResult | null {
  if (!headlines || headlines.length < 2) return null;

  const relayResult = lookupRelaySummary(headlines);
  if (relayResult) {
    trackLLMUsage(relayResult.provider, relayResult.model, true);
    return relayResult;
  }

  return PENDING_RESULT;
}

// ── Translation (still uses API — different use case) ──

interface ApiProviderDef {
  featureId: RuntimeFeatureId;
  provider: SummarizationProvider;
  label: string;
}

const API_PROVIDERS: ApiProviderDef[] = [
  { featureId: 'aiOllama',      provider: 'ollama',     label: 'Ollama' },
  { featureId: 'aiGroq',        provider: 'groq',       label: 'Groq AI' },
  { featureId: 'aiOpenRouter',  provider: 'openrouter', label: 'OpenRouter' },
];

const newsClient = new NewsServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const translationBreaker = createCircuitBreaker<SummarizeArticleResponse>({ name: 'Translation', cacheTtlMs: 0 });
const emptyTranslationFallback: SummarizeArticleResponse = { summary: '', provider: '', model: '', cached: false, skipped: false, fallback: true, tokens: 0, reason: '', error: '', errorType: '' };

/**
 * Translate text using the API provider chain.
 * Translation is on-demand and cannot be pre-computed.
 */
export async function translateText(
  text: string,
  targetLang: string,
  onProgress?: ProgressCallback,
): Promise<string | null> {
  if (!text) return null;

  const totalSteps = API_PROVIDERS.length;
  for (const [i, providerDef] of API_PROVIDERS.entries()) {
    if (!isFeatureAvailable(providerDef.featureId)) continue;

    onProgress?.(i + 1, totalSteps, `Translating with ${providerDef.label}...`);
    try {
      const resp = await translationBreaker.execute(async () => {
        return newsClient.summarizeArticle({
          provider: providerDef.provider,
          headlines: [text],
          mode: 'translate',
          geoContext: '',
          variant: targetLang,
          lang: '',
        });
      }, emptyTranslationFallback);

      if (resp.fallback || resp.skipped) continue;
      const summary = typeof resp.summary === 'string' ? resp.summary.trim() : '';
      if (summary) return summary;
    } catch (e) {
      console.warn(`${providerDef.label} translation failed`, e);
    }
  }

  return null;
}
```

**Step 2: Verify the build**

Run: `npm run typecheck`
Expected: PASS (no type errors from summarization.ts changes)

**Step 3: Commit**

```bash
git add src/services/summarization.ts
git commit -m "refactor: remove article summary API fallback, relay-cache only"
```

---

### Task 2: Wire Panels to Auto-Update on WebSocket Summary Push

**Files:**
- Modify: `src/components/NewsPanel.ts`
- Modify: `src/components/GoodThingsDigestPanel.ts`
- Modify: `src/components/InsightsPanel.ts`

**Step 1: Update `NewsPanel.ts`**

The `handleSummarize()` method currently awaits `generateSummary()`. Since it's now synchronous, update it to handle the pending state and listen for updates.

In `handleSummarize()`, after calling `generateSummary()`:
- If `result.provider === 'pending'`, show "Summary pending..." and register a one-time listener on `wm:article-summaries-updated`
- When the event fires, re-run `lookupRelaySummary()` (via `generateSummary()`) and update the summary display

Add a cleanup method to remove the event listener on destroy.

Key changes to `handleSummarize()`:

```typescript
// After const result = generateSummary(...)
if (result?.provider === 'pending') {
  this.summaryContainer.innerHTML = '<div class="panel-summary-loading">Summary pending...</div>';
  const onSummariesUpdated = () => {
    const updated = generateSummary(this.currentHeadlines.slice(0, 8), undefined, this.panelId, currentLang);
    if (updated && updated.provider !== 'pending' && updated.summary) {
      this.setCachedSummary(cacheKey, updated.summary);
      this.showSummary(updated.summary);
      document.removeEventListener('wm:article-summaries-updated', onSummariesUpdated);
    }
  };
  document.addEventListener('wm:article-summaries-updated', onSummariesUpdated);
  this.isSummarizing = false;
  this.summaryBtn.innerHTML = '✨';
  this.summaryBtn.disabled = false;
  return;
}
```

Remove the `await` from the `generateSummary()` call (it's now synchronous).

**Step 2: Update `GoodThingsDigestPanel.ts`**

In the `setStories()` method, after the `Promise.allSettled` for summaries, add a listener for `wm:article-summaries-updated` to re-check pending cards.

Store pending card indices. On event, re-run `generateSummary()` for each pending card and call `updateCardSummary()` if a summary is now available.

**Step 3: Update `InsightsPanel.ts`**

In the insights update flow, if `generateSummary()` returns pending, show "Brief pending..." and register a listener to update when summaries arrive.

**Step 4: Verify the build**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/NewsPanel.ts src/components/GoodThingsDigestPanel.ts src/components/InsightsPanel.ts
git commit -m "feat: panels auto-update when relay article summaries arrive"
```

---

### Task 3: Increase AI Engine Article Summary Coverage

**Files:**
- Modify: `services/ai-engine/generators/article-summaries.cjs`

**Step 1: Increase `MAX_ARTICLES` from 10 to 25**

```javascript
const MAX_ARTICLES = 25;
```

**Step 2: Commit**

```bash
git add services/ai-engine/generators/article-summaries.cjs
git commit -m "feat: increase article summary coverage from 10 to 25 articles"
```

---

### Task 4: Create Temporal Anomalies Worker Channel

**Files:**
- Create: `services/shared/channels/temporal-anomalies.cjs`

**Step 1: Write the channel implementation**

Port Welford's algorithm from `server/worldmonitor/infrastructure/v1/record-baseline-snapshot.ts` and `_shared.ts`. Read item counts from other channel Redis keys. Compute baselines and anomalies.

```javascript
'use strict';

const BASELINE_TTL = 7776000; // 90 days
const MIN_SAMPLES = 10;
const Z_THRESHOLD_LOW = 1.5;
const Z_THRESHOLD_MEDIUM = 2.0;
const Z_THRESHOLD_HIGH = 3.0;

const VALID_TYPES = [
  'military_flights', 'vessels', 'protests', 'news', 'ais_gaps', 'satellite_fires',
];

const DATA_SOURCES = {
  news:             { key: 'news:digest:v1:full:en',   countFn: (d) => Array.isArray(d?.items) ? d.items.length : Array.isArray(d) ? d.length : 0 },
  military_flights: { key: 'relay:flights:v1',          countFn: (d) => Array.isArray(d?.flights) ? d.flights.length : 0 },
  vessels:          { key: 'relay:opensky:v1',           countFn: (d) => Array.isArray(d?.vessels) ? d.vessels.length : 0 },
  ais_gaps:         { key: 'relay:ais-snapshot:v1',      countFn: (d) => Array.isArray(d?.disruptions) ? d.disruptions.length : 0 },
  satellite_fires:  { key: 'relay:climate:v1',           countFn: (d) => Array.isArray(d?.fires) ? d.fires.length : 0 },
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const TYPE_LABELS = {
  military_flights: 'Military flights',
  vessels: 'Naval vessels',
  protests: 'Protests',
  news: 'News velocity',
  ais_gaps: 'Dark ship activity',
  satellite_fires: 'Satellite fire detections',
};

function makeBaselineKey(type, region, weekday, month) {
  return `baseline:${type}:${region}:${weekday}:${month}`;
}

function getSeverity(zScore) {
  if (zScore >= Z_THRESHOLD_HIGH) return 'critical';
  if (zScore >= Z_THRESHOLD_MEDIUM) return 'high';
  if (zScore >= Z_THRESHOLD_LOW) return 'medium';
  return 'normal';
}

function formatMessage(type, _region, count, mean, multiplier) {
  const now = new Date();
  const weekday = WEEKDAY_NAMES[now.getUTCDay()];
  const month = MONTH_NAMES[now.getUTCMonth() + 1];
  const mult = multiplier < 10 ? `${multiplier.toFixed(1)}x` : `${Math.round(multiplier)}x`;
  return `${TYPE_LABELS[type] || type} ${mult} normal for ${weekday} (${month}) — ${count} vs baseline ${Math.round(mean)}`;
}

module.exports = async function fetchTemporalAnomalies({ redis, log }) {
  log.debug('fetchTemporalAnomalies executing');
  const timestamp = new Date().toISOString();

  if (!redis || typeof redis.get !== 'function') {
    log.warn('fetchTemporalAnomalies: redis not available');
    return { timestamp, source: 'temporal-anomalies', data: { anomalies: [] }, status: 'error', errors: ['Redis not configured'] };
  }

  const now = new Date();
  const weekday = now.getUTCDay();
  const month = now.getUTCMonth() + 1;
  const region = 'global';
  const anomalies = [];

  try {
    for (const [type, src] of Object.entries(DATA_SOURCES)) {
      const rawData = await redis.get(src.key);
      if (!rawData) continue;

      const count = src.countFn(rawData);
      if (typeof count !== 'number' || isNaN(count)) continue;

      const baselineKey = makeBaselineKey(type, region, weekday, month);
      const baseline = await redis.get(baselineKey);

      // Welford update
      const prev = baseline || { mean: 0, m2: 0, sampleCount: 0 };
      const n = prev.sampleCount + 1;
      const delta = count - prev.mean;
      const newMean = prev.mean + delta / n;
      const delta2 = count - newMean;
      const newM2 = prev.m2 + delta * delta2;

      await redis.setex(baselineKey, BASELINE_TTL, {
        mean: newMean,
        m2: newM2,
        sampleCount: n,
        lastUpdated: now.toISOString(),
      });

      // Check for anomaly (need enough samples)
      if (n < MIN_SAMPLES) continue;

      const variance = Math.max(0, newM2 / (n - 1));
      const stdDev = Math.sqrt(variance);
      const zScore = stdDev > 0 ? Math.abs((count - newMean) / stdDev) : 0;

      if (zScore < Z_THRESHOLD_LOW) continue;

      const severity = getSeverity(zScore);
      const multiplier = newMean > 0
        ? Math.round((count / newMean) * 100) / 100
        : count > 0 ? 999 : 1;

      anomalies.push({
        type,
        region,
        currentCount: count,
        expectedCount: Math.round(newMean),
        zScore: Math.round(zScore * 100) / 100,
        severity,
        message: formatMessage(type, region, count, newMean, multiplier),
      });
    }

    anomalies.sort((a, b) => b.zScore - a.zScore);

    return {
      timestamp,
      source: 'temporal-anomalies',
      data: { anomalies },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchTemporalAnomalies error', { error: err?.message ?? err });
    return { timestamp, source: 'temporal-anomalies', data: { anomalies: [] }, status: 'error', errors: [err?.message ?? String(err)] };
  }
};
```

**Step 2: Commit**

```bash
git add services/shared/channels/temporal-anomalies.cjs
git commit -m "feat: add temporal-anomalies worker channel with Welford baseline"
```

---

### Task 5: Register Temporal Anomalies Channel

**Files:**
- Modify: `services/shared/channels/index.cjs`
- Modify: `services/gateway/channel-keys.json`

**Step 1: Add to CHANNEL_REGISTRY in `index.cjs`**

Add after the last entry (before the closing `}`):

```javascript
'temporal-anomalies': require('./temporal-anomalies.cjs'),
```

**Step 2: Add to `channel-keys.json`**

Add to `channelKeys`:

```json
"temporal-anomalies": "relay:temporal-anomalies:v1"
```

**Step 3: Commit**

```bash
git add services/shared/channels/index.cjs services/gateway/channel-keys.json
git commit -m "feat: register temporal-anomalies in channel registry and gateway keys"
```

---

### Task 6: Add Supabase Migration for Temporal Anomalies Cron

**Files:**
- Create: `supabase/migrations/XXXXXXXX_temporal_anomalies_channel.sql`

**Step 1: Write the migration**

Use the Supabase MCP to push a migration that adds the `temporal-anomalies` service config with a 5-minute cron. Follow the pattern of existing service configs.

```sql
INSERT INTO wm_admin.service_config (service_key, cron_schedule, enabled, ttl_seconds, description)
VALUES (
  'temporal-anomalies',
  '*/5 * * * *',
  true,
  600,
  'Temporal anomaly detection — reads item counts from other channels, computes baselines, pushes anomaly alerts'
)
ON CONFLICT (service_key) DO UPDATE SET
  cron_schedule = EXCLUDED.cron_schedule,
  enabled = EXCLUDED.enabled,
  ttl_seconds = EXCLUDED.ttl_seconds,
  description = EXCLUDED.description;
```

**Step 2: Push migration via MCP**

**Step 3: Commit**

```bash
git add supabase/migrations/*temporal_anomalies*
git commit -m "feat: add temporal-anomalies cron schedule (every 5 min)"
```

---

### Task 7: Add Frontend Handler for Temporal Anomalies

**Files:**
- Modify: `src/data/ai-handler.ts`

**Step 1: Add temporal-anomalies handler**

Import the signal aggregator and CII ingestion. Add handler to the returned record.

Add these imports at the top:

```typescript
import { signalAggregator } from '@/services/signal-aggregator';
import { ingestTemporalAnomaliesForCII } from '@/services/country-instability';
```

Add this handler in the returned object (after `'ai:telegram-summary'`):

```typescript
'temporal-anomalies': (payload: unknown) => {
  if (!payload) { console.warn('[wm:temporal-anomalies] null/undefined payload'); return; }
  const data = payload as { anomalies?: Array<{
    type: string; region: string; currentCount: number; expectedCount: number;
    zScore: number; severity: 'medium' | 'high' | 'critical'; message: string;
  }> };
  const anomalies = data.anomalies ?? [];
  if (anomalies.length === 0) return;
  signalAggregator.ingestTemporalAnomalies(anomalies);
  ingestTemporalAnomaliesForCII(anomalies);
  const ciiPanel = ctx.panels['cii'] as { refresh?: () => void } | undefined;
  ciiPanel?.refresh?.();
},
```

**Step 2: Verify the build**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/data/ai-handler.ts
git commit -m "feat: add temporal-anomalies WebSocket handler"
```

---

### Task 8: Remove Frontend Temporal Baseline Code

**Files:**
- Delete: `src/services/temporal-baseline.ts`
- Modify: `src/data/news-handler.ts` (line 17: remove import, lines ~330-338: remove `updateAndCheck` call)
- Modify: `src/data/news-loader.ts` (line 15: remove import, lines ~253-258: remove `updateAndCheck` call)
- Modify: `src/data/infrastructure-handler.ts` (line 17: remove import, lines ~205-210: remove `updateAndCheck` call)
- Modify: `src/data/intelligence-loader.ts` (line 21: remove import, lines ~126-131 and ~368-373: remove `updateAndCheck` calls)
- Modify: `src/data/geo-handler.ts` (line 13: remove import, lines ~73-78: remove `updateAndCheck` call)
- Modify: `src/services/country-instability.ts` (line 4: change import to inline type)

**Step 1: Delete `src/services/temporal-baseline.ts`**

**Step 2: Remove imports and `updateAndCheck` calls from all 5 data handlers**

In each file:
1. Remove the `import { updateAndCheck } from '@/services/temporal-baseline';` line
2. Remove the `updateAndCheck([...]).then(anomalies => { ... }).catch(() => {});` block
3. Keep the surrounding code intact (the `signalAggregator` and `ingestTemporalAnomaliesForCII` calls are now handled by the WebSocket handler)
4. If `ingestTemporalAnomaliesForCII` was only imported for the `updateAndCheck` callback, check if it's still needed for other calls in the file. If not, remove that import too.

**Step 3: Fix `country-instability.ts` type import**

Change line 4 from:
```typescript
import type { TemporalAnomaly } from '@/services/temporal-baseline';
```
To an inline type definition:
```typescript
export interface TemporalAnomaly {
  type: string;
  region: string;
  currentCount: number;
  expectedCount: number;
  zScore: number;
  message: string;
  severity: 'medium' | 'high' | 'critical';
}
```

**Step 4: Remove from `src/services/index.ts` if re-exported**

Check if `temporal-baseline` is re-exported from the services barrel and remove it.

**Step 5: Verify the build**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove frontend temporal baseline — now served by relay channel"
```

---

### Task 9: Clean Up Gateway Cache Tier Config

**Files:**
- Modify: `server/gateway.ts`

**Step 1: Remove deprecated API entries from `RPC_CACHE_TIER`**

Remove this line:
```typescript
'/api/infrastructure/v1/get-temporal-baseline': 'slow',
```

**Step 2: Verify the build**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add server/gateway.ts
git commit -m "chore: remove deprecated temporal-baseline from RPC cache tier"
```

---

### Task 10: Final Verification

**Step 1: Full type check**

Run: `npm run typecheck`
Expected: PASS with zero errors

**Step 2: Grep verification — no frontend API calls remain**

Run: `grep -r "record-baseline-snapshot\|get-temporal-baseline" src/ --include="*.ts" -l`
Expected: No results (only server/ and generated/ should have these)

Run: `grep -r "summarizeArticle\|summarize-article" src/ --include="*.ts" -l`
Expected: Only `src/services/summarization.ts` (for `translateText`) and generated client files

**Step 3: Commit all changes**

```bash
git add -A
git commit -m "feat: eliminate frontend API calls — relay-only data flow

- Article summaries: relay cache only, panels auto-update on WebSocket push
- Temporal anomalies: new worker channel with Welford baseline detection
- Removed: direct API calls for summarize-article, record-baseline-snapshot, get-temporal-baseline"
```
