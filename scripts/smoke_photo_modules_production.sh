#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
LANG_HEADER="${LANG_HEADER:-EN}"
PHOTO_PATH="${PHOTO_PATH:-}"
SLOT_ID="${SLOT_ID:-daylight}"
AURORA_UID="${AURORA_UID:-uid_pm_prod_smoke_$(date +%s)}"
REPORT_OUT="${REPORT_OUT:-reports/photo_modules_production_smoke.md}"
CURL_RETRY_MAX="${CURL_RETRY_MAX:-4}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-2}"
CURL_CONNECT_TIMEOUT_SEC="${CURL_CONNECT_TIMEOUT_SEC:-8}"
CURL_MAX_TIME_SEC="${CURL_MAX_TIME_SEC:-45}"
SAMPLE_IMAGE_URL="${SAMPLE_IMAGE_URL:-https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg}"

for required_bin in curl jq python3; do
  if ! command -v "$required_bin" >/dev/null 2>&1; then
    echo "missing required command: $required_bin" >&2
    exit 2
  fi
done

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

should_retry_code() {
  local code="$1"
  shift
  local retry_codes="$*"
  for retry_code in $retry_codes; do
    if [[ "$code" == "$retry_code" ]]; then
      return 0
    fi
  done
  return 1
}

curl_with_retry() {
  local retry_codes="$1"
  shift
  local attempt=1
  local max_attempts="$CURL_RETRY_MAX"
  local delay_sec="$CURL_RETRY_DELAY_SEC"
  local exit_code=0
  local err_file
  err_file="$(mktemp)"
  while true; do
    if curl "$@" 2>"$err_file"; then
      rm -f "$err_file"
      return 0
    else
      exit_code=$?
    fi
    if (( attempt >= max_attempts )) || ! should_retry_code "$exit_code" $retry_codes; then
      cat "$err_file" >&2
      rm -f "$err_file"
      return "$exit_code"
    fi
    echo "curl retry: attempt=$attempt/$max_attempts exit_code=$exit_code" >&2
    sleep "$delay_sec"
    attempt=$((attempt + 1))
  done
}

curl_get_retry() {
  curl_with_retry "6 7 28 35 52 56" \
    -sS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_SEC" \
    --max-time "$CURL_MAX_TIME_SEC" \
    "$@"
}

curl_post_retry() {
  curl_with_retry "6 7 28 35 52 56" \
    -sS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_SEC" \
    --max-time "$CURL_MAX_TIME_SEC" \
    "$@"
}

normalize_json() {
  local input_file="$1"
  local output_file="$2"
  if jq -e . "$input_file" >/dev/null 2>&1; then
    cp "$input_file" "$output_file"
    return 0
  fi
  python3 - <<'PY' "$input_file" "$output_file"
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
raw = src.read_bytes()
filtered = bytes(ch for ch in raw if ch >= 32 or ch in (9, 10, 13))
text = filtered.decode("utf-8", errors="replace")

decoder = json.JSONDecoder()
result = None
for idx, ch in enumerate(text):
    if ch != "{":
        continue
    try:
        obj, _ = decoder.raw_decode(text[idx:])
        result = obj
        break
    except json.JSONDecodeError:
        continue

if result is None:
    raise SystemExit("failed to normalize JSON payload")

dst.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
PY
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$(dirname "$REPORT_OUT")"

IMAGE_FILE="$PHOTO_PATH"
if [[ -z "$IMAGE_FILE" ]]; then
  IMAGE_FILE="$TMP_DIR/sample.jpg"
  curl_get_retry "$SAMPLE_IMAGE_URL" -o "$IMAGE_FILE"
fi
if [[ ! -f "$IMAGE_FILE" ]]; then
  echo "photo file not found: $IMAGE_FILE" >&2
  exit 2
fi

UPLOAD_RAW="$TMP_DIR/upload.raw"
UPLOAD_JSON="$TMP_DIR/upload.json"
ANALYSIS_RAW="$TMP_DIR/analysis.raw"
ANALYSIS_JSON="$TMP_DIR/analysis.json"
SUMMARY_JSON="$TMP_DIR/summary.json"

STARTED_AT="$(timestamp_utc)"

curl_post_retry -X POST "$BASE/v1/photos/upload" \
  -H "X-Aurora-UID: $AURORA_UID" \
  -H "X-Lang: $LANG_HEADER" \
  -F "slot_id=$SLOT_ID" \
  -F 'consent=true' \
  -F "photo=@$IMAGE_FILE" >"$UPLOAD_RAW"

normalize_json "$UPLOAD_RAW" "$UPLOAD_JSON"

PHOTO_ID="$(jq -r '.cards[]? | select(.type=="photo_confirm") | .payload.photo_id // empty' "$UPLOAD_JSON" | head -n1)"
QC_STATUS="$(jq -r '.cards[]? | select(.type=="photo_confirm") | .payload.qc_status // "passed"' "$UPLOAD_JSON" | head -n1)"

if [[ -z "$PHOTO_ID" ]]; then
  echo "photo upload did not return photo_id" >&2
  jq '{request_id,trace_id,assistant_message,cards,errors}' "$UPLOAD_JSON" >&2 || true
  exit 1
fi

ANALYSIS_PAYLOAD="$(jq -n --arg pid "$PHOTO_ID" --arg qc "$QC_STATUS" --arg slot "$SLOT_ID" '{
  use_photo: true,
  currentRoutine: {
    am: [{step:"cleanser",product:"gentle cleanser"},{step:"moisturizer",product:"barrier moisturizer"}],
    pm: [{step:"cleanser",product:"gentle cleanser"},{step:"moisturizer",product:"barrier moisturizer"}]
  },
  photos: [{photo_id:$pid,slot_id:$slot,qc_status:$qc}]
}')"

