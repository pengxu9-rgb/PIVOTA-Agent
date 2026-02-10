#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

REPORT_DIR="reports"
REPORT_FILE="$REPORT_DIR/photo_modules_backend_acceptance.md"
TMP_LOG="$(mktemp)"

mkdir -p "$REPORT_DIR"

COMMAND='node --test tests/aurora_bff_photo_modules_acceptance.node.test.cjs'
STARTED_AT_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

set +e
eval "$COMMAND" >"$TMP_LOG" 2>&1
STATUS=$?
set -e

RESULT="PASS"
if [ "$STATUS" -ne 0 ]; then
  RESULT="FAIL"
fi

{
  echo "# Photo Modules Backend Acceptance"
  echo
  echo "- started_at_utc: ${STARTED_AT_UTC}"
  echo "- command: \`${COMMAND}\`"
  echo "- result: **${RESULT}**"
  echo
  echo "## Assertions"
  echo
  echo "- \`/v1/analysis/skin\` returns \`photo_modules_v1\` when \`used_photos=true\`"
  echo "- all region \`coord_space\` values are \`face_crop_norm_v1\`"
  echo "- every heatmap is \`64x64\` with \`values.length=4096\` and values in \`[0,1]\`"
  echo "- \`regions[].region_id\` values are unique"
  echo "- all \`modules[].issues[].evidence_region_ids\` map to existing region ids"
  echo "- payload does not include \`overlay_url\` or server overlay fields"
  echo
  echo "## Test Output"
  echo
  echo '```text'
  cat "$TMP_LOG"
  echo '```'
} >"$REPORT_FILE"

rm -f "$TMP_LOG"

echo "Wrote ${REPORT_FILE}"
exit "$STATUS"
