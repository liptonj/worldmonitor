# Worker Vault Secrets & Schema Validation Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two root causes preventing panel data: (1) workers can't read API keys from Supabase Vault — create a shared secrets module so workers fetch credentials from Vault with `process.env` fallback, and (2) frontend schema validation blocks data delivery — make it non-blocking and fix Zod v4 compatibility.

**Architecture:** Workers get a new `services/shared/secrets.cjs` module that mirrors the existing `server/_shared/secrets.ts` pattern (Vault → Redis cache → env fallback). The module pre-fetches all known secrets at worker startup and caches them in memory with 15-minute TTL. `worker-runner.cjs` merges cached secrets into `config` before passing to channel functions — so channel functions work as-is with `config?.SECRET_NAME`. On the frontend, `relay-push.ts` dispatch is made non-blocking (warn-only) and Zod schemas are updated for v4 compatibility.

**Tech Stack:** Node.js CommonJS (workers), Supabase Vault (`get_vault_secret_value` RPC), ioredis, TypeScript (frontend), Zod v4

---

## Task 1: Create shared secrets module for workers

**Files:**
- Create: `services/shared/secrets.cjs`

**Step 1: Create the secrets module**

Note: The shared `redis.cjs` module's `get()` JSON-parses results, but secrets are plain strings. This module uses `getClient()` to access the raw ioredis client directly for plain string get/setex.

```javascript
'use strict';

const { createLogger } = require('./logger.cjs');
const { getClient: getRedisClient } = require('./redis.cjs');

const log = createLogger('secrets');

const CACHE_TTL_MS = 15 * 60_000; // 15 minutes
const REDIS_CACHE_TTL_SECONDS = 900;

const KNOWN_SECRETS = [
  'FINNHUB_API_KEY',
  'ACLED_ACCESS_TOKEN',
  'OREF_PROXY_AUTH',
  'UCDP_ACCESS_TOKEN',
  'WTO_API_KEY',
  'EIA_API_KEY',
  'FRED_API_KEY',
  'NASA_FIRMS_API_KEY',
  'AVIATIONSTACK_API_KEY',
  'RELAY_SHARED_SECRET',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'URLHAUS_AUTH_KEY',
];

const ENV_ONLY = new Set([
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'REDIS_URL',
  'NODE_ENV',
]);

let _cache = new Map();
let _cacheTs = 0;
let _supabaseClient = null;

function _createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) return null;

  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch (err) {
    log.warn('Failed to create Supabase client for Vault', { error: err.message });
    return null;
  }
}

function _getSupabaseClient() {
  if (!_supabaseClient) _supabaseClient = _createSupabaseClient();
  return _supabaseClient;
}

async function _fetchFromVault(secretName) {
  const supabase = _getSupabaseClient();
  if (!supabase) return undefined;

  try {
    const { data, error } = await supabase
      .rpc('get_vault_secret_value', { secret_name: secretName });
    if (!error && data != null) return String(data);
  } catch (err) {
    log.debug('Vault fetch failed', { secret: secretName, error: err.message });
  }
  return undefined;
}

async function _fetchFromRedisCache(secretName) {
  try {
    const client = getRedisClient();
    const cached = await client.get(`wm:vault:v1:${secretName}`);
    if (cached !== null && cached !== undefined) return cached;
  } catch {
    // Redis miss — non-fatal
  }
  return undefined;
}

async function _storeInRedisCache(secretName, value) {
  if (!value) return;
  try {
    const client = getRedisClient();
    await client.setex(`wm:vault:v1:${secretName}`, REDIS_CACHE_TTL_SECONDS, value);
  } catch {
    // Non-fatal
  }
}

async function getSecret(secretName) {
  if (ENV_ONLY.has(secretName)) {
    return process.env[secretName] ?? undefined;
  }

  if (_cache.has(secretName) && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache.get(secretName);
  }

  const fromRedis = await _fetchFromRedisCache(secretName);
  if (fromRedis) {
    _cache.set(secretName, fromRedis);
    return fromRedis;
  }

  const fromVault = await _fetchFromVault(secretName);
  if (fromVault) {
    _cache.set(secretName, fromVault);
    await _storeInRedisCache(secretName, fromVault);
    return fromVault;
  }

  const fromEnv = process.env[secretName];
  if (fromEnv) {
    _cache.set(secretName, fromEnv);
    return fromEnv;
  }

  return undefined;
}

async function initSecrets() {
  log.info('Initializing secrets from Vault', { count: KNOWN_SECRETS.length });
  let vaultCount = 0;
  let envCount = 0;

  const results = await Promise.allSettled(
    KNOWN_SECRETS.map(async (name) => {
      const value = await getSecret(name);
      if (value) {
        const source = _cache.has(name) ? 'vault/redis' : 'env';
        if (source !== 'env') vaultCount++;
        else envCount++;
      }
      return { name, found: !!value };
    })
  );

  const missing = results
    .filter(r => r.status === 'fulfilled' && !r.value.found)
    .map(r => r.value.name);

  _cacheTs = Date.now();
  log.info('Secrets initialized', { vault: vaultCount, env: envCount, missing: missing.length, missingKeys: missing });
  return { loaded: vaultCount + envCount, missing };
}

function getSecretSync(secretName) {
  if (_cache.has(secretName)) return _cache.get(secretName);
  return process.env[secretName] ?? undefined;
}

function getAllCachedSecrets() {
  const result = {};
  for (const name of KNOWN_SECRETS) {
    const value = _cache.get(name) ?? process.env[name];
    if (value) result[name] = value;
  }
  return result;
}

module.exports = { getSecret, initSecrets, getSecretSync, getAllCachedSecrets, KNOWN_SECRETS };
```

