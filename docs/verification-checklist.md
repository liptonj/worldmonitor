# Frontend Relay Migration Verification

> **Manual verification checklist** for developers and QA to verify the relay architecture is functioning correctly before deployment. Run through each section in DevTools and confirm behavior.

---

## Pre-Deployment Checklist

### Network Tab (HTTP)
- [ ] Single `/bootstrap?variant=full&channels=...` request on page load
- [ ] No polling to `/panel/flights`, `/panel/markets`, etc.
- [ ] No requests to `/opensky`, `/polymarket`, `/gdelt`, `/oref`
- [ ] No repeated `/rss?url=...` polling

### WebSocket (Network → WS)
- [ ] Single WebSocket connection to relay
- [ ] `wm-subscribe` message sent with all channels
- [ ] `wm-push` messages received with correct `channel` field
- [ ] No disconnects or reconnects under normal conditions

Note: You may also see `wm-ping` heartbeat frames every 30 seconds. These are normal and keep the connection alive.

### UI Behavior
- [ ] All panels load on page load (from bootstrap or fallback)
- [ ] Panels update in real-time (via WebSocket push)
- [ ] No visible polling spinners or repeated fetches
- [ ] Graceful degradation if WebSocket unavailable

### Performance
- [ ] Page load time improved (fewer HTTP requests)
- [ ] Network waterfall shows parallel bootstrap + WebSocket init
- [ ] No request storms or rate limiting

### Edge Cases
- [ ] Reload page while offline: panels load from IndexedDB cache
- [ ] Disconnect WebSocket mid-session: fallback /panel requests work
- [ ] Reconnect WebSocket: `wm-subscribe` re-sent, updates resume

---

## How to Verify Each Item

### Network Tab (HTTP)

| Item | How to verify |
|------|---------------|
| Single bootstrap request | Open DevTools → **Network** tab → Filter by `bootstrap` → Reload page. You should see exactly **one** request matching `/bootstrap?variant=full&channels=...` |
| No panel polling | Filter by `panel` or search for `flights`, `markets`, `gdelt`, etc. After initial load, no repeated requests to `/panel/*` should appear over 2–3 minutes. |
| No direct proxy requests | Filter or search for `opensky`, `polymarket`, `gdelt`, `oref`. These should not appear; all data flows through relay bootstrap/WebSocket. |
| No RSS polling | Filter by `rss` or search for `rss?url=`. No repeated `/rss?url=...` requests. |

### WebSocket (Network → WS)

| Item | How to verify |
|------|---------------|
| Single WebSocket | DevTools → **Network** tab → **WS** filter → Reload. One WebSocket connection to the relay URL (e.g. `wss://relay.5ls.us`). |
| wm-subscribe sent | Click the WebSocket row → **Messages** tab. Look for an outgoing message with `{"type":"wm-subscribe","channels":[...]}` containing all channel names. |
| wm-push received | In **Messages** tab, incoming frames should include `wm-push` with a `channel` field matching panel data (e.g. `markets`, `flights`, `oref`). |
| No disconnects | Leave the page open for 2–3 minutes. WebSocket status should remain **101** (open). No reconnect loops in console. |

### UI Behavior

| Item | How to verify |
|------|---------------|
| Panels load on load | All dashboard panels (flights, markets, GDELT, OREF, etc.) render within a few seconds of page load. |
| Real-time updates | Wait for a known-updating channel (e.g. markets, OREF). Panel content should update without a full page reload. |
| No polling spinners | No recurring loading indicators or repeated fetch animations. |
| Graceful degradation | Simulate WebSocket failure (e.g. block WebSocket in DevTools or use offline mode). Panels should still load from bootstrap or fallback `/panel` requests. |

### Performance

| Item | How to verify |
|------|---------------|
| Fewer HTTP requests | Compare request count on load vs. pre-migration. Should see 1 bootstrap + static assets, not N panel requests. |
| Parallel bootstrap + WS | In **Network** waterfall, bootstrap fetch and WebSocket upgrade should start in parallel shortly after page load. |
| No request storms | No bursts of many identical requests in quick succession. |

### Edge Cases

| Item | How to verify |
|------|---------------|
| Offline reload | DevTools → **Network** → **Offline** → Reload. Panels should load from IndexedDB cache (may show stale data). Note: Offline panels load from IndexedDB only if the cache was populated within the last 10 minutes. |
| WebSocket disconnect | DevTools → **Network** → Right-click WebSocket → **Close connection**, or use a proxy to drop WS. Panels should fall back to `/panel/:channel` requests. |
| WebSocket reconnect | After closing WS, wait for reconnect (or reload). New connection should send `wm-subscribe` again; updates should resume. |

