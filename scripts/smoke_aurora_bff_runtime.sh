#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
AURORA_UID="${AURORA_UID:-uid_release_gate_$(date +%s)}"
TRACE_ID="${TRACE_ID:-t_$(date +%s)}"
BRIEF_ID="${BRIEF_ID:-b_$(date +%s)}"

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

printf "BASE=%s\nAURORA_LANG=%s\nAURORA_UID=%s\nTRACE_ID=%s\nBRIEF_ID=%s\n" "$BASE" "$AURORA_LANG" "$AURORA_UID" "$TRACE_ID" "$BRIEF_ID"

say "deployed commit (best-effort)"
curl -sSI "${BASE}/v1/session/bootstrap" | grep -i '^x-service-commit:' || true

say "session bootstrap"
bootstrap_json="$(curl -fsS "${BASE}/v1/session/bootstrap" "${COMMON_HEADERS[@]}")"
printf "%s\n" "$bootstrap_json" | jq_assert "bootstrap envelope has cards" '.cards | type=="array" and (length >= 1)'
printf "%s\n" "$bootstrap_json" | jq -r '.cards[0].type' >/dev/null || true

say "reco gate (missing profile -> diagnosis_gate, no recommendations)"
gate_json="$(curl -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{
    "action":{
      "action_id":"chip.start.reco_products",
      "kind":"chip",
      "data":{"reply_text":"Recommend a few products","include_alternatives":false}
    },
    "session":{"state":"S2_DIAGNOSIS"}
  }')"
printf "%s\n" "$gate_json" | jq_assert "diagnosis_gate card exists" '.cards | any(.type=="diagnosis_gate")'
printf "%s\n" "$gate_json" | jq_assert "recommendations card absent" '(.cards | any(.type=="recommendations")) | not'

say "profile update (core + itinerary)"
profile_json="$(curl -fsS -X POST "${BASE}/v1/profile/update" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"skinType":"oily","sensitivity":"low","barrierStatus":"impaired","goals":["dark_spots","acne"],"budgetTier":"¥500","itinerary":"Travel next week (cold/dry), lots of outdoor time"}')"

printf "%s\n" "$profile_json" | jq_assert "profile card exists" '.cards | any(.type=="profile")'

say "session bootstrap (after profile update)"
bootstrap2_json="$(curl -fsS "${BASE}/v1/session/bootstrap" "${COMMON_HEADERS[@]}")"
printf "%s\n" "$bootstrap2_json" | jq_assert "is_returning=true" '(.cards[]|select(.type=="session_bootstrap")|.payload.is_returning) == true'
printf "%s\n" "$bootstrap2_json" | jq_assert "profile.itinerary persisted" '(.cards[]|select(.type=="session_bootstrap")|.payload.profile.itinerary) == "Travel next week (cold/dry), lots of outdoor time"'

say "tracker log + recent (7d)"
tracker_json="$(curl -fsS -X POST "${BASE}/v1/tracker/log" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"redness":1,"acne":2,"hydration":3,"notes":"quick check-in"}')"

printf "%s\n" "$tracker_json" | jq_assert "tracker_log card exists" '.cards | any(.type=="tracker_log")'

recent_json="$(curl -fsS "${BASE}/v1/tracker/recent?days=7" "${COMMON_HEADERS[@]}")"
printf "%s\n" "$recent_json" | jq_assert "tracker_recent card exists" '.cards | any(.type=="tracker_recent")'
printf "%s\n" "$recent_json" | jq_assert "recent logs length >= 1" '(.cards[]|select(.type=="tracker_recent")|.payload.logs|length) >= 1'

say "skin analysis (empty body ok)"
skin_json="$(curl -fsS -X POST "${BASE}/v1/analysis/skin" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{}')"

printf "%s\n" "$skin_json" | jq_assert "analysis_summary card exists" '.cards | any(.type=="analysis_summary")'
printf "%s\n" "$skin_json" | jq_assert "analysis field_missing is null" '(.cards[]|select(.type=="analysis_summary")|.field_missing) == null'
printf "%s\n" "$skin_json" | jq_assert "analysis has 1+ features" '(.cards[]|select(.type=="analysis_summary")|.payload.analysis.features|length) >= 1'
printf "%s\n" "$skin_json" | jq_assert "analysis has strategy" '((.cards[]|select(.type=="analysis_summary")|.payload.analysis.strategy)//"") | length > 0'

say "product analyze (Nivea Creme)"
analyze_json="$(curl -fsS -X POST "${BASE}/v1/product/analyze" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"name":"Nivea Creme"}')"

printf "%s\n" "$analyze_json" | jq_assert "product_analysis card exists" '.cards | any(.type=="product_analysis")'
printf "%s\n" "$analyze_json" | jq_assert "verdict is present" '((.cards[]|select(.type=="product_analysis")|.payload.assessment.verdict)//"") | length > 0'
printf "%s\n" "$analyze_json" | jq_assert "reasons length >= 1" '(.cards[]|select(.type=="product_analysis")|.payload.assessment.reasons|length) >= 1'

