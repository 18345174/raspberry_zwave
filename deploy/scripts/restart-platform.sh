#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

SERVICE_NAME=${SERVICE_NAME:-zwave-test-platform.service}
FRONTEND_SERVICE_NAME=${FRONTEND_SERVICE_NAME:-}
DEFAULT_BACKEND_PORT=${DEFAULT_BACKEND_PORT:-8080}
DEFAULT_FRONTEND_PORT=${DEFAULT_FRONTEND_PORT:-5173}
ENV_FILE=${ENV_FILE:-$REPO_ROOT/backend/.env}

if [[ ! -f "$ENV_FILE" && -f "/opt/zwave-test-platform/backend/.env" ]]; then
  ENV_FILE="/opt/zwave-test-platform/backend/.env"
fi

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

BACKEND_PORT=${BACKEND_PORT:-$(read_env_value PORT "$DEFAULT_BACKEND_PORT")}
FRONTEND_PORT=${FRONTEND_PORT:-$(read_env_value FRONTEND_PORT "$DEFAULT_FRONTEND_PORT")}

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

echo "[1/4] Checking backend port"
kill_port_if_needed "$BACKEND_PORT" "backend"

echo "[2/4] Checking frontend port"
kill_port_if_needed "$FRONTEND_PORT" "frontend"

echo "[3/4] Restarting backend service"
restart_service_if_present "$SERVICE_NAME" "backend"

echo "[4/4] Restarting frontend service"
if [[ -n "$FRONTEND_SERVICE_NAME" ]]; then
  restart_service_if_present "$FRONTEND_SERVICE_NAME" "frontend"
else
  echo "[frontend] No separate frontend service configured."
  echo "[frontend] In the current deployment, frontend static files are served by $SERVICE_NAME."
fi

echo "Restart complete."
echo "Backend port: $BACKEND_PORT"
echo "Frontend port: $FRONTEND_PORT"
