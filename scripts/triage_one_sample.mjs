#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { preprocessPhotoBuffer, sha256Hex } from './internal_batch_helpers.mjs';
import { resolvePackImage, readJsonlRows, toPosix } from './local_image_loader.mjs';

const require = createRequire(import.meta.url);
const { runSkinDiagnosisV1, buildSkinAnalysisFromDiagnosisV1 } = require('../src/auroraBff/skinDiagnosisV1');
const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const { ensureModulesForPayload, PRED_MODULES_MISSING_REASON_DETAILS } = require('./eval_circle_local_fallback.cjs');
const { decodeRleBinary, polygonNormToMask, bboxNormToMask, countOnes } = require('../src/auroraBff/evalAdapters/common/metrics');

function parseBool(value, fallback = true) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function parseArgs(argv) {
  const home = process.env.HOME || '';
  const out = {
    review_jsonl: '',
    source: '',
    sample_hash: '',
    image_path: '',
    internal_dir: process.env.INTERNAL_DIR || path.join(home, 'Desktop', 'Aurora', 'internal test photos'),
    cache_dir: process.env.CACHE_DIR || path.join('datasets_cache', 'external'),
    lapa_dir: process.env.LAPA_DIR || path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'LaPa DB'),
    celeba_dir:
      process.env.CELEBA_DIR
      || path.join(home, 'Desktop', 'Aurora', 'datasets_raw', 'CelebAMask-HQ(1)', 'CelebAMask-HQ', 'CelebA-HQ-img'),
    lang: process.env.LANG || 'en',
    max_edge: process.env.MAX_EDGE || 2048,
    sanitize: process.env.SANITIZE || 'true',
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

  out.review_jsonl = String(out.review_jsonl || '').trim();
  out.source = String(out.source || '').trim().toLowerCase();
  out.sample_hash = String(out.sample_hash || '').trim();
  out.image_path = String(out.image_path || '').trim();
  out.internal_dir = String(out.internal_dir || '').trim();
  out.cache_dir = String(out.cache_dir || '').trim();
  out.lapa_dir = String(out.lapa_dir || '').trim();
  out.celeba_dir = String(out.celeba_dir || '').trim();
  out.lang = String(out.lang || 'en').trim().toLowerCase().startsWith('zh') ? 'CN' : 'EN';
  out.max_edge = parseNumber(out.max_edge, 2048, 512, 4096);
  out.sanitize = parseBool(out.sanitize, true);
  return out;
}

function normalizeQuality(value) {
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
  };
}

function decodeModulePixelCount(module, grid = 64) {
  if (!module || typeof module !== 'object') return 0;
  if (typeof module.mask_rle_norm === 'string' && module.mask_rle_norm.trim()) {
    const mask = decodeRleBinary(module.mask_rle_norm.trim(), grid * grid);
    return countOnes(mask);
  }
  const region = module.region && typeof module.region === 'object' ? module.region : null;
  if (!region) return 0;
  if (region.kind === 'polygon' && Array.isArray(region.polygon_norm) && region.polygon_norm.length >= 3) {
    const mask = polygonNormToMask({ points: region.polygon_norm, closed: true }, grid, grid);
    return countOnes(mask);
  }
  if (region.kind === 'bbox' && region.bbox_norm && typeof region.bbox_norm === 'object') {
    const mask = bboxNormToMask(region.bbox_norm, grid, grid);
    return countOnes(mask);
  }
  return 0;
}

function buildModulePixelsMap(payload) {
  const debug = payload && payload.internal_debug && typeof payload.internal_debug === 'object'
    ? payload.internal_debug
    : {};
  const mapFromDebug = debug.module_pixels_map && typeof debug.module_pixels_map === 'object'
    ? Object.entries(debug.module_pixels_map).reduce((acc, [key, value]) => {
      const token = String(key || '').trim();
      if (!token) return acc;
      const n = Number(value);
      if (!Number.isFinite(n)) return acc;
      acc[token] = Math.max(0, Math.trunc(n));
      return acc;
    }, {})
    : {};
  if (Object.keys(mapFromDebug).length) return mapFromDebug;
  const modules = Array.isArray(payload && payload.modules) ? payload.modules : [];
  const out = {};
  for (const module of modules) {
    const moduleId = String(module && module.module_id ? module.module_id : '').trim();
    if (!moduleId) continue;
    out[moduleId] = decodeModulePixelCount(module, 64);
  }
  return out;
}

