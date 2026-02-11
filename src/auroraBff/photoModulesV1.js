const crypto = require('crypto');
const { mapIngredientActions } = require('./ingredientActionsV1');
const { renderAllowedTemplate } = require('./claimsTemplates/render');
const { buildProductRecommendations } = require('./productRecV1');
const { inferRiskTier } = require('./ingredientKbV2/resolve');
const {
  createMask,
  bboxNormToMask,
  polygonNormToMask,
  resizeHeatmapToMask,
  orMaskInto,
  andMasks,
  countOnes,
  encodeRleBinary,
  decodeRleBinary,
} = require('./evalAdapters/common/metrics');

const FACE_COORD_SPACE = 'face_crop_norm_v1';
const HEATMAP_GRID_DEFAULT = Object.freeze({ w: 64, h: 64 });
const MODULE_MASK_GRID_SIZE = 64;
const MODULE_BOXES = Object.freeze({
  forehead: { x: 0.2, y: 0.03, w: 0.6, h: 0.22 },
  left_cheek: { x: 0.08, y: 0.34, w: 0.34, h: 0.3 },
  right_cheek: { x: 0.58, y: 0.34, w: 0.34, h: 0.3 },
  nose: { x: 0.42, y: 0.32, w: 0.16, h: 0.32 },
  chin: { x: 0.33, y: 0.67, w: 0.34, h: 0.26 },
  under_eye_left: { x: 0.18, y: 0.24, w: 0.24, h: 0.13 },
  under_eye_right: { x: 0.58, y: 0.24, w: 0.24, h: 0.13 },
});
const FACE_OVAL_POLYGON = Object.freeze({
  points: [
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
  ],
  closed: true,
});

function parseEnvBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function parseEnvNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const FACE_OVAL_CLIP_ENABLED = parseEnvBoolean(process.env.DIAG_FACE_OVAL_CLIP, true);
const MODULE_SHRINK_CHIN = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_CHIN, 0.8, 0.5, 1);
const MODULE_SHRINK_FOREHEAD = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_FOREHEAD, 0.88, 0.5, 1);
const MODULE_SHRINK_CHEEK = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_CHEEK, 0.9, 0.5, 1);

const SUPPORTED_ISSUES = new Set(['redness', 'shine', 'texture', 'tone', 'acne']);
const MODULE_SKIN_INTERSECTION_MIN_PIXELS = Math.max(
  1,
  Math.min(512, Math.trunc(Number(process.env.DIAG_SKINMASK_MIN_PIXELS || 8) || 8)),
);
const MODULE_SKIN_INTERSECTION_MIN_RATIO = Math.max(
  0,
  Math.min(1, Number(process.env.DIAG_SKINMASK_MIN_KEEP_RATIO || 0.6)),
);
const MODULE_SKIN_POSITIVE_RATIO_MIN = Math.max(
  0,
  Math.min(1, Number(process.env.DIAG_SKINMASK_POSITIVE_RATIO_MIN || 0.04)),
);
const MODULE_SKIN_POSITIVE_RATIO_MAX = Math.max(
  MODULE_SKIN_POSITIVE_RATIO_MIN,
  Math.min(1, Number(process.env.DIAG_SKINMASK_POSITIVE_RATIO_MAX || 0.95)),
);

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number <= 0) return 0;
  if (number >= 1) return 1;
  return number;
}

function round3(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 1000) / 1000;
}

function normalizeLanguage(language) {
  return String(language || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeQualityGrade(qualityGrade) {
  const token = String(qualityGrade || '').trim().toLowerCase();
  if (token === 'pass' || token === 'degraded' || token === 'fail') return token;
  return 'unknown';
}

function normalizeSeverity0to4(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(4, number));
}

function isPointNearlyEqual(a, b, eps = 1e-6) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

function sanitizeBBox(rawBox) {
  if (!rawBox || typeof rawBox !== 'object') {
    return { ok: false, clipped: false, reason: 'bbox_missing', bbox: null };
  }
  const rawX = Number(rawBox.x);
  const rawY = Number(rawBox.y);
  const rawW = Number(rawBox.w);
  const rawH = Number(rawBox.h);
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawW) || !Number.isFinite(rawH)) {
    return { ok: false, clipped: false, reason: 'bbox_non_numeric', bbox: null };
  }

  const x0 = clamp01(rawX);
  const y0 = clamp01(rawY);
  const x1 = clamp01(rawX + rawW);
  const y1 = clamp01(rawY + rawH);
  const clipped = x0 !== rawX || y0 !== rawY || x1 !== rawX + rawW || y1 !== rawY + rawH;

  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.max(x0, x1) - x;
  const h = Math.max(y0, y1) - y;
  if (w <= 0.001 || h <= 0.001) {
    return { ok: false, clipped: true, reason: 'bbox_too_small', bbox: null };
  }

  return {
    ok: true,
    clipped,
    reason: null,
    clip_reason: clipped ? 'bbox_clamped' : null,
    bbox: {
      x: round3(x),
      y: round3(y),
      w: round3(w),
      h: round3(h),
    },
  };
}

function toBBoxFromNorm(rawBBoxNorm) {
  if (!rawBBoxNorm || typeof rawBBoxNorm !== 'object') return null;
  const x0 = Number(rawBBoxNorm.x0);
  const y0 = Number(rawBBoxNorm.y0);
  const x1 = Number(rawBBoxNorm.x1);
  const y1 = Number(rawBBoxNorm.y1);
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return (
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    b.x + 1e-9 >= Math.min(a.x, c.x) &&
    b.y <= Math.max(a.y, c.y) + 1e-9 &&
    b.y + 1e-9 >= Math.min(a.y, c.y)
  );
}

