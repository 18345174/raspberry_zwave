#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

SERVICE_NAME=${SERVICE_NAME:-zwave-test-platform.service}
FRONTEND_SERVICE_NAME=${FRONTEND_SERVICE_NAME:-}
APP_DIR=${APP_DIR:-/opt/zwave-test-platform}
DATA_DIR=${DATA_DIR:-/var/lib/zwave-test-platform}
LOG_DIR=${LOG_DIR:-/var/log/zwave-test-platform}
APP_USER=${APP_USER:-$(id -un)}
APP_GROUP=${APP_GROUP:-$(id -gn)}
HOST=${HOST:-0.0.0.0}
PORT=${PORT:-8080}
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-123456}
DEBUG_API_ENABLED=${DEBUG_API_ENABLED:-false}
API_TOKEN=${API_TOKEN:-}
ZWAVE_CACHE_DIR=${ZWAVE_CACHE_DIR:-$DATA_DIR/zwave}
ZWAVE_DEVICE_CONFIG_DIR=${ZWAVE_DEVICE_CONFIG_DIR:-}
ZWAVE_KEY_S0_LEGACY=${ZWAVE_KEY_S0_LEGACY:-}
ZWAVE_KEY_S2_UNAUTHENTICATED=${ZWAVE_KEY_S2_UNAUTHENTICATED:-}
ZWAVE_KEY_S2_AUTHENTICATED=${ZWAVE_KEY_S2_AUTHENTICATED:-}
ZWAVE_KEY_S2_ACCESS_CONTROL=${ZWAVE_KEY_S2_ACCESS_CONTROL:-}
AUTH_SESSION_TTL_HOURS=${AUTH_SESSION_TTL_HOURS:-24}
DEFAULT_FRONTEND_PORT=${DEFAULT_FRONTEND_PORT:-5173}
ENV_FILE=${ENV_FILE:-$REPO_ROOT/backend/.env}
ZWAVE_JS_PACKAGES=${ZWAVE_JS_PACKAGES:-"zwave-js @zwave-js/core @zwave-js/cc @zwave-js/shared"}
CHECK_NODE_DEPS_ON_RESTART=${CHECK_NODE_DEPS_ON_RESTART:-true}
REBUILD_ON_DEP_INSTALL=${REBUILD_ON_DEP_INSTALL:-true}
FORCE_NPM_INSTALL=${FORCE_NPM_INSTALL:-false}

if [[ ! -f "$ENV_FILE" && -f "$APP_DIR/backend/.env" ]]; then
  ENV_FILE="$APP_DIR/backend/.env"
fi

usage() {
  cat <<USAGE
Usage:
  bash deploy/scripts/platform.sh <command>

Commands:
  deploy     First-time Raspberry Pi deployment. Installs Ubuntu dependencies,
             writes backend/.env, grants dialout, syncs code, installs deps,
             builds frontend/backend, and enables the systemd service.

  install    Sync current repo to APP_DIR, run npm install + npm run build,
             render the systemd unit, and restart/enable the backend service.
             Use this after git pull when you want the deployed copy updated.

  restart    Daily restart helper. Checks deployed node_modules first; if
             zwave-js package versions do not match package-lock.json, it runs
             npm install --include=optional and rebuilds before restarting.
             Then it checks backend/frontend ports, kills listeners if needed,
             and restarts the service. Frontend is only restarted separately
             when FRONTEND_SERVICE_NAME is set.

  help       Show this help.

Useful environment variables:
  APP_DIR                 Deploy target directory. Default: /opt/zwave-test-platform
  DATA_DIR                Runtime data directory. Default: /var/lib/zwave-test-platform
  LOG_DIR                 Runtime log directory. Default: /var/log/zwave-test-platform
  APP_USER                Service user. Default: current user
  APP_GROUP               Service group. Default: current user's group
  HOST                    Backend bind host for generated backend/.env. Default: 0.0.0.0
  PORT                    Backend port for generated backend/.env and restart checks. Default: 8080
  ADMIN_USERNAME          Default login username when running deploy. Default: admin
  ADMIN_PASSWORD          Default login password when running deploy. Default: 123456
  API_TOKEN               Optional static API token written into backend/.env
  DEBUG_API_ENABLED       Whether debug APIs are enabled in backend/.env. Default: false
  AUTH_SESSION_TTL_HOURS  Browser login session duration. Default: 24
  FRONTEND_SERVICE_NAME   Optional separate frontend systemd service name for restart mode
  FRONTEND_PORT           Optional frontend port to inspect in restart mode. Default: 5173
  ENV_FILE                backend .env path. Default: repo backend/.env, fallback to APP_DIR/backend/.env
  ZWAVE_JS_PACKAGES       Space-separated packages checked against package-lock.json on restart.
                          Default: zwave-js @zwave-js/core @zwave-js/cc @zwave-js/shared
  CHECK_NODE_DEPS_ON_RESTART  Set false to skip dependency version checks in restart. Default: true
  REBUILD_ON_DEP_INSTALL  Run npm run build after restart installs deps. Default: true
  FORCE_NPM_INSTALL       Force npm install in install/restart. Default: false

Examples:
  bash deploy/scripts/platform.sh deploy
  bash deploy/scripts/platform.sh install
  bash deploy/scripts/platform.sh restart
  FRONTEND_SERVICE_NAME=my-frontend.service bash deploy/scripts/platform.sh restart
  APP_DIR=/opt/zwave-test-platform APP_USER=ubuntu APP_GROUP=ubuntu bash deploy/scripts/platform.sh install
USAGE
}

