'use strict';

// `start_purchase` on the native MCP door — end to end through the REAL pieces:
//
//   commerceToolSurface.callTool (dial, schema, identity) -> orchestratedPurchaseTool (row rules, price binding,
//     buyer mapping) -> the REAL create client (src/services/agentPurchaseCreateClient.js) and the REAL read client
//     (src/services/agentPurchaseReadClient.js) -> a STUBBED fetchImpl answering with the backend contract's JSON
//   -> back through the REAL money filter (sanitizeResult) and the REAL tool-error mapper.
//
// NO NETWORK: every backend answer is a stub, and the catalog read is a recording fake.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentPurchaseCreateClient, CREATE_REFUSALS } = require('../src/services/agentPurchaseCreateClient');
const { createAgentPurchaseReadClient } = require('../src/services/agentPurchaseReadClient');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => ({
      surface: await import('../mcp-server/src/commerceToolSurface.js'),
      tool: await import('../mcp-server/src/orchestratedPurchaseTool.js'),
      errors: await import('../safety-kernel/src/errors.js'),
      executor: await import('../safety-kernel/src/protocol/canonicalExecutor.js'),
    }))();
  }
  return modsPromise;
}

const FLAG = 'ORCHESTRATED_PURCHASE_TOOL_ENABLED';
const SESSION = Object.freeze({ user_ref: 'buyer_1', acp_session_id: 'sess_1' });
const API_KEY = 'ak_fixture';
const USER_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJidXllci0xIn0.c2lnbmF0dXJlLWZpeHR1cmU';
const FULL_AUTH = () => ({ 'X-API-Key': API_KEY, 'X-Agent-User-JWT': USER_JWT });

const EMAIL = 'ada@example.test';
const PHONE = '+15550100';
const STREET = '900 Brannan St';
const LAST = 'Lovelace';
const POSTAL = '94103';
const BUYER_STRINGS = [EMAIL, PHONE, STREET, LAST, POSTAL];

const AP = 'ap_283fba3ce85c4e59bb331e54';
const RP = 'rp_0123456789abcdef01234567';
const PP = 'pp_aaaaaaaaaaaaaaaaaaaaaaaa';
// `token=` is a query the money filter scrubs everywhere except a buyer handoff: it pins that the page survives.
const CARD_PAGE = 'https://rail.example/bind?token=abc';

// The live demo mirror row (the shape the backend's cart-link lane resolves; see tests/reap_agentic_lane.node.test.cjs).
const LIVE_TOKEN = 'eyJ2IjowLCJ0IjoicmVkaXJlY3QiLCJtYXJrZXQiOiJVUyIsInRvb2wiOiJjcmVhdG9yX2FnZW50cyIsIm1hcmtldF9vYnNlcnZlZCI6dHJ1ZSwiZGVzdCI6Imh0dHBzOi8vanVkeWRvbGwuY29tL3Byb2R1Y3RzL3NpbGt5LW1hdHRlLWxpcC1pbms_dmFyaWFudD00OTgxOTI2NzMwMTY1MyZ1dG1fc291cmNlPXBpdm90YSZ1dG1fbWVkaXVtPWFmZmlsaWF0ZSZ1dG1fY2FtcGFpZ249VVMmcHZ0X2NsaWNrX2lkPWNsa18zNjQ1YmYyZjdkMDk0OWZmYTMxYTRlZjEmdXRtX2NvbnRlbnQ9Y2xrXzM2NDViZjJmN2QwOTQ5ZmZhMzFhNGVmMSIsImN0eCI6eyJzZWVkSWQiOiJlcHN2XzM4YWQ4OGQ0MzZjMzJlMjRiYTdjNjQ0NiIsInNvdXJjZSI6ImV4dGVybmFsX3NlZWRfbGlua3MiLCJwdnRfY2xpY2tfaWQiOiJjbGtfMzY0NWJmMmY3ZDA5NDlmZmEzMWE0ZWYxIiwicHZ0X3N1cmZhY2UiOiJjcmVhdG9yX2FnZW50cyIsInRvb2wiOiJjcmVhdG9yX2FnZW50cyIsImpvaW5fbW9kZSI6InJlZmVycmFsX29ubHkifSwiaWF0IjoxNzkwNjUzMTYyLCJleHAiOjE3OTEyNTc5NjJ9.z2eUZz-tCUGToldwJc-Y_i4XNkDV39QTgKj27vCzVyE';
const JUDY_ROW = Object.freeze({
  product_id: 'sig_6433c8107859a484fb72d14861e84690',
  title: 'Silky Matte Lip Ink',
  brand: 'Judydoll',
  price: 9.99,
  currency: 'USD',
  merchant_id: 'external_seed',
  platform: 'external',
  product_key: 'prod::external_seed::external_seed::ext_0f95730ee5ba05a6b7957ada',
  external_redirect_url: `https://api.pivota.cc/r?token=${LIVE_TOKEN}`,
  destination_url: 'https://judydoll.com/products/silky-matte-lip-ink',
  purchase_grain: 'product',
  variants: [{ variant_id: 'sig_6433c8107859a484fb72d14861e84690' }],
});
// A storefront row whose link names no variant: no cart link can be built for it.
const UNRESOLVABLE_ROW = Object.freeze({
  product_id: 'sig_reap_a', title: 'Standard Eau de Parfum', price: 42.5, currency: 'USD', merchant_id: 'merch_obs_brand',
  external_redirect_url: 'https://www.brand.example/products/standard-edp', product_key: 'prod::m_brand::shopify::1001',
  purchase_grain: 'product', variants: [{ variant_id: 'sig_reap_a' }],
});
const ROWS = Object.freeze({ [JUDY_ROW.product_id]: JUDY_ROW, [UNRESOLVABLE_ROW.product_id]: UNRESOLVABLE_ROW });

