# Strategic Posture End-to-End Verification Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify that strategic-posture.cjs correctly fetches OpenSky credentials from Supabase Vault, proxies requests through the relay server, and that the frontend StrategicPosturePanel subscribes to WebSocket channel updates (not HTTP calls).

**Architecture:** Backend worker executes strategic-posture.cjs channel function via orchestrator schedule, which proxies OpenSky API calls through relay.5ls.us using RELAY_SHARED_SECRET authentication. The relay server handles OAuth2 with OpenSky using credentials from Supabase Vault. Frontend panel subscribes to 'strategic-posture' WebSocket channel for real-time updates.

**Tech Stack:** Node.js (CJS), Supabase Vault, Redis, Docker, gRPC, WebSocket, TypeScript frontend

---

## Task 1: Verify Supabase Vault Credentials

**Files:**
- Query: Supabase Vault via MCP

**Step 1: List all secrets in Supabase Vault**

Use MCP tool to query vault.secrets table:

```bash
CallMcpTool(plugin-supabase-supabase, execute_sql, {
  "query": "SELECT id, name, description FROM vault.secrets WHERE name IN ('OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET', 'RELAY_SHARED_SECRET', 'WS_RELAY_URL')"
})
```

**Expected:** Should return 4 rows with:
- OPENSKY_CLIENT_ID (value: jlipton522-api-client)
- OPENSKY_CLIENT_SECRET (value: ZLGqFsHjnQGpVLDq29Th9f2JFCIoC2ra)
- RELAY_SHARED_SECRET (exists)
- WS_RELAY_URL (value: https://relay.5ls.us)

**Step 2: Verify get_vault_secret_value RPC function exists**

```bash
CallMcpTool(plugin-supabase-supabase, execute_sql, {
  "query": "SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'get_vault_secret_value'"
})
```

**Expected:** Function exists (used by secrets.cjs line 66)

**Step 3: Test retrieving OPENSKY_CLIENT_SECRET via RPC**

```bash
CallMcpTool(plugin-supabase-supabase, execute_sql, {
  "query": "SELECT get_vault_secret_value('OPENSKY_CLIENT_SECRET') AS value"
})
```

**Expected:** Returns 'ZLGqFsHjnQGpVLDq29Th9f2JFCIoC2ra'

**Step 4: Document findings**

Create checklist in plan:
- [ ] OPENSKY_CLIENT_ID in Vault = jlipton522-api-client
- [ ] OPENSKY_CLIENT_SECRET in Vault = ZLGqFsHjnQGpVLDq29Th9f2JFCIoC2ra  
- [ ] RELAY_SHARED_SECRET in Vault (value verified)
- [ ] WS_RELAY_URL in Vault = https://relay.5ls.us
- [ ] get_vault_secret_value() RPC function exists

---

## Task 2: Verify Worker Configuration for OpenSky

**Files:**
- Read: `/Users/jolipton/Projects/worldmonitor/services/docker-compose.yml:145-180`
- Read: `/Users/jolipton/Projects/worldmonitor/services/.env.production`

**Step 1: Verify docker-compose.yml worker environment**

Check that worker service has these environment variables:

```yaml
environment:
  - OPENSKY_CLIENT_ID=${OPENSKY_CLIENT_ID:-}
  - OPENSKY_CLIENT_SECRET=${OPENSKY_CLIENT_SECRET:-}
  - WS_RELAY_URL=${WS_RELAY_URL:-}
  - RELAY_SHARED_SECRET=${RELAY_SHARED_SECRET:-}
```

Expected: Lines 169-172 in docker-compose.yml

**Step 2: Verify .env.production has required values**

```bash
grep -E "^(OPENSKY_CLIENT_ID|OPENSKY_CLIENT_SECRET|WS_RELAY_URL|RELAY_SHARED_SECRET)=" services/.env.production
```

Expected output:
```
OPENSKY_CLIENT_ID=jlipton522-api-client
OPENSKY_CLIENT_SECRET=ZLGqFsHjnQGpVLDq29Th9f2JFCIoC2ra
WS_RELAY_URL=https://relay.5ls.us
RELAY_SHARED_SECRET=<actual secret value>
```

**Step 3: Verify secrets.cjs includes OpenSky credentials**

Read `/Users/jolipton/Projects/worldmonitor/services/shared/secrets.cjs:11-25`

Expected: Lines 22-23 contain:
```javascript
'OPENSKY_CLIENT_ID',
'OPENSKY_CLIENT_SECRET',
```

**Step 4: Document findings**

- [ ] docker-compose.yml worker has WS_RELAY_URL env var
- [ ] docker-compose.yml worker has RELAY_SHARED_SECRET env var
- [ ] docker-compose.yml worker has OPENSKY_CLIENT_ID env var
- [ ] docker-compose.yml worker has OPENSKY_CLIENT_SECRET env var
- [ ] .env.production has all 4 required values
- [ ] secrets.cjs KNOWN_SECRETS includes OPENSKY_CLIENT_ID
- [ ] secrets.cjs KNOWN_SECRETS includes OPENSKY_CLIENT_SECRET

---

## Task 3: Verify strategic-posture.cjs Uses Relay Proxy

**Files:**
- Read: `/Users/jolipton/Projects/worldmonitor/services/shared/channels/strategic-posture.cjs:33-48`

**Step 1: Verify relay URL construction**

Lines 37-39:
```javascript
const relayBase = config?.WS_RELAY_URL || process.env.WS_RELAY_URL;
const openskyBase = relayBase ? relayBase.replace(/^wss?:\/\//, 'https://').replace(/\/$/, '') : 'https://opensky-network.org/api/states/all';
const openskyUrl = relayBase ? `${openskyBase}/opensky` : 'https://opensky-network.org/api/states/all';
```

**Expected behavior:**
- If `WS_RELAY_URL` is set (e.g., "https://relay.5ls.us"), then:
  - `openskyBase` = "https://relay.5ls.us"
  - `openskyUrl` = "https://relay.5ls.us/opensky"
- If `WS_RELAY_URL` is NOT set:
  - `openskyUrl` = "https://opensky-network.org/api/states/all" (direct, unauthenticated)

**Step 2: Verify RELAY_SHARED_SECRET authentication header**

Lines 42-47:
```javascript
const sharedSecret = config?.RELAY_SHARED_SECRET || process.env.RELAY_SHARED_SECRET;
if (sharedSecret) {
  const authHeader = (config?.RELAY_AUTH_HEADER || process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
  headers[authHeader] = sharedSecret;
  headers.Authorization = `Bearer ${sharedSecret}`;
}
```

**Expected:** If RELAY_SHARED_SECRET exists, headers will include:
- Custom auth header (default: 'x-relay-key')
- Authorization: Bearer token

**Step 3: Verify fetch call uses constructed URL and headers**

Lines 54-58:
```javascript
const data = await http.fetchJson(url, {
  headers,
  timeout: POSTURE_TIMEOUT_MS,
});
```

**Expected:** Calls `https://relay.5ls.us/opensky?lamin=...&lamax=...` with auth headers

**Step 4: Document findings**

- [ ] strategic-posture.cjs reads WS_RELAY_URL from config/env
- [ ] strategic-posture.cjs reads RELAY_SHARED_SECRET from config/env
- [ ] strategic-posture.cjs constructs relay URL: `${relayBase}/opensky`
- [ ] strategic-posture.cjs adds Authorization: Bearer header
- [ ] strategic-posture.cjs does NOT directly implement OpenSky OAuth2
- [ ] strategic-posture.cjs falls back to direct OpenSky call if WS_RELAY_URL is missing

---

## Task 4: Verify Orchestrator Schedules strategic-posture

**Files:**
- Query: Supabase wm_admin.service_config table

**Step 1: Query service_config for strategic-posture**

```bash
CallMcpTool(plugin-supabase-supabase, execute_sql, {
  "query": "SELECT service_key, enabled, cron_schedule, redis_key, ttl_seconds FROM wm_admin.service_config WHERE service_key = 'strategic-posture'"
})
```

**Expected:**
- enabled: true
- cron_schedule: e.g., "*/5 * * * *" (every 5 minutes)
- redis_key: "theater-posture:sebuf:v1"

**Step 2: Verify orchestrator loads this config**

Read `/Users/jolipton/Projects/worldmonitor/services/orchestrator/index.cjs:154-166`

Line 159: Query loads all enabled service configs
Line 175: Schedules cron jobs for each config

**Expected:** Orchestrator will schedule strategic-posture to run on its cron_schedule

**Step 3: Verify orchestrator triggers worker via gRPC**

Lines 89-100:
```javascript
async function triggerService(supabase, serviceConfig, workerClient, aiEngineClient, triggerRequestId = null, executeFn = execute) {
  const client = shouldRouteToAiEngine(serviceConfig.service_key) ? aiEngineClient : workerClient;
  const req = buildTriggerRequest(serviceConfig);
  // ...
  const res = await executeFn(client, req);
}
```

**Expected:** 
- strategic-posture routes to `workerClient` (not ai-engine)
- Sends gRPC Execute request with service_key='strategic-posture'

**Step 4: Document findings**

- [ ] service_config has strategic-posture row with enabled=true
- [ ] orchestrator loads service_config on startup (line 269)
- [ ] orchestrator schedules cron job for strategic-posture
- [ ] orchestrator sends gRPC Execute to worker service
- [ ] orchestrator uses buildTriggerRequest() to construct request payload

---

## Task 5: Verify Worker Executes strategic-posture.cjs

**Files:**
- Read: `/Users/jolipton/Projects/worldmonitor/services/worker/index.cjs`
- Read: `/Users/jolipton/Projects/worldmonitor/services/shared/worker-runner.cjs`

**Step 1: Verify worker receives gRPC Execute request**

Worker index.cjs should have gRPC server that handles Execute calls:

```javascript
// Expected structure:
server.addService(proto.WorkerService.service, {
  Execute: async (call, callback) => {
    const { serviceKey } = call.request;
    const channelFn = getChannel(serviceKey);
    const result = await runWorkerFn(channelFn, call.request);
    callback(null, result);
  }
});
```

**Step 2: Verify worker-runner.cjs merges config and secrets**

Read `/Users/jolipton/Projects/worldmonitor/services/shared/worker-runner.cjs`

Expected: Function that:
1. Gets channel function by service_key ('strategic-posture')
2. Calls `getAllCachedSecrets()` from secrets.cjs
3. Merges config with cached secrets
4. Passes merged config to channel function

```javascript
const enrichedConfig = { ...config, ...getAllCachedSecrets() };
const result = await channelFn({ config: enrichedConfig, redis, log, http });
```

**Step 3: Verify worker initializes secrets on startup**

Expected: Worker calls `initSecrets()` before handling requests:

```javascript
const { initSecrets } = require('@worldmonitor/shared/secrets.cjs');
await initSecrets();
```

**Step 4: Document findings**

- [ ] worker/index.cjs has gRPC Execute handler
- [ ] worker gets channel function by service_key
- [ ] worker-runner.cjs calls getAllCachedSecrets()
- [ ] worker-runner.cjs merges config with secrets
- [ ] worker passes enriched config to strategic-posture.cjs
- [ ] worker calls initSecrets() on startup

---

## Task 6: Trace Full Backend Data Flow

**Files:**
- Test: End-to-end backend flow

**Step 1: Verify secrets flow: Vault → Redis → Worker**

1. Supabase Vault stores OPENSKY_CLIENT_SECRET
2. secrets.cjs:initSecrets() loads from Vault (line 129)
3. secrets.cjs caches in Redis with key `wm:vault:v1:OPENSKY_CLIENT_SECRET` (line 89)
4. secrets.cjs caches in memory `_cache` Map (line 114)
5. worker-runner.cjs calls getAllCachedSecrets() (line 159)
6. strategic-posture.cjs receives config with OPENSKY_CLIENT_SECRET

**Step 2: Verify proxy flow: Worker → Relay → OpenSky**

1. strategic-posture.cjs gets `WS_RELAY_URL` from config
2. strategic-posture.cjs constructs URL: `https://relay.5ls.us/opensky?lamin=10&lamax=66...`
3. strategic-posture.cjs adds `Authorization: Bearer ${RELAY_SHARED_SECRET}` header
4. strategic-posture.cjs calls http.fetchJson(url, { headers })
5. Relay server receives request at /opensky endpoint
6. Relay server uses OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET to get OAuth2 token from auth.opensky-network.org
7. Relay server calls opensky-network.org/api/states/all with Bearer token
8. Relay server returns data to strategic-posture.cjs

**Step 3: Verify data flow: Worker → Redis → Frontend**

1. strategic-posture.cjs processes OpenSky data
2. strategic-posture.cjs returns { data: { theaters: [...] }, status: 'success' }
3. worker stores result in Redis with key `theater-posture:sebuf:v1`
4. gateway/relay publishes update to WebSocket channel 'strategic-posture'
5. Frontend StrategicPosturePanel receives push via applyPush() (line 196)

**Step 4: Document findings**

- [ ] Secrets: Vault → secrets.cjs → Redis cache → worker config
- [ ] Proxy: worker → relay.5ls.us/opensky → auth.opensky-network.org → opensky API
- [ ] Data: worker → Redis → WebSocket → frontend panel
- [ ] strategic-posture.cjs does NOT make direct OAuth2 calls
- [ ] Relay server (relay.5ls.us) handles OAuth2 authentication

---

## Task 7: Verify Frontend WebSocket Subscription (Not HTTP)

**Files:**
- Read: `/Users/jolipton/Projects/worldmonitor/src/components/StrategicPosturePanel.ts:14`
- Read: `/Users/jolipton/Projects/worldmonitor/src/components/StrategicPosturePanel.ts:196-201`
- Grep: Frontend for fetchRelayPanel usage in StrategicPosturePanel

**Step 1: Verify channelKeys subscription**

Line 14:
```typescript
override readonly channelKeys = ['strategic-posture'];
```

**Expected:** Panel subscribes to 'strategic-posture' WebSocket channel

**Step 2: Verify applyPush() receives WebSocket data**

Lines 196-201:
```typescript
applyPush(payload: unknown): void {
  const data = adaptPosturePayload(payload);
  if (data) {
    this.updatePostures(data);
  }
}
```

**Expected:** This method is called by Panel base class when WebSocket message arrives

**Step 3: Verify refresh() uses HTTP as manual fallback only**

Lines 256-270:
```typescript
public async refresh(): Promise<void> {
  this.showLoading();
  try {
    const payload = await fetchRelayPanel<unknown>('strategic-posture');
    if (payload) {
      this.applyPush(payload);
    } else {
      this.showNoData();
    }
  } catch (error) {
    // ...
  }
}
```

**Expected:** 
- `refresh()` is only called on manual user action (button click)
- Normal operation uses applyPush() from WebSocket
- HTTP fetch is NOT automatic/polling

**Step 4: Verify no setInterval or polling for HTTP calls**

```bash
grep -n "setInterval\|setTimeout.*fetch" src/components/StrategicPosturePanel.ts
```

**Expected:** No polling intervals for HTTP fetch (only vessel re-augmentation timers)

**Step 5: Document findings**

- [ ] StrategicPosturePanel.channelKeys = ['strategic-posture']
- [ ] StrategicPosturePanel.applyPush() handles WebSocket updates
- [ ] StrategicPosturePanel.refresh() uses HTTP only for manual refresh
- [ ] StrategicPosturePanel does NOT poll HTTP automatically
- [ ] Panel base class manages WebSocket subscription via channelKeys

---

## Task 8: Test Redis Data After Worker Run

**Files:**
- Test: Redis key `theater-posture:sebuf:v1`

**Step 1: Check Redis for strategic-posture data**

```bash
bash /Users/jolipton/Projects/worldmonitor/scripts/check-redis-data-nc.sh
```

Or direct netcat command:
```bash
echo "GET theater-posture:sebuf:v1" | nc 10.230.255.80 6379
```

**Expected:** JSON data with:
```json
{
  "data": {
    "theaters": [
      {
        "theater": "baltic",
        "postureLevel": "normal|elevated|critical",
        "activeFlights": <number>,
        "trackedVessels": 0,
        "activeOperations": [],
        "assessedAt": <timestamp>
      },
      // ... more theaters
    ]
  },
  "status": "success",
  "timestamp": "<ISO date>"
}
```

**Step 2: Verify no error status**

If status is 'error', check errors array:
```json
{
  "status": "error",
  "errors": ["All OpenSky region fetches failed"]
}
```

This would indicate:
- WS_RELAY_URL not configured (falls back to direct calls)
- Relay server is down
- OpenSky credentials expired/invalid

**Step 3: Check worker logs for HTTP requests**

```bash
docker logs worldmon-worker-1 --tail=100 | grep -i "opensky\|strategic-posture"
```

**Expected log entries:**
- "fetchStrategicPosture executing"
- "Calling https://relay.5ls.us/opensky?lamin=..."
- "Region fetch succeeded" (or warning if failed)

**Step 4: Document findings**

- [ ] Redis key theater-posture:sebuf:v1 exists
- [ ] Data has status: 'success'
- [ ] Data has theaters array with 6 theaters
- [ ] Worker logs show relay.5ls.us calls (not direct opensky-network.org)
- [ ] Worker logs show successful OpenSky data retrieval

---

## Task 9: Test Frontend WebSocket Reception

**Files:**
- Test: Browser DevTools Console

**Step 1: Open browser DevTools and check WebSocket connection**

1. Navigate to worldmonitor frontend
2. Open DevTools → Network → WS tab
3. Look for WebSocket connection to relay/gateway

**Expected:** Active WebSocket connection showing messages

**Step 2: Monitor for strategic-posture messages**

In Console tab:
```javascript
// Add temporary listener
window.addEventListener('wm:channel-update', (e) => {
  if (e.detail.channel === 'strategic-posture') {
    console.log('Strategic Posture Update:', e.detail);
  }
});
```

**Expected:** Every 5 minutes (or on cron schedule), see update event

**Step 3: Verify Panel receives data via applyPush**

Add console.log to StrategicPosturePanel.ts line 197:
```typescript
applyPush(payload: unknown): void {
  console.log('[StrategicPosturePanel] Received WebSocket push:', payload);
  const data = adaptPosturePayload(payload);
  // ...
}
```

Rebuild and test. **Expected:** Console shows WebSocket payloads (not HTTP fetch)

**Step 4: Verify Panel does NOT call fetchRelayPanel automatically**

Search console for:
```
[StrategicPosturePanel] Refresh error
```

If this appears without user clicking refresh button, panel is incorrectly polling HTTP.

**Expected:** No automatic HTTP calls, only WebSocket updates

**Step 5: Document findings**

- [ ] Browser has active WebSocket connection
- [ ] WebSocket messages arrive for 'strategic-posture' channel
- [ ] StrategicPosturePanel.applyPush() is called (console log visible)
- [ ] StrategicPosturePanel.refresh() is NOT called automatically
- [ ] Panel updates without HTTP polling

---

## Task 10: Verify OAuth2 Architecture (Relay vs Worker)

**Files:**
- Read: `/Users/jolipton/Projects/worldmonitor/scripts/ais-relay.cjs`
- Compare: strategic-posture.cjs vs ais-relay.cjs OAuth2 implementation

**Step 1: Verify ais-relay.cjs has OAuth2 implementation**

Expected to find in ais-relay.cjs:
- Token endpoint: `auth.opensky-network.org/oauth/token`
- client_credentials grant type
- client_id and client_secret Basic Auth
- Token caching with expiry check
- Bearer token in Authorization header for API calls

**Step 2: Verify strategic-posture.cjs does NOT have OAuth2**

strategic-posture.cjs should NOT contain:
- `auth.opensky-network.org` references
- `client_credentials` grant
- Token fetch logic
- Token caching

**Step 3: Confirm architectural split**

Current architecture:
```
┌─────────────────────────────────────────────────┐
│ Worker (strategic-posture.cjs)                  │
│ ├─ Gets WS_RELAY_URL                            │
│ ├─ Gets RELAY_SHARED_SECRET                     │
│ ├─ Calls: https://relay.5ls.us/opensky          │
│ └─ Headers: Authorization: Bearer <secret>      │
└────────────────┬────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│ Relay Server (relay.5ls.us)                     │
│ ├─ Verifies RELAY_SHARED_SECRET                 │
│ ├─ Gets OPENSKY_CLIENT_ID from Vault            │
│ ├─ Gets OPENSKY_CLIENT_SECRET from Vault        │
│ ├─ Calls: auth.opensky-network.org/oauth/token  │
│ ├─ Gets Bearer token (cached)                   │
│ └─ Calls: opensky-network.org/api/states/all    │
└─────────────────────────────────────────────────┘
```

**Alternative architecture (if refactored):**
```
┌─────────────────────────────────────────────────┐
│ Worker (strategic-posture.cjs) - REFACTORED     │
│ ├─ Gets OPENSKY_CLIENT_ID from config           │
│ ├─ Gets OPENSKY_CLIENT_SECRET from config       │
│ ├─ Calls: auth.opensky-network.org/oauth/token  │
│ ├─ Gets Bearer token (cached in Redis)          │
│ ├─ Calls: opensky-network.org/api/states/all    │
│ └─ Direct OpenSky API calls (no relay proxy)    │
└─────────────────────────────────────────────────┘
```

**Step 4: Document current state**

- [ ] ais-relay.cjs contains full OAuth2 implementation
- [ ] strategic-posture.cjs does NOT contain OAuth2 implementation
- [ ] Current architecture: Worker → Relay → OpenSky (relay handles OAuth2)
- [ ] Worker uses WS_RELAY_URL to proxy through relay
- [ ] Worker uses RELAY_SHARED_SECRET to authenticate with relay
- [ ] Relay uses OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET for OAuth2

**Decision point:** Keep relay architecture OR refactor worker to do direct OAuth2?

---

## Task 11: Final Verification Checklist

**Files:**
- Summary: All findings from Tasks 1-10

**Complete System Checklist:**

### Backend Configuration
- [ ] Supabase Vault has OPENSKY_CLIENT_ID = jlipton522-api-client
- [ ] Supabase Vault has OPENSKY_CLIENT_SECRET = ZLGqFsHjnQGpVLDq29Th9f2JFCIoC2ra
- [ ] Supabase Vault has RELAY_SHARED_SECRET
- [ ] Supabase Vault has WS_RELAY_URL = https://relay.5ls.us
- [ ] docker-compose.yml worker has all 4 env vars configured
- [ ] .env.production has all 4 env vars with correct values
- [ ] secrets.cjs KNOWN_SECRETS includes OpenSky credentials

### Worker Execution
- [ ] orchestrator schedules strategic-posture with cron
- [ ] orchestrator sends gRPC Execute to worker
- [ ] worker loads secrets from Vault on startup
- [ ] worker merges secrets into config before calling channel function
- [ ] strategic-posture.cjs receives WS_RELAY_URL in config
- [ ] strategic-posture.cjs constructs relay URL: https://relay.5ls.us/opensky
- [ ] strategic-posture.cjs adds Authorization: Bearer header with RELAY_SHARED_SECRET
- [ ] strategic-posture.cjs does NOT directly implement OAuth2

### Data Flow
- [ ] Worker stores result in Redis: theater-posture:sebuf:v1
- [ ] Redis data has status: 'success' (not 'error')
- [ ] Redis data has 6 theaters with posture levels
- [ ] Gateway/relay publishes to WebSocket channel 'strategic-posture'

### Frontend Subscription
- [ ] StrategicPosturePanel.channelKeys = ['strategic-posture']
- [ ] Panel.applyPush() receives WebSocket messages
- [ ] Panel does NOT poll HTTP automatically
- [ ] Panel.refresh() is manual-only fallback
- [ ] Browser DevTools shows WebSocket messages arriving

### OAuth2 Architecture
- [ ] Current: Worker proxies through relay.5ls.us
- [ ] Relay server handles OpenSky OAuth2 authentication
- [ ] Worker does NOT contain OAuth2 token logic
- [ ] Architecture decision: Keep relay OR refactor to direct?

**Status:** ✅ All verified | ⚠️ Issues found | ❌ Failed

---

## Execution Notes

**Testing order:**
1. Tasks 1-2: Verify credentials and configuration (static checks)
2. Task 3-6: Trace backend code flow (code reading)
3. Task 7: Verify frontend code (no HTTP polling)
4. Task 8: Test live Redis data (requires running system)
5. Task 9: Test browser WebSocket (requires running system)
6. Task 10-11: Architecture review and final checklist

**If errors found:**
- Task 8 fails → Check docker-compose.yml worker env vars
- Task 9 fails → Check Panel.channelKeys and CHANNEL_REGISTRY
- OAuth errors → Verify Vault credentials and relay server status

**Deployment:**
1. Commit all .env.production and docker-compose.yml changes
2. SSH to production server: `ssh ubuntu@10.230.255.80`
3. Pull latest changes: `cd /opt/worldmonitor && git pull`
4. Restart worker: `docker-compose restart worker`
5. Verify logs: `docker logs worldmon-worker-1 --tail=100`
6. Check Redis: `bash scripts/check-redis-data-nc.sh`
