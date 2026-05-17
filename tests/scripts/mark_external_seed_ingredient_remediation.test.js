const {
  buildPlan,
  hasForceFilledInci,
} = require('../../scripts/mark-external-seed-ingredient-remediation.cjs');

function baseRow(seedData) {
  return {
    external_product_id: 'ext_case',
    title: 'Test Serum',
    canonical_url: 'https://example.com/products/test-serum',
    destination_url: 'https://example.com/products/test-serum',
    seed_data: {
      title: 'Test Serum',
      category: 'skincare',
      snapshot: {},
      ...seedData,
    },
  };
}

function forceFillContract() {
  return {
    contract_version: 'pivota.pdp.force_fill.v1',
    field: 'ingredients_inci',
    source_origin: 'pivota_force_fill',
    source_quality_status: 'force_filled_pending_source',
    display_note:
      'Full INCI has not been captured from an approved source yet. Check the merchant page before purchase.',
  };
}

describe('mark-external-seed-ingredient-remediation', () => {
  test('treats stale force-fill contract as force-filled even when a note is present', () => {
    const row = baseRow({
      pdp_ingredients_raw:
        'Full INCI has not been captured from an approved source yet. Check the merchant page before purchase.',
      ingredient_intel: {
        force_fill_contract: forceFillContract(),
      },
      pdp_field_quality_summary: {
        ingredients_raw: {
          source_origin: 'unknown',
          source_quality_status: 'quarantined',
        },
      },
    });

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
    });

    expect(hasForceFilledInci(row.seed_data)).toBe(true);
    expect(plan.result.action).toBe('manual_source_review_required');
    expect(plan.result.status).toBe('dry_run');
    expect(plan.nextSeedData.ingredient_remediation_v1.action).toBe('manual_source_review_required');
    expect(plan.nextSeedData.pdp_field_quality_summary.ingredients_inci.source_quality_status).toBe('blocked');
  });

  test('clears stale force-fill contract without blocking trusted reviewed INCI', () => {
    const row = baseRow({
      ingredients_inci: ['Calophyllum Inophyllum Seed Oil'],
      ingredient_intel: {
        force_fill_contract: forceFillContract(),
      },
      pdp_field_quality_summary: {
        ingredients_raw: {
          source_origin: 'official_pdp',
          source_quality_status: 'high',
        },
        ingredients_inci: {
          source_origin: 'official_pdp',
          source_quality_status: 'high',
        },
      },
    });

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
    });

    expect(plan.result.action).toBe('clear_stale_force_fill_contract');
    expect(plan.result.status).toBe('dry_run');
    expect(plan.nextSeedData.ingredients_inci).toEqual(['Calophyllum Inophyllum Seed Oil']);
    expect(plan.nextSeedData.ingredient_intel.force_fill_contract).toBeUndefined();
    expect(plan.nextSeedData.ingredient_remediation_v1).toBeUndefined();
  });
});
