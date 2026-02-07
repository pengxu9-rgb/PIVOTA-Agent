#!/usr/bin/env python3

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from release_gate_discovery import DiscoveryResult, discover_artifact


REPO_ROOT = Path(__file__).resolve().parents[1]


def _now_utc_iso() -> str:
    import datetime as _dt

    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _norm_token(x: Any) -> str:
    return str("" if x is None else x).strip().lower()


def _parse_bool_env(name: str, default: bool = False) -> bool:
    v = _norm_token(os.environ.get(name))
    if not v:
        return default
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _parse_float_env(name: str, default: Optional[float] = None) -> Optional[float]:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        n = float(str(raw).strip())
    except Exception:
        return default
    if not (n == n) or n in (float("inf"), float("-inf")):
        return default
    return n


def _parse_csv_env(name: str, default: Sequence[str]) -> List[str]:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return list(default)
    parts = [p.strip().lower() for p in str(raw).split(",")]
    return [p for p in parts if p]


def _find_first_existing(paths: Sequence[Path]) -> Optional[Path]:
    for p in paths:
        try:
            if p.exists():
                return p
        except Exception:
            continue
    return None


def _fmt_path(path: Optional[Path]) -> str:
    if path is None:
        return ""
    try:
        rel = path.resolve().relative_to(REPO_ROOT.resolve())
        return str(rel)
    except Exception:
        return str(path)


def _read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str  # PASS | FAIL | MISSING
    details_md: str
    source_path: Optional[Path] = None


def _render_kv_table(rows: Sequence[Tuple[str, str]]) -> str:
    out = []
    out.append("| metric | value |")
    out.append("|---|---:|")
    for k, v in rows:
        out.append(f"| {k} | {v} |")
    return "\n".join(out)


def _fmt_iso_utc_from_mtime(ts: float) -> str:
    import datetime as _dt

    return _dt.datetime.utcfromtimestamp(ts).replace(microsecond=0).isoformat() + "Z"


def _render_discovery_md(discovery: DiscoveryResult) -> str:
    # Note: do not include file contents; paths + timestamps only.
    lines: List[str] = []
    lines.append("Scanner:")
    lines.append(f"- repo_root: `{discovery.repo_root}`")
    lines.append(f"- cwd: `{discovery.cwd}`")

    if discovery.override_kind == "arg":
        lines.append(f"- explicit path arg: `{discovery.override_value or ''}`")
    elif discovery.override_kind == "env":
        lines.append(f"- env override: `{discovery.override_name or ''}={discovery.override_value or ''}`")

    if discovery.override_error:
        lines.append(f"- override error: `{discovery.override_error}`")

    if discovery.searched_rel_paths:
        lines.append("- searched well-known paths:")
        for rel in discovery.searched_rel_paths:
            lines.append(f"  - `{rel}`")

    if discovery.searched_patterns:
        lines.append("- searched patterns:")
        for pat in discovery.searched_patterns:
            lines.append(f"  - `{pat}`")

    if discovery.candidates:
        lines.append("- candidates (sorted by mtime desc):")
        for c in discovery.candidates:
            mtime = c.mtime_iso if c.mtime_iso and c.mtime_iso != "(unknown)" else _fmt_iso_utc_from_mtime(c.mtime) if c.mtime >= 0 else "(unknown)"
            extra = f" (error: {c.stat_error})" if c.stat_error else ""
            lines.append(f"  - `{_fmt_path(c.path)}` — `{mtime}`{extra}")

    return "\n".join(lines)


