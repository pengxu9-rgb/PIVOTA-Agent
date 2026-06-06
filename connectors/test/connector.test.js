import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConnectorError } from '../MerchantConnector.js';
import { CustomRestConnector, getConnector } from '../registry.js';
import { ShopifyConnector, normalizeAmount } from '../shopify/ShopifyConnector.js';

function response(json, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return json;
    },
  };
}

test('ShopifyConnector previewQuote returns locked totals from a live Storefront response', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({
      data: {
        cartCreate: {
          cart: {
            id: 'gid://shopify/Cart/live-cart-1',
            checkoutUrl: 'https://checkout.example/cart/live-cart-1',
            cost: {
              subtotalAmount: { amount: '40.00', currencyCode: 'USD' },
              totalTaxAmount: { amount: '3.20', currencyCode: 'USD' },
              totalAmount: { amount: '48.20', currencyCode: 'USD' },
            },
            deliveryGroups: {
              nodes: [
                {
                  selectedDeliveryOption: {
                    title: 'Standard',
                    estimatedCost: { amount: '5.00', currencyCode: 'USD' },
                  },
                  deliveryOptions: [],
                },
              ],
            },
            lines: {
              nodes: [
                {
                  id: 'line-1',
                  quantity: 2,
                  merchandise: {
                    id: 'gid://shopify/ProductVariant/111',
                    sku: 'SKU-111',
                    title: 'Blue',
                    product: {
                      id: 'gid://shopify/Product/222',
                      title: 'Pivota Tee',
                    },
                  },
                  cost: {
                    subtotalAmount: { amount: '40.00', currencyCode: 'USD' },
                    totalAmount: { amount: '40.00', currencyCode: 'USD' },
                  },
                },
              ],
            },
          },
          userErrors: [],
        },
      },
    });
  };

  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify',
    merchant_of_record: 'Pivota Test Shop LLC',
    shopDomain: 'test-shop.myshopify.com',
    storefrontAccessToken: 'storefront-token',
    fetchImpl,
  });

  const quote = await connector.previewQuote({
    merchant_id: 'merchant-shopify',
    items: [{ sku_id: 'gid://shopify/ProductVariant/111', quantity: 2 }],
    shipping_address: {
      recipient_name: 'Ada Lovelace',
      address_line1: '1 Main St',
      city: 'New York',
      country: 'US',
      postal_code: '10001',
    },
    discount_codes: ['SAVE10'],
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/2025-01\/graphql\.json$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(quote.locked_totals, {
    subtotal: '40.00',
    tax: '3.20',
    shipping: '5.00',
    total: '48.20',
  });
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.merchant_of_record, 'Pivota Test Shop LLC');
  assert.equal(quote.quoteRef.live, true);
  assert.equal(quote.quoteRef.cart_id, 'gid://shopify/Cart/live-cart-1');
  assert.equal(quote.payment_handlers[0].id, 'shop_pay');
  assert.equal(quote.line_items[0].sku_id, 'gid://shopify/ProductVariant/111');
  assert.equal(quote.line_items[0].unit_price, '20.00');
  assert.equal(quote.line_items[0].line_subtotal, '40.00');
  assert.equal(quote.line_items[0].line_total, '40.00');
});

