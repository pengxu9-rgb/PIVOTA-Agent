// The native door's route to the storefront path (mcpStorefrontCart.js), at the tool surface: what only a
// surface-level test can pin. The real doors are driven in tests/mcp_storefront_cart_door.node.test.cjs.
//
// Pinned here:
//   - the `/mcp` view: off, every call and tools/list is the wrapped surface's own, argument for argument; on, only
//     the checkout tools are marked for the path, and nothing a caller passes can mark a call;
//   - the option is honoured on the native dialect only: the UCP projection neither forwards nor reads it;
//   - a CONNECTED merchant's cart goes to the kernel even when its product read looks like a storefront row;
//   - a read that fails, a seller that does not match, and the escalation's own switch off all leave the call on
//     the path it took before;
//   - the schema tools/list publishes is the schema the door enforces.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCommerceToolSurface, ucpDialectSurface, commerceToolDefinitions } from '../src/commerceToolSurface.js';
import {
  MCP_STOREFRONT_ESCALATION_FLAG,
  NATIVE_STOREFRONT_STATUS,
  mcpStorefrontCartSurface,
  mcpStorefrontEscalationEnabled,
  storefrontCartInputSchema,
  storefrontCartToolDefinition,
  storefrontMarketProblem,
  toNativeStorefrontCheckout,
} from '../src/mcpStorefrontCart.js';
import { encodeEscalationId, UCP_ESCALATION_FLAG } from '../src/ucpCheckoutEscalation.js';
import { MERCHANT_PRICING_FLAG } from '../src/ucpMerchantDoorPricing.js';

const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
const SELLER = 'merch_obs_000000000000000a';
const OTHER_SELLER = 'merch_obs_000000000000000b';
const CONNECTED = 'merch_shop_a';
const SIG = `sig_${'a'.repeat(32)}`;
const SIG_CONNECTED = `sig_${'1'.repeat(32)}`;
const VARIANT = '44000000000001';
const GID = `gid://shopify/ProductVariant/${VARIANT}`;

const STOREFRONT_ROW = Object.freeze({
  product_id: SIG, merchant_id: SELLER, title: 'Calm Serum', price: 25, currency: 'USD',
  external_redirect_url: `https://store-a.example/products/calm-serum?variant=${VARIANT}`,
  destination_url: `https://store-a.example/products/calm-serum?variant=${VARIANT}`,
  variants: [{ variant_id: VARIANT }],
});
// A connected merchant's product whose read ALSO carries a storefront link (the backend stamps Pivota's own hop
// on a connected Shopify merchant's products): the row alone would classify as a storefront row.
const CONNECTED_ROW = Object.freeze({
  product_id: SIG_CONNECTED, merchant_id: CONNECTED, title: 'Day Lotion', price: 18, currency: 'USD',
  external_redirect_url: 'https://shop-a.example/products/day-lotion?variant=44000000000099',
  destination_url: 'https://shop-a.example/products/day-lotion?variant=44000000000099',
  variants: [{ variant_id: '44000000000099' }],
});

function executorWith({ rows = {}, readThrows = false } = {}) {
  const seen = [];
  return {
    seen,
    kernelCalls: () => seen.filter((s) => s.op !== 'get_product'),
    async execute(op, params) {
      seen.push({ op, params: structuredClone(params) });
      if (op === 'get_product') {
        if (readThrows) throw new Error('upstream down');
        const p = params.payload.product;
        const row = rows[p.product_id];
        return row ? { product: structuredClone(row) } : { product: null };
      }
      if (op === 'cancel_checkout_session') return { session_id: params.session_id, status: 'canceled' };
      return { session_id: 'q_kernel', status: 'ready_for_payment' };
    },
  };
}

