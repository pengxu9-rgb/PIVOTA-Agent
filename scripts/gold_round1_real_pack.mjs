#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey, sha256Hex } from './internal_batch_helpers.mjs';
import { readJsonlRows, resolvePackImage, toPosix } from './local_image_loader.mjs';

const DEFAULT_LIMIT = 200;
const DEFAULT_BUCKET_N = 60;
const DEFAULT_SEED = 'gold_round1_real_seed_v1';
const DEFAULT_INTERNAL_LIMIT = 38;
const DEFAULT_DOUBLE_ANNOTATE_RATIO = 0.1;

const HELP_TEXT = `gold_round1_real_pack.mjs

Usage:
  node scripts/gold_round1_real_pack.mjs --review_in <review_pack_mixed.jsonl|csv> [options]

Required:
  --review_in <path>              review_pack_mixed input file (.jsonl/.ndjson/.csv)

Optional:
  --run_id <id>                   output run_id (default: infer from review filename)
  --out <dir>                     output directory (default: artifacts/gold_round1_real_<run_id>)
  --limit <n>                     total target sample count (default: 200)
  --bucket_n <n>                  per-bucket count for each external source (default: 60)
  --seed <token>                  sampling seed (default: gold_round1_real_seed_v1)
  --limit_internal <n>            max internal samples (default: 38)
  --double_annotate_ratio <0-1>   fraction of selected set marked for double annotation (default: 0.1)
  --include_non_local_ok <bool>   include ok rows where pipeline_mode_used != local (default: false)
  --internal_dir <path>           internal images root
  --cache_dir <path>              datasets cache root
  --lapa_dir <path>               LaPa images root
  --celeba_dir <path>             CelebAMaskHQ images root
  --help                          show help
`;

function parseNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === ',') {
      values.push(current);
      current = '';
    } else if (ch === '"') {
      quoted = true;
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

async function readReviewRows(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return readJsonlRows(inputPath);
  if (ext !== '.csv') {
    throw new Error(`unsupported_review_input:${ext || 'unknown'}`);
  }
  const text = await fsp.readFile(inputPath, 'utf8');
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      const key = headers[j];
      const value = values[j] == null ? '' : values[j];
      row[key] = value;
    }
    rows.push(row);
  }
  return rows;
}

function parseArgs(argv) {
  const home = process.env.HOME || '';
  const out = {
    help: 'false',
    run_id: process.env.RUN_ID || '',
    review_in: process.env.REVIEW_JSONL || process.env.REVIEW_IN || '',
    out: process.env.OUT || '',
    limit: process.env.LIMIT || DEFAULT_LIMIT,
    bucket_n: process.env.BUCKET_N || DEFAULT_BUCKET_N,
    seed: process.env.GOLD_ROUND1_REAL_SEED || process.env.GOLD_ROUND1_SEED || DEFAULT_SEED,
    limit_internal: process.env.LIMIT_INTERNAL || DEFAULT_INTERNAL_LIMIT,
    double_annotate_ratio: process.env.DOUBLE_ANNOTATE_RATIO || DEFAULT_DOUBLE_ANNOTATE_RATIO,
    include_non_local_ok: process.env.GOLD_ROUND1_REAL_INCLUDE_NON_LOCAL_OK || 'false',
    internal_dir: process.env.INTERNAL_DIR || path.join(home, 'Desktop', 'Aurora', 'internal test photos'),
    cache_dir: process.env.CACHE_DIR || path.join('datasets_cache', 'external'),
    lapa_dir: process.env.LAPA_DIR || path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'LaPa DB'),
    celeba_dir:
      process.env.CELEBA_DIR
      || path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'CelebAMask-HQ(1)', 'CelebAMask-HQ', 'CelebA-HQ-img'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'help' || key === 'h') {
      out.help = 'true';
      continue;
    }
    if (!(key in out)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    i += 1;
  }

  out.run_id = String(out.run_id || '').trim();
  out.review_in = String(out.review_in || '').trim();
  out.out = String(out.out || '').trim();
  out.limit = parseNumber(out.limit, DEFAULT_LIMIT, 1, 5000);
  out.bucket_n = parseNumber(out.bucket_n, DEFAULT_BUCKET_N, 1, 1000);
  out.limit_internal = parseNumber(out.limit_internal, DEFAULT_INTERNAL_LIMIT, 0, 1000);
  out.double_annotate_ratio = Math.max(0, Math.min(1, Number(out.double_annotate_ratio) || DEFAULT_DOUBLE_ANNOTATE_RATIO));
  out.seed = String(out.seed || '').trim() || DEFAULT_SEED;
  out.include_non_local_ok = parseBool(out.include_non_local_ok, false);
  out.internal_dir = String(out.internal_dir || '').trim();
  out.cache_dir = String(out.cache_dir || '').trim();
  out.lapa_dir = String(out.lapa_dir || '').trim();
  out.celeba_dir = String(out.celeba_dir || '').trim();
  out.help = parseBool(out.help, false);
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  const token = path.basename(String(args.review_in || ''));
  const match = token.match(/review_pack_mixed_(\d{15}|\d{8}_\d{6,9})\.(jsonl|ndjson|csv)$/i);
  if (match) return match[1];
  return runTimestampKey();
}

