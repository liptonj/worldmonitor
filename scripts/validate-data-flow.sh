#!/usr/bin/env bash
# validate-data-flow.sh — Verify data flow: Worker → Redis → Gateway → WebSocket → Frontend
#
# Run from repo root:
#   bash scripts/validate-data-flow.sh
#   bash scripts/validate-data-flow.sh --quick   # Skip WebSocket test
#   bash scripts/validate-data-flow.sh --local  # Use local Redis (not Docker)
#
# The script will:
#   1. Check if services are running (Docker)
#   2. List Redis keys matching relay/ai/theater/risk patterns
#   3. Show key TTLs and sample values
#   4. Check gateway HTTP connectivity (/health, /panel/:channel)
#   5. Optionally test WebSocket connection (wscat if available)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICES_DIR="${ROOT_DIR}/services"
GATEWAY_PORT="${GATEWAY_PORT:-3004}"
GATEWAY_HOST="${GATEWAY_HOST:-localhost}"
QUICK=false
USE_DOCKER=true

log()  { echo "[validate] $*"; }
warn() { echo "[validate] WARN: $*" >&2; }
ok()   { echo "[validate] ✓ $*"; }
fail() { echo "[validate] ✗ $*" >&2; }

for arg in "$@"; do
  case "${arg}" in
    --quick) QUICK=true ;;
    --local) USE_DOCKER=false ;;
    -h|--help)
      cat <<'EOF'
Usage:
  bash scripts/validate-data-flow.sh [--quick] [--local]

Options:
  --quick   Skip WebSocket test (faster)
  --local   Use local redis-cli instead of Docker (services may still be Docker)

Environment:
  GATEWAY_PORT   Gateway HTTP port (default: 3004)
  GATEWAY_HOST   Gateway host (default: localhost)
EOF
      exit 0
      ;;
  esac
done

cd "${ROOT_DIR}"
PASS=0
FAIL=0

# ── Redis CLI helper ─────────────────────────────────────────────────────────
# Prefer docker compose (v2 plugin), fall back to docker-compose
docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "${SERVICES_DIR}/docker-compose.yml" "$@"
  else
    docker-compose -f "${SERVICES_DIR}/docker-compose.yml" "$@"
  fi
}

redis_cmd() {
  if [[ "${USE_DOCKER}" == "true" ]]; then
    docker_compose exec -T redis redis-cli "$@"
  else
    redis-cli "$@"
  fi
}

# ── 1. Check services running ────────────────────────────────────────────────
log "1. Checking services..."
if [[ "${USE_DOCKER}" == "true" ]]; then
  if docker_compose ps 2>/dev/null | grep -qE "redis|gateway|orchestrator"; then
    ok "Docker services running"
    ((PASS++)) || true
  else
    fail "Docker services not running. Start with: cd services && docker compose up -d"
    ((FAIL++)) || true
  fi
else
  if redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "Local Redis responding"
    ((PASS++)) || true
  else
    fail "Local Redis not responding (redis-cli ping)"
    ((FAIL++)) || true
  fi
fi

# ── 2. Redis keys (relay/ai/theater/risk patterns) ───────────────────────────
log ""
log "2. Redis keys (relay:* ai:* theater-posture:* risk:*)..."

KEY_PATTERNS=("relay:*" "ai:*" "theater-posture:*" "risk:*")
ALL_KEYS=()
for pat in "${KEY_PATTERNS[@]}"; do
  if keys=$(redis_cmd KEYS "${pat}" 2>/dev/null); then
    while IFS= read -r k; do
      [[ -n "$k" ]] && ALL_KEYS+=("$k")
    done <<< "$keys"
  fi
done

