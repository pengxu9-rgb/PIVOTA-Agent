'use strict';

// THE TWO TAXONOMY LEAF SETS HAD DIVERGED, AND THE GAP WAS LOAD-BEARING.
//
// `has_category_door()` in pivota-backend is derived entirely from its `TAXONOMY_LEAVES`. This repo
// had no equivalent, so anything here wanting to ask "can recall reach this path" had to re-derive
// it from `CANONICAL_CATEGORY_PATHS` — a different, much smaller set:
//
//     CANONICAL_CATEGORY_PATHS (here)   25 leaves   roots: beauty
//     TAXONOMY_LEAVES (pivota-backend)  72 leaves   roots: beauty 42, fashion 25, electronics 5
//
// Measured over all 217 distinct category_path values in production: the backend rule calls 76
// serving rows doorless, the local-set rule would call 190 — disagreeing on 40 paths / 114 serving
// rows, EVERY ONE of them in the same direction (local says no-door where production says door).
// A writer-side door check built on the local set would have been a beauty-only gate wearing a door
// check's name.
//
// This suite pins the vendored copy to production's answers so it cannot drift back.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TAXONOMY_LEAVES,
  LEAF_PARENTS,
  ANCESTOR_NODES,
  TAXONOMY_ROOTS,
  CANONICAL_CATEGORY_PATHS,
  categoryPathHasDoor,
  categoryPathIsCategorised,
  canonicalTargetsWithoutADoor,
} = require('../src/services/beautyTaxonomy');
const VENDORED = require('../src/services/recallTaxonomyLeaves');
const VERDICTS = require('./fixtures/recall_category_door_verdicts.json');
const LEAVES_FIXTURE = require('./fixtures/recall_taxonomy_leaves.json');
const GOLDEN = require('./fixtures/recall_browse_prefix_golden.json');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveBeautyCategoryPathPrefixForQuery } = require('../src/services/externalSeedProducts');

// ---------------------------------------------------------------------------
// 1. The vendored copy is the backend's set, and says so in numbers.
// ---------------------------------------------------------------------------

test('the vendored leaf set matches production BY MEMBERSHIP, not by count', () => {
  // A COUNT IS NOT A PIN. The first version of this test checked `length === 72` plus sortedness
  // plus the path regex — and a fabricated leaf (`fashion/accessories/hat` -> `fashion/accessories/
  // fedora-bogus`) satisfies all three, changes no door verdict for any of the 217 production
  // paths, and sailed through the whole suite. The mirror has to be pinned to the thing it mirrors.
  assert.deepEqual(TAXONOMY_LEAVES, LEAVES_FIXTURE.leaves, 'the vendored leaf set drifted from pivota-backend');
  assert.deepEqual([...LEAF_PARENTS].sort(), LEAVES_FIXTURE.leaf_parents, 'LEAF_PARENTS drifted');
  // ANCESTOR_NODES is pinned exactly because the `range(1, len(parts))` boundary is invisible in
  // behaviour: deriving ancestors with `parts.map` instead of `parts.slice(1).map` grows this from
  // 27 entries to 99 while leaving categoryPathHasDoor bit-identical (a leaf always startsWith its
  // own parent). The next consumer asking "is this a branch node?" would then diverge silently.
  assert.deepEqual([...ANCESTOR_NODES].sort(), LEAVES_FIXTURE.ancestor_nodes, 'ANCESTOR_NODES drifted');
  assert.equal(ANCESTOR_NODES.length, 27);
  assert.equal(TAXONOMY_LEAVES.length, VERDICTS.leaf_count, 'leaf COUNT drifted from the captured backend set');
  assert.equal(TAXONOMY_LEAVES.length, 72);
  assert.deepEqual([...TAXONOMY_ROOTS].sort(), ['beauty', 'electronics', 'fashion']);
  // Every entry is a real multi-segment path, sorted, unique — a hand-edit that breaks any of these
  // is far more likely than a deliberate taxonomy change.
  assert.deepEqual(TAXONOMY_LEAVES, [...TAXONOMY_LEAVES].sort(), 'leaves must stay sorted');
  assert.equal(new Set(TAXONOMY_LEAVES).size, TAXONOMY_LEAVES.length, 'duplicate leaf');
  for (const leaf of TAXONOMY_LEAVES) {
    assert.match(leaf, /^[a-z0-9-]+(\/[a-z0-9-]+)+$/, `${leaf} is not a normalised multi-segment path`);
  }
  assert.equal(VENDORED.TAXONOMY_LEAVES, TAXONOMY_LEAVES, 'beautyTaxonomy must re-export the vendored array itself');
});

