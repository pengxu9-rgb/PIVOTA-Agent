jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    normalizeSizeUnitSpacing,
    isValidSpecValue,
    buildSpecBackfillPlanForRow,
    summarizePlans,
  },
} = require('../../scripts/backfill-reviewed-external-seed-product-specs.cjs');

describe('backfill-reviewed-external-seed-product-specs', () => {
  test('normalizes unit spacing without inventing a spec', () => {
    expect(normalizeSizeUnitSpacing('30ml')).toBe('30 mL');
    expect(normalizeSizeUnitSpacing('70pads / 160ml')).toBe('70 pads / 160 mL');
    expect(isValidSpecValue('Default Title')).toBe(false);
    expect(isValidSpecValue('30 mL')).toBe(true);
  });

  test('plans reviewed single-SKU size fields into root and snapshot', () => {
    const plan = buildSpecBackfillPlanForRow(
      {
        id: 'seed_tirtir_c24',
        external_product_id: 'ext_e2e6c1d3f3d55314bd0a3702',
        title: 'Pure Vitamin C24 Serum',
        seed_data: {
          brand: 'TIRTIR',
          snapshot: {
            title: 'Pure Vitamin C24 Serum',
            variants: [
              {
                variant_id: '01TTS0011',
                title: 'Default Title',
                option_name: 'Title',
                option_value: 'Default Title',
              },
            ],
          },
        },
      },
      {
        external_product_id: 'ext_e2e6c1d3f3d55314bd0a3702',
        brand: 'TIRTIR',
        title: 'Pure Vitamin C24 Serum',
        size_detail_label: '1.01 fl oz / 30ml',
        net_content: '30ml',
        net_size: '1.01 fl oz',
        sources: [
          {
            source_kind: 'recognized_retailer_product_spec',
            source_url: 'https://www.iherb.com/pr/tirtir-pure-vitamin-c24-serum-1-01-fl-oz-30-ml/140612',
          },
        ],
      },
    );

    expect(plan.status).toBe('planned');
    expect(plan.next_seed_data.size_detail_label).toBe('1.01 fl oz / 30 mL');
    expect(plan.next_seed_data.snapshot.size_detail_label).toBe('1.01 fl oz / 30 mL');
    expect(plan.next_seed_data.net_content).toBe('30 mL');
    expect(plan.next_seed_data.snapshot.net_size).toBe('1.01 fl oz');
    expect(plan.next_seed_data.reviewed_product_specs_v1).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.reviewed_product_specs.v1',
        source_origin: 'reviewed_seed_map',
        source_quality_status: 'high',
      }),
    );
    expect(plan.next_seed_data.external_seed_snapshot_contract.legacy_fields_quarantined).toBe(true);
  });

  test('blocks mismatched reviewed specs instead of cross-writing by brand', () => {
    const plan = buildSpecBackfillPlanForRow(
      {
        id: 'seed_tirtir_other',
        external_product_id: 'ext_other',
        title: 'Mask Fit Makeup Fixer',
        seed_data: { brand: 'TIRTIR', snapshot: { title: 'Mask Fit Makeup Fixer' } },
      },
      {
        external_product_id: 'ext_other',
        brand: 'TIRTIR',
        title: 'Pure Vitamin C24 Serum',
        size_detail_label: '30 mL',
        sources: [{ source_kind: 'recognized_retailer_product_spec', source_url: 'https://example.com/spec' }],
      },
    );

    expect(plan.status).toBe('blocked');
    expect(plan.blocking_reasons).toContain('title_mismatch');
  });

  test('is idempotent when reviewed spec fields and contracts are already fresh', () => {
    const sources = [
      {
        source_kind: 'recognized_retailer_product_spec',
        source_url: 'https://www.yesstyle.com/en/tirtir-matcha-tea-pads-70-pads/info.html/pid.1137403229',
      },
    ];
    const existingSpecContract = {
      contract_version: 'external_seed.reviewed_product_specs.v1',
      source_origin: 'reviewed_seed_map',
      source_quality_status: 'high',
      fields: ['size_detail_label', 'net_content', 'net_size'],
      sources,
    };
    const existingSnapshotContract = {
      contract_version: 'external_seed.snapshot_contract.v1',
      authoritative: true,
      structured_fields_authoritative: true,
      legacy_fields_quarantined: true,
      replace_strategy: 'replace_not_merge',
    };
    const quality = {
      size_detail_label: { source_origin: 'reviewed_seed_map', source_quality_status: 'high' },
      net_content: { source_origin: 'reviewed_seed_map', source_quality_status: 'high' },
      net_size: { source_origin: 'reviewed_seed_map', source_quality_status: 'high' },
    };

    const plan = buildSpecBackfillPlanForRow(
      {
        id: 'seed_tirtir_matcha_pads',
        external_product_id: 'ext_2ed925c42fe7f2dfd73f98db',
        title: 'Matcha Tea Pads',
        seed_data: {
          brand: 'TIRTIR',
          size_detail_label: '70 pads / 160 mL',
          net_content: '70 pads',
          net_size: '160 mL',
          reviewed_product_specs_v1: existingSpecContract,
          external_seed_snapshot_contract: existingSnapshotContract,
          pdp_field_quality_summary: quality,
          snapshot: {
            title: 'Matcha Tea Pads',
            size_detail_label: '70 pads / 160 mL',
            net_content: '70 pads',
            net_size: '160 mL',
            reviewed_product_specs_v1: existingSpecContract,
            external_seed_snapshot_contract: existingSnapshotContract,
            pdp_field_quality_summary: quality,
          },
        },
      },
      {
        external_product_id: 'ext_2ed925c42fe7f2dfd73f98db',
        brand: 'TIRTIR',
        title: 'Matcha Tea Pads',
        size_detail_label: '70 pads / 160 mL',
        net_content: '70 pads',
        net_size: '160 mL',
        sources,
      },
    );

    expect(plan.status).toBe('unchanged');
    expect(plan.changed).toBe(false);
  });

  test('summarizes planned and blocked rows for audit', () => {
    const summary = summarizePlans([
      { status: 'planned', patch_keys: ['size_detail_label', 'net_content'] },
      { status: 'blocked', blocking_reasons: ['title_mismatch'] },
    ]);

    expect(summary.planned).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.by_patch_key.size_detail_label).toBe(1);
    expect(summary.blocking_reasons.title_mismatch).toBe(1);
  });
});