test('ShopifyConnector createOrder pins locked prices and rejects divergent draft totals', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({
      draft_order: {
        id: 777,
        name: '#D777',
        order_id: null,
        status: 'open',
        total_price: '49.00',
      },
    });
  };

  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify',
    merchant_of_record: 'Pivota Test Shop LLC',
    shopDomain: 'test-shop.myshopify.com',
    adminAccessToken: 'admin-token',
    fetchImpl,
  });

  const quoteRef = {
    merchant_id: 'merchant-shopify',
    merchant_of_record: 'Pivota Test Shop LLC',
    cart_id: 'gid://shopify/Cart/live-cart-1',
    checkout_url: 'https://checkout.example/cart/live-cart-1',
    payment_handler_id: 'shop_pay',
    currency: 'USD',
    locked_totals: {
      subtotal: 40,
      tax: 3.2,
      shipping: 5,
      total: 48.2,
    },
    line_items: [
      {
        sku_id: 'gid://shopify/ProductVariant/111',
        quantity: 2,
        unit_price: 20,
        line_subtotal: 50,
        line_total: 40,
      },
    ],
  };

  await assert.rejects(
    () =>
      connector.createOrder({
        quoteRef,
        shipping_address: {
          recipient_name: 'Ada Lovelace',
          address_line1: '1 Main St',
          city: 'New York',
          country: 'US',
          postal_code: '10001',
        },
      }),
    (error) => error instanceof ConnectorError && error.code === 'PRICE_LOCK_VIOLATION',
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/admin\/api\/2025-01\/draft_orders\.json$/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.draft_order.line_items[0], {
    variant_id: '111',
    quantity: 2,
    price: '25.00',
    applied_discount: {
      title: 'Pivota locked quote line discount',
      description: 'Pivota locked quote line discount',
      value_type: 'fixed_amount',
      value: '10.00',
      amount: '10.00',
    },
  });
  assert.deepEqual(body.draft_order.shipping_line, {
    title: 'Pivota locked shipping',
    price: '5.00',
  });
});

test('ShopifyConnector createOrder returns draft and completed order ids separately', async () => {
  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify',
    merchant_of_record: 'Pivota Test Shop LLC',
    shopDomain: 'test-shop.myshopify.com',
    adminAccessToken: 'admin-token',
    fetchImpl: async () =>
      response({
        draft_order: {
          id: 777,
          name: '#D777',
          order_id: 12345,
          status: 'completed',
          total_price: '48.20',
        },
      }),
  });

  const order = await connector.createOrder({
    quoteRef: {
      merchant_id: 'merchant-shopify',
      merchant_of_record: 'Pivota Test Shop LLC',
      currency: 'USD',
      locked_totals: {
        subtotal: 40,
        tax: 3.2,
        shipping: 5,
        total: 48.2,
      },
      line_items: [
        {
          sku_id: 'gid://shopify/ProductVariant/111',
          quantity: 2,
          unit_price: 20,
          line_total: 40,
        },
      ],
    },
  });

  assert.equal(order.draft_order_id, '777');
  assert.equal(order.order_id, '12345');
  assert.equal(order.merchant_order_id, '#D777');
  assert.deepEqual(order.locked_totals, {
    subtotal: '40.00',
    tax: '3.20',
    shipping: '5.00',
    total: '48.20',
  });
});

test('ShopifyConnector status and refund reject uncompleted draft orders', async () => {
  const calls = [];
  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify',
    merchant_of_record: 'Pivota Test Shop LLC',
    shopDomain: 'test-shop.myshopify.com',
    adminAccessToken: 'admin-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({});
    },
  });

  await assert.rejects(
    () => connector.getOrderStatus({ draft_order_id: 'gid://shopify/DraftOrder/777', order_id: null }),
    (error) => error instanceof ConnectorError && error.code === 'ORDER_NOT_COMPLETED',
  );
  await assert.rejects(
    () => connector.refund({ draft_order_id: 'gid://shopify/DraftOrder/777', order_id: null }),
    (error) => error instanceof ConnectorError && error.code === 'ORDER_NOT_COMPLETED',
  );
  assert.equal(calls.length, 0);
});

test('ShopifyConnector status and refund target the real completed order id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/refunds.json')) {
      return response({
        refund: {
          id: 987,
          status: 'success',
          transactions: [{ amount: '12.50', currency: 'USD', status: 'success' }],
        },
      });
    }

    return response({
      order: {
        id: 12345,
        financial_status: 'paid',
        fulfillments: [{ tracking_number: 'TRACK123', tracking_company: 'UPS' }],
      },
    });
  };

  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify',
    merchant_of_record: 'Pivota Test Shop LLC',
    shopDomain: 'test-shop.myshopify.com',
    adminAccessToken: 'admin-token',
    fetchImpl,
  });

  const status = await connector.getOrderStatus({
    draft_order_id: 'gid://shopify/DraftOrder/777',
    order_id: 'gid://shopify/Order/12345',
  });
  const refund = await connector.refund({
    draft_order_id: 'gid://shopify/DraftOrder/777',
    order_id: 'gid://shopify/Order/12345',
    reason: 'Customer requested refund',
    amount: { amount: 12.5, currency: 'USD' },
    orderContext: { amount: 50, currency: 'USD' },
  });

  assert.match(calls[0].url, /\/admin\/api\/2025-01\/orders\/12345\.json$/);
  assert.match(calls[1].url, /\/admin\/api\/2025-01\/orders\/12345\/refunds\.json$/);
  assert.equal(status.order_id, '12345');
  assert.equal(status.tracking, 'TRACK123');
  assert.equal(refund.order_id, 'gid://shopify/Order/12345');
});

