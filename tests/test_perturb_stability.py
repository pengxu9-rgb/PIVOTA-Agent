import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "perturb_stability.py"


def _run_script(out_path: Path, *, n_perturbations: int = 8) -> Dict[str, Any]:
    proc = subprocess.run(
        ["python3", str(SCRIPT), "--n-perturbations", str(n_perturbations), "--out", str(out_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
        env={**os.environ},
    )
    if proc.returncode != 0:
        raise AssertionError(
            "perturb_stability.py failed\n"
            f"exit={proc.returncode}\n"
            f"stderr:\n{proc.stderr.strip()}\n"
            f"stdout:\n{proc.stdout.strip()}\n"
        )
    if not out_path.exists():
        raise AssertionError(f"report not created: {out_path}")
    return json.loads(out_path.read_text(encoding="utf-8"))


def _issue_scores(variant: Dict[str, Any], issue_type: str) -> Optional[Tuple[float, str]]:
    for it in variant.get("issues") or []:
        if not isinstance(it, dict):
            continue
        if it.get("issue_type") != issue_type:
            continue
        try:
            return (float(it.get("severity_score")), str(it.get("severity") or ""))
        except Exception:
            return None
    return None


def test_perturb_stability_minimal_synthetic_does_not_jump() -> None:
    # Minimal regression: synthetic image + mild perturbations should not wildly change
    # severities *when quality stays non-fail* (fail variants are allowed to gate/turn conservative).
    with tempfile.TemporaryDirectory(prefix="aurora_stability_test_") as tmp:
        out_path = Path(tmp) / "stability_report.json"
        report = _run_script(out_path, n_perturbations=8)

    assert report.get("schema_version") == "aurora.stability_report.v1"
    images = report.get("images") or []
    assert images, "missing images in stability report"

    first = images[0]
    variants: List[Dict[str, Any]] = list(first.get("variants") or [])
    assert len(variants) >= 9, "expected original + >=8 perturbations"

    # Keep only non-fail quality variants; these should be stable.
    nonfail = []
    for v in variants:
        q = v.get("quality") or {}
        if not v.get("ok"):
            continue
        if q.get("grade") == "fail":
            continue
        nonfail.append(v)

    assert len(nonfail) >= 3, "expected at least 3 non-fail variants for a stable slice"

    issue_types = sorted({it.get("issue_type") for v in nonfail for it in (v.get("issues") or []) if isinstance(it, dict) and it.get("issue_type")})
    assert issue_types, "missing issues in non-fail variants"

    # Stability assertion: within the non-fail slice, severity_score should not swing wildly.
    # (We don't assert correctness; only stability under mild perturbations.)
    for itype in issue_types:
        scores: List[float] = []
        labels: List[str] = []
        for v in nonfail:
            got = _issue_scores(v, itype)
            if not got:
                continue
            s, lab = got
            scores.append(s)
            labels.append(lab)
        if not scores:
            continue
        assert (max(scores) - min(scores)) <= 0.2, f"{itype}: severity_score range too large in non-fail slice"
        assert len({l for l in labels if l}) <= 3, f"{itype}: severity labels too unstable in non-fail slice"

    # Contract check: report exposes correlation direction fields.
    issue_stability = first.get("issue_stability") or {}
    for itype, stab in issue_stability.items():
        if not isinstance(stab, dict):
            continue
        assert isinstance(stab.get("confidence_vs_quality_factor"), str)


def _import_perturb_module() -> Any:
    spec = importlib.util.spec_from_file_location("aurora_perturb_stability", str(SCRIPT))
    if spec is None or spec.loader is None:
        raise AssertionError("failed to import perturb_stability.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_stability_stats_missing_issue_does_not_inflate_range() -> None:
    mod = _import_perturb_module()
    build = getattr(mod, "_build_stability_report", None)
    if not callable(build):
        raise AssertionError("_build_stability_report not found")

    # Simulate 3 comparable variants (non-fail quality), with one missing a finding for the same issue_type.
    # The missing variant must NOT be treated as severity_score=0 (which would inflate the range).
    results: List[Dict[str, Any]] = [
        {
            "image": "img.png",
            "variant": "original",
            "variant_kind": "identity",
            "ok": True,
            "reason": None,
            "diagnosis": {
                "quality": {"grade": "degraded", "quality_factor": 1.0, "reasons": []},
                "issues": [
                    {"issue_type": "pores", "severity_score": 0.7, "severity": "mild", "severity_level": 1, "confidence": 0.9},
                ],
            },
        },
        {
            "image": "img.png",
            "variant": "noise",
            "variant_kind": "noise",
            "ok": True,
            "reason": None,
            "diagnosis": {
                "quality": {"grade": "degraded", "quality_factor": 1.0, "reasons": []},
                "issues": [
                    {"issue_type": "pores", "severity_score": 0.8, "severity": "moderate", "severity_level": 2, "confidence": 0.9},
                ],
            },
        },
        {
            "image": "img.png",
            "variant": "jpeg",
            "variant_kind": "jpeg",
            "ok": True,
            "reason": None,
            "diagnosis": {
                "quality": {"grade": "degraded", "quality_factor": 1.0, "reasons": []},
                "issues": [
                    # pores missing here
                ],
            },
        },
    ]

    report = build(results)
    first = (report.get("images") or [{}])[0]
    pores = ((first.get("issue_stability") or {}).get("pores") or {})
    assert round(float(pores.get("severity_score_range") or 0.0), 3) == 0.1
    assert pores.get("missing_in_compared_variants_n") == 1
    assert pores.get("appearance_flip_rate") == 0.333
