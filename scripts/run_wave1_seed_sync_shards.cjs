#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output', 'live-smoke');
const DEFAULT_PREFIX = `wave1-seed-sync-${new Date().toISOString().slice(0, 10)}`;
const DEFAULT_TIMEOUT_MS = Math.max(5_000, Number.parseInt(process.env.WAVE1_SHARD_TIMEOUT_MS, 10) || 20_000);

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const out = {
    wave: 'kb_reviewed',
    limit: 100,
    startOffset: 0,
    endOffset: 0,
    step: 100,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    apply: false,
    resume: false,
    prefix: DEFAULT_PREFIX,
    outDir: DEFAULT_OUTPUT_ROOT,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = normalizeNonEmptyString(argv[idx]);
    if (token === '--wave') {
      out.wave = normalizeNonEmptyString(argv[idx + 1]) || out.wave;
      idx += 1;
    } else if (token === '--limit') {
      out.limit = Math.max(1, Number.parseInt(argv[idx + 1], 10) || out.limit);
      idx += 1;
    } else if (token === '--start-offset') {
      out.startOffset = Math.max(0, Number.parseInt(argv[idx + 1], 10) || 0);
      idx += 1;
    } else if (token === '--end-offset') {
      out.endOffset = Math.max(0, Number.parseInt(argv[idx + 1], 10) || 0);
      idx += 1;
    } else if (token === '--step') {
      out.step = Math.max(1, Number.parseInt(argv[idx + 1], 10) || out.step);
      idx += 1;
    } else if (token === '--timeout-ms') {
      out.timeoutMs = Math.max(1_000, Number.parseInt(argv[idx + 1], 10) || out.timeoutMs);
      idx += 1;
    } else if (token === '--apply') {
      out.apply = true;
    } else if (token === '--resume') {
      out.resume = true;
    } else if (token === '--prefix') {
      out.prefix = normalizeNonEmptyString(argv[idx + 1]) || out.prefix;
      idx += 1;
    } else if (token === '--out-dir') {
      out.outDir = normalizeNonEmptyString(argv[idx + 1]) || out.outDir;
      idx += 1;
    }
  }
  if (out.endOffset < out.startOffset) out.endOffset = out.startOffset;
  return out;
}

function resolvePathMaybeRelative(targetPath) {
  if (!targetPath) return '';
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

function buildOffsets(args) {
  const offsets = [];
  for (let offset = args.startOffset; offset <= args.endOffset; offset += args.step) {
    offsets.push(offset);
  }
  if (offsets.length === 0) offsets.push(args.startOffset);
  return offsets;
}

function readJsonSafe(targetPath) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

function shardFilePath(outDir, prefix, offset) {
  return path.join(outDir, `${prefix}-offset-${offset}.json`);
}

function runShard(args, offset, outDir) {
  const outPath = shardFilePath(outDir, args.prefix, offset);
  if (args.resume && fs.existsSync(outPath)) {
    return {
      offset,
      out_path: outPath,
      resumed: true,
      ok: true,
      data: readJsonSafe(outPath),
    };
  }
  const childArgs = [
    path.join(process.cwd(), 'scripts', 'sync-external-seed-ingredient-fields.cjs'),
    '--wave', args.wave,
    '--limit', String(args.limit),
    '--offset', String(offset),
    '--out', outPath,
  ];
  if (args.apply) childArgs.push('--apply');
  else childArgs.push('--dry-run');

  const result = {
    offset,
    out_path: outPath,
    resumed: false,
    ok: true,
    error: null,
    data: null,
  };

  try {
    execFileSync(process.execPath, childArgs, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: args.timeoutMs,
    });
  } catch (error) {
    result.ok = false;
    result.error = {
      message: normalizeNonEmptyString(error?.message) || 'script_failed',
      stderr: normalizeNonEmptyString(error?.stderr),
      stdout: normalizeNonEmptyString(error?.stdout),
      status: Number.isFinite(error?.status) ? error.status : null,
    };
  }
  result.data = readJsonSafe(outPath);
  return result;
}

function addCounter(counter, key, amount = 1) {
  const normalized = normalizeNonEmptyString(key || 'none') || 'none';
  counter[normalized] = Number(counter[normalized] || 0) + amount;
}

function summarize(shards) {
  const summary = {
    shards: Array.isArray(shards) ? shards.length : 0,
    ok_shards: 0,
    failed_shards: 0,
    resumed_shards: 0,
    scanned: 0,
    changed: 0,
    updated: 0,
    eligible_for_wave_apply: 0,
    skipped_guardrail: 0,
    quarantine_reason: {},
    seed_quarantine_bucket: {},
    contamination_signal_source: {},
    seed_kb_sync_status: {},
  };
  for (const shard of Array.isArray(shards) ? shards : []) {
    if (shard?.ok) summary.ok_shards += 1;
    else summary.failed_shards += 1;
    if (shard?.resumed) summary.resumed_shards += 1;
    const shardSummary = shard?.data?.summary || {};
    summary.scanned += Number(shardSummary.scanned || 0);
    summary.changed += Number(shardSummary.changed || 0);
    summary.updated += Number(shardSummary.updated || 0);
    summary.eligible_for_wave_apply += Number(shardSummary.eligible_for_wave_apply || 0);
    summary.skipped_guardrail += Number(shardSummary.skipped_guardrail || 0);
    for (const [key, value] of Object.entries(shardSummary.quarantine_reason || {})) {
      addCounter(summary.quarantine_reason, key, Number(value || 0));
    }
    for (const [key, value] of Object.entries(shardSummary.seed_quarantine_bucket || {})) {
      addCounter(summary.seed_quarantine_bucket, key, Number(value || 0));
    }
    for (const [key, value] of Object.entries(shardSummary.contamination_signal_source || {})) {
      addCounter(summary.contamination_signal_source, key, Number(value || 0));
    }
    for (const [key, value] of Object.entries(shardSummary.seed_kb_sync_status || {})) {
      addCounter(summary.seed_kb_sync_status, key, Number(value || 0));
    }
  }
  return summary;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolvePathMaybeRelative(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const offsets = buildOffsets(args);
  const shards = offsets.map((offset) => runShard(args, offset, outDir));
  const bundle = {
    generated_at: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry_run',
    wave: args.wave,
    limit: args.limit,
    timeout_ms: args.timeoutMs,
    start_offset: args.startOffset,
    end_offset: args.endOffset,
    step: args.step,
    prefix: args.prefix,
    out_dir: outDir,
    summary: summarize(shards),
    shards,
  };
  const bundlePath = path.join(outDir, `${args.prefix}-bundle.json`);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  fs.writeFileSync(bundlePath, serialized, 'utf8');
  process.stdout.write(serialized);
}

if (require.main === module) {
  main();
}

module.exports = {
  _internals: {
    parseArgs,
    buildOffsets,
    summarize,
  },
};
