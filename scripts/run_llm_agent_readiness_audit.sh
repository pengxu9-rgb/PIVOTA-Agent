#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_CLEAN_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"

AGENT_CANONICAL_REPO="${PIVOTA_AGENT_CANONICAL_REPO:-/Users/pengchydan/dev/PIVOTA-Agent}"
BACKEND_REPO="${PIVOTA_BACKEND_REPO:-/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-backend}"
ACP_REPO="${PIVOTA_ACP_REPO:-/Users/pengchydan/dev/pivota-acp-revert}"
CATALOG_REPO="${PIVOTA_CATALOG_REPO:-/Users/pengchydan/dev/Pivota-catalog-intelligence}"
BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
OUT_DIR="${OUT_DIR:-${AGENT_CLEAN_REPO}/reports/llm-agent-infra-readiness}"

timestamp() {
  date -u +"%Y%m%d_%H%M%S"
}

TS="$(timestamp)"
RUN_DIR="${OUT_DIR}/${TS}"
REPORT_MD="${RUN_DIR}/README.md"
SUMMARY_JSON="${RUN_DIR}/summary.json"
mkdir -p "${RUN_DIR}"

repo_branch() {
  git -C "$1" branch --show-current 2>/dev/null || true
}

repo_head() {
  git -C "$1" rev-parse --short HEAD 2>/dev/null || true
}

repo_origin_main() {
  git -C "$1" rev-parse --short origin/main 2>/dev/null || true
}

repo_dirty_count() {
  git -C "$1" status --porcelain 2>/dev/null | wc -l | tr -d ' '
}

path_tracked_in_origin() {
  local repo="$1"
  local target="$2"
  if git -C "$repo" rev-parse --verify origin/main >/dev/null 2>&1; then
    if git -C "$repo" ls-tree -r --name-only origin/main -- "$target" | grep -q .; then
      echo "yes"
      return
    fi
  fi
  echo "no"
}

probe_agent_service_version() {
  local response=""
  response="$(
    curl -fsS --max-time 20 \
      -H 'Content-Type: application/json' \
      -X POST \
      --data '{"operation":"find_products_multi","payload":{"search":{"query":"serum","limit":1,"in_stock_only":true}},"metadata":{"source":"search"}}' \
      "${BASE_URL%/}/api/gateway" \
      2>/dev/null || true
  )"
  if [[ -z "${response}" ]]; then
    echo ""
    return
  fi
  RESPONSE_JSON="${response}" python3 - <<'PY'
import json
import os

text = os.environ.get("RESPONSE_JSON", "").strip()
if not text:
    raise SystemExit(0)
try:
    data = json.loads(text)
except Exception:
    raise SystemExit(0)
meta = data.get("metadata") if isinstance(data, dict) else None
if not isinstance(meta, dict):
    raise SystemExit(0)
svc = meta.get("service_version")
if not isinstance(svc, dict):
    raise SystemExit(0)
commit = svc.get("commit")
if isinstance(commit, str) and commit.strip():
    print(commit.strip())
PY
}

STEP_NAMES=()
STEP_STATUSES=()
STEP_LOGS=()

run_step() {
  local name="$1"
  shift
  local slug
  slug="$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr ' /:' '___' | tr -cd 'a-z0-9_')"
  local log_file="${RUN_DIR}/${slug}.log"
  STEP_NAMES+=("$name")
  STEP_LOGS+=("$log_file")
  if "$@" >"${log_file}" 2>&1; then
    STEP_STATUSES+=("pass")
  else
    STEP_STATUSES+=("fail")
  fi
}

node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"

if [[ -z "${node_bin}" ]]; then
  echo "node binary not found in PATH" >&2
  exit 2
fi

if [[ -z "${npm_bin}" ]]; then
  echo "npm binary not found in PATH" >&2
  exit 2
fi

if [[ ! -x "${AGENT_CLEAN_REPO}/node_modules/.bin/jest" ]]; then
  run_step \
    "agent_clean_install" \
    bash -lc "cd '${AGENT_CLEAN_REPO}' && '${npm_bin}' ci"
fi

agent_node_modules_bin="${AGENT_CLEAN_REPO}/node_modules/.bin/jest"
agent_node_path="${AGENT_CLEAN_REPO}/node_modules"

if [[ ! -x "${agent_node_modules_bin}" ]]; then
  agent_node_modules_bin="${AGENT_CANONICAL_REPO}/node_modules/.bin/jest"
  agent_node_path="${AGENT_CANONICAL_REPO}/node_modules"
fi

