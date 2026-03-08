# Environment Variables

This document covers environment variables used by the World Monitor frontend. For server-side relay configuration (Vercel, relay server), see [RELAY_PARAMETERS.md](./RELAY_PARAMETERS.md).

---

## Relay Configuration

The frontend uses a relay gateway for all real-time data (aviation, markets, GDELT, OREF, polymarket, earthquakes, fires, etc.). These variables are **required** for live data; without them, the app falls back to polling or shows stale/empty panels.

### `VITE_RELAY_HTTP_URL` (required)

HTTP base URL for relay gateway bootstrap and panel endpoints. Used for bootstrap, panel, map layer, and RSS proxy fetches.

- **Example:** `https://relay.5ls.us`
- **Default:** `https://relay.5ls.us` (hardcoded fallback in code)

### `VITE_WS_RELAY_URL` (required)

WebSocket URL for real-time push updates. When unset, push is disabled and the app falls back to polling (with a console warning).

- **Example:** `wss://relay.5ls.us`
- **Used by:** `relay-push.ts`, bootstrap, maritime, predictions, military flights, GDELT intel

### `VITE_WS_RELAY_TOKEN` (optional)

Authentication token for relay WebSocket and HTTP requests. If set:

- Appended as `?token=...` to the WebSocket URL
- Sent as `Authorization: Bearer <token>` on HTTP requests (bootstrap, panel, map layer)

- **Example:** `your-optional-token-here`
- **Leave empty** if the relay does not require auth

---

## Current Architecture

All data channels now use:

1. **`/bootstrap?channels=...`** — Initial page load (fetches all channel data at once)
2. **WebSocket `wm-subscribe`** — Real-time updates via `relay-push.ts`
3. **`/panel/:channel`** — Fallback if bootstrap data unavailable

**Benefits:**

- No per-channel HTTP polling
- Single bootstrap call reduces network requests
- Real-time updates via WebSocket push
- Fallback ensures graceful degradation
