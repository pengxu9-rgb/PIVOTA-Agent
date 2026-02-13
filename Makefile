.PHONY: bench stability test golden loadtest privacy-check release-gate gate-debug runtime-smoke entry-smoke status docs verify-daily verify-fail-diagnose pseudo-label-job monitoring-validate gold-label-sample gold-seed-pack gold-round1-pack gold-round1-real-pack gold-round1-runbook gold-label-import eval-gold eval-gold-round1 eval-gold-ab eval-gold-iaa train-calibrator eval-calibration eval-region-accuracy reliability-table shadow-daily shadow-smoke shadow-acceptance ingest-ingredient-sources ingredient-kb-audit ingredient-kb-dry-run claims-audit photo-modules-acceptance photo-modules-prod-smoke internal-batch datasets-prepare datasets-audit datasets-ingest-local train-circle-prior eval-circle eval-circle-fasseg eval-circle-celeba-parsing eval-circle-crossset eval-circle-fasseg-ab eval-circle-fasseg-matrix eval-circle-shrink-sweep eval-datasets train-skinmask export-skinmask eval-skinmask eval-skinmask-fasseg eval-gt-sanity-fasseg eval-circle-ab bench-skinmask debug-skinmask-preproc internal-photo-review-pack review-pack-mixed preference-round1-pack preference-round1-real-pack preference-label-import preference-import eval-preference preference-adjudication-pack preference-adjudication-merge preference-final preference-diagnostics preference-overlay-gate preference-next-variants release-gate-preference release-gate-circle

AURORA_LANG ?= EN
REPEAT ?= 5
QC ?= pass
PRIMARY ?= routine
DETECTOR ?= auto
DEGRADED_MODE ?=
OUT ?=
IMAGES ?=
LOADTEST_DURATION_S ?= 10
LOADTEST_CONCURRENCY ?= 8
LOADTEST_REQUEST_TIMEOUT_S ?= 8
LOADTEST_QC ?= pass
LOADTEST_P95_BUDGET_MS ?= 2000
BASE ?= https://pivota-agent-production.up.railway.app
VERIFY_IN ?= tmp/diag_pseudo_label_factory
VERIFY_STORE_DIR ?= $(VERIFY_IN)
VERIFY_HARD_CASES ?=
VERIFY_REPORT_DATE ?=
VERIFY_OUT ?= reports
VERIFY_FAIL_OUT ?= reports
SHADOW_DAILY_DATE ?=
SHADOW_DAILY_SINCE ?=
SHADOW_REPORTS_OUT ?= reports
SHADOW_OUTPUTS_OUT ?= outputs
SHADOW_VERIFY_IN ?= tmp/diag_pseudo_label_factory
SHADOW_HARD_CASES ?= tmp/diag_verify/hard_cases.ndjson
SHADOW_PSEUDO_MIN_AGREEMENT ?=
SHADOW_BASE ?= $(BASE)
SHADOW_CALLS ?= 20
SHADOW_GUARD_CALLS ?= 20
SHADOW_WAIT_AFTER_SEC ?= 12
SHADOW_ALLOW_GUARD_TEST ?= false
SHADOW_MIN_USED_PHOTOS_RATIO ?= 0.95
SHADOW_MAX_PASS_FAIL_RATE ?= 0.05
SHADOW_MAX_TIMEOUT_RATE ?= 0.02
SHADOW_MAX_UPSTREAM_5XX_RATE ?= 0.02
PSEUDO_STORE_DIR ?= tmp/diag_pseudo_label_factory
PSEUDO_OUT_DIR ?= reports/pseudo_label_job
PSEUDO_JOB_DATE ?=
GOLD_TASKS_IN ?=
GOLD_TASKS_OUT ?= out/gold_label_tasks_$(shell date -u +%Y%m%d).jsonl
GOLD_TASKS_DATE ?=
GOLD_TOTAL ?= 500
GOLD_HARD_RATIO ?= 0.6
GOLD_QUOTA_FILE ?=
GOLD_ALLOW_ROI ?= false
GOLD_SEED ?=
GOLD_SEED_LIMIT ?= 120
GOLD_SEED_BUCKETS ?= CHIN_OVERFLOW,BG_LEAKAGE,NOSE_OVERFLOW,LAPA_FAIL,RANDOM_BASELINE
GOLD_SEED_BUCKET_MIN ?= 20
GOLD_SEED_SOURCE_MIN ?= 8
GOLD_SEED_TASKS_OUT ?= artifacts/gold_seed_tasks_labelstudio.json
GOLD_SEED_MANIFEST_OUT ?= artifacts/gold_seed_manifest.json
REVIEW_MD ?=
REVIEW_JSONL ?=
IN ?=
LABELS ?=
MANIFEST ?=
EVAL_JSONL ?=
EVAL_MD ?=
RUN_ID ?=
GOLD_EXPORT_JSON ?=
OUT_ROOT ?=
LS_EXPORT ?=
GOLD_IMPORT_IN ?=
GOLD_IMPORT_OUT ?= artifacts/gold_labels.ndjson
GOLD_IMPORT_QA_STATUS ?= approved
GOLD_IMPORT_ANNOTATOR ?=
ROUND1_IN ?=
DOUBLE_ANNOTATE_RATIO ?= 0.1
CAL_MODEL_OUTPUTS ?= tmp/diag_pseudo_label_factory/model_outputs.ndjson
CAL_GOLD_LABELS ?= $(GOLD_IMPORT_OUT)
CAL_TRAIN_SAMPLES ?=
CAL_OUT_DIR ?= model_registry
CAL_ALIAS_PATH ?= model_registry/diag_calibration_v1.json
CAL_IOU ?= 0.3
CAL_MIN_GROUP_SAMPLES ?= 24
CAL_EVAL_MODEL ?=
CAL_EVAL_OUT ?= reports/calibration_eval.json
EVAL_GOLD_LABELS ?= $(GOLD_IMPORT_OUT)
EVAL_GOLD_PRED_JSONL ?=
EVAL_GOLD_GRID ?= 256
EVAL_GOLD_CAL_TRAIN_OUT ?= artifacts/calibration_train_samples.ndjson
EVAL_GOLD_IAA_MIN_MIOU ?= 0.75
PRED_JSONL ?=
GOLD_LABELS ?=
EVAL_GOLD_AB_SWEEP ?=
EVAL_CROSSSET_DATASETS ?= celebamaskhq,lapa,fasseg
PREFERENCE_VARIANT ?= variant1
PREFERENCE_SEED ?= preference_round1_seed_v1
PREFERENCE_MAX_EDGE ?= 512
PREFERENCE_MODULE_BOX_MODE ?= dynamic_skinmask
PREFERENCE_REQUIRE_DYNAMIC_BOXES ?= true
PREFERENCE_EXCLUDE_TEMPLATE_LIKE ?= false
PREFERENCE_MIN_GEOMETRY_QC_SCORE ?= 0.2
PREFERENCE_TEMPLATE_MATCH_EPS ?= 0.004
PREFERENCE_IMPORT_ALL_ANNOTATIONS ?= true
PREFERENCE_ADJ_LIMIT ?= 80
PREFERENCE_LABELS ?=
EXPORTS ?=
BASE_EXPORTS ?=
ADJ_EXPORTS ?=
BASE_LABELS ?=
ADJ_LABELS ?=
CROSSSET_JSONL ?=
GOLD_EVAL_MD ?=
TARGET_TOTAL ?= 200
IAA_RATIO ?= 0.1
OVERLAP_RATIO ?= 0.25
OVERLAP_MIN ?= 40
EXTERNAL_INDEX_LAPA ?=
EXTERNAL_INDEX_CELEBA ?=
REVIEW_PACK_JSONL ?=
REGION_ACC_MODEL_OUTPUTS ?= $(CAL_MODEL_OUTPUTS)
REGION_ACC_GOLD_LABELS ?= $(CAL_GOLD_LABELS)
REGION_ACC_IOU ?= 0.3
REGION_ACC_OUT_JSON ?= reports/region_accuracy_eval.json
REGION_ACC_OUT_CSV ?= reports/region_accuracy_eval.csv
REGION_ACC_OUT_MD ?= reports/region_accuracy_eval.md
REGION_ACC_PROVIDERS ?=
REGION_ACC_ALLOW_EMPTY_GOLD ?= false
RELIABILITY_IN ?= tmp/diag_pseudo_label_factory
RELIABILITY_OUT ?= reports/reliability/reliability.json
RELIABILITY_DATE ?=
INGREDIENT_KB_DATA_DIR ?= data/external
INGREDIENT_KB_ARTIFACT ?= artifacts/ingredient_kb_v2.json
INGREDIENT_KB_MANIFEST ?= artifacts/manifest.json
INGREDIENT_KB_SOURCES_REPORT ?= reports/ingredient_kb_sources_report.md
INGREDIENT_KB_CLAIMS_AUDIT ?= reports/ingredient_kb_claims_audit.md
INGREDIENT_KB_FETCH_LIVE ?= false
CLAIMS_AUDIT_REPORT ?= reports/claims_audit.md
PHOTOS_DIR ?=
MARKET ?= US
LANG ?= en
MODE ?= direct
CONCURRENCY ?= 4
LIMIT ?=
TIMEOUT_MS ?= 30000
RETRY ?= 2
SHUFFLE ?= false
SANITIZE ?= true
MAX_EDGE ?= 2048
FAIL_FAST_ON_CLAIM_VIOLATION ?= false
RAW_DIR ?= $(HOME)/Desktop/datasets_raw
CACHE_DIR ?= datasets_cache/external
DATASETS ?= lapa,celebamaskhq,fasseg
EVAL_TIMEOUT_MS ?= 30000
EVAL_CONCURRENCY ?= 4
EVAL_SHUFFLE ?= false
EVAL_EMIT_DEBUG ?= false
EVAL_GRID_SIZE ?= 128
EVAL_REPORT_DIR ?= reports
EVAL_BASE_URL ?=
EVAL_TOKEN ?=
CIRCLE_MODEL_OUT ?= model_registry/circle_prior_v1.json
CIRCLE_MODEL_ALIAS ?= model_registry/circle_prior_latest.json
EVAL_CIRCLE_MODEL_PATH ?= $(CIRCLE_MODEL_ALIAS)
CIRCLE_MODEL_MIN_PIXELS ?= 24
CIRCLE_MODEL_CALIBRATION ?= true
EPOCHS ?= 8
BATCH ?= 8
ONNX ?= artifacts/skinmask_v2.onnx
CKPT ?=
SKINMASK_OUT_DIR ?= outputs/skinmask_train
SKINMASK_IMAGE_SIZE ?= 512
SKINMASK_NUM_WORKERS ?= 4
SKINMASK_BACKBONE ?= nvidia/segformer-b0-finetuned-ade-512-512
BENCH_ITERS ?= 200
BENCH_WARMUP ?= 8
BENCH_TIMEOUT_MS ?= 5000
BENCH_IMAGE ?=
BENCH_STRICT ?= false

