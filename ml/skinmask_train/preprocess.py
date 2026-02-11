from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image
from transformers import AutoImageProcessor


def create_train_image_processor(backbone_name: str):
    processor = AutoImageProcessor.from_pretrained(backbone_name)
    if hasattr(processor, "do_reduce_labels"):
        processor.do_reduce_labels = False
    return processor


def preprocess_pil_image(image: Image.Image, image_processor) -> np.ndarray:
    encoded = image_processor(images=image, return_tensors="pt")
    pixel_values = encoded.get("pixel_values")
    if pixel_values is None:
        raise ValueError("pixel_values_missing")
    if hasattr(pixel_values, "detach"):
        array = pixel_values.detach().cpu().numpy()
    else:
        array = np.asarray(pixel_values)
    if array.ndim != 4 or array.shape[0] != 1 or array.shape[1] != 3:
        raise ValueError(f"unexpected_pixel_values_shape:{tuple(array.shape)}")
    return array.astype(np.float32, copy=False)


def channel_stats_from_nchw(pixel_values: np.ndarray) -> list[dict[str, float]]:
    if pixel_values.ndim != 4 or pixel_values.shape[0] != 1 or pixel_values.shape[1] != 3:
        raise ValueError(f"unexpected_pixel_values_shape:{tuple(pixel_values.shape)}")
    stats = []
    for channel in range(3):
        data = pixel_values[0, channel]
        stats.append(
            {
                "min": float(np.min(data)),
                "max": float(np.max(data)),
                "mean": float(np.mean(data)),
                "std": float(np.std(data)),
            }
        )
    return stats


def schema_skin_class_id(schema: dict[str, Any] | None, fallback: int = 1) -> int:
    payload = schema if isinstance(schema, dict) else {}
    output = payload.get("output")
    if not isinstance(output, dict):
        return int(fallback)
    classes = output.get("classes")
    skin_class = str(output.get("skin_class") or "skin").strip()
    if isinstance(classes, list):
        normalized = [str(item) for item in classes]
        if skin_class in normalized:
            return normalized.index(skin_class)
    try:
        token = int(output.get("skin_class_id"))
    except (TypeError, ValueError):
        token = int(fallback)
    return max(0, token)
