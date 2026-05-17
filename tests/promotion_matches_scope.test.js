// Tests for matchesScope() — promo scope filter gate in findApplicablePromotionsForProduct.
// Exercises both legacy Pivota scope shape and Shopify-imported scope.shopifyItems shape.

describe('matchesScope', () => {
  let matchesScope;
  let prevEnv;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
    };
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.DATABASE_URL = 'postgres://test';
    const server = require('../src/server');
    matchesScope = server._debug.matchesScope;
  });

  afterAll(() => {
    jest.resetModules();
    if (prevEnv.ADMIN_API_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevEnv.ADMIN_API_KEY;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
  });

  // ----- legacy scope shape -----

  test('scope.global=true matches any product', () => {
    expect(matchesScope({ scope: { global: true } }, { product_id: 'anything' })).toBe(true);
  });

  test('legacy scope.productIds matches exact string id (back-compat)', () => {
    expect(
      matchesScope({ scope: { productIds: ['p_123'] } }, { product_id: 'p_123' })
    ).toBe(true);
  });

  test('legacy scope.productIds now matches GID-encoded id (numeric tail)', () => {
    // The bug this fix addresses for legacy-shape promos: product_id in cache is numeric,
    // promo scope holds the full Shopify GID. Old verbatim .includes() failed here.
    expect(
      matchesScope(
        { scope: { productIds: ['gid://shopify/Product/10064567370025'] } },
        { product_id: '10064567370025' }
      )
    ).toBe(true);
  });

  test('legacy scope.categoryIds substring-matches product category (back-compat)', () => {
    expect(
      matchesScope(
        { scope: { categoryIds: ['Beauty'] } },
        { category: 'Beauty & Skincare' }
      )
    ).toBe(true);
  });

  test('returns false when no scope branch matches', () => {
    expect(
      matchesScope(
        { scope: { productIds: ['p_other'] } },
        { product_id: 'p_actual', category: 'unrelated', vendor: 'unrelated' }
      )
    ).toBe(false);
  });

  // ----- Shopify-imported scope shape (the main bug this fix addresses) -----

  test('scope.shopifyItems.__typename=AllDiscountItems matches any product', () => {
    expect(
      matchesScope(
        { scope: { shopifyItems: { __typename: 'AllDiscountItems' } } },
        { product_id: '10064567370025' }
      )
    ).toBe(true);
  });

  test('scope.shopifyItems.allItems=true also matches any product (alternate shape)', () => {
    expect(
      matchesScope(
        { scope: { shopifyItems: { allItems: true, __typename: 'AllDiscountItems' } } },
        { product_id: 'x' }
      )
    ).toBe(true);
  });

  test('scope.shopifyItems.productIds with GID matches numeric product_id', () => {
    // PIVOTA_TEST_AMOUNT10-style: scope.shopifyItems.productIds = ['gid://shopify/Product/...']
    expect(
      matchesScope(
        {
          scope: {
            shopifyItems: {
              __typename: 'DiscountProducts',
              productIds: ['gid://shopify/Product/10064558096681'],
            },
          },
        },
        { product_id: '10064558096681' }
      )
    ).toBe(true);
  });

  test('scope.shopifyItems.products.nodes[].id (object-array shape) matches numeric product_id', () => {
    // PIVOTA_TEST_BXGY-style: nested objects with id field
    expect(
      matchesScope(
        {
          scope: {
            shopifyItems: {
              __typename: 'DiscountProducts',
              products: { nodes: [{ id: 'gid://shopify/Product/10064567370025' }] },
            },
          },
        },
        { product_id: '10064567370025' }
      )
    ).toBe(true);
  });

  test('scope.shopifyItems.productIds with non-matching GID returns false', () => {
    expect(
      matchesScope(
        {
          scope: {
            shopifyItems: {
              __typename: 'DiscountProducts',
              productIds: ['gid://shopify/Product/9999'],
            },
          },
        },
        { product_id: '10064558096681' }
      )
    ).toBe(false);
  });

  test('scope.shopifyItems.variantIds matches product.variants[].id', () => {
    expect(
      matchesScope(
        {
          scope: {
            shopifyItems: {
              __typename: 'DiscountProducts',
              variantIds: ['gid://shopify/ProductVariant/4242'],
            },
          },
        },
        {
          product_id: '10064558096681',
          variants: [{ id: 'gid://shopify/ProductVariant/4242' }],
        }
      )
    ).toBe(true);
  });

  test('combined legacy + shopify scope (both set) matches if either matches', () => {
    // Defensive: a promo with both shapes populated should still match.
    expect(
      matchesScope(
        {
          scope: {
            productIds: ['other'],
            shopifyItems: {
              __typename: 'DiscountProducts',
              productIds: ['gid://shopify/Product/10064558096681'],
            },
          },
        },
        { product_id: '10064558096681' }
      )
    ).toBe(true);
  });

  test('missing scope object returns false safely', () => {
    expect(matchesScope({}, { product_id: 'anything' })).toBe(false);
    expect(matchesScope({ scope: null }, { product_id: 'anything' })).toBe(false);
  });
});
