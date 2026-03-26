const {
  configureProductDetailAdapters,
  fetchProductDetailForOffers,
  getProductDetailSource,
  rewriteCheckoutItemsForOfferSelection,
  __internal,
} = require('../../src/commerce/catalog/productDetailAdapters');

describe('productDetailAdapters', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    __internal.resetProductDetailAdapterCaches();
    configureProductDetailAdapters({
      axios: jest.fn(),
      query: jest.fn(),
      logger: { warn: jest.fn() },
      buildInvokeUpstreamAuthHeaders: jest.fn(() => ({})),
      callUpstreamWithOptionalRetry: jest.fn(),
      getUpstreamTimeoutMs: jest.fn(() => 1500),
      pivotaApiBase: 'https://unit.test',
    });
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test('fetchProductDetailForOffers reuses memory cache after upstream success', async () => {
    delete process.env.DATABASE_URL;
    const callUpstreamWithOptionalRetry = jest.fn(async () => ({
      data: {
        product: {
          merchant_id: 'm1',
          product_id: 'p1',
          title: 'Cached Product',
          currency: 'USD',
          price: '19.5',
        },
      },
    }));

    configureProductDetailAdapters({
      callUpstreamWithOptionalRetry,
    });

    const first = await fetchProductDetailForOffers({
      merchantId: 'm1',
      productId: 'p1',
      checkoutToken: 'checkout-token',
    });
    const second = await fetchProductDetailForOffers({
      merchantId: 'm1',
      productId: 'p1',
      checkoutToken: 'checkout-token',
    });

    expect(callUpstreamWithOptionalRetry).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      merchant_id: 'm1',
      product_id: 'p1',
      title: 'Cached Product',
      price: 19.5,
    });
    expect(second).toMatchObject({
      merchant_id: 'm1',
      product_id: 'p1',
      title: 'Cached Product',
      price: 19.5,
    });
    expect(getProductDetailSource(first)).toBe('upstream');
    expect(getProductDetailSource(second)).toBe('upstream');
  });

  test('rewriteCheckoutItemsForOfferSelection remaps cross-seller variant ids via group member sku lookup', async () => {
    const result = await rewriteCheckoutItemsForOfferSelection({
      offerId: 'offer_1',
      merchantId: 'm-target',
      items: [
        {
          product_id: 'p-origin',
          variant_id: 'v-origin-blue',
          quantity: 1,
        },
      ],
      parseOfferId: () => ({ product_group_id: 'pg_1' }),
      fetchProductGroupMembersFromUpstream: jest.fn(async () => ({
        members: [
          { merchant_id: 'm-origin', product_id: 'p-origin' },
          { merchant_id: 'm-target', product_id: 'p-target' },
        ],
      })),
      fetchLegacyDetail: jest.fn(async ({ productId }) => {
        if (productId === 'p-origin') {
          return {
            product_id: 'p-origin',
            variants: [
              {
                id: 'v-origin-blue',
                sku: 'SKU-BLUE',
                options: { Color: 'Blue', Size: 'M' },
              },
            ],
          };
        }
        if (productId === 'p-target') {
          return {
            product_id: 'p-target',
            variants: [
              {
                id: 'v-target-blue',
                sku: 'SKU-BLUE',
                options: { Color: 'Blue', Size: 'M' },
              },
            ],
          };
        }
        return null;
      }),
    });

    expect(result).toEqual({
      product_group_id: 'pg_1',
      product_id: 'p-target',
      items: [
        {
          product_id: 'p-target',
          variant_id: 'v-target-blue',
          variantId: 'v-target-blue',
          quantity: 1,
          sku: 'SKU-BLUE',
          selected_options: {
            color: 'blue',
            size: 'm',
          },
        },
      ],
    });
  });
});
