#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { Blob } from 'node:buffer';
import {
  assertPrivacySafeText,
  classifyRowErrorKind,
  collectPhotoFiles,
  countBy,
  csvEscape,
  fetchJsonWithRetry,
  mean,
  normalizeLang,
  normalizeMarket,
  parseLooseJson,
  preprocessPhotoBuffer,
  ratio,
  runTimestampKey,
  sanitizeErrorDetail,
  sha256Hex,
  summarizeAnalysisEnvelope,
  toAuroraLangHeader,
  toDistributionRows,
  toIsoUtc,
  toMode,
} from './internal_batch_helpers.mjs';

const DEFAULT_BASE = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_OUT_DIR = 'reports';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRY = 2;
const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_HARD_CARD_RATIO = 0.8;
const DEFAULT_HARD_USED_PHOTOS_RATIO = 0.8;
const DEFAULT_SOFT_DEGRADED_RATIO = 0.3;
const DEFAULT_SOFT_ACTIONS_ZERO_RATIO = 0.2;
const DEFAULT_SOFT_PRODUCTS_ZERO_RATIO = 0.7;
const DEFAULT_REVIEW_FALLBACK_THRESHOLD = 2;

const DEFAULT_ROUTINE = {
  am: [
    { step: 'cleanser', product: 'gentle cleanser' },
    { step: 'moisturizer', product: 'barrier moisturizer' },
    { step: 'sunscreen', product: 'spf 50' },
  ],
  pm: [
    { step: 'cleanser', product: 'gentle cleanser' },
    { step: 'moisturizer', product: 'barrier moisturizer' },
  ],
};

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (token === 'true' || token === '1' || token === 'yes' || token === 'on') return true;
  if (token === 'false' || token === '0' || token === 'no' || token === 'off') return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function trimTrailingSlash(input) {
  return String(input || '').replace(/\/+$/, '');
}

function parseArgs(argv) {
  const out = {
    photosDir: process.env.PHOTOS_DIR || '',
    base: process.env.BASE || DEFAULT_BASE,
    token: process.env.TOKEN || '',
    market: process.env.MARKET || 'US',
    lang: process.env.LANG || 'en',
    mode: process.env.MODE || 'direct',
    concurrency: parseNumber(process.env.CONCURRENCY, DEFAULT_CONCURRENCY, 1, 16),
    limit: parseNumber(process.env.LIMIT, 0, 0, 100000),
    shuffle: parseBoolean(process.env.SHUFFLE, false),
    timeoutMs: parseNumber(process.env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 2000, 120000),
    retry: parseNumber(process.env.RETRY, DEFAULT_RETRY, 0, 5),
    sanitize: parseBoolean(process.env.SANITIZE, true),
    maxEdge: parseNumber(process.env.MAX_EDGE, DEFAULT_MAX_EDGE, 512, 4096),
    outDir: process.env.OUT_DIR || DEFAULT_OUT_DIR,
    failFastOnClaimViolation: parseBoolean(process.env.FAIL_FAST_ON_CLAIM_VIOLATION, false),
    hardCardRatio: parseNumber(process.env.HARD_CARD_RATIO, DEFAULT_HARD_CARD_RATIO, 0, 1),
    hardUsedPhotosRatio: parseNumber(process.env.HARD_USED_PHOTOS_RATIO, DEFAULT_HARD_USED_PHOTOS_RATIO, 0, 1),
    softDegradedRatio: parseNumber(process.env.SOFT_DEGRADED_RATIO, DEFAULT_SOFT_DEGRADED_RATIO, 0, 1),
    softActionsZeroRatio: parseNumber(process.env.SOFT_ACTIONS_ZERO_RATIO, DEFAULT_SOFT_ACTIONS_ZERO_RATIO, 0, 1),
    softProductsZeroRatio: parseNumber(process.env.SOFT_PRODUCTS_ZERO_RATIO, DEFAULT_SOFT_PRODUCTS_ZERO_RATIO, 0, 1),
    reviewFallbackThreshold: parseNumber(
      process.env.REVIEW_FALLBACK_THRESHOLD,
      DEFAULT_REVIEW_FALLBACK_THRESHOLD,
      0,
      20,
    ),
  };

  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (token === '--photos-dir' && next) {
      out.photosDir = next;
      i += 1;
      continue;
    }
    if (token === '--base' && next) {
      out.base = next;
      i += 1;
      continue;
    }
    if (token === '--token' && next) {
      out.token = next;
      i += 1;
      continue;
    }
    if (token === '--market' && next) {
      out.market = next;
      i += 1;
      continue;
    }
    if (token === '--lang' && next) {
      out.lang = next;
      i += 1;
      continue;
    }
    if (token === '--mode' && next) {
      out.mode = next;
      i += 1;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = parseNumber(next, out.concurrency, 1, 16);
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 0, 100000);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeoutMs = parseNumber(next, out.timeoutMs, 2000, 120000);
      i += 1;
      continue;
    }
    if (token === '--retry' && next) {
      out.retry = parseNumber(next, out.retry, 0, 5);
      i += 1;
      continue;
    }
    if (token === '--max-edge' && next) {
      out.maxEdge = parseNumber(next, out.maxEdge, 512, 4096);
      i += 1;
      continue;
    }
    if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
      continue;
    }
    if (token === '--hard-card-ratio' && next) {
      out.hardCardRatio = parseNumber(next, out.hardCardRatio, 0, 1);
      i += 1;
      continue;
    }
    if (token === '--hard-used-photos-ratio' && next) {
      out.hardUsedPhotosRatio = parseNumber(next, out.hardUsedPhotosRatio, 0, 1);
      i += 1;
      continue;
    }
    if (token === '--soft-degraded-ratio' && next) {
      out.softDegradedRatio = parseNumber(next, out.softDegradedRatio, 0, 1);
      i += 1;
      continue;
    }
    if (token === '--soft-actions-zero-ratio' && next) {
      out.softActionsZeroRatio = parseNumber(next, out.softActionsZeroRatio, 0, 1);
      i += 1;
      continue;
    }
    if (token === '--soft-products-zero-ratio' && next) {
      out.softProductsZeroRatio = parseNumber(next, out.softProductsZeroRatio, 0, 1);
      i += 1;
      continue;
    }
    if (token === '--review-fallback-threshold' && next) {
      out.reviewFallbackThreshold = parseNumber(next, out.reviewFallbackThreshold, 0, 20);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
    if (token === '--no-sanitize') {
      out.sanitize = false;
      continue;
    }
    if (token === '--fail_fast_on_claim_violation') {
      out.failFastOnClaimViolation = true;
      continue;
    }
  }

  out.base = trimTrailingSlash(out.base || DEFAULT_BASE);
  out.market = normalizeMarket(out.market);
  out.lang = normalizeLang(out.lang);
  out.mode = toMode(out.mode);
  out.concurrency = Math.trunc(out.concurrency);
  out.limit = Math.trunc(out.limit);
  out.retry = Math.trunc(out.retry);
  out.timeoutMs = Math.trunc(out.timeoutMs);
  out.maxEdge = Math.trunc(out.maxEdge);
  out.reviewFallbackThreshold = Math.trunc(out.reviewFallbackThreshold);
  out.outDir = String(out.outDir || DEFAULT_OUT_DIR).trim() || DEFAULT_OUT_DIR;

  return out;
}

