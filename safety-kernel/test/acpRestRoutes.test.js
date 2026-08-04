import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { SafetyKernel } from '../src/kernel.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { createAcpRouteHandlers, normalizeAcpRouteRequest } from '../src/protocol/acpRestRoutes.js';
import { InMemoryKvStore } from '../src/stores.js';

const SECRET = 'acp-route-signing-secret-0123456789';
const KSECRET = 'acp-route-kernel-secret-0123456789';
const FIXED_NOW = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const QUOTE = {
  merchant_of_record: 'merch_A',
  currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }],
  acp_state: {},
};

function sign(rawBody, ts = FIXED_NOW) {
  return createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');
}

function setup() {
  const upstreamCalls = [];
  const kernel = new SafetyKernel({
    secret: KSECRET,
    log: quiet,
    now: () => FIXED_NOW,
    upstream: async (op, payload) => {
      upstreamCalls.push({ op, payload });
      if (op === 'preview_quote') return QUOTE;
      if (op === 'create_order') return { order_id: 'o_route', acp_state: {} };
      if (op === 'submit_payment') return { payment_id: 'pay_route', payment_status: 'succeeded' };
      return {};
    },
  });
  const executor = createCanonicalExecutor({
    kernel,
    upstream: async () => ({}),
    verifyPaymentAuthorization: async (_authz, bound) => ({
      ok: true,
      amount: bound.amount,
      currency: bound.currency,
      user_ref: bound.user_ref,
    }),
  });
  const adapter = createAcpRestAdapter({
    executor,
    sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }),
    signingSecret: SECRET,
    resolveUserRef: async (req) => req.headers['x-test-buyer'],
    now: () => FIXED_NOW,
  });
  return { adapter, upstreamCalls };
}

test('ACP route handlers forward captured rawBody for signature verification and pricing', async () => {
  const { adapter, upstreamCalls } = setup();
  const routes = createAcpRouteHandlers(adapter, { basePath: '/acp' });
  const createRoute = routes.find((r) => r.method === 'POST' && r.path === '/acp/checkout_sessions');
  assert.ok(createRoute);

  const rawBody = JSON.stringify({ merchant_id: 'merch_A', buyer: { email: 'route@example.com' }, items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] });
  const out = await createRoute.handler({
    headers: {
      timestamp: String(FIXED_NOW),
      signature: sign(rawBody),
      'idempotency-key': 'idem-route-001',
      'x-test-buyer': 'buyer_route',
    },
    rawBody: Buffer.from(rawBody),
    body: { merchant_id: 'merch_A', buyer: { email: 'route@example.com' }, items: [{ product_id: 'p1', variant_id: 'v1', quantity: 99, amount: 999999 }] },
    params: {},
  });

  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.headers['content-type'], 'application/json');
  const priced = upstreamCalls.find((c) => c.op === 'preview_quote')?.payload.quote;
  assert.equal(priced.items[0].quantity, 1, 'adapter must price from the signed raw body');
  assert.equal(priced.items[0].amount, undefined, 'parsed-body money injection must not enter pricing');
});

test('ACP route normalizer does not synthesize rawBody from parsed JSON', () => {
  const normalized = normalizeAcpRouteRequest({
    headers: {},
    body: { items: [{ product_id: 'p1', quantity: 1 }] },
    params: {},
  });
  assert.equal(normalized.rawBody, undefined);
  assert.deepEqual(normalized.body, { items: [{ product_id: 'p1', quantity: 1 }] });
});
