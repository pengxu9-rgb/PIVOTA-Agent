#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TASK_SCHEMA_VERSION = 'aurora.diag.gold_label_task.v1';

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function normalizeBucket(value, fallback = 'unknown') {
  const token = normalizeToken(value);
  return token || fallback;
}

function parseBool(value, fallback = false) {
  const token = normalizeToken(value);
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function parseArgs(argv) {
  const out = {
    hardCases: '',
    modelOutputs: '',
    out: '',
    date: '',
    total: '',
    hardRatio: '',
    quotaFile: '',
    allowRoi: '',
    seed: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    const next = argv[index + 1];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    index += 1;
  }
  return out;
}

function dateKeyFromInput(raw) {
  const token = String(raw || '').trim();
  if (!token) {
    const now = new Date();
    return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  }
  if (/^\d{8}$/.test(token)) return token;
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token.replace(/-/g, '');
  throw new Error(`invalid --date: ${token}`);
}

function datePrefix(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function readJsonMaybe(filePath) {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
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

function writeNdjson(filePath, rows) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  fs.writeFileSync(resolved, payload, 'utf8');
  return resolved;
}

function randomFromSeed(seedRaw) {
  let state = clampInt(seedRaw, 88675123, 1, 2147483647);
  return () => {
    state = (Math.imul(state, 48271) + 0x12345) % 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function shuffleWithSeed(list, seedRaw) {
  const out = Array.isArray(list) ? list.slice() : [];
  const random = randomFromSeed(seedRaw);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const tmp = out[index];
    out[index] = out[swapIndex];
    out[swapIndex] = tmp;
  }
  return out;
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
    sensitivity: 'barrier',
  };
  return aliases[token] || 'other';
}

function normalizeQuotaMap(raw, fallbackLimit = Infinity) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const bucket = normalizeBucket(key, '');
    if (!bucket) continue;
    const limit = Number(value);
    out[bucket] = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : fallbackLimit;
  }
  return out;
}

function loadQuotaConfig(args) {
  const defaults = {
    total: 500,
    hard_case_ratio: 0.6,
    tone_quota: {},
    lighting_quota: {},
    region_quota: {},
  };
  if (!args.quotaFile) return defaults;
  const loaded = readJsonMaybe(args.quotaFile);
  return {
    total: clampInt(loaded.total, defaults.total, 1, 50000),
    hard_case_ratio: Math.max(0, Math.min(1, Number(loaded.hard_case_ratio == null ? defaults.hard_case_ratio : loaded.hard_case_ratio))),
    tone_quota: normalizeQuotaMap(loaded.tone_quota),
    lighting_quota: normalizeQuotaMap(loaded.lighting_quota),
    region_quota: normalizeQuotaMap(loaded.region_quota),
  };
}

function quotaAllows(bucketCounts, quotaMap, bucket) {
  if (!quotaMap || typeof quotaMap !== 'object' || !Object.keys(quotaMap).length) return true;
  const key = normalizeBucket(bucket, 'unknown');
  const limit = Number.isFinite(Number(quotaMap[key])) ? Number(quotaMap[key]) : Number(quotaMap.unknown);
  if (!Number.isFinite(limit)) return true;
  const current = Number(bucketCounts[key] || 0);
  return current < Math.max(0, limit);
}

function addBucketCount(bucketCounts, bucket) {
  const key = normalizeBucket(bucket, 'unknown');
  bucketCounts[key] = Number(bucketCounts[key] || 0) + 1;
}

function extractDateFiltered(rows, dayPrefix) {
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row?.created_at || '').startsWith(dayPrefix));
}

function groupModelOutputsByInference(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const inferenceId = String(row?.inference_id || '').trim();
    if (!inferenceId) continue;
    if (!map.has(inferenceId)) map.set(inferenceId, []);
    map.get(inferenceId).push(row);
  }
  return map;
}

