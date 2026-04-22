#!/usr/bin/env bash
set -euo pipefail

DEPLOY_WEBHOOK_URL="${DEPLOY_WEBHOOK_URL:-${RAILWAY_PRODUCTION_DEPLOY_WEBHOOK_URL:-${PIVOTA_AGENT_PROD_DEPLOY_WEBHOOK_URL:-${RAILWAY_DEPLOY_WEBHOOK_URL:-}}}}"
DEPLOY_REASON="${DEPLOY_REASON:-github_push_main}"
TARGET_SHA="${TARGET_SHA:-}"
TARGET_REF="${TARGET_REF:-}"
TARGET_REPOSITORY="${TARGET_REPOSITORY:-}"
TRIGGER_RUN_URL="${TRIGGER_RUN_URL:-}"
TRIGGER_ACTOR="${TRIGGER_ACTOR:-}"

if [[ -z "${DEPLOY_WEBHOOK_URL}" ]]; then
  echo "ERROR: production deploy webhook URL is not configured." >&2
  exit 2
fi

payload="$(jq -n \
  --arg reason "$DEPLOY_REASON" \
  --arg sha "$TARGET_SHA" \
  --arg ref "$TARGET_REF" \
  --arg repository "$TARGET_REPOSITORY" \
  --arg run_url "$TRIGGER_RUN_URL" \
  --arg actor "$TRIGGER_ACTOR" \
  '{reason:$reason, sha:$sha, ref:$ref, repository:$repository, run_url:$run_url, actor:$actor}')"

curl -sS -X POST "$DEPLOY_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  --data "$payload" >/dev/null

echo "PASS: production deploy webhook triggered."
