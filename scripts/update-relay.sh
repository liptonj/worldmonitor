#!/usr/bin/env bash
# update-relay.sh — Pull latest code and restart the relay process on relay.5ls.us
#
# Run this on the relay host after deploying a new version:
#   bash scripts/update-relay.sh
#
# The script will:
#   1. Check required .env values and prompt for any that are missing
#   2. Pull the latest code from git
#   3. Restart the relay process (supports pm2 and systemd)
#
# Environment:
#   RELAY_PROCESS_NAME   pm2 process name (default: worldmonitor-relay)
#   RELAY_SERVICE_NAME   systemd service name (default: worldmonitor-relay)
#   RELAY_MANAGER        Force process manager: "pm2" | "systemd" | "none"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

RELAY_PROCESS_NAME="${RELAY_PROCESS_NAME:-worldmonitor-relay}"
RELAY_SERVICE_NAME="${RELAY_SERVICE_NAME:-worldmonitor-relay}"

log()  { echo "[update-relay] $*"; }
warn() { echo "[update-relay] WARN: $*" >&2; }
die()  { echo "[update-relay] ERROR: $*" >&2; exit 1; }

# ── 1. Check and prompt for required .env values ─────────────────────────────

# env_get KEY — read current value from .env (empty string if missing/unset)
env_get() {
  local key="$1"
  if [[ -f "${ENV_FILE}" ]]; then
    grep -E "^${key}=" "${ENV_FILE}" | tail -1 | cut -d'=' -f2- || true
  fi
}

# env_set KEY VALUE — upsert a KEY=VALUE line in .env
env_set() {
  local key="$1" value="$2"
  if [[ -f "${ENV_FILE}" ]] && grep -qE "^${key}=" "${ENV_FILE}"; then
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

log "Checking required .env values..."
prompt_env "RELAY_SHARED_SECRET" \
  "Shared secret between this relay and Vercel (must match RELAY_SHARED_SECRET on Vercel)."
prompt_env "VERCEL_APP_URL" \
  "URL of the Vercel deployment this relay posts headlines to (e.g. https://worldmonitor.app)."

# ── 2. Pull latest code ─────────────────────────────────────────────────────

cd "${ROOT_DIR}"

log "Pulling latest code..."
git pull --ff-only || die "git pull failed — resolve conflicts manually and re-run"

log "Installing/updating dependencies..."
npm install --omit=dev || warn "npm install failed — relay may be missing node-cron"

# ── 3. Detect process manager and restart ────────────────────────────────────

restart_pm2() {
  log "Restarting via pm2 (process: ${RELAY_PROCESS_NAME})..."
  if pm2 describe "${RELAY_PROCESS_NAME}" > /dev/null 2>&1; then
    pm2 restart "${RELAY_PROCESS_NAME}" --update-env
    pm2 save
    log "pm2 restart done."
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
  elif systemctl list-units --type=service 2>/dev/null | grep -q "${RELAY_SERVICE_NAME}"; then
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
