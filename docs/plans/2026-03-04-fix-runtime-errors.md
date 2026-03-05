# Fix Runtime Errors Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix GDELT RPC JSON parse errors and analysis worker timeout failures in both dev and production.

**Architecture:** Two independent fixes: (1) harden GDELT server response parsing so non-JSON responses don't produce cryptic errors, and (2) restructure the analysis worker to lazy-load heavy imports so it signals readiness immediately and retries on failure.

**Tech Stack:** TypeScript, Vite web workers, Vercel serverless functions, Playwright e2e tests

---

### Task 1: Harden GDELT response JSON parsing

**Files:**
- Modify: `server/worldmonitor/intelligence/v1/search-gdelt-documents.ts:78`

**Step 1: Wrap `response.json()` in a try/catch**

In the GDELT fetcher (inside `cachedFetchJson`), the current code calls `response.json()` directly at line 78. If GDELT returns a response with `content-type: application/json` but an invalid JSON body, this throws a raw `JSON.parse` error like `Unexpected token 'P', "Parenthese"...`.

Replace lines 78-89:

```typescript
        let data: {
          articles?: Array<{
            title?: string;
            url?: string;
            domain?: string;
            source?: { domain?: string };
            seendate?: string;
            socialimage?: string;
            language?: string;
            tone?: number;
          }>;
        };

        try {
          data = await response.json();
        } catch {
          const text = await response.text().catch(() => '(unreadable)');
          throw new Error(`GDELT returned invalid JSON: ${text.slice(0, 120)}`);
        }
```

**Step 2: Verify the server builds**

Run: `npx tsc --noEmit --project tsconfig.server.json` (or equivalent type-check)
Expected: No type errors in `search-gdelt-documents.ts`

**Step 3: Commit**

```bash
git add server/worldmonitor/intelligence/v1/search-gdelt-documents.ts
git commit -m "fix(gdelt): catch invalid JSON from GDELT API responses"
```

---

### Task 2: Commit existing Redis pipeline POST fix

**Files:**
- Already modified: `server/_shared/redis.ts`

**Step 1: Review the diff**

Run: `git diff server/_shared/redis.ts`
Confirm the changes switch `getCachedJson` and `setCachedJson` from path-based GET/SET URLs to pipeline POST requests. This avoids SRH path-routing issues when cache keys contain parentheses, quotes, or other special characters.

**Step 2: Commit**

```bash
git add server/_shared/redis.ts
git commit -m "fix(redis): use pipeline POST to avoid SRH path-routing issues with special chars"
```

---

### Task 3: Lazy-load analysis worker imports

**Files:**
- Modify: `src/workers/analysis.worker.ts`

**Step 1: Convert eager imports to lazy dynamic imports**

Replace the entire file content. Key changes:
- Move all `analysis-core` imports from top-level to a lazy loader function
- Send `{ type: 'ready' }` immediately (before any heavy imports)
- Dynamically import `analysis-core` on first `cluster` or `correlation` message
- Cache the import promise so it only loads once

