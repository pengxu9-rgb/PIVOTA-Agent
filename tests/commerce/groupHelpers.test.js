const {
  resolveProductGroupCached,
  buildOffersFromGroupMembers,
} = require('../../src/commerce/pdp/groupHelpers');
const { resetPdpHotCachesForTest } = require('../../src/commerce/pdp/hotCaches');

describe('commerce pdp group helpers', () => {
  beforeEach(() => {
    resetPdpHotCachesForTest();
  });

  test('resolveProductGroupCached caches upstream response and returns debug cache envelope', async () => {
    const resolveProductGroupFromUpstream = jest.fn(async () => ({
      product_group_id: 'pg:m1:p1',
      members: [
        {
          merchant_id: 'm1',
          product_id: 'p1',
          platform: 'shopify',
          is_primary: true,
        },
      ],
    }));

    const first = await resolveProductGroupCached({
      productId: 'p1',
      merchantId: 'm1',
      platform: 'shopify',
      checkoutToken: 'checkout-token',
      resolveProductGroupFromUpstream,
      resolveProductGroupByProductIdFromUpstream: jest.fn(),
    });
    const second = await resolveProductGroupCached({
      productId: 'p1',
      merchantId: 'm1',
      platform: 'shopify',
      checkoutToken: 'checkout-token',
      debug: true,
      resolveProductGroupFromUpstream,
      resolveProductGroupByProductIdFromUpstream: jest.fn(),
    });

    expect(resolveProductGroupFromUpstream).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      canonical_product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
        platform: 'shopify',
      },
    });
    expect(second).toMatchObject({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      cache: {
        hit: true,
      },
    });
  });

  test('buildOffersFromGroupMembers fetches product details and prefers selected merchant offer', async () => {
    const result = await buildOffersFromGroupMembers({
      members: [
        { merchant_id: 'm1', product_id: 'p1', is_primary: true, merchant_name: 'Shop 1' },
        { merchant_id: 'm2', product_id: 'p1', merchant_name: 'Shop 2' },
      ],
      checkoutToken: 'checkout-token',
      preferredMerchantId: 'm2',
      fetchProductDetailForOffers: jest.fn(async ({ merchantId }) => ({
        merchant_id: merchantId,
        product_id: 'p1',
        currency: 'USD',
        price: merchantId === 'm1' ? 10 : 12,
        in_stock: true,
        shipping: {
          cost: { amount: merchantId === 'm1' ? 0 : 1, currency: 'USD' },
        },
      })),
      buildProductGroupId: jest.fn(({ merchant_id, product_id }) => `pg:${merchant_id}:${product_id}`),
      buildOfferId: jest.fn(
        ({ merchant_id, product_group_id, fulfillment_type, tier }) =>
          `of:v1:${merchant_id}:${product_group_id}:${fulfillment_type}:${tier}`,
      ),
      normalizeOfferMoney: jest.fn((amount, currency) => ({
        amount: Number(amount) || 0,
        currency: currency || 'USD',
      })),
    });

    expect(result).toMatchObject({
      status: 'success',
      offers_count: 2,
      canonical_product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
      },
      default_offer_id: expect.stringContaining('m2'),
      best_price_offer_id: expect.stringContaining('m1'),
    });
    expect(Array.isArray(result.offers)).toBe(true);
    expect(result.offers[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'm1',
        product_id: 'p1',
      }),
    );
  });
});
