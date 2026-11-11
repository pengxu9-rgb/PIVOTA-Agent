'use strict';

// THE `/mcp` DOOR REACHES THE SELLER'S OWN CART (AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED).
//
// Before the flag, a partner on `/mcp` could never get a store's cart, totals and link: only the UCP door
// (`/ucp/mcp`) took the storefront path, and a native create_checkout_session for a seller Pivota is not
// connected to ended in `ucp_storefront_checkout_unavailable`.
//
// END TO END over the real doors (tests/_support/mcpStorefrontCartDoor.cjs says what is real and what is
// stubbed): one child process runs the whole request set with the flag off, then with it on. `off` and `on`
// below are those two sets of answers, each with what reached the seller's storefront (`store`), the backend
// (`upstream`) and the purchasability ops route (`gate`) during that call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { IDS, HOST, STORE_PRICE, gid, LEGACY_ESC_ID } = require('./_support/mcpStorefrontCartDoor.cjs');

const CHILD = path.join(__dirname, '_support', 'mcpStorefrontCartDoorChild.cjs');
const ORIGINAL_ENV = { ...process.env };
test.after(() => { process.env = { ...ORIGINAL_ENV }; });

function runChild(port, env = {}) {
  const res = spawnSync(process.execPath, [CHILD, String(port)], {
    env: { ...process.env, COMBO_PARTNER_DOOR: '', COMBO_EMPTY_REASON: '', ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 240000,
  });
  const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('DOOR_RESULT '));
  assert.ok(line, `the door child printed no result (exit ${res.status}): ${String(res.stderr || '').slice(-2000)}`);
  return JSON.parse(line.slice('DOOR_RESULT '.length));
}

const { off, on } = runChild(4421);

// Wall-clock timestamps and the kernel's random quote ids are the only bytes that differ between two runs of
// the same request; everything else is compared exactly.
const mask = (text) => String(text)
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>')
  .replace(/q_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'q_<random>');
const errorOf = (answer) => (answer.value && answer.value.error) || null;
const reasonOf = (answer) => { const e = errorOf(answer); return e && e.detail ? e.detail.reason : null; };
const codesOf = (answer) => ((answer.value && answer.value.messages) || []).map((m) => m.code);
const toolsSent = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);
const decodeEsc = (id) => JSON.parse(Buffer.from(String(id).slice(4), 'base64url').toString('utf8'));
const totalOf = (answer, type) => answer.value.totals.find((t) => t.type === type).amount;
const mcpKeys = Object.keys(on).filter((k) => k.startsWith('mcp.'));
const otherDoorKeys = Object.keys(on).filter((k) => !k.startsWith('mcp.'));

// ---- flag on: the store's cart ------------------------------------------------------------------------------

test('priced by the store: the native answer carries the store\'s lines, totals, currency, link, an esc_ id and an expiry', () => {
  const a = on['mcp.create_priced'];
  assert.equal(a.isError, false, a.raw);
  const v = a.value;
  assert.equal(v.status, 'completes_on_seller_storefront');
  assert.notEqual(v.status, 'ready_for_payment');
  assert.match(v.session_id, /^esc_/);
  assert.equal(v.currency, 'USD');
  assert.equal(v.amount_unit, 'minor');
  // The STORE's price (27.50), not the catalog's (25.00).
  assert.equal(STORE_PRICE[IDS.VARIANT_A], 2750);
  assert.equal(v.line_items.length, 1);
  assert.equal(v.line_items[0].product_id, IDS.SIG_A);
  assert.equal(v.line_items[0].quantity, 1);
  assert.equal(v.line_items[0].item.price, 2750);
  assert.equal(totalOf(a, 'subtotal'), 2750);
  assert.equal(totalOf(a, 'total'), 2750);
  assert.match(v.totals[0].display_text, /priced by the seller's storefront/);
  const link = new URL(v.continue_url);
  assert.equal(link.protocol, 'https:');
  assert.equal(link.hostname, HOST.A);
  assert.match(link.pathname, /^\/cart\/c\/cart_store-a_/);
  assert.ok(Date.parse(v.expires_at) > Date.now(), 'an expiry in the future');
  assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront']);
  assert.equal(v.market_assumed, undefined);
  // The native shape: no UCP envelope, no UCP status, no second id.
  assert.equal(v.ucp, undefined);
  assert.equal(v.id, undefined);
  assert.equal(JSON.stringify(v).includes('requires_escalation'), false);
  // The id is the escalation's own: the seller's cart id, bound to the seller, for the named market.
  const id = decodeEsc(v.session_id);
  assert.deepEqual(Object.keys(id).sort(), ['c', 'h', 'i', 'm', 'v']);
  assert.deepEqual([id.v, id.h, id.m, id.i], [2, HOST.A, 'US', [[IDS.SIG_A, 1]]]);
  assert.equal(link.pathname.endsWith(id.c), true);
});

test('priced by the store: exactly one create_cart reached the seller, with the variant, the quantity and the market, and no buyer data', () => {
  const a = on['mcp.create_priced'];
  const tools = a.store.filter((c) => c.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].host, HOST.A);
  assert.equal(tools[0].tool, 'create_cart');
  assert.deepEqual(tools[0].arguments, { cart: { line_items: [{ item: { id: gid(IDS.VARIANT_A) }, quantity: 1 }], context: { address_country: 'US' } } });
  assert.equal(tools[0].has_authorization, false);
  assert.equal(JSON.stringify(a.store).includes('buyer@example.test'), false);
  assert.deepEqual(a.gate, [{ domain: HOST.A, market: 'US' }], 'the purchasability gate was asked about the seller, for the named market');
});

