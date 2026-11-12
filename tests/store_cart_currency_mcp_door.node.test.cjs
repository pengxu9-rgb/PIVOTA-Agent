'use strict';

// THE `/mcp` DOOR'S STOREFRONT CART IS UNDER THE CURRENCY RULE, OR IT DOES NOT RUN.
//
// Two switches, both default off, both read per call by one reader:
//   AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED   the `/mcp` door's route to a seller's own storefront cart
//   AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET         a storefront checkout's currency is the buyer market's
// The first REQUIRES the second. Through the real doors (tests/_support/storeCartMarketDoor.cjs says what is real):
//
//   /mcp path | rule | `/mcp` storefront checkout                         | `/ucp/mcp` storefront checkout
//   ----------+------+----------------------------------------------------+------------------------------------------
//   off       | off  | not offered (refused, as always)                   | answered in the catalog row's currency
//   ON        | off  | EXACTLY as "off, off", byte for byte, + a log line | unchanged: the catalog row's currency
//   off       | ON   | EXACTLY as "off, off"                              | under the rule
//   ON        | ON   | under the rule                                     | under the rule
//
// "Under the rule": the currency is the request market's (on `/mcp` the market is a required argument of this path;
// a missing or malformed one keeps this door's own refusal), a seller priced in another currency is refused by name
// with no store call, a market with no currency is refused by name, and an id is re-read under the market it carries.
// This door keeps no copy of a created cart: every create, re-read and update is computed when it is asked, so a
// cart created before the rule was on is re-judged on its next read, never replayed.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/storeCartMarketDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');

const { IDS, HOST, ucpCreate, ucpGet, nativeCreate, escId, decodeEscId, idem } = support;
const door = support.bootDoor({ port: 4478 });
const OFF = { mcp: false, currency: false };
const MCP_ONLY = { mcp: true, currency: false };
const RULE_ONLY = { mcp: false, currency: true };
const BOTH = { mcp: true, currency: true };
const mcp = (flags, name, args, o) => door.withFlags(flags, () => door.call('/mcp', name, args, o));
const ucp = (flags, name, args, o) => door.withFlags(flags, () => door.call('/ucp/mcp', name, args, o));
const tools = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);
const errorOf = (answer) => (answer.value && answer.value.error) || {};
const reasonOf = (answer) => (errorOf(answer).detail || {}).reason;
const readPayloads = (answer) => answer.upstream.filter((u) => u.op === 'get_pdp_v2').map((u) => u.payload);
const theRead = (signature) => JSON.stringify({ product_ref: { product_id: signature }, include: ['product_overview'] });
const NOT_RUN = (tool) => ({ event: 'mcp_storefront_cart_path', outcome: 'not_run', reason: 'currency_follows_market_off', tool });
// What a call did, for "exactly as": the response bytes and everything sent anywhere.
// (A kernel session's id is a fresh random id on every call; it is the one thing normalised.)
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const facts = (answer) => ({ http: answer.http, raw: answer.raw.replace(UUID, '<uuid>'), store: answer.store, upstream: answer.upstream, gate: answer.gate });
let n = 500;
const create = (seller, signature, market, extra = {}) => nativeCreate(seller, [[signature, 1]], (n += 1), { ...(market === undefined ? {} : { market }), ...extra });

test.before(() => door.listen());
test.after(() => door.close());
test.beforeEach(() => { door.setGateEnforced(true); door.reset(); });

// ---- the path's switch on, the rule off: nothing of the path runs ---------------------------------------------------

