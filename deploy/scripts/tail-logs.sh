#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME=${SERVICE_NAME:-zwave-test-platform.service}
MODE=${1:-backend}
TAIL_LINES=${TAIL_LINES:-120}

JOURNAL_ARGS=(-u "$SERVICE_NAME" -n "$TAIL_LINES" -f -o short-iso --no-hostname)
JOURNAL_CHECK_ARGS=(-u "$SERVICE_NAME" -n 1 --no-pager)

run_journal() {
  if journalctl "${JOURNAL_CHECK_ARGS[@]}" >/dev/null 2>&1 </dev/null; then
    journalctl "${JOURNAL_ARGS[@]}"
    return
  fi

  sudo journalctl "${JOURNAL_ARGS[@]}"
}

case "$MODE" in
  backend|all)
    run_journal
    ;;
  controller)
    run_journal | grep -Ei --line-buffered "zwave-runtime|zwave-adapter|controller|serial|tty|usb|connect|disconnect|ready|error|failed|timeout|driver"
    ;;
  zwave)
    run_journal | grep -Ei --line-buffered "zwave|z-wave|driver|serial|tty|usb|node|controller|inclusion|exclusion|security|s0|s2|dsk|heal|interview|value updated|notification|error|failed"
    ;;
  errors|error)
    run_journal | grep -Ei --line-buffered "error|failed|exception|fatal|timeout|denied|disconnect|unavailable"
    ;;
  *)
    cat <<EOF
Usage: $0 [all|zwave|errors]
Usage: $0 [backend|controller|zwave|errors|all]

Examples:
  bash deploy/scripts/tail-logs.sh
  bash deploy/scripts/tail-logs.sh backend
  bash deploy/scripts/tail-logs.sh controller
  bash deploy/scripts/tail-logs.sh all
  bash deploy/scripts/tail-logs.sh errors
  SERVICE_NAME=zwave-test-platform.service bash deploy/scripts/tail-logs.sh zwave
EOF
    exit 1
    ;;
esac