bench:
	python3 scripts/bench_analyze.py --lang $(AURORA_LANG) --repeat $(REPEAT) --qc $(QC) --primary $(PRIMARY) --detector $(DETECTOR) $(if $(DEGRADED_MODE),--degraded-mode $(DEGRADED_MODE),) $(if $(OUT),--out $(OUT),) $(IMAGES)

stability:
	python3 scripts/perturb_stability.py --lang $(AURORA_LANG) --out $(if $(OUT),$(OUT),artifacts/stability_report.json) $(IMAGES)

test:
	python3 -m pytest -q tests/test_e2e_contract.py tests/test_perturb_stability.py tests/test_release_gate_discovery.py tests/test_release_gate_bench_sanity.py

golden:
	UPDATE_GOLDEN=1 python3 -m pytest -q tests/test_e2e_contract.py

loadtest:
	LOADTEST_DURATION_S=$(LOADTEST_DURATION_S) \
	LOADTEST_CONCURRENCY=$(LOADTEST_CONCURRENCY) \
	LOADTEST_REQUEST_TIMEOUT_S=$(LOADTEST_REQUEST_TIMEOUT_S) \
	LOADTEST_QC=$(LOADTEST_QC) \
	$(if $(LOADTEST_P95_BUDGET_MS),LOADTEST_P95_BUDGET_MS=$(LOADTEST_P95_BUDGET_MS),) \
	python3 scripts/load_test.py --out $(if $(OUT),$(OUT),artifacts/loadtest_report.md)

privacy-check:
	mkdir -p tmp
	npm run test:aurora-bff:unit
	node scripts/e2e_local_skin_analyze.cjs > tmp/privacy_check_stdout.log 2> tmp/privacy_check_stderr.log
	python3 scripts/log_scan.py --quiet

release-gate:
	python3 scripts/generate_release_gate.py

gate-debug:
	python3 scripts/generate_release_gate.py --debug

runtime-smoke:
	BASE=$(BASE) AURORA_LANG=$(AURORA_LANG) bash scripts/smoke_aurora_bff_runtime.sh

entry-smoke:
	BASE=$(BASE) AURORA_LANG=$(AURORA_LANG) bash scripts/smoke_entry_routes.sh

status:
	python3 scripts/status_snapshot.py --out $(if $(OUT),$(OUT),status_snapshot.json)

docs: status
	@echo "Status snapshot generated; docs are in docs/IMPLEMENTATION_STATUS.md and docs/NEXT_STEPS.md"

verify-daily:
	node scripts/report_verify_daily.js --in $(VERIFY_IN) --out $(VERIFY_OUT) $(if $(VERIFY_HARD_CASES),--hard-cases $(VERIFY_HARD_CASES),) $(if $(VERIFY_REPORT_DATE),--date $(VERIFY_REPORT_DATE),)

verify-fail-diagnose:
	node scripts/diagnose_verify_failures.js --in $(VERIFY_IN) --out $(VERIFY_FAIL_OUT) $(if $(VERIFY_HARD_CASES),--hard-cases $(VERIFY_HARD_CASES),) $(if $(VERIFY_REPORT_DATE),--date $(VERIFY_REPORT_DATE),)

pseudo-label-job:
	node scripts/run_pseudo_label_job.js --store-dir $(PSEUDO_STORE_DIR) --out-dir $(PSEUDO_OUT_DIR) $(if $(PSEUDO_JOB_DATE),--date $(PSEUDO_JOB_DATE),)

monitoring-validate:
	python3 scripts/monitoring_validate.py

gold-label-sample:
	node scripts/sample_gold_label_tasks.js $(if $(GOLD_TASKS_IN),--hardCases $(GOLD_TASKS_IN),) --out $(GOLD_TASKS_OUT) --total $(GOLD_TOTAL) --hardRatio $(GOLD_HARD_RATIO) --allowRoi $(GOLD_ALLOW_ROI) $(if $(GOLD_TASKS_DATE),--date $(GOLD_TASKS_DATE),) $(if $(GOLD_QUOTA_FILE),--quotaFile $(GOLD_QUOTA_FILE),) $(if $(GOLD_SEED),--seed $(GOLD_SEED),)

gold-seed-pack:
	node scripts/gold_seed_pack.mjs --limit "$(GOLD_SEED_LIMIT)" --buckets "$(GOLD_SEED_BUCKETS)" --bucket_min "$(GOLD_SEED_BUCKET_MIN)" --source_min "$(GOLD_SEED_SOURCE_MIN)" --tasks_out "$(GOLD_SEED_TASKS_OUT)" --manifest_out "$(GOLD_SEED_MANIFEST_OUT)" --report_dir "$(EVAL_REPORT_DIR)" --cache_dir "$(CACHE_DIR)" --internal_dir "$(if $(INTERNAL_DIR),$(INTERNAL_DIR),$(HOME)/Desktop/Aurora/internal test photos)" --lapa_dir "$(if $(LAPA_DIR),$(LAPA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/LaPa DB)" --celeba_dir "$(if $(CELEBA_DIR),$(CELEBA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/CelebAMask-HQ(1)/CelebAMask-HQ/CelebA-HQ-img)" $(if $(REVIEW_MD),--review_md "$(REVIEW_MD)",) $(if $(REVIEW_JSONL),--review_jsonl "$(REVIEW_JSONL)",) $(if $(GOLD_SEED),--seed "$(GOLD_SEED)",)

gold-round1-pack:
	node scripts/gold_round1_pack.mjs --run_id "$(RUN_ID)" --review_jsonl "$(REVIEW_JSONL)" --report_dir "$(EVAL_REPORT_DIR)" --internal_dir "$(if $(INTERNAL_DIR),$(INTERNAL_DIR),$(HOME)/Desktop/Aurora/internal test photos)" --cache_dir "$(CACHE_DIR)" --lapa_dir "$(if $(LAPA_DIR),$(LAPA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/LaPa DB)" --celeba_dir "$(if $(CELEBA_DIR),$(CELEBA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/CelebAMask-HQ(1)/CelebAMask-HQ/CelebA-HQ-img)" --limit_internal "$(if $(LIMIT_INTERNAL),$(LIMIT_INTERNAL),38)" --limit_lapa "$(if $(LIMIT_DATASET_LAPA),$(LIMIT_DATASET_LAPA),50)" --limit_celeba "$(if $(LIMIT_DATASET_CELEBA),$(LIMIT_DATASET_CELEBA),50)" --top_risk "$(if $(TOP_RISK),$(TOP_RISK),30)" --random_count "$(if $(RANDOM_COUNT),$(RANDOM_COUNT),20)" --guard_untriggered_min_ratio "$(if $(GUARD_UNTRIGGERED_MIN_RATIO),$(GUARD_UNTRIGGERED_MIN_RATIO),0.3)" --seed "$(if $(GOLD_ROUND1_SEED),$(GOLD_ROUND1_SEED),gold_round1_seed_v1)" --convert_heic "$(if $(CONVERT_HEIC),$(CONVERT_HEIC),true)" $(if $(OUT_ROOT),--out_root "$(OUT_ROOT)",) $(if $(HEIC_CONVERT_CMD),--heic_convert_cmd "$(HEIC_CONVERT_CMD)",)

