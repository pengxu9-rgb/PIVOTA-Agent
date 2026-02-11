#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Blob } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  collectPhotoFiles,
  csvEscape,
  fetchJsonWithRetry,
  normalizeLang,
  normalizeMarket,
  preprocessPhotoBuffer,
  ratio,
  runTimestampKey,
  sha256Hex,
  toAuroraLangHeader,
} from './internal_batch_helpers.mjs';

const require = createRequire(import.meta.url);
const { bboxNormToMask, decodeRleBinary, countOnes } = require('../src/auroraBff/evalAdapters/common/metrics');
const { runSkinDiagnosisV1, buildSkinAnalysisFromDiagnosisV1 } = require('../src/auroraBff/skinDiagnosisV1');
const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const { ensureModulesForPayload, PRED_MODULES_MISSING_REASON_DETAILS } = require('./eval_circle_local_fallback.cjs');

const HOME_DIR = process.env.HOME || '';
const DEFAULT_BASE = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_EVAL_TIMEOUT_MS = 30000;
const DEFAULT_RETRY = 2;
const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LIMIT_INTERNAL = 51;
const DEFAULT_LIMIT_FASSEG = 150;
const DEFAULT_LIMIT_LAPA = 50;
const DEFAULT_LIMIT_CELEBA = 50;
const DEFAULT_SAMPLE_SEED = 'review_pack_mixed_seed_v1';
const DEFAULT_MATRIX_BASELINE_GROUP = 'c0_k0';
const DEFAULT_CIRCLE_MODEL_PATH = path.join('model_registry', 'circle_prior_latest.json');
const DEFAULT_CIRCLE_MODEL_MIN_PIXELS = 24;
const RUN_MODES = new Set(['auto', 'local', 'remote']);
const DEFAULT_OUTSIDE_TOUCH_THRESHOLD = 0.02;
const DEFAULT_BAND_TOUCH_THRESHOLD = 0.08;
const DEFAULT_CHIN_BOTTOM_BAND_RATIO = 0.03;
const DEFAULT_NOSE_SIDE_BAND_RATIO = 0.03;
const DEFAULT_RISK_PIXELS_MIN_THRESH = 120;
const DEFAULT_RISK_INNER_OVAL_SCALE = 0.94;
const DEFAULT_GOLD_BUCKET_TOPN = 20;
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

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function mean(values) {
  const valid = Array.isArray(values)
    ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (!valid.length) return 0;
  return valid.reduce((acc, value) => acc + value, 0) / valid.length;
}

function percentile(values, p = 0.5) {
  const valid = Array.isArray(values)
    ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
    : [];
  if (!valid.length) return 0;
  const rank = Math.max(0, Math.min(valid.length - 1, Math.floor((valid.length - 1) * p)));
  return valid[rank];
}

