.PHONY: bench stability test golden loadtest privacy-check release-gate gate-debug runtime-smoke entry-smoke status docs verify-daily pseudo-label-job monitoring-validate gold-label-sample gold-label-import train-calibrator eval-calibration

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
GOLD_IMPORT_IN ?=
GOLD_IMPORT_OUT ?= tmp/diag_pseudo_label_factory/gold_labels.ndjson
GOLD_IMPORT_QA_STATUS ?= approved
GOLD_IMPORT_ANNOTATOR ?=
CAL_MODEL_OUTPUTS ?= tmp/diag_pseudo_label_factory/model_outputs.ndjson
CAL_GOLD_LABELS ?= tmp/diag_pseudo_label_factory/gold_labels.ndjson
CAL_OUT_DIR ?= model_registry
CAL_ALIAS_PATH ?= model_registry/diag_calibration_v1.json
CAL_IOU ?= 0.3
CAL_MIN_GROUP_SAMPLES ?= 24
CAL_EVAL_MODEL ?=
CAL_EVAL_OUT ?= reports/calibration_eval.json

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

pseudo-label-job:
	node scripts/run_pseudo_label_job.js --store-dir $(PSEUDO_STORE_DIR) --out-dir $(PSEUDO_OUT_DIR) $(if $(PSEUDO_JOB_DATE),--date $(PSEUDO_JOB_DATE),)

monitoring-validate:
	python3 scripts/monitoring_validate.py

gold-label-sample:
	node scripts/sample_gold_label_tasks.js $(if $(GOLD_TASKS_IN),--hardCases $(GOLD_TASKS_IN),) --out $(GOLD_TASKS_OUT) --total $(GOLD_TOTAL) --hardRatio $(GOLD_HARD_RATIO) --allowRoi $(GOLD_ALLOW_ROI) $(if $(GOLD_TASKS_DATE),--date $(GOLD_TASKS_DATE),) $(if $(GOLD_QUOTA_FILE),--quotaFile $(GOLD_QUOTA_FILE),) $(if $(GOLD_SEED),--seed $(GOLD_SEED),)

gold-label-import:
	node scripts/import_gold_labels.js --in $(GOLD_IMPORT_IN) --out $(GOLD_IMPORT_OUT) --qaStatus $(GOLD_IMPORT_QA_STATUS) $(if $(GOLD_IMPORT_ANNOTATOR),--annotatorId $(GOLD_IMPORT_ANNOTATOR),)

train-calibrator:
	node scripts/train_calibrator.js --modelOutputs $(CAL_MODEL_OUTPUTS) --goldLabels $(CAL_GOLD_LABELS) --outDir $(CAL_OUT_DIR) --aliasPath $(CAL_ALIAS_PATH) --iouThreshold $(CAL_IOU) --minGroupSamples $(CAL_MIN_GROUP_SAMPLES)

eval-calibration:
	node scripts/eval_calibration.js --model $(if $(CAL_EVAL_MODEL),$(CAL_EVAL_MODEL),$(CAL_ALIAS_PATH)) --modelOutputs $(CAL_MODEL_OUTPUTS) --goldLabels $(CAL_GOLD_LABELS) --iouThreshold $(CAL_IOU) --outJson $(CAL_EVAL_OUT)
