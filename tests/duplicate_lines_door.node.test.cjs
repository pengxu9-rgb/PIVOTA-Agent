'use strict';

// ONE LINE PER PRODUCT AND VARIANT, AT EVERY CHECKOUT DOOR (the real gateway app, offline).
//
// The per-line quantity ceiling bounds one line. What prices a cart adds the quantities of lines that name the same
// product and variant together before pricing them, so 600 + 600 of one variant would be priced as one line of
// 1,200. A cart that names the same product and variant on more than one line is refused, by name, at the door:
// `/mcp`, `/ucp/mcp`, the ACP REST door and both invoke addresses (strict checkout on and off).
//
// What is pinned here, through the routes:
//   - the refusal: its code, message and detail (the positions of the lines to merge), the same on every door in that
//     door's own error body;
//   - NOTHING IS SENT ANYWHERE for it: no catalog or backend read, no purchasability gate, no quote, no store call
//     (the fixture records every one of them);
//   - it is decided on the lines alone: the same answer for every market, named or not, priced or not;
//   - two different variants of one product are two lines and are priced as sent, at 999 units each;
//   - a line that names a variant beside one of the same product that names none is NOT refused from the request
//     alone. For a KERNEL row (a product Pivota prices) on `/mcp`, `/ucp/mcp` and ACP REST, the door's read resolves
//     the second line; when that is the same variant the cart is refused before it is priced, and before ACP claims
//     the caller's key, so the merged cart can be sent again with the same key. For a STOREFRONT row no cart is built
//     at the store: the door answers with the hand-off to the seller's page (the store-cart builder's own check, not
//     this rule). On the INVOKE door nothing resolves a variant: the two lines go to be priced as two different keys;
//   - a cart of one line is answered exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./_support/intakeKeyQtyDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { IDS } = fx;
let door;

test.before(async () => {
  door = fx.bootDoor({ port: 4479, buyerKeys: await fx.mintBuyerKeys() });
  await door.listen();
});
test.after(async () => { if (door) await door.close(); });

const MESSAGE = 'This cart names the same product and variant on more than one line. Merge those lines into one line that carries their combined quantity (at most 999 units per line) and send the request again. `detail.duplicate_lines` lists the lines to merge by position (the first line is 1), one group per product and variant. Retrying as sent will not change the answer.';
const detailOf = (groups) => ({ reason: 'duplicate_line_for_product_variant', duplicate_lines: groups });

