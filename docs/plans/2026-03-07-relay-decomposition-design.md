# Relay Microservices Decomposition — Design Document

**Date:** 2026-03-07
**Status:** Approved
**Supersedes:** `2026-03-06-relay-decomposition.plan.md` (original plan — retained for reference)

---

## Problem

`scripts/ais-relay.cjs` is a 7,874-line monolithic Node.js file containing 12+ concerns, 50+ cron schedules, 6 on-demand proxies, and 216 raw `console.*` calls. It is difficult to maintain, test, deploy, and debug. A single failure can take down all data feeds.

## Goals

1. Decompose the monolith into isolated, independently deployable services
2. Eliminate all frontend proxy/polling patterns in favor of cached reads and WebSocket push
3. Enable adding new data feeds without deploying new containers
4. Provide admin visibility and control over all services via the existing admin portal
5. Ship structured logging to Splunk for observability

## Non-Goals

- Rewriting the frontend framework
- Changing the WebSocket protocol (wm-subscribe/wm-push stays as-is)
- Multi-region deployment
- Kubernetes (Docker Compose on self-hosted server is sufficient)

---

## Architecture

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Worker model | Generic worker pool (3-4 replicas) | Avoids 28+ static containers; new feeds require no new containers |
| Inter-service communication | gRPC | Type-safe, reliable delivery, request/response semantics; project already has protobuf infrastructure |
| Redis role | Cache only (GET/SETEX) | No pub/sub; gRPC handles all notifications; simplifies Redis to one responsibility |
| Orchestrator exposure | Internal only (no HTTP API) | Admin uses Supabase directly; orchestrator subscribes via Realtime |
| Config-driven feeds | `fetch_type: simple_http \| simple_rss \| custom` | Simple feeds added via database row only; complex feeds need a code function |
| Deployment | Self-hosted Docker Compose + Cloudflare Tunnel | Already self-hosted; tunnel provides TLS/DDoS with zero inbound ports |
| Log aggregation | Splunk via Docker logging driver | Existing Splunk server; Docker driver is simplest integration |
| Redis provider | Local Redis container (Upstash deprecated) | All services on same host; local Redis eliminates external dependency |

### Container Architecture

```
Total containers: ~10

┌──────────────────────────────────────────────────────────────────┐
│                        Self-Hosted Server                        │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ cloudflared  │  │   gateway    │  │    orchestrator       │  │
│  │ (tunnel)     │──│   :3004      │  │  (no HTTP server)     │  │
│  └─────────────┘  │ HTTP + WS    │  │  Supabase Realtime    │  │
│                    │ gRPC server  │  │  → cron scheduling    │  │
│                    └──────┬───────┘  │  → gRPC trigger       │  │
│                           │          │  → Supabase writeback  │  │
│                           │          └──────────┬────────────┘  │
│                           │                     │ gRPC          │
│                      Redis (cache)              │               │
│                           │                     │               │
│  ┌────────────────────────┴─────────────────────┴────────────┐ │
│  │              Generic Workers (×3-4 replicas)               │ │
│  │  Receive gRPC trigger → load channel function → execute   │ │
│  │  → write Redis cache → gRPC broadcast to gateway          │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Dedicated Services                             │ │
│  │  ais-processor    — aisstream.io WebSocket, vessel state   │ │
│  │  ingest-telegram  — Telegram session, OSINT messages       │ │
│  │  ai-engine        — LLM calls, /api/deduct, 8 generators  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────┐  ┌────────────┐                                   │
│  │  redis   │  │ watchtower  │                                   │
│  │  :6379   │  │ auto-update │                                   │
│  └──────────┘  └────────────┘                                   │
└──────────────────────────────────────────────────────────────────┘

Host firewall: ALL inbound ports CLOSED
(cloudflared initiates outbound only)
```

### Communication Map

```
Supabase ──Realtime──► Orchestrator     (config changes, manual triggers)
Orchestrator ──gRPC──► Workers          (trigger: execute channel function)
Orchestrator ──gRPC──► AI Engine        (trigger: run AI generation)
Workers ─────gRPC───► Gateway           (broadcast: new data for WS clients)
AI Engine ───gRPC───► Gateway           (broadcast: new AI results)
AIS Processor ─gRPC─► Gateway           (broadcast: vessel updates)
Telegram ────gRPC───► Gateway           (broadcast: OSINT messages)
Workers ─────Redis──► (cache write)     (SETEX for HTTP reads)
Gateway ─────Redis──► (cache read)      (GET for /panel/*, /bootstrap)
Orchestrator ─Supa──► service_config    (write last_run_at, last_status)
Admin Portal ─Supa──► service_config    (read status, write config)
```

