'use strict';

const {
  MODULE_BOXES,
  bboxNormToMask,
  andMasks,
  countOnes,
} = require('./metrics');

function cloneDefaultBoxes() {
  const out = {};
  for (const [moduleId, box] of Object.entries(MODULE_BOXES)) {
    out[moduleId] = {
      x: Number(box.x),
      y: Number(box.y),
      w: Number(box.w),
      h: Number(box.h),
    };
  }
  return out;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function sanitizeBox(rawBox, fallback) {
  const fb = fallback && typeof fallback === 'object'
    ? fallback
    : { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  if (!rawBox || typeof rawBox !== 'object') {
    return { x: round4(fb.x), y: round4(fb.y), w: round4(fb.w), h: round4(fb.h) };
  }
  const x = clamp01(rawBox.x);
  const y = clamp01(rawBox.y);
  const x1 = clamp01(Number(rawBox.x) + Number(rawBox.w));
  const y1 = clamp01(Number(rawBox.y) + Number(rawBox.h));
  const minX = Math.min(x, x1);
  const minY = Math.min(y, y1);
  const maxX = Math.max(x, x1);
  const maxY = Math.max(y, y1);
  const w = Math.max(0.02, maxX - minX);
  const h = Math.max(0.02, maxY - minY);
  return {
    x: round4(Math.max(0, Math.min(0.98, minX))),
    y: round4(Math.max(0, Math.min(0.98, minY))),
    w: round4(Math.max(0.02, Math.min(1, w))),
    h: round4(Math.max(0.02, Math.min(1, h))),
  };
}

function weightedMedian(values, weights) {
  if (!Array.isArray(values) || !values.length) return 0;
  const rows = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) continue;
    const weight = Number.isFinite(Number(weights && weights[i])) ? Math.max(0, Number(weights[i])) : 1;
    if (weight <= 0) continue;
    rows.push({ value, weight });
  }
  if (!rows.length) return 0;
  rows.sort((a, b) => a.value - b.value);
  const totalWeight = rows.reduce((acc, row) => acc + row.weight, 0);
  const target = totalWeight / 2;
  let cumulative = 0;
  for (const row of rows) {
    cumulative += row.weight;
    if (cumulative >= target) return row.value;
  }
  return rows[rows.length - 1].value;
}

function fitModuleBoxes(sampleRows, defaults = cloneDefaultBoxes()) {
  const grouped = {};
  for (const moduleId of Object.keys(defaults)) grouped[moduleId] = [];
  for (const row of Array.isArray(sampleRows) ? sampleRows : []) {
    if (!row || typeof row !== 'object') continue;
    const moduleId = String(row.module_id || '').trim();
    if (!moduleId || !grouped[moduleId]) continue;
    const box = sanitizeBox(row.box, defaults[moduleId]);
    const weight = Number.isFinite(Number(row.weight)) ? Math.max(0, Number(row.weight)) : 1;
    if (weight <= 0) continue;
    grouped[moduleId].push({
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      weight,
      source: String(row.source || 'unknown'),
    });
  }

  const outBoxes = {};
  const stats = {};
  for (const [moduleId, rows] of Object.entries(grouped)) {
    if (!rows.length) {
      outBoxes[moduleId] = sanitizeBox(defaults[moduleId], defaults[moduleId]);
      stats[moduleId] = {
        samples: 0,
        strong_samples: 0,
        weak_samples: 0,
        fallback_default: true,
      };
      continue;
    }
    const weights = rows.map((row) => row.weight);
    const box = sanitizeBox({
      x: weightedMedian(rows.map((row) => row.x), weights),
      y: weightedMedian(rows.map((row) => row.y), weights),
      w: weightedMedian(rows.map((row) => row.w), weights),
      h: weightedMedian(rows.map((row) => row.h), weights),
    }, defaults[moduleId]);
    outBoxes[moduleId] = box;
    stats[moduleId] = {
      samples: rows.length,
      strong_samples: rows.filter((row) => row.source === 'strong').length,
      weak_samples: rows.filter((row) => row.source !== 'strong').length,
      fallback_default: false,
    };
  }

  return {
    module_boxes: outBoxes,
    module_stats: stats,
  };
}

function validateModuleBoxes(rawBoxes, defaults = cloneDefaultBoxes()) {
  const payload = rawBoxes && typeof rawBoxes === 'object' ? rawBoxes : {};
  const out = {};
  for (const [moduleId, fallback] of Object.entries(defaults)) {
    out[moduleId] = sanitizeBox(payload[moduleId], fallback);
  }
  return out;
}

function applyModelBoxCalibration({
  moduleId,
  predMask,
  gridSize,
  modelBoxes,
  minPixels = 24,
}) {
  if (!(predMask instanceof Uint8Array)) return predMask;
  const box = modelBoxes && modelBoxes[moduleId];
  if (!box) return predMask;
  const boxMask = bboxNormToMask(box, gridSize, gridSize);
  const filtered = andMasks(predMask, boxMask);
  if (countOnes(filtered) >= Math.max(1, Number(minPixels) || 24)) return filtered;
  return predMask;
}

module.exports = {
  cloneDefaultBoxes,
  sanitizeBox,
  weightedMedian,
  fitModuleBoxes,
  validateModuleBoxes,
  applyModelBoxCalibration,
};

