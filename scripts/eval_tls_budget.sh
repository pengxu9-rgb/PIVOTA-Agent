#!/usr/bin/env bash
set -euo pipefail

# Evaluate health endpoint latency budgets for TLS optimization.
# Usage:
#   BASE_URL=https://pivota-agent-production.up.railway.app ./scripts/eval_tls_budget.sh
# Optional:
#   ROUNDS=10 OUTPUT_JSON=/tmp/tls_eval.json ./scripts/eval_tls_budget.sh
#   BASELINE_JSON=/tmp/tls_eval_before.json MAX_REGRESSION_PCT=5 ./scripts/eval_tls_budget.sh

BASE_URL="${BASE_URL:-https://pivota-agent-production.up.railway.app}"
ENDPOINT_A="${ENDPOINT_A:-/healthz/lite}"
ENDPOINT_B="${ENDPOINT_B:-/healthz}"
ROUNDS="${ROUNDS:-8}"
CONNECT_TIMEOUT_SEC="${CONNECT_TIMEOUT_SEC:-10}"
MAX_TIME_SEC="${MAX_TIME_SEC:-30}"
OUTPUT_JSON="${OUTPUT_JSON:-/tmp/tls_budget_eval_$(date +%Y%m%d_%H%M%S).json}"
BASELINE_JSON="${BASELINE_JSON:-}"

MAX_HTTP_FAILURES="${MAX_HTTP_FAILURES:-0}"
MAX_REGRESSION_PCT="${MAX_REGRESSION_PCT:-5}"

BUDGET_FIRST_TLS_P90_SEC="${BUDGET_FIRST_TLS_P90_SEC:-2.5}"
BUDGET_FIRST_TTFB_P90_SEC="${BUDGET_FIRST_TTFB_P90_SEC:-2.5}"
BUDGET_FIRST_TOTAL_P90_SEC="${BUDGET_FIRST_TOTAL_P90_SEC:-3.0}"
BUDGET_SECOND_TTFB_P90_SEC="${BUDGET_SECOND_TTFB_P90_SEC:-1.5}"
BUDGET_SECOND_TOTAL_P90_SEC="${BUDGET_SECOND_TOTAL_P90_SEC:-1.5}"

if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]] || [ "$ROUNDS" -le 0 ]; then
  echo "ROUNDS must be a positive integer" >&2
  exit 1
fi

if ! [[ "$MAX_HTTP_FAILURES" =~ ^[0-9]+$ ]]; then
  echo "MAX_HTTP_FAILURES must be a non-negative integer" >&2
  exit 1
fi

TMP_DATA="$(mktemp)"
trap 'rm -f "$TMP_DATA"' EXIT

echo "== TLS budget evaluation =="
echo "base_url=${BASE_URL}"
echo "rounds=${ROUNDS}"
echo "first=${ENDPOINT_A} second=${ENDPOINT_B}"
echo

http_failures=0
for ((i = 1; i <= ROUNDS; i++)); do
  probe_out="$(curl -sS --http1.1 \
    --connect-timeout "${CONNECT_TIMEOUT_SEC}" \
    --max-time "${MAX_TIME_SEC}" \
    -o /dev/null \
    -w "first %{http_code} %{time_appconnect} %{time_starttransfer} %{time_total}\n" \
    "${BASE_URL}${ENDPOINT_A}" \
    --next \
    -o /dev/null \
    -w "second %{http_code} %{time_appconnect} %{time_starttransfer} %{time_total}\n" \
    "${BASE_URL}${ENDPOINT_B}")"

  first_line="$(echo "$probe_out" | sed -n '1p')"
  second_line="$(echo "$probe_out" | sed -n '2p')"

  first_code="$(echo "$first_line" | awk '{print $2}')"
  first_tls="$(echo "$first_line" | awk '{print $3}')"
  first_ttfb="$(echo "$first_line" | awk '{print $4}')"
  first_total="$(echo "$first_line" | awk '{print $5}')"

  second_code="$(echo "$second_line" | awk '{print $2}')"
  second_tls="$(echo "$second_line" | awk '{print $3}')"
  second_ttfb="$(echo "$second_line" | awk '{print $4}')"
  second_total="$(echo "$second_line" | awk '{print $5}')"

  if [ "${first_code}" != "200" ] || [ "${second_code}" != "200" ]; then
    http_failures=$((http_failures + 1))
  fi

  printf "%s %s %s %s %s %s %s %s %s\n" \
    "$i" "$first_code" "$first_tls" "$first_ttfb" "$first_total" \
    "$second_code" "$second_tls" "$second_ttfb" "$second_total" >>"$TMP_DATA"

  echo "round=${i} first(code=${first_code} tls=${first_tls}s ttfb=${first_ttfb}s total=${first_total}s) second(code=${second_code} ttfb=${second_ttfb}s total=${second_total}s)"
done

export BASE_URL ENDPOINT_A ENDPOINT_B BASELINE_JSON MAX_REGRESSION_PCT http_failures
export MAX_HTTP_FAILURES
export BUDGET_FIRST_TLS_P90_SEC BUDGET_FIRST_TTFB_P90_SEC BUDGET_FIRST_TOTAL_P90_SEC
export BUDGET_SECOND_TTFB_P90_SEC BUDGET_SECOND_TOTAL_P90_SEC

