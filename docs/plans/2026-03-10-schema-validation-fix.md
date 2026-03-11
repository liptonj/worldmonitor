# Schema Validation & Panel Data Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the blocking schema validation gate in `relay-push.ts` that prevents panel data delivery, fix OREF handler payload shape, and ensure all channel schemas are accurate — so every panel receives data via WebSocket push-on-subscribe.

**Architecture:** WebSocket push-on-subscribe is the only data path. Workers → Redis → Gateway `unwrapEnvelope` → WebSocket `wm-push` → client `relay-push.ts` dispatch → handlers → panels. Schema validation in dispatch must be non-blocking (warn-only) — handlers already have their own defensive parsing. The gateway's `ENVELOPE_FIELDS` strips `timestamp`, `source`, `status`, `errors` (plural) but NOT `error` (singular), which causes partial envelope leakage for error responses.

**Tech Stack:** TypeScript (Vite frontend), Zod v4 (`^4.3.6`), Node.js CommonJS (backend services), Redis (ioredis), WebSocket

---

## Task 1: Make relay-push schema validation non-blocking

**Files:**
- Modify: `src/services/relay-push.ts:30-62`

**Step 1: Change dispatch to warn-only on schema failure (never block)**

Current code (`src/services/relay-push.ts` lines 30–62):
```typescript
function dispatch(channel: string, payload: unknown): void {
  if (payload === undefined || payload === null) {
    console.warn(`[wm:${channel}] null/undefined payload — setting channel to error`);
    setChannelState(channel, 'error', 'websocket', { error: 'No data available' });
    return;
  }

  const schema = channelSchemas[channel];
  let resolvedPayload: unknown = payload;
  if (schema) {
    const result = schema.safeParse(payload);
    if (!result.success) {
      console.warn(
        `[relay-push] schema mismatch (${channel}):`,
        result.error.issues.map((i) => i.message).join('; '),
      );
      setChannelState(channel, 'error', 'websocket', { error: 'Invalid payload shape' });
      return;
    }
    resolvedPayload = result.data;
  }

  setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(resolvedPayload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}
```

New code:
```typescript
function dispatch(channel: string, payload: unknown): void {
  if (payload === undefined || payload === null) {
    console.warn(`[wm:${channel}] null/undefined payload — setting channel to error`);
    setChannelState(channel, 'error', 'websocket', { error: 'No data available' });
    return;
  }

  const schema = channelSchemas[channel];
  if (schema) {
    const result = schema.safeParse(payload);
    if (!result.success) {
      const payloadType = Array.isArray(payload) ? 'array' : typeof payload;
      const keys = (payload && typeof payload === 'object' && !Array.isArray(payload))
        ? Object.keys(payload as Record<string, unknown>).slice(0, 8)
        : [];
      console.warn(
        `[relay-push] schema mismatch (${channel}):`,
        result.error.issues.map((i) => i.message).join('; '),
        { payloadType, keys },
      );
    }
  }

  setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}
```

Key changes:
- Removed `return` after schema failure — data always flows to handlers
- Removed `setChannelState('error')` on schema failure — handlers decide state
- Always pass original `payload` to handlers (not Zod-resolved data — handlers have their own parsing)
- Added `payloadType` and `keys` to warning for diagnostics

**Step 2: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors related to relay-push.

**Step 3: Commit**

```bash
git add src/services/relay-push.ts
git commit -m "fix(relay-push): make schema validation non-blocking — warn only, always dispatch"
```

---

## Task 2: Fix OREF handler — handle error envelope leakage

**Files:**
- Modify: `src/data/intelligence-handler.ts:248-268`

**Step 1: Update OREF handler to detect error envelope payloads**

The OREF channel function returns `{ timestamp, source, status, data: null, error: '...' }` when proxy auth is missing. Gateway `unwrapEnvelope` strips `timestamp`, `source`, `status` but NOT `error` (singular — only `errors` plural is in `ENVELOPE_FIELDS`). This produces `{ data: null, error: 'OREF_PROXY_AUTH not configured' }` which the handler doesn't recognize.

Current code (`src/data/intelligence-handler.ts` lines 248–268):
```typescript
    oref: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:oref] skipped — invalid payload type:', typeof payload); return; }
      let data = payload as OrefAlertsResponse;
      if (!('configured' in data) && !('alerts' in data)) {
        const raw = payload as Record<string, unknown>;
        if ('current' in raw || 'history' in raw) {
          const current = raw.current as unknown[] | null;
          const history = raw.history as unknown[] | null;
          data = {
            configured: true,
            alerts: Array.isArray(current) ? current as OrefAlertsResponse['alerts'] : [],
            historyCount24h: Array.isArray(history) ? history.length : 0,
            timestamp: new Date().toISOString(),
          };
        } else {
          console.warn('[wm:oref] unrecognized payload shape — rendering as unconfigured');
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
      }
      renderOrefAlerts(data);
    },
```

