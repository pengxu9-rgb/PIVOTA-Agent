#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
AURORA_UID="${AURORA_UID:-uid_release_gate_$(date +%s)}"
TRACE_ID="${TRACE_ID:-t_$(date +%s)}"
BRIEF_ID="${BRIEF_ID:-b_$(date +%s)}"
CURL_RETRY_MAX="${CURL_RETRY_MAX:-30}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
CURL_RETRY_MAX_TIME_SEC="${CURL_RETRY_MAX_TIME_SEC:-240}"
LAB_SERIES_URL="${LAB_SERIES_URL:-https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one}"

COMMON_HEADERS=(
  -H "X-Aurora-UID: ${AURORA_UID}"
  -H "X-Lang: ${AURORA_LANG}"
  -H "X-Trace-ID: ${TRACE_ID}"
  -H "X-Brief-ID: ${BRIEF_ID}"
)

say() {
  printf "\n== %s ==\n" "$1"
}

jq_assert() {
  local label="$1"
  local expr="$2"
  if ! jq -e "$expr" >/dev/null; then
    printf "\n[FAIL] %s\n" "$label" >&2
    printf "  jq expr: %s\n" "$expr" >&2
    exit 1
  fi
  printf "[PASS] %s\n" "$label"
}

curl_do() {
  curl --retry "${CURL_RETRY_MAX}" --retry-delay "${CURL_RETRY_DELAY_SEC}" --retry-max-time "${CURL_RETRY_MAX_TIME_SEC}" --retry-all-errors "$@"
}

health_started_at() {
  curl_do -fsS "${BASE}/health" | jq -r '.version.started_at // empty'
}

assert_started_at_stable() {
  local label="$1"
  local before="$2"
  local after="$3"
  if [[ -z "$before" || -z "$after" ]]; then
    printf "[WARN] %s: skipped started_at stability check (missing value)\n" "$label"
    return
  fi
  if [[ "$before" != "$after" ]]; then
    printf "\n[FAIL] %s restarted service\n  started_at(before)=%s\n  started_at(after)=%s\n" "$label" "$before" "$after" >&2
    exit 1
  fi
  printf "[PASS] %s started_at stable\n" "$label"
}

printf "BASE=%s\nAURORA_LANG=%s\nAURORA_UID=%s\nTRACE_ID=%s\nBRIEF_ID=%s\nCURL_RETRY_MAX=%s\nCURL_RETRY_DELAY_SEC=%s\nCURL_RETRY_MAX_TIME_SEC=%s\nLAB_SERIES_URL=%s\n" \
  "$BASE" "$AURORA_LANG" "$AURORA_UID" "$TRACE_ID" "$BRIEF_ID" "$CURL_RETRY_MAX" "$CURL_RETRY_DELAY_SEC" "$CURL_RETRY_MAX_TIME_SEC" "$LAB_SERIES_URL"

say "deployed commit (best-effort)"
curl_do -sSI "${BASE}/v1/session/bootstrap" | grep -i '^x-service-commit:' || true

say "health contract"
health_json="$(curl_do -fsS "${BASE}/health")"
printf "%s\n" "$health_json" | jq_assert "health exposes aurora_chat_contract" '.aurora_chat_contract | type=="object"'
printf "%s\n" "$health_json" | jq_assert "health exposes skill_router_v2" '(.aurora_chat_contract.skill_router_v2 | type) == "boolean"'
printf "%s\n" "$health_json" | jq_assert "health exposes analysis_story_v2_enabled" '(.aurora_chat_contract.analysis_story_v2_enabled | type) == "boolean"'
printf "%s\n" "$health_json" | jq_assert "skill_router_v2 enabled" '.aurora_chat_contract.skill_router_v2 == true'
printf "%s\n" "$health_json" | jq_assert "analysis card contract is story_only" '.aurora_chat_contract.analysis_card_contract_mode == "story_only"'
printf "%s\n" "$health_json" | jq_assert "v1 chat delegation mode is compatible_only" '.aurora_chat_contract.v1_chat_v2_delegation_mode == "compatible_only"'