test('path ON, rule OFF: every `/mcp` checkout call is byte for byte the call with the path off, with the same traffic, and one log line says why', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-15T10:00:00.000Z') });
  // An id the UCP door mints with the rule off (GB, over a USD store cart): what a re-read on `/mcp` must not serve.
  const minted = await ucp(OFF, 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB'));
  assert.deepEqual([minted.value.currency, decodeEscId(minted.value.id).m], ['USD', 'GB']);
  const requests = [
    ['create_checkout_session', () => create(IDS.SELLER_A, IDS.SIG_USD, 'GB')],
    ['create_checkout_session', () => create(IDS.SELLER_A, IDS.SIG_USD, 'US')],
    ['create_checkout_session', () => create(IDS.SELLER_A, IDS.SIG_USD, 'DE')],
    ['create_checkout_session', () => create(IDS.SELLER_A, IDS.SIG_USD, 'ZZ')],
    ['create_checkout_session', () => create(IDS.SELLER_A, IDS.SIG_USD, 'USA')],
    ['create_checkout_session', () => create(IDS.SELLER_A, IDS.SIG_USD, undefined)],
    ['create_checkout_session', () => create(IDS.SELLER_G, IDS.SIG_GBP, 'GB')],
    // A connected merchant's cart: the kernel prices it, in every state.
    ['create_checkout_session', () => nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], 590), 'kernel'],
    ['get_checkout_session', () => ({ session_id: minted.value.id })],
    ['get_checkout_session', () => ({ session_id: escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'GB' }) })],
    ['get_checkout_session', () => ({ session_id: 'q_00000000-0000-0000-0000-000000000000' })],
    ['update_checkout_session', () => ({ idempotency_key: idem(591), session_id: minted.value.id, quote: { merchant_id: IDS.SELLER_A, items: [{ product_id: IDS.SIG_USD, quantity: 2 }], customer_email: 'buyer@example.test' } })],
    ['complete_checkout_session', () => ({ idempotency_key: idem(592), session_id: minted.value.id, payment_authorization: { type: 'none' } })],
    ['cancel_checkout_session', () => ({ idempotency_key: idem(593), session_id: minted.value.id })],
  ];
  for (const [i, [name, build, kernel]] of requests.entries()) {
    const args = build();
    door.reset();
    const off = await mcp(OFF, name, args);
    door.reset();
    const mcpOnly = await mcp(MCP_ONLY, name, args);
    assert.deepEqual(facts(mcpOnly), facts(off), `request ${i} (${name}): identical bytes and traffic`);
    assert.deepEqual(tools(mcpOnly), [], `request ${i}: no store cart call`);
    assert.deepEqual(off.log.filter((l) => l.event === 'mcp_storefront_cart_path'), []);
    assert.deepEqual(mcpOnly.log.filter((l) => l.event === 'mcp_storefront_cart_path'), [NOT_RUN(name)], `request ${i}: the one line`);
    // And no storefront answer of it states a price in any currency: the defect is not reachable on this door.
    if (!kernel) assert.deepEqual(assertAnswerCurrency(JSON.parse(mcpOnly.raw), null, `request ${i}`).money, []);
  }
});

test('path ON, rule OFF: tools/list on `/mcp`, and a tool that is not a checkout tool, are the path-off bytes with no log line', async () => {
  const list = { jsonrpc: '2.0', id: 7, method: 'tools/list' };
  const off = await door.withFlags(OFF, () => door.post('/mcp', list));
  const mcpOnly = await door.withFlags(MCP_ONLY, () => door.post('/mcp', list));
  const both = await door.withFlags(BOTH, () => door.post('/mcp', list));
  assert.equal(mcpOnly.raw, off.raw);
  assert.notEqual(both.raw, off.raw, 'with both on the checkout tools say what the path answers');
  assert.deepEqual(mcpOnly.log, []);
  const search = await mcp(MCP_ONLY, 'search_catalog', { query: 'serum', market: 'US' });
  assert.deepEqual(search.log, []);
  // The other doors' tool lists never follow either switch.
  for (const p of ['/ucp/mcp', '/public/mcp']) {
    const a = await door.withFlags(OFF, () => door.post(p, list, { buyer: null }));
    const b = await door.withFlags(BOTH, () => door.post(p, list, { buyer: null }));
    assert.equal(b.raw, a.raw, p);
  }
});

