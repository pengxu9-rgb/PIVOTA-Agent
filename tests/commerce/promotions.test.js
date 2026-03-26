const {
  applyDealsToResponse,
  computePromotionStatus,
  getActivePromotions,
  sanitizePromotionForResponse,
  validateAndNormalizePromotion,
} = require('../../src/commerce/promotions');

describe('commerce promotions', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('applyDealsToResponse enriches flat products and similar-item payloads', () => {
    const promotions = [
      {
        id: 'promo_flash',
        type: 'FLASH_SALE',
        name: 'Flash',
        merchantId: 'merchant_1',
        channels: ['creator_agents'],
        scope: { global: true },
        startAt: '2026-03-20T00:00:00.000Z',
        endAt: '2026-03-21T12:00:00.000Z',
        config: {
          kind: 'FLASH_SALE',
          flashPrice: 80,
          originalPrice: 100,
        },
      },
    ];

    const result = applyDealsToResponse(
      {
        products: [
          {
            merchant_id: 'merchant_1',
            product_id: 'prod_1',
            price: 100,
          },
        ],
        items: [
          {
            product: {
              merchant_id: 'merchant_1',
              product_id: 'prod_2',
              price: 100,
            },
          },
        ],
      },
      promotions,
      new Date('2026-03-21T00:00:00.000Z'),
      'creator_1',
    );

    expect(result.products[0]).toMatchObject({
      best_deal: {
        id: 'promo_flash',
        type: 'FLASH_SALE',
        discount_percent: 20,
        urgency_level: 'MEDIUM',
      },
      all_deals: [
        expect.objectContaining({
          id: 'promo_flash',
          type: 'FLASH_SALE',
        }),
      ],
    });
    expect(result.items[0].product.best_deal).toMatchObject({
      id: 'promo_flash',
      type: 'FLASH_SALE',
    });
    expect(result.items[0].all_deals).toHaveLength(1);
  });

  test('getActivePromotions filters deleted rows and derives human-readable rules', async () => {
    const promotions = await getActivePromotions(new Date('2026-03-21T00:00:00.000Z'), null, {
      getAllPromotions: async () => [
        {
          id: 'promo_bundle',
          type: 'MULTI_BUY_DISCOUNT',
          config: { kind: 'MULTI_BUY_DISCOUNT', thresholdQuantity: 2, discountPercent: 15 },
          deletedAt: null,
        },
        {
          id: 'promo_deleted',
          type: 'FLASH_SALE',
          deletedAt: '2026-03-20T00:00:00.000Z',
        },
      ],
      logger: { error: jest.fn() },
    });

    expect(promotions).toEqual([
      expect.objectContaining({
        id: 'promo_bundle',
        humanReadableRule: 'Buy 2, get 15% off',
      }),
    ]);
  });

  test('getActivePromotions swallows store failures and logs once', async () => {
    const logger = { error: jest.fn() };
    const promotions = await getActivePromotions(new Date('2026-03-21T00:00:00.000Z'), null, {
      getAllPromotions: async () => {
        throw new Error('boom');
      },
      logger,
    });

    expect(promotions).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      { err: 'boom' },
      'Failed to load promotions',
    );
  });

  test('validateAndNormalizePromotion and admin helpers produce stable response shapes', () => {
    const normalized = validateAndNormalizePromotion(
      {
        promotion: {
          name: 'Flash Friday',
          type: 'FLASH_SALE',
          startAt: '2026-03-21T00:00:00.000Z',
          endAt: '2026-03-21T02:00:00.000Z',
          merchantId: 'merchant_1',
          channels: ['creator_agents'],
          scope: { global: true },
          flashPrice: 49,
          originalPrice: 99,
        },
      },
      {},
      { requireAll: true },
    );

    expect(normalized.error).toBeUndefined();
    expect(normalized.promotion).toMatchObject({
      type: 'FLASH_SALE',
      merchantId: 'merchant_1',
      humanReadableRule: 'Flash deal',
      config: {
        kind: 'FLASH_SALE',
        flashPrice: 49,
        originalPrice: 99,
      },
    });

    expect(
      sanitizePromotionForResponse({
        merchant_id: 'merchant_2',
        scope: { product_ids: ['prod_1'], category_ids: ['cat_1'], global: false },
      }),
    ).toEqual({
      merchant_id: 'merchant_2',
      merchantId: 'merchant_2',
      scope: {
        productIds: ['prod_1'],
        categoryIds: ['cat_1'],
        brandIds: [],
        global: false,
      },
    });

    expect(
      computePromotionStatus(
        {
          startAt: '2026-03-20T00:00:00.000Z',
          endAt: '2026-03-22T00:00:00.000Z',
        },
        Date.parse('2026-03-21T00:00:00.000Z'),
      ),
    ).toBe('ACTIVE');
  });
});
