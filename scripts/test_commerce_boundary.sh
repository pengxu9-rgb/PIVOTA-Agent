#!/usr/bin/env bash
set -euo pipefail

skip_preflight=0
if [[ "${1:-}" == "--skip-preflight" ]]; then
  skip_preflight=1
fi

if [[ "$skip_preflight" -ne 1 ]]; then
  bash scripts/test_preflight.sh
fi

bash scripts/test_commerce_boundary_node.sh --skip-preflight
bash scripts/test_commerce_boundary_jest.sh --skip-preflight
