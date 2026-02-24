#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATASET_PATH="${ROUTINE_EXPERT_DATASET_PATH:-${ROOT_DIR}/datasets/routine_expert_benchmark_120.json}"
AURORA_SCORES_PATH="${ROUTINE_EXPERT_AURORA_SCORES_PATH:-${ROOT_DIR}/reports/routine-expert/aurora_scores.json}"
GEMINI_SCORES_PATH="${ROUTINE_EXPERT_GEMINI_SCORES_PATH:-${ROOT_DIR}/reports/routine-expert/gemini_scores.json}"
OUT_DIR="${ROUTINE_EXPERT_REPORTS_DIR:-${ROOT_DIR}/reports}"

echo "[routine-benchmark-gate] dataset=${DATASET_PATH}"
echo "[routine-benchmark-gate] aurora_scores=${AURORA_SCORES_PATH}"
echo "[routine-benchmark-gate] gemini_scores=${GEMINI_SCORES_PATH}"
echo "[routine-benchmark-gate] out_dir=${OUT_DIR}"

if [[ ! -f "${DATASET_PATH}" ]]; then
  echo "[routine-benchmark-gate] missing dataset: ${DATASET_PATH}" >&2
  exit 1
fi
if [[ ! -f "${AURORA_SCORES_PATH}" ]]; then
  echo "[routine-benchmark-gate] missing aurora scores: ${AURORA_SCORES_PATH}" >&2
  exit 1
fi
if [[ ! -f "${GEMINI_SCORES_PATH}" ]]; then
  echo "[routine-benchmark-gate] missing gemini scores: ${GEMINI_SCORES_PATH}" >&2
  exit 1
fi

node "${ROOT_DIR}/scripts/eval_routine_expert_benchmark.cjs" \
  --dataset "${DATASET_PATH}" \
  --aurora "${AURORA_SCORES_PATH}" \
  --gemini "${GEMINI_SCORES_PATH}" \
  --out-dir "${OUT_DIR}"

DATE_TOKEN="$(date -u +%Y%m%d)"
REPORT_JSON="${OUT_DIR}/routine-expert-benchmark-${DATE_TOKEN}.json"
REPORT_MD="${OUT_DIR}/routine-expert-benchmark-${DATE_TOKEN}.md"

if [[ -f "${REPORT_MD}" ]]; then
  echo "[routine-benchmark-gate] report_md=${REPORT_MD}"
fi
if [[ -f "${REPORT_JSON}" ]]; then
  echo "[routine-benchmark-gate] report_json=${REPORT_JSON}"
fi
