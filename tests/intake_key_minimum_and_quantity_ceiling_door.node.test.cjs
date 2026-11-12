'use strict';

// THE TWO SHARED CHECKOUT BOUNDS, THROUGH THE REAL DOORS: `/mcp`, `/ucp/mcp`, `/public/mcp` and the ACP REST routes.
//
//   - An idempotency key that is PRESENT is at least 8 characters (Unicode code points, surrounding whitespace not
//     counted) on every operation that changes state. Refused with the code a missing key gets
//     (IDEMPOTENCY_CONFLICT), the reason `idempotency_key_too_short`, not retriable. An ABSENT key is answered
//     exactly as it was.
//   - One cart line is at most 999 units, on a create and on an update, on the kernel path and on the storefront
//     cart. Refused with the code every bad quantity gets (QUOTE_REQUIRED), the reason
//     `quantity_above_line_maximum`, not retriable, and the maximum in the message and the detail.
//   - Both are refused BEFORE ANYTHING IS SENT ANYWHERE. The fixture records every request the gateway makes to the
//     catalog, the backend (quote, product detail, purchasability gate, anything else) and the seller's storefront;
//     every refusal below asserts that list is empty.
//
// The app, its routes and everything behind them are real; see tests/_support/intakeKeyQtyDoor.cjs for what is
// stubbed. Every name is a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./_support/intakeKeyQtyDoor.cjs');

const { IDS } = fx;
const ASTRAL = '\u{1F511}'; // one character, two UTF-16 units
let door;

test.before(async () => {
  door = fx.bootDoor({ port: 4476, buyerKeys: await fx.mintBuyerKeys() });
  await door.listen();
});
test.after(async () => { if (door) await door.close(); });

// ---- what a refusal looks like on each kind of door -------------------------------------------------------------

const errorOf = (r) => (r.value && r.value.error) || null;
const sentNothing = (r, label) => {
  assert.deepEqual(r.upstream, [], `${label}: nothing was sent to the catalog, the backend or the gate`);
  assert.deepEqual(r.store, [], `${label}: nothing was sent to a storefront`);
};
function assertKeyTooShort(r, label) {
  assert.equal(r.http, 200, label);
  assert.equal(r.isError, true, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(errorOf(r), {
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'The idempotency key is too short: it must be at least 8 characters, not counting leading or trailing whitespace or invisible formatting characters. Generate a new unique key of that length or longer (a UUID works) and send the request again with it. Retrying with this key will not change the answer.',
    retriable: false,
    detail: { reason: 'idempotency_key_too_short', min_length: 8 },
  }, label);
  sentNothing(r, label);
}
function assertQuantityAboveMaximum(r, label) {
  assert.equal(r.http, 200, label);
  assert.equal(r.isError, true, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(errorOf(r), {
    code: 'QUOTE_REQUIRED',
    message: "A line's quantity is above the maximum: at most 999 units per line are accepted. Send a whole number from 1 to 999 as each line's quantity. Retrying as sent will not change the answer.",
    retriable: false,
    detail: { reason: 'quantity_above_line_maximum', max_quantity: 999 },
  }, label);
  sentNothing(r, label);
}
const reasonOf = (r) => (errorOf(r) && errorOf(r).detail && errorOf(r).detail.reason) || null;
const pastTheKeyGate = (r, label) => assert.notEqual(errorOf(r) && errorOf(r).code, 'IDEMPOTENCY_CONFLICT', `${label}: ${r.raw.slice(0, 300)}`);
function assertAcpKeyTooShort(r, label) {
  assert.equal(r.http, 409, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(r.body, {
    type: 'error',
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'The idempotency key is too short: it must be at least 8 characters, not counting leading or trailing whitespace or invisible formatting characters. Generate a new unique key of that length or longer (a UUID works) and send the request again with it. Retrying with this key will not change the answer.',
    detail: { reason: 'idempotency_key_too_short', min_length: 8 },
  }, label);
  sentNothing(r, label);
}
function assertAcpQuantityAboveMaximum(r, label) {
  assert.equal(r.http, 400, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(r.body, {
    type: 'error',
    code: 'QUOTE_REQUIRED',
    message: "A line's quantity is above the maximum: at most 999 units per line are accepted. Send a whole number from 1 to 999 as each line's quantity. Retrying as sent will not change the answer.",
    detail: { reason: 'quantity_above_line_maximum', max_quantity: 999 },
  }, label);
  sentNothing(r, label);
}
const quoteCalls = (r) => r.upstream.filter((c) => c.path === '/agent/v2/quotes/preview');

let keySeq = 0;
/** A fresh key of 8 or more characters. */
const freshKey = () => { keySeq += 1; return `idem-door-${String(keySeq).padStart(4, '0')}`; };
/** A kernel session of this buyer's, made through `/mcp`. */
async function kernelSession() {
  const created = await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: fx.nativeQuote(1) }));
  assert.equal(created.isError, false, created.raw.slice(0, 300));
  return created.value.session_id;
}

// ---- /mcp: the key ----------------------------------------------------------------------------------------------

const nativeMutations = (sid) => ({
  create_checkout_session: { quote: fx.nativeQuote(1) },
  update_checkout_session: { session_id: sid, quote: fx.nativeQuote(2) },
  complete_checkout_session: { session_id: sid, payment_authorization: { method: 'placeholder', token: 'placeholder' } },
  create_payment_link: { session_id: sid, customer_email: 'buyer@example.test' },
  cancel_checkout_session: { session_id: sid },
  request_after_sales: { status: { order_id: 'ord_placeholder', requested_action: 'refund' } },
});

test('/mcp: a key of 7 characters is refused on every tool that changes state, and nothing is sent anywhere', async () => {
  const sid = await kernelSession();
  for (const [tool, args] of Object.entries(nativeMutations(sid))) {
    assertKeyTooShort(await door.call('/mcp', tool, fx.withKey('abcdefg', args)), `${tool} 7`);
    assertKeyTooShort(await door.call('/mcp', tool, fx.withKey('k', args)), `${tool} 1`);
  }
});

test('/mcp: a key of 8 characters is past the gate on every tool that changes state', async () => {
  for (const tool of Object.keys(nativeMutations('placeholder'))) {
    // A session of its own for each, so one tool's effect (a cancel, a re-quote) is not another's input.
    const args = nativeMutations(await kernelSession())[tool];
    const key = `8chr-${tool.slice(0, 3)}`;
    assert.equal(key.length, 8);
    pastTheKeyGate(await door.call('/mcp', tool, fx.withKey(key, args)), tool);
  }
  // And the two that reach the backend on a good key do reach it.
  const created = await door.call('/mcp', 'create_checkout_session', fx.withKey('ABCDEFGH', { quote: fx.nativeQuote(3) }));
  assert.equal(created.isError, false, created.raw.slice(0, 300));
  assert.equal(quoteCalls(created).length, 1);
});

test('/mcp: surrounding whitespace is not counted; the unit is the character, not the UTF-16 unit', async () => {
  const args = { quote: fx.nativeQuote(1) };
  // 8 or more characters as sent, fewer once trimmed.
  assertKeyTooShort(await door.call('/mcp', 'create_checkout_session', fx.withKey('abc     ', args)), 'padded right');
  assertKeyTooShort(await door.call('/mcp', 'create_checkout_session', fx.withKey('   abcdefg   ', args)), 'padded both sides');
  // Four characters outside the basic plane: eight UTF-16 units, four characters.
  assert.equal(ASTRAL.repeat(4).length, 8);
  assertKeyTooShort(await door.call('/mcp', 'create_checkout_session', fx.withKey(ASTRAL.repeat(4), args)), 'four characters of two units each');
  assertKeyTooShort(await door.call('/mcp', 'create_checkout_session', fx.withKey('é'.repeat(7), args)), 'seven two-byte characters');

  for (const key of ['  abcdefgh  ', 'é'.repeat(8), '一'.repeat(8), ASTRAL.repeat(8)]) {
    const r = await door.call('/mcp', 'create_checkout_session', fx.withKey(key, args));
    assert.equal(r.isError, false, `${JSON.stringify(key)}: ${r.raw.slice(0, 300)}`);
    assert.equal(quoteCalls(r).length, 1, `${JSON.stringify(key)}: priced`);
  }
});

test('/mcp: an absent key is answered exactly as before', async () => {
  const sid = await kernelSession();
  for (const [tool, args] of Object.entries(nativeMutations(sid))) {
    for (const [label, callArgs] of [['no key', args], ['blank key', fx.withKey('   ', args)]]) {
      const r = await door.call('/mcp', tool, callArgs);
      // The missing-key refusal: its code, the taxonomy's generic message, and no detail.
      assert.deepEqual(errorOf(r), {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'This looks like a different request reusing an old reference. Starting fresh.',
        retriable: false,
      }, `${tool} ${label}`);
    }
  }
});

test('/mcp: a read takes no key and is untouched', async () => {
  const sid = await kernelSession();
  const read = await door.call('/mcp', 'get_checkout_session', { session_id: sid });
  assert.equal(read.isError, false, read.raw.slice(0, 300));
  assert.equal(read.value.session_id, sid);
});

// ---- /mcp: the quantity --------------------------------------------------------------------------------------------

test('/mcp create: 999 units are priced; 1000, and a huge number, are refused with nothing sent anywhere', async () => {
  const at = await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: fx.nativeQuote(999) }));
  assert.equal(at.isError, false, at.raw.slice(0, 300));
  assert.equal(at.value.line_items[0].quantity, 999);
  assert.equal(at.value.totals.total, 999 * fx.CONNECTED_UNIT_MINOR);
  assert.equal(quoteCalls(at)[0].body.offer_refs[0].quantity, 999, 'the quantity the backend was asked to price');

  assertQuantityAboveMaximum(await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: fx.nativeQuote(1000) })), '1000');
  assertQuantityAboveMaximum(await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: fx.nativeQuote(900000000) })), '900000000');
  assertQuantityAboveMaximum(await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: fx.nativeQuote(1e30) })), '1e30');
  // No variant named: the door would read the product to resolve one. The refusal comes before that read.
  assertQuantityAboveMaximum(await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: fx.nativeQuote(1000, { variant: null }) })), '1000, variant to resolve');
  // Above the ceiling on the second line only.
  const twoLines = fx.nativeQuote(1);
  twoLines.items.push({ product_id: IDS.SIG_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 1000 });
  assertQuantityAboveMaximum(await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: twoLines })), 'second line');
});