### gRPC Service Definitions

```protobuf
// proto/relay/v1/worker.proto
service WorkerService {
  rpc Execute(TriggerRequest) returns (TriggerResult);
  rpc HealthCheck(HealthRequest) returns (HealthResponse);
}

message TriggerRequest {
  string service_key = 1;
  string redis_key = 2;
  int32 ttl_seconds = 3;
  string settings_json = 4;
  string trigger_id = 5;       // correlation ID for logging
  string fetch_type = 6;       // "simple_http" | "simple_rss" | "custom"
}

message TriggerResult {
  string service_key = 1;
  string status = 2;           // "ok" | "error"
  int32 duration_ms = 3;
  string error = 4;
  string trigger_id = 5;
}

// proto/relay/v1/gateway.proto
service GatewayService {
  rpc Broadcast(BroadcastRequest) returns (BroadcastResponse);
}

message BroadcastRequest {
  string channel = 1;
  bytes payload = 2;
  int64 timestamp_ms = 3;
  string trigger_id = 4;
}

message BroadcastResponse {
  int32 clients_notified = 1;
}
```

---

## Directory Structure

```
services/
├── shared/                          # @worldmonitor/shared npm workspace package
│   ├── package.json
│   ├── logger.cjs                   # Structured JSON logger (LOG_LEVEL, scoped)
│   ├── redis.cjs                    # Redis client (GET/SETEX only, no pub/sub)
│   ├── config.cjs                   # Env var loader + validation
│   ├── http.cjs                     # HTTP fetch helpers (retries, compression)
│   ├── worker-runner.cjs            # Generic worker: gRPC trigger → load function → execute → Redis → gRPC broadcast
│   ├── grpc-client.cjs              # gRPC client helpers (gateway broadcast, etc.)
│   └── channels/                    # All channel fetch functions
│       ├── markets.cjs
│       ├── fred.cjs
│       ├── weather.cjs
│       ├── opensky.cjs
│       ├── oref.cjs
│       ├── trade.cjs
│       ├── macro-signals.cjs
│       ├── supply-chain.cjs
│       ├── iran-events.cjs
│       ├── pizzint.cjs
│       ├── ...                      # ~38 channel functions total
│       └── _simple-fetcher.cjs      # Generic fetcher for simple_http / simple_rss types
│
├── proto/
│   └── relay/v1/
│       ├── worker.proto
│       └── gateway.proto
│
├── orchestrator/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # Supabase Realtime → cron → gRPC triggers → Supabase writeback
│
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # HTTP + WS + gRPC server, reads Redis, broadcasts to WS
│
├── worker/
│   ├── Dockerfile                   # ONE image, replicated ×3-4
│   ├── package.json
│   └── index.cjs                    # gRPC server, loads channel functions dynamically
│
├── ais-processor/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # aisstream.io WS → vessel tracking → Redis + gRPC broadcast
│
├── ingest-telegram/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # Telegram OSINT (always-on, session-based)
│
├── ai-engine/
│   ├── Dockerfile
│   ├── package.json
│   └── index.cjs                    # LLM providers + 8 generators + /api/deduct
│
├── Dockerfile.base                  # Node 22 Alpine + shared lib + proto-generated code
├── docker-compose.yml               # Full stack
├── docker-compose.dev.yml           # Local dev overrides
├── docker-compose.prod.yml          # Production (tunnel, isolation, persistence, Splunk)
└── .github/
    └── workflows/
        └── build-services.yml       # CI/CD: build → push to GHCR → watchtower auto-updates
```

---

## Complete Channel Inventory

### Generic Worker Channels (~38 functions in `shared/channels/`)

