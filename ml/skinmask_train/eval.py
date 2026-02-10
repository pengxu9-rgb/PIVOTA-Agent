#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader
from transformers import AutoImageProcessor, SegformerForSemanticSegmentation

from .augment import build_eval_transform
from .datasets import (
    MultiDatasetSegDataset,
    build_records,
    collate_for_segformer,
    parse_datasets,
    split_records,
    to_device,
)
from .label_map import CLASS_TO_ID, IGNORE_INDEX


@dataclass
class EvalAccum:
    samples_total: int = 0
    samples_ok: int = 0
    iou_sum: float = 0.0
    coverage_sum: float = 0.0
    leakage_sum: float = 0.0

    def add(self, *, iou: float, coverage: float, leakage: float) -> None:
        self.samples_total += 1
        self.samples_ok += 1
        self.iou_sum += float(iou)
        self.coverage_sum += float(coverage)
        self.leakage_sum += float(leakage)

    def as_summary(self) -> dict:
        denom = max(1, self.samples_ok)
        return {
            "samples_total": int(self.samples_total),
            "samples_ok": int(self.samples_ok),
            "samples_failed": int(max(0, self.samples_total - self.samples_ok)),
            "miou_skin": float(self.iou_sum / denom),
            "coverage_skin": float(self.coverage_sum / denom),
            "leakage_skin": float(self.leakage_sum / denom),
            "module_miou_mean": float(self.iou_sum / denom),
            "leakage_mean": float(self.leakage_sum / denom),
            "face_detect_fail_rate": 0.0,
        }


def now_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate Aurora skinmask model on prepared datasets.")
    parser.add_argument("--cache_dir", default="datasets_cache/external")
    parser.add_argument("--datasets", default="fasseg,lapa,celebamaskhq")
    parser.add_argument("--limit_per_dataset", type=int, default=0)
    parser.add_argument("--val_ratio", type=float, default=0.12)
    parser.add_argument("--split", choices=["all", "train", "val"], default="val")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch_size", type=int, default=8)
    parser.add_argument("--num_workers", type=int, default=4)
    parser.add_argument("--image_size", type=int, default=512)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--checkpoint", required=True, help="Checkpoint dir containing hf_model and hf_processor.")
    parser.add_argument("--report_dir", default="reports")
    parser.add_argument("--out_json", default="")
    return parser.parse_args()


def pick_device(token: str) -> torch.device:
    normalized = str(token or "auto").strip().lower()
    if normalized == "cpu":
        return torch.device("cpu")
    if normalized == "cuda":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def resolve_model_dirs(checkpoint_input: str) -> tuple[Path, Path]:
    base = Path(checkpoint_input).expanduser().resolve()
    if base.is_dir():
        if (base / "hf_model").is_dir() and (base / "hf_processor").is_dir():
            return base / "hf_model", base / "hf_processor"
        if (base / "config.json").is_file():
            if (base.parent / "hf_processor").is_dir():
                return base, base.parent / "hf_processor"
            return base, base
    raise FileNotFoundError("checkpoint_dir_missing_hf_model_or_hf_processor")


def safe_ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return float(numerator) / float(denominator)


@torch.no_grad()
def evaluate(model, loader: DataLoader, device: torch.device) -> dict:
    model.eval()
    skin_id = CLASS_TO_ID["skin"]
    accum = EvalAccum()

    for batch in loader:
        batch = to_device(batch, device)
        outputs = model(pixel_values=batch["pixel_values"], labels=batch["labels"])
        logits = outputs.logits
        labels = batch["labels"]
        if logits.shape[-2:] != labels.shape[-2:]:
            logits = torch.nn.functional.interpolate(
                logits,
                size=labels.shape[-2:],
                mode="bilinear",
                align_corners=False,
            )
        pred = torch.argmax(logits, dim=1)

        for idx in range(pred.shape[0]):
            pred_mask = pred[idx]
            gt_mask = labels[idx]
            valid = gt_mask != IGNORE_INDEX
            if torch.count_nonzero(valid).item() == 0:
                accum.samples_total += 1
                continue

            pred_skin = (pred_mask == skin_id) & valid
            gt_skin = (gt_mask == skin_id) & valid

            intersection = torch.count_nonzero(pred_skin & gt_skin).item()
            union = torch.count_nonzero(pred_skin | gt_skin).item()
            gt_count = torch.count_nonzero(gt_skin).item()
            pred_count = torch.count_nonzero(pred_skin).item()
            non_skin = valid & (~gt_skin)
            leakage_pixels = torch.count_nonzero(pred_skin & non_skin).item()

            accum.add(
                iou=safe_ratio(intersection, union),
                coverage=safe_ratio(intersection, gt_count),
                leakage=safe_ratio(leakage_pixels, pred_count),
            )

    return accum.as_summary()


