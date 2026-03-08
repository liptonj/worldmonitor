# Relay Microservices Decomposition Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decompose the 7,874-line monolithic `scripts/ais-relay.cjs` into ~28 independent containerized microservices with an orchestrator for scheduling/config, a shared library, structured logging, a unified CLI, GitHub Actions CI/CD, observability, and the corresponding frontend migration to eliminate all proxy/polling patterns in favor of cached channel reads.

**Architecture:** Every data source becomes a **worker** service that fetches on a schedule (controlled by the orchestrator), writes to Redis, and exits. The **gateway** is a thin read/broadcast layer — HTTP serves from Redis cache, WebSocket pushes via Redis pub/sub. The **orchestrator** reads schedules and config from a Supabase `service_config` table, triggers workers via Redis pub/sub, and monitors health. Zero proxying — all data is pre-fetched and cached. The frontend eliminates all on-demand proxy calls and polling in favor of WebSocket subscriptions and cached HTTP reads from the gateway.

**Tech Stack:** Node.js CJS, Docker, Docker Compose, GitHub Actions, Redis (pub/sub + cache), Supabase (config + Realtime), `ws`, `node-cron` (orchestrator only), Bash (relay-ctl CLI)

**Dependency on other plans:**
- `2026-03-06-scripts-fixes.plan.md` — bug fixes should land FIRST
- `2026-03-06-relay-native-ai.md` — AI functions are already in the relay; this plan containerizes them

---

## Current State

### Relay (Backend)

`scripts/ais-relay.cjs` — single 7,874-line CJS file containing:
- 12+ distinct concerns (AIS, LLM, Telegram, OREF, UCDP, 6 proxies, 30+ channel fetchers, HTTP server, WS server, auth, metrics)
- 216 raw `console.*` calls with inconsistent prefixes, no log levels, no structured output
- 50+ cron schedules scattered across 2,500 lines
- 6 on-demand proxy handlers (OpenSky, RSS, WorldBank, Polymarket, YouTube, NOTAM)
- All config via env vars and hardcoded constants

### Frontend (Client)

The frontend (`src/`) has three data patterns:

| Pattern | Count | Examples |
|---------|-------|---------|
| **WebSocket push** (desired) | 40+ channels | markets, news, weather, oref, etc. |
| **On-demand proxy** (eliminate) | 6 endpoints | `/opensky`, `/rss`, `/polymarket`, `/gdelt`, `/ais/snapshot`, `/api/deduct` |
| **HTTP poll** (eliminate) | 2 patterns | AIS snapshot (5min), OREF alerts (120s) |

**Proxy endpoints currently called by the frontend:**

| Proxy | Frontend File | Endpoint | Type |
|-------|---------------|----------|------|
| OpenSky | `src/services/military-flights.ts:268` | `/api/opensky` or relay `/opensky` | On-demand bounding box query |
| RSS | `src/services/security-advisories.ts:212` | `RELAY_HTTP_BASE/rss?url=...` | On-demand feed fetch |
| Polymarket | `src/services/prediction/index.ts:139` | `/api/polymarket` or relay `/polymarket` | On-demand |
| AIS Snapshot | `src/services/maritime/index.ts:183` | `/api/ais-snapshot` or relay `/ais/snapshot` | Poll every 5min |
| GDELT | `src/services/gdelt-intel.ts:143` | `RELAY_HTTP_BASE/gdelt?params` | On-demand |
| Deduct | `src/components/DeductionPanel.ts:140` | `{relay}/api/deduct` | User-triggered LLM |
| YouTube | `src/services/live-news.ts:19` | `/api/youtube/live` | On-demand (via Vercel, not relay) |

**Relay HTTP endpoints used by the frontend:**

| Endpoint | Frontend File | Purpose |
|----------|---------------|---------|
| `/bootstrap?variant=` | `src/services/bootstrap.ts:35` | App initialization — loads all panel data |
| `/panel/{channel}` | `src/services/relay-http.ts:25`, `src/app/data-loader.ts` (16 calls) | On-demand panel data refresh |
| `/api/deduct` | `src/components/DeductionPanel.ts:140` | User-triggered LLM deduction |

**WebSocket architecture (keep as-is, already correct):**

- Single WS to `VITE_WS_RELAY_URL`
- Subscribe via `{ type: 'wm-subscribe', channels: [...] }`
- Receive via `{ type: 'wm-push', channel, payload }`
- `relay-push.ts` dispatches to registered handlers
- Reconnect with exponential backoff (2s → 60s max)
- Staleness detection (30s threshold)

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Admin Portal                         │
│              (Supabase wm_admin tables)                  │
│    service_config: schedules, enabled, TTLs, settings    │
└───────────────────────┬─────────────────────────────────┘
                        │ Supabase Realtime
                        │
┌───────────────────────▼─────────────────────────────────┐
│                   Orchestrator                           │
│                                                          │
│  • Reads service_config from Supabase                    │
│  • Schedules triggers via node-cron                      │
│  • Sends trigger → Redis pub/sub                         │
│  • Listens for heartbeats + results                      │
│  • Updates last_run_at, last_status in Supabase          │
│  • Exposes /admin API for relay-ctl                      │
│  • Detects dead services, retries, circuit breaks        │
│  • Alerts on failures (Discord/Slack webhook)            │
└───────────────────────┬─────────────────────────────────┘
                        │ Redis pub/sub
          ┌─────────────┼─────────────────────┐
          │             │                     │
    ┌─────▼──────┐ ┌────▼──────┐  ┌───────────▼──────────┐
    │  Gateway   │ │  Workers  │  │  Always-On Services   │
    │            │ │  (28+)    │  │                        │
    │  HTTP      │ │           │  │  ais-processor         │
    │  WebSocket │ │  Wait for │  │  ingest-telegram       │
    │  Reads     │ │  trigger  │  │                        │
    │  Redis     │ │  → fetch  │  │  (have own internal    │
    │  Broadcasts│ │  → Redis  │  │   loops, not triggered │
    │            │ │  → done   │  │   by orchestrator)     │
    └────────────┘ └───────────┘  └────────────────────────┘
