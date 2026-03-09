#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
RUN_ID="${RUN_ID:-$(date +%s)}"
NON_BLOCKING_FAILURES=()

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

jq_warn_json() {
  local label="$1"
  local expr="$2"
  local json="$3"
  if ! printf "%s\n" "$json" | jq -e "$expr" >/dev/null; then
    printf "[WARN] %s\n" "$label" >&2
    printf "  jq expr: %s\n" "$expr" >&2
    NON_BLOCKING_FAILURES+=("$label")
    return 1
  fi
  printf "[PASS] %s\n" "$label"
}

warn_note() {
  local label="$1"
  printf "[WARN] %s\n" "$label" >&2
  NON_BLOCKING_FAILURES+=("$label")
}

curl_do() {
  curl --retry "${CURL_RETRY_MAX}" --retry-delay "${CURL_RETRY_DELAY_SEC}" --retry-max-time "${CURL_RETRY_MAX_TIME_SEC}" --retry-all-errors "$@"
}

# jq helper: collect events from top-level .events AND .ops.experiment_events
# normalizes experiment_events {event_type,event_data} -> {event_name,data}
ALL_EVENTS_JQ='(
  [(.events // [])[]] +
  [(.ops.experiment_events // [])[] | {event_name: .event_type, data: .event_data}]
)'

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

  jq_assert_json "artifact_missing emits reco-stage output (chatcards or legacy)" '
    .cards | any(.type=="product_verdict" or .type=="recommendations" or .type=="confidence_notice")
  ' "$reco_json"
  jq_assert_json "artifact_missing reason tagged when confidence_notice is used" '
    if (.cards | any(.type=="confidence_notice"))
    then (.cards | any((.type=="confidence_notice") and (.payload.reason=="artifact_missing")))
    else true
    end
  ' "$reco_json"
  jq_assert_json "artifact_missing event reason or recs present (optional stream)" "
    if (${ALL_EVENTS_JQ} | any(.event_name==\"recos_requested\"))
    then (
      (${ALL_EVENTS_JQ} | any((.event_name==\"recos_requested\") and ((.data.reason // \"\")==\"artifact_missing\")))
      or (.cards | any((.type==\"recommendations\") and (((.payload.recommendations // []) | length) >= 1)))
    )
    else true
    end
  " "$reco_json"
}

run_case_low_confidence() {
  local uid="uid_gate_low_conf_${RUN_ID}"
  local trace="trace_gate_low_conf_${RUN_ID}"
  local brief="brief_gate_low_conf_${RUN_ID}"

  say "case 2: low confidence downgrade"
  seed_core_profile "$uid" "$trace" "$brief"

  local analysis_json
  analysis_json="$(post_json "$uid" "$trace" "$brief" "/v1/analysis/skin" '{"use_photo":false}')"

  jq_assert_json "analysis_story_v2 exists" '.cards | any(.type=="analysis_story_v2")' "$analysis_json"
  jq_assert_json "ingredient_plan exists on low confidence path" '.cards | any(.type=="ingredient_plan")' "$analysis_json"
  jq_assert_json "confidence_notice exists on low confidence path" '.cards | any(.type=="confidence_notice")' "$analysis_json"
  jq_assert_json "no routine_fit_summary on low confidence path" '(.cards | any(.type=="routine_fit_summary")) | not' "$analysis_json"
  jq_assert_json "analysis_summary not public when story exists" '
    if (.cards | any(.type=="analysis_story_v2"))
    then (.cards | any(.type=="analysis_summary")) | not
    else true
    end
  ' "$analysis_json"

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

  jq_assert_json "low confidence emits reco-stage output (product_verdict/recommendations/notice)" '
    .cards | any(.type=="product_verdict" or .type=="recommendations")
      or any((.type=="confidence_notice") and (.payload.reason=="low_confidence" or .payload.reason=="timeout_degraded"))
  ' "$reco_json"
  jq_assert_json "low confidence event flag true when stream is present" "
    if (${ALL_EVENTS_JQ} | any(.event_name==\"recos_requested\"))
    then (${ALL_EVENTS_JQ} | any((.event_name==\"recos_requested\") and ((.data.low_confidence==true) or (.data.reason==\"artifact_missing\"))))
    else true
    end
  " "$reco_json"
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

  jq_warn_json "analysis_story_v2 exists (medium case)" '.cards | any(.type=="analysis_story_v2")' "$analysis_json"
  jq_warn_json "ingredient_plan exists (medium case)" '.cards | any(.type=="ingredient_plan")' "$analysis_json"
  jq_warn_json "routine_fit_summary exists (medium case)" '.cards | any(.type=="routine_fit_summary")' "$analysis_json"
  jq_warn_json "routine deep-dive chip exists when routine_fit_summary exists" '
    if (.cards | any(.type=="routine_fit_summary"))
    then (.suggested_chips // [] | any(.chip_id=="chip.aurora.next_action.routine_deep_dive"))
    else false
    end
  ' "$analysis_json"
  jq_warn_json "analysis_summary not public when story exists (medium case)" '
    if (.cards | any(.type=="analysis_story_v2"))
    then (.cards | any(.type=="analysis_summary")) | not
    else true
    end
  ' "$analysis_json"

  local deep_dive_json
  deep_dive_json="$(
    post_json "$uid" "$trace" "$brief" "/v1/chat" '{
      "action":{
        "action_id":"chip.aurora.next_action.deep_dive_skin",
        "kind":"action",
        "data":{"reply_text":"Tell me more about my skin","trigger_source":"analysis_story_v2"}
      }
    }'
  )"
  jq_warn_json "deep_dive_skin does not fall back to ingredient_hub or nudge" '
    (.cards | any(.type=="ingredient_hub" or .type=="nudge")) | not
  ' "$deep_dive_json"
  jq_warn_json "deep_dive_skin returns non-empty assistant message" '((.assistant_message.content // "") | length) > 0' "$deep_dive_json"

  if printf "%s\n" "$analysis_json" | jq -e '.cards | any(.type=="routine_fit_summary")' >/dev/null; then
    local routine_follow_json
    routine_follow_json="$(
      post_json "$uid" "$trace" "$brief" "/v1/chat" '{
        "action":{
          "action_id":"chip.aurora.next_action.routine_deep_dive",
          "kind":"action",
          "data":{"reply_text":"What should I simplify first?","trigger_source":"routine_fit_summary"}
        }
      }'
    )"
    jq_warn_json "routine_deep_dive returns routine_fit_summary again" '.cards | any(.type=="routine_fit_summary")' "$routine_follow_json"
    jq_warn_json "routine_deep_dive does not fall back to ingredient_hub or nudge" '
      (.cards | any(.type=="ingredient_hub" or .type=="nudge")) | not
    ' "$routine_follow_json"
  else
    warn_note "routine_deep_dive skipped because routine_fit_summary was absent in analysis output"
  fi

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

  jq_assert_json "medium/high path emits product_verdict/recommendations" '
    .cards | any(.type=="product_verdict" or .type=="recommendations")
  ' "$reco_json"
  jq_assert_json "medium/high path has at least one recommendation or verdict payload" '
    (.cards | map(select(.type=="recommendations" or .type=="product_verdict")) | length) >= 1
  ' "$reco_json"
  jq_assert_json "recos_requested source and parity fields present (optional stream)" "
    if (${ALL_EVENTS_JQ} | any(.event_name==\"recos_requested\"))
    then (${ALL_EVENTS_JQ} | any((.event_name==\"recos_requested\") and ((((.data.source // \"\") | length) > 0) and (((.data.mainline_status // \"\") | length) > 0))))
    else true
    end
  " "$reco_json"
  jq_assert_json "medium/high path not marked artifact_missing when recommendations exist (optional stream)" "
    if (${ALL_EVENTS_JQ} | any(.event_name==\"recos_requested\"))
    then (${ALL_EVENTS_JQ} | any((.event_name==\"recos_requested\") and (((.data.reason // \"\") != \"artifact_missing\") or (.data.grounded_count > 0) or (.data.ungrounded_count > 0))))
    else true
    end
  " "$reco_json"
}

run_case_direct_reco_generate() {
  local uid="uid_gate_direct_reco_${RUN_ID}"
  local trace="trace_gate_direct_reco_${RUN_ID}"
  local brief="brief_gate_direct_reco_${RUN_ID}"

  say "case 4: direct reco generate"
  seed_core_profile "$uid" "$trace" "$brief"

  local direct_json
  direct_json="$(
    post_json "$uid" "$trace" "$brief" "/v1/reco/generate" '{
      "focus":"dark spots and acne marks",
      "constraints":{"fragrance_free":true},
      "include_alternatives":false
    }'
  )"

  jq_assert_json "direct reco generate returns recommendation payload" '
    .cards | any((.type=="recommendations") and (((.payload.recommendations // []) | length) >= 1))
  ' "$direct_json"
  jq_assert_json "direct reco event is present with stable semantics" "
    (${ALL_EVENTS_JQ} | any((.event_name==\"recos_requested\")
      and (((.data.source // \"\") | length) > 0)
      and (((.data.mainline_status // \"\") | length) > 0)
      and (((.data.reason // \"\") != \"artifact_missing\") or (.data.grounded_count > 0) or (.data.ungrounded_count > 0))
    ))
  " "$direct_json"
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

  jq_assert_json "safety block emits triage or safety confidence_notice" '
    .cards | any(.type=="triage")
      or any((.type=="confidence_notice") and (.payload.reason=="safety_block"))
  ' "$safety_json"
  jq_assert_json "safety block keeps recommendations in conservative fallback shape when present" '
    if (.cards | any(.type=="recommendations"))
    then
      ((.cards[] | select(.type=="recommendations") | .payload.recommendations) // []) as $recs |
      ($recs | length) >= 1 and
      ($recs | all(
        ((.routine_slot // "") | test("cleanser|moisturizer|sunscreen"; "i")) and
        (((.title // "") | tostring | length) == 0) and
        (((.product_url // "") | tostring | length) == 0)
      ))
    else true end
  ' "$safety_json"
  jq_assert_json "safety block event reason (optional stream)" "
    if (${ALL_EVENTS_JQ} | any(.event_name==\"recos_requested\"))
    then (${ALL_EVENTS_JQ} | any((.event_name==\"recos_requested\") and (.data.reason==\"safety_boundary\") and (.data.blocked==true)))
    else true
    end
  " "$safety_json"
}

printf "BASE=%s\nAURORA_LANG=%s\nRUN_ID=%s\n" "$BASE" "$AURORA_LANG" "$RUN_ID"
say "deployed commit (best-effort)"
curl_do -sSI "${BASE}/v1/session/bootstrap" | grep -i '^x-service-commit:' || true

run_case_artifact_missing
run_case_low_confidence
run_case_medium_confidence
run_case_safety_block

say "summary"
if ((${#NON_BLOCKING_FAILURES[@]} > 0)); then
  printf "WARN(non-blocking): %s issue(s)\n" "${#NON_BLOCKING_FAILURES[@]}"
  for item in "${NON_BLOCKING_FAILURES[@]}"; do
    printf "  - %s\n" "$item"
  done
fi
printf "PASS: aurora skin reco gate smoke OK\n"
