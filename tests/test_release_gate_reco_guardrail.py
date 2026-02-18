import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import generate_release_gate as grg  # noqa: E402
import release_gate_discovery as rgd  # noqa: E402


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def _discover_reco_guardrail(repo_root: Path) -> rgd.DiscoveryResult:
    return rgd.discover_artifact(
        name="reco_guardrail_report",
        repo_root=repo_root,
        explicit_path="",
        env_override_name="RELEASE_RECO_GUARDRAIL_REPORT_PATH",
        default_rel_paths=["artifacts/reco_guardrail_report.json"],
        patterns=["**/reco_guardrail_report*.json"],
    )


def test_reco_guardrail_check_passes_with_clean_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RELEASE_RECO_GUARDRAIL_REPORT_PATH", raising=False)
    _write_json(
        tmp_path / "artifacts/reco_guardrail_report.json",
        {
            "metrics": {
                "recall_at_k": 0.6,
                "ndcg_at_k": 0.7,
                "competitors_same_brand_rate": 0.0,
                "competitors_on_page_source_rate": 0.0,
                "explanation_alignment_at_3": 1.0,
            },
            "gates": {
                "hard_fail": False,
                "violations": [],
                "warnings": [],
            },
            "by_block": {
                "competitors": {"candidates": 2, "alignment": {"rate": 1.0}, "same_brand_hits": 0, "on_page_hits": 0},
                "related_products": {"candidates": 1, "alignment": {"rate": 1.0}},
                "dupes": {"candidates": 1, "alignment": {"rate": 1.0}},
            },
            "samples": {"total": 1},
        },
    )

    result = grg._reco_guardrail_check(_discover_reco_guardrail(tmp_path))
    assert result.status == "PASS"


def test_reco_guardrail_check_fails_on_any_pollution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RELEASE_RECO_GUARDRAIL_REPORT_PATH", raising=False)
    _write_json(
        tmp_path / "artifacts/reco_guardrail_report.json",
        {
            "metrics": {
                "competitors_same_brand_rate": 0.25,
                "competitors_on_page_source_rate": 0.0,
                "explanation_alignment_at_3": 0.98,
            },
            "gates": {
                "hard_fail": True,
                "violations": ["competitors_same_brand_rate_gt_zero"],
                "warnings": [],
            },
            "by_block": {
                "competitors": {"candidates": 4, "alignment": {"rate": 0.9}, "same_brand_hits": 1, "on_page_hits": 0},
            },
            "samples": {"total": 1},
        },
    )

    result = grg._reco_guardrail_check(_discover_reco_guardrail(tmp_path))
    assert result.status == "FAIL"
    assert "same_brand_rate" in result.details_md or "hard redline" in result.details_md


def test_reco_guardrail_check_missing_report_marks_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RELEASE_RECO_GUARDRAIL_REPORT_PATH", raising=False)
    result = grg._reco_guardrail_check(_discover_reco_guardrail(tmp_path))
    assert result.status == "MISSING"
