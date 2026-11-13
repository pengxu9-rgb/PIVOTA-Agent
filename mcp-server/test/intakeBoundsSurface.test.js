// THE TWO SHARED BOUNDS AT THE TOOL SURFACE (both dialects) AND ON THE STOREFRONT-CART PATH.
//
// The surface refuses a short idempotency key and a line above 999 units on the request alone, so the refusal must
// come BEFORE every read the surface would otherwise make: the variant proof, the storefront cart's product reads
// (and, behind them, its purchasability gate and the seller's own door), intake's default-variant read and the
// kernel. The executor here is a recorder: a refused call that reaches it, for a read or for the operation itself,
// fails the test.
//
// Also pinned: the numbers the tool schemas publish are the runtime's own (imported, not restated), and the
// storefront-cart path holds no second ceiling: its guards fall through on intake's one definition of a quantity
// a door may act on, without reading anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDEMPOTENCY_KEY_LENGTH_SENTENCE,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  MAX_LINE_QUANTITY,
} from '../../safety-kernel/src/protocol/buyerIntake.js';
import { CANONICAL_OPERATIONS } from '../../safety-kernel/src/protocol/canonicalContract.js';
import {
  commerceToolDefinitions,
  createCommerceToolSurface,
  toToolError,
  ucpCommerceToolDefinitionsFor,
  ucpDialectSurface,
} from '../src/commerceToolSurface.js';
import { toolDefinitions as legacyToolDefinitions } from '../src/operationMap.js';
import { START_PURCHASE_INPUT_SCHEMA, START_PURCHASE_MAX_QUANTITY, startPurchaseArgumentProblems } from '../src/orchestratedPurchaseTool.js';
import { REAP_MAX_QUANTITY } from '../src/ucpReapAgenticLane.js';
import {
  refuseUnservedStorefrontCheckout,
  tryEscalateUcpCheckout,
  UCP_ESCALATION_FLAG,
} from '../src/ucpCheckoutEscalation.js';

const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
const UCP_META = { 'ucp-agent': { profile: 'https://agent.example/profile' } };
const rejected = (promise) => promise.then((value) => ({ answered: value }), (err) => err);

/** An executor that records every call. `rows`: what the product read answers per product id. */
function recorder(rows = {}) {
  const seen = [];
  return {
    seen,
    async execute(op, params, ctx) {
      seen.push({ op, params, ctx });
      if (op === 'get_product') {
        const row = rows[params.payload.product.product_id];
        return row ? { product: { ...row } } : { product: null };
      }
      return { session_id: 'q_kernel', status: 'ready_for_payment' };
    },
  };
}

// A product Pivota transacts (one real variant, no storefront link) and one that completes on its seller's storefront.
const CONTRACTED = Object.freeze({ product_id: 'p_shop_1', title: 'Day Lotion', price: 18, currency: 'USD', merchant_id: 'merch_shop_a', variants: [{ variant_id: 'v-9001-1' }] });
const STOREFRONT = Object.freeze({
  product_id: 'sig_store_a', title: 'Calm Serum', price: 25, currency: 'USD', merchant_id: 'merch_obs_000000000000000a',
  external_redirect_url: 'https://store-a.example/products/calm-serum?variant=44000000000001',
});
const ROWS = { [CONTRACTED.product_id]: CONTRACTED, [STOREFRONT.product_id]: STOREFRONT };

