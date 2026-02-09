const fs = require('node:fs');
const path = require('node:path');

const CALIBRATION_SCHEMA_VERSION = 'aurora.diag.calibration_model.v1';
const DEFAULT_MODEL_VERSION_PREFIX = 'diag_calibration_v1';
const DEFAULT_MODEL_RELATIVE_PATH = path.join('model_registry', 'diag_calibration_v1.json');
const DEFAULT_MATCH_IOU = 0.3;
const DEFAULT_MIN_GROUP_SAMPLES = 24;

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
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

function parseBool(value, fallback = false) {
  const token = normalizeToken(value);
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function normalizeBucket(value, fallback = 'unknown') {
  const token = normalizeToken(value);
  return token || fallback;
}

function isoNow() {
  return new Date().toISOString();
}

function defaultModelPath(baseDir = process.cwd()) {
  return path.join(baseDir, DEFAULT_MODEL_RELATIVE_PATH);
}

function findLatestCalibratorModel(baseDir = process.cwd()) {
  const registryDir = path.join(baseDir, 'model_registry');
  try {
    const entries = fs.readdirSync(registryDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && /^calibrator_v\d{8}\.json$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
    if (!candidates.length) return null;
    return path.join(registryDir, candidates[0]);
  } catch (_err) {
    return null;
  }
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

function bboxFromHeatmap(region) {
  if (!region || typeof region !== 'object') return null;
  const rows = Math.max(1, Math.min(64, Math.trunc(Number(region.rows))));
  const cols = Math.max(1, Math.min(64, Math.trunc(Number(region.cols))));
  const values = Array.isArray(region.values) ? region.values.map((v) => clamp01(v)) : [];
  if (values.length !== rows * cols) return null;

  let peak = 0;
  for (const value of values) peak = Math.max(peak, value);
  if (peak <= 0.0001) return null;

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

function extractPrimaryBBox(concern) {
  if (!concern || typeof concern !== 'object') return null;
  if (concern.region_hint_bbox) {
    const hinted = normalizeBBox(concern.region_hint_bbox);
    if (hinted) return hinted;
  }

  const regions = Array.isArray(concern.regions) ? concern.regions : [];
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
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (intersection <= 0) return 0;
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const union = areaA + areaB - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function normalizeConcernType(rawType) {
  const token = normalizeToken(rawType);
  if (!token) return 'other';
  const aliases = {
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
    texture: 'texture',
    pores: 'texture',
    roughness: 'texture',
    tone: 'tone',
    dark_spots: 'tone',
    hyperpigmentation: 'tone',
    dryness: 'dryness',
    dehydration: 'dryness',
    barrier: 'barrier',
    barrier_stress: 'barrier',
    sensitivity: 'barrier',
    other: 'other',
  };
  return aliases[token] || 'other';
}

function normalizeQualityFeatures(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const exposureScore = clamp01(
    source.exposure_score != null
      ? source.exposure_score
      : source.exposure != null
        ? source.exposure
        : source.brightness_score,
  );
  const reflectionScore = clamp01(
    source.reflection_score != null
      ? source.reflection_score
      : source.glare_score != null
        ? source.glare_score
        : source.specular_score,
  );
  const filterScore = clamp01(
    source.filter_score != null
      ? source.filter_score
      : source.filter_probability != null
        ? source.filter_probability
        : source.synthetic_filter_score,
  );
  const makeupDetected = Boolean(
    source.makeup_detected != null
      ? source.makeup_detected
      : source.has_makeup != null
        ? source.has_makeup
        : false,
  );
  const filterDetected = Boolean(
    source.filter_detected != null
      ? source.filter_detected
      : source.has_filter != null
        ? source.has_filter
        : filterScore >= 0.55,
  );

  return {
    exposure_score: round3(exposureScore),
    reflection_score: round3(reflectionScore),
    filter_score: round3(filterScore),
    makeup_detected: makeupDetected,
    filter_detected: filterDetected,
  };
}

function extractQualityFeaturesFromRecord(record = {}) {
  const source =
    (record.quality_features && typeof record.quality_features === 'object' && record.quality_features) ||
    (record.output_json && typeof record.output_json.quality_features === 'object' && record.output_json.quality_features) ||
    (record.metadata && typeof record.metadata.quality_features === 'object' && record.metadata.quality_features) ||
    {};
  return normalizeQualityFeatures({
    ...source,
    ...(record.filter_detected != null ? { filter_detected: record.filter_detected } : {}),
    ...(record.makeup_detected != null ? { makeup_detected: record.makeup_detected } : {}),
  });
}

function normalizeConcernForTraining(rawConcern, index = 0) {
  const concern = rawConcern && typeof rawConcern === 'object' ? rawConcern : {};
  return {
    idx: index,
    type: normalizeConcernType(concern.type),
    severity: round3(clampSeverity(concern.severity)),
    confidence: round3(clamp01(concern.confidence)),
    bbox: extractPrimaryBBox(concern),
  };
}

function extractConcernsFromProviderRecord(record = {}) {
  const concernsRaw =
    (record.output_json && Array.isArray(record.output_json.concerns) && record.output_json.concerns) ||
    (Array.isArray(record.concerns) && record.concerns) ||
    [];
  return concernsRaw.map((concern, index) => normalizeConcernForTraining(concern, index));
}

function extractConcernsFromGoldRecord(record = {}) {
  const concernsRaw =
    (Array.isArray(record.concerns) && record.concerns) ||
    (record.canonical && Array.isArray(record.canonical.concerns) && record.canonical.concerns) ||
    (record.output_json && Array.isArray(record.output_json.concerns) && record.output_json.concerns) ||
    [];
  return concernsRaw.map((concern, index) => normalizeConcernForTraining(concern, index));
}

function mapGoldByInference(goldLabels = []) {
  const map = new Map();
  for (const row of goldLabels) {
    if (!row || typeof row !== 'object') continue;
    const qaStatus = normalizeToken(row.qa_status || row.status || row.label_status || 'approved');
    if (qaStatus && !['approved', 'gold', 'accepted'].includes(qaStatus)) continue;
    const inferenceId = String(row.inference_id || row.inferenceId || row.trace_id || '').trim();
    if (!inferenceId) continue;
    map.set(inferenceId, row);
  }
  return map;
}

function greedyMatchByType(predictions, goldConcerns, iouThreshold) {
  const matchedPred = new Set();
  const matchedGold = new Set();
  const matches = [];

  const preds = Array.isArray(predictions) ? predictions : [];
  const gold = Array.isArray(goldConcerns) ? goldConcerns : [];

  for (let pIdx = 0; pIdx < preds.length; pIdx += 1) {
    const pred = preds[pIdx];
    let bestG = -1;
    let bestIou = 0;
    for (let gIdx = 0; gIdx < gold.length; gIdx += 1) {
      if (matchedGold.has(gIdx)) continue;
      const target = gold[gIdx];
      if (pred.type !== target.type) continue;
      const overlap = iou(pred.bbox, target.bbox);
      if (overlap >= iouThreshold && overlap > bestIou) {
        bestIou = overlap;
        bestG = gIdx;
      }
    }
    if (bestG >= 0) {
      matchedPred.add(pIdx);
      matchedGold.add(bestG);
      matches.push({ pred_index: pIdx, gold_index: bestG, iou: round3(bestIou), type: pred.type });
    }
  }

  return { matchedPred, matchedGold, matches };
}

function buildTrainingRows({ modelOutputs = [], goldLabels = [], iouThreshold = DEFAULT_MATCH_IOU } = {}) {
  const goldByInference = mapGoldByInference(goldLabels);
  const rows = [];

  for (const record of modelOutputs) {
    if (!record || typeof record !== 'object') continue;
    const inferenceId = String(record.inference_id || record.inferenceId || '').trim();
    if (!inferenceId) continue;

    const goldRecord = goldByInference.get(inferenceId);
    if (!goldRecord) continue;

    const provider = normalizeBucket(record.provider, 'unknown_provider');
    const qualityGrade = normalizeBucket(record.quality_grade, normalizeBucket(goldRecord.quality_grade, 'unknown'));
    const toneBucket = normalizeBucket(record.skin_tone_bucket, normalizeBucket(goldRecord.skin_tone_bucket, 'unknown'));
    const lightingBucket = normalizeBucket(record.lighting_bucket, normalizeBucket(goldRecord.lighting_bucket, 'unknown'));
    const regionBucket = normalizeBucket(
      record.region_bucket,
      normalizeBucket(
        (goldRecord.metadata && (goldRecord.metadata.region || goldRecord.metadata.country)) || goldRecord.region_bucket,
        'unknown',
      ),
    );

    const qualityFeatures = extractQualityFeaturesFromRecord({
      ...record,
      quality_features:
        (record.quality_features && typeof record.quality_features === 'object' && record.quality_features) ||
        (goldRecord.quality_features && typeof goldRecord.quality_features === 'object' && goldRecord.quality_features) ||
        (goldRecord.metadata && typeof goldRecord.metadata.quality_features === 'object' && goldRecord.metadata.quality_features) ||
        null,
    });

    const predictions = extractConcernsFromProviderRecord(record);
    const goldConcerns = extractConcernsFromGoldRecord(goldRecord);
    const matching = greedyMatchByType(predictions, goldConcerns, iouThreshold);

    for (let pIdx = 0; pIdx < predictions.length; pIdx += 1) {
      const pred = predictions[pIdx];
      rows.push({
        inference_id: inferenceId,
        provider,
        type: pred.type,
        quality_grade: qualityGrade,
        tone_bucket: toneBucket,
        lighting_bucket: lightingBucket,
        region_bucket: regionBucket,
        raw_confidence: round3(clamp01(pred.confidence)),
        raw_severity: round3(clampSeverity(pred.severity)),
        exposure_score: qualityFeatures.exposure_score,
        reflection_score: qualityFeatures.reflection_score,
        filter_score: qualityFeatures.filter_score,
        makeup_detected: qualityFeatures.makeup_detected,
        filter_detected: qualityFeatures.filter_detected,
        label: matching.matchedPred.has(pIdx) ? 1 : 0,
      });
    }
  }

  return rows;
}

function buildProviderPerformanceRows({ modelOutputs = [], goldLabels = [], iouThreshold = DEFAULT_MATCH_IOU } = {}) {
  const goldByInference = mapGoldByInference(goldLabels);
  const rows = [];

  for (const record of modelOutputs) {
    if (!record || typeof record !== 'object') continue;
    const inferenceId = String(record.inference_id || record.inferenceId || '').trim();
    if (!inferenceId) continue;
    const goldRecord = goldByInference.get(inferenceId);
    if (!goldRecord) continue;

    const provider = normalizeBucket(record.provider, 'unknown_provider');
    const qualityGrade = normalizeBucket(record.quality_grade, normalizeBucket(goldRecord.quality_grade, 'unknown'));
    const toneBucket = normalizeBucket(record.skin_tone_bucket, normalizeBucket(goldRecord.skin_tone_bucket, 'unknown'));

    const predictions = extractConcernsFromProviderRecord(record);
    const goldConcerns = extractConcernsFromGoldRecord(goldRecord);
    const matching = greedyMatchByType(predictions, goldConcerns, iouThreshold);

    const types = new Set();
    for (const pred of predictions) types.add(pred.type);
    for (const gold of goldConcerns) types.add(gold.type);

    for (const type of types) {
      const predIdxList = predictions
        .map((pred, idx) => ({ pred, idx }))
        .filter((entry) => entry.pred.type === type)
        .map((entry) => entry.idx);
      const goldIdxList = goldConcerns
        .map((gold, idx) => ({ gold, idx }))
        .filter((entry) => entry.gold.type === type)
        .map((entry) => entry.idx);

      let tp = 0;
      for (const idx of predIdxList) {
        if (matching.matchedPred.has(idx)) tp += 1;
      }
      const fp = Math.max(0, predIdxList.length - tp);
      let fn = 0;
      for (const idx of goldIdxList) {
        if (!matching.matchedGold.has(idx)) fn += 1;
      }

      rows.push({
        provider,
        type,
        quality_grade: qualityGrade,
        tone_bucket: toneBucket,
        tp,
        fp,
        fn,
      });
    }
  }

  return rows;
}

function fitIsotonicCalibrator(samples = []) {
  const points = samples
    .map((sample) => ({
      x: clamp01(sample.raw_confidence),
      y: clamp01(sample.label),
      w: Math.max(0.0001, Number(sample.weight || 1)),
    }))
    .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y))
    .sort((a, b) => a.x - b.x);

  if (!points.length) {
    return {
      kind: 'isotonic_step_v1',
      x: [0, 1],
      y: [0, 1],
      samples: 0,
    };
  }

  const blocks = [];
  for (const point of points) {
    blocks.push({
      xMin: point.x,
      xMax: point.x,
      sumY: point.y * point.w,
      sumW: point.w,
    });

    while (blocks.length > 1) {
      const curr = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      const currAvg = curr.sumY / curr.sumW;
      const prevAvg = prev.sumY / prev.sumW;
      if (prevAvg <= currAvg) break;
      prev.xMax = curr.xMax;
      prev.sumY += curr.sumY;
      prev.sumW += curr.sumW;
      blocks.pop();
    }
  }

  const x = [];
  const y = [];
  for (const block of blocks) {
    x.push(round3(block.xMax));
    y.push(round3(clamp01(block.sumY / Math.max(block.sumW, 0.0001))));
  }

  if (x[0] > 0) {
    x.unshift(0);
    y.unshift(y[0]);
  }
  if (x[x.length - 1] < 1) {
    x.push(1);
    y.push(y[y.length - 1]);
  }

  return {
    kind: 'isotonic_step_v1',
    x,
    y,
    samples: points.length,
  };
}

function predictIsotonic(calibrator, rawConfidence) {
  const safeRaw = clamp01(rawConfidence);
  if (!calibrator || !Array.isArray(calibrator.x) || !Array.isArray(calibrator.y)) return safeRaw;
  if (!calibrator.x.length || calibrator.x.length !== calibrator.y.length) return safeRaw;

  for (let i = 0; i < calibrator.x.length; i += 1) {
    if (safeRaw <= Number(calibrator.x[i])) return clamp01(calibrator.y[i]);
  }
  return clamp01(calibrator.y[calibrator.y.length - 1]);
}

function computeBrier(samples, selector) {
  if (!Array.isArray(samples) || !samples.length) return 0;
  const sum = samples.reduce((acc, sample) => {
    const prob = clamp01(selector(sample));
    const label = clamp01(sample.label);
    const diff = prob - label;
    return acc + diff * diff;
  }, 0);
  return round3(sum / samples.length);
}

function computeEce(samples, selector, binCount = 10) {
  if (!Array.isArray(samples) || !samples.length) return 0;
  const bins = new Array(Math.max(2, Math.trunc(binCount))).fill(0).map(() => ({ n: 0, conf: 0, acc: 0 }));

  for (const sample of samples) {
    const prob = clamp01(selector(sample));
    const label = clamp01(sample.label);
    const idx = Math.min(bins.length - 1, Math.floor(prob * bins.length));
    const bin = bins[idx];
    bin.n += 1;
    bin.conf += prob;
    bin.acc += label;
  }

  let ece = 0;
  const total = samples.length;
  for (const bin of bins) {
    if (!bin.n) continue;
    const meanConf = bin.conf / bin.n;
    const meanAcc = bin.acc / bin.n;
    ece += (bin.n / total) * Math.abs(meanConf - meanAcc);
  }
  return round3(ece);
}

function groupRows(rows, keyBuilder) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyBuilder(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function buildCalibrationGroupKey(row, level = 'provider_quality_tone') {
  const provider = normalizeBucket(row.provider, 'unknown_provider');
  const quality = normalizeBucket(row.quality_grade, 'unknown');
  const tone = normalizeBucket(row.tone_bucket, 'unknown');
  const lighting = normalizeBucket(row.lighting_bucket, 'unknown');
  const makeup = row.makeup_detected ? 'mk1' : 'mk0';
  const filter = row.filter_detected ? 'ft1' : 'ft0';

  if (level === 'provider_quality_tone_lighting_flags') return `${provider}|${quality}|${tone}|${lighting}|${makeup}|${filter}`;
  if (level === 'provider_quality_tone_lighting') return `${provider}|${quality}|${tone}|${lighting}`;
  if (level === 'provider_quality_tone') return `${provider}|${quality}|${tone}`;
  if (level === 'provider_quality') return `${provider}|${quality}`;
  if (level === 'provider') return provider;
  return 'global';
}

function learnProviderWeights(perfRows, { minSamples = DEFAULT_MIN_GROUP_SAMPLES } = {}) {
  const aggByProvider = new Map();
  const aggByBucket = new Map();

  for (const row of perfRows) {
    const provider = normalizeBucket(row.provider, 'unknown_provider');
    const keyProvider = provider;
    const keyBucket = `${provider}|${normalizeBucket(row.type, 'other')}|${normalizeBucket(row.quality_grade, 'unknown')}|${normalizeBucket(
      row.tone_bucket,
      'unknown',
    )}`;

    const update = (map, key) => {
      const cur = map.get(key) || { tp: 0, fp: 0, fn: 0 };
      cur.tp += Math.max(0, Number(row.tp || 0));
      cur.fp += Math.max(0, Number(row.fp || 0));
      cur.fn += Math.max(0, Number(row.fn || 0));
      map.set(key, cur);
    };

    update(aggByProvider, keyProvider);
    update(aggByBucket, keyBucket);
  }

  const scoreToWeight = (tp, fp, fn) => {
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return round3(clamp(0.25 + 1.75 * f1, 0.25, 2.25));
  };

  const byProvider = {};
  for (const [provider, stats] of aggByProvider.entries()) {
    byProvider[provider] = scoreToWeight(stats.tp, stats.fp, stats.fn);
  }

  const byBucket = {};
  for (const [bucket, stats] of aggByBucket.entries()) {
    const samples = stats.tp + stats.fp + stats.fn;
    if (samples < minSamples) continue;
    byBucket[bucket] = {
      weight: scoreToWeight(stats.tp, stats.fp, stats.fn),
      samples,
      tp: stats.tp,
      fp: stats.fp,
      fn: stats.fn,
    };
  }

  return {
    default: 1,
    by_provider: byProvider,
    by_bucket: byBucket,
  };
}

function trainCalibrationModel({
  modelOutputs = [],
  goldLabels = [],
  options = {},
} = {}) {
  const iouThreshold = clamp(Number(options.iou_threshold || DEFAULT_MATCH_IOU), 0.05, 0.95);
  const minGroupSamples = Math.max(8, Math.trunc(Number(options.min_group_samples || DEFAULT_MIN_GROUP_SAMPLES)));

  const rows = buildTrainingRows({ modelOutputs, goldLabels, iouThreshold });
  const perfRows = buildProviderPerformanceRows({ modelOutputs, goldLabels, iouThreshold });

  const globalCalibrator = fitIsotonicCalibrator(rows);
  const byProvider = {};
  const byGroup = {};

  const providerGroups = groupRows(rows, (row) => buildCalibrationGroupKey(row, 'provider'));
  for (const [provider, samples] of providerGroups.entries()) {
    if (samples.length < minGroupSamples) continue;
    byProvider[provider] = fitIsotonicCalibrator(samples);
  }

  const levels = [
    'provider_quality_tone_lighting_flags',
    'provider_quality_tone_lighting',
    'provider_quality_tone',
    'provider_quality',
  ];
  for (const level of levels) {
    const groups = groupRows(rows, (row) => buildCalibrationGroupKey(row, level));
    for (const [key, samples] of groups.entries()) {
      if (samples.length < minGroupSamples) continue;
      byGroup[key] = fitIsotonicCalibrator(samples);
    }
  }

  const rawEce = computeEce(rows, (row) => row.raw_confidence, 10);
  const rawBrier = computeBrier(rows, (row) => row.raw_confidence);

  const model = {
    schema_version: CALIBRATION_SCHEMA_VERSION,
    model_version: `${DEFAULT_MODEL_VERSION_PREFIX}_${isoNow().replace(/[^0-9]/g, '').slice(0, 14)}`,
    created_at: isoNow(),
    training: {
      samples_total: rows.length,
      iou_threshold: round3(iouThreshold),
      min_group_samples: minGroupSamples,
      baseline_metrics: {
        ece: rawEce,
        brier: rawBrier,
      },
      feature_fields: [
        'raw_confidence',
        'exposure_score',
        'reflection_score',
        'filter_score',
        'tone_bucket',
        'lighting_bucket',
        'makeup_detected',
        'filter_detected',
      ],
    },
    calibration: {
      global: globalCalibrator,
      by_provider: byProvider,
      by_group: byGroup,
      hierarchy: [
        'provider_quality_tone_lighting_flags',
        'provider_quality_tone_lighting',
        'provider_quality_tone',
        'provider_quality',
        'provider',
        'global',
      ],
    },
    provider_weights: learnProviderWeights(perfRows, { minSamples: minGroupSamples }),
    severity_smoothing: {
      min_scale: 0.72,
      max_scale: 1,
      confidence_gamma: 1,
    },
    feature_defaults: {
      tone_bucket: 'unknown',
      lighting_bucket: 'unknown',
      region_bucket: 'unknown',
      quality_grade: 'unknown',
    },
  };

  const calibratedRows = rows.map((row) => ({
    ...row,
    calibrated_confidence: calibrateConfidence(model, {
      provider: row.provider,
      qualityGrade: row.quality_grade,
      toneBucket: row.tone_bucket,
      lightingBucket: row.lighting_bucket,
      qualityFeatures: {
        exposure_score: row.exposure_score,
        reflection_score: row.reflection_score,
        filter_score: row.filter_score,
        makeup_detected: row.makeup_detected,
        filter_detected: row.filter_detected,
      },
      rawConfidence: row.raw_confidence,
    }),
  }));

  model.training.calibrated_metrics = {
    ece: computeEce(calibratedRows, (row) => row.calibrated_confidence, 10),
    brier: computeBrier(calibratedRows, (row) => row.calibrated_confidence),
  };

  return { model, rows, calibratedRows, perfRows };
}

function resolveCalibrator(model, context = {}) {
  const provider = normalizeBucket(context.provider, 'unknown_provider');
  const quality = normalizeBucket(context.qualityGrade || context.quality_grade, 'unknown');
  const tone = normalizeBucket(context.toneBucket || context.tone_bucket, 'unknown');
  const lighting = normalizeBucket(context.lightingBucket || context.lighting_bucket, 'unknown');
  const makeup = context.qualityFeatures?.makeup_detected ? 'mk1' : 'mk0';
  const filter = context.qualityFeatures?.filter_detected ? 'ft1' : 'ft0';

  const byGroup = model?.calibration?.by_group && typeof model.calibration.by_group === 'object' ? model.calibration.by_group : {};
  const byProvider = model?.calibration?.by_provider && typeof model.calibration.by_provider === 'object' ? model.calibration.by_provider : {};

  const candidates = [
    `${provider}|${quality}|${tone}|${lighting}|${makeup}|${filter}`,
    `${provider}|${quality}|${tone}|${lighting}`,
    `${provider}|${quality}|${tone}`,
    `${provider}|${quality}`,
  ];
  for (const key of candidates) {
    if (byGroup[key]) return byGroup[key];
  }
  if (byProvider[provider]) return byProvider[provider];
  return model?.calibration?.global || null;
}

function applyQualityAdjustment(calibrated, qualityFeatures = {}) {
  const q = normalizeQualityFeatures(qualityFeatures);
  let factor = 1;
  factor += (q.exposure_score - 0.5) * 0.1;
  factor -= q.reflection_score * 0.12;
  factor -= q.filter_score * 0.16;
  if (q.makeup_detected) factor -= 0.05;
  if (q.filter_detected) factor -= 0.06;
  return clamp01(calibrated * clamp(factor, 0.55, 1.12));
}

function calibrateConfidence(model, {
  provider,
  qualityGrade,
  toneBucket,
  lightingBucket,
  qualityFeatures,
  rawConfidence,
} = {}) {
  const safeRaw = clamp01(rawConfidence);
  if (!model || model.schema_version !== CALIBRATION_SCHEMA_VERSION) return round3(safeRaw);
  const calibrator = resolveCalibrator(model, {
    provider,
    qualityGrade,
    toneBucket,
    lightingBucket,
    qualityFeatures,
  });
  const isotonic = predictIsotonic(calibrator, safeRaw);
  return round3(applyQualityAdjustment(isotonic, qualityFeatures));
}

function resolveProviderWeight(model, {
  provider,
  type,
  qualityGrade,
  toneBucket,
} = {}) {
  const safeProvider = normalizeBucket(provider, 'unknown_provider');
  const safeType = normalizeConcernType(type);
  const safeQuality = normalizeBucket(qualityGrade, 'unknown');
  const safeTone = normalizeBucket(toneBucket, 'unknown');

  const providerWeights = model?.provider_weights || {};
  const bucketKey = `${safeProvider}|${safeType}|${safeQuality}|${safeTone}`;
  const bucket = providerWeights.by_bucket && providerWeights.by_bucket[bucketKey];
  if (bucket && Number.isFinite(Number(bucket.weight))) return clamp(Number(bucket.weight), 0.2, 2.5);

  if (providerWeights.by_provider && Number.isFinite(Number(providerWeights.by_provider[safeProvider]))) {
    return clamp(Number(providerWeights.by_provider[safeProvider]), 0.2, 2.5);
  }
  return clamp(Number(providerWeights.default || 1), 0.2, 2.5);
}

function smoothSeverity(model, { severity, calibratedConfidence } = {}) {
  const safeSeverity = clampSeverity(severity);
  const safeConfidence = clamp01(calibratedConfidence);
  if (!model || model.schema_version !== CALIBRATION_SCHEMA_VERSION) return round3(safeSeverity);
  const smoothing = model.severity_smoothing || {};
  const minScale = clamp(Number(smoothing.min_scale || 0.72), 0.5, 1);
  const maxScale = clamp(Number(smoothing.max_scale || 1), minScale, 1.2);
  const gamma = clamp(Number(smoothing.confidence_gamma || 1), 0.5, 2);
  const confidenceTerm = safeConfidence ** gamma;
  const scale = minScale + (maxScale - minScale) * confidenceTerm;
  return round3(clampSeverity(safeSeverity * scale));
}

function defaultCalibrationModel() {
  return {
    schema_version: CALIBRATION_SCHEMA_VERSION,
    model_version: `${DEFAULT_MODEL_VERSION_PREFIX}_identity`,
    created_at: '1970-01-01T00:00:00.000Z',
    training: {
      samples_total: 0,
      iou_threshold: DEFAULT_MATCH_IOU,
      min_group_samples: DEFAULT_MIN_GROUP_SAMPLES,
      baseline_metrics: { ece: 0, brier: 0 },
      calibrated_metrics: { ece: 0, brier: 0 },
      feature_fields: [
        'raw_confidence',
        'exposure_score',
        'reflection_score',
        'filter_score',
        'tone_bucket',
        'lighting_bucket',
        'makeup_detected',
        'filter_detected',
      ],
    },
    calibration: {
      global: { kind: 'isotonic_step_v1', x: [0, 1], y: [0, 1], samples: 0 },
      by_provider: {},
      by_group: {},
      hierarchy: [
        'provider_quality_tone_lighting_flags',
        'provider_quality_tone_lighting',
        'provider_quality_tone',
        'provider_quality',
        'provider',
        'global',
      ],
    },
    provider_weights: {
      default: 1,
      by_provider: {},
      by_bucket: {},
    },
    severity_smoothing: {
      min_scale: 0.72,
      max_scale: 1,
      confidence_gamma: 1,
    },
    feature_defaults: {
      tone_bucket: 'unknown',
      lighting_bucket: 'unknown',
      region_bucket: 'unknown',
      quality_grade: 'unknown',
    },
  };
}

function loadCalibrationModelFromPath(modelPath) {
  const defaultModel = defaultCalibrationModel();
  try {
    const resolvedPath = String(modelPath || '').trim() || defaultModelPath(process.cwd());
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema_version !== CALIBRATION_SCHEMA_VERSION) {
      return { model: defaultModel, source: 'default_fallback', error: 'SCHEMA_MISMATCH' };
    }
    return { model: parsed, source: resolvedPath, error: null };
  } catch (err) {
    return {
      model: defaultModel,
      source: 'default_fallback',
      error: err && err.code ? err.code : 'LOAD_FAILED',
    };
  }
}

let runtimeCache = null;

function loadCalibrationRuntime({ enabled, modelPath, forceReload = false } = {}) {
  const isEnabled = enabled == null ? parseBool(process.env.DIAG_CALIBRATION_ENABLED, false) : Boolean(enabled);
  if (!isEnabled) return { enabled: false, model: null, source: null, error: null };

  const explicitPath = String(modelPath || process.env.DIAG_CALIBRATION_MODEL_PATH || '').trim();
  const useLatestVersion = parseBool(process.env.DIAG_CALIBRATION_USE_LATEST_VERSION, true);
  const resolvedPath = explicitPath || (useLatestVersion ? findLatestCalibratorModel(process.cwd()) : null) || defaultModelPath(process.cwd());
  if (!forceReload && runtimeCache && runtimeCache.path === resolvedPath) {
    return { enabled: true, model: runtimeCache.model, source: runtimeCache.source, error: runtimeCache.error };
  }

  const loaded = loadCalibrationModelFromPath(resolvedPath);
  runtimeCache = {
    path: resolvedPath,
    model: loaded.model,
    source: loaded.source,
    error: loaded.error,
  };
  return { enabled: true, model: loaded.model, source: loaded.source, error: loaded.error };
}

function computeGroupedEce(rows, selector, groupFields = []) {
  const out = {};
  if (!Array.isArray(rows) || !rows.length) return out;
  const groups = new Map();
  for (const row of rows) {
    const key = groupFields.map((field) => normalizeBucket(row[field], 'unknown')).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [key, samples] of groups.entries()) {
    out[key] = {
      samples: samples.length,
      ece: computeEce(samples, selector, 10),
      brier: computeBrier(samples, selector),
    };
  }
  return out;
}

module.exports = {
  CALIBRATION_SCHEMA_VERSION,
  DEFAULT_MODEL_RELATIVE_PATH,
  DEFAULT_MATCH_IOU,
  DEFAULT_MIN_GROUP_SAMPLES,
  clamp01,
  clampSeverity,
  round3,
  iou,
  normalizeConcernType,
  normalizeQualityFeatures,
  buildTrainingRows,
  buildProviderPerformanceRows,
  fitIsotonicCalibrator,
  predictIsotonic,
  computeEce,
  computeBrier,
  computeGroupedEce,
  trainCalibrationModel,
  calibrateConfidence,
  resolveProviderWeight,
  smoothSeverity,
  defaultCalibrationModel,
  defaultModelPath,
  findLatestCalibratorModel,
  loadCalibrationModelFromPath,
  loadCalibrationRuntime,
};