function houseError(code, status) {
  return {
    status: 'error',
    error: { code: status === 404 ? 'PRODUCT_NOT_FOUND' : status === 400 ? 'INVALID_REQUEST' : 'CONFLICT', message: code, details: { error: code } },
    detail: { error: code },
  };
}

function unified(railId, state = 'needs_payment_method', extra = {}) {
  return {
    purchase_id: PP, rail: railId.startsWith('ap_') ? 'a2a' : 'reap', executor: 'rail_managed', rail_purchase_id: railId,
    state, rail_state: 'needs_payment_method', created_at: '2026-10-13T00:00:00Z',
    totals: { currency: 'USD', our_price_minor: 999 }, poll_after_seconds: 15,
    next_action: { type: 'open_url', kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-10-13T00:30:00Z' },
    detail: { id: railId, state: 'needs_payment_method', hosted_url: CARD_PAGE }, ...extra,
  };
}

function fakeBackend() {
  const calls = [];
  const state = {
    post: { status: 202, body: { purchase_id: AP, rail: 'a2a', state: 'routing', rail_state: 'opened', poll_after_seconds: 5, variant_title: null } },
    get: new Map([[AP, { status: 200, body: unified(AP) }], [RP, { status: 200, body: unified(RP) }]]),
    mode: null,
  };
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, headers: { ...(init.headers || {}) }, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (state.mode === 'throw') throw new TypeError('fetch failed');
    if (state.mode === 'hang' && init.method === 'POST') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
        const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      }));
    }
    const r = init.method === 'POST' ? state.post : (state.get.get(u.pathname.split('/').pop()) || { status: 404, body: houseError('purchase_not_found', 404) });
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status, text: async () => text };
  }
  return { calls, state, fetchImpl };
}

function fakeLogger() {
  const lines = [];
  const sink = (level) => (detail, msg) => lines.push({ level, msg, ...detail });
  return { lines, info: sink('info'), warn: sink('warn'), error: sink('error') };
}

function recordingExecutor(rows) {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params });
      if (op === 'get_product') {
        const row = rows[params.payload.product.product_id];
        return row ? { product: { ...row } } : { product: null };
      }
      throw new Error(`unexpected op ${op}`);
    },
  };
}

