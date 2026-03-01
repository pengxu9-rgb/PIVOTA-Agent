#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: npm run test:file -- <test-file> [more files...]" >&2
  exit 1
fi

bash scripts/test_preflight.sh

node_targets=()
jest_targets=()

for target in "$@"; do
  if [[ ! -f "$target" ]]; then
    echo "[test:file] ERROR: file not found: $target" >&2
    exit 1
  fi
  case "$target" in
    *.node.test.cjs)
      node_targets+=("$target")
      ;;
    *.test.js|*.test.ts)
      jest_targets+=("$target")
      ;;
    *)
      echo "[test:file] ERROR: unsupported test filename: $target" >&2
      echo "[test:file] Supported: *.node.test.cjs, *.test.js, *.test.ts" >&2
      exit 1
      ;;
  esac
done

if [[ ${#node_targets[@]} -gt 0 ]]; then
  node --test "${node_targets[@]}"
fi

if [[ ${#jest_targets[@]} -gt 0 ]]; then
  node ./node_modules/.bin/jest --watchman=false --runInBand "${jest_targets[@]}"
fi
