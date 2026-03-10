#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
RETURNING_UID="${RETURNING_UID:-uid_returning_canary_$(date +%s)}"
NEGATIVE_UID="${NEGATIVE_UID:-uid_returning_canary_negative_$(date +%s)}"
TRACE_ID="${TRACE_ID:-trace_returning_canary_$(date +%s)}"
BRIEF_ID="${BRIEF_ID:-brief_returning_canary_$(date +%s)}"
EXPECT_SUMMARY_TEXT="${EXPECT_SUMMARY_TEXT:-true}"
TARGET_DEPLOYMENT_ID="${TARGET_DEPLOYMENT_ID:-}"
TARGET_COMMIT="${TARGET_COMMIT:-}"
CURL_RETRY_MAX="${CURL_RETRY_MAX:-20}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
CURL_RETRY_MAX_TIME_SEC="${CURL_RETRY_MAX_TIME_SEC:-180}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RETURNING_HEADERS=(
  -H "Content-Type: application/json"
  -H "X-Aurora-UID: ${RETURNING_UID}"
  -H "X-Lang: ${AURORA_LANG}"
  -H "X-Trace-ID: ${TRACE_ID}"
  -H "X-Brief-ID: ${BRIEF_ID}"
)

NEGATIVE_HEADERS=(
  -H "Content-Type: application/json"
  -H "X-Aurora-UID: ${NEGATIVE_UID}"
  -H "X-Lang: ${AURORA_LANG}"
  -H "X-Trace-ID: ${TRACE_ID}_neg"
  -H "X-Brief-ID: ${BRIEF_ID}_neg"
)

say() {
  printf "\n== %s ==\n" "$1"
}

jq_assert() {
  local label="$1"
  local expr="$2"
  local file="$3"
  if ! jq -e "$expr" "$file" >/dev/null; then
    printf "\n[FAIL] %s\n" "$label" >&2
    printf "  jq expr: %s\n" "$expr" >&2
    printf "  file: %s\n" "$file" >&2
    exit 1
  fi
  printf "[PASS] %s\n" "$label"
}

curl_do() {
  curl --retry "${CURL_RETRY_MAX}" --retry-delay "${CURL_RETRY_DELAY_SEC}" --retry-max-time "${CURL_RETRY_MAX_TIME_SEC}" --retry-all-errors "$@"
}

normalize_bool() {
  local raw
  raw="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    true|1|yes|y|on) printf 'true' ;;
    false|0|no|n|off) printf 'false' ;;
    *) printf 'false' ;;
  esac
}

EXPECT_SUMMARY_TEXT_NORMALIZED="$(normalize_bool "${EXPECT_SUMMARY_TEXT}")"

printf "BASE=%s\nAURORA_LANG=%s\nRETURNING_UID=%s\nNEGATIVE_UID=%s\nTRACE_ID=%s\nBRIEF_ID=%s\nEXPECT_SUMMARY_TEXT=%s\nTARGET_DEPLOYMENT_ID=%s\nTARGET_COMMIT=%s\n" \
  "$BASE" "$AURORA_LANG" "$RETURNING_UID" "$NEGATIVE_UID" "$TRACE_ID" "$BRIEF_ID" "$EXPECT_SUMMARY_TEXT_NORMALIZED" "$TARGET_DEPLOYMENT_ID" "$TARGET_COMMIT"

say "deployed identity"
curl_do -sSI "${BASE}/v1/session/bootstrap" | tr -d '\r' | egrep '^(HTTP/|x-service-deployment-id:|x-service-commit:|x-aurora-build:)' || true

if [[ -n "$TARGET_DEPLOYMENT_ID" ]]; then
  deployed_id="$(
    curl_do -sSI "${BASE}/v1/session/bootstrap" \
      | tr -d '\r' \
      | awk -F': ' 'tolower($1)=="x-service-deployment-id" {print $2}' \
      | head -n 1
  )"
  if [[ "$deployed_id" != "$TARGET_DEPLOYMENT_ID" ]]; then
    printf "\n[FAIL] target deployment id mismatch\n  expected=%s\n  actual=%s\n" "$TARGET_DEPLOYMENT_ID" "${deployed_id:-missing}" >&2
    exit 1
  fi
  printf "[PASS] target deployment id matched\n"
fi

