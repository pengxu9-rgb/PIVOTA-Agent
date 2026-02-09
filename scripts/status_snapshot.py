#!/usr/bin/env python3
"""Generate a machine-readable implementation status snapshot for Aurora diagnosis."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Dict, List, Optional


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def parse_release_gate(path: Path) -> Dict[str, object]:
    text = read_text(path)
    result: Dict[str, object] = {
        "exists": path.exists(),
        "generated_at": None,
        "verdict": None,
        "checks": {},
    }
    if not text:
        return result

    generated_match = re.search(r"^- Generated at:\s*`([^`]+)`", text, flags=re.M)
    verdict_match = re.search(r"^- Verdict:\s*\*\*([A-Z]+)\*\*", text, flags=re.M)
    if generated_match:
        result["generated_at"] = generated_match.group(1).strip()
    if verdict_match:
        result["verdict"] = verdict_match.group(1).strip()

    checks: Dict[str, str] = {}
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 4:
            continue
        name = parts[1]
        status = parts[2]
        if not name or name in {"check", "verdict"} or status == "status":
            continue
        status_clean = status.replace("*", "").strip()
        if status_clean in {"PASS", "FAIL", "MISSING"}:
            checks[name] = status_clean
    result["checks"] = checks
    return result


def parse_metric_names(path: Path) -> List[str]:
    text = read_text(path)
    if not text:
        return []

    names = set()
    for pattern in [r"# HELP\s+([a-zA-Z0-9_]+)", r"renderCounter\(lines,\s*'([a-zA-Z0-9_]+)'"]:
        for match in re.finditer(pattern, text):
            names.add(match.group(1))

    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("lines.push(`"):
            continue
        match = re.search(r"`([a-zA-Z0-9_]+)(?:\{|\s)", line)
        if match:
            names.add(match.group(1))

    return sorted(names)


def extract_bool_default(path: Path, flag: str) -> Optional[bool]:
    text = read_text(path)
    if not text:
        return None

    match = re.search(rf"boolEnv\('{re.escape(flag)}',\s*(true|false)\)", text)
    if match:
        return match.group(1) == "true"

    match = re.search(rf"parseBool\(process\.env\.{re.escape(flag)},\s*(true|false)\)", text)
    if match:
        return match.group(1) == "true"

    match = re.search(
        rf"process\.env\.{re.escape(flag)}\s*\|\|\s*'([^']+)'\)\.toLowerCase\(\)\s*!==\s*'false'",
        text,
    )
    if match:
        default_token = match.group(1).strip().lower()
        return default_token != "false"

    return None


def extract_number_default(path: Path, flag: str) -> Optional[float]:
    text = read_text(path)
    if not text:
        return None

    match = re.search(rf"numEnv\('{re.escape(flag)}',\s*([0-9]+(?:\.[0-9]+)?)", text)
    if match:
        value = float(match.group(1))
        return int(value) if value.is_integer() else value

    match = re.search(rf"process\.env\.{re.escape(flag)}\s*\|\|\s*([0-9]+(?:\.[0-9]+)?)", text)
    if match:
        value = float(match.group(1))
        return int(value) if value.is_integer() else value

    return None


def extract_string_default(path: Path, flag: str) -> Optional[str]:
    text = read_text(path)
    if not text:
        return None

    match = re.search(rf"process\.env\.{re.escape(flag)}\s*\|\|\s*'([^']+)'", text)
    if match:
        return match.group(1)

    match = re.search(rf"process\.env\.{re.escape(flag)}[^\n]*\|\|\s*'([^']+)'", text)
    if match:
        return match.group(1)

    return None


def flag_defaults(repo_root: Path) -> Dict[str, object]:
    routes = repo_root / "src/auroraBff/routes.js"
    ensemble = repo_root / "src/auroraBff/diagEnsemble.js"
    verify = repo_root / "src/auroraBff/diagVerify.js"
    calibration = repo_root / "src/auroraBff/diagCalibration.js"
    pseudo = repo_root / "src/auroraBff/pseudoLabelFactory.js"

    return {
        "AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM": extract_bool_default(routes, "AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM"),
        "AURORA_PHOTO_DOWNLOAD_URL_TIMEOUT_MS": extract_number_default(routes, "AURORA_PHOTO_DOWNLOAD_URL_TIMEOUT_MS"),
        "AURORA_PHOTO_FETCH_TIMEOUT_MS": extract_number_default(routes, "AURORA_PHOTO_FETCH_TIMEOUT_MS"),
        "AURORA_PHOTO_FETCH_RETRIES": extract_number_default(routes, "AURORA_PHOTO_FETCH_RETRIES"),
        "DIAG_ENSEMBLE": extract_bool_default(ensemble, "DIAG_ENSEMBLE"),
        "DIAG_ENSEMBLE_GEMINI_ENABLED": extract_bool_default(ensemble, "DIAG_ENSEMBLE_GEMINI_ENABLED"),
        "DIAG_ENSEMBLE_GPT_ENABLED": extract_bool_default(ensemble, "DIAG_ENSEMBLE_GPT_ENABLED"),
        "DIAG_GEMINI_VERIFY": extract_bool_default(verify, "DIAG_GEMINI_VERIFY"),
        "DIAG_GEMINI_VERIFY_IOU_THRESHOLD": extract_number_default(verify, "DIAG_GEMINI_VERIFY_IOU_THRESHOLD"),
        "DIAG_GEMINI_VERIFY_TIMEOUT_MS": extract_number_default(verify, "DIAG_GEMINI_VERIFY_TIMEOUT_MS"),
        "DIAG_GEMINI_VERIFY_RETRIES": extract_number_default(verify, "DIAG_GEMINI_VERIFY_RETRIES"),
        "DIAG_GEMINI_VERIFY_HARD_CASE_THRESHOLD": extract_number_default(verify, "DIAG_GEMINI_VERIFY_HARD_CASE_THRESHOLD"),
        "DIAG_GEMINI_VERIFY_MODEL": extract_string_default(verify, "DIAG_GEMINI_VERIFY_MODEL"),
        "DIAG_CALIBRATION_ENABLED": extract_bool_default(calibration, "DIAG_CALIBRATION_ENABLED"),
        "DIAG_CALIBRATION_MODEL_PATH": "model_registry/diag_calibration_v1.json",
        "AURORA_PSEUDO_LABEL_ENABLED": extract_bool_default(pseudo, "AURORA_PSEUDO_LABEL_ENABLED"),
        "AURORA_PSEUDO_LABEL_ALLOW_ROI": extract_bool_default(pseudo, "AURORA_PSEUDO_LABEL_ALLOW_ROI"),
    }


def route_presence(repo_root: Path) -> Dict[str, bool]:
    routes_text = read_text(repo_root / "src/auroraBff/routes.js")
    ui_events_text = read_text(repo_root / "src/telemetry/uiEvents.js")
    return {
        "metrics_route": "app.get('/metrics'" in routes_text,
        "ui_events_route": "app.post('/v1/events'" in ui_events_text,
    }


def key_file_presence(repo_root: Path) -> Dict[str, bool]:
    candidates = {
        "release_gate": repo_root / "RELEASE_GATE.md",
        "stability_report": repo_root / "artifacts/stability_report.json",
        "loadtest_report": repo_root / "artifacts/loadtest_report.md",
        "bench_report": repo_root / "artifacts/bench_analyze.json",
        "diag_verify_doc": repo_root / "docs/DIAG_VERIFY.md",
        "aurora_cards_contract": repo_root / "docs/aurora_bff_cards.md",
        "aurora_runbook": repo_root / "docs/aurora_bff_runbook.md",
        "pseudo_label_store_manifest": repo_root / "tmp/diag_pseudo_label_factory/manifest.json",
    }
    return {name: path.exists() for name, path in candidates.items()}


def storage_presence(repo_root: Path) -> Dict[str, bool]:
    return {
        "model_registry_calibration": (repo_root / "model_registry/diag_calibration_v1.json").exists(),
        "pseudo_label_model_outputs": (repo_root / "tmp/diag_pseudo_label_factory/model_outputs.ndjson").exists(),
        "pseudo_label_records": (repo_root / "tmp/diag_pseudo_label_factory/pseudo_labels.ndjson").exists(),
        "pseudo_label_agreement_samples": (repo_root / "tmp/diag_pseudo_label_factory/agreement_samples.ndjson").exists(),
        "hard_cases_queue": (repo_root / "tmp/diag_verify/hard_cases.ndjson").exists(),
    }


def script_presence(repo_root: Path) -> Dict[str, bool]:
    return {
        "run_diag_ensemble": (repo_root / "scripts/run_diag_ensemble.py").exists(),
        "report_agreement": (repo_root / "scripts/report_agreement.py").exists(),
        "eval_calibration": (repo_root / "scripts/eval_calibration.py").exists(),
        "sample_for_labeling": (repo_root / "scripts/sample_for_labeling.py").exists(),
    }


def build_snapshot(repo_root: Path) -> Dict[str, object]:
    release_gate = parse_release_gate(repo_root / "RELEASE_GATE.md")
    metric_names = parse_metric_names(repo_root / "src/auroraBff/visionMetrics.js")

    return {
        "generated_at_utc": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "repo_root": str(repo_root),
        "release_gate": release_gate,
        "key_files": key_file_presence(repo_root),
        "storage": storage_presence(repo_root),
        "scripts": script_presence(repo_root),
        "routes": route_presence(repo_root),
        "metrics": {
            "count": len(metric_names),
            "names": metric_names,
        },
        "flag_defaults": flag_defaults(repo_root),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate repository status snapshot JSON.")
    parser.add_argument("--out", default="status_snapshot.json", help="Output JSON path (default: status_snapshot.json)")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = repo_root / out_path

    snapshot = build_snapshot(repo_root)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