const nativeQuote = (quantity, product = CONTRACTED.product_id) => ({
  merchant_id: 'merch_shop_a', customer_email: 'buyer@example.test',
  items: [{ product_id: product, variant_id: 'v-9001-1', quantity }],
});
// The native tools that change state, with arguments that are otherwise acceptable.
const NATIVE_CALLS = {
  create_checkout_session: { quote: nativeQuote(1) },
  update_checkout_session: { session_id: 'q_1', quote: nativeQuote(1) },
  complete_checkout_session: { session_id: 'q_1', payment_authorization: { method: 'placeholder' } },
  create_payment_link: { session_id: 'q_1', customer_email: 'buyer@example.test' },
  cancel_checkout_session: { session_id: 'q_1' },
  request_after_sales: { status: { order_id: 'o_1', requested_action: 'refund' } },
};
const ucpCheckout = (quantity, product = CONTRACTED.product_id) => ({
  line_items: [{ item: { id: product }, quantity }],
  buyer: { email: 'buyer@example.test' },
  context: { address_country: 'US' },
});
const ucpCalls = (key) => {
  const meta = key === undefined ? UCP_META : { ...UCP_META, 'idempotency-key': key };
  return {
    create_checkout: { meta, checkout: ucpCheckout(1) },
    update_checkout: { meta, id: 'q_1', checkout: ucpCheckout(1) },
    complete_checkout: { meta, id: 'q_1', checkout: { payment: { method: 'ucp_handler', token: 'placeholder.grant.token' } } },
  };
};

function assertKeyTooShort(err, label) {
  assert.equal(err && err.code, 'IDEMPOTENCY_CONFLICT', `${label}: ${JSON.stringify(err && (err.answered ?? err.message))}`);
  assert.equal(err.retriable, false, `${label}: terminal`);
  const wire = JSON.parse(toToolError(err).content[0].text).error;
  assert.equal(wire.code, 'IDEMPOTENCY_CONFLICT', label);
  assert.equal(wire.retriable, false, label);
  assert.deepEqual(wire.detail, { reason: 'idempotency_key_too_short', min_length: 8 }, label);
  assert.match(wire.message, /at least 8 characters/, label);
}
// Keys with a character outside printable ASCII: wide, accented, invisible, control.
const BAD_CHARACTER_KEYS = ['\u{1F511}'.repeat(8), 'idem-\u00e9-0001', '\u4e00'.repeat(8), 'abcdefgh\u200b', '\u200b'.repeat(8), 'idem-0001\u00ad', 'idem\t0001', '\u{1F511}'];
function assertKeyBadCharacters(err, label) {
  assert.equal(err && err.code, 'IDEMPOTENCY_CONFLICT', `${label}: ${JSON.stringify(err && (err.answered ?? err.message))}`);
  assert.equal(err.retriable, false, `${label}: terminal`);
  const wire = JSON.parse(toToolError(err).content[0].text).error;
  assert.equal(wire.retriable, false, label);
  assert.deepEqual(wire.detail, { reason: 'idempotency_key_bad_characters', accepted_characters: 'printable ASCII, U+0020 to U+007E' }, label);
  assert.match(wire.message, /printable ASCII characters only/, label);
}
function assertQuantityAboveMaximum(err, label) {
  assert.equal(err && err.code, 'QUOTE_REQUIRED', `${label}: ${JSON.stringify(err && (err.answered ?? err.message))}`);
  assert.equal(err.retriable, false, `${label}: terminal`);
  const wire = JSON.parse(toToolError(err).content[0].text).error;
  assert.equal(wire.code, 'QUOTE_REQUIRED', label);
  assert.equal(wire.retriable, false, label);
  assert.deepEqual(wire.detail, { reason: 'quantity_above_line_maximum', max_quantity: 999 }, label);
  assert.match(wire.message, /at most 999 units per line/, label);
}

function withEscalation(fn) {
  const saved = process.env[UCP_ESCALATION_FLAG];
  process.env[UCP_ESCALATION_FLAG] = '1';
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env[UCP_ESCALATION_FLAG];
    else process.env[UCP_ESCALATION_FLAG] = saved;
  });
}

// ---- the key, native dialect ----------------------------------------------------------------------------------

test('the native cases below are every mutating tool the native dialect publishes', () => {
  const mutating = CANONICAL_OPERATIONS.filter((op) => op.mutating && op.mcp && !op.refusalOnly).map((op) => op.mcp);
  const published = new Set(commerceToolDefinitions.map((t) => t.name));
  assert.deepEqual(mutating.filter((name) => published.has(name)).sort(), Object.keys(NATIVE_CALLS).sort());
});

