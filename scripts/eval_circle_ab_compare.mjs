#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function nowKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}${ss}`;
}

function toPosix(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
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

function mean(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
  return sum / values.length;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseArgs(argv) {
  const out = {
    onnx: process.env.ONNX || process.env.DIAG_SKINMASK_MODEL_PATH || path.join('artifacts', 'skinmask_v1.onnx'),
    cache_dir: process.env.CACHE_DIR || path.join('datasets_cache', 'external'),
    datasets: process.env.DATASETS || 'fasseg,lapa,celebamaskhq',
    limit: parseNumber(process.env.LIMIT, 0, 0, 200000),
    shuffle: parseBoolean(process.env.EVAL_SHUFFLE || process.env.SHUFFLE, false),
    concurrency: parseNumber(process.env.EVAL_CONCURRENCY || process.env.CONCURRENCY, 4, 1, 32),
    timeout_ms: parseNumber(process.env.EVAL_TIMEOUT_MS || process.env.TIMEOUT_MS, 30000, 1000, 120000),
    market: String(process.env.MARKET || 'EU'),
    lang: String(process.env.LANG || 'en'),
    grid_size: parseNumber(process.env.EVAL_GRID_SIZE || process.env.GT_GRID_SIZE, 128, 64, 512),
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports',
    base_url: process.env.EVAL_BASE_URL || process.env.BASE || '',
    token: process.env.EVAL_TOKEN || process.env.TOKEN || '',
    emit_debug_overlays: parseBoolean(process.env.EVAL_EMIT_DEBUG || process.env.EMIT_DEBUG_OVERLAYS, false),
    circle_model_path: process.env.EVAL_CIRCLE_MODEL_PATH || process.env.CIRCLE_MODEL_PATH || '',
    circle_model_calibration: parseBoolean(process.env.CIRCLE_MODEL_CALIBRATION, true),
    circle_model_min_pixels: parseNumber(process.env.CIRCLE_MODEL_MIN_PIXELS, 24, 1, 4096),
    sample_seed: String(process.env.EVAL_SAMPLE_SEED || process.env.SAMPLE_SEED || 'skinmask_ab_seed_v1'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--onnx' && next) {
      out.onnx = String(next);
      i += 1;
      continue;
    }
    if (token === '--cache_dir' && next) {
      out.cache_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--datasets' && next) {
      out.datasets = String(next);
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 0, 200000);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = parseNumber(next, out.concurrency, 1, 32);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeout_ms = parseNumber(next, out.timeout_ms, 1000, 120000);
      i += 1;
      continue;
    }
    if (token === '--market' && next) {
      out.market = String(next);
      i += 1;
      continue;
    }
    if (token === '--lang' && next) {
      out.lang = String(next);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = parseNumber(next, out.grid_size, 64, 512);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--base_url' && next) {
      out.base_url = String(next);
      i += 1;
      continue;
    }
    if (token === '--token' && next) {
      out.token = String(next);
      i += 1;
      continue;
    }
    if (token === '--circle_model_path' && next) {
      out.circle_model_path = String(next);
      i += 1;
      continue;
    }
    if (token === '--circle_model_min_pixels' && next) {
      out.circle_model_min_pixels = parseNumber(next, out.circle_model_min_pixels, 1, 4096);
      i += 1;
      continue;
    }
    if (token === '--sample_seed' && next) {
      out.sample_seed = String(next);
      i += 1;
      continue;
    }
    if (token === '--disable_circle_model_calibration') {
      out.circle_model_calibration = false;
      continue;
    }
    if (token === '--emit_debug_overlays') {
      out.emit_debug_overlays = true;
      continue;
    }
  }

  out.limit = Math.max(0, Math.trunc(out.limit));
  out.grid_size = Math.max(64, Math.trunc(out.grid_size));
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.timeout_ms = Math.max(1000, Math.trunc(out.timeout_ms));
  out.circle_model_min_pixels = Math.max(1, Math.trunc(out.circle_model_min_pixels));
  out.onnx = String(out.onnx || '').trim();
  out.base_url = String(out.base_url || '').trim();
  out.token = String(out.token || '').trim();
  out.circle_model_path = String(out.circle_model_path || '').trim();
  out.sample_seed = String(out.sample_seed || '').trim();
  return out;
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch (_error) {
      // continue
    }
  }
  throw new Error('missing_json_output');
}

