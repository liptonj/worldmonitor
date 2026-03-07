# Environment Variables

This document covers environment variables used by the World Monitor frontend. For server-side relay configuration (Vercel, relay server), see [RELAY_PARAMETERS.md](./RELAY_PARAMETERS.md).

---

## Relay Configuration

The frontend uses a relay gateway for all real-time data (aviation, markets, GDELT, OREF, polymarket, earthquakes, fires, etc.). These variables are **required** for live data; without them, the app falls back to polling or shows stale/empty panels.

### `VITE_RELAY_HTTP_URL` (required)

HTTP base URL for relay gateway. Used for bootstrap, panel, map layer, and RSS proxy fetches.

- **Example:** `https://relay.5ls.us`
- **Default:** `https://relay.5ls.us` (hardcoded fallback in code)

### `VITE_WS_RELAY_URL` (required)

WebSocket URL for real-time push. When unset, push is disabled and the app falls back to polling (with a console warning).

- **Example:** `wss://relay.5ls.us`
- **Used by:** `relay-push.ts`, bootstrap, maritime, predictions, military flights, GDELT intel

### `VITE_WS_RELAY_TOKEN` (optional)

Authentication token for relay. When set:

- Appended as `?token=...` to the WebSocket URL
- Sent as `Authorization: Bearer <token>` on HTTP requests (bootstrap, panel, map layer)

- **Example:** `your-optional-token-here`
- **Leave empty** if the relay does not require auth

---

## Migration Notes

All data channels now use:

1. **`/bootstrap?channels=...`** — Initial load on page load (single request for all relay channels)
2. **WebSocket `wm-subscribe`** — Real-time updates via `relay-push.ts`
3. **`/panel/:channel`** — Fallback when WebSocket is unavailable or bootstrap misses a channel

**No more per-channel polling!** The previous architecture polled `/panel/aviation`, `/panel/markets`, etc. on fixed intervals. The new flow uses a single bootstrap call + WebSocket subscription.
