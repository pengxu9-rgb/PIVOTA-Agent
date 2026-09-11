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
const GOLDEN = require('./fixtures/recall_browse_prefix_golden.json');
const { resolveBeautyCategoryPathPrefixForQuery } = require('../src/services/externalSeedProducts');

// ---------------------------------------------------------------------------
// 1. The vendored copy is the backend's set, and says so in numbers.
// ---------------------------------------------------------------------------

test('the vendored leaf set matches the shape production derives its doors from', () => {
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
    const got = categoryPathHasDoor(row.path.trim());
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
  for (const [query, expected] of Object.entries(GOLDEN.prefixes)) {
    assert.equal(
      resolveBeautyCategoryPathPrefixForQuery(query),
      expected,
      `browse prefix moved for ${JSON.stringify(query)} — that is a SERVING change, not a refactor`,
    );
  }
  const nonEmpty = Object.values(GOLDEN.prefixes).filter(Boolean).length;
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
