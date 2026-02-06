#!/usr/bin/env python3

import argparse
import csv
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


REPO_ROOT = Path(__file__).resolve().parents[1]


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(s: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _default_base_dir() -> Path:
    env = os.environ.get("AURORA_HARD_CASE_DIR", "").strip()
    if env:
        return Path(env)
    return REPO_ROOT / "tmp" / "hard_cases"


def _default_image_dir() -> Path:
    env = os.environ.get("AURORA_HARD_CASE_IMAGE_DIR", "").strip()
    if env:
        return Path(env)
    return REPO_ROOT / "tmp" / "hard_case_images"


@dataclass
class ExportRow:
    hard_case_id: str
    created_at: str
    request_id_hash: str
    pipeline_version: str
    shadow_run: str
    locale: str
    region: str
    device_class: str
    analysis_source: str
    triggers: str
    qc_grade: str
    pixel_grade: str
    pixel_quality_factor: str
    skin_coverage: str
    blur_factor: str
    exposure_factor: str
    wb_factor: str
    pixel_reasons: str
    issues_summary: str
    llm_features_summary: str
    has_image: str
    image_file: str
    image_expires_at: str
    image_deleted_at: str


def _summarize_issues(record: Dict[str, Any]) -> str:
    findings = record.get("findings") if isinstance(record.get("findings"), dict) else {}
    issues = findings.get("issues") if isinstance(findings.get("issues"), list) else []
    parts: List[str] = []
    for it in issues[:8]:
        if not isinstance(it, dict):
            continue
        t = str(it.get("issue_type") or "").strip()
        if not t:
            continue
        sev = it.get("severity_level")
        conf = it.get("confidence")
        sev_s = str(int(sev)) if isinstance(sev, (int, float)) else "0"
        if isinstance(conf, (int, float)):
            parts.append(f"{t}:{sev_s}@{conf:.3f}")
        else:
            parts.append(f"{t}:{sev_s}")
    return "; ".join(parts)


def _summarize_llm_features(record: Dict[str, Any]) -> str:
    findings = record.get("findings") if isinstance(record.get("findings"), dict) else {}
    feats = findings.get("llm_features") if isinstance(findings.get("llm_features"), list) else []
    obs: List[str] = []
    for it in feats[:3]:
        if not isinstance(it, dict):
            continue
        o = str(it.get("observation") or "").strip()
        if not o:
            continue
        obs.append(o[:90])
    return " | ".join(obs)


def _row_from_record(record: Dict[str, Any]) -> ExportRow:
    quality = record.get("quality") if isinstance(record.get("quality"), dict) else {}
    metrics = quality.get("pixel_metrics") if isinstance(quality.get("pixel_metrics"), dict) else {}
    image = record.get("image") if isinstance(record.get("image"), dict) else {}

    triggers = record.get("triggers") if isinstance(record.get("triggers"), list) else []
    pixel_reasons = quality.get("pixel_reasons") if isinstance(quality.get("pixel_reasons"), list) else []

    return ExportRow(
        hard_case_id=str(record.get("hard_case_id") or ""),
        created_at=str(record.get("created_at") or ""),
        request_id_hash=str(record.get("request_id_hash") or ""),
        pipeline_version=str(record.get("pipeline_version") or ""),
        shadow_run=str(bool(record.get("shadow_run"))),
        locale=str(record.get("locale") or ""),
        region=str(record.get("region") or ""),
        device_class=str(record.get("device_class") or ""),
        analysis_source=str(record.get("analysis_source") or ""),
        triggers="|".join([str(x) for x in triggers[:16]]),
        qc_grade=str(quality.get("qc_grade") or ""),
        pixel_grade=str(quality.get("pixel_grade") or ""),
        pixel_quality_factor=str(quality.get("pixel_quality_factor") or ""),
        skin_coverage=str(metrics.get("skin_coverage") or ""),
        blur_factor=str(metrics.get("blur_factor") or ""),
        exposure_factor=str(metrics.get("exposure_factor") or ""),
        wb_factor=str(metrics.get("wb_factor") or ""),
        pixel_reasons="|".join([str(x) for x in pixel_reasons[:16]]),
        issues_summary=_summarize_issues(record),
        llm_features_summary=_summarize_llm_features(record),
        has_image=str(bool(image.get("file"))),
        image_file=str(image.get("file") or ""),
        image_expires_at=str(image.get("expires_at") or ""),
        image_deleted_at=str(image.get("deleted_at") or ""),
    )


def _load_records(base_dir: Path) -> Iterable[Dict[str, Any]]:
    if not base_dir.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(base_dir.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(rec, dict):
                rec["_file"] = str(p)
                out.append(rec)
        except Exception:
            continue
    return out


def _cleanup_expired_images(records: Iterable[Dict[str, Any]], *, image_dir: Path) -> int:
    now = _now_utc()
    deleted = 0
    for rec in records:
        image = rec.get("image") if isinstance(rec.get("image"), dict) else None
        if not image or "file" not in image or not image.get("file"):
            continue
        if image.get("deleted_at"):
            continue
        exp = image.get("expires_at")
        exp_dt = _parse_iso(str(exp)) if isinstance(exp, str) else None
        if not exp_dt or exp_dt > now:
            continue

        file_name = Path(str(image.get("file"))).name
        file_path = image_dir / file_name
        try:
            if file_path.exists():
                file_path.unlink()
                deleted += 1
        except Exception:
            pass

        # Mark record (in-place; will be persisted by caller).
        image["deleted_at"] = now.isoformat().replace("+00:00", "Z")
        image["delete_reason"] = "ttl_expired"
    return deleted


def main() -> int:
    ap = argparse.ArgumentParser(description="Export hard-case samples (derived-only by default).")
    ap.add_argument("--base-dir", type=str, default=str(_default_base_dir()))
    ap.add_argument("--image-dir", type=str, default=str(_default_image_dir()))
    ap.add_argument("--format", choices=["csv", "json"], default="csv")
    ap.add_argument("--out", type=str, default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only-with-image", action="store_true")
    ap.add_argument("--cleanup-expired-images", action="store_true")
    ap.add_argument("--include-identity-hash", action="store_true")
    args = ap.parse_args()

    base_dir = Path(args.base_dir)
    image_dir = Path(args.image_dir)

    records = list(_load_records(base_dir))
    if args.only_with_image:
        records = [
            r
            for r in records
            if isinstance(r.get("image"), dict) and bool((r.get("image") or {}).get("file"))
        ]
    if args.limit and args.limit > 0:
        records = records[: args.limit]

    if args.cleanup_expired_images:
        deleted = _cleanup_expired_images(records, image_dir=image_dir)
        # Persist any updated records.
        for r in records:
            f = r.get("_file")
            if not f:
                continue
            try:
                Path(str(f)).write_text(json.dumps(r, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
        print(f"[cleanup] deleted_expired_images={deleted}")

    if args.format == "json":
        payload: List[Dict[str, Any]] = []
        for r in records:
            rr = dict(r)
            rr.pop("_file", None)
            if not args.include_identity_hash:
                rr.pop("identity_hash", None)
            payload.append(rr)
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        if args.out:
            Path(args.out).write_text(text, encoding="utf-8")
        else:
            print(text)
        return 0

    # CSV
    rows = [_row_from_record(r) for r in records]
    fieldnames = list(ExportRow.__annotations__.keys())
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            for r in rows:
                w.writerow(r.__dict__)
        print(f"[ok] wrote {len(rows)} rows -> {out_path}")
        return 0

    w = csv.DictWriter(
        open(1, "w", encoding="utf-8", newline=""),  # type: ignore[arg-type]
        fieldnames=fieldnames,
    )
    w.writeheader()
    for r in rows:
        w.writerow(r.__dict__)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

