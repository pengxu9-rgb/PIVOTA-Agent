#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey } from './internal_batch_helpers.mjs';
import { readJsonlRows, toPosix } from './local_image_loader.mjs';

const CHOICES = Object.freeze(['baseline', 'variant1', 'tie', 'cannot_tell']);
const MODULE_IDS = Object.freeze([
  'nose',
  'forehead',
  'left_cheek',
  'right_cheek',
  'chin',
  'under_eye_left',
  'under_eye_right',
]);

const HELP_TEXT = `preference_diagnostics.mjs

Usage:
  node scripts/preference_diagnostics.mjs --run_id <id> --manifest <manifest.json> --eval_jsonl <eval_preference.jsonl|json> --labels <preference_labels.ndjson> [options]

Required:
  --run_id <id>                            run id
  --manifest <path>                        preference manifest.json
  --eval_jsonl <path>                      eval_preference jsonl (or summary json)
  --labels <path>                          preference_labels.ndjson or preference_labels_merged.ndjson

Options:
  --out_dir <path>                         report output dir (default: reports)
  --crossset_jsonl <path>                  optional eval_circle_crossset json/jsonl
  --gold_eval_md <path>                    optional eval_gold markdown
  --overlay_gate_coverage_min <0-1>        min coverage for overlay diff propagation (default: 0.98)
  --overlay_gate_consistency_min <0-1>     min manifest/eval consistency rate (default: 0.98)
  --overlay_gate_epsilon <n>               max abs delta for consistency (default: 1e-6)
  --overlay_gate_only <bool>               run only overlay consistency gate and exit
  --skip_overlay_gate <bool>               skip overlay consistency gate (default: false)
  --help                                   show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseNumberWithFallback(value, fallback, min = -Infinity, max = Infinity) {
  const n = parseNumber(value);
  if (n == null) return fallback;
  return Math.max(min, Math.min(max, n));
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = parseNumber(value);
    if (n != null) return n;
  }
  return null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const token = String(value).trim();
    if (token) return token;
  }
  return null;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function normalizeChoice(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return null;
  if (token === 'baseline' || token === 'base') return 'baseline';
  if (token === 'variant1' || token === 'variant' || token === 'var') return 'variant1';
  if (token === 'tie' || token === 'equal' || token === 'same') return 'tie';
  if (token === 'cannot_tell' || token === 'cant_tell' || token === 'unknown' || token === 'unclear') return 'cannot_tell';
  return null;
}

function normalizeConfidenceInt(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 1) return Math.max(1, Math.min(5, Math.round(n * 5)));
  if (n <= 5) return Math.max(1, Math.min(5, Math.round(n)));
  if (n <= 10) return Math.max(1, Math.min(5, Math.round(n / 2)));
  if (n <= 100) return Math.max(1, Math.min(5, Math.round(n / 20)));
  return 5;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const token of [args.manifest, args.eval_jsonl, args.labels]) {
    const base = path.basename(String(token || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function parseArgs(argv) {
  const out = {
    help: false,
    run_id: process.env.RUN_ID || '',
    manifest: process.env.MANIFEST || '',
    eval_jsonl: process.env.EVAL_JSONL || '',
    labels: process.env.LABELS || process.env.PREFERENCE_LABELS || '',
    out_dir: process.env.OUT_DIR || process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports',
    crossset_jsonl: process.env.CROSSSET_JSONL || '',
    gold_eval_md: process.env.GOLD_EVAL_MD || '',
    overlay_gate_coverage_min: process.env.OVERLAY_GATE_COVERAGE_MIN || '0.98',
    overlay_gate_consistency_min: process.env.OVERLAY_GATE_CONSISTENCY_MIN || '0.98',
    overlay_gate_epsilon: process.env.OVERLAY_GATE_EPSILON || '0.000001',
    overlay_gate_only: process.env.OVERLAY_GATE_ONLY || 'false',
    skip_overlay_gate: process.env.SKIP_OVERLAY_GATE || 'false',
  };

  const aliasMap = {
    run_id: 'run_id',
    runid: 'run_id',
    manifest: 'manifest',
    eval_jsonl: 'eval_jsonl',
    eval_json: 'eval_jsonl',
    labels: 'labels',
    out_dir: 'out_dir',
    outdir: 'out_dir',
    out: 'out_dir',
    crossset_jsonl: 'crossset_jsonl',
    crossset: 'crossset_jsonl',
    gold_eval_md: 'gold_eval_md',
    gold_md: 'gold_eval_md',
    overlay_gate_coverage_min: 'overlay_gate_coverage_min',
    overlay_gate_consistency_min: 'overlay_gate_consistency_min',
    overlay_gate_epsilon: 'overlay_gate_epsilon',
    overlay_gate_only: 'overlay_gate_only',
    skip_overlay_gate: 'skip_overlay_gate',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const tokenRaw = String(argv[i] || '');
    if (tokenRaw === '--help' || tokenRaw === '-h') {
      out.help = true;
      continue;
    }

    if (!tokenRaw.startsWith('--')) continue;
    const body = tokenRaw.slice(2);
    const eqIndex = body.indexOf('=');
    let keyRaw = body;
    let value = null;
    if (eqIndex >= 0) {
      keyRaw = body.slice(0, eqIndex);
      value = body.slice(eqIndex + 1);
    }

    const key = aliasMap[String(keyRaw || '').trim().toLowerCase()];
    if (!key) continue;

    if (value == null) {
      const next = argv[i + 1];
      if (!next || String(next).startsWith('--')) {
        out[key] = 'true';
        continue;
      }
      out[key] = String(next);
      i += 1;
    } else {
      out[key] = String(value);
    }
  }

  out.help = parseBool(out.help, false);
  out.run_id = String(out.run_id || '').trim();
  out.manifest = String(out.manifest || '').trim();
  out.eval_jsonl = String(out.eval_jsonl || '').trim();
  out.labels = String(out.labels || '').trim();
  out.out_dir = String(out.out_dir || 'reports').trim() || 'reports';
  out.crossset_jsonl = String(out.crossset_jsonl || '').trim();
  out.gold_eval_md = String(out.gold_eval_md || '').trim();
  out.overlay_gate_coverage_min = parseNumberWithFallback(out.overlay_gate_coverage_min, 0.98, 0, 1);
  out.overlay_gate_consistency_min = parseNumberWithFallback(out.overlay_gate_consistency_min, 0.98, 0, 1);
  out.overlay_gate_epsilon = parseNumberWithFallback(out.overlay_gate_epsilon, 0.000001, 0, Infinity);
  out.overlay_gate_only = parseBool(out.overlay_gate_only, false);
  out.skip_overlay_gate = parseBool(out.skip_overlay_gate, false);
  return out;
}

function emptyCounts() {
  return {
    baseline: 0,
    variant1: 0,
    tie: 0,
    cannot_tell: 0,
  };
}

function countTotal(counts) {
  return CHOICES.reduce((acc, key) => acc + Number(counts[key] || 0), 0);
}

function wilsonInterval(success, total, z = 1.96) {
  const s = Number(success);
  const n = Number(total);
  if (!Number.isFinite(s) || !Number.isFinite(n) || n <= 0) return { low: null, high: null };
  const p = Math.max(0, Math.min(1, s / n));
  const z2 = z * z;
  const denom = 1 + (z2 / n);
  const center = p + (z2 / (2 * n));
  const margin = z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

function buildRateRow({ key, counts, sampleIds }) {
  const totalVotes = countTotal(counts);
  const headVotes = Number(counts.baseline || 0) + Number(counts.variant1 || 0);
  const baselineCi = wilsonInterval(Number(counts.baseline || 0), headVotes);
  const variantCi = wilsonInterval(Number(counts.variant1 || 0), headVotes);
  const majority = CHOICES
    .map((choice) => ({ choice, value: Number(counts[choice] || 0) }))
    .sort((a, b) => b.value - a.value || a.choice.localeCompare(b.choice))[0];
  const majorityValue = majority ? majority.value : 0;

  return {
    slice_key: key,
    n_votes: totalVotes,
    sample_count: sampleIds.size,
    baseline_votes: Number(counts.baseline || 0),
    variant1_votes: Number(counts.variant1 || 0),
    tie_votes: Number(counts.tie || 0),
    cannot_tell_votes: Number(counts.cannot_tell || 0),
    head_to_head_votes: headVotes,
    baseline_win_rate: headVotes > 0 ? round3(Number(counts.baseline || 0) / headVotes) : null,
    variant1_win_rate: headVotes > 0 ? round3(Number(counts.variant1 || 0) / headVotes) : null,
    tie_rate: totalVotes > 0 ? round3(Number(counts.tie || 0) / totalVotes) : null,
    cannot_tell_rate: totalVotes > 0 ? round3(Number(counts.cannot_tell || 0) / totalVotes) : null,
    disagreement_rate: totalVotes > 0 ? round3(1 - (majorityValue / totalVotes)) : null,
    baseline_wilson_low: headVotes > 0 ? round3(baselineCi.low) : null,
    baseline_wilson_high: headVotes > 0 ? round3(baselineCi.high) : null,
    variant1_wilson_low: headVotes > 0 ? round3(variantCi.low) : null,
    variant1_wilson_high: headVotes > 0 ? round3(variantCi.high) : null,
    _sample_ids: [...sampleIds].sort((a, b) => a.localeCompare(b)),
  };
}

function computeKappa(pairs, categories = CHOICES) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const validPairs = pairs.filter((pair) => Array.isArray(pair) && pair.length === 2 && categories.includes(pair[0]) && categories.includes(pair[1]));
  if (!validPairs.length) return null;

  let agree = 0;
  const margA = Object.fromEntries(categories.map((item) => [item, 0]));
  const margB = Object.fromEntries(categories.map((item) => [item, 0]));

  for (const [a, b] of validPairs) {
    if (a === b) agree += 1;
    margA[a] += 1;
    margB[b] += 1;
  }

  const n = validPairs.length;
  const po = agree / n;
  let pe = 0;
  for (const cat of categories) {
    pe += (margA[cat] / n) * (margB[cat] / n);
  }
  if (Math.abs(1 - pe) < 1e-9) return null;
  return (po - pe) / (1 - pe);
}

function bucketHair(raw) {
  const n = parseNumber(raw);
  if (n == null) return 'unknown';
  if (n < 0.1) return 'low(<0.10)';
  if (n < 0.25) return 'mid(0.10-0.25)';
  return 'high(>=0.25)';
}

function bucketLeakage(raw) {
  const n = parseNumber(raw);
  if (n == null) return 'unknown';
  if (n < 0.05) return 'low(<0.05)';
  if (n < 0.15) return 'mid(0.05-0.15)';
  return 'high(>=0.15)';
}

function bucketMinPixels(raw) {
  const n = parseNumber(raw);
  if (n == null) return 'unknown';
  if (n <= 16) return 'tiny(<=16)';
  if (n <= 48) return 'small(17-48)';
  if (n <= 128) return 'mid(49-128)';
  return 'large(>128)';
}

function bucketConfidence(raw) {
  const n = normalizeConfidenceInt(raw);
  if (n == null) return 'unknown';
  if (n <= 2) return 'low(<=2)';
  if (n >= 4) return 'high(>=4)';
  return 'mid(3)';
}

function bucketOverlayDiff(raw) {
  const n = parseNumber(raw);
  if (n == null) return 'unknown';
  if (n < 0.01) return 'very_low(<0.01)';
  if (n < 0.03) return 'mid(0.01-0.03)';
  return 'high(>=0.03)';
}

function extractOverlayDiffRatio(raw, fallback = null) {
  const risk = raw && raw.risk_features && typeof raw.risk_features === 'object' ? raw.risk_features : {};
  return firstFiniteNumber(
    raw && raw.overlay_diff_ratio,
    raw && raw.diff_ratio,
    raw && raw.overlayDiffRatio,
    risk.overlay_diff_ratio,
    risk.diff_ratio,
    risk.overlayDiffRatio,
    fallback,
  );
}

function extractOverlayDiffPixels(raw, fallback = null) {
  const risk = raw && raw.risk_features && typeof raw.risk_features === 'object' ? raw.risk_features : {};
  const n = firstFiniteNumber(
    raw && raw.overlay_diff_pixels,
    raw && raw.diff_pixels,
    raw && raw.overlayDiffPixels,
    risk.overlay_diff_pixels,
    risk.diff_pixels,
    risk.overlayDiffPixels,
    fallback,
  );
  return n == null ? null : Math.max(0, Math.trunc(n));
}

function extractOverlayFocusModule(raw, fallback = null) {
  const risk = raw && raw.risk_features && typeof raw.risk_features === 'object' ? raw.risk_features : {};
  return firstNonEmptyString(
    raw && raw.overlay_focus_module,
    raw && raw.overlayFocusModule,
    risk.overlay_focus_module,
    risk.overlayFocusModule,
    fallback,
  );
}

function normalizeManifestRow(row) {
  const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
  if (!sampleId) return null;

  const risk = row && row.risk_features && typeof row.risk_features === 'object'
    ? row.risk_features
    : {};

  const guardA = row && row.module_guard_triggered;
  const guardB = row && row.baseline_summary && row.baseline_summary.module_guard_triggered;
  const guardC = row && row.variant_summary && row.variant_summary.module_guard_triggered;
  const guardTriggered = [guardA, guardB, guardC].some((value) => value === true)
    ? true
    : ([guardA, guardB, guardC].some((value) => value === false) ? false : null);

  return {
    sample_id: sampleId,
    source: String(row.source || '').trim().toLowerCase() || null,
    task_batch: String(row.task_batch || '').trim().toUpperCase() || null,
    hair_overlap_est: firstFiniteNumber(
      risk.hair_overlap_est,
      row.hair_overlap_est,
      row.forehead_hair_overlap_est,
    ),
    leakage_bg_est_mean: firstFiniteNumber(
      risk.leakage_bg_est_mean,
      row.leakage_bg_est_mean,
    ),
    min_module_pixels: (() => {
      const n = firstFiniteNumber(
        risk.min_module_pixels,
        row.min_module_pixels,
        row.module_pixels_min,
      );
      return n == null ? null : Math.max(0, Math.trunc(n));
    })(),
    overlay_diff_pixels: extractOverlayDiffPixels({ ...row, risk_features: risk }, null),
    overlay_diff_ratio: extractOverlayDiffRatio({ ...row, risk_features: risk }, null),
    overlay_focus_module: extractOverlayFocusModule({ ...row, risk_features: risk }, null),
    guard_triggered: guardTriggered,
  };
}

function normalizeLabelRow(row, manifestRow) {
  const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
  if (!sampleId) return null;

  const source = String(row.source || (manifestRow && manifestRow.source) || 'unknown').trim().toLowerCase() || 'unknown';
  const winner = normalizeChoice(row.winner || row.overall_choice);
  const moduleId = String(row.module_id || 'overall').trim().toLowerCase() || 'overall';
  const confidenceInt = normalizeConfidenceInt(row.confidence_int != null ? row.confidence_int : row.confidence);

  const rowRisk = row && row.risk_features && typeof row.risk_features === 'object'
    ? row.risk_features
    : {};

  const hairOverlap = firstFiniteNumber(
    rowRisk.hair_overlap_est,
    row && row.hair_overlap_est,
  );
  const leakageBg = firstFiniteNumber(
    rowRisk.leakage_bg_est_mean,
    row && row.leakage_bg_est_mean,
  );
  const minPixelsRaw = firstFiniteNumber(
    rowRisk.min_module_pixels,
    row && row.min_module_pixels,
  );
  const minPixels = minPixelsRaw == null ? null : Math.max(0, Math.trunc(minPixelsRaw));
  const overlayDiffPixels = extractOverlayDiffPixels(row, null);
  const overlayDiffRatio = extractOverlayDiffRatio(row, null);
  const overlayFocusModule = extractOverlayFocusModule(row, null);

  return {
    sample_id: sampleId,
    source,
    winner,
    module_id: moduleId,
    per_module_choice: row && row.per_module_choice && typeof row.per_module_choice === 'object' ? row.per_module_choice : {},
    rater_id: String(row.rater_id || row.annotator_id || 'unknown_rater').trim() || 'unknown_rater',
    annotation_id: String(row.annotation_id || '').trim() || null,
    confidence_int: confidenceInt,
    task_batch: String(row.task_batch || (manifestRow && manifestRow.task_batch) || '').trim().toUpperCase() || null,
    created_at: row.created_at || (row.timestamps && row.timestamps.created_at) || null,
    updated_at: row.updated_at || (row.timestamps && row.timestamps.updated_at) || null,
    decision_source: String(row.decision_source || '').trim().toLowerCase() || null,
    hair_overlap_est: hairOverlap != null ? hairOverlap : (manifestRow ? manifestRow.hair_overlap_est : null),
    leakage_bg_est_mean: leakageBg != null ? leakageBg : (manifestRow ? manifestRow.leakage_bg_est_mean : null),
    min_module_pixels: minPixels != null ? minPixels : (manifestRow ? manifestRow.min_module_pixels : null),
    overlay_diff_pixels: overlayDiffPixels != null ? overlayDiffPixels : (manifestRow ? manifestRow.overlay_diff_pixels : null),
    overlay_diff_ratio: overlayDiffRatio != null ? overlayDiffRatio : (manifestRow ? manifestRow.overlay_diff_ratio : null),
    overlay_focus_module: overlayFocusModule || (manifestRow ? manifestRow.overlay_focus_module : null),
    guard_triggered: manifestRow ? manifestRow.guard_triggered : null,
  };
}

function sortRowsStable(rows) {
  return [...rows].sort((a, b) => {
    const sampleDelta = String(a.sample_id || '').localeCompare(String(b.sample_id || ''));
    if (sampleDelta !== 0) return sampleDelta;
    const moduleDelta = String(a.module_id || '').localeCompare(String(b.module_id || ''));
    if (moduleDelta !== 0) return moduleDelta;
    const raterDelta = String(a.rater_id || '').localeCompare(String(b.rater_id || ''));
    if (raterDelta !== 0) return raterDelta;
    const tsA = Date.parse(String(a.updated_at || a.created_at || '')) || 0;
    const tsB = Date.parse(String(b.updated_at || b.created_at || '')) || 0;
    if (tsA !== tsB) return tsA - tsB;
    return String(a.annotation_id || '').localeCompare(String(b.annotation_id || ''));
  });
}

async function readJsonPathMaybe(filePath) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function loadEvalRows(evalPath) {
  const abs = path.resolve(evalPath);
  const ext = String(path.extname(abs) || '').trim().toLowerCase();

  if (ext === '.jsonl' || ext === '.ndjson') {
    return {
      summary: null,
      sample_rows: await readJsonlRows(abs),
    };
  }

  const json = await readJsonPathMaybe(abs);
  if (!json) return { summary: null, sample_rows: [] };

  if (Array.isArray(json)) {
    return {
      summary: null,
      sample_rows: json,
    };
  }

  const fallbackRows = [];
  if (Array.isArray(json.sample_rows)) fallbackRows.push(...json.sample_rows);
  if (Array.isArray(json.rows)) fallbackRows.push(...json.rows);
  if (Array.isArray(json.top_contentious_samples)) fallbackRows.push(...json.top_contentious_samples);

  if (!fallbackRows.length && json.artifacts && json.artifacts.report_jsonl) {
    const inferred = path.resolve(String(json.artifacts.report_jsonl));
    const stat = await fsp.stat(inferred).catch(() => null);
    if (stat && stat.isFile()) {
      return {
        summary: json,
        sample_rows: await readJsonlRows(inferred),
      };
    }
  }

  return {
    summary: json,
    sample_rows: fallbackRows,
  };
}

function summarizeVotes(votes, keyFn) {
  const counters = new Map();
  for (const vote of votes) {
    const key = String(keyFn(vote) || 'unknown').trim() || 'unknown';
    if (!counters.has(key)) {
      counters.set(key, {
        counts: emptyCounts(),
        sampleIds: new Set(),
      });
    }
    const entry = counters.get(key);
    const choice = normalizeChoice(vote.choice);
    if (!choice) continue;
    entry.counts[choice] += 1;
    entry.sampleIds.add(String(vote.sample_id || ''));
  }

  return [...counters.entries()]
    .map(([key, value]) => buildRateRow({ key, counts: value.counts, sampleIds: value.sampleIds }))
    .sort((a, b) => b.n_votes - a.n_votes || String(a.slice_key).localeCompare(String(b.slice_key)));
}

function pickLatestByRater(rows) {
  const sorted = [...rows].sort((a, b) => {
    const ta = Date.parse(String(a.updated_at || a.created_at || '')) || 0;
    const tb = Date.parse(String(b.updated_at || b.created_at || '')) || 0;
    if (ta !== tb) return tb - ta;
    return String(b.annotation_id || '').localeCompare(String(a.annotation_id || ''));
  });

  const map = new Map();
  for (const row of sorted) {
    const key = String(row.rater_id || '').trim();
    if (!key || map.has(key)) continue;
    map.set(key, row);
  }
  return map;
}

function buildSampleStatsFromLabels(overallRows) {
  const bySample = new Map();
  for (const row of overallRows) {
    const sampleId = String(row.sample_id || '').trim();
    if (!sampleId) continue;
    if (!bySample.has(sampleId)) bySample.set(sampleId, []);
    bySample.get(sampleId).push(row);
  }

  const rows = [];
  for (const [sampleId, list] of bySample.entries()) {
    const counts = emptyCounts();
    const annotators = new Set();
    const confidences = [];
    let source = 'unknown';

    for (const row of list) {
      const winner = normalizeChoice(row.winner);
      if (winner) counts[winner] += 1;
      annotators.add(String(row.rater_id || 'unknown_rater'));
      if (row.confidence_int != null) confidences.push(Number(row.confidence_int));
      source = row.source || source;
    }

    const totalVotes = countTotal(counts);
    const headVotes = Number(counts.baseline || 0) + Number(counts.variant1 || 0);
    const maxCount = Math.max(...CHOICES.map((choice) => Number(counts[choice] || 0)));

    rows.push({
      sample_id: sampleId,
      source,
      baseline_votes: counts.baseline,
      variant1_votes: counts.variant1,
      tie_votes: counts.tie,
      cannot_tell_votes: counts.cannot_tell,
      total_votes: totalVotes,
      annotators_total: annotators.size,
      baseline_win_rate: headVotes > 0 ? round3(counts.baseline / headVotes) : null,
      variant1_win_rate: headVotes > 0 ? round3(counts.variant1 / headVotes) : null,
      tie_rate: totalVotes > 0 ? round3(counts.tie / totalVotes) : null,
      cannot_tell_rate: totalVotes > 0 ? round3(counts.cannot_tell / totalVotes) : null,
      disagreement_rate: totalVotes > 0 ? round3(1 - (maxCount / totalVotes)) : null,
      low_confidence_rate: confidences.length ? round3(confidences.filter((value) => value <= 2).length / confidences.length) : null,
      split_close_score: headVotes > 0 ? round3(1 - (Math.abs(counts.baseline - counts.variant1) / headVotes)) : null,
      contentious_score: round3(
        (totalVotes > 0 ? (counts.cannot_tell / totalVotes) : 0) * 0.45
        + (totalVotes > 0 ? (1 - (maxCount / totalVotes)) : 0) * 0.35
        + (confidences.length ? (confidences.filter((value) => value <= 2).length / confidences.length) : 0) * 0.2,
      ),
    });
  }

  return rows.sort((a, b) => String(a.sample_id).localeCompare(String(b.sample_id)));
}

function buildSampleEvalMap(sampleRows, manifestMap) {
  const map = new Map();
  for (const raw of sampleRows) {
    const sampleId = String(raw && (raw.sample_id || raw.sample_hash) ? (raw.sample_id || raw.sample_hash) : '').trim();
    if (!sampleId) continue;
    const manifestRow = manifestMap.get(sampleId) || null;
    const source = String(raw.source || (manifestRow && manifestRow.source) || 'unknown').trim().toLowerCase() || 'unknown';

    map.set(sampleId, {
      sample_id: sampleId,
      source,
      cannot_tell_rate: parseNumber(raw.cannot_tell_rate),
      disagreement_rate: parseNumber(raw.disagreement_overlap_rate != null ? raw.disagreement_overlap_rate : raw.disagreement_rate),
      low_confidence_rate: parseNumber(raw.low_confidence_rate),
      split_close_score: parseNumber(raw.split_close_score),
      contentious_score: parseNumber(raw.contentious_score),
      annotators_total: parseNumber(raw.annotators_total),
      total_votes: parseNumber(raw.total_votes),
      hair_overlap_est: firstFiniteNumber(
        raw.hair_overlap_est,
        raw && raw.risk_features && raw.risk_features.hair_overlap_est,
        manifestRow && manifestRow.hair_overlap_est,
      ),
      leakage_bg_est_mean: firstFiniteNumber(
        raw.leakage_bg_est_mean,
        raw && raw.risk_features && raw.risk_features.leakage_bg_est_mean,
        manifestRow && manifestRow.leakage_bg_est_mean,
      ),
      min_module_pixels: (() => {
        const n = firstFiniteNumber(
          raw.min_module_pixels,
          raw && raw.risk_features && raw.risk_features.min_module_pixels,
          manifestRow && manifestRow.min_module_pixels,
        );
        return n == null ? null : Math.max(0, Math.trunc(n));
      })(),
      overlay_diff_pixels: extractOverlayDiffPixels(raw, manifestRow && manifestRow.overlay_diff_pixels),
      overlay_diff_ratio: extractOverlayDiffRatio(raw, manifestRow && manifestRow.overlay_diff_ratio),
      overlay_focus_module: extractOverlayFocusModule(raw, manifestRow && manifestRow.overlay_focus_module),
      guard_triggered: manifestRow ? manifestRow.guard_triggered : null,
    });
  }
  return map;
}

function evaluateOverlayConsistencyGate({
  manifestMap,
  evalRows,
  coverageMin = 0.98,
  consistencyMin = 0.98,
  epsilon = 0.000001,
}) {
  const rows = Array.isArray(evalRows) ? evalRows : [];
  let totalRows = 0;
  let presentRows = 0;
  let consistentRows = 0;
  let joinableRows = 0;
  const issues = [];

  for (const raw of rows) {
    const sampleId = String(raw && (raw.sample_id || raw.sample_hash) ? (raw.sample_id || raw.sample_hash) : '').trim();
    if (!sampleId) continue;
    totalRows += 1;

    const manifestRow = manifestMap.get(sampleId) || null;
    const evalOverlay = extractOverlayDiffRatio(raw, null);
    const manifestOverlay = manifestRow ? extractOverlayDiffRatio(manifestRow, manifestRow.overlay_diff_ratio) : null;

    if (evalOverlay != null) presentRows += 1;

    let issue = null;
    let delta = null;
    if (!manifestRow) {
      issue = 'missing_manifest_row';
    } else if (manifestOverlay == null) {
      issue = 'missing_manifest_overlay';
    } else if (evalOverlay == null) {
      issue = 'missing_eval_overlay';
    } else {
      joinableRows += 1;
      delta = Math.abs(Number(evalOverlay) - Number(manifestOverlay));
      if (delta <= epsilon) {
        consistentRows += 1;
      } else {
        issue = 'value_mismatch';
      }
    }

    if (issue) {
      issues.push({
        sample_id: sampleId,
        issue,
        eval_overlay_diff_ratio: evalOverlay == null ? null : round3(evalOverlay),
        manifest_overlay_diff_ratio: manifestOverlay == null ? null : round3(manifestOverlay),
        abs_delta: delta == null ? null : round3(delta),
      });
    }
  }

  const coverageRate = totalRows > 0 ? presentRows / totalRows : 0;
  const consistencyRate = totalRows > 0 ? consistentRows / totalRows : 0;
  const joinableConsistencyRate = joinableRows > 0 ? consistentRows / joinableRows : null;
  const missingRate = totalRows > 0 ? (totalRows - presentRows) / totalRows : 1;
  const issuePriority = {
    value_mismatch: 0,
    missing_eval_overlay: 1,
    missing_manifest_overlay: 2,
    missing_manifest_row: 3,
  };
  const topIssues = [...issues]
    .sort((a, b) => {
      const pa = Object.prototype.hasOwnProperty.call(issuePriority, a.issue) ? issuePriority[a.issue] : 99;
      const pb = Object.prototype.hasOwnProperty.call(issuePriority, b.issue) ? issuePriority[b.issue] : 99;
      if (pa !== pb) return pa - pb;
      const sampleDelta = String(a.sample_id || '').localeCompare(String(b.sample_id || ''));
      if (sampleDelta !== 0) return sampleDelta;
      return Number(b.abs_delta || 0) - Number(a.abs_delta || 0);
    })
    .slice(0, 10);

  const pass = totalRows > 0 && coverageRate >= coverageMin && consistencyRate >= consistencyMin;
  return {
    pass,
    thresholds: {
      coverage_min: round3(coverageMin),
      consistency_min: round3(consistencyMin),
      epsilon: epsilon,
    },
    counts: {
      eval_rows_total: totalRows,
      overlay_present_rows: presentRows,
      consistent_rows: consistentRows,
      joinable_rows: joinableRows,
      issue_rows: issues.length,
    },
    rates: {
      coverage_rate: round3(coverageRate),
      consistency_rate: round3(consistencyRate),
      joinable_consistency_rate: round3(joinableConsistencyRate),
      missing_rate: round3(missingRate),
    },
    top_issues: topIssues,
  };
}

function renderOverlayGateFailureTable(gateResult) {
  const lines = [];
  lines.push('overlay_consistency_gate_failed');
  lines.push(`- coverage_rate=${gateResult.rates.coverage_rate} threshold=${gateResult.thresholds.coverage_min}`);
  lines.push(`- consistency_rate=${gateResult.rates.consistency_rate} threshold=${gateResult.thresholds.consistency_min}`);
  lines.push('| rank | sample_id | issue | eval_overlay_diff_ratio | manifest_overlay_diff_ratio | abs_delta |');
  lines.push('|---:|---|---|---:|---:|---:|');
  if (!gateResult.top_issues.length) {
    lines.push('| 1 | - | - | - | - | - |');
  } else {
    gateResult.top_issues.forEach((row, idx) => {
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.issue} | ${row.eval_overlay_diff_ratio ?? '-'} | ${row.manifest_overlay_diff_ratio ?? '-'} | ${row.abs_delta ?? '-'} |`);
    });
  }
  return `${lines.join('\n')}\n`;
}

