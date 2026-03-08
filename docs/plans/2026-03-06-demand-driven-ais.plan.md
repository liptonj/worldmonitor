# Demand-Driven AIS: Stop Ship Traffic Data When Layer Is Off

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure zero AIS data flows (polling, callbacks, relay subscriptions) when the ship traffic layer is disabled.

**Architecture:** AIS data currently flows through 3 independent paths that must ALL be gated by the `ais` layer toggle: (1) relay WebSocket channel subscription, (2) maritime HTTP polling via `initAisStream()`, and (3) military vessel AIS callbacks via `initMilitaryVesselStream()`. Path 1 is already fixed. Paths 2 and 3 are the root cause — military vessels independently start AIS polling even when the `ais` layer is off.

**Tech Stack:** Vanilla TypeScript, WebSocket relay, maritime/military-vessels services

---

## Root Cause Analysis

There are 3 independent AIS data paths:

| Path | Mechanism | Gated by `ais` layer? | Status |
|------|-----------|----------------------|--------|
| 1. Relay WS channel `ais` | `subscribeChannel('ais')` | Yes (CHANNEL_TO_LAYER) | **Fixed** |
| 2. Maritime HTTP polling | `initAisStream()` → `startPolling()` → `GET /ais/snapshot` every N seconds | Partially — starts on init if layer is on, but nothing stops it when military vessels restart it | **Broken** |
| 3. Military vessel callbacks | `initMilitaryVesselStream()` → `registerAisCallback()` + `initAisStream()` | No — military layer/Strategic Posture always calls this | **Broken** |

### Call chain that keeps AIS alive when layer is off:

```
loadIntelligenceSignals() / loadMilitary()
  → initMilitaryVesselStream()
    → registerAisCallback(processAisPosition)   // adds position callback
    → initAisStream()                             // starts polling
      → startPolling()
        → pollSnapshot() every 30s
          → shouldIncludeCandidates() returns true  // because positionCallbacks.size > 0
          → GET /ais/snapshot?candidates=true       // requests position data from relay
          → emitCandidateReports()                  // fires position callbacks
```

When user toggles AIS layer OFF:
```
event-handlers.ts:
  → disconnectAisStream()     // stops polling interval
  → unsubscribeChannel('ais') // stops relay push
  // BUT: does NOT call disconnectMilitaryVesselStream()
  // So next loadMilitary() call restarts everything
```

---

## Task 1: Make military vessels independent of AIS polling

**Files:**
- Modify: `src/services/military-vessels.ts:499-514`
- Modify: `src/services/military-vessels.ts:543-558`

**Context:** Military vessel tracking currently piggybacks on the AIS polling stream. When the military layer loads, it calls `initAisStream()` which starts HTTP polling. This must be decoupled so military vessels work without starting AIS polling.

**Step 1: Remove `initAisStream()` from `initMilitaryVesselStream()`**

In `src/services/military-vessels.ts`, change `initMilitaryVesselStream()`:

```typescript
export function initMilitaryVesselStream(): void {
  if (isTracking) return;

  vesselCache = null;
  breaker.clearCache();

  registerAisCallback(processAisPosition);
  isTracking = true;

  // REMOVED: initAisStream() — AIS polling is now controlled
  // exclusively by the ais layer toggle. Military vessels receive
  // position data only when AIS is active.
}
```

Remove lines 510-513 (the `if (isAisConfigured()) { initAisStream(); }` block).

**Step 2: Remove `initMilitaryVesselStream()` from `fetchMilitaryVessels()`**

In `src/services/military-vessels.ts`, change `fetchMilitaryVessels()` lines 555-558:

```typescript
// BEFORE:
if (!isTracking && isAisConfigured()) {
  initMilitaryVesselStream();
}

// AFTER: Remove these lines entirely. Military vessel stream
// initialization is handled by loadMilitary() in data-loader.ts.
```

**Step 3: Type check**

Run: `npx tsc --noEmit --pretty`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/services/military-vessels.ts
git commit -m "fix: decouple military vessels from AIS polling lifecycle"
```

---

## Task 2: Gate AIS polling on the `ais` layer state

**Files:**
- Modify: `src/services/maritime/index.ts:380-394`
- Modify: `src/services/maritime/index.ts:339-346`

**Context:** `registerAisCallback()` currently calls `startPolling()` unconditionally. It should only register the callback — polling is controlled by the layer toggle.

**Step 1: Remove `startPolling()` from `registerAisCallback()`**

In `src/services/maritime/index.ts`, change `registerAisCallback()`:

```typescript
export function registerAisCallback(callback: AisCallback): void {
  positionCallbacks.add(callback);
  // REMOVED: startPolling() — polling is started/stopped
  // by initAisStream()/disconnectAisStream() via the ais layer toggle.
}
```

**Step 2: Type check**

Run: `npx tsc --noEmit --pretty`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/services/maritime/index.ts
git commit -m "fix: registerAisCallback no longer starts polling independently"
```

---

## Task 3: Coordinate military vessel cleanup on AIS layer toggle off

**Files:**
- Modify: `src/app/event-handlers.ts:801-809`

**Context:** When the `ais` layer is toggled off, we call `disconnectAisStream()` which stops polling. But we should also disconnect military vessel tracking since it depends on AIS position data.

**Step 1: Add `disconnectMilitaryVesselStream()` to the ais-off path**

In `src/app/event-handlers.ts`, update the ais layer toggle handler:

```typescript
if (layer === 'ais') {
  if (enabled) {
    this.ctx.map?.setLayerLoading('ais', true);
    initAisStream();
    this.callbacks.waitForAisData();
  } else {
    disconnectAisStream();
    disconnectMilitaryVesselStream();
  }
  return;
}
```