| Channel Function | Redis Key | Cron | Fetch Type |
|---|---|---|---|
| `markets` | `market:dashboard:v1` | `*/5 * * * *` | custom |
| `stablecoins` | `relay:stablecoins:v1` | `*/5 * * * *` | custom |
| `etf-flows` | `relay:etf-flows:v1` | `*/5 * * * *` | custom |
| `macro-signals` | `economic:macro-signals:v1` | `3-59/5 * * * *` | custom |
| `strategic-risk` | `risk:scores:sebuf:v1` | `*/5 * * * *` | custom |
| `predictions` | `relay:predictions:v1` | `1-59/5 * * * *` | custom |
| `news:full` | `news:digest:v1:full:en` | `*/5 * * * *` | custom |
| `news:tech` | `news:digest:v1:tech:en` | `1-59/5 * * * *` | custom |
| `news:finance` | `news:digest:v1:finance:en` | `2-59/5 * * * *` | custom |
| `news:happy` | `news:digest:v1:happy:en` | `3-59/5 * * * *` | custom |
| `supply-chain` | `supply_chain:chokepoints:v1` | `2-59/10 * * * *` | custom |
| `strategic-posture` | `theater-posture:sebuf:v1` | `3-59/10 * * * *` | custom |
| `pizzint` | `intel:pizzint:v1` | `4-59/10 * * * *` | custom |
| `iran-events` | `conflict:iran-events:v1` | `*/10 * * * *` | custom |
| `weather` | `relay:weather:v1` | `*/10 * * * *` | custom |
| `gps-interference` | `relay:gps-interference:v1` | `*/5 * * * *` | custom |
| `cables` | `relay:cables:v1` | `*/15 * * * *` | custom |
| `cyber` | `relay:cyber:v1` | `5-59/10 * * * *` | custom |
| `service-status` | `relay:service-status:v1` | `*/5 * * * *` | custom |
| `trade` | `relay:trade:v1` | `*/15 * * * *` | custom |
| `fred` | `relay:fred:v1` | `*/30 * * * *` | custom |
| `oil` | `relay:oil:v1` | `1-59/30 * * * *` | custom |
| `conflict` | `relay:conflict:v1` | `*/30 * * * *` | custom |
| `natural` | `relay:natural:v1` | `2-59/30 * * * *` | custom |
| `eonet` | `relay:eonet:v1` | `*/30 * * * *` | custom |
| `gdacs` | `relay:gdacs:v1` | `*/30 * * * *` | custom |
| `oref` | `relay:oref:v1` | `*/5 * * * *` | custom |
| `opensky` | `relay:opensky:v1` | `*/1 * * * *` | custom |
| `gdelt` | `relay:gdelt:v1` | `*/15 * * * *` | custom |
| `youtube-live` | `relay:youtube-live:v1` | `*/5 * * * *` | custom |
| `bis` | `relay:bis:v1` | `0 * * * *` | custom |
| `flights` | `relay:flights:v1` | `5 * * * *` | custom |
| `aviation-precache` | N/A | `0 0 * * *` | custom |
| `giving` | `giving:summary:v1` | `0 0 * * *` | custom |
| `climate` | `relay:climate:v1` | `0 */6 * * *` | custom |
| `ucdp-events` | `conflict:ucdp-events:v1` | `0 */6 * * *` | custom |
| `worldbank` | `relay:worldbank:v1` | `0 */6 * * *` | simple_http |
| `security-advisories` | `relay:security-advisories:v1` | `*/30 * * * *` | simple_rss |
| `gulf-quotes` | `relay:gulf-quotes:v1` | `*/10 * * * *` | custom |
| `tech-events` | `relay:tech-events:v1` | `*/10 * * * *` | custom |
| `spending` | `relay:spending:v1` | `*/10 * * * *` | custom |

### AI Engine Channels (dedicated ai-engine service)

| AI Function | Redis Key | Cron |
|---|---|---|
| `ai:intel-digest` | `ai:digest:global:v1` | `*/10 * * * *` |
| `ai:panel-summary` | `ai:panel-summary:v1` | `*/15 * * * *` |
| `ai:article-summaries` | `ai:article-summaries:v1` | `2-59/5 * * * *` |
| `ai:classifications` | `ai:classifications:v1` | (part of article-summaries) |
| `ai:country-briefs` | `ai:country-briefs:v1` | `*/30 * * * *` |
| `ai:posture-analysis` | `ai:posture-analysis:v1` | `3-59/15 * * * *` |
| `ai:instability-analysis` | `ai:instability-analysis:v1` | `5-59/30 * * * *` |
| `ai:risk-overview` | `ai:risk-overview:v1` | `4-59/15 * * * *` |

### Dedicated Always-On Services

