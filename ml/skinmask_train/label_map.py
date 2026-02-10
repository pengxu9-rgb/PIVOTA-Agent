from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Mapping

import numpy as np

IGNORE_INDEX = 255

UNIFIED_CLASSES = (
    "background",
    "skin",
    "hair",
    "eyes",
    "nose",
    "mouth",
)

CLASS_TO_ID = {name: index for index, name in enumerate(UNIFIED_CLASSES)}
ID_TO_CLASS = {index: name for name, index in CLASS_TO_ID.items()}


@dataclass(frozen=True)
class LabelSpace:
    dataset: str
    classes: tuple[str, ...]
    ignore_index: int = IGNORE_INDEX


LABEL_SPACES: Dict[str, LabelSpace] = {
    "lapa": LabelSpace(dataset="lapa", classes=UNIFIED_CLASSES),
    "celebamaskhq": LabelSpace(dataset="celebamaskhq", classes=UNIFIED_CLASSES),
    "fasseg": LabelSpace(dataset="fasseg", classes=UNIFIED_CLASSES),
    "acne04": LabelSpace(dataset="acne04", classes=UNIFIED_CLASSES),
}


def normalize_dataset_name(dataset: str) -> str:
    token = str(dataset or "").strip().lower()
    if token in {"celebamask-hq", "celebamask_hq", "celebamaskhq"}:
        return "celebamaskhq"
    if token in {"la_pa", "lapa"}:
        return "lapa"
    if token in {"fasseg", "fasseg-db", "fassegdb"}:
        return "fasseg"
    if token in {"acne04", "acne-04", "acne_db"}:
        return "acne04"
    return token


def _new_mask_like(mask: np.ndarray, fill: int = IGNORE_INDEX) -> np.ndarray:
    out = np.full(mask.shape, int(fill), dtype=np.uint8)
    return out


def _assign_labels(out: np.ndarray, source: np.ndarray, label_values: Iterable[int], class_id: int) -> None:
    if out.shape != source.shape:
        raise ValueError("shape_mismatch")
    for label_value in label_values:
        out[source == int(label_value)] = np.uint8(class_id)


def remap_lapa(mask: np.ndarray) -> np.ndarray:
    if mask.ndim != 2:
        raise ValueError("lapa_mask_must_be_2d")
    out = _new_mask_like(mask)
    out[mask == 0] = CLASS_TO_ID["background"]
    _assign_labels(out, mask, [1], CLASS_TO_ID["skin"])
    _assign_labels(out, mask, [17], CLASS_TO_ID["hair"])
    _assign_labels(out, mask, [4, 5], CLASS_TO_ID["eyes"])
    _assign_labels(out, mask, [10], CLASS_TO_ID["nose"])
    _assign_labels(out, mask, [11, 12, 13], CLASS_TO_ID["mouth"])
    return out


def remap_fasseg(mask: np.ndarray) -> np.ndarray:
    if mask.ndim != 2:
        raise ValueError("fasseg_mask_must_be_2d")
    out = _new_mask_like(mask)
    out[mask == 0] = CLASS_TO_ID["background"]
    _assign_labels(out, mask, [1], CLASS_TO_ID["skin"])
    _assign_labels(out, mask, [2], CLASS_TO_ID["hair"])
    return out


def remap_celebamask_parts(part_masks: Mapping[str, np.ndarray], image_shape: tuple[int, int]) -> np.ndarray:
    out = np.full(image_shape, CLASS_TO_ID["background"], dtype=np.uint8)
    if not part_masks:
        return out

    unknown_part_positive = np.zeros(image_shape, dtype=bool)
    normalized = {str(key).strip().lower(): np.asarray(value).astype(bool) for key, value in part_masks.items()}
    known_parts = {
        "skin",
        "hair",
        "l_eye",
        "r_eye",
        "l_brow",
        "r_brow",
        "nose",
        "mouth",
        "u_lip",
        "l_lip",
    }
    for part_name, part_mask in normalized.items():
        if part_mask.shape != image_shape:
            raise ValueError("celebamask_part_shape_mismatch")
        if part_name not in known_parts:
            unknown_part_positive |= part_mask

    if "skin" in normalized:
        out[normalized["skin"]] = CLASS_TO_ID["skin"]
    if "hair" in normalized:
        out[normalized["hair"]] = CLASS_TO_ID["hair"]

    eye_mask = np.zeros(image_shape, dtype=bool)
    for part_name in ("l_eye", "r_eye", "l_brow", "r_brow"):
        if part_name in normalized:
            eye_mask |= normalized[part_name]
    out[eye_mask] = CLASS_TO_ID["eyes"]

    if "nose" in normalized:
        out[normalized["nose"]] = CLASS_TO_ID["nose"]

    mouth_mask = np.zeros(image_shape, dtype=bool)
    for part_name in ("mouth", "u_lip", "l_lip"):
        if part_name in normalized:
            mouth_mask |= normalized[part_name]
    out[mouth_mask] = CLASS_TO_ID["mouth"]

    out[unknown_part_positive] = np.uint8(IGNORE_INDEX)
    return out


def remap_dataset_mask(
    dataset: str,
    *,
    mask: np.ndarray | None = None,
    part_masks: Mapping[str, np.ndarray] | None = None,
    image_shape: tuple[int, int] | None = None,
) -> np.ndarray:
    name = normalize_dataset_name(dataset)
    if name == "lapa":
        if mask is None:
            raise ValueError("lapa_mask_missing")
        return remap_lapa(mask)
    if name == "fasseg":
        if mask is None:
            raise ValueError("fasseg_mask_missing")
        return remap_fasseg(mask)
    if name == "celebamaskhq":
        if image_shape is None:
            if mask is not None and mask.ndim == 2:
                image_shape = (int(mask.shape[0]), int(mask.shape[1]))
            elif part_masks:
                first = next(iter(part_masks.values()))
                image_shape = (int(first.shape[0]), int(first.shape[1]))
            else:
                raise ValueError("celebamask_shape_missing")
        return remap_celebamask_parts(part_masks or {}, image_shape)
    if name == "acne04":
        if mask is None:
            raise ValueError("acne04_mask_missing")
        out = np.full(mask.shape, np.uint8(IGNORE_INDEX), dtype=np.uint8)
        out[mask == 0] = CLASS_TO_ID["background"]
        return out
    raise ValueError(f"unsupported_dataset:{dataset}")


def to_binary_skin_mask(unified_mask: np.ndarray, *, include_unknown_as_non_skin: bool = True) -> np.ndarray:
    if unified_mask.ndim != 2:
        raise ValueError("unified_mask_must_be_2d")
    skin = (unified_mask == CLASS_TO_ID["skin"]).astype(np.uint8)
    if include_unknown_as_non_skin:
        return skin
    unknown = unified_mask == IGNORE_INDEX
    skin[unknown] = 0
    return skin

