#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runTimestampKey, preprocessPhotoBuffer } from './internal_batch_helpers.mjs';

const require = createRequire(import.meta.url);
const {
  polygonNormToMask,
  decodeRleBinary,
  bboxNormToMask,
  orMaskInto,
  countOnes,
  intersectionCount,
  unionCount,
} = require('../src/auroraBff/evalAdapters/common/metrics');
const { runSkinDiagnosisV1, buildSkinAnalysisFromDiagnosisV1 } = require('../src/auroraBff/skinDiagnosisV1');
const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const { ensureModulesForPayload } = require('./eval_circle_local_fallback.cjs');

const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_GRID_SIZE = 256;
const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_CALIBRATION_OUT = path.join('artifacts', 'calibration_train_samples.ndjson');
const DEFAULT_LANG = 'EN';
const FACE_OVAL_POLYGON = Object.freeze([
  { x: 0.5, y: 0.06 },
  { x: 0.64, y: 0.1 },
  { x: 0.75, y: 0.2 },
  { x: 0.82, y: 0.35 },
  { x: 0.84, y: 0.5 },
  { x: 0.8, y: 0.66 },
  { x: 0.72, y: 0.8 },
  { x: 0.62, y: 0.9 },
  { x: 0.5, y: 0.95 },
  { x: 0.38, y: 0.9 },
  { x: 0.28, y: 0.8 },
  { x: 0.2, y: 0.66 },
  { x: 0.16, y: 0.5 },
  { x: 0.18, y: 0.35 },
  { x: 0.25, y: 0.2 },
  { x: 0.36, y: 0.1 },
]);

function parseBool(value, fallback = true) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function csvEscape(value) {
  const token = String(value == null ? '' : value);
  if (token.includes(',') || token.includes('"') || token.includes('\n')) {
    return `"${token.replace(/"/g, '""')}"`;
  }
  return token;
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function parseArgs(argv) {
  const out = {
    gold_labels: process.env.EVAL_GOLD_LABELS || path.join('artifacts', 'gold_labels.ndjson'),
    pred_jsonl: process.env.EVAL_GOLD_PRED_JSONL || process.env.EVAL_GOLD_PRED || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    grid_size: process.env.EVAL_GOLD_GRID || DEFAULT_GRID_SIZE,
    calibration_out: process.env.EVAL_GOLD_CAL_TRAIN_OUT || DEFAULT_CALIBRATION_OUT,
    max_edge: process.env.MAX_EDGE || DEFAULT_MAX_EDGE,
    rerun_local: process.env.EVAL_GOLD_RERUN_LOCAL || 'true',
    language: process.env.AURORA_LANG || 'en',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--gold_labels' && next) {
      out.gold_labels = String(next);
      i += 1;
      continue;
    }
    if (token === '--pred_jsonl' && next) {
      out.pred_jsonl = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = String(next);
      i += 1;
      continue;
    }
    if (token === '--calibration_out' && next) {
      out.calibration_out = String(next);
      i += 1;
      continue;
    }
    if (token === '--max_edge' && next) {
      out.max_edge = String(next);
      i += 1;
      continue;
    }
    if (token === '--rerun_local' && next) {
      out.rerun_local = String(next);
      i += 1;
      continue;
    }
    if (token === '--language' && next) {
      out.language = String(next);
      i += 1;
      continue;
    }
  }
  out.gold_labels = String(out.gold_labels || '').trim();
  out.pred_jsonl = String(out.pred_jsonl || '').trim();
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim();
  out.grid_size = Math.max(64, Math.min(512, Math.trunc(parseNumber(out.grid_size, DEFAULT_GRID_SIZE, 64, 512))));
  out.calibration_out = String(out.calibration_out || DEFAULT_CALIBRATION_OUT).trim();
  out.max_edge = Math.max(512, Math.min(4096, Math.trunc(parseNumber(out.max_edge, DEFAULT_MAX_EDGE, 512, 4096))));
  out.rerun_local = parseBool(out.rerun_local, true);
  out.language = String(out.language || 'en').trim().toLowerCase().startsWith('zh') ? 'CN' : DEFAULT_LANG;
  return out;
}