gold-round1-real-pack:
	@test -n "$(REVIEW_JSONL)" || (echo "REVIEW_JSONL is required, e.g. reports/review_pack_mixed_<run_id>.jsonl" && exit 2)
	node scripts/gold_round1_real_pack.mjs --run_id "$(RUN_ID)" --review_in "$(REVIEW_JSONL)" --out "$(OUT)" --limit "$(if $(LIMIT),$(LIMIT),200)" --bucket_n "$(if $(BUCKET_N),$(BUCKET_N),60)" --seed "$(if $(GOLD_ROUND1_SEED),$(GOLD_ROUND1_SEED),gold_round1_real_seed_v1)" --limit_internal "$(if $(LIMIT_INTERNAL),$(LIMIT_INTERNAL),38)" --double_annotate_ratio "$(if $(DOUBLE_ANNOTATE_RATIO),$(DOUBLE_ANNOTATE_RATIO),0.1)" --internal_dir "$(if $(INTERNAL_DIR),$(INTERNAL_DIR),$(HOME)/Desktop/Aurora/internal test photos)" --cache_dir "$(CACHE_DIR)" --lapa_dir "$(if $(LAPA_DIR),$(LAPA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/LaPa DB)" --celeba_dir "$(if $(CELEBA_DIR),$(CELEBA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/CelebAMask-HQ(1)/CelebAMask-HQ/CelebA-HQ-img)"

gold-round1-runbook:
	@test -n "$(REVIEW_JSONL)" || (echo "REVIEW_JSONL is required, e.g. reports/review_pack_mixed_<run_id>.jsonl" && exit 2)
	node scripts/gold_round1_runbook.mjs --run_id "$(RUN_ID)" --review_jsonl "$(REVIEW_JSONL)" --out "$(OUT)" --report_dir "$(EVAL_REPORT_DIR)" --limit "$(if $(LIMIT),$(LIMIT),200)" --bucket_n "$(if $(BUCKET_N),$(BUCKET_N),60)" --double_annotate_ratio "$(if $(DOUBLE_ANNOTATE_RATIO),$(DOUBLE_ANNOTATE_RATIO),0.1)" --seed "$(if $(GOLD_ROUND1_SEED),$(GOLD_ROUND1_SEED),gold_round1_real_seed_v1)"

gold-label-import:
	@test -n "$(if $(ROUND1_IN),$(ROUND1_IN),$(GOLD_IMPORT_IN))" || (echo "ROUND1_IN (or GOLD_IMPORT_IN) is required" && exit 2)
	node scripts/gold_label_import.mjs --in "$(if $(ROUND1_IN),$(ROUND1_IN),$(GOLD_IMPORT_IN))" --out "$(if $(OUT),$(OUT),$(GOLD_IMPORT_OUT))" --qa_status "$(GOLD_IMPORT_QA_STATUS)" $(if $(GOLD_IMPORT_ANNOTATOR),--annotator "$(GOLD_IMPORT_ANNOTATOR)",)

eval-gold:
	node scripts/eval_gold.mjs --gold_labels "$(if $(GOLD_LABELS),$(GOLD_LABELS),$(EVAL_GOLD_LABELS))" --report_dir "$(EVAL_REPORT_DIR)" --grid_size "$(EVAL_GOLD_GRID)" --calibration_out "$(EVAL_GOLD_CAL_TRAIN_OUT)" --rerun_local "$(if $(EVAL_GOLD_RERUN_LOCAL),$(EVAL_GOLD_RERUN_LOCAL),true)" $(if $(PRED_JSONL),--pred_jsonl "$(PRED_JSONL)",$(if $(EVAL_GOLD_PRED_JSONL),--pred_jsonl "$(EVAL_GOLD_PRED_JSONL)",))

eval-gold-round1:
	@if [ -n "$(GOLD_EXPORT_JSON)" ]; then \
		test -n "$(RUN_ID)" || (echo "RUN_ID is required with GOLD_EXPORT_JSON" && exit 2); \
		node scripts/gold_label_import.mjs --in "$(GOLD_EXPORT_JSON)" --out "artifacts/gold_round1_$(RUN_ID)/gold_labels.ndjson" --qa_status "$(GOLD_IMPORT_QA_STATUS)" $(if $(GOLD_IMPORT_ANNOTATOR),--annotator "$(GOLD_IMPORT_ANNOTATOR)",); \
		node scripts/eval_gold.mjs --gold_labels "artifacts/gold_round1_$(RUN_ID)/gold_labels.ndjson" --report_dir "$(EVAL_REPORT_DIR)" --grid_size "$(EVAL_GOLD_GRID)" --calibration_out "artifacts/gold_round1_$(RUN_ID)/calibration_train_samples.ndjson" --rerun_local "true" $(if $(PRED_JSONL),--pred_jsonl "$(PRED_JSONL)",$(if $(EVAL_GOLD_PRED_JSONL),--pred_jsonl "$(EVAL_GOLD_PRED_JSONL)",)); \
	else \
		test -n "$(if $(GOLD_LABELS),$(GOLD_LABELS),$(EVAL_GOLD_LABELS))" || (echo "GOLD_LABELS (or EVAL_GOLD_LABELS) is required" && exit 2); \
		node scripts/eval_gold.mjs --gold_labels "$(if $(GOLD_LABELS),$(GOLD_LABELS),$(EVAL_GOLD_LABELS))" --report_dir "$(EVAL_REPORT_DIR)" --grid_size "$(EVAL_GOLD_GRID)" --calibration_out "$(EVAL_GOLD_CAL_TRAIN_OUT)" --rerun_local "true" $(if $(PRED_JSONL),--pred_jsonl "$(PRED_JSONL)",$(if $(EVAL_GOLD_PRED_JSONL),--pred_jsonl "$(EVAL_GOLD_PRED_JSONL)",)); \
	fi

eval-gold-ab:
	node scripts/eval_gold_ab.mjs --gold_labels "$(if $(GOLD_LABELS),$(GOLD_LABELS),$(EVAL_GOLD_LABELS))" --report_dir "$(EVAL_REPORT_DIR)" --grid_size "$(EVAL_GOLD_GRID)" --rerun_local "true" --under_eye_min_coverage "$(if $(EVAL_GOLD_AB_UNDER_EYE_MIN_COVERAGE),$(EVAL_GOLD_AB_UNDER_EYE_MIN_COVERAGE),0.08)" $(if $(EVAL_GOLD_AB_SWEEP),--variant3_sweep "$(EVAL_GOLD_AB_SWEEP)",) $(if $(PRED_JSONL),--pred_jsonl "$(PRED_JSONL)",$(if $(EVAL_GOLD_PRED_JSONL),--pred_jsonl "$(EVAL_GOLD_PRED_JSONL)",))

eval-gold-iaa:
	@test -n "$(LS_EXPORT)" || (echo "LS_EXPORT is required, e.g. artifacts/gold_round1_real_<run_id>/label_studio_export_round1_<run_id>.json" && exit 2)
	node scripts/eval_gold_iaa.mjs --ls_export "$(LS_EXPORT)" --run_id "$(RUN_ID)" --report_dir "$(EVAL_REPORT_DIR)" --grid_size "$(EVAL_GOLD_GRID)" --min_miou_threshold "$(if $(EVAL_GOLD_IAA_MIN_MIOU),$(EVAL_GOLD_IAA_MIN_MIOU),0.75)"

train-calibrator:
	node scripts/train_calibrator.js --modelOutputs $(CAL_MODEL_OUTPUTS) --goldLabels $(CAL_GOLD_LABELS) --outDir $(CAL_OUT_DIR) --aliasPath $(CAL_ALIAS_PATH) --iouThreshold $(CAL_IOU) --minGroupSamples $(CAL_MIN_GROUP_SAMPLES) $(if $(CAL_TRAIN_SAMPLES),--trainSamples $(CAL_TRAIN_SAMPLES),)

eval-calibration:
	node scripts/eval_calibration.js --model $(if $(CAL_EVAL_MODEL),$(CAL_EVAL_MODEL),$(CAL_ALIAS_PATH)) --modelOutputs $(CAL_MODEL_OUTPUTS) --goldLabels $(CAL_GOLD_LABELS) --iouThreshold $(CAL_IOU) --outJson $(CAL_EVAL_OUT)

eval-region-accuracy:
	node scripts/eval_region_accuracy.js --modelOutputs $(REGION_ACC_MODEL_OUTPUTS) --goldLabels $(REGION_ACC_GOLD_LABELS) --iouThreshold $(REGION_ACC_IOU) --outJson $(REGION_ACC_OUT_JSON) --outCsv $(REGION_ACC_OUT_CSV) --outMd $(REGION_ACC_OUT_MD) $(if $(REGION_ACC_PROVIDERS),--providers $(REGION_ACC_PROVIDERS),) $(if $(filter true,$(REGION_ACC_ALLOW_EMPTY_GOLD)),--allowEmptyGold true,)

reliability-table:
	node scripts/build_reliability_table.js --in $(RELIABILITY_IN) --out $(RELIABILITY_OUT) $(if $(RELIABILITY_DATE),--date $(RELIABILITY_DATE),)

shadow-daily:
	node scripts/run_shadow_daily.js --in $(SHADOW_VERIFY_IN) --hard-cases $(SHADOW_HARD_CASES) --reports-out $(SHADOW_REPORTS_OUT) --outputs-out $(SHADOW_OUTPUTS_OUT) $(if $(SHADOW_DAILY_DATE),--date $(SHADOW_DAILY_DATE),) $(if $(SHADOW_DAILY_SINCE),--since $(SHADOW_DAILY_SINCE),) $(if $(SHADOW_PSEUDO_MIN_AGREEMENT),--pseudo-min-agreement $(SHADOW_PSEUDO_MIN_AGREEMENT),)

