#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-CN}"
AURORA_UID="${AURORA_UID:-test_uid_entry_smoke_$(date +%s)}"
LANG_UPPER="$(printf "%s" "${AURORA_LANG}" | tr '[:lower:]' '[:upper:]')"
CHECK_POSITIVE_TONE="${CHECK_POSITIVE_TONE:-true}"
BANNED_PHRASES_CN="${BANNED_PHRASES_CN:-焦虑,别慌,恐慌,慌了}"
BANNED_PHRASES_EN="${BANNED_PHRASES_EN:-low-stress,anxious,panic}"

CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
PY_BIN="${PY_BIN:-/usr/bin/python3}"
CURL_CONN_RESET_RETRIES="${CURL_CONN_RESET_RETRIES:-1}"
CURL_CONN_RESET_SLEEP_SEC="${CURL_CONN_RESET_SLEEP_SEC:-1}"

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
  local attempt=0
  local max_retries=0
  local rc=0

  if [[ "$CURL_CONN_RESET_RETRIES" =~ ^[0-9]+$ ]]; then
    max_retries="$CURL_CONN_RESET_RETRIES"
  fi

  while true; do
    if "$CURL_BIN" -sS -X POST "${BASE}${path}" \
      -H "Content-Type: application/json" \
      -H "X-Aurora-UID: ${AURORA_UID}" \
      -d "$data"; then
      return 0
    fi
    rc=$?
    if [[ "$rc" -eq 35 && "$attempt" -lt "$max_retries" ]]; then
      attempt=$((attempt + 1))
      echo "[warn] curl connection reset (rc=35), retry ${attempt}/${max_retries} ..." >&2
      sleep "$CURL_CONN_RESET_SLEEP_SEC"
      continue
    fi
    return "$rc"
  done
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

