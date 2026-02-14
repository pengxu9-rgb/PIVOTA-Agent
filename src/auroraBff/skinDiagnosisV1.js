const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ANALYSIS_MAX_SIDE = 256;

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round3(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function median(sorted) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const pp = clamp01(p);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(pp * (sorted.length - 1))));
  return sorted[idx];
}

function rgbToYCrCb(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cr = (r - y) * 0.713 + 128;
  const cb = (b - y) * 0.564 + 128;
  return { y, cr, cb };
}

function rgbToLabFast(r8, g8, b8) {
  const r = SRGB_TO_LINEAR[r8];
  const g = SRGB_TO_LINEAR[g8];
  const b = SRGB_TO_LINEAR[b8];

  // D65
  let x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let z = r * 0.0193 + g * 0.1192 + b * 0.9505;

  // Normalize by reference white.
  x /= 0.95047;
  y /= 1.0;
  z /= 1.08883;

  const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const b2 = 200 * (fy - fz);
  return { L, a, b: b2 };
}

async function decodeToSmallRgb(imageBuffer, { maxSide = ANALYSIS_MAX_SIDE } = {}) {
  const { data, info } = await sharp(imageBuffer)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info && typeof info.width === 'number' ? info.width : null;
  const height = info && typeof info.height === 'number' ? info.height : null;
  if (!width || !height) throw new Error('decode_failed');
  if (!data || data.length !== width * height * 3) throw new Error('decode_failed');
  return { rgb: data, width, height };
}

function computeSkinMask(rgb, width, height) {
  const n = width * height;
  const labels = new Int32Array(n);
  let nextId = 0;

  const centerX0 = Math.floor(width * 0.35);
  const centerX1 = Math.ceil(width * 0.65);
  const centerY0 = Math.floor(height * 0.35);
  const centerY1 = Math.ceil(height * 0.7);

  function isSeedSkin(i) {
    const off = i * 3;
    const r = rgb[off];
    const g = rgb[off + 1];
    const b = rgb[off + 2];
    const { y, cr, cb } = rgbToYCrCb(r, g, b);
    // Conservative classic thresholds, avoid very dark pixels.
    if (y < 40) return false;
    if (cr < 133 || cr > 178) return false;
    if (cb < 80 || cb > 135) return false;
    return true;
  }

  const components = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (labels[i] !== 0) continue;
    if (!isSeedSkin(i)) continue;

    nextId += 1;
    const id = nextId;
    let top = 0;
    stack[top++] = i;
    labels[i] = id;

    let size = 0;
    let touchCenter = false;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (top > 0) {
      const idx = stack[--top];
      size += 1;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x >= centerX0 && x <= centerX1 && y >= centerY0 && y <= centerY1) touchCenter = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const up = y > 0 ? idx - width : -1;
      const down = y + 1 < height ? idx + width : -1;
      const left = x > 0 ? idx - 1 : -1;
      const right = x + 1 < width ? idx + 1 : -1;

      if (up >= 0 && labels[up] === 0 && isSeedSkin(up)) {
        labels[up] = id;
        stack[top++] = up;
      }
      if (down >= 0 && labels[down] === 0 && isSeedSkin(down)) {
        labels[down] = id;
        stack[top++] = down;
      }
      if (left >= 0 && labels[left] === 0 && isSeedSkin(left)) {
        labels[left] = id;
        stack[top++] = left;
      }
      if (right >= 0 && labels[right] === 0 && isSeedSkin(right)) {
        labels[right] = id;
        stack[top++] = right;
      }
    }

    components.push({
      id,
      size,
      touchCenter,
      bbox: { x0: minX, y0: minY, x1: maxX, y1: maxY },
    });
  }

  if (!components.length) {
    return { ok: false, reason: 'skin_roi_not_found' };
  }

  const minAcceptSize = Math.max(200, Math.floor(n * 0.06));
  let best = null;
  for (const c of components) {
    if (c.size < minAcceptSize) continue;
    const score = c.size * (c.touchCenter ? 1.35 : 1.0);
    if (!best || score > best.score) best = { ...c, score };
  }
  if (!best) return { ok: false, reason: 'skin_roi_too_small' };

  const mask = new Uint8Array(n);
  let skinPixels = 0;
  for (let i = 0; i < n; i += 1) {
    if (labels[i] === best.id) {
      mask[i] = 1;
      skinPixels += 1;
    }
  }

  const coverage = skinPixels / n;
  return {
    ok: true,
    mask,
    skinPixels,
    coverage,
    bbox: best.bbox,
    touchCenter: best.touchCenter,
  };
}

function computeRegionBoxes(bbox) {
  const x0 = bbox.x0;
  const y0 = bbox.y0;
  const x1 = bbox.x1;
  const y1 = bbox.y1;
  const w = Math.max(1, x1 - x0 + 1);
  const h = Math.max(1, y1 - y0 + 1);

  function box(rx0, ry0, rx1, ry1) {
    const xx0 = Math.round(x0 + rx0 * w);
    const yy0 = Math.round(y0 + ry0 * h);
    const xx1 = Math.round(x0 + rx1 * w);
    const yy1 = Math.round(y0 + ry1 * h);
    return {
      x0: Math.min(xx0, xx1),
      y0: Math.min(yy0, yy1),
      x1: Math.max(xx0, xx1),
      y1: Math.max(yy0, yy1),
    };
  }

  return {
    full: { x0, y0, x1, y1 },
    forehead: box(0.2, 0.0, 0.8, 0.28),
    nose: box(0.4, 0.34, 0.6, 0.66),
    cheeks: box(0.12, 0.34, 0.88, 0.74),
    left_cheek: box(0.12, 0.38, 0.42, 0.74),
    right_cheek: box(0.58, 0.38, 0.88, 0.74),
    chin: box(0.25, 0.74, 0.75, 1.0),
    // Exclusions (very approximate).
    exclude_eyes: box(0.15, 0.22, 0.85, 0.46),
    exclude_mouth: box(0.22, 0.74, 0.78, 0.93),
  };
}

function isInside(x, y, box) {
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
}

const DEFAULT_QUALITY_GATE = Object.freeze({
  fail: Object.freeze({
    min_coverage: 0.06,
    min_blur_factor: 0.2,
    min_exposure_factor: 0.2,
    min_quality_factor: 0.25,
  }),
  degraded: Object.freeze({
    min_blur_factor: 0.45,
    min_exposure_factor: 0.45,
    min_wb_factor: 0.65,
    min_quality_factor: 0.55,
  }),
});

function normalizeQualityGateConfig(overrides) {
  const obj = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : null;
  const failRaw = obj && obj.fail && typeof obj.fail === 'object' && !Array.isArray(obj.fail) ? obj.fail : null;
  const degradedRaw =
    obj && obj.degraded && typeof obj.degraded === 'object' && !Array.isArray(obj.degraded) ? obj.degraded : null;

  const fail = {
    min_coverage: clamp01(
      clamp(
        Number(failRaw && failRaw.min_coverage != null ? failRaw.min_coverage : DEFAULT_QUALITY_GATE.fail.min_coverage),
        0,
        1,
      ),
    ),
    min_blur_factor: clamp01(
      clamp(
        Number(
          failRaw && failRaw.min_blur_factor != null
            ? failRaw.min_blur_factor
            : DEFAULT_QUALITY_GATE.fail.min_blur_factor,
        ),
        0,
        1,
      ),
    ),
    min_exposure_factor: clamp01(
      clamp(
        Number(
          failRaw && failRaw.min_exposure_factor != null
            ? failRaw.min_exposure_factor
            : DEFAULT_QUALITY_GATE.fail.min_exposure_factor,
        ),
        0,
        1,
      ),
    ),
    min_quality_factor: clamp01(
      clamp(
        Number(
          failRaw && failRaw.min_quality_factor != null
            ? failRaw.min_quality_factor
            : DEFAULT_QUALITY_GATE.fail.min_quality_factor,
        ),
        0,
        1,
      ),
    ),
  };

  const degraded = {
    min_blur_factor: clamp01(
      clamp(
        Number(
          degradedRaw && degradedRaw.min_blur_factor != null
            ? degradedRaw.min_blur_factor
            : DEFAULT_QUALITY_GATE.degraded.min_blur_factor,
        ),
        0,
        1,
      ),
    ),
    min_exposure_factor: clamp01(
      clamp(
        Number(
          degradedRaw && degradedRaw.min_exposure_factor != null
            ? degradedRaw.min_exposure_factor
            : DEFAULT_QUALITY_GATE.degraded.min_exposure_factor,
        ),
        0,
        1,
      ),
    ),
    min_wb_factor: clamp01(
      clamp(
        Number(
          degradedRaw && degradedRaw.min_wb_factor != null
            ? degradedRaw.min_wb_factor
            : DEFAULT_QUALITY_GATE.degraded.min_wb_factor,
        ),
        0,
        1,
      ),
    ),
    min_quality_factor: clamp01(
      clamp(
        Number(
          degradedRaw && degradedRaw.min_quality_factor != null
            ? degradedRaw.min_quality_factor
            : DEFAULT_QUALITY_GATE.degraded.min_quality_factor,
        ),
        0,
        1,
      ),
    ),
  };

  return { fail, degraded };
}

