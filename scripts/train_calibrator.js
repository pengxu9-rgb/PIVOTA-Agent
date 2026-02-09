#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  trainCalibrationModel,
  defaultModelPath,
} = require('../src/auroraBff/diagCalibration');

function parseArgs(argv) {
  const out = {
    modelOutputs: '',
    goldLabels: '',
    outDir: '',
    aliasPath: '',
    iouThreshold: '',
    minGroupSamples: '',
    writeAlias: 'true',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    index += 1;
  }
  return out;
}

function parseBool(value, fallback = true) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function clamp(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function readNdjson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return [];
  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch (_err) {
      // Ignore malformed rows.
    }
  }
  return out;
}

function writeJson(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function dateSlug() {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const modelOutputsPath = String(args.modelOutputs || path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson')).trim();
  const goldLabelsPath = String(args.goldLabels || path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson')).trim();
  const outDir = String(args.outDir || path.join(root, 'model_registry')).trim();
  const aliasPath = String(args.aliasPath || defaultModelPath(root)).trim();
  const iouThreshold = clamp(args.iouThreshold, 0.3, 0.05, 0.95);
  const minGroupSamples = Math.max(8, Math.trunc(clamp(args.minGroupSamples, 24, 8, 100000)));
  const writeAlias = parseBool(args.writeAlias, true);

  const modelOutputs = readNdjson(modelOutputsPath);
  const goldLabels = readNdjson(goldLabelsPath);
  if (!modelOutputs.length) {
    process.stderr.write(`no model outputs found: ${modelOutputsPath}\n`);
    process.exit(2);
    return;
  }
  if (!goldLabels.length) {
    process.stderr.write(`no gold labels found: ${goldLabelsPath}\n`);
    process.exit(2);
    return;
  }

  const trained = trainCalibrationModel({
    modelOutputs,
    goldLabels,
    options: {
      iou_threshold: iouThreshold,
      min_group_samples: minGroupSamples,
    },
  });
  const model = trained.model;
  model.model_version = `calibrator_v${dateSlug()}`;

  const versionPath = writeJson(path.join(outDir, `${model.model_version}.json`), model);
  let aliasWritten = null;
  if (writeAlias) aliasWritten = writeJson(aliasPath, model);

  const baseline = model.training?.baseline_metrics || {};
  const calibrated = model.training?.calibrated_metrics || {};

  const summary = {
    schema_version: model.schema_version,
    model_version: model.model_version,
    model_outputs_path: path.resolve(modelOutputsPath),
    gold_labels_path: path.resolve(goldLabelsPath),
    written_model_path: versionPath,
    alias_model_path: aliasWritten,
    samples_total: trained.rows.length,
    perf_rows_total: trained.perfRows.length,
    metrics: {
      baseline,
      calibrated,
      delta: {
        ece: Number((Number(baseline.ece || 0) - Number(calibrated.ece || 0)).toFixed(3)),
        brier: Number((Number(baseline.brier || 0) - Number(calibrated.brier || 0)).toFixed(3)),
      },
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