test('ShopifyConnector refund happy path returns normalized refund and merchant of record', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({
      refund: {
        id: 987,
        status: 'success',
        transactions: [{ amount: '12.50', currency: 'USD', status: 'success' }],
      },
    });
  };

  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify',
    merchant_of_record: 'Pivota Test Shop LLC',
    shopDomain: 'test-shop.myshopify.com',
    adminAccessToken: 'admin-token',
    fetchImpl,
  });

  const refund = await connector.refund({
    order_id: 'gid://shopify/Order/12345',
    reason: 'Customer requested refund',
    amount: { amount: 12.5, currency: 'USD' },
    orderContext: { amount: 50, currency: 'USD' },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/admin\/api\/2025-01\/orders\/12345\/refunds\.json$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(refund, {
    refund_id: '987',
    order_id: 'gid://shopify/Order/12345',
    status: 'success',
    amount: '12.50',
    currency: 'USD',
    merchant_of_record: 'Pivota Test Shop LLC',
  });
});

// --- X-P1-5: refund amount/currency derived from the LOCKED order, not caller input ---

function refundConnector() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const tx = body?.refund?.transactions?.[0];
    return response({ refund: { id: 987, status: 'success', transactions: tx ? [{ ...tx, status: 'success' }] : [] } });
  };
  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify', merchant_of_record: 'Pivota Test Shop LLC',
    shopDomain: 'test-shop.myshopify.com', adminAccessToken: 'admin-token', fetchImpl,
  });
  return { connector, calls };
}

test('X-P1-5: a caller refund amount above the order total is CAPPED at the refundable balance', async () => {
  const { connector, calls } = refundConnector();
  await connector.refund({
    order_id: 'gid://shopify/Order/12345',
    amount: 9999, // attacker asks for far more than the order
    orderContext: { amount: 113, currency: 'USD' },
  });
  assert.equal(calls[0].body.refund.transactions[0].amount, '113.00', 'capped to order total');
});

test('X-P1-5: refund currency is FORCED to the order currency, ignoring caller currency', async () => {
  const { connector, calls } = refundConnector();
  await connector.refund({
    order_id: 'gid://shopify/Order/12345',
    amount: { amount: 50, currency: 'EUR' }, // caller tries EUR
    orderContext: { amount: 113, currency: 'USD' },
  });
  assert.equal(calls[0].body.refund.transactions[0].currency, 'USD');
  assert.equal(calls[0].body.refund.transactions[0].amount, '50.00', 'partial within balance honored');
});

test('X-P1-5: refund respects already-refunded balance', async () => {
  const { connector, calls } = refundConnector();
  await connector.refund({
    order_id: 'gid://shopify/Order/12345',
    orderContext: { amount: 113, currency: 'USD', refunded_amount: 100 },
  });
  assert.equal(calls[0].body.refund.transactions[0].amount, '13.00', 'only the remaining balance');
});

test('X-P1-5: a fully-refunded order refuses further refund', async () => {
  const { connector } = refundConnector();
  await assert.rejects(
    connector.refund({ order_id: 'gid://shopify/Order/12345', orderContext: { amount: 113, currency: 'USD', refunded_amount: 113 } }),
    (e) => e instanceof ConnectorError && e.code === 'REFUND_NOT_ALLOWED',
  );
});

test('X-P1-5 (Codex P0-1): refund WITHOUT orderContext fails closed, never a full refund', async () => {
  const { connector, calls } = refundConnector();
  await assert.rejects(
    connector.refund({ order_id: 'gid://shopify/Order/12345', amount: 50 }),
    (e) => e instanceof ConnectorError && e.code === 'REFUND_CONTEXT_REQUIRED',
  );
  assert.equal(calls.length, 0, 'no Shopify refund call without a locked order context');
});

