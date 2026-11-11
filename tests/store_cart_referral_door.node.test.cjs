'use strict';

// A STORE CART THE DOOR BUILDS CARRIES A REFERRAL (AGENT_CHECKOUT_UCP_CART_REFERRAL_ENABLED).
//
// The door reads the product with the gateway's own key, so the catalog link it holds is the seller's direct page:
// there was nothing to carry onto the cart link, no click was recorded, and a purchase from the cart could not be
// joined to us or to the partner. With the flag on the door asks the backend for one referral just before it sends
// `create_cart`, and carries the members on the cart link and (with AGENT_CHECKOUT_UCP_CART_ATTRIBUTION_ENABLED) in
// the cart's `attribution`.
//
// END TO END over the real doors (`/ucp/mcp` and `/mcp`), two partners with their own api keys. What is real and
// what is stubbed: tests/_support/mcpStorefrontCartDoor.cjs and tests/_support/storeCartHardeningDoor.cjs. The
// backend's referral route is answered with the REAL handler's recorded answers
// (tests/fixtures/backend_storefront_cart_referral.backend.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const h = require('./_support/storeCartHardeningDoor.cjs');

const { IDS, HOST, AS, gid } = h;
const ORIGINAL_ENV = { ...process.env };
const door = h.bootHardeningDoor({ port: 4462 });
let pricing = null;

test.before(async () => {
  await door.listen();
  pricing = await import(path.join(door.root, 'mcp-server/src/ucpMerchantDoorPricing.js'));
});
test.after(async () => {
  await door.close();
  process.env = { ...ORIGINAL_ENV };
});
test.beforeEach(() => {
  door.resetHardening();
  pricing.resetCartReferralOutcomeCountsForTest();
  h.setFlags([]);
});

const decodeEsc = (id) => JSON.parse(Buffer.from(String(id).slice(4), 'base64url').toString('utf8'));
const codesOf = (answer) => ((answer.value && answer.value.messages) || []).map((m) => m.code);
const toolCalls = (answer) => answer.store.filter((c) => c.kind === 'tool');
const queryOf = (url) => [...new URL(url).searchParams.entries()];
const ucpCreate = (items, n, as = AS.A, market = 'US') => door.call('/ucp/mcp', 'create_checkout', h.ucpCreateKeyed(items, market, n), { buyer: as });
const ucpGet = (id, as = AS.A) => door.call('/ucp/mcp', 'get_checkout', { meta: h.UCP_META, id }, { buyer: as });
const membersFor = (clickId, { medium = 'create_checkout', campaign = 'US' } = {}) => [
  ['utm_source', 'pivota'], ['utm_medium', medium], ['utm_campaign', campaign], ['pvt_click_id', clickId], ['utm_content', clickId],
];
const CLICK = (n) => `clk_${n.toString(16).padStart(24, '0')}`;

// ---- flag off --------------------------------------------------------------------------------------------------

test('flag off: no referral is asked for, the cart link carries no tracking member, the id is as it was', async () => {
  h.setFlags([h.FORWARDING_FLAG, h.ATTRIBUTION_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 1]], 1);
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(a.referral, []);
  assert.deepEqual(queryOf(a.value.continue_url), [['key', 'k0']]);
  assert.deepEqual(Object.keys(decodeEsc(a.value.id)), ['v', 'i', 'c', 'h', 'm']);
  assert.equal(toolCalls(a)[0].arguments.cart.attribution, undefined);
  assert.deepEqual(pricing.cartReferralOutcomeCounts(), {});
});

// ---- the referral ----------------------------------------------------------------------------------------------

