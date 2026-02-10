#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

import { normalizeDatasetName, SUPPORTED_DATASETS } from './datasets_registry.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.heic', '.heif', '.tif', '.tiff']);
const ZIP_EXTENSIONS = new Set(['.zip']);
const ANNO_EXTENSIONS = new Set(['.json', '.txt', '.xml', '.csv']);

const DEFAULT_RAW_DIR = path.join(os.homedir(), 'Desktop', 'datasets_raw');
const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const REPORTS_DIR = 'reports';

const DATASET_SPECS = Object.freeze({
  lapa: {
    aliases: [/lapa/i],
    class_list: ['background', 'skin', 'left_eyebrow', 'right_eyebrow', 'left_eye', 'right_eye', 'nose', 'upper_lip', 'inner_mouth', 'lower_lip', 'hair'],
  },
  celebamaskhq: {
    aliases: [/celeb.*mask.*hq/i, /celebamaskhq/i],
    class_list: ['skin', 'nose', 'eye_g', 'l_eye', 'r_eye', 'l_brow', 'r_brow', 'l_ear', 'r_ear', 'mouth', 'u_lip', 'l_lip', 'hair', 'hat', 'ear_r', 'neck_l', 'neck', 'cloth'],
  },
  fasseg: {
    aliases: [/fasseg/i],
    class_list: ['background', 'skin', 'hair', 'beard', 'sunglasses', 'other'],
  },
  acne04: {
    aliases: [/acne[-_ ]?0?4/i, /acne04/i],
    class_list: ['lesion_bbox', 'lesion_points'],
  },
});

function toPosix(inputPath) {
  return String(inputPath || '').split(path.sep).join('/');
}

