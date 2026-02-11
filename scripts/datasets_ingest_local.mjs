#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import fg from 'fast-glob';

const require = createRequire(import.meta.url);
const { normalizeDatasetName, SUPPORTED_DATASETS } = require('./datasets_registry.js');

const HOME_DIR = process.env.HOME || os.homedir() || '';
const DEFAULT_CACHE_DIR = 'datasets_cache';
const DEFAULT_REPORT_DIR = 'reports';
const PREVIEW_BYTES = 96;
const PREFLIGHT_SAMPLE_COUNT = 20;
const PREFLIGHT_FAIL_RATE_MAX = 0.05;
const IMAGE_EXT_RE = /\.(jpg|jpeg|png)$/i;

const DATASET_DEFAULT_ROOTS = Object.freeze({
  lapa: path.join(HOME_DIR, 'Desktop', 'Aurora', 'datasets_raw', 'LaPa DB'),
  celebamaskhq: path.join(
    HOME_DIR,
    'Desktop',
    'Aurora',
    'datasets_raw',
    'CelebAMask-HQ(1)',
    'CelebAMask-HQ',
    'CelebA-HQ-img',
  ),
  fasseg: path.join(HOME_DIR, 'Desktop', 'Aurora', 'datasets_raw', 'FASSEG-DB-v2019'),
  acne04: path.join(HOME_DIR, 'Desktop', 'Aurora', 'datasets_raw', 'ACNE DB'),
});

const PRIORITY_PATTERNS = Object.freeze({
  lapa: [
    {
      name: 'lapa_images_train_val_test_images',
      match: (rel) => /\/images\/(train|val|test)\/images\/[^/]+\.(jpg|jpeg|png)$/i.test(rel),
    },
    {
      name: 'lapa_train_val_test_images',
      match: (rel) => /\/(train|val|test)\/images\/[^/]+\.(jpg|jpeg|png)$/i.test(rel),
    },
  ],
  celebamaskhq: [
    {
      name: 'celeb_hq_img_folder',
      match: (rel) => /\/[^/]*hq[^/]*img[^/]*\/[^/]+\.(jpg|jpeg|png)$/i.test(rel),
    },
    {
      name: 'celeb_celeba_img_folder',
      match: (rel) => /\/[^/]*celeba[^/]*img[^/]*\/[^/]+\.(jpg|jpeg|png)$/i.test(rel),
    },
    {
      name: 'celeb_images_folder',
      match: (rel) => /\/images\/[^/]+\.(jpg|jpeg|png)$/i.test(rel),
    },
  ],
});