function parseRevertedModules(payload) {
  const debug = payload && payload.internal_debug && typeof payload.internal_debug === 'object'
    ? payload.internal_debug
    : {};
  const reverted = Array.isArray(debug.circle_model_reverted_modules) ? debug.circle_model_reverted_modules : [];
  return Array.from(new Set(reverted.map((v) => String(v || '').trim()).filter(Boolean)));
}

function parseDegradedReasons(payload) {
  const debug = payload && payload.internal_debug && typeof payload.internal_debug === 'object'
    ? payload.internal_debug
    : {};
  const reasons = Array.isArray(debug.degraded_reasons) ? debug.degraded_reasons : [];
  return Array.from(new Set(reasons.map((v) => String(v || '').trim()).filter(Boolean)));
}

async function resolveByReviewRow(args) {
  if (!args.review_jsonl) throw new Error('missing --review_jsonl');
  if (!args.sample_hash) throw new Error('missing --sample_hash');
  if (!args.source) throw new Error('missing --source');
  const reviewPath = path.resolve(args.review_jsonl);
  const rows = await readJsonlRows(reviewPath);
  const matched = rows.find(
    (row) => String(row && row.sample_hash ? row.sample_hash : '').trim() === args.sample_hash
      && String(row && row.source ? row.source : '').trim().toLowerCase() === args.source,
  );
  if (!matched) {
    const error = new Error(`sample_not_found:${args.source}:${args.sample_hash}`);
    error.code = 'SAMPLE_NOT_FOUND';
    throw error;
  }
  const rel = String(matched.image_path_rel || '').trim();
  let abs = await resolvePackImage({
    source: args.source,
    imagePathRel: rel,
    internalDir: args.internal_dir,
    cacheDir: args.cache_dir,
  });
  if (!abs && rel && !/^https?:\/\//i.test(rel)) {
    if (args.source === 'lapa') abs = path.resolve(args.lapa_dir, rel);
    if (args.source === 'celebamaskhq') abs = path.resolve(args.celeba_dir, rel);
  }
  if (!abs || !fs.existsSync(abs)) {
    const error = new Error(`image_not_found:${rel}`);
    error.code = 'IMAGE_NOT_FOUND';
    throw error;
  }
  return {
    review_path: reviewPath,
    row: matched,
    image_path: abs,
  };
}