---

## Expected vs Unexpected Behavior

### Network Tab

| Scenario | Expected | Unexpected |
|----------|----------|------------|
| Page load | 1 `/bootstrap?variant=full&channels=...` request | Multiple bootstrap requests, or polling to `/panel/*` |
| Ongoing traffic | WebSocket frames only; no repeated HTTP | Repeated `/panel/flights`, `/panel/markets`, etc. |
| Proxy endpoints | None | Requests to `/opensky`, `/polymarket`, `/gdelt`, `/oref` |
| RSS | None or minimal | Repeated `/rss?url=...` polling |

### WebSocket (Network → WS)

| Scenario | Expected | Unexpected |
|----------|----------|------------|
| Connection | 1 WebSocket to relay | Multiple WebSockets, or connections to non-relay URLs |
| Subscribe | `wm-subscribe` sent once on connect | No subscribe message, or subscribe sent repeatedly |
| Push | `wm-push` with valid `channel` | No push messages, or malformed payloads |
| Stability | Connection stays open | Frequent disconnects/reconnects |

### UI

| Scenario | Expected | Unexpected |
|----------|----------|------------|
| Initial load | All panels render from bootstrap/fallback | Blank panels, errors, or long loading |
| Updates | Panels update in real-time | No updates, or only after manual refresh |
| Degradation | Fallback works when WS unavailable | App breaks or shows errors when WS fails |

---

## Troubleshooting Tips

### WebSocket won't connect

- **Check `VITE_WS_RELAY_URL`** — Must be set and point to a valid `wss://` URL (e.g. `wss://relay.5ls.us`).
- **Check CORS / CSP** — Ensure `wss:` and the relay host are allowed in Content-Security-Policy.
- **Check token** — If relay requires auth, set `VITE_WS_RELAY_TOKEN`; it is appended as `?token=...` to the WebSocket URL.

### Bootstrap returns 404 or fails

- **Check `VITE_RELAY_HTTP_URL`** — Must point to the relay HTTP base (e.g. `https://relay.5ls.us`).
- **Check relay health** — Verify the relay service is running and `/bootstrap` is reachable.
- **Check channels param** — URL should include `channels=...` with comma-separated channel names.

### Panels stay empty

- **Check bootstrap response** — Inspect the `/bootstrap` response body; it should contain data for requested channels.
- **Check hydration** — `getHydratedData()` is used on load; ensure bootstrap runs before panel render.
- **Check fallback** — If bootstrap fails, `/panel/:channel` should be used; verify those endpoints exist.

### Polling still visible

- **Polling still visible?** Search for `scheduleRefresh` or polling logic in `data-loader.ts` or `refresh-scheduler.ts`. Ensure `RefreshScheduler` is not being instantiated (it's deprecated).
- **Search for direct fetches** — Ensure no direct `fetch` to `/opensky`, `/polymarket`, etc.
- **Check relay-push** — `initRelayPush()` should be called with all channel names; subscriptions should handle updates.

---

## Evidence Collection

### Screenshots to take

1. **Network tab — single bootstrap request**  
   - Filter: `bootstrap`  
   - Show exactly one `/bootstrap?variant=full&channels=...` request on page load.

2. **WebSocket messages — subscribe and push**  
   - Filter: WS  
   - Show `wm-subscribe` (outgoing) and `wm-push` (incoming) frames with correct structure.

3. **No polling in Network tab**  
   - Filter by `panel`, `opensky`, `polymarket`, `gdelt`, `oref`  
   - Show no repeated requests after initial load (or only fallback if WS was disconnected).

### Optional evidence

- Network waterfall showing parallel bootstrap + WebSocket init.
- Console output showing no errors or reconnect loops during normal operation.

---

## Task 15: Test Update (Completed)

**Objective:** Find tests that mock HTTP polling and update them to mock WebSocket push.

**Finding:** No tests needed updating.

- **Search scope:** `src/**/*.test.ts`, `src/**/*.spec.ts`, `tests/**/*.test.mjs`
- **Result:** No test files in `src/`. Tests in `tests/` do not mock `fetchRelayPanel` or `relay-http`.
- **Existing tests:** `relay-push-wiring.test.mjs`, `zero-browser-api-calls.test.mjs` are migration guards (assert App.ts does NOT call `scheduleRefresh`). They remain valid post-migration.
- **Reference:** See `docs/test-migration-status.md` for full audit.