async function readNdjson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function safeRatio(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

function percentile(values, p = 0.5) {
  const valid = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const rank = Math.max(0, Math.min(valid.length - 1, Math.floor((valid.length - 1) * p)));
  return valid[rank];
}

function mean(values) {
  const valid = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((acc, value) => acc + value, 0) / valid.length;
}

function normalizePoints(rawPoints) {
  const points = [];
  for (const raw of Array.isArray(rawPoints) ? rawPoints : []) {
    if (!raw) continue;
    let x = null;
    let y = null;
    if (Array.isArray(raw) && raw.length >= 2) {
      x = Number(raw[0]);
      y = Number(raw[1]);
    } else if (typeof raw === 'object') {
      x = Number(raw.x);
      y = Number(raw.y);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x > 1 || y > 1) {
      x /= 100;
      y /= 100;
    }
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    points.push({ x, y });
  }
  return points.length >= 3 ? points : null;
}

function polygonMaskFromLabel(label, gridSize) {
  if (!label || typeof label !== 'object') return null;
  const points = normalizePoints(label.points_norm || label.points || label.value?.points);
  if (!points) return null;
  return polygonNormToMask({ points, closed: true }, gridSize, gridSize);
}

function maskBoundingBox(mask, gridSize) {
  if (!(mask instanceof Uint8Array) || mask.length !== gridSize * gridSize) return null;
  let minX = gridSize;
  let minY = gridSize;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const y = Math.trunc(i / gridSize);
    const x = i - (y * gridSize);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX || maxY < minY) return null;
  const denom = Math.max(1, gridSize);
  return {
    x0: minX / denom,
    y0: minY / denom,
    x1: (maxX + 1) / denom,
    y1: (maxY + 1) / denom,
  };
}

function decodeModuleMask(module, gridSize) {
  if (!module || typeof module !== 'object') return null;
  const grid = Math.max(8, Math.trunc(Number(module.mask_grid) || gridSize));
  if (typeof module.mask_rle_norm === 'string' && module.mask_rle_norm.trim()) {
    const decoded = decodeRleBinary(module.mask_rle_norm.trim(), grid * grid);
    if (grid === gridSize) return decoded;
    return resizeMaskNearest(decoded, grid, gridSize);
  }
  if (module.box && typeof module.box === 'object') {
    return bboxNormToMask(module.box, gridSize, gridSize);
  }
  return null;
}

function resizeMaskNearest(sourceMask, sourceGrid, targetGrid) {
  const out = new Uint8Array(targetGrid * targetGrid);
  if (!(sourceMask instanceof Uint8Array)) return out;
  for (let y = 0; y < targetGrid; y += 1) {
    const sy = Math.max(0, Math.min(sourceGrid - 1, Math.floor(((y + 0.5) * sourceGrid) / targetGrid)));
    for (let x = 0; x < targetGrid; x += 1) {
      const sx = Math.max(0, Math.min(sourceGrid - 1, Math.floor(((x + 0.5) * sourceGrid) / targetGrid)));
      out[(y * targetGrid) + x] = sourceMask[(sy * sourceGrid) + sx] ? 1 : 0;
    }
  }
  return out;
}

function metricIou(predMask, gtMask) {
  const den = unionCount(predMask, gtMask);
  if (den <= 0) return null;
  return intersectionCount(predMask, gtMask) / den;
}

function metricHairAsSkin(predSkin, goldHair) {
  const predPixels = countOnes(predSkin);
  if (predPixels <= 0) return null;
  return intersectionCount(predSkin, goldHair) / predPixels;
}

function metricBgAsSkin(predSkin, goldBg) {
  const predPixels = countOnes(predSkin);
  if (predPixels <= 0) return null;
  return intersectionCount(predSkin, goldBg) / predPixels;
}

function metricSkinMiss(predSkin, goldSkin) {
  const goldPixels = countOnes(goldSkin);
  if (goldPixels <= 0) return null;
  const overlap = intersectionCount(predSkin, goldSkin);
  return (goldPixels - overlap) / goldPixels;
}

function staticFaceOvalMask(gridSize) {
  return polygonNormToMask({ points: FACE_OVAL_POLYGON, closed: true }, gridSize, gridSize);
}

