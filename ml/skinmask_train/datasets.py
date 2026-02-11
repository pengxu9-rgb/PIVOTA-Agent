from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

from .label_map import IGNORE_INDEX, remap_dataset_mask, to_binary_skin_mask


SUPPORTED_DATASETS = ("fasseg", "lapa", "celebamaskhq", "acne04")


@dataclass(frozen=True)
class SampleRecord:
    dataset: str
    sample_id: str
    image_path: Path
    split: str
    mask_path: Path | None = None
    part_paths: tuple[tuple[str, Path], ...] = ()


def _normalize_dataset_name(dataset: str) -> str:
    token = str(dataset or "").strip().lower()
    if token in {"celebamask-hq", "celebamask_hq", "celebamaskhq"}:
        return "celebamaskhq"
    if token in {"lapa", "la_pa"}:
        return "lapa"
    if token in {"fasseg", "fasseg-db", "fassegdb"}:
        return "fasseg"
    if token in {"acne04", "acne-04", "acne_db"}:
        return "acne04"
    return token


def parse_datasets(raw: str | Sequence[str]) -> list[str]:
    if isinstance(raw, str):
        tokens = [part.strip() for part in raw.split(",") if part.strip()]
    else:
        tokens = [str(part).strip() for part in raw if str(part).strip()]
    normalized = [_normalize_dataset_name(token) for token in tokens]
    deduped = []
    for token in normalized:
        if token in deduped:
            continue
        if token not in SUPPORTED_DATASETS:
            raise ValueError(f"unsupported_dataset:{token}")
        deduped.append(token)
    return deduped


def _candidate_indexes(cache_external_dir: Path, dataset: str) -> list[Path]:
    dataset_root = cache_external_dir / dataset
    if not dataset_root.exists():
        return []
    indexes = []
    for child in dataset_root.iterdir():
        if not child.is_dir():
            continue
        index_path = child / "dataset_index.jsonl"
        if index_path.is_file():
            indexes.append(index_path)
    indexes.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return indexes


def resolve_dataset_index(cache_external_dir: str | Path, dataset: str) -> Path:
    cache_dir = Path(cache_external_dir).expanduser().resolve()
    candidates = _candidate_indexes(cache_dir, dataset)
    if not candidates:
        raise FileNotFoundError(f"dataset_index_not_found:{dataset}")
    return candidates[0]


