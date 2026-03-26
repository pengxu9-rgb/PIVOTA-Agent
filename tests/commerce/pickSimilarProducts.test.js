const { pickSimilarProducts } = require('../../src/commerce/shared/pickSimilarProducts');

describe('pickSimilarProducts', () => {
  test('prefers products within the base price band and excludes requested ids', () => {
    const picked = pickSimilarProducts(
      [
        { product_id: 'base', price: 100 },
        { product_id: 'near_1', price: 92 },
        { product_id: 'near_2', price: 108 },
        { product_id: 'far', price: 190 },
        { product_id: 'excluded', price: 101 },
      ],
      'base',
      3,
      ['excluded'],
    );

    expect(picked).toEqual([
      { product_id: 'near_1', price: 92 },
      { product_id: 'near_2', price: 108 },
    ]);
  });

  test('falls back to non-base candidates when the base product is missing', () => {
    const picked = pickSimilarProducts(
      [
        { product_id: 'p1', price: 10 },
        { product_id: 'p2', price: 12 },
        { product_id: 'p3', price: 14 },
      ],
      'missing',
      2,
    );

    expect(picked).toEqual([
      { product_id: 'p1', price: 10 },
      { product_id: 'p2', price: 12 },
    ]);
  });
});
