#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {
    modelOutputs: '',
    goldLabels: '',
    iouThreshold: '',
    outJson: '',
    outCsv: '',
    outMd: '',
    providers: '',
    allowEmptyGold: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    index += 1;
  }
  return out;
}

function clamp(value, min, max, fallback = min) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function clamp01(value, fallback = 0) {
  return clamp(value, 0, 1, fallback);
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function parseBoolFlag(value, defaultValue = false) {
  const token = normalizeToken(value);
  if (!token) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return defaultValue;
}

function normalizeBucket(value, fallback = 'unknown') {
  const token = normalizeToken(value);
  return token || fallback;
}

function normalizeConcernType(rawType) {
  const token = normalizeToken(rawType);
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
  return {
    x0: round3(minX),
    y0: round3(minY),
    x1: round3(maxX),
    y1: round3(maxY),
  };
}

function bboxFromPolygon(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let hasPoint = false;
  for (const point of points) {
    if (!point || typeof point !== 'object') continue;
    const x = clamp01(point.x);
    const y = clamp01(point.y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    hasPoint = true;
  }
  if (!hasPoint) return null;
  return normalizeBBox({ x0: minX, y0: minY, x1: maxX, y1: maxY });
}

function bboxFromHeatmap(region) {
  if (!region || typeof region !== 'object') return null;
  const rows = Math.max(1, Math.min(128, Math.trunc(Number(region.rows) || 0)));
  const cols = Math.max(1, Math.min(128, Math.trunc(Number(region.cols) || 0)));
  const values = Array.isArray(region.values) ? region.values.map((value) => clamp01(value)) : [];
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

  if (concern.region_hint_bbox && typeof concern.region_hint_bbox === 'object') {
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

function inferModuleProxy(concern, bbox) {
  if (concern && typeof concern === 'object') {
    const fromConcern = normalizeToken(concern.module_id || concern.module || concern.region_id);
    if (fromConcern) return fromConcern;
  }
  if (!bbox) return 'unknown';

  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;

  if (cy < 0.28) return 'forehead';
  if (cy > 0.78) return 'chin';

  if (cy < 0.52) {
    if (cx < 0.4) return 'under_eye_left';
    if (cx > 0.6) return 'under_eye_right';
    return 'nose';
  }

  if (cx < 0.45) return 'left_cheek';
  if (cx > 0.55) return 'right_cheek';
  return 'nose';
}

function readNdjson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return [];
  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch (_err) {
      // Ignore malformed lines.
    }
  }
  return out;
}

function writeText(filePath, content) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  return resolved;
}

function mapGoldByInference(goldRows) {
  const out = new Map();
  for (const row of Array.isArray(goldRows) ? goldRows : []) {
    if (!row || typeof row !== 'object') continue;
    const qaStatus = normalizeToken(row.qa_status || row.status || row.label_status || 'approved');
    if (qaStatus && !['approved', 'gold', 'accepted'].includes(qaStatus)) continue;
    const inferenceId = String(row.inference_id || row.inferenceId || row.trace_id || '').trim();
    if (!inferenceId) continue;
    out.set(inferenceId, row);
  }
  return out;
}

function normalizeConcernsFromProviderRecord(record) {
  const concernsRaw =
    (record && record.output_json && Array.isArray(record.output_json.concerns) && record.output_json.concerns) ||
    (record && Array.isArray(record.concerns) && record.concerns) ||
    [];

  const out = [];
  for (const concern of concernsRaw) {
    if (!concern || typeof concern !== 'object') continue;
    const bbox = extractPrimaryBBox(concern);
    out.push({
      type: normalizeConcernType(concern.type),
      confidence: round3(clamp01(concern.confidence)),
      bbox,
      module_proxy: inferModuleProxy(concern, bbox),
    });
  }
  return out;
}

function normalizeConcernsFromGoldRecord(row) {
  const concernsRaw =
    (row && Array.isArray(row.concerns) && row.concerns) ||
    (row && row.canonical && Array.isArray(row.canonical.concerns) && row.canonical.concerns) ||
    (row && row.output_json && Array.isArray(row.output_json.concerns) && row.output_json.concerns) ||
    [];

  const out = [];
  for (const concern of concernsRaw) {
    if (!concern || typeof concern !== 'object') continue;
    const bbox = extractPrimaryBBox(concern);
    out.push({
      type: normalizeConcernType(concern.type),
      confidence: 1,
      bbox,
      module_proxy: inferModuleProxy(concern, bbox),
    });
  }
  return out;
}

function createCounter() {
  return {
    samples: 0,
    pred_count: 0,
    gold_count: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    matched_ious: [],
  };
}

function addMatchIou(counter, value) {
  if (!counter || !Number.isFinite(value)) return;
  counter.matched_ious.push(round3(value));
}

function getOrCreate(map, key) {
  if (!map.has(key)) map.set(key, createCounter());
  return map.get(key);
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return round3(sorted[idx]);
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return round3(numerator / denominator);
}

function finalizeCounter(counter) {
  const precision = counter.tp + counter.fp > 0 ? counter.tp / (counter.tp + counter.fp) : 0;
  const recall = counter.tp + counter.fn > 0 ? counter.tp / (counter.tp + counter.fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  let meanIou = null;
  if (counter.matched_ious.length) {
    const sum = counter.matched_ious.reduce((acc, value) => acc + value, 0);
    meanIou = round3(sum / counter.matched_ious.length);
  }

  return {
    samples: counter.samples,
    pred_count: counter.pred_count,
    gold_count: counter.gold_count,
    tp: counter.tp,
    fp: counter.fp,
    fn: counter.fn,
    precision: round3(precision),
    recall: round3(recall),
    f1: round3(f1),
    mean_iou: meanIou,
    p50_iou: percentile(counter.matched_ious, 0.5),
    p90_iou: percentile(counter.matched_ious, 0.9),
    matched_count: counter.matched_ious.length,
  };
}

function toRows(metricMap, scope) {
  const rows = [];
  for (const [key, counter] of metricMap.entries()) {
    rows.push({ scope, key, ...finalizeCounter(counter) });
  }
  rows.sort((a, b) => {
    if (b.f1 !== a.f1) return b.f1 - a.f1;
    if (b.recall !== a.recall) return b.recall - a.recall;
    return String(a.key).localeCompare(String(b.key));
  });
  return rows;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(allRows) {
  const headers = [
    'scope',
    'key',
    'samples',
    'pred_count',
    'gold_count',
    'tp',
    'fp',
    'fn',
    'precision',
    'recall',
    'f1',
    'mean_iou',
    'p50_iou',
    'p90_iou',
    'matched_count',
  ];
  const lines = [headers.join(',')];
  for (const row of allRows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function markdownTable(headers, rows) {
  const line1 = `| ${headers.join(' | ')} |`;
  const line2 = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((value) => String(value == null ? '' : value)).join(' | ')} |`);
  return [line1, line2, ...body].join('\n');
}

function topLowRecall(rows, limit = 5) {
  return rows
    .filter((row) => row.scope === 'type' && row.gold_count >= 3)
    .sort((a, b) => a.recall - b.recall || b.gold_count - a.gold_count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

function buildMarkdown({
  generatedAt,
  iouThreshold,
  providerFilter,
  inputCounts,
  overall,
  byType,
  byModule,
  byProvider,
  lowRecall,
  paths,
}) {
  const overallRows = [[
    overall.samples,
    overall.pred_count,
    overall.gold_count,
    overall.tp,
    overall.fp,
    overall.fn,
    overall.precision,
    overall.recall,
    overall.f1,
    overall.mean_iou,
    overall.p50_iou,
    overall.p90_iou,
  ]];

  const typeRows = byType.slice(0, 12).map((row) => [
    row.key,
    row.gold_count,
    row.pred_count,
    row.tp,
    row.fp,
    row.fn,
    row.precision,
    row.recall,
    row.f1,
    row.mean_iou,
  ]);

  const moduleRows = byModule.slice(0, 12).map((row) => [
    row.key,
    row.gold_count,
    row.pred_count,
    row.tp,
    row.fp,
    row.fn,
    row.precision,
    row.recall,
    row.f1,
    row.mean_iou,
  ]);

  const providerRows = byProvider.map((row) => [
    row.key,
    row.samples,
    row.gold_count,
    row.pred_count,
    row.precision,
    row.recall,
    row.f1,
    row.mean_iou,
  ]);

  const lowRecallRows = lowRecall.map((row) => [
    row.key,
    row.gold_count,
    row.recall,
    row.f1,
    row.mean_iou,
    'add more positive samples and review bbox consistency for this issue type',
  ]);

  const lines = [
    '# Region Accuracy Evaluation (Internal Gold Labels)',
    '',
    `- generated_at_utc: ${generatedAt}`,
    `- iou_threshold: ${iouThreshold}`,
    `- provider_filter: ${providerFilter || 'all'}`,
    `- model_outputs_total: ${inputCounts.model_outputs_total}`,
    `- gold_labels_total: ${inputCounts.gold_labels_total}`,
    `- matched_inference_total: ${inputCounts.matched_inference_total}`,
    '',
    '## Overall',
    '',
    markdownTable(
      ['samples', 'pred', 'gold', 'tp', 'fp', 'fn', 'precision', 'recall', 'f1', 'mean_iou', 'p50_iou', 'p90_iou'],
      overallRows,
    ),
    '',
    `- detection_rate(tp/gold): ${ratio(overall.tp, overall.gold_count)}`,
    `- false_positive_rate(fp/pred): ${ratio(overall.fp, overall.pred_count)}`,
    '',
    '## By Type (Top 12 by F1)',
    '',
    typeRows.length
      ? markdownTable(['type', 'gold', 'pred', 'tp', 'fp', 'fn', 'precision', 'recall', 'f1', 'mean_iou'], typeRows)
      : '_No type rows._',
    '',
    '## By Module Proxy (Top 12 by F1)',
    '',
    moduleRows.length
      ? markdownTable(['module_proxy', 'gold', 'pred', 'tp', 'fp', 'fn', 'precision', 'recall', 'f1', 'mean_iou'], moduleRows)
      : '_No module rows._',
    '',
    '## By Provider',
    '',
    providerRows.length
      ? markdownTable(['provider', 'samples', 'gold', 'pred', 'precision', 'recall', 'f1', 'mean_iou'], providerRows)
      : '_No provider rows._',
    '',
    '## Targeted Follow-ups',
    '',
    lowRecallRows.length
      ? markdownTable(['type', 'gold', 'recall', 'f1', 'mean_iou', 'action'], lowRecallRows)
      : '_No low-recall type reached minimum support (gold>=3)._',
    '',
    '## Artifacts',
    '',
    `- json: ${paths.outJson}`,
    `- csv: ${paths.outCsv}`,
    `- md: ${paths.outMd}`,
    '',
  ];

  return `${lines.join('\n')}\n`;
}

function evaluate({ modelOutputs, goldLabels, iouThreshold, providers }) {
  const providerSet = new Set(
    String(providers || '')
      .split(',')
      .map((token) => normalizeToken(token))
      .filter(Boolean),
  );
  const goldByInference = mapGoldByInference(goldLabels);

  const overallCounter = createCounter();
  const typeCounters = new Map();
  const moduleCounters = new Map();
  const providerCounters = new Map();

  let matchedInferenceTotal = 0;

  for (const record of Array.isArray(modelOutputs) ? modelOutputs : []) {
    if (!record || typeof record !== 'object') continue;

    const provider = normalizeBucket(record.provider, 'unknown_provider');
    if (providerSet.size && !providerSet.has(provider)) continue;

    const inferenceId = String(record.inference_id || record.inferenceId || '').trim();
    if (!inferenceId) continue;

    const gold = goldByInference.get(inferenceId);
    if (!gold) continue;

    const preds = normalizeConcernsFromProviderRecord(record);
    const golds = normalizeConcernsFromGoldRecord(gold);

    matchedInferenceTotal += 1;

    const providerCounter = getOrCreate(providerCounters, provider);
    providerCounter.samples += 1;

    overallCounter.samples += 1;
    overallCounter.pred_count += preds.length;
    overallCounter.gold_count += golds.length;
    providerCounter.pred_count += preds.length;
    providerCounter.gold_count += golds.length;

    const matchedPred = new Set();
    const matchedGold = new Set();

    for (let pIdx = 0; pIdx < preds.length; pIdx += 1) {
      const pred = preds[pIdx];
      let bestG = -1;
      let bestIou = 0;
      for (let gIdx = 0; gIdx < golds.length; gIdx += 1) {
        if (matchedGold.has(gIdx)) continue;
        const goldConcern = golds[gIdx];
        if (pred.type !== goldConcern.type) continue;
        const overlap = iou(pred.bbox, goldConcern.bbox);
        if (overlap >= iouThreshold && overlap > bestIou) {
          bestIou = overlap;
          bestG = gIdx;
        }
      }
      if (bestG >= 0) {
        matchedPred.add(pIdx);
        matchedGold.add(bestG);

        overallCounter.tp += 1;
        providerCounter.tp += 1;
        addMatchIou(overallCounter, bestIou);
        addMatchIou(providerCounter, bestIou);

        const predTypeCounter = getOrCreate(typeCounters, pred.type);
        predTypeCounter.samples += 1;
        predTypeCounter.pred_count += 1;
        predTypeCounter.gold_count += 1;
        predTypeCounter.tp += 1;
        addMatchIou(predTypeCounter, bestIou);

        const predModuleCounter = getOrCreate(moduleCounters, pred.module_proxy);
        predModuleCounter.samples += 1;
        predModuleCounter.pred_count += 1;
        predModuleCounter.gold_count += 1;
        predModuleCounter.tp += 1;
        addMatchIou(predModuleCounter, bestIou);
      }
    }

    for (let pIdx = 0; pIdx < preds.length; pIdx += 1) {
      const pred = preds[pIdx];
      const typeCounter = getOrCreate(typeCounters, pred.type);
      const moduleCounter = getOrCreate(moduleCounters, pred.module_proxy);

      if (!matchedPred.has(pIdx)) {
        overallCounter.fp += 1;
        providerCounter.fp += 1;
        typeCounter.fp += 1;
        moduleCounter.fp += 1;
      }

      typeCounter.pred_count += 1;
      moduleCounter.pred_count += 1;
      typeCounter.samples += 1;
      moduleCounter.samples += 1;
    }

    for (let gIdx = 0; gIdx < golds.length; gIdx += 1) {
      const goldConcern = golds[gIdx];
      const typeCounter = getOrCreate(typeCounters, goldConcern.type);
      const moduleCounter = getOrCreate(moduleCounters, goldConcern.module_proxy);

      typeCounter.gold_count += 1;
      moduleCounter.gold_count += 1;

      if (!matchedGold.has(gIdx)) {
        overallCounter.fn += 1;
        providerCounter.fn += 1;
        typeCounter.fn += 1;
        moduleCounter.fn += 1;
      }

      typeCounter.samples += 1;
      moduleCounter.samples += 1;
    }
  }

  const overall = finalizeCounter(overallCounter);
  const byType = toRows(typeCounters, 'type');
  const byModule = toRows(moduleCounters, 'module_proxy');
  const byProvider = toRows(providerCounters, 'provider');

  const allRows = [
    { scope: 'overall', key: 'overall', ...overall },
    ...byType,
    ...byModule,
    ...byProvider,
  ];

  return {
    iou_threshold: iouThreshold,
    provider_filter: providerSet.size ? Array.from(providerSet) : null,
    input_counts: {
      model_outputs_total: Array.isArray(modelOutputs) ? modelOutputs.length : 0,
      gold_labels_total: Array.isArray(goldLabels) ? goldLabels.length : 0,
      matched_inference_total: matchedInferenceTotal,
    },
    overall,
    by_type: byType,
    by_module_proxy: byModule,
    by_provider: byProvider,
    rows_for_csv: allRows,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const allowEmptyGold = parseBoolFlag(args.allowEmptyGold, false);

  const modelOutputsPath = String(args.modelOutputs || path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson')).trim();
  const goldLabelsPath = String(args.goldLabels || path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson')).trim();
  const iouThreshold = clamp(args.iouThreshold, 0.05, 0.95, 0.3);

  const outJson = String(args.outJson || path.join(root, 'reports', 'region_accuracy_eval.json')).trim();
  const outCsv = String(args.outCsv || path.join(root, 'reports', 'region_accuracy_eval.csv')).trim();
  const outMd = String(args.outMd || path.join(root, 'reports', 'region_accuracy_eval.md')).trim();

  const modelOutputs = readNdjson(modelOutputsPath);
  const goldLabels = readNdjson(goldLabelsPath);
  const generatedAt = new Date().toISOString();
  const hasGoldFile = fs.existsSync(path.resolve(goldLabelsPath));

  if (!allowEmptyGold && !hasGoldFile) {
    const payload = {
      ok: false,
      generated_at: generatedAt,
      error: {
        code: 'GOLD_LABELS_MISSING',
        detail: `gold labels file not found: ${path.resolve(goldLabelsPath)}`,
        hint: 'import labels first (make gold-label-import ...) or use --allowEmptyGold true for dry-run',
      },
    };
    process.stderr.write(`[region_accuracy_eval] ${payload.error.code}: ${payload.error.detail}\n`);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  if (!allowEmptyGold && goldLabels.length === 0) {
    const payload = {
      ok: false,
      generated_at: generatedAt,
      error: {
        code: 'GOLD_LABELS_EMPTY',
        detail: `gold labels parsed as empty: ${path.resolve(goldLabelsPath)}`,
        hint: 'import approved labels first (make gold-label-import ...) or use --allowEmptyGold true for dry-run',
      },
    };
    process.stderr.write(`[region_accuracy_eval] ${payload.error.code}: ${payload.error.detail}\n`);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 3;
    return;
  }

  const result = evaluate({
    modelOutputs,
    goldLabels,
    iouThreshold,
    providers: args.providers,
  });

  const lowRecall = topLowRecall(result.rows_for_csv, 5);

  const payload = {
    generated_at: generatedAt,
    model_outputs_path: path.resolve(modelOutputsPath),
    gold_labels_path: path.resolve(goldLabelsPath),
    ...result,
  };

  const csvText = buildCsv(result.rows_for_csv);
  const mdText = buildMarkdown({
    generatedAt,
    iouThreshold,
    providerFilter: result.provider_filter ? result.provider_filter.join(',') : '',
    inputCounts: result.input_counts,
    overall: result.overall,
    byType: result.by_type,
    byModule: result.by_module_proxy,
    byProvider: result.by_provider,
    lowRecall,
    paths: {
      outJson: path.relative(root, outJson),
      outCsv: path.relative(root, outCsv),
      outMd: path.relative(root, outMd),
    },
  });

  writeText(outJson, `${JSON.stringify(payload, null, 2)}\n`);
  writeText(outCsv, csvText);
  writeText(outMd, mdText);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    generated_at: generatedAt,
    iou_threshold: iouThreshold,
    matched_inference_total: result.input_counts.matched_inference_total,
    overall: result.overall,
    output: {
      json: path.resolve(outJson),
      csv: path.resolve(outCsv),
      md: path.resolve(outMd),
    },
  }, null, 2)}\n`);
}

main();