**Step 2: Run lint check**

```bash
node -c services/shared/secrets.cjs
```

Expected: No syntax errors.

**Step 3: Commit**

```bash
git add services/shared/secrets.cjs
git commit -m "feat(secrets): add shared Vault secrets module for workers"
```

---

## Task 2: Add `SUPABASE_SERVICE_KEY` to worker in docker-compose

**Files:**
- Modify: `services/docker-compose.yml:105-117`

**Step 1: Add SUPABASE_SERVICE_KEY to worker environment**

Current worker env block (lines 105–117):
```yaml
    environment:
      - REDIS_URL=redis://redis:6379
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
      - GATEWAY_HOST=gateway
      - GATEWAY_GRPC_PORT=50051
      - WORKER_GRPC_PORT=50052
      - FRED_API_KEY=${FRED_API_KEY:-}
      - EIA_API_KEY=${EIA_API_KEY:-}
      - WTO_API_KEY=${WTO_API_KEY:-}
      - NASA_FIRMS_API_KEY=${NASA_FIRMS_API_KEY:-}
      - ACLED_ACCESS_TOKEN=${ACLED_ACCESS_TOKEN:-}
      - LOG_LEVEL=info
```

New worker env block:
```yaml
    environment:
      - REDIS_URL=redis://redis:6379
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - GATEWAY_HOST=gateway
      - GATEWAY_GRPC_PORT=50051
      - WORKER_GRPC_PORT=50052
      - FRED_API_KEY=${FRED_API_KEY:-}
      - EIA_API_KEY=${EIA_API_KEY:-}
      - WTO_API_KEY=${WTO_API_KEY:-}
      - NASA_FIRMS_API_KEY=${NASA_FIRMS_API_KEY:-}
      - ACLED_ACCESS_TOKEN=${ACLED_ACCESS_TOKEN:-}
      - FINNHUB_API_KEY=${FINNHUB_API_KEY:-}
      - OREF_PROXY_AUTH=${OREF_PROXY_AUTH:-}
      - UCDP_ACCESS_TOKEN=${UCDP_ACCESS_TOKEN:-}
      - AVIATIONSTACK_API_KEY=${AVIATIONSTACK_API_KEY:-}
      - OPENSKY_CLIENT_ID=${OPENSKY_CLIENT_ID:-}
      - OPENSKY_CLIENT_SECRET=${OPENSKY_CLIENT_SECRET:-}
      - LOG_LEVEL=info
```

