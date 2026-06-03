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

function relationshipFamilyKey(product) {
  return relationshipGraphInternal.familyIdentityKey({
    name: product.title || product.name,
    title: product.title || product.name,
    brand: product.brand,
    category: product.category,
    product_type: product.product_type,
    variant_title: product.variant_title,
    variant_detail_label: product.variant_detail_label,
    product_ref: product.product_ref || product.product_id || product.source_product_id,
  });
}

describe('dedupeSimilarCandidatesByFamily', () => {
  const {
    dedupeSimilarCandidatesByFamily,
    dedupeSimilarCandidatesByMerchantProductId,
    resolveSimilarFamilyDedupeContext,
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

  test('drops anchor-family recall items when the anchor is resolved from an identity-only ref', async () => {
    const anchor = {
      merchant_id: 'external_seed',
      product_id: 'ext_anchor_suedish',
      external_product_id: 'ext_anchor_suedish',
    };
    const ownShade = {
      merchant_id: 'external_seed',
      product_id: 'sig_match_stix_ebony',
      source_product_id: 'ext_match_stix_ebony',
      source: 'external',
      brand: 'Fenty Beauty',
      title: 'Match Stix Contour \u2014 Ebony',
      category: 'Contour',
      product_type: 'Contour',
    };
    const otherProduct = {
      merchant_id: 'external_seed',
      product_id: 'sig_rare_blush_joy',
      source_product_id: 'ext_rare_blush_joy',
      source: 'external',
      brand: 'Rare Beauty',
      title: 'Soft Pinch Liquid Blush - Joy',
      category: 'Blush',
      product_type: 'Blush',
    };
    const queryFn = jest.fn(async (sql, params) => {
      expect(sql).toMatch(/unnest\(\$1::text\[\]\)/);
      expect(params[0]).toEqual(['ext_anchor_suedish', 'ext_match_stix_ebony', 'ext_rare_blush_joy']);
      return {
        rows: [
          {
            input_ref: 'ext_anchor_suedish',
            normalized_ref: 'ext_anchor_suedish',
            source_product_id: 'ext_anchor_suedish',
            title: 'Match Stix Contour \u2014 Suedish',
            brand: 'Fenty Beauty',
            category: 'Contour',
            product_type: 'Contour',
            product_payload: { variant_title: 'Shade: Suedish' },
            variant_title: 'Shade: Suedish',
            pivota_signature_id: 'sig_anchor_suedish',
            product_group_id: 'pg_anchor_suedish',
            is_primary: true,
            pdp_lifecycle_stage: 'published',
          },
          {
            input_ref: 'ext_match_stix_ebony',
            normalized_ref: 'ext_match_stix_ebony',
            source_product_id: 'ext_match_stix_ebony',
            title: 'Match Stix Contour \u2014 Ebony',
            brand: 'Fenty Beauty',
            category: 'Contour',
            product_type: 'Contour',
            product_payload: { variant_title: 'Shade: Ebony' },
            variant_title: 'Shade: Ebony',
            pivota_signature_id: 'sig_match_stix_ebony',
            product_group_id: 'pg_match_stix_ebony',
            is_primary: false,
            pdp_lifecycle_stage: 'published',
          },
          {
            input_ref: 'ext_rare_blush_joy',
            normalized_ref: 'ext_rare_blush_joy',
            source_product_id: 'ext_rare_blush_joy',
            title: 'Soft Pinch Liquid Blush - Joy',
            brand: 'Rare Beauty',
            category: 'Blush',
            product_type: 'Blush',
            product_payload: {},
            pivota_signature_id: 'sig_rare_blush_joy',
            product_group_id: 'pg_rare_blush_joy',
            is_primary: true,
            pdp_lifecycle_stage: 'published',
          },
        ],
      };
    });

    const context = await resolveSimilarFamilyDedupeContext({
      anchorProduct: anchor,
      items: [ownShade, otherProduct],
      queryFn,
    });
    const out = dedupeSimilarCandidatesByFamily([ownShade, otherProduct], context);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(context.anchorFamilyKey).toMatch(/^family:v1:/);
    expect(out).toEqual([otherProduct]);
  });

  test('collapses named shade variants when resolved catalog families match', () => {
    const ebony = {
      merchant_id: 'external_seed',
      product_id: 'sig_match_stix_ebony',
      source_product_id: 'EXT_MATCH_STIX_EBONY',
      source: 'external',
      brand: 'Fenty Beauty',
      title: 'Match Stix Contour \u2014 Ebony',
      category: 'Contour',
      product_type: 'Contour',
    };
    const espresso = {
      merchant_id: 'external_seed',
      product_id: 'sig_match_stix_espresso',
      source_product_id: 'ext_match_stix_espresso',
      source: 'external',
      brand: 'Fenty Beauty',
      title: 'Match Stix Contour \u2014 Espresso',
      category: 'Contour',
      product_type: 'Contour',
    };
    const familyKey = relationshipFamilyKey({
      product_id: 'ext_match_stix_ebony',
      title: 'Match Stix Contour',
      brand: 'Fenty Beauty',
      category: 'Contour',
      product_type: 'Contour',
      variant_title: 'Shade: Ebony',
    });
    const resolutionMap = new Map([
      ['ext_match_stix_ebony', { family_key: familyKey, family_key_source: 'derived_family_key' }],
      ['ext_match_stix_espresso', { family_key: familyKey, family_key_source: 'derived_family_key' }],
    ]);

    expect(dedupeSimilarCandidatesByFamily([ebony, espresso])).toEqual([ebony, espresso]);
    expect(dedupeSimilarCandidatesByFamily([ebony, espresso], { resolutionMap })).toEqual([ebony]);
  });

  test('prefers resolved family keys and falls back to title keys on resolution miss', () => {
    const sameTitleA = {
      merchant_id: 'external_seed',
      product_id: 'sig_resolved_a',
      source_product_id: 'ext_resolved_a',
      source: 'external',
      brand: 'Same Brand',
      title: 'Same Seller Title - 01',
      category: 'Makeup',
      product_type: 'Makeup',
    };
    const sameTitleB = {
      ...sameTitleA,
      product_id: 'sig_resolved_b',
      source_product_id: 'ext_resolved_b',
    };
    const resolutionMap = new Map([
      ['ext_resolved_a', { family_key: 'family:v1:resolved a::line a::makeup' }],
      ['ext_resolved_b', { family_key: 'family:v1:resolved b::line b::makeup' }],
    ]);

    expect(dedupeSimilarCandidatesByFamily([sameTitleA, sameTitleB])).toEqual([sameTitleA]);
    expect(dedupeSimilarCandidatesByFamily([sameTitleA, sameTitleB], { resolutionMap })).toEqual([
      sameTitleA,
      sameTitleB,
    ]);

    const shade185 = fentyConcealer({ product_id: 'sig_resolution_miss_185' });
    const shade255 = fentyConcealer({
      product_id: 'sig_resolution_miss_255',
      title: "Pro Filt'r Instant Retouch Concealer - 255",
    });

    expect(dedupeSimilarCandidatesByFamily([shade185, shade255], { resolutionMap })).toEqual([shade185]);
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
    const resolutionMap = new Map([
      ['sig_missing_a', { family_key: 'ref:sig_missing_a', family_key_source: 'fallback_ref' }],
      ['sig_missing_b', { family_key: 'ref:sig_missing_b', family_key_source: 'fallback_ref' }],
    ]);

    const out = dedupeSimilarCandidatesByFamily(
      [missingBrandTitleA, missingBrandTitleB, duplicateA],
      { resolutionMap },
    );

    expect(out).toEqual([missingBrandTitleA, missingBrandTitleB]);
  });

  test('fails closed to Phase 1 title behavior when resolution is unavailable', async () => {
    const ebony = {
      merchant_id: 'external_seed',
      product_id: 'sig_fail_closed_ebony',
      source_product_id: 'ext_fail_closed_ebony',
      source: 'external',
      brand: 'Fenty Beauty',
      title: 'Match Stix Contour \u2014 Ebony',
      category: 'Contour',
      product_type: 'Contour',
    };
    const espresso = {
      merchant_id: 'external_seed',
      product_id: 'sig_fail_closed_espresso',
      source_product_id: 'ext_fail_closed_espresso',
      source: 'external',
      brand: 'Fenty Beauty',
      title: 'Match Stix Contour \u2014 Espresso',
      category: 'Contour',
      product_type: 'Contour',
    };
    const phase1 = dedupeSimilarCandidatesByFamily([ebony, espresso]);
    const queryFn = jest.fn(async () => {
      throw new Error('catalog resolver offline');
    });

    const context = await resolveSimilarFamilyDedupeContext({
      anchorProduct: { merchant_id: 'external_seed', product_id: 'ext_fail_closed_anchor' },
      items: [ebony, espresso],
      queryFn,
    });
    const out = dedupeSimilarCandidatesByFamily([ebony, espresso], context);

    expect(context.resolutionMap).toBeNull();
    expect(out).toEqual(phase1);
    expect(out).toEqual([ebony, espresso]);
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
