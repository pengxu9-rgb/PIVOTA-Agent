'use strict';

// The REAP AGENTIC lane of the UCP checkout door — end to end through the REAL pieces:
//
//   UCP wire args -> ucpArgumentAdapter -> commerceToolSurface.callTool (identity, allowlist, lane order)
//     -> ucpReapAgenticLane -> the REAL backend client (src/services/reapAgenticPurchaseClient.js)
//     -> a STUBBED fetchImpl answering with the backend contract's own JSON (pivota-backend
//        docs/reap_agentic_routes.md, captured from the real app)
//     -> back through the REAL money filter (sanitizeResult) and the REAL UCP shaper, and — where it says so —
//        through the REAL remote MCP adapter, i.e. the JSON-RPC body a platform receives.
//
// NO NETWORK. Nothing here resolves DNS: every backend answer is a stub, the kernel is a recording fake, and the
// purchasability gate is either off (the default) or a real isolated client over a stubbed transport.
//
// Discovered by scripts/run_node_test_suites.cjs (glob over tests/**/*.node.test.cjs), which is what the
// `node-tests` job of .github/workflows/pr-full-jest.yml runs.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReapAgenticPurchaseClient, MAX_TIMEOUT_MS } = require('../src/services/reapAgenticPurchaseClient');
const { createReapRecoveryIdentityReader } = require('../src/services/reapRecoveryIdentity');
const {
  GATE_FLAG_ENV,
  OPS_TOKEN_ENV,
  BASE_URL_ENV,
  createMerchantPurchasabilityClient,
} = require('../src/services/merchantPurchasabilityClient');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => ({
      surface: await import('../mcp-server/src/commerceToolSurface.js'),
      lane: await import('../mcp-server/src/ucpReapAgenticLane.js'),
      adapter: await import('../mcp-server/src/remoteMcpAdapter.js'),
      errors: await import('../safety-kernel/src/errors.js'),
      sanitizer: await import('../safety-kernel/src/protocol/resultSanitizer.js'),
    }))();
  }
  return modsPromise;
}

// ---- fixtures ------------------------------------------------------------------------------------------

const LANE_FLAG = 'REAP_AGENTIC_LANE_ENABLED';
const ESCALATION_FLAG = 'AGENT_CHECKOUT_UCP_ESCALATION_ENABLED';
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const PID = 'rp_283fba3ce85c4e59bb331e54';
const OTHER_BUYERS_PID = 'rp_0123456789abcdef01234567';
const SESSION = Object.freeze({ user_ref: 'buyer_1', acp_session_id: 'sess_1' });
const API_KEY = 'ak_minds_fixture';
const USER_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJidXllci0xIn0.c2lnbmF0dXJlLWZpeHR1cmU';

// Buyer data — every one of these strings is grepped for in every response and every log line below.
const EMAIL = 'ada@example.test';
const PHONE = '+15550100';
const STREET = '900 Brannan St';
const SUITE = 'Suite 400';
const LAST = 'Lovelace';
const POSTAL = '94103';
const BUYER_STRINGS = [EMAIL, PHONE, STREET, SUITE, LAST, POSTAL];

// A non-native Shopify row, as the unscoped read serves it: the builder's storefront redirect (so the door has
// already classified it as NOT Pivota-transacted), our catalog key, product-grain (one purchasable unit).
const REAP_ROW = Object.freeze({
  product_id: 'sig_reap_a',
  title: 'Standard Eau de Parfum',
  brand: 'Brand',
  price: 42.5,
  currency: 'USD',
  merchant_id: 'merch_obs_brand',
  external_redirect_url: 'https://www.brand.example/products/standard-edp',
  product_key: 'prod::m_brand::shopify::1001',
  purchase_grain: 'product',
  variants: [{ variant_id: 'sig_reap_a' }],
});
// A CONTRACTED (native-completable) merchant row that would otherwise look eligible: Shopify key, a domain.
const NATIVE_ROW = Object.freeze({
  product_id: 'p_native_1',
  title: 'Native Serum',
  price: 20,
  currency: 'USD',
  merchant_id: 'merchant_native',
  canonical_url: 'https://native.example/products/serum',
  product_key: 'prod::merchant_native::shopify::77',
  variants: [{ variant_id: '48930014462260' }],
});
const MULTI_VARIANT_ROW = Object.freeze({
  ...REAP_ROW,
  product_id: 'sig_reap_multi',
  purchase_grain: 'variant',
  variants: [{ variant_id: '4001' }, { variant_id: '4002' }],
});

const DESTINATION = Object.freeze({
  first_name: 'Ada',
  last_name: LAST,
  phone_number: PHONE,
  street_address: STREET,
  extended_address: SUITE,
  address_locality: 'San Francisco',
  address_region: 'CA',
  postal_code: POSTAL,
  address_country: 'US',
});

const ABSENT = Symbol('absent');
function createArgs({ productId = REAP_ROW.product_id, quantity = 1, key = 'idem-reap-0001', consent = 'reap-agentic-v1', destination = DESTINATION, buyerExtra = {}, discounts = ABSENT, reap = ABSENT, expectedMoney = undefined, legacy = false } = {}) {
  // Original displayed fixture prices, independent of later drifted/read rows.
  const originalPrices = {
    sig_reap_a:[4250,'USD'],sig_6433c8107859a484fb72d14861e84690:[999,'USD'],
    sig_jsm_skin_nuder_cushion:[3800,'SGD'],sig_bb8acf5d9319c377ce7710dd06fd3395:[2600,'USD'],
    sig_07176ee6bdd7c39f60dd4f9fc121df0d:[2000,'USD'],sig_016e4c1188aad178f54edf96f9d486fc:[3400,'USD'],
    sig_1d54c9e3b5d3969ea4327b5de4f5d101:[3200,'USD'],sig_f5da0819600319955648dc6b9da64125:[2400,'USD'],
  };
  const original = originalPrices[productId] || [4250,'USD'];
  const money = expectedMoney || {expected_unit_price_minor:original[0],expected_currency:original[1]};
  const buyer = { email: EMAIL, ...buyerExtra };
  if (consent !== ABSENT) buyer.consent_version = consent;
  return {
    meta: { 'ucp-agent': { profile: 'https://minds.example/.well-known/ucp-agent' }, 'idempotency-key': key },
    checkout: {
      line_items: [{ item: { id: productId }, quantity }],
      buyer,
      context: { address_country: 'US' },
      ...(destination ? { fulfillment: { methods: [{ type: 'shipping', destinations: [{ ...destination }] }] } } : {}),
      ...(discounts !== ABSENT ? { discounts } : {}),
      ...(!legacy && (expectedMoney || reap !== ABSENT || process.env.REAP_AGENTIC_LANE_ENABLED === "1") ? { reap: {...money,...(reap===ABSENT?{}:reap)} } : {}),
    },
  };
}
const META = { 'ucp-agent': { profile: 'https://minds.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-reap-0002' };

// The backend's purchase views — the contract page's captured JSON, per state, for THIS purchase id.
function view(state, extra = {}) {
  return {
    id: PID,
    state,
    merchant_domain: 'brand.example',
    product_key: REAP_ROW.product_key,
    variant_key: 'sku::prod::m_brand::shopify::1001::v1',
    product_name: 'Standard Eau de Parfum',
    variant_title: 'Standard',
    brand: 'Brand',
    category: 'fragrance',
    quantity: 1,
    reap_quote_expires_at: null,
    refusal_reason: null,
    last_error_code: null,
    consent_version: 'reap-agentic-v1',
    consented_at: '2026-09-23T11:55:49.926588+00:00',
    created_at: '2026-09-23T11:55:49.926588+00:00',
    updated_at: '2026-09-23T11:55:49.959009+00:00',
    terminal_at: null,
    totals: { currency: 'USD', our_price_minor: 4250, quoted_total_minor: null, final_total_minor: null, shipping_minor: null, tax_minor: null },
    poll_after_seconds: 30,
    ...extra,
  };
}
const ENROLL_URL = 'https://pay.prava.space/enroll/3fa85f64';
const APPROVE_URL = 'https://pay.prava.space/checkout/chk_7f3a';
const LATER = '2026-09-23T13:00:00.000000+00:00';
const EARLIER = '2026-09-23T11:00:00.000000+00:00';
const SOON = '2026-09-23T12:05:00.000000+00:00';
const QUOTED = { currency: 'USD', our_price_minor: 4250, quoted_total_minor: 4500, final_total_minor: null, shipping_minor: 100, tax_minor: 150 };
const FINAL = { ...QUOTED, final_total_minor: 4500 };

function houseError(code, status) {
  return {
    status: 'error',
    error: { code: status === 404 ? 'PRODUCT_NOT_FOUND' : status === 400 ? 'INVALID_REQUEST' : 'CONFLICT', message: code, details: { error: code } },
    metadata: { timestamp: '2026-09-23T12:00:00.000000Z', request_id: 'req-fixture' },
    detail: { error: code },
  };
}

/** The backend, stubbed at the transport. Records every request the REAL client makes. */
function fakeBackend() {
  const calls = [];
  const state = {
    post: { status: 202, body: { purchase_id: PID, status: 'resolving', poll_after_seconds: 60 } },
    get: new Map([[PID, { status: 200, body: view('resolving') }]]),
    recover: new Map(),
    mode: null, // null | 'throw' | 'hang'
  };
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    calls.push({
      method: init.method,
      path: u.pathname,
      headers: { ...(init.headers || {}) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (state.mode === 'throw') throw new TypeError('fetch failed');
    if (state.mode === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    let r;
    // `post` may be a LIST, consumed one per POST (the last one repeating) — for the lane's Tier B retry.
    if (init.method === 'POST' && u.pathname.endsWith('/recover')) {
      const body = JSON.parse(init.body);
      r = state.recover.get(body.idempotency_key) || { status: 404, body: houseError('purchase_not_found', 404) };
      if (typeof r === 'function') r = r(body);
    } else if (init.method === 'POST') r = Array.isArray(state.post) ? (state.post.length > 1 ? state.post.shift() : state.post[0]) : state.post;
    else r = state.get.get(u.pathname.split('/').pop()) || { status: 404, body: houseError('purchase_not_found', 404) };
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

const READ_FAILS = Symbol('read fails');
function recordingExecutor(rows, errors) {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params });
      if (op === 'get_product') {
        const row = rows[params.payload.product.product_id];
        if (row === READ_FAILS) throw new Error('upstream read failed');
        return row ? { product: { ...row } } : { product: null };
      }
      if (op === 'get_checkout_session' || op === 'update_checkout_session' || op === 'complete_checkout_session') {
        // What the kernel answers for a session id it has never minted.
        throw new errors.PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'unknown_session' });
      }
      return { session_id: 'q_kernel' };
    },
  };
}

const ROWS = Object.freeze({
  [REAP_ROW.product_id]: REAP_ROW,
  [NATIVE_ROW.product_id]: NATIVE_ROW,
  [MULTI_VARIANT_ROW.product_id]: MULTI_VARIANT_ROW,
});

const FULL_AUTH = () => ({ 'X-API-Key': API_KEY, Authorization: `Bearer ${API_KEY}`, 'X-Agent-User-JWT': USER_JWT });

async function build({ requireAuthoritativeRefusal = false, lane = true, logger = fakeLogger(), backend = fakeBackend(), clientTimeoutMs, authHeaders = FULL_AUTH, rows = ROWS } = {}) {
  const m = await mods();
  m.lane.resetReapLaneLogOnceForTest();
  const executor = recordingExecutor(rows, m.errors);
  const client = createReapAgenticPurchaseClient({
    baseUrl: 'https://backend.example',
    requireAuthoritativeRefusal,
    fetchImpl: backend.fetchImpl,
    authHeaders,
    logger,
    ...(clientTimeoutMs ? { timeoutMs: clientTimeoutMs } : {}),
  });
  const identityQueries = [];
  const recoveryIdentityReader = createReapRecoveryIdentityReader({ query: async (sql, values) => {
    identityQueries.push({ sql, values });
    return { rows: rows[values[0]] ? [rows[values[0]]] : [] };
  } });
  const native = m.surface.createCommerceToolSurface(executor, {
    cache: false,
    log: logger,
    ...(lane ? { reapAgentic: { client, recoveryIdentityReader } } : {}),
  });
  const ucp = m.surface.ucpDialectSurface(native);
  return { ucp, executor, backend, logger, client, m, identityQueries };
}

/** Run with env vars set, restoring exactly what was there. */
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
const ON = { [LANE_FLAG]: '1', [ESCALATION_FLAG]: undefined, [GATE_FLAG_ENV]: undefined };

/** `{ ok }` or `{ err }` — the error as the MCP wire would carry it. */
async function outcome(m, p) {
  try {
    return { ok: await p };
  } catch (e) {
    return { err: m.surface.toToolError(e) };
  }
}

// Every response this file produces is collected here and walked at the end for card/PII fields.
const ALL_RESPONSES = [];
const ALL_LOGS = [];
function keep(value) { ALL_RESPONSES.push(value); return value; }

const REQUIRED_CHECKOUT = ['ucp', 'id', 'line_items', 'status', 'currency', 'totals', 'links'];
const STATUS_ENUM = ['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled'];
const REAP_ID_RE = /^reap_rp_[0-9a-f]{24}\.[A-Za-z0-9_-]+$/;

function assertSpecCheckout(out) {
  for (const k of REQUIRED_CHECKOUT) assert.ok(Object.hasOwn(out, k), `checkout is missing required member ${k}`);
  assert.ok(STATUS_ENUM.includes(out.status), `status ${out.status} is not a UCP status`);
  assert.deepEqual(out.ucp.payment_handlers, {});
  assert.equal(out.totals.filter((t) => t.type === 'subtotal').length, 1);
  assert.equal(out.totals.filter((t) => t.type === 'total').length, 1);
  // UCP total.json: a discount is strictly NEGATIVE; subtotal / fulfillment / tax / fee are non-negative.
  for (const t of out.totals) {
    if (t.type === 'discount' || t.type === 'items_discount') assert.ok(t.amount < 0, `${t.type} must be < 0, got ${t.amount}`);
    if (['subtotal', 'fulfillment', 'tax', 'fee'].includes(t.type)) assert.ok(t.amount >= 0, `${t.type} must be >= 0`);
  }
  if (out.discounts && Array.isArray(out.discounts.applied)) {
    for (const a of out.discounts.applied) assert.ok(Number.isSafeInteger(a.amount) && a.amount >= 0, 'applied amount is a non-negative amount');
  }
  if (out.status === 'requires_escalation') assert.match(out.continue_url, /^https:\/\//);
  else assert.equal(Object.hasOwn(out, 'continue_url'), false, `continue_url on a ${out.status} checkout`);
}

function message(out, code) {
  return (out.messages || []).find((msg) => msg.code === code);
}

async function createReap(env, opts = {}) {
  const ctx = await build(opts);
  const out = await withEnv(env, () => ctx.ucp.callTool('create_checkout', createArgs(opts.args), SESSION));
  return { ...ctx, out: keep(out) };
}

// =========================================================================================================
// 0. SWITCH OFF — byte-identical, zero backend calls
// =========================================================================================================


// The kernel's stub checkout answer as it leaves the UCP dialect: unchanged, plus the `ucp` envelope with
// `payment_handlers: {}` that UCP requires on every checkout response (ucpResponseShaper.shapeUcpCheckoutResponse).
const KERNEL_ON_UCP = Object.freeze({ session_id: 'q_kernel', ucp: { version: '2026-04-08', status: 'success', payment_handlers: {} } });

test('switch OFF: create/get/update/complete are byte-identical to a door without the lane, with 0 backend calls', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const m = await mods();
  const reapId = m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const calls = [
    ['create_checkout', createArgs()],
    ['get_checkout', { meta: META, id: reapId }],
    ['update_checkout', { meta: META, id: reapId, checkout: { line_items: [{ item: { id: REAP_ROW.product_id }, quantity: 2 }], buyer: { email: EMAIL } } }],
    ['complete_checkout', { meta: META, id: reapId, checkout: { payment: { method: 'ucp_handler', token: 'grant-fixture' } } }],
  ];
  for (const escalation of [undefined, '1']) {
    for (const laneFlag of [undefined, '0', 'off']) {
      const withLane = await build({ lane: true });
      const without = await build({ lane: false });
      for (const [tool, args] of calls) {
        const env = { [LANE_FLAG]: laneFlag, [ESCALATION_FLAG]: escalation };
        const a = await withEnv(env, () => outcome(m, withLane.ucp.callTool(tool, structuredClone(args), SESSION)));
        const b = await withEnv(env, () => outcome(m, without.ucp.callTool(tool, structuredClone(args), SESSION)));
        assert.equal(JSON.stringify(a), JSON.stringify(b), `${tool} (lane=${laneFlag}, escalation=${escalation}) must be byte-identical`);
        keep(a);
      }
      assert.equal(withLane.backend.calls.length, 0, 'the switch off makes NO backend call');
      assert.deepEqual(withLane.executor.seen.map((c) => c.op), without.executor.seen.map((c) => c.op), 'and the kernel sees the same calls');
    }
  }
});

test('switch OFF snapshot: the pinned answers for the fixture offer', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const m = await mods();
  const { ucp, backend } = await build({ lane: true });
  // Escalation off: the kernel path, exactly as before.
  const kernel = await withEnv({ [LANE_FLAG]: undefined, [ESCALATION_FLAG]: undefined }, () => ucp.callTool('create_checkout', createArgs(), SESSION));
  assert.deepEqual(kernel, KERNEL_ON_UCP);
  // Escalation on: the storefront checkout, pinned byte for byte.
  const escalated = await withEnv({ [LANE_FLAG]: undefined, [ESCALATION_FLAG]: '1' }, () => ucp.callTool('create_checkout', createArgs(), SESSION));
  assert.equal(JSON.stringify(escalated), JSON.stringify({
    ucp: { version: '2026-04-08', status: 'success', payment_handlers: {} },
    id: escalated.id,
    status: 'requires_escalation',
    continue_url: 'https://www.brand.example/products/standard-edp',
    currency: 'USD',
    line_items: [{ id: 'li_1', item: { id: 'sig_reap_a', title: 'Standard Eau de Parfum', price: 4250 }, quantity: 1, totals: [{ type: 'subtotal', amount: 4250 }, { type: 'total', amount: 4250 }] }],
    totals: [
      { type: 'subtotal', amount: 4250, display_text: "Expected subtotal (catalog's last observed price)" },
      { type: 'total', amount: 4250, display_text: "Expected total before the seller's shipping and tax" },
    ],
    buyer: { email: EMAIL },
    links: [{ type: 'terms_of_service', url: 'https://pivota.cc/terms', title: 'Pivota Terms of Service' }],
    expires_at: '2026-09-23T18:00:00.000Z',
    messages: escalated.messages,
  }));
  assert.match(escalated.id, /^esc_/);
  assert.equal(escalated.messages[0].code, 'checkout.completes_on_seller_storefront');
  // …and a `reap_` id with the switch off is just an unknown id to the kernel.
  const reapId = m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const got = await withEnv({ [LANE_FLAG]: undefined }, () => outcome(m, ucp.callTool('get_checkout', { meta: META, id: reapId }, SESSION)));
  assert.equal(JSON.parse(got.err.content[0].text).error.code, 'CHECKOUT_OUTCOME_UNKNOWN');
  assert.equal(ucp === undefined, false);
  assert.equal(backend.calls.length, 0);
});

// =========================================================================================================
// 1. ON + ELIGIBLE — one POST, an `incomplete` reap_ checkout at once, through the real filter + shaper
// =========================================================================================================

test('on + eligible: ONE backend POST -> 202 -> checkout {id: reap_…, status: incomplete}; the kernel never runs', async () => {
  const { out, backend, executor } = await createReap(ON);
  assert.match(out.id, REAP_ID_RE);
  assert.ok(out.id.startsWith(`reap_${PID}.`), 'the id carries the backend purchase id');
  assert.equal(out.status, 'incomplete');
  assertSpecCheckout(out);
  assert.equal(out.currency, 'USD');
  // item.id ECHOES the caller's id (as the storefront lane does); the product_key is never published.
  assert.deepEqual(out.line_items, [{ id: 'li_1', item: { id: 'sig_reap_a', title: 'Standard Eau de Parfum', price: 4250 }, quantity: 1, totals: [{ type: 'subtotal', amount: 4250 }, { type: 'total', amount: 4250 }] }]);
  assert.equal(JSON.stringify(out).includes('prod::'), false);
  assert.equal(message(out, 'reap.poll_after_seconds').content, '60', 'the backend cadence is carried');
  assert.ok(message(out, 'reap.resolving'));

  assert.equal(backend.calls.length, 1);
  const [call] = backend.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/agent/v2/commerce/reap/purchases');
  assert.equal(call.headers['X-API-Key'], API_KEY);
  assert.equal(call.headers['X-Agent-User-JWT'], USER_JWT, 'the buyer JWT is forwarded');
  assert.deepEqual(call.body, {
    merchant_domain: 'www.brand.example', // AS OBSERVED, lowercased only — the backend canonicalises both sides
    product_key: 'prod::m_brand::shopify::1001',
    quantity: 1,
    buyer: {
      email: EMAIL,
      consent_version: 'reap-agentic-v1',
      shipping_address: {
        firstName: 'Ada', lastName: LAST, phone: PHONE, addressLine1: STREET, addressLine2: SUITE,
        city: 'San Francisco', region: 'CA', postalCode: POSTAL, country: 'US',
      },
    },
    expected_unit_price_minor:4250,expected_currency:'USD',
    idempotency_key: call.body.idempotency_key,
  });
  assert.equal(Object.hasOwn(call.body, 'variant_key'), false, 'no variant key is ever guessed');
  assert.equal(executor.seen.some((c) => c.op === 'create_checkout_session'), false, 'no kernel quote, no inventory hold');
});

test('lane order: with storefront escalation ALSO on, an eligible row is answered by Reap, and the storefront lane never runs', async () => {
  const { out, backend, executor } = await createReap({ ...ON, [ESCALATION_FLAG]: '1' });
  assert.match(out.id, REAP_ID_RE, 'Reap before the storefront link');
  assert.equal(out.status, 'incomplete');
  assert.equal(backend.calls.length, 1);
  assert.equal(executor.seen.filter((c) => c.op === 'get_product').length, 1, 'one read, shared');
});

