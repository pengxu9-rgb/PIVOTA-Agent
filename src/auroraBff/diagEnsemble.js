const OpenAI = require('openai');
const { z } = require('zod');
const { extractJsonObject, parseJsonOnlyObject } = require('./jsonExtract');
const { persistPseudoLabelArtifacts } = require('./pseudoLabelFactory');
const {
  normalizeQualityFeatures,
  calibrateConfidence,
  resolveProviderWeight,
  smoothSeverity,
  loadCalibrationRuntime,
} = require('./diagCalibration');

const CANONICAL_SCHEMA_VERSION = 'aurora.diagnosis_canonical.v1';
const CANONICAL_TYPES = Object.freeze([
  'redness',
  'acne',
  'shine',
  'texture',
  'tone',
  'dryness',
  'barrier',
  'other',
]);
const QUALITY_SENSITIVITY = Object.freeze(['low', 'medium', 'high']);

const TYPE_ALIASES = Object.freeze({
  redness: 'redness',
  irritation: 'redness',
  erythema: 'redness',
  acne: 'acne',
  breakout: 'acne',
  breakouts: 'acne',
  pimple: 'acne',
  shine: 'shine',
  oiliness: 'shine',
  sebum: 'shine',
  pores: 'texture',
  texture: 'texture',
  roughness: 'texture',
  dark_spots: 'tone',
  tone: 'tone',
  uneven_tone: 'tone',
  hyperpigmentation: 'tone',
  dryness: 'dryness',
  flaking: 'dryness',
  dehydration: 'dryness',
  barrier: 'barrier',
  barrier_stress: 'barrier',
  sensitivity: 'barrier',
});

const PROVIDER_BASE_WEIGHT = Object.freeze({
  cv_provider: 0.7,
  gemini_provider: 1.0,
  gpt_provider: 1.05,
});

const MODEL_RELIABILITY = Object.freeze({
  redness: { pass: 0.9, degraded: 0.8, fail: 0.55, unknown: 0.7 },
  acne: { pass: 0.82, degraded: 0.7, fail: 0.52, unknown: 0.65 },
  shine: { pass: 0.8, degraded: 0.75, fail: 0.55, unknown: 0.66 },
  texture: { pass: 0.78, degraded: 0.66, fail: 0.5, unknown: 0.62 },
  tone: { pass: 0.72, degraded: 0.52, fail: 0.42, unknown: 0.56 },
  dryness: { pass: 0.75, degraded: 0.64, fail: 0.48, unknown: 0.58 },
  barrier: { pass: 0.7, degraded: 0.6, fail: 0.45, unknown: 0.55 },
  other: { pass: 0.6, degraded: 0.55, fail: 0.4, unknown: 0.5 },
});

const BBoxSchema = z.object({
  x0: z.number().min(0).max(1),
  y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
});

const PolygonPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const RegionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bbox'), bbox_norm: BBoxSchema }),
  z.object({ kind: z.literal('polygon'), points: z.array(PolygonPointSchema).min(3).max(96) }),
  z.object({
    kind: z.literal('heatmap'),
    rows: z.number().int().min(1).max(64),
    cols: z.number().int().min(1).max(64),
    values: z.array(z.number().min(0).max(1)).max(4096),
  }),
]);

const ConcernSchema = z.object({
  type: z.enum(CANONICAL_TYPES),
  regions: z.array(RegionSchema).min(1).max(6),
  severity: z.number().min(0).max(4),
  confidence: z.number().min(0).max(1),
  evidence_text: z.string().trim().min(1).max(500),
  quality_sensitivity: z.enum(QUALITY_SENSITIVITY),
  source_model: z.string().trim().min(1),
  provenance: z
    .object({
      provider: z.string().trim().min(1).optional(),
      source_ids: z.array(z.string().trim().min(1)).max(12).optional(),
      reviewer: z.string().trim().min(1).optional(),
      weak_match: z.boolean().optional(),
      notes: z.array(z.string().trim().min(1)).max(10).optional(),
    })
    .passthrough(),
  uncertain: z.boolean().optional(),
});

const CanonicalSchema = z.object({
  schema_version: z.literal(CANONICAL_SCHEMA_VERSION),
  concerns: z.array(ConcernSchema).max(64),
  conflicts: z
    .array(
      z.object({
        conflict_id: z.string().trim().min(1),
        kind: z.enum(['type_disagreement', 'region_disagreement', 'severity_disagreement']),
        type: z.enum(CANONICAL_TYPES).optional(),
        severity: z.number().min(0).max(1),
        message: z.string().trim().min(1).max(280),
        providers: z.array(z.string().trim().min(1)).max(6),
      }),
    )
    .max(32)
    .default([]),
  provider_stats: z
    .array(
      z.object({
        provider: z.string().trim().min(1),
        ok: z.boolean(),
        latency_ms: z.number().min(0),
        concern_count: z.number().int().min(0),
        schema_failed: z.boolean().optional(),
        failure_reason: z.string().trim().min(1).optional(),
      }),
    )
    .max(8)
    .optional(),
  agreement_score: z.number().min(0).max(1).optional(),
});

const ProviderConcernSchema = z.object({
  type: z.string().trim().min(1),
  regions: z.array(RegionSchema).min(1).max(6),
  severity: z.number().min(0).max(4).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence_text: z.string().trim().min(1).max(500).optional(),
  quality_sensitivity: z.string().trim().optional(),
  source_model: z.string().trim().optional(),
  provenance: z.record(z.any()).optional(),
  uncertain: z.boolean().optional(),
});

const ProviderPayloadSchema = z.object({
  concerns: z.array(ProviderConcernSchema).max(64),
  flags: z.array(z.string().trim().min(1)).max(20).optional(),
  review: z.string().trim().min(1).optional(),
});

let openaiClient = null;

function boolEnv(name, fallback) {
  const raw = String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numEnv(name, fallback, min, max) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(1, Number(value)));
}

function clampSeverity(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(4, Number(value)));
}

function round3(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Number(Number(value).toFixed(3));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timeout after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseURL = String(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '').trim();
  openaiClient = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  return openaiClient;
}

function normalizeConcernType(rawType) {
  const raw = String(rawType || '').trim().toLowerCase();
  if (!raw) return 'other';
  if (Object.prototype.hasOwnProperty.call(TYPE_ALIASES, raw)) return TYPE_ALIASES[raw];
  return 'other';
}

function normalizeQualitySensitivity(raw, qualityGrade) {
  const token = String(raw || '').trim().toLowerCase();
  if (QUALITY_SENSITIVITY.includes(token)) return token;
  if (qualityGrade === 'fail') return 'high';
  if (qualityGrade === 'degraded') return 'medium';
  return 'low';
}

function normalizeBBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x0 = clamp01(raw.x0);
  const y0 = clamp01(raw.y0);
  const x1 = clamp01(raw.x1);
  const y1 = clamp01(raw.y1);
  const minX = Math.min(x0, x1);
  const minY = Math.min(y0, y1);
  const maxX = Math.max(x0, x1);
  const maxY = Math.max(y0, y1);
  if (maxX - minX <= 0.001 || maxY - minY <= 0.001) return null;
  return { x0: round3(minX), y0: round3(minY), x1: round3(maxX), y1: round3(maxY) };
}

