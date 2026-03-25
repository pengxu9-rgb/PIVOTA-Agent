#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_CLEAN_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"

AGENT_CANONICAL_REPO="${PIVOTA_AGENT_CANONICAL_REPO:-/Users/pengchydan/dev/PIVOTA-Agent}"
BACKEND_REPO="${PIVOTA_BACKEND_REPO:-/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-backend}"
ACP_REPO="${PIVOTA_ACP_REPO:-/Users/pengchydan/dev/pivota-acp-revert}"
BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
BACKEND_PUBLIC_BASE_URL="${BACKEND_PUBLIC_BASE_URL:-https://web-production-fedb.up.railway.app}"
OUT_DIR="${OUT_DIR:-${AGENT_CLEAN_REPO}/reports/celestial-commerce-core-readiness}"

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

probe_backend_public_version() {
  python3 - "${BACKEND_PUBLIC_BASE_URL%/}" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")

def nonempty(value):
    if isinstance(value, str):
        value = value.strip()
        return value or ""
    return ""

for path in ("/__build", "/health"):
    url = f"{base}{path}"
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            body = response.read().decode("utf-8", "replace")
            headers = {str(k).lower(): str(v).strip() for k, v in response.headers.items()}
    except (urllib.error.URLError, TimeoutError, ValueError):
        continue

    payload = {}
    if body.strip():
      try:
        payload = json.loads(body)
      except json.JSONDecodeError:
        payload = {}

    version = payload.get("version") if isinstance(payload, dict) else {}
    if not isinstance(version, dict):
      version = {}
    info = {
      "commit": nonempty(version.get("commit")) or nonempty(headers.get("x-service-commit")),
      "build_id": nonempty(version.get("build_id")) or nonempty(headers.get("x-service-build-id")),
      "deployment_id": nonempty(version.get("deployment_id")) or nonempty(headers.get("x-service-deployment-id")),
      "service": nonempty(version.get("service")) or nonempty(payload.get("service")),
      "environment": nonempty(version.get("environment")),
      "probe_path": path,
    }
    if any(info.values()):
      print(json.dumps(info))
      raise SystemExit(0)

print("{}")
PY
}

