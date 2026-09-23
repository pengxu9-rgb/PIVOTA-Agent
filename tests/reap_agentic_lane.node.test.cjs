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
function createArgs({ productId = REAP_ROW.product_id, quantity = 1, key = 'idem-reap-0001', consent = 'reap-agentic-v1', destination = DESTINATION, buyerExtra = {} } = {}) {
  const buyer = { email: EMAIL, ...buyerExtra };
  if (consent !== ABSENT) buyer.consent_version = consent;
  return {
    meta: { 'ucp-agent': { profile: 'https://minds.example/.well-known/ucp-agent' }, 'idempotency-key': key },
    checkout: {
      line_items: [{ item: { id: productId }, quantity }],
      buyer,
      context: { address_country: 'US' },
      ...(destination ? { fulfillment: { methods: [{ type: 'shipping', destinations: [{ ...destination }] }] } } : {}),
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
const QUOTED = { currency: 'USD', our_price_minor: 4250, quoted_total_minor: 4500, final_total_minor: null, shipping_minor: 100, tax_minor: 150 };
const FINAL = { ...QUOTED, final_total_minor: 4500 };

function houseError(code, status) {
  return {
    status: 'error',
    error: { code: status === 404 ? 'PRODUCT_NOT_FOUND' : 'CONFLICT', message: code, details: { error: code } },
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
    if (init.method === 'POST') r = state.post;
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

function recordingExecutor(rows, errors) {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params });
      if (op === 'get_product') {
        const row = rows[params.payload.product.product_id];
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

async function build({ lane = true, logger = fakeLogger(), backend = fakeBackend(), clientTimeoutMs, authHeaders = FULL_AUTH } = {}) {
  const m = await mods();
  m.lane.resetReapLaneLogOnceForTest();
  const executor = recordingExecutor(ROWS, m.errors);
  const client = createReapAgenticPurchaseClient({
    baseUrl: 'https://backend.example',
    fetchImpl: backend.fetchImpl,
    authHeaders,
    logger,
    ...(clientTimeoutMs ? { timeoutMs: clientTimeoutMs } : {}),
  });
  const native = m.surface.createCommerceToolSurface(executor, {
    cache: false,
    log: logger,
    ...(lane ? { reapAgentic: { client } } : {}),
  });
  const ucp = m.surface.ucpDialectSurface(native);
  return { ucp, executor, backend, logger, client, m };
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
  assert.deepEqual(kernel, { session_id: 'q_kernel' });
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
  assert.equal(JSON.parse(got.err.content[0].text).error.code, 'QUOTE_NOT_FOUND');
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

test('get_checkout: the completed checkout carries the order reference and the charged total', async () => {
  const backend = fakeBackend();
  backend.state.get.set(PID, { status: 200, body: view('completed', { totals: FINAL, order_reference: 'ord_991', poll_after_seconds: null }) });
  const ctx = await build({ backend });
  const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
  const out = keep(await withEnv(ON, () => ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
  assert.equal(message(out, 'reap.order_reference').content, 'ord_991');
  assert.deepEqual(out.totals.map((x) => [x.type, x.amount]), [['subtotal', 4250], ['total', 4500]]);
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
  assert.deepEqual(kernelGets, [`reap_${PID}`, 'q_never_minted']);
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

for (const [label, arrange] of [
  ['409 merchant_not_eligible', (b) => { b.state.post = { status: 409, body: houseError('merchant_not_eligible', 409) }; }],
  ['404 not_available_on_this_rail', (b) => { b.state.post = { status: 404, body: houseError('not_available_on_this_rail', 404) }; }],
  ['409 row_not_found', (b) => { b.state.post = { status: 409, body: houseError('row_not_found', 409) }; }],
  ['409 idempotency_conflict', (b) => { b.state.post = { status: 409, body: houseError('idempotency_conflict', 409) }; }],
  ['401 agent_user_required', (b) => { b.state.post = { status: 401, body: houseError('agent_user_required', 401) }; }],
  ['400 currency_unsupported', (b) => { b.state.post = { status: 400, body: houseError('currency_unsupported', 400) }; }],
  ['500', (b) => { b.state.post = { status: 500, body: {} }; }],
  ['timeout', (b) => { b.state.mode = 'hang'; }],
  ['202 without a purchase id', (b) => { b.state.post = { status: 202, body: { status: 'resolving' } }; }],
]) {
  test(`create_checkout: backend ${label} -> falls through to storefront escalation (on) / the kernel (off)`, { timeout: 5000 }, async () => {
    const backend = fakeBackend();
    arrange(backend);
    const logger = fakeLogger();
    const esc = await createReap({ ...ON, [ESCALATION_FLAG]: '1' }, { backend, logger, clientTimeoutMs: 60 });
    assert.equal(esc.out.status, 'requires_escalation');
    assert.match(esc.out.id, /^esc_/);
    assert.equal(esc.out.continue_url, REAP_ROW.external_redirect_url);
    assert.equal(backend.calls.length, 1, 'one POST, no retry');
    assert.equal(esc.executor.seen.filter((c) => c.op === 'get_product').length, 1, 'both lanes judged ONE read');

    backend.calls.length = 0;
    const kernel = await createReap(ON, { backend, logger, clientTimeoutMs: 60 });
    assert.deepEqual(kernel.out, { session_id: 'q_kernel' });
    assert.ok(kernel.executor.seen.some((c) => c.op === 'create_checkout_session'));
    ALL_LOGS.push(...logger.lines);
    const laneLines = logger.lines.filter((l) => l.event === 'reap_agentic_lane' && l.op === 'create_checkout_session');
    assert.ok(laneLines.length >= 1, 'the fall-through is logged');
    for (const line of laneLines) assert.deepEqual(Object.keys(line).sort(), ['code', 'event', 'level', 'msg', 'op', 'outcome'].sort(), 'codes only');
  });
}

test('create_checkout: the refusal code is what gets logged — and only the code', async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 409, body: houseError('row_not_found', 409) };
  const logger = fakeLogger();
  await createReap(ON, { backend, logger });
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

for (const [label, post, args] of [
  ['non-eligible merchant, no consent (backend checks consent BEFORE eligibility -> 400 consent_required)', { status: 400, body: houseError('consent_required', 400) }, { consent: ABSENT }],
  ['eligible merchant, no consent (400 consent_required)', { status: 400, body: houseError('consent_required', 400) }, { consent: ABSENT }],
  ['no last name (400 invalid_address)', { status: 400, body: houseError('invalid_address', 400) }, { destination: { ...DESTINATION, last_name: undefined } }],
  ['no phone anywhere (400 invalid_address)', { status: 400, body: houseError('invalid_address', 400) }, { destination: { ...DESTINATION, phone_number: undefined } }],
  ['no destination at all (400 invalid_request)', { status: 400, body: houseError('invalid_request', 400) }, { destination: null }],
]) {
  test(`create_checkout: ${label} -> NEVER a refusal: today's storefront answer, byte for byte, PLUS one constant ${HINT} message`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const backend = fakeBackend();
    backend.state.post = post;
    const ctx = await build({ backend });
    const out = keep(await withEnv({ ...ON, [ESCALATION_FLAG]: '1' }, () => ctx.ucp.callTool('create_checkout', createArgs(args), SESSION)));
    const baseline = await storefrontBaseline(createArgs(args));
    assert.equal(backend.calls.length, 1, 'the rail was asked');
    assert.equal(out.status, 'requires_escalation');
    const hinted = out.messages.filter((msg) => msg.code === HINT);
    assert.equal(hinted.length, 1, 'exactly one hint');
    assert.deepEqual(hinted[0], ctx.m.lane.REAP_AVAILABLE_WITH_CONSENT_MESSAGE, 'the CONSTANT message, nothing request- or backend-derived');
    for (const path of ['checkout.buyer.consent_version', 'checkout.fulfillment.methods[0].destinations[0].last_name', 'checkout.fulfillment.methods[0].destinations[0].phone_number']) {
      assert.ok(hinted[0].content.includes(path), path);
    }
    const withoutHint = { ...out, messages: out.messages.filter((msg) => msg.code !== HINT) };
    assert.equal(JSON.stringify(withoutHint), JSON.stringify(baseline), "everything else is today's answer, byte for byte");
  });
}

for (const [label, post, args] of [
  ['400 invalid_return_url', { status: 400, body: houseError('invalid_return_url', 400) }, {}],
  ['400 invalid_request with COMPLETE buyer details (a malformed id / a catalog defect, not the buyer)', { status: 400, body: houseError('invalid_request', 400) }, {}],
  ['400 invalid_address with a complete destination', { status: 400, body: houseError('invalid_address', 400) }, {}],
  ['400 currency_unsupported', { status: 400, body: houseError('currency_unsupported', 400) }, {}],
]) {
  test(`create_checkout: ${label} -> falls through with NO message, logged by code only`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const backend = fakeBackend();
    backend.state.post = post;
    const logger = fakeLogger();
    const ctx = await build({ backend, logger });
    const out = keep(await withEnv({ ...ON, [ESCALATION_FLAG]: '1' }, () => ctx.ucp.callTool('create_checkout', createArgs(args), SESSION)));
    assert.equal(JSON.stringify(out), JSON.stringify(await storefrontBaseline(createArgs(args))), "exactly today's answer");
    const line = logger.lines.find((l) => l.event === 'reap_agentic_lane' && l.outcome === 'refused');
    assert.equal(line.code, post.body.detail.error);
    ALL_LOGS.push(...logger.lines);
  });
}

test('escalation OFF: a short buyer block still never refuses — the kernel path answers as today (the hint has nowhere to ride)', async () => {
  const backend = fakeBackend();
  backend.state.post = { status: 400, body: houseError('consent_required', 400) };
  const ctx = await build({ backend });
  const out = keep(await withEnv(ON, () => ctx.ucp.callTool('create_checkout', createArgs({ consent: ABSENT }), SESSION)));
  assert.deepEqual(out, { session_id: 'q_kernel' });
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
    const r = await withEnv({ ...ON, [ESCALATION_FLAG]: escalation }, () => outcome(ctx.m, ctx.ucp.callTool('create_checkout', createArgs({ consent: ABSENT }), SESSION)));
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

test('get_checkout from a caller the rail cannot serve SKIPS the lane: today\'s answer, no backend call, the id handed on untouched', async () => {
  for (const authHeaders of [() => ({ 'X-API-Key': API_KEY }), () => ({ 'X-API-Key': API_KEY, 'X-Agent-User-JWT': '  ' }), () => ({})]) {
    const backend = fakeBackend();
    const ctx = await build({ backend, authHeaders });
    const id = ctx.m.lane.encodeReapCheckoutId({ purchaseId: PID, productId: REAP_ROW.product_id, productKey: REAP_ROW.product_key, quantity: 1, currency: 'USD', unitMinor: 4250 });
    const withLane = keep(await withEnv(ON, () => outcome(ctx.m, ctx.ucp.callTool('get_checkout', { meta: META, id }, SESSION))));
    const noLane = await build({ lane: false });
    const today = await withEnv(ON, () => outcome(noLane.m, noLane.ucp.callTool('get_checkout', { meta: META, id }, SESSION)));
    assert.equal(JSON.stringify(withLane), JSON.stringify(today));
    assert.equal(backend.calls.length, 0);
    assert.deepEqual(ctx.executor.seen.filter((c) => c.op === 'get_checkout_session').map((c) => c.params.session_id), [id], 'not rewritten — the lane did not act');
  }
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
      const out = keep(await withEnv({ ...ON, [ESCALATION_FLAG]: '1' }, () => ctx.ucp.callTool('create_checkout', createArgs({ consent: ABSENT }), SESSION)));
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
  const out = keep(await withEnv({ ...ON, [ESCALATION_FLAG]: '1' }, () => ctx.ucp.callTool('create_checkout', createArgs({ productId: NATIVE_ROW.product_id, consent: ABSENT }), SESSION)));
  assert.deepEqual(out, { session_id: 'q_kernel' });
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
      ctx: SESSION, executor, ucpArgs: createArgs(), client: ctx.client, env, shouldOfferPurchase,
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
    assert.equal(JSON.stringify(r), JSON.stringify(plainUnknown), `malformed id ${id.slice(0, 60)}`);
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
