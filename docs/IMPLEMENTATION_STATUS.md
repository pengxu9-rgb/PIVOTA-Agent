# Implementation Status (Aurora Diagnosis Pipeline)

Last updated: 2026-02-09

## 1) Current Pipeline (text flow)

1. `POST /v1/photos/confirm` receives upload confirmation + QC, and if auto mode is enabled it triggers diagnosis follow-up (`AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM`).
   - Reference: `src/auroraBff/routes.js:209`
2. Diagnosis path fetches profile/logs context and attempts photo bytes retrieval.
   - bytes path prefers in-memory upload cache, then signed download URL.
   - Reference: `src/auroraBff/routes.js:803`, `src/auroraBff/routes.js:813`, `src/auroraBff/routes.js:969`
3. If bytes are available, diagnosis computes CV findings + plan/takeaways and marks `used_photos=true`.
   - Reference: `src/auroraBff/routes.js:983`, `src/auroraBff/skinDiagnosisV1.js:1021`
4. If bytes are unavailable or quality fails, response degrades to rule-based/fallback and adds explicit next-action guidance.
   - Reference: `src/auroraBff/routes.js:1002`, `src/auroraBff/routes.js:1671`, `src/auroraBff/routes.js:2215`
5. Optional shadow verifier can run (Gemini verify) without changing user-visible findings, then writes shadow artifacts/metrics.
   - Reference: `src/auroraBff/diagVerify.js:249`, `src/auroraBff/diagVerify.js:347`, `src/auroraBff/diagVerify.js:387`
6. Metrics exposed via `/metrics`; UI telemetry ingested via `POST /v1/events`.
   - Reference: `src/auroraBff/routes.js:4859`, `src/telemetry/uiEvents.js:72`

## 2) Capability Checklist (fact-based)

### a) 图片获取链路：上传→取图→bytes进入pipeline（含失败原因分类）
- [x] Implemented.
- Evidence:
  - Upload cache first: `src/auroraBff/routes.js:813`
  - Signed URL fetch fallback: `src/auroraBff/routes.js:846`
  - Bytes path used by diagnosis: `src/auroraBff/routes.js:969`
  - Failure code taxonomy implemented:
    - `DOWNLOAD_URL_GENERATE_FAILED`: `src/auroraBff/routes.js:805`
    - `DOWNLOAD_URL_FETCH_4XX`: `src/auroraBff/routes.js:709`
    - `DOWNLOAD_URL_FETCH_5XX`: `src/auroraBff/routes.js:706`
    - `DOWNLOAD_URL_TIMEOUT`: `src/auroraBff/routes.js:703`
    - `DOWNLOAD_URL_EXPIRED`: `src/auroraBff/routes.js:698`
    - `DOWNLOAD_URL_DNS`: `src/auroraBff/routes.js:715`

### b) used_photos/photos_provided 语义与 UI 提示
- [x] Implemented.
- Evidence:
  - Payload fields: `used_photos`, `analysis_source`, `photo_notice`: `src/auroraBff/routes.js:1073`, `src/auroraBff/routes.js:1074`, `src/auroraBff/routes.js:1075`
  - Failure reflected in `field_missing analysis.used_photos`: `src/auroraBff/routes.js:1002`
  - Contract doc explicitly defines semantics: `docs/aurora_bff_cards.md:75`, `docs/aurora_bff_cards.md:77`, `docs/aurora_bff_cards.md:79`

### c) CV-only photo_findings（类型覆盖）
- [x] Implemented.
- Evidence:
  - CV findings builder: `src/auroraBff/skinDiagnosisV1.js:1021`
  - Types currently emitted:
    - `redness`: `src/auroraBff/skinDiagnosisV1.js:1097`
    - `shine`: `src/auroraBff/skinDiagnosisV1.js:1120`
    - `texture`: `src/auroraBff/skinDiagnosisV1.js:1143`
    - `tone` (uneven-tone related): `src/auroraBff/skinDiagnosisV1.js:1167`

### d) 可视化证据输出（heatmap/bbox/polygon）
- [x] Implemented (bbox + heatmap in diagnosis canonical and plan evidence).
- Evidence:
  - Canonical concern supports `regions[]` with region schema: `src/auroraBff/diagEnsemble.js:94`
  - Provider normalization supports bbox/heatmap: `src/auroraBff/diagEnsemble.js:430`, `src/auroraBff/diagEnsemble.js:820`
  - User-facing analysis includes `evidence_regions` when photos used: `src/auroraBff/routes.js:1878`
  - Conflict heatmap schema contract documented: `docs/aurora_bff_cards.md:109`