const GENERIC_IGNORE_TOKENS = Object.freeze([
  '__macosx',
  '.ds_store',
  '/label/',
  '/labels/',
  '/mask/',
  '/masks/',
  '/anno/',
  '/annotation/',
  '/annotations/',
  '/seg/',
  '/segmentation/',
  '/landmark/',
  '/landmarks/',
]);

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function nowKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}`;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseDatasetList(input) {
  const raw = String(input || 'all').trim().toLowerCase();
  if (!raw || raw === 'all') return [...SUPPORTED_DATASETS];
  const items = raw
    .split(',')
    .map((item) => normalizeDatasetName(item))
    .filter(Boolean);
  const unique = [...new Set(items)];
  for (const dataset of unique) {
    if (!SUPPORTED_DATASETS.includes(dataset)) {
      throw new Error(`unsupported_dataset:${dataset}`);
    }
  }
  return unique;
}

function parseArgs(argv) {
  const out = {
    datasets: process.env.DATASETS || 'all',
    dataset_root: process.env.DATASET_ROOT || '',
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    report_dir: process.env.REPORT_DIR || process.env.EVAL_REPORT_DIR || DEFAULT_REPORT_DIR,
    lapa_root: process.env.LAPA_DIR || '',
    celebamaskhq_root: process.env.CELEBA_DIR || '',
    fasseg_root: process.env.FASSEG_DIR || '',
    acne04_root: process.env.ACNE04_DIR || '',
    preflight_sample: parseNumber(process.env.PREFLIGHT_SAMPLE_COUNT, PREFLIGHT_SAMPLE_COUNT, 1, 200),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--datasets' && next) {
      out.datasets = next;
      i += 1;
      continue;
    }
    if (token === '--dataset_root' && next) {
      out.dataset_root = next;
      i += 1;
      continue;
    }
    if (token === '--cache_dir' && next) {
      out.cache_dir = next;
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = next;
      i += 1;
      continue;
    }
    if (token === '--lapa_root' && next) {
      out.lapa_root = next;
      i += 1;
      continue;
    }
    if (token === '--celebamaskhq_root' && next) {
      out.celebamaskhq_root = next;
      i += 1;
      continue;
    }
    if (token === '--fasseg_root' && next) {
      out.fasseg_root = next;
      i += 1;
      continue;
    }
    if (token === '--acne04_root' && next) {
      out.acne04_root = next;
      i += 1;
      continue;
    }
    if (token === '--preflight_sample' && next) {
      out.preflight_sample = parseNumber(next, out.preflight_sample, 1, 200);
      i += 1;
      continue;
    }
  }
  return out;
}

function inferSplit(relPath) {
  const token = toPosix(relPath).toLowerCase();
  if (/(^|\/)train(\/|$)/.test(token)) return 'train';
  if (/(^|\/)(val|valid|validation)(\/|$)/.test(token)) return 'val';
  if (/(^|\/)test(\/|$)/.test(token)) return 'test';
  return 'unknown';
}

function hasGenericIgnoreToken(relPath) {
  const lower = toPosix(relPath).toLowerCase();
  return GENERIC_IGNORE_TOKENS.some((token) => lower.includes(token));
}

function chooseImageSet(dataset, relImageFiles) {
  const patterns = PRIORITY_PATTERNS[dataset] || [];
  for (const pattern of patterns) {
    const hit = relImageFiles.filter((rel) => pattern.match(`/${toPosix(rel)}`));
    if (hit.length > 0) {
      return {
        scan_mode: `preferred:${pattern.name}`,
        records: hit,
      };
    }
  }

  const generic = relImageFiles.filter((rel) => !hasGenericIgnoreToken(rel));
  const byDir = new Map();
  for (const rel of generic) {
    const dir = toPosix(path.dirname(rel));
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
  }

  let clusterDir = '';
  let clusterCount = 0;
  for (const [dir, count] of byDir.entries()) {
    if (count > clusterCount) {
      clusterDir = dir;
      clusterCount = count;
    }
  }

  if (clusterDir && clusterCount > 0) {
    const clustered = generic.filter((rel) => toPosix(path.dirname(rel)) === clusterDir);
    return {
      scan_mode: `generic_cluster:${clusterDir}`,
      records: clustered,
    };
  }

  return {
    scan_mode: 'generic_all',
    records: generic,
  };
}

function classifyReadError(error) {
  const code = String(error && error.code ? error.code : '').toUpperCase();
  const msg = String(error && error.message ? error.message : error || '').toLowerCase();
  if (code === 'ENOENT') return 'LOCAL_FILE_NOT_FOUND';
  if (
    code === 'EIO' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    msg.includes('operation not permitted') ||
    msg.includes('not downloaded') ||
    msg.includes('cloud') ||
    msg.includes('i/o') ||
    msg.includes('resource busy')
  ) {
    return 'LOCAL_FILE_NOT_READY';
  }
  return 'READ_FAIL';
}

async function preflightRead(indexRows, cacheDatasetDir, sampleCount) {
  const selected = [...indexRows]
    .sort((a, b) => String(a.sample_id || '').localeCompare(String(b.sample_id || '')))
    .slice(0, Math.min(sampleCount, indexRows.length));

  const failures = [];
  for (const row of selected) {
    const rel = String(row && row.image_path ? row.image_path : '');
    const abs = path.resolve(cacheDatasetDir, rel);
    try {
      const fd = await fsp.open(abs, 'r');
      try {
        await fd.read(Buffer.alloc(PREVIEW_BYTES), 0, PREVIEW_BYTES, 0);
      } finally {
        await fd.close();
      }
    } catch (error) {
      failures.push({
        reason: classifyReadError(error),
        path: rel,
        message: String(error && error.message ? error.message : error).slice(0, 180),
      });
    }
  }

  return {
    checked: selected.length,
    failed: failures.length,
    fail_rate: selected.length ? failures.length / selected.length : 0,
    failures,
  };
}

async function ensureSymlink(cacheDatasetDir, sourceRoot) {
  const linkPath = path.join(cacheDatasetDir, 'source_root');
  await fsp.mkdir(cacheDatasetDir, { recursive: true });
  const current = await fsp.lstat(linkPath).catch(() => null);
  if (current) {
    await fsp.rm(linkPath, { recursive: true, force: true });
  }
  await fsp.symlink(path.resolve(sourceRoot), linkPath);
}

function resolveDatasetRoot(dataset, args, datasets) {
  if (args.dataset_root) {
    if (datasets.length !== 1) {
      throw new Error('dataset_root_requires_single_dataset');
    }
    return path.resolve(args.dataset_root);
  }
  const explicit = args[`${dataset}_root`];
  if (explicit) return path.resolve(explicit);
  return path.resolve(DATASET_DEFAULT_ROOTS[dataset] || '');
}

async function ingestDataset({ dataset, rootDir, cacheRoot, preflightSample }) {
  const stat = await fsp.stat(rootDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return {
      dataset,
      ok: false,
      status: 'FAIL',
      root: rootDir,
      message: 'DATASET_ROOT_NOT_FOUND',
      records: 0,
      preflight: null,
      scan_mode: '-',
      sample_errors: [],
    };
  }

  const relImageFiles = (await fg('**/*.{jpg,jpeg,png}', {
    cwd: rootDir,
    onlyFiles: true,
    dot: false,
    unique: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  }))
    .map((rel) => toPosix(rel))
    .filter((rel) => IMAGE_EXT_RE.test(rel))
    .sort((a, b) => a.localeCompare(b));

  const chosen = chooseImageSet(dataset, relImageFiles);
  const cacheDatasetDir = path.join(cacheRoot, dataset);
  await ensureSymlink(cacheDatasetDir, rootDir);

  const rows = chosen.records.map((rel) => {
    const imagePath = `source_root/${rel}`;
    if (/^https?:\/\//i.test(imagePath)) {
      throw new Error(`invalid_http_image_path:${dataset}:${imagePath}`);
    }
    return {
      dataset,
      split: inferSplit(rel),
      sample_id: sha256Hex(`${dataset}:${rel}`).slice(0, 24),
      image_path: imagePath,
      source_root: path.resolve(rootDir),
    };
  });

  const indexPath = path.join(cacheDatasetDir, 'index.jsonl');
  const payload = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  await fsp.writeFile(indexPath, payload, 'utf8');

  const preflight = await preflightRead(rows, cacheDatasetDir, preflightSample);
  const sampleErrors = preflight.failures.slice(0, 5);
  const preflightFailed = preflight.checked > 0 && preflight.fail_rate > PREFLIGHT_FAIL_RATE_MAX;

  return {
    dataset,
    ok: !preflightFailed,
    status: preflightFailed ? 'FAIL' : 'PASS',
    root: rootDir,
    records: rows.length,
    scan_mode: chosen.scan_mode,
    index_path: toPosix(path.relative(process.cwd(), indexPath)),
    preflight,
    sample_errors: sampleErrors,
    message: preflightFailed
      ? `PREFLIGHT_FAIL_RATE_GT_${PREFLIGHT_FAIL_RATE_MAX}`
      : 'OK',
  };
}

function buildReport({ runAtIso, runId, cacheRoot, datasets, rows }) {
  const lines = [];
  lines.push('# Local Dataset Ingest Report');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${runAtIso}`);
  lines.push(`- datasets: ${datasets.join(', ')}`);
  lines.push(`- cache_root: ${toPosix(path.relative(process.cwd(), cacheRoot))}`);
  lines.push('');
  lines.push('| dataset | status | records | scan_mode | preflight_fail_rate | index_path | message |');
  lines.push('|---|---|---:|---|---:|---|---|');
  for (const row of rows) {
    const failRate = row.preflight ? (row.preflight.fail_rate * 100) : 0;
    lines.push(
      `| ${row.dataset} | ${row.status} | ${row.records || 0} | ${row.scan_mode || '-'} | ${row.preflight ? failRate.toFixed(1) : '0.0'}% | ${row.index_path || '-'} | ${row.message || '-'} |`,
    );
  }
  lines.push('');
  lines.push('## Preflight Sample Errors (Top 5 per dataset)');
  lines.push('');
  lines.push('| dataset | reason_detail | image_path | message |');
  lines.push('|---|---|---|---|');
  let emitted = 0;
  for (const row of rows) {
    for (const error of row.sample_errors || []) {
      emitted += 1;
      lines.push(`| ${row.dataset} | ${error.reason} | ${error.path} | ${error.message} |`);
    }
  }
  if (!emitted) {
    lines.push('| - | - | - | - |');
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Index rows contain local relative `image_path` and `source_root` only (no URLs).');
  lines.push('- If reason_detail is `LOCAL_FILE_NOT_READY`, run “Download Now” in Finder for the dataset folder.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasets = parseDatasetList(args.datasets);
  const runId = nowKey();
  const runAtIso = new Date().toISOString();
  const cacheRoot = path.resolve(args.cache_dir);
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.mkdir(reportDir, { recursive: true });

  const rows = [];
  let hasFail = false;
  for (const dataset of datasets) {
    const rootDir = resolveDatasetRoot(dataset, args, datasets);
    const result = await ingestDataset({
      dataset,
      rootDir,
      cacheRoot,
      preflightSample: args.preflight_sample,
    });
    rows.push(result);
    if (!result.ok) hasFail = true;
  }

  const reportPath = path.join(reportDir, `datasets_ingest_local_${runId}.md`);
  const md = buildReport({
    runAtIso,
    runId,
    cacheRoot,
    datasets,
    rows,
  });
  await fsp.writeFile(reportPath, md, 'utf8');

  const payload = {
    ok: !hasFail,
    run_id: runId,
    datasets,
    report: toPosix(path.relative(process.cwd(), reportPath)),
    rows: rows.map((row) => ({
      dataset: row.dataset,
      status: row.status,
      records: row.records || 0,
      scan_mode: row.scan_mode || '-',
      preflight_fail_rate: row.preflight ? Number((row.preflight.fail_rate || 0).toFixed(4)) : 0,
      index_path: row.index_path || '',
      message: row.message || '',
    })),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);

  if (hasFail) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
