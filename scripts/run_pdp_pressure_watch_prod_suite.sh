#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${PDP_PRESSURE_BASE_URL:-https://agent.pivota.cc}"
ENDPOINT="${PDP_PRESSURE_ENDPOINT:-/api/gateway}"
OUT_DIR="${PDP_PRESSURE_OUT_DIR:-$ROOT_DIR/reports}"
ROUNDS="${PDP_PRESSURE_ROUNDS:-3}"
TIMEOUT_MS="${PDP_PRESSURE_TIMEOUT_MS:-8000}"
CONCURRENCY="${PDP_PRESSURE_CONCURRENCY:-4}"
CASE_FILE="${PDP_PRESSURE_CASE_FILE:-$ROOT_DIR/scripts/fixtures/pdp_pressure_watch.production-2026-04-09.json}"

echo "[pdp-pressure-watch] case_file=${CASE_FILE}"
echo "[pdp-pressure-watch] rounds=${ROUNDS} concurrency=${CONCURRENCY} timeout_ms=${TIMEOUT_MS}"

node "$ROOT_DIR/scripts/pdp_pressure_watch.js" \
  --base-url "$BASE_URL" \
  --endpoint "$ENDPOINT" \
  --case-file "$CASE_FILE" \
  --out-dir "$OUT_DIR" \
  --rounds "$ROUNDS" \
  --timeout-ms "$TIMEOUT_MS" \
  --concurrency "$CONCURRENCY"