def _safe_resolve_under(root: Path, rel_path: str) -> Path | None:
    candidate = (root / rel_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _safe_resolve_from_source_root(source_root: Path | None, rel_path: str) -> Path | None:
    if source_root is None:
        return None
    if not source_root.exists():
        return None
    candidate = (source_root / rel_path).resolve()
    try:
        candidate.relative_to(source_root.resolve())
    except ValueError:
        return None
    return candidate


def _resolve_row_path(root: Path, row: dict, rel_path: str) -> Path | None:
    token = str(rel_path or "").strip()
    if not token:
        return None
    primary = _safe_resolve_under(root, token)
    if primary and primary.exists():
        return primary

    meta = row.get("meta") if isinstance(row, dict) else None
    source_root_raw = None
    if isinstance(meta, dict):
        source_root_raw = meta.get("source_root")
    if source_root_raw:
        source_root = Path(str(source_root_raw)).expanduser()
        secondary = _safe_resolve_from_source_root(source_root, token)
        if secondary and secondary.exists():
            return secondary
    return primary


def _read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            token = line.strip()
            if not token:
                continue
            rows.append(json.loads(token))
    return rows


def _build_records_for_dataset(
    *,
    dataset: str,
    index_path: Path,
    limit: int = 0,
    shuffle: bool = False,
    seed: int = 42,
) -> list[SampleRecord]:
    root = index_path.parent.resolve()
    rows = _read_jsonl(index_path)
    if shuffle:
        rnd = random.Random(seed)
        rnd.shuffle(rows)
    if limit and limit > 0:
        rows = rows[: int(limit)]

    records: list[SampleRecord] = []
    for row in rows:
        image_rel = str(row.get("image_path", "")).strip()
        if not image_rel:
            continue
        image_abs = _resolve_row_path(root, row, image_rel)
        if not image_abs or not image_abs.exists():
            continue
        sample_id = str(row.get("sample_id") or image_rel)
        split = str(row.get("split") or "unknown")

        if dataset == "celebamaskhq":
            raw_parts = row.get("mask_paths")
            part_paths = []
            if isinstance(raw_parts, list):
                for item in raw_parts:
                    if not isinstance(item, dict):
                        continue
                    part = str(item.get("part") or "unknown").strip().lower()
                    rel = str(item.get("path") or "").strip()
                    if not rel:
                        continue
                    abs_path = _resolve_row_path(root, row, rel)
                    if not abs_path or not abs_path.exists():
                        continue
                    part_paths.append((part, abs_path))
            if not part_paths:
                continue
            records.append(
                SampleRecord(
                    dataset=dataset,
                    sample_id=sample_id,
                    image_path=image_abs,
                    split=split,
                    part_paths=tuple(part_paths),
                )
            )
            continue

        mask_rel = str(row.get("mask_path") or row.get("annotation_path") or "").strip()
        if not mask_rel:
            continue
        mask_abs = _resolve_row_path(root, row, mask_rel)
        if not mask_abs or not mask_abs.exists():
            continue
        records.append(
            SampleRecord(
                dataset=dataset,
                sample_id=sample_id,
                image_path=image_abs,
                split=split,
                mask_path=mask_abs,
            )
        )
    return records


def build_records(
    *,
    cache_external_dir: str | Path,
    datasets: Sequence[str],
    limit_per_dataset: int = 0,
    shuffle: bool = False,
    seed: int = 42,
) -> list[SampleRecord]:
    all_records: list[SampleRecord] = []
    for dataset in parse_datasets(datasets):
        index_path = resolve_dataset_index(cache_external_dir, dataset)
        rows = _build_records_for_dataset(
            dataset=dataset,
            index_path=index_path,
            limit=limit_per_dataset,
            shuffle=shuffle,
            seed=seed,
        )
        all_records.extend(rows)
    return all_records


def split_records(records: Sequence[SampleRecord], val_ratio: float = 0.1, seed: int = 42) -> tuple[list[SampleRecord], list[SampleRecord]]:
    per_dataset: Dict[str, list[SampleRecord]] = {}
    for row in records:
        per_dataset.setdefault(row.dataset, []).append(row)
    train_records: list[SampleRecord] = []
    val_records: list[SampleRecord] = []
    rnd = random.Random(seed)
    for dataset, rows in per_dataset.items():
        bucket = list(rows)
        rnd.shuffle(bucket)
        if len(bucket) < 4:
            train_records.extend(bucket)
            continue
        val_count = max(1, int(round(len(bucket) * float(val_ratio))))
        val_count = min(val_count, max(1, len(bucket) // 3))
        val_records.extend(bucket[:val_count])
        train_records.extend(bucket[val_count:])
    rnd.shuffle(train_records)
    rnd.shuffle(val_records)
    return train_records, val_records


def _read_mask_image(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        arr = np.asarray(image)
    if arr.ndim == 3:
        arr = arr[:, :, 0]
    return arr.astype(np.int32)


def _read_part_mask(path: Path, target_shape: tuple[int, int]) -> np.ndarray:
    with Image.open(path) as image:
        mask = image.convert("L")
        if (mask.height, mask.width) != target_shape:
            mask = mask.resize((target_shape[1], target_shape[0]), Image.NEAREST)
        arr = np.asarray(mask, dtype=np.uint8)
    return (arr > 0).astype(np.uint8)


def _load_image(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGB")


def collect_record_stats(records: Sequence[SampleRecord]) -> dict:
    by_dataset: Dict[str, int] = {}
    for row in records:
        by_dataset[row.dataset] = by_dataset.get(row.dataset, 0) + 1
    return {
        "total": len(records),
        "by_dataset": by_dataset,
    }


class MultiDatasetSegDataset(Dataset):
    def __init__(
        self,
        records: Sequence[SampleRecord],
        *,
        transform=None,
        binary_skin: bool = True,
    ) -> None:
        self.records = list(records)
        self.transform = transform
        self.binary_skin = bool(binary_skin)

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> dict:
        record = self.records[index]
        image = _load_image(record.image_path)
        image_h, image_w = image.height, image.width

        if record.dataset == "celebamaskhq":
            part_masks = {}
            for part_name, part_path in record.part_paths:
                part_masks[part_name] = _read_part_mask(part_path, (image_h, image_w))
            mask = remap_dataset_mask(
                "celebamaskhq",
                part_masks=part_masks,
                image_shape=(image_h, image_w),
            )
        elif record.mask_path:
            raw_mask = _read_mask_image(record.mask_path)
            if raw_mask.shape != (image_h, image_w):
                raw_mask = np.asarray(
                    Image.fromarray(raw_mask.astype(np.uint8), mode="L").resize((image_w, image_h), Image.NEAREST),
                    dtype=np.int32,
                )
            mask = remap_dataset_mask(record.dataset, mask=raw_mask)
        else:
            mask = np.full((image_h, image_w), IGNORE_INDEX, dtype=np.uint8)

        if self.binary_skin:
            mask = to_binary_skin_mask(mask, preserve_ignore_index=True)

        if self.transform is not None:
            image, mask = self.transform(image, mask)

        return {
            "image": image,
            "mask": mask.astype(np.uint8),
            "sample_id": record.sample_id,
            "dataset": record.dataset,
            "split": record.split,
            "image_path": str(record.image_path),
        }


def collate_for_segformer(batch: Iterable[dict], image_processor):
    rows = list(batch)
    images = [row["image"] for row in rows]
    masks = [row["mask"] for row in rows]
    encoded = image_processor(
        images=images,
        segmentation_maps=masks,
        return_tensors="pt",
    )
    encoded["sample_id"] = [row["sample_id"] for row in rows]
    encoded["dataset"] = [row["dataset"] for row in rows]
    return encoded


def to_device(batch: dict, device: torch.device) -> dict:
    moved = {}
    for key, value in batch.items():
        if torch.is_tensor(value):
            moved[key] = value.to(device)
        else:
            moved[key] = value
    return moved