function computeQualityMetrics({ rgb, width, height, skinMask, skinPixels, bbox, qualityGateConfig }) {
  const n = width * height;

  let sumY = 0;
  let sumY2 = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const off = i * 3;
    const r = rgb[off];
    const g = rgb[off + 1];
    const b = rgb[off + 2];
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    gray[i] = y;
    if (skinMask[i] !== 1) continue;
    sumY += y;
    sumY2 += y * y;
    sumR += r;
    sumG += g;
    sumB += b;
  }

  const meanY = skinPixels ? sumY / skinPixels : 0;
  const varY = skinPixels ? Math.max(0, sumY2 / skinPixels - meanY * meanY) : 0;
  const stdY = Math.sqrt(varY);

  const meanR = skinPixels ? sumR / skinPixels : 0;
  const meanG = skinPixels ? sumG / skinPixels : 0;
  const meanB = skinPixels ? sumB / skinPixels : 0;

  const rg = meanG > 0 ? meanR / meanG : 1;
  const bg = meanG > 0 ? meanB / meanG : 1;
  const wbCast = Math.max(Math.abs(rg - 1), Math.abs(bg - 1));

  // Blur proxy: Laplacian energy (mean abs laplacian) within skin bbox.
  let lapSum = 0;
  let lapN = 0;
  for (let y = bbox.y0 + 1; y < bbox.y1; y += 1) {
    for (let x = bbox.x0 + 1; x < bbox.x1; x += 1) {
      const idx = y * width + x;
      if (skinMask[idx] !== 1) continue;
      const c = gray[idx];
      const lap = -4 * c + gray[idx - 1] + gray[idx + 1] + gray[idx - width] + gray[idx + width];
      lapSum += Math.abs(lap);
      lapN += 1;
    }
  }
  const lapEnergy = lapN ? lapSum / lapN : 0;

  const coverage = skinPixels / n;

  const blurFactor = clamp01((lapEnergy - 6) / 18);
  const exposureFactor = clamp01(1 - Math.abs(meanY - 135) / 110);
  const wbFactor = clamp01(1 - wbCast / 0.45);
  const coverageFactor = clamp01((coverage - 0.06) / 0.18);

  const qualityFactor = clamp01(blurFactor * exposureFactor * wbFactor * coverageFactor);

  const reasons = [];
  if (coverage < 0.06) reasons.push('low_skin_coverage');
  if (blurFactor < 0.35) reasons.push('blur');
  if (exposureFactor < 0.4) reasons.push(meanY < 80 ? 'too_dark' : 'too_bright');
  if (wbFactor < 0.55) reasons.push('white_balance_unstable');

  const gate = normalizeQualityGateConfig(qualityGateConfig);
  const failGate = gate.fail;
  const degradedGate = gate.degraded;

  // Keep FAIL reserved for hard failure conditions (coverage / blur / exposure).
  // Composite quality_factor is still used for DEGRADED, but not for FAIL to
  // avoid over-failing clear photos with warm/cool cast.
  let grade = 'pass';
  if (
    coverage < failGate.min_coverage ||
    blurFactor < failGate.min_blur_factor ||
    exposureFactor < failGate.min_exposure_factor
  ) {
    grade = 'fail';
  } else if (
    blurFactor < degradedGate.min_blur_factor ||
    exposureFactor < degradedGate.min_exposure_factor ||
    wbFactor < degradedGate.min_wb_factor ||
    qualityFactor < degradedGate.min_quality_factor
  ) {
    grade = 'degraded';
  }

  return {
    grade,
    quality_factor: round3(qualityFactor),
    reasons,
    metrics: {
      skin_coverage: round3(coverage),
      mean_luma: round3(meanY),
      luma_std: round3(stdY),
      laplacian_energy: round3(lapEnergy),
      white_balance_cast: round3(wbCast),
      blur_factor: round3(blurFactor),
      exposure_factor: round3(exposureFactor),
      wb_factor: round3(wbFactor),
      coverage_factor: round3(coverageFactor),
    },
  };
}

function computeLabStats({ rgb, width, height, skinMask, regionBoxes }) {
  const n = width * height;

  const global = { L: [], a: [], b: [] };

  for (let i = 0; i < n; i += 1) {
    if (skinMask[i] !== 1) continue;
    const off = i * 3;
    const lab = rgbToLabFast(rgb[off], rgb[off + 1], rgb[off + 2]);

    // sample limit: keep arrays reasonably sized
    if (global.L.length < 24000 || (i % 3 === 0 && global.L.length < 42000)) {
      global.L.push(lab.L);
      global.a.push(lab.a);
      global.b.push(lab.b);
    }
  }

  function summarize(arr) {
    const out = { mean: null, p10: null, p50: null, p90: null, std: null };
    if (!arr.length) return out;
    const sorted = arr.slice().sort((a, b) => a - b);
    const sum = arr.reduce((acc, v) => acc + v, 0);
    const mean = sum / arr.length;
    const sum2 = arr.reduce((acc, v) => acc + (v - mean) ** 2, 0);
    const std = Math.sqrt(sum2 / arr.length);
    out.mean = mean;
    out.p10 = percentile(sorted, 0.1);
    out.p50 = median(sorted);
    out.p90 = percentile(sorted, 0.9);
    out.std = std;
    return out;
  }

  const globalSummary = { L: summarize(global.L), a: summarize(global.a), b: summarize(global.b) };

  return {
    global: globalSummary,
    regions: {},
  };
}