function runEval({ args, skinmaskEnabled, repoRoot, reportDir, sampleSeed }) {
  const targetReportDir = reportDir || args.report_dir;
  const cli = [
    path.join('scripts', 'eval_circle_accuracy.mjs'),
    '--cache_dir',
    args.cache_dir,
    '--datasets',
    args.datasets,
    '--concurrency',
    String(args.concurrency),
    '--timeout_ms',
    String(args.timeout_ms),
    '--market',
    args.market,
    '--lang',
    args.lang,
    '--grid_size',
    String(args.grid_size),
    '--report_dir',
    targetReportDir,
    '--circle_model_min_pixels',
    String(args.circle_model_min_pixels),
    '--sample_seed',
    String(sampleSeed || args.sample_seed || 'skinmask_ab_seed_v1'),
  ];

  if (args.circle_model_path) {
    cli.push('--circle_model_path', args.circle_model_path);
  }
  if (args.limit > 0) cli.push('--limit', String(args.limit));
  cli.push('--shuffle');
  if (args.base_url) cli.push('--base_url', args.base_url);
  if (args.token) cli.push('--token', args.token);
  if (args.emit_debug_overlays) cli.push('--emit_debug_overlays');
  if (!args.circle_model_calibration) cli.push('--disable_circle_model_calibration');

  if (skinmaskEnabled) {
    cli.push('--skinmask_enabled', '--skinmask_model_path', args.onnx);
  } else {
    cli.push('--disable_skinmask');
  }

  const run = spawnSync(process.execPath, cli, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DIAG_SKINMASK_ENABLED: skinmaskEnabled ? 'true' : 'false',
      DIAG_SKINMASK_MODEL_PATH: args.onnx,
      TOKEN: args.token || process.env.TOKEN || '',
      EVAL_TOKEN: args.token || process.env.EVAL_TOKEN || '',
    },
  });

  let parsed = null;
  try {
    parsed = parseLastJsonLine(run.stdout);
  } catch (_error) {
    parsed = null;
  }
  if (run.status !== 0 && !parsed) {
    throw new Error(
      `eval_circle_failed(${skinmaskEnabled ? 'skinmask_on' : 'skinmask_off'}): ${run.stderr || run.stdout || 'unknown_error'}`,
    );
  }
  if (!parsed) {
    throw new Error(`eval_circle_missing_json(${skinmaskEnabled ? 'skinmask_on' : 'skinmask_off'})`);
  }
  parsed.eval_exit_code = Number.isFinite(Number(run.status)) ? Number(run.status) : 0;
  if (run.stderr && String(run.stderr).trim()) {
    parsed.eval_stderr = String(run.stderr).trim();
  }
  return parsed;
}

async function readJsonlRows(filePath) {
  const text = await fsp.readFile(path.resolve(filePath), 'utf8');
  const rows = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (_error) {
      // skip invalid lines
    }
  }
  return rows;
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

async function readCsvRows(filePath) {
  const text = await fsp.readFile(path.resolve(filePath), 'utf8');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = values[j] == null ? '' : values[j];
    }
    rows.push(row);
  }
  return rows;
}