const errorOf = (r) => (r.value && r.value.error) || null;
const sentNothing = (r, label) => {
  assert.deepEqual(r.upstream, [], `${label}: nothing was sent to the catalog, the backend or the gate`);
  assert.deepEqual(r.store, [], `${label}: nothing was sent to a storefront`);
};
const quoteCalls = (r) => r.upstream.filter((c) => c.path === '/agent/v2/quotes/preview');
function assertDuplicateLines(r, groups, label) {
  assert.equal(r.http, 200, label);
  assert.equal(r.isError, true, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(errorOf(r), { code: 'QUOTE_REQUIRED', message: MESSAGE, retriable: false, detail: detailOf(groups) }, label);
  sentNothing(r, label);
}

let keySeq = 0;
const freshKey = () => { keySeq += 1; return `idem-dupl-${String(keySeq).padStart(4, '0')}`; };
const item = (product_id, variant_id, quantity) => (variant_id ? { product_id, variant_id, quantity } : { product_id, quantity });
const nativeCart = (items, { merchant = IDS.SELLER_CONNECTED, market } = {}) => ({
  idempotency_key: freshKey(),
  quote: { merchant_id: merchant, items, customer_email: 'buyer@example.test' },
  ...(market ? { market } : {}),
});
const ucpCart = (lines, market = 'US') => ({
  meta: fx.ucpMeta(freshKey()),
  checkout: {
    line_items: lines.map(([id, quantity]) => ({ item: { id }, quantity })),
    buyer: { email: 'buyer@example.test' },
    ...(market ? { context: { address_country: market } } : {}),
  },
});
const ONE = IDS.SIG_CONNECTED;
const ONE_V = IDS.VARIANT_CONNECTED;
const TWO = IDS.SIG_TWO_VARIANTS;

async function kernelSession() {
  const created = await door.call('/mcp', 'create_checkout_session', nativeCart([item(ONE, ONE_V, 1)]));
  assert.equal(created.isError, false, created.raw.slice(0, 300));
  return created.value.session_id;
}

// ---- /mcp ---------------------------------------------------------------------------------------------------------

test('/mcp create and update: the same product and variant on two lines is refused by name, and nothing is sent anywhere', async () => {
  const sid = await kernelSession();
  for (const [label, items, groups] of [
    ['600 + 600 of one variant', [item(ONE, ONE_V, 600), item(ONE, ONE_V, 600)], [[1, 2]]],
    ['1 + 1', [item(ONE, ONE_V, 1), item(ONE, ONE_V, 1)], [[1, 2]]],
    ['no variant named, twice', [item(ONE, null, 600), item(ONE, null, 600)], [[1, 2]]],
    ['not adjacent, ids padded', [item(TWO, IDS.VARIANT_TWO_A, 1), item(ONE, ONE_V, 1), item(` ${TWO} `, `${IDS.VARIANT_TWO_A} `, 2)], [[1, 3]]],
    ['two groups', [item(TWO, IDS.VARIANT_TWO_B, 1), item(TWO, IDS.VARIANT_TWO_A, 1), item(TWO, IDS.VARIANT_TWO_A, 1), item(TWO, IDS.VARIANT_TWO_B, 1)], [[1, 4], [2, 3]]],
  ]) {
    assertDuplicateLines(await door.call('/mcp', 'create_checkout_session', nativeCart(items)), groups, `create ${label}`);
    assertDuplicateLines(await door.call('/mcp', 'update_checkout_session', { ...nativeCart(items), session_id: sid }), groups, `update ${label}`);
  }
});

test('/mcp: two different variants of one product are two lines: 999 units of each are priced as sent, on create and on update', async () => {
  const items = [item(TWO, IDS.VARIANT_TWO_A, 999), item(TWO, IDS.VARIANT_TWO_B, 999)];
  const created = await door.call('/mcp', 'create_checkout_session', nativeCart(items));
  assert.equal(created.isError, false, created.raw.slice(0, 300));
  assert.deepEqual(quoteCalls(created).map((c) => c.body.offer_refs.map((ref) => [ref.product_id, ref.variant_id, ref.quantity])), [
    [[TWO, IDS.VARIANT_TWO_A, 999], [TWO, IDS.VARIANT_TWO_B, 999]],
  ], 'one quote, two lines, each as sent');
  assertAnswerCurrency(JSON.parse(created.raw), 'USD', 'two variants');
  const updated = await door.call('/mcp', 'update_checkout_session', { ...nativeCart(items), session_id: created.value.session_id });
  assert.equal(updated.isError, false, updated.raw.slice(0, 300));
  assert.equal(quoteCalls(updated)[0].body.offer_refs.length, 2);
});

test('/mcp, a kernel row: a line that names a variant beside one that names none is never priced as one line: resolved to the same variant, it is refused before the quote', async () => {
  // The product has one variant, so the line that names none resolves to the variant the other line names. The door
  // cannot know that from the request (it reads the product to find out); once it does, the two lines are the same.
  const r = await door.call('/mcp', 'create_checkout_session', nativeCart([item(ONE, ONE_V, 600), item(ONE, null, 600)]));
  assert.equal(r.isError, true, r.raw.slice(0, 300));
  assert.deepEqual(errorOf(r), { code: 'QUOTE_REQUIRED', message: MESSAGE, retriable: false, detail: detailOf([[1, 2]]) });
  assert.deepEqual(quoteCalls(r), [], 'nothing was priced');
  assert.deepEqual(r.store, []);
  assert.ok(r.upstream.length > 0 && r.upstream.every((c) => c.body && c.body.operation === 'get_product_detail'), `only the read that resolves the variant: ${JSON.stringify(r.upstream).slice(0, 300)}`);
  // A product with two variants: the line that names none cannot be resolved at all, and keeps the refusal it always got.
  const ambiguous = await door.call('/mcp', 'create_checkout_session', nativeCart([item(TWO, IDS.VARIANT_TWO_A, 600), item(TWO, null, 600)]));
  assert.equal(ambiguous.isError, true, ambiguous.raw.slice(0, 300));
  assert.notEqual(errorOf(ambiguous).detail && errorOf(ambiguous).detail.reason, 'duplicate_line_for_product_variant');
  assert.deepEqual(quoteCalls(ambiguous), [], 'nothing was priced');
});

test('/mcp: a short key and a line above the ceiling are answered before the duplicate rule; a cart of one line is priced as before', async () => {
  const dup = [item(ONE, ONE_V, 1), item(ONE, ONE_V, 1)];
  const shortKey = await door.call('/mcp', 'create_checkout_session', { ...nativeCart(dup), idempotency_key: 'abcdefg' });
  assert.equal(errorOf(shortKey).detail.reason, 'idempotency_key_too_short');
  const over = await door.call('/mcp', 'create_checkout_session', nativeCart([item(ONE, ONE_V, 1000), item(ONE, ONE_V, 1)]));
  assert.equal(errorOf(over).detail.reason, 'quantity_above_line_maximum');
  const single = await door.call('/mcp', 'create_checkout_session', nativeCart([item(ONE, ONE_V, 999)]));
  assert.equal(single.isError, false, single.raw.slice(0, 300));
  assert.equal(quoteCalls(single)[0].body.offer_refs[0].quantity, 999);
});

// ---- /mcp: the partner door's own storefront cart -------------------------------------------------------------------

test('/mcp storefront cart (its switch on): a duplicate line reaches nothing, in every market and with none named; one line is priced in the market\'s currency', async () => {
  const FLAGS = ['AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED', 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET'];
  const saved = FLAGS.map((flag) => process.env[flag]);
  for (const flag of FLAGS) process.env[flag] = '1';
  try {
    const cart = (items, market) => nativeCart(items, { merchant: IDS.SELLER_STORE, market });
    for (const market of ['US', 'SG', 'GB', 'DE', null, 'ZZ']) {
      door.resetGate();
      assertDuplicateLines(await door.call('/mcp', 'create_checkout_session', cart([item(IDS.SIG_STORE, null, 600), item(IDS.SIG_STORE, null, 600)], market)), [[1, 2]], `storefront, market ${market}`);
    }
    // Within the rule, the standing answers: the priced market in its own currency, every other refused by name.
    door.resetGate();
    const priced = await door.call('/mcp', 'create_checkout_session', cart([item(IDS.SIG_STORE, null, 999)], 'US'));
    assert.equal(priced.isError, false, priced.raw.slice(0, 300));
    assert.equal(priced.store.find((c) => c.tool === 'create_cart').arguments.cart.line_items[0].quantity, 999);
    assertAnswerCurrency(JSON.parse(priced.raw), resolveServingCurrency('US'), 'US x a USD seller');
    for (const market of ['SG', 'GB', 'DE']) {
      door.resetGate();
      const other = await door.call('/mcp', 'create_checkout_session', cart([item(IDS.SIG_STORE, null, 1)], market));
      const expected = resolveServingCurrency(market) ? 'seller_not_priced_in_market_currency' : 'market_not_priced';
      assert.equal(other.value.error.detail.reason, expected, `${market}: ${other.raw.slice(0, 300)}`);
      assertAnswerCurrency(JSON.parse(other.raw), resolveServingCurrency(market), `${market} x a USD seller`);
      assert.equal(other.store.some((c) => c.tool === 'create_cart'), false, market);
    }
    const noMarket = await door.call('/mcp', 'create_checkout_session', cart([item(IDS.SIG_STORE, null, 1)], null));
    assert.equal(noMarket.value.error.detail.reason, 'market_required_for_seller_storefront', noMarket.raw.slice(0, 300));
    const unknown = await door.call('/mcp', 'create_checkout_session', cart([item(IDS.SIG_STORE, null, 1)], 'ZZ'));
    assert.equal(unknown.isError, true);
    assert.match(unknown.raw, /ZZ/, 'an unknown market is refused by name');
  } finally {
    FLAGS.forEach((flag, i) => {
      if (saved[i] === undefined) delete process.env[flag];
      else process.env[flag] = saved[i];
    });
  }
});

// ---- /ucp/mcp -----------------------------------------------------------------------------------------------------

test('/ucp/mcp create and update: the same item id on two lines is refused by name before any read, in every market and with none named', async () => {
  const sid = await kernelSession();
  for (const market of ['US', 'SG', 'GB', 'DE', null, 'ZZ']) {
    door.resetGate();
    // The seller's storefront product: no product read, no gate, no store.
    assertDuplicateLines(await door.call('/ucp/mcp', 'create_checkout', ucpCart([[IDS.SIG_STORE, 600], [IDS.SIG_STORE, 600]], market)), [[1, 2]], `storefront, market ${market}`);
    // The connected merchant's product (the kernel would price it): a bare id twice, and a named variant twice.
    assertDuplicateLines(await door.call('/ucp/mcp', 'create_checkout', ucpCart([[ONE, 600], [ONE, 600]], market)), [[1, 2]], `kernel, bare id, market ${market}`);
    assertDuplicateLines(await door.call('/ucp/mcp', 'create_checkout', ucpCart([[`${TWO}::v::${IDS.VARIANT_TWO_A}`, 1], [`${TWO}::v::${IDS.VARIANT_TWO_B}`, 1], [`${TWO}::v::${IDS.VARIANT_TWO_A}`, 1]], market)), [[1, 3]], `kernel, named variant, market ${market}`);
    assertDuplicateLines(await door.call('/ucp/mcp', 'update_checkout', { ...ucpCart([[ONE, 1], [ONE, 2]], market), id: sid }), [[1, 2]], `update, market ${market}`);
  }
});

test('/ucp/mcp: two different variants of one product are two lines, sent to be priced as named', async () => {
  const r = await door.call('/ucp/mcp', 'create_checkout', ucpCart([[`${TWO}::v::${IDS.VARIANT_TWO_A}`, 999], [`${TWO}::v::${IDS.VARIANT_TWO_B}`, 999]]));
  assert.deepEqual(quoteCalls(r).map((c) => c.body.offer_refs.map((ref) => [ref.variant_id, ref.quantity])), [
    [[IDS.VARIANT_TWO_A, 999], [IDS.VARIANT_TWO_B, 999]],
  ], `one quote, two lines: ${r.raw.slice(0, 300)}`);
});

test('/ucp/mcp, a kernel row: a named variant beside the bare product id is never priced as one line', async () => {
  const r = await door.call('/ucp/mcp', 'create_checkout', ucpCart([[`${ONE}::v::${ONE_V}`, 600], [ONE, 600]]));
  assert.equal(r.isError, true, r.raw.slice(0, 300));
  assert.deepEqual(quoteCalls(r), [], 'nothing was priced');
  assert.deepEqual(r.store, []);
  assert.deepEqual(errorOf(r).detail, detailOf([[1, 2]]), r.raw.slice(0, 300));
});

test('/ucp/mcp: a storefront cart of one line is still handed to the store, 999 units, in the market\'s currency', async () => {
  door.resetGate();
  const r = await door.call('/ucp/mcp', 'create_checkout', ucpCart([[IDS.SIG_STORE, 999]]));
  assert.equal(r.isError, false, r.raw.slice(0, 300));
  assert.equal(r.store.find((c) => c.tool === 'create_cart').arguments.cart.line_items[0].quantity, 999);
  assertAnswerCurrency(JSON.parse(r.raw), 'USD', 'storefront, US');
});

// ---- after the refusal: the merged cart, with the SAME key --------------------------------------------------------------
//
// The refusal says "merge those lines and send the request again". A caller that corrects a create reuses its key.

test('ACP REST, a kernel row: a named variant beside an unnamed line is refused before the key is claimed; the merged cart with the same key is then created and priced once', async () => {
  for (const [label, refusedCart] of [
    ['named + unnamed, resolved to the same variant', [item(ONE, ONE_V, 600), item(ONE, null, 600)]],
    ['unnamed + named', [item(ONE, null, 1), item(ONE, ONE_V, 2)]],
    ['the same variant named twice', [item(ONE, ONE_V, 600), item(ONE, ONE_V, 600)]],
  ]) {
    const key = freshKey();
    const refused = await door.acp('POST', '/checkout_sessions', acpCart(refusedCart), { key });
    assert.equal(refused.http, 400, `${label}: ${refused.raw.slice(0, 300)}`);
    assert.deepEqual(refused.body, { type: 'error', code: 'QUOTE_REQUIRED', message: MESSAGE, detail: detailOf([[1, 2]]) }, label);
    assert.deepEqual(quoteCalls(refused), [], `${label}: nothing was priced`);
    assert.deepEqual(refused.store, [], label);
    // The same key, the lines merged: a FIRST create (201), priced once. A claim left behind by the refused attempt
    // would answer 404 here for as long as the claim lives.
    const merged = await door.acp('POST', '/checkout_sessions', acpCart([item(ONE, ONE_V, 999)]), { key });
    assert.equal(merged.http, 201, `${label}: the merged cart with the same key: ${merged.raw.slice(0, 300)}`);
    assert.equal(quoteCalls(merged).length, 1, `${label}: one quote`);
    assert.deepEqual(quoteCalls(merged)[0].body.offer_refs.map((ref) => [ref.variant_id, ref.quantity]), [[ONE_V, 999]], label);
    // And from here the key is that session's: the same request again is a replay of it, not a second create.
    const replay = await door.acp('POST', '/checkout_sessions', acpCart([item(ONE, ONE_V, 999)]), { key });
    assert.equal(replay.http, 200, `${label}: ${replay.raw.slice(0, 200)}`);
    assert.equal(replay.body.id, merged.body.id, label);
    assert.deepEqual(quoteCalls(replay), [], label);
  }
  // On update the same pair is refused too, and the session keeps the quote it had.
  const created = await door.acp('POST', '/checkout_sessions', acpCart([item(ONE, ONE_V, 1)]), { key: freshKey() });
  const update = await door.acp('POST', `/checkout_sessions/${created.body.id}`, acpCart([item(ONE, ONE_V, 600), item(ONE, null, 600)]), { key: freshKey() });
  assert.equal(update.http, 400, update.raw.slice(0, 300));
  assert.deepEqual(update.body.detail, detailOf([[1, 2]]));
  assert.deepEqual(quoteCalls(update), []);
  const mergedUpdate = await door.acp('POST', `/checkout_sessions/${created.body.id}`, acpCart([item(ONE, ONE_V, 999)]), { key: freshKey() });
  assert.equal(mergedUpdate.http, 200, mergedUpdate.raw.slice(0, 300));
});

test('/mcp and /ucp/mcp, a kernel row: after the same refusal the merged cart with the same key is priced', async () => {
  const nativeKey = freshKey();
  const refused = await door.call('/mcp', 'create_checkout_session', { ...nativeCart([item(ONE, ONE_V, 600), item(ONE, null, 600)]), idempotency_key: nativeKey });
  assert.deepEqual(errorOf(refused).detail, detailOf([[1, 2]]), refused.raw.slice(0, 300));
  const merged = await door.call('/mcp', 'create_checkout_session', { ...nativeCart([item(ONE, ONE_V, 999)]), idempotency_key: nativeKey });
  assert.equal(merged.isError, false, merged.raw.slice(0, 300));
  assert.equal(quoteCalls(merged).length, 1);

  const ucpKey = freshKey();
  const ucpRefused = await door.call('/ucp/mcp', 'create_checkout', { ...ucpCart([[`${ONE}::v::${ONE_V}`, 600], [ONE, 600]]), meta: fx.ucpMeta(ucpKey) });
  assert.deepEqual(errorOf(ucpRefused).detail, detailOf([[1, 2]]), ucpRefused.raw.slice(0, 300));
  const ucpMerged = await door.call('/ucp/mcp', 'create_checkout', { ...ucpCart([[`${ONE}::v::${ONE_V}`, 999]]), meta: fx.ucpMeta(ucpKey) });
  assert.equal(quoteCalls(ucpMerged).length, 1, `the merged cart reaches the quote: ${ucpMerged.raw.slice(0, 300)}`);
  assert.notEqual(errorOf(ucpMerged) && errorOf(ucpMerged).code, 'IDEMPOTENCY_CONFLICT');
});

// ---- a storefront row: named beside unnamed ----------------------------------------------------------------------------

test('a storefront row, both doors: a named variant beside the bare product is NOT this rule\'s refusal; no cart is built at the store, the answer is the hand-off to the seller\'s page', async () => {
  // The store-cart builder declines two lines of one store variant (its own, older check) and the door falls back
  // to the hand-off. Nothing is sent to the store either way.
  door.resetGate();
  const ucp = await door.call('/ucp/mcp', 'create_checkout', ucpCart([[`${IDS.SIG_STORE}::v::${IDS.VARIANT_STORE}`, 600], [IDS.SIG_STORE, 600]]));
  assert.equal(ucp.isError, false, ucp.raw.slice(0, 300));
  assert.equal(ucp.value.status, 'requires_escalation');
  assert.equal(ucp.value.continue_url, `https://${fx.STORE_HOST}/products/calm-serum?variant=${IDS.VARIANT_STORE}`, 'the product page, not a store cart');
  assert.deepEqual(ucp.value.line_items.map((l) => l.quantity), [600, 600], 'the two lines as sent, not one summed line');
  assert.deepEqual(ucp.store, [], 'no store call: no cart was built');
  assert.deepEqual(ucp.upstream.map((c) => c.to), ['catalog', 'gate'], 'the product read and the gate, nothing else');
  const FLAGS = ['AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED', 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET'];
  const saved = FLAGS.map((flag) => process.env[flag]);
  for (const flag of FLAGS) process.env[flag] = '1';
  try {
    door.resetGate();
    const native = await door.call('/mcp', 'create_checkout_session', nativeCart([item(IDS.SIG_STORE, IDS.VARIANT_STORE, 600), item(IDS.SIG_STORE, null, 600)], { merchant: IDS.SELLER_STORE, market: 'US' }));
    assert.equal(native.isError, false, native.raw.slice(0, 300));
    assert.equal(native.value.status, 'completes_on_seller_storefront');
    assert.deepEqual(native.value.line_items.map((l) => l.quantity), [600, 600]);
    assert.deepEqual(native.store, [], 'no store call: no cart was built');
    assert.deepEqual(native.upstream.map((c) => c.to), ['catalog', 'gate']);
    assertAnswerCurrency(JSON.parse(native.raw), resolveServingCurrency('US'), 'storefront hand-off, US');
  } finally {
    FLAGS.forEach((flag, i) => { if (saved[i] === undefined) delete process.env[flag]; else process.env[flag] = saved[i]; });
  }
});

// ---- the invoke door: named beside unnamed ----------------------------------------------------------------------------

test('invoke, every route: a named variant beside an unnamed line is NOT refused (nothing here reads the product); the two lines go to be priced as two different keys, never as one', async () => {
  // THE RESIDUAL, stated: the other doors resolve the unnamed line and refuse the pair; the invoke door cannot. Its
  // quote body carries the unnamed line as the variant that restates the product id, so what prices the cart is
  // asked about (product, variant) and (product, product): two keys, whose quantities it does not add together.
  for (const [label, route, strict] of INVOKE_WAYS) {
    for (const product of [ONE, TWO]) {
      const variant = product === ONE ? ONE_V : IDS.VARIANT_TWO_A;
      const r = await door.invoke(route, 'preview_quote', invokeQuote([item(product, variant, 600), item(product, null, 600)]), { strict });
      assert.notEqual(r.body && r.body.detail && r.body.detail.reason, 'duplicate_line_for_product_variant', `${label}: ${r.raw.slice(0, 200)}`);
      assert.equal(quoteCalls(r).length, 1, `${label}: ${r.raw.slice(0, 200)}`);
      assert.deepEqual(quoteCalls(r)[0].body.offer_refs.map((ref) => [ref.product_id, ref.variant_id, ref.quantity]), [[product, variant, 600], [product, product, 600]], `${label}: two keys, 600 each`);
    }
    // Two unnamed lines ARE one key on this door, and are refused.
    assertInvokeDuplicateLines(await door.invoke(route, 'preview_quote', invokeQuote([item(TWO, null, 600), item(TWO, null, 600)]), { strict }), [[1, 2]], `${label} unnamed twice`);
  }
});

// ---- the completion line ------------------------------------------------------------------------------------------

test('the tools/call completion line names the duplicate-line refusal, on both doors, and nothing from the cart', async () => {
  const logger = require('../src/logger');
  for (const [doorName, send] of [
    ['mcp', () => door.call('/mcp', 'create_checkout_session', nativeCart([item(ONE, ONE_V, 600), item(ONE, ONE_V, 600)]))],
    ['ucp_mcp', () => door.call('/ucp/mcp', 'create_checkout', ucpCart([[IDS.SIG_STORE, 600], [IDS.SIG_STORE, 600]]))],
  ]) {
    const lines = [];
    const real = logger.info;
    logger.info = (obj, msg) => { if (msg === 'mcp tools/call complete') lines.push(obj); };
    try {
      await send();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      logger.info = real;
    }
    assert.equal(lines.length, 1, doorName);
    assert.equal(lines[0].door, doorName);
    assert.equal(lines[0].outcome, 'tool_error', doorName);
    assert.equal(lines[0].error_code, 'QUOTE_REQUIRED', doorName);
    assert.equal(lines[0].error_reason, 'duplicate_line_for_product_variant', doorName);
    const text = JSON.stringify(lines[0]);
    for (const sent of [ONE, ONE_V, IDS.SIG_STORE, 'buyer@example.test', 'idem-dupl']) assert.ok(!text.includes(sent), `${doorName}: ${sent} is not logged`);
  }
});

// ---- ACP REST -----------------------------------------------------------------------------------------------------

const acpCart = (items) => ({ merchant_id: IDS.SELLER_CONNECTED, items });
function assertAcpDuplicateLines(r, groups, label) {
  assert.equal(r.http, 400, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(r.body, { type: 'error', code: 'QUOTE_REQUIRED', message: MESSAGE, detail: detailOf(groups) }, label);
  sentNothing(r, label);
}

test('ACP REST create and update: a duplicate line is refused by name with nothing sent; two variants of one product are priced as sent', async () => {
  const created = await door.acp('POST', '/checkout_sessions', acpCart([item(TWO, IDS.VARIANT_TWO_A, 999), item(TWO, IDS.VARIANT_TWO_B, 999)]), { key: freshKey() });
  assert.equal(created.http, 201, created.raw.slice(0, 300));
  assert.deepEqual(quoteCalls(created)[0].body.offer_refs.map((ref) => [ref.variant_id, ref.quantity]), [[IDS.VARIANT_TWO_A, 999], [IDS.VARIANT_TWO_B, 999]]);
  for (const [label, items, groups] of [
    ['600 + 600', [item(ONE, ONE_V, 600), item(ONE, ONE_V, 600)], [[1, 2]]],
    ['no variant twice', [item(ONE, null, 1), item(ONE, null, 1)], [[1, 2]]],
    ['third line', [item(TWO, IDS.VARIANT_TWO_A, 1), item(TWO, IDS.VARIANT_TWO_B, 1), item(TWO, IDS.VARIANT_TWO_A, 1)], [[1, 3]]],
  ]) {
    assertAcpDuplicateLines(await door.acp('POST', '/checkout_sessions', acpCart(items), { key: freshKey() }), groups, `create ${label}`);
    assertAcpDuplicateLines(await door.acp('POST', `/checkout_sessions/${created.body.id}`, acpCart(items), { key: freshKey() }), groups, `update ${label}`);
    // A session id nobody has: the cart is refused, and nothing is said about whether the session exists.
    assertAcpDuplicateLines(await door.acp('POST', '/checkout_sessions/cs_nobody_has_this', acpCart(items), { key: freshKey() }), groups, `update of an unknown session ${label}`);
  }
  // A caller with no verified buyer is told that first, whatever the cart says.
  const noBuyer = await door.acp('POST', '/checkout_sessions', acpCart([item(ONE, ONE_V, 1), item(ONE, ONE_V, 1)]), { key: freshKey(), buyer: false });
  assert.equal(noBuyer.http, 401, noBuyer.raw.slice(0, 200));
  // Named beside unnamed, resolved to the same variant: refused before the quote.
  const mixed = await door.acp('POST', '/checkout_sessions', acpCart([item(ONE, ONE_V, 600), item(ONE, null, 600)]), { key: freshKey() });
  assert.equal(mixed.http, 400, mixed.raw.slice(0, 300));
  assert.deepEqual(mixed.body.detail, detailOf([[1, 2]]));
  assert.deepEqual(quoteCalls(mixed), [], 'nothing was priced');
});

// ---- the invoke routes --------------------------------------------------------------------------------------------

const SHOP = '/agent/shop/v1/invoke';
const CREATOR = '/agent/creator/v1/invoke';
const INVOKE_WAYS = [
  ['shop, strict', SHOP, true],
  ['shop, strict off', SHOP, false],
  ['creator alias, strict', CREATOR, true],
  ['creator alias, strict off', CREATOR, false],
];
const invokeRefusal = (groups) => ({ status: 'failure', error: 'QUOTE_REQUIRED', code: 'QUOTE_REQUIRED', message: MESSAGE, retriable: false, detail: detailOf(groups) });
const invokeQuote = (items, extra = {}) => ({ quote: { merchant_id: IDS.SELLER_CONNECTED, items, customer_email: 'buyer@example.test' }, ...extra });
function assertInvokeDuplicateLines(r, groups, label) {
  assert.equal(r.http, 422, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(r.body, invokeRefusal(groups), label);
  sentNothing(r, label);
}

test('invoke preview_quote: a duplicate line is refused by name with nothing sent, on every route; two variants of one product are priced as sent', async () => {
  for (const [label, route, strict] of INVOKE_WAYS) {
    assertInvokeDuplicateLines(await door.invoke(route, 'preview_quote', invokeQuote([item(ONE, ONE_V, 600), item(ONE, ONE_V, 600)]), { strict }), [[1, 2]], `${label} 600 + 600`);
    assertInvokeDuplicateLines(await door.invoke(route, 'preview_quote', invokeQuote([item(TWO, IDS.VARIANT_TWO_A, 1), item(ONE, ONE_V, 1), item(TWO, IDS.VARIANT_TWO_A, 1)]), { strict }), [[1, 3]], `${label} third line`);
    // On this door a line that names no variant is priced as the variant that restates its product id, so two
    // such lines are one product and variant.
    assertInvokeDuplicateLines(await door.invoke(route, 'preview_quote', invokeQuote([item(ONE, null, 1), item(ONE, null, 1)]), { strict }), [[1, 2]], `${label} no variant twice`);
    const two = await door.invoke(route, 'preview_quote', invokeQuote([item(TWO, IDS.VARIANT_TWO_A, 999), item(TWO, IDS.VARIANT_TWO_B, 999)]), { strict });
    assert.equal(two.http, 200, `${label}: ${two.raw.slice(0, 300)}`);
    assert.deepEqual(quoteCalls(two)[0].body.offer_refs.map((ref) => [ref.variant_id, ref.quantity]), [[IDS.VARIANT_TWO_A, 999], [IDS.VARIANT_TWO_B, 999]], label);
    const one = await door.invoke(route, 'preview_quote', invokeQuote([item(ONE, ONE_V, 999)]), { strict });
    assert.equal(one.http, 200, `${label}: ${one.raw.slice(0, 300)}`);
  }
});

test('invoke, the gateway\'s own handler: a line is identified as its quote body is built, and two offers of one variant are one variant', async () => {
  for (const [label, route, strict] of INVOKE_WAYS.filter(([, , on]) => !on)) {
    // The same variant under two offers: what prices the cart adds the two lines together whatever offer each names.
    const offers = [{ ...item(ONE, ONE_V, 600), offer_id: 'of_placeholder_a' }, { ...item(ONE, ONE_V, 600), offer_id: 'of_placeholder_b' }];
    assertInvokeDuplicateLines(await door.invoke(route, 'preview_quote', invokeQuote(offers), { strict }), [[1, 2]], `${label} two offers`);
    // Its other spellings of a line's ids.
    assertInvokeDuplicateLines(await door.invoke(route, 'preview_quote', invokeQuote([{ productId: ONE, variantId: ONE_V, quantity: 1 }, item(ONE, ONE_V, 1)]), { strict }), [[1, 2]], `${label} camel case`);
    assertInvokeDuplicateLines(await door.invoke(route, 'preview_quote', invokeQuote([{ product_id: ONE, sku: ONE_V, quantity: 1 }, item(ONE, ONE_V, 1)]), { strict }), [[1, 2]], `${label} sku`);
    // create_order on this handler may carry lines of its own (it re-quotes them): the same rule.
    const order = (items) => ({
      idempotency_key: freshKey(),
      order: { quote_id: 'q_placeholder', customer_email: 'buyer@example.test', items,
        shipping_address: { country: 'US', city: 'Springfield', postal_code: '00000', address_line1: '1 Example Street', recipient_name: 'Example Buyer' } },
    });
    assertInvokeDuplicateLines(await door.invoke(route, 'create_order', order([item(ONE, ONE_V, 600), item(ONE, ONE_V, 600)]), { strict }), [[1, 2]], `${label} create_order`);
    const distinct = await door.invoke(route, 'create_order', order([item(TWO, IDS.VARIANT_TWO_A, 1), item(TWO, IDS.VARIANT_TWO_B, 1)]), { strict });
    assert.notEqual(distinct.body && distinct.body.detail && distinct.body.detail.reason, 'duplicate_line_for_product_variant', `${label}: ${distinct.raw.slice(0, 200)}`);
  }
});

for (const address of [SHOP, CREATOR]) test(`${address} invoke, strict contract: an order is priced from its locked quote, so duplicate lines beside it are not read and not judged`, async () => {
  const r = await door.invoke(address, 'create_order', {
    idempotency_key: freshKey(),
    order: { quote_id: 'q_placeholder', customer_email: 'buyer@example.test', items: [item(ONE, ONE_V, 1), item(ONE, ONE_V, 1)],
      shipping_address: { country: 'US', city: 'Springfield', postal_code: '00000', address_line1: '1 Example Street', recipient_name: 'Example Buyer' } },
  });
  assert.notEqual(r.body && r.body.detail && r.body.detail.reason, 'duplicate_line_for_product_variant', r.raw.slice(0, 200));
});

// ---- tools/list ---------------------------------------------------------------------------------------------------

test('tools/list: both checkout doors say it on each cart\'s line-item list; the public door publishes no cart', async () => {
  const { DUPLICATE_LINES_SENTENCE } = require('./_support/lineQuantityMaximumSchemaEdit.cjs');
  const { DUPLICATE_LINES_SENTENCE: runtimeSentence } = require('../safety-kernel/src/protocol/intakeBounds.cjs');
  assert.equal(DUPLICATE_LINES_SENTENCE, runtimeSentence, 'the reversal helper reverses the sentence the runtime publishes');
  const count = (tools) => JSON.stringify(tools).split(DUPLICATE_LINES_SENTENCE).length - 1;
  const native = await door.listTools('/mcp');
  assert.equal(count(native), 2);
  for (const name of ['create_checkout_session', 'update_checkout_session']) {
    assert.equal(native.find((t) => t.name === name).inputSchema.properties.quote.properties.items.description, DUPLICATE_LINES_SENTENCE, name);
  }
  const ucp = await door.listTools('/ucp/mcp');
  assert.equal(count(ucp), 2);
  for (const name of ['create_checkout', 'update_checkout']) {
    assert.ok(ucp.find((t) => t.name === name).inputSchema.properties.checkout.properties.line_items.description.endsWith(DUPLICATE_LINES_SENTENCE), name);
  }
  assert.equal(count(await door.listTools('/public/mcp')), 0);
});
