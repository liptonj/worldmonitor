# WebSocket Data/Payload Field Mismatch Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs preventing all WebSocket push data from reaching UI panels.

**Architecture:** The gateway broadcasts messages with field `data` but the client reads `payload` (always `undefined`). Additionally, the gateway's WebSocket broadcast path skips `unwrapEnvelope()` that the HTTP path applies, sending raw envelopes instead of clean payloads.

**Tech Stack:** TypeScript (Vite frontend), Node.js CommonJS (gateway service), `node:test` for tests

---

## Root Cause Analysis

**Bug 1 — Field name mismatch (blocks ALL channels):**
- Gateway `handleBroadcast` (line 226 of `services/gateway/index.cjs`) sends: `{ type: 'wm-push', channel, data, ts }`
- Client `relay-push.ts` (line 78) reads: `msg.payload` → always `undefined`
- Every handler receives `undefined`, so no panel ever renders WebSocket data.

**Bug 2 — Missing envelope unwrap on WebSocket path:**
- HTTP endpoints (`/panel/:channel`, `/bootstrap`) call `unwrapEnvelope()` to strip metadata fields (`timestamp`, `source`, `status`, `errors`) before sending to the frontend.
- The gRPC→WebSocket broadcast path sends raw worker output without unwrapping.
- Even after fixing Bug 1, handlers would receive `{timestamp, source, data: [...], status}` instead of the clean payload they expect.

---

### Task 1: Fix gateway `handleBroadcast` to unwrap envelopes

**Files:**
- Modify: `services/gateway/index.cjs`
- Test: `services/gateway/test/gateway.test.cjs`

**Step 1: Export `unwrapEnvelope` from gateway**

In `services/gateway/index.cjs`, add `unwrapEnvelope` to the `module.exports` block:

```javascript
module.exports = {
  handleBroadcast,
  routeHttpRequest,
  unwrapEnvelope,
  PHASE4_CHANNEL_KEYS,
  PHASE4_MAP_KEYS,
};
```

**Step 2: Add `unwrapEnvelope` call in `handleBroadcast`**

In `services/gateway/index.cjs`, modify `handleBroadcast` to unwrap before sending:

```javascript
function handleBroadcast(channel, data, subscriptions) {
  const clients = subscriptions.get(channel);
  if (!clients || clients.size === 0) {
    return 0;
  }
  const ts = Math.floor(Date.now() / 1000);
  const unwrapped = unwrapEnvelope(data);
  const msg = JSON.stringify({ type: 'wm-push', channel, data: unwrapped, ts });
  let count = 0;
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) {
        ws.send(msg);
        count++;
      }
    } catch (err) {
      log.debug('WS send error', { channel, error: err.message });
    }
  }
  return count;
}
```

**Step 3: Write tests for `unwrapEnvelope`**

Add tests to `services/gateway/test/gateway.test.cjs`:

```javascript
const { unwrapEnvelope } = require('../index.cjs');

describe('unwrapEnvelope', () => {
  it('returns inner data for simple envelope (only data as non-envelope field)', () => {
    const raw = { timestamp: '2026-01-01', source: 'test', status: 'success', data: [1, 2, 3] };
    const result = unwrapEnvelope(raw);
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('strips envelope fields and keeps payload fields for rich payloads', () => {
    const raw = { timestamp: '2026-01-01', source: 'test', status: 'success', stocks: [], commodities: [] };
    const result = unwrapEnvelope(raw);
    assert.deepStrictEqual(result, { stocks: [], commodities: [] });
  });

  it('returns arrays as-is', () => {
    const raw = [1, 2, 3];
    assert.deepStrictEqual(unwrapEnvelope(raw), [1, 2, 3]);
  });

  it('returns null/undefined as-is', () => {
    assert.strictEqual(unwrapEnvelope(null), null);
    assert.strictEqual(unwrapEnvelope(undefined), undefined);
  });

  it('returns object with no payload keys as-is', () => {
    const raw = { timestamp: '2026-01-01', source: 'test', status: 'success' };
    assert.deepStrictEqual(unwrapEnvelope(raw), raw);
  });
});
```

**Step 4: Update existing `handleBroadcast` test to verify unwrapping**

Update the existing test in `services/gateway/test/gateway.test.cjs` that checks the sent message to verify envelope fields are stripped:

```javascript
it('unwraps envelope before broadcasting to clients', () => {
  const sent = [];
  const client1 = { send: (m) => sent.push(m), readyState: 1 };
  const subscriptions = new Map([['news:full', new Set([client1])]]);
  const envelope = { timestamp: '2026-01-01', source: 'news:full', status: 'success', data: [{ title: 'test' }] };
  const count = handleBroadcast('news:full', envelope, subscriptions);
  assert.strictEqual(count, 1);
  const parsed = JSON.parse(sent[0]);
  assert.strictEqual(parsed.type, 'wm-push');
  assert.strictEqual(parsed.channel, 'news:full');
  assert.deepStrictEqual(parsed.data, [{ title: 'test' }]);
  assert.strictEqual(parsed.data.timestamp, undefined);
  assert.strictEqual(parsed.data.source, undefined);
});
```

**Step 5: Run tests**

Run: `cd services/gateway && node --test test/gateway.test.cjs`

Expected: All tests pass.

**Step 6: Commit**

```bash
git add services/gateway/index.cjs services/gateway/test/gateway.test.cjs
git commit -m "fix(gateway): unwrap envelope in WebSocket broadcast to match HTTP path"
```

---

### Task 2: Fix client `relay-push.ts` to read `data` field

**Files:**
- Modify: `src/services/relay-push.ts`
- Test: `tests/relay-push-service.test.mjs`

**Step 1: Write the failing test**

Add to `tests/relay-push-service.test.mjs`:

```javascript
it('relay-push.ts reads msg.data (not msg.payload) for wm-push dispatch', () => {
  const src = readFileSync('src/services/relay-push.ts', 'utf8');
  assert.ok(
    src.includes('msg.data') || src.includes("msg['data']"),
    'must read msg.data field from wm-push messages (gateway sends data, not payload)'
  );
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/relay-push-service.test.mjs`

Expected: FAIL — `relay-push.ts` currently reads `msg.payload`, not `msg.data`.

**Step 3: Fix the field name in `relay-push.ts`**

In `src/services/relay-push.ts`, change line 78 from:

```typescript
dispatch(msg.channel, msg.payload);
```

to:

```typescript
dispatch(msg.channel, msg.data);
```

This reads `data` which matches what the gateway sends. We use `msg.data` (not a fallback like `msg.payload ?? msg.data`) because the gateway is the single source of truth and always sends `data`.

**Step 4: Run test to verify it passes**

Run: `node --test tests/relay-push-service.test.mjs`

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/services/relay-push.ts tests/relay-push-service.test.mjs
git commit -m "fix(relay-push): read msg.data field to match gateway wm-push format"
```

---

### Task 3: Add diagnostic logging for push data flow

**Files:**
- Modify: `src/services/relay-push.ts`

**Step 1: Add a debug log in the dispatch path**

In `src/services/relay-push.ts`, update the message handler to log received pushes for debugging. Add a log after the `msg.type` check:

```typescript
socket.addEventListener('message', (event) => {
  lastMessageAt = Date.now();
  const raw = typeof event.data === 'string' ? event.data : '';
  if (!raw) return;
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.type === 'wm-push' && typeof msg.channel === 'string') {
      const hasData = msg.data !== undefined && msg.data !== null;
      const hasHandlers = handlers.has(msg.channel);
      if (!hasData || !hasHandlers) {
        console.warn('[relay-push] wm-push received', {
          channel: msg.channel,
          hasData,
          hasHandlers,
          handlerCount: handlers.get(msg.channel)?.size ?? 0,
        });
      }
      dispatch(msg.channel, msg.data);
    }
  } catch {
    console.warn('[relay-push] received unparseable message');
  }
});
```

This only logs when there's a potential problem (no data or no handlers), keeping normal operation quiet.

**Step 2: Commit**

```bash
git add src/services/relay-push.ts
git commit -m "fix(relay-push): add diagnostic logging for missing data or handlers"
```

---

### Task 4: Verify end-to-end

**Step 1: Build and deploy the gateway**

Rebuild and deploy the gateway service with the `unwrapEnvelope` fix.

**Step 2: Build the frontend**

Run: `npm run build` (or `npm run dev` for local testing)

**Step 3: Verify in browser**

Open the app and check the browser console:
- Confirm `[relay-push] connected, subscribing to [...]` appears
- Confirm NO `[relay-push] wm-push received { hasData: false }` warnings
- Confirm panels populate with live data from WebSocket pushes
- Check the Network tab's WebSocket frames to verify `data` field contains unwrapped payloads (no `timestamp`/`source`/`status` envelope fields)

**Step 4: Final commit**

If any adjustments were needed, commit them. Otherwise, no action needed.
