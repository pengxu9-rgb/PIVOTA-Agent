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
  return values.reduce((acc, value) => acc + Number(value || 0), 0) / values.length;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function parseArgs(argv) {
  const out = {
    onnx: process.env.ONNX || path.join('artifacts', 'skinmask_v1.onnx'),
    cache_dir: process.env.CACHE_DIR || path.join('datasets_cache', 'external'),
    datasets: process.env.DATASETS || 'fasseg,lapa,celebamaskhq',
    limit: parseNumber(process.env.LIMIT, 0, 0, 200000),
    shuffle: parseBoolean(process.env.EVAL_SHUFFLE || process.env.SHUFFLE, false),
    concurrency: parseNumber(process.env.EVAL_CONCURRENCY || process.env.CONCURRENCY, 4, 1, 16),
    timeout_ms: parseNumber(process.env.EVAL_TIMEOUT_MS || process.env.TIMEOUT_MS, 30000, 1000, 120000),
    market: String(process.env.MARKET || 'EU'),
    lang: String(process.env.LANG || 'en'),
    grid_size: parseNumber(process.env.EVAL_GRID_SIZE || process.env.GT_GRID_SIZE, 128, 64, 512),
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports',
    emit_debug_overlays: parseBoolean(process.env.EVAL_EMIT_DEBUG || process.env.EMIT_DEBUG_OVERLAYS, false),
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
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--emit_debug_overlays') {
      out.emit_debug_overlays = true;
    }
  }

  out.limit = Math.max(0, Math.trunc(out.limit));
  out.grid_size = Math.max(64, Math.trunc(out.grid_size));
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.timeout_ms = Math.max(1000, Math.trunc(out.timeout_ms));
  out.onnx = String(out.onnx || '').trim();
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

async function coverageMeanFromJsonl(pathInput) {
  const abs = path.resolve(pathInput);
  const text = await fsp.readFile(abs, 'utf8');
  const values = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    if (!row || !row.ok || !Array.isArray(row.module_scores)) continue;
    for (const moduleScore of row.module_scores) {
      const coverage = Number(moduleScore && moduleScore.coverage);
      if (Number.isFinite(coverage)) values.push(coverage);
    }
  }
  return mean(values);
}

function runEval({ args, skinmaskEnabled, repoRoot }) {
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
    args.report_dir,
  ];
  if (args.limit > 0) {
    cli.push('--limit', String(args.limit));
  }
  if (args.shuffle) {
    cli.push('--shuffle');
  }
  if (args.emit_debug_overlays) {
    cli.push('--emit_debug_overlays');
  }
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
    },
  });
  if (run.status !== 0) {
    throw new Error(
      `eval_circle_failed(${skinmaskEnabled ? 'skinmask_on' : 'skinmask_off'}): ${run.stderr || run.stdout || 'unknown_error'}`,
    );
  }
  return parseLastJsonLine(run.stdout);
}