for (const [tool, args] of Object.entries(NATIVE_CALLS)) {
  test(`native ${tool}: a short key is refused by name with nothing read or executed; 8 characters are past the gate`, async () => {
    const executor = recorder(ROWS);
    const surface = createCommerceToolSurface(executor, { cache: false });
    for (const key of ['abcdefg', 'a', '       a', 'abc     ']) {
      assertKeyTooShort(await rejected(surface.callTool(tool, { idempotency_key: key, ...args }, SESSION)), `${tool} ${JSON.stringify(key)}`);
    }
    assert.deepEqual(executor.seen, [], 'the executor was never called');

    for (const key of ['abcdefgh', ' abcdefgh ', 'a b c d~', '0f8fad5b-d9cb-469f-a165-70867728950e']) {
      const out = await rejected(surface.callTool(tool, { idempotency_key: key, ...args }, SESSION));
      assert.notEqual(out && out.code, 'IDEMPOTENCY_CONFLICT', `${tool} ${JSON.stringify(key)}: past the key gate`);
    }
    assert.ok(executor.seen.some((c) => c.op === tool), 'the operation itself was executed');
    // The native door hands the key on exactly as it was sent.
    assert.equal(executor.seen.find((c) => c.op === tool && c.params.idempotency_key === ' abcdefgh ') !== undefined, true);
  });
}

test('native: an absent key is left to the rule that requires one, where it always was', async () => {
  const executor = recorder(ROWS);
  const surface = createCommerceToolSurface(executor, { cache: false });
  await surface.callTool('create_checkout_session', { quote: nativeQuote(1) }, SESSION);
  await surface.callTool('create_checkout_session', { idempotency_key: '   ', quote: nativeQuote(1) }, SESSION);
  // The surface passes both on; the canonical executor is what refuses a missing key (intakeBounds.test.js).
  assert.deepEqual(executor.seen.map((c) => [c.op, c.params.idempotency_key]), [
    ['create_checkout_session', undefined], ['create_checkout_session', '   '],
  ]);
});

// ---- the key, UCP dialect ---------------------------------------------------------------------------------------

for (const tool of ['create_checkout', 'update_checkout', 'complete_checkout']) {
  test(`UCP ${tool}: a short key is refused by name with nothing read or executed; 8 characters are past the gate`, async () => {
    await withEscalation(async () => {
      const executor = recorder(ROWS);
      const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
      // This door trims the key before using it, so padding never counts here either.
      for (const key of ['abcdefg', 'a', '  abcdefg  ', 'abc     ']) {
        assertKeyTooShort(await rejected(ucp.callTool(tool, ucpCalls(key)[tool], SESSION)), `${tool} ${JSON.stringify(key)}`);
      }
      assert.deepEqual(executor.seen, [], 'no product was read and nothing was executed');

      const out = await rejected(ucp.callTool(tool, ucpCalls('abcdefgh')[tool], SESSION));
      assert.notEqual(out && out.code, 'IDEMPOTENCY_CONFLICT', `${tool}: past the key gate`);
      assert.ok(executor.seen.length > 0, 'the door went on to its reads');
    });
  });
}

test('UCP: a short key on a cart that would become a storefront cart is refused before its first read', async () => {
  await withEscalation(async () => {
    const executor = recorder(ROWS);
    const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
    const args = { meta: { ...UCP_META, 'idempotency-key': 'abcdefg' }, checkout: ucpCheckout(1, STOREFRONT.product_id) };
    assertKeyTooShort(await rejected(ucp.callTool('create_checkout', args, SESSION)), 'storefront cart');
    assert.deepEqual(executor.seen, []);
  });
});

