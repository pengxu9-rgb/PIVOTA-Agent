process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('checkout rollout suite via /agent/shop/v1/invoke', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('keeps preview_quote -> create_order -> submit_payment on the canonical merchant PSP path', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout')
      .post('/agent/v2/quotes/preview', (body) => {
        return (
          body &&
          body.merchant_id === 'm_rollout' &&
          Array.isArray(body.offer_refs) &&
          body.offer_refs[0]?.offer_id === 'offer::m_rollout::v_rollout' &&
          body.offer_refs[0]?.product_id === 'p_rollout' &&
          body.offer_refs[0]?.variant_id === 'v_rollout'
        );
      })
      .reply(200, {
        status: 'success',
        quote: {
          quote_id: 'q_rollout_123',
          expires_at: '2026-03-20T00:00:00Z',
          currency: 'USD',
          price_breakdown: {
            subtotal: '29.00',
            discount_total: '0.00',
            total: '29.00',
            currency: 'USD',
          },
          shipping_breakdown: {
            shipping_fee: '0.00',
            delivery_options: [{ id: 'ship_rollout', label: 'Standard' }],
          },
          tax_breakdown: {
            tax: '0.00',
          },
        },
      })
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout')
      .post('/agent/v2/orders', (body) => {
        return (
          body &&
          body.quote_id === 'q_rollout_123' &&
          body.buyer_context?.customer_email === 'rollout@example.com' &&
          body.buyer_context?.buyer_ref === 'buyer_rollout' &&
          body.buyer_context?.shipping_address?.country === 'US'
        );
      })
      .reply(200, {
        status: 'success',
        order: {
          order_id: 'ORD_ROLLOUT_123',
          quote_id: 'q_rollout_123',
          merchant_id: 'm_rollout',
          line_items: [
            {
              product_id: 'p_rollout',
              variant_id: 'v_rollout',
              quantity: 1,
              unit_price: '29.00',
            },
          ],
          buyer_context: {
            customer_email: 'rollout@example.com',
            buyer_ref: 'buyer_rollout',
            shipping_address: {
              name: 'Rollout Buyer',
              address_line1: '1 Canary Way',
              city: 'San Francisco',
              state: 'CA',
              postal_code: '94105',
              country: 'US',
            },
          },
          payment_status: 'awaiting_payment',
          payment_summary: { psp: 'stripe', client_secret: 'cs_rollout' },
          fulfillment_summary: { fulfillment_status: null },
          amounts: {
            subtotal: '29.00',
            shipping_fee: '0.00',
            tax: '0.00',
            total: '29.00',
            currency: 'USD',
          },
        },
        payment: { psp: 'stripe', client_secret: 'cs_rollout' },
      })
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout')
      .post('/agent/v1/payments', (body) => {
        return (
          body &&
          body.order_id === 'ORD_ROLLOUT_123' &&
          body.payment_method?.type === 'card'
        );
      })
      .reply(200, {
        status: 'requires_action',
        payment_id: 'pay_rollout_123',
        payment_intent_id: 'pi_rollout_123',
        psp: 'stripe',
        client_secret: 'pi_rollout_123_secret_456',
      });

    const previewResp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout')
      .set('X-Buyer-Ref', 'buyer_rollout')
      .send({
        operation: 'preview_quote',
        payload: {
          quote: {
            merchant_id: 'm_rollout',
            offer_id: 'offer::m_rollout::v_rollout',
            items: [{ product_id: 'p_rollout', variant_id: 'v_rollout', quantity: 1 }],
            shipping_address: { country: 'US', postal_code: '94105', city: 'San Francisco', state: 'CA' },
          },
        },
      })
      .expect(200);

    const createOrderResp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout')
      .set('X-Buyer-Ref', 'buyer_rollout')
      .send({
        operation: 'create_order',
        payload: {
          order: {
            quote_id: 'q_rollout_123',
            customer_email: 'rollout@example.com',
            shipping_address: {
              name: 'Rollout Buyer',
              address_line1: '1 Canary Way',
              city: 'San Francisco',
              state: 'CA',
              postal_code: '94105',
              country: 'US',
            },
            items: [
              {
                merchant_id: 'm_rollout',
                product_id: 'p_rollout',
                variant_id: 'v_rollout',
                product_title: 'Canary Serum',
                quantity: 1,
                unit_price: 29,
              },
            ],
          },
        },
      })
      .expect(200);

    const paymentResp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout')
      .set('X-Buyer-Ref', 'buyer_rollout')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ORD_ROLLOUT_123',
            expected_amount: 29,
            currency: 'USD',
            payment_method_hint: 'card',
            buyer_ref: 'buyer_rollout',
          },
        },
      })
      .expect(200);

    expect(previewResp.body.quote_id).toBe('q_rollout_123');
    expect(previewResp.body.quote.quote_id).toBe('q_rollout_123');
    expect(createOrderResp.body.order_id).toBe('ORD_ROLLOUT_123');
    expect(createOrderResp.body.quote_id).toBe('q_rollout_123');
    expect(createOrderResp.body.payment?.client_secret).toBe('cs_rollout');
    expect(paymentResp.body).toMatchObject({
      status: 'requires_action',
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      payment_intent_id: 'pi_rollout_123',
      psp: 'stripe',
      payment_action: {
        type: 'stripe_client_secret',
        client_secret: 'pi_rollout_123_secret_456',
      },
      payment: {
        payment_intent_id: 'pi_rollout_123',
        payment_status: 'requires_action',
      },
    });
    expect(nock.isDone()).toBe(true);
  });

  it('survives quote expiry and temporary payment unavailability without leaving the merchant PSP path', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_retry')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_retry')
      .post('/agent/v2/quotes/preview', (body) => {
        return (
          body &&
          body.merchant_id === 'm_rollout' &&
          Array.isArray(body.offer_refs) &&
          body.offer_refs[0]?.offer_id === 'offer::m_rollout::v_rollout'
        );
      })
      .reply(200, {
        status: 'success',
        quote: {
          quote_id: 'q_rollout_expired',
          expires_at: '2026-03-20T00:00:00Z',
          currency: 'USD',
          price_breakdown: {
            subtotal: '29.00',
            discount_total: '0.00',
            total: '29.00',
            currency: 'USD',
          },
          shipping_breakdown: {
            shipping_fee: '0.00',
            delivery_options: [{ id: 'ship_rollout', label: 'Standard' }],
          },
          tax_breakdown: {
            tax: '0.00',
          },
        },
      })
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_retry')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_retry')
      .post('/agent/v2/orders', (body) => body && body.quote_id === 'q_rollout_expired')
      .reply(409, {
        detail: {
          error: 'QUOTE_EXPIRED',
          message: 'Quote expired before order creation',
        },
      })
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_retry')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_retry')
      .post('/agent/v2/quotes/preview', (body) => {
        return (
          body &&
          body.merchant_id === 'm_rollout' &&
          Array.isArray(body.offer_refs) &&
          body.offer_refs[0]?.product_id === 'p_rollout' &&
          body.offer_refs[0]?.variant_id === 'v_rollout'
        );
      })
      .reply(200, {
        status: 'success',
        quote: {
          quote_id: 'q_rollout_retry',
          expires_at: '2026-03-20T00:10:00Z',
          currency: 'USD',
        },
      })
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_retry')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_retry')
      .post('/agent/v2/orders', (body) => {
        return (
          body &&
          body.quote_id === 'q_rollout_retry' &&
          body.buyer_context?.customer_email === 'rollout@example.com' &&
          body.buyer_context?.buyer_ref === 'buyer_rollout_retry'
        );
      })
      .reply(200, {
        status: 'success',
        order: {
          order_id: 'ORD_ROLLOUT_RETRY',
          quote_id: 'q_rollout_retry',
          merchant_id: 'm_rollout',
          line_items: [
            {
              product_id: 'p_rollout',
              variant_id: 'v_rollout',
              quantity: 1,
              unit_price: '29.00',
            },
          ],
          buyer_context: {
            customer_email: 'rollout@example.com',
            buyer_ref: 'buyer_rollout_retry',
            shipping_address: {
              name: 'Rollout Buyer',
              address_line1: '1 Canary Way',
              city: 'San Francisco',
              state: 'CA',
              postal_code: '94105',
              country: 'US',
            },
          },
          payment_status: 'awaiting_payment',
          payment_summary: { psp: 'stripe', client_secret: 'cs_rollout_retry' },
          fulfillment_summary: { fulfillment_status: null },
          amounts: {
            subtotal: '29.00',
            shipping_fee: '0.00',
            tax: '0.00',
            total: '29.00',
            currency: 'USD',
          },
        },
        payment: { psp: 'stripe', client_secret: 'cs_rollout_retry' },
      })
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_retry')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_retry')
      .post('/agent/v1/payments', (body) => {
        return (
          body &&
          body.order_id === 'ORD_ROLLOUT_RETRY' &&
          body.payment_method?.type === 'card'
        );
      })
      .reply(503, {
        detail: {
          error: 'TEMPORARY_UNAVAILABLE',
          message: 'checkout intent store warming up',
        },
      })
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_retry')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_retry')
      .post('/agent/v1/payments', (body) => {
        return (
          body &&
          body.order_id === 'ORD_ROLLOUT_RETRY' &&
          body.payment_method?.type === 'card'
        );
      })
      .reply(200, {
        status: 'requires_action',
        payment_id: 'pay_rollout_retry',
        payment_intent_id: 'pi_rollout_retry',
        psp: 'stripe',
        client_secret: 'pi_rollout_retry_secret_456',
      });

    const previewResp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout_retry')
      .set('X-Buyer-Ref', 'buyer_rollout_retry')
      .send({
        operation: 'preview_quote',
        payload: {
          quote: {
            merchant_id: 'm_rollout',
            offer_id: 'offer::m_rollout::v_rollout',
            items: [{ product_id: 'p_rollout', variant_id: 'v_rollout', quantity: 1 }],
            shipping_address: { country: 'US', postal_code: '94105', city: 'San Francisco', state: 'CA' },
          },
        },
      })
      .expect(200);

    const createOrderResp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout_retry')
      .set('X-Buyer-Ref', 'buyer_rollout_retry')
      .send({
        operation: 'create_order',
        payload: {
          order: {
            quote_id: 'q_rollout_expired',
            customer_email: 'rollout@example.com',
            shipping_address: {
              name: 'Rollout Buyer',
              address_line1: '1 Canary Way',
              city: 'San Francisco',
              state: 'CA',
              postal_code: '94105',
              country: 'US',
            },
            items: [
              {
                merchant_id: 'm_rollout',
                product_id: 'p_rollout',
                variant_id: 'v_rollout',
                product_title: 'Canary Serum',
                quantity: 1,
                unit_price: 29,
              },
            ],
          },
        },
      })
      .expect(200);

    const paymentResp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout_retry')
      .set('X-Buyer-Ref', 'buyer_rollout_retry')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ORD_ROLLOUT_RETRY',
            expected_amount: 29,
            currency: 'USD',
            payment_method_hint: 'card',
            buyer_ref: 'buyer_rollout_retry',
          },
        },
      })
      .expect(200);

    expect(previewResp.body.quote_id).toBe('q_rollout_expired');
    expect(createOrderResp.body.order_id).toBe('ORD_ROLLOUT_RETRY');
    expect(createOrderResp.body.quote_id).toBe('q_rollout_retry');
    expect(createOrderResp.body.payment?.client_secret).toBe('cs_rollout_retry');
    expect(paymentResp.body).toMatchObject({
      status: 'requires_action',
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      payment_intent_id: 'pi_rollout_retry',
      psp: 'stripe',
      payment_action: {
        type: 'stripe_client_secret',
        client_secret: 'pi_rollout_retry_secret_456',
      },
      payment: {
        payment_intent_id: 'pi_rollout_retry',
        payment_status: 'requires_action',
      },
    });
    expect(nock.isDone()).toBe(true);
  });

  it('surfaces GOVERNANCE_UNAVAILABLE on create_order without fallback or requote', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_governance')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_governance')
      .post('/agent/v2/orders', (body) => {
        return body && body.quote_id === 'q_rollout_governance_blocked';
      })
      .reply(503, {
        detail: {
          error: 'GOVERNANCE_UNAVAILABLE',
          message: 'Agent governance unavailable for mutating request.',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout_governance')
      .set('X-Buyer-Ref', 'buyer_rollout_governance')
      .send({
        operation: 'create_order',
        payload: {
          order: {
            quote_id: 'q_rollout_governance_blocked',
            customer_email: 'rollout@example.com',
            shipping_address: {
              name: 'Rollout Buyer',
              address_line1: '1 Canary Way',
              city: 'San Francisco',
              state: 'CA',
              postal_code: '94105',
              country: 'US',
            },
            items: [
              {
                merchant_id: 'm_rollout',
                product_id: 'p_rollout',
                variant_id: 'v_rollout',
                product_title: 'Canary Serum',
                quantity: 1,
                unit_price: 29,
              },
            ],
          },
        },
      })
      .expect(503);

    expect(res.body).toMatchObject({
      detail: {
        error: 'GOVERNANCE_UNAVAILABLE',
        message: 'Agent governance unavailable for mutating request.',
      },
    });
    expect(nock.isDone()).toBe(true);
  });

  it('surfaces GOVERNANCE_UNAVAILABLE on submit_payment without retrying', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .matchHeader('X-Agent-User-JWT', 'jwt_rollout_governance')
      .matchHeader('X-Buyer-Ref', 'buyer_rollout_governance')
      .post('/agent/v1/payments', (body) => {
        return body && body.order_id === 'ORD_ROLLOUT_GOVERNANCE';
      })
      .reply(503, {
        detail: {
          error: 'GOVERNANCE_UNAVAILABLE',
          message: 'Agent governance unavailable for mutating request.',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-User-JWT', 'jwt_rollout_governance')
      .set('X-Buyer-Ref', 'buyer_rollout_governance')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ORD_ROLLOUT_GOVERNANCE',
            expected_amount: 29,
            currency: 'USD',
            payment_method_hint: 'card',
            buyer_ref: 'buyer_rollout_governance',
          },
        },
      })
      .expect(503);

    expect(res.body).toMatchObject({
      detail: {
        error: 'GOVERNANCE_UNAVAILABLE',
        message: 'Agent governance unavailable for mutating request.',
      },
    });
    expect(nock.isDone()).toBe(true);
  });
});
