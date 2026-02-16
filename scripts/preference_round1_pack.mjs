#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import {
  runTimestampKey,
  sha256Hex,
} from './internal_batch_helpers.mjs';
import {
  readJsonlRows,
  resolvePackImage,
  toLabelStudioLocalFilesUrl,
  transcodeToPackJpeg,
  toPosix,
} from './local_image_loader.mjs';

const require = createRequire(import.meta.url);
const {
  runSkinDiagnosisV1,
  buildSkinAnalysisFromDiagnosisV1,
} = require('../src/auroraBff/skinDiagnosisV1');
const { inferSkinMaskOnFaceCrop } = require('../src/auroraBff/skinmaskOnnx');
const {
  bboxNormToMask,
  countOnes,
  encodeRleBinary,
  decodeRleBinary,
} = require('../src/auroraBff/evalAdapters/common/metrics');

const STRONG_MODULES = Object.freeze(['nose', 'forehead', 'left_cheek', 'right_cheek', 'chin']);
const WEAK_MODULES = Object.freeze(['under_eye_left', 'under_eye_right']);
const ALL_MODULES = Object.freeze([...STRONG_MODULES, ...WEAK_MODULES]);
const MODULE_COLORS = Object.freeze({
  face_oval: '#4CAF50',
  forehead: '#8BC34A',
  nose: '#03A9F4',
  left_cheek: '#FF5722',
  right_cheek: '#FF7043',
  chin: '#009688',
  under_eye_left: '#FFC107',
  under_eye_right: '#FFB300',
});
const MODULE_TEMPLATE_BOXES = Object.freeze({
  forehead: { x: 0.2, y: 0.03, w: 0.6, h: 0.22 },
  left_cheek: { x: 0.08, y: 0.34, w: 0.34, h: 0.3 },
  right_cheek: { x: 0.58, y: 0.34, w: 0.34, h: 0.3 },
  nose: { x: 0.42, y: 0.32, w: 0.16, h: 0.32 },
  chin: { x: 0.33, y: 0.67, w: 0.34, h: 0.26 },
  under_eye_left: { x: 0.16, y: 0.31, w: 0.26, h: 0.11 },
  under_eye_right: { x: 0.58, y: 0.31, w: 0.26, h: 0.11 },
});

const FACE_OVAL_POLYGON = Object.freeze([
  { x: 0.5, y: 0.06 },
  { x: 0.64, y: 0.1 },
  { x: 0.75, y: 0.2 },
  { x: 0.82, y: 0.35 },
  { x: 0.84, y: 0.5 },
  { x: 0.8, y: 0.66 },
  { x: 0.72, y: 0.8 },
  { x: 0.62, y: 0.9 },
  { x: 0.5, y: 0.95 },
  { x: 0.38, y: 0.9 },
  { x: 0.28, y: 0.8 },
  { x: 0.2, y: 0.66 },
  { x: 0.16, y: 0.5 },
  { x: 0.18, y: 0.35 },
  { x: 0.25, y: 0.2 },
  { x: 0.36, y: 0.1 },
]);

const DEFAULTS = Object.freeze({
  limit_internal: 38,
  limit_lapa: 60,
  limit_celeba: 60,
  seed: 'preference_round1_seed_v1',
  variant: 'variant1',
  report_dir: 'reports',
  cache_dir: path.join('datasets_cache', 'external'),
  converted_subdir: 'converted',
  images_subdir: 'images',
  mock_pipeline: false,
  variant2_min_coverage: 0.012,
  variant1_forehead_top_clip_ratio: 0.12,
  variant3_min_pixels: 12,
  variant3_min_keep_ratio: 0.25,
  module_box_mode: 'dynamic_skinmask',
  require_dynamic_boxes: false,
  exclude_template_like: false,
  min_geometry_qc_score: 0,
  template_match_eps: 0.004,
  hard_filter_gate: false,
  hard_filter_require_quality_pass: true,
  hard_filter_max_guarded_modules: 1,
  hard_filter_min_module_pixels: 48,
  hard_filter_min_dynamic_score: 0.7,
  hard_filter_min_box_plausibility: 0.72,
  hard_filter_min_mask_rle_ratio: 0,
  hard_filter_min_face_span_h: 0,
  hard_filter_min_face_span_w: 0,
  hard_filter_min_face_span_area: 0,
  hard_filter_require_onnx_skinmask: false,
  hard_filter_min_overlap_score: 0,
  hard_filter_max_abs_yaw: 1,
  hard_filter_require_all_strong_modules: true,
  hard_filter_fail_on_empty: true,
  skinmask_onnx_enabled: true,
  skinmask_onnx_strict: true,
  skinmask_model_path: path.join('artifacts', 'skinmask_v2.onnx'),
  skinmask_timeout_ms: 1200,
  max_edge: 2048,
  concurrency: 2,
});

