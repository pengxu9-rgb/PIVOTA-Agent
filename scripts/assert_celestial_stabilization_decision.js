#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    reportRoot: '',
    summaryPath: '',
    failOn: 'no-go',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report-root') {
      args.reportRoot = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--summary') {
      args.summaryPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--fail-on') {
      args.failOn = String(argv[index + 1] || 'no-go').trim().toLowerCase();
      index += 1;
    }
  }
  return args;
}

function resolveLatestSummary(reportRoot) {
  const directories = fs
    .readdirSync(reportRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const candidate = path.join(reportRoot, directories[index], 'summary.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function shouldFail(decision, failOn) {
  const normalized = String(decision || '').trim().toUpperCase();
  if (failOn === 'none') {
    return false;
  }
  if (failOn === 'hold') {
    return normalized !== 'GO';
  }
  return normalized === 'NO-GO';
}

const args = parseArgs(process.argv);
const reportRoot = args.reportRoot || path.join(process.cwd(), 'reports', 'celestial-commerce-core-staging-stabilization-ci');
const summaryPath = args.summaryPath || resolveLatestSummary(reportRoot);

if (!summaryPath || !fs.existsSync(summaryPath)) {
  console.error(`Unable to locate stabilization summary under ${reportRoot}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const decision = String(summary?.decision?.decision || summary?.decision?.label || '').trim().toUpperCase();
const payload = {
  ok: !shouldFail(decision, args.failOn),
  fail_on: args.failOn,
  summary_path: summaryPath,
  decision,
  next_action: summary?.decision?.next_action || '',
  blocking_failures: Array.isArray(summary?.decision?.blocking_failures)
    ? summary.decision.blocking_failures
    : [],
};

if (shouldFail(decision, args.failOn)) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