function bboxFromPolygon(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    if (!point || typeof point !== 'object') continue;
    const x = clamp01(point.x);
    const y = clamp01(point.y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX - minX <= 0.001 || maxY - minY <= 0.001) return null;
  return { x0: round3(minX), y0: round3(minY), x1: round3(maxX), y1: round3(maxY) };
}

function bboxFromHeatmap(heatmap) {
  if (!heatmap || typeof heatmap !== 'object') return null;
  const rows = Number(heatmap.rows);
  const cols = Number(heatmap.cols);
  const values = Array.isArray(heatmap.values) ? heatmap.values : [];
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows <= 0 || cols <= 0) return null;
  if (values.length !== rows * cols) return null;

  let maxValue = 0;
  for (const value of values) maxValue = Math.max(maxValue, clamp01(value));
  if (maxValue <= 0.001) return null;

  const threshold = maxValue * 0.4;
  let minRow = rows;
  let minCol = cols;
  let maxRow = -1;
  let maxCol = -1;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = clamp01(values[row * cols + col]);
      if (value < threshold) continue;
      minRow = Math.min(minRow, row);
      minCol = Math.min(minCol, col);
      maxRow = Math.max(maxRow, row);
      maxCol = Math.max(maxCol, col);
    }
  }
  if (maxRow < 0 || maxCol < 0) return null;
  return normalizeBBox({
    x0: minCol / cols,
    y0: minRow / rows,
    x1: (maxCol + 1) / cols,
    y1: (maxRow + 1) / rows,
  });
}

function primaryBBoxFromConcern(concern) {
  const regions = Array.isArray(concern?.regions) ? concern.regions : [];
  for (const region of regions) {
    if (!region || typeof region !== 'object') continue;
    if (region.kind === 'bbox' && region.bbox_norm) {
      const normalized = normalizeBBox(region.bbox_norm);
      if (normalized) return normalized;
    }
    if (region.kind === 'polygon' && Array.isArray(region.points)) {
      const fromPolygon = bboxFromPolygon(region.points);
      if (fromPolygon) return fromPolygon;
    }
    if (region.kind === 'heatmap') {
      const fromHeatmap = bboxFromHeatmap(region);
      if (fromHeatmap) return fromHeatmap;
    }
  }
  return null;
}

function iou(a, b) {
  if (!a || !b) return 0;
  const xA = Math.max(a.x0, b.x0);
  const yA = Math.max(a.y0, b.y0);
  const xB = Math.min(a.x1, b.x1);
  const yB = Math.min(a.y1, b.y1);
  const intersection = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  if (intersection <= 0) return 0;
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const union = areaA + areaB - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function ensureJsonObject(rawText) {
  if (typeof rawText !== 'string') return null;
  const parsedStrict = parseJsonOnlyObject(rawText);
  if (parsedStrict) return parsedStrict;
  return extractJsonObject(rawText);
}

function extractTextFromGeminiResponse(response) {
  if (!response) return '';
  if (typeof response.text === 'string' && response.text.trim()) return response.text.trim();
  const candidates = response.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) return part.text.trim();
    }
  }
  return '';
}

function safeStringify(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function summarizeSchemaError(detail) {
  const raw = safeStringify(detail || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  return raw.slice(0, 120);
}

function containsQuotaHint(text) {
  const token = String(text || '').toLowerCase();
  return (
    token.includes('quota') ||
    token.includes('insufficient_quota') ||
    token.includes('resource_exhausted') ||
    token.includes('billing') ||
    token.includes('monthly limit')
  );
}

function containsImageInvalidHint(text) {
  const token = String(text || '').toLowerCase();
  return (
    token.includes('image') ||
    token.includes('unsupported mime') ||
    token.includes('mime') ||
    token.includes('invalid argument') ||
    token.includes('too large') ||
    token.includes('payload too large') ||
    token.includes('decode') ||
    token.includes('corrupt')
  );
}

function inferHttpStatusClass(statusCode, reason) {
  const code = Number.isFinite(Number(statusCode)) ? Math.trunc(Number(statusCode)) : 0;
  const token = String(reason || '').toUpperCase();
  if (token.includes('TIMEOUT')) return 'timeout';
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500 && code < 600) return '5xx';
  return 'unknown';
}

function classifyProviderFailureMeta(error) {
  const statusCode =
    (Number.isFinite(Number(error?.status)) && Number(error.status)) ||
    (Number.isFinite(Number(error?.statusCode)) && Number(error.statusCode)) ||
    (Number.isFinite(Number(error?.response?.status)) && Number(error.response.status)) ||
    null;
  const errorCode = String(error?.code || '').trim();
  const errorName = String(error?.name || '').trim();
  const responseBody =
    (typeof error?.response?.data === 'string' && error.response.data) ||
    (error?.response?.data != null ? safeStringify(error.response.data) : '') ||
    '';
  const message = String(error?.message || '').trim();
  const text = `${message} ${responseBody}`.trim().toLowerCase();

  const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'EPROTO']);
  const isTimeout =
    errorName === 'AbortError' ||
    errorCode === 'ETIMEDOUT' ||
    /timed out|timeout|econnaborted|etimedout/.test(text);
  const isNetwork =
    networkCodes.has(errorCode) ||
    /enotfound|eai_again|dns|socket hang up|tls|certificate|self signed/.test(text);

  let reason = 'VISION_UNKNOWN';
  if (isTimeout || statusCode === 408) {
    reason = 'VISION_TIMEOUT';
  } else if (isNetwork) {
    reason = 'VISION_NETWORK_ERROR';
  } else if (statusCode === 401) {
    reason = 'VISION_MISSING_KEY';
  } else if (statusCode === 403) {
    reason = /api key|credential|permission|forbidden|auth/.test(text)
      ? 'VISION_MISSING_KEY'
      : 'VISION_UPSTREAM_4XX';
  } else if (statusCode === 429) {
    reason = containsQuotaHint(text) ? 'VISION_QUOTA_EXCEEDED' : 'VISION_RATE_LIMITED';
  } else if (Number.isFinite(Number(statusCode)) && statusCode >= 500) {
    reason = 'VISION_UPSTREAM_5XX';
  } else if (Number.isFinite(Number(statusCode)) && statusCode >= 400) {
    reason = containsImageInvalidHint(text) ? 'VISION_IMAGE_INVALID' : 'VISION_UPSTREAM_4XX';
  } else if (containsQuotaHint(text)) {
    reason = 'VISION_QUOTA_EXCEEDED';
  } else if (/rate.?limit/.test(text)) {
    reason = 'VISION_RATE_LIMITED';
  } else if (containsImageInvalidHint(text)) {
    reason = 'VISION_IMAGE_INVALID';
  }

  return {
    reason,
    statusCode: Number.isFinite(Number(statusCode)) ? Math.trunc(Number(statusCode)) : null,
    statusClass: inferHttpStatusClass(statusCode, reason),
    errorClass: errorCode || errorName || 'UNKNOWN_ERROR',
    responseBytesLen: responseBody ? Buffer.byteLength(String(responseBody), 'utf8') : 0,
  };
}