function resolveFinalVerdictFromMarkdown(markdownText) {
  if (!markdownText) return null;
  const lines = String(markdownText || '').split('\n');
  const verdicts = [];
  for (const line of lines) {
    const rowMatch = line.match(/^\|\s*verdict\s*\|\s*([^|]+?)\s*\|/i);
    if (rowMatch) {
      const token = String(rowMatch[1] || '').trim().toUpperCase();
      if (token) verdicts.push(token);
      continue;
    }
    const bulletMatch = line.match(/verdict\s*:\s*\*\*([A-Z_]+)\*\*/i);
    if (bulletMatch) {
      const token = String(bulletMatch[1] || '').trim().toUpperCase();
      if (token) verdicts.push(token);
    }
  }
  return verdicts.length ? verdicts[verdicts.length - 1] : null;
}

function resolveFinalVerdictFallback(overallRates, moduleRows, iaa) {
  const forehead = moduleRows.find((row) => String(row.slice_key || '') === 'forehead') || null;
  const overallDelta =
    overallRates.variant1_win_rate != null && overallRates.baseline_win_rate != null
      ? Number(overallRates.variant1_win_rate) - Number(overallRates.baseline_win_rate)
      : null;
  const foreheadDelta =
    forehead && forehead.variant1_win_rate != null && forehead.baseline_win_rate != null
      ? Number(forehead.variant1_win_rate) - Number(forehead.baseline_win_rate)
      : null;

  const variantCriterion = Boolean(
    (overallDelta != null && overallDelta >= 0.05)
    || (foreheadDelta != null && foreheadDelta >= 0.1),
  );
  const cannotCriterion = overallRates.cannot_tell_rate != null && Number(overallRates.cannot_tell_rate) <= 0.25;
  const iaaCriterion = iaa.overall_kappa != null
    ? Number(iaa.overall_kappa) >= 0.2
    : iaa.overall_simple_agreement != null
      ? Number(iaa.overall_simple_agreement) >= 0.6
      : false;

  if (!cannotCriterion || !iaaCriterion) return 'NEED_ADJUDICATION';
  return variantCriterion ? 'SHIP_VARIANT1' : 'KEEP_BASELINE';
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value))).map((value) => Number(value));
  if (!valid.length) return null;
  return round3(valid.reduce((acc, value) => acc + value, 0) / valid.length);
}