async function build({ backend = fakeBackend(), logger = fakeLogger(), authHeaders = FULL_AUTH, rows = ROWS, timeoutMs } = {}) {
  const m = await mods();
  const executor = recordingExecutor(rows);
  const deps = { baseUrl: 'https://backend.example', fetchImpl: backend.fetchImpl, authHeaders, logger, ...(timeoutMs ? { timeoutMs } : {}) };
  const surface = m.surface.createCommerceToolSurface(executor, {
    cache: false,
    log: logger,
    orchestratedPurchase: { createClient: createAgentPurchaseCreateClient(deps), readClient: createAgentPurchaseReadClient(deps) },
  });
  return { surface, executor, backend, logger, m };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const READ_FLAG = 'AGENT_PURCHASE_ORDER_READ_ENABLED';
const ON = { [FLAG]: '1', [READ_FLAG]: '1' };

function args(over = {}) {
  return {
    idempotency_key: 'idem-purchase-0001',
    merchant_id: 'external_seed',
    product_id: JUDY_ROW.product_id,
    quantity: 1,
    expected_unit_price_minor: 999,
    expected_currency: 'USD',
    consent_version: 'terms-2026-10',
    customer_email: EMAIL,
    shipping_address: { name: `Ada ${LAST}`, phone: PHONE, address_line1: STREET, city: 'San Francisco', state: 'CA', postal_code: POSTAL, country: 'US' },
    ...over,
  };
}

/** `{ ok }` or `{ err }` — the error as the MCP wire carries it. */
async function call(ctx, toolArgs, session = SESSION) {
  try {
    return { ok: await ctx.surface.callTool('start_purchase', toolArgs, session) };
  } catch (err) {
    const wire = ctx.m.surface.toToolError(err);
    return { err: JSON.parse(wire.content[0].text).error, raw: err };
  }
}

const posts = (backend) => backend.calls.filter((c) => c.method === 'POST');

// ---- the door ------------------------------------------------------------------------------------------

test('dark: not listed, and a call is an unknown tool, exactly as before the tool existed', async () => {
  const ctx = await build();
  for (const env of [{ [FLAG]: undefined, [READ_FLAG]: '1' }, { [FLAG]: '1', [READ_FLAG]: undefined }]) await withEnv(env, async () => {
    assert.equal(ctx.surface.tools.some((t) => t.name === 'start_purchase'), false);
    assert.equal(ctx.surface.isCommerceTool('start_purchase'), false);
    await assert.rejects(ctx.surface.callTool('start_purchase', args(), SESSION), (err) => err.name === 'UnknownToolError');
  });
  // The second case: the tool's own dial on but the get_order purchase read off. A purchase it opened could not
  // be polled (get_order would answer "not found" for an existing purchase), so the tool stays dark.
  assert.equal(ctx.backend.calls.length, 0);
});

test('on: listed on the native door with its schema; the UCP dialect does not list or route it', async () => {
  const ctx = await build();
  await withEnv(ON, async () => {
    const tool = ctx.surface.tools.find((t) => t.name === 'start_purchase');
    assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.required.includes('consent_version'));
    assert.equal(ctx.surface.isCommerceTool('start_purchase'), true);
    const ucp = ctx.m.surface.ucpDialectSurface(ctx.surface);
    assert.equal(ucp.tools.some((t) => t.name === 'start_purchase'), false);
    await assert.rejects(ctx.surface.callTool('start_purchase', args(), SESSION, { dialect: 'ucp' }), (err) => err.name === 'UnknownToolError');
  });
});

// ---- the happy path ------------------------------------------------------------------------------------

