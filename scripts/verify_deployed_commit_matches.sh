#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://pivota-agent-production.up.railway.app}"
TARGET_COMMIT="${TARGET_COMMIT:-$(git rev-parse --short=12 HEAD)}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-80}"
SLEEP_SECONDS="${SLEEP_SECONDS:-10}"

if ! [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$MAX_ATTEMPTS" -le 0 ]; then
  echo "MAX_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

if ! [[ "$SLEEP_SECONDS" =~ ^[0-9]+$ ]] || [ "$SLEEP_SECONDS" -lt 0 ]; then
  echo "SLEEP_SECONDS must be a non-negative integer" >&2
  exit 2
fi

echo "BASE_URL=$BASE_URL"
echo "TARGET_COMMIT=$TARGET_COMMIT"

deployed=""
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  deployed="$(
    curl -sSI "${BASE_URL%/}/v1/session/bootstrap" \
      | tr -d '\r' \
      | awk -F': ' 'tolower($1)=="x-service-commit" {print $2}' \
      | head -n 1 \
      || true
  )"
  echo "${i}/${MAX_ATTEMPTS} deployed_commit=${deployed:-missing}"
  if [ -n "${deployed:-}" ] && [ "$deployed" = "$TARGET_COMMIT" ]; then
    echo "PASS: deployed commit matches target."
    exit 0
  fi
  sleep "$SLEEP_SECONDS"
done

echo "FAIL: deployment commit mismatch."
echo "deployed=${deployed:-missing}"
echo "target=$TARGET_COMMIT"
exit 1
