// ONE LINE PER PRODUCT AND VARIANT, AT THE TOOL SURFACE (both dialects).
//
// A cart that names the same product and variant on more than one line is refused on the request alone, so the
// refusal must come BEFORE every read the surface would otherwise make: the variant proof, the storefront cart's
// product reads (and, behind them, its purchasability gate and the seller's own door), intake's default-variant read
// and the kernel. The executor here is a recorder: a refused call that reaches it, for a read or for the operation
// itself, fails the test.
//
// Also pinned: how each dialect identifies a line (the native `product_id` + `variant_id`; UCP's `item.id`, which
// names a product or `<product>::v::<variant>`), what a line with no variant means, and the one sentence both tool
// lists publish about it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DUPLICATE_LINES_SENTENCE } from '../../safety-kernel/src/protocol/buyerIntake.js';
import {
  commerceToolDefinitions,
  createCommerceToolSurface,
  toToolError,
  ucpCommerceToolDefinitionsFor,
  ucpDialectSurface,
} from '../src/commerceToolSurface.js';
import { describeToolErrorReason } from '../src/toolCallOutcome.js';
import { UCP_ESCALATION_FLAG } from '../src/ucpCheckoutEscalation.js';

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

// A product Pivota transacts with one variant, one with two, and one that completes on its seller's storefront.
const ONE = Object.freeze({ product_id: 'p_shop_1', title: 'Day Lotion', price: 18, currency: 'USD', merchant_id: 'merch_shop_a', variants: [{ variant_id: 'v-9001-1' }] });
const TWO = Object.freeze({ product_id: 'p_shop_2', title: 'Night Lotion', price: 18, currency: 'USD', merchant_id: 'merch_shop_a', variants: [{ variant_id: 'v-9002-1' }, { variant_id: 'v-9002-2' }] });
const STOREFRONT = Object.freeze({
  product_id: 'sig_store_a', title: 'Calm Serum', price: 25, currency: 'USD', merchant_id: 'merch_obs_000000000000000a',
  external_redirect_url: 'https://store-a.example/products/calm-serum?variant=44000000000001',
});
const ROWS = { [ONE.product_id]: ONE, [TWO.product_id]: TWO, [STOREFRONT.product_id]: STOREFRONT };

const MESSAGE = 'This cart names the same product and variant on more than one line. Merge those lines into one line that carries their combined quantity (at most 999 units per line) and send the request again. `detail.duplicate_lines` lists the lines to merge by position (the first line is 1), one group per product and variant. Retrying as sent will not change the answer.';

function assertDuplicateLines(err, groups, label) {
  assert.equal(err && err.code, 'QUOTE_REQUIRED', `${label}: ${JSON.stringify(err && (err.answered ?? err.message))}`);
  assert.equal(err.retriable, false, `${label}: terminal`);
  const wire = JSON.parse(toToolError(err).content[0].text).error;
  assert.deepEqual(wire, { code: 'QUOTE_REQUIRED', message: MESSAGE, retriable: false, detail: { reason: 'duplicate_line_for_product_variant', duplicate_lines: groups } }, label);
  // The completion line names it, from the closed set.
  assert.deepEqual(describeToolErrorReason(err), { error_reason: 'duplicate_line_for_product_variant' }, label);
}

const nativeArgs = (tool, items, key = 'idem-dup-0001') => ({
  idempotency_key: key,
  ...(tool === 'update_checkout_session' ? { session_id: 'q_1' } : {}),
  quote: { merchant_id: 'merch_shop_a', customer_email: 'buyer@example.test', items },
});
const ucpArgs = (tool, lines, key = 'idem-dup-0001', market = 'US') => ({
  meta: { ...UCP_META, 'idempotency-key': key },
  ...(tool === 'update_checkout' ? { id: 'q_1' } : {}),
  checkout: {
    line_items: lines.map(([id, quantity]) => ({ item: { id }, quantity })),
    buyer: { email: 'buyer@example.test' },
    ...(market ? { context: { address_country: market } } : {}),
  },
});
const item = (product_id, variant_id, quantity = 1) => (variant_id === undefined ? { product_id, quantity } : { product_id, variant_id, quantity });