Key changes:
- Added `SUPABASE_SERVICE_KEY` (required for Vault RPC calls)
- Added env var pass-throughs for all missing API keys as fallbacks (with `:-` default so they're optional)

**Step 2: Commit**

```bash
git add services/docker-compose.yml
git commit -m "fix(docker): add SUPABASE_SERVICE_KEY and missing API key env vars to worker"
```

---

## Task 3: Update worker-runner to merge Vault secrets into config

**Files:**
- Modify: `services/shared/worker-runner.cjs`

**Step 1: Update worker-runner to merge cached secrets into config**

Current code (`services/shared/worker-runner.cjs` lines 1–4):
```javascript
'use strict';

const config = require('./config.cjs');
const http = require('./http.cjs');
const { fetchSimple } = require('./channels/_simple-fetcher.cjs');
```

New code:
```javascript
'use strict';

const config = require('./config.cjs');
const http = require('./http.cjs');
const { fetchSimple } = require('./channels/_simple-fetcher.cjs');
const { getAllCachedSecrets } = require('./secrets.cjs');
```

Current code (line 44):
```javascript
      result = await channelFn({ config, redis, log, http });
```

New code:
```javascript
      const enrichedConfig = { ...config, ...getAllCachedSecrets() };
      result = await channelFn({ config: enrichedConfig, redis, log, http });
```

This merges all cached Vault secrets into `config` before passing to the channel function. Channel functions already read `config?.ACLED_ACCESS_TOKEN || process.env.ACLED_ACCESS_TOKEN`, so `config?.ACLED_ACCESS_TOKEN` will now resolve from Vault.

**Step 2: Run syntax check**

```bash
node -c services/shared/worker-runner.cjs
```

Expected: No syntax errors.

**Step 3: Commit**

```bash
git add services/shared/worker-runner.cjs
git commit -m "fix(worker-runner): merge Vault secrets into config for channel functions"
```

---

## Task 4: Initialize secrets at worker startup

**Files:**
- Modify: `services/worker/index.cjs:1-12` (imports) and `:117-137` (`main()` function)

**Step 1: Add import at top of file**

Add after line 10 (`const log = createLogger('worker');`):
```javascript
const { initSecrets } = require('@worldmonitor/shared/secrets.cjs');
```

**Step 2: Make `main()` async and add secret initialization**

Current `main()` (lines 117–151):
```javascript
function main() {
  const config = require('@worldmonitor/shared/config.cjs');
  const port = config.WORKER_GRPC_PORT;

  const server = new grpc.Server();
  server.addService(WorkerService.service, {
    Execute: (call, callback) => handleExecute(call, callback),
    HealthCheck: handleHealthCheck,
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        log.error('Worker gRPC server bind failed', { error: err.message });
        process.exit(1);
      }
      log.info('Worker gRPC server listening', { port: boundPort });
    }
  );
  // ... shutdown handlers
```

New `main()`:
```javascript
async function main() {
  const config = require('@worldmonitor/shared/config.cjs');
  const port = config.WORKER_GRPC_PORT;

  try {
    const { loaded, missing } = await initSecrets();
    log.info('Vault secrets ready', { loaded, missing: missing.length });
  } catch (err) {
    log.warn('Vault secret init failed — falling back to env vars', { error: err.message });
  }

  const server = new grpc.Server();
  // ... rest unchanged
```

Note: `initSecrets()` no longer takes a redis argument — the secrets module gets its own redis client internally via `getClient()` from `redis.cjs`.

**Step 3: Run syntax check**

```bash
node -c services/worker/index.cjs
```

**Step 4: Commit**

```bash
git add services/worker/index.cjs
git commit -m "fix(worker): initialize Vault secrets at startup"
```

---

## Task 5: Update markets channel to read FINNHUB_API_KEY from config

**Files:**
- Modify: `services/shared/channels/markets.cjs:152`

**Step 1: Change from `process.env` to `config`**

Current code (line 152):
```javascript
    const apiKey = process.env.FINNHUB_API_KEY;
```

New code:
```javascript
    const apiKey = config?.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY;
```

This is the only channel function that reads directly from `process.env` without checking `config` first. All other channel functions already do `config?.X || process.env.X`.

**Step 2: Run syntax check**

```bash
node -c services/shared/channels/markets.cjs
```

**Step 3: Commit**

```bash
git add services/shared/channels/markets.cjs
git commit -m "fix(markets): read FINNHUB_API_KEY from config (Vault) with env fallback"
```

---

## Task 6: Make relay-push schema validation non-blocking

**Files:**
- Modify: `src/services/relay-push.ts:30-62`

**Step 1: Change dispatch to warn-only on schema failure**

Current code (`src/services/relay-push.ts` lines 30–62):
```typescript
function dispatch(channel: string, payload: unknown): void {
  if (payload === undefined || payload === null) {
    console.warn(`[wm:${channel}] null/undefined payload — setting channel to error`);
    setChannelState(channel, 'error', 'websocket', { error: 'No data available' });
    return;
  }

  const schema = channelSchemas[channel];
  let resolvedPayload: unknown = payload;
  if (schema) {
    const result = schema.safeParse(payload);
    if (!result.success) {
      console.warn(
        `[relay-push] schema mismatch (${channel}):`,
        result.error.issues.map((i) => i.message).join('; '),
      );
      setChannelState(channel, 'error', 'websocket', { error: 'Invalid payload shape' });
      return;
    }
    resolvedPayload = result.data;
  }

  setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(resolvedPayload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}
```

New code:
```typescript
function dispatch(channel: string, payload: unknown): void {
  if (payload === undefined || payload === null) {
    console.warn(`[wm:${channel}] null/undefined payload — setting channel to error`);
    setChannelState(channel, 'error', 'websocket', { error: 'No data available' });
    return;
  }

  const schema = channelSchemas[channel];
  if (schema) {
    const result = schema.safeParse(payload);
    if (!result.success) {
      const payloadType = Array.isArray(payload) ? 'array' : typeof payload;
      const keys = (payload && typeof payload === 'object' && !Array.isArray(payload))
        ? Object.keys(payload as Record<string, unknown>).slice(0, 8)
        : [];
      console.warn(
        `[relay-push] schema mismatch (${channel}):`,
        result.error.issues.map((i) => i.message).join('; '),
        { payloadType, keys },
      );
    }
  }

  setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}
```

Key changes:
- Removed `return` after schema failure — data always flows to handlers
- Removed `setChannelState('error')` on schema failure — handlers decide state
- Always pass original `payload` to handlers (not Zod-resolved `result.data`) — handlers have their own parsing
- Added `payloadType` and `keys` to warning for diagnostics

**Step 2: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors related to relay-push.

**Step 3: Commit**

```bash
git add src/services/relay-push.ts
git commit -m "fix(relay-push): make schema validation non-blocking — warn only, always dispatch"
```

---

## Task 7: Fix OREF handler — handle error envelope from gateway

**Files:**
- Modify: `src/data/intelligence-handler.ts:248-268`

**Step 1: Update OREF handler to detect error payloads**

The OREF channel function returns `{ timestamp, source, status, data: null, error: '...' }` when proxy auth is missing. Gateway `unwrapEnvelope` strips `timestamp`, `source`, `status` but NOT `error` (singular — only `errors` plural is in `ENVELOPE_FIELDS`). This produces `{ data: null, error: 'OREF_PROXY_AUTH not configured' }` which the handler doesn't recognize.

Current code (`src/data/intelligence-handler.ts` lines 248–268):
```typescript
    oref: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:oref] skipped — invalid payload type:', typeof payload); return; }
      let data = payload as OrefAlertsResponse;
      if (!('configured' in data) && !('alerts' in data)) {
        const raw = payload as Record<string, unknown>;
        if ('current' in raw || 'history' in raw) {
          const current = raw.current as unknown[] | null;
          const history = raw.history as unknown[] | null;
          data = {
            configured: true,
            alerts: Array.isArray(current) ? current as OrefAlertsResponse['alerts'] : [],
            historyCount24h: Array.isArray(history) ? history.length : 0,
            timestamp: new Date().toISOString(),
          };
        } else {
          console.warn('[wm:oref] unrecognized payload shape — rendering as unconfigured');
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
      }
      renderOrefAlerts(data);
    },
```

New code:
```typescript
    oref: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:oref] skipped — invalid payload type:', typeof payload); return; }
      let data = payload as OrefAlertsResponse;
      if (!('configured' in data) && !('alerts' in data)) {
        const raw = payload as Record<string, unknown>;
        if ('error' in raw || raw.data === null || raw.data === undefined) {
          const errorMsg = typeof raw.error === 'string' ? raw.error : 'service unavailable';
          console.debug(`[wm:oref] error envelope received: ${errorMsg}`);
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
        if ('current' in raw || 'history' in raw) {
          const current = raw.current as unknown[] | null;
          const history = raw.history as unknown[] | null;
          data = {
            configured: true,
            alerts: Array.isArray(current) ? current as OrefAlertsResponse['alerts'] : [],
            historyCount24h: Array.isArray(history) ? history.length : 0,
            timestamp: new Date().toISOString(),
          };
        } else {
          console.warn('[wm:oref] unrecognized payload shape', { keys: Object.keys(raw).slice(0, 8) });
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
      }
      renderOrefAlerts(data);
    },
```

Key change: detect `{ data: null, error: '...' }` (partially-unwrapped error envelope) before falling to "unrecognized" branch.

**Step 2: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/data/intelligence-handler.ts
git commit -m "fix(oref-handler): handle error envelope leakage from gateway"
```

---

## Task 8: Fix Zod schemas for Zod v4 compatibility

**Files:**
- Modify: `src/data/channel-schemas.ts`

**Step 1: Replace `z.object({}).passthrough()` with `z.record()`**

Current code (`src/data/channel-schemas.ts`):
```typescript
import { z } from 'zod';

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: z.object({}).passthrough(),
  predictions: z.union([z.array(z.unknown()), z.object({ markets: z.array(z.unknown()) }).passthrough()]),
  telegram: z.union([
    z.array(z.unknown()),
    z.object({}).passthrough().refine((obj) => {
      if (Array.isArray((obj as Record<string, unknown>).items) || Array.isArray((obj as Record<string, unknown>).messages)) {
        return true;
      }
      const nested = (obj as Record<string, unknown>).data;
      return !!nested
        && typeof nested === 'object'
        && (Array.isArray((nested as Record<string, unknown>).items)
          || Array.isArray((nested as Record<string, unknown>).messages));
    }, { message: 'Must have items/messages array at root or in data' }),
  ]),
  intelligence: z.object({}).passthrough(),
  conflict: z.object({ events: z.array(z.unknown()) }).passthrough(),
  ais: z.object({}).passthrough(),
  giving: z.object({}).passthrough(),
  climate: z.union([z.array(z.unknown()), z.object({ anomalies: z.array(z.unknown()) }).passthrough()]),
  fred: z.union([z.array(z.unknown()), z.object({ series: z.array(z.unknown()) }).passthrough()]),
  oil: z.union([z.array(z.unknown()), z.object({ prices: z.array(z.unknown()) }).passthrough()]),
  'ai:intel-digest': z.object({}).passthrough(),
  'ai:panel-summary': z.object({}).passthrough(),
  'ai:risk-overview': z.object({}).passthrough(),
  'ai:posture-analysis': z.object({}).passthrough(),
  gdelt: z.object({}).passthrough(),
  cyber: z.union([z.array(z.unknown()), z.object({ threats: z.array(z.unknown()) }).passthrough()]),
  'security-advisories': z.union([z.array(z.unknown()), z.object({ items: z.array(z.unknown()) }).passthrough()]),
};
```

New code:
```typescript
import { z } from 'zod';