const HELP_TEXT = `preference_round1_pack.mjs

Usage:
  node scripts/preference_round1_pack.mjs --review_in <review_pack_mixed.jsonl|csv> [options]

Required:
  --review_in <path>                    review_pack_mixed input file

Options:
  --run_id <id>                         run id (default: infer from review filename)
  --out <dir>                           output root (default: artifacts/preference_round1_<run_id>)
  --variant <variant1|variant2|variant3>
  --seed <token>                        deterministic seed (default: preference_round1_seed_v1)
  --limit_internal <n>                  selected internal samples (default: 38)
  --limit_lapa <n>                      selected lapa samples (default: 60)
  --limit_celeba <n>                    selected celebamaskhq samples (default: 60)
  --internal_dir <path>                 internal image root
  --cache_dir <path>                    external cache root (default: datasets_cache/external)
  --lapa_dir <path>                     accepted for compatibility; resolved via cache_dir/lapa
  --celeba_dir <path>                   accepted for compatibility; resolved via cache_dir/celebamaskhq
  --variant2_min_coverage <0-1>         under-eye fallback-empty threshold (default: 0.012)
  --variant1_forehead_top_clip_ratio <0-1>
  --variant3_min_pixels <n>
  --variant3_min_keep_ratio <0-1>
  --module_box_mode <static|dynamic_skinmask|auto>   module box source mode (default: dynamic_skinmask)
  --require_dynamic_boxes <bool>         exclude sample if dynamic boxes were not applied (default: false)
  --exclude_template_like <bool>         exclude sample if boxes match static template (default: false)
  --min_geometry_qc_score <0-1>          exclude sample when geometry QC score is lower (default: 0, disabled)
  --template_match_eps <0-0.05>          per-coordinate tolerance for template-like match (default: 0.004)
  --hard_filter_gate <bool>              enable offline hard-filter gate before writing tasks (default: false)
  --hard_filter_require_quality_pass <bool>  require quality_grade=pass in both A/B (default: true)
  --hard_filter_max_guarded_modules <n>  max allowed guarded modules per side (default: 1)
  --hard_filter_min_module_pixels <n>    min allowed module_pixels_min per side (default: 48)
  --hard_filter_min_dynamic_score <0-1>  min allowed dynamic box score per side (default: 0.7)
  --hard_filter_min_box_plausibility <0-1>  min allowed module-box plausibility score per side (default: 0.72)
  --hard_filter_min_mask_rle_ratio <0-1>  min strong-module mask_rle coverage per side (default: 0, disabled)
  --hard_filter_min_face_span_h <0-1>  min strong-module vertical span per side (default: 0, disabled)
  --hard_filter_min_face_span_w <0-1>  min strong-module horizontal span per side (default: 0, disabled)
  --hard_filter_min_face_span_area <0-1>  min strong-module bbox area per side (default: 0, disabled)
  --hard_filter_require_onnx_skinmask <bool>  require ONNX skinmask source in both A/B (default: false)
  --hard_filter_min_overlap_score <0-1>  min module_box_overlap_score per side (default: 0, disabled)
  --hard_filter_max_abs_yaw <0-1>  max absolute yaw_est per side (default: 1, disabled)
  --hard_filter_require_all_strong_modules <bool>  require 5 strong modules in both A/B (default: true)
  --hard_filter_fail_on_empty <bool>     exit non-zero when hard-filter removes all samples (default: true)
  --skinmask_onnx_enabled <bool>         enable ONNX skinmask for module boxes (default: true)
  --skinmask_onnx_strict <bool>          if ONNX fails, exclude/fallback-null instead of bbox prior (default: true)
  --skinmask_model_path <path>           ONNX model path (default: artifacts/skinmask_v2.onnx)
  --skinmask_timeout_ms <n>              ONNX timeout in ms per side (default: 1200)
  --mock_pipeline <bool>                deterministic mock pipeline for smoke/tests
  --max_edge <n>                        max edge for render buffer (default: 2048)
  --concurrency <n>                     local processing concurrency (default: 2)
  --help                                show help
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

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
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
  if (ext !== '.csv') throw new Error(`unsupported_review_input:${ext || 'unknown'}`);
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
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = values[j] == null ? '' : values[j];
    rows.push(row);
  }
  return rows;
}

function normalizeSource(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return 'unknown';
  if (token === 'celeb' || token === 'celeba' || token === 'celebamask') return 'celebamaskhq';
  return token;
}

function normalizeReviewRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = normalizeSource(raw.source || raw.dataset);
  const sampleHash = String(raw.sample_hash || '').trim();
  const imagePathRel = String(raw.image_path_rel || raw.image_rel || '').trim();
  const imagePathAbs = String(raw.image_path || '').trim();
  if (!source || !sampleHash) return null;
  const riskScore = Number(raw.risk_score);
  const minModulePixels = Number(raw.min_module_pixels ?? raw.module_pixels_min);
  const leakageBgEst = Number(raw.leakage_bg_est_mean ?? raw.leakage_bg_mean);
  const hairOverlapEst = Number(raw.forehead_hair_overlap_rate ?? raw.hair_as_skin_rate);
  const ok = parseBool(raw.ok, false);
  const pipelineModeUsed = String(raw.pipeline_mode_used || '').trim().toLowerCase();
  const moduleGuardTriggered = parseBool(raw.module_guard_triggered, false);
  const guardedModules = Array.isArray(raw.guarded_modules)
    ? raw.guarded_modules.map((item) => String(item || '').trim()).filter(Boolean)
    : String(raw.guarded_modules || '')
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    raw,
    source,
    sample_hash: sampleHash,
    image_path_rel: imagePathRel,
    image_path_abs: imagePathAbs,
    ok,
    pipeline_mode_used: pipelineModeUsed,
    risk_score: Number.isFinite(riskScore) ? riskScore : 0,
    min_module_pixels: Number.isFinite(minModulePixels) ? Math.max(0, Math.trunc(minModulePixels)) : 0,
    leakage_bg_est_mean: Number.isFinite(leakageBgEst) ? leakageBgEst : null,
    hair_overlap_est: Number.isFinite(hairOverlapEst) ? hairOverlapEst : null,
    module_guard_triggered: moduleGuardTriggered || guardedModules.length > 0,
    guarded_modules: guardedModules,
  };
}

function isCandidate(row) {
  if (!row || typeof row !== 'object') return false;
  if (!row.ok) return false;
  if (!row.sample_hash) return false;
  if (row.pipeline_mode_used && row.pipeline_mode_used !== 'local') return false;
  if (!row.image_path_rel && !row.image_path_abs) return false;
  if (/^https?:\/\//i.test(String(row.image_path_rel || '').trim())) return false;
  return ['internal', 'lapa', 'celebamaskhq'].includes(row.source);
}

function deterministicOrder(rows, seed) {
  return [...rows].sort((a, b) => {
    const riskA = Number(a.risk_score || 0);
    const riskB = Number(b.risk_score || 0);
    if (riskA !== riskB) return riskB - riskA;
    const minA = Number(a.min_module_pixels || 0);
    const minB = Number(b.min_module_pixels || 0);
    if (minA !== minB) return minA - minB;
    const keyA = sha256Hex(`${seed}:${a.source}:${a.sample_hash}`);
    const keyB = sha256Hex(`${seed}:${b.source}:${b.sample_hash}`);
    if (keyA === keyB) return a.sample_hash.localeCompare(b.sample_hash);
    return keyA.localeCompare(keyB);
  });
}

function selectRows(candidates, args) {
  const bySource = {
    internal: deterministicOrder(candidates.filter((row) => row.source === 'internal'), `${args.seed}:internal`),
    lapa: deterministicOrder(candidates.filter((row) => row.source === 'lapa'), `${args.seed}:lapa`),
    celebamaskhq: deterministicOrder(candidates.filter((row) => row.source === 'celebamaskhq'), `${args.seed}:celebamaskhq`),
  };
  const selected = [
    ...bySource.internal.slice(0, args.limit_internal),
    ...bySource.lapa.slice(0, args.limit_lapa),
    ...bySource.celebamaskhq.slice(0, args.limit_celeba),
  ];
  return {
    selected,
    counts: {
      internal: selected.filter((row) => row.source === 'internal').length,
      lapa: selected.filter((row) => row.source === 'lapa').length,
      celebamaskhq: selected.filter((row) => row.source === 'celebamaskhq').length,
    },
    pools: {
      internal: bySource.internal.length,
      lapa: bySource.lapa.length,
      celebamaskhq: bySource.celebamaskhq.length,
    },
  };
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  const token = path.basename(String(args.review_in || ''));
  const match = token.match(/review_pack_mixed_(\d{15}|\d{8}_\d{6,9})\.(jsonl|ndjson|csv)$/i);
  if (match) return match[1];
  return runTimestampKey();
}

function parseArgs(argv) {
  const home = process.env.HOME || '';
  const out = {
    help: false,
    run_id: process.env.RUN_ID || '',
    review_in: process.env.REVIEW_JSONL || process.env.REVIEW_IN || '',
    out: process.env.OUT || '',
    variant: process.env.VARIANT || DEFAULTS.variant,
    seed: process.env.PREFERENCE_SEED || DEFAULTS.seed,
    limit_internal: process.env.LIMIT_INTERNAL || DEFAULTS.limit_internal,
    limit_lapa: process.env.LIMIT_LAPA || DEFAULTS.limit_lapa,
    limit_celeba: process.env.LIMIT_CELEBA || DEFAULTS.limit_celeba,
    internal_dir: process.env.INTERNAL_DIR || path.join(home, 'Desktop', 'Aurora', 'internal test photos'),
    cache_dir: process.env.CACHE_DIR || DEFAULTS.cache_dir,
    lapa_dir: process.env.LAPA_DIR || '',
    celeba_dir: process.env.CELEBA_DIR || '',
    variant2_min_coverage: process.env.PREF_VARIANT2_MIN_COVERAGE || DEFAULTS.variant2_min_coverage,
    variant1_forehead_top_clip_ratio: process.env.PREF_VARIANT1_FOREHEAD_TOP_CLIP_RATIO || DEFAULTS.variant1_forehead_top_clip_ratio,
    variant3_min_pixels: process.env.PREF_VARIANT3_MIN_PIXELS || DEFAULTS.variant3_min_pixels,
    variant3_min_keep_ratio: process.env.PREF_VARIANT3_MIN_KEEP_RATIO || DEFAULTS.variant3_min_keep_ratio,
    module_box_mode: process.env.PREF_MODULE_BOX_MODE || process.env.DIAG_MODULE_BOX_MODE || DEFAULTS.module_box_mode,
    require_dynamic_boxes: process.env.PREF_REQUIRE_DYNAMIC_BOXES || DEFAULTS.require_dynamic_boxes,
    exclude_template_like: process.env.PREF_EXCLUDE_TEMPLATE_LIKE || DEFAULTS.exclude_template_like,
    min_geometry_qc_score: process.env.PREF_MIN_GEOMETRY_QC_SCORE || DEFAULTS.min_geometry_qc_score,
    template_match_eps: process.env.PREF_TEMPLATE_MATCH_EPS || DEFAULTS.template_match_eps,
    hard_filter_gate: process.env.PREF_HARD_FILTER_GATE || DEFAULTS.hard_filter_gate,
    hard_filter_require_quality_pass: process.env.PREF_HARD_FILTER_REQUIRE_QUALITY_PASS || DEFAULTS.hard_filter_require_quality_pass,
    hard_filter_max_guarded_modules: process.env.PREF_HARD_FILTER_MAX_GUARDED_MODULES || DEFAULTS.hard_filter_max_guarded_modules,
    hard_filter_min_module_pixels: process.env.PREF_HARD_FILTER_MIN_MODULE_PIXELS || DEFAULTS.hard_filter_min_module_pixels,
    hard_filter_min_dynamic_score: process.env.PREF_HARD_FILTER_MIN_DYNAMIC_SCORE || DEFAULTS.hard_filter_min_dynamic_score,
    hard_filter_min_box_plausibility: process.env.PREF_HARD_FILTER_MIN_BOX_PLAUSIBILITY || DEFAULTS.hard_filter_min_box_plausibility,
    hard_filter_min_mask_rle_ratio: process.env.PREF_HARD_FILTER_MIN_MASK_RLE_RATIO || DEFAULTS.hard_filter_min_mask_rle_ratio,
    hard_filter_min_face_span_h: process.env.PREF_HARD_FILTER_MIN_FACE_SPAN_H || DEFAULTS.hard_filter_min_face_span_h,
    hard_filter_min_face_span_w: process.env.PREF_HARD_FILTER_MIN_FACE_SPAN_W || DEFAULTS.hard_filter_min_face_span_w,
    hard_filter_min_face_span_area: process.env.PREF_HARD_FILTER_MIN_FACE_SPAN_AREA || DEFAULTS.hard_filter_min_face_span_area,
    hard_filter_require_onnx_skinmask:
      process.env.PREF_HARD_FILTER_REQUIRE_ONNX_SKINMASK || DEFAULTS.hard_filter_require_onnx_skinmask,
    hard_filter_min_overlap_score:
      process.env.PREF_HARD_FILTER_MIN_OVERLAP_SCORE || DEFAULTS.hard_filter_min_overlap_score,
    hard_filter_max_abs_yaw:
      process.env.PREF_HARD_FILTER_MAX_ABS_YAW || DEFAULTS.hard_filter_max_abs_yaw,
    hard_filter_require_all_strong_modules: process.env.PREF_HARD_FILTER_REQUIRE_ALL_STRONG_MODULES || DEFAULTS.hard_filter_require_all_strong_modules,
    hard_filter_fail_on_empty: process.env.PREF_HARD_FILTER_FAIL_ON_EMPTY || DEFAULTS.hard_filter_fail_on_empty,
    skinmask_onnx_enabled: process.env.PREF_SKINMASK_ONNX_ENABLED || DEFAULTS.skinmask_onnx_enabled,
    skinmask_onnx_strict: process.env.PREF_SKINMASK_ONNX_STRICT || DEFAULTS.skinmask_onnx_strict,
    skinmask_model_path: process.env.PREF_SKINMASK_MODEL_PATH || process.env.DIAG_SKINMASK_MODEL_PATH || DEFAULTS.skinmask_model_path,
    skinmask_timeout_ms: process.env.PREF_SKINMASK_TIMEOUT_MS || process.env.DIAG_SKINMASK_TIMEOUT_MS || DEFAULTS.skinmask_timeout_ms,
    mock_pipeline: process.env.PREF_MOCK_PIPELINE || String(DEFAULTS.mock_pipeline),
    max_edge: process.env.MAX_EDGE || DEFAULTS.max_edge,
    concurrency: process.env.CONCURRENCY || DEFAULTS.concurrency,
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
  out.review_in = String(out.review_in || '').trim();
  out.out = String(out.out || '').trim();
  out.variant = String(out.variant || DEFAULTS.variant).trim().toLowerCase();
  out.seed = String(out.seed || DEFAULTS.seed).trim() || DEFAULTS.seed;
  out.limit_internal = Math.max(0, Math.min(5000, Math.trunc(parseNumber(out.limit_internal, DEFAULTS.limit_internal, 0, 5000))));
  out.limit_lapa = Math.max(0, Math.min(5000, Math.trunc(parseNumber(out.limit_lapa, DEFAULTS.limit_lapa, 0, 5000))));
  out.limit_celeba = Math.max(0, Math.min(5000, Math.trunc(parseNumber(out.limit_celeba, DEFAULTS.limit_celeba, 0, 5000))));
  out.internal_dir = String(out.internal_dir || '').trim();
  out.cache_dir = String(out.cache_dir || DEFAULTS.cache_dir).trim() || DEFAULTS.cache_dir;
  out.lapa_dir = String(out.lapa_dir || '').trim();
  out.celeba_dir = String(out.celeba_dir || '').trim();
  out.variant2_min_coverage = clamp01(out.variant2_min_coverage);
  out.variant1_forehead_top_clip_ratio = clamp01(out.variant1_forehead_top_clip_ratio);
  out.variant3_min_pixels = Math.max(1, Math.min(512, Math.trunc(parseNumber(out.variant3_min_pixels, DEFAULTS.variant3_min_pixels, 1, 512))));
  out.variant3_min_keep_ratio = clamp01(out.variant3_min_keep_ratio);
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
  out.hard_filter_fail_on_empty = parseBool(out.hard_filter_fail_on_empty, DEFAULTS.hard_filter_fail_on_empty);
  out.skinmask_onnx_enabled = parseBool(out.skinmask_onnx_enabled, DEFAULTS.skinmask_onnx_enabled);
  out.skinmask_onnx_strict = parseBool(out.skinmask_onnx_strict, DEFAULTS.skinmask_onnx_strict);
  out.skinmask_model_path = String(out.skinmask_model_path || DEFAULTS.skinmask_model_path).trim();
  out.skinmask_timeout_ms = Math.max(
    50,
    Math.min(
      60000,
      Math.trunc(parseNumber(out.skinmask_timeout_ms, DEFAULTS.skinmask_timeout_ms, 50, 60000)),
    ),
  );
  out.mock_pipeline = parseBool(out.mock_pipeline, DEFAULTS.mock_pipeline);
  out.max_edge = Math.max(64, Math.min(4096, Math.trunc(parseNumber(out.max_edge, DEFAULTS.max_edge, 64, 4096))));
  out.concurrency = Math.max(1, Math.min(8, Math.trunc(parseNumber(out.concurrency, DEFAULTS.concurrency, 1, 8))));
  return out;
}

function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const x0 = clamp01(x);
  const y0 = clamp01(y);
  const x1 = clamp01(x + w);
  const y1 = clamp01(y + h);
  const nx = Math.min(x0, x1);
  const ny = Math.min(y0, y1);
  const nw = Math.max(0, Math.abs(x1 - x0));
  const nh = Math.max(0, Math.abs(y1 - y0));
  if (nw <= 0.001 || nh <= 0.001) return null;
  return { x: round3(nx), y: round3(ny), w: round3(nw), h: round3(nh) };
}

function parseModuleRows(payload) {
  const modules = Array.isArray(payload && payload.modules) ? payload.modules : [];
  return modules.map((moduleRow) => ({
    module_id: String(moduleRow && moduleRow.module_id ? moduleRow.module_id : '').trim(),
    box: normalizeBox(moduleRow && moduleRow.box),
    mask_rle_norm: typeof (moduleRow && moduleRow.mask_rle_norm) === 'string'
      ? moduleRow.mask_rle_norm
      : null,
    mask_grid: Math.max(16, Math.min(512, Math.trunc(Number(moduleRow && moduleRow.mask_grid) || 64))),
    module_pixels: Math.max(0, Math.trunc(Number(moduleRow && moduleRow.module_pixels) || 0)),
  })).filter((row) => row.module_id);
}

function moduleRowsToMap(moduleRows) {
  const map = new Map();
  for (const row of moduleRows) map.set(row.module_id, row);
  return map;
}

function replaceModuleByBox(moduleRow, box) {
  const safeBox = normalizeBox(box);
  if (!safeBox) return moduleRow;
  const grid = Math.max(16, Math.min(512, Math.trunc(Number(moduleRow.mask_grid) || 64)));
  const mask = bboxNormToMask(safeBox, grid, grid);
  return {
    ...moduleRow,
    box: safeBox,
    mask_grid: grid,
    module_pixels: countOnes(mask),
    mask_rle_norm: encodeRleBinary(mask),
  };
}

function applyVariant1ToModuleRows(moduleRows, args) {
  const ratio = clamp01(args.variant1_forehead_top_clip_ratio);
  return moduleRows.map((row) => {
    if (row.module_id !== 'forehead' || !row.box) return row;
    const topClip = row.box.h * ratio;
    const next = {
      x: row.box.x,
      y: row.box.y + topClip,
      w: row.box.w,
      h: row.box.h - topClip,
    };
    return replaceModuleByBox(row, next);
  });
}

function applyVariant2ToModuleRows(moduleRows, args) {
  const threshold = clamp01(args.variant2_min_coverage);
  return moduleRows.map((row) => {
    if (row.module_id !== 'under_eye_left' && row.module_id !== 'under_eye_right') return row;
    const grid = Math.max(16, Math.min(512, Math.trunc(Number(row.mask_grid) || 64)));
    const pixels = Number(row.module_pixels || 0);
    const ratio = pixels > 0 ? pixels / (grid * grid) : 0;
    if (ratio >= threshold) return row;
    const empty = new Uint8Array(grid * grid);
    return {
      ...row,
      module_pixels: 0,
      mask_grid: grid,
      mask_rle_norm: encodeRleBinary(empty),
      box: null,
    };
  });
}

function parseVariant(args) {
  const token = String(args.variant || '').trim().toLowerCase();
  if (token === 'variant1') {
    return {
      baseline_id: 'baseline_default',
      variant_id: 'variant1_forehead_hair_clip',
      variant_kind: 'variant1',
      env_overrides: {},
      applyPostprocess: (rows) => applyVariant1ToModuleRows(rows, args),
      description: 'forehead hair-aware clip (top strip clip heuristic)',
    };
  }
  if (token === 'variant2') {
    return {
      baseline_id: 'baseline_default',
      variant_id: 'variant2_under_eye_relaxed_guard',
      variant_kind: 'variant2',
      env_overrides: {
        DIAG_MODULE_MIN_PIXELS_UNDER_EYE: '1',
        DIAG_MODULE_GUARD_DILATION_MAX_ITER: '0',
      },
      applyPostprocess: (rows) => applyVariant2ToModuleRows(rows, args),
      description: 'under-eye relaxed guard + low coverage fallback empty',
    };
  }
  if (token === 'variant3') {
    const ratioToken = String(args.variant3_min_keep_ratio).replace('.', '_');
    return {
      baseline_id: 'baseline_default',
      variant_id: `variant3_clip_${args.variant3_min_pixels}_${ratioToken}`,
      variant_kind: 'variant3',
      env_overrides: {
        DIAG_FACE_OVAL_CLIP_MIN_PIXELS: String(args.variant3_min_pixels),
        DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO: String(args.variant3_min_keep_ratio),
      },
      applyPostprocess: (rows) => rows,
      description: `face_oval clip sweep min_pixels=${args.variant3_min_pixels}, min_keep_ratio=${args.variant3_min_keep_ratio}`,
    };
  }
  throw new Error(`unsupported_variant:${args.variant}`);
}

function withEnvOverrides(envOverrides, loader) {
  const keys = Object.keys(envOverrides || {});
  const saved = new Map();
  for (const key of keys) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = String(envOverrides[key]);
  }
  try {
    return loader();
  } finally {
    for (const key of keys) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

function loadBuildPhotoModulesCardWithEnv(envOverrides = {}) {
  const modulePath = require.resolve('../src/auroraBff/photoModulesV1');
  return withEnvOverrides(envOverrides, () => {
    delete require.cache[modulePath];
    const mod = require(modulePath);
    if (!mod || typeof mod.buildPhotoModulesCard !== 'function') {
      throw new Error('photo_modules_builder_missing');
    }
    return mod.buildPhotoModulesCard;
  });
}

function buildPipelineEnvOverrides(args, variantEnvOverrides = {}) {
  const merged = {
    DIAG_MODULE_BOX_MODE: String(args.module_box_mode || DEFAULTS.module_box_mode || 'dynamic_skinmask'),
    ...variantEnvOverrides,
  };
  const out = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

function normalizeQualityGrade(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'pass' || token === 'degraded' || token === 'fail') return token;
  return 'unknown';
}

function fallbackFaceCropFromDiagnosisInternal(diagnosisInternal) {
  const internal = diagnosisInternal && typeof diagnosisInternal === 'object' ? diagnosisInternal : {};
  const existing = internal.face_crop && typeof internal.face_crop === 'object' ? internal.face_crop : null;
  if (existing && existing.bbox_px && typeof existing.bbox_px === 'object') return existing;
  const origW = Math.max(1, Math.trunc(Number(internal.orig_size_px && internal.orig_size_px.w) || 1));
  const origH = Math.max(1, Math.trunc(Number(internal.orig_size_px && internal.orig_size_px.h) || 1));
  return {
    coord_space: 'orig_px_v1',
    bbox_px: { x: 0, y: 0, w: origW, h: origH },
    orig_size_px: { w: origW, h: origH },
    render_size_px_hint: { w: Math.max(1, Math.min(origW, 512)), h: Math.max(1, Math.min(origH, 512)) },
  };
}

function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
  const ms = Math.max(50, Math.min(60000, Math.trunc(Number(timeoutMs) || DEFAULTS.skinmask_timeout_ms)));
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const error = new Error(code);
      error.code = code;
      setTimeout(() => reject(error), ms);
    }),
  ]);
}

function skinMaskPriorFromDiagnosisInternal(internal) {
  const safeInternal = internal && typeof internal === 'object' ? internal : null;
  const norm = safeInternal && safeInternal.skin_bbox_norm && typeof safeInternal.skin_bbox_norm === 'object'
    ? safeInternal.skin_bbox_norm
    : null;
  if (!norm) return null;
  const x0 = clamp01(norm.x0);
  const y0 = clamp01(norm.y0);
  const x1 = clamp01(norm.x1);
  const y1 = clamp01(norm.y1);
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.max(0, Math.abs(x1 - x0));
  const h = Math.max(0, Math.abs(y1 - y0));
  if (w <= 0.01 || h <= 0.01) return null;
  return {
    bbox: { x, y, w, h },
    positive_ratio: Math.max(0, Math.min(1, w * h)),
  };
}

async function inferSkinMaskForPackModules({ imageBuffer, diagnosisInternal, args } = {}) {
  const priorMask = skinMaskPriorFromDiagnosisInternal(diagnosisInternal);
  const strict = Boolean(args && args.skinmask_onnx_strict);
  const enabled = Boolean(args && args.skinmask_onnx_enabled);
  const modelPath = String(args && args.skinmask_model_path ? args.skinmask_model_path : '').trim();
  if (!enabled) {
    return {
      skinMask: priorMask,
      source: priorMask ? 'bbox_prior' : 'none',
      onnx_ok: false,
      onnx_reason: 'onnx_disabled',
    };
  }
  if (!modelPath) {
    return {
      skinMask: strict ? null : priorMask,
      source: strict ? 'none' : (priorMask ? 'bbox_prior' : 'none'),
      onnx_ok: false,
      onnx_reason: 'onnx_model_missing',
    };
  }
  const modelPathResolved = path.isAbsolute(modelPath) ? modelPath : path.resolve(modelPath);
  try {
    const inferred = await withTimeout(
      Promise.resolve(
        inferSkinMaskOnFaceCrop({
          imageBuffer,
          diagnosisInternal,
          modelPath: modelPathResolved,
        }),
      ),
      args && args.skinmask_timeout_ms,
      'SKINMASK_TIMEOUT',
    );
    if (inferred && inferred.ok && typeof inferred.mask_rle_norm === 'string' && inferred.mask_rle_norm.trim()) {
      return {
        skinMask: {
          mask_grid: Math.max(16, Math.min(512, Math.trunc(Number(inferred.mask_grid) || 64))),
          mask_rle_norm: inferred.mask_rle_norm,
          positive_ratio: Number.isFinite(Number(inferred.positive_ratio)) ? Number(inferred.positive_ratio) : null,
          ...(inferred.bbox && typeof inferred.bbox === 'object' ? { bbox: inferred.bbox } : {}),
        },
        source: 'onnx_rle',
        onnx_ok: true,
        onnx_reason: null,
      };
    }
    return {
      skinMask: strict ? null : priorMask,
      source: strict ? 'none' : (priorMask ? 'bbox_prior' : 'none'),
      onnx_ok: false,
      onnx_reason: String(inferred && inferred.reason ? inferred.reason : 'onnx_no_mask'),
    };
  } catch (error) {
    const reason = String(error && (error.code || error.message) ? (error.code || error.message) : 'onnx_exception');
    return {
      skinMask: strict ? null : priorMask,
      source: strict ? 'none' : (priorMask ? 'bbox_prior' : 'none'),
      onnx_ok: false,
      onnx_reason: reason,
    };
  }
}

function buildMockPayload({ sampleHash, variantKind }) {
  const seed = sha256Hex(`${sampleHash}:${variantKind}`);
  const jitter = (idx, scale) => {
    const token = seed.slice(idx, idx + 2);
    const n = parseInt(token || '00', 16) / 255;
    return (n - 0.5) * scale;
  };
  const baseBoxes = MODULE_TEMPLATE_BOXES;
  const modules = ALL_MODULES.map((moduleId, idx) => {
    const box = baseBoxes[moduleId];
    const shift = jitter(idx * 2, 0.04);
    const variantShift = variantKind === 'variant1' && moduleId === 'forehead'
      ? -0.03
      : variantKind === 'variant2' && moduleId.startsWith('under_eye')
        ? 0.02
        : 0;
    const next = normalizeBox({
      x: box.x + shift * 0.4,
      y: box.y + variantShift,
      w: box.w,
      h: box.h * (variantKind === 'variant1' && moduleId === 'forehead' ? 0.85 : 1),
    });
    return replaceModuleByBox({ module_id: moduleId, box: next, mask_grid: 64, module_pixels: 0, mask_rle_norm: null }, next);
  });
  return {
    used_photos: true,
    quality_grade: 'pass',
    face_crop: {
      coord_space: 'orig_px_v1',
      bbox_px: { x: 0, y: 0, w: 256, h: 256 },
      orig_size_px: { w: 256, h: 256 },
      render_size_px_hint: { w: 256, h: 256 },
    },
    modules,
    internal_debug: {
      module_box_mode: 'dynamic_skinmask',
      module_box_dynamic_applied: true,
      module_box_dynamic_reason: null,
      module_box_dynamic_score: 1,
      module_guard_triggered: modules.some((row) => row.module_id.startsWith('under_eye') && row.module_pixels < 30),
      module_pixels_map: Object.fromEntries(modules.map((row) => [row.module_id, row.module_pixels || 0])),
      module_pixels_min: Math.min(...modules.map((row) => Number(row.module_pixels || 0))),
      module_guard_pixel_diffs: [],
      guarded_modules: [],
    },
  };
}

async function runLocalPipeline({
  imageBuffer,
  sampleHash,
  lang,
  args,
  buildPhotoModulesCard,
  postprocess,
  mockMode,
  variantKind,
}) {
  if (mockMode) {
    const payload = buildMockPayload({ sampleHash, variantKind });
    const moduleRows = postprocess(parseModuleRows(payload));
    payload.modules = moduleRows;
    return {
      ok: true,
      payload,
      module_rows: moduleRows,
      quality_grade: 'pass',
      reason: null,
    };
  }

  let diagnosis = null;
  try {
    diagnosis = await runSkinDiagnosisV1({
      imageBuffer,
      language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
      profileSummary: null,
      recentLogsSummary: null,
    });
  } catch (error) {
    return {
      ok: false,
      payload: null,
      module_rows: [],
      quality_grade: 'unknown',
      reason: `diagnosis_exception:${String(error && error.message ? error.message : error)}`,
    };
  }
  if (!diagnosis || !diagnosis.ok) {
    return {
      ok: false,
      payload: null,
      module_rows: [],
      quality_grade: 'unknown',
      reason: `diagnosis_fail:${String(diagnosis && diagnosis.reason ? diagnosis.reason : 'unknown')}`,
    };
  }

  const quality = diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null;
  const qualityGrade = normalizeQualityGrade(quality && quality.grade);
  const analysis = buildSkinAnalysisFromDiagnosisV1(diagnosis.diagnosis, {
    language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
    profileSummary: null,
  });
  const skinMaskResult = await inferSkinMaskForPackModules({
    imageBuffer,
    diagnosisInternal: diagnosis.internal || null,
    args,
  });

  let built;
  try {
    const skinMask = skinMaskResult && typeof skinMaskResult === 'object' ? skinMaskResult.skinMask : null;
    built = buildPhotoModulesCard({
      requestId: `pref_${sampleHash}`,
      analysis,
      usedPhotos: true,
      photoQuality: quality,
      photoNotice: null,
      diagnosisInternal: diagnosis.internal || null,
      profileSummary: null,
      language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
      ingredientRecEnabled: false,
      productRecEnabled: false,
      internalTestMode: true,
      skinMask,
    });
  } catch (error) {
    return {
      ok: false,
      payload: null,
      module_rows: [],
      quality_grade: qualityGrade,
      reason: `module_builder_exception:${String(error && error.message ? error.message : error)}`,
    };
  }

  const payload =
    built && built.card && built.card.payload && typeof built.card.payload === 'object'
      ? built.card.payload
      : {
          used_photos: true,
          quality_grade: qualityGrade,
          face_crop: fallbackFaceCropFromDiagnosisInternal(diagnosis.internal || null),
          regions: [],
          modules: [],
        };

  const moduleRows = postprocess(parseModuleRows(payload));
  payload.modules = moduleRows;
  const internalDebug = payload.internal_debug && typeof payload.internal_debug === 'object'
    ? payload.internal_debug
    : {};
  payload.internal_debug = {
    ...internalDebug,
    skinmask_source: skinMaskResult && skinMaskResult.source ? skinMaskResult.source : 'none',
    skinmask_onnx_ok: Boolean(skinMaskResult && skinMaskResult.onnx_ok),
    skinmask_onnx_reason:
      skinMaskResult && Object.prototype.hasOwnProperty.call(skinMaskResult, 'onnx_reason')
        ? skinMaskResult.onnx_reason
        : null,
  };

  return {
    ok: true,
    payload,
    module_rows: moduleRows,
    quality_grade: qualityGrade,
    reason: null,
  };
}

function moduleSummary(moduleRows, payload, templateMatchEps = DEFAULTS.template_match_eps) {
  const rows = Array.isArray(moduleRows) ? moduleRows : [];
  const pixels = rows.map((row) => Number(row.module_pixels || 0)).filter((value) => Number.isFinite(value));
  const modulePixelsMap = {};
  for (const row of rows) modulePixelsMap[row.module_id] = Math.max(0, Math.trunc(Number(row.module_pixels || 0)));
  const moduleRowsMap = new Map(rows.map((row) => [String(row.module_id || '').trim(), row]));
  const internalDebug = payload && payload.internal_debug && typeof payload.internal_debug === 'object'
    ? payload.internal_debug
    : {};
  const guardTriggered = Boolean(
    internalDebug.module_guard_triggered,
  );
  const guardedModules = Array.isArray(internalDebug.guarded_modules)
    ? internalDebug.guarded_modules.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const moduleBoxMode = String(internalDebug.module_box_mode || '').trim() || 'unknown';
  const dynamicApplied = Boolean(internalDebug.module_box_dynamic_applied);
  const dynamicReason = internalDebug.module_box_dynamic_reason == null
    ? null
    : String(internalDebug.module_box_dynamic_reason);
  const dynamicScore = Number.isFinite(Number(internalDebug.module_box_dynamic_score))
    ? Math.max(0, Math.min(1, Number(internalDebug.module_box_dynamic_score)))
    : null;
  const overlapScore = Number.isFinite(Number(internalDebug.module_box_overlap_score))
    ? Math.max(0, Math.min(1, Number(internalDebug.module_box_overlap_score)))
    : null;
  const positiveRatio = Number.isFinite(Number(internalDebug.module_box_positive_ratio))
    ? Math.max(0, Math.min(1, Number(internalDebug.module_box_positive_ratio)))
    : null;
  const anchors = internalDebug.module_box_anchors && typeof internalDebug.module_box_anchors === 'object'
    ? internalDebug.module_box_anchors
    : null;
  const yawRaw = anchors && Number.isFinite(Number(anchors.yaw_est))
    ? Number(anchors.yaw_est)
    : null;
  const yawEst = yawRaw == null ? null : Math.max(-1, Math.min(1, yawRaw));
  const skinmaskSource = internalDebug.skinmask_source == null ? null : String(internalDebug.skinmask_source);
  const skinmaskOnnxOk = Boolean(internalDebug.skinmask_onnx_ok);
  const skinmaskOnnxReason = internalDebug.skinmask_onnx_reason == null ? null : String(internalDebug.skinmask_onnx_reason);
  const faceOvalMaskSource = internalDebug.face_oval_mask_source == null ? null : String(internalDebug.face_oval_mask_source);
  const boxPlausibility = computeModuleBoxPlausibility(moduleRowsMap);

  const templateRows = STRONG_MODULES
    .map((moduleId) => {
      const row = moduleRowsMap.get(moduleId);
      const box = normalizeBox(row && row.box);
      const tpl = normalizeBox(MODULE_TEMPLATE_BOXES[moduleId]);
      if (!box || !tpl) return null;
      const coordDiff = (
        Math.abs(box.x - tpl.x)
        + Math.abs(box.y - tpl.y)
        + Math.abs(box.w - tpl.w)
        + Math.abs(box.h - tpl.h)
      ) / 4;
      return {
        module_id: moduleId,
        coord_diff: coordDiff,
      };
    })
    .filter(Boolean);
  const templateMeanDiff = templateRows.length
    ? templateRows.reduce((sum, row) => sum + row.coord_diff, 0) / templateRows.length
    : null;
  const templateMaxDiff = templateRows.length
    ? Math.max(...templateRows.map((row) => row.coord_diff))
    : null;
  const eps = Math.max(0, Math.min(0.05, Number(templateMatchEps) || DEFAULTS.template_match_eps));
  const templateLike = templateRows.length >= 4
    && templateRows.every((row) => row.coord_diff <= eps);

  const strongPresent = STRONG_MODULES.filter((moduleId) => moduleRowsMap.has(moduleId)).length;
  const strongCoverage = strongPresent / STRONG_MODULES.length;
  const minPixelsScore = Math.max(0, Math.min(1, (pixels.length ? Math.min(...pixels) : 0) / 256));
  const dynamicGateScore = dynamicApplied ? 1 : 0;
  const templateGateScore = templateLike ? 0 : 1;
  const geometryQcScore = round3(
    (dynamicGateScore * 0.5)
    + (templateGateScore * 0.3)
    + (strongCoverage * 0.1)
    + (minPixelsScore * 0.1),
  );
  return {
    modules_count: rows.length,
    module_pixels_min: pixels.length ? Math.min(...pixels) : 0,
    module_pixels_map: modulePixelsMap,
    module_guard_triggered: guardTriggered || guardedModules.length > 0,
    guarded_modules: guardedModules,
    module_box_mode: moduleBoxMode,
    module_box_dynamic_applied: dynamicApplied,
    module_box_dynamic_reason: dynamicReason,
    module_box_dynamic_score: dynamicScore,
    module_box_overlap_score: overlapScore,
    module_box_positive_ratio: positiveRatio,
    module_box_yaw_est: yawEst,
    skinmask_source: skinmaskSource,
    skinmask_onnx_ok: skinmaskOnnxOk,
    skinmask_onnx_reason: skinmaskOnnxReason,
    face_oval_mask_source: faceOvalMaskSource,
    module_box_plausibility_score: boxPlausibility.score,
    module_box_plausibility_violations: boxPlausibility.violations,
    module_box_template_like: templateLike,
    module_box_template_mean_diff: templateMeanDiff == null ? null : round3(templateMeanDiff),
    module_box_template_max_diff: templateMaxDiff == null ? null : round3(templateMaxDiff),
    geometry_qc_score: geometryQcScore,
  };
}

function boxCenterX(box) {
  return Number(box.x) + (Number(box.w) * 0.5);
}

function boxCenterY(box) {
  return Number(box.y) + (Number(box.h) * 0.5);
}

function isBoxValid(box) {
  return Boolean(box)
    && Number.isFinite(Number(box.x))
    && Number.isFinite(Number(box.y))
    && Number.isFinite(Number(box.w))
    && Number.isFinite(Number(box.h))
    && Number(box.w) > 0.001
    && Number(box.h) > 0.001;
}

function computeModuleBoxPlausibility(moduleRowsMap) {
  const get = (moduleId) => {
    const row = moduleRowsMap && typeof moduleRowsMap.get === 'function' ? moduleRowsMap.get(moduleId) : null;
    const box = normalizeBox(row && row.box);
    return isBoxValid(box) ? box : null;
  };
  const forehead = get('forehead');
  const nose = get('nose');
  const leftCheek = get('left_cheek');
  const rightCheek = get('right_cheek');
  const chin = get('chin');
  const underEyeLeft = get('under_eye_left');
  const underEyeRight = get('under_eye_right');

  const required = [forehead, nose, leftCheek, rightCheek, chin];
  if (required.some((box) => !box)) {
    return {
      score: 0,
      violations: ['missing_strong_module_box'],
    };
  }

  const faceTop = Math.min(forehead.y, leftCheek.y, rightCheek.y);
  const faceBottom = Math.max(
    chin.y + chin.h,
    leftCheek.y + leftCheek.h,
    rightCheek.y + rightCheek.h,
    nose.y + nose.h,
  );
  const faceLeft = Math.min(leftCheek.x, forehead.x, nose.x);
  const faceRight = Math.max(rightCheek.x + rightCheek.w, forehead.x + forehead.w, nose.x + nose.w);
  const faceH = Math.max(0.12, faceBottom - faceTop);
  const faceW = Math.max(0.12, faceRight - faceLeft);
  const centerX = (faceLeft + faceRight) * 0.5;

  const violations = [];
  const weights = [];
  const addCheck = (ok, key, weight = 1) => {
    weights.push(weight);
    if (!ok) violations.push(key);
  };

  const foreheadBottom = forehead.y + forehead.h;
  const noseTop = nose.y;
  const noseBottom = nose.y + nose.h;
  const chinTop = chin.y;
  const leftCheekCenterX = boxCenterX(leftCheek);
  const rightCheekCenterX = boxCenterX(rightCheek);
  const noseCenterX = boxCenterX(nose);
  const underEyeCenterY = (() => {
    const vals = [];
    if (underEyeLeft) vals.push(boxCenterY(underEyeLeft));
    if (underEyeRight) vals.push(boxCenterY(underEyeRight));
    if (!vals.length) return null;
    return vals.reduce((sum, n) => sum + n, 0) / vals.length;
  })();

  addCheck(foreheadBottom <= noseTop + (0.05 * faceH), 'forehead_not_above_nose', 1.2);
  addCheck(noseBottom <= chinTop + (0.06 * faceH), 'nose_not_above_chin', 1.2);
  addCheck(leftCheekCenterX <= noseCenterX - (0.06 * faceW), 'left_cheek_not_left_of_nose', 1);
  addCheck(rightCheekCenterX >= noseCenterX + (0.06 * faceW), 'right_cheek_not_right_of_nose', 1);
  addCheck(Math.abs(noseCenterX - centerX) <= (0.14 * faceW), 'nose_not_centered', 0.8);
  addCheck(noseTop >= faceTop + (0.33 * faceH), 'nose_too_high', 1);
  addCheck(noseTop <= faceTop + (0.62 * faceH), 'nose_too_low', 0.6);
  addCheck(leftCheek.y >= faceTop + (0.36 * faceH), 'left_cheek_too_high', 0.8);
  addCheck(rightCheek.y >= faceTop + (0.36 * faceH), 'right_cheek_too_high', 0.8);
  addCheck(chinTop >= faceTop + (0.62 * faceH), 'chin_too_high', 0.8);
  addCheck(chinTop <= faceTop + (0.9 * faceH), 'chin_too_low', 0.4);
  if (underEyeCenterY != null) {
    addCheck(underEyeCenterY <= noseTop + (0.08 * faceH), 'under_eye_not_above_nose', 0.6);
  }

  const total = weights.reduce((sum, n) => sum + n, 0);
  const failed = violations.reduce((sum, key) => {
    const idx = [
      'forehead_not_above_nose',
      'nose_not_above_chin',
      'left_cheek_not_left_of_nose',
      'right_cheek_not_right_of_nose',
      'nose_not_centered',
      'nose_too_high',
      'nose_too_low',
      'left_cheek_too_high',
      'right_cheek_too_high',
      'chin_too_high',
      'chin_too_low',
      'under_eye_not_above_nose',
    ].indexOf(key);
    if (idx < 0) return sum + 1;
    return sum + weights[idx];
  }, 0);
  const score = round3(Math.max(0, Math.min(1, 1 - (failed / Math.max(1e-6, total)))));
  return {
    score,
    violations,
  };
}

function strongModuleCount(summary) {
  const map = summary && summary.module_pixels_map && typeof summary.module_pixels_map === 'object'
    ? summary.module_pixels_map
    : {};
  return STRONG_MODULES.filter((moduleId) => Number.isFinite(Number(map[moduleId]))).length;
}

function strongMaskRleRatio(moduleRows) {
  const rows = Array.isArray(moduleRows) ? moduleRows : [];
  if (!rows.length) return 0;
  const byModule = new Map();
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const moduleId = String(row.module_id || '').trim();
    if (!moduleId) return;
    byModule.set(moduleId, row);
  });
  const total = STRONG_MODULES.length;
  let withMask = 0;
  STRONG_MODULES.forEach((moduleId) => {
    const row = byModule.get(moduleId);
    if (!row) return;
    const mask = row.mask_rle_norm;
    if (typeof mask === 'string' && mask.trim()) withMask += 1;
  });
  return withMask / total;
}

function strongFaceSpanStats(moduleRowsMap) {
  const boxes = STRONG_MODULES
    .map((moduleId) => {
      const row = moduleRowsMap && typeof moduleRowsMap.get === 'function' ? moduleRowsMap.get(moduleId) : null;
      return normalizeBox(row && row.box);
    })
    .filter(Boolean);
  if (boxes.length < STRONG_MODULES.length) {
    return {
      ok: false,
      span_w: 0,
      span_h: 0,
      span_area: 0,
    };
  }
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const box of boxes) {
    x0 = Math.min(x0, Number(box.x));
    y0 = Math.min(y0, Number(box.y));
    x1 = Math.max(x1, Number(box.x) + Number(box.w));
    y1 = Math.max(y1, Number(box.y) + Number(box.h));
  }
  const spanW = Math.max(0, x1 - x0);
  const spanH = Math.max(0, y1 - y0);
  return {
    ok: true,
    span_w: round3(spanW),
    span_h: round3(spanH),
    span_area: round3(spanW * spanH),
  };
}

function hardFilterGateReasons({
  args,
  baselineSummary,
  variantSummary,
  baselineModuleRows,
  variantModuleRows,
}) {
  if (!args.hard_filter_gate) return [];
  const reasons = [];
  const baselineQuality = String(baselineSummary && baselineSummary.quality_grade || '').trim().toLowerCase();
  const variantQuality = String(variantSummary && variantSummary.quality_grade || '').trim().toLowerCase();
  if (args.hard_filter_require_quality_pass) {
    if (baselineQuality !== 'pass' || variantQuality !== 'pass') {
      reasons.push(`hard_filter_quality_not_pass:${baselineQuality || 'unknown'}|${variantQuality || 'unknown'}`);
    }
  }

  const baselineGuarded = Array.isArray(baselineSummary && baselineSummary.guarded_modules)
    ? baselineSummary.guarded_modules.length
    : 0;
  const variantGuarded = Array.isArray(variantSummary && variantSummary.guarded_modules)
    ? variantSummary.guarded_modules.length
    : 0;
  if (
    baselineGuarded > args.hard_filter_max_guarded_modules
    || variantGuarded > args.hard_filter_max_guarded_modules
  ) {
    reasons.push(
      `hard_filter_guarded_modules:${baselineGuarded}|${variantGuarded}>${args.hard_filter_max_guarded_modules}`,
    );
  }

  const baselineMinPixels = Number.isFinite(Number(baselineSummary && baselineSummary.module_pixels_min))
    ? Number(baselineSummary.module_pixels_min)
    : 0;
  const variantMinPixels = Number.isFinite(Number(variantSummary && variantSummary.module_pixels_min))
    ? Number(variantSummary.module_pixels_min)
    : 0;
  if (Math.min(baselineMinPixels, variantMinPixels) < args.hard_filter_min_module_pixels) {
    reasons.push(
      `hard_filter_module_pixels_min:${round3(Math.min(baselineMinPixels, variantMinPixels))}<${round3(args.hard_filter_min_module_pixels)}`,
    );
  }

  const baselineDynScore = Number.isFinite(Number(baselineSummary && baselineSummary.module_box_dynamic_score))
    ? Number(baselineSummary.module_box_dynamic_score)
    : 0;
  const variantDynScore = Number.isFinite(Number(variantSummary && variantSummary.module_box_dynamic_score))
    ? Number(variantSummary.module_box_dynamic_score)
    : 0;
  if (Math.min(baselineDynScore, variantDynScore) < args.hard_filter_min_dynamic_score) {
    reasons.push(
      `hard_filter_dynamic_score:${round3(Math.min(baselineDynScore, variantDynScore))}<${round3(args.hard_filter_min_dynamic_score)}`,
    );
  }
  const baselineBoxPlausibility = Number.isFinite(Number(baselineSummary && baselineSummary.module_box_plausibility_score))
    ? Number(baselineSummary.module_box_plausibility_score)
    : 0;
  const variantBoxPlausibility = Number.isFinite(Number(variantSummary && variantSummary.module_box_plausibility_score))
    ? Number(variantSummary.module_box_plausibility_score)
    : 0;
  const minBoxPlausibility = Math.min(baselineBoxPlausibility, variantBoxPlausibility);
  if (minBoxPlausibility < args.hard_filter_min_box_plausibility) {
    reasons.push(
      `hard_filter_box_plausibility:${round3(minBoxPlausibility)}<${round3(args.hard_filter_min_box_plausibility)}`,
    );
  }
  if (args.hard_filter_min_mask_rle_ratio > 0) {
    const baselineMaskRatio = strongMaskRleRatio(baselineModuleRows);
    const variantMaskRatio = strongMaskRleRatio(variantModuleRows);
    const minMaskRatio = Math.min(baselineMaskRatio, variantMaskRatio);
    if (minMaskRatio < args.hard_filter_min_mask_rle_ratio) {
      reasons.push(
        `hard_filter_mask_rle_ratio:${round3(minMaskRatio)}<${round3(args.hard_filter_min_mask_rle_ratio)}`,
      );
    }
  }
  const baselineRowsMap = moduleRowsToMap(Array.isArray(baselineModuleRows) ? baselineModuleRows : []);
  const variantRowsMap = moduleRowsToMap(Array.isArray(variantModuleRows) ? variantModuleRows : []);
  const baselineFaceSpan = strongFaceSpanStats(baselineRowsMap);
  const variantFaceSpan = strongFaceSpanStats(variantRowsMap);
  if (args.hard_filter_min_face_span_h > 0) {
    const minSpanH = Math.min(
      Number(baselineFaceSpan.span_h || 0),
      Number(variantFaceSpan.span_h || 0),
    );
    if (minSpanH < args.hard_filter_min_face_span_h) {
      reasons.push(
        `hard_filter_face_span_h:${round3(minSpanH)}<${round3(args.hard_filter_min_face_span_h)}`,
      );
    }
  }
  if (args.hard_filter_min_face_span_w > 0) {
    const minSpanW = Math.min(
      Number(baselineFaceSpan.span_w || 0),
      Number(variantFaceSpan.span_w || 0),
    );
    if (minSpanW < args.hard_filter_min_face_span_w) {
      reasons.push(
        `hard_filter_face_span_w:${round3(minSpanW)}<${round3(args.hard_filter_min_face_span_w)}`,
      );
    }
  }
  if (args.hard_filter_min_face_span_area > 0) {
    const minSpanArea = Math.min(
      Number(baselineFaceSpan.span_area || 0),
      Number(variantFaceSpan.span_area || 0),
    );
    if (minSpanArea < args.hard_filter_min_face_span_area) {
      reasons.push(
        `hard_filter_face_span_area:${round3(minSpanArea)}<${round3(args.hard_filter_min_face_span_area)}`,
      );
    }
  }
  if (args.hard_filter_require_onnx_skinmask) {
    const baselineSource = String(baselineSummary && baselineSummary.skinmask_source || '');
    const variantSource = String(variantSummary && variantSummary.skinmask_source || '');
    if (baselineSource !== 'onnx_rle' || variantSource !== 'onnx_rle') {
      reasons.push(`hard_filter_skinmask_source:${baselineSource || 'none'}|${variantSource || 'none'}`);
    }
  }
  if (args.hard_filter_min_overlap_score > 0) {
    const baselineOverlap = Number.isFinite(Number(baselineSummary && baselineSummary.module_box_overlap_score))
      ? Number(baselineSummary.module_box_overlap_score)
      : 0;
    const variantOverlap = Number.isFinite(Number(variantSummary && variantSummary.module_box_overlap_score))
      ? Number(variantSummary.module_box_overlap_score)
      : 0;
    const minOverlap = Math.min(baselineOverlap, variantOverlap);
    if (minOverlap < args.hard_filter_min_overlap_score) {
      reasons.push(
        `hard_filter_overlap_score:${round3(minOverlap)}<${round3(args.hard_filter_min_overlap_score)}`,
      );
    }
  }
  if (args.hard_filter_max_abs_yaw < 1) {
    const baselineYaw = Number.isFinite(Number(baselineSummary && baselineSummary.module_box_yaw_est))
      ? Math.abs(Number(baselineSummary.module_box_yaw_est))
      : 1;
    const variantYaw = Number.isFinite(Number(variantSummary && variantSummary.module_box_yaw_est))
      ? Math.abs(Number(variantSummary.module_box_yaw_est))
      : 1;
    const maxYaw = Math.max(baselineYaw, variantYaw);
    if (maxYaw > args.hard_filter_max_abs_yaw) {
      reasons.push(`hard_filter_abs_yaw:${round3(maxYaw)}>${round3(args.hard_filter_max_abs_yaw)}`);
    }
  }

  if (args.hard_filter_require_all_strong_modules) {
    const baselineStrong = strongModuleCount(baselineSummary);
    const variantStrong = strongModuleCount(variantSummary);
    if (baselineStrong < STRONG_MODULES.length || variantStrong < STRONG_MODULES.length) {
      reasons.push(`hard_filter_strong_modules_missing:${baselineStrong}|${variantStrong}<${STRONG_MODULES.length}`);
    }
  }

  return reasons;
}

function inferABRoles(seed, sampleHash) {
  const token = sha256Hex(`${seed}:ab:${sampleHash}`);
  const swap = parseInt(token.slice(0, 2), 16) % 2 === 1;
  return swap
    ? { role_a: 'variant', role_b: 'baseline' }
    : { role_a: 'baseline', role_b: 'variant' };
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveFaceCropBox(faceCrop, width, height) {
  const bbox = faceCrop && typeof faceCrop === 'object' && faceCrop.bbox_px && typeof faceCrop.bbox_px === 'object'
    ? faceCrop.bbox_px
    : null;
  if (!bbox) return null;
  const x = Math.max(0, Math.floor(Number(bbox.x) || 0));
  const y = Math.max(0, Math.floor(Number(bbox.y) || 0));
  const w = Math.max(0, Math.floor(Number(bbox.w) || 0));
  const h = Math.max(0, Math.floor(Number(bbox.h) || 0));
  if (w <= 1 || h <= 1) return null;
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  const nx = Math.max(0, Math.min(width - 1, x));
  const ny = Math.max(0, Math.min(height - 1, y));
  const nw = Math.max(1, x1 - nx);
  const nh = Math.max(1, y1 - ny);
  if (nw <= 1 || nh <= 1) return null;
  return { left: nx, top: ny, width: nw, height: nh };
}

function buildOverlaySvg({ width, height, role, label, variantId, moduleRows }) {
  const faceOval = FACE_OVAL_POLYGON
    .map((point) => `${round3(point.x * width)},${round3(point.y * height)}`)
    .join(' ');

  const moduleRects = [];
  const legendRows = [];
  const orderedModules = ALL_MODULES.filter((moduleId) => moduleRows.some((row) => row.module_id === moduleId));
  let legendX = 12;
  const legendY = Math.max(8, height - 22);
  for (const moduleId of orderedModules) {
    const row = moduleRows.find((item) => item.module_id === moduleId);
    const color = MODULE_COLORS[moduleId] || '#FFFFFF';
    if (row && row.box) {
      const x = round3(row.box.x * width);
      const y = round3(row.box.y * height);
      const w = Math.max(1, round3(row.box.w * width));
      const h = Math.max(1, round3(row.box.h * height));
      moduleRects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2"/>`);
      moduleRects.push(`<text x="${Math.max(2, x + 2)}" y="${Math.max(10, y + 12)}" fill="${color}" font-size="11" font-family="Menlo, monospace">${escapeXml(moduleId)}</text>`);
    }
    legendRows.push(`<rect x="${legendX}" y="${legendY}" width="10" height="10" fill="${color}" />`);
    legendRows.push(`<text x="${legendX + 14}" y="${legendY + 10}" fill="#FFFFFF" font-size="10" font-family="Menlo, monospace">${escapeXml(moduleId)}</text>`);
    legendX += 14 + (moduleId.length * 6) + 8;
  }

  const topBarHeight = 30;
  const title = `${label} (${role}) · ${variantId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${topBarHeight}" fill="rgba(0,0,0,0.6)"/>
  <text x="10" y="20" fill="#FFFFFF" font-size="12" font-family="Menlo, monospace">${escapeXml(title)}</text>
  <polygon points="${faceOval}" fill="none" stroke="${MODULE_COLORS.face_oval}" stroke-width="2" stroke-dasharray="6,4"/>
  ${moduleRects.join('\n  ')}
  <rect x="0" y="${Math.max(0, height - 26)}" width="${width}" height="26" fill="rgba(0,0,0,0.55)"/>
  ${legendRows.join('\n  ')}
</svg>`;
}

