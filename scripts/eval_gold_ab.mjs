#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTimestampKey } from './internal_batch_helpers.mjs';

const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_GRID_SIZE = 256;
const DEFAULT_UNDER_EYE_MIN_COVERAGE = 0.08;
const DEFAULT_SWEEP = [
  { min_pixels: 8, min_keep_ratio: 0.2 },
  { min_pixels: 12, min_keep_ratio: 0.25 },
  { min_pixels: 16, min_keep_ratio: 0.3 },
  { min_pixels: 24, min_keep_ratio: 0.35 },
];
const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const HELP_TEXT = `eval_gold_ab.mjs

Usage:
  node scripts/eval_gold_ab.mjs --gold_labels <path> [options]

Options:
  --gold_labels <path>             required; imported gold labels ndjson
  --pred_jsonl <path>              optional prediction rows jsonl
  --report_dir <dir>               output report directory (default: reports)
  --grid_size <n>                  eval grid size (default: 256)
  --rerun_local <bool>             force local rerun in eval_gold (default: true)
  --under_eye_min_coverage <0-1>   variant2 low-coverage fallback threshold (default: 0.08)
  --variant3_sweep <csv>           face-oval clip sweep pairs minPixels:minKeepRatio (default: 8:0.2,12:0.25,16:0.3,24:0.35)
  --help                           show help
`;

function parseBool(value, fallback = true) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
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

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function csvEscape(value) {
  const token = String(value == null ? '' : value);
  if (token.includes(',') || token.includes('"') || token.includes('\n')) {
    return `"${token.replace(/"/g, '""')}"`;
  }
  return token;
}

function parseSweep(raw) {
  const token = String(raw || '').trim();
  if (!token) return DEFAULT_SWEEP;
  const pairs = token
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(':').map((v) => v.trim()))
    .filter((pair) => pair.length === 2)
    .map(([a, b]) => ({
      min_pixels: Math.max(1, Math.trunc(Number(a) || 0)),
      min_keep_ratio: Math.max(0, Math.min(1, Number(b) || 0)),
    }))
    .filter((pair) => Number.isFinite(pair.min_pixels) && Number.isFinite(pair.min_keep_ratio));
  return pairs.length ? pairs : DEFAULT_SWEEP;
}

function parseArgs(argv) {
  const out = {
    help: false,
    gold_labels: process.env.GOLD_LABELS || process.env.EVAL_GOLD_LABELS || '',
    pred_jsonl: process.env.PRED_JSONL || process.env.EVAL_GOLD_PRED_JSONL || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    grid_size: process.env.EVAL_GOLD_GRID || DEFAULT_GRID_SIZE,
    rerun_local: process.env.EVAL_GOLD_RERUN_LOCAL || 'true',
    under_eye_min_coverage: process.env.EVAL_GOLD_AB_UNDER_EYE_MIN_COVERAGE || DEFAULT_UNDER_EYE_MIN_COVERAGE,
    variant3_sweep: process.env.EVAL_GOLD_AB_SWEEP || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token === '--gold_labels' && next) {
      out.gold_labels = String(next);
      i += 1;
      continue;
    }
    if (token === '--pred_jsonl' && next) {
      out.pred_jsonl = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = String(next);
      i += 1;
      continue;
    }
    if (token === '--rerun_local' && next) {
      out.rerun_local = String(next);
      i += 1;
      continue;
    }
    if (token === '--under_eye_min_coverage' && next) {
      out.under_eye_min_coverage = String(next);
      i += 1;
      continue;
    }
    if (token === '--variant3_sweep' && next) {
      out.variant3_sweep = String(next);
      i += 1;
      continue;
    }
  }
  out.help = parseBool(out.help, false);
  out.gold_labels = String(out.gold_labels || '').trim();
  out.pred_jsonl = String(out.pred_jsonl || '').trim();
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.grid_size = Math.max(64, Math.min(512, Math.trunc(parseNumber(out.grid_size, DEFAULT_GRID_SIZE, 64, 512))));
  out.rerun_local = parseBool(out.rerun_local, true);
  out.under_eye_min_coverage = Math.max(0, Math.min(1, Number(out.under_eye_min_coverage) || DEFAULT_UNDER_EYE_MIN_COVERAGE));
  out.variant3_sweep = parseSweep(out.variant3_sweep);
  return out;
}

