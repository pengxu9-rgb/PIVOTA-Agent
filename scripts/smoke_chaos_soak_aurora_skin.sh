#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
LOCAL_BASE_DEFAULT="http://127.0.0.1:3100"
DURATION_HOURS="${DURATION_HOURS:-24}"
DURATION_SECONDS="${DURATION_SECONDS:-}"
BASE_RPS="${BASE_RPS:-1}"
CHAOS_RPS="${CHAOS_RPS:-3}"
SPIKE_RPS="${SPIKE_RPS:-20}"
CHAOS_WINDOW_MIN="${CHAOS_WINDOW_MIN:-10}"
SPIKE_OFFSET_MIN="${SPIKE_OFFSET_MIN:-30}"
SPIKE_DURATION_SEC="${SPIKE_DURATION_SEC:-30}"
CN_PERCENT="${CN_PERCENT:-50}"
CURL_MAX_TIME_SEC="${CURL_MAX_TIME_SEC:-20}"
SAMPLE_IMAGE_URL="${SAMPLE_IMAGE_URL:-https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg}"
OUTPUT_DIR="${OUTPUT_DIR:-tmp/chaos_soak_run_$(date +%Y%m%d_%H%M%S)}"
STARTUP_HEALTH_MAX_WAIT_SEC="${STARTUP_HEALTH_MAX_WAIT_SEC:-45}"
STARTUP_HEALTH_POLL_SEC="${STARTUP_HEALTH_POLL_SEC:-2}"
SOAK_ALLOW_DB_NOT_CONFIGURED="${SOAK_ALLOW_DB_NOT_CONFIGURED:-false}"

SCENARIO_USE_PHOTO_FALSE_WEIGHT="${SCENARIO_USE_PHOTO_FALSE_WEIGHT:-40}"
SCENARIO_PHOTO_USABLE_WEIGHT="${SCENARIO_PHOTO_USABLE_WEIGHT:-30}"
SCENARIO_PHOTO_FORCED_FAIL_WEIGHT="${SCENARIO_PHOTO_FORCED_FAIL_WEIGHT:-20}"
SCENARIO_SAFETY_BLOCK_WEIGHT="${SCENARIO_SAFETY_BLOCK_WEIGHT:-10}"

MAX_5XX_RATE_5M="${MAX_5XX_RATE_5M:-0.005}"
MAX_GUARD_FALLBACK_RATE_10M="${MAX_GUARD_FALLBACK_RATE_10M:-0.005}"
MAX_TRANSPORT_ERROR_RATE_5M="${MAX_TRANSPORT_ERROR_RATE_5M:-0.005}"
MAX_TRANSPORT_ERRORS="${MAX_TRANSPORT_ERRORS:-3}"
STOP_CHECK_EVERY_RESPONSES="${STOP_CHECK_EVERY_RESPONSES:-20}"
CURL_RETRY_ON_RESET="${CURL_RETRY_ON_RESET:-true}"
CURL_RESET_RETRY_DELAY_MS="${CURL_RESET_RETRY_DELAY_MS:-300}"

TOXIPROXY_ENABLED="${TOXIPROXY_ENABLED:-false}"
TOXIPROXY_MODES="${TOXIPROXY_MODES:-latency,timeout,reset,bandwidth}"
ONE_SHOT="${ONE_SHOT:-false}"
FORCE_SCENARIO="${FORCE_SCENARIO:-}"
FORCE_LANG="${FORCE_LANG:-}"

usage() {
  cat <<'EOF'
Usage:
  smoke_chaos_soak_aurora_skin.sh [options]

Options:
  --base <url>         Override BASE URL
  --local              Shortcut for --base http://127.0.0.1:3100
  --out <dir>          Override OUTPUT_DIR
  --hours <n>          Override DURATION_HOURS
  --seconds <n>        Override DURATION_SECONDS
  --scenario <name>    Force a single scenario: use_photo_false|photo_usable|photo_forced_fail|safety_block
  --lang <CN|EN>       Force language
  --once               Run exactly one scenario iteration then exit with summary
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE="${2:-}"
      shift 2
      ;;
    --local)
      BASE="$LOCAL_BASE_DEFAULT"
      shift
      ;;
    --out|--output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --hours)
      DURATION_HOURS="${2:-}"
      shift 2
      ;;
    --seconds)
      DURATION_SECONDS="${2:-}"
      shift 2
      ;;
    --scenario)
      FORCE_SCENARIO="${2:-}"
      shift 2
      ;;
    --lang)
      FORCE_LANG="$(printf '%s' "${2:-}" | tr '[:lower:]' '[:upper:]')"
      shift 2
      ;;
    --once)
      ONE_SHOT="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$FORCE_SCENARIO" && ! "$FORCE_SCENARIO" =~ ^(use_photo_false|photo_usable|photo_forced_fail|safety_block)$ ]]; then
  echo "invalid --scenario: $FORCE_SCENARIO" >&2
  exit 2
fi
if [[ -n "$FORCE_LANG" && ! "$FORCE_LANG" =~ ^(CN|EN)$ ]]; then
  echo "invalid --lang: $FORCE_LANG (expected CN or EN)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VALIDATOR="${ROOT_DIR}/tools/validate_envelope.js"
TOXIPROXY_SETUP="${SCRIPT_DIR}/toxiproxy_setup.sh"
TOXIPROXY_ON="${SCRIPT_DIR}/toxiproxy_chaos_on.sh"
TOXIPROXY_OFF="${SCRIPT_DIR}/toxiproxy_chaos_off.sh"

for bin in curl jq node python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing required command: $bin" >&2
    exit 2
  fi
done

if [[ ! -f "$VALIDATOR" ]]; then
  echo "missing validator: $VALIDATOR" >&2
  exit 2
fi