function classifyProviderFailure(error) {
  return classifyProviderFailureMeta(error).reason;
}

function extractProviderStatusCode(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.trunc(numeric);
  }
  return null;
}

function buildQualityFeatureSnapshot(photoQuality) {
  const quality = photoQuality && typeof photoQuality === 'object' ? photoQuality : {};
  const reasons = Array.isArray(quality.reasons)
    ? quality.reasons.map((item) => String(item || '').trim().toLowerCase())
    : [];
  return normalizeQualityFeatures({
    exposure_score:
      quality.exposure_score != null
        ? quality.exposure_score
        : quality.brightness_score != null
          ? quality.brightness_score
          : quality.grade === 'pass'
            ? 0.72
            : quality.grade === 'degraded'
              ? 0.56
              : 0.42,
    reflection_score: quality.reflection_score != null ? quality.reflection_score : reasons.includes('specular') ? 0.7 : 0.15,
    filter_score: quality.filter_score != null ? quality.filter_score : reasons.includes('has_filter') ? 0.9 : 0.12,
    makeup_detected: quality.makeup_detected === true,
    filter_detected: quality.filter_detected === true || reasons.includes('has_filter'),
  });
}

function getReliability({ provider, type, qualityGrade }) {
  const safeProvider = Object.prototype.hasOwnProperty.call(PROVIDER_BASE_WEIGHT, provider) ? provider : 'cv_provider';
  const safeType = Object.prototype.hasOwnProperty.call(MODEL_RELIABILITY, type) ? type : 'other';
  const safeQuality = ['pass', 'degraded', 'fail', 'unknown'].includes(String(qualityGrade || '').toLowerCase())
    ? String(qualityGrade || '').toLowerCase()
    : 'unknown';
  const modelWeight = MODEL_RELIABILITY[safeType][safeQuality] ?? MODEL_RELIABILITY[safeType].unknown;
  return (PROVIDER_BASE_WEIGHT[safeProvider] || 0.5) * modelWeight;
}

function normalizeConcernFromProvider(rawConcern, { provider, concernIndex, qualityGrade, providerQualityFeatures }) {
  const concern = rawConcern && typeof rawConcern === 'object' ? rawConcern : null;
  if (!concern) return null;

  const type = normalizeConcernType(concern.type);
  const regionsRaw = Array.isArray(concern.regions) ? concern.regions : [];
  const regions = [];
  for (const region of regionsRaw) {
    const validated = RegionSchema.safeParse(region);
    if (validated.success) {
      regions.push(validated.data);
      continue;
    }
    if (region && typeof region === 'object' && region.bbox_norm) {
      const bbox = normalizeBBox(region.bbox_norm);
      if (bbox) regions.push({ kind: 'bbox', bbox_norm: bbox });
    }
  }
  if (!regions.length) return null;

  const evidenceText = String(concern.evidence_text || '').trim() || `Signal from ${provider}`;
  const severity = clampSeverity(concern.severity);
  const confidence = clamp01(concern.confidence);
  const qualitySensitivity = normalizeQualitySensitivity(concern.quality_sensitivity, qualityGrade);
  const qualityFeatures = normalizeQualityFeatures(
    concern.quality_features && typeof concern.quality_features === 'object' ? concern.quality_features : providerQualityFeatures,
  );
  const provenance = concern.provenance && typeof concern.provenance === 'object' ? { ...concern.provenance } : {};
  const sourceIds = Array.isArray(provenance.source_ids)
    ? provenance.source_ids.filter((item) => typeof item === 'string' && item.trim()).slice(0, 12)
    : [];

  return {
    concern_id: `${provider}_${concernIndex}`,
    type,
    regions,
    raw_confidence: round3(confidence),
    severity: round3(severity),
    confidence: round3(confidence),
    evidence_text: evidenceText.slice(0, 500),
    quality_sensitivity: qualitySensitivity,
    quality_features: qualityFeatures,
    source_model: String(concern.source_model || provider).trim() || provider,
    provenance: {
      provider,
      source_ids: sourceIds,
      ...(provenance.reviewer ? { reviewer: String(provenance.reviewer).trim() } : {}),
      ...(Array.isArray(provenance.notes) ? { notes: provenance.notes.slice(0, 10) } : {}),
      ...(!sourceIds.length ? { source_ids: [`${provider}:${concernIndex}`] } : {}),
    },
    ...(concern.uncertain === true ? { uncertain: true } : {}),
  };
}

function mergeBBoxes(items) {
  const bboxes = items
    .map((item) => ({ bbox: primaryBBoxFromConcern(item.concern), weight: item.weight }))
    .filter((item) => item.bbox && item.weight > 0);
  if (!bboxes.length) return null;
  let sumWeight = 0;
  let x0 = 0;
  let y0 = 0;
  let x1 = 0;
  let y1 = 0;
  for (const item of bboxes) {
    sumWeight += item.weight;
    x0 += item.bbox.x0 * item.weight;
    y0 += item.bbox.y0 * item.weight;
    x1 += item.bbox.x1 * item.weight;
    y1 += item.bbox.y1 * item.weight;
  }
  if (sumWeight <= 0) return bboxes[0].bbox;
  return normalizeBBox({
    x0: x0 / sumWeight,
    y0: y0 / sumWeight,
    x1: x1 / sumWeight,
    y1: y1 / sumWeight,
  });
}

function mergePolygons(items) {
  const polygons = [];
  for (const item of items) {
    const regions = Array.isArray(item.concern?.regions) ? item.concern.regions : [];
    for (const region of regions) {
      if (region?.kind !== 'polygon' || !Array.isArray(region.points)) continue;
      polygons.push({ points: region.points, weight: item.weight });
      break;
    }
  }
  if (!polygons.length) return null;
  polygons.sort((a, b) => b.weight - a.weight);
  const best = polygons[0];
  const sameLength = polygons.filter((poly) => poly.points.length === best.points.length);
  if (sameLength.length <= 1) return { kind: 'polygon', points: best.points };

  const merged = [];
  for (let idx = 0; idx < best.points.length; idx += 1) {
    let sumWeight = 0;
    let sumX = 0;
    let sumY = 0;
    for (const poly of sameLength) {
      const point = poly.points[idx];
      const weight = Math.max(0.0001, poly.weight);
      sumWeight += weight;
      sumX += clamp01(point.x) * weight;
      sumY += clamp01(point.y) * weight;
    }
    merged.push({
      x: round3(sumX / Math.max(sumWeight, 0.0001)),
      y: round3(sumY / Math.max(sumWeight, 0.0001)),
    });
  }
  return { kind: 'polygon', points: merged };
}

