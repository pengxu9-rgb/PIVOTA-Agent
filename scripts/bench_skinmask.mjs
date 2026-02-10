#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inferSkinMaskOnFaceCrop } = require('../src/auroraBff/skinmaskOnnx');

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

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] || 0;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function humanBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let unit = units[0];
  for (let i = 0; i < units.length; i += 1) {
    unit = units[i];
    if (v < 1024 || i === units.length - 1) break;
    v /= 1024;
  }
  return `${round3(v)} ${unit}`;
}

function toPosix(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function normalizeDatasets(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    onnx: String(process.env.ONNX || path.join('artifacts', 'skinmask_v1.onnx')),
    cache_dir: String(process.env.CACHE_DIR || path.join('datasets_cache', 'external')),
    datasets: normalizeDatasets(process.env.DATASETS || 'fasseg,lapa,celebamaskhq'),
    input_image: String(process.env.BENCH_IMAGE || ''),
    iterations: parseNumber(process.env.BENCH_ITERS, 200, 1, 20000),
    warmup: parseNumber(process.env.BENCH_WARMUP, 8, 0, 2000),
    timeout_ms: parseNumber(process.env.BENCH_TIMEOUT_MS, 5000, 100, 120000),
    grid_size: parseNumber(process.env.DIAG_SKINMASK_GRID, 64, 32, 256),
    report_dir: String(process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports'),
    strict: parseBoolean(process.env.BENCH_STRICT, false),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--onnx' && next) {
      out.onnx = String(next);
      i += 1;
      continue;
    }
    if (token === '--cache_dir' && next) {
      out.cache_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--datasets' && next) {
      out.datasets = normalizeDatasets(next);
      i += 1;
      continue;
    }
    if (token === '--input_image' && next) {
      out.input_image = String(next);
      i += 1;
      continue;
    }
    if (token === '--iterations' && next) {
      out.iterations = parseNumber(next, out.iterations, 1, 20000);
      i += 1;
      continue;
    }
    if (token === '--warmup' && next) {
      out.warmup = parseNumber(next, out.warmup, 0, 2000);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeout_ms = parseNumber(next, out.timeout_ms, 100, 120000);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = parseNumber(next, out.grid_size, 32, 256);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--strict') {
      out.strict = true;
      continue;
    }
  }

  if (!out.datasets.length) out.datasets = ['fasseg', 'lapa', 'celebamaskhq'];
  out.iterations = Math.max(1, Math.trunc(out.iterations));
  out.warmup = Math.max(0, Math.trunc(out.warmup));
  out.timeout_ms = Math.max(100, Math.trunc(out.timeout_ms));
  out.grid_size = Math.max(32, Math.trunc(out.grid_size));
  return out;
}

async function findImageFromIndex(datasetRoot, maxRows = 300) {
  const indexPath = path.join(datasetRoot, 'dataset_index.jsonl');
  if (!fs.existsSync(indexPath)) return null;
  const text = await fsp.readFile(indexPath, 'utf8');
  const lines = text.split('\n');
  let seen = 0;
  for (const rawLine of lines) {
    if (seen >= maxRows) break;
    const line = rawLine.trim();
    if (!line) continue;
    seen += 1;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    const imageRel = row && typeof row.image_path === 'string' ? row.image_path : '';
    if (!imageRel) continue;
    const candidate = path.resolve(datasetRoot, imageRel);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

async function findAnyImageFile(datasetRoot) {
  const queue = [datasetRoot];
  const imageExt = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
  let visited = 0;
  while (queue.length && visited < 50000) {
    const current = queue.shift();
    visited += 1;
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!imageExt.has(ext)) continue;
      return fullPath;
    }
  }
  return null;
}