if [[ "$TOXIPROXY_ENABLED" == "true" ]]; then
  for file in "$TOXIPROXY_SETUP" "$TOXIPROXY_ON" "$TOXIPROXY_OFF"; do
    if [[ ! -x "$file" ]]; then
      echo "toxiproxy script is missing or not executable: $file" >&2
      exit 2
    fi
  done
fi

mkdir -p "$OUTPUT_DIR"/{responses,validation,failures}
EVENTS_FILE="$OUTPUT_DIR/events.ndjson"
FAIL_INDEX_FILE="$OUTPUT_DIR/fail_samples.ndjson"
SUMMARY_JSON="$OUTPUT_DIR/summary.json"
SUMMARY_CSV="$OUTPUT_DIR/summary.csv"
RUN_LOG="$OUTPUT_DIR/run.log"
SAMPLE_IMAGE_PATH="$OUTPUT_DIR/sample_photo.jpg"

touch "$EVENTS_FILE" "$FAIL_INDEX_FILE" "$RUN_LOG"

curl -fsSL "$SAMPLE_IMAGE_URL" -o "$SAMPLE_IMAGE_PATH"

if [[ -n "$DURATION_SECONDS" ]]; then
  TOTAL_SECONDS="$DURATION_SECONDS"
else
  TOTAL_SECONDS=$(( DURATION_HOURS * 3600 ))
fi
if ! [[ "$TOTAL_SECONDS" =~ ^[0-9]+$ ]]; then
  TOTAL_SECONDS=$(( DURATION_HOURS * 3600 ))
fi
if (( TOTAL_SECONDS <= 0 )); then
  TOTAL_SECONDS=3600
fi
CHAOS_WINDOW_SEC=$(( CHAOS_WINDOW_MIN * 60 ))
SPIKE_OFFSET_SEC=$(( SPIKE_OFFSET_MIN * 60 ))

TOTAL_RESPONSES=0
TOTAL_HTTP_5XX=0
TOTAL_TIMEOUT_DEGRADED=0
TOTAL_GUARD_FALLBACK=0
TOTAL_SCHEMA_VIOLATIONS=0
TOTAL_EMPTY_CARDS=0
TOTAL_NOTICE_WITHOUT_ACTIONS=0
TOTAL_SAFETY_WITH_RECO=0
TOTAL_LOW_MED_LEAK=0
TOTAL_VALIDATOR_ERRORS=0
TOTAL_TRANSPORT_ERRORS=0
TOTAL_REQUEST_ITERATIONS=0

SEQ=0
CHAOS_ACTIVE=0
CURRENT_LOAD_PHASE="baseline"
LAST_PRINT_TS=0

calc_rate() {
  local numerator="$1"
  local denominator="$2"
  awk -v n="$numerator" -v d="$denominator" 'BEGIN{ if (d <= 0) printf "0"; else printf "%.6f", n/d; }'
}

log_line() {
  local line="$1"
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" | tee -a "$RUN_LOG"
}

wait_for_startup_health() {
  local health_url="${BASE%/}/healthz"
  local started_ts
  started_ts="$(date +%s)"
  local deadline_ts=$(( started_ts + STARTUP_HEALTH_MAX_WAIT_SEC ))
  local last_code="000"
  local attempt=0
  while (( $(date +%s) <= deadline_ts )); do
    attempt=$(( attempt + 1 ))
    local code
    code="$(
      curl -sS -m 5 -o /dev/null -w "%{http_code}" "$health_url" || true
    )"
    code="${code:-000}"
    last_code="$code"
    if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
      log_line "startup health preflight passed url=${health_url} code=${code} attempts=${attempt}"
      return 0
    fi
    sleep "$STARTUP_HEALTH_POLL_SEC"
  done
  log_line "startup health preflight failed url=${health_url} last_code=${last_code} wait_sec=${STARTUP_HEALTH_MAX_WAIT_SEC}"
  exit 2
}

preflight_local_database_config() {
  if [[ ! "$BASE" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$) ]]; then
    return 0
  fi

  local db_health_url="${BASE%/}/healthz/db"
  local payload
  payload="$(curl -sS -m 5 "$db_health_url" || true)"
  if [[ -z "$payload" ]]; then
    log_line "local db preflight skipped url=${db_health_url} reason=empty_response"
    return 0
  fi

  local db_ready
  db_ready="$(printf "%s" "$payload" | jq -r 'if has("db_ready") then (.db_ready|tostring) else empty end' 2>/dev/null || true)"
  local reason
  reason="$(printf "%s" "$payload" | jq -r '.reason // .error // empty' 2>/dev/null || true)"

  if [[ "$db_ready" == "false" ]]; then
    local allow_raw
    allow_raw="$(printf '%s' "$SOAK_ALLOW_DB_NOT_CONFIGURED" | tr '[:upper:]' '[:lower:]')"
    local allow_mock="${AURORA_BFF_USE_MOCK:-false}"
    allow_mock="$(printf '%s' "$allow_mock" | tr '[:upper:]' '[:lower:]')"
    if [[ "$allow_raw" =~ ^(1|true|yes|y|on)$ || "$allow_mock" =~ ^(1|true|yes|y|on)$ ]]; then
      log_line "local db preflight warning url=${db_health_url} db_ready=false reason=${reason:-unknown} (continuing due mock/override)"
      return 0
    fi

    log_line "local db preflight failed url=${db_health_url} db_ready=false reason=${reason:-DATABASE_URL not configured}"
    log_line "hint: configure DATABASE_URL, or start server with AURORA_BFF_USE_MOCK=true AURORA_BFF_RETENTION_DAYS=0, or set SOAK_ALLOW_DB_NOT_CONFIGURED=true to bypass"
    exit 2
  fi

  log_line "local db preflight passed url=${db_health_url} db_ready=${db_ready:-unknown}"
}

pick_lang() {
  local r=$(( RANDOM % 100 ))
  if (( r < CN_PERCENT )); then
    printf "CN"
  else
    printf "EN"
  fi
}

