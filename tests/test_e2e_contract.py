import difflib
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
NODE_RUNNER = REPO_ROOT / "scripts" / "e2e_local_skin_analyze.cjs"
GOLDEN_PATH = REPO_ROOT / "tests" / "fixtures" / "skin" / "e2e_contract_golden_v1.json"


def _run_node_runner(request_body: Dict[str, Any]) -> Dict[str, Any]:
    proc = subprocess.run(
        ["node", str(NODE_RUNNER)],
        input=json.dumps(request_body, ensure_ascii=False),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
        env={**os.environ},
    )
    if proc.returncode != 0:
        raise AssertionError(
            "local handler runner failed\n"
            f"exit={proc.returncode}\n"
            f"stderr:\n{proc.stderr.strip()}\n"
            f"stdout:\n{proc.stdout.strip()}\n"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as err:
        raise AssertionError(f"runner did not output JSON: {err}\nstdout:\n{proc.stdout}") from err


def _first_card(envelope: Dict[str, Any], card_type: str) -> Optional[Dict[str, Any]]:
    for c in envelope.get("cards") or []:
        if c.get("type") == card_type:
            return c
    return None


def _uniq_str_list(values: List[Any]) -> List[str]:
    out: List[str] = []
    seen = set()
    for v in values:
        if not isinstance(v, str):
            continue
        s = v.strip()
        if not s:
            continue
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out


def _extract_finding_types(analysis_payload: Dict[str, Any]) -> List[str]:
    analysis = analysis_payload.get("analysis")
    if isinstance(analysis, dict):
        findings = analysis.get("findings")
        if isinstance(findings, list):
            types: List[str] = []
            for f in findings:
                if not isinstance(f, dict):
                    continue
                t = f.get("issue_type") or f.get("issueType") or f.get("type")
                if isinstance(t, str) and t.strip():
                    types.append(t.strip())
            if types:
                return sorted(_uniq_str_list(types))

    quality_report = analysis_payload.get("quality_report") or {}
    detector_policy = quality_report.get("detector_policy")
    if isinstance(detector_policy, dict):
        top_issue_types = detector_policy.get("top_issue_types")
        if isinstance(top_issue_types, list):
            return sorted(_uniq_str_list(top_issue_types))

    return []


def _snapshot_from_envelope(envelope: Dict[str, Any]) -> Dict[str, Any]:
    card = _first_card(envelope, "analysis_summary")
    if not card:
        raise AssertionError(f"missing analysis_summary card; card_types={[c.get('type') for c in (envelope.get('cards') or [])]}")

    payload = card.get("payload") or {}
    quality_report = payload.get("quality_report") or {}
    photo_quality = quality_report.get("photo_quality") or {}
    llm = quality_report.get("llm") or {}
    vision = llm.get("vision") or {}
    report = llm.get("report") or {}

    failure_codes = _uniq_str_list(list(photo_quality.get("reasons") or []))
    for fm in card.get("field_missing") or []:
        if isinstance(fm, dict) and isinstance(fm.get("reason"), str) and fm.get("reason").strip():
            failure_codes.append(fm["reason"].strip())
    failure_codes = sorted(_uniq_str_list(failure_codes))

    return {
        "analysis_source": payload.get("analysis_source"),
        "quality_grade": photo_quality.get("grade"),
        "failure_codes": failure_codes,
        "llm_called": {
            "vision": vision.get("decision") == "call",
            "report": report.get("decision") == "call",
        },
        "finding_types": _extract_finding_types(payload),
    }


def _json_diff(expected: Any, got: Any) -> str:
    a = json.dumps(expected, ensure_ascii=False, indent=2, sort_keys=True).splitlines(True)
    b = json.dumps(got, ensure_ascii=False, indent=2, sort_keys=True).splitlines(True)
    return "".join(difflib.unified_diff(a, b, fromfile="golden", tofile="current"))


def test_e2e_contract_analysis_skin_qc_fail_golden() -> None:
    # qc=fail: must gate hard (no LLM), return retake advice, and keep outputs conservative.
    request_body = {
        "use_photo": True,
        "currentRoutine": {
            "am": {"cleanser": "gentle", "moisturizer": "basic", "spf": "spf"},
            "pm": {"cleanser": "gentle", "moisturizer": "basic"},
        },
        "photos": [{"slot_id": "front", "photo_id": "synthetic_photo_1", "qc_status": "fail"}],
    }

    envelope = _run_node_runner(request_body)
    snapshot = _snapshot_from_envelope(envelope)

    assert snapshot["quality_grade"] == "fail"
    assert snapshot["analysis_source"] == "retake"
    assert snapshot["llm_called"] == {"vision": False, "report": False}
    assert snapshot["finding_types"] == []

    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    expected = golden.get("snapshot")
    if not isinstance(expected, dict):
        raise AssertionError("golden is missing snapshot object")

    if os.environ.get("UPDATE_GOLDEN") == "1":
        golden["snapshot"] = snapshot
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return

    if snapshot != expected:
        raise AssertionError("golden mismatch\n" + _json_diff(expected, snapshot))