async function runLocalPrediction({ imagePath, gridSize, language, maxEdge }) {
  const rawBuffer = await fsp.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const preprocessed = await preprocessPhotoBuffer({
    inputBuffer: rawBuffer,
    extension: ext,
    sanitize: true,
    maxEdge,
  });
  const diagnosis = await runSkinDiagnosisV1({
    imageBuffer: preprocessed.buffer,
    language,
    profileSummary: null,
    recentLogsSummary: null,
  });
  if (!diagnosis || !diagnosis.ok) {
    throw new Error(`local_diagnosis_fail:${String(diagnosis && diagnosis.reason ? diagnosis.reason : 'unknown')}`);
  }
  const quality = diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null;
  const analysis = buildSkinAnalysisFromDiagnosisV1(diagnosis.diagnosis, {
    language,
    profileSummary: null,
  });
  const built = buildPhotoModulesCard({
    requestId: `eval_gold_${path.basename(imagePath)}`,
    analysis,
    usedPhotos: true,
    photoQuality: quality,
    photoNotice: null,
    diagnosisInternal: diagnosis.internal || null,
    profileSummary: null,
    language,
    ingredientRecEnabled: false,
    productRecEnabled: false,
    internalTestMode: true,
  });
  const payload = built && built.card && built.card.payload && typeof built.card.payload === 'object'
    ? built.card.payload
    : { modules: [] };
  const ensured = ensureModulesForPayload(payload, { gridSize: 64 });
  const safePayload = ensured && ensured.payload && typeof ensured.payload === 'object' ? ensured.payload : payload;
  const modules = Array.isArray(safePayload.modules) ? safePayload.modules : [];
  if (!modules.length) {
    throw new Error('local_modules_empty');
  }

  const predSkin = new Uint8Array(gridSize * gridSize);
  const modulePixels = {};
  for (const module of modules) {
    const moduleId = String(module && module.module_id ? module.module_id : '').trim();
    const moduleMask = decodeModuleMask(module, gridSize);
    if (!(moduleMask instanceof Uint8Array)) continue;
    modulePixels[moduleId || 'unknown'] = countOnes(moduleMask);
    orMaskInto(predSkin, moduleMask);
  }
  return {
    pred_skin_mask: predSkin,
    pred_oval_mask: staticFaceOvalMask(gridSize),
    modules_count: modules.length,
    module_pixels_map: modulePixels,
    quality_grade: String(safePayload.quality_grade || '').trim() || null,
  };
}

function extractPredFromRow(predRow, gridSize) {
  if (!predRow || typeof predRow !== 'object') return null;

  let predSkinMask = null;
  let predOvalMask = null;

  if (typeof predRow.pred_skin_mask_rle_norm === 'string' && predRow.pred_skin_mask_rle_norm.trim()) {
    predSkinMask = decodeRleBinary(predRow.pred_skin_mask_rle_norm.trim(), gridSize * gridSize);
  } else {
    const skinPoints = normalizePoints(predRow.pred_skin_points_norm || predRow.pred_skin_points);
    if (skinPoints) predSkinMask = polygonNormToMask({ points: skinPoints, closed: true }, gridSize, gridSize);
  }

  if (typeof predRow.pred_oval_mask_rle_norm === 'string' && predRow.pred_oval_mask_rle_norm.trim()) {
    predOvalMask = decodeRleBinary(predRow.pred_oval_mask_rle_norm.trim(), gridSize * gridSize);
  } else {
    const ovalPoints = normalizePoints(predRow.pred_oval_points_norm || predRow.pred_oval_points);
    if (ovalPoints) predOvalMask = polygonNormToMask({ points: ovalPoints, closed: true }, gridSize, gridSize);
  }

  if (!(predSkinMask instanceof Uint8Array) || predSkinMask.length !== gridSize * gridSize) {
    return null;
  }

  return {
    pred_skin_mask: predSkinMask,
    pred_oval_mask:
      predOvalMask instanceof Uint8Array && predOvalMask.length === gridSize * gridSize
        ? predOvalMask
        : staticFaceOvalMask(gridSize),
    modules_count: Number.isFinite(Number(predRow.modules_count)) ? Math.max(0, Math.trunc(Number(predRow.modules_count))) : null,
    module_pixels_map: predRow.module_pixels_map && typeof predRow.module_pixels_map === 'object' ? predRow.module_pixels_map : {},
    quality_grade: predRow.quality_grade || null,
  };
}

