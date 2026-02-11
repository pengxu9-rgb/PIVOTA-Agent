#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_CIRCLE_MODEL_PATH = path.join('model_registry', 'circle_prior_latest.json');
const DEFAULT_LIMIT = 150;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_GRID_SIZE = 128;
const DEFAULT_MARKET = 'EU';
const DEFAULT_LANG = 'en';
const DEFAULT_SAMPLE_SEED = 'fasseg_matrix_seed_v1';
const DEFAULT_CIRCLE_MODEL_MIN_PIXELS = 24;
const DEFAULT_REGRESSION_DELTA = 0.02;

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

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function mean(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const valid = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  const total = valid.reduce((acc, value) => acc + value, 0);
  return total / valid.length;
}

function parseArgs(argv) {
  const out = {
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    limit: parseNumber(process.env.LIMIT, DEFAULT_LIMIT, 1, 200000),
    concurrency: parseNumber(process.env.EVAL_CONCURRENCY || process.env.CONCURRENCY, DEFAULT_CONCURRENCY, 1, 16),
    timeout_ms: parseNumber(process.env.EVAL_TIMEOUT_MS || process.env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120000),
    market: String(process.env.MARKET || DEFAULT_MARKET),
    lang: String(process.env.LANG || DEFAULT_LANG),
    grid_size: parseNumber(process.env.EVAL_GRID_SIZE || process.env.GT_GRID_SIZE, DEFAULT_GRID_SIZE, 64, 512),
    circle_model_path: String(process.env.EVAL_CIRCLE_MODEL_PATH || process.env.CIRCLE_MODEL_PATH || DEFAULT_CIRCLE_MODEL_PATH),
    circle_model_min_pixels: parseNumber(
      process.env.CIRCLE_MODEL_MIN_PIXELS,
      DEFAULT_CIRCLE_MODEL_MIN_PIXELS,
      1,
      4096,
    ),
    sample_seed: String(process.env.EVAL_SAMPLE_SEED || process.env.SAMPLE_SEED || DEFAULT_SAMPLE_SEED),
    emit_debug_overlays: parseBoolean(process.env.EVAL_EMIT_DEBUG || process.env.EMIT_DEBUG_OVERLAYS, false),
    token: String(process.env.EVAL_TOKEN || process.env.TOKEN || ''),
    base_url: String(process.env.EVAL_BASE_URL || process.env.BASE || ''),
    regression_delta_threshold: parseNumber(
      process.env.EVAL_MATRIX_REGRESSION_DELTA,
      DEFAULT_REGRESSION_DELTA,
      0,
      1,
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cache_dir' && next) {
      out.cache_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 1, 200000);
      i += 1;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = parseNumber(next, out.concurrency, 1, 16);
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
    if (token === '--regression_delta' && next) {
      out.regression_delta_threshold = parseNumber(next, out.regression_delta_threshold, 0, 1);
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
    if (token === '--emit_debug_overlays') {
      out.emit_debug_overlays = true;
      continue;
    }
  }

  out.limit = Math.max(1, Math.trunc(out.limit));
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.timeout_ms = Math.max(1000, Math.trunc(out.timeout_ms));
  out.grid_size = Math.max(64, Math.trunc(out.grid_size));
  out.circle_model_min_pixels = Math.max(1, Math.trunc(out.circle_model_min_pixels));
  out.sample_seed = String(out.sample_seed || DEFAULT_SAMPLE_SEED).trim() || DEFAULT_SAMPLE_SEED;
  out.base_url = String(out.base_url || '').trim();
  out.token = String(out.token || '').trim();
  out.regression_delta_threshold = Math.max(0, Number(out.regression_delta_threshold || DEFAULT_REGRESSION_DELTA));
  const modelToken = String(out.circle_model_path || '').trim();
  out.circle_model_path = ['none', 'off', 'false'].includes(modelToken.toLowerCase())
    ? DEFAULT_CIRCLE_MODEL_PATH
    : modelToken || DEFAULT_CIRCLE_MODEL_PATH;
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
  const lines = text
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
      row[headers[j]] = values[j] == null ? '' : values[j];
    }
    rows.push(row);
  }
  return rows;
}

