#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
ENDPOINT="${ENDPOINT:-${COMMERCE_CORE_PROD_SMOKE_ENDPOINT:-/api/gateway}}"
DEFAULT_INVOKE_BASE_URL="https://pivota-agent-production.up.railway.app"
SMOKE_BASE_URL="${COMMERCE_CORE_PROD_SMOKE_BASE_URL:-${BASE_URL}}"
ROUNDS="${ROUNDS:-1}"
TIMEOUT_MS="${TIMEOUT_MS:-25000}"
OUT_DIR="${OUT_DIR:-reports/celestial-commerce-core-prod-smoke}"
QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/fixtures/celestial_commerce_core_prod_gate.json}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-1}"
AUTH_TOKEN="${AUTH_TOKEN:-${COMMERCE_CORE_PROD_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${COMMERCE_CORE_PROD_AGENT_API_KEY:-}}"

if [[ -z "${COMMERCE_CORE_PROD_SMOKE_BASE_URL:-}" && "${BASE_URL}" == "https://agent.pivota.cc" && "${ENDPOINT}" == "/agent/shop/v1/invoke" ]]; then
  SMOKE_BASE_URL="${DEFAULT_INVOKE_BASE_URL}"
fi

cd "${REPO_ROOT}"

if [[ "${VERIFY_DEPLOY}" == "1" ]]; then
  BASE_URL="${SMOKE_BASE_URL}" bash "${SCRIPT_DIR}/verify_deployed_commit_matches.sh"
fi

args=(
  --base-url "${SMOKE_BASE_URL}"
  --endpoint "${ENDPOINT}"
  --rounds "${ROUNDS}"
  --timeout-ms "${TIMEOUT_MS}"
  --out-dir "${OUT_DIR}"
  --query-file "${QUERY_FILE}"
  --source "search"
  --fail-on-gate-failures
)

if [[ -n "${AUTH_TOKEN}" ]]; then
  args+=(--auth-token "${AUTH_TOKEN}")
fi

if [[ -n "${AGENT_API_KEY}" ]]; then
  args+=(--agent-api-key "${AGENT_API_KEY}")
fi

node "${SCRIPT_DIR}/search_stability_matrix.js" "${args[@]}"
