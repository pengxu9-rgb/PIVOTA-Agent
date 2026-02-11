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
const DEFAULT_BASELINE_GROUP = 'c1_k1';

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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

async function readJsonlRows(filePath) {
  const text = await fsp.readFile(path.resolve(filePath), 'utf8');
  return String(text)
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

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  if (!/[,"\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

async function writeCsvRows(filePath, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  await fsp.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeJsonlRows(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row));
  await fsp.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
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
  const value = safeNumber(row[field], NaN);
  return Number.isFinite(value) ? round3(value) : null;
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
      delta_leakage: round3(safeNumber(c1k0.leakage_mean) - safeNumber(c0k0.leakage_mean)),
    },
    {
      factor: 'circle',
      context: 'calibration=1',
      delta_leakage: round3(safeNumber(c1k1.leakage_mean) - safeNumber(c0k1.leakage_mean)),
    },
    {
      factor: 'calibration',
      context: 'circle=0',
      delta_leakage: round3(safeNumber(c0k1.leakage_mean) - safeNumber(c0k0.leakage_mean)),
    },
    {
      factor: 'calibration',
      context: 'circle=1',
      delta_leakage: round3(safeNumber(c1k1.leakage_mean) - safeNumber(c1k0.leakage_mean)),
    },
  ];
}

function computeCoverageMean(jsonlRows, csvRows) {
  const valuesFromJsonl = (Array.isArray(jsonlRows) ? jsonlRows : [])
    .map((row) => safeNumber(row && row.metric_stats ? row.metric_stats.coverage_mean : NaN, NaN))
    .filter((value) => Number.isFinite(value));
  if (valuesFromJsonl.length) return round3(mean(valuesFromJsonl));
  const valuesFromCsv = (Array.isArray(csvRows) ? csvRows : [])
    .map((row) => safeNumber(row.coverage_mean, NaN))
    .filter((value) => Number.isFinite(value));
  if (valuesFromCsv.length) return round3(mean(valuesFromCsv));
  return 0;
}

function extractSampleHashes(jsonlRows) {
  const values = new Set();
  for (const row of jsonlRows || []) {
    const sampleHash = String(row && row.sample_hash ? row.sample_hash : '').trim();
    if (sampleHash) values.add(sampleHash);
  }
  return Array.from(values).sort();
}

function computeSampleSetConsistency(groups, jsonlByGroup) {
  const baselineHashes = extractSampleHashes(jsonlByGroup[groups[0].id] || []);
  const baselineKey = baselineHashes.join(',');
  for (const group of groups.slice(1)) {
    const hashes = extractSampleHashes(jsonlByGroup[group.id] || []);
    if (hashes.join(',') !== baselineKey) {
      return false;
    }
  }
  return true;
}

function buildModuleTable(csvByGroup, groupIds) {
  const trackedModules = [
    { module: 'chin', type: 'single', left: 'chin', right: 'chin' },
    { module: 'forehead', type: 'single', left: 'forehead', right: 'forehead' },
    { module: 'cheeks', type: 'avg', left: 'left_cheek', right: 'right_cheek' },
  ];
  const trackedMetrics = [
    { key: 'miou_mean', label: 'mIoU', higher_is_better: true },
    { key: 'leakage_mean', label: 'leakage', higher_is_better: false },
    { key: 'coverage_mean', label: 'coverage', higher_is_better: true },
  ];
  const rows = [];
  for (const moduleEntry of trackedModules) {
    for (const metricEntry of trackedMetrics) {
      const row = {
        module: moduleEntry.module,
        metric: metricEntry.label,
        metric_key: metricEntry.key,
        higher_is_better: metricEntry.higher_is_better,
      };
      for (const groupId of groupIds) {
        const csvRows = csvByGroup[groupId] || [];
        const value = moduleEntry.type === 'avg'
          ? round3(mean([
            moduleMetric(csvRows, moduleEntry.left, metricEntry.key),
            moduleMetric(csvRows, moduleEntry.right, metricEntry.key),
          ].filter((x) => Number.isFinite(Number(x)))))
          : moduleMetric(csvRows, moduleEntry.left, metricEntry.key);
        row[groupId] = Number.isFinite(Number(value)) ? round3(value) : null;
      }
      rows.push(row);
    }
  }
  return rows;
}