function findEvalScript(repoRoot) {
  const scriptPath = path.join(repoRoot, 'scripts', 'eval_circle_accuracy.mjs');
  if (!fs.existsSync(scriptPath)) throw new Error(`eval_script_missing:${scriptPath}`);
  return scriptPath;
}

function runGroupEval({ args, repoRoot, evalScript, runDir, group }) {
  const cli = [
    evalScript,
    '--cache_dir',
    args.cache_dir,
    '--datasets',
    'fasseg',
    '--limit',
    String(args.limit),
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
    runDir,
    '--sample_seed',
    args.sample_seed,
    '--shuffle',
    '--circle_model_min_pixels',
    String(args.circle_model_min_pixels),
  ];

  if (group.circle_enabled) {
    cli.push('--circle_model_path', args.circle_model_path);
  } else {
    cli.push('--circle_model_path', 'off');
  }
  if (!group.calibration_enabled) {
    cli.push('--disable_circle_model_calibration');
  }
  if (args.base_url) {
    cli.push('--base_url', args.base_url);
  }
  if (args.token) {
    cli.push('--token', args.token);
  }
  if (args.emit_debug_overlays) {
    cli.push('--emit_debug_overlays');
  }

  const result = spawnSync(process.execPath, cli, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN: args.token || process.env.TOKEN || '',
      EVAL_TOKEN: args.token || process.env.EVAL_TOKEN || '',
    },
  });

  let payload = null;
  try {
    payload = parseLastJsonLine(result.stdout);
  } catch (_error) {
    payload = null;
  }
  if (result.status !== 0 && !payload) {
    throw new Error(
      `group_${group.id}_failed:${result.stderr || result.stdout || 'unknown_error'}`,
    );
  }
  if (!payload) {
    throw new Error(`group_${group.id}_missing_json_payload`);
  }
  payload.eval_exit_code = Number.isFinite(Number(result.status)) ? Number(result.status) : 0;
  payload.group = group.id;
  payload.group_label = group.label;
  payload.circle_enabled = group.circle_enabled;
  payload.calibration_enabled = group.calibration_enabled;
  return payload;
}

function moduleMetric(rows, moduleId, field) {
  const row = rows.find((item) => String(item.module_id || '') === String(moduleId));
  if (!row) return null;
  const value = Number(row[field]);
  return Number.isFinite(value) ? round3(value) : null;
}

function cheeksAggregate(rows, field) {
  const left = moduleMetric(rows, 'left_cheek', field);
  const right = moduleMetric(rows, 'right_cheek', field);
  const values = [left, right].filter((value) => Number.isFinite(Number(value)));
  return values.length ? round3(mean(values)) : null;
}

function computeRegressionDriverRows(groupMap) {
  const c0k0 = groupMap.c0_k0;
  const c0k1 = groupMap.c0_k1;
  const c1k0 = groupMap.c1_k0;
  const c1k1 = groupMap.c1_k1;
  return [
    {
      factor: 'circle',
      context: 'calibration=0',
      delta_leakage: round3(Number(c1k0.leakage_mean || 0) - Number(c0k0.leakage_mean || 0)),
    },
    {
      factor: 'circle',
      context: 'calibration=1',
      delta_leakage: round3(Number(c1k1.leakage_mean || 0) - Number(c0k1.leakage_mean || 0)),
    },
    {
      factor: 'calibration',
      context: 'circle=0',
      delta_leakage: round3(Number(c0k1.leakage_mean || 0) - Number(c0k0.leakage_mean || 0)),
    },
    {
      factor: 'calibration',
      context: 'circle=1',
      delta_leakage: round3(Number(c1k1.leakage_mean || 0) - Number(c1k0.leakage_mean || 0)),
    },
  ];
}

