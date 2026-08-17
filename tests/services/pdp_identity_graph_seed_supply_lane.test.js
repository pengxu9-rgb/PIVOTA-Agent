'use strict';

// ADR-009 task 4 / group 1 — pdpIdentityGraph's row-side seed gates.
//
// The defect class: a serving branch that asks "is this external-seed supply?"
// by comparing the row's seller against the retired sentinel merchant. #1770
// re-keyed that supply onto per-brand observed sellers (`merch_obs_…`), so the
// comparison now answers "no, a real merchant" for essentially the whole seed
// corpus and the branch silently stops firing. Four such gates in this file are
// converged onto the durable discriminators (the row's own source_kind, then
// the canonical seed-lane predicate); ONE — the placeholder seller LABEL — is
// deliberately left narrow, and this file pins that too so a later sweep does
// not "finish the job" by widening it.
//
// Every test below is written so that restoring the old sentinel comparison
// makes it fail; the three marked PRESERVATION pin behaviour that must NOT move.

const {
  composeSyntheticCanonicalProduct,
  searchPdpIdentityGroupsForQuery,
  _internals,
} = require('../../src/services/pdpIdentityGraph');

const { buildIdentitySearchOffer, hydrateIdentityRowsFromCurrentExternalSeeds } = _internals;

// A per-brand observed seller: what the re-key moved crawl supply onto.
const OBSERVED_SELLER = 'merch_obs_9f2c11a4';
// The legacy anonymous bucket, whose catalog_merchants row is a placeholder.
const LEGACY_BUCKET = 'external_seed';
// A connected merchant we actually transact with.
const CONNECTED_MERCHANT = 'merch_7ab3d90c';

const SEED_PRODUCT_ID = 'ext_5a1c9d3f8b2e4c6a7d0f1b2c';
const CONNECTED_PRODUCT_ID = '8123456789012';

function savingsPayload(extra = {}) {
  return {
    title: 'Aurora Glow Serum',
    price: { amount: 79, currency: 'USD' },
    store_discount_badges: ['20% off'],
    store_discount_summary: 'Save $20 today',
    payment_offer_summary: '5% back with card',
    promotion_lines: ['Bundle and save'],
    ...extra,
  };
}

function observedSellerSeedListing(overrides = {}) {
  return {
    merchant_id: OBSERVED_SELLER,
    product_id: SEED_PRODUCT_ID,
    source_kind: 'external_seed',
    source_payload: savingsPayload(),
    ...overrides,
  };
}

describe('savings presentation is suppressed for ALL external-seed supply', () => {
  test('an observed-seller seed offer carries no savings fields', () => {
    const offer = buildIdentitySearchOffer(observedSellerSeedListing(), 'grp_aurora');
    expect(offer).toBeTruthy();
    // The offer still exists and still carries its price — only the unverified
    // crawl-sourced savings claims are withheld.
    expect(offer.price).toEqual({ amount: 79, currency: 'USD' });
    expect(offer.store_discount_badges).toBeUndefined();
    expect(offer.store_discount_summary).toBeUndefined();
    expect(offer.payment_offer_summary).toBeUndefined();
    expect(offer.promotion_lines).toBeUndefined();
  });

  test('PRESERVATION: the legacy anonymous bucket is still suppressed', () => {
    const offer = buildIdentitySearchOffer(
      observedSellerSeedListing({ merchant_id: LEGACY_BUCKET }),
      'grp_aurora',
    );
    expect(offer.store_discount_badges).toBeUndefined();
    expect(offer.payment_offer_summary).toBeUndefined();
  });

  test('PRESERVATION: a connected merchant still gets its savings fields', () => {
    const offer = buildIdentitySearchOffer(
      {
        merchant_id: CONNECTED_MERCHANT,
        product_id: CONNECTED_PRODUCT_ID,
        source_kind: 'internal',
        source_payload: savingsPayload(),
      },
      'grp_aurora',
    );
    expect(offer.store_discount_badges).toEqual(['20% off']);
    expect(offer.store_discount_summary).toBe('Save $20 today');
    expect(offer.payment_offer_summary).toBe('5% back with card');
  });
});

