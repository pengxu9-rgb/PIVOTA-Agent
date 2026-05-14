const {
  _internals: { buildPlan },
} = require('../../scripts/backfill-external-seed-reviewed-content-inheritance.cjs');

describe('backfill-external-seed-reviewed-content-inheritance', () => {
  test('copies reviewed parent INCI into a force-filled child without overwriting protected content', () => {
    const parentInci =
      'Water, Titanium Dioxide, Cyclopentasiloxane, Dimethicone, Trimethylsiloxysilicate, Propanediol, PEG-10 Dimethicone, Niacinamide, Isododecane, Magnesium Sulfate, Iron Oxides, Aluminum Hydroxide, Stearic Acid, Fragrance, Glycerin, Tocopherol.';
    const childInci =
      'Water, Glycerin, Butylene Glycol, Niacinamide, Phenoxyethanol, Tocopherol, Fragrance, Iron Oxides.';
    const rowsById = new Map([
      [
        'ext_child',
        {
          external_product_id: 'ext_child',
          title: 'Mask Fit Red Cushion Refill',
          canonical_url: 'https://tirtir.global/products/mask-fit-red-cushion-refill',
          seed_data: {
            snapshot: {},
            pdp_ingredients_raw: childInci,
            pdp_field_quality_summary: {
              ingredients_raw: {
                source_origin: 'pivota_force_fill',
                source_quality_status: 'force_filled_pending_source',
              },
            },
          },
        },
      ],
      [
        'ext_parent',
        {
          external_product_id: 'ext_parent',
          title: 'Mask Fit Red Cushion',
          canonical_url: 'https://tirtir.global/products/mask-fit-red-cushion',
          seed_data: {
            snapshot: {},
            pdp_ingredients_raw: parentInci,
            pdp_field_quality_summary: {
              ingredients_raw: {
                source_origin: 'official_html',
                source_quality_status: 'high',
              },
            },
          },
        },
      ],
    ]);

    const plan = buildPlan(
      {
        external_product_id: 'ext_child',
        source_external_product_id: 'ext_parent',
        fields: ['pdp_ingredients_raw'],
        reason_codes: ['reviewed_refill_same_formula_parent'],
        evidence_note: 'Reviewed refill uses the same official formula source as the parent cushion.',
      },
      rowsById,
      '2026-05-14T00:00:00.000Z',
    );

    expect(plan.result.status).toBe('dry_run');
    expect(plan.result.inherited_fields).toEqual(['pdp_ingredients_raw']);
    expect(plan.nextSeedData.pdp_ingredients_raw).toBe(parentInci);
    expect(plan.nextSeedData.pdp_field_quality_summary.ingredients_raw).toMatchObject({
      source_origin: 'reviewed_component_inheritance',
      source_quality_status: 'high',
      source_external_product_id: 'ext_parent',
    });
  });

  test('blocks when the child already has protected ingredients', () => {
    const parentInci =
      'Water, Titanium Dioxide, Cyclopentasiloxane, Dimethicone, Trimethylsiloxysilicate, Propanediol, PEG-10 Dimethicone, Niacinamide, Isododecane, Magnesium Sulfate, Iron Oxides, Aluminum Hydroxide, Stearic Acid, Fragrance, Glycerin, Tocopherol.';
    const childInci =
      'Aqua, Glycerin, Dimethicone, Butylene Glycol, Niacinamide, Phenoxyethanol, Tocopherol, Iron Oxides, Fragrance.';
    const rowsById = new Map([
      [
        'ext_child',
        {
          external_product_id: 'ext_child',
          title: 'Mask Fit Red Cushion Refill',
          canonical_url: 'https://tirtir.global/products/mask-fit-red-cushion-refill',
          seed_data: {
            snapshot: {},
            pdp_ingredients_raw: childInci,
            pdp_field_quality_summary: {
              ingredients_raw: {
                source_origin: 'official_html',
                source_quality_status: 'high',
              },
            },
          },
        },
      ],
      [
        'ext_parent',
        {
          external_product_id: 'ext_parent',
          title: 'Mask Fit Red Cushion',
          canonical_url: 'https://tirtir.global/products/mask-fit-red-cushion',
          seed_data: {
            snapshot: {},
            pdp_ingredients_raw: parentInci,
            pdp_field_quality_summary: {
              ingredients_raw: {
                source_origin: 'official_html',
                source_quality_status: 'high',
              },
            },
          },
        },
      ],
    ]);

    const plan = buildPlan(
      {
        external_product_id: 'ext_child',
        source_external_product_id: 'ext_parent',
        fields: ['pdp_ingredients_raw'],
      },
      rowsById,
      '2026-05-14T00:00:00.000Z',
    );

    expect(plan.result.status).toBe('blocked');
    expect(plan.result.blocking_reasons).toContain('child_ingredients_already_protected');
  });
});
