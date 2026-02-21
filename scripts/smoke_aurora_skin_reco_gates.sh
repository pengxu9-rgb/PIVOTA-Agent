#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
RUN_ID="${RUN_ID:-$(date +%s)}"

CURL_RETRY_MAX="${CURL_RETRY_MAX:-20}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
CURL_RETRY_MAX_TIME_SEC="${CURL_RETRY_MAX_TIME_SEC:-180}"

say() {
  printf "\n== %s ==\n" "$1"
}

fail() {
  printf "\n[FAIL] %s\n" "$1" >&2
  exit 1
}

jq_assert_json() {
  local label="$1"
  local expr="$2"
  local json="$3"
  if ! printf "%s\n" "$json" | jq -e "$expr" >/dev/null; then
    printf "\n[FAIL] %s\n" "$label" >&2
    printf "  jq expr: %s\n" "$expr" >&2
    exit 1
  fi
  printf "[PASS] %s\n" "$label"
}

curl_do() {
  curl --retry "${CURL_RETRY_MAX}" --retry-delay "${CURL_RETRY_DELAY_SEC}" --retry-max-time "${CURL_RETRY_MAX_TIME_SEC}" --retry-all-errors "$@"
}

post_json() {
  local uid="$1"
  local trace="$2"
  local brief="$3"
  local path="$4"
  local body="$5"
  curl_do -fsS -X POST "${BASE}${path}" \
    -H "Content-Type: application/json" \
    -H "X-Aurora-UID: ${uid}" \
    -H "X-Lang: ${AURORA_LANG}" \
    -H "X-Trace-ID: ${trace}" \
    -H "X-Brief-ID: ${brief}" \
    --data "$body"
}

seed_core_profile() {
  local uid="$1"
  local trace="$2"
  local brief="$3"
  local profile_json
  profile_json="$(post_json "$uid" "$trace" "$brief" "/v1/profile/update" '{"skinType":"oily","sensitivity":"low","barrierStatus":"healthy","goals":["acne","dark_spots"],"budgetTier":"¥500"}')"
  jq_assert_json "profile update accepted (${uid})" '.cards | any(.type=="profile")' "$profile_json"
}

run_case_artifact_missing() {
  local uid="uid_gate_artifact_missing_${RUN_ID}"
  local trace="trace_gate_artifact_missing_${RUN_ID}"
  local brief="brief_gate_artifact_missing_${RUN_ID}"

  say "case 1: artifact_missing gate"
  seed_core_profile "$uid" "$trace" "$brief"

  local reco_json
  reco_json="$(
    post_json "$uid" "$trace" "$brief" "/v1/chat" '{
      "action":{
        "action_id":"chip.start.reco_products",
        "kind":"chip",
        "data":{"reply_text":"Recommend products now","include_alternatives":false}
      },
      "session":{"state":"S2_DIAGNOSIS"}
    }'
  )"

  jq_assert_json "artifact_missing emits confidence_notice" '.cards | any(.type=="confidence_notice")' "$reco_json"
  jq_assert_json "artifact_missing reason tagged" '.cards | any((.type=="confidence_notice") and (.payload.reason=="artifact_missing"))' "$reco_json"
  jq_assert_json "artifact_missing does not emit recommendations" '(.cards | any(.type=="recommendations")) | not' "$reco_json"
  jq_assert_json "artifact_missing event reason" '.events | any((.event_name=="recos_requested") and (.data.reason=="artifact_missing"))' "$reco_json"
}

run_case_low_confidence() {
  local uid="uid_gate_low_conf_${RUN_ID}"
  local trace="trace_gate_low_conf_${RUN_ID}"
  local brief="brief_gate_low_conf_${RUN_ID}"

  say "case 2: low confidence downgrade"
  seed_core_profile "$uid" "$trace" "$brief"

  local analysis_json
  analysis_json="$(post_json "$uid" "$trace" "$brief" "/v1/analysis/skin" '{"use_photo":false}')"

  jq_assert_json "analysis_summary exists" '.cards | any(.type=="analysis_summary")' "$analysis_json"
  jq_assert_json "analysis source baseline_low_confidence" '(.cards[] | select(.type=="analysis_summary") | .payload.analysis_source) == "baseline_low_confidence"' "$analysis_json"
  jq_assert_json "artifact confidence low" '(.cards[] | select(.type=="analysis_summary") | .payload.diagnosis_artifact.overall_confidence.level) == "low"' "$analysis_json"
  jq_assert_json "recommendation_ready false on low confidence" '(.cards[] | select(.type=="analysis_summary") | .payload.recommendation_ready) == false' "$analysis_json"

  local reco_json
  reco_json="$(
    post_json "$uid" "$trace" "$brief" "/v1/chat" '{
      "action":{
        "action_id":"chip.start.reco_products",
        "kind":"chip",
        "data":{"reply_text":"Recommend products now","include_alternatives":false}
      },
      "session":{"state":"S2_DIAGNOSIS"}
    }'
  )"

  jq_assert_json "low confidence emits confidence_notice or timeout_degraded" '.cards | any((.type=="confidence_notice") and (.payload.reason=="low_confidence" or .payload.reason=="timeout_degraded"))' "$reco_json"
  jq_assert_json "low confidence event flag true" '.events | any((.event_name=="recos_requested") and (.data.low_confidence==true))' "$reco_json"
  jq_assert_json "no safety block in low confidence case" '(.cards | any((.type=="confidence_notice") and (.payload.reason=="safety_block"))) | not' "$reco_json"
}

