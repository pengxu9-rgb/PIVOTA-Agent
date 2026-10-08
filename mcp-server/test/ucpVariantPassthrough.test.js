// VARIANT PASSTHROUGH on the UCP door: the size/shade an agent picks reaches every lane that can honour it.
//
// Pinned here:
//   - the composite item id `<product_id>::v::<variant_id>` parses on the FIRST separator, and malformed ones refuse;
//   - a chosen variant must be one of the product's REAL variants (proven on the product read) — or nothing runs;
//   - the kernel lane receives the chosen `variant_id` (no "ambiguous" refusal, no guess);
//   - the storefront escalation shows the chosen variant (its price, its label, its id) and keeps it in its id;
//   - merchant-door pricing carts the chosen variant's OWN seller id, or falls back — never another variant's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseUcpItemId, encodeUcpVariantItemId, realVariantsOf, variantPriceOf } from '../src/ucpVariantIds.js';
import { UCP_ESCALATION_FLAG, decodeEscalationId, tryEscalateUcpCheckout } from '../src/ucpCheckoutEscalation.js';
import { MERCHANT_PRICING_FLAG, sellerVariantGidOf } from '../src/ucpMerchantDoorPricing.js';
import { UCP_INPUT_SCHEMAS, UCP_TOOL_DESCRIPTIONS } from '../src/ucpArgumentAdapter.js';
import { shapeUcpGetProductResponse } from '../src/ucpResponseShaper.js';
import { createCommerceToolSurface, ucpDialectSurface, toToolError } from '../src/commerceToolSurface.js';

const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-0001-variant' };
const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
const GID = (n) => `gid://shopify/ProductVariant/${n}`;

const CONTRACTED = Object.freeze({
  product_id: 'p_shop_1', title: 'Shop Serum', price: 20, currency: 'USD', merchant_id: 'merchant_shop',
  variants: [{ variant_id: '48930014462260', title: '30ml', price: 20 }, { variant_id: '48930014462261', title: '50ml', price: 32 }],
});
const STOREFRONT = Object.freeze({
  product_id: 'sig_lip', title: 'Lip Tint', price: 18, currency: 'USD',
  external_redirect_url: 'https://brand.example/products/lip-tint',
  // Row-level identity that names a DIFFERENT variant (Rose): a chosen variant must never be carted by these.
  source_variant_id: '44000000000001',
  destination_url: 'https://brand.example/products/lip-tint?variant=44000000000001',
  variants: [
    { variant_id: 'v_rose', title: 'Rose', price: { current: { amount: 18, currency: 'USD' } }, source_variant_id: '44000000000001' },
    { variant_id: 'v_coral', title: 'Coral', price: { current: { amount: 21, currency: 'USD' } }, source_variant_id: '44000000000002' },
    { variant_id: 'v_nude', title: 'Nude' },
  ],
});

function executorWith(rowsById) {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params });
      if (op === 'get_product') {
        const row = rowsById[params.payload.product.product_id];
        return row ? { product: structuredClone(row) } : { product: null };
      }
      return { session_id: 'q_kernel' };
    },
  };
}
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const body = (id, qty = 1, extra = {}) => ({ meta: AGENT_META, checkout: { line_items: [{ item: { id }, quantity: qty }], buyer: { email: 'shopper@example.test' }, context: { address_country: 'US' }, ...extra } });
const rejected = (p) => p.then(() => null, (e) => e);
const surface = (executor, opts = {}) => ucpDialectSurface(createCommerceToolSurface(executor, { cache: false, ...opts }));