shadow-smoke:
	BASE=$(SHADOW_BASE) CALLS=$(SHADOW_CALLS) WAIT_AFTER_SEC=$(SHADOW_WAIT_AFTER_SEC) EXPECT_GUARD=0 scripts/probe_verify_budget_guard.sh
	node scripts/run_shadow_daily.js --in $(SHADOW_VERIFY_IN) --hard-cases $(SHADOW_HARD_CASES) --reports-out $(SHADOW_REPORTS_OUT) --outputs-out $(SHADOW_OUTPUTS_OUT) $(if $(SHADOW_DAILY_DATE),--date $(SHADOW_DAILY_DATE),)

shadow-acceptance:
	node scripts/shadow_acceptance.js --base $(SHADOW_BASE) --calls $(SHADOW_CALLS) --guard-calls $(SHADOW_GUARD_CALLS) --wait-after-sec $(SHADOW_WAIT_AFTER_SEC) --allow-guard-test $(SHADOW_ALLOW_GUARD_TEST) --in $(SHADOW_VERIFY_IN) --hard-cases $(SHADOW_HARD_CASES) --reports-out $(SHADOW_REPORTS_OUT) --outputs-out $(SHADOW_OUTPUTS_OUT) --min-used-photos-ratio $(SHADOW_MIN_USED_PHOTOS_RATIO) --max-pass-fail-rate $(SHADOW_MAX_PASS_FAIL_RATE) --max-timeout-rate $(SHADOW_MAX_TIMEOUT_RATE) --max-upstream-5xx-rate $(SHADOW_MAX_UPSTREAM_5XX_RATE) $(if $(SHADOW_DAILY_DATE),--date $(SHADOW_DAILY_DATE),) $(if $(SHADOW_DAILY_SINCE),--since $(SHADOW_DAILY_SINCE),)

ingest-ingredient-sources:
	node scripts/ingest_ingredient_sources.js --data-dir $(INGREDIENT_KB_DATA_DIR) --artifact-path $(INGREDIENT_KB_ARTIFACT) --manifest-path $(INGREDIENT_KB_MANIFEST) --sources-report $(INGREDIENT_KB_SOURCES_REPORT) --claims-audit-report $(INGREDIENT_KB_CLAIMS_AUDIT) $(if $(filter true,$(INGREDIENT_KB_FETCH_LIVE)),--fetch-live,)

ingredient-kb-audit:
	node scripts/ingest_ingredient_sources.js --audit-only --artifact-path $(INGREDIENT_KB_ARTIFACT) --claims-audit-report $(INGREDIENT_KB_CLAIMS_AUDIT) --fail-on-audit

ingredient-kb-dry-run:
	node scripts/ingest_ingredient_sources.js --dry-run --fail-on-audit --data-dir $(INGREDIENT_KB_DATA_DIR) --artifact-path $(INGREDIENT_KB_ARTIFACT) --manifest-path $(INGREDIENT_KB_MANIFEST) --sources-report $(INGREDIENT_KB_SOURCES_REPORT) --claims-audit-report $(INGREDIENT_KB_CLAIMS_AUDIT) $(if $(filter true,$(INGREDIENT_KB_FETCH_LIVE)),--fetch-live,)

claims-audit:
	node scripts/claims_audit.js --out $(CLAIMS_AUDIT_REPORT)

photo-modules-acceptance:
	bash scripts/accept_photo_modules_backend.sh
	node scripts/accept_photo_modules_frontend.mjs
	node scripts/audit_analytics_payloads.js

photo-modules-prod-smoke:
	bash scripts/smoke_photo_modules_production.sh

internal-batch:
	@TOKEN="$(TOKEN)" node scripts/internal_batch_run_photos.mjs --photos-dir "$(PHOTOS_DIR)" --base "$(BASE)" --market "$(MARKET)" --lang "$(LANG)" --mode "$(MODE)" --concurrency "$(CONCURRENCY)" --timeout_ms "$(TIMEOUT_MS)" --retry "$(RETRY)" --max-edge "$(MAX_EDGE)" $(if $(LIMIT),--limit "$(LIMIT)",) $(if $(filter true,$(SHUFFLE)),--shuffle,) $(if $(filter false,$(SANITIZE)),--no-sanitize,) $(if $(filter true,$(FAIL_FAST_ON_CLAIM_VIOLATION)),--fail_fast_on_claim_violation,)

datasets-prepare:
	node scripts/datasets_prepare.mjs --raw_dir "$(RAW_DIR)" --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)"

datasets-audit:
	node scripts/datasets_audit.mjs --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)"

datasets-ingest-local:
	node scripts/datasets_ingest_local.mjs --datasets "$(DATASETS)" --cache_dir "$(CACHE_DIR)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(DATASET_ROOT),--dataset_root "$(DATASET_ROOT)",) $(if $(LAPA_DIR),--lapa_root "$(LAPA_DIR)",) $(if $(CELEBA_DIR),--celebamaskhq_root "$(CELEBA_DIR)",) $(if $(FASSEG_DIR),--fasseg_root "$(FASSEG_DIR)",) $(if $(ACNE04_DIR),--acne04_root "$(ACNE04_DIR)",) $(if $(PREFLIGHT_SAMPLE_COUNT),--preflight_sample "$(PREFLIGHT_SAMPLE_COUNT)",)

train-circle-prior:
	node scripts/train_circle_prior_model.mjs --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)" --concurrency "$(EVAL_CONCURRENCY)" --grid_size "$(EVAL_GRID_SIZE)" --report_dir "$(EVAL_REPORT_DIR)" --model_out "$(CIRCLE_MODEL_OUT)" --alias_out "$(CIRCLE_MODEL_ALIAS)" --min_part_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" $(if $(LIMIT),--limit "$(LIMIT)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,)

eval-circle:
	CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_CALIBRATION="$(CIRCLE_MODEL_CALIBRATION)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_accuracy.mjs --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --report_dir "$(EVAL_REPORT_DIR)" --circle_model_path "$(EVAL_CIRCLE_MODEL_PATH)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" $(if $(LIMIT),--limit "$(LIMIT)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,) $(if $(filter false,$(CIRCLE_MODEL_CALIBRATION)),--disable_circle_model_calibration,)

eval-circle-fasseg:
	@set -euo pipefail; \
	OUT="$$(CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_CALIBRATION="$(CIRCLE_MODEL_CALIBRATION)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_accuracy.mjs --cache_dir "$(CACHE_DIR)" --datasets "fasseg" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --report_dir "$(EVAL_REPORT_DIR)" --circle_model_path "$(EVAL_CIRCLE_MODEL_PATH)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" --limit "$(if $(LIMIT),$(LIMIT),200)" $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,) $(if $(filter false,$(CIRCLE_MODEL_CALIBRATION)),--disable_circle_model_calibration,) 2>&1)"; \
	printf "%s\n" "$$OUT"; \
	JSON_LINE="$$(printf "%s\n" "$$OUT" | tail -n 1)"; \
	node -e 'const payload=JSON.parse(process.argv[1]); const summaryRows=Number(payload.summary_rows||0); const leakBg=Number(payload.leakage_bg_mean||0); const emptyRate=Number(payload.empty_module_rate||0); const segOnly=String(payload.dataset_eval_mode||"").toLowerCase()==="segmentation_only"; if (!(summaryRows>0)) { console.error("eval-circle-fasseg hard gate failed: empty Per-Module Summary"); console.error("Check jsonl fail reasons + gt/pred stats:", payload && payload.artifacts ? payload.artifacts.jsonl : "reports/eval_circle_*.jsonl"); process.exit(3); } if (segOnly && (leakBg>0.1 || emptyRate>0.01)) { console.error("eval-circle-fasseg segmentation-only hard gate failed: leakage_bg_mean="+leakBg+" empty_module_rate="+emptyRate); process.exit(4); }' "$$JSON_LINE"

eval-circle-celeba-parsing:
	CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_CALIBRATION="$(CIRCLE_MODEL_CALIBRATION)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_accuracy.mjs --cache_dir "$(CACHE_DIR)" --datasets "celebamaskhq" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --report_dir "$(EVAL_REPORT_DIR)" --circle_model_path "$(EVAL_CIRCLE_MODEL_PATH)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" --limit "$(if $(LIMIT),$(LIMIT),150)" $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,) $(if $(filter false,$(CIRCLE_MODEL_CALIBRATION)),--disable_circle_model_calibration,)

eval-circle-crossset:
	CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_CALIBRATION="$(CIRCLE_MODEL_CALIBRATION)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_crossset.mjs --datasets "$(if $(EVAL_CROSSSET_DATASETS),$(EVAL_CROSSSET_DATASETS),celebamaskhq,lapa,fasseg)" --cache_dir "$(CACHE_DIR)" --report_dir "$(EVAL_REPORT_DIR)" --limit "$(if $(LIMIT),$(LIMIT),150)" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --circle_model_path "$(if $(EVAL_CIRCLE_MODEL_PATH),$(EVAL_CIRCLE_MODEL_PATH),model_registry/circle_prior_latest.json)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(EVAL_TOKEN),--token "$(EVAL_TOKEN)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,) $(if $(filter false,$(CIRCLE_MODEL_CALIBRATION)),--disable_circle_model_calibration,)