function hashToken(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractModelOutputCandidate(inferenceId, rows) {
  const sorted = safeArray(rows).slice().sort((left, right) => String(right?.created_at || '').localeCompare(String(left?.created_at || '')));
  const first = sorted[0] || {};
  const concerns = [];
  for (const row of sorted) {
    const outputJson = row && typeof row.output_json === 'object' ? row.output_json : {};
    const list = Array.isArray(outputJson.concerns) ? outputJson.concerns : [];
    for (const concern of list) {
      if (!concern || typeof concern !== 'object') continue;
      concerns.push(concern);
    }
  }
  const concernTypes = Array.from(new Set(concerns.map((concern) => normalizeConcernType(concern.type)))).filter(Boolean);
  return {
    source: 'random_pool',
    inference_id: inferenceId,
    request_id_hash: hashToken(first.request_id || inferenceId),
    asset_id_hash: hashToken(first.asset_id || first.photo_id || first.upload_id || ''),
    quality_grade: normalizeBucket(first.quality_grade, 'unknown'),
    tone_bucket: normalizeBucket(first.skin_tone_bucket, 'unknown'),
    lighting_bucket: normalizeBucket(first.lighting_bucket, 'unknown'),
    region_bucket: normalizeBucket(first.region_bucket || first.region || first.country, 'unknown'),
    device_class: normalizeBucket(first.device_class, 'unknown'),
    issue_type: concernTypes[0] || 'other',
    concern_types: concernTypes,
    disagreement_reason: null,
    suggested_fix_summary: null,
    roi_uri: String(first?.output_json?.roi_uri || first?.roi_uri || '').trim() || null,
    created_at: String(first.created_at || ''),
    concerns,
  };
}

function extractHardCaseCandidate(row) {
  const quality = row && typeof row.quality_summary === 'object' ? row.quality_summary : {};
  return {
    source: 'hard_case',
    inference_id: String(row?.inference_id || '').trim() || null,
    request_id_hash: String(row?.request_id_hash || '').trim() || null,
    asset_id_hash: String(row?.asset_id_hash || '').trim() || null,
    quality_grade: normalizeBucket(quality.quality_grade || row?.quality_grade, 'unknown'),
    tone_bucket: normalizeBucket(quality.tone_bucket || row?.skin_tone_bucket, 'unknown'),
    lighting_bucket: normalizeBucket(quality.lighting_bucket || row?.lighting_bucket, 'unknown'),
    region_bucket: normalizeBucket(row?.region_bucket || row?.region || row?.country, 'unknown'),
    device_class: normalizeBucket(quality.device_class || row?.device_class, 'unknown'),
    issue_type: normalizeConcernType(row?.issue_type),
    concern_types: [normalizeConcernType(row?.issue_type)],
    disagreement_reason: String(row?.disagreement_reason || '').trim() || null,
    suggested_fix_summary: String(row?.suggested_fix_summary || '').trim() || null,
    roi_uri: String(row?.roi_uri || '').trim() || null,
    created_at: String(row?.created_at || ''),
    concerns: [],
  };
}

function formatBboxPrediction(concern, index) {
  if (!concern || typeof concern !== 'object') return null;
  const regions = Array.isArray(concern.regions) ? concern.regions : [];
  for (const region of regions) {
    if (!region || region.kind !== 'bbox' || typeof region.bbox_norm !== 'object') continue;
    const box = region.bbox_norm;
    const x0 = Number(box.x0);
    const y0 = Number(box.y0);
    const x1 = Number(box.x1);
    const y1 = Number(box.y1);
    if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) continue;
    const width = Math.max(0, (x1 - x0) * 100);
    const height = Math.max(0, (y1 - y0) * 100);
    if (width <= 0 || height <= 0) continue;
    return {
      id: `bbox_${index + 1}`,
      from_name: 'label',
      to_name: 'image',
      type: 'rectanglelabels',
      value: {
        x: Math.max(0, Math.min(100, x0 * 100)),
        y: Math.max(0, Math.min(100, y0 * 100)),
        width: Math.max(0, Math.min(100, width)),
        height: Math.max(0, Math.min(100, height)),
        rectanglelabels: [normalizeConcernType(concern.type)],
      },
    };
  }
  return null;
}

function buildLabelStudioTask(candidate, index, { includeRoi }) {
  const predictions = [];
  const predictionResults = [];
  const concerns = safeArray(candidate.concerns);
  for (let i = 0; i < concerns.length; i += 1) {
    const result = formatBboxPrediction(concerns[i], i);
    if (result) predictionResults.push(result);
  }
  if (predictionResults.length) {
    predictions.push({
      model_version: 'aurora.pseudo_prelabel.v1',
      score: 0.5,
      result: predictionResults.slice(0, 8),
    });
  }

  const taskId = `gold_task_${String(index + 1).padStart(6, '0')}`;
  const inferenceId = String(candidate.inference_id || '').trim();
  const data = {
    schema_version: TASK_SCHEMA_VERSION,
    task_id: taskId,
    inference_id: inferenceId || null,
    request_id_hash: candidate.request_id_hash || null,
    asset_id_hash: candidate.asset_id_hash || null,
    quality_grade: candidate.quality_grade,
    tone_bucket: candidate.tone_bucket,
    lighting_bucket: candidate.lighting_bucket,
    region_bucket: candidate.region_bucket,
    device_class: candidate.device_class,
    issue_type: candidate.issue_type,
    concern_types: Array.isArray(candidate.concern_types) ? candidate.concern_types : [],
    source: candidate.source,
    disagreement_reason: candidate.disagreement_reason,
    suggested_fix_summary: candidate.suggested_fix_summary,
    requires_user_opt_in: includeRoi ? false : true,
  };
  if (includeRoi && candidate.roi_uri) data.image = candidate.roi_uri;
  if (!includeRoi || !candidate.roi_uri) {
    data.image_placeholder = 'ROI not exported. Request user opt-in to attach image.';
  }

  return {
    id: taskId,
    data,
    meta: {
      created_at: new Date().toISOString(),
      priority: candidate.source === 'hard_case' ? 'high' : 'normal',
    },
    ...(predictions.length ? { predictions } : {}),
  };
}