say "session bootstrap"
bootstrap_json="$(curl_do -fsS "${BASE}/v1/session/bootstrap" "${COMMON_HEADERS[@]}")"
printf "%s\n" "$bootstrap_json" | jq_assert "bootstrap envelope has cards" '.cards | type=="array" and (length >= 1)'
printf "%s\n" "$bootstrap_json" | jq -r '.cards[0].type' >/dev/null || true

say "reco entry (missing profile -> answer-first with advisory/low-confidence allowed)"
gate_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{
    "action":{
      "action_id":"chip.start.reco_products",
      "kind":"chip",
      "data":{"reply_text":"Recommend a few products","include_alternatives":false}
    },
    "session":{"state":"S7_PRODUCT_RECO"}
  }')"
printf "%s\n" "$gate_json" | jq_assert "chat returns cards array" '.cards | type=="array" and (length >= 1)'
printf "%s\n" "$gate_json" | jq_assert "answer-first output exists (recommendations/product_verdict/confidence_notice)" '
  .cards
  | any(.type=="recommendations")
    or any(.type=="product_verdict")
    or any(.type=="confidence_notice")
'
printf "%s\n" "$gate_json" | jq_assert "no safety require-info hard gate event on reco entry" '((.events // []) | any(.event_name=="safety_gate_require_info")) | not'

say "profile update (core + itinerary)"
profile_json="$(curl_do -fsS -X POST "${BASE}/v1/profile/update" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"skinType":"oily","sensitivity":"low","barrierStatus":"impaired","goals":["dark_spots","acne"],"budgetTier":"¥500","itinerary":"Travel next week (cold/dry), lots of outdoor time"}')"

printf "%s\n" "$profile_json" | jq_assert "profile card exists" '.cards | any(.type=="profile")'

say "session bootstrap (after profile update)"
bootstrap2_json="$(curl_do -fsS "${BASE}/v1/session/bootstrap" "${COMMON_HEADERS[@]}")"
printf "%s\n" "$bootstrap2_json" | jq_assert "is_returning=true" '(.cards[]|select(.type=="session_bootstrap")|.payload.is_returning) == true'
printf "%s\n" "$bootstrap2_json" | jq_assert "profile.itinerary persisted" '(.cards[]|select(.type=="session_bootstrap")|.payload.profile.itinerary) == "Travel next week (cold/dry), lots of outdoor time"'

say "tracker log + recent (7d)"
tracker_json="$(curl_do -fsS -X POST "${BASE}/v1/tracker/log" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"redness":1,"acne":2,"hydration":3,"notes":"quick check-in"}')"

printf "%s\n" "$tracker_json" | jq_assert "tracker_log card exists" '.cards | any(.type=="tracker_log")'

recent_json="$(curl_do -fsS "${BASE}/v1/tracker/recent?days=7" "${COMMON_HEADERS[@]}")"
printf "%s\n" "$recent_json" | jq_assert "tracker_recent card exists" '.cards | any(.type=="tracker_recent")'
printf "%s\n" "$recent_json" | jq_assert "recent logs length >= 1" '(.cards[]|select(.type=="tracker_recent")|.payload.logs|length) >= 1'

say "skin analysis (empty body ok)"
skin_json="$(curl_do -fsS -X POST "${BASE}/v1/analysis/skin" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{}')"

printf "%s\n" "$skin_json" | jq_assert "analysis_story_v2 has ui_card_v1" '.cards | any(.type=="analysis_story_v2" and ((.payload.ui_card_v1|type)=="object") and ((.payload.ui_card_v1.headline//"")|length>0))'
printf "%s\n" "$skin_json" | jq_assert "ingredient_plan card exists" '.cards | any(.type=="ingredient_plan")'
printf "%s\n" "$skin_json" | jq_assert "analysis_summary not public when story exists" '
  if (.cards | any(.type=="analysis_story_v2"))
  then (.cards | any(.type=="analysis_summary")) | not
  else true
  end
