#!/usr/bin/env bash
set -euo pipefail

skip_preflight=0
if [[ "${1:-}" == "--skip-preflight" ]]; then
  skip_preflight=1
fi

if [[ "$skip_preflight" -ne 1 ]]; then
  bash scripts/test_preflight.sh
fi

AURORA_BFF_USE_MOCK=true \
AURORA_CHAT_RESPONSE_FORMAT=legacy \
node --test --test-concurrency=1 \
  tests/boundary_service_imports.node.test.cjs \
  tests/standalone_service_apps.node.test.cjs \
  tests/aurora_bff_reco_catalog.node.test.cjs \
  tests/aurora_bff_pdp_prefetch.node.test.cjs
