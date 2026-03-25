const {
  buildBatchCandidateDecision,
  chunkList,
  detectCrossBrandTitleAnomaly,
  detectSuspiciousTitleShift,
  hasSubstantiveCompletenessImprovement,
  looksLikeAccessoryToolProduct,
  looksLikeBundleLikeProduct,
  looksLikeMarketingPartialTitle,
  normalizeTitleForComparison,
  summarizeTitleOverlap,
  summarizeCompletenessDelta,
  summarizeMissingFields,
} = require('../../scripts/run_external_seed_completeness_batches.cjs');

describe('run_external_seed_completeness_batches', () => {
  test('summarizeMissingFields marks incomplete completeness contract fields', () => {
    expect(
      summarizeMissingFields({
        pdp_description_raw_present: true,
        pdp_ingredients_raw_present: false,
        pdp_active_ingredients_raw_present: false,
        pdp_how_to_use_raw_present: true,
        pdp_details_sections_count: 0,
        raw_ingredient_text_clean_present: false,
      }),
    ).toEqual(['ingredients_or_active', 'pdp_details_sections', 'raw_ingredient_text_clean']);
  });

  test('summarizeCompletenessDelta detects field improvements without regressions', () => {
    const delta = summarizeCompletenessDelta(
      {
        pdp_description_raw_present: true,
        pdp_ingredients_raw_present: false,
        pdp_active_ingredients_raw_present: false,
        pdp_how_to_use_raw_present: false,
        pdp_details_sections_count: 0,
        raw_ingredient_text_clean_present: false,
      },
      {
        pdp_description_raw_present: true,
        pdp_ingredients_raw_present: true,
        pdp_active_ingredients_raw_present: false,
        pdp_how_to_use_raw_present: true,
        pdp_details_sections_count: 3,
        raw_ingredient_text_clean_present: true,
      },
    );

    expect(delta.improved_fields).toEqual([
      'ingredients_or_active',
      'pdp_how_to_use_raw',
      'pdp_details_sections',
      'raw_ingredient_text_clean',
    ]);
    expect(delta.regressed_fields).toEqual([]);
    expect(delta.improved).toBe(true);
    expect(delta.regressed).toBe(false);
    expect(hasSubstantiveCompletenessImprovement(delta)).toBe(true);
  });

  test('hasSubstantiveCompletenessImprovement ignores description-plus-details only gains', () => {
    const delta = summarizeCompletenessDelta(
      {
        pdp_description_raw_present: false,
        pdp_ingredients_raw_present: false,
        pdp_active_ingredients_raw_present: false,
        pdp_how_to_use_raw_present: false,
        pdp_details_sections_count: 0,
        raw_ingredient_text_clean_present: false,
      },
      {
        pdp_description_raw_present: true,
        pdp_ingredients_raw_present: false,
        pdp_active_ingredients_raw_present: false,
        pdp_how_to_use_raw_present: false,
        pdp_details_sections_count: 1,
        raw_ingredient_text_clean_present: false,
      },
    );

    expect(delta.improved_fields).toEqual(['pdp_description_raw', 'pdp_details_sections']);
    expect(hasSubstantiveCompletenessImprovement(delta)).toBe(false);
  });

  test('buildBatchCandidateDecision blocks dry runs with no missing-field improvement', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        target_url: 'https://olehenriksen.com/products/example-product',
        before_state: {
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: true,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 2,
          raw_ingredient_text_clean_present: true,
        },
        next_state: {
          canonical_url: 'https://olehenriksen.com/products/example-product',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: true,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 2,
          raw_ingredient_text_clean_present: true,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['no_missing_field_improvement']));
  });

  test('buildBatchCandidateDecision blocks regressions even if base guard would allow apply', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        target_url: 'https://olehenriksen.com/products/example-product',
        before_state: {
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: true,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 2,
          raw_ingredient_text_clean_present: true,
        },
        next_state: {
          canonical_url: 'https://olehenriksen.com/products/example-product',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: true,
          pdp_details_sections_count: 3,
          raw_ingredient_text_clean_present: true,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['regressed_existing_field']));
  });

  test('buildBatchCandidateDecision blocks bundle-like products by default', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        title: 'Best of Ole Skincare Essential Set',
        target_url: 'https://olehenriksen.com/products/best-of-ole-skincare-essential-set-global',
        before_state: {
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
        next_state: {
          canonical_url: 'https://olehenriksen.com/products/best-of-ole-skincare-essential-set-global',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: true,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: true,
          pdp_details_sections_count: 3,
          raw_ingredient_text_clean_present: true,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['bundle_like_product']));
  });

  test('buildBatchCandidateDecision blocks cross-brand title anomalies', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        title: 'MUFE Artist Color Pencil Extreme Smudge-Proof Lip Liner',
        target_url: 'https://olehenriksen.com/products/mufe-artist-color-pencil-extreme-smudge-proof-lip-liner',
        before_state: {
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
        next_state: {
          canonical_url: 'https://olehenriksen.com/products/mufe-artist-color-pencil-extreme-smudge-proof-lip-liner',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: true,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: true,
          pdp_details_sections_count: 3,
          raw_ingredient_text_clean_present: true,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['cross_brand_title_anomaly']));
    expect(decision.cross_brand_anomaly).toEqual({
      foreign_brand: 'mufe',
      current_host: 'olehenriksen.com',
    });
  });

  test('chunkList creates deterministic batch slices', () => {
    expect(chunkList(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  test('looksLikeBundleLikeProduct catches common set language', () => {
    expect(looksLikeBundleLikeProduct('Glow Strong Mini Moisturizer + Eye Cream Duo')).toBe(true);
    expect(looksLikeBundleLikeProduct('BeamCream Smoothing Body Moisturizer')).toBe(false);
  });

  test('looksLikeAccessoryToolProduct catches brush-style tools', () => {
    expect(looksLikeAccessoryToolProduct('Foundation Brush 02')).toBe(true);
    expect(looksLikeAccessoryToolProduct('BeamCream Smoothing Body Moisturizer')).toBe(false);
  });

  test('normalizeTitleForComparison normalizes punctuation and case', () => {
    expect(normalizeTitleForComparison("Rose D'Amalfi Eau de Parfum")).toBe('rose d amalfi eau de parfum');
  });

  test('summarizeTitleOverlap reports high containment for close title matches', () => {
    expect(summarizeTitleOverlap('Cleansing Concentrate', 'TOM FORD RESEARCH Cleansing Concentrate')).toMatchObject({
      shared_count: 2,
      containment: 1,
    });
  });

  test('detectSuspiciousTitleShift flags low-overlap successor title shifts', () => {
    expect(
      detectSuspiciousTitleShift(
        'Shade and Illuminate Radiance Enhancer',
        'Shade and Illuminate Concealer',
      ),
    ).toMatchObject({
      shared_count: 2,
    });
  });

  test('detectSuspiciousTitleShift allows exact or near-contained successor titles', () => {
    expect(
      detectSuspiciousTitleShift(
        'Cleansing Concentrate',
        'TOM FORD RESEARCH Cleansing Concentrate',
      ),
    ).toBeNull();
  });

  test('detectCrossBrandTitleAnomaly allows matching domain brand families', () => {
    expect(
      detectCrossBrandTitleAnomaly(
        'Fenty Treatz Hydrating + Strengthening Lip Oil',
        'https://fentybeauty.com/products/fenty-treatz-hydrating-strengthening-lip-oil-cacao',
        {
          canonical_url:
            'https://fentybeauty.com/products/fenty-treatz-hydrating-strengthening-lip-oil-cacao',
        },
      ),
    ).toBeNull();
  });

  test('buildBatchCandidateDecision blocks details-only improvements', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        title: 'Pout Preserve Peptide Lip Treatment Grape Fizz',
        target_url: 'https://olehenriksen.com/products/pout-preserve-peptide-lip-treatment-grape-fizz',
        before_state: {
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
        next_state: {
          canonical_url: 'https://olehenriksen.com/products/pout-preserve-peptide-lip-treatment-grape-fizz',
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 1,
          raw_ingredient_text_clean_present: false,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['details_only_improvement']));
  });

  test('buildBatchCandidateDecision blocks description-plus-details-only improvements', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        title: 'NUXE Iconics',
        target_url: 'https://us.nuxe.com/products/nuxe-iconics',
        before_state: {
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
        next_state: {
          canonical_url: 'https://us.nuxe.com/products/nuxe-iconics',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 1,
          raw_ingredient_text_clean_present: false,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['details_only_improvement']));
  });

  test('buildBatchCandidateDecision blocks marketing partial titles', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        title: 'The Radiance Ritual',
        target_url: 'https://us.nuxe.com/products/the-radiance-ritual',
        before_state: {
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
        next_state: {
          canonical_url: 'https://us.nuxe.com/products/the-radiance-ritual',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 1,
          raw_ingredient_text_clean_present: false,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['marketing_partial_title']));
  });

  test('buildBatchCandidateDecision blocks accessory tool products', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        title: 'Foundation Brush 02',
        target_url: 'https://www.tomfordbeauty.com/products/foundation-brush-02',
        before_state: {
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
        next_state: {
          canonical_url: 'https://www.tomfordbeauty.com/products/foundation-brush-02',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: true,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 2,
          raw_ingredient_text_clean_present: false,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['accessory_tool_product']));
  });

  test('buildBatchCandidateDecision blocks suspicious title-shift successors', () => {
    const decision = buildBatchCandidateDecision(
      {
        status: 'dry_run',
        title: 'Shade and Illuminate Radiance Enhancer',
        target_url: 'https://www.tomfordbeauty.com/product/shade-and-illuminate-radiance-enhancer?shade=Light',
        before_state: {
          pdp_description_raw_present: false,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
        next_state: {
          title: 'Shade and Illuminate Concealer',
          canonical_url: 'https://www.tomfordbeauty.com/products/shade-and-illuminate-concealer',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: true,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: true,
          pdp_details_sections_count: 3,
          raw_ingredient_text_clean_present: true,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['title_shift_successor']));
    expect(decision.title_shift_anomaly).toMatchObject({
      shared_count: 2,
    });
  });

  test('looksLikeMarketingPartialTitle catches NUXE weak partial titles', () => {
    expect(looksLikeMarketingPartialTitle('Holidays Giftset The Iconics')).toBe(true);
    expect(looksLikeMarketingPartialTitle('The Prodigieux Hair Glow-Up')).toBe(true);
    expect(looksLikeMarketingPartialTitle('Detangling Leave-in Hair Milk')).toBe(false);
  });
});
