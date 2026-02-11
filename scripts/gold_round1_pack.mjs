#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey, sha256Hex } from './internal_batch_helpers.mjs';
import {
  readJsonlRows,
  resolvePackImage,
  transcodeToPackJpeg,
  toPosix,
} from './local_image_loader.mjs';

const DEFAULT_TOP_RISK = 30;
const DEFAULT_RANDOM = 20;
const DEFAULT_LIMIT_INTERNAL = 38;
const DEFAULT_LIMIT_LAPA = 50;
const DEFAULT_LIMIT_CELEBA = 50;
const DEFAULT_GUARD_UNTRIGGERED_MIN_RATIO = 0.3;

function parseNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseFloatNumber(value, fallback, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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

function parseArgs(argv) {
  const home = process.env.HOME || '';
  const out = {
    run_id: '',
    review_jsonl: '',
    report_dir: process.env.REPORT_DIR || 'reports',
    out_root: '',
    internal_dir: process.env.INTERNAL_DIR || path.join(home, 'Desktop', 'Aurora', 'internal test photos'),
    cache_dir: process.env.CACHE_DIR || path.join('datasets_cache', 'external'),
    lapa_dir: process.env.LAPA_DIR || path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'LaPa DB'),
    celeba_dir:
      process.env.CELEBA_DIR
      || path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'CelebAMask-HQ(1)', 'CelebAMask-HQ', 'CelebA-HQ-img'),
    limit_internal: process.env.LIMIT_INTERNAL || DEFAULT_LIMIT_INTERNAL,
    limit_lapa: process.env.LIMIT_DATASET_LAPA || DEFAULT_LIMIT_LAPA,
    limit_celeba: process.env.LIMIT_DATASET_CELEBA || DEFAULT_LIMIT_CELEBA,
    top_risk: process.env.GOLD_ROUND1_TOP_RISK || DEFAULT_TOP_RISK,
    random_count: process.env.GOLD_ROUND1_RANDOM_COUNT || DEFAULT_RANDOM,
    guard_untriggered_min_ratio:
      process.env.GOLD_ROUND1_GUARD_UNTRIGGERED_MIN_RATIO || DEFAULT_GUARD_UNTRIGGERED_MIN_RATIO,
    seed: process.env.GOLD_ROUND1_SEED || 'gold_round1_seed_v1',
    convert_heic: process.env.CONVERT_HEIC || 'true',
    heic_convert_cmd: process.env.HEIC_CONVERT_CMD || '',
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

  out.run_id = String(out.run_id || '').trim();
  out.review_jsonl = String(out.review_jsonl || '').trim();
  out.report_dir = String(out.report_dir || 'reports').trim() || 'reports';
  out.internal_dir = String(out.internal_dir || '').trim();
  out.cache_dir = String(out.cache_dir || '').trim();
  out.lapa_dir = String(out.lapa_dir || '').trim();
  out.celeba_dir = String(out.celeba_dir || '').trim();
  out.limit_internal = parseNumber(out.limit_internal, DEFAULT_LIMIT_INTERNAL, 0, 10000);
  out.limit_lapa = parseNumber(out.limit_lapa, DEFAULT_LIMIT_LAPA, 0, 10000);
  out.limit_celeba = parseNumber(out.limit_celeba, DEFAULT_LIMIT_CELEBA, 0, 10000);
  out.top_risk = parseNumber(out.top_risk, DEFAULT_TOP_RISK, 0, 10000);
  out.random_count = parseNumber(out.random_count, DEFAULT_RANDOM, 0, 10000);
  out.guard_untriggered_min_ratio = parseFloatNumber(
    out.guard_untriggered_min_ratio,
    DEFAULT_GUARD_UNTRIGGERED_MIN_RATIO,
    0,
    1,
  );
  out.seed = String(out.seed || '').trim() || 'gold_round1_seed_v1';
  out.convert_heic = parseBool(out.convert_heic, true);
  out.heic_convert_cmd = String(out.heic_convert_cmd || '').trim();
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  const token = path.basename(args.review_jsonl || '');
  const match = token.match(/review_pack_mixed_(\d{15}|\d{8}_\d{6,9})\.jsonl$/i);
  if (match) return match[1];
  return runTimestampKey();
}

function isLocalOkRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (!row.ok) return false;
  if (String(row.pipeline_mode_used || '').trim().toLowerCase() !== 'local') return false;
  const rel = String(row.image_path_rel || '').trim();
  if (!rel) return false;
  if (/^https?:\/\//i.test(rel)) return false;
  return true;
}

function riskValue(row) {
  const n = Number(row && row.risk_score);
  return Number.isFinite(n) ? n : 0;
}

function guardTriggered(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.module_guard_triggered) return true;
  const guards = Array.isArray(row.guarded_modules) ? row.guarded_modules : [];
  return guards.some((moduleId) => {
    const token = String(moduleId || '').trim().toLowerCase();
    return token === 'under_eye_left' || token === 'under_eye_right' || token === 'chin';
  });
}

function sourceRows(reviewRows, source) {
  const sourceToken = String(source || '').trim().toLowerCase();
  return reviewRows.filter((row) => String(row.source || '').trim().toLowerCase() === sourceToken);
}

function withSelectionMeta(row, bucket, rank) {
  return {
    ...row,
    risk_bucket: bucket,
    selected_rank: rank,
  };
}

function applyGuardStratify(selectedRows, sourcePool, seed, guardMinRatio) {
  const selected = [...selectedRows];
  if (!selected.length) return selected;
  const targetMin = Math.ceil(selected.length * guardMinRatio);
  const countNonGuard = () => selected.filter((row) => !guardTriggered(row)).length;
  if (countNonGuard() >= targetMin) return selected;

  const selectedHashes = new Set(selected.map((row) => String(row.sample_hash || '')));
  const candidateNonGuard = seededSort(
    sourcePool.filter((row) => !guardTriggered(row) && !selectedHashes.has(String(row.sample_hash || ''))),
    `${seed}:guard_non_trigger`,
    (row) => String(row.sample_hash || ''),
  );
  const replaceCandidates = selected
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => guardTriggered(row) && String(row.risk_bucket || '') === 'random')
    .sort((left, right) => riskValue(left.row) - riskValue(right.row));

  let nonGuardCount = countNonGuard();
  while (candidateNonGuard.length && replaceCandidates.length && nonGuardCount < targetMin) {
    const incoming = candidateNonGuard.shift();
    const replace = replaceCandidates.shift();
    selected[replace.index] = withSelectionMeta(incoming, 'guard_stratify', replace.index + 1);
    selectedHashes.add(String(incoming.sample_hash || ''));
    nonGuardCount += 1;
  }

  return selected;
}

function selectSource({
  rows,
  source,
  topRisk,
  randomCount,
  limit,
  seed,
  guardMinRatio,
}) {
  const pool = sourceRows(rows, source).filter(isLocalOkRow);
  if (!pool.length || limit <= 0) return [];

  const byRisk = [...pool].sort((left, right) => {
    const riskDiff = riskValue(right) - riskValue(left);
    if (riskDiff !== 0) return riskDiff;
    return String(left.sample_hash || '').localeCompare(String(right.sample_hash || ''));
  });

  const topRows = byRisk.slice(0, Math.min(limit, topRisk)).map((row, index) => withSelectionMeta(row, 'top_risk', index + 1));
  const selectedHashes = new Set(topRows.map((row) => String(row.sample_hash || '')));
  const remaining = pool.filter((row) => !selectedHashes.has(String(row.sample_hash || '')));
  const randomRows = seededSort(remaining, `${seed}:${source}:random`, (row) => String(row.sample_hash || ''))
    .slice(0, Math.min(limit - topRows.length, randomCount))
    .map((row, index) => withSelectionMeta(row, 'random', index + 1));

  let selected = [...topRows, ...randomRows];
  if (selected.length < limit) {
    const extra = seededSort(
      remaining.filter((row) => !selected.some((current) => current.sample_hash === row.sample_hash)),
      `${seed}:${source}:extra`,
      (row) => String(row.sample_hash || ''),
    )
      .slice(0, limit - selected.length)
      .map((row, index) => withSelectionMeta(row, 'random_fill', index + 1));
    selected = [...selected, ...extra];
  }

  selected = applyGuardStratify(selected, pool, `${seed}:${source}`, guardMinRatio);
  return selected.slice(0, limit);
}