function markBestGroup(moduleRow, groupIds) {
  const entries = groupIds
    .map((groupId) => ({ group_id: groupId, value: safeNumber(moduleRow[groupId], NaN) }))
    .filter((item) => Number.isFinite(item.value));
  if (!entries.length) return null;
  const comparator = moduleRow.higher_is_better
    ? (a, b) => b.value - a.value
    : (a, b) => a.value - b.value;
  entries.sort(comparator);
  return entries[0].group_id;
}

function computeDeltasForGroup(groupMap, baselineGroupId) {
  const baseline = groupMap[baselineGroupId] || {};
  const baselineLeakage = safeNumber(baseline.leakage_mean);
  const baselineMiou = safeNumber(baseline.module_miou_mean);
  const baselineCoverage = safeNumber(baseline.coverage_mean);
  const out = {};
  for (const [groupId, item] of Object.entries(groupMap)) {
    out[groupId] = {
      leakage_delta_vs_baseline: round3(safeNumber(item.leakage_mean) - baselineLeakage),
      miou_delta_vs_baseline: round3(safeNumber(item.module_miou_mean) - baselineMiou),
      coverage_delta_vs_baseline: round3(safeNumber(item.coverage_mean) - baselineCoverage),
    };
  }
  return out;
}

function findRecommendation(groups, groupMap, baselineGroupId) {
  const baseline = groupMap[baselineGroupId];
  if (!baseline) return null;
  const candidates = groups
    .filter((group) => group.id !== baselineGroupId)
    .map((group) => {
      const item = groupMap[group.id];
      const leakageDelta = safeNumber(item.leakage_mean) - safeNumber(baseline.leakage_mean);
      const miouDelta = safeNumber(item.module_miou_mean) - safeNumber(baseline.module_miou_mean);
      const qualifies = leakageDelta <= -0.15 || miouDelta >= 0.05;
      const score = (-leakageDelta / 0.15) + (miouDelta / 0.05);
      return {
        group_id: group.id,
        circle_enabled: group.circle_enabled,
        calibration_enabled: group.calibration_enabled,
        leakage_delta_vs_baseline: round3(leakageDelta),
        miou_delta_vs_baseline: round3(miouDelta),
        qualifies,
        score,
      };
    })
    .filter((item) => item.qualifies)
    .sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0] : null;
}

function findMaxRegressionDriver(driverRows) {
  const positiveRows = driverRows
    .map((row) => ({ ...row, delta_leakage: safeNumber(row.delta_leakage) }))
    .filter((row) => row.delta_leakage > 0);
  if (!positiveRows.length) return null;
  positiveRows.sort((a, b) => b.delta_leakage - a.delta_leakage);
  return positiveRows[0];
}

