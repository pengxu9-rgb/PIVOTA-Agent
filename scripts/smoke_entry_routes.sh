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
  "$PY_BIN" -c '
import json,sys
j=json.load(open(sys.argv[1]))
cards=[(c.get("type") or c.get("card_type")) for c in (j.get("cards") or [])]
assistant=((j.get("assistant_message") or {}).get("content") or "")
if not assistant:
    for card in (j.get("cards") or []):
        if (card.get("type") or card.get("card_type"))=="text_response":
            sections=card.get("sections") or []
            if sections:
                assistant=(sections[0].get("text_en") or sections[0].get("text_zh") or "")
                break
first=str(assistant).splitlines()[:1]
print("cards=",cards)
print("first=",first)
' "$file"
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
cards = [(c.get("type") or c.get("card_type")) for c in (j.get("cards") or [])]
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

assert_cards_with_retry() {
  local key="$1"
  local path="$2"
  local data="$3"
  local mode="$4"
  local expected_csv="$5"
  local retries="${6:-3}"
  local sleep_sec="${7:-2}"
  local case_var="CASE_${key}"
  local case_file=""

  local n=1
  while true; do
    capture_case "$key" "$path" "$data"
    case_file="${!case_var}"
    extract_summary "$case_file"
    assert_no_banned_first_line "$case_file" "$LANG_UPPER"
    if "$PY_BIN" -c '
import json,sys
path, mode, expected = sys.argv[1], sys.argv[2], [s for s in sys.argv[3].split(",") if s]
j = json.load(open(path))
cards = [(c.get("type") or c.get("card_type")) for c in (j.get("cards") or [])]
if mode == "exact":
    ok = cards == expected
elif mode == "contains_all":
    ok = all(e in cards for e in expected)
elif mode == "contains_any":
    ok = any(e in cards for e in expected)
elif mode == "contains_none":
    ok = all(e not in cards for e in expected)
else:
    raise SystemExit(2)
raise SystemExit(0 if ok else 1)
' "$case_file" "$mode" "$expected_csv"; then
      return 0
    fi
    if [[ "$n" -ge "$retries" ]]; then
      assert_cards "$case_file" "$mode" "$expected_csv"
      return 0
    fi
    echo "[warn] case=${key} missing expected cards (attempt ${n}/${retries}), retrying..." >&2
    n=$((n + 1))
    sleep "$sleep_sec"
  done
}