function withEscalation(fn) {
  const saved = process.env[UCP_ESCALATION_FLAG];
  process.env[UCP_ESCALATION_FLAG] = '1';
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env[UCP_ESCALATION_FLAG];
    else process.env[UCP_ESCALATION_FLAG] = saved;
  });
}

// ---- native dialect -----------------------------------------------------------------------------------------------

for (const tool of ['create_checkout_session', 'update_checkout_session']) {
  test(`native ${tool}: the same product and variant on two lines is refused by name with nothing read or executed`, async () => {
    const executor = recorder(ROWS);
    const surface = createCommerceToolSurface(executor, { cache: false });
    assertDuplicateLines(await rejected(surface.callTool(tool, nativeArgs(tool, [item('p_shop_1', 'v-9001-1', 600), item('p_shop_1', 'v-9001-1', 600)]), SESSION)), [[1, 2]], '600 + 600');
    assertDuplicateLines(await rejected(surface.callTool(tool, nativeArgs(tool, [item('p_shop_1', 'v-9001-1'), item('p_shop_2', 'v-9002-1'), item(' p_shop_1 ', 'v-9001-1 ')]), SESSION)), [[1, 3]], 'padded ids, not adjacent');
    // Two lines of one product that name no variant are the same line twice: refused before the read that would resolve them.
    assertDuplicateLines(await rejected(surface.callTool(tool, nativeArgs(tool, [item('p_shop_1', undefined, 600), item('p_shop_1', undefined, 600)]), SESSION)), [[1, 2]], 'no variant twice');
    assert.deepEqual(executor.seen, [], 'the executor was never called: no read, nothing executed');
  });

  test(`native ${tool}: two different variants of one product are two lines, at any quantity, and are executed as sent`, async () => {
    const executor = recorder(ROWS);
    const surface = createCommerceToolSurface(executor, { cache: false });
    const items = [item('p_shop_2', 'v-9002-1', 999), item('p_shop_2', 'v-9002-2', 999)];
    await surface.callTool(tool, nativeArgs(tool, items), SESSION);
    const call = executor.seen.find((c) => c.op === tool);
    assert.deepEqual(call.params.quote.items, items);
  });
}

test('native: a line that names a variant beside one of the same product that names none is not refused at the door; it goes on to the read that resolves it', async () => {
  const executor = recorder(ROWS);
  const surface = createCommerceToolSurface(executor, { cache: false });
  await surface.callTool('create_checkout_session', nativeArgs('create_checkout_session', [item('p_shop_1', 'v-9001-1', 600), item('p_shop_1', undefined, 600)]), SESSION);
  assert.deepEqual(executor.seen.map((c) => c.op), ['get_product', 'create_checkout_session'], 'the product was read to resolve the unnamed variant');
  // What the door hands the executor: both lines now carry the same variant. The CANONICAL executor refuses that
  // pair before pricing (safety-kernel/test/duplicateLines.test.js); this recorder stands in for it.
  assert.deepEqual(executor.seen[1].params.quote.items.map((it) => it.variant_id), ['v-9001-1', 'v-9001-1']);
});

test('native: the key rule and the ceiling answer before the duplicate rule', async () => {
  const executor = recorder(ROWS);
  const surface = createCommerceToolSurface(executor, { cache: false });
  const dup = [item('p_shop_1', 'v-9001-1'), item('p_shop_1', 'v-9001-1')];
  const shortKey = await rejected(surface.callTool('create_checkout_session', nativeArgs('create_checkout_session', dup, 'abcdefg'), SESSION));
  assert.equal(shortKey.detail.reason, 'idempotency_key_too_short');
  const over = await rejected(surface.callTool('create_checkout_session', nativeArgs('create_checkout_session', [item('p_shop_1', 'v-9001-1', 1000), item('p_shop_1', 'v-9001-1', 1)]), SESSION));
  assert.equal(over.detail.reason, 'quantity_above_line_maximum');
  assert.deepEqual(executor.seen, []);
});

// ---- UCP dialect --------------------------------------------------------------------------------------------------