test('on + eligible, on the JSON-RPC wire: the remote MCP adapter carries the same checkout', async () => {
  const ctx = await build();
  const rpc = ctx.m.adapter.createRemoteMcpAdapter(ctx.ucp, {
    authenticate: async () => ({ sessionContext: SESSION }),
    resolveSessionContext: (req, auth) => auth.sessionContext,
  });
  const res = await withEnv(ON, () => rpc.handleJsonRpc({
    headers: {},
    body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_checkout', arguments: createArgs() } },
  }));
  assert.equal(res.status, 200);
  const checkout = JSON.parse(res.body.result.content[0].text);
  keep(res.body);
  assert.match(checkout.id, REAP_ID_RE);
  assert.equal(checkout.status, 'incomplete');
  assertSpecCheckout(checkout);
});

test('the lane answer leaves through the REAL money filter: a secret-shaped value planted in the view is scrubbed', async () => {
  // Construction already refuses unknown view members; this proves the filter is ALSO on the path, by planting a
  // value in a member the lane DOES read (the product name) and watching it be redacted on the way out.
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body: view('resolving', { product_name: 'Serum sk_live_abcdefghijklmnop' }) });
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  assert.equal(out.line_items[0].item.title, 'Serum [REDACTED_SECRET] — Standard');
});

test('the title leaves through the real filter and shaper: plain for LTR text, the RTL half alone isolated', async () => {
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body: view('resolving', { product_name: 'Lip Ink \u05E9\u05E4\u05EA\u05D5\u05DF\u200F', variant_title: '07 BURGUNDY INK' }) });
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  assert.equal(out.line_items[0].item.title, '\u2068Lip Ink \u05E9\u05E4\u05EA\u05D5\u05DF\u200F\u2069 — 07 BURGUNDY INK');
});

// =========================================================================================================
// 2. get_checkout — every backend state, through the BUILT response
// =========================================================================================================

const STATE_TABLE = [
  // [label, backend body, expected status, expected continue_url, expected message code]
  ['resolving', view('resolving'), 'incomplete', undefined, 'reap.resolving'],
  ['needs_enrollment + url', view('needs_enrollment', { hosted_url: ENROLL_URL, hosted_url_expires_at: LATER }), 'requires_escalation', ENROLL_URL, 'reap.needs_enrollment'],
  ['quoting', view('quoting'), 'incomplete', undefined, 'reap.quoting'],
  ['awaiting_approval + url', view('awaiting_approval', { totals: QUOTED, reap_quote_expires_at: LATER, hosted_url: APPROVE_URL, hosted_url_expires_at: LATER }), 'requires_escalation', APPROVE_URL, 'reap.awaiting_approval'],
  ['processing', view('processing', { totals: QUOTED }), 'complete_in_progress', undefined, 'reap.processing'],
  ['completed + order ref', view('completed', { totals: FINAL, order_reference: 'ord_991', poll_after_seconds: null, terminal_at: LATER }), 'completed', undefined, 'reap.completed'],
  ['refused', view('refused', { refusal_reason: 'options:sole_label_differs:size', poll_after_seconds: null }), 'canceled', undefined, 'reap.purchase_refused'],
  ['failed', view('failed', { last_error_code: 'checkout_failed', poll_after_seconds: null }), 'canceled', undefined, 'reap.purchase_failed'],
  ['expired', view('expired', { poll_after_seconds: null }), 'canceled', undefined, 'reap.purchase_expired'],
  // A pending state with nowhere to send the buyer is NOT published as requires_escalation.
  ['needs_enrollment, no url', view('needs_enrollment'), 'incomplete', undefined, 'reap.hosted_page_not_ready'],
  ['needs_enrollment, expired url', view('needs_enrollment', { hosted_url: ENROLL_URL, hosted_url_expires_at: EARLIER }), 'incomplete', undefined, 'reap.hosted_page_not_ready'],
  ['needs_enrollment, url with NO expiry', view('needs_enrollment', { hosted_url: ENROLL_URL }), 'incomplete', undefined, 'reap.hosted_page_not_ready'],
  ['awaiting_approval, url with a null expiry', view('awaiting_approval', { hosted_url: APPROVE_URL, hosted_url_expires_at: null }), 'incomplete', undefined, 'reap.hosted_page_not_ready'],
  // A state the backend adds after this door: in progress, named, logged once — not "could not be read".
  ['an unknown future state', view('partner_review'), 'incomplete', undefined, 'reap.state_unrecognised'],
  ['needs_enrollment, foreign host', view('needs_enrollment', { hosted_url: 'https://pay.prava.space.evil.example/enroll/1', hosted_url_expires_at: LATER }), 'incomplete', undefined, 'reap.hosted_page_not_ready'],
  ['awaiting_approval, http url', view('awaiting_approval', { hosted_url: 'http://pay.prava.space/checkout/1', hosted_url_expires_at: LATER }), 'incomplete', undefined, 'reap.hosted_page_not_ready'],
  ['awaiting_approval, secret-shaped query', view('awaiting_approval', { hosted_url: 'https://pay.prava.space/checkout/1?token=abc', hosted_url_expires_at: LATER }), 'incomplete', undefined, 'reap.hosted_page_not_ready'],
  // A URL is NEVER forwarded for a non-pending state, whatever the body carries.
  ['processing + stray url', view('processing', { hosted_url: APPROVE_URL, hosted_url_expires_at: LATER }), 'complete_in_progress', undefined, 'reap.processing'],
  ['completed + stray url', view('completed', { totals: FINAL, order_reference: 'ord_991', hosted_url: APPROVE_URL, hosted_url_expires_at: LATER }), 'completed', undefined, 'reap.completed'],
  ['resolving + stray url', view('resolving', { hosted_url: ENROLL_URL, hosted_url_expires_at: LATER }), 'incomplete', undefined, 'reap.resolving'],
];

for (const [label, body, status, continueUrl, code] of STATE_TABLE) {
  test(`get_checkout maps backend "${label}" -> ${status}`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const backend = fakeBackend();
    backend.state.get.set(PID, { status: 200, body });
    const ctx = await build({ backend });
    const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
    const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
    assert.equal(out.id, id);
    assert.equal(out.status, status);
    assert.equal(out.continue_url, continueUrl);
    assertSpecCheckout(out);
    assert.ok(message(out, code), `expected message ${code}; got ${JSON.stringify(out.messages.map((x) => x.code))}`);
    assert.equal(backend.calls.length, 1, 'exactly ONE backend GET');
    assert.equal(backend.calls[0].method, 'GET');
    assert.equal(backend.calls[0].path, `/agent/v2/commerce/reap/purchases/${PID}`);
    assert.equal(backend.calls[0].headers['X-Agent-User-JWT'], USER_JWT);
    const terminal = ['completed', 'canceled'].includes(status);
    assert.equal(Boolean(message(out, 'reap.poll_after_seconds')), !terminal, 'a poll hint on every non-terminal answer, none on a terminal one');
  });
}

// =========================================================================================================
// 2b. the approval deadline — the quote TTL, not the hosted page's expiry
//
// Measured 2026-09-25 in the Reap sandbox: the page says created + 15 min; the checkout is FAILED (not EXPIRED)
// seconds after the quote's created + 5 min. The backend publishes the earlier as `approval_deadline`.
// =========================================================================================================

async function getCheckout(body) {
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body });
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  return keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
}

test('awaiting_approval: expires_at is approval_deadline (the quote TTL), NOT the page\'s later hosted_url_expires_at', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const out = await getCheckout(view('awaiting_approval', {
    totals: QUOTED, reap_quote_expires_at: SOON, approval_deadline: SOON, hosted_url: APPROVE_URL, hosted_url_expires_at: LATER,
  }));
  assert.equal(out.status, 'requires_escalation');
  assert.equal(out.continue_url, APPROVE_URL);
  assert.equal(out.expires_at, new Date(Date.parse(SOON)).toISOString());
  assert.notEqual(out.expires_at, new Date(Date.parse(LATER)).toISOString());
  const deadline = message(out, 'reap.approval_deadline');
  assert.ok(deadline, 'the deadline is a bare message a platform can read without parsing prose');
  assert.equal(deadline.type, 'info');
  assert.equal(deadline.content, out.expires_at);
  assert.equal(deadline.path, '$.expires_at');
  const text = message(out, 'reap.awaiting_approval').content;
  assert.match(text, /before expires_at/);
  assert.doesNotMatch(text, /expires_at — the quote/, 'the prose must not assert the VALUE is the quote expiry: with an older backend it is the page expiry');
  assert.match(text, /usually the merchant quote/);
  assertSpecCheckout(out);
});

test('awaiting_approval: a PASSED approval_deadline hides the link even though the page itself is still live', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const out = await getCheckout(view('awaiting_approval', {
    totals: QUOTED, reap_quote_expires_at: EARLIER, approval_deadline: EARLIER, hosted_url: APPROVE_URL, hosted_url_expires_at: LATER,
  }));
  assert.equal(out.status, 'incomplete', 'not terminal: the backend poller closes the row, this door never invents a canceled');
  assert.equal(out.continue_url, undefined);
  assert.equal(message(out, 'reap.hosted_page_not_ready'), undefined, '"page not available yet, poll again" would be false in both halves');
  const passed = message(out, 'reap.approval_deadline_passed');
  assert.ok(passed);
  assert.equal(passed.type, 'warning');
  assert.match(passed.content, /window closed before the buyer approved/);
  assert.match(passed.content, /create a new checkout/);
  assert.ok(passed.content.endsWith(`Closed at ${new Date(Date.parse(EARLIER)).toISOString()}.`), passed.content);
  assert.equal(passed.content.includes(EARLIER), false, 'the raw backend text is never echoed, only the normalised instant');
  assert.equal(message(out, 'reap.approval_deadline'), undefined);
  assert.ok(message(out, 'reap.poll_after_seconds'), 'still a non-terminal answer');
  assert.equal(JSON.stringify(out).includes('prava.space'), false, 'a link to a page that will not take the approval is not published');
  assertSpecCheckout(out);
});

test('awaiting_approval: a missing link with NO deadline, or a live deadline, is still "page not ready" — the passed message needs a passed deadline', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const extra of [
    { totals: QUOTED },
    { totals: QUOTED, approval_deadline: SOON },
    { totals: QUOTED, approval_deadline: EARLIER, hosted_url: 'http://pay.prava.space/checkout/1', hosted_url_expires_at: LATER },
  ]) {
    const out = await getCheckout(view('awaiting_approval', extra));
    assert.equal(out.status, 'incomplete');
    if (extra.approval_deadline === EARLIER) {
      assert.ok(message(out, 'reap.approval_deadline_passed'), 'a passed deadline beside an unvouched link is still a passed deadline');
    } else {
      assert.ok(message(out, 'reap.hosted_page_not_ready'), JSON.stringify(extra));
      assert.equal(message(out, 'reap.approval_deadline_passed'), undefined);
    }
  }
  // needs_enrollment never carries an approval deadline, so it never says one passed.
  const out = await getCheckout(view('needs_enrollment', { approval_deadline: EARLIER }));
  assert.ok(message(out, 'reap.hosted_page_not_ready'));
  assert.equal(message(out, 'reap.approval_deadline_passed'), undefined);
});

test('awaiting_approval: a backend that does not send approval_deadline falls back to hosted_url_expires_at', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const out = await getCheckout(view('awaiting_approval', {
    totals: QUOTED, reap_quote_expires_at: LATER, hosted_url: APPROVE_URL, hosted_url_expires_at: LATER,
  }));
  assert.equal(out.status, 'requires_escalation');
  assert.equal(out.expires_at, new Date(Date.parse(LATER)).toISOString());
  assert.equal(message(out, 'reap.approval_deadline').content, out.expires_at);
});

test('awaiting_approval: a PRESENT but unreadable approval_deadline is refused, not skipped over for the longer page expiry', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const bad of ['soon', '', 42, {}]) {
    const out = await getCheckout(view('awaiting_approval', {
      totals: QUOTED, approval_deadline: bad, hosted_url: APPROVE_URL, hosted_url_expires_at: LATER,
    }));
    assert.equal(out.status, 'incomplete', JSON.stringify(bad));
    assert.equal(out.continue_url, undefined);
  }
  // null is "not sent" — the fallback, as for an older backend.
  const out = await getCheckout(view('awaiting_approval', {
    totals: QUOTED, approval_deadline: null, hosted_url: APPROVE_URL, hosted_url_expires_at: LATER,
  }));
  assert.equal(out.status, 'requires_escalation');
  assert.equal(out.expires_at, new Date(Date.parse(LATER)).toISOString());
});

test('needs_enrollment: the page expiry is the deadline (nothing is quoted yet) and no reap.approval_deadline message is published', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const out = await getCheckout(view('needs_enrollment', { hosted_url: ENROLL_URL, hosted_url_expires_at: LATER }));
  assert.equal(out.status, 'requires_escalation');
  assert.equal(out.expires_at, new Date(Date.parse(LATER)).toISOString());
  assert.equal(message(out, 'reap.approval_deadline'), undefined);
});

test('failed with approval_window_lapsed: canceled, the reason named, and the buyer agent told what to do', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const out = await getCheckout(view('failed', { last_error_code: 'approval_window_lapsed', poll_after_seconds: null }));
  assert.equal(out.status, 'canceled');
  const failed = message(out, 'reap.purchase_failed');
  assert.match(failed.content, /Reason: approval_window_lapsed\./);
  assert.match(failed.content, /did not approve before the quote expired/);
  assert.match(failed.content, /Create a new checkout to try again\./, 'the actionable half of the hint');
  const plain = await getCheckout(view('failed', { last_error_code: 'checkout_failed', poll_after_seconds: null }));
  assert.doesNotMatch(message(plain, 'reap.purchase_failed').content, /did not approve/);
  // The hint is keyed on the STATE too: the backend writes this code on 'failed' only.
  for (const state of ['refused', 'expired']) {
    const other = await getCheckout(view(state, { refusal_reason: 'approval_window_lapsed', last_error_code: 'approval_window_lapsed', poll_after_seconds: null }));
    assert.doesNotMatch(message(other, `reap.purchase_${state}`).content, /did not approve/, state);
  }
});

test('get_checkout: the completed checkout carries the order reference and the charged total', async () => {
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body: view('completed', { totals: FINAL, order_reference: 'ord_991', poll_after_seconds: null }) });
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  assert.equal(message(out, 'reap.order_reference').content, 'ord_991');
  // Shipping and tax as their own rows now (they reconcile with the charged total).
  assert.deepEqual(out.totals.map((x) => [x.type, x.amount]), [['subtotal', 4250], ['fulfillment', 100], ['tax', 150], ['total', 4500]]);
  assert.equal(out.line_items[0].item.title, 'Standard Eau de Parfum — Standard');
});

test('get_checkout: a refused purchase names its reason; an unsafe reason string is not echoed', async () => {
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body: view('refused', { refusal_reason: 'options:sole_label_differs:size' }) });
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  assert.match(message(out, 'reap.purchase_refused').content, /Reason: options:sole_label_differs:size\./);
  backend.state.get.set(PID, { status: 200, body: view('refused', { refusal_reason: `buyer ${EMAIL} said no <script>` }) });
  const out2 = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  assert.equal(out2.status, 'canceled');
  assert.doesNotMatch(message(out2, 'reap.purchase_refused').content, /Reason:/);
});

// =========================================================================================================
// 3. update / complete — refused by name, no backend call
// =========================================================================================================

test('update_checkout / complete_checkout on a reap_ id are REFUSED with a named reason and no backend call', async () => {
  const ctx = await build();
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const upd = await withEnv(ON, () => outcome(ctx.m, ctx.ucp.callTool('update_checkout', { meta: META, id, checkout: { line_items: [{ item: { id: 'sig_reap_a' }, quantity: 2 }], buyer: { email: EMAIL } } }, SESSION)));
  const cmp = await withEnv(ON, () => outcome(ctx.m, ctx.ucp.callTool('complete_checkout', { meta: META, id, checkout: { payment: { method: 'ucp_handler', token: 'grant-fixture' } } }, SESSION)));
  keep(upd); keep(cmp);
  const u = JSON.parse(upd.err.content[0].text).error;
  const c = JSON.parse(cmp.err.content[0].text).error;
  assert.equal(u.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(c.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(u.retriable, false);
  assert.match(u.message, /cannot be changed here/);
  assert.match(c.message, /Reap's own hosted page/);
  assert.equal(ctx.backend.calls.length, 0);
  assert.equal(ctx.executor.seen.some((x) => x.op === 'complete_checkout_session' || x.op === 'update_checkout_session'), false, 'the kernel (and so the issuer registry / mandate verifier) is never reached');
});

// =========================================================================================================
// 4. backend failures on get — 404 is an unknown id; transport/5xx/timeout/malformed are `incomplete`
// =========================================================================================================

async function unknownIdBody(ctx, id) {
  const r = await withEnv(ON, () => outcome(ctx.m, ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  return r;
}

test('get_checkout: backend 404 -> exactly the body ANY unknown checkout id gets', async () => {
  const backend = fakeBackend();
  backend.state.get.delete(PID);
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const reap404 = await unknownIdBody(ctx, id);
  const plainUnknown = await unknownIdBody(ctx, 'q_never_minted');
  keep(reap404);
  assert.equal(JSON.stringify(reap404), JSON.stringify(plainUnknown));
  assert.equal(JSON.parse(reap404.err.content[0].text).error.code, 'QUOTE_NOT_FOUND');
  // …and the kernel is handed only what it needs: the purchase id, not the line snapshot the full id carries.
  const kernelGets = ctx.executor.seen.filter((c) => c.op === 'get_checkout_session').map((c) => c.params.session_id);
  assert.deepEqual(kernelGets, ['q_never_minted'], 'a Reap miss is answered directly, never through the kernel');
});

for (const [label, status, code] of [
  ['404 not_available_on_this_rail (dial turned off mid-purchase)', 404, 'not_available_on_this_rail'],
  ['404 with no reason body', 404, null],
  ['401 agent_user_required', 401, 'agent_user_required'],
  ['403', 403, 'forbidden'],
  ['429', 429, 'rate_limited'],
  ['400 invalid_request', 400, 'invalid_request'],
]) {
  test(`get_checkout: backend ${label} -> incomplete + retry hint, NEVER "unknown id" (a re-create would open a second purchase)`, async () => {
    const backend = fakeBackend();
    backend.state.get.set(PID, { status, body: code ? houseError(code, status) : 'not json' });
    const ctx = await build({ backend });
    const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
    const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
    assert.equal(out.status, 'incomplete');
    assert.ok(message(out, 'reap.view_unavailable'));
    assert.equal(ctx.executor.seen.some((c) => c.op === 'get_checkout_session'), false, 'the kernel is not asked');
  });
}

for (const [label, arrange] of [
  ['500', (b) => b.state.get.set(PID, { status: 500, body: { status: 'error' } })],
  ['503 non-JSON', (b) => b.state.get.set(PID, { status: 503, body: '<html>upstream</html>' })],
  ['transport error', (b) => { b.state.mode = 'throw'; }],
  ['timeout', (b) => { b.state.mode = 'hang'; }],
  ['200 non-JSON', (b) => b.state.get.set(PID, { status: 200, body: 'not json' })],
  ['200 malformed state', (b) => b.state.get.set(PID, { status: 200, body: view('Not A State!') })],
  ['200 view without totals', (b) => b.state.get.set(PID, { status: 200, body: view('processing', { totals: null }) })],
  ['200 someone else\'s id in the body', (b) => b.state.get.set(PID, { status: 200, body: { ...view('completed'), id: OTHER_BUYERS_PID } })],
]) {
  test(`get_checkout: backend ${label} -> incomplete + retry hint, never terminal`, { timeout: 5000 }, async () => {
    const backend = fakeBackend();
    arrange(backend);
    const ctx = await build({ backend, clientTimeoutMs: 60 });
    const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 2, currency: 'USD', unitMinor: 4250 });
    const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
    assert.equal(out.status, 'incomplete');
    assertSpecCheckout(out);
    assert.ok(message(out, 'reap.view_unavailable'), 'the answer says it is showing the snapshot');
    assert.equal(message(out, 'reap.poll_after_seconds').content, '30');
    assert.equal(out.line_items[0].quantity, 2, 'the line as it stood at creation');
    assert.equal(out.totals.find((x) => x.type === 'total').amount, 8500);
    assert.equal(backend.calls.length, 1, 'ONE attempt, no retry');
  });
}

test('the client clamps its budget to <= 2 s and never unrefs an awaited timer', () => {
  const c = createReapAgenticPurchaseClient({ baseUrl: 'https://b.example', timeoutMs: 60_000, authHeaders: () => ({}) });
  assert.equal(c.timeoutMs, MAX_TIMEOUT_MS);
  assert.equal(MAX_TIMEOUT_MS, 2000);
  const src = require('node:fs').readFileSync(require.resolve('../src/services/reapAgenticPurchaseClient'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''), /\.unref\(/);
});

// =========================================================================================================
// 5. create: a backend refusal FALLS THROUGH to the next lane
// =========================================================================================================

for (const [status, code, expected] of [[409,'merchant_not_eligible','OPERATION_NOT_ALLOWED'],[404,'not_available_on_this_rail','CHECKOUT_OUTCOME_UNKNOWN'],[409,'row_not_found','OPERATION_NOT_ALLOWED'],[401,'agent_user_required','CHECKOUT_OUTCOME_UNKNOWN'],[400,'currency_unsupported','OPERATION_NOT_ALLOWED']]) {
 test(`create_checkout: backend ${status} ${code} stops the selected route without another checkout`,async()=>{
  const backend=fakeBackend();backend.state.post={status,body:houseError(code,status)};
  for(const escalation of [undefined,'1']){
   backend.calls.length=0;const ctx=await build({backend});const result=await withEnv({...ON,[ESCALATION_FLAG]:escalation},()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs(),SESSION)));
   assert.equal(errorOf(result).code,expected);assert.equal(backend.calls.length,1);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);assert.equal(JSON.stringify(result).includes('continue_url'),false);
  }
 });
}

for (const [label, arrange] of [
  ['500', (b) => { b.state.post = { status: 500, body: {} }; }],
  ['timeout after POST', (b) => { b.state.mode = 'hang'; }],
  ['202 without purchase id', (b) => { b.state.post = { status: 202, body: { status: 'resolving' } }; }],
  ['idempotency conflict', (b) => { b.state.post = { status: 409, body: houseError('idempotency_conflict', 409) }; }],
]) {
  test(`create_checkout: ${label} preserves uncertain attempt and never offers another checkout`, { timeout: 5000 }, async () => {
    const backend = fakeBackend();
    arrange(backend);
    for (const escalation of [undefined, '1']) {
      backend.calls.length = 0;
      const ctx = await build({ backend, clientTimeoutMs: 60 });
      const result = await withEnv({ ...ON, [ESCALATION_FLAG]: escalation },
        () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs(), SESSION)));
      assert.ok(result.err, 'an uncertain POST must be a tool error, not a fallback');
      const wire = JSON.parse(result.err.content[0].text);
      assert.equal(wire.error.code, 'CHECKOUT_OUTCOME_UNKNOWN');
      assert.equal(wire.error.retriable, true);
      assert.match(wire.error.recovery, /same idempotency_key/);
      assert.equal(backend.calls.length, 1);
      assert.equal(ctx.executor.seen.some((c) => c.op === 'create_checkout_session'), false);
      assert.equal(JSON.stringify(wire).includes(REAP_ROW.external_redirect_url), false);
    }
  });
}

