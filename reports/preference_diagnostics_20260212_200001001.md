# Preference Diagnostics v1

- run_id: 20260212_200001001
- generated_at: 2026-02-12T16:16:17.069Z
- manifest: `artifacts/preference_round1_20260212_200001001/manifest.json`
- eval_input: `reports/eval_preference_20260212_200001001.jsonl`
- labels: `artifacts/preference_round1_20260212_200001001/preference_labels.ndjson`

## Executive Summary

- final_verdict: **SHIP_VARIANT1**
- overall win/tie/cannot_tell: baseline=0.3 variant1=0.7 tie=0.115 cannot_tell=0.115 (n=26)
- Wilson CI: baseline=[0.145, 0.519], variant1=[0.481, 0.855]
- overlap IAA: agreement=0.667, kappa=0.455, overlap_labeled_by_2plus=6/6, sufficient=yes

## Where The Signal Comes From

### By Source

| source | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| internal | 10 | 0.5 | 0.5 | 0.2 | 0 | [0.215, 0.785] | [0.215, 0.785] |
| lapa | 10 | 0.143 | 0.857 | 0.1 | 0.2 | [0.026, 0.513] | [0.487, 0.974] |
| celebamaskhq | 6 | 0.2 | 0.8 | 0 | 0.167 | [0.036, 0.624] | [0.376, 0.964] |

### By Module

| module | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| chin | 26 | 0.654 | 0.346 | 0 | 0 | [0.462, 0.806] | [0.194, 0.538] |
| forehead | 26 | 0.385 | 0.615 | 0 | 0 | [0.224, 0.575] | [0.425, 0.776] |
| left_cheek | 26 | - | - | 1 | 0 | [-, -] | [-, -] |
| nose | 26 | 0.385 | 0.615 | 0 | 0 | [0.224, 0.575] | [0.425, 0.776] |
| right_cheek | 26 | 0.538 | 0.462 | 0 | 0.5 | [0.291, 0.768] | [0.232, 0.709] |

### By Hair Overlap Bucket

| hair_overlap_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| low(<0.10) | 26 | 0.3 | 0.7 | 0.115 | 0.115 | [0.145, 0.519] | [0.481, 0.855] |

### By Leakage BG Bucket

| leakage_bg_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| low(<0.05) | 26 | 0.3 | 0.7 | 0.115 | 0.115 | [0.145, 0.519] | [0.481, 0.855] |

### By Min Module Pixels Bucket

| min_module_pixels_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| tiny(<=16) | 26 | 0.3 | 0.7 | 0.115 | 0.115 | [0.145, 0.519] | [0.481, 0.855] |

### By Guard Triggered

| guard_triggered | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| no | 26 | 0.3 | 0.7 | 0.115 | 0.115 | [0.145, 0.519] | [0.481, 0.855] |

### By Overlay Diff Bucket

| overlay_diff_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| very_low(<0.01) | 26 | 0.3 | 0.7 | 0.115 | 0.115 | [0.145, 0.519] | [0.481, 0.855] |

### By Confidence Bucket

| confidence_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| high(>=4) | 13 | 0.143 | 0.857 | 0.231 | 0.231 | [0.026, 0.513] | [0.487, 0.974] |
| low(<=2) | 13 | 0.385 | 0.615 | 0 | 0 | [0.177, 0.645] | [0.355, 0.823] |

## Disagreement Diagnosis

Likely-cause labels used: `visual difference too small`, `task ambiguous`, `model outputs unstable`, `crop/resize artifact`, `internal photo style mismatch`, `hair/skin boundary issue`.