test('UCP door: ONE referral, asked before the store call, for the partner, with the seller and market and nothing of the buyer', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 1]], 2);
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront']);

  assert.equal(a.referral.length, 1);
  const [call] = a.referral;
  // Before the cart was sent: the store had received no tool call from this checkout yet.
  assert.equal(call.storeToolCallsBefore, 0);
  assert.deepEqual(toolCalls(a).map((c) => c.tool), ['create_cart']);
  // What the backend is told: the seller host, the market, the observed seller's id. Nothing else.
  assert.deepEqual(call.body, { seller_host: HOST.A, market: 'US', merchant_id: IDS.SELLER_A });
  assert.equal(JSON.stringify(call.body).includes('buyer'), false);
  // On the gateway's own key, with the partner's request-bound assertion over exactly these bytes.
  assert.equal(call.headers['x-api-key'], 'test-token');
  assert.equal(call.assertion.ok, true);
  assert.equal(call.assertion.payload.sub, h.PARTNER_A);
  assert.equal(call.assertion.payload.op, 'ucp_storefront_cart.referral');
  assert.equal(call.assertion.payload.p, h.REFERRAL_PATH);
  assert.equal(call.assertion.payload.rid, null);
  assert.equal(call.assertion.payload.bh, crypto.createHash('sha256').update(JSON.stringify(call.body), 'utf8').digest('hex'));
  // No buyer identity rides on the call.
  for (const name of Object.keys(call.headers)) assert.doesNotMatch(name, /buyer|user-ref|acp-session/i);

  // (a) The cart link: the seller's own query first, byte for byte, then the referral's members in the backend's order.
  const clickId = CLICK(1);
  assert.equal(a.value.continue_url, `https://${HOST.A}/cart/c/cart_store-a_0001?key=k0&${membersFor(clickId).map(([k, v]) => `${k}=${v}`).join('&')}`);
  // (b) Not sent as a cart attribute while that switch is off.
  assert.deepEqual(toolCalls(a)[0].arguments, { cart: { line_items: [{ item: { id: gid(IDS.VARIANT_A) }, quantity: 1 }], context: { address_country: 'US' } } });
  // The id carries the members, so a re-read hands out the same link without asking again.
  assert.deepEqual(Object.entries(decodeEsc(a.value.id).t), membersFor(clickId));
  assert.deepEqual(pricing.cartReferralOutcomeCounts(), { minted: 1 });

  const again = await ucpGet(a.value.id);
  assert.equal(again.isError, false, again.raw);
  assert.equal(again.value.continue_url, a.value.continue_url);
  assert.deepEqual(again.referral, []);
  assert.deepEqual(toolCalls(again).map((c) => c.tool), ['get_cart']);
  assert.deepEqual(pricing.cartReferralOutcomeCounts(), { minted: 1 });
});

test('with the cart attribute switch on, the SAME members ride as cart.attribution, and only tracking members', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.ATTRIBUTION_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 2], [IDS.SIG_A_SECOND, 1]], 3);
  assert.equal(a.isError, false, a.raw);
  assert.equal(a.referral.length, 1, 'one referral per cart, whatever its lines');
  const sent = toolCalls(a)[0].arguments.cart;
  assert.deepEqual(Object.entries(sent.attribution), membersFor(CLICK(1)));
  for (const key of Object.keys(sent.attribution)) assert.match(key, /^(utm_|pvt_)/);
  assert.deepEqual(Object.keys(sent).sort(), ['attribution', 'context', 'line_items']);
  assert.deepEqual(queryOf(a.value.continue_url).slice(1), membersFor(CLICK(1)));
  // A re-read sends no attribute (it is a get_cart) and carries the same members on the link.
  const again = await ucpGet(a.value.id);
  assert.deepEqual(toolCalls(again)[0].arguments, { id: 'cart_store-a_0001' });
  assert.equal(again.value.continue_url, a.value.continue_url);
});

test('native door: the same referral on a cart built through /mcp', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.ATTRIBUTION_FLAG, h.NATIVE_DOOR_FLAG]);
  const a = await door.call('/mcp', 'create_checkout_session', h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 4 }), { buyer: AS.A });
  assert.equal(a.isError, false, a.raw);
  assert.equal(a.value.status, 'completes_on_seller_storefront');
  assert.equal(a.referral.length, 1);
  assert.equal(a.referral[0].storeToolCallsBefore, 0);
  assert.deepEqual(a.referral[0].body, { seller_host: HOST.A, market: 'US', merchant_id: IDS.SELLER_A });
  assert.equal(a.referral[0].assertion.payload.sub, h.PARTNER_A);
  assert.deepEqual(queryOf(a.value.continue_url), [['key', 'k0'], ...membersFor(CLICK(1))]);
  assert.deepEqual(Object.entries(toolCalls(a)[0].arguments.cart.attribution), membersFor(CLICK(1)));
  const again = await door.call('/mcp', 'get_checkout_session', { session_id: a.value.session_id }, { buyer: AS.A });
  assert.equal(again.value.continue_url, a.value.continue_url);
  assert.deepEqual(again.referral, []);
});

test('each partner\'s cart gets its own referral, signed for that partner', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 1]], 5, AS.A);
  const b = await ucpCreate([[IDS.SIG_A, 1]], 6, AS.B);
  assert.deepEqual([a.referral[0].assertion.payload.sub, b.referral[0].assertion.payload.sub], [h.PARTNER_A, h.PARTNER_B]);
  assert.notEqual(decodeEsc(a.value.id).t.pvt_click_id, decodeEsc(b.value.id).t.pvt_click_id);
  assert.notEqual(a.referral[0].assertion.payload.jti, b.referral[0].assertion.payload.jti);
});