function buildCalibrationRow({ sample, metrics, predSkinMask, goldSkinMask, runId }) {
  const predScoreRaw = 1 - Number(metrics.bg_as_skin_rate == null ? 0.5 : metrics.bg_as_skin_rate);
  const predScore = Math.max(0, Math.min(1, Number.isFinite(predScoreRaw) ? predScoreRaw : 0.5));
  const goldIou = Number(metrics.skin_iou);
  if (!Number.isFinite(goldIou)) return null;
  const inferenceId = `gold_${runId}_${sample.sample_hash}`;
  const predBox = maskBoundingBox(predSkinMask, sample.grid_size);
  const goldBox = maskBoundingBox(goldSkinMask, sample.grid_size);
  if (!predBox || !goldBox) return null;

  const modelOutput = {
    inference_id: inferenceId,
    provider: 'gold_eval_local',
    quality_grade: sample.quality_grade || 'unknown',
    skin_tone_bucket: 'unknown',
    lighting_bucket: 'unknown',
    output_json: {
      concerns: [
        {
          type: 'skin',
          confidence: round3(predScore),
          severity: 2,
          regions: [
            {
              kind: 'bbox',
              bbox_norm: {
                x0: predBox.x0,
                y0: predBox.y0,
                x1: predBox.x1,
                y1: predBox.y1,
              },
            },
          ],
        },
      ],
    },
  };

  const goldLabel = {
    inference_id: inferenceId,
    qa_status: 'approved',
    concerns: [
      {
        type: 'skin',
        confidence: 1,
        severity: 2,
        regions: [
          {
            kind: 'bbox',
            bbox_norm: {
              x0: goldBox.x0,
              y0: goldBox.y0,
              x1: goldBox.x1,
              y1: goldBox.y1,
            },
          },
        ],
      },
    ],
  };

  return {
    sample_hash: sample.sample_hash,
    source: sample.source,
    pred_score: round3(predScore),
    gold_iou: round3(goldIou),
    features: {
      oval_iou: round3(metrics.oval_iou),
      bg_as_skin_rate: round3(metrics.bg_as_skin_rate),
      hair_as_skin_rate: round3(metrics.hair_as_skin_rate),
      skin_miss_rate: round3(metrics.skin_miss_rate),
      pred_skin_pixels: countOnes(predSkinMask),
      modules_count: Number.isFinite(Number(sample.modules_count)) ? Number(sample.modules_count) : null,
    },
    model_output: modelOutput,
    gold_label: goldLabel,
  };
}

function sourceStats(rows, source) {
  const filtered = rows.filter((row) => row.source === source);
  const metricKeys = ['oval_iou', 'skin_iou', 'hair_as_skin_rate', 'bg_as_skin_rate', 'skin_miss_rate'];
  const stats = { source, samples: filtered.length };
  for (const key of metricKeys) {
    const values = filtered.map((row) => row[key]).filter((value) => Number.isFinite(Number(value)));
    stats[`${key}_mean`] = round3(mean(values));
    stats[`${key}_p50`] = round3(percentile(values, 0.5));
    stats[`${key}_p90`] = round3(percentile(values, 0.9));
  }
  return stats;
}

