# Data Flow Validation Guide

This document describes the end-to-end data flow from workers to frontend panels and provides a step-by-step validation checklist, commands, expected outputs, and troubleshooting guidance.

## Data Flow Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Worker    │────▶│    Redis     │────▶│   Gateway    │────▶│  WebSocket   │────▶│  Frontend   │
│ (Orchestrator│     │  (key-value) │     │ (HTTP + WS)  │     │   wm-push    │     │   Panel     │
│  scheduled) │     │              │     │              │     │              │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                     │                    │                    │                    │
       │ SET key value       │ GET key            │ Broadcast          │ dispatch(channel,   │
       │ (JSON envelope)     │ (on update)        │ to subscribers     │   data)            │
       │                     │                    │                    │                    │
       ▼                     ▼                    ▼                    ▼                    ▼
  relay:gdelt:v1        gRPC notify          handleBroadcast      wm-push {channel,     applyGdelt()
  ai:panel-summary:v1   or polling           unwrapEnvelope       data, ts}            render panel
  risk:scores:sebuf:v1
```

### Stage 1: Worker → Redis

- **Orchestrator** schedules workers via cron (see `services/orchestrator/config.cjs`)
- **Workers** fetch external data, format as `{ timestamp, source, data, status }`, and `SET` into Redis
- **Redis keys** follow patterns: `relay:*`, `ai:*`, `risk:*`, `theater-posture:*`, etc.
- **Channel registry** maps frontend channel names to Redis keys (`src/config/channel-registry.ts`, `services/gateway/channel-keys.json`)

### Stage 2: Redis → Gateway

- **Gateway** subscribes to Redis keys (or polls) and receives updates
- **gRPC** `Broadcast(channel, payload)` is called by workers/ais-processor when data changes
- **Gateway** looks up channel → Redis key mapping, fetches latest value, unwraps envelope, broadcasts to WebSocket clients

### Stage 3: Gateway → WebSocket

- **WebSocket server** accepts connections and `wm-subscribe` messages
- **Clients** send: `{"type":"wm-subscribe","channels":["ais","gdelt",...]}`
- **Gateway** broadcasts: `{"type":"wm-push","channel":"ais","data":{...},"ts":1234567890}`
- **Envelope** (`timestamp`, `source`, `status`) is stripped before sending

### Stage 4: WebSocket → Frontend

- **relay-push.ts** maintains singleton WebSocket connection, sends `wm-subscribe` on connect
- **Handlers** registered via `subscribe(channel, handler)` receive `data` from `wm-push`
- **channel-state.ts** marks channel `ready` with `lastDataAt`
- **Panels** use `fetchRelayPanel()` for HTTP fallback and WebSocket push for live updates

### Stage 5: Frontend → Panel

- **Data loader** / **bootstrap** fetches `/bootstrap` for initial hydration
- **Panel components** (e.g. `InsightsPanel`, `GdeltPanel`) subscribe to channels and render when data arrives
- **applyMethod** handlers (e.g. `applyGdelt`, `applyIntelligence`) process pushed data and update UI

---

## Quick Validation Script

Run the automated validation script from the repo root:

```bash
# Full validation (includes WebSocket test if wscat installed)
bash scripts/validate-data-flow.sh

# Skip WebSocket test (faster)
bash scripts/validate-data-flow.sh --quick

# Use local Redis instead of Docker
bash scripts/validate-data-flow.sh --local
```

**Environment variables:**
- `GATEWAY_PORT` — Gateway HTTP port (default: 3004)
- `GATEWAY_HOST` — Gateway host (default: localhost)

---

## Step-by-Step Validation Checklist

### 1. Services Running

```bash
cd services && docker compose ps
```

**Expected:** `redis`, `gateway`, `orchestrator`, `worker`, `ais-processor` (and optionally `ai-engine`, `ingest-telegram`) show as `running` or `Up`.

### 2. Redis Keys

```bash
cd services && docker compose exec -T redis redis-cli KEYS "relay:*"
cd services && docker compose exec -T redis redis-cli KEYS "ai:*"
cd services && docker compose exec -T redis redis-cli KEYS "risk:*"
cd services && docker compose exec -T redis redis-cli KEYS "theater-posture:*"
```

**Expected:** Non-empty lists of keys. Common keys:
- `relay:ais-snapshot:v1`, `relay:gdelt:v1`, `relay:flights:v1`, etc.
- `ai:digest:global:v1`, `ai:panel-summary:v1`
- `risk:scores:sebuf:v1`
- `theater-posture:sebuf:v1`

### 3. Key TTLs and Values

```bash
# Check TTL (-1 = no expiry, -2 = key doesn't exist)
cd services && docker compose exec -T redis redis-cli TTL "relay:ais-snapshot:v1"