function buildDriverCandidates(sliceGroups, sampleEvalMap, globalDisagreementRate) {
  const candidates = [];

  for (const group of sliceGroups) {
    for (const slice of group.rows) {
      if (slice.n_votes < 3) continue;
      const sampleIds = Array.isArray(slice._sample_ids) ? slice._sample_ids : [];
      const sampleRows = sampleIds
        .map((sampleId) => sampleEvalMap.get(sampleId))
        .filter(Boolean);

      const avgSplitClose = average(sampleRows.map((row) => row.split_close_score));
      const avgHair = average(sampleRows.map((row) => row.hair_overlap_est));
      const avgLeakage = average(sampleRows.map((row) => row.leakage_bg_est_mean));
      const avgMinPixels = average(sampleRows.map((row) => row.min_module_pixels));
      const avgOverlayDiff = average(sampleRows.map((row) => row.overlay_diff_ratio));

      const cannotRate = Number(slice.cannot_tell_rate || 0);
      const disagreementRate = Number(slice.disagreement_rate || 0);
      const score = round3(
        cannotRate * 0.45
        + disagreementRate * 0.4
        + (Number(avgSplitClose || 0) * 0.15),
      ) || 0;

      let likelyCause = 'model outputs unstable';
      let issueArea = 'model issue';

      if (group.type === 'module' && String(slice.slice_key) === 'forehead' && Number(avgHair || 0) >= 0.2) {
        likelyCause = 'hair/skin boundary issue';
        issueArea = 'model issue';
      } else if (cannotRate >= 0.35 && Number(avgOverlayDiff || 0) > 0 && Number(avgOverlayDiff || 0) < 0.01) {
        likelyCause = 'visual difference too small';
        issueArea = 'UI issue';
      } else if (cannotRate >= 0.35 && Number(avgSplitClose || 0) >= 0.75) {
        likelyCause = 'visual difference too small';
        issueArea = 'UI issue';
      } else if (cannotRate >= 0.3 && Number(avgMinPixels || 999) <= 20) {
        likelyCause = 'crop/resize artifact';
        issueArea = 'pipeline issue';
      } else if (cannotRate >= 0.3 && group.type === 'module' && String(slice.slice_key).includes('under_eye')) {
        likelyCause = 'task ambiguous';
        issueArea = 'instruction issue';
      } else if (
        disagreementRate >= 0.4
        && (
          Number(avgHair || 0) >= 0.15
          || Number(avgLeakage || 0) >= 0.1
          || Number(avgMinPixels || 999) <= 24
        )
      ) {
        likelyCause = 'model outputs unstable';
        issueArea = 'model issue';
      } else if (group.type === 'source' && String(slice.slice_key) === 'internal' && disagreementRate >= Number(globalDisagreementRate || 0) + 0.1) {
        likelyCause = 'internal photo style mismatch';
        issueArea = 'model issue';
      }

      candidates.push({
        slice_type: group.type,
        slice_key: slice.slice_key,
        n_votes: slice.n_votes,
        cannot_tell_rate: slice.cannot_tell_rate,
        disagreement_rate: slice.disagreement_rate,
        avg_split_close: avgSplitClose,
        avg_hair_overlap: avgHair,
        avg_leakage_bg: avgLeakage,
        avg_min_module_pixels: avgMinPixels,
        avg_overlay_diff_ratio: avgOverlayDiff,
        likely_cause: likelyCause,
        issue_area: issueArea,
        score,
      });
    }
  }

  return candidates
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0)
      || Number(b.cannot_tell_rate || 0) - Number(a.cannot_tell_rate || 0)
      || Number(b.disagreement_rate || 0) - Number(a.disagreement_rate || 0)
      || String(a.slice_type).localeCompare(String(b.slice_type))
      || String(a.slice_key).localeCompare(String(b.slice_key)));
}