function makeHeaders({ auroraUid, langHeader, token, jsonBody = false }) {
  const headers = {
    Accept: 'application/json',
    'X-Aurora-UID': auroraUid,
    'X-Lang': langHeader,
  };
  if (jsonBody) headers['Content-Type'] = 'application/json';
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-API-Key'] = token;
  }
  return headers;
}

function bestErrorText(response) {
  if (!response) return 'unknown_error';
  if (response.timed_out) return 'request_timeout';
  const errorText = response.error && response.error.message ? String(response.error.message) : '';
  if (errorText) return errorText;

  const json = response.json;
  if (json && typeof json === 'object') {
    const cards = Array.isArray(json.cards) ? json.cards : [];
    for (const card of cards.slice(0, 3)) {
      const payload = card && typeof card.payload === 'object' ? card.payload : {};
      const hit = payload.error || payload.detail || payload.message;
      if (hit) return String(hit);
    }
    if (json.error) return String(json.error);
    if (json.message) return String(json.message);
  }

  if (response.status) return `http_${response.status}`;
  return 'unknown_error';
}

function parsePhotoConfirmCard(json) {
  const parsed = parseLooseJson(JSON.stringify(json || {}));
  if (!parsed || typeof parsed !== 'object') return null;
  const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
  const confirm = cards.find((card) => card && card.type === 'photo_confirm');
  if (!confirm || !confirm.payload || typeof confirm.payload !== 'object') return null;
  const payload = confirm.payload;
  const photoId = String(payload.photo_id || '').trim();
  if (!photoId) return null;
  return {
    photo_id: photoId,
    slot_id: String(payload.slot_id || 'daylight').trim() || 'daylight',
    qc_status: String(payload.qc_status || 'passed').trim().toLowerCase() || 'passed',
  };
}

function isDirectUnsupportedResponse(response) {
  const status = Number(response && response.status ? response.status : 0);
  if (status === 404 || status === 415 || status === 405 || status === 501) return true;
  if (status === 400) {
    const text = JSON.stringify(response && response.json ? response.json : {}).toLowerCase();
    if (text.includes('multipart')) return true;
    if (text.includes('unsupported media type')) return true;
    if (text.includes('content-type')) return true;
  }
  return false;
}

function isConfirmUnsupportedResponse(response) {
  const status = Number(response && response.status ? response.status : 0);
  return status === 404 || status === 405 || status === 501;
}

async function directAnalyze({ base, headers, timeoutMs, retry, imageBuffer, contentType, market, lang }) {
  const form = new FormData();
  const filename = contentType === 'image/png' ? 'photo.png' : 'photo.jpg';
  form.append('file', new Blob([imageBuffer], { type: contentType }), filename);
  form.append('use_photo', 'true');
  form.append('market', String(market || 'US'));
  form.append('lang', String(lang || 'en'));
  form.append('source', 'internal_batch');

  const response = await fetchJsonWithRetry({
    url: `${base}/v1/analysis/skin`,
    method: 'POST',
    headers,
    body: form,
    timeoutMs,
    retry,
  });

  return {
    mode: 'direct',
    stage: 'analysis',
    response,
    upload_response: null,
    confirm_response: null,
  };
}

