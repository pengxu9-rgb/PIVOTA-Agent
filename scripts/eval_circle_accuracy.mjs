#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Blob } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { getAdapter, listAdapters, normalizeDatasetName } = require('../src/auroraBff/evalAdapters/index');
const {
  normalizeCacheDirs,
  toPosix,
  writeJsonl,
  writeText,
} = require('../src/auroraBff/evalAdapters/common/datasetUtils');
const {
  MODULE_BOXES,
  createMask,
  bboxNormToMask,
  polygonNormToMask,
  resizeHeatmapToMask,
  orMaskInto,
  iouScore,
  coverageScore,
  leakageScore,
  countOnes,
  decodeRleBinary,
  moduleMaskFromBox,
} = require('../src/auroraBff/evalAdapters/common/metrics');
const {
  faceCropFromSkinBBoxNorm,
  deriveGtModulesFromSkinMask,
  saveDerivedGt,
} = require('../src/auroraBff/evalAdapters/common/gtDerivation');
const { runSkinDiagnosisV1, buildSkinAnalysisFromDiagnosisV1 } = require('../src/auroraBff/skinDiagnosisV1');
const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_DATASETS = ['lapa', 'celebamaskhq', 'fasseg'];
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_GRID_SIZE = 128;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MARKET = 'EU';
const DEFAULT_LANG = 'en';

const DEFAULT_MIN_MIOU = Number(process.env.EVAL_MIN_MIOU || 0.65);
const DEFAULT_MAX_FAIL_RATE = Number(process.env.EVAL_MAX_FAIL_RATE || 0.05);
const DEFAULT_MAX_LEAKAGE = Number(process.env.EVAL_MAX_LEAKAGE || 0.1);

function nowRunKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}${ss}`;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
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

function parseArgs(argv) {
  const out = {
    base_url: process.env.BASE_URL || process.env.BASE || '',
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    datasets: process.env.DATASETS || DEFAULT_DATASETS.join(','),
    limit: parseNumber(process.env.LIMIT, 0, 0, 200000),
    shuffle: parseBoolean(process.env.SHUFFLE, false),
    concurrency: parseNumber(process.env.CONCURRENCY, DEFAULT_CONCURRENCY, 1, 16),
    timeout_ms: parseNumber(process.env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120000),
    market: String(process.env.MARKET || DEFAULT_MARKET),
    lang: String(process.env.LANG || DEFAULT_LANG),
    emit_debug_overlays: parseBoolean(process.env.EMIT_DEBUG_OVERLAYS, false),
    token: String(process.env.TOKEN || process.env.API_TOKEN || ''),
    report_dir: process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    grid_size: parseNumber(process.env.GT_GRID_SIZE, DEFAULT_GRID_SIZE, 64, 512),
    eval_min_miou: parseNumber(process.env.EVAL_MIN_MIOU, DEFAULT_MIN_MIOU, 0, 1),
    eval_max_fail_rate: parseNumber(process.env.EVAL_MAX_FAIL_RATE, DEFAULT_MAX_FAIL_RATE, 0, 1),
    eval_max_leakage: parseNumber(process.env.EVAL_MAX_LEAKAGE, DEFAULT_MAX_LEAKAGE, 0, 1),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--base_url' && next) {
      out.base_url = next;
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
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 0, 200000);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = parseNumber(next, out.concurrency, 1, 16);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeout_ms = parseNumber(next, out.timeout_ms, 1000, 120000);
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
    if (token === '--emit_debug_overlays') {
      out.emit_debug_overlays = true;
      continue;
    }
    if (token === '--token' && next) {
      out.token = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = parseNumber(next, out.grid_size, 64, 512);
      i += 1;
      continue;
    }
  }

  out.base_url = String(out.base_url || '').replace(/\/+$/, '');
  out.datasets = parseDatasets(out.datasets);
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.limit = Math.max(0, Math.trunc(out.limit));
  out.timeout_ms = Math.max(1000, Math.trunc(out.timeout_ms));
  out.grid_size = Math.max(64, Math.trunc(out.grid_size));
  out.lang = String(out.lang || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  out.market = String(out.market || 'EU').toUpperCase();
  return out;
}

function parseDatasets(raw) {
  const tokens = String(raw || '')
    .split(',')
    .map((token) => normalizeDatasetName(token))
    .filter(Boolean);
  const deduped = [...new Set(tokens)];
  if (!deduped.length) return [...DEFAULT_DATASETS];
  const unsupported = deduped.filter((name) => !listAdapters().includes(name));
  if (unsupported.length) {
    throw new Error(`unsupported_datasets:${unsupported.join(',')}`);
  }
  return deduped;
}

function hashId(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex').slice(0, 20);
}

function mean(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
  return sum / values.length;
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function sanitizeJsonText(text) {
  const filtered = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 32 || code === 9 || code === 10 || code === 13) filtered.push(text[i]);
  }
  return filtered.join('');
}

function parseLooseJson(text) {
  const raw = String(text || '');
  try {
    return JSON.parse(raw);
  } catch {
    const sanitized = sanitizeJsonText(raw);
    try {
      return JSON.parse(sanitized);
    } catch {
      const start = sanitized.indexOf('{');
      const end = sanitized.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(sanitized.slice(start, end + 1));
      }
      throw new Error('invalid_json_response');
    }
  }
}

function moduleIds() {
  return Object.keys(MODULE_BOXES);
}

function validateBBox(box) {
  if (!box || typeof box !== 'object') return false;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite)) return false;
  if (x < 0 || y < 0 || w < 0 || h < 0) return false;
  if (x + w > 1.001 || y + h > 1.001) return false;
  return true;
}

function validatePolygon(poly) {
  if (!poly || typeof poly !== 'object' || !Array.isArray(poly.points) || poly.points.length < 3) return false;
  return poly.points.every((point) => {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    return Number.isFinite(x) && Number.isFinite(y) && x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001;
  });
}

function validateHeatmap(heatmap) {
  if (!heatmap || typeof heatmap !== 'object') return false;
  const grid = heatmap.grid && typeof heatmap.grid === 'object' ? heatmap.grid : {};
  const w = Number(grid.w);
  const h = Number(grid.h);
  const values = Array.isArray(heatmap.values) ? heatmap.values : [];
  if (w !== 64 || h !== 64 || values.length !== 4096) return false;
  return values.every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1);
}

function regionMaskFromRegion(region, gridSize) {
  const mask = createMask(gridSize, gridSize, 0);
  if (!region || typeof region !== 'object') return { mask, legal: false };

  let legal = true;
  if (region.coord_space !== 'face_crop_norm_v1') legal = false;

  if (region.bbox) {
    legal = validateBBox(region.bbox) && legal;
    const bboxMask = bboxNormToMask(region.bbox, gridSize, gridSize);
    orMaskInto(mask, bboxMask);
  }
  if (region.polygon) {
    legal = validatePolygon(region.polygon) && legal;
    const polygonMask = polygonNormToMask(region.polygon, gridSize, gridSize);
    orMaskInto(mask, polygonMask);
  }
  if (region.heatmap) {
    legal = validateHeatmap(region.heatmap) && legal;
    const grid = region.heatmap.grid || {};
    const intensity = clamp01(region.style && Number(region.style.intensity));
    const heatMask = resizeHeatmapToMask(
      region.heatmap.values || [],
      Number(grid.w || 64),
      Number(grid.h || 64),
      gridSize,
      gridSize,
      0.35,
      intensity || 1,
    );
    orMaskInto(mask, heatMask);
  }

  return { mask, legal };
}

function moduleMasksFromCardPayload(payload, gridSize) {
  const regions = Array.isArray(payload && payload.regions) ? payload.regions : [];
  const modules = Array.isArray(payload && payload.modules) ? payload.modules : [];
  const regionMap = new Map();
  let invalidRegionCount = 0;
  for (const region of regions) {
    const regionId = String(region && region.region_id ? region.region_id : '').trim();
    if (!regionId) continue;
    const built = regionMaskFromRegion(region, gridSize);
    if (!built.legal) invalidRegionCount += 1;
    regionMap.set(regionId, built.mask);
  }

  const moduleMasks = {};
  for (const moduleId of moduleIds()) {
    moduleMasks[moduleId] = createMask(gridSize, gridSize, 0);
  }

  for (const moduleRow of modules) {
    const moduleId = String(moduleRow && moduleRow.module_id ? moduleRow.module_id : '').trim();
    if (!moduleId || !moduleMasks[moduleId]) continue;
    const target = moduleMasks[moduleId];
    const issueRows = Array.isArray(moduleRow && moduleRow.issues) ? moduleRow.issues : [];
    const evidenceIds = new Set();
    for (const issue of issueRows) {
      const ids = Array.isArray(issue && issue.evidence_region_ids) ? issue.evidence_region_ids : [];
      for (const evidenceId of ids) evidenceIds.add(String(evidenceId));
    }
    if (Array.isArray(moduleRow && moduleRow.evidence_region_ids)) {
      for (const evidenceId of moduleRow.evidence_region_ids) evidenceIds.add(String(evidenceId));
    }
    for (const evidenceId of evidenceIds) {
      const regionMask = regionMap.get(String(evidenceId));
      if (regionMask) orMaskInto(target, regionMask);
    }
    if (!countOnes(target) && moduleRow && moduleRow.box && validateBBox(moduleRow.box)) {
      orMaskInto(target, bboxNormToMask(moduleRow.box, gridSize, gridSize));
    }
    if (!countOnes(target)) {
      orMaskInto(target, moduleMaskFromBox(moduleId, gridSize, gridSize));
    }
  }

  return {
    moduleMasks,
    regionsCount: regions.length,
    invalidRegionCount,
  };
}

function decodeGtModuleMasks(derivedGt, gridSize) {
  const out = {};
  const moduleRows = Array.isArray(derivedGt && derivedGt.module_masks) ? derivedGt.module_masks : [];
  for (const moduleId of moduleIds()) {
    const row = moduleRows.find((item) => String(item && item.module_id) === moduleId);
    if (!row || typeof row.mask_rle_norm !== 'string') {
      out[moduleId] = moduleMaskFromBox(moduleId, gridSize, gridSize);
      continue;
    }
    out[moduleId] = decodeRleBinary(row.mask_rle_norm, gridSize * gridSize);
  }
  return out;
}

function skinMaskBoundingNorm(mask, width, height) {
  if (!(mask instanceof Uint8Array) || !width || !height) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return {
    x0: minX / width,
    y0: minY / height,
    x1: (maxX + 1) / width,
    y1: (maxY + 1) / height,
  };
}

function makeApiHeaders({ uid, lang, token } = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Aurora-UID': uid,
    'X-Lang': String(lang || 'EN').toUpperCase().startsWith('ZH') ? 'CN' : 'EN',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-API-Key'] = token;
  }
  return headers;
}

async function callApiPrediction({
  baseUrl,
  imageBuffer,
  sampleToken,
  timeoutMs,
  market,
  lang,
  token,
}) {
  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), `sample_${sampleToken}.jpg`);
  form.append('use_photo', 'true');
  form.append('market', String(market || 'EU'));
  form.append('lang', String(lang || 'en'));
  form.append('source', 'datasets_eval');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/analysis/skin`, {
      method: 'POST',
      headers: makeApiHeaders({ uid: `eval_${sampleToken}`, lang, token }),
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return {
      ok: false,
      reason: message.includes('aborted') ? 'api_timeout' : 'api_network_error',
      status: 0,
      payload: null,
    };
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  let parsed;
  try {
    parsed = parseLooseJson(rawText);
  } catch {
    return {
      ok: false,
      reason: 'api_invalid_json',
      status: response.status,
      payload: null,
    };
  }

  const cards = Array.isArray(parsed && parsed.cards) ? parsed.cards : [];
  const modulesCard = cards.find((card) => card && card.type === 'photo_modules_v1');
  const analysisCard = cards.find((card) => card && card.type === 'analysis_summary');
  if (!modulesCard || !modulesCard.payload || typeof modulesCard.payload !== 'object') {
    return {
      ok: false,
      reason: 'photo_modules_card_missing',
      status: response.status,
      payload: null,
      analysis: analysisCard && analysisCard.payload ? analysisCard.payload : null,
    };
  }

  return {
    ok: response.ok,
    reason: response.ok ? null : `api_status_${response.status}`,
    status: response.status,
    payload: modulesCard.payload,
    analysis: analysisCard && analysisCard.payload ? analysisCard.payload : null,
  };
}

