const {
  buildSearchProductKey,
  collapseNearDuplicateSearchProducts,
  resolveSearchDedupePerTitleLimit,
} = require('../../src/commerce/catalog/searchDedupe');

describe('searchDedupe', () => {
  test('buildSearchProductKey normalizes merchant/product ids', () => {
    expect(
      buildSearchProductKey({
        merchant_id: 'm_1',
        product_id: 'p_1',
      }),
    ).toBe('m_1::p_1');

    expect(
      buildSearchProductKey({
        merchantId: 'm_2',
        id: 'p_2',
      }),
    ).toBe('m_2::p_2');
  });

  test('collapseNearDuplicateSearchProducts keeps only per-title limit', () => {
    const products = [
      { id: '1', title: 'The Ordinary Niacinamide 10% + Zinc 1%' },
      { id: '2', title: 'The Ordinary Niacinamide 10% + Zinc 1%' },
      { id: '3', title: 'The Ordinary Niacinamide 10% + Zinc 1%' },
      { id: '4', title: 'Another Serum' },
    ];

    expect(
      collapseNearDuplicateSearchProducts(products, { perTitleLimit: 1 }).map((item) => item.id),
    ).toEqual(['1', '4']);

    expect(
      collapseNearDuplicateSearchProducts(products, { perTitleLimit: 2 }).map((item) => item.id),
    ).toEqual(['1', '2', '4']);
  });

  test('resolveSearchDedupePerTitleLimit preserves beauty and lookup policy', () => {
    expect(
      resolveSearchDedupePerTitleLimit({
        queryText: 'ipsa',
        intent: { primary_domain: 'beauty', query_class: 'lookup' },
        queryClass: 'lookup',
      }),
    ).toBe(1);

    expect(
      resolveSearchDedupePerTitleLimit({
        queryText: '约会妆',
        intent: {
          primary_domain: 'beauty',
          scenario: { name: 'general' },
          query_class: 'scenario',
        },
        queryClass: 'scenario',
      }),
    ).toBe(3);

    expect(
      resolveSearchDedupePerTitleLimit({
        queryText: '送礼',
        intent: { primary_domain: 'other', query_class: 'gift' },
        queryClass: 'gift',
      }),
    ).toBe(2);
  });
});
