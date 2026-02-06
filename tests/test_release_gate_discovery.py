import os
import sys
from pathlib import Path
from typing import List

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import release_gate_discovery as rgd  # noqa: E402


def _write(path: Path, content: str, *, mtime: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.utime(path, (mtime, mtime))


def _default_stability_specs() -> tuple[List[str], List[str]]:
    rels = [
        "stability_report.json",
        "artifacts/stability_report.json",
        "outputs/stability_report.json",
        "scripts/outputs/stability_report.json",
    ]
    pats = ["**/stability_report*.json"]
    return (rels, pats)


def _default_loadtest_specs() -> tuple[List[str], List[str]]:
    rels = [
        "loadtest_report.md",
        "artifacts/loadtest_report.md",
        "outputs/loadtest_report.md",
        "scripts/outputs/loadtest_report.md",
    ]
    pats = ["**/loadtest_report*.md"]
    return (rels, pats)


def test_discovery_picks_latest_mtime_stability(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo_root = tmp_path
    rels, pats = _default_stability_specs()

    root_file = repo_root / "stability_report.json"
    artifacts_file = repo_root / "artifacts" / "stability_report.json"
    scripts_file = repo_root / "scripts" / "outputs" / "stability_report_alt.json"

    _write(root_file, "{}", mtime=10.0)
    _write(scripts_file, "{}", mtime=20.0)
    _write(artifacts_file, "{}", mtime=30.0)

    monkeypatch.delenv("RELEASE_STABILITY_REPORT_PATH", raising=False)

    d = rgd.discover_artifact(
        name="stability_report",
        repo_root=repo_root,
        explicit_path="",
        env_override_name="RELEASE_STABILITY_REPORT_PATH",
        default_rel_paths=rels,
        patterns=pats,
    )

    assert d.selected_via == "auto"
    assert d.selected is not None
    assert d.selected.path == artifacts_file.resolve()
    assert d.selected.mtime == 30.0
    assert d.candidates, "expected candidates list"
    assert d.candidates[0].mtime >= d.candidates[-1].mtime


def test_discovery_picks_latest_mtime_loadtest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo_root = tmp_path
    rels, pats = _default_loadtest_specs()

    root_file = repo_root / "loadtest_report.md"
    artifacts_file = repo_root / "artifacts" / "loadtest_report.md"
    scripts_file = repo_root / "scripts" / "outputs" / "loadtest_report_2026.md"

    _write(root_file, "# report\n", mtime=10.0)
    _write(scripts_file, "# report\n", mtime=20.0)
    _write(artifacts_file, "# report\n", mtime=30.0)

    monkeypatch.delenv("RELEASE_LOADTEST_REPORT_PATH", raising=False)

    d = rgd.discover_artifact(
        name="loadtest_report",
        repo_root=repo_root,
        explicit_path="",
        env_override_name="RELEASE_LOADTEST_REPORT_PATH",
        default_rel_paths=rels,
        patterns=pats,
    )

    assert d.selected_via == "auto"
    assert d.selected is not None
    assert d.selected.path == artifacts_file.resolve()
    assert d.selected.mtime == 30.0


def test_env_override_wins_when_present(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo_root = tmp_path
    rels, pats = _default_stability_specs()

    override_file = repo_root / "scripts" / "outputs" / "stability_report_env.json"
    auto_file = repo_root / "artifacts" / "stability_report.json"

    _write(override_file, "{}", mtime=1.0)
    _write(auto_file, "{}", mtime=999.0)

    monkeypatch.setenv("RELEASE_STABILITY_REPORT_PATH", "scripts/outputs/stability_report_env.json")

    d = rgd.discover_artifact(
        name="stability_report",
        repo_root=repo_root,
        explicit_path="",
        env_override_name="RELEASE_STABILITY_REPORT_PATH",
        default_rel_paths=rels,
        patterns=pats,
    )

    assert d.selected_via == "env"
    assert d.selected is not None
    assert d.selected.path == override_file.resolve()
    assert d.override_kind == "env"
    assert d.override_error is None


def test_env_override_missing_falls_back_to_auto(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo_root = tmp_path
    rels, pats = _default_loadtest_specs()

    auto_file = repo_root / "artifacts" / "loadtest_report.md"
    _write(auto_file, "# ok\n", mtime=123.0)

    monkeypatch.setenv("RELEASE_LOADTEST_REPORT_PATH", "does/not/exist.md")

    d = rgd.discover_artifact(
        name="loadtest_report",
        repo_root=repo_root,
        explicit_path="",
        env_override_name="RELEASE_LOADTEST_REPORT_PATH",
        default_rel_paths=rels,
        patterns=pats,
    )

    assert d.selected_via == "auto"
    assert d.selected is not None
    assert d.selected.path == auto_file.resolve()
    assert d.override_kind == "env"
    assert d.override_error is not None
    assert "override path not found" in d.override_error

