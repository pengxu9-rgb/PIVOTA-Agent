jest.mock('../../src/db', () => ({
  query: jest.fn(),
  closePool: jest.fn(),
}));
jest.mock('axios', () => ({
  head: jest.fn(),
  get: jest.fn(),
}));

const {
  CLASSIFICATIONS,
  DEFAULT_CORE_PDP_TIMEOUT_MS,
  DEFAULT_DETAILS_PDP_TIMEOUT_MS,
  DEFAULT_SIMILAR_TIMEOUT_MS,
  classifyBeautyServingQualityRow,
  probeMerchantUrl,
} = require('../../scripts/audit-external-seed-beauty-serving-quality.cjs');
const axios = require('axios');

describe('audit-external-seed-beauty-serving-quality', () => {
  beforeEach(() => {
    axios.head.mockReset();
    axios.get.mockReset();
  });

  test('classifies source-unavailable markers as terminal source unavailable', () => {
    const result = classifyBeautyServingQualityRow({
      row: {
        id: 'eps_1',
        external_product_id: 'ext_1',
        title: 'Stale product',
        seed_data: {
          source_unavailable_v1: {
            contract_version: 'external_seed.source_unavailable.v1',
            status: 'source_unavailable',
          },
          snapshot: {},
        },
      },
    });

    expect(result.classification).toBe(CLASSIFICATIONS.SOURCE_UNAVAILABLE);
    expect(result.auto_fixable).toBe(false);
    expect(result.recommended_action).toBe('already held by external_seed.source_unavailable.v1');
    expect(result.failure_reasons).toEqual(expect.arrayContaining(['source_unavailable_marker']));
  });

  test('classifies shipping protection as non merchandise', () => {
    const result = classifyBeautyServingQualityRow({
      row: {
        id: 'eps_2',
        external_product_id: 'ext_2',
        title: 'Route Package Protection',
        price_amount: 1,
        image_url: 'https://cdn.example.com/route.jpg',
        seed_data: { snapshot: {} },
      },
    });

    expect(result.classification).toBe(CLASSIFICATIONS.NON_MERCHANDISE);
    expect(result.failure_reasons).toEqual(expect.arrayContaining(['non_merchandise_surface']));
  });

  test('classifies donation pages as non merchandise', () => {
    const result = classifyBeautyServingQualityRow({
      row: {
        id: 'eps_donation',
        external_product_id: 'ext_donation',
        title: 'Donate To The Clara Lionel Foundation',
        category: 'Donation',
        price_amount: 5,
        image_url: 'https://cdn.example.com/donate.jpg',
        seed_data: {
          snapshot: {
            canonical_url: 'https://fentybeauty.com/products/donate-to-the-clara-lionel-foundation',
            description: '100% of your donation supports the Clara Lionel Foundation.',
          },
        },
      },
    });

    expect(result.classification).toBe(CLASSIFICATIONS.NON_MERCHANDISE);
    expect(result.failure_reasons).toEqual(expect.arrayContaining(['non_merchandise_surface']));
  });

  test('classifies stale but identifiable product rows as repairable backfill', () => {
    const result = classifyBeautyServingQualityRow({
      row: {
        id: 'eps_3',
        external_product_id: 'ext_3',
        title: 'Rare Beauty Blush',
        category: 'external',
        price_amount: 0,
        seed_data: { snapshot: {} },
      },
      merchantUrlHealth: { checked: true, ok: true, status: 200 },
    });

    expect(result.classification).toBe(CLASSIFICATIONS.REPAIRABLE_BACKFILL);
    expect(result.failure_reasons).toEqual(
      expect.arrayContaining(['missing_image', 'invalid_zero_or_negative_price', 'generic_external_category']),
    );
  });

  test('passes complete rows without content or PDP failures', () => {
    const result = classifyBeautyServingQualityRow({
      row: {
        id: 'eps_4',
        external_product_id: 'ext_4',
        title: 'Rare Beauty Soft Pinch Liquid Blush',
        category: 'Blush',
        price_amount: 23,
        image_url: 'https://cdn.example.com/blush.jpg',
        seed_data: { snapshot: {} },
      },
      merchantUrlHealth: { checked: true, ok: true, status: 200 },
    });

    expect(result.classification).toBe(CLASSIFICATIONS.PASS);
    expect(result.failure_reasons).toEqual([]);
  });

  test('does not classify informational duplicate SKU findings as repairable serving debt', () => {
    const result = classifyBeautyServingQualityRow({
      row: {
        id: 'eps_info_duplicate_sku',
        external_product_id: 'ext_info_duplicate_sku',
        title: "Pro Filt'r Instant Retouch Concealer — #210",
        price_amount: 29,
        image_url: 'https://cdn.example.com/concealer.jpg',
        seed_data: { snapshot: {} },
      },
      contentAudit: {
        findings: [
          {
            anomaly_type: 'gift_card_duplicate_sku',
            severity: 'info',
          },
        ],
      },
      pdpQuality: {
        failure_reasons: [],
      },
      merchantUrlHealth: { checked: true, ok: true, status: 200 },
    });

    expect(result.classification).toBe(CLASSIFICATIONS.PASS);
    expect(result.failure_reasons).toEqual([]);
  });

  test('uses production-safe PDP probe timeout defaults for beauty serving audits', () => {
    expect(DEFAULT_CORE_PDP_TIMEOUT_MS).toBeGreaterThanOrEqual(45000);
    expect(DEFAULT_DETAILS_PDP_TIMEOUT_MS).toBeGreaterThanOrEqual(60000);
    expect(DEFAULT_SIMILAR_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
  });

  test('falls back to GET when merchant HEAD probe is blocked', async () => {
    axios.head.mockResolvedValue({ status: 403 });
    axios.get.mockResolvedValue({ status: 200 });

    const result = await probeMerchantUrl('https://www.charlottetilbury.com/us/product/example');

    expect(result).toEqual({
      checked: true,
      ok: true,
      status: 200,
      method: 'GET',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('classifies extractor-failed incomplete rows as review required, not backfill-ready', () => {
    const result = classifyBeautyServingQualityRow({
      row: {
        id: 'eps_5',
        external_product_id: 'ext_5',
        title: 'Charlotte Tilbury Mascara',
        price_amount: 0,
        seed_data: { snapshot: {} },
      },
      pdpQuality: {
        failure_reasons: ['extractor_failure', 'product_intel_module_empty_or_blocked'],
      },
      merchantUrlHealth: { checked: true, ok: true, status: 200 },
    });

    expect(result.classification).toBe(CLASSIFICATIONS.REVIEW_REQUIRED);
    expect(result.auto_fixable).toBe(false);
  });
});