test('rule ON, path OFF: `/mcp` is exactly as with both off', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-15T10:00:00.000Z') });
  for (const build of [() => create(IDS.SELLER_A, IDS.SIG_USD, 'GB'), () => create(IDS.SELLER_A, IDS.SIG_USD, undefined)]) {
    const args = build();
    const off = await mcp(OFF, 'create_checkout_session', args);
    const ruleOnly = await mcp(RULE_ONLY, 'create_checkout_session', args);
    assert.deepEqual(facts(ruleOnly), facts(off));
    assert.deepEqual(ruleOnly.log, []);
  }
});

// ---- the four states, one cell: a GB buyer and a seller priced in USD ----------------------------------------------

test('THE FLAG-STATE TABLE, for a GB create of a USD seller, on both doors', async () => {
  const cell = async (flags) => {
    door.reset();
    const onMcp = await mcp(flags, 'create_checkout_session', create(IDS.SELLER_A, IDS.SIG_USD, 'GB'));
    door.reset();
    const onUcp = await ucp(flags, 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB', (n += 1)));
    const say = (a) => (a.isError ? (reasonOf(a) || errorOf(a).code) : `priced ${a.value.currency}`);
    return { mcp: say(onMcp), mcp_store: tools(onMcp), ucp: say(onUcp), ucp_store: tools(onUcp) };
  };
  assert.deepEqual(await cell(OFF), { mcp: 'INVALID_ARGUMENTS', mcp_store: [], ucp: 'priced USD', ucp_store: ['create_cart'] }, 'both off: `/mcp` has no such path; `/ucp/mcp` shows the defect');
  assert.deepEqual(await cell(MCP_ONLY), { mcp: 'INVALID_ARGUMENTS', mcp_store: [], ucp: 'priced USD', ucp_store: ['create_cart'] }, 'path on, rule off: `/mcp` as off; `/ucp/mcp` unchanged');
  assert.deepEqual(await cell(RULE_ONLY), { mcp: 'INVALID_ARGUMENTS', mcp_store: [], ucp: 'seller_not_priced_in_market_currency', ucp_store: [] }, 'rule on, path off');
  assert.deepEqual(await cell(BOTH), { mcp: 'seller_not_priced_in_market_currency', mcp_store: [], ucp: 'seller_not_priced_in_market_currency', ucp_store: [] }, 'both on');
});

// ---- both on: the rule on `/mcp` -------------------------------------------------------------------------------------

test('both ON, GB x a USD seller: refused by name in the native door\'s words, no store call, one product read with no market', async () => {
  const created = await mcp(BOTH, 'create_checkout_session', create(IDS.SELLER_A, IDS.SIG_USD, 'GB'));
  assert.equal(created.isError, true);
  const error = errorOf(created);
  assert.equal(error.code, 'NO_MERCHANT_OFFER');
  assert.deepEqual(error.detail, {
    reason: 'seller_not_priced_in_market_currency', market: 'GB', market_currency: 'GBP', seller_currencies: ['USD'],
    storefront_items: [IDS.SIG_USD], seller_hosts: [HOST.A],
    storefront_urls: { [IDS.SIG_USD]: `https://${HOST.A}/products/calm-serum?variant=${IDS.VARIANT_USD}` },
  });
  assert.deepEqual(created.store, []);
  assert.deepEqual(created.gate, [{ domain: HOST.A, market: 'GB' }]);
  assert.deepEqual(readPayloads(created), [theRead(IDS.SIG_USD)]);
  const found = assertAnswerCurrency(JSON.parse(created.raw), 'GBP');
  assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []]);
  assert.deepEqual(created.log, [{
    event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency',
    market: 'GB', expected_currency: 'GBP', row_currency: 'USD', seller_host: HOST.A,
  }]);
});

