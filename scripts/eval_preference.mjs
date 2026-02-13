#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey } from './internal_batch_helpers.mjs';

const MODULE_IDS = Object.freeze([
  'nose',
  'forehead',
  'left_cheek',
  'right_cheek',
  'chin',
  'under_eye_left',
  'under_eye_right',
]);

const CHOICE_CATS = Object.freeze(['baseline', 'variant1', 'tie', 'cannot_tell']);

const HELP_TEXT = `eval_preference.mjs

Usage:
  node scripts/eval_preference.mjs --labels <preference_labels.ndjson> [options]

Required:
  --labels <path>                       preference labels ndjson

Options:
  --run_id <id>                         run id (default: infer from labels filename)
  --manifest <path>                     optional pack manifest json for risk features + overlap set
  --report_dir <dir>                    report output dir (default: reports)
  --out_jsonl <path>                    explicit per-sample jsonl path
  --help                                show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function round3(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function parseFiniteNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = parseFiniteNumber(value);
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

function parseArgs(argv) {
  const out = {
    help: false,
    labels: process.env.LABELS || process.env.PREFERENCE_LABELS || '',
    run_id: process.env.RUN_ID || '',
    manifest: process.env.MANIFEST || process.env.PREFERENCE_MANIFEST || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports',
    out_jsonl: process.env.OUT_JSONL || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!(key in out)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    i += 1;
  }

  out.help = parseBool(out.help, false);
  out.labels = String(out.labels || '').trim();
  out.run_id = String(out.run_id || '').trim();
  out.manifest = String(out.manifest || '').trim();
  out.report_dir = String(out.report_dir || 'reports').trim() || 'reports';
  out.out_jsonl = String(out.out_jsonl || '').trim();
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  const base = path.basename(String(args.labels || ''));
  const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
  if (match) return match[1];
  return runTimestampKey();
}

async function readNdjson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeChoice(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return null;
  if (token === 'baseline' || token === 'base') return 'baseline';
  if (token === 'variant' || token === 'variant1' || token === 'var') return 'variant1';
  if (token === 'tie' || token === 'equal' || token === 'same') return 'tie';
  if (token === 'cannot_tell' || token === 'cant_tell' || token === 'unknown' || token === 'unclear') return 'cannot_tell';
  if (CHOICE_CATS.includes(token)) return token;
  return null;
}

function normalizeConfidenceInt(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  if (n <= 1) return Math.max(1, Math.min(5, Math.round(n * 5)));
  if (n <= 5) return Math.max(1, Math.min(5, Math.round(n)));
  if (n <= 10) return Math.max(1, Math.min(5, Math.round(n / 2)));
  if (n <= 100) return Math.max(1, Math.min(5, Math.round(n / 20)));
  return 5;
}

function normalizeConfidence(raw) {
  const ci = normalizeConfidenceInt(raw);
  if (ci != null) return ci / 5;

  const token = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!token) return null;
  if (token === 'high') return 0.9;
  if (token === 'medium' || token === 'mid') return 0.6;
  if (token === 'low') return 0.3;
  return null;
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
  return CHOICE_CATS.reduce((acc, key) => acc + Number(counts[key] || 0), 0);
}

function wilsonInterval(success, total, z = 1.96) {
  const n = Number(total);
  const s = Number(success);
  if (!Number.isFinite(n) || !Number.isFinite(s) || n <= 0) {
    return { low: null, high: null };
  }
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

function ratesFromCounts(counts) {
  const total = countTotal(counts);
  const headToHead = Number(counts.baseline || 0) + Number(counts.variant1 || 0);
  const majority = CHOICE_CATS.map((key) => ({ key, value: Number(counts[key] || 0) }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))[0];
  const maxVotes = majority ? majority.value : 0;

  const variantCi = wilsonInterval(Number(counts.variant1 || 0), headToHead);
  const baselineCi = wilsonInterval(Number(counts.baseline || 0), headToHead);

  return {
    total_votes: total,
    majority_choice: total > 0 ? majority.key : null,
    disagreement_rate: total > 0 ? round3(1 - (maxVotes / total)) : null,
    tie_rate: total > 0 ? round3(Number(counts.tie || 0) / total) : null,
    cannot_tell_rate: total > 0 ? round3(Number(counts.cannot_tell || 0) / total) : null,
    baseline_win_rate: headToHead > 0 ? round3(Number(counts.baseline || 0) / headToHead) : null,
    variant1_win_rate: headToHead > 0 ? round3(Number(counts.variant1 || 0) / headToHead) : null,
    split_close_score: headToHead > 0
      ? round3(1 - (Math.abs(Number(counts.baseline || 0) - Number(counts.variant1 || 0)) / headToHead))
      : null,
    head_to_head_votes: headToHead,
    baseline_wilson_low: headToHead > 0 ? round3(baselineCi.low) : null,
    baseline_wilson_high: headToHead > 0 ? round3(baselineCi.high) : null,
    variant1_wilson_low: headToHead > 0 ? round3(variantCi.low) : null,
    variant1_wilson_high: headToHead > 0 ? round3(variantCi.high) : null,
  };
}

function computeKappa(pairs, categories = CHOICE_CATS) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const validPairs = pairs.filter((pair) => Array.isArray(pair) && pair.length === 2 && categories.includes(pair[0]) && categories.includes(pair[1]));
  if (!validPairs.length) return null;

  let agree = 0;
  const margA = Object.fromEntries(categories.map((cat) => [cat, 0]));
  const margB = Object.fromEntries(categories.map((cat) => [cat, 0]));

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

function buildManifestContext(manifest) {
  const rows = Array.isArray(manifest && manifest.rows) ? manifest.rows : [];
  const overlapSampleIds = new Set(
    Array.isArray(manifest && manifest.overlap && manifest.overlap.sample_ids)
      ? manifest.overlap.sample_ids.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
  );

  const rowMap = new Map();
  for (const row of rows) {
    const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
    if (!sampleId) continue;
    const taskBatch = String(row.task_batch || '').trim().toUpperCase() || null;
    if (taskBatch === 'OVERLAP') overlapSampleIds.add(sampleId);

    const risk = row && typeof row.risk_features === 'object' && row.risk_features
      ? row.risk_features
      : {};

    rowMap.set(sampleId, {
      source: String(row.source || '').trim().toLowerCase() || null,
      task_batch: taskBatch,
      risk_features: {
        hair_overlap_est: firstFiniteNumber(
          risk && risk.hair_overlap_est,
          row.hair_overlap_est,
          row.forehead_hair_overlap_est,
        ),
        leakage_bg_est_mean: firstFiniteNumber(
          risk && risk.leakage_bg_est_mean,
          row.leakage_bg_est_mean,
        ),
        min_module_pixels: (() => {
          const n = firstFiniteNumber(
            risk && risk.min_module_pixels,
            row.min_module_pixels,
            row.module_pixels_min,
          );
          return n == null ? null : Math.max(0, Math.trunc(n));
        })(),
        overlay_diff_pixels: (() => {
          const n = firstFiniteNumber(
            risk && risk.overlay_diff_pixels,
            risk && risk.diff_pixels,
            risk && risk.overlayDiffPixels,
            row.overlay_diff_pixels,
            row.diff_pixels,
            row.overlayDiffPixels,
          );
          return n == null ? null : Math.max(0, Math.trunc(n));
        })(),
        overlay_diff_ratio: firstFiniteNumber(
          risk && risk.overlay_diff_ratio,
          risk && risk.diff_ratio,
          risk && risk.overlayDiffRatio,
          row.overlay_diff_ratio,
          row.diff_ratio,
          row.overlayDiffRatio,
        ),
        overlay_focus_module: firstNonEmptyString(
          risk && risk.overlay_focus_module,
          risk && risk.overlayFocusModule,
          row.overlay_focus_module,
        ),
      },
      overlay_bbox: row && row.overlay_bbox && typeof row.overlay_bbox === 'object' ? row.overlay_bbox : null,
      overlay_zoom: (() => {
        const n = parseFiniteNumber(row && row.overlay_zoom);
        return n != null ? n : null;
      })(),
    });
  }

  return { row_map: rowMap, overlap_sample_ids: overlapSampleIds };
}

function normalizeLabelRow(row, manifestRow) {
  const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
  const winner = normalizeChoice(row.winner || row.overall_choice);
  const perModule = {};
  for (const moduleId of MODULE_IDS) {
    const rawChoice = row && row.per_module_choice && typeof row.per_module_choice === 'object'
      ? row.per_module_choice[moduleId]
      : null;
    perModule[moduleId] = normalizeChoice(rawChoice);
  }

  const confidenceInt = normalizeConfidenceInt(row.confidence_int != null ? row.confidence_int : row.confidence);
  const confidence = confidenceInt != null
    ? confidenceInt / 5
    : normalizeConfidence(row.confidence);

  const taskBatch = String(
    row.task_batch
    || (manifestRow && manifestRow.task_batch)
    || '',
  ).trim().toUpperCase() || null;

  const rawRisk = row && row.risk_features && typeof row.risk_features === 'object'
    ? row.risk_features
    : {};
  const manifestRisk = manifestRow && manifestRow.risk_features
    ? manifestRow.risk_features
    : {};

  return {
    sample_id: sampleId,
    source: String(row.source || (manifestRow && manifestRow.source) || 'unknown').trim().toLowerCase() || 'unknown',
    rater_id: String(row.rater_id || row.annotator_id || '').trim() || 'unknown_rater',
    annotation_id: String(row.annotation_id || '').trim() || null,
    winner,
    per_module_choice: perModule,
    reasons: Array.isArray(row.reasons) ? row.reasons.map((item) => String(item || '').trim()).filter(Boolean) : [],
    confidence,
    confidence_int: confidenceInt,
    created_at: row.created_at || (row.timestamps && row.timestamps.created_at) || null,
    updated_at: row.updated_at || (row.timestamps && row.timestamps.updated_at) || null,
    task_batch: taskBatch,
    overlap_sample: taskBatch === 'OVERLAP',
    risk_features: {
      hair_overlap_est: firstFiniteNumber(
        rawRisk.hair_overlap_est,
        row && row.hair_overlap_est,
        manifestRisk.hair_overlap_est,
      ),
      leakage_bg_est_mean: firstFiniteNumber(
        rawRisk.leakage_bg_est_mean,
        row && row.leakage_bg_est_mean,
        manifestRisk.leakage_bg_est_mean,
      ),
      min_module_pixels: (() => {
        const n = firstFiniteNumber(
          rawRisk.min_module_pixels,
          row && row.min_module_pixels,
          manifestRisk.min_module_pixels,
        );
        return n == null ? null : Math.max(0, Math.trunc(n));
      })(),
      overlay_diff_pixels: (() => {
        const n = firstFiniteNumber(
          rawRisk.overlay_diff_pixels,
          rawRisk.diff_pixels,
          rawRisk.overlayDiffPixels,
          row && row.overlay_diff_pixels,
          row && row.diff_pixels,
          row && row.overlayDiffPixels,
          manifestRisk.overlay_diff_pixels,
        );
        return n == null ? null : Math.max(0, Math.trunc(n));
      })(),
      overlay_diff_ratio: firstFiniteNumber(
        rawRisk.overlay_diff_ratio,
        rawRisk.diff_ratio,
        rawRisk.overlayDiffRatio,
        row && row.overlay_diff_ratio,
        row && row.diff_ratio,
        row && row.overlayDiffRatio,
        manifestRisk.overlay_diff_ratio,
      ),
      overlay_focus_module: firstNonEmptyString(
        rawRisk.overlay_focus_module,
        rawRisk.overlayFocusModule,
        row && row.overlay_focus_module,
        manifestRisk.overlay_focus_module,
      ),
    },
  };
}

function pickLatestByRater(rows) {
  const byRater = new Map();
  const sorted = [...rows].sort((a, b) => {
    const ta = Date.parse(String(a.updated_at || a.created_at || '')) || 0;
    const tb = Date.parse(String(b.updated_at || b.created_at || '')) || 0;
    if (ta !== tb) return tb - ta;
    return String(b.annotation_id || '').localeCompare(String(a.annotation_id || ''));
  });
  for (const row of sorted) {
    const rater = String(row.rater_id || '').trim();
    if (!rater || byRater.has(rater)) continue;
    byRater.set(rater, row);
  }
  return byRater;
}

function buildMarkdown({ runId, labelsPath, manifestPath, summary, moduleSummaryRows, iaaSummary, pairRows, topContentious, files }) {
  const lines = [];
  lines.push('# Eval Preference Round1');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- labels: \`${labelsPath}\``);
  lines.push(`- manifest: ${manifestPath ? `\`${manifestPath}\`` : '-'}`);
  lines.push(`- samples: ${summary.samples_total}`);
  lines.push(`- annotations: ${summary.annotations_total}`);
  lines.push('');

  lines.push('## Overall Rates');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| baseline_win_rate | ${summary.overall.baseline_win_rate ?? '-'} |`);
  lines.push(`| variant1_win_rate | ${summary.overall.variant1_win_rate ?? '-'} |`);
  lines.push(`| tie_rate | ${summary.overall.tie_rate ?? '-'} |`);
  lines.push(`| cannot_tell_rate | ${summary.overall.cannot_tell_rate ?? '-'} |`);
  lines.push(`| disagreement_rate | ${summary.overall.disagreement_rate ?? '-'} |`);
  lines.push(`| avg_confidence | ${summary.overall.avg_confidence ?? '-'} |`);
  lines.push(`| low_confidence_rate | ${summary.overall.low_confidence_rate ?? '-'} |`);
  lines.push('');

  lines.push('## Win-Rate CI (Wilson)');
  lines.push('');
  lines.push('| scope | head_to_head_votes | baseline_win_rate (95% CI) | variant1_win_rate (95% CI) |');
  lines.push('|---|---:|---|---|');
  lines.push(`| overall | ${summary.overall.head_to_head_votes || 0} | ${summary.overall.baseline_win_rate ?? '-'} [${summary.overall.baseline_wilson_low ?? '-'}, ${summary.overall.baseline_wilson_high ?? '-'}] | ${summary.overall.variant1_win_rate ?? '-'} [${summary.overall.variant1_wilson_low ?? '-'}, ${summary.overall.variant1_wilson_high ?? '-'}] |`);
  moduleSummaryRows.forEach((row) => {
    lines.push(`| module:${row.module_id} | ${row.head_to_head_votes || 0} | ${row.baseline_win_rate ?? '-'} [${row.baseline_wilson_low ?? '-'}, ${row.baseline_wilson_high ?? '-'}] | ${row.variant1_win_rate ?? '-'} [${row.variant1_wilson_low ?? '-'}, ${row.variant1_wilson_high ?? '-'}] |`);
  });
  lines.push('');

  lines.push('## Confidence Stratified');
  lines.push('');
  lines.push('| bucket | votes | baseline_win_rate | variant1_win_rate |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| high (>=4) | ${summary.confidence.high_votes} | ${summary.confidence.high_baseline_win_rate ?? '-'} | ${summary.confidence.high_variant1_win_rate ?? '-'} |`);
  lines.push(`| low (<=2) | ${summary.confidence.low_votes} | ${summary.confidence.low_baseline_win_rate ?? '-'} | ${summary.confidence.low_variant1_win_rate ?? '-'} |`);
  lines.push('');

  lines.push('## Per-Module Win Rates');
  lines.push('');
  lines.push('| module | votes | baseline_win_rate | variant1_win_rate | tie_rate | cannot_tell_rate | disagreement_rate |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  moduleSummaryRows.forEach((row) => {
    lines.push(`| ${row.module_id} | ${row.total_votes} | ${row.baseline_win_rate ?? '-'} | ${row.variant1_win_rate ?? '-'} | ${row.tie_rate ?? '-'} | ${row.cannot_tell_rate ?? '-'} | ${row.disagreement_rate ?? '-'} |`);
  });
  lines.push('');

  lines.push('## IAA (Overlap Subset)');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| overlap_samples_total | ${iaaSummary.overlap_samples_total} |`);
  lines.push(`| overlap_samples_labeled_by_2plus | ${iaaSummary.overlap_samples_labeled_by_2plus} |`);
  lines.push(`| overall_simple_agreement | ${iaaSummary.overall_simple_agreement ?? '-'} |`);
  lines.push(`| overall_kappa | ${iaaSummary.overall_kappa ?? '-'} |`);
  lines.push('');
  lines.push('| module | simple_agreement | kappa | paired_votes |');
  lines.push('|---|---:|---:|---:|');
  iaaSummary.per_module.forEach((row) => {
    lines.push(`| ${row.module_id} | ${row.simple_agreement ?? '-'} | ${row.kappa ?? '-'} | ${row.paired_votes} |`);
  });
  lines.push('');

  lines.push('## IAA Per Annotator Pair');
  lines.push('');
  lines.push('| pair | shared_samples | simple_agreement | kappa |');
  lines.push('|---|---:|---:|---:|');
  if (!pairRows.length) {
    lines.push('| - | - | - | - |');
  } else {
    pairRows.forEach((row) => {
      lines.push(`| ${row.pair} | ${row.shared_samples} | ${row.simple_agreement ?? '-'} | ${row.kappa ?? '-'} |`);
    });
  }
  lines.push('');

  if (summary.risk_features_missing_count > 0) {
    lines.push('## Warnings');
    lines.push('');
    lines.push(`- missing risk features for ${summary.risk_features_missing_count} samples`);
    lines.push('');
  }

  lines.push('## Top 50 Contentious Samples');
  lines.push('');
  lines.push('| rank | sample_id | source | task_batch | annotators | votes | majority | cannot_tell_rate | disagreement_overlap_rate | low_confidence_rate | contentious_score | risk(hair/leak_bg/min_pixels) |');
  lines.push('|---:|---|---|---|---:|---:|---|---:|---:|---:|---:|---|');
  if (!topContentious.length) {
    lines.push('| 1 | - | - | - | - | - | - | - | - | - | - | - |');
  } else {
    topContentious.forEach((row, idx) => {
      const risk = `${row.hair_overlap_est ?? '-'} / ${row.leakage_bg_est_mean ?? '-'} / ${row.min_module_pixels ?? '-'}`;
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.source} | ${row.task_batch || '-'} | ${row.annotators_total} | ${row.total_votes} | ${row.majority_choice || '-'} | ${row.cannot_tell_rate ?? '-'} | ${row.disagreement_overlap_rate ?? '-'} | ${row.low_confidence_rate ?? '-'} | ${row.contentious_score ?? '-'} | ${risk} |`);
    });
  }
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- report_md: \`${files.reportMdRel}\``);
  lines.push(`- report_jsonl: \`${files.reportJsonlRel}\``);
  lines.push(`- report_json: \`${files.reportJsonRel}\``);
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
  if (!args.labels) {
    process.stderr.write('eval_preference: missing --labels\n');
    process.exit(2);
    return;
  }

  const labelsPath = path.resolve(args.labels);
  const runId = inferRunId(args);
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const labelsRaw = await readNdjson(labelsPath);

  let manifestPathRel = null;
  let manifestCtx = { row_map: new Map(), overlap_sample_ids: new Set() };
  if (args.manifest) {
    const manifestPath = path.resolve(args.manifest);
    const manifestRaw = await fsp.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    manifestCtx = buildManifestContext(manifest);
    manifestPathRel = toPosix(path.relative(process.cwd(), manifestPath));
  }

  const labelsBySample = new Map();
  const overallCounts = emptyCounts();
  const perModuleCounts = Object.fromEntries(MODULE_IDS.map((moduleId) => [moduleId, emptyCounts()]));
  const confidenceAll = [];
  const confidenceHighRows = [];
  const confidenceLowRows = [];

  for (const raw of labelsRaw) {
    const sampleId = String(raw && (raw.sample_id || raw.sample_hash) ? (raw.sample_id || raw.sample_hash) : '').trim();
    if (!sampleId) continue;
    const manifestRow = manifestCtx.row_map.get(sampleId) || null;
    const normalized = normalizeLabelRow(raw, manifestRow);
    if (!normalized.sample_id) continue;

    if (!labelsBySample.has(normalized.sample_id)) labelsBySample.set(normalized.sample_id, []);
    labelsBySample.get(normalized.sample_id).push(normalized);

    if (normalized.winner) overallCounts[normalized.winner] += 1;
    if (normalized.confidence != null) confidenceAll.push(normalized.confidence);

    const isHeadToHead = normalized.winner === 'baseline' || normalized.winner === 'variant1';
    if (isHeadToHead && normalized.confidence_int != null) {
      if (normalized.confidence_int >= 4) confidenceHighRows.push(normalized.winner);
      if (normalized.confidence_int <= 2) confidenceLowRows.push(normalized.winner);
    }

    for (const moduleId of MODULE_IDS) {
      const choice = normalized.per_module_choice[moduleId];
      if (choice) perModuleCounts[moduleId][choice] += 1;
    }
  }

  const overlapIds = manifestCtx.overlap_sample_ids;
  const sampleRows = [];
  const overlapSampleRaterRows = new Map();
  let riskMissingCount = 0;

  for (const [sampleId, rows] of labelsBySample.entries()) {
    const counts = emptyCounts();
    const annotators = new Set();
    const confidences = [];
    let source = 'unknown';

    for (const row of rows) {
      annotators.add(row.rater_id);
      source = row.source || source;
      if (row.winner) counts[row.winner] += 1;
      if (row.confidence_int != null) confidences.push(row.confidence_int);
    }

    const rates = ratesFromCounts(counts);
    const avgConfidence = confidences.length
      ? round3(confidences.reduce((acc, value) => acc + value, 0) / confidences.length)
      : null;
    const lowConfidenceRate = confidences.length
      ? round3(confidences.filter((value) => value <= 2).length / confidences.length)
      : null;

    const manifestRow = manifestCtx.row_map.get(sampleId) || null;
    const manifestRisk = manifestRow && manifestRow.risk_features
      ? manifestRow.risk_features
      : {};
    const rowRiskList = rows
      .map((item) => (item && item.risk_features && typeof item.risk_features === 'object' ? item.risk_features : null))
      .filter(Boolean);
    const rowRisk = {
      hair_overlap_est: firstFiniteNumber(...rowRiskList.map((risk) => risk.hair_overlap_est)),
      leakage_bg_est_mean: firstFiniteNumber(...rowRiskList.map((risk) => risk.leakage_bg_est_mean)),
      min_module_pixels: firstFiniteNumber(...rowRiskList.map((risk) => risk.min_module_pixels)),
      overlay_diff_pixels: firstFiniteNumber(...rowRiskList.map((risk) => risk.overlay_diff_pixels)),
      overlay_diff_ratio: firstFiniteNumber(...rowRiskList.map((risk) => risk.overlay_diff_ratio)),
      overlay_focus_module: firstNonEmptyString(...rowRiskList.map((risk) => risk.overlay_focus_module)),
    };

    const hairOverlapEst = firstFiniteNumber(manifestRisk.hair_overlap_est, rowRisk.hair_overlap_est);
    const leakageBgEst = firstFiniteNumber(manifestRisk.leakage_bg_est_mean, rowRisk.leakage_bg_est_mean);
    const minModulePixelsRaw = firstFiniteNumber(manifestRisk.min_module_pixels, rowRisk.min_module_pixels);
    const minModulePixels = minModulePixelsRaw == null ? null : Math.max(0, Math.trunc(minModulePixelsRaw));
    const overlayDiffPixelsRaw = firstFiniteNumber(manifestRisk.overlay_diff_pixels, rowRisk.overlay_diff_pixels);
    const overlayDiffPixels = overlayDiffPixelsRaw == null ? null : Math.max(0, Math.trunc(overlayDiffPixelsRaw));
    const overlayDiffRatio = firstFiniteNumber(manifestRisk.overlay_diff_ratio, rowRisk.overlay_diff_ratio);
    const overlayFocusModule = firstNonEmptyString(manifestRisk.overlay_focus_module, rowRisk.overlay_focus_module);
    const overlayBbox = manifestRow && manifestRow.overlay_bbox ? manifestRow.overlay_bbox : null;
    const overlayZoom = manifestRow && Number.isFinite(Number(manifestRow.overlay_zoom)) ? Number(manifestRow.overlay_zoom) : null;
    if (hairOverlapEst == null && leakageBgEst == null && minModulePixels == null && overlayDiffRatio == null) {
      riskMissingCount += 1;
    }

    const taskBatch = String(
      (manifestRow && manifestRow.task_batch)
      || rows[0].task_batch
      || (overlapIds.has(sampleId) ? 'OVERLAP' : ''),
    ).trim().toUpperCase() || null;

    const overlapSample = overlapIds.has(sampleId) || taskBatch === 'OVERLAP';
    const disagreementOverlapRate = overlapSample && annotators.size >= 2
      ? rates.disagreement_rate
      : 0;

    if (overlapSample) {
      overlapSampleRaterRows.set(sampleId, pickLatestByRater(rows));
    }

    const riskSignal = (() => {
      const components = [];
      if (hairOverlapEst != null) components.push(Math.max(0, Math.min(1, hairOverlapEst)));
      if (leakageBgEst != null) components.push(Math.max(0, Math.min(1, leakageBgEst)));
      if (minModulePixels != null) components.push(minModulePixels <= 16 ? 1 : minModulePixels <= 32 ? 0.6 : 0);
      if (!components.length) return 0;
      return components.reduce((acc, value) => acc + value, 0) / components.length;
    })();

    const contentiousScore = round3(
      (Number(rates.cannot_tell_rate) || 0) * 0.35
      + (Number(disagreementOverlapRate) || 0) * 0.35
      + (Number(lowConfidenceRate) || 0) * 0.2
      + riskSignal * 0.1,
    );

    sampleRows.push({
      run_id: runId,
      sample_id: sampleId,
      sample_hash: sampleId,
      source,
      task_batch: taskBatch,
      overlap_sample: overlapSample,
      annotations_total: rows.length,
      annotators_total: annotators.size,
      baseline_votes: counts.baseline,
      variant1_votes: counts.variant1,
      tie_votes: counts.tie,
      cannot_tell_votes: counts.cannot_tell,
      total_votes: rates.total_votes,
      majority_choice: rates.majority_choice,
      baseline_win_rate: rates.baseline_win_rate,
      variant1_win_rate: rates.variant1_win_rate,
      tie_rate: rates.tie_rate,
      cannot_tell_rate: rates.cannot_tell_rate,
      disagreement_rate: rates.disagreement_rate,
      disagreement_overlap_rate: disagreementOverlapRate,
      split_close_score: rates.split_close_score,
      avg_confidence: avgConfidence,
      low_confidence_rate: lowConfidenceRate,
      contentious_score: contentiousScore,
      hair_overlap_est: round3(hairOverlapEst),
      leakage_bg_est_mean: round3(leakageBgEst),
      min_module_pixels: minModulePixels,
      overlay_diff_pixels: overlayDiffPixels,
      overlay_diff_ratio: round3(overlayDiffRatio),
      overlay_focus_module: overlayFocusModule,
      overlay_bbox: overlayBbox || null,
      overlay_zoom: round3(overlayZoom),
      risk_features_missing: hairOverlapEst == null && leakageBgEst == null && minModulePixels == null && overlayDiffRatio == null,
    });
  }

  sampleRows.sort((a, b) => {
    const cannotDelta = Number(b.cannot_tell_rate || 0) - Number(a.cannot_tell_rate || 0);
    if (Math.abs(cannotDelta) > 1e-9) return cannotDelta;
    const overlapDisDelta = Number(b.disagreement_overlap_rate || 0) - Number(a.disagreement_overlap_rate || 0);
    if (Math.abs(overlapDisDelta) > 1e-9) return overlapDisDelta;
    const lowConfDelta = Number(b.low_confidence_rate || 0) - Number(a.low_confidence_rate || 0);
    if (Math.abs(lowConfDelta) > 1e-9) return lowConfDelta;
    const scoreDelta = Number(b.contentious_score || 0) - Number(a.contentious_score || 0);
    if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
    return String(a.sample_id || '').localeCompare(String(b.sample_id || ''));
  });

  // IAA over overlap samples with >=2 annotators.
  const overallPairs = [];
  const perModulePairs = Object.fromEntries(MODULE_IDS.map((moduleId) => [moduleId, []]));
  const pairCounters = new Map();
  let overlapLabeledBy2Plus = 0;

  for (const [sampleId, byRater] of overlapSampleRaterRows.entries()) {
    const raters = [...byRater.keys()].sort((a, b) => a.localeCompare(b));
    if (raters.length < 2) continue;
    overlapLabeledBy2Plus += 1;

    for (let i = 0; i < raters.length; i += 1) {
      for (let j = i + 1; j < raters.length; j += 1) {
        const ra = raters[i];
        const rb = raters[j];
        const aRow = byRater.get(ra);
        const bRow = byRater.get(rb);
        const pairKey = `${ra}|${rb}`;

        if (!pairCounters.has(pairKey)) {
          pairCounters.set(pairKey, {
            pair: pairKey,
            shared_samples: new Set(),
            overall_pairs: [],
          });
        }
        const pairEntry = pairCounters.get(pairKey);
        pairEntry.shared_samples.add(sampleId);

        const aChoice = normalizeChoice(aRow && aRow.winner);
        const bChoice = normalizeChoice(bRow && bRow.winner);
        if (aChoice && bChoice) {
          overallPairs.push([aChoice, bChoice]);
          pairEntry.overall_pairs.push([aChoice, bChoice]);
        }

        for (const moduleId of MODULE_IDS) {
          const am = normalizeChoice(aRow && aRow.per_module_choice && aRow.per_module_choice[moduleId]);
          const bm = normalizeChoice(bRow && bRow.per_module_choice && bRow.per_module_choice[moduleId]);
          if (!am || !bm) continue;
          perModulePairs[moduleId].push([am, bm]);
        }
      }
    }
  }

  const iaaPerModuleRows = MODULE_IDS.map((moduleId) => {
    const pairs = perModulePairs[moduleId];
    const total = pairs.length;
    const hits = pairs.filter(([a, b]) => a === b).length;
    return {
      module_id: moduleId,
      paired_votes: total,
      simple_agreement: total > 0 ? round3(hits / total) : null,
      kappa: round3(computeKappa(pairs, CHOICE_CATS)),
    };
  });

  const pairRows = [...pairCounters.values()]
    .map((entry) => {
      const total = entry.overall_pairs.length;
      const hits = entry.overall_pairs.filter(([a, b]) => a === b).length;
      return {
        pair: entry.pair,
        shared_samples: entry.shared_samples.size,
        simple_agreement: total > 0 ? round3(hits / total) : null,
        kappa: round3(computeKappa(entry.overall_pairs, CHOICE_CATS)),
      };
    })
    .sort((a, b) => b.shared_samples - a.shared_samples || String(a.pair).localeCompare(String(b.pair)));

  const overallRates = ratesFromCounts(overallCounts);
  const confidenceOverall = confidenceAll.length
    ? round3(confidenceAll.reduce((acc, value) => acc + value, 0) / confidenceAll.length)
    : null;
  const lowConfidenceOverall = confidenceAll.length
    ? round3(confidenceAll.filter((value) => value <= 0.4).length / confidenceAll.length)
    : null;

  const moduleSummaryRows = MODULE_IDS.map((moduleId) => ({
    module_id: moduleId,
    ...ratesFromCounts(perModuleCounts[moduleId]),
  }));

  const highCounts = emptyCounts();
  const lowCounts = emptyCounts();
  confidenceHighRows.forEach((choice) => { highCounts[choice] += 1; });
  confidenceLowRows.forEach((choice) => { lowCounts[choice] += 1; });
  const highRates = ratesFromCounts(highCounts);
  const lowRates = ratesFromCounts(lowCounts);

  const reportJsonlPath = path.resolve(args.out_jsonl || path.join(reportDir, `eval_preference_${runId}.jsonl`));
  const reportMdPath = path.resolve(path.join(reportDir, `eval_preference_${runId}.md`));
  const reportJsonPath = path.resolve(path.join(reportDir, `eval_preference_${runId}.json`));

  const jsonlPayload = sampleRows.length ? `${sampleRows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fsp.writeFile(reportJsonlPath, jsonlPayload, 'utf8');

  const forehead = moduleSummaryRows.find((row) => row.module_id === 'forehead') || null;
  const variantDelta =
    overallRates.variant1_win_rate != null && overallRates.baseline_win_rate != null
      ? round3(overallRates.variant1_win_rate - overallRates.baseline_win_rate)
      : null;
  const foreheadDelta =
    forehead && forehead.variant1_win_rate != null && forehead.baseline_win_rate != null
      ? round3(forehead.variant1_win_rate - forehead.baseline_win_rate)
      : null;

  const summaryPayload = {
    ok: true,
    run_id: runId,
    labels_path: toPosix(path.relative(process.cwd(), labelsPath)),
    manifest_path: manifestPathRel,
    samples_total: sampleRows.length,
    annotations_total: labelsRaw.length,
    overall: {
      ...overallRates,
      avg_confidence: confidenceOverall,
      low_confidence_rate: lowConfidenceOverall,
    },
    overall_counts: overallCounts,
    per_module: moduleSummaryRows,
    confidence: {
      high_votes: highRates.head_to_head_votes || 0,
      high_baseline_win_rate: highRates.baseline_win_rate,
      high_variant1_win_rate: highRates.variant1_win_rate,
      low_votes: lowRates.head_to_head_votes || 0,
      low_baseline_win_rate: lowRates.baseline_win_rate,
      low_variant1_win_rate: lowRates.variant1_win_rate,
    },
    iaa: {
      overlap_samples_total: overlapIds.size,
      overlap_samples_labeled_by_2plus: overlapLabeledBy2Plus,
      overall_simple_agreement: overallPairs.length
        ? round3(overallPairs.filter(([a, b]) => a === b).length / overallPairs.length)
        : null,
      overall_kappa: round3(computeKappa(overallPairs, CHOICE_CATS)),
      per_module: iaaPerModuleRows,
      per_annotator_pair: pairRows,
    },
    risk_features_missing_count: riskMissingCount,
    top_contentious_samples: sampleRows.slice(0, 50),
    recommendation_hint: {
      variant1_minus_baseline: variantDelta,
      forehead_variant1_minus_baseline: foreheadDelta,
      suggestion: (() => {
        if (variantDelta != null && variantDelta >= 0.05) return 'consider_variant1';
        if (foreheadDelta != null && foreheadDelta >= 0.1) return 'consider_variant1';
        return 'keep_baseline_or_adjudicate';
      })(),
    },
    artifacts: {
      report_md: toPosix(path.relative(process.cwd(), reportMdPath)),
      report_jsonl: toPosix(path.relative(process.cwd(), reportJsonlPath)),
      report_json: toPosix(path.relative(process.cwd(), reportJsonPath)),
    },
  };

  await fsp.writeFile(reportJsonPath, `${JSON.stringify(summaryPayload, null, 2)}\n`, 'utf8');

  const markdown = buildMarkdown({
    runId,
    labelsPath: toPosix(path.relative(process.cwd(), labelsPath)),
    manifestPath: manifestPathRel,
    summary: summaryPayload,
    moduleSummaryRows,
    iaaSummary: summaryPayload.iaa,
    pairRows,
    topContentious: summaryPayload.top_contentious_samples,
    files: {
      reportMdRel: summaryPayload.artifacts.report_md,
      reportJsonlRel: summaryPayload.artifacts.report_jsonl,
      reportJsonRel: summaryPayload.artifacts.report_json,
    },
  });
  await fsp.writeFile(reportMdPath, markdown, 'utf8');

  process.stdout.write(`${JSON.stringify(summaryPayload, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`eval_preference_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
