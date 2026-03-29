#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-https://pivota-agent-production.up.railway.app}"
ENDPOINT="${ENDPOINT:-/agent/shop/v1/invoke}"
CASES_PATH="${CASES_PATH:-${SCRIPT_DIR}/fixtures/celestial_commerce_core_aurora_rollout_smoke_20.json}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/reports/celestial-commerce-core-aurora-rollout-smoke-20}"
AUTH_TOKEN="${AUTH_TOKEN:-${COMMERCE_CORE_PROD_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${COMMERCE_CORE_PROD_AGENT_API_KEY:-}}"

args=(
  --base-url "${BASE_URL}"
  --endpoint "${ENDPOINT}"
  --cases "${CASES_PATH}"
  --out-dir "${OUT_DIR}"
)

if [[ -n "${AUTH_TOKEN}" ]]; then
  args+=(--auth-token "${AUTH_TOKEN}")
fi

if [[ -n "${AGENT_API_KEY}" ]]; then
  args+=(--agent-api-key "${AGENT_API_KEY}")
fi

node "${SCRIPT_DIR}/run_celestial_commerce_core_aurora_manual_review.js" "${args[@]}"
