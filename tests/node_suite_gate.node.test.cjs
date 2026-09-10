// Guards the gate that runs every other `node --test` suite.
//
// Context, because it is why these assertions earn their weight: for most of this repo's
// life a `node --test` suite ran only if a human added it to an allowlist. On 2026-09-10
// the one CI actually reads named 87 of 295 suites under tests/ (a second list, in the
// `test:node` npm script, is invoked by no workflow at all), so 208 had never executed.
//
// The first attempt to fix that replaced the allowlist with a glob — and dropped 24
// money-path suites, because the glob read `tests/` flat while the allowlist had also
// named 16 under mcp-server/test, 7 under safety-kernel/test, and one under
// tests/integration. The partition assertion in that version could not catch it: it
// ranged over what the glob had already found, which makes it arithmetic rather than a
// property of the code.
//
// So the two tests that matter here both range over something the code under test does
// NOT choose: an independent walk of the filesystem, and a recorded list of what the old
// allowlist ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  discoverSuites,
  readQuarantine,
  planRun,
  recoveryOutcome,
  SUITE_ROOTS,
  SUITE_SUFFIX,
  TESTS_DIR,
  QUARANTINE_FILE,
} = require('../scripts/run_node_test_suites.cjs');

const repoRoot = path.resolve(__dirname, '..');

