#!/usr/bin/env node

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
  cropMaskToNorm,
} = require('../src/auroraBff/evalAdapters/common/maskUtils');
const { faceCropFromSkinBBoxNorm } = require('../src/auroraBff/evalAdapters/common/gtDerivation');
const {
  createMask,
  countOnes,
} = require('../src/auroraBff/evalAdapters/common/metrics');

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_LIMIT = 150;
const DEFAULT_GRID_SIZE = Math.max(
  32,
  Math.min(256, Math.trunc(Number(process.env.EVAL_GRID_SIZE || 128) || 128)),
);
const DEFAULT_SEED = 'gt_sanity_fasseg_seed_v1';

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

function parseArgs(argv) {
  const out = {
    cache_dir: String(process.env.CACHE_DIR || DEFAULT_CACHE_DIR),
    report_dir: String(process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR),
    limit: parseNumber(process.env.LIMIT, DEFAULT_LIMIT, 1, 100000),
    grid_size: parseNumber(process.env.EVAL_GRID_SIZE, DEFAULT_GRID_SIZE, 32, 256),
    shuffle: parseBoolean(process.env.EVAL_SHUFFLE, false),
    seed: String(process.env.EVAL_SAMPLE_SEED || DEFAULT_SEED),
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
    if (token === '--seed' && next) {
      out.seed = String(next);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
  }
  return out;
}

function mean(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return 0;
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!nums.length) return 0;
  const rank = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[rank] || 0;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function hashId(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 20);
}

function makeRelativeLabel(repoRoot, targetPath) {
  const rel = path.relative(repoRoot, targetPath);
  if (!rel || rel.startsWith('..')) return toPosix(targetPath);
  return toPosix(rel);
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
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

function deriveFassegMasks(labelImage) {
  const width = Math.max(1, Math.trunc(Number(labelImage && labelImage.width) || 0));
  const height = Math.max(1, Math.trunc(Number(labelImage && labelImage.height) || 0));
  const raw = labelImage && labelImage.data;
  const data =
    raw && typeof raw.length === 'number' && ArrayBuffer.isView(raw)
      ? raw
      : null;
  if (!data || !width || !height || Number(data.length) !== width * height) {
    return { ok: false, reason: 'label_image_invalid' };
  }

  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 1) {
    const value = Number(data[i]) & 0xff;
    hist[value] += 1;
  }
  const uniqueCount = hist.reduce((acc, count) => (count > 0 ? acc + 1 : acc), 0);
  const compressedLike = uniqueCount > 16;

  const skinMask = createMask(width, height, 0);
  const hairMask = createMask(width, height, 0);
  const bgMask = createMask(width, height, 0);
  const otherMask = createMask(width, height, 0);

  if (compressedLike) {
    for (let i = 0; i < data.length; i += 1) {
      const value = Number(data[i]) & 0xff;
      if (value >= 192) {
        skinMask[i] = 1;
      } else if (value >= 64) {
        hairMask[i] = 1;
      } else {
        bgMask[i] = 1;
      }
    }
    return {
      ok: true,
      mode: 'jpeg_quantized_3band',
      width,
      height,
      skinMask,
      hairMask,
      bgMask,
      otherMask,
      uniqueCount,
    };
  }

  for (let i = 0; i < data.length; i += 1) {
    const value = Number(data[i]) & 0xff;
    if (value === 1) {
      skinMask[i] = 1;
    } else if (value === 2) {
      hairMask[i] = 1;
    } else if (value === 0) {
      bgMask[i] = 1;
    } else {
      otherMask[i] = 1;
    }
  }
  return {
    ok: true,
    mode: 'label_012',
    width,
    height,
    skinMask,
    hairMask,
    bgMask,
    otherMask,
    uniqueCount,
  };
}