test('UCP: an absent key keeps the refusal this door always gave it', async () => {
  const executor = recorder(ROWS);
  const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
  for (const [tool, args] of Object.entries(ucpCalls(undefined))) {
    const err = await rejected(ucp.callTool(tool, args, SESSION));
    assert.equal(err.code, 'QUOTE_REQUIRED', tool);
    assert.equal(err.detail.reason, 'ucp_idempotency_key_required', tool);
  }
  assert.deepEqual(executor.seen, []);
});

test('the two vendor tools that continue an earlier create are not judged by the key rule', async () => {
  // They must present the ORIGINAL create's key, whatever its length was when that create was accepted.
  const executor = recorder(ROWS);
  const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
  const recover = await rejected(ucp.callTool('recover_checkout', { meta: { ...UCP_META, 'idempotency-key': 'abc' }, checkout: ucpCheckout(1) }, SESSION));
  assert.notEqual(recover.code, 'IDEMPOTENCY_CONFLICT', `recover: ${recover.code} ${recover.detail && recover.detail.reason}`);
  const resume = await rejected(ucp.callTool('resume_checkout', { meta: { ...UCP_META, 'idempotency-key': 'abc' }, checkout_id: 'reap_x', checkout: ucpCheckout(1) }, SESSION));
  assert.notEqual(resume.code, 'IDEMPOTENCY_CONFLICT', `resume: ${resume.code} ${resume.detail && resume.detail.reason}`);
});

// ---- the quantity, both dialects, create and update -------------------------------------------------------------

for (const tool of ['create_checkout_session', 'update_checkout_session']) {
  test(`native ${tool}: a line of 1000 is refused by name with nothing read or executed; 999 is executed`, async () => {
    const executor = recorder(ROWS);
    const surface = createCommerceToolSurface(executor, { cache: false });
    const call = (quantity, variant = true) => surface.callTool(tool, {
      idempotency_key: 'idem-quantity-0001',
      ...(tool === 'update_checkout_session' ? { session_id: 'q_1' } : {}),
      quote: { ...nativeQuote(quantity), items: [{ product_id: CONTRACTED.product_id, quantity, ...(variant ? { variant_id: 'v-9001-1' } : {}) }] },
    }, SESSION);
    assertQuantityAboveMaximum(await rejected(call(1000)), `${tool} 1000`);
    assertQuantityAboveMaximum(await rejected(call(900000000)), `${tool} 900000000`);
    assertQuantityAboveMaximum(await rejected(call(1e30)), `${tool} 1e30`);
    // Without a variant the door would read the product to resolve one: the refusal comes before that read.
    assertQuantityAboveMaximum(await rejected(call(1000, false)), `${tool} 1000, no variant`);
    assert.deepEqual(executor.seen, [], 'the executor was never called');

    // A numeric string is not coerced and is not this refusal: the one a bad quantity always got.
    const asString = await rejected(call('1000'));
    assert.equal(asString.code, 'QUOTE_REQUIRED');
    assert.deepEqual(asString.detail, { reason: 'item_bad_quantity' });
    assert.deepEqual(executor.seen, []);

    await call(999);
    assert.equal(executor.seen.find((c) => c.op === tool).params.quote.items[0].quantity, 999);
  });
}