const looseObject = z.record(z.string(), z.unknown());

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: looseObject,
  predictions: z.union([z.array(z.unknown()), looseObject]),
  telegram: z.union([
    z.array(z.unknown()),
    looseObject.refine((obj) => {
      return Array.isArray(obj.items)
        || Array.isArray(obj.messages)
        || (obj.data && typeof obj.data === 'object'
          && (Array.isArray((obj.data as Record<string, unknown>).items)
            || Array.isArray((obj.data as Record<string, unknown>).messages)));
    }, { message: 'Must have items/messages array at root or in data' }),
  ]),
  intelligence: looseObject,
  conflict: looseObject.refine(
    (obj) => Array.isArray(obj.events),
    { message: 'Must have events array' },
  ),
  ais: looseObject,
  giving: looseObject,
  climate: z.union([z.array(z.unknown()), looseObject]),
  fred: z.union([z.array(z.unknown()), looseObject]),
  oil: z.union([z.array(z.unknown()), looseObject]),
  'ai:intel-digest': looseObject,
  'ai:panel-summary': looseObject,
  'ai:risk-overview': looseObject,
  'ai:posture-analysis': looseObject,
  gdelt: looseObject,
  cyber: z.union([z.array(z.unknown()), looseObject]),
  'security-advisories': z.union([z.array(z.unknown()), looseObject]),
};
```

Key change: `z.record(z.string(), z.unknown())` is the canonical Zod v4 way to accept any object with string keys. `.refine()` calls work identically on `z.record()`.

**Step 2: Run build**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/data/channel-schemas.ts
git commit -m "fix(channel-schemas): use z.record for Zod v4 compatibility"
```