test('FWBC-P2: a malformed amount object (no amount field) is rejected, not a full refund', async () => {
  const { connector, calls } = refundConnector();
  await assert.rejects(
    connector.refund({ order_id: 'gid://shopify/Order/12345', amount: { currency: 'USD' }, orderContext: { amount: 113, currency: 'USD' } }),
    (e) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
  );
  assert.equal(calls.length, 0, 'no Shopify call for a malformed amount');
});

test('FWBC-P2: a negative refunded_amount cannot inflate the refundable cap', async () => {
  const { connector, calls } = refundConnector();
  await connector.refund({
    order_id: 'gid://shopify/Order/12345',
    amount: 200,
    orderContext: { amount: 100, currency: 'USD', refunded_amount: -50 },
  });
  // refundable must be clamped to the order total (100), not 150
  assert.equal(calls[0].body.refund.transactions[0].amount, '100.00');
});

test('X-P3-3: normalizeAmount rejects invalid, non-finite, and negative values', () => {
  assert.equal(normalizeAmount('abc'), undefined);
  assert.equal(normalizeAmount({ amount: 'abc', currency: 'USD' }), undefined);
  assert.equal(normalizeAmount(-5), undefined);
  assert.equal(normalizeAmount(Infinity), undefined);
  assert.equal(normalizeAmount(true), undefined);
  assert.equal(normalizeAmount([]), undefined);
  assert.deepEqual(normalizeAmount(12.5), { amount: '12.50', currency: undefined });
  assert.deepEqual(normalizeAmount({ amount: '9.99', currency: 'USD' }), { amount: '9.99', currency: 'USD' });
});

test('ShopifyConnector verifyWebhook accepts signed body and rejects tampering', () => {
  const secret = 'webhook-secret';
  const rawBody = JSON.stringify({ id: 123, financial_status: 'paid' });
  const signature = createHmac('sha256', secret).update(Buffer.from(rawBody)).digest('base64');
  const connector = new ShopifyConnector({
    merchant_id: 'merchant-shopify',
    shopDomain: 'test-shop.myshopify.com',
    webhookSecret: secret,
    fetchImpl: async () => response({}),
  });

  assert.equal(connector.verifyWebhook({ 'x-shopify-hmac-sha256': signature }, rawBody), true);
  assert.equal(connector.verifyWebhook({ 'x-shopify-hmac-sha256': signature }, `${rawBody} `), false);
});

test('registry resolves shopify and custom connector types', () => {
  const fetchImpl = async () => response({});
  const shopify = getConnector({
    id: 'merchant-shopify',
    connector: 'shopify',
    name: 'Pivota Test Shop LLC',
    config: {
      shopDomain: 'test-shop.myshopify.com',
      webhookSecret: 'secret',
    },
    fetchImpl,
  });
  const custom = getConnector({
    id: 'merchant-custom',
    connector: 'custom',
    name: 'Custom Merchant',
    config: {
      baseUrl: 'https://merchant.example',
    },
    fetchImpl,
  });

  assert.ok(shopify instanceof ShopifyConnector);
  assert.ok(custom instanceof CustomRestConnector);
  assert.equal(custom.provider, 'custom');
});

test('custom connector stub fails money-path operations with NOT_SUPPORTED', async () => {
  const connector = new CustomRestConnector({ merchant_id: 'merchant-custom' });
  await assert.rejects(
    () => connector.previewQuote({ merchant_id: 'merchant-custom', items: [{ sku_id: '1', quantity: 1 }] }),
    (error) => error instanceof ConnectorError && error.code === 'NOT_SUPPORTED',
  );
});

test('custom connector stub explicitly fences unsupported checkout and after-sales operations', async () => {
  const connector = new CustomRestConnector({ merchant_id: 'merchant-custom' });
  for (const operation of ['createCheckout', 'requestReturn', 'requestExchange', 'requestSupport']) {
    await assert.rejects(
      () => connector[operation]({ order_id: 'ord_1' }),
      (error) =>
        error instanceof ConnectorError &&
        error.code === 'NOT_SUPPORTED' &&
        error.details?.operation === operation,
      operation,
    );
  }
});
