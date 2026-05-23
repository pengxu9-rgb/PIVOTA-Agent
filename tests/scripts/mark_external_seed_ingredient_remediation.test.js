const {
  buildServingBlockPatch,
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

  test('marks accessory rows as INCI not applicable', () => {
    const row = baseRow({
      title: 'Rumi Ultra-thin Spot Cover Patch with Case (28ea)',
      ingredient_intel: {
        force_fill_contract: forceFillContract(),
      },
      pdp_field_quality_summary: {
        ingredients_raw: {
          source_origin: 'pivota_force_fill',
          source_quality_status: 'force_filled_pending_source',
        },
      },
    });
    row.title = 'Rumi Ultra-thin Spot Cover Patch with Case (28ea)';

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
    });

    expect(plan.result.family).toBe('accessory');
    expect(plan.result.action).toBe('mark_inci_not_applicable');
    expect(plan.nextSeedData.ingredient_remediation_v1.action).toBe('mark_inci_not_applicable');
    expect(plan.nextSeedData.ingredient_intel.inci_applicability.status).toBe('not_applicable');
    expect(plan.nextSeedData.ingredient_intel.force_fill_contract).toBeUndefined();
  });

  test('allows explicit forced accessory family for manually reviewed component rows', () => {
    const row = baseRow({
      title: 'Lip Sleeping Mask Topper',
      ingredient_intel: {
        force_fill_contract: forceFillContract(),
      },
      pdp_field_quality_summary: {
        ingredients_raw: {
          source_origin: 'pivota_force_fill',
          source_quality_status: 'force_filled_pending_source',
        },
      },
    });
    row.title = 'Lip Sleeping Mask Topper';

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
      forceFamily: 'accessory',
    });

    expect(plan.result.classified_family).toBe('single_formula');
    expect(plan.result.family).toBe('accessory');
    expect(plan.result.forced_family).toBe('accessory');
    expect(plan.result.action).toBe('mark_inci_not_applicable');
    expect(plan.nextSeedData.product_family).toBe('accessory');
    expect(plan.nextSeedData.snapshot.product_family).toBe('accessory');
    expect(plan.nextSeedData.ingredient_intel.inci_applicability.status).toBe('not_applicable');
  });

  test('forced accessory family can replace an existing manual source review queue', () => {
    const row = baseRow({
      title: 'Lip Sleeping Mask Topper',
      ingredient_intel: {
        source_review_queue: {
          status: 'manual_source_review_required',
        },
      },
      ingredient_remediation_v1: {
        field: 'ingredients_inci',
        source_origin: 'pivota_manual_component_repair',
        action: 'manual_source_review_required',
        reason_codes: ['manual_ingredient_source_review_required'],
      },
    });
    row.title = 'Lip Sleeping Mask Topper';

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
      forceFamily: 'accessory',
    });

    expect(plan.changed).toBe(true);
    expect(plan.result.family).toBe('accessory');
    expect(plan.result.action).toBe('mark_inci_not_applicable');
    expect(plan.nextSeedData.product_family).toBe('accessory');
    expect(plan.nextSeedData.snapshot.product_family).toBe('accessory');
    expect(plan.nextSeedData.ingredient_remediation_v1.action).toBe('mark_inci_not_applicable');
    expect(plan.nextSeedData.ingredient_intel.inci_applicability.status).toBe('not_applicable');
  });

  test('forced accessory family can patch product family on already not-applicable rows', () => {
    const row = baseRow({
      title: 'Lip Sleeping Mask Topper',
      ingredient_intel: {
        inci_applicability: {
          status: 'not_applicable',
          reason: 'product_family_accessory',
        },
      },
      ingredient_remediation_v1: {
        field: 'ingredients_inci',
        source_origin: 'pivota_manual_component_repair',
        action: 'mark_inci_not_applicable',
        reason_codes: ['product_family_accessory'],
      },
    });
    row.title = 'Lip Sleeping Mask Topper';

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
      forceFamily: 'accessory',
    });

    expect(plan.changed).toBe(true);
    expect(plan.result.status).toBe('dry_run');
    expect(plan.result.action).toBe('mark_inci_not_applicable');
    expect(plan.nextSeedData.product_family).toBe('accessory');
    expect(plan.nextSeedData.snapshot.product_family).toBe('accessory');
  });

  test('clears stale force-fill contract on already-remediated not-applicable rows', () => {
    const row = baseRow({
      title: 'Rumi Ultra-thin Spot Cover Patch with Case (28ea)',
      ingredient_intel: {
        force_fill_contract: forceFillContract(),
        inci_applicability: {
          status: 'not_applicable',
          family: 'accessory',
          reason_codes: ['accessory_no_formula_inci'],
        },
      },
      ingredient_remediation_v1: {
        action: 'mark_inci_not_applicable',
        reason_codes: ['accessory_no_formula_inci'],
      },
    });
    row.title = 'Rumi Ultra-thin Spot Cover Patch with Case (28ea)';

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
    });

    expect(plan.result.action).toBe('mark_inci_not_applicable');
    expect(plan.result.status).toBe('dry_run');
    expect(plan.changed).toBe(true);
    expect(plan.nextSeedData.ingredient_remediation_v1.action).toBe('mark_inci_not_applicable');
    expect(plan.nextSeedData.ingredient_intel.inci_applicability.status).toBe('not_applicable');
    expect(plan.nextSeedData.ingredient_intel.force_fill_contract).toBeUndefined();
  });

  test('marks reviewed component-linked sets and clears stale force-fill contract', () => {
    const row = baseRow({
      title: 'Lip Liner & Gloss Duo',
      product_family: 'set_or_collection',
      bundle_component_refs: [
        {
          external_product_id: 'ext_liner',
          review_state: 'reviewed',
          inheritance_scope: ['ingredients_inci', 'how_to_use'],
        },
        {
          external_product_id: 'ext_gloss',
          review_state: 'reviewed',
          inheritance_scope: ['ingredients_inci', 'how_to_use'],
        },
      ],
      ingredient_intel: {
        force_fill_contract: forceFillContract(),
      },
      pdp_field_quality_summary: {
        ingredients_inci: {
          source_origin: 'pivota_force_fill',
          source_quality_status: 'force_filled_pending_source',
        },
      },
    });
    row.title = 'Lip Liner & Gloss Duo';

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
      forceFamily: 'set_or_collection',
    });

    expect(plan.result.action).toBe('component_refs_linked');
    expect(plan.result.status).toBe('dry_run');
    expect(plan.changed).toBe(true);
    expect(plan.nextSeedData.ingredient_intel.force_fill_contract).toBeUndefined();
    expect(plan.nextSeedData.ingredient_intel.source_review_queue.status).toBe('component_refs_linked');
    expect(plan.nextSeedData.ingredient_remediation_v1.action).toBe('component_refs_linked');
    expect(plan.nextSeedData.pdp_field_quality_summary.ingredients_inci).toMatchObject({
      source_origin: 'pivota_manual_component_repair',
      source_quality_status: 'component_refs_linked',
    });
  });

  test('clears stale force-fill contract on already-remediated component-linked sets', () => {
    const row = baseRow({
      title: 'Lip Liner & Gloss Duo',
      product_family: 'set_or_collection',
      bundle_component_refs: [
        {
          external_product_id: 'ext_liner',
          review_state: 'reviewed',
          inheritance_scope: ['ingredients_inci', 'how_to_use'],
        },
      ],
      ingredient_intel: {
        force_fill_contract: forceFillContract(),
        source_review_queue: {
          status: 'component_refs_linked',
        },
      },
      ingredient_remediation_v1: {
        field: 'ingredients_inci',
        source_origin: 'pivota_manual_component_repair',
        action: 'component_refs_linked',
        reason_codes: ['bundle_component_refs_linked'],
      },
    });
    row.title = 'Lip Liner & Gloss Duo';

    const plan = buildPlan(row, {
      generatedAt: '2026-05-17T00:00:00.000Z',
      apply: false,
    });

    expect(plan.result.action).toBe('component_refs_linked');
    expect(plan.result.status).toBe('dry_run');
    expect(plan.changed).toBe(true);
    expect(plan.nextSeedData.ingredient_intel.force_fill_contract).toBeUndefined();
    expect(plan.nextSeedData.ingredient_intel.source_review_queue.status).toBe('component_refs_linked');
    expect(plan.nextSeedData.pdp_field_quality_summary.ingredients_inci.source_quality_status).toBe(
      'component_refs_linked',
    );
  });

  test('serving mirror patch preserves trusted INCI only for stale-contract cleanup', () => {
    const seedData = {
      ingredients_inci: ['Calophyllum Inophyllum Seed Oil'],
      ingredient_intel: {
        inci_list: ['Calophyllum Inophyllum Seed Oil'],
        source_origin: 'official_pdp',
        source_quality_status: 'high',
      },
      pdp_field_quality_summary: {
        ingredients_inci: {
          source_origin: 'official_pdp',
          source_quality_status: 'high',
        },
      },
      snapshot: {},
    };

    expect(buildServingBlockPatch(seedData).ingredients_inci).toBeUndefined();
    expect(
      buildServingBlockPatch(seedData, { preserveTrustedIngredients: true }).ingredients_inci,
    ).toEqual(['Calophyllum Inophyllum Seed Oil']);
  });
});