function selectCandidates({ hardCandidates, randomCandidates, total, hardRatio, quotas, seed }) {
  const out = [];
  const seenInference = new Set();
  const toneCounts = {};
  const lightingCounts = {};
  const regionCounts = {};

  const hardTarget = Math.min(total, Math.max(0, Math.round(total * hardRatio)));

  function canTake(candidate) {
    if (!candidate) return false;
    const inferenceKey = String(candidate.inference_id || '');
    if (inferenceKey && seenInference.has(inferenceKey)) return false;
    if (!quotaAllows(toneCounts, quotas.tone_quota, candidate.tone_bucket)) return false;
    if (!quotaAllows(lightingCounts, quotas.lighting_quota, candidate.lighting_bucket)) return false;
    if (!quotaAllows(regionCounts, quotas.region_quota, candidate.region_bucket)) return false;
    return true;
  }

  function pushCandidate(candidate) {
    out.push(candidate);
    const inferenceKey = String(candidate.inference_id || '');
    if (inferenceKey) seenInference.add(inferenceKey);
    addBucketCount(toneCounts, candidate.tone_bucket);
    addBucketCount(lightingCounts, candidate.lighting_bucket);
    addBucketCount(regionCounts, candidate.region_bucket);
  }

  const hardPool = shuffleWithSeed(hardCandidates, seed);
  for (const candidate of hardPool) {
    if (out.length >= hardTarget) break;
    if (!canTake(candidate)) continue;
    pushCandidate(candidate);
  }

  const randomPool = shuffleWithSeed(randomCandidates, Number(seed) + 17);
  for (const candidate of randomPool) {
    if (out.length >= total) break;
    if (!canTake(candidate)) continue;
    pushCandidate(candidate);
  }

  if (out.length < total) {
    const fallbackPool = [...hardPool, ...randomPool];
    for (const candidate of fallbackPool) {
      if (out.length >= total) break;
      const inferenceKey = String(candidate.inference_id || '');
      if (inferenceKey && seenInference.has(inferenceKey)) continue;
      pushCandidate(candidate);
    }
  }

  return {
    selected: out.slice(0, total),
    counts: {
      tone: toneCounts,
      lighting: lightingCounts,
      region: regionCounts,
      selected_total: out.length,
      selected_hard_case: out.filter((item) => item.source === 'hard_case').length,
    },
  };
}

function resolveHardCasesPath(baseDir, dateKey) {
  const primary = path.join(baseDir, 'reports', 'pseudo_label_job', dateKey, 'hard_cases_daily.jsonl');
  if (fs.existsSync(primary)) return primary;
  const fallback = path.join(baseDir, 'tmp', 'diag_verify', 'hard_cases.ndjson');
  return fallback;
}

function resolveModelOutputsPath(baseDir) {
  return path.join(baseDir, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const dateKey = dateKeyFromInput(args.date);
  const dayPrefix = datePrefix(dateKey);
  const quotas = loadQuotaConfig(args);
  const total = clampInt(args.total || quotas.total, quotas.total, 1, 50000);
  const hardRatio = Math.max(0, Math.min(1, Number(args.hardRatio === '' ? quotas.hard_case_ratio : args.hardRatio)));
  const includeRoi = parseBool(args.allowRoi, false);
  const seed = clampInt(args.seed, Number(dateKey.slice(-6)), 1, 2147483647);

  const hardCasesPath = path.resolve(args.hardCases || resolveHardCasesPath(repoRoot, dateKey));
  const modelOutputsPath = path.resolve(args.modelOutputs || resolveModelOutputsPath(repoRoot));
  const outPath = path.resolve(args.out || path.join(repoRoot, 'out', `gold_label_tasks_${dateKey}.jsonl`));

  const hardRows = extractDateFiltered(readNdjson(hardCasesPath), dayPrefix).map(extractHardCaseCandidate);
  const modelRows = extractDateFiltered(readNdjson(modelOutputsPath), dayPrefix);
  const grouped = groupModelOutputsByInference(modelRows);
  const randomCandidates = Array.from(grouped.entries()).map(([inferenceId, rows]) => extractModelOutputCandidate(inferenceId, rows));

  const picked = selectCandidates({
    hardCandidates: hardRows,
    randomCandidates,
    total,
    hardRatio,
    quotas,
    seed,
  });
  const tasks = picked.selected.map((candidate, index) => buildLabelStudioTask(candidate, index, { includeRoi }));
  const writtenPath = writeNdjson(outPath, tasks);

  const summary = {
    schema_version: TASK_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    date_key: dateKey,
    inputs: {
      hard_cases_path: hardCasesPath,
      model_outputs_path: modelOutputsPath,
      hard_candidates: hardRows.length,
      random_candidates: randomCandidates.length,
    },
    config: {
      total,
      hard_case_ratio: hardRatio,
      allow_roi: includeRoi,
      seed,
      tone_quota: quotas.tone_quota,
      lighting_quota: quotas.lighting_quota,
      region_quota: quotas.region_quota,
    },
    output: {
      tasks_path: writtenPath,
      selected_total: tasks.length,
      selected_hard_case: picked.counts.selected_hard_case,
      bucket_counts: picked.counts,
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