assert_no_banned_first_line() {
  local file="$1"
  local lang="$2"
  if [[ "$CHECK_POSITIVE_TONE" != "true" ]]; then
    return 0
  fi
  "$PY_BIN" -c '
import json, sys
path, lang = sys.argv[1], (sys.argv[2] or "").upper()
j = json.load(open(path))
content = ((j.get("assistant_message") or {}).get("content") or "")
first = ""
for line in str(content).splitlines():
    line = line.strip()
    if line:
        first = line
        break
if not first:
    raise SystemExit(0)

def parse_terms(raw):
    return [t.strip() for t in str(raw or "").split(",") if t.strip()]

if lang in ("EN", "EN-US", "EN_GB", "EN-UK"):
    banned = parse_terms(sys.argv[4]) or ["low-stress", "anxious", "panic"]
    haystack = first.lower()
else:
    banned = parse_terms(sys.argv[3]) or ["焦虑", "别慌", "恐慌", "慌了"]
    haystack = first

for term in banned:
    needle = term.lower() if lang in ("EN", "EN-US", "EN_GB", "EN-UK") else term
    if needle and needle in haystack:
        raise SystemExit(f"positive-tone check failed; banned phrase matched ({term}) in first line: {first}")
' "$file" "$lang" "$BANNED_PHRASES_CN" "$BANNED_PHRASES_EN"
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

assert_reco_stage() {
  local file="$1"
  "$PY_BIN" -c '
import json,sys
path = sys.argv[1]
j = json.load(open(path))
cards = j.get("cards") or []
types = [c.get("type") for c in cards]
if "recommendations" in types:
    raise SystemExit(0)
if "confidence_notice" not in types:
    raise SystemExit(f"reco stage expected recommendations or confidence_notice, got={types}")
reason = None
for c in cards:
    if c.get("type") == "confidence_notice":
        reason = ((c.get("payload") or {}).get("reason") or "")
        break
allowed = {"artifact_missing", "low_confidence", "safety_block", "timeout_degraded"}
if reason not in allowed:
    raise SystemExit(f"confidence_notice reason unexpected: {reason!r}, allowed={sorted(allowed)}")
' "$file"
}

cleanup() {
  rm -f "${CASE_profile:-}" "${CASE_fit:-}" "${CASE_reco:-}" "${CASE_antia:-}" "${CASE_env:-}" "${CASE_conflict:-}" "${CASE_stale:-}" "${CASE_gate:-}" || true
}
trap cleanup EXIT

printf "BASE=%s\nAURORA_LANG=%s\nAURORA_UID=%s\n" "$BASE" "$AURORA_LANG" "$AURORA_UID"

if [[ "$LANG_UPPER" == "CN" || "$LANG_UPPER" == "ZH" || "$LANG_UPPER" == "ZH-CN" ]]; then
  MSG_GATE='要烟酰胺精华，最好温和点'
  MSG_FIT='这款适不适合我：The Ordinary Niacinamide 10% + Zinc 1%'
  MSG_RECO='要烟酰胺精华，最好温和点'
  MSG_ANTI='我想抗老，给我一个低刺激方案'
  MSG_ENV='明天要下雪，我应该注意什么？'
  MSG_CONFLICT='阿达帕林/维A + 果酸同晚叠加？'
else
  MSG_GATE='Recommend a gentle niacinamide serum.'
  MSG_FIT='Is this suitable for me: The Ordinary Niacinamide 10% + Zinc 1%?'
  MSG_RECO='Recommend a gentle niacinamide serum.'
  MSG_ANTI='I want an anti-aging routine with low irritation.'
  MSG_ENV='It may snow tomorrow. What should I watch out for?'
  MSG_CONFLICT='Can I layer adapalene/retinoid with glycolic acid on the same night?'
fi

say "1) no-profile recommendation gate"
capture_case "gate" "/v1/chat" "{\"message\":\"${MSG_GATE}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_gate"
assert_no_banned_first_line "$CASE_gate" "$LANG_UPPER"
assert_cards "$CASE_gate" "contains_all" "diagnosis_gate"
assert_cards "$CASE_gate" "contains_none" "recommendations"

say "2) profile patch"
capture_case "profile" "/v1/profile/update" '{"skinType":"oily","sensitivity":"low","barrierStatus":"healthy","goals":["brightening","acne"],"region":"CN","budgetTier":"¥500"}'
extract_summary "$CASE_profile"
assert_no_banned_first_line "$CASE_profile" "$LANG_UPPER"
assert_cards "$CASE_profile" "contains_all" "profile"

say "3) fit-check"
capture_case "fit" "/v1/chat" "{\"message\":\"${MSG_FIT}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_fit"
assert_no_banned_first_line "$CASE_fit" "$LANG_UPPER"
assert_cards "$CASE_fit" "contains_all" "aurora_structured,product_analysis"

say "4) reco"
capture_case "reco" "/v1/chat" "{\"message\":\"${MSG_RECO}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_reco"
assert_no_banned_first_line "$CASE_reco" "$LANG_UPPER"
assert_reco_stage "$CASE_reco"

say "5) anti-aging"
capture_case "antia" "/v1/chat" "{\"message\":\"${MSG_ANTI}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_antia"
assert_no_banned_first_line "$CASE_antia" "$LANG_UPPER"
assert_reco_stage "$CASE_antia"

say "6) env stress"
capture_case "env" "/v1/chat" "{\"message\":\"${MSG_ENV}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_env"
assert_no_banned_first_line "$CASE_env" "$LANG_UPPER"
assert_cards "$CASE_env" "contains_all" "env_stress"

say "7) conflict"
capture_case "conflict" "/v1/chat" "{\"message\":\"${MSG_CONFLICT}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_conflict"
assert_no_banned_first_line "$CASE_conflict" "$LANG_UPPER"
assert_cards "$CASE_conflict" "contains_all" "routine_simulation,conflict_heatmap"

say "8) stale budget chip (strict guard)"
capture_case "stale" "/v1/chat" "{\"action\":{\"action_id\":\"chip.clarify.budget.y500\",\"kind\":\"chip\",\"data\":{\"clarification_id\":\"budget\",\"reply_text\":\"¥500\"}},\"message\":\"¥500\",\"session\":{\"state\":\"idle\"},\"client_state\":\"RECO_GATE\",\"language\":\"${AURORA_LANG}\"}"
extract_summary "$CASE_stale"
assert_no_banned_first_line "$CASE_stale" "$LANG_UPPER"
assert_cards "$CASE_stale" "contains_none" "recommendations,diagnosis_gate"
assert_cards "$CASE_stale" "contains_all" "profile"

say "PASS"
echo "entry-route smoke checks passed."