function mergeHeatmaps(items) {
  const heatmaps = [];
  for (const item of items) {
    const regions = Array.isArray(item.concern?.regions) ? item.concern.regions : [];
    for (const region of regions) {
      if (region?.kind !== 'heatmap') continue;
      heatmaps.push({ region, weight: item.weight });
      break;
    }
  }
  if (!heatmaps.length) return null;
  heatmaps.sort((a, b) => b.weight - a.weight);
  const best = heatmaps[0].region;
  const compatible = heatmaps.filter(
    (item) =>
      item.region.rows === best.rows &&
      item.region.cols === best.cols &&
      Array.isArray(item.region.values) &&
      item.region.values.length === best.values.length,
  );
  if (!compatible.length) return null;
  if (compatible.length === 1) return best;

  const values = new Array(best.values.length).fill(0);
  for (let idx = 0; idx < best.values.length; idx += 1) {
    let sumWeight = 0;
    let value = 0;
    for (const item of compatible) {
      const weight = Math.max(0.0001, item.weight);
      sumWeight += weight;
      value += clamp01(item.region.values[idx]) * weight;
    }
    values[idx] = round3(value / Math.max(sumWeight, 0.0001));
  }
  return { kind: 'heatmap', rows: best.rows, cols: best.cols, values };
}

function fuseCluster(cluster, {
  qualityGrade,
  conflictStore,
  calibrationModel,
  toneBucket,
  lightingBucket,
}) {
  const weightedItems = cluster.members.map((member) => {
    const calibratedConfidence = calibrateConfidence(calibrationModel, {
      provider: member.provider,
      qualityGrade,
      toneBucket,
      lightingBucket,
      qualityFeatures: member.concern.quality_features,
      rawConfidence: member.concern.raw_confidence,
    });
    const smoothedSeverity = smoothSeverity(calibrationModel, {
      severity: member.concern.severity,
      calibratedConfidence,
    });
    return {
      concern: member.concern,
      calibratedConfidence,
      smoothedSeverity,
      weight: Math.max(
        0.0001,
        getReliability({
          provider: member.provider,
          type: member.concern.type,
          qualityGrade,
        }) *
          resolveProviderWeight(calibrationModel, {
            provider: member.provider,
            type: member.concern.type,
            qualityGrade,
            toneBucket,
          }) *
          Math.max(0.2, calibratedConfidence),
      ),
    };
  });

  let severitySum = 0;
  let confidenceSum = 0;
  let totalWeight = 0;
  let maxSeverity = 0;
  let minSeverity = 4;
  const providers = new Set();
  const sourceIds = new Set();
  const sourceModels = new Set();
  const notes = [];
  let evidenceSeed = null;

  for (const item of weightedItems) {
    const concern = item.concern;
    const smoothedSeverity = item.smoothedSeverity;
    const calibratedConfidence = item.calibratedConfidence;
    const weight = item.weight;
    totalWeight += weight;
    severitySum += smoothedSeverity * weight;
    confidenceSum += calibratedConfidence * weight;
    maxSeverity = Math.max(maxSeverity, smoothedSeverity);
    minSeverity = Math.min(minSeverity, smoothedSeverity);
    providers.add(concern.provenance?.provider || 'unknown');
    sourceModels.add(concern.source_model);
    for (const id of concern.provenance?.source_ids || []) sourceIds.add(id);
    if (!evidenceSeed || calibratedConfidence > evidenceSeed.confidence) {
      evidenceSeed = { text: concern.evidence_text, confidence: calibratedConfidence };
    }
    if (concern.uncertain) notes.push('provider_marked_uncertain');
  }

  const fusedBbox = mergeBBoxes(weightedItems);
  const fusedPolygon = mergePolygons(weightedItems);
  const fusedHeatmap = mergeHeatmaps(weightedItems);
  const fusedRegions = [];
  if (fusedBbox) fusedRegions.push({ kind: 'bbox', bbox_norm: fusedBbox });
  if (fusedPolygon) fusedRegions.push(fusedPolygon);
  if (fusedHeatmap) fusedRegions.push(fusedHeatmap);
  if (!fusedRegions.length) {
    fusedRegions.push({
      kind: 'bbox',
      bbox_norm: { x0: 0.18, y0: 0.22, x1: 0.82, y1: 0.9 },
    });
  }

  const severitySpread = maxSeverity - minSeverity;
  const providerList = Array.from(providers);
  if (severitySpread >= 1.5) {
    conflictStore.push({
      conflict_id: `conf_sev_${cluster.clusterId}`,
      kind: 'severity_disagreement',
      type: cluster.type,
      severity: round3(Math.min(1, severitySpread / 4)),
      message: `Severity disagreement (${minSeverity.toFixed(1)}-${maxSeverity.toFixed(1)}) across providers.`,
      providers: providerList.slice(0, 6),
    });
  }

  let regionDivergence = 0;
  for (let i = 0; i < weightedItems.length; i += 1) {
    for (let j = i + 1; j < weightedItems.length; j += 1) {
      const boxA = primaryBBoxFromConcern(weightedItems[i].concern);
      const boxB = primaryBBoxFromConcern(weightedItems[j].concern);
      if (!boxA || !boxB) continue;
      regionDivergence = Math.max(regionDivergence, 1 - iou(boxA, boxB));
    }
  }
  if (regionDivergence >= 0.7 && providerList.length > 1) {
    conflictStore.push({
      conflict_id: `conf_region_${cluster.clusterId}`,
      kind: 'region_disagreement',
      type: cluster.type,
      severity: round3(Math.min(1, regionDivergence)),
      message: 'Region overlap is low between providers for this concern.',
      providers: providerList.slice(0, 6),
    });
  }

  const uncertain = severitySpread >= 1.5 || regionDivergence >= 0.7 || notes.length > 0;
  const confidence = totalWeight > 0 ? confidenceSum / totalWeight : 0;
  const aggregatedSeverity = totalWeight > 0 ? severitySum / totalWeight : 0;

  return {
    type: cluster.type,
    regions: fusedRegions.slice(0, 6),
    severity: round3(aggregatedSeverity),
    confidence: round3(uncertain ? confidence * 0.78 : confidence),
    evidence_text: String(evidenceSeed?.text || `Consensus signal from ${providerList.join(', ')}`).slice(0, 500),
    quality_sensitivity: normalizeQualitySensitivity(cluster.qualitySensitivity, qualityGrade),
    source_model: `ensemble(${Array.from(sourceModels).join('+')})`,
    provenance: {
      provider: 'ensemble_aggregator',
      source_ids: Array.from(sourceIds).slice(0, 12),
      notes: notes.slice(0, 10),
      providers: providerList.slice(0, 6),
    },
    ...(uncertain ? { uncertain: true } : {}),
  };
}