for (const tool of ['create_checkout', 'update_checkout']) {
  test(`UCP ${tool}: a line of 1000 is refused by name before the first product read; 999 goes on`, async () => {
    await withEscalation(async () => {
      for (const product of [CONTRACTED.product_id, STOREFRONT.product_id]) {
        const executor = recorder(ROWS);
        const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
        const call = (quantity) => ucp.callTool(tool, {
          meta: { ...UCP_META, 'idempotency-key': 'idem-quantity-0002' },
          ...(tool === 'update_checkout' ? { id: 'q_1' } : {}),
          checkout: ucpCheckout(quantity, product),
        }, SESSION);
        assertQuantityAboveMaximum(await rejected(call(1000)), `${tool} ${product} 1000`);
        assertQuantityAboveMaximum(await rejected(call(900000000)), `${tool} ${product} 900000000`);
        assert.deepEqual(executor.seen, [], `${tool} ${product}: no product was read and nothing was executed`);

        const asString = await rejected(call('1000'));
        assert.notEqual(asString.detail && asString.detail.reason, 'quantity_above_line_maximum', 'a string is not coerced');

        const at = await rejected(call(999));
        assert.notEqual(at.detail && at.detail.reason, 'quantity_above_line_maximum', `${tool} ${product} 999`);
        assert.ok(executor.seen.some((c) => c.op === 'get_product'), `${tool} ${product} 999: the door went on to its reads`);
      }
    });
  });
}

for (const tool of ['create_checkout', 'update_checkout']) {
  test(`UCP ${tool}: a line that NAMES A VARIANT is proven against a product read before intake; 1000 is refused before that read`, async () => {
    // Without the surface's own early ceiling this cart would be read first (the variant proof) and refused after.
    for (const product of [CONTRACTED, STOREFRONT]) {
      const variant = product === CONTRACTED ? 'v-9001-1' : '44000000000001';
      const row = { ...product, variants: [{ variant_id: variant }] };
      const executor = recorder({ [product.product_id]: row });
      const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
      const call = (quantity) => ucp.callTool(tool, {
        meta: { ...UCP_META, 'idempotency-key': 'idem-quantity-0004' },
        ...(tool === 'update_checkout' ? { id: 'q_1' } : {}),
        checkout: ucpCheckout(quantity, `${product.product_id}::v::${variant}`),
      }, SESSION);
      assertQuantityAboveMaximum(await rejected(call(1000)), `${tool} ${product.product_id} 1000`);
      assert.deepEqual(executor.seen, [], `${tool} ${product.product_id}: the product was not read`);
      await rejected(call(999));
      assert.ok(executor.seen.some((c) => c.op === 'get_product'), `${tool} ${product.product_id} 999: the variant proof read the product`);
    }
  });
}

test('UCP create: 999 units of a storefront product become a storefront checkout of 999 units', async () => {
  await withEscalation(async () => {
    const executor = recorder(ROWS);
    const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
    const out = await ucp.callTool('create_checkout', { meta: { ...UCP_META, 'idempotency-key': 'idem-quantity-0003' }, checkout: ucpCheckout(999, STOREFRONT.product_id) }, SESSION);
    assert.equal(out.status, 'requires_escalation');
    assert.equal(out.line_items[0].quantity, 999);
    assert.equal(executor.seen.some((c) => c.op === 'create_checkout_session'), false, 'the kernel prices nothing for a storefront cart');
  });
});

// ---- the storefront-cart path holds no second number ------------------------------------------------------------

test('the storefront cart falls through on a line above the ceiling without reading anything', async () => {
  const env = { [UCP_ESCALATION_FLAG]: '1' };
  const op = { id: 'create_checkout_session' };
  const params = (quantity) => ({ idempotency_key: 'idem-store-0001', quote: { items: [{ product_id: STOREFRONT.product_id, quantity }] } });
  const ucpArgs = { meta: UCP_META, checkout: ucpCheckout(1, STOREFRONT.product_id) };
  const gate = async () => { throw new Error('the purchasability gate was asked'); };

  for (const quantity of [MAX_LINE_QUANTITY + 1, 900000000, 0, -1, 1.5, '3']) {
    const executor = recorder(ROWS);
    const out = await tryEscalateUcpCheckout({ op, params: params(quantity), ctx: SESSION, executor, ucpArgs, env, shouldOfferPurchase: gate });
    assert.equal(out, null, `quantity ${quantity}: left to intake`);
    assert.deepEqual(executor.seen, [], `quantity ${quantity}: no product was read`);
  }
  // At the ceiling the path goes on: it reads the product (and would then ask its gate).
  const executor = recorder(ROWS);
  const out = await tryEscalateUcpCheckout({ op, params: params(MAX_LINE_QUANTITY), ctx: SESSION, executor, ucpArgs, env, shouldOfferPurchase: async () => true });
  assert.equal(executor.seen.filter((c) => c.op === 'get_product').length, 1);
  assert.equal(out.line_items[0].quantity, MAX_LINE_QUANTITY);
});