'
printf "%s\n" "$skin_json" | jq_assert "analysis meta present" '.analysis_meta | type=="object"'
printf "%s\n" "$skin_json" | jq_assert "analysis confidence label present" '.cards | any(.type=="analysis_story_v2" and ((.payload.ui_card_v1.confidence_label//"")|length>0))'
printf "%s\n" "$skin_json" | jq_assert "analysis suppresses passive pregnancy confidence card" '([.cards[]? | select(.type=="confidence_notice" and .payload.reason=="pregnancy_optional_profile")] | length) == 0'

say "skin analysis (routine-fit path)"
skin_routine_json="$(curl_do -fsS -X POST "${BASE}/v1/analysis/skin" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"use_photo":false,"currentRoutine":{"am":{"cleanser":"Gentle cleanser","serum":"Vitamin C serum","moisturizer":"Barrier cream","spf":"SPF50"},"pm":{"cleanser":"Gentle cleanser","treatment":"Retinol serum","moisturizer":"Barrier cream"}}}')"

printf "%s\n" "$skin_routine_json" | jq_assert "routine-fit analysis has story card" '.cards | any(.type=="analysis_story_v2")'
printf "%s\n" "$skin_routine_json" | jq_assert "routine-fit analysis has ingredient_plan" '.cards | any(.type=="ingredient_plan")'
printf "%s\n" "$skin_routine_json" | jq_assert "routine-fit analysis has routine_fit_summary" '.cards | any(.type=="routine_fit_summary")'
printf "%s\n" "$skin_routine_json" | jq_assert "routine-fit analysis exposes deep-dive chip" '(.suggested_chips // [] | any(.chip_id=="chip.aurora.next_action.routine_deep_dive"))'
printf "%s\n" "$skin_routine_json" | jq_assert "routine-fit analysis does not expose public analysis_summary" '
  if (.cards | any(.type=="analysis_story_v2"))
  then (.cards | any(.type=="analysis_summary")) | not
  else true
  end
'

say "analysis follow-up actions"
analysis_deep_dive_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{
    "action":{
      "action_id":"chip.aurora.next_action.deep_dive_skin",
      "kind":"action",
      "data":{"reply_text":"Tell me more about my skin","trigger_source":"analysis_story_v2"}
    }
  }')"
printf "%s\n" "$analysis_deep_dive_json" | jq_assert "deep_dive_skin avoids ingredient_hub/nudge fallback" '(.cards | any(.type=="ingredient_hub" or .type=="nudge")) | not'
printf "%s\n" "$analysis_deep_dive_json" | jq_assert "deep_dive_skin assistant text exists" '(((.assistant_text // .assistant_message.content // "") | length) > 0)'

analysis_routine_deep_dive_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{
    "action":{
      "action_id":"chip.aurora.next_action.routine_deep_dive",
      "kind":"action",
      "data":{"reply_text":"What should I simplify first?","trigger_source":"routine_fit_summary"}
    }
  }')"
printf "%s\n" "$analysis_routine_deep_dive_json" | jq_assert "routine_deep_dive replays routine_fit_summary" '.cards | any(.type=="routine_fit_summary")'
printf "%s\n" "$analysis_routine_deep_dive_json" | jq_assert "routine_deep_dive avoids ingredient_hub/nudge fallback" '(.cards | any(.type=="ingredient_hub" or .type=="nudge")) | not'

say "/v1/chat free-form with context (v2-compatible path)"
v1_chat_v2_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"message":"what ingredient is best for acne?","context":{"locale":"en","profile":{}}}')"

printf "%s\n" "$v1_chat_v2_json" | jq_assert "/v1/chat v2-compatible returns cards array" '.cards | type=="array" and (length >= 1)'
printf "%s\n" "$v1_chat_v2_json" | jq_assert "/v1/chat v2-compatible returns text_response" '.cards | any(.card_type=="text_response")'
printf "%s\n" "$v1_chat_v2_json" | jq_assert "/v1/chat v2-compatible returns next_actions" '.next_actions | type=="array"'

say "product analyze (Nivea Creme)"
started_at_before_analyze="$(health_started_at)"
analyze_json="$(curl_do -fsS -X POST "${BASE}/v1/product/analyze" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"name":"Nivea Creme"}')"
started_at_after_analyze="$(health_started_at)"
assert_started_at_stable "product analyze (Nivea Creme)" "$started_at_before_analyze" "$started_at_after_analyze"

