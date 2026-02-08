#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-CN}"
AURORA_UID="${AURORA_UID:-test_uid_entry_smoke_$(date +%s)}"

CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
PY_BIN="${PY_BIN:-/usr/bin/python3}"

if [[ ! -x "$CURL_BIN" ]]; then
  CURL_BIN="$(command -v curl)"
fi
if [[ ! -x "$PY_BIN" ]]; then
  PY_BIN="$(command -v python3)"
fi

if [[ -z "${CURL_BIN:-}" || -z "${PY_BIN:-}" ]]; then
  echo "curl/python3 not found." >&2
  exit 1
fi

say() {
  printf "\n== %s ==\n" "$1"
}

post_json() {
  local path="$1"
  local data="$2"
  "$CURL_BIN" -sS -X POST "${BASE}${path}" \
    -H "Content-Type: application/json" \
    -H "X-Aurora-UID: ${AURORA_UID}" \
    -d "$data"
}

capture_case() {
  local key="$1"
  local path="$2"
  local data="$3"
  local tmp
  tmp="$(mktemp)"
  post_json "$path" "$data" >"$tmp"
  export "CASE_${key}=$tmp"
}

extract_summary() {
  local file="$1"
  "$PY_BIN" -c 'import json,sys; j=json.load(open(sys.argv[1])); cards=[c.get("type") for c in (j.get("cards") or [])]; first=((j.get("assistant_message") or {}).get("content") or "").splitlines()[:1]; print("cards=",cards); print("first=",first)' "$file"
}

assert_cards() {
  local file="$1"
  local mode="$2"
  local expected_csv="$3"
  "$PY_BIN" -c '
import json,sys
path, mode, expected = sys.argv[1], sys.argv[2], [s for s in sys.argv[3].split(",") if s]
j = json.load(open(path))
cards = [c.get("type") for c in (j.get("cards") or [])]
if mode == "exact":
    ok = cards == expected
elif mode == "contains_all":
    ok = all(e in cards for e in expected)
elif mode == "contains_any":
    ok = any(e in cards for e in expected)
elif mode == "contains_none":
    ok = all(e not in cards for e in expected)
else:
    raise SystemExit(f"unknown mode: {mode}")
if not ok:
    raise SystemExit(f"assert_cards failed mode={mode} expected={expected} got={cards}")
' "$file" "$mode" "$expected_csv"
}

cleanup() {
  rm -f "${CASE_profile:-}" "${CASE_fit:-}" "${CASE_reco:-}" "${CASE_antia:-}" "${CASE_env:-}" "${CASE_conflict:-}" "${CASE_stale:-}" "${CASE_gate:-}" || true
}
trap cleanup EXIT

printf "BASE=%s\nAURORA_LANG=%s\nAURORA_UID=%s\n" "$BASE" "$AURORA_LANG" "$AURORA_UID"

say "1) no-profile recommendation gate"
capture_case "gate" "/v1/chat" "{\"message\":\"要烟酰胺精华，最好温和点\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_gate"
assert_cards "$CASE_gate" "contains_all" "diagnosis_gate"
assert_cards "$CASE_gate" "contains_none" "recommendations"

say "2) profile patch"
capture_case "profile" "/v1/profile/update" '{"skinType":"oily","sensitivity":"low","barrierStatus":"healthy","goals":["brightening","acne"],"region":"CN","budgetTier":"¥500"}'
extract_summary "$CASE_profile"
assert_cards "$CASE_profile" "contains_all" "profile"

say "3) fit-check"
capture_case "fit" "/v1/chat" '{"message":"这款适不适合我：The Ordinary Niacinamide 10% + Zinc 1%","language":"CN","session":{"state":"idle"}}'
extract_summary "$CASE_fit"
assert_cards "$CASE_fit" "contains_all" "aurora_structured,product_analysis"

say "4) reco"
capture_case "reco" "/v1/chat" '{"message":"要烟酰胺精华，最好温和点","language":"CN","session":{"state":"idle"}}'
extract_summary "$CASE_reco"
assert_cards "$CASE_reco" "contains_all" "recommendations"

say "5) anti-aging"
capture_case "antia" "/v1/chat" '{"message":"我想抗老，给我一个低刺激方案","language":"CN","session":{"state":"idle"}}'
extract_summary "$CASE_antia"
assert_cards "$CASE_antia" "contains_all" "recommendations"

say "6) env stress"
capture_case "env" "/v1/chat" '{"message":"明天要下雪，我应该注意什么？","language":"CN","session":{"state":"idle"}}'
extract_summary "$CASE_env"
assert_cards "$CASE_env" "contains_all" "env_stress"

say "7) conflict"
capture_case "conflict" "/v1/chat" '{"message":"阿达帕林/维A + 果酸同晚叠加？","language":"CN","session":{"state":"idle"}}'
extract_summary "$CASE_conflict"
assert_cards "$CASE_conflict" "contains_all" "routine_simulation,conflict_heatmap"

say "8) stale budget chip (strict guard)"
capture_case "stale" "/v1/chat" '{"action":{"action_id":"chip.clarify.budget.y500","kind":"chip","data":{"clarification_id":"budget","reply_text":"¥500"}},"message":"¥500","session":{"state":"idle"},"client_state":"RECO_GATE","language":"CN"}'
extract_summary "$CASE_stale"
assert_cards "$CASE_stale" "contains_none" "recommendations,diagnosis_gate"
assert_cards "$CASE_stale" "contains_all" "profile"

say "PASS"
echo "entry-route smoke checks passed."