async function confirmAnalyze({
  base,
  headers,
  timeoutMs,
  retry,
  imageBuffer,
  contentType,
  slotId,
}) {
  const uploadForm = new FormData();
  const filename = contentType === 'image/png' ? 'photo.png' : 'photo.jpg';
  uploadForm.append('slot_id', slotId);
  uploadForm.append('consent', 'true');
  uploadForm.append('photo', new Blob([imageBuffer], { type: contentType }), filename);

  const uploadResponse = await fetchJsonWithRetry({
    url: `${base}/v1/photos/upload`,
    method: 'POST',
    headers,
    body: uploadForm,
    timeoutMs,
    retry,
  });

  if (!uploadResponse.ok) {
    return {
      mode: 'confirm',
      stage: 'upload',
      response: uploadResponse,
      upload_response: uploadResponse,
      confirm_response: null,
    };
  }

  const uploadParsed = parsePhotoConfirmCard(uploadResponse.json);
  if (!uploadParsed || !uploadParsed.photo_id) {
    return {
      mode: 'confirm',
      stage: 'upload_parse',
      response: {
        ...uploadResponse,
        ok: false,
      },
      upload_response: uploadResponse,
      confirm_response: null,
    };
  }

  const confirmResponse = await fetchJsonWithRetry({
    url: `${base}/v1/photos/confirm`,
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ photo_id: uploadParsed.photo_id, slot_id: uploadParsed.slot_id }),
    timeoutMs,
    retry,
  });

  if (!confirmResponse.ok) {
    return {
      mode: 'confirm',
      stage: 'confirm',
      response: confirmResponse,
      upload_response: uploadResponse,
      confirm_response: confirmResponse,
    };
  }

  const confirmParsed = parsePhotoConfirmCard(confirmResponse.json);
  const photoId = (confirmParsed && confirmParsed.photo_id) || uploadParsed.photo_id;
  const qcStatus =
    (confirmParsed && confirmParsed.qc_status) ||
    uploadParsed.qc_status ||
    'passed';

  const analysisResponse = await fetchJsonWithRetry({
    url: `${base}/v1/analysis/skin`,
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      use_photo: true,
      currentRoutine: DEFAULT_ROUTINE,
      photos: [
        {
          photo_id: photoId,
          slot_id: uploadParsed.slot_id || slotId,
          qc_status: qcStatus,
        },
      ],
    }),
    timeoutMs,
    retry,
  });

  return {
    mode: 'confirm',
    stage: 'analysis',
    response: analysisResponse,
    upload_response: uploadResponse,
    confirm_response: confirmResponse,
  };
}

function rowFromAttempt({
  runId,
  market,
  lang,
  modeRequested,
  modeActual,
  response,
  summary,
  preprocess,
  errorDetail,
  stage,
  uploadResponse,
  confirmResponse,
  fallbackNote,
}) {
  const parseOk = Boolean(summary);
  const hasCard = Boolean(summary && summary.has_photo_modules_card);
  const errorKind = classifyRowErrorKind({
    response,
    parseOk,
    hasPhotoModulesCard: hasCard,
  });

  const requestOk = Number(response && response.status ? response.status : 0) >= 200
    && Number(response && response.status ? response.status : 0) < 300;

  return {
    run_id: runId,
    photo_hash: preprocess.photo_hash,
    market,
    lang,
    mode: modeActual,
    mode_requested: modeRequested,
    request_id: summary && summary.request_id ? summary.request_id : null,
    trace_id: summary && summary.trace_id ? summary.trace_id : null,
    used_photos: summary ? summary.used_photos : null,
    analysis_source: summary ? summary.analysis_source : null,
    quality_grade: summary ? summary.quality_grade : null,
    has_photo_modules_card: hasCard,
    regions_count: summary ? summary.regions_count : 0,
    regions_bbox_count: summary ? summary.regions_bbox_count : 0,
    regions_polygon_count: summary ? summary.regions_polygon_count : 0,
    regions_heatmap_count: summary ? summary.regions_heatmap_count : 0,
    modules_count: summary ? summary.modules_count : 0,
    issues_top: summary ? summary.issues_top : [],
    actions_count: summary ? summary.actions_count : 0,
    products_count: summary ? summary.products_count : 0,
    evidence_grade_distribution: summary ? summary.evidence_grade_distribution : null,
    citations_count_distribution: summary ? summary.citations_count_distribution : null,
    claims_template_fallback_count: summary ? summary.claims_template_fallback_count : 'unknown',
    claims_violation_detected: summary ? summary.claims_violation_detected : 'unknown',
    claims_audit_known: summary ? Boolean(summary.claims_audit_known) : false,
    claims_template_fallback_reasons: summary ? summary.claims_template_fallback_reasons : null,
    claims_violation_reasons: summary ? summary.claims_violation_reasons : null,
    product_suppression_reasons: summary ? summary.product_suppression_reasons : [],
    status_code: Number(response && response.status ? response.status : 0),
    request_ok: requestOk,
    error_kind: errorKind,
    error_detail: errorDetail || null,
    stage: stage || null,
    fallback_note: fallbackNote || null,
    duration_ms: Number(response && response.duration_ms ? response.duration_ms : 0),
    upload_status_code: Number(uploadResponse && uploadResponse.status ? uploadResponse.status : 0) || null,
    confirm_status_code: Number(confirmResponse && confirmResponse.status ? confirmResponse.status : 0) || null,
    sanitize_applied: Boolean(preprocess.sanitize_applied),
    original_width: preprocess.original.width,
    original_height: preprocess.original.height,
    processed_width: preprocess.processed.width,
    processed_height: preprocess.processed.height,
    processed_bytes: preprocess.processed.bytes,
  };
}

