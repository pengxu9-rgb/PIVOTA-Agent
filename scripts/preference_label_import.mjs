#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex, runTimestampKey } from './internal_batch_helpers.mjs';

const MODULE_FIELD_TO_ID = Object.freeze({
  pref_nose: 'nose',
  pref_forehead: 'forehead',
  pref_left_cheek: 'left_cheek',
  pref_right_cheek: 'right_cheek',
  pref_chin: 'chin',
  pref_under_eye_left: 'under_eye_left',
  pref_under_eye_right: 'under_eye_right',
});

const MODULE_IDS = Object.freeze([
  'nose',
  'forehead',
  'left_cheek',
  'right_cheek',
  'chin',
  'under_eye_left',
  'under_eye_right',
]);

const REASON_CHOICES = Object.freeze([
  'hairline_forehead_ambiguous',
  'occlusion_or_shadow',
  'blur_or_low_res',
  'modules_too_small',
  'overall_similar',
]);

const HELP_TEXT = `preference_label_import.mjs

Usage:
  node scripts/preference_label_import.mjs --in <label_studio_export.json> [options]
  node scripts/preference_label_import.mjs --exports <a.json,b.json,...> [options]
  node scripts/preference_label_import.mjs --export <a.json> --export <b.json> [options]

Inputs:
  --in <path>                              single Label Studio export (compat mode)
  --exports <csv>                          comma-separated exports list
  --export <path>                          repeatable export path flag

Options:
  --manifest <path>                        preference pack manifest.json (used for A/B unflip)
  --out <path>                             output ndjson path (default: artifacts/preference_round1_<run_id>/preference_labels.ndjson)
  --run_id <id>                            run id (default: infer from input filename)
  --baseline_id <id>                       fallback baseline id (default: baseline_default)
  --variant_id <id>                        fallback variant id (default: variant1_forehead_hair_clip)
  --all_annotations <bool>                 import all annotations per task (default: true)
  --report_dir <dir>                       qc report dir (default: reports)
  --help                                   show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function splitCsvArg(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    help: false,
    in: process.env.IN || process.env.ROUND1_IN || process.env.PREFERENCE_EXPORT_IN || '',
    exports: process.env.EXPORTS || process.env.PREFERENCE_EXPORTS || '',
    export: [],
    manifest: process.env.MANIFEST || process.env.PREFERENCE_MANIFEST || '',
    out: process.env.OUT || process.env.PREFERENCE_LABELS_OUT || '',
    run_id: process.env.RUN_ID || '',
    baseline_id: process.env.BASELINE_ID || 'baseline_default',
    variant_id: process.env.VARIANT_ID || 'variant1_forehead_hair_clip',
    all_annotations: process.env.PREFERENCE_IMPORT_ALL_ANNOTATIONS || 'true',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }

    if (token === '--export' || token === '--exports') {
      if (!next || String(next).startsWith('--')) continue;
      out.export.push(String(next));
      i += 1;
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
  out.in = String(out.in || '').trim();
  out.exports = String(out.exports || '').trim();
  out.manifest = String(out.manifest || '').trim();
  out.out = String(out.out || '').trim();
  out.run_id = String(out.run_id || '').trim();
  out.baseline_id = String(out.baseline_id || 'baseline_default').trim() || 'baseline_default';
  out.variant_id = String(out.variant_id || 'variant1_forehead_hair_clip').trim() || 'variant1_forehead_hair_clip';
  out.all_annotations = parseBool(out.all_annotations, true);
  out.report_dir = String(out.report_dir || 'reports').trim() || 'reports';

  const inputTokens = [];
  if (out.in) inputTokens.push(out.in);
  inputTokens.push(...splitCsvArg(out.exports));
  for (const token of out.export) {
    inputTokens.push(...splitCsvArg(token));
  }

  const inputPaths = [...new Set(
    inputTokens
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => path.resolve(item)),
  )].sort((a, b) => toPosix(a).localeCompare(toPosix(b)));

  out.input_paths = inputPaths;
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const token of [...(args.input_paths || []), args.manifest]) {
    const base = path.basename(String(token || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function sortAnnotations(annotations) {
  const candidates = Array.isArray(annotations)
    ? annotations.filter((item) => item && typeof item === 'object')
    : [];
  return [...candidates].sort((a, b) => {
    const aCount = Array.isArray(a.result) ? a.result.length : 0;
    const bCount = Array.isArray(b.result) ? b.result.length : 0;
    if (aCount !== bCount) return bCount - aCount;
    const aTs = Date.parse(String(a.updated_at || a.created_at || '')) || 0;
    const bTs = Date.parse(String(b.updated_at || b.created_at || '')) || 0;
    if (aTs !== bTs) return bTs - aTs;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function extractTasks(exportPayload) {
  if (Array.isArray(exportPayload)) return exportPayload;
  if (exportPayload && Array.isArray(exportPayload.tasks)) return exportPayload.tasks;
  if (exportPayload && Array.isArray(exportPayload.data)) return exportPayload.data;
  return [];
}

function resolveAnnotatorRaw(annotation) {
  if (!annotation || typeof annotation !== 'object') return 'unknown_rater';
  const candidates = [];
  const completedBy = annotation.completed_by;
  if (typeof completedBy === 'string' || typeof completedBy === 'number') candidates.push(String(completedBy));
  if (completedBy && typeof completedBy === 'object') {
    for (const key of ['id', 'email', 'username', 'first_name', 'last_name']) {
      if (completedBy[key] != null && String(completedBy[key]).trim()) {
        candidates.push(String(completedBy[key]).trim());
      }
    }
  }
  for (const key of ['completed_by_id', 'created_username', 'created_by', 'updated_by', 'annotator']) {
    if (annotation[key] != null && String(annotation[key]).trim()) {
      candidates.push(String(annotation[key]).trim());
    }
  }
  return candidates[0] || 'unknown_rater';
}

function anonymizeRater(raw) {
  const token = String(raw || '').trim().toLowerCase() || 'unknown_rater';
  return `rater_${sha256Hex(token).slice(0, 12)}`;
}

function normalizeRole(token, fallback) {
  const raw = String(token || '').trim().toLowerCase();
  if (raw === 'baseline' || raw === 'variant') return raw;
  return fallback;
}

function resolveAnnotationId(annotation, taskId, sampleId, raterId, index) {
  const direct = annotation && annotation.id != null ? String(annotation.id).trim() : '';
  if (direct) return direct;
  return `prefann_${sha256Hex(`${taskId}:${sampleId}:${raterId}:${index}`)}`;
}

function extractChoiceText(result) {
  if (!result || typeof result !== 'object') return null;
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  const choices = Array.isArray(value.choices) ? value.choices : [];
  if (!choices.length) return null;
  return String(choices[0] || '').trim() || null;
}

function extractNotesText(result) {
  if (!result || typeof result !== 'object') return null;
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  if (Array.isArray(value.text) && value.text.length) {
    const joined = value.text.map((item) => String(item || '').trim()).filter(Boolean).join(' ').trim();
    return joined || null;
  }
  if (typeof value.text === 'string') {
    const token = value.text.trim();
    return token || null;
  }
  return null;
}

function parseConfidenceValue(raw) {
  if (raw == null) return null;
  const token = String(raw).trim().toLowerCase();
  if (!token) return null;
  const direct = Number(token);
  if (Number.isFinite(direct)) {
    if (direct <= 1) return Math.max(0, Math.min(1, direct));
    if (direct <= 5) return Math.max(0, Math.min(1, direct / 5));
    if (direct <= 10) return Math.max(0, Math.min(1, direct / 10));
    if (direct <= 100) return Math.max(0, Math.min(1, direct / 100));
    return 1;
  }
  if (token === 'high') return 0.9;
  if (token === 'medium' || token === 'mid') return 0.6;
  if (token === 'low') return 0.3;
  return null;
}

function parseConfidenceInt(raw) {
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

function extractConfidence(result) {
  if (!result || typeof result !== 'object') return null;
  const type = String(result.type || '').trim().toLowerCase();
  const fromName = String(result.from_name || '').trim().toLowerCase();
  const value = result.value && typeof result.value === 'object' ? result.value : {};

  if (type === 'choices' || type === 'choice') {
    if (!fromName.includes('confidence')) return null;
    const choice = extractChoiceText(result);
    return parseConfidenceValue(choice);
  }

  if (type === 'rating') {
    const rating = Number(value.rating);
    const max = Number(value.max);
    if (Number.isFinite(rating) && Number.isFinite(max) && max > 0) {
      return Math.max(0, Math.min(1, rating / max));
    }
    return parseConfidenceValue(value.rating);
  }

  if (type === 'number') {
    if (!fromName.includes('confidence')) return null;
    return parseConfidenceValue(value.number);
  }

  return null;
}

function extractChoicesArray(result) {
  if (!result || typeof result !== 'object') return [];
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  const choices = Array.isArray(value.choices) ? value.choices : [];
  return choices
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeReasons(rawChoices) {
  const out = [];
  for (const tokenRaw of rawChoices) {
    const token = String(tokenRaw || '').trim().toLowerCase();
    if (!token) continue;
    if (REASON_CHOICES.includes(token)) {
      out.push(token);
      continue;
    }
    if (token.includes('hairline') || token.includes('forehead')) {
      out.push('hairline_forehead_ambiguous');
      continue;
    }
    if (token.includes('occlusion') || token.includes('shadow')) {
      out.push('occlusion_or_shadow');
      continue;
    }
    if (token.includes('blur') || token.includes('low') || token.includes('res')) {
      out.push('blur_or_low_res');
      continue;
    }
    if (token.includes('small')) {
      out.push('modules_too_small');
      continue;
    }
    if (token.includes('similar')) {
      out.push('overall_similar');
    }
  }
  return [...new Set(out)];
}

function normalizeWinner(raw, roleA, roleB) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return { value: null, invalid: false };

  if (token === 'a' || token === 'option_a') {
    return { value: roleA === 'baseline' ? 'baseline' : 'variant1', invalid: false };
  }
  if (token === 'b' || token === 'option_b') {
    return { value: roleB === 'baseline' ? 'baseline' : 'variant1', invalid: false };
  }
  if (token === 'baseline' || token === 'base') return { value: 'baseline', invalid: false };
  if (token === 'variant' || token === 'variant1' || token === 'var') return { value: 'variant1', invalid: false };
  if (token === 'tie' || token === 'equal' || token === 'same') return { value: 'tie', invalid: false };
  if (token === 'cannot_tell' || token === 'cant_tell' || token === 'unknown' || token === 'unclear') {
    return { value: 'cannot_tell', invalid: false };
  }
  return { value: null, invalid: true };
}

function buildEmptyPerModuleChoice() {
  const out = {};
  for (const moduleId of MODULE_IDS) out[moduleId] = null;
  return out;
}

function resolveTaskId(task, fallback) {
  const direct = task && (task.id || task.task_id || task.pk);
  if (direct != null && String(direct).trim()) return String(direct).trim();
  return fallback;
}

function buildManifestLookup(manifest) {
  const rows = Array.isArray(manifest && manifest.rows) ? manifest.rows : [];
  const flipMap = manifest && typeof manifest.flip_map === 'object' && manifest.flip_map ? manifest.flip_map : {};
  const map = new Map();

  for (const row of rows) {
    const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
    if (!sampleId) continue;
    map.set(sampleId, {
      source: String(row.source || '').trim().toLowerCase() || null,
      role_a: normalizeRole(row.role_a, 'baseline'),
      role_b: normalizeRole(row.role_b, 'variant'),
      baseline_id: String(row.baseline_id || '').trim() || null,
      variant_id: String(row.variant_id || '').trim() || null,
      task_batch: String(row.task_batch || '').trim().toUpperCase() || null,
      risk_features: (() => {
        const risk = row && typeof row.risk_features === 'object' ? row.risk_features : {};
        const hair = firstFiniteNumber(risk.hair_overlap_est, row.hair_overlap_est, row.forehead_hair_overlap_est);
        const leakage = firstFiniteNumber(risk.leakage_bg_est_mean, row.leakage_bg_est_mean);
        const minPixels = firstFiniteNumber(risk.min_module_pixels, row.min_module_pixels, row.module_pixels_min);
        const overlayPixels = firstFiniteNumber(
          risk.overlay_diff_pixels,
          risk.diff_pixels,
          risk.overlayDiffPixels,
          row.overlay_diff_pixels,
          row.diff_pixels,
          row.overlayDiffPixels,
        );
        const overlayRatio = firstFiniteNumber(
          risk.overlay_diff_ratio,
          risk.diff_ratio,
          risk.overlayDiffRatio,
          row.overlay_diff_ratio,
          row.diff_ratio,
          row.overlayDiffRatio,
        );
        const overlayFocus = String(
          risk.overlay_focus_module
          ?? risk.overlayFocusModule
          ?? row.overlay_focus_module
          ?? row.overlayFocusModule
          ?? '',
        ).trim() || null;
        return {
          hair_overlap_est: hair == null ? null : hair,
          leakage_bg_est_mean: leakage == null ? null : leakage,
          min_module_pixels: minPixels == null ? null : Math.max(0, Math.trunc(minPixels)),
          overlay_diff_pixels: overlayPixels == null ? null : Math.max(0, Math.trunc(overlayPixels)),
          overlay_diff_ratio: overlayRatio == null ? null : overlayRatio,
          overlay_focus_module: overlayFocus,
        };
      })(),
    });
  }

  for (const [sampleId, info] of Object.entries(flipMap)) {
    const token = String(sampleId || '').trim();
    if (!token) continue;
    const existing = map.get(token) || {};
    map.set(token, {
      ...existing,
      role_a: normalizeRole(info && info.role_a, existing.role_a || 'baseline'),
      role_b: normalizeRole(
        info && info.role_b,
        existing.role_b || (normalizeRole(info && info.role_a, 'baseline') === 'baseline' ? 'variant' : 'baseline'),
      ),
    });
  }

  return map;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === ',') {
      values.push(current);
      current = '';
    } else if (ch === '"') {
      quoted = true;
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function parseCsvRows(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[String(headers[j] || '').trim()] = values[j] == null ? '' : values[j];
    }
    rows.push(row);
  }
  return rows;
}

function firstNonEmpty(obj, keys) {
  for (const key of keys) {
    const value = obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
    if (value == null) continue;
    const token = String(value).trim();
    if (token) return token;
  }
  return '';
}

function parseDelimitedReasons(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return normalizeReasons(raw);
  const token = String(raw).trim();
  if (!token) return [];
  const parts = token.split(/[;,|]/g).map((item) => item.trim()).filter(Boolean);
  return normalizeReasons(parts);
}

function extractPerModuleFromJsonToken(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && raw) return raw;
  const token = String(raw).trim();
  if (!token) return {};
  try {
    const parsed = JSON.parse(token);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_error) {
    // ignore
  }
  return {};
}

function buildRowKey(row) {
  const sampleId = String(row.sample_id || '').trim();
  const moduleId = String(row.module_id || 'overall').trim() || 'overall';
  const raterId = String(row.rater_id || row.annotator_id || 'unknown_rater').trim() || 'unknown_rater';
  return `${sampleId}\u0000${moduleId}\u0000${raterId}`;
}

function rowTimestamp(row) {
  return Date.parse(String(row.updated_at || row.created_at || '')) || 0;
}

function compareRowPriority(a, b) {
  const tsDelta = rowTimestamp(a) - rowTimestamp(b);
  if (tsDelta !== 0) return tsDelta;

  const annDelta = String(a.annotation_id || '').localeCompare(String(b.annotation_id || ''));
  if (annDelta !== 0) return annDelta;

  const srcDelta = String(b.source_export_file || '').localeCompare(String(a.source_export_file || ''));
  if (srcDelta !== 0) return srcDelta;

  const hashA = sha256Hex(JSON.stringify(a));
  const hashB = sha256Hex(JSON.stringify(b));
  return hashA.localeCompare(hashB);
}

function dedupeRows(rows) {
  const bestByKey = new Map();
  for (const row of rows) {
    const key = buildRowKey(row);
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, row);
      continue;
    }
    if (compareRowPriority(row, existing) > 0) {
      bestByKey.set(key, row);
    }
  }
  const deduped = [...bestByKey.values()].sort((a, b) => {
    const sampleDelta = String(a.sample_id || '').localeCompare(String(b.sample_id || ''));
    if (sampleDelta !== 0) return sampleDelta;
    const moduleDelta = String(a.module_id || '').localeCompare(String(b.module_id || ''));
    if (moduleDelta !== 0) return moduleDelta;
    const raterDelta = String(a.rater_id || '').localeCompare(String(b.rater_id || ''));
    if (raterDelta !== 0) return raterDelta;
    const tsDelta = rowTimestamp(b) - rowTimestamp(a);
    if (tsDelta !== 0) return tsDelta;
    return String(a.annotation_id || '').localeCompare(String(b.annotation_id || ''));
  });
  return {
    rows: deduped,
    duplicate_rows_dropped: Math.max(0, rows.length - deduped.length),
  };
}

function buildQcMarkdown({ runId, inputRels, outputRel, qcRows, summary }) {
  const lines = [];
  lines.push('# Preference Import QC');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push('- inputs:');
  if (!inputRels.length) {
    lines.push('  - -');
  } else {
    inputRels.forEach((inputRel) => lines.push(`  - \`${inputRel}\``));
  }
  lines.push(`- output: \`${outputRel}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| input_exports | ${summary.input_exports} |`);
  lines.push(`| raw_rows | ${summary.raw_rows} |`);
  lines.push(`| imported_rows | ${summary.imported_rows} |`);
  lines.push(`| duplicate_rows_dropped | ${summary.duplicate_rows_dropped} |`);
  lines.push(`| rows_with_required_fields | ${summary.rows_with_required_fields} |`);
  lines.push(`| rows_missing_required_fields | ${summary.rows_missing_required_fields} |`);
  lines.push(`| rows_with_invalid_choices | ${summary.rows_with_invalid_choices} |`);
  lines.push(`| total_invalid_choice_count | ${summary.total_invalid_choice_count} |`);
  lines.push(`| missing_confidence_count | ${summary.missing_confidence_count} |`);
  lines.push(`| cannot_tell_rate | ${summary.cannot_tell_rate} |`);
  lines.push('');
  lines.push('## Per Annotator');
  lines.push('');
  lines.push('| rater_id | labeled_rows | labeled_samples |');
  lines.push('|---|---:|---:|');
  if (!summary.per_annotator.length) {
    lines.push('| - | - | - |');
  } else {
    summary.per_annotator.forEach((row) => {
      lines.push(`| ${row.rater_id} | ${row.labeled_rows} | ${row.labeled_samples} |`);
    });
  }
  lines.push('');
  lines.push('## Top QC Issues');
  lines.push('');
  lines.push('| rank | sample_id | module_id | source | source_export_file | rater_id | task_batch | has_required_fields | invalid_choice_count | confidence_int | winner | notes |');
  lines.push('|---:|---|---|---|---|---|---|---|---:|---:|---|---|');
  if (!qcRows.length) {
    lines.push('| 1 | - | - | - | - | - | - | - | - | - | - | - |');
  } else {
    qcRows.slice(0, 30).forEach((row, idx) => {
      lines.push(`| ${idx + 1} | ${row.sample_id || '-'} | ${row.module_id || '-'} | ${row.source || '-'} | ${row.source_export_file || '-'} | ${row.rater_id || '-'} | ${row.task_batch || '-'} | ${row.has_required_fields ? 'true' : 'false'} | ${row.invalid_choice_count || 0} | ${row.confidence_int == null ? '-' : row.confidence_int} | ${row.winner || '-'} | ${String(row.notes || '').replace(/\|/g, '/').slice(0, 80) || '-'} |`);
    });
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function makeImportedRow({
  runId,
  sampleId,
  source,
  winnerRaw,
  roleA,
  roleB,
  baselineId,
  variantId,
  taskBatch,
  raterRaw,
  annotationId,
  taskId,
  createdAt,
  updatedAt,
  confidence,
  confidenceInt,
  reasons,
  notes,
  perModuleChoice,
  perModuleChoiceRaw,
  manifestInfo,
  invalidChoiceCount,
  exportRel,
  importedAt,
  isAdjudication,
  moduleId = 'overall',
}) {
  const normalizedWinner = normalizeWinner(winnerRaw, roleA, roleB);
  const invalidTotal = invalidChoiceCount + (normalizedWinner.invalid ? 1 : 0);
  const winner = normalizedWinner.value;
  const raterId = anonymizeRater(raterRaw);

  const finalConfidenceInt = confidenceInt == null && confidence != null
    ? parseConfidenceInt(confidence)
    : confidenceInt;
  const finalConfidence = confidence == null && finalConfidenceInt != null
    ? parseConfidenceValue(finalConfidenceInt)
    : confidence;

  return {
    schema_version: 'aurora.preference_labels.v1',
    run_id: runId,
    task_id: taskId,
    sample_id: sampleId,
    sample_hash: sampleId,
    module_id: moduleId || 'overall',
    source,
    winner,
    overall_choice: winner,
    overall_choice_raw: winnerRaw,
    confidence: finalConfidence,
    confidence_int: finalConfidenceInt,
    reasons,
    notes: notes || null,
    rater_id: raterId,
    annotator_id: raterId,
    annotation_id: annotationId,
    created_at: createdAt,
    updated_at: updatedAt,
    timestamps: {
      created_at: createdAt,
      updated_at: updatedAt,
    },
    per_module_choice: perModuleChoice,
    per_module_choice_raw: perModuleChoiceRaw,
    baseline_id: baselineId,
    variant_id: variantId,
    role_a: roleA,
    role_b: roleB,
    task_batch: taskBatch,
    risk_features: (manifestInfo && manifestInfo.risk_features) || null,
    has_required_fields: Boolean(sampleId && winner && raterId),
    invalid_choice_count: invalidTotal,
    is_adjudication: parseBool(isAdjudication, false),
    source_export_file: exportRel,
    imported_at: importedAt,
  };
}

async function importJsonExport({
  filePath,
  exportRel,
  runId,
  args,
  manifestLookup,
  importedAt,
}) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const tasks = extractTasks(parsed);
  const outRows = [];

  for (let t = 0; t < tasks.length; t += 1) {
    const task = tasks[t] || {};
    const data = task.data && typeof task.data === 'object' ? task.data : {};
    const sampleId = String(data.sample_id || data.sample_hash || '').trim();
    if (!sampleId) continue;

    const manifestInfo = manifestLookup.get(sampleId) || null;
    const source = String(data.source || (manifestInfo && manifestInfo.source) || task.source || 'unknown').trim().toLowerCase() || 'unknown';
    const taskId = resolveTaskId(task, `task_${sampleId}`);

    const roleA = normalizeRole((manifestInfo && manifestInfo.role_a) || data.role_a, 'baseline');
    const roleB = normalizeRole((manifestInfo && manifestInfo.role_b) || data.role_b, roleA === 'baseline' ? 'variant' : 'baseline');
    const taskBatch = String((manifestInfo && manifestInfo.task_batch) || data.task_batch || data.batch || '').trim().toUpperCase() || null;

    const baselineId = String((manifestInfo && manifestInfo.baseline_id) || data.baseline_id || args.baseline_id || 'baseline_default').trim() || 'baseline_default';
    const variantId = String((manifestInfo && manifestInfo.variant_id) || data.variant_id || args.variant_id || 'variant1_forehead_hair_clip').trim() || 'variant1_forehead_hair_clip';

    const sortedAnnotations = sortAnnotations(task.annotations);
    const annotations = args.all_annotations ? sortedAnnotations : sortedAnnotations.slice(0, 1);

    for (let i = 0; i < annotations.length; i += 1) {
      const annotation = annotations[i] || {};
      const results = Array.isArray(annotation.result) ? annotation.result : [];

      let winnerRaw = null;
      let confidence = null;
      let confidenceInt = null;
      let reasons = [];
      let notes = null;
      let invalidChoiceCount = 0;
      const perModuleChoice = buildEmptyPerModuleChoice();
      const perModuleChoiceRaw = buildEmptyPerModuleChoice();

      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        const fromName = String(result.from_name || '').trim();
        const fromNameLower = fromName.toLowerCase();
        const type = String(result.type || '').trim().toLowerCase();

        if (type === 'choices' || type === 'choice') {
          const rawChoice = extractChoiceText(result);
          if (!rawChoice) continue;

          if (fromName === 'overall_choice') {
            winnerRaw = rawChoice;
            continue;
          }

          if (Object.prototype.hasOwnProperty.call(MODULE_FIELD_TO_ID, fromName)) {
            const moduleId = MODULE_FIELD_TO_ID[fromName];
            perModuleChoiceRaw[moduleId] = rawChoice;
            const mapped = normalizeWinner(rawChoice, roleA, roleB);
            perModuleChoice[moduleId] = mapped.value;
            if (mapped.invalid) invalidChoiceCount += 1;
            continue;
          }

          if (fromNameLower.includes('confidence')) {
            confidence = extractConfidence(result) ?? confidence;
            confidenceInt = parseConfidenceInt(extractChoiceText(result)) ?? confidenceInt;
          }
          if (fromName === 'overall_reasons') {
            reasons = normalizeReasons(extractChoicesArray(result));
          }
          continue;
        }

        if ((type === 'textarea' || type === 'text') && fromName === 'notes') {
          const token = extractNotesText(result);
          if (token) notes = token;
          continue;
        }

        if (type === 'rating' || type === 'number') {
          const parsedConfidence = extractConfidence(result);
          if (parsedConfidence != null) confidence = parsedConfidence;
          if (fromNameLower.includes('confidence')) {
            const valueObj = result && result.value && typeof result.value === 'object' ? result.value : {};
            confidenceInt = parseConfidenceInt(
              valueObj.rating != null
                ? valueObj.rating
                : (valueObj.number != null ? valueObj.number : parsedConfidence),
            ) ?? confidenceInt;
          }
        }
      }

      const raterRaw = resolveAnnotatorRaw(annotation);
      const raterId = anonymizeRater(raterRaw);
      const annotationId = resolveAnnotationId(annotation, taskId, sampleId, raterId, i);
      const createdAt = annotation.created_at || null;
      const updatedAt = annotation.updated_at || null;

      outRows.push(makeImportedRow({
        runId,
        sampleId,
        source,
        winnerRaw,
        roleA,
        roleB,
        baselineId,
        variantId,
        taskBatch,
        raterRaw,
        annotationId,
        taskId,
        createdAt,
        updatedAt,
        confidence,
        confidenceInt,
        reasons,
        notes,
        perModuleChoice,
        perModuleChoiceRaw,
        manifestInfo,
        invalidChoiceCount,
        exportRel,
        importedAt,
        isAdjudication: data.adjudication || (task.meta && task.meta.adjudication) || false,
      }));
    }
  }

  return outRows;
}