```

### Target Directory Structure

```
services/
├── shared/                          # @worldmonitor/shared npm workspace package
│   ├── package.json
│   ├── logger.cjs                   # Structured logger (LOG_LEVEL, JSON/human)
│   ├── redis.cjs                    # Redis client + pub/sub helpers
│   ├── config.cjs                   # Env var loader + validation
│   ├── http.cjs                     # HTTP helpers (compressed responses, etc.)
│   └── worker.cjs                   # Generic worker runner (trigger → fetch → Redis → result)
│
├── orchestrator/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # Scheduler, trigger publisher, health monitor, admin API
│
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # HTTP server + WS server, reads Redis, broadcasts
│
├── ais-processor/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # aisstream.io WS → vessel tracking → Redis
│
├── ai-engine/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # LLM providers + 8 generators (triggered by orchestrator)
│
├── ingest-telegram/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # Telegram OSINT (always-on, session-based)
│
├── ingest-oref/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # OREF siren alerts
│
├── ingest-ucdp/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # UCDP conflict events
│
├── channel-markets/                 # One directory per channel
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs
├── channel-news/
├── channel-fred/
├── channel-weather/
├── channel-flights/
├── channel-opensky/                 # Was a proxy, now a scheduled fetcher
├── channel-oil/
├── channel-crypto/
├── channel-trade/
├── channel-conflict/
├── channel-climate/
├── channel-natural/
├── channel-risk/
├── channel-posture/
├── channel-polymarket/              # Was a proxy, now a scheduled fetcher
├── channel-worldbank/               # Was a proxy, now a scheduled fetcher
├── channel-youtube/                 # Was a proxy, now a scheduled fetcher
├── channel-cables/
├── channel-cyber/
├── channel-service-status/
├── channel-gps/
├── channel-gdelt/                   # Was a proxy, now a scheduled fetcher
├── channel-security-advisories/     # Was RSS proxy, now a scheduled fetcher
├── channel-misc/                    # Gulf quotes, tech events, spending, giving, BIS, NOTAMs
│
├── Dockerfile.base                  # Shared base image (Node 22 Alpine + shared lib)
├── docker-compose.yml               # Full stack for local dev
├── docker-compose.prod.yml          # Production overrides
└── .github/
    └── workflows/
        └── build-services.yml       # Matrix build + publish to GHCR
```

---

## Phase 0 — Shared Library

### Task 1: Create `@worldmonitor/shared` package

**Files:**
- Create: `services/shared/package.json`
- Create: `services/shared/logger.cjs`
- Create: `services/shared/redis.cjs`
- Create: `services/shared/config.cjs`
- Create: `services/shared/http.cjs`
- Create: `services/shared/worker.cjs`

**Step 1: Create directory and package.json**

```bash
mkdir -p services/shared
```

```json
{
  "name": "@worldmonitor/shared",
  "version": "1.0.0",
  "private": true,
  "main": "index.cjs",
  "files": ["*.cjs"]
}
```

**Step 2: Create `logger.cjs`**

Structured logger with configurable levels (`LOG_LEVEL` env), JSON output in production, human-readable in dev, scoped child loggers. (Full implementation provided in conversation history.)

**Step 3: Create `redis.cjs`**

Redis client wrapper:
- Creates ioredis connection from `REDIS_URL`
- `publish(channel, payload)` — serialize + publish to pub/sub
- `subscribe(pattern, callback)` — subscribe to pub/sub channels
- `get(key)` / `setex(key, ttl, value)` / `del(key)` — cache operations
- Connection health check
- Graceful disconnect

**Step 4: Create `worker.cjs`**

The generic worker runner that every channel service uses:

```javascript
// services/shared/worker.cjs
'use strict';
const { createLogger } = require('./logger.cjs');
const { createRedisClient } = require('./redis.cjs');

function createWorker({ service, onTrigger }) {
  const log = createLogger(service);
  const redis = createRedisClient();
  const triggerChannel = `orchestrator:trigger:${service}`;
  const resultChannel = `orchestrator:result:${service}`;
  const heartbeatChannel = 'orchestrator:heartbeat';

  let heartbeatInterval;

  async function start() {
    log.info('worker starting', { service });

    // Send initial heartbeat
    await redis.publish(heartbeatChannel, JSON.stringify({
      service, status: 'ready', startedAt: new Date().toISOString(),
    }));

    // Heartbeat every 30s
    heartbeatInterval = setInterval(async () => {
      await redis.publish(heartbeatChannel, JSON.stringify({
        service, status: 'alive', ts: new Date().toISOString(),
      }));
    }, 30_000);

    // Listen for triggers
    const sub = redis.duplicate();
    await sub.subscribe(triggerChannel);
    sub.on('message', async (ch, raw) => {
      const trigger = JSON.parse(raw);
      const startMs = Date.now();
      log.info('triggered', { redisKey: trigger.redisKey });

      try {
        const result = await onTrigger({
          config: trigger.settings || {},
          redis,
          log,
        });

        if (result && result.ok !== false) {
          const payload = JSON.stringify(result.data ?? result);
          await redis.setex(trigger.redisKey, trigger.ttlSeconds, payload);
          // Publish to channel so gateway can broadcast to WS clients
          await redis.publish(`channel:${service}`, payload);
          log.info('completed', { durationMs: Date.now() - startMs });
        }

        await redis.publish(resultChannel, JSON.stringify({
          service, status: result?.ok === false ? 'error' : 'ok',
          durationMs: Date.now() - startMs,
          reason: result?.reason,
        }));
      } catch (err) {
        log.error('failed', { err });
        await redis.publish(resultChannel, JSON.stringify({
          service, status: 'error',
          durationMs: Date.now() - startMs,
          error: err.message,
        }));
      }
    });

    // Graceful shutdown
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, async () => {
        log.info('shutting down', { signal: sig });
        clearInterval(heartbeatInterval);
        sub.unsubscribe();
        sub.quit();
        redis.quit();
        process.exit(0);
      });
    }

    log.info('worker ready, waiting for triggers', { channel: triggerChannel });
  }

  start().catch(err => {
    log.error('fatal startup error', { err });
    process.exit(1);
  });
}

module.exports = { createWorker };
```

**Step 5: Commit**

```bash
git add services/shared/
git commit -m "feat: create @worldmonitor/shared library (logger, redis, worker runner)"
```

---

## Phase 1 — Orchestrator + Supabase Config

### Task 2: Create `wm_admin.service_config` table

**Files:**
- Create: `supabase/migrations/YYYYMMDDHHMMSS_create_service_config.sql`

**Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS wm_admin.service_config (
  service_key          TEXT PRIMARY KEY,
  enabled              BOOLEAN NOT NULL DEFAULT true,
  cron_schedule        TEXT NOT NULL,
  timeout_ms           INTEGER NOT NULL DEFAULT 30000,
  redis_key            TEXT NOT NULL,
  ttl_seconds          INTEGER NOT NULL DEFAULT 600,
  settings             JSONB NOT NULL DEFAULT '{}',
  last_run_at          TIMESTAMPTZ,
  last_duration_ms     INTEGER,
  last_status          TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  max_consecutive_failures INTEGER NOT NULL DEFAULT 5,
  alert_on_failure     BOOLEAN NOT NULL DEFAULT true,
  description          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE wm_admin.service_config IS
  'Orchestrator-managed service schedules and runtime config. Changes are picked up via Realtime.';

ALTER TABLE wm_admin.service_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_config_admin_read ON wm_admin.service_config
  FOR SELECT TO authenticated
  USING (wm_admin.has_role(auth.uid(), 'admin'));

CREATE POLICY service_config_admin_write ON wm_admin.service_config
  FOR ALL TO authenticated
  USING (wm_admin.has_role(auth.uid(), 'admin'));
```

