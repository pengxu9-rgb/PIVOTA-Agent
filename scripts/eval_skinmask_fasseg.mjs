#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { getAdapter } = require('../src/auroraBff/evalAdapters/index');
const {
  normalizeCacheDirs,
  toPosix,
  writeJsonl,
  writeText,
} = require('../src/auroraBff/evalAdapters/common/datasetUtils');
const {
  readMaskLabelImage,
  maskFromAllowedLabelValues,
  cropMaskToNorm,
} = require('../src/auroraBff/evalAdapters/common/maskUtils');
const { faceCropFromSkinBBoxNorm } = require('../src/auroraBff/evalAdapters/common/gtDerivation');
const {
  createMask,
  countOnes,
  intersectionCount,
  iouScore,
  decodeRleBinary,
} = require('../src/auroraBff/evalAdapters/common/metrics');
const { inferSkinMaskOnFaceCrop, loadSkinmaskSchema } = require('../src/auroraBff/skinmaskOnnx');

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_ONNX = path.join('artifacts', 'skinmask_v1.onnx');
const DEFAULT_LIMIT = 150;
const DEFAULT_GRID_SIZE = Math.max(
  32,
  Math.min(256, Math.trunc(Number(process.env.DIAG_SKINMASK_GRID || 64) || 64)),
);
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_SEED = 'skinmask_fasseg_eval';

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function nowRunKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}${ss}`;
}

function hashId(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 20);
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function mean(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  let total = 0;
  let count = 0;
  for (const value of values) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    total += n;
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] || 0;
}

function maskBoundingNorm(mask, width, height) {
  const w = Math.max(1, Math.trunc(Number(width) || 1));
  const h = Math.max(1, Math.trunc(Number(height) || 1));
  if (!(mask instanceof Uint8Array) || mask.length !== w * h) {
    return { x0: 0, y0: 0, x1: 1, y1: 1 };
  }
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) {
    return { x0: 0, y0: 0, x1: 1, y1: 1 };
  }
  return {
    x0: minX / w,
    y0: minY / h,
    x1: (maxX + 1) / w,
    y1: (maxY + 1) / h,
  };
}

function buildBgMask(skinMask, hairMask) {
  const len = Math.max(skinMask ? skinMask.length : 0, hairMask ? hairMask.length : 0);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    const isSkin = skinMask && skinMask[i] ? 1 : 0;
    const isHair = hairMask && hairMask[i] ? 1 : 0;
    out[i] = isSkin || isHair ? 0 : 1;
  }
  return out;
}

function safeRatio(num, den) {
  return den > 0 ? num / den : 0;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('skinmask_infer_timeout');
      error.code = 'TIMEOUT';
      reject(error);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function makeRelativeLabel(repoRoot, targetPath) {
  const rel = path.relative(repoRoot, targetPath);
  if (!rel || rel.startsWith('..')) return toPosix(targetPath);
  return toPosix(rel);
}

function parseArgs(argv) {
  const out = {
    cache_dir: String(process.env.CACHE_DIR || DEFAULT_CACHE_DIR),
    report_dir: String(process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR),
    onnx: String(process.env.ONNX || process.env.DIAG_SKINMASK_MODEL_PATH || DEFAULT_ONNX),
    limit: parseNumber(process.env.LIMIT, DEFAULT_LIMIT, 1, 100000),
    shuffle: parseBoolean(process.env.EVAL_SHUFFLE, false),
    seed: String(process.env.EVAL_SAMPLE_SEED || DEFAULT_SEED),
    grid_size: parseNumber(process.env.DIAG_SKINMASK_GRID, DEFAULT_GRID_SIZE, 32, 256),
    timeout_ms: parseNumber(process.env.EVAL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 200, 120000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cache_dir' && next) {
      out.cache_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--onnx' && next) {
      out.onnx = String(next);
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 1, 100000);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = parseNumber(next, out.grid_size, 32, 256);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeout_ms = parseNumber(next, out.timeout_ms, 200, 120000);
      i += 1;
      continue;
    }
    if (token === '--seed' && next) {
      out.seed = String(next);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
    if (token === '--no-shuffle') {
      out.shuffle = false;
      continue;
    }
  }

  out.limit = Math.max(1, Math.trunc(out.limit));
  out.grid_size = Math.max(32, Math.trunc(out.grid_size));
  out.timeout_ms = Math.max(200, Math.trunc(out.timeout_ms));
  out.seed = String(out.seed || DEFAULT_SEED);
  return out;
}

function renderFailReasonTable(rows) {
  const counter = new Map();
  for (const row of rows) {
    if (row && !row.ok) {
      const reason = String(row.fail_reason || 'UNKNOWN');
      counter.set(reason, (counter.get(reason) || 0) + 1);
    }
  }
  const entries = Array.from(counter.entries()).sort((a, b) => b[1] - a[1]);
  return entries;
}

function buildSummaryCsv({ metrics, samplesTotal, samplesOk, samplesFailed, failReasonRows }) {
  const lines = [];
  lines.push('metric,mean,p50,p90');
  lines.push(`skin_iou,${round3(metrics.skin_iou_mean)},${round3(metrics.skin_iou_p50)},${round3(metrics.skin_iou_p90)}`);
  lines.push(`hair_as_skin_rate,${round3(metrics.hair_as_skin_rate_mean)},${round3(metrics.hair_as_skin_rate_p50)},${round3(metrics.hair_as_skin_rate_p90)}`);
  lines.push(`bg_as_skin_rate,${round3(metrics.bg_as_skin_rate_mean)},${round3(metrics.bg_as_skin_rate_p50)},${round3(metrics.bg_as_skin_rate_p90)}`);
  lines.push(`skin_miss_rate,${round3(metrics.skin_miss_rate_mean)},${round3(metrics.skin_miss_rate_p50)},${round3(metrics.skin_miss_rate_p90)}`);
  lines.push(`pred_skin_ratio,${round3(metrics.pred_skin_ratio_mean)},${round3(metrics.pred_skin_ratio_p50)},${round3(metrics.pred_skin_ratio_p90)}`);
  lines.push('');
  lines.push('summary,value');
  lines.push(`samples_total,${samplesTotal}`);
  lines.push(`samples_ok,${samplesOk}`);
  lines.push(`samples_failed,${samplesFailed}`);
  for (const [reason, count] of failReasonRows) {
    lines.push(`${csvEscape(`fail_reason_${reason}`)},${count}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildSummaryMd({
  runId,
  generatedAt,
  args,
  onnxLabel,
  samplesTotal,
  samplesOk,
  samplesFailed,
  metrics,
  failReasonRows,
  schemaSummary,
  sanity,
  artifactLabels,
}) {
  const lines = [];
  lines.push('# FASSEG Skinmask Evaluation');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${generatedAt}`);
  lines.push('- dataset: fasseg');
  lines.push(`- onnx: ${onnxLabel}`);
  lines.push(`- limit: ${args.limit}`);
  lines.push(`- grid_size: ${args.grid_size}`);
  lines.push(`- timeout_ms: ${args.timeout_ms}`);
  lines.push(`- sample_seed: ${args.seed}`);
  lines.push(`- shuffle: ${args.shuffle ? 'true' : 'false'}`);
  lines.push(`- samples_total: ${samplesTotal}`);
  lines.push(`- samples_ok: ${samplesOk}`);
  lines.push(`- samples_failed: ${samplesFailed}`);
  lines.push('');
  lines.push('## Schema');
  lines.push('');
  lines.push(`- schema_path: ${schemaSummary.schema_path || 'n/a'}`);
  lines.push(`- schema_loaded: ${schemaSummary.schema_loaded ? 'true' : 'false'}`);
  lines.push(`- schema_version: ${schemaSummary.schema_version || 'n/a'}`);
  lines.push(`- input_color_space: ${schemaSummary.input_color_space || 'n/a'}`);
  lines.push(`- input_range: ${schemaSummary.input_range || 'n/a'}`);
  lines.push(`- input_size: ${Array.isArray(schemaSummary.input_size) ? schemaSummary.input_size.join('x') : 'n/a'}`);
  lines.push(`- output_type: ${schemaSummary.output_type || 'n/a'}`);
  lines.push(`- output_classes: ${Array.isArray(schemaSummary.output_classes) ? schemaSummary.output_classes.join(',') : 'n/a'}`);
  lines.push(`- skin_class: ${schemaSummary.skin_class || 'n/a'}`);
  lines.push(`- skin_class_id: ${Number.isFinite(Number(schemaSummary.skin_class_id)) ? Number(schemaSummary.skin_class_id) : 'n/a'}`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| metric | mean | p50 | p90 |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| skin_iou | ${round3(metrics.skin_iou_mean)} | ${round3(metrics.skin_iou_p50)} | ${round3(metrics.skin_iou_p90)} |`);
  lines.push(`| hair_as_skin_rate | ${round3(metrics.hair_as_skin_rate_mean)} | ${round3(metrics.hair_as_skin_rate_p50)} | ${round3(metrics.hair_as_skin_rate_p90)} |`);
  lines.push(`| bg_as_skin_rate | ${round3(metrics.bg_as_skin_rate_mean)} | ${round3(metrics.bg_as_skin_rate_p50)} | ${round3(metrics.bg_as_skin_rate_p90)} |`);
  lines.push(`| skin_miss_rate | ${round3(metrics.skin_miss_rate_mean)} | ${round3(metrics.skin_miss_rate_p50)} | ${round3(metrics.skin_miss_rate_p90)} |`);
  lines.push(`| pred_skin_ratio | ${round3(metrics.pred_skin_ratio_mean)} | ${round3(metrics.pred_skin_ratio_p50)} | ${round3(metrics.pred_skin_ratio_p90)} |`);
  lines.push('');
  if (sanity && sanity.triggered) {
    lines.push('## Warnings');
    lines.push('');
    lines.push(
      `- WARNING: ${sanity.code} (pred_skin_ratio_mean=${round3(sanity.pred_skin_ratio_mean)}, skin_iou_mean=${round3(sanity.skin_iou_mean)}). likely class mapping wrong.`,
    );
    lines.push('');
  }
  lines.push('');
  lines.push('## Fail Reasons');
  lines.push('');
  lines.push('| fail_reason | count | pct_of_total |');
  lines.push('|---|---:|---:|');
  if (!failReasonRows.length) {
    lines.push('| - | 0 | 0 |');
  } else {
    for (const [reason, count] of failReasonRows) {
      lines.push(`| ${reason} | ${count} | ${round3(safeRatio(count, samplesTotal))} |`);
    }
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- md: \`${artifactLabels.md}\``);
  lines.push(`- csv: \`${artifactLabels.csv}\``);
  lines.push(`- jsonl: \`${artifactLabels.jsonl}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(process.cwd());
  const reportDir = path.resolve(repoRoot, args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const onnxPath = path.resolve(repoRoot, args.onnx);
  if (!fs.existsSync(onnxPath)) {
    throw new Error(`onnx_not_found:${args.onnx}`);
  }
  const onnxStat = await fsp.stat(onnxPath);
  if (!onnxStat.isFile()) {
    throw new Error(`onnx_not_file:${args.onnx}`);
  }
  const schemaResolved = loadSkinmaskSchema(onnxPath);
  const schemaSummary = {
    schema_path:
      schemaResolved && schemaResolved.schema_path
        ? makeRelativeLabel(repoRoot, schemaResolved.schema_path)
        : null,
    schema_loaded: Boolean(schemaResolved && schemaResolved.schema_loaded),
    schema_version:
      schemaResolved && schemaResolved.schema_version ? String(schemaResolved.schema_version) : null,
    input_color_space:
      schemaResolved && schemaResolved.input && schemaResolved.input.color_space
        ? String(schemaResolved.input.color_space)
        : null,
    input_range:
      schemaResolved && schemaResolved.input && schemaResolved.input.range
        ? String(schemaResolved.input.range)
        : null,
    input_size:
      schemaResolved && schemaResolved.input && Array.isArray(schemaResolved.input.size)
        ? schemaResolved.input.size.map((value) => Number(value))
        : null,
    output_type:
      schemaResolved && schemaResolved.output && schemaResolved.output.type
        ? String(schemaResolved.output.type)
        : null,
    output_classes:
      schemaResolved && schemaResolved.output && Array.isArray(schemaResolved.output.classes)
        ? schemaResolved.output.classes.map((token) => String(token))
        : [],
    skin_class:
      schemaResolved && schemaResolved.output && schemaResolved.output.skin_class
        ? String(schemaResolved.output.skin_class)
        : null,
    skin_class_id:
      schemaResolved && schemaResolved.output && Number.isFinite(Number(schemaResolved.output.skin_class_id))
        ? Number(schemaResolved.output.skin_class_id)
        : null,
  };

  const cache = normalizeCacheDirs(args.cache_dir);
  const adapter = getAdapter('fasseg');
  if (!adapter) {
    throw new Error('fasseg_adapter_missing');
  }
  const loaded = await adapter.loadSamples({
    repoRoot,
    cacheExternalDir: cache.cacheExternalDir,
    cacheRootDir: cache.cacheRootDir,
    limit: args.limit,
    shuffle: args.shuffle,
    seed: args.seed,
  });
  const samples = Array.isArray(loaded && loaded.samples) ? loaded.samples : [];
  if (!samples.length) {
    throw new Error('fasseg_samples_empty');
  }

  const runId = nowRunKey();
  const rows = [];

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const evalSample = adapter.toEvalSample(sample);
    const sampleHash = hashId(`fasseg:${evalSample.sample_id}:${index}`);
    const row = {
      dataset: 'fasseg',
      sample_hash: sampleHash,
      ok: false,
      fail_reason: null,
      note: null,
      skin_iou: 0,
      hair_as_skin_rate: 0,
      bg_as_skin_rate: 0,
      skin_miss_rate: 0,
      pred_skin_ratio: 0,
      pred_skin_pixels: 0,
      gt_skin_pixels: 0,
      gt_hair_pixels: 0,
      gt_bg_pixels: 0,
      skinmask_pixels_est: 0,
      skinmask_reason: null,
    };

    let imageBuffer = null;
    try {
      imageBuffer = await fsp.readFile(evalSample.image_bytes_path);
    } catch (error) {
      row.fail_reason = 'IMAGE_READ_FAIL';
      row.note = String(error && error.message ? error.message : error);
      rows.push(row);
      continue;
    }

    let gtSkin = null;
    try {
      gtSkin = await adapter.buildSkinMask(evalSample);
    } catch (error) {
      row.fail_reason = 'GT_SKIN_BUILD_FAIL';
      row.note = String(error && error.message ? error.message : error);
      rows.push(row);
      continue;
    }
    if (!gtSkin || !gtSkin.ok || !(gtSkin.mask instanceof Uint8Array)) {
      row.fail_reason = 'GT_SKIN_MISSING';
      row.note = gtSkin && gtSkin.reason ? String(gtSkin.reason) : 'gt_skin_missing';
      rows.push(row);
      continue;
    }

    const gtSkinPixelsFull = countOnes(gtSkin.mask);
    if (!gtSkinPixelsFull) {
      row.fail_reason = 'GT_SKIN_EMPTY';
      row.note = 'gt_skin_pixels_zero';
      rows.push(row);
      continue;
    }

    let labelImage = null;
    try {
      const maskPath = String(
        evalSample &&
          Array.isArray(evalSample.gt_masks) &&
          evalSample.gt_masks[0] &&
          typeof evalSample.gt_masks[0].mask_path === 'string'
          ? evalSample.gt_masks[0].mask_path
          : '',
      );
      labelImage = await readMaskLabelImage(maskPath);
    } catch (error) {
      row.fail_reason = 'GT_MASK_READ_FAIL';
      row.note = String(error && error.message ? error.message : error);
      rows.push(row);
      continue;
    }

    const hairMaskFull = maskFromAllowedLabelValues(labelImage, [2]);
    const bgMaskFull = buildBgMask(gtSkin.mask, hairMaskFull);
    const gtSkinBboxNorm = maskBoundingNorm(gtSkin.mask, gtSkin.width, gtSkin.height);
    const faceCropBox = faceCropFromSkinBBoxNorm({
      skinBboxNorm: gtSkinBboxNorm,
      imageWidth: gtSkin.width,
      imageHeight: gtSkin.height,
      marginScale: 1.2,
    });
    const diagnosisInternal = {
      skin_bbox_norm: gtSkinBboxNorm,
      face_crop: {
        coord_space: 'orig_px_v1',
        bbox_px: faceCropBox,
        orig_size_px: { w: gtSkin.width, h: gtSkin.height },
        render_size_px_hint: {
          w: Math.max(1, Math.min(gtSkin.width, 512)),
          h: Math.max(1, Math.min(gtSkin.height, 512)),
        },
      },
      orig_size_px: { w: gtSkin.width, h: gtSkin.height },
    };

    let inferred = null;
    try {
      inferred = await withTimeout(
        inferSkinMaskOnFaceCrop({
          imageBuffer,
          diagnosisInternal,
          modelPath: onnxPath,
          gridSize: args.grid_size,
          allowPriorFallback: false,
        }),
        args.timeout_ms,
      );
    } catch (error) {
      row.fail_reason = error && error.code === 'TIMEOUT' ? 'TIMEOUT' : 'INFER_EXCEPTION';
      row.note = String(error && error.message ? error.message : error);
      rows.push(row);
      continue;
    }

    row.skinmask_reason = inferred && inferred.reason ? String(inferred.reason) : null;
    row.skinmask_pixels_est = Number.isFinite(Number(inferred && inferred.positive_pixels))
      ? Math.max(0, Math.trunc(Number(inferred.positive_pixels)))
      : 0;
    if (!inferred || !inferred.ok || !inferred.mask_rle_norm) {
      row.fail_reason = inferred && inferred.reason ? `INFER_${String(inferred.reason).toUpperCase()}` : 'INFER_FAIL';
      row.note = inferred && inferred.detail ? String(inferred.detail) : null;
      rows.push(row);
      continue;
    }

    const predMaskNorm = decodeRleBinary(inferred.mask_rle_norm, args.grid_size * args.grid_size);
    const gtSkinNorm = cropMaskToNorm(gtSkin.mask, gtSkin.width, gtSkin.height, faceCropBox, args.grid_size, args.grid_size);
    const gtHairNorm = cropMaskToNorm(hairMaskFull, gtSkin.width, gtSkin.height, faceCropBox, args.grid_size, args.grid_size);
    const gtBgNorm = cropMaskToNorm(bgMaskFull, gtSkin.width, gtSkin.height, faceCropBox, args.grid_size, args.grid_size);

    const predPixels = countOnes(predMaskNorm);
    const gtSkinPixels = countOnes(gtSkinNorm);
    const gtHairPixels = countOnes(gtHairNorm);
    const gtBgPixels = countOnes(gtBgNorm);
    const hitSkin = intersectionCount(predMaskNorm, gtSkinNorm);
    const hitHair = intersectionCount(predMaskNorm, gtHairNorm);
    const hitBg = intersectionCount(predMaskNorm, gtBgNorm);
    const missSkin = Math.max(0, gtSkinPixels - hitSkin);

    row.ok = true;
    row.fail_reason = null;
    row.pred_skin_pixels = predPixels;
    row.pred_skin_ratio = round3(safeRatio(predPixels, args.grid_size * args.grid_size));
    row.gt_skin_pixels = gtSkinPixels;
    row.gt_hair_pixels = gtHairPixels;
    row.gt_bg_pixels = gtBgPixels;
    row.skin_iou = round3(iouScore(predMaskNorm, gtSkinNorm));
    row.hair_as_skin_rate = round3(safeRatio(hitHair, predPixels));
    row.bg_as_skin_rate = round3(safeRatio(hitBg, predPixels));
    row.skin_miss_rate = round3(safeRatio(missSkin, gtSkinPixels));
    rows.push(row);
  }

  const okRows = rows.filter((row) => row && row.ok);
  const failReasonRows = renderFailReasonTable(rows);
  const metrics = {
    skin_iou_mean: round3(mean(okRows.map((row) => row.skin_iou))),
    skin_iou_p50: round3(percentile(okRows.map((row) => row.skin_iou), 50)),
    skin_iou_p90: round3(percentile(okRows.map((row) => row.skin_iou), 90)),
    hair_as_skin_rate_mean: round3(mean(okRows.map((row) => row.hair_as_skin_rate))),
    hair_as_skin_rate_p50: round3(percentile(okRows.map((row) => row.hair_as_skin_rate), 50)),
    hair_as_skin_rate_p90: round3(percentile(okRows.map((row) => row.hair_as_skin_rate), 90)),
    bg_as_skin_rate_mean: round3(mean(okRows.map((row) => row.bg_as_skin_rate))),
    bg_as_skin_rate_p50: round3(percentile(okRows.map((row) => row.bg_as_skin_rate), 50)),
    bg_as_skin_rate_p90: round3(percentile(okRows.map((row) => row.bg_as_skin_rate), 90)),
    skin_miss_rate_mean: round3(mean(okRows.map((row) => row.skin_miss_rate))),
    skin_miss_rate_p50: round3(percentile(okRows.map((row) => row.skin_miss_rate), 50)),
    skin_miss_rate_p90: round3(percentile(okRows.map((row) => row.skin_miss_rate), 90)),
    pred_skin_ratio_mean: round3(mean(okRows.map((row) => row.pred_skin_ratio))),
    pred_skin_ratio_p50: round3(percentile(okRows.map((row) => row.pred_skin_ratio), 50)),
    pred_skin_ratio_p90: round3(percentile(okRows.map((row) => row.pred_skin_ratio), 90)),
  };
  const sanity = {
    code: 'SKINMASK_CLASS_MAPPING_LIKELY_WRONG',
    triggered: metrics.pred_skin_ratio_mean > 0.8 && metrics.skin_iou_mean < 0.2,
    pred_skin_ratio_mean: round3(metrics.pred_skin_ratio_mean),
    skin_iou_mean: round3(metrics.skin_iou_mean),
  };

  const jsonlPath = path.join(reportDir, `eval_skinmask_fasseg_${runId}.jsonl`);
  const csvPath = path.join(reportDir, `eval_skinmask_fasseg_${runId}.csv`);
  const mdPath = path.join(reportDir, `eval_skinmask_fasseg_${runId}.md`);
  writeJsonl(jsonlPath, rows);
  writeText(
    csvPath,
    buildSummaryCsv({
      metrics,
      samplesTotal: rows.length,
      samplesOk: okRows.length,
      samplesFailed: rows.length - okRows.length,
      failReasonRows,
    }),
  );

  const artifactLabels = {
    md: makeRelativeLabel(repoRoot, mdPath),
    csv: makeRelativeLabel(repoRoot, csvPath),
    jsonl: makeRelativeLabel(repoRoot, jsonlPath),
  };
  writeText(
    mdPath,
    buildSummaryMd({
      runId,
      generatedAt: new Date().toISOString(),
      args,
      onnxLabel: makeRelativeLabel(repoRoot, onnxPath),
      samplesTotal: rows.length,
      samplesOk: okRows.length,
      samplesFailed: rows.length - okRows.length,
      metrics,
      failReasonRows,
      schemaSummary,
      sanity,
      artifactLabels,
    }),
  );

  const payload = {
    ok: !sanity.triggered,
    run_id: runId,
    dataset: 'fasseg',
    samples_total: rows.length,
    samples_ok: okRows.length,
    samples_failed: rows.length - okRows.length,
    metrics,
    schema: schemaSummary,
    sanity,
    artifacts: artifactLabels,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (sanity.triggered) {
    process.stderr.write(
      `eval_skinmask_fasseg_failed: likely class mapping wrong (pred_skin_ratio_mean=${round3(metrics.pred_skin_ratio_mean)}, skin_iou_mean=${round3(metrics.skin_iou_mean)})\n`,
    );
    process.exitCode = 2;
  }
}

run().catch((error) => {
  const message = String(error && error.message ? error.message : error);
  process.stderr.write(`eval_skinmask_fasseg_failed: ${message}\n`);
  process.exitCode = 1;
});