printf "%s\n" "$analyze_json" | jq_assert "product_analysis card exists" '.cards | any(.type=="product_analysis")'
printf "%s\n" "$analyze_json" | jq_assert "verdict is present" '((.cards[]|select(.type=="product_analysis")|.payload.assessment.verdict)//"") | length > 0'
printf "%s\n" "$analyze_json" | jq_assert "reasons length >= 1" '(.cards[]|select(.type=="product_analysis")|.payload.assessment.reasons|length) >= 1'

say "product parse/analyze URL path (Lab Series) + anti-drift guard"
started_at_before_parse_url="$(health_started_at)"
parse_url_json="$(curl_do -fsS -X POST "${BASE}/v1/product/parse" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data "{\"text\":\"${LAB_SERIES_URL}\"}")"
started_at_after_parse_url="$(health_started_at)"
assert_started_at_stable "product parse (Lab Series URL)" "$started_at_before_parse_url" "$started_at_after_parse_url"
printf "%s\n" "$parse_url_json" | jq_assert "product_parse card exists for URL" '.cards | any(.type=="product_parse")'
printf "%s\n" "$parse_url_json" | jq_assert "product_parse keeps trace_id continuity" "(.trace_id // \"\") == \"${TRACE_ID}\""

started_at_before_analyze_url="$(health_started_at)"
analyze_url_json="$(curl_do -fsS -X POST "${BASE}/v1/product/analyze" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data "{\"url\":\"${LAB_SERIES_URL}\"}")"
started_at_after_analyze_url="$(health_started_at)"
assert_started_at_stable "product analyze (Lab Series URL)" "$started_at_before_analyze_url" "$started_at_after_analyze_url"
printf "%s\n" "$analyze_url_json" | jq_assert "product_analysis card exists for URL" '.cards | any(.type=="product_analysis")'
printf "%s\n" "$analyze_url_json" | jq_assert "product_analyze keeps trace_id continuity" "(.trace_id // \"\") == \"${TRACE_ID}\""
printf "%s\n" "$analyze_url_json" | jq_assert "URL analyze provenance.url_fetch has provider-aware attempts" '
  (.cards[]|select(.type=="product_analysis")|.payload.provenance.url_fetch.attempts) as $atts |
  (($atts|type)=="array") and
  (if ($atts|length)==0 then true else ($atts | all(((.strategy // "")|length>0) and ((.provider // "")|length>0)) ) end)
'
printf "%s\n" "$analyze_url_json" | jq_assert "URL analyze retrieval_degradation is diagnosable when degraded" '
  (.cards[]|select(.type=="product_analysis")|.payload) as $p |
  ($p.provenance.retrieval_degradation // null) as $rd |
  if $rd == null then
    true
  else
    (($rd|type)=="object") and
    (
      if ($rd.degraded == true and (($rd.transient_failure_count // 0) > 0)) then
        (
          ($p.missing_info // [])
          | any(. == "catalog_ann_transient_failure" or . == "competitor_recall_transient_degraded")
        )
      else
        true
      end
    )
  end
'
printf "%s\n" "$analyze_url_json" | jq_assert "URL analyze alternatives do not contain obvious non-skincare tools" '
  [
    (.cards[]|select(.type=="product_analysis")|.payload.competitors.candidates[]?),
    (.cards[]|select(.type=="product_analysis")|.payload.related_products.candidates[]?),
    (.cards[]|select(.type=="product_analysis")|.payload.dupes.candidates[]?)
  ] as $rows |
  (
    [$rows[] | (((.name // .display_name // "") + " " + (.category // "") + " " + (.product_type // "")) | ascii_downcase | test("(brush|makeup\\s*brush|applicator|tool\\b|blender)"))]
    | any
  ) | not
'

say "dupe compare (real products -> should have tradeoffs)"
dupe_json="$(curl_do -fsS -X POST "${BASE}/v1/dupe/compare" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"original":{"brand":"Nivea","name":"Creme"},"dupe":{"brand":"The Ordinary","name":"Hyaluronic Acid 2% + B5"}}')"

printf "%s\n" "$dupe_json" | jq_assert "dupe_compare card exists" '.cards | any(.type=="dupe_compare")'
printf "%s\n" "$dupe_json" | jq_assert "tradeoffs length >= 1" '(.cards[]|select(.type=="dupe_compare")|.payload.tradeoffs|length) >= 1'
printf "%s\n" "$dupe_json" | jq_assert "first tradeoff looks human" '((.cards[]|select(.type=="dupe_compare")|.payload.tradeoffs[0])//"") | length >= 20'

say "routine simulate (retinoid × acids -> should produce conflict heatmap cell)"
routine_json="$(curl_do -fsS -X POST "${BASE}/v1/routine/simulate" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"routine":{"pm":[{"step":"Treatment","key_actives":["retinol"]}]},"test_product":{"name":"Test Acid","key_actives":["glycolic acid"]}}')"

printf "%s\n" "$routine_json" | jq_assert "routine_simulation card exists" '.cards | any(.type=="routine_simulation")'
printf "%s\n" "$routine_json" | jq_assert "conflict_heatmap card exists" '.cards | any(.type=="conflict_heatmap")'
printf "%s\n" "$routine_json" | jq_assert "heatmap has 2+ steps" '(.cards[]|select(.type=="conflict_heatmap")|.payload.axes.rows.items|length) >= 2'
printf "%s\n" "$routine_json" | jq_assert "heatmap has >=1 cell" '(.cards[]|select(.type=="conflict_heatmap")|.payload.cells.items|length) >= 1'
printf "%s\n" "$routine_json" | jq_assert "first cell has headline/why/recommendations" '(.cards[]|select(.type=="conflict_heatmap")|.payload.cells.items[0]) | ((.headline_i18n.en//"")|length>0) and ((.why_i18n.en//"")|length>0) and ((.recommendations|length) >= 1)'

say "chat conflict question (should include routine_simulation + conflict_heatmap; direct or compatibility wrapper)"
chat_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"message":"My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.","session":{"state":"S7_PRODUCT_RECO"}}')"

printf "%s\n" "$chat_json" | jq_assert "/v1/chat returns cards array" '.cards | type=="array"'
printf "%s\n" "$chat_json" | jq_assert "chat includes routine_simulation (direct or compatibility wrapper)" '
  .cards | any(.type=="routine_simulation")
  or any(
    .type=="compatibility" and
    ((.sections // []) | any(
      .kind=="compatibility_structured" and
      (
        .source_card_type=="routine_simulation"
        or ((.routine_simulation // null) | type == "object")
      )
    ))
  )
'
printf "%s\n" "$chat_json" | jq_assert "chat includes conflict_heatmap (direct or compatibility wrapper)" '
  .cards | any(.type=="conflict_heatmap")
  or any(
    .type=="compatibility" and
    ((.sections // []) | any(
      .kind=="compatibility_structured" and
      (
        .source_card_type=="conflict_heatmap"
        or ((.conflict_heatmap // null) | type == "object")
      )
    ))
  )
'
printf "%s\n" "$chat_json" | jq_assert "chat heatmap has >=1 cell (direct or compatibility wrapper)" '
  (
    [
      (.cards[]? | select(.type=="conflict_heatmap") | ((.payload.cells.items // []) | length)),
      (.cards[]? | select(.type=="compatibility") | .sections[]? | select(.kind=="compatibility_structured") | ((.conflict_heatmap.cells.items // []) | length))
    ]
    | map(select(. != null))
    | max
    // 0
  ) >= 1
'
printf "%s\n" "$chat_json" | jq_assert "chat passive advisory cards are suppressed" '
  ([.cards[]? | select(.type=="confidence_notice" and (.payload.reason=="safety_optional_profile_missing" or .payload.reason=="gate_advisory" or .payload.reason=="pregnancy_optional_profile"))] | length) == 0
'
printf "%s\n" "$chat_json" | jq_assert "chat passive-gate meta is present when advisory events exist" '
  if ((.events // []) | any(.event_name=="safety_advisory_inline" or .event_name=="gate_advisory_inline")) then
    ((.session_patch.meta.passive_gate_suppressed // false) == true)
  else
    true
  end
'
printf "%s\n" "$chat_json" | jq_assert "chat suppressed_gate_ids is present when advisory events exist" '
  if ((.events // []) | any(.event_name=="safety_advisory_inline" or .event_name=="gate_advisory_inline")) then
    ((.session_patch.meta.suppressed_gate_ids // []) | type=="array") and ((.session_patch.meta.suppressed_gate_ids // []) | length >= 1)
  else
    true
  end
'
printf "%s\n" "$chat_json" | jq_assert "chat conflict path has no require-info gate event" '((.events // []) | any(.event_name=="safety_gate_require_info")) | not'

say "chat follow-up alternatives (goal+anchor should stay anchored)"
followup_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data "{
    \"message\":\"Find acne-focused alternatives and give me a clear pick recommendation.\",
    \"action\":{
      \"action_id\":\"chat.followup.alternatives\",
      \"kind\":\"action\",
      \"data\":{
        \"goal\":\"acne_focus\",
        \"prompt\":\"Find acne-focused alternatives and give me a clear pick recommendation.\",
        \"anchor\":{
          \"brand\":\"Lab Series\",
          \"name\":\"All-In-One Defense Lotion\",
          \"url\":\"${LAB_SERIES_URL}\"
        }
      }
    }
  }")"

printf "%s\n" "$followup_json" | jq_assert "follow-up returns analysis card (product_analysis or product_verdict)" '.cards | any(.type=="product_analysis" or .type=="product_verdict")'
printf "%s\n" "$followup_json" | jq_assert "follow-up carries goal signal (provenance or ops event)" '
  (
    [(.cards[]? | select(.type=="product_analysis") | (.payload.provenance.followup_goal // ""))] | any(. == "acne_focus")
  )
  or
  (
    (.ops.experiment_events // []) | any((.event_data.followup_goal // "") == "acne_focus")
  )
'
printf "%s\n" "$followup_json" | jq_assert "follow-up carries anchor-used signal (provenance or ops event)" '
  (
    [
      (.cards[]? | select(.type=="product_analysis") | (.payload.provenance.anchor_used // {}) | ((.anchor_product_id // .anchor_product_url // "") | tostring | length > 0))
    ] | any
  )
  or
  (
    (.ops.experiment_events // []) | any((.event_data.anchored // false) == true)
  )
'
printf "%s\n" "$followup_json" | jq_assert "follow-up provenance has anchor_used (legacy payload)" '
  if (.cards | any(.type=="product_analysis")) then
    (
      (.cards[]|select(.type=="product_analysis")|.payload.provenance.anchor_used) as $a |
      (($a.anchor_product_id // $a.anchor_product_url // "") | tostring | length) > 0
    )
  else
    true
  end
'
printf "%s\n" "$followup_json" | jq_assert "follow-up not missing anchor code (legacy payload)" '
  if (.cards | any(.type=="product_analysis")) then
    (
      [(.cards[]|select(.type=="product_analysis")|.payload.missing_info[]? | tostring | ascii_downcase)]
      | any(. == "followup_anchor_missing")
    ) | not
  else
    true
  end
'
printf "%s\n" "$followup_json" | jq_assert "follow-up alternatives contain no obvious non-skincare tools (legacy payload)" '
  if (.cards | any(.type=="product_analysis")) then
    (
      [
        (.cards[]|select(.type=="product_analysis")|.payload.competitors.candidates[]?),
        (.cards[]|select(.type=="product_analysis")|.payload.related_products.candidates[]?),
        (.cards[]|select(.type=="product_analysis")|.payload.dupes.candidates[]?)
      ] as $rows |
      (
        [$rows[] | (((.name // .display_name // "") + " " + (.category // "") + " " + (.product_type // "")) | ascii_downcase | test("(brush|makeup\\s*brush|applicator|tool\\b|blender)"))]
        | any
      ) | not
    )
  else
    true
  end
'
printf "%s\n" "$followup_json" | jq_assert "follow-up product_verdict keeps structured payload (chatcards)" '
  if (.cards | any(.type=="product_verdict")) then
    (
      .cards | any(
        .type=="product_verdict" and
        (
          (.sections // [])
          | any(.kind=="product_verdict_structured" and ((.verdict // "") | length > 0))
        )
      )
    )
  else
    true
  end
'

say "chat reco (recommendations OR confidence_notice under artifact gate)"
reco_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{
    "action":{
      "action_id":"chip.start.reco_products",
      "kind":"chip",
      "data":{
        "reply_text":"Recommend a few products",
        "include_alternatives":false,
        "profile_patch":{
          "skinType":"oily",
          "sensitivity":"low",
          "barrierStatus":"impaired",
          "goals":["dark_spots","acne"],
          "budgetTier":"¥500"
        }
      }
    },
    "session":{"state":"S2_DIAGNOSIS"}
  }')"

printf "%s\n" "$reco_json" | jq_assert "chat reco returns recommendations or confidence_notice" '
  .cards
  | any(.type=="recommendations")
    or any(.type=="confidence_notice")
'

if printf "%s\n" "$reco_json" | jq -e '.cards | any(.type=="recommendations")' >/dev/null; then
  printf "%s\n" "$reco_json" | jq_assert "recommendations length >= 1" '(.cards[]|select(.type=="recommendations")|.payload.recommendations|length) >= 1'
  printf "%s\n" "$reco_json" | jq_assert "first recommendation has retrieval provenance fields" '
    (.cards[]|select(.type=="recommendations")|.payload.recommendations[0]) as $r |
    ((( $r.retrieval_source // "" ) | length) > 0) and ((( $r.retrieval_reason // "" ) | length) > 0)
  '
  printf "%s\n" "$reco_json" | jq_assert "recommendations have no duplicate products" '
    (.cards[]|select(.type=="recommendations")|.payload.recommendations) as $recs |
    (($recs | map(
      (
        (.product_id // .sku.product_id // .sku.sku_id // "")
        | tostring
        | ascii_downcase
      )
    ) | map(select(length > 0))) ) as $ids |
    (($ids | length) == ($ids | unique | length))
  '
  reco_source="$(printf "%s\n" "$reco_json" | jq -r '([.cards[]|select(.type=="recommendations")|.payload.source][0] // "unknown")')"
  printf "reco_source=%s\n" "$reco_source"
  if [[ "$reco_source" == "artifact_matcher_v1" ]]; then
    printf "%s\n" "$reco_json" | jq_assert "matcher reco has explainability fields" '
      (.cards[]|select(.type=="recommendations")|.payload.recommendations[0]) as $r |
      (
        (($r.reasons // []) | type=="array" and length >= 1) or
        (($r.matched_ingredients // []) | type=="array" and length >= 1) or
        (($r.fit_explanations // []) | type=="array" and length >= 1)
      )
    '
  else
    printf "%s\n" "$reco_json" | jq_assert "reco reasons include user-context markers" '
      (.cards[]|select(.type=="recommendations")|.payload.recommendations) as $recs |
      (
        ($recs | map((.reasons // []) | join(" ")) | join(" || "))
        | test("last\\s*7d|check[- ]?in|upcoming\\s*plan|itinerary|barrier|tolerance|goal|sensitivity"; "i")
      ) == true
    '
  fi
  printf "%s\n" "$reco_json" | jq_assert "recos_requested event includes source when event stream is present" '
    (.events // []) as $ev |
    if ($ev | length) == 0 then
      true
    else
      ($ev | any((.event_name=="recos_requested") and (((.data.source // "") | length) > 0)))
    end
  '
else
  printf "%s\n" "$reco_json" | jq_assert "confidence_notice card exists" '.cards | any(.type=="confidence_notice")'
  printf "%s\n" "$reco_json" | jq_assert "recommendations absent when confidence_notice path" '(.cards | any(.type=="recommendations")) | not'
  printf "%s\n" "$reco_json" | jq_assert "recos_requested event includes reco degrade reason" '
    (.events // []) |
    any(
      (.event_name=="recos_requested") and
      (
        .data.reason=="artifact_missing" or
        .data.reason=="artifact_low_confidence" or
        .data.reason=="safety_block" or
        .data.reason=="timeout_degraded" or
        .data.reason=="upstream_empty_recommendations" or
        .data.reason=="upstream_schema_invalid" or
        .data.reason=="ingredient_constraint_no_match" or
        .data.reason=="low_confidence_treatment_filtered"
      )
    )
  '
fi

say "pregnancy due-date auto reset (non-blocking policy)"
preg_reset_uid="${AURORA_UID}_preg_reset"
preg_reset_json="$(curl_do -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  -H "X-Aurora-UID: ${preg_reset_uid}" \
  -H "X-Lang: ${AURORA_LANG}" \
  -H "X-Trace-ID: ${TRACE_ID}_preg_reset" \
  -H "X-Brief-ID: ${BRIEF_ID}_preg_reset" \
  --data '{
    "action":{
      "action_id":"chip.profile.seed.pregnancy",
      "kind":"chip",
      "data":{
        "reply_text":"seed pregnancy profile",
        "profile_patch":{"pregnancy_status":"pregnant","pregnancy_due_date":"2020-01-01"}
      }
    },
    "session":{"state":"S7_PRODUCT_RECO"}
  }')"
printf "%s\n" "$preg_reset_json" | jq_assert "pregnancy seed response has cards" '.cards | type=="array" and (length >= 1)'
printf "%s\n" "$preg_reset_json" | jq_assert "pregnancy_status_auto_reset event (optional stream) is valid when present" '
  (.events // []) as $ev |
  if ($ev | length) == 0 then
    true
  else
    ($ev | any(.event_name=="pregnancy_status_auto_reset"))
  end
'
preg_bootstrap_json="$(curl_do -fsS "${BASE}/v1/session/bootstrap" \
  -H "X-Aurora-UID: ${preg_reset_uid}" \
  -H "X-Lang: ${AURORA_LANG}" \
  -H "X-Trace-ID: ${TRACE_ID}_preg_reset_bootstrap" \
  -H "X-Brief-ID: ${BRIEF_ID}_preg_reset_bootstrap")"
printf "%s\n" "$preg_bootstrap_json" | jq_assert "pregnancy auto-reset applies to stored profile state" '
  (
    .cards[]? | select(.type=="session_bootstrap") | .payload.profile.pregnancy_status
  ) == "not_pregnant"
'

say "ui events ingest (POST /v1/events should return 204)"
events_code="$(curl_do -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/v1/events" \
  -H 'Content-Type: application/json' \
  --data "{\"source\":\"pivota-aurora-chatbox\",\"events\":[{\"event_name\":\"aurora_conflict_heatmap_impression\",\"brief_id\":\"${BRIEF_ID}\",\"trace_id\":\"${TRACE_ID}\",\"timestamp\":$(date +%s000),\"data\":{\"aurora_uid\":\"${AURORA_UID}\",\"lang\":\"${AURORA_LANG}\",\"state\":\"has_conflicts\"}},{\"event_name\":\"aurora_conflict_heatmap_cell_tap\",\"brief_id\":\"${BRIEF_ID}\",\"trace_id\":\"${TRACE_ID}\",\"timestamp\":$(date +%s000),\"data\":{\"aurora_uid\":\"${AURORA_UID}\",\"lang\":\"${AURORA_LANG}\",\"state\":\"has_conflicts\",\"row_index\":0,\"col_index\":1,\"severity\":2,\"rule_ids\":[\"retinoid_x_acids\"],\"step_a\":\"PM Treatment\",\"step_b\":\"Test Acid\"}}]}")"
if [[ "$events_code" != "204" ]]; then
  printf "\n[FAIL] ui events ingest\n  expected http_code=204 got=%s\n" "$events_code" >&2
  exit 1
fi
printf "[PASS] ui events ingest\n"

say "summary"
printf "PASS: runtime smoke OK\n"