function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function polygonSelfIntersect(points) {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const iNext = (i + 1) % n;
    const a1 = points[i];
    const a2 = points[iNext];
    for (let j = i + 1; j < n; j += 1) {
      const jNext = (j + 1) % n;
      if (i === j || iNext === j || jNext === i) continue;
      if (i === 0 && jNext === n - 1) continue;
      const b1 = points[j];
      const b2 = points[jNext];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function sanitizePolygon(rawPolygon) {
  if (!rawPolygon || typeof rawPolygon !== 'object' || !Array.isArray(rawPolygon.points)) {
    return { ok: false, clipped: false, reason: 'polygon_missing', polygon: null, bbox: null };
  }

  let clipped = false;
  const clipReasons = new Set();
  const deduped = [];
  for (const point of rawPolygon.points) {
    if (!point || typeof point !== 'object') continue;
    const xRaw = Number(point.x);
    const yRaw = Number(point.y);
    if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) {
      clipped = true;
      clipReasons.add('polygon_non_numeric');
      continue;
    }
    const x = clamp01(xRaw);
    const y = clamp01(yRaw);
    if (x !== xRaw || y !== yRaw) {
      clipped = true;
      clipReasons.add('polygon_clamped');
    }
    const next = { x: round3(x), y: round3(y) };
    const prev = deduped[deduped.length - 1];
    if (prev && isPointNearlyEqual(prev, next)) {
      clipped = true;
      clipReasons.add('polygon_deduped');
      continue;
    }
    deduped.push(next);
  }

  if (deduped.length >= 2 && isPointNearlyEqual(deduped[0], deduped[deduped.length - 1])) {
    deduped.pop();
    clipped = true;
    clipReasons.add('polygon_deduped');
  }

  if (deduped.length < 3) {
    return { ok: false, clipped: true, reason: 'polygon_too_few_points', polygon: null, bbox: null };
  }
  if (polygonSelfIntersect(deduped)) {
    return { ok: false, clipped: true, reason: 'polygon_self_intersection', polygon: null, bbox: null };
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of deduped) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const bbox = {
    x: round3(minX),
    y: round3(minY),
    w: round3(maxX - minX),
    h: round3(maxY - minY),
  };
  if (bbox.w <= 0.001 || bbox.h <= 0.001) {
    return { ok: false, clipped: true, reason: 'polygon_too_small', polygon: null, bbox: null };
  }

  return {
    ok: true,
    clipped,
    reason: null,
    clip_reason: clipReasons.size ? Array.from(clipReasons).sort().join('+') : null,
    polygon: {
      points: deduped,
      closed: true,
    },
    bbox,
  };
}

function bilinearSample(values, width, height, x, y) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
  const q11 = values[y0 * width + x0] || 0;
  const q21 = values[y0 * width + x1] || 0;
  const q12 = values[y1 * width + x0] || 0;
  const q22 = values[y1 * width + x1] || 0;
  const tx = x - x0;
  const ty = y - y0;
  const a = q11 * (1 - tx) + q21 * tx;
  const b = q12 * (1 - tx) + q22 * tx;
  return a * (1 - ty) + b * ty;
}

function resizeGridValues(values, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return values.slice();
  const out = new Array(dstW * dstH).fill(0);
  for (let y = 0; y < dstH; y += 1) {
    const sy = ((y + 0.5) * srcH) / dstH - 0.5;
    for (let x = 0; x < dstW; x += 1) {
      const sx = ((x + 0.5) * srcW) / dstW - 0.5;
      out[y * dstW + x] = round3(clamp01(bilinearSample(values, srcW, srcH, sx, sy)));
    }
  }
  return out;
}

function sanitizeHeatmap(rawHeatmap) {
  if (!rawHeatmap || typeof rawHeatmap !== 'object') {
    return { ok: false, clipped: false, reason: 'heatmap_missing', heatmap: null };
  }
  const rawGrid = rawHeatmap.grid && typeof rawHeatmap.grid === 'object' ? rawHeatmap.grid : null;
  const wRaw = Number(rawGrid ? rawGrid.w : rawHeatmap.w);
  const hRaw = Number(rawGrid ? rawGrid.h : rawHeatmap.h);
  const valuesRaw = Array.isArray(rawHeatmap.values) ? rawHeatmap.values : null;
  if (!Number.isFinite(wRaw) || !Number.isFinite(hRaw) || !valuesRaw) {
    return { ok: false, clipped: false, reason: 'heatmap_invalid_grid', heatmap: null };
  }

  const srcW = Math.max(1, Math.min(256, Math.trunc(wRaw)));
  const srcH = Math.max(1, Math.min(256, Math.trunc(hRaw)));
  const expected = srcW * srcH;
  let clipped = srcW !== wRaw || srcH !== hRaw;
  if (valuesRaw.length < expected) {
    return { ok: false, clipped: true, reason: 'heatmap_values_length_mismatch', heatmap: null };
  }

  const normalized = valuesRaw.slice(0, expected).map((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      clipped = true;
      return 0;
    }
    const clamped = clamp01(numeric);
    if (clamped !== numeric) clipped = true;
    return clamped;
  });

  const resizedValues = resizeGridValues(
    normalized,
    srcW,
    srcH,
    HEATMAP_GRID_DEFAULT.w,
    HEATMAP_GRID_DEFAULT.h,
  );
  return {
    ok: true,
    clipped,
    reason: null,
    clip_reason: clipped ? 'heatmap_clamped_or_resampled' : null,
    heatmap: {
      coord_space: FACE_COORD_SPACE,
      grid: { w: HEATMAP_GRID_DEFAULT.w, h: HEATMAP_GRID_DEFAULT.h },
      values: resizedValues,
      value_range: { min: 0, max: 1 },
      smoothing_hint: 'bilinear',
    },
  };
}

function computeBoxOverlapRatio(moduleBox, regionBox) {
  const x0 = Math.max(moduleBox.x, regionBox.x);
  const y0 = Math.max(moduleBox.y, regionBox.y);
  const x1 = Math.min(moduleBox.x + moduleBox.w, regionBox.x + regionBox.w);
  const y1 = Math.min(moduleBox.y + moduleBox.h, regionBox.y + regionBox.h);
  const iw = x1 - x0;
  const ih = y1 - y0;
  if (iw <= 0 || ih <= 0) return 0;
  const intersection = iw * ih;
  const regionArea = Math.max(1e-6, regionBox.w * regionBox.h);
  return clamp01(intersection / regionArea);
}

function heatmapStatsInModule(heatmap, moduleBox) {
  if (!heatmap || !heatmap.grid || !Array.isArray(heatmap.values)) return { mean: 0, p90: 0 };
  const width = Math.max(1, Math.trunc(Number(heatmap.grid.w || 0)));
  const height = Math.max(1, Math.trunc(Number(heatmap.grid.h || 0)));
  if (heatmap.values.length < width * height) return { mean: 0, p90: 0 };

  const x0 = Math.max(0, Math.min(width - 1, Math.floor(moduleBox.x * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(moduleBox.y * height)));
  const x1 = Math.max(0, Math.min(width, Math.ceil((moduleBox.x + moduleBox.w) * width)));
  const y1 = Math.max(0, Math.min(height, Math.ceil((moduleBox.y + moduleBox.h) * height)));
  if (x1 <= x0 || y1 <= y0) return { mean: 0, p90: 0 };

  const values = [];
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = clamp01(Number(heatmap.values[y * width + x] || 0));
      values.push(value);
      sum += value;
      count += 1;
    }
  }
  if (!count) return { mean: 0, p90: 0 };

  values.sort((a, b) => a - b);
  const p90Index = Math.min(values.length - 1, Math.floor(0.9 * (values.length - 1)));
  return {
    mean: clamp01(sum / count),
    p90: clamp01(values[p90Index]),
  };
}

