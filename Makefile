.PHONY: bench stability test golden loadtest privacy-check release-gate gate-debug

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

bench:
	python3 scripts/bench_analyze.py --lang $(AURORA_LANG) --repeat $(REPEAT) --qc $(QC) --primary $(PRIMARY) --detector $(DETECTOR) $(if $(DEGRADED_MODE),--degraded-mode $(DEGRADED_MODE),) $(if $(OUT),--out $(OUT),) $(IMAGES)

stability:
	python3 scripts/perturb_stability.py --lang $(AURORA_LANG) --out $(if $(OUT),$(OUT),artifacts/stability_report.json) $(IMAGES)

test:
	python3 -m pytest -q tests/test_e2e_contract.py tests/test_perturb_stability.py tests/test_release_gate_discovery.py

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
