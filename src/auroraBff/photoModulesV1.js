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
  under_eye_left: { x: 0.16, y: 0.31, w: 0.26, h: 0.11 },
  under_eye_right: { x: 0.58, y: 0.31, w: 0.26, h: 0.11 },
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
const MODULE_SHRINK_CHIN = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_CHIN, 0.55, 0.4, 1);
const MODULE_SHRINK_FOREHEAD = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_FOREHEAD, 0.45, 0.3, 1);
const MODULE_SHRINK_CHEEK = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_CHEEK, 0.65, 0.4, 1);
const MODULE_SHRINK_UNDER_EYE = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_UNDER_EYE, 0.5, 0.35, 1);
const MODULE_SHRINK_NOSE = parseEnvNumber(process.env.DIAG_MODULE_SHRINK_NOSE, 0.45, 0.3, 1);
const MODULE_MIN_PIXELS_UNDER_EYE = Math.max(
  1,
  Math.min(1024, Math.trunc(Number(process.env.DIAG_MODULE_MIN_PIXELS_UNDER_EYE || 64) || 64)),
);
const MODULE_MIN_PIXELS_FOREHEAD = Math.max(
  1,
  Math.min(2048, Math.trunc(Number(process.env.DIAG_MODULE_MIN_PIXELS_FOREHEAD || 128) || 128)),
);
const MODULE_MIN_PIXELS_CHIN = Math.max(
  1,
  Math.min(2048, Math.trunc(Number(process.env.DIAG_MODULE_MIN_PIXELS_CHIN || 128) || 128)),
);
const MODULE_MIN_PIXELS_CHEEK = Math.max(
  1,
  Math.min(4096, Math.trunc(Number(process.env.DIAG_MODULE_MIN_PIXELS_CHEEK || 256) || 256)),
);
const MODULE_MIN_PIXELS_DEFAULT = Math.max(
  1,
  Math.min(2048, Math.trunc(Number(process.env.DIAG_MODULE_MIN_PIXELS_DEFAULT || 128) || 128)),
);
const MODULE_GUARD_DILATION_MAX_ITER = Math.max(
  1,
  Math.min(32, Math.trunc(Number(process.env.DIAG_MODULE_GUARD_DILATION_MAX_ITER || 6) || 6)),
);
const FOREHEAD_BAND_RATIO = parseEnvNumber(process.env.DIAG_FOREHEAD_BAND_RATIO, 0.25, 0.15, 0.95);
const FOREHEAD_BROW_LINE_Y = parseEnvNumber(process.env.DIAG_FOREHEAD_BROW_LINE_Y, 0.38, 0.22, 0.6);
const NOSE_GUARD_MAX_WIDTH = parseEnvNumber(process.env.DIAG_NOSE_GUARD_MAX_WIDTH, 0.07, 0.05, 0.35);
const NOSE_GUARD_X_CENTER = parseEnvNumber(process.env.DIAG_NOSE_GUARD_X_CENTER, 0.5, 0.35, 0.65);
const NOSE_GUARD_Y_TOP = parseEnvNumber(process.env.DIAG_NOSE_GUARD_Y_TOP, 0.4, 0.12, 0.65);
const NOSE_GUARD_Y_BOTTOM = parseEnvNumber(process.env.DIAG_NOSE_GUARD_Y_BOTTOM, 0.56, 0.25, 0.95);
const NOSE_GUARD_WING_HALF_WIDTH_RATIO = parseEnvNumber(
  process.env.DIAG_NOSE_GUARD_WING_HALF_WIDTH_RATIO,
  0.18,
  0.08,
  0.45,
);
const NOSE_GUARD_WING_MARGIN = parseEnvNumber(process.env.DIAG_NOSE_GUARD_WING_MARGIN, 0.012, 0.003, 0.08);
const CHIN_GUARD_X_MIN = parseEnvNumber(process.env.DIAG_CHIN_GUARD_X_MIN, 0.36, 0.05, 0.5);
const CHIN_GUARD_X_MAX = parseEnvNumber(process.env.DIAG_CHIN_GUARD_X_MAX, 0.64, 0.5, 0.95);
const CHIN_GUARD_Y_MIN = parseEnvNumber(process.env.DIAG_CHIN_GUARD_Y_MIN, 0.6, 0.4, 0.9);
const CHIN_GUARD_Y_MAX = parseEnvNumber(process.env.DIAG_CHIN_GUARD_Y_MAX, 0.72, 0.55, 0.99);
const CHIN_GUARD_JAWLINE_Y_MAX = parseEnvNumber(process.env.DIAG_CHIN_GUARD_JAWLINE_Y_MAX, 0.76, 0.58, 0.96);
const CHIN_GUARD_ELLIPSE_CX = parseEnvNumber(process.env.DIAG_CHIN_GUARD_ELLIPSE_CX, 0.5, 0.25, 0.75);
const CHIN_GUARD_ELLIPSE_CY = parseEnvNumber(process.env.DIAG_CHIN_GUARD_ELLIPSE_CY, 0.71, 0.56, 0.9);
const CHIN_GUARD_ELLIPSE_RX = parseEnvNumber(process.env.DIAG_CHIN_GUARD_ELLIPSE_RX, 0.12, 0.05, 0.32);
const CHIN_GUARD_ELLIPSE_RY = parseEnvNumber(process.env.DIAG_CHIN_GUARD_ELLIPSE_RY, 0.09, 0.04, 0.25);
const FACE_OVAL_CLIP_MIN_PIXELS = Math.max(
  1,
  Math.min(512, Math.trunc(Number(process.env.DIAG_FACE_OVAL_CLIP_MIN_PIXELS || 8) || 8)),
);
const FACE_OVAL_CLIP_MIN_KEEP_RATIO = Math.max(
  0,
  Math.min(1, Number(process.env.DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO || 0.25)),
);

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
const MODULE_BOX_MODE = (() => {
  const token = String(process.env.DIAG_MODULE_BOX_MODE || 'dynamic_skinmask').trim().toLowerCase();
  if (token === 'static' || token === 'dynamic_skinmask' || token === 'auto') return token;
  return 'dynamic_skinmask';
})();
const MODULE_BOX_DYNAMIC_MIN_SCORE = Math.max(
  0,
  Math.min(1, Number(process.env.DIAG_MODULE_BOX_DYNAMIC_MIN_SCORE || 0.6)),
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
  moduleBoxes,
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
  const activeModuleBoxes = moduleBoxes && typeof moduleBoxes === 'object' ? moduleBoxes : MODULE_BOXES;

  for (const [moduleId, moduleBoxRaw] of Object.entries(activeModuleBoxes)) {
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

function hasValidSkinBBoxNorm(diagnosisInternal) {
  const internal = diagnosisInternal && typeof diagnosisInternal === 'object' ? diagnosisInternal : {};
  const bbox = internal.skin_bbox_norm && typeof internal.skin_bbox_norm === 'object'
    ? internal.skin_bbox_norm
    : null;
  if (!bbox) return false;
  const x0 = Number(bbox.x0);
  const y0 = Number(bbox.y0);
  const x1 = Number(bbox.x1);
  const y1 = Number(bbox.y1);
  if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) return false;
  return Math.abs(x1 - x0) >= 0.02 && Math.abs(y1 - y0) >= 0.02;
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

function median(numbers) {
  const values = Array.isArray(numbers)
    ? numbers.map((value) => Number(value)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
    : [];
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2) return values[mid];
  return (values[mid - 1] + values[mid]) / 2;
}

function percentileSortedNumbers(sortedValues, q) {
  const values = Array.isArray(sortedValues) ? sortedValues : [];
  if (!values.length) return null;
  const quantile = clamp01(q);
  const idx = (values.length - 1) * quantile;
  const lo = Math.max(0, Math.min(values.length - 1, Math.floor(idx)));
  const hi = Math.max(0, Math.min(values.length - 1, Math.ceil(idx)));
  if (lo === hi) return Number(values[lo]);
  const ratio = idx - lo;
  return Number(values[lo]) + ((Number(values[hi]) - Number(values[lo])) * ratio);
}

function percentileNumbers(numbers, q) {
  const values = Array.isArray(numbers)
    ? numbers.map((value) => Number(value)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
    : [];
  return percentileSortedNumbers(values, q);
}

function gatherMaskRowEdges(mask, gridSize) {
  if (!(mask instanceof Uint8Array) || !mask.length) {
    return {
      row_edges: [],
      min_x: gridSize,
      max_x: -1,
      min_y: gridSize,
      max_y: -1,
      positive_pixels: 0,
    };
  }
  const g = Math.max(1, Math.trunc(Number(gridSize) || 1));
  const rowEdges = [];
  let minX = g;
  let maxX = -1;
  let minY = g;
  let maxY = -1;
  let positivePixels = 0;
  for (let y = 0; y < g; y += 1) {
    let lx = -1;
    let rx = -1;
    let count = 0;
    let sumX = 0;
    for (let x = 0; x < g; x += 1) {
      if (!mask[(y * g) + x]) continue;
      if (lx < 0) lx = x;
      rx = x;
      count += 1;
      sumX += x;
    }
    if (count <= 0 || lx < 0 || rx < 0) continue;
    rowEdges.push({
      y,
      lx,
      rx,
      cx: count > 0 ? (sumX / count) : ((lx + rx) / 2),
      w: rx - lx + 1,
      count,
    });
    positivePixels += count;
    if (lx < minX) minX = lx;
    if (rx > maxX) maxX = rx;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    row_edges: rowEdges,
    min_x: minX,
    max_x: maxX,
    min_y: minY,
    max_y: maxY,
    positive_pixels: positivePixels,
  };
}

function pickRowByAreaQuantile(rowEdges, quantile) {
  if (!Array.isArray(rowEdges) || !rowEdges.length) return null;
  const weightedTotal = rowEdges.reduce(
    (sum, row) => sum + Math.max(1, Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0),
    0,
  );
  if (weightedTotal <= 0) return pickRowEdgeNear(rowEdges, rowEdges[Math.trunc(rowEdges.length / 2)].y);
  const target = clamp01(quantile) * weightedTotal;
  let acc = 0;
  for (const row of rowEdges) {
    const weight = Math.max(1, Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0);
    acc += weight;
    if (acc >= target) return row;
  }
  return rowEdges[rowEdges.length - 1] || null;
}

function summarizeRowBand(rowEdges, yMin, yMax) {
  if (!Array.isArray(rowEdges) || !rowEdges.length) return null;
  const lower = Math.min(Number(yMin), Number(yMax));
  const upper = Math.max(Number(yMin), Number(yMax));
  const rows = rowEdges.filter((row) => Number(row && row.y) >= lower && Number(row && row.y) <= upper);
  if (!rows.length) return null;
  const lefts = rows.map((row) => Number(row.lx)).filter((value) => Number.isFinite(value));
  const rights = rows.map((row) => Number(row.rx)).filter((value) => Number.isFinite(value));
  const lxQ = percentileNumbers(lefts, 0.2);
  const rxQ = percentileNumbers(rights, 0.8);
  const lxRaw = Number.isFinite(lxQ) ? lxQ : Math.min(...lefts);
  const rxRaw = Number.isFinite(rxQ) ? rxQ : Math.max(...rights);
  const lx = Math.trunc(Math.floor(Math.max(0, lxRaw)));
  const rx = Math.trunc(Math.ceil(Math.max(lx + 1, rxRaw)));
  const weighted = rows.reduce(
    (acc, row) => {
      const weight = Math.max(1, Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0);
      const cx = Number.isFinite(Number(row && row.cx)) ? Number(row.cx) : (Number(row.lx) + Number(row.rx)) / 2;
      return {
        sum: acc.sum + (cx * weight),
        weight: acc.weight + weight,
      };
    },
    { sum: 0, weight: 0 },
  );
  const cx = weighted.weight > 0
    ? weighted.sum / weighted.weight
    : (median(rows.map((row) => row.cx)) ?? ((lx + rx) / 2));
  return {
    y0: rows[0].y,
    y1: rows[rows.length - 1].y,
    lx,
    rx,
    cx,
    rows: rows.length,
  };
}

function rowBandToNorm(rowBand, gridSize) {
  if (!rowBand || !Number.isFinite(Number(gridSize)) || Number(gridSize) <= 0) return null;
  const g = Number(gridSize);
  const x0 = clamp01(Number(rowBand.lx) / g);
  const x1 = clamp01((Number(rowBand.rx) + 1) / g);
  const y0 = clamp01(Number(rowBand.y0) / g);
  const y1 = clamp01((Number(rowBand.y1) + 1) / g);
  const cx = clamp01((Number(rowBand.cx) + 0.5) / g);
  if (![x0, x1, y0, y1, cx].every((value) => Number.isFinite(value))) return null;
  return {
    x0: Math.min(x0, x1),
    x1: Math.max(x0, x1),
    y0: Math.min(y0, y1),
    y1: Math.max(y0, y1),
    cx,
  };
}

function pickRowEdgeNear(rowEdges, targetY) {
  if (!Array.isArray(rowEdges) || !rowEdges.length) return null;
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const row of rowEdges) {
    const dist = Math.abs(Number(row.y) - Number(targetY));
    if (dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  return best;
}

function rowEdgeToNorm(row, gridSize) {
  if (!row || !Number.isFinite(Number(gridSize)) || Number(gridSize) <= 0) return null;
  const g = Number(gridSize);
  const y = (Number(row.y) + 0.5) / g;
  const lx = (Number(row.lx) + 0.5) / g;
  const rx = (Number(row.rx) + 0.5) / g;
  const cx = (Number(row.cx) + 0.5) / g;
  if (![y, lx, rx, cx].every((value) => Number.isFinite(value))) return null;
  return {
    y: clamp01(y),
    lx: clamp01(Math.min(lx, rx)),
    rx: clamp01(Math.max(lx, rx)),
    cx: clamp01(cx),
  };
}

function sanitizeBoxCorners(x0, y0, x1, y1) {
  return sanitizeBBox({
    x: Math.min(Number(x0), Number(x1)),
    y: Math.min(Number(y0), Number(y1)),
    w: Math.abs(Number(x1) - Number(x0)),
    h: Math.abs(Number(y1) - Number(y0)),
  });
}

function deriveModuleBoxesFromSkinMask({ skinMask, gridSize } = {}) {
  const targetGrid = normalizeMaskGridSize(gridSize, MODULE_MASK_GRID_SIZE);
  const decoded = decodeSkinMaskToGrid(skinMask, targetGrid);
  if (!(decoded instanceof Uint8Array) || !decoded.length) {
    return { ok: false, reason: 'skinmask_unavailable', score: 0, module_boxes: null };
  }

  const totalPixels = targetGrid * targetGrid;
  const componentMinPixels = Math.max(12, Math.trunc(totalPixels * 0.015));
  const componentSelection = selectFaceComponentFromMask(decoded, targetGrid, {
    minPixels: componentMinPixels,
    centerX: 0.5,
    centerY: 0.54,
  });
  const componentMask = componentSelection && componentSelection.mask
    ? componentSelection.mask
    : (largestConnectedComponentMask(decoded, targetGrid, componentMinPixels) || decoded);
  const geometry = gatherMaskRowEdges(componentMask, targetGrid);
  const rowEdges = geometry.row_edges;
  const rawMinX = geometry.min_x;
  const rawMaxX = geometry.max_x;
  const rawMinY = geometry.min_y;
  const rawMaxY = geometry.max_y;
  const positivePixels = Math.max(0, Math.trunc(Number(geometry.positive_pixels) || 0));
  const positiveRatio = positivePixels / Math.max(1, totalPixels);

  if (rowEdges.length < Math.max(6, Math.trunc(targetGrid * 0.08)) || rawMinX > rawMaxX || rawMinY > rawMaxY) {
    return {
      ok: false,
      reason: 'skinmask_rows_insufficient',
      score: round3(clamp01(positiveRatio)),
      module_boxes: null,
      positive_ratio: round3(positiveRatio),
    };
  }

  const rowWidthsSorted = rowEdges
    .map((row) => Number(row && row.w))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const medianRowWidth = percentileSortedNumbers(rowWidthsSorted, 0.5) || Math.max(1, rawMaxX - rawMinX + 1);
  const stableRowWidthThreshold = Math.max(3, Math.trunc(medianRowWidth * 0.68));
  const stableRows = rowEdges.filter((row) => Number(row && row.w) >= stableRowWidthThreshold);
  const minX = stableRows.length >= 5
    ? Math.min(...stableRows.map((row) => Number(row.lx)))
    : rawMinX;
  const maxX = stableRows.length >= 5
    ? Math.max(...stableRows.map((row) => Number(row.rx)))
    : rawMaxX;
  const minY = stableRows.length >= 5
    ? Math.min(...stableRows.map((row) => Number(row.y)))
    : rawMinY;
  const maxY = stableRows.length >= 5
    ? Math.max(...stableRows.map((row) => Number(row.y)))
    : rawMaxY;

  const faceHpx = Math.max(4, maxY - minY + 1);
  const faceWpx = Math.max(4, maxX - minX + 1);
  const faceBoxRaw = sanitizeBBox({
    x: (minX / targetGrid) - 0.01,
    y: (minY / targetGrid) - 0.01,
    w: (faceWpx / targetGrid) + 0.02,
    h: (faceHpx / targetGrid) + 0.02,
  });
  if (!faceBoxRaw.ok || !faceBoxRaw.bbox) {
    return { ok: false, reason: 'skinmask_face_bbox_invalid', score: 0, module_boxes: null };
  }
  const faceBox = faceBoxRaw.bbox;
  const faceW = faceBox.w;
  const faceH = faceBox.h;

  const clampRow = (value) => Math.max(minY, Math.min(maxY, Math.trunc(Number(value) || minY)));
  const yByArea = (quantile, fallbackRatio) => {
    const row = pickRowByAreaQuantile(rowEdges, quantile);
    if (row && Number.isFinite(Number(row.y))) return clampRow(row.y);
    return clampRow(minY + (faceHpx * fallbackRatio));
  };
  const yNormByArea = (quantile, fallbackRatio) => clamp01(yByArea(quantile, fallbackRatio) / targetGrid);
  const pickBand = (q0, q1, minRows = 3) => {
    let y0 = yByArea(q0, q0);
    let y1 = yByArea(q1, q1);
    if (y1 < y0) {
      const tmp = y0;
      y0 = y1;
      y1 = tmp;
    }
    const currentRows = y1 - y0 + 1;
    if (currentRows < minRows) {
      const expand = Math.ceil((minRows - currentRows) / 2);
      y0 = clampRow(y0 - expand);
      y1 = clampRow(y1 + expand);
    }
    let band = summarizeRowBand(rowEdges, y0, y1);
    if (!band) {
      const near = pickRowEdgeNear(rowEdges, (y0 + y1) / 2);
      if (near) {
        band = {
          y0: near.y,
          y1: near.y,
          lx: near.lx,
          rx: near.rx,
          cx: near.cx,
          rows: 1,
        };
      }
    }
    return band;
  };

  const foreheadBandPx = pickBand(0.02, 0.24, 4);
  const underEyeBandPx = pickBand(0.29, 0.46, 4);
  const noseBandPx = pickBand(0.36, 0.71, 5);
  const cheekBandPx = pickBand(0.43, 0.8, 6);
  const chinBandPx = pickBand(0.73, 0.98, 4);
  const midBandPx = pickBand(0.35, 0.68, 6);

  const foreheadBand = rowBandToNorm(foreheadBandPx, targetGrid);
  const underEyeBand = rowBandToNorm(underEyeBandPx, targetGrid);
  const noseBand = rowBandToNorm(noseBandPx, targetGrid);
  const cheekBand = rowBandToNorm(cheekBandPx, targetGrid);
  const chinBand = rowBandToNorm(chinBandPx, targetGrid);
  const midBand = rowBandToNorm(midBandPx, targetGrid);

  const centerDefault = faceBox.x + (faceW / 2);
  const centerX = clamp01(
    median(
      [midBand && midBand.cx, noseBand && noseBand.cx, cheekBand && cheekBand.cx]
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    ) ?? centerDefault,
  );
  const yawEstimate = faceW > 0.01 ? (centerX - centerDefault) / (faceW * 0.35) : 0;
  const yaw = Math.max(-1, Math.min(1, yawEstimate));
  const bridgePad = Math.max(0.006, Math.min(faceW * 0.085, faceW * (0.055 + (Math.abs(yaw) * 0.02))));

  const dynamicBoxes = {};
  const directModuleIds = new Set();
  const fallbackModuleIds = new Set();
  const minBoxScales = {
    forehead: { w: 0.36, h: 0.085 },
    under_eye_left: { w: 0.11, h: 0.055 },
    under_eye_right: { w: 0.11, h: 0.055 },
    left_cheek: { w: 0.15, h: 0.145 },
    right_cheek: { w: 0.15, h: 0.145 },
    nose: { w: 0.08, h: 0.16 },
    chin: { w: 0.24, h: 0.095 },
  };
  const enforceMinimumBoxSize = (moduleId, box, clampBox) => {
    const rule = minBoxScales[moduleId];
    if (!rule || !box) return box;
    const minW = Math.max(0.01, faceW * Number(rule.w || 0));
    const minH = Math.max(0.01, faceH * Number(rule.h || 0));
    const needW = box.w < minW;
    const needH = box.h < minH;
    if (!needW && !needH) return box;
    const cx = box.x + (box.w / 2);
    const cy = box.y + (box.h / 2);
    const grown = sanitizeBBox({
      x: cx - (Math.max(box.w, minW) / 2),
      y: cy - (Math.max(box.h, minH) / 2),
      w: Math.max(box.w, minW),
      h: Math.max(box.h, minH),
    });
    if (!grown.ok || !grown.bbox) return box;
    let bounded = grown.bbox;
    if (clampBox) {
      const clamped = intersectBoxes(bounded, clampBox);
      if (clamped) bounded = clamped;
    }
    return intersectBoxes(bounded, faceBox) || bounded || box;
  };
  const addBox = (moduleId, x0, y0, x1, y1, clampBoxRaw = null, source = 'direct') => {
    const raw = sanitizeBoxCorners(x0, y0, x1, y1);
    if (!raw.ok || !raw.bbox) return;
    const clampBox = clampBoxRaw ? sanitizeBBox(clampBoxRaw) : null;
    let bounded = intersectBoxes(raw.bbox, faceBox) || raw.bbox;
    if (clampBox && clampBox.ok && clampBox.bbox) {
      bounded = intersectBoxes(bounded, clampBox.bbox);
      if (!bounded) return;
    }
    const minSized = enforceMinimumBoxSize(
      moduleId,
      bounded,
      clampBox && clampBox.ok ? clampBox.bbox : null,
    );
    const final = sanitizeBBox(minSized || bounded);
    if (!final.ok || !final.bbox) return;
    dynamicBoxes[moduleId] = final.bbox;
    if (String(source || 'direct') === 'fallback') fallbackModuleIds.add(moduleId);
    else directModuleIds.add(moduleId);
  };

  const foreheadY0 = Math.max(faceBox.y + (faceH * 0.01), foreheadBand ? foreheadBand.y0 : yNormByArea(0.02, 0.02));
  const foreheadY1 = Math.min(
    foreheadBand ? foreheadBand.y1 : yNormByArea(0.24, 0.24),
    (underEyeBand ? underEyeBand.y0 : yNormByArea(0.3, 0.3)) - (faceH * 0.012),
  );
  const foreheadClamp = {
    x: faceBox.x,
    y: faceBox.y,
    w: faceBox.w,
    h: Math.max(0.02, (underEyeBand ? underEyeBand.y0 : (faceBox.y + faceH * 0.35)) - faceBox.y),
  };
  addBox(
    'forehead',
    (foreheadBand ? foreheadBand.x0 : faceBox.x) + (faceW * 0.015),
    foreheadY0,
    (foreheadBand ? foreheadBand.x1 : (faceBox.x + faceBox.w)) - (faceW * 0.015),
    foreheadY1,
    foreheadClamp,
  );

  const underY0 = Math.max(faceBox.y + (faceH * 0.24), underEyeBand ? underEyeBand.y0 : yNormByArea(0.29, 0.29));
  const underY1 = Math.min(
    faceBox.y + (faceH * 0.55),
    underEyeBand ? underEyeBand.y1 : yNormByArea(0.46, 0.46),
  );
  const underLeft = (underEyeBand ? underEyeBand.x0 : faceBox.x) + (faceW * 0.01);
  const underRight = (underEyeBand ? underEyeBand.x1 : (faceBox.x + faceBox.w)) - (faceW * 0.01);
  const centerPad = Math.max(bridgePad, faceW * 0.055);
  const leftSideX1 = Math.max(faceBox.x + faceW * 0.2, centerX - centerPad);
  const rightSideX0 = Math.min(faceBox.x + faceW * 0.8, centerX + centerPad);
  const underEyeLeftClamp = {
    x: faceBox.x,
    y: faceBox.y + (faceH * 0.2),
    w: Math.max(0.01, leftSideX1 - faceBox.x),
    h: Math.max(0.01, faceH * 0.38),
  };
  const underEyeRightClamp = {
    x: rightSideX0,
    y: faceBox.y + (faceH * 0.2),
    w: Math.max(0.01, (faceBox.x + faceBox.w) - rightSideX0),
    h: Math.max(0.01, faceH * 0.38),
  };
  addBox(
    'under_eye_left',
    underLeft,
    underY0,
    Math.min(centerX - bridgePad, underRight - (faceW * 0.06)),
    underY1,
    underEyeLeftClamp,
  );
  addBox(
    'under_eye_right',
    Math.max(centerX + bridgePad, underLeft + (faceW * 0.06)),
    underY0,
    underRight,
    underY1,
    underEyeRightClamp,
  );

  const mouthAnchorY = yNormByArea(0.68, 0.68);
  const jawAnchorY = yNormByArea(0.88, 0.88);
  const chinBandTopY = chinBand ? chinBand.y0 : yNormByArea(0.79, 0.79);
  const chinTopFloor = Math.max(
    faceBox.y + (faceH * 0.7),
    mouthAnchorY + (faceH * 0.08),
  );
  const chinTopCeil = Math.min(
    faceBox.y + (faceH * 0.9),
    jawAnchorY + (faceH * 0.04),
  );
  const chinTopY = Math.max(chinTopFloor, Math.min(chinBandTopY, chinTopCeil));
  const cheekY0 = Math.max(underY0 + (faceH * 0.01), cheekBand ? cheekBand.y0 : yNormByArea(0.43, 0.43));
  const cheekY1 = Math.min(chinTopY - (faceH * 0.04), cheekBand ? cheekBand.y1 : yNormByArea(0.8, 0.8));
  const cheekSplitPad = Math.max(bridgePad, faceW * 0.075);
  const leftCheekClamp = {
    x: faceBox.x,
    y: faceBox.y + (faceH * 0.34),
    w: Math.max(0.01, (centerX - cheekSplitPad) - faceBox.x),
    h: Math.max(0.01, faceH * 0.58),
  };
  const rightCheekClamp = {
    x: centerX + cheekSplitPad,
    y: faceBox.y + (faceH * 0.34),
    w: Math.max(0.01, (faceBox.x + faceBox.w) - (centerX + cheekSplitPad)),
    h: Math.max(0.01, faceH * 0.58),
  };
  addBox(
    'left_cheek',
    (cheekBand ? cheekBand.x0 : faceBox.x) + (faceW * 0.015),
    cheekY0,
    centerX - cheekSplitPad,
    cheekY1,
    leftCheekClamp,
  );
  addBox(
    'right_cheek',
    centerX + cheekSplitPad,
    cheekY0,
    (cheekBand ? cheekBand.x1 : (faceBox.x + faceBox.w)) - (faceW * 0.015),
    cheekY1,
    rightCheekClamp,
  );

  const noseBandLeft = noseBand ? noseBand.x0 : (faceBox.x + (faceW * 0.3));
  const noseBandRight = noseBand ? noseBand.x1 : (faceBox.x + (faceW * 0.7));
  const noseCenterX = clamp01(((noseBand ? noseBand.cx : centerX) * 0.7) + (centerX * 0.3));
  const noseBandSpanLeft = Math.max(0.01, noseCenterX - noseBandLeft);
  const noseBandSpanRight = Math.max(0.01, noseBandRight - noseCenterX);
  const noseHalfW = Math.max(
    faceW * 0.045,
    Math.min(faceW * 0.13, Math.min(noseBandSpanLeft, noseBandSpanRight) * 0.78),
  );
  const noseClamp = {
    x: centerX - (faceW * 0.18),
    y: faceBox.y + (faceH * 0.26),
    w: Math.max(0.01, faceW * 0.36),
    h: Math.max(0.01, faceH * 0.48),
  };
  addBox(
    'nose',
    noseCenterX - noseHalfW,
    Math.max(underY0 + (faceH * 0.005), noseBand ? noseBand.y0 : yNormByArea(0.36, 0.36)),
    noseCenterX + noseHalfW,
    Math.min(chinTopY - (faceH * 0.05), noseBand ? noseBand.y1 : yNormByArea(0.71, 0.71)),
    noseClamp,
  );

  const chinBandLeft = chinBand ? chinBand.x0 : (faceBox.x + (faceW * 0.18));
  const chinBandRight = chinBand ? chinBand.x1 : (faceBox.x + (faceW * 0.82));
  const chinHalfW = Math.max(
    faceW * 0.2,
    Math.min(faceW * 0.34, ((chinBandRight - chinBandLeft) * 0.5)),
  );
  const chinBottomByBand = chinBand ? chinBand.y1 : yNormByArea(0.95, 0.95);
  const chinBottomCeil = Math.min(
    faceBox.y + (faceH * 0.965),
    mouthAnchorY + (faceH * 0.45),
  );
  const chinBottomY = Math.max(
    chinTopY + (faceH * 0.08),
    Math.min(chinBottomByBand, chinBottomCeil),
  );
  const chinClamp = {
    x: faceBox.x + (faceW * 0.04),
    y: Math.max(faceBox.y + (faceH * 0.62), chinTopY - (faceH * 0.04)),
    w: faceW * 0.92,
    h: Math.max(
      0.01,
      (faceBox.y + (faceH * 0.98)) - Math.max(faceBox.y + (faceH * 0.62), chinTopY - (faceH * 0.04)),
    ),
  };
  addBox(
    'chin',
    centerX - chinHalfW,
    chinTopY,
    centerX + chinHalfW,
    chinBottomY,
    chinClamp,
  );

  const addFaceGeometryFallback = (moduleId) => {
    const xLeft = faceBox.x;
    const xRight = faceBox.x + faceBox.w;
    if (moduleId === 'forehead') {
      addBox(moduleId, xLeft + (faceW * 0.1), faceBox.y + (faceH * 0.02), xRight - (faceW * 0.1), faceBox.y + (faceH * 0.25), null, 'fallback');
      return;
    }
    if (moduleId === 'under_eye_left') {
      addBox(moduleId, xLeft + (faceW * 0.08), faceBox.y + (faceH * 0.28), centerX - bridgePad, faceBox.y + (faceH * 0.44), null, 'fallback');
      return;
    }
    if (moduleId === 'under_eye_right') {
      addBox(moduleId, centerX + bridgePad, faceBox.y + (faceH * 0.28), xRight - (faceW * 0.08), faceBox.y + (faceH * 0.44), null, 'fallback');
      return;
    }
    if (moduleId === 'left_cheek') {
      addBox(moduleId, xLeft + (faceW * 0.04), faceBox.y + (faceH * 0.45), centerX - (faceW * 0.09), faceBox.y + (faceH * 0.78), null, 'fallback');
      return;
    }
    if (moduleId === 'right_cheek') {
      addBox(moduleId, centerX + (faceW * 0.09), faceBox.y + (faceH * 0.45), xRight - (faceW * 0.04), faceBox.y + (faceH * 0.78), null, 'fallback');
      return;
    }
    if (moduleId === 'nose') {
      addBox(moduleId, centerX - (faceW * 0.08), faceBox.y + (faceH * 0.36), centerX + (faceW * 0.08), faceBox.y + (faceH * 0.69), null, 'fallback');
      return;
    }
    if (moduleId === 'chin') {
      addBox(moduleId, centerX - (faceW * 0.28), faceBox.y + (faceH * 0.74), centerX + (faceW * 0.28), faceBox.y + (faceH * 0.99), null, 'fallback');
    }
  };

  for (const moduleId of [
    'forehead',
    'under_eye_left',
    'under_eye_right',
    'left_cheek',
    'right_cheek',
    'nose',
    'chin',
  ]) {
    if (!dynamicBoxes[moduleId]) addFaceGeometryFallback(moduleId);
  }

  const overlaps = [];
  for (const finalBox of Object.values(dynamicBoxes)) {
    const moduleMask = bboxNormToMask(finalBox, targetGrid, targetGrid);
    const modulePixels = countOnes(moduleMask);
    if (modulePixels <= 0) continue;
    const overlapPixels = countOnes(andMasks(moduleMask, componentMask));
    overlaps.push(clamp01(overlapPixels / modulePixels));
  }
  const overlapScore = overlaps.length
    ? overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length
    : 0;
  const rowsCoverage = clamp01(rowEdges.length / Math.max(1, faceHpx));
  const ratioInRange = positiveRatio >= MODULE_SKIN_POSITIVE_RATIO_MIN && positiveRatio <= MODULE_SKIN_POSITIVE_RATIO_MAX;
  const ratioQuality = ratioInRange ? clamp01(positiveRatio) : clamp01(positiveRatio * 0.6);
  const directCoverage = clamp01(directModuleIds.size / 7);
  const adjustedScore = round3(clamp01((0.48 * overlapScore) + (0.2 * rowsCoverage) + (0.12 * ratioQuality) + (0.2 * directCoverage)));
  const hasRequiredDynamic = Object.keys(dynamicBoxes).length >= 5;
  const hasLowDirectCoverage = directModuleIds.size < 5;
  const ratioReason = ratioInRange ? null : 'skinmask_positive_ratio_out_of_range';
  return {
    ok: hasRequiredDynamic,
    reason: hasRequiredDynamic
      ? (hasLowDirectCoverage ? 'dynamic_boxes_partial_direct' : ratioReason)
      : (ratioReason || 'dynamic_boxes_incomplete'),
    score: adjustedScore,
    module_boxes: hasRequiredDynamic ? dynamicBoxes : null,
    positive_ratio: round3(positiveRatio),
    overlap_score: round3(overlapScore),
    rows_coverage: round3(rowsCoverage),
    direct_coverage: round3(directCoverage),
    derived_modules_count: directModuleIds.size,
    fallback_modules_count: fallbackModuleIds.size,
    total_modules_count: Object.keys(dynamicBoxes).length,
    anchors: {
      forehead_row: rowEdgeToNorm(pickRowByAreaQuantile(rowEdges, 0.2), targetGrid),
      eye_row: rowEdgeToNorm(pickRowByAreaQuantile(rowEdges, 0.4), targetGrid),
      nose_row: rowEdgeToNorm(pickRowByAreaQuantile(rowEdges, 0.56), targetGrid),
      mouth_row: rowEdgeToNorm(pickRowByAreaQuantile(rowEdges, 0.72), targetGrid),
      chin_row: rowEdgeToNorm(pickRowByAreaQuantile(rowEdges, 0.92), targetGrid),
      face_center: { x: centerX, y: faceBox.y + (faceBox.h / 2) },
      yaw_est: round3(yaw),
      component_center: componentSelection
        ? { x: round3(componentSelection.cx), y: round3(componentSelection.cy) }
        : null,
      component_score: componentSelection ? componentSelection.score : null,
      component_count: componentSelection ? componentSelection.component_count : null,
    },
  };
}

function resolveModuleBoxDynamicDebug({ derivation } = {}) {
  const derived = derivation && typeof derivation === 'object' ? derivation : {};
  const score = Number.isFinite(Number(derived.score)) ? clamp01(Number(derived.score)) : 0;
  const boxCount =
    derived.module_boxes && typeof derived.module_boxes === 'object'
      ? Object.keys(derived.module_boxes).length
      : 0;
  const hasDerivedBoxes = boxCount >= 5;
  const meetsScore = hasDerivedBoxes && score >= MODULE_BOX_DYNAMIC_MIN_SCORE;

  if (MODULE_BOX_MODE === 'static') {
    return {
      module_box_mode: 'static',
      module_box_dynamic_applied: false,
      module_box_dynamic_reason: 'mode_static',
      module_box_dynamic_score: round3(score),
    };
  }
  if (MODULE_BOX_MODE === 'auto' && !meetsScore) {
    return {
      module_box_mode: 'static',
      module_box_dynamic_applied: false,
      module_box_dynamic_reason: derived.reason || (hasDerivedBoxes ? 'auto_fallback_low_score' : 'auto_fallback_dynamic_unavailable'),
      module_box_dynamic_score: round3(score),
      module_box_dynamic_boxes_count: boxCount,
    };
  }
  if (MODULE_BOX_MODE === 'auto' && meetsScore) {
    return {
      module_box_mode: 'dynamic_skinmask',
      module_box_dynamic_applied: true,
      module_box_dynamic_reason: derived.reason || null,
      module_box_dynamic_score: round3(score),
      module_box_dynamic_boxes_count: boxCount,
    };
  }

  const applied = hasDerivedBoxes;
  const reason = applied
    ? (derived.reason || (score >= MODULE_BOX_DYNAMIC_MIN_SCORE ? null : 'forced_dynamic_low_score'))
    : (derived.reason || 'dynamic_unavailable');
  return {
    module_box_mode: 'dynamic_skinmask',
    module_box_dynamic_applied: applied,
    module_box_dynamic_reason: reason,
    module_box_dynamic_score: round3(score),
    module_box_dynamic_boxes_count: boxCount,
  };
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

function extractConnectedComponents(mask, gridSize, minPixels = 1) {
  if (!(mask instanceof Uint8Array) || !mask.length) return [];
  const g = Math.max(1, Math.trunc(Number(gridSize) || 1));
  const n = g * g;
  if (mask.length < n) return [];
  const minCount = Math.max(1, Math.trunc(Number(minPixels) || 1));
  const visited = new Uint8Array(n);
  const stack = [];
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  const components = [];
  for (let i = 0; i < n; i += 1) {
    if (!mask[i] || visited[i]) continue;
    stack.length = 0;
    const indices = [];
    visited[i] = 1;
    stack.push(i);
    let minX = g;
    let minY = g;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    let touchesLeft = false;
    let touchesRight = false;
    let touchesTop = false;
    let touchesBottom = false;
    while (stack.length) {
      const idx = stack.pop();
      indices.push(idx);
      const x = idx % g;
      const y = Math.trunc(idx / g);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;
      if (x <= 0) touchesLeft = true;
      if (x >= g - 1) touchesRight = true;
      if (y <= 0) touchesTop = true;
      if (y >= g - 1) touchesBottom = true;
      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g || ny >= g) continue;
        const nIdx = ny * g + nx;
        if (visited[nIdx] || !mask[nIdx]) continue;
        visited[nIdx] = 1;
        stack.push(nIdx);
      }
    }
    if (indices.length < minCount || maxX < 0 || maxY < 0) continue;
    const width = Math.max(1, maxX - minX + 1);
    const height = Math.max(1, maxY - minY + 1);
    components.push({
      indices,
      pixels: indices.length,
      bbox: sanitizeBBox({
        x: minX / g,
        y: minY / g,
        w: width / g,
        h: height / g,
      }).bbox,
      cx: clamp01(((sumX / Math.max(1, indices.length)) + 0.5) / g),
      cy: clamp01(((sumY / Math.max(1, indices.length)) + 0.5) / g),
      aspect: width / Math.max(1, height),
      border_touches: Number(touchesLeft) + Number(touchesRight) + Number(touchesTop) + Number(touchesBottom),
    });
  }
  components.sort((a, b) => Number(b.pixels || 0) - Number(a.pixels || 0));
  return components;
}

function selectFaceComponentFromMask(mask, gridSize, { minPixels = 24, centerX = 0.5, centerY = 0.54 } = {}) {
  const components = extractConnectedComponents(mask, gridSize, minPixels);
  if (!components.length) return null;
  const g = Math.max(1, Math.trunc(Number(gridSize) || 1));
  const totalPixels = g * g;
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const component of components) {
    const areaRatio = Number(component.pixels || 0) / Math.max(1, totalPixels);
    const areaScore = clamp01(areaRatio / 0.22);
    const dx = Number(component.cx || 0.5) - clamp01(centerX);
    const dy = Number(component.cy || 0.5) - clamp01(centerY);
    const centerDist = Math.sqrt((dx * dx) + (dy * dy));
    const centerScore = clamp01(1 - (centerDist / 0.75));
    const aspect = Number(component.aspect || 0.7);
    const aspectScore = clamp01(1 - (Math.abs(aspect - 0.65) / 0.6));
    const borderTouches = Math.max(0, Math.trunc(Number(component.border_touches) || 0));
    const borderPenalty = borderTouches >= 3 ? 0.3 : borderTouches === 2 ? 0.12 : 0;
    const score = (0.42 * areaScore) + (0.43 * centerScore) + (0.15 * aspectScore) - borderPenalty;
    if (score > bestScore) {
      best = component;
      bestScore = score;
    }
  }
  if (!best || !Array.isArray(best.indices) || !best.indices.length) return null;
  const outMask = createMask(g, g, 0);
  for (const idx of best.indices) outMask[idx] = 1;
  return {
    mask: outMask,
    bbox: best.bbox || null,
    pixels: Math.max(0, Math.trunc(Number(best.pixels) || 0)),
    cx: clamp01(best.cx),
    cy: clamp01(best.cy),
    aspect: Number.isFinite(Number(best.aspect)) ? Number(best.aspect) : null,
    border_touches: Math.max(0, Math.trunc(Number(best.border_touches) || 0)),
    score: round3(clamp01(bestScore)),
    component_count: components.length,
  };
}

function largestConnectedComponentMask(mask, gridSize, minPixels = 24) {
  const components = extractConnectedComponents(mask, gridSize, minPixels);
  if (!components.length) return null;
  const g = Math.max(1, Math.trunc(Number(gridSize) || 1));
  const out = createMask(g, g, 0);
  for (const idx of components[0].indices || []) out[idx] = 1;
  return out;
}

function moduleShrinkScale(moduleId) {
  const token = String(moduleId || '').trim().toLowerCase();
  if (token === 'chin') return MODULE_SHRINK_CHIN;
  if (token === 'forehead') return MODULE_SHRINK_FOREHEAD;
  if (token === 'left_cheek' || token === 'right_cheek') return MODULE_SHRINK_CHEEK;
  if (token === 'under_eye_left' || token === 'under_eye_right') return MODULE_SHRINK_UNDER_EYE;
  if (token === 'nose') return MODULE_SHRINK_NOSE;
  return 1;
}

function intersectBoxes(boxA, boxB) {
  const a = sanitizeBBox(boxA);
  const b = sanitizeBBox(boxB);
  if (!a.ok || !a.bbox || !b.ok || !b.bbox) return null;
  const x0 = Math.max(a.bbox.x, b.bbox.x);
  const y0 = Math.max(a.bbox.y, b.bbox.y);
  const x1 = Math.min(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w);
  const y1 = Math.min(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h);
  const raw = {
    x: x0,
    y: y0,
    w: Math.max(0, x1 - x0),
    h: Math.max(0, y1 - y0),
  };
  const out = sanitizeBBox(raw);
  return out.ok ? out.bbox : null;
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

function ellipseNormToMask({ cx, cy, rx, ry } = {}, gridSize) {
  const targetGrid = normalizeMaskGridSize(gridSize, MODULE_MASK_GRID_SIZE);
  const mask = createMask(targetGrid, targetGrid, 0);
  const safeCx = clamp01(Number(cx));
  const safeCy = clamp01(Number(cy));
  const safeRx = Math.max(0.01, Math.min(0.45, Number(rx) || 0.01));
  const safeRy = Math.max(0.01, Math.min(0.45, Number(ry) || 0.01));
  for (let y = 0; y < targetGrid; y += 1) {
    const py = (y + 0.5) / targetGrid;
    const dy = (py - safeCy) / safeRy;
    for (let x = 0; x < targetGrid; x += 1) {
      const px = (x + 0.5) / targetGrid;
      const dx = (px - safeCx) / safeRx;
      if (dx * dx + dy * dy <= 1) {
        mask[y * targetGrid + x] = 1;
      }
    }
  }
  return mask;
}

function buildChinGuardMask({
  targetGrid,
  moduleBox,
  faceOvalMask,
  faceOvalBox,
  faceOvalMaskSource,
  boxScale = 1,
} = {}) {
  const faceOvalSanitized = sanitizeBBox(faceOvalBox);
  const moduleSanitized = sanitizeBBox(moduleBox);
  const useDynamicFaceOvalRef = String(faceOvalMaskSource || '') === 'skinmask_component';
  const refBox = useDynamicFaceOvalRef && faceOvalSanitized.ok && faceOvalSanitized.bbox
    ? faceOvalSanitized.bbox
    : moduleSanitized.ok && moduleSanitized.bbox
      ? moduleSanitized.bbox
      : null;
  const yMax = Math.min(CHIN_GUARD_Y_MAX, CHIN_GUARD_JAWLINE_Y_MAX);
  const bandRaw = refBox
    ? {
      x: refBox.x + (refBox.w * 0.18),
      y: refBox.y + (refBox.h * 0.67),
      w: Math.max(0.01, refBox.w * 0.64),
      h: Math.max(0.01, refBox.h * 0.3),
    }
    : {
      x: CHIN_GUARD_X_MIN,
      y: CHIN_GUARD_Y_MIN,
      w: Math.max(0.01, CHIN_GUARD_X_MAX - CHIN_GUARD_X_MIN),
      h: Math.max(0.01, yMax - CHIN_GUARD_Y_MIN),
    };
  const band = sanitizeBBox(bandRaw);
  if (!band.ok || !band.bbox) return null;
  let mask = bboxNormToMask(band.bbox, targetGrid, targetGrid);
  const ellipseMask = ellipseNormToMask(
    refBox
      ? {
        cx: refBox.x + (refBox.w * 0.5),
        cy: refBox.y + (refBox.h * 0.84),
        rx: Math.max(0.02, refBox.w * 0.22),
        ry: Math.max(0.02, refBox.h * 0.13),
      }
      : {
        cx: CHIN_GUARD_ELLIPSE_CX,
        cy: CHIN_GUARD_ELLIPSE_CY,
        rx: CHIN_GUARD_ELLIPSE_RX,
        ry: CHIN_GUARD_ELLIPSE_RY,
      },
    targetGrid,
  );
  mask = andMasks(mask, ellipseMask);
  if (moduleBox) {
    const scaledBox = Number(boxScale) < 0.999 ? shrinkModuleBox(moduleBox, boxScale) : moduleBox;
    const localBox = sanitizeBBox(scaledBox);
    if (localBox.ok && localBox.bbox) {
      mask = andMasks(mask, bboxNormToMask(localBox.bbox, targetGrid, targetGrid));
    }
  }
  if (faceOvalMask) {
    mask = andMasks(mask, faceOvalMask);
  }
  return countOnes(mask) > 0 ? mask : null;
}

function buildNoseGuardMask({
  targetGrid,
  moduleBox,
  faceOvalMask,
  faceOvalBox,
  faceOvalMaskSource,
  boxScale = 1,
} = {}) {
  const scaledBox = Number(boxScale) < 0.999 ? shrinkModuleBox(moduleBox, boxScale) : moduleBox;
  const sanitized = sanitizeBBox(scaledBox);
  const faceOvalSanitized = sanitizeBBox(faceOvalBox);
  const dynamicFaceOval = String(faceOvalMaskSource || '') === 'skinmask_component' && faceOvalSanitized.ok && faceOvalSanitized.bbox
    ? faceOvalSanitized.bbox
    : null;
  const dynamicTop = dynamicFaceOval ? dynamicFaceOval.y + (dynamicFaceOval.h * 0.3) : NOSE_GUARD_Y_TOP;
  const dynamicBottom = dynamicFaceOval ? dynamicFaceOval.y + (dynamicFaceOval.h * 0.74) : NOSE_GUARD_Y_BOTTOM;
  const dynamicMaxWidth = dynamicFaceOval
    ? Math.max(NOSE_GUARD_MAX_WIDTH, dynamicFaceOval.w * 0.24)
    : NOSE_GUARD_MAX_WIDTH;
  const sourceBox = sanitized.ok && sanitized.bbox
    ? sanitized.bbox
    : {
      x: NOSE_GUARD_X_CENTER - dynamicMaxWidth / 2,
      y: dynamicTop,
      w: dynamicMaxWidth,
      h: Math.max(0.01, dynamicBottom - dynamicTop),
    };
  const centerX = sourceBox.x + sourceBox.w / 2;
  const wingHalfWidth = Math.max(
    0.01,
    Math.min(dynamicMaxWidth / 2, sourceBox.w * NOSE_GUARD_WING_HALF_WIDTH_RATIO),
  );
  const guardRaw = {
    x: centerX - wingHalfWidth - NOSE_GUARD_WING_MARGIN,
    y: dynamicTop,
    w: (wingHalfWidth + NOSE_GUARD_WING_MARGIN) * 2,
    h: Math.max(0.01, dynamicBottom - dynamicTop),
  };
  const guard = sanitizeBBox(guardRaw);
  if (!guard.ok || !guard.bbox) return null;
  let mask = bboxNormToMask(guard.bbox, targetGrid, targetGrid);
  if (faceOvalMask) {
    mask = andMasks(mask, faceOvalMask);
  }
  return countOnes(mask) > 0 ? mask : null;
}

function applyModuleGuards(moduleId, boxRaw, { faceOvalBox, faceOvalMaskSource } = {}) {
  const baseSanitized = sanitizeBBox(boxRaw);
  if (!baseSanitized.ok || !baseSanitized.bbox) {
    return {
      box: null,
      chinGuardApplied: false,
      noseGuardApplied: false,
      foreheadBandApplied: false,
    };
  }
  let box = baseSanitized.bbox;
  let chinGuardApplied = false;
  let noseGuardApplied = false;
  let foreheadBandApplied = false;
  const faceOvalSanitized = sanitizeBBox(faceOvalBox);
  const dynamicFaceOval = String(faceOvalMaskSource || '') === 'skinmask_component' && faceOvalSanitized.ok && faceOvalSanitized.bbox
    ? faceOvalSanitized.bbox
    : null;
  if (moduleId === 'chin') {
    const yMax = Math.min(CHIN_GUARD_Y_MAX, CHIN_GUARD_JAWLINE_Y_MAX);
    const chinGuard = dynamicFaceOval
      ? {
        x: dynamicFaceOval.x + (dynamicFaceOval.w * 0.16),
        y: dynamicFaceOval.y + (dynamicFaceOval.h * 0.66),
        w: Math.max(0.01, dynamicFaceOval.w * 0.68),
        h: Math.max(0.01, dynamicFaceOval.h * 0.31),
      }
      : {
        x: CHIN_GUARD_X_MIN,
        y: CHIN_GUARD_Y_MIN,
        w: Math.max(0.01, CHIN_GUARD_X_MAX - CHIN_GUARD_X_MIN),
        h: Math.max(0.01, yMax - CHIN_GUARD_Y_MIN),
      };
    const guarded = intersectBoxes(box, chinGuard);
    if (guarded) {
      box = guarded;
      chinGuardApplied = true;
    }
  }

  if (moduleId === 'nose') {
    const sourceCenterX = box.x + box.w / 2;
    const centerX = clamp01(Number.isFinite(sourceCenterX) ? sourceCenterX : NOSE_GUARD_X_CENTER);
    const dynamicTop = dynamicFaceOval ? dynamicFaceOval.y + (dynamicFaceOval.h * 0.3) : NOSE_GUARD_Y_TOP;
    const dynamicBottom = dynamicFaceOval ? dynamicFaceOval.y + (dynamicFaceOval.h * 0.74) : NOSE_GUARD_Y_BOTTOM;
    const dynamicMaxWidth = dynamicFaceOval
      ? Math.max(NOSE_GUARD_MAX_WIDTH, dynamicFaceOval.w * 0.24)
      : NOSE_GUARD_MAX_WIDTH;
    const wingHalfWidth = Math.max(
      0.01,
      Math.min(dynamicMaxWidth / 2, box.w * NOSE_GUARD_WING_HALF_WIDTH_RATIO),
    );
    const width = (wingHalfWidth + NOSE_GUARD_WING_MARGIN) * 2;
    const guardXMin = centerX - width / 2;
    const guard = {
      x: guardXMin,
      y: dynamicTop,
      w: width,
      h: Math.max(0.01, dynamicBottom - dynamicTop),
    };
    const guarded = intersectBoxes(box, guard);
    if (guarded) {
      box = guarded;
      noseGuardApplied = true;
    }
  }

  if (moduleId === 'forehead') {
    const staticOvalTop = Math.min(...FACE_OVAL_POLYGON.points.map((point) => Number(point.y || 0)));
    const staticOvalBottom = Math.max(...FACE_OVAL_POLYGON.points.map((point) => Number(point.y || 1)));
    const dynamicTop = faceOvalBox && Number.isFinite(Number(faceOvalBox.y))
      ? Number(faceOvalBox.y)
      : staticOvalTop;
    const dynamicBottom = faceOvalBox && Number.isFinite(Number(faceOvalBox.y + faceOvalBox.h))
      ? Number(faceOvalBox.y + faceOvalBox.h)
      : staticOvalBottom;
    const browTarget = faceOvalBox && Number.isFinite(Number(faceOvalBox.h))
      ? Number(faceOvalBox.y) + (Number(faceOvalBox.h) * 0.42)
      : FOREHEAD_BROW_LINE_Y;
    const ovalTopY = clamp01(dynamicTop);
    const ovalBottomY = clamp01(dynamicBottom);
    const clampedBrowY = Math.max(
      ovalTopY + 0.02,
      Math.min(ovalBottomY - 0.02, browTarget),
    );
    const bandTop = clampedBrowY - (clampedBrowY - ovalTopY) * FOREHEAD_BAND_RATIO;
    const foreheadBand = {
      x: box.x,
      y: bandTop,
      w: box.w,
      h: Math.max(0.02, clampedBrowY - bandTop),
    };
    const guarded = intersectBoxes(box, foreheadBand);
    if (guarded) {
      box = guarded;
      foreheadBandApplied = true;
    }
  }

  return {
    box,
    chinGuardApplied,
    noseGuardApplied,
    foreheadBandApplied,
  };
}

function buildFaceOvalClipFallbackMask({
  moduleId,
  moduleBox,
  targetGrid,
  faceOvalMask,
  baselinePixels,
} = {}) {
  if (!moduleBox || !faceOvalMask) return { mask: null, reason: null, pixels: 0 };
  const strictModule = moduleId === 'chin' || moduleId === 'nose';
  const shrinkFactors = strictModule ? [0.82, 0.74, 0.66, 0.58, 0.5] : [0.92, 0.86, 0.8, 0.74];
  let bestMask = null;
  let bestPixels = 0;
  let bestReason = null;
  for (const factor of shrinkFactors) {
    const shrunkBox = shrinkModuleBox(moduleBox, factor);
    if (!shrunkBox) continue;
    const shrunkMask = bboxNormToMask(shrunkBox, targetGrid, targetGrid);
    const clipped = andMasks(shrunkMask, faceOvalMask);
    const clippedPixels = countOnes(clipped);
    if (clippedPixels > bestPixels) {
      bestMask = clipped;
      bestPixels = clippedPixels;
      bestReason = `SHRINK_${round3(factor)}`;
    }
    if (clippedPixels >= FACE_OVAL_CLIP_MIN_PIXELS) {
      return {
        mask: clipped,
        reason: `SHRINK_${round3(factor)}`,
        pixels: clippedPixels,
      };
    }
  }
  const clippedBaseline = andMasks(bboxNormToMask(moduleBox, targetGrid, targetGrid), faceOvalMask);
  const clippedBaselinePixels = countOnes(clippedBaseline);
  if (strictModule) {
    return {
      mask: bestMask || clippedBaseline,
      reason: bestReason || 'STRICT_CLIPPED_BASELINE',
      pixels: bestMask ? bestPixels : clippedBaselinePixels,
    };
  }
  return {
    mask: clippedBaseline,
    reason: baselinePixels > 0 ? 'CLIPPED_BASELINE' : 'EMPTY_BASELINE',
    pixels: clippedBaselinePixels,
  };
}

function isUnderEyeModule(moduleId) {
  return moduleId === 'under_eye_left' || moduleId === 'under_eye_right';
}

function moduleMinPixelsThreshold(moduleId) {
  if (moduleId === 'under_eye_left' || moduleId === 'under_eye_right') return MODULE_MIN_PIXELS_UNDER_EYE;
  if (moduleId === 'forehead') return MODULE_MIN_PIXELS_FOREHEAD;
  if (moduleId === 'chin') return MODULE_MIN_PIXELS_CHIN;
  if (moduleId === 'left_cheek' || moduleId === 'right_cheek') return MODULE_MIN_PIXELS_CHEEK;
  return MODULE_MIN_PIXELS_DEFAULT;
}

function dilateMaskOnce(mask, gridSize) {
  if (!(mask instanceof Uint8Array) || !Number.isFinite(Number(gridSize)) || gridSize <= 1) {
    return createMask(Math.max(1, Math.trunc(Number(gridSize) || 1)), Math.max(1, Math.trunc(Number(gridSize) || 1)), 0);
  }
  const grid = Math.max(1, Math.trunc(gridSize));
  const out = createMask(grid, grid, 0);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const y = Math.trunc(index / grid);
    const x = index - y * grid;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= grid) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= grid) continue;
        out[(ny * grid) + nx] = 1;
      }
    }
  }
  return out;
}