assert_reco_stage() {
  local file="$1"
  "$PY_BIN" -c '
import json,sys
path = sys.argv[1]
j = json.load(open(path))
cards = j.get("cards") or []
types = [(c.get("type") or c.get("card_type")) for c in cards]
if "recommendations" in types:
    raise SystemExit(0)
if "product_verdict" in types:
    raise SystemExit(0)
if "skin_status" in types or "routine" in types:
    raise SystemExit(0)
if "aurora_ingredient_report" in types or "ingredient_hub" in types:
    raise SystemExit(0)
if "nudge" in types:
    # Passive advisory path can return nudge-only in current chatcards contract.
    raise SystemExit(0)
if "text_response" in types:
    sections = []
    for card in cards:
        if (card.get("type") or card.get("card_type")) == "text_response":
            sections = card.get("sections") or []
            break
    if sections:
        text = (sections[0].get("text_en") or sections[0].get("text_zh") or "").strip()
        if text:
            raise SystemExit(0)
if "confidence_notice" not in types:
    raise SystemExit(
        f"reco stage expected recommendations/product_verdict/skin_status/routine/"
        f"aurora_ingredient_report/ingredient_hub/nudge/text_response/confidence_notice, got={types}"
    )
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

assert_fit_stage() {
  local file="$1"
  "$PY_BIN" -c '
import json,sys
path = sys.argv[1]
j = json.load(open(path))
cards = [(c.get("type") or c.get("card_type")) for c in (j.get("cards") or [])]
if "aurora_structured" in cards and "product_analysis" in cards:
    raise SystemExit(0)
if "product_verdict" in cards:
    raise SystemExit(0)
if "compatibility" in cards:
    raise SystemExit(0)
raise SystemExit(f"fit-check expected aurora_structured+product_analysis or product_verdict/compatibility, got={cards}")
' "$file"
}

assert_env_stage() {
  local file="$1"
  "$PY_BIN" -c '
import json,sys
path = sys.argv[1]
j = json.load(open(path))
cards = [(c.get("type") or c.get("card_type")) for c in (j.get("cards") or [])]
if "env_stress" in cards:
    raise SystemExit(0)
if "travel" in cards or "skin_status" in cards:
    raise SystemExit(0)
if "text_response" in cards:
    for card in (j.get("cards") or []):
        if (card.get("type") or card.get("card_type")) == "text_response":
            sections = card.get("sections") or []
            if sections:
                text = (sections[0].get("text_en") or sections[0].get("text_zh") or "").strip()
                if text:
                    raise SystemExit(0)
# Runtime can temporarily degrade to generic error when env provider is unavailable.
if "error" in cards:
    if "recommendations" in cards:
        raise SystemExit(f"env fallback error must not include recommendations, got={cards}")
    raise SystemExit(0)
raise SystemExit(f"env stage expected env_stress/travel/skin_status/text_response (or error fallback), got={cards}")
' "$file"
}

assert_conflict_stage() {
  local file="$1"
  "$PY_BIN" -c '
import json,sys
path = sys.argv[1]
j = json.load(open(path))
cards = [(c.get("type") or c.get("card_type")) for c in (j.get("cards") or [])]
if "routine_simulation" in cards and "conflict_heatmap" in cards:
    raise SystemExit(0)
if "compatibility" in cards:
    raise SystemExit(0)
if "text_response" in cards:
    for card in (j.get("cards") or []):
        if (card.get("type") or card.get("card_type")) == "text_response":
            sections = card.get("sections") or []
            if sections:
                text = (sections[0].get("text_en") or sections[0].get("text_zh") or "").strip().lower()
                if text and (
                    "alternate" in text
                    or "avoid" in text
                    or "separate" in text
                    or "错开" in text
                    or "不要同晚" in text
                    or "交替" in text
                    or "轮换" in text
                    or "隔天" in text
                    or "另一个晚上" in text
                    or "斑贴测试" in text
                ):
                    raise SystemExit(0)
if "confidence_notice" in cards:
    chip_ids = [(c.get("chip_id") or "") for c in (j.get("suggested_chips") or [])]
    if not any("pregnancy" in cid.lower() for cid in chip_ids):
        raise SystemExit(f"conflict safety gate missing pregnancy chips; chips={chip_ids}")
    events = [e.get("event_name") for e in (j.get("events") or [])]
    if "safety_gate_require_info" not in events:
        raise SystemExit(f"conflict safety gate missing safety event; events={events}")
    raise SystemExit(0)
raise SystemExit(f"conflict stage expected routine_simulation+conflict_heatmap, compatibility, mitigated text_response, or safety gate, got={cards}")
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
assert_cards "$CASE_gate" "contains_any" "diagnosis_gate,recommendations,product_verdict,confidence_notice,aurora_ingredient_report,ingredient_hub,nudge"

say "2) profile patch"
capture_case "profile" "/v1/profile/update" '{"skinType":"oily","sensitivity":"low","barrierStatus":"healthy","goals":["brightening","acne"],"region":"CN","budgetTier":"¥500"}'
extract_summary "$CASE_profile"
assert_no_banned_first_line "$CASE_profile" "$LANG_UPPER"
assert_cards "$CASE_profile" "contains_all" "profile"

say "3) fit-check"
assert_cards_with_retry \
  "fit" \
  "/v1/chat" \
  "{\"message\":\"${MSG_FIT}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}" \
  "contains_any" \
  "aurora_structured,product_analysis,product_verdict,compatibility" \
  "${FIT_CHECK_RETRIES:-3}" \
  "${FIT_CHECK_RETRY_SLEEP_SEC:-2}"
assert_fit_stage "$CASE_fit"

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
assert_env_stage "$CASE_env"

say "7) conflict"
capture_case "conflict" "/v1/chat" "{\"message\":\"${MSG_CONFLICT}\",\"language\":\"${AURORA_LANG}\",\"session\":{\"state\":\"idle\"}}"
extract_summary "$CASE_conflict"
assert_no_banned_first_line "$CASE_conflict" "$LANG_UPPER"
assert_conflict_stage "$CASE_conflict"

say "8) stale budget chip (strict guard)"
capture_case "stale" "/v1/chat" "{\"action\":{\"action_id\":\"chip.clarify.budget.y500\",\"kind\":\"chip\",\"data\":{\"clarification_id\":\"budget\",\"reply_text\":\"¥500\"}},\"message\":\"¥500\",\"session\":{\"state\":\"idle\"},\"client_state\":\"RECO_GATE\",\"language\":\"${AURORA_LANG}\"}"
extract_summary "$CASE_stale"
assert_no_banned_first_line "$CASE_stale" "$LANG_UPPER"
assert_cards "$CASE_stale" "contains_none" "recommendations,diagnosis_gate"
assert_cards "$CASE_stale" "contains_any" "profile,nudge"

say "PASS"
echo "entry-route smoke checks passed."
