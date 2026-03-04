#!/usr/bin/env bash
set -euo pipefail

ROLLBACK_WEBHOOK_URL="${ROLLBACK_WEBHOOK_URL:-${RAILWAY_ROLLBACK_WEBHOOK_URL:-}}"
ROLLBACK_REASON="${ROLLBACK_REASON:-aurora_release_gate_failed}"
FAILED_RUN_URL="${FAILED_RUN_URL:-}"
FAILED_SHA="${FAILED_SHA:-}"
FAILED_DEPLOYMENT_ID="${FAILED_DEPLOYMENT_ID:-}"

if [[ -z "${ROLLBACK_WEBHOOK_URL}" ]]; then
  echo "SKIP: rollback webhook URL is not configured."
  exit 0
fi

payload="$(jq -n \
  --arg reason "$ROLLBACK_REASON" \
  --arg run_url "$FAILED_RUN_URL" \
  --arg sha "$FAILED_SHA" \
  --arg deployment_id "$FAILED_DEPLOYMENT_ID" \
  '{reason:$reason, run_url:$run_url, sha:$sha, deployment_id:$deployment_id}')"

curl -sS -X POST "$ROLLBACK_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  --data "$payload" >/dev/null

echo "PASS: rollback webhook triggered."