test('nothing on disk escapes discovery — walked independently, repo-wide', () => {
  // Deliberately NOT discoverSuites' own walker, and deliberately NOT scoped by
  // SUITE_ROOTS. Both sides of the comparison must not come from the code under test: a
  // root the code forgot would be missing from both and the assertion would pass. That is
  // precisely how 24 suites were dropped unnoticed — and a first version of this very test
  // took its roots from SUITE_ROOTS and stayed green against that mutant.
  //
  // `.node.test.cjs` is a suffix unique to these suites, so a repo-wide search for it is
  // ground truth that no change to the runner can move.
  const out = execFileSync(
    'find',
    [repoRoot, '-name', '*.node.test.cjs', '-type', 'f', '-not', '-path', '*/node_modules/*'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const onDisk = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => path.relative(repoRoot, l))
    .filter((l) => !l.startsWith('..'));

  assert.ok(onDisk.length > 0, 'the independent walk found no suites — this test is inert');

  const discovered = new Set(discoverSuites());
  const missed = onDisk.filter((f) => !discovered.has(f)).sort();
  assert.deepEqual(missed, [], '.node.test.cjs suite(s) exist on disk that the gate cannot see');
});

test('the package test dirs are covered at their declared depth', () => {
  // mcp-server/ and safety-kernel/ use `*.test.js` in a `test/` (singular) directory —
  // a suffix jest also uses, so this half cannot be a repo-wide search. It is scoped, and
  // the guarantee that the ROOTS themselves are not silently dropped comes from the
  // recorded pre-glob allowlist in the next test, not from here.
  for (const spec of SUITE_ROOTS.filter((r) => r.dir !== 'tests')) {
    const abs = path.join(repoRoot, spec.dir);
    assert.ok(fs.existsSync(abs), `${spec.dir} should exist`);
    const args = [abs, '-maxdepth', '1', '-name', `*${spec.suffix}`, '-type', 'f'];
    const found = execFileSync('find', args, { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => path.relative(repoRoot, l));
    assert.ok(found.length > 0, `${spec.dir} should hold suites`);
    const discovered = new Set(discoverSuites());
    assert.deepEqual(found.filter((f) => !discovered.has(f)).sort(), []);
  }
});

test('every suite the pre-glob allowlist ran is still discovered', () => {
  // The regression that motivated this file. tests/fixtures/pre_glob_allowlist.txt is a
  // verbatim record of the 110 files the workflow's `node --test` invocation named at
  // 205e9f1cd. It is history and does not grow — new suites are the glob's job.
  const fixture = path.join(__dirname, 'fixtures', 'pre_glob_allowlist.txt');
  const want = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  assert.equal(want.length, 110, 'the recorded allowlist should still hold all 110 files');

  const discovered = new Set(discoverSuites());
  const dropped = want.filter((f) => !discovered.has(f)).sort();
  assert.deepEqual(dropped, [], 'suite(s) the old allowlist ran are no longer discovered');

  // Discovered is not enough: quarantining one of these would drop coverage CI already
  // had, just as silently as failing to glob it. All 110 are green, so the honest way to
  // remove one from the gate is to fix it, not to list it.
  const quarantined = readQuarantine();
  const excluded = want.filter((f) => quarantined.has(f)).sort();
  assert.deepEqual(excluded, [], 'suite(s) the old allowlist ran green are now quarantined');
});

test('discovery is a glob: a suite nobody has heard of is found anyway', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-suite-glob-'));
  try {
    fs.mkdirSync(path.join(dir, 'suites', 'nested'), { recursive: true });
    // A name that appears nowhere in this repo, so no allowlist could contain it.
    fs.writeFileSync(path.join(dir, 'suites', `zzz_invented_${Date.now()}${SUITE_SUFFIX}`), '');
    fs.writeFileSync(path.join(dir, 'suites', 'nested', `zzz_deep${SUITE_SUFFIX}`), '');
    fs.writeFileSync(path.join(dir, 'suites', 'not_a_suite.js'), '');
    fs.writeFileSync(path.join(dir, 'suites', 'also_not.test.js'), '');

    const found = discoverSuites([{ dir: 'suites', suffix: SUITE_SUFFIX, recursive: true }], dir);

    assert.equal(found.length, 2, 'both invented suites should be discovered');
    // The nested one is the half a flat readdir misses — the shape of the dropped-24 bug.
    assert.ok(found.some((f) => f.includes('nested/')), 'recursive discovery must reach nested dirs');
    // The negative half matters as much: discovery must not sweep in jest's files, which
    // the sharded jest job already runs. Double-running them would be its own defect.
    assert.ok(!found.some((f) => f.endsWith('not_a_suite.js')));
    assert.ok(!found.some((f) => f.endsWith('also_not.test.js')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planRun splits suites into gated and stale', () => {
  const plan = planRun(['tests/a.node.test.cjs', 'tests/b.node.test.cjs'], new Set(['tests/b.node.test.cjs']));
  assert.deepEqual(plan.gated, ['tests/a.node.test.cjs']);
  assert.deepEqual(plan.stale, []);

  // A quarantine entry naming a file that no longer exists is stale, and the runner halts
  // on it rather than skipping: a list that has drifted from the repo it describes is how
  // the allowlists rotted.
  const drifted = planRun(['tests/a.node.test.cjs'], new Set(['tests/gone.node.test.cjs']));
  assert.deepEqual(drifted.stale, ['tests/gone.node.test.cjs']);
});

test('the recovery ratchet fails CI, and only CI, when a quarantined suite passes', () => {
  // The mechanism the whole design rests on — "quarantine is self-emptying". Untested in
  // the first version of this script.
  assert.deepEqual(recoveryOutcome(['tests/x.node.test.cjs'], true), { exitCode: 1, enforced: true });
  assert.deepEqual(recoveryOutcome(['tests/x.node.test.cjs'], false), { exitCode: 0, enforced: false });
  assert.deepEqual(recoveryOutcome([], true), { exitCode: 0, enforced: false });
});

test('quarantine and the gated set partition every discovered suite', () => {
  const all = discoverSuites();
  const quarantined = readQuarantine();
  const { stale, gated } = planRun(all, quarantined);

  assert.deepEqual(stale, [], 'quarantine names suite(s) that no longer exist — delete those lines');
  assert.equal(gated.length + quarantined.size, all.length);
});

test('quarantine entries are repo-relative paths under a known suite root', () => {
  // Bare filenames would be ambiguous: two roots can hold the same basename, and one
  // entry would then silence both.
  const roots = SUITE_ROOTS.map((r) => `${r.dir}/`);
  for (const entry of readQuarantine()) {
    assert.ok(!entry.includes('*'), `quarantine entry ${JSON.stringify(entry)} should not be a glob`);
    assert.ok(
      roots.some((r) => entry.startsWith(r)),
      `quarantine entry ${JSON.stringify(entry)} is not under a known suite root`,
    );
  }
});

test('the quarantine file explains itself', () => {
  const text = fs.readFileSync(QUARANTINE_FILE, 'utf8');
  assert.match(text, /THIS LIST MAY ONLY SHRINK/);
  assert.match(text, /\b[0-9a-f]{9,40}\b/, 'header should name the commit it was measured against');
});

test('tests/ is where suites live, and the gate looks there', () => {
  assert.equal(path.basename(TESTS_DIR), 'tests');
  assert.ok(fs.existsSync(TESTS_DIR));
});
