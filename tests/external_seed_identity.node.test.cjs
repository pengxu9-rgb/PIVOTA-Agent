// Ranges every "is this an external seed?" implementation over the SAME rows.
//
// The defect this addresses is not a wrong line, it is five answers to one question. When a
// concern has no owner it is re-derived at each call site; a fix pins the result where the bug
// was seen, its test pins that site's output, and the same defect resurfaces at the next site.
// A table that runs all implementations over shared cases makes a disagreement a visible fact
// rather than something rediscovered a year later.
//
// The cases are REAL SHAPES, taken from the live agent door (search_catalog, 2026-09-10) and
// from prod `catalog_products`, not invented ones. That matters: every legacy predicate returns
// false for every external seed in production, and only a case built from a served row shows it.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isExternalSeedRow,
  isExternalSeedRowCorrected,
  externalSeedDisagreement,
  LEGACY_SEED_PLATFORMS,
  OBSERVED_SEED_PLATFORMS,
} = require('../src/externalSeedIdentity');

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// IMPORTED where reachable, transcribed only where genuinely module-private.
//
// The transcription-only version of this table got pdpBuilder's predicate WRONG — it copied five
// of seven clauses, dropping the `purchase_route` and `commerce_mode` arms and substituting
// String().trim() for stripHtml(). That made the module's "union of all five / never narrows"
// claim look verified when it was false. pdpBuilder exports its predicate, so importing it would
// have failed immediately. A transcription is a second copy, and a second copy can be wrong —
// which is the defect this whole file is about, committed inside the test for it.
const { isExternalSeedLikeProduct } = require('../src/pdpBuilder');
const { isExternalSeedLaneProduct } = require('../src/services/externalSeedLane');

const LEGACY = {
  'server.js:15417': (p) =>
    String(p.merchant_id || p.merchantId || '').trim() === 'external_seed' ||
    norm(p.source) === 'external_seed',
  'findProductsMulti/policy.js:415': (p) =>
    norm(p.merchant_id || p.merchantId) === 'external_seed' || norm(p.source) === 'external_seed',
  // The REAL function, not a copy of it.
  'pdpBuilder.js:233': (p) => isExternalSeedLikeProduct(p),
  'semanticOwnerExecution.js:111': (p) =>
    norm(p.merchant_id || p.merchantId) === 'external_seed' ||
    norm(p.source || p.query_source).includes('external_seed'),
  'ui/ProductDetailClient.tsx:281': (p) =>
    ['external_seed', 'external_product_seeds'].includes(
      norm(p.source || p.product_source || p.productSource),
    ) || norm(p.platform) === 'external',
};

// Real shapes. `served_*` are verbatim field combinations observed on the live agent door.
const CASES = [
  {
    name: 'served canonical-chain external seed (13,896 rows in prod)',
    row: { platform: 'external_seed', source: 'canonical_chain', merchant_id: 'merch_obs_e1cf1ca8ef133606', catalog_track: 'external_referral' },
    legacyAgrees: false,
    correctedIs: true,
  },
  {
    name: 'served external seed with source=merchant_public',
    row: { platform: 'external_seed', source: 'merchant_public', merchant_id: 'merch_obs_04db57b3f57f12e4' },
    legacyAgrees: false,
    correctedIs: true,
  },
  {
    name: 'served internal shopify product (1,545 rows)',
    row: { platform: 'shopify', source: 'merchant_public', merchant_id: 'merch_efbc46b4619cfbdf' },
    legacyAgrees: false,
    correctedIs: false,
  },
  {
    name: 'legacy shape: merchant_id is the literal external_seed',
    row: { merchant_id: 'external_seed', source: 'canonical_chain' },
    legacyAgrees: true,
    correctedIs: true,
  },
  {
    name: 'legacy shape: source is external_seed',
    row: { merchant_id: 'merch_x', source: 'external_seed' },
    legacyAgrees: true,
    correctedIs: true,
  },
  { name: 'null row', row: null, legacyAgrees: false, correctedIs: false },
  { name: 'empty object', row: {}, legacyAgrees: false, correctedIs: false },
];

test('the owner reproduces what the legacy predicates agree on', () => {
  // Adoption must be behaviour-preserving. Where every legacy implementation gives the same
  // answer, the owner must give that answer too — otherwise replacing a call site changes
  // behaviour while claiming to be a refactor.
  for (const { name, row, legacyAgrees } of CASES) {
    const answers = Object.entries(LEGACY).map(([impl, fn]) => [impl, row ? fn(row) : false]);
    const unanimous = answers.every(([, a]) => a === answers[0][1]);
    if (!unanimous) continue;
    assert.equal(
      isExternalSeedRow(row),
      legacyAgrees,
      `${name}: the owner must match the unanimous legacy answer`,
    );
    for (const [impl, a] of answers) {
      assert.equal(isExternalSeedRow(row), a, `${name}: owner disagrees with ${impl}`);
    }
  }
});

