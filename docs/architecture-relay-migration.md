# Relay Migration Architecture

Post-migration data flow for the frontend relay integration. All relay channels use bootstrap + WebSocket push instead of per-channel polling.

## Data Flow (Post-Migration)

### Initial Page Load

1. User loads app
2. `bootstrap.ts` fetches `/bootstrap?channels=...` (all relay channels)
3. Data cached in IndexedDB for next visit
4. Panels hydrate from bootstrap data (instant render)

### Real-Time Updates

1. `relay-push.ts` establishes WebSocket connection
2. Sends `wm-subscribe` with all channel names
3. Relay gateway broadcasts updates via `wm-push` messages
4. Panels re-render with new data (no polling)

### Fallback (Offline/Degraded)

1. If bootstrap fails: load from IndexedDB cache (stale data)
2. If WebSocket unavailable: fallback to `/panel/:channel` polling (rare)
3. If both fail: show "Offline" indicator

### Performance Wins

- **Before:** N channels × M polls/minute = 100s of HTTP requests/min
- **After:** 1 bootstrap + 1 WebSocket = ~2 connections total
- **Latency:** Push updates < 500ms vs polling 30-180s intervals