json_field() {
  local json="$1"
  local field="$2"
  RESPONSE_JSON="${json}" python3 - "${field}" <<'PY'
import json
import os
import sys

field = sys.argv[1]
text = os.environ.get("RESPONSE_JSON", "").strip()
if not text:
    raise SystemExit(0)
try:
    data = json.loads(text)
except Exception:
    raise SystemExit(0)
value = data.get(field)
if isinstance(value, str) and value.strip():
    print(value.strip())
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

if [[ -z "${node_bin}" || -z "${npm_bin}" ]]; then
  echo "node and npm are required" >&2
  exit 2
fi

if [[ ! -x "${AGENT_CLEAN_REPO}/node_modules/.bin/jest" ]]; then
  run_step \
    "agent_clean_install" \
    bash -lc "cd '${AGENT_CLEAN_REPO}' && '${npm_bin}' ci"
fi

agent_jest="${AGENT_CLEAN_REPO}/node_modules/.bin/jest"
agent_node_path="${AGENT_CLEAN_REPO}/node_modules"
if [[ ! -x "${agent_jest}" ]]; then
  agent_jest="${AGENT_CANONICAL_REPO}/node_modules/.bin/jest"
  agent_node_path="${AGENT_CANONICAL_REPO}/node_modules"
fi

run_step \
  "public_search_contract_local_gate" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && PATH='$(dirname "${agent_jest}")':\$PATH NODE_PATH='${agent_node_path}' '${node_bin}' --check src/server.js && '${node_bin}' --check scripts/search_stability_matrix.js && bash -n scripts/smoke_celestial_commerce_core_prod.sh && '${agent_jest}' --runInBand tests/celestial_commerce_core_contracts.test.js tests/integration/invoke.find_products_multi_cache_search.test.js"

run_step \
  "shopping_agent_commerce_local_gate" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && PATH='$(dirname "${agent_jest}")':\$PATH NODE_PATH='${agent_node_path}' '${agent_jest}' --runInBand tests/celestial_commerce_core_contracts.test.js tests/integration/invoke.find_products_multi_strict_surface.test.js"

run_step \
  "aurora_commerce_orchestration_local_gate" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && PATH='$(dirname "${agent_jest}")':\$PATH NODE_PATH='${agent_node_path}' '${agent_jest}' --runInBand tests/aurora_commerce_core_contracts.test.js"

run_step \
  "commerce_core_production_smoke" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && VERIFY_DEPLOY=0 BASE_URL='${BASE_URL}' bash scripts/smoke_celestial_commerce_core_prod.sh"

agent_prod_commit="$(probe_agent_service_version)"
backend_public_version_json="$(probe_backend_public_version)"
backend_prod_commit="$(json_field "${backend_public_version_json}" "commit")"
backend_prod_build_id="$(json_field "${backend_public_version_json}" "build_id")"
backend_prod_deployment_id="$(json_field "${backend_public_version_json}" "deployment_id")"
backend_prod_service="$(json_field "${backend_public_version_json}" "service")"
backend_prod_environment="$(json_field "${backend_public_version_json}" "environment")"
backend_prod_probe_path="$(json_field "${backend_public_version_json}" "probe_path")"

step_status() {
  local target="$1"
  for i in "${!STEP_NAMES[@]}"; do
    if [[ "${STEP_NAMES[$i]}" == "${target}" ]]; then
      echo "${STEP_STATUSES[$i]}"
      return
    fi
  done
  echo "missing"
}

score_from_status() {
  local status="$1"
  if [[ "${status}" == "pass" ]]; then
    echo "green"
  else
    echo "red"
  fi
}

public_local_status="$(step_status public_search_contract_local_gate)"
shopping_local_status="$(step_status shopping_agent_commerce_local_gate)"
aurora_local_status="$(step_status aurora_commerce_orchestration_local_gate)"
prod_smoke_status="$(step_status commerce_core_production_smoke)"

prompt_intent_status="red"
query_decomposition_status="red"
commerce_search_status="red"
merchant_product_status="red"
fallback_resilience_status="red"
provenance_status="amber"
drift_status="red"

if [[ "${shopping_local_status}" == "pass" ]]; then
  prompt_intent_status="amber"
  query_decomposition_status="amber"
fi

if [[ "${public_local_status}" == "pass" && "${prod_smoke_status}" == "pass" ]]; then
  commerce_search_status="green"
fi
if [[ "${aurora_local_status}" == "pass" && "${prod_smoke_status}" == "pass" ]]; then
  merchant_product_status="amber"
fi
if [[ "${shopping_local_status}" == "pass" && "${aurora_local_status}" == "pass" && "${prod_smoke_status}" == "pass" ]]; then
  fallback_resilience_status="amber"
  drift_status="amber"
fi
if [[ -n "${agent_prod_commit}" && -n "${backend_prod_commit}" && "${backend_prod_service}" == "pivota-backend" ]]; then
  provenance_status="green"
fi

{
  echo "# Celestial Commerce Core Readiness"
  echo
  echo "- Timestamp (UTC): ${TS}"
  echo "- Base URL: ${BASE_URL}"
  echo "- Backend public base URL: ${BACKEND_PUBLIC_BASE_URL}"
  echo "- Agent clean repo: \`${AGENT_CLEAN_REPO}\`"
  echo
  echo "## Layer Contract Inventory"
  echo
  echo "| Item | Status | Evidence |"
  echo "| --- | --- | --- |"
  echo "| Source contract matrix tracked on origin/main | $(path_tracked_in_origin "${AGENT_CLEAN_REPO}" "docs/runbooks/celestial_commerce_core_source_contracts.md") | \`docs/runbooks/celestial_commerce_core_source_contracts.md\` |"
  echo "| Commerce core runbook tracked on origin/main | $(path_tracked_in_origin "${AGENT_CLEAN_REPO}" "docs/runbooks/celestial_commerce_core_readiness.md") | \`docs/runbooks/celestial_commerce_core_readiness.md\` |"
  echo "| Commerce core workflow tracked on origin/main | $(path_tracked_in_origin "${AGENT_CLEAN_REPO}" ".github/workflows/celestial-commerce-core-readiness.yml") | \`.github/workflows/celestial-commerce-core-readiness.yml\` |"
  echo
  echo "## Repo Truth"
  echo
  echo "| Repo | Branch | HEAD | origin/main | Dirty files |"
  echo "| --- | --- | --- | --- | ---: |"
  echo "| Agent clean | \`$(repo_branch "${AGENT_CLEAN_REPO}")\` | \`$(repo_head "${AGENT_CLEAN_REPO}")\` | \`$(repo_origin_main "${AGENT_CLEAN_REPO}")\` | $(repo_dirty_count "${AGENT_CLEAN_REPO}") |"
  echo "| Agent canonical | \`$(repo_branch "${AGENT_CANONICAL_REPO}")\` | \`$(repo_head "${AGENT_CANONICAL_REPO}")\` | \`$(repo_origin_main "${AGENT_CANONICAL_REPO}")\` | $(repo_dirty_count "${AGENT_CANONICAL_REPO}") |"
  echo "| Backend canonical | \`$(repo_branch "${BACKEND_REPO}")\` | \`$(repo_head "${BACKEND_REPO}")\` | \`$(repo_origin_main "${BACKEND_REPO}")\` | $(repo_dirty_count "${BACKEND_REPO}") |"
  echo "| ACP canonical | \`$(repo_branch "${ACP_REPO}")\` | \`$(repo_head "${ACP_REPO}")\` | \`$(repo_origin_main "${ACP_REPO}")\` | $(repo_dirty_count "${ACP_REPO}") |"
  echo
  echo "## Production Truth"
  echo
  echo "- Agent public \`service_version.commit\`: \`${agent_prod_commit:-missing}\`"
  echo "- Backend public \`version.commit\`: \`${backend_prod_commit:-missing}\`"
  echo "- Backend public \`version.build_id\`: \`${backend_prod_build_id:-missing}\`"
  echo "- Backend public \`version.deployment_id\`: \`${backend_prod_deployment_id:-missing}\`"
  echo "- Backend public \`version.service\`: \`${backend_prod_service:-missing}\`"
  echo "- Backend public \`version.environment\`: \`${backend_prod_environment:-missing}\`"
  echo "- Backend public probe path: \`${backend_prod_probe_path:-missing}\`"
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
  echo "| Dimension | Status | Primary blocker |"
  echo "| --- | --- | --- |"
  echo "| Prompt/Intent Readiness | ${prompt_intent_status} | $( if [[ "${prompt_intent_status}" == "green" ]]; then echo "none"; elif [[ "${prompt_intent_status}" == "amber" ]]; then echo "shopping-agent prompt/loop-break contract is testable locally, but not yet backed by stable live prompt fixtures"; else echo "shopping_agent helper/query-rewrite gate failing"; fi ) |"
  echo "| Query Decomposition Readiness | ${query_decomposition_status} | $( if [[ "${query_decomposition_status}" == "green" ]]; then echo "none"; elif [[ "${query_decomposition_status}" == "amber" ]]; then echo "merchant vs product decomposition still lacks a canonical live acceptance corpus"; else echo "scenario clarify/query rewrite contract incomplete"; fi ) |"
  echo "| Commerce Search Contract Readiness | ${commerce_search_status} | $( if [[ "${commerce_search_status}" == "green" ]]; then echo "none"; else echo "public search contract or prod smoke failing"; fi ) |"
  echo "| Merchant/Product Routing Readiness | ${merchant_product_status} | $( if [[ "${merchant_product_status}" == "green" ]]; then echo "none"; elif [[ "${merchant_product_status}" == "amber" ]]; then echo "merchant-style live routing is now covered, but exact product lookup on shopping_agent is still live-flaky and remains local-only"; else echo "aurora-bff downstream routing/source propagation failing"; fi ) |"
  echo "| Fallback/Resilience Readiness | ${fallback_resilience_status} | $( if [[ "${fallback_resilience_status}" == "green" ]]; then echo "none"; elif [[ "${fallback_resilience_status}" == "amber" ]]; then echo "clarify-required live behavior is covered, but exact lookup fallback still is not deterministic enough for shared production smoke"; else echo "cross-layer fallback/strict path not fully covered"; fi ) |"
  echo "| Observability/Provenance Readiness | ${provenance_status} | $( if [[ "${provenance_status}" == "green" ]]; then echo "none"; else echo "agent/backend public version surface incomplete"; fi ) |"
  echo "| Cross-layer Contract Drift Risk | ${drift_status} | $( if [[ "${drift_status}" == "green" ]]; then echo "none"; elif [[ "${drift_status}" == "amber" ]]; then echo "L1/L2 semantics are aligned by contract and smoke today, but still coordinated across multiple modules"; else echo "source contracts and prod semantics still diverge"; fi ) |"
  echo
  echo "## Next Fixes"
  echo
  echo "1. Keep \`search\`, \`shopping_agent\`, and \`aurora-bff\` contract fixtures in one shared prod smoke so future drift is visible immediately."
  echo "2. Add stable live prompt fixtures for \`/ui/chat\` so shopping-agent prompt understanding can graduate from local helper coverage to true end-to-end coverage."
  echo "3. Stabilize exact product-lookup routing for \`shopping_agent\` and only then promote product-specific lookup back into the shared live commerce-core smoke."
  echo "4. If Aurora and shopping-agent semantics diverge again, move the shared commerce query contract into a single reusable module instead of env-level coordination."
} >"${REPORT_MD}"

STEPS_JSONL="${RUN_DIR}/steps.jsonl"
: >"${STEPS_JSONL}"
for i in "${!STEP_NAMES[@]}"; do
  python3 - "${STEP_NAMES[$i]}" "${STEP_STATUSES[$i]}" "${STEP_LOGS[$i]}" >>"${STEPS_JSONL}" <<'PY'
import json
import sys
name, status, log = sys.argv[1:4]
print(json.dumps({"name": name, "status": status, "log": log}))
PY
done

python3 - "${SUMMARY_JSON}" "${STEPS_JSONL}" <<PY
import json
import pathlib
import sys

summary_path = pathlib.Path(sys.argv[1])
steps_path = pathlib.Path(sys.argv[2])
steps = []
if steps_path.exists():
    for line in steps_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        steps.append(json.loads(line))

summary = {
    "timestamp_utc": "${TS}",
    "base_url": "${BASE_URL}",
    "backend_public_base_url": "${BACKEND_PUBLIC_BASE_URL}",
    "agent_clean_repo": "${AGENT_CLEAN_REPO}",
    "agent_public_service_version_commit": "${agent_prod_commit}",
    "backend_public_version": {
        "commit": "${backend_prod_commit}",
        "build_id": "${backend_prod_build_id}",
        "deployment_id": "${backend_prod_deployment_id}",
        "service": "${backend_prod_service}",
        "environment": "${backend_prod_environment}",
        "probe_path": "${backend_prod_probe_path}",
    },
    "steps": steps,
    "scorecard": {
        "prompt_intent": "${prompt_intent_status}",
        "query_decomposition": "${query_decomposition_status}",
        "commerce_search_contract": "${commerce_search_status}",
        "merchant_product_routing": "${merchant_product_status}",
        "fallback_resilience": "${fallback_resilience_status}",
        "observability_provenance": "${provenance_status}",
        "cross_layer_contract_drift": "${drift_status}",
    },
}
summary_path.write_text(json.dumps(summary, indent=2))
PY

echo "Commerce core readiness report: ${REPORT_MD}"
