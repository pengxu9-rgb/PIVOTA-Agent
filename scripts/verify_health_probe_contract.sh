#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ALLOWED_ASSERT_HEALTHZ_LITE="request(app).get('/healthz/lite').expect(404)"
ALLOWED_ASSERT_HEALTH_LITE="request(app).get('/health/lite').expect(404)"

TARGETS=()
for path in Dockerfile monitor-pivota.sh scripts src tests docs .github monitoring ci Makefile package.json package-lock.json; do
  if [[ -e "$path" ]]; then
    TARGETS+=("$path")
  fi
done

if command -v rg >/dev/null 2>&1; then
  MATCH_LINES="$(
    rg -n --no-heading --color=never --no-messages --glob '!scripts/verify_health_probe_contract.sh' "healthz/lite|health/lite" "${TARGETS[@]}" || true
  )"
else
  MATCH_LINES="$(
    grep -R -n -E --exclude='verify_health_probe_contract.sh' "healthz/lite|health/lite" "${TARGETS[@]}" 2>/dev/null || true
  )"
fi

if [[ -z "$MATCH_LINES" ]]; then
  echo "[health-probe-contract] expected deprecation assertions are missing." >&2
  exit 1
fi

FOUND_HEALTHZ_LITE=0
FOUND_HEALTH_LITE=0
UNEXPECTED_LINES=""

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ "$line" == *"tests/server.health.test.js:"*"$ALLOWED_ASSERT_HEALTHZ_LITE"* ]]; then
    FOUND_HEALTHZ_LITE=1
    continue
  fi
  if [[ "$line" == *"tests/server.health.test.js:"*"$ALLOWED_ASSERT_HEALTH_LITE"* ]]; then
    FOUND_HEALTH_LITE=1
    continue
  fi
  UNEXPECTED_LINES+="${line}"$'\n'
done <<< "$MATCH_LINES"

if [[ -n "$UNEXPECTED_LINES" ]]; then
  echo "[health-probe-contract] unexpected lite endpoint references detected:" >&2
  printf '%s' "$UNEXPECTED_LINES" >&2
  exit 1
fi

if (( FOUND_HEALTHZ_LITE == 0 || FOUND_HEALTH_LITE == 0 )); then
  echo "[health-probe-contract] missing required 404 assertions in tests/server.health.test.js" >&2
  exit 1
fi

echo "[health-probe-contract] OK: only deprecated 404 assertions remain."