function qualityFlagsFromReasons(qualityReasons) {
  const reasons = Array.isArray(qualityReasons) ? qualityReasons.map((item) => String(item || '').toLowerCase()) : [];
  const flags = [];
  if (reasons.some((reason) => reason.includes('bright') || reason.includes('glare') || reason.includes('specular'))) {
    flags.push('glare_confounded');
  }
  if (reasons.some((reason) => reason.includes('shadow') || reason.includes('dark'))) {
    flags.push('shadow_confounded');
  }
  if (reasons.some((reason) => reason.includes('filter') || reason.includes('beauty'))) {
    flags.push('filter_suspected');
  }
  if (reasons.some((reason) => reason.includes('blur'))) {
    flags.push('blurred');
  }
  return flags;
}

function countBy(items, keyFields) {
  const counter = new Map();
  for (const item of items) {
    const labels = keyFields.map((field) => String(item[field] || 'unknown'));
    const key = JSON.stringify(labels);
    counter.set(key, (counter.get(key) || 0) + 1);
  }
  const out = [];
  for (const [key, value] of counter.entries()) {
    const labels = JSON.parse(key);
    const row = {};
    keyFields.forEach((field, index) => {
      row[field] = labels[index];
    });
    row.count = value;
    out.push(row);
  }
  return out;
}

function buildCropId(faceCrop) {
  const bbox = faceCrop && faceCrop.bbox_px && typeof faceCrop.bbox_px === 'object' ? faceCrop.bbox_px : {};
  const size = faceCrop && faceCrop.orig_size_px && typeof faceCrop.orig_size_px === 'object' ? faceCrop.orig_size_px : {};
  const signature = `${size.w || 0}:${size.h || 0}:${bbox.x || 0}:${bbox.y || 0}:${bbox.w || 0}:${bbox.h || 0}`;
  return `crop_${crypto.createHash('sha1').update(signature).digest('hex').slice(0, 16)}`;
}

function normalizeFaceCrop(faceCropRaw) {
  const raw = faceCropRaw && typeof faceCropRaw === 'object' ? faceCropRaw : {};
  const bboxRaw = raw.bbox_px && typeof raw.bbox_px === 'object' ? raw.bbox_px : null;
  const origRaw = raw.orig_size_px && typeof raw.orig_size_px === 'object' ? raw.orig_size_px : null;
  const hintRaw = raw.render_size_px_hint && typeof raw.render_size_px_hint === 'object' ? raw.render_size_px_hint : null;

  const bbox = {
    x: Math.max(0, Math.trunc(Number(bboxRaw && bboxRaw.x))),
    y: Math.max(0, Math.trunc(Number(bboxRaw && bboxRaw.y))),
    w: Math.max(1, Math.trunc(Number(bboxRaw && bboxRaw.w))),
    h: Math.max(1, Math.trunc(Number(bboxRaw && bboxRaw.h))),
  };
  const orig = {
    w: Math.max(1, Math.trunc(Number(origRaw && origRaw.w))),
    h: Math.max(1, Math.trunc(Number(origRaw && origRaw.h))),
  };

  const hintW = Math.max(1, Math.trunc(Number(hintRaw && hintRaw.w)));
  const hintH = Math.max(1, Math.trunc(Number(hintRaw && hintRaw.h)));
  const renderHint = {
    w: Number.isFinite(hintW) && hintW > 0 ? hintW : 512,
    h: Number.isFinite(hintH) && hintH > 0 ? hintH : 512,
  };

  const normalized = {
    crop_id: typeof raw.crop_id === 'string' && raw.crop_id.trim() ? raw.crop_id.trim() : null,
    coord_space: 'orig_px_v1',
    bbox_px: bbox,
    orig_size_px: orig,
    render_size_px_hint: renderHint,
  };
  if (!normalized.crop_id) normalized.crop_id = buildCropId(normalized);
  return normalized;
}

function normalizeIssueType(issueType) {
  const token = String(issueType || '').trim().toLowerCase();
  if (SUPPORTED_ISSUES.has(token)) return token;
  if (token === 'pores') return 'texture';
  if (token === 'dark_spots') return 'tone';
  return null;
}

function qualityFactorForModule(qualityGrade) {
  if (qualityGrade === 'degraded') return 0.82;
  if (qualityGrade === 'pass') return 1;
  return 0.7;
}

function moduleIdToLabel(moduleId, language) {
  const lang = normalizeLanguage(language);
  const map = {
    forehead: { EN: 'forehead', CN: '额头' },
    left_cheek: { EN: 'left cheek', CN: '左脸颊' },
    right_cheek: { EN: 'right cheek', CN: '右脸颊' },
    nose: { EN: 'nose', CN: '鼻部' },
    chin: { EN: 'chin', CN: '下巴' },
    under_eye_left: { EN: 'left under-eye', CN: '左眼下' },
    under_eye_right: { EN: 'right under-eye', CN: '右眼下' },
  };
  return map[moduleId] ? map[moduleId][lang] : moduleId;
}

function buildIssueExplanation({ moduleId, issueType, evidenceRegionIds, language, market } = {}) {
  const lang = normalizeLanguage(language);
  const templateLang = lang === 'CN' ? 'zh' : 'en';
  const moduleLabel = moduleIdToLabel(moduleId, lang);
  const normalizedMarket = String(market || '').trim().toUpperCase() || (lang === 'CN' ? 'CN' : 'US');
  const rendered = renderAllowedTemplate({
    templateType: 'module_explanation_short',
    issueType,
    moduleLabel,
    lang: templateLang,
    market: normalizedMarket,
  });
  return {
    text: rendered.text,
    templateKey: rendered.template_key,
    fallback: Boolean(rendered.fallback),
    reason: rendered.reason || 'ok',
    violations: Array.isArray(rendered.violations) ? rendered.violations : [],
  };
}

function computeRegionStyle({ severity0to4, confidence0to1, issueType } = {}) {
  const severityScore = clamp01(normalizeSeverity0to4(severity0to4) / 4);
  const confidence = clamp01(confidence0to1);
  return {
    intensity: round3(clamp01(severityScore * 0.7 + confidence * 0.3)),
    priority: round3(clamp01(severityScore * 0.8 + confidence * 0.2)),
    label_hint: String(issueType || 'signal'),
  };
}

