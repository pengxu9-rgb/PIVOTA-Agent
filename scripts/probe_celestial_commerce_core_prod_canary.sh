#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
DEFAULT_INVOKE_BASE_URL="https://pivota-agent-production.up.railway.app"
CANARY_BASE_URL="${COMMERCE_CORE_PROD_CANARY_BASE_URL:-${BASE_URL}}"
ROUNDS="${ROUNDS:-1}"
TIMEOUT_MS="${TIMEOUT_MS:-15000}"
OUT_DIR="${OUT_DIR:-reports/celestial-commerce-core-prod-canary}"
QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/fixtures/celestial_commerce_core_prod_canary.json}"
SOURCE="${SOURCE:-search}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-0}"
FAIL_ON_GATE_FAILURES="${FAIL_ON_GATE_FAILURES:-0}"
EVAL_MODE="${EVAL_MODE:-0}"
AUTH_TOKEN="${AUTH_TOKEN:-${COMMERCE_CORE_PROD_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${COMMERCE_CORE_PROD_AGENT_API_KEY:-}}"
ENDPOINT="${ENDPOINT:-${COMMERCE_CORE_PROD_CANARY_ENDPOINT:-}}"

if [[ -z "${ENDPOINT}" ]]; then
  if [[ -n "${AUTH_TOKEN}" || -n "${AGENT_API_KEY}" ]]; then
    ENDPOINT="/agent/shop/v1/invoke"
  else
    ENDPOINT="/api/gateway"
  fi
fi

if [[ -z "${COMMERCE_CORE_PROD_CANARY_BASE_URL:-}" && "${BASE_URL}" == "https://agent.pivota.cc" && "${ENDPOINT}" == "/agent/shop/v1/invoke" ]]; then
  CANARY_BASE_URL="${DEFAULT_INVOKE_BASE_URL}"
fi

cd "${REPO_ROOT}"

if [[ "${VERIFY_DEPLOY}" == "1" ]]; then
  BASE_URL="${CANARY_BASE_URL}" bash "${SCRIPT_DIR}/verify_deployed_commit_matches.sh"
fi

args=(
  --base-url "${CANARY_BASE_URL}"
  --endpoint "${ENDPOINT}"
  --rounds "${ROUNDS}"
  --timeout-ms "${TIMEOUT_MS}"
  --out-dir "${OUT_DIR}"
  --query-file "${QUERY_FILE}"
  --source "${SOURCE}"
)

if [[ "${EVAL_MODE}" == "1" ]]; then
  args+=(--eval-mode)
fi

if [[ "${FAIL_ON_GATE_FAILURES}" == "1" ]]; then
  args+=(--fail-on-gate-failures)
fi

if [[ -n "${AUTH_TOKEN}" ]]; then
  args+=(--auth-token "${AUTH_TOKEN}")
fi

if [[ -n "${AGENT_API_KEY}" ]]; then
  args+=(--agent-api-key "${AGENT_API_KEY}")
fi

node "${SCRIPT_DIR}/search_stability_matrix.js" "${args[@]}"
