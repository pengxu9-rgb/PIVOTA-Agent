const previousSimilarFamilyFlag = process.env.AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED;
delete process.env.AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED;

const app = require('../src/server');
const { __internal: relationshipGraphInternal } = require('../src/auroraBff/productRelationshipGraph');

afterAll(() => {
  if (previousSimilarFamilyFlag === undefined) {
    delete process.env.AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED;
  } else {
    process.env.AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED = previousSimilarFamilyFlag;
  }
});

function fentyConcealer(overrides = {}) {
  return {
    merchant_id: 'external_seed',
    product_id: 'sig_fenty_concealer_185',
    source: 'external',
    brand: 'Fenty Beauty',
    title: "Pro Filt'r Instant Retouch Concealer - 185",
    category: 'Concealer',
    product_type: 'Concealer',
    ...overrides,
  };
}

function productIds(items) {
  return items.map((item) => item.product_id);
}

describe('dedupeSimilarCandidatesByFamily', () => {
  const {
    dedupeSimilarCandidatesByFamily,
    dedupeSimilarCandidatesByMerchantProductId,
    shapeItemForFamilyKey,
  } = app._debug;

  test('collapses recall shades from the same product family to one card', () => {
    const shade185 = fentyConcealer({ product_id: 'sig_concealer_185' });
    const shade255 = fentyConcealer({
      product_id: 'sig_concealer_255',
      title: "Pro Filt'r Instant Retouch Concealer - 255",
    });

    const out = dedupeSimilarCandidatesByFamily([shade185, shade255]);

    expect(out).toEqual([shade185]);
  });

  test('keeps curated relationship-graph item when recall has the same family', () => {
    const curated = fentyConcealer({
      merchant_id: 'pivota',
      product_id: 'pg_fenty_concealer',
      source: 'relationship_graph',
    });
    const recall = fentyConcealer({
      product_id: 'sig_fenty_concealer_255',
      title: "Pro Filt'r Instant Retouch Concealer - 255",
    });

    const out = dedupeSimilarCandidatesByFamily([curated, recall]);

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(curated);
  });

  test('drops recall items from the anchor family', () => {
    const anchor = fentyConcealer({ product_id: 'sig_anchor', title: "Pro Filt'r Instant Retouch Concealer - 190" });
    const anchorFamilyKey = relationshipGraphInternal.familyIdentityKey(shapeItemForFamilyKey(anchor));
    const ownShade = fentyConcealer({
      product_id: 'sig_own_shade',
      title: "Pro Filt'r Instant Retouch Concealer - 255",
    });
    const otherProduct = {
      merchant_id: 'external_seed',
      product_id: 'sig_other_product',
      source: 'external',
      brand: 'Rare Beauty',
      title: 'Liquid Touch Brightening Concealer - 180W',
      category: 'Concealer',
      product_type: 'Concealer',
    };

    const out = dedupeSimilarCandidatesByFamily([ownShade, otherProduct], { anchorFamilyKey });

    expect(out).toEqual([otherProduct]);
  });

  test('falls back to merchant/product dedupe when family key is not derived', () => {
    const missingBrandTitleA = {
      merchant_id: 'external_seed',
      product_id: 'sig_missing_a',
      source: 'external',
    };
    const missingBrandTitleB = {
      merchant_id: 'external_seed',
      product_id: 'sig_missing_b',
      source: 'external',
    };
    const duplicateA = {
      merchant_id: 'external_seed',
      product_id: 'sig_missing_a',
      source: 'external',
    };

    const out = dedupeSimilarCandidatesByFamily([missingBrandTitleA, missingBrandTitleB, duplicateA]);

    expect(out).toEqual([missingBrandTitleA, missingBrandTitleB]);
  });

  test('does not merge products whose family categories conflict', () => {
    const categorylessFirst = fentyConcealer({
      product_id: 'sig_categoryless',
      category: undefined,
      product_type: undefined,
    });
    const concealer = fentyConcealer({ product_id: 'sig_concealer' });
    const conflictingCategory = fentyConcealer({
      product_id: 'sig_foundation',
      category: 'Foundation',
      product_type: 'Foundation',
    });

    const out = dedupeSimilarCandidatesByFamily([categorylessFirst, concealer, conflictingCategory]);

    expect(productIds(out)).toEqual(['sig_categoryless', 'sig_foundation']);
  });

  test('flag-off default preserves merchant/product dedupe behavior', () => {
    const shade185 = fentyConcealer({ product_id: 'sig_concealer_185' });
    const shade255 = fentyConcealer({
      product_id: 'sig_concealer_255',
      title: "Pro Filt'r Instant Retouch Concealer - 255",
    });
    const duplicateShade185 = fentyConcealer({ product_id: 'sig_concealer_185' });

    expect(app._debug.isSimilarFamilyDedupeEnabled()).toBe(false);
    expect(dedupeSimilarCandidatesByMerchantProductId([shade185, shade255, duplicateShade185])).toEqual([
      shade185,
      shade255,
    ]);
  });
});
