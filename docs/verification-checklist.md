# Frontend Relay Migration Verification

> **Manual verification checklist** for developers and QA to verify the relay migration before deployment. Run through each section in DevTools and confirm behavior.

## Pre-Deployment Checklist

### Network Tab (HTTP)
- [ ] Single `/bootstrap?channels=...` request on page load
- [ ] No polling to `/panel/flights`, `/panel/markets`, etc.
- [ ] No requests to `/opensky`, `/polymarket`, `/gdelt`, `/oref`
- [ ] No repeated `/rss?url=...` polling

### WebSocket Tab
- [ ] Single WebSocket connection to relay
- [ ] `wm-subscribe` message sent with all channels
- [ ] `wm-push` messages received with correct `channel` field
- [ ] No disconnects or reconnects under normal conditions

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