test('an exact retry after an unknown POST keeps the backend payload and idempotency key unchanged', async () => {
  const backend = fakeBackend();
  backend.state.post = [
    { status: 500, body: {} },
    { status: 202, body: { purchase_id: PID, status: 'resolving', poll_after_seconds: 60 } },
  ];
  const ctx = await build({ backend });
  const failed = await withEnv(ON, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs(), SESSION)));
  assert.equal(JSON.parse(failed.err.content[0].text).error.detail.reason, 'ucp_reap_create_outcome_unknown');
  const retried = await withEnv(ON, () => ctx.ucp.callTool('create_checkout', createArgs(), SESSION));
  assert.match(retried.id, REAP_ID_RE);
  assert.deepEqual(backend.calls[0].body, backend.calls[1].body);
  assert.equal(ctx.executor.seen.some((c) => c.op === 'create_checkout_session'), false);
});

test('create_checkout: the refusal code is what gets logged — and only the code', async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 409, body: houseError('row_not_found', 409) };
  const logger = fakeLogger();
  const ctx = await build({backend,logger});
  await withEnv(ON,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs(),SESSION)));
  ALL_LOGS.push(...logger.lines);
  const line = logger.lines.find((l) => l.event === 'reap_agentic_lane' && l.outcome === 'refused');
  assert.equal(line.code, 'row_not_found');
});

// =========================================================================================================
// 6. consent, native, gate, eligibility
// =========================================================================================================

/** Today's storefront answer for the fixture: the lane OFF, escalation ON — the byte baseline for §6. */
async function storefrontBaseline(args) {
  const ctx = await build({ lane: false });
  return withEnv({ [LANE_FLAG]: undefined, [ESCALATION_FLAG]: '1' }, () => ctx.ucp.callTool('create_checkout', args, SESSION));
}
const HINT = 'reap.available_with_consent';

for(const [code,args] of [['consent_required',{consent:ABSENT}],['invalid_address',{destination:{...DESTINATION,last_name:undefined}}],['invalid_address',{destination:{...DESTINATION,phone_number:undefined}}],['invalid_request',{destination:null}],['invalid_return_url',{}],['invalid_request',{}],['invalid_address',{}],['currency_unsupported',{}]]){
 test(`create_checkout: ${code} buyer/catalog refusal never becomes a store offer`,async()=>{
  const backend=fakeBackend();backend.state.post={status:400,body:houseError(code,400)};const ctx=await build({backend});
  const result=await withEnv({...ON,[ESCALATION_FLAG]:'1'},()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs(args),SESSION)));
  assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(errorOf(result).detail.reason,'ucp_reap_create_refused');assert.equal(backend.calls.length,1);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);assert.equal(JSON.stringify(result).includes('continue_url'),false);
 });
}
test('escalation OFF: a consent refusal cannot enter the kernel',async()=>{
 const backend=fakeBackend();backend.state.post={status:400,body:houseError('consent_required',400)};const ctx=await build({backend});const result=await withEnv(ON,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({consent:ABSENT}),SESSION)));assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
});

test('a VALUE-BEARING 400 body (backend message, fields, validation errors, 2 KB) -> no buyer string in any response or log line', async () => {
  const valueBearing = {
    status: 'error',
    error: {
      code: 'BAD_REQUEST',
      message: `consent_required for ${EMAIL} at ${STREET}, ${POSTAL}; phone ${PHONE}; ${LAST}`,
      details: { error: 'consent_required', fields: { email: EMAIL, address: { addressLine1: STREET, addressLine2: SUITE, lastName: LAST } } },
      validation_errors: Array.from({ length: 12 }, (_, i) => ({ loc: ['buyer', 'shipping_address', i], msg: `bad ${EMAIL} ${PHONE}`, input: STREET })),
    },
    detail: { error: 'consent_required', message: `${EMAIL} ${PHONE} ${STREET} ${SUITE} ${LAST} ${POSTAL}`.repeat(8) },
  };
  assert.ok(JSON.stringify(valueBearing).length >= 2048, 'the fixture really is 2 KB');
  for (const escalation of ['1', undefined]) {
    const backend = fakeBackend();
    backend.state.post = { status: 400, body: valueBearing };
    const logger = fakeLogger();
    const ctx = await build({ backend, logger });
    const r = await withEnv({ ...ON, [ESCALATION_FLAG]: escalation }, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs({ consent: ABSENT,legacy:true }), SESSION)));
    keep(r);
    const text = JSON.stringify(r);
    // The storefront answer echoes the buyer's own email in `buyer.email` today (unchanged); nothing ELSE of
    // the buyer, and nothing from the backend body, may appear.
    for (const v of [PHONE, STREET, SUITE, LAST, POSTAL, 'validation_errors', 'BAD_REQUEST']) assert.equal(text.includes(v), false, `"${v}" in the response`);
    const logText = JSON.stringify(logger.lines);
    for (const v of [...BUYER_STRINGS, 'validation_errors', 'BAD_REQUEST']) assert.equal(logText.includes(v), false, `"${v}" logged`);
    ALL_LOGS.push(...logger.lines);
  }
});

test('consent_version is forwarded VERBATIM — never trimmed, case-folded or filtered', async () => {
  for (const consent of [' Reap-Agentic-V1\u00a0', 'v1\u2028', '版本-1']) {
    const backend = fakeBackend();
    await createReap(ON, { backend, args: { consent } });
    assert.equal(backend.calls[0].body.buyer.consent_version, consent, JSON.stringify(consent));
  }
});

test('the argument adapter ENFORCES the advertised consent schema (string, <= 32 code points) before any lane runs', async () => {
  for (const consent of ['x'.repeat(33), 7, true, {}, null]) {
    const backend = fakeBackend();
    const ctx = await build({ backend });
    const r = keep(await withEnv(ON, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs({ consent }), SESSION))));
    const err = JSON.parse(r.err.content[0].text).error;
    assert.equal(err.detail.reason, 'ucp_consent_version_invalid', JSON.stringify(consent));
    assert.equal(backend.calls.length, 0);
  }
  // 32 code points is fine even when that is more than 32 UTF-16 units
  const backend = fakeBackend();
  await createReap(ON, { backend, args: { consent: '\u{1F600}'.repeat(32) } });
  assert.equal(backend.calls.length, 1);
});

test('get_checkout without rail credentials stays on the primary uncertainty boundary, never kernel',async()=>{
 const backend=fakeBackend();const ctx=await build({backend,authHeaders:()=>({})});const id=ctx.m.lane.encodeReapCheckoutId({purchaseId:PID,productId:REAP_ROW.product_id,productKey:REAP_ROW.product_key,quantity:1,currency:'USD',unitMinor:4250});const result=await withEnv(ON,()=>outcome(ctx.m,ctx.ucp.callTool('get_checkout',{meta:META,id},SESSION)));assert.equal(errorOf(result).code,'CHECKOUT_OUTCOME_UNKNOWN');assert.equal(backend.calls.length,0);assert.equal(ctx.executor.seen.some(c=>c.op==='get_checkout_session'),false);
});

test('a caller the rail cannot serve (no X-Agent-User-JWT, or no API key — e.g. MCP-OAuth) skips the lane silently: 0 backend calls, logged ONCE', async () => {
  for (const authHeaders of [
    () => ({ 'X-API-Key': API_KEY }),
    () => ({ 'X-Agent-User-JWT': USER_JWT }),
    () => ({}),
    // PRESENT BUT EMPTY is not a credential either.
    () => ({ 'X-API-Key': API_KEY, 'X-Agent-User-JWT': '' }),
    () => ({ 'X-API-Key': API_KEY, 'X-Agent-User-JWT': '   ' }),
    () => ({ 'X-API-Key': ' \t ', 'X-Agent-User-JWT': USER_JWT }),
  ]) {
    const backend = fakeBackend();
    const logger = fakeLogger();
    const ctx = await build({ backend, logger, authHeaders });
    for (let i = 0; i < 3; i += 1) {
      const out = keep(await withEnv({ ...ON, [ESCALATION_FLAG]: '1' }, () => ctx.ucp.callTool('create_checkout', createArgs({ consent: ABSENT,legacy:true }), SESSION)));
      assert.equal(out.status, 'requires_escalation', 'today\'s answer, not a consent refusal');
    }
    assert.equal(backend.calls.length, 0);
    assert.equal(ctx.executor.seen.filter((c) => c.op === 'get_product').length, 3, 'skipped before the lane read anything of its own');
    const lines = logger.lines.filter((l) => l.code === 'no_caller_credentials');
    assert.equal(lines.length, 1, 'once, not per request');
    ALL_LOGS.push(...logger.lines);
  }
});

test('native-completable merchant NEVER enters the lane — even a Shopify row with a key and a domain', async () => {
  const ctx = await build();
  const out = keep(await withEnv({ ...ON, [ESCALATION_FLAG]: '1' }, () => ctx.ucp.callTool('create_checkout', createArgs({ productId: NATIVE_ROW.product_id, consent: ABSENT,legacy:true }), SESSION)));
  assert.deepEqual(out, KERNEL_ON_UCP);
  assert.equal(ctx.backend.calls.length, 0);
  assert.ok(ctx.executor.seen.some((c) => c.op === 'create_checkout_session'), 'the kernel path ran');
  // …and the row that DECLARES internal_checkout despite a redirect url is native too
  const m = await mods();
  const executor = recordingExecutor({ x1: { ...REAP_ROW, product_id: 'x1', purchase_route: 'internal_checkout' } }, m.errors);
  const res = await m.lane.tryReapAgenticCheckout({
    op: { id: 'create_checkout_session' }, params: { idempotency_key: 'idem-reap-0001', quote: { items: [{ product_id: 'x1', quantity: 1 }], customer_email: EMAIL } },
    ctx: SESSION, executor, ucpArgs: createArgs({ productId: 'x1' }), client: ctx.client, env: { [LANE_FLAG]: '1' },
  });
  assert.equal(res, null);
  assert.equal(ctx.backend.calls.length, 0);
});

for (const [label, args, rows] of [
  ['multi-variant row', createArgs({ productId: MULTI_VARIANT_ROW.product_id }), null],
  ['quantity above the rail maximum', createArgs({ quantity: 11 }), null],
  ['a non-Shopify key', createArgs({ productId: 'sig_woo' }), { sig_woo: { ...REAP_ROW, product_id: 'sig_woo', product_key: 'prod::m_brand::woocommerce::9' } }],
  ['no product key', createArgs({ productId: 'sig_nokey' }), { sig_nokey: { ...REAP_ROW, product_id: 'sig_nokey', product_key: undefined } }],
]) {
  test(`create_checkout: ${label} -> the lane is not entered (0 backend calls)`, async () => {
    const m = await mods();
    const backend = fakeBackend();
    const ctx = await build({ backend });
    if (rows) {
      const executor = recordingExecutor({ ...ROWS, ...rows }, m.errors);
      const ucp = m.surface.ucpDialectSurface(m.surface.createCommerceToolSurface(executor, { cache: false, reapAgentic: { client: ctx.client } }));
      await withEnv(ON, () => outcome(m, ucp.callTool('create_checkout', args, SESSION)));
    } else {
      await withEnv(ON, () => outcome(m, ctx.ucp.callTool('create_checkout', args, SESSION)));
    }
    assert.equal(backend.calls.length, 0);
  });
}

test('the purchasability gate: declined -> skipped (no POST); asked with the domain + request market only; switch off -> never asked', async () => {
  const m = await mods();
  const opsCalls = [];
  const BROWSE_ONLY = { tier: 'browse_only', enforced: true, sweep_enabled: true };
  const PURCHASE = { tier: 'purchase', enforced: true, sweep_enabled: true };
  const run = async (fact, gateOn) => {
    const env = { [LANE_FLAG]: '1', [BASE_URL_ENV]: 'https://ops.example', [OPS_TOKEN_ENV]: 'admin-jwt-fixture', ...(gateOn ? { [GATE_FLAG_ENV]: '1' } : {}) };
    const gateClient = createMerchantPurchasabilityClient({
      env,
      fetchImpl: async (url) => { opsCalls.push(url); return { ok: true, status: 200, json: async () => fact }; },
      logger: fakeLogger(),
    });
    let asked = 0;
    const shouldOfferPurchase = (a) => { asked += 1; return gateClient.shouldOfferPurchase(a); };
    const backend = fakeBackend();
    const ctx = await build({ backend });
    const executor = recordingExecutor(ROWS, m.errors);
    const res = await m.lane.tryReapAgenticCheckout({
      op: { id: 'create_checkout_session' },
      params: { idempotency_key: 'idem-reap-0001', quote: { items: [{ product_id: REAP_ROW.product_id, quantity: 1 }], customer_email: EMAIL } },
      ctx: SESSION, executor, ucpArgs: createArgs({reap:{}}), client: ctx.client, env, shouldOfferPurchase,
    });
    return { res, backend, asked };
  };
  const declined = await run(BROWSE_ONLY, true);
  assert.equal(declined.res, null, 'skipped');
  assert.equal(declined.backend.calls.length, 0, 'no purchase opened for a browse-only merchant');
  assert.equal(declined.asked, 1);
  const url = new URL(opsCalls[0]);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['domain', 'market']);
  assert.equal(url.searchParams.get('domain'), 'brand.example');
  assert.equal(url.searchParams.get('market'), 'US');
  const allowed = await run(PURCHASE, true);
  assert.match(allowed.res.id, REAP_ID_RE);
  assert.equal(allowed.backend.calls.length, 1);
  const off = await run(BROWSE_ONLY, false);
  assert.equal(off.asked, 0, 'switch off: the gate is not consulted at all');
  assert.equal(off.backend.calls.length, 1);
});