test('both ON, GB x a GBP seller: priced in GBP by the seller, in the native shape; the re-read is the same cart under the id\'s market', async () => {
  const created = await mcp(BOTH, 'create_checkout_session', create(IDS.SELLER_G, IDS.SIG_GBP, 'GB'));
  assert.equal(created.isError, false);
  const v = created.value;
  assert.deepEqual([v.status, v.currency, v.amount_unit, v.totals.map((x) => x.amount)], ['completes_on_seller_storefront', 'GBP', 'minor', [2100, 2100]]);
  assert.deepEqual(decodeEscId(v.session_id).m, 'GB');
  assert.equal('market_assumed' in v, false);
  assert.deepEqual(tools(created), ['create_cart']);
  assert.deepEqual(readPayloads(created), [theRead(IDS.SIG_GBP)]);
  assertAnswerCurrency(JSON.parse(created.raw), 'GBP');
  const got = await mcp(BOTH, 'get_checkout_session', { session_id: v.session_id });
  assert.deepEqual([got.value.currency, got.value.totals.map((x) => x.amount), tools(got)], ['GBP', [2100, 2100], ['get_cart']]);
  assert.deepEqual(readPayloads(got), [theRead(IDS.SIG_GBP)]);
  assertAnswerCurrency(JSON.parse(got.raw), 'GBP');
  // The UCP door reads the same id the same way.
  const onUcp = await ucp(BOTH, 'get_checkout', ucpGet(v.session_id));
  assert.deepEqual([onUcp.value.currency, onUcp.value.totals.map((x) => x.amount)], ['GBP', [2100, 2100]]);
});

test('both ON: a market with no currency is refused by name; a missing or malformed market keeps this door\'s own refusal', async () => {
  for (const market of ['DE', 'ZZ']) {
    const created = await mcp(BOTH, 'create_checkout_session', create(IDS.SELLER_A, IDS.SIG_USD, market));
    assert.equal(errorOf(created).code, 'NO_MERCHANT_OFFER', market);
    assert.deepEqual(errorOf(created).detail, { reason: 'market_not_priced', market, storefront_items: [IDS.SIG_USD], seller_hosts: [HOST.A] }, market);
    assert.deepEqual([created.store, created.gate], [[], []], market);
    assert.deepEqual(assertAnswerCurrency(JSON.parse(created.raw), null).money, []);
  }
  const unnamed = await mcp(BOTH, 'create_checkout_session', create(IDS.SELLER_A, IDS.SIG_USD, undefined));
  assert.equal(errorOf(unnamed).code, 'QUOTE_REQUIRED');
  assert.equal(reasonOf(unnamed), 'market_required_for_seller_storefront');
  const malformed = await mcp(BOTH, 'create_checkout_session', create(IDS.SELLER_A, IDS.SIG_USD, 'USA'));
  assert.equal(errorOf(malformed).code, 'INVALID_ARGUMENTS');
  assert.deepEqual([unnamed.store, malformed.store, malformed.upstream], [[], [], []]);
});

test('both ON, US x a USD seller: the answer the path gives with the rule is priced in USD by the seller, and a connected merchant\'s cart still goes to the kernel', async () => {
  const created = await mcp(BOTH, 'create_checkout_session', create(IDS.SELLER_A, IDS.SIG_USD, 'US'));
  assert.deepEqual([created.value.currency, created.value.totals.map((x) => x.amount), tools(created)], ['USD', [2750, 2750], ['create_cart']]);
  assertAnswerCurrency(JSON.parse(created.raw), 'USD');
  const off = await mcp(OFF, 'create_checkout_session', nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], 594));
  const both = await mcp(BOTH, 'create_checkout_session', nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], 594));
  assert.equal(off.isError, false);
  assert.deepEqual([both.store, both.gate, both.upstream.map((u) => u.op)], [[], [], off.upstream.map((u) => u.op)]);
});

// ---- the flip: a cart created before the rule is re-judged, never replayed -----------------------------------------

