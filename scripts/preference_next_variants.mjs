#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTimestampKey, sha256Hex } from './internal_batch_helpers.mjs';
import {
  readJsonlRows,
  toLabelStudioLocalFilesUrl,
  toPosix,
} from './local_image_loader.mjs';

const runExecFile = promisify(execFile);

const DEFAULTS = Object.freeze({
  max_candidates: 8,
  top_k: 4,
  target_total: 120,
  overlap_ratio: 0.25,
  overlap_min: 24,
  overlay_diff_min: 0.01,
  overlay_diff_priority_weight: 1,
  seed: 'preference_round2_seed_v1',
  report_dir: 'reports',
  max_edge: 512,
  concurrency: 2,
  cache_dir: path.join('datasets_cache', 'external'),
  internal_dir: process.cwd(),
  mock_pipeline: false,
});

const HELP_TEXT = `preference_next_variants.mjs

Usage:
  node scripts/preference_next_variants.mjs --run_id <round1_run_id> --contentious <contentious.jsonl> --manifest <manifest.json> [options]

Required:
  --run_id <id>                           source preference run id (round1)
  --contentious <path>                    artifacts/preference_contentious_<run_id>.jsonl
  --manifest <path>                       artifacts/preference_round1_<run_id>/manifest.json

Options:
  --next_run_id <id>                      output round2 run id (default: <run_id>_round2)
  --out_dir <dir>                         output root (default: artifacts/preference_round2_<next_run_id>)
  --crossset_jsonl <path>                 optional crossset summary json/jsonl
  --gold_labels <path>                    optional gold labels ndjson for eval_gold_ab scoring
  --pred_jsonl <path>                     optional pred jsonl for eval_gold_ab scoring
  --max_candidates <n>                    cap candidate count before scoring (default: 8)
  --top_k <n>                             top valid candidates to keep (default: 4)
  --target_total <n>                      round2 sample target (default: 120)
  --overlap_ratio <0-1>                   overlap ratio for IAA assignment (default: 0.25)
  --overlap_min <n>                       overlap minimum count (default: 24)
  --overlay_diff_min <ratio>              min diff ratio considered high-separability (default: 0.01)
  --overlay_diff_priority_weight <num>    >0 prioritizes high-separability samples; 0 disables this weighting
  --seed <token>                          deterministic seed (default: preference_round2_seed_v1)
  --cache_dir <path>                      forwarded to preference_round1_pack (default: datasets_cache/external)
  --internal_dir <path>                   forwarded to preference_round1_pack (default: cwd)
  --max_edge <n>                          forwarded to preference_round1_pack (default: 512)
  --concurrency <n>                       forwarded to preference_round1_pack (default: 2)
  --mock_pipeline <bool>                  deterministic mock mode for tests/smoke
  --help                                  show help
`;

const SOURCE_KEYS = Object.freeze(['internal', 'lapa', 'celebamaskhq']);

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  if (value == null) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function splitCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    help: false,
    run_id: process.env.RUN_ID || '',
    next_run_id: process.env.NEXT_RUN_ID || '',
    contentious: process.env.CONTENTIOUS || '',
    manifest: process.env.MANIFEST || '',
    out_dir: process.env.OUT || process.env.OUT_DIR || '',
    crossset_jsonl: process.env.CROSSSET_JSONL || '',
    gold_labels: process.env.GOLD_LABELS || '',
    pred_jsonl: process.env.PRED_JSONL || '',
    max_candidates: process.env.MAX_CANDIDATES || DEFAULTS.max_candidates,
    top_k: process.env.TOP_K || DEFAULTS.top_k,
    target_total: process.env.TARGET_TOTAL || DEFAULTS.target_total,
    overlap_ratio: process.env.OVERLAP_RATIO || DEFAULTS.overlap_ratio,
    overlap_min: process.env.OVERLAP_MIN || DEFAULTS.overlap_min,
    overlay_diff_min: process.env.OVERLAY_DIFF_MIN || DEFAULTS.overlay_diff_min,
    overlay_diff_priority_weight: process.env.OVERLAY_DIFF_PRIORITY_WEIGHT || DEFAULTS.overlay_diff_priority_weight,
    seed: process.env.PREFERENCE_SEED || DEFAULTS.seed,
    cache_dir: process.env.CACHE_DIR || DEFAULTS.cache_dir,
    internal_dir: process.env.INTERNAL_DIR || DEFAULTS.internal_dir,
    max_edge: process.env.PREFERENCE_MAX_EDGE || DEFAULTS.max_edge,
    concurrency: process.env.EVAL_CONCURRENCY || DEFAULTS.concurrency,
    mock_pipeline: process.env.MOCK_PIPELINE || DEFAULTS.mock_pipeline,
  };

  const aliasMap = {
    run_id: 'run_id',
    runid: 'run_id',
    next_run_id: 'next_run_id',
    nextrunid: 'next_run_id',
    contentious: 'contentious',
    manifest: 'manifest',
    out: 'out_dir',
    out_dir: 'out_dir',
    outdir: 'out_dir',
    crossset_jsonl: 'crossset_jsonl',
    crossset: 'crossset_jsonl',
    gold_labels: 'gold_labels',
    pred_jsonl: 'pred_jsonl',
    max_candidates: 'max_candidates',
    top_k: 'top_k',
    target_total: 'target_total',
    overlap_ratio: 'overlap_ratio',
    overlap_min: 'overlap_min',
    overlay_diff_min: 'overlay_diff_min',
    overlay_diff_priority_weight: 'overlay_diff_priority_weight',
    seed: 'seed',
    cache_dir: 'cache_dir',
    internal_dir: 'internal_dir',
    max_edge: 'max_edge',
    concurrency: 'concurrency',
    mock_pipeline: 'mock_pipeline',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const tokenRaw = String(argv[i] || '');
    if (tokenRaw === '--help' || tokenRaw === '-h') {
      out.help = true;
      continue;
    }
    if (!tokenRaw.startsWith('--')) continue;
    const body = tokenRaw.slice(2);
    const eqIndex = body.indexOf('=');
    let keyRaw = body;
    let value = null;
    if (eqIndex >= 0) {
      keyRaw = body.slice(0, eqIndex);
      value = body.slice(eqIndex + 1);
    }
    const key = aliasMap[String(keyRaw || '').trim().toLowerCase()];
    if (!key) continue;
    if (value == null) {
      const next = argv[i + 1];
      if (!next || String(next).startsWith('--')) {
        out[key] = 'true';
        continue;
      }
      out[key] = String(next);
      i += 1;
    } else {
      out[key] = String(value);
    }
  }

  out.help = parseBool(out.help, false);
  out.run_id = String(out.run_id || '').trim();
  out.next_run_id = String(out.next_run_id || '').trim();
  out.contentious = String(out.contentious || '').trim();
  out.manifest = String(out.manifest || '').trim();
  out.out_dir = String(out.out_dir || '').trim();
  out.crossset_jsonl = String(out.crossset_jsonl || '').trim();
  out.gold_labels = String(out.gold_labels || '').trim();
  out.pred_jsonl = String(out.pred_jsonl || '').trim();
  out.max_candidates = Math.max(1, Math.min(32, Math.trunc(parseNumber(out.max_candidates, DEFAULTS.max_candidates, 1, 32))));
  out.top_k = Math.max(1, Math.min(16, Math.trunc(parseNumber(out.top_k, DEFAULTS.top_k, 1, 16))));
  out.target_total = Math.max(1, Math.min(2000, Math.trunc(parseNumber(out.target_total, DEFAULTS.target_total, 1, 2000))));
  out.overlap_ratio = clamp01(out.overlap_ratio);
  out.overlap_min = Math.max(0, Math.min(2000, Math.trunc(parseNumber(out.overlap_min, DEFAULTS.overlap_min, 0, 2000))));
  out.overlay_diff_min = clamp01(out.overlay_diff_min);
  out.overlay_diff_priority_weight = parseNumber(out.overlay_diff_priority_weight, DEFAULTS.overlay_diff_priority_weight, 0, 10);
  out.seed = String(out.seed || DEFAULTS.seed).trim() || DEFAULTS.seed;
  out.cache_dir = String(out.cache_dir || DEFAULTS.cache_dir).trim() || DEFAULTS.cache_dir;
  out.internal_dir = String(out.internal_dir || DEFAULTS.internal_dir).trim() || DEFAULTS.internal_dir;
  out.max_edge = Math.max(64, Math.min(2048, Math.trunc(parseNumber(out.max_edge, DEFAULTS.max_edge, 64, 2048))));
  out.concurrency = Math.max(1, Math.min(8, Math.trunc(parseNumber(out.concurrency, DEFAULTS.concurrency, 1, 8))));
  out.mock_pipeline = parseBool(out.mock_pipeline, DEFAULTS.mock_pipeline);
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const token of [args.contentious, args.manifest]) {
    const base = path.basename(String(token || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function stableHash(seed, key) {
  return sha256Hex(`${seed}:${key}`);
}

function deterministicSort(items, seed, keyFn) {
  return [...items].sort((a, b) => {
    const ka = String(keyFn(a));
    const kb = String(keyFn(b));
    const ha = stableHash(seed, ka);
    const hb = stableHash(seed, kb);
    if (ha === hb) return ka.localeCompare(kb);
    return ha.localeCompare(hb);
  });
}

function sampleIdOf(row) {
  return String(
    row && typeof row === 'object'
      ? (row.sample_id || row.sample_hash || row.id || '')
      : '',
  ).trim();
}

function asNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSource(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (token === 'celeb' || token === 'celeba' || token === 'celebamask') return 'celebamaskhq';
  return token || 'unknown';
}

function riskFromManifestRow(row) {
  const risk = row && typeof row.risk_features === 'object' ? row.risk_features : {};
  const hair = asNumberOrNull(
    risk.hair_overlap_est
    ?? row.hair_overlap_est
    ?? row.forehead_hair_overlap_est
    ?? null,
  );
  const leakage = asNumberOrNull(
    risk.leakage_bg_est_mean
    ?? row.leakage_bg_est_mean
    ?? null,
  );
  const minPixels = asNumberOrNull(
    risk.min_module_pixels
    ?? row.min_module_pixels
    ?? row.module_pixels_min
    ?? null,
  );
  const overlayDiffPixels = asNumberOrNull(
    risk.overlay_diff_pixels
    ?? risk.diff_pixels
    ?? risk.overlayDiffPixels
    ?? row.overlay_diff_pixels
    ?? row.diff_pixels
    ?? row.overlayDiffPixels
    ?? null,
  );
  const overlayDiffRatio = asNumberOrNull(
    risk.overlay_diff_ratio
    ?? risk.diff_ratio
    ?? risk.overlayDiffRatio
    ?? row.overlay_diff_ratio
    ?? row.diff_ratio
    ?? row.overlayDiffRatio
    ?? null,
  );
  const overlayFocusModule = String(
    risk.overlay_focus_module
    ?? risk.overlayFocusModule
    ?? row.overlay_focus_module
    ?? row.overlayFocusModule
    ?? '',
  ).trim() || null;
  return {
    hair_overlap_est: hair == null ? null : round3(hair),
    leakage_bg_est_mean: leakage == null ? null : round3(leakage),
    min_module_pixels: minPixels == null ? null : Math.max(0, Math.trunc(minPixels)),
    overlay_diff_pixels: overlayDiffPixels == null ? null : Math.max(0, Math.trunc(overlayDiffPixels)),
    overlay_diff_ratio: overlayDiffRatio == null ? null : round3(overlayDiffRatio),
    overlay_focus_module: overlayFocusModule,
  };
}

function overlayRiskFromContentiousRow(row) {
  const risk = row && typeof row.risk_features === 'object' ? row.risk_features : {};
  const rowOverlayDiffRatio = row ? (row.overlay_diff_ratio ?? row.diff_ratio ?? row.overlayDiffRatio) : null;
  const rowOverlayDiffPixels = row ? (row.overlay_diff_pixels ?? row.diff_pixels ?? row.overlayDiffPixels) : null;
  const rowOverlayFocusModule = row ? (row.overlay_focus_module ?? row.overlayFocusModule) : null;
  const overlayDiffRatio = asNumberOrNull(
    rowOverlayDiffRatio
    ?? risk.overlay_diff_ratio
    ?? risk.diff_ratio
    ?? risk.overlayDiffRatio
    ?? null,
  );
  const overlayDiffPixels = asNumberOrNull(
    rowOverlayDiffPixels
    ?? risk.overlay_diff_pixels
    ?? risk.diff_pixels
    ?? risk.overlayDiffPixels
    ?? null,
  );
  const overlayFocusModule = String(
    rowOverlayFocusModule
    ?? risk.overlay_focus_module
    ?? risk.overlayFocusModule
    ?? '',
  ).trim() || null;
  return {
    overlay_diff_ratio: overlayDiffRatio == null ? null : round3(overlayDiffRatio),
    overlay_diff_pixels: overlayDiffPixels == null ? null : Math.max(0, Math.trunc(overlayDiffPixels)),
    overlay_focus_module: overlayFocusModule,
  };
}

async function readJsonOrJsonl(filePath) {
  const absPath = path.resolve(filePath);
  const ext = String(path.extname(absPath) || '').trim().toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') {
    return readJsonlRows(absPath);
  }
  const raw = await fsp.readFile(absPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed.samples)) return parsed.samples;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [parsed];
  }
  return [];
}