train-skinmask:
	python3 -m ml.skinmask_train.train --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)" --epochs "$(EPOCHS)" --batch_size "$(BATCH)" --num_workers "$(SKINMASK_NUM_WORKERS)" --image_size "$(SKINMASK_IMAGE_SIZE)" --out_dir "$(SKINMASK_OUT_DIR)" --backbone_name "$(SKINMASK_BACKBONE)" $(if $(LIMIT),--limit_per_dataset "$(LIMIT)",)

export-skinmask:
	python3 -m ml.skinmask_train.export_onnx --ckpt "$(CKPT)" --out "$(if $(OUT),$(OUT),$(ONNX))" --image_size "$(SKINMASK_IMAGE_SIZE)"

eval-skinmask:
	node scripts/skinmask_ablation_report.mjs --onnx "$(ONNX)" --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(LIMIT),--limit "$(LIMIT)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,)

eval-skinmask-fasseg:
	node scripts/eval_skinmask_fasseg.mjs --cache_dir "$(CACHE_DIR)" --report_dir "$(EVAL_REPORT_DIR)" --onnx "$(if $(ONNX),$(ONNX),artifacts/skinmask_v2.onnx)" --limit "$(if $(LIMIT),$(LIMIT),150)" --grid_size "$(EVAL_GRID_SIZE)" --timeout_ms "$(EVAL_TIMEOUT_MS)" $(if $(EVAL_SAMPLE_SEED),--seed "$(EVAL_SAMPLE_SEED)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,)

eval-gt-sanity-fasseg:
	node scripts/eval_gt_sanity_fasseg.mjs --cache_dir "$(CACHE_DIR)" --report_dir "$(EVAL_REPORT_DIR)" --limit "$(if $(LIMIT),$(LIMIT),150)" --grid_size "$(EVAL_GRID_SIZE)" $(if $(EVAL_SAMPLE_SEED),--seed "$(EVAL_SAMPLE_SEED)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,)

eval-circle-ab:
	CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_CALIBRATION="$(CIRCLE_MODEL_CALIBRATION)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_ab_compare.mjs --onnx "$(ONNX)" --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --report_dir "$(EVAL_REPORT_DIR)" --circle_model_path "$(EVAL_CIRCLE_MODEL_PATH)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" $(if $(LIMIT),--limit "$(LIMIT)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(EVAL_TOKEN),--token "$(EVAL_TOKEN)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,) $(if $(filter false,$(CIRCLE_MODEL_CALIBRATION)),--disable_circle_model_calibration,)

eval-circle-fasseg-ab:
	CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_CALIBRATION="$(CIRCLE_MODEL_CALIBRATION)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_ab_compare.mjs --onnx "$(if $(ONNX),$(ONNX),artifacts/skinmask_v2.onnx)" --cache_dir "$(CACHE_DIR)" --datasets "fasseg" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --report_dir "$(EVAL_REPORT_DIR)" --circle_model_path "$(EVAL_CIRCLE_MODEL_PATH)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" --limit "$(if $(LIMIT),$(LIMIT),150)" $(if $(EVAL_SAMPLE_SEED),--sample_seed "$(EVAL_SAMPLE_SEED)",) $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(EVAL_TOKEN),--token "$(EVAL_TOKEN)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,) $(if $(filter false,$(CIRCLE_MODEL_CALIBRATION)),--disable_circle_model_calibration,)

eval-circle-fasseg-matrix:
	CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_fasseg_matrix.mjs --cache_dir "$(CACHE_DIR)" --report_dir "$(EVAL_REPORT_DIR)" --limit "$(if $(LIMIT),$(LIMIT),150)" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --circle_model_path "$(if $(EVAL_CIRCLE_MODEL_PATH),$(EVAL_CIRCLE_MODEL_PATH),model_registry/circle_prior_latest.json)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" --sample_seed "$(if $(EVAL_SAMPLE_SEED),$(EVAL_SAMPLE_SEED),fasseg_matrix_seed_v1)" $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(EVAL_TOKEN),--token "$(EVAL_TOKEN)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,)

internal-photo-review-pack:
	PHOTO_DIR="$(PHOTO_DIR)" BASE="$(if $(EVAL_BASE_URL),$(EVAL_BASE_URL),$(BASE))" TOKEN="$(if $(EVAL_TOKEN),$(EVAL_TOKEN),$(TOKEN))" MARKET="$(MARKET)" LANG="$(LANG)" EVAL_REPORT_DIR="$(EVAL_REPORT_DIR)" LIMIT="$(if $(LIMIT),$(LIMIT),200)" EVAL_CONCURRENCY="$(EVAL_CONCURRENCY)" TIMEOUT_MS="$(EVAL_TIMEOUT_MS)" RETRY="$(if $(RETRY),$(RETRY),2)" SAMPLE_SEED="$(if $(EVAL_SAMPLE_SEED),$(EVAL_SAMPLE_SEED),review_pack_seed_v1)" CHOSEN_GROUP="$(CHOSEN_GROUP)" MATRIX_REPORT="$(MATRIX_REPORT)" node scripts/internal_photo_review_pack.mjs --photo_dir "$(PHOTO_DIR)" --market "$(MARKET)" --lang "$(LANG)" --report_dir "$(EVAL_REPORT_DIR)" --limit "$(if $(LIMIT),$(LIMIT),200)" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --retry "$(if $(RETRY),$(RETRY),2)" --max_edge "$(MAX_EDGE)" --seed "$(if $(EVAL_SAMPLE_SEED),$(EVAL_SAMPLE_SEED),review_pack_seed_v1)" $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",$(if $(BASE),--base_url "$(BASE)",)) $(if $(CHOSEN_GROUP),--group "$(CHOSEN_GROUP)",) $(if $(MATRIX_REPORT),--matrix_report "$(MATRIX_REPORT)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) $(if $(EVAL_TOKEN),--token "$(EVAL_TOKEN)",)

