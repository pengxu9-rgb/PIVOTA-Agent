#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_UID="${AURORA_UID:-travel_probe_$(date +%s)}"
TRACE_ID="${TRACE_ID:-travel_probe_trace_$(date +%s)}"
BRIEF_ID="${BRIEF_ID:-travel_probe_brief_$(date +%s)}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[FAIL] jq is required" >&2
  exit 2
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

request() {
  local method="$1"
  local path="$2"
  local body_file="$3"
  local headers_file="$4"
  shift 4
  curl -sS -X "$method" -D "$headers_file" -o "$body_file" "$@" "${BASE%/}${path}"
}

status() {
  awk 'NR==1{print $2}' "$1"
}

content_type() {
  awk -F': *' 'tolower($1)=="content-type" {print tolower($2)}' "$1" | head -n 1 | tr -d '\r'
}

echo "BASE=$BASE"

# Probe 1: route sentinel for travel plans
h1="$tmp_dir/h1.txt"
b1="$tmp_dir/b1.json"
request GET /v1/travel-plans "$b1" "$h1"
s1="$(status "$h1")"
ct1="$(content_type "$h1")"
[[ "$s1" != "404" ]] || { echo "[FAIL] /v1/travel-plans route missing (404)"; exit 1; }
[[ "$ct1" == *"application/json"* ]] || { echo "[FAIL] /v1/travel-plans non-json response: $ct1"; exit 1; }

# Probe 2: chat should still be healthy
h2="$tmp_dir/h2.txt"
b2="$tmp_dir/b2.json"
request POST /v1/chat "$b2" "$h2" \
  -H 'Content-Type: application/json' \
  -H "X-Aurora-UID: ${AURORA_UID}" \
  -H "X-Trace-ID: ${TRACE_ID}" \
  -H "X-Brief-ID: ${BRIEF_ID}" \
  -H 'X-Lang: EN' \
  --data '{"message":"hello"}'
s2="$(status "$h2")"
ct2="$(content_type "$h2")"
[[ "$s2" != "404" ]] || { echo "[FAIL] /v1/chat route missing (404)"; exit 1; }
[[ "$ct2" == *"application/json"* ]] || { echo "[FAIL] /v1/chat non-json response: $ct2"; exit 1; }

echo "PASS: travel_plans_synthetic_probe"
