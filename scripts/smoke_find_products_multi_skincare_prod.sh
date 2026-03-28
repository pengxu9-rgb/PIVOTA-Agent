#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
DEFAULT_INVOKE_BASE_URL="https://pivota-agent-production.up.railway.app"
SMOKE_BASE_URL="${SMOKE_BASE_URL:-${COMMERCE_CORE_PROD_SMOKE_BASE_URL:-${BASE_URL}}}"
AUTH_TOKEN="${AUTH_TOKEN:-${COMMERCE_CORE_PROD_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${COMMERCE_CORE_PROD_AGENT_API_KEY:-}}"
ENDPOINT="${ENDPOINT:-${COMMERCE_CORE_PROD_SMOKE_ENDPOINT:-}}"
ROUNDS="${ROUNDS:-1}"
TIMEOUT_MS="${TIMEOUT_MS:-20000}"
OUT_DIR="${OUT_DIR:-reports/search-prod-skincare}"
QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/fixtures/find_products_multi_skincare_prod_gate.json}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-1}"

if [[ -z "${ENDPOINT}" ]]; then
  if [[ -n "${AUTH_TOKEN}" || -n "${AGENT_API_KEY}" ]]; then
    ENDPOINT="/agent/shop/v1/invoke"
  else
    ENDPOINT="/api/gateway"
  fi
fi

if [[ -z "${COMMERCE_CORE_PROD_SMOKE_BASE_URL:-}" && "${BASE_URL}" == "https://agent.pivota.cc" && "${ENDPOINT}" == "/agent/shop/v1/invoke" ]]; then
  SMOKE_BASE_URL="${DEFAULT_INVOKE_BASE_URL}"
fi

cd "${REPO_ROOT}"

if [[ "${VERIFY_DEPLOY}" == "1" ]]; then
  VERIFY_GATEWAY_ENDPOINT="${GATEWAY_ENDPOINT:-/api/gateway}"
  VERIFY_ALLOW_HEADER_FALLBACK="${ALLOW_HEADER_FALLBACK:-1}"
  if [[ "${ENDPOINT}" == "/agent/shop/v1/invoke" && ( -n "${AUTH_TOKEN}" || -n "${AGENT_API_KEY}" ) ]]; then
    VERIFY_GATEWAY_ENDPOINT=""
    VERIFY_ALLOW_HEADER_FALLBACK="0"
  fi
  BASE_URL="${BASE_URL}" \
  INVOKE_BASE_URL="${SMOKE_BASE_URL}" \
  AUTH_TOKEN="${AUTH_TOKEN}" \
  AGENT_API_KEY="${AGENT_API_KEY}" \
  GATEWAY_ENDPOINT="${VERIFY_GATEWAY_ENDPOINT}" \
  ALT_GATEWAY_ENDPOINT="${ENDPOINT}" \
  ALLOW_HEADER_FALLBACK="${VERIFY_ALLOW_HEADER_FALLBACK}" \
  bash "${SCRIPT_DIR}/verify_deployed_commit_matches.sh"
fi

args=(
  --base-url "${SMOKE_BASE_URL}"
  --endpoint "${ENDPOINT}" \
  --rounds "${ROUNDS}" \
  --timeout-ms "${TIMEOUT_MS}" \
  --out-dir "${OUT_DIR}" \
  --query-file "${QUERY_FILE}" \
  --source "search" \
  --fail-on-gate-failures
)

if [[ -n "${AUTH_TOKEN}" ]]; then
  args+=(--auth-token "${AUTH_TOKEN}")
fi

if [[ -n "${AGENT_API_KEY}" ]]; then
  args+=(--agent-api-key "${AGENT_API_KEY}")
fi

node "${SCRIPT_DIR}/search_stability_matrix.js" "${args[@]}"