test('EVERY TOP-LEVEL DOMAIN IS AN ANCESTOR NODE — the fact that started all of this', () => {
  // `range(1, len(parts))` on the backend side includes i == 1, so a bare domain has a door while
  // resolving to nothing. Pinned because it is deeply counter-intuitive and is the reason the
  // bare-domain cohort passed every off-taxonomy health check.
  for (const root of TAXONOMY_ROOTS) {
    assert.ok(ANCESTOR_NODES.includes(root), `${root} must be an ancestor node`);
    assert.equal(categoryPathHasDoor(root), true, `${root} must have a door`);
    assert.equal(categoryPathIsCategorised(root), false, `${root} must NOT count as categorised`);
  }
});

// ---------------------------------------------------------------------------
// 2. Cross-language agreement, against production's own answers.
// ---------------------------------------------------------------------------

test('categoryPathHasDoor agrees with pivota-backend on every path in production', () => {
  // The fixture is `has_category_door()` run over all 217 distinct `category_path` values in the
  // prod catalog on 2026-09-11, plus edge cases. This is the assertion that makes the vendored copy
  // worth having: a stale copy shows up HERE, as a disagreement with production, not as a silent
  // difference in what a writer skips.
  const disagreements = [];
  let servingAffected = 0;
  for (const row of VERDICTS.prod_paths) {
    // NOT `.trim()`. This suite has a test three below asserting the rule must not trim, and
    // trimming here would both defeat that and FALSIFY it: a regenerated fixture containing one
    // padded production path (`'beauty/makeup '`, whose honest Python answer is false) made this
    // assertion report a drift that does not exist, blamed on the leaf set.
    const got = categoryPathHasDoor(row.path);
    if (got !== row.door) {
      disagreements.push(`${row.path}: backend=${row.door} node=${got} (serving ${row.serving})`);
      servingAffected += row.serving;
    }
  }
  assert.deepEqual(
    disagreements,
    [],
    `${disagreements.length} paths disagree with production, affecting ${servingAffected} serving rows`,
  );
  for (const row of VERDICTS.edge_cases) {
    assert.equal(categoryPathHasDoor(row.path), row.door, `edge case ${JSON.stringify(row.path)}`);
  }
  // The fixture must actually contain both answers, or "agreement" is vacuous.
  const doors = VERDICTS.prod_paths.filter((r) => r.door).length;
  assert.ok(doors > 0 && doors < VERDICTS.prod_paths.length, 'fixture must contain both doored and doorless paths');
});

test('the door question and the categorised question are DIFFERENT questions', () => {
  // Collapsing these two is the mistake this whole area exists to prevent, so the four-way table is
  // pinned explicitly. Each row is a real shape seen in production.
  const TABLE = [
    // path,                          categorised, hasDoor
    ['beauty', false, true], //        a namespace: answered nothing, but browsable
    ['beauty/makeup', true, true], //  a branch node: answered, browsable, not a leaf
    ['beauty/makeup/face/blush', true, true],
    ['wellness/supplements', true, false], // answered, but recall has no prefix for it
    ['beauty/pottery', true, false],
    ['', false, false],
  ];
  for (const [path, categorised, door] of TABLE) {
    assert.equal(categoryPathIsCategorised(path), categorised, `categorised(${JSON.stringify(path)})`);
    assert.equal(categoryPathHasDoor(path), door, `hasDoor(${JSON.stringify(path)})`);
  }
});

