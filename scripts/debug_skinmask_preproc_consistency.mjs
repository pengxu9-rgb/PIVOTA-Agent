#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { getAdapter } = require('../src/auroraBff/evalAdapters/index');
const { readMaskLabelImage } = require('../src/auroraBff/evalAdapters/common/maskUtils');
const { createMask, countOnes } = require('../src/auroraBff/evalAdapters/common/metrics');
const { faceCropFromSkinBBoxNorm } = require('../src/auroraBff/evalAdapters/common/gtDerivation');
const { inferSkinMaskOnFaceCrop } = require('../src/auroraBff/skinmaskOnnx');
const { normalizeCacheDirs, writeJsonl, writeText, toPosix } = require('../src/auroraBff/evalAdapters/common/datasetUtils');

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_ONNX = path.join('artifacts', 'skinmask_v1.onnx');
const DEFAULT_LIMIT = 20;
const DEFAULT_GRID_SIZE = Math.max(
  32,
  Math.min(256, Math.trunc(Number(process.env.DIAG_SKINMASK_GRID || 128) || 128)),
);
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SEED = 'skinmask_preproc_consistency_v1';
const DEFAULT_BACKBONE = 'nvidia/segformer-b0-finetuned-ade-512-512';
const MISMATCH_THRESHOLD = 0.05;

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
    onnx: String(process.env.ONNX || process.env.DIAG_SKINMASK_MODEL_PATH || DEFAULT_ONNX),
    limit: parseNumber(process.env.LIMIT, DEFAULT_LIMIT, 1, 5000),
    seed: String(process.env.EVAL_SAMPLE_SEED || DEFAULT_SEED),
    grid_size: parseNumber(process.env.DIAG_SKINMASK_GRID, DEFAULT_GRID_SIZE, 32, 256),
    timeout_ms: parseNumber(process.env.EVAL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 500, 120000),
    shuffle: parseBoolean(process.env.EVAL_SHUFFLE, false),
    backbone_name: String(process.env.SKINMASK_BACKBONE || DEFAULT_BACKBONE),
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
      out.limit = parseNumber(next, out.limit, 1, 5000);
      i += 1;
      continue;
    }
    if (token === '--seed' && next) {
      out.seed = String(next);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = parseNumber(next, out.grid_size, 32, 256);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeout_ms = parseNumber(next, out.timeout_ms, 500, 120000);
      i += 1;
      continue;
    }
    if (token === '--backbone_name' && next) {
      out.backbone_name = String(next);
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
  return out;
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

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
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

function safeRatio(num, den) {
  return den > 0 ? num / den : 0;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function clampBoxToImage(box, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.trunc(Number(box.x) || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.trunc(Number(box.y) || 0)));
  const maxW = Math.max(1, width - x);
  const maxH = Math.max(1, height - y);
  const w = Math.max(1, Math.min(maxW, Math.trunc(Number(box.w) || width)));
  const h = Math.max(1, Math.min(maxH, Math.trunc(Number(box.h) || height)));
  return { x, y, w, h };
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
  if (maxX < 0 || maxY < 0) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return {
    x0: minX / w,
    y0: minY / h,
    x1: (maxX + 1) / w,
    y1: (maxY + 1) / h,
  };
}

function deriveFassegSkinMask(labelImage) {
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
    hist[Number(data[i]) & 0xff] += 1;
  }
  const uniqueCount = hist.reduce((acc, count) => (count > 0 ? acc + 1 : acc), 0);
  const compressedLike = uniqueCount > 16;
  const skinMask = createMask(width, height, 0);
  if (compressedLike) {
    for (let i = 0; i < data.length; i += 1) {
      const value = Number(data[i]) & 0xff;
      if (value >= 192) skinMask[i] = 1;
    }
  } else {
    for (let i = 0; i < data.length; i += 1) {
      if ((Number(data[i]) & 0xff) === 1) skinMask[i] = 1;
    }
  }
  if (!countOnes(skinMask)) {
    return { ok: false, reason: 'gt_skin_empty' };
  }
  return {
    ok: true,
    width,
    height,
    skinMask,
  };
}

function formatChannelStats(stats) {
  if (!stats || typeof stats !== 'object') return '-';
  return `min=${round4(stats.min)} max=${round4(stats.max)} mean=${round4(stats.mean)} std=${round4(stats.std)}`;
}

