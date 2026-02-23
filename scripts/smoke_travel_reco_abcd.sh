#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://pivota-agent-production.up.railway.app}"
LANG_HDR="${LANG_HDR:-EN}"

echo "[INFO] BASE_URL=${BASE_URL}"
echo "[INFO] LANG_HDR=${LANG_HDR}"

ts_now() { date +%s; }

post_json() {
  local url="$1"
  local uid="$2"
  local trace="$3"
  local brief="$4"
  local data_file="$5"
  curl -sS -X POST "${BASE_URL}${url}" \
    -H "Content-Type: application/json" \
    -H "X-Aurora-UID:${uid}" \
    -H "X-Trace-ID:${trace}" \
    -H "X-Brief-ID:${brief}" \
    -H "X-Lang:${LANG_HDR}" \
    --data @"${data_file}"
}

assert_jq() {
  local jq_expr="$1"
  local json_file="$2"
  if jq -e "${jq_expr}" "${json_file}" >/dev/null; then
    return 0
  fi
  return 1
}

run_scenario_a_nearest_upcoming() {
  local uid="smoke_trip_a_$(ts_now)"
  local trace="trace_trip_a_$(ts_now)"
  local brief="brief_trip_a_$(ts_now)"

  cat >/tmp/smoke_trip_a_profile.json <<'JSON'
{
  "skinType": "oily",
  "sensitivity": "low",
  "barrierStatus": "healthy",
  "goals": ["acne"],
  "region": "San Francisco, CA",
  "travel_plans": [
    {
      "trip_id": "trip_near",
      "destination": "Seattle",
      "start_date": "2026-02-24",
      "end_date": "2026-02-26"
    },
    {
      "trip_id": "trip_far",
      "destination": "Tokyo",
      "start_date": "2026-03-05",
      "end_date": "2026-03-08"
    }
  ]
}
JSON

  post_json "/v1/profile/update" "${uid}" "${trace}" "${brief}" /tmp/smoke_trip_a_profile.json >/tmp/smoke_trip_a_profile_resp.json

  cat >/tmp/smoke_trip_a_chat.json <<'JSON'
{
  "message": "Please recommend products for me.",
  "action": { "action_id": "chip_get_recos", "kind": "chip", "data": { "trigger_source": "chip" } },
  "session": { "state": "idle" },
  "language": "EN"
}
JSON
  post_json "/v1/chat" "${uid}" "${trace}" "${brief}" /tmp/smoke_trip_a_chat.json >/tmp/smoke_trip_a_chat_resp.json

  if assert_jq '
    ((.cards // []) | any(.type == "diagnosis_gate" or .type == "gate_notice")) | not
    and (
      ((.cards // []) | map(select(.type=="recommendations")) | .[0].payload.recommendation_meta.active_trip_id // "") == "trip_near"
    )
  ' /tmp/smoke_trip_a_chat_resp.json; then
    echo "[PASS] 场景A 最近未来行程命中 trip_near"
  else
    echo "[FAIL] 场景A（见 /tmp/smoke_trip_a_chat_resp.json）"
  fi
}

run_scenario_b_in_range_priority() {
  local uid="smoke_trip_b_$(ts_now)"
  local trace="trace_trip_b_$(ts_now)"
  local brief="brief_trip_b_$(ts_now)"

  cat >/tmp/smoke_trip_b_profile.json <<'JSON'
{
  "skinType": "oily",
  "sensitivity": "low",
  "barrierStatus": "healthy",
  "goals": ["acne"],
  "region": "San Francisco, CA",
  "travel_plans": [
    {
      "trip_id": "trip_in_range",
      "destination": "Los Angeles",
      "start_date": "2026-02-22",
      "end_date": "2026-02-24"
    },
    {
      "trip_id": "trip_upcoming",
      "destination": "Tokyo",
      "start_date": "2026-02-28",
      "end_date": "2026-03-02"
    }
  ]
}
JSON

  post_json "/v1/profile/update" "${uid}" "${trace}" "${brief}" /tmp/smoke_trip_b_profile.json >/tmp/smoke_trip_b_profile_resp.json

  cat >/tmp/smoke_trip_b_chat.json <<'JSON'
{
  "message": "Recommend products for this week.",
  "action": { "action_id": "chip_get_recos", "kind": "chip", "data": { "trigger_source": "chip" } },
  "session": { "state": "idle" },
  "language": "EN"
}
JSON
  post_json "/v1/chat" "${uid}" "${trace}" "${brief}" /tmp/smoke_trip_b_chat.json >/tmp/smoke_trip_b_chat_resp.json

  if assert_jq '
    ((.cards // []) | any(.type == "diagnosis_gate" or .type == "gate_notice")) | not
    and (
      ((.cards // []) | map(select(.type=="recommendations")) | .[0].payload.recommendation_meta.active_trip_id // "") == "trip_in_range"
    )
  ' /tmp/smoke_trip_b_chat_resp.json; then
    echo "[PASS] 场景B 命中区间行程优先 trip_in_range"
  else
    echo "[FAIL] 场景B（见 /tmp/smoke_trip_b_chat_resp.json）"
  fi
}

run_scenario_c_expired_fallback_region() {
  local uid="smoke_trip_c_$(ts_now)"
  local trace="trace_trip_c_$(ts_now)"
  local brief="brief_trip_c_$(ts_now)"

  cat >/tmp/smoke_trip_c_profile.json <<'JSON'
{
  "skinType": "oily",
  "sensitivity": "low",
  "barrierStatus": "healthy",
  "goals": ["pores"],
  "region": "San Francisco, CA",
  "travel_plans": [
    {
      "trip_id": "trip_expired",
      "destination": "Tokyo",
      "start_date": "2026-02-01",
      "end_date": "2026-02-03"
    }
  ]
}
JSON

  post_json "/v1/profile/update" "${uid}" "${trace}" "${brief}" /tmp/smoke_trip_c_profile.json >/tmp/smoke_trip_c_profile_resp.json

  cat >/tmp/smoke_trip_c_chat.json <<'JSON'
{
  "message": "Please adjust my skincare based on weather this week.",
  "session": { "state": "idle" },
  "language": "EN"
}
JSON
  post_json "/v1/chat" "${uid}" "${trace}" "${brief}" /tmp/smoke_trip_c_chat.json >/tmp/smoke_trip_c_chat_resp.json

  if assert_jq '
    ((.cards // []) | any(.type == "env_stress"))
    and (((.cards // []) | any(.type == "diagnosis_gate" or .type == "gate_notice")) | not)
  ' /tmp/smoke_trip_c_chat_resp.json; then
    echo "[PASS] 场景C 过期行程已回落常驻地 weather/env_stress"
  else
    echo "[FAIL] 场景C（见 /tmp/smoke_trip_c_chat_resp.json）"
  fi
}

run_scenario_d_core_profile_gate() {
  local uid="smoke_trip_d_$(ts_now)"
  local trace="trace_trip_d_$(ts_now)"
  local brief="brief_trip_d_$(ts_now)"

  cat >/tmp/smoke_trip_d_chat.json <<'JSON'
{
  "message": "Please recommend products for me.",
  "action": { "action_id": "chip_get_recos", "kind": "chip", "data": { "trigger_source": "chip" } },
  "session": { "state": "idle" },
  "language": "EN"
}
JSON
  post_json "/v1/chat" "${uid}" "${trace}" "${brief}" /tmp/smoke_trip_d_chat.json >/tmp/smoke_trip_d_chat_resp.json

  if assert_jq '
    ((.cards // []) | any(.type=="diagnosis_gate" or .type=="gate_notice"))
    and (((.cards // []) | any(.type=="recommendations")) | not)
  ' /tmp/smoke_trip_d_chat_resp.json; then
    echo "[PASS] 场景D core profile gate 无回归"
  else
    echo "[FAIL] 场景D（见 /tmp/smoke_trip_d_chat_resp.json）"
  fi
}

run_scenario_a_nearest_upcoming
run_scenario_b_in_range_priority
run_scenario_c_expired_fallback_region
run_scenario_d_core_profile_gate

echo "[DONE] smoke_travel_reco_abcd completed."
