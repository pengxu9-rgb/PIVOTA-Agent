// THE STOREFRONT CHECKOUT ID IS BOUND TO ITS BUYER (AGENT_CHECKOUT_STORE_CART_ID_BINDING): the id itself and the lane.
// The doors end to end: tests/store_cart_id_binding_door.node.test.cjs.
//
// Pinned here: the three modes and what any other value means; the v3 shape and that a build before this one reads
// it as no id of its own; what the binding covers; who may read which id under which mode; fail closed with no key
// or no buyer; the hand-off record reference, the referral members and the market survive in a bound id.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UCP_ESCALATION_FLAG, ID_BINDING_FLAG, ID_BINDING_MODES, ID_BINDING_SECRET_ENV, idBindingMode,
  encodeEscalationId, decodeEscalationId, isEscalationId, escalationIdReadable, escalationIdIsBound,
  escalationCartIdOf, escalationSellerHostOf, escalationMarketOf, escalationRecordIdOf, escalationTrackingOf,
  tryEscalateUcpCheckout, refuseUnservedStorefrontCheckout,
} from '../src/ucpCheckoutEscalation.js';
import { MERCHANT_PRICING_FLAG } from '../src/ucpMerchantDoorPricing.js';

const SECRET = 'unit-confirmation-secret-0123456789';
const MINT = { [ID_BINDING_FLAG]: 'mint', [ID_BINDING_SECRET_ENV]: SECRET };
const ENFORCE = { [ID_BINDING_FLAG]: 'enforce', [ID_BINDING_SECRET_ENV]: SECRET };
const OFF = { [ID_BINDING_SECRET_ENV]: SECRET };
const ITEMS = [{ product_id: 'sig_bind_a', quantity: 2 }];
const RECORD = `esh_${'r'.repeat(22)}`;
const TRACKING = [['utm_source', 'pivota'], ['pvt_click_id', 'clk_0000000000000000000000b1']];
const escBody = (id) => JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8'));
const escOf = (body) => `esc_${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`;
const priced = (userRef, env = MINT, over = {}) => encodeEscalationId(over.items || ITEMS, over.cart || 'cart_1', 'shop-a.example.com', { code: over.market || 'US' }, over.record, over.tracking, { userRef, env });
const catalogue = (userRef, env = MINT) => encodeEscalationId(ITEMS, undefined, undefined, { code: 'US' }, undefined, undefined, { userRef, env });

describe('the switch', () => {
  test('off, mint, enforce; anything else is off', () => {
    assert.equal(ID_BINDING_FLAG, 'AGENT_CHECKOUT_STORE_CART_ID_BINDING');
    assert.equal(ID_BINDING_SECRET_ENV, 'CONFIRMATION_SECRET');
    assert.deepEqual(Object.values(ID_BINDING_MODES), ['off', 'mint', 'enforce']);
    for (const [value, mode] of [['mint', 'mint'], [' Mint ', 'mint'], ['ENFORCE', 'enforce'], ['off', 'off'], ['', 'off'], ['1', 'off'], ['true', 'off'], ['on', 'off'], ['enforced', 'off'], [undefined, 'off']]) {
      assert.equal(idBindingMode({ [ID_BINDING_FLAG]: value }), mode, String(value));
    }
  });
});

