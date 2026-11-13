'use strict';

// THE STOREFRONT CHECKOUT ID IS BOUND TO THE BUYER THAT CREATED IT (AGENT_CHECKOUT_STORE_CART_ID_BINDING).
//
// An `esc_` id was a bearer handle: any verified buyer holding it could read the cart's totals and link. With the
// switch on `mint`, new ids are v3 and carry a binding to the creating buyer; with `enforce`, unbound ids are no
// longer read. Through the real doors (`/ucp/mcp` and `/mcp`; tests/_support/storeCartHardeningDoor.cjs): a bound
// id presented by another buyer answers, on every operation, EXACTLY what an id that never existed answers.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./_support/storeCartHardeningDoor.cjs');

const { IDS, AS } = h;
const ORIGINAL_ENV = { ...process.env };
const door = h.bootHardeningDoor({ port: 4465 });

test.before(async () => { await door.listen(); });
test.after(async () => {
  await door.close();
  process.env = { ...ORIGINAL_ENV };
});
test.beforeEach(() => { door.resetHardening(); h.setFlags([]); process.env.CONFIRMATION_SECRET = ORIGINAL_SECRET; });
const ORIGINAL_SECRET = process.env.CONFIRMATION_SECRET;

let keySeq = 3000;
const nextKey = () => (keySeq += 1);
const decodeEsc = (id) => JSON.parse(Buffer.from(String(id).slice(4), 'base64url').toString('utf8'));
const errorOf = (answer) => (answer.value && answer.value.error) || null;
const ucpCreate = (items, { as = AS.A, market = 'US' } = {}) => door.call('/ucp/mcp', 'create_checkout', h.ucpCreateKeyed(items, market, nextKey()), { buyer: as });

// Every operation that takes a checkout id, on both doors. `id` is put where each tool takes it.
const OPERATIONS = {
  'ucp get_checkout': (id, as) => door.call('/ucp/mcp', 'get_checkout', { meta: h.UCP_META, id }, { buyer: as }),
  'ucp update_checkout': (id, as) => door.call('/ucp/mcp', 'update_checkout', { meta: { ...h.UCP_META, 'idempotency-key': h.idem(3901) }, id, checkout: { line_items: [{ item: { id: IDS.SIG_A }, quantity: 2 }] } }, { buyer: as }),
  'ucp complete_checkout': (id, as) => door.call('/ucp/mcp', 'complete_checkout', { meta: { ...h.UCP_META, 'idempotency-key': h.idem(3902) }, id, checkout: { payment: { instruments: [] } } }, { buyer: as }),
  'mcp get_checkout_session': (id, as) => door.call('/mcp', 'get_checkout_session', { session_id: id }, { buyer: as }),
  'mcp update_checkout_session': (id, as) => door.call('/mcp', 'update_checkout_session', { ...h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 2]], { n: 3903 }), session_id: id }, { buyer: as }),
  'mcp complete_checkout_session': (id, as) => door.call('/mcp', 'complete_checkout_session', { idempotency_key: h.idem(3904), session_id: id, payment_authorization: { type: 'none' } }, { buyer: as }),
  'mcp cancel_checkout_session': (id, as) => door.call('/mcp', 'cancel_checkout_session', { idempotency_key: h.idem(3905), session_id: id }, { buyer: as }),
  'mcp create_payment_link': (id, as) => door.call('/mcp', 'create_payment_link', { idempotency_key: h.idem(3906), session_id: id, customer_email: 'buyer@example.test' }, { buyer: as }),
  'mcp get_order': (id, as) => door.call('/mcp', 'get_order', { order_id: id }, { buyer: as }),
};
// An answer with the id it was asked about, and the clock, taken out: what is left must not depend on the id.
const shape = (answer, id) => String(answer.raw).split(id).join('<id>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>');
const traffic = (answer) => JSON.stringify({ store: answer.store, gate: answer.gate, upstream: answer.upstream.map((u) => u.op), handoffReads: answer.handoffReads.length });
// An id that never existed, of the same shape and length as `id`: the same members, another cart, a random binding.
const neverExisted = (id) => {
  const body = decodeEsc(id);
  return h.escId({ ...body, ...(body.c ? { c: 'cart_store-a_9999' } : {}), b: Buffer.from(String(body.b), 'base64url').reverse().toString('base64url') });
};

