#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
DURATION_MIN="${DURATION_MIN:-10}"
REQUESTS_PER_MIN="${REQUESTS_PER_MIN:-5}"
LANGS="${LANGS:-EN,CN}"
CURL_MAX_TIME_SEC="${CURL_MAX_TIME_SEC:-30}"
SAMPLE_IMAGE_URL="${SAMPLE_IMAGE_URL:-https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg}"

for required_bin in curl jq mktemp; do
  if ! command -v "$required_bin" >/dev/null 2>&1; then
    echo "missing required command: $required_bin" >&2
    exit 2
  fi
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TOTAL_REQUESTS=$(( DURATION_MIN * REQUESTS_PER_MIN ))
if (( TOTAL_REQUESTS < 1 )); then
  TOTAL_REQUESTS=1
fi

IFS=',' read -r -a LANG_ARRAY <<<"$LANGS"
if (( ${#LANG_ARRAY[@]} == 0 )); then
  LANG_ARRAY=("EN" "CN")
fi

SAMPLE_IMAGE_PATH="$TMP_DIR/sample.jpg"
curl -fsSL "$SAMPLE_IMAGE_URL" -o "$SAMPLE_IMAGE_PATH"

total_calls=0
http_5xx_count=0
timeout_degraded_count=0
reco_output_guard_fallback_count=0
empty_cards_count=0

say() { printf "\n== %s ==\n" "$1"; }

rand_uid() {
  local seed="$1"
  printf "uid_soak_%s_%s_%s" "$seed" "$(date +%s)" "$RANDOM"
}

post_json() {
  local out_body="$1"
  local out_code_var="$2"
  local uid="$3"
  local lang="$4"
  local path="$5"
  local body="$6"
  local code
  code="$(
    curl -sS -m "$CURL_MAX_TIME_SEC" -o "$out_body" -w "%{http_code}" \
      -X POST "${BASE}${path}" \
      -H "Content-Type: application/json" \
      -H "X-Aurora-UID: ${uid}" \
      -H "X-Lang: ${lang}" \
      -H "X-Trace-ID: trace_${uid}" \
      -H "X-Brief-ID: brief_${uid}" \
      --data "$body" || true
  )"
  printf -v "$out_code_var" '%s' "${code:-000}"
}

post_multipart_photo_upload() {
  local out_body="$1"
  local out_code_var="$2"
  local uid="$3"
  local lang="$4"
  local code
  code="$(
    curl -sS -m "$CURL_MAX_TIME_SEC" -o "$out_body" -w "%{http_code}" \
      -X POST "${BASE}/v1/photos/upload" \
      -H "X-Aurora-UID: ${uid}" \
      -H "X-Lang: ${lang}" \
      -F "slot_id=daylight" \
      -F "consent=true" \
      -F "photo=@${SAMPLE_IMAGE_PATH}" || true
  )"
  printf -v "$out_code_var" '%s' "${code:-000}"
}

record_response_stats() {
  local body_file="$1"
  local code="$2"
  total_calls=$((total_calls + 1))
  if [[ "$code" =~ ^5 ]]; then
    http_5xx_count=$((http_5xx_count + 1))
  fi
  if ! jq -e . "$body_file" >/dev/null 2>&1; then
    return 0
  fi
  if jq -e '.cards | arrays | length == 0' "$body_file" >/dev/null 2>&1; then
    empty_cards_count=$((empty_cards_count + 1))
  fi
  if jq -e '.cards | arrays | any((.type=="confidence_notice") and (.payload.reason=="timeout_degraded"))' "$body_file" >/dev/null 2>&1; then
    timeout_degraded_count=$((timeout_degraded_count + 1))
  fi
  if jq -e '.events | arrays | any(.event_name=="reco_output_guard_fallback")' "$body_file" >/dev/null 2>&1; then
    reco_output_guard_fallback_count=$((reco_output_guard_fallback_count + 1))
  fi
}

seed_profile() {
  local uid="$1"
  local lang="$2"
  local out="$TMP_DIR/profile_${uid}.json"
  local code=000
  post_json "$out" code "$uid" "$lang" "/v1/profile/update" '{"skinType":"oily","sensitivity":"low","barrierStatus":"healthy","goals":["acne","hydration"],"budgetTier":"$50","region":"US"}'
  record_response_stats "$out" "$code"
}

run_case_artifact_missing() {
  local uid="$1"
  local lang="$2"
  seed_profile "$uid" "$lang"
  local out="$TMP_DIR/reco_artifact_missing_${uid}.json"
  local code=000
  post_json "$out" code "$uid" "$lang" "/v1/chat" '{"message":"recommend products","action":{"action_id":"chip.start.reco_products","kind":"chip","data":{}},"session":{"state":"idle"}}'
  record_response_stats "$out" "$code"
}

run_case_low_confidence() {
  local uid="$1"
  local lang="$2"
  seed_profile "$uid" "$lang"
  local analysis="$TMP_DIR/analysis_low_${uid}.json"
  local code_a=000
  post_json "$analysis" code_a "$uid" "$lang" "/v1/analysis/skin" '{"use_photo":false}'
  record_response_stats "$analysis" "$code_a"
  local reco="$TMP_DIR/reco_low_${uid}.json"
  local code_r=000
  post_json "$reco" code_r "$uid" "$lang" "/v1/chat" '{"message":"recommend products","action":{"action_id":"chip.start.reco_products","kind":"chip","data":{}},"session":{"state":"idle"}}'
  record_response_stats "$reco" "$code_r"
}

run_case_safety_block() {
  local uid="$1"
  local lang="$2"
  seed_profile "$uid" "$lang"
  local msg_en='I have severe pain, bleeding and pus on my face. recommend products now.'
  local msg_cn='我脸上剧痛、出血并且化脓，请推荐产品。'
  local msg="$msg_en"
  if [[ "$lang" == "CN" ]]; then
    msg="$msg_cn"
  fi
  local out="$TMP_DIR/reco_safety_${uid}.json"
  local code=000
  post_json "$out" code "$uid" "$lang" "/v1/chat" "$(jq -cn --arg m "$msg" '{message:$m,action:{action_id:"chip.start.reco_products",kind:"chip",data:{}},session:{state:"idle"}}')"
  record_response_stats "$out" "$code"
}

run_case_photo_usable() {
  local uid="$1"
  local lang="$2"
  seed_profile "$uid" "$lang"
  local upload="$TMP_DIR/photo_upload_${uid}.json"
  local code_u=000
  post_multipart_photo_upload "$upload" code_u "$uid" "$lang"
  record_response_stats "$upload" "$code_u"
  local photo_id
  photo_id="$(jq -r '.cards[]? | select(.type=="photo_confirm") | .payload.photo_id // empty' "$upload" | head -n1)"
  local qc_status
  qc_status="$(jq -r '.cards[]? | select(.type=="photo_confirm") | .payload.qc_status // "passed"' "$upload" | head -n1)"
  if [[ -z "$photo_id" ]]; then
    return 0
  fi
  local analysis="$TMP_DIR/analysis_photo_usable_${uid}.json"
  local code_a=000
  local payload
  payload="$(jq -cn --arg pid "$photo_id" --arg qc "$qc_status" '{use_photo:true,currentRoutine:"AM cleanser + SPF; PM moisturizer",photos:[{photo_id:$pid,slot_id:"daylight",qc_status:$qc}]}')"
  post_json "$analysis" code_a "$uid" "$lang" "/v1/analysis/skin" "$payload"
  record_response_stats "$analysis" "$code_a"
}

run_case_photo_forced_fail() {
  local uid="$1"
  local lang="$2"
  seed_profile "$uid" "$lang"
  local out="$TMP_DIR/analysis_photo_fail_${uid}.json"
  local code=000
  post_json "$out" code "$uid" "$lang" "/v1/analysis/skin" '{"use_photo":true,"photos":[{"photo_id":"missing_photo_for_soak_fail","slot_id":"daylight","qc_status":"failed"}]}'
  record_response_stats "$out" "$code"
}

say "Aurora skin soak start"
printf "BASE=%s\nDURATION_MIN=%s\nREQUESTS_PER_MIN=%s\nTOTAL_REQUESTS=%s\nLANGS=%s\n" \
  "$BASE" "$DURATION_MIN" "$REQUESTS_PER_MIN" "$TOTAL_REQUESTS" "$LANGS"

for ((i=1; i<=TOTAL_REQUESTS; i+=1)); do
  lang="${LANG_ARRAY[$(( (i - 1) % ${#LANG_ARRAY[@]} ))]}"
  case_idx=$(( (i - 1) % 5 ))
  uid="$(rand_uid "${i}_${lang}")"
  if (( case_idx == 0 )); then
    run_case_artifact_missing "$uid" "$lang"
  elif (( case_idx == 1 )); then
    run_case_low_confidence "$uid" "$lang"
  elif (( case_idx == 2 )); then
    run_case_safety_block "$uid" "$lang"
  elif (( case_idx == 3 )); then
    run_case_photo_usable "$uid" "$lang"
  else
    run_case_photo_forced_fail "$uid" "$lang"
  fi
done

say "Aurora skin soak summary"
printf "total_calls=%s\n" "$total_calls"
printf "http_5xx_count=%s\n" "$http_5xx_count"
printf "timeout_degraded_count=%s\n" "$timeout_degraded_count"
printf "reco_output_guard_fallback_count=%s\n" "$reco_output_guard_fallback_count"
printf "empty_cards_count=%s\n" "$empty_cards_count"

exit 0
