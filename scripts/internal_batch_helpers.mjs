#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const SUPPORTED_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);

const BASE64_RE = /\b[A-Za-z0-9+/]{120,}={0,2}\b/g;
const LOCAL_PATH_RE = /(?:\/Users\/[^\s"'`]+|\/home\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g;
const BBOX_PX_RE = /"bbox_px"\s*:\s*\{[^}]{0,600}\}/g;
const EXIF_KEY_RE = /\b(?:GPSLatitude|GPSLongitude|DateTimeOriginal|Make|Model|LensModel|SerialNumber)\b/gi;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const token = String(value || '').trim().toLowerCase();
  if (token === 'true' || token === '1' || token === 'yes') return true;
  if (token === 'false' || token === '0' || token === 'no') return false;
  return null;
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function runTimestampKey(date = new Date()) {
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${y}${m}${d}_${hh}${mm}${ss}${ms}`;
}

export function normalizeMarket(input) {
  const token = String(input || 'US').trim().toUpperCase();
  if (token === 'EU' || token === 'US') return token;
  return 'US';
}

export function normalizeLang(input) {
  const token = String(input || 'en').trim().toLowerCase();
  if (token === 'zh' || token === 'cn' || token === 'zh-cn') return 'zh';
  return 'en';
}

export function toAuroraLangHeader(lang) {
  return normalizeLang(lang) === 'zh' ? 'CN' : 'EN';
}

export function toMode(input) {
  const token = String(input || 'direct').trim().toLowerCase();
  return token === 'confirm' ? 'confirm' : 'direct';
}

export function shuffleInPlace(list, randomFn = Math.random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomFn() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

async function walkPhotos(dirPath, out) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkPhotos(fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_PHOTO_EXTENSIONS.has(ext)) continue;
    out.push(fullPath);
  }
}

export async function collectPhotoFiles({ photosDir, limit = 0, shuffle = false }) {
  const resolved = path.resolve(String(photosDir || '.'));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`photos_dir_not_found:${resolved}`);
  }

  const files = [];
  await walkPhotos(resolved, files);
  files.sort((a, b) => a.localeCompare(b));
  if (shuffle) shuffleInPlace(files);

  const limited = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? files.slice(0, Math.trunc(Number(limit)))
    : files;

  return {
    photosDirResolved: resolved,
    photosDirHash: sha256Hex(resolved).slice(0, 16),
    files: limited,
    totalDiscovered: files.length,
  };
}

function resolveContentTypeFromFormat(format, extension = '') {
  const token = String(format || '').trim().toLowerCase();
  if (token === 'png') return 'image/png';
  if (token === 'heic' || token === 'heif') return 'image/heic';
  if (token === 'webp') return 'image/webp';
  if (token === 'avif') return 'image/avif';
  if (token === 'jpg' || token === 'jpeg') return 'image/jpeg';

  const ext = String(extension || '').trim().toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  return 'image/jpeg';
}

function chooseOutputFormat(inputFormat, extension = '') {
  const token = String(inputFormat || '').trim().toLowerCase();
  if (token === 'png') return 'png';

  const ext = String(extension || '').trim().toLowerCase();
  if (ext === '.png') return 'png';
  return 'jpeg';
}

function normalizeImageDecodeError(err) {
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  if (msg.includes('unsupported image format')) return 'unsupported_image_format';
  if (msg.includes('heif') || msg.includes('heic')) return 'heic_decode_failed';
  if (msg.includes('input buffer')) return 'invalid_image_buffer';
  return 'image_decode_failed';
}

export async function preprocessPhotoBuffer({
  inputBuffer,
  extension = '',
  sanitize = true,
  maxEdge = 2048,
} = {}) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new Error('input_buffer_required');
  }
  const safeMaxEdge = Math.max(512, Math.min(4096, Math.trunc(Number(maxEdge) || 2048)));

  let metadata = null;
  try {
    metadata = await sharp(inputBuffer, { failOn: 'none' }).metadata();
  } catch (err) {
    const code = normalizeImageDecodeError(err);
    const wrapped = new Error(code);
    wrapped.code = code;
    throw wrapped;
  }

  const original = {
    width: toFiniteNumber(metadata && metadata.width, null),
    height: toFiniteNumber(metadata && metadata.height, null),
    format: String(metadata && metadata.format ? metadata.format : path.extname(extension).slice(1)).toLowerCase() || 'unknown',
    bytes: inputBuffer.length,
    content_type: resolveContentTypeFromFormat(metadata && metadata.format, extension),
  };

  if (!sanitize) {
    return {
      buffer: inputBuffer,
      photo_hash: sha256Hex(inputBuffer),
      original,
      processed: {
        width: original.width,
        height: original.height,
        format: original.format,
        bytes: inputBuffer.length,
        content_type: original.content_type,
      },
      sanitize_applied: false,
    };
  }

  let pipeline = sharp(inputBuffer, { failOn: 'none' }).rotate();
  pipeline = pipeline.resize({
    width: safeMaxEdge,
    height: safeMaxEdge,
    fit: 'inside',
    withoutEnlargement: true,
  });

  const outputFormat = chooseOutputFormat(metadata && metadata.format, extension);
  if (outputFormat === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else {
    pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });
  }

  let output = null;
  try {
    output = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (err) {
    const code = normalizeImageDecodeError(err);
    const wrapped = new Error(code);
    wrapped.code = code;
    throw wrapped;
  }

  const processedBuffer = output && Buffer.isBuffer(output.data) ? output.data : Buffer.alloc(0);
  const processedInfo = output && isObject(output.info) ? output.info : {};
  const processed = {
    width: toFiniteNumber(processedInfo.width, original.width),
    height: toFiniteNumber(processedInfo.height, original.height),
    format: String(processedInfo.format || outputFormat || 'jpeg').toLowerCase(),
    bytes: processedBuffer.length,
    content_type: outputFormat === 'png' ? 'image/png' : 'image/jpeg',
  };

  return {
    buffer: processedBuffer,
    photo_hash: sha256Hex(processedBuffer),
    original,
    processed,
    sanitize_applied: true,
  };
}

export function parseLooseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = raw.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeForPrivacyText(value, { extraPaths = [] } = {}) {
  let out = String(value == null ? '' : value);
  const uniquePaths = Array.from(new Set((extraPaths || []).filter(Boolean).map((item) => String(item))));

  for (const p of uniquePaths.sort((a, b) => b.length - a.length)) {
    out = out.split(p).join('[path]');
  }

  out = out.replace(LOCAL_PATH_RE, '[path]');
  out = out.replace(BASE64_RE, '[base64]');
  out = out.replace(BBOX_PX_RE, '"pixel_bbox_redacted":"[redacted]"');
  out = out.replace(/\bbbox_px\b/gi, 'pixel_bbox_redacted');
  out = out.replace(EXIF_KEY_RE, '[exif_key]');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

export function sanitizeErrorDetail(detail, { extraPaths = [], maxLen = 220 } = {}) {
  const text = typeof detail === 'string'
    ? detail
    : detail == null
      ? ''
      : (() => {
          try {
            return JSON.stringify(detail);
          } catch {
            return String(detail);
          }
        })();
  const cleaned = sanitizeForPrivacyText(text, { extraPaths });
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 3)}...`;
}

export function findPrivacyIssues(text, { extraPaths = [] } = {}) {
  const raw = String(text == null ? '' : text);
  const issues = [];

  const uniquePaths = Array.from(new Set((extraPaths || []).filter(Boolean).map((item) => String(item))));
  if (uniquePaths.some((p) => p && raw.includes(p))) issues.push('path');
  if (LOCAL_PATH_RE.test(raw)) issues.push('local_path_pattern');
  if (BASE64_RE.test(raw)) issues.push('base64');
  if (/\bbbox_px\b/.test(raw)) issues.push('bbox_px');
  if (EXIF_KEY_RE.test(raw)) issues.push('exif_key');
  return issues;
}

export function assertPrivacySafeText(text, { extraPaths = [] } = {}) {
  const issues = findPrivacyIssues(text, { extraPaths });
  if (issues.length) {
    throw new Error(`privacy_violation:${issues.join(',')}`);
  }
}

function responseHeadersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, key) => {
    out[String(key).toLowerCase()] = String(value);
  });
  return out;
}

