const {
  classifyPostGraduation,
  qualityForRow,
} = require('../../scripts/graduate_ips_stuck_identity_approved.cjs');

function baseRow(overrides = {}) {
  return {
    catalog_title: 'Barrier Serum',
    catalog_brand: 'Pivota Test',
    catalog_product_type: 'Serum',
    catalog_description: 'A source-backed serum description with enough detail to clear the full deterministic description component. It explains texture, use case, and key benefits clearly.',
    catalog_image_url: 'https://example.test/serum.jpg',
    seed_price_amount: 24,
    product_payload: {},
    seed_data: {},
    identity_resolved: true,
    ...overrides,
  };
}

describe('graduate IPS deterministic quality scoring', () => {
  test('keeps summary and attributes at zero by default', () => {
    const row = baseRow({
      seed_data: {
        summary: 'A concise source-backed product summary that is long enough to score as a complete summary component.',
        pdp_details_sections: [{ heading: 'Benefits', content: 'Hydrates and supports the skin barrier.' }],
        pdp_how_to_use_raw: 'Apply after cleansing.',
        ingredient_intel: { inci_list: ['water'] },
      },
    });

    const quality = qualityForRow(row, { scoreOptionalComponents: false });

    expect(quality.content_quality_score).toBe(71.4);
    expect(quality.details.components.find((item) => item.name === 'summary').score).toBe(0);
    expect(quality.details.components.find((item) => item.name === 'attributes').score).toBe(0);
    expect(quality.details.source_backed_fields.optional_components_enabled).toBe(false);
  });

  test('scores source-backed summary and attributes when flag behavior is enabled', () => {
    const row = baseRow({
      seed_data: {
        summary: 'A concise source-backed product summary that is long enough to score as a complete summary component.',
        pdp_details_sections: [{ heading: 'Benefits', content: 'Hydrates and supports the skin barrier.' }],
        pdp_how_to_use_raw: 'Apply after cleansing.',
        ingredient_intel: { inci_list: ['water'] },
      },
    });

    const quality = qualityForRow(row, { scoreOptionalComponents: true });

    expect(quality.content_quality_score).toBe(100);
    expect(quality.details.components.find((item) => item.name === 'summary').score).toBe(100);
    expect(quality.details.components.find((item) => item.name === 'attributes').score).toBe(100);
    expect(quality.details.source_backed_fields.summary_length).toBeGreaterThanOrEqual(80);
    expect(quality.details.source_backed_fields.attribute_signal_count).toBe(3);
  });

  test('classification can clear low_quality only after optional scoring lifts the score', () => {
    const row = baseRow({
      catalog_description: 'x'.repeat(55),
      seed_data: {
        pdp_details_sections: [{ heading: 'Texture', content: 'Lightweight gel serum.' }],
      },
    });

    const historical = qualityForRow(row, { scoreOptionalComponents: false });
    const lifted = qualityForRow(row, { scoreOptionalComponents: true });

    expect(historical.content_quality_score).toBe(57.1);
    expect(lifted.content_quality_score).toBe(67.1);
    expect(classifyPostGraduation(historical, row).blockerCode).toBe('low_quality');
    expect(classifyPostGraduation(lifted, row).blockerCode).toBe('none');
  });
});
