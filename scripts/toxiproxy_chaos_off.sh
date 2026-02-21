#!/usr/bin/env bash
set -euo pipefail

TOXIPROXY_API_URL="${TOXIPROXY_API_URL:-http://127.0.0.1:8474}"
TOXIPROXY_PROXY_NAME="${TOXIPROXY_PROXY_NAME:-aurora_upstream}"

for bin in curl jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing required command: $bin" >&2
    exit 2
  fi
done

toxics="$(
  curl -fsS "${TOXIPROXY_API_URL}/proxies/${TOXIPROXY_PROXY_NAME}/toxics" 2>/dev/null \
    | jq -r '.[]?.name' || true
)"

if [[ -n "$toxics" ]]; then
  while IFS= read -r toxic_name; do
    [[ -z "$toxic_name" ]] && continue
    curl -fsS -X DELETE "${TOXIPROXY_API_URL}/proxies/${TOXIPROXY_PROXY_NAME}/toxics/${toxic_name}" >/dev/null || true
  done <<<"$toxics"
fi

echo "toxics cleared for proxy=${TOXIPROXY_PROXY_NAME}"
