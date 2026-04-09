#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function parseArgs(argv) {
  const out = {
    command: '',
    cases: '',
    report: '',
    review: '',
    outDir: '',
    batchName: '',
    manualOverrides: 'scripts/fixtures/product_intel_manual_overrides.json',
    model: process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL || 'gemini-3-pro-preview',
    write: false,
    skipGemini: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (!out.command && !token.startsWith('--')) {
      out.command = token;
      continue;
    }
    if (token === '--cases' && next) {
      out.cases = next;
      i += 1;
    } else if (token === '--report' && next) {
      out.report = next;
      i += 1;
    } else if (token === '--review' && next) {
      out.review = next;
      i += 1;
    } else if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
    } else if (token === '--batch-name' && next) {
      out.batchName = next;
      i += 1;
    } else if (token === '--manual-overrides' && next) {
      out.manualOverrides = next;
      i += 1;
    } else if (token === '--model' && next) {
      out.model = next;
      i += 1;
    } else if (token === '--write') {
      out.write = true;
    } else if (token === '--skip-gemini') {
      out.skipGemini = true;
    }
  }

  if (!out.command) out.command = 'help';
  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function displayPath(rootDir, targetPath) {
  const absolute = resolvePath(rootDir, targetPath);
  const relative = path.relative(rootDir, absolute);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return relative || '.';
  }
  return absolute;
}

function runNodeScript(rootDir, scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`command_failed:${path.basename(scriptPath)}`);
  }
  return result.stdout ? JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop()) : null;
}

function summarizeReviewRows(reviewDoc) {
  const rows = Array.isArray(reviewDoc?.rows) ? reviewDoc.rows : [];
  const counts = {
    total: rows.length,
    pass: 0,
    rewrite: 0,
    pending: 0,
  };

  for (const row of rows) {
    const status = asString(row?.review_status).toLowerCase();
    if (status === 'pass') counts.pass += 1;
    else if (status === 'rewrite') counts.rewrite += 1;
    else counts.pending += 1;
  }

  return {
    counts,
    ready_to_publish: counts.total > 0 && counts.pass === counts.total,
    blocked_case_ids: rows
      .filter((row) => asString(row?.review_status).toLowerCase() !== 'pass')
      .map((row) => asString(row?.case_id))
      .filter(Boolean),
  };
}

function buildDefaultOutDir(rootDir, batchName) {
  const safeBatch = asString(batchName).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  const suffix = safeBatch || new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(rootDir, 'reports', 'pivota-insights', suffix);
}

function runPrepare(rootDir, args) {
  if (!args.cases) throw new Error('--cases is required for prepare');
  const outDir = resolvePath(rootDir, args.outDir || buildDefaultOutDir(rootDir, args.batchName));
  const workflowScript = path.join(rootDir, 'scripts', 'pivota_insights_review_workflow.js');
  const payload = runNodeScript(rootDir, workflowScript, [
    'init',
    '--cases',
    resolvePath(rootDir, args.cases),
    '--out-dir',
    outDir,
    '--manual-overrides',
    resolvePath(rootDir, args.manualOverrides),
    '--model',
    args.model,
    ...(args.skipGemini ? ['--skip-gemini'] : []),
  ]);
  const reviewDoc = JSON.parse(fs.readFileSync(payload.review_json, 'utf8'));
  const summary = summarizeReviewRows(reviewDoc);
  const result = {
    status: 'ok',
    command: 'prepare',
    out_dir: outDir,
    compare_json: payload.compare_json,
    review_json: payload.review_json,
    review_markdown: payload.review_markdown,
    model_requested: args.model,
    review_summary: summary,
    next_steps: [
      `Review ${displayPath(rootDir, payload.review_json)} and mark every row pass or rewrite.`,
      `Check status with: npm run pivota-insights:skill -- status --review ${displayPath(rootDir, payload.review_json)}`,
      `Publish only after all rows pass.`,
    ],
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function runStatus(rootDir, args) {
  if (!args.review) throw new Error('--review is required for status');
  const reviewPath = resolvePath(rootDir, args.review);
  const reviewDoc = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const summary = summarizeReviewRows(reviewDoc);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      command: 'status',
      review: reviewPath,
      review_summary: summary,
    })}\n`,
  );
}

function runPublish(rootDir, args) {
  if (!args.report) throw new Error('--report is required for publish');
  if (!args.review) throw new Error('--review is required for publish');
  const reviewPath = resolvePath(rootDir, args.review);
  const reviewDoc = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const summary = summarizeReviewRows(reviewDoc);
  if (!summary.ready_to_publish) {
    const err = new Error(`review_not_ready:${summary.blocked_case_ids.join(',')}`);
    err.code = 'REVIEW_NOT_READY';
    throw err;
  }
  const workflowScript = path.join(rootDir, 'scripts', 'pivota_insights_review_workflow.js');
  runNodeScript(rootDir, workflowScript, [
    'publish',
    '--report',
    resolvePath(rootDir, args.report),
    '--review',
    reviewPath,
    ...(args.write ? ['--write'] : []),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      command: 'publish',
      report: resolvePath(rootDir, args.report),
      review: reviewPath,
      write: Boolean(args.write),
    })}\n`,
  );
}

function runBakeoff(rootDir, args) {
  if (!args.cases) throw new Error('--cases is required for bakeoff');
  const bakeoffScript = path.join(rootDir, 'scripts', 'product_intel_model_bakeoff.js');
  const outDir = resolvePath(rootDir, args.outDir || buildDefaultOutDir(rootDir, args.batchName || 'bakeoff'));
  fs.mkdirSync(outDir, { recursive: true });
  const jsonOut = path.join(outDir, 'bakeoff.json');
  const markdownOut = path.join(outDir, 'bakeoff.md');
  runNodeScript(rootDir, bakeoffScript, [
    '--cases',
    resolvePath(rootDir, args.cases),
    '--manual-overrides',
    resolvePath(rootDir, args.manualOverrides),
    '--out',
    jsonOut,
    '--markdown',
    markdownOut,
  ]);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      command: 'bakeoff',
      out_dir: outDir,
      json: jsonOut,
      markdown: markdownOut,
    })}\n`,
  );
}

function printHelp() {
  process.stdout.write(
    [
      'Pivota Insights skill entrypoint',
      '',
      'Commands:',
      '  prepare --cases <cases.json> [--batch-name name] [--out-dir dir] [--model gemini-3-flash-preview|gemini-3-pro-preview|gemini-3.1-pro-preview]',
      '  status --review <review.json>',
      '  publish --report <compare.json> --review <review.json> [--write]',
      '  bakeoff --cases <cases.json> [--batch-name name] [--out-dir dir]',
      '',
      'Review gate:',
      '  publish is blocked unless every review row is marked pass.',
      '',
    ].join('\n'),
  );
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv);
  if (args.command === 'prepare') return runPrepare(rootDir, args);
  if (args.command === 'status') return runStatus(rootDir, args);
  if (args.command === 'publish') return runPublish(rootDir, args);
  if (args.command === 'bakeoff') return runBakeoff(rootDir, args);
  printHelp();
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildDefaultOutDir,
  parseArgs,
  summarizeReviewRows,
};
