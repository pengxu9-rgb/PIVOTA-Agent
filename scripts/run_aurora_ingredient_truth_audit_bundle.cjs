#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_BASE_URL = process.env.AURORA_AUDIT_BASE_URL || 'https://pivota-agent-production.up.railway.app';
const DEFAULT_MATRIX_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.AURORA_AUDIT_TIMEOUT_MS, 10) || 25_000,
);
const DEFAULT_ROUTINE_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.AURORA_ROUTINE_AUDIT_TIMEOUT_MS, 10) || 60_000,
);
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output', 'live-smoke');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    matrixTimeoutMs: DEFAULT_MATRIX_TIMEOUT_MS,
    routineTimeoutMs: DEFAULT_ROUTINE_TIMEOUT_MS,
    sampleLimit: 25,
    prefix: `aurora-ingredient-truth-bundle-${new Date().toISOString().slice(0, 10)}`,
    outDir: DEFAULT_OUTPUT_ROOT,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = normalizeNonEmptyString(argv[idx]);
    if (token === '--base-url') {
      out.baseUrl = normalizeNonEmptyString(argv[idx + 1]) || DEFAULT_BASE_URL;
      idx += 1;
    } else if (token === '--matrix-timeout-ms') {
      out.matrixTimeoutMs = Math.max(5_000, Number.parseInt(argv[idx + 1], 10) || DEFAULT_MATRIX_TIMEOUT_MS);
      idx += 1;
    } else if (token === '--routine-timeout-ms') {
      out.routineTimeoutMs = Math.max(10_000, Number.parseInt(argv[idx + 1], 10) || DEFAULT_ROUTINE_TIMEOUT_MS);
      idx += 1;
    } else if (token === '--sample-limit') {
      out.sampleLimit = Math.max(1, Number.parseInt(argv[idx + 1], 10) || 25);
      idx += 1;
    } else if (token === '--prefix') {
      out.prefix = normalizeNonEmptyString(argv[idx + 1]) || out.prefix;
      idx += 1;
    } else if (token === '--out-dir') {
      out.outDir = normalizeNonEmptyString(argv[idx + 1]) || out.outDir;
      idx += 1;
    }
  }
  return out;
}

function resolvePathMaybeRelative(targetPath) {
  if (!targetPath) return '';
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

function readJsonSafe(targetPath) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = {
    ok: true,
    script: path.basename(scriptPath),
    args,
    output_path: options.outputPath || null,
    error: null,
  };
  try {
    execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
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
  if (options.outputPath) result.data = readJsonSafe(options.outputPath);
  return result;
}

function rowsFromResult(result) {
  return Array.isArray(result?.data?.rows) ? result.data.rows : [];
}

function countRowsByBucket(rows, bucketSet) {
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const bucket = normalizeNonEmptyString(row?.root_cause_bucket);
    if (bucketSet.has(bucket)) count += 1;
  }
  return count;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolvePathMaybeRelative(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const scriptsDir = path.join(process.cwd(), 'scripts');
  const canonicalPath = path.join(outDir, `${args.prefix}-canonical.json`);
  const noncanonicalPath = path.join(outDir, `${args.prefix}-noncanonical.json`);
  const backlogPath = path.join(outDir, `${args.prefix}-backlog.json`);
  const censusPath = path.join(outDir, `${args.prefix}-seed-census.json`);
  const routinePath = path.join(outDir, `${args.prefix}-routine-smoke.json`);
  const misrankPath = path.join(outDir, `${args.prefix}-misrank.json`);
  const bundlePath = path.join(outDir, `${args.prefix}-bundle.json`);

  const results = {
    canonical: runNodeScript(
      path.join(scriptsDir, 'audit_aurora_ingredient_root_cause_matrix.cjs'),
      [
        '--base-url', args.baseUrl,
        '--timeout-ms', String(args.matrixTimeoutMs),
        '--start-index', '0',
        '--count', '12',
        '--out', canonicalPath,
      ],
      { outputPath: canonicalPath },
    ),
    noncanonical: runNodeScript(
      path.join(scriptsDir, 'audit_aurora_ingredient_root_cause_matrix.cjs'),
      [
        '--base-url', args.baseUrl,
        '--timeout-ms', String(args.matrixTimeoutMs),
        '--start-index', '12',
        '--count', '4',
        '--out', noncanonicalPath,
      ],
      { outputPath: noncanonicalPath },
    ),
    backlog: runNodeScript(
      path.join(scriptsDir, 'audit_aurora_ingredient_root_cause_matrix.cjs'),
      [
        '--base-url', args.baseUrl,
        '--timeout-ms', String(args.matrixTimeoutMs),
        '--start-index', '16',
        '--count', '4',
        '--out', backlogPath,
      ],
      { outputPath: backlogPath },
    ),
    seed_census: runNodeScript(
      path.join(scriptsDir, 'audit_external_seed_blank_field_census.cjs'),
      [
        '--sample-limit', String(args.sampleLimit),
        '--out', censusPath,
      ],
      { outputPath: censusPath },
    ),
    routine_truth_smoke: runNodeScript(
      path.join(scriptsDir, 'audit_aurora_routine_truth_smoke.cjs'),
      [
        '--base-url', args.baseUrl,
        '--timeout-ms', String(args.routineTimeoutMs),
        '--out', routinePath,
      ],
      { outputPath: routinePath },
    ),
    misrank_backlog: runNodeScript(
      path.join(scriptsDir, 'build_aurora_ingredient_misrank_backlog.cjs'),
      [
        '--input', canonicalPath,
        '--input', noncanonicalPath,
        '--input', backlogPath,
        '--out', misrankPath,
      ],
      { outputPath: misrankPath },
    ),
  };

  const canonicalRows = rowsFromResult(results.canonical);
  const noncanonicalRows = rowsFromResult(results.noncanonical);
  const backlogRows = rowsFromResult(results.backlog);
  const allRows = [...canonicalRows, ...noncanonicalRows, ...backlogRows];
  const codeLaneBuckets = new Set(['explicit_supply_present_but_filtered']);
  const dataLaneBuckets = new Set(['only_family_supply_present', 'no_explicit_supply_in_any_source', 'registry_not_resolved']);
  const misrankLaneBuckets = new Set(['explicit_supply_present_but_misranked']);

  const bundle = {
    generated_at: new Date().toISOString(),
    base_url: args.baseUrl,
    matrix_timeout_ms: args.matrixTimeoutMs,
    routine_timeout_ms: args.routineTimeoutMs,
    sample_limit: args.sampleLimit,
    prefix: args.prefix,
    out_dir: outDir,
    results,
    summary: {
      canonical_bucket_counts: results.canonical.data?.bucket_counts || {},
      noncanonical_bucket_counts: results.noncanonical.data?.bucket_counts || {},
      backlog_bucket_counts: results.backlog.data?.bucket_counts || {},
      code_lane_count: countRowsByBucket(allRows, codeLaneBuckets),
      data_lane_count: countRowsByBucket(allRows, dataLaneBuckets),
      misrank_lane_count:
        Number(results.misrank_backlog.data?.summary?.candidate_count || 0) ||
        countRowsByBucket(allRows, misrankLaneBuckets),
      contaminated_attached_slice_count:
        Number(results.seed_census.data?.summary?.contaminated_attached_slice_count || 0),
      seed_census_summary: results.seed_census.data?.summary || {},
      routine_rows: Array.isArray(results.routine_truth_smoke.data?.rows)
        ? results.routine_truth_smoke.data.rows
        : [],
    },
  };

  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  fs.writeFileSync(bundlePath, serialized, 'utf8');
  process.stdout.write(serialized);
}

main();
