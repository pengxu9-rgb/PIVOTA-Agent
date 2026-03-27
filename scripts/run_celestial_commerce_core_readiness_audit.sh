#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_CLEAN_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"

AGENT_CANONICAL_REPO="${PIVOTA_AGENT_CANONICAL_REPO:-/Users/pengchydan/dev/PIVOTA-Agent}"
BACKEND_REPO="${PIVOTA_BACKEND_REPO:-/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-backend}"
ACP_REPO="${PIVOTA_ACP_REPO:-/Users/pengchydan/dev/pivota-acp-revert}"
BASE_URL="${BASE_URL:-https://agent.pivota.cc}"
BACKEND_PUBLIC_BASE_URL="${BACKEND_PUBLIC_BASE_URL:-https://web-production-fedb.up.railway.app}"
GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH="${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH:-}"
GATEWAY_GOVERNANCE_LOG_INPUT_PATH="${GATEWAY_GOVERNANCE_LOG_INPUT_PATH:-}"
OUT_DIR="${OUT_DIR:-${AGENT_CLEAN_REPO}/reports/celestial-commerce-core-readiness}"
COMMERCE_CORE_PROD_SMOKE_ENDPOINT="${COMMERCE_CORE_PROD_SMOKE_ENDPOINT:-}"
COMMERCE_CORE_PROD_AUTH_TOKEN="${COMMERCE_CORE_PROD_AUTH_TOKEN:-}"
COMMERCE_CORE_PROD_AGENT_API_KEY="${COMMERCE_CORE_PROD_AGENT_API_KEY:-}"

timestamp() {
  date -u +"%Y%m%d_%H%M%S"
}

TS="$(timestamp)"
RUN_DIR="${OUT_DIR}/${TS}"
REPORT_MD="${RUN_DIR}/README.md"
SUMMARY_JSON="${RUN_DIR}/summary.json"
GATEWAY_GOVERNANCE_REPORT_MD="${RUN_DIR}/gateway_governance_shadow_summary.md"
GATEWAY_GOVERNANCE_REPORT_JSON="${RUN_DIR}/gateway_governance_shadow_summary.json"
GATEWAY_GOVERNANCE_EXTRACTED_SAMPLE="${RUN_DIR}/gateway_governance_shadow_runtime_sample.ndjson"
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

probe_agent_public_contract() {
  python3 - "${BASE_URL%/}/api/gateway" <<'PY'
import json
import sys
import urllib.error
import urllib.request

url = sys.argv[1]
payload = json.dumps({
    "operation": "find_products_multi",
    "payload": {"search": {"query": "serum", "limit": 1, "in_stock_only": True}},
    "metadata": {"source": "search"},
}).encode("utf-8")
headers = {"Content-Type": "application/json"}
request = urllib.request.Request(url, data=payload, headers=headers, method="POST")

status = None
raw_body = ""
response_headers = {}
transport_error = ""

try:
    with urllib.request.urlopen(request, timeout=20) as response:
        status = response.status
        raw_body = response.read().decode("utf-8", "replace")
        response_headers = {str(k).lower(): str(v).strip() for k, v in response.headers.items()}
except urllib.error.HTTPError as exc:
    status = exc.code
    raw_body = exc.read().decode("utf-8", "replace")
    response_headers = {str(k).lower(): str(v).strip() for k, v in exc.headers.items()}
except (urllib.error.URLError, TimeoutError, ValueError) as exc:
    transport_error = str(exc)

payload_json = {}
if raw_body.strip():
    try:
        payload_json = json.loads(raw_body)
    except json.JSONDecodeError:
        payload_json = {}

metadata = payload_json.get("metadata") if isinstance(payload_json, dict) else {}
if not isinstance(metadata, dict):
    metadata = {}
service_version = metadata.get("service_version")
if not isinstance(service_version, dict):
    service_version = {}

result = {
    "http_status": status,
    "error": payload_json.get("error") if isinstance(payload_json, dict) else "",
    "message": payload_json.get("message") if isinstance(payload_json, dict) else "",
    "service_version_commit": service_version.get("commit") if isinstance(service_version.get("commit"), str) else "",
    "content_type": response_headers.get("content-type", ""),
    "transport_error": transport_error,
}
print(json.dumps(result))
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

field_path = [part for part in sys.argv[1].split('.') if part]
text = os.environ.get("RESPONSE_JSON", "").strip()
if not text:
    raise SystemExit(0)
try:
    data = json.loads(text)
except Exception:
    raise SystemExit(0)
value = data
for part in field_path:
    if isinstance(value, dict):
        value = value.get(part)
    elif isinstance(value, list):
        try:
            value = value[int(part)]
        except Exception:
            raise SystemExit(0)
    else:
        raise SystemExit(0)

if isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, (int, float)):
    print(value)
