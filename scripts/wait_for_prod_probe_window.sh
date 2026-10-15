#!/usr/bin/env bash
# Hold a production probe until the database's quiet window is over.
#
# WHY. The push-to-main prod probes (the search stability matrix, the skincare and discovery
# smokes) each cost the backend real canonical searches on the 2-vCPU pivota-pg primary. The
# daily relgraph-sync cron already holds that primary at 0.5-0.6 CPU between about 10:30 and
# 11:20 UTC. A gateway merge landing in that window used to stack its probes on top of the cron.
# The probes measure whatever production is serving, and production does not change on merge,
# so a probe that waits measures the same thing a little later.
#
# WHAT. If "now" (UTC) falls inside PROD_PROBE_QUIET_WINDOW_UTC ("HH:MM-HH:MM", default
# 10:30-11:20; a window may cross midnight), sleep until it ends and write a note saying so to
# the step summary. Outside the window, return at once. An empty window disables the wait.
#
# Test seams: PROD_PROBE_NOW_EPOCH pins "now"; PROD_PROBE_WAIT_DRY_RUN=1 prints the wait
# without sleeping.
set -euo pipefail

WINDOW="${PROD_PROBE_QUIET_WINDOW_UTC-10:30-11:20}"
NOW_EPOCH="${PROD_PROBE_NOW_EPOCH:-$(date -u +%s)}"
DRY_RUN="${PROD_PROBE_WAIT_DRY_RUN:-0}"

note() {
  echo "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "$1" >> "${GITHUB_STEP_SUMMARY}"
  fi
}

if [[ -z "${WINDOW}" ]]; then
  echo "prod probe quiet window: disabled"
  exit 0
fi

if [[ ! "${WINDOW}" =~ ^([0-9]{2}):([0-9]{2})-([0-9]{2}):([0-9]{2})$ ]]; then
  echo "PROD_PROBE_QUIET_WINDOW_UTC must look like HH:MM-HH:MM, got '${WINDOW}'" >&2
  exit 2
fi
start_s=$(( (10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}) * 60 ))
end_s=$(( (10#${BASH_REMATCH[3]} * 60 + 10#${BASH_REMATCH[4]}) * 60 ))
now_s=$(( NOW_EPOCH % 86400 ))

inside=0
if (( start_s < end_s )); then
  (( now_s >= start_s && now_s < end_s )) && inside=1
elif (( start_s > end_s )); then
  (( now_s >= start_s || now_s < end_s )) && inside=1
fi

if (( inside == 0 )); then
  echo "prod probe quiet window ${WINDOW} UTC: outside, probing now"
  exit 0
fi

wait_s=$(( (end_s - now_s + 86400) % 86400 ))
note "Prod probe deferred: $(date -u -d "@${NOW_EPOCH}" +%H:%M:%S 2>/dev/null || date -u -r "${NOW_EPOCH}" +%H:%M:%S) UTC is inside the pivota-pg quiet window ${WINDOW} UTC (relgraph-sync). Waiting ${wait_s}s before calling production."
echo "wait_seconds=${wait_s}"
if [[ "${DRY_RUN}" != "1" ]]; then
  sleep "${wait_s}"
fi