function shouldRetryStatus(status) {
  return Number(status) >= 500;
}

function classifyFetchError(err) {
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  if (msg.includes('aborted') || msg.includes('timeout')) return 'TIMEOUT';
  return 'UNKNOWN';
}

export async function fetchJsonWithRetry({
  url,
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 30000,
  retry = 2,
} = {}) {
  const maxAttempts = Math.max(1, Math.trunc(Number(retry) || 0) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = Math.max(1000, Math.trunc(Number(timeoutMs) || 30000));
    const timer = setTimeout(() => controller.abort(new Error(`timeout_${timeout}ms`)), timeout);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const json = parseLooseJson(text);
      const status = Number(response.status || 0);
      const headerObj = responseHeadersToObject(response.headers);
      const result = {
        ok: response.ok,
        status,
        headers: headerObj,
        text,
        json,
        timed_out: false,
        duration_ms: Date.now() - startedAt,
      };

      if (!response.ok && shouldRetryStatus(status) && attempt < maxAttempts) {
        await sleep(Math.min(1200, 180 * attempt));
        continue;
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const timeoutKind = classifyFetchError(err);
      if (attempt < maxAttempts && timeoutKind !== 'UNKNOWN') {
        await sleep(Math.min(1200, 180 * attempt));
        continue;
      }
      return {
        ok: false,
        status: 0,
        headers: {},
        text: '',
        json: null,
        timed_out: timeoutKind === 'TIMEOUT',
        duration_ms: Date.now() - startedAt,
        error: err,
      };
    }
  }

  return {
    ok: false,
    status: 0,
    headers: {},
    text: '',
    json: null,
    timed_out: classifyFetchError(lastError) === 'TIMEOUT',
    duration_ms: 0,
    error: lastError,
  };
}