describe('the composite id', () => {
  test('parses on the FIRST separator; a plain id has no variant', () => {
    assert.deepEqual(parseUcpItemId('sig_a'), { product_id: 'sig_a' });
    assert.deepEqual(parseUcpItemId(' sig_a::v::123 '), { product_id: 'sig_a', variant_id: '123' });
    assert.deepEqual(parseUcpItemId('sig_a::v::ext:k::v::9'), { product_id: 'sig_a', variant_id: 'ext:k::v::9' }, 'a variant id may itself contain the separator');
    assert.equal(encodeUcpVariantItemId('sig_a', 'ext:k::v::9'), 'sig_a::v::ext:k::v::9');
  });
  test('malformed: an empty side, a non-printable or over-long variant id', () => {
    for (const bad of ['::v::1', 'sig_a::v::', 'sig_a::v:: ', 'sig_a::v::a b', `sig_a::v::${'x'.repeat(257)}`, '']) assert.equal(parseUcpItemId(bad), null, JSON.stringify(bad));
  });
  test("real variants are checkout's own count; a variant's own price reads canonical, flat and scalar shapes", () => {
    assert.deepEqual(realVariantsOf(STOREFRONT).map((r) => r.id), ['v_rose', 'v_coral', 'v_nude']);
    assert.deepEqual(variantPriceOf(STOREFRONT.variants[1], STOREFRONT), { amount: 2100, currency: 'USD' });
    assert.deepEqual(variantPriceOf({ price: { amount: 5, currency: 'eur' } }, STOREFRONT), { amount: 500, currency: 'EUR' });
    assert.deepEqual(variantPriceOf({ price: 7 }, STOREFRONT), { amount: 700, currency: 'USD' });
    assert.equal(variantPriceOf({ title: 'no price' }, STOREFRONT), undefined, "never borrows the product's");
  });
});

describe('at the door', () => {
  test('the kernel lane receives the chosen variant (no ambiguity refusal, no guess)', async () => {
    const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED });
    await surface(executor).callTool('create_checkout', body(encodeUcpVariantItemId(CONTRACTED.product_id, '48930014462261'), 2), SESSION);
    const create = executor.seen.find((c) => c.op === 'create_checkout_session');
    assert.deepEqual(create.params.quote.items.map((i) => [i.product_id, i.variant_id, i.quantity]), [[CONTRACTED.product_id, '48930014462261', 2]]);
  });
  test('a bare product id with several variants is still refused, never guessed', async () => {
    const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED });
    const err = await rejected(surface(executor).callTool('create_checkout', body(CONTRACTED.product_id), SESSION));
    assert.ok(err);
    assert.equal(executor.seen.some((c) => c.op === 'create_checkout_session'), false);
  });
  test('a variant the product does not have is refused by name before ANY lane runs (create and update)', async () => {
    for (const [tool, extra] of [['create_checkout', {}], ['update_checkout', { id: 'q_kernel' }]]) {
      const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED });
      const ucp = surface(executor);
      const args = { ...body(encodeUcpVariantItemId(CONTRACTED.product_id, 'v_forged')), ...extra };
      const err = await rejected(ucp.callTool(tool, args, SESSION));
      assert.equal(err.code, 'QUOTE_REQUIRED', tool);
      assert.equal(err.retriable, false);
      assert.equal(err.detail.acp_detail.reason, 'ucp_variant_not_in_product');
      assert.deepEqual(err.detail.acp_detail.rejected_item_ids, [`${CONTRACTED.product_id}::v::v_forged`]);
      assert.deepEqual(executor.seen.map((c) => c.op), ['get_product'], `${tool}: one read, nothing priced`);
      assert.equal(JSON.parse(toToolError(err).content[0].text).error.detail.reason, 'ucp_variant_not_in_product');
    }
  });
  test("a restated product id is not a variant (the pdpBuilder's `${pid}-1` fabrication)", async () => {
    const row = { ...CONTRACTED, variants: [{ variant_id: 'p_shop_1-1' }, { variant_id: 'p_shop_1-2' }] };
    const executor = executorWith({ [row.product_id]: row });
    const err = await rejected(surface(executor).callTool('create_checkout', body(encodeUcpVariantItemId(row.product_id, 'p_shop_1-1')), SESSION));
    assert.equal(err.detail.acp_detail.reason, 'ucp_variant_not_in_product');
  });
  test('a malformed variant id is refused by the adapter, before any read', async () => {
    const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED });
    const err = await rejected(surface(executor).callTool('create_checkout', body(`${CONTRACTED.product_id}::v::`), SESSION));
    assert.equal(err.detail?.acp_detail?.reason ?? err.detail?.reason, 'ucp_line_item_variant_malformed');
    assert.equal(executor.seen.length, 0);
  });
});