test('the unserved-storefront refusal leaves a line above the ceiling to intake without reading anything', async () => {
  for (const opId of ['create_checkout_session', 'update_checkout_session']) {
    const params = (quantity) => ({ session_id: opId === 'update_checkout_session' ? 'q_1' : undefined, quote: { items: [{ product_id: STOREFRONT.product_id, quantity }] } });
    for (const quantity of [MAX_LINE_QUANTITY + 1, 900000000, 0, '3']) {
      const executor = recorder(ROWS);
      const out = await refuseUnservedStorefrontCheckout({ op: { id: opId }, params: params(quantity), ctx: SESSION, executor, env: {} });
      assert.equal(out, undefined, `${opId} ${quantity}`);
      assert.deepEqual(executor.seen, [], `${opId} ${quantity}: no product was read`);
    }
    // At the ceiling it reads the row and refuses the storefront product, as it does for any quantity it may act on.
    const executor = recorder(ROWS);
    const err = await rejected(refuseUnservedStorefrontCheckout({ op: { id: opId }, params: params(MAX_LINE_QUANTITY), ctx: SESSION, executor, env: {} }));
    assert.equal(err.detail.reason, 'ucp_storefront_checkout_unavailable', opId);
    assert.equal(executor.seen.filter((c) => c.op === 'get_product').length, 1, opId);
  }
});

// ---- what tools/list publishes is the runtime's own number -------------------------------------------------------

const schemaOf = (definitions, name) => definitions.find((t) => t.name === name).inputSchema;

test('the published minimum for an idempotency key is the runtime minimum, on every tool that takes one', () => {
  assert.equal(IDEMPOTENCY_KEY_MIN_LENGTH, 8);
  for (const tool of Object.keys(NATIVE_CALLS)) {
    const schema = schemaOf(commerceToolDefinitions, tool);
    assert.equal(schema.properties.idempotency_key.minLength, IDEMPOTENCY_KEY_MIN_LENGTH, tool);
    assert.ok(schema.required.includes('idempotency_key'), `${tool}: still required, as before`);
  }
  for (const env of [{}, { REAP_AGENTIC_LANE_ENABLED: '1' }, { REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '1' }]) {
    const definitions = ucpCommerceToolDefinitionsFor(env);
    for (const tool of ['create_checkout', 'update_checkout', 'complete_checkout']) {
      const meta = schemaOf(definitions, tool).properties.meta;
      assert.equal(meta.properties['idempotency-key'].minLength, IDEMPOTENCY_KEY_MIN_LENGTH, tool);
      assert.deepEqual(meta.required, ['idempotency-key'], `${tool}: still required, as before`);
    }
  }
});

