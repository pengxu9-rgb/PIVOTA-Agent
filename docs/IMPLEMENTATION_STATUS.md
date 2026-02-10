# Implementation Status (Aurora Diagnosis Pipeline)

Last updated: 2026-02-10 (product-rec enabled verification + env rollback checklist + monitoring guard-metric alignment)

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
- [x] Implemented for repo scope (rules + dashboard + runbook + validator).
- Evidence:
  - Metrics endpoint and counters/histograms exist: `src/auroraBff/routes.js:4859`, `src/auroraBff/visionMetrics.js:650`, `src/auroraBff/visionMetrics.js:769`
  - Canonical alert rules + recording rules are committed: `monitoring/alerts/aurora_diagnosis_rules.yml:1`, `monitoring/alerts/aurora_diagnosis_rules.yml:30`, `monitoring/alerts/aurora_diagnosis_rules.yml:83`
  - Canonical dashboard JSON includes verify/geometry/guard panels: `monitoring/dashboards/aurora_diagnosis_overview.grafana.json:2`, `monitoring/dashboards/aurora_diagnosis_overview.grafana.json:108`, `monitoring/dashboards/aurora_diagnosis_overview.grafana.json:135`
  - Monitoring validation is automated and wired via Make target: `scripts/monitoring_validate.py:16`, `scripts/monitoring_validate.py:146`, `Makefile:157`

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
3. Monitoring assets are complete in-repo, but production Alertmanager/Grafana provisioning and on-call routing remain environment-ops responsibilities.
   - Reference: `docs/MONITORING_RUNBOOK.md:3`, `monitoring/alerts/aurora_diagnosis_rules.yml:1`, `monitoring/dashboards/aurora_diagnosis_overview.grafana.json:1`
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
- `DIAG_VERIFY_MAX_CALLS_PER_MIN` (default `60`): `src/auroraBff/diagVerify.js:463`
- `DIAG_VERIFY_MAX_CALLS_PER_DAY` (default `10000`): `src/auroraBff/diagVerify.js:464`
- `ALLOW_GUARD_TEST` (default `false`, enables runtime header/query/body override for guard acceptance tests): `src/auroraBff/routes.js:226`, `src/auroraBff/diagVerify.js:807`
- `DIAG_CALIBRATION_ENABLED` (default `false`): `src/auroraBff/diagCalibration.js:922`
- `DIAG_CALIBRATION_USE_LATEST_VERSION` (default `true`): `src/auroraBff/diagCalibration.js:940`
- `AURORA_PSEUDO_LABEL_ENABLED` (default `true`): `src/auroraBff/pseudoLabelFactory.js:92`

### Local reproducibility commands
- Release gate: `make release-gate`
- Runtime smoke: `make runtime-smoke BASE=https://pivota-agent-production.up.railway.app`
- Photo modules production smoke (robust JSON parse): `make photo-modules-prod-smoke BASE=https://pivota-agent-production.up.railway.app PHOTO_PATH=/absolute/path/to/photo.jpg`
- Verify guard probe (single run): `BASE=https://pivota-agent-production.up.railway.app CALLS=1 WAIT_AFTER_SEC=10 EXPECT_GUARD=0 scripts/probe_verify_budget_guard.sh`
- Verify guard probe (DNS/network jitter hardened): `BASE=https://pivota-agent-production.up.railway.app CALLS=1 WAIT_AFTER_SEC=10 EXPECT_GUARD=0 CURL_RETRY_MAX=6 CURL_RETRY_DELAY_SEC=2 scripts/probe_verify_budget_guard.sh`
- Verify reason-delta quick check (UNKNOWN/4XX/5XX/TIMEOUT): capture `/metrics` before/after one probe and diff `verify_fail_total{reason=*}` counters
- Focused tests (contract + stability + gate discovery): `make test`
- Full unit suite used by privacy check flow: `npm run test:aurora-bff:unit`
- Gold-label sample generation: `make gold-label-sample GOLD_TOTAL=500 GOLD_HARD_RATIO=0.6`
- Gold-label import: `make gold-label-import GOLD_IMPORT_IN=/path/to/label_studio_export.json`
- Region accuracy eval (internal gold labels): `make eval-region-accuracy REGION_ACC_MODEL_OUTPUTS=tmp/diag_pseudo_label_factory/model_outputs.ndjson REGION_ACC_GOLD_LABELS=tmp/diag_pseudo_label_factory/gold_labels.ndjson REGION_ACC_IOU=0.3`
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

