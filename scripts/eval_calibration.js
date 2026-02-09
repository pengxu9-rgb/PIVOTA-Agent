#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  buildTrainingRows,
  calibrateConfidence,
  computeEce,
  computeBrier,
  computeGroupedEce,
  loadCalibrationModelFromPath,
} = require('../src/auroraBff/diagCalibration');

function parseArgs(argv) {
  const out = {
    model: '',
    modelOutputs: '',
    goldLabels: '',
    iouThreshold: '',
    outJson: '',
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const modelPath = String(args.model || path.join(root, 'model_registry', 'diag_calibration_v1.json')).trim();
  const modelOutputsPath = String(args.modelOutputs || path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson')).trim();
  const goldLabelsPath = String(args.goldLabels || path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson')).trim();
  const iouThreshold = clamp(args.iouThreshold, 0.3, 0.05, 0.95);

  const loaded = loadCalibrationModelFromPath(modelPath);
  if (!loaded.model || loaded.error) {
    process.stderr.write(`failed to load model: ${modelPath} (error=${loaded.error || 'unknown'})\n`);
    process.exit(2);
    return;
  }
  const modelOutputs = readNdjson(modelOutputsPath);
  const goldLabels = readNdjson(goldLabelsPath);
  const rows = buildTrainingRows({
    modelOutputs,
    goldLabels,
    iouThreshold,
  });

  const calibratedRows = rows.map((row) => ({
    ...row,
    calibrated_confidence: calibrateConfidence(loaded.model, {
      provider: row.provider,
      qualityGrade: row.quality_grade,
      toneBucket: row.tone_bucket,
      lightingBucket: row.lighting_bucket,
      qualityFeatures: {
        exposure_score: row.exposure_score,
        reflection_score: row.reflection_score,
        filter_score: row.filter_score,
        makeup_detected: row.makeup_detected,
        filter_detected: row.filter_detected,
      },
      rawConfidence: row.raw_confidence,
    }),
  }));

  const payload = {
    model_path: path.resolve(modelPath),
    model_version: loaded.model.model_version,
    schema_version: loaded.model.schema_version,
    input_counts: {
      model_outputs: modelOutputs.length,
      gold_labels: goldLabels.length,
      eval_rows: rows.length,
    },
    metrics: {
      raw: {
        ece: computeEce(rows, (row) => row.raw_confidence, 10),
        brier: computeBrier(rows, (row) => row.raw_confidence),
      },
      calibrated: {
        ece: computeEce(calibratedRows, (row) => row.calibrated_confidence, 10),
        brier: computeBrier(calibratedRows, (row) => row.calibrated_confidence),
      },
    },
    grouped_ece: {
      tone_bucket: computeGroupedEce(calibratedRows, (row) => row.calibrated_confidence, ['tone_bucket']),
      lighting_bucket: computeGroupedEce(calibratedRows, (row) => row.calibrated_confidence, ['lighting_bucket']),
    },
  };
  payload.metrics.delta = {
    ece: Number((payload.metrics.raw.ece - payload.metrics.calibrated.ece).toFixed(3)),
    brier: Number((payload.metrics.raw.brier - payload.metrics.calibrated.brier).toFixed(3)),
  };

  if (String(args.outJson || '').trim()) {
    payload.output_path = writeJson(String(args.outJson).trim(), payload);
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main();