def build_markdown(summary: dict, args: argparse.Namespace, model_dir: Path) -> str:
    lines = [
        "# Skinmask Segmentation Eval",
        "",
        f"- generated_at: {datetime.now(timezone.utc).isoformat()}",
        f"- checkpoint: `{model_dir.as_posix()}`",
        f"- datasets: {','.join(parse_datasets(args.datasets))}",
        f"- split: {args.split}",
        f"- samples_total: {summary['samples_total']}",
        f"- samples_ok: {summary['samples_ok']}",
        f"- samples_failed: {summary['samples_failed']}",
        f"- miou_skin: {round(summary['miou_skin'], 4)}",
        f"- coverage_skin: {round(summary['coverage_skin'], 4)}",
        f"- leakage_skin: {round(summary['leakage_skin'], 4)}",
        "",
        "## Eval-Circle Compatible Keys",
        "",
        f"- module_miou_mean: {round(summary['module_miou_mean'], 4)}",
        f"- leakage_mean: {round(summary['leakage_mean'], 4)}",
        f"- face_detect_fail_rate: {round(summary['face_detect_fail_rate'], 4)}",
        "",
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    set_seed(args.seed)
    device = pick_device(args.device)
    model_dir, processor_dir = resolve_model_dirs(args.checkpoint)

    records = build_records(
        cache_external_dir=args.cache_dir,
        datasets=parse_datasets(args.datasets),
        limit_per_dataset=args.limit_per_dataset,
        shuffle=True,
        seed=args.seed,
    )
    if not records:
        raise RuntimeError("no_records_found_for_eval")
    train_records, val_records = split_records(records, val_ratio=args.val_ratio, seed=args.seed)
    if args.split == "train":
        eval_records = train_records
    elif args.split == "val":
        eval_records = val_records
    else:
        eval_records = list(records)

    if not eval_records:
        raise RuntimeError(f"empty_eval_split:{args.split}")

    dataset = MultiDatasetSegDataset(eval_records, transform=build_eval_transform(args.image_size))

    image_processor = AutoImageProcessor.from_pretrained(str(processor_dir))
    if hasattr(image_processor, "do_reduce_labels"):
        image_processor.do_reduce_labels = False
    loader = DataLoader(
        dataset,
        batch_size=max(1, int(args.batch_size)),
        shuffle=False,
        num_workers=max(0, int(args.num_workers)),
        collate_fn=lambda rows: collate_for_segformer(rows, image_processor),
        pin_memory=device.type == "cuda",
    )

    model = SegformerForSemanticSegmentation.from_pretrained(str(model_dir))
    if hasattr(model.config, "semantic_loss_ignore_index"):
        model.config.semantic_loss_ignore_index = IGNORE_INDEX
    model.to(device)

    summary = evaluate(model, loader, device)
    summary["ok"] = True
    summary["device"] = str(device)
    summary["split"] = args.split
    summary["checkpoint"] = str(model_dir.as_posix())

    report_dir = Path(args.report_dir).expanduser().resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    run_key = now_key()
    out_json = Path(args.out_json).expanduser().resolve() if args.out_json else report_dir / f"skinmask_eval_{run_key}.json"
    out_md = report_dir / f"skinmask_eval_{run_key}.md"
    out_json.write_text(f"{json.dumps(summary, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    out_md.write_text(build_markdown(summary, args, model_dir), encoding="utf-8")

    payload = {
        "ok": True,
        "summary_json": out_json.as_posix(),
        "summary_md": out_md.as_posix(),
        **summary,
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