## 6) Latest Production Verification (Verifier + Photo Modules)

Validation window:
- Service: `https://pivota-agent-production.up.railway.app`
- Deployed commit: `dd83eada4434`
- Started at: `2026-02-10T02:41:22.057Z`

Photo modules production smoke (2026-02-10 UTC):
- Command family: `make photo-modules-prod-smoke BASE=https://pivota-agent-production.up.railway.app`
- Result:
  - `analysis_source=vision_gemini`
  - `used_photos=true`
  - `quality_grade=degraded`
  - `regions_count=8`
  - `modules_count=7`
  - `has_photo_modules_v1=true`
- Artifact:
  - `reports/photo_modules_production_smoke.md`

Photo modules local acceptance (2026-02-10 UTC):
- Backend acceptance PASS:
  - `reports/photo_modules_backend_acceptance.md`
- Frontend acceptance PASS:
  - `reports/photo_modules_frontend_acceptance.md`
- Analytics privacy audit PASS (no image bytes/base64/url, no bbox_px, no region geometry in events):
  - `reports/analytics_audit.md`

Internal batch verification (ordered run `1->2`, 2026-02-10 UTC):
- Input compatibility note:
  - Original set had 13 files with MIME `image/heic` even when extension was `.jpg`, which caused local decode failures in `sharp`.
  - Mitigation for this run: converted source set to temporary JPEG-only input (gitignored): `tmp/internal_batch_input_jpeg_20260210_111136` (27/27 converted).
- Step 1 (`MARKET=EU`, `LANG=en`, full 27 photos, `MODE=confirm`):
  - Command family: `make internal-batch PHOTOS_DIR=tmp/internal_batch_input_jpeg_20260210_111136 BASE=https://pivota-agent-production.up.railway.app MARKET=EU LANG=en MODE=confirm CONCURRENCY=4`
  - Result (`run_id=internal_batch_20260210_0318`):
    - `success_rate=1.0` (`27/27`)
    - `used_photos_rate=1.0` (`27/27`)
    - `photo_modules_card_ratio=0.8519` (`23/27`)
    - `claims_violation_detected=true`: `0`
    - `hard_gate_pass=true`
    - soft warning: `degraded_or_fail_ratio=0.963 > 0.3`
  - Artifacts:
    - `reports/internal_batch_20260210_0318.md`
    - `reports/internal_batch_20260210_0318.csv`
    - `reports/internal_batch_20260210_0318.jsonl`
- Step 2 (`MARKET=US`, `LANG=zh`, sampled 10 photos, `SHUFFLE=true`, `MODE=confirm`):
  - Command family: `make internal-batch PHOTOS_DIR=tmp/internal_batch_input_jpeg_20260210_111136 BASE=https://pivota-agent-production.up.railway.app MARKET=US LANG=zh MODE=confirm CONCURRENCY=4 LIMIT=10 SHUFFLE=true`
  - Result (`run_id=internal_batch_20260210_0321`):
    - `success_rate=1.0` (`10/10`)
    - `used_photos_rate=1.0` (`10/10`)
    - `photo_modules_card_ratio=1.0` (`10/10`)
    - `claims_violation_detected=true`: `0`
    - `hard_gate_pass=true`
    - soft warning: `degraded_or_fail_ratio=0.9 > 0.3`
  - Artifacts:
    - `reports/internal_batch_20260210_0321.md`
    - `reports/internal_batch_20260210_0321.csv`
    - `reports/internal_batch_20260210_0321.jsonl`

Historical verifier guard probes (2026-02-09 UTC):

Probe run A (smoke):
- Command family: `scripts/probe_verify_budget_guard.sh` (`CALLS=2`, `WAIT_AFTER_SEC=15`, `EXPECT_GUARD=0`)
- Result:
  - `used_photos=true`
  - `analysis_source=vision_gemini`
  - `verify_calls_total` delta: `+4`
  - `verify_fail_total` delta: `+0`
  - `verify_budget_guard_total` delta: `+0`
  - `verify_calls_total{status="guard"}` delta: `+0`