async function callLocalPrediction({ imageBuffer, sampleToken, lang }) {
  const diagnosis = await runSkinDiagnosisV1({
    imageBuffer,
    language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
    profileSummary: null,
    recentLogsSummary: null,
  });
  if (!diagnosis || !diagnosis.ok) {
    return {
      ok: false,
      reason: diagnosis && diagnosis.reason ? diagnosis.reason : 'local_diagnosis_failed',
      payload: null,
      quality: null,
      diagnosisInternal: diagnosis && diagnosis.internal ? diagnosis.internal : null,
      metrics: null,
    };
  }

  const analysis = buildSkinAnalysisFromDiagnosisV1(diagnosis.diagnosis, {
    language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
    profileSummary: null,
  });

  const built = buildPhotoModulesCard({
    requestId: sampleToken,
    analysis,
    usedPhotos: true,
    photoQuality: diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null,
    photoNotice: null,
    diagnosisInternal: diagnosis.internal || null,
    profileSummary: null,
    language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
    ingredientRecEnabled: false,
    productRecEnabled: false,
  });
  if (!built || !built.card || !built.card.payload) {
    return {
      ok: false,
      reason: 'local_photo_modules_missing',
      payload: null,
      quality: diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null,
      diagnosisInternal: diagnosis.internal || null,
      metrics: null,
    };
  }

  return {
    ok: true,
    reason: null,
    payload: built.card.payload,
    quality: diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null,
    diagnosisInternal: diagnosis.internal || null,
    metrics: built.metrics || null,
  };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { ok: false, reason: String(error && error.message ? error.message : error) };
      }
    }
  }
  const runners = [];
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  for (let i = 0; i < n; i += 1) runners.push(runner());
  await Promise.all(runners);
  return results;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function makeSummaryRows(sampleRows) {
  const buckets = new Map();
  for (const sample of sampleRows) {
    if (!sample || !sample.ok || !Array.isArray(sample.module_scores)) continue;
    for (const row of sample.module_scores) {
      const key = `${sample.dataset}::${row.module_id}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
  }
  const out = [];
  for (const [key, rows] of buckets.entries()) {
    const [dataset, moduleId] = key.split('::');
    const ious = rows.map((row) => Number(row.iou || 0));
    const coverages = rows.map((row) => Number(row.coverage || 0));
    const leakages = rows.map((row) => Number(row.leakage || 0));
    out.push({
      dataset,
      module_id: moduleId,
      samples: rows.length,
      miou_mean: round3(mean(ious)),
      miou_p50: round3(percentile(ious, 0.5)),
      miou_p90: round3(percentile(ious, 0.9)),
      coverage_mean: round3(mean(coverages)),
      leakage_mean: round3(mean(leakages)),
    });
  }
  out.sort((a, b) => {
    if (a.dataset !== b.dataset) return a.dataset.localeCompare(b.dataset);
    return a.module_id.localeCompare(b.module_id);
  });
  return out;
}

function makeCsv(rows) {
  const headers = [
    'dataset',
    'module_id',
    'samples',
    'miou_mean',
    'miou_p50',
    'miou_p90',
    'coverage_mean',
    'leakage_mean',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown({
  args,
  runKey,
  sampleRows,
  summaryRows,
  jsonlPath,
  csvPath,
  weakRows,
  softWarnings,
}) {
  const total = sampleRows.length;
  const okRows = sampleRows.filter((row) => row && row.ok);
  const failedRows = sampleRows.filter((row) => !row || !row.ok);
  const faceDetectFails = okRows.filter((row) => row.face_detect_ok === false).length;
  const landmarkFails = okRows.filter((row) => row.landmark_ok === false).length;
  const leakageValues = [];
  const miouValues = [];
  const dropRates = [];
  for (const row of okRows) {
    if (Array.isArray(row.module_scores)) {
      for (const moduleScore of row.module_scores) {
        leakageValues.push(Number(moduleScore.leakage || 0));
        miouValues.push(Number(moduleScore.iou || 0));
      }
    }
    if (Number.isFinite(Number(row.geometry_sanitize_drop_rate))) {
      dropRates.push(Number(row.geometry_sanitize_drop_rate));
    }
  }

  const lines = [];
  lines.push('# Circle Accuracy Evaluation');
  lines.push('');
  lines.push(`- run_id: ${runKey}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- mode: ${args.base_url ? 'api' : 'local'}`);
  lines.push(`- datasets: ${args.datasets.join(', ')}`);
  lines.push(`- samples_total: ${total}`);
  lines.push(`- samples_ok: ${okRows.length}`);
  lines.push(`- samples_failed: ${failedRows.length}`);
  lines.push(`- face_detect_fail_rate: ${round3(total ? faceDetectFails / total : 0)}`);
  lines.push(`- landmark_fail_rate: ${round3(total ? landmarkFails / total : 0)}`);
  lines.push(`- module_mIoU_mean: ${round3(mean(miouValues))}`);
  lines.push(`- leakage_mean: ${round3(mean(leakageValues))}`);
  lines.push(`- geometry_sanitize_drop_rate_mean: ${dropRates.length ? round3(mean(dropRates)) : 'n/a'}`);
  lines.push('');
  lines.push('## Thresholds (soft gate)');
  lines.push('');
  lines.push(`- module_mIoU >= ${args.eval_min_miou}`);
  lines.push(`- face_detect_fail_rate <= ${args.eval_max_fail_rate}`);
  lines.push(`- leakage_mean <= ${args.eval_max_leakage}`);
  lines.push('');

  if (softWarnings.length) {
    lines.push('## Soft Warnings');
    lines.push('');
    for (const warning of softWarnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('## Per-Module Summary');
  lines.push('');
  lines.push('| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const row of summaryRows) {
    lines.push(
      `| ${row.dataset} | ${row.module_id} | ${row.samples} | ${row.miou_mean} | ${row.miou_p50} | ${row.miou_p90} | ${row.coverage_mean} | ${row.leakage_mean} |`,
    );
  }
  lines.push('');

  if (weakRows.length) {
    lines.push('## Weak-Label Datasets');
    lines.push('');
    for (const row of weakRows) {
      lines.push(
        `- ${row.dataset}: samples=${row.samples}, note=${row.note || 'weak_label_only'}, lesion_count_mean=${row.lesion_count_mean == null ? 'n/a' : row.lesion_count_mean}`,
      );
    }
    lines.push('');
  }

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- jsonl: \`${toPosix(path.relative(process.cwd(), jsonlPath))}\``);
  lines.push(`- csv: \`${toPosix(path.relative(process.cwd(), csvPath))}\``);
  if (args.emit_debug_overlays) {
    lines.push(`- debug output: \`outputs/datasets_debug/${runKey}\` (**DO NOT DISTRIBUTE**)`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const cache = normalizeCacheDirs(args.cache_dir);
  const runKey = nowRunKey();
  const reportDir = path.resolve(args.report_dir || DEFAULT_REPORT_DIR);
  await ensureDir(reportDir);
  await ensureDir(cache.derivedGtDir);

  const jsonlPath = path.join(reportDir, `eval_circle_${runKey}.jsonl`);
  const csvPath = path.join(reportDir, `eval_circle_summary_${runKey}.csv`);
  const mdPath = path.join(reportDir, `eval_circle_summary_${runKey}.md`);
  const debugDir = path.join('outputs', 'datasets_debug', runKey);
  if (args.emit_debug_overlays) await ensureDir(debugDir);

  const allSamples = [];
  for (const dataset of args.datasets) {
    const adapter = getAdapter(dataset);
    if (!adapter) throw new Error(`adapter_not_found:${dataset}`);
    const loaded = await adapter.loadSamples({
      repoRoot,
      cacheExternalDir: cache.cacheExternalDir,
      cacheRootDir: cache.cacheRootDir,
      limit: args.limit || undefined,
      shuffle: args.shuffle,
      seed: runKey,
    });
    for (const sample of loaded.samples || []) {
      allSamples.push({
        dataset,
        adapter,
        sample,
      });
    }
  }

  if (!allSamples.length) {
    throw new Error('no_samples_found_after_prepare');
  }

  const sampleRows = await runWithConcurrency(allSamples, args.concurrency, async (entry, index) => {
    const evalSample = entry.adapter.toEvalSample(entry.sample);
    const imageBuffer = await fsp.readFile(evalSample.image_bytes_path);
    const sampleHash = hashId(`${entry.dataset}:${evalSample.sample_id}:${index}`);

    const prediction = args.base_url
      ? await callApiPrediction({
          baseUrl: args.base_url,
          imageBuffer,
          sampleToken: sampleHash,
          timeoutMs: args.timeout_ms,
          market: args.market,
          lang: args.lang,
          token: args.token,
        })
      : await callLocalPrediction({
          imageBuffer,
          sampleToken: sampleHash,
          lang: args.lang,
        });

    if (!prediction.ok || !prediction.payload) {
      return {
        ok: false,
        dataset: entry.dataset,
        sample_hash: sampleHash,
        sample_id: evalSample.sample_id,
        reason: prediction.reason || 'prediction_failed',
      };
    }

    const gtSkin = await entry.adapter.buildSkinMask(evalSample);
    if (!gtSkin || !gtSkin.ok || !(gtSkin.mask instanceof Uint8Array)) {
      return {
        ok: true,
        weak_label_only: true,
        dataset: entry.dataset,
        sample_hash: sampleHash,
        sample_id: evalSample.sample_id,
        reason: gtSkin && gtSkin.reason ? gtSkin.reason : 'weak_label_only',
        note: gtSkin && gtSkin.note ? gtSkin.note : null,
        lesion_count_weak: gtSkin && Number.isFinite(Number(gtSkin.lesion_count_weak)) ? Number(gtSkin.lesion_count_weak) : null,
      };
    }

    const payload = prediction.payload;
    const faceCrop = payload && payload.face_crop && typeof payload.face_crop === 'object' ? payload.face_crop : null;
    const fallbackSkinBbox = skinMaskBoundingNorm(gtSkin.mask, gtSkin.width, gtSkin.height);
    const fallbackFaceCrop = faceCropFromSkinBBoxNorm({
      skinBboxNorm: fallbackSkinBbox,
      imageWidth: gtSkin.width,
      imageHeight: gtSkin.height,
      marginScale: 1.2,
    });
    const resolvedFaceCrop = faceCrop || {
      coord_space: 'orig_px_v1',
      bbox_px: fallbackFaceCrop,
      orig_size_px: { w: gtSkin.width, h: gtSkin.height },
      render_size_px_hint: { w: 512, h: 512 },
    };

    const derivedGt = deriveGtModulesFromSkinMask({
      skinMaskImage: {
        mask: gtSkin.mask,
        width: gtSkin.width,
        height: gtSkin.height,
      },
      imageWidth: gtSkin.width,
      imageHeight: gtSkin.height,
      faceCropBox: resolvedFaceCrop,
      gridSize: args.grid_size,
      moduleIds: moduleIds(),
    });
    const derivedPayload = {
      schema_version: 'aurora.eval.derived_gt.v1',
      dataset: entry.dataset,
      sample_id: evalSample.sample_id,
      sample_hash: sampleHash,
      generated_at: new Date().toISOString(),
      ...derivedGt,
    };
    const derivedPath = saveDerivedGt(cache.cacheRootDir, entry.dataset, evalSample.sample_id, derivedPayload);

    const gtModuleMasks = decodeGtModuleMasks(derivedGt, args.grid_size);
    const gtSkinMaskNorm = decodeRleBinary(derivedGt.skin_mask_rle_norm, args.grid_size * args.grid_size);
    const predicted = moduleMasksFromCardPayload(payload, args.grid_size);

    const moduleScores = [];
    for (const moduleId of moduleIds()) {
      const predMask = predicted.moduleMasks[moduleId];
      const gtMask = gtModuleMasks[moduleId];
      const gtPixels = countOnes(gtMask);
      if (!gtPixels) continue;
      moduleScores.push({
        module_id: moduleId,
        iou: round3(iouScore(predMask, gtMask)),
        coverage: round3(coverageScore(predMask, gtMask)),
        leakage: round3(leakageScore(predMask, gtSkinMaskNorm)),
        pred_pixels: countOnes(predMask),
        gt_pixels: gtPixels,
      });
    }

    const geometryDropRows = Array.isArray(prediction.metrics && prediction.metrics.geometryDropCounts)
      ? prediction.metrics.geometryDropCounts
      : [];
    const dropped = geometryDropRows.reduce((acc, row) => acc + Number(row && row.count ? row.count : 0), 0);
    const geometrySanitizeDropRate = round3(dropped / Math.max(1, dropped + Number(predicted.regionsCount || 0)));
    const faceDetectOk = Boolean(payload && payload.face_crop && payload.face_crop.bbox_px);

    const row = {
      ok: true,
      dataset: entry.dataset,
      sample_hash: sampleHash,
      sample_id: evalSample.sample_id,
      module_scores: moduleScores,
      quality_grade: String(payload && payload.quality_grade ? payload.quality_grade : ''),
      regions_count: Number(predicted.regionsCount || 0),
      invalid_region_count: Number(predicted.invalidRegionCount || 0),
      face_detect_ok: faceDetectOk,
      landmark_ok: faceDetectOk,
      geometry_sanitize_drop_rate: Number.isFinite(geometrySanitizeDropRate) ? geometrySanitizeDropRate : null,
      weak_label_only: false,
      derived_gt_path: toPosix(path.relative(repoRoot, derivedPath)),
      source_mode: args.base_url ? 'api' : 'local',
    };

    if (args.emit_debug_overlays) {
      const debugPath = path.join(debugDir, `${entry.dataset}_${sampleHash}.json`);
      await fsp.mkdir(path.dirname(debugPath), { recursive: true });
      await fsp.writeFile(
        debugPath,
        `${JSON.stringify({
          warning: 'DO NOT DISTRIBUTE',
          dataset: entry.dataset,
          sample_hash: sampleHash,
          module_scores: moduleScores,
          quality_grade: row.quality_grade,
          regions_count: row.regions_count,
        }, null, 2)}\n`,
        'utf8',
      );
      row.debug_path = toPosix(path.relative(repoRoot, debugPath));
    }

    return row;
  });

  writeJsonl(jsonlPath, sampleRows);

  const summaryRows = makeSummaryRows(sampleRows);
  writeText(csvPath, makeCsv(summaryRows));

  const weakBuckets = new Map();
  for (const row of sampleRows) {
    if (!row || !row.weak_label_only) continue;
    if (!weakBuckets.has(row.dataset)) weakBuckets.set(row.dataset, []);
    weakBuckets.get(row.dataset).push(row);
  }
  const weakRows = [];
  for (const [dataset, rows] of weakBuckets.entries()) {
    const lesionValues = rows
      .map((row) => (Number.isFinite(Number(row.lesion_count_weak)) ? Number(row.lesion_count_weak) : null))
      .filter((value) => value != null);
    weakRows.push({
      dataset,
      samples: rows.length,
      lesion_count_mean: lesionValues.length ? round3(mean(lesionValues)) : null,
      note: rows[0] && rows[0].note ? rows[0].note : 'weak_label_only',
    });
  }
  weakRows.sort((a, b) => a.dataset.localeCompare(b.dataset));

  const okRows = sampleRows.filter((row) => row && row.ok && !row.weak_label_only);
  const miouValues = [];
  const leakageValues = [];
  for (const row of okRows) {
    for (const moduleScore of row.module_scores || []) {
      miouValues.push(Number(moduleScore.iou || 0));
      leakageValues.push(Number(moduleScore.leakage || 0));
    }
  }
  const faceDetectFailRate = okRows.length
    ? okRows.filter((row) => row.face_detect_ok === false).length / okRows.length
    : 0;
  const miouMean = mean(miouValues);
  const leakageMean = mean(leakageValues);

  const softWarnings = [];
  if (miouMean < args.eval_min_miou) {
    softWarnings.push(`module_mIoU ${round3(miouMean)} < threshold ${args.eval_min_miou}`);
  }
  if (faceDetectFailRate > args.eval_max_fail_rate) {
    softWarnings.push(`face_detect_fail_rate ${round3(faceDetectFailRate)} > threshold ${args.eval_max_fail_rate}`);
  }
  if (leakageMean > args.eval_max_leakage) {
    softWarnings.push(`leakage_mean ${round3(leakageMean)} > threshold ${args.eval_max_leakage}`);
  }

  const markdown = renderMarkdown({
    args,
    runKey,
    sampleRows,
    summaryRows,
    jsonlPath,
    csvPath,
    weakRows,
    softWarnings,
  });
  writeText(mdPath, markdown);

  const payload = {
    ok: true,
    run_id: runKey,
    mode: args.base_url ? 'api' : 'local',
    datasets: args.datasets,
    samples_total: sampleRows.length,
    samples_ok: sampleRows.filter((row) => row && row.ok).length,
    samples_failed: sampleRows.filter((row) => !row || !row.ok).length,
    weak_label_samples: sampleRows.filter((row) => row && row.weak_label_only).length,
    module_miou_mean: round3(miouMean),
    leakage_mean: round3(leakageMean),
    face_detect_fail_rate: round3(faceDetectFailRate),
    soft_warnings: softWarnings,
    artifacts: {
      jsonl: toPosix(path.relative(repoRoot, jsonlPath)),
      csv: toPosix(path.relative(repoRoot, csvPath)),
      md: toPosix(path.relative(repoRoot, mdPath)),
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((error) => {
  const message = String(error && error.stack ? error.stack : error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
