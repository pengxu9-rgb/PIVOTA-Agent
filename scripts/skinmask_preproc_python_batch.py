#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import io
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ml.skinmask_train.preprocess import (
    channel_stats_from_nchw,
    create_train_image_processor,
    preprocess_pil_image,
    schema_skin_class_id,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch Python-side preprocess+inference stats for skinmask debug.")
    parser.add_argument("--manifest", required=True, help="JSON file of samples: [{sample_hash,crop_b64}]")
    parser.add_argument("--onnx", required=True, help="ONNX model path.")
    parser.add_argument(
        "--backbone_name",
        default="nvidia/segformer-b0-finetuned-ade-512-512",
        help="Backbone used by training-side AutoImageProcessor.",
    )
    parser.add_argument("--schema", default="", help="Optional schema json path. Defaults to <onnx>.schema.json.")
    return parser.parse_args()


def load_schema(onnx_path: Path, explicit_schema_path: str) -> dict[str, Any]:
    if explicit_schema_path:
        schema_path = Path(explicit_schema_path).expanduser().resolve()
    else:
        if onnx_path.suffix.lower() == ".onnx":
            schema_path = onnx_path.with_suffix(".schema.json")
        else:
            schema_path = Path(f"{onnx_path.as_posix()}.schema.json")
    if schema_path.exists() and schema_path.is_file():
        with schema_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    return {}


def parse_logits(
    logits: np.ndarray,
    *,
    output_type: str,
    skin_class_id: int,
) -> tuple[float, float]:
    payload = np.asarray(logits)
    if payload.ndim != 4:
        raise ValueError(f"unexpected_logits_rank:{payload.shape}")
    dims = payload.shape
    channels_first = False
    if 1 <= dims[1] <= 64:
        channels_first = True
        channels = int(dims[1])
        h = int(dims[2])
        w = int(dims[3])
        data = payload[0].transpose(1, 2, 0)  # HWC
    elif 1 <= dims[3] <= 64:
        channels = int(dims[3])
        h = int(dims[1])
        w = int(dims[2])
        data = payload[0]  # HWC
    else:
        raise ValueError(f"unsupported_logits_layout:{payload.shape}")
    if h <= 0 or w <= 0 or channels <= 0:
        raise ValueError(f"invalid_logits_shape:{payload.shape}")
    skin_id = max(0, min(channels - 1, int(skin_class_id)))
    out_type = str(output_type or "softmax").strip().lower()

    if out_type == "sigmoid":
        skin_logits = data[:, :, skin_id]
        skin_probs = 1.0 / (1.0 + np.exp(-np.clip(skin_logits, -40.0, 40.0)))
        pred_skin = skin_probs >= 0.5
        return float(np.mean(skin_probs)), float(np.mean(pred_skin))

    shifted = data - np.max(data, axis=2, keepdims=True)
    expd = np.exp(np.clip(shifted, -40.0, 40.0))
    denom = np.sum(expd, axis=2, keepdims=True)
    probs = expd / np.clip(denom, 1e-8, None)
    skin_probs = probs[:, :, skin_id]
    pred_skin = np.argmax(data, axis=2) == skin_id
    return float(np.mean(skin_probs)), float(np.mean(pred_skin))


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest).expanduser().resolve()
    onnx_path = Path(args.onnx).expanduser().resolve()
    if not manifest_path.exists():
        raise FileNotFoundError(f"manifest_not_found:{manifest_path}")
    if not onnx_path.exists():
        raise FileNotFoundError(f"onnx_not_found:{onnx_path}")

    with manifest_path.open("r", encoding="utf-8") as handle:
        samples = json.load(handle)
    if not isinstance(samples, list):
        raise ValueError("manifest_must_be_array")

    schema = load_schema(onnx_path, args.schema)
    output = schema.get("output") if isinstance(schema.get("output"), dict) else {}
    output_type = str(output.get("type") or "softmax").strip().lower()
    skin_class_id = schema_skin_class_id(schema, fallback=1)

    image_processor = create_train_image_processor(args.backbone_name)
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    rows = []
    for item in samples:
        sample_hash = str((item or {}).get("sample_hash") or "")
        crop_b64 = str((item or {}).get("crop_b64") or "")
        row: dict[str, Any] = {
            "sample_hash": sample_hash,
            "ok": False,
            "fail_reason": None,
            "resize_shape": None,
            "channel_stats": None,
            "skin_prob_mean": None,
            "pred_skin_ratio": None,
        }
        if not sample_hash or not crop_b64:
            row["fail_reason"] = "INVALID_INPUT"
            rows.append(row)
            continue
        try:
            image_bytes = base64.b64decode(crop_b64)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            pixel_values = preprocess_pil_image(image, image_processor)
            stats = channel_stats_from_nchw(pixel_values)
            outputs = session.run(None, {input_name: pixel_values.astype(np.float32, copy=False)})
            if not outputs:
                raise ValueError("onnx_output_missing")
            skin_prob_mean, pred_skin_ratio = parse_logits(
                np.asarray(outputs[0]),
                output_type=output_type,
                skin_class_id=skin_class_id,
            )
            row["ok"] = True
            row["resize_shape"] = [int(pixel_values.shape[2]), int(pixel_values.shape[3])]
            row["channel_stats"] = stats
            row["skin_prob_mean"] = skin_prob_mean
            row["pred_skin_ratio"] = pred_skin_ratio
        except Exception as error:  # noqa: BLE001
            row["fail_reason"] = str(error)
        rows.append(row)

    payload = {
        "ok": True,
        "rows": rows,
        "schema": {
            "output_type": output_type,
            "skin_class_id": int(skin_class_id),
        },
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