test('the same request on the UCP door gets the same cart facts: same code, same totals, same link host', () => {
  const native = on['mcp.create_priced'].value;
  const ucp = on['ucp.create_priced'].value;
  assert.equal(ucp.status, 'requires_escalation');
  assert.deepEqual(codesOf(on['ucp.create_priced']), codesOf(on['mcp.create_priced']));
  assert.deepEqual(native.totals, ucp.totals);
  assert.equal(native.currency, ucp.currency);
  assert.deepEqual(native.line_items.map(({ product_id: _p, ...line }) => line), ucp.line_items);
  assert.deepEqual(native.messages, ucp.messages);
  assert.deepEqual(native.links, ucp.links);
  assert.equal(new URL(native.continue_url).hostname, new URL(ucp.continue_url).hostname);
});

test('several products of one seller: one cart, every line the store\'s', () => {
  const a = on['mcp.create_two_products'];
  assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront']);
  assert.deepEqual(a.value.line_items.map((l) => [l.product_id, l.quantity, l.item.price]), [[IDS.SIG_A, 2, 2750], [IDS.SIG_A_SECOND, 3, 1200]]);
  assert.equal(totalOf(a, 'total'), 2 * 2750 + 3 * 1200);
  assert.deepEqual(toolsSent(a), ['create_cart']);
});