function renderMd({
  runKey,
  args,
  groups,
  groupMap,
  moduleTable,
  driverRows,
  maxRegressionDriver,
  recommendation,
  deltasByGroup,
  sampleSetConsistent,
  regressionThreshold,
  mdPath,
  csvPath,
  jsonlPath,
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
  lines.push(`- sample_set_consistent: ${sampleSetConsistent ? 'true' : 'false'}`);
  lines.push(`- baseline_group: ${DEFAULT_BASELINE_GROUP}`);
  lines.push('');

  if (recommendation) {
    lines.push('## Recommended default flags for internal test');
    lines.push('');
    lines.push(
      `- group: \`${recommendation.group_id}\` (circle=${recommendation.circle_enabled ? 1 : 0}, calibration=${recommendation.calibration_enabled ? 1 : 0})`,
    );
    lines.push(`- leakage_delta_vs_${DEFAULT_BASELINE_GROUP}: ${recommendation.leakage_delta_vs_baseline}`);
    lines.push(`- mIoU_delta_vs_${DEFAULT_BASELINE_GROUP}: ${recommendation.miou_delta_vs_baseline}`);
    lines.push('');
  }

  lines.push('## Group Summary');
  lines.push('');
  lines.push('| group | circle_enabled | calibration_enabled | module_mIoU_mean | leakage_mean | coverage_mean | samples_ok | samples_total | leakage_delta_vs_baseline | mIoU_delta_vs_baseline |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const group of groups) {
    const row = groupMap[group.id];
    const delta = deltasByGroup[group.id] || {};
    lines.push(
      `| ${group.id} | ${group.circle_enabled ? 1 : 0} | ${group.calibration_enabled ? 1 : 0} | ${round3(row.module_miou_mean)} | ${round3(row.leakage_mean)} | ${round3(row.coverage_mean)} | ${row.samples_ok} | ${row.samples_total} | ${round3(delta.leakage_delta_vs_baseline)} | ${round3(delta.miou_delta_vs_baseline)} |`,
    );
  }
  lines.push('');

  lines.push('## Per-Module Compare (chin / forehead / cheeks)');
  lines.push('');
  lines.push('| module | metric | c0_k0 | c0_k1 | c1_k0 | c1_k1 | best_group |');
  lines.push('|---|---|---:|---:|---:|---:|---|');
  for (const row of moduleTable) {
    const bestGroup = markBestGroup(row, groups.map((item) => item.id));
    lines.push(
      `| ${row.module} | ${row.metric} | ${row.c0_k0 ?? 'n/a'} | ${row.c0_k1 ?? 'n/a'} | ${row.c1_k0 ?? 'n/a'} | ${row.c1_k1 ?? 'n/a'} | ${bestGroup || 'n/a'} |`,
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

  if (maxRegressionDriver) {
    lines.push('## Max Regression Driver');
    lines.push('');
    lines.push(
      `- factor: ${maxRegressionDriver.factor}, context: ${maxRegressionDriver.context}, leakage_delta=${round3(maxRegressionDriver.delta_leakage)}`,
    );
    lines.push('');
  }

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- matrix.md: \`${toPosix(path.relative(process.cwd(), mdPath))}\``);
  lines.push(`- matrix.csv: \`${toPosix(path.relative(process.cwd(), csvPath))}\``);
  lines.push(`- matrix.jsonl: \`${toPosix(path.relative(process.cwd(), jsonlPath))}\``);
  for (const group of groups) {
    const payload = groupMap[group.id];
    lines.push(`- ${group.id}.summary: \`${payload.artifacts && payload.artifacts.md ? payload.artifacts.md : ''}\``);
    lines.push(`- ${group.id}.csv: \`${payload.artifacts && payload.artifacts.csv ? payload.artifacts.csv : ''}\``);
    lines.push(`- ${group.id}.jsonl: \`${payload.artifacts && payload.artifacts.jsonl ? payload.artifacts.jsonl : ''}\``);
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
  const jsonlByGroup = {};
  for (const group of groups) {
    const payload = groupPayloads[group.id];
    if (!payload.artifacts || !payload.artifacts.csv) {
      throw new Error(`group_${group.id}_missing_csv_artifact`);
    }
    if (!payload.artifacts || !payload.artifacts.jsonl) {
      throw new Error(`group_${group.id}_missing_jsonl_artifact`);
    }
    csvByGroup[group.id] = await readCsvRows(payload.artifacts.csv);
    jsonlByGroup[group.id] = await readJsonlRows(payload.artifacts.jsonl);
  }

  const moduleTable = buildModuleTable(
    csvByGroup,
    groups.map((group) => group.id),
  );

  const groupMap = {};
  for (const group of groups) {
    const payload = groupPayloads[group.id];
    groupMap[group.id] = {
      ...payload,
      module_miou_mean: safeNumber(payload.module_miou_mean, 0),
      leakage_mean: safeNumber(payload.leakage_mean, 0),
      coverage_mean: computeCoverageMean(jsonlByGroup[group.id], csvByGroup[group.id]),
      samples_ok: safeNumber(payload.samples_ok, 0),
      samples_total: safeNumber(payload.samples_total, 0),
    };
  }

  const sampleSetConsistent = computeSampleSetConsistency(groups, jsonlByGroup);
  const driverRows = computeRegressionDriverRows(groupMap);
  const maxRegressionDriver = findMaxRegressionDriver(driverRows);
  const deltasByGroup = computeDeltasForGroup(groupMap, DEFAULT_BASELINE_GROUP);
  const recommendation = findRecommendation(groups, groupMap, DEFAULT_BASELINE_GROUP);

  const mdPath = path.join(reportDir, `eval_circle_matrix_${runKey}.md`);
  const csvPath = path.join(reportDir, `eval_circle_matrix_${runKey}.csv`);
  const jsonlPath = path.join(reportDir, `eval_circle_matrix_${runKey}.jsonl`);
  const mdText = renderMd({
    runKey,
    args,
    groups,
    groupMap,
    moduleTable,
    driverRows,
    maxRegressionDriver,
    recommendation,
    deltasByGroup,
    sampleSetConsistent,
    regressionThreshold: args.regression_delta_threshold,
    mdPath,
    csvPath,
    jsonlPath,
  });
  await fsp.writeFile(mdPath, mdText, 'utf8');

  const csvHeaders = [
    'section',
    'group',
    'module',
    'metric',
    'circle_enabled',
    'calibration_enabled',
    'value',
    'delta_vs_baseline',
    'module_miou_mean',
    'leakage_mean',
    'coverage_mean',
    'samples_ok',
    'samples_total',
    'factor',
    'context',
    'leakage_delta',
    'verdict',
    'note',
  ];
  const csvRows = [];
  for (const group of groups) {
    const summary = groupMap[group.id];
    const delta = deltasByGroup[group.id] || {};
    csvRows.push({
      section: 'group',
      group: group.id,
      module: '-',
      metric: 'summary',
      circle_enabled: group.circle_enabled ? 1 : 0,
      calibration_enabled: group.calibration_enabled ? 1 : 0,
      value: '',
      delta_vs_baseline: '',
      module_miou_mean: round3(summary.module_miou_mean),
      leakage_mean: round3(summary.leakage_mean),
      coverage_mean: round3(summary.coverage_mean),
      samples_ok: summary.samples_ok,
      samples_total: summary.samples_total,
      factor: '',
      context: '',
      leakage_delta: round3(delta.leakage_delta_vs_baseline),
      verdict: '',
      note: '',
    });
  }

  for (const row of moduleTable) {
    for (const group of groups) {
      const value = row[group.id];
      const baselineValue = row[DEFAULT_BASELINE_GROUP];
      csvRows.push({
        section: 'module',
        group: group.id,
        module: row.module,
        metric: row.metric,
        circle_enabled: group.circle_enabled ? 1 : 0,
        calibration_enabled: group.calibration_enabled ? 1 : 0,
        value: value == null ? '' : round3(value),
        delta_vs_baseline: value == null || baselineValue == null ? '' : round3(safeNumber(value) - safeNumber(baselineValue)),
        module_miou_mean: '',
        leakage_mean: '',
        coverage_mean: '',
        samples_ok: '',
        samples_total: '',
        factor: '',
        context: '',
        leakage_delta: '',
        verdict: '',
        note: '',
      });
    }
  }

  for (const row of driverRows) {
    const isDriver = safeNumber(row.delta_leakage, 0) > args.regression_delta_threshold;
    csvRows.push({
      section: 'driver',
      group: '-',
      module: '-',
      metric: 'leakage_delta',
      circle_enabled: '',
      calibration_enabled: '',
      value: '',
      delta_vs_baseline: '',
      module_miou_mean: '',
      leakage_mean: '',
      coverage_mean: '',
      samples_ok: '',
      samples_total: '',
      factor: row.factor,
      context: row.context,
      leakage_delta: round3(row.delta_leakage),
      verdict: isDriver ? 'REGRESSION DRIVER' : 'ok',
      note: '',
    });
  }

  if (recommendation) {
    csvRows.push({
      section: 'recommendation',
      group: recommendation.group_id,
      module: '-',
      metric: 'recommended_default_flags',
      circle_enabled: recommendation.circle_enabled ? 1 : 0,
      calibration_enabled: recommendation.calibration_enabled ? 1 : 0,
      value: '',
      delta_vs_baseline: '',
      module_miou_mean: '',
      leakage_mean: recommendation.leakage_delta_vs_baseline,
      coverage_mean: '',
      samples_ok: '',
      samples_total: '',
      factor: '',
      context: '',
      leakage_delta: recommendation.leakage_delta_vs_baseline,
      verdict: 'RECOMMENDED',
      note: `miou_delta=${recommendation.miou_delta_vs_baseline}`,
    });
  }

  await writeCsvRows(csvPath, csvHeaders, csvRows);

  const jsonlRows = [
    {
      section: 'meta',
      run_id: runKey,
      generated_at: new Date().toISOString(),
      datasets: ['fasseg'],
      sample_seed: args.sample_seed,
      limit: args.limit,
      baseline_group: DEFAULT_BASELINE_GROUP,
      sample_set_consistent: sampleSetConsistent,
      circle_model_path: args.circle_model_path,
      regression_delta_threshold: round3(args.regression_delta_threshold),
      recommendation: recommendation || null,
      max_regression_driver: maxRegressionDriver || null,
    },
    ...groups.map((group) => ({
      section: 'group',
      group: group.id,
      circle_enabled: group.circle_enabled,
      calibration_enabled: group.calibration_enabled,
      module_miou_mean: round3(groupMap[group.id].module_miou_mean),
      leakage_mean: round3(groupMap[group.id].leakage_mean),
      coverage_mean: round3(groupMap[group.id].coverage_mean),
      samples_ok: groupMap[group.id].samples_ok,
      samples_total: groupMap[group.id].samples_total,
      delta_vs_baseline: deltasByGroup[group.id],
      artifacts: groupMap[group.id].artifacts || {},
    })),
    ...moduleTable.map((row) => ({
      section: 'module',
      module: row.module,
      metric: row.metric,
      values: Object.fromEntries(groups.map((group) => [group.id, row[group.id]])),
      best_group: markBestGroup(row, groups.map((group) => group.id)),
      baseline_group: DEFAULT_BASELINE_GROUP,
    })),
    ...driverRows.map((row) => ({
      section: 'driver',
      factor: row.factor,
      context: row.context,
      leakage_delta: round3(row.delta_leakage),
      verdict: safeNumber(row.delta_leakage, 0) > args.regression_delta_threshold ? 'REGRESSION DRIVER' : 'ok',
    })),
  ];
  await writeJsonlRows(jsonlPath, jsonlRows);

  const payload = {
    ok: true,
    run_id: runKey,
    sample_seed: args.sample_seed,
    sample_set_consistent: sampleSetConsistent,
    baseline_group: DEFAULT_BASELINE_GROUP,
    recommendation: recommendation || null,
    max_regression_driver: maxRegressionDriver || null,
    groups: groups.map((group) => ({
      id: group.id,
      circle_enabled: group.circle_enabled,
      calibration_enabled: group.calibration_enabled,
      module_miou_mean: round3(groupMap[group.id].module_miou_mean),
      leakage_mean: round3(groupMap[group.id].leakage_mean),
      coverage_mean: round3(groupMap[group.id].coverage_mean),
      samples_ok: groupMap[group.id].samples_ok,
      samples_total: groupMap[group.id].samples_total,
      delta_vs_baseline: deltasByGroup[group.id],
    })),
    driver_rows: driverRows,
    artifacts: {
      md: toPosix(path.relative(repoRoot, mdPath)),
      csv: toPosix(path.relative(repoRoot, csvPath)),
      jsonl: toPosix(path.relative(repoRoot, jsonlPath)),
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (maxExitCode > 0) process.exitCode = maxExitCode;
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