elif isinstance(value, str) and value.strip():
    print(value.strip())
PY
}

json_file_field() {
  local json_path="$1"
  local field_path="$2"
  python3 - "${json_path}" "${field_path}" <<'PY'
import json
import pathlib
import sys

json_path = pathlib.Path(sys.argv[1])
field_path = [part for part in sys.argv[2].split('.') if part]
if not json_path.exists():
    raise SystemExit(0)
try:
    data = json.loads(json_path.read_text())
except Exception:
    raise SystemExit(0)

value = data
for part in field_path:
    if isinstance(value, dict):
        value = value.get(part)
    elif isinstance(value, list):
        try:
            value = value[int(part)]
        except Exception:
            raise SystemExit(0)
    else:
        raise SystemExit(0)

if isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, (int, float)):
    print(value)
elif isinstance(value, str) and value.strip():
    print(value.strip())
PY
}

git_commit_on_origin_main() {
  local repo="$1"
  local commit="$2"
  if [[ -z "${commit}" ]]; then
    echo "unknown"
    return
  fi
  if ! git -C "$repo" rev-parse --verify "${commit}^{commit}" >/dev/null 2>&1; then
    echo "unknown"
    return
  fi
  if git -C "$repo" rev-parse --verify origin/main >/dev/null 2>&1 && \
     git -C "$repo" merge-base --is-ancestor "${commit}" origin/main >/dev/null 2>&1; then
    echo "true"
    return
  fi
  echo "false"
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
  "gateway_governance_local_gate" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && PATH='$(dirname "${agent_jest}")':\$PATH NODE_PATH='${agent_node_path}' '${agent_jest}' --runInBand tests/celestial_commerce_gateway_access_governance.test.js tests/celestial_commerce_gateway_ingress_invocation.test.js tests/invoke_gateway_shadow_audit.test.js tests/celestial_commerce_gateway_shadow_summary.test.js tests/celestial_commerce_gateway_governance_report_script.test.js"

run_step \
  "commerce_core_production_smoke" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && VERIFY_DEPLOY=0 BASE_URL='${BASE_URL}' bash scripts/smoke_celestial_commerce_core_prod.sh"

gateway_governance_runtime_input_path="${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH}"
if [[ -n "${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}" ]]; then
  run_step \
    "gateway_governance_shadow_extract" \
    bash -lc "cd '${AGENT_CLEAN_REPO}' && '${node_bin}' scripts/extract_gateway_governance_shadow_sample.js --input '${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}' --out '${GATEWAY_GOVERNANCE_EXTRACTED_SAMPLE}'"
  gateway_governance_extract_last_status="${STEP_STATUSES[$((${#STEP_STATUSES[@]} - 1))]}"
  if [[ "${gateway_governance_extract_last_status}" == "pass" ]]; then
    gateway_governance_runtime_input_path="${GATEWAY_GOVERNANCE_EXTRACTED_SAMPLE}"
  else
    gateway_governance_runtime_input_path=""
  fi
fi

run_step \
  "gateway_governance_shadow_report" \
  bash -lc "cd '${AGENT_CLEAN_REPO}' && report_cmd=( '${node_bin}' scripts/generate_celestial_commerce_gateway_governance_report.js --out-dir '${RUN_DIR}' ); if [[ -n '${gateway_governance_runtime_input_path}' ]]; then report_cmd+=( --runtime-sample '${gateway_governance_runtime_input_path}' ); fi; \"\${report_cmd[@]}\""

agent_public_contract_json="$(probe_agent_public_contract)"
agent_public_contract_status="$(json_field "${agent_public_contract_json}" "http_status")"
agent_public_contract_error="$(json_field "${agent_public_contract_json}" "error")"
agent_public_contract_message="$(json_field "${agent_public_contract_json}" "message")"
agent_public_contract_content_type="$(json_field "${agent_public_contract_json}" "content_type")"
agent_public_transport_error="$(json_field "${agent_public_contract_json}" "transport_error")"
agent_prod_commit="$(json_field "${agent_public_contract_json}" "service_version_commit")"
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
gateway_governance_local_status="$(step_status gateway_governance_local_gate)"
prod_smoke_status="$(step_status commerce_core_production_smoke)"
gateway_governance_extract_status="$(step_status gateway_governance_shadow_extract)"
gateway_governance_report_status="$(step_status gateway_governance_shadow_report)"

prompt_intent_status="red"
query_decomposition_status="red"
commerce_search_status="red"
merchant_product_status="red"
fallback_resilience_status="red"
gateway_governance_status="red"
provenance_status="amber"
drift_status="red"
public_gateway_auth_required="false"
supported_prod_smoke_requested="false"
prod_smoke_auth_configured="false"
prod_smoke_endpoint="${COMMERCE_CORE_PROD_SMOKE_ENDPOINT}"

if [[ -n "${COMMERCE_CORE_PROD_AUTH_TOKEN}" || -n "${COMMERCE_CORE_PROD_AGENT_API_KEY}" ]]; then
  prod_smoke_auth_configured="true"
fi

if [[ -z "${prod_smoke_endpoint}" ]]; then
  if [[ "${prod_smoke_auth_configured}" == "true" ]]; then
    prod_smoke_endpoint="/agent/shop/v1/invoke"
  else
    prod_smoke_endpoint="/api/gateway"
  fi
fi

if [[ "${agent_public_contract_status}" == "401" && "${agent_public_contract_error}" == "UNAUTHORIZED" ]]; then
  public_gateway_auth_required="true"
fi

if [[ "${prod_smoke_endpoint}" == "/agent/shop/v1/invoke" && "${prod_smoke_auth_configured}" == "true" ]]; then
  supported_prod_smoke_requested="true"
fi

prod_smoke_matrix_json="$(json_file_field "${RUN_DIR}/commerce_core_production_smoke.log" "json")"
prod_smoke_primary_service_commit="$(
  python3 - "${prod_smoke_matrix_json}" <<'PY'
import json
import pathlib
import sys

json_path = pathlib.Path(sys.argv[1])
if not json_path.exists():
    raise SystemExit(0)
try:
    data = json.loads(json_path.read_text())
except Exception:
    raise SystemExit(0)

values = []
for row in data.get("rows", []):
    if not isinstance(row, dict):
        continue
    value = str(row.get("service_commit") or "").strip()
    if value and value not in values:
        values.append(value)
if values:
    print(values[0])
PY
)"
prod_smoke_failing_case_ids="$(
  python3 - "${prod_smoke_matrix_json}" <<'PY'