**Step 2: Seed with all services**

```sql
INSERT INTO wm_admin.service_config (service_key, cron_schedule, redis_key, ttl_seconds, description) VALUES
  ('channel-markets',     '*/2 * * * *',   'market:dashboard:v1',           480,   'Finnhub + Yahoo + CoinGecko market data'),
  ('channel-news-full',   '*/15 * * * *',  'news:digest:v1:full:en',        900,   'Full news digest'),
  ('channel-news-tech',   '*/15 * * * *',  'news:digest:v1:tech:en',        900,   'Tech news digest'),
  ('channel-news-finance','*/15 * * * *',  'news:digest:v1:finance:en',     900,   'Finance news digest'),
  ('channel-news-happy',  '*/15 * * * *',  'news:digest:v1:happy:en',       900,   'Positive news digest'),
  ('channel-fred',        '*/30 * * * *',  'relay:fred:v1',                 1800,  'FRED economic data'),
  ('channel-weather',     '*/10 * * * *',  'relay:weather:v1',              600,   'NWS weather alerts'),
  ('channel-flights',     '*/30 * * * *',  'relay:flights:v1',              7200,  'FAA + intl aviation data'),
  ('channel-opensky',     '*/1 * * * *',   'relay:opensky:v1',              120,   'Global aircraft states'),
  ('channel-oil',         '0 * * * *',     'relay:oil:v1',                  3600,  'EIA oil data'),
  ('channel-crypto',      '*/5 * * * *',   'relay:stablecoins:v1',          600,   'Stablecoins + ETF flows'),
  ('channel-trade',       '*/15 * * * *',  'relay:trade:v1',                900,   'WTO trade data'),
  ('channel-conflict',    '*/30 * * * *',  'relay:conflict:v1',             1800,  'ACLED conflict events'),
  ('channel-climate',     '0 */6 * * *',   'relay:climate:v1',              21600, 'Climate anomalies'),
  ('channel-natural',     '0 * * * *',     'relay:natural:v1',              3600,  'FIRMS + EONET + GDACS'),
  ('channel-risk',        '*/10 * * * *',  'risk:scores:sebuf:v1',          600,   'Strategic risk scores'),
  ('channel-posture',     '*/15 * * * *',  'theater-posture:sebuf:v1',      900,   'Strategic posture'),
  ('channel-polymarket',  '*/10 * * * *',  'relay:predictions:v1',          600,   'Prediction markets'),
  ('channel-worldbank',   '0 */6 * * *',   'relay:worldbank:v1',            21600, 'World Bank indicators'),
  ('channel-youtube',     '*/5 * * * *',   'relay:youtube-live:v1',         300,   'YouTube live stream status'),
  ('channel-cables',      '*/10 * * * *',  'relay:cables:v1',               600,   'Submarine cables'),
  ('channel-cyber',       '0 */2 * * *',   'relay:cyber:v1',                7200,  'Cyber events'),
  ('channel-service-status','*/30 * * * *','relay:service-status:v1',       1800,  'Service health checks'),
  ('channel-gps',         '0 * * * *',     'relay:gps-interference:v1',     3600,  'GPS interference data'),
  ('channel-gdelt',       '*/15 * * * *',  'relay:gdelt:v1',                900,   'GDELT intel events'),
  ('channel-security-advisories','*/30 * * * *','relay:security-advisories:v1',1800,'Security advisory feeds'),
  ('channel-misc',        '*/10 * * * *',  'relay:misc:v1',                 600,   'Gulf quotes, tech events, spending, giving, BIS, NOTAMs'),
  ('ingest-oref',         '*/5 * * * *',   'relay:oref:v1',                 600,   'OREF siren alerts'),
  ('ingest-ucdp',         '0 */6 * * *',   'conflict:ucdp-events:v1',      86400, 'UCDP conflict events'),
  ('ai-intel-digest',     '2 */4 * * *',   'ai:digest:global:v1',           14400, 'AI global intelligence digest'),
  ('ai-panel-summary',    '*/15 * * * *',  'ai:panel-summary:v1',           900,   'AI panel summary (two-model consensus)'),
  ('ai-article-summaries','*/15 * * * *',  'ai:article-summaries:v1',       86400, 'AI article summarization'),
  ('ai-country-briefs',   '5 */2 * * *',   'ai:country-briefs:v1',          7200,  'AI country intel briefs'),
  ('ai-posture-analysis', '10 */4 * * *',  'ai:posture-analysis:v1',        14400, 'AI posture analysis'),
  ('ai-instability',      '15 */4 * * *',  'ai:instability-analysis:v1',    14400, 'AI instability analysis'),
  ('ai-risk-overview',    '4-59/15 * * * *','ai:risk-overview:v1',          3600,  'AI strategic risk overview')
ON CONFLICT (service_key) DO NOTHING;
```

**Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat: create service_config table for orchestrator scheduling"
```

---

### Task 3: Create orchestrator service

**Files:**
- Create: `services/orchestrator/package.json`
- Create: `services/orchestrator/index.cjs`
- Create: `services/orchestrator/Dockerfile`

**Step 1: Build the orchestrator**

The orchestrator:
1. Loads all `service_config` rows from Supabase on startup
2. Subscribes to Supabase Realtime for config changes (schedule, enabled, settings)
3. Registers a `node-cron` job for each enabled service
4. On cron tick: publishes trigger to `orchestrator:trigger:{service_key}` via Redis
5. Listens on `orchestrator:result:*` for completion reports
6. Listens on `orchestrator:heartbeat` for health tracking
7. Updates `last_run_at`, `last_status`, `last_duration_ms`, `consecutive_failures` in Supabase
8. Sends alerts via webhook when `consecutive_failures >= max_consecutive_failures`
9. Exposes admin API:
   - `GET /services` — list all services with status
   - `POST /trigger/{service_key}` — manual trigger
   - `POST /enable/{service_key}` — enable/disable
   - `GET /health` — orchestrator health

**Step 2: Commit**

```bash
git add services/orchestrator/
git commit -m "feat: create orchestrator service with Supabase config + Redis triggers"
```

---

## Phase 2 — Gateway

### Task 4: Create gateway service

**Files:**
- Create: `services/gateway/package.json`
- Create: `services/gateway/index.cjs`
- Create: `services/gateway/Dockerfile`

**Step 1: Build the gateway**

The gateway is a thin read/broadcast layer:

**HTTP endpoints:**
- `GET /health` — health check
- `GET /bootstrap?variant=` — reads multiple Redis keys, assembles bootstrap payload
- `GET /panel/{channel}` — reads single Redis key, returns cached JSON
- `GET /api/{channel}` — same as `/panel/`, aliased for frontend compatibility
- `GET /metrics` — relay metrics from Redis

**WebSocket:**
- Accepts connections at `ws://host:port`
- Handles `wm-subscribe` / `wm-unsubscribe` messages
- Subscribes to Redis pub/sub `channel:*`
- On Redis message: broadcasts to subscribed WS clients as `{ type: 'wm-push', channel, payload }`
- Rate limits subscriptions (existing logic)
- Sends cached payloads on subscribe (reads from Redis)