function buildActions({
  overall,
  moduleRows,
  sourceRows,
  driverRows,
  iaa,
  crosssetSummary,
}) {
  const forehead = moduleRows.find((row) => String(row.slice_key) === 'forehead') || null;
  const underEye = moduleRows.find((row) => String(row.slice_key).includes('under_eye')) || null;
  const internal = sourceRows.find((row) => String(row.slice_key) === 'internal') || null;

  const topCannotDriver = driverRows.find((row) => Number(row.cannot_tell_rate || 0) >= 0.25) || driverRows[0] || null;
  const topDisagreeDriver = driverRows.find((row) => Number(row.disagreement_rate || 0) >= 0.35) || driverRows[0] || null;

  const actions = [
    {
      title: 'Increase visual separability in A/B overlays',
      what_to_change: 'Update `scripts/preference_round1_real_runbook.mjs` overlay rendering to add contour-diff inset and run a focused sweep with `PREFERENCE_MAX_EDGE=768`.',
      target_slice: topCannotDriver ? `${topCannotDriver.slice_type}:${topCannotDriver.slice_key}` : 'overall cannot_tell-heavy samples',
      why: `cannot_tell_rate=${topCannotDriver ? topCannotDriver.cannot_tell_rate ?? '-' : '-'} with avg_split_close=${topCannotDriver ? topCannotDriver.avg_split_close ?? '-' : '-'} indicates small visible deltas.`,
      validate: 'Run `make preference-round1-real-pack ... TARGET_TOTAL=80 PREFERENCE_MAX_EDGE=768` then `make preference-final ...`; expect cannot_tell_rate to drop by >=0.05 without lowering IAA.',
    },
    {
      title: 'Tighten labeling rubric for ambiguous modules',
      what_to_change: 'Refine `label_studio/project_preference_ab.xml` instructions and `docs/GOLD_LABELING_GUIDE.md` for tie/cannot_tell usage on under-eye and low-detail regions.',
      target_slice: underEye ? `module:${underEye.slice_key}` : 'module:under_eye_*',
      why: `under-eye slice cannot_tell_rate=${underEye ? underEye.cannot_tell_rate ?? '-' : '-'} and disagreement_rate=${underEye ? underEye.disagreement_rate ?? '-' : '-'}.`,
      validate: 'Re-run overlap subset (>=40) and check IAA improves (kappa +0.05) while cannot_tell on under-eye decreases.',
    },
    {
      title: 'Harden forehead hair/skin boundary behavior',
      what_to_change: 'Keep hair-aware forehead clip path and prioritize forehead/hair hard cases for skinmask+hair-mask retraining decision; tune oval clip params in offline AB (`DIAG_FACE_OVAL_CLIP_MIN_PIXELS`, `DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO`).',
      target_slice: 'forehead + high hair_overlap_est',
      why: `forehead variant win=${forehead ? forehead.variant1_win_rate ?? '-' : '-'}, baseline win=${forehead ? forehead.baseline_win_rate ?? '-' : '-'}; disagreement driver highlights boundary instability.`,
      validate: 'Run `make eval-gold-ab ...` + preference rerun on hair-high subset; expect forehead variant win +>=0.10 and lower disagreement in high-hair bucket.',
    },
    {
      title: 'Stabilize hard-case guard strategy',
      what_to_change: 'Tune guard behavior on hard samples via offline variant sweep (variant2 under-eye guard relaxation + fallback behavior) and compare only guard-triggered subset.',
      target_slice: topDisagreeDriver ? `${topDisagreeDriver.slice_type}:${topDisagreeDriver.slice_key}` : 'guard_triggered samples',
      why: `high disagreement slice score=${topDisagreeDriver ? topDisagreeDriver.score ?? '-' : '-'} suggests unstable model outputs on hard cases.`,
      validate: 'Run a guard-triggered mini-pack (`TARGET_TOTAL=80`, stress-heavy) and expect disagreement_rate drop by >=0.08 with no increase in cannot_tell.',
    },
    {
      title: 'Address internal style mismatch and pipeline artifacts',
      what_to_change: 'If internal remains worse, add internal-style slices to training/eval packs and inspect crop pipeline (`input_thumb` generation) for over-aggressive resizing.',
      target_slice: internal ? `source:${internal.slice_key}` : 'source:internal',
      why: `internal disagreement_rate=${internal ? internal.disagreement_rate ?? '-' : '-'} vs overall=${overall.disagreement_rate ?? '-'}; crossset leakage=${crosssetSummary && crosssetSummary.max_leakage_bg_mean != null ? crosssetSummary.max_leakage_bg_mean : '-'}.`,
      validate: 'Run internal-only preference round (`LIMIT_INTERNAL` up, external down) and confirm internal cannot_tell/disagreement converge toward external slices.',
    },
  ];

  const adjusted = actions.map((action, index) => ({
    rank: index + 1,
    ...action,
  }));

  return adjusted.slice(0, 5);
}