import json
import pathlib
import sys

json_path = pathlib.Path(sys.argv[1])
if not json_path.exists():
    raise SystemExit(0)
try:
    data = json.loads(json_path.read_text())
except Exception:
    raise SystemExit(0)

case_ids = []
for row in data.get("rows", []):
    if not isinstance(row, dict):
        continue
    if row.get("gate_passed") is True:
        continue
    case_id = str(row.get("case_id") or "").strip()
    if case_id and case_id not in case_ids:
        case_ids.append(case_id)
if case_ids:
    print(",".join(case_ids))
PY
)"
prod_smoke_primary_commit_on_origin_main="$(git_commit_on_origin_main "${AGENT_CLEAN_REPO}" "${prod_smoke_primary_service_commit}")"

if [[ "${shopping_local_status}" == "pass" ]]; then
  prompt_intent_status="amber"
  query_decomposition_status="amber"
fi

if [[ "${public_local_status}" == "pass" && "${prod_smoke_status}" == "pass" ]]; then
  commerce_search_status="green"
elif [[ "${public_local_status}" == "pass" && "${public_gateway_auth_required}" == "true" && "${supported_prod_smoke_requested}" != "true" ]]; then
  commerce_search_status="amber"
fi
if [[ "${aurora_local_status}" == "pass" && "${prod_smoke_status}" == "pass" && "${supported_prod_smoke_requested}" == "true" ]]; then
  merchant_product_status="green"
