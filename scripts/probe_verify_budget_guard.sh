#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
LANG_HEADER="${LANG_HEADER:-EN}"
CALLS="${CALLS:-3}"
WAIT_AFTER_SEC="${WAIT_AFTER_SEC:-12}"
SLEEP_BETWEEN_SEC="${SLEEP_BETWEEN_SEC:-1}"
EXPECT_GUARD="${EXPECT_GUARD:-0}"
IMG_URL="${IMG_URL:-https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg}"
AURORA_UID="${AURORA_UID:-uid_verify_guard_$(date +%s)}"
CURL_RETRY_MAX="${CURL_RETRY_MAX:-6}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-2}"
CURL_CONNECT_TIMEOUT_SEC="${CURL_CONNECT_TIMEOUT_SEC:-8}"
CURL_MAX_TIME_SEC="${CURL_MAX_TIME_SEC:-30}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

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
  curl_with_retry "6 7" \
    -sS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_SEC" \
    --max-time "$CURL_MAX_TIME_SEC" \
    "$@"
}

metric_sum() {
  local metric_name="$1"
  curl_get_retry "$BASE/metrics" \
    | awk -v m="$metric_name" '($1==m || $1 ~ ("^" m "\\{")) {sum+=$NF} END {if (sum=="") sum=0; printf "%.0f\n", sum+0}'
}

metric_labeled() {
  local metric_name="$1"
  local label_match="$2"
  curl_get_retry "$BASE/metrics" \
    | awk -v m="$metric_name" -v l="$label_match" 'index($0, m "{") == 1 && index($0, l) > 0 {sum+=$NF} END {if (sum=="") sum=0; printf "%.0f\n", sum+0}'
}

echo "== verify guard probe =="
echo "BASE=$BASE"
echo "AURORA_UID=$AURORA_UID"
echo "CALLS=$CALLS WAIT_AFTER_SEC=$WAIT_AFTER_SEC EXPECT_GUARD=$EXPECT_GUARD"

before_calls_total="$(metric_sum verify_calls_total)"
before_fail_total="$(metric_sum verify_fail_total)"
before_guard_total="$(metric_sum verify_budget_guard_total)"
before_calls_guard="$(metric_labeled verify_calls_total 'status="guard"')"

echo "before: verify_calls_total=$before_calls_total verify_fail_total=$before_fail_total verify_budget_guard_total=$before_guard_total verify_calls_total{status=guard}=$before_calls_guard"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
img_path="$tmp_dir/probe.jpg"

curl_with_retry "6 7 28 35 52 56" \
  -fsSL \
  --connect-timeout "$CURL_CONNECT_TIMEOUT_SEC" \
  --max-time "$CURL_MAX_TIME_SEC" \
  "$IMG_URL" \
  -o "$img_path"

upload_json="$(curl_post_retry -X POST "$BASE/v1/photos/upload" \
  -H "X-Aurora-UID: $AURORA_UID" \
  -H "X-Lang: $LANG_HEADER" \
  -F 'slot_id=daylight' \
  -F 'consent=true' \
  -F "photo=@$img_path;type=image/jpeg")"

photo_id="$(printf '%s' "$upload_json" | jq -r '.cards[] | select(.type=="photo_confirm") | .payload.photo_id' | head -n1)"
qc_status="$(printf '%s' "$upload_json" | jq -r '.cards[] | select(.type=="photo_confirm") | .payload.qc_status' | head -n1)"

if [[ -z "$photo_id" || "$photo_id" == "null" ]]; then
  echo "photo upload failed" >&2
  printf '%s\n' "$upload_json" | jq '{assistant_message,cards,events}' >&2
  exit 1
fi

echo "photo: id=$photo_id qc_status=${qc_status:-unknown}"

analysis_payload="$(jq -n --arg pid "$photo_id" --arg qc "${qc_status:-passed}" '{
  use_photo: true,
  currentRoutine: {
    am: [ { step: "cleanser", product: "gentle cleanser" } ],
    pm: [ { step: "moisturizer", product: "barrier cream" } ]
  },
  photos: [
    { photo_id: $pid, slot_id: "daylight", qc_status: (if ($qc == "" or $qc == "null") then "passed" else $qc end) }
  ]
}')"

for i in $(seq 1 "$CALLS"); do
  echo "analysis call $i/$CALLS"
  analysis_json="$(curl_post_retry -X POST "$BASE/v1/analysis/skin" \
    -H 'Content-Type: application/json' \
    -H "X-Aurora-UID: $AURORA_UID" \
    -H "X-Lang: $LANG_HEADER" \
    --data "$analysis_payload")"
  printf '%s' "$analysis_json" | jq -r '.cards[] | select(.type=="analysis_summary") | "  used_photos=\(.payload.used_photos) quality=\(.payload.quality_report.photo_quality.grade) source=\(.payload.analysis_source)"'
  sleep "$SLEEP_BETWEEN_SEC"
done

echo "waiting ${WAIT_AFTER_SEC}s for async verifier flush..."
sleep "$WAIT_AFTER_SEC"

after_calls_total="$(metric_sum verify_calls_total)"
after_fail_total="$(metric_sum verify_fail_total)"
after_guard_total="$(metric_sum verify_budget_guard_total)"
after_calls_guard="$(metric_labeled verify_calls_total 'status="guard"')"

delta_calls_total=$((after_calls_total - before_calls_total))
delta_fail_total=$((after_fail_total - before_fail_total))
delta_guard_total=$((after_guard_total - before_guard_total))
delta_calls_guard=$((after_calls_guard - before_calls_guard))

echo "after:  verify_calls_total=$after_calls_total verify_fail_total=$after_fail_total verify_budget_guard_total=$after_guard_total verify_calls_total{status=guard}=$after_calls_guard"
echo "delta:  verify_calls_total=$delta_calls_total verify_fail_total=$delta_fail_total verify_budget_guard_total=$delta_guard_total verify_calls_total{status=guard}=$delta_calls_guard"

echo "-- verify_calls_total labels --"
curl_get_retry "$BASE/metrics" | awk '/^verify_calls_total\{/{print}'

echo "-- verify_fail_total labels --"
curl_get_retry "$BASE/metrics" | awk '/^verify_fail_total\{/{print}'

echo "-- verify_budget_guard_total --"
curl_get_retry "$BASE/metrics" | awk '/^verify_budget_guard_total/{print}'

if [[ "$EXPECT_GUARD" == "1" ]]; then
  if (( delta_guard_total <= 0 && delta_calls_guard <= 0 )); then
    echo "guard expectation failed: no budget guard increments observed" >&2
    exit 3
  fi
fi

echo "probe done"
