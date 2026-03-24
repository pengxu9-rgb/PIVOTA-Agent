const {
  summarizeNextState,
  summarizeResults,
} = require('../../scripts/scan_external_seed_completeness_candidates.cjs');

describe('scan_external_seed_completeness_candidates', () => {
  test('summarizeNextState reads top-level and snapshot seed fields', () => {
    const row = {
      id: 'eps_test',
      title: 'Test Product',
      canonical_url: 'https://example.com/products/test-product',
    };
    const nextRow = {
      seed_data: {
        snapshot: {
          pdp_description_raw: 'Desc',
          pdp_details_sections: [{ heading: 'How', body: 'Use gently' }],
          raw_ingredient_text_clean: 'Water, Glycerin',
        },
        pdp_ingredients_raw: 'Water, Glycerin',
      },
    };

    expect(summarizeNextState(row, nextRow)).toEqual({
      seed_id: 'eps_test',
      title: 'Test Product',
      canonical_url: 'https://example.com/products/test-product',
      seed_description_origin: null,
      pdp_description_raw_present: true,
      pdp_ingredients_raw_present: true,
      pdp_active_ingredients_raw_present: false,
      pdp_how_to_use_raw_present: false,
      pdp_details_sections_count: 1,
      raw_ingredient_text_clean_present: true,
    });
  });

  test('summarizeResults separates guard-allowed from blocked dry runs', () => {
    const summary = summarizeResults([
      { status: 'dry_run', guard: { allow_apply: true, reasons: [] } },
      { status: 'dry_run', guard: { allow_apply: false, reasons: ['insufficient_key_field_gain'] } },
      { status: 'skipped', guard: { allow_apply: false, reasons: ['not_dry_run_candidate'] } },
      { status: 'failed', guard: { allow_apply: false, reasons: [] } },
    ]);

    expect(summary).toEqual({
      scanned: 4,
      dry_run: 2,
      skipped: 1,
      failed: 1,
      guard_apply_allowed: 1,
      guard_apply_blocked: 1,
      blocked_by_reason: {
        insufficient_key_field_gain: 1,
      },
    });
  });
});