test('the door check asks the way recall asks: case-sensitively, untrimmed', () => {
  // A mis-cased path being unreachable is the failure mode, so normalising here would measure a
  // different system than the one answering the query.
  assert.equal(categoryPathHasDoor('beauty/makeup'), true);
  assert.equal(categoryPathHasDoor('Beauty/Makeup'), false);
  assert.equal(categoryPathHasDoor('BEAUTY/MAKEUP'), false);
  assert.equal(categoryPathHasDoor(' beauty/makeup'), false);
});

// ---------------------------------------------------------------------------
// 3. The reverse drift check — and it must be able to fire.
// ---------------------------------------------------------------------------

test('canonicalTargetsWithoutADoor fires on a map that steers rows somewhere unbrowsable', () => {
  // An assertion that only ever sees a clean map proves the map is clean, never that the check
  // works. Hand it a broken one. (pivota-backend learned this with `gateway_collisions`.)
  assert.deepEqual(canonicalTargetsWithoutADoor(), [], 'the real map must be clean');
  assert.deepEqual(
    canonicalTargetsWithoutADoor({ good: 'beauty/makeup/face/blush', bad: 'beauty/pottery' }),
    ['beauty/pottery'],
  );
  assert.deepEqual(canonicalTargetsWithoutADoor({ a: 'wellness/supplements', b: 'beauty/kites' }).sort(), [
    'beauty/kites',
    'wellness/supplements',
  ]);
  assert.deepEqual(canonicalTargetsWithoutADoor({}), []);
});

test('every canonical home is reachable by recall', () => {
  // The runtime assert in beautyTaxonomy.js covers this at import; stated here too so the intent is
  // greppable and a reader sees WHY the import can throw.
  for (const path of Object.values(CANONICAL_CATEGORY_PATHS)) {
    assert.equal(categoryPathHasDoor(path), true, `${path} is a canonical target recall cannot reach`);
  }
});

// ---------------------------------------------------------------------------
// 4. THE 0-DIFF INVARIANT: adding leaves must not move a single browse prefix.
// ---------------------------------------------------------------------------

test('browse prefixes are unchanged — this change is read-side only', () => {
  // `CANONICAL_CATEGORY_PATHS` feeds `BEAUTY_CATEGORY_PATH_BY_LABEL`, which feeds
  // `resolveBeautyCategoryPathPrefixForQuery` — the live browse prefix for a query. Widening a
  // shared vocabulary is never automatically additive, so the vendored leaves were added as a
  // SEPARATE constant and the canonical map was not touched at all.
  //
  // Measured across 6,639 queries (every product title in the repo's fixtures plus the category
  // vocabulary): zero prefixes moved. The golden below is the pinned subset.
  // THE GOLDEN HAS TO PIN THE CHANNEL IT NAMES. The first version pinned 37 queries, every one of
  // which is answered by `resolveBeautyCategoryPathPrefixFromText` or the alias patterns BEFORE
  // `BEAUTY_CATEGORY_PATH_BY_LABEL` is consulted — so re-homing a canonical value, or collapsing
  // ALL 25 onto one leaf, left all 37 assertions green. Collapsing the map and diffing the resolver
  // over 6,726 queries finds 203 that genuinely route through it; they are pinned here.
  for (const [query, expected] of Object.entries(GOLDEN.map_dependent)) {
    assert.equal(
      resolveBeautyCategoryPathPrefixForQuery(query),
      expected,
      `browse prefix moved for ${JSON.stringify(query)} — that is a SERVING change, not a refactor`,
    );
  }
  for (const [query, expected] of Object.entries(GOLDEN.other_channels)) {
    assert.equal(resolveBeautyCategoryPathPrefixForQuery(query), expected, `browse prefix moved for ${JSON.stringify(query)}`);
  }
  assert.ok(Object.keys(GOLDEN.map_dependent).length >= 150, 'the map-dependent golden has been gutted');
  const nonEmpty = Object.values(GOLDEN.other_channels).filter(Boolean).length;
  assert.ok(nonEmpty >= 25, `golden must pin real prefixes, only ${nonEmpty} are non-empty`);
});