if [[ -n "$TARGET_COMMIT" ]]; then
  deployed_commit="$(
    curl_do -sSI "${BASE}/v1/session/bootstrap" \
      | tr -d '\r' \
      | awk -F': ' 'tolower($1)=="x-service-commit" {print $2}' \
      | head -n 1
  )"
  if [[ -z "$deployed_commit" ]]; then
    printf "[WARN] x-service-commit missing; skipping commit equality check\n"
  elif [[ "$deployed_commit" != "$TARGET_COMMIT" ]]; then
    printf "\n[FAIL] target commit mismatch\n  expected=%s\n  actual=%s\n" "$TARGET_COMMIT" "$deployed_commit" >&2
    exit 1
  else
    printf "[PASS] target commit matched\n"
  fi
fi

say "seed returning baseline"
curl_do -fsS -X POST "${BASE}/v1/profile/update" "${RETURNING_HEADERS[@]}" \
  --data '{"skinType":"oily","sensitivity":"low","barrierStatus":"healthy","goals":["acne","hydration"],"budgetTier":"$50","region":"US"}' \
  > "${TMP_DIR}/profile_update.json"
jq_assert "profile update returns profile card" '.cards | any(.type=="profile")' "${TMP_DIR}/profile_update.json"

curl_do -fsS -X POST "${BASE}/v1/tracker/log" "${RETURNING_HEADERS[@]}" \
  --data '{"date":"2026-03-01","acne":4,"redness":3,"hydration":2,"notes":"baseline"}' \
  > "${TMP_DIR}/tracker_log_1.json"
curl_do -fsS -X POST "${BASE}/v1/tracker/log" "${RETURNING_HEADERS[@]}" \
  --data '{"date":"2026-03-08","acne":2,"redness":2,"hydration":4,"notes":"improved"}' \
  > "${TMP_DIR}/tracker_log_2.json"

say "bootstrap returning user"
curl_do -fsS "${BASE}/v1/session/bootstrap" "${RETURNING_HEADERS[@]}" > "${TMP_DIR}/bootstrap.json"
jq_assert "bootstrap marks user as returning" '(.cards[] | select(.type=="session_bootstrap") | .payload.is_returning) == true' "${TMP_DIR}/bootstrap.json"

say "returning triage"
curl_do -fsS -X POST "${BASE}/v1/chat" "${RETURNING_HEADERS[@]}" \
  --data '{"action":{"action_id":"chip.start.diagnosis","kind":"chip","data":{"reply_text":"Start diagnosis"}}}' \
  > "${TMP_DIR}/triage.json"
jq_assert "triage returns returning_triage card" '.cards | any(.type=="returning_triage")' "${TMP_DIR}/triage.json"
jq_assert "triage section kinds are correct" '(.cards[] | select(.type=="returning_triage") | .payload.sections | map(.kind)) == ["previous_diagnosis_summary","returning_action_selection"]' "${TMP_DIR}/triage.json"
jq_assert "triage summary_text field exists" '(.cards[] | select(.type=="returning_triage") | .payload.sections[] | select(.kind=="previous_diagnosis_summary") | has("summary_text")) == true' "${TMP_DIR}/triage.json"
jq_assert "triage quick replies contain all 4 actions" '((.suggested_quick_replies // []) | map(.id)) as $ids | (["chip.action.reassess","chip.action.update_goals","chip.action.check_progress","chip.action.new_photo"] | all(. as $expected | $ids | index($expected)))' "${TMP_DIR}/triage.json"
jq_assert "triage diagnosis_state is returning_triage" '.session_patch.state.diagnosis_state == "returning_triage"' "${TMP_DIR}/triage.json"

if [[ "$EXPECT_SUMMARY_TEXT_NORMALIZED" == "true" ]]; then
  jq_assert "triage summary_text is non-empty" '((.cards[] | select(.type=="returning_triage") | .payload.sections[] | select(.kind=="previous_diagnosis_summary") | .summary_text) | type == "string" and length > 0)' "${TMP_DIR}/triage.json"
else
  printf "[INFO] summary_text non-empty assertion skipped because EXPECT_SUMMARY_TEXT=%s\n" "$EXPECT_SUMMARY_TEXT_NORMALIZED"
fi

say "update goals"
curl_do -fsS -X POST "${BASE}/v1/chat" "${RETURNING_HEADERS[@]}" \
  --data '{"action":{"action_id":"chip.action.update_goals","kind":"chip","data":{"reply_text":"Update my goals"}}}' \
  > "${TMP_DIR}/update_goals.json"
