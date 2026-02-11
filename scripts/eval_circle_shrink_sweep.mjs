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
const DEFAULT_SAMPLE_SEED = 'fasseg_shrink_sweep_seed_v1';
const DEFAULT_CIRCLE_MODEL_MIN_PIXELS = 24;

const SWEEP_GROUPS = [
  { id: 'baseline', chin: 1, forehead: 1, cheek: 1, underEye: 1, nose: 1 },
  { id: 'default', chin: 0.8, forehead: 0.88, cheek: 0.9, underEye: 0.95, nose: 0.95 },
  { id: 'tight_a', chin: 0.75, forehead: 0.85, cheek: 0.88, underEye: 0.93, nose: 0.93 },
  { id: 'tight_b', chin: 0.7, forehead: 0.82, cheek: 0.85, underEye: 0.9, nose: 0.9 },
  { id: 'mid_a', chin: 0.78, forehead: 0.86, cheek: 0.88, underEye: 0.92, nose: 0.94 },
  { id: 'mid_b', chin: 0.82, forehead: 0.9, cheek: 0.9, underEye: 0.94, nose: 0.96 },
  { id: 'loose_a', chin: 0.85, forehead: 0.9, cheek: 0.92, underEye: 0.97, nose: 0.97 },
  { id: 'loose_b', chin: 0.9, forehead: 0.93, cheek: 0.94, underEye: 0.98, nose: 0.98 },
];

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
    circle_model_calibration: parseBoolean(process.env.CIRCLE_MODEL_CALIBRATION, true),
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
    require_target: parseBoolean(process.env.SHRINK_SWEEP_REQUIRE_TARGET, false),
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
    if (token === '--disable_circle_model_calibration') {
      out.circle_model_calibration = false;
      continue;
    }
    if (token === '--require_target') {
      out.require_target = true;
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

function parsePerModule(csvRows) {
  const map = new Map();
  for (const row of Array.isArray(csvRows) ? csvRows : []) {
    const dataset = String(row.dataset || '').trim();
    const moduleId = String(row.module_id || '').trim();
    if (dataset !== 'fasseg' || !moduleId) continue;
    map.set(moduleId, {
      miou_mean: safeNumber(row.miou_mean, NaN),
      leakage_mean: safeNumber(row.leakage_mean, NaN),
      coverage_mean: safeNumber(row.coverage_mean, NaN),
    });
  }
  const pick = (moduleId, field) => {
    const row = map.get(moduleId);
    const value = row ? row[field] : NaN;
    return Number.isFinite(value) ? round3(value) : null;
  };
  const cheeks = {
    miou_mean: round3(
      mean([pick('left_cheek', 'miou_mean'), pick('right_cheek', 'miou_mean')].filter((value) => Number.isFinite(value))),
    ),
    leakage_mean: round3(
      mean([pick('left_cheek', 'leakage_mean'), pick('right_cheek', 'leakage_mean')].filter((value) => Number.isFinite(value))),
    ),
    coverage_mean: round3(
      mean([pick('left_cheek', 'coverage_mean'), pick('right_cheek', 'coverage_mean')].filter((value) => Number.isFinite(value))),
    ),
  };
  return {
    chin: {
      miou_mean: pick('chin', 'miou_mean'),
      leakage_mean: pick('chin', 'leakage_mean'),
      coverage_mean: pick('chin', 'coverage_mean'),
    },
    forehead: {
      miou_mean: pick('forehead', 'miou_mean'),
      leakage_mean: pick('forehead', 'leakage_mean'),
      coverage_mean: pick('forehead', 'coverage_mean'),
    },
    cheeks,
  };
}

function isDominated(candidate, other) {
  const betterOrEqualLeakage = safeNumber(other.leakage_mean, Infinity) <= safeNumber(candidate.leakage_mean, Infinity);
  const betterOrEqualMiou = safeNumber(other.module_miou_mean, -Infinity) >= safeNumber(candidate.module_miou_mean, -Infinity);
  const strictlyBetter =
    safeNumber(other.leakage_mean, Infinity) < safeNumber(candidate.leakage_mean, Infinity) ||
    safeNumber(other.module_miou_mean, -Infinity) > safeNumber(candidate.module_miou_mean, -Infinity);
  return betterOrEqualLeakage && betterOrEqualMiou && strictlyBetter;
}

function paretoFrontier(rows) {
  const out = [];
  for (const row of rows) {
    const dominated = rows.some((other) => other !== row && isDominated(row, other));
    if (!dominated) out.push(row);
  }
  out.sort((a, b) => {
    if (safeNumber(a.leakage_mean) !== safeNumber(b.leakage_mean)) {
      return safeNumber(a.leakage_mean) - safeNumber(b.leakage_mean);
    }
    return safeNumber(b.module_miou_mean) - safeNumber(a.module_miou_mean);
  });
  return out;
}

function scoreRow(row, baseline) {
  const leakageGain = safeNumber(baseline.leakage_mean) - safeNumber(row.leakage_mean);
  const miouGain = safeNumber(row.module_miou_mean) - safeNumber(baseline.module_miou_mean);
  return leakageGain * 1.0 + miouGain * 0.5;
}

function renderMd({
  runKey,
  args,
  rows,
  paretoRows,
  recommendedRows,
  targetMetRows,
  mdPath,
  csvPath,
  jsonlPath,
}) {
  const lines = [];
  const baseline = rows.find((row) => row.group_id === 'baseline') || rows[0];
  lines.push('# Eval Circle Shrink Sweep (FASSEG)');
  lines.push('');
  lines.push(`- run_id: ${runKey}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- datasets: fasseg`);
  lines.push(`- sample_seed: ${args.sample_seed}`);
  lines.push(`- limit: ${args.limit}`);
  lines.push(`- baseline_group: ${baseline ? baseline.group_id : 'n/a'}`);
  lines.push(`- circle_model_path: ${args.circle_model_path}`);
  lines.push(`- circle_model_calibration: ${args.circle_model_calibration ? 'true' : 'false'}`);
  lines.push('');

  if (targetMetRows.length) {
    lines.push('## DoD Check');
    lines.push('');
    lines.push('- status: PASS');
    lines.push(`- combos_meeting_target: ${targetMetRows.map((row) => row.group_id).join(', ')}`);
    lines.push('');
  } else {
    lines.push('## DoD Check');
    lines.push('');
    lines.push('- status: NOT_MET');
    lines.push('- target: leakage_delta <= -0.10 and mIoU_delta >= -0.02 (vs baseline)');
    lines.push('');
  }

  lines.push('## Sweep Summary');
  lines.push('');
  lines.push('| group | chin | forehead | cheek | under_eye | nose | module_mIoU_mean | leakage_mean | coverage_mean | leakage_delta_vs_baseline | mIoU_delta_vs_baseline | target_met |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const row of rows) {
    lines.push(
      `| ${row.group_id} | ${row.shrink.chin} | ${row.shrink.forehead} | ${row.shrink.cheek} | ${row.shrink.underEye} | ${row.shrink.nose} | ${row.module_miou_mean} | ${row.leakage_mean} | ${row.coverage_mean} | ${row.leakage_delta_vs_baseline} | ${row.miou_delta_vs_baseline} | ${row.target_met ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');

  lines.push('## Per-Module Tradeoff (chin / forehead / cheeks)');
  lines.push('');
  lines.push('| group | module | mIoU | leakage | coverage |');
  lines.push('|---|---|---:|---:|---:|');
  for (const row of rows) {
    for (const moduleName of ['chin', 'forehead', 'cheeks']) {
      const moduleRow = row.modules[moduleName] || {};
      lines.push(
        `| ${row.group_id} | ${moduleName} | ${moduleRow.miou_mean ?? 'n/a'} | ${moduleRow.leakage_mean ?? 'n/a'} | ${moduleRow.coverage_mean ?? 'n/a'} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Pareto Frontier');
  lines.push('');
  lines.push('| rank | group | module_mIoU_mean | leakage_mean | score_vs_baseline |');
  lines.push('|---:|---|---:|---:|---:|');
  paretoRows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.group_id} | ${row.module_miou_mean} | ${row.leakage_mean} | ${row.score_vs_baseline} |`,
    );
  });
  lines.push('');

  if (recommendedRows.length) {
    lines.push('## Recommended Internal Defaults');
    lines.push('');
    for (const row of recommendedRows) {
      lines.push(
        `- \`${row.group_id}\` => DIAG_MODULE_SHRINK_CHIN=${row.shrink.chin}, DIAG_MODULE_SHRINK_FOREHEAD=${row.shrink.forehead}, DIAG_MODULE_SHRINK_CHEEK=${row.shrink.cheek}, DIAG_MODULE_SHRINK_UNDER_EYE=${row.shrink.underEye}, DIAG_MODULE_SHRINK_NOSE=${row.shrink.nose}`,
      );
    }
    lines.push('');
  }

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- sweep.md: \`${toPosix(path.relative(process.cwd(), mdPath))}\``);
  lines.push(`- sweep.csv: \`${toPosix(path.relative(process.cwd(), csvPath))}\``);
  lines.push(`- sweep.jsonl: \`${toPosix(path.relative(process.cwd(), jsonlPath))}\``);
  for (const row of rows) {
    lines.push(`- ${row.group_id}.summary: \`${row.artifacts.md || ''}\``);
    lines.push(`- ${row.group_id}.csv: \`${row.artifacts.csv || ''}\``);
    lines.push(`- ${row.group_id}.jsonl: \`${row.artifacts.jsonl || ''}\``);
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
  const sweepRunDir = path.join(reportDir, `.eval_circle_shrink_sweep_${runKey}`);
  await fsp.mkdir(sweepRunDir, { recursive: true });

  const groupRows = [];
  let maxExitCode = 0;

  for (const group of SWEEP_GROUPS) {
    const groupReportDir = path.join(sweepRunDir, group.id);
    await fsp.mkdir(groupReportDir, { recursive: true });
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
      groupReportDir,
      '--sample_seed',
      args.sample_seed,
      '--shuffle',
      '--circle_model_path',
      args.circle_model_path,
      '--circle_model_min_pixels',
      String(args.circle_model_min_pixels),
    ];
    if (!args.circle_model_calibration) {
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
        DIAG_MODULE_SHRINK_CHIN: String(group.chin),
        DIAG_MODULE_SHRINK_FOREHEAD: String(group.forehead),
        DIAG_MODULE_SHRINK_CHEEK: String(group.cheek),
        DIAG_MODULE_SHRINK_UNDER_EYE: String(group.underEye),
        DIAG_MODULE_SHRINK_NOSE: String(group.nose),
      },
    });

    let payload = null;
    try {
      payload = parseLastJsonLine(result.stdout);
    } catch (_error) {
      payload = null;
    }
    if (result.status !== 0 && !payload) {
      throw new Error(`group_${group.id}_failed:${result.stderr || result.stdout || 'unknown_error'}`);
    }
    if (!payload) {
      throw new Error(`group_${group.id}_missing_json_payload`);
    }
    maxExitCode = Math.max(maxExitCode, Number(result.status || 0), Number(payload.exit_code || 0));

    const csvRows = payload.artifacts && payload.artifacts.csv
      ? await readCsvRows(payload.artifacts.csv)
      : [];
    const moduleStats = parsePerModule(csvRows);
    const coverageFromCsv = round3(
      mean(
        csvRows
          .map((row) => safeNumber(row.coverage_mean, NaN))
          .filter((value) => Number.isFinite(value)),
      ),
    );
    groupRows.push({
      group_id: group.id,
      shrink: {
        chin: group.chin,
        forehead: group.forehead,
        cheek: group.cheek,
        underEye: group.underEye,
        nose: group.nose,
      },
      module_miou_mean: round3(safeNumber(payload.module_miou_mean, 0)),
      leakage_mean: round3(safeNumber(payload.leakage_mean, 0)),
      coverage_mean: round3(safeNumber(payload.coverage_mean, coverageFromCsv)),
      samples_ok: safeNumber(payload.samples_ok, 0),
      samples_total: safeNumber(payload.samples_total, 0),
      modules: moduleStats,
      artifacts: payload.artifacts || {},
    });
  }

  const baseline = groupRows.find((row) => row.group_id === 'baseline') || groupRows[0];
  for (const row of groupRows) {
    row.leakage_delta_vs_baseline = round3(row.leakage_mean - baseline.leakage_mean);
    row.miou_delta_vs_baseline = round3(row.module_miou_mean - baseline.module_miou_mean);
    row.target_met = row.leakage_delta_vs_baseline <= -0.1 && row.miou_delta_vs_baseline >= -0.02;
    row.score_vs_baseline = round3(scoreRow(row, baseline));
  }

  const sortedRows = groupRows
    .slice()
    .sort((a, b) => {
      if (a.group_id === baseline.group_id) return -1;
      if (b.group_id === baseline.group_id) return 1;
      if (a.leakage_mean !== b.leakage_mean) return a.leakage_mean - b.leakage_mean;
      return b.module_miou_mean - a.module_miou_mean;
    });
  const paretoRows = paretoFrontier(groupRows).map((row) => ({
    ...row,
    score_vs_baseline: round3(scoreRow(row, baseline)),
  }));
  paretoRows.sort((a, b) => b.score_vs_baseline - a.score_vs_baseline);
  const recommendedRows = paretoRows.slice(0, 3);
  const targetMetRows = sortedRows.filter((row) => row.target_met);

  const mdPath = path.join(reportDir, `eval_circle_shrink_sweep_${runKey}.md`);
  const csvPath = path.join(reportDir, `eval_circle_shrink_sweep_${runKey}.csv`);
  const jsonlPath = path.join(reportDir, `eval_circle_shrink_sweep_${runKey}.jsonl`);

  const mdText = renderMd({
    runKey,
    args,
    rows: sortedRows,
    paretoRows,
    recommendedRows,
    targetMetRows,
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
    'chin',
    'forehead',
    'cheek',
    'under_eye',
    'nose',
    'value',
    'module_miou_mean',
    'leakage_mean',
    'coverage_mean',
    'leakage_delta_vs_baseline',
    'miou_delta_vs_baseline',
    'target_met',
    'score_vs_baseline',
  ];
  const csvRows = [];
  for (const row of sortedRows) {
    csvRows.push({
      section: 'group',
      group: row.group_id,
      module: '-',
      metric: 'summary',
      chin: row.shrink.chin,
      forehead: row.shrink.forehead,
      cheek: row.shrink.cheek,
      under_eye: row.shrink.underEye,
      nose: row.shrink.nose,
      value: '',
      module_miou_mean: row.module_miou_mean,
      leakage_mean: row.leakage_mean,
      coverage_mean: row.coverage_mean,
      leakage_delta_vs_baseline: row.leakage_delta_vs_baseline,
      miou_delta_vs_baseline: row.miou_delta_vs_baseline,
      target_met: row.target_met ? 'yes' : 'no',
      score_vs_baseline: row.score_vs_baseline,
    });
    for (const moduleName of ['chin', 'forehead', 'cheeks']) {
      const stats = row.modules[moduleName] || {};
      csvRows.push({
        section: 'module',
        group: row.group_id,
        module: moduleName,
        metric: 'module_stats',
        chin: row.shrink.chin,
        forehead: row.shrink.forehead,
        cheek: row.shrink.cheek,
        under_eye: row.shrink.underEye,
        nose: row.shrink.nose,
        value: '',
        module_miou_mean: stats.miou_mean ?? '',
        leakage_mean: stats.leakage_mean ?? '',
        coverage_mean: stats.coverage_mean ?? '',
        leakage_delta_vs_baseline: '',
        miou_delta_vs_baseline: '',
        target_met: '',
        score_vs_baseline: '',
      });
    }
  }
  await writeCsvRows(csvPath, csvHeaders, csvRows);

  const jsonlRows = [
    {
      section: 'meta',
      run_id: runKey,
      generated_at: new Date().toISOString(),
      dataset: 'fasseg',
      sample_seed: args.sample_seed,
      limit: args.limit,
      baseline_group: baseline.group_id,
      target_met_count: targetMetRows.length,
      recommended_groups: recommendedRows.map((row) => row.group_id),
      require_target: args.require_target,
    },
    ...sortedRows.map((row) => ({
      section: 'group',
      ...row,
    })),
    ...paretoRows.map((row, index) => ({
      section: 'pareto',
      rank: index + 1,
      group_id: row.group_id,
      score_vs_baseline: row.score_vs_baseline,
      module_miou_mean: row.module_miou_mean,
      leakage_mean: row.leakage_mean,
    })),
  ];
  await writeJsonlRows(jsonlPath, jsonlRows);

  const payload = {
    ok: true,
    run_id: runKey,
    baseline_group: baseline.group_id,
    target_met_count: targetMetRows.length,
    recommended_groups: recommendedRows.map((row) => ({
      group_id: row.group_id,
      shrink: row.shrink,
      module_miou_mean: row.module_miou_mean,
      leakage_mean: row.leakage_mean,
      score_vs_baseline: row.score_vs_baseline,
    })),
    artifacts: {
      md: toPosix(path.relative(repoRoot, mdPath)),
      csv: toPosix(path.relative(repoRoot, csvPath)),
      jsonl: toPosix(path.relative(repoRoot, jsonlPath)),
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (args.require_target && targetMetRows.length === 0) {
    process.exitCode = 3;
    return;
  }
  if (maxExitCode > 0) {
    process.exitCode = maxExitCode;
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