function buildRegionsFromFindings({ findings, qualityFlags } = {}) {
  const safeFindings = Array.isArray(findings) ? findings : [];
  const regions = [];
  const regionMeta = new Map();
  const drops = [];
  const clips = [];

  function drop(reason, regionType) {
    drops.push({ reason, region_type: regionType || 'unknown' });
  }

  function clip(reason, regionType) {
    clips.push({ reason, region_type: regionType || 'unknown' });
  }

  for (let i = 0; i < safeFindings.length; i += 1) {
    const finding = safeFindings[i];
    if (!finding || typeof finding !== 'object') continue;
    const issueType = normalizeIssueType(finding.issue_type);
    if (!issueType) continue;

    const findingId =
      typeof finding.finding_id === 'string' && finding.finding_id.trim()
        ? finding.finding_id.trim()
        : `finding_${i + 1}`;
    const severity = normalizeSeverity0to4(finding.severity);
    const confidence = clamp01(Number(finding.confidence));
    const style = computeRegionStyle({ severity0to4: severity, confidence0to1: confidence, issueType });
    const geometry = finding.geometry && typeof finding.geometry === 'object' ? finding.geometry : null;
    if (!geometry) {
      drop('geometry_missing', 'unknown');
      continue;
    }

    const rawBBox = geometry.bbox_norm ? toBBoxFromNorm(geometry.bbox_norm) : geometry.bbox;
    if (rawBBox) {
      const bbox = sanitizeBBox(rawBBox);
      if (!bbox.ok || !bbox.bbox) {
        drop(bbox.reason || 'bbox_invalid', 'bbox');
      } else {
        const regionId = `${findingId}_bbox`;
        const notes = [];
        if (bbox.clipped) {
          const clipReason = bbox.clip_reason || 'bbox_clipped';
          notes.push(clipReason);
          clip(clipReason, 'bbox');
        }
        const region = {
          region_id: regionId,
          type: 'bbox',
          coord_space: FACE_COORD_SPACE,
          bbox: bbox.bbox,
          style,
          ...(notes.length ? { notes } : {}),
          ...(qualityFlags.length ? { quality_flags: qualityFlags.slice(0, 4) } : {}),
        };
        regions.push(region);
        regionMeta.set(regionId, {
          issue_type: issueType,
          severity_0_4: severity,
          confidence_0_1: confidence,
          region_type: 'bbox',
          bbox: bbox.bbox,
          heatmap: null,
        });
      }
    }

    if (geometry.polygon && typeof geometry.polygon === 'object') {
      const polygon = sanitizePolygon(geometry.polygon);
      if (!polygon.ok || !polygon.polygon) {
        drop(polygon.reason || 'polygon_invalid', 'polygon');
      } else {
        const regionId = `${findingId}_polygon`;
        const notes = [];
        if (polygon.clipped) {
          const clipReason = polygon.clip_reason || 'polygon_clipped';
          notes.push(clipReason);
          clip(clipReason, 'polygon');
        }
        const region = {
          region_id: regionId,
          type: 'polygon',
          coord_space: FACE_COORD_SPACE,
          polygon: polygon.polygon,
          style,
          ...(notes.length ? { notes } : {}),
          ...(qualityFlags.length ? { quality_flags: qualityFlags.slice(0, 4) } : {}),
        };
        regions.push(region);
        regionMeta.set(regionId, {
          issue_type: issueType,
          severity_0_4: severity,
          confidence_0_1: confidence,
          region_type: 'polygon',
          bbox: polygon.bbox,
          heatmap: null,
        });
      }
    }

    const maybeHeatmap =
      geometry &&
      ((geometry.type === 'grid' && Number.isFinite(Number(geometry.rows)) && Number.isFinite(Number(geometry.cols)) && Array.isArray(geometry.values))
        ? { grid: { w: Number(geometry.cols), h: Number(geometry.rows) }, values: geometry.values }
        : geometry.heatmap && typeof geometry.heatmap === 'object'
          ? geometry.heatmap
          : null);

    if (maybeHeatmap) {
      const heatmap = sanitizeHeatmap(maybeHeatmap);
      if (!heatmap.ok || !heatmap.heatmap) {
        drop(heatmap.reason || 'heatmap_invalid', 'heatmap');
      } else {
        const regionId = `${findingId}_heatmap`;
        const notes = [];
        if (heatmap.clipped) {
          const clipReason = heatmap.clip_reason || 'heatmap_clipped';
          notes.push(clipReason);
          clip(clipReason, 'heatmap');
        }
        const region = {
          region_id: regionId,
          type: 'heatmap',
          coord_space: FACE_COORD_SPACE,
          heatmap: heatmap.heatmap,
          style,
          ...(notes.length ? { notes } : {}),
          ...(qualityFlags.length ? { quality_flags: qualityFlags.slice(0, 4) } : {}),
        };
        regions.push(region);
        regionMeta.set(regionId, {
          issue_type: issueType,
          severity_0_4: severity,
          confidence_0_1: confidence,
          region_type: 'heatmap',
          bbox: rawBBox ? sanitizeBBox(rawBBox).bbox : null,
          heatmap: heatmap.heatmap,
        });
      }
    }
  }

  return {
    regions: regions.slice(0, 120),
    regionMeta,
    geometryCounts: countBy([...drops, ...clips], ['reason', 'region_type']),
  };
}

function moduleContribution({ moduleBox, region, meta } = {}) {
  if (!moduleBox || !region || !meta) return null;
  if (meta.region_type === 'heatmap' && region.heatmap) {
    const stats = heatmapStatsInModule(region.heatmap, moduleBox);
    const overlap = Math.max(stats.mean, stats.p90);
    if (overlap <= 0.02) return null;
    return {
      overlap,
      signalScore: clamp01(Math.max(stats.mean, stats.p90)),
      severityScore: clamp01(normalizeSeverity0to4(meta.severity_0_4) / 4),
      confidence: clamp01(meta.confidence_0_1),
    };
  }

  const regionBox = meta.bbox;
  if (!regionBox) return null;
  const overlap = computeBoxOverlapRatio(moduleBox, regionBox);
  if (overlap <= 0.03) return null;
  return {
    overlap,
    signalScore: clamp01(normalizeSeverity0to4(meta.severity_0_4) / 4),
    severityScore: clamp01(normalizeSeverity0to4(meta.severity_0_4) / 4),
    confidence: clamp01(meta.confidence_0_1),
  };
}