function moduleStatsFromSample(row) {
  if (!row || !row.ok || row.weak_label_only) return null;
  const moduleScores = Array.isArray(row.module_scores) ? row.module_scores : [];
  if (!moduleScores.length) return null;
  const iouValues = moduleScores
    .map((item) => Number(item && item.iou))
    .filter((value) => Number.isFinite(value));
  const coverageValues = moduleScores
    .map((item) => Number(item && item.coverage))
    .filter((value) => Number.isFinite(value));
  const leakageValues = moduleScores
    .map((item) => Number(item && item.leakage))
    .filter((value) => Number.isFinite(value));

  const tooSmallRate = Number.isFinite(Number(row.skin_roi_too_small_rate))
    ? Number(row.skin_roi_too_small_rate)
    : moduleScores.length
      ? moduleScores.filter((item) => item && item.roi_too_small).length / moduleScores.length
      : 0;

  return {
    module_miou_mean: round3(mean(iouValues)),
    coverage_mean: round3(mean(coverageValues)),
    leakage_mean: round3(mean(leakageValues)),
    roi_too_small_rate: round3(tooSmallRate),
    face_detect_fail: row.face_detect_ok === false ? 1 : 0,
    face_detect_ok: row.face_detect_ok !== false,
    modules_evaluated: moduleScores.length,
    regions_count: Number.isFinite(Number(row.regions_count)) ? Number(row.regions_count) : null,
    invalid_region_count: Number.isFinite(Number(row.invalid_region_count)) ? Number(row.invalid_region_count) : null,
  };
}

function metricDelta(offValue, onValue) {
  if (!Number.isFinite(Number(offValue)) || !Number.isFinite(Number(onValue))) return null;
  return round3(Number(onValue) - Number(offValue));
}

function pickFailReason(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.fail_reason != null && String(row.fail_reason).trim()) return String(row.fail_reason);
  if (row.reason != null && String(row.reason).trim()) return String(row.reason);
  return null;
}

function numberOrZero(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n;
}

function joinSampleRows({ offRows, onRows }) {
  const offMap = new Map();
  const onMap = new Map();

  for (const row of offRows) {
    const dataset = String((row && row.dataset) || 'unknown');
    const sampleHash = String((row && row.sample_hash) || '');
    const key = `${dataset}::${sampleHash}`;
    offMap.set(key, row);
  }
  for (const row of onRows) {
    const dataset = String((row && row.dataset) || 'unknown');
    const sampleHash = String((row && row.sample_hash) || '');
    const key = `${dataset}::${sampleHash}`;
    onMap.set(key, row);
  }

  const keys = Array.from(new Set([...offMap.keys(), ...onMap.keys()]));
  keys.sort((a, b) => a.localeCompare(b));

  const joined = [];
  for (const key of keys) {
    const off = offMap.get(key) || null;
    const on = onMap.get(key) || null;
    const [dataset, sampleHash] = key.split('::');

    const offMetrics = moduleStatsFromSample(off);
    const onMetrics = moduleStatsFromSample(on);
    const offGtStats = off && off.gt_stats && typeof off.gt_stats === 'object' ? off.gt_stats : {};
    const onGtStats = on && on.gt_stats && typeof on.gt_stats === 'object' ? on.gt_stats : {};
    const offPredStats = off && off.pred_stats && typeof off.pred_stats === 'object' ? off.pred_stats : {};
    const onPredStats = on && on.pred_stats && typeof on.pred_stats === 'object' ? on.pred_stats : {};
    const offFailReason = pickFailReason(off);
    const onFailReason = pickFailReason(on);

    joined.push({
      dataset,
      sample_hash: sampleHash,
      status_off: off && off.ok ? 'ok' : 'failed',
      status_on: on && on.ok ? 'ok' : 'failed',
      weak_label_only_off: Boolean(off && off.weak_label_only),
      weak_label_only_on: Boolean(on && on.weak_label_only),
      fail_reason_off: offFailReason,
      fail_reason_on: onFailReason,
      skinmask_reason_off: off && off.skinmask_reason ? String(off.skinmask_reason) : null,
      skinmask_reason_on: on && on.skinmask_reason ? String(on.skinmask_reason) : null,
      gt_skin_pixels_off: numberOrZero(offGtStats.skin_pixels),
      gt_skin_pixels_on: numberOrZero(onGtStats.skin_pixels),
      pred_module_count_off: numberOrZero(offPredStats.module_count),
      pred_module_count_on: numberOrZero(onPredStats.module_count),
      pred_skin_pixels_est_off: numberOrZero(offPredStats.pred_skin_pixels_est),
      pred_skin_pixels_est_on: numberOrZero(onPredStats.pred_skin_pixels_est),
      off: offMetrics,
      on: onMetrics,
      delta: {
        module_miou_mean: metricDelta(offMetrics && offMetrics.module_miou_mean, onMetrics && onMetrics.module_miou_mean),
        coverage_mean: metricDelta(offMetrics && offMetrics.coverage_mean, onMetrics && onMetrics.coverage_mean),
        leakage_mean: metricDelta(offMetrics && offMetrics.leakage_mean, onMetrics && onMetrics.leakage_mean),
        roi_too_small_rate: metricDelta(offMetrics && offMetrics.roi_too_small_rate, onMetrics && onMetrics.roi_too_small_rate),
        face_detect_fail: metricDelta(offMetrics && offMetrics.face_detect_fail, onMetrics && onMetrics.face_detect_fail),
      },
    });
  }

  return joined;
}

