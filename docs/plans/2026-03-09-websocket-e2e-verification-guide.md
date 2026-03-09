# End-to-End Verification Guide — WebSocket Data/Payload Fix

This guide walks through verifying the three code fixes for the WebSocket data/payload field mismatch:

1. **Gateway** — `handleBroadcast` unwraps envelopes before broadcasting
2. **Client** — `relay-push.ts` reads `msg.data` (matching gateway format)
3. **Diagnostics** — Logging for missing data or handlers

---

## Build Steps

### Gateway

**Option A: Local Docker build (recommended for verification)**

> **Note:** The gateway requires `channel-keys.json` (generated from `src/config/channel-registry.ts`). Ensure it is committed and up to date. When the registry changes, run `npm run generate:channel-keys` from the repo root and commit the updated file.

```bash
cd /Users/jolipton/Projects/worldmonitor/services

# Build gateway image from local source (includes the fix)
docker build -f gateway/Dockerfile -t sliptronic/worldrelay_gateway:latest .
```

If the base image is missing, build it first:

```bash
docker build -f Dockerfile.base -t sliptronic/worldrelay_base:latest .
```

**Option B: Deploy to production (Docker Hub)**

```bash
cd /Users/jolipton/Projects/worldmonitor/services

# Build and push
docker build -f gateway/Dockerfile -t sliptronic/worldrelay_gateway:latest .
docker push sliptronic/worldrelay_gateway:latest
```

On the production server, pull and restart:

```bash
docker pull sliptronic/worldrelay_gateway:latest
# Restart gateway (method depends on your deployment)
```

---

### Frontend

```bash
cd /Users/jolipton/Projects/worldmonitor

# For local dev (recommended for verification)
npm run dev

# Or for production build
npm run build
```

---

## Environment Setup for Local Verification

Ensure `.env` (or `.env.local`) in the project root has:

```bash
VITE_WS_RELAY_URL=ws://localhost:3004
# Optional: VITE_WS_RELAY_TOKEN=your-token
```

For local Docker, the gateway must be reachable at `ws://localhost:3004`. Use `docker-compose.dev.yml` to expose the port.

---

## Running the Stack Locally

```bash
cd /Users/jolipton/Projects/worldmonitor/services

# Start relay stack with local build + port 3004 exposed
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Verify gateway is up
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
```

Then start the frontend:

```bash
cd /Users/jolipton/Projects/worldmonitor
npm run dev
```

---

## Browser Verification Steps

### 1. Open the app

- Navigate to `http://localhost:5173` (or your Vite dev URL)
- Open DevTools (F12 or Cmd+Option+I) → **Console** tab

### 2. Check console logs

**Expected (success):**

- `[relay-push] connected, subscribing to [...]` — appears shortly after load
- The array should list channels such as `markets`, `predictions`, `news:full`, etc.

**Failure indicators:**

- `[relay-push] VITE_WS_RELAY_URL not set — push disabled, polling fallback active` — env var missing
- `[relay-push] wm-push received { channel: '...', hasData: false, hasHandlers: true }` — gateway still sending without `data` or envelope not unwrapped
- `[relay-push] wm-push received { channel: '...', hasData: true, hasHandlers: false }` — channel subscribed but no handler (may be normal for some channels)

### 3. Inspect WebSocket frames (Network tab)

1. Open DevTools → **Network** tab
2. Filter by **WS** (WebSocket)
3. Click the WebSocket connection to `localhost:3004` (or your relay URL)
4. Open the **Messages** sub-tab
5. Wait for incoming `wm-push` messages (or trigger data by changing layers/panels)

**Expected payload shape:**

```json
{
  "type": "wm-push",
  "channel": "markets",
  "data": { ... },
  "ts": 1234567890
}
```

**Verify:**

- `data` exists and is **not** an envelope object
- `data` should **not** contain `timestamp`, `source`, or `status` at the top level
- For array payloads (e.g. news): `data` should be `[...]` not `{ timestamp, source, data: [...], status }`

### 4. Check panel behavior

- Open panels that receive WebSocket data (e.g. Markets, News, AIS, Flights, Predictions)
- Confirm they populate with live data
- Data should update when the relay pushes new content (may take a few seconds to minutes depending on channel)

---

## Expected Results

| Check | Expected |
|-------|----------|
| **Console** | `[relay-push] connected, subscribing to [...]` appears |
| **Console** | No `[relay-push] wm-push received { hasData: false }` warnings |
| **WebSocket frames** | `data` field contains unwrapped payloads (no `timestamp`/`source`/`status` envelope) |
| **Panels** | Populate with live data from WebSocket pushes |

---

## If Issues Found

1. **Capture evidence**
   - Screenshot or copy console output (including any `[relay-push]` messages)
   - Screenshot or copy a sample WebSocket frame (right-click → Copy message)
   - Note which panels fail to update

2. **Report back** with:
   - Exact console messages
   - Sample `wm-push` JSON from Network tab
   - Whether `hasData` is `false` or `true` in warnings
   - Gateway version/build (local vs Docker Hub)

3. **Quick checks**
   - Confirm `VITE_WS_RELAY_URL` points to the running gateway
   - Confirm gateway was rebuilt after the fix
   - Run gateway tests: `cd services/gateway && node --test test/gateway.test.cjs`
   - Run relay-push tests: `node --test tests/relay-push-service.test.mjs`

---

## Final Commit (if adjustments needed)

If you make any fixes during verification:

```bash
git add <modified-files>
git commit -m "fix: <description of adjustment>"
```

Otherwise, no further commits are required for Task 4.