function readEnvelopeLikeRoot(json) {
  if (!isObject(json)) return { root: null, cards: [] };
  const cards = asArray(json.cards);
  if (cards.length) return { root: json, cards };

  if (isObject(json.data) && asArray(json.data.cards).length) {
    return { root: json.data, cards: asArray(json.data.cards) };
  }

  return { root: json, cards: [] };
}

function findCardByType(cards, type) {
  return asArray(cards).find((card) => card && String(card.type || '').trim() === type) || null;
}

function normalizeEvidenceGrade(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'A' || token === 'B' || token === 'C') return token;
  return null;
}

function collectIssueRows(modules) {
  const rows = [];
  for (const module of asArray(modules)) {
    const moduleId = String(module && module.module_id ? module.module_id : '').trim() || 'unknown';
    for (const issue of asArray(module && module.issues)) {
      rows.push({
        module_id: moduleId,
        issue_type: String(issue && issue.issue_type ? issue.issue_type : 'unknown').trim().toLowerCase() || 'unknown',
        severity_0_4: toFiniteNumber(issue && issue.severity_0_4, 0),
        confidence_0_1: toFiniteNumber(issue && issue.confidence_0_1, 0),
      });
    }
  }
  rows.sort((a, b) => (b.severity_0_4 - a.severity_0_4) || (b.confidence_0_1 - a.confidence_0_1));
  return rows;
}

function distributionFromValues(values) {
  const map = Object.create(null);
  for (const value of values) {
    const key = String(value);
    map[key] = (map[key] || 0) + 1;
  }
  return Object.keys(map).length ? map : null;
}

function collectEvidenceEntries(modules) {
  const entries = [];

  for (const module of asArray(modules)) {
    for (const action of asArray(module && module.actions)) {
      const grade = normalizeEvidenceGrade(action && action.evidence_grade);
      const citationCount = toFiniteNumber(
        action && action.citations_count,
        asArray(action && action.citations).length,
      );
      if (grade || Number.isFinite(citationCount)) {
        entries.push({ grade, citations_count: Number.isFinite(citationCount) ? Math.max(0, Math.trunc(citationCount)) : 0 });
      }
    }

    for (const product of asArray(module && module.products)) {
      const evidence = isObject(product && product.evidence) ? product.evidence : {};
      const grade = normalizeEvidenceGrade(evidence.evidence_grade || product.evidence_grade);
      const citationCount = toFiniteNumber(
        evidence.citations_count,
        asArray(evidence.citation_ids).length,
      );
      if (grade || Number.isFinite(citationCount)) {
        entries.push({ grade, citations_count: Number.isFinite(citationCount) ? Math.max(0, Math.trunc(citationCount)) : 0 });
      }
    }
  }

  if (!entries.length) {
    return {
      evidence_grade_distribution: null,
      citations_count_distribution: null,
    };
  }

  return {
    evidence_grade_distribution: distributionFromValues(entries.map((entry) => entry.grade || 'unknown')),
    citations_count_distribution: distributionFromValues(entries.map((entry) => entry.citations_count)),
  };
}