function regressionTopRows(joinedRows, limit = 50) {
  const regressions = [];
  for (const row of joinedRows) {
    if (!row || !row.off || !row.on) continue;
    const leakageUp = Number.isFinite(Number(row.delta && row.delta.leakage_mean)) && row.delta.leakage_mean > 0
      ? Number(row.delta.leakage_mean)
      : 0;
    const miouDown = Number.isFinite(Number(row.delta && row.delta.module_miou_mean)) && row.delta.module_miou_mean < 0
      ? Math.abs(Number(row.delta.module_miou_mean))
      : 0;
    if (leakageUp <= 0 && miouDown <= 0) continue;
    regressions.push({
      dataset: row.dataset,
      sample_hash: row.sample_hash,
      leakage_delta: round3(leakageUp),
      miou_delta: row.delta.module_miou_mean,
      roi_delta: row.delta.roi_too_small_rate,
      off_leakage: row.off.leakage_mean,
      on_leakage: row.on.leakage_mean,
      off_miou: row.off.module_miou_mean,
      on_miou: row.on.module_miou_mean,
      fail_reason_off: row.fail_reason_off || null,
      fail_reason_on: row.fail_reason_on || null,
      gt_skin_pixels_off: numberOrZero(row.gt_skin_pixels_off),
      gt_skin_pixels_on: numberOrZero(row.gt_skin_pixels_on),
      pred_module_count_off: numberOrZero(row.pred_module_count_off),
      pred_module_count_on: numberOrZero(row.pred_module_count_on),
      pred_skin_pixels_est_off: numberOrZero(row.pred_skin_pixels_est_off),
      pred_skin_pixels_est_on: numberOrZero(row.pred_skin_pixels_est_on),
      score: round3(leakageUp + miouDown),
    });
  }

  regressions.sort((a, b) => {
    if (b.leakage_delta !== a.leakage_delta) return b.leakage_delta - a.leakage_delta;
    const aMiouDown = Number.isFinite(Number(a.miou_delta)) ? Math.max(0, -Number(a.miou_delta)) : 0;
    const bMiouDown = Number.isFinite(Number(b.miou_delta)) ? Math.max(0, -Number(b.miou_delta)) : 0;
    if (bMiouDown !== aMiouDown) return bMiouDown - aMiouDown;
    return a.sample_hash.localeCompare(b.sample_hash);
  });

  return regressions.slice(0, Math.max(0, Math.min(limit, regressions.length)));
}

function failReasonRate(rows, reasonToken) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  if (!total) return 0;
  const count = list.reduce((acc, row) => {
    const token = pickFailReason(row);
    return acc + (token === reasonToken ? 1 : 0);
  }, 0);
  return round3(count / total);
}