function buildModuleIssues({
  moduleId,
  moduleBox,
  regions,
  regionMeta,
  qualityGrade,
  language,
  profileSummary,
  market,
  riskTier,
  ingredientRecEnabled,
  productRecEnabled,
  productRecMinCitations,
  productRecMinEvidenceGrade,
  productRecRepairOnlyWhenDegraded,
  internalTestMode,
  ingredientKbArtifactPath,
  productCatalogPath,
} = {}) {
  const issueBucket = new Map();

  for (const region of regions) {
    const meta = regionMeta.get(region.region_id);
    if (!meta || !meta.issue_type) continue;
    const contribution = moduleContribution({ moduleBox, region, meta });
    if (!contribution) continue;

    const issueType = meta.issue_type;
    const list = issueBucket.get(issueType) || [];
    list.push({
      region_id: region.region_id,
      overlap: contribution.overlap,
      signalScore: contribution.signalScore,
      severityScore: contribution.severityScore,
      confidence: contribution.confidence,
    });
    issueBucket.set(issueType, list);
  }

  const moduleIssues = [];
  const actions = [];
  const templateFallbackRows = [];
  const claimsViolationRows = [];
  const qualityFactor = qualityFactorForModule(qualityGrade);

  for (const [issueType, list] of issueBucket.entries()) {
    if (!list.length) continue;
    const weightSum = list.reduce((acc, item) => acc + item.overlap, 0);
    if (weightSum <= 0) continue;

    const weightedMean = list.reduce((acc, item) => acc + item.signalScore * item.overlap, 0) / weightSum;
    const sorted = list.slice().sort((a, b) => a.signalScore - b.signalScore);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * (sorted.length - 1)))].signalScore;
    const severityScore = clamp01(Math.max(weightedMean, p90));
    const severity0to4 = round3(clamp01(severityScore) * 4);

    const confidenceRaw = Math.max(...list.map((item) => item.confidence));
    const confidence0to1 = round3(clamp01(confidenceRaw * qualityFactor));
    const evidenceRegionIds = list
      .slice()
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3)
      .map((item) => item.region_id);
    const explanation = buildIssueExplanation({ moduleId, issueType, evidenceRegionIds, language, market });
    if (explanation.fallback) {
      templateFallbackRows.push({
        reason: String(explanation.reason || 'unknown'),
      });
    }
    if (String(explanation.reason || '').toLowerCase() === 'banned_terms') {
      claimsViolationRows.push({ reason: 'banned_terms' });
    }

    moduleIssues.push({
      issue_type: issueType,
      severity_0_4: severity0to4,
      confidence_0_1: confidence0to1,
      evidence_region_ids: evidenceRegionIds,
      explanation_short: explanation.text,
      explanation_template_key: explanation.templateKey,
      explanation_template_fallback: explanation.fallback,
      explanation_template_reason: explanation.reason,
    });

    if (ingredientRecEnabled) {
      const ingredientActions = mapIngredientActions({
        issueType,
        evidenceRegionIds,
        language,
        barrierStatus: profileSummary && profileSummary.barrierStatus,
        sensitivity: profileSummary && profileSummary.sensitivity,
        market,
        contraindications: profileSummary && profileSummary.contraindications,
        internalTestMode,
      });
      for (const action of ingredientActions) {
        actions.push(action);
        if (action && action.why_template_fallback) {
          templateFallbackRows.push({
            reason: String(action.why_template_reason || 'unknown'),
          });
        }
        if (String(action && action.why_template_reason ? action.why_template_reason : '').toLowerCase() === 'banned_terms') {
          claimsViolationRows.push({ reason: 'banned_terms' });
        }
      }
    }
  }

  let products = [];
  let productSuppressedReason = null;
  let productRecDebug = null;
  if (productRecEnabled) {
    const productRecResult = buildProductRecommendations({
      moduleId,
      issues: moduleIssues,
      actions,
      market,
      lang: normalizeLanguage(language) === 'CN' ? 'zh' : 'en',
      riskTier,
      qualityGrade,
      minCitations: productRecMinCitations,
      minEvidenceGrade: productRecMinEvidenceGrade,
      repairOnlyWhenDegraded: productRecRepairOnlyWhenDegraded,
      internalTestMode,
      artifactPath: ingredientKbArtifactPath,
      catalogPath: productCatalogPath,
    });
    products = Array.isArray(productRecResult.products) ? productRecResult.products.slice(0, 3) : [];
    productSuppressedReason = productRecResult.suppressed_reason || null;
    productRecDebug = productRecResult.debug || null;
    for (const product of products) {
      if (product && product.why_match_template_fallback) {
        templateFallbackRows.push({
          reason: String(product.why_match_template_reason || 'unknown'),
        });
      }
      if (String(product && product.why_match_template_reason ? product.why_match_template_reason : '').toLowerCase() === 'banned_terms') {
        claimsViolationRows.push({ reason: 'banned_terms' });
      }
    }
  }

  return {
    issues: moduleIssues.sort((a, b) => b.severity_0_4 - a.severity_0_4).slice(0, 4),
    actions,
    products,
    productSuppressedReason,
    productRecDebug,
    templateFallbackRows,
    claimsViolationRows,
  };
}

function buildModules({
  regions,
  regionMeta,
  qualityGrade,
  language,
  profileSummary,
  ingredientRecEnabled,
  productRecEnabled,
  productRecMinCitations,
  productRecMinEvidenceGrade,
  productRecRepairOnlyWhenDegraded,
  internalTestMode,
  ingredientKbArtifactPath,
  productCatalogPath,
} = {}) {
  const modules = [];
  const moduleIssueRows = [];
  const ingredientRows = [];
  const productRecEmittedRows = [];
  const productRecSuppressedRows = [];
  const claimsTemplateFallbackRows = [];
  const claimsViolationRows = [];
  const lang = normalizeLanguage(language);
  const market = String((profileSummary && profileSummary.region) || (lang === 'CN' ? 'CN' : 'US'))
    .trim()
    .toUpperCase();
  const riskTier = inferRiskTier({
    barrierStatus: profileSummary && profileSummary.barrierStatus,
    sensitivity: profileSummary && profileSummary.sensitivity,
    contraindications: profileSummary && profileSummary.contraindications,
  });

  for (const [moduleId, moduleBoxRaw] of Object.entries(MODULE_BOXES)) {
    const moduleBoxSanitized = sanitizeBBox(moduleBoxRaw);
    if (!moduleBoxSanitized.ok || !moduleBoxSanitized.bbox) continue;
    const moduleBox = moduleBoxSanitized.bbox;

    const result = buildModuleIssues({
      moduleId,
      moduleBox,
      regions,
      regionMeta,
      qualityGrade,
      language,
      profileSummary,
      market,
      riskTier,
      ingredientRecEnabled,
      productRecEnabled,
      productRecMinCitations,
      productRecMinEvidenceGrade,
      productRecRepairOnlyWhenDegraded,
      internalTestMode,
      ingredientKbArtifactPath,
      productCatalogPath,
    });

    const issues = Array.isArray(result.issues) ? result.issues : [];
    const actions = Array.isArray(result.actions) ? result.actions : [];
    const products = Array.isArray(result.products) ? result.products : [];
    for (const issue of issues) {
      moduleIssueRows.push({ module_id: moduleId, issue_type: issue.issue_type });
    }
    for (const action of actions) {
      const issueType = Array.isArray(action.evidence_issue_types) && action.evidence_issue_types[0]
        ? action.evidence_issue_types[0]
        : 'unknown';
      ingredientRows.push({ module_id: moduleId, issue_type: issueType });
    }
    for (const row of Array.isArray(result.templateFallbackRows) ? result.templateFallbackRows : []) {
      claimsTemplateFallbackRows.push({ reason: String(row && row.reason ? row.reason : 'unknown') });
    }
    for (const row of Array.isArray(result.claimsViolationRows) ? result.claimsViolationRows : []) {
      claimsViolationRows.push({ reason: String(row && row.reason ? row.reason : 'unknown') });
    }
    if (productRecEnabled) {
      for (const _product of products) {
        productRecEmittedRows.push({
          market,
          quality_grade: normalizeQualityGrade(qualityGrade),
        });
      }
      if (result.productSuppressedReason) {
        productRecSuppressedRows.push({
          reason: String(result.productSuppressedReason || 'unknown'),
        });
      }
    }

    const modulePayload = {
      module_id: moduleId,
      issues,
      actions,
      ...(productRecEnabled ? { products } : {}),
    };
    if (internalTestMode) {
      modulePayload.internal_debug = {
        market,
        risk_tier: riskTier,
        product_suppressed_reason: result.productSuppressedReason,
        product_rec: result.productRecDebug,
      };
    }

    modules.push(modulePayload);
  }

  return {
    modules,
    moduleIssueCounts: countBy(moduleIssueRows, ['module_id', 'issue_type']),
    ingredientActionCounts: countBy(ingredientRows, ['module_id', 'issue_type']),
    productRecEmittedCounts: countBy(productRecEmittedRows, ['market', 'quality_grade']),
    productRecSuppressedCounts: countBy(productRecSuppressedRows, ['reason']),
    claimsTemplateFallbackCounts: countBy(claimsTemplateFallbackRows, ['reason']),
    claimsViolationCounts: countBy(claimsViolationRows, ['reason']),
    market,
    riskTier,
  };
}

