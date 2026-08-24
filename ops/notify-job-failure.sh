#!/usr/bin/env bash
set -euo pipefail
unit="${1:?unit name required}"
message="Tally scheduled job ${unit} failed on $(hostname). Inspect journalctl -u ${unit} immediately."
systemd-cat --identifier=tally-alert --priority=emerg /bin/echo "$message"
if [[ -z "${TALLY_FAILURE_WEBHOOK_URL:-}" ]]; then
  echo "TALLY_FAILURE_WEBHOOK_URL is not configured; external alert was not sent." >&2
  exit 1
fi
escaped=${message//\\/\\\\}; escaped=${escaped//\"/\\\"}
curl --fail --silent --show-error --max-time 15 -H 'content-type: application/json' --data "{\"text\":\"${escaped}\"}" "$TALLY_FAILURE_WEBHOOK_URL"