**Auth:**
- `RELAY_SHARED_SECRET` for admin/push endpoints
- `RELAY_WS_TOKEN` for WS connections
- CORS allowlist (existing origins)

**What the gateway does NOT do:**
- No external API calls
- No data processing
- No cron schedules
- No caching logic (just reads Redis)
- No LLM calls

**Step 2: Commit**

```bash
git add services/gateway/
git commit -m "feat: create gateway service (HTTP + WS, pure Redis read layer)"
```

---

## Phase 3 — Extract Services

Each task extracts one service from the monolith. Services are extracted one at a time using the shadow → canary → switch migration pattern.

### Task 5: Extract `ais-processor` (always-on)

**Source:** `scripts/ais-relay.cjs:2397-2870, 5005-5125`

The AIS processor:
- Connects to aisstream.io WebSocket
- Processes position reports into vessel map, density grid, chokepoint detection
- Builds snapshots on interval
- Writes snapshots to Redis (`relay:ais-snapshot:v1`)
- Publishes to `channel:ais` pub/sub

This service keeps its own in-memory state (vessels, density) and periodically flushes snapshots to Redis.

### Task 6: Extract `ai-engine` (triggered by orchestrator)

**Source:** `scripts/ais-relay.cjs:277-1207`

The AI engine:
- Resolves LLM provider credentials from Supabase
- Loads prompts from Supabase
- Runs 8 generation functions when triggered
- Each function reads context from Redis (news, markets, etc.), calls LLM, writes result to Redis
- Uses `createWorker` pattern but with multiple trigger channels (one per AI function)

### Task 7: Extract `ingest-telegram` (always-on)

**Source:** `scripts/ais-relay.cjs:1442-1745`

Always-on due to Telegram session management. Polls on its own internal schedule.

### Task 8: Extract `ingest-oref` (triggered by orchestrator)

**Source:** `scripts/ais-relay.cjs:1746-2014`

### Task 9: Extract `ingest-ucdp` (triggered by orchestrator)

**Source:** `scripts/ais-relay.cjs:2015-2131`

### Tasks 10–28: Extract all channel services

Each channel service uses the `createWorker` pattern:

```javascript
// services/channel-fred/index.cjs
const { createWorker } = require('@worldmonitor/shared/worker');

createWorker({
  service: 'channel-fred',
  async onTrigger({ config, redis, log }) {
    // ... existing fetchFred() logic from ais-relay.cjs ...
    return { ok: true, data: fredData };
  },
});
```

**Former proxies that become channel fetchers:**

| Task | Service | Old pattern | New pattern |
|------|---------|-------------|-------------|
| 10 | `channel-opensky` | Client sends bbox → relay forwards to OpenSky API | Fetch global states every 60s, cache full dataset. Gateway filters by bbox from cache. |
| 11 | `channel-polymarket` | Client sends query → relay forwards to Gamma API | Fetch all tracked markets every 10min, cache. |
| 12 | `channel-worldbank` | Client sends indicator → relay forwards to World Bank | Fetch all tracked indicators every 6h, cache. |
| 13 | `channel-youtube` | Client asks "is this live?" → relay checks | Check all configured channels every 5min, cache. |
| 14 | `channel-gdelt` | Client sends params → relay forwards to GDELT | Fetch configured queries every 15min, cache. |
| 15 | `channel-security-advisories` | Client sends RSS URL → relay fetches | Fetch configured advisory feeds every 30min, cache. |

**Channel fetchers (straightforward extraction):**

| Task | Service | Source lines |
|------|---------|-------------|
| 16 | `channel-markets` | 6653-6820 (Finnhub + Yahoo + CoinGecko) |
| 17 | `channel-news` | 7340-7410 (4 news variants) |
| 18 | `channel-fred` | 5601-5680 |
| 19 | `channel-weather` | complex (NWS) |
| 20 | `channel-flights` | complex (FAA + intl + NOTAM pre-cache) |
| 21 | `channel-oil` | 5718-5780 |
| 22 | `channel-crypto` | stablecoins + ETF flows |
| 23 | `channel-trade` | 5280-5320 |
| 24 | `channel-conflict` | 6990-7050 (ACLED) |
| 25 | `channel-climate` | climate anomalies |
| 26 | `channel-natural` | FIRMS + EONET + GDACS |
| 27 | `channel-risk` | strategic risk scores |
| 28 | `channel-misc` | Gulf quotes, tech events, spending, giving, BIS, cables, cyber, GPS, service-status |

### Migration strategy per service

```
1. SHADOW — new service writes to shadow Redis key (e.g. relay:fred:v2)
           — compare output with monolith's relay:fred:v1
           — monolith still serves clients
           
2. CANARY — gateway reads from new key for 10% of requests
           — monitor for errors/differences
           
3. SWITCH — gateway reads from new key for 100%
           — disable channel in monolith
           
4. CLEANUP — remove old code from monolith
```

---

## Phase 4 — Docker

### Task 29: Create shared base image

**Files:**
- Create: `services/Dockerfile.base`

```dockerfile
FROM node:22-alpine AS base
RUN apk add --no-cache tini
WORKDIR /app
COPY services/shared/ ./shared/
RUN cd shared && npm ci --omit=dev
ENTRYPOINT ["/sbin/tini", "--"]
USER node
```

### Task 30: Create per-service Dockerfiles

Each service Dockerfile:

```dockerfile
FROM ghcr.io/yourorg/relay-base:latest
COPY services/channel-fred/ ./service/
RUN cd service && npm ci --omit=dev
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "require('./shared/redis').ping()"
CMD ["node", "service/index.cjs"]
```

### Task 31: Create Docker Compose

**Files:**
- Create: `services/docker-compose.yml`
- Create: `services/docker-compose.dev.yml`
- Create: `services/docker-compose.prod.yml`

**docker-compose.yml (base):**

