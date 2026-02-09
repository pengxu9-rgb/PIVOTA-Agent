#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_PROFILE_SUMMARY: Dict[str, Any] = {
    "skinType": "oily",
    "barrierStatus": "healthy",
    "sensitivity": "low",
    "currentRoutine": "gentle cleanser + moisturizer + spf",
}


@dataclass(frozen=True)
class VariantSpec:
    name: str
    kind: str
    params: Dict[str, Any]


def _collect_images(paths: Sequence[str]) -> List[Path]:
    exts = {".jpg", ".jpeg", ".png", ".webp"}
    out: List[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.is_file() and child.suffix.lower() in exts:
                    out.append(child)
        elif p.is_file() and p.suffix.lower() in exts:
            out.append(p)
    return out


def _clamp_u8(arr: np.ndarray) -> np.ndarray:
    return np.clip(arr, 0, 255).astype(np.uint8)


def _make_synthetic_image(out_path: Path, *, seed: int = 42) -> Path:
    """
    Deterministic synthetic "skin-like" patch:
    - Color chosen to comfortably pass the YCrCb skin ROI gate.
    - Mild texture so blur proxy isn't trivially low.
    """
    rng = np.random.default_rng(seed)
    h = w = 256
    base = np.zeros((h, w, 3), dtype=np.float32)
    # Tuned so Cr/Cb fall within computeSkinMask() thresholds with margin.
    base[..., 0] = 155  # R
    base[..., 1] = 140  # G
    base[..., 2] = 135  # B

    xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    shade = xx * 4.0 + yy * 2.0
    base[..., 0] += shade
    base[..., 1] += shade * 0.9
    base[..., 2] += shade * 0.8

    noise = rng.normal(0.0, 8.0, size=base.shape).astype(np.float32)
    img = _clamp_u8(base + noise)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img).save(out_path)
    return out_path


def _pil_to_np_rgb(img: Image.Image) -> np.ndarray:
    if img.mode != "RGB":
        img = img.convert("RGB")
    return np.asarray(img).astype(np.uint8)


