#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { getAdapter, listAdapters, normalizeDatasetName } = require('../src/auroraBff/evalAdapters/index');
const {
  normalizeCacheDirs,
  toPosix,
  writeJson,
  writeText,
} = require('../src/auroraBff/evalAdapters/common/datasetUtils');
const {
  cloneDefaultBoxes,
  fitModuleBoxes,
  sanitizeBox,
} = require('../src/auroraBff/evalAdapters/common/circlePriorModel');
const {
  countOnes,
  andMasks,
  bboxNormToMask,
} = require('../src/auroraBff/evalAdapters/common/metrics');
const {
  readMaskLabelImage,
  readBinaryMaskFromThreshold,
  maskFromAllowedLabelValues,
  resizeMaskNearest,
  cropMaskToNorm,
} = require('../src/auroraBff/evalAdapters/common/maskUtils');
const { faceCropFromSkinBBoxNorm } = require('../src/auroraBff/evalAdapters/common/gtDerivation');

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_DATASETS = ['lapa', 'celebamaskhq', 'fasseg'];
const DEFAULT_MODEL_OUT = path.join('model_registry', 'circle_prior_v1.json');
const DEFAULT_ALIAS_OUT = path.join('model_registry', 'circle_prior_latest.json');
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_GRID_SIZE = 256;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MIN_PART_PIXELS = 24;
const DEFAULT_MIN_SKIN_OVERLAP = 0.2;