say "dupe compare (real products -> should have tradeoffs)"
dupe_json="$(curl -fsS -X POST "${BASE}/v1/dupe/compare" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"original":{"brand":"Nivea","name":"Creme"},"dupe":{"brand":"The Ordinary","name":"Hyaluronic Acid 2% + B5"}}')"

printf "%s\n" "$dupe_json" | jq_assert "dupe_compare card exists" '.cards | any(.type=="dupe_compare")'
printf "%s\n" "$dupe_json" | jq_assert "tradeoffs length >= 1" '(.cards[]|select(.type=="dupe_compare")|.payload.tradeoffs|length) >= 1'
printf "%s\n" "$dupe_json" | jq_assert "first tradeoff looks human" '((.cards[]|select(.type=="dupe_compare")|.payload.tradeoffs[0])//"") | length >= 20'

say "routine simulate (retinoid × acids -> should produce conflict heatmap cell)"
routine_json="$(curl -fsS -X POST "${BASE}/v1/routine/simulate" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"routine":{"pm":[{"step":"Treatment","key_actives":["retinol"]}]},"test_product":{"name":"Test Acid","key_actives":["glycolic acid"]}}')"

printf "%s\n" "$routine_json" | jq_assert "routine_simulation card exists" '.cards | any(.type=="routine_simulation")'
printf "%s\n" "$routine_json" | jq_assert "conflict_heatmap card exists" '.cards | any(.type=="conflict_heatmap")'
printf "%s\n" "$routine_json" | jq_assert "heatmap has 2+ steps" '(.cards[]|select(.type=="conflict_heatmap")|.payload.axes.rows.items|length) >= 2'
printf "%s\n" "$routine_json" | jq_assert "heatmap has >=1 cell" '(.cards[]|select(.type=="conflict_heatmap")|.payload.cells.items|length) >= 1'
printf "%s\n" "$routine_json" | jq_assert "first cell has headline/why/recommendations" '(.cards[]|select(.type=="conflict_heatmap")|.payload.cells.items[0]) | ((.headline_i18n.en//"")|length>0) and ((.why_i18n.en//"")|length>0) and ((.recommendations|length) >= 1)'

say "chat conflict question (should include routine_simulation + conflict_heatmap)"
chat_json="$(curl -fsS -X POST "${BASE}/v1/chat" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data '{"message":"My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.","session":{"state":"S7_PRODUCT_RECO"}}')"

printf "%s\n" "$chat_json" | jq_assert "/v1/chat returns cards array" '.cards | type=="array"'
printf "%s\n" "$chat_json" | jq_assert "chat includes routine_simulation" '.cards | any(.type=="routine_simulation")'
printf "%s\n" "$chat_json" | jq_assert "chat includes conflict_heatmap" '.cards | any(.type=="conflict_heatmap")'
printf "%s\n" "$chat_json" | jq_assert "chat heatmap has >=1 cell" '(.cards[]|select(.type=="conflict_heatmap")|.payload.cells.items|length) >= 1'

say "chat reco (reasons include logs + itinerary)"
reco_json="$(curl -fsS -X POST "${BASE}/v1/chat" \
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

printf "%s\n" "$reco_json" | jq_assert "recommendations card exists" '.cards | any(.type=="recommendations")'
printf "%s\n" "$reco_json" | jq_assert "recommendations length >= 1" '(.cards[]|select(.type=="recommendations")|.payload.recommendations|length) >= 1'
printf "%s\n" "$reco_json" | jq_assert "reco reasons mention recent logs" '(.cards[]|select(.type=="recommendations")|.payload.recommendations[0].reasons | any(test("Last 7d:"))) == true'
printf "%s\n" "$reco_json" | jq_assert "reco reasons mention itinerary" '(.cards[]|select(.type=="recommendations")|.payload.recommendations[0].reasons | any(test("Upcoming plan:"))) == true'

say "ui events ingest (POST /v1/events should return 204)"
events_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/v1/events" \
  -H 'Content-Type: application/json' \
  --data "{\"source\":\"pivota-aurora-chatbox\",\"events\":[{\"event_name\":\"aurora_conflict_heatmap_impression\",\"brief_id\":\"${BRIEF_ID}\",\"trace_id\":\"${TRACE_ID}\",\"timestamp\":$(date +%s000),\"data\":{\"aurora_uid\":\"${AURORA_UID}\",\"lang\":\"${AURORA_LANG}\",\"state\":\"has_conflicts\"}},{\"event_name\":\"aurora_conflict_heatmap_cell_tap\",\"brief_id\":\"${BRIEF_ID}\",\"trace_id\":\"${TRACE_ID}\",\"timestamp\":$(date +%s000),\"data\":{\"aurora_uid\":\"${AURORA_UID}\",\"lang\":\"${AURORA_LANG}\",\"state\":\"has_conflicts\",\"row_index\":0,\"col_index\":1,\"severity\":2,\"rule_ids\":[\"retinoid_x_acids\"],\"step_a\":\"PM Treatment\",\"step_b\":\"Test Acid\"}}]}")"
if [[ "$events_code" != "204" ]]; then
  printf "\n[FAIL] ui events ingest\n  expected http_code=204 got=%s\n" "$events_code" >&2
  exit 1
fi
printf "[PASS] ui events ingest\n"

say "summary"
printf "PASS: runtime smoke OK\n"