run_step \
  "agent_search_regressions" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && PATH='$(dirname "${agent_node_modules_bin}")':\$PATH NODE_PATH='${agent_node_path}' '${node_bin}' --check src/server.js && '${node_bin}' --check scripts/search_stability_matrix.js && '${agent_node_modules_bin}' --runInBand tests/integration/invoke.find_products_multi_cache_search.test.js tests/integration/invoke.find_products_multi_strict_surface.test.js tests/services/external_seed_products.test.js tests/services/external_seed_harvester_bridge.test.js tests/find_products_multi_policy.test.js"

run_step \
  "shopping_production_smoke" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && VERIFY_DEPLOY=0 BASE_URL='${BASE_URL}' bash scripts/smoke_find_products_multi_skincare_prod.sh"

run_step \
  "backend_payment_aftercare_gate_local" \
  bash -lc "cd '${BACKEND_REPO}' && bash ./scripts/run_payment_aftercare_gate.sh"

if [[ -f "${BACKEND_REPO}/scripts/run_agent_rollout_gate.sh" ]]; then
  run_step \
    "backend_rollout_gate_local_candidate" \
    bash -lc "cd '${BACKEND_REPO}' && bash ./scripts/run_agent_rollout_gate.sh"
fi

if [[ -f "${ACP_REPO}/tests/test_agent_control_plane_contract.py" ]]; then
  run_step \
    "acp_control_plane_contract_gate_local" \
    bash -lc "cd '${ACP_REPO}' && python3 -m pytest tests/test_agent_governance_contract.py tests/test_agent_control_plane_contract.py tests/test_runtime_interface_drift.py tests/test_agent_rollout_contract.py tests/test_agent_docs_runtime.py tests/test_route_uniqueness.py -q"
fi

agent_prod_commit="$(probe_agent_service_version)"

