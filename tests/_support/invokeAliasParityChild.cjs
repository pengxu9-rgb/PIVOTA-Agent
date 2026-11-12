'use strict';

// ONE INVOKE ADDRESS, EVERY OPERATION, EVERY STRICT STATE, in its own process. Prints nothing; writes one JSON
// file. Driven by tests/invoke_route_alias_parity.node.test.cjs, which runs it once per address and requires
// the two files to be equal.
//
// Its own process per address, so both addresses meet the same caches in the same order: in one process the
// second address would be served from what the first one warmed, and the two would differ for that reason.
//
// REAL: the app (routes, auth, the strict route, the kernel mount with its in-memory stores, the invoke handler).
// STUBBED: every host the app dials. One recorder answers all of them (the auth introspection, the backend's
// quote, order and payment routes with a priced answer, everything else with an empty success) and keeps what
// was sent: method, host, path, body and WHICH credential each header carried.
//
// Usage: node tests/_support/invokeAliasParityChild.cjs <address> <outfile>

const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');
const supertest = require('supertest');

const [address, outFile] = process.argv.slice(2);

const BACKEND = 'http://backend.test';
const AUTH = 'http://auth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const SERVICE_KEY = 'service-key-placeholder';
const INTERNAL_KEY = 'internal-key-placeholder';
const CALLER_KEY = `ak_live_${'a'.repeat(64)}`;
const CHECKOUT_TOKEN = `v1.${Buffer.from(JSON.stringify({ agent_id: 'agent_ct', exp: 9999999999 })).toString('base64url')}.${'s'.repeat(43)}`;

const MONEY_OPERATIONS = ['preview_quote', 'create_order', 'submit_payment', 'request_after_sales', 'confirm_payment'];
// [AGENT_CHECKOUT_STRICT, AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED]
const STATES = [['0', '0'], ['0', '1'], ['1', '0'], ['1', '1']];

Object.assign(process.env, {
  NODE_ENV: 'test',
  PIVOTA_API_BASE: BACKEND,
  PIVOTA_API_KEY: SERVICE_KEY,
  // Introspection configured: the real key and checkout-token checks run (no test bypass).
  AGENT_AUTH_INTROSPECT_URL: `${AUTH}${INTROSPECT_PATH}`,
  AGENT_AUTH_INTROSPECT_INTERNAL_KEY: INTERNAL_KEY,
  AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED: 'false',
  AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
  CONFIRMATION_SECRET: 'confirmation-secret-0123456789abcdef',
  PAYMENT_WEBHOOK_SECRET: 'webhook-secret-0123456789abcdef',
  LOG_LEVEL: 'silent',
});
delete process.env.DATABASE_URL;
delete process.env.AGENT_CHECKOUT_STRICT;
delete process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED;

function setState([strict, submit]) {
  if (strict === '1') process.env.AGENT_CHECKOUT_STRICT = '1';
  else delete process.env.AGENT_CHECKOUT_STRICT;
  if (submit === '1') process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED = '1';
  else delete process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED;
}

let current = null;
const stray = [];

function credentialClass(value) {
  if (!value) return null;
  const raw = String(value).replace(/^Bearer\s+/i, '');
  if (raw === CALLER_KEY) return 'caller_key';
  if (raw === SERVICE_KEY) return 'service_key';
  if (raw === INTERNAL_KEY) return 'internal_key';
  if (raw === CHECKOUT_TOKEN) return 'checkout_token';
  return 'other';
}

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-agent-api-key', 'x-internal-key', 'x-checkout-token'];