function renderReport({
  runKey,
  args,
  basePayload,
  skinmaskPayload,
  baseCoverage,
  skinmaskCoverage,
  outPath,
}) {
  const baseMiou = Number(basePayload.module_miou_mean || 0);
  const skinMiou = Number(skinmaskPayload.module_miou_mean || 0);
  const baseLeakage = Number(basePayload.leakage_mean || 0);
  const skinLeakage = Number(skinmaskPayload.leakage_mean || 0);
  const baseRoiTooSmall = Number(basePayload.skin_roi_too_small_rate || 0);
  const skinRoiTooSmall = Number(skinmaskPayload.skin_roi_too_small_rate || 0);
  const baseFail = Number(basePayload.face_detect_fail_rate || 0);
  const skinFail = Number(skinmaskPayload.face_detect_fail_rate || 0);

  const lines = [];
  lines.push('# Skinmask Ablation Report');
  lines.push('');
  lines.push(`- run_id: ${runKey}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- datasets: ${args.datasets}`);
  lines.push(`- onnx: ${args.onnx}`);
  lines.push(`- limit: ${args.limit || 'all'}`);
  lines.push('');
  lines.push('| metric | skinmask_off | skinmask_on | delta(on-off) |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| module_mIoU_mean | ${round3(baseMiou)} | ${round3(skinMiou)} | ${round3(skinMiou - baseMiou)} |`);
  lines.push(`| coverage_mean | ${round3(baseCoverage)} | ${round3(skinmaskCoverage)} | ${round3(skinmaskCoverage - baseCoverage)} |`);
  lines.push(`| leakage_mean | ${round3(baseLeakage)} | ${round3(skinLeakage)} | ${round3(skinLeakage - baseLeakage)} |`);
  lines.push(`| skin_roi_too_small_rate | ${round3(baseRoiTooSmall)} | ${round3(skinRoiTooSmall)} | ${round3(skinRoiTooSmall - baseRoiTooSmall)} |`);
  lines.push(`| face_detect_fail_rate | ${round3(baseFail)} | ${round3(skinFail)} | ${round3(skinFail - baseFail)} |`);
  lines.push('');
  lines.push('## Eval Artifacts');
  lines.push('');
  lines.push(`- off.md: \`${basePayload.artifacts && basePayload.artifacts.md ? basePayload.artifacts.md : ''}\``);
  lines.push(`- on.md: \`${skinmaskPayload.artifacts && skinmaskPayload.artifacts.md ? skinmaskPayload.artifacts.md : ''}\``);
  lines.push(`- off.csv: \`${basePayload.artifacts && basePayload.artifacts.csv ? basePayload.artifacts.csv : ''}\``);
  lines.push(`- on.csv: \`${skinmaskPayload.artifacts && skinmaskPayload.artifacts.csv ? skinmaskPayload.artifacts.csv : ''}\``);
  lines.push(`- off.jsonl: \`${basePayload.artifacts && basePayload.artifacts.jsonl ? basePayload.artifacts.jsonl : ''}\``);
  lines.push(`- on.jsonl: \`${skinmaskPayload.artifacts && skinmaskPayload.artifacts.jsonl ? skinmaskPayload.artifacts.jsonl : ''}\``);
  lines.push('');
  if (args.emit_debug_overlays) {
    lines.push('> DO NOT DISTRIBUTE debug overlay outputs.');
    lines.push('');
  }
  lines.push(`- report: \`${path.relative(process.cwd(), outPath).replace(/\\/g, '/')}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const reportDir = path.resolve(args.report_dir || 'reports');
  await fsp.mkdir(reportDir, { recursive: true });

  if (!args.onnx) {
    throw new Error('onnx_path_missing');
  }
  if (!fs.existsSync(path.resolve(args.onnx))) {
    throw new Error(`onnx_not_found:${args.onnx}`);
  }

  const basePayload = runEval({ args, skinmaskEnabled: false, repoRoot });
  const skinmaskPayload = runEval({ args, skinmaskEnabled: true, repoRoot });

  const baseCoverage = await coverageMeanFromJsonl(basePayload.artifacts.jsonl);
  const skinmaskCoverage = await coverageMeanFromJsonl(skinmaskPayload.artifacts.jsonl);

  const runKey = nowKey();
  const outPath = path.join(reportDir, `skinmask_ablation_${runKey}.md`);
  const report = renderReport({
    runKey,
    args,
    basePayload,
    skinmaskPayload,
    baseCoverage,
    skinmaskCoverage,
    outPath,
  });
  await fsp.writeFile(outPath, report, 'utf8');

  const payload = {
    ok: true,
    run_id: runKey,
    report: path.relative(repoRoot, outPath).replace(/\\/g, '/'),
    off: basePayload,
    on: skinmaskPayload,
    coverage_mean_off: round3(baseCoverage),
    coverage_mean_on: round3(skinmaskCoverage),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