function collectClaimsAudit(modules) {
  let observed = false;
  let fallbackCount = 0;
  let violationDetected = false;
  const fallbackReasons = Object.create(null);
  const violationReasons = Object.create(null);

  const markReason = (target, reason) => {
    const key = String(reason || 'unknown').trim().toLowerCase() || 'unknown';
    target[key] = (target[key] || 0) + 1;
  };

  for (const module of asArray(modules)) {
    for (const issue of asArray(module && module.issues)) {
      const fallback = normalizeBool(issue && issue.explanation_template_fallback);
      const reason = String(issue && issue.explanation_template_reason ? issue.explanation_template_reason : '').trim();
      if (fallback != null || reason) observed = true;
      if (fallback === true) {
        fallbackCount += 1;
        markReason(fallbackReasons, reason || 'unknown');
      }
      if (reason.toLowerCase() === 'banned_terms') {
        violationDetected = true;
        markReason(violationReasons, reason);
      }
      if (asArray(issue && issue.violations).length) {
        violationDetected = true;
        markReason(violationReasons, 'violations_array');
      }
    }

    for (const action of asArray(module && module.actions)) {
      const fallback = normalizeBool(action && action.why_template_fallback);
      const reason = String(action && action.why_template_reason ? action.why_template_reason : '').trim();
      if (fallback != null || reason) observed = true;
      if (fallback === true) {
        fallbackCount += 1;
        markReason(fallbackReasons, reason || 'unknown');
      }
      if (reason.toLowerCase() === 'banned_terms') {
        violationDetected = true;
        markReason(violationReasons, reason);
      }
      if (asArray(action && action.violations).length) {
        violationDetected = true;
        markReason(violationReasons, 'violations_array');
      }
    }

    for (const product of asArray(module && module.products)) {
      const fallback = normalizeBool(product && product.why_match_template_fallback);
      const reason = String(product && product.why_match_template_reason ? product.why_match_template_reason : '').trim();
      if (fallback != null || reason) observed = true;
      if (fallback === true) {
        fallbackCount += 1;
        markReason(fallbackReasons, reason || 'unknown');
      }
      if (reason.toLowerCase() === 'banned_terms') {
        violationDetected = true;
        markReason(violationReasons, reason);
      }
      if (asArray(product && product.violations).length) {
        violationDetected = true;
        markReason(violationReasons, 'violations_array');
      }
    }
  }

  if (!observed) {
    return {
      claims_audit_known: false,
      claims_template_fallback_count: 'unknown',
      claims_violation_detected: 'unknown',
      claims_template_fallback_reasons: null,
      claims_violation_reasons: null,
    };
  }

  return {
    claims_audit_known: true,
    claims_template_fallback_count: fallbackCount,
    claims_violation_detected: violationDetected,
    claims_template_fallback_reasons: Object.keys(fallbackReasons).length ? fallbackReasons : {},
    claims_violation_reasons: Object.keys(violationReasons).length ? violationReasons : {},
  };
}

function collectProductSuppressionReasons(modules) {
  const reasons = [];
  for (const module of asArray(modules)) {
    const internalDebug = isObject(module && module.internal_debug) ? module.internal_debug : null;
    const candidate = String(
      (internalDebug && internalDebug.product_suppressed_reason) ||
        module.product_suppressed_reason ||
        '',
    ).trim();
    if (candidate) reasons.push(candidate);
  }
  return Array.from(new Set(reasons));
}

