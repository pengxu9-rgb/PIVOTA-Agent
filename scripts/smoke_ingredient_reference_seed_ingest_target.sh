#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_BIN="${PY_BIN:-$(command -v python3)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

INGREDIENT_XLSX="${1:-${INGREDIENT_XLSX:-}}"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/artifacts/ingredient_reference_seed_ingest_live_smoke_$(date +%Y%m%dT%H%M%S)}"

if [[ -z "${PY_BIN:-}" || -z "${NODE_BIN:-}" ]]; then
  echo "python3 and node are required." >&2
  exit 2
fi

if [[ -z "${INGREDIENT_XLSX:-}" ]]; then
  echo "Usage: bash scripts/smoke_ingredient_reference_seed_ingest_target.sh /path/to/ingredient_reference.xlsx" >&2
  echo "Or set INGREDIENT_XLSX=/path/to/ingredient_reference.xlsx" >&2
  exit 2
fi

if [[ ! -f "${INGREDIENT_XLSX}" ]]; then
  echo "ingredient workbook not found: ${INGREDIENT_XLSX}" >&2
  exit 2
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required for the live seed_ingest target smoke." >&2
  exit 2
fi

mkdir -p "${OUT_DIR}"

BUNDLE_CSV="${OUT_DIR}/ingredient_reference_seed_ingest.csv"
MANIFEST_JSON="${OUT_DIR}/ingredient_reference_seed_ingest_manifest.json"
COPY_SQL="${OUT_DIR}/ingredient_reference_seed_ingest_copy.sql"
TARGET_CHECK_JSON="${OUT_DIR}/ingredient_reference_seed_ingest_target_check.json"
DDL_SQL="${OUT_DIR}/ingredient_reference_seed_ingest_create.sql"

echo "== Export bundle =="
"${PY_BIN}" "${ROOT_DIR}/scripts/export_ingredient_reference_seed_ingest_bundle.py" \
  --ingredient-xlsx "${INGREDIENT_XLSX}" \
  --out-csv "${BUNDLE_CSV}" \
  --out-manifest-json "${MANIFEST_JSON}" \
  --out-copy-sql "${COPY_SQL}"

echo
echo "== Live target check =="
"${NODE_BIN}" "${ROOT_DIR}/scripts/check_ingredient_reference_seed_ingest_target.js" \
  --bundle-manifest-json "${MANIFEST_JSON}" \
  --out-json "${TARGET_CHECK_JSON}"

echo
echo "== Summary =="
"${PY_BIN}" - "${MANIFEST_JSON}" "${TARGET_CHECK_JSON}" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
check = json.load(open(sys.argv[2], encoding="utf-8"))

print(f"target_table: {check.get('target_table')}")
print(f"bundle_row_count: {manifest.get('row_count')}")
print(f"table_exists: {check.get('table_exists')}")
print(f"copy_ready: {check.get('copy_ready')}")
print(f"missing_in_db: {check.get('missing_in_db')}")
print(f"extra_in_db: {check.get('extra_in_db')}")
print(f"manifest_column_count: {check.get('manifest_column_count')}")
print(f"db_column_count: {check.get('db_column_count')}")
PY

COPY_READY="$("${PY_BIN}" - "${TARGET_CHECK_JSON}" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
print("true" if payload.get("copy_ready") else "false")
PY
)"

if [[ "${COPY_READY}" != "true" ]]; then
  echo
  echo "== Generate conservative DDL template =="
  "${PY_BIN}" "${ROOT_DIR}/scripts/generate_ingredient_reference_seed_ingest_ddl.py" \
    --bundle-manifest-json "${MANIFEST_JSON}" \
    --out-sql "${DDL_SQL}"
  echo "seed_ingest target is not copy-ready. DDL template: ${DDL_SQL}" >&2
  exit 1
fi

echo "seed_ingest target is copy-ready. Artifacts: ${OUT_DIR}"
