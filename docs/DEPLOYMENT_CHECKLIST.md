# Deployment Checklist — Panel Data Flow Fixes

> **Date:** 2026-03-09  
> **Related:** [PANEL_DATA_FLOW_FIXES_SUMMARY.md](PANEL_DATA_FLOW_FIXES_SUMMARY.md) | [plans/2026-03-09-fix-all-panel-data-flows.md](plans/2026-03-09-fix-all-panel-data-flows.md)

Use this checklist when deploying the panel data flow fixes. Complete steps in order.

---

## Prerequisites

- [ ] Git working tree clean or changes committed
- [ ] Node.js and npm available
- [ ] Docker and Docker Compose available (for local/services)
- [ ] Supabase CLI installed (if applying migrations)
- [ ] Access to production/staging Supabase project (if applicable)
- [ ] Access to gateway and orchestrator deployment targets

---

## Step-by-Step Deployment Order

### Step 1: Database Migration

**Purpose:** Ensure `wm_admin.service_config` has all required worker schedules (gdelt, strategic-risk, strategic-posture, ai:panel-summary, ai:intel-digest, etc.).

**Commands:**
```bash
# From repo root
supabase db push
# OR for specific migration:
supabase migration up
```

**Verification:**
```bash
# Connect to Supabase and verify service_config has gdelt, strategic-risk, etc.
supabase db execute "SELECT service_key, redis_key FROM wm_admin.service_config WHERE service_key IN ('gdelt','strategic-risk','strategic-posture','ai:panel-summary','ai:intel-digest')"
```

**Expected:** Rows returned for each service_key with correct redis_key.

---

### Step 2: Regenerate Channel Keys

**Purpose:** Ensure `services/gateway/channel-keys.json` includes all channels (especially `gdelt`).

**Commands:**
```bash
npm run generate:channel-keys
```

**Verification:**
```bash
grep '"gdelt"' services/gateway/channel-keys.json
```

**Expected:** `"gdelt": "relay:gdelt:v1"` present in output.

---

### Step 3: Build Frontend

**Purpose:** Compile TypeScript and produce deployable assets.

**Commands:**
```bash
npm run build
```

**Verification:**
```bash
# No build errors; dist/ or build/ populated
ls -la dist/ 2>/dev/null || ls -la build/ 2>/dev/null
```

**Expected:** Build completes with exit code 0; output directory contains index.html and assets.

---

### Step 4: Restart Gateway

**Purpose:** Gateway loads `channel-keys.json` at startup; must restart to pick up new channels.

**Commands:**
```bash
cd services && docker compose restart gateway
```

**Verification:**
```bash
curl -s http://localhost:3004/health | jq .
curl -s http://localhost:3004/panel/gdelt | head -c 200
```

**Expected:**
- `/health` → `{"status":"ok",...}`
- `/panel/gdelt` → 200 with JSON (or `{"status":"pending"}` if no data yet)

---

### Step 5: Restart Orchestrator

**Purpose:** Orchestrator schedules workers from `service_config`; restart ensures it picks up any config changes.

**Commands:**
```bash
cd services && docker compose restart orchestrator
```

**Verification:**
```bash
cd services && docker compose logs orchestrator --tail 30
```

**Expected:** No repeated errors; logs show job scheduling or execution.

---

### Step 6: Verify Redis Keys (After Workers Run)

**Purpose:** Confirm workers are publishing to Redis.

**Commands:**
```bash
cd services && docker compose exec -T redis redis-cli KEYS "relay:gdelt:v1"
cd services && docker compose exec -T redis redis-cli KEYS "risk:scores:sebuf:v1"
cd services && docker compose exec -T redis redis-cli KEYS "theater-posture:sebuf:v1"
cd services && docker compose exec -T redis redis-cli KEYS "ai:panel-summary:v1"
cd services && docker compose exec -T redis redis-cli KEYS "ai:digest:global:v1"
```

**Expected:** Keys exist (workers run on cron; may take 1–15 minutes depending on schedule).

---

### Step 7: Run Full Validation Script

**Purpose:** End-to-end validation of data flow.

**Commands:**
```bash
bash scripts/validate-data-flow.sh
# Or skip WebSocket test:
bash scripts/validate-data-flow.sh --quick
```

**Expected:** All checks pass (Redis keys, gateway HTTP, optional WebSocket).

---

### Step 8: Deploy Frontend

**Purpose:** Deploy built assets to Vercel, Cloudflare Pages, or other host.

**Commands:** (Environment-specific)
```bash
# Example: Vercel
vercel --prod

# Example: Cloudflare Pages
npx wrangler pages deploy dist
```

**Verification:**
- Open deployed URL
- Open browser DevTools → Network → filter WS
- Confirm WebSocket connects and receives `wm-push` messages
- Check Console for no 404 errors

---

## Services That Need Restarting

| Service | When to Restart | Reason |
|---------|-----------------|--------|
| **gateway** | After `channel-keys.json` changes | Loads channel mapping at startup |
| **orchestrator** | After `service_config` changes | Schedules workers from DB |
| **worker** | Only if worker code changed | Executes fetch jobs |
| **ai-engine** | Only if AI engine code changed | Produces ai:panel-summary, etc. |
| **redis** | Only if Redis config changed | Rare |

**Minimum for this deployment:** `gateway`, `orchestrator`.

---

## Verification Commands Summary

| Check | Command | Success |
|-------|---------|---------|
| Services up | `docker compose ps` | redis, gateway, orchestrator Up |
| Gateway health | `curl -s http://localhost:3004/health` | `{"status":"ok"}` |
| GDELT panel | `curl -s http://localhost:3004/panel/gdelt` | 200 + JSON |
| Bootstrap | `curl -s "http://localhost:3004/bootstrap?variant=full&channels=gdelt,intelligence"` | 200 + JSON |
| Redis gdelt | `redis-cli GET relay:gdelt:v1` | JSON string (or empty if no data yet) |
| Full validation | `bash scripts/validate-data-flow.sh` | All checks pass |

---

## Success Criteria Checklist (from Plan)

After deployment, verify:

- [ ] No 404 errors in browser console
- [ ] GDELT panel shows articles or "No recent articles" (not loading forever)
- [ ] Strategic Risk panel shows data or "No data available" (not "Insufficient Data")
- [ ] AI Insights panel shows summary or "Generating..." (not stuck loading)
- [ ] Strategic Posture panel shows posture data or "No posture data" (not "Acquiring Data")
- [ ] Intel Feed panel shows items or "No intel available" (not "All Intel sources disabled")
- [ ] World News panel shows articles
- [ ] WebSocket receives `wm-push` messages for multiple channels
- [ ] All enabled panels transition out of loading state within 30 seconds

---

## Troubleshooting

| Issue | Action |
|-------|--------|
| Gateway 404 for `/panel/gdelt` | Regenerate `channel-keys.json`; restart gateway |
| No Redis keys for channel | Check orchestrator logs; verify `service_config` has correct `redis_key` |
| Panel stuck "Loading..." | Check browser console; verify channel in `wm-subscribe`; test `/panel/:channel` |
| "All Intel sources disabled" | Verify `ai:digest:global:v1` in Redis; ensure `intelligence` in subscription list |

See [DATA_FLOW_VALIDATION.md](DATA_FLOW_VALIDATION.md) for detailed troubleshooting.
