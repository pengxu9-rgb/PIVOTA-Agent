#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-staging.up.railway.app}"
AUTH_TOKEN="${AUTH_TOKEN:-${AURORA_AUTH_TOKEN:-}}"
AURORA_LANG="${AURORA_LANG:-EN}"
AURORA_UID="${AURORA_UID:-uid_auth_refresh_$(date +%s)}"
TRACE_ID="${TRACE_ID:-trace_auth_refresh_$(date +%s)}"
BRIEF_ID="${BRIEF_ID:-brief_auth_refresh_$(date +%s)}"
BOOTSTRAP_PATH="${BOOTSTRAP_PATH:-/v1/session/bootstrap}"
JSON_CHAT_PATH="${JSON_CHAT_PATH:-/v2/chat}"
STREAM_CHAT_PATH="${STREAM_CHAT_PATH:-/v1/chat/stream}"
JSON_MESSAGE="${JSON_MESSAGE:-Tell me about niacinamide. Keep it short.}"
STREAM_MESSAGE="${STREAM_MESSAGE:-how do I start a simple skincare routine?}"
WAIT_AFTER_REFRESH_SEC="${WAIT_AFTER_REFRESH_SEC:-0}"
EXPECT_INVALID_AFTER_SLEEP="${EXPECT_INVALID_AFTER_SLEEP:-false}"
TARGET_DEPLOYMENT_ID="${TARGET_DEPLOYMENT_ID:-}"
TARGET_COMMIT="${TARGET_COMMIT:-}"
CURL_RETRY_MAX="${CURL_RETRY_MAX:-20}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
CURL_RETRY_MAX_TIME_SEC="${CURL_RETRY_MAX_TIME_SEC:-180}"

if [[ -z "$AUTH_TOKEN" ]]; then
  printf "[FAIL] AUTH_TOKEN or AURORA_AUTH_TOKEN is required.\n" >&2
  printf "Hint: read pivota_aurora_auth_session_v1 from localStorage and export its token.\n" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf "[FAIL] jq is required.\n" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

COMMON_HEADERS=(
  -H "Authorization: Bearer ${AUTH_TOKEN}"
  -H "X-Aurora-UID: ${AURORA_UID}"
  -H "X-Lang: ${AURORA_LANG}"
  -H "X-Trace-ID: ${TRACE_ID}"
  -H "X-Brief-ID: ${BRIEF_ID}"
)