{
  echo "# Pivota LLM / Agent Infrastructure Readiness"
  echo
  echo "- Timestamp (UTC): ${TS}"
  echo "- Base URL: ${BASE_URL}"
  echo "- Agent clean repo: \`${AGENT_CLEAN_REPO}\`"
  echo
  echo "## Repo Inventory"
  echo
  echo "| Repo | Path | Branch | HEAD | origin/main | Dirty files | Key gate/workflow on origin/main |"
  echo "| --- | --- | --- | --- | --- | ---: | --- |"
  echo "| Agent canonical | \`${AGENT_CANONICAL_REPO}\` | \`$(repo_branch "${AGENT_CANONICAL_REPO}")\` | \`$(repo_head "${AGENT_CANONICAL_REPO}")\` | \`$(repo_origin_main "${AGENT_CANONICAL_REPO}")\` | $(repo_dirty_count "${AGENT_CANONICAL_REPO}") | shopping gate tracked: $(path_tracked_in_origin "${AGENT_CANONICAL_REPO}" ".github/workflows/shopping-search-release-gate.yml") |"
  echo "| Backend canonical | \`${BACKEND_REPO}\` | \`$(repo_branch "${BACKEND_REPO}")\` | \`$(repo_head "${BACKEND_REPO}")\` | \`$(repo_origin_main "${BACKEND_REPO}")\` | $(repo_dirty_count "${BACKEND_REPO}") | rollout gate tracked: $(path_tracked_in_origin "${BACKEND_REPO}" "scripts/run_agent_rollout_gate.sh") |"
  echo "| ACP canonical | \`${ACP_REPO}\` | \`$(repo_branch "${ACP_REPO}")\` | \`$(repo_head "${ACP_REPO}")\` | \`$(repo_origin_main "${ACP_REPO}")\` | $(repo_dirty_count "${ACP_REPO}") | control-plane tests tracked: $(path_tracked_in_origin "${ACP_REPO}" "tests/test_agent_control_plane_contract.py") |"
  echo "| Catalog canonical | \`${CATALOG_REPO}\` | \`$(repo_branch "${CATALOG_REPO}")\` | \`$(repo_head "${CATALOG_REPO}")\` | \`$(repo_origin_main "${CATALOG_REPO}")\` | $(repo_dirty_count "${CATALOG_REPO}") | n/a |"
  echo
  echo "## Production Truth"
  echo
  if [[ -n "${agent_prod_commit}" ]]; then
    echo "- Agent public \`service_version.commit\`: \`${agent_prod_commit}\`"
  else
    echo "- Agent public \`service_version.commit\`: missing"
  fi
  echo
  echo "## Verification Runs"
  echo
  for i in "${!STEP_NAMES[@]}"; do
    echo "- ${STEP_NAMES[$i]}: ${STEP_STATUSES[$i]}"
    echo "  - log: \`${STEP_LOGS[$i]}\`"
  done
  echo
  echo "## Scorecard"
  echo
  agent_ok="red"
  shopping_ok="red"
  payment_ok="red"
  backend_contract_ok="red"
  acp_ok="amber"
  provenance_ok="amber"
  catalog_ok="amber"

  if [[ " ${STEP_NAMES[*]} " == *" agent_search_regressions "* ]]; then
    for i in "${!STEP_NAMES[@]}"; do
      if [[ "${STEP_NAMES[$i]}" == "agent_search_regressions" && "${STEP_STATUSES[$i]}" == "pass" ]]; then
        agent_ok="green"
      fi
      if [[ "${STEP_NAMES[$i]}" == "shopping_production_smoke" && "${STEP_STATUSES[$i]}" == "pass" ]]; then
        shopping_ok="green"
      fi
      if [[ "${STEP_NAMES[$i]}" == "backend_payment_aftercare_gate_local" && "${STEP_STATUSES[$i]}" == "pass" ]]; then
        payment_ok="green"
      fi
      if [[ "${STEP_NAMES[$i]}" == "backend_rollout_gate_local_candidate" && "${STEP_STATUSES[$i]}" == "pass" ]]; then
        backend_contract_ok="green"
      fi
      if [[ "${STEP_NAMES[$i]}" == "backend_rollout_gate_local_candidate" && "${STEP_STATUSES[$i]}" == "fail" ]]; then
        backend_contract_ok="red"
      fi
      if [[ "${STEP_NAMES[$i]}" == "acp_control_plane_contract_gate_local" && "${STEP_STATUSES[$i]}" == "pass" ]]; then
        acp_ok="green"
      fi
      if [[ "${STEP_NAMES[$i]}" == "acp_control_plane_contract_gate_local" && "${STEP_STATUSES[$i]}" == "fail" ]]; then
        acp_ok="red"
      fi
    done
  fi

  if [[ -n "${agent_prod_commit}" ]]; then
    provenance_ok="green"
  fi
  if [[ "$(path_tracked_in_origin "${AGENT_CANONICAL_REPO}" ".github/workflows/shopping-search-release-gate.yml")" != "yes" ]]; then
    provenance_ok="amber"
  fi
  if [[ "$(path_tracked_in_origin "${BACKEND_REPO}" "scripts/run_agent_rollout_gate.sh")" != "yes" ]]; then
    backend_contract_ok="red"
  fi
  if [[ "$(path_tracked_in_origin "${ACP_REPO}" "tests/test_agent_control_plane_contract.py")" != "yes" ]]; then
    acp_ok="amber"
  fi

  echo "- shopping commerce retrieval: ${shopping_ok}"
  echo "  - blocker: none if green; otherwise inspect search smoke or agent search regression logs."
  echo "- checkout / payment aftercare: ${payment_ok}"
  echo "  - blocker: payment-aftercare gate regression if not green."
  echo "- backend docs / runtime contracts: ${backend_contract_ok}"
  echo "  - blocker: backend rollout gate is currently local-only and not tracked in origin/main."
  echo "- dispute / operations workflow: ${backend_contract_ok}"
  echo "  - blocker: same backend rollout gate; current local candidate has known docs/SLA drift failures."
  echo "- ACP control-plane: ${acp_ok}"
  echo "  - blocker: local gate passes, but clean merged-main tracking is incomplete if amber."
  echo "- deploy provenance / workflow gates: ${provenance_ok}"
  echo "  - blocker: shopping release workflow missing from agent origin/main until this branch merges."
  echo "- catalog-intelligence / ingredient pipeline readiness: ${catalog_ok}"
  echo "  - blocker: no clean-main automated gate wired into this audit yet."
  echo
  echo "## Next Fixes"
  echo
  echo "1. Merge the agent shopping search release workflow and skincare smoke assets."
  echo "2. Upstream backend rollout gate files from local canonical repo into a clean branch, then fix the current docs title and PCS dashboard SLA drift."
  echo "3. Upstream ACP control-plane contract test stack from local canonical repo into a clean branch to remove local-only ambiguity."
  echo "4. Keep production smoke as a required release gate for any search, ingredient, budget FX, or external parity changes."
} >"${REPORT_MD}"

STEPS_TSV="${RUN_DIR}/steps.tsv"
: >"${STEPS_TSV}"
for i in "${!STEP_NAMES[@]}"; do
  printf '%s\t%s\t%s\n' "${STEP_NAMES[$i]}" "${STEP_STATUSES[$i]}" "${STEP_LOGS[$i]}" >>"${STEPS_TSV}"
done

python3 - "${STEPS_TSV}" >"${SUMMARY_JSON}" <<PY
import json
import pathlib
import sys

steps = []
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line.strip():
        continue
    name, status, log = line.split("\t", 2)
    steps.append({"name": name, "status": status, "log": log})

summary = {
    "timestamp_utc": "${TS}",
    "base_url": "${BASE_URL}",
    "agent_clean_repo": "${AGENT_CLEAN_REPO}",
    "agent_public_service_version_commit": "${agent_prod_commit}",
    "steps": steps,
}

print(json.dumps(summary, indent=2))
PY

echo "Readiness report: ${REPORT_MD}"
