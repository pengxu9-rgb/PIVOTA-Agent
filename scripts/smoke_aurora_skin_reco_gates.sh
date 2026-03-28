#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
RUN_ID="${RUN_ID:-$(date +%s)}"

CURL_RETRY_MAX="${CURL_RETRY_MAX:-20}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
CURL_RETRY_MAX_TIME_SEC="${CURL_RETRY_MAX_TIME_SEC:-180}"
ALL_EVENTS_JQ='(
  ((.events // []) | map({event_name: (.event_name // .event_type // ""), data: (.data // .event_data // {})}))
  +
  ((.ops.experiment_events // []) | map({event_name: (.event_name // .event_type // ""), data: (.data // .event_data // {})}))
)'
NON_BLOCKING_FAILURES=()
INGREDIENT_PLAN_CARD_JQ='any(.type=="ingredient_plan" or .type=="ingredient_plan_v2")'
ROUTINE_AUDIT_V1_CARD_JQ='(any(.type=="routine_verdict_v1") and any(.type=="routine_product_audit_v1") and any(.type=="routine_user_fit_v1") and any(.type=="routine_adjustment_plan_v1"))'
ROUTINE_V2_CARD_JQ='((any(.type=="routine_product_audit_v1") and any(.type=="routine_adjustment_plan_v1")) and (any(.type=="routine_verdict_v1" or .type=="routine_user_fit_v1") | not))'
ROUTINE_PREVIEW_CARD_JQ='any(.type=="routine_products_preview")'
ROUTINE_ANALYSIS_CARD_JQ="(${ROUTINE_AUDIT_V1_CARD_JQ} or ${ROUTINE_V2_CARD_JQ} or ${ROUTINE_PREVIEW_CARD_JQ} or any(.type==\"routine_fit_summary\"))"
ROUTINE_AUDIT_V1_CONTRACT_JQ='
  ((.cards | map(.type)) == ["routine_verdict_v1","routine_product_audit_v1","routine_user_fit_v1","routine_adjustment_plan_v1"])
  and ((.analysis_meta.analysis_mode // "") == "routine_audit_v1")
  and ((.session_patch.meta.analysis_contract.card_contract // "") == "aurora.routine_audit_v1")
'

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
    printf "[WARN] %s\n" "$label"
    NON_BLOCKING_FAILURES+=("$label")
    return 0
  fi
  printf "[PASS] %s\n" "$label"
}

jq_assert_no_mainline_fallback() {
  local label="$1"
  local json="$2"
  jq_assert_json "$label" '
    [
      .. | objects | select(
        (.fallback_used == true)
        or (.network_fallback_used == true)
        or (.llm_fallback_used == true)
        or (.reco_enrich_timeout == true)
        or ((.recommendation_mode_final // "") == "open_world_only")
        or ((.analysis_mode // "") == "timeout_degraded")
        or ((.analysis_source // "") == "baseline_low_confidence")
        or ((.analysis_source // "") == "rules_only_timeout_degraded")
        or ((.detector_source // "") == "baseline_low_confidence")
        or (((.mainline_status // "") | tostring | test("timeout_degraded|plan_only_fallback|empty_structured|upstream_timeout"; "i")))
        or ((.telemetry_reason // "") == "timeout_degraded")
        or ((.products_empty_reason // "") == "timeout_degraded")
      )
    ] | length == 0
  ' "$json"
}

warn_note() {
  local label="$1"
  printf "[WARN] %s\n" "$label"
  NON_BLOCKING_FAILURES+=("$label")
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
  local uid="uid_gate_needs_context_${RUN_ID}"
  local trace="trace_gate_needs_context_${RUN_ID}"
  local brief="brief_gate_needs_context_${RUN_ID}"

  say "case 1: reco request yields explicit mainline status"
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

  jq_assert_json "reco request emits reco-stage output" '
    .cards | any(.type=="product_verdict" or .type=="recommendations" or .type=="confidence_notice")
  ' "$reco_json"
  jq_assert_no_mainline_fallback "reco request stays off timeout/baseline fallback" "$reco_json"
  jq_assert_json "reco request exposes explicit mainline status when stream is present" '
    if ('"${ALL_EVENTS_JQ}"' | any(.event_name=="recos_requested"))
    then ('"${ALL_EVENTS_JQ}"' | any(
      (.event_name=="recos_requested")
      and (
        ((.data.mainline_status // "")=="needs_more_context")
        or ((.data.mainline_status // "")=="grounded_success")
      )
    ))
    else true
    end
  ' "$reco_json"
  jq_assert_json "confidence_notice is not artifact_missing/timeout when notice is shown" '
    if (.cards | any(.type=="confidence_notice"))
    then (.cards | all(
      if .type=="confidence_notice"
      then (
        ((.payload.reason // "") != "artifact_missing")
        and ((.payload.reason // "") != "timeout_degraded")
      )
      else true
      end
    ))
    else true
    end
  ' "$reco_json"
}

run_case_low_confidence() {
  local uid="uid_gate_text_mainline_${RUN_ID}"
  local trace="trace_gate_text_mainline_${RUN_ID}"
  local brief="brief_gate_text_mainline_${RUN_ID}"

  say "case 2: text analysis stays on mainline contract"
  seed_core_profile "$uid" "$trace" "$brief"

  local analysis_json
  analysis_json="$(post_json "$uid" "$trace" "$brief" "/v1/analysis/skin" '{"use_photo":false,"currentRoutine":{"am":{"cleanser":"Gentle cleanser","serum":"Vitamin C serum","moisturizer":"Barrier cream","spf":"SPF 50 sunscreen"},"pm":{"cleanser":"Gentle cleanser","treatment":"Retinol serum","moisturizer":"Barrier cream"}}}')"

  jq_assert_json "analysis stays on canonical no-photo contract" '
    (
      (.cards | any(.type=="analysis_story_v2"))
      and (.cards | any(.type=="ingredient_plan_v2"))
    )
    or
    (
      (.cards | any(.type=="routine_product_audit_v1"))
      and (.cards | any(.type=="routine_adjustment_plan_v1"))
    )
  ' "$analysis_json"
  jq_assert_json "analysis source is not baseline fallback" '(.analysis_meta.detector_source // "") != "baseline_low_confidence"' "$analysis_json"
  jq_assert_json "analysis mode is not timeout degraded" '(.analysis_meta.analysis_mode // "") != "timeout_degraded"' "$analysis_json"
  jq_assert_no_mainline_fallback "text analysis stays off degraded fallback markers" "$analysis_json"
  jq_assert_json "analysis_summary is not public when structured mainline cards exist" '
    if (
      (.cards | any(.type=="analysis_story_v2"))
      or (.cards | any(.type=="routine_product_audit_v1"))
    )
    then (.cards | any(.type=="analysis_summary")) | not
    else true
    end
  ' "$analysis_json"
}

run_case_medium_confidence() {
  local uid="uid_gate_medium_conf_${RUN_ID}"
  local trace="trace_gate_medium_conf_${RUN_ID}"
  local brief="brief_gate_medium_conf_${RUN_ID}"

  say "case 3: medium confidence + recommendation path"
  seed_core_profile "$uid" "$trace" "$brief"

  local analysis_json
  analysis_json="$(post_json "$uid" "$trace" "$brief" "/v1/analysis/skin" '{"use_photo":false,"currentRoutine":{"am":{"cleanser":"Gentle cleanser","serum":"Niacinamide serum","moisturizer":"Barrier cream","spf":"SPF 50 sunscreen"},"pm":{"cleanser":"Gentle cleanser","treatment":"Niacinamide serum","moisturizer":"Barrier cream"}}}')"

  jq_assert_json "analysis returns routine audit or story card (medium case)" '
    if ((.analysis_meta.analysis_mode // "") == "routine_audit_v1") or ((.session_patch.meta.analysis_contract.card_contract // "") == "aurora.routine_audit_v1")
    then true
    else (.cards | any(.type=="analysis_story_v2"))
    end
  ' "$analysis_json"
  jq_assert_json "routine analysis emits audit/preview/v2/legacy supported contract (medium case)" "
    if ((.analysis_meta.analysis_mode // \"\") == \"routine_audit_v1\") or ((.session_patch.meta.analysis_contract.card_contract // \"\") == \"aurora.routine_audit_v1\")
    then ${ROUTINE_AUDIT_V1_CONTRACT_JQ}
    elif (.cards | ${ROUTINE_PREVIEW_CARD_JQ})
    then true
    elif (.cards | ${ROUTINE_V2_CARD_JQ})
    then true
    else ((.cards | any(.type==\"analysis_story_v2\")) and (.cards | ${INGREDIENT_PLAN_CARD_JQ}) and (.cards | any(.type==\"routine_fit_summary\")))
    end
  " "$analysis_json"
  jq_assert_json "analysis source is not baseline fallback" '(.analysis_meta.detector_source // "") != "baseline_low_confidence"' "$analysis_json"
  jq_assert_json "artifact usable signal is valid on medium/high" '
    if ((.analysis_meta.analysis_mode // "") == "routine_audit_v1") or ((.session_patch.meta.analysis_contract.card_contract // "") == "aurora.routine_audit_v1")
    then ((.analysis_meta.artifact_usable | type) == "boolean")
    else ((.analysis_meta.artifact_usable // false) == true)
    end
  ' "$analysis_json"
  jq_assert_json "analysis confidence medium/high" '
    if ((.analysis_meta.analysis_mode // "") == "routine_audit_v1") or ((.session_patch.meta.analysis_contract.card_contract // "") == "aurora.routine_audit_v1")
    then true
    else (.cards | any((.type=="analysis_story_v2") and ((((.payload.confidence_overall.level // .payload.ui_card_v1.confidence_label // "") | ascii_downcase) == "medium") or (((.payload.confidence_overall.level // .payload.ui_card_v1.confidence_label // "") | ascii_downcase) == "high"))))
    end
  ' "$analysis_json"
  jq_warn_json "routine follow-up chips align with active contract" "
    if ((.analysis_meta.analysis_mode // \"\") == \"routine_audit_v1\") or ((.session_patch.meta.analysis_contract.card_contract // \"\") == \"aurora.routine_audit_v1\")
    then (
      ((.suggested_chips // []) | any(.chip_id==\"chip.aurora.next_action.deep_dive_skin\"))
      and (((.suggested_chips // []) | any(.chip_id==\"chip.aurora.next_action.routine_deep_dive\")) | not)
    )
    elif (.cards | ${ROUTINE_PREVIEW_CARD_JQ})
    then true
    elif (.cards | ${ROUTINE_ANALYSIS_CARD_JQ})
    then (.suggested_chips // [] | any(.chip_id==\"chip.aurora.next_action.routine_deep_dive\"))
    else false
    end
  ' "$analysis_json"
  jq_assert_json "analysis_summary not public when story exists (medium case)" '
    if (.cards | any(.type=="analysis_story_v2"))
    then (.cards | any(.type=="analysis_summary")) | not
    else true
    end
  ' "$analysis_json"
  jq_assert_no_mainline_fallback "medium analysis stays off degraded fallback markers" "$analysis_json"

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
  jq_warn_json "deep_dive_skin returns non-empty assistant message" '(((.assistant_text // .assistant_message.content // "") | length) > 0)' "$deep_dive_json"

  if printf "%s\n" "$analysis_json" | jq -e '(.suggested_chips // [] | any(.chip_id=="chip.aurora.next_action.routine_deep_dive"))' >/dev/null; then
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
    jq_warn_json "routine_deep_dive returns routine-specific output again" ".cards | ${ROUTINE_ANALYSIS_CARD_JQ}" "$routine_follow_json"
    jq_warn_json "routine_deep_dive does not fall back to ingredient_hub or nudge" '
      (.cards | any(.type=="ingredient_hub" or .type=="nudge")) | not
    ' "$routine_follow_json"
  else
    jq_assert_json "routine audit/preview contract intentionally omits legacy routine_deep_dive chip" '
      if ((.analysis_meta.analysis_mode // "") == "routine_audit_v1") or ((.session_patch.meta.analysis_contract.card_contract // "") == "aurora.routine_audit_v1")
      then (
        ((.suggested_chips // []) | any(.chip_id=="chip.aurora.next_action.deep_dive_skin"))
        and (((.suggested_chips // []) | any(.chip_id=="chip.aurora.next_action.routine_deep_dive")) | not)
      )
      else (
        (.cards | any(.type=="routine_products_preview"))
        and (((.suggested_chips // []) | any(.chip_id=="chip.aurora.next_action.routine_deep_dive")) | not)
      )
      end
    ' "$analysis_json"
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
  jq_assert_json "recos_requested grounded_success when stream is present" '
    if ('"${ALL_EVENTS_JQ}"' | any(.event_name=="recos_requested"))
    then ('"${ALL_EVENTS_JQ}"' | any((.event_name=="recos_requested") and ((((.data.source // "") | length) > 0) and ((.data.mainline_status // "")=="grounded_success"))))
    else true
    end
  ' "$reco_json"
  jq_assert_json "medium/high path does not degrade into confidence_notice" '(.cards | any(.type=="confidence_notice")) | not' "$reco_json"
  jq_assert_no_mainline_fallback "medium/high reco stays off degraded fallback markers" "$reco_json"
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
  jq_assert_json "direct reco event is present with stable semantics" '
    ('"${ALL_EVENTS_JQ}"' | any((.event_name=="recos_requested")
      and (((.data.source // "") | length) > 0)
      and ((.data.mainline_status // "") == "grounded_success")
    ))
  ' "$direct_json"
  jq_assert_no_mainline_fallback "direct reco stays off degraded fallback markers" "$direct_json"
}

run_case_safety_block() {
  local uid="uid_gate_safety_${RUN_ID}"
  local trace="trace_gate_safety_${RUN_ID}"
  local brief="brief_gate_safety_${RUN_ID}"

  say "case 5: safety block"
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
  jq_assert_json "safety block event reason (optional stream)" '
    if ('"${ALL_EVENTS_JQ}"' | any(.event_name=="recos_requested"))
    then ('"${ALL_EVENTS_JQ}"' | any((.event_name=="recos_requested") and (.data.reason=="safety_boundary") and (.data.blocked==true)))
    else true
    end
  ' "$safety_json"
}

printf "BASE=%s\nAURORA_LANG=%s\nRUN_ID=%s\n" "$BASE" "$AURORA_LANG" "$RUN_ID"
say "deployed commit (best-effort)"
curl_do -sSI "${BASE}/v1/session/bootstrap" | grep -i '^x-service-commit:' || true

run_case_artifact_missing
run_case_low_confidence
run_case_medium_confidence
run_case_direct_reco_generate
run_case_safety_block

say "summary"
printf "PASS: aurora skin reco gate smoke OK\n"
if [ "${#NON_BLOCKING_FAILURES[@]}" -gt 0 ]; then
  say "non-blocking warnings"
  printf '%s\n' "${NON_BLOCKING_FAILURES[@]}"
fi