function stddev(values) {
  const valid = Array.isArray(values)
    ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (!valid.length) return 0;
  const avg = mean(valid);
  const variance = valid.reduce((acc, value) => acc + ((value - avg) ** 2), 0) / valid.length;
  return Math.sqrt(Math.max(0, variance));
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function trimTrailingSlash(input) {
  return String(input || '').replace(/\/+$/, '');
}

function isHttpLikePath(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function deterministicSort(files, seedToken) {
  const seed = String(seedToken || DEFAULT_SAMPLE_SEED).trim() || DEFAULT_SAMPLE_SEED;
  const tokenOf = (value) => {
    if (value && typeof value === 'object') {
      const sampleHash = String(value.sample_hash || '').trim();
      if (sampleHash) return sampleHash;
      const filePath = String(value.file_path || '').trim();
      if (filePath) return filePath;
      return JSON.stringify(value);
    }
    return String(value || '');
  };
  return [...files].sort((left, right) => {
    const leftToken = tokenOf(left);
    const rightToken = tokenOf(right);
    const leftKey = sha256Hex(`${seed}:${leftToken}`);
    const rightKey = sha256Hex(`${seed}:${rightToken}`);
    if (leftKey === rightKey) return leftToken.localeCompare(rightToken);
    return leftKey.localeCompare(rightKey);
  });
}

function classifySampleLoadReason(error) {
  const code = String(error && error.code ? error.code : '').toUpperCase();
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  if (code === 'ENOENT') return 'LOCAL_FILE_NOT_FOUND';
  if (
    code === 'EIO' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    message.includes('operation not permitted') ||
    message.includes('not downloaded') ||
    message.includes('cloud') ||
    message.includes('resource busy')
  ) {
    return 'LOCAL_FILE_NOT_READY';
  }
  return 'LOCAL_FILE_NOT_READY';
}

function fileExtToken(filePath) {
  return String(path.extname(String(filePath || '')) || '')
    .trim()
    .toLowerCase();
}

function detectMagicType(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length < 12) return 'unknown';
  if (inputBuffer.length >= 3 && inputBuffer[0] === 0xff && inputBuffer[1] === 0xd8 && inputBuffer[2] === 0xff) {
    return 'jpg';
  }
  if (
    inputBuffer.length >= 8
    && inputBuffer[0] === 0x89
    && inputBuffer[1] === 0x50
    && inputBuffer[2] === 0x4e
    && inputBuffer[3] === 0x47
    && inputBuffer[4] === 0x0d
    && inputBuffer[5] === 0x0a
    && inputBuffer[6] === 0x1a
    && inputBuffer[7] === 0x0a
  ) {
    return 'png';
  }
  const riff = inputBuffer.toString('ascii', 0, 4);
  const webp = inputBuffer.toString('ascii', 8, 12);
  if (riff === 'RIFF' && webp === 'WEBP') return 'webp';
  const ftyp = inputBuffer.toString('ascii', 4, 8);
  if (ftyp === 'ftyp') {
    const brand = inputBuffer.toString('ascii', 8, 12).toLowerCase();
    if (['heic', 'heif', 'heix', 'hevc', 'heis', 'heim', 'mif1', 'msf1'].includes(brand)) {
      return 'heic';
    }
    return 'isobmff';
  }
  return 'unknown';
}

function classifyDecodeFailure({ error, ext, magicType }) {
  const code = String(error && error.code ? error.code : '').trim().toLowerCase();
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  const extToken = String(ext || '').trim().toLowerCase();
  const magic = String(magicType || '').trim().toLowerCase();
  const maybeHeic = magic === 'heic' || extToken === '.heic' || extToken === '.heif';
  if (maybeHeic && (code.includes('heic') || message.includes('heic') || message.includes('heif') || code === 'unsupported_image_format')) {
    return {
      reason_detail: 'HEIC_UNSUPPORTED',
      error_code: code || 'HEIC_UNSUPPORTED',
    };
  }
  if (maybeHeic && message.includes('unsupported image format')) {
    return {
      reason_detail: 'HEIC_UNSUPPORTED',
      error_code: code || 'HEIC_UNSUPPORTED',
    };
  }
  return {
    reason_detail: 'DECODE_FAIL',
    error_code: code || 'DECODE_FAIL',
  };
}

function inferIndexDatasetBySource(source) {
  const token = String(source || '').trim().toLowerCase();
  if (token === 'lapa') return 'lapa';
  if (token === 'celebamaskhq') return 'celebamaskhq';
  return '';
}

async function readIndexRows(indexPath) {
  const raw = await fsp.readFile(indexPath, 'utf8');
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

function parseGroup(groupId) {
  const match = /^c([01])_k([01])$/i.exec(String(groupId || '').trim());
  if (!match) return null;
  return {
    id: `c${match[1]}_k${match[2]}`,
    circle_enabled: match[1] === '1',
    calibration_enabled: match[2] === '1',
  };
}

async function resolveChosenGroup({ reportDir, explicitGroup, explicitReport }) {
  if (explicitGroup) {
    const parsed = parseGroup(explicitGroup);
    if (!parsed) throw new Error(`invalid_group:${explicitGroup}`);
    return { group: parsed, source: 'arg' };
  }

  const reportFile = explicitReport
    ? path.resolve(explicitReport)
    : await (async () => {
        const root = path.resolve(reportDir);
        const entries = await fsp.readdir(root).catch(() => []);
        const candidates = entries
          .filter((name) => /^eval_circle_matrix_\d{8}_\d{6}\.jsonl$/i.test(name))
          .map((name) => path.join(root, name));
        if (!candidates.length) return null;
        const stats = await Promise.all(
          candidates.map(async (filePath) => ({
            filePath,
            mtimeMs: (await fsp.stat(filePath)).mtimeMs,
          })),
        );
        stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return stats[0].filePath;
      })();

  if (!reportFile) {
    const fallback = parseGroup(DEFAULT_MATRIX_BASELINE_GROUP);
    return { group: fallback, source: 'fallback_default' };
  }

  const raw = await fsp.readFile(reportFile, 'utf8');
  const first = String(raw)
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
    .find(Boolean);

  const recommendedId =
    (first && first.section === 'meta' && first.recommendation && first.recommendation.group_id)
      ? String(first.recommendation.group_id)
      : DEFAULT_MATRIX_BASELINE_GROUP;
  const parsed = parseGroup(recommendedId);
  if (!parsed) throw new Error(`invalid_recommended_group:${recommendedId}`);
  return {
    group: parsed,
    source: `matrix:${toPosix(path.relative(process.cwd(), reportFile))}`,
  };
}

function parseArgs(argv) {
  const baseFromEnv = String(process.env.EVAL_BASE_URL || process.env.BASE || '').trim();
  const runModeToken = String(process.env.RUN_MODE || '').trim().toLowerCase();
  const out = {
    base_url: baseFromEnv || DEFAULT_BASE,
    base_explicit: Boolean(baseFromEnv),
    token: process.env.EVAL_TOKEN || process.env.TOKEN || '',
    market: process.env.MARKET || 'EU',
    lang: process.env.LANG || 'en',
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    internal_dir: process.env.INTERNAL_DIR || path.join(HOME_DIR, 'Desktop', 'Aurora', 'internal test photos'),
    lapa_dir: process.env.LAPA_DIR || path.join(HOME_DIR, 'Desktop', 'Aurora', 'datasets_raw', 'LaPa DB'),
    celeba_dir:
      process.env.CELEBA_DIR ||
      path.join(HOME_DIR, 'Desktop', 'Aurora', 'datasets_raw', 'CelebAMask-HQ(1)', 'CelebAMask-HQ', 'CelebA-HQ-img'),
    limit_internal: parseNumber(process.env.LIMIT_INTERNAL, DEFAULT_LIMIT_INTERNAL, 0, 10000),
    limit_dataset_fasseg: parseNumber(process.env.LIMIT_DATASET_FASSEG, DEFAULT_LIMIT_FASSEG, 0, 200000),
    limit_dataset_lapa: parseNumber(process.env.LIMIT_DATASET_LAPA, DEFAULT_LIMIT_LAPA, 0, 100000),
    limit_dataset_celeba: parseNumber(process.env.LIMIT_DATASET_CELEBA, DEFAULT_LIMIT_CELEBA, 0, 100000),
    sample_seed: String(process.env.EVAL_SAMPLE_SEED || process.env.SAMPLE_SEED || DEFAULT_SAMPLE_SEED),
    timeout_ms: parseNumber(process.env.EVAL_TIMEOUT_MS || process.env.TIMEOUT_MS, DEFAULT_EVAL_TIMEOUT_MS, 1000, 120000),
    retry: parseNumber(process.env.RETRY, DEFAULT_RETRY, 0, 5),
    max_edge: parseNumber(process.env.MAX_EDGE, DEFAULT_MAX_EDGE, 512, 4096),
    concurrency: parseNumber(process.env.EVAL_CONCURRENCY || process.env.CONCURRENCY, DEFAULT_CONCURRENCY, 1, 16),
    matrix_report: String(process.env.MATRIX_REPORT || ''),
    chosen_group: String(process.env.CHOSEN_GROUP || ''),
    circle_model_path: String(process.env.EVAL_CIRCLE_MODEL_PATH || DEFAULT_CIRCLE_MODEL_PATH),
    circle_model_min_pixels: parseNumber(process.env.CIRCLE_MODEL_MIN_PIXELS, DEFAULT_CIRCLE_MODEL_MIN_PIXELS, 1, 4096),
    eval_grid_size: parseNumber(process.env.EVAL_GRID_SIZE, 128, 64, 512),
    eval_shuffle: parseBoolean(process.env.EVAL_SHUFFLE || process.env.SHUFFLE, false),
    run_mode: RUN_MODES.has(runModeToken) ? runModeToken : 'auto',
    outside_touch_threshold: parseNumber(process.env.RISK_OUTSIDE_TOUCH_THRESHOLD, DEFAULT_OUTSIDE_TOUCH_THRESHOLD, 0, 1),
    band_touch_threshold: parseNumber(process.env.RISK_BAND_TOUCH_THRESHOLD, DEFAULT_BAND_TOUCH_THRESHOLD, 0, 1),
    chin_bottom_band_ratio: parseNumber(process.env.RISK_CHIN_BOTTOM_BAND_RATIO, DEFAULT_CHIN_BOTTOM_BAND_RATIO, 0.001, 0.5),
    nose_side_band_ratio: parseNumber(process.env.RISK_NOSE_SIDE_BAND_RATIO, DEFAULT_NOSE_SIDE_BAND_RATIO, 0.001, 0.5),
    risk_pixels_min_thresh: parseNumber(process.env.RISK_PIXELS_MIN_THRESH, DEFAULT_RISK_PIXELS_MIN_THRESH, 1, 4096),
    risk_inner_oval_scale: parseNumber(process.env.RISK_INNER_OVAL_SCALE, DEFAULT_RISK_INNER_OVAL_SCALE, 0.7, 1),
    gold_bucket_topn: parseNumber(process.env.REVIEW_GOLD_BUCKET_TOPN, DEFAULT_GOLD_BUCKET_TOPN, 1, 200),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--base_url' && next) {
      out.base_url = String(next);
      out.base_explicit = true;
      i += 1;
      continue;
    }
    if (token === '--token' && next) {
      out.token = String(next);
      i += 1;
      continue;
    }
    if (token === '--market' && next) {
      out.market = String(next);
      i += 1;
      continue;
    }
    if (token === '--lang' && next) {
      out.lang = String(next);
      i += 1;
      continue;
    }
    if (token === '--cache_dir' && next) {
      out.cache_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--internal_dir' && next) {
      out.internal_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--lapa_dir' && next) {
      out.lapa_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--celeba_dir' && next) {
      out.celeba_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--limit_internal' && next) {
      out.limit_internal = parseNumber(next, out.limit_internal, 0, 10000);
      i += 1;
      continue;
    }
    if (token === '--limit_dataset_fasseg' && next) {
      out.limit_dataset_fasseg = parseNumber(next, out.limit_dataset_fasseg, 0, 200000);
      i += 1;
      continue;
    }
    if (token === '--limit_dataset_lapa' && next) {
      out.limit_dataset_lapa = parseNumber(next, out.limit_dataset_lapa, 0, 100000);
      i += 1;
      continue;
    }
    if (token === '--limit_dataset_celeba' && next) {
      out.limit_dataset_celeba = parseNumber(next, out.limit_dataset_celeba, 0, 100000);
      i += 1;
      continue;
    }
    if (token === '--seed' && next) {
      out.sample_seed = String(next);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeout_ms = parseNumber(next, out.timeout_ms, 1000, 120000);
      i += 1;
      continue;
    }
    if (token === '--retry' && next) {
      out.retry = parseNumber(next, out.retry, 0, 5);
      i += 1;
      continue;
    }
    if (token === '--max_edge' && next) {
      out.max_edge = parseNumber(next, out.max_edge, 512, 4096);
      i += 1;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = parseNumber(next, out.concurrency, 1, 16);
      i += 1;
      continue;
    }
    if (token === '--matrix_report' && next) {
      out.matrix_report = String(next);
      i += 1;
      continue;
    }
    if (token === '--chosen_group' && next) {
      out.chosen_group = String(next);
      i += 1;
      continue;
    }
    if (token === '--circle_model_path' && next) {
      out.circle_model_path = String(next);
      i += 1;
      continue;
    }
    if (token === '--circle_model_min_pixels' && next) {
      out.circle_model_min_pixels = parseNumber(next, out.circle_model_min_pixels, 1, 4096);
      i += 1;
      continue;
    }
    if (token === '--run_mode' && next) {
      out.run_mode = String(next || '').trim().toLowerCase();
      i += 1;
      continue;
    }
  }

  out.market = normalizeMarket(out.market);
  out.lang = normalizeLang(out.lang);
  out.base_url = trimTrailingSlash(out.base_url || DEFAULT_BASE);
  out.sample_seed = String(out.sample_seed || DEFAULT_SAMPLE_SEED).trim() || DEFAULT_SAMPLE_SEED;
  out.timeout_ms = Math.max(1000, Math.trunc(out.timeout_ms));
  out.retry = Math.max(0, Math.trunc(out.retry));
  out.max_edge = Math.max(512, Math.trunc(out.max_edge));
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.limit_internal = Math.max(0, Math.trunc(out.limit_internal));
  out.limit_dataset_fasseg = Math.max(0, Math.trunc(out.limit_dataset_fasseg));
  out.limit_dataset_lapa = Math.max(0, Math.trunc(out.limit_dataset_lapa));
  out.limit_dataset_celeba = Math.max(0, Math.trunc(out.limit_dataset_celeba));
  out.eval_grid_size = Math.max(64, Math.trunc(out.eval_grid_size));
  out.circle_model_min_pixels = Math.max(1, Math.trunc(out.circle_model_min_pixels));
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.run_mode = RUN_MODES.has(out.run_mode) ? out.run_mode : 'auto';
  out.outside_touch_threshold = parseNumber(out.outside_touch_threshold, DEFAULT_OUTSIDE_TOUCH_THRESHOLD, 0, 1);
  out.band_touch_threshold = parseNumber(out.band_touch_threshold, DEFAULT_BAND_TOUCH_THRESHOLD, 0, 1);
  out.chin_bottom_band_ratio = parseNumber(out.chin_bottom_band_ratio, DEFAULT_CHIN_BOTTOM_BAND_RATIO, 0.001, 0.5);
  out.nose_side_band_ratio = parseNumber(out.nose_side_band_ratio, DEFAULT_NOSE_SIDE_BAND_RATIO, 0.001, 0.5);
  out.risk_pixels_min_thresh = Math.max(1, Math.trunc(parseNumber(out.risk_pixels_min_thresh, DEFAULT_RISK_PIXELS_MIN_THRESH, 1, 4096)));
  out.risk_inner_oval_scale = parseNumber(out.risk_inner_oval_scale, DEFAULT_RISK_INNER_OVAL_SCALE, 0.7, 1);
  out.gold_bucket_topn = Math.max(1, Math.trunc(parseNumber(out.gold_bucket_topn, DEFAULT_GOLD_BUCKET_TOPN, 1, 200)));
  return out;
}

function makeHeaders({ auroraUid, langHeader, token, group }) {
  const headers = {
    Accept: 'application/json',
    'X-Aurora-UID': auroraUid,
    'X-Lang': langHeader,
    'X-Circle-Model-Enabled': group.circle_enabled ? '1' : '0',
    'X-Circle-Model-Calibration': group.calibration_enabled ? '1' : '0',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-API-Key'] = token;
  }
  return headers;
}

function findCardByType(cards, type) {
  return Array.isArray(cards)
    ? cards.find((card) => card && String(card.type || '').trim() === String(type || '').trim())
    : null;
}

const OVAL_MASK_CACHE = new Map();
function polygonToMask(points, gridSize) {
  return require('../src/auroraBff/evalAdapters/common/metrics').polygonNormToMask(
    { points, closed: true },
    gridSize,
    gridSize,
  );
}

function getFaceOvalMask(gridSize, scale = 1) {
  const grid = Math.max(32, Math.min(256, Math.trunc(Number(gridSize) || 64)));
  const safeScale = parseNumber(scale, 1, 0.7, 1.2);
  const cacheKey = `${grid}:${safeScale.toFixed(3)}`;
  if (OVAL_MASK_CACHE.has(cacheKey)) return OVAL_MASK_CACHE.get(cacheKey);
  const points = safeScale === 1
    ? FACE_OVAL_POLYGON
    : FACE_OVAL_POLYGON.map((point) => ({
        x: 0.5 + ((safeScale) * (safeNumber(point.x, 0.5) - 0.5)),
        y: 0.5 + ((safeScale) * (safeNumber(point.y, 0.5) - 0.5)),
      }));
  const mask = polygonToMask(points, grid);
  OVAL_MASK_CACHE.set(cacheKey, mask);
  return mask;
}

function decodeModuleMask(module) {
  const grid = Math.max(32, Math.min(256, Math.trunc(Number(module && module.mask_grid) || 64)));
  if (module && typeof module.mask_rle_norm === 'string' && module.mask_rle_norm.trim()) {
    return {
      grid,
      mask: decodeRleBinary(module.mask_rle_norm.trim(), grid * grid),
    };
  }
  if (module && module.box && typeof module.box === 'object') {
    return {
      grid,
      mask: bboxNormToMask(module.box, grid, grid),
    };
  }
  return null;
}

function maskBoundingBoxNorm(mask, grid) {
  if (!(mask instanceof Uint8Array) || !grid || grid <= 1) return null;
  let minX = grid;
  let minY = grid;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const y = Math.trunc(i / grid);
    const x = i - y * grid;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX || maxY < minY) return null;
  const denom = Math.max(1, grid - 1);
  return {
    min_x: minX / denom,
    min_y: minY / denom,
    max_x: maxX / denom,
    max_y: maxY / denom,
  };
}

function leakageBgProxy(moduleMask, faceOvalMask) {
  if (!(moduleMask instanceof Uint8Array) || !(faceOvalMask instanceof Uint8Array)) {
    return { leakage_bg: null, module_pixels: 0 };
  }
  const modulePixels = countOnes(moduleMask);
  if (modulePixels <= 0) return { leakage_bg: null, module_pixels: 0 };
  let outside = 0;
  for (let i = 0; i < moduleMask.length; i += 1) {
    if (!moduleMask[i]) continue;
    if (!faceOvalMask[i]) outside += 1;
  }
  return {
    leakage_bg: round3(ratio(outside, modulePixels)),
    module_pixels: modulePixels,
  };
}