function mergeDistributionCounter(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] || 0) + Number(value || 0);
  }
}

function sumReasons(rows, key) {
  const out = Object.create(null);
  for (const row of rows) {
    const value = row && row[key] && typeof row[key] === 'object' ? row[key] : null;
    if (!value) continue;
    for (const [reason, count] of Object.entries(value)) {
      out[reason] = (out[reason] || 0) + Number(count || 0);
    }
  }
  return out;
}

function topSuppressionReasons(rows) {
  const counter = Object.create(null);
  for (const row of rows) {
    const reasons = Array.isArray(row && row.product_suppression_reasons) ? row.product_suppression_reasons : [];
    for (const reason of reasons) {
      const key = String(reason || 'unknown').trim() || 'unknown';
      counter[key] = (counter[key] || 0) + 1;
    }
  }
  const items = Object.entries(counter).map(([reason, count]) => ({ reason, count }));
  items.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return items;
}

function table(headers, rows) {
  const line1 = `| ${headers.join(' | ')} |`;
  const line2 = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((value) => String(value == null ? '' : value)).join(' | ')} |`);
  return [line1, line2, ...body].join('\n');
}

function collectManualReviewRows(rows, { productRecEnabled, fallbackThreshold }) {
  const selected = [];

  for (const row of rows) {
    const reasons = [];
    if (row.error_kind === 'NO_CARD') reasons.push('NO_CARD');
    if (row.error_kind && row.error_kind !== 'NO_CARD') reasons.push(row.error_kind);
    if (row.quality_grade === 'degraded' || row.quality_grade === 'fail') reasons.push(`QUALITY_${row.quality_grade.toUpperCase()}`);
    if (Number(row.regions_count || 0) === 0) reasons.push('REGIONS_ZERO');
    if (Number(row.actions_count || 0) === 0) reasons.push('ACTIONS_ZERO');
    if (productRecEnabled && Number(row.products_count || 0) === 0) reasons.push('PRODUCTS_ZERO');
    if (typeof row.claims_template_fallback_count === 'number' && row.claims_template_fallback_count > fallbackThreshold) {
      reasons.push('CLAIMS_FALLBACK_HIGH');
    }
    if (!reasons.length) continue;

    selected.push({
      photo_hash: row.photo_hash,
      reasons,
      quality_grade: row.quality_grade || 'unknown',
      actions_count: row.actions_count,
      products_count: row.products_count,
      claims_template_fallback_count: row.claims_template_fallback_count,
      error_kind: row.error_kind || '',
      score: reasons.length,
    });
  }

  selected.sort((a, b) => b.score - a.score || String(a.photo_hash).localeCompare(String(b.photo_hash)));
  return selected.slice(0, 20);
}

function evaluateGates(rows, config, summary) {
  const hardFailures = [];
  const softWarnings = [];

  if (summary.claimsViolationCount > 0) {
    hardFailures.push(`claims_violation_detected=${summary.claimsViolationCount}`);
  }
  if (summary.hasCardRatio < config.hardCardRatio) {
    hardFailures.push(`photo_modules_card_ratio=${summary.hasCardRatio} < ${config.hardCardRatio}`);
  }
  if (summary.usedPhotosRatio < config.hardUsedPhotosRatio) {
    hardFailures.push(`used_photos_ratio=${summary.usedPhotosRatio} < ${config.hardUsedPhotosRatio}`);
  }

  if (summary.degradedOrFailRatio > config.softDegradedRatio) {
    softWarnings.push(`degraded_or_fail_ratio=${summary.degradedOrFailRatio} > ${config.softDegradedRatio}`);
  }
  if (summary.actionsZeroRatio > config.softActionsZeroRatio) {
    softWarnings.push(`actions_zero_ratio=${summary.actionsZeroRatio} > ${config.softActionsZeroRatio}`);
  }
  if (summary.productRecEnabled && summary.productsZeroRatio > config.softProductsZeroRatio) {
    softWarnings.push(`products_zero_ratio=${summary.productsZeroRatio} > ${config.softProductsZeroRatio}`);
  }

  return {
    hard_pass: hardFailures.length === 0,
    hard_failures: hardFailures,
    soft_warnings: softWarnings,
  };
}

function buildSummary(rows, config, runInfo) {
  const total = rows.length;
  const successCount = rows.filter((row) => row.request_ok).length;
  const hasCardCount = rows.filter((row) => row.has_photo_modules_card).length;
  const usedPhotosCount = rows.filter((row) => row.used_photos === true).length;

  const qualityGrades = rows.map((row) => row.quality_grade || 'unknown');
  const qualityGradeDist = countBy(qualityGrades);

  const degradedOrFailCount = rows.filter((row) => row.quality_grade === 'degraded' || row.quality_grade === 'fail').length;
  const actionsZeroCount = rows.filter((row) => Number(row.actions_count || 0) === 0).length;
  const productsZeroCount = rows.filter((row) => Number(row.products_count || 0) === 0).length;

  const claimsViolationCount = rows.filter((row) => row.claims_violation_detected === true).length;
  const claimsUnknownCount = rows.filter((row) => row.claims_violation_detected === 'unknown').length;
  const claimsFallbackValues = rows
    .map((row) => (typeof row.claims_template_fallback_count === 'number' ? row.claims_template_fallback_count : null))
    .filter((value) => Number.isFinite(value));

  const evidenceGradeCounter = Object.create(null);
  const citationCountCounter = Object.create(null);
  for (const row of rows) {
    mergeDistributionCounter(evidenceGradeCounter, row.evidence_grade_distribution);
    mergeDistributionCounter(citationCountCounter, row.citations_count_distribution);
  }

  const fallbackReasonCounter = sumReasons(rows, 'claims_template_fallback_reasons');
  const violationReasonCounter = sumReasons(rows, 'claims_violation_reasons');

  const productSuppressionTop = topSuppressionReasons(rows);
  const productRecEnabled =
    rows.some((row) => Number(row.products_count || 0) > 0)
    || productSuppressionTop.length > 0
    || parseBoolean(process.env.DIAG_PRODUCT_REC, false);

  const summary = {
    total,
    successCount,
    successRate: ratio(successCount, total),
    hasCardCount,
    hasCardRatio: ratio(hasCardCount, total),
    usedPhotosCount,
    usedPhotosRatio: ratio(usedPhotosCount, total),
    qualityGradeDist,
    degradedOrFailRatio: ratio(degradedOrFailCount, total),
    actionsZeroRatio: ratio(actionsZeroCount, total),
    productsZeroRatio: ratio(productsZeroCount, total),
    claimsViolationCount,
    claimsUnknownCount,
    claimsFallbackMean: mean(claimsFallbackValues),
    claimsFallbackKnownCount: claimsFallbackValues.length,
    evidenceGradeCounter,
    citationCountCounter,
    fallbackReasonCounter,
    violationReasonCounter,
    productSuppressionTop,
    productRecEnabled,
    modeDist: countBy(rows.map((row) => row.mode || 'unknown')),
    errorKindDist: countBy(rows.map((row) => row.error_kind || 'none')),
    regionsMean: mean(rows.map((row) => Number(row.regions_count || 0))),
    modulesMean: mean(rows.map((row) => Number(row.modules_count || 0))),
    actionsMean: mean(rows.map((row) => Number(row.actions_count || 0))),
    productsMean: mean(rows.map((row) => Number(row.products_count || 0))),
    regionsDist: countBy(rows.map((row) => Number(row.regions_count || 0))),
    modulesDist: countBy(rows.map((row) => Number(row.modules_count || 0))),
    actionsDist: countBy(rows.map((row) => Number(row.actions_count || 0))),
    productsDist: countBy(rows.map((row) => Number(row.products_count || 0))),
    runInfo,
  };

  summary.manualReviewRows = collectManualReviewRows(rows, {
    productRecEnabled,
    fallbackThreshold: config.reviewFallbackThreshold,
  });

  summary.gates = evaluateGates(rows, config, summary);
  return summary;
}

function buildMarkdown(rows, summary, config, runInfo, outputPaths) {
  const qualityRows = toDistributionRows(summary.qualityGradeDist)
    .map((item) => [item.key, item.count, ratio(item.count, summary.total)]);

  const modeRows = toDistributionRows(summary.modeDist).map((item) => [item.key, item.count]);
  const errorRows = toDistributionRows(summary.errorKindDist).map((item) => [item.key, item.count]);

  const fallbackReasonRows = toDistributionRows(summary.fallbackReasonCounter).map((item) => [item.key, item.count]);
  const violationReasonRows = toDistributionRows(summary.violationReasonCounter).map((item) => [item.key, item.count]);
  const suppressionRows = summary.productSuppressionTop.slice(0, 10).map((item) => [item.reason, item.count]);

  const evidenceGradeRows = toDistributionRows(summary.evidenceGradeCounter).map((item) => [item.key, item.count]);
  const citationRows = toDistributionRows(summary.citationCountCounter).map((item) => [item.key, item.count]);

  const reviewRows = summary.manualReviewRows.map((item) => [
    item.photo_hash,
    item.reasons.join(','),
    item.quality_grade,
    item.error_kind,
    item.actions_count,
    item.products_count,
    item.claims_template_fallback_count,
  ]);

  const lines = [
    `# Internal Photo Batch Report (${runInfo.runId})`,
    '',
    `- started_at_utc: ${runInfo.startedAt}`,
    `- finished_at_utc: ${runInfo.finishedAt}`,
    `- run_id: ${runInfo.runId}`,
    `- processed_count: ${summary.total}`,
    `- discovered_count: ${runInfo.discoveredCount}`,
    `- selected_count: ${runInfo.selectedCount}`,
    `- aborted_early: ${runInfo.abortedEarly ? 'true' : 'false'}`,
    runInfo.abortReason ? `- abort_reason: ${runInfo.abortReason}` : null,
    '',
    '## 1) 总览',
    '',
    `- 成功率: ${summary.successRate} (${summary.successCount}/${summary.total})`,
    `- used_photos 率: ${summary.usedPhotosRatio} (${summary.usedPhotosCount}/${summary.total})`,
    `- photo_modules_v1 有卡比例: ${summary.hasCardRatio} (${summary.hasCardCount}/${summary.total})`,
    '',
    qualityRows.length
      ? table(['quality_grade', 'count', 'ratio'], qualityRows)
      : '_No quality_grade data._',
    '',
    '## 2) photo_modules_v1 覆盖',
    '',
    `- regions_count 均值: ${summary.regionsMean}`,
    `- modules_count 均值: ${summary.modulesMean}`,
    `- actions_count 均值: ${summary.actionsMean}`,
    `- products_count 均值: ${summary.productsMean}`,
    '',
    table(['metric', 'distribution'], [
      ['regions_count', JSON.stringify(summary.regionsDist)],
      ['modules_count', JSON.stringify(summary.modulesDist)],
      ['actions_count', JSON.stringify(summary.actionsDist)],
      ['products_count', JSON.stringify(summary.productsDist)],
    ]),
    '',
    evidenceGradeRows.length || citationRows.length
      ? table(
          ['evidence_metric', 'distribution'],
          [
            ['evidence_grade_distribution', JSON.stringify(summary.evidenceGradeCounter)],
            ['citations_count_distribution', JSON.stringify(summary.citationCountCounter)],
          ],
        )
      : '_No evidence fields emitted._',
    '',
    '## 3) claims/模板',
    '',
    `- claims_violation_detected=true 数量: ${summary.claimsViolationCount}`,
    `- claims_violation_detected=unknown 数量: ${summary.claimsUnknownCount}`,
    `- claims_template_fallback 均值(仅已知样本): ${summary.claimsFallbackMean}`,
    `- claims_template_fallback 已知样本数: ${summary.claimsFallbackKnownCount}`,
    '',
    fallbackReasonRows.length
      ? table(['fallback_reason', 'count'], fallbackReasonRows)
      : '_No template fallback reasons observed._',
    '',
    violationReasonRows.length
      ? table(['violation_reason', 'count'], violationReasonRows)
      : '_No violation reasons observed._',
    '',
    '## 4) Product Rec',
    '',
    `- product_rec_enabled(推断): ${summary.productRecEnabled ? 'true' : 'false'}`,
    `- emitted(每图 products_count>0): ${rows.filter((row) => Number(row.products_count || 0) > 0).length}`,
    `- suppressed(每图 products_count=0): ${rows.filter((row) => Number(row.products_count || 0) === 0).length}`,
    '',
    suppressionRows.length
      ? table(['suppression_reason', 'count'], suppressionRows)
      : '_Suppression reason unavailable (likely INTERNAL_TEST_MODE off)._',
    '',
    '## 5) Top 20 需要人工复核样本',
    '',
    reviewRows.length
      ? table(
          ['photo_hash', 'reasons', 'quality_grade', 'error_kind', 'actions_count', 'products_count', 'claims_fallback'],
          reviewRows,
        )
      : '_No samples matched manual-review rules._',
    '',
    '## 6) Gate Results',
    '',
    `- hard_gate_pass: ${summary.gates.hard_pass ? 'true' : 'false'}`,
    summary.gates.hard_failures.length
      ? table(['hard_gate_failure'], summary.gates.hard_failures.map((item) => [item]))
      : '_No hard gate failures._',
    '',
    summary.gates.soft_warnings.length
      ? table(['soft_gate_warning'], summary.gates.soft_warnings.map((item) => [item]))
      : '_No soft gate warnings._',
    '',
    '## 7) 运行命令与环境摘要',
    '',
    `- base: ${config.base}`,
    `- market: ${config.market}`,
    `- lang: ${config.lang}`,
    `- mode_requested: ${config.mode}`,
    `- concurrency: ${config.concurrency}`,
    `- limit: ${config.limit || 'all'}`,
    `- shuffle: ${config.shuffle ? 'true' : 'false'}`,
    `- sanitize: ${config.sanitize ? 'true' : 'false'} (max_edge=${config.maxEdge})`,
    `- timeout_ms: ${config.timeoutMs}`,
    `- retry: ${config.retry}`,
    `- fail_fast_on_claim_violation: ${config.failFastOnClaimViolation ? 'true' : 'false'}`,
    `- photos_dir_hash: ${runInfo.photosDirHash}`,
    `- token_present: ${config.token ? 'true' : 'false'}`,
    `- hard thresholds: card_ratio>=${config.hardCardRatio}, used_photos_ratio>=${config.hardUsedPhotosRatio}`,
    `- soft thresholds: degraded_ratio<=${config.softDegradedRatio}, actions_zero_ratio<=${config.softActionsZeroRatio}, products_zero_ratio<=${config.softProductsZeroRatio}`,
    `- artifacts: md=${outputPaths.mdPath}, csv=${outputPaths.csvPath}, jsonl=${outputPaths.jsonlPath}`,
    '',
    '## Additional Distributions',
    '',
    modeRows.length ? table(['mode', 'count'], modeRows) : '_No mode rows._',
    '',
    errorRows.length ? table(['error_kind', 'count'], errorRows) : '_No error rows._',
    '',
  ].filter((line) => line !== null);

  return `${lines.join('\n')}\n`;
}

