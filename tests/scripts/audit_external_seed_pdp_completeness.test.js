const {
  classifyExtractorCompleteness,
  classifySeedPdpSyncStatus,
  classifyAuditBucket,
} = require('../../scripts/audit_external_seed_pdp_completeness.cjs');

describe('audit_external_seed_pdp_completeness', () => {
  test('treats partial extractor + partial seed coverage as synced', () => {
    const extractorProduct = {
      description_raw: 'A sample card.',
    };
    const row = {
      seed_data: {
        pdp_description_raw: 'A sample card.',
      },
    };

    expect(classifyExtractorCompleteness(extractorProduct)).toBe('partial');
    expect(classifySeedPdpSyncStatus(extractorProduct, row)).toBe('synced');
  });

  test('keeps present extractor + partial seed coverage as extractor_only_unsynced', () => {
    const extractorProduct = {
      description_raw: 'A brush.',
      details_sections: [
        {
          heading: 'Details',
          body: 'Soft synthetic bristles.',
          source_kind: 'accordion_button',
        },
      ],
      how_to_use_raw: 'Sweep over the face.',
    };
    const row = {
      seed_data: {
        pdp_description_raw: 'A brush.',
      },
    };

    expect(classifyExtractorCompleteness(extractorProduct)).toBe('present');
    expect(classifySeedPdpSyncStatus(extractorProduct, row)).toBe('extractor_only_unsynced');
  });

  test('classifies partial extractor + partial seed rows as ok rather than writeback gap', () => {
    const extractorProduct = {
      description_raw: 'A sample card.',
    };
    const row = {
      seed_data: {
        pdp_description_raw: 'A sample card.',
      },
    };

    const bucket = classifyAuditBucket({
      extractorResponse: { diagnostics: { failure_category: null } },
      extractorProduct,
      row,
      audit: { findings: [] },
      pageTruth: {
        has_ingredients_module: false,
        has_active_ingredients_module: false,
        has_inci_module: false,
        has_details_module: true,
        has_how_to_use_module: false,
      },
    });

    expect(bucket).toBe('ok');
  });

  test('routes non-product fallback findings into a quarantine bucket', () => {
    const bucket = classifyAuditBucket({
      extractorResponse: { diagnostics: { failure_category: null } },
      extractorProduct: {
        description_raw: 'Digital gift card.',
      },
      row: {
        seed_data: {},
      },
      audit: {
        findings: [
          {
            anomaly_type: 'non_product_fallback_page',
          },
        ],
      },
      pageTruth: {
        has_ingredients_module: false,
        has_active_ingredients_module: false,
        has_inci_module: false,
        has_details_module: true,
        has_how_to_use_module: false,
      },
    });

    expect(bucket).toBe('non_product_fallback');
  });
});
