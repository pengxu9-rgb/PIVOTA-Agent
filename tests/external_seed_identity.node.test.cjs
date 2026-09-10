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

// The five legacy predicates, transcribed from their definitions. Transcriptions rather than
// imports because most are module-private; each is pinned to its file:line so a drift between
// this table and the original is findable. The equivalence test below is what keeps them honest.
const LEGACY = {
  'server.js:15417': (p) =>
    String(p.merchant_id || p.merchantId || '').trim() === 'external_seed' ||
    norm(p.source) === 'external_seed',
  'findProductsMulti/policy.js:415': (p) =>
    norm(p.merchant_id || p.merchantId) === 'external_seed' || norm(p.source) === 'external_seed',
  'pdpBuilder.js:233': (p) =>
    norm(p.merchant_id || p.merchantId || (p.merchant && p.merchant.id)) === 'external_seed' ||
    ['external_seed', 'external_product_seeds', 'external_seed_db'].includes(
      norm(p.source || p.product_source || p.productSource || p.detail_source || p.query_source),
    ) ||
    norm(p.platform || p.source_platform) === 'external',
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

test("platform === 'external' matches nothing — it is legacy vocabulary, not a live check", () => {
  // Two legacy predicates gate on it. Prod `catalog_products.platform` has zero such rows:
  // external_seed=13896, shopify=1545, wix=40, url_audit=34, brand_authored=1. Written down so
  // nobody re-adds it believing it does something.
  assert.deepEqual(LEGACY_SEED_PLATFORMS, ['external']);
  assert.deepEqual(OBSERVED_SEED_PLATFORMS, ['external_seed']);
  assert.notDeepEqual(LEGACY_SEED_PLATFORMS, OBSERVED_SEED_PLATFORMS);

  const observedPlatforms = ['external_seed', 'shopify', 'wix', 'url_audit', 'brand_authored'];
  assert.equal(
    observedPlatforms.includes('external'),
    false,
    "'external' is not a platform value this system produces",
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