test('/mcp create: a numeric string is not coerced and keeps the refusal a bad quantity always got', async () => {
  for (const quantity of ['1000', '5', 0, -1, 1.5]) {
    const r = await door.call('/mcp', 'create_checkout_session', fx.withKey(freshKey(), { quote: fx.nativeQuote(quantity) }));
    assert.deepEqual(errorOf(r), {
      code: 'QUOTE_REQUIRED',
      message: 'I need a fresh price quote before placing this order.',
      retriable: false,
    }, `quantity ${JSON.stringify(quantity)}`);
    sentNothing(r, `quantity ${JSON.stringify(quantity)}`);
  }
});

test('/mcp update: 999 units are re-priced; 1000, and a huge number, are refused with nothing sent anywhere', async () => {
  const sid = await kernelSession();
  const at = await door.call('/mcp', 'update_checkout_session', fx.withKey(freshKey(), { session_id: sid, quote: fx.nativeQuote(999) }));
  assert.equal(at.isError, false, at.raw.slice(0, 300));
  assert.equal(quoteCalls(at)[0].body.offer_refs[0].quantity, 999);

  assertQuantityAboveMaximum(await door.call('/mcp', 'update_checkout_session', fx.withKey(freshKey(), { session_id: sid, quote: fx.nativeQuote(1000) })), '1000');
  assertQuantityAboveMaximum(await door.call('/mcp', 'update_checkout_session', fx.withKey(freshKey(), { session_id: sid, quote: fx.nativeQuote(900000000) })), '900000000');
  assertQuantityAboveMaximum(await door.call('/mcp', 'update_checkout_session', fx.withKey(freshKey(), { session_id: sid, quote: fx.nativeQuote(1000, { variant: null }) })), '1000, variant to resolve');
  const asString = await door.call('/mcp', 'update_checkout_session', fx.withKey(freshKey(), { session_id: sid, quote: fx.nativeQuote('1000') }));
  assert.equal(errorOf(asString).code, 'QUOTE_REQUIRED');
  assert.equal('detail' in errorOf(asString), false, 'a string is the older refusal, not this one');
});