def _np_rgb_to_pil(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(arr.astype(np.uint8))


def _apply_resize(img: Image.Image, scale: float) -> Image.Image:
    w, h = img.size
    nw = max(8, int(round(w * scale)))
    nh = max(8, int(round(h * scale)))
    small = img.resize((nw, nh), resample=Image.BILINEAR)
    return small.resize((w, h), resample=Image.BILINEAR)


def _apply_crop_jitter(img: Image.Image, crop_frac: float, offset_xy: Tuple[float, float]) -> Image.Image:
    w, h = img.size
    cw = max(8, int(round(w * crop_frac)))
    ch = max(8, int(round(h * crop_frac)))
    ox = int(round((w - cw) * (0.5 + offset_xy[0])))
    oy = int(round((h - ch) * (0.5 + offset_xy[1])))
    ox = max(0, min(w - cw, ox))
    oy = max(0, min(h - ch, oy))
    cropped = img.crop((ox, oy, ox + cw, oy + ch))
    return cropped.resize((w, h), resample=Image.BILINEAR)


def _apply_gaussian_noise(img: Image.Image, sigma: float, *, seed: int) -> Image.Image:
    rng = np.random.default_rng(seed)
    arr = _pil_to_np_rgb(img).astype(np.float32)
    noise = rng.normal(0.0, float(sigma), size=arr.shape).astype(np.float32)
    return _np_rgb_to_pil(_clamp_u8(arr + noise))


def _apply_color_temp(img: Image.Image, *, warm: bool) -> Image.Image:
    arr = _pil_to_np_rgb(img).astype(np.float32)
    if warm:
        arr[..., 0] *= 1.02  # R up (mild)
        arr[..., 2] *= 0.99  # B down (mild)
    else:
        arr[..., 0] *= 0.99  # R down (mild)
        arr[..., 2] *= 1.02  # B up (mild)
    return _np_rgb_to_pil(_clamp_u8(arr))


def _encode_jpeg(img: Image.Image, *, quality: int) -> bytes:
    bio = BytesIO()
    img.save(bio, format="JPEG", quality=int(quality), optimize=True)
    return bio.getvalue()


def _variant_specs(n_perturbations: int) -> List[VariantSpec]:
    """
    Return a stable list (original + N perturbations).
    Keep this deterministic so tests don't flake.
    """
    n = max(8, min(12, int(n_perturbations)))
    candidates: List[VariantSpec] = [
        VariantSpec("resize_097", "resize", {"scale": 0.97}),
        VariantSpec("resize_095", "resize", {"scale": 0.95}),
        VariantSpec("crop_jitter_a", "crop", {"crop_frac": 0.98, "offset_xy": (0.02, -0.02)}),
        VariantSpec("crop_jitter_b", "crop", {"crop_frac": 0.98, "offset_xy": (-0.02, 0.02)}),
        VariantSpec("noise_sigma1_5", "noise", {"sigma": 1.5, "seed_offset": 10}),
        VariantSpec("jpeg_q90", "jpeg", {"quality": 90}),
        VariantSpec("jpeg_q82", "jpeg", {"quality": 82}),
        VariantSpec("temp_warm", "temp", {"warm": True}),
        VariantSpec("temp_cool", "temp", {"warm": False}),
        VariantSpec("noise_sigma2_5", "noise", {"sigma": 2.5, "seed_offset": 20}),
    ]
    return [VariantSpec("original", "identity", {})] + candidates[:n]


def _save_variant_image(
    img: Image.Image,
    out_dir: Path,
    *,
    base_name: str,
    variant: VariantSpec,
    jpeg_quality: Optional[int] = None,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_base = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in base_name)[:80] or "image"
    if variant.kind == "jpeg":
        q = int(jpeg_quality or variant.params.get("quality") or 80)
        out_path = out_dir / f"{safe_base}__{variant.name}.jpg"
        out_path.write_bytes(_encode_jpeg(img, quality=q))
        return out_path
    out_path = out_dir / f"{safe_base}__{variant.name}.png"
    img.save(out_path, format="PNG")
    return out_path


def _generate_variants(img_path: Path, out_dir: Path, *, seed: int, n_perturbations: int) -> List[Dict[str, Any]]:
    base_name = img_path.stem
    img = Image.open(img_path).convert("RGB")

    variants: List[Dict[str, Any]] = []
    for spec in _variant_specs(n_perturbations):
        v_img = img
        if spec.kind == "resize":
            v_img = _apply_resize(img, float(spec.params["scale"]))
        elif spec.kind == "crop":
            v_img = _apply_crop_jitter(
                img,
                float(spec.params["crop_frac"]),
                (float(spec.params["offset_xy"][0]), float(spec.params["offset_xy"][1])),
            )
        elif spec.kind == "noise":
            v_img = _apply_gaussian_noise(img, float(spec.params["sigma"]), seed=seed + int(spec.params.get("seed_offset", 0)))
        elif spec.kind == "temp":
            v_img = _apply_color_temp(img, warm=bool(spec.params["warm"]))
        elif spec.kind == "identity":
            v_img = img
        elif spec.kind == "jpeg":
            v_img = img
        else:
            raise ValueError(f"unknown variant kind: {spec.kind}")

        out_path = _save_variant_image(
            v_img,
            out_dir,
            base_name=base_name,
            variant=spec,
            jpeg_quality=int(spec.params.get("quality") or 80) if spec.kind == "jpeg" else None,
        )
        variants.append(
            {
                "image": img_path.name,
                "variant": spec.name,
                "variant_kind": spec.kind,
                "path": str(out_path),
            }
        )
    return variants


NODE_BATCH_CODE = r"""
const fs = require('fs');
const path = require('path');

function safeObj(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8').trim();
  const jobs = raw ? JSON.parse(raw) : [];
  const modPath = path.join(process.cwd(), 'src', 'auroraBff', 'skinDiagnosisV1');
  const { runSkinDiagnosisV1 } = require(modPath);
  const routesModPath = path.join(process.cwd(), 'src', 'auroraBff', 'routes');
  const routesMod = require(routesModPath);
  const buildSkinAnalysisFromDiagnosisV1 = routesMod && routesMod.__internal ? routesMod.__internal.buildSkinAnalysisFromDiagnosisV1 : null;
  const buildExecutablePlanForAnalysis = routesMod && routesMod.__internal ? routesMod.__internal.buildExecutablePlanForAnalysis : null;

  const out = [];
  for (const j of jobs) {
    const job = safeObj(j) || {};
    const filePath = typeof job.path === 'string' ? job.path : '';
    let buf = null;
    try {
      buf = fs.readFileSync(filePath);
    } catch (err) {
      out.push({ ...job, ok: false, reason: 'read_failed' });
      continue;
    }

    let res = null;
    try {
      res = await runSkinDiagnosisV1({
        imageBuffer: buf,
        language: job.lang === 'CN' ? 'CN' : 'EN',
        profileSummary: safeObj(job.profileSummary) || null,
        recentLogsSummary: Array.isArray(job.recentLogsSummary) ? job.recentLogsSummary : [],
      });
    } catch (err) {
      out.push({ ...job, ok: false, reason: 'diagnosis_threw' });
      continue;
    }

    if (!res || !res.ok || !safeObj(res.diagnosis)) {
      out.push({ ...job, ok: false, reason: (res && res.reason) ? String(res.reason) : 'diagnosis_failed' });
      continue;
    }

    const diag = res.diagnosis;
    const q = safeObj(diag.quality) || null;
    const issues = Array.isArray(diag.issues) ? diag.issues : [];
    const issuesSlim = issues
      .map((it) => safeObj(it) || null)
      .filter(Boolean)
      .map((it) => ({
        issue_type: typeof it.issue_type === 'string' ? it.issue_type : null,
        region: typeof it.region === 'string' ? it.region : null,
        severity: typeof it.severity === 'string' ? it.severity : null,
        severity_level: typeof it.severity_level === 'number' ? it.severity_level : null,
        severity_score: typeof it.severity_score === 'number' ? it.severity_score : null,
        confidence: typeof it.confidence === 'number' ? it.confidence : null,
      }))
      .filter((it) => it.issue_type);

    let geometrySanitizer = null;
    if (typeof buildSkinAnalysisFromDiagnosisV1 === 'function' && typeof buildExecutablePlanForAnalysis === 'function') {
      try {
        const analysis0 = buildSkinAnalysisFromDiagnosisV1(diag, {
          language: job.lang === 'CN' ? 'CN' : 'EN',
          profileSummary: safeObj(job.profileSummary) || null,
        });
        const analysis1 = buildExecutablePlanForAnalysis({
          analysis: analysis0,
          language: job.lang === 'CN' ? 'CN' : 'EN',
          usedPhotos: true,
          photoQuality: q || { grade: 'unknown', reasons: [] },
          profileSummary: safeObj(job.profileSummary) || null,
          photosProvided: true,
        });
        if (analysis1 && typeof analysis1.__geometry_sanitizer === 'object') {
          geometrySanitizer = analysis1.__geometry_sanitizer;
        }
      } catch (_) {
        geometrySanitizer = null;
      }
    }

    out.push({
      ...job,
      ok: true,
      diagnosis: {
        quality: q
          ? {
              grade: typeof q.grade === 'string' ? q.grade : 'unknown',
              quality_factor: typeof q.quality_factor === 'number' ? q.quality_factor : null,
              reasons: Array.isArray(q.reasons) ? q.reasons.slice(0, 10) : [],
            }
          : null,
        issues: issuesSlim,
      },
      geometry_sanitizer: geometrySanitizer && typeof geometrySanitizer === 'object' ? geometrySanitizer : null,
    });
  }

  process.stdout.write(JSON.stringify({ schema_version: 'aurora.diagnosis_batch.v1', results: out }) + '\n');
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
"""


def _run_diagnosis_batch(
    jobs: List[Dict[str, Any]],
    *,
    lang: str,
    profile_summary: Dict[str, Any],
) -> List[Dict[str, Any]]:
    payload = []
    for j in jobs:
        payload.append(
            {
                **j,
                "lang": "CN" if lang.upper() == "CN" else "EN",
                "profileSummary": profile_summary,
                "recentLogsSummary": [],
            }
        )

    proc = subprocess.run(
        ["node", "-e", NODE_BATCH_CODE],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
        env={**os.environ},
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node diagnosis batch failed\nexit={proc.returncode}\nstderr:\n{proc.stderr.strip()}")
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"node did not output JSON: {err}\nstdout:\n{proc.stdout[:4000]}") from err
    results = out.get("results") or []
    if not isinstance(results, list):
        return []
    return [r for r in results if isinstance(r, dict)]


def _corr_sign(xs: List[float], ys: List[float]) -> str:
    if len(xs) < 3 or len(ys) < 3 or len(xs) != len(ys):
        return "insufficient"
    mx = float(sum(xs)) / float(len(xs))
    my = float(sum(ys)) / float(len(ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 1e-12 or vy <= 1e-12:
        return "flat"
    cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(len(xs)))
    if abs(cov) <= 1e-9:
        return "flat"
    return "positive" if cov > 0 else "negative"


def _build_stability_report(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_image: Dict[str, List[Dict[str, Any]]] = {}
    for r in results:
        by_image.setdefault(str(r.get("image") or "image"), []).append(r)

    images_out: List[Dict[str, Any]] = []
    report_geom_requests = 0
    report_geom_drop_total = 0
    report_geom_clip_total = 0
    report_geom_drop_rate_max = 0.0

    for image_name, rows in sorted(by_image.items(), key=lambda x: x[0]):
        variants_out: List[Dict[str, Any]] = []
        image_geom_requests = 0
        image_geom_drop_total = 0
        image_geom_clip_total = 0
        for run_index, r in enumerate(sorted(rows, key=lambda x: str(x.get("variant") or ""))):
            diag = (r.get("diagnosis") or {}) if isinstance(r.get("diagnosis"), dict) else {}
            q = (diag.get("quality") or {}) if isinstance(diag.get("quality"), dict) else {}
            issues = diag.get("issues") if isinstance(diag.get("issues"), list) else []
            gs_raw = r.get("geometry_sanitizer") if isinstance(r.get("geometry_sanitizer"), dict) else {}
            gs_checked = int(gs_raw.get("checked_n") or 0)
            gs_dropped = int(gs_raw.get("dropped_n") or 0)
            gs_clipped = int(gs_raw.get("clipped_n") or 0)
            image_geom_requests += 1
            image_geom_drop_total += max(0, gs_dropped)
            image_geom_clip_total += max(0, gs_clipped)
            slim_issues: List[Dict[str, Any]] = []
            for it in issues:
                if not isinstance(it, dict):
                    continue
                if not isinstance(it.get("issue_type"), str):
                    continue
                slim_issues.append(
                    {
                        "issue_type": it.get("issue_type"),
                        "severity_score": it.get("severity_score"),
                        "severity": it.get("severity"),
                        "severity_level": it.get("severity_level"),
                        "confidence": it.get("confidence"),
                    }
                )

            # Keep a minimal, non-identifying slice of quality metrics for debugging stability.
            q_metrics = q.get("metrics") if isinstance(q.get("metrics"), dict) else {}
            q_metrics_slim = {
                "skin_coverage": q_metrics.get("skin_coverage"),
                "mean_luma": q_metrics.get("mean_luma"),
                "laplacian_energy": q_metrics.get("laplacian_energy"),
                "blur_factor": q_metrics.get("blur_factor"),
                "exposure_factor": q_metrics.get("exposure_factor"),
                "wb_factor": q_metrics.get("wb_factor"),
                "coverage_factor": q_metrics.get("coverage_factor"),
            }

            variants_out.append(
                {
                    "variant": r.get("variant"),
                    "variant_kind": r.get("variant_kind"),
                    "run_index": run_index,
                    "ok": bool(r.get("ok")),
                    "reason": r.get("reason"),
                    "quality": {
                        "grade": q.get("grade"),
                        "quality_factor": q.get("quality_factor"),
                        "reasons": q.get("reasons") if isinstance(q.get("reasons"), list) else [],
                        "metrics": q_metrics_slim,
                    },
                    "geometry_sanitizer": {
                        "checked_n": max(0, gs_checked),
                        "dropped_n": max(0, gs_dropped),
                        "clipped_n": max(0, gs_clipped),
                    },
                    "issues": slim_issues,
                }
            )

        # Compute per-issue stability across comparable variants.
        #
        # IMPORTANT: We exclude `quality.grade == fail` variants from stability range, because
        # "fail" means the pipeline would recommend retake and output should be conservative.
        # Including fail-grade runs in the range can create artificial 0 ↔ high-score swings
        # that are not actionable for "diagnosis stability" (they are "quality gate" events).
        comparable_variants: List[Dict[str, Any]] = []
        grade_counts: Dict[str, int] = {"pass": 0, "degraded": 0, "fail": 0, "unknown": 0}
        excluded_not_ok = 0
        excluded_fail_grade = 0
        excluded_missing_grade = 0
        for v in variants_out:
            if not v.get("ok"):
                excluded_not_ok += 1
                continue
            q0 = v.get("quality") if isinstance(v.get("quality"), dict) else {}
            grade = q0.get("grade") if isinstance(q0.get("grade"), str) else "unknown"
            if grade not in grade_counts:
                grade = "unknown"
            grade_counts[grade] += 1
            if grade == "fail":
                excluded_fail_grade += 1
                continue
            if grade == "unknown":
                excluded_missing_grade += 1
                continue
            comparable_variants.append(v)

        # Collect issue types from all variants so the report remains stable even if some
        # variants omit certain issues.
        issue_types = set()
        for v in variants_out:
            for it in v.get("issues") or []:
                if isinstance(it, dict) and isinstance(it.get("issue_type"), str):
                    issue_types.add(it["issue_type"])

        baseline = next((v for v in variants_out if v.get("variant") == "original"), None)
        baseline_ok = bool(baseline and baseline.get("ok"))
        baseline_grade = None
        if baseline_ok:
            q0 = baseline.get("quality") if isinstance(baseline.get("quality"), dict) else {}
            baseline_grade = q0.get("grade") if isinstance(q0.get("grade"), str) else None
        baseline_comparable = bool(baseline_ok and baseline_grade in {"pass", "degraded"})

        def _issue_entry(v: Dict[str, Any], itype: str) -> Optional[Dict[str, Any]]:
            return next((x for x in (v.get("issues") or []) if isinstance(x, dict) and x.get("issue_type") == itype), None)

        def _variant_ref(v: Dict[str, Any]) -> Dict[str, Any]:
            q0 = v.get("quality") if isinstance(v.get("quality"), dict) else {}
            return {
                "variant": v.get("variant"),
                "variant_kind": v.get("variant_kind"),
                "run_index": v.get("run_index"),
                "quality_grade": q0.get("grade"),
            }

        issue_stability: Dict[str, Any] = {}
        worst_by_range: List[Dict[str, Any]] = []
        for itype in sorted(issue_types):
            sev_scores: List[float] = []
            sev_levels: List[float] = []
            confs: List[float] = []
            qfs: List[float] = []
            sev_labels: List[str] = []
            missing_in_comparable = 0
            series_points: List[Dict[str, Any]] = []
            for v in comparable_variants:
                qf = (v.get("quality") or {}).get("quality_factor")
                try:
                    qf_f = float(qf)
                except Exception:
                    qf_f = None
                entry = _issue_entry(v, itype)
                if not entry:
                    missing_in_comparable += 1
                    continue
                try:
                    s = float(entry.get("severity_score"))
                except Exception:
                    s = None
                try:
                    c = float(entry.get("confidence"))
                except Exception:
                    c = None
                try:
                    lvl = float(entry.get("severity_level"))
                except Exception:
                    lvl = None
                lab = entry.get("severity")
                if isinstance(lab, str) and lab.strip():
                    sev_labels.append(lab.strip())
                if s is None or c is None or qf_f is None:
                    continue
                sev_scores.append(s)
                confs.append(c)
                qfs.append(qf_f)
                if lvl is not None:
                    sev_levels.append(lvl)
                series_points.append({"severity_score": s, "confidence": c, "severity_level": lvl, "severity": lab, "variant_ref": _variant_ref(v)})

            if sev_scores:
                mn = float(min(sev_scores))
                mx = float(max(sev_scores))
                # Find which variants contributed to min/max (for diagnosis without any image data).
                min_point = None
                max_point = None
                for pt in series_points:
                    s = pt.get("severity_score")
                    if s == mn and min_point is None:
                        min_point = pt
                    if s == mx and max_point is None:
                        max_point = pt
                issue_stability[itype] = {
                    "severity_score_min": mn,
                    "severity_score_max": mx,
                    "severity_score_range": mx - mn,
                    "severity_score_min_ref": (min_point or {}).get("variant_ref"),
                    "severity_score_max_ref": (max_point or {}).get("variant_ref"),
                    "severity_level_min": float(min(sev_levels)) if sev_levels else None,
                    "severity_level_max": float(max(sev_levels)) if sev_levels else None,
                    "severity_labels": sorted({s for s in sev_labels})[:6],
                    "confidence_min": float(min(confs)) if confs else None,
                    "confidence_max": float(max(confs)) if confs else None,
                    "confidence_vs_quality_factor": _corr_sign(confs, qfs),
                    "compared_variants_n": len(comparable_variants),
                    "missing_in_compared_variants_n": missing_in_comparable,
                    "appearance_flip_rate": round(float(missing_in_comparable) / float(len(comparable_variants)), 3)
                    if comparable_variants
                    else None,
                }
                worst_by_range.append(
                    {
                        "issue_type": itype,
                        "issue_subtype": None,
                        "transform_min": (min_point or {}).get("variant_ref"),
                        "transform_max": (max_point or {}).get("variant_ref"),
                        "score_min": mn,
                        "score_max": mx,
                        "range": mx - mn,
                        "run_ids": [
                            idx
                            for idx in [
                                ((min_point or {}).get("variant_ref") or {}).get("run_index"),
                                ((max_point or {}).get("variant_ref") or {}).get("run_index"),
                            ]
                            if isinstance(idx, int)
                        ][:2],
                        "notes": [
                            "range_computed_on=quality_nonfail",
                            f"excluded_quality_fail_n={excluded_fail_grade}",
                            f"excluded_not_ok_n={excluded_not_ok}",
                        ],
                    }
                )
            else:
                issue_stability[itype] = {
                    "severity_score_min": None,
                    "severity_score_max": None,
                    "severity_score_range": None,
                    "confidence_vs_quality_factor": "insufficient",
                    "compared_variants_n": len(comparable_variants),
                    "missing_in_compared_variants_n": None,
                    "appearance_flip_rate": None,
                }

        # Per-transform summary: how much each transform family deviates from the baseline.
        per_transform_summary: List[Dict[str, Any]] = []
        # Build baseline scores (if available).
        baseline_scores: Dict[str, float] = {}
        if baseline_comparable:
            for itype in sorted(issue_types):
                entry = _issue_entry(baseline, itype) if isinstance(baseline, dict) else None
                if not entry:
                    continue
                try:
                    baseline_scores[itype] = float(entry.get("severity_score"))
                except Exception:
                    continue

        kinds = sorted({str(v.get("variant_kind") or "unknown") for v in variants_out})
        for kind in kinds:
            group = [v for v in variants_out if str(v.get("variant_kind") or "unknown") == kind]
            group_nonfail = [v for v in comparable_variants if str(v.get("variant_kind") or "unknown") == kind]
            delta_by_issue: Dict[str, List[float]] = {itype: [] for itype in issue_types}
            if baseline_scores:
                for v in group_nonfail:
                    for itype in issue_types:
                        entry = _issue_entry(v, itype)
                        if not entry:
                            continue
                        try:
                            s = float(entry.get("severity_score"))
                        except Exception:
                            continue
                        if itype in baseline_scores:
                            delta_by_issue[itype].append(abs(s - baseline_scores[itype]))

            def _mean(xs: List[float]) -> Optional[float]:
                if not xs:
                    return None
                return float(sum(xs)) / float(len(xs))

            per_transform_summary.append(
                {
                    "variant_kind": kind,
                    "variants_total_n": len(group),
                    "variants_compared_n": len(group_nonfail),
                    "avg_abs_delta_by_issue": {itype: _mean(xs) for itype, xs in delta_by_issue.items()},
                    "max_abs_delta_by_issue": {itype: (max(xs) if xs else None) for itype, xs in delta_by_issue.items()},
                    "notes": [
                        "baseline_variant=original" if baseline_comparable else "baseline_variant_unavailable",
                        "deltas_computed_on=quality_nonfail",
                    ],
                }
            )

        # Top-K worst ranges (usually <= number of issue types).
        top_k_worst = sorted([x for x in worst_by_range if isinstance(x.get("range"), (int, float))], key=lambda x: float(x["range"]), reverse=True)[:10]
        worst = top_k_worst[0] if top_k_worst else None
        image_geom_drop_rate = float(image_geom_drop_total) / float(max(1, image_geom_requests))
        report_geom_requests += image_geom_requests
        report_geom_drop_total += image_geom_drop_total
        report_geom_clip_total += image_geom_clip_total
        report_geom_drop_rate_max = max(report_geom_drop_rate_max, image_geom_drop_rate)

        images_out.append(
            {
                "image": image_name,
                "variants": variants_out,
                "issue_stability": issue_stability,
                "quality_grade_counts": grade_counts,
                "excluded_variants": {
                    "not_ok_n": excluded_not_ok,
                    "quality_fail_n": excluded_fail_grade,
                    "quality_unknown_n": excluded_missing_grade,
                },
                "top_k_worst": top_k_worst,
                "per_transform_summary": per_transform_summary,
                "worst_issue_type": (worst or {}).get("issue_type") if isinstance(worst, dict) else None,
                "worst_severity_score_range": (worst or {}).get("range") if isinstance(worst, dict) else None,
                "geometry_sanitizer": {
                    "analyze_requests_n": image_geom_requests,
                    "drop_total": image_geom_drop_total,
                    "clip_total": image_geom_clip_total,
                    "drop_rate": round(image_geom_drop_rate, 6),
                },
            }
        )

    report_geom_drop_rate = float(report_geom_drop_total) / float(max(1, report_geom_requests))
    return {
        "schema_version": "aurora.stability_report.v1",
        "generated_at": __import__("datetime").datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "geometry_sanitizer_summary": {
            "analyze_requests_total": report_geom_requests,
            "drop_total": report_geom_drop_total,
            "clip_total": report_geom_clip_total,
            "drop_rate": round(report_geom_drop_rate, 6),
            "drop_rate_max_by_image": round(report_geom_drop_rate_max, 6),
        },
        "images": images_out,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run mild perturbations and measure diagnosis stability (offline).")
    parser.add_argument("--lang", default="EN", choices=["EN", "CN"])
    parser.add_argument("--out", default="stability_report.json", help="Output JSON path (default: stability_report.json).")
    parser.add_argument("--n-perturbations", type=int, default=10, help="Number of perturbations (8..12, excluding original).")
    parser.add_argument(
        "--geometry-drop-rate-max",
        type=float,
        default=float(os.environ.get("STABILITY_GEOMETRY_DROP_RATE_MAX", "0.2")),
        help="Fail (exit 1) if geometry_sanitizer_summary.drop_rate exceeds this threshold.",
    )
    parser.add_argument("--keep-temp", action="store_true", help="Keep generated perturbation images on disk.")
    parser.add_argument("images", nargs="*", help="Image file/dir paths. If empty, uses a deterministic synthetic image.")
    args = parser.parse_args(list(argv) if argv is not None else None)

    images = _collect_images(args.images)
    tmp_root: Optional[Path] = None
    if not images:
        tmp_root = Path(tempfile.mkdtemp(prefix="aurora_perturb_"))
        synth = tmp_root / "synthetic_skin.png"
        _make_synthetic_image(synth)
        images = [synth]

    out_dir = Path(tempfile.mkdtemp(prefix="aurora_perturb_variants_"))
    jobs: List[Dict[str, Any]] = []
    for idx, img_path in enumerate(images):
        per_img_dir = out_dir / f"img_{idx}"
        jobs.extend(_generate_variants(img_path, per_img_dir, seed=1000 + idx * 17, n_perturbations=int(args.n_perturbations)))

    batch_results = _run_diagnosis_batch(jobs, lang=args.lang, profile_summary=dict(DEFAULT_PROFILE_SUMMARY))
    report = _build_stability_report(batch_results)

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = Path.cwd() / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if not args.keep_temp:
        try:
            # Best-effort cleanup
            import shutil

            shutil.rmtree(out_dir, ignore_errors=True)
            if tmp_root:
                shutil.rmtree(tmp_root, ignore_errors=True)
        except Exception:
            pass

    print(str(out_path))
    summary = report.get("geometry_sanitizer_summary") if isinstance(report, dict) else None
    drop_rate = float((summary or {}).get("drop_rate") or 0.0)
    budget = float(args.geometry_drop_rate_max) if args.geometry_drop_rate_max is not None else 0.0
    if budget > 0 and drop_rate > budget:
        print(
            f"geometry_sanitizer_drop_rate exceeded budget: drop_rate={drop_rate:.6f}, budget={budget:.6f}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