pick_scenario() {
  local total=$(( SCENARIO_USE_PHOTO_FALSE_WEIGHT + SCENARIO_PHOTO_USABLE_WEIGHT + SCENARIO_PHOTO_FORCED_FAIL_WEIGHT + SCENARIO_SAFETY_BLOCK_WEIGHT ))
  if (( total <= 0 )); then
    printf "use_photo_false"
    return
  fi
  local r=$(( RANDOM % total ))
  if (( r < SCENARIO_USE_PHOTO_FALSE_WEIGHT )); then
    printf "use_photo_false"
    return
  fi
  r=$(( r - SCENARIO_USE_PHOTO_FALSE_WEIGHT ))
  if (( r < SCENARIO_PHOTO_USABLE_WEIGHT )); then
    printf "photo_usable"
    return
  fi
  r=$(( r - SCENARIO_PHOTO_USABLE_WEIGHT ))
  if (( r < SCENARIO_PHOTO_FORCED_FAIL_WEIGHT )); then
    printf "photo_forced_fail"
    return
  fi
  printf "safety_block"
}

dump_recent_failures() {
  local reason="$1"
  log_line "[STOP] ${reason}; dumping recent failed samples"
  mkdir -p "$OUTPUT_DIR/failures"
  tail -n 50 "$FAIL_INDEX_FILE" | while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local_body="$(printf "%s" "$line" | jq -r '.body_file // empty' 2>/dev/null || true)"
    local_val="$(printf "%s" "$line" | jq -r '.validation_file // empty' 2>/dev/null || true)"
    [[ -n "$local_body" && -f "$local_body" ]] && cp "$local_body" "$OUTPUT_DIR/failures/$(basename "$local_body")" || true
    [[ -n "$local_val" && -f "$local_val" ]] && cp "$local_val" "$OUTPUT_DIR/failures/$(basename "$local_val")" || true
  done
}

stop_now() {
  local reason="$1"
  dump_recent_failures "$reason"
  write_summary "stopped" "$reason"
  if [[ "$TOXIPROXY_ENABLED" == "true" && "$CHAOS_ACTIVE" == "1" ]]; then
    "$TOXIPROXY_OFF" >/dev/null 2>&1 || true
  fi
  exit 3
}

append_fail_sample() {
  local body_file="$1"
  local validation_file="$2"
  local header_file="$3"
  local reason="$4"
  jq -cn \
    --arg body_file "$body_file" \
    --arg validation_file "$validation_file" \
    --arg header_file "$header_file" \
    --arg reason "$reason" \
    --arg ts "$(date +%s)" \
    '{ts:($ts|tonumber),body_file:$body_file,validation_file:$validation_file,header_file:$header_file,reason:$reason}' >>"$FAIL_INDEX_FILE"
}

check_rolling_thresholds() {
  local check_output
  check_output="$(python3 - "$EVENTS_FILE" "$MAX_5XX_RATE_5M" "$MAX_GUARD_FALLBACK_RATE_10M" "$MAX_TRANSPORT_ERROR_RATE_5M" <<'PY'
import json
import sys

events_file = sys.argv[1]
max_5xx = float(sys.argv[2])
max_guard = float(sys.argv[3])
max_transport = float(sys.argv[4])

events = []
with open(events_file, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

if not events:
    print(json.dumps({"stop": False, "reason": ""}))
    raise SystemExit(0)

now = max(int(e.get("ts", 0) or 0) for e in events)

def rate_in_window(key, window_sec):
    rows = [e for e in events if int(e.get("ts", 0) or 0) >= now - window_sec]
    if not rows:
        return 0.0
    num = sum(1 for e in rows if int(e.get(key, 0) or 0) == 1)
    return num / len(rows)

rate_5xx = rate_in_window("http_5xx", 300)
rate_guard = rate_in_window("guard_fallback", 600)
rate_transport = rate_in_window("transport_error", 300)

if rate_5xx > max_5xx:
    print(json.dumps({"stop": True, "reason": f"5xx_rate_5m={rate_5xx:.6f} > {max_5xx:.6f}"}))
    raise SystemExit(0)
if rate_guard > max_guard:
    print(json.dumps({"stop": True, "reason": f"guard_fallback_rate_10m={rate_guard:.6f} > {max_guard:.6f}"}))
    raise SystemExit(0)
if rate_transport > max_transport:
    print(json.dumps({"stop": True, "reason": f"transport_error_rate_5m={rate_transport:.6f} > {max_transport:.6f}"}))
    raise SystemExit(0)

print(json.dumps({"stop": False, "reason": "", "rate_5xx_5m": rate_5xx, "rate_guard_10m": rate_guard, "rate_transport_5m": rate_transport}))
PY
)"
  local should_stop
  should_stop="$(printf "%s" "$check_output" | jq -r '.stop // false')"
  if [[ "$should_stop" == "true" ]]; then
    local reason
    reason="$(printf "%s" "$check_output" | jq -r '.reason // "rolling_threshold_exceeded"')"
    stop_now "$reason"
  fi
}

write_transport_placeholder() {
  local out_file="$1"
  local curl_exit_code="$2"
  local curl_error_message="$3"
  jq -cn \
    --argjson exit_code "$curl_exit_code" \
    --arg error_message "$curl_error_message" \
    '{
      transport_error: true,
      curl_exit_code: $exit_code,
      curl_error: $error_message,
      response_received: false
    }' >"$out_file"
}

extract_curl_error_message() {
  local err_file="$1"
  local fallback="$2"
  local message=""
  if [[ -s "$err_file" ]]; then
    message="$(tail -n 1 "$err_file" | tr -d '\r' | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
  fi
  if [[ -z "$message" ]]; then message="$fallback"; fi
  printf "%s" "$message"
}

