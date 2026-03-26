#!/usr/bin/env bash
set -euo pipefail

heap_mb="${JEST_MAX_OLD_SPACE_SIZE_MB:-8192}"

AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED=false \
node --max-old-space-size="${heap_mb}" ./node_modules/.bin/jest --watchman=false --runInBand "$@"