function buildSummaryMarkdown({ runId, args, rows, sourceSummaries, worstRows, files }) {
  const lines = [];
  lines.push('# Gold Label Evaluation');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- gold_labels: ${toPosix(path.relative(process.cwd(), path.resolve(args.gold_labels)))}`);
  lines.push(`- pred_jsonl: ${args.pred_jsonl ? toPosix(path.relative(process.cwd(), path.resolve(args.pred_jsonl))) : '-'}`);
  lines.push(`- grid_size: ${args.grid_size}`);
  lines.push(`- rerun_local: ${args.rerun_local}`);
  lines.push(`- samples_total: ${rows.length}`);
  lines.push(`- samples_scored: ${rows.filter((row) => row.skin_iou != null).length}`);
  lines.push('');
  lines.push('## Source Metrics');
  lines.push('');
  lines.push('| source | samples | oval_iou mean/p50/p90 | skin_iou mean/p50/p90 | hair_as_skin mean/p50/p90 | bg_as_skin mean/p50/p90 | skin_miss mean/p50/p90 |');
  lines.push('|---|---:|---|---|---|---|---|');
  for (const summary of sourceSummaries) {
    const formatTriplet = (prefix) => `${summary[`${prefix}_mean`] ?? '-'} / ${summary[`${prefix}_p50`] ?? '-'} / ${summary[`${prefix}_p90`] ?? '-'}`;
    lines.push(
      `| ${summary.source} | ${summary.samples} | ${formatTriplet('oval_iou')} | ${formatTriplet('skin_iou')} | ${formatTriplet('hair_as_skin_rate')} | ${formatTriplet('bg_as_skin_rate')} | ${formatTriplet('skin_miss_rate')} |`,
    );
  }
  lines.push('');
  lines.push('## Top 20 Worst Samples');
  lines.push('');
  lines.push('| rank | sample_hash | source | skin_iou | bg_as_skin_rate | skin_miss_rate | hair_as_skin_rate | driver_score | pred_source | fail_reason |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---|---|');
  worstRows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.sample_hash} | ${row.source} | ${row.skin_iou ?? '-'} | ${row.bg_as_skin_rate ?? '-'} | ${row.skin_miss_rate ?? '-'} | ${row.hair_as_skin_rate ?? '-'} | ${row.driver_score ?? '-'} | ${row.pred_source} | ${row.fail_reason || '-'} |`,
    );
  });
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- jsonl: \`${files.jsonlRel}\``);
  lines.push(`- csv: \`${files.csvRel}\``);
  lines.push(`- calibration_train_samples: \`${files.calibrationRel}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.gold_labels) {
    process.stderr.write('eval_gold: missing --gold_labels\n');
    process.exit(2);
    return;
  }

  const goldLabelsPath = path.resolve(args.gold_labels);
  if (!fs.existsSync(goldLabelsPath)) {
    process.stderr.write(`eval_gold: gold labels not found: ${goldLabelsPath}\n`);
    process.exit(2);
    return;
  }

  const runId = runTimestampKey();
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const predMap = new Map();
  if (args.pred_jsonl) {
    const predPath = path.resolve(args.pred_jsonl);
    if (fs.existsSync(predPath)) {
      const rows = await readNdjson(predPath);
      for (const row of rows) {
        const sampleHash = String(row && row.sample_hash ? row.sample_hash : '').trim();
        if (!sampleHash) continue;
        predMap.set(sampleHash, row);
      }
    }
  }

  const goldRows = await readNdjson(goldLabelsPath);
  const outRows = [];
  const calibrationRows = [];

  for (const gold of goldRows) {
    const sampleHash = String(gold.sample_hash || '').trim();
    const source = String(gold.source || 'unknown').trim().toLowerCase() || 'unknown';
    if (!sampleHash) continue;

    const labels = gold.labels && typeof gold.labels === 'object' ? gold.labels : {};
    const goldOvalMask = polygonMaskFromLabel(labels.face_oval, args.grid_size);
    const goldSkinMask = polygonMaskFromLabel(labels.skin, args.grid_size);
    const goldHairMask = polygonMaskFromLabel(labels.hair, args.grid_size);
    const goldBgMask = polygonMaskFromLabel(labels.background, args.grid_size);

    const predRow = predMap.get(sampleHash) || null;
    let prediction = extractPredFromRow(predRow, args.grid_size);
    let predSource = prediction ? 'pred_jsonl' : null;
    let failReason = null;

    if (!prediction && args.rerun_local) {
      const imagePathRaw = String(gold.image_path || '').trim();
      const imagePath = imagePathRaw.startsWith('file://') ? imagePathRaw.slice('file://'.length) : imagePathRaw;
      if (imagePath && fs.existsSync(imagePath)) {
        try {
          prediction = await runLocalPrediction({
            imagePath,
            gridSize: args.grid_size,
            language: args.language,
            maxEdge: args.max_edge,
          });
          predSource = 'local_rerun';
        } catch (error) {
          failReason = String(error && error.message ? error.message : error).slice(0, 160);
        }
      } else if (!prediction) {
        failReason = 'missing_image_path';
      }
    }

    if (!prediction) {
      outRows.push({
        sample_hash: sampleHash,
        source,
        pred_source: predSource || 'none',
        fail_reason: failReason || 'prediction_unavailable',
        oval_iou: null,
        skin_iou: null,
        hair_as_skin_rate: null,
        bg_as_skin_rate: null,
        skin_miss_rate: null,
      });
      continue;
    }

    const predSkinMask = prediction.pred_skin_mask;
    const predOvalMask = prediction.pred_oval_mask || staticFaceOvalMask(args.grid_size);
    const predSkinPixels = countOnes(predSkinMask);
    const goldSkinPixels = goldSkinMask ? countOnes(goldSkinMask) : 0;

    const metrics = {
      oval_iou: goldOvalMask ? metricIou(predOvalMask, goldOvalMask) : null,
      skin_iou: goldSkinMask ? metricIou(predSkinMask, goldSkinMask) : null,
      hair_as_skin_rate: goldHairMask ? metricHairAsSkin(predSkinMask, goldHairMask) : null,
      bg_as_skin_rate: goldBgMask ? metricBgAsSkin(predSkinMask, goldBgMask) : null,
      skin_miss_rate: goldSkinMask ? metricSkinMiss(predSkinMask, goldSkinMask) : null,
    };

    const driverScore = (
      (Number.isFinite(Number(metrics.bg_as_skin_rate)) ? Number(metrics.bg_as_skin_rate) : 0)
      + (Number.isFinite(Number(metrics.skin_miss_rate)) ? Number(metrics.skin_miss_rate) : 0)
      + (Number.isFinite(Number(metrics.skin_iou)) ? (1 - Number(metrics.skin_iou)) : 1)
    );

    const row = {
      sample_hash: sampleHash,
      source,
      pred_source: predSource || 'unknown',
      fail_reason: null,
      modules_count: Number.isFinite(Number(prediction.modules_count)) ? Math.trunc(Number(prediction.modules_count)) : null,
      module_pixels_min: (() => {
        const values = Object.values(prediction.module_pixels_map || {}).map((value) => Number(value)).filter((value) => Number.isFinite(value));
        if (!values.length) return null;
        return Math.max(0, Math.trunc(Math.min(...values)));
      })(),
      pred_skin_pixels: predSkinPixels,
      gold_skin_pixels: goldSkinPixels,
      oval_iou: round3(metrics.oval_iou),
      skin_iou: round3(metrics.skin_iou),
      hair_as_skin_rate: round3(metrics.hair_as_skin_rate),
      bg_as_skin_rate: round3(metrics.bg_as_skin_rate),
      skin_miss_rate: round3(metrics.skin_miss_rate),
      driver_score: round3(driverScore),
    };

    outRows.push(row);

    if (goldSkinMask) {
      const calibrationRow = buildCalibrationRow({
        sample: {
          sample_hash: sampleHash,
          source,
          quality_grade: prediction.quality_grade,
          modules_count: row.modules_count,
          grid_size: args.grid_size,
        },
        metrics,
        predSkinMask,
        goldSkinMask,
        runId,
      });
      if (calibrationRow) calibrationRows.push(calibrationRow);
    }
  }

  const sourceList = Array.from(new Set(outRows.map((row) => row.source))).sort();
  const summaries = sourceList.map((source) => sourceStats(outRows, source));
  summaries.unshift(sourceStats(outRows, 'all').source === 'all' ? sourceStats(outRows, 'all') : { source: 'all', samples: outRows.length });

  // Replace synthetic all summary with actual over all rows.
  const allSummary = {
    source: 'all',
    samples: outRows.length,
  };
  for (const key of ['oval_iou', 'skin_iou', 'hair_as_skin_rate', 'bg_as_skin_rate', 'skin_miss_rate']) {
    const values = outRows.map((row) => row[key]).filter((value) => Number.isFinite(Number(value)));
    allSummary[`${key}_mean`] = round3(mean(values));
    allSummary[`${key}_p50`] = round3(percentile(values, 0.5));
    allSummary[`${key}_p90`] = round3(percentile(values, 0.9));
  }
  const sourceSummaries = [allSummary, ...sourceList.map((source) => sourceStats(outRows, source))];

  const worstRows = [...outRows]
    .filter((row) => Number.isFinite(Number(row.driver_score)))
    .sort((a, b) => Number(b.driver_score) - Number(a.driver_score))
    .slice(0, 20);

  const baseName = `eval_gold_${runId}`;
  const jsonlPath = path.join(reportDir, `${baseName}.jsonl`);
  const csvPath = path.join(reportDir, `${baseName}.csv`);
  const mdPath = path.join(reportDir, `${baseName}.md`);
  const calibrationPath = path.resolve(args.calibration_out);

  await fsp.mkdir(path.dirname(calibrationPath), { recursive: true });

  await fsp.writeFile(jsonlPath, outRows.map((row) => JSON.stringify(row)).join('\n') + (outRows.length ? '\n' : ''), 'utf8');

  const csvHeaders = [
    'source',
    'samples',
    'oval_iou_mean', 'oval_iou_p50', 'oval_iou_p90',
    'skin_iou_mean', 'skin_iou_p50', 'skin_iou_p90',
    'hair_as_skin_rate_mean', 'hair_as_skin_rate_p50', 'hair_as_skin_rate_p90',
    'bg_as_skin_rate_mean', 'bg_as_skin_rate_p50', 'bg_as_skin_rate_p90',
    'skin_miss_rate_mean', 'skin_miss_rate_p50', 'skin_miss_rate_p90',
  ];
  const csvRows = [
    csvHeaders.join(','),
    ...sourceSummaries.map((summary) => [
      summary.source,
      summary.samples,
      summary.oval_iou_mean ?? '', summary.oval_iou_p50 ?? '', summary.oval_iou_p90 ?? '',
      summary.skin_iou_mean ?? '', summary.skin_iou_p50 ?? '', summary.skin_iou_p90 ?? '',
      summary.hair_as_skin_rate_mean ?? '', summary.hair_as_skin_rate_p50 ?? '', summary.hair_as_skin_rate_p90 ?? '',
      summary.bg_as_skin_rate_mean ?? '', summary.bg_as_skin_rate_p50 ?? '', summary.bg_as_skin_rate_p90 ?? '',
      summary.skin_miss_rate_mean ?? '', summary.skin_miss_rate_p50 ?? '', summary.skin_miss_rate_p90 ?? '',
    ].map(csvEscape).join(',')),
  ];
  await fsp.writeFile(csvPath, `${csvRows.join('\n')}\n`, 'utf8');

  const calibrationPayload = calibrationRows.length
    ? `${calibrationRows.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';
  await fsp.writeFile(calibrationPath, calibrationPayload, 'utf8');

  const markdown = buildSummaryMarkdown({
    runId,
    args,
    rows: outRows,
    sourceSummaries,
    worstRows,
    files: {
      jsonlRel: toPosix(path.relative(process.cwd(), jsonlPath)),
      csvRel: toPosix(path.relative(process.cwd(), csvPath)),
      calibrationRel: toPosix(path.relative(process.cwd(), calibrationPath)),
    },
  });
  await fsp.writeFile(mdPath, markdown, 'utf8');

  const summary = {
    ok: true,
    run_id: runId,
    samples_total: outRows.length,
    samples_scored: outRows.filter((row) => row.skin_iou != null).length,
    report_md: toPosix(path.relative(process.cwd(), mdPath)),
    report_csv: toPosix(path.relative(process.cwd(), csvPath)),
    report_jsonl: toPosix(path.relative(process.cwd(), jsonlPath)),
    calibration_train_samples: toPosix(path.relative(process.cwd(), calibrationPath)),
    overall: allSummary,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`eval_gold_failed: ${error.message}\n`);
  process.exit(1);
});