| rank | slice | n votes | cannot_tell | disagreement | likely cause | issue area | evidence(avg split/hair/leak/minpx/overlay_diff) |
|---:|---|---:|---:|---:|---|---|---|
| 1 | module:right_cheek | 26 | 0.5 | 0.5 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 2 | confidence:high(>=4) | 13 | 0.231 | 0.538 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 3 | source:lapa | 10 | 0.2 | 0.4 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 4 | source:internal | 10 | 0 | 0.6 | internal photo style mismatch | model issue | 0 / 0 / 0 / 0 / 0 |
| 5 | guard_triggered:no | 26 | 0.115 | 0.462 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 6 | hair_bucket:low(<0.10) | 26 | 0.115 | 0.462 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 7 | leakage_bucket:low(<0.05) | 26 | 0.115 | 0.462 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 8 | min_pixels_bucket:tiny(<=16) | 26 | 0.115 | 0.462 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 9 | overlay_diff_bucket:very_low(<0.01) | 26 | 0.115 | 0.462 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 10 | source:celebamaskhq | 6 | 0.167 | 0.333 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 11 | confidence:low(<=2) | 13 | 0 | 0.385 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |
| 12 | module:forehead | 26 | 0 | 0.385 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0 |

## Proposer Input Summary

- suggested_overlay_diff_filter_min: 0.01
- very_low_overlay_diff_vote_rate: 1
- proposer_hint: prioritize samples with overlay_diff_ratio>=0.01; downweight overlay_diff_ratio<0.01 when cannot_tell-heavy.

## Action Recommendations

| rank | action title | what to change | target slice | why | how to validate |
|---:|---|---|---|---|---|
| 1 | Increase visual separability in A/B overlays | Update `scripts/preference_round1_real_runbook.mjs` overlay rendering to add contour-diff inset and run a focused sweep with `PREFERENCE_MAX_EDGE=768`. | module:right_cheek | cannot_tell_rate=0.5 with avg_split_close=0 indicates small visible deltas. | Run `make preference-round1-real-pack ... TARGET_TOTAL=80 PREFERENCE_MAX_EDGE=768` then `make preference-final ...`; expect cannot_tell_rate to drop by >=0.05 without lowering IAA. |
| 2 | Tighten labeling rubric for ambiguous modules | Refine `label_studio/project_preference_ab.xml` instructions and `docs/GOLD_LABELING_GUIDE.md` for tie/cannot_tell usage on under-eye and low-detail regions. | module:under_eye_* | under-eye slice cannot_tell_rate=- and disagreement_rate=-. | Re-run overlap subset (>=40) and check IAA improves (kappa +0.05) while cannot_tell on under-eye decreases. |
| 3 | Harden forehead hair/skin boundary behavior | Keep hair-aware forehead clip path and prioritize forehead/hair hard cases for skinmask+hair-mask retraining decision; tune oval clip params in offline AB (`DIAG_FACE_OVAL_CLIP_MIN_PIXELS`, `DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO`). | forehead + high hair_overlap_est | forehead variant win=0.615, baseline win=0.385; disagreement driver highlights boundary instability. | Run `make eval-gold-ab ...` + preference rerun on hair-high subset; expect forehead variant win +>=0.10 and lower disagreement in high-hair bucket. |
| 4 | Stabilize hard-case guard strategy | Tune guard behavior on hard samples via offline variant sweep (variant2 under-eye guard relaxation + fallback behavior) and compare only guard-triggered subset. | module:right_cheek | high disagreement slice score=0.425 suggests unstable model outputs on hard cases. | Run a guard-triggered mini-pack (`TARGET_TOTAL=80`, stress-heavy) and expect disagreement_rate drop by >=0.08 with no increase in cannot_tell. |
| 5 | Address internal style mismatch and pipeline artifacts | If internal remains worse, add internal-style slices to training/eval packs and inspect crop pipeline (`input_thumb` generation) for over-aggressive resizing. | source:internal | internal disagreement_rate=0.6 vs overall=0.462; crossset leakage=-. | Run internal-only preference round (`LIMIT_INTERNAL` up, external down) and confirm internal cannot_tell/disagreement converge toward external slices. |

## Contentious Export

- file: `artifacts/preference_contentious_20260212_200001001.jsonl`
- samples: 20