# Get value (first 200 chars)
cd services && docker compose exec -T redis redis-cli GET "relay:ais-snapshot:v1" | head -c 200
```

**Expected:** TTL ≥ -1; GET returns JSON string (envelope with `timestamp`, `source`, `data`).

### 4. Gateway HTTP

```bash
# Health
curl -s http://localhost:3004/health

# Panel endpoints (channel names from channel-keys.json)
curl -s http://localhost:3004/panel/ais | jq .
curl -s http://localhost:3004/panel/gdelt | jq .
curl -s http://localhost:3004/panel/intelligence | jq .
curl -s http://localhost:3004/panel/strategic-risk | jq .
curl -s "http://localhost:3004/panel/ai:panel-summary" | jq .
```

**Expected:**
- `/health` → `{"status":"ok","uptime":...}`
- `/panel/:channel` → 200 with JSON payload (or `{"status":"pending"}` if no data yet)

### 5. WebSocket Connection

**Option A: Browser DevTools**

1. Open app (e.g. `http://localhost:5173` or deployed URL)
2. DevTools → Network → filter **WS**
3. Find WebSocket to relay (e.g. `ws://localhost:3004` or `wss://relay.example.com`)
4. Messages tab: outgoing `{"type":"wm-subscribe","channels":[...]}`
5. Incoming `{"type":"wm-push","channel":"ais","data":{...},"ts":...}`

**Option B: wscat (CLI)**

```bash
# Install: npm i -g wscat
wscat -c ws://localhost:3004 -x '{"type":"wm-subscribe","channels":["ais","gdelt"]}'
```

**Expected:** Connection opens; after subscribing, `wm-push` messages appear when workers publish.

### 6. Channel-by-Channel Commands

| Channel           | Redis Key                  | Check Command                                                                 |
|-------------------|----------------------------|-------------------------------------------------------------------------------|
| ais               | relay:ais-snapshot:v1       | `redis-cli GET relay:ais-snapshot:v1`                                         |
| gdelt             | relay:gdelt:v1             | `redis-cli GET relay:gdelt:v1`                                                |
| intelligence      | ai:digest:global:v1        | `redis-cli GET ai:digest:global:v1`                                           |
| strategic-risk    | risk:scores:sebuf:v1       | `redis-cli GET risk:scores:sebuf:v1`                                          |
| strategic-posture | theater-posture:sebuf:v1   | `redis-cli GET theater-posture:sebuf:v1`                                      |
| ai:panel-summary  | ai:panel-summary:v1        | `redis-cli GET ai:panel-summary:v1`                                           |
| markets           | market:dashboard:v1        | `redis-cli GET market:dashboard:v1`                                           |
| flights           | relay:flights:v1           | `redis-cli GET relay:flights:v1`                                              |

### 7. Bootstrap Endpoint

```bash
curl -s http://localhost:3004/bootstrap | jq 'keys'
```

**Expected:** Object with hydration keys (`aisSnapshot`, `gdelt`, `strategicRisk`, etc.). Values may be `null` if workers haven't populated yet.

### 8. Gateway Logs

```bash
cd services && docker compose logs gateway --tail 50
```

**Expected:** `Broadcast` debug logs when gRPC receives updates; no repeated errors.

### 9. Orchestrator Logs

```bash
cd services && docker compose logs orchestrator --tail 100 | grep -iE "error|failed|executing"
```