function normalizeManifestRows(manifestRows) {
  const out = [];
  for (const row of manifestRows || []) {
    if (!row || typeof row !== 'object') continue;
    const sampleId = sampleIdOf(row);
    if (!sampleId) continue;
    const source = normalizeSource(row.source || row.dataset);
    if (!SOURCE_KEYS.includes(source)) continue;
    const imageCandidates = [
      row.input_thumb_path,
      row.image_path,
      row.image_path_abs,
      row.image_a_path,
      row.overlay_baseline_path,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    out.push({
      sample_id: sampleId,
      source,
      manifest_row: row,
      image_candidates: imageCandidates,
      risk_features: riskFromManifestRow(row),
      guard_triggered:
        Boolean(row.module_guard_triggered)
        || Boolean(row.guard_triggered)
        || Boolean(row.risk_features && row.risk_features.guard_triggered)
        || (Array.isArray(row.guarded_modules) && row.guarded_modules.length > 0),
      guarded_modules: Array.isArray(row.guarded_modules)
        ? row.guarded_modules.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    });
  }
  const bySample = new Map();
  for (const row of out) {
    if (!bySample.has(row.sample_id)) {
      bySample.set(row.sample_id, row);
    }
  }
  return [...bySample.values()];
}

async function chooseUsableImagePath(row) {
  for (const rawPath of row.image_candidates) {
    const resolved = path.resolve(rawPath);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (stat && stat.isFile()) return resolved;
  }
  return null;
}

function normalizeContentiousRows(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const sampleId = sampleIdOf(row);
    if (!sampleId) continue;
    const source = normalizeSource(row.source || row.dataset);
    const risk = row.risk_features && typeof row.risk_features === 'object' ? row.risk_features : {};
    out.push({
      sample_id: sampleId,
      source,
      cannot_tell_rate: asNumberOrNull(row.cannot_tell_rate),
      disagreement_rate: asNumberOrNull(
        row.disagreement_overlap_rate
        ?? row.disagreement_rate,
      ),
      low_confidence_rate: asNumberOrNull(row.low_confidence_rate),
      hair_overlap_est: asNumberOrNull(
        row.hair_overlap_est
        ?? risk.hair_overlap_est
        ?? null,
      ),
      leakage_bg_est_mean: asNumberOrNull(
        row.leakage_bg_est_mean
        ?? risk.leakage_bg_est_mean
        ?? null,
      ),
      min_module_pixels: asNumberOrNull(
        row.min_module_pixels
        ?? risk.min_module_pixels
        ?? null,
      ),
      overlay_diff_ratio: asNumberOrNull(
        row.overlay_diff_ratio
        ?? row.diff_ratio
        ?? row.overlayDiffRatio
        ?? risk.overlay_diff_ratio
        ?? risk.diff_ratio
        ?? risk.overlayDiffRatio
        ?? null,
      ),
      overlay_diff_pixels: asNumberOrNull(
        row.overlay_diff_pixels
        ?? row.diff_pixels
        ?? row.overlayDiffPixels
        ?? risk.overlay_diff_pixels
        ?? risk.diff_pixels
        ?? risk.overlayDiffPixels
        ?? null,
      ),
      guard_triggered: Boolean(row.guard_triggered || (risk && risk.guard_triggered)),
    });
  }
  const dedup = new Map();
  for (const row of out) {
    const prev = dedup.get(row.sample_id);
    if (!prev) {
      dedup.set(row.sample_id, row);
      continue;
    }
    // Keep the higher contentious row deterministically.
    const prevScore = Number(prev.cannot_tell_rate || 0) + Number(prev.disagreement_rate || 0) + Number(prev.low_confidence_rate || 0);
    const nextScore = Number(row.cannot_tell_rate || 0) + Number(row.disagreement_rate || 0) + Number(row.low_confidence_rate || 0);
    if (nextScore > prevScore) dedup.set(row.sample_id, row);
  }
  return [...dedup.values()];
}