async function renderOverlay({ imageBuffer, payload, moduleRows, role, label, variantId, outPath, maxEdge }) {
  let work = sharp(imageBuffer, { failOn: 'none' }).rotate();
  // Keep full-image coordinates so overlay boxes (normalized on source image)
  // stay aligned with rendered pixels.
  if (maxEdge > 0) {
    work = work.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: false });
  }
  const basePng = await work.png().toBuffer();
  const meta = await sharp(basePng, { failOn: 'none' }).metadata();
  const width = Math.max(1, Math.trunc(Number(meta.width) || 1));
  const height = Math.max(1, Math.trunc(Number(meta.height) || 1));
  const svg = buildOverlaySvg({
    width,
    height,
    role,
    label,
    variantId,
    moduleRows,
  });

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(basePng, { failOn: 'none' })
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function resolveSampleImagePath(row, args) {
  const directPath = String(row.image_path_abs || '').trim();
  if (directPath && fs.existsSync(directPath)) return path.resolve(directPath);

  const relPath = String(row.image_path_rel || '').trim();
  if (relPath && path.isAbsolute(relPath) && fs.existsSync(relPath)) return path.resolve(relPath);

  const resolved = await resolvePackImage({
    source: row.source,
    imagePathRel: relPath,
    internalDir: args.internal_dir,
    cacheDir: args.cache_dir,
  });
  if (resolved && fs.existsSync(resolved)) return path.resolve(resolved);
  return null;
}