| Service | Redis Key | Reason |
|---|---|---|
| `ais-processor` | `relay:ais-snapshot:v1` | Persistent WebSocket to aisstream.io, in-memory vessel state |
| `ingest-telegram` | `relay:telegram:v1` | Persistent Telegram session, in-memory message buffer |

### Orchestrator-Managed Config Channels

| Channel | Redis Key | Cron |
|---|---|---|
| `config:news-sources` | `relay:config:news-sources` | `*/5 * * * *` |
| `config:feature-flags` | `relay:config:feature-flags` | `*/5 * * * *` |

### Gateway Channel Mappings

The gateway maintains these mappings (carried over from the monolith):

- `PHASE4_CHANNEL_KEYS` — maps channel name → Redis key (48 entries)
- `CHANNEL_TO_HYDRATION_KEY` — maps channel name → frontend hydration key (29 entries)
- `PHASE4_MAP_KEYS` — maps channel name → Redis key for `/map` endpoint (5 entries)
- `intelligence` is a backward-compatible alias for `ai:intel-digest`

---

## Supabase Tables

### `wm_admin.service_config`

```sql
CREATE TABLE IF NOT EXISTS wm_admin.service_config (
  service_key              TEXT PRIMARY KEY,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  cron_schedule            TEXT NOT NULL,
  timeout_ms               INTEGER NOT NULL DEFAULT 30000,
  redis_key                TEXT NOT NULL,
  ttl_seconds              INTEGER NOT NULL DEFAULT 600,
  fetch_type               TEXT NOT NULL DEFAULT 'custom',  -- 'custom' | 'simple_http' | 'simple_rss'
  settings                 JSONB NOT NULL DEFAULT '{}',
  last_run_at              TIMESTAMPTZ,
  last_duration_ms         INTEGER,
  last_status              TEXT,
  last_error               TEXT,
  consecutive_failures     INTEGER NOT NULL DEFAULT 0,
  max_consecutive_failures INTEGER NOT NULL DEFAULT 5,
  alert_on_failure         BOOLEAN NOT NULL DEFAULT true,
  description              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `wm_admin.trigger_requests`

```sql
CREATE TABLE IF NOT EXISTS wm_admin.trigger_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key     TEXT NOT NULL REFERENCES wm_admin.service_config(service_key),
  requested_by    UUID REFERENCES auth.users(id),
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'completed' | 'failed'
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
```

The orchestrator subscribes to Realtime on `trigger_requests` inserts with `status = 'pending'`.

---

## Adding a New Data Feed

### Simple feed (config-driven, zero code)

1. Insert a row into `service_config`:

```sql
INSERT INTO wm_admin.service_config
  (service_key, cron_schedule, redis_key, ttl_seconds, fetch_type, settings, description)
VALUES
  ('channel-my-feed', '*/15 * * * *', 'relay:my-feed:v1', 900, 'simple_http',
   '{"url": "https://api.example.com/data", "headers": {}, "response_format": "json"}',
   'My new data feed');
