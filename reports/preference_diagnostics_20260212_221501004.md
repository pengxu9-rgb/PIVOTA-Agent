# Preference Diagnostics v1

- run_id: 20260212_221501004
- generated_at: 2026-02-12T23:37:29.212Z
- manifest: `artifacts/_smoke_overlay_gate_20260212_221501004/manifest.json`
- eval_input: `artifacts/_smoke_overlay_gate_20260212_221501004/eval.jsonl`
- labels: `artifacts/_smoke_overlay_gate_20260212_221501004/labels.ndjson`

## Executive Summary

- final_verdict: **SHIP_VARIANT1**
- overall win/tie/cannot_tell: baseline=0.333 variant1=0.667 tie=0.333 cannot_tell=0.167 (n=6)
- Wilson CI: baseline=[0.061, 0.792], variant1=[0.208, 0.939]
- overlap IAA: agreement=0.5, kappa=0.333, overlap_labeled_by_2plus=2/2, sufficient=yes

## Overlay Consistency Gate

- pass: yes
- coverage_rate: 1 (min 0.98)
- consistency_rate: 1 (min 0.98, eps=0.000001)
- eval_rows_total: 4
- top_issues: 0

## Where The Signal Comes From

### By Source

| source | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| internal | 3 | 0.333 | 0.667 | 0 | 0 | [0.061, 0.792] | [0.208, 0.939] |
| lapa | 2 | - | - | 1 | 0 | [-, -] | [-, -] |
| celebamaskhq | 1 | - | - | 0 | 1 | [-, -] | [-, -] |

### By Module

| module | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| forehead | 6 | 0.333 | 0.667 | 0.333 | 0.167 | [0.061, 0.792] | [0.208, 0.939] |
| nose | 6 | 0.333 | 0.667 | 0.333 | 0.167 | [0.061, 0.792] | [0.208, 0.939] |

### By Hair Overlap Bucket

| hair_overlap_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| mid(0.10-0.25) | 4 | 0.333 | 0.667 | 0 | 0.25 | [0.061, 0.792] | [0.208, 0.939] |
| low(<0.10) | 2 | - | - | 1 | 0 | [-, -] | [-, -] |

### By Leakage BG Bucket

| leakage_bg_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| low(<0.05) | 5 | 0.333 | 0.667 | 0.4 | 0 | [0.061, 0.792] | [0.208, 0.939] |
| mid(0.05-0.15) | 1 | - | - | 0 | 1 | [-, -] | [-, -] |

### By Min Module Pixels Bucket

| min_module_pixels_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| mid(49-128) | 3 | 0 | 1 | 0.667 | 0 | [0, 0.793] | [0.207, 1] |
| tiny(<=16) | 2 | 0.5 | 0.5 | 0 | 0 | [0.095, 0.905] | [0.095, 0.905] |
| small(17-48) | 1 | - | - | 0 | 1 | [-, -] | [-, -] |

### By Guard Triggered

| guard_triggered | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| no | 5 | 0.333 | 0.667 | 0.4 | 0 | [0.061, 0.792] | [0.208, 0.939] |
| yes | 1 | - | - | 0 | 1 | [-, -] | [-, -] |

### By Overlay Diff Bucket

| overlay_diff_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| high(>=0.03) | 2 | 0 | 1 | 0 | 0.5 | [0, 0.793] | [0.207, 1] |
| mid(0.01-0.03) | 2 | - | - | 1 | 0 | [-, -] | [-, -] |
| very_low(<0.01) | 2 | 0.5 | 0.5 | 0 | 0 | [0.095, 0.905] | [0.095, 0.905] |

### By Confidence Bucket

| confidence_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| high(>=4) | 4 | 0 | 1 | 0.5 | 0.25 | [0, 0.793] | [0.207, 1] |
| low(<=2) | 2 | 0.5 | 0.5 | 0 | 0 | [0.095, 0.905] | [0.095, 0.905] |

## Disagreement Diagnosis

Likely-cause labels used: `visual difference too small`, `task ambiguous`, `model outputs unstable`, `crop/resize artifact`, `internal photo style mismatch`, `hair/skin boundary issue`.