function parseJsonObject(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('empty_stdout');
  try {
    return JSON.parse(text);
  } catch (_error) {
    // fallback
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    const candidate = lines.slice(i).join('\n');
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // keep scanning
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

function getOverallMetric(overall, key) {
  if (!overall || typeof overall !== 'object') return null;
  const direct = Number(overall[key]);
  if (Number.isFinite(direct)) return direct;
  const legacy = Number(overall[`${key}_mean`]);
  if (Number.isFinite(legacy)) return legacy;
  return null;
}

function groupScore(metrics) {
  const strong = Number(metrics.strong_module_miou_mean);
  const skin = Number(metrics.skin_iou_mean);
  const underEyeCov = Number(metrics.under_eye_band_coverage_mean);
  const underEyeLeakBg = Number(metrics.under_eye_leakage_bg_mean);
  const underEyeLeakHair = Number(metrics.under_eye_leakage_hair_mean);
  const foreheadHair = Number(metrics.forehead_hair_overlap_rate_mean);
  return round3(
    (Number.isFinite(strong) ? strong * 2.2 : 0)
    + (Number.isFinite(skin) ? skin * 0.5 : 0)
    + (Number.isFinite(underEyeCov) ? underEyeCov * 0.8 : 0)
    - (Number.isFinite(underEyeLeakBg) ? underEyeLeakBg * 0.9 : 0)
    - (Number.isFinite(underEyeLeakHair) ? underEyeLeakHair * 0.9 : 0)
    - (Number.isFinite(foreheadHair) ? foreheadHair * 1.1 : 0),
  );
}

function metricDelta(base, cur) {
  if (!Number.isFinite(Number(base)) || !Number.isFinite(Number(cur))) return null;
  return round3(Number(cur) - Number(base));
}

async function runEvalGroup({ group, args, repoRoot, tempRoot }) {
  const calibrationOut = path.join(tempRoot, `${group.id}_calibration.ndjson`);
  const cli = [
    path.join(repoRoot, 'scripts', 'eval_gold.mjs'),
    '--gold_labels', args.gold_labels,
    '--report_dir', tempRoot,
    '--grid_size', String(args.grid_size),
    '--calibration_out', calibrationOut,
    '--rerun_local', args.rerun_local ? 'true' : 'false',
  ];
  if (args.pred_jsonl) cli.push('--pred_jsonl', args.pred_jsonl);
  if (group.eval_args && Array.isArray(group.eval_args)) cli.push(...group.eval_args);

  const env = {
    ...process.env,
    ...(group.env_overrides || {}),
  };
  const run = spawnSync(process.execPath, cli, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    throw new Error(`group_eval_failed:${group.id}:${String(run.stderr || run.stdout || '').slice(0, 400)}`);
  }
  const summary = parseJsonObject(run.stdout);
  const jsonlPath = path.resolve(repoRoot, summary.report_jsonl);
  const rows = await readNdjson(jsonlPath);
  const overall = summary.overall && typeof summary.overall === 'object' ? summary.overall : {};
  const metrics = {
    skin_iou_mean: getOverallMetric(overall, 'skin_iou_mean') ?? getOverallMetric(overall, 'skin_iou'),
    strong_module_miou_mean: getOverallMetric(overall, 'strong_module_miou_mean'),
    under_eye_band_coverage_mean: getOverallMetric(overall, 'under_eye_band_coverage_mean'),
    under_eye_leakage_bg_mean: getOverallMetric(overall, 'under_eye_leakage_bg_mean'),
    under_eye_leakage_hair_mean: getOverallMetric(overall, 'under_eye_leakage_hair_mean'),
    forehead_hair_overlap_rate_mean: getOverallMetric(overall, 'forehead_hair_overlap_rate'),
    samples_total: Number(summary.samples_total) || rows.length,
    samples_scored: Number(summary.samples_scored) || rows.filter((row) => row.skin_iou != null).length,
  };
  return {
    group,
    summary,
    rows,
    metrics,
  };
}

function rowMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const hash = String(row && row.sample_hash ? row.sample_hash : '').trim();
    if (!hash) continue;
    map.set(hash, row);
  }
  return map;
}

