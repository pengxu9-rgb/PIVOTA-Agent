#!/usr/bin/env node
// Runs the `node --test` suites — the ones jest STRUCTURALLY cannot see.
//
// jest.config.js testMatch is `**/tests/**/*.test.(js|ts)`, so every `*.node.test.cjs`
// file is invisible to the sharded jest job. Until this script, the answer was two
// hand-maintained allowlists. The one inside pr-full-jest.yml named 87 of 295 files; the
// one in the `test:node` npm script named 66 more, but no workflow invokes that script,
// so those never ran either. 208 suites had never run in any CI job, including suites
// written specifically to stop a production defect from coming back. A test that never
// executes is not a weaker guard than no test — it is worse, because the PR that added
// it was reviewed as though a guard now existed.
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

// WHERE SUITES LIVE. Three roots, because this repo keeps `node --test` suites in three
// shapes and an earlier version of this script globbed only the first — silently dropping
// 23 money-path suites under mcp-server/ and safety-kernel/ that the allowlist it replaced
// had been running, plus everything nested under tests/. A glob is only an improvement
// over an allowlist if it covers what the allowlist covered.
//
// `tests` is walked RECURSIVELY: tests/integration, tests/scripts and tests/services all
// hold suites, and a flat readdir cannot see them.
const SUITE_ROOTS = Object.freeze([
  { dir: 'tests', suffix: SUITE_SUFFIX, recursive: true },
  // ESM packages with their own package.json. Directory is `test`, singular — which is
  // also why jest's `**/tests/**` testMatch cannot see them either.
  { dir: 'mcp-server/test', suffix: '.test.js', recursive: false },
  { dir: 'safety-kernel/test', suffix: '.test.js', recursive: false },
]);

// The suites run with the env they inherit. An earlier version of this script forced
// AURORA_BFF_USE_MOCK=true across every suite, copying what the `test:node` npm script
// did — and that flag is not inert: it swaps auroraChat for a mock
// (src/auroraBff/auroraDecisionClient.js), so it BROKE
// tests/aurora_decision_client_upstream_path, whose whole subject is the real upstream
// POST. That suite is green on main and was quarantined for a failure this runner
// manufactured, which the recovery ratchet could never have released because the ratchet
// re-runs with the same forced env.
//
// The CI job this replaces set no such flag over its 110 suites, so inheriting is also
// the faithful choice. A suite that needs the mock sets it for itself.
const TEST_ENV = { ...process.env };

// Generous: the observed gated batch is ~2.5 minutes. This exists so a hang fails with a
// signal rather than eating the workflow's own timeout with no output.
const GATED_BATCH_TIMEOUT_MS = 20 * 60 * 1000;

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

function walk(absDir, suffix, recursive, out, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (recursive && entry.name !== 'node_modules') {
        walk(path.join(absDir, entry.name), suffix, recursive, out, rel);
      }
    } else if (entry.name.endsWith(suffix)) {
      out.push(rel);
    }
  }
  return out;
}

// `roots` is a parameter, not a constant, so a test can point discovery at a scratch
// directory and prove the glob actually globs. A discovery function that only ever
// reads its own hardcoded paths cannot be distinguished from a hardcoded list by any
// test that calls it, and "it is a glob" is the single claim this whole script rests on.
//
// Returns repo-relative paths (e.g. `tests/foo.node.test.cjs`,
// `mcp-server/test/bar.test.js`), NOT bare filenames: two roots can hold the same
// basename, and a bare name would make one quarantine entry silence both.
function discoverSuites(roots = SUITE_ROOTS, root = ROOT) {
  const found = [];
  for (const spec of roots) {
    walk(path.join(root, spec.dir), spec.suffix, spec.recursive, found, spec.dir);
  }
  return found.sort();
}

// One `node --test` invocation for the whole set. Returns the exit code.
function runSuites(files) {
  if (!files.length) return 0;
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: ROOT,
    env: TEST_ENV,
    stdio: 'inherit',
    // A hung gated suite should not silently consume the whole job budget.
    timeout: GATED_BATCH_TIMEOUT_MS,
  });
  return result.status == null ? 1 : result.status;
}

