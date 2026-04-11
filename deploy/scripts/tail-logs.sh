#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME=${SERVICE_NAME:-zwave-test-platform.service}
MODE=${1:-zwave}
TAIL_LINES=${TAIL_LINES:-120}

JOURNAL_ARGS=(-u "$SERVICE_NAME" -n "$TAIL_LINES" -f -o short-iso --no-hostname)

run_journal() {
  if journalctl "${JOURNAL_ARGS[@]}" >/dev/null 2>&1 </dev/null; then
    journalctl "${JOURNAL_ARGS[@]}"
    return
  fi

  sudo journalctl "${JOURNAL_ARGS[@]}"
}

case "$MODE" in
  all)
    run_journal
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

Examples:
  bash deploy/scripts/tail-logs.sh
  bash deploy/scripts/tail-logs.sh all
  bash deploy/scripts/tail-logs.sh errors
  SERVICE_NAME=zwave-test-platform.service bash deploy/scripts/tail-logs.sh zwave
EOF
    exit 1
    ;;
esac
