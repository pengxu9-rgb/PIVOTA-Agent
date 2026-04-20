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

  test('classifies non-formula brand accessories as tool/accessory gaps', () => {
    const titles = [
      'The Oversized Scrunchie',
      'Fenty Skin Baseball Hat',
      'Fenty Hair Satin Scarf',
      'Teddy Travel Bag',
      'LED Vanity Mirror',
      "Trace'd Out Dual Pencil Sharpener",
    ];

    for (const title of titles) {
      const result = classifyRow(
        row({
          title,
          canonical_url: `https://example.com/products/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          destination_url: `https://example.com/products/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          seed_data: {
            pdp_description_raw: `${title} accessory listing.`,
            snapshot: {},
          },
        }),
      );

      expect(result.product_context.product_family).toBe('tool_accessory');
      expect(result.field_status.inci).toBe('not_applicable');
      expect(result.field_status.active_ingredients).toBe('not_applicable_without_regulatory_active_signal');
    }
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

  test('separates identity review queue rows from automatic identity candidates', () => {
    const result = classifyRow(
      row({
        has_identity: false,
        has_any_identity: true,
        identity_review_or_live_blocked: true,
        seed_data: {
          pdp_description_raw: 'A detailed serum description with enough content to generate product intel.',
          pdp_details_sections: [{ heading: 'Benefits', body: 'Supports visible texture and clarity.' }],
          snapshot: {},
        },
      }),
    );

    expect(result.field_status.identity).toBe('identity_review_queue_or_live_blocked');
    expect(result.field_status.product_key_kb).toBe('blocked_identity_review_queue_or_live_disabled');
    expect(result.actionable_fields).not.toContain('identity');
    expect(result.actionable_fields).not.toContain('product_key_kb');
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

  test('summarizes fragmented product-line identity groups separately from missing identity', () => {
    const rows = [
      classifyRow(
        row({
          external_product_id: 'ext_foundation_190',
          title: "Pro Filt'r Soft Matte Longwear Foundation — #190",
          has_product_key_kb: true,
          identity_product_line_id: 'pl_190',
          identity_sellable_item_group_id: 'sig_190',
        }),
      ),
      classifyRow(
        row({
          external_product_id: 'ext_foundation_235',
          title: "Pro Filt'r Soft Matte Longwear Foundation — #235",
          has_product_key_kb: true,
          identity_product_line_id: 'pl_235',
          identity_sellable_item_group_id: 'sig_235',
        }),
      ),
      classifyRow(
        row({
          external_product_id: 'ext_foundation_300',
          title: "Pro Filt'r Soft Matte Longwear Foundation — #300",
          has_product_key_kb: true,
          identity_product_line_id: 'pl_300',
          identity_sellable_item_group_id: 'sig_300',
        }),
      ),
    ];

    const summary = summarizeRows(rows);

    expect(summary.by_field_status.identity.present).toBe(3);
    expect(summary.identity_fragmentation.affected_rows).toBe(3);
    expect(summary.identity_fragmentation.fragmented_groups).toBe(1);
    expect(summary.identity_fragmentation.top_groups[0]).toEqual(
      expect.objectContaining({
        product_line_key: 'pro filtr soft matte longwear foundation',
        distinct_product_line_ids: 3,
      }),
    );
    expect(summary.candidate_external_product_ids.product_line_fragmentation_candidate).toEqual([
      'ext_foundation_190',
      'ext_foundation_235',
      'ext_foundation_300',
    ]);
  });

  test('does not count non-merchandise gift cards as product-line fragmentation', () => {
    const rows = [
      classifyRow(
        row({
          external_product_id: 'ext_gift_25',
          title: 'Pixi E-Gift Card 25',
          has_product_key_kb: true,
          identity_product_line_id: 'pl_gift_25',
          identity_sellable_item_group_id: 'sig_gift_25',
        }),
      ),
      classifyRow(
        row({
          external_product_id: 'ext_gift_50',
          title: 'Pixi E-Gift Card 50',
          has_product_key_kb: true,
          identity_product_line_id: 'pl_gift_50',
          identity_sellable_item_group_id: 'sig_gift_50',
        }),
      ),
      classifyRow(
        row({
          external_product_id: 'ext_gift_75',
          title: 'Pixi E-Gift Card 75',
          has_product_key_kb: true,
          identity_product_line_id: 'pl_gift_75',
          identity_sellable_item_group_id: 'sig_gift_75',
        }),
      ),
    ];

    const summary = summarizeRows(rows);

    expect(summary.by_product_family.non_merchandise).toBe(3);
    expect(summary.identity_fragmentation.affected_rows).toBe(0);
    expect(summary.identity_fragmentation.fragmented_groups).toBe(0);
    expect(summary.candidate_external_product_ids.product_line_fragmentation_candidate).toEqual([]);
  });

  test('treats plural e-gift card PDPs as non-merchandise coverage gaps', () => {
    const result = classifyRow(
      row({
        external_product_id: 'ext_fenty_gift_cards',
        title: 'Fenty Beauty E-Gift Cards',
        canonical_url: 'https://fentybeauty.com/products/egift-cards',
        destination_url: 'https://fentybeauty.com/products/egift-cards',
        has_product_key_kb: false,
        has_identity: false,
        has_any_identity: true,
      }),
    );

    expect(result.product_context.product_family).toBe('non_merchandise');
    expect(result.field_status.identity).toBe('not_applicable');
    expect(result.field_status.product_key_kb).toBe('not_applicable');
    expect(result.actionable_fields).toEqual([]);
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