function identityOf(rawHeaders) {
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders || {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  const identity = {};
  for (const name of CREDENTIAL_HEADERS) identity[name] = credentialClass(headers[name]);
  // Every other x- header, value included, so a header only one address sends is a visible difference.
  identity.other = Object.keys(headers)
    .filter((k) => k.startsWith('x-') && !CREDENTIAL_HEADERS.includes(k))
    .sort()
    .map((k) => `${k}=${headers[k]}`);
  return identity;
}

function cannedReply(uri, body) {
  const p = uri.split('?')[0];
  if (p === INTROSPECT_PATH) {
    if (body && body.checkout_token) {
      return [200, {
        valid: true,
        agent_id: 'agent_ct',
        is_active: true,
        auth_source: 'checkout_token',
        scopes: ['checkout'],
        merchant_ids: ['m_placeholder'],
        expires_at: Math.floor(Date.now() / 1000) + 600,
      }];
    }
    return [200, { valid: true, agent_id: 'agent_key', is_active: true, auth_source: 'agent_api_key', scopes: ['*'] }];
  }
  if (p === '/agent/v2/quotes/preview') {
    return [200, {
      quote: {
        quote_id: 'q_backend',
        expires_at: '2099-12-31T00:00:00Z',
        currency: 'USD',
        price_breakdown: { subtotal: '29.00', discount_total: '0.00', total: '29.00', currency: 'USD' },
        shipping_breakdown: { shipping_fee: '0.00', delivery_options: [] },
        tax_breakdown: { tax: '0.00' },
        provenance: { engine: 'placeholder_engine', engine_ref: 'tok_placeholder' },
        line_items: [{ product_id: 'p_placeholder', variant_id: 'v_placeholder', quantity: 1 }],
      },
    }];
  }
  if (p === '/agent/v2/orders') {
    return [200, {
      status: 'success',
      order: { order_id: 'ORD_PLACEHOLDER', quote_id: 'q_backend', amounts: { total: '29.00', currency: 'USD' } },
      tracking: { order_id: 'ORD_PLACEHOLDER' },
    }];
  }
  if (p === '/agent/v2/payments/checkout-sessions') {
    return [200, {
      status: 'success',
      checkout_session: {
        checkout_session_id: 'cs_placeholder',
        order_id: 'ORD_PLACEHOLDER',
        state: 'created',
        hosted_url: 'https://pay.example/placeholder',
        provider: 'placeholder_hosted_checkout',
      },
    }];
  }
  if (p === '/agent/v1/payments') {
    return [200, { status: 'success', payment_id: 'pay_placeholder', payment_status: 'requires_action', order_id: 'ORD_PLACEHOLDER' }];
  }
  return [200, { status: 'success', products: [], items: [], total: 0 }];
}

const isLoopback = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
nock.disableNetConnect();
nock.enableNetConnect(isLoopback);
for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  nock(/^https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/)
    .persist()
    .intercept(/.*/, method)
    .reply(function record(uri, body) {
      let parsed = body;
      if (typeof body === 'string') {
        try {
          parsed = JSON.parse(body);
        } catch {
          // not JSON: keep the text
        }
      }
      const entry = {
        method,
        host: this.req.options.host || this.req.options.hostname || null,
        path: uri,
        body: parsed === '' ? null : parsed,
        identity: identityOf(this.req.headers),
      };
      (current ? current.outbound : stray).push(entry);
      return cannedReply(uri, parsed);
    });
}

const strayAudits = [];
globalThis.__PIVOTA_AGENT_CHECKOUT_AUDIT_TEST_SINK = (entry) => {
  (current ? current.audits : strayAudits).push(entry);
};

const app = require(path.join(__dirname, '..', '..', 'src', 'server'));
const { OperationEnum } = require(path.join(__dirname, '..', '..', 'src', 'schema'));

const shippingAddress = {
  recipient_name: 'Placeholder Buyer',
  address_line1: '1 Placeholder Way',
  city: 'Placeholder City',
  state: 'CA',
  postal_code: '00000',
  country: 'US',
};
const productRef = { product_id: 'p_placeholder', merchant_id: 'm_placeholder' };