function summarizeModules(modules, options = {}) {
  const outsideTouchThreshold = parseNumber(
    options.outside_touch_threshold,
    DEFAULT_OUTSIDE_TOUCH_THRESHOLD,
    0,
    1,
  );
  const bandTouchThreshold = parseNumber(
    options.band_touch_threshold,
    DEFAULT_BAND_TOUCH_THRESHOLD,
    0,
    1,
  );
  const chinBottomBandRatio = parseNumber(
    options.chin_bottom_band_ratio,
    DEFAULT_CHIN_BOTTOM_BAND_RATIO,
    0.001,
    0.5,
  );
  const noseSideBandRatio = parseNumber(
    options.nose_side_band_ratio,
    DEFAULT_NOSE_SIDE_BAND_RATIO,
    0.001,
    0.5,
  );
  const innerOvalScale = parseNumber(
    options.risk_inner_oval_scale,
    DEFAULT_RISK_INNER_OVAL_SCALE,
    0.7,
    1,
  );
  const rows = [];
  for (const module of Array.isArray(modules) ? modules : []) {
    const decoded = decodeModuleMask(module);
    if (!decoded) continue;
    const faceOvalMask = getFaceOvalMask(decoded.grid, 1);
    const riskInnerOvalMask = getFaceOvalMask(decoded.grid, innerOvalScale);
    const leak = leakageBgProxy(decoded.mask, faceOvalMask);
    const bboxNorm = maskBoundingBoxNorm(decoded.mask, decoded.grid);
    const modulePixels = Math.max(0, Math.trunc(leak.module_pixels));
    let outsidePixels = 0;
    let bottomBandPixels = 0;
    let sideBandPixels = 0;
    const bottomBandStart = Math.max(0, decoded.grid - Math.max(1, Math.trunc(decoded.grid * chinBottomBandRatio)));
    const sideBandWidth = Math.max(1, Math.trunc(decoded.grid * noseSideBandRatio));
    for (let i = 0; i < decoded.mask.length; i += 1) {
      if (!decoded.mask[i]) continue;
      const y = Math.trunc(i / decoded.grid);
      const x = i - (y * decoded.grid);
      if (!riskInnerOvalMask[i]) outsidePixels += 1;
      if (y >= bottomBandStart) bottomBandPixels += 1;
      if (x < sideBandWidth || x >= (decoded.grid - sideBandWidth)) sideBandPixels += 1;
    }
    const outsideRatio = modulePixels > 0 ? round3(ratio(outsidePixels, modulePixels)) : null;
    const bottomBandRatio = modulePixels > 0 ? round3(ratio(bottomBandPixels, modulePixels)) : null;
    const sideBandRatio = modulePixels > 0 ? round3(ratio(sideBandPixels, modulePixels)) : null;
    rows.push({
      module_id: String(module && module.module_id ? module.module_id : '').trim() || 'unknown',
      leakage_bg: leak.leakage_bg,
      module_pixels: modulePixels,
      bbox_norm: bboxNorm,
      outside_oval_ratio: outsideRatio,
      bottom_band_ratio: bottomBandRatio,
      side_band_ratio: sideBandRatio,
    });
  }
  const chin = rows.find((row) => row.module_id === 'chin') || null;
  const nose = rows.find((row) => row.module_id === 'nose') || null;
  const leakageValues = rows
    .map((row) => safeNumber(row.leakage_bg, NaN))
    .filter((value) => Number.isFinite(value));
  const modulePixels = rows.map((row) => safeNumber(row.module_pixels, 0));
  const emptyCount = modulePixels.filter((value) => value <= 0).length;
  const chinOutsideRatio = chin ? safeNumber(chin.outside_oval_ratio, 0) : null;
  const noseOutsideRatio = nose ? safeNumber(nose.outside_oval_ratio, 0) : null;
  const chinBottomBand = chin ? safeNumber(chin.bottom_band_ratio, 0) : null;
  const noseSideBand = nose ? safeNumber(nose.side_band_ratio, 0) : null;
  const chinTouchesBottom = Boolean(
    chin && chinOutsideRatio > outsideTouchThreshold && chinBottomBand > bandTouchThreshold,
  );
  const noseTouchesSide = Boolean(
    nose && noseOutsideRatio > outsideTouchThreshold && noseSideBand > bandTouchThreshold,
  );
  return {
    modules_count: rows.length,
    module_rows: rows,
    module_pixels_min: modulePixels.length ? Math.max(0, Math.trunc(Math.min(...modulePixels))) : 0,
    empty_module_rate: modulePixels.length ? round3(emptyCount / modulePixels.length) : 0,
    chin_leakage_bg: chin ? safeNumber(chin.leakage_bg, null) : null,
    nose_leakage_bg: nose ? safeNumber(nose.leakage_bg, null) : null,
    leakage_bg_mean: leakageValues.length ? round3(mean(leakageValues)) : null,
    chin_outside_oval_ratio: chinOutsideRatio,
    nose_outside_oval_ratio: noseOutsideRatio,
    chin_bottom_band_ratio: chinBottomBand,
    nose_side_band_ratio: noseSideBand,
    chin_touches_oval_bottom: chinTouchesBottom,
    nose_touches_oval_side: noseTouchesSide,
  };
}

function parseDegradedReasons(photoPayload) {
  const reasons = new Set();
  const push = (value) => {
    const token = String(value || '').trim();
    if (token) reasons.add(token);
  };
  push(photoPayload && photoPayload.degraded_reason);
  if (Array.isArray(photoPayload && photoPayload.degraded_reasons)) {
    for (const reason of photoPayload.degraded_reasons) push(reason);
  }
  const dbg = photoPayload && photoPayload.internal_debug && typeof photoPayload.internal_debug === 'object'
    ? photoPayload.internal_debug
    : null;
  if (Array.isArray(dbg && dbg.degraded_reasons)) {
    for (const reason of dbg.degraded_reasons) push(reason);
  }
  return Array.from(reasons);
}

function parseRevertedModules(payloads) {
  const out = new Set();
  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') continue;
    const dbg = payload.internal_debug && typeof payload.internal_debug === 'object' ? payload.internal_debug : null;
    const values = Array.isArray(dbg && dbg.circle_model_reverted_modules)
      ? dbg.circle_model_reverted_modules
      : [];
    for (const value of values) {
      const token = String(value || '').trim();
      if (token) out.add(token);
    }
  }
  return Array.from(out);
}

function inferFlagBoolean(payloads, key) {
  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') continue;
    const direct = payload[key];
    if (typeof direct === 'boolean') return direct;
    const dbg = payload.internal_debug && typeof payload.internal_debug === 'object' ? payload.internal_debug : null;
    if (dbg && typeof dbg[key] === 'boolean') return dbg[key];
  }
  return null;
}

async function analyzePhotoViaApi({
  args,
  group,
  sampleHash,
  imageBuffer,
  contentType,
  sourceTag,
}) {
  const auroraUid = `${sourceTag}-${sampleHash.slice(0, 16)}`;
  const headers = makeHeaders({
    auroraUid,
    langHeader: toAuroraLangHeader(args.lang),
    token: args.token,
    group,
  });

  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: contentType }), contentType === 'image/png' ? 'photo.png' : 'photo.jpg');
  form.append('use_photo', 'true');
  form.append('market', String(args.market));
  form.append('lang', String(args.lang));
  form.append('source', `review_pack_mixed_${sourceTag}`);
  form.append('internal_test_mode', 'true');

  const response = await fetchJsonWithRetry({
    url: `${args.base_url}/v1/analysis/skin`,
    method: 'POST',
    headers,
    body: form,
    timeoutMs: args.timeout_ms,
    retry: args.retry,
  });

  if (!response || !response.ok) {
    const statusCode = safeNumber(response && response.status, 0);
    const failReason = statusCode > 0 ? `HTTP_${statusCode}` : 'PIPELINE_HTTP_FAIL';
    const reasonDetail = statusCode > 0 ? `HTTP_STATUS_${statusCode}` : 'HTTP_STATUS_UNKNOWN';
    return {
      ok: false,
      status_code: statusCode,
      fail_reason: failReason,
      reason_detail: reasonDetail,
      degraded_reasons: [],
      reverted_modules: [],
      modules_count: 0,
      module_pixels_min: 0,
      empty_module_rate: 1,
      chin_leakage_bg: null,
      nose_leakage_bg: null,
      leakage_bg_mean: null,
      chin_outside_oval_ratio: null,
      nose_outside_oval_ratio: null,
      chin_bottom_band_ratio: null,
      nose_side_band_ratio: null,
      leakage_bg_est_mean: null,
      chin_leakage_bg_est: null,
      nose_leakage_bg_est: null,
      chin_touches_oval_bottom: false,
      nose_touches_oval_side: false,
      note: String(response && response.error && response.error.message ? response.error.message : '').slice(0, 180),
      quality_grade: null,
      face_detect_ok: null,
      landmark_ok: null,
    };
  }

  const root = response.json && typeof response.json === 'object' ? response.json : {};
  const cards = Array.isArray(root.cards) ? root.cards : [];
  const photoCard = findCardByType(cards, 'photo_modules_v1');
  const analysisCard = findCardByType(cards, 'analysis_summary');
  if (!photoCard || !photoCard.payload || typeof photoCard.payload !== 'object') {
    return {
      ok: false,
      status_code: safeNumber(response.status, 0),
      fail_reason: 'NO_PHOTO_MODULES_CARD',
      degraded_reasons: [],
      reverted_modules: [],
      modules_count: 0,
      module_pixels_min: 0,
      empty_module_rate: 1,
      chin_leakage_bg: null,
      nose_leakage_bg: null,
      leakage_bg_mean: null,
      chin_outside_oval_ratio: null,
      nose_outside_oval_ratio: null,
      chin_bottom_band_ratio: null,
      nose_side_band_ratio: null,
      leakage_bg_est_mean: null,
      chin_leakage_bg_est: null,
      nose_leakage_bg_est: null,
      chin_touches_oval_bottom: false,
      nose_touches_oval_side: false,
      note: '',
      quality_grade: null,
      face_detect_ok: inferFlagBoolean([analysisCard && analysisCard.payload], 'face_detect_ok'),
      landmark_ok: inferFlagBoolean([analysisCard && analysisCard.payload], 'landmark_ok'),
    };
  }

  const photoPayload = photoCard.payload;
  const modules = Array.isArray(photoPayload.modules) ? photoPayload.modules : [];
  const moduleSummary = summarizeModules(modules, args);
  const degradedReasons = parseDegradedReasons(photoPayload);
  const revertedModules = parseRevertedModules([
    photoPayload,
    analysisCard && analysisCard.payload && typeof analysisCard.payload === 'object' ? analysisCard.payload : null,
  ]);

  const faceDetectOk = inferFlagBoolean([
    photoPayload,
    analysisCard && analysisCard.payload ? analysisCard.payload : null,
  ], 'face_detect_ok');
  const landmarkOk = inferFlagBoolean([
    photoPayload,
    analysisCard && analysisCard.payload ? analysisCard.payload : null,
  ], 'landmark_ok');

  return {
    ok: true,
    status_code: safeNumber(response.status, 0),
    fail_reason: null,
    degraded_reasons: degradedReasons,
    reverted_modules: revertedModules,
    modules_count: moduleSummary.modules_count,
    module_pixels_min: moduleSummary.module_pixels_min,
    empty_module_rate: moduleSummary.empty_module_rate,
    chin_leakage_bg: null,
    nose_leakage_bg: null,
    leakage_bg_mean: null,
    chin_outside_oval_ratio: moduleSummary.chin_outside_oval_ratio,
    nose_outside_oval_ratio: moduleSummary.nose_outside_oval_ratio,
    chin_bottom_band_ratio: moduleSummary.chin_bottom_band_ratio,
    nose_side_band_ratio: moduleSummary.nose_side_band_ratio,
    leakage_bg_est_mean: moduleSummary.leakage_bg_mean,
    chin_leakage_bg_est: moduleSummary.chin_leakage_bg,
    nose_leakage_bg_est: moduleSummary.nose_leakage_bg,
    chin_touches_oval_bottom: moduleSummary.chin_touches_oval_bottom,
    nose_touches_oval_side: moduleSummary.nose_touches_oval_side,
    module_rows: moduleSummary.module_rows,
    quality_grade: String(photoPayload.quality_grade || '').trim().toLowerCase() || null,
    face_detect_ok: faceDetectOk,
    landmark_ok: landmarkOk,
    note: '',
    integration_status: 'ok',
    integration_fail_reason: null,
  };
}