```yaml
services:
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 1gb --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    healthcheck:
      test: redis-cli ping
      interval: 10s

  orchestrator:
    build:
      context: .
      dockerfile: services/orchestrator/Dockerfile
    depends_on:
      redis: { condition: service_healthy }
    environment:
      REDIS_URL: redis://redis:6379
      SUPABASE_URL: ${SUPABASE_URL}
      SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY}
      LOG_LEVEL: info

  gateway:
    build:
      context: .
      dockerfile: services/gateway/Dockerfile
    ports:
      - "${RELAY_PORT:-3004}:3004"
    depends_on:
      redis: { condition: service_healthy }
    environment:
      REDIS_URL: redis://redis:6379
      RELAY_SHARED_SECRET: ${RELAY_SHARED_SECRET}
      RELAY_WS_TOKEN: ${RELAY_WS_TOKEN}
      LOG_LEVEL: info

  ais-processor:
    build:
      context: .
      dockerfile: services/ais-processor/Dockerfile
    depends_on:
      redis: { condition: service_healthy }
    environment:
      REDIS_URL: redis://redis:6379
      AISSTREAM_API_KEY: ${AISSTREAM_API_KEY}

  channel-markets:
    build:
      context: .
      dockerfile: services/channel-markets/Dockerfile
    depends_on:
      redis: { condition: service_healthy }
      orchestrator: { condition: service_started }
    environment:
      REDIS_URL: redis://redis:6379
      FINNHUB_API_KEY: ${FINNHUB_API_KEY}

  # ... all other services, each with only the env vars it needs ...

volumes:
  redis-data:

networks:
  default:
    name: relay-network
```

**docker-compose.dev.yml (minimal for local dev):**

```yaml
# Run: docker compose -f docker-compose.yml -f docker-compose.dev.yml up redis gateway orchestrator channel-fred
services:
  redis:
    ports:
      - "6379:6379"

  gateway:
    environment:
      LOG_LEVEL: debug
      LOG_FORMAT: human

  orchestrator:
    environment:
      LOG_LEVEL: debug
```

**Step: Commit**

```bash
git add services/Dockerfile.base services/docker-compose*.yml
git commit -m "feat: add Docker infrastructure (base image, compose files)"
```

---

## Phase 5 — GitHub Actions CI/CD

### Task 32: Create build workflow

**Files:**
- Create: `.github/workflows/build-services.yml`

```yaml
name: Build & Publish Services

on:
  push:
    branches: [main]
    paths:
      - 'services/**'
  pull_request:
    paths:
      - 'services/**'

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.changes.outputs.services }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - id: changes
        run: |
          changed=$(git diff --name-only HEAD~1 HEAD -- services/ \
            | grep -oP 'services/[^/]+' | sort -u | sed 's|services/||')
          # Always rebuild if shared/ changed
          if echo "$changed" | grep -q '^shared$'; then
            all=$(ls -d services/*/ | sed 's|services/||;s|/||' | grep -v shared)
            echo "services=$(echo $all | jq -R -s -c 'split(" ") | map(select(length > 0))')" >> $GITHUB_OUTPUT
          else
            echo "services=$(echo $changed | jq -R -s -c 'split("\n") | map(select(length > 0))')" >> $GITHUB_OUTPUT
          fi

  build:
    needs: detect-changes
    if: needs.detect-changes.outputs.services != '[]'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: ${{ fromJson(needs.detect-changes.outputs.services) }}
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: services/${{ matrix.service }}/Dockerfile
          push: ${{ github.event_name == 'push' }}
          tags: |
            ghcr.io/${{ github.repository_owner }}/relay-${{ matrix.service }}:${{ github.sha }}
            ghcr.io/${{ github.repository_owner }}/relay-${{ matrix.service }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Key features:
- **Change detection** — only rebuilds services whose files changed
- **Shared library change** — triggers rebuild of ALL services
- **GHCR publishing** — tagged with SHA + `latest`
- **PR builds** — build but don't push (verify Dockerfile works)

**Step: Commit**

```bash
git add .github/workflows/build-services.yml
git commit -m "feat: add GitHub Actions workflow for service builds"
```

---

## Phase 6 — Observability

### Task 33: Add centralized logging

All containers log structured JSON to stdout/stderr. Docker Compose captures these natively. For production:

- Use Docker logging driver to ship to Loki, CloudWatch, or Datadog
- Each log line includes `scope` (service name) for filtering
- Correlation IDs: orchestrator includes `triggerId` in trigger messages, workers propagate it through logs

### Task 34: Add alerting to orchestrator

The orchestrator sends alerts when:
- A service has `consecutive_failures >= max_consecutive_failures`
- A service hasn't sent a heartbeat in `2 * cron_interval`
- Redis memory exceeds threshold
- Any service exits unexpectedly

Alert destinations (configurable via env):
- `ALERT_DISCORD_WEBHOOK` — Discord channel
- `ALERT_SLACK_WEBHOOK` — Slack channel

```javascript
async function sendAlert({ service, type, message }) {
  const webhookUrl = process.env.ALERT_DISCORD_WEBHOOK;
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `🚨 **${service}** — ${type}: ${message}`,
    }),
  });
}
```

### Task 35: Add metrics endpoint to gateway

`GET /metrics` returns:
- Per-service: last_run_at, last_duration_ms, last_status, consecutive_failures
- Redis: memory usage, key count, pub/sub channel count
- Gateway: WS client count, channel subscriber counts, messages/sec
- System: container uptime, memory usage

Data sourced from orchestrator's Supabase table + Redis INFO.

**Step: Commit**

```bash
git add services/orchestrator/ services/gateway/
git commit -m "feat: add alerting and metrics to orchestrator and gateway"
```

---

## Phase 7 — Frontend Migration

### Task 36: Remove OpenSky proxy calls

**Files:**
- Modify: `src/services/military-flights.ts`

**Current:** Lines 268–275 call `/api/opensky?lamin=...&lomax=...` on-demand when the user pans the map.

**New:** The `channel-opensky` service fetches ALL global aircraft states every 60s and caches them in Redis. The gateway serves the full dataset at `GET /api/opensky`. The frontend fetches the full dataset and filters client-side by bounding box.

```typescript
// OLD — on-demand proxy with bounding box
const url = `${OPENSKY_PROXY_URL}?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
const resp = await fetch(url);

// NEW — subscribe to opensky channel, filter client-side
// In App.ts setupRelayPush, add 'opensky' to channels
// In military-flights.ts, filter from cached data
```

Alternative: if the full global dataset is too large for WS push, the gateway can accept bbox query params on `GET /api/opensky?bbox=...` and filter server-side from the cached Redis data.

**Step: Commit**

```bash
git add src/services/military-flights.ts
git commit -m "refactor(frontend): replace OpenSky proxy with cached channel read"
```

---

### Task 37: Remove RSS proxy calls

**Files:**
- Modify: `src/services/security-advisories.ts`

**Current:** Line 212 calls `RELAY_HTTP_BASE/rss?url=...` to fetch arbitrary RSS feeds on-demand.

**New:** The `channel-security-advisories` service pre-fetches all configured advisory feeds every 30min. The frontend reads from the cached channel via `GET /panel/security-advisories` or WebSocket subscription.

