#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-https://pivota-agent-production.up.railway.app}"
ENDPOINT="${ENDPOINT:-/agent/shop/v1/invoke}"
TIMEOUT_MS="${TIMEOUT_MS:-20000}"
VERIFY_DEPLOY="${VERIFY_DEPLOY:-1}"

cd "${REPO_ROOT}"

if [[ "${VERIFY_DEPLOY}" == "1" ]]; then
  BASE_URL="${BASE_URL}" ALT_GATEWAY_ENDPOINT="${ENDPOINT}" \
    bash "${SCRIPT_DIR}/verify_deployed_commit_matches.sh"
fi

BASE_URL="${BASE_URL}" \
ENDPOINT="${ENDPOINT}" \
TIMEOUT_MS="${TIMEOUT_MS}" \
node "${SCRIPT_DIR}/run_discovery_feed_smoke.cjs"
