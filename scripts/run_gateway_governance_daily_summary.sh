#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${OUT_DIR:-${REPO_ROOT}/reports/gateway-governance-daily}"
GATEWAY_GOVERNANCE_LOG_INPUT_PATH="${GATEWAY_GOVERNANCE_LOG_INPUT_PATH:-}"
GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH="${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH:-}"
GATEWAY_GOVERNANCE_ALERT_THRESHOLDS_PATH="${GATEWAY_GOVERNANCE_ALERT_THRESHOLDS_PATH:-}"

timestamp() {
  date -u +"%Y%m%d_%H%M%S"
}

TS="$(timestamp)"
RUN_DIR="${OUT_DIR}/${TS}"
REPORT_MD="${RUN_DIR}/README.md"
SUMMARY_JSON="${RUN_DIR}/summary.json"
SHADOW_SAMPLE_PATH="${RUN_DIR}/gateway_governance_shadow_runtime_sample.ndjson"
GOVERNANCE_REPORT_JSON="${RUN_DIR}/gateway_governance_shadow_summary.json"
GOVERNANCE_REPORT_MD="${RUN_DIR}/gateway_governance_shadow_summary.md"
ALERTS_JSON="${RUN_DIR}/gateway_governance_alerts.json"
ALERTS_MD="${RUN_DIR}/gateway_governance_alerts.md"
mkdir -p "${RUN_DIR}"

if [[ -z "${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}" && -z "${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH}" ]]; then
  echo "either GATEWAY_GOVERNANCE_LOG_INPUT_PATH or GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH is required" >&2
  exit 2
fi

node_bin="$(command -v node || true)"
if [[ -z "${node_bin}" ]]; then
  echo "node is required" >&2
  exit 2
fi

input_sample_path="${GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH}"
extract_status="skipped"
if [[ -n "${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}" ]]; then
  "${node_bin}" "${REPO_ROOT}/scripts/extract_gateway_governance_shadow_sample.js" \
    --input "${GATEWAY_GOVERNANCE_LOG_INPUT_PATH}" \
    --out "${SHADOW_SAMPLE_PATH}" >"${RUN_DIR}/gateway_governance_shadow_extract.log"
  input_sample_path="${SHADOW_SAMPLE_PATH}"
  extract_status="pass"
fi

"${node_bin}" "${REPO_ROOT}/scripts/generate_celestial_commerce_gateway_governance_report.js" \
  --out-dir "${RUN_DIR}" \
  --runtime-sample "${input_sample_path}" >"${RUN_DIR}/gateway_governance_shadow_report.log"

thresholds_path="${GATEWAY_GOVERNANCE_ALERT_THRESHOLDS_PATH:-${REPO_ROOT}/scripts/fixtures/celestial_commerce_gateway_governance_alert_thresholds.json}"
"${node_bin}" "${REPO_ROOT}/scripts/evaluate_celestial_commerce_gateway_governance_alerts.js" \
  --summary "${GOVERNANCE_REPORT_JSON}" \
  --thresholds "${thresholds_path}" \
  --out-dir "${RUN_DIR}" >"${RUN_DIR}/gateway_governance_alerts.log"

python3 - "${REPORT_MD}" "${SUMMARY_JSON}" "${RUN_DIR}" "${extract_status}" "${input_sample_path}" "${thresholds_path}" <<'PY'
import json
import pathlib
import sys

report_md = pathlib.Path(sys.argv[1])
summary_json = pathlib.Path(sys.argv[2])
run_dir = pathlib.Path(sys.argv[3])
extract_status = sys.argv[4]
runtime_sample_path = sys.argv[5]
thresholds_path = sys.argv[6]

shadow_summary = json.loads((run_dir / "gateway_governance_shadow_summary.json").read_text())
alerts = json.loads((run_dir / "gateway_governance_alerts.json").read_text())

lines = []
lines.append("# Gateway Governance Daily Summary")
lines.append("")
lines.append(f"- Run dir: `{run_dir}`")
lines.append(f"- Extract step: {extract_status}")
lines.append(f"- Runtime sample: `{runtime_sample_path}`")
lines.append(f"- Thresholds: `{thresholds_path}`")
lines.append(f"- Shadow readiness status: {shadow_summary.get('readiness_status', 'missing')}")
lines.append(f"- Alert status: {alerts.get('overall_status', 'missing')}")
lines.append("")
lines.append("## Runtime Shadow Snapshot")
lines.append("")
runtime = shadow_summary.get("runtime_samples", {})
lines.append(f"- Shadow events: {runtime.get('shadow_events', 0)}")
lines.append(f"- Would-enforce events: {runtime.get('coverage', {}).get('would_enforce_count', 0)}")
lines.append(f"- Blocked/throttled shadow events: {runtime.get('coverage', {}).get('blocked_or_throttled_observed_count', 0)}")
lines.append(f"- Downgraded/truncated shadow events: {runtime.get('coverage', {}).get('downgraded_or_truncated_observed_count', 0)}")
lines.append("")
lines.append("## Alert Results")
lines.append("")
lines.append("| Rule | Status | Observed | Threshold |")
lines.append("| --- | --- | ---: | --- |")
for alert in alerts.get("alerts", []):
    if alert.get("comparator") == "min":
        threshold = f">= {alert.get('target')}"
    elif alert.get("comparator") == "max":
        threshold = f"<= {alert.get('target')}"
    else:
        threshold = "n/a"
    lines.append(f"| {alert.get('key')} | {alert.get('status')} | {alert.get('observed')} | {threshold} |")
lines.append("")
lines.append("## Artifacts")
lines.append("")
lines.append(f"- Shadow summary markdown: `{run_dir / 'gateway_governance_shadow_summary.md'}`")
lines.append(f"- Shadow summary json: `{run_dir / 'gateway_governance_shadow_summary.json'}`")
lines.append(f"- Alerts markdown: `{run_dir / 'gateway_governance_alerts.md'}`")
lines.append(f"- Alerts json: `{run_dir / 'gateway_governance_alerts.json'}`")
report_md.write_text("\n".join(lines) + "\n")

summary = {
    "run_dir": str(run_dir),
    "extract_status": extract_status,
    "runtime_sample_path": runtime_sample_path,
    "thresholds_path": thresholds_path,
    "shadow_summary": {
        "readiness_status": shadow_summary.get("readiness_status"),
        "runtime_shadow_events": runtime.get("shadow_events", 0),
        "runtime_would_enforce_count": runtime.get("coverage", {}).get("would_enforce_count", 0),
    },
    "alerts": {
        "overall_status": alerts.get("overall_status"),
        "alert_count": sum(1 for item in alerts.get("alerts", []) if item.get("status") != "green"),
        "json_path": str(run_dir / "gateway_governance_alerts.json"),
        "markdown_path": str(run_dir / "gateway_governance_alerts.md"),
    },
}
summary_json.write_text(json.dumps(summary, indent=2) + "\n")
PY

echo "Gateway governance daily summary: ${REPORT_MD}"