jq_assert "update_goals returns diagnosis_gate" '.cards | any(.type=="diagnosis_gate")' "${TMP_DIR}/update_goals.json"
jq_assert "update_goals does not return returning_triage" '(.cards | any(.type=="returning_triage")) | not' "${TMP_DIR}/update_goals.json"
jq_assert "update_goals reason is update_goals" '(.cards[] | select(.type=="diagnosis_gate") | .payload.reason) == "update_goals"' "${TMP_DIR}/update_goals.json"

say "check progress"
curl_do -fsS -X POST "${BASE}/v1/chat" "${RETURNING_HEADERS[@]}" \
  --data '{"action":{"action_id":"chip.action.check_progress","kind":"chip","data":{"reply_text":"Check my progress"}}}' \
  > "${TMP_DIR}/progress.json"
jq_assert "progress returns skin_progress card" '.cards | any(.type=="skin_progress")' "${TMP_DIR}/progress.json"
jq_assert "progress section kinds are correct" '(.cards[] | select(.type=="skin_progress") | .payload.sections | map(.kind)) == ["progress_baseline","progress_delta","progress_highlights","progress_recommendation"]' "${TMP_DIR}/progress.json"
jq_assert "progress diagnosis_state is progress_viewed" '.session_patch.state.diagnosis_state == "progress_viewed"' "${TMP_DIR}/progress.json"
jq_assert "progress experiment event emitted" '(.ops.experiment_events // []) | any(.event_type=="progress_viewed")' "${TMP_DIR}/progress.json"
jq_assert "no visual claims appear in no-photo progress text" '
  [
    (.cards[]? | select(.type=="skin_progress") | .payload.sections[]? | .text_en?),
    (.cards[]? | select(.type=="skin_progress") | .payload.sections[]? | .text_zh?),
    (.cards[]? | select(.type=="skin_progress") | .payload.sections[]? | .improvements[]?),
    (.cards[]? | select(.type=="skin_progress") | .payload.sections[]? | .regressions[]?),
    (.cards[]? | select(.type=="skin_progress") | .payload.sections[]? | .stable[]?),
    (.cards[]? | select(.type=="skin_progress") | .payload.sections[]? | .concern_deltas[]? | .note_en?),
    (.cards[]? | select(.type=="skin_progress") | .payload.sections[]? | .concern_deltas[]? | .note_zh?)
  ]
  | map(select(. != null and . != ""))
  | all(test("photo|image|picture|visual|visible|looks?|appears?|show(?:s|ing)?|from the photo|照片|图片|看起来|显示出|从照片"; "i") | not)
' "${TMP_DIR}/progress.json"

say "negative check progress without baseline"
curl_do -fsS -X POST "${BASE}/v1/chat" "${NEGATIVE_HEADERS[@]}" \
  --data '{"action":{"action_id":"chip.action.check_progress","kind":"chip","data":{"reply_text":"Check my progress"}}}' \
  > "${TMP_DIR}/progress_negative.json"
jq_assert "negative user does not get skin_progress" '(.cards | any(.type=="skin_progress")) | not' "${TMP_DIR}/progress_negative.json"
jq_assert "negative user gets diagnosis gate behavior" '.cards | any(.type=="diagnosis_gate" or .type=="confidence_notice")' "${TMP_DIR}/progress_negative.json"

say "summary"
jq -n \
  --arg base "$BASE" \
  --arg returning_uid "$RETURNING_UID" \
  --arg negative_uid "$NEGATIVE_UID" \
  --arg expect_summary_text "$EXPECT_SUMMARY_TEXT_NORMALIZED" \
  --slurpfile triage "${TMP_DIR}/triage.json" \
  --slurpfile progress "${TMP_DIR}/progress.json" \
  --slurpfile negative "${TMP_DIR}/progress_negative.json" \
  '{
    base: $base,
    returning_uid: $returning_uid,
    negative_uid: $negative_uid,
    expect_summary_text: $expect_summary_text,
    triage_summary_text: (($triage[0].cards[] | select(.type=="returning_triage") | .payload.sections[] | select(.kind=="previous_diagnosis_summary") | .summary_text) // null),
    triage_diagnosis_state: ($triage[0].session_patch.state.diagnosis_state // null),
    progress_diagnosis_state: ($progress[0].session_patch.state.diagnosis_state // null),
    negative_card_types: (($negative[0].cards // []) | map(.type))
  }'

printf "\nPASS: Aurora returning/progress canary completed.\n"