describe('the id', () => {
  test('off, or nothing to bind to: the v1/v2 id it always was, byte for byte', () => {
    const v2 = encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' });
    const v1 = encodeEscalationId(ITEMS, undefined, undefined, { code: 'US' });
    assert.equal(priced('buyer-1', OFF), v2);
    assert.equal(catalogue('buyer-1', OFF), v1);
    assert.equal(encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' }, undefined, undefined, undefined), v2);
    assert.deepEqual([escBody(v2).v, escBody(v1).v], [2, 1]);
  });

  test('mint: v3, the same members in the same order, then the binding', () => {
    const id = priced('buyer-1', MINT, { record: RECORD, tracking: TRACKING });
    assert.deepEqual(Object.keys(escBody(id)), ['v', 'i', 'c', 'h', 'm', 'r', 't', 'b']);
    assert.equal(escBody(id).v, 3);
    assert.match(escBody(id).b, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(Object.keys(escBody(catalogue('buyer-1'))), ['v', 'i', 'm', 'b']);
    // Everything an id carried still reads: the items, the cart, the seller, the market, the record, the referral.
    assert.deepEqual(decodeEscalationId(id), ITEMS);
    assert.equal(isEscalationId(id), true);
    assert.equal(escalationIdIsBound(id), true);
    assert.equal(escalationCartIdOf(id), 'cart_1');
    assert.equal(escalationSellerHostOf(id), 'shop-a.example.com');
    assert.deepEqual(escalationMarketOf(id), { market: 'US', assumed: false, legacy: false });
    assert.equal(escalationRecordIdOf(id), RECORD);
    assert.deepEqual(escalationTrackingOf(id), TRACKING);
    assert.equal(escalationCartIdOf(catalogue('buyer-1')), undefined);
    assert.equal(escalationIdIsBound(encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' })), false);
  });

  test('a build before this one reads a v3 id as no id of its own (its version rule, verbatim)', () => {
    // The rule of every earlier build: v2 needs a cart and a host; anything else must be v1 with neither.
    const earlierBuildAccepts = (parsed) => !(parsed.v === 2
      ? (typeof parsed.c !== 'string' || typeof parsed.h !== 'string')
      : (parsed.v !== 1 || parsed.c !== undefined || parsed.h !== undefined));
    assert.equal(earlierBuildAccepts(escBody(priced('buyer-1'))), false);
    assert.equal(earlierBuildAccepts(escBody(catalogue('buyer-1'))), false);
    assert.equal(earlierBuildAccepts(escBody(encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' }))), true);
  });

  test('a v3 id is well formed only with a binding of the right shape; a v1/v2 id only without one', () => {
    const body = escBody(priced('buyer-1'));
    for (const bad of [{ ...body, b: undefined }, { ...body, b: 'short' }, { ...body, b: 7 }, { ...body, b: `${body.b}x` }, { ...body, c: undefined }, { ...body, h: undefined }, { ...body, v: 4 }, { ...body, v: 2 }, { ...escBody(catalogue('buyer-1')), v: 1 }]) {
      assert.equal(decodeEscalationId(escOf(bad)), null, JSON.stringify(bad));
      assert.equal(escalationIdReadable(escOf(bad), 'buyer-1', MINT), false);
    }
  });
});

describe('who may read an id', () => {
  const bound = priced('buyer-1');
  const unbound = encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' });
  test('a bound id: its buyer, under every mode; nobody else, under any', () => {
    for (const env of [OFF, MINT, ENFORCE]) {
      assert.equal(escalationIdReadable(bound, 'buyer-1', env), true);
      for (const other of ['buyer-2', 'buyer-1 ', 'BUYER-1', '', null, undefined, 1]) assert.equal(escalationIdReadable(bound, other, env), other === 'buyer-1 ' ? true : false, String(other));
    }
  });
  test('an unbound id: anyone under off and mint (as before); no one under enforce', () => {
    for (const who of ['buyer-1', 'buyer-2']) {
      assert.equal(escalationIdReadable(unbound, who, OFF), true);
      assert.equal(escalationIdReadable(unbound, who, MINT), true);
      assert.equal(escalationIdReadable(unbound, who, ENFORCE), false);
    }
  });
  test('the binding covers every member: change one and the id is nobody\'s', () => {
    const body = escBody(priced('buyer-1', MINT, { record: RECORD, tracking: TRACKING }));
    const changes = {
      quantity: { i: [['sig_bind_a', 9]] }, product: { i: [['sig_other', 2]] }, cart: { c: 'cart_2' }, host: { h: 'shop-b.example.com' },
      market: { m: 'GB' }, record: { r: `esh_${'q'.repeat(22)}` }, tracking: { t: { utm_source: 'elsewhere' } },
    };
    for (const [name, change] of Object.entries(changes)) assert.equal(escalationIdReadable(escOf({ ...body, ...change }), 'buyer-1', MINT), false, name);
    assert.equal(escalationIdReadable(escOf(body), 'buyer-1', MINT), true);
    // A member added or dropped, too.
    const { r: _r, ...withoutRecord } = body;
    assert.equal(escalationIdReadable(escOf(withoutRecord), 'buyer-1', MINT), false);
    assert.equal(escalationIdReadable(escOf({ v: 3, i: body.i, c: body.c, h: body.h, m: body.m, a: 1, r: body.r, t: body.t, b: body.b }), 'buyer-1', MINT), false);
  });
  test('a GB cart and a US cart of one buyer are two bindings', () => {
    const us = priced('buyer-1', MINT, { market: 'US' });
    const gb = priced('buyer-1', MINT, { market: 'GB' });
    assert.notEqual(escBody(us).b, escBody(gb).b);
    assert.equal(escalationIdReadable(escOf({ ...escBody(us), m: 'GB' }), 'buyer-1', MINT), false);
    assert.deepEqual([escalationMarketOf(us).market, escalationMarketOf(gb).market], ['US', 'GB']);
  });
  test('the key: another secret, a short one or none reads no bound id; the binding is not the secret\'s plain HMAC', async () => {
    assert.equal(escalationIdReadable(bound, 'buyer-1', { ...MINT, [ID_BINDING_SECRET_ENV]: 'another-confirmation-secret-0123456789' }), false);
    assert.equal(escalationIdReadable(bound, 'buyer-1', { ...MINT, [ID_BINDING_SECRET_ENV]: 'short' }), false);
    assert.equal(escalationIdReadable(bound, 'buyer-1', { [ID_BINDING_FLAG]: 'mint' }), false);
    // No key: nothing is bound (the lane refuses the create instead; below).
    assert.equal(escBody(priced('buyer-1', { [ID_BINDING_FLAG]: 'mint' })).v, 2);
    assert.equal(escBody(priced('', MINT)).v, 2);
    const { createHmac } = await import('node:crypto');
    const { b, ...members } = escBody(bound);
    assert.notEqual(createHmac('sha256', SECRET).update(JSON.stringify([members, 'buyer-1']), 'utf8').digest('base64url'), b, 'a derived key, with a label of its own');
  });
  test('an id that is not ours at all is not readable, under any mode', () => {
    for (const env of [OFF, MINT, ENFORCE]) for (const id of ['esc_bm90LWFuLWlk', 'q_123', '', null, undefined]) assert.equal(escalationIdReadable(id, 'buyer-1', env), false);
  });
});

describe('the lane', () => {
  const BASE = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1', [ID_BINDING_SECRET_ENV]: SECRET };
  const SEED = Object.freeze({
    product_id: 'sig_bind_a', merchant_id: 'merch_obs_shop_a', title: 'Serum X', price: 25, currency: 'USD',
    external_redirect_url: 'https://shop-a.example.com/products/serum-x?variant=1',
    variants: [{ variant_id: 'sig_bind_a', source_variant_id: '44012345678901' }],
  });
  const executor = { async execute(op) { return op === 'get_product' ? { product: structuredClone(SEED) } : {}; } };
  const cart = () => ({ ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify({
    id: 'cart_1', currency: 'USD', continue_url: 'https://shop-a.example.com/cart/c/cart_1?key=k',
    line_items: [{ id: 'l0', item: { id: 'gid://shopify/ProductVariant/44012345678901', title: 'T', price: 2400 }, quantity: 2, totals: [{ type: 'subtotal', amount: 4800 }, { type: 'total', amount: 4800 }] }],
    totals: [{ type: 'subtotal', amount: 4800 }, { type: 'total', amount: 4800 }],
  }) }] } } });
  const fakeDoor = () => { const calls = []; return { calls, async endpointFor() { return 'https://shop-a.example.com/api/ucp/mcp'; }, async createCart() { calls.push('create_cart'); return cart(); }, async getCart() { calls.push('get_cart'); return cart(); } }; };
  const create = ({ env, user = 'buyer-1', door = fakeDoor(), log }) => tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session' }, ctx: { user_ref: user }, params: { idempotency_key: 'idem-bind-0001', quote: { items: [{ product_id: SEED.product_id, quantity: 2 }] } },
    executor, ucpArgs: { checkout: { context: { address_country: 'US' } } }, env, now: 1000, merchantDoor: door, log,
  });
  const op = (opId, id, { env, user, door = fakeDoor() }) => tryEscalateUcpCheckout({
    op: { id: opId }, ctx: { user_ref: user }, params: { session_id: id, idempotency_key: 'idem-bind-0002' }, executor, ucpArgs: {}, env, now: 2000, merchantDoor: door,
  });

  test('mint: the id handed out is bound; its buyer re-reads it; for anyone else every operation is "not one of ours"', async () => {
    const env = { ...BASE, [ID_BINDING_FLAG]: 'mint' };
    const made = await create({ env });
    assert.equal(escBody(made.id).v, 3);
    const door = fakeDoor();
    const own = await op('get_checkout_session', made.id, { env, user: 'buyer-1', door });
    assert.equal(own.id, made.id);
    assert.deepEqual(door.calls, ['get_cart']);
    for (const opId of ['get_checkout_session', 'update_checkout_session', 'complete_checkout_session']) {
      const other = fakeDoor();
      assert.equal(await op(opId, made.id, { env, user: 'buyer-2', door: other }), null, opId);
      assert.deepEqual(other.calls, [], opId);
      // The door's own refusal of an id no lane served does not see it either: it answers as for a kernel id.
      assert.equal(await refuseUnservedStorefrontCheckout({ op: { id: opId }, params: { session_id: made.id }, ctx: { user_ref: 'buyer-2' }, executor, env }), undefined, opId);
    }
    // Its own buyer's update and complete keep their named refusal.
    await assert.rejects(op('update_checkout_session', made.id, { env, user: 'buyer-1' }), (err) => err.detail.reason === 'ucp_escalation_update_refused');
  });

  test('enforce: an unbound id is not one of ours, whoever holds it', async () => {
    const unbound = (await create({ env: BASE })).id;
    assert.equal(escBody(unbound).v, 2);
    assert.equal((await op('get_checkout_session', unbound, { env: { ...BASE, [ID_BINDING_FLAG]: 'mint' }, user: 'buyer-2' })).id, unbound);
    assert.equal(await op('get_checkout_session', unbound, { env: { ...BASE, [ID_BINDING_FLAG]: 'enforce' }, user: 'buyer-1' }), null);
  });

  test('fail closed: the switch on with no key, or no verified buyer, hands out nothing and contacts no seller', async () => {
    for (const [env, user, reason] of [
      [{ ...BASE, [ID_BINDING_FLAG]: 'mint', [ID_BINDING_SECRET_ENV]: undefined }, 'buyer-1', 'no_key'],
      [{ ...BASE, [ID_BINDING_FLAG]: 'enforce', [ID_BINDING_SECRET_ENV]: 'short' }, 'buyer-1', 'no_key'],
      [{ ...BASE, [ID_BINDING_FLAG]: 'mint' }, '', 'no_buyer'],
    ]) {
      const door = fakeDoor();
      const lines = [];
      const out = await create({ env, user, door, log: { error: (f) => lines.push(f) } });
      assert.equal(out, null);
      assert.deepEqual(door.calls, []);
      assert.deepEqual(lines, [{ event: 'storefront_cart_id_binding', outcome: 'unbindable', reason }]);
    }
    // Off: no key is needed, and the id is the unbound one.
    assert.equal(escBody((await create({ env: { ...BASE, [ID_BINDING_SECRET_ENV]: undefined } })).id).v, 2);
  });
});