review-pack-mixed:
	INTERNAL_DIR="$(if $(INTERNAL_DIR),$(INTERNAL_DIR),$(HOME)/Desktop/Aurora/internal test photos)" \
	LAPA_DIR="$(if $(LAPA_DIR),$(LAPA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/LaPa DB)" \
	CELEBA_DIR="$(if $(CELEBA_DIR),$(CELEBA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/CelebAMask-HQ(1)/CelebAMask-HQ/CelebA-HQ-img)" \
	CACHE_DIR="$(CACHE_DIR)" \
	BASE="$(if $(EVAL_BASE_URL),$(EVAL_BASE_URL),$(BASE))" \
	TOKEN="$(if $(EVAL_TOKEN),$(EVAL_TOKEN),$(TOKEN))" \
	MARKET="$(MARKET)" \
	LANG="$(LANG)" \
	EVAL_REPORT_DIR="$(EVAL_REPORT_DIR)" \
	LIMIT_INTERNAL="$(if $(LIMIT_INTERNAL),$(LIMIT_INTERNAL),51)" \
	LIMIT_DATASET_FASSEG="$(if $(LIMIT_DATASET_FASSEG),$(LIMIT_DATASET_FASSEG),150)" \
	LIMIT_DATASET_LAPA="$(if $(LIMIT_DATASET_LAPA),$(LIMIT_DATASET_LAPA),50)" \
	LIMIT_DATASET_CELEBA="$(if $(LIMIT_DATASET_CELEBA),$(LIMIT_DATASET_CELEBA),50)" \
	EVAL_CONCURRENCY="$(EVAL_CONCURRENCY)" \
	TIMEOUT_MS="$(EVAL_TIMEOUT_MS)" \
	RETRY="$(if $(RETRY),$(RETRY),2)" \
	RUN_MODE="$(if $(RUN_MODE),$(RUN_MODE),auto)" \
	SAMPLE_SEED="$(if $(EVAL_SAMPLE_SEED),$(EVAL_SAMPLE_SEED),review_pack_mixed_seed_v1)" \
	CHOSEN_GROUP="$(CHOSEN_GROUP)" \
	MATRIX_REPORT="$(MATRIX_REPORT)" \
	node scripts/review_pack_mixed.mjs \
		--internal_dir "$(if $(INTERNAL_DIR),$(INTERNAL_DIR),$(HOME)/Desktop/Aurora/internal test photos)" \
		--lapa_dir "$(if $(LAPA_DIR),$(LAPA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/LaPa DB)" \
		--celeba_dir "$(if $(CELEBA_DIR),$(CELEBA_DIR),$(HOME)/Desktop/Aurora/datasets_raw/CelebAMask-HQ(1)/CelebAMask-HQ/CelebA-HQ-img)" \
		--cache_dir "$(CACHE_DIR)" \
		--market "$(MARKET)" \
		--lang "$(LANG)" \
		--report_dir "$(EVAL_REPORT_DIR)" \
		--limit_internal "$(if $(LIMIT_INTERNAL),$(LIMIT_INTERNAL),51)" \
		--limit_dataset_fasseg "$(if $(LIMIT_DATASET_FASSEG),$(LIMIT_DATASET_FASSEG),150)" \
		--limit_dataset_lapa "$(if $(LIMIT_DATASET_LAPA),$(LIMIT_DATASET_LAPA),50)" \
		--limit_dataset_celeba "$(if $(LIMIT_DATASET_CELEBA),$(LIMIT_DATASET_CELEBA),50)" \
		--concurrency "$(EVAL_CONCURRENCY)" \
		--timeout_ms "$(EVAL_TIMEOUT_MS)" \
		--retry "$(if $(RETRY),$(RETRY),2)" \
		--run_mode "$(if $(RUN_MODE),$(RUN_MODE),auto)" \
		--max_edge "$(MAX_EDGE)" \
		--seed "$(if $(EVAL_SAMPLE_SEED),$(EVAL_SAMPLE_SEED),review_pack_mixed_seed_v1)" \
		$(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",$(if $(BASE),--base_url "$(BASE)",)) \
		$(if $(CHOSEN_GROUP),--chosen_group "$(CHOSEN_GROUP)",) \
		$(if $(MATRIX_REPORT),--matrix_report "$(MATRIX_REPORT)",) \
		$(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,) \
		$(if $(EVAL_TOKEN),--token "$(EVAL_TOKEN)",)

preference-round1-pack:
	@test -n "$(REVIEW_JSONL)" || (echo "REVIEW_JSONL is required, e.g. reports/review_pack_mixed_<run_id>.jsonl" && exit 2)
	node scripts/preference_round1_pack.mjs --run_id "$(RUN_ID)" --review_in "$(REVIEW_JSONL)" --variant "$(if $(VARIANT),$(VARIANT),$(PREFERENCE_VARIANT))" --seed "$(if $(PREFERENCE_SEED),$(PREFERENCE_SEED),preference_round1_seed_v1)" --limit_internal "$(if $(LIMIT_INTERNAL),$(LIMIT_INTERNAL),38)" --limit_lapa "$(if $(LIMIT_LAPA),$(LIMIT_LAPA),60)" --limit_celeba "$(if $(LIMIT_CELEBA),$(LIMIT_CELEBA),60)" --internal_dir "$(if $(INTERNAL_DIR),$(INTERNAL_DIR),$(HOME)/Desktop/Aurora/internal test photos)" --cache_dir "$(CACHE_DIR)" --module_box_mode "$(if $(PREFERENCE_MODULE_BOX_MODE),$(PREFERENCE_MODULE_BOX_MODE),dynamic_skinmask)" --require_dynamic_boxes "$(if $(PREFERENCE_REQUIRE_DYNAMIC_BOXES),$(PREFERENCE_REQUIRE_DYNAMIC_BOXES),true)" --exclude_template_like "$(if $(PREFERENCE_EXCLUDE_TEMPLATE_LIKE),$(PREFERENCE_EXCLUDE_TEMPLATE_LIKE),false)" --min_geometry_qc_score "$(if $(PREFERENCE_MIN_GEOMETRY_QC_SCORE),$(PREFERENCE_MIN_GEOMETRY_QC_SCORE),0.2)" --template_match_eps "$(if $(PREFERENCE_TEMPLATE_MATCH_EPS),$(PREFERENCE_TEMPLATE_MATCH_EPS),0.004)" --hard_filter_gate "$(if $(PREFERENCE_HARD_FILTER_GATE),$(PREFERENCE_HARD_FILTER_GATE),true)" --hard_filter_require_quality_pass "$(if $(PREFERENCE_HARD_FILTER_REQUIRE_QUALITY_PASS),$(PREFERENCE_HARD_FILTER_REQUIRE_QUALITY_PASS),true)" --hard_filter_max_guarded_modules "$(if $(PREFERENCE_HARD_FILTER_MAX_GUARDED_MODULES),$(PREFERENCE_HARD_FILTER_MAX_GUARDED_MODULES),1)" --hard_filter_min_module_pixels "$(if $(PREFERENCE_HARD_FILTER_MIN_MODULE_PIXELS),$(PREFERENCE_HARD_FILTER_MIN_MODULE_PIXELS),48)" --hard_filter_min_dynamic_score "$(if $(PREFERENCE_HARD_FILTER_MIN_DYNAMIC_SCORE),$(PREFERENCE_HARD_FILTER_MIN_DYNAMIC_SCORE),0.7)" --hard_filter_min_box_plausibility "$(if $(PREFERENCE_HARD_FILTER_MIN_BOX_PLAUSIBILITY),$(PREFERENCE_HARD_FILTER_MIN_BOX_PLAUSIBILITY),0.72)" --hard_filter_min_mask_rle_ratio "$(if $(PREFERENCE_HARD_FILTER_MIN_MASK_RLE_RATIO),$(PREFERENCE_HARD_FILTER_MIN_MASK_RLE_RATIO),0)" --hard_filter_require_all_strong_modules "$(if $(PREFERENCE_HARD_FILTER_REQUIRE_ALL_STRONG_MODULES),$(PREFERENCE_HARD_FILTER_REQUIRE_ALL_STRONG_MODULES),true)" --hard_filter_fail_on_empty "$(if $(PREFERENCE_HARD_FILTER_FAIL_ON_EMPTY),$(PREFERENCE_HARD_FILTER_FAIL_ON_EMPTY),true)" --max_edge "$(MAX_EDGE)" --concurrency "$(EVAL_CONCURRENCY)" $(if $(OUT),--out "$(OUT)",) $(if $(MOCK_PIPELINE),--mock_pipeline "$(MOCK_PIPELINE)",)

preference-round1-real-pack:
	@test -n "$(INTERNAL_DIR)" || (echo "INTERNAL_DIR is required for real round1 pack" && exit 2)
	node scripts/preference_round1_real_runbook.mjs --run_id "$(RUN_ID)" --internal_dir "$(INTERNAL_DIR)" --seed "$(if $(PREFERENCE_SEED),$(PREFERENCE_SEED),preference_round1_real_seed_v1)" --external_index_lapa "$(if $(EXTERNAL_INDEX_LAPA),$(EXTERNAL_INDEX_LAPA),$(CACHE_DIR)/lapa/index.jsonl)" --external_index_celeba "$(if $(EXTERNAL_INDEX_CELEBA),$(EXTERNAL_INDEX_CELEBA),$(CACHE_DIR)/celebamaskhq/index.jsonl)" --cache_dir "$(CACHE_DIR)" --limit_internal "$(if $(LIMIT_INTERNAL),$(LIMIT_INTERNAL),60)" --limit_lapa "$(if $(LIMIT_LAPA),$(LIMIT_LAPA),70)" --limit_celeba "$(if $(LIMIT_CELEBA),$(LIMIT_CELEBA),70)" --target_total "$(if $(TARGET_TOTAL),$(TARGET_TOTAL),200)" --overlap_ratio "$(if $(OVERLAP_RATIO),$(OVERLAP_RATIO),$(if $(IAA_RATIO),$(IAA_RATIO),0.25))" --overlap_min "$(if $(OVERLAP_MIN),$(OVERLAP_MIN),40)" --module_box_mode "$(if $(PREFERENCE_MODULE_BOX_MODE),$(PREFERENCE_MODULE_BOX_MODE),dynamic_skinmask)" --require_dynamic_boxes "$(if $(PREFERENCE_REQUIRE_DYNAMIC_BOXES),$(PREFERENCE_REQUIRE_DYNAMIC_BOXES),true)" --exclude_template_like "$(if $(PREFERENCE_EXCLUDE_TEMPLATE_LIKE),$(PREFERENCE_EXCLUDE_TEMPLATE_LIKE),false)" --min_geometry_qc_score "$(if $(PREFERENCE_MIN_GEOMETRY_QC_SCORE),$(PREFERENCE_MIN_GEOMETRY_QC_SCORE),0.2)" --template_match_eps "$(if $(PREFERENCE_TEMPLATE_MATCH_EPS),$(PREFERENCE_TEMPLATE_MATCH_EPS),0.004)" --hard_filter_gate "$(if $(PREFERENCE_HARD_FILTER_GATE),$(PREFERENCE_HARD_FILTER_GATE),true)" --hard_filter_require_quality_pass "$(if $(PREFERENCE_HARD_FILTER_REQUIRE_QUALITY_PASS),$(PREFERENCE_HARD_FILTER_REQUIRE_QUALITY_PASS),true)" --hard_filter_max_guarded_modules "$(if $(PREFERENCE_HARD_FILTER_MAX_GUARDED_MODULES),$(PREFERENCE_HARD_FILTER_MAX_GUARDED_MODULES),1)" --hard_filter_min_module_pixels "$(if $(PREFERENCE_HARD_FILTER_MIN_MODULE_PIXELS),$(PREFERENCE_HARD_FILTER_MIN_MODULE_PIXELS),48)" --hard_filter_min_dynamic_score "$(if $(PREFERENCE_HARD_FILTER_MIN_DYNAMIC_SCORE),$(PREFERENCE_HARD_FILTER_MIN_DYNAMIC_SCORE),0.7)" --hard_filter_min_box_plausibility "$(if $(PREFERENCE_HARD_FILTER_MIN_BOX_PLAUSIBILITY),$(PREFERENCE_HARD_FILTER_MIN_BOX_PLAUSIBILITY),0.72)" --hard_filter_min_mask_rle_ratio "$(if $(PREFERENCE_HARD_FILTER_MIN_MASK_RLE_RATIO),$(PREFERENCE_HARD_FILTER_MIN_MASK_RLE_RATIO),0)" --hard_filter_require_all_strong_modules "$(if $(PREFERENCE_HARD_FILTER_REQUIRE_ALL_STRONG_MODULES),$(PREFERENCE_HARD_FILTER_REQUIRE_ALL_STRONG_MODULES),true)" --hard_filter_fail_on_empty "$(if $(PREFERENCE_HARD_FILTER_FAIL_ON_EMPTY),$(PREFERENCE_HARD_FILTER_FAIL_ON_EMPTY),true)" --max_edge "$(if $(PREFERENCE_MAX_EDGE),$(PREFERENCE_MAX_EDGE),512)" --concurrency "$(EVAL_CONCURRENCY)" $(if $(OUT),--out "$(OUT)",) $(if $(REVIEW_PACK_JSONL),--review_pack_jsonl "$(REVIEW_PACK_JSONL)",$(if $(REVIEW_JSONL),--review_pack_jsonl "$(REVIEW_JSONL)",)) $(if $(MOCK_PIPELINE),--mock_pipeline "$(MOCK_PIPELINE)",)

preference-label-import:
	@EXPORT_PATHS="$(if $(EXPORTS),$(EXPORTS),)"; \
	INPUT_PATH="$(if $(ROUND1_IN),$(ROUND1_IN),$(IN))"; \
	test -n "$$EXPORT_PATHS$$INPUT_PATH" || (echo "provide EXPORTS=<a.json,b.json> or IN/ROUND1_IN=<path>" && exit 2); \
	if [ -n "$$EXPORT_PATHS" ]; then \
		node scripts/preference_label_import.mjs --exports "$$EXPORT_PATHS" --run_id "$(RUN_ID)" --all_annotations "$(if $(PREFERENCE_IMPORT_ALL_ANNOTATIONS),$(PREFERENCE_IMPORT_ALL_ANNOTATIONS),true)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(OUT),--out "$(OUT)",) $(if $(MANIFEST),--manifest "$(MANIFEST)",) $(if $(BASELINE_ID),--baseline_id "$(BASELINE_ID)",) $(if $(VARIANT_ID),--variant_id "$(VARIANT_ID)",); \
	else \
		node scripts/preference_label_import.mjs --in "$$INPUT_PATH" --run_id "$(RUN_ID)" --all_annotations "$(if $(PREFERENCE_IMPORT_ALL_ANNOTATIONS),$(PREFERENCE_IMPORT_ALL_ANNOTATIONS),true)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(OUT),--out "$(OUT)",) $(if $(MANIFEST),--manifest "$(MANIFEST)",) $(if $(BASELINE_ID),--baseline_id "$(BASELINE_ID)",) $(if $(VARIANT_ID),--variant_id "$(VARIANT_ID)",); \
	fi