function normalizeQualityGradeToken(value) {
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

async function analyzePhotoViaLocal({
  args,
  sampleHash,
  imageBuffer,
}) {
  let diagnosis;
  try {
    diagnosis = await runSkinDiagnosisV1({
      imageBuffer,
      language: String(args.lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
      profileSummary: null,
      recentLogsSummary: null,
    });
  } catch (error) {
    return {
      ok: false,
      status_code: 0,
      fail_reason: 'LOCAL_DIAGNOSIS_EXCEPTION',
      reason_detail: null,
      degraded_reasons: [],
      reverted_modules: [],
      modules_count: 0,
      module_pixels_min: 0,
      empty_module_rate: 1,
      chin_leakage_bg: null,
      nose_leakage_bg: null,
      leakage_bg_mean: null,
      chin_outside_oval_ratio: null,
      nose_outside_oval_ratio: null,
      chin_bottom_band_ratio: null,
      nose_side_band_ratio: null,
      leakage_bg_est_mean: null,
      chin_leakage_bg_est: null,
      nose_leakage_bg_est: null,
      chin_touches_oval_bottom: false,
      nose_touches_oval_side: false,
      note: String(error && error.message ? error.message : error).slice(0, 180),
      quality_grade: null,
      face_detect_ok: null,
      landmark_ok: null,
      integration_status: 'missing_card',
      integration_fail_reason: 'LOCAL_DIAGNOSIS_EXCEPTION',
    };
  }

  if (!diagnosis || !diagnosis.ok) {
    return {
      ok: false,
      status_code: 0,
      fail_reason: 'LOCAL_DIAGNOSIS_FAIL',
      reason_detail: null,
      degraded_reasons: [],
      reverted_modules: [],
      modules_count: 0,
      module_pixels_min: 0,
      empty_module_rate: 1,
      chin_leakage_bg: null,
      nose_leakage_bg: null,
      leakage_bg_mean: null,
      chin_outside_oval_ratio: null,
      nose_outside_oval_ratio: null,
      chin_bottom_band_ratio: null,
      nose_side_band_ratio: null,
      leakage_bg_est_mean: null,
      chin_leakage_bg_est: null,
      nose_leakage_bg_est: null,
      chin_touches_oval_bottom: false,
      nose_touches_oval_side: false,
      note: String(diagnosis && diagnosis.reason ? diagnosis.reason : 'diagnosis_failed').slice(0, 180),
      quality_grade: null,
      face_detect_ok: null,
      landmark_ok: null,
      integration_status: 'missing_card',
      integration_fail_reason: 'LOCAL_DIAGNOSIS_FAIL',
    };
  }

  const quality = diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null;
  const qualityGrade = normalizeQualityGradeToken(quality && quality.grade);
  const analysis = buildSkinAnalysisFromDiagnosisV1(diagnosis.diagnosis, {
    language: String(args.lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
    profileSummary: null,
  });

  let built;
  let degradedReason = null;
  try {
    built = buildPhotoModulesCard({
      requestId: `local_${sampleHash}`,
      analysis,
      usedPhotos: true,
      photoQuality: quality,
      photoNotice: null,
      diagnosisInternal: diagnosis.internal || null,
      profileSummary: null,
      language: String(args.lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
      ingredientRecEnabled: false,
      productRecEnabled: false,
      internalTestMode: true,
    });
  } catch (_error) {
    degradedReason = PRED_MODULES_MISSING_REASON_DETAILS.MODULEIZER_EXCEPTION;
  }

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
  const moduleSummary = summarizeModules(modules, args);
  const degradedReasons = parseDegradedReasons(payload);
  if (ensured && ensured.degradedReason && !degradedReasons.includes(ensured.degradedReason)) {
    degradedReasons.push(ensured.degradedReason);
  }

  return {
    ok: moduleSummary.modules_count > 0,
    status_code: 200,
    fail_reason: moduleSummary.modules_count > 0 ? null : 'NO_PHOTO_MODULES_CARD',
    reason_detail: moduleSummary.modules_count > 0 ? null : 'LOCAL_MODULES_EMPTY',
    degraded_reasons: degradedReasons,
    reverted_modules: parseRevertedModules([payload]),
    modules_count: moduleSummary.modules_count,
    module_pixels_min: moduleSummary.module_pixels_min,
    empty_module_rate: moduleSummary.empty_module_rate,
    chin_leakage_bg: null,
    nose_leakage_bg: null,
    leakage_bg_mean: null,
    chin_outside_oval_ratio: moduleSummary.chin_outside_oval_ratio,
    nose_outside_oval_ratio: moduleSummary.nose_outside_oval_ratio,
    chin_bottom_band_ratio: moduleSummary.chin_bottom_band_ratio,
    nose_side_band_ratio: moduleSummary.nose_side_band_ratio,
    leakage_bg_est_mean: moduleSummary.leakage_bg_mean,
    chin_leakage_bg_est: moduleSummary.chin_leakage_bg,
    nose_leakage_bg_est: moduleSummary.nose_leakage_bg,
    chin_touches_oval_bottom: moduleSummary.chin_touches_oval_bottom,
    nose_touches_oval_side: moduleSummary.nose_touches_oval_side,
    module_rows: moduleSummary.module_rows,
    quality_grade: String(payload.quality_grade || qualityGrade || '').trim().toLowerCase() || null,
    face_detect_ok: inferFlagBoolean([payload, diagnosis && diagnosis.internal], 'face_detect_ok'),
    landmark_ok: inferFlagBoolean([payload, diagnosis && diagnosis.internal], 'landmark_ok'),
    note: '',
    integration_status: moduleSummary.modules_count > 0 ? 'ok' : 'missing_card',
    integration_fail_reason: moduleSummary.modules_count > 0 ? null : 'LOCAL_MODULES_EMPTY',
  };
}

function resolvePipelineMode({ runMode, sampleFilePath, baseExplicit }) {
  const mode = String(runMode || 'auto').trim().toLowerCase();
  if (mode === 'local' || mode === 'remote') return mode;
  if (isHttpLikePath(sampleFilePath)) return 'remote';
  if (baseExplicit) return 'remote';
  return 'local';
}

async function runPool(items, concurrency, worker) {
  const total = items.length;
  const out = new Array(total);
  let cursor = 0;
  async function loop() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      out[index] = await worker(items[index], index);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, total || 1)) }, () => loop());
  await Promise.all(runners);
  return out;
}

async function collectSampleFiles({ dirPath, limit, seed, source, cacheDir }) {
  if (!dirPath || limit <= 0) {
    return {
      enabled: false,
      source,
      dir: dirPath || '',
      dir_hash: '',
      total_discovered: 0,
      selected_count: 0,
      samples: [],
      sample_mode: 'none',
      skip_reason: 'disabled_or_limit_zero',
    };
  }
  const resolved = path.resolve(dirPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return {
      enabled: false,
      source,
      dir: resolved,
      dir_hash: sha256Hex(resolved).slice(0, 16),
      total_discovered: 0,
      selected_count: 0,
      samples: [],
      sample_mode: 'none',
      skip_reason: 'dir_missing',
    };
  }

  const indexDataset = inferIndexDatasetBySource(source);
  if (indexDataset && cacheDir) {
    const indexPath = path.resolve(cacheDir, indexDataset, 'index.jsonl');
    const indexStat = await fsp.stat(indexPath).catch(() => null);
    if (indexStat && indexStat.isFile()) {
      const indexRows = await readIndexRows(indexPath);
      const indexRoot = path.dirname(indexPath);
      const indexedSamples = indexRows.map((row, idx) => {
        const imagePath = String(row && row.image_path ? row.image_path : '').trim();
        const sampleHash = String(row && row.sample_id ? row.sample_id : '').trim()
          || sha256Hex(`${source}:idx:${idx}:${imagePath}`).slice(0, 20);
        if (!imagePath) {
          return {
            file_path: '',
            sample_hash: sampleHash.slice(0, 20),
            source_dataset: source,
            reason_detail: 'LOCAL_FILE_NOT_FOUND',
            preload_note: 'empty_image_path',
          };
        }
        if (/^https?:\/\//i.test(imagePath)) {
          return {
            file_path: imagePath,
            sample_hash: sampleHash.slice(0, 20),
            source_dataset: source,
            reason_detail: 'LOCAL_FILE_NOT_FOUND',
            preload_note: 'http_path_forbidden',
          };
        }
        return {
          file_path: path.resolve(indexRoot, imagePath),
          sample_hash: sampleHash.slice(0, 20),
          source_dataset: source,
          reason_detail: null,
          preload_note: '',
        };
      });
      const ordered = deterministicSort(indexedSamples, `${seed}:${source}:index`);
      const selected = ordered.slice(0, limit);
      return {
        enabled: true,
        source,
        dir: resolved,
        dir_hash: sha256Hex(resolved).slice(0, 16),
        total_discovered: indexedSamples.length,
        selected_count: selected.length,
        samples: selected,
        sample_mode: 'index',
        index_path: toPosix(path.relative(process.cwd(), indexPath)),
        skip_reason: selected.length ? null : 'empty_index',
      };
    }
  }

  const collected = await collectPhotoFiles({
    photosDir: resolved,
    limit: 0,
    shuffle: false,
  });
  const candidates = collected.files.map((filePath) => ({
    file_path: filePath,
    sample_hash: sha256Hex(`${source}:${toPosix(path.relative(resolved, filePath))}`).slice(0, 20),
    source_dataset: source,
    reason_detail: null,
    preload_note: '',
  }));
  const ordered = deterministicSort(candidates, `${seed}:${source}:dir`);
  const selected = ordered.slice(0, limit);
  return {
    enabled: true,
    source,
    dir: resolved,
    dir_hash: sha256Hex(resolved).slice(0, 16),
    total_discovered: collected.totalDiscovered,
    selected_count: selected.length,
    samples: selected,
    sample_mode: 'dir_scan',
    skip_reason: selected.length ? null : 'empty_dir',
  };
}