test('/mcp: a short key and a line above the ceiling together: the key is answered first', async () => {
  assertKeyTooShort(await door.call('/mcp', 'create_checkout_session', fx.withKey('k', { quote: fx.nativeQuote(900000000) })), 'both');
});

// ---- /ucp/mcp: the key ---------------------------------------------------------------------------------------------

const ucpPayment = { payment: { method: 'ucp_handler', token: 'placeholder.grant.token' } };

test('/ucp/mcp: a key of 7 characters is refused on create, update and complete, and nothing is sent anywhere', async () => {
  const sid = await kernelSession();
  for (const key of ['abcdefg', 'k', '  abcdefg  ', 'abc     ', ASTRAL.repeat(4), 'é'.repeat(7)]) {
    const meta = fx.ucpMeta(key);
    // A storefront cart: no product read, no gate, no store. A kernel cart: no product read, no quote.
    assertKeyTooShort(await door.call('/ucp/mcp', 'create_checkout', { meta, checkout: fx.ucpCheckout(IDS.SIG_STORE, 1) }), `create storefront ${JSON.stringify(key)}`);
    assertKeyTooShort(await door.call('/ucp/mcp', 'create_checkout', { meta, checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, 1) }), `create kernel ${JSON.stringify(key)}`);
    assertKeyTooShort(await door.call('/ucp/mcp', 'update_checkout', { meta, id: sid, checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, 2) }), `update ${JSON.stringify(key)}`);
    assertKeyTooShort(await door.call('/ucp/mcp', 'complete_checkout', { meta, id: sid, checkout: ucpPayment }), `complete ${JSON.stringify(key)}`);
  }
});

test('/ucp/mcp: a key of 8 characters is past the gate: the storefront cart is made, the kernel cart is priced', async () => {
  for (const key of ['abcdefgh', '  ABCDEFGH  ', 'é'.repeat(8), ASTRAL.repeat(8)]) {
    door.resetGate();
    const store = await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(key), checkout: fx.ucpCheckout(IDS.SIG_STORE, 2) });
    assert.equal(store.isError, false, `${JSON.stringify(key)}: ${store.raw.slice(0, 300)}`);
    assert.equal(store.value.status, 'requires_escalation');
    assert.deepEqual(store.store.filter((c) => c.kind === 'tool').map((c) => c.tool), ['create_cart'], JSON.stringify(key));
    const kernel = await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(key), checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, 2) });
    pastTheKeyGate(kernel, `kernel ${JSON.stringify(key)}`);
    assert.equal(quoteCalls(kernel).length, 1, `${JSON.stringify(key)}: the quote was asked for`);
  }
  const sid = await kernelSession();
  const updated = await door.call('/ucp/mcp', 'update_checkout', { meta: fx.ucpMeta('abcdefgh'), id: sid, checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, 2) });
  pastTheKeyGate(updated, 'update');
  assert.equal(quoteCalls(updated).length, 1, 'update: the quote was asked for');
  pastTheKeyGate(await door.call('/ucp/mcp', 'complete_checkout', { meta: fx.ucpMeta('abcdefgh'), id: sid, checkout: ucpPayment }), 'complete');
});

test('/ucp/mcp: an absent key keeps the refusal this door always gave it', async () => {
  const sid = await kernelSession();
  for (const [tool, args] of [
    ['create_checkout', { checkout: fx.ucpCheckout(IDS.SIG_STORE, 1) }],
    ['update_checkout', { id: sid, checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, 2) }],
    ['complete_checkout', { id: sid, checkout: ucpPayment }],
  ]) {
    for (const [label, meta] of [['no key', fx.ucpMeta(undefined)], ['blank key', fx.ucpMeta('   ')]]) {
      const r = await door.call('/ucp/mcp', tool, { meta, ...args });
      assert.equal(errorOf(r).code, 'QUOTE_REQUIRED', `${tool} ${label}`);
      assert.equal(reasonOf(r), 'ucp_idempotency_key_required', `${tool} ${label}`);
      sentNothing(r, `${tool} ${label}`);
    }
  }
});

// ---- /ucp/mcp: the quantity, on the storefront cart and on the kernel path ---------------------------------------

test('/ucp/mcp create, storefront cart: 999 units reach the store; 1000, and a huge number, reach nothing', async () => {
  door.resetGate();
  const at = await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(freshKey()), checkout: fx.ucpCheckout(IDS.SIG_STORE, 999) });
  assert.equal(at.isError, false, at.raw.slice(0, 300));
  assert.equal(at.value.line_items[0].quantity, 999);
  assert.equal(at.value.line_items[0].totals[0].amount, 999 * fx.STORE_UNIT_MINOR);
  const cart = at.store.find((c) => c.tool === 'create_cart');
  assert.equal(cart.arguments.cart.line_items[0].quantity, 999, 'the quantity the store was asked for');
  assert.deepEqual(at.upstream.map((c) => c.to), ['catalog', 'gate'], 'one product read, one gate read');

  door.resetGate();
  for (const quantity of [1000, 900000000, 1e30]) {
    assertQuantityAboveMaximum(await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(freshKey()), checkout: fx.ucpCheckout(IDS.SIG_STORE, quantity) }), `storefront ${quantity}`);
  }
  // A numeric string is not coerced into a quantity, is not this refusal, and no store is asked for a cart.
  const asString = await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(freshKey()), checkout: fx.ucpCheckout(IDS.SIG_STORE, '1000') });
  assert.equal(asString.isError, true);
  assert.notEqual(reasonOf(asString), 'quantity_above_line_maximum');
  assert.deepEqual(asString.store, []);
});

