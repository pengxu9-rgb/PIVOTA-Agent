#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
AURORA_LANG="${AURORA_LANG:-EN}"
AURORA_UID="${AURORA_UID:-travel_plans_smoke_$(date +%s)}"
TRACE_ID="${TRACE_ID:-trace_travel_plans_$(date +%s)}"
BRIEF_ID="${BRIEF_ID:-brief_travel_plans_$(date +%s)}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[FAIL] jq is required for smoke_travel_plans_runtime.sh" >&2
  exit 2
fi

HEADERS_COMMON=(
  -H "X-Aurora-UID: ${AURORA_UID}"
  -H "X-Lang: ${AURORA_LANG}"
  -H "X-Trace-ID: ${TRACE_ID}"
  -H "X-Brief-ID: ${BRIEF_ID}"
)

say() {
  printf "\n== %s ==\n" "$1"
}

fail() {
  printf "\n[FAIL] %s\n" "$1" >&2
  exit 1
}

pass() {
  printf "[PASS] %s\n" "$1"
}

status_from_headers() {
  awk 'NR==1 {print $2}' "$1"
}

content_type_from_headers() {
  awk -F': *' 'tolower($1)=="content-type" {print tolower($2)}' "$1" | head -n 1 | tr -d '\r'
}

request_capture() {
  local method="$1"
  local path="$2"
  local out_body="$3"
  local out_headers="$4"
  shift 4

  curl -sS -X "$method" -D "$out_headers" -o "$out_body" "$@" "${BASE%/}${path}"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

say "route-level sentinel: GET /v1/travel-plans without UID must be business error JSON (not route 404/html)"
NO_UID_BODY="$TMP_DIR/no_uid_body.json"
NO_UID_HEADERS="$TMP_DIR/no_uid_headers.txt"
request_capture "GET" "/v1/travel-plans" "$NO_UID_BODY" "$NO_UID_HEADERS"

no_uid_status="$(status_from_headers "$NO_UID_HEADERS")"
no_uid_ct="$(content_type_from_headers "$NO_UID_HEADERS")"
[[ "$no_uid_status" != "404" ]] || fail "GET /v1/travel-plans returned route 404"
[[ "$no_uid_ct" == *"application/json"* ]] || fail "GET /v1/travel-plans returned non-json content-type: ${no_uid_ct:-missing}"
no_uid_error="$(jq -r '.error // empty' "$NO_UID_BODY" 2>/dev/null || true)"
if [[ "$no_uid_error" != "MISSING_AURORA_UID" && "$no_uid_error" != "BAD_REQUEST" ]]; then
  fail "GET /v1/travel-plans without UID returned unexpected error=${no_uid_error:-missing}"
fi
pass "GET /v1/travel-plans without UID is route-hit business error"

say "GET /v1/travel-plans with UID"
LIST_BODY="$TMP_DIR/list_body.json"
LIST_HEADERS="$TMP_DIR/list_headers.txt"
request_capture "GET" "/v1/travel-plans" "$LIST_BODY" "$LIST_HEADERS" "${HEADERS_COMMON[@]}"

list_status="$(status_from_headers "$LIST_HEADERS")"
list_ct="$(content_type_from_headers "$LIST_HEADERS")"
[[ "$list_status" != "404" ]] || fail "GET /v1/travel-plans with UID returned route 404"
[[ "$list_ct" == *"application/json"* ]] || fail "GET /v1/travel-plans with UID returned non-json content-type: ${list_ct:-missing}"
jq -e '.plans | type == "array"' "$LIST_BODY" >/dev/null || fail "GET /v1/travel-plans response missing plans array"
pass "GET /v1/travel-plans with UID returns JSON + plans[]"

say "PATCH /v1/travel-plans/:trip_id sentinel (fake id must be PLAN_NOT_FOUND json)"
PATCH_BODY="$TMP_DIR/patch_body.json"
PATCH_HEADERS="$TMP_DIR/patch_headers.txt"
request_capture "PATCH" "/v1/travel-plans/trip_fake_for_probe" "$PATCH_BODY" "$PATCH_HEADERS" \
  -H 'Content-Type: application/json' \
  "${HEADERS_COMMON[@]}" \
  --data '{"destination":"ProbeCity"}'

patch_status="$(status_from_headers "$PATCH_HEADERS")"
patch_ct="$(content_type_from_headers "$PATCH_HEADERS")"
[[ "$patch_status" == "404" ]] || fail "PATCH fake trip expected 404 PLAN_NOT_FOUND, got ${patch_status:-missing}"
[[ "$patch_ct" == *"application/json"* ]] || fail "PATCH fake trip returned non-json content-type: ${patch_ct:-missing}"
patch_error="$(jq -r '.error // empty' "$PATCH_BODY" 2>/dev/null || true)"
[[ "$patch_error" == "PLAN_NOT_FOUND" ]] || fail "PATCH fake trip expected PLAN_NOT_FOUND, got ${patch_error:-missing}"
pass "PATCH travel plan fake id route is mounted"

say "POST /v1/travel-plans/:trip_id/archive sentinel (fake id must be PLAN_NOT_FOUND json)"
ARCHIVE_BODY="$TMP_DIR/archive_body.json"
ARCHIVE_HEADERS="$TMP_DIR/archive_headers.txt"
request_capture "POST" "/v1/travel-plans/trip_fake_for_probe/archive" "$ARCHIVE_BODY" "$ARCHIVE_HEADERS" \
  -H 'Content-Type: application/json' \
  "${HEADERS_COMMON[@]}" \
  --data '{}'

archive_status="$(status_from_headers "$ARCHIVE_HEADERS")"
archive_ct="$(content_type_from_headers "$ARCHIVE_HEADERS")"
[[ "$archive_status" == "404" ]] || fail "POST archive fake trip expected 404 PLAN_NOT_FOUND, got ${archive_status:-missing}"
[[ "$archive_ct" == *"application/json"* ]] || fail "POST archive fake trip returned non-json content-type: ${archive_ct:-missing}"
archive_error="$(jq -r '.error // empty' "$ARCHIVE_BODY" 2>/dev/null || true)"
[[ "$archive_error" == "PLAN_NOT_FOUND" ]] || fail "POST archive fake trip expected PLAN_NOT_FOUND, got ${archive_error:-missing}"
pass "Archive travel plan fake id route is mounted"

say "chat route sentinel: POST /v1/chat must be non-404 JSON"
CHAT_BODY="$TMP_DIR/chat_body.json"
CHAT_HEADERS="$TMP_DIR/chat_headers.txt"
request_capture "POST" "/v1/chat" "$CHAT_BODY" "$CHAT_HEADERS" \
  -H 'Content-Type: application/json' \
  "${HEADERS_COMMON[@]}" \
  --data '{"message":"hello"}'

chat_status="$(status_from_headers "$CHAT_HEADERS")"
chat_ct="$(content_type_from_headers "$CHAT_HEADERS")"
[[ "$chat_status" != "404" ]] || fail "POST /v1/chat returned route 404"
[[ "$chat_ct" == *"application/json"* ]] || fail "POST /v1/chat returned non-json content-type: ${chat_ct:-missing}"
pass "POST /v1/chat non-404 JSON"

printf "\nPASS: smoke_travel_plans_runtime OK\n"