async function importCsvExport({
  filePath,
  exportRel,
  runId,
  args,
  manifestLookup,
  importedAt,
}) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const rows = parseCsvRows(raw);
  const outRows = [];

  for (let i = 0; i < rows.length; i += 1) {
    const csvRow = rows[i] || {};
    const sampleId = firstNonEmpty(csvRow, ['sample_id', 'sample_hash', 'data.sample_id', 'task.data.sample_id', 'task.sample_id']);
    if (!sampleId) continue;

    const manifestInfo = manifestLookup.get(sampleId) || null;
    const source = String(firstNonEmpty(csvRow, ['source', 'data.source']) || (manifestInfo && manifestInfo.source) || 'unknown').trim().toLowerCase() || 'unknown';
    const taskId = firstNonEmpty(csvRow, ['task_id', 'task.id', 'id']) || `task_${sampleId}`;

    const roleA = normalizeRole((manifestInfo && manifestInfo.role_a) || firstNonEmpty(csvRow, ['role_a', 'data.role_a']), 'baseline');
    const roleB = normalizeRole((manifestInfo && manifestInfo.role_b) || firstNonEmpty(csvRow, ['role_b', 'data.role_b']), roleA === 'baseline' ? 'variant' : 'baseline');
    const taskBatch = String(
      (manifestInfo && manifestInfo.task_batch)
      || firstNonEmpty(csvRow, ['task_batch', 'data.task_batch', 'batch'])
      || '',
    ).trim().toUpperCase() || null;

    const baselineId = String((manifestInfo && manifestInfo.baseline_id) || firstNonEmpty(csvRow, ['baseline_id', 'data.baseline_id']) || args.baseline_id).trim() || 'baseline_default';
    const variantId = String((manifestInfo && manifestInfo.variant_id) || firstNonEmpty(csvRow, ['variant_id', 'data.variant_id']) || args.variant_id).trim() || 'variant1_forehead_hair_clip';

    const raterRaw = firstNonEmpty(csvRow, ['annotator_id', 'rater_id', 'annotator', 'completed_by', 'completed_by_id', 'email']) || 'unknown_rater';
    const raterId = anonymizeRater(raterRaw);
    const annotationId = firstNonEmpty(csvRow, ['annotation_id', 'annotation.id', 'id']) || resolveAnnotationId({}, taskId, sampleId, raterId, i);

    const createdAt = firstNonEmpty(csvRow, ['created_at', 'annotation.created_at']) || null;
    const updatedAt = firstNonEmpty(csvRow, ['updated_at', 'annotation.updated_at']) || null;

    const confidenceRaw = firstNonEmpty(csvRow, ['confidence_int', 'overall_confidence', 'confidence']);
    const confidenceInt = parseConfidenceInt(confidenceRaw);
    const confidence = parseConfidenceValue(confidenceRaw);

    const reasons = parseDelimitedReasons(firstNonEmpty(csvRow, ['reasons', 'overall_reasons']));
    const notes = firstNonEmpty(csvRow, ['notes', 'note']) || null;

    const winnerRaw = firstNonEmpty(csvRow, ['overall_choice', 'winner', 'choice']);
    const perModuleChoice = buildEmptyPerModuleChoice();
    const perModuleChoiceRaw = buildEmptyPerModuleChoice();
    let invalidChoiceCount = 0;

    const perModuleInline = extractPerModuleFromJsonToken(firstNonEmpty(csvRow, ['per_module_choice', 'per_module_choice_raw']));

    for (const [field, moduleId] of Object.entries(MODULE_FIELD_TO_ID)) {
      const rawChoice = firstNonEmpty(csvRow, [field, `${moduleId}_choice`, `pref.${moduleId}`])
        || (perModuleInline && perModuleInline[moduleId] != null ? String(perModuleInline[moduleId]) : '');
      if (!rawChoice) continue;
      perModuleChoiceRaw[moduleId] = rawChoice;
      const mapped = normalizeWinner(rawChoice, roleA, roleB);
      perModuleChoice[moduleId] = mapped.value;
      if (mapped.invalid) invalidChoiceCount += 1;
    }

    const moduleId = firstNonEmpty(csvRow, ['module_id', 'module']) || 'overall';

    outRows.push(makeImportedRow({
      runId,
      sampleId,
      source,
      winnerRaw,
      roleA,
      roleB,
      baselineId,
      variantId,
      taskBatch,
      raterRaw,
      annotationId,
      taskId,
      createdAt,
      updatedAt,
      confidence,
      confidenceInt,
      reasons,
      notes,
      perModuleChoice,
      perModuleChoiceRaw,
      manifestInfo,
      invalidChoiceCount,
      exportRel,
      importedAt,
      isAdjudication: firstNonEmpty(csvRow, ['adjudication', 'is_adjudication']) || false,
      moduleId,
    }));
  }

  return outRows;
}