```typescript
// OLD — on-demand RSS proxy
const resp = await fetch(`${RELAY_HTTP_BASE}/rss?url=${encodeURIComponent(feedUrl)}`);

// NEW — read from cached channel
const resp = await fetch(`${RELAY_HTTP_BASE}/panel/security-advisories`);
```

This requires defining the list of advisory feeds in the orchestrator config (`settings` JSONB field on the `channel-security-advisories` row).

**Step: Commit**

```bash
git add src/services/security-advisories.ts
git commit -m "refactor(frontend): replace RSS proxy with cached security-advisories channel"
```

---

### Task 38: Remove Polymarket proxy calls

**Files:**
- Modify: `src/services/prediction/index.ts`

**Current:** Lines 139–149 call `/api/polymarket` on-demand.

**New:** The `predictions` WebSocket channel already pushes Polymarket data. Remove the on-demand proxy fallback entirely.

```typescript
// OLD — on-demand proxy
const resp = await fetch(`${POLYMARKET_PROXY_URL}?endpoint=${encodeURIComponent(endpoint)}`);

// NEW — data comes via WS 'predictions' channel (already subscribed in App.ts:579)
// Remove fetchPredictionMarkets() HTTP call entirely
// Prediction panel only uses WS-pushed data
```

**Step: Commit**

```bash
git add src/services/prediction/index.ts
git commit -m "refactor(frontend): remove Polymarket proxy, use predictions WS channel"
```

---

### Task 39: Remove AIS snapshot polling

**Files:**
- Modify: `src/services/maritime/index.ts`

**Current:** Lines 343–361 poll `/api/ais-snapshot` every 5 minutes via setInterval.

**New:** The `ais` WebSocket channel already pushes AIS data. Enhance the `ais-processor` to include full snapshot data (disruptions, density, candidates) in the channel payload. Remove the polling entirely.

```typescript
// OLD — poll every 5 minutes
this.snapshotInterval = setInterval(() => this.fetchSnapshot(), 5 * 60 * 1000);

// NEW — subscribe to 'ais' WS channel (already done in App.ts)
// The ais-processor service pushes full snapshot data including candidates
// Remove fetchSnapshot(), snapshotInterval, and all polling logic
```

**Step: Commit**

```bash
git add src/services/maritime/index.ts
git commit -m "refactor(frontend): remove AIS snapshot polling, use ais WS channel"
```

---

### Task 40: Remove GDELT proxy calls

**Files:**
- Modify: `src/services/gdelt-intel.ts`

**Current:** Line 143 calls `RELAY_HTTP_BASE/gdelt?params` on-demand.

**New:** The `channel-gdelt` service pre-fetches GDELT data every 15min. Frontend reads from cached channel.

```typescript
// OLD
const resp = await fetch(`${RELAY_HTTP_BASE}/gdelt?${params}`);

// NEW
const resp = await fetch(`${RELAY_HTTP_BASE}/panel/gdelt`);
// Or subscribe to 'gdelt' WS channel
```

**Step: Commit**

```bash
git add src/services/gdelt-intel.ts
git commit -m "refactor(frontend): replace GDELT proxy with cached channel read"
```

---

### Task 41: Remove OREF polling fallback

**Files:**
- Modify: `src/services/oref-alerts.ts`

**Current:** Line 297 polls OREF API directly every ~120s as a fallback.

**New:** The `oref` WebSocket channel already pushes alerts. Remove the direct polling entirely — the `ingest-oref` service handles all fetching.

```typescript
// OLD — direct polling fallback
this.pollInterval = setInterval(() => this.pollOref(), 120_000);

// NEW — remove polling entirely
// Data comes via 'oref' WS channel (already subscribed)
```

**Step: Commit**

```bash
git add src/services/oref-alerts.ts
git commit -m "refactor(frontend): remove OREF direct polling, rely on oref WS channel"
```

---

### Task 42: Update `relay-http.ts` and `bootstrap.ts`

**Files:**
- Modify: `src/services/relay-http.ts`
- Modify: `src/services/bootstrap.ts`

**Current:** `relay-http.ts` exports `fetchRelayPanel`, `relayRssUrl`, `fetchRelayMap`. `bootstrap.ts` calls `RELAY_HTTP_BASE/bootstrap`.

**New:**
- Remove `relayRssUrl` (no more RSS proxy)
- Remove `fetchRelayMap` (unused)
- `fetchRelayPanel` stays — gateway still serves `/panel/{channel}` from Redis cache
- `bootstrap.ts` stays — gateway serves `/bootstrap` by assembling multiple Redis keys
- Update `RELAY_HTTP_BASE` to point to gateway URL

```typescript
// relay-http.ts — cleaned up
export const RELAY_HTTP_BASE = import.meta.env.VITE_RELAY_HTTP_URL || 'https://relay.5ls.us';

export async function fetchRelayPanel<T>(channel: string): Promise<T | null> {
  const resp = await fetch(`${RELAY_HTTP_BASE}/panel/${channel}`);
  if (!resp.ok) return null;
  return resp.json();
}

// Remove: relayRssUrl, fetchRelayMap
```

**Step: Commit**

```bash
git add src/services/relay-http.ts src/services/bootstrap.ts
git commit -m "refactor(frontend): clean up relay-http.ts, remove proxy helpers"
```

---

### Task 43: Clean up env vars and settings

**Files:**
- Modify: `src/services/settings-constants.ts`
- Modify: `src/services/runtime-config.ts`

Remove references to:
- `VITE_OPENSKY_RELAY_URL` (no more OpenSky proxy)
- `VITE_RELAY_SHARED_SECRET` (client should never have the shared secret)
- Any proxy-specific settings

**Step: Commit**

```bash
git add src/services/settings-constants.ts src/services/runtime-config.ts
git commit -m "refactor(frontend): remove proxy-related env vars and settings"
```

---

## Phase 8 — CLI

### Task 44: Create `relay-ctl.sh`

**Files:**
- Create: `scripts/relay-ctl.sh`

The CLI talks to the orchestrator's admin API:

```bash
#!/usr/bin/env bash
# relay-ctl.sh — WorldMonitor Relay management CLI

ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3005}"

case "${1:-}" in
  services)    cmd_services "$@" ;;    # GET /services — list all with status
  trigger)     cmd_trigger "$@" ;;     # POST /trigger/{service} — manual trigger
  enable)      cmd_enable "$@" ;;      # POST /enable/{service}?enabled=true/false
  logs)        cmd_logs "$@" ;;        # docker compose logs -f [service]
  status)      cmd_status "$@" ;;      # GET /health + docker compose ps
  update)      cmd_update "$@" ;;      # git pull + docker compose build + up
  rollback)    cmd_rollback "$@" ;;    # checkout SHA + rebuild + up
  auto-update) cmd_auto_update "$@" ;; # systemd timer on/off
  config)      cmd_config "$@" ;;      # show/validate/diff env
  cache)       cmd_cache "$@" ;;       # redis-cli stats/clear
  health)      cmd_health "$@" ;;      # GET /health on gateway + orchestrator
  *)           usage ;;
esac
```