async function runPool(items, concurrency, worker) {
  if (!items.length) return [];
  const out = new Array(items.length);
  let cursor = 0;
  async function loop() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => loop());
  await Promise.all(runners);
  return out;
}

function normalizeTaskRow({
  runId,
  baselineId,
  variantId,
  row,
  rank,
  roleA,
  roleB,
  imageAPath,
  imageBPath,
  baselineSummary,
  variantSummary,
  labelStudioDocumentRoot,
}) {
  const taskId = `pref_${row.source}_${row.sample_hash}`;
  const shared = {
    run_id: runId,
    source: row.source,
    sample_hash: row.sample_hash,
    baseline_id: baselineId,
    variant_id: variantId,
    role_a: roleA,
    role_b: roleB,
    image_path_rel: row.image_path_rel || '',
    risk_score: round3(row.risk_score),
    min_module_pixels: row.min_module_pixels,
    leakage_bg_est_mean: row.leakage_bg_est_mean == null ? null : round3(row.leakage_bg_est_mean),
    hair_overlap_est: row.hair_overlap_est == null ? null : round3(row.hair_overlap_est),
    module_guard_triggered: Boolean(row.module_guard_triggered),
    guarded_modules: Array.isArray(row.guarded_modules) ? row.guarded_modules : [],
    baseline_summary: baselineSummary,
    variant_summary: variantSummary,
    adjudication: false,
  };

  const task = {
    id: taskId,
    data: {
      image_a: toLabelStudioLocalFilesUrl(imageAPath, { documentRoot: labelStudioDocumentRoot }),
      image_b: toLabelStudioLocalFilesUrl(imageBPath, { documentRoot: labelStudioDocumentRoot }),
      image_a_path: imageAPath,
      image_b_path: imageBPath,
      source: row.source,
      sample_hash: row.sample_hash,
      baseline_id: baselineId,
      variant_id: variantId,
      role_a: roleA,
      role_b: roleB,
      rank,
      adjudication: false,
    },
    meta: shared,
    metadata: shared,
  };

  const manifestRow = {
    ...shared,
    task_id: taskId,
    rank,
    image_a_path: imageAPath,
    image_b_path: imageBPath,
  };

  return { task, manifestRow };
}