function pickRenderHint(width, height) {
  const w = Math.max(1, Math.trunc(Number(width)));
  const h = Math.max(1, Math.trunc(Number(height)));
  const maxEdge = Math.max(w, h);
  if (maxEdge <= 512) return { w, h };
  const ratio = 512 / maxEdge;
  return {
    w: Math.max(1, Math.round(w * ratio)),
    h: Math.max(1, Math.round(h * ratio)),
  };
}

function buildFaceCropFromSkinBBox({ skinBBoxNorm, origSizePx, marginScale } = {}) {
  const skin = skinBBoxNorm && typeof skinBBoxNorm === 'object' ? skinBBoxNorm : null;
  const size = origSizePx && typeof origSizePx === 'object' ? origSizePx : null;
  const width = Math.max(1, Math.trunc(Number(size && size.w)));
  const height = Math.max(1, Math.trunc(Number(size && size.h)));
  if (!skin || !width || !height) return null;

  const x0Raw = clamp01(Number(skin.x0));
  const y0Raw = clamp01(Number(skin.y0));
  const x1Raw = clamp01(Number(skin.x1));
  const y1Raw = clamp01(Number(skin.y1));
  const x0 = Math.min(x0Raw, x1Raw);
  const y0 = Math.min(y0Raw, y1Raw);
  const x1 = Math.max(x0Raw, x1Raw);
  const y1 = Math.max(y0Raw, y1Raw);
  const baseW = Math.max(0.01, x1 - x0);
  const baseH = Math.max(0.01, y1 - y0);

  const scale = Number.isFinite(Number(marginScale)) && Number(marginScale) > 0 ? Number(marginScale) : 1.2;
  const centerX = x0 + baseW / 2;
  const centerY = y0 + baseH / 2;
  const cropW = Math.min(1, baseW * scale);
  const cropH = Math.min(1, baseH * scale);
  const cropX0 = clamp01(centerX - cropW / 2);
  const cropY0 = clamp01(centerY - cropH / 2);
  const cropX1 = clamp01(cropX0 + cropW);
  const cropY1 = clamp01(cropY0 + cropH);

  const pxX = Math.max(0, Math.floor(cropX0 * width));
  const pxY = Math.max(0, Math.floor(cropY0 * height));
  const pxW = Math.max(1, Math.round((cropX1 - cropX0) * width));
  const pxH = Math.max(1, Math.round((cropY1 - cropY0) * height));
  const boundedW = Math.max(1, Math.min(width - pxX, pxW));
  const boundedH = Math.max(1, Math.min(height - pxY, pxH));

  return normalizeFaceCrop({
    coord_space: 'orig_px_v1',
    bbox_px: { x: pxX, y: pxY, w: boundedW, h: boundedH },
    orig_size_px: { w: width, h: height },
    render_size_px_hint: pickRenderHint(boundedW, boundedH),
  });
}

function normalizeFaceCropFromInternal(diagnosisInternal) {
  const internal = diagnosisInternal && typeof diagnosisInternal === 'object' ? diagnosisInternal : {};
  const existing = internal.face_crop && typeof internal.face_crop === 'object' ? internal.face_crop : null;
  if (existing) return normalizeFaceCrop(existing);

  const fromSkinBBox = buildFaceCropFromSkinBBox({
    skinBBoxNorm: internal.skin_bbox_norm,
    origSizePx: internal.orig_size_px,
    marginScale: Number(internal.face_crop_margin_scale || 1.2),
  });
  if (fromSkinBBox) return fromSkinBBox;

  const origW = Math.max(1, Math.trunc(Number(internal.orig_size_px && internal.orig_size_px.w)));
  const origH = Math.max(1, Math.trunc(Number(internal.orig_size_px && internal.orig_size_px.h)));
  const fallbackW = Number.isFinite(origW) && origW > 0 ? origW : 1;
  const fallbackH = Number.isFinite(origH) && origH > 0 ? origH : 1;
  return normalizeFaceCrop({
    coord_space: 'orig_px_v1',
    bbox_px: { x: 0, y: 0, w: fallbackW, h: fallbackH },
    orig_size_px: { w: fallbackW, h: fallbackH },
    render_size_px_hint: pickRenderHint(fallbackW, fallbackH),
  });
}

function normalizeMaskGridSize(value, fallback = MODULE_MASK_GRID_SIZE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(32, Math.min(256, Math.trunc(n)));
}

function buildRegionMask(region, gridSize) {
  const empty = createMask(gridSize, gridSize, 0);
  if (!region || typeof region !== 'object') return empty;
  if (region.bbox && typeof region.bbox === 'object') {
    const bboxMask = bboxNormToMask(region.bbox, gridSize, gridSize);
    orMaskInto(empty, bboxMask);
  }
  if (region.polygon && typeof region.polygon === 'object') {
    const polygonMask = polygonNormToMask(region.polygon, gridSize, gridSize);
    orMaskInto(empty, polygonMask);
  }
  if (region.heatmap && typeof region.heatmap === 'object') {
    const grid = region.heatmap.grid && typeof region.heatmap.grid === 'object' ? region.heatmap.grid : {};
    const heatMask = resizeHeatmapToMask(
      Array.isArray(region.heatmap.values) ? region.heatmap.values : [],
      Number(grid.w || 64),
      Number(grid.h || 64),
      gridSize,
      gridSize,
      0.35,
      clamp01(region.style && Number(region.style.intensity)) || 1,
    );
    orMaskInto(empty, heatMask);
  }
  return empty;
}

