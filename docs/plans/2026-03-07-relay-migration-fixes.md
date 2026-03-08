# Relay Migration Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical and important issues found in the frontend relay migration code review.

**Architecture:** Address news loading path to use bootstrap cache when WebSocket is unavailable, fix broken e2e test script, introduce typed interface for relay push handlers, and update stale documentation.

**Tech Stack:** TypeScript, Vite, Playwright

---

## Task 1: Fix News Loading Path (Critical)

**Files:**
- Modify: `src/App.ts:470-478`
- Modify: `src/app/data-loader.ts` (add loadNews call)

**Context:** `loadNews()` is never called during init, so bootstrap news in the hydration cache is unused if WebSocket connects late or fails. News currently depends entirely on WebSocket push.

**Step 1: Locate loadNews() implementation**

Run: `grep -n "async loadNews" src/app/data-loader.ts`
Expected: Find the loadNews method definition (around line 1800+)

**Step 2: Call loadNews after bootstrap**

In `src/App.ts`, after line 470 (`await fetchBootstrapData(SITE_VARIANT || 'full');`), add:

```typescript
await fetchBootstrapData(SITE_VARIANT || 'full');
// Load news immediately after bootstrap to consume cached data
void this.dataLoader.loadNews();
```

**Step 3: Update sourcesReady comment**

Update the comment at line 471-473 to reflect the new flow:

```typescript
// loadNews() is called immediately after bootstrap to consume cached news.
// loadNewsSources() and loadFeatureFlags() fire without await; loadNews()
// will use bootstrap cache first, then wait for sources if needed.
```

**Step 4: Verify build passes**

Run: `npm run typecheck`
Expected: No errors

**Step 5: Commit**

```bash
git add src/App.ts
git commit -m "fix(news): call loadNews after bootstrap to use cached data"
```

---

## Task 2: Fix Broken E2E Test Script (Important)

**Files:**
- Modify: `package.json:34`
- Delete: Remove test or create minimal replacement

**Context:** `test:e2e:runtime` script points to deleted `e2e/runtime-fetch.spec.ts`. The file was removed because it tested `loadMarkets()` which no longer exists.

**Step 1: Check if file exists**

Run: `ls -la e2e/runtime-fetch.spec.ts`
Expected: `No such file or directory`

**Step 2: Option A - Remove the script (recommended)**

In `package.json`, remove line 34:

```json
"test:e2e:runtime": "cross-env VITE_VARIANT=full playwright test e2e/runtime-fetch.spec.ts",
```

And update line 35 to remove reference:

```json
"test:e2e": "npm run test:e2e:full && npm run test:e2e:tech && npm run test:e2e:finance",
```

**Step 3: Verify test:e2e still works**

Run: `npm run test:e2e --help`
Expected: Shows help without errors

**Step 4: Commit**

```bash
git add package.json
git commit -m "fix(test): remove broken test:e2e:runtime script"
```

---

## Task 3: Add Typed Interface for Relay Push Handlers (Important)

**Files:**
- Create: `src/types/relay-push-handlers.ts`
- Modify: `src/app/data-loader.ts:1-10` (add interface implementation)
- Modify: `src/App.ts:437-441` (remove any cast)

**Context:** `DataLoaderManager` is cast to `any` to call `apply*` methods. These methods are public but not on a shared interface.

**Step 1: Create RelayPushHandlers interface**

Create `src/types/relay-push-handlers.ts`:

```typescript
/**
 * Interface for relay push data handlers.
 * Implemented by DataLoaderManager to process real-time relay updates.
 */
export interface RelayPushHandlers {
  applyNewsDigest(payload: unknown): Promise<void>;
  applyOref(payload: unknown): void;
  applyFlights(payload: unknown): void;
  applyMarkets(payload: unknown): void;
  applyPolymarket(payload: unknown): void;
  applyFires(payload: unknown): void;
  applyEarthquakes(payload: unknown): void;
  applyCyber(payload: unknown): void;
  applyClimate(payload: unknown): void;
  applyProtests(payload: unknown): void;
  applyCables(payload: unknown): void;
  applyGpsJamming(payload: unknown): void;
  applyAdvisories(payload: unknown): void;
  applyTelegram(payload: unknown): void;
  applyGdelt(payload: unknown): void;
  applyFredData(payload: unknown): void;
  applyOilData(payload: unknown): void;
  applyBisData(payload: unknown): void;
  applyTradeData(payload: unknown): void;
  applySupplyChainData(payload: unknown): void;
  applyPizzInt(payload: unknown): void;
}
```

**Step 2: Implement interface in DataLoaderManager**

In `src/app/data-loader.ts`, add interface implementation at class declaration:

```typescript
import type { RelayPushHandlers } from '@/types/relay-push-handlers';

export class DataLoaderManager implements AppModule, RelayPushHandlers {
```

**Step 3: Export interface from types/index.ts**

In `src/types/index.ts`, add export:

```typescript
export type { RelayPushHandlers } from './relay-push-handlers';
```

**Step 4: Remove any cast in App.ts**

Replace lines 437-441 in `src/App.ts`:

```typescript
// Before:
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dl = this.dataLoader as any;
subscribeRelayPush(`news:${variant}`, (p) => { void dl.applyNewsDigest(p); });

// After:
subscribeRelayPush(`news:${variant}`, (p) => { 
  void this.dataLoader.applyNewsDigest(p); 
});
```

**Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors, confirms interface is correctly implemented

**Step 6: Commit**

```bash
git add src/types/relay-push-handlers.ts src/types/index.ts src/app/data-loader.ts src/App.ts
git commit -m "refactor(relay): add typed RelayPushHandlers interface"
```

---

## Task 4: Update Stale sourcesReady Documentation (Suggestion)