test('the published maximum for a line quantity is the runtime ceiling, and lower lane limits are untouched', () => {
  assert.equal(MAX_LINE_QUANTITY, 999);
  for (const tool of ['create_checkout_session', 'update_checkout_session']) {
    const quantity = schemaOf(commerceToolDefinitions, tool).properties.quote.properties.items.items.properties.quantity;
    assert.deepEqual(quantity, { type: 'integer', minimum: 1, maximum: MAX_LINE_QUANTITY }, tool);
  }
  for (const env of [{}, { REAP_AGENTIC_LANE_ENABLED: '1' }, { REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '1' }]) {
    const definitions = ucpCommerceToolDefinitionsFor(env);
    for (const tool of ['create_checkout', 'update_checkout']) {
      const quantity = schemaOf(definitions, tool).properties.checkout.properties.line_items.items.properties.quantity;
      assert.deepEqual(quantity, { type: 'integer', minimum: 1, maximum: MAX_LINE_QUANTITY }, `${tool} ${JSON.stringify(env)}`);
    }
  }
  // The purchase lanes keep their own, lower, limits.
  assert.equal(REAP_MAX_QUANTITY, 10);
  assert.equal(START_PURCHASE_MAX_QUANTITY, 10);
  // Every `maximum` any published schema states for a `quantity`: the ceiling, or a lane's lower limit.
  const maxima = new Set();
  const walk = (node, key) => {
    if (!node || typeof node !== 'object') return;
    if (key === 'quantity' && Object.hasOwn(node, 'maximum')) maxima.add(node.maximum);
    for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  for (const definitions of [commerceToolDefinitions, ucpCommerceToolDefinitionsFor({}), ucpCommerceToolDefinitionsFor({ REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '1' })]) {
    walk(definitions, null);
  }
  assert.deepEqual([...maxima].sort((a, b) => a - b), [...new Set([REAP_MAX_QUANTITY, MAX_LINE_QUANTITY])].filter((m) => maxima.has(m)));
  assert.ok(maxima.has(MAX_LINE_QUANTITY));
});

test('each published key description says how the minimum is counted, which minLength alone cannot', () => {
  const sentence = ` ${IDEMPOTENCY_KEY_LENGTH_SENTENCE}`;
  assert.equal(sentence, ' At least 8 characters, printable ASCII only (U+0020 to U+007E); leading and trailing spaces are not counted.');
  for (const tool of Object.keys(NATIVE_CALLS)) {
    assert.ok(schemaOf(commerceToolDefinitions, tool).properties.idempotency_key.description.endsWith(sentence), tool);
  }
  for (const env of [{}, { REAP_AGENTIC_LANE_ENABLED: '1' }]) {
    for (const tool of ucpCommerceToolDefinitionsFor(env)) {
      assert.ok(tool.inputSchema.properties.meta.properties['idempotency-key'].description.endsWith(sentence), tool.name);
    }
  }
});

test('the older quote tool, whose calls go to the invoke door, publishes the same ceiling', () => {
  const quote = legacyToolDefinitions.find((t) => t.name === 'pivota_quote');
  const quantity = quote.inputSchema.properties.payload.properties.quote.properties.items.items.properties.quantity;
  assert.deepEqual(quantity, { type: 'integer', minimum: 1, maximum: MAX_LINE_QUANTITY });
});

// ---- start_purchase: the same key rule, its own quantity limit ------------------------------------------------------

const PURCHASE_ARGS = Object.freeze({
  merchant_id: 'merch_shop_a', product_id: 'p_shop_1', quantity: 1, expected_unit_price_minor: 1800, expected_currency: 'USD',
  consent_version: 'terms-0001',
  shipping_address: { name: 'Example Buyer', phone: '0000000000', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000', country: 'US' },
});

async function withPurchaseTool(fn) {
  const flags = ['ORCHESTRATED_PURCHASE_TOOL_ENABLED', 'AGENT_PURCHASE_ORDER_READ_ENABLED'];
  const saved = flags.map((name) => process.env[name]);
  for (const name of flags) process.env[name] = '1';
  try { return await fn(); } finally {
    flags.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
  }
}

test('start_purchase: a short key gets the shared named refusal before anything is read; its schema states the shared minimum', async () => {
  await withPurchaseTool(async () => {
    const executor = recorder(ROWS);
    const surface = createCommerceToolSurface(executor, { cache: false, orchestratedPurchase: { client: { createPurchase: async () => { throw new Error('the purchase backend was called'); } } } });
    // Plainly short, padded (8 UTF-16 units as sent), wide (8 units, 4 characters), invisible.
    for (const key of ['abcdefg', 'k', '   abcde', 'abc     ']) {
      assertKeyTooShort(await rejected(surface.callTool('start_purchase', { idempotency_key: key, ...PURCHASE_ARGS }, SESSION)), `start_purchase ${JSON.stringify(key)}`);
    }
    for (const key of BAD_CHARACTER_KEYS) {
      assertKeyBadCharacters(await rejected(surface.callTool('start_purchase', { idempotency_key: key, ...PURCHASE_ARGS }, SESSION)), `start_purchase ${JSON.stringify(key)}`);
    }
    assert.deepEqual(executor.seen, [], 'nothing was read');
    // No key at all is the tool's own argument problem, as before.
    for (const absent of [undefined, '', '   ']) {
      const err = await rejected(surface.callTool('start_purchase', { ...(absent === undefined ? {} : { idempotency_key: absent }), ...PURCHASE_ARGS }, SESSION));
      assert.equal(err.name, 'ToolValidationError', JSON.stringify(absent));
      assert.match(err.message, /idempotency_key is required/);
    }
    // Eight characters are past the key rule.
    const ok = await rejected(surface.callTool('start_purchase', { idempotency_key: 'abcdefgh', ...PURCHASE_ARGS }, SESSION));
    assert.notEqual(ok && ok.code, 'IDEMPOTENCY_CONFLICT');
    assert.doesNotMatch(String(ok && ok.message), /idempotency_key/);
  });
  assert.deepEqual(startPurchaseArgumentProblems({ ...PURCHASE_ARGS, idempotency_key: 'abcdefgh' }), []);
  const key = START_PURCHASE_INPUT_SCHEMA.properties.idempotency_key;
  assert.equal(key.minLength, IDEMPOTENCY_KEY_MIN_LENGTH);
  assert.ok(key.description.endsWith(` ${IDEMPOTENCY_KEY_LENGTH_SENTENCE}`));
  // Its own, lower, quantity limit is untouched.
  assert.deepEqual(START_PURCHASE_INPUT_SCHEMA.properties.quantity, { type: 'integer', minimum: 1, maximum: 10 });
  assert.equal(startPurchaseArgumentProblems({ ...PURCHASE_ARGS, idempotency_key: 'abcdefgh', quantity: 11 })[0].field, 'quantity');
});

// ---- which characters a key may be made of, at the surface ---------------------------------------------------------

test('a key with a character outside printable ASCII is refused by name on every tool that takes a key, with nothing read or executed', async () => {
  await withEscalation(async () => {
    const executor = recorder(ROWS);
    const surface = createCommerceToolSurface(executor, { cache: false });
    const ucp = ucpDialectSurface(surface);
    for (const key of BAD_CHARACTER_KEYS) {
      for (const [tool, args] of Object.entries(NATIVE_CALLS)) {
        assertKeyBadCharacters(await rejected(surface.callTool(tool, { idempotency_key: key, ...args }, SESSION)), `native ${tool} ${JSON.stringify(key)}`);
      }
      for (const [tool, args] of Object.entries(ucpCalls(key))) {
        assertKeyBadCharacters(await rejected(ucp.callTool(tool, args, SESSION)), `UCP ${tool} ${JSON.stringify(key)}`);
      }
      const storefront = { meta: { ...UCP_META, 'idempotency-key': key }, checkout: ucpCheckout(1, STOREFRONT.product_id) };
      assertKeyBadCharacters(await rejected(ucp.callTool('create_checkout', storefront, SESSION)), `UCP storefront ${JSON.stringify(key)}`);
    }
    assert.deepEqual(executor.seen, [], 'the executor was never called');
  });
});

test('the partner door\'s own storefront cart leaves a line above the ceiling to intake, by intake\'s one predicate', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../src/mcpStorefrontCart.js', import.meta.url), 'utf8');
  assert.match(source, /items\.some\(\(it\) => !isAcceptableLineQuantity\(it\.quantity\)\)/);
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /Number\.isSafeInteger\(it\.quantity\)/);
});