```typescript
/**
 * Web Worker for heavy computational tasks (clustering & correlation analysis).
 * Runs O(n²) Jaccard clustering and correlation detection off the main thread.
 *
 * Core logic is lazily imported from src/services/analysis-core.ts
 * so the worker can signal readiness before the heavy module loads.
 */

import type {
  NewsItemCore,
  ClusteredEventCore,
  PredictionMarketCore,
  MarketDataCore,
  CorrelationSignalCore,
  SourceType,
  StreamSnapshot,
} from '@/services/analysis-core';

interface ClusterMessage {
  type: 'cluster';
  id: string;
  items: NewsItemCore[];
  sourceTiers: Record<string, number>;
}

interface CorrelationMessage {
  type: 'correlation';
  id: string;
  clusters: ClusteredEventCore[];
  predictions: PredictionMarketCore[];
  markets: MarketDataCore[];
  sourceTypes: Record<string, SourceType>;
}

interface ResetMessage {
  type: 'reset';
}

type WorkerMessage = ClusterMessage | CorrelationMessage | ResetMessage;

interface ClusterResult {
  type: 'cluster-result';
  id: string;
  clusters: ClusteredEventCore[];
}

interface CorrelationResult {
  type: 'correlation-result';
  id: string;
  signals: CorrelationSignalCore[];
}

// Lazy-loaded core module
let coreModule: typeof import('@/services/analysis-core') | null = null;
let coreLoadPromise: Promise<typeof import('@/services/analysis-core')> | null = null;

async function getCore() {
  if (coreModule) return coreModule;
  if (!coreLoadPromise) {
    coreLoadPromise = import('@/services/analysis-core');
  }
  coreModule = await coreLoadPromise;
  return coreModule;
}

// Worker-local state (persists between messages)
let previousSnapshot: StreamSnapshot | null = null;
const recentSignalKeys = new Set<string>();

function isRecentDuplicate(key: string): boolean {
  return recentSignalKeys.has(key);
}

function markSignalSeen(key: string): void {
  recentSignalKeys.add(key);
  setTimeout(() => recentSignalKeys.delete(key), 30 * 60 * 1000);
}

// Signal readiness immediately — heavy imports happen lazily on first message
self.postMessage({ type: 'ready' });

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'cluster': {
      const core = await getCore();
      const items = message.items.map(item => ({
        ...item,
        pubDate: new Date(item.pubDate),
      }));

      const getSourceTier = (source: string): number => message.sourceTiers[source] ?? 4;
      const clusters = core.clusterNewsCore(items, getSourceTier);

      const result: ClusterResult = {
        type: 'cluster-result',
        id: message.id,
        clusters,
      };
      self.postMessage(result);
      break;
    }

    case 'correlation': {
      const core = await getCore();
      const clusters = message.clusters.map(cluster => ({
        ...cluster,
        firstSeen: new Date(cluster.firstSeen),
        lastUpdated: new Date(cluster.lastUpdated),
        allItems: cluster.allItems.map(item => ({
          ...item,
          pubDate: new Date(item.pubDate),
        })),
      }));

      const getSourceType = (source: string): SourceType => message.sourceTypes[source] ?? 'other';

      const { signals, snapshot } = core.analyzeCorrelationsCore(
        clusters,
        message.predictions,
        message.markets,
        previousSnapshot,
        getSourceType,
        isRecentDuplicate,
        markSignalSeen
      );

      previousSnapshot = snapshot;

      const result: CorrelationResult = {
        type: 'correlation-result',
        id: message.id,
        signals,
      };
      self.postMessage(result);
      break;
    }

    case 'reset': {
      previousSnapshot = null;
      recentSignalKeys.clear();
      break;
    }
  }
};
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```bash
git add src/workers/analysis.worker.ts
git commit -m "fix(worker): lazy-load analysis-core so worker signals ready immediately"
```

---

### Task 4: Add retry logic and increase timeout in analysis worker manager

**Files:**
- Modify: `src/services/analysis-worker.ts:44,49-65,159-163`

**Step 1: Increase timeout and add retry constant**

Change line 44:

```typescript
  private static readonly READY_TIMEOUT_MS = 20000; // 20 seconds to become ready
  private static readonly MAX_READY_RETRIES = 1;
  private readyAttempts = 0;
```

**Step 2: Add retry logic to `initWorker`**

In the timeout handler (lines 57-65), instead of immediately giving up, check if retries remain and re-create the worker:

```typescript
    this.readyTimeout = setTimeout(() => {
      if (!this.isReady) {
        if (this.readyAttempts < AnalysisWorkerManager.MAX_READY_RETRIES) {
          console.warn('[AnalysisWorker] Ready timeout, retrying...');
          this.readyAttempts++;
          if (this.worker) {
            this.worker.terminate();
            this.worker = null;
          }
          if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
          }
          this.isReady = false;
          // Re-run init (readyPromise/resolve/reject are still set from the outer call)
          const oldResolve = this.readyResolve;
          const oldReject = this.readyReject;
          this.readyResolve = oldResolve;
          this.readyReject = oldReject;
          this.startWorker();
        } else {
          const error = new Error('Worker failed to become ready within timeout');
          console.error('[AnalysisWorker]', error.message);
          this.readyReject?.(error);
          this.cleanup();
        }
      }
    }, AnalysisWorkerManager.READY_TIMEOUT_MS);
```

**Step 3: Extract worker creation into `startWorker()`**

Extract the worker creation + event handler setup from `initWorker()` into a separate `startWorker()` method so it can be called on retry without re-creating the promise:

```typescript
  private initWorker(): void {
    if (this.worker) return;

    this.readyAttempts = 0;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.startWorker();
  }

  private startWorker(): void {
    this.readyTimeout = setTimeout(() => {
      // ... retry logic from Step 2
    }, AnalysisWorkerManager.READY_TIMEOUT_MS);

    try {
      this.worker = new AnalysisWorker();
    } catch (error) {
      console.error('[AnalysisWorker] Failed to create worker:', error);
      this.readyReject?.(error instanceof Error ? error : new Error(String(error)));
      this.cleanup();
      return;
    }

    this.worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      // ... existing message handler (unchanged)
    };

    this.worker.onerror = (error) => {
      // ... existing error handler (unchanged)
    };
  }
```

**Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 5: Commit**

```bash
git add src/services/analysis-worker.ts
git commit -m "fix(worker): increase ready timeout to 20s, add 1-retry on timeout"
```

---

### Task 5: Manual verification

**Step 1: Run dev server and check browser console**

Run: `npm run dev` (or equivalent)
Open the app in Chrome DevTools → Console

Expected:
- No `[GDELT-Intel] RPC error: Unexpected token` errors
- No `[AnalysisWorker] Worker failed to become ready within timeout` errors
- The `[MLWorker] Unable to determine content-length` warning is expected and harmless
- News clustering and correlation analysis should complete successfully

**Step 2: Run existing e2e tests**

Run: `npx playwright test`
Expected: All existing tests pass

**Step 3: Commit any remaining changes**

If any adjustments were needed during verification, commit them.
