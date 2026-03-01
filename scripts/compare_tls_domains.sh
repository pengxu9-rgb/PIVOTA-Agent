#!/usr/bin/env bash
set -euo pipefail

# Compare TLS/TTFB/total latency across domain candidates.
# Usage:
#   HOSTS="pivota-agent-production.up.railway.app,api.pivota.cc" ./scripts/compare_tls_domains.sh
# Optional:
#   PATH_SUFFIX=/healthz ROUNDS=8 MODES=default,http1.1,http2 ./scripts/compare_tls_domains.sh
#   OUTPUT_JSON=/tmp/tls_domains.json ./scripts/compare_tls_domains.sh

HOSTS_RAW="${HOSTS:-pivota-agent-production.up.railway.app}"
PATH_SUFFIX="${PATH_SUFFIX:-/healthz}"
ROUNDS="${ROUNDS:-8}"
MODES="${MODES:-default,http1.1,http2}"
CONNECT_TIMEOUT_SEC="${CONNECT_TIMEOUT_SEC:-10}"
MAX_TIME_SEC="${MAX_TIME_SEC:-30}"
OUTPUT_JSON="${OUTPUT_JSON:-/tmp/tls_domain_compare_$(date +%Y%m%d_%H%M%S).json}"

if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]] || [ "$ROUNDS" -le 0 ]; then
  echo "ROUNDS must be a positive integer" >&2
  exit 1
fi

if [[ "$PATH_SUFFIX" != /* ]]; then
  echo "PATH_SUFFIX must start with '/'" >&2
  exit 1
fi

normalize_host() {
  local raw="$1"
  raw="$(echo "$raw" | tr -d '[:space:]')"
  raw="${raw#https://}"
  raw="${raw#http://}"
  raw="${raw%%/*}"
  printf "%s" "$raw"
}

mode_flag() {
  case "$1" in
    default) printf "" ;;
    http1.1) printf -- "--http1.1" ;;
    http2) printf -- "--http2" ;;
    *)
      echo "Unsupported mode: $1 (allowed: default,http1.1,http2)" >&2
      exit 1
      ;;
  esac
}

TMP_DATA="$(mktemp)"
trap 'rm -f "$TMP_DATA"' EXIT

IFS=', ' read -r -a HOST_ITEMS <<<"$HOSTS_RAW"
IFS=',' read -r -a MODE_ITEMS <<<"$MODES"

declare -a HOSTS=()
for item in "${HOST_ITEMS[@]}"; do
  host="$(normalize_host "$item")"
  if [ -n "$host" ]; then
    HOSTS+=("$host")
  fi
done

if [ "${#HOSTS[@]}" -eq 0 ]; then
  echo "No valid hosts provided in HOSTS" >&2
  exit 1
fi

echo "== TLS domain comparison =="
echo "hosts=${HOSTS[*]}"
echo "path=${PATH_SUFFIX}"
echo "rounds=${ROUNDS}"
echo "modes=${MODES}"
echo

for host in "${HOSTS[@]}"; do
  for raw_mode in "${MODE_ITEMS[@]}"; do
    mode="$(echo "$raw_mode" | tr -d '[:space:]')"
    [ -z "$mode" ] && continue
    flag="$(mode_flag "$mode")"
    echo "-- host=${host} mode=${mode} --"
    for ((i = 1; i <= ROUNDS; i++)); do
      url="https://${host}${PATH_SUFFIX}"
      probe="$(curl -sS ${flag} \
        --connect-timeout "${CONNECT_TIMEOUT_SEC}" \
        --max-time "${MAX_TIME_SEC}" \
        -o /dev/null \
        -w "%{http_code} %{time_appconnect} %{time_starttransfer} %{time_total}" \
        "$url")"
      code="$(echo "$probe" | awk '{print $1}')"
      tls="$(echo "$probe" | awk '{print $2}')"
      ttfb="$(echo "$probe" | awk '{print $3}')"
      total="$(echo "$probe" | awk '{print $4}')"
      printf "%s %s %s %s %s %s\n" "$host" "$mode" "$code" "$tls" "$ttfb" "$total" >>"$TMP_DATA"
      echo "round=${i} code=${code} tls=${tls}s ttfb=${ttfb}s total=${total}s"
    done
    echo
  done
done

export OUTPUT_JSON
python3 - "$TMP_DATA" <<'PY'
import json
import math
import os
import sys
from collections import defaultdict
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


rows = []
with open(sys.argv[1], "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        host, mode, code, tls, ttfb, total = line.split()
        rows.append(
            {
                "host": host,
                "mode": mode,
                "code": int(code),
                "tls": float(tls),
                "ttfb": float(ttfb),
                "total": float(total),
                "app_time": max(0.0, float(ttfb) - float(tls)),
            }
        )

groups = defaultdict(list)
for row in rows:
    groups[(row["host"], row["mode"])].append(row)

summary_rows = []
for (host, mode), vals in groups.items():
    codes = [v["code"] for v in vals]
    success = sum(1 for c in codes if c == 200)
    entry = {
        "host": host,
        "mode": mode,
        "rounds": len(vals),
        "success_count": success,
        "success_rate": round(success / len(vals), 4) if vals else 0.0,
        "tls": stats([v["tls"] for v in vals]),
        "ttfb": stats([v["ttfb"] for v in vals]),
        "total": stats([v["total"] for v in vals]),
        "app_time": stats([v["app_time"] for v in vals]),
    }
    summary_rows.append(entry)

summary_rows.sort(key=lambda x: (x["total"]["p90"], x["ttfb"]["p90"], x["tls"]["p90"]))

result = {
    "timestamp_utc": datetime.now(timezone.utc).isoformat(),
    "summary": summary_rows,
}

out = os.environ["OUTPUT_JSON"]
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
    f.write("\n")

print("== Ranked by total.p90 (lower is better) ==")
for i, item in enumerate(summary_rows, start=1):
    print(
        f"{i}. host={item['host']} mode={item['mode']} "
        f"success={item['success_count']}/{item['rounds']} "
        f"tls_p90={item['tls']['p90']}s "
        f"ttfb_p90={item['ttfb']['p90']}s "
        f"total_p90={item['total']['p90']}s "
        f"app_p90={item['app_time']['p90']}s"
    )
print(f"\nresult_json={out}")
PY
