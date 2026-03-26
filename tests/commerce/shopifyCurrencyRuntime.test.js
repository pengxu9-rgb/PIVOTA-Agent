const { createShopifyCurrencyRuntime } = require('../../src/commerce/catalog/shopifyCurrencyRuntime');

describe('shopifyCurrencyRuntime', () => {
  test('overrides USD Shopify product currency from shop metadata', async () => {
    const queryDb = jest.fn().mockResolvedValue({
      rows: [{ domain: 'merchant-shop.test', api_key: 'shopify_token' }],
    });
    const axiosClient = {
      get: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          shop: {
            currency: 'CAD',
          },
        },
      }),
    };
    const logger = { warn: jest.fn() };
    const runtime = createShopifyCurrencyRuntime({
      queryDb,
      axiosClient,
      logger,
      databaseUrl: 'postgres://example',
    });
    const products = [
      { merchant_id: 'm1', platform: 'shopify', currency: 'USD' },
      { merchant_id: 'm1', platform: 'shopify', currency: '' },
    ];

    const result = await runtime.applyShopifyCurrencyOverride(products);

    expect(result).toBe(products);
    expect(products.map((product) => product.currency)).toEqual(['CAD', 'CAD']);
    expect(queryDb).toHaveBeenCalledTimes(1);
    expect(axiosClient.get).toHaveBeenCalledTimes(1);
  });

  test('does nothing when there are no qualifying Shopify USD rows', async () => {
    const queryDb = jest.fn();
    const axiosClient = { get: jest.fn() };
    const runtime = createShopifyCurrencyRuntime({
      queryDb,
      axiosClient,
      logger: { warn: jest.fn() },
      databaseUrl: 'postgres://example',
    });
    const products = [
      { merchant_id: 'm1', platform: 'amazon', currency: 'USD' },
      { merchant_id: 'm2', platform: 'shopify', currency: 'EUR' },
    ];

    await expect(runtime.applyShopifyCurrencyOverride(products)).resolves.toBe(products);
    expect(queryDb).not.toHaveBeenCalled();
    expect(axiosClient.get).not.toHaveBeenCalled();
  });
});
