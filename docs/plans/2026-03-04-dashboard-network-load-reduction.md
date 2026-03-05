# Dashboard Network Load Reduction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce dashboard startup to fewer than 10 initial network requests while improving first meaningful render and achieving LCP under 2.5s.

**Architecture:** Introduce phased startup orchestration so only critical data loads on first paint, then schedule non-critical panels using deferred/background priorities. Add a request budget gate, startup dedupe, and stale-while-revalidate behavior for secondary data to aggressively cut network chatter without blocking key UI. Keep existing APIs where possible and migrate high-churn startup calls into grouped deferred phases.

**Tech Stack:** TypeScript, Vite, native fetch, existing app modules (`DataLoaderManager`, `RefreshScheduler`), node:test/tsx test runner.

---

## Implementation Notes

- Apply DRY and YAGNI: only add scheduling primitives needed for startup phases and request budgeting.
- Use TDD-first for scheduler/budget behavior and `loadMarkets()` duplication regression.
- Keep imports at top-of-file (rule: no inline imports).
- Prefer small commits after each task.
- Skill references for execution: `@superpowers:executing-plans`, `@superpowers:verification-before-completion`.

---

### Task 1: Add Startup Load Profile Contract

**Files:**
- Create: `src/app/startup-load-profile.ts`
- Test: `tests/startup-load-profile.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStartupLoadProfile } from '../src/app/startup-load-profile.ts';

describe('startup load profile', () => {
  it('defines critical and deferred phases with request budget <= 10', () => {
    const profile = getStartupLoadProfile('full');
    assert.ok(profile.initialRequestBudget <= 10);
    assert.ok(profile.phaseA.length > 0);
    assert.ok(profile.phaseB.length > 0);
    assert.ok(profile.phaseC.length > 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/startup-load-profile.test.mjs`  
Expected: FAIL with module/function not found.

**Step 3: Write minimal implementation**

```typescript
export type StartupTaskName = string;

export interface StartupLoadProfile {
  initialRequestBudget: number;
  phaseA: StartupTaskName[];
  phaseB: StartupTaskName[];
  phaseC: StartupTaskName[];
}

export function getStartupLoadProfile(variant: string): StartupLoadProfile {
  // Minimal full-profile default; variant refinements come later.
  return {
    initialRequestBudget: 10,
    phaseA: ['news', 'markets'],
    phaseB: ['predictions', 'fred', 'oil', 'bis', 'pizzint'],
    phaseC: ['intelligence', 'natural', 'weather', 'ais', 'cables', 'cyberThreats'],
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/startup-load-profile.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/startup-load-profile.test.mjs src/app/startup-load-profile.ts
git commit -m "test: define startup load profile contract"
```

---

### Task 2: Add Request Budget Gate + Startup Scheduler Primitive

**Files:**
- Create: `src/app/startup-request-budget.ts`
- Test: `tests/startup-request-budget.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStartupRequestBudget } from '../src/app/startup-request-budget.ts';

describe('startup request budget', () => {
  it('consumes budget and blocks when exhausted', () => {
    const budget = createStartupRequestBudget(2);
    assert.equal(budget.tryConsume('news'), true);
    assert.equal(budget.tryConsume('markets'), true);
    assert.equal(budget.tryConsume('intelligence'), false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/startup-request-budget.test.mjs`  
Expected: FAIL with missing module/function.

**Step 3: Write minimal implementation**

```typescript
export interface StartupRequestBudget {
  tryConsume: (taskName: string) => boolean;
  remaining: () => number;
}

export function createStartupRequestBudget(limit: number): StartupRequestBudget {
  const consumed = new Set<string>();
  return {
    tryConsume(taskName: string): boolean {
      if (consumed.has(taskName)) return true;
      if (consumed.size >= limit) return false;
      consumed.add(taskName);
      return true;
    },
    remaining(): number {
      return Math.max(0, limit - consumed.size);
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/startup-request-budget.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/startup-request-budget.test.mjs src/app/startup-request-budget.ts
git commit -m "feat: add startup request budget gate"
```

---

### Task 3: Eliminate Duplicate Market Dashboard Call in `loadMarkets`

**Files:**
- Modify: `src/app/data-loader.ts`
- Test: `tests/load-markets-single-dashboard-call.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('loadMarkets implementation', () => {
  it('calls fetchMarketDashboard only once', () => {
    const src = readFileSync(resolve('src/app/data-loader.ts'), 'utf-8');
    const loadMarketsBlock = src.slice(src.indexOf('async loadMarkets()'), src.indexOf('async loadPredictions()'));
    const count = (loadMarketsBlock.match(/fetchMarketDashboard\(/g) || []).length;
    assert.equal(count, 1, 'loadMarkets should call fetchMarketDashboard exactly once');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/load-markets-single-dashboard-call.test.mjs`  
Expected: FAIL because count is currently 2.

**Step 3: Write minimal implementation**

```typescript
// In loadMarkets():
// - fetch dashboard once
// - derive stocks, sectors, commodities, and crypto from the single response
// - remove second fetchMarketDashboard() call
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/load-markets-single-dashboard-call.test.mjs`  
Expected: PASS.

**Step 5: Run smoke typecheck**

Run: `npm run typecheck`  
Expected: PASS.