test('opens the purchase with our row facts and the buyer, then answers in the get_order shape with the page intact', async () => {
  const ctx = await build();
  const { ok } = await withEnv(ON, () => call(ctx, args({ payment_preference: { rail: 'a2a' } })));
  const [post] = posts(ctx.backend);
  assert.equal(post.path, '/agent/v2/commerce/purchases');
  assert.equal(post.headers['X-API-Key'], API_KEY);
  assert.equal(post.headers['X-Agent-User-JWT'], USER_JWT);
  assert.deepEqual(post.body, {
    item_source: 'cart_link',
    merchant_domain: 'judydoll.com',
    product_key: JUDY_ROW.product_key,
    quantity: 1,
    buyer: {
      email: EMAIL,
      consent_version: 'terms-2026-10',
      shipping_address: { firstName: 'Ada', lastName: LAST, phone: PHONE, addressLine1: STREET, city: 'San Francisco', region: 'CA', postalCode: POSTAL, country: 'US' },
    },
    idempotency_key: ctx.m.tool.purchaseIdempotencyKey('idem-purchase-0001'),
    expected_unit_price_minor: 999,
    expected_currency: 'USD',
    payment_preference: { rail: 'a2a' },
  });
  const gets = ctx.backend.calls.filter((c) => c.method === 'GET');
  assert.deepEqual(gets.map((g) => g.path), [`/agent/v2/commerce/purchases/${AP}`]);
  assert.equal(ok.order_id, PP);
  assert.equal(ok.status, 'needs_payment_method');
  assert.equal(ok.rail, 'a2a');
  assert.equal(ok.source, 'agent_purchase');
  // The rail's page reaches the agent verbatim (query intact) under the handoff key.
  assert.equal(ok.next_action.action_url, CARD_PAGE);
});

test('the backend key is namespaced: never the raw tool key, stable for the same key', async (t) => {
  const m = await mods();
  const a = m.tool.purchaseIdempotencyKey('idem-purchase-0001');
  assert.match(a, /^mcp-purchase-v1-[0-9a-f]{48}$/);
  assert.equal(a, m.tool.purchaseIdempotencyKey('idem-purchase-0001'));
  assert.notEqual(a, m.tool.purchaseIdempotencyKey('idem-purchase-0002'));
});

test('no payment_preference: none is sent (the backend router decides)', async () => {
  const ctx = await build();
  await withEnv(ON, () => call(ctx, args()));
  assert.equal('payment_preference' in posts(ctx.backend)[0].body, false);
});

test('a request the backend handed to Reap is read back by its Reap id', async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 202, body: { purchase_id: RP, status: 'resolving', poll_after_seconds: 60 } };
  const ctx = await build({ backend });
  const { ok } = await withEnv(ON, () => call(ctx, args()));
  assert.deepEqual(backend.calls.filter((c) => c.method === 'GET').map((g) => g.path), [`/agent/v2/commerce/purchases/${RP}`]);
  assert.equal(ok.rail, 'reap');
});

test('an accepted purchase whose read-back fails still answers with its id, never an error', async () => {
  const backend = fakeBackend();
  backend.state.get = new Map([[AP, { status: 503, body: { error: 'state_unmapped' } }]]);
  const ctx = await build({ backend });
  const { ok } = await withEnv(ON, () => call(ctx, args()));
  assert.equal(ok.order_id, AP);
  assert.equal(ok.status, 'accepted');
  assert.equal(ok.read_pending, true);
  assert.equal(posts(backend).length, 1);
});

test('the attested email wins over the body one', async () => {
  const ctx = await build();
  const { ok } = await withEnv(ON, () => call(ctx, args({ customer_email: 'model-said@example.test' }), {
    ...SESSION, claims: { sub: 'buyer_1', email: EMAIL, email_verified: true },
  }));
  assert.ok(ok);
  assert.equal(posts(ctx.backend)[0].body.buyer.email, EMAIL);
});

test('a disclaimed attested email is not used; the body one is', async () => {
  const ctx = await build();
  await withEnv(ON, () => call(ctx, args(), { ...SESSION, claims: { sub: 'buyer_1', email: 'idp@example.test', email_verified: false } }));
  assert.equal(posts(ctx.backend)[0].body.buyer.email, EMAIL);
});

// ---- refusals before any write -------------------------------------------------------------------------

test('identity: a call without a verified buyer and session is refused before anything is read', async () => {
  const ctx = await build();
  await withEnv(ON, async () => {
    await assert.rejects(ctx.surface.callTool('start_purchase', args(), {}), (err) => err.name === 'IdentityRequiredError');
  });
  assert.equal(ctx.backend.calls.length, 0);
  assert.equal(ctx.executor.seen.length, 0);
});