test('the purchasability gate, UNKEYABLE: no market + ENFORCED takes the SAME declined branch (skipped, no POST); unenforced or unknown is unchanged', async () => {
  // The Reap lane consumes the gate through the escalation module's `mayOfferPurchaseForDomain`, so an
  // `unkeyable_enforced` answer (`offer: false`) must land on the very `purchasability_declined` skip a
  // `gate` decline lands on — and the door then falls through to the storefront escalation lane, which
  // consults the same gate with the same (absent) market.
  const m = await mods();
  const keyedFor = (enforced) => ({ tier: 'browse_only', enforced, sweep_enabled: true });
  const run = async (answer) => {
    const opsCalls = [];
    const env = { [LANE_FLAG]: '1', [BASE_URL_ENV]: 'https://ops.example', [OPS_TOKEN_ENV]: 'admin-jwt-fixture', [GATE_FLAG_ENV]: '1' };
    const gateClient = createMerchantPurchasabilityClient({
      env,
      fetchImpl: async (url) => { opsCalls.push(url); return answer(url); },
      logger: fakeLogger(),
    });
    const lines = [];
    const log = { info: (o) => lines.push(o), warn: (o) => lines.push(o), error: (o) => lines.push(o) };
    const backend = fakeBackend();
    const ctx = await build({ backend });
    const executor = recordingExecutor(ROWS, m.errors);
    const args = createArgs({reap:{}});
    delete args.checkout.context; // the request names NO market
    const res = await m.lane.tryReapAgenticCheckout({
      op: { id: 'create_checkout_session' },
      params: { idempotency_key: 'idem-reap-0001', quote: { items: [{ product_id: REAP_ROW.product_id, quantity: 1 }], customer_email: EMAIL } },
      ctx: SESSION, executor, ucpArgs: args, client: ctx.client, env, shouldOfferPurchase: (a) => gateClient.shouldOfferPurchase(a), log,
    });
    return { res, backend, opsCalls, lines };
  };
  // #2352's market-less answer
  const marketUnknown = (enforced) => async () => ({ ok: true, status: 200, json: async () => ({ ...keyedFor(enforced), market: null, reason: 'market_unknown', facts: [] }) });

  const enforced = await run(marketUnknown(true));
  assert.equal(enforced.res, null, 'skipped');
  assert.equal(enforced.backend.calls.length, 0, 'no purchase opened with no market under enforcement');
  assert.ok(enforced.lines.some((l) => l.outcome === 'skipped' && l.code === 'purchasability_declined'),
    'the SAME branch a gate decline takes');
  const url = new URL(enforced.opsCalls[0]);
  assert.deepEqual([...url.searchParams.keys()], ['domain'], 'no market is invented for the read');
  assert.equal(url.searchParams.get('domain'), 'brand.example');

  const unenforced = await run(marketUnknown(false));
  assert.match(unenforced.res.id, REAP_ID_RE);
  assert.equal(unenforced.backend.calls.length, 1);

  const failing = await run(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.match(failing.res.id, REAP_ID_RE, 'enforcement NOT KNOWN is not enforcement: fail open');
  assert.equal(failing.backend.calls.length, 1);
});

// =========================================================================================================
// 7. the id — tampering, other buyers, idempotency
// =========================================================================================================

test('id tampering: malformed reap_ ids never reach the backend and get the unknown-id body; another buyer\'s id -> backend 404 -> the same', async () => {
  const m = await mods();
  const backend = fakeBackend();
  const ctx = await build({ backend });
  const plainUnknown = await unknownIdBody(ctx, 'q_never_minted');
  const good = m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const snap = good.split('.')[1];
  const forged = (o) => `reap_${PID}.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
  const bad = [
    'reap_../x',
    `reap_${PID}/../../admin`,
    `reap_${'a'.repeat(300)}`,
    `reap_${PID}.${'A'.repeat(520)}`,
    `reap_${PID}`,
    `reap_${PID.toUpperCase()}.${snap}`,
    `reap_rp_283fba3ce85c4e59bb331e5.${snap}`,
    `reap_${PID}.${snap}x`,
    `REAP_${PID}.${snap}`,
    `kern_${PID}.${snap}`,
    `xreap_${PID}.${snap}`,
    forged({ v: 1, i: 'sig_reap_a', q: 1, c: 'USD', u: 4250, email: EMAIL }),
    forged({ v: 2, i: 'sig_reap_a', q: 1, c: 'USD', u: 4250 }),
    forged({ v: 1, i: 'sig_reap_a', q: 99, c: 'USD', u: 4250 }),
    forged({ v: 1, i: 'sig_reap_a', q: 1, c: 'usd', u: 4250 }),
    forged({ v: 1, i: 'sig_reap_a', q: 1, c: 'USD', u: -1 }),
    forged({ v: 1, i: '', q: 1, c: 'USD', u: 4250 }),
  ];
  for (const id of bad) {
    const r = await unknownIdBody(ctx, id);
    assert.equal(errorOf(r).code,id.startsWith('reap_')?'CHECKOUT_OUTCOME_UNKNOWN':'QUOTE_NOT_FOUND', `malformed id ${id.slice(0, 60)}`);
  }
  assert.equal(backend.calls.length, 0, 'no malformed id was ever sent anywhere');
  // update / complete on a malformed id are the kernel's answer too, not the lane's refusal
  const upd = await withEnv(ON, () => outcome(m, ctx.ucp.callTool('update_checkout', { meta: META, id: 'reap_../x', checkout: { line_items: [{ item: { id: 'sig_reap_a' }, quantity: 1 }], buyer: { email: EMAIL } } }, SESSION)));
  assert.notEqual(JSON.parse(upd.err.content[0].text).error.code, 'OPERATION_NOT_ALLOWED');

  const others = m.lane.encodeReapCheckoutId({ purchaseId: OTHER_BUYERS_PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const r = await unknownIdBody(ctx, others);
  assert.equal(JSON.stringify(r), JSON.stringify(plainUnknown));
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].path, `/agent/v2/commerce/reap/purchases/${OTHER_BUYERS_PID}`);
});

test('idempotency: the backend key is DERIVED from meta["idempotency-key"] — same key, same backend key; never random, never raw', async () => {
  const backend = fakeBackend();
  const ctx = await build({ backend });
  for (const key of ['idem-reap-0001', 'idem-reap-0001', 'idem-reap-0002']) {
    await withEnv(ON, () => ctx.ucp.callTool('create_checkout', createArgs({ key }), SESSION));
  }
  const keys = backend.calls.map((c) => c.body.idempotency_key);
  assert.equal(keys[0], keys[1], 'a retry is the same request');
  assert.notEqual(keys[0], keys[2]);
  for (const k of keys) {
    assert.ok(k.length <= 128, 'fits the backend column');
    assert.equal(k.includes('idem-reap'), false, 'the caller key is not echoed');
  }
  assert.equal(ctx.m.lane.reapIdempotencyKey('idem-reap-0001'), keys[0]);
});

test('the checkout id carries no buyer data', async () => {
  const { out } = await createReap(ON);
  const decoded = Buffer.from(out.id.split('.')[1], 'base64url').toString('utf8');
  for (const s of [...BUYER_STRINGS, 'reap-agentic-v1']) {
    assert.equal(out.id.includes(s), false);
    assert.equal(decoded.includes(s), false);
  }
});

// =========================================================================================================
// 8. the production wiring: SAME headers as the strict lane, never the internal key
// =========================================================================================================

test('server wiring: the client sends the caller\'s X-API-Key + forwarded X-Agent-User-JWT, and never falls back to the internal key', async () => {
  process.env.PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || 'internal-key-fixture';
  const server = require('../src/server');
  const strict = server._debug.__agentCheckoutStrict;
  const backend = fakeBackend();
  const client = strict.buildReapAgenticPurchaseClient(null, { fetchImpl: backend.fetchImpl, baseUrl: 'https://backend.example' });

  await strict.runInInvokeAuthContextForTest(
    { api_key: API_KEY, agent_user_jwt: USER_JWT, buyer_ref: 'buyer-ref-fixture' },
    () => client.getPurchase(PID),
  );
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].headers['X-API-Key'], API_KEY);
  assert.equal(backend.calls[0].headers['X-Agent-User-JWT'], USER_JWT);
  assert.equal(Object.hasOwn(backend.calls[0].headers, 'X-Buyer-Ref'), false);

  const noKey = await strict.runInInvokeAuthContextForTest({ agent_user_jwt: USER_JWT }, () => client.getPurchase(PID));
  const noJwt = await strict.runInInvokeAuthContextForTest({ api_key: API_KEY }, () => client.startPurchase({}));
  assert.equal(noKey.kind, 'unauthenticated', 'no caller key -> no request, NOT the internal key');
  assert.equal(noJwt.kind, 'unauthenticated', 'no buyer token -> no request');
  assert.equal(backend.calls.length, 1);
});

// =========================================================================================================
// 8b. THE SELLER -- a create whose expected seller differs is REFUSED at the door; Reap answers name the seller
// =========================================================================================================

const ESC_ON = { ...ON, [ESCALATION_FLAG]: '1' };
const sellerOf = (out) => ({
  domain: (message(out, 'reap.merchant_domain') || {}).content,
  id: (message(out, 'reap.merchant_id') || {}).content,
});
const errorOf = (r) => (r.err ? JSON.parse(r.err.content[0].text).error : null);

test('seller OUT: create and get name the seller (bare content at $.line_items[0]); the degraded get names none', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { out, ucp, backend } = await createReap(ON);
  assert.match(out.id, REAP_ID_RE);
  assert.deepEqual(sellerOf(out), { domain: 'www.brand.example', id: 'm_brand' });
  assert.equal(backend.calls[0].body.merchant_domain, message(out, 'reap.merchant_domain').content, 'the SAME host the purchase was opened for');
  for (const code of ['reap.merchant_domain', 'reap.merchant_id']) {
    const m = message(out, code);
    assert.deepEqual([m.type, m.path, m.content_type], ['info', '$.line_items[0]', 'plain'], code);
  }
  assert.equal(JSON.stringify(out).includes('prod::'), false, 'the product key itself is still never published');
  backend.state.get.set(PID, { status: 200, body: view('quoting', { merchant_domain: 'WWW.Brand.Example' }) });
  const got = keep(await withEnv(ON, () => ucp.callTool('get_checkout', { meta: META, id: out.id }, SESSION)));
  assert.deepEqual(sellerOf(got), { domain: 'www.brand.example', id: 'm_brand' });
  assertSpecCheckout(got);
  backend.state.mode = 'throw';
  const degraded = keep(await withEnv(ON, () => ucp.callTool('get_checkout', { meta: META, id: out.id }, SESSION)));
  assert.ok(message(degraded, 'reap.view_unavailable'));
  assert.deepEqual(sellerOf(degraded), { domain: undefined, id: undefined }, 'never from the caller-carried id');
});

// Every path a create can take, each with a DIFFERENT expected seller: refused at the door, with escalation off
// AND on, and NOTHING downstream runs -- no backend call, no kernel op, only the row reads.
const OTHER = { reap: { expected_merchant_domain: 'other-seller.example' } };
// A NATIVE row that carries its merchant's REGISTERED store (the backend derives `online_store_url` from the
// merchant's verified connected store). NATIVE_ROW itself carries only a catalog `canonical_url`, which is not
// the merchant of record, so it can never be confirmed.
const NATIVE_REGISTERED_ROW = Object.freeze({ ...NATIVE_ROW, product_id: 'p_native_reg', online_store_url: 'https://www.native.example/products/serum' });
const SELLER_PATHS = [
  ['eligible Reap row', { productId: REAP_ROW.product_id }, {}, 'www.brand.example', 'm_brand', 'different_seller'],
  ['no caller credentials (MCP-OAuth / no user JWT)', { productId: REAP_ROW.product_id }, { authHeaders: () => ({ 'X-API-Key': API_KEY }) }, 'www.brand.example', 'm_brand', 'different_seller'],
  ['native row with a registered store', { productId: 'p_native_reg' }, { rows: { p_native_reg: NATIVE_REGISTERED_ROW } }, 'www.native.example', 'merchant_native', 'different_seller'],
  ['native row with NO registered store (catalog url only)', { productId: NATIVE_ROW.product_id }, {}, undefined, 'merchant_native', 'seller_unconfirmed'],
  ['explicit domain is the seller, the storefront link is another (probe A)', { productId: 'sig_a' }, { rows: { sig_a: { ...MULTI_VARIANT_ROW, product_id: 'sig_a', merchant_domain: 'other-seller.example', external_redirect_url: 'https://www.brand.example/p' } } }, 'www.brand.example', 'm_brand', 'different_seller'],
  ['multi-variant row', { productId: MULTI_VARIANT_ROW.product_id }, {}, 'www.brand.example', 'm_brand', 'different_seller'],
  ['no product key', { productId: 'sig_nokey' }, { rows: { sig_nokey: { ...REAP_ROW, product_id: 'sig_nokey', product_key: undefined } } }, 'www.brand.example', undefined, 'different_seller'],
  ['not Shopify', { productId: 'sig_woo' }, { rows: { sig_woo: { ...REAP_ROW, product_id: 'sig_woo', product_key: 'prod::m_brand::woocommerce::9' } } }, 'www.brand.example', 'm_brand', 'different_seller'],
  ['unpriced row', { productId: 'sig_np' }, { rows: { sig_np: { ...REAP_ROW, product_id: 'sig_np', price: null } } }, 'www.brand.example', 'm_brand', 'different_seller'],
  ['row read fails', { productId: 'sig_down' }, { rows: { sig_down: READ_FAILS } }, undefined, undefined, 'seller_unconfirmed'],
  ['row has no merchant domain', { productId: 'sig_nohost' }, { rows: { sig_nohost: { ...REAP_ROW, product_id: 'sig_nohost', external_redirect_url: 'https://agent.pivota.cc/r?token=abc' } } }, undefined, 'm_brand', 'seller_unconfirmed'],
];

test('seller IN, MISMATCH on EVERY path: refused ucp_seller_mismatch at the door; no lane, no kernel, no backend call', async () => {
  const m = await mods();
  for (const [label, argOpts, buildOpts, domain, merchantId, cause] of SELLER_PATHS) {
    for (const env of [ON, ESC_ON]) {
      const ctx = await build(buildOpts);
      const r = keep(await withEnv(env, () => outcome(m, ctx.ucp.callTool('create_checkout', createArgs({ ...argOpts, ...OTHER }), SESSION))));
      ALL_LOGS.push(...ctx.logger.lines);
      const e = errorOf(r);
      const tag = `${label} (escalation ${env === ESC_ON ? 'on' : 'off'})`;
      assert.ok(e, `${tag}: refused, not answered`);
      assert.equal(e.code, 'QUOTE_REQUIRED', tag);
      assert.equal(e.detail.reason, 'ucp_seller_mismatch', tag);
      assert.equal(e.detail.cause, cause, tag);
      assert.equal(e.detail.merchant_domain, domain, tag);
      assert.equal(e.detail.merchant_id, merchantId, tag);
      assert.equal(JSON.stringify(r).includes('continue_url'), false, `${tag}: no link of any kind`);
      assert.equal(ctx.backend.calls.length, 0, `${tag}: no backend call`);
      assert.deepEqual([...new Set(ctx.executor.seen.map((c) => c.op))], ['get_product'], `${tag}: only the row read -- no kernel op`);
      assert.deepEqual(ctx.logger.lines.filter((l) => /^reap_agentic/.test(String(l.event || ''))), [], `${tag}: the Reap lane never ran`);
    }
  }
});

test('seller IN, a MULTI-LINE cart: every line must be the expected seller; one other seller refuses the whole create', async () => {
  const m = await mods();
  const args = createArgs({ reap: { expected_merchant_domain: 'brand.example' } });
  args.checkout.line_items = [{ item: { id: REAP_ROW.product_id }, quantity: 1 }, { item: { id: 'p_native_reg' }, quantity: 1 }];
  for (const env of [ON, ESC_ON]) {
    const ctx = await build({ rows: { ...ROWS, p_native_reg: NATIVE_REGISTERED_ROW } });
    const e = errorOf(await withEnv(env, () => outcome(m, ctx.ucp.callTool('create_checkout', structuredClone(args), SESSION))));
    assert.deepEqual([e.detail.reason, e.detail.line_item, e.detail.merchant_domain], ['ucp_seller_mismatch', '$.line_items[1]', 'www.native.example']);
    assert.equal(ctx.backend.calls.length, 0);
    assert.deepEqual([...new Set(ctx.executor.seen.map((c) => c.op))], ['get_product']);
  }
});

test('seller IN, MATCH: selected Reap succeeds; an incompatible native or refused row never changes route',async()=>{
 const {backend:plain,out:plainOut}=await createReap(ON);
 for(const expected of ['brand.example','www.brand.example','BRAND.EXAMPLE','Www.Brand.Example']){
  const {out,backend}=await createReap(ON,{args:{reap:{expected_merchant_domain:expected}}});assert.deepEqual(backend.calls[0].body,plain.calls[0].body);assert.equal(out.id,plainOut.id);
 }
 const ctx=await build({rows:{...ROWS,p_native_reg:NATIVE_REGISTERED_ROW}});const result=await withEnv(ON,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({productId:'p_native_reg',reap:{expected_merchant_domain:'native.example'}}),SESSION)));assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(ctx.backend.calls.length,0);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
});

// EVERY destination a row can send the buyer to must be the expected seller -- not just the one the Reap lane buys
// from (review round 2, P1). The storefront answer hands out `external_redirect_url`; the Reap lane buys from the
// explicit merchant field first. Probes from the review, through the REAL door, escalation ON.
const EXPECT_BRAND = { reap: { expected_merchant_domain: 'brand.example' } };
const DEST_PROBES = [
  ['A: merchant_domain is the seller, the storefront link is another seller', { merchant_domain: 'brand.example', external_redirect_url: 'https://other-seller.example/products/x' }, 'different_seller', 'other-seller.example'],
  ['B: an affiliate hop to another seller', { external_redirect_url: 'https://click.linksynergy.com/deeplink?id=abc&mid=1&murl=https%3A%2F%2Fother-seller.example%2Fp' }, 'seller_unconfirmed', undefined],
  ['B2: an affiliate hop even to the SAME seller (its end is not this URL)', { external_redirect_url: 'https://www.brand.example/go?url=https://www.brand.example/p' }, 'seller_unconfirmed', undefined],
  ['a Pivota /r attribution hop', { external_redirect_url: 'https://agent.pivota.cc/r?token=abc' }, 'seller_unconfirmed', undefined],
  ['a path-embedded redirect', { external_redirect_url: 'https://www.brand.example/redirect/https://other-seller.example/p' }, 'seller_unconfirmed', undefined],
  ['source_domain is another seller', { source_domain: 'www.other-seller.example' }, 'different_seller', 'www.other-seller.example'],
];

test('seller IN: EVERY destination of the row must be the expected seller -- probes A, B, the /r hop (refused, nothing runs)', async () => {
  const m = await mods();
  for (const [label, extra, cause, host] of DEST_PROBES) {
    const row = { ...MULTI_VARIANT_ROW, product_id: 'sig_probe', ...extra };
    for (const env of [ON, ESC_ON]) {
      const ctx = await build({ rows: { sig_probe: row } });
      const r = await withEnv(env, () => outcome(m, ctx.ucp.callTool('create_checkout', createArgs({ productId: 'sig_probe', ...EXPECT_BRAND }), SESSION)));
      const e = errorOf(r);
      assert.ok(e, `${label}: refused`);
      assert.deepEqual([e.detail.reason, e.detail.cause, e.detail.merchant_domain], ['ucp_seller_mismatch', cause, host], label);
      assert.equal(JSON.stringify(r).includes('continue_url'), false, label);
      assert.equal(ctx.backend.calls.length, 0, label);
      assert.deepEqual([...new Set(ctx.executor.seen.map((c) => c.op))], ['get_product'], label);
    }
  }
});

test('seller IN: matching seller cannot bypass required variant selection on an explicit Reap request', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const row = { ...MULTI_VARIANT_ROW, product_id: 'sig_ok', merchant_domain: 'Brand.example', external_redirect_url: 'https://www.brand.example/products/x' };
  const m = await mods();
  const ctx = await build({ rows: { sig_ok: row } });
  const result = await withEnv(ESC_ON, () => outcome(m, ctx.ucp.callTool('create_checkout', createArgs({ productId: 'sig_ok', ...EXPECT_BRAND }), SESSION)));
  const error = errorOf(result);
  assert.equal(error.code, 'QUOTE_REQUIRED');
  assert.equal(error.detail.reason, 'ucp_reap_variant_not_created');
  assert.equal(ctx.backend.calls.length, 0);
  assert.equal(JSON.stringify(result).includes('continue_url'), false);
  assert.equal(ctx.executor.seen.some(c => c.op === 'create_checkout_session'), false);
});

test('storefront lane, belt and braces: handed an expected seller the link does not match, it REFUSES instead of linking', async () => {
  const esc = await import('../mcp-server/src/ucpCheckoutEscalation.js');
  const m = await mods();
  const run = (expected, url) => esc.tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session' },
    params: { idempotency_key: 'k', quote: { items: [{ product_id: 'sig_x', quantity: 1 }] } },
    ctx: {},
    executor: recordingExecutor({ sig_x: { ...REAP_ROW, product_id: 'sig_x', external_redirect_url: url } }, m.errors),
    ucpArgs: { checkout: { line_items: [{ item: { id: 'sig_x' }, quantity: 1 }], reap: { expected_merchant_domain: expected } } },
    env: { [ESCALATION_FLAG]: '1' },
    now: NOW,
  });
  for (const [url, cause] of [
    ['https://other-seller.example/p', 'different_seller'],
    ['https://click.linksynergy.com/deeplink?murl=https%3A%2F%2Fbrand.example%2Fp', 'seller_unconfirmed'],
    ['https://agent.pivota.cc/r?token=abc', 'seller_unconfirmed'],
  ]) {
    const r = await outcome(m, run('brand.example', url));
    assert.deepEqual([errorOf(r)?.detail?.reason, errorOf(r)?.detail?.cause], ['ucp_seller_mismatch', cause], url);
  }
  const ok = await run('brand.example', 'https://www.brand.example/p');
  assert.equal(ok.continue_url, 'https://www.brand.example/p');
  // Without an expected seller the lane answers exactly as before.
  const plain = await esc.tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session' }, params: { idempotency_key: 'k', quote: { items: [{ product_id: 'sig_x', quantity: 1 }] } }, ctx: {},
    executor: recordingExecutor({ sig_x: { ...REAP_ROW, product_id: 'sig_x', external_redirect_url: 'https://other-seller.example/p' } }, m.errors),
    ucpArgs: { checkout: { line_items: [{ item: { id: 'sig_x' }, quantity: 1 }] } }, env: { [ESCALATION_FLAG]: '1' }, now: NOW,
  });
  assert.equal(plain.continue_url, 'https://other-seller.example/p');
});

test('seller IN, MATCH reads the selected row once on success and refusal',async()=>{
 const reap=await createReap(ON,{args:EXPECT_BRAND});assert.equal(reap.executor.seen.filter(c=>c.op==='get_product').length,1);
 const backend=fakeBackend();backend.state.post={status:409,body:houseError('row_not_found',409)};const ctx=await build({backend});const result=await withEnv(ESC_ON,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs(EXPECT_BRAND),SESSION)));assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(ctx.executor.seen.filter(c=>c.op==='get_product').length,1);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
});

// THE LIVE DEMO ROW (round 3): judydoll's "Silky Matte Lip Ink", an external-seed row whose external_redirect_url is a
// Pivota attribution hop. The hop's token payload `dest` is the merchant's own PDP; that is the seller judged.
// The live row's external_redirect_url token, read 2026-09-29 via search_catalog: the backend's TWO-segment format
// (`<b64url(payload JSON)>.<b64url(HMAC-SHA256)>`, pivota-backend make_redirect_token). Its payload `dest` is
// https://judydoll.com/products/silky-matte-lip-ink?variant=49819267301653&utm_source=pivota&…
const LIVE_JUDY_TOKEN = 'eyJ2IjowLCJ0IjoicmVkaXJlY3QiLCJtYXJrZXQiOiJVUyIsInRvb2wiOiJjcmVhdG9yX2FnZW50cyIsIm1hcmtldF9vYnNlcnZlZCI6dHJ1ZSwiZGVzdCI6Imh0dHBzOi8vanVkeWRvbGwuY29tL3Byb2R1Y3RzL3NpbGt5LW1hdHRlLWxpcC1pbms_dmFyaWFudD00OTgxOTI2NzMwMTY1MyZ1dG1fc291cmNlPXBpdm90YSZ1dG1fbWVkaXVtPWFmZmlsaWF0ZSZ1dG1fY2FtcGFpZ249VVMmcHZ0X2NsaWNrX2lkPWNsa18zNjQ1YmYyZjdkMDk0OWZmYTMxYTRlZjEmdXRtX2NvbnRlbnQ9Y2xrXzM2NDViZjJmN2QwOTQ5ZmZhMzFhNGVmMSIsImN0eCI6eyJzZWVkSWQiOiJlcHN2XzM4YWQ4OGQ0MzZjMzJlMjRiYTdjNjQ0NiIsInNvdXJjZSI6ImV4dGVybmFsX3NlZWRfbGlua3MiLCJwdnRfY2xpY2tfaWQiOiJjbGtfMzY0NWJmMmY3ZDA5NDlmZmEzMWE0ZWYxIiwicHZ0X3N1cmZhY2UiOiJjcmVhdG9yX2FnZW50cyIsInRvb2wiOiJjcmVhdG9yX2FnZW50cyIsImpvaW5fbW9kZSI6InJlZmVycmFsX29ubHkifSwiaWF0IjoxNzkwNjUzMTYyLCJleHAiOjE3OTEyNTc5NjJ9.z2eUZz-tCUGToldwJc-Y_i4XNkDV39QTgKj27vCzVyE';
// The backend's format for any payload (the signature is not checked by the door, so the live one is reused).
const hopToken = (payload) => `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${LIVE_JUDY_TOKEN.split('.')[1]}`;
const JUDY_HOP = `https://api.pivota.cc/r?token=${LIVE_JUDY_TOKEN}`;
const JUDY_ROW = Object.freeze({
  product_id: 'sig_6433c8107859a484fb72d14861e84690',
  title: 'Silky Matte Lip Ink',
  brand: 'Judydoll',
  price: 9.99,
  currency: 'USD',
  merchant_id: 'external_seed',
  platform: 'external',
  product_key: 'prod::external_seed::external_seed::ext_0f95730ee5ba05a6b7957ada',
  external_redirect_url: JUDY_HOP,
  destination_url: 'https://judydoll.com/products/silky-matte-lip-ink',
  purchase_grain: 'product',
  variants: [{ variant_id: 'sig_6433c8107859a484fb72d14861e84690' }],
});

test('the live demo row (a Pivota /r hop): its own seller passes and keeps the attributed link; any other seller is refused', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const m = await mods();
  const rows = { [JUDY_ROW.product_id]: JUDY_ROW };
  const selected = await build({rows});
  const blocked = await withEnv(ESC_ON,()=>outcome(m,selected.ucp.callTool('create_checkout',createArgs({productId:JUDY_ROW.product_id,reap:{expected_merchant_domain:'judydoll.com'}}),SESSION)));
  assert.equal(errorOf(blocked).code,'OPERATION_NOT_ALLOWED');assert.equal(selected.backend.calls.length,0);assert.equal(JSON.stringify(blocked).includes(JUDY_HOP),false);
  for (const expected of ['other-seller.example', 'judydoll.co']) {
    const ctx = await build({ rows });
    const r = await withEnv(ESC_ON, () => outcome(m, ctx.ucp.callTool('create_checkout', createArgs({ productId: JUDY_ROW.product_id, reap: { expected_merchant_domain: expected } }), SESSION)));
    assert.deepEqual([errorOf(r)?.detail?.reason, errorOf(r)?.detail?.cause, errorOf(r)?.detail?.merchant_domain], ['ucp_seller_mismatch', 'different_seller', 'judydoll.com'], expected);
    assert.equal(JSON.stringify(r).includes('continue_url'), false);
    assert.equal(ctx.backend.calls.length, 0);
  }
  // The storefront lane's own re-check decodes the hop the same way.
  const esc = await import('../mcp-server/src/ucpCheckoutEscalation.js');
  const direct = (expected) => esc.tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session' },
    params: { idempotency_key: 'k', quote: { items: [{ product_id: JUDY_ROW.product_id, quantity: 1 }] } },
    ctx: {}, executor: recordingExecutor(rows, m.errors),
    ucpArgs: { checkout: { line_items: [{ item: { id: JUDY_ROW.product_id }, quantity: 1 }], reap: { expected_merchant_domain: expected } } },
    env: { [ESCALATION_FLAG]: '1' }, now: NOW,
  });
  assert.equal((await direct('judydoll.com')).continue_url, JUDY_HOP);
  assert.equal(errorOf(await outcome(m, direct('other-seller.example')))?.detail?.cause, 'different_seller');
});

test('seller IN with the lane OFF: `checkout.reap` is refused as an unknown field, exactly as on main, with 0 backend calls', async () => {
  const m = await mods();
  for (const esc of [undefined, '1']) {
    const { ucp, backend } = await build({ lane: true });
    const r = await withEnv({ [LANE_FLAG]: undefined, [ESCALATION_FLAG]: esc }, () => outcome(m, ucp.callTool('create_checkout', createArgs({ reap: { expected_merchant_domain: 'brand.example' } }), SESSION)));
    const error = errorOf(r);
    assert.equal(error.detail.reason, 'ucp_unknown_field');
    assert.equal(error.detail.rejected_field, 'checkout.reap');
    assert.deepEqual(error.detail.accepted_fields, ['line_items', 'cart_id', 'buyer', 'context', 'fulfillment', 'attribution'], 'the same list main names');
    assert.equal(backend.calls.length, 0);
  }
});

// =========================================================================================================
// 9. the deep walk — no card field, no buyer data, no purchase_route, in any response or log line
// =========================================================================================================

const CARD_KEYS = /^(card|cards|card_?number|pan|cvv|cvc|card_?last_?4|last_?4|card_?network|card_?brand|card_?token|payment_?token|enrollment_?id|reap_(checkout|quote|variant|product)_id|buyer_ref|owner_id|purchase_route|consented_at)$/i;