preference-import:
	@test -n "$(EXPORTS)" || (echo "EXPORTS is required, e.g. label_studio_export_a.json,label_studio_export_b.json" && exit 2)
	@test -n "$(MANIFEST)" || (echo "MANIFEST is required" && exit 2)
	node scripts/preference_label_import.mjs --exports "$(EXPORTS)" --manifest "$(MANIFEST)" --run_id "$(RUN_ID)" --all_annotations "$(if $(PREFERENCE_IMPORT_ALL_ANNOTATIONS),$(PREFERENCE_IMPORT_ALL_ANNOTATIONS),true)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(OUT),--out "$(OUT)",) $(if $(BASELINE_ID),--baseline_id "$(BASELINE_ID)",) $(if $(VARIANT_ID),--variant_id "$(VARIANT_ID)",)

eval-preference:
	@LABELS_PATH="$(if $(PREFERENCE_LABELS),$(PREFERENCE_LABELS),$(LABELS))"; \
	test -n "$$LABELS_PATH" || (echo "LABELS (or PREFERENCE_LABELS) is required, e.g. artifacts/preference_round1_<run_id>/preference_labels.ndjson" && exit 2); \
	node scripts/eval_preference.mjs --labels "$$LABELS_PATH" --run_id "$(RUN_ID)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(MANIFEST),--manifest "$(MANIFEST)",) $(if $(OUT_JSONL),--out_jsonl "$(OUT_JSONL)",)

preference-adjudication-pack:
	@test -n "$(EVAL_JSONL)" || (echo "EVAL_JSONL is required, e.g. reports/eval_preference_<run_id>.jsonl" && exit 2)
	@MANIFEST_PATH="$(if $(MANIFEST),$(MANIFEST),$(if $(RUN_ID),artifacts/preference_round1_$(RUN_ID)/manifest.json,))"; \
	test -n "$$MANIFEST_PATH" || (echo "MANIFEST is required (or provide RUN_ID for default artifacts/preference_round1_<run_id>/manifest.json)" && exit 2); \
	node scripts/preference_adjudication_pack.mjs --eval_jsonl "$(EVAL_JSONL)" --manifest "$$MANIFEST_PATH" --run_id "$(RUN_ID)" --limit "$(if $(LIMIT),$(LIMIT),$(PREFERENCE_ADJ_LIMIT))" $(if $(OUT),--out "$(OUT)",)

preference-adjudication-merge:
	@BASE_PATH="$(if $(BASE_LABELS),$(BASE_LABELS),$(BASE))"; \
	ADJ_PATH="$(if $(ADJ_LABELS),$(ADJ_LABELS),$(ADJ))"; \
	test -n "$$BASE_PATH" || (echo "BASE_LABELS (or BASE) is required" && exit 2); \
	test -n "$$ADJ_PATH" || (echo "ADJ_LABELS (or ADJ) is required" && exit 2); \
	node scripts/preference_merge_adjudication.mjs --base_labels "$$BASE_PATH" --adj_labels "$$ADJ_PATH" --run_id "$(RUN_ID)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(OUT),--out "$(OUT)",)

preference-final:
	@test -n "$(MANIFEST)" || (echo "MANIFEST is required" && exit 2)
	@test -n "$(BASE_EXPORTS)" || (echo "BASE_EXPORTS is required, e.g. export_batch_a.json,export_batch_b.json" && exit 2)
	node scripts/preference_eval_final.mjs --run_id "$(RUN_ID)" --manifest "$(MANIFEST)" --base_exports "$(BASE_EXPORTS)" --report_dir "$(EVAL_REPORT_DIR)" --all_annotations "$(if $(PREFERENCE_IMPORT_ALL_ANNOTATIONS),$(PREFERENCE_IMPORT_ALL_ANNOTATIONS),true)" --overall_delta_min "$(if $(OVERALL_DELTA_MIN),$(OVERALL_DELTA_MIN),0.05)" --forehead_delta_min "$(if $(FOREHEAD_DELTA_MIN),$(FOREHEAD_DELTA_MIN),0.10)" --cannot_tell_max "$(if $(CANNOT_TELL_MAX),$(CANNOT_TELL_MAX),0.25)" --iaa_kappa_min "$(if $(IAA_KAPPA_MIN),$(IAA_KAPPA_MIN),0.2)" --iaa_agreement_min "$(if $(IAA_AGREEMENT_MIN),$(IAA_AGREEMENT_MIN),0.6)" --limit_top "$(if $(LIMIT_TOP),$(LIMIT_TOP),20)" $(if $(ADJ_EXPORTS),--adj_exports "$(ADJ_EXPORTS)",) $(if $(OUT),--out_dir "$(OUT)",)

preference-diagnostics:
	@LABELS_PATH="$(if $(LABELS),$(LABELS),$(PREFERENCE_LABELS))"; \
	test -n "$(RUN_ID)" || (echo "RUN_ID is required" && exit 2); \
	test -n "$(MANIFEST)" || (echo "MANIFEST is required" && exit 2); \
	test -n "$(EVAL_JSONL)" || (echo "EVAL_JSONL is required" && exit 2); \
	test -n "$$LABELS_PATH" || (echo "LABELS (or PREFERENCE_LABELS) is required" && exit 2); \
	node scripts/preference_diagnostics.mjs --run_id "$(RUN_ID)" --manifest "$(MANIFEST)" --eval_jsonl "$(EVAL_JSONL)" --labels "$$LABELS_PATH" --out_dir "$(if $(OUT),$(OUT),$(EVAL_REPORT_DIR))" --overlay_gate_coverage_min "$(if $(OVERLAY_GATE_COVERAGE_MIN),$(OVERLAY_GATE_COVERAGE_MIN),0.98)" --overlay_gate_consistency_min "$(if $(OVERLAY_GATE_CONSISTENCY_MIN),$(OVERLAY_GATE_CONSISTENCY_MIN),0.98)" --overlay_gate_epsilon "$(if $(OVERLAY_GATE_EPSILON),$(OVERLAY_GATE_EPSILON),0.000001)" $(if $(CROSSSET_JSONL),--crossset_jsonl "$(CROSSSET_JSONL)",) $(if $(GOLD_EVAL_MD),--gold_eval_md "$(GOLD_EVAL_MD)",)

