describe('promotionStore remote cache', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      PROMOTIONS_MODE: 'remote',
      PROMOTIONS_BACKEND_BASE_URL: 'https://promo-backend.test',
      PROMOTIONS_ADMIN_KEY: 'promo_admin_test_key',
      PROMO_REMOTE_CACHE_TTL_MS: '30000',
      PROMO_REMOTE_STALE_WHILE_REVALIDATE: 'true',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('caches empty remote promotion snapshots within ttl', async () => {
    const axiosMock = jest.fn().mockResolvedValue({ data: { promotions: [] } });
    jest.doMock('axios', () => axiosMock);

    const { getAllPromotions } = require('../src/promotionStore');

    await expect(getAllPromotions()).resolves.toEqual([]);
    await expect(getAllPromotions()).resolves.toEqual([]);

    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  test('serves stale empty snapshot while revalidating after ttl expiry', async () => {
    jest.useFakeTimers();
    const axiosMock = jest
      .fn()
      .mockResolvedValueOnce({ data: { promotions: [] } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: { promotions: [] } }), 1000);
          }),
      );
    jest.doMock('axios', () => axiosMock);

    const { getAllPromotions } = require('../src/promotionStore');

    await expect(getAllPromotions()).resolves.toEqual([]);
    jest.advanceTimersByTime(30001);

    const stalePromise = getAllPromotions();
    await expect(stalePromise).resolves.toEqual([]);
    expect(axiosMock).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    jest.useRealTimers();
  });

  test('fetches and caches merchant-scoped remote promotions', async () => {
    const axiosMock = jest.fn().mockResolvedValue({
      data: {
        promotions: [
          {
            id: 'promo_shopify_scope',
            merchantId: 'merch_shopify',
            scope: {
              shopifyItems: {
                __typename: 'AllDiscountItems',
              },
            },
            config: {
              source: 'shopify_discount_node',
            },
          },
        ],
      },
    });
    jest.doMock('axios', () => axiosMock);

    const { getPromotionsForMerchant } = require('../src/promotionStore');

    const first = await getPromotionsForMerchant('merch_shopify');
    const second = await getPromotionsForMerchant('merch_shopify');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(axiosMock).toHaveBeenCalledTimes(1);
    expect(axiosMock.mock.calls[0][0].url).toBe(
      'https://promo-backend.test/agent/internal/promotions?merchantId=merch_shopify&limit=200',
    );
  });

  test('preserves Shopify discount scope metadata while stripping legacy merchant scope', () => {
    const { normalizePromotionRecord } = require('../src/promotionStore');

    const normalized = normalizePromotionRecord({
      id: 'promo_shopify_scope',
      merchantId: 'merch_shopify',
      scope: {
        merchantIds: ['legacy_should_not_remain'],
        global: false,
        shopifyItems: {
          __typename: 'DiscountProducts',
          productIds: ['gid://shopify/Product/10064558096681'],
        },
      },
      config: {
        source: 'shopify_discount_node',
      },
    });

    expect(normalized.scope).toEqual(
      expect.objectContaining({
        global: false,
        shopifyItems: {
          __typename: 'DiscountProducts',
          productIds: ['gid://shopify/Product/10064558096681'],
        },
        productIds: [],
        categoryIds: [],
        brandIds: [],
      }),
    );
    expect(normalized.scope.merchantIds).toBeUndefined();
  });
});