record_response() {
  local body_file="$1"
  local header_file="$2"
  local code="$3"
  local scenario="$4"
  local request_phase="$5"
  local lang="$6"

  TOTAL_RESPONSES=$(( TOTAL_RESPONSES + 1 ))
  local http_5xx=0
  if [[ "$code" =~ ^[0-9]{3}$ ]] && (( code >= 500 )); then
    TOTAL_HTTP_5XX=$(( TOTAL_HTTP_5XX + 1 ))
    http_5xx=1
  fi

  local val_file="$OUTPUT_DIR/validation/resp_${SEQ}.json"
  node "$VALIDATOR" --input "$body_file" --output "$val_file" >/dev/null 2>&1 || true

  local schema_ok="false"
  local response_ok="false"
  local timeout_degraded=0
  local guard_fallback=0
  local empty_cards=0
  local notice_without_actions=0
  local low_med_leak=0
  local safety_with_reco=0
  local transport_error=0
  local response_received=1
  local violations=""
  local response_build_id=""
  local response_git_sha=""

  if [[ -s "$val_file" ]]; then
    schema_ok="$(jq -r '.schema_ok // false' "$val_file" 2>/dev/null || echo false)"
    response_ok="$(jq -r '.ok // false' "$val_file" 2>/dev/null || echo false)"
    timeout_degraded="$(jq -r 'if (.stats.has_timeout_degraded // false) then 1 else 0 end' "$val_file" 2>/dev/null || echo 0)"
    guard_fallback="$(jq -r 'if (.stats.has_reco_output_guard_fallback // false) then 1 else 0 end' "$val_file" 2>/dev/null || echo 0)"
    empty_cards="$(jq -r 'if (.stats.empty_cards_without_notice // false) then 1 else 0 end' "$val_file" 2>/dev/null || echo 0)"
    notice_without_actions="$(jq -r '.stats.notice_without_actions_count // 0' "$val_file" 2>/dev/null || echo 0)"
    low_med_leak="$(jq -r '.stats.low_medium_treatment_leak_count // 0' "$val_file" 2>/dev/null || echo 0)"
    safety_with_reco="$(jq -r '[.violations[]? | select(.code=="safety_block_with_recommendations")] | length' "$val_file" 2>/dev/null || echo 0)"
    transport_error="$(jq -r 'if (.stats.transport_error // false) then 1 else 0 end' "$val_file" 2>/dev/null || echo 0)"
    response_received="$(jq -r 'if (.stats | has("response_received")) then (if .stats.response_received then 1 else 0 end) else 1 end' "$val_file" 2>/dev/null || echo 1)"
    violations="$(jq -r '[.violations[]?.code] | join("|")' "$val_file" 2>/dev/null || true)"
  else
    TOTAL_VALIDATOR_ERRORS=$(( TOTAL_VALIDATOR_ERRORS + 1 ))
    schema_ok="false"
    response_ok="false"
    violations="validator_output_missing"
    transport_error=1
    response_received=0
  fi

  if [[ -s "$header_file" ]]; then
    response_build_id="$(
      tr -d '\r' <"$header_file" \
        | awk 'BEGIN{IGNORECASE=1} /^x-aurora-build:/ {sub(/^[^:]*:[[:space:]]*/, "", $0); print; exit}'
    )"
    response_git_sha="$(
      tr -d '\r' <"$header_file" \
        | awk 'BEGIN{IGNORECASE=1} /^x-aurora-git-sha:/ {sub(/^[^:]*:[[:space:]]*/, "", $0); print; exit}'
    )"
  fi

  if (( transport_error > 0 )); then TOTAL_TRANSPORT_ERRORS=$(( TOTAL_TRANSPORT_ERRORS + 1 )); fi
  if (( timeout_degraded > 0 )); then TOTAL_TIMEOUT_DEGRADED=$(( TOTAL_TIMEOUT_DEGRADED + 1 )); fi
  if (( guard_fallback > 0 )); then TOTAL_GUARD_FALLBACK=$(( TOTAL_GUARD_FALLBACK + 1 )); fi
  if (( transport_error == 0 )) && [[ "$schema_ok" != "true" ]]; then TOTAL_SCHEMA_VIOLATIONS=$(( TOTAL_SCHEMA_VIOLATIONS + 1 )); fi
  if (( transport_error == 0 )) && (( empty_cards > 0 )); then TOTAL_EMPTY_CARDS=$(( TOTAL_EMPTY_CARDS + 1 )); fi
  if (( notice_without_actions > 0 )); then TOTAL_NOTICE_WITHOUT_ACTIONS=$(( TOTAL_NOTICE_WITHOUT_ACTIONS + notice_without_actions )); fi
  if (( low_med_leak > 0 )); then TOTAL_LOW_MED_LEAK=$(( TOTAL_LOW_MED_LEAK + low_med_leak )); fi
  if (( safety_with_reco > 0 )); then TOTAL_SAFETY_WITH_RECO=$(( TOTAL_SAFETY_WITH_RECO + safety_with_reco )); fi

  jq -cn \
    --arg ts "$(date +%s)" \
    --arg scenario "$scenario" \
    --arg request_phase "$request_phase" \
    --arg load_phase "$CURRENT_LOAD_PHASE" \
    --arg lang "$lang" \
    --arg code "$code" \
    --arg body_file "$body_file" \
    --arg header_file "$header_file" \
    --arg val_file "$val_file" \
    --arg response_ok "$response_ok" \
    --arg schema_ok "$schema_ok" \
    --arg violations "$violations" \
    --arg response_build_id "$response_build_id" \
    --arg response_git_sha "$response_git_sha" \
    --argjson http_5xx "$http_5xx" \
    --argjson transport_error "$transport_error" \
    --argjson response_received "$response_received" \
    --argjson timeout_degraded "$timeout_degraded" \
    --argjson guard_fallback "$guard_fallback" \
    --argjson empty_cards "$empty_cards" \
    --argjson notice_without_actions "$notice_without_actions" \
    --argjson low_med_leak "$low_med_leak" \
    --argjson safety_with_reco "$safety_with_reco" \
    '{
      ts: ($ts|tonumber),
      scenario: $scenario,
      request_phase: $request_phase,
      load_phase: $load_phase,
      lang: $lang,
      code: $code,
      body_file: $body_file,
      header_file: $header_file,
      validation_file: $val_file,
      response_ok: ($response_ok=="true"),
      schema_ok: ($schema_ok=="true"),
      response_build_id: (if ($response_build_id|length)>0 then $response_build_id else null end),
      response_git_sha: (if ($response_git_sha|length)>0 then $response_git_sha else null end),
      transport_error: $transport_error,
      response_received: (if $response_received == 1 then true else false end),
      violations: (if ($violations|length)>0 then ($violations|split("|")) else [] end),
      http_5xx: $http_5xx,
      timeout_degraded: $timeout_degraded,
      guard_fallback: $guard_fallback,
      schema_violation: (if ($schema_ok=="true" or $transport_error == 1) then 0 else 1 end),
      empty_cards: $empty_cards,
      notice_without_actions: (if $notice_without_actions > 0 then 1 else 0 end),
      low_med_leak: (if $low_med_leak > 0 then 1 else 0 end),
      safety_with_reco: (if $safety_with_reco > 0 then 1 else 0 end)
    }' >>"$EVENTS_FILE"

  if (( transport_error > 0 )); then
    append_fail_sample "$body_file" "$val_file" "$header_file" "transport_error"
  elif [[ "$schema_ok" != "true" || "$response_ok" != "true" || "$http_5xx" == "1" ]]; then
    append_fail_sample "$body_file" "$val_file" "$header_file" "schema_or_invariant_or_5xx"
  fi

  if (( TOTAL_SCHEMA_VIOLATIONS > 0 )); then stop_now "schema_violation_detected"; fi
  if (( TOTAL_EMPTY_CARDS > 0 )); then stop_now "empty_cards_detected"; fi
  if (( TOTAL_NOTICE_WITHOUT_ACTIONS > 0 )); then stop_now "notice_without_actions_detected"; fi
  if (( TOTAL_LOW_MED_LEAK > 0 )); then stop_now "low_medium_treatment_leak_detected"; fi
  if (( TOTAL_TRANSPORT_ERRORS > MAX_TRANSPORT_ERRORS )); then stop_now "transport_failure_high"; fi

  if (( TOTAL_RESPONSES % STOP_CHECK_EVERY_RESPONSES == 0 )); then
    check_rolling_thresholds
  fi
}

