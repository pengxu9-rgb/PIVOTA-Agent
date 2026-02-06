import json
import os
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import generate_release_gate as grg  # noqa: E402


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def _clear_bench_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in (
        "RELEASE_BENCH_P95_BUDGET_MS",
        "RELEASE_BENCH_FAILURE_RATE_MAX",
        "RELEASE_BENCH_LLM_SCHEMA_FAIL_MAX",
        "RELEASE_BENCH_MIN_P95_MS",
    ):
        monkeypatch.delenv(k, raising=False)


def test_bench_sanity_fails_on_suspiciously_low_p95(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_bench_env(monkeypatch)
    p = tmp_path / "bench_analyze.json"
    _write_json(
        p,
        {
            "payload": {"qc": "pass", "images": ["synthetic.png"]},
            "summary": {"n": 10, "total_p50": 0.03, "total_p95": 0.06, "failure_rate": 0.0, "llm_calls": 0},
        },
    )

    r = grg._bench_check(p)
    assert r.status == "FAIL"
    assert "suspiciously low" in r.details_md


def test_bench_sanity_skips_min_p95_when_qc_fail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_bench_env(monkeypatch)
    monkeypatch.setenv("RELEASE_BENCH_MIN_P95_MS", "1000")  # would fail if applied

    p = tmp_path / "bench_analyze.json"
    _write_json(
        p,
        {
            "payload": {"qc": "fail", "images": ["synthetic.png"]},
            "summary": {"n": 3, "total_p50": 0.05, "total_p95": 0.05, "failure_rate": 0.0, "llm_calls": 0},
        },
    )

    r = grg._bench_check(p)
    assert r.status == "PASS"


def test_bench_sanity_fails_when_n_is_zero(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_bench_env(monkeypatch)
    p = tmp_path / "bench_analyze.json"
    _write_json(
        p,
        {
            "payload": {"qc": "pass", "images": ["synthetic.png"]},
            "summary": {"n": 0, "total_p50": 10.0, "total_p95": 10.0, "failure_rate": 0.0, "llm_calls": 0},
        },
    )

    r = grg._bench_check(p)
    assert r.status == "FAIL"
    assert "summary.n" in r.details_md


def test_bench_sanity_passes_for_normal_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_bench_env(monkeypatch)
    p = tmp_path / "bench_analyze.json"
    _write_json(
        p,
        {
            "payload": {"qc": "pass", "images": ["synthetic.png"]},
            "summary": {"n": 5, "total_p50": 30.0, "total_p95": 60.0, "failure_rate": 0.0, "llm_calls": 0},
        },
    )

    r = grg._bench_check(p)
    assert r.status == "PASS"

