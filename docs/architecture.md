# World Monitor Architecture

High-level architecture and data flow for the frontend. See [architecture-relay-migration.md](./architecture-relay-migration.md) for relay-specific migration details.

## Data Flow (Relay Architecture)

### Initial Page Load

1. User loads app
2. `bootstrap.ts` fetches `/bootstrap?variant=full&channels=...` (all relay channels at once)
3. Data cached in IndexedDB for next visit via `persistent-cache.ts`
4. Panels hydrate from bootstrap data using `getHydratedData()` (instant render)

### Real-Time Updates

1. `relay-push.ts` establishes WebSocket connection to relay gateway
2. Sends `wm-subscribe` message with all subscribed channel names
3. Relay gateway broadcasts updates via `wm-push` messages
4. Panels re-render with new data (no HTTP polling)

### Fallback (Offline/Degraded Mode)

1. If bootstrap fails: load from IndexedDB cache (stale data, max 10 min old)
2. If WebSocket unavailable: fallback to on-demand `/panel/:channel` HTTP fetch (rare)
3. If both fail: show per-panel error states (e.g. "No data from relay")

### Performance Benefits

- **Before:** N channels × M polls/minute = 100s of HTTP requests/min
- **After:** 1 bootstrap + 1 WebSocket = ~2 connections total
- **Latency:** Push updates < 500ms vs polling 30-180s intervals