function buildCrosssetSummary(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const normalized = rows
    .map((row) => ({
      dataset: String(row.dataset || row.source || row.name || '').trim().toLowerCase(),
      leakage_bg_mean: parseNumber(row.leakage_bg_mean != null ? row.leakage_bg_mean : row.leakage_bg),
      leakage_hair_mean: parseNumber(row.leakage_hair_mean != null ? row.leakage_hair_mean : row.leakage_hair),
      strong_module_miou_mean: parseNumber(row.strong_module_miou_mean != null ? row.strong_module_miou_mean : row.strong_module_mIoU_mean),
    }))
    .filter((row) => row.dataset);

  if (!normalized.length) return null;

  const byDataset = new Map();
  for (const row of normalized) {
    if (!byDataset.has(row.dataset)) byDataset.set(row.dataset, []);
    byDataset.get(row.dataset).push(row);
  }

  const perDataset = [...byDataset.entries()].map(([dataset, items]) => ({
    dataset,
    leakage_bg_mean: average(items.map((item) => item.leakage_bg_mean)),
    leakage_hair_mean: average(items.map((item) => item.leakage_hair_mean)),
    strong_module_miou_mean: average(items.map((item) => item.strong_module_miou_mean)),
  }))
    .sort((a, b) => String(a.dataset).localeCompare(String(b.dataset)));

  const maxLeak = perDataset
    .map((row) => Number(row.leakage_bg_mean))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  return {
    per_dataset: perDataset,
    max_leakage_bg_mean: Number.isFinite(maxLeak) ? round3(maxLeak) : null,
  };
}

function parseGoldEvalMarkdown(raw) {
  if (!raw) return null;
  const text = String(raw || '');
  const keyPatterns = [
    'strong_module_mIoU_mean',
    'forehead_hair_overlap_rate_mean',
    'under_eye_band_coverage_p50',
    'leakage_bg_mean',
  ];

  const metrics = {};
  for (const key of keyPatterns) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\|\\s*${escaped}\\s*\\|\\s*([0-9.]+)\\s*\\|`, 'i');
    const match = text.match(regex);
    if (match) metrics[key] = round3(Number(match[1]));
  }

  return Object.keys(metrics).length ? metrics : null;
}

function renderSliceTable(title, sliceRows, sliceLabel = 'slice') {
  const lines = [];
  lines.push(`### ${title}`);
  lines.push('');
  lines.push(`| ${sliceLabel} | n votes | baseline win | variant1 win | tie | cannot_tell | baseline CI | variant1 CI |`);
  lines.push('|---|---:|---:|---:|---:|---:|---|---|');

  if (!sliceRows.length) {
    lines.push('| - | - | - | - | - | - | - | - |');
  } else {
    sliceRows.forEach((row) => {
      lines.push(`| ${row.slice_key} | ${row.n_votes} | ${row.baseline_win_rate ?? '-'} | ${row.variant1_win_rate ?? '-'} | ${row.tie_rate ?? '-'} | ${row.cannot_tell_rate ?? '-'} | [${row.baseline_wilson_low ?? '-'}, ${row.baseline_wilson_high ?? '-'}] | [${row.variant1_wilson_low ?? '-'}, ${row.variant1_wilson_high ?? '-'}] |`);
    });
  }

  lines.push('');
  return lines;
}