**Step 6: Commit**

```bash
git add tests/load-markets-single-dashboard-call.test.mjs src/app/data-loader.ts
git commit -m "perf: remove duplicate market dashboard fetch"
```

---

### Task 4: Phase Startup Tasks in `DataLoaderManager.loadAllData`

**Files:**
- Modify: `src/app/data-loader.ts`
- Modify: `src/app/event-handlers.ts`
- Modify: `src/app/startup-load-profile.ts`
- Modify: `src/app/startup-request-budget.ts`
- Test: `tests/data-loader-phased-startup.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('phased startup wiring', () => {
  it('uses startup profile and request budget in loadAllData', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('getStartupLoadProfile'));
    assert.ok(src.includes('createStartupRequestBudget'));
    assert.ok(src.includes('phaseA'));
    assert.ok(src.includes('phaseB'));
    assert.ok(src.includes('phaseC'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/data-loader-phased-startup.test.mjs`  
Expected: FAIL because phased profile/budget are not fully wired.

**Step 3: Write minimal implementation**

```typescript
// Implement phased startup:
// - Phase A: await Promise.allSettled(criticalTasks)
// - mark initial render complete
// - Phase B: queue with micro-delay/stagger
// - Phase C: load only on layer enabled / viewport interaction
// - enforce createStartupRequestBudget(profile.initialRequestBudget)
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/data-loader-phased-startup.test.mjs`  
Expected: PASS.

**Step 5: Run targeted regression tests**

Run: `node --test tests/flush-stale-refreshes.test.mjs tests/bootstrap.test.mjs`  
Expected: PASS.

**Step 6: Commit**

```bash
git add tests/data-loader-phased-startup.test.mjs src/app/data-loader.ts src/app/event-handlers.ts src/app/startup-load-profile.ts src/app/startup-request-budget.ts
git commit -m "perf: phase startup loading and enforce request budget"
```

---

### Task 5: Add Deferred Non-Critical Refresh Registration

**Files:**
- Modify: `src/app/refresh-scheduler.ts`
- Modify: `src/app/data-loader.ts`
- Test: `tests/refresh-scheduler-deferred-registration.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('refresh scheduler deferred registration', () => {
  it('supports delayed registration for non-critical jobs', () => {
    const src = readFileSync('src/app/refresh-scheduler.ts', 'utf-8');
    assert.ok(src.includes('registerDeferred') || src.includes('delayMs'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/refresh-scheduler-deferred-registration.test.mjs`  
Expected: FAIL because deferred registration does not exist yet.

**Step 3: Write minimal implementation**

```typescript
// Extend scheduler with deferred registration helper:
// registerDeferred(registration, delayMs)
// - waits delayMs before scheduleRefresh
// - skips when app destroyed
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/refresh-scheduler-deferred-registration.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/refresh-scheduler-deferred-registration.test.mjs src/app/refresh-scheduler.ts src/app/data-loader.ts
git commit -m "perf: defer non-critical refresh registrations"
```

---

### Task 6: Add Startup Performance Guardrails + Smoke Checks

**Files:**
- Create: `tests/dashboard-startup-request-budget.test.mjs`
- Modify: `tests/bootstrap.test.mjs`
- Optional docs note: `docs/plans/2026-03-04-page-load-performance-followup.md` (if needed)

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('dashboard startup budget guardrails', () => {
  it('documents startup request budget constant <= 10', () => {
    const src = readFileSync('src/app/startup-load-profile.ts', 'utf-8');
    const match = src.match(/initialRequestBudget:\s*(\d+)/);
    assert.ok(match, 'initialRequestBudget not found');
    assert.ok(Number(match[1]) <= 10, 'startup budget must be <= 10');
  });
});
```

**Step 2: Run test to verify it fails (if budget wiring is missing)**

Run: `node --test tests/dashboard-startup-request-budget.test.mjs`  
Expected: FAIL before final wiring, PASS after wiring.

**Step 3: Implement/adjust minimal code**

```typescript
// Ensure startup-load-profile explicitly exports initialRequestBudget <= 10
// and data-loader references it during startup execution.
```

**Step 4: Run full data test suite and typecheck**

Run: `npm run test:data`  
Expected: PASS.

Run: `npm run typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/dashboard-startup-request-budget.test.mjs tests/bootstrap.test.mjs src/app/startup-load-profile.ts src/app/data-loader.ts
git commit -m "test: add startup network budget guardrails"
```

---

## Verification Checklist (Before PR)

1. `npm run test:data`
2. `npm run typecheck`
3. Manual startup smoke on `full` variant:
   - Open app with cache disabled in DevTools.
   - Confirm first render appears before non-critical panels finish.
   - Confirm startup request count target is under 10 for initial phase.
4. Manual freshness smoke:
   - Confirm deferred panels hydrate within expected background window.
   - Confirm stale data badges/indicators (if present) remain accurate.

---

## Rollout Notes

- Release behind a feature flag (e.g., `startupPhasedLoading`) for safe rollout.
- Start with `full` variant only, then expand to `finance`/`tech` after metrics are stable.
- Watch:
  - LCP p75
  - Startup request count
  - Error rate in `loadAllData` tasks
  - Time-to-first-news and time-to-first-market-panel