describe('the placeholder-seller label stays on the anonymous bucket only', () => {
  // This is the KEEP decision. The label names "we have no seller of record",
  // which is true of the legacy bucket and FALSE of an observed seller — so
  // widening it to the seed lane would replace a real seller of record with a
  // generic placeholder. A mutation that converges this site fails here.
  const namelessPayload = { title: 'Aurora Glow Serum', price: { amount: 79, currency: 'USD' } };

  test('the anonymous bucket falls back to the placeholder label', () => {
    const offer = buildIdentitySearchOffer(
      {
        merchant_id: LEGACY_BUCKET,
        product_id: SEED_PRODUCT_ID,
        source_kind: 'external_seed',
        source_payload: namelessPayload,
      },
      'grp_aurora',
    );
    expect(offer.merchant_name).toBe('External reference');
  });

  test('an observed seller with no payload name is left unnamed, not placeheld', () => {
    const offer = buildIdentitySearchOffer(
      {
        merchant_id: OBSERVED_SELLER,
        product_id: SEED_PRODUCT_ID,
        source_kind: 'external_seed',
        source_payload: namelessPayload,
      },
      'grp_aurora',
    );
    expect(offer.merchant_name).toBeUndefined();
  });
});

describe('fresh seed variants win over the stored payload for observed sellers', () => {
  const staleVariants = [{ id: 'v_stale', variant_id: 'v_stale', title: '30ml (stale)' }];
  const freshVariants = [{ id: 'v_fresh', variant_id: 'v_fresh', title: '30ml' }];

  function compose(merchantId) {
    const listing = {
      merchant_id: merchantId,
      product_id: SEED_PRODUCT_ID,
      source_kind: 'external_seed',
      source_payload: {
        product_id: SEED_PRODUCT_ID,
        title: 'Aurora Glow Serum',
        variants: staleVariants,
        default_variant_id: 'v_stale',
      },
    };
    const fallbackProduct = {
      merchant_id: merchantId,
      product_id: SEED_PRODUCT_ID,
      title: 'Aurora Glow Serum',
      variants: freshVariants,
      default_variant_id: 'v_fresh',
    };
    return composeSyntheticCanonicalProduct({
      requestedListing: listing,
      exactListings: [listing],
      lineListings: [listing],
      fallbackProduct,
    });
  }

  test('an observed-seller seed serves the freshly built variants', () => {
    const { product } = compose(OBSERVED_SELLER);
    expect(product.variants).toEqual(freshVariants);
    expect(product.default_variant_id).toBe('v_fresh');
  });

  test('PRESERVATION: the legacy anonymous bucket still serves fresh variants', () => {
    const { product } = compose(LEGACY_BUCKET);
    expect(product.variants).toEqual(freshVariants);
    expect(product.default_variant_id).toBe('v_fresh');
  });
});

describe('commerce overlay withholds savings for observed-seller seeds', () => {
  // The overlay gate only shows itself when the CONTENT listing and the
  // SELECTED COMMERCE listing differ: the product is built from the content
  // payload (no savings of its own) and the commerce listing's fields are
  // overlaid on top. So the group here is a brand content listing plus a
  // separate selected commerce listing that carries the savings claims.
  const brandContentListing = {
    merchant_id: 'merch_obs_brandsite',
    product_id: 'ext_brand_canonical_row_0001',
    source_kind: 'external_seed',
    source_tier: 'brand',
    source_payload: {
      product_id: 'ext_brand_canonical_row_0001',
      title: 'Aurora Glow Serum',
      description: 'Brand-site canonical copy.',
    },
  };

  function composeWithCommerceListing(commerceListing) {
    return composeSyntheticCanonicalProduct({
      requestedListing: commerceListing,
      exactListings: [brandContentListing],
      lineListings: [brandContentListing],
    });
  }

  test('the composed product carries no savings fields for a seed commerce listing', () => {
    const { product } = composeWithCommerceListing(
      observedSellerSeedListing({
        source_payload: savingsPayload({ product_id: SEED_PRODUCT_ID }),
      }),
    );
    expect(product.store_discount_badges).toBeUndefined();
    expect(product.store_discount_summary).toBeUndefined();
    expect(product.payment_offer_summary).toBeUndefined();
    // The non-savings commerce fields still overlay normally.
    expect(product.price).toEqual({ amount: 79, currency: 'USD' });
  });

  test('PRESERVATION: a connected merchant commerce listing keeps its savings overlay', () => {
    const { product } = composeWithCommerceListing({
      merchant_id: CONNECTED_MERCHANT,
      product_id: CONNECTED_PRODUCT_ID,
      source_kind: 'internal',
      source_payload: savingsPayload({ product_id: CONNECTED_PRODUCT_ID }),
    });
    expect(product.store_discount_badges).toEqual(['20% off']);
    expect(product.payment_offer_summary).toBe('5% back with card');
  });

  test('PRESERVATION: the legacy anonymous bucket is still withheld', () => {
    const { product } = composeWithCommerceListing(
      observedSellerSeedListing({
        merchant_id: LEGACY_BUCKET,
        source_payload: savingsPayload({ product_id: SEED_PRODUCT_ID }),
      }),
    );
    expect(product.store_discount_badges).toBeUndefined();
  });
});