test('partner identity forwarding off: the referral is still minted, on the gateway\'s key alone, for no partner', async () => {
  h.setFlags([h.REFERRAL_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 1]], 7);
  assert.equal(a.isError, false, a.raw);
  assert.equal(a.referral.length, 1);
  assert.equal(a.referral[0].assertion, null, 'no partner assertion is sent');
  assert.equal(a.referral[0].headers['x-api-key'], 'test-token');
  assert.deepEqual(queryOf(a.value.continue_url), [['key', 'k0'], ...membersFor(CLICK(1))]);
});

test('the referral records the market the cart was built for: the assumed one when the buyer named none, the named one otherwise', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 1]], 8, AS.A, null);
  assert.ok(a.value.market_assumed, 'answered for an assumed market');
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(a.referral[0].body, { seller_host: HOST.A, market: 'US', merchant_id: IDS.SELLER_A });
  assert.equal(toolCalls(a)[0].arguments.cart.context.address_country, 'US');
  assert.equal(new URL(a.value.continue_url).searchParams.get('utm_campaign'), 'US');
  // A cart built for another market is recorded for that market, never for a default.
  const sg = await ucpCreate([[IDS.SIG_A, 1]], 81, AS.A, 'SG');
  assert.equal(sg.isError, false, sg.raw);
  assert.equal(toolCalls(sg)[0].arguments.cart.context.address_country, 'SG');
  assert.deepEqual(sg.referral[0].body, { seller_host: HOST.A, market: 'SG', merchant_id: IDS.SELLER_A });
  assert.equal(new URL(sg.value.continue_url).searchParams.get('utm_campaign'), 'SG');
});

// ---- a link that already carries a referral --------------------------------------------------------------------

test('a catalog link that already carries tracking members is left alone: no referral is minted', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.ATTRIBUTION_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A_STAMPED, 1]], 9);
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(a.referral, []);
  assert.deepEqual(queryOf(a.value.continue_url), [['key', 'k0'], ...h.STAMPED_TRACKING]);
  assert.deepEqual(Object.entries(toolCalls(a)[0].arguments.cart.attribution), [...h.STAMPED_TRACKING]);
  assert.equal(decodeEsc(a.value.id).t, undefined);
  assert.deepEqual(pricing.cartReferralOutcomeCounts(), {});
});

// ---- nothing is minted for a checkout that sends no cart ---------------------------------------------------------

test('no store call, no referral: an unresolved variant, a declined seller, a connected merchant', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.NATIVE_DOOR_FLAG]);
  const unresolved = await ucpCreate([[IDS.SIG_A_MULTI, 1]], 10);
  const declined = await ucpCreate([[IDS.SIG_C, 1]], 11);
  const connected = await door.call('/mcp', 'create_checkout_session', h.nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 12 }), { buyer: AS.A });
  for (const answer of [unresolved, declined, connected]) {
    assert.deepEqual(answer.referral, []);
    assert.deepEqual(toolCalls(answer), []);
  }
  assert.deepEqual(codesOf(unresolved), ['checkout.completes_on_seller_storefront']);
  assert.deepEqual(pricing.cartReferralOutcomeCounts(), {});
});

test('a cart the store answered but the door rejected: the catalog answer, with no tracking member and no id member', async () => {
  // The referral was minted (the cart was about to be sent); the store's answer was then refused. The buyer gets the
  // product page, and the unused click row stays on the hand-off surface, where issued-link counts leave it out.
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG]);
  const a = await ucpCreate([[IDS.SIG_B, 1]], 13);
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(codesOf(a), ['checkout.completes_on_seller_storefront']);
  assert.equal(a.referral.length, 1);
  assert.equal(a.value.continue_url, `https://${HOST.B}/products/barrier-cream?variant=${IDS.VARIANT_B}`);
  assert.equal(decodeEsc(a.value.id).t, undefined);
});

// ---- a miss never fails the buyer --------------------------------------------------------------------------------

