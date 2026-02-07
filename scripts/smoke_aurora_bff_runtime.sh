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

say "ui events ingest (POST /v1/events should return 204)"
events_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/v1/events" \
  -H 'Content-Type: application/json' \
  --data "{\"source\":\"pivota-aurora-chatbox\",\"events\":[{\"event_name\":\"aurora_conflict_heatmap_impression\",\"brief_id\":\"${BRIEF_ID}\",\"trace_id\":\"${TRACE_ID}\",\"timestamp\":$(date +%s000),\"data\":{\"aurora_uid\":\"${AURORA_UID}\",\"lang\":\"${AURORA_LANG}\",\"state\":\"has_conflicts\"}}]}")"
if [[ "$events_code" != "204" ]]; then
  printf "\n[FAIL] ui events ingest\n  expected http_code=204 got=%s\n" "$events_code" >&2
  exit 1
fi
printf "[PASS] ui events ingest\n"

say "summary"
printf "PASS: runtime smoke OK\n"
