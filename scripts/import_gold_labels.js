#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GOLD_LABEL_SCHEMA_VERSION = 'aurora.diag.gold_label.v1';

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function clampSeverity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(4, numeric));
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function parseArgs(argv) {
  const out = {
    in: '',
    out: '',
    qaStatus: 'approved',
    annotatorId: '',
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

function readJson(filePath) {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

function readNdjson(filePath) {
  const resolved = path.resolve(filePath);
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

function appendNdjson(filePath, rows) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  fs.appendFileSync(resolved, payload, 'utf8');
  return resolved;
}

function normalizeConcernType(rawType) {
  const token = normalizeToken(rawType);
  if (!token) return 'other';
  const aliases = {
    redness: 'redness',
    irritation: 'redness',
    erythema: 'redness',
    acne: 'acne',
    breakout: 'acne',
    breakouts: 'acne',
    pimple: 'acne',
    shine: 'shine',
    oiliness: 'shine',
    sebum: 'shine',
    texture: 'texture',
    pores: 'texture',
    roughness: 'texture',
    tone: 'tone',
    dark_spots: 'tone',
    hyperpigmentation: 'tone',
    dryness: 'dryness',
    dehydration: 'dryness',
    barrier: 'barrier',
    sensitivity: 'barrier',
  };
  return aliases[token] || 'other';
}

function normalizeRectangleResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.type !== 'rectanglelabels') return null;
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  const labels = Array.isArray(value.rectanglelabels) ? value.rectanglelabels : [];
  const type = normalizeConcernType(labels[0] || 'other');
  const x = clamp01(Number(value.x) / 100);
  const y = clamp01(Number(value.y) / 100);
  const width = clamp01(Number(value.width) / 100);
  const height = clamp01(Number(value.height) / 100);
  if (width <= 0 || height <= 0) return null;
  return {
    type,
    confidence: 1,
    severity: 2,
    evidence_text: '',
    quality_sensitivity: 'medium',
    source_model: 'human_label',
    regions: [
      {
        kind: 'bbox',
        bbox_norm: {
          x0: round3(x),
          y0: round3(y),
          x1: round3(Math.max(x, Math.min(1, x + width))),
          y1: round3(Math.max(y, Math.min(1, y + height))),
        },
      },
    ],
    provenance: {
      source_ids: [],
    },
  };
}

function normalizeConcernsFromLabelStudioTask(task) {
  const annotations = Array.isArray(task?.annotations) ? task.annotations : [];
  const concernMap = new Map();

  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== 'object') continue;
    const annotationResult = Array.isArray(annotation.result) ? annotation.result : [];
    for (const entry of annotationResult) {
      const concern = normalizeRectangleResult(entry);
      if (!concern) continue;
      const key = `${concern.type}:${JSON.stringify(concern.regions[0].bbox_norm)}`;
      if (!concernMap.has(key)) concernMap.set(key, concern);
    }
  }

  return Array.from(concernMap.values());
}

function inferMeta(task) {
  const data = task?.data && typeof task.data === 'object' ? task.data : {};
  return {
    inference_id: String(data.inference_id || task.inference_id || '').trim(),
    quality_grade: normalizeToken(data.quality_grade || task.quality_grade || 'unknown'),
    skin_tone_bucket: normalizeToken(data.tone_bucket || data.skin_tone_bucket || task.skin_tone_bucket || 'unknown'),
    lighting_bucket: normalizeToken(data.lighting_bucket || task.lighting_bucket || 'unknown'),
    region_bucket: normalizeToken(data.region_bucket || task.region_bucket || 'unknown'),
  };
}

function normalizeGoldRecord(task, { qaStatus, annotatorId }) {
  const concerns = normalizeConcernsFromLabelStudioTask(task);
  const meta = inferMeta(task);
  const inferenceId = String(meta.inference_id || '').trim();
  if (!inferenceId) return null;

  return {
    schema_version: GOLD_LABEL_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    inference_id: inferenceId,
    qa_status: String(qaStatus || 'approved').trim() || 'approved',
    annotator_id: String(annotatorId || task?.annotator_id || '').trim() || 'unknown_annotator',
    quality_grade: meta.quality_grade || 'unknown',
    skin_tone_bucket: meta.skin_tone_bucket || 'unknown',
    lighting_bucket: meta.lighting_bucket || 'unknown',
    region_bucket: meta.region_bucket || 'unknown',
    concerns,
    metadata: {
      source_format: 'label_studio',
      annotation_count: Array.isArray(task?.annotations) ? task.annotations.length : 0,
    },
  };
}

function parseInputFile(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return readNdjson(resolved);
  const parsed = readJson(resolved);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
  return [];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = String(args.in || '').trim();
  if (!inputPath) {
    process.stderr.write('missing required --in <label_studio_export.jsonl|json>\n');
    process.exit(2);
    return;
  }

  const outPath = String(args.out || path.join(process.cwd(), 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson')).trim();
  const qaStatus = String(args.qaStatus || 'approved').trim() || 'approved';
  const annotatorId = String(args.annotatorId || '').trim();
  const tasks = parseInputFile(inputPath);
  const normalized = [];
  let skippedNoInference = 0;

  for (const task of tasks) {
    const row = normalizeGoldRecord(task, { qaStatus, annotatorId });
    if (!row) {
      skippedNoInference += 1;
      continue;
    }
    normalized.push(row);
  }

  const writtenPath = appendNdjson(outPath, normalized);
  const summary = {
    schema_version: GOLD_LABEL_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    input_path: path.resolve(inputPath),
    output_path: writtenPath,
    total_tasks: tasks.length,
    imported_rows: normalized.length,
    skipped_no_inference: skippedNoInference,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
