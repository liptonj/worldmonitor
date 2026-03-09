# Redis Diagnosis for Panel Hydration Audit

**Date:** 2026-03-09  
**Task:** Task 7 — Determine which panels have data in Redis (frontend-fixable vs backend-fixable)

---

## 1. Execution Status

| Step | Status | Notes |
|------|--------|-------|
| Step 1: Redis KEYS | ❌ Not run | Docker daemon not running |
| Step 2: Critical keys EXISTS | ❌ Not run | Docker daemon not running |
| Step 3: Orchestrator logs | ❌ Not run | Docker daemon not running |
| Step 4: Worker logs | ❌ Not run | Docker daemon not running |
| Step 5: AI engine logs | ❌ Not run | Docker daemon not running |

**Error:** `Cannot connect to the Docker daemon at unix:///Users/jolipton/.docker/run/docker.sock. Is the docker daemon running?`

**Action required:** Start Docker Desktop (or equivalent), then re-run the diagnostic commands below to populate this report with actual data.

---

## 2. Redis Keys by Panel

Keys are grouped by the panels they feed. Source: `src/config/channel-registry.ts`, `services/gateway/channel-keys.json`.

### 2.1 Critical Keys (Task 7 spec)

| Redis Key | Panel(s) | Has Data |
|-----------|----------|----------|
| `market:dashboard:v1` | Markets, Commodities, Crypto, Heatmap | ⏳ Unknown |
| `relay:conflict:v1` | CII, Intel, Map | ⏳ Unknown |
| `risk:scores:sebuf:v1` | Strategic Risk, CII | ⏳ Unknown |
| `theater-posture:sebuf:v1` | Strategic Posture | ⏳ Unknown |
| `ai:panel-summary:v1` | AI Insights | ⏳ Unknown |
| `news:digest:v1:full:en` | Live News, Headlines | ⏳ Unknown |
| `relay:predictions:v1` | Predictions (Polymarket) | ⏳ Unknown |
| `relay:telegram:v1` | Telegram Intel | ⏳ Unknown |
| `relay:fred:v1` | Commodities, Economic | ⏳ Unknown |
| `relay:oil:v1` | Commodities | ⏳ Unknown |
| `relay:bis:v1` | Commodities, Economic | ⏳ Unknown |

### 2.2 Full Key Registry (grouped by panel)

| Panel | Channel | Redis Key | Has Data |
|-------|---------|-----------|----------|
| **Markets** | markets | market:dashboard:v1 | ⏳ |
| **Commodities** | markets, fred, oil, bis | market:dashboard:v1, relay:fred:v1, relay:oil:v1, relay:bis:v1 | ⏳ |
| **Crypto** | markets | market:dashboard:v1 | ⏳ |
| **Heatmap** | markets | market:dashboard:v1 | ⏳ |
| **Predictions** | predictions | relay:predictions:v1 | ⏳ |
| **Strategic Posture** | strategic-posture | theater-posture:sebuf:v1 | ⏳ |
| **Strategic Risk** | strategic-risk | risk:scores:sebuf:v1 | ⏳ |
| **CII** | conflict, strategic-risk, ai:country-briefs | relay:conflict:v1, risk:scores:sebuf:v1, ai:country-briefs:v1 | ⏳ |
| **Telegram Intel** | telegram | relay:telegram:v1 | ⏳ |
| **AI Insights** | ai:panel-summary | ai:panel-summary:v1 | ⏳ |
| **Headlines / Live News** | news:full | news:digest:v1:full:en | ⏳ |
| **GDELT Intel** | gdelt | relay:gdelt:v1 | ⏳ |
| **Global Digest** | intelligence, ai:intel-digest | ai:digest:global:v1 | ⏳ |
| **Gulf Economies** | gulf-quotes | relay:gulf-quotes:v1 | ⏳ |
| **Stablecoins** | stablecoins | relay:stablecoins:v1 | ⏳ |
| **ETF Flows** | etf-flows | relay:etf-flows:v1 | ⏳ |
| **Macro Signals** | macro-signals | economic:macro-signals:v1 | ⏳ |
| **Trade Policy** | trade | relay:trade:v1 | ⏳ |
| **Supply Chain** | supply-chain | supply_chain:chokepoints:v1 | ⏳ |
| **OREF Sirens** | oref | relay:oref:v1 | ⏳ |
| **UCDP Events** | ucdp-events | conflict:ucdp-events:v1 | ⏳ |
| **Climate** | climate | relay:climate:v1 | ⏳ |
| **Giving** | giving | giving:summary:v1 | ⏳ |
| **Map** | flights, weather, natural, cables, cyber, conflict, etc. | relay:flights:v1, relay:weather:v1, relay:natural:v1, etc. | ⏳ |
| **Cascade** | cables, cyber, supply-chain | relay:cables:v1, relay:cyber:v1, supply_chain:chokepoints:v1 | ⏳ |
| **Service Status** | service-status | relay:service-status:v1 | ⏳ |

---

## 3. Panel Data Status Summary

| Status | Meaning |
|--------|---------|
| ✅ | Key exists in Redis — frontend Tasks 1–6 can fix panel |
| ❌ | Key missing — backend/worker fix required first |
| ⏳ | Unknown — re-run diagnostics with Docker |

**Current:** All entries are ⏳ because diagnostics could not run.

---

## 4. Orchestrator / Worker / AI Engine Health

| Service | Status | Notes |
|---------|--------|-------|
| Orchestrator | ⏳ N/A | Docker not running |
| Worker | ⏳ N/A | Docker not running |
| AI engine | ⏳ N/A | Docker not running |

---

## 5. Conclusion

**Diagnostics could not be executed** because the Docker daemon was not running. No Redis keys, orchestrator schedules, or worker logs were inspected.

**Next steps:**
1. Start Docker Desktop.
2. Run `cd services && docker-compose up -d` to bring up Redis, orchestrator, worker, and ai-engine.
3. Re-run the diagnostic commands in Section 6.
4. Update this document with actual ✅/❌ results.
5. Proceed with frontend Tasks 1–6 only for panels whose Redis keys show ✅.

---

## 6. Re-run Instructions

Copy and run these commands when Docker is available:

```bash
# Step 1: List all Redis keys
cd services && docker-compose exec -T redis redis-cli KEYS '*' | sort

# Step 2: Check critical keys (output: 11 integers, 1=exists 0=missing)
cd services && docker-compose exec -T redis redis-cli EXISTS \
  "market:dashboard:v1" \
  "relay:conflict:v1" \
  "risk:scores:sebuf:v1" \
  "theater-posture:sebuf:v1" \
  "ai:panel-summary:v1" \
  "news:digest:v1:full:en" \
  "relay:predictions:v1" \
  "relay:telegram:v1" \
  "relay:fred:v1" \
  "relay:oil:v1" \
  "relay:bis:v1"

# Step 3: Orchestrator logs
cd services && docker-compose logs orchestrator 2>&1 | tail -50

# Step 4: Worker logs
cd services && docker-compose logs worker 2>&1 | tail -100

# Step 5: AI engine logs
cd services && docker-compose logs ai-engine 2>&1 | tail -50
```

**Alternative:** Use the existing script from the project root:
```bash
./scripts/check-redis-data.sh
```

---

## 7. Reference: Key → Panel Mapping

From `docs/plans/2026-03-09-panel-hydration-audit.md`:

- **Category B (frontend-fixable):** Panels with data in Redis but bootstrap not consumed — Tasks 1–6 fix these.
- **Category E (backend-fixable):** Panels with no Redis data — workers/AI engine must run first.

This diagnosis determines which panels fall into which category.