test('off: ids are unbound and any verified buyer holding one reads it (what the switch changes)', async () => {
  const made = await ucpCreate([[IDS.SIG_A, 1]]);
  assert.deepEqual(Object.keys(decodeEsc(made.value.id)), ['v', 'i', 'c', 'h', 'm']);
  assert.equal(decodeEsc(made.value.id).v, 2);
  const other = await OPERATIONS['ucp get_checkout'](made.value.id, AS.A_OTHER_BUYER);
  assert.equal(other.isError, false, other.raw);
  assert.equal(other.value.continue_url, made.value.continue_url);
});

test('mint: a new id is v3 with a binding, and its buyer reads it on both doors', async () => {
  h.setFlags([h.BIND_MINT, h.NATIVE_DOOR_FLAG]);
  const priced = await ucpCreate([[IDS.SIG_A, 1]]);
  assert.equal(priced.isError, false, priced.raw);
  const body = decodeEsc(priced.value.id);
  assert.deepEqual(Object.keys(body), ['v', 'i', 'c', 'h', 'm', 'b']);
  assert.equal(body.v, 3);
  assert.match(body.b, /^[A-Za-z0-9_-]{43}$/);
  // The catalogue answer's id is bound too.
  const fallback = await ucpCreate([[IDS.SIG_B, 1]]);
  assert.deepEqual(Object.keys(decodeEsc(fallback.value.id)), ['v', 'i', 'm', 'b']);
  // A native create mints one as well.
  const native = await door.call('/mcp', 'create_checkout_session', h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: nextKey() }), { buyer: AS.A });
  assert.equal(decodeEsc(native.value.session_id).v, 3);
  // The buyer's own reads.
  for (const [id, total] of [[priced.value.id, 2750], [native.value.session_id, 2750]]) {
    const viaUcp = await OPERATIONS['ucp get_checkout'](id, AS.A);
    const viaMcp = await OPERATIONS['mcp get_checkout_session'](id, AS.A);
    assert.equal(viaUcp.isError, false, viaUcp.raw);
    assert.equal(viaMcp.isError, false, viaMcp.raw);
    assert.equal(viaUcp.value.totals.find((t) => t.type === 'total').amount, total);
    assert.deepEqual(viaUcp.store.filter((c) => c.kind === 'tool').map((c) => c.tool), ['get_cart']);
  }
  const ownFallback = await OPERATIONS['ucp get_checkout'](fallback.value.id, AS.A);
  assert.equal(ownFallback.isError, false, ownFallback.raw);
  // Its buyer's update, complete, cancel and payment link keep their own named refusals.
  assert.equal(errorOf(await OPERATIONS['ucp update_checkout'](priced.value.id, AS.A)).detail.reason, 'escalated_checkout');
  assert.equal(errorOf(await OPERATIONS['mcp cancel_checkout_session'](priced.value.id, AS.A)).detail.reason, 'escalated_checkout');
});

for (const [who, as] of [['another buyer of the same partner', 'A_OTHER_BUYER'], ['a buyer of another partner', 'B']]) {
  test(`mint: ${who} gets, on every operation, exactly the answer for an id that never existed`, async () => {
    h.setFlags([h.BIND_MINT, h.NATIVE_DOOR_FLAG, h.HANDOFF_RECORD_FLAG, h.FORWARDING_FLAG]);
    const made = await ucpCreate([[IDS.SIG_A, 3]]);
    assert.equal(made.isError, false, made.raw);
    const id = made.value.id;
    assert.match(decodeEsc(id).r, /^esh_/, 'a recorded hand-off, so get_order has something to find');
    const ghost = neverExisted(id);
    assert.equal(ghost.length, id.length);
    for (const [name, run] of Object.entries(OPERATIONS)) {
      door.resetGate();
      const theirs = await run(id, AS[as]);
      door.resetGate();
      const unknown = await run(ghost, AS[as]);
      assert.equal(shape(theirs, id), shape(unknown, ghost), `${name}: the answer`);
      assert.equal(traffic(theirs), traffic(unknown), `${name}: what the call reached`);
      // And exactly the answer for a string that is no id of any shape.
      door.resetGate();
      const noise = await run(h.FORGED_ESC_ID, AS[as]);
      assert.equal(shape(theirs, id), shape(noise, h.FORGED_ESC_ID), `${name}: the answer for a string that is no id`);
      assert.equal(traffic(theirs), traffic(noise), `${name}: what that call reached`);
      assert.equal(theirs.store.length, 0, `${name}: the seller is not asked`);
      assert.equal(theirs.handoffReads.length, 0, `${name}: the hand-off record is not read`);
      assert.equal(String(theirs.raw).includes('cart_store-a'), false, `${name}: nothing of the cart`);
    }
    // The buyer it belongs to still reads it, and its order.
    const own = await OPERATIONS['ucp get_checkout'](id, AS.A);
    assert.equal(own.isError, false, own.raw);
    const ownOrder = await OPERATIONS['mcp get_order'](id, AS.A);
    assert.equal(ownOrder.handoffReads.length, 1);
    assert.equal(ownOrder.isError, false, ownOrder.raw);
    assert.equal(ownOrder.value.status, 'handed_off');
  });
}