**Key difference from previous plan:** The CLI now talks to the orchestrator API instead of directly managing pm2/systemd. Docker Compose handles service lifecycle.

**Step: Commit**

```bash
chmod +x scripts/relay-ctl.sh
git add scripts/relay-ctl.sh
git commit -m "feat: add relay-ctl CLI (talks to orchestrator API)"
```

---

## Phase 9 — Secrets & Networking

### Task 45: Configure secrets management

**Approach:** Docker Compose secrets + Supabase Vault

```yaml
# docker-compose.prod.yml
services:
  channel-markets:
    secrets:
      - finnhub_api_key
    environment:
      FINNHUB_API_KEY_FILE: /run/secrets/finnhub_api_key

secrets:
  finnhub_api_key:
    external: true  # Created via: docker secret create finnhub_api_key ./secret.txt
```

Each service reads its secret from `/run/secrets/` — never from env vars in production.

For the orchestrator: API keys can also live in the `settings` JSONB field of `service_config`, encrypted via Supabase Vault. The orchestrator passes them in the trigger message so workers don't need any secret env vars at all.

### Task 46: Configure network isolation

```yaml
# docker-compose.prod.yml
networks:
  internal:
    internal: true    # No external access
  public:
    driver: bridge    # Gateway exposed

services:
  gateway:
    networks: [internal, public]
    ports:
      - "3004:3004"

  orchestrator:
    networks: [internal]

  redis:
    networks: [internal]

  channel-markets:
    networks: [internal]

  # All other services: internal only
```

Only the gateway is exposed publicly. All other services communicate only through Redis on the internal network.

**Step: Commit**

```bash
git add services/docker-compose.prod.yml
git commit -m "feat: add secrets management and network isolation"
```

---

## Verification Checklist

1. **Orchestrator triggers services on schedule:**
   ```bash
   relay-ctl services   # All services show last_run_at, status
   ```

2. **Gateway serves cached data:**
   ```bash
   curl http://localhost:3004/panel/markets | jq .
   curl http://localhost:3004/health
   ```

3. **WebSocket push works:**
   ```bash
   wscat -c ws://localhost:3004 -x '{"type":"wm-subscribe","channels":["markets"]}'
   ```

4. **Frontend loads with no proxy calls:**
   - Open browser DevTools Network tab
   - Verify zero calls to `/opensky`, `/rss?url=`, `/polymarket`, `/gdelt`
   - Verify all data arrives via WS push or `/panel/*` cached reads

5. **Manual trigger works:**
   ```bash
   relay-ctl trigger channel-fred
   ```

6. **Config changes propagate:**
   - Change `channel-fred` cron from `*/30` to `*/15` in Supabase admin
   - Orchestrator picks up change via Realtime
   - Next trigger fires at new interval

7. **Alerting works:**
   - Disable Redis, wait for failures
   - Discord/Slack alert fires

8. **GitHub Actions builds on push:**
   - Change a service file, push to main
   - Only that service rebuilds

9. **Local dev works with minimal services:**
   ```bash
   docker compose up redis gateway orchestrator channel-fred
   ```

---

## Phase 10 — Cloudflare Tunnel

### Task 47: Add `cloudflared` container

**Files:**
- Modify: `services/docker-compose.yml`
- Modify: `services/docker-compose.prod.yml`

**Step 1: Add cloudflared service to Docker Compose**

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      gateway: { condition: service_healthy }
    networks:
      - internal
    restart: always
```

**Step 2: Remove exposed ports from gateway**

```yaml
# docker-compose.prod.yml
services:
  gateway:
    # NO ports: section — all traffic goes through tunnel
    networks:
      - internal
```

The dev Compose file keeps `ports: "3004:3004"` for local development (no tunnel needed locally).

**Step 3: Configure tunnel route in Cloudflare Dashboard**

| Public hostname | Service target | Access policy |
|----------------|---------------|---------------|
| `relay.5ls.us` | `http://gateway:3004` | Public (CORS + RELAY_SHARED_SECRET handle auth) |

No separate admin subdomain — orchestrator admin is accessed through the existing admin portal (see Task 49).

The gateway exposes `/admin/*` routes that proxy to `orchestrator:3005` on the internal network. These endpoints require a valid Supabase admin JWT (same `requireAdmin()` pattern used by all other admin APIs).

Cloudflare natively handles:
- TLS termination (`https://relay.5ls.us` → `http://gateway:3004`)
- WebSocket upgrade (`wss://relay.5ls.us` → `ws://gateway:3004`)
- DDoS protection
- HTTP/2 and HTTP/3

**Step 4: Gateway admin proxy route**

The gateway includes a reverse-proxy path for orchestrator admin calls:

```javascript
// gateway/index.cjs — admin proxy to orchestrator
if (req.url.startsWith('/admin/')) {
  const orchestratorUrl = `http://orchestrator:3005${req.url}`;
  const proxyRes = await fetch(orchestratorUrl, {
    method: req.method,
    headers: { authorization: req.headers.authorization },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
  });
  res.writeHead(proxyRes.status, Object.fromEntries(proxyRes.headers));
  proxyRes.body.pipe(res);
  return;
}
```

The orchestrator validates the Supabase JWT and checks admin role — same `get_my_admin_role()` RPC pattern used by all existing admin endpoints.

**Step 5: Update `relay-ctl.sh` for remote access**

When running `relay-ctl` remotely, it talks to the orchestrator through the gateway:

```bash
RELAY_URL="${RELAY_URL:-https://relay.5ls.us}"
```

Authentication uses the same Supabase JWT:

```bash
curl -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
     "${RELAY_URL}/admin/services"
```

**Step 6: Verify no ports are exposed on host**

```bash
# On the relay host:
sudo ss -tlnp | grep -E '3004|3005'
# Expected: nothing — all traffic goes through cloudflared tunnel
```

**Step 7: Commit**

```bash
git add services/docker-compose.yml services/docker-compose.prod.yml services/gateway/index.cjs scripts/relay-ctl.sh
git commit -m "feat: add Cloudflare Tunnel container, gateway admin proxy, remove exposed ports"
```

---

### Task 48: Secure Upstash Redis connection

**Files:**
- Modify: `.env` / `.env.example`

**Step 1: Verify Upstash Redis uses HTTPS**

Current `.env` has:
```
UPSTASH_REDIS_REST_URL=http://redis.5ls.us
```

If this is going through a local tunnel, change to use the Upstash-provided HTTPS URL directly:
```
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
```

Or if `redis.5ls.us` is a local tunnel to the Docker Redis container, that's fine for the REST proxy but the internal Docker services should use `redis://redis:6379` (the Docker service name) instead.