function computeSpecularFraction({ rgb, width, height, skinMask, box }) {
  let n = 0;
  let spec = 0;
  for (let y = box.y0; y <= box.y1; y += 1) {
    for (let x = box.x0; x <= box.x1; x += 1) {
      const idx = y * width + x;
      if (skinMask[idx] !== 1) continue;
      const off = idx * 3;
      const r = rgb[off];
      const g = rgb[off + 1];
      const b = rgb[off + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 0 ? (max - min) / max : 0; // 0..1
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      n += 1;
      if (luma > 215 && sat < 0.12) spec += 1;
    }
  }
  return n ? spec / n : 0;
}

function connectedComponentsCount(binary, width, height, box, { minArea = 2, maxArea = 400 } = {}) {
  const n = width * height;
  const labels = new Int32Array(n);
  let nextId = 0;
  const stack = new Int32Array(n);
  let count = 0;

  function idxInside(i) {
    const x = i % width;
    const y = Math.floor(i / width);
    return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  }

  for (let y = box.y0; y <= box.y1; y += 1) {
    for (let x = box.x0; x <= box.x1; x += 1) {
      const start = y * width + x;
      if (binary[start] !== 1) continue;
      if (labels[start] !== 0) continue;
      nextId += 1;
      const id = nextId;
      let top = 0;
      stack[top++] = start;
      labels[start] = id;
      let size = 0;

      while (top > 0) {
        const idx = stack[--top];
        size += 1;
        const xx = idx % width;
        const yy = Math.floor(idx / width);
        const up = yy > box.y0 ? idx - width : -1;
        const down = yy < box.y1 ? idx + width : -1;
        const left = xx > box.x0 ? idx - 1 : -1;
        const right = xx < box.x1 ? idx + 1 : -1;

        for (const nb of [up, down, left, right]) {
          if (nb < 0) continue;
          if (!idxInside(nb)) continue;
          if (binary[nb] !== 1) continue;
          if (labels[nb] !== 0) continue;
          labels[nb] = id;
          stack[top++] = nb;
        }
      }

      if (size >= minArea && size <= maxArea) count += 1;
    }
  }

  return count;
}

const SEVERITY_THRESHOLDS = Object.freeze({
  acne: {
    all: [0.12, 0.3, 0.52],
  },
  redness: {
    all: [0.18, 0.38, 0.6],
  },
  pores: {
    nose: [0.35, 0.6, 0.82],
    cheeks: [0.3, 0.55, 0.78],
    forehead: [0.28, 0.5, 0.72],
    all: [0.3, 0.55, 0.78],
  },
  dark_spots: {
    all: [0.22, 0.42, 0.65],
  },
});

function normalizeThresholdTriplet(raw, fallback) {
  const base = Array.isArray(fallback) && fallback.length >= 3 ? fallback : [0.25, 0.5, 0.75];
  if (!Array.isArray(raw) || raw.length < 3) return base.slice(0, 3);
  let t1 = clamp01(Number(raw[0]));
  let t2 = clamp01(Number(raw[1]));
  let t3 = clamp01(Number(raw[2]));
  if (!Number.isFinite(t1)) t1 = clamp01(Number(base[0]));
  if (!Number.isFinite(t2)) t2 = clamp01(Number(base[1]));
  if (!Number.isFinite(t3)) t3 = clamp01(Number(base[2]));
  t2 = clamp(t2, t1, 1);
  t3 = clamp(t3, t2, 1);
  return [t1, t2, t3];
}

function mergeSeverityThresholds(overrides) {
  const base = SEVERITY_THRESHOLDS;
  const out = {};
  for (const [issueType, regions] of Object.entries(base)) {
    const regionMap = regions && typeof regions === 'object' ? regions : {};
    const copy = {};
    for (const [regionKey, triplet] of Object.entries(regionMap)) {
      copy[regionKey] = Array.isArray(triplet) ? triplet.slice(0, 3) : triplet;
    }
    out[issueType] = copy;
  }

  const obj = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : null;
  if (!obj) return out;

  for (const [issueTypeRaw, regionOverridesRaw] of Object.entries(obj)) {
    const issueType = typeof issueTypeRaw === 'string' ? issueTypeRaw : '';
    if (!issueType || !out[issueType]) continue;
    const regionOverrides =
      regionOverridesRaw && typeof regionOverridesRaw === 'object' && !Array.isArray(regionOverridesRaw)
        ? regionOverridesRaw
        : null;
    if (!regionOverrides) continue;

    const current = out[issueType];
    const fallbackAll = current.all || [0.25, 0.5, 0.75];
    for (const [regionRaw, tripletRaw] of Object.entries(regionOverrides)) {
      const region = typeof regionRaw === 'string' && regionRaw.trim() ? regionRaw.trim() : null;
      if (!region) continue;
      const fallback = current[region] || fallbackAll;
      current[region] = normalizeThresholdTriplet(tripletRaw, fallback);
    }
  }

  return out;
}

function scoreToSeverity({ issueType, region = 'all', score, thresholds } = {}) {
  const s = clamp01(score);
  const thMap = thresholds && typeof thresholds === 'object' && !Array.isArray(thresholds) ? thresholds : null;
  const map = (thMap && thMap[issueType]) || SEVERITY_THRESHOLDS[issueType] || SEVERITY_THRESHOLDS.redness;
  const th = map[region] || map.all || [0.25, 0.5, 0.75];
  const [t1, t2, t3] = th;
  if (s < t1) return { level: 0, severity: 'none' };
  if (s < t2) return { level: 1, severity: 'mild' };
  if (s < t3) return { level: 2, severity: 'moderate' };
  return { level: 3, severity: 'severe' };
}

function confidenceToLabel(conf) {
  const c = clamp01(conf);
  if (c >= 0.78) return 'pretty_sure';
  if (c >= 0.52) return 'somewhat_sure';
  return 'not_sure';
}

function agreementFactor({ issueType, detectorSeverityLevel, profileSummary, recentLogsSummary }) {
  let factor = 1;
  const latest = Array.isArray(recentLogsSummary) && recentLogsSummary[0] ? recentLogsSummary[0] : null;
  const p = profileSummary && typeof profileSummary === 'object' ? profileSummary : {};
  const goals = Array.isArray(p.goals) ? p.goals.map((g) => String(g || '').toLowerCase()) : [];

  const sev = typeof detectorSeverityLevel === 'number' ? detectorSeverityLevel : 0;
  if (issueType === 'acne' && latest && typeof latest.acne === 'number') {
    const log = clamp(latest.acne, 0, 5);
    const logSev = log <= 1 ? 0 : log <= 2 ? 1 : log <= 3 ? 2 : 3;
    const diff = Math.abs(sev - logSev);
    factor = diff === 0 ? 1.15 : diff === 1 ? 1.05 : 0.78;
  } else if (issueType === 'redness' && latest && typeof latest.redness === 'number') {
    const log = clamp(latest.redness, 0, 5);
    const logSev = log <= 1 ? 0 : log <= 2 ? 1 : log <= 3 ? 2 : 3;
    const diff = Math.abs(sev - logSev);
    factor = diff === 0 ? 1.12 : diff === 1 ? 1.03 : 0.8;
  } else if (issueType === 'pores' && goals.some((g) => g.includes('pores'))) {
    factor = sev > 0 ? 1.05 : 1.0;
  } else if (issueType === 'dark_spots' && goals.some((g) => g.includes('dark') || g.includes('spot') || g.includes('pigment'))) {
    factor = sev > 0 ? 1.03 : 1.0;
  }
  return round3(clamp(factor, 0.55, 1.25));
}

function logit(p) {
  const v = clamp01(p);
  const eps = 1e-6;
  const pp = Math.min(1 - eps, Math.max(eps, v));
  return Math.log(pp / (1 - pp));
}

function sigmoid(x) {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

function applyTemperatureScaling(p, temperature) {
  const t = Number.isFinite(temperature) && temperature > 0 ? temperature : 1;
  return sigmoid(logit(p) / t);
}

function applyIsotonicPoints(p, points) {
  const x = clamp01(p);
  const pts = Array.isArray(points) ? points.filter((pt) => Array.isArray(pt) && pt.length >= 2) : [];
  if (!pts.length) return x;
  const sorted = pts
    .map((pt) => [clamp01(Number(pt[0])), clamp01(Number(pt[1]))])
    .sort((a, b) => a[0] - b[0]);

  if (x <= sorted[0][0]) return sorted[0][1];
  if (x >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 1; i < sorted.length; i += 1) {
    const [x0, y0] = sorted[i - 1];
    const [x1, y1] = sorted[i];
    if (x >= x0 && x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return x;
}

const CALIBRATION_CACHE = { loaded: false, config: null };

function getCalibrationConfig() {
  if (CALIBRATION_CACHE.loaded) return CALIBRATION_CACHE.config;
  CALIBRATION_CACHE.loaded = true;
  const envPath = String(process.env.AURORA_SKIN_CALIBRATION_PATH || '').trim();
  const filePath = envPath || path.join(__dirname, '..', '..', 'data', 'skin_calibration_v1.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    CALIBRATION_CACHE.config = obj && typeof obj === 'object' ? obj : null;
  } catch {
    CALIBRATION_CACHE.config = null;
  }
  return CALIBRATION_CACHE.config;
}

function calibrateModelConfidence(modelConf, { issueType } = {}) {
  const p = clamp01(modelConf);
  const cfg = getCalibrationConfig();
  const issues = cfg && cfg.issues && typeof cfg.issues === 'object' ? cfg.issues : null;
  const entry = issues && issueType && issues[issueType] ? issues[issueType] : null;
  if (!entry || typeof entry !== 'object') return p;
  const method = typeof entry.method === 'string' ? entry.method : null;
  if (method === 'temperature') return applyTemperatureScaling(p, Number(entry.temperature));
  if (method === 'isotonic') return applyIsotonicPoints(p, entry.points);
  return p;
}

function buildEvidenceShort({ issueType, severity, confidence, metrics, language, qualityGrade, wbUnstable }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const confLabel = confidenceToLabel(confidence);
  const confidentText = confLabel === 'pretty_sure' ? (lang === 'CN' ? '较确定' : 'fairly confident') : confLabel === 'somewhat_sure' ? (lang === 'CN' ? '中等把握' : 'somewhat confident') : (lang === 'CN' ? '把握不高' : 'low confidence');

  if (issueType === 'dark_spots' && (qualityGrade !== 'pass' || wbUnstable)) {
    return lang === 'CN'
      ? ['光照/白平衡不够稳定，本次不可靠判断色沉/暗沉。', '建议自然光、无滤镜重拍后再评估。']
      : ['Lighting/white balance is unstable; I cannot reliably assess dark spots today.', 'Retake in daylight with no filters to reassess.'];
  }

  const sevText =
    severity === 'none'
      ? lang === 'CN'
        ? '未见明显'
        : 'no strong signal'
      : severity === 'mild'
        ? lang === 'CN'
          ? '轻度'
          : 'mild'
        : severity === 'moderate'
          ? lang === 'CN'
            ? '中度'
            : 'moderate'
          : lang === 'CN'
            ? '偏重'
            : 'high';

  if (issueType === 'acne') {
    const c = metrics && typeof metrics.acne_count === 'number' ? metrics.acne_count : null;
    const d = metrics && typeof metrics.acne_density === 'number' ? metrics.acne_density : null;
    return lang === 'CN'
      ? [`疑似炎性小红点：${c != null ? c : '—'} 个（密度 ${d != null ? round3(d) : '—'}）。`, `结论为${sevText}，${confidentText}。`]
      : [`Possible inflamed red spots: ${c != null ? c : '—'} (density ${d != null ? round3(d) : '—'}).`, `Overall: ${sevText}, ${confidentText}.`];
  }
  if (issueType === 'redness') {
    const aShift = metrics && typeof metrics.a_shift === 'number' ? metrics.a_shift : null;
    const frac = metrics && typeof metrics.red_fraction === 'number' ? metrics.red_fraction : null;
    return lang === 'CN'
      ? [`泛红信号：a* 偏移 ${aShift != null ? round3(aShift) : '—'}，红区占比 ${frac != null ? round3(frac) : '—'}。`, `结论为${sevText}，${confidentText}。`]
      : [`Redness signals: a* shift ${aShift != null ? round3(aShift) : '—'}, red fraction ${frac != null ? round3(frac) : '—'}.`, `Overall: ${sevText}, ${confidentText}.`];
  }
  if (issueType === 'pores') {
    const idx = metrics && typeof metrics.pore_index === 'number' ? metrics.pore_index : null;
    const spec = metrics && typeof metrics.specular_fraction === 'number' ? metrics.specular_fraction : null;
    return lang === 'CN'
      ? [`纹理/毛孔指数：${idx != null ? round3(idx) : '—'}（油光校正系数已应用）。`, `结论为${sevText}，${confidentText}${spec != null && spec > 0.15 ? '（鼻部油光较强 → 更保守）' : ''}。`]
      : [`Texture/pore index: ${idx != null ? round3(idx) : '—'} (with specular correction).`, `Overall: ${sevText}, ${confidentText}${spec != null && spec > 0.15 ? ' (strong shine → more conservative)' : ''}.`];
  }
  if (issueType === 'dark_spots') {
    const drop = metrics && typeof metrics.luma_drop === 'number' ? metrics.luma_drop : null;
    const hue = metrics && typeof metrics.hue_shift === 'number' ? metrics.hue_shift : null;
    return lang === 'CN'
      ? [`暗沉/色沉信号：luma_drop ${drop != null ? round3(drop) : '—'}，色相偏移 ${hue != null ? round3(hue) : '—'}。`, `结论为${sevText}，${confidentText}。`]
      : [`Dark spot signals: luma_drop ${drop != null ? round3(drop) : '—'}, hue shift ${hue != null ? round3(hue) : '—'}.`, `Overall: ${sevText}, ${confidentText}.`];
  }
  return lang === 'CN' ? ['已生成诊断结论。', `把握度：${confidentText}。`] : ['Diagnosis computed.', `Confidence: ${confidentText}.`];
}

function runIssueScoring({
  issueType,
  rawScore,
  modelConf,
  region,
  quality,
  profileSummary,
  recentLogsSummary,
  metrics,
  wbUnstable,
  language,
  severityThresholds,
}) {
  const sev = scoreToSeverity({ issueType, region, score: rawScore, thresholds: severityThresholds });
  const qualityFactor = quality && typeof quality.quality_factor === 'number' ? quality.quality_factor : 1;
  const agree = agreementFactor({ issueType, detectorSeverityLevel: sev.level, profileSummary, recentLogsSummary });
  const calibratedModel = calibrateModelConfidence(modelConf, { issueType });
  const finalConf = clamp01(calibratedModel * qualityFactor * agree);
  const evidenceShort = buildEvidenceShort({
    issueType,
    severity: sev.severity,
    confidence: finalConf,
    metrics,
    language,
    qualityGrade: quality && quality.grade ? quality.grade : 'pass',
    wbUnstable,
  });

  return {
    issue_type: issueType,
    region: region || 'all',
    severity: sev.severity,
    severity_level: sev.level,
    severity_score: round3(clamp01(rawScore)),
    confidence: round3(finalConf),
    confidence_label: confidenceToLabel(finalConf),
    calibration: {
      model_conf: round3(clamp01(modelConf)),
      model_conf_calibrated: round3(clamp01(calibratedModel)),
      quality_factor: round3(clamp01(qualityFactor)),
      agreement_factor: agree,
    },
    evidence: {
      evidence_short: evidenceShort,
      metrics: metrics || {},
      quality_notes:
        quality && Array.isArray(quality.reasons) && quality.reasons.length
          ? quality.reasons.slice(0, 6)
          : [],
    },
  };
}

function scoreToSeverityLevel0to4(score) {
  const s = clamp01(score);
  if (s < 0.15) return 0;
  if (s < 0.35) return 1;
  if (s < 0.55) return 2;
  if (s < 0.75) return 3;
  return 4;
}

function normalizeBoxToUnit(box, width, height) {
  if (!box || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const x0 = clamp01(Number(box.x0) / width);
  const y0 = clamp01(Number(box.y0) / height);
  const x1 = clamp01(Number(box.x1) / width);
  const y1 = clamp01(Number(box.y1) / height);
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

function buildGridHeatmapForBox(boxNorm, score, { rows = 6, cols = 6 } = {}) {
  const values = new Array(rows * cols).fill(0);
  const s = clamp01(score);
  if (!boxNorm) return values;
  for (let r = 0; r < rows; r += 1) {
    const y = (r + 0.5) / rows;
    for (let c = 0; c < cols; c += 1) {
      const x = (c + 0.5) / cols;
      const idx = r * cols + c;
      const inside = x >= boxNorm.x0 && x <= boxNorm.x1 && y >= boxNorm.y0 && y <= boxNorm.y1;
      if (inside) {
        values[idx] = round3(s);
        continue;
      }
      const dx = Math.max(0, Math.max(boxNorm.x0 - x, x - boxNorm.x1));
      const dy = Math.max(0, Math.max(boxNorm.y0 - y, y - boxNorm.y1));
      const d = Math.sqrt(dx * dx + dy * dy);
      values[idx] = round3(s * Math.max(0, 1 - d * 4.5) * 0.45);
    }
  }
  return values;
}

function qualityHasReason(quality, reason) {
  if (!quality || !Array.isArray(quality.reasons) || !reason) return false;
  return quality.reasons.some((item) => String(item || '').trim() === String(reason));
}

function buildPhotoTakeaways({ findings, language }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const out = [];
  const push = (value) => {
    if (!value || typeof value !== 'object') return;
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    if (!text) return;
    const linkedFindingIds = Array.isArray(value.linked_finding_ids)
      ? value.linked_finding_ids.filter((item) => typeof item === 'string' && item.trim()).slice(0, 6)
      : [];
    const linkedIssueTypes = Array.isArray(value.linked_issue_types)
      ? value.linked_issue_types.filter((item) => typeof item === 'string' && item.trim()).slice(0, 6)
      : [];
    out.push({
      takeaway_id: typeof value.takeaway_id === 'string' && value.takeaway_id.trim() ? value.takeaway_id.trim() : null,
      source: 'photo',
      issue_type: value.issue_type || null,
      text,
      confidence: round3(clamp01(Number(value.confidence))),
      linked_finding_ids: linkedFindingIds,
      linked_issue_types: linkedIssueTypes,
    });
  };

  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const issueType = String(finding.issue_type || '');
    const severity = Number.isFinite(finding.severity) ? finding.severity : 0;
    const confidence = Number.isFinite(finding.confidence) ? finding.confidence : 0.35;
    const uncertain = Boolean(finding.uncertain);
    if (uncertain) {
      push({
        takeaway_id: `tw_photo_${issueType || 'tone'}_uncertain`,
        issue_type: issueType,
        confidence,
        linked_finding_ids: typeof finding.finding_id === 'string' ? [finding.finding_id] : [],
        linked_issue_types: issueType ? [issueType] : [],
        text:
          lang === 'CN'
            ? 'From photo: 光照或白平衡不稳定，暗沉/肤色不均暂不下结论，建议自然光重拍后再评估。'
            : 'From photo: lighting/white balance is unstable, so uneven-tone assessment is uncertain; retake in daylight.',
      });
      continue;
    }
    if (severity <= 0) continue;
    if (issueType === 'redness') {
      push({
        takeaway_id: 'tw_photo_redness',
        issue_type: issueType,
        confidence,
        linked_finding_ids: typeof finding.finding_id === 'string' ? [finding.finding_id] : [],
        linked_issue_types: issueType ? [issueType] : [],
        text:
          lang === 'CN'
            ? 'From photo: 泛红信号偏高，先用温和清洁+修护保湿，并降低强活性叠加频率。'
            : 'From photo: redness signals are elevated, so prioritize gentle cleansing, barrier repair, and lower active stacking.',
      });
      continue;
    }
    if (issueType === 'shine') {
      push({
        takeaway_id: 'tw_photo_shine',
        issue_type: issueType,
        confidence,
        linked_finding_ids: typeof finding.finding_id === 'string' ? [finding.finding_id] : [],
        linked_issue_types: issueType ? [issueType] : [],
        text:
          lang === 'CN'
            ? 'From photo: T 区油光/镜面反射偏高，白天重视防晒并避免厚重封闭型叠加。'
            : 'From photo: T-zone shine/specular highlights are elevated, so keep SPF consistent and avoid heavy occlusive layering.',
      });
      continue;
    }
    if (issueType === 'texture') {
      push({
        takeaway_id: 'tw_photo_texture',
        issue_type: issueType,
        confidence,
        linked_finding_ids: typeof finding.finding_id === 'string' ? [finding.finding_id] : [],
        linked_issue_types: issueType ? [issueType] : [],
        text:
          lang === 'CN'
            ? 'From photo: 纹理/毛孔信号偏高，建议从低频温和焕肤开始，并观察 72 小时反应。'
            : 'From photo: texture/pore signals are elevated; start with low-frequency gentle exfoliation and watch the 72-hour response.',
      });
      continue;
    }
    if (issueType === 'tone') {
      push({
        takeaway_id: 'tw_photo_tone',
        issue_type: issueType,
        confidence,
        linked_finding_ids: typeof finding.finding_id === 'string' ? [finding.finding_id] : [],
        linked_issue_types: issueType ? [issueType] : [],
        text:
          lang === 'CN'
            ? 'From photo: 肤色不均信号存在，建议优先稳定防晒，再逐步加入温和提亮。'
            : 'From photo: uneven-tone signals are present; lock in daily SPF first, then add gentle brightening.',
      });
    }
  }
  return out.slice(0, 8);
}

function buildPhotoFindings({
  issues,
  raw,
  quality,
  regionBoxes,
  width,
  height,
  language,
} = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const safeIssues = Array.isArray(issues) ? issues : [];
  const safeQuality = quality && typeof quality === 'object' ? quality : { grade: 'unknown', reasons: [] };
  const issueMap = {};
  for (const issue of safeIssues) {
    if (!issue || typeof issue !== 'object') continue;
    const key = typeof issue.issue_type === 'string' ? issue.issue_type : '';
    if (!key) continue;
    issueMap[key] = issue;
  }

  if (safeQuality.grade === 'fail') {
    const takeaways = [
      {
        takeaway_id: 'tw_photo_quality_retake',
        source: 'photo',
        issue_type: 'quality',
        text:
          lang === 'CN'
            ? 'From photo: 本次图像质量未通过（模糊/曝光/白平衡/覆盖），建议按提示重拍后再继续分析。'
            : 'From photo: image quality failed (blur/exposure/WB/coverage), so please retake before analysis.',
        confidence: 1,
        linked_finding_ids: [],
        linked_issue_types: ['quality'],
      },
    ];
    return { photo_findings: [], takeaways };
  }

  const glareRisk = qualityHasReason(safeQuality, 'too_bright') || qualityHasReason(safeQuality, 'white_balance_unstable');
  const blurRisk = qualityHasReason(safeQuality, 'blur');
  const degraded = safeQuality.grade === 'degraded';
  const qualityFactor = Number.isFinite(safeQuality.quality_factor) ? clamp01(safeQuality.quality_factor) : 0.6;
  const confidencePenalty = (degraded ? 0.82 : 1) * (glareRisk ? 0.86 : 1) * (blurRisk ? 0.88 : 1);

  const rednessIssue = issueMap.redness || {};
  const rednessMetrics = rednessIssue.evidence && rednessIssue.evidence.metrics ? rednessIssue.evidence.metrics : {};
  const rednessScore = Number.isFinite(rednessIssue.severity_score) ? clamp01(rednessIssue.severity_score) : clamp01(raw?.redness?.score);
  const rednessConfBase = Number.isFinite(rednessIssue.confidence) ? clamp01(rednessIssue.confidence) : clamp01(0.45 + rednessScore * 0.4);
  const rednessConfidence = round3(clamp01(rednessConfBase * confidencePenalty));
  const rednessBox = normalizeBoxToUnit(regionBoxes && regionBoxes.cheeks, width, height);

  const poresIssue = issueMap.pores || {};
  const poresMetrics = poresIssue.evidence && poresIssue.evidence.metrics ? poresIssue.evidence.metrics : {};
  const poreIndex = Number.isFinite(poresMetrics.pore_index) ? clamp01(poresMetrics.pore_index) : clamp01(raw?.pores?.score);
  const textureConfidence = round3(
    clamp01((Number.isFinite(poresIssue.confidence) ? poresIssue.confidence : 0.4 + poreIndex * 0.4) * confidencePenalty * (blurRisk ? 0.8 : 1)),
  );
  const textureBox = normalizeBoxToUnit(regionBoxes && regionBoxes.cheeks, width, height);
  const specularFraction = Number.isFinite(poresMetrics.specular_fraction)
    ? clamp01(poresMetrics.specular_fraction)
    : clamp01(raw?.pores?.metrics?.specular_fraction);
  const shineScore = clamp01((specularFraction - 0.04) / 0.28);
  const shineConfidence = round3(clamp01((0.48 + shineScore * 0.45) * qualityFactor * (glareRisk ? 0.8 : 1)));
  const shineBox = normalizeBoxToUnit(regionBoxes && regionBoxes.nose, width, height);

  const darkIssue = issueMap.dark_spots || {};
  const darkMetrics = darkIssue.evidence && darkIssue.evidence.metrics ? darkIssue.evidence.metrics : {};
  const toneBox = normalizeBoxToUnit(regionBoxes && regionBoxes.full, width, height);
  const wbUnstable = qualityHasReason(safeQuality, 'white_balance_unstable');
  const toneStable = safeQuality.grade === 'pass' && !wbUnstable && !qualityHasReason(safeQuality, 'too_bright') && !qualityHasReason(safeQuality, 'too_dark');
  const toneScore = Number.isFinite(darkIssue.severity_score) ? clamp01(darkIssue.severity_score) : clamp01(raw?.dark_spots?.score);
  const toneConfidenceBase = Number.isFinite(darkIssue.confidence) ? clamp01(darkIssue.confidence) : clamp01(0.28 + toneScore * 0.42);
  const toneConfidence = round3(clamp01((toneStable ? toneConfidenceBase : 0.24) * confidencePenalty));

  const photoFindings = [
    {
      finding_id: 'pf_redness',
      issue_type: 'redness',
      subtype: 'diffuse_redness_proxy',
      severity: scoreToSeverityLevel0to4(rednessScore),
      confidence: rednessConfidence,
      evidence:
        lang === 'CN'
          ? `From photo: a* 偏移=${round3(rednessMetrics.a_shift)}，红区占比=${round3(rednessMetrics.red_fraction)}。${glareRisk ? '光照/反光可能影响判断。' : ''}`
          : `From photo: a* shift=${round3(rednessMetrics.a_shift)}, red-area ratio=${round3(rednessMetrics.red_fraction)}.${glareRisk ? ' lighting/glare may affect this.' : ''}`,
      computed_features: {
        a_shift: round3(rednessMetrics.a_shift),
        red_fraction: round3(rednessMetrics.red_fraction),
        quality_factor: round3(qualityFactor),
      },
      geometry: {
        type: 'grid',
        rows: 6,
        cols: 6,
        values: buildGridHeatmapForBox(rednessBox, rednessScore, { rows: 6, cols: 6 }),
        bbox_norm: rednessBox,
      },
    },
    {
      finding_id: 'pf_shine',
      issue_type: 'shine',
      subtype: 'specular_highlight_proxy',
      severity: scoreToSeverityLevel0to4(shineScore),
      confidence: shineConfidence,
      evidence:
        lang === 'CN'
          ? `From photo: 鼻部镜面反光比例=${round3(specularFraction)}。${glareRisk ? '光照/反光可能抬高该值。' : ''}`
          : `From photo: nose specular-highlight ratio=${round3(specularFraction)}.${glareRisk ? ' lighting/glare may inflate this.' : ''}`,
      computed_features: {
        specular_fraction: round3(specularFraction),
        shine_score: round3(shineScore),
        quality_factor: round3(qualityFactor),
      },
      geometry: {
        type: 'grid',
        rows: 6,
        cols: 6,
        values: buildGridHeatmapForBox(shineBox, shineScore, { rows: 6, cols: 6 }),
        bbox_norm: shineBox,
      },
    },
    {
      finding_id: 'pf_texture',
      issue_type: 'texture',
      subtype: 'pores_proxy',
      severity: scoreToSeverityLevel0to4(poreIndex),
      confidence: textureConfidence,
      evidence:
        lang === 'CN'
          ? `From photo: 纹理能量=${round3(poresMetrics.texture_energy)}，毛孔代理指数=${round3(poreIndex)}。${blurRisk || glareRisk ? 'lighting/glare may affect this.' : ''}`
          : `From photo: texture energy=${round3(poresMetrics.texture_energy)}, pore proxy=${round3(poreIndex)}.${blurRisk || glareRisk ? ' lighting/glare may affect this.' : ''}`,
      computed_features: {
        texture_energy: round3(poresMetrics.texture_energy),
        pore_index: round3(poreIndex),
        specular_fraction: round3(specularFraction),
        quality_factor: round3(qualityFactor),
      },
      geometry: {
        type: 'grid',
        rows: 6,
        cols: 6,
        values: buildGridHeatmapForBox(textureBox, poreIndex, { rows: 6, cols: 6 }),
        bbox_norm: textureBox,
      },
    },
    {
      finding_id: 'pf_tone',
      issue_type: 'tone',
      subtype: 'uneven_tone_proxy',
      severity: toneStable ? scoreToSeverityLevel0to4(toneScore) : 0,
      confidence: toneConfidence,
      uncertain: !toneStable,
      evidence: toneStable
        ? lang === 'CN'
          ? `From photo: 亮度落差=${round3(darkMetrics.luma_drop)}，色偏=${round3(darkMetrics.hue_shift)}。`
          : `From photo: luma-drop=${round3(darkMetrics.luma_drop)}, hue shift=${round3(darkMetrics.hue_shift)}.`
        : lang === 'CN'
          ? 'From photo: 光照/白平衡不稳定，暗沉/肤色不均结果不确定，建议重拍。'
          : 'From photo: uneven-tone signal is uncertain, retake recommended (lighting/WB instability).',
      computed_features: {
        luma_drop: round3(darkMetrics.luma_drop),
        hue_shift: round3(darkMetrics.hue_shift),
        white_balance_unstable: wbUnstable,
        quality_factor: round3(qualityFactor),
      },
      geometry: {
        type: 'grid',
        rows: 6,
        cols: 6,
        values: buildGridHeatmapForBox(toneBox, toneStable ? toneScore : 0.2, { rows: 6, cols: 6 }),
        bbox_norm: toneBox,
      },
    },
  ];

  const takeaways = buildPhotoTakeaways({ findings: photoFindings, language: lang });
  return { photo_findings: photoFindings, takeaways };
}

function computeIssueRawScores({ labStats, rgb, width, height, skinMask, skinPixels, regionBoxes, quality }) {
  const globalA = labStats.global.a;
  const globalL = labStats.global.L;
  const globalB = labStats.global.b;
  const wbUnstable = Boolean(quality && Array.isArray(quality.reasons) && quality.reasons.includes('white_balance_unstable'));

  const medianA = globalA && typeof globalA.p50 === 'number' ? globalA.p50 : 0;
  const meanA = globalA && typeof globalA.mean === 'number' ? globalA.mean : 0;
  const stdA = globalA && typeof globalA.std === 'number' ? globalA.std : 0;

  const medianL = globalL && typeof globalL.p50 === 'number' ? globalL.p50 : 0;
  const p10L = globalL && typeof globalL.p10 === 'number' ? globalL.p10 : 0;

  const meanB = globalB && typeof globalB.mean === 'number' ? globalB.mean : 0;

  // ---- Acne (localized red + edges) ----
  const n = width * height;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const off = i * 3;
    const r = rgb[off];
    const g = rgb[off + 1];
    const b = rgb[off + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  const grad = new Uint8Array(n);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx = Math.abs(gray[idx + 1] - gray[idx - 1]);
      const gy = Math.abs(gray[idx + width] - gray[idx - width]);
      grad[idx] = Math.min(255, gx + gy);
    }
  }

  const acneCandidates = new Uint8Array(n);
  const acneBox = regionBoxes.cheeks;
  const eyeEx = regionBoxes.exclude_eyes;
  const mouthEx = regionBoxes.exclude_mouth;
  const aThresh = medianA + 10;
  for (let y = acneBox.y0; y <= acneBox.y1; y += 1) {
    for (let x = acneBox.x0; x <= acneBox.x1; x += 1) {
      if (isInside(x, y, eyeEx) || isInside(x, y, mouthEx)) continue;
      const idx = y * width + x;
      if (skinMask[idx] !== 1) continue;
      const off = idx * 3;
      const lab = rgbToLabFast(rgb[off], rgb[off + 1], rgb[off + 2]);
      if (lab.a <= aThresh) continue;
      if (grad[idx] < 35) continue;
      acneCandidates[idx] = 1;
    }
  }
  const acneCount = connectedComponentsCount(acneCandidates, width, height, acneBox, { minArea: 2, maxArea: 110 });
  const acneDensity = acneCount / Math.max(1, Number.isFinite(skinPixels) ? skinPixels : 0);
  const acneScore = clamp01(acneDensity * 520);
  const acneModelConf = clamp01(0.18 + Math.min(1, acneCount / 18) * 0.65);

  // ---- Redness (diffuse + localized) ----
  const redFraction = clamp01((stdA > 0 ? stdA / 22 : 0) * 0.35 + clamp01((meanA - medianA) / 10) * 0.55);
  const rednessScore = clamp01(redFraction);
  const rednessModelConf = clamp01(0.22 + clamp01(stdA / 22) * 0.55);

  // ---- Pores (texture index in nose/cheeks with specular correction) ----
  const noseBox = regionBoxes.nose;
  const cheeksBox = regionBoxes.cheeks;
  let lapNose = 0;
  let lapCheeks = 0;
  let lapN = 0;
  let lapC = 0;
  for (let y = regionBoxes.full.y0 + 1; y < regionBoxes.full.y1; y += 1) {
    for (let x = regionBoxes.full.x0 + 1; x < regionBoxes.full.x1; x += 1) {
      const idx = y * width + x;
      if (skinMask[idx] !== 1) continue;
      const lap = Math.abs(-4 * gray[idx] + gray[idx - 1] + gray[idx + 1] + gray[idx - width] + gray[idx + width]);
      if (isInside(x, y, noseBox)) {
        lapNose += lap;
        lapN += 1;
      } else if (isInside(x, y, cheeksBox) && !isInside(x, y, noseBox)) {
        lapCheeks += lap;
        lapC += 1;
      }
    }
  }
  const noseTex = lapN ? lapNose / lapN : 0;
  const cheekTex = lapC ? lapCheeks / lapC : 0;
  const specFrac = computeSpecularFraction({ rgb, width, height, skinMask, box: noseBox });
  const shinePenalty = clamp01((specFrac - 0.06) / 0.22);
  const poreIndex = clamp01(((noseTex + cheekTex) / 2 - 6) / 18) * (1 - 0.65 * shinePenalty);
  const poresScore = poreIndex;
  const poresModelConf = clamp01(0.22 + poreIndex * 0.65) * (1 - 0.55 * shinePenalty);

  // ---- Dark spots (only when quality pass + WB stable) ----
  const globalLumaDrop = clamp01((medianL - p10L - 2) / 16);
  const hueShift = clamp01(Math.abs(meanB) / 35);
  const darkScoreRaw = clamp01(globalLumaDrop * 0.85 + hueShift * 0.15);
  const darkScore = quality && quality.grade === 'pass' && !wbUnstable ? darkScoreRaw : 0;
  const darkModelConf = quality && quality.grade === 'pass' && !wbUnstable ? clamp01(0.15 + darkScoreRaw * 0.55) : 0.1;

  return {
    wbUnstable,
    acne: { score: acneScore, model_conf: acneModelConf, metrics: { acne_count: acneCount, acne_density: acneDensity } },
    redness: {
      score: rednessScore,
      model_conf: rednessModelConf,
      metrics: { a_shift: meanA - medianA, red_fraction: redFraction },
    },
    pores: {
      score: poresScore,
      model_conf: poresModelConf,
      metrics: { texture_energy: (noseTex + cheekTex) / 2, pore_index: poreIndex, specular_fraction: specFrac },
    },
    dark_spots: {
      score: darkScore,
      model_conf: darkModelConf,
      metrics: { luma_drop: medianL - p10L, hue_shift: meanB },
    },
  };
}

function toDiagnosisCardPayload({ diagnosis, quality, language, photoFindings, takeaways }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const summaryNotes = [];
  if (quality && quality.grade !== 'pass') {
    summaryNotes.push(
      lang === 'CN'
        ? `照片质量=${quality.grade}（置信度会更保守；建议自然光重拍提升准确度）`
        : `photo_quality=${quality.grade} (more conservative; retake in daylight for accuracy)`,
    );
  }
  if (quality && Array.isArray(quality.reasons) && quality.reasons.includes('white_balance_unstable')) {
    summaryNotes.push(lang === 'CN' ? '白平衡不稳定：色沉/暗沉判断将更保守。' : 'White balance unstable: dark spot assessment is conservative.');
  }
  return {
    schema_version: 'aurora.skin_diagnosis.v1',
    quality,
    issues: diagnosis,
    photo_findings: Array.isArray(photoFindings) ? photoFindings.slice(0, 10) : [],
    takeaways: Array.isArray(takeaways) ? takeaways.slice(0, 10) : [],
    notes: summaryNotes.slice(0, 6),
  };
}

async function runSkinDiagnosisV1({
  imageBuffer,
  language,
  profileSummary,
  recentLogsSummary,
  profiler,
  qualityGateConfig,
  severityThresholdsOverrides,
} = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const prof = profiler && typeof profiler.start === 'function' ? profiler : null;
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 50) {
    return { ok: false, reason: 'no_image' };
  }

  const severityThresholds =
    severityThresholdsOverrides && typeof severityThresholdsOverrides === 'object' && !Array.isArray(severityThresholdsOverrides)
      ? mergeSeverityThresholds(severityThresholdsOverrides)
      : null;

  let decoded = null;
  try {
    if (prof) prof.start('decode', { kind: 'downscale_rgb', max_side: ANALYSIS_MAX_SIDE });
    decoded = await decodeToSmallRgb(imageBuffer, { maxSide: ANALYSIS_MAX_SIDE });
    if (prof) prof.end('decode', { kind: 'downscale_rgb', w: decoded.width, h: decoded.height });
  } catch {
    if (prof) prof.fail('decode', new Error('decode_failed'), { kind: 'downscale_rgb' });
    return { ok: false, reason: 'decode_failed' };
  }

  const { rgb, width, height } = decoded;
  let skin = null;
  try {
    if (prof) prof.start('skin_roi', { kind: 'ycrcb_connected_components' });
    skin = computeSkinMask(rgb, width, height);
    if (!skin.ok) throw new Error(String(skin.reason || 'skin_roi_failed'));
    if (prof) prof.end('skin_roi', { kind: 'ycrcb_connected_components', coverage: round3(skin.coverage) });
  } catch (err) {
    if (prof) prof.fail('skin_roi', err, { kind: 'ycrcb_connected_components' });
    return { ok: false, reason: skin && skin.reason ? skin.reason : 'skin_roi_failed' };
  }

  const regionBoxes = computeRegionBoxes(skin.bbox);
  let quality = null;
  try {
    if (prof) prof.start('quality', { kind: 'quality_metrics' });
    quality = computeQualityMetrics({
      rgb,
      width,
      height,
      skinMask: skin.mask,
      skinPixels: skin.skinPixels,
      bbox: skin.bbox,
      qualityGateConfig,
    });
    if (prof)
      prof.end('quality', {
        kind: 'quality_metrics',
        grade: quality.grade,
        qf: quality.quality_factor,
        coverage: quality.metrics && quality.metrics.skin_coverage ? quality.metrics.skin_coverage : null,
      });
  } catch (err) {
    if (prof) prof.fail('quality', err, { kind: 'quality_metrics' });
    return { ok: false, reason: 'quality_failed' };
  }

  let labStats = null;
  let raw = null;
  try {
    if (prof) prof.start('detector', { kind: 'lab_texture_rules' });
    labStats = computeLabStats({ rgb, width, height, skinMask: skin.mask, regionBoxes });
    raw = computeIssueRawScores({ labStats, rgb, width, height, skinMask: skin.mask, skinPixels: skin.skinPixels, regionBoxes, quality });
    if (prof)
      prof.end('detector', {
        kind: 'lab_texture_rules',
        acne_n: raw && raw.acne && raw.acne.metrics ? raw.acne.metrics.count : null,
      });
  } catch (err) {
    if (prof) prof.fail('detector', err, { kind: 'lab_texture_rules' });
    return { ok: false, reason: 'detector_failed' };
  }

  const issues = [];
  try {
    if (prof) prof.start('postprocess', { kind: 'severity_calibration' });
    issues.push(
      runIssueScoring({
        issueType: 'acne',
        rawScore: raw.acne.score,
        modelConf: raw.acne.model_conf,
        region: 'all',
        quality,
        profileSummary,
        recentLogsSummary,
        metrics: raw.acne.metrics,
        wbUnstable: raw.wbUnstable,
        language: lang,
        severityThresholds,
      }),
    );
    issues.push(
      runIssueScoring({
        issueType: 'redness',
        rawScore: raw.redness.score,
        modelConf: raw.redness.model_conf,
        region: 'all',
        quality,
        profileSummary,
        recentLogsSummary,
        metrics: raw.redness.metrics,
        wbUnstable: raw.wbUnstable,
        language: lang,
        severityThresholds,
      }),
    );
    issues.push(
      runIssueScoring({
        issueType: 'pores',
        rawScore: raw.pores.score,
        modelConf: raw.pores.model_conf,
        region: 'nose',
        quality,
        profileSummary,
        recentLogsSummary,
        metrics: raw.pores.metrics,
        wbUnstable: raw.wbUnstable,
        language: lang,
        severityThresholds,
      }),
    );
    issues.push(
      runIssueScoring({
        issueType: 'dark_spots',
        rawScore: raw.dark_spots.score,
        modelConf: raw.dark_spots.model_conf,
        region: 'all',
        quality,
        profileSummary,
        recentLogsSummary,
        metrics: raw.dark_spots.metrics,
        wbUnstable: raw.wbUnstable,
        language: lang,
        severityThresholds,
      }),
    );
    if (prof) prof.end('postprocess', { kind: 'severity_calibration', issues_n: issues.length });
  } catch (err) {
    if (prof) prof.fail('postprocess', err, { kind: 'severity_calibration' });
    return { ok: false, reason: 'postprocess_failed' };
  }

  const findingsOutput = buildPhotoFindings({
    issues,
    raw,
    quality,
    regionBoxes,
    width,
    height,
    language: lang,
  });

  const payload = toDiagnosisCardPayload({
    diagnosis: issues,
    quality,
    language: lang,
    photoFindings: findingsOutput.photo_findings,
    takeaways: findingsOutput.takeaways,
  });
  const bbox = skin && skin.bbox && typeof skin.bbox === 'object' ? skin.bbox : null;
  const w = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : null;
  const h = Number.isFinite(height) ? Math.max(1, Math.trunc(height)) : null;
  const internal = w && h
    ? {
        orig_size_px: { w, h },
        ...(bbox
          ? {
              skin_bbox_norm: {
                x0: clamp01(bbox.x0 / w),
                y0: clamp01(bbox.y0 / h),
                x1: clamp01(bbox.x1 / w),
                y1: clamp01(bbox.y1 / h),
              },
            }
          : {}),
      }
    : null;
  return { ok: true, diagnosis: payload, ...(internal ? { internal } : {}) };
}

function summarizeDiagnosisForPolicy(diagnosisV1) {
  const d = diagnosisV1 && typeof diagnosisV1 === 'object' && !Array.isArray(diagnosisV1) ? diagnosisV1 : null;
  const issues = d && Array.isArray(d.issues) ? d.issues : [];
  const quality = d && d.quality && typeof d.quality === 'object' ? d.quality : null;
  const qualityGrade = quality && typeof quality.grade === 'string' ? quality.grade : 'unknown';

  const sorted = issues
    .map((it) => (it && typeof it === 'object' && !Array.isArray(it) ? it : null))
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const sa = Number.isFinite(a.severity_level) ? a.severity_level : 0;
      const sb = Number.isFinite(b.severity_level) ? b.severity_level : 0;
      if (sb !== sa) return sb - sa;
      const ca = Number.isFinite(a.confidence) ? a.confidence : 0;
      const cb = Number.isFinite(b.confidence) ? b.confidence : 0;
      return cb - ca;
    });

  const top = sorted[0] || null;
  const second = sorted[1] || null;
  const topSeverity = top && Number.isFinite(top.severity_level) ? top.severity_level : 0;
  const topConf = top && Number.isFinite(top.confidence) ? top.confidence : 0;
  const topScore = top && Number.isFinite(top.severity_score) ? top.severity_score : null;
  const secondScore = second && Number.isFinite(second.severity_score) ? second.severity_score : null;

  let detectorConfidenceLevel = 'low';
  if (qualityGrade === 'pass' && topSeverity >= 2 && topConf >= 0.75) detectorConfidenceLevel = 'high';
  else if (qualityGrade === 'pass' && topSeverity >= 1 && topConf >= 0.55) detectorConfidenceLevel = 'medium';

  const uncertaintyReasons = [];
  if (qualityGrade !== 'pass') uncertaintyReasons.push(`quality_${qualityGrade}`);
  if (topConf < 0.6) uncertaintyReasons.push('low_top_confidence');
  if (topScore != null && secondScore != null) {
    const gap = Math.abs(topScore - secondScore);
    if (gap < 0.06) uncertaintyReasons.push('top2_close');
  }
  // "Uncertainty" should be reserved for cases where deterministic signals are genuinely ambiguous
  // (e.g. low confidence, close top-2 scores, or non-pass quality). Medium confidence ≠ uncertainty.
  const uncertainty = uncertaintyReasons.length > 0;

  const topIssueTypes = sorted
    .filter((it) => (Number.isFinite(it.severity_level) ? it.severity_level : 0) > 0)
    .map((it) => (typeof it.issue_type === 'string' ? it.issue_type : null))
    .filter(Boolean)
    .slice(0, 3);

  return {
    schema_version: 'aurora.skin_diagnosis_policy.v1',
    detector_confidence_level: detectorConfidenceLevel,
    uncertainty,
    ...(uncertaintyReasons.length ? { uncertainty_reasons: uncertaintyReasons.slice(0, 6) } : {}),
    ...(topIssueTypes.length ? { top_issue_types: topIssueTypes } : {}),
  };
}

function buildSkinAnalysisFromDiagnosisV1(diagnosisV1, { language, profileSummary } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const d = diagnosisV1 && typeof diagnosisV1 === 'object' && !Array.isArray(diagnosisV1) ? diagnosisV1 : null;
  const issues = d && Array.isArray(d.issues) ? d.issues : [];
  const quality = d && d.quality && typeof d.quality === 'object' ? d.quality : null;
  if (!d || !issues.length) return null;

  function clampText(raw, maxLen) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return '';
    if (s.length <= maxLen) return s;
    return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
  }

  const sorted = issues
    .map((it) => (it && typeof it === 'object' && !Array.isArray(it) ? it : null))
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const sa = Number.isFinite(a.severity_level) ? a.severity_level : 0;
      const sb = Number.isFinite(b.severity_level) ? b.severity_level : 0;
      if (sb !== sa) return sb - sa;
      const ca = Number.isFinite(a.confidence) ? a.confidence : 0;
      const cb = Number.isFinite(b.confidence) ? b.confidence : 0;
      return cb - ca;
    });

  const features = [];
  const photoFindings = Array.isArray(d.photo_findings)
    ? d.photo_findings.filter((item) => item && typeof item === 'object').slice(0, 10)
    : [];
  const takeaways = [];
  const qualityGrade = quality && typeof quality.grade === 'string' ? quality.grade : null;
  if (qualityGrade && qualityGrade !== 'pass') {
    features.push({
      observation:
        lang === 'CN'
          ? `照片质量=${qualityGrade}，我会更保守（避免把光照/油光/虚焦当成皮肤问题）。`
          : `Photo quality=${qualityGrade}; I’ll be more conservative (to avoid mistaking lighting/shine/blur for skin issues).`,
      confidence: 'pretty_sure',
    });
  }

  const diagnosisTakeaways = Array.isArray(d.takeaways) ? d.takeaways : [];
  for (const takeaway of diagnosisTakeaways) {
    if (!takeaway || typeof takeaway !== 'object') continue;
    const text = typeof takeaway.text === 'string' ? takeaway.text.trim() : '';
    if (!text) continue;
    takeaways.push({
      takeaway_id: takeaway.takeaway_id || null,
      source: takeaway.source || 'photo',
      issue_type: takeaway.issue_type || null,
      text,
      confidence: round3(clamp01(Number(takeaway.confidence))),
      linked_finding_ids: Array.isArray(takeaway.linked_finding_ids) ? takeaway.linked_finding_ids.slice(0, 6) : [],
      linked_issue_types: Array.isArray(takeaway.linked_issue_types) ? takeaway.linked_issue_types.slice(0, 6) : [],
    });
  }

  const userGoals = profileSummary && Array.isArray(profileSummary.goals) ? profileSummary.goals.filter((item) => typeof item === 'string') : [];
  if (userGoals.length) {
    const goalsText = userGoals.slice(0, 3).join(', ');
    takeaways.push({
      takeaway_id: 'tw_user_goals',
      source: 'user',
      issue_type: 'goal',
      text: lang === 'CN' ? `You mentioned your goals: ${goalsText}.` : `You mentioned your goals: ${goalsText}.`,
      confidence: 1,
      linked_finding_ids: [],
      linked_issue_types: ['goal'],
    });
  }

  const issueText = (it) => {
    const type = typeof it.issue_type === 'string' ? it.issue_type : null;
    const sev = typeof it.severity === 'string' ? it.severity : 'none';
    const conf = typeof it.confidence_label === 'string' ? it.confidence_label : 'somewhat_sure';
    if (!type) return null;

    if (type === 'acne') {
      if (sev === 'none') {
        return {
          observation:
            lang === 'CN'
              ? '痘/红点信号不强（仅基于可见线索）；如果你有在用强活性，优先避免刺激叠加。'
              : 'Acne-like red bump signals are not strong (visible cues only); if you use strong actives, avoid stacking irritation.',
          confidence: conf,
        };
      }
      return {
        observation:
          lang === 'CN'
            ? `有痘/红点倾向（${sev}）：先把“温和+控刺激”放在第一位，再逐步做控痘。`
            : `Some acne-like red bump tendency (${sev}): prioritize gentle + low-irritation first, then step up acne control gradually.`,
        confidence: conf,
      };
    }

    if (type === 'redness') {
      if (sev === 'none') {
        return {
          observation: lang === 'CN' ? '泛红信号不强；如果最近有刺痛/爆皮，更应以修护为主。' : 'Redness signals are not strong; if you’ve had stinging/flaking, prioritize barrier repair.',
          confidence: conf,
        };
      }
      return {
        observation:
          lang === 'CN'
            ? `泛红/刺激信号偏多（${sev}）：建议减少叠加与频率，先稳住屏障。`
            : `More redness/irritation signals (${sev}): reduce stacking/frequency and stabilize the barrier first.`,
        confidence: conf,
      };
    }

    if (type === 'pores') {
      if (sev === 'none') {
        return {
          observation: lang === 'CN' ? '毛孔/纹理信号不强；油光/反光会让判断偏保守。' : 'Pore/texture signals are not strong; shine can bias this, so I keep it conservative.',
          confidence: conf,
        };
      }
      return {
        observation:
          lang === 'CN'
            ? `毛孔/纹理较明显（${sev}）：更适合“温和清洁+保湿+控油”，避免过度去角质。`
            : `Pores/texture look more noticeable (${sev}): lean on gentle cleansing + hydration + oil control; avoid over-exfoliating.`,
        confidence: conf,
      };
    }

    if (type === 'dark_spots') {
      const wbUnstable = quality && Array.isArray(quality.reasons) ? quality.reasons.includes('white_balance_unstable') : false;
      const isDegraded = qualityGrade && qualityGrade !== 'pass';
      if (isDegraded || wbUnstable) {
        return {
          observation:
            lang === 'CN'
              ? '光照/白平衡不够稳定：本次对暗沉/色沉会更保守，建议自然光无滤镜再评估。'
              : 'Lighting/white balance is unstable: I’m conservative about dark spots/uneven tone; retake in daylight with no filters to reassess.',
          confidence: 'not_sure',
        };
      }
      if (sev === 'none') {
        return {
          observation: lang === 'CN' ? '暗沉/色沉信号不强；想要更准需要更稳定的自然光。' : 'Dark spot/uneven tone signals are not strong; stable daylight helps reliability.',
          confidence: conf,
        };
      }
      return {
        observation:
          lang === 'CN'
            ? `肤色不均/暗沉倾向（${sev}）：建议先把防晒和温和提亮节奏做稳。`
            : `Some uneven tone/dark spot tendency (${sev}): prioritize consistent SPF and gentle brightening pace.`,
        confidence: conf,
      };
    }

    return null;
  };

  for (const it of sorted) {
    if (features.length >= 6) break;
    const f = issueText(it);
    if (!f) continue;
    const observation = clampText(f.observation, 200);
    if (!observation) continue;
    const c = typeof f.confidence === 'string' ? f.confidence.trim() : '';
    const confidence = c === 'pretty_sure' || c === 'somewhat_sure' || c === 'not_sure' ? c : 'somewhat_sure';
    features.push({ observation, confidence });
  }

  const routineText = profileSummary && typeof profileSummary.currentRoutine === 'string' ? profileSummary.currentRoutine : '';
  const routineLower = String(routineText || '').toLowerCase();
  const hasRetinoid = /\bretinol\b|\btretinoin\b|\badapalene\b|\bretinoid\b|维a|阿达帕林|维a酸|视黄醇/.test(routineLower);
  const hasAcids = /\b(aha|bha|pha|glycolic|lactic|salicylic)\b|果酸|水杨酸|乳酸|葡糖酸内酯/.test(routineLower);

  const needs_risk_check = Boolean(hasRetinoid || hasAcids);

  const strategy =
    lang === 'CN'
      ? `建议按 3 步走：\n1) 基础稳住：温和洁面 + 保湿；白天一定要 SPF。\n2) 若想改善（痘/泛红/毛孔/肤色不均）：一次只改一个变量，从低频开始，观察 72 小时。\n3) 避免同晚叠加多种强活性（维A/酸/高浓VC），有刺痛/爆皮就先修护。\n\n你最近是否有刺痛/泛红/爆皮？`
      : `A safe 3-step plan:\n1) Stabilize basics: gentle cleanser + moisturizer; daytime SPF is non-negotiable.\n2) If targeting acne/redness/pores/uneven tone: change one variable at a time, start low-frequency, watch the 72h response.\n3) Avoid stacking multiple strong actives (retinoid/acids/high-strength vitamin C); if stinging/flaking, switch to repair mode.\n\nAny stinging/redness/flaking recently?`;

  return {
    features: features.slice(0, 6),
    strategy: clampText(strategy, 1200),
    needs_risk_check,
    photo_findings: photoFindings,
    findings: photoFindings,
    takeaways: takeaways.slice(0, 10),
  };
}

module.exports = {
  runSkinDiagnosisV1,
  summarizeDiagnosisForPolicy,
  buildSkinAnalysisFromDiagnosisV1,
  scoreToSeverity,
  calibrateModelConfidence,
  agreementFactor,
  applyTemperatureScaling,
  applyIsotonicPoints,
};