elif [[ "${aurora_local_status}" == "pass" && "${supported_prod_smoke_requested}" == "true" ]]; then
  merchant_product_status="red"
elif [[ "${aurora_local_status}" == "pass" && "${prod_smoke_status}" == "pass" ]]; then
  merchant_product_status="amber"
elif [[ "${aurora_local_status}" == "pass" && "${public_gateway_auth_required}" == "true" ]]; then
  merchant_product_status="amber"
fi
if [[ "${shopping_local_status}" == "pass" && "${aurora_local_status}" == "pass" && "${prod_smoke_status}" == "pass" ]]; then
  fallback_resilience_status="amber"
  drift_status="amber"
elif [[ "${shopping_local_status}" == "pass" && "${aurora_local_status}" == "pass" && "${public_gateway_auth_required}" == "true" && "${supported_prod_smoke_requested}" != "true" ]]; then
  fallback_resilience_status="amber"
  drift_status="amber"
fi
if [[ "${supported_prod_smoke_requested}" == "true" && "${prod_smoke_primary_commit_on_origin_main}" == "false" ]]; then
  drift_status="red"
fi
if [[ "${gateway_governance_local_status}" == "pass" && "${gateway_governance_report_status}" == "pass" ]]; then
  gateway_governance_status="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "readiness_status")"
  if [[ -z "${gateway_governance_status}" ]]; then
    gateway_governance_status="amber"
  fi
fi
if [[ -n "${agent_prod_commit}" && -n "${backend_prod_commit}" && "${backend_prod_service}" == "pivota-backend" && "${gateway_governance_report_status}" == "pass" ]]; then
  provenance_status="green"
fi

