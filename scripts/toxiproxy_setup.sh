#!/usr/bin/env bash
set -euo pipefail

TOXIPROXY_API_URL="${TOXIPROXY_API_URL:-http://127.0.0.1:8474}"
TOXIPROXY_PROXY_NAME="${TOXIPROXY_PROXY_NAME:-aurora_upstream}"
TOXIPROXY_LISTEN="${TOXIPROXY_LISTEN:-127.0.0.1:19090}"
TOXIPROXY_UPSTREAM="${TOXIPROXY_UPSTREAM:-}"
TOXIPROXY_RECREATE="${TOXIPROXY_RECREATE:-true}"

if [[ -z "$TOXIPROXY_UPSTREAM" ]]; then
  echo "TOXIPROXY_UPSTREAM is required (host:port)" >&2
  exit 2
fi

for bin in curl jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing required command: $bin" >&2
    exit 2
  fi
done

has_proxy="$(
  curl -fsS "${TOXIPROXY_API_URL}/proxies/${TOXIPROXY_PROXY_NAME}" >/dev/null 2>&1 && echo "yes" || echo "no"
)"

if [[ "$has_proxy" == "yes" && "$TOXIPROXY_RECREATE" == "true" ]]; then
  curl -fsS -X DELETE "${TOXIPROXY_API_URL}/proxies/${TOXIPROXY_PROXY_NAME}" >/dev/null
  has_proxy="no"
fi

if [[ "$has_proxy" == "no" ]]; then
  curl -fsS -X POST "${TOXIPROXY_API_URL}/proxies" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn \
      --arg name "$TOXIPROXY_PROXY_NAME" \
      --arg listen "$TOXIPROXY_LISTEN" \
      --arg upstream "$TOXIPROXY_UPSTREAM" \
      '{name:$name,listen:$listen,upstream:$upstream}')" >/dev/null
fi

curl -fsS "${TOXIPROXY_API_URL}/proxies/${TOXIPROXY_PROXY_NAME}" | jq '{name,listen,upstream,enabled}'