const LAPA_PART_LABELS = Object.freeze({
  l_brow: [2],
  r_brow: [3],
  l_eye: [4],
  r_eye: [5],
  nose: [6],
  u_lip: [7],
  mouth: [7, 8, 9],
  l_lip: [9],
});

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function nowKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}${ss}`;
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseDatasets(value) {
  const text = String(value || '').trim();
  if (!text) return [...DEFAULT_DATASETS];
  const out = text
    .split(',')
    .map((token) => normalizeDatasetName(token))
    .filter(Boolean);
  const deduped = [...new Set(out)];
  if (!deduped.length) return [...DEFAULT_DATASETS];
  const unsupported = deduped.filter((dataset) => !listAdapters().includes(dataset));
  if (unsupported.length) {
    throw new Error(`unsupported_datasets:${unsupported.join(',')}`);
  }
  return deduped;
}

function parseArgs(argv) {
  const out = {
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    datasets: process.env.DATASETS || DEFAULT_DATASETS.join(','),
    limit: parseNumber(process.env.LIMIT, 0, 0, 200000),
    shuffle: parseBoolean(process.env.SHUFFLE, false),
    seed: process.env.SEED || nowKey(),
    report_dir: process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    model_out: process.env.CIRCLE_MODEL_OUT || DEFAULT_MODEL_OUT,
    alias_out: process.env.CIRCLE_MODEL_ALIAS || DEFAULT_ALIAS_OUT,
    grid_size: parseNumber(process.env.CIRCLE_MODEL_GRID_SIZE, DEFAULT_GRID_SIZE, 96, 512),
    concurrency: parseNumber(process.env.CONCURRENCY, DEFAULT_CONCURRENCY, 1, 16),
    min_part_pixels: parseNumber(process.env.CIRCLE_MODEL_MIN_PART_PIXELS, DEFAULT_MIN_PART_PIXELS, 4, 2048),
    min_skin_overlap: parseNumber(process.env.CIRCLE_MODEL_MIN_SKIN_OVERLAP, DEFAULT_MIN_SKIN_OVERLAP, 0, 1),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cache_dir' && next) {
      out.cache_dir = next;
      i += 1;
      continue;
    }
    if (token === '--datasets' && next) {
      out.datasets = next;
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 0, 200000);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
    if (token === '--seed' && next) {
      out.seed = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--model_out' && next) {
      out.model_out = String(next);
      i += 1;
      continue;
    }
    if (token === '--alias_out' && next) {
      out.alias_out = String(next);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = parseNumber(next, out.grid_size, 96, 512);
      i += 1;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = parseNumber(next, out.concurrency, 1, 16);
      i += 1;
      continue;
    }
    if (token === '--min_part_pixels' && next) {
      out.min_part_pixels = parseNumber(next, out.min_part_pixels, 4, 2048);
      i += 1;
      continue;
    }
    if (token === '--min_skin_overlap' && next) {
      out.min_skin_overlap = parseNumber(next, out.min_skin_overlap, 0, 1);
      i += 1;
      continue;
    }
  }

  out.datasets = parseDatasets(out.datasets);
  out.limit = Math.max(0, Math.trunc(out.limit));
  out.grid_size = Math.max(96, Math.trunc(out.grid_size));
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.model_out = path.resolve(out.model_out);
  out.alias_out = path.resolve(out.alias_out);
  out.report_dir = path.resolve(out.report_dir);
  return out;
}

function bboxFromMask(mask, width, height, minPixels = 1) {
  if (!(mask instanceof Uint8Array) || !width || !height) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      pixels += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (pixels < Math.max(1, Number(minPixels) || 1)) return null;
  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX + 1 - minX) / width,
    h: (maxY + 1 - minY) / height,
    pixels,
  };
}

function unionBoxes(boxes) {
  const valid = (Array.isArray(boxes) ? boxes : []).filter(Boolean);
  if (!valid.length) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const box of valid) {
    minX = Math.min(minX, clamp01(box.x));
    minY = Math.min(minY, clamp01(box.y));
    maxX = Math.max(maxX, clamp01(Number(box.x) + Number(box.w)));
    maxY = Math.max(maxY, clamp01(Number(box.y) + Number(box.h)));
  }
  return sanitizeBox({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, { x: 0.2, y: 0.2, w: 0.6, h: 0.6 });
}

function expandBox(box, xScale = 1, yScale = 1, yShift = 0) {
  if (!box) return null;
  const centerX = Number(box.x) + Number(box.w) / 2;
  const centerY = Number(box.y) + Number(box.h) / 2 + Number(yShift) * Number(box.h);
  const w = Math.max(0.02, Number(box.w) * Number(xScale || 1));
  const h = Math.max(0.02, Number(box.h) * Number(yScale || 1));
  return sanitizeBox({
    x: centerX - w / 2,
    y: centerY - h / 2,
    w,
    h,
  }, box);
}

function insideUnit(box) {
  if (!box) return null;
  return sanitizeBox(box, box);
}

function firstPart(partBoxes, keys) {
  for (const key of keys) {
    const hit = partBoxes[key];
    if (hit) return hit;
  }
  return null;
}

function overlapWithSkinRatio(box, skinMaskNorm, gridSize) {
  if (!box || !(skinMaskNorm instanceof Uint8Array)) return 0;
  const boxMask = bboxNormToMask(box, gridSize, gridSize);
  const boxPixels = countOnes(boxMask);
  if (!boxPixels) return 0;
  const inter = countOnes(andMasks(boxMask, skinMaskNorm));
  return inter / boxPixels;
}

function hashSample(dataset, sampleId) {
  return crypto.createHash('sha256').update(`${dataset}:${sampleId}`).digest('hex').slice(0, 16);
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function makeCsv(modelBoxes, moduleStats) {
  const headers = ['module_id', 'x', 'y', 'w', 'h', 'samples', 'strong_samples', 'weak_samples', 'fallback_default'];
  const lines = [headers.join(',')];
  for (const moduleId of Object.keys(modelBoxes)) {
    const box = modelBoxes[moduleId] || {};
    const stats = moduleStats[moduleId] || {};
    lines.push([
      moduleId,
      round4(box.x),
      round4(box.y),
      round4(box.w),
      round4(box.h),
      Number(stats.samples || 0),
      Number(stats.strong_samples || 0),
      Number(stats.weak_samples || 0),
      Boolean(stats.fallback_default || false),
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          ok: false,
          reason: String(error && error.message ? error.message : error),
        };
      }
    }
  }
  const slots = [];
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  for (let i = 0; i < n; i += 1) slots.push(runner());
  await Promise.all(slots);
  return results;
}

function createDefaultRows() {
  const defaults = cloneDefaultBoxes();
  const rows = [];
  for (const [moduleId, box] of Object.entries(defaults)) {
    rows.push({
      module_id: moduleId,
      box,
      source: 'weak',
      weight: 1,
    });
  }
  return rows;
}

function buildModuleCandidates(partBoxes, defaults) {
  const modules = {};
  const lEye = firstPart(partBoxes, ['l_eye', 'left_eye']);
  const rEye = firstPart(partBoxes, ['r_eye', 'right_eye']);
  const lBrow = firstPart(partBoxes, ['l_brow', 'left_brow']);
  const rBrow = firstPart(partBoxes, ['r_brow', 'right_brow']);
  const nose = firstPart(partBoxes, ['nose']);
  const mouth = unionBoxes([
    firstPart(partBoxes, ['mouth']),
    firstPart(partBoxes, ['u_lip']),
    firstPart(partBoxes, ['l_lip']),
  ]);
  const browUnion = unionBoxes([lBrow, rBrow]);

  if (lEye) {
    modules.under_eye_left = expandBox(lEye, 2.3, 1.35, 0.8);
  }
  if (rEye) {
    modules.under_eye_right = expandBox(rEye, 2.3, 1.35, 0.8);
  }
  if (nose) {
    modules.nose = expandBox(nose, 1.15, 1.18, 0.03);
  }
  if (browUnion) {
    modules.forehead = insideUnit({
      x: Math.max(0, browUnion.x - browUnion.w * 0.28),
      y: 0,
      w: Math.min(1, browUnion.w * 1.56),
      h: Math.max(0.08, Math.min(0.36, browUnion.y + browUnion.h * 0.52)),
    });
  }

  const noseAnchor = modules.nose || nose || defaults.nose;
  const noseCenterX = clamp01(Number(noseAnchor.x) + Number(noseAnchor.w) / 2);
  const yTop = clamp01(((lEye?.y ?? rEye?.y) || 0.25) + ((lEye?.h ?? rEye?.h ?? 0.08) * 0.6));
  const yBottom = clamp01((mouth ? mouth.y + mouth.h * 0.9 : 0.88));
  modules.left_cheek = insideUnit({
    x: 0.04,
    y: Math.min(yTop, yBottom - 0.1),
    w: Math.max(0.12, noseCenterX - 0.06),
    h: Math.max(0.12, yBottom - yTop),
  });
  modules.right_cheek = insideUnit({
    x: noseCenterX + 0.02,
    y: Math.min(yTop, yBottom - 0.1),
    w: Math.max(0.12, 0.96 - (noseCenterX + 0.02)),
    h: Math.max(0.12, yBottom - yTop),
  });
  modules.chin = insideUnit({
    x: Math.max(0.16, (mouth ? mouth.x - mouth.w * 0.25 : 0.3)),
    y: clamp01(mouth ? mouth.y + mouth.h * 0.8 : 0.66),
    w: Math.min(0.68, mouth ? mouth.w * 1.5 : 0.38),
    h: 0.32,
  });

  const rows = [];
  for (const moduleId of Object.keys(defaults)) {
    const box = modules[moduleId];
    if (box) {
      rows.push({
        module_id: moduleId,
        box: sanitizeBox(box, defaults[moduleId]),
        source: 'strong',
        weight: 3,
      });
    } else {
      rows.push({
        module_id: moduleId,
        box: defaults[moduleId],
        source: 'weak',
        weight: 1,
      });
    }
  }
  return rows;
}

function skinBboxNorm(mask, width, height) {
  const box = bboxFromMask(mask, width, height, 16);
  if (!box) return null;
  return {
    x0: box.x,
    y0: box.y,
    x1: clamp01(box.x + box.w),
    y1: clamp01(box.y + box.h),
  };
}

async function extractPartBoxes(dataset, evalSample, skinShape, faceCropBox, gridSize, minPartPixels) {
  const out = {};
  if (dataset === 'celebamaskhq') {
    const partRows = Array.isArray(evalSample?.gt_parts?.part_masks) ? evalSample.gt_parts.part_masks : [];
    for (const partRow of partRows) {
      const partName = String(partRow?.part || '').toLowerCase();
      const partPath = String(partRow?.path || '').trim();
      if (!partName || !partPath) continue;
      const parsed = await readBinaryMaskFromThreshold(partPath, 1).catch(() => null);
      if (!parsed || !(parsed.mask instanceof Uint8Array)) continue;
      const resized =
        parsed.width === skinShape.width && parsed.height === skinShape.height
          ? parsed.mask
          : resizeMaskNearest(parsed.mask, parsed.width, parsed.height, skinShape.width, skinShape.height);
      const cropMask = cropMaskToNorm(resized, skinShape.width, skinShape.height, faceCropBox, gridSize, gridSize);
      const box = bboxFromMask(cropMask, gridSize, gridSize, minPartPixels);
      if (box) out[partName] = sanitizeBox(box, { x: 0.3, y: 0.3, w: 0.2, h: 0.2 });
    }
    return out;
  }

  if (dataset === 'lapa') {
    const maskPath = String(evalSample?.gt_masks?.[0]?.mask_path || '').trim();
    if (!maskPath) return out;
    const labelImage = await readMaskLabelImage(maskPath).catch(() => null);
    if (!labelImage) return out;
    for (const [partName, values] of Object.entries(LAPA_PART_LABELS)) {
      const mask = maskFromAllowedLabelValues(labelImage, values);
      const cropMask = cropMaskToNorm(mask, labelImage.width, labelImage.height, faceCropBox, gridSize, gridSize);
      const box = bboxFromMask(cropMask, gridSize, gridSize, minPartPixels);
      if (box) out[partName] = sanitizeBox(box, { x: 0.3, y: 0.3, w: 0.2, h: 0.2 });
    }
    return out;
  }

  return out;
}

function applySkinOverlapGuard(rows, defaults, skinMaskNorm, gridSize, minSkinOverlap) {
  return rows.map((row) => {
    const moduleId = row.module_id;
    const fallback = defaults[moduleId];
    const overlap = overlapWithSkinRatio(row.box, skinMaskNorm, gridSize);
    if (row.source === 'strong' && overlap < minSkinOverlap) {
      return {
        module_id: moduleId,
        box: fallback,
        source: 'weak',
        weight: 1,
        overlap,
      };
    }
    return {
      ...row,
      overlap,
    };
  });
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function renderReport({
  runKey,
  args,
  modelPath,
  aliasPath,
  fit,
  datasetStats,
  sampleStats,
  csvPath,
}) {
  const lines = [];
  lines.push('# Circle Prior Model Training');
  lines.push('');
  lines.push(`- run_id: ${runKey}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- datasets: ${args.datasets.join(', ')}`);
  lines.push(`- limit: ${args.limit || 'none'}`);
  lines.push(`- grid_size: ${args.grid_size}`);
  lines.push(`- min_part_pixels: ${args.min_part_pixels}`);
  lines.push(`- min_skin_overlap: ${args.min_skin_overlap}`);
  lines.push(`- model_out: ${toPosix(path.relative(process.cwd(), modelPath))}`);
  lines.push(`- model_alias: ${toPosix(path.relative(process.cwd(), aliasPath))}`);
  lines.push('');
  lines.push('## Sample Coverage');
  lines.push('');
  lines.push(`- samples_total: ${sampleStats.total}`);
  lines.push(`- samples_used: ${sampleStats.used}`);
  lines.push(`- samples_skipped: ${sampleStats.skipped}`);
  lines.push('');
  lines.push('| dataset | loaded | used | skipped |');
  lines.push('|---|---:|---:|---:|');
  for (const [dataset, stats] of Object.entries(datasetStats)) {
    lines.push(`| ${dataset} | ${stats.loaded} | ${stats.used} | ${stats.skipped} |`);
  }
  lines.push('');
  lines.push('## Module Boxes');
  lines.push('');
  lines.push('| module | x | y | w | h | samples | strong | weak |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const moduleId of Object.keys(fit.module_boxes)) {
    const box = fit.module_boxes[moduleId];
    const stats = fit.module_stats[moduleId] || {};
    lines.push(
      `| ${moduleId} | ${round4(box.x)} | ${round4(box.y)} | ${round4(box.w)} | ${round4(box.h)} | ${stats.samples || 0} | ${stats.strong_samples || 0} | ${stats.weak_samples || 0} |`,
    );
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- csv: \`${toPosix(path.relative(process.cwd(), csvPath))}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runKey = nowKey();
  const cache = normalizeCacheDirs(args.cache_dir);
  const defaults = cloneDefaultBoxes();

  await ensureDir(path.dirname(args.model_out));
  await ensureDir(path.dirname(args.alias_out));
  await ensureDir(args.report_dir);

  const loadedEntries = [];
  const datasetStats = {};
  for (const dataset of args.datasets) {
    const adapter = getAdapter(dataset);
    if (!adapter) throw new Error(`adapter_not_found:${dataset}`);
    const loaded = await adapter.loadSamples({
      repoRoot: process.cwd(),
      cacheExternalDir: cache.cacheExternalDir,
      cacheRootDir: cache.cacheRootDir,
      limit: args.limit || undefined,
      shuffle: args.shuffle,
      seed: `${args.seed}:${dataset}`,
    });
    datasetStats[dataset] = { loaded: (loaded.samples || []).length, used: 0, skipped: 0 };
    for (const sample of loaded.samples || []) {
      loadedEntries.push({ dataset, adapter, sample });
    }
  }

  if (!loadedEntries.length) throw new Error('no_training_samples_loaded');

  const sampleResults = await runWithConcurrency(loadedEntries, args.concurrency, async (entry) => {
    const evalSample = entry.adapter.toEvalSample(entry.sample);
    const skin = await entry.adapter.buildSkinMask(evalSample);
    if (!skin || !skin.ok || !(skin.mask instanceof Uint8Array)) {
      return {
        ok: false,
        dataset: entry.dataset,
        sample_id: evalSample.sample_id,
        reason: skin && skin.reason ? skin.reason : 'skin_mask_missing',
      };
    }

    const skinNormBox = skinBboxNorm(skin.mask, skin.width, skin.height);
    if (!skinNormBox) {
      return {
        ok: false,
        dataset: entry.dataset,
        sample_id: evalSample.sample_id,
        reason: 'skin_bbox_missing',
      };
    }

    const faceCrop = faceCropFromSkinBBoxNorm({
      skinBboxNorm: skinNormBox,
      imageWidth: skin.width,
      imageHeight: skin.height,
      marginScale: 1.2,
    });

    const skinMaskNorm = cropMaskToNorm(
      skin.mask,
      skin.width,
      skin.height,
      faceCrop,
      args.grid_size,
      args.grid_size,
    );

    const partBoxes = await extractPartBoxes(
      entry.dataset,
      evalSample,
      { width: skin.width, height: skin.height },
      faceCrop,
      args.grid_size,
      args.min_part_pixels,
    );

    const rawRows = buildModuleCandidates(partBoxes, defaults);
    const guardedRows = applySkinOverlapGuard(rawRows, defaults, skinMaskNorm, args.grid_size, args.min_skin_overlap);
    const rows = guardedRows.map((row) => ({
      module_id: row.module_id,
      box: sanitizeBox(row.box, defaults[row.module_id]),
      source: row.source,
      weight: row.weight,
    }));

    return {
      ok: true,
      dataset: entry.dataset,
      sample_id: evalSample.sample_id,
      sample_hash: hashSample(entry.dataset, evalSample.sample_id),
      rows,
      strong_count: rows.filter((row) => row.source === 'strong').length,
      weak_count: rows.filter((row) => row.source !== 'strong').length,
    };
  });

  const trainingRows = createDefaultRows();
  const sampleStats = {
    total: sampleResults.length,
    used: 0,
    skipped: 0,
  };

  for (const result of sampleResults) {
    const stats = datasetStats[result?.dataset] || null;
    if (!result || !result.ok || !Array.isArray(result.rows) || !result.rows.length) {
      sampleStats.skipped += 1;
      if (stats) stats.skipped += 1;
      continue;
    }
    sampleStats.used += 1;
    if (stats) stats.used += 1;
    for (const row of result.rows) trainingRows.push(row);
  }

  const fit = fitModuleBoxes(trainingRows, defaults);
  const modelPayload = {
    schema_version: 'aurora.circle_prior_model.v1',
    generated_at: new Date().toISOString(),
    datasets: args.datasets,
    seed: args.seed,
    grid_size: args.grid_size,
    min_part_pixels: args.min_part_pixels,
    min_skin_overlap: args.min_skin_overlap,
    training_stats: {
      samples_total: sampleStats.total,
      samples_used: sampleStats.used,
      samples_skipped: sampleStats.skipped,
      by_dataset: datasetStats,
      candidate_rows_total: trainingRows.length,
    },
    module_boxes: fit.module_boxes,
    module_stats: fit.module_stats,
  };

  writeJson(args.model_out, modelPayload);
  writeJson(args.alias_out, modelPayload);

  const csvPath = path.join(args.report_dir, `circle_prior_train_${runKey}.csv`);
  const mdPath = path.join(args.report_dir, `circle_prior_train_${runKey}.md`);
  writeText(csvPath, makeCsv(fit.module_boxes, fit.module_stats));
  writeText(mdPath, renderReport({
    runKey,
    args,
    modelPath: args.model_out,
    aliasPath: args.alias_out,
    fit,
    datasetStats,
    sampleStats,
    csvPath,
  }));

  const summary = {
    ok: true,
    run_id: runKey,
    datasets: args.datasets,
    samples_total: sampleStats.total,
    samples_used: sampleStats.used,
    samples_skipped: sampleStats.skipped,
    module_boxes: fit.module_boxes,
    artifacts: {
      model: toPosix(path.relative(process.cwd(), args.model_out)),
      alias: toPosix(path.relative(process.cwd(), args.alias_out)),
      csv: toPosix(path.relative(process.cwd(), csvPath)),
      md: toPosix(path.relative(process.cwd(), mdPath)),
    },
  };

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