- Reason deltas (before/after metrics snapshot):
  - `UNKNOWN=0`
  - `UPSTREAM_4XX=0`
  - `UPSTREAM_5XX=0`
  - `TIMEOUT=0`
  - `RATE_LIMIT=0`
  - `QUOTA=0`
  - `NETWORK_ERROR=0`
  - `IMAGE_FETCH_FAILED=0`
  - `SCHEMA_INVALID=0`

Probe run B (stress):
- Command family: `scripts/probe_verify_budget_guard.sh` (`CALLS=75`, `WAIT_AFTER_SEC=30`, `SLEEP_BETWEEN_SEC=0`, `EXPECT_GUARD=1`)
- Result:
  - `used_photos=true` for all 75 calls
  - dominant `analysis_source=vision_gemini` (one fallback sample observed as `diagnosis_v1_template`)
  - `verify_calls_total` delta: `+150` (`attempt=+75`, `success=+74`, `fail=+1`)
  - `verify_fail_total` delta: `+1` (reason: `QUOTA`)
  - `verify_budget_guard_total` delta: `+0`
  - `verify_calls_total{status="guard"}` delta: `+0`
- Note:
  - stress probe exited with code `3` only because `EXPECT_GUARD=1` was not met.
  - this indicates the current production guard thresholds are above this traffic level (or guard is configured permissive for this environment).

Interpretation:
- Verifier failure-reason mapping remains stable: `UNKNOWN` bucket did not increase during guard probes.
- Photo modules card path is live and healthy in production (`photo_modules_v1` emitted under `used_photos=true` with valid overlay geometry payload).
- Local backend/frontend acceptance and analytics privacy audit all pass.

## 7) Product Rec Enabled Verification (2026-02-10 UTC)

Validation window:
- Service: `https://pivota-agent-production.up.railway.app`
- Deployed commit observed during this run: `a9295f90c7b4` (`x-service-commit` header)

Gate checks re-run (local):
- `make ingredient-kb-dry-run` PASS
- `make ingredient-kb-audit` PASS
- `make claims-audit` PASS
- `node --test tests/aurora_bff_claims_product_rec.node.test.cjs tests/aurora_bff_ingredient_kb_v2.node.test.cjs tests/aurora_bff_photo_modules_v1.node.test.cjs` PASS (`12/12`)

Production batch runs after `DIAG_PRODUCT_REC=true`:
- EU/en sample run (`run_id=internal_batch_20260210_050024310`, `limit=10`):
  - `success_rate=1.0` (`10/10`)
  - `used_photos_rate=1.0` (`10/10`)
  - `photo_modules_card_ratio=0.8` (`8/10`)
  - `products_count` mean: `0`
  - Artifact: `reports/internal_batch_manual/internal_batch_20260210_050024310.md`
- US/zh sample run (`run_id=internal_batch_20260210_050223344`, `limit=10`):
  - `success_rate=1.0` (`10/10`)
  - `used_photos_rate=1.0` (`10/10`)
  - `photo_modules_card_ratio=0.8` (`8/10`)
  - `products_count` mean: `0`
- EU/en probe run (`run_id=internal_batch_20260210_050612854`, `limit=5`, local parser flag `DIAG_PRODUCT_REC=true`):
  - `product_rec_enabled(推断)=true`
  - `products_count` mean: `0`
  - hard gate did not pass in this random 5-photo probe due `NO_CARD` ratio, but no claim violations were observed.
  - Artifact: `reports/internal_batch_manual/internal_batch_20260210_050612854.md`

Observed metrics delta during validation window:
- Metrics snapshot (`2026-02-10T05:00:23Z -> 2026-02-10T05:04:16Z`):
  - `product_rec_suppressed_total{reason="LOW_EVIDENCE"}`: `0 -> 336` (`+336`)
  - `claims_template_fallback_total{reason="ok"}`: `0 -> 3069` (`+3069`)
  - `claims_violation_total`: `0 -> 0`
- Current live metrics after additional probe:
  - `product_rec_suppressed_total{reason="LOW_EVIDENCE"} = 378`
  - `claims_template_fallback_total{reason="ok"} = 3438`
  - `claims_violation_total = 0`

Conclusion:
- Product-rec path is active in production (suppression metrics increase under `LOW_EVIDENCE`), and no medical-claim violations were emitted.
- Current behavior is intentionally conservative: suppress recommendations when evidence threshold is not met.

