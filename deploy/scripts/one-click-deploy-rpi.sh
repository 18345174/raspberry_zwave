#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

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
ENV_FILE="$REPO_ROOT/backend/.env"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script must run on Raspberry Pi Ubuntu/Linux." >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "[1/5] Preparing Ubuntu dependencies"
bash "$SCRIPT_DIR/prepare-ubuntu.sh"

echo "[2/5] Granting serial access to $APP_USER"
sudo usermod -aG dialout "$APP_USER" || true

PASSWORD_HASH=$(node backend/scripts/generate-password-hash.mjs "$ADMIN_PASSWORD")

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
ADMIN_PASSWORD_HASH=$PASSWORD_HASH
AUTH_SESSION_TTL_HOURS=$AUTH_SESSION_TTL_HOURS
ENVEOF

echo "[4/5] Installing application to $APP_DIR"
APP_DIR="$APP_DIR" \
DATA_DIR="$DATA_DIR" \
LOG_DIR="$LOG_DIR" \
APP_USER="$APP_USER" \
APP_GROUP="$APP_GROUP" \
bash "$SCRIPT_DIR/install.sh"

PI_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo "[5/5] Deployment complete"
echo "Service: zwave-test-platform.service"
echo "URL: http://${PI_IP:-<raspberry-pi-ip>}:$PORT"
echo "Login username: $ADMIN_USERNAME"
echo "Login password: $ADMIN_PASSWORD"
echo "Note: relogin or run 'newgrp dialout' may be required before serial permissions fully apply."