function sanitizeModuleRowsForManifest(moduleRows) {
  if (!Array.isArray(moduleRows)) return [];
  return moduleRows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const moduleId = String(row.module_id || '').trim();
      if (!moduleId) return null;
      const box = normalizeBox(row.box);
      const maskGrid = Math.max(16, Math.min(512, Math.trunc(Number(row.mask_grid) || 64)));
      const modulePixels = Math.max(0, Math.trunc(Number(row.module_pixels) || 0));
      const maskRle = typeof row.mask_rle_norm === 'string' ? row.mask_rle_norm : null;
      return {
        module_id: moduleId,
        box,
        mask_grid: maskGrid,
        module_pixels: modulePixels,
        mask_rle_norm: maskRle,
      };
    })
    .filter(Boolean);
}

function renderPreview({ runId, reviewIn, outRoot, baselineId, variantId, selectedRows, excludedRows }) {
  const lines = [];
  lines.push('# Preference Round1 Pack Preview');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- review_in: \`${reviewIn}\``);
  lines.push(`- out_root: \`${outRoot}\``);
  lines.push(`- baseline_id: ${baselineId}`);
  lines.push(`- variant_id: ${variantId}`);
  lines.push(`- selected: ${selectedRows.length}`);
  lines.push(`- excluded: ${excludedRows.length}`);
  lines.push('');
  lines.push('## Selected Samples');
  lines.push('');
  lines.push('| rank | source | sample_hash | role_a | role_b | risk_score | min_module_pixels | leakage_bg_est_mean | hair_overlap_est | image_a_path | image_b_path |');
  lines.push('|---:|---|---|---|---|---:|---:|---:|---:|---|---|');
  selectedRows.forEach((row, idx) => {
    lines.push(
      `| ${idx + 1} | ${row.source} | ${row.sample_hash} | ${row.role_a} | ${row.role_b} | ${row.risk_score ?? '-'} | ${row.min_module_pixels ?? '-'} | ${row.leakage_bg_est_mean ?? '-'} | ${row.hair_overlap_est ?? '-'} | ${toPosix(row.image_a_path)} | ${toPosix(row.image_b_path)} |`,
    );
  });
  if (!selectedRows.length) lines.push('| 1 | - | - | - | - | - | - | - | - | - | - |');

  lines.push('');
  lines.push('## Excluded Samples');
  lines.push('');
  lines.push('| source | sample_hash | reason |');
  lines.push('|---|---|---|');
  if (!excludedRows.length) {
    lines.push('| - | - | - |');
  } else {
    excludedRows.forEach((row) => {
      lines.push(`| ${row.source || '-'} | ${row.sample_hash || '-'} | ${row.reason || '-'} |`);
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
  if (!args.review_in) {
    process.stderr.write('preference_round1_pack: missing --review_in\n');
    process.exit(2);
    return;
  }

  const variant = parseVariant(args);
  const runId = inferRunId(args);
  const reviewPath = path.resolve(args.review_in);
  const outRoot = path.resolve(args.out || path.join('artifacts', `preference_round1_${runId}`));
  const imagesDir = path.join(outRoot, DEFAULTS.images_subdir);
  const convertedDir = path.join(outRoot, DEFAULTS.converted_subdir);

  await fsp.mkdir(imagesDir, { recursive: true });
  await fsp.mkdir(convertedDir, { recursive: true });

  const rawRows = await readReviewRows(reviewPath);
  const normalized = rawRows.map(normalizeReviewRow).filter(Boolean);
  const candidates = normalized.filter(isCandidate);
  const selection = selectRows(candidates, args);

  const buildPhotoModulesCardBaseline = loadBuildPhotoModulesCardWithEnv(
    buildPipelineEnvOverrides(args, {}),
  );
  const buildPhotoModulesCardVariant = loadBuildPhotoModulesCardWithEnv(
    buildPipelineEnvOverrides(args, variant.env_overrides),
  );

  const outcomes = await runPool(selection.selected, args.concurrency, async (row) => {
    const absPath = await resolveSampleImagePath(row, args);
    if (!absPath) {
      return {
        ok: false,
        excluded: { source: row.source, sample_hash: row.sample_hash, reason: 'image_not_found' },
      };
    }

    const convertedPath = path.join(convertedDir, `${row.sample_hash}.jpg`);
    try {
      await transcodeToPackJpeg({ inputPath: absPath, outputPath: convertedPath });
    } catch (error) {
      return {
        ok: false,
        excluded: {
          source: row.source,
          sample_hash: row.sample_hash,
          reason: `decode_fail:${String(error && error.error_code ? error.error_code : error && error.message ? error.message : error)}`,
        },
      };
    }

    const imageBuffer = await fsp.readFile(convertedPath);

    const baselineResult = await runLocalPipeline({
      imageBuffer,
      sampleHash: row.sample_hash,
      lang: 'en',
      args,
      buildPhotoModulesCard: buildPhotoModulesCardBaseline,
      postprocess: (moduleRows) => moduleRows,
      mockMode: args.mock_pipeline,
      variantKind: 'baseline',
    });

    const variantResult = await runLocalPipeline({
      imageBuffer,
      sampleHash: row.sample_hash,
      lang: 'en',
      args,
      buildPhotoModulesCard: buildPhotoModulesCardVariant,
      postprocess: variant.applyPostprocess,
      mockMode: args.mock_pipeline,
      variantKind: variant.variant_kind,
    });

    if (!baselineResult.ok && !variantResult.ok) {
      return {
        ok: false,
        excluded: {
          source: row.source,
          sample_hash: row.sample_hash,
          reason: `both_variants_failed:${baselineResult.reason || '-'}|${variantResult.reason || '-'}`,
        },
      };
    }

    const baselineSummary = {
      ...moduleSummary(baselineResult.module_rows, baselineResult.payload, args.template_match_eps),
      quality_grade: baselineResult.quality_grade,
      reason: baselineResult.reason,
      ok: baselineResult.ok,
    };
    const variantSummary = {
      ...moduleSummary(variantResult.module_rows, variantResult.payload, args.template_match_eps),
      quality_grade: variantResult.quality_grade,
      reason: variantResult.reason,
      ok: variantResult.ok,
    };

    const exclusionReasons = [];
    if (args.require_dynamic_boxes) {
      const dynamicOk = baselineSummary.module_box_dynamic_applied && variantSummary.module_box_dynamic_applied;
      if (!dynamicOk) exclusionReasons.push('module_box_dynamic_not_applied');
    }
    if (args.exclude_template_like) {
      if (baselineSummary.module_box_template_like || variantSummary.module_box_template_like) {
        exclusionReasons.push('module_box_template_like');
      }
    }
    const geometryScore = Math.min(
      Number.isFinite(Number(baselineSummary.geometry_qc_score)) ? Number(baselineSummary.geometry_qc_score) : 0,
      Number.isFinite(Number(variantSummary.geometry_qc_score)) ? Number(variantSummary.geometry_qc_score) : 0,
    );
    if (args.min_geometry_qc_score > 0 && geometryScore < args.min_geometry_qc_score) {
      exclusionReasons.push(`geometry_qc_low:${round3(geometryScore)}<${round3(args.min_geometry_qc_score)}`);
    }
    exclusionReasons.push(
      ...hardFilterGateReasons({
        args,
        baselineSummary,
        variantSummary,
        baselineModuleRows: baselineResult.module_rows,
        variantModuleRows: variantResult.module_rows,
      }),
    );
    if (exclusionReasons.length) {
      return {
        ok: false,
        excluded: {
          source: row.source,
          sample_hash: row.sample_hash,
          reason: exclusionReasons.join('|'),
        },
      };
    }

    const roles = inferABRoles(args.seed, row.sample_hash);
    const roleAResult = roles.role_a === 'baseline' ? baselineResult : variantResult;
    const roleBResult = roles.role_b === 'baseline' ? baselineResult : variantResult;

    const imageAPath = path.resolve(imagesDir, `${row.sample_hash}_A.png`);
    const imageBPath = path.resolve(imagesDir, `${row.sample_hash}_B.png`);

    await renderOverlay({
      imageBuffer,
      payload: roleAResult.payload || { modules: [] },
      moduleRows: roleAResult.module_rows || [],
      role: roles.role_a,
      label: 'A',
      variantId: roles.role_a === 'baseline' ? variant.baseline_id : variant.variant_id,
      outPath: imageAPath,
      maxEdge: args.max_edge,
    });

    await renderOverlay({
      imageBuffer,
      payload: roleBResult.payload || { modules: [] },
      moduleRows: roleBResult.module_rows || [],
      role: roles.role_b,
      label: 'B',
      variantId: roles.role_b === 'baseline' ? variant.baseline_id : variant.variant_id,
      outPath: imageBPath,
      maxEdge: args.max_edge,
    });

    return {
      ok: true,
      item: {
        row,
        role_a: roles.role_a,
        role_b: roles.role_b,
        image_a_path: imageAPath,
        image_b_path: imageBPath,
        baseline_summary: {
          ...baselineSummary,
        },
        baseline_module_rows: baselineResult.module_rows || [],
        variant_summary: {
          ...variantSummary,
        },
        variant_module_rows: variantResult.module_rows || [],
      },
    };
  });

  const kept = [];
  const excluded = [];
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== 'object') continue;
    if (outcome.ok && outcome.item) {
      kept.push(outcome.item);
      continue;
    }
    if (outcome.excluded) excluded.push(outcome.excluded);
  }
  const tasks = [];
  const manifestRows = [];
  const labelStudioDocumentRoot = path.resolve(
    String(process.env.LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT || outRoot),
  );
  for (let i = 0; i < kept.length; i += 1) {
    const item = kept[i];
    const normalizedRow = normalizeTaskRow({
      runId,
      baselineId: variant.baseline_id,
      variantId: variant.variant_id,
      row: item.row,
      rank: i + 1,
      roleA: item.role_a,
      roleB: item.role_b,
      imageAPath: item.image_a_path,
      imageBPath: item.image_b_path,
      baselineSummary: item.baseline_summary,
      variantSummary: item.variant_summary,
      labelStudioDocumentRoot,
    });
    normalizedRow.manifestRow.baseline_module_rows = sanitizeModuleRowsForManifest(item.baseline_module_rows);
    normalizedRow.manifestRow.variant_module_rows = sanitizeModuleRowsForManifest(item.variant_module_rows);
    tasks.push(normalizedRow.task);
    manifestRows.push(normalizedRow.manifestRow);
  }

  const tasksPath = path.join(outRoot, 'tasks.json');
  const manifestPath = path.join(outRoot, 'manifest.json');
  const previewPath = path.join(outRoot, 'preview.md');

  await fsp.writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  await fsp.writeFile(manifestPath, `${JSON.stringify({
    run_id: runId,
    generated_at: new Date().toISOString(),
    review_in: toPosix(path.relative(process.cwd(), reviewPath)),
    seed: args.seed,
    baseline_id: variant.baseline_id,
    variant_id: variant.variant_id,
    variant_kind: variant.variant_kind,
    variant_description: variant.description,
    module_box_mode: args.module_box_mode,
    qc_filters: {
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
    },
    selection: {
      limit_internal: args.limit_internal,
      limit_lapa: args.limit_lapa,
      limit_celeba: args.limit_celeba,
      pool_internal: selection.pools.internal,
      pool_lapa: selection.pools.lapa,
      pool_celeba: selection.pools.celebamaskhq,
      selected_internal: selection.counts.internal,
      selected_lapa: selection.counts.lapa,
      selected_celeba: selection.counts.celebamaskhq,
      selected_total: manifestRows.length,
      excluded_total: excluded.length,
    },
    artifacts: {
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
      images_dir: toPosix(path.relative(process.cwd(), imagesDir)),
    },
    rows: manifestRows,
    excluded,
  }, null, 2)}\n`, 'utf8');
  await fsp.writeFile(previewPath, renderPreview({
    runId,
    reviewIn: toPosix(path.relative(process.cwd(), reviewPath)),
    outRoot: toPosix(path.relative(process.cwd(), outRoot)),
    baselineId: variant.baseline_id,
    variantId: variant.variant_id,
    selectedRows: manifestRows,
    excludedRows: excluded,
  }), 'utf8');

  if (args.hard_filter_gate && args.hard_filter_fail_on_empty && manifestRows.length <= 0) {
    process.stderr.write('preference_round1_pack_hard_filter_gate_failed: no samples retained after hard filter\n');
    process.exit(4);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    variant: variant.variant_kind,
    baseline_id: variant.baseline_id,
    variant_id: variant.variant_id,
    selected_total: manifestRows.length,
    excluded_total: excluded.length,
    artifacts: {
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      manifest_json: toPosix(path.relative(process.cwd(), manifestPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
      images_dir: toPosix(path.relative(process.cwd(), imagesDir)),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_round1_pack_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