for (const tool of ['create_checkout', 'update_checkout']) {
  test(`UCP ${tool}: the same item id on two lines is refused by name before the first product read, in every market and with none named`, async () => {
    await withEscalation(async () => {
      const executor = recorder(ROWS);
      const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
      for (const market of ['US', 'SG', 'GB', 'DE', null]) {
        // A bare product id twice (kernel path): no variant twice.
        assertDuplicateLines(await rejected(ucp.callTool(tool, ucpArgs(tool, [['p_shop_1', 600], ['p_shop_1', 600]], 'idem-dup-0001', market), SESSION)), [[1, 2]], `${market} bare id, 600 + 600`);
        // A named variant twice: refused before the read that would prove the variant belongs.
        assertDuplicateLines(await rejected(ucp.callTool(tool, ucpArgs(tool, [['p_shop_2::v::v-9002-1', 1], ['p_shop_2::v::v-9002-2', 1], ['p_shop_2::v::v-9002-1', 1]], 'idem-dup-0001', market), SESSION)), [[1, 3]], `${market} named variant`);
        // A product that completes on its seller's storefront: refused before its product read, its gate and its store.
        assertDuplicateLines(await rejected(ucp.callTool(tool, ucpArgs(tool, [['sig_store_a', 1], ['sig_store_a', 2]], 'idem-dup-0001', market), SESSION)), [[1, 2]], `${market} storefront product`);
      }
      assert.deepEqual(executor.seen, [], 'no product was read and nothing was executed');
    });
  });
}

test('UCP create: two different variants of one product are two lines and go on, each proven against the product read', async () => {
  await withEscalation(async () => {
    const executor = recorder(ROWS);
    const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
    await ucp.callTool('create_checkout', ucpArgs('create_checkout', [['p_shop_2::v::v-9002-1', 999], ['p_shop_2::v::v-9002-2', 999]]), SESSION);
    const call = executor.seen.find((c) => c.op === 'create_checkout_session');
    assert.ok(call, `executed: ${JSON.stringify(executor.seen.map((c) => c.op))}`);
    assert.deepEqual(call.params.quote.items.map((it) => [it.product_id, it.variant_id, it.quantity]), [['p_shop_2', 'v-9002-1', 999], ['p_shop_2', 'v-9002-2', 999]]);
  });
});

test('UCP create: a bare product id beside a named variant of it is not refused at the door (not known to be the same until the product is read)', async () => {
  await withEscalation(async () => {
    const executor = recorder(ROWS);
    const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
    const out = await rejected(ucp.callTool('create_checkout', ucpArgs('create_checkout', [['p_shop_1::v::v-9001-1', 600], ['p_shop_1', 600]]), SESSION));
    assert.notEqual(out && out.detail && out.detail.reason, 'duplicate_line_for_product_variant');
    assert.ok(executor.seen.some((c) => c.op === 'get_product'), 'the door went on to its reads');
  });
});

test('the two vendor tools that continue an earlier create are not judged by the duplicate rule', async () => {
  const executor = recorder(ROWS);
  const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
  const args = ucpArgs('create_checkout', [['p_shop_1', 1], ['p_shop_1', 1]]);
  const recover = await rejected(ucp.callTool('recover_checkout', args, SESSION));
  assert.notEqual(recover.detail && recover.detail.reason, 'duplicate_line_for_product_variant', `recover: ${recover.code}`);
});

// ---- tools/list ---------------------------------------------------------------------------------------------------

test('both tool lists say it once on each cart\'s line-item list, in the rule\'s own sentence; no other schema carries it', () => {
  const native = Object.fromEntries(commerceToolDefinitions.map((t) => [t.name, t.inputSchema]));
  for (const tool of ['create_checkout_session', 'update_checkout_session']) {
    assert.equal(native[tool].properties.quote.properties.items.description, DUPLICATE_LINES_SENTENCE, tool);
  }
  const ucp = Object.fromEntries(ucpCommerceToolDefinitionsFor({}).map((t) => [t.name, t.inputSchema]));
  for (const tool of ['create_checkout', 'update_checkout']) {
    const description = ucp[tool].properties.checkout.properties.line_items.description;
    assert.ok(description.endsWith(` ${DUPLICATE_LINES_SENTENCE}`), `${tool}: ${description}`);
    assert.ok(description.startsWith('Required. The lines to price;'), tool);
  }
  const count = (defs) => JSON.stringify(defs).split(DUPLICATE_LINES_SENTENCE).length - 1;
  assert.equal(count(commerceToolDefinitions), 2, 'native: create and update');
  assert.equal(count(ucpCommerceToolDefinitionsFor({})), 2, 'UCP: create and update');
});