function adaptiveDilateWithinFaceOval({
  mask,
  targetPixels,
  gridSize,
  maxIter,
  faceOvalMask,
} = {}) {
  const grid = Math.max(1, Math.trunc(Number(gridSize) || 1));
  const target = Math.max(1, Math.trunc(Number(targetPixels) || 1));
  const safeMaxIter = Math.max(0, Math.trunc(Number(maxIter) || 0));
  let working = mask instanceof Uint8Array ? mask : createMask(grid, grid, 0);
  let pixels = countOnes(working);
  let iters = 0;
  while (pixels < target && iters < safeMaxIter) {
    let expanded = dilateMaskOnce(working, grid);
    if (faceOvalMask) expanded = andMasks(expanded, faceOvalMask);
    const expandedPixels = countOnes(expanded);
    working = expanded;
    iters += 1;
    if (expandedPixels <= pixels) {
      pixels = expandedPixels;
      break;
    }
    pixels = expandedPixels;
  }
  return {
    mask: working,
    pixels,
    dilation_iters: iters,
  };
}

function attachModuleMasks({
  modules,
  regions,
  skinMask,
  moduleBoxes,
  gridSize,
  allowFaceOvalClip,
} = {}) {
  const safeModules = Array.isArray(modules) ? modules : [];
  const safeRegions = Array.isArray(regions) ? regions : [];
  const targetGrid = normalizeMaskGridSize(gridSize, MODULE_MASK_GRID_SIZE);
  const activeModuleBoxes = moduleBoxes && typeof moduleBoxes === 'object' ? moduleBoxes : MODULE_BOXES;
  const moduleIds = Object.keys(activeModuleBoxes);

  const skinMaskNorm = decodeSkinMaskToGrid(skinMask, targetGrid);
  const staticFaceOvalMask =
    FACE_OVAL_CLIP_ENABLED && allowFaceOvalClip !== false
      ? polygonNormToMask(FACE_OVAL_POLYGON, targetGrid, targetGrid)
      : null;
  const dynamicFaceOvalSelection =
    FACE_OVAL_CLIP_ENABLED && allowFaceOvalClip !== false && skinMaskNorm
      ? selectFaceComponentFromMask(
        skinMaskNorm,
        targetGrid,
        {
          minPixels: Math.max(FACE_OVAL_CLIP_MIN_PIXELS, Math.trunc(targetGrid * targetGrid * 0.02)),
          centerX: 0.5,
          centerY: 0.54,
        },
      )
      : null;
  const dynamicFaceOvalCandidate =
    dynamicFaceOvalSelection && dynamicFaceOvalSelection.mask ? dynamicFaceOvalSelection.mask : null;
  const dynamicFaceOvalPixels = countOnes(dynamicFaceOvalCandidate || createMask(targetGrid, targetGrid, 0));
  const dynamicFaceOvalRatio = dynamicFaceOvalPixels / Math.max(1, targetGrid * targetGrid);
  const dynamicFaceOvalBox = dynamicFaceOvalCandidate ? maskBoundingBox(dynamicFaceOvalCandidate, targetGrid) : null;
  const dynamicFaceOvalAspect = dynamicFaceOvalBox && Number.isFinite(Number(dynamicFaceOvalBox.w))
    && Number.isFinite(Number(dynamicFaceOvalBox.h))
    && Number(dynamicFaceOvalBox.h) > 1e-6
    ? Number(dynamicFaceOvalBox.w) / Number(dynamicFaceOvalBox.h)
    : null;
  const dynamicFaceOvalPlausible =
    dynamicFaceOvalCandidate &&
    dynamicFaceOvalRatio >= 0.02 &&
    dynamicFaceOvalBox &&
    Number.isFinite(Number(dynamicFaceOvalAspect)) &&
    dynamicFaceOvalAspect >= 0.25 &&
    dynamicFaceOvalAspect <= 1.15 &&
    Number(dynamicFaceOvalBox.w) * Number(dynamicFaceOvalBox.h) >= 0.08;
  const dynamicFaceOvalMask = dynamicFaceOvalPlausible ? dynamicFaceOvalCandidate : null;
  const faceOvalMask = dynamicFaceOvalMask || staticFaceOvalMask;
  const faceOvalMaskSource = dynamicFaceOvalMask
    ? 'skinmask_component'
    : staticFaceOvalMask
      ? 'template_fallback'
      : 'none';
  const faceOvalBox = faceOvalMask ? maskBoundingBox(faceOvalMask, targetGrid) : null;

  const skinMaskPositiveRatio = skinMask && Number.isFinite(Number(skinMask.positive_ratio))
    ? Number(skinMask.positive_ratio)
    : skinMaskNorm
      ? countOnes(skinMaskNorm) / Math.max(1, targetGrid * targetGrid)
      : 0;
  const skinMaskReliable =
    Boolean(skinMaskNorm) &&
    skinMaskPositiveRatio >= MODULE_SKIN_POSITIVE_RATIO_MIN &&
    skinMaskPositiveRatio <= MODULE_SKIN_POSITIVE_RATIO_MAX;

  const effectiveModuleBoxes = {};
  const shrinkFactorsUsed = {};
  let chinGuardApplied = false;
  let noseGuardApplied = false;
  let chinHardGuardApplied = false;
  let noseHardGuardApplied = false;
  let foreheadBandApplied = false;
  for (const moduleId of moduleIds) {
    const baseBox = activeModuleBoxes[moduleId];
    const scale = moduleShrinkScale(moduleId);
    shrinkFactorsUsed[moduleId] = round3(scale);
    const adjusted = shrinkModuleBox(baseBox, scale);
    const guarded = applyModuleGuards(moduleId, adjusted || baseBox, { faceOvalBox, faceOvalMaskSource });
    if (guarded.box) effectiveModuleBoxes[moduleId] = guarded.box;
    chinGuardApplied = chinGuardApplied || guarded.chinGuardApplied;
    noseGuardApplied = noseGuardApplied || guarded.noseGuardApplied;
    foreheadBandApplied = foreheadBandApplied || guarded.foreheadBandApplied;
  }

  const regionMaskMap = new Map();
  for (const region of safeRegions) {
    const regionId = String(region && region.region_id ? region.region_id : '').trim();
    if (!regionId) continue;
    regionMaskMap.set(regionId, buildRegionMask(region, targetGrid));
  }
  let refinedModules = 0;
  let fallbackSkippedModules = 0;
  let faceOvalClipFallbackModules = 0;
  const faceOvalClipFallbackReasons = [];
  const degradedReasons = new Set();
  const modulePixelsMap = {};
  const guardedModules = [];
  const moduleGuardPixelDiffs = [];
  const guardEnabledModules = new Set(['under_eye_left', 'under_eye_right', 'forehead', 'chin']);

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
    let moduleDegradedReason = null;

    if (moduleId === 'chin') {
      const chinGuardMask = buildChinGuardMask({
        targetGrid,
        moduleBox: moduleBaseBox,
        faceOvalMask,
        faceOvalBox,
        faceOvalMaskSource,
      });
      if (chinGuardMask) {
        const constrained = andMasks(finalMask, chinGuardMask);
        if (countOnes(constrained) > 0) {
          finalMask = constrained;
          chinHardGuardApplied = true;
          chinGuardApplied = true;
        }
      }
    } else if (moduleId === 'nose') {
      const noseGuardMask = buildNoseGuardMask({
        targetGrid,
        moduleBox: moduleBaseBox,
        faceOvalMask,
        faceOvalBox,
        faceOvalMaskSource,
      });
      if (noseGuardMask) {
        const constrained = andMasks(finalMask, noseGuardMask);
        if (countOnes(constrained) > 0) {
          finalMask = constrained;
          noseHardGuardApplied = true;
          noseGuardApplied = true;
        }
      }
    }

    if (faceOvalMask) {
      const strictModule = moduleId === 'chin' || moduleId === 'nose';
      const baselineMask = countOnes(modulePolygonMask) ? modulePolygonMask : finalMask;
      const baselinePixels = countOnes(baselineMask);
      const clippedMask = andMasks(finalMask, faceOvalMask);
      const clippedPixels = countOnes(clippedMask);
      const clipKeepThreshold = Math.max(
        FACE_OVAL_CLIP_MIN_PIXELS,
        Math.trunc(Math.max(1, baselinePixels) * FACE_OVAL_CLIP_MIN_KEEP_RATIO),
      );
      if (clippedPixels >= clipKeepThreshold || (strictModule && clippedPixels > 0)) {
        finalMask = clippedMask;
      } else if (baselinePixels || countOnes(clippedMask)) {
        if (strictModule) {
          const strictScales = [0.92, 0.84, 0.76, 0.68];
          let strictBestMask = null;
          let strictBestPixels = 0;
          let strictReason = null;
          for (const scale of strictScales) {
            const strictMask = moduleId === 'chin'
              ? buildChinGuardMask({
                targetGrid,
                moduleBox: moduleBaseBox,
                faceOvalMask,
                faceOvalBox,
                faceOvalMaskSource,
                boxScale: scale,
              })
              : buildNoseGuardMask({
                targetGrid,
                moduleBox: moduleBaseBox,
                faceOvalMask,
                faceOvalBox,
                faceOvalMaskSource,
                boxScale: scale,
              });
            const strictPixels = countOnes(strictMask || createMask(targetGrid, targetGrid, 0));
            if (strictPixels > 0 && strictPixels > strictBestPixels) {
              strictBestMask = strictMask;
              strictBestPixels = strictPixels;
              strictReason = `STRICT_GUARD_SHRINK_${round3(scale)}`;
            }
            if (strictPixels >= FACE_OVAL_CLIP_MIN_PIXELS) {
              strictBestMask = strictMask;
              strictBestPixels = strictPixels;
              strictReason = `STRICT_GUARD_SHRINK_${round3(scale)}`;
              break;
            }
          }
          if (strictBestMask && strictBestPixels > 0) {
            finalMask = strictBestMask;
            moduleDegradedReason = 'FACE_OVAL_CLIP_TOO_SMALL';
            faceOvalClipFallbackModules += 1;
            if (strictReason) faceOvalClipFallbackReasons.push(String(strictReason));
            degradedReasons.add(moduleDegradedReason);
          } else {
            finalMask = clippedMask;
          }
        } else {
          const fallbackMask = buildFaceOvalClipFallbackMask({
            moduleId,
            moduleBox: moduleBaseBox,
            targetGrid,
            faceOvalMask,
            baselinePixels,
          });
          finalMask = fallbackMask.mask || clippedMask;
          moduleDegradedReason = 'FACE_OVAL_CLIP_TOO_SMALL';
          faceOvalClipFallbackModules += 1;
          if (fallbackMask.reason) faceOvalClipFallbackReasons.push(String(fallbackMask.reason));
          degradedReasons.add(moduleDegradedReason);
        }
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

    const beforeGuardPixels = countOnes(finalMask);
    const moduleThreshold = moduleMinPixelsThreshold(moduleId);
    const guardEnabled = guardEnabledModules.has(moduleId);
    if (guardEnabled && moduleThreshold > 0 && beforeGuardPixels < moduleThreshold) {
      let guardMethod = null;
      let dilationIters = 0;
      let guardMask = finalMask;
      let guardPixels = beforeGuardPixels;

      const dilated = adaptiveDilateWithinFaceOval({
        mask: guardMask,
        targetPixels: moduleThreshold,
        gridSize: targetGrid,
        maxIter: MODULE_GUARD_DILATION_MAX_ITER,
        faceOvalMask: faceOvalMask || null,
      });
      if (dilated && countOnes(dilated.mask) > guardPixels) {
        guardMask = dilated.mask;
        guardPixels = countOnes(dilated.mask);
        dilationIters = Math.max(0, Math.trunc(Number(dilated.dilation_iters) || 0));
        guardMethod = 'dilate';
      }

      if (guardPixels < moduleThreshold) {
        const rawBaseBox = activeModuleBoxes[moduleId] || MODULE_BOXES[moduleId] || moduleBaseBox;
        const rawGuarded = applyModuleGuards(moduleId, rawBaseBox || moduleBaseBox, {
          faceOvalBox,
          faceOvalMaskSource,
        });
        const rawGuardBox = rawGuarded.box || rawBaseBox || moduleBaseBox;
        let rawMask = bboxNormToMask(rawGuardBox, targetGrid, targetGrid);
        if (faceOvalMask) rawMask = andMasks(rawMask, faceOvalMask);
        const rawPixels = countOnes(rawMask);
        if (rawPixels > guardPixels) {
          guardMask = rawMask;
          guardPixels = rawPixels;
          guardMethod = 'revert_raw';
        }
      }

      if (guardPixels < moduleThreshold && faceOvalMask && moduleBaseBox) {
        const fallback = buildFaceOvalClipFallbackMask({
          moduleId,
          moduleBox: activeModuleBoxes[moduleId] || MODULE_BOXES[moduleId] || moduleBaseBox,
          targetGrid,
          faceOvalMask,
          baselinePixels: guardPixels,
        });
        const fallbackPixels = countOnes(fallback && fallback.mask ? fallback.mask : createMask(targetGrid, targetGrid, 0));
        if (fallback && fallback.mask && fallbackPixels > guardPixels) {
          guardMask = fallback.mask;
          guardPixels = fallbackPixels;
          guardMethod = 'template_fallback';
        }
      }

      if (guardPixels > beforeGuardPixels) {
        finalMask = guardMask;
      }
      const afterGuardPixels = countOnes(finalMask);
      if (afterGuardPixels < moduleThreshold && !moduleDegradedReason) {
        moduleDegradedReason = isUnderEyeModule(moduleId) ? 'UNDER_EYE_TOO_THIN' : 'MODULE_TOO_THIN';
        degradedReasons.add(moduleDegradedReason);
      }
      guardedModules.push(moduleId);
      moduleGuardPixelDiffs.push({
        module_id: moduleId,
        before_pixels: beforeGuardPixels,
        after_pixels: afterGuardPixels,
        threshold: moduleThreshold,
        guard_method: guardMethod || 'none',
        dilation_iters: dilationIters,
      });
    }

    const finalPixels = countOnes(finalMask);
    modulePixelsMap[moduleId] = finalPixels;

    const box = maskBoundingBox(finalMask, targetGrid) || modulePayload.box || moduleBaseBox || null;
    return {
      ...modulePayload,
      ...(moduleDegradedReason ? { degraded_reason: moduleDegradedReason } : {}),
      ...(box ? { box } : {}),
      ...(evidenceIds.size ? { evidence_region_ids: Array.from(evidenceIds) } : {}),
      mask_grid: targetGrid,
      module_pixels: finalPixels,
      mask_rle_norm: encodeRleBinary(finalMask),
    };
  });

  const modulePixelValues = Object.values(modulePixelsMap)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const modulePixelsMin = modulePixelValues.length ? Math.max(0, Math.min(...modulePixelValues)) : 0;

  return {
    modules: modulesOut,
    skinmask_refined_modules: refinedModules,
    skinmask_skipped_modules: fallbackSkippedModules,
    skinmask_grid: targetGrid,
    skinmask_available: Boolean(skinMaskNorm),
    skinmask_reliable: Boolean(skinMaskReliable),
    skinmask_positive_ratio: Number.isFinite(skinMaskPositiveRatio) ? round3(skinMaskPositiveRatio) : null,
    face_oval_clip_enabled: Boolean(faceOvalMask),
    face_oval_mask_source: faceOvalMaskSource,
    face_oval_clip_fallback_modules: faceOvalClipFallbackModules,
    face_oval_clip_fallback_reason:
      faceOvalClipFallbackReasons.length > 0 ? String(faceOvalClipFallbackReasons[0]) : null,
    face_oval_component_score:
      dynamicFaceOvalSelection && Number.isFinite(Number(dynamicFaceOvalSelection.score))
        ? Number(dynamicFaceOvalSelection.score)
        : null,
    face_oval_component_count:
      dynamicFaceOvalSelection && Number.isFinite(Number(dynamicFaceOvalSelection.component_count))
        ? Math.max(0, Math.trunc(Number(dynamicFaceOvalSelection.component_count)))
        : null,
    shrink_factors_used: shrinkFactorsUsed,
    chin_guard_applied: chinGuardApplied,
    nose_guard_applied: noseGuardApplied,
    chin_hard_guard_applied: chinHardGuardApplied,
    nose_hard_guard_applied: noseHardGuardApplied,
    forehead_band_ratio_used: round3(FOREHEAD_BAND_RATIO),
    forehead_band_applied: foreheadBandApplied,
    module_pixels_map: modulePixelsMap,
    module_pixels_min: Math.max(0, Math.trunc(modulePixelsMin)),
    module_guard_triggered: guardedModules.length > 0,
    guarded_modules: Array.from(new Set(guardedModules)),
    module_guard_pixel_diffs: moduleGuardPixelDiffs,
    module_min_pixels_under_eye: MODULE_MIN_PIXELS_UNDER_EYE,
    module_min_pixels_forehead: MODULE_MIN_PIXELS_FOREHEAD,
    module_min_pixels_chin: MODULE_MIN_PIXELS_CHIN,
    module_min_pixels_cheek: MODULE_MIN_PIXELS_CHEEK,
    module_min_pixels_default: MODULE_MIN_PIXELS_DEFAULT,
    degraded_reasons: Array.from(degradedReasons),
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
  const moduleBoxDerivation = deriveModuleBoxesFromSkinMask({
    skinMask,
    gridSize: MODULE_MASK_GRID_SIZE,
  });
  const moduleBoxDynamicDebug = resolveModuleBoxDynamicDebug({ derivation: moduleBoxDerivation });
  const useDynamicModuleBoxes = moduleBoxDynamicDebug.module_box_mode === 'dynamic_skinmask'
    && moduleBoxDynamicDebug.module_box_dynamic_applied
    && moduleBoxDerivation
    && moduleBoxDerivation.module_boxes
    && typeof moduleBoxDerivation.module_boxes === 'object';
  const activeModuleBoxes = useDynamicModuleBoxes
    ? moduleBoxDerivation.module_boxes
    : MODULE_BOXES;
  const regionBuild = buildRegionsFromFindings({ findings, qualityFlags });
  const regions = regionBuild.regions;
  const allowFaceOvalClip = Boolean(
    diagnosisInternal &&
      typeof diagnosisInternal === 'object' &&
      diagnosisInternal.face_crop &&
      typeof diagnosisInternal.face_crop === 'object' &&
      diagnosisInternal.face_crop.bbox_px &&
      typeof diagnosisInternal.face_crop.bbox_px === 'object',
  );

  const modulesBuild = buildModules({
    regions,
    regionMeta: regionBuild.regionMeta,
    moduleBoxes: activeModuleBoxes,
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
    moduleBoxes: activeModuleBoxes,
    gridSize: MODULE_MASK_GRID_SIZE,
    allowFaceOvalClip,
  });

  const payload = {
    used_photos: true,
    quality_grade: qualityGrade,
    ...(typeof photoNotice === 'string' && photoNotice.trim() ? { photo_notice: photoNotice.trim() } : {}),
    face_crop: faceCrop,
    regions,
    modules: moduleMaskBuild.modules,
    ...(Array.isArray(moduleMaskBuild.degraded_reasons) && moduleMaskBuild.degraded_reasons.length
      ? { degraded_reason: moduleMaskBuild.degraded_reasons[0], degraded_reasons: moduleMaskBuild.degraded_reasons }
      : {}),
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
      face_oval_clip_enabled: moduleMaskBuild.face_oval_clip_enabled,
      face_oval_mask_source: moduleMaskBuild.face_oval_mask_source,
      face_oval_clip_fallback_modules: moduleMaskBuild.face_oval_clip_fallback_modules,
      clip_fallback_reason: moduleMaskBuild.face_oval_clip_fallback_reason,
      face_oval_component_score: moduleMaskBuild.face_oval_component_score,
      face_oval_component_count: moduleMaskBuild.face_oval_component_count,
      shrink_factors_used: moduleMaskBuild.shrink_factors_used,
      chin_guard_applied: moduleMaskBuild.chin_guard_applied,
      chin_hard_guard_applied: moduleMaskBuild.chin_hard_guard_applied,
      nose_guard_applied: moduleMaskBuild.nose_guard_applied,
      nose_hard_guard_applied: moduleMaskBuild.nose_hard_guard_applied,
      forehead_band_ratio_used: moduleMaskBuild.forehead_band_ratio_used,
      forehead_band_applied: moduleMaskBuild.forehead_band_applied,
      module_pixels_map: moduleMaskBuild.module_pixels_map,
      module_pixels_min: moduleMaskBuild.module_pixels_min,
      module_guard_triggered: moduleMaskBuild.module_guard_triggered,
      guarded_modules: moduleMaskBuild.guarded_modules,
      module_guard_pixel_diffs: moduleMaskBuild.module_guard_pixel_diffs,
      module_box_mode: moduleBoxDynamicDebug.module_box_mode,
      module_box_dynamic_applied: moduleBoxDynamicDebug.module_box_dynamic_applied,
      module_box_dynamic_reason: moduleBoxDynamicDebug.module_box_dynamic_reason,
      module_box_dynamic_score: moduleBoxDynamicDebug.module_box_dynamic_score,
      module_box_overlap_score: Number.isFinite(Number(moduleBoxDerivation && moduleBoxDerivation.overlap_score))
        ? Number(moduleBoxDerivation.overlap_score)
        : null,
      module_box_positive_ratio: Number.isFinite(Number(moduleBoxDerivation && moduleBoxDerivation.positive_ratio))
        ? Number(moduleBoxDerivation.positive_ratio)
        : null,
      module_box_anchors: moduleBoxDerivation && moduleBoxDerivation.anchors ? moduleBoxDerivation.anchors : null,
      module_min_pixels_under_eye: moduleMaskBuild.module_min_pixels_under_eye,
      module_min_pixels_forehead: moduleMaskBuild.module_min_pixels_forehead,
      module_min_pixels_chin: moduleMaskBuild.module_min_pixels_chin,
      module_min_pixels_cheek: moduleMaskBuild.module_min_pixels_cheek,
      module_min_pixels_default: moduleMaskBuild.module_min_pixels_default,
      degraded_reasons: moduleMaskBuild.degraded_reasons,
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