Add `disconnectMilitaryVesselStream` to the import from `@/services`:

```typescript
import {
  // ... existing imports ...
  disconnectMilitaryVesselStream,
} from '@/services';
```

**Step 2: Verify the import is re-exported from services/index.ts**

Check that `disconnectMilitaryVesselStream` is exported from `src/services/index.ts`. If not, add the re-export.

**Step 3: Type check**

Run: `npx tsc --noEmit --pretty`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/app/event-handlers.ts src/services/index.ts
git commit -m "fix: disconnect military vessel stream when AIS layer is toggled off"
```

---

## Task 4: Gate `initMilitaryVesselStream` on AIS layer in data-loader

**Files:**
- Modify: `src/app/data-loader.ts:930-934`
- Modify: `src/app/data-loader.ts:1411-1414`

**Context:** `loadIntelligenceSignals()` and `loadMilitary()` unconditionally call `initMilitaryVesselStream()`. This should only happen when the `ais` layer is actually enabled, since military vessel tracking depends on AIS data.

**Step 1: Gate `initMilitaryVesselStream()` on AIS layer state**

In `loadIntelligenceSignals()` (around line 930-934):

```typescript
// BEFORE:
if (isMilitaryVesselTrackingConfigured()) {
  initMilitaryVesselStream();
}

// AFTER:
if (isMilitaryVesselTrackingConfigured() && this.ctx.mapLayers.ais) {
  initMilitaryVesselStream();
}
```

In `loadMilitary()` (around line 1411-1414):

```typescript
// BEFORE:
if (isMilitaryVesselTrackingConfigured()) {
  initMilitaryVesselStream();
}

// AFTER:
if (isMilitaryVesselTrackingConfigured() && this.ctx.mapLayers.ais) {
  initMilitaryVesselStream();
}
```

**Step 2: Type check**

Run: `npx tsc --noEmit --pretty`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "fix: only start military vessel AIS tracking when ais layer is active"
```

---

## Task 5: Verify relay-side AIS demand gating

**Files:**
- Modify: `scripts/ais-relay.cjs` (connectUpstream trigger)

**Context:** The relay connects to `aisstream.io` as soon as any WebSocket client connects, regardless of whether anyone subscribes to the `ais` channel. This wastes the relay server's bandwidth and CPU processing AIS messages no one is consuming.

**Step 1: Check if any client is subscribed to `ais` before connecting upstream**

Find where `connectUpstream()` is called in the WebSocket `connection` handler (around line 6741) and gate it:

```javascript
// BEFORE (in wss.on('connection')):
connectUpstream();

// AFTER:
// Only connect to aisstream.io if at least one client needs AIS
const aisSubscribers = channelSubscribers.get('ais');
if (aisSubscribers && aisSubscribers.size > 0) {
  connectUpstream();
}
```

Also find the `wm-subscribe` handler and add `connectUpstream()` when a client subscribes to `ais`:

```javascript
// In the wm-subscribe handler, after subscribing channels:
if (accepted.includes('ais')) {
  connectUpstream();
}
```

Also disconnect upstream when no clients need AIS:

```javascript
// In the wm-unsubscribe handler, after removing the ais subscription:
if (msg.channels.includes('ais')) {
  const remaining = channelSubscribers.get('ais');
  if (!remaining || remaining.size === 0) {
    disconnectUpstream();
  }
}
```

Create `disconnectUpstream()` if it doesn't exist:

```javascript
function disconnectUpstream() {
  if (upstreamSocket) {
    console.log('[Relay] No AIS subscribers — disconnecting from aisstream.io');
    upstreamSocket.close();
    upstreamSocket = null;
  }
}
```

Also handle client disconnect — check if the disconnecting client was the last `ais` subscriber.

**Step 2: Verify the `/ais/snapshot` HTTP endpoint still works**

The `/ais/snapshot` endpoint should still call `connectUpstream()` when hit, since it's an explicit data request. Verify this path is unchanged.

**Step 3: Test manually**

1. Start relay locally
2. Connect a WebSocket client without subscribing to `ais` — relay should NOT connect to aisstream.io
3. Subscribe to `ais` — relay should connect to aisstream.io
4. Unsubscribe from `ais` — relay should disconnect from aisstream.io

**Step 4: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "perf: only connect to aisstream.io when clients subscribe to ais channel"
```

---

## Task 6: Final verification

**Step 1: Full type check**

Run: `npx tsc --noEmit --pretty`
Expected: Clean build

**Step 2: Lint check**

Run lints on all modified files.

**Step 3: Behavioral verification**

With the AIS layer OFF:
- [ ] No `[relay-push] connected, subscribing to` should include `'ais'`
- [ ] No `/ais/snapshot` requests in the network tab
- [ ] No `PositionReport` messages in console
- [ ] Military layer still shows USNI fleet data (static, no live AIS)
- [ ] Strategic Posture panel still works (without live vessel positions)

With the AIS layer toggled ON:
- [ ] `subscribeChannel('ais')` fires
- [ ] `/ais/snapshot` polling starts
- [ ] Ship positions appear on map
- [ ] Military vessels receive live AIS data

With the AIS layer toggled back OFF:
- [ ] `unsubscribeChannel('ais')` fires
- [ ] `disconnectAisStream()` stops polling
- [ ] `disconnectMilitaryVesselStream()` stops military callbacks
- [ ] No more AIS traffic

**Step 4: Commit and push**

```bash
git push
```