### e) 结构化 plan/takeaways（Today/7days/After calm + source）
- [x] Implemented.
- Evidence:
  - Plan slots created (`today`, `next_7_days`, `after_calm`): `src/auroraBff/routes.js:1980`, `src/auroraBff/routes.js:2086`, `src/auroraBff/routes.js:2163`
  - Source annotation exists (`photo|user|mixed`): `src/auroraBff/routes.js:1894`
  - Linked finding IDs carried through plan/takeaways: `src/auroraBff/routes.js:2090`, `src/auroraBff/routes.js:2172`

### f) Vision/LLM 调用策略与兜底（reason 细分、重试、fallback）
- [x] Implemented.
- Evidence:
  - Download URL retry/backoff/timeout handling: `src/auroraBff/routes.js:720`, `src/auroraBff/routes.js:779`
  - Fallback action card with explicit why/retake/questions: `src/auroraBff/routes.js:1758`, `src/auroraBff/routes.js:1759`, `src/auroraBff/routes.js:1761`
  - No-photo fallback output wiring: `src/auroraBff/routes.js:2215`, `src/auroraBff/routes.js:2222`

### g) A 主干上线开关（env flags）
- [x] Implemented as runtime behavior control.
- Evidence:
  - Auto-analysis switch after confirm: `src/auroraBff/routes.js:209`
  - Photo fetch knobs (timeout/retry/cache): `src/auroraBff/routes.js:184`, `src/auroraBff/routes.js:190`

### h) B shadow verifier 接入状态（stub / 真调用）
- [x] Implemented with real provider calls, default OFF.
- Evidence:
  - Flag default false: `src/auroraBff/diagVerify.js:249`
  - Real CV + Gemini providers invoked when enabled: `src/auroraBff/diagVerify.js:312`, `src/auroraBff/diagVerify.js:320`
  - Structured verifier verdict includes per-issue agreement and fixes: `src/auroraBff/diagVerify.js:353`

### i) model_outputs / pseudo_labels / hard_cases / agreement_metrics 存储
- [x] Implemented.
- Evidence:
  - Pseudo-label store files: `manifest.json`, `model_outputs.ndjson`, `pseudo_labels.ndjson`, `agreement_samples.ndjson` at `src/auroraBff/pseudoLabelFactory.js:103`
  - Hard-case file path default: `src/auroraBff/diagVerify.js:237`
  - Agreement metrics exposed in metrics renderer: `src/auroraBff/visionMetrics.js:284`, `src/auroraBff/visionMetrics.js:301`

### j) metrics / alerts / dashboard 完整度
- [ ] Partially implemented.
- Evidence:
  - Metrics endpoint and counters/histograms exist: `src/auroraBff/routes.js:4859`, `src/auroraBff/visionMetrics.js:293`, `src/auroraBff/visionMetrics.js:310`
  - Alert/dashboard specs exist: `ALERTS.md:1`, `DASHBOARD.md:3`
  - Remaining gap noted in alerts doc (geometry sanitizer drop metric not fully stable): `ALERTS.md:71`

### k) RELEASE_GATE 阈值与最新结果（GO/NO-GO）
- [x] Latest gate is GO.
- Evidence:
  - Verdict GO: `RELEASE_GATE.md:4`
  - Stability PASS and loadtest PASS artifact links: `RELEASE_GATE.md:12`, `RELEASE_GATE.md:13`

## 3) Known Limitations / Risks

1. Photo-derived conclusions remain sensitive to lighting/filter/makeup artifacts; fallback and quality gating reduce but do not eliminate this risk.
   - Reference: `src/auroraBff/diagVerify.js:41`, `src/auroraBff/diagVerify.js:367`
2. Shadow verifier is off by default; without enabling `DIAG_GEMINI_VERIFY`, disagreement telemetry/hard-case loop is absent in production traffic.
   - Reference: `src/auroraBff/diagVerify.js:249`
3. Metrics/alerts are documented but operational dashboard wiring and some alert signals are still partially manual.
   - Reference: `ALERTS.md:71`, `DASHBOARD.md:3`
4. Pseudo-label pipeline stores structured outputs only by default (good for privacy), but optional ROI persistence remains opt-in and should be controlled carefully.
   - Reference: `src/auroraBff/pseudoLabelFactory.js:94`

