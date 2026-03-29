#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/fixtures/celestial_commerce_core_rollout_smoke_20.json}"
OUT_DIR="${OUT_DIR:-reports/celestial-commerce-core-rollout-smoke-20}"
ROUNDS="${ROUNDS:-1}"
TIMEOUT_MS="${TIMEOUT_MS:-15000}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-0}"
FAIL_ON_GATE_FAILURES="${FAIL_ON_GATE_FAILURES:-1}"

QUERY_FILE="${QUERY_FILE}" \
OUT_DIR="${OUT_DIR}" \
ROUNDS="${ROUNDS}" \
TIMEOUT_MS="${TIMEOUT_MS}" \
VERIFY_DEPLOY="${VERIFY_DEPLOY}" \
FAIL_ON_GATE_FAILURES="${FAIL_ON_GATE_FAILURES}" \
bash "${SCRIPT_DIR}/probe_celestial_commerce_core_prod_canary.sh"