function sourceToken(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return 'unknown';
  if (token === 'celeba' || token === 'celeb' || token === 'celebamask') return 'celebamaskhq';
  return token;
}

function normalizeBoolLike(raw, fallback = false) {
  const token = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!token) return fallback;
  if (['true', '1', 'yes', 'y'].includes(token)) return true;
  if (['false', '0', 'no', 'n'].includes(token)) return false;
  return fallback;
}

function normalizeReviewRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = sourceToken(raw.source || raw.dataset);
  const sampleHash = String(raw.sample_hash || '').trim();
  const imagePathRel = String(raw.image_path_rel || '').trim();
  if (!source || !sampleHash || !imagePathRel) return null;
  const guardedRaw = raw.guarded_modules;
  const guardedModules = Array.isArray(guardedRaw)
    ? guardedRaw.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : String(guardedRaw || '')
      .split('|')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  const minPixels = Number(raw.min_module_pixels ?? raw.module_pixels_min);
  const risk = Number(raw.risk_score);
  return {
    raw,
    source,
    sample_hash: sampleHash,
    image_path_rel: imagePathRel,
    ok: normalizeBoolLike(raw.ok, false),
    pipeline_mode_used: String(raw.pipeline_mode_used || '').trim().toLowerCase(),
    risk_score: Number.isFinite(risk) ? risk : 0,
    min_module_pixels: Number.isFinite(minPixels) ? Math.max(0, Math.trunc(minPixels)) : 0,
    min_module_id: String(raw.min_module_id || '').trim() || 'unknown',
    module_guard_triggered: normalizeBoolLike(raw.module_guard_triggered, false) || guardedModules.length > 0,
    guarded_modules: guardedModules,
    fail_reason: String(raw.fail_reason || '').trim() || null,
    reason_detail: String(raw.reason_detail || '').trim() || null,
  };
}