def _bench_check(path: Optional[Path]) -> CheckResult:
    if path is None or not path.exists():
        return CheckResult(
            name="bench",
            status="MISSING",
            details_md="No bench report found. Run `make bench OUT=artifacts/bench_analyze.json`.",
            source_path=path,
        )

    try:
        data = _read_json(path)
    except Exception as e:
        return CheckResult(
            name="bench",
            status="FAIL",
            details_md=f"Failed to parse bench JSON: `{e}`",
            source_path=path,
        )

    summary = data.get("summary") or {}
    payload = data.get("payload") or {}
    qc = _norm_token(payload.get("qc") or "unknown") or "unknown"
    images = payload.get("images") or []
    total_p50 = float(summary.get("total_p50") or 0.0)
    total_p95 = float(summary.get("total_p95") or 0.0)
    n = int(summary.get("n") or 0)
    llm_calls = int(summary.get("llm_calls") or 0)
    failure_rate = float(summary.get("failure_rate") or 0.0)

    outcomes = summary.get("llm_outcomes") or {}
    v = outcomes.get("vision") or {}
    r = outcomes.get("report") or {}
    vision_fail_rate = float(v.get("schema_failure_rate") or 0.0) if isinstance(v, dict) else 0.0
    report_fail_rate = float(r.get("schema_failure_rate") or 0.0) if isinstance(r, dict) else 0.0

    p95_budget_ms = _parse_float_env("RELEASE_BENCH_P95_BUDGET_MS", None)
    fail_rate_budget = _parse_float_env("RELEASE_BENCH_FAILURE_RATE_MAX", 0.05)
    llm_schema_fail_budget = _parse_float_env("RELEASE_BENCH_LLM_SCHEMA_FAIL_MAX", 0.05)
    sanity_min_p95_ms = _parse_float_env("RELEASE_BENCH_MIN_P95_MS", 1.0)

    status = "PASS"
    reasons = []
    if n <= 0:
        status = "FAIL"
        reasons.append("bench report has no samples (summary.n <= 0)")
    if total_p95 <= 0:
        status = "FAIL"
        reasons.append("total_p95_ms <= 0 (bench likely did not run a real pipeline)")
    if qc != "fail" and sanity_min_p95_ms is not None and sanity_min_p95_ms > 0 and 0 < total_p95 < sanity_min_p95_ms:
        status = "FAIL"
        reasons.append(f"suspiciously low total_p95_ms {total_p95:.2f} < sanity_min_p95_ms {sanity_min_p95_ms:.2f}")
    if p95_budget_ms is not None and p95_budget_ms > 0 and total_p95 > p95_budget_ms:
        status = "FAIL"
        reasons.append(f"p95 {total_p95:.2f} ms > budget {p95_budget_ms:.0f} ms")
    if failure_rate > (fail_rate_budget or 0.0):
        status = "FAIL"
        reasons.append(f"failure_rate {failure_rate:.2%} > budget {(fail_rate_budget or 0.0):.2%}")
    if max(vision_fail_rate, report_fail_rate) > (llm_schema_fail_budget or 0.0):
        status = "FAIL"
        reasons.append(
            f"llm_schema_fail_rate max({vision_fail_rate:.2%},{report_fail_rate:.2%}) > budget {(llm_schema_fail_budget or 0.0):.2%}"
        )

    budget_line = []
    budget_line.append(f"- Budget (optional): `RELEASE_BENCH_P95_BUDGET_MS={p95_budget_ms}`")
    budget_line.append(f"- Budget: `RELEASE_BENCH_FAILURE_RATE_MAX={fail_rate_budget}`")
    budget_line.append(f"- Budget: `RELEASE_BENCH_LLM_SCHEMA_FAIL_MAX={llm_schema_fail_budget}`")
    budget_line.append(f"- Sanity: `RELEASE_BENCH_MIN_P95_MS={sanity_min_p95_ms}` (skipped when qc=fail)")

    rows = [
        ("qc", qc),
        ("images", str(len(images)) if isinstance(images, list) else "unknown"),
        ("n", str(n)),
        ("total_p50_ms", f"{total_p50:.2f}"),
        ("total_p95_ms", f"{total_p95:.2f}"),
        ("failure_rate", f"{failure_rate:.2%}"),
        ("llm_calls_total", str(llm_calls)),
        ("vision_schema_fail_rate", f"{vision_fail_rate:.2%}"),
        ("report_schema_fail_rate", f"{report_fail_rate:.2%}"),
    ]
    md = []
    md.append(f"Source: `{_fmt_path(path)}`")
    md.append("")
    md.append(_render_kv_table(rows))
    md.append("")
    md.extend(budget_line)
    if reasons:
        md.append("")
        md.append("Reasons:")
        for r0 in reasons:
            md.append(f"- {r0}")
    return CheckResult(name="bench", status=status, details_md="\n".join(md), source_path=path)