function decodeSkinMaskToGrid(skinMask, gridSize) {
  if (!skinMask || typeof skinMask !== 'object') return null;
  const targetGrid = normalizeMaskGridSize(gridSize, MODULE_MASK_GRID_SIZE);
  const maskGrid = normalizeMaskGridSize(skinMask.mask_grid, targetGrid);
  if (typeof skinMask.mask_rle_norm === 'string' && skinMask.mask_rle_norm.trim()) {
    const decoded = decodeRleBinary(skinMask.mask_rle_norm, maskGrid * maskGrid);
    if (maskGrid === targetGrid) return decoded;
    const resized = resizeHeatmapToMask(Array.from(decoded), maskGrid, maskGrid, targetGrid, targetGrid, 0.5, 1);
    return resized;
  }
  if (skinMask.heatmap && typeof skinMask.heatmap === 'object') {
    const heatmap = skinMask.heatmap;
    const grid = heatmap.grid && typeof heatmap.grid === 'object' ? heatmap.grid : {};
    return resizeHeatmapToMask(
      Array.isArray(heatmap.values) ? heatmap.values : [],
      Number(grid.w || maskGrid),
      Number(grid.h || maskGrid),
      targetGrid,
      targetGrid,
      clamp01(heatmap.threshold || 0.5),
      1,
    );
  }
  if (skinMask.bbox && typeof skinMask.bbox === 'object') {
    return bboxNormToMask(skinMask.bbox, targetGrid, targetGrid);
  }
  return null;
}

function collectEvidenceRegionIds(moduleRow) {
  const ids = new Set();
  if (!moduleRow || typeof moduleRow !== 'object') return ids;
  const issueRows = Array.isArray(moduleRow.issues) ? moduleRow.issues : [];
  for (const issue of issueRows) {
    const evidenceIds = Array.isArray(issue && issue.evidence_region_ids) ? issue.evidence_region_ids : [];
    for (const evidenceId of evidenceIds) {
      const token = String(evidenceId || '').trim();
      if (token) ids.add(token);
    }
  }
  const moduleEvidenceIds = Array.isArray(moduleRow.evidence_region_ids) ? moduleRow.evidence_region_ids : [];
  for (const evidenceId of moduleEvidenceIds) {
    const token = String(evidenceId || '').trim();
    if (token) ids.add(token);
  }
  return ids;
}