function selectInternal({ rows, limit }) {
  const pool = sourceRows(rows, 'internal').filter(isLocalOkRow);
  const sorted = [...pool].sort((left, right) => String(left.sample_hash || '').localeCompare(String(right.sample_hash || '')));
  return sorted.slice(0, limit).map((row, index) => withSelectionMeta(row, 'internal_all', index + 1));
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
  const source = String(row.source || '').trim().toLowerCase();
  if (!rel || /^https?:\/\//i.test(rel)) return null;
  if (source === 'lapa') {
    const candidate = path.resolve(args.lapa_dir, rel);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat && stat.isFile()) return candidate;
  }
  if (source === 'celebamaskhq') {
    const candidate = path.resolve(args.celeba_dir, rel);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat && stat.isFile()) return candidate;
  }
  return null;
}

function summarizeBySource(rows) {
  const out = new Map();
  for (const row of rows) {
    const source = String(row.source || 'unknown').trim().toLowerCase();
    const current = out.get(source) || { source, selected: 0, guard_triggered: 0, bucket_counts: new Map() };
    current.selected += 1;
    if (guardTriggered(row)) current.guard_triggered += 1;
    const bucket = String(row.risk_bucket || 'unknown');
    current.bucket_counts.set(bucket, Number(current.bucket_counts.get(bucket) || 0) + 1);
    out.set(source, current);
  }
  return Array.from(out.values()).sort((left, right) => left.source.localeCompare(right.source));
}

function summarizeMinModule(rows) {
  const out = new Map();
  for (const row of rows) {
    const source = String(row.source || 'unknown').trim().toLowerCase();
    const moduleId = String(row.min_module_id || 'unknown').trim() || 'unknown';
    const key = `${source}::${moduleId}`;
    const current = out.get(key) || { source, min_module_id: moduleId, count: 0 };
    current.count += 1;
    out.set(key, current);
  }
  return Array.from(out.values())
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source) || left.min_module_id.localeCompare(right.min_module_id));
}

