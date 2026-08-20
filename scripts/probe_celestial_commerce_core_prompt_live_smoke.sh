#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-${COMMERCE_CORE_PROD_SMOKE_BASE_URL:-https://pivota-agent-production.up.railway.app}}"
ENDPOINT="${ENDPOINT:-/v1/chat}"
CASES_PATH="${CASES_PATH:-${SCRIPT_DIR}/fixtures/celestial_commerce_core_prompt_live_smoke.json}"
OUT_DIR="${OUT_DIR:-reports/celestial-commerce-core-prompt-live-smoke}"
TIMEOUT_MS="${TIMEOUT_MS:-25000}"
RETRIES="${RETRIES:-1}"
RETRY_BACKOFF_MS="${RETRY_BACKOFF_MS:-500}"
AUTH_TOKEN="${AUTH_TOKEN:-${CELESTIAL_COMMERCE_PROMPT_AUTH_TOKEN:-}}"
AGENT_API_KEY="${AGENT_API_KEY:-${CELESTIAL_COMMERCE_PROMPT_AGENT_API_KEY:-}}"

cd "${REPO_ROOT}"

args=(
  --base-url "${BASE_URL}"
  --endpoint "${ENDPOINT}"
  --cases "${CASES_PATH}"
  --out-dir "${OUT_DIR}"
  --timeout-ms "${TIMEOUT_MS}"
  --retries "${RETRIES}"
  --retry-backoff-ms "${RETRY_BACKOFF_MS}"
)

if [[ -n "${AUTH_TOKEN}" ]]; then
  args+=(--auth-token "${AUTH_TOKEN}")
fi

if [[ -n "${AGENT_API_KEY}" ]]; then
  args+=(--agent-api-key "${AGENT_API_KEY}")
fi

# /ui/chat is no longer anonymous on any host. This wrapper defaults ENDPOINT to /v1/chat, so CI is
# unaffected, but a manual run pointed at /ui/chat 404s on every case without this.
if [[ -n "${PIVOTA_UI_CHAT_INTERNAL_KEY:-}" ]]; then
  args+=(--internal-key "${PIVOTA_UI_CHAT_INTERNAL_KEY}")
fi

node "${SCRIPT_DIR}/run_celestial_commerce_core_prompt_live_smoke.js" "${args[@]}"
