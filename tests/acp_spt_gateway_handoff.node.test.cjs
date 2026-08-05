// PR-F (gateway side) — ACP delegated-PSP-token (Stripe SharedPaymentToken) handoff.
//
// The safety-kernel suite (safety-kernel/test/acpSptDelegatedHandoff.test.js) holds the ROUTING invariants
// (flag-off byte-identity, single-use claim, charge-once, INV-3 for non-SPT tokens, no token in logs). This
// file holds the GATEWAY-side wiring the kernel cannot see:
//
//   - the flag itself (default OFF, and which literals turn it on),
//   - the exact request body sent to the backend's off-session money endpoint,
//   - end to end over the real app: an external ACP agent completing with `payment_data.token = spt_…` must
//     produce POST /agent/v2/orders carrying `metadata.protocol_name = "acp"` and the BACKEND's own quote id,
//     then POST /agent/v1/payments carrying the token — against a stub backend that records both.
//
// The end-to-end case is the one that would have caught a silent regression in any of the three builders it
// crosses (kernel.createOrder → buildCreateOrderV2Body → applyStrictHostedOrderMetadata).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const request = require('supertest');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || 'backend_test_key';

const app = require('../src/server');
const { buildDelegatedPaymentV1Body, isAcpSptGatewayHandoffEnabled } = app._debug;

const SPT = 'spt_1PjKtestTOKENvalue0001';

// --- the flag -----------------------------------------------------------------------------------------------

const FLAG = 'ACP_SPT_GATEWAY_HANDOFF_ENABLED';
function withFlag(value, fn) {
  const original = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  }
}

test('the SPT handoff is OFF by default', () => {
  withFlag(undefined, () => assert.equal(isAcpSptGatewayHandoffEnabled(), false));
  for (const off of ['', '0', 'false', 'off', 'no', 'enabled_maybe']) {
    withFlag(off, () => assert.equal(isAcpSptGatewayHandoffEnabled(), false, `"${off}" must not enable a money path`));
  }
});

test('the SPT handoff turns on for the same literals every other money flag accepts', () => {
  for (const on of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
    withFlag(on, () => assert.equal(isAcpSptGatewayHandoffEnabled(), true, `"${on}" should enable`));
  }
});

// --- the backend request body -------------------------------------------------------------------------------

test('the delegated charge body is {order_id, payment_method:{type:card, token}, idempotency_key} and nothing else', () => {
  const body = buildDelegatedPaymentV1Body({ order_id: 'ord_1', token: SPT, idempotency_key: 'idem-1' });
  assert.deepEqual(body, {
    order_id: 'ord_1',
    payment_method: { type: 'card', token: SPT },
    idempotency_key: 'idem-1',
  });
  // No amount/currency: the backend prices the charge from the order it created from our quote. Re-asserting
  // the figure here would give the amount a second, forgeable source.
  assert.equal('amount' in body, false);
  assert.equal('expected_amount' in body, false);
  assert.equal('currency' in body, false);
  // And no hosted-checkout fields — this endpoint is NOT the hosted checkout-session surface.
  assert.equal('return_url' in body, false);
  assert.equal('payment_handler_id' in body, false);
});

test('the delegated charge body drops empties rather than sending nulls', () => {
  assert.deepEqual(buildDelegatedPaymentV1Body({}), {});
  assert.deepEqual(buildDelegatedPaymentV1Body({ order_id: '  ', token: SPT }), {
    payment_method: { type: 'card', token: SPT },
  });
  // No token ⇒ no payment_method at all (never a bare `{type:'card'}` charge request).
  assert.deepEqual(buildDelegatedPaymentV1Body({ order_id: 'ord_1', idempotency_key: 'k' }), {
    order_id: 'ord_1',
    idempotency_key: 'k',
  });
});

// --- end to end over the live app against a stub backend ----------------------------------------------------

describeEndToEnd();