python3 - "$TMP_DATA" "$OUTPUT_JSON" <<'PY'
import json
import math
import os
import sys
from datetime import datetime, timezone


def percentile(values, q):
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    idx = (len(s) - 1) * q
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return float(s[lo])
    return float(s[lo] + (s[hi] - s[lo]) * (idx - lo))


def stats(values):
    if not values:
        return None
    return {
        "count": len(values),
        "avg": round(sum(values) / len(values), 4),
        "p50": round(percentile(values, 0.50), 4),
        "p90": round(percentile(values, 0.90), 4),
        "p95": round(percentile(values, 0.95), 4),
        "max": round(max(values), 4),
    }


def read_rows(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) != 9:
                continue
            rows.append(
                {
                    "round": int(parts[0]),
                    "first_code": int(parts[1]),
                    "first_tls": float(parts[2]),
                    "first_ttfb": float(parts[3]),
                    "first_total": float(parts[4]),
                    "second_code": int(parts[5]),
                    "second_tls": float(parts[6]),
                    "second_ttfb": float(parts[7]),
                    "second_total": float(parts[8]),
                }
            )
    return rows


rows = read_rows(sys.argv[1])
output_path = sys.argv[2]

metrics = {
    "first_tls": stats([r["first_tls"] for r in rows]),
    "first_ttfb": stats([r["first_ttfb"] for r in rows]),
    "first_total": stats([r["first_total"] for r in rows]),
    "second_ttfb": stats([r["second_ttfb"] for r in rows]),
    "second_total": stats([r["second_total"] for r in rows]),
}

budgets = {
    "first_tls_p90": float(os.environ["BUDGET_FIRST_TLS_P90_SEC"]),
    "first_ttfb_p90": float(os.environ["BUDGET_FIRST_TTFB_P90_SEC"]),
    "first_total_p90": float(os.environ["BUDGET_FIRST_TOTAL_P90_SEC"]),
    "second_ttfb_p90": float(os.environ["BUDGET_SECOND_TTFB_P90_SEC"]),
    "second_total_p90": float(os.environ["BUDGET_SECOND_TOTAL_P90_SEC"]),
    "max_http_failures": int(os.environ["MAX_HTTP_FAILURES"]),
}

http_failures = int(os.environ.get("http_failures", "0"))
failures = []

if http_failures > budgets["max_http_failures"]:
    failures.append(
        f"http_failures={http_failures} exceeds max_http_failures={budgets['max_http_failures']}"
    )

checks = [
    ("first_tls", "first_tls_p90"),
    ("first_ttfb", "first_ttfb_p90"),
    ("first_total", "first_total_p90"),
    ("second_ttfb", "second_ttfb_p90"),
    ("second_total", "second_total_p90"),
]

for metric_key, budget_key in checks:
    metric = metrics.get(metric_key)
    if not metric:
        failures.append(f"missing metric: {metric_key}")
        continue
    p90 = metric["p90"]
    limit = budgets[budget_key]
    if p90 > limit:
        failures.append(f"{metric_key}.p90={p90}s exceeds {budget_key}={limit}s")

baseline_path = os.environ.get("BASELINE_JSON", "").strip()
max_regression_pct = float(os.environ.get("MAX_REGRESSION_PCT", "5"))
baseline = None
if baseline_path:
    with open(baseline_path, "r", encoding="utf-8") as f:
        baseline = json.load(f)

if baseline:
    baseline_metrics = baseline.get("metrics", {})
    compare_keys = ["first_tls", "first_total", "second_total"]
    for key in compare_keys:
        cur = metrics.get(key, {}).get("p90")
        old = baseline_metrics.get(key, {}).get("p90")
        if cur is None or old is None:
            continue
        allowed = old * (1 + max_regression_pct / 100.0)
        if cur > allowed:
            failures.append(
                f"{key}.p90 regression: current={cur}s baseline={old}s allowed={round(allowed, 4)}s"
            )

result = {
    "timestamp_utc": datetime.now(timezone.utc).isoformat(),
    "base_url": os.environ["BASE_URL"],
    "endpoint_first": os.environ["ENDPOINT_A"],
    "endpoint_second": os.environ["ENDPOINT_B"],
    "rounds": len(rows),
    "http_failures": http_failures,
    "budgets": budgets,
    "metrics": metrics,
    "baseline_json": baseline_path or None,
    "max_regression_pct": max_regression_pct,
    "pass": len(failures) == 0,
    "failures": failures,
}

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("\n== Summary ==")
for key in ["first_tls", "first_ttfb", "first_total", "second_ttfb", "second_total"]:
    m = metrics[key]
    print(
        f"{key}: avg={m['avg']}s p50={m['p50']}s p90={m['p90']}s p95={m['p95']}s max={m['max']}s"
    )
print(f"http_failures={http_failures}")
print(f"result_json={output_path}")

if failures:
    print("\n== Budget Check: FAIL ==")
    for reason in failures:
        print(f"- {reason}")
    sys.exit(1)

print("\n== Budget Check: PASS ==")
PY