function ratio(value, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Number(value || 0) / total;
}

function analyzeContentious(rows) {
  const total = Math.max(1, rows.length);
  const hairHigh = rows.filter((row) => {
    const v = asNumberOrNull(row.hair_overlap_est);
    return v != null && v >= 0.25;
  }).length;
  const lowPixels = rows.filter((row) => {
    const v = asNumberOrNull(row.min_module_pixels);
    return v != null && v <= 24;
  }).length;
  const leakageHigh = rows.filter((row) => {
    const v = asNumberOrNull(row.leakage_bg_est_mean);
    return v != null && v >= 0.12;
  }).length;
  const cannotTellHeavy = rows.filter((row) => {
    const v = asNumberOrNull(row.cannot_tell_rate);
    return v != null && v >= 0.5;
  }).length;
  const disagreeHeavy = rows.filter((row) => {
    const v = asNumberOrNull(row.disagreement_rate);
    return v != null && v >= 0.5;
  }).length;
  const guardHeavy = rows.filter((row) => row.guard_triggered).length;
  return {
    total: rows.length,
    hair_high_ratio: round3(ratio(hairHigh, total)),
    low_pixels_ratio: round3(ratio(lowPixels, total)),
    leakage_high_ratio: round3(ratio(leakageHigh, total)),
    cannot_tell_heavy_ratio: round3(ratio(cannotTellHeavy, total)),
    disagreement_heavy_ratio: round3(ratio(disagreeHeavy, total)),
    guard_ratio: round3(ratio(guardHeavy, total)),
  };
}

