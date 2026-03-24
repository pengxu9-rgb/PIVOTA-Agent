const {
  buildGuardDecision,
  hasAcceptableLocale,
  looksLikeCatalogFeedUrl,
  looksLikeNonProductUrl,
} = require('../../scripts/run_external_seed_completeness_tranche.cjs');

describe('run_external_seed_completeness_tranche', () => {
  test('rejects catalog feed targets and locale drift for US seeds', () => {
    const decision = buildGuardDecision(
      {
        status: 'dry_run',
        target_url:
          'https://fentybeauty.com/products/skincare-lovrs-cleanser-toner-spf-moisturizer-collectors-case-1.js',
        next_state: {
          canonical_url: 'https://fentybeauty.com/en-nl/collections/fentyskin-startrs',
          pdp_description_raw_present: true,
          pdp_ingredients_raw_present: false,
          pdp_active_ingredients_raw_present: false,
          pdp_how_to_use_raw_present: false,
          pdp_details_sections_count: 0,
          raw_ingredient_text_clean_present: false,
        },
      },
      'US',
    );

    expect(decision.allow_apply).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'target_catalog_feed',
        'canonical_non_product',
        'canonical_market_locale_mismatch',
        'insufficient_key_field_gain',
      ]),
    );
  });

  test('allows direct US PDPs that add key fields', () => {
    const decision = buildGuardDecision(
      {
        status: 'dry_run',
        target_url: 'https://fentybeauty.com/products/fenty-treatz-hydrating-strengthening-lip-oil-cacao',
        next_state: {
          canonical_url: 'https://fentybeauty.com/products/fenty-treatz-hydrating-strengthening-lip-oil-cacao',
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

    expect(decision.allow_apply).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  test('locale and URL helpers classify expected patterns', () => {
    expect(looksLikeCatalogFeedUrl('https://example.com/products/foo.js')).toBe(true);
    expect(looksLikeNonProductUrl('https://example.com/en-nl/collections/foo')).toBe(true);
    expect(hasAcceptableLocale('https://example.com/products/foo', 'US')).toBe(true);
    expect(hasAcceptableLocale('https://example.com/en-us/products/foo', 'US')).toBe(true);
    expect(hasAcceptableLocale('https://example.com/en-nl/products/foo', 'US')).toBe(false);
  });
});