test('fallback: a store answer the door rejects (cart link on another host) is answered from the catalog, and says so', () => {
  const a = on['mcp.create_fallback'];
  assert.equal(a.isError, false, a.raw);
  // The store WAS asked, and answered with a link that is not on its own host.
  assert.deepEqual(toolsSent(a), ['create_cart']);
  assert.deepEqual(codesOf(a), ['checkout.completes_on_seller_storefront']);
  assert.equal(a.value.status, 'completes_on_seller_storefront');
  // The catalog's price (30.00) and the product page, never the rejected cart link.
  assert.equal(totalOf(a, 'total'), 3000);
  assert.match(a.value.totals[0].display_text, /catalog's last observed price/);
  assert.equal(a.value.continue_url, `https://${HOST.B}/products/barrier-cream?variant=${IDS.VARIANT_B}`);
  assert.equal(a.raw.includes('elsewhere.example'), false);
  const id = decodeEsc(a.value.session_id);
  assert.deepEqual([id.v, id.m, id.c, id.h], [1, 'US', undefined, undefined]);
});

test('fallback: a store that answers in another currency than the catalog\'s is rejected the same way', () => {
  const a = on['mcp.create_store_answers_other_currency'];
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(toolsSent(a), ['create_cart']);
  assert.deepEqual(codesOf(a), ['checkout.completes_on_seller_storefront']);
  assert.equal(a.value.currency, 'USD');
  assert.equal(totalOf(a, 'total'), 4000);
  assert.equal(a.value.continue_url, `https://${HOST.D}/products/hand-cream?variant=${IDS.VARIANT_D}`);
  assert.equal(a.raw.includes('EUR'), false);
});

test('gate decline: merchant_not_purchasable, no link, and the store is never contacted', () => {
  const a = on['mcp.create_declined'];
  assert.equal(a.isError, true);
  assert.equal(errorOf(a).code, 'NO_MERCHANT_OFFER');
  assert.equal(reasonOf(a), 'merchant_not_purchasable');
  assert.equal(errorOf(a).retriable, false);
  assert.deepEqual(a.store, []);
  assert.deepEqual(a.gate, [{ domain: HOST.C, market: 'US' }]);
  assert.equal(a.raw.includes(`https://${HOST.C}`), false, 'no storefront link is handed out for a declined seller');
  assert.equal(errorOf(a).market_assumed, undefined);
  // The UCP door refuses the same cart the same way.
  assert.equal(reasonOf(on['ucp.create_declined']), 'merchant_not_purchasable');
  assert.equal(errorOf(a).message, errorOf(on['ucp.create_declined']).message);
});

test('no verified buyer: USER_AUTH_REQUIRED before anything is read, on create and on re-read', () => {
  for (const key of ['mcp.create_no_buyer', 'mcp.get_no_buyer']) {
    const a = on[key];
    assert.equal(a.isError, true, key);
    assert.equal(errorOf(a).code, 'USER_AUTH_REQUIRED', key);
    assert.deepEqual([a.store, a.upstream, a.gate], [[], [], []], key);
    // Exactly the answer with the flag off, and the UCP door's.
    assert.equal(a.raw, off[key].raw, key);
  }
  assert.equal(errorOf(on['ucp.create_no_buyer']).code, 'USER_AUTH_REQUIRED');
});

test('unresolved variant: several options and no choice is never carted; the catalog answer is given', () => {
  const a = on['mcp.create_unresolved_variant'];
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(toolsSent(a), [], 'no cart is built on a guess');
  assert.deepEqual(codesOf(a), ['checkout.completes_on_seller_storefront']);
  assert.equal(a.value.continue_url, `https://${HOST.A}/products/body-lotion`);
  assert.deepEqual(codesOf(on['ucp.create_unresolved_variant']), codesOf(a));
});

test('a chosen variant is carted as that variant; a variant the product does not have is refused before any store call', () => {
  const chosen = on['mcp.create_chosen_variant'];
  assert.deepEqual(codesOf(chosen), ['checkout.priced_by_seller_storefront']);
  assert.equal(chosen.value.line_items[0].variant_id, IDS.VARIANT_A_MULTI[1]);
  assert.equal(chosen.value.line_items[0].product_id, IDS.SIG_A_MULTI);
  assert.equal(totalOf(chosen, 'total'), STORE_PRICE[IDS.VARIANT_A_MULTI[1]]);
  const sent = chosen.store.filter((c) => c.kind === 'tool');
  assert.deepEqual(sent.map((c) => c.arguments.cart.line_items), [[{ item: { id: gid(IDS.VARIANT_A_MULTI[1]) }, quantity: 1 }]]);
  const unknown = on['mcp.create_unknown_variant'];
  assert.equal(reasonOf(unknown), 'ucp_variant_not_in_product');
  assert.deepEqual(unknown.store, []);
});

test('mixed sellers: two sellers\' items in one checkout are refused; nothing is carted anywhere', () => {
  const a = on['mcp.create_mixed_sellers_shared_name'];
  assert.equal(a.isError, true);
  assert.equal(reasonOf(a), 'ucp_multi_seller_escalation');
  assert.deepEqual(errorOf(a).detail.seller_hosts.sort(), [HOST.A, HOST.D]);
  assert.deepEqual(a.store, []);
  assert.equal(reasonOf(on['ucp.create_mixed_sellers']), 'ucp_multi_seller_escalation');
});

test('a quote that names one seller for another seller\'s product does not get that seller\'s cart: answered exactly as with the flag off', () => {
  for (const key of ['mcp.create_mixed_sellers_named_seller', 'mcp.create_other_sellers_product', 'mcp.create_connected_seller_storefront_product']) {
    assert.equal(on[key].isError, true, key);
    assert.equal(on[key].raw, off[key].raw, key);
    assert.deepEqual(on[key].store, [], key);
    assert.deepEqual(on[key].gate, [], key);
  }
});

test('a connected merchant\'s cart still goes to the kernel exactly as with the flag off: same quote, same upstream calls, no store, no gate', () => {
  for (const key of ['mcp.create_connected', 'mcp.create_connected_variant', 'mcp.update_kernel_unknown']) {
    const a = on[key];
    assert.equal(a.isError, false, `${key}: ${a.raw}`);
    assert.equal(a.value.status, 'ready_for_payment', key);
    assert.match(a.value.session_id, /^q_/, key);
    assert.equal(a.value.merchant_of_record, IDS.SELLER_CONNECTED, key);
    assert.equal(mask(a.raw), mask(off[key].raw), key);
    assert.deepEqual(a.upstream, off[key].upstream, key);
    assert.ok(a.upstream.some((u) => u.op === 'quotes.preview' && u.merchant_id === IDS.SELLER_CONNECTED), key);
    assert.deepEqual([a.store, a.gate], [[], []], key);
  }
  // `market` on a cart the kernel prices is accepted and changes nothing.
  assert.equal(mask(on['mcp.create_connected_with_market'].raw), mask(on['mcp.create_connected_variant'].raw));
  assert.deepEqual(on['mcp.create_connected_with_market'].upstream, on['mcp.create_connected_variant'].upstream);
});

test('get_checkout_session on the esc_ id reads the SAME cart back: one get_cart, no new cart', () => {
  const created = on['mcp.create_priced'];
  const read = on['mcp.get_own_created'];
  assert.equal(read.isError, false, read.raw);
  assert.equal(read.value.session_id, created.value.session_id);
  assert.equal(read.value.status, 'completes_on_seller_storefront');
  assert.deepEqual(read.value.line_items, created.value.line_items);
  assert.deepEqual(read.value.totals, created.value.totals);
  assert.equal(read.value.continue_url, created.value.continue_url);
  assert.deepEqual(codesOf(read), ['checkout.priced_by_seller_storefront']);
  const sent = read.store.filter((c) => c.kind === 'tool');
  assert.deepEqual(sent.map((c) => [c.host, c.tool, c.arguments]), [[HOST.A, 'get_cart', { id: decodeEsc(created.value.session_id).c }]]);
});

test('get_checkout_session reads an id the UCP door minted, and answers what the UCP door answers for it', () => {
  for (const [nativeKey, ucpKey] of [['mcp.get_priced', 'ucp.get_priced'], ['mcp.get_fallback', 'ucp.get_fallback']]) {
    const native = on[nativeKey].value;
    const ucp = on[ucpKey].value;
    assert.equal(on[nativeKey].isError, false, on[nativeKey].raw);
    assert.equal(native.session_id, ucp.id);
    assert.deepEqual(native.totals, ucp.totals);
    assert.deepEqual(native.messages, ucp.messages);
    assert.equal(native.continue_url, ucp.continue_url);
  }
  assert.deepEqual(toolsSent(on['mcp.get_fallback']), [], 'a catalog-priced id has no cart to read');
  assert.equal(on['mcp.get_chosen_variant'].value.line_items[0].variant_id, IDS.VARIANT_A_MULTI[1]);
});

test('re-reads the gate declines, a legacy id and an id nobody minted', () => {
  const declined = on['mcp.get_declined_seller_id'];
  assert.equal(reasonOf(declined), 'ucp_escalation_reread_unconfirmed');
  assert.deepEqual(declined.store, []);
  const legacy = on['mcp.get_legacy_id'];
  assert.equal(decodeEsc(LEGACY_ESC_ID).m, undefined);
  assert.equal(reasonOf(legacy), 'ucp_escalation_reread_unconfirmed');
  assert.match(errorOf(legacy).message, /create a new checkout with `market`/);
  // An id this door cannot decode is not an escalation id: the kernel answers, as with the flag off.
  assert.equal(on['mcp.get_forged_id'].raw, off['mcp.get_forged_id'].raw);
  assert.equal(on['mcp.get_kernel_unknown'].raw, off['mcp.get_kernel_unknown'].raw);
});

test('update, complete, cancel and payment link on an esc_ id are refused by name, with no store call and no kernel call', () => {
  const expected = {
    'mcp.update_esc': ['ucp_escalation_update_refused', /cannot be updated here/],
    'mcp.complete_esc': ['ucp_escalation_complete_refused', /cannot be completed here/],
    'mcp.cancel_esc': ['mcp_storefront_cart_cancel_refused', /nothing to cancel here/],
    'mcp.payment_link_esc': ['mcp_storefront_cart_payment_link_refused', /cannot be paid through Pivota/],
  };
  for (const [key, [, message]] of Object.entries(expected)) {
    const a = on[key];
    assert.equal(a.isError, true, key);
    assert.equal(errorOf(a).code, 'OPERATION_NOT_ALLOWED', key);
    assert.equal(errorOf(a).retriable, false, key);
    assert.equal(reasonOf(a), 'escalated_checkout', key);
    assert.match(errorOf(a).message, message, key);
    assert.deepEqual([a.store, a.upstream, a.gate], [[], [], []], key);
  }
  // update and complete are the UCP door's own refusals, word for word.
  assert.equal(errorOf(on['mcp.update_esc']).message, errorOf(on['ucp.update_esc']).message);
  // The same operations on a kernel session are untouched.
  for (const key of ['mcp.complete_kernel_unknown', 'mcp.cancel_kernel_unknown', 'mcp.payment_link_kernel_unknown', 'mcp.get_order_unknown']) {
    assert.equal(on[key].raw, off[key].raw, key);
  }
});

// The creates for a storefront seller's cart that name no market: absent, null, blank; with a variant the product
// does not have; under the shared seed seller name; and for the seller the gate declines.
const NO_MARKET_KEYS = ['mcp.create_no_market', 'mcp.create_null_market', 'mcp.create_blank_market',
  'mcp.create_no_market_unknown_variant', 'mcp.create_no_market_shared_seed_name', 'mcp.create_declined_no_market'];

test('the market: named is used; unnamed (absent, null, blank) is refused by name, before the gate and any store call; malformed is refused', () => {
  for (const key of NO_MARKET_KEYS) {
    const a = on[key];
    assert.equal(a.isError, true, `${key}: ${a.raw}`);
    assert.equal(errorOf(a).code, 'QUOTE_REQUIRED', key);
    assert.equal(errorOf(a).retriable, false, key);
    assert.deepEqual(errorOf(a).detail, { reason: 'market_required_for_seller_storefront', required_argument: 'market', format: 'ISO 3166-1 alpha-2' }, key);
    assert.match(errorOf(a).message, /Send `market`, the buyer's country as an ISO 3166-1 alpha-2 code/, key);
    // NOTHING reached a store, and the purchasability gate was never asked.
    assert.deepEqual([a.store, a.gate], [[], []], key);
    // Only the product reads the path makes to know this is a storefront cart at all; no quote, no kernel.
    assert.deepEqual([...new Set(a.upstream.map((u) => u.op))], ['get_pdp_v2'], key);
    // Nothing is decided for an assumed market: no label, no id.
    assert.equal(a.raw.includes('market_assumed'), false, key);
    assert.equal(a.raw.includes('esc_'), false, key);
    assert.equal(errorOf(a).market_assumed, undefined, key);
    // The refusal names no seller, no store and no product: it is the same bytes for every such cart.
    assert.equal(a.raw, on['mcp.create_no_market'].raw, key);
    for (const name of [...Object.values(HOST), IDS.SELLER_A, IDS.SELLER_C, IDS.SHARED_SEED_SELLER, IDS.SIG_A, IDS.SIG_C]) assert.equal(a.raw.includes(name), false, `${key} ${name}`);
  }
  // The seller the gate declines is still declined by name once the market is named (not before).
  assert.equal(reasonOf(on['mcp.create_declined']), 'merchant_not_purchasable');
  // The same cart with the market named is the store's cart, as before.
  assert.deepEqual(codesOf(on['mcp.create_priced']), ['checkout.priced_by_seller_storefront']);
  assert.deepEqual(on['mcp.create_priced'].store.filter((c) => c.kind === 'tool').map((c) => c.arguments.cart.context), [{ address_country: 'US' }]);
  assert.deepEqual(on['mcp.create_priced'].gate, [{ domain: HOST.A, market: 'US' }]);
  // Lower case is the same market; three letters is not a market.
  assert.equal(decodeEsc(on['mcp.create_lowercase_market'].value.session_id).m, 'US');
  const malformed = on['mcp.create_malformed_market'];
  assert.equal(errorOf(malformed).code, 'INVALID_ARGUMENTS');
  assert.match(errorOf(malformed).message, /`market` must be the buyer's country/);
  assert.deepEqual([malformed.store, malformed.upstream], [[], []]);
});

test('no create on /mcp is answered for an assumed market: no market_assumed member or message, and no assumed mark in an esc_ id', () => {
  const creates = mcpKeys.filter((k) => k.startsWith('mcp.create_'));
  assert.ok(creates.length >= 30);
  let minted = 0;
  for (const key of creates) {
    const a = on[key];
    assert.equal(a.raw.includes('market_assumed'), false, key);
    const id = a.value && a.value.session_id;
    if (typeof id !== 'string' || !id.startsWith('esc_')) continue;
    minted += 1;
    assert.equal(decodeEsc(id).a, undefined, key);
    assert.match(String(decodeEsc(id).m), /^[A-Z]{2}$/, key);
  }
  assert.ok(minted >= 8, String(minted));
});

test('the UCP door still answers a create that names no market with its labelled assumed-US cart (known gap; unchanged by the flag)', () => {
  for (const phase of [off, on]) {
    const a = phase['ucp.create_no_market'];
    assert.equal(a.isError, false, a.raw);
    assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront', 'market_assumed']);
    assert.equal(a.value.market_assumed.code, 'US');
    const id = decodeEsc(a.value.id);
    assert.deepEqual([id.m, id.a], ['US', 1]);
    assert.deepEqual(a.store.filter((c) => c.kind === 'tool').map((c) => [c.tool, c.arguments.cart.context]), [['create_cart', { address_country: 'US' }]]);
  }
  assert.equal(mask(on['ucp.create_no_market'].raw), mask(off['ucp.create_no_market'].raw));
});

test('get_checkout_session on an id the UCP door minted for an assumed market reads it back as the UCP door does, label kept', () => {
  const native = on['mcp.get_assumed_id'];
  const ucp = on['ucp.get_assumed_id'];
  assert.equal(native.isError, false, native.raw);
  assert.equal(decodeEsc(native.value.session_id).a, 1);
  assert.equal(native.value.session_id, ucp.value.id);
  assert.deepEqual(native.value.market_assumed, ucp.value.market_assumed);
  assert.equal(native.value.market_assumed.code, 'US');
  assert.deepEqual(native.value.messages, ucp.value.messages);
  assert.deepEqual(codesOf(native), ['checkout.priced_by_seller_storefront', 'market_assumed']);
  assert.deepEqual(native.value.totals, ucp.value.totals);
  // One read of the cart the UCP door built; no new cart.
  assert.deepEqual(toolsSent(native), ['get_cart']);
});

test('product ids as this door\'s own search returned them resolve: the 36-character signature and the group-shaped id', () => {
  const row = on['mcp.search'].value.products.find((p) => p.title === 'Lip Oil');
  assert.equal(row.product_id, IDS.GROUP_EMITTED, 'search serves this row under its group-shaped id');
  for (const key of ['mcp.create_from_search_row', 'mcp.create_emitted_id']) {
    const a = on[key];
    assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront'], `${key}: ${a.raw}`);
    assert.equal(a.value.line_items[0].product_id, IDS.GROUP_EMITTED, key);
    assert.equal(totalOf(a, 'total'), STORE_PRICE[IDS.VARIANT_EMITTED], key);
  }
  // The shared seed seller name beside a seed product's signature is the same seller.
  assert.deepEqual(codesOf(on['mcp.create_shared_seed_name']), ['checkout.priced_by_seller_storefront']);
});

test('discount codes are not sent to a store, and the answer says so', () => {
  const a = on['mcp.create_discount_codes'];
  assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront', 'discount_code_not_evaluated']);
  assert.equal(JSON.stringify(a.store).includes('CODE10'), false);
  assert.equal(a.raw.includes('CODE10'), false);
  assert.equal(totalOf(a, 'total'), 2750);
});

test('carts the shared intake refuses on shape, and unknown products, are answered exactly as with the flag off', () => {
  for (const key of ['mcp.create_bad_quantity', 'mcp.create_unknown_product', 'mcp.unknown_tool', 'mcp.arguments_not_an_object']) {
    assert.equal(on[key].raw, off[key].raw, key);
    assert.deepEqual(on[key].store, [], key);
  }
  // An undeclared argument is still refused by name; the refusal lists `market` among the accepted ones only now.
  assert.match(errorOf(off['mcp.create_undeclared_argument']).message, /unknown argument "buyer_market".*Accepted top-level arguments: idempotency_key, quote\.$/);
  assert.match(errorOf(on['mcp.create_undeclared_argument']).message, /unknown argument "buyer_market".*Accepted top-level arguments: idempotency_key, quote, market\.$/);
  assert.equal(on['mcp.create_empty_cart'].isError, true);
  assert.deepEqual(on['mcp.create_empty_cart'].store, []);
});

test('no native answer speaks UCP: no envelope, no UCP status, no UCP field name', () => {
  for (const key of mcpKeys) {
    if (key === 'mcp.unknown_tool') continue;
    assert.equal(/"ucp"\s*:/.test(on[key].raw), false, key);
    assert.equal(on[key].raw.includes('requires_escalation'), false, key);
    assert.equal(on[key].raw.includes('checkout.context'), false, key);
    assert.equal(on[key].raw.includes('address_country'), false, key);
  }
});

test('only a cart ever reaches a store: create_cart and get_cart, unauthenticated, from either phase', () => {
  const sent = [...Object.values(off), ...Object.values(on)].flatMap((a) => a.store || []);
  assert.ok(sent.length > 0);
  assert.deepEqual([...new Set(sent.map((c) => c.kind))].sort(), ['profile', 'tool']);
  assert.deepEqual([...new Set(sent.filter((c) => c.kind === 'tool').map((c) => c.tool))].sort(), ['create_cart', 'get_cart']);
  assert.equal(sent.some((c) => c.has_authorization), false);
  assert.equal(JSON.stringify(sent).includes('buyer@example.test'), false);
});

// ---- the tool list ----------------------------------------------------------------------------------------------

const toolsOf = (answer) => answer.body.result.tools;

test('tools/list on /mcp says what the checkout tools answer only while the flag is on', async () => {
  // The surface reads this at load; the child's doors were loaded with it (the fixture's env).
  process.env.UCP_LIVE_PRODUCT_READ = 'shadow';
  const { commerceToolDefinitions } = await import('../mcp-server/src/commerceToolSurface.js');
  // Off: the surface's own declarations, byte for byte.
  assert.equal(JSON.stringify(toolsOf(off['mcp.tools_list'])), JSON.stringify(commerceToolDefinitions));
  assert.equal(off['mcp.tools_list'].raw.includes('completes_on_seller_storefront'), false);
  const offCreate = toolsOf(off['mcp.tools_list']).find((t) => t.name === 'create_checkout_session');
  assert.deepEqual(Object.keys(offCreate.inputSchema.properties), ['idempotency_key', 'quote']);
  // On: create declares `market` and describes the storefront answer; the session tools say what they do with an esc_ id.
  const onTools = toolsOf(on['mcp.tools_list']);
  const onCreate = onTools.find((t) => t.name === 'create_checkout_session');
  assert.deepEqual(Object.keys(onCreate.inputSchema.properties), ['idempotency_key', 'quote', 'market']);
  assert.deepEqual(onCreate.inputSchema.required, offCreate.inputSchema.required);
  assert.equal(onCreate.description.startsWith(offCreate.description), true);
  for (const phrase of ['completes_on_seller_storefront', 'checkout.priced_by_seller_storefront', 'checkout.completes_on_seller_storefront', 'continue_url', 'market_required_for_seller_storefront', 'esc_']) {
    assert.equal(onCreate.description.includes(phrase), true, phrase);
  }
  // `market` is REQUIRED for a seller-storefront checkout, in words: the same tool also creates the checkouts
  // Pivota prices itself, where it stays optional, so the schema's `required` list does not name it (asserted above).
  assert.match(onCreate.description, /`market` \(the buyer's country, ISO 3166-1 alpha-2\) is REQUIRED for such a checkout/);
  assert.match(onCreate.inputSchema.properties.market.description, /REQUIRED for such a checkout/);
  assert.equal(onCreate.inputSchema.required.includes('market'), false);
  // The create declaration no longer says a market is assumed for such a checkout.
  assert.equal(JSON.stringify(onCreate).includes('market_assumed'), false);
  assert.equal(/for a US buyer/.test(JSON.stringify(onCreate)), false);
  const changed = onTools.filter((t, i) => JSON.stringify(t) !== JSON.stringify(toolsOf(off['mcp.tools_list'])[i])).map((t) => t.name).sort();
  assert.deepEqual(changed, ['cancel_checkout_session', 'complete_checkout_session', 'create_checkout_session', 'create_payment_link', 'get_checkout_session', 'update_checkout_session']);
  assert.deepEqual(onTools.map((t) => t.name), toolsOf(off['mcp.tools_list']).map((t) => t.name));
});

// ---- flag off -------------------------------------------------------------------------------------------------

test('flag off: /mcp answers a storefront seller\'s checkout as it did before, and no store is ever contacted from /mcp', () => {
  const noMarket = off['mcp.create_no_market'];
  assert.equal(errorOf(noMarket).code, 'OPERATION_NOT_ALLOWED');
  assert.equal(reasonOf(noMarket), 'ucp_storefront_checkout_unavailable');
  // `market` is not an argument of create_checkout_session while the flag is off.
  const withMarket = off['mcp.create_priced'];
  assert.equal(errorOf(withMarket).code, 'INVALID_ARGUMENTS');
  assert.match(errorOf(withMarket).message, /unknown argument "market"/);
  assert.match(errorOf(withMarket).message, /Accepted top-level arguments: idempotency_key, quote\./);
  // An esc_ id is an unknown session to the kernel.
  for (const key of ['mcp.get_priced', 'mcp.get_own_created', 'mcp.get_fallback', 'mcp.get_legacy_id', 'mcp.payment_link_esc']) {
    assert.equal(errorOf(off[key]).code, 'QUOTE_NOT_FOUND', key);
  }
  for (const key of mcpKeys) assert.deepEqual(off[key].store, [], key);
  for (const key of mcpKeys) assert.equal(off[key].raw.includes('completes_on_seller_storefront'), false, key);
});

test('the view is wired at the /mcp adapter only; no other door, and nothing below the tool surface, knows the flag', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const server = read('src/server.js');
  assert.equal((server.match(/mcpStorefrontCartSurface\(/g) || []).length, 1);
  assert.match(server, /createRemoteMcpAdapter\(partnerDoorSurface\(getOffersEmptyReasonSurface\(mcpStorefrontCartSurface\(surface\)\)/);
  // The UCP door projects the bare surface.
  assert.match(server, /const surface = ucpDialectSurface\(await getCommerceToolSurface\(\)\);/);
  assert.equal(server.includes('AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED') && !server.includes('process.env.AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED'), true, 'named in a comment, read nowhere in the server');
  for (const file of ['mcp-server/src/publicReadToolSurface.js', 'mcp-server/src/ucpResponseShaper.js', 'mcp-server/src/ucpArgumentAdapter.js',
    'mcp-server/src/ucpCheckoutEscalation.js', 'mcp-server/src/ucpMerchantDoorPricing.js', 'mcp-server/src/remoteMcpAdapter.js',
    'safety-kernel/src/protocol/canonicalExecutor.js', 'safety-kernel/src/protocol/canonicalContract.js']) {
    const text = read(file);
    assert.equal(/storefrontCartDoor|MCP_STOREFRONT_ESCALATION|mcpStorefrontCart/.test(text), false, file);
  }
});

// ---- the other doors ------------------------------------------------------------------------------------------

test('the UCP door, the public door and the invoke route answer the same with the flag on as with it off', () => {
  assert.ok(otherDoorKeys.length >= 20);
  for (const key of otherDoorKeys) {
    assert.equal(mask(on[key].raw), mask(off[key].raw), key);
    assert.equal(on[key].http, off[key].http, key);
    assert.deepEqual(on[key].store.filter((c) => c.kind === 'tool'), off[key].store.filter((c) => c.kind === 'tool'), key);
  }
  // And the UCP door did take the storefront path in both phases (the comparison above is not of two refusals).
  assert.deepEqual(codesOf(off['ucp.create_priced']), ['checkout.priced_by_seller_storefront']);
  assert.deepEqual(toolsSent(off['ucp.create_priced']), ['create_cart']);
  assert.equal(off['ucp.tools_list'].raw, on['ucp.tools_list'].raw);
  assert.equal(off['public.tools_list'].raw, on['public.tools_list'].raw);
  // The public door has no checkout tool at all.
  assert.equal(on['public.create_checkout_session'].raw.includes('completes_on_seller_storefront'), false);
});

test('the read tools on /mcp answer the same with the flag on as with it off', () => {
  for (const key of ['mcp.initialize', 'mcp.search', 'mcp.search_no_market', 'mcp.get_product', 'mcp.get_product_emitted', 'mcp.get_offers']) {
    assert.equal(mask(on[key].raw), mask(off[key].raw), key);
  }
});
