#!/usr/bin/env python3
from __future__ import annotations

import argparse
from functools import partial
import json
import math
import os
import random
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from torch.optim import AdamW
from torch.utils.data import DataLoader
from transformers import AutoImageProcessor, SegformerForSemanticSegmentation, get_linear_schedule_with_warmup

from .augment import build_eval_transform, build_train_augment
from .datasets import (
    MultiDatasetSegDataset,
    build_records,
    collate_for_segformer,
    collect_record_stats,
    parse_datasets,
    split_records,
    to_device,
)
from .label_map import CLASS_TO_ID, ID_TO_CLASS, IGNORE_INDEX, UNIFIED_CLASSES


def now_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = False
    torch.backends.cudnn.benchmark = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Aurora skinmask segmentation model (SegFormer-B0).")
    parser.add_argument("--cache_dir", default="datasets_cache/external", help="Prepared datasets cache root.")
    parser.add_argument("--datasets", default="fasseg,lapa,celebamaskhq", help="Comma-separated dataset names.")
    parser.add_argument("--limit_per_dataset", type=int, default=0, help="Limit per dataset (0 means all).")
    parser.add_argument("--epochs", type=int, default=8, help="Training epochs.")
    parser.add_argument("--batch_size", type=int, default=8, help="Batch size.")
    parser.add_argument("--num_workers", type=int, default=4, help="Dataloader workers.")
    parser.add_argument("--lr", type=float, default=3e-5, help="Learning rate.")
    parser.add_argument("--weight_decay", type=float, default=1e-4, help="Weight decay.")
    parser.add_argument("--warmup_ratio", type=float, default=0.05, help="Warmup ratio.")
    parser.add_argument("--val_ratio", type=float, default=0.12, help="Validation split ratio.")
    parser.add_argument("--image_size", type=int, default=512, help="Train/eval image size.")
    parser.add_argument("--seed", type=int, default=42, help="Random seed.")
    parser.add_argument("--device", default="auto", help="cuda|cpu|auto")
    parser.add_argument("--out_dir", default="outputs/skinmask_train", help="Output directory.")
    parser.add_argument(
        "--backbone_name",
        default="nvidia/segformer-b0-finetuned-ade-512-512",
        help="Pretrained model backbone (default SegFormer-B0).",
    )
    parser.add_argument("--save_every", type=int, default=1, help="Epoch interval for checkpoint snapshots.")
    parser.add_argument("--max_steps", type=int, default=0, help="Optional global max optimizer steps.")
    return parser.parse_args()


def pick_device(token: str) -> torch.device:
    normalized = str(token or "auto").strip().lower()
    if normalized == "cpu":
        return torch.device("cpu")
    if normalized == "cuda":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def safe_ratio(num: float, den: float) -> float:
    return num / den if den > 0 else 0.0


@torch.no_grad()
def evaluate(model, loader: DataLoader, device: torch.device) -> dict:
    model.eval()
    total_loss = 0.0
    total_batches = 0
    iou_values = []
    coverage_values = []
    leakage_values = []

    skin_id = CLASS_TO_ID["skin"]

    for batch in loader:
        batch = to_device(batch, device)
        outputs = model(pixel_values=batch["pixel_values"], labels=batch["labels"])
        loss = outputs.loss
        if torch.is_tensor(loss):
            total_loss += float(loss.detach().cpu().item())
            total_batches += 1

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
                continue
            pred_skin = (pred_mask == skin_id) & valid
            gt_skin = (gt_mask == skin_id) & valid
            intersection = torch.count_nonzero(pred_skin & gt_skin).item()
            union = torch.count_nonzero(pred_skin | gt_skin).item()
            gt_count = torch.count_nonzero(gt_skin).item()
            pred_count = torch.count_nonzero(pred_skin).item()
            non_skin = valid & (~gt_skin)
            leakage_pixels = torch.count_nonzero(pred_skin & non_skin).item()
            iou_values.append(safe_ratio(intersection, union))
            coverage_values.append(safe_ratio(intersection, gt_count))
            leakage_values.append(safe_ratio(leakage_pixels, pred_count))

    model.train()
    return {
        "loss": total_loss / total_batches if total_batches else 0.0,
        "miou_skin": float(np.mean(iou_values)) if iou_values else 0.0,
        "coverage_skin": float(np.mean(coverage_values)) if coverage_values else 0.0,
        "leakage_skin": float(np.mean(leakage_values)) if leakage_values else 0.0,
        "samples": len(iou_values),
    }


def round4(value: float) -> float:
    return float(round(float(value), 4))


def save_checkpoint(
    *,
    out_dir: Path,
    name: str,
    model,
    image_processor,
    args: argparse.Namespace,
    epoch: int,
    step: int,
    metrics: dict,
) -> dict:
    ckpt_dir = out_dir / name
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(ckpt_dir / "hf_model")
    image_processor.save_pretrained(ckpt_dir / "hf_processor")

    payload = {
        "schema_version": "aurora.skinmask.train.v1",
        "epoch": int(epoch),
        "step": int(step),
        "metrics": metrics,
        "backbone_name": args.backbone_name,
        "num_labels": len(UNIFIED_CLASSES),
        "classes": list(UNIFIED_CLASSES),
        "ignore_index": IGNORE_INDEX,
        "model_dir": str((ckpt_dir / "hf_model").as_posix()),
        "processor_dir": str((ckpt_dir / "hf_processor").as_posix()),
    }
    torch.save(payload, ckpt_dir / "checkpoint.pt")
    with (ckpt_dir / "checkpoint.json").open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    return payload


