.PHONY: bench stability test golden loadtest privacy-check release-gate gate-debug runtime-smoke entry-smoke status docs verify-daily pseudo-label-job monitoring-validate

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
VERIFY_STORE_DIR ?= tmp/diag_pseudo_label_factory
VERIFY_HARD_CASES ?= tmp/diag_verify/hard_cases.ndjson
VERIFY_REPORT_DATE ?=
PSEUDO_STORE_DIR ?= tmp/diag_pseudo_label_factory
PSEUDO_OUT_DIR ?= reports/pseudo_label_job
PSEUDO_JOB_DATE ?=

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
	node scripts/report_verify_daily.js --store-dir $(VERIFY_STORE_DIR) --hard-cases $(VERIFY_HARD_CASES) $(if $(VERIFY_REPORT_DATE),--date $(VERIFY_REPORT_DATE),)

pseudo-label-job:
	node scripts/run_pseudo_label_job.js --store-dir $(PSEUDO_STORE_DIR) --out-dir $(PSEUDO_OUT_DIR) $(if $(PSEUDO_JOB_DATE),--date $(PSEUDO_JOB_DATE),)

monitoring-validate:
	python3 scripts/monitoring_validate.py