async function importExportFile({
  filePath,
  runId,
  args,
  manifestLookup,
  importedAt,
}) {
  const ext = String(path.extname(filePath) || '').trim().toLowerCase();
  const exportRel = toPosix(path.relative(process.cwd(), filePath));

  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') {
    return importJsonExport({
      filePath,
      exportRel,
      runId,
      args,
      manifestLookup,
      importedAt,
    });
  }

  if (ext === '.csv') {
    return importCsvExport({
      filePath,
      exportRel,
      runId,
      args,
      manifestLookup,
      importedAt,
    });
  }

  throw new Error(`unsupported_export_ext:${ext || 'unknown'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }
  if (!args.input_paths.length) {
    process.stderr.write('preference_label_import: missing input, use --in or --exports\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const outputPath = path.resolve(
    args.out || path.join('artifacts', `preference_round1_${runId}`, 'preference_labels.ndjson'),
  );
  const reportDir = path.resolve(args.report_dir);
  const qcReportPath = path.resolve(path.join(reportDir, `preference_import_qc_${runId}.md`));

  const manifestLookup = new Map();
  if (args.manifest) {
    const manifestPath = path.resolve(args.manifest);
    const manifestRaw = await fsp.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    for (const [sampleId, value] of buildManifestLookup(manifest).entries()) {
      manifestLookup.set(sampleId, value);
    }
  }

  const importStartedAt = new Date().toISOString();
  const rawRows = [];
  for (const inputPath of args.input_paths) {
    const importedRows = await importExportFile({
      filePath: inputPath,
      runId,
      args,
      manifestLookup,
      importedAt: importStartedAt,
    });
    rawRows.push(...importedRows);
  }

  const deduped = dedupeRows(rawRows);
  const outRows = deduped.rows;

  await Promise.all([
    fsp.mkdir(path.dirname(outputPath), { recursive: true }),
    fsp.mkdir(path.dirname(qcReportPath), { recursive: true }),
  ]);

  const ndjson = outRows.length ? `${outRows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fsp.writeFile(outputPath, ndjson, 'utf8');

  const summary = {
    input_exports: args.input_paths.length,
    raw_rows: rawRows.length,
    imported_rows: outRows.length,
    duplicate_rows_dropped: deduped.duplicate_rows_dropped,
    rows_with_required_fields: outRows.filter((row) => row.has_required_fields).length,
    rows_missing_required_fields: outRows.filter((row) => !row.has_required_fields).length,
    rows_with_invalid_choices: outRows.filter((row) => Number(row.invalid_choice_count || 0) > 0).length,
    total_invalid_choice_count: outRows.reduce((acc, row) => acc + Math.max(0, Number(row.invalid_choice_count || 0)), 0),
    missing_confidence_count: outRows.filter((row) => row.confidence_int == null).length,
    cannot_tell_rate: outRows.length
      ? Math.round(
        (outRows.filter((row) => String(row.winner || '') === 'cannot_tell').length / outRows.length) * 1000,
      ) / 1000
      : null,
    per_annotator: (() => {
      const counters = new Map();
      for (const row of outRows) {
        const id = String(row.rater_id || 'unknown_rater');
        if (!counters.has(id)) counters.set(id, { rater_id: id, labeled_rows: 0, sample_ids: new Set() });
        const entry = counters.get(id);
        entry.labeled_rows += 1;
        entry.sample_ids.add(String(row.sample_id || ''));
      }
      return [...counters.values()]
        .map((entry) => ({
          rater_id: entry.rater_id,
          labeled_rows: entry.labeled_rows,
          labeled_samples: entry.sample_ids.size,
        }))
        .sort((a, b) => b.labeled_rows - a.labeled_rows || a.rater_id.localeCompare(b.rater_id));
    })(),
  };

  const qcRows = [...outRows].sort((a, b) => {
    const missingDelta = Number(a.has_required_fields ? 0 : 1) - Number(b.has_required_fields ? 0 : 1);
    if (missingDelta !== 0) return -missingDelta;
    const missingConfidenceDelta = Number(a.confidence_int == null ? 1 : 0) - Number(b.confidence_int == null ? 1 : 0);
    if (missingConfidenceDelta !== 0) return -missingConfidenceDelta;
    const invalidDelta = Number(b.invalid_choice_count || 0) - Number(a.invalid_choice_count || 0);
    if (invalidDelta !== 0) return invalidDelta;
    return String(a.sample_id || '').localeCompare(String(b.sample_id || ''));
  });

  const qcMarkdown = buildQcMarkdown({
    runId,
    inputRels: args.input_paths.map((inputPath) => toPosix(path.relative(process.cwd(), inputPath))),
    outputRel: toPosix(path.relative(process.cwd(), outputPath)),
    qcRows,
    summary,
  });
  await fsp.writeFile(qcReportPath, qcMarkdown, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    input_paths: args.input_paths.map((inputPath) => toPosix(path.relative(process.cwd(), inputPath))),
    output_path: toPosix(path.relative(process.cwd(), outputPath)),
    qc_report_md: toPosix(path.relative(process.cwd(), qcReportPath)),
    all_annotations: args.all_annotations,
    ...summary,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_label_import_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