New code:
```typescript
    oref: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:oref] skipped — invalid payload type:', typeof payload); return; }
      let data = payload as OrefAlertsResponse;
      if (!('configured' in data) && !('alerts' in data)) {
        const raw = payload as Record<string, unknown>;
        if ('error' in raw || (raw.data === null || raw.data === undefined)) {
          const errorMsg = typeof raw.error === 'string' ? raw.error : 'service unavailable';
          console.debug(`[wm:oref] error envelope received: ${errorMsg}`);
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
        if ('current' in raw || 'history' in raw) {
          const current = raw.current as unknown[] | null;
          const history = raw.history as unknown[] | null;
          data = {
            configured: true,
            alerts: Array.isArray(current) ? current as OrefAlertsResponse['alerts'] : [],
            historyCount24h: Array.isArray(history) ? history.length : 0,
            timestamp: new Date().toISOString(),
          };
        } else {
          console.warn('[wm:oref] unrecognized payload shape', { keys: Object.keys(raw).slice(0, 8) });
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
      }
      renderOrefAlerts(data);
    },
```

Key change: detect `{ data: null, error: '...' }` (partially-unwrapped error envelope) before falling to "unrecognized" branch.

**Step 2: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/data/intelligence-handler.ts
git commit -m "fix(oref-handler): handle error envelope leakage from gateway unwrapEnvelope"
```

---

## Task 3: Add `error` (singular) to gateway ENVELOPE_FIELDS

**Files:**
- Modify: `services/gateway/index.cjs:104`

**Step 1: Add 'error' to ENVELOPE_FIELDS**

Current code (`services/gateway/index.cjs` line 104):
```javascript
const ENVELOPE_FIELDS = new Set(['timestamp', 'source', 'status', 'errors']);
```

New code:
```javascript
const ENVELOPE_FIELDS = new Set(['timestamp', 'source', 'status', 'errors', 'error']);
```

This prevents error envelope fields from leaking through `unwrapEnvelope` for ALL channels, not just OREF.

**Step 2: Run gateway tests**

```bash
cd services && node --test gateway/test/gateway.test.cjs 2>&1
```

Expected: All tests pass.

**Step 3: Commit**

```bash
git add services/gateway/index.cjs
git commit -m "fix(gateway): add 'error' (singular) to ENVELOPE_FIELDS to prevent leakage"
```

---

## Task 4: Fix Zod schemas to match actual unwrapped payloads

**Files:**
- Modify: `src/data/channel-schemas.ts`

**Step 1: Audit and fix each schema against actual payload shapes**

After `unwrapEnvelope`, these are the actual shapes per channel (from the channel functions + envelope stripping):

| Channel | Channel function returns | After `unwrapEnvelope` |
|---------|------------------------|----------------------|
| `markets` | `{ timestamp, source, data: { stocks, commodities, ... } }` | `{ stocks, commodities, ... }` |
| `giving` | `{ timestamp, source, status, data: { summary: {...} } }` | `{ summary: {...} }` |
| `telegram` | `{ timestamp, source, data: { messages, count } }` | `{ messages, count }` |
| `conflict` | `{ timestamp, source, data: { events: [...] } }` | `{ events: [...] }` |
| `climate` | varies (array or `{ anomalies }`) | varies |

Current code (`src/data/channel-schemas.ts`):
```typescript
import { z } from 'zod';

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: z.object({}).passthrough(),
  predictions: z.union([z.array(z.unknown()), z.object({ markets: z.array(z.unknown()) }).passthrough()]),
  telegram: z.union([
    z.array(z.unknown()),
    z.object({}).passthrough().refine((obj) => {
      if (Array.isArray((obj as Record<string, unknown>).items) || Array.isArray((obj as Record<string, unknown>).messages)) {
        return true;
      }
      const nested = (obj as Record<string, unknown>).data;
      return !!nested
        && typeof nested === 'object'
        && (Array.isArray((nested as Record<string, unknown>).items)
          || Array.isArray((nested as Record<string, unknown>).messages));
    }, { message: 'Must have items/messages array at root or in data' }),
  ]),
  intelligence: z.object({}).passthrough(),
  conflict: z.object({ events: z.array(z.unknown()) }).passthrough(),
  ais: z.object({}).passthrough(),
  giving: z.object({}).passthrough(),
  climate: z.union([z.array(z.unknown()), z.object({ anomalies: z.array(z.unknown()) }).passthrough()]),
  fred: z.union([z.array(z.unknown()), z.object({ series: z.array(z.unknown()) }).passthrough()]),
  oil: z.union([z.array(z.unknown()), z.object({ prices: z.array(z.unknown()) }).passthrough()]),
  'ai:intel-digest': z.object({}).passthrough(),
  'ai:panel-summary': z.object({}).passthrough(),
  'ai:risk-overview': z.object({}).passthrough(),
  'ai:posture-analysis': z.object({}).passthrough(),
  gdelt: z.object({}).passthrough(),
  cyber: z.union([z.array(z.unknown()), z.object({ threats: z.array(z.unknown()) }).passthrough()]),
  'security-advisories': z.union([z.array(z.unknown()), z.object({ items: z.array(z.unknown()) }).passthrough()]),
};
```

New code:
```typescript
import { z } from 'zod';