say() {
  printf "\n== %s ==\n" "$1"
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

jq_assert_file() {
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

extract_auth_state() {
  jq -r '.meta.auth.state // empty' "$1"
}

extract_auth_email() {
  jq -r '.meta.auth.user.email // empty' "$1"
}

extract_auth_expires() {
  jq -r '.meta.auth.expires_at // empty' "$1"
}

assert_iso_not_earlier() {
  local label="$1"
  local current="$2"
  local previous="$3"
  if [[ -z "$current" || -z "$previous" ]]; then
    printf "\n[FAIL] %s\n  missing expires_at\n" "$label" >&2
    exit 1
  fi
  if ! node -e "const current = Date.parse(process.argv[1]); const previous = Date.parse(process.argv[2]); process.exit(Number.isFinite(current) && Number.isFinite(previous) && current >= previous ? 0 : 1);" "$current" "$previous"; then
    printf "\n[FAIL] %s\n  current=%s\n  previous=%s\n" "$label" "$current" "$previous" >&2
    exit 1
  fi
  printf "[PASS] %s\n" "$label"
}

extract_sse_result_json() {
  local source_file="$1"
  awk '
    BEGIN { RS=""; FS="\n"; ORS="" }
    {
      event="";
      data="";
      for (i = 1; i <= NF; i++) {
        line=$i;
        sub(/\r$/, "", line);
        if (line ~ /^event: /) {
          event=substr(line, 8);
        } else if (line ~ /^data: /) {
          payload=substr(line, 7);
          data=(data == "" ? payload : data "\n" payload);
        }
      }
      if (event == "result") {
        print data;
        exit;
      }
    }
  ' "$source_file"
}

EXPECT_INVALID_AFTER_SLEEP_NORMALIZED="$(normalize_bool "${EXPECT_INVALID_AFTER_SLEEP}")"

printf "BASE=%s\nAURORA_LANG=%s\nAURORA_UID=%s\nTRACE_ID=%s\nBRIEF_ID=%s\nBOOTSTRAP_PATH=%s\nJSON_CHAT_PATH=%s\nSTREAM_CHAT_PATH=%s\nWAIT_AFTER_REFRESH_SEC=%s\nEXPECT_INVALID_AFTER_SLEEP=%s\nTARGET_DEPLOYMENT_ID=%s\nTARGET_COMMIT=%s\n" \
  "$BASE" "$AURORA_LANG" "$AURORA_UID" "$TRACE_ID" "$BRIEF_ID" "$BOOTSTRAP_PATH" "$JSON_CHAT_PATH" "$STREAM_CHAT_PATH" "$WAIT_AFTER_REFRESH_SEC" "$EXPECT_INVALID_AFTER_SLEEP_NORMALIZED" "$TARGET_DEPLOYMENT_ID" "$TARGET_COMMIT"

say "deployed identity"
curl_do -sSI "${BASE}${BOOTSTRAP_PATH}" | tr -d '\r' | egrep '^(HTTP/|x-service-deployment-id:|x-service-commit:|x-aurora-build:)' || true

if [[ -n "$TARGET_DEPLOYMENT_ID" ]]; then
  deployed_id="$(
    curl_do -sSI "${BASE}${BOOTSTRAP_PATH}" \
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
    curl_do -sSI "${BASE}${BOOTSTRAP_PATH}" \
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

say "bootstrap authenticated"
curl_do -fsS "${BASE}${BOOTSTRAP_PATH}" "${COMMON_HEADERS[@]}" > "${TMP_DIR}/bootstrap_1.json"
jq_assert_file "bootstrap returns meta.auth" '.meta.auth | type=="object"' "${TMP_DIR}/bootstrap_1.json"
jq_assert_file "bootstrap auth state is authenticated" '.meta.auth.state == "authenticated"' "${TMP_DIR}/bootstrap_1.json"
jq_assert_file "bootstrap auth email is non-empty" '(.meta.auth.user.email | type=="string" and length > 0)' "${TMP_DIR}/bootstrap_1.json"
jq_assert_file "bootstrap auth expires_at is non-empty" '(.meta.auth.expires_at | type=="string" and length > 0)' "${TMP_DIR}/bootstrap_1.json"

BOOTSTRAP_EMAIL="$(extract_auth_email "${TMP_DIR}/bootstrap_1.json")"
BOOTSTRAP_EXPIRES="$(extract_auth_expires "${TMP_DIR}/bootstrap_1.json")"
printf "bootstrap_email=%s\nbootstrap_expires_at=%s\n" "$BOOTSTRAP_EMAIL" "$BOOTSTRAP_EXPIRES"

say "json chat refresh"
curl_do -fsS -X POST "${BASE}${JSON_CHAT_PATH}" \
  -H 'Content-Type: application/json' \
  "${COMMON_HEADERS[@]}" \
  --data "{\"message\":\"${JSON_MESSAGE}\",\"context\":{\"locale\":\"en\",\"profile\":{}}}" \
  > "${TMP_DIR}/chat_json.json"
jq_assert_file "json chat auth state is authenticated" '.meta.auth.state == "authenticated"' "${TMP_DIR}/chat_json.json"
jq_assert_file "json chat returns cards array" '.cards | type=="array"' "${TMP_DIR}/chat_json.json"

CHAT_JSON_EXPIRES="$(extract_auth_expires "${TMP_DIR}/chat_json.json")"
assert_iso_not_earlier "json chat refreshed expires_at" "$CHAT_JSON_EXPIRES" "$BOOTSTRAP_EXPIRES"
printf "chat_json_expires_at=%s\n" "$CHAT_JSON_EXPIRES"

say "stream chat refresh"
curl_do -fsS -X POST "${BASE}${STREAM_CHAT_PATH}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  "${COMMON_HEADERS[@]}" \
  --data "{\"message\":\"${STREAM_MESSAGE}\",\"context\":{\"locale\":\"en\",\"profile\":{}}}" \
  > "${TMP_DIR}/chat_stream.txt"

STREAM_RESULT_JSON="$(extract_sse_result_json "${TMP_DIR}/chat_stream.txt")"
if [[ -z "$STREAM_RESULT_JSON" ]]; then
  printf "\n[FAIL] stream result event missing\n  file=%s\n" "${TMP_DIR}/chat_stream.txt" >&2
  exit 1
fi
printf "%s\n" "$STREAM_RESULT_JSON" > "${TMP_DIR}/chat_stream_result.json"
jq_assert_file "stream result auth state is authenticated" '.meta.auth.state == "authenticated"' "${TMP_DIR}/chat_stream_result.json"
jq_assert_file "stream result keeps meta envelope" '.meta | type=="object"' "${TMP_DIR}/chat_stream_result.json"

STREAM_EXPIRES="$(extract_auth_expires "${TMP_DIR}/chat_stream_result.json")"
assert_iso_not_earlier "stream chat refreshed expires_at" "$STREAM_EXPIRES" "$CHAT_JSON_EXPIRES"
printf "stream_expires_at=%s\n" "$STREAM_EXPIRES"

if [[ "$WAIT_AFTER_REFRESH_SEC" =~ ^[0-9]+$ ]] && [[ "$WAIT_AFTER_REFRESH_SEC" -gt 0 ]]; then
  say "post-wait auth check"
  printf "sleeping %ss\n" "$WAIT_AFTER_REFRESH_SEC"
  sleep "$WAIT_AFTER_REFRESH_SEC"
  curl_do -fsS "${BASE}${BOOTSTRAP_PATH}" "${COMMON_HEADERS[@]}" > "${TMP_DIR}/bootstrap_after_wait.json"
  POST_WAIT_STATE="$(extract_auth_state "${TMP_DIR}/bootstrap_after_wait.json")"

  if [[ "$EXPECT_INVALID_AFTER_SLEEP_NORMALIZED" == "true" ]]; then
    jq_assert_file "post-wait auth state is invalid" '.meta.auth.state == "invalid"' "${TMP_DIR}/bootstrap_after_wait.json"
    jq_assert_file "post-wait auth expires_at is null" '.meta.auth.expires_at == null' "${TMP_DIR}/bootstrap_after_wait.json"
  else
    jq_assert_file "post-wait auth state remains authenticated" '.meta.auth.state == "authenticated"' "${TMP_DIR}/bootstrap_after_wait.json"
    POST_WAIT_EXPIRES="$(extract_auth_expires "${TMP_DIR}/bootstrap_after_wait.json")"
    assert_iso_not_earlier "post-wait bootstrap keeps refreshed expires_at" "$POST_WAIT_EXPIRES" "$STREAM_EXPIRES"
  fi

  printf "post_wait_state=%s\n" "$POST_WAIT_STATE"
fi

say "summary"
jq -n \
  --arg base "$BASE" \
  --arg uid "$AURORA_UID" \
  --arg email "$BOOTSTRAP_EMAIL" \
  --arg bootstrap_expires "$BOOTSTRAP_EXPIRES" \
  --arg chat_json_expires "$CHAT_JSON_EXPIRES" \
  --arg stream_expires "$STREAM_EXPIRES" \
  '{
    base: $base,
    aurora_uid: $uid,
    auth_email: $email,
    bootstrap_expires_at: $bootstrap_expires,
    json_chat_expires_at: $chat_json_expires,
    stream_expires_at: $stream_expires
  }'

printf "\nPASS: aurora auth session refresh smoke OK\n"
