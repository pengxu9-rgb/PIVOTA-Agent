#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { Blob } from 'node:buffer';
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

const DEFAULT_BASE = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRY = 2;
const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_SAMPLE_SEED = 'review_pack_seed_v1';
const DEFAULT_MATRIX_BASELINE_GROUP = 'c1_k1';
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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
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

function trimTrailingSlash(input) {
  return String(input || '').replace(/\/+$/, '');
}

function deterministicSort(files, seed) {
  const token = String(seed || DEFAULT_SAMPLE_SEED).trim() || DEFAULT_SAMPLE_SEED;
  return [...files].sort((a, b) => {
    const left = sha256Hex(`${token}:${a}`);
    const right = sha256Hex(`${token}:${b}`);
    if (left === right) return String(a).localeCompare(String(b));
    return left.localeCompare(right);
  });
}

function parseArgs(argv) {
  const out = {
    photo_dir: process.env.PHOTO_DIR || '',
    base_url: process.env.BASE || DEFAULT_BASE,
    token: process.env.TOKEN || '',
    market: process.env.MARKET || 'US',
    lang: process.env.LANG || 'en',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    limit: parseNumber(process.env.LIMIT, DEFAULT_LIMIT, 1, 5000),
    timeout_ms: parseNumber(process.env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120000),
    retry: parseNumber(process.env.RETRY, DEFAULT_RETRY, 0, 5),
    max_edge: parseNumber(process.env.MAX_EDGE, DEFAULT_MAX_EDGE, 512, 4096),
    concurrency: parseNumber(process.env.CONCURRENCY || process.env.EVAL_CONCURRENCY, DEFAULT_CONCURRENCY, 1, 16),
    sample_seed: String(process.env.EVAL_SAMPLE_SEED || process.env.SAMPLE_SEED || DEFAULT_SAMPLE_SEED),
    chosen_group: String(process.env.CHOSEN_GROUP || ''),
    matrix_report: String(process.env.MATRIX_REPORT || ''),
    shuffle: parseBoolean(process.env.SHUFFLE || process.env.EVAL_SHUFFLE, false),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--photo_dir' && next) {
      out.photo_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--base_url' && next) {
      out.base_url = String(next);
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
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 1, 5000);
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
    if (token === '--seed' && next) {
      out.sample_seed = String(next);
      i += 1;
      continue;
    }
    if (token === '--group' && next) {
      out.chosen_group = String(next);
      i += 1;
      continue;
    }
    if (token === '--matrix_report' && next) {
      out.matrix_report = String(next);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
  }

  out.base_url = trimTrailingSlash(out.base_url || DEFAULT_BASE);
  out.market = normalizeMarket(out.market);
  out.lang = normalizeLang(out.lang);
  out.limit = Math.max(1, Math.trunc(out.limit));
  out.retry = Math.max(0, Math.trunc(out.retry));
  out.max_edge = Math.max(512, Math.trunc(out.max_edge));
  out.timeout_ms = Math.max(1000, Math.trunc(out.timeout_ms));
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.sample_seed = String(out.sample_seed || DEFAULT_SAMPLE_SEED).trim() || DEFAULT_SAMPLE_SEED;
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.chosen_group = String(out.chosen_group || '').trim();
  out.matrix_report = String(out.matrix_report || '').trim();
  return out;
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
        const entries = await fs.readdir(root).catch(() => []);
        const candidates = entries
          .filter((name) => /^eval_circle_matrix_\d{8}_\d{6}\.jsonl$/i.test(name))
          .map((name) => path.join(root, name));
        if (!candidates.length) return null;
        const stats = await Promise.all(
          candidates.map(async (filePath) => ({
            filePath,
            mtimeMs: (await fs.stat(filePath)).mtimeMs,
          })),
        );
        stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return stats[0].filePath;
      })();

  if (!reportFile) {
    const fallback = parseGroup(DEFAULT_MATRIX_BASELINE_GROUP);
    return { group: fallback, source: 'fallback_default' };
  }

  const raw = await fs.readFile(reportFile, 'utf8');
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
    source: `matrix:${path.relative(process.cwd(), reportFile).replace(/\\/g, '/')}`,
  };
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

function maskFromPolygon(points, gridSize) {
  const safeGrid = Math.max(32, Math.min(256, Math.trunc(Number(gridSize) || 64)));
  return require('../src/auroraBff/evalAdapters/common/metrics').polygonNormToMask(
    { points, closed: true },
    safeGrid,
    safeGrid,
  );
}