function walk(value, visit, path = '$') {
  if (Array.isArray(value)) { value.forEach((v, i) => walk(v, visit, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { visit(k, v, `${path}.${k}`); walk(v, visit, `${path}.${k}`); }
  }
}

test('deep walk (runs last): no card/PII/purchase_route field in ANY response or lane log line this file produced', async () => {
  // Make sure the walk sees a completed + an enrollment answer even when run alone.
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body: view('needs_enrollment', { hosted_url: ENROLL_URL, hosted_url_expires_at: '2099-01-01T00:00:00+00:00', card_last4: '4242', enrollment_id: 'enr_1', purchase_route: 'reap' }) });
  const logger = fakeLogger();
  const ctx = await build({ backend, logger });
  const created = keep(await withEnv(ON, () => ctx.ucp.callTool('create_checkout', createArgs(), SESSION)));
  keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id: created.id }, SESSION)));
  ALL_LOGS.push(...logger.lines);

  assert.ok(ALL_RESPONSES.length > 40, `walked ${ALL_RESPONSES.length} responses`);
  for (const r of ALL_RESPONSES) {
    // The switch-off / escalation snapshots legitimately echo the buyer email (the storefront lane's
    // `buyer.email` pre-fill, unchanged by this PR); every OTHER buyer field must be absent everywhere.
    const reapAnswer = JSON.stringify(r).includes('reap_rp_');
    const text = JSON.stringify(r);
    for (const s of BUYER_STRINGS.filter((x) => x !== EMAIL)) assert.equal(text.includes(s), false, `buyer data "${s}" in a response`);
    if (reapAnswer) assert.equal(text.includes(EMAIL), false, 'a Reap answer never echoes the buyer email');
    walk(r, (k) => assert.equal(CARD_KEYS.test(k), false, `forbidden key "${k}" in a response`));
  }
  const laneLogs = ALL_LOGS.filter((l) => /reap/.test(String(l.event || '')));
  assert.ok(laneLogs.length > 5);
  for (const l of laneLogs) {
    const text = JSON.stringify(l);
    for (const s of [...BUYER_STRINGS, USER_JWT, API_KEY, PID]) assert.equal(text.includes(s), false, `"${s}" logged: ${text}`);
  }
});


// =========================================================================================================
// OFFER CODES AND THE TIER B (cart-link) RETRY — backend PR "cart-link quotes via externalCheckout, offer codes"
// =========================================================================================================

const CART_LINK_FLAG = 'REAP_AGENTIC_CART_LINK_LANE_ENABLED';
// Offer codes are ARMED only with the lane AND its cart-link dial (review of #2323, G1/G8).
const CODES_ON = { ...ON, [CART_LINK_FLAG]: '1' };

test('offer code: checkout.discounts.codes[0] is forwarded VERBATIM as offer_code when codes are armed; absent means no key', async () => {
  for (const code of ['PEACHIE20', 'peachie20', ' Save 10 ']) {
    const backend = fakeBackend();
    await createReap(CODES_ON, { backend, args: { discounts: { codes: [code] } } });
    assert.equal(backend.calls[0].body.offer_code, code, JSON.stringify(code));
  }
  for (const discounts of [ABSENT, {}, { codes: [] }]) {
    const backend = fakeBackend();
    await createReap(CODES_ON, { backend, args: { discounts } });
    assert.equal(Object.hasOwn(backend.calls[0].body, 'offer_code'), false);
  }
});

test('offer code NOT armed (lane on, cart-link dial off; or lane off): `discounts` is refused as on base, and not advertised', async () => {
  for (const env of [ON, { ...ON, [LANE_FLAG]: undefined, [CART_LINK_FLAG]: '1' }]) {
    const backend = fakeBackend();
    const ctx = await build({ backend });
    const r = keep(await withEnv(env, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs({ discounts: { codes: ['SAVE10'] } }), SESSION))));
    const err = JSON.parse(r.err.content[0].text).error;
    assert.equal(err.detail.reason, 'ucp_unknown_field', JSON.stringify(env));
    assert.equal(backend.calls.length, 0);
    const tools = await withEnv(env, () => ctx.ucp.tools);
    const create = tools.find((t) => t.name === 'create_checkout');
    assert.equal(Object.hasOwn(create.inputSchema.properties.checkout.properties, 'discounts'), false);
  }
  const ctx = await build();
  const armed = await withEnv(CODES_ON, () => ctx.ucp.tools);
  const create = armed.find((t) => t.name === 'create_checkout');
  assert.equal(create.inputSchema.properties.checkout.properties.discounts.properties.codes.maxItems, 1);
  assert.match(create.description, /checkout\.discounts\.codes/);
});

test('offer code: the adapter enforces the advertised shape (one string of 1..128 code points) before any lane runs', async () => {
  for (const discounts of [{ codes: ['A', 'B'] }, { codes: [''] }, { codes: ['x'.repeat(129)] }, { codes: ['\u{1F600}'.repeat(129)] }, { codes: [7] }, { codes: 'SAVE10' }, { code: 'SAVE10' }, 'SAVE10']) {
    const backend = fakeBackend();
    const ctx = await build({ backend });
    const r = keep(await withEnv(CODES_ON, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs({ discounts }), SESSION))));
    assert.ok(r.err, JSON.stringify(discounts));
    assert.equal(backend.calls.length, 0, JSON.stringify(discounts));
  }
  for (const code of ['x'.repeat(128), '\u{1F600}'.repeat(128)]) {
    // 128 CODE POINTS is fine even when it is 256 UTF-16 units (astral characters).
    const backend = fakeBackend();
    await createReap(CODES_ON, { backend, args: { discounts: { codes: [code] } } });
    assert.equal(backend.calls[0].body.offer_code, code);
  }
});

test('a catalog refusal with an offer code stops the checkout and never exposes another link',async()=>{
 const backend=fakeBackend();backend.state.post={status:409,body:houseError('row_not_found',409)};const ctx=await build({backend});const result=await withEnv(CODES_ON,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({discounts:{codes:['SAVE10']}}),SESSION)));assert.equal(errorOf(result).detail.reason,'ucp_reap_create_refused');assert.equal(JSON.stringify(result).includes('SAVE10'),false);assert.equal(JSON.stringify(result).includes('continue_url'),false);assert.equal(backend.calls.length,1);
});
test('backend invalid_offer_code stops the selected checkout without another rail or key',async()=>{
 const backend=fakeBackend();backend.state.post={status:400,body:houseError('invalid_offer_code',400)};const ctx=await build({backend});const result=await withEnv({...CODES_ON,[ESCALATION_FLAG]:'1'},()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({discounts:{codes:['SAVE10']}}),SESSION)));assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(errorOf(result).detail.reason,'ucp_reap_create_refused');assert.equal(backend.calls.length,1);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
});

function priced(extra) {
  return view('awaiting_approval', { hosted_url: APPROVE_URL, hosted_url_expires_at: LATER, approval_deadline: LATER, ...extra });
}
async function getWith(body) {
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body });
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  return keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
}

test('get_checkout: an applied code -> discounts.applied, a NEGATIVE discount row, and totals that reconcile', async () => {
  const out = await getWith(priced({ offer_code: 'PEACHIE20', offer_code_outcome: 'applied', totals: { ...QUOTED, quoted_total_minor: 4075, discount_minor: 425 } }));
  assertSpecCheckout(out);
  assert.deepEqual(out.totals.map((x) => [x.type, x.amount]), [['subtotal', 4250], ['fulfillment', 100], ['tax', 150], ['discount', -425], ['total', 4075]]);
  assert.deepEqual(out.discounts, { codes: ['PEACHIE20'], applied: [{ code: 'PEACHIE20', title: 'Offer code', amount: 425 }] });
  const msg = message(out, 'reap.offer_code_applied');
  assert.equal(msg.type, 'info');
  assert.equal(msg.content.includes('PEACHIE20'), false, 'the code itself is never echoed in a message');
});

test('get_checkout: a dropped code is a UCP discount warning at $.discounts.codes[0]; no_discount is info', async () => {
  for (const [outcomeName, code] of [['dropped_invalid', 'discount_code_invalid'], ['dropped_expired', 'discount_code_expired']]) {
    const out = await getWith(priced({ offer_code: 'PEACHIE20', offer_code_outcome: outcomeName, totals: { ...QUOTED } }));
    assertSpecCheckout(out);
    const msg = message(out, code);
    assert.equal(msg.type, 'warning');
    assert.equal(msg.path, '$.discounts.codes[0]');
    assert.deepEqual(out.discounts, { codes: ['PEACHIE20'], applied: [] });
    assert.deepEqual(out.totals.map((x) => [x.type, x.amount]), [['subtotal', 4250], ['fulfillment', 100], ['tax', 150], ['total', 4500]]);
  }
  const nd = await getWith(priced({ offer_code: 'PEACHIE20', offer_code_outcome: 'no_discount', totals: { ...QUOTED, discount_minor: 0 } }));
  assert.equal(message(nd, 'reap.offer_code_no_discount').type, 'info');
  // An outcome this door does not know is not published, and a view without a code carries no `discounts`.
  const unknown = await getWith(view('quoting', { offer_code_outcome: 'half_applied<script>' }));
  assert.equal((unknown.messages || []).some((m) => /offer_code|discount_code/.test(m.code)), false);
  assert.equal(Object.hasOwn(unknown, 'discounts'), false);
});

test('get_checkout: tax INCLUDED in the prices is not a tax row, and the total says so; a breakdown that does not reconcile is not shown', async () => {
  const incl = await getWith(priced({ totals: { currency: 'USD', our_price_minor: 4250, quoted_total_minor: 4650, final_total_minor: null, shipping_minor: 400, tax_minor: 248, tax_included: true } }));
  assertSpecCheckout(incl);
  assert.deepEqual(incl.totals.map((x) => [x.type, x.amount]), [['subtotal', 4250], ['fulfillment', 400], ['total', 4650]]);
  assert.match(incl.totals.at(-1).display_text, /tax is included/);
  const off = await getWith(priced({ totals: { ...QUOTED, quoted_total_minor: 9999 } }));
  assert.deepEqual(off.totals.map((x) => x.type), ['subtotal', 'total']);
});

test('get_checkout: refused offer_code_rejected tells the agent to create a NEW checkout without the code, with a NEW key', async () => {
  const out = await getWith(view('refused', { refusal_reason: 'offer_code_rejected' }));
  assert.equal(out.status, 'canceled');
  const msg = message(out, 'reap.purchase_refused');
  assert.match(msg.content, /WITHOUT the code/);
  assert.match(msg.content, /NEW idempotency key/);
});

test('Tier B: a variant refusal never retries cart_link, whatever the dial',async()=>{
 for(const env of [ON,CODES_ON]){const backend=fakeBackend();backend.state.post=[{status:409,body:houseError('merchant_not_eligible',409)},{status:202,body:{purchase_id:PID,status:'resolving',poll_after_seconds:60}}];const ctx=await build({backend});const result=await withEnv(env,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs(),SESSION)));assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(backend.calls.length,1);assert.equal(backend.calls[0].body.item_source,undefined);}
});
test('Tier B: every deterministic variant refusal makes exactly one POST',async()=>{
 for(const code of ['merchant_not_eligible','merchant_disabled','row_not_shopify','row_not_found','merchant_not_purchasable']){const backend=fakeBackend();backend.state.post={status:409,body:houseError(code,409)};const ctx=await build({backend});const result=await withEnv(CODES_ON,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs(),SESSION)));assert.equal(errorOf(result).detail.reason,'ucp_reap_create_refused');assert.equal(backend.calls.length,1);}
});
test('Tier B keys: explicit initial cart source is stable and differs from every variant namespace',async()=>{
 const {lane}=await mods();assert.equal(lane.reapCartLinkIdempotencyKey('K'),lane.reapCartLinkIdempotencyKey(' K '));assert.notEqual(lane.reapCartLinkIdempotencyKey('K'),lane.reapIdempotencyKey('K:cart_link'));assert.equal(lane.reapCartLinkIdempotencyKey(''),null);
 const backend=fakeBackend();const row={...REAP_ROW,source_variant_id:'49819267301653'};const ctx=await build({backend,rows:{[row.product_id]:row}});const args=createArgs({reap:{expected_merchant_domain:'brand.example',item_source:'cart_link'}});
 for(let i=0;i<2;i++)assert.match((await withEnv(CODES_ON,()=>ctx.ucp.callTool('create_checkout',args,SESSION))).id,REAP_ID_RE);
 assert.equal(backend.calls.length,2);assert.deepEqual(backend.calls[0].body,backend.calls[1].body);assert.equal(backend.calls[0].body.item_source,'cart_link');assert.equal(backend.calls[0].body.idempotency_key,lane.reapCartLinkIdempotencyKey('idem-reap-0001'));assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
});

test('the lane itself never forwards a code unless armed, even if handed one directly (belt and braces behind the adapter, G8)', async () => {
  for (const [env, expected] of [[ON, false], [CODES_ON, true]]) {
    const ctx = await build();
    const backend = fakeBackend();
    const client = createReapAgenticPurchaseClient({ baseUrl: 'https://backend.example', fetchImpl: backend.fetchImpl, authHeaders: FULL_AUTH, logger: fakeLogger() });
    await withEnv(env, () => ctx.m.lane.tryReapAgenticCheckout({
      op: { id: 'create_checkout_session' },
      params: { idempotency_key: 'idem-direct', quote: { items: [{ product_id: REAP_ROW.product_id, quantity: 1 }], customer_email: EMAIL } },
      ctx: { user_ref: 'buyer_1', acp_session_id: 'sess_1' },
      executor: ctx.executor,
      ucpArgs: createArgs({ discounts: { codes: ['SAVE10'] } }),
      client,
      now: NOW,
    }));
    assert.equal(backend.calls.length, 1, JSON.stringify(env));
    assert.equal(Object.hasOwn(backend.calls[0].body, 'offer_code'), expected, JSON.stringify(env));
  }
});

// ---- final review round: S1 (rounding), S2 (discounts on update) ----------------------------------------

async function getWithLog(body) {
  const logger = fakeLogger();
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body });
  const ctx = await build({ backend, logger });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  return { out, lines: logger.lines };
}

test('S1: a ONE-unit residual (the backend tolerates it) becomes a Rounding row, of the sign UCP allows, so the rows still reconcile', async () => {
  for (const [quoted, row] of [[4501, ['fee', 1]], [4499, ['discount', -1]]]) {
    const { out, lines } = await getWithLog(priced({ totals: { ...QUOTED, quoted_total_minor: quoted } }));
    assertSpecCheckout(out);
    assert.deepEqual(out.totals.map((x) => [x.type, x.amount]), [['subtotal', 4250], ['fulfillment', 100], ['tax', 150], row, ['total', quoted]]);
    assert.equal(out.totals.find((x) => x.type === row[0]).display_text, 'Rounding');
    assert.equal(out.totals.slice(0, -1).reduce((a, t) => a + t.amount, 0), quoted, 'the rows add up to the total');
    assert.equal(lines.some((l) => l.outcome === 'breakdown_unreconciled'), false);
  }
});

test('S1: a residual over one unit shows NO breakdown, is logged breakdown_unreconciled, and `applied` does not claim a discount row', async () => {
  const { out, lines } = await getWithLog(priced({
    offer_code: 'PEACHIE20', offer_code_outcome: 'applied',
    totals: { ...QUOTED, quoted_total_minor: 4000, discount_minor: 425 },
  }));
  assertSpecCheckout(out);
  assert.deepEqual(out.totals.map((x) => x.type), ['subtotal', 'total']);
  assert.ok(lines.some((l) => l.outcome === 'breakdown_unreconciled' && l.code === 'breakdown_unreconciled'));
  const msg = message(out, 'reap.offer_code_applied');
  assert.doesNotMatch(msg.content, /discount row/);
  assert.match(msg.content, /discounts\.applied/);
  // With the row present, the message does name it.
  const { out: ok } = await getWithLog(priced({ offer_code: 'PEACHIE20', offer_code_outcome: 'applied', totals: { ...QUOTED, quoted_total_minor: 4075, discount_minor: 425 } }));
  assert.match(message(ok, 'reap.offer_code_applied').content, /discount row/);
});

test('S2: armed, update_checkout ACCEPTS `discounts` -- a reap_ checkout refusal names the create-only rule; unarmed it is ucp_unknown_field', async () => {
  const ctx = await build();
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const args = { meta: META, id, checkout: { line_items: [{ item: { id: 'sig_reap_a' }, quantity: 1 }], buyer: { email: EMAIL }, discounts: { codes: ['SAVE10'] } } };
  const armed = keep(await withEnv(CODES_ON, () => outcome(ctx.m, ctx.ucp.callTool('update_checkout', args, SESSION))));
  const e = JSON.parse(armed.err.content[0].text).error;
  assert.equal(e.code, 'OPERATION_NOT_ALLOWED');
  assert.match(e.message, /only be set when a Reap checkout is CREATED/);
  const unarmed = keep(await withEnv(ON, () => outcome(ctx.m, ctx.ucp.callTool('update_checkout', args, SESSION))));
  assert.equal(JSON.parse(unarmed.err.content[0].text).error.detail.reason, 'ucp_unknown_field');
  // Without a code, the Reap refusal says nothing about codes.
  const plain = keep(await withEnv(CODES_ON, () => outcome(ctx.m, ctx.ucp.callTool('update_checkout', { ...args, checkout: { ...args.checkout, discounts: undefined } }, SESSION))));
  assert.doesNotMatch(JSON.parse(plain.err.content[0].text).error.message, /offer code/i);
});

test('S2: armed, a code on update_checkout of a NON-Reap checkout is not applied and the answer says so at $.discounts.codes[0]', async () => {
  const m = await mods();
  // A contracted (native) row: the kernel path answers the update, not the Reap lane.
  const executor = {
    async execute(op) {
      if (op === 'get_product') return { product: { ...NATIVE_ROW } };
      if (op === 'update_checkout_session') return { session_id: 'q_kernel_1' };
      return { session_id: 'q_kernel' };
    },
  };
  const ucp = m.surface.ucpDialectSurface(m.surface.createCommerceToolSurface(executor, { cache: false, log: fakeLogger() }));
  const args = (discounts) => ({ meta: META, id: 'q_kernel_1', checkout: { line_items: [{ item: { id: NATIVE_ROW.product_id }, quantity: 1 }], buyer: { email: EMAIL }, ...(discounts ? { discounts } : {}) } });
  const out = keep(await withEnv(CODES_ON, () => ucp.callTool('update_checkout', args({ codes: ['SAVE10'] }), SESSION)));
  const notice = (out.messages || []).filter((x) => x.path === '$.discounts.codes[0]');
  assert.equal(notice.length, 1);
  assert.equal(notice[0].type, 'warning');
  assert.equal(notice[0].code, 'discount_code_invalid');
  assert.match(notice[0].content, /CREATED/);
  const plain = keep(await withEnv(CODES_ON, () => ucp.callTool('update_checkout', args(null), SESSION)));
  assert.equal((plain.messages || []).some((x) => x.path === '$.discounts.codes[0]'), false);
});

// =========================================================================================================
// Tier B cart-link, DIRECT, for EXTERNAL-SEED / mirror rows (the two demo merchants)
// =========================================================================================================

const JSM_ROW = Object.freeze({
  product_id: 'sig_jsm_skin_nuder_cushion',
  title: 'Skin Nuder Cushion',
  brand: 'JUNGSAEMMOOL',
  price: 38,
  currency: 'SGD',
  merchant_id: 'merch_obs_jungsaemmool',
  platform: 'external_seed',
  // The MIRROR shape (prod::external_seed::external_seed::<external_product_id>) -- the one key the backend's
  // cart-link lane resolves. The live jsmbeauty.sg rows carry an enrichment `ext:` key instead (JSM_EXT_ROW below),
  // which that lane refuses, so the gateway skips them.
  product_key: 'prod::external_seed::external_seed::ext_jsm_9f2c1e7ab04d',
  external_redirect_url: `https://api.pivota.cc/r?token=${hopToken({
    dest: 'https://jsmbeauty.sg/products/skin-nuder-cushion?utm_source=pivota&utm_medium=agent',
    merchant_canonical_url: 'https://jsmbeauty.sg',
    destination_url: 'https://jsmbeauty.sg/products/skin-nuder-cushion',
  })}`,
  destination_url: 'https://jsmbeauty.sg/products/skin-nuder-cushion',
  source_variant_id: '44012345678901',
  purchase_grain: 'product',
  variants: [{ variant_id: 'sig_jsm_skin_nuder_cushion' }],
});
const SG_DESTINATION = Object.freeze({ ...DESTINATION, street_address: '1 Raffles Place', address_locality: 'Singapore', address_region: undefined, postal_code: '048616', address_country: 'SG' });
const CART_ROWS = Object.freeze({ [JUDY_ROW.product_id]: JUDY_ROW, [JSM_ROW.product_id]: JSM_ROW });
const sgArgs = (extra = {}) => {
  const a = createArgs({ productId: JSM_ROW.product_id, destination: JSON.parse(JSON.stringify(SG_DESTINATION)), ...extra });
  a.checkout.context = { address_country: 'SG' };
  return a;
};

test('Tier B DIRECT: the judydoll mirror row is POSTed ONCE as item_source cart_link, with exactly the body the backend reads', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { out, backend, m } = await createReap(CODES_ON, { rows: CART_ROWS, args: { productId: JUDY_ROW.product_id } });
  assert.match(out.id, REAP_ID_RE);
  assert.equal(backend.calls.length, 1, 'one POST: no variant attempt first');
  assert.deepEqual(backend.calls[0].body, {
    merchant_domain: 'judydoll.com', // the host of the hop's dest -- the catalog source_domain, as observed
    product_key: 'prod::external_seed::external_seed::ext_0f95730ee5ba05a6b7957ada',
    quantity: 1,
    buyer: {
      email: EMAIL,
      consent_version: 'reap-agentic-v1',
      shipping_address: {
        firstName: 'Ada', lastName: LAST, phone: PHONE, addressLine1: STREET, addressLine2: SUITE,
        city: 'San Francisco', region: 'CA', postalCode: POSTAL, country: 'US',
      },
    },
    expected_unit_price_minor:999,expected_currency:'USD',
    idempotency_key: m.lane.reapCartLinkIdempotencyKey('idem-reap-0001'),
    item_source: 'cart_link',
  });
  assert.equal(message(out, 'reap.merchant_domain').content, 'judydoll.com');
  assert.equal(message(out, 'reap.merchant_id'), undefined, 'the external-seed sentinel is not a seller id');
  assert.equal(out.currency, 'USD');
});

