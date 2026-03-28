#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
AURORA_UID_PREFIX="${AURORA_UID_PREFIX:-uid_aurora_skill_prod_smoke}"
LAB_SERIES_URL="${LAB_SERIES_URL:-https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one}"
CURL_MAX_TIME_SEC="${CURL_MAX_TIME_SEC:-45}"
CURL_RETRY_MAX="${CURL_RETRY_MAX:-2}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-reports/aurora_skill_routes_prod_smoke_${STAMP}}"

CURL_BIN="${CURL_BIN:-$(command -v curl)}"
JQ_BIN="${JQ_BIN:-$(command -v jq)}"
PY_BIN="${PY_BIN:-$(command -v python3)}"
LOCAL_HEAD_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || true)"

if [[ -z "${CURL_BIN:-}" || -z "${JQ_BIN:-}" || -z "${PY_BIN:-}" ]]; then
  echo "curl, jq, and python3 are required." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
SUMMARY_MD="${OUT_DIR}/summary.md"
SUMMARY_TSV="${OUT_DIR}/summary.tsv"

PASS_COUNT=0
FAIL_COUNT=0

cat >"$SUMMARY_MD" <<EOF
# Aurora skill routes production smoke

- base: \`$BASE\`
- language: \`$AURORA_LANG\`
- started_at_utc: \`$STAMP\`
- out_dir: \`$OUT_DIR\`

## Checks

EOF

printf "status\tcase\tcheck\tdetail\n" >"$SUMMARY_TSV"

say() {
  printf "\n== %s ==\n" "$1"
}

record_check() {
  local status="$1"
  local case_name="$2"
  local check_name="$3"
  local detail="$4"
  printf "%s\t%s\t%s\t%s\n" "$status" "$case_name" "$check_name" "$detail" >>"$SUMMARY_TSV"
  printf -- "- [%s] \`%s\` %s: %s\n" "$status" "$case_name" "$check_name" "$detail" >>"$SUMMARY_MD"
  if [[ "$status" == "PASS" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

case_paths() {
  local case_name="$1"
  echo "${OUT_DIR}/${case_name}.request.json ${OUT_DIR}/${case_name}.response.json ${OUT_DIR}/${case_name}.headers.txt ${OUT_DIR}/${case_name}.http_code ${OUT_DIR}/${case_name}.curl.err"
}

run_post_case() {
  local case_name="$1"
  local path="$2"
  local payload="$3"
  local request_file response_file headers_file http_file err_file
  read -r request_file response_file headers_file http_file err_file < <(case_paths "$case_name")
  printf "%s\n" "$payload" >"$request_file"
  local aurora_uid="${AURORA_UID_PREFIX}_${case_name}_$(date +%s)"
  local http_code
  http_code="$("$CURL_BIN" -sS \
    --retry "$CURL_RETRY_MAX" \
    --retry-delay "$CURL_RETRY_DELAY_SEC" \
    --retry-all-errors \
    --max-time "$CURL_MAX_TIME_SEC" \
    -X POST "${BASE}${path}" \
    -H "Content-Type: application/json" \
    -H "X-Aurora-UID: ${aurora_uid}" \
    -H "X-Lang: ${AURORA_LANG}" \
    -o "$response_file" \
    -D "$headers_file" \
    -w "%{http_code}" \
    --data "$payload" \
    2>"$err_file" || true)"
  printf "%s" "${http_code:-000}" >"$http_file"
}

run_get_case() {
  local case_name="$1"
  local path="$2"
  local request_file response_file headers_file http_file err_file
  read -r request_file response_file headers_file http_file err_file < <(case_paths "$case_name")
  printf "{}\n" >"$request_file"
  local aurora_uid="${AURORA_UID_PREFIX}_${case_name}_$(date +%s)"
  local http_code
  http_code="$("$CURL_BIN" -sS \
    --retry "$CURL_RETRY_MAX" \
    --retry-delay "$CURL_RETRY_DELAY_SEC" \
    --retry-all-errors \
    --max-time "$CURL_MAX_TIME_SEC" \
    "${BASE}${path}" \
    -H "X-Aurora-UID: ${aurora_uid}" \
    -H "X-Lang: ${AURORA_LANG}" \
    -o "$response_file" \
    -D "$headers_file" \
    -w "%{http_code}" \
    2>"$err_file" || true)"
  printf "%s" "${http_code:-000}" >"$http_file"
}

http_code_of() {
  local case_name="$1"
  cat "${OUT_DIR}/${case_name}.http_code"
}

response_file_of() {
  local case_name="$1"
  echo "${OUT_DIR}/${case_name}.response.json"
}

header_value_of() {
  local case_name="$1"
  local header_name="$2"
  local headers_file="${OUT_DIR}/${case_name}.headers.txt"
  tr -d '\r' <"$headers_file" | awk -F': ' -v name="$(printf "%s" "$header_name" | tr '[:upper:]' '[:lower:]')" '
    tolower($1) == name { print $2; exit }
  '
}

json_meta_value_of() {
  local case_name="$1"
  local meta_key="$2"
  local file
  file="$(response_file_of "$case_name")"
  "$PY_BIN" - "$file" "$meta_key" <<'PY'
import json, sys
path, key = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)
value = payload.get("meta", {}).get(key)
if isinstance(value, str):
    print(value)
PY
}

assert_http_ok() {
  local case_name="$1"
  local check_name="$2"
  local code
  code="$(http_code_of "$case_name")"
  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    record_check PASS "$case_name" "$check_name" "http_code=${code}"
  else
    local err_file="${OUT_DIR}/${case_name}.curl.err"
    local err_msg=""
    if [[ -s "$err_file" ]]; then
      err_msg="$(tr '\n' ' ' <"$err_file" | sed 's/[[:space:]]\+/ /g' | cut -c1-200)"
    fi
    record_check FAIL "$case_name" "$check_name" "http_code=${code}${err_msg:+ error=${err_msg}}"
  fi
}

assert_jq_expr() {
  local case_name="$1"
  local check_name="$2"
  local expr="$3"
  local file
  file="$(response_file_of "$case_name")"
  if "$JQ_BIN" -e "$expr" "$file" >/dev/null 2>&1; then
    record_check PASS "$case_name" "$check_name" "$expr"
  else
    record_check FAIL "$case_name" "$check_name" "$expr"
  fi
}

assert_card_any() {
  local case_name="$1"
  local check_name="$2"
  local expected_csv="$3"
  local file
  file="$(response_file_of "$case_name")"
  if "$PY_BIN" - "$file" "$expected_csv" <<'PY'
import json, sys
path = sys.argv[1]
expected = {token.strip() for token in sys.argv[2].split(",") if token.strip()}
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)
cards = payload.get("cards") or []
types = {str(card.get("card_type") or card.get("type") or "").strip() for card in cards}
raise SystemExit(0 if expected.intersection(types) else 1)
PY
  then
    record_check PASS "$case_name" "$check_name" "expected_any=${expected_csv}"
  else
    local cards
    cards="$("$PY_BIN" - "$file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    payload = json.load(fh)
cards = [str(card.get("card_type") or card.get("type") or "") for card in (payload.get("cards") or [])]
print(",".join(cards))
PY
)"
    record_check FAIL "$case_name" "$check_name" "expected_any=${expected_csv} actual=${cards:-<none>}"
  fi
}

assert_json_contains() {
  local case_name="$1"
  local check_name="$2"
  local needle="$3"
  local file
  file="$(response_file_of "$case_name")"
  if "$PY_BIN" - "$file" "$needle" <<'PY'
import json, sys
path, needle = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)
def walk(value):
    if isinstance(value, str):
        return needle in value
    if isinstance(value, list):
        return any(walk(item) for item in value)
    if isinstance(value, dict):
        return any(walk(item) for item in value.values())
    return False
raise SystemExit(0 if walk(payload) else 1)
PY
  then
    record_check PASS "$case_name" "$check_name" "contains=${needle}"
  else
    record_check FAIL "$case_name" "$check_name" "missing=${needle}"
  fi
}

assert_json_not_contains() {
  local case_name="$1"
  local check_name="$2"
  local needle="$3"
  local file
  file="$(response_file_of "$case_name")"
  if "$PY_BIN" - "$file" "$needle" <<'PY'
import json, sys
path, needle = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)
def walk(value):
    if isinstance(value, str):
        return needle in value
    if isinstance(value, list):
        return any(walk(item) for item in value)
    if isinstance(value, dict):
        return any(walk(item) for item in value.values())
    return False
raise SystemExit(1 if walk(payload) else 0)
PY
  then
    record_check PASS "$case_name" "$check_name" "not_contains=${needle}"
  else
    record_check FAIL "$case_name" "$check_name" "unexpected=${needle}"
  fi
}

travel_payload="$(cat <<'EOF'
{"action":{"action_id":"chip.start.travel","kind":"chip","data":{"reply_text":"Open travel skincare plan","trigger_source":"chip"}},"session":{"state":"IDLE_CHAT","profile":{"travel_plan":{"trip_id":"trip_tokyo_1","destination":"Tokyo","departure_region":"San Francisco","start_date":"2026-03-20","end_date":"2026-03-25"}}}}
EOF
)"

ingredient_payload="$(cat <<'EOF'
{"action":{"action_id":"chip.start.ingredients.entry","kind":"chip","data":{"reply_text":"Open ingredient hub","trigger_source":"chip"}},"session":{"state":"IDLE_CHAT"}}
EOF
)"

product_chat_payload="$(cat <<EOF
{"action":{"action_id":"chip.action.analyze_product","kind":"chip","data":{"reply_text":"${LAB_SERIES_URL}","product_anchor":{"url":"${LAB_SERIES_URL}"}}},"session":{"state":"IDLE_CHAT","profile":{"skin_type":"dry"}},"anchor_product_url":"${LAB_SERIES_URL}"}
EOF
)"

dupe_suggest_chat_payload="$(cat <<EOF
{"action":{"action_id":"chip.start.dupes","kind":"chip","data":{"reply_text":"Find dupes: ${LAB_SERIES_URL}","product_anchor":{"url":"${LAB_SERIES_URL}"}}},"session":{"state":"IDLE_CHAT"},"anchor_product_url":"${LAB_SERIES_URL}"}
EOF
)"

dupe_compare_chat_payload="$(cat <<'EOF'
{"action":{"action_id":"chip.action.dupe_compare","kind":"chip","data":{"reply_text":"Compare: Budget Lab Barrier Daily Cream","product_anchor":{"brand":"Glow Lab","name":"Barrier Cloud Cream"},"comparison_targets":[{"brand":"Budget Lab","name":"Barrier Daily Cream"}]}},"session":{"state":"IDLE_CHAT"}}
EOF
)"

product_legacy_payload='{"name":"Nivea Creme"}'
dupe_suggest_legacy_payload="$(cat <<EOF
{"original_url":"${LAB_SERIES_URL}"}
EOF
)"
dupe_compare_legacy_payload='{"original":{"brand":"Glow Lab","name":"Barrier Cloud Cream"},"dupe":{"brand":"Budget Lab","name":"Barrier Daily Cream"}}'

say "health"
run_get_case "health" "/health"
assert_http_ok "health" "http_ok"
assert_jq_expr "health" "skill_router_v2_enabled" '.aurora_chat_contract.skill_router_v2 == true'
assert_jq_expr "health" "delegation_mode_compatible_only" '.aurora_chat_contract.v1_chat_v2_delegation_mode == "compatible_only"'

say "ingredient entry via /v1/chat"
run_post_case "ingredient_chat" "/v1/chat" "$ingredient_payload"
assert_http_ok "ingredient_chat" "http_ok"
assert_card_any "ingredient_chat" "returns_ingredient_hub" "ingredient_hub"

say "travel entry via /v1/chat"
run_post_case "travel_chat" "/v1/chat" "$travel_payload"
assert_http_ok "travel_chat" "http_ok"
assert_card_any "travel_chat" "returns_travel_card" "travel"
assert_json_contains "travel_chat" "travel_context_contains_destination" "Tokyo"
assert_json_contains "travel_chat" "travel_context_contains_start_date" "2026-03-20"
assert_json_contains "travel_chat" "travel_context_contains_end_date" "2026-03-25"
assert_json_not_contains "travel_chat" "travel_not_marked_destination_missing" "destination_missing"

say "product analyze via /v1/chat"
run_post_case "product_chat" "/v1/chat" "$product_chat_payload"
assert_http_ok "product_chat" "http_ok"
assert_card_any "product_chat" "returns_product_result_card" "product_verdict"
assert_json_not_contains "product_chat" "product_not_anchor_gate_only" "anchor_id_not_used_due_to_low_trust"
assert_json_not_contains "product_chat" "product_mainline_not_blocked" "\"mainline_blocked\":true"
assert_json_not_contains "product_chat" "product_no_fallback_flag" "\"fallback_used\":true"
assert_json_not_contains "product_chat" "product_not_empty_state" "\"empty_state\""

say "dupe suggest via /v1/chat"
run_post_case "dupe_suggest_chat" "/v1/chat" "$dupe_suggest_chat_payload"
assert_http_ok "dupe_suggest_chat" "http_ok"
assert_card_any "dupe_suggest_chat" "returns_dupe_suggest_card" "dupe_suggest"
assert_json_not_contains "dupe_suggest_chat" "dupe_suggest_not_open_world_only" "\"recommendation_mode_final\":\"open_world_only\""
assert_json_not_contains "dupe_suggest_chat" "dupe_suggest_not_fallback_reco" "fallback_reco"
assert_json_not_contains "dupe_suggest_chat" "dupe_suggest_mainline_not_blocked" "\"mainline_blocked\":true"
assert_json_not_contains "dupe_suggest_chat" "dupe_suggest_no_fallback_flag" "\"fallback_used\":true"
assert_json_not_contains "dupe_suggest_chat" "dupe_suggest_not_empty_state" "\"empty_state\""

say "dupe compare via /v1/chat"
run_post_case "dupe_compare_chat" "/v1/chat" "$dupe_compare_chat_payload"
assert_http_ok "dupe_compare_chat" "http_ok"
assert_card_any "dupe_compare_chat" "returns_dupe_compare_card" "compatibility"
assert_json_not_contains "dupe_compare_chat" "dupe_compare_mainline_not_blocked" "\"mainline_blocked\":true"
assert_json_not_contains "dupe_compare_chat" "dupe_compare_no_fallback_flag" "\"fallback_used\":true"
assert_json_not_contains "dupe_compare_chat" "dupe_compare_not_empty_state" "\"empty_state\""

say "legacy product analyze"
run_post_case "product_legacy" "/v1/product/analyze" "$product_legacy_payload"
assert_http_ok "product_legacy" "http_ok"
assert_card_any "product_legacy" "returns_legacy_product_analysis" "product_analysis"

say "legacy dupe suggest"
run_post_case "dupe_suggest_legacy" "/v1/dupe/suggest" "$dupe_suggest_legacy_payload"
assert_http_ok "dupe_suggest_legacy" "http_ok"
assert_card_any "dupe_suggest_legacy" "returns_legacy_dupe_suggest" "dupe_suggest"

say "legacy dupe compare"
run_post_case "dupe_compare_legacy" "/v1/dupe/compare" "$dupe_compare_legacy_payload"
assert_http_ok "dupe_compare_legacy" "http_ok"
assert_card_any "dupe_compare_legacy" "returns_legacy_dupe_compare" "dupe_compare,compatibility"

SERVICE_COMMIT="$(header_value_of "health" "x-service-commit" || true)"
INGREDIENT_BUILD_SHA="$(json_meta_value_of "ingredient_chat" "build_sha" || true)"
TRAVEL_BUILD_SHA="$(json_meta_value_of "travel_chat" "build_sha" || true)"
PRODUCT_BUILD_SHA="$(json_meta_value_of "product_chat" "build_sha" || true)"

cat >>"$SUMMARY_MD" <<EOF

## Build Metadata

- local_head_commit: \`${LOCAL_HEAD_COMMIT:-unknown}\`
- health_x_service_commit: \`${SERVICE_COMMIT:-missing}\`
- ingredient_chat_meta_build_sha: \`${INGREDIENT_BUILD_SHA:-missing}\`
- travel_chat_meta_build_sha: \`${TRAVEL_BUILD_SHA:-missing}\`
- product_chat_meta_build_sha: \`${PRODUCT_BUILD_SHA:-missing}\`

EOF

cat >>"$SUMMARY_MD" <<EOF

## Totals

- pass: $PASS_COUNT
- fail: $FAIL_COUNT

EOF

printf "\nSmoke artifacts: %s\n" "$OUT_DIR"
printf "Pass: %s\nFail: %s\n" "$PASS_COUNT" "$FAIL_COUNT"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