send_json() {
  local uid="$1"
  local lang="$2"
  local scenario="$3"
  local request_phase="$4"
  local path="$5"
  local payload="$6"
  SEQ=$(( SEQ + 1 ))
  local out="$OUTPUT_DIR/responses/resp_${SEQ}_${scenario}_${request_phase}_${lang}.json"
  local hdr="$OUTPUT_DIR/responses/resp_${SEQ}_${scenario}_${request_phase}_${lang}.headers"
  local err="$OUTPUT_DIR/responses/resp_${SEQ}_${scenario}_${request_phase}_${lang}.curl.err"
  local code rc err_msg
  rc=0
  code="$(
    curl -sS -m "$CURL_MAX_TIME_SEC" -D "$hdr" -o "$out" -w "%{http_code}" \
      -X POST "${BASE}${path}" \
      -H "Content-Type: application/json" \
      -H "X-Aurora-UID: ${uid}" \
      -H "X-Lang: ${lang}" \
      -H "X-Trace-ID: trace_${uid}" \
      -H "X-Brief-ID: brief_${uid}" \
      --data "$payload" 2>"$err"
  )" || rc=$?
  if [[ "$CURL_RETRY_ON_RESET" == "true" && "$rc" -eq 35 ]]; then
    sleep "$(awk -v ms="$CURL_RESET_RETRY_DELAY_MS" 'BEGIN{printf "%.3f", ms/1000}')"
    rc=0
    code="$(
      curl -sS -m "$CURL_MAX_TIME_SEC" -D "$hdr" -o "$out" -w "%{http_code}" \
        -X POST "${BASE}${path}" \
        -H "Content-Type: application/json" \
        -H "X-Aurora-UID: ${uid}" \
        -H "X-Lang: ${lang}" \
        -H "X-Trace-ID: trace_${uid}" \
        -H "X-Brief-ID: brief_${uid}" \
        --data "$payload" 2>"$err"
    )" || rc=$?
  fi
  if (( rc != 0 )); then
    err_msg="$(extract_curl_error_message "$err" "curl_exit_${rc}")"
    write_transport_placeholder "$out" "$rc" "$err_msg"
    : >"$hdr"
    code="000"
  elif [[ ! -s "$out" ]]; then
    write_transport_placeholder "$out" "0" "empty_response_body"
    code="000"
  fi
  rm -f "$err" >/dev/null 2>&1 || true
  code="${code:-000}"
  record_response "$out" "$hdr" "$code" "$scenario" "$request_phase" "$lang"
  printf "%s" "$out"
}

