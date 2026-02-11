#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from transformers import SegformerForSemanticSegmentation
from ml.skinmask_train.label_map import SKIN_BINARY_CLASSES, skin_class_id_from_schema, write_skinmask_schema


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export Aurora skinmask SegFormer checkpoint to ONNX.")
    parser.add_argument("--ckpt", required=True, help="Checkpoint dir (hf_model) or run dir containing hf_model.")
    parser.add_argument("--out", default="artifacts/skinmask_v2.onnx", help="ONNX output path.")
    parser.add_argument("--image_size", type=int, default=512, help="Dummy export input size.")
    parser.add_argument("--opset", type=int, default=17, help="ONNX opset.")
    parser.add_argument("--schema_out", default="", help="Optional explicit schema output path.")
    return parser.parse_args()


def resolve_model_dir(raw: str) -> Path:
    base = Path(raw).expanduser().resolve()
    if base.is_dir() and (base / "config.json").is_file():
        return base
    if base.is_dir() and (base / "hf_model").is_dir():
        return base / "hf_model"
    raise FileNotFoundError("ckpt_not_found_or_missing_hf_model")


def main() -> None:
    args = parse_args()
    model_dir = resolve_model_dir(args.ckpt)
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image_size = max(64, int(args.image_size))

    model = SegformerForSemanticSegmentation.from_pretrained(str(model_dir))
    model.eval()

    dummy = torch.randn(1, 3, image_size, image_size, dtype=torch.float32)
    dynamic_axes = {
        "pixel_values": {0: "batch", 2: "height", 3: "width"},
        "logits": {0: "batch", 2: "height_out", 3: "width_out"},
    }
    with torch.no_grad():
        torch.onnx.export(
            model,
            (dummy,),
            str(out_path),
            input_names=["pixel_values"],
            output_names=["logits"],
            dynamic_axes=dynamic_axes,
            do_constant_folding=True,
            opset_version=max(13, int(args.opset)),
        )

    schema_path = (
        Path(args.schema_out).expanduser().resolve()
        if str(args.schema_out or "").strip()
        else out_path.with_suffix(".schema.json")
    )
    schema = write_skinmask_schema(
        schema_path,
        size=(image_size, image_size),
        output_type="sigmoid",
        classes=SKIN_BINARY_CLASSES,
    )

    meta = {
        "ok": True,
        "schema_version": "aurora.skinmask.onnx_export.v1",
        "checkpoint_model_dir": model_dir.as_posix(),
        "onnx_path": out_path.as_posix(),
        "schema_path": schema_path.as_posix(),
        "skin_class_id": int(skin_class_id_from_schema(schema)),
        "input": {"name": "pixel_values", "shape": ["batch", 3, "height", "width"], "dtype": "float32"},
        "output": {"name": "logits", "shape": ["batch", 1, "height_out", "width_out"], "dtype": "float32"},
        "opset": max(13, int(args.opset)),
    }
    meta_path = out_path.with_suffix(f"{out_path.suffix}.json")
    meta_path.write_text(f"{json.dumps(meta, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