**Expected:** Job execution logs; no `error` or `failed` for scheduled channels.

---

## Expected Outputs Summary

| Check              | Success                                      | Failure                                      |
|--------------------|-----------------------------------------------|----------------------------------------------|
| Services           | `redis`, `gateway`, `orchestrator` Up          | Containers exited or missing                  |
| Redis keys         | Non-empty `relay:*`, `ai:*`                    | Empty or only few keys                        |
| TTL                | -1 or positive integer                         | -2 (key missing)                             |
| /health            | `{"status":"ok"}`                              | Connection refused, 5xx                       |
| /panel/:channel    | 200 + JSON                                    | 404 (channel not in gateway)                  |
| WebSocket          | Connect + wm-push received                     | Connection refused, no pushes                 |
| Panel UI           | Data renders or "No data"                      | "Loading..." indefinitely, "Insufficient Data" |

---

## Troubleshooting Guide

### No Redis keys for a channel

**Cause:** Worker not scheduled, worker failing, or wrong Redis key.

**Actions:**
1. Check `services/orchestrator/config.cjs` for the channel’s cron and Redis key
2. Check `services/gateway/channel-keys.json` — channel name must map to that Redis key
3. Run `npm run generate:channel-keys` after changing `channel-registry.ts`
4. Inspect orchestrator logs: `docker compose logs orchestrator`

### Gateway returns 404 for /panel/:channel

**Cause:** Channel not in `channel-keys.json`.

**Actions:**
1. Confirm channel in `src/config/channel-registry.ts`
2. Regenerate: `npm run generate:channel-keys`
3. Restart gateway: `docker compose restart gateway`

### WebSocket connects but no wm-push

**Cause:** Workers not publishing, gRPC not called, or no subscribers.

**Actions:**
1. Confirm Redis has data for the channel
2. Check gateway logs for `Broadcast` and `clients_notified`
3. Ensure frontend sends `wm-subscribe` with the correct channel names
4. Verify `relay-push.ts` subscribes to the channels used by the panel

### Panel stuck on "Loading..."

**Cause:** No bootstrap data, no WebSocket push, or handler not registered.

**Actions:**
1. Check browser console for `[relay-push] wm-push received { hasData: false }` — indicates envelope/payload issue
2. Verify panel’s channel is in `wm-subscribe` (from `panels.ts` or `channel-registry`)
3. Test `/panel/:channel` — if it returns data, HTTP path works; issue is likely WebSocket or handler
4. Confirm `applyMethod` handler exists in `intelligence-handler.ts` or equivalent

### "All Intel sources disabled" (Intel Feed)

**Cause:** `intelligence` channel empty or not subscribed.

**Actions:**
1. Check `ai:digest:global:v1` in Redis
2. Ensure `intelligence` is in frontend subscription list
3. Verify Intel panel uses `applyIntelligence` and subscribes to `intelligence`

### "Insufficient Data" (Strategic Risk)

**Cause:** `risk:scores:sebuf:v1` empty or strategic-risk worker not running.

**Actions:**
1. Check Redis: `redis-cli GET risk:scores:sebuf:v1`
2. Verify strategic-risk worker in orchestrator config
3. Create stub worker if missing (see plan Task 10)

### GDELT panel loading forever

**Cause:** GDELT was using direct `/gdelt` instead of relay channel.

**Actions:**
1. Ensure `gdelt` is in channel-registry with `redisKey: 'relay:gdelt:v1'`
2. Ensure `fetchGdeltPanel()` uses `fetchRelayPanel('gdelt')` not direct fetch
3. Verify GDELT worker publishes to `relay:gdelt:v1`

---

## Related Files

- `scripts/validate-data-flow.sh` — Automated validation script
- `src/config/channel-registry.ts` — Channel definitions and Redis keys
- `services/gateway/channel-keys.json` — Generated mapping (from channel-registry)
- `services/gateway/index.cjs` — Gateway HTTP/WebSocket/gRPC
- `src/services/relay-push.ts` — Frontend WebSocket client
- `docs/plans/2026-03-09-fix-all-panel-data-flows.md` — Full implementation plan