test('the canonical map is untouched by this change', () => {
  // The cheapest possible guard on the above: if nobody adds a key here, no prefix can move.
  assert.equal(Object.keys(CANONICAL_CATEGORY_PATHS).length, 25);
  assert.equal(
    Object.values(CANONICAL_CATEGORY_PATHS).every((p) => p.startsWith('beauty/')),
    true,
    'CANONICAL_CATEGORY_PATHS is the beauty canonicalisation map; the recall leaf set is a separate list',
  );
});

test('the import-time guard actually throws — not just the function it calls', () => {
  // Deleting the whole `_CANONICAL_WITHOUT_A_DOOR` block left all nine tests green: one test drives
  // the FUNCTION and another restates the property, but nothing asserted that importing the module
  // fails. The mechanism is what protects the gateway's boot, so it is driven here in a child
  // process against a real copy of the module with one bad canonical target injected.
  const dir = path.join(__dirname, '..', 'src', 'services');
  const real = path.join(dir, 'beautyTaxonomy.js');
  const probe = path.join(dir, `__import_guard_probe_${process.pid}.js`);
  const source = fs.readFileSync(real, 'utf8');
  const injected = source.replace(
    /(const CANONICAL_CATEGORY_PATHS = Object\.freeze\(\{\n)/,
    "$1  __probe_no_door: 'beauty/pottery',\n",
  );
  assert.notEqual(injected, source, 'the probe must actually inject a doorless canonical target');
  try {
    fs.writeFileSync(probe, injected);
    const run = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(probe)})`], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'importing a module with a doorless canonical target must FAIL');
    assert.match(run.stderr, /CANONICAL_CATEGORY_PATHS targets a path recall cannot reach/);
    assert.match(run.stderr, /beauty\/pottery/);
    assert.match(run.stderr, /recallTaxonomyLeaves\.js needs regenerating/, 'the error must say how to fix it');
  } finally {
    fs.rmSync(probe, { force: true });
  }
  // Control: the UNMODIFIED module imports cleanly in the same child-process harness, so the test
  // above is measuring the injection and not a broken probe.
  const clean = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(real)})`], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
});

test('the two predicates agree about an array, because the writers will see one', () => {
  // `normalizeCategoryPathText` accepts `['beauty','fragrance']`; `categoryPathHasDoor` used a bare
  // String() and turned it into 'beauty,fragrance' — no door — while its sibling in the same module
  // said categorised. Two predicates in one file disagreeing about an input shape is a trap, and
  // the writers that will gate on this read category_path out of JSON where the array form occurs.
  for (const [arr, str] of [
    [['beauty', 'makeup'], 'beauty/makeup'],
    [['beauty', 'makeup', 'face', 'blush'], 'beauty/makeup/face/blush'],
    [['beauty', 'pottery'], 'beauty/pottery'],
    [['beauty'], 'beauty'],
  ]) {
    assert.equal(categoryPathHasDoor(arr), categoryPathHasDoor(str), `array vs string: ${JSON.stringify(arr)}`);
    assert.equal(categoryPathIsCategorised(arr), categoryPathIsCategorised(str));
  }
  // And the tolerance is exactly that -- it must not become general normalisation.
  assert.equal(categoryPathHasDoor('Beauty/Makeup'), false);
  assert.equal(categoryPathHasDoor(' beauty/makeup'), false);
  for (const junk of [null, undefined, 0, 42, {}, true]) {
    assert.equal(categoryPathHasDoor(junk), false, `${JSON.stringify(junk)} must not have a door`);
  }
});