for (const [mode, reason] of [
  ['dark', 'http_404'],
  ['store_unavailable', 'referral_store_unavailable'],
  ['assertion_rejected', 'PARTNER_ASSERTION_REJECTED'],
  ['not_a_service_caller', 'service_caller_required'],
  ['invalid_body', 'http_400'],
  ['malformed', 'malformed_answer'],
]) {
  test(`a referral the backend does not mint (${mode}) is a counted miss: the store cart is built anyway, unattributed`, async () => {
    h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.ATTRIBUTION_FLAG]);
    door.setReferralBackend(mode);
    assert.equal(pricing.REFERRAL_MISS_POLICY, 'build_cart_unattributed');
    const a = await ucpCreate([[IDS.SIG_A, 1]], 20);
    assert.equal(a.isError, false, a.raw);
    assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront']);
    assert.equal(a.referral.length, 1, 'asked once, never retried');
    assert.deepEqual(toolCalls(a).map((c) => c.tool), ['create_cart']);
    assert.equal(toolCalls(a)[0].arguments.cart.attribution, undefined);
    assert.deepEqual(queryOf(a.value.continue_url), [['key', 'k0']]);
    assert.equal(decodeEsc(a.value.id).t, undefined);
    assert.deepEqual(pricing.cartReferralOutcomeCounts(), { [`miss:${reason}`]: 1 });
    // The re-read is the plain cart too.
    const again = await ucpGet(a.value.id);
    assert.equal(again.value.continue_url, a.value.continue_url);
  });
}

test('a referral that does not answer in time is a miss after one second, and the cart is still built', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG]);
  door.setReferralBackend('recorded', { delayMs: 1600 });
  assert.equal(pricing.REFERRAL_MINT_BUDGET_MS, 1000);
  const started = Date.now();
  const a = await ucpCreate([[IDS.SIG_A, 1]], 21);
  const took = Date.now() - started;
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront']);
  assert.deepEqual(queryOf(a.value.continue_url), [['key', 'k0']]);
  assert.ok(took >= 950 && took < 1550, `the door waited about the budget and no longer (${took} ms)`);
  assert.deepEqual(pricing.cartReferralOutcomeCounts(), { 'miss:timeout': 1 });
});

// ---- with the hand-off record -----------------------------------------------------------------------------------

test('with the hand-off record on, the record names the minted click and the id carries both', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.HANDOFF_RECORD_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 1]], 30);
  assert.equal(a.isError, false, a.raw);
  const id = decodeEsc(a.value.id);
  assert.match(id.r, /^esh_[A-Za-z0-9_-]{22}$/);
  assert.equal(id.t.pvt_click_id, CLICK(1));
  assert.equal(a.handoff.length, 1);
  assert.equal(a.handoff[0].body.referral_click_id, CLICK(1));
  assert.equal(a.handoff[0].body.record_id, id.r);
  assert.equal(a.handoff[0].body.binding, crypto.createHash('sha256').update(a.value.id, 'utf8').digest('hex'));
  // Two backend calls for this cart, in this order: the referral (before the store), then the record (after).
  assert.equal(a.referral.length, 1);
  assert.equal(a.referral[0].storeToolCallsBefore, 0);
  // A stamped link's own click is still the one recorded, and nothing is minted for it.
  const stamped = await ucpCreate([[IDS.SIG_A_STAMPED, 1]], 31);
  assert.deepEqual(stamped.referral, []);
  assert.equal(stamped.handoff[0].body.referral_click_id, h.STAMPED_CLICK_ID);
});

// ---- without change 2, each create is its own cart and its own referral --------------------------------------------

test('two creates are two carts and two referrals', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG]);
  const a = await ucpCreate([[IDS.SIG_A, 1]], 40);
  const b = await ucpCreate([[IDS.SIG_A, 1]], 41);
  assert.deepEqual([a.referral.length, b.referral.length], [1, 1]);
  assert.deepEqual([decodeEsc(a.value.id).t.pvt_click_id, decodeEsc(b.value.id).t.pvt_click_id], [CLICK(1), CLICK(2)]);
  assert.deepEqual([decodeEsc(a.value.id).c, decodeEsc(b.value.id).c], ['cart_store-a_0001', 'cart_store-a_0002']);
});

// ---- ids nobody minted --------------------------------------------------------------------------------------------

test('a re-read carries only well-formed tracking members from an id, and only while the flag is on', async () => {
  h.setFlags([h.REFERRAL_FLAG]);
  const made = await ucpCreate([[IDS.SIG_A, 1]], 50);
  const body = decodeEsc(made.value.id);
  // Members that are not tracking members are ignored whole; the id still reads its cart.
  const bad = await ucpGet(h.escId({ ...body, t: { utm_source: 'pivota', note: 'https://elsewhere.example/' } }));
  assert.equal(bad.isError, false, bad.raw);
  assert.deepEqual(queryOf(bad.value.continue_url), [['key', 'k0']]);
  const url = await ucpGet(h.escId({ ...body, t: { utm_source: 'https://elsewhere.example/' } }));
  assert.deepEqual(queryOf(url.value.continue_url), [['key', 'k0']]);
  // Flag off: the member is not read at all.
  h.setFlags([]);
  const off = await ucpGet(made.value.id);
  assert.equal(off.isError, false, off.raw);
  assert.deepEqual(queryOf(off.value.continue_url), [['key', 'k0']]);
});