function clusterConcerns(normalizedConcerns, { iouThreshold = 0.28 } = {}) {
  const byType = new Map();
  for (const item of normalizedConcerns) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type).push(item);
  }

  const clusters = [];
  let clusterId = 0;
  for (const [type, items] of byType.entries()) {
    const localClusters = [];
    for (const item of items) {
      const itemBox = primaryBBoxFromConcern(item);
      let matched = null;
      let bestIou = 0;
      for (const cluster of localClusters) {
        const clusterBox = cluster.primaryBox;
        const overlap = itemBox && clusterBox ? iou(itemBox, clusterBox) : 0;
        if (overlap >= iouThreshold && overlap >= bestIou) {
          bestIou = overlap;
          matched = cluster;
        }
      }
      if (!matched) {
        localClusters.push({
          clusterId: clusterId += 1,
          type,
          primaryBox: itemBox,
          qualitySensitivity: item.quality_sensitivity,
          members: [{ concern: item, provider: item.provenance?.provider || 'unknown' }],
        });
      } else {
        matched.members.push({ concern: item, provider: item.provenance?.provider || 'unknown' });
        if (!matched.primaryBox) matched.primaryBox = itemBox;
        if (item.quality_sensitivity === 'high') matched.qualitySensitivity = 'high';
        if (item.quality_sensitivity === 'medium' && matched.qualitySensitivity !== 'high') matched.qualitySensitivity = 'medium';
      }
    }
    clusters.push(...localClusters);
  }
  return clusters;
}

function computeAgreementScore(providerOutputs) {
  const valid = providerOutputs.filter((output) => output && output.ok && Array.isArray(output.concerns) && output.concerns.length);
  if (valid.length <= 1) return 1;
  const pairScores = [];
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const a = valid[i].concerns;
      const b = valid[j].concerns;
      if (!a.length && !b.length) {
        pairScores.push(1);
        continue;
      }
      let matches = 0;
      for (const concernA of a) {
        const boxA = primaryBBoxFromConcern(concernA);
        const sameType = b.filter((concernB) => concernB.type === concernA.type);
        let matched = false;
        for (const concernB of sameType) {
          const boxB = primaryBBoxFromConcern(concernB);
          if (!boxA || !boxB) {
            matched = true;
            break;
          }
          if (iou(boxA, boxB) >= 0.2) {
            matched = true;
            break;
          }
        }
        if (matched) matches += 1;
      }
      pairScores.push(matches / Math.max(1, Math.max(a.length, b.length)));
    }
  }
  const average = pairScores.reduce((sum, value) => sum + value, 0) / Math.max(1, pairScores.length);
  return round3(Math.max(0, Math.min(1, average)));
}

function makeProviderStat({ provider, ok, latencyMs, concernCount, schemaFailed, failureReason }) {
  return {
    provider,
    ok: Boolean(ok),
    latency_ms: round3(Math.max(0, Number(latencyMs || 0))),
    concern_count: Math.max(0, Math.trunc(Number(concernCount || 0))),
    ...(schemaFailed ? { schema_failed: true } : {}),
    ...(failureReason ? { failure_reason: String(failureReason) } : {}),
  };
}

function mapFindingToConcern({ finding, diagnosisInternal, qualityGrade, index, qualityFeatures }) {
  if (!finding || typeof finding !== 'object') return null;
  const type = normalizeConcernType(finding.issue_type);
  const severity = clampSeverity(finding.severity);
  const confidence = clamp01(finding.confidence);
  const evidenceText = String(finding.evidence || '').trim() || `CV signal ${type}`;
  const regions = [];

  if (finding.geometry && typeof finding.geometry === 'object') {
    const bbox = normalizeBBox(finding.geometry.bbox_norm);
    if (bbox) regions.push({ kind: 'bbox', bbox_norm: bbox });
    if (
      finding.geometry.type === 'grid' &&
      Number.isFinite(Number(finding.geometry.rows)) &&
      Number.isFinite(Number(finding.geometry.cols)) &&
      Array.isArray(finding.geometry.values)
    ) {
      const rows = Math.max(1, Math.min(64, Math.trunc(Number(finding.geometry.rows))));
      const cols = Math.max(1, Math.min(64, Math.trunc(Number(finding.geometry.cols))));
      const values = finding.geometry.values.slice(0, rows * cols).map((value) => round3(clamp01(value)));
      if (values.length === rows * cols) regions.push({ kind: 'heatmap', rows, cols, values });
    }
  }

  if (!regions.length && diagnosisInternal?.skin_bbox_norm) {
    const bbox = normalizeBBox(diagnosisInternal.skin_bbox_norm);
    if (bbox) regions.push({ kind: 'bbox', bbox_norm: bbox });
  }
  if (!regions.length) {
    regions.push({ kind: 'bbox', bbox_norm: { x0: 0.18, y0: 0.22, x1: 0.82, y1: 0.9 } });
  }

  return {
    type,
    regions,
    raw_confidence: round3(confidence),
    severity: round3(severity),
    confidence: round3(confidence),
    evidence_text: evidenceText.slice(0, 500),
    quality_sensitivity: normalizeQualitySensitivity(finding.uncertain ? 'high' : null, qualityGrade),
    source_model: 'cv_provider',
    quality_features: qualityFeatures || normalizeQualityFeatures({}),
    provenance: {
      provider: 'cv_provider',
      source_ids: [String(finding.finding_id || `cv_finding_${index + 1}`)],
      ...(finding.subtype ? { notes: [`subtype:${finding.subtype}`] } : {}),
    },
    ...(finding.uncertain ? { uncertain: true } : {}),
  };
}