**Step 2: Ensure internal services use Docker DNS**

All Docker services should use `REDIS_URL=redis://redis:6379` (the Docker Compose service name), not any external URL. Only the Upstash REST API (used for warm/broadcast to the Vercel frontend) should use the external URL.

**Step 3: Commit**

```bash
git add .env.example
git commit -m "fix: ensure Redis connections use HTTPS or internal Docker DNS"
```

---

## Network Architecture (Final)

```
                        Internet
                           │
                    Cloudflare Edge
                    (TLS, DDoS, WAF)
                           │
              ┌────────────┼────────────────┐
              │                             │
         relay.5ls.us                  ollama.5ls.us
         (public + /admin/*)          (CF Access)
              │                             │
         ┌────┴─────────────────────────────┴───┐
         │           cloudflared container       │
         │    (outbound tunnel, no inbound ports)│
         └────┬─────────────────────────────┬───┘
              │                             │
    ┌─────────┴──┐                    ┌─────┴──────┐
    │  gateway   │                    │  ollama    │
    │  :3004     │                    │  :11434    │
    │  /admin/* ──┼── proxy ──┐       └────────────┘
    └─────┬──────┘           │
          │            ┌──────┴──────┐
          │            │orchestrator │
          │            │  :3005      │
          │            │  (JWT auth) │
          │            └──────┬──────┘
          │                   │
          │            Redis pub/sub
          │                   │
    ┌─────┴───────────────────┴──────────────────┐
    │              internal network               │
    │                                             │
    │  redis:6379  ais-processor  ai-engine       │
    │  channel-*   ingest-*                       │
    │  (28+ containers, no external access)       │
    └─────────────────────────────────────────────┘

Host firewall: ALL inbound ports CLOSED
              (cloudflared initiates outbound only)

Admin flow:
  Admin portal (Vercel) → relay.5ls.us/admin/* → gateway → orchestrator
  Auth: Supabase JWT + get_my_admin_role() — same as all other admin pages
```

---

### Task 49: Add Relay Services page to existing admin portal

**Files:**
- Create: `src/admin/pages/relay-services.ts`
- Create: `api/admin/relay-services.ts`
- Modify: `src/admin/dashboard.ts`

The orchestrator admin UI is a new page inside the existing admin portal — not a separate site or subdomain. It follows the exact same patterns as the other admin pages (e.g., `secrets.ts`, `llm-config.ts`).

**Step 1: Add nav entry in `dashboard.ts`**

Add to the `NAV` array and `PageId` type:

```typescript
type PageId = 'secrets' | 'feature-flags' | 'news-sources' | 'llm-config' | 'app-keys' | 'display-settings' | 'market-symbols' | 'relay-services';

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  // ... existing entries ...
  { id: 'relay-services', label: 'Relay Services', icon: '⚙️' },
];
```

Add the case to `navigateTo()`:

```typescript
case 'relay-services':
  renderRelayServicesPage(content, accessToken);
  break;
```

**Step 2: Create `src/admin/pages/relay-services.ts`**

Page provides:
- **Service list** — table of all services from `service_config`, showing: name, status (healthy/unhealthy/disabled), last run, next run, cron schedule
- **Enable/disable** toggle per service
- **Trigger now** button per service (sends trigger via orchestrator API)
- **Edit schedule** — inline edit for cron expression
- **Edit settings** — JSON editor for the `settings` JSONB field
- **View logs** — expandable log viewer per service (last N log entries from orchestrator)
- **Health overview** — summary cards showing total services, healthy count, unhealthy count, disabled count

Data flow:

```
Admin page → fetch('/api/admin/relay-services') → Vercel API route
  → fetch('https://relay.5ls.us/admin/services') → gateway → orchestrator
  → orchestrator reads from service_config + Redis health data
  → response flows back
```

Alternatively, the admin page can read `service_config` directly from Supabase (it already has the JWT and the table has admin-only RLS policies), and only use the orchestrator API for actions (trigger, restart, view logs):

```typescript
// Read config directly from Supabase (RLS enforced — admin only)
const { data: services } = await supabase
  .from('service_config')
  .select('*')
  .order('service_key');

// Actions go through orchestrator API via gateway
await fetch(`${RELAY_HTTP_BASE}/admin/services/${key}/trigger`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
});
```

**Step 3: Create `api/admin/relay-services.ts`**

Vercel API route that proxies action requests to the orchestrator. Uses the same `requireAdmin()` auth:

```typescript
import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

  try {
    const admin = await requireAdmin(req);

    const relayUrl = process.env.WS_RELAY_URL;
    const path = new URL(req.url).pathname.replace('/api/admin/relay-services', '/admin/services');

    const res = await fetch(`${relayUrl}${path}`, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${admin.client}`,
        'Content-Type': 'application/json',
      },
      body: ['GET', 'HEAD'].includes(req.method!) ? undefined : await req.text(),
    });

    return new Response(res.body, {
      status: res.status,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
```

**Step 4: Orchestrator admin endpoints**

The orchestrator exposes these internal HTTP endpoints (only reachable via gateway `/admin/*` proxy):

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/admin/services` | List all services with health/status |
| `POST` | `/admin/services/:key/trigger` | Trigger an immediate run |
| `POST` | `/admin/services/:key/enable` | Enable a disabled service |
| `POST` | `/admin/services/:key/disable` | Disable a service |
| `GET` | `/admin/services/:key/logs` | Get recent log entries |
| `GET` | `/admin/health` | Overall health summary |

All endpoints validate the Supabase JWT from the `Authorization` header using the same `get_my_admin_role()` RPC.

**Step 5: Commit**

```bash
git add src/admin/pages/relay-services.ts src/admin/dashboard.ts api/admin/relay-services.ts
git commit -m "feat: add Relay Services page to admin portal"
```

---

## Summary

| Phase | Tasks | What Ships |
|-------|-------|-----------|
| **0** | 1 | `@worldmonitor/shared` library (logger, redis, worker runner) |
| **1** | 2–3 | Orchestrator service + `service_config` Supabase table |
| **2** | 4 | Gateway service (HTTP + WS, pure Redis reader) |
| **3** | 5–28 | 24 extracted services (shadow → canary → switch per service) |
| **4** | 29–31 | Docker infrastructure (base image, Compose files, dev profiles) |
| **5** | 32 | GitHub Actions CI/CD (change detection, matrix build, GHCR publish) |
| **6** | 33–35 | Observability (centralized logging, alerting, metrics) |
| **7** | 36–43 | Frontend migration (remove all proxies, polling, and on-demand calls) |
| **8** | 44 | `relay-ctl.sh` CLI (talks to orchestrator API) |
| **9** | 45–46 | Secrets management + network isolation |
| **10** | 47–49 | Cloudflare Tunnel (zero exposed ports, HTTPS everywhere) + Relay Services admin page in existing portal |