function renderBucketCount(bucketMap) {
  const entries = Array.from(bucketMap.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return '-';
  return entries.map(([bucket, count]) => `${bucket}:${count}`).join(', ');
}

function stackSnippet(raw, maxLines = 30) {
  const text = String(raw || '').trim();
  if (!text) return '-';
  return text
    .split('\n')
    .slice(0, maxLines)
    .join('\n');
}

async function writeTriageReport({ runId, reportDir, failRows }) {
  const outPath = path.resolve(reportDir, `lapa_local_fail_triage_${runId}.md`);
  const reasonMap = new Map();
  for (const row of failRows) {
    const reason = String(row.reason_detail || row.fail_reason || 'UNKNOWN').trim() || 'UNKNOWN';
    reasonMap.set(reason, Number(reasonMap.get(reason) || 0) + 1);
  }
  const reasonRows = Array.from(reasonMap.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const lines = [];
  lines.push('# LaPa Local Fail Triage');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- fail_rows: ${failRows.length}`);
  lines.push('');
  lines.push('## Reason Distribution');
  lines.push('');
  lines.push('| reason_detail | count |');
  lines.push('|---|---:|');
  if (!reasonRows.length) {
    lines.push('| - | 0 |');
  } else {
    for (const row of reasonRows) lines.push(`| ${row.reason} | ${row.count} |`);
  }
  lines.push('');
  lines.push('## Fail Rows');
  lines.push('');
  lines.push('| sample_hash | image_path_rel | fail_reason | reason_detail | error_code | stack_snippet |');
  lines.push('|---|---|---|---|---|---|');
  if (!failRows.length) {
    lines.push('| - | - | - | - | - | - |');
  } else {
    for (const row of failRows) {
      const snippet = stackSnippet(row.error_stack || row.note || row.message_first_line || '').replace(/\|/g, '\\|').replace(/\n/g, '<br/>');
      lines.push(
        `| ${row.sample_hash || '-'} | ${row.image_path_rel || '-'} | ${row.fail_reason || '-'} | ${row.reason_detail || '-'} | ${row.decode_error_code || row.error_code || '-'} | ${snippet || '-'} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Reproduce One Sample');
  lines.push('');
  lines.push('```bash');
  lines.push(`node scripts/triage_one_sample.mjs --source lapa --sample_hash <hash> --review_jsonl reports/review_pack_mixed_${runId}.jsonl`);
  lines.push('```');
  lines.push('');
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, `${lines.join('\n')}\n`, 'utf8');
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.review_jsonl) {
    process.stderr.write('gold_round1_pack: missing --review_jsonl\n');
    process.exit(2);
    return;
  }

  const reviewPath = path.resolve(args.review_jsonl);
  if (!fs.existsSync(reviewPath)) {
    process.stderr.write(`gold_round1_pack: review_jsonl not found: ${reviewPath}\n`);
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const outRoot = path.resolve(args.out_root || path.join('artifacts', `gold_round1_${runId}`));
  const imagesRoot = path.join(outRoot, 'images');
  const tasksPath = path.join(outRoot, 'label_studio_tasks.json');
  const manifestPath = path.join(outRoot, 'manifest.json');
  const selectedPath = path.join(outRoot, 'selected_rows.jsonl');
  const reportPath = path.resolve(args.report_dir, `gold_round1_pack_${runId}.md`);

  const rows = await readJsonlRows(reviewPath);
  const selectedInternal = selectInternal({ rows, limit: args.limit_internal });
  const selectedLapa = selectSource({
    rows,
    source: 'lapa',
    topRisk: args.top_risk,
    randomCount: args.random_count,
    limit: args.limit_lapa,
    seed: args.seed,
    guardMinRatio: args.guard_untriggered_min_ratio,
  });
  const selectedCeleba = selectSource({
    rows,
    source: 'celebamaskhq',
    topRisk: args.top_risk,
    randomCount: args.random_count,
    limit: args.limit_celeba,
    seed: args.seed,
    guardMinRatio: args.guard_untriggered_min_ratio,
  });

  const selectedRows = [...selectedInternal, ...selectedLapa, ...selectedCeleba];
  const selectedHashes = new Set(selectedRows.map((row) => String(row.sample_hash || '')));
  const lapaFails = sourceRows(rows, 'lapa').filter((row) => !row.ok && !selectedHashes.has(String(row.sample_hash || '')));

  const resolvedItems = [];
  const exclusions = [];
  let heicMismatchCount = 0;
  let convertSuccessCount = 0;
  let convertFailCount = 0;
  const conversionMap = new Map();

  for (const row of selectedRows) {
    const sampleHash = String(row.sample_hash || '').trim();
    const source = String(row.source || '').trim().toLowerCase();
    if (!sampleHash || !source) continue;
    const absInput = await resolveRowPath(row, args);
    if (!absInput) {
      exclusions.push({
        source,
        sample_hash: sampleHash,
        reason: 'LOCAL_FILE_NOT_FOUND',
        image_path_rel: row.image_path_rel || null,
      });
      continue;
    }
    const outPath = path.join(imagesRoot, source, `${sampleHash}.jpg`);
    try {
      const transcodeInfo = await transcodeToPackJpeg({
        inputPath: absInput,
        outputPath: outPath,
        customHeicConvertCmd: args.heic_convert_cmd,
      });
      if (transcodeInfo.heic_mismatch) heicMismatchCount += 1;
      if (transcodeInfo.converted) {
        convertSuccessCount += 1;
        const key = `${source}|${transcodeInfo.ext_from_path || '-'}|${transcodeInfo.magic_type || '-'}|${transcodeInfo.container_hint || '-'}`;
        conversionMap.set(key, Number(conversionMap.get(key) || 0) + 1);
      }
      resolvedItems.push({
        row,
        source,
        sample_hash: sampleHash,
        abs_input_path: absInput,
        abs_output_path: outPath,
        image_rel: toPosix(path.relative(outRoot, outPath)),
        transcode: transcodeInfo,
      });
    } catch (error) {
      if (String(error && error.reason_detail || '').trim() === 'HEIC_CONVERT_FAIL') convertFailCount += 1;
      exclusions.push({
        source,
        sample_hash: sampleHash,
        reason: String(error && error.reason_detail ? error.reason_detail : 'DECODE_CONVERT_FAIL'),
        error_code: String(error && error.error_code ? error.error_code : error && error.code ? error.code : 'DECODE_CONVERT_FAIL'),
        image_path_rel: row.image_path_rel || null,
      });
    }
  }

  const tasks = resolvedItems.map((item) => ({
    id: `${item.source}_${item.sample_hash}`,
    data: {
      image: item.image_rel,
      local_path: toPosix(item.abs_output_path),
      notes: `${item.row.risk_bucket}; guard_triggered=${guardTriggered(item.row)}; min_module=${String(item.row.min_module_id || 'unknown')}`,
    },
    meta: {
      run_id: runId,
      source: item.source,
      sample_hash: item.sample_hash,
      risk_score: round3(item.row.risk_score),
      risk_bucket: item.row.risk_bucket || 'unknown',
      guard_triggered: guardTriggered(item.row),
      min_module_id: item.row.min_module_id || null,
      min_module_pixels: parseNumber(item.row.min_module_pixels, 0, 0, 1000000),
      image_path_rel: item.row.image_path_rel || null,
    },
  }));

  const manifest = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    review_jsonl: toPosix(path.relative(process.cwd(), reviewPath)),
    out_root: toPosix(path.relative(process.cwd(), outRoot)),
    seed: args.seed,
    selection: {
      limit_internal: args.limit_internal,
      limit_lapa: args.limit_lapa,
      limit_celeba: args.limit_celeba,
      top_risk: args.top_risk,
      random_count: args.random_count,
      guard_untriggered_min_ratio: args.guard_untriggered_min_ratio,
    },
    stats: {
      selected_requested: selectedRows.length,
      selected_packaged: tasks.length,
      excluded_count: exclusions.length,
      heic_mismatch_count: heicMismatchCount,
      convert_success_count: convertSuccessCount,
      convert_fail_count: convertFailCount,
      lapa_fail_rows: lapaFails.length,
    },
    rows: resolvedItems.map((item) => ({
      source: item.source,
      sample_hash: item.sample_hash,
      image_path_rel: item.row.image_path_rel || null,
      image_pack_rel: item.image_rel,
      abs_output_path: toPosix(item.abs_output_path),
      risk_score: round3(item.row.risk_score),
      risk_bucket: item.row.risk_bucket || 'unknown',
      guard_triggered: guardTriggered(item.row),
      min_module_id: item.row.min_module_id || null,
      min_module_pixels: parseNumber(item.row.min_module_pixels, 0, 0, 1000000),
      metrics_snapshot: {
        leakage_bg_est_mean: round3(item.row.leakage_bg_est_mean),
        chin_outside_oval_ratio: round3(item.row.chin_outside_oval_ratio),
        nose_outside_oval_ratio: round3(item.row.nose_outside_oval_ratio),
        module_pixels_min: parseNumber(item.row.module_pixels_min, 0, 0, 1000000),
      },
      transcode: item.transcode,
    })),
    exclusions,
  };

  await fsp.mkdir(outRoot, { recursive: true });
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    selectedPath,
    `${resolvedItems.map((item) => JSON.stringify({
      source: item.source,
      sample_hash: item.sample_hash,
      image_path_rel: item.row.image_path_rel || null,
      risk_score: round3(item.row.risk_score),
      risk_bucket: item.row.risk_bucket || 'unknown',
      guard_triggered: guardTriggered(item.row),
      min_module_id: item.row.min_module_id || null,
      min_module_pixels: parseNumber(item.row.min_module_pixels, 0, 0, 1000000),
    })).join('\n')}\n`,
    'utf8',
  );

  const lapaTriagePath = await writeTriageReport({
    runId,
    reportDir: args.report_dir,
    failRows: lapaFails,
  });

  const bySourceSummary = summarizeBySource(resolvedItems.map((item) => item.row));
  const minModuleSummary = summarizeMinModule(resolvedItems.map((item) => item.row));
  const conversionRows = Array.from(conversionMap.entries())
    .map(([token, convertCount]) => {
      const [source, ext, magicType, containerHint] = token.split('|');
      return { source, ext, magic_type: magicType, container_hint: containerHint, convert_count: convertCount };
    })
    .sort((left, right) => right.convert_count - left.convert_count || left.source.localeCompare(right.source));

  const mdLines = [];
  mdLines.push('# Gold Round1 Pack');
  mdLines.push('');
  mdLines.push(`- run_id: ${runId}`);
  mdLines.push(`- generated_at: ${new Date().toISOString()}`);
  mdLines.push(`- review_jsonl: \`${toPosix(path.relative(process.cwd(), reviewPath))}\``);
  mdLines.push(`- seed: ${args.seed}`);
  mdLines.push(`- selected_requested: ${selectedRows.length}`);
  mdLines.push(`- selected_packaged: ${tasks.length}`);
  mdLines.push(`- excluded_count: ${exclusions.length}`);
  mdLines.push(`- heic_mismatch_count: ${heicMismatchCount}`);
  mdLines.push(`- convert_success_count: ${convertSuccessCount}`);
  mdLines.push(`- convert_fail_count: ${convertFailCount}`);
  mdLines.push('');
  mdLines.push('## Selection Summary');
  mdLines.push('');
  mdLines.push('| source | selected | guard_triggered | risk_bucket_counts |');
  mdLines.push('|---|---:|---:|---|');
  if (!bySourceSummary.length) {
    mdLines.push('| - | 0 | 0 | - |');
  } else {
    for (const row of bySourceSummary) {
      mdLines.push(`| ${row.source} | ${row.selected} | ${row.guard_triggered} | ${renderBucketCount(row.bucket_counts)} |`);
    }
  }
  mdLines.push('');
  mdLines.push('## Min-Module Distribution');
  mdLines.push('');
  mdLines.push('| source | min_module_id | count |');
  mdLines.push('|---|---|---:|');
  if (!minModuleSummary.length) {
    mdLines.push('| - | - | 0 |');
  } else {
    for (const row of minModuleSummary.slice(0, 20)) {
      mdLines.push(`| ${row.source} | ${row.min_module_id} | ${row.count} |`);
    }
  }
  mdLines.push('');
  mdLines.push('## Decode Conversions Breakdown');
  mdLines.push('');
  mdLines.push('| source | ext | magic_type | container_hint | convert_count |');
  mdLines.push('|---|---|---|---|---:|');
  if (!conversionRows.length) {
    mdLines.push('| - | - | - | - | 0 |');
  } else {
    for (const row of conversionRows) {
      mdLines.push(`| ${row.source} | ${row.ext} | ${row.magic_type} | ${row.container_hint} | ${row.convert_count} |`);
    }
  }
  mdLines.push('');
  mdLines.push('## Exclusions');
  mdLines.push('');
  mdLines.push('| source | sample_hash | reason | error_code | image_path_rel |');
  mdLines.push('|---|---|---|---|---|');
  if (!exclusions.length) {
    mdLines.push('| - | - | - | - | - |');
  } else {
    for (const row of exclusions.slice(0, 100)) {
      mdLines.push(`| ${row.source} | ${row.sample_hash} | ${row.reason} | ${row.error_code || '-'} | ${row.image_path_rel || '-'} |`);
    }
  }
  mdLines.push('');
  mdLines.push('## Artifacts');
  mdLines.push('');
  mdLines.push(`- round1_dir: \`${toPosix(path.relative(process.cwd(), outRoot))}\``);
  mdLines.push(`- tasks: \`${toPosix(path.relative(process.cwd(), tasksPath))}\``);
  mdLines.push(`- manifest: \`${toPosix(path.relative(process.cwd(), manifestPath))}\``);
  mdLines.push(`- selected_rows: \`${toPosix(path.relative(process.cwd(), selectedPath))}\``);
  mdLines.push(`- lapa_fail_triage: \`${toPosix(path.relative(process.cwd(), lapaTriagePath))}\``);
  mdLines.push('');
  mdLines.push('## Label Studio Import');
  mdLines.push('');
  mdLines.push('1. Create/open local Label Studio project with `label_studio/project_oval_skin.xml`.');
  mdLines.push(`2. Import tasks from \`${toPosix(path.relative(process.cwd(), tasksPath))}\`.`);
  mdLines.push('3. Export annotations as JSON, then run:');
  mdLines.push('');
  mdLines.push('```bash');
  mdLines.push(`make eval-gold-round1 RUN_ID=${runId} GOLD_EXPORT_JSON=/absolute/path/to/label_studio_export.json`);
  mdLines.push('```');
  mdLines.push('');

  await fsp.writeFile(reportPath, `${mdLines.join('\n')}\n`, 'utf8');

  const result = {
    ok: true,
    run_id: runId,
    selected_requested: selectedRows.length,
    selected_packaged: tasks.length,
    excluded_count: exclusions.length,
    heic_mismatch_count: heicMismatchCount,
    convert_success_count: convertSuccessCount,
    convert_fail_count: convertFailCount,
    artifacts: {
      report_md: toPosix(path.relative(process.cwd(), reportPath)),
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      manifest_json: toPosix(path.relative(process.cwd(), manifestPath)),
      selected_jsonl: toPosix(path.relative(process.cwd(), selectedPath)),
      lapa_triage_md: toPosix(path.relative(process.cwd(), lapaTriagePath)),
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