test('Tier B DIRECT: the jsmbeauty.sg mirror row in the SG market -- SGD, the ext: key, the SG buyer, and its seller check', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const ctx = await build({ rows: CART_ROWS });
  const res = keep(await withEnv(CODES_ON, () => ctx.ucp.callTool('create_checkout', sgArgs({ reap: { expected_merchant_domain: 'jsmbeauty.sg' } }), SESSION)));
  assert.match(res.id, REAP_ID_RE);
  assert.equal(res.currency, 'SGD');
  assert.equal(res.line_items[0].item.price, 3800);
  assert.equal(ctx.backend.calls.length, 1);
  const body = ctx.backend.calls[0].body;
  assert.deepEqual(
    { merchant_domain: body.merchant_domain, product_key: body.product_key, item_source: body.item_source, country: body.buyer.shipping_address.country },
    { merchant_domain: 'jsmbeauty.sg', product_key: 'prod::external_seed::external_seed::ext_jsm_9f2c1e7ab04d', item_source: 'cart_link', country: 'SG' },
  );
  assert.equal(Object.hasOwn(body, 'variant_key'), false, 'no caller variant: the backend proves the sole one');
  assert.equal(body.idempotency_key, ctx.m.lane.reapCartLinkIdempotencyKey('idem-reap-0001'));
  // The seller check stays in force: another expected seller is refused at the door, nothing POSTed.
  const ctx2 = await build({ rows: CART_ROWS });
  const refused = await withEnv(CODES_ON, () => outcome(ctx2.m, ctx2.ucp.callTool('create_checkout', sgArgs({ reap: { expected_merchant_domain: 'judydoll.com' } }), SESSION)));
  assert.deepEqual([errorOf(refused)?.detail?.reason, errorOf(refused)?.detail?.merchant_domain], ['ucp_seller_mismatch', 'jsmbeauty.sg']);
  assert.equal(ctx2.backend.calls.length, 0);
});

test('Tier B DIRECT needs BOTH dials: lane on + cart-link off skips an external-seed row exactly as before (0 POSTs)', async () => {
  for (const env of [ON, { ...ON, [CART_LINK_FLAG]: '0' }]) {
    const logger = fakeLogger();
    const { out, backend } = await createReap(env, { logger, rows: CART_ROWS, args: { productId: JUDY_ROW.product_id,legacy:true } });
    assert.deepEqual(out, KERNEL_ON_UCP, 'the kernel path answers, as before');
    assert.equal(backend.calls.length, 0);
    assert.ok(logger.lines.some((l) => l.event === 'reap_agentic_lane' && l.code === 'not_shopify'), 'the same skip code as before');
  }
});

test('Tier B DIRECT requires ONE resolvable variant: source_variant_id, or variant= on the merchant URL; otherwise skipped', async () => {
  const cases = [
    ['source_variant_id on the single variant', { source_variant_id: undefined, variants: [{ variant_id: 'x', source_variant_id: 'gid://shopify/ProductVariant/44012345678901' }] }, 1],
    ['no variant anywhere', { source_variant_id: undefined }, 0],
    ['source_variant_id not numeric', { source_variant_id: 'default' }, 0],
    ['variant= on another host is not the merchant\'s', { source_variant_id: undefined, external_redirect_url: 'https://jsmbeauty.sg/products/x', destination_url: 'https://other.example/p?variant=1' }, 0],
    ['variant= on the merchant URL', { source_variant_id: undefined, destination_url: 'https://jsmbeauty.sg/products/x?variant=440123' }, 1],
    ['two variant= values', { source_variant_id: undefined, destination_url: 'https://jsmbeauty.sg/products/x?variant=1&variant=2' }, 0],
  ];
  for (const [label, patch, posts] of cases) {
    const row = { ...JSM_ROW, ...patch };
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    const logger = fakeLogger();
    const ctx = await build({ logger, rows: { [JSM_ROW.product_id]: row } });
    await withEnv(CODES_ON, () => ctx.ucp.callTool('create_checkout', sgArgs(), SESSION).catch(() => null));
    assert.equal(ctx.backend.calls.length, posts, label);
    if (!posts) assert.ok(logger.lines.some((l) => l.code === 'variant_unresolvable' || l.code === 'no_merchant_domain'), label);
  }
});

test('Tier B DIRECT: a cart refusal and a Shopify variant refusal each stop after one original-source POST',async()=>{
 for(const [rows,pid,source]of [[CART_ROWS,JUDY_ROW.product_id,'cart_link'],[ROWS,REAP_ROW.product_id,undefined]]){const backend=fakeBackend();backend.state.post=[{status:409,body:houseError('merchant_not_eligible',409)},{status:202,body:{purchase_id:PID,status:'resolving'}}];const ctx=await build({backend,rows});const result=await withEnv({...CODES_ON,[ESCALATION_FLAG]:'1'},()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({productId:pid}),SESSION)));assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(backend.calls.length,1);assert.equal(backend.calls[0].body.item_source,source);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);}
});

test('Tier B DIRECT, lane OFF (cart-link dial on or off): external-seed creates are byte-identical to a door without the lane, 0 POSTs', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const m = await mods();
  for (const escalation of [undefined, '1']) {
    for (const cart of [undefined, '1']) {
      for (const laneFlag of [undefined, '0']) {
        const withLane = await build({ lane: true, rows: CART_ROWS });
        const without = await build({ lane: false, rows: CART_ROWS });
        const env = { [LANE_FLAG]: laneFlag, [CART_LINK_FLAG]: cart, [ESCALATION_FLAG]: escalation };
        for (const args of [createArgs({ productId: JUDY_ROW.product_id }), sgArgs()]) {
          const a = await withEnv(env, () => outcome(m, withLane.ucp.callTool('create_checkout', structuredClone(args), SESSION)));
          const b = await withEnv(env, () => outcome(m, without.ucp.callTool('create_checkout', structuredClone(args), SESSION)));
          assert.equal(JSON.stringify(a), JSON.stringify(b), JSON.stringify(env));
        }
        assert.equal(withLane.backend.calls.length, 0);
      }
    }
  }
});

test('Tier B DIRECT is for EXTERNAL-SEED rows only: another non-Shopify row (WooCommerce, Wix) is still skipped, 0 POSTs', async () => {
  for (const [pid, patch] of [
    ['sig_woo', { platform: 'woocommerce', product_key: 'prod::m_brand::woocommerce::9' }],
    ['sig_wix', { platform: undefined, product_key: 'prod::m_brand::wix::9' }],
  ]) {
    const row = { ...JUDY_ROW, product_id: pid, ...patch };
    if (row.platform === undefined) delete row.platform;
    const logger = fakeLogger();
    const { backend } = await createReap(CODES_ON, { logger, rows: { [pid]: row }, args: { productId: pid,legacy:true } });
    assert.equal(backend.calls.length, 0, pid);
    assert.ok(logger.lines.some((l) => l.code === 'not_shopify'), pid);
  }
});

test('the live token re-encoded with `dest` on ANOTHER host: refused at the door for judydoll.com, nothing opened', async () => {
  const m = await mods();
  const payload = JSON.parse(Buffer.from(LIVE_JUDY_TOKEN.split('.')[0], 'base64url').toString('utf8'));
  const row = { ...JUDY_ROW, external_redirect_url: `https://api.pivota.cc/r?token=${hopToken({ ...payload, dest: 'https://other-seller.example/products/x?variant=1' })}` };
  for (const env of [ON, ESC_ON]) {
    const ctx = await build({ rows: { [JUDY_ROW.product_id]: row } });
    const r = await withEnv(env, () => outcome(m, ctx.ucp.callTool('create_checkout', createArgs({ productId: JUDY_ROW.product_id, reap: { expected_merchant_domain: 'judydoll.com' } }), SESSION)));
    assert.deepEqual([errorOf(r)?.detail?.cause, errorOf(r)?.detail?.merchant_domain], ['different_seller', 'other-seller.example']);
    assert.equal(ctx.backend.calls.length, 0);
  }
});

// ---- B3: only a key the backend's cart-link lane RESOLVES is sent ----------------------------------------------
// pivota-backend `_load_cart_link_item` resolves an external_seed row only when it is the seed MIRROR
// (source_system external_product_seeds_mirror_v1, key prod::external_seed::external_seed::<id>). An enrichment
// `ext:<canonical>::<hash>` key -- what the live jsmbeauty.sg rows carry, e.g.
// ext:jungsaemmool-essential-mool-toner::4b4c3cfe -- is a catalog_products key with the agent's source_system,
// which that lane refuses (`row_variant_unverified`). An affiliate-feed `platform: external` row is not a mirror.
const JSM_EXT_ROW = Object.freeze({ ...JSM_ROW, product_id: 'sig_jsm_essential_mool_toner', product_key: 'ext:jungsaemmool-essential-mool-toner::4b4c3cfe' });

test('Tier B DIRECT sends ONLY a key the backend resolves: ext: / affiliate / non-mirror rows are skipped row_key_unsupported, 0 POSTs', async () => {
  const cases = [
    ['live jsmbeauty.sg ext: key', JSM_EXT_ROW, sgArgs, 0],
    ['platform external, affiliate-feed key', { ...JUDY_ROW, product_id: 'sig_aff', product_key: 'prod::merch_aff::external::B0CXYZ' }, null, 0],
    ['mirror key, another source_system', { ...JUDY_ROW, product_id: 'sig_mx', source_system: 'catalog_enrichment_agent_v3' }, null, 0],
    ['mirror key with no id after the prefix', { ...JUDY_ROW, product_id: 'sig_m0', product_key: 'prod::external_seed::external_seed::' }, null, 0],
    ['mirror key, the mirror source_system', { ...JUDY_ROW, product_id: 'sig_mm', source_system: 'external_product_seeds_mirror_v1' }, null, 1],
    ['mirror key, no source_system on the read (judydoll)', JUDY_ROW, null, 1],
  ];
  for (const [label, row, argsFn, posts] of cases) {
    const logger = fakeLogger();
    const ctx = await build({ logger, rows: { [row.product_id]: row } });
    const args = argsFn ? { ...argsFn(), checkout: { ...argsFn().checkout, line_items: [{ item: { id: row.product_id }, quantity: 1 }] } } : createArgs({ productId: row.product_id, expectedMoney:{expected_unit_price_minor:Math.round(row.price*100),expected_currency:row.currency} });
    await withEnv(CODES_ON, () => ctx.ucp.callTool('create_checkout', args, SESSION).catch(() => null));
    assert.equal(ctx.backend.calls.length, posts, label);
    if (posts) assert.equal(ctx.backend.calls[0].body.product_key, row.product_key, label);
    else assert.ok(logger.lines.some((l) => l.code === 'row_key_unsupported'), label);
  }
});

// ---- B2: which host is sent when the explicit field and the URL differ only by `www.` ---------------------------
// The backend matches lower(catalog_products.source_domain) BYTE FOR BYTE, so the explicit catalog field is sent as
// observed (lowercased) -- never the URL's spelling, never a folded one.
test('Tier B DIRECT: an explicit merchant_domain / source_domain wins over the URL host, www. and all, as observed', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const [label, patch, sent] of [
    ['source_domain www., URL bare', { source_domain: 'WWW.Judydoll.com' }, 'www.judydoll.com'],
    ['merchant_domain bare, URL www.', { merchant_domain: 'judydoll.com', external_redirect_url: 'https://www.judydoll.com/products/silky-matte-lip-ink?variant=49819267301653', destination_url: 'https://www.judydoll.com/products/silky-matte-lip-ink' }, 'judydoll.com'],
    ['no explicit field: the hop dest host', {}, 'judydoll.com'],
    ['no explicit field, no hop: destination_url as observed', { external_redirect_url: 'https://www.judydoll.com/products/x?variant=49819267301653', destination_url: 'https://www.judydoll.com/products/x' }, 'www.judydoll.com'],
  ]) {
    const row = { ...JUDY_ROW, ...patch };
    const ctx = await build({ rows: { [row.product_id]: row } });
    await withEnv(CODES_ON, () => ctx.ucp.callTool('create_checkout', createArgs({ productId: row.product_id }), SESSION));
    assert.equal(ctx.backend.calls.length, 1, label);
    assert.equal(ctx.backend.calls[0].body.merchant_domain, sent, label);
  }
});

// =========================================================================================================
// The cart-link variant PRE-FILTER reads the row's own sole variant id (staging demo, 2026-09-29)
// =========================================================================================================
// LIVE: create_checkout for KraveBeauty 24 Carrot Retinal was skipped `variant_unresolvable`. Its read names the one
// variant only as `variants[0].variant_id` / `default_variant_id` -- no source_variant_id, no `variant=` on any URL.
const KRAVE_URL = 'https://kravebeauty.com/products/24-carrot-retinal';
const KRAVE_ROW = Object.freeze({
  product_id: 'sig_bb8acf5d9319c377ce7710dd06fd3395',
  title: '24 Carrot Retinal',
  brand: 'KraveBeauty',
  price: 26,
  currency: 'USD',
  platform: 'external_seed',
  source: 'external_seed',
  product_key: 'prod::external_seed::external_seed::ext_8026e90301d17f1f7745b5c7',
  destination_url: KRAVE_URL,
  external_redirect_url: KRAVE_URL,
  source_url: KRAVE_URL,
  default_variant_id: '41596313010251',
  variants: [{ variant_id: '41596313010251', sku_id: 'K108-01-0000-EU', title: '1.01 oz', price: 26, currency: 'USD' }],
  purchase_grain: 'variant',
});
const kraveCreate = async (row, env = CODES_ON, extra = {}) => {
  const logger = fakeLogger();
  const ctx = await build({ logger, rows: { [row.product_id]: row } });
  const r = await withEnv(env, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs({ productId: row.product_id, expectedMoney:{expected_unit_price_minor:Math.round(row.price*100),expected_currency:row.currency}, ...extra }), SESSION)));
  return { ...ctx, logger, r };
};

test('pre-filter: the LIVE KraveBeauty row (sole variant named only by variant_id / default_variant_id) is POSTed once as cart_link -- and no variant is sent', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { r, backend, m } = await kraveCreate(KRAVE_ROW);
  assert.match(r.ok.id, REAP_ID_RE);
  assert.equal(backend.calls.length, 1);
  const body = backend.calls[0].body;
  assert.deepEqual(
    { merchant_domain: body.merchant_domain, product_key: body.product_key, item_source: body.item_source, idempotency_key: body.idempotency_key },
    { merchant_domain: 'kravebeauty.com', product_key: 'prod::external_seed::external_seed::ext_8026e90301d17f1f7745b5c7', item_source: 'cart_link', idempotency_key: m.lane.reapCartLinkIdempotencyKey('idem-reap-0001') },
  );
  assert.equal(Object.hasOwn(body, 'variant_key'), false, 'the backend accepts no caller variant');
  assert.equal(JSON.stringify(body).includes('41596313010251'), false, 'the variant id never leaves the door');
  // The seller check is still in force.
  const ok = await kraveCreate(KRAVE_ROW, CODES_ON, { reap: { expected_merchant_domain: 'kravebeauty.com' } });
  assert.equal(ok.backend.calls.length, 1);
  const other = await kraveCreate(KRAVE_ROW, CODES_ON, { reap: { expected_merchant_domain: 'other-seller.example' } });
  assert.equal(errorOf(other.r)?.detail?.reason, 'ucp_seller_mismatch');
  assert.equal(other.backend.calls.length, 0);
});

test('pre-filter: only the variant_id, only the default_variant_id, or the gid form each resolve; disagreeing or non-Shopify ids do not (0 POSTs, variant_unresolvable)', async () => {
  const cases = [
    ['variants[0].variant_id alone', { default_variant_id: undefined }, 1],
    ['default_variant_id alone, no variants', { variants: [] }, 1],
    ['default_variant_id alone, variants absent', { variants: undefined }, 1],
    ['gid form on the variant', { default_variant_id: undefined, variants: [{ variant_id: 'gid://shopify/ProductVariant/41596313010251' }] }, 1],
    ['gid default agreeing with a bare variant id', { default_variant_id: 'gid://shopify/ProductVariant/41596313010251' }, 1],
    ['non-numeric variant id (the SKU)', { default_variant_id: undefined, variants: [{ variant_id: 'K108-01-0000-EU' }] }, 0],
    ['non-numeric default (ext_…:single)', { variants: [], default_variant_id: 'ext_8026e90301d17f1f7745b5c7:single' }, 0],
    ['variant_id and default_variant_id disagree', { default_variant_id: '41596313010999' }, 0],
    ['a Shopify variant_id beside a non-Shopify default', { default_variant_id: 'ext_8026e90301d17f1f7745b5c7:single' }, 0],
  ];
  for (const [label, patch, posts] of cases) {
    const row = { ...KRAVE_ROW, ...patch };
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    const { backend, logger } = await kraveCreate(row);
    assert.equal(backend.calls.length, posts, label);
    if (posts === 0) assert.ok(logger.lines.some((l) => l.code === 'variant_unresolvable'), label);
    else assert.equal(Object.hasOwn(backend.calls[0].body, 'variant_key'), false, label);
  }
  // Two variants with different ids are never POSTed (the multi-variant skip runs first), whatever default says.
  for (const def of [undefined, '41596313010251']) {
    const row = { ...KRAVE_ROW, variants: [{ variant_id: '41596313010251' }, { variant_id: '41596313010252' }] };
    if (def === undefined) delete row.default_variant_id;
    const { backend } = await kraveCreate(row);
    assert.equal(backend.calls.length, 0, `two variants, default ${def}`);
  }
});

test('pre-filter, flags off: the KraveBeauty create is byte-identical to a door without the lane, 0 POSTs; cart-link dial off still skips it', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const m = await mods();
  for (const env of [{ [LANE_FLAG]: undefined, [CART_LINK_FLAG]: '1' }, { [LANE_FLAG]: undefined, [CART_LINK_FLAG]: undefined }, { [LANE_FLAG]: '0', [CART_LINK_FLAG]: '1' }]) {
    const withLane = await build({ lane: true, rows: { [KRAVE_ROW.product_id]: KRAVE_ROW } });
    const without = await build({ lane: false, rows: { [KRAVE_ROW.product_id]: KRAVE_ROW } });
    const a = await withEnv(env, () => outcome(m, withLane.ucp.callTool('create_checkout', createArgs({ productId: KRAVE_ROW.product_id }), SESSION)));
    const b = await withEnv(env, () => outcome(m, without.ucp.callTool('create_checkout', createArgs({ productId: KRAVE_ROW.product_id }), SESSION)));
    assert.equal(JSON.stringify(a), JSON.stringify(b), JSON.stringify(env));
    assert.equal(withLane.backend.calls.length, 0);
  }
  const { backend, logger } = await kraveCreate(KRAVE_ROW, ON);
  assert.equal(backend.calls.length, 0);
  assert.ok(logger.lines.some((l) => l.code === 'not_shopify'));
});

// =========================================================================================================
// Option 2 PR D: ENRICHMENT rows (catalog_enrichment_agent_v1) on the cart-link lane, behind their own dial
// =========================================================================================================
// pivota-backend option 2 (PR C) teaches `_load_cart_link_item` to resolve an enrichment row against its variant
// proof table. This gateway half lets those rows reach that POST -- ONLY with REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED
// on (default OFF) on top of both existing dials.
//
// FIXTURES ARE LIVE READS, copied from get_product on 2026-09-29 (image, description and per-variant media members
// dropped; nothing else changed unless the name says so). NONE carries source_domain, source_system or platform;
// canonical_url / url are Pivota's own PDP; the merchant's page is external_redirect_url, with destination_url and
// source_url beside it (stila's and MAC's source_url carry `www.` where the others do not).
const ENRICH_FLAG = 'REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED';
const ENRICH_ON = { ...CODES_ON, [ENRICH_FLAG]: '1' };
const liveVariant = (variant_id, sku_id, title, amount, in_stock = true) => ({
  variant_id, sku_id, title, options: [{ name: 'Color', value: title, axis_kind: 'color' }],
  price: { current: { amount, currency: 'USD' } }, availability: in_stock ? { in_stock: true } : { in_stock: false, available_quantity: 0 },
  axis_kind: 'color', display_label: `Color: ${title}`, source_quality_status: 'captured',
});
const pdp = (sig) => `https://agent.pivota.cc/products/${sig}`;
// stila, ONE variant: the row this lane is for.
const STILA_LIVE = Object.freeze({
  product_id: 'sig_07176ee6bdd7c39f60dd4f9fc121df0d',
  merchant_id: 'merch_obs_7f59d9487c6e0762',
  title: 'Dual-Ended Waterproof Liquid Eye Liner - Amber / Brown | Stila Cosmetics',
  brand: 'Stila',
  source: 'external_seed',
  readiness_tier: null, serving_eligible: true, purchase_route: null, commerce_mode: null, checkout_handoff: null,
  external_redirect_url: 'https://stilacosmetics.com/products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown',
  url: pdp('sig_07176ee6bdd7c39f60dd4f9fc121df0d'),
  canonical_url: pdp('sig_07176ee6bdd7c39f60dd4f9fc121df0d'),
  destination_url: 'https://stilacosmetics.com/products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown',
  source_url: 'https://www.stilacosmetics.com/products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown',
  default_variant_id: '40318467145831',
  variants: [liveVariant('40318467145831', 'SC91020001', 'Amber / Dark Brown', 20)],
  purchase_grain: 'variant',
  price: 20,
  availability: { in_stock: true },
  source_product_id: 'stila:d51136bb9c4d8454',
  product_key: 'ext:stila-stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown-last-chance-shade::73fc0547',
  sellable_item_group_id: 'sig_07176ee6bdd7c39f60dd4f9fc121df0d',
  product_group_id: 'sig_aa1c66fa39df46adf89e4580',
  pivota_signature_id: 'sig_07176ee6bdd7c39f60dd4f9fc121df0d',
  pivota_canonical_url: pdp('sig_07176ee6bdd7c39f60dd4f9fc121df0d'),
  canonical_scope: 'synthetic',
  currency: 'USD',
});
// bluemercury (a retailer, ext:retailer: key): NINE variants live; the first three kept.
const BLUEMERCURY_LIVE = Object.freeze({
  product_id: 'sig_016e4c1188aad178f54edf96f9d486fc',
  merchant_id: 'merch_obs_a2e07b1e8a08148b',
  title: 'Afterglow Liquid Blush',
  brand: 'NARS',
  source: 'external_seed',
  readiness_tier: null, serving_eligible: true, purchase_route: null, commerce_mode: null, checkout_handoff: null,
  external_redirect_url: 'https://bluemercury.com/products/nars-afterglow-liquid-blush',
  url: pdp('sig_016e4c1188aad178f54edf96f9d486fc'),
  canonical_url: pdp('sig_016e4c1188aad178f54edf96f9d486fc'),
  destination_url: 'https://bluemercury.com/products/nars-afterglow-liquid-blush',
  source_url: 'https://bluemercury.com/products/nars-afterglow-liquid-blush',
  default_variant_id: '40020810465355',
  variants: [
    liveVariant('40020810465355', '9425113202', 'Orgasm', 34, false),
    liveVariant('40020810498123', '9425113203', 'Behave', 34, false),
    liveVariant('40020810530891', '9425113204', 'Dolce Vita', 34, false),
  ],
  purchase_grain: 'variant',
  price: 34,
  availability: { in_stock: true },
  source_product_id: 'bluemercury-com:a257e56e2b97fc71',
  product_key: 'ext:retailer:1af5dd8fd7ce370b37e13eedcdd32fc7',
  pivota_signature_id: 'sig_016e4c1188aad178f54edf96f9d486fc',
  pivota_canonical_url: pdp('sig_016e4c1188aad178f54edf96f9d486fc'),
  currency: 'USD',
});
// tarte: 48 variants live; two kept.
const TARTE_LIVE = Object.freeze({
  product_id: 'sig_1d54c9e3b5d3969ea4327b5de4f5d101',
  merchant_id: 'merch_obs_c75008da8d4366d6',
  title: 'Shape Tape™ Blur Concealer Stick | Creamy, Buildable Coverage in 47 Shades – Tarte™',
  brand: 'Tarte',
  source: 'external_seed',
  external_redirect_url: 'https://tartecosmetics.com/products/shape-tape-blur-concealer-stick',
  url: pdp('sig_1d54c9e3b5d3969ea4327b5de4f5d101'),
  canonical_url: pdp('sig_1d54c9e3b5d3969ea4327b5de4f5d101'),
  destination_url: 'https://tartecosmetics.com/products/shape-tape-blur-concealer-stick',
  source_url: 'https://tartecosmetics.com/products/shape-tape-blur-concealer-stick',
  default_variant_id: '52789610643478',
  variants: [liveVariant('52789610643478', 'FG14427', '8B porcelain beige', 32), liveVariant('52789610676246', 'FG14428', '12B fair beige', 32)],
  purchase_grain: 'variant',
  price: 32,
  source_product_id: 'tarte:5c0800334c4a222a',
  product_key: 'ext:tarte-shape-tape-blur-concealer-stick::874dcfea',
  currency: 'USD',
});
// MAC: 7 variants live (the shade family); two kept. Its source_url is www., the others bare.
const MAC_LIVE = Object.freeze({
  product_id: 'sig_f5da0819600319955648dc6b9da64125',
  merchant_id: 'merch_obs_28b3afd14edf211f',
  title: 'Retro Matte Lipstick - Bronx',
  brand: 'MAC Cosmetics',
  source: 'external_seed',
  external_redirect_url: 'https://maccosmetics.com/products/retro-matte-lipstick',
  url: pdp('sig_f5da0819600319955648dc6b9da64125'),
  canonical_url: pdp('sig_f5da0819600319955648dc6b9da64125'),
  destination_url: 'https://maccosmetics.com/products/retro-matte-lipstick',
  source_url: 'https://www.maccosmetics.com/products/retro-matte-lipstick',
  default_variant_id: '54057345941699',
  variants: [liveVariant('54057345941699', 'M0N904', 'Ruby Woo', 24), liveVariant('54057345908931', 'M0N901', 'Bronx', 24)],
  purchase_grain: 'variant',
  price: 24,
  source_product_id: 'mac-cosmetics:b9fbf06a66abf0ed',
  product_key: 'ext:mac-cosmetics-retro-matte-lipstick::a234aae1',
  currency: 'USD',
});
// The PRODUCER's product-level placeholder (ingestion.py): sku `<product_key>::canonical`, source_variant_id = the
// product key. No live read exposes it (the view assembler drops it; none of the four above has it); if one did, it
// would carry those identities.
const placeholderOf = (row) => ({ variant_id: row.product_key, sku_id: `${row.product_key}::canonical`, title: 'Default' });

