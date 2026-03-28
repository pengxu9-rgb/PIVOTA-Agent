#!/usr/bin/env bash
set -euo pipefail

RAIL_MODE="${RAIL_MODE:-authoritative_commerce}"
DEFAULT_PUBLIC_BASE_URL="${DEFAULT_PUBLIC_BASE_URL:-https://agent.pivota.cc}"
DEFAULT_INVOKE_BASE_URL="${DEFAULT_INVOKE_BASE_URL:-https://pivota-agent-production.up.railway.app}"
BASE_URL="${BASE_URL:-}"
INVOKE_BASE_URL="${INVOKE_BASE_URL:-${COMMERCE_CORE_PROD_SMOKE_BASE_URL:-${DEFAULT_INVOKE_BASE_URL}}}"
TARGET_COMMIT="${TARGET_COMMIT:-$(git rev-parse --short=12 HEAD)}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-80}"
SLEEP_SECONDS="${SLEEP_SECONDS:-10}"
GATEWAY_ENDPOINT="${GATEWAY_ENDPOINT-}"
ALT_GATEWAY_ENDPOINT="${ALT_GATEWAY_ENDPOINT-/agent/shop/v1/invoke}"
VERIFY_QUERY="${VERIFY_QUERY:-serum}"
AUTH_TOKEN="${AUTH_TOKEN:-${COMMERCE_CORE_PROD_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${COMMERCE_CORE_PROD_AGENT_API_KEY:-}}"
ALLOW_HEADER_FALLBACK="${ALLOW_HEADER_FALLBACK:-0}"

if [[ "${RAIL_MODE}" == "public_observability" ]]; then
  if [[ -z "${BASE_URL}" ]]; then
    BASE_URL="${DEFAULT_PUBLIC_BASE_URL}"
  fi
  if [[ -z "${GATEWAY_ENDPOINT}" ]]; then
    GATEWAY_ENDPOINT="/api/gateway"
  fi
  if [[ "${ALLOW_HEADER_FALLBACK}" == "0" ]]; then
    ALLOW_HEADER_FALLBACK="1"
  fi
else
  if [[ -z "${BASE_URL}" ]]; then
    BASE_URL="${DEFAULT_INVOKE_BASE_URL}"
  fi
  GATEWAY_ENDPOINT="${GATEWAY_ENDPOINT:-}"
  ALT_GATEWAY_ENDPOINT="${ALT_GATEWAY_ENDPOINT:-/agent/shop/v1/invoke}"
  ALLOW_HEADER_FALLBACK="0"
  if [[ -z "${AUTH_TOKEN}" && -z "${AGENT_API_KEY}" ]]; then
    echo "authoritative_commerce verify requires AUTH_TOKEN or AGENT_API_KEY" >&2
    exit 2
  fi
fi

if ! [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$MAX_ATTEMPTS" -le 0 ]; then
  echo "MAX_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

if ! [[ "$SLEEP_SECONDS" =~ ^[0-9]+$ ]] || [ "$SLEEP_SECONDS" -lt 0 ]; then
  echo "SLEEP_SECONDS must be a non-negative integer" >&2
  exit 2
fi

echo "BASE_URL=$BASE_URL"
echo "INVOKE_BASE_URL=${INVOKE_BASE_URL:-$BASE_URL}"
echo "RAIL_MODE=$RAIL_MODE"
echo "TARGET_COMMIT=$TARGET_COMMIT"
echo "GATEWAY_ENDPOINT=$GATEWAY_ENDPOINT"
echo "ALT_GATEWAY_ENDPOINT=$ALT_GATEWAY_ENDPOINT"
echo "ALLOW_HEADER_FALLBACK=$ALLOW_HEADER_FALLBACK"
if [[ -n "${AUTH_TOKEN}" ]]; then
  echo "AUTH_MODE=bearer"
elif [[ -n "${AGENT_API_KEY}" ]]; then
  echo "AUTH_MODE=x-agent-api-key"
else
  echo "AUTH_MODE=none"
fi

extract_gateway_commit() {
  local endpoint="$1"
  local request_base_url="${2:-$BASE_URL}"
  local response=""
  if [ -z "$endpoint" ]; then
    return 0
  fi
  local -a curl_args=(
    -fsS
    --max-time 20
    -H 'Content-Type: application/json'
    -X POST
  )
  if [ -n "${AUTH_TOKEN}" ]; then
    if [[ "${AUTH_TOKEN}" =~ ^[Bb]earer[[:space:]]+ ]]; then
      curl_args+=(-H "Authorization: ${AUTH_TOKEN}")
    else
      curl_args+=(-H "Authorization: Bearer ${AUTH_TOKEN}")
    fi
  fi
  if [ -n "${AGENT_API_KEY}" ]; then
    curl_args+=(-H "X-Agent-API-Key: ${AGENT_API_KEY}")
  fi
  response="$(
    curl "${curl_args[@]}" \
      --data "$(cat <<JSON
{"operation":"find_products_multi","payload":{"search":{"query":"${VERIFY_QUERY}","limit":1,"in_stock_only":true}},"metadata":{"source":"search"}}
JSON
)" \
      "${request_base_url%/}${endpoint}" \
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
  deployed=""
  detected_via="missing"

  if [ -n "${GATEWAY_ENDPOINT:-}" ]; then
    deployed="$(extract_gateway_commit "$GATEWAY_ENDPOINT" "$BASE_URL")"
    detected_via="gateway:${BASE_URL%/}${GATEWAY_ENDPOINT}"
  fi

  if [ -z "${deployed:-}" ] && [ -n "${ALT_GATEWAY_ENDPOINT:-}" ]; then
    deployed="$(extract_gateway_commit "$ALT_GATEWAY_ENDPOINT" "${INVOKE_BASE_URL:-$BASE_URL}")"
    detected_via="gateway:${INVOKE_BASE_URL:-$BASE_URL}${ALT_GATEWAY_ENDPOINT}"
  fi

  if [ -z "${deployed:-}" ] && [[ "${ALLOW_HEADER_FALLBACK}" != "0" ]]; then
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
