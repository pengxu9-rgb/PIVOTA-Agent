const nock = require('nock');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '1';
process.env.PIVOTA_API_BASE = 'https://backend.test';
process.env.PIVOTA_API_KEY = 'test-token';

const app = require('../src/server');

function descriptor(overrides = {}) {
  return {
    status: 'eligible',
    kind: 'pivota_agent_checkout_handoff',
    merchant_id: 'merch_1',
    product_key: 'prod::merch_1::shopify::p1',
    sku_key: 'sku_1',
    offer_id: 'offer_1',
    pivota_signature_id: 'sig_1',
    commerce_path: 'pivota_direct_quote_first',
    source_deliverability_status: 'transactable',
    ...overrides,
  };
}

function pdpResponse() {
  return {
    status: 'success',
    product: {
      merchant_id: 'merch_1',
      product_id: 'p1',
      title: 'Live Buyable SKU',
      serving_eligible: true,
      in_stock: true,
    },
    modules: [
      {
        type: 'offers',
        data: {
          offers: [
            {
              offer_id: 'offer_1',
              merchant_id: 'merch_1',
              product_id: 'p1',
              sku_id: 'sku_1',
              purchase_route: 'internal_checkout',
              commerce_mode: 'merchant_embedded_checkout',
              checkout_handoff: 'embedded',
              inventory: { in_stock: true },
            },
          ],
        },
      },
    ],
  };
}

describe('checkout_handoff invoke route', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('blocks before PDP revalidation when allow_checkout_handoff is absent', async () => {
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'checkout_handoff',
        payload: {
          handoff_descriptor: descriptor(),
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.status).toBe('blocked');
    expect(res.body.blockers).toContain('checkout_handoff_not_allowed');
    expect(res.body.metadata.gateway_governance.access.allow_checkout_handoff).toBe(false);
  });

  test('revalidates PDP and returns quote-ready template without order or pay calls', async () => {
    const pdpScope = nock('https://backend.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body?.operation === 'get_pdp_v2' &&
          body?.payload?.options?.serving_eligible_only === true &&
          body?.payload?.product_ref?.product_id === 'sig_1' &&
          body?.payload?.product_ref?.offer_id === 'offer_1'
        );
      })
      .reply(200, pdpResponse());
    const orderScope = nock('https://backend.test')
      .post('/agent/v2/orders')
      .reply(500, { error: 'SHOULD_NOT_CREATE_ORDER' });
    const payScope = nock('https://backend.test')
      .post('/agent/v2/payments/checkout-sessions')
      .reply(500, { error: 'SHOULD_NOT_SUBMIT_PAYMENT' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'checkout_handoff',
        payload: {
          handoff_descriptor: descriptor(),
        },
        metadata: {
          source: 'shopping_agent',
          allow_checkout_handoff: true,
          partner_tier: 'flagship',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.checkout_handoff.status).toBe('quote_ready');
    expect(res.body.checkout_handoff.preview_quote_template).toEqual({
      operation: 'preview_quote',
      payload: {
        quote: {
          merchant_id: 'merch_1',
          items: [{ product_id: 'p1', sku_id: 'sku_1', quantity: 1 }],
        },
      },
    });
    expect(res.body.checkout_handoff.order_created).toBe(false);
    expect(res.body.checkout_handoff.payment_submitted).toBe(false);
    expect(pdpScope.isDone()).toBe(true);
    expect(orderScope.isDone()).toBe(false);
    expect(payScope.isDone()).toBe(false);
  });
});
