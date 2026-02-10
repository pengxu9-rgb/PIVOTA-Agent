'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function toPosix(value) {
  return String(value || '').split(path.sep).join('/');
}

function normalizeCacheDirs(cacheDir) {
  const cacheExternalDir = path.resolve(cacheDir || path.join('datasets_cache', 'external'));
  const cacheRootDir = path.basename(cacheExternalDir) === 'external' ? path.dirname(cacheExternalDir) : cacheExternalDir;
  return {
    cacheExternalDir,
    cacheRootDir,
    manifestsDir: path.join(cacheRootDir, 'manifests'),
    derivedGtDir: path.join(cacheRootDir, 'derived_gt'),
  };
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function readJsonl(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
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

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function existsPath(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findLatestVersionDir(datasetDir) {
  const entries = await fsp.readdir(datasetDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry && entry.isDirectory()).map((entry) => path.join(datasetDir, entry.name));
  if (!dirs.length) return null;

  let latest = null;
  let latestMtime = -1;
  for (const dir of dirs) {
    const st = await fsp.stat(dir).catch(() => null);
    if (!st) continue;
    const mtime = Number(st.mtimeMs || 0);
    if (!latest || mtime > latestMtime) {
      latest = dir;
      latestMtime = mtime;
    }
  }
  return latest;
}

async function resolveDatasetFiles({
  dataset,
  repoRoot,
  cacheExternalDir,
  cacheRootDir,
}) {
  const manifestPath = path.join(cacheRootDir, 'manifests', `${dataset}.manifest.json`);
  const manifest = await readJson(manifestPath);

  const datasetRootFromManifest =
    manifest && typeof manifest.extract_rel_path === 'string' && manifest.extract_rel_path.trim()
      ? path.resolve(repoRoot, manifest.extract_rel_path)
      : null;
  const datasetBaseDir = path.join(cacheExternalDir, dataset);
  const datasetRootFallback = await findLatestVersionDir(datasetBaseDir);
  const datasetRoot = datasetRootFromManifest || datasetRootFallback;
  if (!datasetRoot) {
    throw new Error(`dataset_root_not_found:${dataset}`);
  }

  const indexPathFromManifest =
    manifest && typeof manifest.index_rel_path === 'string' && manifest.index_rel_path.trim()
      ? path.resolve(repoRoot, manifest.index_rel_path)
      : null;
  const indexPathFallback = path.join(datasetRoot, 'dataset_index.jsonl');
  const indexPath = indexPathFromManifest || indexPathFallback;
  const hasIndex = await existsPath(indexPath);
  if (!hasIndex) {
    throw new Error(`dataset_index_missing:${dataset}`);
  }

  return {
    manifestPath,
    manifest,
    datasetRoot,
    indexPath,
  };
}

function hashSampleId(dataset, sourceToken) {
  return crypto.createHash('sha256').update(`${dataset}:${String(sourceToken || '')}`).digest('hex').slice(0, 24);
}

function createRng(seedText) {
  const seedHex = crypto.createHash('sha256').update(String(seedText || 'aurora')).digest('hex').slice(0, 16);
  let state = Number.parseInt(seedHex, 16) >>> 0;
  if (!Number.isFinite(state) || state === 0) state = 0x9e3779b9;
  return function rng() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) & 0xffffffff) / 0x100000000;
  };
}

function pickRows(rows, { limit, shuffle = false, seed = 'aurora' } = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (shuffle) {
    const rand = createRng(seed);
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
  }
  const max = Number(limit);
  if (Number.isFinite(max) && max > 0) return list.slice(0, Math.floor(max));
  return list;
}

function sumCounts(rows, predicate) {
  let total = 0;
  for (const row of rows) {
    if (predicate(row)) total += 1;
  }
  return total;
}

function summarizeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    total: list.length,
    with_mask: sumCounts(list, (row) => Boolean(row && (row.mask_path || (Array.isArray(row.mask_paths) && row.mask_paths.length)))),
    with_annotation: sumCounts(list, (row) => Boolean(row && row.annotation_path)),
  };
}

function safeResolveUnder(rootDir, relPath) {
  const resolved = path.resolve(rootDir, String(relPath || ''));
  const normalizedRoot = `${path.resolve(rootDir)}${path.sep}`;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(rootDir)) {
    return null;
  }
  return resolved;
}

function fileLabel(filePath, repoRoot) {
  const rel = path.relative(repoRoot, filePath);
  return toPosix(rel.startsWith('..') ? filePath : rel);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) lines.push(JSON.stringify(row));
  fs.writeFileSync(filePath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(content || ''), 'utf8');
}

module.exports = {
  toPosix,
  normalizeCacheDirs,
  readJson,
  readJsonl,
  ensureDir,
  existsPath,
  resolveDatasetFiles,
  hashSampleId,
  pickRows,
  summarizeRows,
  safeResolveUnder,
  fileLabel,
  writeJson,
  writeJsonl,
  writeText,
};
