#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://pivota-agent-production.up.railway.app}"
INTERVAL_SEC="${INTERVAL_SEC:-60}"
DURATION_MIN="${DURATION_MIN:-30}"
SAMPLES="${SAMPLES:-$(( (DURATION_MIN * 60 + INTERVAL_SEC - 1) / INTERVAL_SEC ))}"

TARGET_COMBINED_MAX="${TARGET_COMBINED_MAX:-0.20}"       # (UPSTREAM_5XX + TIMEOUT) / verify_fail_total
TARGET_IMAGE_FETCH_MAX="${TARGET_IMAGE_FETCH_MAX:-0.08}" # IMAGE_FETCH_FAILED / verify_fail_total
TARGET_UNKNOWN_MAX="${TARGET_UNKNOWN_MAX:-0}"            # UNKNOWN delta absolute count
STRICT="${STRICT:-0}"                                     # 1 => non-zero exit when threshold fails

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 2
fi

if [[ "$SAMPLES" -lt 1 ]]; then
  SAMPLES=1
fi

snapshot_from_metrics() {
  node -e '
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const out = {
    verify_calls: { attempt: 0, ok: 0, fail: 0, guard: 0 },
    verify_budget_guard_total: 0,
    verify_fail: { total: 0, reasons: {} },
  };
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const value = Number(line.trim().split(/\s+/).pop() || 0);
    if (!Number.isFinite(value)) continue;
    if (line.startsWith("verify_calls_total{")) {
      const status = (line.match(/status="([^"]+)"/) || [])[1];
      if (status && Object.prototype.hasOwnProperty.call(out.verify_calls, status)) {
        out.verify_calls[status] += value;
      }
      continue;
    }
    if (line.startsWith("verify_budget_guard_total")) {
      out.verify_budget_guard_total += value;
      continue;
    }
    if (line.startsWith("verify_fail_total{")) {
      const reason = (line.match(/reason="([^"]+)"/) || [])[1] || "UNKNOWN";
      out.verify_fail.total += value;
      out.verify_fail.reasons[reason] = (out.verify_fail.reasons[reason] || 0) + value;
    }
  }
  process.stdout.write(JSON.stringify(out));
});
'
}

fetch_snapshot() {
  curl -fsS "$BASE/metrics" | snapshot_from_metrics
}

delta_json() {
  local baseline_json="$1"
  local current_json="$2"
  node -e '
const baseline = JSON.parse(process.argv[1]);
const current = JSON.parse(process.argv[2]);
const deltaMonotonic = (b, c) => {
  const bn = Number.isFinite(Number(b)) ? Number(b) : 0;
  const cn = Number.isFinite(Number(c)) ? Number(c) : 0;
  return cn >= bn ? cn - bn : cn;
};
const reasons = new Set([
  ...Object.keys((baseline.verify_fail && baseline.verify_fail.reasons) || {}),
  ...Object.keys((current.verify_fail && current.verify_fail.reasons) || {}),
  "UPSTREAM_5XX",
  "TIMEOUT",
  "IMAGE_FETCH_FAILED",
  "SCHEMA_INVALID",
  "QUOTA",
  "NETWORK_ERROR",
  "UPSTREAM_4XX",
  "RATE_LIMIT",
  "UNKNOWN",
]);
const out = {
  verify_calls: {
    attempt: deltaMonotonic(baseline.verify_calls?.attempt, current.verify_calls?.attempt),
    ok: deltaMonotonic(baseline.verify_calls?.ok, current.verify_calls?.ok),
    fail: deltaMonotonic(baseline.verify_calls?.fail, current.verify_calls?.fail),
    guard: deltaMonotonic(baseline.verify_calls?.guard, current.verify_calls?.guard),
  },
  verify_budget_guard_total: deltaMonotonic(
    baseline.verify_budget_guard_total,
    current.verify_budget_guard_total,
  ),
  verify_fail: { total: deltaMonotonic(baseline.verify_fail?.total, current.verify_fail?.total), reasons: {} },
};
for (const reason of reasons) {
  out.verify_fail.reasons[reason] = deltaMonotonic(
    baseline.verify_fail?.reasons?.[reason],
    current.verify_fail?.reasons?.[reason],
  );
}
process.stdout.write(JSON.stringify(out));
' "$baseline_json" "$current_json"
}

