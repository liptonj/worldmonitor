# Phase 6: Frontend Migration Guide

A practical guide for migrating the frontend from proxy/polling patterns to the relay gateway (WebSocket + HTTP).

## What to Remove

Remove all direct proxy calls to these endpoints:

- `/opensky` — OpenSky flight data
- `/rss` — RSS feeds
- `/polymarket` — Polymarket data
- `/gdelt` — GDELT news
- `/oref` — OREF alerts

Also remove any `setInterval` or polling logic that repeatedly fetches these endpoints.

## What to Replace With

| Old Pattern | New Pattern |
|-------------|-------------|
| `fetch('/opensky')` every N seconds | WebSocket `wm-subscribe` + `wm-push` events |
| `fetch('/rss')` | WebSocket subscribe to `rss` channel |
| `fetch('/polymarket')` | WebSocket subscribe to `polymarket` channel |
| `fetch('/gdelt')` | WebSocket subscribe to `gdelt` channel |
| `fetch('/oref')` | WebSocket subscribe to `oref` channel |
| Initial page load data | `GET /bootstrap` for all channels at once |
| Cached read of a single channel | `GET /panel/:channel` (e.g. `/panel/opensky`) |

## Migration Pattern

### Before (polling)

```javascript
// BAD: Polling every 60 seconds
useEffect(() => {
  const load = () => fetch('/opensky').then(r => r.json()).then(setData);
  load();
  const id = setInterval(load, 60000);
  return () => clearInterval(id);
}, []);
```

### After (WebSocket subscribe)

```javascript
// GOOD: Subscribe via WebSocket, receive real-time pushes
useEffect(() => {
  const ws = new WebSocket(RELAY_WS_URL); // e.g. wss://relay.example.com

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'wm-subscribe', channels: ['opensky'] }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'wm-push' && msg.channel === 'opensky') {
      setData(msg.payload);
    }
  };

  return () => ws.close();
}, []);
```

### Bootstrap (initial load)

On page load, call `GET /bootstrap` once to get initial data for all channels you need:

```javascript
// Fetch initial data for all channels in one request
const bootstrap = await fetch(RELAY_HTTP_URL + '/bootstrap').then(r => r.json());
// bootstrap = { opensky: {...}, rss: {...}, polymarket: {...}, ... }
```

Then subscribe via WebSocket for real-time updates.

### Cached read (single channel)

If you only need one channel and don't need real-time updates:

```javascript
const data = await fetch(RELAY_HTTP_URL + '/panel/opensky').then(r => r.json());
```

## Verification

1. Open DevTools → Network tab.
2. Filter by Fetch/XHR.
3. Confirm **zero** requests to `/opensky`, `/rss`, `/polymarket`, `/gdelt`, `/oref`.
4. You should see:
   - One `GET /bootstrap` on page load (or per channel `GET /panel/:channel` if not using bootstrap).
   - A WebSocket connection to the relay gateway.
   - WebSocket frames with `wm-push` messages when data updates.

## Summary

| Action | Endpoint / Message |
|--------|--------------------|
| Initial load (all channels) | `GET /bootstrap` |
| Initial load (single channel) | `GET /panel/:channel` |
| Subscribe for real-time | WS: `{ type: 'wm-subscribe', channels: ['opensky', ...] }` |
| Receive updates | WS: `{ type: 'wm-push', channel: 'opensky', payload: {...} }` |