function renderMarkdown({
  runId,
  inputRel,
  verdict,
  overall,
  iaa,
  overlayGate,
  slices,
  drivers,
  actions,
  contentiousRel,
  contentiousCount,
  crosssetSummary,
  goldSummary,
}) {
  const lines = [];
  lines.push('# Preference Diagnostics v1');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- manifest: \`${inputRel.manifest}\``);
  lines.push(`- eval_input: \`${inputRel.eval}\``);
  lines.push(`- labels: \`${inputRel.labels}\``);
  if (inputRel.crossset) lines.push(`- crossset: \`${inputRel.crossset}\``);
  if (inputRel.gold_eval_md) lines.push(`- gold_eval_md: \`${inputRel.gold_eval_md}\``);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- final_verdict: **${verdict}**`);
  lines.push(`- overall win/tie/cannot_tell: baseline=${overall.baseline_win_rate ?? '-'} variant1=${overall.variant1_win_rate ?? '-'} tie=${overall.tie_rate ?? '-'} cannot_tell=${overall.cannot_tell_rate ?? '-'} (n=${overall.n_votes})`);
  lines.push(`- Wilson CI: baseline=[${overall.baseline_wilson_low ?? '-'}, ${overall.baseline_wilson_high ?? '-'}], variant1=[${overall.variant1_wilson_low ?? '-'}, ${overall.variant1_wilson_high ?? '-'}]`);
  lines.push(`- overlap IAA: agreement=${iaa.overall_simple_agreement ?? '-'}, kappa=${iaa.overall_kappa ?? '-'}, overlap_labeled_by_2plus=${iaa.overlap_samples_labeled_by_2plus}/${iaa.overlap_samples_total}, sufficient=${iaa.sufficient ? 'yes' : 'no'}`);
  lines.push('');

  lines.push('## Overlay Consistency Gate');
  lines.push('');
  lines.push(`- pass: ${overlayGate.pass ? 'yes' : 'no'}`);
  lines.push(`- coverage_rate: ${overlayGate.rates.coverage_rate} (min ${overlayGate.thresholds.coverage_min})`);
  lines.push(`- consistency_rate: ${overlayGate.rates.consistency_rate} (min ${overlayGate.thresholds.consistency_min}, eps=${overlayGate.thresholds.epsilon})`);
  lines.push(`- eval_rows_total: ${overlayGate.counts.eval_rows_total}`);
  lines.push(`- top_issues: ${overlayGate.top_issues.length}`);
  lines.push('');

  lines.push('## Where The Signal Comes From');
  lines.push('');
  lines.push(...renderSliceTable('By Source', slices.by_source, 'source'));
  lines.push(...renderSliceTable('By Module', slices.by_module, 'module'));
  lines.push(...renderSliceTable('By Hair Overlap Bucket', slices.by_risk_hair, 'hair_overlap_bucket'));
  lines.push(...renderSliceTable('By Leakage BG Bucket', slices.by_risk_leakage, 'leakage_bg_bucket'));
  lines.push(...renderSliceTable('By Min Module Pixels Bucket', slices.by_risk_min_pixels, 'min_module_pixels_bucket'));
  lines.push(...renderSliceTable('By Guard Triggered', slices.by_guard, 'guard_triggered'));
  lines.push(...renderSliceTable('By Overlay Diff Bucket', slices.by_overlay_diff, 'overlay_diff_bucket'));
  lines.push(...renderSliceTable('By Confidence Bucket', slices.by_confidence, 'confidence_bucket'));

  lines.push('## Disagreement Diagnosis');
  lines.push('');
  lines.push('Likely-cause labels used: `visual difference too small`, `task ambiguous`, `model outputs unstable`, `crop/resize artifact`, `internal photo style mismatch`, `hair/skin boundary issue`.');
  lines.push('');
  lines.push('| rank | slice | n votes | cannot_tell | disagreement | likely cause | issue area | evidence(avg split/hair/leak/minpx/overlay_diff) |');
  lines.push('|---:|---|---:|---:|---:|---|---|---|');
  if (!drivers.length) {
    lines.push('| 1 | - | - | - | - | - | - | - |');
  } else {
    drivers.slice(0, 12).forEach((row, idx) => {
      const evidence = `${row.avg_split_close ?? '-'} / ${row.avg_hair_overlap ?? '-'} / ${row.avg_leakage_bg ?? '-'} / ${row.avg_min_module_pixels ?? '-'} / ${row.avg_overlay_diff_ratio ?? '-'}`;
      lines.push(`| ${idx + 1} | ${row.slice_type}:${row.slice_key} | ${row.n_votes} | ${row.cannot_tell_rate ?? '-'} | ${row.disagreement_rate ?? '-'} | ${row.likely_cause} | ${row.issue_area} | ${evidence} |`);
    });
  }
  lines.push('');

  const overlayLow = slices.by_overlay_diff.find((row) => String(row.slice_key || '') === 'very_low(<0.01)') || null;
  lines.push('## Proposer Input Summary');
  lines.push('');
  lines.push(`- suggested_overlay_diff_filter_min: 0.01`);
  lines.push(`- very_low_overlay_diff_vote_rate: ${round3(overlayLow && overlayLow.n_votes > 0 ? overlayLow.n_votes / Math.max(1, overall.n_votes || 1) : 0)}`);
  lines.push(`- proposer_hint: prioritize samples with overlay_diff_ratio>=0.01; downweight overlay_diff_ratio<0.01 when cannot_tell-heavy.`);
  lines.push('');

  lines.push('## Action Recommendations');
  lines.push('');
  lines.push('| rank | action title | what to change | target slice | why | how to validate |');
  lines.push('|---:|---|---|---|---|---|');
  actions.forEach((row) => {
    lines.push(`| ${row.rank} | ${row.title} | ${row.what_to_change.replace(/\|/g, '/')} | ${row.target_slice.replace(/\|/g, '/')} | ${row.why.replace(/\|/g, '/')} | ${row.validate.replace(/\|/g, '/')} |`);
  });
  lines.push('');

  if (crosssetSummary) {
    lines.push('## Optional Crossset Context');
    lines.push('');
    lines.push('| dataset | strong_module_mIoU_mean | leakage_bg_mean | leakage_hair_mean |');
    lines.push('|---|---:|---:|---:|');
    crosssetSummary.per_dataset.forEach((row) => {
      lines.push(`| ${row.dataset} | ${row.strong_module_miou_mean ?? '-'} | ${row.leakage_bg_mean ?? '-'} | ${row.leakage_hair_mean ?? '-'} |`);
    });
    lines.push('');
  }

  if (goldSummary) {
    lines.push('## Optional Gold Eval Context');
    lines.push('');
    lines.push('| metric | value |');
    lines.push('|---|---:|');
    for (const key of Object.keys(goldSummary).sort()) {
      lines.push(`| ${key} | ${goldSummary[key]} |`);
    }
    lines.push('');
  }

  lines.push('## Contentious Export');
  lines.push('');
  lines.push(`- file: \`${contentiousRel}\``);
  lines.push(`- samples: ${contentiousCount}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }

  if (!args.manifest) {
    process.stderr.write('preference_diagnostics: missing --manifest\n');
    process.exit(2);
    return;
  }
  if (!args.eval_jsonl) {
    process.stderr.write('preference_diagnostics: missing --eval_jsonl\n');
    process.exit(2);
    return;
  }
  if (!args.labels && !args.overlay_gate_only) {
    process.stderr.write('preference_diagnostics: missing --labels\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const manifestPath = path.resolve(args.manifest);
  const evalPath = path.resolve(args.eval_jsonl);
  const labelsPath = args.labels ? path.resolve(args.labels) : null;
  const outDir = path.resolve(args.out_dir);
  const diagnosticsMdPath = path.resolve(path.join(outDir, `preference_diagnostics_${runId}.md`));
  const diagnosticsJsonPath = path.resolve(path.join(outDir, `preference_diagnostics_${runId}.json`));
  const contentiousPath = path.resolve(path.join('artifacts', `preference_contentious_${runId}.jsonl`));

  await Promise.all([
    fsp.mkdir(outDir, { recursive: true }),
    fsp.mkdir(path.dirname(contentiousPath), { recursive: true }),
  ]);

  const manifestRaw = await fsp.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  const manifestMap = new Map();
  const manifestRows = Array.isArray(manifest && manifest.rows) ? manifest.rows : [];
  for (const rawRow of manifestRows) {
    const row = normalizeManifestRow(rawRow);
    if (!row) continue;
    manifestMap.set(row.sample_id, row);
  }

  const evalLoaded = await loadEvalRows(evalPath);
  const evalRows = Array.isArray(evalLoaded.sample_rows) ? evalLoaded.sample_rows : [];

  const overlayGate = evaluateOverlayConsistencyGate({
    manifestMap,
    evalRows,
    coverageMin: args.overlay_gate_coverage_min,
    consistencyMin: args.overlay_gate_consistency_min,
    epsilon: args.overlay_gate_epsilon,
  });

  if (args.overlay_gate_only) {
    if (!overlayGate.pass) {
      process.stderr.write(renderOverlayGateFailureTable(overlayGate));
      process.exit(3);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      run_id: runId,
      overlay_consistency_gate: overlayGate,
      inputs: {
        manifest: toPosix(path.relative(process.cwd(), manifestPath)),
        eval: toPosix(path.relative(process.cwd(), evalPath)),
      },
    }, null, 2)}\n`);
    process.exit(0);
    return;
  }

  if (!args.skip_overlay_gate && !overlayGate.pass) {
    process.stderr.write(renderOverlayGateFailureTable(overlayGate));
    process.exit(3);
    return;
  }

  const overlapSet = new Set(
    Array.isArray(manifest && manifest.overlap && manifest.overlap.sample_ids)
      ? manifest.overlap.sample_ids.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  );

  const labelRawRows = await readJsonlRows(labelsPath);
  const labelRows = sortRowsStable(
    labelRawRows
      .map((row) => normalizeLabelRow(row, manifestMap.get(String((row && (row.sample_id || row.sample_hash)) || '').trim()) || null))
      .filter(Boolean),
  );

  const overallLabelRows = labelRows.filter((row) => String(row.module_id || 'overall') === 'overall' && normalizeChoice(row.winner));
  const evalRowsFallback = buildSampleStatsFromLabels(overallLabelRows);
  const evalRowsResolved = Array.isArray(evalLoaded.sample_rows) && evalLoaded.sample_rows.length
    ? evalLoaded.sample_rows
    : evalRowsFallback;

  const sampleEvalMap = buildSampleEvalMap(evalRowsResolved, manifestMap);

  const overallVotes = [];
  const moduleVotes = [];

  for (const row of overallLabelRows) {
    const sampleId = row.sample_id;
    const source = row.source || (manifestMap.get(sampleId) && manifestMap.get(sampleId).source) || 'unknown';
    const hair = row.hair_overlap_est;
    const leakage = row.leakage_bg_est_mean;
    const minPixels = row.min_module_pixels;
    const overlayDiff = row.overlay_diff_ratio;
    const guard = row.guard_triggered;
    const confBucket = bucketConfidence(row.confidence_int);

    const baseVote = {
      sample_id: sampleId,
      source,
      choice: normalizeChoice(row.winner),
      confidence_bucket: confBucket,
      hair_bucket: bucketHair(hair),
      leakage_bucket: bucketLeakage(leakage),
      min_pixels_bucket: bucketMinPixels(minPixels),
      overlay_diff_bucket: bucketOverlayDiff(overlayDiff),
      guard_bucket: guard == null ? 'unknown' : (guard ? 'yes' : 'no'),
    };

    if (baseVote.choice) overallVotes.push(baseVote);

    for (const moduleId of MODULE_IDS) {
      const moduleChoiceRaw = row.per_module_choice && typeof row.per_module_choice === 'object'
        ? row.per_module_choice[moduleId]
        : null;
      const moduleChoice = normalizeChoice(moduleChoiceRaw);
      if (!moduleChoice) continue;
      moduleVotes.push({
        ...baseVote,
        module: moduleId,
        choice: moduleChoice,
      });
    }
  }

  const overallCounts = emptyCounts();
  overallVotes.forEach((vote) => {
    if (vote.choice) overallCounts[vote.choice] += 1;
  });
  const overallSummary = buildRateRow({
    key: 'overall',
    counts: overallCounts,
    sampleIds: new Set(overallVotes.map((vote) => String(vote.sample_id || '')).filter(Boolean)),
  });

  const slices = {
    by_source: summarizeVotes(overallVotes, (vote) => vote.source || 'unknown'),
    by_module: summarizeVotes(moduleVotes, (vote) => vote.module || 'unknown'),
    by_risk_hair: summarizeVotes(overallVotes, (vote) => vote.hair_bucket || 'unknown'),
    by_risk_leakage: summarizeVotes(overallVotes, (vote) => vote.leakage_bucket || 'unknown'),
    by_risk_min_pixels: summarizeVotes(overallVotes, (vote) => vote.min_pixels_bucket || 'unknown'),
    by_guard: summarizeVotes(overallVotes, (vote) => vote.guard_bucket || 'unknown'),
    by_overlay_diff: summarizeVotes(overallVotes, (vote) => vote.overlay_diff_bucket || 'unknown'),
    by_confidence: summarizeVotes(overallVotes, (vote) => vote.confidence_bucket || 'unknown'),
  };

  const overlapRowsBySample = new Map();
  for (const row of overallLabelRows) {
    const sampleId = String(row.sample_id || '').trim();
    if (!sampleId) continue;
    if (!overlapSet.has(sampleId) && String(row.task_batch || '').toUpperCase() !== 'OVERLAP') continue;
    if (!overlapRowsBySample.has(sampleId)) overlapRowsBySample.set(sampleId, []);
    overlapRowsBySample.get(sampleId).push(row);
  }

  const iaaPairs = [];
  let overlapLabeledBy2Plus = 0;
  for (const rows of overlapRowsBySample.values()) {
    const byRater = pickLatestByRater(rows);
    const raters = [...byRater.keys()].sort((a, b) => a.localeCompare(b));
    if (raters.length < 2) continue;
    overlapLabeledBy2Plus += 1;
    for (let i = 0; i < raters.length; i += 1) {
      for (let j = i + 1; j < raters.length; j += 1) {
        const a = normalizeChoice(byRater.get(raters[i]).winner);
        const b = normalizeChoice(byRater.get(raters[j]).winner);
        if (a && b) iaaPairs.push([a, b]);
      }
    }
  }

  const iaaAgreement = iaaPairs.length
    ? round3(iaaPairs.filter(([a, b]) => a === b).length / iaaPairs.length)
    : null;
  const iaaKappa = round3(computeKappa(iaaPairs, CHOICES));
  const iaaSufficient = iaaKappa != null
    ? iaaKappa >= 0.2
    : iaaAgreement != null
      ? iaaAgreement >= 0.6
      : false;

  const iaa = {
    overall_simple_agreement: iaaAgreement,
    overall_kappa: iaaKappa,
    overlap_samples_total: overlapSet.size || overlapRowsBySample.size,
    overlap_samples_labeled_by_2plus: overlapLabeledBy2Plus,
    sufficient: iaaSufficient,
  };

  const finalMdCandidates = [
    path.resolve(path.join(outDir, `PREFERENCE_FINAL_${runId}.md`)),
    path.resolve(path.join('reports', `PREFERENCE_FINAL_${runId}.md`)),
    path.resolve(path.join(outDir, `RELEASE_GATE_PREFERENCE_${runId}.md`)),
    path.resolve(path.join('reports', `RELEASE_GATE_PREFERENCE_${runId}.md`)),
  ];
  let finalVerdict = null;
  for (const candidate of finalMdCandidates) {
    const stat = await fsp.stat(candidate).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const mdRaw = await fsp.readFile(candidate, 'utf8');
    finalVerdict = resolveFinalVerdictFromMarkdown(mdRaw);
    if (finalVerdict) break;
  }
  if (!finalVerdict) {
    finalVerdict = resolveFinalVerdictFallback(overallSummary, slices.by_module, iaa);
  }

  const globalDisagreementRate = overallSummary.disagreement_rate != null ? Number(overallSummary.disagreement_rate) : 0;
  const drivers = buildDriverCandidates([
    { type: 'source', rows: slices.by_source },
    { type: 'module', rows: slices.by_module },
    { type: 'hair_bucket', rows: slices.by_risk_hair },
    { type: 'leakage_bucket', rows: slices.by_risk_leakage },
    { type: 'min_pixels_bucket', rows: slices.by_risk_min_pixels },
    { type: 'guard_triggered', rows: slices.by_guard },
    { type: 'overlay_diff_bucket', rows: slices.by_overlay_diff },
    { type: 'confidence', rows: slices.by_confidence },
  ], sampleEvalMap, globalDisagreementRate);

  const moduleDisagreementBySample = new Map();
  const rowsBySample = new Map();
  for (const row of overallLabelRows) {
    const sampleId = String(row.sample_id || '').trim();
    if (!sampleId) continue;
    if (!rowsBySample.has(sampleId)) rowsBySample.set(sampleId, []);
    rowsBySample.get(sampleId).push(row);
  }

  for (const [sampleId, rows] of rowsBySample.entries()) {
    const byRater = pickLatestByRater(rows);
    const modulesInvolved = [];
    for (const moduleId of MODULE_IDS) {
      const choices = [];
      for (const row of byRater.values()) {
        const moduleChoiceRaw = row.per_module_choice && typeof row.per_module_choice === 'object'
          ? row.per_module_choice[moduleId]
          : null;
        const moduleChoice = normalizeChoice(moduleChoiceRaw);
        if (moduleChoice) choices.push(moduleChoice);
      }
      if (choices.length < 2) continue;
      const distinct = new Set(choices);
      if (distinct.size > 1 || distinct.has('cannot_tell')) {
        modulesInvolved.push(moduleId);
      }
    }
    moduleDisagreementBySample.set(sampleId, modulesInvolved.sort((a, b) => a.localeCompare(b)));
  }

  const contentiousRows = [...sampleEvalMap.values()]
    .map((row) => {
      const modulesInvolved = moduleDisagreementBySample.get(row.sample_id) || [];
      const risk = {
        hair_overlap_est: row.hair_overlap_est,
        leakage_bg_est_mean: row.leakage_bg_est_mean,
        min_module_pixels: row.min_module_pixels,
        overlay_diff_pixels: row.overlay_diff_pixels,
        overlay_diff_ratio: row.overlay_diff_ratio,
        overlay_focus_module: row.overlay_focus_module,
        guard_triggered: row.guard_triggered,
      };
      return {
        sample_id: row.sample_id,
        source: row.source,
        modules_involved: modulesInvolved,
        disagreement_stats: {
          cannot_tell_rate: row.cannot_tell_rate,
          disagreement_rate: row.disagreement_rate,
          low_confidence_rate: row.low_confidence_rate,
          contentious_score: row.contentious_score,
          annotators_total: row.annotators_total,
          total_votes: row.total_votes,
        },
        risk_features: risk,
        _sort_score: Number(row.contentious_score || 0),
      };
    })
    .filter((row) => {
      const cannot = Number(row.disagreement_stats.cannot_tell_rate || 0);
      const disagree = Number(row.disagreement_stats.disagreement_rate || 0);
      const lowConf = Number(row.disagreement_stats.low_confidence_rate || 0);
      const risk = row.risk_features;
      return (
        cannot > 0
        || disagree > 0
        || lowConf > 0
        || row.modules_involved.length > 0
        || Number(risk.hair_overlap_est || 0) >= 0.2
        || Number(risk.leakage_bg_est_mean || 0) >= 0.1
        || (Number.isFinite(Number(risk.min_module_pixels)) && Number(risk.min_module_pixels) <= 24)
        || (Number.isFinite(Number(risk.overlay_diff_ratio)) && Number(risk.overlay_diff_ratio) < 0.01)
        || risk.guard_triggered === true
      );
    })
    .sort((a, b) => Number(b._sort_score || 0) - Number(a._sort_score || 0)
      || Number(b.disagreement_stats.cannot_tell_rate || 0) - Number(a.disagreement_stats.cannot_tell_rate || 0)
      || Number(b.disagreement_stats.disagreement_rate || 0) - Number(a.disagreement_stats.disagreement_rate || 0)
      || String(a.sample_id).localeCompare(String(b.sample_id)));

  const contentiousPayload = contentiousRows
    .map((row) => {
      const out = { ...row };
      delete out._sort_score;
      return out;
    });

  const contentiousNdjson = contentiousPayload.length
    ? `${contentiousPayload.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';
  await fsp.writeFile(contentiousPath, contentiousNdjson, 'utf8');

  let crosssetSummary = null;
  if (args.crossset_jsonl) {
    const crosssetPath = path.resolve(args.crossset_jsonl);
    const ext = String(path.extname(crosssetPath) || '').trim().toLowerCase();
    let crossRows = [];
    if (ext === '.jsonl' || ext === '.ndjson') {
      crossRows = await readJsonlRows(crosssetPath);
    } else if (ext === '.json') {
      const parsed = await readJsonPathMaybe(crosssetPath);
      if (Array.isArray(parsed)) crossRows = parsed;
      else if (parsed && Array.isArray(parsed.rows)) crossRows = parsed.rows;
      else if (parsed && parsed.datasets && typeof parsed.datasets === 'object') {
        crossRows = Object.entries(parsed.datasets).map(([dataset, value]) => ({ dataset, ...(value || {}) }));
      }
    }
    crosssetSummary = buildCrosssetSummary(crossRows);
  }

  let goldSummary = null;
  if (args.gold_eval_md) {
    const goldPath = path.resolve(args.gold_eval_md);
    const stat = await fsp.stat(goldPath).catch(() => null);
    if (stat && stat.isFile()) {
      const raw = await fsp.readFile(goldPath, 'utf8');
      goldSummary = parseGoldEvalMarkdown(raw);
    }
  }

  const actions = buildActions({
    overall: overallSummary,
    moduleRows: slices.by_module,
    sourceRows: slices.by_source,
    driverRows: drivers,
    iaa,
    crosssetSummary,
  });

  const overlayVeryLowSlice = slices.by_overlay_diff.find((row) => String(row.slice_key || '') === 'very_low(<0.01)') || null;
  const overlayVeryLowVoteRate = overlayVeryLowSlice && overallSummary.n_votes
    ? round3(Number(overlayVeryLowSlice.n_votes || 0) / Math.max(1, Number(overallSummary.n_votes || 0)))
    : 0;

  const summaryJson = {
    ok: true,
    run_id: runId,
    final_verdict: finalVerdict,
    executive: {
      overall: overallSummary,
      iaa,
    },
    overlay_consistency_gate: overlayGate,
    slices: {
      by_source: slices.by_source.map((row) => ({ ...row, _sample_ids: undefined })),
      by_module: slices.by_module.map((row) => ({ ...row, _sample_ids: undefined })),
      by_risk_hair: slices.by_risk_hair.map((row) => ({ ...row, _sample_ids: undefined })),
      by_risk_leakage: slices.by_risk_leakage.map((row) => ({ ...row, _sample_ids: undefined })),
      by_risk_min_pixels: slices.by_risk_min_pixels.map((row) => ({ ...row, _sample_ids: undefined })),
      by_guard: slices.by_guard.map((row) => ({ ...row, _sample_ids: undefined })),
      by_overlay_diff: slices.by_overlay_diff.map((row) => ({ ...row, _sample_ids: undefined })),
      by_confidence: slices.by_confidence.map((row) => ({ ...row, _sample_ids: undefined })),
    },
    disagreement_drivers: drivers.slice(0, 12),
    actions,
    contentious_export: {
      path: toPosix(path.relative(process.cwd(), contentiousPath)),
      samples: contentiousPayload.length,
    },
    optional_context: {
      crossset: crosssetSummary,
      gold_eval: goldSummary,
    },
    proposer_summary: {
      suggested_overlay_diff_filter_min: 0.01,
      very_low_overlay_diff_vote_rate: overlayVeryLowVoteRate,
      guidance: 'prioritize contentious samples with overlay_diff_ratio>=0.01 and downweight overlay_diff_ratio<0.01',
    },
    generated_at: new Date().toISOString(),
    inputs: {
      manifest: toPosix(path.relative(process.cwd(), manifestPath)),
      eval: toPosix(path.relative(process.cwd(), evalPath)),
      labels: toPosix(path.relative(process.cwd(), labelsPath)),
      crossset: args.crossset_jsonl ? toPosix(path.relative(process.cwd(), path.resolve(args.crossset_jsonl))) : null,
      gold_eval_md: args.gold_eval_md ? toPosix(path.relative(process.cwd(), path.resolve(args.gold_eval_md))) : null,
    },
    artifacts: {
      diagnostics_md: toPosix(path.relative(process.cwd(), diagnosticsMdPath)),
      diagnostics_json: toPosix(path.relative(process.cwd(), diagnosticsJsonPath)),
      contentious_jsonl: toPosix(path.relative(process.cwd(), contentiousPath)),
    },
  };

  const markdown = renderMarkdown({
    runId,
    inputRel: summaryJson.inputs,
    verdict: finalVerdict,
    overall: overallSummary,
    iaa,
    overlayGate,
    slices,
    drivers,
    actions,
    contentiousRel: summaryJson.artifacts.contentious_jsonl,
    contentiousCount: contentiousPayload.length,
    crosssetSummary,
    goldSummary,
  });

  await Promise.all([
    fsp.writeFile(diagnosticsMdPath, markdown, 'utf8'),
    fsp.writeFile(diagnosticsJsonPath, `${JSON.stringify(summaryJson, null, 2)}\n`, 'utf8'),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    final_verdict: finalVerdict,
    overlay_consistency_gate: overlayGate,
    actions_count: actions.length,
    disagreement_drivers_count: summaryJson.disagreement_drivers.length,
    contentious_samples: contentiousPayload.length,
    artifacts: summaryJson.artifacts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_diagnostics_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
