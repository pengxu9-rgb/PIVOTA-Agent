#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTimestampKey } from './internal_batch_helpers.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

const STRONG_MODULES = Object.freeze(['nose', 'forehead', 'left_cheek', 'right_cheek', 'chin']);
const DEFAULT_DATASETS = 'celebamaskhq,lapa,fasseg';
const DEFAULT_LIMIT = 150;
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_GRID_SIZE = 128;
const DEFAULT_MARKET = 'US';
const DEFAULT_LANG = 'en';
const DEFAULT_CIRCLE_MODEL_PATH = path.join('model_registry', 'circle_prior_latest.json');
const DEFAULT_CIRCLE_MODEL_MIN_PIXELS = 24;

const HELP_TEXT = `eval_circle_crossset.mjs

Usage:
  node scripts/eval_circle_crossset.mjs [options]

Options:
  --datasets <csv>                  datasets to compare (default: celebamaskhq,lapa,fasseg)
  --limit <n>                       per-dataset sample limit (default: 150)
  --report_dir <dir>                output report directory (default: reports)
  --cache_dir <dir>                 datasets cache root (default: datasets_cache/external)
  --concurrency <n>                 eval concurrency (default: 4)
  --timeout_ms <n>                  request timeout (default: 30000)
  --grid_size <n>                   evaluation grid size (default: 128)
  --market <US|JP>                  market tag (default: US)
  --lang <en|ja|zh>                 language tag (default: en)
  --base_url <url>                  evaluate via API base url (optional)
  --token <token>                   API token (optional)
  --circle_model_path <path>        circle prior model path (default: model_registry/circle_prior_latest.json)
  --circle_model_min_pixels <n>     circle prior calibration min pixels (default: 24)
  --shuffle <bool>                  shuffle dataset sample order (default: false)
  --emit_debug_overlays <bool>      emit debug overlays (default: false)
  --disable_circle_model_calibration <bool>
  --help                            show help
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

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function parseDatasets(raw) {
  return Array.from(
    new Set(
      String(raw || DEFAULT_DATASETS)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function parseArgs(argv) {
  const out = {
    help: false,
    datasets: process.env.EVAL_CROSSSET_DATASETS || process.env.DATASETS || DEFAULT_DATASETS,
    limit: process.env.LIMIT || DEFAULT_LIMIT,
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    concurrency: process.env.EVAL_CONCURRENCY || process.env.CONCURRENCY || DEFAULT_CONCURRENCY,
    timeout_ms: process.env.EVAL_TIMEOUT_MS || process.env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
    grid_size: process.env.EVAL_GRID_SIZE || DEFAULT_GRID_SIZE,
    market: process.env.MARKET || DEFAULT_MARKET,
    lang: process.env.LANG || DEFAULT_LANG,
    base_url: process.env.EVAL_BASE_URL || process.env.BASE_URL || process.env.BASE || '',
    token: process.env.EVAL_TOKEN || process.env.TOKEN || '',
    circle_model_path: process.env.EVAL_CIRCLE_MODEL_PATH || process.env.CIRCLE_MODEL_PATH || DEFAULT_CIRCLE_MODEL_PATH,
    circle_model_min_pixels: process.env.CIRCLE_MODEL_MIN_PIXELS || DEFAULT_CIRCLE_MODEL_MIN_PIXELS,
    shuffle: process.env.EVAL_SHUFFLE || process.env.SHUFFLE || 'false',
    emit_debug_overlays: process.env.EVAL_EMIT_DEBUG || process.env.EMIT_DEBUG_OVERLAYS || 'false',
    disable_circle_model_calibration: process.env.DISABLE_CIRCLE_MODEL_CALIBRATION || 'false',
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
  out.datasets = parseDatasets(out.datasets);
  out.limit = Math.max(1, Math.min(5000, Math.trunc(parseNumber(out.limit, DEFAULT_LIMIT, 1, 5000))));
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.cache_dir = String(out.cache_dir || DEFAULT_CACHE_DIR).trim() || DEFAULT_CACHE_DIR;
  out.concurrency = Math.max(1, Math.min(16, Math.trunc(parseNumber(out.concurrency, DEFAULT_CONCURRENCY, 1, 16))));
  out.timeout_ms = Math.max(1000, Math.min(180000, Math.trunc(parseNumber(out.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 180000))));
  out.grid_size = Math.max(64, Math.min(512, Math.trunc(parseNumber(out.grid_size, DEFAULT_GRID_SIZE, 64, 512))));
  out.market = String(out.market || DEFAULT_MARKET).trim() || DEFAULT_MARKET;
  out.lang = String(out.lang || DEFAULT_LANG).trim() || DEFAULT_LANG;
  out.base_url = String(out.base_url || '').trim();
  out.token = String(out.token || '').trim();
  out.circle_model_path = String(out.circle_model_path || DEFAULT_CIRCLE_MODEL_PATH).trim() || DEFAULT_CIRCLE_MODEL_PATH;
  out.circle_model_min_pixels = Math.max(
    1,
    Math.min(1024, Math.trunc(parseNumber(out.circle_model_min_pixels, DEFAULT_CIRCLE_MODEL_MIN_PIXELS, 1, 1024))),
  );
  out.shuffle = parseBool(out.shuffle, false);
  out.emit_debug_overlays = parseBool(out.emit_debug_overlays, false);
  out.disable_circle_model_calibration = parseBool(out.disable_circle_model_calibration, false);
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
      // continue
    }
  }
  throw new Error('json_parse_failed');
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

async function readCsvRows(csvPath) {
  const text = await fsp.readFile(csvPath, 'utf8');
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = values[j] == null ? '' : values[j];
    rows.push(row);
  }
  return rows;
}

async function runSingleDataset(dataset, args) {
  const cli = [
    path.join(REPO_ROOT, 'scripts', 'eval_circle_accuracy.mjs'),
    '--cache_dir', args.cache_dir,
    '--datasets', dataset,
    '--concurrency', String(args.concurrency),
    '--timeout_ms', String(args.timeout_ms),
    '--market', args.market,
    '--lang', args.lang,
    '--grid_size', String(args.grid_size),
    '--report_dir', args.report_dir,
    '--circle_model_path', args.circle_model_path,
    '--circle_model_min_pixels', String(args.circle_model_min_pixels),
    '--limit', String(args.limit),
  ];
  if (args.shuffle) cli.push('--shuffle');
  if (args.base_url) cli.push('--base_url', args.base_url);
  if (args.emit_debug_overlays) cli.push('--emit_debug_overlays');
  if (args.disable_circle_model_calibration) cli.push('--disable_circle_model_calibration');

  const env = {
    ...process.env,
    ...(args.token ? { TOKEN: args.token } : {}),
  };
  const run = spawnSync(process.execPath, cli, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
  let payload = null;
  try {
    payload = parseJsonObject(run.stdout);
  } catch (error) {
    if (run.status !== 0) {
      throw new Error(`eval_circle_failed:${dataset}:${String(run.stderr || run.stdout || '').slice(0, 500)}`);
    }
    throw error;
  }

  const csvRel = payload && payload.artifacts ? payload.artifacts.csv : '';
  const csvPath = csvRel ? path.resolve(REPO_ROOT, csvRel) : '';
  const csvRows = csvPath && fs.existsSync(csvPath) ? await readCsvRows(csvPath) : [];

  return {
    dataset,
    exit_code: Number.isFinite(run.status) ? run.status : 1,
    payload,
    csv_rows: csvRows,
  };
}

function summarizeDatasetResult(result) {
  const strongRows = result.csv_rows.filter((row) => STRONG_MODULES.includes(String(row.module_id || '').trim()));
  const allRows = result.csv_rows;
  const worstStrong = [...strongRows]
    .sort((a, b) => Number(a.miou_mean || 0) - Number(b.miou_mean || 0))
    .slice(0, 1)[0] || null;

  const summary = {
    dataset: result.dataset,
    dataset_eval_mode: result.payload && result.payload.dataset_eval_mode ? result.payload.dataset_eval_mode : 'unknown',
    exit_code: result.exit_code,
    samples_total: Number(result.payload && result.payload.samples_total) || 0,
    samples_ok: Number(result.payload && result.payload.samples_ok) || 0,
    strong_module_miou_mean: round3(mean(strongRows.map((row) => Number(row.miou_mean)))),
    coverage_mean: round3(mean(strongRows.map((row) => Number(row.coverage_mean)))),
    leakage_bg_mean: round3(mean(strongRows.map((row) => Number(row.leakage_bg_mean)))),
    leakage_hair_mean: round3(mean(strongRows.map((row) => Number(row.leakage_hair_mean)))),
    worst_module: worstStrong ? String(worstStrong.module_id || 'unknown') : null,
    worst_module_miou: worstStrong ? round3(Number(worstStrong.miou_mean)) : null,
    fail_reasons: Array.isArray(result.payload && result.payload.fail_reasons) ? result.payload.fail_reasons : [],
    artifacts: result.payload && result.payload.artifacts ? result.payload.artifacts : {},
  };

  const moduleRows = allRows.map((row) => ({
    dataset: result.dataset,
    module_id: String(row.module_id || ''),
    miou_mean: round3(Number(row.miou_mean)),
    coverage_mean: round3(Number(row.coverage_mean)),
    leakage_bg_mean: round3(Number(row.leakage_bg_mean)),
    leakage_hair_mean: round3(Number(row.leakage_hair_mean)),
    samples: Number(row.samples) || 0,
  }));
  return { summary, moduleRows };
}

function renderMarkdown({ runId, args, summaries, worstModules, files }) {
  const lines = [];
  lines.push('# Eval Circle Crossset');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- datasets: ${args.datasets.join(', ')}`);
  lines.push(`- limit: ${args.limit}`);
  lines.push(`- cache_dir: \`${toPosix(path.relative(process.cwd(), path.resolve(args.cache_dir)))}\``);
  lines.push(`- report_dir: \`${toPosix(path.relative(process.cwd(), path.resolve(args.report_dir)))}\``);
  lines.push('');
  lines.push('## Per-Dataset Metrics');
  lines.push('');
  lines.push('| dataset | mode | exit_code | samples_total | strong_module_mIoU | coverage | leakage_bg | leakage_hair | worst_module | worst_module_mIoU |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|---:|');
  for (const row of summaries) {
    lines.push(
      `| ${row.dataset} | ${row.dataset_eval_mode} | ${row.exit_code} | ${row.samples_total} | ${row.strong_module_miou_mean ?? '-'} | ${row.coverage_mean ?? '-'} | ${row.leakage_bg_mean ?? '-'} | ${row.leakage_hair_mean ?? '-'} | ${row.worst_module || '-'} | ${row.worst_module_miou ?? '-'} |`,
    );
  }
  lines.push('');
  lines.push('## Worst Modules Across Datasets');
  lines.push('');
  lines.push('| rank | dataset | module | mIoU | coverage | leakage_bg | leakage_hair | samples |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|');
  if (!worstModules.length) {
    lines.push('| 1 | - | - | - | - | - | - | - |');
  } else {
    worstModules.slice(0, 30).forEach((row, idx) => {
      lines.push(
        `| ${idx + 1} | ${row.dataset} | ${row.module_id} | ${row.miou_mean ?? '-'} | ${row.coverage_mean ?? '-'} | ${row.leakage_bg_mean ?? '-'} | ${row.leakage_hair_mean ?? '-'} | ${row.samples} |`,
      );
    });
  }
  lines.push('');
  lines.push('## Fail Reasons');
  lines.push('');
  for (const row of summaries) {
    lines.push(`### ${row.dataset}`);
    lines.push('');
    lines.push('| reason | count | pct |');
    lines.push('|---|---:|---:|');
    if (!Array.isArray(row.fail_reasons) || !row.fail_reasons.length) {
      lines.push('| - | 0 | 0 |');
    } else {
      for (const reason of row.fail_reasons.slice(0, 10)) {
        lines.push(`| ${reason.reason || '-'} | ${reason.count || 0} | ${reason.pct || 0} |`);
      }
    }
    lines.push('');
  }
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- report_md: \`${files.mdRel}\``);
  lines.push(`- report_json: \`${files.jsonRel}\``);
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
  if (!args.datasets.length) {
    process.stderr.write('eval_circle_crossset: datasets cannot be empty\n');
    process.exit(2);
    return;
  }

  const runId = runTimestampKey();
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const datasetRuns = [];
  for (const dataset of args.datasets) {
    datasetRuns.push(await runSingleDataset(dataset, args));
  }

  const summaries = [];
  const allModuleRows = [];
  for (const run of datasetRuns) {
    const built = summarizeDatasetResult(run);
    summaries.push(built.summary);
    allModuleRows.push(...built.moduleRows.filter((row) => STRONG_MODULES.includes(row.module_id)));
  }
  const worstModules = [...allModuleRows]
    .sort((a, b) => Number(a.miou_mean || Infinity) - Number(b.miou_mean || Infinity))
    .slice(0, 60);

  const reportJsonPath = path.join(reportDir, `eval_circle_crossset_${runId}.json`);
  const reportMdPath = path.join(reportDir, `eval_circle_crossset_${runId}.md`);
  const jsonPayload = {
    ok: true,
    run_id: runId,
    generated_at: new Date().toISOString(),
    datasets: args.datasets,
    limit: args.limit,
    summaries,
    worst_modules: worstModules,
    dataset_runs: datasetRuns.map((run) => ({
      dataset: run.dataset,
      exit_code: run.exit_code,
      payload: run.payload,
    })),
  };
  await fsp.writeFile(reportJsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');
  const markdown = renderMarkdown({
    runId,
    args,
    summaries,
    worstModules,
    files: {
      mdRel: toPosix(path.relative(process.cwd(), reportMdPath)),
      jsonRel: toPosix(path.relative(process.cwd(), reportJsonPath)),
    },
  });
  await fsp.writeFile(reportMdPath, markdown, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    datasets: args.datasets,
    report_md: toPosix(path.relative(process.cwd(), reportMdPath)),
    report_json: toPosix(path.relative(process.cwd(), reportJsonPath)),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`eval_circle_crossset_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});