function renderMd({
  runKey,
  args,
  groups,
  groupMap,
  moduleTable,
  driverRows,
  regressionThreshold,
  mdPath,
}) {
  const lines = [];
  lines.push('# Eval Circle FASSEG Matrix (Circle × Calibration)');
  lines.push('');
  lines.push(`- run_id: ${runKey}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- datasets: fasseg`);
  lines.push(`- sample_seed: ${args.sample_seed}`);
  lines.push(`- limit: ${args.limit}`);
  lines.push(`- circle_model_path: ${args.circle_model_path}`);
  lines.push(`- regression_delta_threshold: ${round3(regressionThreshold)}`);
  lines.push('');

  lines.push('## Group Summary');
  lines.push('');
  lines.push('| group | circle_enabled | calibration_enabled | module_mIoU_mean | leakage_mean | samples_ok | samples_total |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const group of groups) {
    const row = groupMap[group.id];
    lines.push(
      `| ${group.id} | ${group.circle_enabled ? 1 : 0} | ${group.calibration_enabled ? 1 : 0} | ${round3(row.module_miou_mean)} | ${round3(row.leakage_mean)} | ${row.samples_ok} | ${row.samples_total} |`,
    );
  }
  lines.push('');

  lines.push('## Per-Module Compare (chin / forehead / cheeks)');
  lines.push('');
  lines.push('| module | metric | c0_k0 | c0_k1 | c1_k0 | c1_k1 |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const row of moduleTable) {
    lines.push(
      `| ${row.module} | ${row.metric} | ${row.c0_k0 ?? 'n/a'} | ${row.c0_k1 ?? 'n/a'} | ${row.c1_k0 ?? 'n/a'} | ${row.c1_k1 ?? 'n/a'} |`,
    );
  }
  lines.push('');

  lines.push('## Driver Analysis (Leakage Delta)');
  lines.push('');
  lines.push('| factor | context | leakage_delta | verdict |');
  lines.push('|---|---|---:|---|');
  for (const row of driverRows) {
    const isDriver = Number(row.delta_leakage || 0) > regressionThreshold;
    lines.push(
      `| ${row.factor} | ${row.context} | ${round3(row.delta_leakage)} | ${isDriver ? 'REGRESSION DRIVER' : 'ok'} |`,
    );
  }
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- matrix.md: \`${toPosix(path.relative(process.cwd(), mdPath))}\``);
  for (const group of groups) {
    const payload = groupMap[group.id];
    lines.push(`- ${group.id}.summary: \`${payload.artifacts && payload.artifacts.md ? payload.artifacts.md : ''}\``);
    lines.push(`- ${group.id}.csv: \`${payload.artifacts && payload.artifacts.csv ? payload.artifacts.csv : ''}\``);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const runKey = nowKey();
  const evalScript = findEvalScript(repoRoot);
  const matrixRunDir = path.join(reportDir, `.eval_circle_matrix_${runKey}`);
  await fsp.mkdir(matrixRunDir, { recursive: true });

  const groups = [
    { id: 'c0_k0', label: 'circle=0 calib=0', circle_enabled: false, calibration_enabled: false },
    { id: 'c0_k1', label: 'circle=0 calib=1', circle_enabled: false, calibration_enabled: true },
    { id: 'c1_k0', label: 'circle=1 calib=0', circle_enabled: true, calibration_enabled: false },
    { id: 'c1_k1', label: 'circle=1 calib=1', circle_enabled: true, calibration_enabled: true },
  ];

  const groupPayloads = {};
  let maxExitCode = 0;
  for (const group of groups) {
    const groupReportDir = path.join(matrixRunDir, group.id);
    await fsp.mkdir(groupReportDir, { recursive: true });
    const payload = runGroupEval({
      args,
      repoRoot,
      evalScript,
      runDir: groupReportDir,
      group,
    });
    groupPayloads[group.id] = payload;
    maxExitCode = Math.max(maxExitCode, Number(payload.eval_exit_code || 0));
  }

  const csvByGroup = {};
  for (const group of groups) {
    const payload = groupPayloads[group.id];
    if (!payload.artifacts || !payload.artifacts.csv) {
      throw new Error(`group_${group.id}_missing_csv_artifact`);
    }
    csvByGroup[group.id] = await readCsvRows(payload.artifacts.csv);
  }

  const moduleRows = ['chin', 'forehead', 'left_cheek', 'right_cheek'];
  const moduleTable = [];
  for (const moduleId of moduleRows) {
    moduleTable.push({
      module: moduleId,
      metric: 'mIoU',
      c0_k0: moduleMetric(csvByGroup.c0_k0, moduleId, 'miou_mean'),
      c0_k1: moduleMetric(csvByGroup.c0_k1, moduleId, 'miou_mean'),
      c1_k0: moduleMetric(csvByGroup.c1_k0, moduleId, 'miou_mean'),
      c1_k1: moduleMetric(csvByGroup.c1_k1, moduleId, 'miou_mean'),
    });
    moduleTable.push({
      module: moduleId,
      metric: 'leakage',
      c0_k0: moduleMetric(csvByGroup.c0_k0, moduleId, 'leakage_mean'),
      c0_k1: moduleMetric(csvByGroup.c0_k1, moduleId, 'leakage_mean'),
      c1_k0: moduleMetric(csvByGroup.c1_k0, moduleId, 'leakage_mean'),
      c1_k1: moduleMetric(csvByGroup.c1_k1, moduleId, 'leakage_mean'),
    });
  }

  moduleTable.push({
    module: 'cheeks_avg',
    metric: 'mIoU',
    c0_k0: cheeksAggregate(csvByGroup.c0_k0, 'miou_mean'),
    c0_k1: cheeksAggregate(csvByGroup.c0_k1, 'miou_mean'),
    c1_k0: cheeksAggregate(csvByGroup.c1_k0, 'miou_mean'),
    c1_k1: cheeksAggregate(csvByGroup.c1_k1, 'miou_mean'),
  });
  moduleTable.push({
    module: 'cheeks_avg',
    metric: 'leakage',
    c0_k0: cheeksAggregate(csvByGroup.c0_k0, 'leakage_mean'),
    c0_k1: cheeksAggregate(csvByGroup.c0_k1, 'leakage_mean'),
    c1_k0: cheeksAggregate(csvByGroup.c1_k0, 'leakage_mean'),
    c1_k1: cheeksAggregate(csvByGroup.c1_k1, 'leakage_mean'),
  });

  const groupMap = {};
  for (const group of groups) {
    const payload = groupPayloads[group.id];
    groupMap[group.id] = {
      ...payload,
      module_miou_mean: Number(payload.module_miou_mean || 0),
      leakage_mean: Number(payload.leakage_mean || 0),
      samples_ok: Number(payload.samples_ok || 0),
      samples_total: Number(payload.samples_total || 0),
    };
  }

  const driverRows = computeRegressionDriverRows(groupMap);
  const mdPath = path.join(reportDir, `eval_circle_matrix_${runKey}.md`);
  const mdText = renderMd({
    runKey,
    args,
    groups,
    groupMap,
    moduleTable,
    driverRows,
    regressionThreshold: args.regression_delta_threshold,
    mdPath,
  });
  await fsp.writeFile(mdPath, mdText, 'utf8');

  const payload = {
    ok: true,
    run_id: runKey,
    sample_seed: args.sample_seed,
    groups: groups.map((group) => ({
      id: group.id,
      circle_enabled: group.circle_enabled,
      calibration_enabled: group.calibration_enabled,
      module_miou_mean: round3(groupMap[group.id].module_miou_mean),
      leakage_mean: round3(groupMap[group.id].leakage_mean),
      samples_ok: groupMap[group.id].samples_ok,
      samples_total: groupMap[group.id].samples_total,
    })),
    driver_rows: driverRows,
    artifacts: {
      md: toPosix(path.relative(repoRoot, mdPath)),
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (maxExitCode > 0) process.exitCode = maxExitCode;
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});

