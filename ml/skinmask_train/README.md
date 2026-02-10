# Aurora Skinmask Train

This folder trains and exports the face/skin segmentation model used to refine `photo_modules_v1` leakage control.

## Prerequisites

- Prepared external datasets via:
  - `make datasets-prepare`
  - `make datasets-audit`
- Python env with:
  - `torch`
  - `transformers`
  - `numpy`
  - `Pillow`

## Train

```bash
make train-skinmask DATASETS="fasseg,lapa,celebamaskhq" EPOCHS=8 BATCH=8
```

Outputs:
- `outputs/skinmask_train/run_*/best/checkpoint.pt`
- `outputs/skinmask_train/run_*/best/hf_model/`
- `outputs/skinmask_train/run_*/best/hf_processor/`

## Evaluate

```bash
python3 -m ml.skinmask_train.eval --cache_dir datasets_cache/external --datasets fasseg,lapa,celebamaskhq --checkpoint outputs/skinmask_train/run_*/best --split val
```

Outputs:
- `reports/skinmask_eval_*.json`
- `reports/skinmask_eval_*.md`

## Export ONNX

```bash
make export-skinmask CKPT="outputs/skinmask_train/run_*/best" OUT=artifacts/skinmask_v1.onnx
```

Outputs:
- `artifacts/skinmask_v1.onnx`
- `artifacts/skinmask_v1.onnx.json`

## A/B with eval-circle

```bash
make eval-skinmask ONNX=artifacts/skinmask_v1.onnx DATASETS="fasseg,lapa,celebamaskhq" LIMIT=200
```

Outputs:
- `reports/skinmask_ablation_*.md`

## Notes

- Default backbone: `SegFormer-B0` (`nvidia/segformer-b0-finetuned-ade-512-512`).
- Label space is unified in `label_map.py`; missing classes are mapped to `ignore_index=255`.
- Do not commit datasets or generated outputs.
