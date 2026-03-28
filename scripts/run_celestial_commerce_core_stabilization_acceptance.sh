#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${OUT_DIR:-${REPO_ROOT}/reports/celestial-commerce-core-stabilization}"
STAGING_BASE_URL="${STAGING_BASE_URL:-https://pivota-agent-staging.up.railway.app}"
STAGING_MATRIX_CASES_PATH="${STAGING_MATRIX_CASES_PATH:-${REPO_ROOT}/scripts/fixtures/celestial_commerce_core_staging_acceptance_matrix.json}"
STAGING_TIMEOUT_MS="${STAGING_TIMEOUT_MS:-15000}"
RUN_STAGING_MATRIX="${RUN_STAGING_MATRIX:-1}"

GATEWAY_GOVERNANCE_LOG_INPUT_PATH="${GATEWAY_GOVERNANCE_LOG_INPUT_PATH:-}"
GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH="${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH:-}"
if [[ -z "${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}" && -z "${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH}" ]]; then
  GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH="${REPO_ROOT}/scripts/fixtures/celestial_commerce_gateway_governance_shadow_runtime_sample.ndjson"
fi

timestamp() {
  date -u +"%Y%m%d_%H%M%S"
}

latest_match() {
  local root="$1"
  local filename="$2"
  find "${root}" -type f -name "${filename}" 2>/dev/null | sort | tail -n 1
}

TS="$(timestamp)"
RUN_DIR="${OUT_DIR}/${TS}"
REPORT_MD="${RUN_DIR}/README.md"
SUMMARY_JSON="${RUN_DIR}/summary.json"
STEPS_JSON="${RUN_DIR}/steps.json"
mkdir -p "${RUN_DIR}"

STEP_NAMES=()
STEP_STATUSES=()
STEP_LOGS=()

run_step() {
  local name="$1"
  shift
  local slug
  slug="$(echo "${name}" | tr '[:upper:]' '[:lower:]' | tr ' /:' '___' | tr -cd 'a-z0-9_')"
  local log_file="${RUN_DIR}/${slug}.log"
  STEP_NAMES+=("${name}")
  STEP_LOGS+=("${log_file}")
  if "$@" >"${log_file}" 2>&1; then
    STEP_STATUSES+=("pass")
  else
    STEP_STATUSES+=("fail")
  fi
}

node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"
if [[ -z "${node_bin}" || -z "${npm_bin}" ]]; then
  echo "node and npm are required" >&2
  exit 2
fi

run_step \
  "boundary" \
  bash -lc "cd '${REPO_ROOT}' && '${node_bin}' scripts/verify_celestial_commerce_core_boundaries.js"

run_step \
  "milestone0" \
  bash -lc "cd '${REPO_ROOT}' && '${npm_bin}' run test:commerce-core:milestone0"

run_step \
  "integration_find_products_multi" \
  bash -lc "cd '${REPO_ROOT}' && npx jest --runInBand tests/integration/invoke.find_products_multi_cache_search.test.js tests/integration/invoke.find_products_multi_strict_surface.test.js"

READINESS_ROOT="${RUN_DIR}/readiness"
run_step \
  "readiness_audit" \
  bash -lc "cd '${REPO_ROOT}' && OUT_DIR='${READINESS_ROOT}' GATEWAY_GOVERNANCE_LOG_INPUT_PATH='${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}' GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH='${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH}' '${npm_bin}' run audit:readiness:commerce-core"

readiness_report_path="$(latest_match "${READINESS_ROOT}" 'README.md')"
readiness_summary_path="$(latest_match "${READINESS_ROOT}" 'summary.json')"

GATEWAY_DAILY_ROOT="${RUN_DIR}/gateway_daily"
run_step \
  "gateway_governance_daily" \
  bash -lc "cd '${REPO_ROOT}' && OUT_DIR='${GATEWAY_DAILY_ROOT}' GATEWAY_GOVERNANCE_LOG_INPUT_PATH='${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}' GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH='${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH}' '${npm_bin}' run audit:gateway-governance:daily"

gateway_daily_report_path="$(latest_match "${GATEWAY_DAILY_ROOT}" 'README.md')"
gateway_daily_summary_path="$(latest_match "${GATEWAY_DAILY_ROOT}" 'summary.json')"

STAGING_MATRIX_ROOT="${RUN_DIR}/staging_matrix"
staging_matrix_report_path=""
staging_matrix_summary_path=""
if [[ "${RUN_STAGING_MATRIX}" == "1" ]]; then
  run_step \
    "staging_matrix" \
    bash -lc "cd '${REPO_ROOT}' && '${node_bin}' scripts/run_celestial_commerce_core_staging_matrix.js --base-url '${STAGING_BASE_URL}' --cases '${STAGING_MATRIX_CASES_PATH}' --out-dir '${STAGING_MATRIX_ROOT}' --timeout-ms '${STAGING_TIMEOUT_MS}'"
  staging_matrix_report_path="${STAGING_MATRIX_ROOT}/celestial_commerce_core_staging_matrix.md"
  staging_matrix_summary_path="${STAGING_MATRIX_ROOT}/celestial_commerce_core_staging_matrix.json"
else
  STEP_NAMES+=("staging_matrix")
  STEP_STATUSES+=("skipped")
  STEP_LOGS+=("${RUN_DIR}/staging_matrix_skipped.log")
  printf 'staging matrix skipped (RUN_STAGING_MATRIX=%s)\n' "${RUN_STAGING_MATRIX}" >"${RUN_DIR}/staging_matrix_skipped.log"
fi

STEP_NAMES_PATH="${RUN_DIR}/step_names.txt"
STEP_STATUSES_PATH="${RUN_DIR}/step_statuses.txt"
STEP_LOGS_PATH="${RUN_DIR}/step_logs.txt"
printf "%s\n" "${STEP_NAMES[@]}" >"${STEP_NAMES_PATH}"
printf "%s\n" "${STEP_STATUSES[@]}" >"${STEP_STATUSES_PATH}"
printf "%s\n" "${STEP_LOGS[@]}" >"${STEP_LOGS_PATH}"

python3 - "${STEP_NAMES_PATH}" "${STEP_STATUSES_PATH}" "${STEP_LOGS_PATH}" "${STEPS_JSON}" <<'PY'
import json
import pathlib
import sys

names = pathlib.Path(sys.argv[1]).read_text().splitlines()
statuses = pathlib.Path(sys.argv[2]).read_text().splitlines()
logs = pathlib.Path(sys.argv[3]).read_text().splitlines()
steps = []
for name, status, log in zip(names, statuses, logs):
    steps.append({"name": name, "status": status, "log": log})
pathlib.Path(sys.argv[4]).write_text(json.dumps({"steps": steps}, indent=2) + "\n")
PY

"${node_bin}" "${REPO_ROOT}/scripts/generate_celestial_commerce_core_stabilization_report.js" \
  --repo-root "${REPO_ROOT}" \
  --out-dir "${RUN_DIR}" \
  --steps "${STEPS_JSON}" \
  --readiness-summary "${readiness_summary_path}" \
  --readiness-report "${readiness_report_path}" \
  --gateway-daily-summary "${gateway_daily_summary_path}" \
  --gateway-daily-report "${gateway_daily_report_path}" \
  --staging-matrix-summary "${staging_matrix_summary_path}" \
  --staging-matrix-report "${staging_matrix_report_path}" >"${RUN_DIR}/stabilization_report.log"

echo "Commerce core stabilization report: ${RUN_DIR}/README.md"
