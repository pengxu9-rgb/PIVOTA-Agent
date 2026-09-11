// The two `platform` spellings are NOT interchangeable, and this records why — so the next attempt
// to "just unify the vocabulary" starts from the measurement instead of repeating it.
//
// THE SPLIT. Production `catalog_products.platform` is `external_seed` on 13,896 of 15,516 rows and
// `external` on ZERO. But four builders mint `external` in memory at serve time
// (src/server.js, src/services/externalSeedProducts.js x2, src/services/RecommendationEngine.js),
// so the value exists only in objects. A DB census therefore reads `external` as dead vocabulary
// and a served response does not — which is how it survived since 2026-05-01.
//
// WHY IT CANNOT SIMPLY BE UNIFIED. Both directions are behaviour changes, measured:
//
//   widen the consumers to accept `external_seed` on the platform arm
//     -> isExternalSeedLikeProduct flips false->TRUE for the canonical-chain served shape,
//        i.e. ~13,896 products, essentially everything the door serves.
//
//   change the producers to stamp `external_seed`
//     -> for a row carrying NO `source` (three of the four builders stamp none),
//        isExternalSeedLikeProduct flips true->FALSE, and it gates the PDP external redirect URL,
//        renderability and suppression across ~18 call sites in pdpBuilder.
//
// The second was attempted and reverted: both gates went green (node 3,859, jest 1,826) because no
// suite exercises a source-less minted row through pdpBuilder. The assertion below is what caught
// it. Green suites were not evidence of safety here; this case is.

const { isExternalSeedLikeProduct } = require('../src/pdpBuilder');
const { isExternalSeedLaneProduct } = require('../src/services/externalSeedLane');

describe('the two platform spellings are disjoint across the two predicates', () => {
  // A row with ONLY a platform signal — the shape three of the four builders emit.
  const onlyOld = { merchant_id: 'merch_obs_x', platform: 'external' };
  const onlyNew = { merchant_id: 'merch_obs_x', platform: 'external_seed' };

  test('pdpBuilder recognises `external` and NOT `external_seed`', () => {
    expect(isExternalSeedLikeProduct(onlyOld)).toBe(true);
    expect(isExternalSeedLikeProduct(onlyNew)).toBe(false);
  });

  test('the lane owner recognises `external_seed` and NOT `external` — the mirror image', () => {
    expect(isExternalSeedLaneProduct(onlyOld)).toBe(false);
    expect(isExternalSeedLaneProduct(onlyNew)).toBe(true);
  });

  test('so no single spelling satisfies both, which is the whole constraint', () => {
    for (const row of [onlyOld, onlyNew]) {
      expect(isExternalSeedLikeProduct(row) && isExternalSeedLaneProduct(row)).toBe(false);
    }
  });

  test('a row carrying BOTH signals is recognised by both — the escape hatch, if one is wanted', () => {
    // Stamping `source: 'external_seed'` alongside the platform makes a row acceptable to either
    // predicate regardless of spelling. That is the one shape that unifies without a flip, and it
    // is what a future migration should emit rather than changing `platform` alone.
    const both = { merchant_id: 'merch_obs_x', platform: 'external_seed', source: 'external_seed' };
    expect(isExternalSeedLikeProduct(both)).toBe(true);
    expect(isExternalSeedLaneProduct(both)).toBe(true);
  });

  test('an internal merchant row is recognised by neither', () => {
    const internal = { merchant_id: 'merch_efbc46b4619cfbdf', platform: 'shopify', source: 'merchant_public' };
    expect(isExternalSeedLikeProduct(internal)).toBe(false);
    expect(isExternalSeedLaneProduct(internal)).toBe(false);
  });
});
