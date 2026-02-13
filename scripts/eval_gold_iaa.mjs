#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runTimestampKey } from './internal_batch_helpers.mjs';

const require = createRequire(import.meta.url);
const { decodeRleBinary, countOnes, intersectionCount, unionCount } = require('../src/auroraBff/evalAdapters/common/metrics');

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

const STRONG_MODULES = Object.freeze(['nose', 'forehead', 'left_cheek', 'right_cheek', 'chin']);
const WEAK_UNDER_EYE_MODULES = Object.freeze(['under_eye_left', 'under_eye_right']);
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_GRID_SIZE = 256;
const DEFAULT_MIN_IOU_THRESHOLD = 0.75;

const HELP_TEXT = `eval_gold_iaa.mjs

Usage:
  node scripts/eval_gold_iaa.mjs --ls_export <label_studio_export.json> [options]

Required:
  --ls_export <path>                      Label Studio export with double-annotated tasks

Optional:
  --run_id <id>                           run id (default: infer from export filename)
  --report_dir <dir>                      output directory (default: reports)
  --grid_size <n>                         import grid size (default: 256)
  --min_miou_threshold <0-1>              soft gate threshold (default: 0.75)
  --help                                  show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function mean(values) {
  const valid = values.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (!valid.length) return null;
  return valid.reduce((acc, item) => acc + item, 0) / valid.length;
}

function percentile(values, p = 0.5) {
  const valid = values
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const rank = Math.max(0, Math.min(valid.length - 1, Math.floor((valid.length - 1) * p)));
  return valid[rank];
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function safeRatio(num, den) {
  if (!Number.isFinite(Number(num)) || !Number.isFinite(Number(den)) || Number(den) <= 0) return null;
  return Number(num) / Number(den);
}

function inferRunId(lsExportPath, explicitRunId = '') {
  if (explicitRunId) return explicitRunId;
  const file = path.basename(String(lsExportPath || ''));
  const patterns = [
    /label_studio_export_round1_(\d{15}|\d{8}_\d{6,9})\.(json|jsonl|ndjson)$/i,
    /round1_(\d{15}|\d{8}_\d{6,9})/i,
    /(?:export|labels?)_(\d{15}|\d{8}_\d{6,9})/i,
  ];
  for (const pattern of patterns) {
    const match = file.match(pattern);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function parseArgs(argv) {
  const out = {
    help: false,
    ls_export: process.env.LS_EXPORT || process.env.ROUND1_IN || '',
    run_id: process.env.RUN_ID || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    grid_size: process.env.EVAL_GOLD_GRID || DEFAULT_GRID_SIZE,
    min_miou_threshold: process.env.EVAL_GOLD_IAA_MIN_MIOU || DEFAULT_MIN_IOU_THRESHOLD,
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
    if (!next || String(next).startsWith('--')) continue;
    out[key] = String(next);
    i += 1;
  }
  out.help = parseBool(out.help, false);
  out.ls_export = String(out.ls_export || '').trim();
  out.run_id = String(out.run_id || '').trim();
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.grid_size = Math.max(64, Math.min(512, Math.trunc(parseNumber(out.grid_size, DEFAULT_GRID_SIZE, 64, 512))));
  out.min_miou_threshold = Math.max(0, Math.min(1, Number(out.min_miou_threshold) || DEFAULT_MIN_IOU_THRESHOLD));
  return out;
}

function parseJsonObject(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('empty_stdout');
  try {
    return JSON.parse(text);
  } catch (_error) {
    // fallback to last JSON blob
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    const candidate = lines.slice(i).join('\n');
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // continue
    }
  }
  throw new Error('json_parse_failed');
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

function resizeMaskNearest(sourceMask, sourceGrid, targetGrid) {
  const out = new Uint8Array(targetGrid * targetGrid);
  if (!(sourceMask instanceof Uint8Array)) return out;
  for (let y = 0; y < targetGrid; y += 1) {
    const sy = Math.max(0, Math.min(sourceGrid - 1, Math.floor(((y + 0.5) * sourceGrid) / targetGrid)));
    for (let x = 0; x < targetGrid; x += 1) {
      const sx = Math.max(0, Math.min(sourceGrid - 1, Math.floor(((x + 0.5) * sourceGrid) / targetGrid)));
      out[(y * targetGrid) + x] = sourceMask[(sy * sourceGrid) + sx] ? 1 : 0;
    }
  }
  return out;
}

function decodeMaskPayload(payload, gridSize) {
  if (!payload || typeof payload !== 'object') return null;
  const rle = typeof payload.rle_norm === 'string'
    ? payload.rle_norm
    : (typeof payload.mask_rle_norm === 'string' ? payload.mask_rle_norm : '');
  if (!String(rle || '').trim()) return null;
  const srcGrid = Math.max(8, Math.trunc(Number(payload.grid_size || payload.mask_grid || gridSize) || gridSize));
  const decoded = decodeRleBinary(String(rle).trim(), srcGrid * srcGrid);
  if (srcGrid === gridSize) return decoded;
  return resizeMaskNearest(decoded, srcGrid, gridSize);
}

function metricIou(maskA, maskB) {
  const den = unionCount(maskA, maskB);
  if (den <= 0) return null;
  return intersectionCount(maskA, maskB) / den;
}

function metricCoverage(predMask, gtMask) {
  const gtPixels = countOnes(gtMask);
  if (gtPixels <= 0) return null;
  return intersectionCount(predMask, gtMask) / gtPixels;
}

function metricLeakage(predMask, badMask) {
  const predPixels = countOnes(predMask);
  if (predPixels <= 0) return null;
  return intersectionCount(predMask, badMask) / predPixels;
}

function decodeModuleMask(row, moduleId, gridSize) {
  const moduleMasks = row && row.module_masks && typeof row.module_masks === 'object' ? row.module_masks : {};
  return decodeMaskPayload(moduleMasks[moduleId], gridSize);
}

function decodeCoreMask(row, key, gridSize) {
  return decodeMaskPayload(row && row[key], gridSize);
}

function pickPair(rows) {
  const sorted = [...rows].sort((a, b) => {
    const aTs = Date.parse(String(a.created_at || a.meta?.created_at || '')) || 0;
    const bTs = Date.parse(String(b.created_at || b.meta?.created_at || '')) || 0;
    return aTs - bTs;
  });
  if (sorted.length < 2) return null;
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (String(sorted[i].annotator_id || '') === String(sorted[j].annotator_id || '')) continue;
      return [sorted[i], sorted[j]];
    }
  }
  return [sorted[0], sorted[1]];
}

function computeUnderEyeMetrics(row, gridSize) {
  const skinMask = decodeCoreMask(row, 'skin_mask', gridSize);
  const bgMask = decodeCoreMask(row, 'background_mask', gridSize);
  const hairMask = decodeCoreMask(row, 'hair_mask', gridSize);
  const rows = [];
  for (const moduleId of WEAK_UNDER_EYE_MODULES) {
    const moduleMask = decodeModuleMask(row, moduleId, gridSize);
    if (!(moduleMask instanceof Uint8Array)) continue;
    rows.push({
      module_id: moduleId,
      band_coverage: skinMask instanceof Uint8Array ? metricCoverage(moduleMask, skinMask) : null,
      leakage_bg: bgMask instanceof Uint8Array ? metricLeakage(moduleMask, bgMask) : null,
      leakage_hair: hairMask instanceof Uint8Array ? metricLeakage(moduleMask, hairMask) : null,
    });
  }
  return {
    band_coverage: mean(rows.map((item) => item.band_coverage)),
    leakage_bg: mean(rows.map((item) => item.leakage_bg)),
    leakage_hair: mean(rows.map((item) => item.leakage_hair)),
    scored_count: rows.length,
  };
}

function computeForeheadHairOverlap(row, gridSize) {
  const foreheadMask = decodeModuleMask(row, 'forehead', gridSize);
  const hairMask = decodeCoreMask(row, 'hair_mask', gridSize);
  if (!(foreheadMask instanceof Uint8Array) || !(hairMask instanceof Uint8Array)) return null;
  return safeRatio(intersectionCount(foreheadMask, hairMask), countOnes(foreheadMask));
}

function comparePair(rowA, rowB, gridSize) {
  const strongScores = [];
  for (const moduleId of STRONG_MODULES) {
    const aMask = decodeModuleMask(rowA, moduleId, gridSize);
    const bMask = decodeModuleMask(rowB, moduleId, gridSize);
    if (!(aMask instanceof Uint8Array) || !(bMask instanceof Uint8Array)) continue;
    strongScores.push({
      module_id: moduleId,
      iou: metricIou(aMask, bMask),
    });
  }
  const strongMean = mean(strongScores.map((item) => item.iou));

  const underEyeA = computeUnderEyeMetrics(rowA, gridSize);
  const underEyeB = computeUnderEyeMetrics(rowB, gridSize);

  const foreheadA = computeForeheadHairOverlap(rowA, gridSize);
  const foreheadB = computeForeheadHairOverlap(rowB, gridSize);

  const underEyeBandDiff = Number.isFinite(Number(underEyeA.band_coverage)) && Number.isFinite(Number(underEyeB.band_coverage))
    ? Math.abs(Number(underEyeA.band_coverage) - Number(underEyeB.band_coverage))
    : null;
  const underEyeLeakBgDiff = Number.isFinite(Number(underEyeA.leakage_bg)) && Number.isFinite(Number(underEyeB.leakage_bg))
    ? Math.abs(Number(underEyeA.leakage_bg) - Number(underEyeB.leakage_bg))
    : null;
  const underEyeLeakHairDiff = Number.isFinite(Number(underEyeA.leakage_hair)) && Number.isFinite(Number(underEyeB.leakage_hair))
    ? Math.abs(Number(underEyeA.leakage_hair) - Number(underEyeB.leakage_hair))
    : null;
  const foreheadDiff = Number.isFinite(Number(foreheadA)) && Number.isFinite(Number(foreheadB))
    ? Math.abs(Number(foreheadA) - Number(foreheadB))
    : null;

  const disagreementScore = (
    (Number.isFinite(Number(strongMean)) ? 1 - Number(strongMean) : 1)
    + (Number.isFinite(Number(foreheadDiff)) ? Number(foreheadDiff) : 0)
    + (Number.isFinite(Number(underEyeBandDiff)) ? Number(underEyeBandDiff) : 0)
    + (Number.isFinite(Number(underEyeLeakBgDiff)) ? Number(underEyeLeakBgDiff) : 0)
    + (Number.isFinite(Number(underEyeLeakHairDiff)) ? Number(underEyeLeakHairDiff) : 0)
  );

  return {
    strong_scores: strongScores.map((item) => ({ module_id: item.module_id, iou: round3(item.iou) })),
    strong_module_miou_a_vs_b: round3(strongMean),
    forehead_hair_overlap_a: round3(foreheadA),
    forehead_hair_overlap_b: round3(foreheadB),
    forehead_hair_overlap_diff_abs: round3(foreheadDiff),
    under_eye_band_coverage_a: round3(underEyeA.band_coverage),
    under_eye_band_coverage_b: round3(underEyeB.band_coverage),
    under_eye_band_coverage_diff_abs: round3(underEyeBandDiff),
    under_eye_leakage_bg_a: round3(underEyeA.leakage_bg),
    under_eye_leakage_bg_b: round3(underEyeB.leakage_bg),
    under_eye_leakage_bg_diff_abs: round3(underEyeLeakBgDiff),
    under_eye_leakage_hair_a: round3(underEyeA.leakage_hair),
    under_eye_leakage_hair_b: round3(underEyeB.leakage_hair),
    under_eye_leakage_hair_diff_abs: round3(underEyeLeakHairDiff),
    disagreement_score: round3(disagreementScore),
  };
}

function renderMarkdown({
  runId,
  args,
  pairRows,
  summary,
  top20,
  files,
}) {
  const lines = [];
  lines.push('# Eval Gold IAA');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- ls_export: \`${toPosix(path.relative(process.cwd(), path.resolve(args.ls_export)))}\``);
  lines.push(`- min_miou_threshold: ${args.min_miou_threshold}`);
  lines.push(`- comparable_task_pairs: ${pairRows.length}`);
  lines.push(`- soft_gate_pass: ${summary.soft_gate_pass}`);
  lines.push(`- soft_gate_note: ${summary.soft_gate_note}`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| metric | mean | p50 | p90 |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| strong_module_mIoU_A_vs_B | ${summary.strong_module_miou_a_vs_b_mean ?? '-'} | ${summary.strong_module_miou_a_vs_b_p50 ?? '-'} | ${summary.strong_module_miou_a_vs_b_p90 ?? '-'} |`);
  lines.push(`| forehead_hair_overlap_diff_abs | ${summary.forehead_hair_overlap_diff_abs_mean ?? '-'} | ${summary.forehead_hair_overlap_diff_abs_p50 ?? '-'} | ${summary.forehead_hair_overlap_diff_abs_p90 ?? '-'} |`);
  lines.push(`| under_eye_band_coverage_diff_abs | ${summary.under_eye_band_coverage_diff_abs_mean ?? '-'} | ${summary.under_eye_band_coverage_diff_abs_p50 ?? '-'} | ${summary.under_eye_band_coverage_diff_abs_p90 ?? '-'} |`);
  lines.push(`| under_eye_leakage_bg_diff_abs | ${summary.under_eye_leakage_bg_diff_abs_mean ?? '-'} | ${summary.under_eye_leakage_bg_diff_abs_p50 ?? '-'} | ${summary.under_eye_leakage_bg_diff_abs_p90 ?? '-'} |`);
  lines.push(`| under_eye_leakage_hair_diff_abs | ${summary.under_eye_leakage_hair_diff_abs_mean ?? '-'} | ${summary.under_eye_leakage_hair_diff_abs_p50 ?? '-'} | ${summary.under_eye_leakage_hair_diff_abs_p90 ?? '-'} |`);
  lines.push('');
  lines.push('## Top20 Disagreement Tasks');
  lines.push('');
  lines.push('| rank | sample_hash | source | task_id | annotator_a | annotator_b | strong_mIoU_A_vs_B | forehead_overlap_diff | under_eye_cov_diff | under_eye_leak_bg_diff | under_eye_leak_hair_diff | disagreement_score |');
  lines.push('|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|');
  if (!top20.length) {
    lines.push('| 1 | - | - | - | - | - | - | - | - | - | - | - |');
  } else {
    top20.forEach((row, idx) => {
      lines.push(
        `| ${idx + 1} | ${row.sample_hash || '-'} | ${row.source || '-'} | ${row.task_id || '-'} | ${row.annotator_a || '-'} | ${row.annotator_b || '-'} | ${row.strong_module_miou_a_vs_b ?? '-'} | ${row.forehead_hair_overlap_diff_abs ?? '-'} | ${row.under_eye_band_coverage_diff_abs ?? '-'} | ${row.under_eye_leakage_bg_diff_abs ?? '-'} | ${row.under_eye_leakage_hair_diff_abs ?? '-'} | ${row.disagreement_score ?? '-'} |`,
      );
    });
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- report_md: \`${files.mdRel}\``);
  lines.push(`- report_jsonl: \`${files.jsonlRel}\``);
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
  if (!args.ls_export) {
    process.stderr.write('eval_gold_iaa: missing --ls_export\n');
    process.exit(2);
    return;
  }
  const lsExportPath = path.resolve(args.ls_export);
  if (!fs.existsSync(lsExportPath)) {
    process.stderr.write(`eval_gold_iaa: ls_export not found: ${lsExportPath}\n`);
    process.exit(2);
    return;
  }

  const runId = inferRunId(lsExportPath, args.run_id);
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `eval_gold_iaa_${runId}_`));
  const importedPath = path.join(tmpDir, 'gold_annotations_all.ndjson');
  const importRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'gold_label_import.mjs'),
    '--in', lsExportPath,
    '--out', importedPath,
    '--run_id', runId,
    '--all_annotations', 'true',
    '--grid_size', String(args.grid_size),
    '--report_dir', tmpDir,
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    encoding: 'utf8',
  });
  if (importRun.status !== 0) {
    const stderr = String(importRun.stderr || importRun.stdout || '').trim();
    process.stderr.write(`eval_gold_iaa: import failed: ${stderr.slice(0, 600)}\n`);
    process.exit(3);
    return;
  }
  parseJsonObject(importRun.stdout);

  const importedRows = await readNdjson(importedPath);
  const grouped = new Map();
  for (const row of importedRows) {
    const taskId = String(row && row.meta && row.meta.task_id != null ? row.meta.task_id : '').trim();
    const sampleHash = String(row && row.sample_hash ? row.sample_hash : '').trim();
    const key = taskId || sampleHash;
    if (!key) continue;
    const bucket = grouped.get(key) || [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  const pairRows = [];
  for (const [taskKey, rows] of grouped.entries()) {
    const pair = pickPair(rows);
    if (!pair) continue;
    const [rowA, rowB] = pair;
    const compare = comparePair(rowA, rowB, args.grid_size);
    if (!Number.isFinite(Number(compare.strong_module_miou_a_vs_b))) continue;
    pairRows.push({
      task_key: taskKey,
      task_id: rowA && rowA.meta ? rowA.meta.task_id || rowB.meta?.task_id || null : null,
      sample_hash: rowA.sample_hash || rowB.sample_hash || null,
      source: rowA.source || rowB.source || 'unknown',
      annotator_a: rowA.annotator_id || null,
      annotator_b: rowB.annotator_id || null,
      ...compare,
    });
  }

  if (!pairRows.length) {
    process.stderr.write('eval_gold_iaa: no comparable double-annotated task pairs found\n');
    process.exit(4);
    return;
  }

  const strongValues = pairRows.map((row) => row.strong_module_miou_a_vs_b);
  const foreheadDiffValues = pairRows.map((row) => row.forehead_hair_overlap_diff_abs);
  const underEyeBandDiffValues = pairRows.map((row) => row.under_eye_band_coverage_diff_abs);
  const underEyeLeakBgDiffValues = pairRows.map((row) => row.under_eye_leakage_bg_diff_abs);
  const underEyeLeakHairDiffValues = pairRows.map((row) => row.under_eye_leakage_hair_diff_abs);

  const summary = {
    strong_module_miou_a_vs_b_mean: round3(mean(strongValues)),
    strong_module_miou_a_vs_b_p50: round3(percentile(strongValues, 0.5)),
    strong_module_miou_a_vs_b_p90: round3(percentile(strongValues, 0.9)),
    forehead_hair_overlap_diff_abs_mean: round3(mean(foreheadDiffValues)),
    forehead_hair_overlap_diff_abs_p50: round3(percentile(foreheadDiffValues, 0.5)),
    forehead_hair_overlap_diff_abs_p90: round3(percentile(foreheadDiffValues, 0.9)),
    under_eye_band_coverage_diff_abs_mean: round3(mean(underEyeBandDiffValues)),
    under_eye_band_coverage_diff_abs_p50: round3(percentile(underEyeBandDiffValues, 0.5)),
    under_eye_band_coverage_diff_abs_p90: round3(percentile(underEyeBandDiffValues, 0.9)),
    under_eye_leakage_bg_diff_abs_mean: round3(mean(underEyeLeakBgDiffValues)),
    under_eye_leakage_bg_diff_abs_p50: round3(percentile(underEyeLeakBgDiffValues, 0.5)),
    under_eye_leakage_bg_diff_abs_p90: round3(percentile(underEyeLeakBgDiffValues, 0.9)),
    under_eye_leakage_hair_diff_abs_mean: round3(mean(underEyeLeakHairDiffValues)),
    under_eye_leakage_hair_diff_abs_p50: round3(percentile(underEyeLeakHairDiffValues, 0.5)),
    under_eye_leakage_hair_diff_abs_p90: round3(percentile(underEyeLeakHairDiffValues, 0.9)),
  };
  summary.soft_gate_pass = Number(summary.strong_module_miou_a_vs_b_mean) >= Number(args.min_miou_threshold);
  summary.soft_gate_note = summary.soft_gate_pass
    ? `IAA strong_module_mIoU_A_vs_B_mean >= ${args.min_miou_threshold}`
    : `IAA below threshold (${summary.strong_module_miou_a_vs_b_mean} < ${args.min_miou_threshold}); tighten labeling guide/process`;

  const top20 = [...pairRows]
    .sort((a, b) => Number(b.disagreement_score || -Infinity) - Number(a.disagreement_score || -Infinity))
    .slice(0, 20);

  const jsonlPath = path.join(reportDir, `eval_gold_iaa_${runId}.jsonl`);
  const mdPath = path.join(reportDir, `eval_gold_iaa_${runId}.md`);
  const jsonPath = path.join(reportDir, `eval_gold_iaa_${runId}.json`);
  await fsp.writeFile(jsonlPath, `${top20.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const markdown = renderMarkdown({
    runId,
    args,
    pairRows,
    summary,
    top20,
    files: {
      mdRel: toPosix(path.relative(process.cwd(), mdPath)),
      jsonlRel: toPosix(path.relative(process.cwd(), jsonlPath)),
    },
  });
  await fsp.writeFile(mdPath, markdown, 'utf8');
  await fsp.writeFile(jsonPath, `${JSON.stringify({
    ok: true,
    run_id: runId,
    comparable_task_pairs: pairRows.length,
    min_miou_threshold: args.min_miou_threshold,
    summary,
    top_disagreement_tasks: top20,
    report_md: toPosix(path.relative(process.cwd(), mdPath)),
    report_jsonl: toPosix(path.relative(process.cwd(), jsonlPath)),
  }, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    comparable_task_pairs: pairRows.length,
    min_miou_threshold: args.min_miou_threshold,
    ...summary,
    report_md: toPosix(path.relative(process.cwd(), mdPath)),
    report_jsonl: toPosix(path.relative(process.cwd(), jsonlPath)),
    report_json: toPosix(path.relative(process.cwd(), jsonPath)),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`eval_gold_iaa_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