def _stability_check(discovery: DiscoveryResult) -> CheckResult:
    path = discovery.selected.path if discovery.selected else None
    if path is None:
        if discovery.candidates:
            return CheckResult(
                name="stability",
                status="FAIL",
                details_md="Candidates found but none were usable.\n\n" + _render_discovery_md(discovery),
                source_path=None,
            )
        return CheckResult(
            name="stability",
            status="MISSING",
            details_md="No stability report found.\n\n"
            "Run `make stability` (default: writes `artifacts/stability_report.json`).\n\n"
            + _render_discovery_md(discovery),
            source_path=None,
        )
    try:
        exists = path.exists()
    except Exception as e:
        return CheckResult(
            name="stability",
            status="FAIL",
            details_md=f"Selected stability report is not accessible: `{e}`\n\n" + _render_discovery_md(discovery),
            source_path=path,
        )
    if not exists:
        return CheckResult(
            name="stability",
            status="MISSING",
            details_md="Selected stability report path does not exist.\n\n" + _render_discovery_md(discovery),
            source_path=path,
        )

    try:
        data = _read_json(path)
    except Exception as e:
        return CheckResult(
            name="stability",
            status="FAIL",
            details_md=f"Failed to parse stability JSON: `{e}`\n\n" + _render_discovery_md(discovery),
            source_path=path,
        )

    images = data.get("images") or []
    first = images[0] if isinstance(images, list) and images else {}
    issue_stability = first.get("issue_stability") or {}

    ranges: List[float] = []
    for _itype, stab in (issue_stability.items() if isinstance(issue_stability, dict) else []):
        if not isinstance(stab, dict):
            continue
        try:
            r = float(stab.get("severity_score_range"))
        except Exception:
            continue
        if r == r:
            ranges.append(r)

    if not ranges:
        return CheckResult(
            name="stability",
            status="FAIL",
            details_md=f"Source: `{_fmt_path(path)}`\n\nNo `severity_score_range` values found in report.",
            source_path=path,
        )

    worst = max(ranges)
    budget = _parse_float_env("RELEASE_STABILITY_MAX_SEVERITY_SCORE_RANGE", 0.2)
    status = "PASS" if (budget is None or worst <= budget) else "FAIL"

    md = []
    md.append(f"Source: `{_fmt_path(path)}`")
    if discovery.selected is not None:
        md.append(f"- Discovered via: `{discovery.selected_via}`")
        md.append(f"- mtime: `{discovery.selected.mtime_iso}`")
        if discovery.override_error:
            md.append(f"- Override ignored: `{discovery.override_error}`")
    md.append("")
    md.append(_render_kv_table([("worst_severity_score_range", f"{worst:.3f}"), ("budget_max_range", f"{(budget or 0.0):.3f}")]))
    md.append("")
    md.append("- Budget: `RELEASE_STABILITY_MAX_SEVERITY_SCORE_RANGE` (default: `0.2`)")
    return CheckResult(name="stability", status=status, details_md="\n".join(md), source_path=path)


def _loadtest_check(discovery: DiscoveryResult) -> CheckResult:
    path = discovery.selected.path if discovery.selected else None
    if path is None:
        if discovery.candidates:
            return CheckResult(
                name="loadtest",
                status="FAIL",
                details_md="Candidates found but none were usable.\n\n" + _render_discovery_md(discovery),
                source_path=None,
            )
        return CheckResult(
            name="loadtest",
            status="MISSING",
            details_md="No load test report found.\n\n"
            "Run `make loadtest` (default: writes `artifacts/loadtest_report.md`).\n\n"
            + _render_discovery_md(discovery),
            source_path=None,
        )
    try:
        exists = path.exists()
    except Exception as e:
        return CheckResult(
            name="loadtest",
            status="FAIL",
            details_md=f"Selected load test report is not accessible: `{e}`\n\n" + _render_discovery_md(discovery),
            source_path=path,
        )
    if not exists:
        return CheckResult(
            name="loadtest",
            status="MISSING",
            details_md="Selected load test report path does not exist.\n\n" + _render_discovery_md(discovery),
            source_path=path,
        )

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return CheckResult(
            name="loadtest",
            status="FAIL",
            details_md=f"Failed to read load test report: `{e}`\n\n" + _render_discovery_md(discovery),
            source_path=path,
        )

    def _md_table_value(key: str) -> Optional[str]:
        # Example: | p95_ms (ok) | 123.45 |
        m = re.search(rf"^\|\s*{re.escape(key)}\s*\|\s*([0-9.]+)\s*\|", text, re.MULTILINE)
        return m.group(1) if m else None

    p50 = _md_table_value("p50_ms (ok)")
    p95 = _md_table_value("p95_ms (ok)")
    p99 = _md_table_value("p99_ms (ok)")
    err_rate = _md_table_value("error_rate")
    llm_ratio = _md_table_value("llm_called_ratio")
    timeout_degraded = _md_table_value("timeout_degraded_count")

    verdict = None
    budget_ms = None
    m = re.search(r"Budget:\s*p95\s*<=\s*([0-9]+)\s*ms.*\*\*(PASS|FAIL|N/A)\*\*", text)
    if m:
        budget_ms = float(m.group(1))
        verdict = m.group(2)
    else:
        m2 = re.search(r"Budget:\s*\(disabled\)\s*→\s*\*\*(N/A)\*\*", text)
        if m2:
            verdict = "N/A"

    status = "PASS"
    reasons = []
    if verdict == "FAIL":
        status = "FAIL"
        reasons.append("load test budget failed (p95 over budget)")
    elif verdict is None:
        status = "FAIL"
        reasons.append("could not parse budget verdict from report")
    elif verdict == "N/A":
        # Conservative default: treat missing budget as MISSING unless explicitly allowed.
        if _parse_bool_env("RELEASE_GATE_ALLOW_LOADTEST_NO_BUDGET", False):
            status = "PASS"
        else:
            status = "FAIL"
            reasons.append("load test budget disabled (set LOADTEST_P95_BUDGET_MS or pass --p95-budget-ms)")

    rows = []
    if p50 is not None:
        rows.append(("p50_ms_ok", p50))
    if p95 is not None:
        rows.append(("p95_ms_ok", p95))
    if p99 is not None:
        rows.append(("p99_ms_ok", p99))
    if err_rate is not None:
        rows.append(("error_rate", err_rate))
    if timeout_degraded is not None:
        rows.append(("timeout_degraded_count", timeout_degraded))
    if llm_ratio is not None:
        rows.append(("llm_called_ratio", llm_ratio))
    if budget_ms is not None:
        rows.append(("p95_budget_ms", f"{budget_ms:.0f}"))
    if verdict is not None:
        rows.append(("verdict", verdict))

    md = []
    md.append(f"Source: `{_fmt_path(path)}`")
    if discovery.selected is not None:
        md.append(f"- Discovered via: `{discovery.selected_via}`")
        md.append(f"- mtime: `{discovery.selected.mtime_iso}`")
        if discovery.override_error:
            md.append(f"- Override ignored: `{discovery.override_error}`")
    md.append("")
    md.append(_render_kv_table(rows or [("parsed", "no_metrics_found")]))
    if reasons:
        md.append("")
        md.append("Reasons:")
        for r0 in reasons:
            md.append(f"- {r0}")

    return CheckResult(name="loadtest", status=status, details_md="\n".join(md), source_path=path)


