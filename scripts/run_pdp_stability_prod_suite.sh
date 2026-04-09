#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${PDP_STABILITY_BASE_URL:-https://agent.pivota.cc}"
DEFAULT_PUBLIC_ENDPOINT="/api"
DEFAULT_PUBLIC_ENDPOINT="${DEFAULT_PUBLIC_ENDPOINT}/gateway"
ENDPOINT="${PDP_STABILITY_ENDPOINT:-$DEFAULT_PUBLIC_ENDPOINT}"
OUT_DIR="${PDP_STABILITY_OUT_DIR:-$ROOT_DIR/reports}"
ROUNDS="${PDP_STABILITY_ROUNDS:-1}"

BASELINE_CASE_FILE="${PDP_STABILITY_BASELINE_CASE_FILE:-$ROOT_DIR/scripts/fixtures/pdp_stability_cases.production-baseline-2026-04-09.json}"
POSTFIX_CASE_FILE="${PDP_STABILITY_POSTFIX_CASE_FILE:-$ROOT_DIR/scripts/fixtures/pdp_stability_cases.production-postfix-2026-04-09.json}"

run_matrix() {
  local label="$1"
  local case_file="$2"

  echo "[pdp-stability] running ${label}"
  echo "[pdp-stability] case_file=${case_file}"

  node "$ROOT_DIR/scripts/pdp_stability_matrix.js" \
    --base-url "$BASE_URL" \
    --endpoint "$ENDPOINT" \
    --case-file "$case_file" \
    --out-dir "$OUT_DIR" \
    --rounds "$ROUNDS"
}

run_matrix "baseline" "$BASELINE_CASE_FILE"
run_matrix "postfix-target" "$POSTFIX_CASE_FILE"
