#!/usr/bin/env bash
# update-relay.sh — Verify env, pull latest code, and restart relay process
#
# Run this on the relay host after deploying a new version:
#   bash scripts/update-relay.sh
#   bash scripts/update-relay.sh --verify-only
#
# The script will:
#   1. Check required .env values and prompt for any that are missing
#   2. Validate env values used by scripts/ais-relay.cjs
#   3. Pull latest code and restart relay process (unless --verify-only)
#
# Environment:
#   RELAY_PROCESS_NAME   pm2 process name (default: worldmonitor-relay)
#   RELAY_SERVICE_NAME   systemd service name (default: worldmonitor-relay)
#   RELAY_MANAGER        Force process manager: "pm2" | "systemd" | "none"
#
# Flags:
#   --verify-only        Validate env and exit (no pull/restart)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

RELAY_PROCESS_NAME="${RELAY_PROCESS_NAME:-worldmonitor-relay}"
RELAY_SERVICE_NAME="${RELAY_SERVICE_NAME:-worldmonitor-relay}"
VERIFY_ONLY=false
VALIDATION_ERRORS=0

log()  { echo "[update-relay] $*"; }
warn() { echo "[update-relay] WARN: $*" >&2; }
die()  { echo "[update-relay] ERROR: $*" >&2; exit 1; }
fail() { echo "[update-relay] ERROR: $*" >&2; VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1)); }

CLEANUP_SRH=false
for arg in "$@"; do
  case "${arg}" in
    --verify-only) VERIFY_ONLY=true ;;
    --cleanup-srh) CLEANUP_SRH=true ;;
    -h|--help)
      cat <<'EOF'
Usage:
  bash scripts/update-relay.sh [--verify-only] [--cleanup-srh]

Options:
  --verify-only   Validate relay env settings and exit without pull/restart.
  --cleanup-srh   Stop and remove SRH Docker container if present (Phase 6 cleanup).
EOF
      exit 0
      ;;
    *)
      die "Unknown argument: ${arg}"
      ;;
  esac
done

# env_get KEY — read current value from .env (empty string if missing/unset)
env_get() {
  local key="$1"
  if [[ -f "${ENV_FILE}" ]]; then
    awk -F= -v k="${key}" '$1==k{v=substr($0,index($0,"=")+1)} END{print v}' "${ENV_FILE}" || true
  fi
}

# env_set KEY VALUE — upsert a KEY=VALUE line in .env
env_set() {
  local key="$1" value="$2"
  if [[ -f "${ENV_FILE}" ]] && awk -F= -v k="${key}" '$1==k{found=1} END{exit !found}' "${ENV_FILE}"; then
    # Replace existing line (portable sed in-place)
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}" && rm -f "${ENV_FILE}.bak"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
  log ".env updated: ${key}=<set>"
}

# prompt_env KEY DESCRIPTION — prompt user if value is missing, then upsert
prompt_env() {
  local key="$1" description="$2"
  local current
  current="$(env_get "${key}")"
  if [[ -n "${current}" ]]; then
    log "${key} already set — skipping."
    return
  fi
  echo ""
  echo "  Required: ${key}"
  echo "  ${description}"
  read -r -p "  Enter value: " input_value
  if [[ -z "${input_value}" ]]; then
    die "${key} cannot be empty."
  fi
  env_set "${key}" "${input_value}"
}

is_strong_secret() {
  local value="$1"
  [[ "${#value}" -ge 24 ]]
}

validate_required_env() {
  local key="$1" label="$2"
  local value
  value="$(env_get "${key}")"
  if [[ -z "${value}" ]]; then
    fail "${label} (${key}) is missing."
    return
  fi
  log "${key} is set."
}

validate_conditional_pair() {
  local key_a="$1" key_b="$2" label="$3"
  local a b
  a="$(env_get "${key_a}")"
  b="$(env_get "${key_b}")"
  if [[ -n "${a}" && -z "${b}" ]]; then
    fail "${label}: ${key_b} missing while ${key_a} is set."
  elif [[ -z "${a}" && -n "${b}" ]]; then
    fail "${label}: ${key_a} missing while ${key_b} is set."
  fi
}

validate_numeric_if_set() {
  local key="$1"
  local value
  value="$(env_get "${key}")"
  if [[ -z "${value}" ]]; then
    return
  fi
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    fail "${key} must be an integer when set."
    return
  fi
  log "${key} looks valid."
}

