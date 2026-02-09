#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  trainCalibrationModel,
  defaultModelPath,
} = require('../src/auroraBff/diagCalibration');

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function readNdjson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return [];
  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch (_err) {
      // Ignore malformed rows.
    }
  }
  return rows;
}

function writeJson(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = process.cwd();
  const modelOutputsPath = String(args['model-outputs'] || path.join(baseDir, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson'));
  const goldLabelsPath = String(args['gold-labels'] || path.join(baseDir, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson'));
  const outDir = String(args['out-dir'] || path.join(baseDir, 'model_registry'));
  const modelAliasPath = String(args['alias-path'] || defaultModelPath(baseDir));
  const iouThreshold = Number(args['iou-threshold'] == null ? 0.3 : args['iou-threshold']);
  const minGroupSamples = Number(args['min-group-samples'] == null ? 24 : args['min-group-samples']);
  const writeAlias = String(args['write-alias'] == null ? 'true' : args['write-alias']).toLowerCase() !== 'false';

  const modelOutputs = readNdjson(modelOutputsPath);
  const goldLabels = readNdjson(goldLabelsPath);
  if (!modelOutputs.length) {
    console.error(`no model outputs found: ${modelOutputsPath}`);
    process.exitCode = 2;
    return;
  }
  if (!goldLabels.length) {
    console.error(`no gold labels found: ${goldLabelsPath}`);
    process.exitCode = 2;
    return;
  }

  const { model, rows, calibratedRows, perfRows } = trainCalibrationModel({
    modelOutputs,
    goldLabels,
    options: {
      iou_threshold: iouThreshold,
      min_group_samples: minGroupSamples,
    },
  });
  const versionPath = path.join(outDir, `diag_calibration_v1_${timestampSlug()}.json`);
  const writtenVersionPath = writeJson(versionPath, model);

  let aliasPath = null;
  if (writeAlias) aliasPath = writeJson(modelAliasPath, model);

  const baseline = model.training?.baseline_metrics || {};
  const calibrated = model.training?.calibrated_metrics || {};
  const out = {
    model_version: model.model_version,
    schema_version: model.schema_version,
    model_outputs_path: path.resolve(modelOutputsPath),
    gold_labels_path: path.resolve(goldLabelsPath),
    written_model_path: writtenVersionPath,
    alias_model_path: aliasPath,
    samples_total: rows.length,
    perf_rows_total: perfRows.length,
    metrics: {
      baseline,
      calibrated,
      delta: {
        ece: Number((Number(baseline.ece || 0) - Number(calibrated.ece || 0)).toFixed(3)),
        brier: Number((Number(baseline.brier || 0) - Number(calibrated.brier || 0)).toFixed(3)),
      },
    },
    buckets: {
      by_provider: Object.keys(model.provider_weights?.by_provider || {}).length,
      by_bucket: Object.keys(model.provider_weights?.by_bucket || {}).length,
    },
    diagnostics: {
      calibrated_rows_preview: calibratedRows.slice(0, 3),
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main();
