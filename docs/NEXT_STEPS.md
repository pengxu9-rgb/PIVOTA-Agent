# Next Steps (Prioritized)

## P0-1) Shadow rollout for `A mainline + B verifier`
- Goal metric:
  - `verify_calls_total` > 0 in production.
  - `agreement_histogram_count` grows daily with stable p50 agreement baseline.
- Impact scope:
  - Diagnosis runtime path and observability only (no user-visible behavior change).
- Modules:
  - `src/auroraBff/diagVerify.js`, `src/auroraBff/visionMetrics.js`, deployment env config.
- DoD:
  - `DIAG_GEMINI_VERIFY=true` in target env.
  - `/metrics` shows non-zero `verify_calls_total` and `agreement_histogram_count`.
  - `tmp/diag_verify/hard_cases.ndjson` (or configured path) receives records under disagreement.

## P0-2) Close diagnosis-first UX regressions in chat flow
- Goal metric:
  - `reco_products` requests without profile dimensions are gated at first response (no premature recommendations).
  - Language consistency errors reduced to near-zero for EN sessions.
- Impact scope:
  - Chat orchestration and state transitions.
- Modules:
  - `src/auroraBff/routes.js` state machine and recommendation gate logic.
- DoD:
  - Fresh UID call to recommendation chip returns `diagnosis_gate` only.
  - No unexpected locale switching after quick-check or budget chips.

## P1-3) Operationalize alerts/dashboard from existing metrics
- Goal metric:
  - Alert coverage for verifier failures, hard-case rate spikes, and photo-fetch failures.
- Impact scope:
  - Monitoring config and on-call readiness.
- Modules:
  - `DASHBOARD.md`, `ALERTS.md`, infrastructure monitoring config.
- DoD:
  - Dashboard panels live for `verify_calls_total`, `verify_fail_total`, `hard_case_rate`, `diag_ensemble_provider_schema_fail_total`.
  - Alerts configured with documented thresholds and tested with synthetic trigger.

## P1-4) Complete pseudo-label to calibration closed loop
- Goal metric:
  - Calibration evaluation shows non-regression or improvement in ECE/Brier per bucket.
- Impact scope:
  - Data pipeline and model registry updates.
- Modules:
  - `src/auroraBff/pseudoLabelFactory.js`, `src/auroraBff/diagCalibration.js`, `scripts/train_diag_calibration.js`, `scripts/eval_calibration.py`.
- DoD:
  - New calibration model artifact version in `model_registry/`.
  - Eval report generated and archived with grouped ECE (tone/region/lighting).

## P2-5) Gold-label workflow completion (active sampling + import/export)
- Goal metric:
  - Labeled hard-case throughput and bucket coverage increase.
- Impact scope:
  - Offline data ops tooling.
- Modules:
  - New scripts for task export/import and active sampling (currently absent).
- DoD:
  - `sample_for_labeling` and import normalization scripts available.
  - QA report generated per batch; no raw full-image export without explicit opt-in.