const enrichCreate = async (row, env = ENRICH_ON, extra = {}) => {
  const logger = fakeLogger();
  const ctx = await build({ logger, rows: { [row.product_id]: row } });
  const r = await withEnv(env, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs({ productId: row.product_id, expectedMoney:{expected_unit_price_minor:Math.round(row.price*100),expected_currency:row.currency}, ...extra }), SESSION)));
  return { ...ctx, logger, r };
};
const skipCodes = (logger) => logger.lines.filter((l) => l.event === 'reap_agentic_lane' && l.outcome === 'skipped').map((l) => l.code);
const withRow = (base, patch) => {
  const row = { ...base, ...patch };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return row;
};

test('enrichment ON: the LIVE stila read (one variant) is POSTed ONCE as cart_link -- the storefront host, the key as is, no variant', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { r, backend, logger, m } = await enrichCreate(STILA_LIVE);
  assert.match(keep(r.ok).id, REAP_ID_RE);
  assert.equal(backend.calls.length, 1, 'one POST, no variant attempt first');
  const body = backend.calls[0].body;
  assert.deepEqual(
    { merchant_domain: body.merchant_domain, product_key: body.product_key, item_source: body.item_source, quantity: body.quantity, idempotency_key: body.idempotency_key },
    { merchant_domain: 'stilacosmetics.com', product_key: STILA_LIVE.product_key, item_source: 'cart_link', quantity: 1, idempotency_key: m.lane.reapCartLinkIdempotencyKey('idem-reap-0001') },
  );
  assert.equal(Object.hasOwn(body, 'variant_key'), false);
  assert.equal(JSON.stringify(body).includes('40318467145831'), false, 'the variant id never leaves the door');
  assert.ok(logger.lines.some((l) => l.outcome === 'cart_link_direct' && l.code === 'enrichment'));
  assert.equal(message(r.ok, 'reap.merchant_domain').content, 'stilacosmetics.com');
  assert.equal(message(r.ok, 'reap.merchant_id'), undefined, 'an ext: key names no seller id');
  assert.equal(m.lane.decodeReapCheckoutId(r.ok.id).productKey, STILA_LIVE.product_key, 'the id round-trips the ext: key');
});

test('enrichment ON: the LIVE bluemercury read (ext:retailer: key), cut to its first variant, sends bluemercury.com', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { r, backend } = await enrichCreate(withRow(BLUEMERCURY_LIVE, { variants: BLUEMERCURY_LIVE.variants.slice(0, 1) }));
  assert.match(r.ok.id, REAP_ID_RE);
  assert.equal(backend.calls.length, 1);
  assert.deepEqual(
    { merchant_domain: backend.calls[0].body.merchant_domain, product_key: backend.calls[0].body.product_key, item_source: backend.calls[0].body.item_source },
    { merchant_domain: 'bluemercury.com', product_key: 'ext:retailer:1af5dd8fd7ce370b37e13eedcdd32fc7', item_source: 'cart_link' },
  );
});

test('enrichment ON: the LIVE multi-variant reads (bluemercury, tarte, MAC) are multi_variant, 0 POSTs', async () => {
  for (const row of [BLUEMERCURY_LIVE, TARTE_LIVE, MAC_LIVE]) {
    const { backend, logger } = await enrichCreate(row);
    assert.equal(backend.calls.length, 0, row.product_id);
    assert.deepEqual(skipCodes(logger), ['multi_variant'], row.product_id);
  }
  // Control: the MAC read cut to one variant IS sent, its www. source_url agreeing with the bare storefront host.
  const mac = await enrichCreate(withRow(MAC_LIVE, { variants: MAC_LIVE.variants.slice(0, 1), default_variant_id: MAC_LIVE.variants[0].variant_id }));
  assert.equal(mac.backend.calls.length, 1);
  assert.equal(mac.backend.calls[0].body.merchant_domain, 'maccosmetics.com');
});

test('enrichment dial OFF (unset, "0", "off"): the live ext: rows are skipped row_key_unsupported exactly as before, 0 POSTs', async () => {
  for (const flag of [undefined, '0', 'off']) {
    for (const row of [STILA_LIVE, withRow(BLUEMERCURY_LIVE, { variants: BLUEMERCURY_LIVE.variants.slice(0, 1) })]) {
      const { backend, logger, r } = await enrichCreate(row, { ...CODES_ON, [ENRICH_FLAG]: flag },{legacy:true});
      assert.equal(backend.calls.length, 0, `${row.product_id} flag ${flag}`);
      assert.deepEqual(skipCodes(logger), ['row_key_unsupported'], `${row.product_id} flag ${flag}`);
      assert.deepEqual(r, { ok: KERNEL_ON_UCP }, 'the kernel path answers, as before');
    }
  }
});

test('enrichment dial ON but a lower dial off: cart-link off -> not_shopify as before; lane off -> byte-identical to no lane', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { backend, logger } = await enrichCreate(STILA_LIVE, { ...ON, [CART_LINK_FLAG]: undefined, [ENRICH_FLAG]: '1' });
  assert.equal(backend.calls.length, 0);
  assert.deepEqual(skipCodes(logger), ['not_shopify']);
  const m = await mods();
  for (const env of [{ [LANE_FLAG]: undefined, [CART_LINK_FLAG]: '1', [ENRICH_FLAG]: '1' }, { [LANE_FLAG]: '0', [CART_LINK_FLAG]: '1', [ENRICH_FLAG]: '1' }]) {
    const withLane = await build({ lane: true, rows: { [STILA_LIVE.product_id]: STILA_LIVE } });
    const without = await build({ lane: false, rows: { [STILA_LIVE.product_id]: STILA_LIVE } });
    const a = await withEnv(env, () => outcome(m, withLane.ucp.callTool('create_checkout', createArgs({ productId: STILA_LIVE.product_id }), SESSION)));
    const b = await withEnv(env, () => outcome(m, without.ucp.callTool('create_checkout', createArgs({ productId: STILA_LIVE.product_id }), SESSION)));
    assert.equal(JSON.stringify(a), JSON.stringify(b), JSON.stringify(env));
    assert.equal(withLane.backend.calls.length, 0);
  }
});

test('enrichment ON: every OTHER ext: shape, the LEGACY collapsed ext:unknown::<8 hex> key, and another source system stay row_key_unsupported, 0 POSTs', async () => {
  const hex32 = '1af5dd8fd7ce370b37e13eedcdd32fc7';
  const hex16 = 'd3bac5e705f83353';
  for (const [label, patch] of [
    ['ext:foo (no hash)', { product_key: 'ext:foo' }],
    ['the collapsed all-non-ASCII key', { product_key: 'ext:unknown::bfb6e8a3' }],
    ['the collapsed key the legacy generator really minted (sha1("unknown")[:8])', { product_key: 'ext:unknown::50d8b4a9' }],
    ['ext:unknown::, 15 hex', { product_key: `ext:unknown::${hex16.slice(0, 15)}` }],
    ['ext:unknown::, 17 hex', { product_key: `ext:unknown::${hex16}0` }],
    ['ext:unknown::, uppercase 16 hex', { product_key: `ext:unknown::${hex16.toUpperCase()}` }],
    ['a slug, 15 hex', { product_key: 'ext:cos-de-baha-mv-50ml::63c46c9fb300432' }],
    ['a slug, 17 hex', { product_key: 'ext:cos-de-baha-mv-50ml::63c46c9fb300432e0' }],
    ['a slug, uppercase 16 hex', { product_key: 'ext:cos-de-baha-mv-50ml::63C46C9FB300432E' }],
    ['uppercase hash', { product_key: 'ext:stila-stay-all-day::73FC0547' }],
    ['7-hex hash', { product_key: 'ext:stila-stay-all-day::73fc054' }],
    ['uppercase slug', { product_key: 'ext:Stila-stay-all-day::73fc0547' }],
    ['empty slug', { product_key: 'ext:::73fc0547' }],
    ['retailer, 31 hex', { product_key: `ext:retailer:${hex32.slice(0, 31)}` }],
    ['retailer, 33 hex', { product_key: `ext:retailer:${hex32}a` }],
    ['retailer, uppercase hex', { product_key: `ext:retailer:${hex32.toUpperCase()}` }],
    ['the mirror source system', { source_system: 'external_product_seeds_mirror_v1' }],
    ['another agent version', { source_system: 'catalog_enrichment_agent_v2' }],
  ]) {
    const { backend, logger } = await enrichCreate(withRow(STILA_LIVE, patch));
    assert.equal(backend.calls.length, 0, label);
    assert.deepEqual(skipCodes(logger), ['row_key_unsupported'], label);
  }
  // Control: the agent's source system on the read is accepted like none.
  const { backend } = await enrichCreate(withRow(STILA_LIVE, { source_system: 'catalog_enrichment_agent_v1' }));
  assert.equal(backend.calls.length, 1);
});

// pivota-backend #2461 (`_script_identity`): a name its ASCII slug cannot stand for is keyed `ext:<slug of the
// identity text, or "unknown">::<sha1(identity)[:16]>`, one DISTINCT key per product. Minted by that PR's own
// derive_product_key (head 3d33719c): ("설화수", "자음생크림"), and the one live key it moves (Cos de BAHA, pinned there).
test('enrichment ON: #2461 distinct 16-hex keys (ext:unknown:: included) are POSTed ONCE as is, and the id round-trips them', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const key of ['ext:unknown::d3bac5e705f83353', 'ext:cos-de-baha-mv-50ml::63c46c9fb300432e']) {
    const { r, backend, logger, m } = await enrichCreate(withRow(STILA_LIVE, { product_key: key }));
    assert.equal(backend.calls.length, 1, key);
    assert.equal(backend.calls[0].body.product_key, key);
    assert.equal(backend.calls[0].body.item_source, 'cart_link');
    assert.deepEqual(skipCodes(logger), [], key);
    assert.equal(m.lane.decodeReapCheckoutId(keep(r.ok).id).productKey, key, key);
  }
});

test('enrichment ON, the host: the storefront page, every other merchant field agreeing (www. folded); else nothing is opened', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const [label, patch, expected] of [
    ['a www. storefront target is sent as observed', { external_redirect_url: 'https://www.stilacosmetics.com/products/x' }, 'www.stilacosmetics.com'],
    ['canonical_url / url on another host are never read', { canonical_url: 'https://other-seller.example/products/x', url: 'https://other-seller.example/products/x' }, 'stilacosmetics.com'],
    ['agreeing explicit source_domain / merchant_domain', { source_domain: 'www.stilacosmetics.com', merchant_domain: 'StilaCosmetics.com' }, 'stilacosmetics.com'],
    ['no destination_url / source_url at all', { destination_url: undefined, source_url: undefined }, 'stilacosmetics.com'],
    ['an affiliate destination_url', { destination_url: 'https://click.linksynergy.com/deeplink?id=abc&murl=https%3A%2F%2Fstilacosmetics.com%2Fp' }, 'merchant_domain_conflict'],
    ['a source_url on a retailer', { source_url: 'https://bluemercury.com/products/stila-liner' }, 'merchant_domain_conflict'],
    ['a source_domain naming another seller', { source_domain: 'bluemercury.com' }, 'merchant_domain_conflict'],
    ['a merchant_domain naming another seller', { merchant_domain: 'ulta.com' }, 'merchant_domain_conflict'],
    ['a sibling subdomain source_url', { source_url: 'https://shop.stilacosmetics.com/products/x' }, 'merchant_domain_conflict'],
    ['storefront target with a query', { external_redirect_url: 'https://stilacosmetics.com/products/x?utm_source=pivota' }, 'no_merchant_domain'],
    ['storefront target not a /products/ page', { external_redirect_url: 'https://stilacosmetics.com/collections/eye' }, 'no_merchant_domain'],
    ['storefront target with a port', { external_redirect_url: 'https://stilacosmetics.com:8443/products/x' }, 'no_merchant_domain'],
    // Review R2: the door and escalationTargetOf see the PARSED target (`:443` dropped, `/x/../` resolved); the host is
    // taken from the field as the row carries it, which pivota-backend storefront_page would refuse.
    ['storefront target with :443', { external_redirect_url: 'https://stilacosmetics.com:443/products/x' }, 'no_merchant_domain'],
    ['storefront target with a dot segment', { external_redirect_url: 'https://stilacosmetics.com/x/../products/x' }, 'no_merchant_domain'],
    ['storefront target with an escaped handle the parser keeps as written', { external_redirect_url: 'https://stilacosmetics.com/products/x%2Fy' }, 'stilacosmetics.com'],
    ['storefront target a Pivota hop', { external_redirect_url: `https://api.pivota.cc/r?token=${hopToken({ dest: 'https://stilacosmetics.com/products/x' })}` }, 'no_merchant_domain'],
  ]) {
    const { backend, logger } = await enrichCreate(withRow(STILA_LIVE, patch));
    if (expected.includes('.')) {
      assert.equal(backend.calls.length, 1, label);
      assert.equal(backend.calls[0].body.merchant_domain, expected, label);
    } else {
      assert.equal(backend.calls.length, 0, label);
      assert.deepEqual(skipCodes(logger), [expected], label);
    }
  }
});

test('enrichment ON, the seller: the door still refuses ucp_seller_mismatch; the host POSTed is the one the door judged', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const expected of ['stilacosmetics.com', 'WWW.STILACOSMETICS.COM']) {
    const { backend } = await enrichCreate(STILA_LIVE, ENRICH_ON, { reap: { expected_merchant_domain: expected } });
    assert.equal(backend.calls.length, 1, expected);
    assert.equal(backend.calls[0].body.merchant_domain, 'stilacosmetics.com');
  }
  const other = await enrichCreate(STILA_LIVE, ENRICH_ON, { reap: { expected_merchant_domain: 'bluemercury.com' } });
  assert.deepEqual([errorOf(other.r)?.detail?.reason, errorOf(other.r)?.detail?.merchant_domain], ['ucp_seller_mismatch', 'stilacosmetics.com']);
  assert.equal(other.backend.calls.length, 0);
});

test('enrichment ON, the variant pre-filter: canonical-only (the producer\'s placeholder, or nothing) and one-variant rows pass; two or more are multi_variant', async () => {
  const S = STILA_LIVE;
  const real = S.variants[0];
  const second = liveVariant('40318467145832', 'SC91020002', 'Black', 20);
  for (const [label, patch, posts] of [
    ['no variants member', { variants: undefined, default_variant_id: undefined }, 1],
    ['variants: []', { variants: [], default_variant_id: undefined }, 1],
    ['only the producer placeholder (sku <pk>::canonical, id = product_key)', { variants: [placeholderOf(S)], default_variant_id: undefined }, 1],
    ['the long-key placeholder (source_variant_id = source_product_id, sku <pk>::canonical), beside the real one', { variants: [{ variant_id: S.source_product_id, sku_id: `${S.product_key}::canonical` }, real] }, 1],
    ['a placeholder named only by its sku <pk>::canonical, beside the real one', { variants: [{ sku_id: `${S.product_key}::canonical`, title: 'Default' }, real] }, 1],
    ['the placeholder beside the ONE real variant', { variants: [placeholderOf(S), real] }, 1],
    ['a placeholder named only by source_variant_id = product_key, beside the real one', { variants: [{ source_variant_id: S.product_key, title: 'Default' }, real] }, 1],
    ['a placeholder restating the requested product id, beside the real one', { variants: [{ variant_id: S.product_id }, real] }, 1],
    ['a placeholder named by `id` (the read\'s other id member), beside the real one', { variants: [{ id: S.product_key }, real] }, 1],
    ['a sole variant the door cannot name (the backend proves it)', { variants: [{ ...real, variant_id: 'SC91020001' }] }, 1],
    ['a sole variant with no id', { variants: [{ title: 'Amber / Dark Brown' }] }, 1],
    ['two real variants', { variants: [real, second] }, 0],
    ['the placeholder beside TWO real variants', { variants: [placeholderOf(S), real, second] }, 0],
    ['two shade entries with no ids', { variants: [{ title: 'Fair' }, { title: 'Light' }] }, 0],
    ['the same id twice', { variants: [real, real] }, 0],
    ['a real id whose sku merely STARTS like the key is not a placeholder', { variants: [real, { variant_id: '40318467145832', sku_id: `${S.product_key}::canonical` }] }, 0],
    ['variants not an array', { variants: { variant_id: real.variant_id } }, 0],
    // Review R1: only EXACT restatements are the placeholder. Each of these is two variants the store sells.
    ['c2: two <pk>::v:<id> variant ids (prefix-restating the key)', { variants: [{ variant_id: `${S.product_key}::v:111` }, { variant_id: `${S.product_key}::v:222` }] }, 0],
    ['c2\': two <pk>::v:<id> skus, no variant ids', { variants: [{ sku_id: `${S.product_key}::v:111` }, { sku_id: `${S.product_key}::v:222` }] }, 0],
    ['c3: numeric variant ids whose skus restate source_product_id', { variants: [{ variant_id: 111, sku_id: S.source_product_id }, { variant_id: 222, sku_id: `${S.source_product_id}-2` }] }, 0],
    ['a digit-only id equal to a digit-only source_product_id is still real', { source_product_id: '8812345', variants: [{ variant_id: '8812345' }, real] }, 0],
    ['<pk>::canonical-2 is not the placeholder', { variants: [{ sku_id: `${S.product_key}::canonical-2` }, real] }, 0],
    ['a placeholder-looking entry with an EMPTY extra id is real', { variants: [{ variant_id: S.product_key, sku_id: '' }, real] }, 0],
  ]) {
    const { backend, logger } = await enrichCreate(withRow(S, patch));
    assert.equal(backend.calls.length, posts, label);
    if (posts === 0) assert.deepEqual(skipCodes(logger), ['multi_variant'], label);
    else assert.equal(Object.hasOwn(backend.calls[0].body, 'variant_key'), false, label);
  }
});

test('enrichment ON, pdpBuilder.buildVariants shapes (review R1 c1): two id-less variants are TWO; one, or none, still passes', async () => {
  const { buildPdpPayload } = require('../src/pdpBuilder');
  const S = STILA_LIVE;
  const built = (variants) => buildPdpPayload({ product: { product_id: S.product_id, title: S.title, currency: 'USD', price: 20, ...(variants ? { variants } : {}) } }).product.variants;
  const two = built([{ title: 'Amber / Dark Brown' }, { title: 'Black' }]);
  assert.deepEqual(two.map((v) => v.variant_id), [`${S.product_id}-1`, `${S.product_id}-2`], 'the producer really names them <product_id>-N');
  const one = built([{ title: 'Amber / Dark Brown' }]);
  const none = built(undefined);
  assert.deepEqual(none.map((v) => [v.variant_id, v.sku_id]), [[S.product_id, S.product_id]], 'a variant-less product is ONE entry restating the product id');
  for (const [label, variants, posts] of [
    ['c1: two id-less variants -> <pid>-1, <pid>-2', two, 0],
    ['control: one id-less variant -> <pid>-1', one, 1],
    ['control: no variants -> the product id restated (the placeholder)', none, 1],
    ['control: that placeholder beside one real variant', [...none, S.variants[0]], 1],
  ]) {
    const { backend, logger } = await enrichCreate(withRow(S, { variants, default_variant_id: undefined }));
    assert.equal(backend.calls.length, posts, label);
    if (posts === 0) assert.deepEqual(skipCodes(logger), ['multi_variant'], label);
  }
});