function isLocalOkRow(row, includeNonLocalOk) {
  if (!row || typeof row !== 'object') return false;
  if (!row.ok) return false;
  if (!includeNonLocalOk && row.pipeline_mode_used && row.pipeline_mode_used !== 'local') return false;
  if (!row.sample_hash || !row.image_path_rel) return false;
  if (/^https?:\/\//i.test(row.image_path_rel)) return false;
  return true;
}

function seededSort(items, seed, tokenFn) {
  return [...items].sort((left, right) => {
    const leftToken = tokenFn(left);
    const rightToken = tokenFn(right);
    const leftKey = sha256Hex(`${seed}:${leftToken}`);
    const rightKey = sha256Hex(`${seed}:${rightToken}`);
    if (leftKey === rightKey) return String(leftToken).localeCompare(String(rightToken));
    return leftKey.localeCompare(rightKey);
  });
}

function sortedTopRisk(rows) {
  return [...rows].sort((a, b) => b.risk_score - a.risk_score || a.sample_hash.localeCompare(b.sample_hash));
}

function sortedLowMinPixels(rows) {
  return [...rows].sort((a, b) => a.min_module_pixels - b.min_module_pixels || b.risk_score - a.risk_score || a.sample_hash.localeCompare(b.sample_hash));
}

function sortedGuardTriggered(rows) {
  return [...rows]
    .filter((row) => row.module_guard_triggered)
    .sort((a, b) => b.risk_score - a.risk_score || a.min_module_pixels - b.min_module_pixels || a.sample_hash.localeCompare(b.sample_hash));
}

function pickWithBucket(rows, count, bucket, bucketOrder, seed) {
  const selected = [];
  const dedup = new Set();
  const randomized = seededSort(rows, `${seed}:${bucket}`, (row) => `${row.source}:${row.sample_hash}`);
  const stable = randomized.sort((a, b) => {
    if (bucket === 'top_risk') {
      return b.risk_score - a.risk_score || a.sample_hash.localeCompare(b.sample_hash);
    }
    if (bucket === 'low_min_pixels') {
      return a.min_module_pixels - b.min_module_pixels || b.risk_score - a.risk_score || a.sample_hash.localeCompare(b.sample_hash);
    }
    return b.risk_score - a.risk_score || a.min_module_pixels - b.min_module_pixels || a.sample_hash.localeCompare(b.sample_hash);
  });
  for (const row of stable) {
    const key = `${row.source}:${row.sample_hash}`;
    if (dedup.has(key)) continue;
    dedup.add(key);
    selected.push({
      ...row,
      selected_bucket: bucket,
      bucket_order: bucketOrder,
    });
    if (selected.length >= count) break;
  }
  return selected;
}

function mergeSelections(rowsByPriority) {
  const out = [];
  const byKey = new Map();
  for (const rows of rowsByPriority) {
    for (const row of rows) {
      const key = `${row.source}:${row.sample_hash}`;
      const existing = byKey.get(key);
      if (!existing) {
        const next = {
          ...row,
          selected_buckets: [row.selected_bucket],
        };
        byKey.set(key, next);
        out.push(next);
      } else if (!existing.selected_buckets.includes(row.selected_bucket)) {
        existing.selected_buckets.push(row.selected_bucket);
      }
    }
  }
  return out;
}

function sourceBalancedOrder(externalRows, seed) {
  const sources = ['lapa', 'celebamaskhq'];
  const bucketOrder = ['top_risk', 'low_min_pixels', 'guard_triggered'];
  const pools = new Map();
  for (const source of sources) {
    const sourceRows = externalRows.filter((row) => row.source === source);
    for (const bucket of bucketOrder) {
      const key = `${source}:${bucket}`;
      const subset = sourceRows.filter((row) => row.selected_buckets.includes(bucket));
      pools.set(
        key,
        seededSort(subset, `${seed}:${source}:${bucket}:order`, (row) => row.sample_hash).sort((a, b) => {
          if (bucket === 'top_risk') return b.risk_score - a.risk_score || a.sample_hash.localeCompare(b.sample_hash);
          if (bucket === 'low_min_pixels') return a.min_module_pixels - b.min_module_pixels || b.risk_score - a.risk_score || a.sample_hash.localeCompare(b.sample_hash);
          return b.risk_score - a.risk_score || a.sample_hash.localeCompare(b.sample_hash);
        }),
      );
    }
  }

  const used = new Set();
  const ordered = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const bucket of bucketOrder) {
      for (const source of sources) {
        const key = `${source}:${bucket}`;
        const queue = pools.get(key) || [];
        while (queue.length) {
          const candidate = queue.shift();
          const candidateKey = `${candidate.source}:${candidate.sample_hash}`;
          if (used.has(candidateKey)) continue;
          used.add(candidateKey);
          ordered.push(candidate);
          progressed = true;
          break;
        }
      }
    }
  }
  return ordered;
}

function pickDoubleAnnotateKeys(rows, ratio, seed) {
  const candidates = rows.filter((row) => {
    const buckets = Array.isArray(row.selected_buckets) ? row.selected_buckets : [];
    return buckets.includes('top_risk') || buckets.includes('low_min_pixels');
  });
  if (!candidates.length || ratio <= 0) return new Set();
  const target = Math.max(1, Math.round(rows.length * ratio));
  const picked = seededSort(candidates, `${seed}:double_annotate`, (row) => `${row.source}:${row.sample_hash}`)
    .slice(0, Math.min(candidates.length, target));
  return new Set(picked.map((row) => `${row.source}:${row.sample_hash}`));
}

async function resolveRowPath(row, args) {
  const direct = await resolvePackImage({
    source: row.source,
    imagePathRel: row.image_path_rel,
    internalDir: args.internal_dir,
    cacheDir: args.cache_dir,
  });
  if (direct) return direct;
  const rel = String(row.image_path_rel || '').trim();
  if (!rel || /^https?:\/\//i.test(rel)) return null;
  if (row.source === 'lapa') {
    const candidate = path.resolve(args.lapa_dir, rel);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat && stat.isFile()) return candidate;
  }
  if (row.source === 'celebamaskhq') {
    const candidate = path.resolve(args.celeba_dir, rel);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat && stat.isFile()) return candidate;
  }
  return null;
}

