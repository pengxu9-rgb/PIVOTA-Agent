#!/usr/bin/env node
// Runs the `node --test` suites — the ones jest STRUCTURALLY cannot see.
//
// jest.config.js testMatch is `**/tests/**/*.test.(js|ts)`, so every `*.node.test.cjs`
// file is invisible to the sharded jest job. Until this script, the answer was two
// hand-maintained allowlists (the `test:node` npm script and a list inside
// pr-full-jest.yml). They had drifted to 135 of 295 files: 161 suites had never run in
// any CI job, including suites written specifically to stop a production defect from
// coming back. A test that never executes is not a weaker guard than no test — it is
// worse, because the PR that added it was reviewed as though a guard now existed.
//
// So discovery here is a GLOB, and the only list is a list of EXCLUSIONS that may only
// shrink. A suite added tomorrow is gated tomorrow, with nobody remembering anything.
//
// The ratchet: quarantined suites are executed too. If one PASSES, this script fails
// the run and tells you to delete its line. Quarantine is therefore self-emptying —
// a fixed suite cannot quietly remain excluded, which is how the old allowlists rotted.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const QUARANTINE_FILE = path.join(TESTS_DIR, 'node_suite_quarantine.txt');
const SUITE_SUFFIX = '.node.test.cjs';

// Matches the env the `test:node` script has always used. Kept here so the local
// command and the CI job cannot diverge — divergence is what produced a suite that
// was green on a laptop and had never run in CI.
const TEST_ENV = { ...process.env, AURORA_BFF_USE_MOCK: 'true' };

function readQuarantine(file = QUARANTINE_FILE) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

// `dir` is a parameter, not a constant, so a test can point discovery at a scratch
// directory and prove the glob actually globs. A discovery function that only ever
// reads one hardcoded path cannot be distinguished from a hardcoded list by any test
// that calls it, and "it is a glob" is the single claim this whole script rests on.
function discoverSuites(dir = TESTS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(SUITE_SUFFIX))
    .sort();
}

// One `node --test` invocation for the whole set. Returns the exit code.
function runSuites(files) {
  if (!files.length) return 0;
  const result = spawnSync(
    process.execPath,
    ['--test', ...files.map((f) => path.join('tests', f))],
    { cwd: ROOT, env: TEST_ENV, stdio: 'inherit' },
  );
  return result.status == null ? 1 : result.status;
}

// Per file, quietly — used only to ask whether a quarantined suite has started passing.
function suitePasses(file) {
  const result = spawnSync(process.execPath, ['--test', path.join('tests', file)], {
    cwd: ROOT,
    env: TEST_ENV,
    stdio: 'ignore',
    timeout: 180_000,
  });
  return result.status === 0;
}

function main() {
  const quarantined = readQuarantine();
  const all = discoverSuites();

  // A quarantine entry naming a file that no longer exists is stale. Fail loudly rather
  // than skipping it: a stale entry is how a list starts describing a repo it has drifted
  // from, and that drift is the defect this script exists to end.
  const missing = [...quarantined].filter((f) => !all.includes(f));
  if (missing.length) {
    console.error(
      `\n[node:test] quarantine names ${missing.length} suite(s) that do not exist:\n` +
        missing.map((f) => `  - ${f}`).join('\n') +
        `\nDelete these lines from tests/node_suite_quarantine.txt.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const gated = all.filter((f) => !quarantined.has(f));
  console.log(
    `[node:test] ${gated.length} gated suite(s), ${quarantined.size} quarantined ` +
      `(${all.length} discovered under tests/*${SUITE_SUFFIX}).`,
  );

  const gatedStatus = runSuites(gated);

  // The ratchet. Checked even when the gated run is already red, so one red suite never
  // hides the news that another has been fixed.
  const recovered = [...quarantined].sort().filter((f) => suitePasses(f));
  if (recovered.length) {
    console.error(
      `\n[node:test] ${recovered.length} quarantined suite(s) now PASS:\n` +
        recovered.map((f) => `  - ${f}`).join('\n') +
        `\nDelete those lines from tests/node_suite_quarantine.txt so the gate keeps them green.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.exitCode = gatedStatus;
}

if (require.main === module) main();

module.exports = {
  discoverSuites,
  readQuarantine,
  SUITE_SUFFIX,
  TESTS_DIR,
  QUARANTINE_FILE,
};
