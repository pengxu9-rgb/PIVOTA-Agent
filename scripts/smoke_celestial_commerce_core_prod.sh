#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
ENDPOINT="${ENDPOINT:-/api/gateway}"
ROUNDS="${ROUNDS:-1}"
TIMEOUT_MS="${TIMEOUT_MS:-25000}"
OUT_DIR="${OUT_DIR:-reports/celestial-commerce-core-prod-smoke}"
QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/fixtures/celestial_commerce_core_prod_gate.json}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-1}"

cd "${REPO_ROOT}"

if [[ "${VERIFY_DEPLOY}" == "1" ]]; then
  BASE_URL="${BASE_URL}" bash "${SCRIPT_DIR}/verify_deployed_commit_matches.sh"
fi

node "${SCRIPT_DIR}/search_stability_matrix.js" \
  --base-url "${BASE_URL}" \
  --endpoint "${ENDPOINT}" \
  --rounds "${ROUNDS}" \
  --timeout-ms "${TIMEOUT_MS}" \
  --out-dir "${OUT_DIR}" \
  --query-file "${QUERY_FILE}" \
  --source "search" \
  --fail-on-gate-failures