test('schema: undeclared arguments and bad values are refused by name, before anything is read', async () => {
  const ctx = await build();
  for (const [bad, needle] of [
    [args({ price: 1 }), '"price"'],
    [args({ consent_version: '' }), 'consent_version'],
    [args({ quantity: 11 }), 'quantity'],
    [args({ variant_id: 'abc' }), 'variant_id'],
    [args({ expected_currency: 'usd' }), 'expected_currency'],
    [args({ shipping_address: { name: 'Ada Lovelace', city: 'SF', country: 'US' } }), 'shipping_address.phone'],
    [args({ payment_preference: { rail: 'cash' } }), 'payment_preference.rail'],
    [args({ variant_id: 111 }), 'variant_id'],
    [args({ shipping_address: { ...args().shipping_address, name: 'Ada' } }), 'shipping_address.name'],
    [args({ shipping_address: { ...args().shipping_address, postal_code: 94103 } }), 'shipping_address.postal_code'],
  ]) {
    const { err } = await withEnv(ON, () => call(ctx, bad));
    assert.ok(err && err.message.includes(needle), `${needle}: ${err && err.message}`);
  }
  assert.equal(ctx.backend.calls.length, 0);
  assert.equal(ctx.executor.seen.length, 0);
});

test('no buyer email anywhere: an intake refusal naming the field, nothing read or sent', async () => {
  const ctx = await build();
  const a = args();
  delete a.customer_email;
  const { err } = await withEnv(ON, () => call(ctx, a));
  assert.equal(err.code, 'QUOTE_REQUIRED');
  assert.deepEqual(err.detail.missing_fields, ['customer_email']);
  assert.equal(ctx.backend.calls.length, 0);
});

test("the shown price is the backend's to judge: it is sent as given, never refused here", async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 409, body: houseError('price_changed', 409) };
  const ctx = await build({ backend });
  const { err } = await withEnv(ON, () => call(ctx, args({ expected_unit_price_minor: 899 })));
  assert.equal(posts(backend).length, 1, 'sent: the backend looks the key up before it checks the price');
  assert.equal(posts(backend)[0].body.expected_unit_price_minor, 899);
  assert.equal(err.code, 'PRICE_CHANGED');
});

test('a retry of an unknown outcome is SENT even after our price moved, so the backend replays the original', async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 503, body: { error: 'checkout_outcome_unknown' } };
  const rows = { [JUDY_ROW.product_id]: { ...JUDY_ROW } };
  const ctx = await build({ backend, rows });
  const first = await withEnv(ON, () => call(ctx, args()));
  assert.equal(first.err.code, 'CHECKOUT_OUTCOME_UNKNOWN');
  rows[JUDY_ROW.product_id] = { ...JUDY_ROW, price: 12.99 }; // our catalog re-priced in between
  backend.state.post = { status: 202, body: { purchase_id: AP, rail: 'a2a', state: 'routing', rail_state: 'opened', poll_after_seconds: 5 } };
  const retry = await withEnv(ON, () => call(ctx, args()));
  assert.equal(posts(backend).length, 2);
  assert.deepEqual(posts(backend)[1].body, posts(backend)[0].body, 'the identical body, so the backend matches the key');
  assert.equal(retry.ok.rail_purchase_id, AP);
});

test('a row no cart link can buy is refused by name, nothing sent', async () => {
  const ctx = await build();
  const { err } = await withEnv(ON, () => call(ctx, args({ product_id: UNRESOLVABLE_ROW.product_id, expected_unit_price_minor: 4250, merchant_id: 'merch_obs_brand' })));
  assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
  assert.deepEqual(err.detail, { reason: 'purchase_not_available', refusal_code: 'variant_unresolvable' });
  // A retry of an unknown outcome can meet this too (the row changed in between): the recovery never says "start over".
  assert.match(err.recovery, /may exist: do not start another/);
  // A product our catalog does not have: the shared catalog read's own refusal, the one every checkout door gives.
  const missing = await withEnv(ON, () => call(ctx, args({ product_id: 'sig_missing' })));
  assert.equal(missing.err.code, 'QUOTE_REQUIRED');
  assert.equal(ctx.backend.calls.length, 0);
});