function maskBoundingBox(mask, gridSize) {
  if (!(mask instanceof Uint8Array) || !mask.length) return null;
  let minX = gridSize;
  let minY = gridSize;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      if (!mask[y * gridSize + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  const raw = {
    x: minX / gridSize,
    y: minY / gridSize,
    w: (maxX + 1 - minX) / gridSize,
    h: (maxY + 1 - minY) / gridSize,
  };
  const sanitized = sanitizeBBox(raw);
  return sanitized.ok ? sanitized.bbox : null;
}

function moduleShrinkScale(moduleId) {
  const token = String(moduleId || '').trim().toLowerCase();
  if (token === 'chin') return MODULE_SHRINK_CHIN;
  if (token === 'forehead') return MODULE_SHRINK_FOREHEAD;
  if (token === 'left_cheek' || token === 'right_cheek') return MODULE_SHRINK_CHEEK;
  return 1;
}

function shrinkModuleBox(boxRaw, scale) {
  const sanitized = sanitizeBBox(boxRaw);
  if (!sanitized.ok || !sanitized.bbox) return null;
  if (!Number.isFinite(Number(scale)) || Number(scale) >= 0.999) return sanitized.bbox;
  const box = sanitized.bbox;
  const factor = Math.max(0.5, Math.min(1, Number(scale)));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const shrunkRaw = {
    x: cx - (box.w * factor) / 2,
    y: cy - (box.h * factor) / 2,
    w: box.w * factor,
    h: box.h * factor,
  };
  const shrunk = sanitizeBBox(shrunkRaw);
  return shrunk.ok ? shrunk.bbox : sanitized.bbox;
}

function attachModuleMasks({
  modules,
  regions,
  skinMask,
  moduleBoxes,
  gridSize,
} = {}) {
  const safeModules = Array.isArray(modules) ? modules : [];
  const safeRegions = Array.isArray(regions) ? regions : [];
  const activeModuleBoxes = moduleBoxes && typeof moduleBoxes === 'object' ? moduleBoxes : MODULE_BOXES;
  const moduleIds = Object.keys(activeModuleBoxes);
  const effectiveModuleBoxes = {};
  for (const moduleId of moduleIds) {
    const baseBox = activeModuleBoxes[moduleId];
    const scale = moduleShrinkScale(moduleId);
    const adjusted = shrinkModuleBox(baseBox, scale);
    if (adjusted) effectiveModuleBoxes[moduleId] = adjusted;
  }
  const targetGrid = normalizeMaskGridSize(gridSize, MODULE_MASK_GRID_SIZE);

  const regionMaskMap = new Map();
  for (const region of safeRegions) {
    const regionId = String(region && region.region_id ? region.region_id : '').trim();
    if (!regionId) continue;
    regionMaskMap.set(regionId, buildRegionMask(region, targetGrid));
  }

  const skinMaskNorm = decodeSkinMaskToGrid(skinMask, targetGrid);
  const faceOvalMask = FACE_OVAL_CLIP_ENABLED ? polygonNormToMask(FACE_OVAL_POLYGON, targetGrid, targetGrid) : null;
  const skinMaskPositiveRatio = skinMask && Number.isFinite(Number(skinMask.positive_ratio))
    ? Number(skinMask.positive_ratio)
    : skinMaskNorm
      ? countOnes(skinMaskNorm) / Math.max(1, targetGrid * targetGrid)
      : 0;
  const skinMaskReliable =
    Boolean(skinMaskNorm) &&
    skinMaskPositiveRatio >= MODULE_SKIN_POSITIVE_RATIO_MIN &&
    skinMaskPositiveRatio <= MODULE_SKIN_POSITIVE_RATIO_MAX;
  let refinedModules = 0;
  let fallbackSkippedModules = 0;

  const modulesOut = safeModules.map((moduleRow) => {
    const modulePayload = moduleRow && typeof moduleRow === 'object' ? { ...moduleRow } : {};
    const moduleId = String(modulePayload.module_id || '').trim();
    if (!moduleId || !moduleIds.includes(moduleId)) return modulePayload;
    const moduleBaseBox = effectiveModuleBoxes[moduleId] || activeModuleBoxes[moduleId] || MODULE_BOXES[moduleId];
    const modulePolygonMask = moduleBaseBox ? bboxNormToMask(moduleBaseBox, targetGrid, targetGrid) : createMask(targetGrid, targetGrid, 0);

    const moduleMask = createMask(targetGrid, targetGrid, 0);
    const evidenceIds = collectEvidenceRegionIds(modulePayload);
    for (const evidenceId of evidenceIds) {
      const regionMask = regionMaskMap.get(evidenceId);
      if (regionMask) orMaskInto(moduleMask, regionMask);
    }

    if (countOnes(moduleMask) && countOnes(modulePolygonMask)) {
      const constrained = andMasks(moduleMask, modulePolygonMask);
      if (countOnes(constrained)) {
        moduleMask.set(constrained);
      } else {
        moduleMask.set(modulePolygonMask);
      }
    }

    if (!countOnes(moduleMask) && countOnes(modulePolygonMask)) {
      moduleMask.set(modulePolygonMask);
    }

    let finalMask = moduleMask;
    if (faceOvalMask) {
      const clippedMask = andMasks(finalMask, faceOvalMask);
      if (countOnes(clippedMask)) {
        finalMask = clippedMask;
      } else if (countOnes(modulePolygonMask)) {
        finalMask = andMasks(modulePolygonMask, faceOvalMask);
      }
    }

    if (skinMaskNorm && skinMaskReliable) {
      const intersected = andMasks(finalMask, skinMaskNorm);
      const modulePixels = countOnes(finalMask);
      const intersectedPixels = countOnes(intersected);
      const keepThreshold = Math.max(
        MODULE_SKIN_INTERSECTION_MIN_PIXELS,
        Math.trunc(modulePixels * MODULE_SKIN_INTERSECTION_MIN_RATIO),
      );
      if (intersectedPixels >= keepThreshold) {
        finalMask = intersected;
        refinedModules += 1;
      } else {
        fallbackSkippedModules += 1;
      }
    }

    const box = maskBoundingBox(finalMask, targetGrid) || modulePayload.box || moduleBaseBox || null;
    return {
      ...modulePayload,
      ...(box ? { box } : {}),
      ...(evidenceIds.size ? { evidence_region_ids: Array.from(evidenceIds) } : {}),
      mask_grid: targetGrid,
      mask_rle_norm: encodeRleBinary(finalMask),
    };
  });

  return {
    modules: modulesOut,
    skinmask_refined_modules: refinedModules,
    skinmask_skipped_modules: fallbackSkippedModules,
    skinmask_grid: targetGrid,
    skinmask_available: Boolean(skinMaskNorm),
    skinmask_reliable: Boolean(skinMaskReliable),
    skinmask_positive_ratio: Number.isFinite(skinMaskPositiveRatio) ? round3(skinMaskPositiveRatio) : null,
  };
}

function buildPhotoModulesCard({
  requestId,
  analysis,
  usedPhotos,
  photoQuality,
  photoNotice,
  diagnosisInternal,
  profileSummary,
  language,
  ingredientRecEnabled,
  productRecEnabled,
  productRecMinCitations,
  productRecMinEvidenceGrade,
  productRecRepairOnlyWhenDegraded,
  internalTestMode,
  ingredientKbArtifactPath,
  productCatalogPath,
  skinMask,
} = {}) {
  const qualityGrade = normalizeQualityGrade(photoQuality && photoQuality.grade);
  if (!usedPhotos) return null;
  if (qualityGrade !== 'pass' && qualityGrade !== 'degraded') return null;

  const baseAnalysis = analysis && typeof analysis === 'object' ? analysis : {};
  const findings = Array.isArray(baseAnalysis.photo_findings)
    ? baseAnalysis.photo_findings
    : Array.isArray(baseAnalysis.findings)
      ? baseAnalysis.findings
      : [];

  const qualityReasons =
    photoQuality && Array.isArray(photoQuality.reasons)
      ? photoQuality.reasons
      : [];
  const qualityFlags = qualityFlagsFromReasons(qualityReasons);

  const faceCrop = normalizeFaceCropFromInternal(diagnosisInternal);
  const regionBuild = buildRegionsFromFindings({ findings, qualityFlags });
  const regions = regionBuild.regions;

  const modulesBuild = buildModules({
    regions,
    regionMeta: regionBuild.regionMeta,
    qualityGrade,
    language,
    profileSummary,
    ingredientRecEnabled: Boolean(ingredientRecEnabled),
    productRecEnabled: Boolean(productRecEnabled),
    productRecMinCitations,
    productRecMinEvidenceGrade,
    productRecRepairOnlyWhenDegraded,
    internalTestMode: Boolean(internalTestMode),
    ingredientKbArtifactPath,
    productCatalogPath,
  });

  const moduleMaskBuild = attachModuleMasks({
    modules: modulesBuild.modules,
    regions,
    skinMask,
    moduleBoxes: MODULE_BOXES,
    gridSize: MODULE_MASK_GRID_SIZE,
  });

  const payload = {
    used_photos: true,
    quality_grade: qualityGrade,
    ...(typeof photoNotice === 'string' && photoNotice.trim() ? { photo_notice: photoNotice.trim() } : {}),
    face_crop: faceCrop,
    regions,
    modules: moduleMaskBuild.modules,
    disclaimers: {
      non_medical: true,
      seek_care_triggers: [
        'Rapidly worsening pain, swelling, or spreading rash.',
        'Eye swelling, breathing discomfort, or severe allergy signs.',
        'Persistent worsening after stopping all new actives for 72 hours.',
      ],
    },
  };
  if (internalTestMode) {
    payload.internal_debug = {
      market: modulesBuild.market,
      risk_tier: modulesBuild.riskTier,
      ingredient_rec_enabled: Boolean(ingredientRecEnabled),
      product_rec_enabled: Boolean(productRecEnabled),
      module_count: Array.isArray(moduleMaskBuild.modules) ? moduleMaskBuild.modules.length : 0,
      skinmask_available: moduleMaskBuild.skinmask_available,
      skinmask_refined_modules: moduleMaskBuild.skinmask_refined_modules,
      skinmask_skipped_modules: moduleMaskBuild.skinmask_skipped_modules,
      skinmask_grid: moduleMaskBuild.skinmask_grid,
      skinmask_reliable: moduleMaskBuild.skinmask_reliable,
      skinmask_positive_ratio: moduleMaskBuild.skinmask_positive_ratio,
    };
  }

  const regionCountRows = countBy(
    regions.map((region) => ({
      region_type: region.type,
      issue_type: String(region.style && region.style.label_hint ? region.style.label_hint : 'unknown').toLowerCase(),
    })),
    ['region_type', 'issue_type'],
  );

  return {
    card: {
      card_id: `photo_modules_${requestId || faceCrop.crop_id}`,
      type: 'photo_modules_v1',
      payload,
    },
    metrics: {
      quality_grade: qualityGrade,
      regionCounts: regionCountRows,
      moduleIssueCounts: modulesBuild.moduleIssueCounts,
      ingredientActionCounts: modulesBuild.ingredientActionCounts,
      geometryDropCounts: regionBuild.geometryCounts,
      productRecEmittedCounts: modulesBuild.productRecEmittedCounts,
      productRecSuppressedCounts: modulesBuild.productRecSuppressedCounts,
      claimsTemplateFallbackCounts: modulesBuild.claimsTemplateFallbackCounts,
      claimsViolationCounts: modulesBuild.claimsViolationCounts,
    },
  };
}

module.exports = {
  FACE_COORD_SPACE,
  buildPhotoModulesCard,
};