describe('storefront escalation and merchant-door pricing', () => {
  const ESC = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: undefined };
  const PRICED = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1' };

  test("escalation shows the CHOSEN variant: its own price and label, its composite id, kept in the checkout id", async () => {
    await withEnv(ESC, async () => {
      const executor = executorWith({ [STOREFRONT.product_id]: STOREFRONT });
      const ucp = surface(executor);
      const lineId = encodeUcpVariantItemId(STOREFRONT.product_id, 'v_coral');
      const out = await ucp.callTool('create_checkout', body(lineId, 2), SESSION);
      assert.equal(out.status, 'requires_escalation');
      assert.deepEqual(out.line_items[0].item, { id: lineId, title: 'Lip Tint — Coral', price: 2100 });
      assert.equal(out.totals.find((t) => t.type === 'total').amount, 4200);
      assert.deepEqual(decodeEscalationId(out.id), [{ product_id: STOREFRONT.product_id, quantity: 2, variant_id: 'v_coral' }]);
      const again = await ucp.callTool('get_checkout', { meta: AGENT_META, id: out.id }, SESSION);
      assert.deepEqual(again.line_items[0].item, out.line_items[0].item);
      // a chosen variant with no price of its own shows the product's catalog price, as before
      const nude = await ucp.callTool('create_checkout', body(encodeUcpVariantItemId(STOREFRONT.product_id, 'v_nude')), SESSION);
      assert.equal(nude.line_items[0].item.price, 1800);
      assert.equal(executor.seen.some((c) => c.op === 'create_checkout_session'), false);
    });
  });

  test('a forged escalation id naming a variant the product does not have is not ours', async () => {
    const forged = 'esc_' + Buffer.from(JSON.stringify({ v: 1, i: [[STOREFRONT.product_id, 1, 'a b']] })).toString('base64url');
    assert.equal(decodeEscalationId(forged), null);
    const four = 'esc_' + Buffer.from(JSON.stringify({ v: 1, i: [[STOREFRONT.product_id, 1, 'v_rose', 'x']] })).toString('base64url');
    assert.equal(decodeEscalationId(four), null);
  });

  function sellerCartFor(gid, price) {
    const payload = { id: 'gid://shopify/Cart/c9', currency: 'USD', continue_url: 'https://brand.example/cart/c/9',
      line_items: [{ item: { id: gid, title: 'Seller Coral', price }, quantity: 1 }],
      totals: [{ type: 'subtotal', amount: price }, { type: 'total', amount: price }] };
    return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
  }

  test("merchant pricing carts the CHOSEN variant's own seller id — never the row's other variants", async () => {
    await withEnv(PRICED, async () => {
      const calls = [];
      const merchantDoor = {
        endpointFor: async () => 'https://brand.example/api/ucp/mcp',
        createCart: async (ep, args) => { calls.push(args); return sellerCartFor(GID('44000000000002'), 2250); },
        getCart: async () => sellerCartFor(GID('44000000000002'), 2250),
      };
      const executor = executorWith({ [STOREFRONT.product_id]: STOREFRONT });
      const lineId = encodeUcpVariantItemId(STOREFRONT.product_id, 'v_coral');
      const out = await surface(executor, { merchantDoor }).callTool('create_checkout', body(lineId), SESSION);
      assert.deepEqual(calls[0].lineItems, [{ item: { id: GID('44000000000002') }, quantity: 1 }]);
      assert.equal(out.messages[0].code, 'checkout.priced_by_seller_storefront');
      assert.deepEqual(out.line_items[0].item, { id: lineId, title: 'Seller Coral', price: 2250 });
    });
  });

  test('a chosen variant with no seller id of its own falls back to the catalog answer (no seller contacted)', async () => {
    const calls = [];
    const merchantDoor = { endpointFor: async () => { calls.push('discover'); return 'https://brand.example/api/ucp/mcp'; }, createCart: async () => { calls.push('cart'); }, getCart: async () => {} };
    const row = { ...STOREFRONT, variants: [...STOREFRONT.variants.slice(0, 2), { variant_id: 'v_nude', title: 'Nude' }] };
    const out = await tryEscalateUcpCheckout({
      op: { id: 'create_checkout_session' }, params: { idempotency_key: 'k', quote: { items: [{ product_id: row.product_id, quantity: 1, variant_id: 'v_nude' }] } },
      ctx: {}, executor: executorWith({ [row.product_id]: row }), ucpArgs: { checkout: { context: { address_country: 'US' } } }, env: PRICED, merchantDoor,
    });
    assert.equal(out.messages[0].code, 'checkout.completes_on_seller_storefront');
    assert.deepEqual(calls, []);
  });
});