function describeEndToEnd() {
  const { describe, it, before, after } = require('node:test');

  describe('ACP complete with an spt_ token, end to end against a stub backend', () => {
    const ORIGINAL_ENV = { ...process.env };
    const ACP_SECRET = 'acp-signing-secret-0123456789abc';
    const BUYER_AUD = 'https://agent.test.local/acp';

    let backend;
    let backendUrl;
    let received;
    let buyerJwt;
    let identityIssuersJson;

    before(async () => {
      // ---- stub backend: the three endpoints this lane crosses -------------------------------------------
      received = [];
      backend = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw || '{}'); } catch { body = raw; }
          received.push({ path: req.url, body, headers: req.headers });
          const json = (obj) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj));
          };
          if (req.url.startsWith('/agent/v2/quotes/preview')) {
            // The live v2 wire: a `quote` envelope whose money is MAJOR-unit decimal STRINGS. The gateway's
            // normalizePreviewQuoteCompat flattens it to `pricing`, and the kernel's upstream adapter parses
            // that to minor units — the same two hops a real quote takes.
            return json({
              quote: {
                quote_id: 'bk_quote_9001',
                currency: 'USD',
                price_breakdown: { subtotal: '10.00', total: '11.30', currency: 'USD' },
                tax_breakdown: { tax: '0.80' },
                shipping_breakdown: { shipping_fee: '0.50', delivery_options: [] },
                line_items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }],
              },
            });
          }
          if (req.url.startsWith('/agent/v2/orders')) {
            return json({ order: { order_id: 'ord_delegated_1' }, total: '11.30', currency: 'USD' });
          }
          if (req.url.startsWith('/agent/v1/payments')) {
            return json({ payment_id: 'pi_delegated_1', payment_status: 'succeeded' });
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end('{}');
        });
      });
      await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
      backendUrl = `http://127.0.0.1:${backend.address().port}`;

      const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const pub = await exportJWK(publicKey);
      pub.kid = 'buyer-spt-k1';
      pub.alg = 'ES256';
      identityIssuersJson = JSON.stringify([
        { iss: 'https://buyer.test.local', aud: BUYER_AUD, jwks: { keys: [pub] }, algs: ['ES256'] },
      ]);
      buyerJwt = await new SignJWT({ email: 'spt-buyer@example.com', email_verified: true })
        .setProtectedHeader({ alg: 'ES256', kid: 'buyer-spt-k1' })
        .setIssuer('https://buyer.test.local')
        .setAudience(BUYER_AUD)
        .setSubject('buyer-spt-1')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);
    });

    after(async () => {
      process.env = { ...ORIGINAL_ENV };
      delete require.cache[require.resolve('../src/server')];
      await new Promise((resolve) => backend.close(resolve));
    });

    const bootApp = (extra) => {
      process.env = {
        ...ORIGINAL_ENV,
        NODE_ENV: 'test',
        AGENT_CHECKOUT_STRICT: '1',
        AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
        AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED: '1',
        AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
        ACP_SIGNING_SECRET: ACP_SECRET,
        IDENTITY_ISSUERS_JSON: identityIssuersJson,
        PIVOTA_API_BASE: backendUrl,
        PIVOTA_API_KEY: 'test-token',
        CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
        PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
        ...extra,
      };
      delete require.cache[require.resolve('../src/server')];
      return require('../src/server');
    };

    const signed = (localApp, path, bodyObj, idem) => {
      const rawBody = JSON.stringify(bodyObj);
      const timestamp = String(Date.now());
      return request(localApp)
        .post(path)
        .set('content-type', 'application/json')
        .set('idempotency-key', idem)
        .set('signature', crypto.createHmac('sha256', ACP_SECRET).update(`${timestamp}.${rawBody}`).digest('hex'))
        .set('timestamp', timestamp)
        .set('x-buyer-authorization', `Bearer ${buyerJwt}`)
        .send(rawBody);
    };

    const createBody = { merchant_id: 'm1', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] };

    it('flag ON: routes the completion to /agent/v2/orders (protocol_name=acp) then /agent/v1/payments (token)', async () => {
      const localApp = bootApp({ [FLAG]: '1' });
      received.length = 0;

      const created = await signed(localApp, '/acp/checkout_sessions', createBody, 'idem-spt-e2e-create');
      assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
      const sid = created.body.id;

      const done = await signed(
        localApp,
        `/acp/checkout_sessions/${sid}/complete`,
        { payment_data: { provider: 'stripe', token: SPT } },
        'idem-spt-e2e-complete',
      );
      assert.equal(done.status, 200, `complete failed: ${JSON.stringify(done.body)}`);

      const orderCall = received.find((r) => r.path.startsWith('/agent/v2/orders'));
      assert.ok(orderCall, 'the order was not created on the backend');
      assert.equal(
        orderCall.body.metadata?.protocol_name,
        'acp',
        'without metadata.protocol_name="acp" the backend off-session gate computes guarded=False and the SPT capture lane never engages',
      );
      assert.equal(
        orderCall.body.quote_id,
        'bk_quote_9001',
        'the order must be priced from the BACKEND quote the gateway was quoted from, not a re-quote',
      );

      const payCall = received.find((r) => r.path.startsWith('/agent/v1/payments'));
      assert.ok(payCall, 'the charge did not reach the off-session money endpoint');
      assert.deepEqual(payCall.body.payment_method, { type: 'card', token: SPT });
      assert.equal(payCall.body.order_id, 'ord_delegated_1');
      assert.ok(payCall.headers['idempotency-key'], 'the charge carries an attempt-scoped idempotency key');

      // The hosted checkout-session surface must NOT have been touched: it cannot take a delegated token.
      assert.equal(
        received.some((r) => r.path.startsWith('/agent/v2/payments/checkout-sessions')),
        false,
        'an SPT must never be sent to the hosted checkout surface',
      );

      // And the response the agent sees must not echo the token back.
      assert.equal(JSON.stringify(done.body).includes('spt_'), false);
    });

    // NOTE ON WHICH REFUSAL FIRES HERE. This boot configures no JWS payment-authorization verifier (no
    // ACP/UCP issuer env), so the flag-off refusal is the executor's `no_payment_authorization_verifier`
    // rather than the verifier's own `unknown_authorization_method`. Both are today's CONFIRMATION_INVALID /
    // 402 for this request in this configuration — which is exactly the point of the assertion: nothing about
    // the flag-off answer changed. The stricter claim (identical error DETAIL against a fully-configured
    // production verifier) is proven in safety-kernel/test/acpSptDelegatedHandoff.test.js, which diffs the
    // flag-off path against a control executor built with no SPT wiring at all.
    it('flag OFF: the same request is refused with 402 and neither creates an order nor charges', async () => {
      const localApp = bootApp({ [FLAG]: '0' });
      received.length = 0;

      const created = await signed(localApp, '/acp/checkout_sessions', createBody, 'idem-spt-e2e-create-off');
      assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
      const sid = created.body.id;

      const res = await signed(
        localApp,
        `/acp/checkout_sessions/${sid}/complete`,
        { payment_data: { provider: 'stripe', token: SPT } },
        'idem-spt-e2e-complete-off',
      );
      assert.equal(res.status, 402, `expected a 402 refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'CONFIRMATION_INVALID');

      assert.equal(received.some((r) => r.path.startsWith('/agent/v2/orders')), false, 'flag off must not burn the quote');
      assert.equal(received.some((r) => r.path.startsWith('/agent/v1/payments')), false, 'flag off must not charge');
    });
  });
}
