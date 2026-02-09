const crypto = require('crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MODEL_OUTPUT_SCHEMA_VERSION = 'aurora.diag.model_output.v1';
const PSEUDO_LABEL_SCHEMA_VERSION = 'aurora.diag.pseudo_label.v1';
const AGREEMENT_SAMPLE_SCHEMA_VERSION = 'aurora.diag.agreement_sample.v1';
const MANIFEST_SCHEMA_VERSION = 'aurora.diag.pseudo_label_manifest.v1';

const DEFAULT_STORE_SUBDIR = path.join('tmp', 'diag_pseudo_label_factory');
const DEFAULT_REGION_IOU_THRESHOLD = 0.3;
const DEFAULT_AGREEMENT_THRESHOLD = 0.75;

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function parseBool(value, fallback = false) {
  const token = normalizeToken(value);
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(Number(value))) return min;
  return Math.max(min, Math.min(max, Number(value)));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clampSeverity(value) {
  return clamp(value, 0, 4);
}

function round3(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Number(Number(value).toFixed(3));
}

function summarizeSchemaError(value) {
  const token = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!token) return null;
  return token.slice(0, 120);
}

function isoNow() {
  return new Date().toISOString();
}

function randomId(prefix) {
  if (typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function envNumber(name, fallback, min, max) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function envNumberFromValue(rawValue, fallback, min, max) {
  const value = Number(rawValue == null ? fallback : rawValue);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function normalizeType(rawType) {
  const token = normalizeToken(rawType);
  if (!token) return 'other';
  const aliases = {
    redness: 'redness',
    irritation: 'redness',
    erythema: 'redness',
    acne: 'acne',
    breakout: 'acne',
    breakouts: 'acne',
    pores: 'texture',
    texture: 'texture',
    roughness: 'texture',
    shine: 'shine',
    oiliness: 'shine',
    sebum: 'shine',
    tone: 'tone',
    dark_spots: 'tone',
    pigmentation: 'tone',
    dryness: 'dryness',
    dehydration: 'dryness',
    barrier: 'barrier',
    sensitivity: 'barrier',
    other: 'other',
  };
  return aliases[token] || 'other';
}

function getStoreConfig() {
  const dir = String(process.env.AURORA_PSEUDO_LABEL_DIR || '').trim() || path.join(process.cwd(), DEFAULT_STORE_SUBDIR);
  const agreementRawValue = process.env.AURORA_PSEUDO_LABEL_MIN_AGREEMENT == null
    ? process.env.AURORA_PSEUDO_LABEL_AGREEMENT_THRESHOLD
    : process.env.AURORA_PSEUDO_LABEL_MIN_AGREEMENT;
  return {
    enabled: parseBool(process.env.AURORA_PSEUDO_LABEL_ENABLED, true),
    baseDir: dir,
    allowRoi: parseBool(process.env.AURORA_PSEUDO_LABEL_ALLOW_ROI, false),
    regionIouThreshold: envNumber('AURORA_PSEUDO_LABEL_REGION_IOU_THRESHOLD', DEFAULT_REGION_IOU_THRESHOLD, 0.05, 0.95),
    agreementThreshold: envNumberFromValue(agreementRawValue, DEFAULT_AGREEMENT_THRESHOLD, 0.05, 1),
  };
}

function getStorePaths(config = getStoreConfig()) {
  return {
    baseDir: config.baseDir,
    manifest: path.join(config.baseDir, 'manifest.json'),
    modelOutputs: path.join(config.baseDir, 'model_outputs.ndjson'),
    pseudoLabels: path.join(config.baseDir, 'pseudo_labels.ndjson'),
    agreementSamples: path.join(config.baseDir, 'agreement_samples.ndjson'),
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function safeReadLines(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function appendNdjson(filePath, records) {
  if (!Array.isArray(records) || !records.length) return;
  const data = `${records.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await fs.appendFile(filePath, data, { encoding: 'utf8' });
}

function defaultManifest(config) {
  const now = isoNow();
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
    settings: {
      allow_roi: Boolean(config.allowRoi),
      region_iou_threshold: round3(config.regionIouThreshold),
      agreement_threshold: round3(config.agreementThreshold),
    },
    counts: {
      model_outputs: 0,
      pseudo_labels: 0,
      agreement_samples: 0,
    },
  };
}

async function updateManifest(paths, config, delta = {}) {
  const loaded = await safeReadJson(paths.manifest);
  const manifest = loaded && typeof loaded === 'object' ? loaded : defaultManifest(config);
  manifest.schema_version = MANIFEST_SCHEMA_VERSION;
  manifest.updated_at = isoNow();
  manifest.settings = {
    allow_roi: Boolean(config.allowRoi),
    region_iou_threshold: round3(config.regionIouThreshold),
    agreement_threshold: round3(config.agreementThreshold),
  };
  manifest.counts = {
    model_outputs: Math.max(0, Math.trunc(Number(manifest.counts?.model_outputs || 0) + Number(delta.model_outputs || 0))),
    pseudo_labels: Math.max(0, Math.trunc(Number(manifest.counts?.pseudo_labels || 0) + Number(delta.pseudo_labels || 0))),
    agreement_samples: Math.max(0, Math.trunc(Number(manifest.counts?.agreement_samples || 0) + Number(delta.agreement_samples || 0))),
  };
  const tmpPath = `${paths.manifest}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(tmpPath, paths.manifest);
  return manifest;
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
  return normalizeBBox({ x0: minX, y0: minY, x1: maxX, y1: maxY });
}

function normalizeHeatmapValues(values, expectedLen) {
  if (!Array.isArray(values) || values.length !== expectedLen) return null;
  const normalized = values.map((v) => clamp01(v));
  const sum = normalized.reduce((acc, v) => acc + v, 0);
  if (sum <= 0) return normalized.map(() => round3(1 / Math.max(1, normalized.length)));
  return normalized.map((v) => round3(v / sum));
}

function bboxFromHeatmap(region) {
  if (!region || typeof region !== 'object') return null;
  const rows = Math.max(1, Math.min(64, Math.trunc(Number(region.rows))));
  const cols = Math.max(1, Math.min(64, Math.trunc(Number(region.cols))));
  const values = normalizeHeatmapValues(region.values, rows * cols);
  if (!values) return null;

  const peak = values.reduce((acc, v) => Math.max(acc, v), 0);
  if (peak <= 0) return null;
  const threshold = peak * 0.35;
  let minRow = rows;
  let minCol = cols;
  let maxRow = -1;
  let maxCol = -1;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = values[row * cols + col];
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

function extractFirstHeatmapSignature(concern) {
  const regions = Array.isArray(concern?.regions) ? concern.regions : [];
  for (const region of regions) {
    if (!region || region.kind !== 'heatmap') continue;
    const rows = Math.max(1, Math.min(64, Math.trunc(Number(region.rows))));
    const cols = Math.max(1, Math.min(64, Math.trunc(Number(region.cols))));
    const normalized = normalizeHeatmapValues(region.values, rows * cols);
    if (!normalized) continue;
    return { rows, cols, values: normalized };
  }
  return null;
}

function extractPrimaryBBox(concern) {
  const regions = Array.isArray(concern?.regions) ? concern.regions : [];
  for (const region of regions) {
    if (!region || typeof region !== 'object') continue;
    if (region.kind === 'bbox' && region.bbox_norm) {
      const bbox = normalizeBBox(region.bbox_norm);
      if (bbox) return bbox;
    }
    if (region.kind === 'polygon' && Array.isArray(region.points)) {
      const bbox = bboxFromPolygon(region.points);
      if (bbox) return bbox;
    }
    if (region.kind === 'heatmap') {
      const bbox = bboxFromHeatmap(region);
      if (bbox) return bbox;
    }
  }
  return null;
}

function iou(a, b) {
  if (!a || !b) return 0;
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const intersect = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (intersect <= 0) return 0;
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const union = areaA + areaB - intersect;
  if (union <= 0) return 0;
  return round3(intersect / union);
}

function correlation(valuesA, valuesB) {
  if (!Array.isArray(valuesA) || !Array.isArray(valuesB)) return null;
  if (!valuesA.length || valuesA.length !== valuesB.length) return null;
  const n = valuesA.length;
  const meanA = valuesA.reduce((acc, v) => acc + v, 0) / n;
  const meanB = valuesB.reduce((acc, v) => acc + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = valuesA[i] - meanA;
    const db = valuesB[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA <= 1e-12 || denB <= 1e-12) return null;
  return round3(num / Math.sqrt(denA * denB));
}

function klDivergence(p, q) {
  if (!Array.isArray(p) || !Array.isArray(q)) return null;
  if (!p.length || p.length !== q.length) return null;
  const eps = 1e-9;
  let score = 0;
  for (let i = 0; i < p.length; i += 1) {
    const pv = Math.max(eps, Number(p[i]));
    const qv = Math.max(eps, Number(q[i]));
    score += pv * Math.log(pv / qv);
  }
  return round3(score);
}

function concernWeight(concern) {
  return Math.max(0.1, clamp01(concern.confidence) * (1 + clampSeverity(concern.severity) / 4));
}

function normalizeConcern(concern, index = 0) {
  const type = normalizeType(concern?.type);
  const severity = round3(clampSeverity(concern?.severity));
  const confidence = round3(clamp01(concern?.confidence));
  const bbox = extractPrimaryBBox(concern);
  const heatmap = extractFirstHeatmapSignature(concern);
  const evidenceText = String(concern?.evidence_text || '').trim();
  const qualitySensitivity = String(concern?.quality_sensitivity || '').trim() || 'medium';
  const sourceModel = String(concern?.source_model || '').trim();
  const sourceIds = Array.isArray(concern?.provenance?.source_ids)
    ? concern.provenance.source_ids.filter((v) => typeof v === 'string' && v.trim()).slice(0, 8)
    : [];

  return {
    idx: index,
    type,
    severity,
    confidence,
    bbox,
    heatmap,
    evidence_text: evidenceText.slice(0, 500),
    quality_sensitivity: qualitySensitivity,
    source_model: sourceModel || null,
    source_ids: sourceIds,
    raw_regions: Array.isArray(concern?.regions) ? concern.regions : [],
  };
}

function concernsByType(concerns) {
  const grouped = new Map();
  for (const concern of concerns) {
    if (!grouped.has(concern.type)) grouped.set(concern.type, []);
    grouped.get(concern.type).push(concern);
  }
  return grouped;
}

function summarizeTypeWeights(concerns) {
  const grouped = concernsByType(concerns);
  const out = new Map();
  for (const [type, list] of grouped.entries()) {
    const weight = list.reduce((acc, concern) => acc + concernWeight(concern), 0);
    out.set(type, round3(weight));
  }
  return out;
}

function computeTypeLevelAgreement(leftConcerns, rightConcerns) {
  const left = summarizeTypeWeights(leftConcerns);
  const right = summarizeTypeWeights(rightConcerns);
  const leftTypes = new Set(left.keys());
  const rightTypes = new Set(right.keys());
  const union = new Set([...leftTypes, ...rightTypes]);
  const intersection = new Set([...leftTypes].filter((type) => rightTypes.has(type)));

  const jaccard = union.size ? intersection.size / union.size : 1;

  let tp = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const type of union) {
    const lw = left.get(type) || 0;
    const rw = right.get(type) || 0;
    leftTotal += lw;
    rightTotal += rw;
    tp += Math.min(lw, rw);
  }
  const precision = leftTotal > 0 ? tp / leftTotal : 1;
  const recall = rightTotal > 0 ? tp / rightTotal : 1;
  const weightedF1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    jaccard: round3(jaccard),
    weighted_f1: round3(weightedF1),
    overlap_types: intersection.size,
    union_types: union.size,
  };
}

function mergeBboxForType(concerns) {
  const withBbox = concerns.filter((concern) => concern.bbox);
  if (!withBbox.length) return null;
  let sumWeight = 0;
  let x0 = 0;
  let y0 = 0;
  let x1 = 0;
  let y1 = 0;
  for (const concern of withBbox) {
    const weight = concernWeight(concern);
    sumWeight += weight;
    x0 += concern.bbox.x0 * weight;
    y0 += concern.bbox.y0 * weight;
    x1 += concern.bbox.x1 * weight;
    y1 += concern.bbox.y1 * weight;
  }
  if (sumWeight <= 0) return withBbox[0].bbox;
  return normalizeBBox({ x0: x0 / sumWeight, y0: y0 / sumWeight, x1: x1 / sumWeight, y1: y1 / sumWeight });
}

function summarizeHeatmapForType(concerns) {
  const list = concerns.filter((concern) => concern.heatmap && Array.isArray(concern.heatmap.values));
  if (!list.length) return null;
  list.sort((a, b) => concernWeight(b) - concernWeight(a));
  return list[0].heatmap;
}

function weightedSeverityForType(concerns) {
  if (!Array.isArray(concerns) || !concerns.length) return { severity: 0, confidence: 0 };
  let sumWeight = 0;
  let severitySum = 0;
  let confidenceSum = 0;
  for (const concern of concerns) {
    const weight = concernWeight(concern);
    sumWeight += weight;
    severitySum += concern.severity * weight;
    confidenceSum += concern.confidence * weight;
  }
  if (sumWeight <= 0) return { severity: 0, confidence: 0 };
  return {
    severity: round3(severitySum / sumWeight),
    confidence: round3(confidenceSum / sumWeight),
  };
}

function computeRegionLevelAgreement(leftConcerns, rightConcerns) {
  const leftGrouped = concernsByType(leftConcerns);
  const rightGrouped = concernsByType(rightConcerns);
  const commonTypes = [...leftGrouped.keys()].filter((type) => rightGrouped.has(type)).sort();

  const perType = [];
  const iouValues = [];
  const corrValues = [];
  const klValues = [];

  for (const type of commonTypes) {
    const leftList = leftGrouped.get(type) || [];
    const rightList = rightGrouped.get(type) || [];
    const leftBox = mergeBboxForType(leftList);
    const rightBox = mergeBboxForType(rightList);
    const overlap = iou(leftBox, rightBox);
    const leftHeat = summarizeHeatmapForType(leftList);
    const rightHeat = summarizeHeatmapForType(rightList);
    let heatCorr = null;
    let heatKl = null;
    if (leftHeat && rightHeat && leftHeat.rows === rightHeat.rows && leftHeat.cols === rightHeat.cols) {
      heatCorr = correlation(leftHeat.values, rightHeat.values);
      heatKl = klDivergence(leftHeat.values, rightHeat.values);
    }
    iouValues.push(overlap);
    if (Number.isFinite(Number(heatCorr))) corrValues.push(Number(heatCorr));
    if (Number.isFinite(Number(heatKl))) klValues.push(Number(heatKl));
    perType.push({
      type,
      iou: round3(overlap),
      heatmap_correlation: Number.isFinite(Number(heatCorr)) ? round3(Number(heatCorr)) : null,
      heatmap_kl: Number.isFinite(Number(heatKl)) ? round3(Number(heatKl)) : null,
    });
  }

  const meanIou = iouValues.length ? iouValues.reduce((acc, v) => acc + v, 0) / iouValues.length : 0;
  const meanCorr = corrValues.length ? corrValues.reduce((acc, v) => acc + v, 0) / corrValues.length : null;
  const meanKl = klValues.length ? klValues.reduce((acc, v) => acc + v, 0) / klValues.length : null;
  const corrComponent = meanCorr == null ? 0.5 : clamp01((meanCorr + 1) / 2);
  const klComponent = meanKl == null ? 0.5 : clamp01(1 - meanKl / 4);
  const score = commonTypes.length ? 0.6 * meanIou + 0.2 * corrComponent + 0.2 * klComponent : 0;

  return {
    mean_iou: round3(meanIou),
    heatmap_correlation: meanCorr == null ? null : round3(meanCorr),
    heatmap_kl: meanKl == null ? null : round3(meanKl),
    common_types: commonTypes.length,
    score: round3(score),
    by_type: perType,
  };
}

function computeSeverityLevelAgreement(leftConcerns, rightConcerns) {
  const leftGrouped = concernsByType(leftConcerns);
  const rightGrouped = concernsByType(rightConcerns);
  const commonTypes = [...leftGrouped.keys()].filter((type) => rightGrouped.has(type)).sort();
  if (!commonTypes.length) {
    return {
      mae: 4,
      interval_overlap: 0,
      common_types: 0,
      score: 0,
      by_type: [],
    };
  }

  const maes = [];
  const overlaps = [];
  const perType = [];

  for (const type of commonTypes) {
    const left = weightedSeverityForType(leftGrouped.get(type));
    const right = weightedSeverityForType(rightGrouped.get(type));
    const mae = Math.abs(left.severity - right.severity);
    maes.push(mae);

    const leftWidth = Math.max(0.25, 1 - left.confidence);
    const rightWidth = Math.max(0.25, 1 - right.confidence);
    const leftLo = Math.max(0, left.severity - leftWidth);
    const leftHi = Math.min(4, left.severity + leftWidth);
    const rightLo = Math.max(0, right.severity - rightWidth);
    const rightHi = Math.min(4, right.severity + rightWidth);
    const overlap = Math.max(0, Math.min(leftHi, rightHi) - Math.max(leftLo, rightLo));
    const union = Math.max(leftHi, rightHi) - Math.min(leftLo, rightLo);
    const overlapRatio = union > 0 ? overlap / union : 0;
    overlaps.push(overlapRatio);
    perType.push({
      type,
      severity_left: left.severity,
      severity_right: right.severity,
      severity_mae: round3(mae),
      interval_overlap: round3(overlapRatio),
    });
  }

  const meanMae = maes.reduce((acc, v) => acc + v, 0) / maes.length;
  const meanOverlap = overlaps.reduce((acc, v) => acc + v, 0) / overlaps.length;
  const score = 0.5 * clamp01(1 - meanMae / 4) + 0.5 * clamp01(meanOverlap);

  return {
    mae: round3(meanMae),
    interval_overlap: round3(meanOverlap),
    common_types: commonTypes.length,
    score: round3(score),
    by_type: perType,
  };
}

function normalizeProviderOutput(providerOutput) {
  const concerns = Array.isArray(providerOutput?.concerns) ? providerOutput.concerns : [];
  return concerns.map((concern, index) => normalizeConcern(concern, index));
}

function computeAgreementForPair({ leftOutput, rightOutput } = {}) {
  const leftConcerns = normalizeProviderOutput(leftOutput);
  const rightConcerns = normalizeProviderOutput(rightOutput);
  const typeLevel = computeTypeLevelAgreement(leftConcerns, rightConcerns);
  const regionLevel = computeRegionLevelAgreement(leftConcerns, rightConcerns);
  const severityLevel = computeSeverityLevelAgreement(leftConcerns, rightConcerns);
  const overall = round3(0.4 * typeLevel.weighted_f1 + 0.35 * regionLevel.score + 0.25 * severityLevel.score);

  const byTypeMap = new Map();
  for (const item of regionLevel.by_type) byTypeMap.set(item.type, { ...item });
  for (const item of severityLevel.by_type) {
    const prev = byTypeMap.get(item.type) || { type: item.type };
    byTypeMap.set(item.type, { ...prev, ...item });
  }

  return {
    type_level: typeLevel,
    region_level: {
      mean_iou: regionLevel.mean_iou,
      heatmap_correlation: regionLevel.heatmap_correlation,
      heatmap_kl: regionLevel.heatmap_kl,
      common_types: regionLevel.common_types,
      score: regionLevel.score,
    },
    severity_level: {
      mae: severityLevel.mae,
      interval_overlap: severityLevel.interval_overlap,
      common_types: severityLevel.common_types,
      score: severityLevel.score,
    },
    overall,
    by_type: Array.from(byTypeMap.values())
      .sort((a, b) => String(a.type).localeCompare(String(b.type)))
      .map((row) => ({
        type: row.type,
        iou: Number.isFinite(Number(row.iou)) ? round3(row.iou) : null,
        heatmap_correlation: Number.isFinite(Number(row.heatmap_correlation)) ? round3(row.heatmap_correlation) : null,
        heatmap_kl: Number.isFinite(Number(row.heatmap_kl)) ? round3(row.heatmap_kl) : null,
        severity_mae: Number.isFinite(Number(row.severity_mae)) ? round3(row.severity_mae) : null,
        interval_overlap: Number.isFinite(Number(row.interval_overlap)) ? round3(row.interval_overlap) : null,
      })),
  };
}

function qualityRank(value) {
  const token = normalizeToken(value);
  if (token === 'high') return 3;
  if (token === 'medium') return 2;
  return 1;
}

function mergeQualitySensitivity(left, right) {
  return qualityRank(left) >= qualityRank(right) ? left : right;
}

function buildPseudoConcern({ geminiConcern, gptConcern, iouScore, agreementOverall }) {
  const leftBbox = geminiConcern.bbox;
  const rightBbox = gptConcern.bbox;
  let mergedBbox = null;
  if (leftBbox && rightBbox) {
    mergedBbox = normalizeBBox({
      x0: (leftBbox.x0 + rightBbox.x0) / 2,
      y0: (leftBbox.y0 + rightBbox.y0) / 2,
      x1: (leftBbox.x1 + rightBbox.x1) / 2,
      y1: (leftBbox.y1 + rightBbox.y1) / 2,
    });
  } else {
    mergedBbox = leftBbox || rightBbox || null;
  }
  if (!mergedBbox) return null;

  const evidenceSegments = [geminiConcern.evidence_text, gptConcern.evidence_text].filter(Boolean);
  const evidenceText = Array.from(new Set(evidenceSegments)).join(' | ').slice(0, 500) || 'cross-model consensus';

  return {
    type: geminiConcern.type,
    regions: [{ kind: 'bbox', bbox_norm: mergedBbox }],
    severity: round3((geminiConcern.severity + gptConcern.severity) / 2),
    confidence: round3((geminiConcern.confidence + gptConcern.confidence) / 2),
    evidence_text: evidenceText,
    quality_sensitivity: mergeQualitySensitivity(geminiConcern.quality_sensitivity, gptConcern.quality_sensitivity),
    source_model: 'pseudo_label_factory',
    provenance: {
      provider: 'pseudo_label_factory',
      source_ids: Array.from(
        new Set([
          ...(geminiConcern.source_ids.length ? geminiConcern.source_ids : [`gemini_provider:${geminiConcern.idx}`]),
          ...(gptConcern.source_ids.length ? gptConcern.source_ids : [`gpt_provider:${gptConcern.idx}`]),
        ]),
      ).slice(0, 10),
      notes: [`matched_type:${geminiConcern.type}`, `region_iou:${round3(iouScore)}`, `agreement_overall:${round3(agreementOverall)}`],
    },
  };
}

function generatePseudoLabelsForPair({
  geminiOutput,
  gptOutput,
  qualityGrade,
  regionIouThreshold = DEFAULT_REGION_IOU_THRESHOLD,
} = {}) {
  const leftConcerns = normalizeProviderOutput(geminiOutput);
  const rightConcerns = normalizeProviderOutput(gptOutput);
  const consumedRight = new Set();
  const matches = [];
  const pseudoConcerns = [];

  for (const left of leftConcerns) {
    let bestIndex = -1;
    let bestIou = 0;
    for (let idx = 0; idx < rightConcerns.length; idx += 1) {
      if (consumedRight.has(idx)) continue;
      const right = rightConcerns[idx];
      if (right.type !== left.type) continue;
      const overlap = iou(left.bbox, right.bbox);
      if (overlap > bestIou) {
        bestIou = overlap;
        bestIndex = idx;
      }
    }
    if (bestIndex < 0 || bestIou < regionIouThreshold) continue;
    const right = rightConcerns[bestIndex];
    consumedRight.add(bestIndex);
    matches.push({
      type: left.type,
      gemini_idx: left.idx,
      gpt_idx: right.idx,
      region_iou: round3(bestIou),
    });
  }

  const agreement = computeAgreementForPair({ leftOutput: geminiOutput, rightOutput: gptOutput });
  for (const match of matches) {
    const left = leftConcerns.find((item) => item.idx === match.gemini_idx);
    const right = rightConcerns.find((item) => item.idx === match.gpt_idx);
    if (!left || !right) continue;
    const concern = buildPseudoConcern({
      geminiConcern: left,
      gptConcern: right,
      iouScore: match.region_iou,
      agreementOverall: agreement.overall,
    });
    if (concern) pseudoConcerns.push(concern);
  }

  const qualityToken = normalizeToken(qualityGrade);
  const qualityEligible = qualityToken === 'pass' || qualityToken === 'degraded';
  return {
    quality_eligible: qualityEligible,
    matches,
    concerns: pseudoConcerns,
    agreement,
  };
}

function sanitizeConcernForStorage(concern, { allowRoi }) {
  const out = {
    type: normalizeType(concern?.type),
    severity: round3(clampSeverity(concern?.severity)),
    confidence: round3(clamp01(concern?.confidence)),
    evidence_text: String(concern?.evidence_text || '').trim().slice(0, 280),
    quality_sensitivity: String(concern?.quality_sensitivity || '').trim() || 'medium',
    source_model: String(concern?.source_model || '').trim() || null,
  };
  if (allowRoi) {
    out.regions = Array.isArray(concern?.regions) ? concern.regions : [];
  } else {
    const bbox = extractPrimaryBBox(concern);
    if (bbox) out.region_hint_bbox = bbox;
    const heatmap = extractFirstHeatmapSignature(concern);
    if (heatmap) {
      out.region_hint_heatmap = {
        rows: heatmap.rows,
        cols: heatmap.cols,
        // Store compact signature only, never full-resolution masks.
        signature: heatmap.values.slice(0, 64),
      };
    }
  }
  return out;
}

function summarizeDerivedFeatures(concerns) {
  const normalized = concerns.map((concern, index) => normalizeConcern(concern, index));
  const concernTypes = Array.from(new Set(normalized.map((concern) => concern.type))).sort();
  const confidenceMean = normalized.length
    ? normalized.reduce((acc, concern) => acc + concern.confidence, 0) / normalized.length
    : 0;
  const severityMean = normalized.length
    ? normalized.reduce((acc, concern) => acc + concern.severity, 0) / normalized.length
    : 0;
  return {
    concern_count: normalized.length,
    concern_types: concernTypes,
    confidence_mean: round3(confidenceMean),
    severity_mean: round3(severityMean),
  };
}

function inferModelName(output) {
  if (typeof output?.model_name === 'string' && output.model_name.trim()) return output.model_name.trim();
  if (typeof output?.source_model === 'string' && output.source_model.trim()) return output.source_model.trim();
  if (typeof output?.model === 'string' && output.model.trim()) return output.model.trim();
  if (output?.provider === 'gemini_provider') {
    return String(process.env.DIAG_ENSEMBLE_GEMINI_MODEL || '').trim() || 'gemini-2.0-flash';
  }
  if (output?.provider === 'gpt_provider') {
    return String(process.env.DIAG_ENSEMBLE_GPT_MODEL || '').trim() || 'gpt-4o-mini';
  }
  return 'cv_ruleset';
}

function inferModelVersion(output) {
  if (typeof output?.model_version === 'string' && output.model_version.trim()) return output.model_version.trim();
  return 'v1';
}

function buildModelOutputRecord({
  inferenceId,
  qualityGrade,
  output,
  skinToneBucket,
  lightingBucket,
  allowRoi,
}) {
  const concerns = Array.isArray(output?.concerns) ? output.concerns : [];
  const sanitizedConcerns = concerns.map((concern) => sanitizeConcernForStorage(concern, { allowRoi }));
  const now = isoNow();
  return {
    schema_version: MODEL_OUTPUT_SCHEMA_VERSION,
    record_id: randomId('mo'),
    inference_id: inferenceId,
    created_at: now,
    provider: String(output?.provider || 'unknown'),
    model_name: inferModelName(output),
    model_version: inferModelVersion(output),
    quality_grade: normalizeToken(qualityGrade) || 'unknown',
    skin_tone_bucket: String(skinToneBucket || 'unknown').trim() || 'unknown',
    lighting_bucket: String(lightingBucket || 'unknown').trim() || 'unknown',
    output_json: {
      ok: Boolean(output?.ok),
      decision: output?.decision ? String(output.decision).slice(0, 32) : output?.ok ? 'verify' : 'unknown',
      concerns: sanitizedConcerns,
      flags: Array.isArray(output?.flags) ? output.flags.slice(0, 20) : [],
      review: output?.review ? String(output.review).slice(0, 120) : null,
      failure_reason: output?.failure_reason ? String(output.failure_reason) : null,
      final_reason: output?.final_reason ? String(output.final_reason) : output?.failure_reason ? String(output.failure_reason) : null,
      raw_final_reason: output?.raw_final_reason ? String(output.raw_final_reason) : null,
      verify_fail_reason: output?.verify_fail_reason ? String(output.verify_fail_reason) : null,
      schema_failed: Boolean(output?.schema_failed),
      latency_ms: Number.isFinite(Number(output?.latency_ms)) ? round3(Number(output.latency_ms)) : null,
      attempts: Number.isFinite(Number(output?.attempts)) ? Math.max(0, Math.trunc(Number(output.attempts))) : null,
      provider_status_code:
        Number.isFinite(Number(output?.provider_status_code)) && Number(output.provider_status_code) > 0
          ? Math.trunc(Number(output.provider_status_code))
          : null,
      skipped_reason: output?.skipped_reason ? String(output.skipped_reason) : null,
      http_status_class: output?.http_status_class ? String(output.http_status_class).toLowerCase() : null,
      error_class: output?.error_class ? String(output.error_class).slice(0, 64) : null,
      image_bytes_len:
        Number.isFinite(Number(output?.image_bytes_len)) && Number(output.image_bytes_len) >= 0
          ? Math.trunc(Number(output.image_bytes_len))
          : null,
      request_payload_bytes_len:
        Number.isFinite(Number(output?.request_payload_bytes_len)) && Number(output.request_payload_bytes_len) >= 0
          ? Math.trunc(Number(output.request_payload_bytes_len))
          : null,
      response_bytes_len:
        Number.isFinite(Number(output?.response_bytes_len)) && Number(output.response_bytes_len) >= 0
          ? Math.trunc(Number(output.response_bytes_len))
          : null,
      schema_error_summary: summarizeSchemaError(output?.schema_error_summary),
      trace_id: output?.trace_id ? String(output.trace_id).slice(0, 96) : null,
    },
    derived_features: summarizeDerivedFeatures(concerns),
  };
}

function buildAgreementSampleRecord({
  inferenceId,
  qualityGrade,
  skinToneBucket,
  lightingBucket,
  agreement,
  pseudoLabelEligible,
  pseudoLabelEmitted,
  providerPair,
}) {
  return {
    schema_version: AGREEMENT_SAMPLE_SCHEMA_VERSION,
    sample_id: randomId('as'),
    inference_id: inferenceId,
    created_at: isoNow(),
    quality_grade: normalizeToken(qualityGrade) || 'unknown',
    skin_tone_bucket: String(skinToneBucket || 'unknown').trim() || 'unknown',
    lighting_bucket: String(lightingBucket || 'unknown').trim() || 'unknown',
    metrics: agreement,
    pseudo_label_eligible: Boolean(pseudoLabelEligible),
    pseudo_label_emitted: Boolean(pseudoLabelEmitted),
    provider_pair: Array.isArray(providerPair)
      ? providerPair.map((provider) => String(provider || '').trim() || 'unknown').slice(0, 2)
      : [],
  };
}

function buildPseudoLabelRecord({
  inferenceId,
  qualityGrade,
  skinToneBucket,
  lightingBucket,
  concerns,
  agreement,
  matches,
  providerModels,
}) {
  return {
    schema_version: PSEUDO_LABEL_SCHEMA_VERSION,
    pseudo_label_id: randomId('pl'),
    inference_id: inferenceId,
    created_at: isoNow(),
    quality_grade: normalizeToken(qualityGrade) || 'unknown',
    skin_tone_bucket: String(skinToneBucket || 'unknown').trim() || 'unknown',
    lighting_bucket: String(lightingBucket || 'unknown').trim() || 'unknown',
    concerns,
    agreement,
    matches,
    sources: providerModels,
  };
}

async function readNdjsonFile(filePath) {
  const lines = await safeReadLines(filePath);
  const rows = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch (_err) {
      // Skip malformed line.
    }
  }
  return rows;
}

function selectAgreementPair(outputs) {
  const list = Array.isArray(outputs) ? outputs.filter(Boolean) : [];
  const geminiOutput = list.find((output) => output.provider === 'gemini_provider');
  const gptOutput = list.find((output) => output.provider === 'gpt_provider');
  const cvOutput = list.find((output) => output.provider === 'cv_provider');

  if (geminiOutput && gptOutput) {
    return {
      leftOutput: geminiOutput,
      rightOutput: gptOutput,
      providerPair: ['gemini_provider', 'gpt_provider'],
      supportsPseudoLabels: true,
      geminiOutput,
      gptOutput,
    };
  }

  if (cvOutput && geminiOutput) {
    return {
      leftOutput: cvOutput,
      rightOutput: geminiOutput,
      providerPair: ['cv_provider', 'gemini_provider'],
      supportsPseudoLabels: false,
      geminiOutput: null,
      gptOutput: null,
    };
  }

  if (list.length >= 2) {
    return {
      leftOutput: list[0],
      rightOutput: list[1],
      providerPair: [
        String(list[0]?.provider || 'unknown').trim() || 'unknown',
        String(list[1]?.provider || 'unknown').trim() || 'unknown',
      ],
      supportsPseudoLabels: false,
      geminiOutput: null,
      gptOutput: null,
    };
  }

  return null;
}

async function persistPseudoLabelArtifacts({
  inferenceId,
  qualityGrade,
  providerOutputs,
  skinToneBucket,
  lightingBucket,
  logger,
} = {}) {
  const config = getStoreConfig();
  if (!config.enabled) {
    return { ok: true, enabled: false, reason: 'DISABLED_BY_FLAG' };
  }

  const outputs = Array.isArray(providerOutputs) ? providerOutputs.filter(Boolean) : [];
  if (!outputs.length) {
    return { ok: true, enabled: true, reason: 'NO_PROVIDER_OUTPUTS' };
  }

  const traceId = String(inferenceId || '').trim() || randomId('inf');
  const paths = getStorePaths(config);
  await ensureDir(paths.baseDir);

  const modelOutputRecords = outputs.map((output) =>
    buildModelOutputRecord({
      inferenceId: traceId,
      qualityGrade,
      output,
      skinToneBucket,
      lightingBucket,
      allowRoi: config.allowRoi,
    }),
  );

  await appendNdjson(paths.modelOutputs, modelOutputRecords);

  const agreementPair = selectAgreementPair(outputs);
  let agreementRecord = null;
  let pseudoLabelRecord = null;

  if (agreementPair) {
    let agreement = null;
    let pseudoLabelEligible = false;
    let emitPseudo = false;

    if (agreementPair.supportsPseudoLabels) {
      const generated = generatePseudoLabelsForPair({
        geminiOutput: agreementPair.geminiOutput,
        gptOutput: agreementPair.gptOutput,
        qualityGrade,
        regionIouThreshold: config.regionIouThreshold,
      });
      agreement = generated.agreement || null;
      const agreementPass = agreement && Number.isFinite(Number(agreement.overall))
        ? Number(agreement.overall) >= config.agreementThreshold
        : false;
      pseudoLabelEligible = generated.quality_eligible && agreementPass;
      emitPseudo = pseudoLabelEligible && generated.concerns.length > 0;

      if (emitPseudo) {
        pseudoLabelRecord = buildPseudoLabelRecord({
          inferenceId: traceId,
          qualityGrade,
          skinToneBucket,
          lightingBucket,
          concerns: generated.concerns,
          agreement,
          matches: generated.matches,
          providerModels: [
            {
              provider: 'gemini_provider',
              model_name: inferModelName(agreementPair.geminiOutput),
              model_version: inferModelVersion(agreementPair.geminiOutput),
            },
            {
              provider: 'gpt_provider',
              model_name: inferModelName(agreementPair.gptOutput),
              model_version: inferModelVersion(agreementPair.gptOutput),
            },
          ],
        });
      }
    } else {
      agreement = computeAgreementForPair({
        leftOutput: agreementPair.leftOutput,
        rightOutput: agreementPair.rightOutput,
      });
    }

    agreementRecord = buildAgreementSampleRecord({
      inferenceId: traceId,
      qualityGrade,
      skinToneBucket,
      lightingBucket,
      agreement,
      pseudoLabelEligible,
      pseudoLabelEmitted: emitPseudo,
      providerPair: agreementPair.providerPair,
    });
  }

  if (agreementRecord) await appendNdjson(paths.agreementSamples, [agreementRecord]);
  if (pseudoLabelRecord) await appendNdjson(paths.pseudoLabels, [pseudoLabelRecord]);

  const manifest = await updateManifest(paths, config, {
    model_outputs: modelOutputRecords.length,
    agreement_samples: agreementRecord ? 1 : 0,
    pseudo_labels: pseudoLabelRecord ? 1 : 0,
  });

  if (logger && typeof logger.info === 'function') {
    logger.info(
      {
        kind: 'diag_pseudo_label_factory',
        inference_id: traceId,
        model_outputs_written: modelOutputRecords.length,
        agreement_written: Boolean(agreementRecord),
        pseudo_label_written: Boolean(pseudoLabelRecord),
      },
      'aurora bff: pseudo-label factory persisted artifacts',
    );
  }

  return {
    ok: true,
    enabled: true,
    inference_id: traceId,
    model_outputs_written: modelOutputRecords.length,
    agreement_written: Boolean(agreementRecord),
    pseudo_label_written: Boolean(pseudoLabelRecord),
    manifest_counts: manifest && manifest.counts ? manifest.counts : null,
  };
}

module.exports = {
  MODEL_OUTPUT_SCHEMA_VERSION,
  PSEUDO_LABEL_SCHEMA_VERSION,
  AGREEMENT_SAMPLE_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  getStoreConfig,
  getStorePaths,
  iou,
  computeTypeLevelAgreement,
  computeRegionLevelAgreement,
  computeSeverityLevelAgreement,
  computeAgreementForPair,
  generatePseudoLabelsForPair,
  persistPseudoLabelArtifacts,
  readNdjsonFile,
  DEFAULT_AGREEMENT_THRESHOLD,
};