async function resolveInput(args) {
  if (args.image_path) {
    const abs = path.resolve(args.image_path);
    if (!fs.existsSync(abs)) {
      const error = new Error(`image_not_found:${abs}`);
      error.code = 'IMAGE_NOT_FOUND';
      throw error;
    }
    const sampleHash = args.sample_hash || sha256Hex(abs).slice(0, 20);
    const source = args.source || 'unknown';
    return {
      review_path: null,
      row: { source, sample_hash: sampleHash, image_path_rel: toPosix(abs) },
      image_path: abs,
    };
  }
  return resolveByReviewRow(args);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = await resolveInput(args);
  const source = String(resolved.row && resolved.row.source ? resolved.row.source : args.source || 'unknown').trim().toLowerCase() || 'unknown';
  const sampleHash = String(resolved.row && resolved.row.sample_hash ? resolved.row.sample_hash : args.sample_hash || '').trim()
    || sha256Hex(resolved.image_path).slice(0, 20);

  const rawBuffer = await fsp.readFile(resolved.image_path);
  const preprocessed = await preprocessPhotoBuffer({
    inputBuffer: rawBuffer,
    extension: path.extname(resolved.image_path).toLowerCase(),
    sanitize: args.sanitize,
    maxEdge: args.max_edge,
  });

  const diagnosis = await runSkinDiagnosisV1({
    imageBuffer: preprocessed.buffer,
    language: args.lang,
    profileSummary: null,
    recentLogsSummary: null,
  });
  if (!diagnosis || !diagnosis.ok) {
    const error = new Error(String(diagnosis && diagnosis.reason ? diagnosis.reason : 'diagnosis_failed'));
    error.code = 'LOCAL_DIAGNOSIS_FAIL';
    throw error;
  }

  const quality = diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null;
  const analysis = buildSkinAnalysisFromDiagnosisV1(diagnosis.diagnosis, {
    language: args.lang,
    profileSummary: null,
  });

  let built = null;
  let degradedReason = null;
  try {
    built = buildPhotoModulesCard({
      requestId: `triage_${sampleHash}`,
      analysis,
      usedPhotos: true,
      photoQuality: quality,
      photoNotice: null,
      diagnosisInternal: diagnosis.internal || null,
      profileSummary: null,
      language: args.lang,
      ingredientRecEnabled: false,
      productRecEnabled: false,
      internalTestMode: true,
    });
  } catch (_error) {
    degradedReason = PRED_MODULES_MISSING_REASON_DETAILS.MODULEIZER_EXCEPTION;
  }

  const qualityGrade = normalizeQuality(quality && quality.grade);
  const payloadFromBuilder =
    built && built.card && built.card.payload && typeof built.card.payload === 'object'
      ? built.card.payload
      : {
          used_photos: true,
          quality_grade: qualityGrade,
          face_crop: fallbackFaceCropFromDiagnosisInternal(diagnosis.internal || null),
          regions: [],
          modules: [],
        };

  if (!degradedReason && (qualityGrade === 'fail' || qualityGrade === 'unknown')) {
    degradedReason = PRED_MODULES_MISSING_REASON_DETAILS.QUALITY_GATED;
  }
  if (!degradedReason && (!Array.isArray(payloadFromBuilder.modules) || payloadFromBuilder.modules.length <= 0)) {
    degradedReason = PRED_MODULES_MISSING_REASON_DETAILS.MODULEIZER_EXCEPTION;
  }

  const ensured = ensureModulesForPayload(payloadFromBuilder, {
    gridSize: 64,
    degradedReason,
  });
  const payload = ensured && ensured.payload && typeof ensured.payload === 'object' ? ensured.payload : payloadFromBuilder;
  const modules = Array.isArray(payload.modules) ? payload.modules : [];
  const modulePixelsMap = buildModulePixelsMap(payload);
  const modulePixelValues = Object.values(modulePixelsMap).filter((value) => Number.isFinite(Number(value)));
  const modulePixelsMin = modulePixelValues.length ? Math.min(...modulePixelValues) : 0;
  const debug = payload && payload.internal_debug && typeof payload.internal_debug === 'object' ? payload.internal_debug : {};

  emit({
    ok: modules.length > 0,
    source,
    sample_hash: sampleHash,
    image_path: toPosix(resolved.image_path),
    image_path_hash: sha256Hex(toPosix(resolved.image_path)).slice(0, 16),
    review_jsonl: resolved.review_path ? toPosix(path.relative(process.cwd(), resolved.review_path)) : null,
    input_row: {
      source,
      sample_hash: sampleHash,
      image_path_rel: resolved.row && resolved.row.image_path_rel ? resolved.row.image_path_rel : null,
    },
    preprocess: {
      sanitize_applied: Boolean(preprocessed.sanitize_applied),
      original: preprocessed.original || null,
      processed: preprocessed.processed || null,
      photo_hash: preprocessed.photo_hash || null,
    },
    diagnosis: {
      ok: Boolean(diagnosis && diagnosis.ok),
      quality_grade: String(payload.quality_grade || qualityGrade || '').trim().toLowerCase() || null,
      face_detect_ok:
        payload.face_detect_ok != null
          ? Boolean(payload.face_detect_ok)
          : diagnosis.internal && diagnosis.internal.face_detect_ok != null
            ? Boolean(diagnosis.internal.face_detect_ok)
            : null,
      landmark_ok:
        payload.landmark_ok != null
          ? Boolean(payload.landmark_ok)
          : diagnosis.internal && diagnosis.internal.landmark_ok != null
            ? Boolean(diagnosis.internal.landmark_ok)
            : null,
      face_crop: payload.face_crop || fallbackFaceCropFromDiagnosisInternal(diagnosis.internal || null),
    },
    modules: {
      count: modules.length,
      module_pixels_min: modulePixelsMin,
      module_pixels_map: modulePixelsMap,
      reverted_modules: parseRevertedModules(payload),
      degraded_reasons: parseDegradedReasons(payload),
      module_guard_triggered: Boolean(debug.module_guard_triggered),
      guarded_modules: Array.isArray(debug.guarded_modules) ? debug.guarded_modules : [],
      module_guard_pixel_diffs: Array.isArray(debug.module_guard_pixel_diffs) ? debug.module_guard_pixel_diffs : [],
    },
  });
}

main().catch((error) => {
  const detail = {
    ok: false,
    error_code: String(error && error.code ? error.code : 'TRIAGE_FAIL'),
    error_message: String(error && error.message ? error.message : error),
    error_stack: String(error && error.stack ? error.stack : ''),
  };
  emit(detail);
  process.exitCode = 1;
});