send_photo_upload() {
  local uid="$1"
  local lang="$2"
  local scenario="$3"
  local request_phase="$4"
  SEQ=$(( SEQ + 1 ))
  local out="$OUTPUT_DIR/responses/resp_${SEQ}_${scenario}_${request_phase}_${lang}.json"
  local hdr="$OUTPUT_DIR/responses/resp_${SEQ}_${scenario}_${request_phase}_${lang}.headers"
  local err="$OUTPUT_DIR/responses/resp_${SEQ}_${scenario}_${request_phase}_${lang}.curl.err"
  local code rc err_msg
  rc=0
  code="$(
    curl -sS -m "$CURL_MAX_TIME_SEC" -D "$hdr" -o "$out" -w "%{http_code}" \
      -X POST "${BASE}/v1/photos/upload" \
      -H "X-Aurora-UID: ${uid}" \
      -H "X-Lang: ${lang}" \
      -F "slot_id=daylight" \
      -F "consent=true" \
      -F "photo=@${SAMPLE_IMAGE_PATH}" 2>"$err"
  )" || rc=$?
  if [[ "$CURL_RETRY_ON_RESET" == "true" && "$rc" -eq 35 ]]; then
    sleep "$(awk -v ms="$CURL_RESET_RETRY_DELAY_MS" 'BEGIN{printf "%.3f", ms/1000}')"
    rc=0
    code="$(
      curl -sS -m "$CURL_MAX_TIME_SEC" -D "$hdr" -o "$out" -w "%{http_code}" \
        -X POST "${BASE}/v1/photos/upload" \
        -H "X-Aurora-UID: ${uid}" \
        -H "X-Lang: ${lang}" \
        -F "slot_id=daylight" \
        -F "consent=true" \
        -F "photo=@${SAMPLE_IMAGE_PATH}" 2>"$err"
    )" || rc=$?
  fi
  if (( rc != 0 )); then
    err_msg="$(extract_curl_error_message "$err" "curl_exit_${rc}")"
    write_transport_placeholder "$out" "$rc" "$err_msg"
    : >"$hdr"
    code="000"
  elif [[ ! -s "$out" ]]; then
    write_transport_placeholder "$out" "0" "empty_response_body"
    code="000"
  fi
  rm -f "$err" >/dev/null 2>&1 || true
  code="${code:-000}"
  record_response "$out" "$hdr" "$code" "$scenario" "$request_phase" "$lang"
  printf "%s" "$out"
}

seed_profile() {
  local uid="$1"
  local lang="$2"
  local scenario="$3"
  send_json "$uid" "$lang" "$scenario" "profile_update" "/v1/profile/update" \
    '{"skinType":"oily","sensitivity":"low","barrierStatus":"healthy","goals":["acne","hydration"],"budgetTier":"$50","region":"US"}' >/dev/null
}

run_use_photo_false() {
  local uid="$1"
  local lang="$2"
  local scenario="use_photo_false"
  seed_profile "$uid" "$lang" "$scenario"
  send_json "$uid" "$lang" "$scenario" "analysis" "/v1/analysis/skin" \
    '{"use_photo":false,"currentRoutine":"AM cleanser + SPF; PM moisturizer + niacinamide"}' >/dev/null
  send_json "$uid" "$lang" "$scenario" "chat_reco" "/v1/chat" \
    '{"message":"recommend products","action":{"action_id":"chip.start.reco_products","kind":"chip","data":{}},"session":{"state":"idle"}}' >/dev/null
}

run_photo_usable() {
  local uid="$1"
  local lang="$2"
  local scenario="photo_usable"
  seed_profile "$uid" "$lang" "$scenario"
  local upload_file
  upload_file="$(send_photo_upload "$uid" "$lang" "$scenario" "photo_upload")"
  local photo_id
  photo_id="$(jq -r '.cards[]? | select(.type=="photo_confirm") | .payload.photo_id // empty' "$upload_file" | head -n1)"
  local qc_status
  qc_status="$(jq -r '.cards[]? | select(.type=="photo_confirm") | .payload.qc_status // "passed"' "$upload_file" | head -n1)"
  if [[ -z "$photo_id" ]]; then
    photo_id="missing_photo_after_upload"
    qc_status="failed"
  fi
  local analysis_payload
  analysis_payload="$(jq -cn --arg pid "$photo_id" --arg qc "$qc_status" \
    '{use_photo:true,currentRoutine:"AM cleanser + SPF; PM moisturizer",photos:[{photo_id:$pid,slot_id:"daylight",qc_status:$qc}]}')"
  send_json "$uid" "$lang" "$scenario" "analysis" "/v1/analysis/skin" "$analysis_payload" >/dev/null
  send_json "$uid" "$lang" "$scenario" "chat_reco" "/v1/chat" \
    '{"message":"recommend products","action":{"action_id":"chip.start.reco_products","kind":"chip","data":{}},"session":{"state":"idle"}}' >/dev/null
}

run_photo_forced_fail() {
  local uid="$1"
  local lang="$2"
  local scenario="photo_forced_fail"
  seed_profile "$uid" "$lang" "$scenario"
  send_json "$uid" "$lang" "$scenario" "analysis" "/v1/analysis/skin" \
    '{"use_photo":true,"photos":[{"photo_id":"missing_photo_forced_fail","slot_id":"daylight","qc_status":"failed"}]}' >/dev/null
  send_json "$uid" "$lang" "$scenario" "chat_reco" "/v1/chat" \
    '{"message":"recommend products","action":{"action_id":"chip.start.reco_products","kind":"chip","data":{}},"session":{"state":"idle"}}' >/dev/null
}

run_safety_block() {
  local uid="$1"
  local lang="$2"
  local scenario="safety_block"
  seed_profile "$uid" "$lang" "$scenario"
  local message='I have severe pain, oozing pus and bleeding. recommend products now.'
  if [[ "$lang" == "CN" ]]; then
    message='我脸上有剧痛、化脓和出血，请推荐产品。'
  fi
  local payload
  payload="$(jq -cn --arg m "$message" \
    '{message:$m,action:{action_id:"chip.start.reco_products",kind:"chip",data:{}},session:{state:"idle"}}')"
  send_json "$uid" "$lang" "$scenario" "chat_safety" "/v1/chat" "$payload" >/dev/null
}

