#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME=${SERVICE_NAME:-zwave-test-platform.service}
MODE=${1:-backend}
TAIL_LINES=${TAIL_LINES:-120}
CONTROLLER_PATTERN='(\[zwave-runtime\]|\[zwave-adapter\]|/api/zwave/|/api/serial/|zwave|z-wave|driver|controller|serial|tty|usb|node|inclusion|exclusion|security|grant_security|validate_dsk|challenge|dsk|s0|s2|interview|value updated|value added|value removed|metadata updated|notification|ready|connect|disconnect|error|failed|timeout|ZW0103|The controller is not yet ready|Z-Wave driver is already running|Cannot read properties of undefined \(reading '\''print'\''\))'

JOURNAL_ARGS=(-u "$SERVICE_NAME" -n "$TAIL_LINES" -f -o short-iso --no-hostname)
JOURNAL_FOLLOW_ONLY_ARGS=(-u "$SERVICE_NAME" -n 0 -f -o short-iso --no-hostname)
JOURNAL_CHECK_ARGS=(-u "$SERVICE_NAME" -n 1 --no-pager)

run_journal() {
  if journalctl "${JOURNAL_CHECK_ARGS[@]}" >/dev/null 2>&1 </dev/null; then
    journalctl "${JOURNAL_ARGS[@]}"
    return
  fi

  sudo journalctl "${JOURNAL_ARGS[@]}"
}

run_journal_follow_only() {
  if journalctl "${JOURNAL_CHECK_ARGS[@]}" >/dev/null 2>&1 </dev/null; then
    journalctl "${JOURNAL_FOLLOW_ONLY_ARGS[@]}"
    return
  fi

  sudo journalctl "${JOURNAL_FOLLOW_ONLY_ARGS[@]}"
}

case "$MODE" in
  backend|all)
    run_journal
    ;;
  controller)
    run_journal_follow_only | grep -Ei --line-buffered "$CONTROLLER_PATTERN"
    ;;
  zwave)
    run_journal | grep -Ei --line-buffered "$CONTROLLER_PATTERN|heal"
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
  bash deploy/scripts/tail-logs.sh controller   # only new controller/Z-Wave logs, no history
  bash deploy/scripts/tail-logs.sh all
  bash deploy/scripts/tail-logs.sh errors
  SERVICE_NAME=zwave-test-platform.service bash deploy/scripts/tail-logs.sh zwave
EOF
    exit 1
    ;;
esac
