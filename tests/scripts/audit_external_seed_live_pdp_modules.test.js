const {
  buildRowAudit,
  requiresVariantClarity,
} = require('../../scripts/audit-external-seed-live-pdp-modules.cjs');

function baseRow(overrides = {}) {
  return {
    id: 'eps_test',
    external_product_id: 'ext_test',
    market: 'US',
    domain: 'example.com',
    title: 'Single Formula Serum',
    canonical_url: 'https://example.com/products/single-formula-serum',
    seed_data: {
      title: 'Single Formula Serum',
      category_path: 'beauty/skincare/serum',
      snapshot: {
        title: 'Single Formula Serum',
        category_path: 'beauty/skincare/serum',
      },
    },
    ...overrides,
  };
}

function module(type, data = {}) {
  return { type, data };
}

function basePdp(variantData = { variants: [], options: [] }) {
  return {
    status: 'success',
    build_id: 'test_build',
    modules: [
      module('canonical', {
        pdp_payload: {
          product: {
            title: 'Single Formula Serum',
            category_path: 'beauty/skincare/serum',
            image_urls: ['https://cdn.example.com/serum.jpg'],
          },
        },
      }),
      module('variant_selector', variantData),
      module('offers', { price: { amount: 24, currency: 'USD' } }),
      module('product_intel', {
        quality_state: 'reviewed',
        evidence_profile: 'official_pdp_seed',
        product_intel_core: {
          what_it_is: { headline: 'Serum identity' },
          why_it_stands_out: ['Official PDP reviewed positioning.'],
        },
      }),
      module('ingredients_inci', {
        items: ['Water', 'Glycerin'],
        source_origin: 'official_pdp',
        source_quality_status: 'high',
      }),
      module('how_to_use', { steps: ['Apply to clean skin.'] }),
      module('product_overview', { body: 'A serum described from the official PDP.' }),
      module('product_details', { bullets: ['30 mL'] }),
      module('reviews_preview', { review_count: 0 }),
    ],
    missing: [],
  };
}

describe('audit-external-seed-live-pdp-modules', () => {
  test('does not require variant clarity for a single formula with no visible variant axis', () => {
    const audit = buildRowAudit(baseRow(), {
      http_status: 200,
      pdp: basePdp({ variants: [], options: [] }),
    });

    expect(audit.product_kind.family).toBe('single_formula');
    expect(audit.variant.ok).toBe(false);
    expect(audit.blocking_reasons).not.toContain('missing_variant_clarity');
    expect(audit.conversion_ready).toBe(true);
  });

  test('still requires readable labels for true multi-variant axes', () => {
    const audit = buildRowAudit(baseRow(), {
      http_status: 200,
      pdp: basePdp({
        variants: [{ title: 'Default Title' }, { title: 'Default Title' }],
        options: [],
      }),
    });

    expect(requiresVariantClarity(audit.variant)).toBe(true);
    expect(audit.blocking_reasons).toContain('missing_variant_clarity');
    expect(audit.conversion_ready).toBe(false);
  });
});