export function summarizeAnalysisEnvelope(json) {
  const { root, cards } = readEnvelopeLikeRoot(json);
  const analysisCard = findCardByType(cards, 'analysis_summary');
  const photoModulesCard = findCardByType(cards, 'photo_modules_v1');

  const analysisPayload = isObject(analysisCard && analysisCard.payload) ? analysisCard.payload : {};
  const photoPayload = isObject(photoModulesCard && photoModulesCard.payload) ? photoModulesCard.payload : {};

  const modules = asArray(photoPayload.modules);
  const regions = asArray(photoPayload.regions);
  const regionTypeCounts = { bbox: 0, polygon: 0, heatmap: 0 };
  for (const region of regions) {
    const type = String(region && region.type ? region.type : '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(regionTypeCounts, type)) {
      regionTypeCounts[type] += 1;
    }
  }

  const issueRows = collectIssueRows(modules);
  const issuesTop = issueRows.slice(0, 8).map((row) => ({
    module_id: row.module_id,
    issue_type: row.issue_type,
    severity_0_4: row.severity_0_4,
    confidence_0_1: row.confidence_0_1,
  }));

  let actionsCount = 0;
  let productsCount = 0;
  for (const module of modules) {
    actionsCount += asArray(module && module.actions).length;
    productsCount += asArray(module && module.products).length;
  }

  const evidence = collectEvidenceEntries(modules);
  const claims = collectClaimsAudit(modules);
  const suppressionReasons = collectProductSuppressionReasons(modules);

  const qualityFromReport = isObject(analysisPayload.quality_report)
    && isObject(analysisPayload.quality_report.photo_quality)
    ? String(analysisPayload.quality_report.photo_quality.grade || '').trim().toLowerCase()
    : '';
  const qualityGrade = String(photoPayload.quality_grade || qualityFromReport || '').trim().toLowerCase() || null;

  const requestId = String(
    (root && root.request_id) ||
      (isObject(json) && json.request_id) ||
      '',
  ).trim() || null;
  const traceId = String(
    (root && root.trace_id) ||
      (isObject(json) && json.trace_id) ||
      '',
  ).trim() || null;

  return {
    request_id: requestId,
    trace_id: traceId,
    has_analysis_card: Boolean(analysisCard),
    has_photo_modules_card: Boolean(photoModulesCard),
    used_photos: normalizeBool(analysisPayload.used_photos),
    analysis_source: String(analysisPayload.analysis_source || '').trim() || null,
    quality_grade: qualityGrade,
    regions_count: regions.length,
    regions_bbox_count: regionTypeCounts.bbox,
    regions_polygon_count: regionTypeCounts.polygon,
    regions_heatmap_count: regionTypeCounts.heatmap,
    modules_count: modules.length,
    issues_top: issuesTop,
    actions_count: actionsCount,
    products_count: productsCount,
    evidence_grade_distribution: evidence.evidence_grade_distribution,
    citations_count_distribution: evidence.citations_count_distribution,
    claims_audit_known: claims.claims_audit_known,
    claims_template_fallback_count: claims.claims_template_fallback_count,
    claims_violation_detected: claims.claims_violation_detected,
    claims_template_fallback_reasons: claims.claims_template_fallback_reasons,
    claims_violation_reasons: claims.claims_violation_reasons,
    product_suppression_reasons: suppressionReasons,
  };
}

function errorFingerprint(responseJson) {
  if (!isObject(responseJson)) return '';
  const cards = asArray(responseJson.cards);
  const textChunks = [];

  if (cards.length) {
    for (const card of cards.slice(0, 3)) {
      if (!isObject(card)) continue;
      const payload = isObject(card.payload) ? card.payload : {};
      textChunks.push(String(payload.error || ''));
      textChunks.push(String(payload.detail || ''));
      textChunks.push(String(payload.message || ''));
    }
  }

  textChunks.push(String(responseJson.error || ''));
  textChunks.push(String(responseJson.message || ''));
  return textChunks.join(' ').toLowerCase();
}

export function isDirectUnsupportedResponse(response) {
  const status = Number(response && response.status ? response.status : 0);
  if (status === 404 || status === 415 || status === 501 || status === 405) return true;
  if (status === 400) {
    const fingerprint = errorFingerprint(response && response.json);
    if (fingerprint.includes('multipart')) return true;
    if (fingerprint.includes('unsupported media type')) return true;
    if (fingerprint.includes('content-type')) return true;
  }
  return false;
}

export function isConfirmUnsupportedResponse(response) {
  const status = Number(response && response.status ? response.status : 0);
  return status === 404 || status === 405 || status === 501;
}

export function classifyRowErrorKind({
  response,
  parseOk,
  hasPhotoModulesCard,
} = {}) {
  if (response && response.timed_out) return 'TIMEOUT';

  const status = Number(response && response.status ? response.status : 0);
  if (status >= 500) return 'HTTP_5XX';
  if (status >= 400) return 'HTTP_4XX';
  if (status >= 200 && status < 300 && !parseOk) return 'SCHEMA_FAIL';
  if (status >= 200 && status < 300 && parseOk && !hasPhotoModulesCard) return 'NO_CARD';
  if (status === 0 && response && response.error) return 'UNKNOWN';
  return null;
}

export function toDistributionRows(distribution) {
  const out = [];
  if (!isObject(distribution)) return out;
  for (const [key, value] of Object.entries(distribution)) {
    out.push({ key: String(key), count: Number(value) || 0 });
  }
  out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return out;
}

export function mean(values) {
  const nums = asArray(values).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(4));
}

export function ratio(numerator, denominator) {
  const den = Number(denominator);
  if (!Number.isFinite(den) || den <= 0) return 0;
  return Number((Number(numerator || 0) / den).toFixed(4));
}

export function countBy(values) {
  const counter = Object.create(null);
  for (const raw of asArray(values)) {
    const key = String(raw == null ? 'null' : raw);
    counter[key] = (counter[key] || 0) + 1;
  }
  return counter;
}

export function csvEscape(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toIsoUtc(date = new Date()) {
  return new Date(date).toISOString();
}
