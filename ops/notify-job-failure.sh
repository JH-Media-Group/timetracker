#!/usr/bin/env bash
set -euo pipefail
unit="${1:?unit name required}"
message="Tally scheduled job ${unit} failed on $(hostname). Inspect journalctl -u ${unit} immediately."
systemd-cat --identifier=tally-alert --priority=err /bin/echo "$message"
if [[ -z "${TALLY_FAILURE_WEBHOOK_URL:-}" ]]; then
  echo "TALLY_FAILURE_WEBHOOK_URL is not configured; external alert was not sent." >&2
  exit 0
fi
if [[ ! "$TALLY_FAILURE_WEBHOOK_URL" =~ ^https://([A-Za-z0-9.-]+)(/|$) ]]; then
  echo "TALLY_FAILURE_WEBHOOK_URL must use HTTPS with a DNS host and default port." >&2; exit 2
fi
host="${BASH_REMATCH[1]}"
if [[ "$host" == "localhost" || "$host" == *.localhost || "$host" == *.local ]]; then
  echo "The failure webhook cannot target a local host." >&2; exit 2
fi
resolved="$(getent ahosts "$host")" || { echo "The failure webhook host could not be resolved safely." >&2; exit 2; }
[[ -n "$resolved" ]] || { echo "The failure webhook host did not resolve." >&2; exit 2; }
while read -r ip _; do
  if [[ "$ip" =~ ^127\. || "$ip" =~ ^10\. || "$ip" =~ ^192\.168\. || "$ip" =~ ^169\.254\. || "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. || "$ip" == "::1" || "$ip" =~ ^[fF][c-dD] || "$ip" =~ ^[fF][eE]80: ]]; then
    echo "The failure webhook cannot resolve to a private or local address." >&2; exit 2
  fi
  [[ -n "${target_ip:-}" ]] || target_ip="$ip"
done <<< "$resolved"
escaped=${message//\\/\\\\}; escaped=${escaped//\"/\\\"}
curl --proto '=https' --resolve "${host}:443:${target_ip}" --fail --silent --show-error --max-time 15 -H 'content-type: application/json' --data "{\"text\":\"${escaped}\"}" "$TALLY_FAILURE_WEBHOOK_URL"