def _privacy_check() -> CheckResult:
    # We intentionally re-run the scanner to ensure the current working tree has no leaks.
    try:
        proc = subprocess.run(
            ["python3", str(REPO_ROOT / "scripts" / "log_scan.py"), "--quiet"],
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ},
        )
    except Exception as e:
        return CheckResult(
            name="privacy",
            status="FAIL",
            details_md=f"Failed to execute privacy scan: `{e}`",
            source_path=None,
        )

    if proc.returncode != 0:
        out = (proc.stdout or "").strip()[:2000]
        err = (proc.stderr or "").strip()[:2000]
        msg = out or err or "privacy scan failed"
        return CheckResult(name="privacy", status="FAIL", details_md=f"Privacy scan failed.\n\n```\n{msg}\n```")

    return CheckResult(
        name="privacy",
        status="PASS",
        details_md="Privacy scan OK (`python3 scripts/log_scan.py --quiet`).",
    )


def _overall_verdict(checks: Sequence[CheckResult]) -> Tuple[str, List[str]]:
    allow_missing = _parse_bool_env("RELEASE_GATE_ALLOW_MISSING", False)
    required = set(_parse_csv_env("RELEASE_GATE_REQUIRED", ["bench", "stability", "loadtest", "privacy"]))

    missing = [c.name for c in checks if c.name in required and c.status == "MISSING"]
    failed = [c.name for c in checks if c.status == "FAIL"]

    if failed:
        return ("NO-GO", [f"failed: {', '.join(sorted(set(failed)))}"])
    if missing and not allow_missing:
        return ("NO-GO", [f"missing evidence: {', '.join(sorted(set(missing)))}"])
    return ("GO", ["all required checks passed" + (" (missing allowed)" if missing and allow_missing else "")])