function buildTopRegressions({ baselineRows, variantRows, limit = 20 }) {
  const baseMap = rowMap(baselineRows);
  const variantMap = rowMap(variantRows);
  const rows = [];
  for (const [sampleHash, baseRow] of baseMap.entries()) {
    const varRow = variantMap.get(sampleHash);
    if (!varRow) continue;
    const deltaDriver = metricDelta(baseRow.driver_score, varRow.driver_score);
    if (!Number.isFinite(Number(deltaDriver))) continue;
    rows.push({
      sample_hash: sampleHash,
      source: varRow.source || baseRow.source || 'unknown',
      driver_delta: deltaDriver,
      strong_miou_delta: metricDelta(baseRow.strong_module_miou_mean, varRow.strong_module_miou_mean),
      under_eye_cov_delta: metricDelta(baseRow.under_eye_band_coverage_mean, varRow.under_eye_band_coverage_mean),
      under_eye_leak_bg_delta: metricDelta(baseRow.under_eye_leakage_bg_mean, varRow.under_eye_leakage_bg_mean),
      under_eye_leak_hair_delta: metricDelta(baseRow.under_eye_leakage_hair_mean, varRow.under_eye_leakage_hair_mean),
      forehead_hair_overlap_delta: metricDelta(baseRow.forehead_hair_overlap_rate, varRow.forehead_hair_overlap_rate),
      fail_reason_base: baseRow.fail_reason || null,
      fail_reason_variant: varRow.fail_reason || null,
    });
  }
  return rows
    .sort((a, b) => Number(b.driver_delta) - Number(a.driver_delta))
    .slice(0, Math.max(1, limit));
}