gateway_governance_total_scenarios="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "total_scenarios")"
gateway_governance_matched_scenarios="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "matched_scenarios")"
gateway_governance_would_enforce="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "coverage.would_enforce_count")"
gateway_governance_runtime_sample_path="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "runtime_sample_path")"
gateway_governance_runtime_total_events="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "runtime_samples.total_events")"
gateway_governance_runtime_shadow_events="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "runtime_samples.shadow_events")"
gateway_governance_runtime_non_shadow_events="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "runtime_samples.non_shadow_events")"
gateway_governance_runtime_would_enforce="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "runtime_samples.coverage.would_enforce_count")"
gateway_governance_runtime_blocked="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "runtime_samples.coverage.blocked_or_throttled_observed_count")"
gateway_governance_runtime_downgraded="$(json_file_field "${GATEWAY_GOVERNANCE_REPORT_JSON}" "runtime_samples.coverage.downgraded_or_truncated_observed_count")"

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
  echo "- Agent public probe \`http_status\`: \`${agent_public_contract_status:-missing}\`"
  echo "- Agent public probe \`error\`: \`${agent_public_contract_error:-missing}\`"
  echo "- Agent public probe \`message\`: \`${agent_public_contract_message:-missing}\`"
  echo "- Agent public probe \`content_type\`: \`${agent_public_contract_content_type:-missing}\`"
  echo "- Supported prod smoke endpoint: \`${prod_smoke_endpoint}\`"
  echo "- Supported prod smoke auth configured: \`${prod_smoke_auth_configured}\`"
  echo "- Supported invoke smoke requested: \`${supported_prod_smoke_requested}\`"
  echo "- Supported prod smoke matrix JSON: \`${prod_smoke_matrix_json:-missing}\`"
  echo "- Supported prod smoke service commit: \`${prod_smoke_primary_service_commit:-missing}\`"
  echo "- Supported prod smoke commit on \`origin/main\`: \`${prod_smoke_primary_commit_on_origin_main:-unknown}\`"
  echo "- Supported prod smoke failing cases: \`${prod_smoke_failing_case_ids:-none}\`"
  if [[ -n "${agent_public_transport_error}" ]]; then
    echo "- Agent public probe transport error: \`${agent_public_transport_error}\`"
  fi
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
  echo "## Gateway Governance Shadow Summary"
  echo
  echo "- Local gate: ${gateway_governance_local_status}"
  echo "- Report generation: ${gateway_governance_report_status}"
  if [[ "${gateway_governance_extract_status}" != "missing" ]]; then
    echo "- Runtime extract step: ${gateway_governance_extract_status}"
  fi
  echo "- Readiness status: ${gateway_governance_status:-missing}"
  echo "- Matched scenarios: ${gateway_governance_matched_scenarios:-0}/${gateway_governance_total_scenarios:-0}"
  echo "- Would-enforce scenarios: ${gateway_governance_would_enforce:-0}"
  echo "- Runtime sample path: \`${gateway_governance_runtime_sample_path:-not_provided}\`"
  echo "- Runtime total events: ${gateway_governance_runtime_total_events:-0}"
  echo "- Runtime shadow events: ${gateway_governance_runtime_shadow_events:-0}"
  echo "- Runtime non-shadow events: ${gateway_governance_runtime_non_shadow_events:-0}"
  echo "- Runtime would-enforce shadow events: ${gateway_governance_runtime_would_enforce:-0}"
  echo "- Runtime blocked/throttled shadow events: ${gateway_governance_runtime_blocked:-0}"
  echo "- Runtime downgraded/truncated shadow events: ${gateway_governance_runtime_downgraded:-0}"
  echo "- Markdown artifact: \`${GATEWAY_GOVERNANCE_REPORT_MD}\`"
  echo "- JSON artifact: \`${GATEWAY_GOVERNANCE_REPORT_JSON}\`"
  echo
  echo "## Scorecard"
  echo
  echo "| Dimension | Status | Primary blocker |"
  echo "| --- | --- | --- |"
  echo "| Prompt/Intent Readiness | ${prompt_intent_status} | $( if [[ "${prompt_intent_status}" == "green" ]]; then echo "none"; elif [[ "${prompt_intent_status}" == "amber" ]]; then echo "shopping-agent prompt/loop-break contract is testable locally, but not yet backed by stable live prompt fixtures"; else echo "shopping_agent helper/query-rewrite gate failing"; fi ) |"
  echo "| Query Decomposition Readiness | ${query_decomposition_status} | $( if [[ "${query_decomposition_status}" == "green" ]]; then echo "none"; elif [[ "${query_decomposition_status}" == "amber" ]]; then echo "merchant vs product decomposition still lacks a canonical live acceptance corpus"; else echo "scenario clarify/query rewrite contract incomplete"; fi ) |"
  echo "| Commerce Search Contract Readiness | ${commerce_search_status} | $( if [[ "${commerce_search_status}" == "green" ]]; then echo "none"; elif [[ "${commerce_search_status}" == "amber" ]]; then echo "supported authenticated invoke smoke was not configured in this run; public /api/gateway is auth-gated and retained only for observability"; else echo "supported authenticated invoke smoke or local contract gate failing"; fi ) |"
  echo "| Merchant/Product Routing Readiness | ${merchant_product_status} | $( if [[ "${merchant_product_status}" == "green" ]]; then echo "none"; elif [[ "${merchant_product_status}" == "amber" ]]; then echo "authenticated invoke smoke is not configured, so live merchant-style and exact-lookup routing cannot both be promoted to the shared gate"; else echo "shared authenticated smoke is failing merchant-style or exact product routing on the supported invoke rail"; fi ) |"
  echo "| Fallback/Resilience Readiness | ${fallback_resilience_status} | $( if [[ "${fallback_resilience_status}" == "green" ]]; then echo "none"; elif [[ "${fallback_resilience_status}" == "amber" ]]; then echo "authenticated invoke smoke covers broad and clarify-required behavior when configured, but exact lookup fallback still is not deterministic enough for shared production smoke"; else echo "cross-layer fallback/strict path not fully covered"; fi ) |"
  echo "| Gateway Invocation/Access Governance Readiness | ${gateway_governance_status} | $( if [[ "${gateway_governance_status}" == "green" ]]; then echo "none"; elif [[ "${gateway_governance_status}" == "amber" ]]; then echo "shadow summary exists but baseline mismatches remain"; else echo "gateway governance gate/report missing or failing"; fi ) |"
  echo "| Observability/Provenance Readiness | ${provenance_status} | $( if [[ "${provenance_status}" == "green" ]]; then echo "none"; else echo "authenticated invoke smoke is instrumented, but public provenance remains auth-gated and daily runtime governance export is not yet automated"; fi ) |"
  echo "| Cross-layer Contract Drift Risk | ${drift_status} | $( if [[ "${drift_status}" == "green" ]]; then echo "none"; elif [[ "${drift_status}" == "amber" ]]; then echo "supported invoke semantics are the primary contract; public probe remains separately observable and cross-layer ownership is still coordinated across multiple modules"; elif [[ "${prod_smoke_primary_commit_on_origin_main}" == "false" ]]; then echo "supported invoke smoke is hitting a deployed commit that is not traceable to origin/main"; else echo "source contracts and supported invoke semantics still diverge"; fi ) |"
  echo
  echo "## Next Fixes"
  echo
  echo "1. Treat authenticated \`/agent/shop/v1/invoke\` as the supported commerce contract and retire public \`/api/gateway\` from shared commerce acceptance."
  echo "2. Keep \`search\`, \`shopping_agent\`, and \`aurora-bff\` contract fixtures in one shared authenticated prod smoke so future drift is visible immediately."
  echo "3. Add stable live prompt fixtures for \`/ui/chat\` so shopping-agent prompt understanding can graduate from local helper coverage to true end-to-end coverage."
  echo "4. Automate daily export of production gateway governance logs and pass the raw file via \`GATEWAY_GOVERNANCE_LOG_INPUT_PATH\` so the readiness report stays on real traffic without manual sample prep."
  echo "5. Keep exact \`shopping_agent\` lookup in the shared authenticated smoke and close any remaining production drift before expanding that live rail to additional source contracts."
  echo "6. Restore GitHub \`main\` as the production source-of-truth before treating supported invoke smoke drift as an ordinary contract regression."
  echo "7. If Aurora guidance-only remains unstable, treat it as a dedicated hardening track instead of folding it into general commerce acceptance."
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
    "agent_public_probe": {
        "http_status": "${agent_public_contract_status}",
        "error": "${agent_public_contract_error}",
        "message": "${agent_public_contract_message}",
        "content_type": "${agent_public_contract_content_type}",
        "transport_error": "${agent_public_transport_error}",
    },
    "supported_prod_smoke": {
        "endpoint": "${prod_smoke_endpoint}",
        "auth_configured": "${prod_smoke_auth_configured}",
        "requested": "${supported_prod_smoke_requested}",
        "matrix_json": "${prod_smoke_matrix_json}",
        "service_commit": "${prod_smoke_primary_service_commit}",
        "commit_on_origin_main": "${prod_smoke_primary_commit_on_origin_main}",
        "failing_case_ids": "${prod_smoke_failing_case_ids}"
    },
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
        "gateway_invocation_access_governance": "${gateway_governance_status}",
        "observability_provenance": "${provenance_status}",
        "cross_layer_contract_drift": "${drift_status}",
    },
    "gateway_governance_shadow": {
        "local_gate": "${gateway_governance_local_status}",
        "extract_step": "${gateway_governance_extract_status}",
        "report_generation": "${gateway_governance_report_status}",
        "readiness_status": "${gateway_governance_status}",
        "total_scenarios": "${gateway_governance_total_scenarios}",
        "matched_scenarios": "${gateway_governance_matched_scenarios}",
        "would_enforce_count": "${gateway_governance_would_enforce}",
        "runtime_sample_path": "${gateway_governance_runtime_sample_path}",
        "runtime_total_events": "${gateway_governance_runtime_total_events}",
        "runtime_shadow_events": "${gateway_governance_runtime_shadow_events}",
        "runtime_non_shadow_events": "${gateway_governance_runtime_non_shadow_events}",
        "runtime_would_enforce_count": "${gateway_governance_runtime_would_enforce}",
        "runtime_blocked_or_throttled_count": "${gateway_governance_runtime_blocked}",
        "runtime_downgraded_or_truncated_count": "${gateway_governance_runtime_downgraded}",
        "markdown_path": "${GATEWAY_GOVERNANCE_REPORT_MD}",
        "json_path": "${GATEWAY_GOVERNANCE_REPORT_JSON}",
    },
}
summary_path.write_text(json.dumps(summary, indent=2))
PY

echo "Commerce core readiness report: ${REPORT_MD}"