test('/ucp/mcp create and update, kernel path: 999 units are sent to be priced; 1000 reach nothing', async () => {
  const at = await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(freshKey()), checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, 999) });
  assert.equal(quoteCalls(at)[0].body.offer_refs[0].quantity, 999);
  for (const quantity of [1000, 900000000]) {
    assertQuantityAboveMaximum(await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(freshKey()), checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, quantity) }), `create ${quantity}`);
  }

  const sid = await kernelSession();
  const updated = await door.call('/ucp/mcp', 'update_checkout', { meta: fx.ucpMeta(freshKey()), id: sid, checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, 999) });
  assert.equal(quoteCalls(updated)[0].body.offer_refs[0].quantity, 999);
  for (const quantity of [1000, 900000000]) {
    // On this door an update reads its cart's products before intake: the refusal comes before that read.
    assertQuantityAboveMaximum(await door.call('/ucp/mcp', 'update_checkout', { meta: fx.ucpMeta(freshKey()), id: sid, checkout: fx.ucpCheckout(IDS.SIG_CONNECTED, quantity) }), `update ${quantity}`);
    assertQuantityAboveMaximum(await door.call('/ucp/mcp', 'update_checkout', { meta: fx.ucpMeta(freshKey()), id: sid, checkout: fx.ucpCheckout(IDS.SIG_STORE, quantity) }), `update storefront product ${quantity}`);
  }
});

test('/ucp/mcp create and update: a line that names a variant is refused above the ceiling before the read that proves the variant', async () => {
  const sid = await kernelSession();
  const chosen = `${IDS.SIG_STORE}::v::${IDS.VARIANT_STORE}`;
  // At the ceiling the door reads the product to prove the variant is one of its own.
  door.resetGate();
  const at = await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(freshKey()), checkout: fx.ucpCheckout(chosen, 999) });
  assert.ok(at.upstream.some((c) => c.to === 'catalog'), `999: ${at.raw.slice(0, 300)}`);
  for (const quantity of [1000, 900000000]) {
    assertQuantityAboveMaximum(await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(freshKey()), checkout: fx.ucpCheckout(chosen, quantity) }), `create ${quantity}`);
    assertQuantityAboveMaximum(await door.call('/ucp/mcp', 'update_checkout', { meta: fx.ucpMeta(freshKey()), id: sid, checkout: fx.ucpCheckout(chosen, quantity) }), `update ${quantity}`);
  }
});

// ---- invisible characters are not counted, on every door -------------------------------------------------------------

test('a key made of, or padded out with, invisible formatting characters is refused on every door; the key itself is never altered', async () => {
  const sid = await kernelSession();
  const acpId = await acpSession();
  // Eight zero-width spaces; seven letters and one; the other characters named in the rule.
  for (const key of ['\u200b'.repeat(8), 'abcdefg\u200b', '\u200babcdefg', 'abc\u200c\u200d\u2060\ufeffdef', 'abcdefg\u00ad', '\u202eabcdefg\u202c']) {
    const label = JSON.stringify(key);
    assertKeyTooShort(await door.call('/mcp', 'create_checkout_session', fx.withKey(key, { quote: fx.nativeQuote(1) })), `/mcp create ${label}`);
    assertKeyTooShort(await door.call('/mcp', 'complete_checkout_session', fx.withKey(key, { session_id: sid, payment_authorization: { method: 'placeholder', token: 'placeholder' } })), `/mcp complete ${label}`);
    assertKeyTooShort(await door.call('/ucp/mcp', 'create_checkout', { meta: fx.ucpMeta(key), checkout: fx.ucpCheckout(IDS.SIG_STORE, 1) }), `/ucp/mcp create ${label}`);
    assertInvokeRefusal(await door.invoke(SHOP, 'preview_quote', invokeQuote(1, { idempotency_key: key })), INVOKE_KEY_REFUSAL, 409, `invoke strict ${label}`);
    assertInvokeRefusal(await door.invoke(CREATOR, 'preview_quote', invokeQuote(1, { idempotency_key: key })), INVOKE_KEY_REFUSAL, 409, `invoke creator ${label}`);
  }
  // An HTTP header cannot carry these characters, so the ACP REST door is shown with the one it can: a soft hyphen.
  assertAcpKeyTooShort(await door.acp('POST', '/checkout_sessions', fx.acpCart(1), { key: 'abcdefg\u00ad' }), 'ACP create, soft hyphen');
  assertAcpKeyTooShort(await door.acp('POST', `/checkout_sessions/${acpId}/cancel`, {}, { key: '\u00ad'.repeat(8) }), 'ACP cancel, eight soft hyphens');

  // Eight counted characters with invisible ones among them: accepted, and handed on exactly as sent. (A soft
  // hyphen here, because the kernel also sends the key to the backend in an HTTP header.)
  const key = 'abcd\u00adefgh\u00ad';
  const link = await door.call('/mcp', 'create_payment_link', fx.withKey(key, { session_id: sid, customer_email: 'buyer@example.test' }));
  const order = link.upstream.find((c) => c.path === '/agent/v2/orders');
  assert.ok(order, link.raw.slice(0, 300));
  assert.equal(JSON.parse(order.body.idempotency_key.replace(/:order$/, ''))[3], key, 'the key the backend is sent is the key as the caller sent it');
});

// ---- ACP REST update: the ceiling before the session is loaded ----------------------------------------------------

test('ACP REST update: a line above the ceiling is answered before the session is looked up, and never before the buyer is known', async () => {
  // A session id nobody has: the quantity is refused, and nothing is said about whether the session exists.
  assertAcpQuantityAboveMaximum(await door.acp('POST', '/checkout_sessions/no-such-session', fx.acpCart(1000), { key: freshKey() }), 'unknown session');
  // Within the ceiling, the same request is told the session is not there, as before.
  const unknown = await door.acp('POST', '/checkout_sessions/no-such-session', fx.acpCart(999), { key: freshKey() });
  assert.equal(unknown.http, 404, unknown.raw.slice(0, 200));
  assert.equal(unknown.body.code, 'QUOTE_NOT_FOUND');
  // No verified buyer: that is still the answer, whatever the cart says.
  const noBuyer = await door.acp('POST', '/checkout_sessions/no-such-session', fx.acpCart(1000), { key: freshKey(), buyer: false });
  assert.equal(noBuyer.http, 401, noBuyer.raw.slice(0, 200));
  assert.equal(noBuyer.body.code, 'USER_AUTH_REQUIRED');
  assert.equal(noBuyer.raw.includes('quantity_above_line_maximum'), false);
  const noBuyerCreate = await door.acp('POST', '/checkout_sessions', fx.acpCart(1000), { key: freshKey(), buyer: false });
  assert.equal(noBuyerCreate.body.code, 'USER_AUTH_REQUIRED');
});