function nowTimestamp() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}`;
}

function parseArgs(argv) {
  const out = {
    raw_dir: process.env.RAW_DIR || DEFAULT_RAW_DIR,
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    datasets: 'all',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--raw_dir' && next) {
      out.raw_dir = next;
      i += 1;
      continue;
    }
    if (token === '--cache_dir' && next) {
      out.cache_dir = next;
      i += 1;
      continue;
    }
    if (token === '--datasets' && next) {
      out.datasets = next;
      i += 1;
    }
  }
  return out;
}

function parseDatasets(input) {
  const token = String(input || 'all').trim().toLowerCase();
  if (!token || token === 'all') return [...SUPPORTED_DATASETS];
  const items = token.split(',').map((part) => normalizeDatasetName(part)).filter(Boolean);
  const unique = [...new Set(items)];
  for (const item of unique) {
    if (!SUPPORTED_DATASETS.includes(item)) {
      throw new Error(`unsupported_dataset:${item}`);
    }
  }
  return unique;
}

async function walkFiles(rootDir) {
  const out = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(full);
    }
  }
  await walk(rootDir);
  return out;
}

async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sanitizeZipEntry(entryPath) {
  const normalized = path.posix.normalize(String(entryPath || ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.isAbsolute(normalized)) return null;
  return normalized;
}

async function unzipWithLibrary(zipPath, outDir) {
  const { default: unzipper } = await import('unzipper');
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    const safeRel = sanitizeZipEntry(entry.path);
    if (!safeRel) continue;
    const destPath = path.join(outDir, safeRel);
    if (entry.type === 'Directory') {
      await fsp.mkdir(destPath, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(destPath));
  }
}

async function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code) => {
      resolve({
        code: Number.isFinite(code) ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.on('error', (error) => {
      resolve({ code: 1, stdout: '', stderr: String(error && error.message ? error.message : error) });
    });
  });
}

async function unzipWithFallback(zipPath, outDir) {
  const result = await runCommand('unzip', ['-oq', zipPath, '-d', outDir]);
  if (result.code !== 0) {
    throw new Error(`unzip_failed:${result.stderr || result.stdout || result.code}`);
  }
}

function splitFromPath(relPath) {
  const token = toPosix(relPath).toLowerCase();
  if (token.includes('/train/') || token.includes('train_')) return 'train';
  if (token.includes('/val/') || token.includes('/valid/') || token.includes('val_')) return 'val';
  if (token.includes('/test/') || token.includes('test_')) return 'test';
  return 'unknown';
}

function stemKey(relPath) {
  const stem = path.basename(relPath, path.extname(relPath)).toLowerCase();
  return stem
    .replace(/[_-]?(mask|seg|segmentation|label|labels|anno|annotation|parsing|gt)$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function sampleIdFor(dataset, relImagePath) {
  return crypto.createHash('sha256').update(`${dataset}:${toPosix(relImagePath)}`).digest('hex').slice(0, 24);
}

function relFromRoot(rootDir, filePath) {
  const rel = path.relative(rootDir, filePath);
  return toPosix(rel);
}

function mapByKey(paths) {
  const out = new Map();
  for (const rel of paths) {
    const key = stemKey(rel);
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(rel);
  }
  return out;
}

function buildCelebAMaskPartMap(maskPaths) {
  const partMap = new Map();
  for (const rel of maskPaths) {
    const base = path.basename(rel, path.extname(rel));
    const match = base.match(/^(\d+)_([a-z0-9_]+)$/i);
    if (!match) continue;
    const id = String(Number(match[1]));
    const part = String(match[2] || '').toLowerCase();
    if (!partMap.has(id)) partMap.set(id, []);
    partMap.get(id).push({ part, path: rel });
  }
  return partMap;
}

function buildDatasetIndex(dataset, relFiles) {
  const imagePaths = relFiles.filter((rel) => IMAGE_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  const maskLikePaths = relFiles.filter((rel) => {
    const ext = path.extname(rel).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return false;
    const low = rel.toLowerCase();
    return /mask|label|seg|parsing|anno/.test(low);
  });
  const annoPaths = relFiles.filter((rel) => ANNO_EXTENSIONS.has(path.extname(rel).toLowerCase()) && /anno|label|bbox|acne|lesion/i.test(rel));

  const imageCandidates = imagePaths.filter((rel) => !maskLikePaths.includes(rel));
  const rows = [];

  if (dataset === 'celebamaskhq') {
    const partMap = buildCelebAMaskPartMap(maskLikePaths);
    for (const imageRel of imageCandidates) {
      const idMatch = path.basename(imageRel, path.extname(imageRel)).match(/(\d+)/);
      const imageId = idMatch ? String(Number(idMatch[1])) : stemKey(imageRel);
      const parts = partMap.get(imageId) || [];
      rows.push({
        dataset,
        sample_id: sampleIdFor(dataset, imageRel),
        image_path: imageRel,
        split: splitFromPath(imageRel),
        mask_paths: parts,
        meta: {
          source: 'dataset_prepare',
          part_count: parts.length,
        },
      });
    }
    return rows;
  }

  const maskMap = mapByKey(maskLikePaths);
  const annoMap = mapByKey(annoPaths);
  for (const imageRel of imageCandidates) {
    const key = stemKey(imageRel);
    const masks = maskMap.get(key) || [];
    const annos = annoMap.get(key) || [];
    rows.push({
      dataset,
      sample_id: sampleIdFor(dataset, imageRel),
      image_path: imageRel,
      split: splitFromPath(imageRel),
      ...(masks[0] ? { mask_path: masks[0] } : {}),
      ...(annos[0] ? { annotation_path: annos[0] } : {}),
      meta: {
        source: 'dataset_prepare',
        mask_candidates: masks.length,
        annotation_candidates: annos.length,
      },
    });
  }
  return rows;
}

function summarizeSplits(rows) {
  const out = {};
  for (const row of rows) {
    const split = String(row && row.split ? row.split : 'unknown');
    out[split] = (out[split] || 0) + 1;
  }
  return out;
}

function summarizeStructure(rows) {
  let maskCount = 0;
  let annoCount = 0;
  for (const row of rows) {
    if (row && row.mask_path) maskCount += 1;
    if (row && Array.isArray(row.mask_paths) && row.mask_paths.length) maskCount += 1;
    if (row && row.annotation_path) annoCount += 1;
  }
  return {
    images: rows.length,
    masks: maskCount,
    annotations: annoCount,
  };
}

async function writeJsonl(filePath, rows) {
  const payload = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  await fsp.writeFile(filePath, payload, 'utf8');
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function datasetSpec(dataset) {
  return DATASET_SPECS[dataset] || { aliases: [new RegExp(dataset, 'i')], class_list: [] };
}

function findZipForDataset(dataset, zipFiles) {
  const spec = datasetSpec(dataset);
  const hits = zipFiles
    .filter((zipPath) => spec.aliases.some((pattern) => pattern.test(path.basename(zipPath))))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  if (!hits.length) return null;
  return hits[hits.length - 1];
}

function relPathForReport(rootDir, targetPath) {
  const rel = path.relative(rootDir, targetPath);
  return toPosix(rel.startsWith('..') ? targetPath : rel);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasets = parseDatasets(args.datasets);
  const rawDir = path.resolve(args.raw_dir);
  const cacheExternalDir = path.resolve(args.cache_dir);
  const cacheRootDir = path.basename(cacheExternalDir) === 'external'
    ? path.dirname(cacheExternalDir)
    : cacheExternalDir;
  const manifestsDir = path.join(cacheRootDir, 'manifests');
  const repoRoot = process.cwd();

  const preparedAt = new Date().toISOString();
  const reportTimeKey = nowTimestamp();
  const reportFile = path.join(REPORTS_DIR, `datasets_prepare_${reportTimeKey}.md`);

  await ensureDir(cacheExternalDir);
  await ensureDir(manifestsDir);
  await ensureDir(REPORTS_DIR);

  const rawStat = await fsp.stat(rawDir).catch(() => null);
  if (!rawStat || !rawStat.isDirectory()) {
    throw new Error(`raw_dir_not_found:${rawDir}`);
  }

  const rawFiles = await walkFiles(rawDir);
  const zipFiles = rawFiles.filter((filePath) => ZIP_EXTENSIONS.has(path.extname(filePath).toLowerCase()));

  const reportRows = [];
  let hasFailure = false;

  for (const dataset of datasets) {
    const zipPath = findZipForDataset(dataset, zipFiles);
    if (!zipPath) {
      hasFailure = true;
      reportRows.push({
        dataset,
        status: 'FAIL',
        message: 'zip_not_found',
      });
      continue;
    }

    const zipStat = await fsp.stat(zipPath);
    const zipSha256 = await hashFileSha256(zipPath);
    const versionKey = `${path.basename(zipPath, '.zip').replace(/[^a-zA-Z0-9._-]+/g, '_')}_${zipSha256.slice(0, 8)}`;
    const extractDir = path.join(cacheExternalDir, dataset, versionKey);
    const indexFile = path.join(extractDir, 'dataset_index.jsonl');

    await ensureDir(extractDir);

    let unzipMode = 'skip_existing';
    const indexExists = await fsp.stat(indexFile).then(() => true).catch(() => false);
    if (!indexExists) {
      try {
        await unzipWithLibrary(zipPath, extractDir);
        unzipMode = 'node_unzipper';
      } catch (err) {
        await unzipWithFallback(zipPath, extractDir);
        unzipMode = `fallback_unzip:${String(err && err.message ? err.message : err).slice(0, 160)}`;
      }
    }

    const extractedFiles = await walkFiles(extractDir);
    const relFiles = extractedFiles
      .map((filePath) => relFromRoot(extractDir, filePath))
      .filter((rel) => rel !== 'dataset_index.jsonl')
      .sort((a, b) => a.localeCompare(b));

    const rows = buildDatasetIndex(dataset, relFiles);
    await writeJsonl(indexFile, rows);

    const spec = datasetSpec(dataset);
    const manifest = {
      schema_version: 'aurora.external_dataset_manifest.v1',
      dataset,
      prepared_at: preparedAt,
      raw_zip: {
        file_name: path.basename(zipPath),
        size_bytes: Number(zipStat.size || 0),
        sha256: zipSha256,
        mtime_ms: Number(zipStat.mtimeMs || 0),
      },
      extract_rel_path: toPosix(path.relative(repoRoot, extractDir)),
      index_rel_path: toPosix(path.relative(repoRoot, indexFile)),
      record_count: rows.length,
      splits: summarizeSplits(rows),
      class_list: spec.class_list,
      structure: summarizeStructure(rows),
      unzip_mode: unzipMode,
    };

    const manifestPath = path.join(manifestsDir, `${dataset}.manifest.json`);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    reportRows.push({
      dataset,
      status: rows.length > 0 ? 'PASS' : 'WARN',
      zip_file: path.basename(zipPath),
      zip_sha256_12: zipSha256.slice(0, 12),
      records: rows.length,
      structure: manifest.structure,
      splits: manifest.splits,
      class_count: Array.isArray(spec.class_list) ? spec.class_list.length : 0,
      manifest: relPathForReport(repoRoot, manifestPath),
      index: relPathForReport(repoRoot, indexFile),
      unzip_mode: unzipMode,
    });
  }

  const lines = [];
  lines.push('# External Datasets Prepare Report');
  lines.push('');
  lines.push(`- prepared_at: ${preparedAt}`);
  lines.push(`- raw_dir: ${path.basename(rawDir)}`);
  lines.push(`- cache_root: ${toPosix(path.relative(repoRoot, cacheRootDir))}`);
  lines.push(`- datasets: ${datasets.join(', ')}`);
  lines.push('');
  lines.push('| dataset | status | zip | sha256(12) | records | images/masks/annos | class_count | split_summary | unzip_mode |');
  lines.push('|---|---:|---|---|---:|---|---:|---|---|');
  for (const row of reportRows) {
    if (row.status === 'FAIL') {
      lines.push(`| ${row.dataset} | FAIL | - | - | 0 | - | 0 | - | ${row.message} |`);
      continue;
    }
    const struct = row.structure || {};
    const splits = Object.entries(row.splits || {}).map(([k, v]) => `${k}:${v}`).join(', ');
    lines.push(
      `| ${row.dataset} | ${row.status} | ${row.zip_file} | ${row.zip_sha256_12} | ${row.records} | ${struct.images || 0}/${struct.masks || 0}/${struct.annotations || 0} | ${row.class_count} | ${splits || '-'} | ${row.unzip_mode} |`,
    );
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Report excludes absolute filesystem paths.');
  lines.push('- Raw images remain in cache only; no dataset files are committed.');
  lines.push('- Generated files: `datasets_cache/manifests/*.manifest.json`, per-dataset `dataset_index.jsonl`.');
  lines.push('');

  await fsp.writeFile(reportFile, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${reportFile}`);

  if (hasFailure) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