describe('identity search ranks a transacting seller above crawl supply', () => {
  const OLD_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgres://identity-search-rank-test/db';
  });
  afterAll(() => {
    if (OLD_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = OLD_DATABASE_URL;
  });

  // Both groups are identical on every other scoring term (same title, one
  // offer each, same confidence, same offer_source), and the seed group is
  // returned FIRST so a tie would leave it first. Only the seller-of-record
  // bonus can reorder them.
  function rowFor(groupId, merchantId, productId, sourceKind) {
    return {
      sellable_item_group_id: groupId,
      merchant_id: merchantId,
      product_id: productId,
      source_kind: sourceKind,
      identity_confidence: 0.9,
      source_payload: {
        product_id: productId,
        title: 'Aurora Glow Serum',
        price: { amount: 79, currency: 'USD' },
      },
    };
  }

  const seedRow = rowFor('grp_seed', OBSERVED_SELLER, SEED_PRODUCT_ID, 'external_seed');
  const connectedRow = rowFor('grp_connected', CONNECTED_MERCHANT, CONNECTED_PRODUCT_ID, 'internal');

  function queryFn() {
    let call = 0;
    return async () => {
      call += 1;
      // 1st call: group-id candidates (seed group first). 2nd: the group rows.
      if (call === 1) return { rows: [seedRow, connectedRow] };
      return { rows: [seedRow, connectedRow] };
    };
  }

  test('the connected-merchant group outranks the observed-seller seed group', async () => {
    const result = await searchPdpIdentityGroupsForQuery({
      queryText: 'aurora glow serum',
      limit: 5,
      queryFn: queryFn(),
    });
    expect(result.products.map((p) => p.product_group_id)).toEqual(['grp_connected', 'grp_seed']);
  });
});

describe('runtime seed hydration follows the lane, not the seller', () => {
  const OLD_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgres://identity-hydration-test/db';
  });
  afterAll(() => {
    if (OLD_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = OLD_DATABASE_URL;
  });

  test('a lane-shaped row with no source_kind is still looked up', async () => {
    const seen = [];
    const queryFn = async (_sql, params) => {
      seen.push(params);
      return { rows: [] };
    };
    await hydrateIdentityRowsFromCurrentExternalSeeds(
      [
        // No source_kind at all: only the seed-lane id shape marks it.
        { merchant_id: OBSERVED_SELLER, product_id: SEED_PRODUCT_ID },
        { merchant_id: CONNECTED_MERCHANT, product_id: CONNECTED_PRODUCT_ID, source_kind: 'internal' },
      ],
      queryFn,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toContain(SEED_PRODUCT_ID);
    expect(seen[0][0]).not.toContain(CONNECTED_PRODUCT_ID);
  });

  test('PRESERVATION: source_kind still selects a row on its own', async () => {
    const seen = [];
    const queryFn = async (_sql, params) => {
      seen.push(params);
      return { rows: [] };
    };
    await hydrateIdentityRowsFromCurrentExternalSeeds(
      [{ merchant_id: OBSERVED_SELLER, product_id: 'legacy_seed_id_1', source_kind: 'external_seed' }],
      queryFn,
    );
    expect(seen[0][0]).toContain('legacy_seed_id_1');
  });
});