def main() -> None:
    args = parse_args()
    set_seed(args.seed)

    device = pick_device(args.device)
    datasets = parse_datasets(args.datasets)
    out_root = Path(args.out_dir).expanduser().resolve()
    run_dir = out_root / f"run_{now_key()}"
    run_dir.mkdir(parents=True, exist_ok=True)

    records = build_records(
        cache_external_dir=args.cache_dir,
        datasets=datasets,
        limit_per_dataset=args.limit_per_dataset,
        shuffle=True,
        seed=args.seed,
    )
    if not records:
        raise RuntimeError("no_records_found_for_training")

    train_records, val_records = split_records(records, val_ratio=args.val_ratio, seed=args.seed)
    if not train_records:
        raise RuntimeError("empty_train_split")

    train_dataset = MultiDatasetSegDataset(train_records, transform=build_train_augment(args.image_size))
    val_dataset = MultiDatasetSegDataset(val_records, transform=build_eval_transform(args.image_size)) if val_records else None

    image_processor = AutoImageProcessor.from_pretrained(args.backbone_name)
    if hasattr(image_processor, "do_reduce_labels"):
        image_processor.do_reduce_labels = False
    collate_fn = partial(collate_for_segformer, image_processor=image_processor)

    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=max(0, int(args.num_workers)),
        collate_fn=collate_fn,
        pin_memory=device.type == "cuda",
    )
    val_loader = (
        DataLoader(
            val_dataset,
            batch_size=max(1, args.batch_size // 2),
            shuffle=False,
            num_workers=max(0, int(args.num_workers)),
            collate_fn=collate_fn,
            pin_memory=device.type == "cuda",
        )
        if val_dataset
        else None
    )

    model = SegformerForSemanticSegmentation.from_pretrained(
        args.backbone_name,
        num_labels=len(UNIFIED_CLASSES),
        id2label=ID_TO_CLASS,
        label2id=CLASS_TO_ID,
        ignore_mismatched_sizes=True,
    )
    if hasattr(model.config, "semantic_loss_ignore_index"):
        model.config.semantic_loss_ignore_index = IGNORE_INDEX
    model.to(device)
    model.train()

    optimizer = AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    total_steps = args.max_steps if args.max_steps and args.max_steps > 0 else args.epochs * max(1, len(train_loader))
    warmup_steps = int(round(total_steps * max(0.0, min(0.5, float(args.warmup_ratio)))))
    scheduler = get_linear_schedule_with_warmup(optimizer, warmup_steps, max(1, total_steps))

    best_key = -math.inf
    best_payload = None
    global_step = 0
    history = []

    for epoch in range(1, args.epochs + 1):
        epoch_loss = 0.0
        epoch_batches = 0
        for batch in train_loader:
            batch = to_device(batch, device)
            outputs = model(pixel_values=batch["pixel_values"], labels=batch["labels"])
            loss = outputs.loss
            loss.backward()
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)

            global_step += 1
            epoch_loss += float(loss.detach().cpu().item())
            epoch_batches += 1
            if args.max_steps and args.max_steps > 0 and global_step >= args.max_steps:
                break

        train_loss = epoch_loss / epoch_batches if epoch_batches else 0.0
        val_metrics = evaluate(model, val_loader, device) if val_loader else {
            "loss": 0.0,
            "miou_skin": 0.0,
            "coverage_skin": 0.0,
            "leakage_skin": 1.0,
            "samples": 0,
        }

        row = {
            "epoch": epoch,
            "step": global_step,
            "train_loss": round4(train_loss),
            "val_loss": round4(val_metrics["loss"]),
            "val_miou_skin": round4(val_metrics["miou_skin"]),
            "val_coverage_skin": round4(val_metrics["coverage_skin"]),
            "val_leakage_skin": round4(val_metrics["leakage_skin"]),
            "val_samples": int(val_metrics["samples"]),
        }
        history.append(row)

        key_score = float(val_metrics["miou_skin"]) - float(val_metrics["leakage_skin"]) * 0.5
        if key_score > best_key:
            best_key = key_score
            best_payload = save_checkpoint(
                out_dir=run_dir,
                name="best",
                model=model,
                image_processor=image_processor,
                args=args,
                epoch=epoch,
                step=global_step,
                metrics=row,
            )

        if epoch % max(1, args.save_every) == 0:
            save_checkpoint(
                out_dir=run_dir,
                name=f"epoch_{epoch:03d}",
                model=model,
                image_processor=image_processor,
                args=args,
                epoch=epoch,
                step=global_step,
                metrics=row,
            )

        if args.max_steps and args.max_steps > 0 and global_step >= args.max_steps:
            break

    last_payload = save_checkpoint(
        out_dir=run_dir,
        name="last",
        model=model,
        image_processor=image_processor,
        args=args,
        epoch=history[-1]["epoch"] if history else 0,
        step=global_step,
        metrics=history[-1] if history else {},
    )

    train_stats = collect_record_stats(train_records)
    val_stats = collect_record_stats(val_records)
    summary = {
        "ok": True,
        "run_dir": str(run_dir.as_posix()),
        "device": str(device),
        "datasets": datasets,
        "records": {
            "train": train_stats,
            "val": val_stats,
        },
        "best_checkpoint": best_payload["model_dir"] if best_payload else None,
        "last_checkpoint": last_payload["model_dir"],
        "history": history,
    }
    with (run_dir / "train_summary.json").open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
