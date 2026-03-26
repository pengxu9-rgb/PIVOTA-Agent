#!/usr/bin/env bash
set -euo pipefail

bash scripts/test_preflight.sh
bash scripts/test_commerce_boundary.sh --skip-preflight
npm run test
npm run contract:test
npm run verify:premerge
