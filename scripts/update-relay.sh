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

for arg in "$@"; do
  case "${arg}" in
    --verify-only) VERIFY_ONLY=true ;;
    -h|--help)
      cat <<'EOF'
Usage:
  bash scripts/update-relay.sh [--verify-only]

Options:
  --verify-only   Validate relay env settings and exit without pull/restart.
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

is_https_url() {
  local value="$1"
  [[ "${value}" =~ ^https://[^[:space:]]+$ ]]
}

is_valid_warm_host() {
  local value="$1"
  local host
  local allowed_raw allowed_host
  host="$(echo "${value}" | sed -E 's#^https://([^/]+).*$#\1#')"
  allowed_raw="$(env_get RELAY_ALLOWED_WARM_HOSTS)"
  if [[ -z "${allowed_raw}" ]]; then
    allowed_raw="worldmonitor.app,info.5ls.us"
  fi
  IFS=',' read -r -a allowed_hosts <<< "${allowed_raw}"
  for allowed_host in "${allowed_hosts[@]}"; do
    allowed_host="$(echo "${allowed_host}" | awk '{$1=$1};1' | tr '[:upper:]' '[:lower:]')"
    [[ -z "${allowed_host}" ]] && continue
    if [[ "${host}" == "${allowed_host}" || "${host}" == *.${allowed_host} ]]; then
      return 0
    fi
  done
  return 1
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

# ── 1. Check and validate required .env values ───────────────────────────────
log "Checking required .env values..."
if [[ "${VERIFY_ONLY}" == "false" ]]; then
  prompt_env "AISSTREAM_API_KEY" \
    "AIS upstream API key used by relay WebSocket ingestion."
  prompt_env "RELAY_SHARED_SECRET" \
    "Shared secret between relay and Vercel (must match RELAY_SHARED_SECRET on Vercel)."
  prompt_env "VERCEL_APP_URL" \
    "URL of deployment relay warms (e.g. https://worldmonitor.app or https://info.5ls.us)."
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
validate_required_env "VERCEL_APP_URL" "Vercel warm target URL"
validate_required_env "UPSTASH_REDIS_REST_URL" "Upstash REST URL"
validate_required_env "UPSTASH_REDIS_REST_TOKEN" "Upstash REST token"

relay_secret="$(env_get RELAY_SHARED_SECRET)"
vercel_url="$(env_get VERCEL_APP_URL)"

if [[ -n "${relay_secret}" ]] && ! is_strong_secret "${relay_secret}"; then
  fail "RELAY_SHARED_SECRET should be at least 24 characters."
fi

if [[ -n "${vercel_url}" ]]; then
  if ! is_https_url "${vercel_url}"; then
    fail "VERCEL_APP_URL must start with https://"
  elif ! is_valid_warm_host "${vercel_url}"; then
    fail "VERCEL_APP_URL host is not in RELAY_ALLOWED_WARM_HOSTS."
  else
    log "VERCEL_APP_URL format is valid."
  fi
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

if [[ "${VALIDATION_ERRORS}" -gt 0 ]]; then
  die "Environment validation failed with ${VALIDATION_ERRORS} error(s)."
fi

log "Environment validation passed."

if [[ "${VERIFY_ONLY}" == "true" ]]; then
  log "--verify-only set; skipping git pull and restart."
  exit 0
fi

# ── 2. Pull latest code ──────────────────────────────────────────────────────
cd "${ROOT_DIR}"

log "Pulling latest code..."
git pull --ff-only || die "git pull failed — resolve conflicts manually and re-run"

log "Installing/updating dependencies..."
npm install --omit=dev || warn "npm install failed — relay may be missing node-cron"

# ── 3. Detect process manager and restart ────────────────────────────────────
restart_pm2() {
  log "Restarting via pm2 (process: ${RELAY_PROCESS_NAME})..."
  if pm2 describe "${RELAY_PROCESS_NAME}" > /dev/null 2>&1; then
    if pm2 restart "${RELAY_PROCESS_NAME}" --update-env; then
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
      --max-restarts 10
    pm2 save
    log "pm2 process re-created."
  else
    warn "pm2 process '${RELAY_PROCESS_NAME}' not found — starting it fresh..."
    pm2 start "${SCRIPT_DIR}/ais-relay.cjs" \
      --name "${RELAY_PROCESS_NAME}" \
      --interpreter node \
      --restart-delay 3000 \
      --max-restarts 10
    pm2 save
    log "pm2 process started."
  fi
}

restart_systemd() {
  log "Restarting via systemd (service: ${RELAY_SERVICE_NAME})..."
  sudo systemctl restart "${RELAY_SERVICE_NAME}"
  sudo systemctl status "${RELAY_SERVICE_NAME}" --no-pager -l || true
  log "systemd restart done."
}

restart_none() {
  warn "No process manager detected and RELAY_MANAGER=none."
  warn "Restart the relay manually: node ${SCRIPT_DIR}/ais-relay.cjs"
}

MANAGER="${RELAY_MANAGER:-}"
if [[ -z "${MANAGER}" ]]; then
  if command -v pm2 > /dev/null 2>&1; then
    MANAGER="pm2"
  elif command -v systemctl > /dev/null 2>&1 && systemctl list-units --type=service 2>/dev/null | awk -v svc="${RELAY_SERVICE_NAME}" '$0 ~ svc {found=1} END{exit !found}'; then
    MANAGER="systemd"
  else
    MANAGER="none"
  fi
fi

case "${MANAGER}" in
  pm2)     restart_pm2 ;;
  systemd) restart_systemd ;;
  none)    restart_none ;;
  *)       die "Unknown RELAY_MANAGER value: '${MANAGER}'. Use pm2, systemd, or none." ;;
esac

log "Relay update complete."