---

## Task 9: Build, verify, and test end-to-end

**Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: Zero errors.

**Step 2: Run full build**

```bash
npm run build
```

Expected: Build succeeds.

**Step 3: Run backend tests**

```bash
cd services && node --test gateway/test/gateway.test.cjs && node --test ais-processor/test/ais-processor.test.cjs
```

Expected: All tests pass.

**Step 4: Run conflict/strategic-risk tests to verify config passthrough**

```bash
cd services && node --test shared/channels/test/conflict.test.cjs && node --test shared/channels/test/strategic-risk.test.cjs
```

Expected: All tests pass (they already pass config with `ACLED_ACCESS_TOKEN`).

**Step 5: Verify secrets module loads cleanly**

```bash
cd services && node -e "const s = require('./shared/secrets.cjs'); console.log('KNOWN_SECRETS:', s.KNOWN_SECRETS.length); console.log('exports:', Object.keys(s).join(', ')); console.log('OK')"
```

Expected: `KNOWN_SECRETS: 13`, `exports: getSecret, initSecrets, getSecretSync, getAllCachedSecrets, KNOWN_SECRETS`, and `OK`.

**Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors from vault secrets and schema validation fix"
```

---

## Execution Order

| Task | Effort | Fixes |
|------|--------|-------|
| **1. Create secrets module** | 10 min | Foundation for Vault-first credential loading |
| **2. Docker-compose env** | 2 min | Workers can authenticate to Vault |
| **3. Worker-runner merge** | 5 min | Channel functions receive secrets via config |
| **4. Worker startup init** | 5 min | Secrets pre-fetched and cached at boot |
| **5. Markets FINNHUB_API_KEY** | 2 min | Markets uses config like all other channels |
| **6. Non-blocking dispatch** | 5 min | ALL panels blocked by schema validation |
| **7. OREF handler** | 5 min | OREF error envelope handling |
| **8. Fix Zod schemas** | 5 min | Zod v4 compatibility |
| **9. Build + verify** | 10 min | Everything compiles and tests pass |

**Execute in order: 1→2→3→4→5→6→7→8→9**

---

## Architecture After Fix

```
Supabase Vault (primary)
    ↓ get_vault_secret_value RPC (service_role)
