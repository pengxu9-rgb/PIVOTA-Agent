#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
LANG_CODE="${LANG_CODE:-en}"
TIMEOUT_MS="${TIMEOUT_MS:-2200}"
UPSTREAM_RETRIES="${UPSTREAM_RETRIES:-1}"
OUT_DIR="${OUT_DIR:-reports}"
PROBE_INCLUDE_STABLE_HINTS="${PROBE_INCLUDE_STABLE_HINTS:-true}"
CURL_RETRY_MAX="${CURL_RETRY_MAX:-6}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
CURL_CONNECT_TIMEOUT_SEC="${CURL_CONNECT_TIMEOUT_SEC:-5}"
CURL_MAX_TIME_SEC="${CURL_MAX_TIME_SEC:-45}"

mkdir -p "$OUT_DIR"
ts="$(date -u +%Y%m%d_%H%M%S)"
report_md="${OUT_DIR}/product_grounding_probe_${ts}.md"
report_csv="${OUT_DIR}/product_grounding_probe_${ts}.csv"

if [[ $# -gt 0 ]]; then
  QUERIES=("$@")
else
  QUERIES=(
    "The Ordinary Niacinamide 10% + Zinc 1%"
    "CeraVe Hydrating Cleanser"
    "La Roche-Posay Cicaplast Baume B5"
    "Bioderma Sensibio H2O Micellar"
    "Winona Soothing Repair Serum"
    "IPSA Time Reset Aqua"
    "SK-II Facial Treatment Essence"
    "Avene Cicalfate+ Restorative Protective Cream"
  )
fi

total=0
resolved_count=0

{
  echo "query,hinted,resolved,reason,reason_code,confidence,latency_ms,matched_product_id,matched_merchant_id,top_candidate_id,top_candidate_title,sources"
} > "$report_csv"

{
  echo "# Product Grounding Probe"
  echo
  echo "- generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- base: \`$BASE\`"
  echo "- lang: \`$LANG_CODE\`"
  echo "- timeout_ms: \`$TIMEOUT_MS\`"
  echo "- upstream_retries: \`$UPSTREAM_RETRIES\`"
  echo "- include_stable_hints: \`$PROBE_INCLUDE_STABLE_HINTS\`"
  echo "- curl_retry_max: \`$CURL_RETRY_MAX\`"
  echo "- curl_retry_delay_sec: \`$CURL_RETRY_DELAY_SEC\`"
  echo "- curl_connect_timeout_sec: \`$CURL_CONNECT_TIMEOUT_SEC\`"
  echo "- curl_max_time_sec: \`$CURL_MAX_TIME_SEC\`"
  echo
  echo "| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |"
  echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
} > "$report_md"

for query in "${QUERIES[@]}"; do
  total=$((total + 1))
  payload="$(python3 - "$query" "$LANG_CODE" "$TIMEOUT_MS" "$UPSTREAM_RETRIES" "$PROBE_INCLUDE_STABLE_HINTS" <<'PY'
import json, sys
q = sys.argv[1]
lang = sys.argv[2]
timeout_ms = int(sys.argv[3])
upstream_retries = int(sys.argv[4])
include_hints_raw = str(sys.argv[5]).strip().lower()
include_hints = include_hints_raw not in ("0", "false", "no", "off")

# Probe-only stable hints for known internal products.
# These are deterministic keys intended to verify "known internal item should not fallback" behavior.
stable_hints = {
    "the ordinary niacinamide 10% + zinc 1%": {
        "product_ref": {
            "product_id": "9886499864904",
            "merchant_id": "merch_efbc46b4619cfbdf",
        },
        "aliases": ["The Ordinary Niacinamide 10% + Zinc 1%"],
        "brand": "The Ordinary",
        "title": "The Ordinary Niacinamide 10% + Zinc 1%",
    },
    "winona soothing repair serum": {
        "product_ref": {
            "product_id": "9886500749640",
            "merchant_id": "merch_efbc46b4619cfbdf",
        },
        "aliases": ["Winona Soothing Repair Serum"],
        "brand": "Winona",
        "title": "Winona Soothing Repair Serum",
    },
}

obj = {
    "query": q,
    "lang": lang,
    "caller": "aurora_chatbox",
    "options": {
        "search_all_merchants": True,
        "timeout_ms": timeout_ms,
        "upstream_retries": upstream_retries,
    },
}
if include_hints:
    key = q.strip().lower()
    hint = stable_hints.get(key)
    if hint:
        obj["hints"] = hint
print(json.dumps(obj, ensure_ascii=False))
PY
)"

  resp=""
  if ! resp="$(curl -sS \
    --retry "$CURL_RETRY_MAX" \
    --retry-all-errors \
    --retry-delay "$CURL_RETRY_DELAY_SEC" \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_SEC" \
    --max-time "$CURL_MAX_TIME_SEC" \
    -X POST "${BASE}/agent/v1/products/resolve" \
    -H "Content-Type: application/json" \
    --data "$payload" 2>/tmp/product_grounding_probe_curl_err.$$)"; then
    curl_err="$(tr '\n' ';' </tmp/product_grounding_probe_curl_err.$$ | sed 's/;/ /g')"
    reason="curl_failed"
    reason_code="network_error"
    confidence=""
    latency=""
    matched_product=""
    matched_merchant=""
    top_pid=""
    top_title=""
    source_summary="curl:fail(${curl_err})"

    query_csv="${query//\"/\"\"}"
    top_title_csv="${top_title//\"/\"\"}"
    source_csv="${source_summary//\"/\"\"}"
    printf '"%s",%s,%s,"%s","%s",%s,%s,"%s","%s","%s","%s","%s"\n' \
      "$query_csv" "false" "false" "$reason" "$reason_code" "${confidence:-}" "${latency:-}" \
      "$matched_product" "$matched_merchant" "$top_pid" "$top_title_csv" "$source_csv" >> "$report_csv"

    query_md="${query//|/\\|}"
    top_md="${top_title//|/\\|}"
    sources_md="${source_summary//|/\\|}"
    echo "| ${query_md} | false | false | ${reason} | ${reason_code} | ${confidence:-n/a} | ${latency:-n/a} | ${matched_product:-n/a} | ${matched_merchant:-n/a} | ${top_pid:-n/a} ${top_md:+(${top_md})} | ${sources_md:-n/a} |" >> "$report_md"
    continue
  fi

  parsed="$(python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    j = json.loads(raw)