function buildMarkdown({ runId, args, groups, baseline, recommended, topRegressions, files }) {
  const lines = [];
  lines.push('# Eval Gold AB');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- gold_labels: \`${toPosix(path.relative(process.cwd(), path.resolve(args.gold_labels)))}\``);
  lines.push(`- pred_jsonl: ${args.pred_jsonl ? `\`${toPosix(path.relative(process.cwd(), path.resolve(args.pred_jsonl)))}\`` : '-'}`);
  lines.push(`- rerun_local: ${args.rerun_local}`);
  lines.push(`- grid_size: ${args.grid_size}`);
  lines.push(`- under_eye_min_coverage(variant2): ${args.under_eye_min_coverage}`);
  lines.push('');
  lines.push('## Group Metrics');
  lines.push('');
  lines.push('| group | skin_iou | strong_module_mIoU | under_eye_cov | under_eye_leak_bg | under_eye_leak_hair | forehead_hair_overlap | score | delta_vs_baseline (strong_mIoU / forehead_hair_overlap) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const item of groups) {
    const m = item.metrics;
    const deltaStrong = metricDelta(baseline.metrics.strong_module_miou_mean, m.strong_module_miou_mean);
    const deltaForehead = metricDelta(baseline.metrics.forehead_hair_overlap_rate_mean, m.forehead_hair_overlap_rate_mean);
    lines.push(
      `| ${item.group.id} | ${round3(m.skin_iou_mean) ?? '-'} | ${round3(m.strong_module_miou_mean) ?? '-'} | ${round3(m.under_eye_band_coverage_mean) ?? '-'} | ${round3(m.under_eye_leakage_bg_mean) ?? '-'} | ${round3(m.under_eye_leakage_hair_mean) ?? '-'} | ${round3(m.forehead_hair_overlap_rate_mean) ?? '-'} | ${item.score ?? '-'} | ${(deltaStrong ?? '-')}/${(deltaForehead ?? '-')} |`,
    );
  }
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(`- recommended_group: \`${recommended.group.id}\``);
  lines.push(`- rationale: maximize strong_module_mIoU while penalizing forehead_hair_overlap and under-eye leakage.`);
  lines.push('');
  lines.push('## Top 20 Regression Samples (recommended - baseline)');
  lines.push('');
  lines.push('| rank | source | sample_hash | driver_delta | strong_mIoU_delta | under_eye_cov_delta | under_eye_leak_bg_delta | under_eye_leak_hair_delta | forehead_hair_overlap_delta | fail_reason_base | fail_reason_recommended |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|');
  if (!topRegressions.length) {
    lines.push('| 1 | - | - | - | - | - | - | - | - | - | - |');
  } else {
    topRegressions.forEach((row, index) => {
      lines.push(
        `| ${index + 1} | ${row.source} | ${row.sample_hash} | ${row.driver_delta ?? '-'} | ${row.strong_miou_delta ?? '-'} | ${row.under_eye_cov_delta ?? '-'} | ${row.under_eye_leak_bg_delta ?? '-'} | ${row.under_eye_leak_hair_delta ?? '-'} | ${row.forehead_hair_overlap_delta ?? '-'} | ${row.fail_reason_base || '-'} | ${row.fail_reason_variant || '-'} |`,
      );
    });
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- report_json: \`${files.json}\``);
  lines.push(`- report_csv: \`${files.csv}\``);
  lines.push(`- report_md: \`${files.md}\``);
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
  if (!args.gold_labels) {
    process.stderr.write('eval_gold_ab: missing --gold_labels\n');
    process.exit(2);
    return;
  }
  const goldPath = path.resolve(args.gold_labels);
  if (!fs.existsSync(goldPath)) {
    process.stderr.write(`eval_gold_ab: gold labels not found: ${goldPath}\n`);
    process.exit(2);
    return;
  }
  if (args.pred_jsonl) {
    const predPath = path.resolve(args.pred_jsonl);
    if (!fs.existsSync(predPath)) {
      process.stderr.write(`eval_gold_ab: pred jsonl not found: ${predPath}\n`);
      process.exit(2);
      return;
    }
  }

  const runId = runTimestampKey();
  const reportDir = path.resolve(args.report_dir);
  const tempRoot = path.join(reportDir, `.eval_gold_ab_${runId}`);
  await fsp.mkdir(tempRoot, { recursive: true });

  const variant3Groups = args.variant3_sweep.map((pair) => ({
    id: `variant3_clip_${pair.min_pixels}_${String(pair.min_keep_ratio).replace('.', '_')}`,
    kind: 'variant3',
    env_overrides: {
      DIAG_FACE_OVAL_CLIP_MIN_PIXELS: String(pair.min_pixels),
      DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO: String(pair.min_keep_ratio),
    },
    eval_args: [],
    note: `face_oval clip sweep min_pixels=${pair.min_pixels}, min_keep_ratio=${pair.min_keep_ratio}`,
  }));

  const groups = [
    {
      id: 'baseline',
      kind: 'baseline',
      env_overrides: {},
      eval_args: [],
      note: 'current default params',
    },
    {
      id: 'variant1_forehead_hair_clip',
      kind: 'variant1',
      env_overrides: {},
      eval_args: ['--forehead_hair_aware_clip', 'true'],
      note: 'forehead hair-aware clip',
    },
    {
      id: 'variant2_under_eye_relaxed_guard',
      kind: 'variant2',
      env_overrides: {
        DIAG_MODULE_MIN_PIXELS_UNDER_EYE: '1',
        DIAG_MODULE_GUARD_DILATION_MAX_ITER: '0',
      },
      eval_args: ['--under_eye_min_coverage', String(args.under_eye_min_coverage)],
      note: 'under-eye relax dilate/min-pixels guard + low-coverage fallback-empty',
    },
    ...variant3Groups,
  ];

  const repoRoot = REPO_ROOT;
  const results = [];
  for (const group of groups) {
    const result = await runEvalGroup({
      group,
      args,
      repoRoot,
      tempRoot,
    });
    result.score = groupScore(result.metrics);
    results.push(result);
  }

  const baseline = results.find((item) => item.group.id === 'baseline') || results[0];
  const recommended = [...results].sort((a, b) => Number(b.score || -Infinity) - Number(a.score || -Infinity))[0];
  const topRegressions = buildTopRegressions({
    baselineRows: baseline.rows,
    variantRows: recommended.rows,
    limit: 20,
  });

  const reportJsonPath = path.join(reportDir, `eval_gold_ab_${runId}.json`);
  const reportCsvPath = path.join(reportDir, `eval_gold_ab_${runId}.csv`);
  const reportMdPath = path.join(reportDir, `eval_gold_ab_${runId}.md`);

  const jsonPayload = {
    ok: true,
    run_id: runId,
    generated_at: new Date().toISOString(),
    gold_labels: toPosix(path.relative(process.cwd(), goldPath)),
    pred_jsonl: args.pred_jsonl ? toPosix(path.relative(process.cwd(), path.resolve(args.pred_jsonl))) : null,
    rerun_local: args.rerun_local,
    grid_size: args.grid_size,
    recommended_group: recommended.group.id,
    baseline_group: baseline.group.id,
    groups: results.map((item) => ({
      group_id: item.group.id,
      kind: item.group.kind,
      note: item.group.note,
      score: item.score,
      metrics: item.metrics,
      delta_vs_baseline: {
        skin_iou_mean: metricDelta(baseline.metrics.skin_iou_mean, item.metrics.skin_iou_mean),
        strong_module_miou_mean: metricDelta(baseline.metrics.strong_module_miou_mean, item.metrics.strong_module_miou_mean),
        under_eye_band_coverage_mean: metricDelta(baseline.metrics.under_eye_band_coverage_mean, item.metrics.under_eye_band_coverage_mean),
        under_eye_leakage_bg_mean: metricDelta(baseline.metrics.under_eye_leakage_bg_mean, item.metrics.under_eye_leakage_bg_mean),
        under_eye_leakage_hair_mean: metricDelta(baseline.metrics.under_eye_leakage_hair_mean, item.metrics.under_eye_leakage_hair_mean),
        forehead_hair_overlap_rate_mean: metricDelta(baseline.metrics.forehead_hair_overlap_rate_mean, item.metrics.forehead_hair_overlap_rate_mean),
      },
      eval_artifacts: {
        report_md: item.summary.report_md,
        report_csv: item.summary.report_csv,
        report_jsonl: item.summary.report_jsonl,
      },
    })),
    top_regression_samples: topRegressions,
  };
  await fsp.writeFile(reportJsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');

  const csvHeaders = [
    'group_id',
    'kind',
    'score',
    'skin_iou_mean',
    'strong_module_miou_mean',
    'under_eye_band_coverage_mean',
    'under_eye_leakage_bg_mean',
    'under_eye_leakage_hair_mean',
    'forehead_hair_overlap_rate_mean',
    'delta_strong_module_miou_mean',
    'delta_forehead_hair_overlap_rate_mean',
  ];
  const csvRows = [
    csvHeaders.join(','),
    ...results.map((item) => [
      item.group.id,
      item.group.kind,
      item.score ?? '',
      item.metrics.skin_iou_mean ?? '',
      item.metrics.strong_module_miou_mean ?? '',
      item.metrics.under_eye_band_coverage_mean ?? '',
      item.metrics.under_eye_leakage_bg_mean ?? '',
      item.metrics.under_eye_leakage_hair_mean ?? '',
      item.metrics.forehead_hair_overlap_rate_mean ?? '',
      metricDelta(baseline.metrics.strong_module_miou_mean, item.metrics.strong_module_miou_mean) ?? '',
      metricDelta(baseline.metrics.forehead_hair_overlap_rate_mean, item.metrics.forehead_hair_overlap_rate_mean) ?? '',
    ].map(csvEscape).join(',')),
  ];
  await fsp.writeFile(reportCsvPath, `${csvRows.join('\n')}\n`, 'utf8');

  const markdown = buildMarkdown({
    runId,
    args,
    groups: results,
    baseline,
    recommended,
    topRegressions,
    files: {
      json: toPosix(path.relative(process.cwd(), reportJsonPath)),
      csv: toPosix(path.relative(process.cwd(), reportCsvPath)),
      md: toPosix(path.relative(process.cwd(), reportMdPath)),
    },
  });
  await fsp.writeFile(reportMdPath, markdown, 'utf8');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      run_id: runId,
      recommended_group: recommended.group.id,
      report_md: toPosix(path.relative(process.cwd(), reportMdPath)),
      report_csv: toPosix(path.relative(process.cwd(), reportCsvPath)),
      report_json: toPosix(path.relative(process.cwd(), reportJsonPath)),
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`eval_gold_ab_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