Worker secrets.cjs (in-memory cache, 15min TTL)
    ↓ getAllCachedSecrets()
worker-runner.cjs merges into config
    ↓ enrichedConfig
channelFn({ config: enrichedConfig, ... })
    ↓ config?.FINNHUB_API_KEY (found!)
API call succeeds → data in Redis
    ↓ push-on-subscribe
Gateway → unwrapEnvelope → WebSocket
    ↓ wm-push
relay-push.ts dispatch (non-blocking schema)
    ↓ always forwards to handler
Handler → Panel renders data
```

Fallback chain per secret: **Vault → Redis cache → process.env**

---

## Success Criteria

1. Worker logs `Vault secrets ready` with `loaded > 0` on startup
2. `FINNHUB_API_KEY not configured` no longer appears in market channel output
3. `ACLED_ACCESS_TOKEN not configured` no longer appears in conflict/strategic-risk output
4. `OREF_PROXY_AUTH not configured` error is handled gracefully (shows "unconfigured" not "unrecognized")
5. No `[relay-push] schema mismatch` errors blocking data delivery
6. `npm run build` completes with zero errors
7. All backend tests pass
8. Secrets fall back to `process.env` when Vault is unreachable

---

## Secrets That Must Be in Supabase Vault

These secrets need to be added to Vault via the admin portal (`admin_upsert_vault_secret`) or a migration:

| Secret Name | Service | Notes |
|-------------|---------|-------|
| `FINNHUB_API_KEY` | markets | Stock/commodity quotes |
| `ACLED_ACCESS_TOKEN` | conflict, strategic-risk | Armed conflict data |
| `OREF_PROXY_AUTH` | oref | Israel Home Front Command alerts |
| `UCDP_ACCESS_TOKEN` | ucdp-events | Uppsala conflict data |
| `EIA_API_KEY` | oil | Energy Information Administration |
| `FRED_API_KEY` | fred | Federal Reserve economic data |
| `NASA_FIRMS_API_KEY` | natural | Satellite fire detection |
| `WTO_API_KEY` | trade | World Trade Organization |
| `AVIATIONSTACK_API_KEY` | flights | Flight delay data |
| `OPENSKY_CLIENT_ID` | opensky | Military flight tracking |
| `OPENSKY_CLIENT_SECRET` | opensky | Military flight tracking |
| `URLHAUS_AUTH_KEY` | cyber | Cyber threat feeds |

Verify each exists in Vault with:
```sql
SELECT name FROM vault.decrypted_secrets WHERE name IN (
  'FINNHUB_API_KEY', 'ACLED_ACCESS_TOKEN', 'OREF_PROXY_AUTH',
  'UCDP_ACCESS_TOKEN', 'EIA_API_KEY', 'FRED_API_KEY',
  'NASA_FIRMS_API_KEY', 'WTO_API_KEY', 'AVIATIONSTACK_API_KEY',
  'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET', 'URLHAUS_AUTH_KEY'
);
```