function getProviderConfig() {
  return {
    enabled: boolEnv('DIAG_ENSEMBLE', false),
    iouThreshold: numEnv('DIAG_ENSEMBLE_IOU_CLUSTER', 0.28, 0.05, 0.95),
    timeoutMs: numEnv('DIAG_ENSEMBLE_TIMEOUT_MS', 12000, 1000, 45000),
    retries: numEnv('DIAG_ENSEMBLE_RETRIES', 1, 0, 3),
    geminiEnabled: boolEnv('DIAG_ENSEMBLE_GEMINI_ENABLED', true),
    geminiModel: String(process.env.DIAG_ENSEMBLE_GEMINI_MODEL || 'gemini-2.0-flash').trim() || 'gemini-2.0-flash',
    gptEnabled: boolEnv('DIAG_ENSEMBLE_GPT_ENABLED', true),
    gptModel: String(process.env.DIAG_ENSEMBLE_GPT_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini',
  };
}

async function runCvProvider({
  diagnosisV1,
  diagnosisInternal,
  photoQuality,
} = {}) {
  const startedAt = Date.now();
  const findings = Array.isArray(diagnosisV1?.photo_findings) ? diagnosisV1.photo_findings : [];
  const qualityGrade = String(photoQuality?.grade || diagnosisV1?.quality?.grade || 'unknown').toLowerCase();
  const qualityFeatures = buildQualityFeatureSnapshot(photoQuality);
  if (!findings.length) {
    return {
      ok: false,
      provider: 'cv_provider',
      model_name: 'cv_ruleset',
      model_version: String(process.env.DIAG_ENSEMBLE_CV_MODEL_VERSION || 'v1').trim() || 'v1',
      concerns: [],
      quality_features: qualityFeatures,
      latency_ms: Date.now() - startedAt,
      attempts: 1,
      provider_status_code: 204,
      failure_reason: 'NO_FINDINGS',
    };
  }

  const concerns = findings
    .map((finding, index) => mapFindingToConcern({ finding, diagnosisInternal, qualityGrade, index, qualityFeatures }))
    .filter(Boolean);

  return {
    ok: concerns.length > 0,
    provider: 'cv_provider',
    model_name: 'cv_ruleset',
    model_version: String(process.env.DIAG_ENSEMBLE_CV_MODEL_VERSION || 'v1').trim() || 'v1',
    concerns,
    quality_features: qualityFeatures,
    latency_ms: Date.now() - startedAt,
    attempts: 1,
    provider_status_code: concerns.length > 0 ? 200 : 422,
    ...(concerns.length ? {} : { failure_reason: 'NO_VALID_FINDINGS' }),
  };
}

function buildGeminiPrompt({ language, profileSummary, qualityGrade }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const compactProfile = profileSummary && typeof profileSummary === 'object'
    ? {
        skinType: profileSummary.skinType || null,
        sensitivity: profileSummary.sensitivity || null,
        barrierStatus: profileSummary.barrierStatus || null,
        goals: Array.isArray(profileSummary.goals) ? profileSummary.goals.slice(0, 4) : [],
      }
    : {};
  return [
    `You are a skin image reviewer. Return strict JSON only.`,
    `language=${lang}`,
    `quality_grade=${qualityGrade}`,
    `profile=${JSON.stringify(compactProfile)}`,
    'Output schema:',
    '{',
    '  "concerns": [',
    '    {',
    '      "type":"redness|acne|shine|texture|tone|dryness|barrier|other",',
    '      "regions":[{"kind":"bbox","bbox_norm":{"x0":0-1,"y0":0-1,"x1":0-1,"y1":0-1}}],',
    '      "severity":0-4,',
    '      "confidence":0-1,',
    '      "evidence_text":"short evidence",',
    '      "quality_sensitivity":"low|medium|high",',
    '      "source_model":"gemini_provider",',
    '      "provenance":{"provider":"gemini_provider","source_ids":["gemini:1"]}',
    '    }',
    '  ],',
    '  "flags":["possible_lighting_bias(optional)"]',
    '}',
    'Rules: no medical diagnosis, no treatment prescriptions, no markdown.',
  ].join('\n');
}

function buildGptReviewerPrompt({ language, geminiDraft, qualityGrade }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  return [
    'You are a strict reviewer for skin-photo concerns.',
    `language=${lang}`,
    `quality_grade=${qualityGrade}`,
    `gemini_draft=${JSON.stringify(geminiDraft || {})}`,
    'Return strict JSON only:',
    '{',
    '  "review":"agree|disagree|partial",',
    '  "flags":["possible_lighting_bias(optional)","possible_filter_bias(optional)"],',
    '  "concerns":[',
    '    {',
    '      "type":"redness|acne|shine|texture|tone|dryness|barrier|other",',
    '      "regions":[{"kind":"bbox","bbox_norm":{"x0":0-1,"y0":0-1,"x1":0-1,"y1":0-1}}],',
    '      "severity":0-4,',
    '      "confidence":0-1,',
    '      "evidence_text":"short reason",',
    '      "quality_sensitivity":"low|medium|high",',
    '      "source_model":"gpt_provider",',
    '      "provenance":{"provider":"gpt_provider","reviewer":"chatgpt"}',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

function parseProviderPayload(rawText) {
  const parsed = ensureJsonObject(String(rawText || ''));
  if (!parsed) return { ok: false, reason: 'SCHEMA_INVALID' };
  const validated = ProviderPayloadSchema.safeParse(parsed);
  if (!validated.success) return { ok: false, reason: 'SCHEMA_INVALID', detail: validated.error.flatten() };
  return { ok: true, payload: validated.data };
}

async function runGeminiProvider({
  imageBuffer,
  language,
  profileSummary,
  photoQuality,
  retries,
  timeoutMs,
  model,
} = {}) {
  const startedAt = Date.now();
  const apiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const qualityFeatures = buildQualityFeatureSnapshot(photoQuality);
  const imageBytesLen = Buffer.isBuffer(imageBuffer) ? imageBuffer.length : 0;
  const requestPayloadBytesLen = imageBytesLen > 0 ? Math.ceil((imageBytesLen / 3)) * 4 : 0;
  if (!apiKey) {
    return {
      ok: false,
      provider: 'gemini_provider',
      model_name: model,
      model_version: 'v1',
      concerns: [],
      quality_features: qualityFeatures,
      latency_ms: Date.now() - startedAt,
      attempts: 0,
      provider_status_code: 401,
      failure_reason: 'VISION_MISSING_KEY',
      http_status_class: '4xx',
      error_class: 'MISSING_API_KEY',
      image_bytes_len: imageBytesLen,
      request_payload_bytes_len: 0,
      response_bytes_len: 0,
    };
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return {
      ok: false,
      provider: 'gemini_provider',
      model_name: model,
      model_version: 'v1',
      concerns: [],
      quality_features: qualityFeatures,
      latency_ms: Date.now() - startedAt,
      attempts: 0,
      provider_status_code: 400,
      failure_reason: 'VISION_IMAGE_INVALID',
      http_status_class: '4xx',
      error_class: 'MISSING_IMAGE',
      image_bytes_len: 0,
      request_payload_bytes_len: 0,
      response_bytes_len: 0,
    };
  }

  let GoogleGenAI = null;
  try {
    ({ GoogleGenAI } = require('@google/genai'));
  } catch (_err) {
    return {
      ok: false,
      provider: 'gemini_provider',
      model_name: model,
      model_version: 'v1',
      concerns: [],
      quality_features: qualityFeatures,
      latency_ms: Date.now() - startedAt,
      attempts: 0,
      provider_status_code: 501,
      failure_reason: 'VISION_UNKNOWN',
      http_status_class: '5xx',
      error_class: 'MISSING_DEP',
      image_bytes_len: imageBytesLen,
      request_payload_bytes_len: requestPayloadBytesLen,
      response_bytes_len: 0,
    };
  }

  const qualityGrade = String(photoQuality?.grade || 'unknown').toLowerCase();
  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildGeminiPrompt({ language, profileSummary, qualityGrade });
  const request = {
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: imageBuffer.toString('base64'),
            },
          },
          { text: prompt },
        ],
      },
    ],
    config: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  };

  let lastError = null;
  const attempts = Math.max(1, retries + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await withTimeout(ai.models.generateContent(request), timeoutMs);
      const text = extractTextFromGeminiResponse(response);
      const responseBytesLen = Buffer.byteLength(String(text || ''), 'utf8');
      const parsed = parseProviderPayload(text);
      if (!parsed.ok) {
        const schemaSummary = summarizeSchemaError(parsed.detail);
        return {
          ok: false,
          provider: 'gemini_provider',
          model_name: model,
          model_version: 'v1',
          concerns: [],
          quality_features: qualityFeatures,
          latency_ms: Date.now() - startedAt,
          attempts: attempt + 1,
          provider_status_code: 200,
          failure_reason: 'VISION_SCHEMA_INVALID',
          verify_fail_reason: 'SCHEMA_INVALID',
          schema_failed: true,
          schema_error_summary: schemaSummary,
          http_status_class: '2xx',
          error_class: 'SCHEMA_INVALID',
          image_bytes_len: imageBytesLen,
          request_payload_bytes_len: requestPayloadBytesLen,
          response_bytes_len: responseBytesLen,
        };
      }
      const concerns = parsed.payload.concerns.map((concern, index) =>
        normalizeConcernFromProvider(concern, {
          provider: 'gemini_provider',
          concernIndex: index,
          qualityGrade,
          providerQualityFeatures: qualityFeatures,
        }),
      );
      return {
        ok: true,
        provider: 'gemini_provider',
        model_name: model,
        model_version: 'v1',
        concerns: concerns.filter(Boolean),
        quality_features: qualityFeatures,
        flags: parsed.payload.flags || [],
        latency_ms: Date.now() - startedAt,
        attempts: attempt + 1,
        provider_status_code: 200,
        http_status_class: '2xx',
        image_bytes_len: imageBytesLen,
        request_payload_bytes_len: requestPayloadBytesLen,
        response_bytes_len: responseBytesLen,
      };
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await sleep(200 * (2 ** attempt));
    }
  }

  const statusCode = extractProviderStatusCode(lastError);
  const failureMeta = classifyProviderFailureMeta(lastError);
  return {
    ok: false,
    provider: 'gemini_provider',
    model_name: model,
    model_version: 'v1',
    concerns: [],
    quality_features: qualityFeatures,
    latency_ms: Date.now() - startedAt,
    attempts,
    ...(Number.isFinite(Number(statusCode)) ? { provider_status_code: Math.trunc(Number(statusCode)) } : {}),
    failure_reason: failureMeta.reason,
    http_status_class: failureMeta.statusClass,
    error_class: failureMeta.errorClass,
    image_bytes_len: imageBytesLen,
    request_payload_bytes_len: requestPayloadBytesLen,
    response_bytes_len: failureMeta.responseBytesLen,
  };
}

