#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import {
  collectPhotoFiles,
  runTimestampKey,
  sha256Hex,
} from './internal_batch_helpers.mjs';
import {
  readJsonlRows,
  toLabelStudioLocalFilesUrl,
  toPosix,
} from './local_image_loader.mjs';

const runExecFile = promisify(execFile);
const require = createRequire(import.meta.url);
const {
  decodeRleBinary,
  bboxNormToMask,
} = require('../src/auroraBff/evalAdapters/common/metrics');

const DEFAULTS = Object.freeze({
  limit_internal: 60,
  limit_lapa: 70,
  limit_celeba: 70,
  target_total: 200,
  overlap_ratio: 0.25,
  overlap_min: 40,
  seed: 'preference_round1_real_seed_v1',
  cache_dir: path.join('datasets_cache', 'external'),
  external_index_lapa: path.join('datasets_cache', 'external', 'lapa', 'index.jsonl'),
  external_index_celeba: path.join('datasets_cache', 'external', 'celebamaskhq', 'index.jsonl'),
  max_edge: 512,
  concurrency: 2,
  report_dir: 'reports',
  mock_pipeline: false,
  module_box_mode: 'dynamic_skinmask',
  require_dynamic_boxes: true,
  exclude_template_like: false,
  min_geometry_qc_score: 0,
  template_match_eps: 0.004,
  hard_filter_gate: true,
  hard_filter_require_quality_pass: false,
  hard_filter_max_guarded_modules: 1,
  hard_filter_min_module_pixels: 48,
  hard_filter_min_dynamic_score: 0.7,
  hard_filter_min_box_plausibility: 0.72,
  hard_filter_min_mask_rle_ratio: 0,
  hard_filter_min_face_span_h: 0,
  hard_filter_min_face_span_w: 0,
  hard_filter_min_face_span_area: 0,
  hard_filter_require_onnx_skinmask: true,
  hard_filter_min_overlap_score: 0.6,
  hard_filter_max_abs_yaw: 0.85,
  hard_filter_require_all_strong_modules: true,
  hard_filter_fail_on_empty: true,
  skinmask_onnx_enabled: true,
  skinmask_onnx_strict: true,
  skinmask_model_path: path.join('artifacts', 'skinmask_v2.onnx'),
  skinmask_timeout_ms: 1200,
});

const SOURCE_PRIORITY = Object.freeze(['internal', 'lapa', 'celebamaskhq']);
const MODULE_IDS = Object.freeze([
  'nose',
  'forehead',
  'left_cheek',
  'right_cheek',
  'chin',
  'under_eye_left',
  'under_eye_right',
]);

