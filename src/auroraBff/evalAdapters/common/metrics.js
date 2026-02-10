'use strict';

const MODULE_BOXES = Object.freeze({
  forehead: { x: 0.2, y: 0.03, w: 0.6, h: 0.22 },
  left_cheek: { x: 0.08, y: 0.34, w: 0.34, h: 0.3 },
  right_cheek: { x: 0.58, y: 0.34, w: 0.34, h: 0.3 },
  nose: { x: 0.42, y: 0.32, w: 0.16, h: 0.32 },
  chin: { x: 0.33, y: 0.67, w: 0.34, h: 0.26 },
  under_eye_left: { x: 0.18, y: 0.24, w: 0.24, h: 0.13 },
  under_eye_right: { x: 0.58, y: 0.24, w: 0.24, h: 0.13 },
});

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function createMask(width, height, fill = 0) {
  const w = Math.max(1, Math.trunc(Number(width) || 0));
  const h = Math.max(1, Math.trunc(Number(height) || 0));
  const v = fill ? 1 : 0;
  return new Uint8Array(w * h).fill(v);
}

function idx(x, y, width) {
  return y * width + x;
}

function fillRect(mask, width, height, x0, y0, x1, y1, value = 1) {
  const nx0 = Math.max(0, Math.min(width, Math.floor(Math.min(x0, x1))));
  const nx1 = Math.max(0, Math.min(width, Math.ceil(Math.max(x0, x1))));
  const ny0 = Math.max(0, Math.min(height, Math.floor(Math.min(y0, y1))));
  const ny1 = Math.max(0, Math.min(height, Math.ceil(Math.max(y0, y1))));
  if (nx1 <= nx0 || ny1 <= ny0) return;
  for (let y = ny0; y < ny1; y += 1) {
    for (let x = nx0; x < nx1; x += 1) {
      mask[idx(x, y, width)] = value ? 1 : 0;
    }
  }
}

function bboxNormToMask(box, width, height) {
  const out = createMask(width, height, 0);
  if (!box || typeof box !== 'object') return out;
  const x0 = clamp01(Number(box.x));
  const y0 = clamp01(Number(box.y));
  const x1 = clamp01(Number(box.x) + Number(box.w));
  const y1 = clamp01(Number(box.y) + Number(box.h));
  fillRect(out, width, height, x0 * width, y0 * height, x1 * width, y1 * height, 1);
  return out;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonNormToMask(polygon, width, height) {
  const out = createMask(width, height, 0);
  const points = Array.isArray(polygon && polygon.points) ? polygon.points : [];
  if (points.length < 3) return out;
  const normPoints = points.map((p) => ({ x: clamp01(Number(p.x)), y: clamp01(Number(p.y)) }));
  for (let y = 0; y < height; y += 1) {
    const ny = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) / width;
      if (pointInPolygon(nx, ny, normPoints)) out[idx(x, y, width)] = 1;
    }
  }
  return out;
}

function resizeHeatmapToMask(values, srcW, srcH, dstW, dstH, threshold = 0.35, intensity = 1) {
  const out = createMask(dstW, dstH, 0);
  if (!Array.isArray(values) || values.length !== srcW * srcH) return out;
  const scaledThreshold = clamp01(Number(threshold));
  const scaledIntensity = clamp01(Number(intensity || 1));
  for (let y = 0; y < dstH; y += 1) {
    const sy = ((y + 0.5) * srcH) / dstH - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const ty = sy - y0;
    for (let x = 0; x < dstW; x += 1) {
      const sx = ((x + 0.5) * srcW) / dstW - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const tx = sx - x0;
      const q11 = Number(values[y0 * srcW + x0] || 0);
      const q21 = Number(values[y0 * srcW + x1] || 0);
      const q12 = Number(values[y1 * srcW + x0] || 0);
      const q22 = Number(values[y1 * srcW + x1] || 0);
      const a = q11 * (1 - tx) + q21 * tx;
      const b = q12 * (1 - tx) + q22 * tx;
      const v = clamp01((a * (1 - ty) + b * ty) * scaledIntensity);
      if (v >= scaledThreshold) out[idx(x, y, dstW)] = 1;
    }
  }
  return out;
}

function orMaskInto(target, source) {
  const len = Math.min(target.length, source.length);
  for (let i = 0; i < len; i += 1) {
    if (source[i]) target[i] = 1;
  }
}

function andMasks(a, b) {
  const len = Math.min(a.length, b.length);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = a[i] && b[i] ? 1 : 0;
  }
  return out;
}

function notMask(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    out[i] = mask[i] ? 0 : 1;
  }
  return out;
}

function countOnes(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) count += 1;
  }
  return count;
}

function intersectionCount(a, b) {
  const len = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < len; i += 1) {
    if (a[i] && b[i]) count += 1;
  }
  return count;
}

function unionCount(a, b) {
  const len = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < len; i += 1) {
    if (a[i] || b[i]) count += 1;
  }
  return count;
}

function safeRatio(num, den) {
  return den > 0 ? num / den : 0;
}

function iouScore(predMask, gtMask) {
  return safeRatio(intersectionCount(predMask, gtMask), unionCount(predMask, gtMask));
}

function coverageScore(predMask, gtMask) {
  return safeRatio(intersectionCount(predMask, gtMask), countOnes(gtMask));
}

function leakageScore(predMask, gtSkinMask) {
  const nonSkin = notMask(gtSkinMask);
  return safeRatio(intersectionCount(predMask, nonSkin), countOnes(predMask));
}

function encodeRleBinary(mask) {
  const counts = [];
  let current = 0;
  let run = 0;
  for (let i = 0; i < mask.length; i += 1) {
    const value = mask[i] ? 1 : 0;
    if (value === current) {
      run += 1;
      continue;
    }
    counts.push(run);
    run = 1;
    current = value;
  }
  counts.push(run);
  return counts.join(',');
}

function decodeRleBinary(rle, expectedLength) {
  const chunks = String(rle || '')
    .split(',')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part) && part >= 0);
  const out = new Uint8Array(Math.max(0, Number(expectedLength) || 0));
  let value = 0;
  let offset = 0;
  for (const count of chunks) {
    const n = Math.trunc(count);
    if (n <= 0) {
      value = value ? 0 : 1;
      continue;
    }
    const end = Math.min(out.length, offset + n);
    if (value) {
      out.fill(1, offset, end);
    }
    offset = end;
    value = value ? 0 : 1;
    if (offset >= out.length) break;
  }
  return out;
}

function moduleMaskFromBox(moduleId, width, height, moduleBoxes) {
  const lookup = moduleBoxes && typeof moduleBoxes === 'object' ? moduleBoxes : MODULE_BOXES;
  const box = lookup[moduleId];
  if (!box) return createMask(width, height, 0);
  return bboxNormToMask(box, width, height);
}

module.exports = {
  MODULE_BOXES,
  clamp01,
  createMask,
  bboxNormToMask,
  polygonNormToMask,
  resizeHeatmapToMask,
  orMaskInto,
  andMasks,
  notMask,
  countOnes,
  intersectionCount,
  unionCount,
  iouScore,
  coverageScore,
  leakageScore,
  encodeRleBinary,
  decodeRleBinary,
  moduleMaskFromBox,
};