test('mint: an id whose members were changed, or whose binding was moved from another id, is an id that never existed', async () => {
  h.setFlags([h.BIND_MINT]);
  const one = await ucpCreate([[IDS.SIG_A, 1]]);
  const two = await ucpCreate([[IDS.SIG_A, 2]]);
  const a = decodeEsc(one.value.id);
  const b = decodeEsc(two.value.id);
  const forged = {
    'another quantity': h.escId({ ...a, i: [[IDS.SIG_A, 5]] }),
    'another cart under this binding': h.escId({ ...a, c: b.c }),
    'the binding of another id': h.escId({ ...a, b: b.b }),
    'another market': h.escId({ ...a, m: 'GB' }),
    'tracking members added': h.escId({ v: 3, i: a.i, c: a.c, h: a.h, m: a.m, t: { utm_source: 'elsewhere' }, b: a.b }),
    'downgraded to v2 with the binding left on': h.escId({ ...a, v: 2 }),
    'no binding': h.escId({ v: 3, i: a.i, c: a.c, h: a.h, m: a.m }),
  };
  const unknown = await OPERATIONS['ucp get_checkout'](h.FORGED_ESC_ID, AS.A);
  for (const [name, id] of Object.entries(forged)) {
    const answer = await OPERATIONS['ucp get_checkout'](id, AS.A);
    assert.equal(shape(answer, id), shape(unknown, h.FORGED_ESC_ID), name);
    assert.equal(answer.store.length, 0, name);
  }
});

test('mint: an unbound id minted before the switch is still read; enforce: it is an id that never existed', async () => {
  const before = await ucpCreate([[IDS.SIG_A, 1]]);
  assert.equal(decodeEsc(before.value.id).v, 2);
  h.setFlags([h.BIND_MINT]);
  const stillRead = await OPERATIONS['ucp get_checkout'](before.value.id, AS.A_OTHER_BUYER);
  assert.equal(stillRead.isError, false, stillRead.raw);
  h.setFlags([h.BIND_ENFORCE]);
  const unknown = await OPERATIONS['ucp get_checkout'](h.FORGED_ESC_ID, AS.A);
  for (const id of [before.value.id, h.LEGACY_ESC_ID]) {
    for (const as of [AS.A, AS.A_OTHER_BUYER]) {
      const refused = await OPERATIONS['ucp get_checkout'](id, as);
      assert.equal(shape(refused, id), shape(unknown, h.FORGED_ESC_ID));
      assert.equal(refused.store.length, 0);
    }
  }
  // Under enforce, new ids are bound and their buyer reads them.
  const bound = await ucpCreate([[IDS.SIG_A, 1]]);
  assert.equal(decodeEsc(bound.value.id).v, 3);
  assert.equal((await OPERATIONS['ucp get_checkout'](bound.value.id, AS.A)).isError, false);
  assert.equal(shape(await OPERATIONS['ucp get_checkout'](bound.value.id, AS.B), bound.value.id), shape(unknown, h.FORGED_ESC_ID));
});

test('switched back off: bound ids are still read by their buyer and by nobody else; new ids are unbound again', async () => {
  h.setFlags([h.BIND_MINT]);
  const bound = await ucpCreate([[IDS.SIG_A, 1]]);
  h.setFlags([]);
  assert.equal((await OPERATIONS['ucp get_checkout'](bound.value.id, AS.A)).isError, false);
  const unknown = await OPERATIONS['ucp get_checkout'](h.FORGED_ESC_ID, AS.A);
  assert.equal(shape(await OPERATIONS['ucp get_checkout'](bound.value.id, AS.A_OTHER_BUYER), bound.value.id), shape(unknown, h.FORGED_ESC_ID));
  assert.equal(decodeEsc((await ucpCreate([[IDS.SIG_A, 1]])).value.id).v, 2);
});