function compareModuleCsv(offRows, onRows) {
  const keyOf = (row) => `${String(row.dataset || '')}::${String(row.module_id || '')}`;
  const offMap = new Map(offRows.map((row) => [keyOf(row), row]));
  const onMap = new Map(onRows.map((row) => [keyOf(row), row]));
  const keys = Array.from(new Set([...offMap.keys(), ...onMap.keys()])).sort((a, b) => a.localeCompare(b));

  const metricFields = [
    'miou_mean',
    'miou_p50',
    'miou_p90',
    'coverage_mean',
    'leakage_mean',
    'roi_too_small_rate',
  ];

  const rows = [];
  for (const key of keys) {
    const off = offMap.get(key) || {};
    const on = onMap.get(key) || {};
    const [dataset, moduleId] = key.split('::');
    const output = {
      dataset,
      module_id: moduleId,
      samples_off: Number.isFinite(Number(off.samples)) ? Number(off.samples) : 0,
      samples_on: Number.isFinite(Number(on.samples)) ? Number(on.samples) : 0,
    };

    for (const field of metricFields) {
      const offValue = Number(off[field]);
      const onValue = Number(on[field]);
      output[`${field}_off`] = Number.isFinite(offValue) ? round3(offValue) : null;
      output[`${field}_on`] = Number.isFinite(onValue) ? round3(onValue) : null;
      output[`${field}_delta`] = metricDelta(offValue, onValue);
    }

    rows.push(output);
  }

  return rows;
}

