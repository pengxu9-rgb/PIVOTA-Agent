#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR_NAME="PIVOTA-Agent-hotfix"
REQUIRED_NODE_MAJOR="20"

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

if [[ "$(basename "$cwd")" != "$PROJECT_DIR_NAME" ]]; then
  fail "run tests from project root '$PROJECT_DIR_NAME'. current: $cwd"
fi

if [[ "$cwd" == *"/Desktop/"* && "${ALLOW_DESKTOP_WORKSPACE:-0}" != "1" ]]; then
  fail "workspace under Desktop is not allowed by default. move to ~/dev or set ALLOW_DESKTOP_WORKSPACE=1 temporarily."
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
  scan_files="$(git ls-files -- package.json package-lock.json src tests scripts jest.config.js 2>/dev/null || true)"
  blocking_dataless=()
  checked_dataless=0
  max_dataless_probe=12
  if [[ -n "$scan_files" ]]; then
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      if ls -ldO "$file" 2>/dev/null | grep -q "dataless"; then
        if (( checked_dataless >= max_dataless_probe )); then
          blocking_dataless+=("$file")
          continue
        fi
        checked_dataless=$((checked_dataless + 1))
        probe_readable "$file" || blocking_dataless+=("$file")
      fi
    done <<< "$scan_files"
  fi
  if [[ ${#blocking_dataless[@]} -gt 0 ]]; then
    echo "[test:preflight] ERROR: dataless unreadable files detected; test run aborted." >&2
    printf '%s\n' "${blocking_dataless[@]:0:20}" | sed 's/^/[test:preflight]   /' >&2
    echo "[test:preflight] Move repo to local path (for example ~/dev), ensure files are fully hydrated, then run npm ci." >&2
    exit 1
  fi
fi

echo "[test:preflight] ok: node_major=$node_major zod=$resolved_zod"
