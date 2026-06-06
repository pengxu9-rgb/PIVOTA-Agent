const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nock = require('nock');
const request = require('supertest');

describe('strict Safety Kernel mount on /agent/shop/v1/invoke', () => {
  const ORIGINAL_ENV = { ...process.env };
  const API_BASE = 'http://localhost:8080';
  const CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
  const WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
  let app;

  beforeEach(() => {
    nock.cleanAll();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      PIVOTA_API_BASE: API_BASE,
      PIVOTA_API_KEY: 'test-token',
      AGENT_CHECKOUT_STRICT: '1',
      AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
      CONFIRMATION_SECRET,
      PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };
    delete require.cache[require.resolve('../../src/server')];
    app = require('../../src/server');
  });

  afterEach(() => {
    nock.cleanAll();
    process.env = { ...ORIGINAL_ENV };
    delete require.cache[require.resolve('../../src/server')];
  });

  function signedWebhook(body) {
    return crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');
  }

  function strictHeaders(req) {
    return req
      .set('X-Test-User-Ref', 'usr_strict')
      .set('X-Test-Acp-Session-Id', 'acp_strict');
  }

  async function previewAndCreateOrder() {
    nock(API_BASE)
      .post('/agent/v2/quotes/preview', (body) => {
        return (
          body?.merchant_id === 'm_strict' &&
          Array.isArray(body?.offer_refs) &&
          body.offer_refs[0]?.product_id === 'p_strict' &&
          body.offer_refs[0]?.variant_id === 'v_strict'
        );
      })
      .reply(200, {
        quote: {
          quote_id: 'q_strict',
          expires_at: '2026-12-31T00:00:00Z',
          currency: 'USD',
          price_breakdown: {
            subtotal: '29.00',
            discount_total: '0.00',
            total: '29.00',
            currency: 'USD',
          },
          shipping_breakdown: {
            shipping_fee: '0.00',
            delivery_options: [],
          },
          tax_breakdown: {
            tax: '0.00',
          },
          provenance: {
            engine: 'shopify_rest_checkout',
            engine_ref: 'tok_strict',
          },
          line_items: [{ product_id: 'p_strict', variant_id: 'v_strict', quantity: 1 }],
        },
      })
      .post('/agent/v2/orders', (body) => {
        return (
          body?.idempotency_key === 'idem_create_strict' &&
          body?.quote_id === 'q_strict' &&
          body?.buyer_context?.shipping_address?.address_line1 === '1 Kernel Way'
        );
      })
      .reply(200, {
        status: 'success',
        order: {
          order_id: 'ORD_STRICT',
          quote_id: 'q_strict',
          amounts: {
            total: '29.00',
            currency: 'USD',
          },
        },
        tracking: { order_id: 'ORD_STRICT' },
      });

    const quote = await strictHeaders(
      request(app).post('/agent/shop/v1/invoke'),
    )
      .send({
        operation: 'preview_quote',
        payload: {
          quote: {
            merchant_id: 'm_strict',
            items: [{ product_id: 'p_strict', variant_id: 'v_strict', quantity: 1 }],
            shipping_address: { country: 'US', postal_code: '94105', city: 'San Francisco', state: 'CA' },
          },
        },
      })
      .expect(200);

    assert.notEqual(quote.body.quote_id, 'q_strict');

    const order = await strictHeaders(
      request(app).post('/agent/shop/v1/invoke'),
    )
      .send({
        operation: 'create_order',
        payload: {
          idempotency_key: 'idem_create_strict',
          order: {
            quote_id: quote.body.quote_id,
            shipping_address: {
              recipient_name: 'Strict Buyer',
              address_line1: '1 Kernel Way',
              city: 'San Francisco',
              state: 'CA',
              postal_code: '94105',
              country: 'US',
            },
          },
        },
      })
      .expect(200);

    assert.deepEqual(
      {
        order_id: order.body.order_id,
        amount_total: order.body.amount_total,
        currency: order.body.currency,
        confirmation_required: order.body.confirmation_required,
      },
      {
        order_id: 'ORD_STRICT',
        amount_total: 2900,
        currency: 'USD',
        confirmation_required: true,
      },
    );
    return { quote: quote.body, order: order.body };
  }

  it('routes quote/order/pay through the Safety Kernel and finalizes via signed raw webhook', async () => {
    await previewAndCreateOrder();
    const commerce = await app._debug.__agentCheckoutStrict.getCommerceMount();
    const confirmationToken = await commerce.mintConfirmation(
      { order_id: 'ORD_STRICT' },
      { user_ref: 'usr_strict', acp_session_id: 'acp_strict' },
    );

    nock(API_BASE)
      .post('/agent/v1/payments', (body) => {
        return (
          body?.idempotency_key === 'idem_pay_strict' &&
          body?.order_id === 'ORD_STRICT' &&
          body?.payment_method?.type === 'card' &&
          body?.expected_amount === undefined &&
          body?.currency === undefined
        );
      })
      .reply(200, {
        payment_status: 'requires_action',
        payment_intent_id: 'pi_strict',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        payment_action: {
          type: 'redirect_url',
          url: 'https://pay.example/strict',
        },
      });

    const payment = await strictHeaders(
      request(app).post('/agent/shop/v1/invoke'),
    )
      .send({
        operation: 'submit_payment',
        payload: {
          idempotency_key: 'idem_pay_strict',
          confirmation_token: confirmationToken,
          payment: {
            order_id: 'ORD_STRICT',
            expected_amount: 2900,
            currency: 'USD',
            payment_method_hint: 'card',
          },
        },
      })
      .expect(200);

    assert.deepEqual(
      {
        payment_id: payment.body.payment_id,
        payment_status: payment.body.payment_status,
        order_status: payment.body.order_status,
        redirect_url: payment.body.redirect_url,
      },
      {
        payment_id: 'pi_strict',
        payment_status: 'requires_action',
        order_status: 'charge_pending',
        redirect_url: 'https://pay.example/strict',
      },
    );

    const webhookBody = { order_id: 'ORD_STRICT', status: 'succeeded', payment_id: 'pi_strict' };
    const forged = await request(app)
      .post('/agent/shop/v1/payment-webhook')
      .set('X-Pivota-Webhook-Signature', 'forged')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(JSON.stringify(webhookBody)));
    assert.equal(forged.status, 401);

    const rawWebhook = Buffer.from(JSON.stringify(webhookBody));
    const webhook = await request(app)
      .post('/agent/shop/v1/payment-webhook')
      .set('X-Pivota-Webhook-Signature', signedWebhook(rawWebhook))
      .set('Content-Type', 'application/octet-stream')
      .send(rawWebhook)
      .expect(200);

    assert.deepEqual(webhook.body, { transitioned: 'paid' });
    assert.equal(nock.isDone(), true);
  });

  it('rejects strict money operations without trusted user/session identity from auth context', async () => {
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'preview_quote',
        payload: {
          acp_state: { acp_session_id: 'body_controlled_session' },
          quote: {
            merchant_id: 'm_strict',
            items: [{ product_id: 'p_strict', quantity: 1 }],
          },
        },
      });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'USER_AUTH_REQUIRED');
    assert.equal(nock.isDone(), true);
  });

  it('fails before upstream when confirmation_token is missing', async () => {
    await previewAndCreateOrder();

    const res = await strictHeaders(
      request(app).post('/agent/shop/v1/invoke'),
    )
      .send({
        operation: 'submit_payment',
        payload: {
          idempotency_key: 'idem_pay_missing_confirmation',
          payment: {
            order_id: 'ORD_STRICT',
            expected_amount: 2900,
            currency: 'USD',
          },
        },
      });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CONFIRMATION_REQUIRED');
    assert.equal(nock.isDone(), true);
  });

  it('blocks legacy confirm_payment in strict mode', async () => {
    const res = await strictHeaders(
      request(app).post('/agent/shop/v1/invoke'),
    )
      .send({
        operation: 'confirm_payment',
        payload: { payment: { order_id: 'ORD_STRICT' } },
      });

    assert.equal(res.status, 405);
    assert.equal(res.body.code, 'OPERATION_NOT_ALLOWED');
    assert.equal(nock.isDone(), true);
  });
});