test('THE FLIP: a GB checkout created with the rule off (answered in USD over a USD store cart) is re-judged on its next read on `/mcp` once both are on', async () => {
  // With the rule off the `/mcp` path does not run, so such a create is reachable on the UCP door only.
  const before = await ucp(MCP_ONLY, 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB'));
  const id = before.value.id;
  assert.deepEqual([before.value.currency, decodeEscId(id).v, decodeEscId(id).m, tools(before)], ['USD', 2, 'GB', ['create_cart']]);
  // Still with the rule off: `/mcp` does not read it at all (the path is not on), and says so in the log.
  const stillOff = await mcp(MCP_ONLY, 'get_checkout_session', { session_id: id });
  assert.equal(stillOff.isError, true);
  assert.deepEqual([stillOff.store, stillOff.log], [[], [NOT_RUN('get_checkout_session')]]);
  assert.deepEqual(assertAnswerCurrency(JSON.parse(stillOff.raw), null).money, []);
  // THE FLIP. The same id, the same seller cart still there: refused by the rule, and the cart is not read.
  const after = await mcp(BOTH, 'get_checkout_session', { session_id: id });
  assert.equal(after.isError, true);
  assert.equal(errorOf(after).code, 'NO_MERCHANT_OFFER');
  assert.equal(reasonOf(after), 'seller_not_priced_in_market_currency');
  assert.deepEqual([errorOf(after).detail.market, errorOf(after).detail.market_currency, errorOf(after).detail.seller_currencies], ['GB', 'GBP', ['USD']]);
  assert.deepEqual(after.store, [], 'the seller is not asked for the cart');
  assert.deepEqual(readPayloads(after), [theRead(IDS.SIG_USD)]);
  assert.deepEqual(assertAnswerCurrency(JSON.parse(after.raw), 'GBP').money, []);
  // The UCP door re-judges it the same way.
  assert.equal(reasonOf(await ucp(BOTH, 'get_checkout', ucpGet(id))), 'seller_not_priced_in_market_currency');
  // Update, complete and cancel on that id state no price in any state (this door computes every answer; none is stored).
  for (const [name, args] of [
    ['update_checkout_session', { idempotency_key: idem(595), session_id: id, quote: { merchant_id: IDS.SELLER_A, items: [{ product_id: IDS.SIG_USD, quantity: 2 }], customer_email: 'buyer@example.test' } }],
    ['complete_checkout_session', { idempotency_key: idem(596), session_id: id, payment_authorization: { type: 'none' } }],
    ['cancel_checkout_session', { idempotency_key: idem(597), session_id: id }],
  ]) {
    const out = await mcp(BOTH, name, args);
    assert.equal(out.isError, true, name);
    assert.equal(errorOf(out).code, 'OPERATION_NOT_ALLOWED', name);
    assert.deepEqual([out.store, readPayloads(out)], [[], []], name);
    const found = assertAnswerCurrency(JSON.parse(out.raw), null, name);
    assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []], name);
  }
  // The same create retried with the same idempotency key after the flip is computed again, and refused: nothing is replayed.
  const key = (n += 1);
  const args = nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], key, { market: 'GB' });
  const first = await mcp(BOTH, 'create_checkout_session', args);
  const retry = await mcp(BOTH, 'create_checkout_session', args);
  assert.deepEqual([reasonOf(first), reasonOf(retry)], ['seller_not_priced_in_market_currency', 'seller_not_priced_in_market_currency']);
  assert.deepEqual(readPayloads(retry), [theRead(IDS.SIG_USD)], 'the retry read the product again');
});

test('both ON: ids from before the rule on `/mcp`: a market with no currency, and no market at all', async () => {
  const de = await mcp(BOTH, 'get_checkout_session', { session_id: escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'DE' }) });
  assert.deepEqual(errorOf(de).detail, { reason: 'market_not_priced', market: 'DE', storefront_items: [IDS.SIG_USD], seller_hosts: [HOST.A] });
  const legacy = await mcp(BOTH, 'get_checkout_session', { session_id: escId({ v: 1, i: [[IDS.SIG_USD, 1]] }) });
  assert.equal(errorOf(legacy).code, 'OPERATION_NOT_ALLOWED');
  assert.deepEqual([de.store, de.gate, legacy.store, legacy.gate], [[], [], [], []]);
  for (const a of [de, legacy]) assert.deepEqual(assertAnswerCurrency(JSON.parse(a.raw), null).money, []);
});