test('no usable secret with the switch on: no storefront checkout is handed out, and none can be read', async () => {
  h.setFlags([h.BIND_MINT]);
  const bound = await ucpCreate([[IDS.SIG_A, 1]]);
  for (const secret of [undefined, 'short']) {
    if (secret === undefined) delete process.env.CONFIRMATION_SECRET; else process.env.CONFIRMATION_SECRET = secret;
    const refused = await ucpCreate([[IDS.SIG_A, 1]]);
    assert.equal(refused.isError, true, refused.raw);
    assert.equal(errorOf(refused).detail.reason, 'ucp_storefront_checkout_unavailable');
    assert.equal(errorOf(refused).retriable, false);
    assert.equal(refused.store.filter((c) => c.kind === 'tool').length, 0, 'no cart is built for an id that could not be bound');
    assert.equal((await OPERATIONS['ucp get_checkout'](bound.value.id, AS.A)).isError, true, 'a binding that cannot be checked is not trusted');
  }
  // Another secret: yesterday's ids do not verify.
  process.env.CONFIRMATION_SECRET = 'another-confirmation-secret-0123456789';
  assert.equal((await OPERATIONS['ucp get_checkout'](bound.value.id, AS.A)).isError, true);
  process.env.CONFIRMATION_SECRET = ORIGINAL_SECRET;
  assert.equal((await OPERATIONS['ucp get_checkout'](bound.value.id, AS.A)).isError, false);
});

test('with the referral, the hand-off record and the retry switch on: one bound id carries all of it and replays as itself', async () => {
  h.setFlags([h.BIND_MINT, h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.HANDOFF_RECORD_FLAG, h.IDEMPOTENCY_FLAG]);
  const n = nextKey();
  const args = h.ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', n);
  const first = await door.call('/ucp/mcp', 'create_checkout', args, { buyer: AS.A });
  assert.equal(first.isError, false, first.raw);
  assert.deepEqual(Object.keys(decodeEsc(first.value.id)), ['v', 'i', 'c', 'h', 'm', 'r', 't', 'b']);
  assert.equal(first.handoff[0].body.binding, require('node:crypto').createHash('sha256').update(first.value.id, 'utf8').digest('hex'));
  const retry = await door.call('/ucp/mcp', 'create_checkout', args, { buyer: AS.A });
  // (With the hand-off record's label on, `price_as_of` is when the seller's cart was read: the replay's own time.)
  const noClock = (raw) => String(raw).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>');
  assert.equal(noClock(retry.raw), noClock(first.raw));
  assert.equal(retry.value.expires_at, first.value.expires_at);
  assert.equal(retry.value.id, first.value.id);
  assert.deepEqual([retry.referral.length, retry.handoff.length], [0, 0]);
  assert.deepEqual(retry.store.filter((c) => c.kind === 'tool').map((c) => c.tool), ['get_cart']);
  // The same key from another buyer is that buyer's own cart, under that buyer's own binding.
  const other = await door.call('/ucp/mcp', 'create_checkout', args, { buyer: AS.A_OTHER_BUYER });
  assert.notEqual(other.value.id, first.value.id);
  assert.notEqual(decodeEsc(other.value.id).b, decodeEsc(first.value.id).b);
  assert.equal((await OPERATIONS['ucp get_checkout'](other.value.id, AS.A)).isError, true);
  // A GB cart and a US cart of one buyer are two ids, each bound, each read back as itself.
  const gb = await ucpCreate([[IDS.SIG_A, 1]], { market: 'GB' });
  assert.equal(decodeEsc(gb.value.id).m, 'GB');
  assert.notEqual(decodeEsc(gb.value.id).b, decodeEsc(first.value.id).b);
  const gbRead = await OPERATIONS['ucp get_checkout'](gb.value.id, AS.A);
  assert.equal(gbRead.isError, false, gbRead.raw);
  assert.equal(gbRead.store.find((c) => c.kind === 'tool').arguments.id, decodeEsc(gb.value.id).c);
});
