#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey, sha256Hex } from './internal_batch_helpers.mjs';

const DEFAULT_LIMIT = 120;
const DEFAULT_BUCKET_MIN = 20;
const DEFAULT_SOURCE_MIN = 8;
const DEFAULT_BUCKETS = ['CHIN_OVERFLOW', 'BG_LEAKAGE', 'NOSE_OVERFLOW', 'LAPA_FAIL', 'RANDOM_BASELINE'];
const REQUIRED_SOURCES = ['internal', 'lapa', 'celebamaskhq'];

function parseIntSafe(value, fallback, min = 0, max = 100000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseArgs(argv) {
  const home = process.env.HOME || '';
  const out = {
    limit: DEFAULT_LIMIT,
    buckets: DEFAULT_BUCKETS.join(','),
    bucket_min: DEFAULT_BUCKET_MIN,
    source_min: DEFAULT_SOURCE_MIN,
    tasks_out: path.join('artifacts', 'gold_seed_tasks_labelstudio.json'),
    manifest_out: path.join('artifacts', 'gold_seed_manifest.json'),
    report_dir: 'reports',
    cache_dir: path.join('datasets_cache', 'external'),
    internal_dir: path.join(home, 'Desktop', 'Aurora', 'internal test photos'),
    lapa_dir: path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'LaPa DB'),
    celeba_dir: path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'CelebAMask-HQ(1)', 'CelebAMask-HQ', 'CelebA-HQ-img'),
    review_md: '',
    review_jsonl: '',
    seed: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!(key in out)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    i += 1;
  }
  out.limit = parseIntSafe(out.limit, DEFAULT_LIMIT, 1, 100000);
  out.bucket_min = parseIntSafe(out.bucket_min, DEFAULT_BUCKET_MIN, 1, 10000);
  out.source_min = parseIntSafe(out.source_min, DEFAULT_SOURCE_MIN, 0, 10000);
  out.seed = String(out.seed || '').trim() || `gold_seed_pack_${runTimestampKey()}`;
  out.report_dir = String(out.report_dir || 'reports').trim() || 'reports';
  out.cache_dir = String(out.cache_dir || path.join('datasets_cache', 'external')).trim();
  out.tasks_out = String(out.tasks_out || path.join('artifacts', 'gold_seed_tasks_labelstudio.json')).trim();
  out.manifest_out = String(out.manifest_out || path.join('artifacts', 'gold_seed_manifest.json')).trim();
  out.buckets = String(out.buckets || DEFAULT_BUCKETS.join(','))
    .split(',')
    .map((v) => String(v || '').trim().toUpperCase())
    .filter(Boolean);
  if (!out.buckets.length) out.buckets = [...DEFAULT_BUCKETS];
  return out;
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function csvEscape(value) {
  const token = String(value == null ? '' : value);
  if (token.includes(',') || token.includes('"') || token.includes('\n')) {
    return `"${token.replace(/"/g, '""')}"`;
  }
  return token;
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

async function resolveReviewJsonlPath(args) {
  if (args.review_jsonl) return path.resolve(args.review_jsonl);
  if (args.review_md) {
    const token = path.basename(args.review_md);
    const match = token.match(/review_pack_mixed_(\d{15}|\d{8}_\d{6,9})\.md$/i);
    if (match) {
      const guess = path.resolve(args.report_dir, `review_pack_mixed_${match[1]}.jsonl`);
      if (fs.existsSync(guess)) return guess;
    }
    const guessed = path.resolve(args.review_md).replace(/\.md$/i, '.jsonl');
    if (fs.existsSync(guessed)) return guessed;
  }
  const reportDir = path.resolve(args.report_dir);
  const names = await fsp.readdir(reportDir).catch(() => []);
  const candidates = names
    .filter((name) => /^review_pack_mixed_\d{15}\.jsonl$/i.test(name) || /^review_pack_mixed_\d{8}_\d{6,9}\.jsonl$/i.test(name))
    .map((name) => path.join(reportDir, name));
  if (!candidates.length) return null;
  const stats = await Promise.all(
    candidates.map(async (filePath) => ({
      filePath,
      mtimeMs: (await fsp.stat(filePath)).mtimeMs,
    })),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0].filePath;
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

function parseRiskMetric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function resolveLocalPath(row, args) {
  const source = String(row.source || '').trim().toLowerCase();
  const rel = String(row.image_path_rel || '').trim();
  if (!source || !rel) return null;
  if (/^https?:\/\//i.test(rel)) return null;

  let baseDir = '';
  if (source === 'internal') baseDir = args.internal_dir;
  if (source === 'lapa') baseDir = path.join(args.cache_dir, 'lapa');
  if (source === 'celebamaskhq') baseDir = path.join(args.cache_dir, 'celebamaskhq');
  if (!baseDir) return null;

  const absPath = path.resolve(baseDir, rel);
  const stat = await fsp.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  return absPath;
}

function chooseBucketRows(bucket, rows) {
  const token = String(bucket || '').trim().toUpperCase();
  if (token === 'CHIN_OVERFLOW') {
    return rows
      .filter((row) => parseRiskMetric(row.chin_outside_oval_ratio) > 0)
      .sort((a, b) => parseRiskMetric(b.chin_outside_oval_ratio) - parseRiskMetric(a.chin_outside_oval_ratio));
  }
  if (token === 'BG_LEAKAGE') {
    return rows
      .filter((row) => parseRiskMetric(row.leakage_bg_est_mean || row.leakage_bg_mean) > 0)
      .sort((a, b) => parseRiskMetric(b.leakage_bg_est_mean || b.leakage_bg_mean) - parseRiskMetric(a.leakage_bg_est_mean || a.leakage_bg_mean));
  }
  if (token === 'NOSE_OVERFLOW') {
    return rows
      .filter((row) => parseRiskMetric(row.nose_outside_oval_ratio) > 0)
      .sort((a, b) => parseRiskMetric(b.nose_outside_oval_ratio) - parseRiskMetric(a.nose_outside_oval_ratio));
  }
  if (token === 'LAPA_FAIL') {
    return rows
      .filter((row) => String(row.source || '').toLowerCase() === 'lapa' && !row.ok)
      .sort((a, b) => parseRiskMetric(b.risk_score) - parseRiskMetric(a.risk_score));
  }
  if (token === 'RANDOM_BASELINE') return rows;
  return [];
}

function sourceCountsOf(rows) {
  const out = {};
  for (const row of rows) {
    const source = String(row.source || '').trim().toLowerCase() || 'unknown';
    out[source] = Number(out[source] || 0) + 1;
  }
  return out;
}

function pickWithQuota({
  rows,
  limit,
  buckets,
  bucketMin,
  sourceMin,
  seed,
}) {
  const selected = [];
  const selectedHashes = new Set();
  const bucketCounts = {};

  const randomRows = seededSort(rows, `${seed}:random`, (row) => row.sample_hash);

  const pushIfPossible = (row, bucketName) => {
    const hash = String(row.sample_hash || '').trim();
    if (!hash || selectedHashes.has(hash)) return false;
    selectedHashes.add(hash);
    selected.push({ ...row, bucket: bucketName });
    bucketCounts[bucketName] = Number(bucketCounts[bucketName] || 0) + 1;
    return true;
  };

  for (const bucket of buckets) {
    bucketCounts[bucket] = 0;
    const ranked = bucket === 'RANDOM_BASELINE'
      ? randomRows
      : chooseBucketRows(bucket, rows);
    for (const row of ranked) {
      if (selected.length >= limit) break;
      if (bucketCounts[bucket] >= bucketMin) break;
      pushIfPossible(row, bucket);
    }
  }

  const bySource = sourceCountsOf(selected);
  for (const source of REQUIRED_SOURCES) {
    if (selected.length >= limit) break;
    const need = Math.max(0, sourceMin - Number(bySource[source] || 0));
    if (need <= 0) continue;
    const pool = randomRows.filter((row) => String(row.source || '').toLowerCase() === source);
    let added = 0;
    for (const row of pool) {
      if (selected.length >= limit || added >= need) break;
      if (pushIfPossible(row, 'RANDOM_BASELINE')) added += 1;
    }
  }

  if (selected.length < limit) {
    for (const row of randomRows) {
      if (selected.length >= limit) break;
      pushIfPossible(row, 'RANDOM_BASELINE');
    }
  }

  return {
    selected,
    bucketCounts,
  };
}

function buildTask({ row, localPath }) {
  const source = String(row.source || '').trim().toLowerCase();
  const sampleHash = String(row.sample_hash || '').trim();
  return {
    id: `${source}_${sampleHash}`,
    data: {
      sample_hash: sampleHash,
      source,
      bucket: row.bucket,
      local_path: localPath,
      image: `file://${localPath}`,
      image_path_rel: String(row.image_path_rel || ''),
      metrics_snapshot: {
        risk_score: parseRiskMetric(row.risk_score),
        leakage_bg_est_mean: parseRiskMetric(row.leakage_bg_est_mean || row.leakage_bg_mean),
        chin_outside_oval_ratio: parseRiskMetric(row.chin_outside_oval_ratio),
        nose_outside_oval_ratio: parseRiskMetric(row.nose_outside_oval_ratio),
        min_module_id: row.min_module_id || null,
        min_module_pixels: parseIntSafe(row.min_module_pixels, 0, 0, 100000),
        fail_reason: row.fail_reason || null,
        reason_detail: row.reason_detail || null,
      },
    },
  };
}

function toManifestRow({ row, localPath }) {
  return {
    sample_hash: String(row.sample_hash || ''),
    source: String(row.source || ''),
    bucket: String(row.bucket || ''),
    local_path: toPosix(localPath),
    image_path_rel: String(row.image_path_rel || ''),
    metrics_snapshot: {
      risk_score: parseRiskMetric(row.risk_score),
      leakage_bg_est_mean: parseRiskMetric(row.leakage_bg_est_mean || row.leakage_bg_mean),
      chin_outside_oval_ratio: parseRiskMetric(row.chin_outside_oval_ratio),
      nose_outside_oval_ratio: parseRiskMetric(row.nose_outside_oval_ratio),
      min_module_id: row.min_module_id || null,
      min_module_pixels: parseIntSafe(row.min_module_pixels, 0, 0, 100000),
      fail_reason: row.fail_reason || null,
      reason_detail: row.reason_detail || null,
    },
  };
}

function buildMarkdown({
  runId,
  reportPathRel,
  reviewJsonlRel,
  limit,
  bucketMin,
  sourceMin,
  buckets,
  selectedRows,
  bucketCounts,
}) {
  const sourceCounts = sourceCountsOf(selectedRows);
  const lines = [];
  lines.push('# Gold Seed Pack');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- review_jsonl: ${reviewJsonlRel}`);
  lines.push(`- limit: ${limit}`);
  lines.push(`- bucket_min: ${bucketMin}`);
  lines.push(`- source_min: ${sourceMin}`);
  lines.push(`- selected_total: ${selectedRows.length}`);
  lines.push('');
  lines.push('## Bucket Summary');
  lines.push('');
  lines.push('| bucket | selected |');
  lines.push('|---|---:|');
  for (const bucket of buckets) {
    lines.push(`| ${bucket} | ${Number(bucketCounts[bucket] || 0)} |`);
  }
  lines.push('');
  lines.push('## Source Coverage');
  lines.push('');
  lines.push('| source | selected |');
  lines.push('|---|---:|');
  for (const source of REQUIRED_SOURCES) {
    lines.push(`| ${source} | ${Number(sourceCounts[source] || 0)} |`);
  }
  lines.push('');
  lines.push('## Sample Preview');
  lines.push('');
  lines.push('| sample_hash | source | bucket | risk_score | leakage_bg_est_mean | chin_outside_oval_ratio | nose_outside_oval_ratio |');
  lines.push('|---|---|---|---:|---:|---:|---:|');
  for (const row of selectedRows.slice(0, 30)) {
    lines.push(`| ${row.sample_hash} | ${row.source} | ${row.bucket} | ${parseRiskMetric(row.risk_score).toFixed(3)} | ${parseRiskMetric(row.leakage_bg_est_mean || row.leakage_bg_mean).toFixed(3)} | ${parseRiskMetric(row.chin_outside_oval_ratio).toFixed(3)} | ${parseRiskMetric(row.nose_outside_oval_ratio).toFixed(3)} |`);
  }
  lines.push('');
  lines.push(`- report: \`${reportPathRel}\``);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = runTimestampKey();
  const reviewJsonlPath = await resolveReviewJsonlPath(args);
  if (!reviewJsonlPath) {
    process.stderr.write('gold_seed_pack: no review_pack_mixed jsonl found\n');
    process.exit(2);
    return;
  }

  const allRows = await readNdjson(reviewJsonlPath);
  const withLocalPath = [];
  for (const row of allRows) {
    const localPath = await resolveLocalPath(row, args);
    if (!localPath) continue;
    withLocalPath.push({
      ...row,
      source: String(row.source || '').trim().toLowerCase(),
      local_path: localPath,
    });
  }

  if (!withLocalPath.length) {
    process.stderr.write('gold_seed_pack: no local image rows available from review pack\n');
    process.exit(2);
    return;
  }

  const selectedResult = pickWithQuota({
    rows: withLocalPath,
    limit: args.limit,
    buckets: args.buckets,
    bucketMin: args.bucket_min,
    sourceMin: args.source_min,
    seed: args.seed,
  });

  const selected = selectedResult.selected;
  const tasks = selected.map((row) => buildTask({ row, localPath: row.local_path }));
  const manifestSamples = selected.map((row) => toManifestRow({ row, localPath: row.local_path }));

  const manifestPayload = {
    schema_version: 'aurora.gold_seed_manifest.v1',
    run_id: runId,
    generated_at: new Date().toISOString(),
    review_jsonl: toPosix(path.relative(process.cwd(), reviewJsonlPath)),
    limit: args.limit,
    bucket_min: args.bucket_min,
    source_min: args.source_min,
    buckets: args.buckets,
    selected_total: selected.length,
    bucket_counts: selectedResult.bucketCounts,
    source_counts: sourceCountsOf(selected),
    samples: manifestSamples,
  };

  const tasksOut = path.resolve(args.tasks_out);
  const manifestOut = path.resolve(args.manifest_out);
  await fsp.mkdir(path.dirname(tasksOut), { recursive: true });
  await fsp.mkdir(path.dirname(manifestOut), { recursive: true });
  await fsp.writeFile(tasksOut, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  await fsp.writeFile(manifestOut, `${JSON.stringify(manifestPayload, null, 2)}\n`, 'utf8');

  const reportPath = path.resolve(args.report_dir, `gold_seed_pack_${runId}.md`);
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  const reportContent = buildMarkdown({
    runId,
    reportPathRel: toPosix(path.relative(process.cwd(), reportPath)),
    reviewJsonlRel: toPosix(path.relative(process.cwd(), reviewJsonlPath)),
    limit: args.limit,
    bucketMin: args.bucket_min,
    sourceMin: args.source_min,
    buckets: args.buckets,
    selectedRows: selected,
    bucketCounts: selectedResult.bucketCounts,
  });
  await fsp.writeFile(reportPath, reportContent, 'utf8');

  const summary = {
    ok: true,
    run_id: runId,
    review_jsonl: toPosix(path.relative(process.cwd(), reviewJsonlPath)),
    selected_total: selected.length,
    tasks_out: toPosix(path.relative(process.cwd(), tasksOut)),
    manifest_out: toPosix(path.relative(process.cwd(), manifestOut)),
    report_out: toPosix(path.relative(process.cwd(), reportPath)),
    bucket_counts: selectedResult.bucketCounts,
    source_counts: sourceCountsOf(selected),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`gold_seed_pack_failed: ${error.message}\n`);
  process.exit(1);
});
