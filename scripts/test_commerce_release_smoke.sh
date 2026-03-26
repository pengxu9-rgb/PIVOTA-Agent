#!/usr/bin/env bash
set -euo pipefail

base="${BASE:-${BASE_URL:-}}"
if [[ -z "$base" ]]; then
  echo "Usage: BASE=https://your-runtime.example.com npm run test:gate:release-smoke" >&2
  exit 1
fi

BASE="$base" bash scripts/smoke_aurora_bff_runtime.sh
BASE="$base" bash scripts/smoke_travel_plans_runtime.sh
node scripts/smoke-lookreplicate-activity-slot.js