test('without the caller credentials the backend needs: refused, no request', async () => {
  const ctx = await build({ authHeaders: () => ({ 'X-API-Key': API_KEY }) });
  const { err } = await withEnv(ON, () => call(ctx, args()));
  assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(err.detail.reason, 'agent_api_key_required');
  assert.equal(ctx.backend.calls.length, 0);
});

// ---- the backend's answers -----------------------------------------------------------------------------

test('definite backend refusals are named and final; nothing is read back', async () => {
  for (const [code, status, wireCode, reason] of [
    ['price_changed', 409, 'PRICE_CHANGED', 'purchase_price_changed'],
    ['idempotency_conflict', 409, 'OPERATION_NOT_ALLOWED', 'purchase_idempotency_conflict'],
    ['merchant_not_eligible', 409, 'OPERATION_NOT_ALLOWED', 'purchase_refused'],
    ['amount_over_limit', 409, 'OPERATION_NOT_ALLOWED', 'purchase_refused'],
    ['consent_required', 400, 'OPERATION_NOT_ALLOWED', 'purchase_refused'],
  ]) {
    const backend = fakeBackend();
    backend.state.post = { status, body: houseError(code, status) };
    const ctx = await build({ backend });
    const { err } = await withEnv(ON, () => call(ctx, args()));
    assert.equal(err.code, wireCode, code);
    assert.equal(err.detail.reason, reason, code);
    if (reason === 'purchase_refused') assert.equal(err.detail.refusal_code, code);
    assert.equal(backend.calls.filter((c) => c.method === 'GET').length, 0);
  }
});

test('every other answer is an UNKNOWN outcome: retry the same call, never start another', async () => {
  const cases = [
    ['503', (b) => { b.state.post = { status: 503, body: { error: 'checkout_outcome_unknown' } }; }],
    ['404 without a documented reason', (b) => { b.state.post = { status: 404, body: { error: 'something_else' } }; }],
    ['refusal at the wrong status', (b) => { b.state.post = { status: 400, body: houseError('merchant_not_eligible', 400) }; }],
    ['malformed 202', (b) => { b.state.post = { status: 202, body: { purchase_id: 'ap_short', rail: 'a2a', rail_state: 'opened' } }; }],
    ['rail disagrees with id', (b) => { b.state.post = { status: 202, body: { purchase_id: AP, rail: 'reap', rail_state: 'opened' } }; }],
    ['transport', (b) => { b.state.mode = 'throw'; }],
  ];
  for (const [name, setup] of cases) {
    const backend = fakeBackend();
    setup(backend);
    const ctx = await build({ backend });
    const { err } = await withEnv(ON, () => call(ctx, args()));
    assert.equal(err.code, 'CHECKOUT_OUTCOME_UNKNOWN', name);
    assert.equal(err.detail.reason, 'purchase_outcome_unknown', name);
    assert.match(err.recovery, /same idempotency_key/, name);
  }
});

test('a create that hangs is cut at the client budget and is an unknown outcome', async () => {
  const backend = fakeBackend();
  backend.state.mode = 'hang';
  const ctx = await build({ backend, timeoutMs: 60 });
  const started = Date.now();
  const { err } = await withEnv(ON, () => call(ctx, args()));
  assert.equal(err.code, 'CHECKOUT_OUTCOME_UNKNOWN');
  assert.ok(Date.now() - started < 1500);
});

test('no buyer data in any log line', async () => {
  const logger = fakeLogger();
  const backend = fakeBackend();
  const ctx = await build({ backend, logger });
  await withEnv(ON, () => call(ctx, args()));
  backend.state.post = { status: 409, body: houseError('merchant_not_eligible', 409) };
  await withEnv(ON, () => call(ctx, args({ idempotency_key: 'idem-purchase-0002' })));
  const text = JSON.stringify(logger.lines);
  for (const s of [...BUYER_STRINGS, API_KEY, USER_JWT, CARD_PAGE]) assert.equal(text.includes(s), false, s);
});

// ---- the reads -----------------------------------------------------------------------------------------

