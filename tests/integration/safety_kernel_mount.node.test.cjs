const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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

  function signedConfirmationHeaders({ order_id, user_ref = 'usr_strict', acp_session_id = 'acp_strict' }) {
    const timestamp = String(Date.now());
    const signature = app._debug.__agentCheckoutStrict.buildCheckoutConfirmationActionSignature({
      timestamp,
      user_ref,
      acp_session_id,
      order_id,
      secret: CONFIRMATION_SECRET,
    });
    return {
      'X-Pivota-Confirm-Timestamp': timestamp,
      'X-Pivota-Confirm-Signature': signature,
    };
  }

  function parseMcpToolResult(res) {
    return JSON.parse(res.body.result.content[0].text);
  }

  async function loadJose() {
    const resolved = require.resolve('jose', {
      paths: [
        path.join(__dirname, '..', '..'),
        path.join(__dirname, '..', '..', 'safety-kernel'),
      ],
    });
    return import(pathToFileURL(resolved).href);
  }

  async function installPaymentGrantIssuer() {
    const { SignJWT, generateKeyPair, exportJWK } = await loadJose();
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.alg = 'ES256';
    jwk.use = 'sig';
    jwk.kid = 'mcp-pay-test-k1';
    const iss = 'https://payments.test.pivota.local';
    const aud = 'pivota-agent-payments';
    process.env.PAYMENT_ISSUERS_JSON = JSON.stringify([
      { iss, aud, jwks: { keys: [jwk] }, algs: ['ES256'] },
    ]);
    return {
      async mintGrant({ session_id, amount = 2900, currency = 'USD', merchant_id = 'm_strict', user_ref = 'usr_strict' }) {
        return new SignJWT({
          allowance: {
            max_amount: amount,
            currency,
            merchant_id,
            checkout_session_id: session_id,
            user_ref,
          },
        })
          .setProtectedHeader({ alg: 'ES256', kid: 'mcp-pay-test-k1' })
          .setIssuer(iss)
          .setAudience(aud)
          .setIssuedAt()
          .setExpirationTime('10m')
          .setJti(`grant_${session_id}`)
          .sign(privateKey);
      },
    };
  }

  async function captureAuditRecords(fn) {
    const audits = [];
    const originalSink = globalThis.__PIVOTA_AGENT_CHECKOUT_AUDIT_TEST_SINK;
    globalThis.__PIVOTA_AGENT_CHECKOUT_AUDIT_TEST_SINK = (entry) => audits.push(entry);
    try {
      const result = await fn();
      return { result, audits };
    } finally {
      if (originalSink) globalThis.__PIVOTA_AGENT_CHECKOUT_AUDIT_TEST_SINK = originalSink;
      else delete globalThis.__PIVOTA_AGENT_CHECKOUT_AUDIT_TEST_SINK;
    }
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
          body?.buyer_context?.shipping_address?.address_line1 === '1 Kernel Way' &&
          body?.buyer_context?.shipping_address?.name === 'Strict Buyer'
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
            customer_email: 'strict-buyer@example.com',
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

  it('rejects submit_payment in strict mode until the dedicated flag is enabled', async () => {
    const { result: res, audits } = await captureAuditRecords(async () => {
      return strictHeaders(
        request(app).post('/agent/shop/v1/invoke'),
      )
        .send({
          operation: 'submit_payment',
          payload: {
            idempotency_key: 'idem_pay_strict_disabled',
            confirmation_token: 'confirm_disabled',
            payment: {
              order_id: 'ORD_STRICT',
              expected_amount: 2900,
              currency: 'USD',
              payment_method_hint: 'card',
            },
          },
        });
    });

    assert.equal(res.status, 405);
    assert.equal(res.body.code, 'OPERATION_NOT_ALLOWED');
    assert.match(res.body.message, /submit_payment is disabled/);
    assert.ok(
      audits.some((entry) => entry.event === 'operation_blocked' && entry.operation === 'submit_payment'),
    );
    assert.equal(nock.isDone(), true);
  });

  it('routes quote/order/pay through the Safety Kernel when submit_payment is enabled and finalizes via signed raw webhook', async () => {
    process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED = '1';
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

  it('mounts remote MCP create_checkout_session on the canonical strict kernel path', async () => {
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
      });

    const res = await strictHeaders(request(app).post('/mcp'))
      .send({
        jsonrpc: '2.0',
        id: 'mcp-create-session-1',
        method: 'tools/call',
        params: {
          name: 'create_checkout_session',
          arguments: {
            idempotency_key: 'idem_mcp_create_session',
            user_ref: 'usr_body_attacker',
            acp_session_id: 'acp_body_attacker',
            quote: {
              merchant_id: 'm_strict',
              items: [
                {
                  product_id: 'p_strict',
                  variant_id: 'v_strict',
                  quantity: 1,
                  amount: 999999,
                },
              ],
              shipping_address: {
                country: 'US',
                postal_code: '94105',
                city: 'San Francisco',
                state: 'CA',
              },
            },
          },
        },
      })
      .expect(200);

    const result = parseMcpToolResult(res);
    assert.equal(result.status, 'ready_for_payment');
    assert.match(result.session_id, /^q_/);
    assert.equal(result.totals.total, 2900);
    assert.equal(result.currency, 'USD');
    assert.equal(nock.isDone(), true);
  });

  it('remote MCP complete_checkout_session defaults to a hosted Stripe Checkout redirect surface', async () => {
    process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED = '1';
    process.env.PIVOTA_AGENT_PUBLIC_BASE_URL = 'https://agent.test.pivota.local';
    const issuer = await installPaymentGrantIssuer();

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
          line_items: [{ product_id: 'p_strict', variant_id: 'v_strict', quantity: 1 }],
        },
      });

    const created = await strictHeaders(request(app).post('/mcp'))
      .send({
        jsonrpc: '2.0',
        id: 'mcp-create-session-for-pay-1',
        method: 'tools/call',
        params: {
          name: 'create_checkout_session',
          arguments: {
            idempotency_key: 'idem_mcp_create_for_pay',
            quote: {
              merchant_id: 'm_strict',
              items: [{ product_id: 'p_strict', variant_id: 'v_strict', quantity: 1 }],
              shipping_address: { country: 'US', postal_code: '94105', city: 'San Francisco', state: 'CA' },
            },
          },
        },
      })
      .expect(200);
    const session = parseMcpToolResult(created);

    nock(API_BASE)
      .post('/agent/v2/orders', (body) => {
        return (
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
      })
      .post('/agent/v1/payments', (body) => {
        return (
          body?.order_id === 'ORD_STRICT' &&
          body?.payment_method?.type === 'stripe_checkout' &&
          body?.return_url === 'https://agent.test.pivota.local/checkout/return?order_id=ORD_STRICT' &&
          body?.expected_amount === undefined &&
          body?.currency === undefined
        );
      })
      .reply(200, {
        payment_status: 'requires_action',
        payment_intent_id: 'cs_strict_checkout',
        psp: 'stripe',
        payment_action: {
          type: 'redirect_url',
          url: 'https://checkout.stripe.test/cs_strict_checkout',
          submit_owner: 'redirect',
          component_kind: 'stripe_checkout',
          supported_in_shopping_ui: true,
        },
      });

    const grant = await issuer.mintGrant({ session_id: session.session_id });
    const paid = await strictHeaders(request(app).post('/mcp'))
      .send({
        jsonrpc: '2.0',
        id: 'mcp-complete-hosted-redirect-1',
        method: 'tools/call',
        params: {
          name: 'complete_checkout_session',
          arguments: {
            idempotency_key: 'idem_mcp_complete_hosted_redirect',
            session_id: session.session_id,
            payment_authorization: {
              method: 'acp_delegated_token',
              token: grant,
            },
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

    const result = parseMcpToolResult(paid);
    assert.equal(result.order.order_id, 'ORD_STRICT');
    assert.equal(result.payment.payment_status, 'requires_action');
    assert.equal(result.payment.order_status, 'charge_pending');
    assert.equal(result.payment.redirect_url, 'https://checkout.stripe.test/cs_strict_checkout');
    assert.equal(nock.isDone(), true);
  });

  it('remote MCP invalid user JWT strips fallback identity and fails closed', async () => {
    const res = await strictHeaders(request(app).post('/mcp'))
      .set('X-Agent-User-JWT', 'not-a-jwt')
      .send({
        jsonrpc: '2.0',
        id: 'mcp-invalid-jwt-1',
        method: 'tools/call',
        params: {
          name: 'create_checkout_session',
          arguments: {
            idempotency_key: 'idem_mcp_invalid_jwt',
            quote: {
              merchant_id: 'm_strict',
              items: [{ product_id: 'p_strict', variant_id: 'v_strict', quantity: 1 }],
            },
          },
        },
      })
      .expect(200);

    assert.equal(res.body.result.isError, true);
    const text = res.body.result.content[0].text;
    assert.match(text, /USER_AUTH_REQUIRED/);
    assert.equal(nock.isDone(), true);
  });

  it('remote MCP blocks complete_checkout_session while submit_payment gate is closed', async () => {
    const { result: res, audits } = await captureAuditRecords(async () => {
      return strictHeaders(request(app).post('/mcp'))
        .send({
          jsonrpc: '2.0',
          id: 'mcp-complete-disabled-1',
          method: 'tools/call',
          params: {
            name: 'complete_checkout_session',
            arguments: {
              idempotency_key: 'idem_mcp_complete_disabled',
              session_id: 'q_disabled',
              payment_authorization: {
                method: 'acp_delegated_token',
                token: 'grant_disabled',
              },
            },
          },
        })
        .expect(200);
    });

    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /OPERATION_NOT_ALLOWED/);
    assert.match(res.body.result.content[0].text, /submit_payment is disabled/);
    assert.ok(
      audits.some((entry) => entry.event === 'operation_blocked' && entry.operation === 'complete_checkout_session'),
    );
    assert.equal(nock.isDone(), true);
  });

  it('mounts host-only confirmation action with signed user-action verification', async () => {
    const { order } = await previewAndCreateOrder();

    const unsigned = await strictHeaders(request(app).post('/checkout/confirm'))
      .send({
        order_id: order.order_id,
        user_ref: 'usr_body_attacker',
        acp_session_id: 'acp_body_attacker',
      });
    assert.equal(unsigned.status, 403);
    assert.equal(unsigned.body.error.code, 'CONFIRMATION_ACTION_REQUIRED');

    const signed = await strictHeaders(request(app).post('/checkout/confirm'))
      .set(signedConfirmationHeaders({ order_id: order.order_id }))
      .send({
        order_id: order.order_id,
        user_ref: 'usr_body_attacker',
        acp_session_id: 'acp_body_attacker',
      })
      .expect(200);
    assert.equal(typeof signed.body.confirmation_token, 'string');
    assert.ok(signed.body.confirmation_token.length > 20);

    const commerce = await app._debug.__agentCheckoutStrict.getCommerceMount();
    await assert.rejects(
      commerce.mintConfirmation(
        { order_id: order.order_id },
        { user_ref: 'usr_attacker', acp_session_id: 'acp_strict' },
      ),
      (error) => error?.code === 'STATE_LINKAGE_MISMATCH',
    );
    assert.equal(nock.isDone(), true);
  });

  it('rejects strict money operations without trusted user/session identity from auth context', async () => {
    const { result: res, audits } = await captureAuditRecords(async () => {
      return request(app)
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
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'USER_AUTH_REQUIRED');
    assert.ok(
      audits.some((entry) => entry.event === 'user_auth_blocked' && entry.operation === 'preview_quote'),
    );
    assert.equal(nock.isDone(), true);
  });

  it('fails before upstream when confirmation_token is missing', async () => {
    process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED = '1';
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

  it('preserves strict-off legacy submit_payment behavior without the dedicated flag', async () => {
    process.env.AGENT_CHECKOUT_STRICT = '0';

    nock(API_BASE)
      .post('/agent/v1/payments', (body) => {
        return (
          body?.order_id === 'ord_legacy' &&
          body?.payment_method?.type === 'card' &&
          body?.expected_amount === undefined &&
          body?.currency === undefined
        );
      })
      .reply(200, {
        payment_status: 'processing',
        payment_intent_id: 'pi_legacy',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ord_legacy',
            quote_id: 'quote_legacy',
            expected_amount: 2900,
            currency: 'USD',
            payment_method_hint: 'card',
          },
        },
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.payment_status, 'processing');
    assert.equal(res.body.payment.payment_intent_id, 'pi_legacy');
    assert.equal(nock.isDone(), true);
  });

  it('blocks legacy confirm_payment in strict mode', async () => {
    const { result: res, audits } = await captureAuditRecords(async () => {
      return strictHeaders(
        request(app).post('/agent/shop/v1/invoke'),
      )
        .send({
          operation: 'confirm_payment',
          payload: { payment: { order_id: 'ORD_STRICT' } },
        });
    });

    assert.equal(res.status, 405);
    assert.equal(res.body.code, 'OPERATION_NOT_ALLOWED');
    assert.ok(
      audits.some((entry) => entry.event === 'operation_blocked' && entry.operation === 'confirm_payment'),
    );
    assert.equal(nock.isDone(), true);
  });
});