function bucketStats(rows) {
  const stats = new Map();
  for (const row of rows) {
    for (const bucket of row.selected_buckets || []) {
      const key = `${row.source}:${bucket}`;
      stats.set(key, Number(stats.get(key) || 0) + 1);
    }
  }
  return Array.from(stats.entries())
    .map(([key, count]) => {
      const [source, bucket] = key.split(':');
      return { source, bucket, count };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.bucket.localeCompare(b.bucket));
}

function renderPreview({ runId, reviewIn, seed, limit, rows, excluded }) {
  const lines = [];
  lines.push('# Gold Round1 Real Pack Preview');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- review_input: \`${toPosix(path.relative(process.cwd(), reviewIn))}\``);
  lines.push(`- seed: ${seed}`);
  lines.push(`- limit: ${limit}`);
  lines.push(`- selected: ${rows.length}`);
  lines.push(`- double_annotate_selected: ${rows.filter((row) => row.double_annotate).length}`);
  lines.push(`- excluded_missing_image: ${excluded.length}`);
  lines.push('');
  lines.push('## Bucket Stats');
  lines.push('');
  lines.push('| source | bucket | count |');
  lines.push('|---|---|---:|');
  for (const row of bucketStats(rows)) {
    lines.push(`| ${row.source} | ${row.bucket} | ${row.count} |`);
  }
  if (!rows.length) lines.push('| - | - | 0 |');
  lines.push('');
  lines.push('## Selected Rows');
  lines.push('');
  lines.push('| rank | source | sample_hash | buckets | double_annotate | risk_score | min_module_id | min_module_pixels | guard_triggered | image_path |');
  lines.push('|---:|---|---|---|---|---:|---|---:|---|---|');
  rows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.source} | ${row.sample_hash} | ${(row.selected_buckets || []).join('+') || '-'} | ${row.double_annotate ? 'true' : 'false'} | ${round3(row.risk_score) ?? '-'} | ${row.min_module_id || '-'} | ${row.min_module_pixels ?? '-'} | ${row.module_guard_triggered ? 'true' : 'false'} | ${toPosix(row.image_path || '-')} |`,
    );
  });
  if (!rows.length) lines.push('| 1 | - | - | - | - | - | - | - | - | - |');
  lines.push('');
  if (excluded.length) {
    lines.push('## Excluded (Missing Local Image)');
    lines.push('');
    lines.push('| source | sample_hash | image_path_rel |');
    lines.push('|---|---|---|');
    for (const row of excluded) lines.push(`| ${row.source} | ${row.sample_hash} | ${row.image_path_rel || '-'} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }
  if (!args.review_in) {
    process.stderr.write('gold_round1_real_pack: missing --review_in (or REVIEW_JSONL)\n');
    process.exit(2);
    return;
  }
  const reviewPath = path.resolve(args.review_in);
  if (!fs.existsSync(reviewPath)) {
    process.stderr.write(`gold_round1_real_pack: review file not found: ${reviewPath}\n`);
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const outRoot = path.resolve(args.out || path.join('artifacts', `gold_round1_real_${runId}`));
  const tasksPath = path.join(outRoot, 'tasks.json');
  const manifestPath = path.join(outRoot, 'manifest.json');
  const previewPath = path.join(outRoot, 'preview.md');

  const rowsRaw = await readReviewRows(reviewPath);
  const normalized = rowsRaw.map(normalizeReviewRow).filter(Boolean);
  const validRows = normalized.filter((row) => isLocalOkRow(row, args.include_non_local_ok));

  const internalPool = validRows.filter((row) => row.source === 'internal');
  const selectedInternal = internalPool
    .sort((a, b) => a.sample_hash.localeCompare(b.sample_hash))
    .slice(0, args.limit_internal)
    .map((row) => ({
      ...row,
      selected_bucket: 'internal_all',
      selected_buckets: ['internal_all'],
      bucket_order: 0,
    }));

  const externalPool = validRows.filter((row) => row.source === 'lapa' || row.source === 'celebamaskhq');
  const bySource = {
    lapa: externalPool.filter((row) => row.source === 'lapa'),
    celebamaskhq: externalPool.filter((row) => row.source === 'celebamaskhq'),
  };

  const extSelections = [];
  for (const source of ['lapa', 'celebamaskhq']) {
    const sourceRows = bySource[source];
    const topRisk = pickWithBucket(sortedTopRisk(sourceRows), args.bucket_n, 'top_risk', 1, `${args.seed}:${source}`);
    const lowMin = pickWithBucket(sortedLowMinPixels(sourceRows), args.bucket_n, 'low_min_pixels', 2, `${args.seed}:${source}`);
    const guard = pickWithBucket(sortedGuardTriggered(sourceRows), args.bucket_n, 'guard_triggered', 3, `${args.seed}:${source}`);
    const merged = mergeSelections([topRisk, lowMin, guard]);
    extSelections.push(...merged);
  }

  const externalOrdered = sourceBalancedOrder(extSelections, args.seed);
  const externalLimit = Math.max(0, args.limit - selectedInternal.length);
  const selectedExternal = externalOrdered.slice(0, externalLimit);
  const selected = [...selectedInternal, ...selectedExternal];
  const doubleAnnotateKeys = pickDoubleAnnotateKeys(selected, args.double_annotate_ratio, args.seed);

  const packaged = [];
  const excluded = [];
  for (const row of selected) {
    const absImage = await resolveRowPath(row, args);
    if (!absImage) {
      excluded.push({
        source: row.source,
        sample_hash: row.sample_hash,
        image_path_rel: row.image_path_rel,
      });
      continue;
    }
    packaged.push({
      ...row,
      image_path: absImage,
      double_annotate: doubleAnnotateKeys.has(`${row.source}:${row.sample_hash}`),
    });
  }

  const tasks = packaged.map((row, index) => ({
    id: `${row.source}_${row.sample_hash}`,
    data: {
      image: `file://${toPosix(row.image_path)}`,
      local_path: toPosix(row.image_path),
      image_path: toPosix(row.image_path),
      source: row.source,
      sample_hash: row.sample_hash,
      bucket: (row.selected_buckets || []).join('+') || row.selected_bucket || 'unknown',
      double_annotate: Boolean(row.double_annotate),
      rank: index + 1,
    },
    meta: {
      run_id: runId,
      source: row.source,
      sample_hash: row.sample_hash,
      selected_buckets: row.selected_buckets || [],
      risk_score: round3(row.risk_score),
      min_module_id: row.min_module_id || null,
      min_module_pixels: row.min_module_pixels,
      module_guard_triggered: Boolean(row.module_guard_triggered),
      double_annotate: Boolean(row.double_annotate),
      image_path_rel: row.image_path_rel,
    },
    metadata: {
      run_id: runId,
      source: row.source,
      sample_hash: row.sample_hash,
      selected_buckets: row.selected_buckets || [],
      risk_score: round3(row.risk_score),
      min_module_id: row.min_module_id || null,
      min_module_pixels: row.min_module_pixels,
      module_guard_triggered: Boolean(row.module_guard_triggered),
      double_annotate: Boolean(row.double_annotate),
      image_path_rel: row.image_path_rel,
    },
  }));

  const manifest = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    review_input: toPosix(path.relative(process.cwd(), reviewPath)),
    out_root: toPosix(path.relative(process.cwd(), outRoot)),
    seed: args.seed,
    selection: {
      limit: args.limit,
      limit_internal: args.limit_internal,
      bucket_n: args.bucket_n,
      include_non_local_ok: args.include_non_local_ok,
      double_annotate_ratio: args.double_annotate_ratio,
    },
    stats: {
      review_rows_total: rowsRaw.length,
      review_rows_valid: validRows.length,
      selected_internal: selectedInternal.length,
      selected_external: selectedExternal.length,
      selected_total: selected.length,
      packaged_total: packaged.length,
      double_annotate_total: packaged.filter((row) => row.double_annotate).length,
      excluded_missing_image: excluded.length,
    },
    rows: packaged.map((row, index) => ({
      rank: index + 1,
      sample_hash: row.sample_hash,
      source: row.source,
      image_path: toPosix(row.image_path),
      image_path_rel: row.image_path_rel,
      selected_buckets: row.selected_buckets || [],
      risk_score: round3(row.risk_score),
      min_module_id: row.min_module_id || null,
      min_module_pixels: row.min_module_pixels,
      module_guard_triggered: Boolean(row.module_guard_triggered),
      double_annotate: Boolean(row.double_annotate),
    })),
    exclusions: excluded,
  };

  await fsp.mkdir(outRoot, { recursive: true });
  await fsp.writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    previewPath,
    renderPreview({
      runId,
      reviewIn: reviewPath,
      seed: args.seed,
      limit: args.limit,
      rows: packaged,
      excluded,
    }),
    'utf8',
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      run_id: runId,
      selected_total: selected.length,
      packaged_total: packaged.length,
      excluded_missing_image: excluded.length,
      artifacts: {
        tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
        manifest_json: toPosix(path.relative(process.cwd(), manifestPath)),
        preview_md: toPosix(path.relative(process.cwd(), previewPath)),
      },
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`gold_round1_real_pack_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