// ---- /public/mcp ----------------------------------------------------------------------------------------------------

test('/public/mcp publishes no checkout tool, so neither bound has anything to judge there', async () => {
  const tools = (await door.listTools('/public/mcp')).map((t) => t.name);
  for (const name of ['create_checkout_session', 'update_checkout_session', 'complete_checkout_session', 'cancel_checkout_session', 'create_payment_link', 'request_after_sales', 'create_checkout', 'update_checkout', 'complete_checkout']) {
    assert.equal(tools.includes(name), false, name);
  }
  const published = JSON.stringify(await door.listTools('/public/mcp'));
  assert.equal(published.includes('idempotency'), false);
  assert.equal(published.includes('"quantity"'), false);
  const r = await door.post('/public/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_checkout_session', arguments: fx.withKey('k', { quote: fx.nativeQuote(900000000) }) } });
  assert.equal(r.raw.includes('idempotency_key_too_short'), false);
  assert.equal(r.raw.includes('quantity_above_line_maximum'), false);
  sentNothing(r, 'public tier');
});

// ---- ACP REST --------------------------------------------------------------------------------------------------------

async function acpSession() {
  const created = await door.acp('POST', '/checkout_sessions', fx.acpCart(1), { key: freshKey() });
  assert.equal(created.http, 201, created.raw.slice(0, 300));
  return created.body.id;
}

test('ACP REST: a short Idempotency-Key is refused on create, update, complete and cancel, and nothing is sent anywhere', async () => {
  const id = await acpSession();
  // The header value reaches the door already trimmed (HTTP strips it), so padding cannot lengthen a key here.
  for (const key of ['abcdefg', 'k', '  abcdefg  ', 'é'.repeat(7)]) {
    assertAcpKeyTooShort(await door.acp('POST', '/checkout_sessions', fx.acpCart(1), { key }), `create ${JSON.stringify(key)}`);
    // No variant named: the door would read the product to resolve one. Refused before that read.
    assertAcpKeyTooShort(await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER_CONNECTED, items: [{ product_id: IDS.SIG_CONNECTED, quantity: 1 }] }, { key }), `create, variant to resolve ${JSON.stringify(key)}`);
    assertAcpKeyTooShort(await door.acp('POST', `/checkout_sessions/${id}`, fx.acpCart(2), { key }), `update ${JSON.stringify(key)}`);
    assertAcpKeyTooShort(await door.acp('POST', `/checkout_sessions/${id}/complete`, { payment_data: { method: 'placeholder', token: 'placeholder' } }, { key }), `complete ${JSON.stringify(key)}`);
    assertAcpKeyTooShort(await door.acp('POST', `/checkout_sessions/${id}/cancel`, {}, { key }), `cancel ${JSON.stringify(key)}`);
  }
});

test('ACP REST: an 8-character key is past the gate; an absent key is answered exactly as before; a read takes none', async () => {
  for (const key of ['abcdefgh', 'é'.repeat(8)]) {
    const created = await door.acp('POST', '/checkout_sessions', fx.acpCart(2), { key });
    assert.equal(created.http, 201, `${JSON.stringify(key)}: ${created.raw.slice(0, 300)}`);
    assert.equal(quoteCalls(created).length, 1);
  }
  const id = await acpSession();
  const updated = await door.acp('POST', `/checkout_sessions/${id}`, fx.acpCart(2), { key: 'ABCDEFGH' });
  assert.equal(updated.http, 200, updated.raw.slice(0, 300));
  const completed = await door.acp('POST', `/checkout_sessions/${id}/complete`, { payment_data: { method: 'placeholder', token: 'placeholder' } }, { key: 'abcdefg8' });
  assert.notEqual(completed.body.code, 'IDEMPOTENCY_CONFLICT', completed.raw.slice(0, 300));
  const canceled = await door.acp('POST', `/checkout_sessions/${id}/cancel`, {}, { key: 'abcdefg9' });
  assert.equal(canceled.http, 200, canceled.raw.slice(0, 300));

  const other = await acpSession();
  for (const [name, method, subPath, body] of [
    ['create', 'POST', '/checkout_sessions', fx.acpCart(1)],
    ['update', 'POST', `/checkout_sessions/${other}`, fx.acpCart(2)],
    ['complete', 'POST', `/checkout_sessions/${other}/complete`, { payment_data: { method: 'placeholder', token: 'placeholder' } }],
    ['cancel', 'POST', `/checkout_sessions/${other}/cancel`, {}],
  ]) {
    const r = await door.acp(method, subPath, body, {});
    assert.equal(r.http, 409, `${name}: ${r.raw.slice(0, 300)}`);
    assert.deepEqual(r.body, {
      type: 'error',
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'This looks like a different request reusing an old reference. Starting fresh.',
    }, `${name}: the missing-key refusal, with no detail`);
  }
  const read = await door.acp('GET', `/checkout_sessions/${other}`, undefined, {});
  assert.equal(read.http, 200, read.raw.slice(0, 300));
});

