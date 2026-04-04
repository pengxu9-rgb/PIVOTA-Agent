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
VERSION_ENDPOINT="${VERSION_ENDPOINT-/version}"
HEALTH_ENDPOINT="${HEALTH_ENDPOINT-/healthz}"
AUTH_TOKEN="${AUTH_TOKEN:-${COMMERCE_CORE_PROD_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${COMMERCE_CORE_PROD_AGENT_API_KEY:-}}"

if [[ "${RAIL_MODE}" == "public_observability" ]]; then
  if [[ -z "${BASE_URL}" ]]; then
    BASE_URL="${DEFAULT_PUBLIC_BASE_URL}"
  fi
else
  if [[ -z "${BASE_URL}" ]]; then
    BASE_URL="${DEFAULT_INVOKE_BASE_URL}"
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
echo "VERSION_ENDPOINT=$VERSION_ENDPOINT"
echo "HEALTH_ENDPOINT=$HEALTH_ENDPOINT"
if [[ -n "${AUTH_TOKEN}" ]]; then
  echo "AUTH_MODE=bearer"
elif [[ -n "${AGENT_API_KEY}" ]]; then
  echo "AUTH_MODE=x-agent-api-key"
else
  echo "AUTH_MODE=none"
fi

extract_json_field() {
  local payload="$1"
  local field_path="$2"
  RESPONSE_JSON="$payload" FIELD_PATH="$field_path" python3 - <<'PY'
import json
import os

text = os.environ.get("RESPONSE_JSON", "").strip()
field_path = [part for part in os.environ.get("FIELD_PATH", "").split(".") if part]
if not text or not field_path:
    raise SystemExit(0)
try:
    data = json.loads(text)
except Exception:
    raise SystemExit(0)
current = data
for part in field_path:
    if not isinstance(current, dict):
        raise SystemExit(0)
    current = current.get(part)
if isinstance(current, str) and current.strip():
    print(current.strip())
PY
}

fetch_json() {
  local endpoint="$1"
  local request_base_url="${2:-$BASE_URL}"
  if [ -z "$endpoint" ]; then
    return 0
  fi
  curl -fsS --max-time 20 "${request_base_url%/}${endpoint}" 2>/dev/null || true
}

extract_version_commit() {
  local endpoint="$1"
  local request_base_url="${2:-$BASE_URL}"
  local response=""
  response="$(fetch_json "$endpoint" "$request_base_url")"
  if [ -z "${response:-}" ]; then
    return 0
  fi
  extract_json_field "$response" "commit"
}

extract_health_commit() {
  local endpoint="$1"
  local request_base_url="${2:-$BASE_URL}"
  local response=""
  response="$(fetch_json "$endpoint" "$request_base_url")"
  if [ -z "${response:-}" ]; then
    return 0
  fi
  extract_json_field "$response" "version.commit"
}

deployed=""
detected_via="missing"
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  deployed=""
  detected_via="missing"

  deployed="$(extract_version_commit "$VERSION_ENDPOINT" "$BASE_URL")"
  detected_via="version:${BASE_URL%/}${VERSION_ENDPOINT}"

  if [ -z "${deployed:-}" ] && [ -n "${HEALTH_ENDPOINT:-}" ]; then
    deployed="$(extract_health_commit "$HEALTH_ENDPOINT" "$BASE_URL")"
    detected_via="health:${BASE_URL%/}${HEALTH_ENDPOINT}"
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
