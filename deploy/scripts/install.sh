#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/zwave-test-platform}
DATA_DIR=${DATA_DIR:-/var/lib/zwave-test-platform}
LOG_DIR=${LOG_DIR:-/var/log/zwave-test-platform}
SERVICE_NAME=zwave-test-platform.service
APP_USER=${APP_USER:-ubuntu}
APP_GROUP=${APP_GROUP:-$APP_USER}
UNIT_TMP=$(mktemp)
trap 'rm -f "$UNIT_TMP"' EXIT

sudo mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR"
sudo rsync -a --delete \
  --exclude node_modules \
  --exclude frontend/dist \
  --exclude backend/dist \
  ./ "$APP_DIR"/

cd "$APP_DIR"
npm install
npm run build

sudo chown -R "$APP_USER:$APP_GROUP" "$APP_DIR" "$DATA_DIR" "$LOG_DIR"
sed \
  -e "s#^User=.*#User=$APP_USER#" \
  -e "s#^Group=.*#Group=$APP_GROUP#" \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" \
  -e "s#^EnvironmentFile=.*#EnvironmentFile=$APP_DIR/backend/.env#" \
  deploy/systemd/$SERVICE_NAME > "$UNIT_TMP"
sudo install -m 0644 "$UNIT_TMP" /etc/systemd/system/$SERVICE_NAME
sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE_NAME
sudo systemctl status $SERVICE_NAME --no-pager

echo "Installed to $APP_DIR"
