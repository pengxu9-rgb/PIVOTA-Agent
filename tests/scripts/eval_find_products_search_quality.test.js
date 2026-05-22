const {
  evaluateSearchResponse,
  requestJson,
  summarizeResults,
} = require('../../scripts/eval-find-products-search-quality.cjs');

function product(overrides = {}) {
  return {
    product_id: 'ext_1',
    merchant_id: 'external_seed',
    title: 'Fenty Icon Velvet Liquid Lipstick',
    brand: 'Fenty Beauty',
    category: 'Lipstick',
    product_type: 'Lipstick',
    catalog_category_path: 'beauty/makeup/lip/lipstick',
    image_url: 'https://cdn.example.com/lip.jpg',
    price: 29,
    pdp_open: {
      product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_1',
      },
    },
    ...overrides,
  };
}

describe('eval-find-products-search-quality', () => {
  test('passes a compliant beauty response', () => {
    const result = evaluateSearchResponse(
      {
        id: 'fenty_lipstick',
        query: 'fenty lipstick',
        expected_contract: { query_class: 'brand_category', target_domain: 'beauty' },
        allowed_brands: ['fenty beauty'],
        allowed_category_prefixes: ['beauty/makeup/lip'],
        forbidden_terms: ['lip oil'],
        min_result_count: 1,
      },
      {
        products: [product()],
        metadata: {
          search_quality_contract: { query_class: 'brand_category', target_domain: 'beauty' },
          canonical_product_count: 4,
          canonical_returned_count: 1,
        },
      },
    );

    expect(result.passed).toBe(true);
    expect(result.metrics.hard_constraint_violation_count).toBe(0);
    expect(result.metrics.missing_image_count).toBe(0);
    expect(result.metrics.invalid_price_count).toBe(0);
    expect(result.metrics.missing_or_open_failed_pdp_count).toBe(0);
  });

  test('flags hard constraint and quality violations in top products', () => {
    const result = evaluateSearchResponse(
      {
        id: 'fenty_lipstick',
        query: 'fenty lipstick',
        expected_contract: { query_class: 'brand_category', target_domain: 'beauty' },
        allowed_brands: ['fenty beauty'],
        allowed_category_prefixes: ['beauty/makeup/lip'],
        forbidden_terms: ['lip oil'],
        min_result_count: 1,
      },
      {
        products: [
          product({
            title: 'Rare Beauty Lip Oil',
            brand: 'Rare Beauty',
            category: 'external',
            product_type: 'external',
            catalog_category_path: 'beauty/makeup/lip/lip-oil',
            image_url: '',
            price: 0,
            pdp_open: null,
          }),
        ],
        metadata: {
          search_quality_contract: { query_class: 'brand_browse', target_domain: 'beauty' },
        },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.top6_hard_constraint_violations.map((item) => item.type)).toEqual(
      expect.arrayContaining(['contract_query_class_mismatch', 'brand_mismatch', 'forbidden_term']),
    );
    expect(result.metrics.missing_image_count).toBe(1);
    expect(result.metrics.invalid_price_count).toBe(1);
    expect(result.metrics.missing_or_open_failed_pdp_count).toBe(1);
    expect(result.metrics.polluted_row_count).toBe(1);
  });

  test('summarizes eval results across cases', () => {
    const summary = summarizeResults([
      { passed: true, metrics: { hard_constraint_violation_count: 0, missing_image_count: 0, invalid_price_count: 0, missing_or_open_failed_pdp_count: 0, polluted_row_count: 0, underfill_count: 0, canonical_candidate_count: 2, canonical_returned_count: 1, latency_ms: 100 } },
      { passed: false, metrics: { hard_constraint_violation_count: 2, missing_image_count: 1, invalid_price_count: 1, missing_or_open_failed_pdp_count: 1, polluted_row_count: 1, underfill_count: 1, canonical_candidate_count: 0, canonical_returned_count: 0, latency_ms: 200 } },
    ]);

    expect(summary.cases).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.hard_constraint_violations).toBe(2);
    expect(summary.p95_latency_ms).toBe(200);
  });

  test('converts fetch failures into failed request results', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

    try {
      const result = await requestJson({
        url: 'https://example.test/agent/shop/v1/invoke',
        payload: { operation: 'find_products_multi' },
        timeoutMs: 10,
        attempts: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
      expect(result.body.error.message).toBe('fetch failed');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('converts response body read failures into failed request results', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: jest.fn().mockRejectedValue(new TypeError('terminated')),
    });

    try {
      const result = await requestJson({
        url: 'https://example.test/agent/shop/v1/invoke',
        payload: { operation: 'find_products_multi' },
        timeoutMs: 10,
        attempts: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(200);
      expect(result.body.error.message).toBe('terminated');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