function candidateSignature(candidate) {
  const params = candidate && candidate.params && typeof candidate.params === 'object'
    ? Object.keys(candidate.params)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${key}=${candidate.params[key]}`)
      .join(';')
    : '';
  return `${candidate.variant_kind}|${params}`;
}

function baseCandidatePool() {
  return [
    {
      id: 'candidate_hair_clip_light',
      title: 'Hair-aware clip light',
      variant_kind: 'variant1',
      params: { variant1_forehead_top_clip_ratio: 0.08, hair_clip_strength: 1 },
      tags: ['hair', 'forehead'],
    },
    {
      id: 'candidate_hair_clip_default',
      title: 'Hair-aware clip default',
      variant_kind: 'variant1',
      params: { variant1_forehead_top_clip_ratio: 0.12, hair_clip_strength: 2 },
      tags: ['hair', 'forehead'],
    },
    {
      id: 'candidate_hair_clip_strong',
      title: 'Hair-aware clip strong',
      variant_kind: 'variant1',
      params: { variant1_forehead_top_clip_ratio: 0.18, hair_clip_strength: 3 },
      tags: ['hair', 'forehead'],
    },
    {
      id: 'candidate_under_eye_relaxed',
      title: 'Under-eye relaxed guard',
      variant_kind: 'variant2',
      params: { variant2_min_coverage: 0.006, under_eye_policy: 'relaxed_guard' },
      tags: ['under_eye', 'low_pixels'],
    },
    {
      id: 'candidate_under_eye_fallback_empty',
      title: 'Under-eye fallback-empty',
      variant_kind: 'variant2',
      params: { variant2_min_coverage: 0.02, under_eye_policy: 'fallback_empty' },
      tags: ['under_eye', 'guard'],
    },
    {
      id: 'candidate_oval_clip_64_0_50',
      title: 'Oval clip 64/0.50',
      variant_kind: 'variant3',
      params: { variant3_min_pixels: 64, variant3_min_keep_ratio: 0.5 },
      tags: ['oval', 'low_pixels'],
    },
    {
      id: 'candidate_oval_clip_96_0_70',
      title: 'Oval clip 96/0.70',
      variant_kind: 'variant3',
      params: { variant3_min_pixels: 96, variant3_min_keep_ratio: 0.7 },
      tags: ['oval', 'low_pixels', 'guard'],
    },
    {
      id: 'candidate_oval_clip_128_0_85',
      title: 'Oval clip 128/0.85',
      variant_kind: 'variant3',
      params: { variant3_min_pixels: 128, variant3_min_keep_ratio: 0.85 },
      tags: ['oval', 'guard'],
    },
  ];
}

function candidatePriority(candidate, analysis) {
  const hair = Number(analysis.hair_high_ratio || 0);
  const lowPixels = Number(analysis.low_pixels_ratio || 0);
  const leakage = Number(analysis.leakage_high_ratio || 0);
  const cannotTell = Number(analysis.cannot_tell_heavy_ratio || 0);
  const disagreement = Number(analysis.disagreement_heavy_ratio || 0);
  const guard = Number(analysis.guard_ratio || 0);
  let score = 0.1 + disagreement * 0.4 + cannotTell * 0.25;
  if (candidate.tags.includes('hair')) score += hair * 1.8 + leakage * 0.4;
  if (candidate.tags.includes('under_eye')) score += lowPixels * 1.0 + cannotTell * 0.8;
  if (candidate.tags.includes('oval')) score += lowPixels * 1.4 + guard * 0.9;
  if (candidate.tags.includes('guard')) score += guard * 0.4;
  return round3(score);
}

function buildCandidates({ analysis, maxCandidates, seed }) {
  const ranked = baseCandidatePool()
    .map((candidate) => ({
      ...candidate,
      priority: candidatePriority(candidate, analysis),
      score_source: 'heuristic',
    }));

  const dedup = new Map();
  for (const item of ranked) {
    const key = candidateSignature(item);
    const prev = dedup.get(key);
    if (!prev || Number(item.priority || 0) > Number(prev.priority || 0)) {
      dedup.set(key, item);
    }
  }

  return [...dedup.values()]
    .sort((a, b) => {
      const da = Number(a.priority || 0);
      const db = Number(b.priority || 0);
      if (Math.abs(db - da) > 1e-12) return db - da;
      const ha = stableHash(`${seed}:candidate-priority`, a.id);
      const hb = stableHash(`${seed}:candidate-priority`, b.id);
      if (ha === hb) return String(a.id || '').localeCompare(String(b.id || ''));
      return ha.localeCompare(hb);
    })
    .slice(0, maxCandidates);
}

function pickUnique(pool, take, usedSet) {
  const picked = [];
  for (const item of pool) {
    if (picked.length >= take) break;
    const key = sampleIdOf(item);
    if (!key || usedSet.has(key)) continue;
    usedSet.add(key);
    picked.push(item);
  }
  return picked;
}

function overlayDiffRatioOf(row) {
  const risk = row && typeof row.risk_features === 'object' ? row.risk_features : {};
  return asNumberOrNull(
    risk.overlay_diff_ratio
    ?? risk.diff_ratio
    ?? risk.overlayDiffRatio
    ?? row.overlay_diff_ratio
    ?? row.diff_ratio
    ?? row.overlayDiffRatio
  );
}

function sortBySeparability(pool, seed, label, overlayDiffMin, overlayDiffPriorityWeight) {
  const minDiff = clamp01(overlayDiffMin);
  const weight = Math.max(0, Number(overlayDiffPriorityWeight) || 0);
  if (!(weight > 0)) {
    return deterministicSort(pool, `${seed}:${label}:no-separability-priority`, (row) => sampleIdOf(row));
  }
  return [...pool].sort((a, b) => {
    const ra = overlayDiffRatioOf(a);
    const rb = overlayDiffRatioOf(b);
    const missingA = ra == null ? 1 : 0;
    const missingB = rb == null ? 1 : 0;
    if (missingA !== missingB) return missingA - missingB;
    if (missingA && missingB) {
      const ha = stableHash(`${seed}:${label}:missing`, sampleIdOf(a));
      const hb = stableHash(`${seed}:${label}:missing`, sampleIdOf(b));
      if (ha === hb) return String(sampleIdOf(a)).localeCompare(String(sampleIdOf(b)));
      return ha.localeCompare(hb);
    }
    const highA = ra >= minDiff ? 1 : 0;
    const highB = rb >= minDiff ? 1 : 0;
    if (highA !== highB) return highB - highA;
    const dr = (rb - ra) * weight;
    if (Math.abs(dr) > 1e-12) return dr;
    const ha = stableHash(`${seed}:${label}`, sampleIdOf(a));
    const hb = stableHash(`${seed}:${label}`, sampleIdOf(b));
    if (ha === hb) return String(sampleIdOf(a)).localeCompare(String(sampleIdOf(b)));
    return ha.localeCompare(hb);
  });
}

function selectSamples({ rows, contentiousRows, targetTotal, seed, overlayDiffMin, overlayDiffPriorityWeight }) {
  const bySample = new Map(rows.map((row) => [row.sample_id, row]));
  const contentiousIds = new Set(contentiousRows.map((row) => row.sample_id));
  const contentiousPoolBase = deterministicSort(
    rows.filter((row) => contentiousIds.has(row.sample_id)),
    `${seed}:pool:contentious`,
    (row) => row.sample_id,
  );
  const contentiousPool = sortBySeparability(
    contentiousPoolBase,
    seed,
    'contentious-separability',
    overlayDiffMin,
    overlayDiffPriorityWeight,
  );
  const guardPool = deterministicSort(
    rows.filter((row) => row.guard_triggered),
    `${seed}:pool:guard`,
    (row) => row.sample_id,
  );
  const randomPoolBase = deterministicSort(
    rows,
    `${seed}:pool:random`,
    (row) => row.sample_id,
  );
  const randomPool = sortBySeparability(
    randomPoolBase,
    seed,
    'random-separability',
    overlayDiffMin,
    overlayDiffPriorityWeight,
  );

  const quotaContentious = Math.max(0, Math.min(targetTotal, Math.round(targetTotal * 0.6)));
  const quotaGuard = Math.max(0, Math.min(targetTotal - quotaContentious, Math.round(targetTotal * 0.2)));
  const quotaRandom = Math.max(0, targetTotal - quotaContentious - quotaGuard);

  const used = new Set();
  const pickContentious = pickUnique(contentiousPool, quotaContentious, used);
  const pickGuard = pickUnique(guardPool, quotaGuard, used);
  const pickRandom = pickUnique(randomPool, quotaRandom, used);

  const selected = [...pickContentious, ...pickGuard, ...pickRandom];
  if (selected.length < targetTotal) {
    const backfillPool = deterministicSort(rows, `${seed}:pool:backfill`, (row) => row.sample_id);
    const need = targetTotal - selected.length;
    const fill = pickUnique(backfillPool, need, used);
    selected.push(...fill);
  }

  const ordered = deterministicSort(selected, `${seed}:selected-order`, (row) => row.sample_id);
  const sourceCounts = {
    internal: ordered.filter((row) => row.source === 'internal').length,
    lapa: ordered.filter((row) => row.source === 'lapa').length,
    celebamaskhq: ordered.filter((row) => row.source === 'celebamaskhq').length,
  };

  const coverage = {
    contentious_selected: ordered.filter((row) => contentiousIds.has(row.sample_id)).length,
    guard_selected: ordered.filter((row) => row.guard_triggered).length,
    random_selected: ordered.length,
    overlay_diff_min: round3(overlayDiffMin),
    overlay_diff_priority_weight: round3(overlayDiffPriorityWeight),
    overlay_diff_high_selected: ordered.filter((row) => {
      const v = overlayDiffRatioOf(row);
      return v != null && v >= overlayDiffMin;
    }).length,
    overlay_diff_low_selected: ordered.filter((row) => {
      const v = overlayDiffRatioOf(row);
      return v != null && v < overlayDiffMin;
    }).length,
    overlay_diff_missing_selected: ordered.filter((row) => overlayDiffRatioOf(row) == null).length,
  };

  return {
    selected: ordered,
    source_counts: sourceCounts,
    pool_sizes: {
      contentious: contentiousPool.length,
      guard: guardPool.length,
      random: randomPool.length,
    },
    quotas: {
      contentious: quotaContentious,
      guard: quotaGuard,
      random: quotaRandom,
    },
    coverage,
    by_sample: bySample,
  };
}

function assignBatches(rows, seed, overlapRatio, overlapMin) {
  const ordered = deterministicSort(rows, `${seed}:assignment`, (row) => row.sample_id);
  const total = ordered.length;
  const overlapTarget = Math.round(total * overlapRatio);
  const overlapCount = Math.min(total, Math.max(overlapMin, overlapTarget));
  const overlapSet = new Set(ordered.slice(0, overlapCount).map((row) => row.sample_id));

  const nonOverlap = ordered.filter((row) => !overlapSet.has(row.sample_id));
  const batchMap = new Map();
  const overlapRows = [];
  const batchA = [];
  const batchB = [];

  for (const row of ordered) {
    if (overlapSet.has(row.sample_id)) {
      batchMap.set(row.sample_id, 'OVERLAP');
      overlapRows.push(row);
      batchA.push(row);
      batchB.push(row);
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

function buildSyntheticReviewRows(rows) {
  return rows.map((row) => ({
    source: row.source,
    sample_hash: row.sample_id,
    image_path: row.image_path,
    image_path_rel: row.image_path_rel || '',
    ok: true,
    pipeline_mode_used: 'local',
    risk_score: Number(row.risk_score || 0),
    min_module_pixels: row.risk_features.min_module_pixels == null ? 0 : row.risk_features.min_module_pixels,
    leakage_bg_est_mean: row.risk_features.leakage_bg_est_mean,
    forehead_hair_overlap_rate: row.risk_features.hair_overlap_est,
    overlay_diff_pixels: row.risk_features.overlay_diff_pixels,
    overlay_diff_ratio: row.risk_features.overlay_diff_ratio,
    overlay_focus_module: row.risk_features.overlay_focus_module,
    module_guard_triggered: Boolean(row.guard_triggered),
    guarded_modules: Array.isArray(row.guarded_modules) ? row.guarded_modules : [],
  }));
}

async function writeJsonl(filePath, rows) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fsp.writeFile(filePath, payload, 'utf8');
}

function parseLastJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    // continue and try from the last object
  }
  let cursor = text.lastIndexOf('{');
  while (cursor >= 0) {
    const slice = text.slice(cursor).trim();
    try {
      return JSON.parse(slice);
    } catch (_error) {
      cursor = text.lastIndexOf('{', cursor - 1);
    }
  }
  return null;
}

async function runPreferencePack({
  candidate,
  runId,
  reviewPath,
  outDir,
  args,
  selectedCounts,
}) {
  const scriptPath = path.resolve('scripts', 'preference_round1_pack.mjs');
  const commandArgs = [
    scriptPath,
    '--run_id', runId,
    '--review_in', reviewPath,
    '--out', outDir,
    '--variant', candidate.variant_kind,
    '--seed', args.seed,
    '--limit_internal', String(selectedCounts.internal),
    '--limit_lapa', String(selectedCounts.lapa),
    '--limit_celeba', String(selectedCounts.celebamaskhq),
    '--internal_dir', args.internal_dir,
    '--cache_dir', args.cache_dir,
    '--max_edge', String(args.max_edge),
    '--concurrency', String(args.concurrency),
  ];

  if (candidate.variant_kind === 'variant1' && Number.isFinite(Number(candidate.params.variant1_forehead_top_clip_ratio))) {
    commandArgs.push('--variant1_forehead_top_clip_ratio', String(candidate.params.variant1_forehead_top_clip_ratio));
  }
  if (candidate.variant_kind === 'variant2' && Number.isFinite(Number(candidate.params.variant2_min_coverage))) {
    commandArgs.push('--variant2_min_coverage', String(candidate.params.variant2_min_coverage));
  }
  if (candidate.variant_kind === 'variant3') {
    if (Number.isFinite(Number(candidate.params.variant3_min_pixels))) {
      commandArgs.push('--variant3_min_pixels', String(candidate.params.variant3_min_pixels));
    }
    if (Number.isFinite(Number(candidate.params.variant3_min_keep_ratio))) {
      commandArgs.push('--variant3_min_keep_ratio', String(candidate.params.variant3_min_keep_ratio));
    }
  }
  if (args.mock_pipeline) commandArgs.push('--mock_pipeline', 'true');

  const run = await runExecFile('node', commandArgs, {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 64,
  });
  const summary = parseLastJsonObject(run.stdout);
  if (!summary || typeof summary !== 'object' || !summary.ok) {
    throw new Error(`preference_round1_pack_failed_for_${candidate.id}`);
  }

  const [tasksRaw, manifestRaw] = await Promise.all([
    fsp.readFile(path.join(outDir, 'tasks.json'), 'utf8'),
    fsp.readFile(path.join(outDir, 'manifest.json'), 'utf8'),
  ]);
  return {
    summary,
    tasks: JSON.parse(tasksRaw),
    manifest: JSON.parse(manifestRaw),
  };
}

function parseVariant3Id(groupId) {
  const token = String(groupId || '').trim();
  const match = token.match(/^variant3_clip_(\d+)_([0-9_]+)$/);
  if (!match) return null;
  return {
    min_pixels: Number(match[1]),
    min_keep_ratio: Number(String(match[2] || '').replace(/_/g, '.')),
  };
}

function pickNearestVariant3Group(groups, candidate) {
  const desiredMinPixels = Number(candidate.params.variant3_min_pixels || 0);
  const desiredKeep = Number(candidate.params.variant3_min_keep_ratio || 0);
  const candidates = groups
    .map((item) => ({
      item,
      parsed: parseVariant3Id(item.group_id || item.id || ''),
    }))
    .filter((entry) => entry.parsed);
  if (!candidates.length) return null;
  return candidates
    .map((entry) => {
      const dPixels = Math.abs(Number(entry.parsed.min_pixels || 0) - desiredMinPixels);
      const dKeep = Math.abs(Number(entry.parsed.min_keep_ratio || 0) - desiredKeep);
      return {
        entry,
        distance: dPixels + (dKeep * 100),
      };
    })
    .sort((a, b) => a.distance - b.distance || String(a.entry.item.group_id || '').localeCompare(String(b.entry.item.group_id || '')))[0].entry.item;
}

function normalizeGoldGroupMetrics(group) {
  if (!group || typeof group !== 'object') return null;
  const metrics = group.metrics && typeof group.metrics === 'object' ? group.metrics : {};
  return {
    strong_module_miou_mean: asNumberOrNull(metrics.strong_module_miou_mean),
    forehead_hair_overlap_rate: asNumberOrNull(metrics.forehead_hair_overlap_rate_mean),
    leakage_bg_mean: asNumberOrNull(metrics.leakage_bg_mean ?? metrics.under_eye_leakage_bg_mean),
    leakage_hair_mean: asNumberOrNull(metrics.leakage_hair_mean ?? metrics.under_eye_leakage_hair_mean),
    empty_module_rate: asNumberOrNull(metrics.empty_module_rate ?? metrics.pred_modules_missing_rate),
  };
}

async function tryGoldScore({ args, outDir, candidates, warnings }) {
  if (!args.gold_labels) return null;
  const stat = await fsp.stat(path.resolve(args.gold_labels)).catch(() => null);
  if (!stat || !stat.isFile()) {
    warnings.push(`gold_labels_not_found:${args.gold_labels}`);
    return null;
  }

  const sweepPairs = candidates
    .filter((candidate) => candidate.variant_kind === 'variant3')
    .map((candidate) => `${candidate.params.variant3_min_pixels}:${candidate.params.variant3_min_keep_ratio}`)
    .filter(Boolean);

  const cli = [
    path.resolve('scripts', 'eval_gold_ab.mjs'),
    '--gold_labels', path.resolve(args.gold_labels),
    '--report_dir', outDir,
    '--rerun_local', 'true',
  ];
  if (args.pred_jsonl) cli.push('--pred_jsonl', path.resolve(args.pred_jsonl));
  if (sweepPairs.length) cli.push('--variant3_sweep', sweepPairs.join(','));

  try {
    const { stdout } = await runExecFile('node', cli, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 64,
    });
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || !parsed.ok || !parsed.report_json) {
      warnings.push('gold_eval_ab_stdout_invalid');
      return null;
    }
    const reportPath = path.resolve(parsed.report_json);
    const raw = await fsp.readFile(reportPath, 'utf8');
    const payload = JSON.parse(raw);
    if (!payload || !Array.isArray(payload.groups)) {
      warnings.push('gold_eval_ab_report_missing_groups');
      return null;
    }

    const byId = new Map();
    for (const group of payload.groups) {
      byId.set(String(group.group_id || group.id || ''), normalizeGoldGroupMetrics(group));
    }
    const baseline = byId.get('baseline') || null;
    return {
      source: 'gold_eval_ab',
      report_json: toPosix(path.relative(process.cwd(), reportPath)),
      groups_raw: payload.groups,
      metrics_by_group: byId,
      baseline,
    };
  } catch (error) {
    warnings.push(`gold_eval_ab_failed:${String(error && error.message ? error.message : error)}`);
    return null;
  }
}

async function tryCrosssetScore(args, warnings) {
  if (!args.crossset_jsonl) return null;
  const absPath = path.resolve(args.crossset_jsonl);
  const stat = await fsp.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    warnings.push(`crossset_not_found:${args.crossset_jsonl}`);
    return null;
  }
  try {
    const rows = await readJsonOrJsonl(absPath);
    const summaries = rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      if (Array.isArray(row.summaries)) return row.summaries;
      return [row];
    }).filter((row) => row && typeof row === 'object' && row.strong_module_miou_mean != null);
    if (!summaries.length) {
      warnings.push('crossset_no_summaries');
      return null;
    }
    const mean = (key) => {
      const values = summaries.map((row) => Number(row[key])).filter((n) => Number.isFinite(n));
      if (!values.length) return null;
      return values.reduce((acc, n) => acc + n, 0) / values.length;
    };
    return {
      source: 'crossset',
      baseline: {
        strong_module_miou_mean: mean('strong_module_miou_mean'),
        forehead_hair_overlap_rate: mean('leakage_hair_mean'),
        leakage_bg_mean: mean('leakage_bg_mean'),
        leakage_hair_mean: mean('leakage_hair_mean'),
        empty_module_rate: null,
      },
      path: toPosix(path.relative(process.cwd(), absPath)),
    };
  } catch (error) {
    warnings.push(`crossset_parse_failed:${String(error && error.message ? error.message : error)}`);
    return null;
  }
}

function baselineFromManifestRows(rows) {
  const hair = rows
    .map((row) => asNumberOrNull(row.risk_features && row.risk_features.hair_overlap_est))
    .filter((n) => n != null);
  const leak = rows
    .map((row) => asNumberOrNull(row.risk_features && row.risk_features.leakage_bg_est_mean))
    .filter((n) => n != null);

  const mean = (values) => {
    if (!values.length) return null;
    return values.reduce((acc, n) => acc + Number(n), 0) / values.length;
  };

  return {
    strong_module_miou_mean: null,
    forehead_hair_overlap_rate: mean(hair),
    leakage_bg_mean: mean(leak),
    leakage_hair_mean: null,
    empty_module_rate: null,
  };
}

function heuristicCandidateMetrics(candidate, context) {
  const analysis = context.analysis || {};
  const baseline = context.baseline_metrics || {};
  const strongBase = Number.isFinite(Number(baseline.strong_module_miou_mean))
    ? Number(baseline.strong_module_miou_mean)
    : 0.52;
  const hairBase = Number.isFinite(Number(baseline.forehead_hair_overlap_rate))
    ? Number(baseline.forehead_hair_overlap_rate)
    : (0.18 + Number(analysis.hair_high_ratio || 0) * 0.18);
  const leakBgBase = Number.isFinite(Number(baseline.leakage_bg_mean))
    ? Number(baseline.leakage_bg_mean)
    : (0.06 + Number(analysis.leakage_high_ratio || 0) * 0.08);
  const leakHairBase = Number.isFinite(Number(baseline.leakage_hair_mean))
    ? Number(baseline.leakage_hair_mean)
    : (0.08 + Number(analysis.hair_high_ratio || 0) * 0.1);

  let strong = strongBase;
  let hair = hairBase;
  let leakBg = leakBgBase;
  let leakHair = leakHairBase;
  let emptyRate = 0;

  if (candidate.variant_kind === 'variant1') {
    const ratio = clamp01(candidate.params.variant1_forehead_top_clip_ratio || 0.12);
    const strength = Math.max(0.5, ratio / 0.12);
    strong += 0.006 * strength;
    hair -= (0.04 + Number(analysis.hair_high_ratio || 0) * 0.06) * strength;
    leakBg += 0.002 * strength;
    leakHair -= 0.008 * strength;
  } else if (candidate.variant_kind === 'variant2') {
    const coverage = clamp01(candidate.params.variant2_min_coverage || 0.01);
    if (coverage <= 0.01) {
      strong += 0.004 + Number(analysis.low_pixels_ratio || 0) * 0.01;
      leakBg += 0.006;
      leakHair += 0.002;
      emptyRate = 0.006;
    } else {
      strong -= 0.003;
      leakBg += 0.012;
      leakHair += 0.003;
      emptyRate = 0.014;
    }
  } else if (candidate.variant_kind === 'variant3') {
    const minPixels = Math.max(1, Number(candidate.params.variant3_min_pixels || 64));
    const keepRatio = clamp01(candidate.params.variant3_min_keep_ratio || 0.7);
    const strictness = Math.min(1.3, (minPixels / 96) + ((keepRatio - 0.7) * 0.9));
    strong += 0.003 + (Number(analysis.low_pixels_ratio || 0) * 0.01 * strictness);
    hair -= 0.012 * strictness;
    leakBg -= 0.007 * strictness;
    leakHair -= 0.005 * strictness;
    emptyRate = Math.max(0, 0.002 + ((strictness - 1) * 0.003));
  }

  return {
    strong_module_miou_mean: round3(Math.max(0, Math.min(1, strong))),
    forehead_hair_overlap_rate: round3(Math.max(0, Math.min(1, hair))),
    leakage_bg_mean: round3(Math.max(0, Math.min(1, leakBg))),
    leakage_hair_mean: round3(Math.max(0, Math.min(1, leakHair))),
    empty_module_rate: round3(Math.max(0, Math.min(1, emptyRate))),
  };
}

function goldMetricsForCandidate(candidate, gold) {
  if (!gold || !gold.metrics_by_group) return null;
  const groupIds = [...gold.metrics_by_group.keys()];
  if (candidate.variant_kind === 'variant1') {
    return gold.metrics_by_group.get('variant1_forehead_hair_clip') || null;
  }
  if (candidate.variant_kind === 'variant2') {
    return gold.metrics_by_group.get('variant2_under_eye_relaxed_guard') || null;
  }
  if (candidate.variant_kind === 'variant3') {
    const groups = groupIds
      .map((id) => ({ group_id: id, metrics: gold.metrics_by_group.get(id) }))
      .filter((entry) => String(entry.group_id).startsWith('variant3_clip_'));
    const picked = pickNearestVariant3Group(groups, candidate);
    return picked ? gold.metrics_by_group.get(String(picked.group_id || '')) || null : null;
  }
  return null;
}

function scoreFormula(metrics) {
  const strong = Number(metrics.strong_module_miou_mean);
  const hair = Number(metrics.forehead_hair_overlap_rate);
  const leakBg = Number(metrics.leakage_bg_mean);
  const leakHair = Number(metrics.leakage_hair_mean);
  return round3(
    (Number.isFinite(strong) ? 2.0 * strong : 0)
    - (Number.isFinite(hair) ? 1.0 * hair : 0)
    - (Number.isFinite(leakBg) ? 0.5 * leakBg : 0)
    - (Number.isFinite(leakHair) ? 0.5 * leakHair : 0),
  );
}

function candidateRationale(candidate, analysis, metricsSource) {
  const slices = [];
  if (candidate.tags.includes('hair')) slices.push('forehead + high hair-overlap');
  if (candidate.tags.includes('under_eye')) slices.push('under-eye + low-module-pixels');
  if (candidate.tags.includes('oval')) slices.push('face-oval clip on hard boundaries');
  const sliceText = slices.length ? slices.join('; ') : 'mixed contentious slices';
  const signal = metricsSource === 'gold_eval_ab'
    ? 'gold strong-module and leakage metrics'
    : metricsSource === 'crossset'
      ? 'crossset leakage/miou proxy metrics'
      : 'contentious risk-feature heuristics';
  return `Targets ${sliceText}; ranked by ${signal}; hair=${analysis.hair_high_ratio}, low_pixels=${analysis.low_pixels_ratio}, cannot_tell=${analysis.cannot_tell_heavy_ratio}.`;
}

function scoreCandidates({ candidates, analysis, baselineMetrics, gold, crossset }) {
  const metricsSource = gold ? 'gold_eval_ab' : crossset ? 'crossset' : 'heuristic';
  const baselineLeakBg = Number.isFinite(Number(baselineMetrics.leakage_bg_mean))
    ? Number(baselineMetrics.leakage_bg_mean)
    : null;

  const scored = candidates.map((candidate) => {
    let metrics = null;
    if (gold) metrics = goldMetricsForCandidate(candidate, gold);
    if (!metrics) metrics = heuristicCandidateMetrics(candidate, { analysis, baseline_metrics: baselineMetrics });

    const score = scoreFormula(metrics);
    const invalidReasons = [];
    if (Number.isFinite(Number(metrics.empty_module_rate)) && Number(metrics.empty_module_rate) > 0.01) {
      invalidReasons.push(`empty_module_rate>${0.01}`);
    }
    if (
      baselineLeakBg != null
      && Number.isFinite(Number(metrics.leakage_bg_mean))
      && Number(metrics.leakage_bg_mean) > (baselineLeakBg + 0.02)
    ) {
      invalidReasons.push(`leakage_bg_mean>${round3(baselineLeakBg + 0.02)}`);
    }

    return {
      ...candidate,
      score,
      valid: invalidReasons.length === 0,
      invalid_reasons: invalidReasons,
      metrics,
      score_source: metricsSource,
      rationale: candidateRationale(candidate, analysis, metricsSource),
    };
  });

  const ordered = [...scored].sort((a, b) => {
    if (Boolean(a.valid) !== Boolean(b.valid)) return a.valid ? -1 : 1;
    const ds = Number(b.score || -Infinity) - Number(a.score || -Infinity);
    if (Math.abs(ds) > 1e-12) return ds;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  return {
    ordered,
    metrics_source: metricsSource,
  };
}

function renderPreview({
  runId,
  nextRunId,
  outDirRel,
  recommended,
  selection,
  rows,
  warnings,
}) {
  const lines = [];
  lines.push('# Preference Next Variants Preview');
  lines.push('');
  lines.push(`- source_run_id: ${runId}`);
  lines.push(`- round2_run_id: ${nextRunId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- out_dir: \`${outDirRel}\``);
  lines.push(`- selected_samples: ${selection.selected_total}`);
  lines.push(`- top_k_candidates: ${recommended.length}`);
  lines.push('');

  lines.push('## Recommended Candidates');
  lines.push('');
  lines.push('| rank | candidate_id | variant_kind | score | valid | rationale |');
  lines.push('|---:|---|---|---:|---|---|');
  if (!recommended.length) {
    lines.push('| 1 | - | - | - | - | - |');
  } else {
    recommended.forEach((candidate, idx) => {
      lines.push(`| ${idx + 1} | ${candidate.id} | ${candidate.variant_kind} | ${candidate.score ?? '-'} | ${candidate.valid ? 'yes' : 'no'} | ${candidate.rationale || '-'} |`);
    });
  }
  lines.push('');

  lines.push('## First 20 Task Rows');
  lines.push('');
  lines.push('| rank | task_id | candidate_id | sample_id | source | task_batch | flip(A/B) | risk(hair/leak_bg/min_pixels) | image_a | image_b |');
  lines.push('|---:|---|---|---|---|---|---|---|---|---|');
  const previewRows = rows.slice(0, 20);
  if (!previewRows.length) {
    lines.push('| 1 | - | - | - | - | - | - | - | - | - |');
  } else {
    previewRows.forEach((row, idx) => {
      const risk = row.risk_features || {};
      const flip = `${row.role_a === 'variant' ? 'variant1' : 'baseline'} / ${row.role_b === 'variant' ? 'variant1' : 'baseline'}`;
      lines.push(
        `| ${idx + 1} | ${row.task_id} | ${row.candidate_id} | ${row.sample_id} | ${row.source} | ${row.task_batch} | ${flip} | ${risk.hair_overlap_est ?? '-'} / ${risk.leakage_bg_est_mean ?? '-'} / ${risk.min_module_pixels ?? '-'} | ${toPosix(row.image_a_path_rel)} | ${toPosix(row.image_b_path_rel)} |`,
      );
    });
  }
  lines.push('');

  if (warnings.length) {
    lines.push('## Warnings');
    lines.push('');
    warnings.forEach((warning) => lines.push(`- ${warning}`));
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

  if (!args.contentious) {
    process.stderr.write('preference_next_variants: missing --contentious\n');
    process.exit(2);
    return;
  }
  if (!args.manifest) {
    process.stderr.write('preference_next_variants: missing --manifest\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const nextRunId = args.next_run_id || `${runId}_round2`;
  const outDir = path.resolve(args.out_dir || path.join('artifacts', `preference_round2_${nextRunId}`));
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(path.join(outDir, '.inputs'), { recursive: true });
  await fsp.mkdir(path.join(outDir, 'candidate_runs'), { recursive: true });

  const warnings = [];

  const manifestPath = path.resolve(args.manifest);
  const contentiousPath = path.resolve(args.contentious);
  const [manifestRaw, contentiousAny] = await Promise.all([
    fsp.readFile(manifestPath, 'utf8'),
    readJsonOrJsonl(contentiousPath),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const manifestRows = normalizeManifestRows(Array.isArray(manifest.rows) ? manifest.rows : []);
  if (!manifestRows.length) {
    process.stderr.write('preference_next_variants: manifest has no usable rows\n');
    process.exit(2);
    return;
  }

  const contentiousRows = normalizeContentiousRows(contentiousAny);
  const contentiousById = new Map(contentiousRows.map((row) => [row.sample_id, row]));

  // Resolve image paths upfront to guarantee pack usability.
  const usableRows = [];
  for (const row of manifestRows) {
    const imagePath = await chooseUsableImagePath(row);
    if (!imagePath) continue;
    const contentiousRisk = overlayRiskFromContentiousRow(contentiousById.get(row.sample_id) || null);
    const manifestRisk = row.risk_features && typeof row.risk_features === 'object' ? row.risk_features : {};
    const mergedRisk = {
      ...manifestRisk,
      overlay_diff_ratio: contentiousRisk.overlay_diff_ratio != null
        ? contentiousRisk.overlay_diff_ratio
        : (manifestRisk.overlay_diff_ratio != null ? manifestRisk.overlay_diff_ratio : null),
      overlay_diff_pixels: contentiousRisk.overlay_diff_pixels != null
        ? contentiousRisk.overlay_diff_pixels
        : (manifestRisk.overlay_diff_pixels != null ? manifestRisk.overlay_diff_pixels : null),
      overlay_focus_module: contentiousRisk.overlay_focus_module || manifestRisk.overlay_focus_module || null,
    };
    usableRows.push({
      sample_id: row.sample_id,
      source: row.source,
      image_path: imagePath,
      image_path_rel: toPosix(path.relative(process.cwd(), imagePath)),
      risk_features: mergedRisk,
      guard_triggered: row.guard_triggered,
      guarded_modules: row.guarded_modules,
      risk_score: asNumberOrNull(
        (contentiousById.get(row.sample_id) && contentiousById.get(row.sample_id).disagreement_rate)
        ?? (contentiousById.get(row.sample_id) && contentiousById.get(row.sample_id).cannot_tell_rate)
        ?? 0,
      ) || 0,
      manifest_row: row.manifest_row,
    });
  }
  if (!usableRows.length) {
    process.stderr.write('preference_next_variants: no rows with usable image paths\n');
    process.exit(2);
    return;
  }

  const analysis = analyzeContentious(contentiousRows);
  const selected = selectSamples({
    rows: usableRows,
    contentiousRows,
    targetTotal: Math.min(args.target_total, usableRows.length),
    seed: args.seed,
    overlayDiffMin: args.overlay_diff_min,
    overlayDiffPriorityWeight: args.overlay_diff_priority_weight,
  });
  const assignment = assignBatches(selected.selected, args.seed, args.overlap_ratio, args.overlap_min);

  const contentiousOverlayMissing = contentiousRows.filter((row) => row.overlay_diff_ratio == null).length;
  const contentiousOverlayMissingRate = contentiousRows.length > 0 ? contentiousOverlayMissing / contentiousRows.length : 0;
  const selectedOverlayMissing = selected.selected.filter((row) => overlayDiffRatioOf(row) == null).length;
  const selectedOverlayMissingRate = selected.selected.length > 0 ? selectedOverlayMissing / selected.selected.length : 0;
  if (contentiousOverlayMissing > 0) {
    warnings.push(`contentious_overlay_diff_missing=${contentiousOverlayMissing}/${contentiousRows.length} (${round3(contentiousOverlayMissingRate)})`);
  }
  if (selectedOverlayMissing > 0) {
    warnings.push(`selected_overlay_diff_missing=${selectedOverlayMissing}/${selected.selected.length} (${round3(selectedOverlayMissingRate)})`);
  }
  if (Math.max(contentiousOverlayMissingRate, selectedOverlayMissingRate) > 0.05) {
    warnings.push('overlay_diff_ratio_missing_rate>0.05; run `make preference-diagnostics ...` (overlay consistency gate) before proposing variants');
  }

  const candidatesInitial = buildCandidates({
    analysis,
    maxCandidates: args.max_candidates,
    seed: args.seed,
  });

  const goldScore = await tryGoldScore({
    args,
    outDir,
    candidates: candidatesInitial,
    warnings,
  });
  const crosssetScore = goldScore ? null : await tryCrosssetScore(args, warnings);
  const baselineMetrics = (goldScore && goldScore.baseline)
    || (crosssetScore && crosssetScore.baseline)
    || baselineFromManifestRows(selected.selected);

  const scored = scoreCandidates({
    candidates: candidatesInitial,
    analysis,
    baselineMetrics,
    gold: goldScore,
    crossset: crosssetScore,
  });

  const validCandidates = scored.ordered.filter((candidate) => candidate.valid);
  const recommended = (validCandidates.length ? validCandidates : scored.ordered).slice(0, Math.min(args.top_k, scored.ordered.length));

  const selectedCounts = selected.source_counts;
  const mergedTasks = [];
  const mergedRows = [];
  const flipMap = {};
  const candidateRunArtifacts = [];
  const labelStudioDocumentRoot = path.resolve(
    String(process.env.LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT || outDir),
  );

  for (let i = 0; i < recommended.length; i += 1) {
    const candidate = recommended[i];
    const candidateRunId = `${nextRunId}_${candidate.id}`;
    const candidateDir = path.join(outDir, 'candidate_runs', candidate.id);
    const reviewPath = path.join(outDir, '.inputs', `review_${candidate.id}.jsonl`);
    const syntheticRows = buildSyntheticReviewRows(selected.selected);
    await writeJsonl(reviewPath, syntheticRows);

    const packResult = await runPreferencePack({
      candidate,
      runId: candidateRunId,
      reviewPath,
      outDir: candidateDir,
      args,
      selectedCounts,
    });
    candidateRunArtifacts.push({
      candidate_id: candidate.id,
      candidate_dir: toPosix(path.relative(process.cwd(), candidateDir)),
      summary: packResult.summary,
    });

    const manifestRowsCandidate = Array.isArray(packResult.manifest.rows) ? packResult.manifest.rows : [];
    const bySample = new Map(manifestRowsCandidate.map((row) => [sampleIdOf(row), row]));

    for (const selectedRow of selected.selected) {
      const sampleId = selectedRow.sample_id;
      const row = bySample.get(sampleId);
      if (!row) continue;
      const taskId = `pref2_${candidate.id}_${sampleId}`;
      const taskBatch = assignment.batch_map.get(sampleId) || 'A';
      const riskFeatures = selectedRow.risk_features || {
        hair_overlap_est: null,
        leakage_bg_est_mean: null,
        min_module_pixels: null,
      };
      const imageAPath = path.resolve(String(row.image_a_path || ''));
      const imageBPath = path.resolve(String(row.image_b_path || ''));
      if (!fs.existsSync(imageAPath) || !fs.existsSync(imageBPath)) continue;

      const merged = {
        run_id: nextRunId,
        parent_run_id: runId,
        candidate_id: candidate.id,
        candidate_rank: i + 1,
        candidate_variant_kind: candidate.variant_kind,
        candidate_params: candidate.params,
        sample_id: sampleId,
        source: selectedRow.source,
        baseline_id: String(row.baseline_id || 'baseline_default'),
        variant_id: String(row.variant_id || candidate.id),
        role_a: String(row.role_a || 'baseline'),
        role_b: String(row.role_b || 'variant'),
        task_id: taskId,
        task_batch: taskBatch,
        double_annotate: taskBatch === 'OVERLAP',
        risk_features: riskFeatures,
        guarded_modules: selectedRow.guarded_modules || [],
        guard_triggered: Boolean(selectedRow.guard_triggered),
        image_a_path: imageAPath,
        image_b_path: imageBPath,
        image_a_path_rel: toPosix(path.relative(process.cwd(), imageAPath)),
        image_b_path_rel: toPosix(path.relative(process.cwd(), imageBPath)),
        candidate_pack_dir: toPosix(path.relative(process.cwd(), candidateDir)),
      };

      const taskData = {
        image_a: toLabelStudioLocalFilesUrl(imageAPath, { documentRoot: labelStudioDocumentRoot }),
        image_b: toLabelStudioLocalFilesUrl(imageBPath, { documentRoot: labelStudioDocumentRoot }),
        image_a_path: imageAPath,
        image_b_path: imageBPath,
        source: merged.source,
        sample_id: merged.sample_id,
        sample_hash: merged.sample_id,
        baseline_id: merged.baseline_id,
        variant_id: merged.variant_id,
        role_a: merged.role_a,
        role_b: merged.role_b,
        candidate_id: merged.candidate_id,
        candidate_rank: merged.candidate_rank,
        candidate_variant_kind: merged.candidate_variant_kind,
        candidate_params: merged.candidate_params,
        task_batch: merged.task_batch,
        double_annotate: merged.double_annotate,
        risk_features: merged.risk_features,
        adjudication: false,
      };
      const task = {
        id: taskId,
        data: taskData,
        meta: {
          run_id: nextRunId,
          parent_run_id: runId,
          ...taskData,
        },
        metadata: {
          run_id: nextRunId,
          parent_run_id: runId,
          ...taskData,
        },
      };

      mergedTasks.push(task);
      mergedRows.push(merged);
      flipMap[`${candidate.id}:${sampleId}`] = {
        role_a: merged.role_a,
        role_b: merged.role_b,
        flipped: merged.role_a === 'variant',
        a_variant_id: merged.role_a === 'baseline' ? merged.baseline_id : merged.variant_id,
        b_variant_id: merged.role_b === 'baseline' ? merged.baseline_id : merged.variant_id,
      };
    }
  }

  const orderedRows = deterministicSort(
    mergedRows,
    `${args.seed}:merged-rows`,
    (row) => `${String(row.candidate_rank || 99).padStart(2, '0')}:${row.candidate_id}:${row.sample_id}`,
  );
  const taskById = new Map(mergedTasks.map((task) => [String(task.id), task]));
  const orderedTasks = orderedRows
    .map((row) => taskById.get(row.task_id))
    .filter(Boolean);

  const overlapSet = new Set(assignment.overlap_sample_ids);
  const tasksBatchA = orderedTasks.filter((task) => {
    const batch = String(task.data && task.data.task_batch || '');
    return batch === 'A' || batch === 'OVERLAP';
  });
  const tasksBatchB = orderedTasks.filter((task) => {
    const batch = String(task.data && task.data.task_batch || '');
    return batch === 'B' || batch === 'OVERLAP';
  });
  const tasksOverlap = orderedTasks.filter((task) => overlapSet.has(String(task.data && task.data.sample_id || '')));

  const candidatesJsonPath = path.join(outDir, 'candidates.json');
  const recommendedPath = path.join(outDir, 'recommended.json');
  const tasksPath = path.join(outDir, 'tasks.json');
  const tasksAllPath = path.join(outDir, 'tasks_all.json');
  const tasksBatchAPath = path.join(outDir, 'tasks_batch_a.json');
  const tasksBatchBPath = path.join(outDir, 'tasks_batch_b.json');
  const tasksOverlapPath = path.join(outDir, 'tasks_overlap.json');
  const manifestOutPath = path.join(outDir, 'manifest.json');
  const previewPath = path.join(outDir, 'preview.md');

  const sourceBreakdown = {
    internal: selected.selected.filter((row) => row.source === 'internal').length,
    lapa: selected.selected.filter((row) => row.source === 'lapa').length,
    celebamaskhq: selected.selected.filter((row) => row.source === 'celebamaskhq').length,
  };

  const candidatesPayload = {
    ok: true,
    run_id: nextRunId,
    parent_run_id: runId,
    generated_at: new Date().toISOString(),
    score_source: scored.metrics_source,
    max_candidates: args.max_candidates,
    top_k: args.top_k,
    analysis,
    baseline_metrics: baselineMetrics,
    warnings,
    candidates: scored.ordered.map((candidate, idx) => ({
      rank: idx + 1,
      id: candidate.id,
      title: candidate.title,
      variant_kind: candidate.variant_kind,
      params: candidate.params,
      tags: candidate.tags,
      priority: candidate.priority,
      score: candidate.score,
      valid: candidate.valid,
      invalid_reasons: candidate.invalid_reasons,
      metrics: candidate.metrics,
      rationale: candidate.rationale,
    })),
    artifacts: {
      out_dir: toPosix(path.relative(process.cwd(), outDir)),
      manifest_json: toPosix(path.relative(process.cwd(), manifestOutPath)),
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
      gold_report_json: goldScore ? goldScore.report_json : null,
      crossset_jsonl: crosssetScore ? crosssetScore.path : null,
    },
  };

  const recommendedPayload = {
    ok: true,
    run_id: nextRunId,
    parent_run_id: runId,
    generated_at: new Date().toISOString(),
    top_k: recommended.length,
    score_source: scored.metrics_source,
    recommended: recommended.map((candidate, idx) => ({
      rank: idx + 1,
      id: candidate.id,
      title: candidate.title,
      variant_kind: candidate.variant_kind,
      params: candidate.params,
      score: candidate.score,
      valid: candidate.valid,
      rationale: candidate.rationale,
    })),
  };

  const manifestOut = {
    schema_version: 'aurora.preference_round2_pack.v1',
    run_id: nextRunId,
    parent_run_id: runId,
    generated_at: new Date().toISOString(),
    seed: args.seed,
    inputs: {
      manifest: toPosix(path.relative(process.cwd(), manifestPath)),
      contentious: toPosix(path.relative(process.cwd(), contentiousPath)),
      crossset_jsonl: args.crossset_jsonl ? toPosix(path.relative(process.cwd(), path.resolve(args.crossset_jsonl))) : null,
      gold_labels: args.gold_labels ? toPosix(path.relative(process.cwd(), path.resolve(args.gold_labels))) : null,
      pred_jsonl: args.pred_jsonl ? toPosix(path.relative(process.cwd(), path.resolve(args.pred_jsonl))) : null,
    },
    selection: {
      target_total: args.target_total,
      selected_total: selected.selected.length,
      pool_sizes: selected.pool_sizes,
      quotas: selected.quotas,
      source_breakdown: sourceBreakdown,
      coverage: selected.coverage,
      separability_policy: {
        overlay_diff_min: round3(args.overlay_diff_min),
        overlay_diff_priority_weight: round3(args.overlay_diff_priority_weight),
      },
    },
    overlap: {
      overlap_ratio: round3(args.overlap_ratio),
      overlap_min: args.overlap_min,
      overlap_count: assignment.overlap_count,
      sample_ids: assignment.overlap_sample_ids,
    },
    batch_counts: {
      tasks_total: orderedTasks.length,
      batch_a_total: tasksBatchA.length,
      batch_b_total: tasksBatchB.length,
      batch_overlap_total: tasksOverlap.length,
      unique_samples_total: selected.selected.length,
      candidates_total: recommended.length,
    },
    candidate_generation: {
      max_candidates: args.max_candidates,
      top_k_requested: args.top_k,
      score_source: scored.metrics_source,
      analysis,
      separability_policy: {
        overlay_diff_min: round3(args.overlay_diff_min),
        overlay_diff_priority_weight: round3(args.overlay_diff_priority_weight),
      },
    },
    baseline_metrics: baselineMetrics,
    warnings,
    candidates: candidatesPayload.candidates,
    recommended: recommendedPayload.recommended,
    flip_map: flipMap,
    batch_assignment: Object.fromEntries(
      assignment.ordered.map((row) => [row.sample_id, assignment.batch_map.get(row.sample_id) || 'A']),
    ),
    rows: orderedRows,
    candidate_runs: candidateRunArtifacts,
    artifacts: {
      out_dir: toPosix(path.relative(process.cwd(), outDir)),
      candidates_json: toPosix(path.relative(process.cwd(), candidatesJsonPath)),
      recommended_json: toPosix(path.relative(process.cwd(), recommendedPath)),
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      tasks_all_json: toPosix(path.relative(process.cwd(), tasksAllPath)),
      tasks_batch_a_json: toPosix(path.relative(process.cwd(), tasksBatchAPath)),
      tasks_batch_b_json: toPosix(path.relative(process.cwd(), tasksBatchBPath)),
      tasks_overlap_json: toPosix(path.relative(process.cwd(), tasksOverlapPath)),
      manifest_json: toPosix(path.relative(process.cwd(), manifestOutPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
    },
  };

  const previewMd = renderPreview({
    runId,
    nextRunId,
    outDirRel: toPosix(path.relative(process.cwd(), outDir)),
    recommended: recommendedPayload.recommended,
    selection: manifestOut.selection,
    rows: orderedRows,
    warnings,
  });

  await Promise.all([
    fsp.writeFile(candidatesJsonPath, `${JSON.stringify(candidatesPayload, null, 2)}\n`, 'utf8'),
    fsp.writeFile(recommendedPath, `${JSON.stringify(recommendedPayload, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksPath, `${JSON.stringify(orderedTasks, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksAllPath, `${JSON.stringify(orderedTasks, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksBatchAPath, `${JSON.stringify(tasksBatchA, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksBatchBPath, `${JSON.stringify(tasksBatchB, null, 2)}\n`, 'utf8'),
    fsp.writeFile(tasksOverlapPath, `${JSON.stringify(tasksOverlap, null, 2)}\n`, 'utf8'),
    fsp.writeFile(manifestOutPath, `${JSON.stringify(manifestOut, null, 2)}\n`, 'utf8'),
    fsp.writeFile(previewPath, previewMd, 'utf8'),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: nextRunId,
    parent_run_id: runId,
    selected_total: selected.selected.length,
    recommended_total: recommended.length,
    overlap_count: assignment.overlap_count,
    score_source: scored.metrics_source,
    artifacts: manifestOut.artifacts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_next_variants_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