test('every legacy predicate is FALSE for every external seed in production', () => {
  // The finding, pinned. If someone fixes one of the five in place, this fails and points at
  // the owner — which is the whole reason the owner exists.
  const productionSeeds = CASES.filter((c) => c.correctedIs && c.row && c.row.platform === 'external_seed');
  assert.ok(productionSeeds.length >= 2, 'expected the observed production shapes');

  for (const { name, row } of productionSeeds) {
    for (const [impl, fn] of Object.entries(LEGACY)) {
      assert.equal(fn(row), false, `${name}: ${impl} unexpectedly returns true — update this table`);
    }
    assert.equal(isExternalSeedRow(row), false, `${name}: the owner preserves that today`);
    assert.equal(isExternalSeedRowCorrected(row), true, `${name}: the corrected answer is true`);
    assert.notEqual(externalSeedDisagreement(row), null, `${name}: must be reported as a disagreement`);
  }
});

test('the owner is NARROWER than two of the five — the "union" claim was false', () => {
  // The correction. isExternalSeedRow is the union of the TWO predicates it actually replaced,
  // not of all five. pdpBuilder accepts purchase_route/commerce_mode arms it does not have, and
  // semanticOwnerExecution matches `source` by substring. Both are shown here with the real
  // function, so a future delegation cannot be argued for on a false premise: pdpBuilder's is
  // exported and used at 18 sites, including PDP redirect resolution and renderability.
  const narrowerThanPdpBuilder = [
    { purchase_route: 'links_out' },
    { purchase_route: 'affiliate_outbound' },
    { commerce_mode: 'links_out' },
  ];
  for (const row of narrowerThanPdpBuilder) {
    assert.equal(LEGACY['pdpBuilder.js:233'](row), true, `${JSON.stringify(row)}: pdpBuilder says external`);
    assert.equal(isExternalSeedRow(row), false, `${JSON.stringify(row)}: the owner does NOT — it is narrower`);
  }

  const narrowerThanSemanticOwner = { source: 'external_seed_backfill' };
  assert.equal(LEGACY['semanticOwnerExecution.js:111'](narrowerThanSemanticOwner), true);
  assert.equal(isExternalSeedRow(narrowerThanSemanticOwner), false);
});

test('the real owner is isSeedRoutedLane, and it is not interchangeable with this one', () => {
  // Pins the difference in BOTH directions so nobody "simplifies" by forwarding one to the other.
  // src/services/externalSeedLane.js is the canonical seed-lane predicate, already imported by
  // src/server.js:102-103. It widens (canonical-chain rows, ext_ id prefixes) AND narrows (it
  // does not read `source` at all).
  const servedCanonicalChain = { platform: 'external_seed', source: 'canonical_chain', merchant_id: 'merch_obs_a' };
  assert.equal(isExternalSeedRow(servedCanonicalChain), false, 'legacy: false');
  assert.equal(isExternalSeedLaneProduct(servedCanonicalChain), true, 'owner: true — a widening');

  const bySource = { merchant_id: 'merch_x', source: 'external_seed' };
  assert.equal(isExternalSeedRow(bySource), true, 'legacy: true');
  assert.equal(isExternalSeedLaneProduct(bySource), false, 'owner: false — a NARROWING');

  // And the corrected predicate ORs them rather than replacing one with the other.
  assert.equal(isExternalSeedRowCorrected(servedCanonicalChain), true);
  assert.equal(isExternalSeedRowCorrected(bySource), true);

  // A shape ONLY the owner accepts — no platform leg, no source leg, just the id prefix. This is
  // what distinguishes "delegates to the owner" from "reimplements a platform check locally";
  // without it, an invented `platform === 'external_seed'` arm passes every assertion above.
  const byIdPrefix = { merchant_id: 'merch_obs_b', source_product_id: 'ext_123' };
  assert.equal(isExternalSeedRow(byIdPrefix), false, 'legacy has no id-prefix arm');
  assert.equal(isExternalSeedLaneProduct(byIdPrefix), true, 'the owner does');
  assert.equal(
    isExternalSeedRowCorrected(byIdPrefix),
    true,
    'the corrected answer must come from the owner, not a locally reinvented platform check',
  );
});

test('the implementations disagree with each other — that is the defect, recorded', () => {
  // Not a hypothetical. A case only some accept proves the five are not interchangeable, so
  // "just use whichever is nearest" is not a safe instinct.
  const row = { merchant_id: 'merch_x', source: 'external_product_seeds' };
  const answers = Object.entries(LEGACY).map(([impl, fn]) => [impl, fn(row)]);
  const yes = answers.filter(([, a]) => a).map(([impl]) => impl);
  const no = answers.filter(([, a]) => !a).map(([impl]) => impl);

  assert.ok(yes.length > 0 && no.length > 0, 'expected a genuine split across implementations');
  // pdpBuilder and the UI accept external_product_seeds; the other three do not.
  assert.ok(yes.includes('pdpBuilder.js:233'));
  assert.ok(no.includes('server.js:15417'));

  // And the owner takes the broader reading, so adoption never NARROWS a call site.
  assert.equal(isExternalSeedRow(row), true);
});

test('case sensitivity: only server.js:15417 was case-sensitive on merchant_id', () => {
  // The owner is case-insensitive, matching four of the five. It is a widening, and it affects
  // zero production rows: no row carries 'external_seed' as a merchant_id in any casing.
  const row = { merchant_id: 'External_Seed' };
  assert.equal(LEGACY['server.js:15417'](row), false, 'the case-sensitive outlier');
  assert.equal(LEGACY['findProductsMulti/policy.js:415'](row), true);
  assert.equal(isExternalSeedRow(row), true, 'the owner follows the majority');
});