function makeModuleCsv(rows) {
  const headers = [
    'dataset',
    'module_id',
    'samples_off',
    'samples_on',
    'miou_mean_off',
    'miou_mean_on',
    'miou_mean_delta',
    'miou_p50_off',
    'miou_p50_on',
    'miou_p50_delta',
    'miou_p90_off',
    'miou_p90_on',
    'miou_p90_delta',
    'coverage_mean_off',
    'coverage_mean_on',
    'coverage_mean_delta',
    'leakage_mean_off',
    'leakage_mean_on',
    'leakage_mean_delta',
    'roi_too_small_rate_off',
    'roi_too_small_rate_on',
    'roi_too_small_rate_delta',
  ];

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((field) => csvEscape(row[field])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function writeJsonl(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function overallMetricTable(basePayload, onPayload, offRows, onRows) {
  const metrics = [
    { label: 'module_mIoU_mean', field: 'module_miou_mean' },
    { label: 'leakage_mean', field: 'leakage_mean' },
    { label: 'PRED_MODULES_MISSING_rate', custom: true },
  ];

  return metrics.map(({ label, field, custom }) => {
    if (custom) {
      const offValue = failReasonRate(offRows, 'PRED_MODULES_MISSING');
      const onValue = failReasonRate(onRows, 'PRED_MODULES_MISSING');
      return {
        metric: label,
        off: offValue,
        on: onValue,
        delta: metricDelta(offValue, onValue),
      };
    }
    const offValue = Number(basePayload && basePayload[field]);
    const onValue = Number(onPayload && onPayload[field]);
    return {
      metric: label,
      off: Number.isFinite(offValue) ? round3(offValue) : null,
      on: Number.isFinite(onValue) ? round3(onValue) : null,
      delta: metricDelta(offValue, onValue),
    };
  });
}

function renderMd({
  runKey,
  args,
  offPayload,
  onPayload,
  overallRows,
  topRows,
  mdPath,
  csvPath,
  jsonlPath,
  showTopRegressions,
  warnings,
  moduleCompareRows,
}) {
  const lines = [];
  lines.push('# Eval Circle Skinmask AB Compare');
  lines.push('');
  lines.push(`- run_id: ${runKey}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- mode: ${args.base_url ? 'api' : 'local'}`);
  lines.push(`- datasets: ${args.datasets}`);
  lines.push(`- onnx: ${args.onnx}`);
  lines.push(`- sample_seed: ${args.sample_seed}`);
  lines.push(`- limit: ${args.limit || 'all'}`);
  lines.push('');

  if (warnings.length) {
    lines.push('## Warnings');
    lines.push('');
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  lines.push('## Overall Delta (on - off)');
  lines.push('');
  lines.push('| metric | skinmask_off | skinmask_on | delta |');
  lines.push('|---|---:|---:|---:|');
  for (const row of overallRows) {
    lines.push(`| ${row.metric} | ${row.off ?? 'n/a'} | ${row.on ?? 'n/a'} | ${row.delta ?? 'n/a'} |`);
  }
  lines.push('');

  lines.push('## Per-Module Delta');
  lines.push('');
  lines.push('| dataset | module | mIoU_off | mIoU_on | mIoU_delta | leakage_off | leakage_on | leakage_delta | coverage_off | coverage_on | coverage_delta |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  if (Array.isArray(moduleCompareRows) && moduleCompareRows.length) {
    for (const row of moduleCompareRows) {
      lines.push(
        `| ${row.dataset} | ${row.module_id} | ${row.miou_mean_off ?? 'n/a'} | ${row.miou_mean_on ?? 'n/a'} | ${row.miou_mean_delta ?? 'n/a'} | ${row.leakage_mean_off ?? 'n/a'} | ${row.leakage_mean_on ?? 'n/a'} | ${row.leakage_mean_delta ?? 'n/a'} | ${row.coverage_mean_off ?? 'n/a'} | ${row.coverage_mean_on ?? 'n/a'} | ${row.coverage_mean_delta ?? 'n/a'} |`,
      );
    }
  } else {
    lines.push('| - | - | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |');
  }
  lines.push('');

  if (showTopRegressions) {
    lines.push('## Top 20 Regression Samples');
    lines.push('');
    lines.push('| rank | dataset | sample_hash | fail_reason_off | fail_reason_on | gt_skin_pixels_off | gt_skin_pixels_on | pred_module_count_off | pred_module_count_on | pred_skin_pixels_est_off | pred_skin_pixels_est_on | leakage_delta | miou_delta |');
    lines.push('|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    if (topRows.length) {
      topRows.forEach((row, index) => {
        lines.push(
          `| ${index + 1} | ${row.dataset} | ${row.sample_hash} | ${row.fail_reason_off || '-'} | ${row.fail_reason_on || '-'} | ${row.gt_skin_pixels_off} | ${row.gt_skin_pixels_on} | ${row.pred_module_count_off} | ${row.pred_module_count_on} | ${row.pred_skin_pixels_est_off} | ${row.pred_skin_pixels_est_on} | ${row.leakage_delta} | ${row.miou_delta} |`,
        );
      });
    } else {
      lines.push('| 1 | n/a | n/a | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
    }
    lines.push('');
  } else {
    lines.push('## Top 20 Regression Samples');
    lines.push('');
    lines.push('- Skipped (enabled only when `skinmask_on.leakage_mean > 0.3`).');
    lines.push('');
  }

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- ab.md: \`${toPosix(path.relative(process.cwd(), mdPath))}\``);
  lines.push(`- ab.csv: \`${toPosix(path.relative(process.cwd(), csvPath))}\``);
  lines.push(`- ab.jsonl: \`${toPosix(path.relative(process.cwd(), jsonlPath))}\``);
  lines.push(`- off.md: \`${offPayload.artifacts && offPayload.artifacts.md ? offPayload.artifacts.md : ''}\``);
  lines.push(`- on.md: \`${onPayload.artifacts && onPayload.artifacts.md ? onPayload.artifacts.md : ''}\``);
  lines.push(`- off.jsonl: \`${offPayload.artifacts && offPayload.artifacts.jsonl ? offPayload.artifacts.jsonl : ''}\``);
  lines.push(`- on.jsonl: \`${onPayload.artifacts && onPayload.artifacts.jsonl ? onPayload.artifacts.jsonl : ''}\``);
  if (args.emit_debug_overlays) {
    lines.push('');
    lines.push('> DO NOT DISTRIBUTE debug overlays under `outputs/datasets_debug/`');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const reportDir = path.resolve(args.report_dir || 'reports');
  await fsp.mkdir(reportDir, { recursive: true });
  const runKey = nowKey();
  const evalWorkDir = path.join(reportDir, `.eval_circle_skinmask_ab_${runKey}`);
  const offReportDir = path.join(evalWorkDir, 'off');
  const onReportDir = path.join(evalWorkDir, 'on');
  await Promise.all([fsp.mkdir(offReportDir, { recursive: true }), fsp.mkdir(onReportDir, { recursive: true })]);

  if (!args.onnx) throw new Error('onnx_path_missing');
  if (!fs.existsSync(path.resolve(args.onnx))) {
    throw new Error(`onnx_not_found:${args.onnx}; set DIAG_SKINMASK_MODEL_PATH or ONNX to a valid .onnx path`);
  }
  const sampleSeed = args.sample_seed || `skinmask_ab_${runKey}`;

  const offPayload = runEval({ args: { ...args, sample_seed: sampleSeed }, skinmaskEnabled: false, repoRoot, reportDir: offReportDir, sampleSeed });
  const onPayload = runEval({ args: { ...args, sample_seed: sampleSeed }, skinmaskEnabled: true, repoRoot, reportDir: onReportDir, sampleSeed });

  const offJsonl = offPayload && offPayload.artifacts ? offPayload.artifacts.jsonl : '';
  const onJsonl = onPayload && onPayload.artifacts ? onPayload.artifacts.jsonl : '';
  const offCsv = offPayload && offPayload.artifacts ? offPayload.artifacts.csv : '';
  const onCsv = onPayload && onPayload.artifacts ? onPayload.artifacts.csv : '';

  if (!offJsonl || !onJsonl || !offCsv || !onCsv) {
    throw new Error('missing_eval_artifacts');
  }

  const [offRows, onRows, offCsvRows, onCsvRows] = await Promise.all([
    readJsonlRows(offJsonl),
    readJsonlRows(onJsonl),
    readCsvRows(offCsv),
    readCsvRows(onCsv),
  ]);

  const joinedRows = joinSampleRows({ offRows, onRows });
  const moduleCompareRows = compareModuleCsv(offCsvRows, onCsvRows);
  const showTopRegressions = Number(onPayload && onPayload.leakage_mean) > 0.3;
  const topRows = regressionTopRows(joinedRows, showTopRegressions ? 20 : 0);
  const overallRows = overallMetricTable(offPayload, onPayload, offRows, onRows);

  const mdPath = path.join(reportDir, `eval_circle_skinmask_ab_${runKey}.md`);
  const csvPath = path.join(reportDir, `eval_circle_skinmask_ab_${runKey}.csv`);
  const jsonlPath = path.join(reportDir, `eval_circle_skinmask_ab_${runKey}.jsonl`);
  const warnings = [];
  if (Number(onPayload.eval_exit_code || 0) !== 0) {
    warnings.push(`skinmask_on eval exited non-zero: ${Number(onPayload.eval_exit_code || 0)}`);
  }
  if (Array.isArray(onPayload.hard_warnings) && onPayload.hard_warnings.length) {
    for (const warning of onPayload.hard_warnings) warnings.push(String(warning));
  }
  if (Number(onPayload && onPayload.leakage_mean) > Number(offPayload && offPayload.leakage_mean)) {
    warnings.push('skinmask_on leakage_mean is higher than skinmask_off');
  }

  const md = renderMd({
    runKey,
    args: { ...args, sample_seed: sampleSeed },
    offPayload,
    onPayload,
    overallRows,
    topRows,
    mdPath,
    csvPath,
    jsonlPath,
    showTopRegressions,
    warnings,
    moduleCompareRows,
  });

  await fsp.writeFile(mdPath, md, 'utf8');
  await fsp.writeFile(csvPath, makeModuleCsv(moduleCompareRows), 'utf8');
  writeJsonl(jsonlPath, joinedRows);

  const payload = {
    ok: true,
    run_id: runKey,
    sample_seed: sampleSeed,
    metrics: overallRows,
    regressions: topRows.length,
    warnings,
    artifacts: {
      md: toPosix(path.relative(repoRoot, mdPath)),
      csv: toPosix(path.relative(repoRoot, csvPath)),
      jsonl: toPosix(path.relative(repoRoot, jsonlPath)),
    },
    off: offPayload,
    on: onPayload,
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
  const nonZero = Math.max(Number(offPayload.eval_exit_code || 0), Number(onPayload.eval_exit_code || 0));
  if (nonZero > 0) process.exitCode = nonZero;
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
