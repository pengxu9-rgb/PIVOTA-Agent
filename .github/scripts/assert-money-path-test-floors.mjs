#!/usr/bin/env node
// CI guard: each money-path suite must keep at least its FLOOR of passing tests. This stops a red
// build being "fixed" by deleting tests. Raise a floor when you add coverage; never lower it to go green.
//
// Run from the repo root: node .github/scripts/assert-money-path-test-floors.mjs
// In CI, pass --report-dir <downloaded-artifacts-dir> so this guard depends on the already-run
// parallel jobs instead of re-running all suites serially.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Conservative floors (current counts are higher; these are the don't-go-below lines).
const FLOORS = {
  'safety-kernel': 316,
  'mcp-server': 82,
  'connectors': 15,
};

function usage() {
  console.error('Usage: node .github/scripts/assert-money-path-test-floors.mjs [--report-dir <dir>]');
}

function parseArgs(argv) {
  const args = { reportDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-dir') {
      args.reportDir = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      usage();
      process.exit(2);
    }
  }
  return args;
}

function parseTestSummary(out) {
  return {
    pass: Number((out.match(/^# pass (\d+)$/m) || out.match(/ℹ pass (\d+)/) || [])[1] || 0),
    fail: Number((out.match(/^# fail (\d+)$/m) || out.match(/ℹ fail (\d+)/) || [])[1] || 0),
  };
}

function collectFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function reportTextBySuite(reportDir) {
  if (!reportDir || !existsSync(reportDir) || !statSync(reportDir).isDirectory()) {
    throw new Error(`Report directory does not exist: ${reportDir || '(empty)'}`);
  }
  const bySuite = {};
  for (const filePath of collectFiles(reportDir)) {
    const fileName = filePath.split('/').pop() || '';
    for (const dir of Object.keys(FLOORS)) {
      if (fileName === `${dir}.tap` || fileName === `${dir}.txt` || fileName.startsWith(`${dir}.`)) {
        bySuite[dir] = readFileSync(filePath, 'utf8');
      }
    }
  }
  return bySuite;
}

function testOutputForSuite(dir) {
  try {
    return execFileSync('node', ['--test'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // node --test exits non-zero if any test fails; capture its output to report.
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

const { reportDir } = parseArgs(process.argv.slice(2));
const outputs = reportDir ? reportTextBySuite(reportDir) : {};
let failed = false;
for (const [dir, floor] of Object.entries(FLOORS)) {
  const out = reportDir ? outputs[dir] : testOutputForSuite(dir);
  if (!out) {
    console.error(`x ${dir}: missing test report`);
    failed = true;
    continue;
  }
  const { pass, fail } = parseTestSummary(out);
  if (fail > 0) {
    console.error(`x ${dir}: ${fail} FAILING test(s)`);
    failed = true;
  } else if (pass < floor) {
    console.error(`x ${dir}: ${pass} passing tests is BELOW the floor of ${floor} - tests deleted? raise coverage, don't lower the floor.`);
    failed = true;
  } else {
    console.log(`ok ${dir}: ${pass} passing (floor ${floor})`);
  }
}

if (failed) {
  console.error('\nMoney-path gate FAILED.');
  process.exit(1);
}
console.log('\nMoney-path gate passed.');
