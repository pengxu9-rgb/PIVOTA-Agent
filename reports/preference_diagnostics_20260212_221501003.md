# Preference Diagnostics v1

- run_id: 20260212_221501003
- generated_at: 2026-02-12T23:36:57.461Z
- manifest: `artifacts/preference_round1_20260212_221501003/manifest.json`
- eval_input: `reports/eval_preference_20260212_221501003.jsonl`
- labels: `artifacts/preference_round1_20260212_221501003/preference_labels.ndjson`

## Executive Summary

- final_verdict: **NEED_ADJUDICATION**
- overall win/tie/cannot_tell: baseline=0.7 variant1=0.3 tie=0.25 cannot_tell=0.25 (n=20)
- Wilson CI: baseline=[0.397, 0.892], variant1=[0.108, 0.603]
- overlap IAA: agreement=-, kappa=0, overlap_labeled_by_2plus=0/6, sufficient=no

## Overlay Consistency Gate

- pass: yes
- coverage_rate: 1 (min 0.98)
- consistency_rate: 1 (min 0.98, eps=0.000001)
- eval_rows_total: 20
- top_issues: 0

## Where The Signal Comes From

### By Source

| source | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| celebamaskhq | 7 | 0.5 | 0.5 | 0.429 | 0.286 | [0.095, 0.905] | [0.095, 0.905] |
| lapa | 7 | 0.6 | 0.4 | 0.143 | 0.143 | [0.231, 0.882] | [0.118, 0.769] |
| internal | 6 | 1 | 0 | 0.167 | 0.333 | [0.438, 1] | [0, 0.562] |

### By Module

| module | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| chin | 20 | 0.6 | 0.4 | 0 | 0 | [0.387, 0.781] | [0.219, 0.613] |
| forehead | 20 | 0.55 | 0.45 | 0 | 0 | [0.342, 0.742] | [0.258, 0.658] |
| left_cheek | 20 | - | - | 1 | 0 | [-, -] | [-, -] |
| nose | 20 | 0.6 | 0.4 | 0 | 0 | [0.387, 0.781] | [0.219, 0.613] |
| right_cheek | 20 | 0.6 | 0.4 | 0 | 0.25 | [0.357, 0.802] | [0.198, 0.643] |

### By Hair Overlap Bucket

| hair_overlap_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| low(<0.10) | 20 | 0.7 | 0.3 | 0.25 | 0.25 | [0.397, 0.892] | [0.108, 0.603] |

### By Leakage BG Bucket

| leakage_bg_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| low(<0.05) | 20 | 0.7 | 0.3 | 0.25 | 0.25 | [0.397, 0.892] | [0.108, 0.603] |

### By Min Module Pixels Bucket

| min_module_pixels_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| tiny(<=16) | 20 | 0.7 | 0.3 | 0.25 | 0.25 | [0.397, 0.892] | [0.108, 0.603] |

### By Guard Triggered

| guard_triggered | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| no | 20 | 0.7 | 0.3 | 0.25 | 0.25 | [0.397, 0.892] | [0.108, 0.603] |

### By Overlay Diff Bucket

| overlay_diff_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| high(>=0.03) | 20 | 0.7 | 0.3 | 0.25 | 0.25 | [0.397, 0.892] | [0.108, 0.603] |

### By Confidence Bucket

| confidence_bucket | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |
|---|---:|---:|---:|---:|---:|---|---|
| high(>=4) | 12 | 0.667 | 0.333 | 0.25 | 0.25 | [0.3, 0.903] | [0.097, 0.7] |
| low(<=2) | 4 | 0.5 | 0.5 | 0.25 | 0.25 | [0.095, 0.905] | [0.095, 0.905] |
| mid(3) | 4 | 1 | 0 | 0.25 | 0.25 | [0.342, 1] | [0, 0.658] |

## Disagreement Diagnosis

Likely-cause labels used: `visual difference too small`, `task ambiguous`, `model outputs unstable`, `crop/resize artifact`, `internal photo style mismatch`, `hair/skin boundary issue`.