function buildSummary(rows) {
  const comparable = rows.filter((row) => row.ok);
  const channelSummary = [];
  let warning = false;
  for (let c = 0; c < 3; c += 1) {
    const pyMean = mean(comparable.map((row) => row.py?.channels?.[c]?.mean));
    const nodeMean = mean(comparable.map((row) => row.node?.channels?.[c]?.mean));
    const pyStd = mean(comparable.map((row) => row.py?.channels?.[c]?.std));
    const nodeStd = mean(comparable.map((row) => row.node?.channels?.[c]?.std));
    const meanDiff = Math.abs(nodeMean - pyMean);
    const stdDiff = Math.abs(nodeStd - pyStd);
    if (meanDiff > MISMATCH_THRESHOLD || stdDiff > MISMATCH_THRESHOLD) warning = true;
    channelSummary.push({
      channel: c,
      py_mean: pyMean,
      node_mean: nodeMean,
      mean_diff_abs: meanDiff,
      py_std: pyStd,
      node_std: nodeStd,
      std_diff_abs: stdDiff,
    });
  }
  return {
    comparable_count: comparable.length,
    warning,
    channel_summary: channelSummary,
    py_skin_prob_mean: mean(comparable.map((row) => row.py?.skin_prob_mean)),
    node_skin_prob_mean: mean(comparable.map((row) => row.node?.skin_prob_mean)),
    py_pred_skin_ratio: mean(comparable.map((row) => row.py?.pred_skin_ratio)),
    node_pred_skin_ratio: mean(comparable.map((row) => row.node?.pred_skin_ratio)),
  };
}