preference-overlay-gate:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required" && exit 2)
	@test -n "$(MANIFEST)" || (echo "MANIFEST is required" && exit 2)
	@test -n "$(EVAL_JSONL)" || (echo "EVAL_JSONL is required" && exit 2)
	@LABELS_PATH="$(if $(LABELS),$(LABELS),$(PREFERENCE_LABELS))"; \
	if [ -z "$$LABELS_PATH" ]; then LABELS_PATH="$(if $(RUN_ID),artifacts/preference_round1_$(RUN_ID)/preference_labels.ndjson,)"; fi; \
	node scripts/preference_diagnostics.mjs --run_id "$(RUN_ID)" --manifest "$(MANIFEST)" --eval_jsonl "$(EVAL_JSONL)" --labels "$$LABELS_PATH" --overlay_gate_only "true" --overlay_gate_coverage_min "$(if $(OVERLAY_GATE_COVERAGE_MIN),$(OVERLAY_GATE_COVERAGE_MIN),0.98)" --overlay_gate_consistency_min "$(if $(OVERLAY_GATE_CONSISTENCY_MIN),$(OVERLAY_GATE_CONSISTENCY_MIN),0.98)" --overlay_gate_epsilon "$(if $(OVERLAY_GATE_EPSILON),$(OVERLAY_GATE_EPSILON),0.000001)"

preference-next-variants:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required (round1 run id)" && exit 2)
	@test -n "$(CONTENTIOUS)" || (echo "CONTENTIOUS is required, e.g. artifacts/preference_contentious_<run_id>.jsonl" && exit 2)
	@test -n "$(MANIFEST)" || (echo "MANIFEST is required, e.g. artifacts/preference_round1_<run_id>/manifest.json" && exit 2)
	node scripts/preference_next_variants.mjs --run_id "$(RUN_ID)" --contentious "$(CONTENTIOUS)" --manifest "$(MANIFEST)" --seed "$(if $(PREFERENCE_SEED),$(PREFERENCE_SEED),preference_round2_seed_v1)" --max_candidates "$(if $(MAX_CANDIDATES),$(MAX_CANDIDATES),8)" --top_k "$(if $(TOP_K),$(TOP_K),4)" --target_total "$(if $(TARGET_TOTAL),$(TARGET_TOTAL),120)" --overlap_ratio "$(if $(OVERLAP_RATIO),$(OVERLAP_RATIO),0.25)" --overlap_min "$(if $(OVERLAP_MIN),$(OVERLAP_MIN),24)" --overlay_diff_min "$(if $(OVERLAY_DIFF_MIN),$(OVERLAY_DIFF_MIN),0.01)" --overlay_diff_priority_weight "$(if $(OVERLAY_DIFF_PRIORITY_WEIGHT),$(OVERLAY_DIFF_PRIORITY_WEIGHT),1)" --cache_dir "$(CACHE_DIR)" --internal_dir "$(if $(INTERNAL_DIR),$(INTERNAL_DIR),$(CURDIR))" --max_edge "$(if $(PREFERENCE_MAX_EDGE),$(PREFERENCE_MAX_EDGE),512)" --concurrency "$(EVAL_CONCURRENCY)" $(if $(NEXT_RUN_ID),--next_run_id "$(NEXT_RUN_ID)",) $(if $(OUT),--out_dir "$(OUT)",) $(if $(CROSSSET_JSONL),--crossset_jsonl "$(CROSSSET_JSONL)",) $(if $(GOLD_LABELS),--gold_labels "$(GOLD_LABELS)",) $(if $(PRED_JSONL),--pred_jsonl "$(PRED_JSONL)",) $(if $(MOCK_PIPELINE),--mock_pipeline "$(MOCK_PIPELINE)",)

release-gate-preference:
	@EVAL_JSONL_PATH="$(if $(EVAL_JSONL),$(EVAL_JSONL),$(if $(RUN_ID),reports/eval_preference_$(RUN_ID).jsonl,))"; \
	EVAL_MD_PATH="$(if $(EVAL_MD),$(EVAL_MD),$(if $(RUN_ID),reports/eval_preference_$(RUN_ID).md,))"; \
	MANIFEST_PATH="$(if $(MANIFEST),$(MANIFEST),$(if $(RUN_ID),artifacts/preference_round1_$(RUN_ID)/manifest.json,))"; \
	test -n "$$EVAL_JSONL_PATH" || (echo "EVAL_JSONL is required (or provide RUN_ID)" && exit 2); \
	test -n "$$EVAL_MD_PATH" || (echo "EVAL_MD is required (or provide RUN_ID)" && exit 2); \
	test -n "$$MANIFEST_PATH" || (echo "MANIFEST is required (or provide RUN_ID)" && exit 2); \
	node scripts/preference_release_gate.mjs --eval_jsonl "$$EVAL_JSONL_PATH" --eval_md "$$EVAL_MD_PATH" --manifest "$$MANIFEST_PATH" --run_id "$(RUN_ID)" --overall_delta_min "$(if $(OVERALL_DELTA_MIN),$(OVERALL_DELTA_MIN),0.05)" --forehead_delta_min "$(if $(FOREHEAD_DELTA_MIN),$(FOREHEAD_DELTA_MIN),0.10)" --cannot_tell_max "$(if $(CANNOT_TELL_MAX),$(CANNOT_TELL_MAX),0.25)" --iaa_kappa_min "$(if $(IAA_KAPPA_MIN),$(IAA_KAPPA_MIN),0.2)" --iaa_agreement_min "$(if $(IAA_AGREEMENT_MIN),$(IAA_AGREEMENT_MIN),0.6)" --limit_top "$(if $(LIMIT_TOP),$(LIMIT_TOP),20)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(EVAL_JSON),--eval_json "$(EVAL_JSON)",) $(if $(OUT),--out "$(OUT)",)

eval-circle-shrink-sweep:
	CACHE_DIR="$(CACHE_DIR)" TOKEN="$(EVAL_TOKEN)" CIRCLE_MODEL_CALIBRATION="$(CIRCLE_MODEL_CALIBRATION)" CIRCLE_MODEL_MIN_PIXELS="$(CIRCLE_MODEL_MIN_PIXELS)" node scripts/eval_circle_shrink_sweep.mjs --cache_dir "$(CACHE_DIR)" --report_dir "$(EVAL_REPORT_DIR)" --limit "$(if $(LIMIT),$(LIMIT),150)" --concurrency "$(EVAL_CONCURRENCY)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --market "$(MARKET)" --lang "$(LANG)" --grid_size "$(EVAL_GRID_SIZE)" --circle_model_path "$(if $(EVAL_CIRCLE_MODEL_PATH),$(EVAL_CIRCLE_MODEL_PATH),model_registry/circle_prior_latest.json)" --circle_model_min_pixels "$(CIRCLE_MODEL_MIN_PIXELS)" --sample_seed "$(if $(EVAL_SAMPLE_SEED),$(EVAL_SAMPLE_SEED),fasseg_shrink_sweep_seed_v1)" $(if $(EVAL_BASE_URL),--base_url "$(EVAL_BASE_URL)",) $(if $(EVAL_TOKEN),--token "$(EVAL_TOKEN)",) $(if $(filter true,$(EVAL_EMIT_DEBUG)),--emit_debug_overlays,) $(if $(filter false,$(CIRCLE_MODEL_CALIBRATION)),--disable_circle_model_calibration,)

bench-skinmask:
	node scripts/bench_skinmask.mjs --onnx "$(ONNX)" --cache_dir "$(CACHE_DIR)" --datasets "$(DATASETS)" --iterations "$(BENCH_ITERS)" --warmup "$(BENCH_WARMUP)" --timeout_ms "$(BENCH_TIMEOUT_MS)" --report_dir "$(EVAL_REPORT_DIR)" $(if $(BENCH_IMAGE),--input_image "$(BENCH_IMAGE)",) $(if $(filter true,$(BENCH_STRICT)),--strict,)

debug-skinmask-preproc:
	node scripts/debug_skinmask_preproc_consistency.mjs --cache_dir "$(CACHE_DIR)" --report_dir "$(EVAL_REPORT_DIR)" --onnx "$(if $(ONNX),$(ONNX),artifacts/skinmask_v2.onnx)" --limit "$(if $(LIMIT),$(LIMIT),20)" --grid_size "$(EVAL_GRID_SIZE)" --timeout_ms "$(EVAL_TIMEOUT_MS)" --backbone_name "$(SKINMASK_BACKBONE)" $(if $(EVAL_SAMPLE_SEED),--seed "$(EVAL_SAMPLE_SEED)",) $(if $(filter true,$(EVAL_SHUFFLE)),--shuffle,)

eval-datasets: datasets-prepare datasets-audit eval-circle

release-gate-circle:
	@test -n "$(LS_EXPORT)" || (echo "LS_EXPORT is required, e.g. artifacts/gold_round1_real_<run_id>/label_studio_export_round1_<run_id>.json" && exit 2)
	@test -n "$(REVIEW_JSONL)" || (echo "REVIEW_JSONL is required, e.g. reports/review_pack_mixed_<run_id>.jsonl" && exit 2)
	node scripts/release_gate_circle.mjs --run_id "$(RUN_ID)" --ls_export "$(LS_EXPORT)" --review_jsonl "$(REVIEW_JSONL)" --limit "$(if $(LIMIT),$(LIMIT),150)" --report_dir "$(EVAL_REPORT_DIR)"