function computeRiskScore(row, options = {}) {
  const pixelThreshold = Math.max(
    1,
    Math.trunc(parseNumber(options.risk_pixels_min_thresh, DEFAULT_RISK_PIXELS_MIN_THRESH, 1, 4096)),
  );
  let score = 0;
  score += 2 * safeNumber(row.chin_outside_oval_ratio, 0);
  score += 2 * safeNumber(row.nose_outside_oval_ratio, 0);
  score += safeNumber(row.chin_bottom_band_ratio, 0);
  score += safeNumber(row.nose_side_band_ratio, 0);
  if (safeNumber(row.module_pixels_min, 0) < pixelThreshold) score += 0.5;
  if (!row.ok) score += 1;
  return round3(score);
}

async function runPipelineSource({ source, config, args, chosenGroup }) {
  const sampleInfo = await collectSampleFiles({
    dirPath: config.dir,
    limit: config.limit,
    seed: args.sample_seed,
    source,
    cacheDir: args.cache_dir,
  });
  if (!sampleInfo.enabled || !sampleInfo.samples.length) {
    return {
      source,
      sample_info: sampleInfo,
      rows: [],
      summary: {
        source,
        samples_total: 0,
        samples_ok: 0,
        samples_failed: 0,
        fail_reasons: [],
        data_access_failures: [],
        reverted_modules: [],
        module_pixels_min_mean: 0,
        module_pixels_min_p50: 0,
        face_detect_fail_rate: 0,
        landmark_fail_rate: 0,
      },
    };
  }

  const rows = await runPool(sampleInfo.samples, args.concurrency, async (sample) => {
    const filePath = sample && sample.file_path ? String(sample.file_path) : '';
    const ext = fileExtToken(filePath);
    const sampleHashSeed = String(sample && sample.sample_hash ? sample.sample_hash : '').trim();
    if (sample && sample.reason_detail) {
      const preloadRow = {
        source,
        dataset: source,
        pipeline_mode_used: String(sample.preload_note || '').includes('http_path_forbidden') ? 'remote' : 'local',
        sample_hash: sampleHashSeed || sha256Hex(`preload_fail:${source}:${filePath}`).slice(0, 20),
        ok: false,
        fail_reason: 'SAMPLE_LOAD_FAIL',
        reason_detail: String(sample.reason_detail || 'LOCAL_FILE_NOT_FOUND'),
        decode_ext: ext || null,
        decode_magic: null,
        decode_error_code: null,
        status_code: 0,
        quality_grade: null,
        modules_count: 0,
        module_pixels_min: 0,
        empty_module_rate: 1,
        leakage_bg_mean: null,
        leakage_bg_est_mean: null,
        chin_leakage_bg: null,
        nose_leakage_bg: null,
        chin_leakage_bg_est: null,
        nose_leakage_bg_est: null,
        chin_outside_oval_ratio: null,
        nose_outside_oval_ratio: null,
        chin_bottom_band_ratio: null,
        nose_side_band_ratio: null,
        leakage_hair_mean: null,
        chin_touches_oval_bottom: false,
        nose_touches_oval_side: false,
        degraded_reasons: [],
        reverted_modules: [],
        face_detect_ok: null,
        landmark_ok: null,
        note: String(sample.preload_note || '').slice(0, 120),
      };
      preloadRow.risk_score = computeRiskScore(preloadRow, args);
      return preloadRow;
    }

    let rawBuffer;
    try {
      rawBuffer = await fsp.readFile(filePath);
    } catch (error) {
      const readFailRow = {
        source,
        dataset: source,
        pipeline_mode_used: 'local',
        sample_hash: sampleHashSeed || sha256Hex(`read_fail:${source}:${String(filePath || '')}`).slice(0, 20),
        ok: false,
        fail_reason: 'SAMPLE_LOAD_FAIL',
        reason_detail: classifySampleLoadReason(error),
        decode_ext: ext || null,
        decode_magic: null,
        decode_error_code: String(error && error.code ? error.code : '').trim().toUpperCase() || null,
        status_code: 0,
        quality_grade: null,
        modules_count: 0,
        module_pixels_min: 0,
        empty_module_rate: 1,
        leakage_bg_mean: null,
        leakage_bg_est_mean: null,
        chin_leakage_bg: null,
        nose_leakage_bg: null,
        chin_leakage_bg_est: null,
        nose_leakage_bg_est: null,
        chin_outside_oval_ratio: null,
        nose_outside_oval_ratio: null,
        chin_bottom_band_ratio: null,
        nose_side_band_ratio: null,
        leakage_hair_mean: null,
        chin_touches_oval_bottom: false,
        nose_touches_oval_side: false,
        degraded_reasons: [],
        reverted_modules: [],
        face_detect_ok: null,
        landmark_ok: null,
        note: String(error && error.message ? error.message : error).slice(0, 120),
      };
      readFailRow.risk_score = computeRiskScore(readFailRow, args);
      return readFailRow;
    }

    let preprocessed;
    let sampleHash = sampleHashSeed || sha256Hex(rawBuffer).slice(0, 20);
    const magicType = detectMagicType(rawBuffer);
    try {
      preprocessed = await preprocessPhotoBuffer({
        inputBuffer: rawBuffer,
        extension: ext,
        sanitize: true,
        maxEdge: args.max_edge,
      });
      sampleHash = sha256Hex(preprocessed.buffer).slice(0, 20);
    } catch (error) {
      const decoded = classifyDecodeFailure({ error, ext, magicType });
      const decodeFailRow = {
        source,
        dataset: source,
        pipeline_mode_used: 'local',
        sample_hash: sampleHash,
        ok: false,
        fail_reason: 'SAMPLE_LOAD_FAIL',
        reason_detail: decoded.reason_detail,
        decode_ext: ext || null,
        decode_magic: magicType || 'unknown',
        decode_error_code: decoded.error_code,
        status_code: 0,
        quality_grade: null,
        modules_count: 0,
        module_pixels_min: 0,
        empty_module_rate: 1,
        leakage_bg_mean: null,
        leakage_bg_est_mean: null,
        chin_leakage_bg: null,
        nose_leakage_bg: null,
        chin_leakage_bg_est: null,
        nose_leakage_bg_est: null,
        chin_outside_oval_ratio: null,
        nose_outside_oval_ratio: null,
        chin_bottom_band_ratio: null,
        nose_side_band_ratio: null,
        leakage_hair_mean: null,
        chin_touches_oval_bottom: false,
        nose_touches_oval_side: false,
        degraded_reasons: [],
        reverted_modules: [],
        face_detect_ok: null,
        landmark_ok: null,
        note: String(error && error.message ? error.message : error).slice(0, 120),
      };
      decodeFailRow.risk_score = computeRiskScore(decodeFailRow, args);
      return decodeFailRow;
    }

    let result;
    const pipelineMode = resolvePipelineMode({
      runMode: args.run_mode,
      sampleFilePath: filePath,
      baseExplicit: args.base_explicit,
    });
    try {
      if (pipelineMode === 'remote') {
        result = await analyzePhotoViaApi({
          args,
          group: chosenGroup.group,
          sampleHash,
          imageBuffer: preprocessed.buffer,
          contentType: preprocessed.processed.content_type || 'image/jpeg',
          sourceTag: source,
        });
      } else {
        result = await analyzePhotoViaLocal({
          args,
          sampleHash,
          imageBuffer: preprocessed.buffer,
        });
      }
    } catch (error) {
      result = {
        ok: false,
        status_code: 0,
        fail_reason: 'ANALYSIS_EXCEPTION',
        reason_detail: null,
        degraded_reasons: [],
        reverted_modules: [],
        modules_count: 0,
        module_pixels_min: 0,
        empty_module_rate: 1,
        chin_leakage_bg: null,
        nose_leakage_bg: null,
        leakage_bg_mean: null,
        leakage_bg_est_mean: null,
        chin_leakage_bg_est: null,
        nose_leakage_bg_est: null,
        chin_outside_oval_ratio: null,
        nose_outside_oval_ratio: null,
        chin_bottom_band_ratio: null,
        nose_side_band_ratio: null,
        chin_touches_oval_bottom: false,
        nose_touches_oval_side: false,
        leakage_hair_mean: null,
        quality_grade: null,
        note: 'analyze_exception',
        face_detect_ok: null,
        landmark_ok: null,
        integration_status: pipelineMode === 'remote' ? 'http_error' : 'missing_card',
        integration_fail_reason: pipelineMode === 'remote' ? 'ANALYSIS_EXCEPTION' : 'LOCAL_ANALYSIS_EXCEPTION',
      };
    }
    const row = {
      source,
      dataset: source,
      pipeline_mode_used: pipelineMode,
      sample_hash: sampleHash,
      ok: Boolean(result.ok),
      fail_reason: result.fail_reason || null,
      reason_detail: result.reason_detail || null,
      decode_ext: ext || null,
      decode_magic: magicType || null,
      decode_error_code: null,
      status_code: safeNumber(result.status_code, 0),
      quality_grade: result.quality_grade || null,
      modules_count: safeNumber(result.modules_count, 0),
      module_pixels_min: safeNumber(result.module_pixels_min, 0),
      empty_module_rate: round3(safeNumber(result.empty_module_rate, 1)),
      leakage_bg_mean: null,
      leakage_bg_est_mean: result.leakage_bg_est_mean == null ? null : round3(result.leakage_bg_est_mean),
      leakage_hair_mean: null,
      chin_leakage_bg: null,
      nose_leakage_bg: null,
      chin_leakage_bg_est: result.chin_leakage_bg_est == null ? null : round3(result.chin_leakage_bg_est),
      nose_leakage_bg_est: result.nose_leakage_bg_est == null ? null : round3(result.nose_leakage_bg_est),
      chin_outside_oval_ratio: result.chin_outside_oval_ratio == null ? null : round3(result.chin_outside_oval_ratio),
      nose_outside_oval_ratio: result.nose_outside_oval_ratio == null ? null : round3(result.nose_outside_oval_ratio),
      chin_bottom_band_ratio: result.chin_bottom_band_ratio == null ? null : round3(result.chin_bottom_band_ratio),
      nose_side_band_ratio: result.nose_side_band_ratio == null ? null : round3(result.nose_side_band_ratio),
      chin_touches_oval_bottom: Boolean(result.chin_touches_oval_bottom),
      nose_touches_oval_side: Boolean(result.nose_touches_oval_side),
      degraded_reasons: Array.isArray(result.degraded_reasons) ? result.degraded_reasons : [],
      reverted_modules: Array.isArray(result.reverted_modules) ? result.reverted_modules : [],
      face_detect_ok: typeof result.face_detect_ok === 'boolean' ? result.face_detect_ok : null,
      landmark_ok: typeof result.landmark_ok === 'boolean' ? result.landmark_ok : null,
      note: result.note || '',
      integration_status: result.integration_status || (pipelineMode === 'remote' ? 'ok' : 'n/a'),
      integration_fail_reason: result.integration_fail_reason || null,
    };
    if (source !== 'fasseg' && row.ok) {
      const estLeak = safeNumber(row.leakage_bg_est_mean, 0);
      if (
        estLeak > 0
        && safeNumber(row.chin_outside_oval_ratio, 0) <= 0
        && safeNumber(row.nose_outside_oval_ratio, 0) <= 0
      ) {
        row.chin_outside_oval_ratio = round3(estLeak * 0.7);
        row.nose_outside_oval_ratio = round3(estLeak);
        row.chin_bottom_band_ratio = round3(Math.max(safeNumber(row.chin_bottom_band_ratio, 0), estLeak * 0.35));
        row.nose_side_band_ratio = round3(Math.max(safeNumber(row.nose_side_band_ratio, 0), estLeak * 0.35));
      }
      row.chin_touches_oval_bottom = safeNumber(row.chin_outside_oval_ratio, 0) > args.outside_touch_threshold
        && safeNumber(row.chin_bottom_band_ratio, 0) > args.band_touch_threshold;
      row.nose_touches_oval_side = safeNumber(row.nose_outside_oval_ratio, 0) > args.outside_touch_threshold
        && safeNumber(row.nose_side_band_ratio, 0) > args.band_touch_threshold;
    }
    row.risk_score = computeRiskScore(row, args);
    return row;
  });

  const failMap = new Map();
  const dataAccessMap = new Map();
  const decodeFailureMap = new Map();
  const decodeExamples = [];
  const integrationFailMap = new Map();
  const revertMap = new Map();
  const okRows = rows.filter((row) => row.ok);
  const failRows = rows.filter((row) => !row.ok);
  for (const row of failRows) {
    const key = String(row.fail_reason || 'UNKNOWN');
    failMap.set(key, (failMap.get(key) || 0) + 1);
    if (key === 'SAMPLE_LOAD_FAIL') {
      const detail = String(row.reason_detail || 'UNKNOWN');
      dataAccessMap.set(detail, (dataAccessMap.get(detail) || 0) + 1);
      const extToken = String(row.decode_ext || '').trim().toLowerCase() || '-';
      const decodeKey = `${extToken}|${detail}`;
      decodeFailureMap.set(decodeKey, (decodeFailureMap.get(decodeKey) || 0) + 1);
      if (decodeExamples.length < 5 && (detail === 'HEIC_UNSUPPORTED' || detail === 'DECODE_FAIL')) {
        decodeExamples.push({
          sample_hash: String(row.sample_hash || '').trim(),
          ext: extToken,
          reason_detail: detail,
          error_code: String(row.decode_error_code || '').trim() || '-',
        });
      }
    }
    if (String(row.pipeline_mode_used || '') === 'remote') {
      const integrationKey = String(row.integration_fail_reason || row.fail_reason || 'UNKNOWN');
      integrationFailMap.set(integrationKey, (integrationFailMap.get(integrationKey) || 0) + 1);
    }
  }
  for (const row of okRows) {
    const tokens = Array.isArray(row.reverted_modules) && row.reverted_modules.length ? row.reverted_modules : ['-'];
    for (const token of tokens) {
      revertMap.set(token, (revertMap.get(token) || 0) + 1);
    }
  }
  const pixels = okRows
    .map((row) => safeNumber(row.module_pixels_min, NaN))
    .filter((value) => Number.isFinite(value));
  const faceDetectKnown = rows.filter((row) => typeof row.face_detect_ok === 'boolean');
  const landmarkKnown = rows.filter((row) => typeof row.landmark_ok === 'boolean');

  return {
    source,
    sample_info: sampleInfo,
    rows,
    summary: {
      source,
      samples_total: rows.length,
      samples_ok: okRows.length,
      samples_failed: failRows.length,
      fail_reasons: Array.from(failMap.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      data_access_failures: Array.from(dataAccessMap.entries())
        .map(([reason_detail, count]) => ({ reason_detail, count }))
        .sort((a, b) => b.count - a.count || a.reason_detail.localeCompare(b.reason_detail)),
      decode_failures_breakdown: Array.from(decodeFailureMap.entries())
        .map(([token, count]) => {
          const [ext, reason_detail] = String(token).split('|');
          return { ext, reason_detail, count };
        })
        .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext) || a.reason_detail.localeCompare(b.reason_detail)),
      decode_error_examples: decodeExamples,
      integration_failures: Array.from(integrationFailMap.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      reverted_modules: Array.from(revertMap.entries())
        .map(([module_id, count]) => ({ module_id, count }))
        .sort((a, b) => b.count - a.count || a.module_id.localeCompare(b.module_id)),
      module_pixels_min_mean: round3(mean(pixels)),
      module_pixels_min_p50: round3(percentile(pixels, 0.5)),
      face_detect_fail_rate: faceDetectKnown.length
        ? round3(faceDetectKnown.filter((row) => row.face_detect_ok === false).length / faceDetectKnown.length)
        : 0,
      landmark_fail_rate: landmarkKnown.length
        ? round3(landmarkKnown.filter((row) => row.landmark_ok === false).length / landmarkKnown.length)
        : 0,
    },
  };
}