test('ACP REST create and update: 999 units are priced; 1000, and a huge number, are refused with nothing sent anywhere', async () => {
  const created = await door.acp('POST', '/checkout_sessions', fx.acpCart(999), { key: freshKey() });
  assert.equal(created.http, 201, created.raw.slice(0, 300));
  assert.equal(created.body.line_items[0].quantity, 999);
  assert.equal(quoteCalls(created)[0].body.offer_refs[0].quantity, 999);
  const id = created.body.id;
  const updated = await door.acp('POST', `/checkout_sessions/${id}`, fx.acpCart(999), { key: freshKey() });
  assert.equal(updated.http, 200, updated.raw.slice(0, 300));
  assert.equal(quoteCalls(updated)[0].body.offer_refs[0].quantity, 999);

  for (const quantity of [1000, 900000000, 1e30]) {
    assertAcpQuantityAboveMaximum(await door.acp('POST', '/checkout_sessions', fx.acpCart(quantity), { key: freshKey() }), `create ${quantity}`);
    assertAcpQuantityAboveMaximum(await door.acp('POST', `/checkout_sessions/${id}`, fx.acpCart(quantity), { key: freshKey() }), `update ${quantity}`);
  }
  // No variant named: refused before the product read that would resolve one.
  assertAcpQuantityAboveMaximum(await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER_CONNECTED, items: [{ product_id: IDS.SIG_CONNECTED, quantity: 1000 }] }, { key: freshKey() }), 'create, variant to resolve');
  // A numeric string is not coerced and keeps the refusal a bad quantity always got.
  for (const [name, r] of [
    ['create', await door.acp('POST', '/checkout_sessions', fx.acpCart('1000'), { key: freshKey() })],
    ['update', await door.acp('POST', `/checkout_sessions/${id}`, fx.acpCart('1000'), { key: freshKey() })],
  ]) {
    assert.equal(r.http, 400, name);
    assert.deepEqual(r.body, { type: 'error', code: 'QUOTE_REQUIRED', message: 'I need a fresh price quote before placing this order.' }, name);
    sentNothing(r, `${name} string`);
  }
});

// ---- the invoke door: /agent/shop/v1/invoke and its creator alias ------------------------------------------------
//
// Three ways a quote reaches the backend from here, and the ceiling is on each:
//   - the shop route with strict checkout ON: the kernel's invoke handler (its contract validator refuses);
//   - the shop route with strict checkout OFF, and the creator alias ALWAYS (it is never the kernel's): the
//     gateway's own handler, which asks the same kernel module before it reads, rewrites or sends anything.
// One answer on all of them: 422 QUOTE_REQUIRED in this door's failure body, with the named detail.