const HELP_TEXT = `preference_round1_real_runbook.mjs

Usage:
  node scripts/preference_round1_real_runbook.mjs --internal_dir <path> [options]

Required:
  --internal_dir <path>                      internal clean photos root (recursive)

Options:
  --run_id <id>                              run id (default: timestamp)
  --out <dir>                                output root (default: artifacts/preference_round1_<run_id>)
  --seed <token>                             deterministic seed (default: preference_round1_real_seed_v1)
  --review_pack_jsonl <path>                 optional review_pack_mixed jsonl/csv for internal sample_hash preference
  --external_index_lapa <path>               default: datasets_cache/external/lapa/index.jsonl
  --external_index_celeba <path>             default: datasets_cache/external/celebamaskhq/index.jsonl
  --cache_dir <path>                         passed through to preference_round1_pack (default: datasets_cache/external)
  --limit_internal <n>                       default: 60
  --limit_lapa <n>                           default: 70
  --limit_celeba <n>                         default: 70
  --target_total <n>                         default: 200
  --overlap_ratio <0-1>                      overlap subset ratio (default: 0.25)
  --overlap_min <n>                          overlap minimum samples (default: 40)
  --iaa_ratio <0-1>                          deprecated alias of --overlap_ratio
  --max_edge <n>                             overlay max edge (default: 512)
  --concurrency <n>                          local processing concurrency (default: 2)
  --module_box_mode <static|dynamic_skinmask|auto>  module box mode passed to pack (default: dynamic_skinmask)
  --require_dynamic_boxes <bool>             exclude samples where dynamic boxes not applied (default: false)
  --exclude_template_like <bool>             exclude template-like static boxes (default: false)
  --min_geometry_qc_score <0-1>              minimum geometry QC score passed to pack (default: 0)
  --template_match_eps <0-0.05>              template box match epsilon (default: 0.004)
  --hard_filter_gate <bool>                  enable offline hard-filter gate (default: false)
  --hard_filter_require_quality_pass <bool>  require quality_grade=pass in both A/B (default: false)
  --hard_filter_max_guarded_modules <n>      max allowed guarded modules per side (default: 1)
  --hard_filter_min_module_pixels <n>        min allowed module_pixels_min per side (default: 48)
  --hard_filter_min_dynamic_score <0-1>      min allowed dynamic box score per side (default: 0.7)
  --hard_filter_min_box_plausibility <0-1>   min allowed module-box plausibility score per side (default: 0.72)
  --hard_filter_min_mask_rle_ratio <0-1>     min strong-module mask_rle coverage per side (default: 0, disabled)
  --hard_filter_min_face_span_h <0-1>        min strong-module vertical span per side (default: 0, disabled)
  --hard_filter_min_face_span_w <0-1>        min strong-module horizontal span per side (default: 0, disabled)
  --hard_filter_min_face_span_area <0-1>     min strong-module bbox area per side (default: 0, disabled)
  --hard_filter_require_onnx_skinmask <bool> require ONNX skinmask source in both A/B (default: true)
  --hard_filter_min_overlap_score <0-1>      min module_box_overlap_score per side (default: 0.6)
  --hard_filter_max_abs_yaw <0-1>            max absolute yaw_est per side (default: 0.85)
  --hard_filter_require_all_strong_modules <bool>  require all 5 strong modules in both A/B (default: true)
  --hard_filter_fail_on_empty <bool>         exit non-zero if hard filter removes all samples (default: true)
  --skinmask_onnx_enabled <bool>             enable ONNX skinmask in pack (default: true)
  --skinmask_onnx_strict <bool>              if ONNX fails, do not fallback to bbox prior (default: true)
  --skinmask_model_path <path>               ONNX model path passed to pack (default: artifacts/skinmask_v2.onnx)
  --skinmask_timeout_ms <ms>                 ONNX timeout per side (default: 1200)
  --mock_pipeline <bool>                     deterministic mock mode for smoke/tests
  --help                                     show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
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

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function asNullableNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sortObjectDeep(input) {
  if (Array.isArray(input)) return input.map((item) => sortObjectDeep(item));
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const key of Object.keys(input).sort()) {
    out[key] = sortObjectDeep(input[key]);
  }
  return out;
}

function hashConfig(input) {
  const canonical = JSON.stringify(sortObjectDeep(input));
  return sha256Hex(canonical).slice(0, 20);
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
  const ext = String(path.extname(inputPath) || '').trim().toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return readJsonlRows(inputPath);
  if (ext !== '.csv') throw new Error(`unsupported_review_pack_ext:${ext || 'unknown'}`);
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
      row[headers[j]] = values[j] == null ? '' : values[j];
    }
    rows.push(row);
  }
  return rows;
}

function normalizeSource(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (token === 'celeb' || token === 'celeba' || token === 'celebamask') return 'celebamaskhq';
  return token;
}

function deterministicSort(items, seed, keyFn) {
  return [...items].sort((a, b) => {
    const ka = String(keyFn(a));
    const kb = String(keyFn(b));
    const ha = sha256Hex(`${seed}:${ka}`);
    const hb = sha256Hex(`${seed}:${kb}`);
    if (ha === hb) return ka.localeCompare(kb);
    return ha.localeCompare(hb);
  });
}

async function fileExists(filePath) {
  const stat = await fsp.stat(filePath).catch(() => null);
  return Boolean(stat && stat.isFile());
}

function buildInternalSampleHash(relPath) {
  return sha256Hex(`internal:${toPosix(relPath)}`).slice(0, 20);
}

function buildExternalSampleHash(source, relPath) {
  return sha256Hex(`${source}:${toPosix(relPath)}`).slice(0, 20);
}

function sanitizeSampleId(raw, fallback) {
  const token = String(raw || '').trim();
  if (!token) return fallback;
  return token.replace(/\s+/g, '_').slice(0, 64);
}

async function collectInternalCandidates({ internalDir, reviewRows, seed }) {
  const collected = await collectPhotoFiles({ photosDir: internalDir, limit: 0, shuffle: false });
  const fileSet = new Set(collected.files.map((filePath) => path.resolve(filePath)));

  const preferredByPath = new Map();
  if (Array.isArray(reviewRows) && reviewRows.length) {
    for (let i = 0; i < reviewRows.length; i += 1) {
      const row = reviewRows[i] || {};
      if (normalizeSource(row.source || row.dataset) !== 'internal') continue;
      let absPath = String(row.image_path || '').trim();
      if (!absPath || !path.isAbsolute(absPath)) {
        const rel = String(row.image_path_rel || row.image_rel || row.image_path || '').trim();
        if (!rel || /^https?:\/\//i.test(rel)) continue;
        absPath = path.resolve(internalDir, rel);
      }
      absPath = path.resolve(absPath);
      if (!fileSet.has(absPath)) continue;
      if (preferredByPath.has(absPath)) continue;
      preferredByPath.set(absPath, {
        index: i,
        sample_hash: sanitizeSampleId(row.sample_hash, buildInternalSampleHash(path.relative(internalDir, absPath))),
        risk_score: Number(row.risk_score),
        min_module_pixels: Number(row.min_module_pixels ?? row.module_pixels_min),
        leakage_bg_est_mean: Number(row.leakage_bg_est_mean ?? row.leakage_bg_mean),
        forehead_hair_overlap_rate: Number(row.forehead_hair_overlap_rate ?? row.hair_as_skin_rate),
      });
    }
  }

  const candidates = [];
  for (const absPath of collected.files) {
    const resolved = path.resolve(absPath);
    const rel = toPosix(path.relative(path.resolve(internalDir), resolved));
    const preferred = preferredByPath.get(resolved) || null;
    const sampleHash = preferred
      ? sanitizeSampleId(preferred.sample_hash, buildInternalSampleHash(rel))
      : buildInternalSampleHash(rel);
    candidates.push({
      source: 'internal',
      abs_path: resolved,
      rel_path: rel,
      sample_hash: sampleHash,
      preferred_index: preferred ? preferred.index : null,
      risk_score: Number.isFinite(preferred && preferred.risk_score) ? Number(preferred.risk_score) : 0,
      min_module_pixels: Number.isFinite(preferred && preferred.min_module_pixels) ? Math.max(0, Math.trunc(preferred.min_module_pixels)) : null,
      leakage_bg_est_mean: Number.isFinite(preferred && preferred.leakage_bg_est_mean) ? Number(preferred.leakage_bg_est_mean) : null,
      forehead_hair_overlap_rate: Number.isFinite(preferred && preferred.forehead_hair_overlap_rate) ? Number(preferred.forehead_hair_overlap_rate) : null,
    });
  }

  const preferred = candidates
    .filter((row) => row.preferred_index != null)
    .sort((a, b) => Number(a.preferred_index) - Number(b.preferred_index) || a.sample_hash.localeCompare(b.sample_hash));
  const rest = deterministicSort(
    candidates.filter((row) => row.preferred_index == null),
    `${seed}:internal_rest`,
    (row) => `${row.sample_hash}:${row.rel_path}`,
  );

  return {
    discovered_total: candidates.length,
    preferred_total: preferred.length,
    ordered: [...preferred, ...rest],
  };
}

function extractIndexImageRel(row) {
  const keys = ['image_path', 'image_path_rel', 'relative_path', 'path', 'file_path'];
  for (const key of keys) {
    const value = String(row && row[key] != null ? row[key] : '').trim();
    if (value) return value;
  }
  return '';
}

async function collectExternalCandidates({ source, indexPath, seed }) {
  const absIndex = path.resolve(indexPath);
  const stat = await fsp.stat(absIndex).catch(() => null);
  if (!stat || !stat.isFile()) {
    return {
      source,
      index_path: absIndex,
      discovered_total: 0,
      usable_total: 0,
      ordered: [],
      missing_index: true,
    };
  }

  const rows = await readJsonlRows(absIndex);
  const indexDir = path.dirname(absIndex);
  const candidates = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const relOrAbs = extractIndexImageRel(row);
    if (!relOrAbs || /^https?:\/\//i.test(relOrAbs)) continue;
    const absPath = path.isAbsolute(relOrAbs)
      ? path.resolve(relOrAbs)
      : path.resolve(indexDir, relOrAbs);
    if (!(await fileExists(absPath))) continue;

    const relPath = toPosix(path.isAbsolute(relOrAbs) ? path.relative(indexDir, absPath) : relOrAbs);
    const sourceId = String(row.sample_id || row.sample_hash || '').trim();
    // Prefix source to avoid cross-dataset collisions like "idx_1" in both LaPa/Celeb.
    const sampleIdSeed = sourceId ? `${source}_${sourceId}` : buildExternalSampleHash(source, relPath);
    const sampleHash = sanitizeSampleId(sampleIdSeed, buildExternalSampleHash(source, relPath));
    const riskScore = Number(row.risk_score);
    const minModulePixels = Number(row.min_module_pixels ?? row.module_pixels_min);
    const leakageBgEst = Number(row.leakage_bg_est_mean ?? row.leakage_bg_mean);
    const hairOverlap = Number(row.forehead_hair_overlap_rate ?? row.hair_as_skin_rate);

    candidates.push({
      source,
      abs_path: absPath,
      rel_path: relPath,
      sample_hash: sampleHash,
      risk_score: Number.isFinite(riskScore) ? riskScore : 0,
      min_module_pixels: Number.isFinite(minModulePixels) ? Math.max(0, Math.trunc(minModulePixels)) : null,
      leakage_bg_est_mean: Number.isFinite(leakageBgEst) ? leakageBgEst : null,
      forehead_hair_overlap_rate: Number.isFinite(hairOverlap) ? hairOverlap : null,
      index_rank: i,
    });
  }

  const ordered = [...candidates].sort((a, b) => {
    const riskDelta = Number(b.risk_score || 0) - Number(a.risk_score || 0);
    if (Math.abs(riskDelta) > 1e-9) return riskDelta;
    const minDelta = Number(a.min_module_pixels || 0) - Number(b.min_module_pixels || 0);
    if (minDelta !== 0) return minDelta;
    const keyA = sha256Hex(`${seed}:${source}:${a.sample_hash}:${a.rel_path}`);
    const keyB = sha256Hex(`${seed}:${source}:${b.sample_hash}:${b.rel_path}`);
    if (keyA === keyB) return a.sample_hash.localeCompare(b.sample_hash);
    return keyA.localeCompare(keyB);
  });

  return {
    source,
    index_path: absIndex,
    discovered_total: rows.length,
    usable_total: candidates.length,
    ordered,
    missing_index: false,
  };
}

function uniqueBySourceAndSample(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.source}:${row.sample_hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function pickWithLimit(ordered, limit) {
  const safeLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  if (safeLimit <= 0) return { selected: [], leftovers: [...ordered] };
  return {
    selected: ordered.slice(0, safeLimit),
    leftovers: ordered.slice(safeLimit),
  };
}

function backfillSelections({ selectedBySource, leftoversBySource, targetTotal, seed }) {
  const currentTotal = SOURCE_PRIORITY.reduce((acc, source) => acc + selectedBySource[source].length, 0);
  if (currentTotal >= targetTotal) {
    return {
      selectedBySource,
      backfilled: 0,
    };
  }

  const pool = [];
  for (const source of SOURCE_PRIORITY) {
    for (const row of leftoversBySource[source]) {
      pool.push({ ...row, _source: source });
    }
  }

  const orderedPool = deterministicSort(pool, `${seed}:backfill`, (row) => `${row.source}:${row.sample_hash}:${row.rel_path}`);
  let added = 0;
  for (const row of orderedPool) {
    const totalNow = SOURCE_PRIORITY.reduce((acc, source) => acc + selectedBySource[source].length, 0);
    if (totalNow >= targetTotal) break;
    selectedBySource[row.source].push(row);
    added += 1;
  }

  return {
    selectedBySource,
    backfilled: added,
  };
}

function buildSyntheticReviewRows(rows) {
  return rows.map((row) => ({
    source: row.source,
    sample_hash: row.sample_hash,
    image_path: row.abs_path,
    image_path_rel: row.rel_path,
    ok: true,
    pipeline_mode_used: 'local',
    risk_score: Number(row.risk_score || 0),
    min_module_pixels: Number.isFinite(row.min_module_pixels) ? row.min_module_pixels : 0,
    leakage_bg_est_mean: row.leakage_bg_est_mean == null ? null : Number(row.leakage_bg_est_mean),
    forehead_hair_overlap_rate: row.forehead_hair_overlap_rate == null ? null : Number(row.forehead_hair_overlap_rate),
    module_guard_triggered: false,
    guarded_modules: [],
  }));
}

async function writeJsonl(filePath, rows) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fsp.writeFile(filePath, payload, 'utf8');
}

async function runPreferencePack({ args, syntheticReviewPath, selectedCounts, outDir }) {
  const scriptPath = path.resolve('scripts', 'preference_round1_pack.mjs');
  const commandArgs = [
    scriptPath,
    '--run_id', args.run_id,
    '--review_in', syntheticReviewPath,
    '--out', outDir,
    '--variant', 'variant1',
    '--seed', args.seed,
    '--limit_internal', String(selectedCounts.internal),
    '--limit_lapa', String(selectedCounts.lapa),
    '--limit_celeba', String(selectedCounts.celebamaskhq),
    '--internal_dir', args.internal_dir,
    '--cache_dir', args.cache_dir,
    '--max_edge', String(args.max_edge),
    '--concurrency', String(args.concurrency),
    '--module_box_mode', args.module_box_mode,
    '--require_dynamic_boxes', String(args.require_dynamic_boxes),
    '--exclude_template_like', String(args.exclude_template_like),
    '--min_geometry_qc_score', String(args.min_geometry_qc_score),
    '--template_match_eps', String(args.template_match_eps),
    '--hard_filter_gate', String(args.hard_filter_gate),
    '--hard_filter_require_quality_pass', String(args.hard_filter_require_quality_pass),
    '--hard_filter_max_guarded_modules', String(args.hard_filter_max_guarded_modules),
    '--hard_filter_min_module_pixels', String(args.hard_filter_min_module_pixels),
    '--hard_filter_min_dynamic_score', String(args.hard_filter_min_dynamic_score),
    '--hard_filter_min_box_plausibility', String(args.hard_filter_min_box_plausibility),
    '--hard_filter_min_mask_rle_ratio', String(args.hard_filter_min_mask_rle_ratio),
    '--hard_filter_min_face_span_h', String(args.hard_filter_min_face_span_h),
    '--hard_filter_min_face_span_w', String(args.hard_filter_min_face_span_w),
    '--hard_filter_min_face_span_area', String(args.hard_filter_min_face_span_area),
    '--hard_filter_require_onnx_skinmask', String(args.hard_filter_require_onnx_skinmask),
    '--hard_filter_min_overlap_score', String(args.hard_filter_min_overlap_score),
    '--hard_filter_max_abs_yaw', String(args.hard_filter_max_abs_yaw),
    '--hard_filter_require_all_strong_modules', String(args.hard_filter_require_all_strong_modules),
    '--hard_filter_fail_on_empty', String(args.hard_filter_fail_on_empty),
    '--skinmask_onnx_enabled', String(args.skinmask_onnx_enabled),
    '--skinmask_onnx_strict', String(args.skinmask_onnx_strict),
    '--skinmask_model_path', String(args.skinmask_model_path),
    '--skinmask_timeout_ms', String(args.skinmask_timeout_ms),
  ];
  if (args.mock_pipeline) {
    commandArgs.push('--mock_pipeline', 'true');
  }

  const { stdout, stderr } = await runExecFile('node', commandArgs, {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 20,
  });

  const parseLastJsonObject = (text) => {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      // Continue and try to parse the last JSON object from mixed stdout.
    }
    let cursor = raw.lastIndexOf('{');
    while (cursor >= 0) {
      const slice = raw.slice(cursor).trim();
      try {
        return JSON.parse(slice);
      } catch (_) {
        cursor = raw.lastIndexOf('{', cursor - 1);
      }
    }
    return null;
  };

  const parsedSummary = parseLastJsonObject(stdout);

  if (!parsedSummary || typeof parsedSummary !== 'object') {
    throw new Error(`preference_pack_no_summary:${String(stderr || '').trim() || 'unknown'}`);
  }

  return parsedSummary;
}

async function ensureJpegThumb({ srcPath, dstPath, maxEdge }) {
  await fsp.mkdir(path.dirname(dstPath), { recursive: true });
  await sharp(srcPath, { failOn: 'none' })
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(dstPath);
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  return runTimestampKey();
}

function parseArgs(argv) {
  const out = {
    help: false,
    run_id: process.env.RUN_ID || '',
    out: process.env.OUT || '',
    seed: process.env.PREFERENCE_SEED || DEFAULTS.seed,
    internal_dir: process.env.INTERNAL_DIR || '',
    external_index_lapa: process.env.EXTERNAL_INDEX_LAPA || DEFAULTS.external_index_lapa,
    external_index_celeba: process.env.EXTERNAL_INDEX_CELEBA || DEFAULTS.external_index_celeba,
    review_pack_jsonl: process.env.REVIEW_PACK_JSONL || process.env.REVIEW_JSONL || '',
    cache_dir: process.env.CACHE_DIR || DEFAULTS.cache_dir,
    limit_internal: process.env.LIMIT_INTERNAL || DEFAULTS.limit_internal,
    limit_lapa: process.env.LIMIT_LAPA || DEFAULTS.limit_lapa,
    limit_celeba: process.env.LIMIT_CELEBA || DEFAULTS.limit_celeba,
    target_total: process.env.TARGET_TOTAL || DEFAULTS.target_total,
    overlap_ratio: process.env.OVERLAP_RATIO || process.env.IAA_RATIO || DEFAULTS.overlap_ratio,
    overlap_min: process.env.OVERLAP_MIN || DEFAULTS.overlap_min,
    max_edge: process.env.MAX_EDGE || DEFAULTS.max_edge,
    concurrency: process.env.EVAL_CONCURRENCY || process.env.CONCURRENCY || DEFAULTS.concurrency,
    module_box_mode: process.env.PREFERENCE_MODULE_BOX_MODE || DEFAULTS.module_box_mode,
    require_dynamic_boxes: process.env.PREFERENCE_REQUIRE_DYNAMIC_BOXES || String(DEFAULTS.require_dynamic_boxes),
    exclude_template_like: process.env.PREFERENCE_EXCLUDE_TEMPLATE_LIKE || String(DEFAULTS.exclude_template_like),
    min_geometry_qc_score: process.env.PREFERENCE_MIN_GEOMETRY_QC_SCORE || DEFAULTS.min_geometry_qc_score,
    template_match_eps: process.env.PREFERENCE_TEMPLATE_MATCH_EPS || DEFAULTS.template_match_eps,
    hard_filter_gate: process.env.PREFERENCE_HARD_FILTER_GATE || String(DEFAULTS.hard_filter_gate),
    hard_filter_require_quality_pass: process.env.PREFERENCE_HARD_FILTER_REQUIRE_QUALITY_PASS || String(DEFAULTS.hard_filter_require_quality_pass),
    hard_filter_max_guarded_modules: process.env.PREFERENCE_HARD_FILTER_MAX_GUARDED_MODULES || DEFAULTS.hard_filter_max_guarded_modules,
    hard_filter_min_module_pixels: process.env.PREFERENCE_HARD_FILTER_MIN_MODULE_PIXELS || DEFAULTS.hard_filter_min_module_pixels,
    hard_filter_min_dynamic_score: process.env.PREFERENCE_HARD_FILTER_MIN_DYNAMIC_SCORE || DEFAULTS.hard_filter_min_dynamic_score,
    hard_filter_min_box_plausibility: process.env.PREFERENCE_HARD_FILTER_MIN_BOX_PLAUSIBILITY || DEFAULTS.hard_filter_min_box_plausibility,
    hard_filter_min_mask_rle_ratio: process.env.PREFERENCE_HARD_FILTER_MIN_MASK_RLE_RATIO || DEFAULTS.hard_filter_min_mask_rle_ratio,
    hard_filter_min_face_span_h: process.env.PREFERENCE_HARD_FILTER_MIN_FACE_SPAN_H || DEFAULTS.hard_filter_min_face_span_h,
    hard_filter_min_face_span_w: process.env.PREFERENCE_HARD_FILTER_MIN_FACE_SPAN_W || DEFAULTS.hard_filter_min_face_span_w,
    hard_filter_min_face_span_area: process.env.PREFERENCE_HARD_FILTER_MIN_FACE_SPAN_AREA || DEFAULTS.hard_filter_min_face_span_area,
    hard_filter_require_onnx_skinmask:
      process.env.PREFERENCE_HARD_FILTER_REQUIRE_ONNX_SKINMASK || DEFAULTS.hard_filter_require_onnx_skinmask,
    hard_filter_min_overlap_score:
      process.env.PREFERENCE_HARD_FILTER_MIN_OVERLAP_SCORE || DEFAULTS.hard_filter_min_overlap_score,
    hard_filter_max_abs_yaw:
      process.env.PREFERENCE_HARD_FILTER_MAX_ABS_YAW || DEFAULTS.hard_filter_max_abs_yaw,
    hard_filter_require_all_strong_modules: process.env.PREFERENCE_HARD_FILTER_REQUIRE_ALL_STRONG_MODULES || String(DEFAULTS.hard_filter_require_all_strong_modules),
    hard_filter_fail_on_empty: process.env.PREFERENCE_HARD_FILTER_FAIL_ON_EMPTY || String(DEFAULTS.hard_filter_fail_on_empty),
    skinmask_onnx_enabled: process.env.PREFERENCE_SKINMASK_ONNX_ENABLED || String(DEFAULTS.skinmask_onnx_enabled),
    skinmask_onnx_strict: process.env.PREFERENCE_SKINMASK_ONNX_STRICT || String(DEFAULTS.skinmask_onnx_strict),
    skinmask_model_path: process.env.PREFERENCE_SKINMASK_MODEL_PATH || DEFAULTS.skinmask_model_path,
    skinmask_timeout_ms: process.env.PREFERENCE_SKINMASK_TIMEOUT_MS || DEFAULTS.skinmask_timeout_ms,
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULTS.report_dir,
    mock_pipeline: process.env.MOCK_PIPELINE || process.env.PREF_MOCK_PIPELINE || String(DEFAULTS.mock_pipeline),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
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

  out.help = parseBool(out.help, false);
  out.run_id = String(out.run_id || '').trim();
  out.out = String(out.out || '').trim();
  out.seed = String(out.seed || DEFAULTS.seed).trim() || DEFAULTS.seed;
  out.internal_dir = String(out.internal_dir || '').trim();
  out.external_index_lapa = String(out.external_index_lapa || DEFAULTS.external_index_lapa).trim();
  out.external_index_celeba = String(out.external_index_celeba || DEFAULTS.external_index_celeba).trim();
  out.review_pack_jsonl = String(out.review_pack_jsonl || '').trim();
  out.cache_dir = String(out.cache_dir || DEFAULTS.cache_dir).trim();
  out.limit_internal = Math.max(0, Math.min(100000, Math.trunc(parseNumber(out.limit_internal, DEFAULTS.limit_internal, 0, 100000))));
  out.limit_lapa = Math.max(0, Math.min(100000, Math.trunc(parseNumber(out.limit_lapa, DEFAULTS.limit_lapa, 0, 100000))));
  out.limit_celeba = Math.max(0, Math.min(100000, Math.trunc(parseNumber(out.limit_celeba, DEFAULTS.limit_celeba, 0, 100000))));
  out.target_total = Math.max(1, Math.min(200000, Math.trunc(parseNumber(out.target_total, DEFAULTS.target_total, 1, 200000))));
  out.overlap_ratio = clamp01(out.overlap_ratio);
  out.overlap_min = Math.max(0, Math.min(200000, Math.trunc(parseNumber(out.overlap_min, DEFAULTS.overlap_min, 0, 200000))));
  out.max_edge = Math.max(256, Math.min(2048, Math.trunc(parseNumber(out.max_edge, DEFAULTS.max_edge, 256, 2048))));
  out.concurrency = Math.max(1, Math.min(16, Math.trunc(parseNumber(out.concurrency, DEFAULTS.concurrency, 1, 16))));
  out.module_box_mode = String(out.module_box_mode || DEFAULTS.module_box_mode).trim().toLowerCase();
  if (!['static', 'dynamic_skinmask', 'auto'].includes(out.module_box_mode)) out.module_box_mode = DEFAULTS.module_box_mode;
  out.require_dynamic_boxes = parseBool(out.require_dynamic_boxes, DEFAULTS.require_dynamic_boxes);
  out.exclude_template_like = parseBool(out.exclude_template_like, DEFAULTS.exclude_template_like);
  out.min_geometry_qc_score = clamp01(parseNumber(out.min_geometry_qc_score, DEFAULTS.min_geometry_qc_score, 0, 1));
  out.template_match_eps = Math.max(0, Math.min(0.05, parseNumber(out.template_match_eps, DEFAULTS.template_match_eps, 0, 0.05)));
  out.hard_filter_gate = parseBool(out.hard_filter_gate, DEFAULTS.hard_filter_gate);
  out.hard_filter_require_quality_pass = parseBool(
    out.hard_filter_require_quality_pass,
    DEFAULTS.hard_filter_require_quality_pass,
  );
  out.hard_filter_max_guarded_modules = Math.max(
    0,
    Math.min(32, Math.trunc(parseNumber(
      out.hard_filter_max_guarded_modules,
      DEFAULTS.hard_filter_max_guarded_modules,
      0,
      32,
    ))),
  );
  out.hard_filter_min_module_pixels = Math.max(
    0,
    Math.min(4096, Math.trunc(parseNumber(
      out.hard_filter_min_module_pixels,
      DEFAULTS.hard_filter_min_module_pixels,
      0,
      4096,
    ))),
  );
  out.hard_filter_min_dynamic_score = clamp01(parseNumber(
    out.hard_filter_min_dynamic_score,
    DEFAULTS.hard_filter_min_dynamic_score,
    0,
    1,
  ));
  out.hard_filter_min_box_plausibility = clamp01(parseNumber(
    out.hard_filter_min_box_plausibility,
    DEFAULTS.hard_filter_min_box_plausibility,
    0,
    1,
  ));
  out.hard_filter_min_mask_rle_ratio = clamp01(parseNumber(
    out.hard_filter_min_mask_rle_ratio,
    DEFAULTS.hard_filter_min_mask_rle_ratio,
    0,
    1,
  ));
  out.hard_filter_min_face_span_h = clamp01(parseNumber(
    out.hard_filter_min_face_span_h,
    DEFAULTS.hard_filter_min_face_span_h,
    0,
    1,
  ));
  out.hard_filter_min_face_span_w = clamp01(parseNumber(
    out.hard_filter_min_face_span_w,
    DEFAULTS.hard_filter_min_face_span_w,
    0,
    1,
  ));
  out.hard_filter_min_face_span_area = clamp01(parseNumber(
    out.hard_filter_min_face_span_area,
    DEFAULTS.hard_filter_min_face_span_area,
    0,
    1,
  ));
  out.hard_filter_require_onnx_skinmask = parseBool(
    out.hard_filter_require_onnx_skinmask,
    DEFAULTS.hard_filter_require_onnx_skinmask,
  );
  out.hard_filter_min_overlap_score = clamp01(parseNumber(
    out.hard_filter_min_overlap_score,
    DEFAULTS.hard_filter_min_overlap_score,
    0,
    1,
  ));
  out.hard_filter_max_abs_yaw = clamp01(parseNumber(
    out.hard_filter_max_abs_yaw,
    DEFAULTS.hard_filter_max_abs_yaw,
    0,
    1,
  ));
  out.hard_filter_require_all_strong_modules = parseBool(
    out.hard_filter_require_all_strong_modules,
    DEFAULTS.hard_filter_require_all_strong_modules,
  );
  out.hard_filter_fail_on_empty = parseBool(
    out.hard_filter_fail_on_empty,
    DEFAULTS.hard_filter_fail_on_empty,
  );
  out.skinmask_onnx_enabled = parseBool(out.skinmask_onnx_enabled, DEFAULTS.skinmask_onnx_enabled);
  out.skinmask_onnx_strict = parseBool(out.skinmask_onnx_strict, DEFAULTS.skinmask_onnx_strict);
  out.skinmask_model_path = String(out.skinmask_model_path || DEFAULTS.skinmask_model_path).trim();
  out.skinmask_timeout_ms = Math.max(
    50,
    Math.min(60000, Math.trunc(parseNumber(out.skinmask_timeout_ms, DEFAULTS.skinmask_timeout_ms, 50, 60000))),
  );
  out.report_dir = String(out.report_dir || DEFAULTS.report_dir).trim() || DEFAULTS.report_dir;
  out.mock_pipeline = parseBool(out.mock_pipeline, DEFAULTS.mock_pipeline);

  // Backward compatibility: --iaa_ratio can be passed by older make targets.
  const iaaIdx = argv.findIndex((token) => String(token) === '--iaa_ratio');
  if (iaaIdx >= 0 && argv[iaaIdx + 1] && !String(argv[iaaIdx + 1]).startsWith('--')) {
    out.overlap_ratio = clamp01(argv[iaaIdx + 1]);
  }
  return out;
}

function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  const nx = Math.max(0, Math.min(1, x));
  const ny = Math.max(0, Math.min(1, y));
  const nw = Math.max(0, Math.min(1 - nx, w));
  const nh = Math.max(0, Math.min(1 - ny, h));
  if (nw <= 0 || nh <= 0) return null;
  return {
    x: round3(nx),
    y: round3(ny),
    w: round3(nw),
    h: round3(nh),
  };
}

function moduleRowsToMap(moduleRows) {
  const map = new Map();
  for (const row of Array.isArray(moduleRows) ? moduleRows : []) {
    if (!row || typeof row !== 'object') continue;
    const moduleId = String(row.module_id || '').trim();
    if (!moduleId) continue;
    map.set(moduleId, {
      module_id: moduleId,
      box: normalizeBox(row.box),
      mask_grid: Math.max(16, Math.min(512, Math.trunc(Number(row.mask_grid) || 64))),
      mask_rle_norm: typeof row.mask_rle_norm === 'string' ? row.mask_rle_norm : null,
    });
  }
  return map;
}

function materializeMask(moduleRow, grid) {
  const size = Math.max(16, Math.min(512, Math.trunc(Number(grid) || 64)));
  if (!moduleRow || typeof moduleRow !== 'object') return new Uint8Array(size * size);
  const rowGrid = Math.max(16, Math.min(512, Math.trunc(Number(moduleRow.mask_grid) || size)));

  if (moduleRow.mask_rle_norm && rowGrid === size) {
    try {
      const decoded = decodeRleBinary(moduleRow.mask_rle_norm, size * size);
      if (decoded && decoded.length === size * size) return decoded;
    } catch (_error) {
      // Fallback to bbox path.
    }
  }

  const box = normalizeBox(moduleRow.box);
  if (box) {
    return bboxNormToMask(box, size, size);
  }
  return new Uint8Array(size * size);
}

function computeMaskBoundingBox(mask, grid) {
  let minX = grid;
  let minY = grid;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      const idx = y * grid + x;
      if (!mask[idx]) continue;
      pixels += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (pixels <= 0 || maxX < minX || maxY < minY) {
    return {
      x: 0,
      y: 0,
      w: grid,
      h: grid,
      pixels: 0,
    };
  }
  return {
    x: minX,
    y: minY,
    w: (maxX - minX + 1),
    h: (maxY - minY + 1),
    pixels,
  };
}

function computeBoundaryMask(mask, grid) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      const idx = y * grid + x;
      if (!mask[idx]) continue;
      const left = x === 0 ? 0 : mask[idx - 1];
      const right = x === grid - 1 ? 0 : mask[idx + 1];
      const up = y === 0 ? 0 : mask[idx - grid];
      const down = y === grid - 1 ? 0 : mask[idx + grid];
      if (!left || !right || !up || !down) out[idx] = 1;
    }
  }
  return out;
}

function setPixelRGBA(buffer, width, height, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = ((y * width) + x) * 4;
  const prevA = Number(buffer[offset + 3] || 0) / 255;
  const alpha = Math.max(0, Math.min(1, Number(a || 0) / 255));
  const nextA = alpha + (prevA * (1 - alpha));
  if (nextA <= 0) return;
  const blend = (src, dst) => Math.round(((src * alpha) + (dst * prevA * (1 - alpha))) / nextA);
  buffer[offset + 0] = blend(Number(r || 0), Number(buffer[offset + 0] || 0));
  buffer[offset + 1] = blend(Number(g || 0), Number(buffer[offset + 1] || 0));
  buffer[offset + 2] = blend(Number(b || 0), Number(buffer[offset + 2] || 0));
  buffer[offset + 3] = Math.round(nextA * 255);
}

function paintCellRect(buffer, width, height, x0, y0, x1, y1, color, alpha, patternFn = null) {
  const minX = Math.max(0, Math.min(width - 1, Math.trunc(x0)));
  const minY = Math.max(0, Math.min(height - 1, Math.trunc(y0)));
  const maxX = Math.max(0, Math.min(width - 1, Math.trunc(x1)));
  const maxY = Math.max(0, Math.min(height - 1, Math.trunc(y1)));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (typeof patternFn === 'function' && !patternFn(x, y)) continue;
      setPixelRGBA(buffer, width, height, x, y, color.r, color.g, color.b, alpha);
    }
  }
}

function percentile(values, p) {
  const list = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!list.length) return null;
  const pos = (list.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return list[lo];
  const frac = pos - lo;
  return (list[lo] * (1 - frac)) + (list[hi] * frac);
}

function computeOverlayDiffStats({ baselineModuleRows, variantModuleRows }) {
  const baselineMap = moduleRowsToMap(baselineModuleRows);
  const variantMap = moduleRowsToMap(variantModuleRows);
  const moduleIds = MODULE_IDS.filter((moduleId) => baselineMap.has(moduleId) || variantMap.has(moduleId));
  const perModule = {};
  let focus = null;

  for (const moduleId of moduleIds) {
    const rowA = baselineMap.get(moduleId) || null;
    const rowB = variantMap.get(moduleId) || null;
    const grid = Math.max(
      16,
      Math.min(
        512,
        Math.trunc(
          Math.max(
            Number(rowA && rowA.mask_grid) || 0,
            Number(rowB && rowB.mask_grid) || 0,
            64,
          ),
        ),
      ),
    );
    const maskA = materializeMask(rowA, grid);
    const maskB = materializeMask(rowB, grid);
    const unionMask = new Uint8Array(grid * grid);
    const diffMask = new Uint8Array(grid * grid);
    let unionPixels = 0;
    let diffPixels = 0;
    for (let i = 0; i < unionMask.length; i += 1) {
      const a = maskA[i] ? 1 : 0;
      const b = maskB[i] ? 1 : 0;
      const u = (a || b) ? 1 : 0;
      const d = (a ^ b) ? 1 : 0;
      unionMask[i] = u;
      diffMask[i] = d;
      if (u) unionPixels += 1;
      if (d) diffPixels += 1;
    }

    const bbox = computeMaskBoundingBox(unionMask, grid);
    const diffRatio = diffPixels / Math.max(1, unionPixels);
    const moduleStats = {
      module_id: moduleId,
      grid,
      union_pixels: unionPixels,
      diff_pixels: diffPixels,
      diff_ratio: round3(diffRatio),
      bbox: {
        x: bbox.x,
        y: bbox.y,
        w: bbox.w,
        h: bbox.h,
      },
      has_signal: unionPixels > 0,
    };
    perModule[moduleId] = moduleStats;

    const focusKey = `${String(moduleStats.diff_pixels).padStart(8, '0')}:${String(moduleStats.diff_ratio).padStart(8, '0')}:${moduleId}`;
    if (!focus) {
      focus = {
        module_id: moduleId,
        key: focusKey,
        grid,
        mask_a: maskA,
        mask_b: maskB,
        diff_mask: diffMask,
        union_mask: unionMask,
        boundary_a: computeBoundaryMask(maskA, grid),
        boundary_b: computeBoundaryMask(maskB, grid),
        bbox: moduleStats.bbox,
        diff_pixels: diffPixels,
        diff_ratio: moduleStats.diff_ratio,
      };
      continue;
    }
    if (focusKey > focus.key) {
      focus = {
        module_id: moduleId,
        key: focusKey,
        grid,
        mask_a: maskA,
        mask_b: maskB,
        diff_mask: diffMask,
        union_mask: unionMask,
        boundary_a: computeBoundaryMask(maskA, grid),
        boundary_b: computeBoundaryMask(maskB, grid),
        bbox: moduleStats.bbox,
        diff_pixels: diffPixels,
        diff_ratio: moduleStats.diff_ratio,
      };
    }
  }

  if (!focus) {
    const grid = 64;
    const empty = new Uint8Array(grid * grid);
    focus = {
      module_id: 'none',
      key: '',
      grid,
      mask_a: empty,
      mask_b: empty,
      diff_mask: empty,
      union_mask: empty,
      boundary_a: empty,
      boundary_b: empty,
      bbox: { x: 0, y: 0, w: grid, h: grid },
      diff_pixels: 0,
      diff_ratio: 0,
    };
  }

  return {
    overlay_focus_module: focus.module_id,
    overlay_diff_pixels: focus.diff_pixels,
    overlay_diff_ratio: round3(focus.diff_ratio),
    overlay_bbox: {
      x: focus.bbox.x,
      y: focus.bbox.y,
      w: focus.bbox.w,
      h: focus.bbox.h,
      grid: focus.grid,
      units: 'grid',
    },
    overlay_zoom: null,
    overlay_diff_modules: perModule,
    _focus: focus,
  };
}

async function applyContourDiffInset({
  baseImagePath,
  targetImagePaths,
  overlayStats,
}) {
  const focus = overlayStats && overlayStats._focus ? overlayStats._focus : null;
  if (!focus) return null;
  const baseBuffer = await fsp.readFile(baseImagePath);
  const baseMeta = await sharp(baseBuffer, { failOn: 'none' }).metadata();
  const width = Math.max(1, Math.trunc(Number(baseMeta.width) || 1));
  const height = Math.max(1, Math.trunc(Number(baseMeta.height) || 1));
  const grid = Math.max(16, Math.min(512, Math.trunc(Number(focus.grid) || 64)));

  const bbox = focus.bbox || { x: 0, y: 0, w: grid, h: grid };
  const side = Math.max(1, Math.max(Number(bbox.w || 0), Number(bbox.h || 0)));
  const margin = Math.max(1, Math.trunc(side * 0.1));
  const x0 = Math.max(0, Math.min(grid - 1, Math.trunc(Number(bbox.x || 0) - margin)));
  const y0 = Math.max(0, Math.min(grid - 1, Math.trunc(Number(bbox.y || 0) - margin)));
  const x1 = Math.max(0, Math.min(grid - 1, Math.trunc(Number(bbox.x || 0) + Number(bbox.w || 1) - 1 + margin)));
  const y1 = Math.max(0, Math.min(grid - 1, Math.trunc(Number(bbox.y || 0) + Number(bbox.h || 1) - 1 + margin)));
  const bw = Math.max(1, x1 - x0 + 1);
  const bh = Math.max(1, y1 - y0 + 1);

  const cropLeft = Math.max(0, Math.min(width - 1, Math.floor((x0 / grid) * width)));
  const cropTop = Math.max(0, Math.min(height - 1, Math.floor((y0 / grid) * height)));
  const cropRight = Math.max(cropLeft + 1, Math.min(width, Math.ceil(((x1 + 1) / grid) * width)));
  const cropBottom = Math.max(cropTop + 1, Math.min(height, Math.ceil(((y1 + 1) / grid) * height)));
  const cropW = Math.max(1, cropRight - cropLeft);
  const cropH = Math.max(1, cropBottom - cropTop);

  const insetMaxW = Math.max(96, Math.min(Math.trunc(width * 0.42), 300));
  const insetMaxH = Math.max(96, Math.min(Math.trunc(height * 0.42), 300));
  const zoomScaleRaw = Math.min(
    3,
    insetMaxW / Math.max(1, cropW),
    insetMaxH / Math.max(1, cropH),
  );
  const zoomScale = Math.max(2, zoomScaleRaw);
  const insetW = Math.max(80, Math.min(insetMaxW, Math.round(cropW * zoomScale)));
  const insetH = Math.max(80, Math.min(insetMaxH, Math.round(cropH * zoomScale)));
  const overlayZoom = round3(Math.min(insetW / Math.max(1, cropW), insetH / Math.max(1, cropH)));

  const insetBase = await sharp(baseBuffer, { failOn: 'none' })
    .extract({
      left: cropLeft,
      top: cropTop,
      width: cropW,
      height: cropH,
    })
    .resize({
      width: insetW,
      height: insetH,
      fit: 'fill',
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();

  const overlayRaw = Buffer.alloc(insetW * insetH * 4, 0);
  const boundaryA = focus.boundary_a;
  const boundaryB = focus.boundary_b;
  const maskA = focus.mask_a;
  const maskB = focus.mask_b;

  for (let gy = y0; gy <= y1; gy += 1) {
    for (let gx = x0; gx <= x1; gx += 1) {
      const gridIdx = gy * grid + gx;
      const localX0 = Math.max(0, Math.min(insetW - 1, Math.floor(((gx - x0) / bw) * insetW)));
      const localY0 = Math.max(0, Math.min(insetH - 1, Math.floor(((gy - y0) / bh) * insetH)));
      const localX1 = Math.max(localX0, Math.min(insetW - 1, Math.ceil((((gx + 1) - x0) / bw) * insetW) - 1));
      const localY1 = Math.max(localY0, Math.min(insetH - 1, Math.ceil((((gy + 1) - y0) / bh) * insetH) - 1));

      const a = maskA[gridIdx] ? 1 : 0;
      const b = maskB[gridIdx] ? 1 : 0;
      if (a && !b) {
        paintCellRect(overlayRaw, insetW, insetH, localX0, localY0, localX1, localY1, { r: 255, g: 66, b: 66 }, 64);
      } else if (!a && b) {
        paintCellRect(overlayRaw, insetW, insetH, localX0, localY0, localX1, localY1, { r: 66, g: 214, b: 255 }, 64);
      }
      if (boundaryA[gridIdx]) {
        paintCellRect(overlayRaw, insetW, insetH, localX0, localY0, localX1, localY1, { r: 255, g: 88, b: 88 }, 220);
      }
      if (boundaryB[gridIdx]) {
        paintCellRect(
          overlayRaw,
          insetW,
          insetH,
          localX0,
          localY0,
          localX1,
          localY1,
          { r: 60, g: 220, b: 255 },
          220,
          (x, y) => ((x + y) % 2 === 0),
        );
      }
    }
  }

  const overlayPng = await sharp(overlayRaw, {
    raw: {
      width: insetW,
      height: insetH,
      channels: 4,
    },
  }).png().toBuffer();

  const legendSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${insetW}" height="${insetH}" viewBox="0 0 ${insetW} ${insetH}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" width="${Math.max(1, insetW - 1)}" height="${Math.max(1, insetH - 1)}" fill="none" stroke="#FFFFFF" stroke-width="1.5"/>
  <rect x="6" y="6" width="10" height="10" fill="#FF5A5A" opacity="0.85"/>
  <text x="20" y="15" fill="#FFFFFF" font-size="10" font-family="Menlo, monospace">A solid</text>
  <rect x="74" y="6" width="10" height="10" fill="#3CDCFf" opacity="0.85"/>
  <text x="88" y="15" fill="#FFFFFF" font-size="10" font-family="Menlo, monospace">B dashed</text>
</svg>`;

  const insetComposed = await sharp(insetBase, { failOn: 'none' })
    .composite([
      { input: overlayPng, blend: 'over' },
      { input: Buffer.from(legendSvg), blend: 'over' },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  const insetLeft = Math.max(0, width - insetW - 8);
  const insetTop = 8;
  const uniqueTargets = [...new Set(
    (Array.isArray(targetImagePaths) ? targetImagePaths : [])
      .map((item) => path.resolve(String(item || '')))
      .filter(Boolean),
  )];
  await Promise.all(uniqueTargets.map(async (targetPath) => {
    const buf = await fsp.readFile(targetPath);
    await sharp(buf, { failOn: 'none' })
      .composite([{ input: insetComposed, left: insetLeft, top: insetTop, blend: 'over' }])
      .png({ compressionLevel: 9 })
      .toFile(targetPath);
  }));

  return {
    overlay_zoom: overlayZoom,
    inset: {
      left: insetLeft,
      top: insetTop,
      width: insetW,
      height: insetH,
    },
  };
}

function summarizeOverlayDiff(rows) {
  const summaryByModule = {};
  for (const moduleId of MODULE_IDS) {
    const ratios = rows
      .map((row) => row && row.overlay_diff_modules && row.overlay_diff_modules[moduleId] ? row.overlay_diff_modules[moduleId].diff_ratio : null)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (!ratios.length) {
      summaryByModule[moduleId] = {
        count: 0,
        mean: null,
        p50: null,
        p90: null,
        low_separability_rate: null,
      };
      continue;
    }
    const mean = ratios.reduce((acc, value) => acc + value, 0) / ratios.length;
    summaryByModule[moduleId] = {
      count: ratios.length,
      mean: round3(mean),
      p50: round3(percentile(ratios, 0.5)),
      p90: round3(percentile(ratios, 0.9)),
      low_separability_rate: round3(ratios.filter((value) => value < 0.01).length / ratios.length),
    };
  }

  const overall = rows
    .map((row) => Number(row.overlay_diff_ratio))
    .filter((value) => Number.isFinite(value));

  return {
    by_module: summaryByModule,
    overall: {
      count: overall.length,
      mean: overall.length ? round3(overall.reduce((acc, value) => acc + value, 0) / overall.length) : null,
      p50: overall.length ? round3(percentile(overall, 0.5)) : null,
      p90: overall.length ? round3(percentile(overall, 0.9)) : null,
      low_separability_rate: overall.length ? round3(overall.filter((value) => value < 0.01).length / overall.length) : null,
    },
  };
}

function assignBatches(rows, seed, overlapRatio, overlapMin) {
  const ordered = deterministicSort(rows, `${seed}:assignment`, (row) => `${row.sample_id}`);
  const total = ordered.length;
  const overlapTarget = Math.round(total * overlapRatio);
  const overlapCount = Math.min(total, Math.max(overlapMin, overlapTarget));
  const overlapSet = new Set(ordered.slice(0, overlapCount).map((row) => row.sample_id));

  const nonOverlap = ordered.filter((row) => !overlapSet.has(row.sample_id));
  const batchMap = new Map();
  const batchA = [];
  const batchB = [];
  const overlapRows = [];

  for (const row of ordered) {
    if (overlapSet.has(row.sample_id)) {
      batchMap.set(row.sample_id, 'OVERLAP');
      overlapRows.push(row);
      batchA.push(row);
      batchB.push(row);
      continue;
    }
  }

  nonOverlap.forEach((row, idx) => {
    const batch = idx % 2 === 0 ? 'A' : 'B';
    batchMap.set(row.sample_id, batch);
    if (batch === 'A') batchA.push(row);
    if (batch === 'B') batchB.push(row);
  });

  return {
    ordered,
    batch_map: batchMap,
    overlap_rows: overlapRows,
    overlap_sample_ids: overlapRows.map((row) => row.sample_id),
    tasks_batch_a_rows: batchA,
    tasks_batch_b_rows: batchB,
    overlap_count: overlapRows.length,
  };
}

function renderPreview({ runId, manifest }) {
  const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
  const sample = deterministicSort(rows, `${manifest.seed}:preview`, (row) => `${row.sample_id}`).slice(0, 20);
  const overlaySummary = manifest.overlay_diff_summary && typeof manifest.overlay_diff_summary === 'object'
    ? manifest.overlay_diff_summary
    : summarizeOverlayDiff(rows);
  const lines = [];
  lines.push('# Preference Round1 Real Pack Preview');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- total_samples: ${rows.length}`);
  lines.push(`- source_breakdown: internal=${manifest.source_breakdown.internal}, lapa=${manifest.source_breakdown.lapa}, celebamaskhq=${manifest.source_breakdown.celebamaskhq}`);
  lines.push(`- overlap_count: ${manifest.overlap.overlap_count}`);
  lines.push(`- overlap_ratio: ${manifest.overlap.overlap_ratio}`);
  lines.push(`- batch_a_total: ${manifest.batch_counts.batch_a_total}`);
  lines.push(`- batch_b_total: ${manifest.batch_counts.batch_b_total}`);
  lines.push(`- overlay_diff_overall_mean: ${overlaySummary.overall && overlaySummary.overall.mean != null ? overlaySummary.overall.mean : '-'}`);
  lines.push(`- overlay_diff_overall_p50: ${overlaySummary.overall && overlaySummary.overall.p50 != null ? overlaySummary.overall.p50 : '-'}`);
  lines.push(`- overlay_diff_overall_p90: ${overlaySummary.overall && overlaySummary.overall.p90 != null ? overlaySummary.overall.p90 : '-'}`);
  lines.push(`- overlay_low_separability_rate(<0.01): ${overlaySummary.overall && overlaySummary.overall.low_separability_rate != null ? overlaySummary.overall.low_separability_rate : '-'}`);
  lines.push('');
  lines.push('## Overlay Diff Summary By Module');
  lines.push('');
  lines.push('| module | n | diff_ratio_mean | diff_ratio_p50 | diff_ratio_p90 | low_separability_rate(<0.01) |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  MODULE_IDS.forEach((moduleId) => {
    const row = overlaySummary.by_module && overlaySummary.by_module[moduleId] ? overlaySummary.by_module[moduleId] : null;
    lines.push(`| ${moduleId} | ${row && row.count != null ? row.count : 0} | ${row && row.mean != null ? row.mean : '-'} | ${row && row.p50 != null ? row.p50 : '-'} | ${row && row.p90 != null ? row.p90 : '-'} | ${row && row.low_separability_rate != null ? row.low_separability_rate : '-'} |`);
  });
  lines.push('');
  lines.push('## Preview 20 (deterministic)');
  lines.push('');
  lines.push('| rank | sample_id | source | task_batch | flip(A/B) | focus_module | diff_ratio | diff_pixels | bbox(x,y,w,h) | zoom | thumb | A | B | baseline_overlay | variant1_overlay |');
  lines.push('|---:|---|---|---|---|---|---:|---:|---|---:|---|---|---|---|---|');
  if (!sample.length) {
    lines.push('| 1 | - | - | - | - | - | - | - | - | - | - | - | - | - | - |');
  } else {
    sample.forEach((row, idx) => {
      const flipToken = row.role_a === 'variant' ? 'flipped' : 'not_flipped';
      const bbox = row.overlay_bbox && typeof row.overlay_bbox === 'object'
        ? `${row.overlay_bbox.x},${row.overlay_bbox.y},${row.overlay_bbox.w},${row.overlay_bbox.h}`
        : '-';
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.source} | ${row.task_batch || '-'} | ${flipToken} | ${row.overlay_focus_module || '-'} | ${row.overlay_diff_ratio ?? '-'} | ${row.overlay_diff_pixels ?? '-'} | ${bbox} | ${row.overlay_zoom ?? '-'} | ${toPosix(row.input_thumb_path_rel || '-')} | ${toPosix(row.image_a_path_rel || '-')} | ${toPosix(row.image_b_path_rel || '-')} | ${toPosix(row.overlay_baseline_path_rel || '-')} | ${toPosix(row.overlay_variant1_path_rel || '-')} |`);
    });
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }
  if (!args.internal_dir) {
    process.stderr.write('preference_round1_real_runbook: missing --internal_dir\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  args.run_id = runId;
  const outDir = path.resolve(args.out || path.join('artifacts', `preference_round1_${runId}`));
  const labelStudioDocumentRoot = path.resolve(
    String(process.env.LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT || outDir),
  );
  const reportDir = path.resolve(args.report_dir || DEFAULTS.report_dir);
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(reportDir, { recursive: true });

  const reviewRows = args.review_pack_jsonl
    ? await readReviewRows(path.resolve(args.review_pack_jsonl)).catch(() => [])
    : [];

  const internal = await collectInternalCandidates({
    internalDir: path.resolve(args.internal_dir),
    reviewRows,
    seed: args.seed,
  });
  const lapa = await collectExternalCandidates({
    source: 'lapa',
    indexPath: args.external_index_lapa,
    seed: args.seed,
  });
  const celeba = await collectExternalCandidates({
    source: 'celebamaskhq',
    indexPath: args.external_index_celeba,
    seed: args.seed,
  });

  const selectedBySource = {
    internal: pickWithLimit(internal.ordered, args.limit_internal).selected,
    lapa: pickWithLimit(lapa.ordered, args.limit_lapa).selected,
    celebamaskhq: pickWithLimit(celeba.ordered, args.limit_celeba).selected,
  };
  const leftoversBySource = {
    internal: pickWithLimit(internal.ordered, args.limit_internal).leftovers,
    lapa: pickWithLimit(lapa.ordered, args.limit_lapa).leftovers,
    celebamaskhq: pickWithLimit(celeba.ordered, args.limit_celeba).leftovers,
  };

  const backfilled = backfillSelections({
    selectedBySource,
    leftoversBySource,
    targetTotal: args.target_total,
    seed: args.seed,
  });

  const selectedRows = uniqueBySourceAndSample([
    ...backfilled.selectedBySource.internal,
    ...backfilled.selectedBySource.lapa,
    ...backfilled.selectedBySource.celebamaskhq,
  ]);
  const selectedSourceMap = new Map();
  for (const row of selectedRows) {
    selectedSourceMap.set(`${row.source}:${row.sample_hash}`, row);
  }

  const selectedCounts = {
    internal: backfilled.selectedBySource.internal.length,
    lapa: backfilled.selectedBySource.lapa.length,
    celebamaskhq: backfilled.selectedBySource.celebamaskhq.length,
  };

  const syntheticRows = buildSyntheticReviewRows(selectedRows);
  const syntheticReviewPath = path.join(outDir, '.inputs', `review_pack_preference_round1_real_${runId}.jsonl`);
  await writeJsonl(syntheticReviewPath, syntheticRows);

  const packSummary = await runPreferencePack({
    args,
    syntheticReviewPath,
    selectedCounts,
    outDir,
  });

  const tasksPath = path.join(outDir, 'tasks.json');
  const tasksAllPath = path.join(outDir, 'tasks_all.json');
  const tasksBatchAPath = path.join(outDir, 'tasks_batch_a.json');
  const tasksBatchBPath = path.join(outDir, 'tasks_batch_b.json');
  const tasksOverlapPath = path.join(outDir, 'tasks_overlap.json');
  const manifestPath = path.join(outDir, 'manifest.json');
  const previewPath = path.join(outDir, 'preview.md');
  const bundlesDir = path.join(outDir, 'bundles');
  const convertedDir = path.join(outDir, 'converted');

  const [tasksRaw, manifestRaw] = await Promise.all([
    fsp.readFile(tasksPath, 'utf8'),
    fsp.readFile(manifestPath, 'utf8'),
  ]);
  const tasks = JSON.parse(tasksRaw);
  const manifestFromPack = JSON.parse(manifestRaw);
  const rows = Array.isArray(manifestFromPack.rows) ? manifestFromPack.rows : [];

  const taskBySample = new Map();
  for (const task of tasks) {
    const sampleHash = String(task && task.data && task.data.sample_hash ? task.data.sample_hash : '').trim();
    if (!sampleHash) continue;
    taskBySample.set(sampleHash, task);
  }

  const sourcePathMap = new Map();
  for (const row of selectedRows) {
    sourcePathMap.set(`${row.source}:${row.sample_hash}`, row.abs_path);
  }

  const enrichedRows = [];
  const flipMap = {};

  for (const row of rows) {
    const sampleId = String(row.sample_hash || '').trim();
    if (!sampleId) continue;
    const task = taskBySample.get(sampleId);
    if (!task) continue;

    const bundleDir = path.join(bundlesDir, sampleId);
    await fsp.mkdir(bundleDir, { recursive: true });

    const imageAPath = path.resolve(String(row.image_a_path || task.data.image_a_path || ''));
    const imageBPath = path.resolve(String(row.image_b_path || task.data.image_b_path || ''));

    const baselineOverlaySrc = row.role_a === 'baseline' ? imageAPath : imageBPath;
    const variantOverlaySrc = row.role_a === 'variant' ? imageAPath : imageBPath;

    const baselineOverlayDst = path.join(bundleDir, 'baseline_overlay.png');
    const variantOverlayDst = path.join(bundleDir, 'variant1_overlay.png');

    await Promise.all([
      fsp.copyFile(baselineOverlaySrc, baselineOverlayDst),
      fsp.copyFile(variantOverlaySrc, variantOverlayDst),
    ]);

    const overlayStats = computeOverlayDiffStats({
      baselineModuleRows: row.baseline_module_rows,
      variantModuleRows: row.variant_module_rows,
    });
    const insetMeta = await applyContourDiffInset({
      baseImagePath: baselineOverlayDst,
      targetImagePaths: [
        imageAPath,
        imageBPath,
        baselineOverlayDst,
        variantOverlayDst,
      ],
      overlayStats,
    }).catch(() => null);
    if (insetMeta && insetMeta.overlay_zoom != null) {
      overlayStats.overlay_zoom = insetMeta.overlay_zoom;
    } else {
      overlayStats.overlay_zoom = 2;
    }

    const convertedCandidate = path.join(convertedDir, `${sampleId}.jpg`);
    const fallbackSource = sourcePathMap.get(`${row.source}:${sampleId}`) || imageAPath;
    const thumbSrc = fs.existsSync(convertedCandidate) ? convertedCandidate : fallbackSource;
    const thumbDst = path.join(bundleDir, 'input_thumb.jpg');
    await ensureJpegThumb({ srcPath: thumbSrc, dstPath: thumbDst, maxEdge: args.max_edge });

    const sourceRisk = selectedSourceMap.get(`${row.source}:${sampleId}`) || null;
    const minPixelsCandidates = [
      sourceRisk && sourceRisk.min_module_pixels,
      row.min_module_pixels,
      row.baseline_summary && row.baseline_summary.module_pixels_min,
      row.variant_summary && row.variant_summary.module_pixels_min,
    ]
      .map((value) => asNullableNumber(value))
      .filter((value) => value != null);
    const riskFeatures = {
      hair_overlap_est: asNullableNumber(
        (sourceRisk && sourceRisk.forehead_hair_overlap_rate)
        ?? row.hair_overlap_est
        ?? row.forehead_hair_overlap_est
        ?? null,
      ),
      leakage_bg_est_mean: asNullableNumber(
        (sourceRisk && sourceRisk.leakage_bg_est_mean)
        ?? row.leakage_bg_est_mean
        ?? null,
      ),
      min_module_pixels: minPixelsCandidates.length
        ? Math.max(0, Math.trunc(Math.min(...minPixelsCandidates)))
        : null,
      overlay_diff_pixels: asNullableNumber(overlayStats.overlay_diff_pixels),
      overlay_diff_ratio: asNullableNumber(overlayStats.overlay_diff_ratio),
      overlay_focus_module: overlayStats.overlay_focus_module || null,
    };
    const stats = {
      sample_id: sampleId,
      source: row.source,
      risk_features: riskFeatures,
      min_module_pixels: riskFeatures.min_module_pixels,
      leakage_bg_est_mean: riskFeatures.leakage_bg_est_mean,
      forehead_hair_overlap_est: riskFeatures.hair_overlap_est,
      overlay_focus_module: overlayStats.overlay_focus_module,
      overlay_diff_pixels: overlayStats.overlay_diff_pixels,
      overlay_diff_ratio: overlayStats.overlay_diff_ratio,
      overlay_bbox: overlayStats.overlay_bbox,
      overlay_zoom: overlayStats.overlay_zoom,
      overlay_diff_modules: overlayStats.overlay_diff_modules,
      baseline_summary: row.baseline_summary || null,
      variant1_summary: row.variant_summary || null,
    };
    const statsPath = path.join(bundleDir, 'sample_stats.json');
    await fsp.writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');

    const enriched = {
      ...row,
      sample_id: sampleId,
      bundle_dir: bundleDir,
      bundle_dir_rel: toPosix(path.relative(process.cwd(), bundleDir)),
      input_thumb_path: thumbDst,
      input_thumb_path_rel: toPosix(path.relative(process.cwd(), thumbDst)),
      overlay_baseline_path: baselineOverlayDst,
      overlay_baseline_path_rel: toPosix(path.relative(process.cwd(), baselineOverlayDst)),
      overlay_variant1_path: variantOverlayDst,
      overlay_variant1_path_rel: toPosix(path.relative(process.cwd(), variantOverlayDst)),
      image_a_path_rel: toPosix(path.relative(process.cwd(), imageAPath)),
      image_b_path_rel: toPosix(path.relative(process.cwd(), imageBPath)),
      stats_json_path: statsPath,
      stats_json_path_rel: toPosix(path.relative(process.cwd(), statsPath)),
      risk_features: riskFeatures,
      min_module_pixels: riskFeatures.min_module_pixels,
      leakage_bg_est_mean: riskFeatures.leakage_bg_est_mean,
      hair_overlap_est: riskFeatures.hair_overlap_est,
      overlay_focus_module: overlayStats.overlay_focus_module,
      overlay_diff_pixels: overlayStats.overlay_diff_pixels,
      overlay_diff_ratio: overlayStats.overlay_diff_ratio,
      overlay_bbox: overlayStats.overlay_bbox,
      overlay_zoom: overlayStats.overlay_zoom,
      overlay_diff_modules: overlayStats.overlay_diff_modules,
    };

    flipMap[sampleId] = {
      role_a: row.role_a,
      role_b: row.role_b,
      flipped: row.role_a === 'variant',
      a_variant_id: row.role_a === 'baseline' ? manifestFromPack.baseline_id : manifestFromPack.variant_id,
      b_variant_id: row.role_b === 'baseline' ? manifestFromPack.baseline_id : manifestFromPack.variant_id,
    };

    task.data.image_a = toLabelStudioLocalFilesUrl(imageAPath, { documentRoot: labelStudioDocumentRoot });
    task.data.image_b = toLabelStudioLocalFilesUrl(imageBPath, { documentRoot: labelStudioDocumentRoot });
    task.data.image_a_path = imageAPath;
    task.data.image_b_path = imageBPath;
    task.data.sample_id = sampleId;
    task.data.input_thumb = toLabelStudioLocalFilesUrl(thumbDst, { documentRoot: labelStudioDocumentRoot });
    task.data.input_thumb_path = thumbDst;
    task.data.baseline_overlay = toLabelStudioLocalFilesUrl(baselineOverlayDst, { documentRoot: labelStudioDocumentRoot });
    task.data.baseline_overlay_path = baselineOverlayDst;
    task.data.variant1_overlay = toLabelStudioLocalFilesUrl(variantOverlayDst, { documentRoot: labelStudioDocumentRoot });
    task.data.variant1_overlay_path = variantOverlayDst;
    task.data.overlay_focus_module = overlayStats.overlay_focus_module;
    task.data.overlay_diff_pixels = overlayStats.overlay_diff_pixels;
    task.data.overlay_diff_ratio = overlayStats.overlay_diff_ratio;
    task.data.overlay_bbox = overlayStats.overlay_bbox;
    task.data.overlay_zoom = overlayStats.overlay_zoom;

    enrichedRows.push(enriched);
  }

  const assignment = assignBatches(
    enrichedRows,
    args.seed,
    args.overlap_ratio,
    args.overlap_min,
  );
  const enrichedBySample = new Map(enrichedRows.map((row) => [row.sample_id, row]));
  const orderedRows = assignment.ordered
    .map((row) => enrichedBySample.get(row.sample_id))
    .filter(Boolean);

  for (const row of enrichedRows) {
    const taskBatch = assignment.batch_map.get(row.sample_id) || 'A';
    row.task_batch = taskBatch;
    row.double_annotate = taskBatch === 'OVERLAP';
    row.risk_features = row.risk_features || {
      hair_overlap_est: asNullableNumber(row.hair_overlap_est),
      leakage_bg_est_mean: asNullableNumber(row.leakage_bg_est_mean),
      min_module_pixels: asNullableNumber(row.min_module_pixels),
      overlay_diff_pixels: asNullableNumber(row.overlay_diff_pixels),
      overlay_diff_ratio: asNullableNumber(row.overlay_diff_ratio),
      overlay_focus_module: row.overlay_focus_module || null,
    };

    const task = taskBySample.get(row.sample_id);
    if (!task) continue;
    task.data.sample_id = row.sample_id;
    task.data.task_batch = taskBatch;
    task.data.double_annotate = row.double_annotate;
    task.data.adjudication = false;
    task.data.risk_features = row.risk_features;
    const mergedMeta = {
      ...(task.meta && typeof task.meta === 'object' ? task.meta : {}),
      task_batch: taskBatch,
      double_annotate: row.double_annotate,
      risk_features: row.risk_features,
    };
    task.meta = mergedMeta;
    task.metadata = {
      ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
      task_batch: taskBatch,
      double_annotate: row.double_annotate,
      risk_features: row.risk_features,
    };
  }

  const orderedTasksAll = assignment.ordered
    .map((row) => taskBySample.get(row.sample_id))
    .filter(Boolean);
  const tasksBatchA = assignment.tasks_batch_a_rows
    .map((row) => taskBySample.get(row.sample_id))
    .filter(Boolean);
  const tasksBatchB = assignment.tasks_batch_b_rows
    .map((row) => taskBySample.get(row.sample_id))
    .filter(Boolean);
  const tasksOverlap = assignment.overlap_rows
    .map((row) => taskBySample.get(row.sample_id))
    .filter(Boolean);

  await fsp.rm(convertedDir, { recursive: true, force: true });

  const sourceBreakdown = {
    internal: enrichedRows.filter((row) => row.source === 'internal').length,
    lapa: enrichedRows.filter((row) => row.source === 'lapa').length,
    celebamaskhq: enrichedRows.filter((row) => row.source === 'celebamaskhq').length,
  };
  const overlayDiffSummary = summarizeOverlayDiff(orderedRows);

  const baselineConfig = {
    group: 'c0_k0',
    skinmask_v2_enabled: true,
    guards: 'default',
    variant_id: manifestFromPack.baseline_id || 'baseline_default',
  };
  const variant1Config = {
    group: 'c0_k0',
    skinmask_v2_enabled: true,
    guards: 'default',
    variant_id: manifestFromPack.variant_id || 'variant1_forehead_hair_clip',
    forehead_hair_aware_clip: true,
  };

  const finalManifest = {
    ...manifestFromPack,
    schema_version: 'aurora.preference_round1_pack.v1',
    run_id: runId,
    generated_at: new Date().toISOString(),
    seed: args.seed,
    pairing: {
      baseline_id: manifestFromPack.baseline_id || 'baseline_default',
      variant_id: manifestFromPack.variant_id || 'variant1_forehead_hair_clip',
      comparison: 'baseline_vs_variant1',
      description: 'baseline defaults vs variant1 forehead hair-aware clip',
    },
    config_hashes: {
      baseline: hashConfig(baselineConfig),
      variant1: hashConfig(variant1Config),
    },
    inputs: {
      internal_dir: toPosix(path.relative(process.cwd(), path.resolve(args.internal_dir))),
      external_index_lapa: toPosix(path.relative(process.cwd(), path.resolve(args.external_index_lapa))),
      external_index_celeba: toPosix(path.relative(process.cwd(), path.resolve(args.external_index_celeba))),
      review_pack_jsonl: args.review_pack_jsonl ? toPosix(path.relative(process.cwd(), path.resolve(args.review_pack_jsonl))) : null,
      synthetic_review_jsonl: toPosix(path.relative(process.cwd(), syntheticReviewPath)),
    },
    source_breakdown: sourceBreakdown,
    overlay_diff_summary: overlayDiffSummary,
    overlap: {
      overlap_ratio: round3(args.overlap_ratio),
      overlap_min: args.overlap_min,
      overlap_count: assignment.overlap_count,
      sample_ids: assignment.overlap_sample_ids,
    },
    iaa: {
      ratio: round3(args.overlap_ratio),
      double_annotate_count: assignment.overlap_count,
      sample_ids: assignment.overlap_sample_ids,
    },
    batch_counts: {
      batch_a_total: tasksBatchA.length,
      batch_b_total: tasksBatchB.length,
      batch_overlap_total: tasksOverlap.length,
      batch_a_unique: tasksBatchA.filter((task) => String(task.data && task.data.task_batch) === 'A').length,
      batch_b_unique: tasksBatchB.filter((task) => String(task.data && task.data.task_batch) === 'B').length,
    },
    flip_map: flipMap,
    batch_assignment: Object.fromEntries(
      assignment.ordered.map((row) => [row.sample_id, assignment.batch_map.get(row.sample_id) || 'A']),
    ),
    artifacts: {
      ...(manifestFromPack.artifacts || {}),
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      tasks_all_json: toPosix(path.relative(process.cwd(), tasksAllPath)),
      tasks_batch_a_json: toPosix(path.relative(process.cwd(), tasksBatchAPath)),
      tasks_batch_b_json: toPosix(path.relative(process.cwd(), tasksBatchBPath)),
      tasks_overlap_json: toPosix(path.relative(process.cwd(), tasksOverlapPath)),
      manifest_json: toPosix(path.relative(process.cwd(), manifestPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
      bundles_dir: toPosix(path.relative(process.cwd(), bundlesDir)),
    },
    rows: orderedRows,
    build: {
      mock_pipeline: args.mock_pipeline,
      max_edge: args.max_edge,
      concurrency: args.concurrency,
      module_box_mode: args.module_box_mode,
      require_dynamic_boxes: args.require_dynamic_boxes,
      exclude_template_like: args.exclude_template_like,
      min_geometry_qc_score: args.min_geometry_qc_score,
      template_match_eps: args.template_match_eps,
      hard_filter_gate: args.hard_filter_gate,
      hard_filter_require_quality_pass: args.hard_filter_require_quality_pass,
      hard_filter_max_guarded_modules: args.hard_filter_max_guarded_modules,
      hard_filter_min_module_pixels: args.hard_filter_min_module_pixels,
      hard_filter_min_dynamic_score: args.hard_filter_min_dynamic_score,
      hard_filter_min_box_plausibility: args.hard_filter_min_box_plausibility,
      hard_filter_min_mask_rle_ratio: args.hard_filter_min_mask_rle_ratio,
      hard_filter_min_face_span_h: args.hard_filter_min_face_span_h,
      hard_filter_min_face_span_w: args.hard_filter_min_face_span_w,
      hard_filter_min_face_span_area: args.hard_filter_min_face_span_area,
      hard_filter_require_all_strong_modules: args.hard_filter_require_all_strong_modules,
      hard_filter_fail_on_empty: args.hard_filter_fail_on_empty,
      selected_total: enrichedRows.length,
      backfilled_count: backfilled.backfilled,
      selected_counts: selectedCounts,
      discovered: {
        internal: internal.discovered_total,
        internal_preferred_from_review: internal.preferred_total,
        lapa_usable: lapa.usable_total,
        celebamaskhq_usable: celeba.usable_total,
      },
    },
    label_studio: {
      local_files_document_root: toPosix(labelStudioDocumentRoot),
      local_files_url_prefix: '/data/local-files/?d=',
    },
  };

  const previewMarkdown = renderPreview({ runId, manifest: finalManifest });

  await Promise.all([
    // Keep tasks.json as backward-compatible alias of tasks_all.json.
    fsp.writeFile(tasksPath, `${JSON.stringify(orderedTasksAll, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksAllPath, `${JSON.stringify(orderedTasksAll, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksBatchAPath, `${JSON.stringify(tasksBatchA, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksBatchBPath, `${JSON.stringify(tasksBatchB, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksOverlapPath, `${JSON.stringify(tasksOverlap, null, 2)}\n`, 'utf8'),
    fsp.writeFile(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8'),
    fsp.writeFile(previewPath, previewMarkdown, 'utf8'),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    selected_total: enrichedRows.length,
    source_breakdown: sourceBreakdown,
    overlap_count: assignment.overlap_count,
    double_annotate_count: assignment.overlap_count,
    pack_summary: packSummary,
    artifacts: {
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      tasks_all_json: toPosix(path.relative(process.cwd(), tasksAllPath)),
      tasks_batch_a_json: toPosix(path.relative(process.cwd(), tasksBatchAPath)),
      tasks_batch_b_json: toPosix(path.relative(process.cwd(), tasksBatchBPath)),
      tasks_overlap_json: toPosix(path.relative(process.cwd(), tasksOverlapPath)),
      manifest_json: toPosix(path.relative(process.cwd(), manifestPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
      bundles_dir: toPosix(path.relative(process.cwd(), bundlesDir)),
      synthetic_review_jsonl: toPosix(path.relative(process.cwd(), syntheticReviewPath)),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_round1_real_runbook_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