function buildSummaryCsv(rows) {
  const headers = [
    'dataset',
    'sample_hash',
    'ok',
    'fail_reason',
    'note',
    'gt_mapping_mode',
    'face_crop_total_pixels',
    'gt_skin_pixels',
    'gt_bg_pixels',
    'gt_hair_pixels',
    'gt_other_pixels',
    'gt_skin_ratio',
    'gt_bg_ratio',
    'gt_hair_ratio',
    'gt_other_ratio',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildSummaryMd({
  runId,
  args,
  generatedAt,
  rows,
  okRows,
  ratioSummary,
  anomalies,
  artifactLabels,
}) {
  const lines = [];
  lines.push('# FASSEG GT Sanity');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${generatedAt}`);
  lines.push(`- dataset: fasseg`);
  lines.push(`- samples_total: ${rows.length}`);
  lines.push(`- samples_ok: ${okRows.length}`);
  lines.push(`- samples_failed: ${rows.length - okRows.length}`);
  lines.push(`- grid_size: ${args.grid_size}`);
  lines.push(`- sample_seed: ${args.seed}`);
  lines.push(`- shuffle: ${args.shuffle ? 'true' : 'false'}`);
  lines.push('');
  lines.push('## Ratios Summary');
  lines.push('');
  lines.push('| ratio | mean | p50 | p90 |');
  lines.push('|---|---:|---:|---:|');
  for (const row of ratioSummary) {
    lines.push(`| ${row.name} | ${row.mean} | ${row.p50} | ${row.p90} |`);
  }
  lines.push('');
  lines.push('## Top 20 Anomalies');
  lines.push('');
  lines.push('| rank | sample_hash | gt_skin_ratio | gt_bg_ratio | gt_hair_ratio | gt_other_ratio | gt_skin_pixels | gt_bg_pixels | gt_hair_pixels | gt_other_pixels |');
  lines.push('|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  if (!anomalies.length) {
    lines.push('| 1 | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
  } else {
    for (let i = 0; i < anomalies.length; i += 1) {
      const row = anomalies[i];
      lines.push(
        `| ${i + 1} | ${row.sample_hash} | ${row.gt_skin_ratio} | ${row.gt_bg_ratio} | ${row.gt_hair_ratio} | ${row.gt_other_ratio} | ${row.gt_skin_pixels} | ${row.gt_bg_pixels} | ${row.gt_hair_pixels} | ${row.gt_other_pixels} |`,
      );
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
  const repoRoot = process.cwd();
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

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
      gt_mapping_mode: null,
      face_crop_total_pixels: args.grid_size * args.grid_size,
      gt_skin_pixels: 0,
      gt_bg_pixels: 0,
      gt_hair_pixels: 0,
      gt_other_pixels: 0,
      gt_skin_ratio: 0,
      gt_bg_ratio: 0,
      gt_hair_ratio: 0,
      gt_other_ratio: 0,
    };

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

    const gtDerived = deriveFassegMasks(labelImage);
    if (!gtDerived.ok) {
      row.fail_reason = 'GT_MASK_INVALID';
      row.note = gtDerived.reason || 'gt_derive_failed';
      rows.push(row);
      continue;
    }
    row.gt_mapping_mode = String(gtDerived.mode || 'unknown');

    const gtSkinBboxNorm = maskBoundingNorm(gtDerived.skinMask, gtDerived.width, gtDerived.height);
    const faceCropBox = faceCropFromSkinBBoxNorm({
      skinBboxNorm: gtSkinBboxNorm,
      imageWidth: gtDerived.width,
      imageHeight: gtDerived.height,
      marginScale: 1.2,
    });

    const gtSkinNorm = cropMaskToNorm(
      gtDerived.skinMask,
      gtDerived.width,
      gtDerived.height,
      faceCropBox,
      args.grid_size,
      args.grid_size,
    );
    const gtHairNorm = cropMaskToNorm(
      gtDerived.hairMask,
      gtDerived.width,
      gtDerived.height,
      faceCropBox,
      args.grid_size,
      args.grid_size,
    );
    const gtBgNorm = cropMaskToNorm(
      gtDerived.bgMask,
      gtDerived.width,
      gtDerived.height,
      faceCropBox,
      args.grid_size,
      args.grid_size,
    );
    const gtOtherNorm = cropMaskToNorm(
      gtDerived.otherMask,
      gtDerived.width,
      gtDerived.height,
      faceCropBox,
      args.grid_size,
      args.grid_size,
    );

    const faceTotal = args.grid_size * args.grid_size;
    const skinPixels = countOnes(gtSkinNorm);
    const hairPixels = countOnes(gtHairNorm);
    const bgPixels = countOnes(gtBgNorm);
    const otherPixels = countOnes(gtOtherNorm);

    row.ok = true;
    row.gt_skin_pixels = skinPixels;
    row.gt_hair_pixels = hairPixels;
    row.gt_bg_pixels = bgPixels;
    row.gt_other_pixels = otherPixels;
    row.gt_skin_ratio = round3(safeRatio(skinPixels, faceTotal));
    row.gt_hair_ratio = round3(safeRatio(hairPixels, faceTotal));
    row.gt_bg_ratio = round3(safeRatio(bgPixels, faceTotal));
    row.gt_other_ratio = round3(safeRatio(otherPixels, faceTotal));
    rows.push(row);
  }

  const okRows = rows.filter((row) => row && row.ok);
  const anomalies = okRows
    .filter((row) => Number(row.gt_bg_ratio) > 0.6 || Number(row.gt_skin_ratio) < 0.2)
    .sort((a, b) => {
      const aScore = (Number(a.gt_bg_ratio) - 0.6) + Math.max(0, 0.2 - Number(a.gt_skin_ratio));
      const bScore = (Number(b.gt_bg_ratio) - 0.6) + Math.max(0, 0.2 - Number(b.gt_skin_ratio));
      if (bScore !== aScore) return bScore - aScore;
      return String(a.sample_hash).localeCompare(String(b.sample_hash));
    })
    .slice(0, 20);

  const ratioSummary = [
    { name: 'gt_skin_ratio', values: okRows.map((row) => Number(row.gt_skin_ratio || 0)) },
    { name: 'gt_bg_ratio', values: okRows.map((row) => Number(row.gt_bg_ratio || 0)) },
    { name: 'gt_hair_ratio', values: okRows.map((row) => Number(row.gt_hair_ratio || 0)) },
    { name: 'gt_other_ratio', values: okRows.map((row) => Number(row.gt_other_ratio || 0)) },
  ].map((entry) => ({
    name: entry.name,
    mean: round3(mean(entry.values)),
    p50: round3(percentile(entry.values, 50)),
    p90: round3(percentile(entry.values, 90)),
  }));

  const jsonlPath = path.join(reportDir, `gt_sanity_fasseg_${runId}.jsonl`);
  const csvPath = path.join(reportDir, `gt_sanity_fasseg_${runId}.csv`);
  const mdPath = path.join(reportDir, `gt_sanity_fasseg_${runId}.md`);
  writeJsonl(jsonlPath, rows);
  writeText(csvPath, buildSummaryCsv(rows));
  const artifactLabels = {
    md: makeRelativeLabel(repoRoot, mdPath),
    csv: makeRelativeLabel(repoRoot, csvPath),
    jsonl: makeRelativeLabel(repoRoot, jsonlPath),
  };
  writeText(
    mdPath,
    buildSummaryMd({
      runId,
      args,
      generatedAt: new Date().toISOString(),
      rows,
      okRows,
      ratioSummary,
      anomalies,
      artifactLabels,
    }),
  );

  const payload = {
    ok: true,
    run_id: runId,
    dataset: 'fasseg',
    samples_total: rows.length,
    samples_ok: okRows.length,
    samples_failed: rows.length - okRows.length,
    anomalies_count: anomalies.length,
    ratio_summary: ratioSummary,
    artifacts: artifactLabels,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

run().catch((error) => {
  const message = String(error && error.message ? error.message : error);
  process.stderr.write(`eval_gt_sanity_fasseg_failed: ${message}\n`);
  process.exitCode = 1;
});