const SHOP = '/agent/shop/v1/invoke';
const CREATOR = '/agent/creator/v1/invoke';
const INVOKE_QUANTITY_REFUSAL = Object.freeze({
  status: 'failure',
  error: 'QUOTE_REQUIRED',
  code: 'QUOTE_REQUIRED',
  message: "A line's quantity is above the maximum: at most 999 units per line are accepted. Send a whole number from 1 to 999 as each line's quantity. Retrying as sent will not change the answer.",
  retriable: false,
  detail: { reason: 'quantity_above_line_maximum', max_quantity: 999 },
});
const INVOKE_KEY_REFUSAL = Object.freeze({
  status: 'failure',
  error: 'IDEMPOTENCY_CONFLICT',
  code: 'IDEMPOTENCY_CONFLICT',
  message: 'The idempotency key is too short: it must be at least 8 characters, not counting leading or trailing whitespace or invisible formatting characters. Generate a new unique key of that length or longer (a UUID works) and send the request again with it. Retrying with this key will not change the answer.',
  retriable: false,
  detail: { reason: 'idempotency_key_too_short', min_length: 8 },
});
// What the strict contract always answered for a missing or short key on a write: unnamed, same code and status.
const INVOKE_STRICT_KEY_REFUSAL_AS_BEFORE = Object.freeze({
  status: 'failure',
  error: 'IDEMPOTENCY_CONFLICT',
  code: 'IDEMPOTENCY_CONFLICT',
  message: 'This looks like a different request reusing an old reference. Starting fresh.',
  recovery: 'use a new idempotency_key for a new request',
  retriable: false,
});
function assertInvokeRefusal(r, expected, status, label) {
  assert.equal(r.http, status, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(r.body, expected, label);
  sentNothing(r, label);
}
const invokeQuote = (quantity, extra = {}) => ({ quote: fx.nativeQuote(quantity), ...extra });
const invokeOrder = (key, quantity) => ({
  ...(key === undefined ? {} : { idempotency_key: key }),
  order: {
    quote_id: 'q_placeholder', customer_email: 'buyer@example.test',
    shipping_address: { country: 'US', city: 'Springfield', postal_code: '00000', address_line1: '1 Example Street', recipient_name: 'Example Buyer' },
    ...(quantity === undefined ? {} : { items: [{ merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SIG_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity }] }),
  },
});
// Every way a request reaches an invoke route: [label, route, strict checkout on?].
const INVOKE_WAYS = [
  ['shop, strict', SHOP, true],
  ['shop, strict off', SHOP, false],
  ['creator alias, strict', CREATOR, true],
  ['creator alias, strict off', CREATOR, false],
];

test('invoke preview_quote: 999 units are priced; 1000, and a huge number, are refused by name with nothing sent, on every route', async () => {
  for (const [label, route, strict] of INVOKE_WAYS) {
    const at = await door.invoke(route, 'preview_quote', invokeQuote(999), { strict });
    assert.equal(at.http, 200, `${label}: ${at.raw.slice(0, 300)}`);
    assert.equal(quoteCalls(at)[0].body.offer_refs[0].quantity, 999, `${label}: the quantity the backend was asked to price`);
    for (const quantity of [1000, 1001, 900000000, 1e30]) {
      assertInvokeRefusal(await door.invoke(route, 'preview_quote', invokeQuote(quantity), { strict }), INVOKE_QUANTITY_REFUSAL, 422, `${label} ${quantity}`);
    }
    // Above the ceiling on the second line only.
    const twoLines = invokeQuote(1);
    twoLines.quote.items.push({ product_id: IDS.SIG_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 1000 });
    assertInvokeRefusal(await door.invoke(route, 'preview_quote', twoLines, { strict }), INVOKE_QUANTITY_REFUSAL, 422, `${label} second line`);
  }
});

test('invoke preview_quote, strict contract: a numeric string is not a quantity there and keeps the refusal it always got', async () => {
  for (const quantity of ['1000', '5', 0, -1, 1.5]) {
    const r = await door.invoke(SHOP, 'preview_quote', invokeQuote(quantity));
    assertInvokeRefusal(r, {
      status: 'failure',
      error: 'QUOTE_REQUIRED',
      code: 'QUOTE_REQUIRED',
      message: 'I need a fresh price quote before placing this order.',
      recovery: 'call pivota_quote first',
      retriable: false,
    }, 422, `strict ${JSON.stringify(quantity)}`);
  }
});

test('invoke preview_quote, the gateway\'s own handler: it CONVERTS a quantity, so the ceiling is on what it would price', async () => {
  // This handler has always priced "999" as 999 units and "1000" as 1000: a string above the ceiling is a line
  // above the ceiling here, and is refused like one. A string within it is priced exactly as before.
  for (const [label, route, strict] of INVOKE_WAYS.filter(([, route, strict]) => route === CREATOR || !strict)) {
    const within = await door.invoke(route, 'preview_quote', invokeQuote('999'), { strict });
    assert.equal(within.http, 200, `${label}: ${within.raw.slice(0, 300)}`);
    assert.equal(quoteCalls(within)[0].body.offer_refs[0].quantity, 999, label);
    for (const quantity of ['1000', '900000000', '1e9', ' 1000 ']) {
      assertInvokeRefusal(await door.invoke(route, 'preview_quote', invokeQuote(quantity), { strict }), INVOKE_QUANTITY_REFUSAL, 422, `${label} ${JSON.stringify(quantity)}`);
    }
    // create_order on this handler may carry lines of its own (it re-quotes them): the same ceiling.
    assertInvokeRefusal(await door.invoke(route, 'create_order', invokeOrder('idem-invoke-order-01', 1000), { strict }), INVOKE_QUANTITY_REFUSAL, 422, `${label} create_order 1000`);
    assertInvokeRefusal(await door.invoke(route, 'create_order', invokeOrder('idem-invoke-order-02', '1000'), { strict }), INVOKE_QUANTITY_REFUSAL, 422, `${label} create_order "1000"`);
    const order = await door.invoke(route, 'create_order', invokeOrder('idem-invoke-order-03', 999), { strict });
    assert.notEqual(order.body && order.body.code, 'QUOTE_REQUIRED', `${label} create_order 999: ${order.raw.slice(0, 200)}`);
    assert.ok(order.upstream.length > 0, `${label} create_order 999 went on to the backend`);
  }
});

test('invoke, strict contract: an order is priced from its locked quote, so lines beside it are not read and not judged', async () => {
  const r = await door.invoke(SHOP, 'create_order', invokeOrder('idem-invoke-order-04', 1000));
  assert.equal(r.http, 404, r.raw.slice(0, 300));
  assert.equal(r.body.code, 'QUOTE_NOT_FOUND');
  sentNothing(r, 'strict create_order');
});

test('invoke, strict contract: a write with no key is refused as before; a key that is present and short gets the one named refusal, on a write and on a quote', async () => {
  const writes = {
    create_order: (key) => invokeOrder(key),
    submit_payment: (key) => ({ ...(key === undefined ? {} : { idempotency_key: key }), confirmation_token: 'placeholder', payment: { order_id: 'ord_placeholder', expected_amount: 1800, currency: 'USD' } }),
    request_after_sales: (key) => ({ ...(key === undefined ? {} : { idempotency_key: key }), status: { order_id: 'ord_placeholder', requested_action: 'refund' } }),
  };
  for (const [operation, payload] of Object.entries(writes)) {
    // NO KEY AT ALL: the kernel's contract validator (contractValidation.js), unnamed, exactly as before.
    for (const key of [undefined, '', '   ']) {
      assertInvokeRefusal(await door.invoke(SHOP, operation, payload(key)), INVOKE_STRICT_KEY_REFUSAL_AS_BEFORE, 409, `${operation} ${JSON.stringify(key)}`);
    }
    // A KEY THAT IS PRESENT AND SHORT: one rule decides, and names itself. The same status as before (409); the
    // body now says what is wrong. Includes what the older count let through (eight UTF-16 units, four characters).
    assert.equal(ASTRAL.repeat(4).length, 8);
    for (const key of ['abcdefg', 'k', '  abcdefg  ', 'abc     ', ASTRAL.repeat(4), '\u200b'.repeat(8), 'abcdefg\u200b']) {
      assertInvokeRefusal(await door.invoke(SHOP, operation, payload(key)), INVOKE_KEY_REFUSAL, 409, `${operation} ${JSON.stringify(key)}`);
    }
    for (const key of ['abcdefgh', '  abcdefgh  ', ASTRAL.repeat(8)]) {
      const r = await door.invoke(SHOP, operation, payload(key));
      assert.notEqual(r.body && r.body.code, 'IDEMPOTENCY_CONFLICT', `${operation} ${JSON.stringify(key)}: ${r.raw.slice(0, 200)}`);
    }
  }
  // A quote needs no key under the strict contract (unchanged); one that is sent is held to the minimum.
  const none = await door.invoke(SHOP, 'preview_quote', invokeQuote(1));
  assert.equal(none.http, 200, none.raw.slice(0, 300));
  for (const key of ['abcdefg', 'k', 'abc     ', ASTRAL.repeat(4)]) {
    assertInvokeRefusal(await door.invoke(SHOP, 'preview_quote', invokeQuote(1, { idempotency_key: key })), INVOKE_KEY_REFUSAL, 409, `preview_quote ${JSON.stringify(key)}`);
  }
  const eight = await door.invoke(SHOP, 'preview_quote', invokeQuote(1, { idempotency_key: 'abcdefgh' }));
  assert.equal(eight.http, 200, eight.raw.slice(0, 300));
});

test('invoke, the gateway\'s own handler: a short key gets the same named refusal whether it is plainly short, padded or wide; the request schema no longer answers it first', async () => {
  for (const [label, route, strict] of INVOKE_WAYS.filter(([, route, strict]) => route === CREATOR || !strict)) {
    for (const [operation, payload] of [['preview_quote', (key) => invokeQuote(1, { idempotency_key: key })], ['create_order', (key) => invokeOrder(key, 1)]]) {
      // BEFORE: src/schema.js (`idempotency_key: z.string().min(8)`) answered a plainly short key with a 400
      // INVALID_REQUEST, and let through 8 units that are fewer than 8 characters. NOW the shared rule is asked
      // first and answers every one of them the same way.
      for (const key of ['abcdefg', 'k', 'abc     ', '  abcdef  ', ASTRAL.repeat(4), '\u200b'.repeat(8), 'abcdefg\u200b']) {
        assertInvokeRefusal(await door.invoke(route, operation, payload(key), { strict }), INVOKE_KEY_REFUSAL, 409, `${label} ${operation} ${JSON.stringify(key)}`);
      }
      keySeq += 1;
      const eightCharacters = `k${String(keySeq).padStart(6, '0')}x`;
      assert.equal(eightCharacters.length, 8);
      const ok = await door.invoke(route, operation, payload(eightCharacters), { strict });
      assert.notEqual(ok.body && ok.body.code, 'IDEMPOTENCY_CONFLICT', `${label} ${operation} 8: ${ok.raw.slice(0, 200)}`);
      assert.ok(ok.upstream.length > 0, `${label} ${operation} 8 went on to the backend`);
      // What is not a present key is still the request schema's to judge, with the 400 it always gave: blank, or
      // not a string.
      for (const notAKey of ['', '   ', 1234567, null]) {
        const r = await door.invoke(route, operation, payload(notAKey), { strict });
        assert.equal(r.http, 400, `${label} ${operation} ${JSON.stringify(notAKey)}: ${r.raw.slice(0, 200)}`);
        assert.equal(r.body.error, 'INVALID_REQUEST', `${label} ${operation} ${JSON.stringify(notAKey)}`);
        sentNothing(r, `${label} ${operation} ${JSON.stringify(notAKey)}`);
      }
      // An operation that takes no key is not this rule's: the schema's 400 for a short one there, as before.
      const read = await door.invoke(route, 'get_order_status', { idempotency_key: 'abc', status: { order_id: 'ord_placeholder' } }, { strict: false });
      assert.equal(read.http, 400, read.raw.slice(0, 200));
      assert.equal(read.body.error, 'INVALID_REQUEST');
      // No key at all is this handler's to accept, as before.
      const none = await door.invoke(route, operation, payload(undefined), { strict });
      assert.notEqual(none.http, 409, `${label} ${operation} no key`);
      assert.ok(none.upstream.length > 0, `${label} ${operation} no key went on to the backend`);
    }
  }
});

test('invoke: an operation that carries no cart and no key is not judged by either bound', async () => {
  for (const [label, route, strict] of INVOKE_WAYS) {
    const r = await door.invoke(route, 'get_product_detail', { product: { merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SIG_CONNECTED }, quote: fx.nativeQuote(1000) }, { strict });
    assert.equal(r.http, 200, `${label}: ${r.raw.slice(0, 200)}`);
  }
});

// ---- tools/list says what the doors do ----------------------------------------------------------------------------

function collect(node, key, into, at = '$') {
  if (!node || typeof node !== 'object') return into;
  for (const [k, v] of Object.entries(node)) {
    if (k === key && v && typeof v === 'object') into.push({ at: `${at}.${k}`, schema: v });
    collect(v, key, into, `${at}.${k}`);
  }
  return into;
}

test('tools/list publishes the minimum for every idempotency key and the ceiling for every cart line quantity', async () => {
  const mcp = await door.listTools('/mcp');
  const ucp = await door.listTools('/ucp/mcp');
  const schemaOf = (tools, name) => tools.find((t) => t.name === name).inputSchema;

  const nativeKeyed = ['create_checkout_session', 'update_checkout_session', 'complete_checkout_session', 'create_payment_link', 'cancel_checkout_session', 'request_after_sales'];
  for (const tool of nativeKeyed) {
    assert.equal(schemaOf(mcp, tool).properties.idempotency_key.minLength, 8, tool);
    assert.ok(schemaOf(mcp, tool).required.includes('idempotency_key'), `${tool}: required, as before`);
  }
  assert.deepEqual(mcp.filter((t) => collect(t.inputSchema, 'idempotency_key', []).length > 0).map((t) => t.name).sort(), [...nativeKeyed].sort(), 'no other native tool takes a key');
  const ucpKeyed = ['create_checkout', 'update_checkout', 'complete_checkout'];
  for (const tool of ucpKeyed) {
    assert.equal(schemaOf(ucp, tool).properties.meta.properties['idempotency-key'].minLength, 8, tool);
    assert.deepEqual(schemaOf(ucp, tool).properties.meta.required, ['idempotency-key'], `${tool}: required, as before`);
  }
  // Every key schema either door publishes states 8, whichever tool it sits on, and says how it is counted: the
  // runtime does not count surrounding whitespace, which `minLength` alone cannot say.
  let keySchemas = 0;
  for (const tools of [mcp, ucp]) {
    for (const key of ['idempotency_key', 'idempotency-key']) {
      for (const found of collect(tools, key, [])) {
        keySchemas += 1;
        assert.equal(found.schema.minLength, 8, found.at);
        assert.ok(found.schema.description.endsWith(' At least 8 characters; leading and trailing whitespace and invisible formatting characters are not counted.'), found.at);
      }
    }
  }
  // Six native tools take a key. Every UCP tool's `meta` declares the member (three of them require it).
  assert.equal(keySchemas, 6 + ucp.length);

  for (const tool of ['create_checkout_session', 'update_checkout_session']) {
    assert.deepEqual(schemaOf(mcp, tool).properties.quote.properties.items.items.properties.quantity, { type: 'integer', minimum: 1, maximum: 999 }, tool);
    assert.equal(schemaOf(mcp, tool).properties.quote.properties.items.maxItems, 50, `${tool}: the cart's own bound is untouched`);
  }
  for (const tool of ['create_checkout', 'update_checkout']) {
    assert.deepEqual(schemaOf(ucp, tool).properties.checkout.properties.line_items.items.properties.quantity, { type: 'integer', minimum: 1, maximum: 999 }, tool);
    assert.equal(schemaOf(ucp, tool).properties.checkout.properties.line_items.maxItems, 50, `${tool}: the cart's own bound is untouched`);
  }
  // Every `quantity` schema either door publishes: the four above, each with the ceiling, and no other.
  const quantities = [...collect(mcp, 'quantity', []), ...collect(ucp, 'quantity', [])];
  assert.equal(quantities.length, 4);
  for (const found of quantities) assert.equal(found.schema.maximum, 999, found.at);
});