async function runGptProvider({
  imageBuffer,
  language,
  geminiDraft,
  photoQuality,
  retries,
  timeoutMs,
  model,
} = {}) {
  const startedAt = Date.now();
  const client = getOpenAIClient();
  const qualityFeatures = buildQualityFeatureSnapshot(photoQuality);
  if (!client) {
    return {
      ok: false,
      provider: 'gpt_provider',
      model_name: model,
      model_version: 'v1',
      concerns: [],
      quality_features: qualityFeatures,
      latency_ms: Date.now() - startedAt,
      failure_reason: 'MISSING_API_KEY',
    };
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return {
      ok: false,
      provider: 'gpt_provider',
      model_name: model,
      model_version: 'v1',
      concerns: [],
      quality_features: qualityFeatures,
      latency_ms: Date.now() - startedAt,
      failure_reason: 'MISSING_IMAGE',
    };
  }

  const qualityGrade = String(photoQuality?.grade || 'unknown').toLowerCase();
  const prompt = buildGptReviewerPrompt({ language, geminiDraft, qualityGrade });
  const content = [
    {
      type: 'text',
      text: prompt,
    },
    {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
      },
    },
  ];

  const attempts = Math.max(1, retries + 1);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const completion = await withTimeout(
        client.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You return strict JSON only.' },
            { role: 'user', content },
          ],
        }),
        timeoutMs,
      );
      const raw = completion?.choices?.[0]?.message?.content || '';
      const parsed = parseProviderPayload(raw);
      if (!parsed.ok) {
        return {
          ok: false,
          provider: 'gpt_provider',
          model_name: model,
          model_version: 'v1',
          concerns: [],
          quality_features: qualityFeatures,
          latency_ms: Date.now() - startedAt,
          failure_reason: parsed.reason,
          schema_failed: true,
        };
      }
      const concerns = parsed.payload.concerns
        .map((concern, index) =>
          normalizeConcernFromProvider(concern, {
            provider: 'gpt_provider',
            concernIndex: index,
            qualityGrade,
            providerQualityFeatures: qualityFeatures,
          }),
        )
        .filter(Boolean);
      return {
        ok: true,
        provider: 'gpt_provider',
        model_name: model,
        model_version: 'v1',
        concerns,
        quality_features: qualityFeatures,
        flags: parsed.payload.flags || [],
        review: parsed.payload.review || null,
        latency_ms: Date.now() - startedAt,
      };
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await sleep(180 * (2 ** attempt));
    }
  }

  return {
    ok: false,
    provider: 'gpt_provider',
    model_name: model,
    model_version: 'v1',
    concerns: [],
    quality_features: qualityFeatures,
    latency_ms: Date.now() - startedAt,
    failure_reason: classifyProviderFailure(lastError),
  };
}

function buildCanonical({
  providerOutputs,
  qualityGrade,
  iouThreshold,
  calibrationModel,
  toneBucket,
  lightingBucket,
}) {
  const normalized = [];
  const normalizedProviderOutputs = [];
  const providerStats = [];
  for (const output of providerOutputs) {
    const concerns = Array.isArray(output.concerns) ? output.concerns : [];
    const normalizedConcerns = [];
    for (let index = 0; index < concerns.length; index += 1) {
      const normalizedConcern = normalizeConcernFromProvider(concerns[index], {
        provider: output.provider,
        concernIndex: index,
        qualityGrade,
        providerQualityFeatures: output.quality_features,
      });
      if (normalizedConcern) normalizedConcerns.push(normalizedConcern);
    }

    normalizedProviderOutputs.push({
      ...output,
      concerns: normalizedConcerns,
    });

    providerStats.push(
      makeProviderStat({
        provider: output.provider,
        ok: output.ok,
        latencyMs: output.latency_ms,
        concernCount: normalizedConcerns.length,
        schemaFailed: Boolean(output.schema_failed),
        failureReason: output.failure_reason,
      }),
    );
    if (!output.ok) continue;
    normalized.push(...normalizedConcerns);
  }

  const conflicts = [];
  const clusters = clusterConcerns(normalized, { iouThreshold });
  const concerns = clusters
    .map((cluster) =>
      fuseCluster(cluster, {
        qualityGrade,
        conflictStore: conflicts,
        calibrationModel,
        toneBucket,
        lightingBucket,
      }))
    .filter(Boolean)
    .sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      return b.confidence - a.confidence;
    })
    .slice(0, 64);

  const agreementScore = computeAgreementScore(normalizedProviderOutputs);

  // Cross-type disagreement in overlapping regions.
  for (let i = 0; i < concerns.length; i += 1) {
    for (let j = i + 1; j < concerns.length; j += 1) {
      const a = concerns[i];
      const b = concerns[j];
      if (a.type === b.type) continue;
      const overlap = iou(primaryBBoxFromConcern(a), primaryBBoxFromConcern(b));
      if (overlap < 0.35) continue;
      conflicts.push({
        conflict_id: `conf_type_${i + 1}_${j + 1}`,
        kind: 'type_disagreement',
        severity: round3(Math.min(1, overlap)),
        message: `Type disagreement in overlapping region: ${a.type} vs ${b.type}.`,
        providers: Array.from(new Set([...(a.provenance.providers || []), ...(b.provenance.providers || [])])).slice(0, 6),
      });
      a.uncertain = true;
      b.uncertain = true;
      a.confidence = round3(a.confidence * 0.82);
      b.confidence = round3(b.confidence * 0.82);
    }
  }

  const canonical = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    concerns,
    conflicts: conflicts.slice(0, 32),
    provider_stats: providerStats,
    agreement_score: agreementScore,
  };
  const validated = CanonicalSchema.safeParse(canonical);
  if (!validated.success) {
    return {
      ok: false,
      failure_reason: 'CANONICAL_SCHEMA_INVALID',
      canonical: {
        schema_version: CANONICAL_SCHEMA_VERSION,
        concerns: [],
        conflicts: [],
        provider_stats: providerStats,
        agreement_score: 0,
      },
    };
  }
  return { ok: true, canonical: validated.data };
}