load_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    die ".env file not found at ${ENV_FILE}"
  fi
  # Export all keys from .env into current shell so pm2 --update-env
  # receives them on restart/start.
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  log "Loaded environment from ${ENV_FILE}"
}

# ── 1. Check and validate required .env values ───────────────────────────────
log "Checking required .env values..."
if [[ "${VERIFY_ONLY}" == "false" ]]; then
  prompt_env "AISSTREAM_API_KEY" \
    "AIS upstream API key used by relay WebSocket ingestion."
  prompt_env "RELAY_SHARED_SECRET" \
    "Shared secret between relay and Vercel (must match RELAY_SHARED_SECRET on Vercel)."
  prompt_env "UPSTASH_REDIS_REST_URL" \
    "Upstash Redis REST URL used by warm-and-broadcast."
  prompt_env "UPSTASH_REDIS_REST_TOKEN" \
    "Upstash Redis REST token used by warm-and-broadcast."
fi

# Keep auth header explicit and aligned with relay default.
if [[ "${VERIFY_ONLY}" == "false" && -z "$(env_get RELAY_AUTH_HEADER)" ]]; then
  env_set "RELAY_AUTH_HEADER" "x-relay-key"
fi

log "Running env validation..."
validate_required_env "AISSTREAM_API_KEY" "AIS upstream auth"
validate_required_env "RELAY_SHARED_SECRET" "Relay auth secret"
validate_required_env "UPSTASH_REDIS_REST_URL" "Upstash REST URL"
validate_required_env "UPSTASH_REDIS_REST_TOKEN" "Upstash REST token"

# RELAY_WS_TOKEN: optional separate token for browser WebSocket auth.
# When set, browser clients pass it as ?token= query param.
# When unset, RELAY_SHARED_SECRET is used for WS auth as well.
ws_token="$(env_get RELAY_WS_TOKEN)"
if [[ -n "${ws_token}" ]]; then
  if ! is_strong_secret "${ws_token}"; then
    fail "RELAY_WS_TOKEN should be at least 24 characters."
  else
    log "RELAY_WS_TOKEN is set and valid."
  fi
else
  warn "RELAY_WS_TOKEN not set — browser WS auth will use RELAY_SHARED_SECRET."
  warn "Set RELAY_WS_TOKEN to use a separate browser-safe token (recommended)."
fi

relay_secret="$(env_get RELAY_SHARED_SECRET)"

if [[ -n "${relay_secret}" ]] && ! is_strong_secret "${relay_secret}"; then
  fail "RELAY_SHARED_SECRET should be at least 24 characters."
fi

validate_conditional_pair "OPENSKY_CLIENT_ID" "OPENSKY_CLIENT_SECRET" "OpenSky credentials"
validate_conditional_pair "TELEGRAM_API_ID" "TELEGRAM_API_HASH" "Telegram credentials"
validate_conditional_pair "TELEGRAM_API_ID" "TELEGRAM_SESSION" "Telegram session"

validate_numeric_if_set "PORT"
validate_numeric_if_set "AIS_SNAPSHOT_INTERVAL_MS"
validate_numeric_if_set "AIS_UPSTREAM_QUEUE_HIGH_WATER"
validate_numeric_if_set "AIS_UPSTREAM_QUEUE_LOW_WATER"
validate_numeric_if_set "AIS_UPSTREAM_QUEUE_HARD_CAP"
validate_numeric_if_set "TELEGRAM_POLL_INTERVAL_MS"
validate_numeric_if_set "TELEGRAM_RATE_LIMIT_MS"

# Advisory: browser build envs are configured in Vercel, not relay host.
if [[ -z "$(env_get VITE_WS_RELAY_URL)" ]]; then
  warn "VITE_WS_RELAY_URL not set in local .env (ensure it is set in Vercel build env)."
fi

# REDIS_URL: local Redis for relay direct-fetch cache.
# Defaults to redis://localhost:6379 when not set.
if [[ -z "$(env_get REDIS_URL)" ]]; then
  warn "REDIS_URL not set — using default redis://localhost:6379."
  env_set "REDIS_URL" "redis://localhost:6379"
fi