async function resolveBenchImage({ cacheDir, datasets, inputImage }) {
  if (inputImage) {
    const resolved = path.resolve(inputImage);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`bench_image_not_found:${inputImage}`);
    }
    return resolved;
  }
  const root = path.resolve(cacheDir);
  for (const dataset of datasets) {
    const datasetDir = path.join(root, dataset);
    if (!fs.existsSync(datasetDir) || !fs.statSync(datasetDir).isDirectory()) continue;
    const versions = (await fsp.readdir(datasetDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(datasetDir, entry.name));
    const versionsWithMtime = await Promise.all(
      versions.map(async (versionPath) => {
        const stat = await fsp.stat(versionPath);
        return { versionPath, mtimeMs: stat.mtimeMs || 0 };
      }),
    );
    versionsWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of versionsWithMtime) {
      const fromIndex = await findImageFromIndex(item.versionPath);
      if (fromIndex) return fromIndex;
      const fallbackImage = await findAnyImageFile(item.versionPath);
      if (fallbackImage) return fallbackImage;
    }
  }
  throw new Error(`bench_image_not_found_in_cache:${cacheDir}`);
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('skinmask_bench_timeout');
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const imagePath = await resolveBenchImage({
    cacheDir: args.cache_dir,
    datasets: args.datasets,
    inputImage: args.input_image,
  });
  const imageBuffer = await fsp.readFile(imagePath);

  const diagnosisInternal = {
    skin_bbox_norm: { x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95 },
    face_crop_margin_scale: 1.2,
  };

  const latencies = [];
  const fallbackCounts = new Map();
  let okCount = 0;
  let failCount = 0;
  let peakRss = process.memoryUsage().rss;
  let totalPositiveRatio = 0;

  const totalRuns = args.warmup + args.iterations;
  for (let i = 0; i < totalRuns; i += 1) {
    const startedAt = process.hrtime.bigint();
    let result = null;
    let fallbackReason = null;
    try {
      result = await withTimeout(
        inferSkinMaskOnFaceCrop({
          imageBuffer,
          diagnosisInternal,
          modelPath: args.onnx,
          gridSize: args.grid_size,
        }),
        args.timeout_ms,
      );
    } catch (error) {
      fallbackReason = error && error.code === 'TIMEOUT' ? 'TIMEOUT' : 'ONNX_FAIL';
      failCount += i >= args.warmup ? 1 : 0;
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    if (i < args.warmup) continue;
    latencies.push(elapsedMs);
    if (result && result.ok) {
      okCount += 1;
      totalPositiveRatio += Number(result.positive_ratio || 0);
    } else if (!fallbackReason) {
      failCount += 1;
      const raw = String(result && result.reason ? result.reason : 'ONNX_FAIL').toUpperCase();
      fallbackReason = raw.includes('TIMEOUT')
        ? 'TIMEOUT'
        : raw.includes('MODEL') || raw.includes('SESSION') || raw.includes('ONNXRUNTIME') || raw.includes('PATH')
          ? 'MODEL_MISSING'
          : 'ONNX_FAIL';
    }
    if (fallbackReason) {
      fallbackCounts.set(fallbackReason, (fallbackCounts.get(fallbackReason) || 0) + 1);
    }
  }

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const mean = latencies.length ? latencies.reduce((acc, value) => acc + value, 0) / latencies.length : 0;
  const avgPositiveRatio = okCount > 0 ? totalPositiveRatio / okCount : 0;
  const runKey = nowKey();

  const summary = {
    schema_version: 'aurora.skinmask.bench.v1',
    run_key: runKey,
    timestamp_utc: new Date().toISOString(),
    iterations: args.iterations,
    warmup: args.warmup,
    timeout_ms: args.timeout_ms,
    grid_size: args.grid_size,
    dataset_scope: args.datasets,
    image_hash_sha1: require('node:crypto').createHash('sha1').update(imageBuffer).digest('hex').slice(0, 16),
    model_path: toPosix(args.onnx),
    latency_ms: {
      mean: round3(mean),
      p50: round3(p50),
      p95: round3(p95),
      p99: round3(p99),
    },
    peak_rss_bytes: peakRss,
    peak_rss_human: humanBytes(peakRss),
    ok_count: okCount,
    fail_count: failCount,
    avg_positive_ratio: round3(avgPositiveRatio),
    fallback_counts: Object.fromEntries(Array.from(fallbackCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
  };

  const reportJsonPath = path.join(reportDir, `bench_skinmask_${runKey}.json`);
  const reportMdPath = path.join(reportDir, `bench_skinmask_${runKey}.md`);
  await fsp.writeFile(reportJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const lines = [
    '# Skinmask ONNX Bench',
    '',
    `- run_key: \`${runKey}\``,
    `- timestamp_utc: \`${summary.timestamp_utc}\``,
    `- iterations: ${args.iterations} (warmup: ${args.warmup})`,
    `- timeout_ms: ${args.timeout_ms}`,
    `- model_path: \`${toPosix(args.onnx)}\``,
    `- latency_ms: p50=${round3(p50)}, p95=${round3(p95)}, p99=${round3(p99)}, mean=${round3(mean)}`,
    `- peak_rss: ${humanBytes(peakRss)} (${peakRss} bytes)`,
    `- ok_count: ${okCount}`,
    `- fail_count: ${failCount}`,
    `- avg_positive_ratio: ${round3(avgPositiveRatio)}`,
    `- fallback_counts: ${JSON.stringify(summary.fallback_counts)}`,
    '',
    '> No overlay images are generated by this benchmark.',
  ];
  await fsp.writeFile(reportMdPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(`skinmask bench complete: ${toPosix(reportMdPath)}`);
  console.log(`p50=${round3(p50)}ms p95=${round3(p95)}ms p99=${round3(p99)}ms peak_rss=${humanBytes(peakRss)}`);
  console.log(JSON.stringify(summary));

  if (args.strict && failCount > 0) {
    process.exitCode = 2;
  }
}

run().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`bench_skinmask_failed: ${message}`);
  process.exitCode = 1;
});