describe('review of #2376', () => {
  const ESC = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: undefined };
  const pubShape = (row) => shapeUcpGetProductResponse({ product: row }, { params: {}, ucpArgs: {} });

  test('the published item.id schema text says a variant can be chosen (agents read it)', () => {
    const text = JSON.stringify(UCP_INPUT_SCHEMAS.create_checkout_session) + UCP_TOOL_DESCRIPTIONS.create_checkout_session;
    assert.doesNotMatch(text, /cannot be checked out over\s+this dialect/);
    assert.match(text, /product\.variants\[\]\.id/);
  });

  test('get_checkout re-proves the variant: an esc_ id naming a variant the row does not have is not a checkout', async () => {
    await withEnv(ESC, async () => {
      const ucp = surface(executorWith({ [STOREFRONT.product_id]: STOREFRONT }));
      for (const vid of ['v_forged', 'v_removed']) {
        const id = 'esc_' + Buffer.from(JSON.stringify({ v: 1, i: [[STOREFRONT.product_id, 1, vid]] })).toString('base64url');
        const err = await rejected(ucp.callTool('get_checkout', { meta: AGENT_META, id }, SESSION));
        assert.equal(err.code, 'QUOTE_NOT_FOUND', vid);
        assert.equal(err.detail.reason, 'ucp_escalation_row_changed');
      }
    });
  });

  test('a $0 variant is not a price: it is published, and handed off, at the product price', async () => {
    const row = { ...STOREFRONT, variants: [{ variant_id: 'v_zero', title: 'Zero', price: 0 }, { variant_id: 'v_coral', title: 'Coral', price: 21 }] };
    const out = pubShape(row);
    assert.deepEqual(out.product.variants.map((v) => v.price.amount), [1800, 2100]);
    assert.equal(out.product.price_range.min.amount, 1800);
    await withEnv(ESC, async () => {
      const handoff = await surface(executorWith({ [row.product_id]: row })).callTool('create_checkout', body(encodeUcpVariantItemId(row.product_id, 'v_zero')), SESSION);
      assert.equal(handoff.line_items[0].item.price, 1800);
    });
  });

  test('ids checkout would refuse (a space, non-ASCII, over-long) are never published, and the envelope says the list is partial', () => {
    const row = { ...STOREFRONT, variants: [{ variant_id: 'v_a', price: 1 }, { variant_id: 'v_b', price: 2 }, { variant_id: 'Shade 01', price: 3 }, { variant_id: 'café', price: 4 }, { variant_id: 'x'.repeat(257), price: 5 }] };
    const out = pubShape(row);
    assert.deepEqual(out.product.variants.map((v) => v.id), ['sig_lip::v::v_a', 'sig_lip::v::v_b']);
    assert.equal(out.messages[0].code, 'variants.partially_published');
    assert.match(out.messages[0].content, /5 purchasable variants; only 2/);
    const one = pubShape({ ...row, variants: [{ variant_id: 'v_a', price: 1 }, { variant_id: 'Shade 01', price: 3 }] });
    assert.equal(one.product.variants[0].id, 'sig_lip');
    assert.match(one.messages[0].content, /fewer than two could be published/);
  });

  test('labels: option values when there is no title; a distinct title when there is neither', () => {
    const out = pubShape({ ...STOREFRONT, variants: [
      { variant_id: 'v_1', options: [{ name: 'Size', value: '30ml' }, { name: 'Finish', value: 'Matte' }] },
      { variant_id: 'v_2' }, { variant_id: 'v_3' },
    ] });
    assert.deepEqual(out.product.variants.map((v) => v.title), ['Lip Tint — 30ml / Matte', 'Lip Tint — option 2', 'Lip Tint — option 3']);
  });

  test("the chosen variant's seller id: its own source id, else its own numeric id — never the row's, never a non-member's", () => {
    assert.equal(sellerVariantGidOf(STOREFRONT, 'brand.example', 'v_coral'), GID('44000000000002'), 'not the row-level / URL Rose id');
    const numeric = { ...STOREFRONT, variants: [{ variant_id: '44000000000009', title: 'A' }, { variant_id: '44000000000010', title: 'B' }] };
    assert.equal(sellerVariantGidOf(numeric, 'brand.example', '44000000000010'), GID('44000000000010'));
    assert.equal(sellerVariantGidOf(STOREFRONT, 'brand.example', 'v_nude'), null, 'no seller id of its own -> nothing, not the row id');
    assert.equal(sellerVariantGidOf(STOREFRONT, 'brand.example', 'v_forged'), null, 'defence in depth: a non-member variant');
  });
});
