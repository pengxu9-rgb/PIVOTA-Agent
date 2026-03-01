#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR_NAME="PIVOTA-Agent-hotfix"
CI_PROJECT_DIR_NAME="${CI_PROJECT_DIR_NAME:-PIVOTA-Agent}"
REQUIRED_NODE_MAJOR="20"
SCAN_TIMEOUT_SECONDS="${TEST_PREFLIGHT_SCAN_TIMEOUT_SECONDS:-15}"
MAX_SCAN_FILES="${TEST_PREFLIGHT_MAX_SCAN_FILES:-1200}"
MAX_DALESS_PROBE="${TEST_PREFLIGHT_MAX_DALESS_PROBE:-8}"
MAX_BLOCKING_DALESS="${TEST_PREFLIGHT_MAX_BLOCKING_DALESS:-5}"

fail() {
  echo "[test:preflight] ERROR: $*" >&2
  exit 1
}

probe_readable() {
  local target="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$target" <<'PY'
import signal
import sys

path = sys.argv[1]

def timeout_handler(signum, frame):
    raise TimeoutError()

signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(10)
try:
    with open(path, "rb") as handle:
        handle.read(1)
    signal.alarm(0)
except Exception:
    sys.exit(1)
sys.exit(0)
PY
  else
    perl -e 'alarm shift @ARGV; exec @ARGV' 10 /bin/cat "$target" >/dev/null 2>&1
  fi
}

cwd="$(pwd -P)"

if [[ "$cwd" == *"/_deploy_tmp_"* ]]; then
  fail "do not run tests inside _deploy_tmp_ directories: $cwd"
fi

cwd_base="$(basename "$cwd")"
if [[ "$cwd_base" != "$PROJECT_DIR_NAME" && "$cwd_base" != "$CI_PROJECT_DIR_NAME" ]]; then
  fail "run tests from project root '$PROJECT_DIR_NAME' (or CI root '$CI_PROJECT_DIR_NAME'). current: $cwd"
fi

if [[ "$cwd" == *"/Desktop/"* ]]; then
  fail "workspace under Desktop is blocked. move to ~/dev and run tests there."
fi

if [[ ! -f package.json ]]; then
  fail "package.json not found in current directory."
fi

if [[ ! -d node_modules ]]; then
  fail "local node_modules missing. run npm ci in this project."
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node not found in PATH."
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" != "$REQUIRED_NODE_MAJOR" ]]; then
  fail "node major must be $REQUIRED_NODE_MAJOR. current: $(node -v)"
fi

resolved_zod="$(node -p "require.resolve('zod/package.json')" 2>/dev/null || true)"
if [[ -z "$resolved_zod" ]]; then
  fail "failed to resolve zod from local dependencies."
fi
if [[ "$resolved_zod" != "$cwd"/node_modules/* ]]; then
  fail "zod resolved outside local node_modules: $resolved_zod"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if ls -lO "$resolved_zod" 2>/dev/null | grep -q "dataless"; then
    probe_readable "$resolved_zod" || fail "resolved zod file is dataless and unreadable: $resolved_zod"
  fi
  scan_status=0
  scan_files="$(
    perl -e 'alarm shift @ARGV; exec @ARGV' "$SCAN_TIMEOUT_SECONDS" \
      git ls-files -- package.json package-lock.json src tests scripts jest.config.js 2>/dev/null \
      | awk 'NF && !seen[$0]++'
  )" || scan_status=$?
  if [[ "$scan_status" -ne 0 ]]; then
    fail "git ls-files timed out/failed during dataless scan (status=$scan_status)."
  fi
  blocking_dataless=()
  checked_dataless=0
  scanned_files=0
  if [[ -n "$scan_files" ]]; then
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      scanned_files=$((scanned_files + 1))
      if (( scanned_files > MAX_SCAN_FILES )); then
        fail "tracked file scan exceeded MAX_SCAN_FILES=$MAX_SCAN_FILES (possible index stall or oversized scope)."
      fi
      if ls -ldO "$file" 2>/dev/null | grep -q "dataless"; then
        if (( checked_dataless >= MAX_DALESS_PROBE )); then
          blocking_dataless+=("$file")
        else
          checked_dataless=$((checked_dataless + 1))
          probe_readable "$file" || blocking_dataless+=("$file")
        fi
        if (( ${#blocking_dataless[@]} >= MAX_BLOCKING_DALESS )); then
          break
        fi
      fi
    done <<< "$scan_files"
  fi
  if [[ ${#blocking_dataless[@]} -gt 0 ]]; then
    echo "[test:preflight] ERROR: dataless unreadable files detected; test run aborted." >&2
    printf '%s\n' "${blocking_dataless[@]:0:20}" | sed 's/^/[test:preflight]   /' >&2
    echo "[test:preflight] scanned_files=$scanned_files checked_dataless=$checked_dataless" >&2
    echo "[test:preflight] Move repo to local path (for example ~/dev), ensure files are fully hydrated, then run npm ci." >&2
    exit 1
  fi
fi

echo "[test:preflight] ok: node_major=$node_major zod=$resolved_zod"