// A seller door that prices every cart it is asked for, and records what it was asked.
function sellerDoor() {
  const calls = [];
  return {
    calls,
    endpointFor: async () => 'https://store-a.example/api/ucp/mcp',
    createCart: async (_endpoint, args) => {
      calls.push({ tool: 'create_cart', args });
      const line = args.lineItems[0];
      return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify({
        id: 'cart_0001', currency: 'USD', continue_url: 'https://store-a.example/cart/c/cart_0001',
        line_items: [{ item: { id: line.item.id, title: 'Store item', price: 2750 }, quantity: line.quantity }],
        totals: [{ type: 'subtotal', amount: 2750 * line.quantity }, { type: 'total', amount: 2750 * line.quantity }],
      }) }] } } };
    },
    getCart: async (_endpoint, cartId) => { calls.push({ tool: 'get_cart', cartId }); return { ok: false, status: 404 }; },
    catalogShopifyVariantCount: async () => 1,
  };
}

const createArgs = (merchant_id, product_id, extra = {}) => ({
  idempotency_key: 'idem-native-0001',
  quote: { merchant_id, items: [{ product_id, quantity: 1 }], customer_email: 'buyer@example.test' },
  ...extra,
});
const ON = Object.freeze({ storefrontCartDoor: true });
const rejected = (p) => p.then(() => null, (e) => e);

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ARMED = Object.freeze({ [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1', MERCHANT_PURCHASABILITY_GATE_ENABLED: undefined });

// ---- the flag ---------------------------------------------------------------------------------------------------

test('the flag is off unless set to an on value, and is read per call', () => {
  assert.equal(MCP_STOREFRONT_ESCALATION_FLAG, 'AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED');
  for (const v of [undefined, '', '0', 'false', 'off', 'no', ' ']) assert.equal(mcpStorefrontEscalationEnabled({ [MCP_STOREFRONT_ESCALATION_FLAG]: v }), false, String(v));
  for (const v of ['1', 'true', 'on', 'yes', 'enabled', ' 1 ']) assert.equal(mcpStorefrontEscalationEnabled({ [MCP_STOREFRONT_ESCALATION_FLAG]: v }), true, v);
  assert.equal(mcpStorefrontEscalationEnabled({}), false);
});

// ---- the view ---------------------------------------------------------------------------------------------------

function recordingSurface() {
  const calls = [];
  const tools = commerceToolDefinitions.map((t) => ({ ...t }));
  return { calls, tools, isCommerceTool: () => true, callTool: (...args) => { calls.push(args); return Promise.resolve('answer'); } };
}

test('view off: tools/list is the surface\'s own array and every call passes through with exactly its arguments', async () => {
  const inner = recordingSurface();
  const view = mcpStorefrontCartSurface(inner, { enabled: () => false });
  assert.equal(view.tools, inner.tools);
  assert.equal(view.isCommerceTool, inner.isCommerceTool);
  const observe = () => {};
  assert.equal(await view.callTool('create_checkout_session', { a: 1 }, SESSION), 'answer');
  await view.callTool('get_checkout_session', { session_id: 'esc_x' }, SESSION, { observe });
  await view.callTool('search_catalog', { query: 'q' });
  assert.deepEqual(inner.calls.map((c) => c.length), [3, 4, 2]);
  assert.deepEqual(inner.calls[0], ['create_checkout_session', { a: 1 }, SESSION]);
  assert.deepEqual(inner.calls[1], ['get_checkout_session', { session_id: 'esc_x' }, SESSION, { observe }]);
  assert.equal(inner.calls.some((c) => c[3] && c[3].storefrontCartDoor !== undefined), false);
});

test('view on: only the checkout tools are marked; the caller\'s observe option is kept; read tools pass through untouched', async () => {
  const inner = recordingSurface();
  const view = mcpStorefrontCartSurface(inner, { enabled: () => true });
  const observe = () => {};
  for (const name of ['create_checkout_session', 'get_checkout_session', 'update_checkout_session', 'complete_checkout_session', 'cancel_checkout_session', 'create_payment_link']) {
    await view.callTool(name, { x: 1 }, SESSION, { observe });
  }
  await view.callTool('create_checkout_session', { x: 1 }, SESSION);
  for (const name of ['search_catalog', 'get_product', 'get_offers', 'get_order', 'request_after_sales', 'recommend_products']) {
    await view.callTool(name, { x: 1 }, SESSION, { observe });
  }
  const marked = inner.calls.filter((c) => c[3] && c[3].storefrontCartDoor === true);
  assert.equal(marked.length, 7);
  assert.equal(marked.slice(0, 6).every((c) => c[3].observe === observe), true);
  assert.deepEqual(inner.calls.slice(7).map((c) => c[3]), Array(6).fill({ observe }));
});

test('the view reads its switch per call: one view object follows the flag', async () => {
  const inner = recordingSurface();
  const view = mcpStorefrontCartSurface(inner);
  await withEnv({ [MCP_STOREFRONT_ESCALATION_FLAG]: undefined }, async () => {
    await view.callTool('create_checkout_session', {}, SESSION);
    assert.equal(view.tools, inner.tools);
  });
  await withEnv({ [MCP_STOREFRONT_ESCALATION_FLAG]: '1' }, async () => {
    await view.callTool('create_checkout_session', {}, SESSION);
    assert.notEqual(view.tools, inner.tools);
  });
  assert.deepEqual(inner.calls.map((c) => Boolean(c[3] && c[3].storefrontCartDoor)), [false, true]);
});

test('view on: the declarations change for the six checkout tools only, and create\'s schema is the one the door enforces', () => {
  const inner = recordingSurface();
  const on = mcpStorefrontCartSurface(inner, { enabled: () => true }).tools;
  const changed = on.filter((t, i) => JSON.stringify(t) !== JSON.stringify(inner.tools[i])).map((t) => t.name).sort();
  assert.deepEqual(changed, ['cancel_checkout_session', 'complete_checkout_session', 'create_checkout_session', 'create_payment_link', 'get_checkout_session', 'update_checkout_session']);
  const base = commerceToolDefinitions.find((t) => t.name === 'create_checkout_session');
  const published = on.find((t) => t.name === 'create_checkout_session').inputSchema;
  assert.equal(published, storefrontCartInputSchema('create_checkout_session', base.inputSchema), 'one schema object: published == enforced');
  assert.deepEqual(Object.keys(published.properties), ['idempotency_key', 'quote', 'market']);
  assert.equal(published.additionalProperties, false);
  assert.deepEqual(base.inputSchema.properties.market, undefined, 'the base schema is not edited');
  // Other tools' schemas are never touched.
  assert.equal(storefrontCartInputSchema('update_checkout_session', base.inputSchema), base.inputSchema);
  assert.equal(storefrontCartToolDefinition(inner.tools[0]), inner.tools[0]);
});

// ---- the surface: who can take the path -------------------------------------------------------------------------

test('without the option a native create for a storefront seller never reaches a store, whatever the flags', async () => {
  await withEnv({ ...ARMED, [MCP_STOREFRONT_ESCALATION_FLAG]: '1' }, async () => {
    const executor = executorWith({ rows: { [SIG]: STOREFRONT_ROW } });
    const door = sellerDoor();
    const surface = createCommerceToolSurface(executor, { cache: false, merchantDoor: door });
    const out = await surface.callTool('create_checkout_session', createArgs(SELLER, SIG), SESSION);
    assert.equal(out.session_id, 'q_kernel');
    assert.deepEqual(door.calls, []);
    // `market` is not an argument without the option.
    const err = await rejected(surface.callTool('create_checkout_session', createArgs(SELLER, SIG, { market: 'US' }), SESSION));
    assert.equal(err.code, 'INVALID_ARGUMENTS');
    // An option that is not exactly `true` marks nothing.
    for (const value of ['1', 1, 'true', {}]) {
      const o = await surface.callTool('create_checkout_session', createArgs(SELLER, SIG), SESSION, { storefrontCartDoor: value });
      assert.equal(o.session_id, 'q_kernel', String(value));
    }
    assert.deepEqual(door.calls, []);
  });
});

test('with the option: the seller\'s cart, in the native shape', async () => {
  await withEnv(ARMED, async () => {
    const executor = executorWith({ rows: { [SIG]: STOREFRONT_ROW } });
    const door = sellerDoor();
    const surface = createCommerceToolSurface(executor, { cache: false, merchantDoor: door });
    const out = await surface.callTool('create_checkout_session', createArgs(SELLER, SIG, { market: 'US' }), SESSION, ON);
    assert.equal(out.status, NATIVE_STOREFRONT_STATUS);
    assert.match(out.session_id, /^esc_/);
    assert.equal(out.continue_url, 'https://store-a.example/cart/c/cart_0001');
    assert.deepEqual(out.messages.map((m) => m.code), ['checkout.priced_by_seller_storefront']);
    assert.deepEqual(door.calls, [{ tool: 'create_cart', args: { lineItems: [{ item: { id: GID }, quantity: 1 }], context: { address_country: 'US' } } }]);
    assert.deepEqual(executor.kernelCalls(), [], 'no quote, no kernel');
  });
});

test('the option is native-only: the UCP dialect ignores it, and the UCP projection never forwards it', async () => {
  await withEnv(ARMED, async () => {
    const ucpArgs = { meta: { 'ucp-agent': { profile: 'https://agent.example/p' }, 'idempotency-key': 'idem-ucp-0001' }, checkout: { line_items: [{ item: { id: SIG }, quantity: 1 }], context: { address_country: 'US' } } };
    const answers = [];
    for (const options of [{ dialect: 'ucp' }, { dialect: 'ucp', storefrontCartDoor: true }]) {
      const surface = createCommerceToolSurface(executorWith({ rows: { [SIG]: STOREFRONT_ROW } }), { cache: false, merchantDoor: sellerDoor() });
      const out = await surface.callTool('create_checkout', ucpArgs, SESSION, options);
      answers.push(JSON.stringify({ ...out, expires_at: null }));
      assert.equal(out.status, 'requires_escalation');
      assert.equal(out.ucp.version, '2026-04-08');
    }
    assert.equal(answers[0], answers[1]);
    // The projection forwards `observe` and nothing else of the caller's options.
    const seen = [];
    const projected = ucpDialectSurface({ tools: [], isCommerceTool: () => true, callTool: async (...args) => { seen.push(args[3]); return {}; } });
    await projected.callTool('create_checkout', ucpArgs, SESSION, { storefrontCartDoor: true, observe: undefined });
    assert.deepEqual(seen, [{ dialect: 'ucp' }]);
  });
});

test('a CONNECTED merchant\'s cart goes to the kernel even when its product read carries a storefront link', async () => {
  await withEnv(ARMED, async () => {
    const calls = [];
    for (const options of [undefined, ON]) {
      const executor = executorWith({ rows: { [SIG_CONNECTED]: CONNECTED_ROW } });
      const door = sellerDoor();
      const surface = createCommerceToolSurface(executor, { cache: false, merchantDoor: door });
      const args = [ 'create_checkout_session', createArgs(CONNECTED, SIG_CONNECTED), SESSION ];
      const out = await surface.callTool(...args, ...(options ? [options] : []));
      assert.equal(out.session_id, 'q_kernel');
      assert.deepEqual(door.calls, []);
      calls.push(JSON.stringify(executor.seen));
    }
    assert.equal(calls[0], calls[1], 'the same reads and the same kernel call, in the same order');
  });
});

test('a seller that is not the row\'s, a read that fails, and a cart with no storefront row are answered exactly as without the option', async () => {
  await withEnv(ARMED, async () => {
    const cases = [
      ['another observed seller named', () => executorWith({ rows: { [SIG]: STOREFRONT_ROW } }), createArgs(OTHER_SELLER, SIG)],
      ['the read fails', () => executorWith({ readThrows: true }), createArgs(SELLER, SIG)],
      // With the variant named, the kernel path needs no read at all: a read this path cannot make must not
      // become a refusal the call never had.
      ['the read fails, variant named', () => executorWith({ readThrows: true }), { ...createArgs(SELLER, SIG), quote: { ...createArgs(SELLER, SIG).quote, items: [{ product_id: SIG, quantity: 1, variant_id: VARIANT }] } }],
      ['no storefront row', () => executorWith({ rows: { [SIG]: { ...STOREFRONT_ROW, external_redirect_url: undefined } } }), createArgs(SELLER, SIG)],
      ['a row that declares internal checkout', () => executorWith({ rows: { [SIG]: { ...STOREFRONT_ROW, purchase_route: 'internal_checkout' } } }), createArgs(SELLER, SIG)],
    ];
    const outcomeOf = async (executor, door, args, options) => {
      const surface = createCommerceToolSurface(executor, { cache: false, merchantDoor: door });
      const out = await surface.callTool('create_checkout_session', args, SESSION, ...(options ? [options] : [])).catch((e) => e);
      return out instanceof Error
        ? { error: out.constructor.name, code: out.code, reason: out.detail && out.detail.acp_detail && out.detail.acp_detail.reason, message: out.message }
        : { answer: out };
    };
    for (const [label, makeExecutor, args] of cases) {
      const [plainExecutor, plainDoor] = [makeExecutor(), sellerDoor()];
      const [markedExecutor, markedDoor] = [makeExecutor(), sellerDoor()];
      const plain = await outcomeOf(plainExecutor, plainDoor, args);
      const marked = await outcomeOf(markedExecutor, markedDoor, args, ON);
      assert.deepEqual(marked, plain, label);
      assert.deepEqual([plainDoor.calls, markedDoor.calls], [[], []], label);
      assert.deepEqual(markedExecutor.kernelCalls(), plainExecutor.kernelCalls(), label);
      assert.notEqual(marked.answer && marked.answer.status, NATIVE_STOREFRONT_STATUS, label);
    }
  });
});

test('the escalation\'s own switch off: a create continues to the kernel, and an esc_ id is refused by name', async () => {
  await withEnv({ ...ARMED, [UCP_ESCALATION_FLAG]: undefined }, async () => {
    const executor = executorWith({ rows: { [SIG]: STOREFRONT_ROW } });
    const door = sellerDoor();
    const surface = createCommerceToolSurface(executor, { cache: false, merchantDoor: door });
    const out = await surface.callTool('create_checkout_session', createArgs(SELLER, SIG, { market: 'US' }), SESSION, ON);
    assert.equal(out.session_id, 'q_kernel');
    assert.deepEqual(door.calls, []);
    const id = encodeEscalationId([{ product_id: SIG, quantity: 1 }], undefined, undefined, { code: 'US', assumed: false });
    const err = await rejected(surface.callTool('get_checkout_session', { session_id: id }, SESSION, ON));
    assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
    assert.equal(err.detail.acp_detail.reason, 'ucp_storefront_checkout_unavailable');
  });
});

test('no verified buyer: refused before the path is entered, on every checkout tool', async () => {
  await withEnv(ARMED, async () => {
    const id = encodeEscalationId([{ product_id: SIG, quantity: 1 }], undefined, undefined, { code: 'US', assumed: false });
    const calls = [
      ['create_checkout_session', createArgs(SELLER, SIG, { market: 'US' })],
      ['get_checkout_session', { session_id: id }],
      ['update_checkout_session', { ...createArgs(SELLER, SIG), session_id: id }],
      ['complete_checkout_session', { idempotency_key: 'idem-native-0002', session_id: id, payment_authorization: {} }],
      ['cancel_checkout_session', { idempotency_key: 'idem-native-0003', session_id: id }],
      ['create_payment_link', { idempotency_key: 'idem-native-0004', session_id: id, customer_email: 'buyer@example.test' }],
    ];
    for (const session of [{}, { user_ref: 'buyer_1' }, { acp_session_id: 'sess_1' }]) {
      for (const [name, args] of calls) {
        const executor = executorWith({ rows: { [SIG]: STOREFRONT_ROW } });
        const door = sellerDoor();
        const err = await rejected(createCommerceToolSurface(executor, { cache: false, merchantDoor: door }).callTool(name, args, session, ON));
        assert.equal(err && err.code, 'USER_AUTH_REQUIRED', `${name} ${JSON.stringify(session)}`);
        assert.deepEqual([executor.seen, door.calls], [[], []], name);
      }
    }
  });
});

test('a create decided for an assumed market is counted, as the read tools\' are', async () => {
  await withEnv(ARMED, async () => {
    const notes = [];
    const surface = createCommerceToolSurface(executorWith({ rows: { [SIG]: STOREFRONT_ROW } }), { cache: false, merchantDoor: sellerDoor() });
    const out = await surface.callTool('create_checkout_session', createArgs(SELLER, SIG), SESSION, { ...ON, observe: (fields) => notes.push(fields) });
    assert.equal(out.market_assumed.code, 'US');
    assert.equal(notes.some((n) => n && n.market_assumed === true), true);
    const named = [];
    await surface.callTool('create_checkout_session', createArgs(SELLER, SIG, { market: 'US' }), SESSION, { ...ON, observe: (fields) => named.push(fields) });
    assert.equal(named.some((n) => n && n.market_assumed === true), false);
  });
});

// ---- the pure pieces ---------------------------------------------------------------------------------------------

test('storefrontMarketProblem: unnamed is fine, a two-letter code is fine, anything else is a problem', () => {
  for (const ok of [undefined, null, '', '  ', 'US', 'us', ' gb ']) assert.equal(storefrontMarketProblem(ok), null, String(ok));
  for (const bad of ['USA', 'U', 'U1', 'United States', 12, true, {}, ['US']]) assert.match(String(storefrontMarketProblem(bad)), /ISO 3166-1 alpha-2/, String(bad));
});

test('toNativeStorefrontCheckout copies the escalation\'s members and names each line\'s product', () => {
  const id = encodeEscalationId([{ product_id: SIG, quantity: 2 }, { product_id: 'sig_b', quantity: 1, variant_id: 'v9' }], 'cart_1', 'store-a.example', { code: 'US', assumed: false });
  const checkout = {
    ucp: { version: '2026-04-08', status: 'success', payment_handlers: {} },
    id, status: 'requires_escalation', continue_url: 'https://store-a.example/cart/c/cart_1', currency: 'USD',
    line_items: [{ id: 'li_1', item: { id: SIG, title: 'A', price: 100 }, quantity: 2, totals: [] }, { id: 'li_2', item: { id: 'sig_b::v::v9', title: 'B', price: 50 }, quantity: 1, totals: [] }],
    totals: [{ type: 'subtotal', amount: 250 }, { type: 'total', amount: 250 }],
    links: [{ type: 'terms_of_service', url: 'https://example.test/terms' }],
    expires_at: '2030-01-01T00:00:00.000Z',
    messages: [{ type: 'info', code: 'checkout.priced_by_seller_storefront', path: '$.continue_url', content: 'x', content_type: 'plain' }],
  };
  const out = toNativeStorefrontCheckout(checkout);
  assert.deepEqual(Object.keys(out), ['session_id', 'status', 'currency', 'amount_unit', 'line_items', 'totals', 'continue_url', 'links', 'expires_at', 'messages']);
  assert.equal(out.session_id, id);
  assert.equal(out.status, 'completes_on_seller_storefront');
  assert.equal(out.amount_unit, 'minor');
  assert.equal(out.continue_url, checkout.continue_url);
  assert.equal(out.totals, checkout.totals);
  assert.deepEqual(out.messages, checkout.messages);
  assert.deepEqual(out.line_items.map((l) => [l.id, l.product_id, l.variant_id]), [['li_1', SIG, undefined], ['li_2', 'sig_b', 'v9']]);
  assert.equal(checkout.line_items[0].product_id, undefined, 'the escalation\'s own object is not edited');
  const withCodes = toNativeStorefrontCheckout(checkout, { discountCodesNotSent: true });
  assert.deepEqual(withCodes.messages.map((m) => m.code), ['checkout.priced_by_seller_storefront', 'discount_code_not_evaluated']);
  assert.equal(checkout.messages.length, 1);
});