ensure_linux() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "This command must run on Raspberry Pi Ubuntu/Linux." >&2
    exit 1
  fi
}

read_env_value() {
  local key=$1
  local fallback=$2

  if [[ -f "$ENV_FILE" ]]; then
    local value
    value=$(awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$ENV_FILE" | tail -n 1)
    if [[ -n "${value:-}" ]]; then
      printf '%s\n' "$value"
      return
    fi
  fi

  printf '%s\n' "$fallback"
}

find_pids_by_port() {
  local port=$1

  if command -v lsof >/dev/null 2>&1; then
    sudo lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    sudo ss -ltnp "sport = :$port" 2>/dev/null | \
      python3 -c 'import re, sys
seen = set()
for line in sys.stdin:
    for pid in re.findall(r"pid=(\d+)", line):
        if pid not in seen:
            seen.add(pid)
            print(pid)'
    return
  fi

  echo "Neither lsof nor ss is available; cannot inspect port $port." >&2
  return 1
}

kill_port_if_needed() {
  local port=$1
  local label=$2
  local pids

  mapfile -t pids < <(find_pids_by_port "$port" || true)
  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "[$label] Port $port is free."
    return
  fi

  echo "[$label] Port $port is occupied by PID(s): ${pids[*]}"
  for pid in "${pids[@]}"; do
    echo "[$label] kill -9 $pid"
    sudo kill -9 "$pid"
  done
}

restart_service_if_present() {
  local service_name=$1
  local label=$2

  if [[ -z "$service_name" ]]; then
    return
  fi

  if ! sudo systemctl cat "$service_name" >/dev/null 2>&1; then
    echo "[$label] Service $service_name is not installed, skipping."
    return
  fi

  echo "[$label] Restarting $service_name"
  sudo systemctl restart "$service_name"
  sudo systemctl status "$service_name" --no-pager
}

bool_is_true() {
  case "${1:-}" in
    true|TRUE|1|yes|YES|y|Y|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

package_lock_version() {
  local app_root=$1
  local package_name=$2

  node - "$app_root" "$package_name" <<'NODE'
const fs = require("fs");
const path = require("path");

const appRoot = process.argv[2];
const packageName = process.argv[3];
const lockPath = path.join(appRoot, "package-lock.json");

if (!fs.existsSync(lockPath)) {
  process.exit(2);
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const entry = lock.packages && lock.packages[`node_modules/${packageName}`];

if (!entry || !entry.version) {
  process.exit(3);
}

console.log(entry.version);
NODE
}

installed_package_version() {
  local app_root=$1
  local package_name=$2

  node - "$app_root" "$package_name" <<'NODE'
const path = require("path");

try {
  const appRoot = process.argv[2];
  const packageName = process.argv[3];
  const packageJson = require(path.join(appRoot, "node_modules", packageName, "package.json"));
  console.log(packageJson.version);
} catch {
  process.exit(1);
}
NODE
}

node_dependency_status() {
  local app_root=$1
  local needs_install=0
  local package_name
  local expected_version
  local installed_version

  if [[ ! -f "$app_root/package-lock.json" ]]; then
    echo "[deps] $app_root/package-lock.json not found; cannot verify node dependencies." >&2
    return 2
  fi

  if bool_is_true "$FORCE_NPM_INSTALL"; then
    echo "[deps] FORCE_NPM_INSTALL=true, npm install is required."
    needs_install=1
  fi

  if [[ ! -d "$app_root/node_modules" ]]; then
    echo "[deps] node_modules is missing."
    needs_install=1
  fi

  if [[ ! -f "$app_root/node_modules/.package-lock.json" ]]; then
    echo "[deps] node_modules/.package-lock.json is missing."
    needs_install=1
  elif [[ "$app_root/package-lock.json" -nt "$app_root/node_modules/.package-lock.json" ]]; then
    echo "[deps] package-lock.json is newer than node_modules/.package-lock.json."
    needs_install=1
  fi

  for package_name in $ZWAVE_JS_PACKAGES; do
    expected_version=$(package_lock_version "$app_root" "$package_name" 2>/dev/null || true)
    if [[ -z "$expected_version" ]]; then
      echo "[deps] Package $package_name is not present in package-lock.json; skipping version check."
      continue
    fi

    installed_version=$(installed_package_version "$app_root" "$package_name" 2>/dev/null || true)
    if [[ -z "$installed_version" ]]; then
      echo "[deps] Package $package_name is missing; expected $expected_version."
      needs_install=1
      continue
    fi

    if [[ "$installed_version" != "$expected_version" ]]; then
      echo "[deps] Package $package_name version mismatch: installed $installed_version, expected $expected_version."
      needs_install=1
    else
      echo "[deps] Package $package_name version OK: $installed_version."
    fi
  done

  if [[ "$needs_install" -eq 1 ]]; then
    return 1
  fi
  return 0
}

install_node_dependencies() {
  local app_root=$1

  echo "[deps] Running npm install --include=optional in $app_root"
  (cd "$app_root" && npm install --include=optional)

  if [[ -x "$app_root/deploy/scripts/ensure-rollup-native.sh" || -f "$app_root/deploy/scripts/ensure-rollup-native.sh" ]]; then
    echo "[deps] Ensuring Rollup native optional dependency"
    (cd "$app_root" && bash deploy/scripts/ensure-rollup-native.sh)
  fi
}

ensure_node_dependencies() {
  local app_root=$1
  local should_build=${2:-false}

  if node_dependency_status "$app_root"; then
    echo "[deps] Node dependencies already match package-lock.json."
    return
  fi

  install_node_dependencies "$app_root"

  if node_dependency_status "$app_root"; then
    echo "[deps] Node dependencies verified after npm install."
  else
    echo "[deps] Node dependencies still do not match after npm install." >&2
    return 1
  fi

  if bool_is_true "$should_build"; then
    echo "[deps] Rebuilding application after dependency install"
    (cd "$app_root" && npm run build)
  fi
}

run_install() {
  local unit_tmp
  unit_tmp=$(mktemp)
  trap 'rm -f "$unit_tmp"' RETURN

  ensure_linux
  cd "$REPO_ROOT"

  sudo mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR"
  sudo rsync -a --delete \
    --exclude node_modules \
    --exclude frontend/dist \
    --exclude backend/dist \
    ./ "$APP_DIR"/

  cd "$APP_DIR"
  install_node_dependencies "$APP_DIR"
  npm run build

  sudo chown -R "$APP_USER:$APP_GROUP" "$APP_DIR" "$DATA_DIR" "$LOG_DIR"
  sed \
    -e "s#^User=.*#User=$APP_USER#" \
    -e "s#^Group=.*#Group=$APP_GROUP#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=$APP_DIR/backend/.env#" \
    "deploy/systemd/$SERVICE_NAME" > "$unit_tmp"
  sudo install -m 0644 "$unit_tmp" "/etc/systemd/system/$SERVICE_NAME"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  sudo systemctl status "$SERVICE_NAME" --no-pager

  echo "Installed to $APP_DIR"
}

run_deploy() {
  local password_hash
  local pi_ip

  ensure_linux
  cd "$REPO_ROOT"

  echo "[1/5] Preparing Ubuntu dependencies"
  bash "$SCRIPT_DIR/prepare-ubuntu.sh"

  echo "[2/5] Granting serial access to $APP_USER"
  sudo usermod -aG dialout "$APP_USER" || true

  password_hash=$(node backend/scripts/generate-password-hash.mjs "$ADMIN_PASSWORD")

  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  fi

  echo "[3/5] Writing backend/.env"
  cat > "$ENV_FILE" <<ENVEOF
PORT=$PORT
HOST=$HOST
DATA_DIR=$DATA_DIR
LOG_DIR=$LOG_DIR
ZWAVE_CACHE_DIR=$ZWAVE_CACHE_DIR
ZWAVE_DEVICE_CONFIG_DIR=$ZWAVE_DEVICE_CONFIG_DIR
DEBUG_API_ENABLED=$DEBUG_API_ENABLED
API_TOKEN=$API_TOKEN
ZWAVE_KEY_S0_LEGACY=$ZWAVE_KEY_S0_LEGACY
ZWAVE_KEY_S2_UNAUTHENTICATED=$ZWAVE_KEY_S2_UNAUTHENTICATED
ZWAVE_KEY_S2_AUTHENTICATED=$ZWAVE_KEY_S2_AUTHENTICATED
ZWAVE_KEY_S2_ACCESS_CONTROL=$ZWAVE_KEY_S2_ACCESS_CONTROL
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=
ADMIN_PASSWORD_HASH=$password_hash
AUTH_SESSION_TTL_HOURS=$AUTH_SESSION_TTL_HOURS
ENVEOF

  echo "[4/5] Installing application to $APP_DIR"
  run_install

  pi_ip=$(hostname -I 2>/dev/null | awk '{print $1}')

  echo "[5/5] Deployment complete"
  echo "Service: $SERVICE_NAME"
  echo "URL: http://${pi_ip:-<raspberry-pi-ip>}:$PORT"
  echo "Login username: $ADMIN_USERNAME"
  echo "Login password: $ADMIN_PASSWORD"
  echo "Note: relogin or run 'newgrp dialout' may be required before serial permissions fully apply."
}

run_restart() {
  local backend_port
  local frontend_port

  ensure_linux
  backend_port=${BACKEND_PORT:-$(read_env_value PORT "$PORT")}
  frontend_port=${FRONTEND_PORT:-$(read_env_value FRONTEND_PORT "$DEFAULT_FRONTEND_PORT")}

  echo "[1/5] Checking deployed node dependencies"
  if bool_is_true "$CHECK_NODE_DEPS_ON_RESTART"; then
    ensure_node_dependencies "$APP_DIR" "$REBUILD_ON_DEP_INSTALL"
  else
    echo "[deps] CHECK_NODE_DEPS_ON_RESTART=false, skipping dependency checks."
  fi

  echo "[2/5] Checking backend port"
  kill_port_if_needed "$backend_port" "backend"

  echo "[3/5] Checking frontend port"
  kill_port_if_needed "$frontend_port" "frontend"

  echo "[4/5] Restarting backend service"
  restart_service_if_present "$SERVICE_NAME" "backend"

  echo "[5/5] Restarting frontend service"
  if [[ -n "$FRONTEND_SERVICE_NAME" ]]; then
    restart_service_if_present "$FRONTEND_SERVICE_NAME" "frontend"
  else
    echo "[frontend] No separate frontend service configured."
    echo "[frontend] In the current deployment, frontend static files are served by $SERVICE_NAME."
  fi

  echo "Restart complete."
  echo "Backend port: $backend_port"
  echo "Frontend port: $frontend_port"
}

COMMAND=${1:-help}
case "$COMMAND" in
  deploy)
    shift
    run_deploy "$@"
    ;;
  install)
    shift
    run_install "$@"
    ;;
  restart)
    shift
    run_restart "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
