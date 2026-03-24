#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
ENDPOINT="${ENDPOINT:-/api/gateway}"
ROUNDS="${ROUNDS:-1}"
TIMEOUT_MS="${TIMEOUT_MS:-20000}"
OUT_DIR="${OUT_DIR:-reports/search-external-seed-ingredient-validity}"
QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/fixtures/find_products_multi_external_seed_ingredient_validity_batch.json}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-1}"
FAIL_ON_GATE_FAILURES="${FAIL_ON_GATE_FAILURES:-0}"

cd "${REPO_ROOT}"

if [[ "${VERIFY_DEPLOY}" == "1" ]]; then
  bash "${SCRIPT_DIR}/verify_deployed_commit_matches.sh"
fi

args=(
  --base-url "${BASE_URL}"
  --endpoint "${ENDPOINT}"
  --rounds "${ROUNDS}"
  --timeout-ms "${TIMEOUT_MS}"
  --out-dir "${OUT_DIR}"
  --query-file "${QUERY_FILE}"
  --source "search"
)

if [[ "${FAIL_ON_GATE_FAILURES}" == "1" ]]; then
  args+=(--fail-on-gate-failures)
fi

node "${SCRIPT_DIR}/search_stability_matrix.js" "${args[@]}"