def _render_release_gate_md(checks: Sequence[CheckResult]) -> str:
    verdict, reasons = _overall_verdict(checks)
    lines: List[str] = []
    lines.append("# RELEASE GATE")
    lines.append("")
    lines.append(f"- Generated at: `{_now_utc_iso()}`")
    lines.append(f"- Verdict: **{verdict}**")
    for r in reasons:
        lines.append(f"  - {r}")
    lines.append("")

    lines.append("## Checks")
    lines.append("")
    lines.append("| check | status | source |")
    lines.append("|---|---|---|")
    for c in checks:
        src = f"`{_fmt_path(c.source_path)}`" if c.source_path else ""
        lines.append(f"| {c.name} | **{c.status}** | {src} |")
    lines.append("")

    lines.append("## Details")
    lines.append("")
    for c in checks:
        lines.append(f"### {c.name}")
        lines.append("")
        lines.append(c.details_md.rstrip())
        lines.append("")

    lines.append("## How to run locally")
    lines.append("")
    lines.append("- `make bench OUT=artifacts/bench_analyze.json`")
    lines.append("- `make stability OUT=artifacts/stability_report.json`")
    lines.append("- `make loadtest OUT=artifacts/loadtest_report.md`")
    lines.append("- `make privacy-check`")
    lines.append("- `make runtime-smoke` (optional; hits `BASE` — also checks `/v1/events` ingest)")
    lines.append("")
    lines.append("## Env flags (diagnosis rollout)")
    lines.append("")
    lines.append("- `DIAG_PIPELINE_VERSION=legacy|v2`")
    lines.append("- `DIAG_SHADOW_MODE=true|false`")
    lines.append("- `DIAG_CANARY_PERCENT=0..100`")
    lines.append("- `LLM_KILL_SWITCH=true|false`")
    lines.append("")
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Generate RELEASE_GATE.md from existing bench/loadtest/stability/privacy outputs.")
    ap.add_argument("--bench", type=str, default="", help="Path to bench JSON (default: artifacts/bench_analyze.json if present).")
    ap.add_argument("--stability", type=str, default="", help="Path to stability_report.json (or use env RELEASE_STABILITY_REPORT_PATH; otherwise auto-discovery).")
    ap.add_argument("--loadtest", type=str, default="", help="Path to loadtest_report.md (or use env RELEASE_LOADTEST_REPORT_PATH; otherwise auto-discovery).")
    ap.add_argument("--debug", action="store_true", help="Print artifact discovery candidates (paths + mtimes).")
    ap.add_argument("--out", type=str, default=str(REPO_ROOT / "RELEASE_GATE.md"), help="Output markdown path.")
    args = ap.parse_args(list(argv) if argv is not None else None)

    bench_path = Path(args.bench) if args.bench else _find_first_existing([REPO_ROOT / "artifacts" / "bench_analyze.json", REPO_ROOT / "bench_analyze.json"])
    stability_discovery = discover_artifact(
        name="stability_report",
        repo_root=REPO_ROOT,
        explicit_path=str(args.stability or ""),
        env_override_name="RELEASE_STABILITY_REPORT_PATH",
        default_rel_paths=[
            "stability_report.json",
            "artifacts/stability_report.json",
            "outputs/stability_report.json",
            "scripts/outputs/stability_report.json",
        ],
        patterns=["**/stability_report*.json"],
    )
    loadtest_discovery = discover_artifact(
        name="loadtest_report",
        repo_root=REPO_ROOT,
        explicit_path=str(args.loadtest or ""),
        env_override_name="RELEASE_LOADTEST_REPORT_PATH",
        default_rel_paths=[
            "loadtest_report.md",
            "artifacts/loadtest_report.md",
            "outputs/loadtest_report.md",
            "scripts/outputs/loadtest_report.md",
        ],
        patterns=["**/loadtest_report*.md"],
    )

    if args.debug:
        print("== release gate artifact discovery ==")
        print(f"repo_root={REPO_ROOT}")
        print(f"cwd={Path.cwd().resolve()}")
        print("")
        for d in (stability_discovery, loadtest_discovery):
            print(f"[{d.name}] selected_via={d.selected_via}")
            if d.override_kind == "env":
                print(f"  env_override={d.override_name} value={d.override_value!r} error={d.override_error!r}")
            elif d.override_kind == "arg":
                print(f"  explicit_path={d.override_value!r} error={d.override_error!r}")
            if d.selected is not None:
                print(f"  selected={_fmt_path(d.selected.path)} mtime={d.selected.mtime_iso}")
            else:
                print("  selected=(none)")
            if d.candidates:
                print("  candidates:")
                for c in d.candidates:
                    extra = f" error={c.stat_error!r}" if c.stat_error else ""
                    print(f"    - {_fmt_path(c.path)} mtime={c.mtime_iso} origin={c.origin}{extra}")
            else:
                print("  candidates=(none)")
            print("")

    checks: List[CheckResult] = [
        _bench_check(bench_path),
        _stability_check(stability_discovery),
        _loadtest_check(loadtest_discovery),
        _privacy_check(),
    ]

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = (Path.cwd() / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(_render_release_gate_md(checks), encoding="utf-8")

    print(str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