test('get_order and the read client accept the A2A rail id (the two patterns stay identical)', async () => {
  const m = await mods();
  const { AGENT_PURCHASE_ID_RE } = require('../src/services/agentPurchaseReadClient');
  assert.equal(AGENT_PURCHASE_ID_RE.test(AP), true);
  assert.equal(m.executor.AGENT_PURCHASE_ID_RE.test(AP), true);
  assert.equal(AGENT_PURCHASE_ID_RE.source, m.executor.AGENT_PURCHASE_ID_RE.source);
  assert.equal(AGENT_PURCHASE_ID_RE.test('xp_283fba3ce85c4e59bb331e54'), false);
});

test('the create refusal vocabulary is the backend door\'s, statuses exact', () => {
  assert.equal(CREATE_REFUSALS.amount_over_limit, 409);
  assert.equal(CREATE_REFUSALS.consent_required, 400);
  assert.equal('not_available_on_this_rail' in CREATE_REFUSALS, false, 'a gate answer never says "nothing was opened"');
  assert.equal('opened_on_another_rail' in CREATE_REFUSALS, false);
});


test("a 401 on create is the caller's credentials refused: final, not \"retry the same key\"", async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 401, body: houseError('agent_user_required', 401) };
  const ctx = await build({ backend });
  const { err } = await withEnv(ON, () => call(ctx, args()));
  assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(err.detail.reason, 'caller_credentials_rejected');
});

test('a selected variant on a multi-variant row is sent as its catalog key', async () => {
  const multi = { ...JUDY_ROW, product_id: 'sig_multi', variants: [{ variant_id: '4001', price: { current: { amount: 9.99, currency: 'USD' } } }, { variant_id: '4002', price: { current: { amount: 9.99, currency: 'USD' } } }] };
  const ctx = await build({ rows: { sig_multi: multi } });
  const none = await withEnv(ON, () => call(ctx, args({ product_id: 'sig_multi' })));
  assert.deepEqual(none.err.detail, { reason: 'purchase_not_available', refusal_code: 'variant_required' });
  const chosen = await withEnv(ON, () => call(ctx, args({ product_id: 'sig_multi', variant_id: '4002' })));
  assert.ok(chosen.ok, JSON.stringify(chosen.err));
  assert.equal(posts(ctx.backend)[0].body.variant_key, `${JUDY_ROW.product_key}::v::4002`);
});


test('the controller sequence: unknown outcome, the row key changes, the retry conflicts -> "may exist", never "start fresh"', async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 503, body: { error: 'checkout_outcome_unknown' } };
  const rows = { [JUDY_ROW.product_id]: { ...JUDY_ROW } };
  const ctx = await build({ backend, rows });
  assert.equal((await withEnv(ON, () => call(ctx, args()))).err.code, 'CHECKOUT_OUTCOME_UNKNOWN');
  // Our catalog re-keys the product (a superseded seed): the retry's fingerprint no longer matches the key's.
  rows[JUDY_ROW.product_id] = { ...JUDY_ROW, product_key: 'prod::external_seed::external_seed::ext_ffffffffffffffffffffffff' };
  backend.state.post = { status: 409, body: houseError('idempotency_conflict', 409) };
  const { err } = await withEnv(ON, () => call(ctx, args()));
  assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(err.detail.reason, 'purchase_idempotency_conflict');
  assert.doesNotMatch(`${err.message} ${err.recovery}`, /start(ing)? fresh|new idempotency_key for a new request/i);
  assert.match(err.recovery, /may exist: check it before starting another/);
});

test('a dark backend door, or an explicit rail it cannot honour, is a definite "not available", not an endless retry', async () => {
  for (const code of ['not_available', 'not_available_on_this_rail']) {
    const backend = fakeBackend();
    backend.state.post = { status: 404, body: houseError(code, 404) };
    const ctx = await build({ backend });
    const { err } = await withEnv(ON, () => call(ctx, args()));
    assert.equal(err.code, 'OPERATION_NOT_ALLOWED', code);
    assert.deepEqual(err.detail, { reason: 'purchase_unavailable', refusal_code: code });
    assert.match(err.recovery, /may exist: do not start another/);
    assert.equal(err.retriable, false);
  }
});