## 8) Production ENV Rollback Checklist (post internal testing)

### Keep enabled for controlled production rollout
- `DIAG_INGREDIENT_REC=true` (default on): `src/auroraBff/routes.js:237`
- `DIAG_PHOTO_MODULES_CARD=true` (photo modules card enabled): `src/auroraBff/routes.js:229`
- `DIAG_PRODUCT_REC=true`: `src/auroraBff/routes.js:238`
- `DIAG_PRODUCT_REC_MIN_CITATIONS=1` (current default): `src/auroraBff/routes.js:239`
- `DIAG_PRODUCT_REC_MIN_EVIDENCE_GRADE=B` (current default): `src/auroraBff/routes.js:243`
- `DIAG_PRODUCT_REC_REPAIR_ONLY_WHEN_DEGRADED=true` (recommended rollout setting): `src/auroraBff/routes.js:250`

### Revert / ensure OFF before broader external traffic
- `INTERNAL_TEST_MODE=false`: `src/auroraBff/routes.js:252`
- `ALLOW_GUARD_TEST=false`: `src/auroraBff/routes.js:230`, `src/auroraBff/diagVerify.js:807`
- `DIAG_GEMINI_VERIFY=false` unless explicitly running shadow verification: `src/auroraBff/diagVerify.js:249`

### Immediate follow-up (to move from suppress-only to useful product rec)
1. Increase A/B evidence and citation coverage for top recommended ingredients in EU/US product catalog overlap.
2. Track suppression mix via:
   - `product_rec_suppressed_total{reason=*}`
   - `product_rec_emitted_total{market,quality_grade}`
   - `claims_violation_total`
3. Keep `claims_violation_total == 0` as hard release gate; allow suppression until evidence improves.

### Final ENV matrix (production rollout)

| ENV | Current (inferred) | Target | Action | Requires redeploy |
| --- | --- | --- | --- | --- |
| `DIAG_INGREDIENT_REC` | on | `true` | keep | yes (if changed) |
| `DIAG_PHOTO_MODULES_CARD` | on (`photo_modules_v1` present) | `true` | keep | yes (if changed) |
| `DIAG_PRODUCT_REC` | on (`LOW_EVIDENCE` suppress counter increasing) | `true` | keep | yes (if changed) |
| `DIAG_PRODUCT_REC_MIN_CITATIONS` | unknown (likely default) | `1` | set explicit | yes |
| `DIAG_PRODUCT_REC_MIN_EVIDENCE_GRADE` | unknown (likely default) | `B` | set explicit | yes |
| `DIAG_PRODUCT_REC_REPAIR_ONLY_WHEN_DEGRADED` | unknown | `true` | set explicit | yes |
| `INTERNAL_TEST_MODE` | off (`internal_debug` not exposed) | `false` | keep off | yes (if changed) |
| `ALLOW_GUARD_TEST` | unknown | `false` | set/keep off | yes |
| `DIAG_GEMINI_VERIFY` | unknown | `false` (unless running shadow window) | set/keep off | yes |
| `AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM` | likely on | `true` | keep | yes (if changed) |
| `DIAG_VERIFY_MAX_CALLS_PER_MIN` | unknown | `60` | keep/set | yes |
| `DIAG_VERIFY_MAX_CALLS_PER_DAY` | unknown | `10000` | keep/set | yes |

### Rollout order (safe)
1. Apply/confirm all target env values above.
2. Redeploy once (single config rollout).
3. Run smoke + batch sample:
   - `make photo-modules-prod-smoke BASE=https://pivota-agent-production.up.railway.app PHOTO_PATH=/absolute/path/to/photo.jpg`
   - `DIAG_PRODUCT_REC=true make internal-batch PHOTOS_DIR=tmp/internal_batch_input_jpeg_20260210_111136 BASE=https://pivota-agent-production.up.railway.app MARKET=EU LANG=en MODE=confirm CONCURRENCY=2 LIMIT=10 SHUFFLE=true OUT_DIR=reports/internal_batch_manual`
4. Verify metrics hard gate:
   - `claims_violation_total == 0`
   - `product_rec_suppressed_total{reason="LOW_EVIDENCE"}` may increase
   - `product_rec_emitted_total` can remain `0` at this stage
