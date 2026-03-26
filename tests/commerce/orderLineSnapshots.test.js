const { buildOrderLineSnapshots } = require('../../src/commerce/shared/orderLineSnapshots');

describe('buildOrderLineSnapshots', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('builds normalized line snapshots with shipping and returns metadata', () => {
    const orderLines = buildOrderLineSnapshots(
      {
        merchant_id: 'merchant_1',
        currency: 'USD',
        selected_delivery_option: {
          method_label: 'Express',
          eta_days_range: [1, 2],
          cost: { amount: 5, currency: 'USD' },
        },
        returns_snapshot: {
          return_window_days: 30,
          free_returns: true,
        },
        items: [
          {
            product_id: 'prod_1',
            variant_id: 'var_1',
            unit_price: 12.5,
            quantity: 2,
          },
        ],
      },
      {
        orderId: 'ORD_123',
        resolvedOfferId: 'of:test',
      },
    );

    expect(orderLines).toEqual([
      expect.objectContaining({
        line_id: 'line_ORD_123_1',
        offer_id: 'of:test',
        merchant_id: 'merchant_1',
        product_id: 'prod_1',
        product_group_id: 'pg:merchant_1:prod_1',
        variant_id: 'var_1',
        quantity: 2,
        price_snapshot: {
          unit_price: 12.5,
          subtotal: 25,
          currency: 'USD',
        },
        shipping_snapshot: {
          method_label: 'Express',
          eta_days_range: [1, 2],
          cost: { amount: 5, currency: 'USD' },
        },
        returns_snapshot: expect.objectContaining({
          return_window_days: 30,
          free_returns: true,
          policy_hash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }),
        created_at: '2026-03-21T10:00:00.000Z',
      }),
    ]);
  });
});
