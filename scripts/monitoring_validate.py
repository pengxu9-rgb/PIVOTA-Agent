#!/usr/bin/env python3
"""Validate monitoring assets for Aurora diagnosis runtime."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence


REQUIRED_ALERTS = (
    "AuroraHttp5xxRateHigh",
    "AuroraHttpTimeoutRateHigh",
    "AuroraVerifyFailSpike",
    "AuroraVerifyBudgetGuardTriggered",
    "AuroraQualityFailRateSpike",
    "AuroraGeometryDropRateSpike",
    "AuroraSkinRecoGeneratedRateLow",
    "AuroraSkinLowConfidenceRateHigh",
    "AuroraSkinSafetyBlockRateHigh",
    "AuroraChatProxyFallbackRateHigh",
)

REQUIRED_RECORDING_RULES = (
    "aurora:quality_fail_rate:15m",
    "aurora:quality_degraded_rate:15m",
    "aurora:geometry_sanitizer_drop_rate:15m",
    "aurora:verify_budget_guard_count:15m",
    "aurora:skin_reco_request_rate:15m",
    "aurora:skin_reco_generated_rate:15m",
    "aurora:skin_low_confidence_rate:15m",
    "aurora:skin_safety_block_rate:15m",
    "aurora:chat_proxy_fallback_rate:5m",
)

KB_V0_REQUIRED_ALERTS = (
    "AuroraKbV0LoaderErrorDetected",
    "AuroraKbV0LegacyFallbackRatioHigh",
    "AuroraKbV0RuleMatchSpike",
    "AuroraKbV0ClimateFallbackSpike",
)

KB_V0_REQUIRED_RECORDING_RULES = (
    "aurora:kb_v0_loader_error_increase:5m",
    "aurora:kb_v0_rule_match_rate:5m",
    "aurora:kb_v0_rule_match_rate:30m",
    "aurora:kb_v0_legacy_fallback_rate:5m",
    "aurora:kb_v0_legacy_fallback_ratio:5m",
    "aurora:kb_v0_climate_fallback_increase:10m",
    "aurora:kb_v0_climate_fallback_warn_threshold:10m",
)

REQUIRED_METRICS = (
    "analyze_requests_total",
    "geometry_sanitizer_drop_total",
    "geometry_sanitizer_clip_total",
    "geometry_sanitizer_drop_rate",
    "verify_calls_total",
    "verify_fail_total",
    "verify_budget_guard_total",
    "aurora_skin_flow_total",
    "aurora_skin_reco_generated_rate",
    "aurora_skin_reco_low_confidence_rate",
    "aurora_skin_reco_safety_block_rate",
    "aurora_kb_v0_loader_error_total",
    "aurora_kb_v0_rule_match_total",
    "aurora_kb_v0_legacy_fallback_total",
    "aurora_kb_v0_climate_fallback_total",
)

REQUIRED_DASHBOARD_EXPR_TOKENS = (
    "pivota_http_requests_total",
    "pivota_http_timeouts_total",
    "verify_calls_total",
    "verify_fail_total",
    "verify_budget_guard_total",
    "analyze_requests_total",
    "geometry_sanitizer_drop_total",
    "aurora:skin_reco_generated_rate:15m",
    "aurora:skin_low_confidence_rate:15m",
    "aurora:skin_safety_block_rate:15m",
    "aurora:chat_proxy_fallback_rate:5m",
)

KB_V0_REQUIRED_DASHBOARD_EXPR_TOKENS = (
    "aurora_kb_v0_loader_error_total",
    "aurora_kb_v0_rule_match_total",
    "aurora_kb_v0_legacy_fallback_total",
    "aurora_kb_v0_climate_fallback_total",
)


@dataclass(frozen=True)
class ValidationError:
    scope: str
    message: str


class Validator:
    def __init__(self) -> None:
        self.errors: List[ValidationError] = []

    def expect(self, condition: bool, scope: str, message: str) -> None:
        if not condition:
            self.errors.append(ValidationError(scope=scope, message=message))

    def expect_subset(self, expected: Iterable[str], actual: Iterable[str], scope: str, label: str) -> None:
        actual_set = set(actual)
        missing = [item for item in expected if item not in actual_set]
        if missing:
            self.errors.append(ValidationError(scope=scope, message=f"missing {label}: {', '.join(missing)}"))


def _extract_rule_names(content: str, key: str) -> Sequence[str]:
    pattern = re.compile(rf"^\s*(?:-\s*)?{re.escape(key)}\s*:\s*([A-Za-z0-9_:.-]+)\s*$", re.MULTILINE)
    return pattern.findall(content)


def _collect_dashboard_expr_tokens(dashboard: dict) -> str:
    parts: List[str] = []
    for panel in dashboard.get("panels", []):
        if not isinstance(panel, dict):
            continue
        for target in panel.get("targets", []):
            if not isinstance(target, dict):
                continue
            expr = target.get("expr")
            if isinstance(expr, str):
                parts.append(expr)
    return "\n".join(parts)


def _extract_metric_names(metrics_text: str) -> Sequence[str]:
    names = []
    for line in metrics_text.splitlines():
        if line.startswith("# HELP "):
            tokens = line.split()
            if len(tokens) >= 3:
                names.append(tokens[2].strip())
    return names


def _render_metrics(repo_root: Path) -> str:
    node_cmd = (
        "const m=require('./src/auroraBff/visionMetrics');"
        "process.stdout.write(m.renderVisionMetricsPrometheus());"
    )
    proc = subprocess.run(
        ["node", "-e", node_cmd],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "failed to render metrics")
    return proc.stdout


def validate(repo_root: Path) -> tuple[list[ValidationError], dict]:
    v = Validator()

    alerts_path = repo_root / "monitoring" / "alerts" / "aurora_diagnosis_rules.yml"
    dashboard_path = repo_root / "monitoring" / "dashboards" / "aurora_diagnosis_overview.grafana.json"
    runbook_path = repo_root / "docs" / "MONITORING_RUNBOOK.md"
    kb_alerts_path = repo_root / "monitoring" / "alerts" / "aurora_kb_v0_rules.yml"
    kb_dashboard_path = repo_root / "monitoring" / "dashboards" / "aurora_kb_v0_overview.grafana.json"
    kb_runbook_path = repo_root / "docs" / "runbooks" / "aurora_kb_v0.md"
    kb_release_checklist_path = repo_root / "docs" / "runbooks" / "aurora_kb_v0_release_checklist.md"

    v.expect(alerts_path.exists(), "alerts", f"missing file: {alerts_path}")
    v.expect(dashboard_path.exists(), "dashboard", f"missing file: {dashboard_path}")
    v.expect(runbook_path.exists(), "runbook", f"missing file: {runbook_path}")
    v.expect(kb_alerts_path.exists(), "kb_v0_alerts", f"missing file: {kb_alerts_path}")
    v.expect(kb_dashboard_path.exists(), "kb_v0_dashboard", f"missing file: {kb_dashboard_path}")
    v.expect(kb_runbook_path.exists(), "kb_v0_runbook", f"missing file: {kb_runbook_path}")
    v.expect(
        kb_release_checklist_path.exists(),
        "kb_v0_release_checklist",
        f"missing file: {kb_release_checklist_path}",
    )

    alerts_content = ""
    dashboard_obj: dict = {}
    kb_alerts_content = ""
    kb_dashboard_obj: dict = {}

    if alerts_path.exists():
        alerts_content = alerts_path.read_text(encoding="utf-8")
        alert_names = _extract_rule_names(alerts_content, "alert")
        record_names = _extract_rule_names(alerts_content, "record")
        v.expect_subset(REQUIRED_ALERTS, alert_names, "alerts", "alert rules")
        v.expect_subset(REQUIRED_RECORDING_RULES, record_names, "alerts", "recording rules")
        v.expect(
            "geometry_sanitizer_drop_total" in alerts_content and "analyze_requests_total" in alerts_content,
            "alerts",
            "geometry drop-rate rule must use geometry_sanitizer_drop_total and analyze_requests_total",
        )
        v.expect(
            "increase(verify_budget_guard_total[15m])" in alerts_content,
            "alerts",
            "verify budget guard recording rule must use verify_budget_guard_total",
        )
        v.expect(
            'verify_fail_total{reason="VERIFY_BUDGET_GUARD"}' not in alerts_content,
            "alerts",
            "legacy verify_fail_total{reason=\"VERIFY_BUDGET_GUARD\"} rule should not be used",
        )

    if dashboard_path.exists():
        try:
            dashboard_obj = json.loads(dashboard_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            v.expect(False, "dashboard", f"invalid JSON: {exc}")
        else:
            v.expect(isinstance(dashboard_obj.get("panels"), list), "dashboard", "dashboard.panels must be a list")
            expr_blob = _collect_dashboard_expr_tokens(dashboard_obj)
            for token in REQUIRED_DASHBOARD_EXPR_TOKENS:
                v.expect(token in expr_blob, "dashboard", f"missing token in panel queries: {token}")
            v.expect(
                'verify_fail_total{reason="VERIFY_BUDGET_GUARD"}' not in expr_blob,
                "dashboard",
                "budget guard panel must use verify_budget_guard_total instead of verify_fail_total reason",
            )

    if kb_alerts_path.exists():
        kb_alerts_content = kb_alerts_path.read_text(encoding="utf-8")
        kb_alert_names = _extract_rule_names(kb_alerts_content, "alert")
        kb_record_names = _extract_rule_names(kb_alerts_content, "record")
        v.expect_subset(KB_V0_REQUIRED_ALERTS, kb_alert_names, "kb_v0_alerts", "alert rules")
        v.expect_subset(KB_V0_REQUIRED_RECORDING_RULES, kb_record_names, "kb_v0_alerts", "recording rules")
        v.expect(
            "aurora:kb_v0_legacy_fallback_ratio:5m > 0.05" in kb_alerts_content,
            "kb_v0_alerts",
            "legacy fallback ratio threshold must be 5%",
        )
        v.expect(
            "runbook: \"docs/runbooks/aurora_kb_v0.md\"" in kb_alerts_content,
            "kb_v0_alerts",
            "KB v0 alerts must point to docs/runbooks/aurora_kb_v0.md",
        )

    if kb_dashboard_path.exists():
        try:
            kb_dashboard_obj = json.loads(kb_dashboard_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            v.expect(False, "kb_v0_dashboard", f"invalid JSON: {exc}")
        else:
            v.expect(isinstance(kb_dashboard_obj.get("panels"), list), "kb_v0_dashboard", "dashboard.panels must be a list")
            kb_expr_blob = _collect_dashboard_expr_tokens(kb_dashboard_obj)
            for token in KB_V0_REQUIRED_DASHBOARD_EXPR_TOKENS:
                v.expect(token in kb_expr_blob, "kb_v0_dashboard", f"missing token in panel queries: {token}")
            templating = kb_dashboard_obj.get("templating", {})
            templating_list = templating.get("list", []) if isinstance(templating, dict) else []
            templating_names = [
                item.get("name")
                for item in templating_list
                if isinstance(item, dict) and isinstance(item.get("name"), str)
            ]
            v.expect_subset(("service", "env"), templating_names, "kb_v0_dashboard", "templating variables")

    metrics_text = ""
    try:
        metrics_text = _render_metrics(repo_root)
    except Exception as exc:
        v.expect(False, "metrics", f"failed to render /metrics payload: {exc}")

    metric_names = _extract_metric_names(metrics_text)
    v.expect_subset(REQUIRED_METRICS, metric_names, "metrics", "exported metric names")

    summary = {
        "alerts_file": str(alerts_path.relative_to(repo_root)),
        "dashboard_file": str(dashboard_path.relative_to(repo_root)),
        "runbook_file": str(runbook_path.relative_to(repo_root)),
        "kb_v0_alerts_file": str(kb_alerts_path.relative_to(repo_root)),
        "kb_v0_dashboard_file": str(kb_dashboard_path.relative_to(repo_root)),
        "kb_v0_runbook_file": str(kb_runbook_path.relative_to(repo_root)),
        "kb_v0_release_checklist_file": str(kb_release_checklist_path.relative_to(repo_root)),
        "alerts_found": _extract_rule_names(alerts_content, "alert") if alerts_content else [],
        "recording_rules_found": _extract_rule_names(alerts_content, "record") if alerts_content else [],
        "kb_v0_alerts_found": _extract_rule_names(kb_alerts_content, "alert") if kb_alerts_content else [],
        "kb_v0_recording_rules_found": _extract_rule_names(kb_alerts_content, "record") if kb_alerts_content else [],
        "metrics_found": metric_names,
        "errors": [{"scope": err.scope, "message": err.message} for err in v.errors],
    }
    return v.errors, summary


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate monitoring alert/dashboard assets")
    parser.add_argument("--out", default="out/monitoring_validate.json", help="JSON summary output path")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    errors, summary = validate(repo_root)

    out_path = repo_root / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if errors:
        for err in errors:
            print(f"[FAIL] {err.scope}: {err.message}")
        print(f"[FAIL] monitoring validation failed ({len(errors)} issue(s)); summary: {out_path}")
        return 1

    print(f"[PASS] monitoring validation passed; summary: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