function buildCsv(rows) {
  const headers = [
    'run_id',
    'photo_hash',
    'market',
    'lang',
    'mode',
    'mode_requested',
    'request_id',
    'trace_id',
    'used_photos',
    'analysis_source',
    'quality_grade',
    'has_photo_modules_card',
    'regions_count',
    'regions_bbox_count',
    'regions_polygon_count',
    'regions_heatmap_count',
    'modules_count',
    'issues_top',
    'actions_count',
    'products_count',
    'evidence_grade_distribution',
    'citations_count_distribution',
    'claims_template_fallback_count',
    'claims_violation_detected',
    'claims_audit_known',
    'product_suppression_reasons',
    'status_code',
    'request_ok',
    'error_kind',
    'error_detail',
    'stage',
    'fallback_note',
    'duration_ms',
    'upload_status_code',
    'confirm_status_code',
    'sanitize_applied',
    'original_width',
    'original_height',
    'processed_width',
    'processed_height',
    'processed_bytes',
  ];

  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map((header) => csvEscape(row[header]));
    lines.push(values.join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function processOnePhoto({
  filePath,
  config,
  runId,
  index,
  total,
  photosDirResolved,
}) {
  const ext = path.extname(filePath).toLowerCase();
  const extraPaths = [photosDirResolved, filePath];

  let raw = null;
  try {
    raw = await fs.readFile(filePath);
  } catch (err) {
    const fallbackHash = sha256Hex(`${filePath}:${Date.now()}:${Math.random()}`).slice(0, 32);
    return {
      run_id: runId,
      photo_hash: fallbackHash,
      market: config.market,
      lang: config.lang,
      mode: config.mode,
      mode_requested: config.mode,
      request_id: null,
      trace_id: null,
      used_photos: null,
      analysis_source: null,
      quality_grade: null,
      has_photo_modules_card: false,
      regions_count: 0,
      regions_bbox_count: 0,
      regions_polygon_count: 0,
      regions_heatmap_count: 0,
      modules_count: 0,
      issues_top: [],
      actions_count: 0,
      products_count: 0,
      evidence_grade_distribution: null,
      citations_count_distribution: null,
      claims_template_fallback_count: 'unknown',
      claims_violation_detected: 'unknown',
      claims_audit_known: false,
      claims_template_fallback_reasons: null,
      claims_violation_reasons: null,
      product_suppression_reasons: [],
      status_code: 0,
      request_ok: false,
      error_kind: 'UNKNOWN',
      error_detail: sanitizeErrorDetail(err && err.message ? err.message : String(err), { extraPaths }),
      stage: 'read_file',
      fallback_note: null,
      duration_ms: 0,
      upload_status_code: null,
      confirm_status_code: null,
      sanitize_applied: config.sanitize,
      original_width: null,
      original_height: null,
      processed_width: null,
      processed_height: null,
      processed_bytes: 0,
    };
  }

  let preprocess = null;
  try {
    preprocess = await preprocessPhotoBuffer({
      inputBuffer: raw,
      extension: ext,
      sanitize: config.sanitize,
      maxEdge: config.maxEdge,
    });
  } catch (err) {
    const code = String(err && err.code ? err.code : err && err.message ? err.message : 'image_preprocess_failed');
    const fallbackHash = sha256Hex(raw).slice(0, 64);
    return {
      run_id: runId,
      photo_hash: fallbackHash,
      market: config.market,
      lang: config.lang,
      mode: config.mode,
      mode_requested: config.mode,
      request_id: null,
      trace_id: null,
      used_photos: null,
      analysis_source: null,
      quality_grade: null,
      has_photo_modules_card: false,
      regions_count: 0,
      regions_bbox_count: 0,
      regions_polygon_count: 0,
      regions_heatmap_count: 0,
      modules_count: 0,
      issues_top: [],
      actions_count: 0,
      products_count: 0,
      evidence_grade_distribution: null,
      citations_count_distribution: null,
      claims_template_fallback_count: 'unknown',
      claims_violation_detected: 'unknown',
      claims_audit_known: false,
      claims_template_fallback_reasons: null,
      claims_violation_reasons: null,
      product_suppression_reasons: [],
      status_code: 0,
      request_ok: false,
      error_kind: 'SCHEMA_FAIL',
      error_detail: sanitizeErrorDetail(code, { extraPaths }),
      stage: 'preprocess',
      fallback_note: null,
      duration_ms: 0,
      upload_status_code: null,
      confirm_status_code: null,
      sanitize_applied: config.sanitize,
      original_width: null,
      original_height: null,
      processed_width: null,
      processed_height: null,
      processed_bytes: raw.length,
    };
  }

  const auroraUid = `internal_batch_${runId}_${String(index + 1).padStart(5, '0')}`;
  const langHeader = toAuroraLangHeader(config.lang);
  const headers = makeHeaders({
    auroraUid,
    langHeader,
    token: config.token,
  });

  const slotId = 'daylight';

  const context = {
    base: config.base,
    headers,
    timeoutMs: config.timeoutMs,
    retry: config.retry,
    imageBuffer: preprocess.buffer,
    contentType: preprocess.processed.content_type,
    market: config.market,
    lang: config.lang,
    slotId,
  };

  let firstAttempt = null;
  let secondAttempt = null;
  let fallbackNote = null;

  if (config.mode === 'direct') {
    firstAttempt = await directAnalyze(context);
    if (isDirectUnsupportedResponse(firstAttempt.response)) {
      secondAttempt = await confirmAnalyze(context);
      fallbackNote = 'direct_unsupported_fallback_to_confirm';
    }
  } else {
    firstAttempt = await confirmAnalyze(context);
    const confirmUnsupported =
      isConfirmUnsupportedResponse(firstAttempt.response)
      || (firstAttempt.stage === 'upload' && isConfirmUnsupportedResponse(firstAttempt.upload_response));
    if (confirmUnsupported) {
      secondAttempt = await directAnalyze(context);
      fallbackNote = 'confirm_unsupported_fallback_to_direct';
    }
  }

  const active = secondAttempt || firstAttempt;
  const response = active.response;
  const summary = response && response.ok && response.json && typeof response.json === 'object'
    ? summarizeAnalysisEnvelope(response.json)
    : null;

  const modeActual = active.mode;
  const errorDetail = sanitizeErrorDetail(bestErrorText(response), { extraPaths });

  const row = rowFromAttempt({
    runId,
    market: config.market,
    lang: config.lang,
    modeRequested: config.mode,
    modeActual,
    response,
    summary,
    preprocess,
    errorDetail,
    stage: active.stage,
    uploadResponse: active.upload_response,
    confirmResponse: active.confirm_response,
    fallbackNote,
  });

  assertPrivacySafeText(JSON.stringify(row), { extraPaths });
  return row;
}

async function runBatch(config) {
  if (!config.photosDir) {
    throw new Error('missing required --photos-dir (or PHOTOS_DIR)');
  }

  const startedAt = toIsoUtc();
  const runId = `internal_batch_${runTimestampKey()}`;
  const collect = await collectPhotoFiles({
    photosDir: config.photosDir,
    limit: config.limit,
    shuffle: config.shuffle,
  });

  if (!collect.files.length) {
    throw new Error('no_photos_found');
  }

  const total = collect.files.length;
  const results = new Array(total);

  let cursor = 0;
  let completed = 0;
  let stopRequested = false;
  let abortReason = '';

  const workerCount = Math.min(config.concurrency, total);

  const worker = async () => {
    while (true) {
      if (stopRequested) return;
      const current = cursor;
      cursor += 1;
      if (current >= total) return;

      const filePath = collect.files[current];
      const row = await processOnePhoto({
        filePath,
        config,
        runId,
        index: current,
        total,
        photosDirResolved: collect.photosDirResolved,
      });

      results[current] = row;
      completed += 1;

      const shortHash = String(row.photo_hash || '').slice(0, 12);
      const msg = [
        `[${completed}/${total}]`,
        `photo=${shortHash}`,
        `mode=${row.mode}`,
        `status=${row.status_code}`,
        `card=${row.has_photo_modules_card ? 'Y' : 'N'}`,
        `err=${row.error_kind || 'none'}`,
      ].join(' ');
      console.log(msg);

      if (config.failFastOnClaimViolation) {
        const hasClaimViolation = row.claims_violation_detected === true;
        const hasTemplateFallback =
          typeof row.claims_template_fallback_count === 'number' && row.claims_template_fallback_count > 0;
        if (hasClaimViolation || hasTemplateFallback) {
          stopRequested = true;
          abortReason = hasClaimViolation
            ? `fail_fast_claims_violation:${row.photo_hash}`
            : `fail_fast_template_fallback:${row.photo_hash}`;
          console.log(`fail-fast triggered: ${abortReason}`);
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const rows = results.filter(Boolean);
  const finishedAt = toIsoUtc();

  const runInfo = {
    runId,
    startedAt,
    finishedAt,
    discoveredCount: collect.totalDiscovered,
    selectedCount: total,
    photosDirHash: collect.photosDirHash,
    abortedEarly: stopRequested,
    abortReason,
  };

  const summary = buildSummary(rows, config, runInfo);

  const outDir = path.resolve(config.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const fileStem = path.join(outDir, runId);
  const jsonlPath = `${fileStem}.jsonl`;
  const csvPath = `${fileStem}.csv`;
  const mdPath = `${fileStem}.md`;

  const jsonlText = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const csvText = buildCsv(rows);
  const markdown = buildMarkdown(rows, summary, config, runInfo, {
    jsonlPath: path.relative(process.cwd(), jsonlPath),
    csvPath: path.relative(process.cwd(), csvPath),
    mdPath: path.relative(process.cwd(), mdPath),
  });

  const extraPaths = [collect.photosDirResolved];
  assertPrivacySafeText(jsonlText, { extraPaths });
  assertPrivacySafeText(csvText, { extraPaths });
  assertPrivacySafeText(markdown, { extraPaths });

  await fs.writeFile(jsonlPath, jsonlText, 'utf8');
  await fs.writeFile(csvPath, csvText, 'utf8');
  await fs.writeFile(mdPath, markdown, 'utf8');

  return {
    runInfo,
    summary,
    output: { jsonlPath, csvPath, mdPath },
  };
}

function printSummary(result) {
  const { runInfo, summary, output } = result;
  console.log('');
  console.log(`run_id=${runInfo.runId}`);
  console.log(`processed=${summary.total} success_rate=${summary.successRate} used_photos_rate=${summary.usedPhotosRatio}`);
  console.log(`photo_modules_card_ratio=${summary.hasCardRatio} hard_gate_pass=${summary.gates.hard_pass}`);
  console.log(`output_md=${path.relative(process.cwd(), output.mdPath)}`);
  console.log(`output_csv=${path.relative(process.cwd(), output.csvPath)}`);
  console.log(`output_jsonl=${path.relative(process.cwd(), output.jsonlPath)}`);

  if (summary.gates.hard_failures.length) {
    console.log(`hard_failures=${summary.gates.hard_failures.join(' | ')}`);
  }
  if (summary.gates.soft_warnings.length) {
    console.log(`soft_warnings=${summary.gates.soft_warnings.join(' | ')}`);
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const result = await runBatch(config);
  printSummary(result);

  if (!result.summary.gates.hard_pass) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  const detail = sanitizeErrorDetail(err && err.message ? err.message : String(err));
  console.error(`internal_batch_run_failed: ${detail}`);
  process.exitCode = 1;
});