| rank | slice | n votes | cannot_tell | disagreement | likely cause | issue area | evidence(avg split/hair/leak/minpx/overlay_diff) |
|---:|---|---:|---:|---:|---|---|---|
| 1 | module:forehead | 6 | 0.167 | 0.667 | model outputs unstable | model issue | 0.45 / 0.138 / 0.045 / 57 / 0.056 |
| 2 | module:nose | 6 | 0.167 | 0.667 | model outputs unstable | model issue | 0.45 / 0.138 / 0.045 / 57 / 0.056 |
| 3 | hair_bucket:mid(0.10-0.25) | 4 | 0.25 | 0.5 | model outputs unstable | model issue | 0.5 / 0.167 / 0.047 / 54.667 / 0.068 |
| 4 | confidence:high(>=4) | 4 | 0.25 | 0.5 | model outputs unstable | model issue | 0.333 / 0.117 / 0.05 / 70.667 / 0.073 |
| 5 | guard_triggered:no | 5 | 0 | 0.6 | model outputs unstable | model issue | 0.433 / 0.123 / 0.03 / 66.667 / 0.048 |
| 6 | leakage_bucket:low(<0.05) | 5 | 0 | 0.6 | model outputs unstable | model issue | 0.433 / 0.123 / 0.03 / 66.667 / 0.048 |
| 7 | source:internal | 3 | 0 | 0.333 | model outputs unstable | model issue | 0.5 / 0.16 / 0.025 / 68 / 0.063 |
| 8 | min_pixels_bucket:mid(49-128) | 3 | 0 | 0.333 | model outputs unstable | model issue | 0.25 / 0.085 / 0.03 / 92 / 0.07 |

## Proposer Input Summary

- suggested_overlay_diff_filter_min: 0.01
- very_low_overlay_diff_vote_rate: 0.333
- proposer_hint: prioritize samples with overlay_diff_ratio>=0.01; downweight overlay_diff_ratio<0.01 when cannot_tell-heavy.

## Action Recommendations

| rank | action title | what to change | target slice | why | how to validate |
|---:|---|---|---|---|---|
| 1 | Increase visual separability in A/B overlays | Update `scripts/preference_round1_real_runbook.mjs` overlay rendering to add contour-diff inset and run a focused sweep with `PREFERENCE_MAX_EDGE=768`. | hair_bucket:mid(0.10-0.25) | cannot_tell_rate=0.25 with avg_split_close=0.5 indicates small visible deltas. | Run `make preference-round1-real-pack ... TARGET_TOTAL=80 PREFERENCE_MAX_EDGE=768` then `make preference-final ...`; expect cannot_tell_rate to drop by >=0.05 without lowering IAA. |
| 2 | Tighten labeling rubric for ambiguous modules | Refine `label_studio/project_preference_ab.xml` instructions and `docs/GOLD_LABELING_GUIDE.md` for tie/cannot_tell usage on under-eye and low-detail regions. | module:under_eye_* | under-eye slice cannot_tell_rate=- and disagreement_rate=-. | Re-run overlap subset (>=40) and check IAA improves (kappa +0.05) while cannot_tell on under-eye decreases. |
| 3 | Harden forehead hair/skin boundary behavior | Keep hair-aware forehead clip path and prioritize forehead/hair hard cases for skinmask+hair-mask retraining decision; tune oval clip params in offline AB (`DIAG_FACE_OVAL_CLIP_MIN_PIXELS`, `DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO`). | forehead + high hair_overlap_est | forehead variant win=0.667, baseline win=0.333; disagreement driver highlights boundary instability. | Run `make eval-gold-ab ...` + preference rerun on hair-high subset; expect forehead variant win +>=0.10 and lower disagreement in high-hair bucket. |
| 4 | Stabilize hard-case guard strategy | Tune guard behavior on hard samples via offline variant sweep (variant2 under-eye guard relaxation + fallback behavior) and compare only guard-triggered subset. | module:forehead | high disagreement slice score=0.409 suggests unstable model outputs on hard cases. | Run a guard-triggered mini-pack (`TARGET_TOTAL=80`, stress-heavy) and expect disagreement_rate drop by >=0.08 with no increase in cannot_tell. |
| 5 | Address internal style mismatch and pipeline artifacts | If internal remains worse, add internal-style slices to training/eval packs and inspect crop pipeline (`input_thumb` generation) for over-aggressive resizing. | source:internal | internal disagreement_rate=0.333 vs overall=0.667; crossset leakage=-. | Run internal-only preference round (`LIMIT_INTERNAL` up, external down) and confirm internal cannot_tell/disagreement converge toward external slices. |

## Contentious Export

- file: `artifacts/preference_contentious_20260212_221501004.jsonl`
- samples: 4

