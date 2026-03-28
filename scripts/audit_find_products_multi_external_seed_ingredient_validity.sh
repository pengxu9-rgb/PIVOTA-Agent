#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RAIL_MODE="${RAIL_MODE:-authoritative_commerce}"
DEFAULT_INVOKE_BASE_URL="https://pivota-agent-production.up.railway.app"
BASE_URL="${BASE_URL:-${DEFAULT_INVOKE_BASE_URL}}"
AUTH_TOKEN="${AUTH_TOKEN:-${COMMERCE_CORE_PROD_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${COMMERCE_CORE_PROD_AGENT_API_KEY:-}}"
ENDPOINT="${ENDPOINT:-${COMMERCE_CORE_PROD_SMOKE_ENDPOINT:-/agent/shop/v1/invoke}}"
ROUNDS="${ROUNDS:-1}"
TIMEOUT_MS="${TIMEOUT_MS:-20000}"
OUT_DIR="${OUT_DIR:-reports/search-external-seed-ingredient-validity}"
QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/fixtures/find_products_multi_external_seed_ingredient_validity_batch.json}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-1}"
FAIL_ON_GATE_FAILURES="${FAIL_ON_GATE_FAILURES:-0}"

SMOKE_BASE_URL="${SMOKE_BASE_URL:-${COMMERCE_CORE_PROD_SMOKE_BASE_URL:-${BASE_URL}}}"
if [[ "${RAIL_MODE}" == "authoritative_commerce" && -z "${AUTH_TOKEN}" && -z "${AGENT_API_KEY}" ]]; then
  echo "audit_find_products_multi_external_seed_ingredient_validity.sh requires AUTH_TOKEN or AGENT_API_KEY for authoritative_commerce" >&2
  exit 2
fi

cd "${REPO_ROOT}"

if [[ "${VERIFY_DEPLOY}" == "1" ]]; then
  BASE_URL="${BASE_URL}" \
  INVOKE_BASE_URL="${SMOKE_BASE_URL}" \
  AUTH_TOKEN="${AUTH_TOKEN}" \
  AGENT_API_KEY="${AGENT_API_KEY}" \
  ALT_GATEWAY_ENDPOINT="${ENDPOINT}" \
  RAIL_MODE="${RAIL_MODE}" \
  bash "${SCRIPT_DIR}/verify_deployed_commit_matches.sh"
fi

args=(
  --base-url "${SMOKE_BASE_URL}"
  --endpoint "${ENDPOINT}"
  --rail-mode "${RAIL_MODE}"
  --rounds "${ROUNDS}"
  --timeout-ms "${TIMEOUT_MS}"
  --out-dir "${OUT_DIR}"
  --query-file "${QUERY_FILE}"
  --source "search"
)

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
