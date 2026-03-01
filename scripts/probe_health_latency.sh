#!/usr/bin/env bash
set -euo pipefail

# Quick probe for separating handshake cost and app-side latency.
# Usage:
#   BASE_URL=https://pivota-agent-production.up.railway.app ./scripts/probe_health_latency.sh

BASE_URL="${BASE_URL:-https://pivota-agent-production.up.railway.app}"
ENDPOINT_A="${ENDPOINT_A:-/healthz}"
ENDPOINT_B="${ENDPOINT_B:-/healthz}"
ROUNDS="${ROUNDS:-5}"

if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]] || [ "$ROUNDS" -le 0 ]; then
  echo "ROUNDS must be a positive integer"
  exit 1
fi

echo "base_url=${BASE_URL}"
echo "rounds=${ROUNDS}"
echo "first=${ENDPOINT_A} second=${ENDPOINT_B}"
echo

for ((i = 1; i <= ROUNDS; i++)); do
  echo "--- round ${i} ---"
  curl -sS --http1.1 \
    -o /dev/null \
    -w "first  code=%{http_code} tls=%{time_appconnect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n" \
    "${BASE_URL}${ENDPOINT_A}" \
    --next \
    -o /dev/null \
    -w "second code=%{http_code} tls=%{time_appconnect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n" \
    "${BASE_URL}${ENDPOINT_B}"
done