## 4) Feature Flags / Runtime Guide

### Core photo diagnosis
- `AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM` (default `true`): `src/auroraBff/routes.js:209`
- `AURORA_PHOTO_DOWNLOAD_URL_TIMEOUT_MS` (default `5000`): `src/auroraBff/routes.js:186`
- `AURORA_PHOTO_FETCH_TIMEOUT_MS` (default `3000`): `src/auroraBff/routes.js:190`
- `AURORA_PHOTO_FETCH_RETRIES` (default `2`): `src/auroraBff/routes.js:194`

### Ensemble / verifier / calibration
- `DIAG_ENSEMBLE` (default `false`): `src/auroraBff/diagEnsemble.js:853`
- `DIAG_GEMINI_VERIFY` (default `false`): `src/auroraBff/diagVerify.js:249`
- `DIAG_CALIBRATION_ENABLED` (default `false`): `src/auroraBff/diagCalibration.js:922`
- `DIAG_CALIBRATION_USE_LATEST_VERSION` (default `true`): `src/auroraBff/diagCalibration.js:940`
- `AURORA_PSEUDO_LABEL_ENABLED` (default `true`): `src/auroraBff/pseudoLabelFactory.js:92`

### Local reproducibility commands
- Release gate: `make release-gate`
- Runtime smoke: `make runtime-smoke BASE=https://pivota-agent-production.up.railway.app`
- Focused tests (contract + stability + gate discovery): `make test`
- Full unit suite used by privacy check flow: `npm run test:aurora-bff:unit`
- Gold-label sample generation: `make gold-label-sample GOLD_TOTAL=500 GOLD_HARD_RATIO=0.6`
- Gold-label import: `make gold-label-import GOLD_IMPORT_IN=/path/to/label_studio_export.json`
- Train calibrator: `make train-calibrator`
- Evaluate calibrator: `make eval-calibration`

## 5) Ingredient KB Production Validation (Aurora)

### A. API acceptance checklist

1. Contract check (`raw_ingredient.original_text` and candidate original content exist):
   - `BASE="https://aurora-beauty-decision-system.vercel.app"`
   - `curl -sS "$BASE/v1/kb/products/ac1d67be62/ingredients?source_system=harvester&source_type=candidate_id" | jq '{ok,schema_version,raw_ingredient:(.raw_ingredient|{text,original_text,source_sheet,source_ref}),candidate0:(.raw_ingredient_candidates[0]|{content,original_content})}'`
2. Cleaning effect check:
   - `curl -sS "$BASE/v1/kb/products/ac1d67be62/ingredients?source_system=harvester&source_type=candidate_id" | jq '{clean_len:(.raw_ingredient.text|length),orig_len:(.raw_ingredient.original_text|length),same:(.raw_ingredient.text==.raw_ingredient.original_text)}'`
3. Crosswalk resolution check:
   - `curl -sS "$BASE/v1/kb/products/ac1d67be62/ingredients?source_system=harvester&source_type=candidate_id" | jq '{matched_by:.resolved.matched_by,source_system:.resolved.source_system,source_type:.resolved.source_type,count:.ingredients.count}'`
4. UUID direct lookup check:
   - `curl -sS "$BASE/v1/kb/products/62881b3b-6cfa-4572-b911-282165cc4e88/ingredients" | jq '{ok,product_id,has_original:(.raw_ingredient.original_text!=null)}'`

Pass criteria:
- `ok=true` and schema is `aurora.product_ingredients.v1`
- `raw_ingredient.original_text` is present
- for noisy samples, `clean_len < orig_len` and `same=false`
- crosswalk query resolves to `matched_by=crosswalk` with `harvester/candidate_id`
- UUID lookup also returns `has_original=true`

### B. Latest spotcheck (2026-02-09 UTC)

- Sample size: 20 candidate ids (first 20 rows from `/Users/pengchydan/Desktop/product_candidates_master_v0_i18n__人工检测完毕.csv`)
- API `ok=true`: 20/20
- `raw_ingredient.original_text` present: 20/20
- cleaned text shorter than original: 18/20
- clean equals original: 1/20
- request errors: 0/20

Generated artifacts:
- `reports/ingredient_kb_spotcheck_20260209_064827.md`
- `reports/ingredient_kb_spotcheck_20260209_064827.csv`