curl_post_retry -X POST "$BASE/v1/analysis/skin" \
  -H 'Content-Type: application/json' \
  -H "X-Aurora-UID: $AURORA_UID" \
  -H "X-Lang: $LANG_HEADER" \
  --data "$ANALYSIS_PAYLOAD" >"$ANALYSIS_RAW"

normalize_json "$ANALYSIS_RAW" "$ANALYSIS_JSON"

python3 - <<'PY' "$ANALYSIS_JSON" "$SUMMARY_JSON"
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
data = json.loads(src.read_text(encoding="utf-8"))
cards = data.get("cards") or []

analysis_card = next((card for card in cards if card.get("type") == "analysis_summary"), None)
modules_card = next((card for card in cards if card.get("type") == "photo_modules_v1"), None)
if analysis_card is None:
    raise AssertionError("analysis_summary card missing")
if modules_card is None:
    raise AssertionError("photo_modules_v1 card missing")

analysis_payload = analysis_card.get("payload") or {}
modules_payload = modules_card.get("payload") or {}
if analysis_payload.get("used_photos") is not True:
    raise AssertionError("expected used_photos=true")

quality_grade = modules_payload.get("quality_grade")
if quality_grade not in {"pass", "degraded"}:
    raise AssertionError(f"expected quality_grade pass/degraded, got {quality_grade!r}")

regions = modules_payload.get("regions") or []
if not regions:
    raise AssertionError("regions must not be empty")

region_ids = [region.get("region_id") for region in regions]
if len(set(region_ids)) != len(region_ids):
    raise AssertionError("region_id values are not unique")

for region in regions:
    if region.get("coord_space") != "face_crop_norm_v1":
        raise AssertionError("region coord_space is not face_crop_norm_v1")
    heatmap = region.get("heatmap")
    if heatmap:
        grid = heatmap.get("grid") or {}
        values = heatmap.get("values") or []
        if grid.get("w") != 64 or grid.get("h") != 64:
            raise AssertionError("heatmap grid must be 64x64")
        if len(values) != 4096:
            raise AssertionError("heatmap values length must be 4096")
        for value in values:
            if not (0.0 <= float(value) <= 1.0):
                raise AssertionError("heatmap values must be in [0,1]")

region_set = set(region_ids)
modules = modules_payload.get("modules") or []
for module in modules:
    for issue in module.get("issues") or []:
        for evidence_id in issue.get("evidence_region_ids") or []:
            if evidence_id not in region_set:
                raise AssertionError(f"unmapped evidence_region_id: {evidence_id}")

serialized = json.dumps(modules_payload, ensure_ascii=False)
for forbidden_key in ("overlay_url", "server_overlay", "overlay_image"):
    if forbidden_key in serialized:
        raise AssertionError(f"forbidden field present: {forbidden_key}")

summary = {
    "request_id": data.get("request_id"),
    "analysis_source": analysis_payload.get("analysis_source"),
    "used_photos": analysis_payload.get("used_photos"),
    "quality_grade": quality_grade,
    "regions_count": len(regions),
    "modules_count": len(modules),
    "has_photo_modules_v1": True
}
out.write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
PY

FINISHED_AT="$(timestamp_utc)"

{
  echo "# Photo Modules Production Smoke"
  echo
  echo "- started_at_utc: $STARTED_AT"
  echo "- finished_at_utc: $FINISHED_AT"
  echo "- base: $BASE"
  echo "- aurora_uid: $AURORA_UID"
  echo "- image_file: $IMAGE_FILE"
  echo
  echo "## Result"
  echo
  jq . "$SUMMARY_JSON"
} >"$REPORT_OUT"

echo "PASS: photo_modules_v1 production smoke"
echo "Wrote $REPORT_OUT"
jq . "$SUMMARY_JSON"