function parseLastJsonLine(stdoutText) {
  const lines = String(stdoutText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch (_error) {
      // continue
    }
  }
  throw new Error('missing_json_output');
}

async function readJsonlRows(filePath) {
  const text = await fsp.readFile(path.resolve(filePath), 'utf8');
  return String(text)
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

function perModuleValue(moduleScores, moduleId, field, fallback = null) {
  if (!Array.isArray(moduleScores)) return fallback;
  const hit = moduleScores.find((row) => String(row && row.module_id || '') === String(moduleId));
  if (!hit) return fallback;
  const value = Number(hit[field]);
  return Number.isFinite(value) ? round3(value) : fallback;
}

function toFassegRow(row) {
  const metricStats = row && row.metric_stats && typeof row.metric_stats === 'object' ? row.metric_stats : {};
  const moduleScores = Array.isArray(row && row.module_scores) ? row.module_scores : [];
  const chinLeak = perModuleValue(moduleScores, 'chin', 'leakage_bg', null);
  const noseLeak = perModuleValue(moduleScores, 'nose', 'leakage_bg', null);
  return {
    source: 'fasseg',
    dataset: 'fasseg',
    pipeline_mode_used: 'fasseg_eval',
    sample_hash: String(row && row.sample_hash ? row.sample_hash : ''),
    ok: Boolean(row && row.ok),
    fail_reason: row && row.fail_reason ? String(row.fail_reason) : null,
    reason_detail: row && row.reason_detail ? String(row.reason_detail) : null,
    status_code: 200,
    quality_grade: row && row.quality_grade ? String(row.quality_grade) : null,
    modules_count: safeNumber(row && row.pred_stats && row.pred_stats.module_count, 0),
    module_pixels_min: safeNumber(metricStats.module_pixels_min, 0),
    empty_module_rate: round3(safeNumber(metricStats.empty_module_rate, 0)),
    leakage_bg_mean: round3(safeNumber(metricStats.leakage_bg_mean, safeNumber(metricStats.leakage_mean, 0))),
    leakage_bg_est_mean: null,
    chin_leakage_bg: chinLeak,
    nose_leakage_bg: noseLeak,
    chin_leakage_bg_est: null,
    nose_leakage_bg_est: null,
    chin_outside_oval_ratio: null,
    nose_outside_oval_ratio: null,
    chin_bottom_band_ratio: null,
    nose_side_band_ratio: null,
    chin_touches_oval_bottom: false,
    nose_touches_oval_side: false,
    degraded_reasons: row && row.degraded_reason ? [String(row.degraded_reason)] : [],
    reverted_modules: [],
    face_detect_ok: row && typeof row.face_detect_ok === 'boolean' ? row.face_detect_ok : null,
    landmark_ok: row && typeof row.landmark_ok === 'boolean' ? row.landmark_ok : null,
    note: row && row.note ? String(row.note) : '',
    risk_score: round3(Math.max(safeNumber(chinLeak, 0), safeNumber(noseLeak, 0))),
    leakage_hair_mean: round3(safeNumber(metricStats.leakage_hair_mean, 0)),
    decode_ext: null,
    decode_magic: null,
    decode_error_code: null,
  };
}

function runFassegEval({ args, runDir, chosenGroup }) {
  if (args.limit_dataset_fasseg <= 0) {
    return {
      payload: null,
      rows: [],
      gate_pass: true,
      gate_reason: 'fasseg_disabled',
    };
  }
  const evalScript = path.resolve('scripts', 'eval_circle_accuracy.mjs');
  const cli = [
    evalScript,
    '--cache_dir',
    args.cache_dir,
    '--datasets',
    'fasseg',
    '--limit',
    String(args.limit_dataset_fasseg),
    '--concurrency',
    String(args.concurrency),
    '--timeout_ms',
    String(args.timeout_ms),
    '--market',
    args.market,
    '--lang',
    args.lang,
    '--grid_size',
    String(args.eval_grid_size),
    '--report_dir',
    runDir,
    '--sample_seed',
    `${args.sample_seed}:fasseg`,
    '--shuffle',
    '--circle_model_min_pixels',
    String(args.circle_model_min_pixels),
  ];
  if (chosenGroup.group.circle_enabled) {
    cli.push('--circle_model_path', args.circle_model_path);
  } else {
    cli.push('--circle_model_path', 'off');
  }
  if (!chosenGroup.group.calibration_enabled) {
    cli.push('--disable_circle_model_calibration');
  }
  const useRemoteForFassegEval = args.run_mode === 'remote' || (args.run_mode === 'auto' && args.base_explicit);
  if (useRemoteForFassegEval && args.base_url) cli.push('--base_url', args.base_url);
  if (args.token) cli.push('--token', args.token);

  const result = spawnSync(process.execPath, cli, {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN: args.token || process.env.TOKEN || '',
      EVAL_TOKEN: args.token || process.env.EVAL_TOKEN || '',
    },
  });
  const payload = parseLastJsonLine(result.stdout);
  payload.eval_exit_code = Number.isFinite(Number(result.status)) ? Number(result.status) : 0;
  return payload;
}

function topRiskRows(rows, limit = 20) {
  const ordered = [...rows]
    .filter((row) => String(row.pipeline_mode_used || '') === 'local')
    .filter((row) => row && row.ok === true)
    .filter((row) => safeNumber(row.module_pixels_min, 0) > 0)
    .filter((row) => Number.isFinite(Number(row.risk_score)))
    .sort((a, b) => {
      const diff = safeNumber(b.risk_score) - safeNumber(a.risk_score);
      if (Math.abs(diff) > 1e-9) return diff;
      return String(a.sample_hash || '').localeCompare(String(b.sample_hash || ''));
    });
  const target = Math.max(0, Math.trunc(limit));
  if (!target || !ordered.length) return [];

  const signatureOf = (row) => [
    round3(row.risk_score),
    round3(row.chin_outside_oval_ratio),
    round3(row.nose_outside_oval_ratio),
    round3(row.chin_bottom_band_ratio),
    round3(row.nose_side_band_ratio),
    Math.trunc(safeNumber(row.module_pixels_min, 0)),
  ].join('|');

  const selected = [];
  const selectedHashes = new Set();
  const signatureCounts = new Map();
  const maxPerSignature = Math.max(2, Math.trunc(target / 4));

  for (const row of ordered) {
    const signature = signatureOf(row);
    if (signatureCounts.has(signature)) continue;
    selected.push(row);
    selectedHashes.add(String(row.sample_hash || ''));
    signatureCounts.set(signature, 1);
    if (selected.length >= target) break;
  }

  if (selected.length < target) {
    for (const row of ordered) {
      const sampleHash = String(row.sample_hash || '');
      if (selectedHashes.has(sampleHash)) continue;
      const signature = signatureOf(row);
      const count = signatureCounts.get(signature) || 0;
      if (count >= maxPerSignature) continue;
      selected.push(row);
      selectedHashes.add(sampleHash);
      signatureCounts.set(signature, count + 1);
      if (selected.length >= target) break;
    }
  }

  if (selected.length < target) {
    for (const row of ordered) {
      const sampleHash = String(row.sample_hash || '');
      if (selectedHashes.has(sampleHash)) continue;
      selected.push(row);
      selectedHashes.add(sampleHash);
      if (selected.length >= target) break;
    }
  }

  return selected.slice(0, target);
}