const looseObject = z.record(z.string(), z.unknown());

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: looseObject,
  predictions: z.union([z.array(z.unknown()), looseObject]),
  telegram: z.union([
    z.array(z.unknown()),
    looseObject.refine((obj) => {
      return Array.isArray(obj.items)
        || Array.isArray(obj.messages)
        || (obj.data && typeof obj.data === 'object'
          && (Array.isArray((obj.data as Record<string, unknown>).items)
            || Array.isArray((obj.data as Record<string, unknown>).messages)));
    }, { message: 'Must have items/messages array at root or in data' }),
  ]),
  intelligence: looseObject,
  conflict: looseObject.refine(
    (obj) => Array.isArray(obj.events),
    { message: 'Must have events array' },
  ),
  ais: looseObject,
  giving: looseObject,
  climate: z.union([z.array(z.unknown()), looseObject]),
  fred: z.union([z.array(z.unknown()), looseObject]),
  oil: z.union([z.array(z.unknown()), looseObject]),
  'ai:intel-digest': looseObject,
  'ai:panel-summary': looseObject,
  'ai:risk-overview': looseObject,
  'ai:posture-analysis': looseObject,
  gdelt: looseObject,
  cyber: z.union([z.array(z.unknown()), looseObject]),
  'security-advisories': z.union([z.array(z.unknown()), looseObject]),
};
```

Key change: use `z.record(z.string(), z.unknown())` instead of `z.object({}).passthrough()`. The `z.record()` approach is the canonical Zod v4 way to accept any object with string keys — it doesn't rely on `.passthrough()` chaining behavior that may differ between Zod versions. The `.refine()` calls work identically on `z.record()`.

**Step 2: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/data/channel-schemas.ts
git commit -m "fix(channel-schemas): use z.record for Zod v4 compatibility, remove fragile passthrough chains"
```

---

## Task 5: Build, verify, and test end-to-end

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

**Step 3: Run backend tests**

```bash
cd services && node --test gateway/test/gateway.test.cjs && node --test ais-processor/test/ais-processor.test.cjs
```

Expected: All tests pass.

**Step 4: Verify no unintended bare returns in handlers**

```bash
rg 'return;' src/data/*-handler.ts | rg -v 'showError|showUnavailable|setData|render|refresh|applyPush|setDigest|setEvents|setAnomalies|update|applyCable|applyCyber|applyRelay|logPayload|typeof payload|console\.|Array\.isArray|earlySignal|error' | head -20
```

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors from schema validation fix"
```

---

## Execution Order

| Task | Effort | Fixes |
|------|--------|-------|
| **1. Non-blocking dispatch** | 5 min | ALL panels blocked by schema validation (giving, potentially telegram, others) |
| **2. OREF handler** | 5 min | OREF "unrecognized payload shape" error |
| **3. Gateway ENVELOPE_FIELDS** | 2 min | Prevents error envelope leakage for all channels |
| **4. Fix Zod schemas** | 10 min | Accurate schema warnings, Zod v4 compatibility |
| **5. Build + verify** | 5 min | Everything compiles and tests pass |

**Execute in order: 1→2→3→4→5**

---

## Success Criteria

1. No `[relay-push] schema mismatch` errors in console for valid payloads
2. Giving panel renders data (no longer blocked by schema gate)
3. Telegram panel renders data when ingest is running
4. OREF panel shows "unconfigured" cleanly instead of "unrecognized payload shape" error
5. Schema validation logs actionable warnings with payload shape info when mismatches occur
6. `npm run build` completes with zero errors
7. All backend tests pass