function buildMarkdown({ runId, args, summary, rows, artifacts, onnxLabel }) {
  const lines = [];
  lines.push('# Skinmask Preprocess Consistency Debug');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push('- dataset: fasseg');
  lines.push(`- onnx: ${onnxLabel}`);
  lines.push(`- limit: ${args.limit}`);
  lines.push(`- sample_seed: ${args.seed}`);
  lines.push(`- shuffle: ${args.shuffle ? 'true' : 'false'}`);
  lines.push(`- threshold: mean/std abs diff > ${MISMATCH_THRESHOLD}`);
  lines.push(`- comparable_samples: ${summary.comparable_count}`);
  lines.push('');
  if (summary.warning) {
    lines.push('## WARNING');
    lines.push('');
    lines.push('**WARNING: PREPROCESS_MISMATCH**');
    lines.push('');
  }
  lines.push('## Channel Summary (A=Python train preprocess, B=Node ONNX preprocess)');
  lines.push('');
  lines.push('| channel | A mean | B mean | abs diff | A std | B std | abs diff |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summary.channel_summary) {
    lines.push(
      `| ${row.channel} | ${round4(row.py_mean)} | ${round4(row.node_mean)} | ${round4(row.mean_diff_abs)} | ${round4(row.py_std)} | ${round4(row.node_std)} | ${round4(row.std_diff_abs)} |`,
    );
  }
  lines.push('');
  lines.push('## Output Summary');
  lines.push('');
  lines.push('| metric | A (Python) | B (Node) | delta (B-A) |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| skin_prob_mean | ${round4(summary.py_skin_prob_mean)} | ${round4(summary.node_skin_prob_mean)} | ${round4(summary.node_skin_prob_mean - summary.py_skin_prob_mean)} |`);
  lines.push(`| pred_skin_ratio | ${round4(summary.py_pred_skin_ratio)} | ${round4(summary.node_pred_skin_ratio)} | ${round4(summary.node_pred_skin_ratio - summary.py_pred_skin_ratio)} |`);
  lines.push('');
  lines.push('## Per-sample');
  lines.push('');
  lines.push('| sample_hash | A resize | B resize | A ch0 | B ch0 | A ch1 | B ch1 | A ch2 | B ch2 | A skin_prob_mean | B skin_prob_mean | A pred_skin_ratio | B pred_skin_ratio | fail_reason |');
  lines.push('|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|');
  for (const row of rows) {
    lines.push(
      `| ${row.sample_hash} | ${row.py?.resize_shape ? row.py.resize_shape.join('x') : '-'} | ${row.node?.resize_shape ? row.node.resize_shape.join('x') : '-'} | ${formatChannelStats(row.py?.channels?.[0])} | ${formatChannelStats(row.node?.channels?.[0])} | ${formatChannelStats(row.py?.channels?.[1])} | ${formatChannelStats(row.node?.channels?.[1])} | ${formatChannelStats(row.py?.channels?.[2])} | ${formatChannelStats(row.node?.channels?.[2])} | ${round4(row.py?.skin_prob_mean)} | ${round4(row.node?.skin_prob_mean)} | ${round4(row.py?.pred_skin_ratio)} | ${round4(row.node?.pred_skin_ratio)} | ${row.fail_reason || '-'} |`,
    );
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- md: \`${artifacts.md}\``);
  lines.push(`- jsonl: \`${artifacts.jsonl}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(process.cwd());
  const reportDir = path.resolve(repoRoot, args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const onnxPath = path.resolve(repoRoot, args.onnx);
  if (!fs.existsSync(onnxPath) || !fs.statSync(onnxPath).isFile()) {
    throw new Error(`onnx_not_found:${args.onnx}`);
  }

  const cache = normalizeCacheDirs(args.cache_dir);
  const adapter = getAdapter('fasseg');
  if (!adapter) throw new Error('fasseg_adapter_missing');

  const loaded = await adapter.loadSamples({
    repoRoot,
    cacheExternalDir: cache.cacheExternalDir,
    cacheRootDir: cache.cacheRootDir,
    limit: args.limit,
    shuffle: args.shuffle,
    seed: args.seed,
  });
  const samples = Array.isArray(loaded && loaded.samples) ? loaded.samples : [];
  if (!samples.length) throw new Error('fasseg_samples_empty');

  const pyManifest = [];
  const rows = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const evalSample = adapter.toEvalSample(sample);
    const sampleHash = hashId(`fasseg:${evalSample.sample_id}:${index}`);
    const row = {
      sample_hash: sampleHash,
      ok: false,
      fail_reason: null,
      py: null,
      node: null,
    };
    try {
      const imageBuffer = await fsp.readFile(evalSample.image_bytes_path);
      const maskPath = String(
        evalSample &&
          Array.isArray(evalSample.gt_masks) &&
          evalSample.gt_masks[0] &&
          typeof evalSample.gt_masks[0].mask_path === 'string'
          ? evalSample.gt_masks[0].mask_path
          : '',
      );
      const labelImage = await readMaskLabelImage(maskPath);
      const gt = deriveFassegSkinMask(labelImage);
      if (!gt.ok) {
        row.fail_reason = `GT_FAIL:${gt.reason || 'unknown'}`;
        rows.push(row);
        continue;
      }
      const bboxNorm = maskBoundingNorm(gt.skinMask, gt.width, gt.height);
      const faceCrop = faceCropFromSkinBBoxNorm({
        skinBboxNorm: bboxNorm,
        imageWidth: gt.width,
        imageHeight: gt.height,
        marginScale: 1.2,
      });

      const normalized = await sharp(imageBuffer, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
      const normBuffer = normalized && normalized.data ? normalized.data : null;
      const imageW = Number(normalized && normalized.info && normalized.info.width);
      const imageH = Number(normalized && normalized.info && normalized.info.height);
      if (!normBuffer || !imageW || !imageH) {
        row.fail_reason = 'IMAGE_NORMALIZE_FAIL';
        rows.push(row);
        continue;
      }
      const cropBox = clampBoxToImage(faceCrop, imageW, imageH);
      const cropBuffer = await sharp(normBuffer, { failOn: 'none' }).extract({
        left: cropBox.x,
        top: cropBox.y,
        width: cropBox.w,
        height: cropBox.h,
      }).png().toBuffer();

      const inferred = await inferSkinMaskOnFaceCrop({
        imageBuffer: cropBuffer,
        diagnosisInternal: {},
        modelPath: onnxPath,
        gridSize: args.grid_size,
        allowPriorFallback: false,
        includeDebugStats: true,
      });
      if (!inferred || !inferred.ok) {
        row.fail_reason = inferred && inferred.reason ? `NODE_FAIL:${inferred.reason}` : 'NODE_FAIL';
        rows.push(row);
        continue;
      }
      row.node = {
        resize_shape: Array.isArray(inferred.input_size) ? inferred.input_size.map((value) => Number(value)) : null,
        channels:
          inferred &&
          inferred.input_tensor_stats &&
          Array.isArray(inferred.input_tensor_stats.channels)
            ? inferred.input_tensor_stats.channels.map((item) => ({
                min: Number(item.min),
                max: Number(item.max),
                mean: Number(item.mean),
                std: Number(item.std),
              }))
            : null,
        skin_prob_mean: Number.isFinite(Number(inferred.skin_prob_mean)) ? Number(inferred.skin_prob_mean) : null,
        pred_skin_ratio: Number.isFinite(Number(inferred.positive_ratio)) ? Number(inferred.positive_ratio) : null,
      };
      pyManifest.push({
        sample_hash: sampleHash,
        crop_b64: cropBuffer.toString('base64'),
      });
      rows.push(row);
    } catch (error) {
      row.fail_reason = `PIPELINE_FAIL:${String(error && error.message ? error.message : error)}`;
      rows.push(row);
    }
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinmask-preproc-'));
  const manifestPath = path.join(tmpDir, 'manifest.json');
  await fsp.writeFile(manifestPath, `${JSON.stringify(pyManifest)}\n`, 'utf8');
  const pyScriptPath = path.resolve(repoRoot, 'scripts', 'skinmask_preproc_python_batch.py');
  const pyRaw = execFileSync('python3', [
    pyScriptPath,
    '--manifest',
    manifestPath,
    '--onnx',
    onnxPath,
    '--backbone_name',
    args.backbone_name,
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const pyPayload = JSON.parse(String(pyRaw || '{}'));
  const pyRows = Array.isArray(pyPayload && pyPayload.rows) ? pyPayload.rows : [];
  const pyByHash = new Map(pyRows.map((row) => [String(row.sample_hash || ''), row]));

  for (const row of rows) {
    if (row.fail_reason) continue;
    const py = pyByHash.get(String(row.sample_hash || ''));
    if (!py || !py.ok) {
      row.fail_reason = py && py.fail_reason ? `PY_FAIL:${py.fail_reason}` : 'PY_FAIL:MISSING_RESULT';
      continue;
    }
    row.py = {
      resize_shape: Array.isArray(py.resize_shape) ? py.resize_shape.map((value) => Number(value)) : null,
      channels: Array.isArray(py.channel_stats)
        ? py.channel_stats.map((item) => ({
            min: Number(item.min),
            max: Number(item.max),
            mean: Number(item.mean),
            std: Number(item.std),
          }))
        : null,
      skin_prob_mean: Number.isFinite(Number(py.skin_prob_mean)) ? Number(py.skin_prob_mean) : null,
      pred_skin_ratio: Number.isFinite(Number(py.pred_skin_ratio)) ? Number(py.pred_skin_ratio) : null,
    };
    row.ok = Boolean(row.node && row.py);
  }

  const summary = buildSummary(rows);
  const runId = nowRunKey();
  const jsonlPath = path.join(reportDir, `debug_skinmask_preproc_consistency_${runId}.jsonl`);
  const mdPath = path.join(reportDir, `debug_skinmask_preproc_consistency_${runId}.md`);
  const artifacts = {
    md: toPosix(path.relative(repoRoot, mdPath)),
    jsonl: toPosix(path.relative(repoRoot, jsonlPath)),
  };
  writeJsonl(jsonlPath, rows.map((row) => ({
    sample_hash: row.sample_hash,
    ok: Boolean(row.ok),
    fail_reason: row.fail_reason || null,
    python: row.py || null,
    node: row.node || null,
  })));
  writeText(mdPath, buildMarkdown({
    runId,
    args,
    summary,
    rows,
    artifacts,
    onnxLabel: toPosix(path.relative(repoRoot, onnxPath)),
  }));

  const payload = {
    ok: !summary.warning,
    run_id: runId,
    samples_total: rows.length,
    samples_ok: rows.filter((row) => row.ok).length,
    samples_failed: rows.filter((row) => !row.ok).length,
    warning: summary.warning,
    threshold: MISMATCH_THRESHOLD,
    artifacts,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

run().catch((error) => {
  const message = String(error && error.message ? error.message : error);
  process.stderr.write(`debug_skinmask_preproc_consistency_failed: ${message}\n`);
  process.exitCode = 1;
});