function summarizeSourceForMd(summary) {
  return [
    `- samples_total: ${summary.samples_total}`,
    `- samples_ok: ${summary.samples_ok}`,
    `- samples_failed: ${summary.samples_failed}`,
    `- module_pixels_min_mean: ${summary.module_pixels_min_mean}`,
    `- module_pixels_min_p50: ${summary.module_pixels_min_p50}`,
    `- face_detect_fail_rate: ${summary.face_detect_fail_rate}`,
    `- landmark_fail_rate: ${summary.landmark_fail_rate}`,
  ];
}

function renderMd({
  runId,
  args,
  chosenGroup,
  internalResult,
  fassegPayload,
  lapaResult,
  celebaResult,
  mixedRows,
  mdPath,
  csvPath,
  jsonlPath,
  gatePass,
}) {
  const externalRows = [
    ...lapaResult.rows.map((row) => ({ ...row, source_dataset: 'lapa' })),
    ...celebaResult.rows.map((row) => ({ ...row, source_dataset: 'celebamaskhq' })),
  ];
  const externalTopRisk = topRiskRows(externalRows, 20);
  const constantFeatureWarnings = (() => {
    if (!externalTopRisk.length) return [];
    const targets = [
      'risk_score',
      'chin_outside_oval_ratio',
      'nose_outside_oval_ratio',
      'chin_bottom_band_ratio',
      'nose_side_band_ratio',
      'module_pixels_min',
    ];
    const warnings = [];
    for (const field of targets) {
      const values = externalTopRisk
        .map((row) => Number(row[field]))
        .filter((value) => Number.isFinite(value));
      if (!values.length) continue;
      if (stddev(values) < 1e-6) warnings.push(`RISK_FEATURE_CONSTANT(field=${field})`);
    }
    return warnings;
  })();
  const riskTopDistinctSignatures = (() => {
    if (!externalTopRisk.length) return 0;
    const signatures = new Set(
      externalTopRisk.map((row) => [
        round3(row.risk_score),
        round3(row.chin_outside_oval_ratio),
        round3(row.nose_outside_oval_ratio),
        round3(row.chin_bottom_band_ratio),
        round3(row.nose_side_band_ratio),
        Math.trunc(safeNumber(row.module_pixels_min, 0)),
      ].join('|')),
    );
    return signatures.size;
  })();
  const integrationFailures = [
    ...((internalResult.summary && internalResult.summary.integration_failures) || []).map((row) => ({ source: 'internal', reason: row.reason, count: row.count })),
    ...((lapaResult.summary && lapaResult.summary.integration_failures) || []).map((row) => ({ source: 'lapa', reason: row.reason, count: row.count })),
    ...((celebaResult.summary && celebaResult.summary.integration_failures) || []).map((row) => ({ source: 'celebamaskhq', reason: row.reason, count: row.count })),
  ]
    .filter((row) => safeNumber(row.count, 0) > 0)
    .sort((a, b) => safeNumber(b.count, 0) - safeNumber(a.count, 0) || String(a.source).localeCompare(String(b.source)));
  const dataAccessFailures = [
    ...((internalResult.summary && internalResult.summary.data_access_failures) || []).map((row) => ({
      source: 'internal',
      reason_detail: row.reason_detail,
      count: row.count,
    })),
    ...((lapaResult.summary && lapaResult.summary.data_access_failures) || []).map((row) => ({
      source: 'lapa',
      reason_detail: row.reason_detail,
      count: row.count,
    })),
    ...((celebaResult.summary && celebaResult.summary.data_access_failures) || []).map((row) => ({
      source: 'celebamaskhq',
      reason_detail: row.reason_detail,
      count: row.count,
    })),
  ]
    .filter((row) => safeNumber(row.count, 0) > 0)
    .sort((a, b) => safeNumber(b.count, 0) - safeNumber(a.count, 0) || String(a.source).localeCompare(String(b.source)));
  const decodeFailureBreakdown = [
    ...((internalResult.summary && internalResult.summary.decode_failures_breakdown) || []).map((row) => ({ source: 'internal', ...row })),
    ...((lapaResult.summary && lapaResult.summary.decode_failures_breakdown) || []).map((row) => ({ source: 'lapa', ...row })),
    ...((celebaResult.summary && celebaResult.summary.decode_failures_breakdown) || []).map((row) => ({ source: 'celebamaskhq', ...row })),
  ]
    .filter((row) => safeNumber(row.count, 0) > 0)
    .sort((a, b) => safeNumber(b.count, 0) - safeNumber(a.count, 0) || String(a.source).localeCompare(String(b.source)));
  const decodeErrorExamples = [
    ...((internalResult.summary && internalResult.summary.decode_error_examples) || []).map((row) => ({ source: 'internal', ...row })),
    ...((lapaResult.summary && lapaResult.summary.decode_error_examples) || []).map((row) => ({ source: 'lapa', ...row })),
    ...((celebaResult.summary && celebaResult.summary.decode_error_examples) || []).map((row) => ({ source: 'celebamaskhq', ...row })),
  ].slice(0, 5);
  const lines = [];
  lines.push('# Mixed Review Pack');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- sample_seed: ${args.sample_seed}`);
  lines.push(`- chosen_group: ${chosenGroup.group.id} (circle=${chosenGroup.group.circle_enabled ? 1 : 0}, calibration=${chosenGroup.group.calibration_enabled ? 1 : 0})`);
  lines.push(`- chosen_group_source: ${chosenGroup.source}`);
  lines.push(`- run_mode: ${args.run_mode}`);
  lines.push(`- base_explicit: ${args.base_explicit ? 'true' : 'false'}`);
  lines.push(`- gate_status_fasseg: ${gatePass ? 'PASS' : 'FAIL'}`);
  lines.push(`- mixed_rows_total: ${mixedRows.length}`);
  lines.push('');

  lines.push('## Internal (no image artifacts)');
  lines.push('');
  lines.push(`- internal_dir_hash: ${internalResult.sample_info.dir_hash}`);
  lines.push(`- selected_count: ${internalResult.sample_info.selected_count}`);
  lines.push(...summarizeSourceForMd(internalResult.summary));
  lines.push('');
  lines.push('| fail_reason | count |');
  lines.push('|---|---:|');
  if (internalResult.summary.fail_reasons.length) {
    for (const row of internalResult.summary.fail_reasons) lines.push(`| ${row.reason} | ${row.count} |`);
  } else {
    lines.push('| - | 0 |');
  }
  lines.push('');

  lines.push('## FASSEG Gate (segmentation_only)');
  lines.push('');
  if (fassegPayload) {
    lines.push(`- samples_total: ${fassegPayload.samples_total}`);
    lines.push(`- samples_ok: ${fassegPayload.samples_ok}`);
    lines.push(`- samples_failed: ${fassegPayload.samples_failed}`);
    lines.push(`- leakage_bg_mean: ${round3(fassegPayload.leakage_bg_mean)}`);
    lines.push(`- leakage_hair_mean: ${round3(fassegPayload.leakage_hair_mean)}`);
    lines.push(`- empty_module_rate: ${round3(fassegPayload.empty_module_rate)}`);
    lines.push(`- module_pixels_min: ${Math.trunc(safeNumber(fassegPayload.module_pixels_min, 0))}`);
    lines.push(`- hard_gate: samples_ok>0 && leakage_bg_mean<=0.1 && empty_module_rate<=0.01 => ${gatePass ? 'PASS' : 'FAIL'}`);
  } else {
    lines.push('- skipped: LIMIT_DATASET_FASSEG=0');
  }
  lines.push('');

  lines.push('## External Stress (LaPa / CelebA, no GT gate)');
  lines.push('');
  lines.push(`- lapa_dir_hash: ${lapaResult.sample_info.dir_hash || '-'}`);
  lines.push(`- lapa_selected_count: ${lapaResult.sample_info.selected_count || 0}`);
  lines.push(`- lapa_sample_mode: ${lapaResult.sample_info.sample_mode || '-'}`);
  lines.push(`- lapa_index_path: ${lapaResult.sample_info.index_path || '-'}`);
  lines.push(`- lapa_local_samples_ok: ${lapaResult.rows.filter((row) => row.ok && row.pipeline_mode_used === 'local').length}`);
  lines.push(`- celeba_dir_hash: ${celebaResult.sample_info.dir_hash || '-'}`);
  lines.push(`- celeba_selected_count: ${celebaResult.sample_info.selected_count || 0}`);
  lines.push(`- celeba_sample_mode: ${celebaResult.sample_info.sample_mode || '-'}`);
  lines.push(`- celeba_index_path: ${celebaResult.sample_info.index_path || '-'}`);
  lines.push(`- celeba_local_samples_ok: ${celebaResult.rows.filter((row) => row.ok && row.pipeline_mode_used === 'local').length}`);
  lines.push('');
  lines.push('| source | samples_total | samples_failed | module_pixels_min_p50 | face_detect_fail_rate | landmark_fail_rate |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  lines.push(`| lapa | ${lapaResult.summary.samples_total} | ${lapaResult.summary.samples_failed} | ${lapaResult.summary.module_pixels_min_p50} | ${lapaResult.summary.face_detect_fail_rate} | ${lapaResult.summary.landmark_fail_rate} |`);
  lines.push(`| celebamaskhq | ${celebaResult.summary.samples_total} | ${celebaResult.summary.samples_failed} | ${celebaResult.summary.module_pixels_min_p50} | ${celebaResult.summary.face_detect_fail_rate} | ${celebaResult.summary.landmark_fail_rate} |`);
  lines.push('');
  lines.push('### Data access failures');
  lines.push('');
  lines.push('| source | reason_detail | count |');
  lines.push('|---|---|---:|');
  if (dataAccessFailures.length) {
    for (const row of dataAccessFailures) {
      lines.push(`| ${row.source} | ${row.reason_detail} | ${Math.trunc(safeNumber(row.count, 0))} |`);
    }
  } else {
    lines.push('| - | - | 0 |');
  }
  lines.push('');
  lines.push('### Decode failures breakdown');
  lines.push('');
  lines.push('| source | ext | reason_detail | count |');
  lines.push('|---|---|---|---:|');
  if (decodeFailureBreakdown.length) {
    for (const row of decodeFailureBreakdown) {
      lines.push(`| ${row.source} | ${row.ext || '-'} | ${row.reason_detail || '-'} | ${Math.trunc(safeNumber(row.count, 0))} |`);
    }
  } else {
    lines.push('| - | - | - | 0 |');
  }
  lines.push('');
  lines.push('### Top 5 decode errors (sample hash only)');
  lines.push('');
  lines.push('| source | sample_hash | ext | reason_detail | error_code |');
  lines.push('|---|---|---|---|---|');
  if (decodeErrorExamples.length) {
    for (const row of decodeErrorExamples) {
      lines.push(`| ${row.source} | ${row.sample_hash || '-'} | ${row.ext || '-'} | ${row.reason_detail || '-'} | ${row.error_code || '-'} |`);
    }
  } else {
    lines.push('| - | - | - | - | - |');
  }
  lines.push('');
  lines.push('### Integration failures (remote-only)');
  lines.push('');
  lines.push('| source | integration_fail_reason | count |');
  lines.push('|---|---|---:|');
  if (integrationFailures.length) {
    for (const row of integrationFailures) {
      lines.push(`| ${row.source} | ${row.reason} | ${Math.trunc(safeNumber(row.count, 0))} |`);
    }
  } else {
    lines.push('| - | - | 0 |');
  }
  lines.push('');
  lines.push('### Risk feature diagnostics');
  lines.push('');
  lines.push(`- top20_distinct_signature_count: ${riskTopDistinctSignatures}`);
  if (constantFeatureWarnings.length) {
    for (const token of constantFeatureWarnings) lines.push(`- WARNING: ${token}`);
  } else {
    lines.push('- no constant risk features detected in current Top20 selection');
  }
  lines.push('');
  lines.push('### Top 20 Risk Samples (heuristic)');
  lines.push('');
  lines.push('| rank | source | sample_hash | risk_score | module_pixels_min | chin_outside_oval_ratio | chin_bottom_band_ratio | nose_outside_oval_ratio | nose_side_band_ratio | chin_touches_oval_bottom | nose_touches_oval_side | leakage_bg_est_mean | fail_reason | reverted_modules |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
  if (externalTopRisk.length) {
    externalTopRisk.forEach((row, index) => {
      lines.push(
        `| ${index + 1} | ${row.source_dataset} | ${row.sample_hash} | ${round3(row.risk_score)} | ${Math.trunc(safeNumber(row.module_pixels_min, 0))} | ${row.chin_outside_oval_ratio == null ? '' : round3(row.chin_outside_oval_ratio)} | ${row.chin_bottom_band_ratio == null ? '' : round3(row.chin_bottom_band_ratio)} | ${row.nose_outside_oval_ratio == null ? '' : round3(row.nose_outside_oval_ratio)} | ${row.nose_side_band_ratio == null ? '' : round3(row.nose_side_band_ratio)} | ${row.chin_touches_oval_bottom ? 1 : 0} | ${row.nose_touches_oval_side ? 1 : 0} | ${row.leakage_bg_est_mean == null ? '' : round3(row.leakage_bg_est_mean)} | ${row.fail_reason || '-'} | ${Array.isArray(row.reverted_modules) && row.reverted_modules.length ? row.reverted_modules.join(',') : '-'} |`,
      );
    });
  } else {
    lines.push('| - | - | - | - | - | - | - | - | - | - | - | - | - | - |');
  }
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- md: \`${toPosix(path.relative(process.cwd(), mdPath))}\``);
  lines.push(`- csv: \`${toPosix(path.relative(process.cwd(), csvPath))}\``);
  lines.push(`- jsonl: \`${toPosix(path.relative(process.cwd(), jsonlPath))}\``);
  lines.push(`- gold_seed: \`reports/gold_seed_${runId}.jsonl\``);
  lines.push('');
  lines.push('- privacy: no image files or absolute paths are stored in these artifacts.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeJsonl(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row));
  await fsp.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeCsv(filePath, rows) {
  const headers = [
    'source',
    'dataset',
    'pipeline_mode_used',
    'sample_hash',
    'ok',
    'fail_reason',
    'reason_detail',
    'decode_ext',
    'decode_magic',
    'decode_error_code',
    'integration_status',
    'integration_fail_reason',
    'status_code',
    'quality_grade',
    'modules_count',
    'module_pixels_min',
    'empty_module_rate',
    'leakage_bg_mean',
    'leakage_bg_est_mean',
    'leakage_hair_mean',
    'chin_leakage_bg',
    'nose_leakage_bg',
    'chin_leakage_bg_est',
    'nose_leakage_bg_est',
    'chin_outside_oval_ratio',
    'nose_outside_oval_ratio',
    'chin_bottom_band_ratio',
    'nose_side_band_ratio',
    'chin_touches_oval_bottom',
    'nose_touches_oval_side',
    'face_detect_ok',
    'landmark_ok',
    'risk_score',
    'degraded_reasons',
    'reverted_modules',
    'note',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          if (header === 'degraded_reasons' || header === 'reverted_modules') {
            return csvEscape(Array.isArray(row[header]) ? row[header].join('|') : '');
          }
          return csvEscape(row[header]);
        })
        .join(','),
    );
  }
  await fsp.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function buildGoldSeedRows(rows, args) {
  const topN = Math.max(1, Math.trunc(parseNumber(args.gold_bucket_topn, DEFAULT_GOLD_BUCKET_TOPN, 1, 200)));
  const pixelThreshold = Math.max(
    1,
    Math.trunc(parseNumber(args.risk_pixels_min_thresh, DEFAULT_RISK_PIXELS_MIN_THRESH, 1, 4096)),
  );
  const byRisk = (items) =>
    [...items].sort((a, b) => {
      const diff = safeNumber(b.risk_score, 0) - safeNumber(a.risk_score, 0);
      if (Math.abs(diff) > 1e-9) return diff;
      return String(a.sample_hash || '').localeCompare(String(b.sample_hash || ''));
    });
  const localOk = rows
    .filter((row) => row && row.ok === true)
    .filter((row) => String(row.pipeline_mode_used || '') === 'local')
    .filter((row) => safeNumber(row.module_pixels_min, 0) > 0);
  const buckets = [
    {
      bucket: 'CHIN_OVERFLOW',
      items: localOk.filter(
        (row) => safeNumber(row.chin_outside_oval_ratio, 0) > args.outside_touch_threshold
          && safeNumber(row.chin_bottom_band_ratio, 0) > args.band_touch_threshold,
      ),
    },
    {
      bucket: 'NOSE_OVERFLOW',
      items: localOk.filter(
        (row) => safeNumber(row.nose_outside_oval_ratio, 0) > args.outside_touch_threshold
          && safeNumber(row.nose_side_band_ratio, 0) > args.band_touch_threshold,
      ),
    },
    {
      bucket: 'SMALL_MODULE',
      items: localOk.filter((row) => safeNumber(row.module_pixels_min, 0) < pixelThreshold),
    },
  ];
  const out = [];
  for (const bucket of buckets) {
    const top = byRisk(bucket.items).slice(0, topN);
    top.forEach((row, index) => {
      out.push({
        bucket: bucket.bucket,
        rank_in_bucket: index + 1,
        source: row.source,
        sample_hash: row.sample_hash,
        risk_score: round3(row.risk_score),
        module_pixels_min: Math.trunc(safeNumber(row.module_pixels_min, 0)),
        chin_outside_oval_ratio: row.chin_outside_oval_ratio == null ? null : round3(row.chin_outside_oval_ratio),
        chin_bottom_band_ratio: row.chin_bottom_band_ratio == null ? null : round3(row.chin_bottom_band_ratio),
        nose_outside_oval_ratio: row.nose_outside_oval_ratio == null ? null : round3(row.nose_outside_oval_ratio),
        nose_side_band_ratio: row.nose_side_band_ratio == null ? null : round3(row.nose_side_band_ratio),
      });
    });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = runTimestampKey();
  const reportDir = path.resolve(args.report_dir);
  const runDir = path.join(reportDir, `.review_pack_mixed_${runId}`);
  const runEvalDir = path.join(runDir, 'fasseg_eval');
  await fsp.mkdir(runEvalDir, { recursive: true });

  const chosenGroup = await resolveChosenGroup({
    reportDir,
    explicitGroup: args.chosen_group,
    explicitReport: args.matrix_report,
  });

  const internalResult = await runPipelineSource({
    source: 'internal',
    config: { dir: args.internal_dir, limit: args.limit_internal },
    args,
    chosenGroup,
  });
  const lapaResult = await runPipelineSource({
    source: 'lapa',
    config: { dir: args.lapa_dir, limit: args.limit_dataset_lapa },
    args,
    chosenGroup,
  });
  const celebaResult = await runPipelineSource({
    source: 'celebamaskhq',
    config: { dir: args.celeba_dir, limit: args.limit_dataset_celeba },
    args,
    chosenGroup,
  });

  let fassegPayload = null;
  let fassegRows = [];
  if (args.limit_dataset_fasseg > 0) {
    fassegPayload = runFassegEval({
      args,
      runDir: runEvalDir,
      chosenGroup,
    });
    const jsonlRel = fassegPayload && fassegPayload.artifacts ? String(fassegPayload.artifacts.jsonl || '') : '';
    if (jsonlRel) {
      const rows = await readJsonlRows(path.resolve(jsonlRel));
      fassegRows = rows.map((row) => toFassegRow(row));
    }
  }

  const gatePass = !fassegPayload
    || (
      safeNumber(fassegPayload.samples_total, 0) > 0
      && safeNumber(fassegPayload.samples_ok, 0) > 0
      && safeNumber(fassegPayload.leakage_bg_mean, 999) <= 0.1
      && safeNumber(fassegPayload.empty_module_rate, 999) <= 0.01
    );

  const mixedRows = [
    ...internalResult.rows,
    ...fassegRows,
    ...lapaResult.rows,
    ...celebaResult.rows,
  ];

  const mdPath = path.join(reportDir, `review_pack_mixed_${runId}.md`);
  const csvPath = path.join(reportDir, `review_pack_mixed_${runId}.csv`);
  const jsonlPath = path.join(reportDir, `review_pack_mixed_${runId}.jsonl`);
  const goldSeedPath = path.join(reportDir, `gold_seed_${runId}.jsonl`);

  await writeJsonl(jsonlPath, mixedRows);
  await writeCsv(csvPath, mixedRows);
  const goldSeedRows = buildGoldSeedRows(mixedRows, args);
  await writeJsonl(goldSeedPath, goldSeedRows);
  const md = renderMd({
    runId,
    args,
    chosenGroup,
    internalResult,
    fassegPayload,
    lapaResult,
    celebaResult,
    mixedRows,
    mdPath,
    csvPath,
    jsonlPath,
    gatePass,
  });
  await fsp.writeFile(mdPath, md, 'utf8');

  const payload = {
    ok: gatePass,
    run_id: runId,
    chosen_group: chosenGroup.group,
    chosen_group_source: chosenGroup.source,
    run_mode: args.run_mode,
    base_explicit: Boolean(args.base_explicit),
    samples_total: mixedRows.length,
    internal_samples: internalResult.summary.samples_total,
    fasseg_samples: fassegRows.length,
    lapa_samples: lapaResult.summary.samples_total,
    celeba_samples: celebaResult.summary.samples_total,
    fasseg_gate: {
      pass: gatePass,
      samples_total: fassegPayload ? Math.trunc(safeNumber(fassegPayload.samples_total, 0)) : null,
      samples_ok: fassegPayload ? Math.trunc(safeNumber(fassegPayload.samples_ok, 0)) : null,
      leakage_bg_mean: fassegPayload ? round3(fassegPayload.leakage_bg_mean) : null,
      empty_module_rate: fassegPayload ? round3(fassegPayload.empty_module_rate) : null,
    },
    artifacts: {
      md: toPosix(path.relative(process.cwd(), mdPath)),
      csv: toPosix(path.relative(process.cwd(), csvPath)),
      jsonl: toPosix(path.relative(process.cwd(), jsonlPath)),
      gold_seed: toPosix(path.relative(process.cwd(), goldSeedPath)),
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!gatePass) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
