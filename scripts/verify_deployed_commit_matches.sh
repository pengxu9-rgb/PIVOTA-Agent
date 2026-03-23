#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
TARGET_COMMIT="${TARGET_COMMIT:-$(git rev-parse --short=12 HEAD)}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-80}"
SLEEP_SECONDS="${SLEEP_SECONDS:-10}"
GATEWAY_ENDPOINT="${GATEWAY_ENDPOINT:-/api/gateway}"
ALT_GATEWAY_ENDPOINT="${ALT_GATEWAY_ENDPOINT:-/agent/shop/v1/invoke}"
VERIFY_QUERY="${VERIFY_QUERY:-serum}"

if ! [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$MAX_ATTEMPTS" -le 0 ]; then
  echo "MAX_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

if ! [[ "$SLEEP_SECONDS" =~ ^[0-9]+$ ]] || [ "$SLEEP_SECONDS" -lt 0 ]; then
  echo "SLEEP_SECONDS must be a non-negative integer" >&2
  exit 2
fi

echo "BASE_URL=$BASE_URL"
echo "TARGET_COMMIT=$TARGET_COMMIT"
echo "GATEWAY_ENDPOINT=$GATEWAY_ENDPOINT"
echo "ALT_GATEWAY_ENDPOINT=$ALT_GATEWAY_ENDPOINT"

extract_gateway_commit() {
  local endpoint="$1"
  local response=""
  if [ -z "$endpoint" ]; then
    return 0
  fi
  response="$(
    curl -fsS --max-time 20 \
      -H 'Content-Type: application/json' \
      -X POST \
      --data "$(cat <<JSON
{"operation":"find_products_multi","payload":{"search":{"query":"${VERIFY_QUERY}","limit":1,"in_stock_only":true}},"metadata":{"source":"search"}}
JSON
)" \
      "${BASE_URL%/}${endpoint}" \
      2>/dev/null || true
  )"
  if [ -z "${response:-}" ]; then
    return 0
  fi
  RESPONSE_JSON="$response" python3 - <<'PY'
import json
import os

text = os.environ.get("RESPONSE_JSON", "").strip()
if not text:
    raise SystemExit(0)
try:
    data = json.loads(text)
except Exception:
    raise SystemExit(0)
meta = data.get("metadata") if isinstance(data, dict) else None
if not isinstance(meta, dict):
    raise SystemExit(0)
svc = meta.get("service_version")
if not isinstance(svc, dict):
    raise SystemExit(0)
commit = svc.get("commit")
if isinstance(commit, str) and commit.strip():
    print(commit.strip())
PY
}

extract_header_commit() {
  curl -sSI "${BASE_URL%/}/v1/session/bootstrap" \
    | tr -d '\r' \
    | awk -F': ' 'tolower($1)=="x-service-commit" {print $2}' \
    | head -n 1 \
    || true
}

deployed=""
detected_via="missing"
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  deployed="$(extract_gateway_commit "$GATEWAY_ENDPOINT")"
  detected_via="gateway:${GATEWAY_ENDPOINT}"
  if [ -z "${deployed:-}" ] && [ -n "${ALT_GATEWAY_ENDPOINT:-}" ]; then
    deployed="$(extract_gateway_commit "$ALT_GATEWAY_ENDPOINT")"
    detected_via="gateway:${ALT_GATEWAY_ENDPOINT}"
  fi
  if [ -z "${deployed:-}" ]; then
    deployed="$(extract_header_commit)"
    detected_via="header:/v1/session/bootstrap"
  fi
  echo "${i}/${MAX_ATTEMPTS} deployed_commit=${deployed:-missing} via=${detected_via}"
  if [ -n "${deployed:-}" ] && [ "$deployed" = "$TARGET_COMMIT" ]; then
    echo "PASS: deployed commit matches target."
    exit 0
  fi
  sleep "$SLEEP_SECONDS"
done

echo "FAIL: deployment commit mismatch."
echo "deployed=${deployed:-missing}"
echo "target=$TARGET_COMMIT"
exit 1