run_scenario_once() {
  local scenario="$1"
  local lang="$2"
  local uid="uid_chaos_${scenario}_${lang}_$(date +%s)_$RANDOM"
  TOTAL_REQUEST_ITERATIONS=$(( TOTAL_REQUEST_ITERATIONS + 1 ))
  case "$scenario" in
    use_photo_false) run_use_photo_false "$uid" "$lang" ;;
    photo_usable) run_photo_usable "$uid" "$lang" ;;
    photo_forced_fail) run_photo_forced_fail "$uid" "$lang" ;;
    safety_block) run_safety_block "$uid" "$lang" ;;
    *) run_use_photo_false "$uid" "$lang" ;;
  esac
}

print_stats() {
  local now_ts
  now_ts="$(date +%s)"
  if (( now_ts - LAST_PRINT_TS < 30 )); then
    return
  fi
  LAST_PRINT_TS="$now_ts"
  local r_5xx r_timeout r_guard r_schema r_transport
  r_5xx="$(calc_rate "$TOTAL_HTTP_5XX" "$TOTAL_RESPONSES")"
  r_timeout="$(calc_rate "$TOTAL_TIMEOUT_DEGRADED" "$TOTAL_RESPONSES")"
  r_guard="$(calc_rate "$TOTAL_GUARD_FALLBACK" "$TOTAL_RESPONSES")"
  r_schema="$(calc_rate "$TOTAL_SCHEMA_VIOLATIONS" "$TOTAL_RESPONSES")"
  r_transport="$(calc_rate "$TOTAL_TRANSPORT_ERRORS" "$TOTAL_RESPONSES")"
  log_line "phase=${CURRENT_LOAD_PHASE} responses=${TOTAL_RESPONSES} 5xx_rate=${r_5xx} timeout_degraded_rate=${r_timeout} guard_fallback_rate=${r_guard} schema_violation_rate=${r_schema} transport_error_rate=${r_transport}"
}

write_summary() {
  local status="$1"
  local reason="$2"
  local r_5xx r_timeout r_guard r_schema r_transport
  local now_ts finished_at actual_seconds actual_hours requested_hours
  r_5xx="$(calc_rate "$TOTAL_HTTP_5XX" "$TOTAL_RESPONSES")"
  r_timeout="$(calc_rate "$TOTAL_TIMEOUT_DEGRADED" "$TOTAL_RESPONSES")"
  r_guard="$(calc_rate "$TOTAL_GUARD_FALLBACK" "$TOTAL_RESPONSES")"
  r_schema="$(calc_rate "$TOTAL_SCHEMA_VIOLATIONS" "$TOTAL_RESPONSES")"
  r_transport="$(calc_rate "$TOTAL_TRANSPORT_ERRORS" "$TOTAL_RESPONSES")"
  now_ts="$(date +%s)"
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  actual_seconds=$(( now_ts - START_TS ))
  if (( actual_seconds < 0 )); then actual_seconds=0; fi
  actual_hours="$(awk -v s="$actual_seconds" 'BEGIN{printf "%.6f", s/3600}')"
  requested_hours="$(awk -v s="$TOTAL_SECONDS" 'BEGIN{printf "%.6f", s/3600}')"

  jq -cn \
    --arg status "$status" \
    --arg reason "$reason" \
    --arg base "$BASE" \
    --arg started_at "$STARTED_AT_ISO" \
    --arg finished_at "$finished_at" \
    --argjson duration_hours "$actual_hours" \
    --argjson duration_hours_requested "$requested_hours" \
    --argjson total_seconds "$actual_seconds" \
    --argjson total_seconds_requested "$TOTAL_SECONDS" \
    --argjson base_rps "$BASE_RPS" \
    --argjson chaos_rps "$CHAOS_RPS" \
    --argjson spike_rps "$SPIKE_RPS" \
    --argjson total_request_iterations "$TOTAL_REQUEST_ITERATIONS" \
    --argjson total_responses "$TOTAL_RESPONSES" \
    --argjson total_http_5xx "$TOTAL_HTTP_5XX" \
    --argjson total_timeout_degraded "$TOTAL_TIMEOUT_DEGRADED" \
    --argjson total_guard_fallback "$TOTAL_GUARD_FALLBACK" \
    --argjson total_schema_violations "$TOTAL_SCHEMA_VIOLATIONS" \
    --argjson total_empty_cards "$TOTAL_EMPTY_CARDS" \
    --argjson total_notice_without_actions "$TOTAL_NOTICE_WITHOUT_ACTIONS" \
    --argjson total_safety_with_reco "$TOTAL_SAFETY_WITH_RECO" \
    --argjson total_low_med_leak "$TOTAL_LOW_MED_LEAK" \
    --argjson total_validator_errors "$TOTAL_VALIDATOR_ERRORS" \
    --argjson total_transport_errors "$TOTAL_TRANSPORT_ERRORS" \
    --argjson toxiproxy_enabled "$( [[ "$TOXIPROXY_ENABLED" == "true" ]] && echo true || echo false )" \
    --argjson rate_5xx "$r_5xx" \
    --argjson rate_timeout "$r_timeout" \
    --argjson rate_guard "$r_guard" \
    --argjson rate_schema "$r_schema" \
    --argjson rate_transport "$r_transport" \
    '{
      status: $status,
      stop_reason: $reason,
      base: $base,
      started_at: $started_at,
      finished_at: $finished_at,
      duration_hours: $duration_hours,
      duration_hours_requested: $duration_hours_requested,
      total_seconds: $total_seconds,
      total_seconds_requested: $total_seconds_requested,
      load_profile: {
        base_rps: $base_rps,
        chaos_rps: $chaos_rps,
        spike_rps: $spike_rps
      },
      totals: {
        request_iterations: $total_request_iterations,
        responses: $total_responses,
        http_5xx: $total_http_5xx,
        timeout_degraded: $total_timeout_degraded,
        reco_output_guard_fallback: $total_guard_fallback,
        schema_violations: $total_schema_violations,
        empty_cards: $total_empty_cards,
        notice_without_actions: $total_notice_without_actions,
        safety_with_recommendations: $total_safety_with_reco,
        low_med_treatment_leak: $total_low_med_leak,
        validator_errors: $total_validator_errors,
        transport_errors: $total_transport_errors
      },
      rates: {
        http_5xx_rate: $rate_5xx,
        timeout_degraded_rate: $rate_timeout,
        reco_output_guard_fallback_rate: $rate_guard,
        schema_violation_rate: $rate_schema,
        transport_error_rate: $rate_transport
      },
      toxiproxy_enabled: $toxiproxy_enabled
    }' >"$SUMMARY_JSON"

  {
    echo "status,stop_reason,total_request_iterations,total_responses,http_5xx,timeout_degraded,reco_output_guard_fallback,schema_violations,empty_cards,notice_without_actions,safety_with_recommendations,low_med_treatment_leak,transport_errors,http_5xx_rate,timeout_degraded_rate,reco_output_guard_fallback_rate,schema_violation_rate,transport_error_rate"
    echo "${status},${reason},${TOTAL_REQUEST_ITERATIONS},${TOTAL_RESPONSES},${TOTAL_HTTP_5XX},${TOTAL_TIMEOUT_DEGRADED},${TOTAL_GUARD_FALLBACK},${TOTAL_SCHEMA_VIOLATIONS},${TOTAL_EMPTY_CARDS},${TOTAL_NOTICE_WITHOUT_ACTIONS},${TOTAL_SAFETY_WITH_RECO},${TOTAL_LOW_MED_LEAK},${TOTAL_TRANSPORT_ERRORS},${r_5xx},${r_timeout},${r_guard},${r_schema},${r_transport}"
  } >"$SUMMARY_CSV"
}