run_case_medium_confidence() {
  local uid="uid_gate_medium_conf_${RUN_ID}"
  local trace="trace_gate_medium_conf_${RUN_ID}"
  local brief="brief_gate_medium_conf_${RUN_ID}"

  say "case 3: medium confidence + recommendation path"
  seed_core_profile "$uid" "$trace" "$brief"

  local analysis_json
  analysis_json="$(post_json "$uid" "$trace" "$brief" "/v1/analysis/skin" '{"use_photo":false,"currentRoutine":"AM: cleanser + moisturizer + sunscreen; PM: cleanser + moisturizer + niacinamide serum"}')"

  jq_assert_json "analysis_summary exists (medium case)" '.cards | any(.type=="analysis_summary")' "$analysis_json"
  jq_assert_json "analysis source is not baseline fallback" '(.cards[] | select(.type=="analysis_summary") | .payload.analysis_source) != "baseline_low_confidence"' "$analysis_json"
  jq_assert_json "artifact confidence medium/high" '.cards[] | select(.type=="analysis_summary") | (.payload.diagnosis_artifact.overall_confidence.level == "medium" or .payload.diagnosis_artifact.overall_confidence.level == "high")' "$analysis_json"
  jq_assert_json "recommendation_ready true on medium/high artifact" '(.cards[] | select(.type=="analysis_summary") | .payload.recommendation_ready) == true' "$analysis_json"

  local reco_json
  reco_json="$(
    post_json "$uid" "$trace" "$brief" "/v1/chat" '{
      "action":{
        "action_id":"chip.start.reco_products",
        "kind":"chip",
        "data":{"reply_text":"Recommend products now","include_alternatives":false}
      },
      "session":{"state":"S2_DIAGNOSIS"}
    }'
  )"

  jq_assert_json "medium/high path emits recommendations or timeout_degraded notice" '.cards | any(.type=="recommendations") or any((.type=="confidence_notice") and (.payload.reason=="timeout_degraded"))' "$reco_json"
  jq_assert_json "no artifact_missing in medium/high path" '(.cards | any((.type=="confidence_notice") and (.payload.reason=="artifact_missing"))) | not' "$reco_json"
  jq_assert_json "recos_requested source or timeout reason present" '.events | any((.event_name=="recos_requested") and ((((.data.source // "") | length) > 0) or (.data.reason=="timeout_degraded")))' "$reco_json"
  jq_assert_json "medium/high path not marked low_confidence unless timeout_degraded" '.events | any((.event_name=="recos_requested") and ((.data.low_confidence==false) or (.data.reason=="timeout_degraded")))' "$reco_json"
}

run_case_safety_block() {
  local uid="uid_gate_safety_${RUN_ID}"
  local trace="trace_gate_safety_${RUN_ID}"
  local brief="brief_gate_safety_${RUN_ID}"

  say "case 4: safety block"
  seed_core_profile "$uid" "$trace" "$brief"

  local safety_json
  safety_json="$(
    post_json "$uid" "$trace" "$brief" "/v1/chat" '{
      "message":"I have severe pain, oozing pus and fever on my face. Please recommend treatment products now.",
      "action":{
        "action_id":"chip.start.reco_products",
        "kind":"chip",
        "data":{"reply_text":"Recommend products now","include_alternatives":false}
      },
      "session":{"state":"S2_DIAGNOSIS"}
    }'
  )"

  jq_assert_json "safety block emits confidence_notice" '.cards | any((.type=="confidence_notice") and (.payload.reason=="safety_block"))' "$safety_json"
  jq_assert_json "safety block removes recommendations" '(.cards | any(.type=="recommendations")) | not' "$safety_json"
  jq_assert_json "safety block event reason" '.events | any((.event_name=="recos_requested") and (.data.reason=="safety_boundary") and (.data.blocked==true))' "$safety_json"
}

printf "BASE=%s\nAURORA_LANG=%s\nRUN_ID=%s\n" "$BASE" "$AURORA_LANG" "$RUN_ID"
say "deployed commit (best-effort)"
curl_do -sSI "${BASE}/v1/session/bootstrap" | grep -i '^x-service-commit:' || true

run_case_artifact_missing
run_case_low_confidence
run_case_medium_confidence
run_case_safety_block

say "summary"
printf "PASS: aurora skin reco gate smoke OK\n"