if [[ ${#ALL_KEYS[@]} -eq 0 ]]; then
  warn "No keys found matching relay/ai/theater/risk patterns"
  ((FAIL++)) || true
else
  ok "Found ${#ALL_KEYS[@]} keys"
  ((PASS++)) || true
  echo ""
  printf "  %-40s %8s %6s\n" "KEY" "TTL" "SIZE"
  printf "  %-40s %8s %6s\n" "---" "---" "----"
  count=0
  for k in "${ALL_KEYS[@]}"; do
    [[ $count -ge 50 ]] && break
    ttl=$(redis_cmd TTL "$k" 2>/dev/null || echo "-")
    size=$(redis_cmd STRLEN "$k" 2>/dev/null || echo "0")
    printf "  %-40s %8s %6s\n" "$k" "$ttl" "$size"
    ((count++)) || true
  done
  [[ ${#ALL_KEYS[@]} -gt 50 ]] && echo "  ... and $(( ${#ALL_KEYS[@]} - 50 )) more"
fi

# ── 3. Key TTLs for critical channels ───────────────────────────────────────
log ""
log "3. TTLs for critical panel channels..."

CRITICAL_KEYS=(
  "relay:ais-snapshot:v1"
  "relay:gdelt:v1"
  "ai:digest:global:v1"
  "ai:panel-summary:v1"
  "risk:scores:sebuf:v1"
  "theater-posture:sebuf:v1"
  "relay:flights:v1"
  "market:dashboard:v1"
)

for k in "${CRITICAL_KEYS[@]}"; do
  val=$(redis_cmd GET "$k" 2>/dev/null)
  ttl=$(redis_cmd TTL "$k" 2>/dev/null || echo "-2")
  if [[ -n "$val" && "$val" != "(nil)" ]]; then
    len=${#val}
    ok "$k: has data (${len} bytes), TTL=${ttl}"
    ((PASS++)) || true
  else
    warn "$k: no data (TTL=${ttl})"
    ((FAIL++)) || true
  fi
done

# ── 4. Gateway HTTP connectivity ─────────────────────────────────────────────
log ""
log "4. Gateway HTTP connectivity..."

HEALTH_URL="http://${GATEWAY_HOST}:${GATEWAY_PORT}/health"
if curl -sf --max-time 5 "${HEALTH_URL}" > /dev/null 2>&1; then
  ok "GET /health OK"
  ((PASS++)) || true
else
  fail "GET /health failed (${HEALTH_URL})"
  ((FAIL++)) || true
fi

# Test a few panel endpoints
PANEL_CHANNELS=("ais" "gdelt" "intelligence" "strategic-risk" "ai:panel-summary")
for ch in "${PANEL_CHANNELS[@]}"; do
  url="http://${GATEWAY_HOST}:${GATEWAY_PORT}/panel/${ch}"
  status=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "${url}" 2>/dev/null || echo "000")
  if [[ "$status" == "200" ]]; then
    ok "GET /panel/${ch} → 200"
    ((PASS++)) || true
  elif [[ "$status" == "404" ]]; then
    warn "GET /panel/${ch} → 404 (channel not in gateway)"
    ((FAIL++)) || true
  else
    warn "GET /panel/${ch} → ${status}"
    ((FAIL++)) || true
  fi
done

# ── 5. WebSocket test (optional) ─────────────────────────────────────────────
if [[ "${QUICK}" != "true" ]]; then
  log ""
  log "5. WebSocket connection test..."

  WS_URL="ws://${GATEWAY_HOST}:${GATEWAY_PORT}"
  if command -v wscat > /dev/null 2>&1; then
    # wscat -c URL -x 'message' sends message after connect; --no-check disables TLS verify
    timeout 5 wscat -c "${WS_URL}" -x '{"type":"wm-subscribe","channels":["ais","gdelt"]}' 2>/dev/null | head -5 &
    WSPID=$!
    sleep 3
    if kill -0 "$WSPID" 2>/dev/null; then
      ok "WebSocket connected and subscribe accepted"
      kill "$WSPID" 2>/dev/null || true
      ((PASS++)) || true
    else
      warn "WebSocket test inconclusive (wscat may have exited)"
    fi
    wait "$WSPID" 2>/dev/null || true
  else
    warn "wscat not installed — skip WebSocket test. Install: npm i -g wscat"
    echo "  Manual test: Open browser DevTools → Network → WS, connect to ${WS_URL}"
    echo "  Send: {\"type\":\"wm-subscribe\",\"channels\":[\"ais\",\"gdelt\"]}"
    echo "  Expect: wm-push messages when data updates"
  fi
else
  log ""
  log "5. WebSocket test skipped (--quick)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
log ""
log "════════════════════════════════════════"
log "  Validation summary: ${PASS} passed, ${FAIL} failed"
log "════════════════════════════════════════"

if [[ ${FAIL} -gt 0 ]]; then
  log ""
  log "See docs/DATA_FLOW_VALIDATION.md for troubleshooting."
  exit 1
fi

exit 0