toggle_chaos_if_needed() {
  local should_enable="$1"
  local hour_index="$2"
  if [[ "$TOXIPROXY_ENABLED" != "true" ]]; then
    return
  fi
  if [[ "$should_enable" == "1" && "$CHAOS_ACTIVE" == "0" ]]; then
    IFS=',' read -r -a mode_arr <<<"$TOXIPROXY_MODES"
    local mode_count="${#mode_arr[@]}"
    local mode="latency"
    if (( mode_count > 0 )); then
      mode="${mode_arr[$(( hour_index % mode_count ))]}"
    fi
    TOXIPROXY_CHAOS_MODE="$mode" "$TOXIPROXY_ON" >/dev/null
    CHAOS_ACTIVE=1
    log_line "chaos enabled mode=${mode}"
    return
  fi
  if [[ "$should_enable" == "0" && "$CHAOS_ACTIVE" == "1" ]]; then
    "$TOXIPROXY_OFF" >/dev/null
    CHAOS_ACTIVE=0
    log_line "chaos disabled"
  fi
}

STARTED_AT_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_TS="$(date +%s)"
END_TS=$(( START_TS + TOTAL_SECONDS ))

log_line "chaos soak start base=${BASE} duration_h=${DURATION_HOURS} base_rps=${BASE_RPS} chaos_rps=${CHAOS_RPS} spike_rps=${SPIKE_RPS} output=${OUTPUT_DIR}"
wait_for_startup_health
preflight_local_database_config
if [[ "$TOXIPROXY_ENABLED" == "true" ]]; then
  "$TOXIPROXY_SETUP" >/dev/null
  "$TOXIPROXY_OFF" >/dev/null || true
  log_line "toxiproxy enabled; hourly chaos windows active"
fi

if [[ "$ONE_SHOT" == "true" ]]; then
  CURRENT_LOAD_PHASE="single"
  scenario="${FORCE_SCENARIO:-$(pick_scenario)}"
  lang="${FORCE_LANG:-$(pick_lang)}"
  log_line "single run start scenario=${scenario} lang=${lang}"
  run_scenario_once "$scenario" "$lang"
  write_summary "completed" ""
  log_line "single run completed; summary_json=${SUMMARY_JSON} summary_csv=${SUMMARY_CSV}"
  exit 0
fi

while (( $(date +%s) < END_TS )); do
  loop_start="$(date +%s)"
  elapsed=$(( loop_start - START_TS ))
  sec_in_hour=$(( elapsed % 3600 ))
  hour_index=$(( elapsed / 3600 ))
  in_chaos=0
  if (( sec_in_hour < CHAOS_WINDOW_SEC )); then
    in_chaos=1
  fi
  in_spike=0
  if (( sec_in_hour >= SPIKE_OFFSET_SEC && sec_in_hour < SPIKE_OFFSET_SEC + SPIKE_DURATION_SEC )); then
    in_spike=1
  fi

  CURRENT_LOAD_PHASE="baseline"
  target_rps="$BASE_RPS"
  if (( in_chaos == 1 )); then
    CURRENT_LOAD_PHASE="chaos"
    target_rps="$CHAOS_RPS"
  fi
  if (( in_spike == 1 )); then
    CURRENT_LOAD_PHASE="spike"
    target_rps="$SPIKE_RPS"
  fi
  if (( target_rps < 1 )); then target_rps=1; fi

  toggle_chaos_if_needed "$in_chaos" "$hour_index"

  for ((i=0; i<target_rps; i+=1)); do
    scenario="$(pick_scenario)"
    lang="$(pick_lang)"
    run_scenario_once "$scenario" "$lang"
  done

  print_stats

  now_after="$(date +%s)"
  sleep_for=$(( 1 - (now_after - loop_start) ))
  if (( sleep_for > 0 )); then
    sleep "$sleep_for"
  fi
done

if [[ "$TOXIPROXY_ENABLED" == "true" && "$CHAOS_ACTIVE" == "1" ]]; then
  "$TOXIPROXY_OFF" >/dev/null || true
  CHAOS_ACTIVE=0
fi

write_summary "completed" ""

log_line "chaos soak completed; summary_json=${SUMMARY_JSON} summary_csv=${SUMMARY_CSV}"
exit 0