const OVAL_MASK_CACHE = new Map();
function getFaceOvalMask(gridSize) {
  const key = Math.max(32, Math.min(256, Math.trunc(Number(gridSize) || 64)));
  if (OVAL_MASK_CACHE.has(key)) return OVAL_MASK_CACHE.get(key);
  const mask = maskFromPolygon(FACE_OVAL_POLYGON, key);
  OVAL_MASK_CACHE.set(key, mask);
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

function summarizeModules(modules) {
  const rows = [];
  for (const module of Array.isArray(modules) ? modules : []) {
    const decoded = decodeModuleMask(module);
    if (!decoded) continue;
    const faceOvalMask = getFaceOvalMask(decoded.grid);
    const leak = leakageBgProxy(decoded.mask, faceOvalMask);
    rows.push({
      module_id: String(module && module.module_id ? module.module_id : '').trim() || 'unknown',
      leakage_bg: leak.leakage_bg,
      module_pixels: leak.module_pixels,
      grid: decoded.grid,
    });
  }
  const chin = rows.find((row) => row.module_id === 'chin') || null;
  const nose = rows.find((row) => row.module_id === 'nose') || null;
  const leakageValues = rows
    .map((row) => safeNumber(row.leakage_bg, NaN))
    .filter((value) => Number.isFinite(value));
  return {
    modules_count: rows.length,
    module_rows: rows,
    chin_leakage_bg: chin ? safeNumber(chin.leakage_bg, null) : null,
    nose_leakage_bg: nose ? safeNumber(nose.leakage_bg, null) : null,
    leakage_bg_mean: leakageValues.length ? round3(mean(leakageValues)) : null,
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

async function analyzePhoto({
  args,
  group,
  sampleHash,
  imageBuffer,
  contentType,
}) {
  const auroraUid = `review-${sampleHash.slice(0, 16)}`;
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
  form.append('source', 'internal_review_pack');
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
    return {
      ok: false,
      status_code: safeNumber(response && response.status, 0),
      fail_reason: `HTTP_${safeNumber(response && response.status, 0) || 'UNKNOWN'}`,
      degraded_reasons: [],
      reverted_modules: [],
      modules_count: 0,
      chin_leakage_bg: null,
      nose_leakage_bg: null,
      leakage_bg_mean: null,
      note: String(response && response.error && response.error.message ? response.error.message : '').slice(0, 180),
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
      chin_leakage_bg: null,
      nose_leakage_bg: null,
      leakage_bg_mean: null,
      note: '',
    };
  }

  const photoPayload = photoCard.payload;
  const modules = Array.isArray(photoPayload.modules) ? photoPayload.modules : [];
  const moduleSummary = summarizeModules(modules);
  const degradedReasons = parseDegradedReasons(photoPayload);
  const revertedModules = parseRevertedModules([
    photoPayload,
    analysisCard && analysisCard.payload && typeof analysisCard.payload === 'object' ? analysisCard.payload : null,
  ]);

  return {
    ok: true,
    status_code: safeNumber(response.status, 0),
    fail_reason: null,
    degraded_reasons: degradedReasons,
    reverted_modules: revertedModules,
    modules_count: moduleSummary.modules_count,
    chin_leakage_bg: moduleSummary.chin_leakage_bg,
    nose_leakage_bg: moduleSummary.nose_leakage_bg,
    leakage_bg_mean: moduleSummary.leakage_bg_mean,
    module_rows: moduleSummary.module_rows,
    quality_grade: String(photoPayload.quality_grade || '').trim().toLowerCase() || null,
  };
}

function toRow({ sampleHash, result }) {
  const chin = safeNumber(result.chin_leakage_bg, NaN);
  const nose = safeNumber(result.nose_leakage_bg, NaN);
  const risk = Number.isFinite(chin) || Number.isFinite(nose)
    ? Math.max(Number.isFinite(chin) ? chin : 0, Number.isFinite(nose) ? nose : 0)
    : null;
  return {
    sample_hash: sampleHash,
    ok: Boolean(result.ok),
    status_code: safeNumber(result.status_code, 0),
    fail_reason: result.fail_reason || null,
    quality_grade: result.quality_grade || null,
    modules_count: safeNumber(result.modules_count, 0),
    leakage_bg_mean: result.leakage_bg_mean == null ? null : round3(result.leakage_bg_mean),
    chin_leakage_bg: result.chin_leakage_bg == null ? null : round3(result.chin_leakage_bg),
    nose_leakage_bg: result.nose_leakage_bg == null ? null : round3(result.nose_leakage_bg),
    risk_score: risk == null ? null : round3(risk),
    degraded_reasons: Array.isArray(result.degraded_reasons) ? result.degraded_reasons : [],
    reverted_modules: Array.isArray(result.reverted_modules) ? result.reverted_modules : [],
    note: result.note || '',
  };
}

async function writeJsonl(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row));
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeCsv(filePath, rows) {
  const headers = [
    'sample_hash',
    'ok',
    'status_code',
    'fail_reason',
    'quality_grade',
    'modules_count',
    'leakage_bg_mean',
    'chin_leakage_bg',
    'nose_leakage_bg',
    'risk_score',
    'degraded_reasons',
    'reverted_modules',
    'note',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function buildTopRiskRows(rows, limit = 50) {
  return [...rows]
    .filter((row) => row.ok && Number.isFinite(Number(row.risk_score)))
    .sort((a, b) => safeNumber(b.risk_score) - safeNumber(a.risk_score))
    .slice(0, Math.max(0, Math.trunc(limit)));
}

function summarizeRows(rows) {
  const okRows = rows.filter((row) => row.ok);
  const failRows = rows.filter((row) => !row.ok);
  const pick = (key) => okRows.map((row) => safeNumber(row[key], NaN)).filter((n) => Number.isFinite(n));
  const meanP = (values) => round3(mean(values));
  const p50 = (values) => round3(percentile(values, 0.5));
  const p90 = (values) => round3(percentile(values, 0.9));
  return {
    samples_total: rows.length,
    samples_ok: okRows.length,
    samples_failed: failRows.length,
    leakage_bg_mean: meanP(pick('leakage_bg_mean')),
    chin_leakage_bg_mean: meanP(pick('chin_leakage_bg')),
    nose_leakage_bg_mean: meanP(pick('nose_leakage_bg')),
    risk_score_p50: p50(pick('risk_score')),
    risk_score_p90: p90(pick('risk_score')),
    fail_reason_dist: (() => {
      const map = new Map();
      for (const row of failRows) {
        const key = String(row.fail_reason || 'UNKNOWN');
        map.set(key, (map.get(key) || 0) + 1);
      }
      return [...map.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    })(),
    degraded_reason_dist: (() => {
      const map = new Map();
      for (const row of okRows) {
        const list = Array.isArray(row.degraded_reasons) && row.degraded_reasons.length ? row.degraded_reasons : ['-'];
        for (const token of list) {
          map.set(token, (map.get(token) || 0) + 1);
        }
      }
      return [...map.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    })(),
    reverted_module_dist: (() => {
      const map = new Map();
      for (const row of okRows) {
        const list = Array.isArray(row.reverted_modules) && row.reverted_modules.length ? row.reverted_modules : ['-'];
        for (const token of list) {
          map.set(token, (map.get(token) || 0) + 1);
        }
      }
      return [...map.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    })(),
  };
}

function renderMd({ runId, args, chosenGroup, rows, summary, topRisk, mdPath, jsonlPath, csvPath }) {
  const lines = [];
  lines.push('# Internal Photo Review Pack');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- photo_dir_hash: ${sha256Hex(path.resolve(args.photo_dir)).slice(0, 16)}`);
  lines.push(`- sample_seed: ${args.sample_seed}`);
  lines.push(`- limit: ${args.limit}`);
  lines.push(`- base_url: ${args.base_url}`);
  lines.push(`- chosen_group: ${chosenGroup.group.id} (circle=${chosenGroup.group.circle_enabled ? 1 : 0}, calibration=${chosenGroup.group.calibration_enabled ? 1 : 0})`);
  lines.push(`- chosen_group_source: ${chosenGroup.source}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- samples_total: ${summary.samples_total}`);
  lines.push(`- samples_ok: ${summary.samples_ok}`);
  lines.push(`- samples_failed: ${summary.samples_failed}`);
  lines.push(`- leakage_bg_mean (proxy): ${summary.leakage_bg_mean}`);
  lines.push(`- chin_leakage_bg_mean (proxy): ${summary.chin_leakage_bg_mean}`);
  lines.push(`- nose_leakage_bg_mean (proxy): ${summary.nose_leakage_bg_mean}`);
  lines.push(`- risk_score_p50: ${summary.risk_score_p50}`);
  lines.push(`- risk_score_p90: ${summary.risk_score_p90}`);
  lines.push('');

  lines.push('## Failure Reasons');
  lines.push('');
  lines.push('| reason | count |');
  lines.push('|---|---:|');
  if (summary.fail_reason_dist.length) {
    for (const row of summary.fail_reason_dist) lines.push(`| ${row.key} | ${row.count} |`);
  } else {
    lines.push('| - | 0 |');
  }
  lines.push('');

  lines.push('## Degraded Reasons');
  lines.push('');
  lines.push('| reason | count |');
  lines.push('|---|---:|');
  if (summary.degraded_reason_dist.length) {
    for (const row of summary.degraded_reason_dist) lines.push(`| ${row.key} | ${row.count} |`);
  } else {
    lines.push('| - | 0 |');
  }
  lines.push('');

  lines.push('## Reverted Modules');
  lines.push('');
  lines.push('| module | count |');
  lines.push('|---|---:|');
  if (summary.reverted_module_dist.length) {
    for (const row of summary.reverted_module_dist) lines.push(`| ${row.key} | ${row.count} |`);
  } else {
    lines.push('| - | 0 |');
  }
  lines.push('');

  lines.push('## Top 50 Risk Samples (nose/chin leakage_bg desc)');
  lines.push('');
  lines.push('| rank | sample_hash | risk_score | nose_leakage_bg | chin_leakage_bg | modules_count | fail_reason | degraded_reasons | reverted_modules |');
  lines.push('|---:|---|---:|---:|---:|---:|---|---|---|');
  if (topRisk.length) {
    topRisk.forEach((row, index) => {
      lines.push(
        `| ${index + 1} | ${row.sample_hash} | ${row.risk_score} | ${row.nose_leakage_bg ?? ''} | ${row.chin_leakage_bg ?? ''} | ${row.modules_count} | ${row.fail_reason || '-'} | ${Array.isArray(row.degraded_reasons) && row.degraded_reasons.length ? row.degraded_reasons.join(', ') : '-'} | ${Array.isArray(row.reverted_modules) && row.reverted_modules.length ? row.reverted_modules.join(', ') : '-'} |`,
      );
    });
  } else {
    lines.push('| 1 | - | 0 | 0 | 0 | 0 | - | - | - |');
  }
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- md: \`${path.relative(process.cwd(), mdPath).replace(/\\/g, '/')}\``);
  lines.push(`- csv: \`${path.relative(process.cwd(), csvPath).replace(/\\/g, '/')}\``);
  lines.push(`- jsonl: \`${path.relative(process.cwd(), jsonlPath).replace(/\\/g, '/')}\``);
  lines.push('');
  lines.push('- note: leakage_bg values in this pack are proxy metrics computed against face-oval mask (no GT images stored).');
  lines.push('');
  return `${lines.join('\n')}\n`;
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
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => loop());
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.photo_dir) throw new Error('PHOTO_DIR is required (--photo_dir or env PHOTO_DIR)');

  const chosenGroup = await resolveChosenGroup({
    reportDir: args.report_dir,
    explicitGroup: args.chosen_group,
    explicitReport: args.matrix_report,
  });

  const photos = await collectPhotoFiles({
    photosDir: args.photo_dir,
    limit: 0,
    shuffle: false,
  });
  const ordered = deterministicSort(photos.files, args.sample_seed);
  const selected = args.shuffle ? ordered : ordered;
  const files = selected.slice(0, args.limit);

  const rows = await runPool(files, args.concurrency, async (filePath) => {
    const rawBuffer = await fs.readFile(filePath);
    const preprocessed = await preprocessPhotoBuffer({
      inputBuffer: rawBuffer,
      extension: path.extname(filePath),
      sanitize: true,
      maxEdge: args.max_edge,
    });
    const sampleHash = sha256Hex(preprocessed.buffer).slice(0, 20);
    const result = await analyzePhoto({
      args,
      group: chosenGroup.group,
      sampleHash,
      imageBuffer: preprocessed.buffer,
      contentType: preprocessed.processed.content_type || 'image/jpeg',
    });
    return toRow({ sampleHash, result });
  });

  const summary = summarizeRows(rows);
  const topRisk = buildTopRiskRows(rows, 50);
  const runId = runTimestampKey();
  const reportDir = path.resolve(args.report_dir);
  await fs.mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, `review_pack_${runId}.md`);
  const csvPath = path.join(reportDir, `review_pack_${runId}.csv`);
  const jsonlPath = path.join(reportDir, `review_pack_${runId}.jsonl`);

  await writeJsonl(jsonlPath, rows);
  await writeCsv(csvPath, rows);
  const md = renderMd({
    runId,
    args,
    chosenGroup,
    rows,
    summary,
    topRisk,
    mdPath,
    jsonlPath,
    csvPath,
  });
  await fs.writeFile(mdPath, md, 'utf8');

  const payload = {
    ok: true,
    run_id: runId,
    chosen_group: chosenGroup.group,
    chosen_group_source: chosenGroup.source,
    samples_total: summary.samples_total,
    samples_ok: summary.samples_ok,
    samples_failed: summary.samples_failed,
    leakage_bg_mean: summary.leakage_bg_mean,
    chin_leakage_bg_mean: summary.chin_leakage_bg_mean,
    nose_leakage_bg_mean: summary.nose_leakage_bg_mean,
    artifacts: {
      md: path.relative(process.cwd(), mdPath).replace(/\\/g, '/'),
      csv: path.relative(process.cwd(), csvPath).replace(/\\/g, '/'),
      jsonl: path.relative(process.cwd(), jsonlPath).replace(/\\/g, '/'),
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});

