// Guards the gate that runs every other `node --test` suite.
//
// Context, because it is the reason these assertions are worth their weight: for most of
// this repo's life, `*.node.test.cjs` files ran only if a human added them to one of two
// hand-maintained allowlists. On 2026-09-10 that had drifted to 135 of 295 files — 161
// suites had never executed in any CI job. Several of them were written specifically to
// stop a production defect recurring, and one of them (aurora_undefined_symbol_guard) is
// red on main right now over a live ReferenceError in src/server.js.
//
// scripts/run_node_test_suites.cjs replaced the allowlists with a glob plus a shrink-only
// quarantine. This file pins the two properties that make that safe:
//
//   1. discovery is a GLOB, not a list  — so a new suite is gated without anyone acting;
//   2. quarantine and the glob PARTITION the suites — so no file can fall between them.
//
// Property 1 is asserted against a scratch directory rather than tests/, because a
// discovery function called only on its own default path is indistinguishable from a
// hardcoded list. The scratch case is the control: it fails if discovery stops globbing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  discoverSuites,
  readQuarantine,
  SUITE_SUFFIX,
  TESTS_DIR,
  QUARANTINE_FILE,
} = require('../scripts/run_node_test_suites.cjs');

test('discovery is a glob: a suite nobody has heard of is found anyway', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-suite-glob-'));
  try {
    // A name that appears nowhere in this repo, so no allowlist could contain it.
    fs.writeFileSync(path.join(dir, `zzz_invented_${Date.now()}${SUITE_SUFFIX}`), '');
    fs.writeFileSync(path.join(dir, 'not_a_suite.js'), '');
    fs.writeFileSync(path.join(dir, 'also_not.test.js'), '');

    const found = discoverSuites(dir);

    assert.equal(found.length, 1, 'the invented suite should be discovered');
    assert.ok(found[0].endsWith(SUITE_SUFFIX));
    // The negative half matters as much: discovery must not sweep in jest's files, which
    // the sharded jest job already runs. Double-running them would be its own defect.
    assert.ok(!found.includes('not_a_suite.js'));
    assert.ok(!found.includes('also_not.test.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quarantine and the gated set partition every suite on disk', () => {
  const all = discoverSuites();
  const quarantined = readQuarantine();

  assert.ok(all.length > 0, 'expected to discover suites under tests/');

  const stale = [...quarantined].filter((f) => !all.includes(f));
  assert.deepEqual(
    stale,
    [],
    'quarantine names suite(s) that no longer exist — delete those lines',
  );

  const gated = all.filter((f) => !quarantined.has(f));
  assert.equal(
    gated.length + quarantined.size,
    all.length,
    'every discovered suite must be either gated or quarantined, never neither',
  );
});

test('quarantine entries are bare filenames, not paths or globs', () => {
  // A path or glob here would silently match nothing and quietly un-quarantine a red
  // suite, turning the gate red for a reason nobody could locate.
  for (const entry of readQuarantine()) {
    assert.ok(
      entry.endsWith(SUITE_SUFFIX),
      `quarantine entry ${JSON.stringify(entry)} should end in ${SUITE_SUFFIX}`,
    );
    assert.ok(
      !entry.includes('/') && !entry.includes('*'),
      `quarantine entry ${JSON.stringify(entry)} should be a bare filename`,
    );
  }
});

test('the quarantine file explains itself', () => {
  // A bare list of 40 filenames decays into folklore. The header carries the measurement
  // date, the commit, and the reason each suite is listed rather than deleted.
  const text = fs.readFileSync(QUARANTINE_FILE, 'utf8');
  assert.match(text, /THIS LIST MAY ONLY SHRINK/);
  assert.match(text, /\b[0-9a-f]{9,40}\b/, 'header should name the commit it was measured against');
});

test('tests/ is where suites live, and the gate looks there', () => {
  assert.equal(path.basename(TESTS_DIR), 'tests');
  assert.ok(fs.existsSync(TESTS_DIR));
});