function payloadFor(operation, tag) {
  const key = `idem_${tag}`.replace(/[^a-z0-9_]/gi, '_').padEnd(12, '0');
  switch (operation) {
    case 'find_products': return { search: { merchant_id: 'm_placeholder', query: 'placeholder serum', page: 1, page_size: 5 } };
    case 'find_products_multi': return { search: { query: 'placeholder serum', page: 1, page_size: 5 } };
    case 'find_similar_products': return { similar: { product_id: 'p_placeholder', limit: 4 } };
    case 'products.recommendations': return { recommendations: { product_id: 'p_placeholder', limit: 4 } };
    case 'offers.resolve': return { offers: { product: { product_id: 'p_placeholder' }, market: 'US', limit: 3 } };
    case 'preview_quote': return {
      quote: {
        merchant_id: 'm_placeholder',
        items: [{ product_id: 'p_placeholder', variant_id: 'v_placeholder', quantity: 1 }],
        shipping_address: { country: 'US', postal_code: '00000', city: 'Placeholder City', state: 'CA' },
      },
    };
    case 'find_promotions': return { promotion: { merchant_id: 'm_placeholder' } };
    case 'create_promotion': return { promotion: { merchant_id: 'm_placeholder', name: 'placeholder promotion' } };
    case 'update_promotion': return { promotion_id: 'promo_placeholder', promotion: { name: 'placeholder promotion' } };
    case 'get_product_detail': return { product: { merchant_id: 'm_placeholder', product_id: 'p_placeholder' } };
    case 'pdp_route_id_exists': return { product_id: 'p_placeholder' };
    case 'pdp_live_read': return { live_refresh: { token: 'placeholder-token' } };
    case 'checkout_handoff': return { handoff: productRef };
    case 'create_order': return {
      idempotency_key: key,
      order: { quote_id: 'q_backend', customer_email: 'buyer@example.com', shipping_address: shippingAddress },
    };
    case 'confirm_payment': return { idempotency_key: key, order: { order_id: 'ORD_PLACEHOLDER' }, payment: { order_id: 'ORD_PLACEHOLDER' } };
    case 'submit_payment': return {
      idempotency_key: key,
      confirmation_token: 'confirm_placeholder',
      payment: { order_id: 'ORD_PLACEHOLDER', quote_id: 'q_backend', expected_amount: 2900, currency: 'USD', payment_method_hint: 'card' },
    };
    case 'get_order_status': return { status: { order_id: 'ORD_PLACEHOLDER' } };
    case 'request_after_sales': return {
      idempotency_key: key,
      status: { order_id: 'ORD_PLACEHOLDER', requested_action: 'refund', reason: 'placeholder reason' },
    };
    default: return { product_ref: productRef };
  }
}