# Supabase client — required for config:news-sources, config:feature-flags, markets, news channels.
prompt_env "SUPABASE_URL" "Supabase project URL (e.g. https://xxx.supabase.co)" "required"
prompt_env "SUPABASE_ANON_KEY" "Supabase anon key" "required"

# Optional API keys — channels that need them will warn and skip if unset.
prompt_env "ACLED_ACCESS_TOKEN" "ACLED access token (for strategic-risk / iran-events)" "optional"

if [[ "${VALIDATION_ERRORS}" -gt 0 ]]; then
  die "Environment validation failed with ${VALIDATION_ERRORS} error(s)."
fi

log "Environment validation passed."

if [[ "${VERIFY_ONLY}" == "true" ]]; then
  log "--verify-only set; skipping git pull and restart."
  exit 0
fi

# Ensure process manager commands inherit .env values.
load_env_file

# ── 2. Pull latest code ──────────────────────────────────────────────────────
cd "${ROOT_DIR}"

log "Pulling latest code..."
git pull --ff-only || die "git pull failed — resolve conflicts manually and re-run"

log "Installing/updating dependencies..."
npm install --omit=dev || warn "npm install failed — relay may be missing node-cron"

# ── 2b. Sync systemd service file if present ─────────────────────────────────
UNIT_SRC="${SCRIPT_DIR}/worldmonitor-relay.service"
UNIT_DEST="/etc/systemd/system/${RELAY_SERVICE_NAME}.service"

if [[ -f "${UNIT_SRC}" ]]; then
  if ! cmp -s "${UNIT_SRC}" "${UNIT_DEST}" 2>/dev/null; then
    log "Updating systemd unit file..."
    sudo cp "${UNIT_SRC}" "${UNIT_DEST}"
    sudo systemctl daemon-reload
    log "systemd unit file synced and daemon reloaded."
  else
    log "systemd unit file unchanged — skipping."
  fi
fi

# ── 3. Configure local Redis (persistence, memory, eviction) ───────────────────
configure_redis() {
  if ! command -v redis-cli > /dev/null 2>&1; then
    die "redis-cli not found — install redis-tools first (apt install redis-tools or brew install redis)."
  fi

  log "Checking local Redis..."
  if ! redis-cli ping 2>/dev/null | grep -q PONG; then
    die "Redis is not running on localhost:6379 -- install/start Redis first."
  fi

  if [[ -n "${REDIS_URL:-}" && "${REDIS_URL}" != *"localhost"* && "${REDIS_URL}" != *"127.0.0.1"* ]]; then
    warn "REDIS_URL points to a non-local host (${REDIS_URL}) — skipping local Redis configuration."
    return 0
  fi

  log "Setting Redis persistence (RDB + AOF)..."
  redis-cli CONFIG SET save "900 1 300 10 60 10000"
  redis-cli CONFIG SET appendonly yes
  redis-cli CONFIG SET appendfsync everysec

  log "Setting Redis memory cap and eviction policy..."
  redis-cli CONFIG SET maxmemory 1gb
  redis-cli CONFIG SET maxmemory-policy allkeys-lru

  log "Persisting Redis config to disk..."
  redis-cli CONFIG REWRITE || warn "Could not persist Redis config to disk (CONFIG REWRITE failed — changes are in-memory only)."

  log "Redis persistence: $(redis-cli INFO persistence | grep -E 'aof_enabled|rdb_last_save' || true)"
  log "Redis maxmemory: $(redis-cli CONFIG GET maxmemory | tail -1 || true)"
  log "Redis configure done."
}

# ── 3b. Stop and remove SRH Docker container (Phase 6 cleanup) ──────────────────
stop_srh() {
  log "Checking for SRH Docker container..."
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^srh$'; then
    log "Stopping and removing SRH container..."
    docker stop srh 2>/dev/null || true
    docker rm srh 2>/dev/null || true
    log "SRH container removed."
  else
    log "SRH container not found (already removed or never installed)."
  fi
}