| rank | slice | n votes | cannot_tell | disagreement | likely cause | issue area | evidence(avg split/hair/leak/minpx/overlay_diff) |
|---:|---|---:|---:|---:|---|---|---|
| 1 | confidence:low(<=2) | 4 | 0.25 | 0.75 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.281 |
| 2 | confidence:high(>=4) | 12 | 0.25 | 0.667 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.275 |
| 3 | guard_triggered:no | 20 | 0.25 | 0.65 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.276 |
| 4 | hair_bucket:low(<0.10) | 20 | 0.25 | 0.65 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.276 |
| 5 | leakage_bucket:low(<0.05) | 20 | 0.25 | 0.65 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.276 |
| 6 | min_pixels_bucket:tiny(<=16) | 20 | 0.25 | 0.65 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.276 |
| 7 | overlay_diff_bucket:high(>=0.03) | 20 | 0.25 | 0.65 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.276 |
| 8 | source:celebamaskhq | 7 | 0.286 | 0.571 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.273 |
| 9 | source:internal | 6 | 0.333 | 0.5 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.276 |
| 10 | module:right_cheek | 20 | 0.25 | 0.55 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.276 |
| 11 | confidence:mid(3) | 4 | 0.25 | 0.5 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.275 |
| 12 | source:lapa | 7 | 0.143 | 0.571 | model outputs unstable | model issue | 0 / 0 / 0 / 0 / 0.28 |

## Proposer Input Summary

- suggested_overlay_diff_filter_min: 0.01
- very_low_overlay_diff_vote_rate: 0
- proposer_hint: prioritize samples with overlay_diff_ratio>=0.01; downweight overlay_diff_ratio<0.01 when cannot_tell-heavy.

## Action Recommendations

| rank | action title | what to change | target slice | why | how to validate |
|---:|---|---|---|---|---|
| 1 | Increase visual separability in A/B overlays | Update `scripts/preference_round1_real_runbook.mjs` overlay rendering to add contour-diff inset and run a focused sweep with `PREFERENCE_MAX_EDGE=768`. | confidence:low(<=2) | cannot_tell_rate=0.25 with avg_split_close=0 indicates small visible deltas. | Run `make preference-round1-real-pack ... TARGET_TOTAL=80 PREFERENCE_MAX_EDGE=768` then `make preference-final ...`; expect cannot_tell_rate to drop by >=0.05 without lowering IAA. |
| 2 | Tighten labeling rubric for ambiguous modules | Refine `label_studio/project_preference_ab.xml` instructions and `docs/GOLD_LABELING_GUIDE.md` for tie/cannot_tell usage on under-eye and low-detail regions. | module:under_eye_* | under-eye slice cannot_tell_rate=- and disagreement_rate=-. | Re-run overlap subset (>=40) and check IAA improves (kappa +0.05) while cannot_tell on under-eye decreases. |
| 3 | Harden forehead hair/skin boundary behavior | Keep hair-aware forehead clip path and prioritize forehead/hair hard cases for skinmask+hair-mask retraining decision; tune oval clip params in offline AB (`DIAG_FACE_OVAL_CLIP_MIN_PIXELS`, `DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO`). | forehead + high hair_overlap_est | forehead variant win=0.45, baseline win=0.55; disagreement driver highlights boundary instability. | Run `make eval-gold-ab ...` + preference rerun on hair-high subset; expect forehead variant win +>=0.10 and lower disagreement in high-hair bucket. |
| 4 | Stabilize hard-case guard strategy | Tune guard behavior on hard samples via offline variant sweep (variant2 under-eye guard relaxation + fallback behavior) and compare only guard-triggered subset. | confidence:low(<=2) | high disagreement slice score=0.413 suggests unstable model outputs on hard cases. | Run a guard-triggered mini-pack (`TARGET_TOTAL=80`, stress-heavy) and expect disagreement_rate drop by >=0.08 with no increase in cannot_tell. |
| 5 | Address internal style mismatch and pipeline artifacts | If internal remains worse, add internal-style slices to training/eval packs and inspect crop pipeline (`input_thumb` generation) for over-aggressive resizing. | source:internal | internal disagreement_rate=0.5 vs overall=0.65; crossset leakage=-. | Run internal-only preference round (`LIMIT_INTERNAL` up, external down) and confirm internal cannot_tell/disagreement converge toward external slices. |

## Contentious Export

- file: `artifacts/preference_contentious_20260212_221501003.jsonl`
- samples: 20