const IDENTITY = { 'X-Test-User-Ref': 'usr_placeholder', 'X-Test-Acp-Session-Id': 'acp_placeholder' };
const CREDENTIALS = {
  none: {},
  key: { Authorization: `Bearer ${CALLER_KEY}` },
  token: { 'X-Checkout-Token': CHECKOUT_TOKEN },
  key_identity: { Authorization: `Bearer ${CALLER_KEY}`, ...IDENTITY },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let baseUrl = null;

async function send(id, state, body, headers) {
  current = { outbound: [], audits: [] };
  const mine = current;
  let request = supertest(baseUrl).post(address);
  for (const [k, v] of Object.entries(headers)) request = request.set(k, v);
  let res;
  try {
    res = await request.send(body).timeout({ response: 60000, deadline: 60000 });
  } catch (err) {
    res = err.response || { status: `ERR:${err.code || err.message}`, body: null };
  }
  // Work the handler started after it answered is recorded under this request, not the next.
  await sleep(25);
  current = null;
  results.push({
    id,
    strict: state[0] === '1',
    submit_enabled: state[1] === '1',
    operation: body && typeof body.operation === 'string' ? body.operation.trim() : null,
    status: res.status,
    body: res.body && Object.keys(res.body).length ? res.body : (res.text || null),
    outbound: mine.outbound,
    audits: mine.audits,
  });
  return res;
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const state of STATES) {
    setState(state);
    const label = `strict=${state[0]},submit=${state[1]}`;

    // Every operation the schema names, plus one it does not and a body with none.
    for (const operation of [...OperationEnum.options, '__not_an_operation__', null]) {
      const money = MONEY_OPERATIONS.includes(operation);
      // A money operation meets every credential class in every state; the others meet the full set once
      // (in the state production runs) and the working credential everywhere.
      const credentials = money || (state[0] === '1' && state[1] === '1') ? Object.keys(CREDENTIALS) : ['key_identity'];
      for (const credential of credentials) {
        const body = operation === null
          ? { payload: {} }
          : { operation, payload: payloadFor(operation, `${operation}_${credential}_${state.join('')}`) };
        await send(`${label}|${operation}|${credential}`, state, body, CREDENTIALS[credential]);
      }
    }

    // The strict route reads the operation trimmed; the handler's schema does not accept the padded spelling.
    await send(`${label}|submit_payment(padded)|key`, state, {
      operation: ' submit_payment ',
      payload: payloadFor('submit_payment', `padded_${state.join('')}`),
    }, CREDENTIALS.key);

    // A purchase, each step fed by the one before.
    const headers = CREDENTIALS.key_identity;
    const tag = `flow_${state.join('')}`;
    const quote = await send(`${label}|flow:preview_quote`, state, { operation: 'preview_quote', payload: payloadFor('preview_quote', tag) }, headers);
    const quoteId = quote.body?.quote_id || quote.body?.quote?.quote_id || 'q_backend';
    const order = await send(`${label}|flow:create_order`, state, {
      operation: 'create_order',
      payload: {
        idempotency_key: `idem_${tag}_order`,
        order: { quote_id: quoteId, customer_email: 'buyer@example.com', shipping_address: shippingAddress },
      },
    }, headers);
    const orderId = order.body?.order_id || order.body?.order?.order_id || 'ORD_PLACEHOLDER';
    let confirmationToken = 'confirm_placeholder';
    if (state[0] === '1') {
      try {
        const commerce = await app._debug.__agentCheckoutStrict.getCommerceMount();
        confirmationToken = await commerce.mintConfirmation(
          { order_id: orderId },
          { user_ref: IDENTITY['X-Test-User-Ref'], acp_session_id: IDENTITY['X-Test-Acp-Session-Id'] },
        );
      } catch {
        // The kernel does not hold this order (the address did not go through it): keep the placeholder.
      }
    }
    const payment = (extra) => ({ order_id: orderId, expected_amount: 2900, currency: 'USD', payment_method_hint: 'card', ...extra });
    // The kernel's payment names no quote; the legacy route requires one. Both spellings, on both addresses.
    await send(`${label}|flow:submit_payment`, state, {
      operation: 'submit_payment',
      payload: { idempotency_key: `idem_${tag}_pay`, confirmation_token: confirmationToken, payment: payment({}) },
    }, headers);
    await send(`${label}|flow:submit_payment(replay)`, state, {
      operation: 'submit_payment',
      payload: { idempotency_key: `idem_${tag}_pay`, confirmation_token: confirmationToken, payment: payment({}) },
    }, headers);
    await send(`${label}|flow:submit_payment(with quote_id)`, state, {
      operation: 'submit_payment',
      payload: { idempotency_key: `idem_${tag}_payq`, confirmation_token: confirmationToken, payment: payment({ quote_id: quoteId }) },
    }, headers);
    await send(`${label}|flow:confirm_payment`, state, {
      operation: 'confirm_payment',
      payload: { idempotency_key: `idem_${tag}_confirm`, order: { order_id: orderId }, payment: { order_id: orderId } },
    }, headers);
    await send(`${label}|flow:get_order_status`, state, { operation: 'get_order_status', payload: { status: { order_id: orderId } } }, headers);
    await send(`${label}|flow:request_after_sales`, state, {
      operation: 'request_after_sales',
      payload: { idempotency_key: `idem_${tag}_refund`, status: { order_id: orderId, requested_action: 'refund', reason: 'placeholder reason' } },
    }, headers);
  }

  fs.writeFileSync(outFile, JSON.stringify({ address, results, stray, stray_audits: strayAudits }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`invokeAliasParityChild failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