# ── 4. Detect process manager and restart ──────────────────────────────────────
restart_pm2() {
  log "Restarting via pm2 (process: ${RELAY_PROCESS_NAME})..."
  if pm2 describe "${RELAY_PROCESS_NAME}" > /dev/null 2>&1; then
    if pm2 restart "${RELAY_PROCESS_NAME}" --update-env --kill-timeout 8000; then
      pm2 save
      log "pm2 restart done."
      return
    fi
    warn "pm2 restart failed for '${RELAY_PROCESS_NAME}' (possibly stale process entry)."
    warn "Cleaning stale pm2 entry and starting relay fresh..."
    pm2 delete "${RELAY_PROCESS_NAME}" > /dev/null 2>&1 || true
    pm2 start "${SCRIPT_DIR}/ais-relay.cjs" \
      --name "${RELAY_PROCESS_NAME}" \
      --interpreter node \
      --restart-delay 3000 \
      --max-restarts 10 \
      --kill-timeout 8000
    pm2 save
    log "pm2 process re-created."
  else
    warn "pm2 process '${RELAY_PROCESS_NAME}' not found — starting it fresh..."
    pm2 start "${SCRIPT_DIR}/ais-relay.cjs" \
      --name "${RELAY_PROCESS_NAME}" \
      --interpreter node \
      --restart-delay 3000 \
      --max-restarts 10 \
      --kill-timeout 8000
    pm2 save
    log "pm2 process started."
  fi
}

restart_systemd() {
  log "Restarting via systemd (service: ${RELAY_SERVICE_NAME})..."

  local relay_port
  relay_port="$(env_get PORT)"
  relay_port="${relay_port:-3004}"

  local stale_pid
  stale_pid="$(sudo lsof -ti ":${relay_port}" 2>/dev/null || true)"
  local service_pid
  service_pid="$(systemctl show -p MainPID --value "${RELAY_SERVICE_NAME}" 2>/dev/null || echo "")"

  if [[ -n "${stale_pid}" && "${stale_pid}" != "${service_pid}" ]]; then
    warn "Port ${relay_port} held by PID ${stale_pid} (not the systemd service) — killing it."
    sudo kill "${stale_pid}" 2>/dev/null || true
    sleep 2
    if sudo lsof -ti ":${relay_port}" > /dev/null 2>&1; then
      warn "PID ${stale_pid} did not exit — sending SIGKILL."
      sudo kill -9 "${stale_pid}" 2>/dev/null || true
      sleep 1
    fi
  fi

  sudo systemctl restart "${RELAY_SERVICE_NAME}"
  sleep 2

  if systemctl is-active --quiet "${RELAY_SERVICE_NAME}"; then
    log "Service is active."
    sudo systemctl status "${RELAY_SERVICE_NAME}" --no-pager -l || true
  else
    warn "Service did not start — check logs with: journalctl -u ${RELAY_SERVICE_NAME} -n 40 --no-pager"
    sudo systemctl status "${RELAY_SERVICE_NAME}" --no-pager -l || true
    return 1
  fi

  log "systemd restart done."
}

restart_none() {
  warn "No process manager detected and RELAY_MANAGER=none."
  warn "Restart the relay manually: node ${SCRIPT_DIR}/ais-relay.cjs"
}

MANAGER="${RELAY_MANAGER:-}"
if [[ -z "${MANAGER}" ]]; then
  if command -v systemctl > /dev/null 2>&1 && systemctl list-units --type=service 2>/dev/null | awk -v svc="${RELAY_SERVICE_NAME}" '$0 ~ svc {found=1} END{exit !found}'; then
    MANAGER="systemd"
  elif command -v pm2 > /dev/null 2>&1; then
    MANAGER="pm2"
  else
    MANAGER="none"
  fi
fi

log "Process manager: ${MANAGER}"

configure_redis

if [[ "${CLEANUP_SRH}" == "true" ]]; then
  stop_srh
fi

case "${MANAGER}" in
  pm2)     restart_pm2 ;;
  systemd)
    svc_env_file="$(systemctl show -p EnvironmentFile --value "${RELAY_SERVICE_NAME}" 2>/dev/null || echo "")"
    if [[ -n "${svc_env_file}" ]]; then
      log "systemd EnvironmentFile: ${svc_env_file}"
    else
      warn "systemd service has no EnvironmentFile — .env changes won't be picked up."
      warn "Add 'EnvironmentFile=${ENV_FILE}' to the [Service] section of the unit file."
    fi
    restart_systemd
    ;;
  none)    restart_none ;;
  *)       die "Unknown RELAY_MANAGER value: '${MANAGER}'. Use pm2, systemd, or none." ;;
esac

log "Relay update complete."