print_tick() {
  local idx="$1"
  local total="$2"
  local delta="$3"
  node -e '
const idx = Number(process.argv[1]);
const total = Number(process.argv[2]);
const delta = JSON.parse(process.argv[3]);
const iso = new Date().toISOString();
const reason = (key) => Number(delta.verify_fail?.reasons?.[key] || 0);
const line = [
  `[${idx}/${total}]`,
  iso,
  `attemptsΔ=${Number(delta.verify_calls?.attempt || 0)}`,
  `failsΔ=${Number(delta.verify_fail?.total || 0)}`,
  `guardsΔ=${Number(delta.verify_budget_guard_total || 0)}`,
  `UPSTREAM_5XXΔ=${reason("UPSTREAM_5XX")}`,
  `TIMEOUTΔ=${reason("TIMEOUT")}`,
  `IMAGE_FETCH_FAILEDΔ=${reason("IMAGE_FETCH_FAILED")}`,
  `UNKNOWNΔ=${reason("UNKNOWN")}`,
].join(" ");
console.log(line);
' "$idx" "$total" "$delta"
}

final_summary() {
  local delta="$1"
  node -e '
const delta = JSON.parse(process.argv[1]);
const targetCombined = Number(process.env.TARGET_COMBINED_MAX || 0.2);
const targetImage = Number(process.env.TARGET_IMAGE_FETCH_MAX || 0.08);
const targetUnknown = Number(process.env.TARGET_UNKNOWN_MAX || 0);
const strict = String(process.env.STRICT || "0") === "1";
const reason = (key) => Number(delta.verify_fail?.reasons?.[key] || 0);
const failTotal = Number(delta.verify_fail?.total || 0);
const up5xx = reason("UPSTREAM_5XX");
const timeout = reason("TIMEOUT");
const imageFetch = reason("IMAGE_FETCH_FAILED");
const unknown = reason("UNKNOWN");
const combined = failTotal > 0 ? (up5xx + timeout) / failTotal : 0;
const imageRate = failTotal > 0 ? imageFetch / failTotal : 0;
const passCombined = combined <= targetCombined;
const passImage = imageRate <= targetImage;
const passUnknown = unknown <= targetUnknown;
console.log("");
console.log("== Window Summary ==");
console.log(`attempts_delta=${Number(delta.verify_calls?.attempt || 0)}`);
console.log(`verify_fail_total_delta=${failTotal}`);
console.log(`verify_budget_guard_total_delta=${Number(delta.verify_budget_guard_total || 0)}`);
console.log(`UPSTREAM_5XX_delta=${up5xx}`);
console.log(`TIMEOUT_delta=${timeout}`);
console.log(`IMAGE_FETCH_FAILED_delta=${imageFetch}`);
console.log(`UNKNOWN_delta=${unknown}`);
console.log(`combined_upstream5xx_timeout_rate=${combined.toFixed(3)} target<=${targetCombined}`);
console.log(`image_fetch_failed_rate=${imageRate.toFixed(3)} target<=${targetImage}`);
console.log(`unknown_delta_target=${targetUnknown}`);
console.log(`threshold_pass_combined=${passCombined}`);
console.log(`threshold_pass_image=${passImage}`);
console.log(`threshold_pass_unknown=${passUnknown}`);
if (strict && (!passCombined || !passImage || !passUnknown)) process.exit(3);
' "$delta"
}

echo "== observe verify fail ratios =="
echo "BASE=$BASE"
echo "INTERVAL_SEC=$INTERVAL_SEC SAMPLES=$SAMPLES (target duration ~ $((INTERVAL_SEC * SAMPLES))s)"
echo "TARGET_COMBINED_MAX=$TARGET_COMBINED_MAX TARGET_IMAGE_FETCH_MAX=$TARGET_IMAGE_FETCH_MAX TARGET_UNKNOWN_MAX=$TARGET_UNKNOWN_MAX STRICT=$STRICT"

baseline_snapshot="$(fetch_snapshot)"
echo "baseline captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

latest_delta='{"verify_calls":{"attempt":0,"ok":0,"fail":0,"guard":0},"verify_budget_guard_total":0,"verify_fail":{"total":0,"reasons":{}}}'
for ((i = 1; i <= SAMPLES; i += 1)); do
  sleep "$INTERVAL_SEC"
  current_snapshot="$(fetch_snapshot)"
  latest_delta="$(delta_json "$baseline_snapshot" "$current_snapshot")"
  print_tick "$i" "$SAMPLES" "$latest_delta"
done

final_summary "$latest_delta"
