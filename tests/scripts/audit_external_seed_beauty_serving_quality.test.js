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
  classifyBeautyServingQualityRow,
} = require('../../scripts/audit-external-seed-beauty-serving-quality.cjs');

describe('audit-external-seed-beauty-serving-quality', () => {
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
    expect(result.auto_fixable).toBe(true);
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
});