**Files:**
- Modify: `src/App.ts:471-477`

**Context:** The comment about `sourcesReady` and `loadNews()` is stale after Task 1 changes.

**Step 1: Update comment to reflect actual flow**

Replace lines 471-477 in `src/App.ts`:

```typescript
// Load news immediately after bootstrap to use cached data first.
// loadNewsSources() and loadFeatureFlags() fire in background without blocking.
// News rendering prioritizes bootstrap cache, then waits for sources/flags with timeout.
loadNewsSources();
loadFeatureFlags();
const sourcesReady = Promise.resolve();
this.dataLoader.setSourcesReady(sourcesReady);
```

**Step 2: Verify build**

Run: `npm run typecheck`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/App.ts
git commit -m "docs(app): update sourcesReady comment for clarity"
```

---

## Task 5: Document RefreshScheduler Status (Suggestion)

**Files:**
- Modify: `src/app/refresh-scheduler.ts:1-20`
- Modify: `src/app/index.ts` (update export JSDoc)

**Context:** `RefreshScheduler` is exported but not used. `TelegramIntelPanel` still references "DataLoader + RefreshScheduler".

**Step 1: Add deprecation notice to RefreshScheduler**

Add JSDoc at the top of `src/app/refresh-scheduler.ts`:

```typescript
/**
 * @deprecated RefreshScheduler is no longer used after relay migration.
 * All relay channels now use WebSocket push (relay-push.ts) for real-time updates.
 * Non-relay RSS feeds are loaded via bootstrap and updated through WebSocket or manual refresh.
 * 
 * This class is preserved for backward compatibility but is not instantiated.
 * Consider removing in a future major version.
 */
export class RefreshScheduler {
```

**Step 2: Update export in app/index.ts**

Add JSDoc to the export:

```typescript
/**
 * @deprecated No longer used after relay migration to WebSocket push.
 */
export { RefreshScheduler } from './refresh-scheduler';
```

**Step 3: Find TelegramIntelPanel reference**

Run: `grep -n "RefreshScheduler" src/components/TelegramIntelPanel.ts`
Expected: Find references in comments

**Step 4: Update TelegramIntelPanel comment**

Update any comments mentioning RefreshScheduler to reflect WebSocket push:

```typescript
// Before: "DataLoader + RefreshScheduler"
// After: "DataLoader + WebSocket relay-push"
```

**Step 5: Verify build**

Run: `npm run typecheck`
Expected: Clean build

**Step 6: Commit**

```bash
git add src/app/refresh-scheduler.ts src/app/index.ts src/components/TelegramIntelPanel.ts
git commit -m "docs(refresh): deprecate RefreshScheduler, update references"
```

---

## Task 6: Update Verification Checklist Channel Names (Suggestion)

**Files:**
- Modify: `docs/verification-checklist.md`

**Context:** Checklist mentions `/panel/aviation` and `/panel/markets`, but actual channel names are `flights` and `markets`.

**Step 1: Read current checklist**

Run: `grep -n "/panel/aviation\|/panel/markets" docs/verification-checklist.md`
Expected: Find references to align

**Step 2: Update checklist with actual channel names**

In `docs/verification-checklist.md`, ensure channel names match `RELAY_CHANNELS` constant:
- `flights` (not `aviation`)
- `markets` ✓
- `oref` ✓
- etc.

**Step 3: Commit**

```bash
git add docs/verification-checklist.md
git commit -m "docs(verify): align checklist with actual relay channel names"
```

---

## Task 7: Verify All Fixes with Build and Tests

**Files:**
- Run comprehensive build and test suite

**Step 1: Clean build**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

**Step 3: Run data tests**

Run: `npm run test:data`
Expected: All tests pass

**Step 4: Run e2e tests (if time permits)**

Run: `npm run test:e2e:full`
Expected: All tests pass (may skip if takes too long)

**Step 5: Document verification**

Create `docs/relay-migration-fixes-verification.md`:

```markdown
# Relay Migration Fixes Verification

Date: 2026-03-07

## Issues Fixed

1. ✅ **Critical**: News loading now uses bootstrap cache via `loadNews()` call
2. ✅ **Important**: Removed broken `test:e2e:runtime` script
3. ✅ **Important**: Added `RelayPushHandlers` typed interface
4. ✅ **Suggestion**: Updated `sourcesReady` documentation
5. ✅ **Suggestion**: Deprecated `RefreshScheduler` with clear JSDoc
6. ✅ **Suggestion**: Aligned verification checklist channel names

## Verification Steps

- [x] `npm run typecheck` - Clean
- [x] `npm run build` - Success
- [x] `npm run test:data` - All passing
- [ ] `npm run test:e2e:full` - (Optional, time-intensive)

## Remaining Work

- [ ] Add automated tests for bootstrap + WebSocket flow (future enhancement)
- [ ] Consider removing `RefreshScheduler` in next major version

## Notes

All critical and important issues from code review are resolved.
The application now properly uses bootstrap cache for news and has
type-safe relay push handlers.
```

**Step 6: Commit**

```bash
git add docs/relay-migration-fixes-verification.md
git commit -m "docs: verify relay migration fixes complete"
```

---

## Summary

This plan addresses all issues found in the code review:

**Critical (Fixed):**
- Task 1: News loading path now uses bootstrap cache

**Important (Fixed):**
- Task 2: Removed broken e2e test script
- Task 3: Added typed `RelayPushHandlers` interface

**Suggestions (Fixed):**
- Task 4: Updated stale documentation
- Task 5: Deprecated `RefreshScheduler` with clear docs
- Task 6: Aligned verification checklist

**Deferred (Future Enhancement):**
- Add automated integration tests for bootstrap + WebSocket flow

Total estimated time: 30-45 minutes