function buildEvidenceRegionsFromCanonical(canonical) {
  const concerns = Array.isArray(canonical?.concerns) ? canonical.concerns : [];
  const regions = [];
  for (const concern of concerns) {
    const concernType = concern?.type || 'other';
    const severity = clampSeverity(concern?.severity);
    const confidence = clamp01(concern?.confidence);
    const evidenceText = String(concern?.evidence_text || '').trim();
    const concernRegions = Array.isArray(concern?.regions) ? concern.regions : [];
    for (const region of concernRegions) {
      regions.push({
        concern_type: concernType,
        severity: round3(severity),
        confidence: round3(confidence),
        evidence_text: evidenceText,
        region,
      });
    }
  }
  return regions.slice(0, 96);
}

async function runDiagnosisEnsemble({
  imageBuffer,
  language,
  photoQuality,
  diagnosisV1,
  diagnosisInternal,
  profileSummary,
  recentLogsSummary,
  inferenceId,
  skinToneBucket,
  lightingBucket,
  logger,
  providerOverrides,
  metricsHooks,
} = {}) {
  const cfg = getProviderConfig();
  const qualityGrade = String(photoQuality?.grade || diagnosisV1?.quality?.grade || 'unknown').toLowerCase();
  const calibrationRuntime = loadCalibrationRuntime();
  const calibrationModel = calibrationRuntime.enabled ? calibrationRuntime.model : null;
  if (calibrationRuntime.enabled && calibrationRuntime.error) {
    logger?.warn(
      {
        source: calibrationRuntime.source,
        error: calibrationRuntime.error,
      },
      'diag ensemble: calibration model load failed, using fallback calibration model',
    );
  }
  if (!cfg.enabled) {
    return {
      ok: false,
      enabled: false,
      failure_reason: 'DISABLED_BY_FLAG',
      provider_stats: [],
      agreement_score: null,
      canonical: null,
    };
  }

  const providers = providerOverrides && typeof providerOverrides === 'object' ? providerOverrides : {};
  const runCv = providers.cvProvider || runCvProvider;
  const runGemini = providers.geminiProvider || runGeminiProvider;
  const runGpt = providers.gptProvider || runGptProvider;

  const cvOut = await runCv({
    diagnosisV1,
    diagnosisInternal,
    photoQuality,
    language,
  });

  const providerOutputs = [cvOut];
  let geminiOut = {
    ok: false,
    provider: 'gemini_provider',
    concerns: [],
    latency_ms: 0,
    failure_reason: 'DISABLED_BY_FLAG',
  };
  if (cfg.geminiEnabled) {
    geminiOut = await runGemini({
      imageBuffer,
      language,
      profileSummary,
      recentLogsSummary,
      photoQuality,
      retries: cfg.retries,
      timeoutMs: cfg.timeoutMs,
      model: cfg.geminiModel,
    });
    providerOutputs.push(geminiOut);
  }

  if (cfg.gptEnabled) {
    const gptOut = await runGpt({
      imageBuffer,
      language,
      geminiDraft: geminiOut && geminiOut.ok ? geminiOut : null,
      photoQuality,
      retries: cfg.retries,
      timeoutMs: cfg.timeoutMs,
      model: cfg.gptModel,
    });
    providerOutputs.push(gptOut);
  }

  const built = buildCanonical({
    providerOutputs,
    qualityGrade,
    iouThreshold: cfg.iouThreshold,
    calibrationModel,
    toneBucket: skinToneBucket,
    lightingBucket,
  });

  for (const stat of built?.canonical?.provider_stats || []) {
    if (metricsHooks && typeof metricsHooks.onProviderResult === 'function') metricsHooks.onProviderResult(stat);
  }
  if (built?.canonical && Number.isFinite(Number(built.canonical.agreement_score))) {
    if (metricsHooks && typeof metricsHooks.onAgreement === 'function') metricsHooks.onAgreement(built.canonical.agreement_score);
  }
  if (metricsHooks && typeof metricsHooks.onCalibrationLoad === 'function') {
    metricsHooks.onCalibrationLoad({
      enabled: calibrationRuntime.enabled,
      source: calibrationRuntime.source,
      error: calibrationRuntime.error,
      model_version: calibrationRuntime.model?.model_version || null,
    });
  }

  let pseudoLabelSummary = null;
  try {
    pseudoLabelSummary = await persistPseudoLabelArtifacts({
      inferenceId: inferenceId || null,
      qualityGrade,
      providerOutputs,
      skinToneBucket: skinToneBucket || 'unknown',
      lightingBucket: lightingBucket || 'unknown',
      logger,
    });
  } catch (err) {
    logger?.warn(
      { err: err && err.message ? err.message : String(err) },
      'diag ensemble: pseudo-label persistence failed',
    );
  }

  if (!built.ok) {
    logger?.warn({ reason: built.failure_reason }, 'diag ensemble: canonical build failed');
  }

  return {
    ok: built.ok,
    enabled: true,
    canonical: built.canonical,
    provider_stats: built.canonical?.provider_stats || [],
    agreement_score: built.canonical?.agreement_score ?? null,
    pseudo_label_summary: pseudoLabelSummary,
    calibration: {
      enabled: calibrationRuntime.enabled,
      source: calibrationRuntime.source,
      error: calibrationRuntime.error,
      model_version: calibrationRuntime.model?.model_version || null,
    },
    failure_reason: built.ok ? null : built.failure_reason,
  };
}

module.exports = {
  CANONICAL_SCHEMA_VERSION,
  CANONICAL_TYPES,
  CanonicalSchema,
  ConcernSchema,
  RegionSchema,
  runCvProvider,
  runGeminiProvider,
  runGptProvider,
  runDiagnosisEnsemble,
  buildCanonical,
  buildEvidenceRegionsFromCanonical,
  normalizeConcernType,
  normalizeConcernFromProvider,
  clusterConcerns,
  computeAgreementScore,
  iou,
};
