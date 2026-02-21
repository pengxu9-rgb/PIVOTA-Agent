#!/usr/bin/env bash
set -euo pipefail

TOXIPROXY_API_URL="${TOXIPROXY_API_URL:-http://127.0.0.1:8474}"
TOXIPROXY_PROXY_NAME="${TOXIPROXY_PROXY_NAME:-aurora_upstream}"
TOXIPROXY_CHAOS_MODE="${TOXIPROXY_CHAOS_MODE:-latency}"
TOXIPROXY_TOXICITY="${TOXIPROXY_TOXICITY:-1.0}"
TOXIPROXY_LATENCY_MS="${TOXIPROXY_LATENCY_MS:-800}"
TOXIPROXY_JITTER_MS="${TOXIPROXY_JITTER_MS:-200}"
TOXIPROXY_TIMEOUT_MS="${TOXIPROXY_TIMEOUT_MS:-2000}"
TOXIPROXY_BANDWIDTH_KBPS="${TOXIPROXY_BANDWIDTH_KBPS:-256}"
TOXIPROXY_RESET_TOXICITY="${TOXIPROXY_RESET_TOXICITY:-0.10}"

for bin in curl jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing required command: $bin" >&2
    exit 2
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/toxiproxy_chaos_off.sh"

add_toxic() {
  local name="$1"
  local type="$2"
  local toxicity="$3"
  local attributes_json="$4"
  curl -fsS -X POST "${TOXIPROXY_API_URL}/proxies/${TOXIPROXY_PROXY_NAME}/toxics" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn \
      --arg name "$name" \
      --arg type "$type" \
      --arg stream "downstream" \
      --argjson toxicity "$toxicity" \
      --argjson attrs "$attributes_json" \
      '{name:$name,type:$type,stream:$stream,toxicity:$toxicity,attributes:$attrs}')" >/dev/null
}

case "$TOXIPROXY_CHAOS_MODE" in
  latency)
    add_toxic "chaos_latency" "latency" "$TOXIPROXY_TOXICITY" "{\"latency\":${TOXIPROXY_LATENCY_MS},\"jitter\":${TOXIPROXY_JITTER_MS}}"
    ;;
  timeout)
    add_toxic "chaos_timeout" "timeout" "$TOXIPROXY_TOXICITY" "{\"timeout\":${TOXIPROXY_TIMEOUT_MS}}"
    ;;
  reset)
    add_toxic "chaos_reset" "reset_peer" "$TOXIPROXY_RESET_TOXICITY" "{}"
    ;;
  bandwidth)
    add_toxic "chaos_bandwidth" "bandwidth" "$TOXIPROXY_TOXICITY" "{\"rate\":${TOXIPROXY_BANDWIDTH_KBPS}}"
    ;;
  mix)
    add_toxic "chaos_mix_latency" "latency" "$TOXIPROXY_TOXICITY" "{\"latency\":${TOXIPROXY_LATENCY_MS},\"jitter\":${TOXIPROXY_JITTER_MS}}"
    add_toxic "chaos_mix_reset" "reset_peer" "$TOXIPROXY_RESET_TOXICITY" "{}"
    ;;
  *)
    echo "unsupported TOXIPROXY_CHAOS_MODE=${TOXIPROXY_CHAOS_MODE}" >&2
    exit 2
    ;;
esac

curl -fsS "${TOXIPROXY_API_URL}/proxies/${TOXIPROXY_PROXY_NAME}/toxics" | jq '{mode:"'"${TOXIPROXY_CHAOS_MODE}"'",toxics:[.[]|{name,type,toxicity,stream,attributes}]}'
