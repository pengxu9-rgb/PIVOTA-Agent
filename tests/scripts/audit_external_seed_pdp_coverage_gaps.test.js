const {
  classifyRow,
  classifyProductContext,
  summarizeRows,
} = require('../../scripts/audit-external-seed-pdp-coverage-gaps');

function row(overrides = {}) {
  return {
    id: 'seed_1',
    external_product_id: 'ext_1',
    market: 'US',
    tool: '*',
    domain: 'example.com',
    title: 'Daily Mineral Sunscreen SPF 50',
    canonical_url: 'https://example.com/products/daily-mineral-sunscreen',
    destination_url: 'https://example.com/products/daily-mineral-sunscreen',
    image_url: 'https://example.com/image.jpg',
    seed_data: {
      brand: 'Example',
      snapshot: {},
    },
    has_product_key_kb: false,
    has_identity: true,
    ...overrides,
  };
}

describe('audit-external-seed-pdp-coverage-gaps helpers', () => {
  test('classifies tool/accessory ingredient gaps as not applicable', () => {
    const result = classifyRow(
      row({
        title: 'Precision Powder Brush',
        canonical_url: 'https://example.com/products/precision-powder-brush',
        destination_url: 'https://example.com/products/precision-powder-brush',
        seed_data: {
          pdp_description_raw: 'A tapered makeup brush for powder placement.',
          pdp_details_sections: [{ heading: 'Details', body: 'Synthetic bristles.' }],
          snapshot: {},
        },
      }),
    );

    expect(result.product_context.product_family).toBe('tool_accessory');
    expect(result.field_status.inci).toBe('not_applicable');
    expect(result.field_status.active_ingredients).toBe('not_applicable_without_regulatory_active_signal');
  });

  test('treats missing SPF active ingredients as actionable while FAQ stays source optional', () => {
    const result = classifyRow(
      row({
        seed_data: {
          pdp_description_raw: 'A lightweight mineral sunscreen with broad spectrum protection.',
          pdp_details_sections: [{ heading: 'Benefits', body: 'Sheer mineral defense.' }],
          pdp_ingredients_raw: 'Water, Caprylic/Capric Triglyceride, Zinc Oxide',
          snapshot: {},
        },
      }),
    );

    expect(result.product_context.regulatory_active_expected).toBe(true);
    expect(result.field_status.active_ingredients).toBe('catalog_truth_or_backfill_candidate');
    expect(result.field_status.faq).toBe('source_optional_or_needs_truth_check');
  });

  test('blocks KB generation candidates when identity is missing', () => {
    const result = classifyRow(
      row({
        has_identity: false,
        seed_data: {
          pdp_description_raw: 'A detailed serum description with enough content to generate product intel.',
          pdp_details_sections: [{ heading: 'Benefits', body: 'Supports visible texture and clarity.' }],
          snapshot: {},
        },
      }),
    );

    expect(result.field_status.product_key_kb).toBe('blocked_missing_identity');
    expect(result.field_status.identity).toBe('identity_backfill_candidate');
  });

  test('summarizes raw and actionable gaps separately', () => {
    const rows = [
      classifyRow(row({ external_product_id: 'ext_a', has_product_key_kb: true })),
      classifyRow(
        row({
          external_product_id: 'ext_b',
          title: 'Precision Powder Brush',
          canonical_url: 'https://example.com/products/precision-powder-brush',
          destination_url: 'https://example.com/products/precision-powder-brush',
          seed_data: { pdp_details_sections: [{ heading: 'Details', body: 'Synthetic bristles.' }], snapshot: {} },
        }),
      ),
    ];
    const summary = summarizeRows(rows);

    expect(summary.raw_missing_by_field.faq).toBe(2);
    expect(summary.raw_missing_by_field.active_ingredients).toBe(2);
    expect(summary.actionable_missing_by_field.active_ingredients).toBe(1);
    expect(summary.by_field_status.faq.source_optional_or_needs_truth_check).toBe(2);
  });

  test('context classifier keeps formula products distinct from accessories', () => {
    expect(
      classifyProductContext(
        row({
          title: 'Blurring Powder Brush',
          canonical_url: 'https://example.com/products/blurring-powder-brush',
          destination_url: 'https://example.com/products/blurring-powder-brush',
        }),
      ).product_family,
    ).toBe('tool_accessory');
    expect(
      classifyProductContext(
        row({
          title: 'Blurring Setting Powder',
          canonical_url: 'https://example.com/products/blurring-setting-powder',
          destination_url: 'https://example.com/products/blurring-setting-powder',
        }),
      ).product_family,
    ).toBe('makeup');
  });
});