```

2. Done — next cron tick, a generic worker fetches it.

### Complex feed (code function)

1. Write a channel function in `shared/channels/my-feed.cjs`:

```javascript
'use strict';
module.exports = async function fetchMyFeed({ config, redis, log, http }) {
  const resp = await http.fetchJson('https://api.example.com/complex', {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  const transformed = resp.data.items.map(item => ({
    id: item.id,
    title: item.name,
    value: item.metrics.score,
  }));
  return { ok: true, data: transformed };
};
```

2. Push to git → CI/CD auto-builds worker image → Watchtower auto-updates workers
3. Insert a row into `service_config` with `fetch_type: 'custom'`
4. Done — no new containers needed.

---

## Migration Strategy

### Per-Channel Shadow → Canary → Switch

```
1. SHADOW  — new channel function writes to shadow Redis key (e.g., relay:fred:v2)
             compare output with monolith's relay:fred:v1
             monolith still serves clients

2. CANARY  — gateway reads from new key for 10% of requests
             monitor for errors/differences

3. SWITCH  — gateway reads from new key for 100%
             disable channel cron in monolith

4. CLEANUP — remove old code from monolith
```

### Extraction Order (critical/high-frequency first)

1. `markets` — most visible, every 5min
2. `news:*` — 4 variants, high visibility
3. `oref` — safety-critical (siren alerts)
4. `strategic-risk`, `strategic-posture` — key dashboard panels
5. All remaining channel functions
6. Dedicated services (ais-processor, ingest-telegram, ai-engine) last

---

## Phase Plan

| Phase | What Ships | New Containers |
|-------|-----------|---------------|
| **0** | Shared library + proto definitions | — |
| **1** | Docker infrastructure + Splunk logging driver | Redis, Watchtower |
| **2** | Orchestrator + Supabase tables | + Orchestrator |
| **3** | Gateway (HTTP + WS + gRPC) | + Gateway |
| **4** | ~38 channel functions (shadow → switch per channel) | + 3-4 Generic Workers |
| **5** | 3 dedicated services (ais-processor, telegram, ai-engine) | + 3 dedicated |
| **6** | Frontend migration (remove all proxies/polling) | — |
| **7** | Observability (Splunk dashboards, alerting) | — |
| **8** | relay-ctl CLI (Supabase wrapper) | — |
| **9** | Networking + secrets (Cloudflare Tunnel, isolation) | + cloudflared |
| **10** | Admin portal Relay Services page | — |

---

## Testing Strategy

| Phase | Tests |
|-------|-------|
| **0** | Unit tests: logger, redis client, config loader, worker-runner, proto compilation |
| **1** | Smoke test: `docker compose up` → all services reach healthy state |
| **2** | Integration: Supabase Realtime subscription, cron scheduling, gRPC trigger dispatch, alert webhook |
| **3** | HTTP endpoint smoke tests, WS subscribe/push, gRPC broadcast integration |
| **4** | Per-channel: shadow phase output comparison (structure, fields, freshness) |
| **5** | Integration tests per dedicated service, LLM mock tests for ai-engine |
| **6** | E2E: frontend loads with zero proxy calls (DevTools network verification) |
| **7** | Verify logs in Splunk, alert webhook fires on simulated failures |
| **8** | CLI smoke tests against dev Supabase |
| **9** | No ports exposed on host, tunnel routing, secrets accessible |
| **10** | Admin page functional tests |

---

## Network Architecture (Final)

```
                        Internet
                           │
                    Cloudflare Edge
                    (TLS, DDoS, WAF)
                           │
                      relay.5ls.us
                           │
                    ┌──────┴──────┐
                    │ cloudflared  │
                    │ (outbound   │
                    │  tunnel)    │
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │   gateway   │
                    │   :3004     │
                    │  HTTP + WS  │
                    │  gRPC :50051│
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────────┐
         │            internal network            │
         │                                        │
         │  orchestrator  (gRPC client only)      │
         │  worker ×3-4   (gRPC server :50052)    │
         │  ais-processor (gRPC client → gateway) │
         │  ingest-telegram (gRPC client → gw)    │
         │  ai-engine     (gRPC server :50053)    │
         │  redis :6379   (cache only)            │
         │  watchtower    (auto-update)           │
         └────────────────────────────────────────┘

Host firewall: ALL inbound ports CLOSED

Admin flow:
  Admin portal (Vercel) → Supabase → service_config / trigger_requests
  Orchestrator subscribes via Supabase Realtime
```

---

## Dependency on Other Plans

- `2026-03-06-scripts-fixes.plan.md` — bug fixes should land FIRST
- `2026-03-06-demand-driven-ais.plan.md` — AIS demand-driven behavior is preserved in ais-processor
- `2026-03-06-src-code-review-fixes.md` — frontend fixes are independent but frontend migration (Phase 6) should come after

---

## Verification Checklist

1. **Orchestrator triggers services on schedule** — check `service_config.last_run_at` in Supabase
2. **Gateway serves cached data** — `curl https://relay.5ls.us/panel/markets | jq .`
3. **WebSocket push works** — `wscat -c wss://relay.5ls.us -x '{"type":"wm-subscribe","channels":["markets"]}'`
4. **Frontend loads with no proxy calls** — DevTools Network tab shows zero `/opensky`, `/rss`, `/polymarket`, `/gdelt` calls
5. **Manual trigger works** — insert into `trigger_requests` via admin portal, service executes
6. **Config changes propagate** — change cron in `service_config`, orchestrator picks up via Realtime
7. **Alerting works** — simulate failures, Discord/Slack webhook fires
8. **Auto-deploy works** — push channel function to git, CI builds, watchtower updates workers
9. **Splunk receives logs** — verify structured JSON logs appear in Splunk dashboard
10. **No ports exposed** — `sudo ss -tlnp | grep -E '3004|3005|6379'` returns nothing