except Exception:
    print("false\tfalse\tinvalid_json\t\t0\t0\t\t\t\t\t")
    raise SystemExit(0)

resolved = bool(j.get("resolved"))
reason = str(j.get("reason") or "")
reason_code = str(j.get("reason_code") or ((j.get("metadata") or {}).get("resolve_reason_code") if isinstance(j.get("metadata"), dict) else "") or "")
confidence = j.get("confidence")
confidence_str = "" if confidence is None else str(confidence)
latency = (((j.get("metadata") or {}).get("latency_ms")) if isinstance(j.get("metadata"), dict) else None)
latency_str = "" if latency is None else str(latency)
product_ref = j.get("product_ref") if isinstance(j.get("product_ref"), dict) else {}
matched_product = str(product_ref.get("product_id") or "")
matched_merchant = str(product_ref.get("merchant_id") or "")
cands = j.get("candidates") if isinstance(j.get("candidates"), list) else []
top = cands[0] if cands else {}
top_ref = top.get("product_ref") if isinstance(top, dict) and isinstance(top.get("product_ref"), dict) else {}
top_pid = str(top_ref.get("product_id") or "")
top_title = str((top.get("title") if isinstance(top, dict) else "") or "")
sources = (j.get("metadata") or {}).get("sources") if isinstance(j.get("metadata"), dict) else []
source_summary_parts = []
hinted = False
if isinstance(sources, list):
    for s in sources[:6]:
        if not isinstance(s, dict):
            continue
        src = str(s.get("source") or "")
        if src == "hints_product_ref":
            hinted = True
        ok = "ok" if s.get("ok") else "fail"
        rsn = str(s.get("reason") or "")
        part = f"{src}:{ok}"
        if rsn:
            part += f"({rsn})"
        source_summary_parts.append(part)
source_summary = ";".join(source_summary_parts)
def nz(v):
    return "__NULL__" if v in ("", None) else str(v)
print(
    f"{str(hinted).lower()}\t{str(resolved).lower()}\t{nz(reason)}\t{nz(reason_code)}\t{nz(confidence_str)}\t{nz(latency_str)}\t"
    f"{nz(matched_product)}\t{nz(matched_merchant)}\t{nz(top_pid)}\t{nz(top_title)}\t{nz(source_summary)}"
)
' <<< "$resp")"

  IFS=$'\t' read -r hinted resolved reason reason_code confidence latency matched_product matched_merchant top_pid top_title source_summary <<< "$parsed"
  hinted="${hinted/__NULL__/}"
  reason="${reason/__NULL__/}"
  reason_code="${reason_code/__NULL__/}"
  confidence="${confidence/__NULL__/}"
  latency="${latency/__NULL__/}"
  matched_product="${matched_product/__NULL__/}"
  matched_merchant="${matched_merchant/__NULL__/}"
  top_pid="${top_pid/__NULL__/}"
  top_title="${top_title/__NULL__/}"
  source_summary="${source_summary/__NULL__/}"
  if [[ "$resolved" == "true" ]]; then
    resolved_count=$((resolved_count + 1))
  fi

  query_csv="${query//\"/\"\"}"
  top_title_csv="${top_title//\"/\"\"}"
  source_csv="${source_summary//\"/\"\"}"
  printf '"%s",%s,%s,"%s","%s",%s,%s,"%s","%s","%s","%s","%s"\n' \
    "$query_csv" "$hinted" "$resolved" "$reason" "$reason_code" "${confidence:-}" "${latency:-}" \
    "$matched_product" "$matched_merchant" "$top_pid" "$top_title_csv" "$source_csv" >> "$report_csv"

  query_md="${query//|/\\|}"
  top_md="${top_title//|/\\|}"
  sources_md="${source_summary//|/\\|}"
  echo "| ${query_md} | ${hinted:-n/a} | ${resolved} | ${reason:-n/a} | ${reason_code:-n/a} | ${confidence:-n/a} | ${latency:-n/a} | ${matched_product:-n/a} | ${matched_merchant:-n/a} | ${top_pid:-n/a} ${top_md:+(${top_md})} | ${sources_md:-n/a} |" >> "$report_md"
done

rate="0"
if [[ "$total" -gt 0 ]]; then
  rate="$(python3 - "$resolved_count" "$total" <<'PY'
import sys
r = int(sys.argv[1]); t = int(sys.argv[2])
print(f"{(r/t):.3f}")
PY
)"
fi

{
  echo
  echo "## Summary"
  echo
  echo "- total_queries: ${total}"
  echo "- resolved_queries: ${resolved_count}"
  echo "- resolve_rate: ${rate}"
  echo
  echo "Artifacts:"
  echo "- \`${report_md}\`"
  echo "- \`${report_csv}\`"
} >> "$report_md"

echo "$report_md"
echo "$report_csv"