// Per file, quietly — used only to ask whether a quarantined suite has started passing.
function suitePasses(file) {
  const result = spawnSync(process.execPath, ['--test', file], {
    cwd: ROOT,
    env: TEST_ENV,
    stdio: 'ignore',
    timeout: 180_000,
  });
  return result.status === 0;
}

// The run's decisions, as data. Pulled out of main() so they can be tested: the recovery
// ratchet is the mechanism this whole script rests on ("quarantine is self-emptying"), and
// in its first version that argument was carried entirely by untested code.
function planRun(all, quarantined) {
  const stale = [...quarantined].filter((f) => !all.includes(f)).sort();
  const gated = all.filter((f) => !quarantined.has(f));
  return { stale, gated };
}

// Exit 1 ONLY under CI. A quarantined suite that passes locally is a finding worth
// printing and not worth failing on: at least one suite passes on a laptop and fails on a
// runner, and failing developers for disagreeing with CI trains people to ignore the
// message. CI can still never let a fixed suite stay quarantined.
function recoveryOutcome(recovered, inCi) {
  if (!recovered.length) return { exitCode: 0, enforced: false };
  return { exitCode: inCi ? 1 : 0, enforced: Boolean(inCi) };
}

function main() {
  const quarantined = readQuarantine();
  const all = discoverSuites();

  // A quarantine entry naming a file that no longer exists is stale. Fail loudly rather
  // than skipping it: a stale entry is how a list starts describing a repo it has drifted
  // from, and that drift is the defect this script exists to end.
  const { stale: missing, gated } = planRun(all, quarantined);
  if (missing.length) {
    console.error(
      `\n[node:test] quarantine names ${missing.length} suite(s) that do not exist:\n` +
        missing.map((f) => `  - ${f}`).join('\n') +
        `\nDelete these lines from tests/node_suite_quarantine.txt.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[node:test] ${gated.length} gated suite(s), ${quarantined.size} quarantined ` +
      `(${all.length} discovered under ${SUITE_ROOTS.map((r) => r.dir).join(', ')}).`,
  );

  const gatedStatus = runSuites(gated);

  // The ratchet. Checked even when the gated run is already red, so one red suite never
  // hides the news that another has been fixed.
  //
  // ENFORCED ONLY IN CI, and the reason is a real case rather than caution: at least one
  // quarantined suite passes on a developer machine and fails on a runner
  // (find_products_beauty_discovery_local_mainline — an event-loop race, not a flag or a
  // credential). CI is the authority on whether a suite is green, so failing a dev box
  // for disagreeing with a runner would train people to ignore this message. Locally the
  // finding is still printed, because "this might be fixable now" is worth reading.
  const recovered = [...quarantined].sort().filter((f) => suitePasses(f));
  if (recovered.length) {
    // `CI=false` is not CI. GitHub sets the literal string "true".
    const inCi = String(process.env.CI || '').toLowerCase() === 'true';
    const outcome = recoveryOutcome(recovered, inCi);
    console.error(
      `\n[node:test] ${recovered.length} quarantined suite(s) PASS here:\n` +
        recovered.map((f) => `  - ${f}`).join('\n') +
        (inCi
          ? `\nDelete those lines from tests/node_suite_quarantine.txt so the gate keeps them green.\n`
          : `\nIf CI agrees, delete those lines from tests/node_suite_quarantine.txt.` +
            ` Not failing locally: only CI decides this.\n`),
    );
    if (outcome.enforced) {
      process.exitCode = outcome.exitCode;
      return;
    }
  }

  process.exitCode = gatedStatus;
}

if (require.main === module) main();

module.exports = {
  discoverSuites,
  readQuarantine,
  planRun,
  recoveryOutcome,
  SUITE_ROOTS,
  SUITE_SUFFIX,
  TESTS_DIR,
  QUARANTINE_FILE,
};
