#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Supported staging commerce rail: POST /agent/shop/v1/invoke
BASE_URL="${BASE_URL:-${STAGING_BASE_URL:-https://pivota-agent-staging.up.railway.app}}"
OUT_DIR="${OUT_DIR:-reports/celestial-commerce-core-staging-invoke-smoke}"
CASES="${CASES:-${SCRIPT_DIR}/fixtures/celestial_commerce_core_staging_invoke_smoke.json}"
TIMEOUT_MS="${TIMEOUT_MS:-${CELESTIAL_COMMERCE_STAGING_TIMEOUT_MS:-15000}}"
RAIL_MODE="${RAIL_MODE:-${CELESTIAL_COMMERCE_STAGING_RAIL_MODE:-authoritative_commerce}}"

cd "${REPO_ROOT}"

node "${SCRIPT_DIR}/run_celestial_commerce_core_staging_matrix.js" \
  --base-url "${BASE_URL}" \
  --cases "${CASES}" \
  --out-dir "${OUT_DIR}" \
  --rail-mode "${RAIL_MODE}" \
  --timeout-ms "${TIMEOUT_MS}"