test('enrichment ON does not change MIRROR rows (#2326/#2327): a named sole variant is still required; KraveBeauty still posts', async () => {
  const noVariant = withRow(JSM_ROW, { source_variant_id: undefined });
  const ctx = await build({ logger: fakeLogger(), rows: { [JSM_ROW.product_id]: noVariant } });
  await withEnv(ENRICH_ON, () => ctx.ucp.callTool('create_checkout', sgArgs(), SESSION).catch(() => null));
  assert.equal(ctx.backend.calls.length, 0);
  assert.deepEqual(skipCodes(ctx.logger), ['variant_unresolvable']);
  const k = await kraveCreate(KRAVE_ROW, ENRICH_ON);
  assert.equal(k.backend.calls.length, 1);
  assert.equal(k.backend.calls[0].body.merchant_domain, 'kravebeauty.com');
  const disagree = await kraveCreate({ ...KRAVE_ROW, default_variant_id: '41596313010999' }, ENRICH_ON);
  assert.equal(disagree.backend.calls.length, 0);
  // Mirror multi-variant: still realVariantCount's rule (two distinct ids), not the enrichment one.
  const idless = await build({ logger: fakeLogger(), rows: { [JSM_ROW.product_id]: { ...JSM_ROW, variants: [{ title: 'a' }, { title: 'b' }] } } });
  await withEnv(ENRICH_ON, () => idless.ucp.callTool('create_checkout', sgArgs(), SESSION));
  assert.equal(idless.backend.calls.length, 1, 'mirror rows keep realVariantCount (entries without ids are not counted)');
  // The mirror host rule (hop dest, then destination_url) is untouched by the enrichment one.
  const judy = await enrichCreate(JUDY_ROW);
  assert.equal(judy.backend.calls[0].body.merchant_domain, 'judydoll.com');
  const judyDest = await enrichCreate({ ...JUDY_ROW, external_redirect_url: 'https://www.judydoll.com/products/x?variant=49819267301653', destination_url: 'https://www.judydoll.com/products/x' });
  assert.equal(judyDest.backend.calls[0].body.merchant_domain, 'www.judydoll.com');
});

test('enrichment ON does not touch SHOPIFY rows: a Shopify-platform row is the variant lane, whatever its key', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const row = withRow(STILA_LIVE, {
    product_id: 'sig_shop_extkey', platform: 'shopify',
    external_redirect_url: 'https://www.brand.example/products/x',
  });
  const { backend } = await enrichCreate(row);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].body.item_source, undefined, 'the variant lane');
  assert.equal(backend.calls[0].body.merchant_domain, 'www.brand.example');
});


// Explicit read-only vendor tool: older gateways reject this name rather than
// silently ignoring an optional create flag and minting after key expiry.
test('recover_checkout cart-link parity: same body/key beyond 24h despite changed price/proof/variants and paused create flags', async (t) => {
  let clock = NOW;
  t.mock.method(Date, 'now', () => clock);
  const row = { ...JUDY_ROW };
  const args = createArgs({ productId: row.product_id, key: 'recovery-cart-original-01',
    discounts: { codes: ['SAVE10'] }, reap: { expected_merchant_domain: 'judydoll.com' } });
  const ctx = await build({ rows: { [row.product_id]: row } });
  await withEnv(CODES_ON, () => ctx.ucp.callTool('create_checkout', args, SESSION));
  const original = ctx.backend.calls[0];
  assert.equal(original.body.item_source, 'cart_link');
  assert.equal(original.body.buyer.consent_version, 'reap-agentic-v1');
  assert.equal(original.body.buyer.shipping_address.country, 'US');
  assert.equal(original.body.offer_code, 'SAVE10');
  assert.equal(Object.hasOwn(original.body, 'variant_key'), false);
  assert.equal(original.body.idempotency_key, ctx.m.lane.reapCartLinkIdempotencyKey('recovery-cart-original-01'));
  const storedView = view('awaiting_approval', { product_key: row.product_key, merchant_domain: 'judydoll.com',
    totals: { currency: 'USD', our_price_minor: 999, quoted_total_minor: 1099 },
    hosted_url: APPROVE_URL, hosted_url_expires_at: SOON, approval_deadline: SOON });
  ctx.backend.state.recover.set(original.body.idempotency_key, (body) => {
    assert.deepEqual(body, original.body, 'original normalized create and recover backend bodies are identical');
    return { status: 200, body: storedView };
  });
  row.price = 999;
  row.variants = [{ variant_id: 'new1' }, { variant_id: 'new2' }];
  row.source_variant_id = undefined;
  row.cart_link_eligible = false;
  row.cart_link_proof = { expires_at: EARLIER };
  clock += 26 * 60 * 60 * 1000;
  const paused = { ...CODES_ON, REAP_AGENTIC_CREATE_ENABLED: '0', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '0' };
  const executorCallsBeforeRecovery = ctx.executor.seen.length;
  const result = await withEnv(paused, () => ctx.ucp.callTool('recover_checkout', args, SESSION));
  assert.match(result.id, REAP_ID_RE);
  assert.equal(result.status, 'incomplete', 'expired hosted action remains closed, no fresh checkout');
  assert.equal(result.continue_url, undefined);
  assert.equal(result.line_items[0].item.price, 999, 'receipt uses stored price, never current catalog price');
  const recovered = ctx.backend.calls.filter((c) => c.path.endsWith('/recover') && c.body.item_source === 'cart_link');
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].headers, original.headers, 'same calling agent and buyer headers');
  clock += 48 * 60 * 60 * 1000;
  await withEnv(paused, () => ctx.ucp.callTool('recover_checkout', args, SESSION));
  assert.deepEqual(ctx.backend.calls.filter((c) => c.path.endsWith('/recover')).map((c) => c.body.idempotency_key),
    [original.body.idempotency_key, original.body.idempotency_key]);
  assert.equal(ctx.backend.calls.filter((c) => !c.path.endsWith('/recover')).length, 1, 'only the original create was dispatched');
  assert.equal(ctx.executor.seen.length, executorCallsBeforeRecovery, 'recovery bypasses PDP/catalog executor entirely');
  assert.equal(ctx.identityQueries.length, 2);
  assert.deepEqual(ctx.identityQueries.map((q) => q.values), [[row.product_id], [row.product_id]]);
});

for (const [label, response] of [
  ['not found/tombstone', { status: 404, body: houseError('purchase_not_found', 404) }],
  ['changed request hash', { status: 409, body: houseError('idempotency_conflict', 409) }],
  ['backend failure', { status: 500, body: {} }],
  ['malformed view', { status: 200, body: { id: PID } }],
]) {
  test(`recover_checkout ${label}: stays unknown with no create or alternate checkout`, async () => {
    const ctx = await build();
    ctx.backend.state.recover.set(ctx.m.lane.reapIdempotencyKey('idem-reap-0001'), response);
    const outcomeValue = await withEnv({ ...ON, REAP_AGENTIC_CREATE_ENABLED: '0' },
      () => outcome(ctx.m, ctx.ucp.callTool('recover_checkout', createArgs(), SESSION)));
    const error = JSON.parse(outcomeValue.err.content[0].text).error;
    assert.equal(error.code, 'CHECKOUT_OUTCOME_UNKNOWN');
    assert.equal(error.detail.reason, 'ucp_reap_create_outcome_unknown');
    assert.equal(ctx.backend.calls.every((c) => c.path.endsWith('/recover')), true);
    assert.equal(ctx.executor.seen.some((c) => c.op === 'create_checkout_session'), false);
    assert.equal(JSON.stringify(error).includes(REAP_ROW.external_redirect_url), false);
  });
}

test('recover_checkout requires the existing verified buyer/session and rejects payment/invalid keys before backend access', async () => {
  const ctx = await build();
  const badKey = createArgs({ key: '' });
  const payment = createArgs(); payment.checkout.payment = { token: 'do-not-charge' };
  for (const args of [badKey, payment]) {
    const result = await outcome(ctx.m, ctx.ucp.callTool('recover_checkout', args, SESSION));
    assert.ok(result.err);
  }
  const anonymous = await outcome(ctx.m, ctx.ucp.callTool('recover_checkout', createArgs(), {}));
  assert.ok(anonymous.err);
  assert.equal(ctx.backend.calls.length, 0);
});

test('recover_checkout unknown catalog identity or absent backend recover support never falls through', async () => {
  const ctx = await build({ rows: {} });
  const r = await outcome(ctx.m, ctx.ucp.callTool('recover_checkout', createArgs(), SESSION));
  assert.equal(JSON.parse(r.err.content[0].text).error.code, 'CHECKOUT_OUTCOME_UNKNOWN');
  assert.equal(ctx.backend.calls.length, 0);
  assert.equal(ctx.executor.seen.some((c) => c.op === 'create_checkout_session'), false);
});

test('recover_checkout transport deadline is bounded and never becomes a fresh create', { timeout: 5000 }, async () => {
  const ctx = await build({ clientTimeoutMs: 60 });
  ctx.backend.state.mode = 'hang';
  const r = await withEnv({ ...ON, REAP_AGENTIC_CREATE_ENABLED: '0' },
    () => outcome(ctx.m, ctx.ucp.callTool('recover_checkout', createArgs(), SESSION)));
  assert.equal(JSON.parse(r.err.content[0].text).error.code, 'CHECKOUT_OUTCOME_UNKNOWN');
  assert.equal(ctx.backend.calls.length, 1);
  assert.equal(ctx.backend.calls[0].path.endsWith('/recover'), true);
});


test('actual backend flat purchase_not_found404 advances variant-to-cart recovery without create', async () => {
  const row = { ...JUDY_ROW, source_domain: 'judydoll.com' };
  const ctx = await build({ rows: { [row.product_id]: row } });
  const args = createArgs({ productId: row.product_id, key: 'actual-flat-recover-namespace',
    reap: { expected_merchant_domain: 'judydoll.com' } });
  // Actual pre-money-contract owned attempt: absence remains exact.
  delete args.checkout.reap.expected_unit_price_minor;delete args.checkout.reap.expected_currency;
  const variantKey = ctx.m.lane.reapIdempotencyKey('actual-flat-recover-namespace');
  const cartKey = ctx.m.lane.reapCartLinkIdempotencyKey('actual-flat-recover-namespace');
  ctx.backend.state.recover.set(variantKey, { status: 404, body: { error: 'purchase_not_found' } });
  ctx.backend.state.recover.set(cartKey, { status: 200, body: view('resolving', {
    merchant_domain: 'judydoll.com', product_key: row.product_key,
    totals: { currency: 'USD', our_price_minor: 1399 },
  }) });
  const result = await withEnv({ ...ON, REAP_AGENTIC_CREATE_ENABLED: '0' },
    () => ctx.ucp.callTool('recover_checkout', args, SESSION));
  assert.match(result.id, REAP_ID_RE);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.continue_url, undefined);
  assert.deepEqual(ctx.backend.calls.map(c => c.body.idempotency_key), [variantKey, cartKey]);
  assert.equal(ctx.backend.calls.every(c => c.path.endsWith('/recover')), true);
  assert.equal(ctx.executor.seen.length, 0, 'no normal PDP or native checkout executor');
});

for (const [label, body, expectedKind] of [
  ['authoritative flat miss', { error: 'purchase_not_found' }, 'not_found'],
  ['existing detailed miss', houseError('purchase_not_found', 404), 'not_found'],
  ['unrelated flat404', { error: 'not_available_on_this_rail' }, 'unavailable'],
  ['unrecognized object404', { error: { code: 'purchase_not_found' } }, 'unavailable'],
  ['conflicting detailed404', { error: 'purchase_not_found', detail: { error: 'rail_disabled' } }, 'unavailable'],
  ['malformed detailed404', { error: 'purchase_not_found', detail: { error: 7 } }, 'unavailable'],
  ['null detailed404', { error: 'purchase_not_found', detail: null }, 'unavailable'],
  ['string detailed404', { error: 'purchase_not_found', detail: 'rail_disabled' }, 'unavailable'],
  ['empty404', {}, 'unavailable'],
]) {
  test(`recover client actual envelope ${label} preserves specific404 classification`, async () => {
    const b = fakeBackend(); const ctx = await build({ backend: b });
    b.state.recover.set('client-envelope-test', { status: 404, body });
    assert.equal((await ctx.client.recoverPurchase({ idempotency_key: 'client-envelope-test' })).kind, expectedKind);
  });
}
test('GET recognizes actual owner-route flat404; the same body on403 is never a namespace miss', async () => {
  const b = fakeBackend(); const ctx = await build({ backend: b });
  b.state.get.set(PID, { status: 404, body: { error: 'purchase_not_found' } });
  assert.equal((await ctx.client.getPurchase(PID)).kind, 'not_found');
  b.state.recover.set('client-envelope-test', { status: 403, body: { error: 'purchase_not_found' } });
  assert.equal((await ctx.client.recoverPurchase({ idempotency_key: 'client-envelope-test' })).kind, 'unavailable');
});

for (const strict of [false,true]) for (const shape of ['flat','nested','main']) {
 const envelope=(status,code)=>shape==='flat'?{error:code}:shape==='nested'?{detail:{error:code}}:{status:'error',error:{code:status===400?'INVALID_REQUEST':'CONFLICT',message:code,details:{error:code}},detail:{error:code}};
 for(const [status,code,expected] of [[409,'merchant_not_eligible','OPERATION_NOT_ALLOWED'],[409,'idempotency_conflict','CHECKOUT_OUTCOME_UNKNOWN'],[400,'consent_required','OPERATION_NOT_ALLOWED'],[404,'not_available_on_this_rail','CHECKOUT_OUTCOME_UNKNOWN']]) {
  test(`PRIMARY: ${strict?'private':'ordinary'} ${shape} ${code} never chooses another rail`,async()=>{
   const backend=fakeBackend(); backend.state.post=[{status,body:envelope(status,code)},{status:202,body:{purchase_id:PID,status:'resolving',poll_after_seconds:60}}];
   const ctx=await build({backend,requireAuthoritativeRefusal:strict});
   const result=await withEnv({...CODES_ON,[ESCALATION_FLAG]:'1'},()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({reap:{expected_merchant_domain:'brand.example'}}),SESSION)));
   assert.ok(result.err); const wire=JSON.parse(result.err.content[0].text); assert.equal(wire.error.code,expected);
   assert.equal(backend.calls.length,1); assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false); assert.equal(JSON.stringify(wire).includes(REAP_ROW.external_redirect_url),false);
  });
 }
}
for(const row of [MULTI_VARIANT_ROW,{...REAP_ROW,price:null},{...REAP_ROW,product_key:null},NATIVE_ROW]){
 test(`PRIMARY: preflight block for ${row.product_id}/${row.product_key}/${row.price} never enters kernel or storefront`,async()=>{
  const ctx=await build({rows:{[row.product_id]:row}});
  const domain=row===NATIVE_ROW?'native.example':'brand.example';
  const result=await withEnv({...ON,[ESCALATION_FLAG]:'1'},()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({productId:row.product_id,reap:{expected_merchant_domain:domain}}),SESSION)));
  assert.ok(result.err);assert.equal(ctx.backend.calls.length,0);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
 });
}

test('explicit Shopify cart_link opens once and recovers only its original source/key after a catalog-independent pause',async()=>{
 const row={...REAP_ROW,source_variant_id:'49819267301653'};
 const backend=fakeBackend(),ctx=await build({backend,rows:{[row.product_id]:row}});
 const args=createArgs({reap:{expected_merchant_domain:'brand.example',item_source:'cart_link'}});
 const opened=await withEnv(CODES_ON,()=>ctx.ucp.callTool('create_checkout',args,SESSION));
 assert.match(opened.id,REAP_ID_RE);assert.equal(backend.calls.length,1);
 const original=backend.calls[0].body;assert.equal(original.item_source,'cart_link');
 backend.state.recover.set(original.idempotency_key,{status:200,body:view('resolving')});
 // A malformed competing namespace is deliberately present: selected-source recovery must never inspect it.
 backend.state.recover.set(ctx.m.lane.reapIdempotencyKey('idem-reap-0001'),{status:500,body:{}});
 const recovered=await withEnv({...CODES_ON,REAP_AGENTIC_CREATE_ENABLED:'0',REAP_AGENTIC_CART_LINK_LANE_ENABLED:'0'},()=>ctx.ucp.callTool('recover_checkout',args,SESSION));
 assert.equal(recovered.id,opened.id);assert.equal(backend.calls.length,2);assert.equal(backend.calls[1].path,'/agent/v2/commerce/reap/purchases/recover');
 assert.deepEqual(backend.calls[1].body,original);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
});

for(const itemSource of ['',null,{},['cart_link'],'cart-link','auto']){
 test(`explicit source ${JSON.stringify(itemSource)} is refused before any backend dispatch`,async()=>{
  const ctx=await build();const result=await withEnv(CODES_ON,()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({reap:{expected_merchant_domain:'brand.example',item_source:itemSource}}),SESSION)));
  assert.ok(result.err);assert.equal(ctx.backend.calls.length,0);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);
 });
}

test('explicit cart_link with its dial off or an unresolved variant never dispatches a variant instead',async()=>{
 for(const [env,row]of [[ON,{...REAP_ROW,source_variant_id:'49819267301653'}],[CODES_ON,REAP_ROW]]){
  const ctx=await build({rows:{[row.product_id]:row}});const result=await withEnv({...env,[ESCALATION_FLAG]:'1'},()=>outcome(ctx.m,ctx.ucp.callTool('create_checkout',createArgs({reap:{expected_merchant_domain:'brand.example',item_source:'cart_link'}}),SESSION)));
  assert.equal(errorOf(result).code,'OPERATION_NOT_ALLOWED');assert.equal(ctx.backend.calls.length,0);assert.equal(ctx.executor.seen.some(c=>c.op==='create_checkout_session'),false);assert.equal(JSON.stringify(result).includes('continue_url'),false);
 }
});

for (const [label,first,second,terminal] of [
  ['paired receipt','a'.repeat(32),'a'.repeat(32),true],
  ['different receipts','a'.repeat(32),'b'.repeat(32),false],
  ['missing companion','a'.repeat(32),null,false],
  ['malformed receipt','bad','a'.repeat(32),false],
  ['ambiguous view','a'.repeat(32),'live',false],
]) test(`recover original legacy retirement: ${label}`,async()=>{
  const row={...JUDY_ROW,source_domain:'judydoll.com'};
  const ctx=await build({rows:{[row.product_id]:row}});
  const key='retirement-original-key';
  const args=createArgs({productId:row.product_id,key,reap:{expected_merchant_domain:'judydoll.com'}});
  delete args.checkout.reap.expected_unit_price_minor;delete args.checkout.reap.expected_currency;
  const response=(id)=>id===null?{status:404,body:{error:'purchase_not_found'}}:id==='live'?{status:200,body:view('resolving',{merchant_domain:'judydoll.com',product_key:row.product_key,totals:{currency:'USD',our_price_minor:1399}})}:{status:200,body:{recovery_status:'retired',reconciliation_id:id}};
  ctx.backend.state.recover.set(ctx.m.lane.reapIdempotencyKey(key),response(first));
  ctx.backend.state.recover.set(ctx.m.lane.reapCartLinkIdempotencyKey(key),response(second));
  const result=await withEnv({...ON,REAP_AGENTIC_CREATE_ENABLED:'0'},()=>outcome(ctx.m,ctx.ucp.callTool('recover_checkout',args,SESSION)));
  const error=JSON.parse(result.err.content[0].text).error;
  assert.equal(error.code,terminal?'CHECKOUT_ATTEMPT_RETIRED':'CHECKOUT_OUTCOME_UNKNOWN');
  if(terminal)assert.deepEqual(error.detail,{reason:'ucp_reap_attempt_retired',reconciliation_id:first});
  assert.ok(ctx.backend.calls.every(c=>c.path.endsWith('/recover')));
  assert.equal(ctx.executor.seen.length,0);
});

for (const [label,body,expected] of [
  ['valid',{recovery_status:'retired',reconciliation_id:'a'.repeat(32)},'retired'],
  ['missing id',{recovery_status:'retired'},'unavailable'],
  ['wrong id',{recovery_status:'retired',reconciliation_id:'bad'},'unavailable'],
  ['extra purchase',{recovery_status:'retired',reconciliation_id:'a'.repeat(32),id:PID},'unavailable'],
  ['extra field',{recovery_status:'retired',reconciliation_id:'a'.repeat(32),extra:true},'unavailable'],
])test(`recovery client typed receipt ${label}`,async()=>{
  const client=createReapAgenticPurchaseClient({baseUrl:'https://backend.example',authHeaders:()=>({'X-API-Key':API_KEY,'X-Agent-User-JWT':USER_JWT}),fetchImpl:async()=>({status:200,text:async()=>JSON.stringify(body)})});
  assert.equal((await client.recoverPurchase({idempotency_key:'original-key'})).kind,expected);
});


// The UI uses this same captured wire fixture, not a synthetic resolvingCheckout builder.
test('fresh backend202 preserves authoritative facts through real client/lane/UCP mapping', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-29T10:00:00Z'));
  const backend = fakeBackend();
  backend.state.post.body.checkout_dispatch_state = 'not_dispatched';
  backend.state.post.body.contact_reentry_required = false;
  const ctx = await createReap(ON, { backend });
  assert.deepEqual(ctx.out, require('./fixtures/reap-accepted-continuation.json'));
  assert.equal(ctx.backend.calls.filter(call => call.method === 'POST').length, 1);
});
for (const dispatch of [undefined, 'invalid', 'dispatch_started', 'dispatched', 'unknown']) {
  test(`accepted backend202 ${dispatch} never invents no-dispatch`, async () => {
    const backend = fakeBackend();
    if (dispatch !== undefined) backend.state.post.body.checkout_dispatch_state = dispatch;
    backend.state.post.body.contact_reentry_required = 'false';
    const ctx = await createReap(ON, { backend });
    assert.equal(message(ctx.out, 'reap.checkout_dispatch_state').content,
      ['dispatch_started', 'dispatched', 'unknown'].includes(dispatch) ? dispatch : 'unknown');
    assert.equal(message(ctx.out, 'reap.contact_reentry_required'), undefined);
  });
}
