'use strict';

// THE CURRENCY RULE AND THE STORE-CART HARDENING, TOGETHER (AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET with the
// referral, the retry ledger, the id binding and the hand-off record on). Through the real doors, over the
// store-cart-by-market fixture (sellers priced in USD, GBP, SGD and EUR; tests/_support/storeCartMarketDoor.cjs) with
// this branch's partners, referral route and hand-off route added (tests/_support/storeCartHardeningDoor.cjs).
//
// A RETRIED CREATE IS JUDGED AGAIN, NEVER SERVED FROM ITS RECORD. The retry ledger answers a retried create by
// reading the recorded checkout back. A checkout recorded BEFORE the currency rule was turned on may be one the rule
// refuses (a GB cart of a seller priced in USD). The read-back goes through the same judgement as any re-read, so
// such a retry is refused by name, with no seller asked. Pinned here:
//   (i)   /ucp/mcp: GB x a USD seller created with the rule off (a store cart, a record), the rule turned on, the
//         same create retried with the same key: the named refusal, no store call, the record is not served;
//   (ii)  /mcp: its storefront path does not run at all with the rule off, so no /mcp record can predate the rule.
//         What can happen there: a record made with both switches on, then the rule turned off. The retry is then
//         answered exactly as with the path off (no store call, the record not served), and is replayed again once
//         the rule is back on. (The re-judgement itself is the same code for both doors; the door-scope of a record
//         made before the rule is pinned in mcp-server/test/storefrontCartIdempotency.test.js.)
//   (iii) US x a USD seller replays byte-identically before and after the rule is turned on;
//   (iv)  a refused create writes NO ledger record, asks for NO referral and writes NO hand-off record, and a later
//         retry is judged again.
// And the whole table: for US, SG, GB, DE, no market and "ZZ", on both doors, with every hardening flag on, no
// answer states a price in another currency than the market's (tests/_support/answerCurrencies.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const market = require('./_support/storeCartMarketDoor.cjs');
const h = require('./_support/storeCartHardeningDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { IDS, HOST } = market;
const ORIGINAL_ENV = { ...process.env };
// The backend base the market fixture answers on (its bootDoor sets PIVOTA_API_BASE to it).
const door = h.bootHardeningDoor({ base: market, backendBase: 'http://backend.store-cart-market.test', port: 4469 });
let ledger = null;
let pricing = null;

test.before(async () => {
  assert.equal(process.env.PIVOTA_API_BASE, 'http://backend.store-cart-market.test');
  await door.listen();
  ledger = await import(path.join(door.root, 'mcp-server/src/storefrontCartIdempotency.js'));
  pricing = await import(path.join(door.root, 'mcp-server/src/ucpMerchantDoorPricing.js'));
});
test.after(async () => {
  await door.close();
  process.env = { ...ORIGINAL_ENV };
});
test.beforeEach(() => {
  door.resetHardening();
  ledger.resetStoreCartIdempotencyCountsForTest();
  pricing.resetCartReferralOutcomeCountsForTest();
  h.setFlags([]);
});

// One buyer of partner A (the market fixture's buyer, calling with partner A's key).
const A = Object.freeze({ ...market.BUYER, 'X-Agent-API-Key': h.KEY_A });
const HARDENING = [h.IDEMPOTENCY_FLAG, h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.HANDOFF_RECORD_FLAG, h.ATTRIBUTION_FLAG];
const RULE = h.CURRENCY_FLAG;
let keySeq = 9000;
const nextKey = () => (keySeq += 1);
const tools = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);
const errorOf = (answer) => (answer.value && answer.value.error) || null;
const ucp = (items, sent, n) => door.call('/ucp/mcp', 'create_checkout', market.ucpCreate(items, sent, n), { buyer: A });
const native = (seller, items, sent, n) => door.call('/mcp', 'create_checkout_session', market.nativeCreate(seller, items, n, sent === undefined ? {} : { market: sent }), { buyer: A });
const whole = (answer) => JSON.parse(answer.raw);
const mask = (text) => String(text).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>');

test('the fixture: the market door\'s sellers, with a partner on the call and the referral route answering', async () => {
  h.setFlags([h.REFERRAL_FLAG, h.FORWARDING_FLAG]);
  const a = await ucp([[IDS.SIG_USD, 1]], 'US', nextKey());
  assert.equal(a.isError, false, a.raw);
  assert.deepEqual(tools(a), ['create_cart']);
  assert.deepEqual(a.referral.map((r) => [r.body.market, r.assertion && r.assertion.payload.sub]), [['US', h.PARTNER_A]]);
});

test('(i) /ucp/mcp: a GB cart of a USD seller recorded BEFORE the rule is not replayed after it: the retry is refused by name, no store call, the record is not served', async () => {
  h.setFlags(HARDENING);
  const n = nextKey();
  // Before the rule: the door builds the store cart and answers in the seller's currency (what the rule exists to stop).
  const before = await ucp([[IDS.SIG_USD, 1]], 'GB', n);
  assert.equal(before.isError, false, before.raw);
  assert.equal(before.value.currency, 'USD');
  assert.deepEqual(tools(before), ['create_cart']);
  assert.deepEqual([before.referral.length, before.handoff.length], [1, 1]);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 1 });
  // The record is there and is served while the rule is off.
  const replayedOff = await ucp([[IDS.SIG_USD, 1]], 'GB', n);
  assert.equal(replayedOff.value.id, before.value.id);
  assert.deepEqual(tools(replayedOff), ['get_cart']);

  // The rule is turned on. The same create, the same key.
  h.setFlags([...HARDENING, RULE]);
  const after = await ucp([[IDS.SIG_USD, 1]], 'GB', n);
  assert.equal(after.isError, true, after.raw);
  assert.equal(errorOf(after).code, 'NO_MERCHANT_OFFER');
  assert.equal(errorOf(after).detail.reason, 'seller_not_priced_in_market_currency');
  assert.equal(errorOf(after).detail.market_currency, 'GBP');
  assert.deepEqual(errorOf(after).detail.seller_currencies, ['USD']);
  assert.deepEqual(after.store, [], 'no seller is asked: not create_cart, and not get_cart on the recorded cart');
  assert.deepEqual([after.referral.length, after.handoff.length], [0, 0]);
  // Nothing of the recorded checkout is in the answer, and no price in any currency.
  assert.equal(after.raw.includes(before.value.id), false, 'the recorded id is not served');
  assert.equal(after.raw.includes('cart_store-a'), false, 'nor its cart');
  const found = assertAnswerCurrency(whole(after), 'GBP', 'the retry after the flip');
  assert.deepEqual([found.money, found.priceCurrencies], [[], []]);
  // Every later retry is judged again, the same way.
  const again = await ucp([[IDS.SIG_USD, 1]], 'GB', n);
  assert.equal(errorOf(again).detail.reason, 'seller_not_priced_in_market_currency');
  assert.deepEqual(again.store, []);
  // A plain re-read of the id handed out before the flip is judged the same way.
  const reread = await door.call('/ucp/mcp', 'get_checkout', market.ucpGet(before.value.id), { buyer: A });
  assert.equal(errorOf(reread).detail.reason, 'seller_not_priced_in_market_currency');
  assert.deepEqual(reread.store, []);
});

test('(i) a market with no currency (DE) recorded before the rule: after it, the retry is refused market_not_priced before the ledger, the gate or any seller', async () => {
  h.setFlags(HARDENING);
  const n = nextKey();
  const before = await ucp([[IDS.SIG_USD, 1]], 'DE', n);
  assert.equal(before.isError, false, before.raw);
  assert.deepEqual(tools(before), ['create_cart']);
  h.setFlags([...HARDENING, RULE]);
  ledger.resetStoreCartIdempotencyCountsForTest();
  const after = await ucp([[IDS.SIG_USD, 1]], 'DE', n);
  assert.equal(errorOf(after).detail.reason, 'market_not_priced');
  assert.deepEqual([after.store, after.gate, after.referral, after.handoff], [[], [], [], []]);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), {}, 'the ledger is not consulted for a market that has no currency');
  assert.equal(after.raw.includes(before.value.id), false);
});

test('(ii) /mcp: the path runs only under the rule, so its records cannot predate it; with the rule turned OFF the retry is answered as with the path off, and replayed again when the rule is back', async () => {
  h.setFlags([...HARDENING, h.NATIVE_DOOR_FLAG, RULE]);
  const n = nextKey();
  const first = await native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'US', n);
  assert.equal(first.isError, false, first.raw);
  assert.equal(first.value.status, 'completes_on_seller_storefront');
  assert.equal(first.value.currency, 'USD');
  assert.deepEqual(tools(first), ['create_cart']);
  const replay = await native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'US', n);
  assert.equal(replay.raw, first.raw);
  assert.deepEqual(tools(replay), ['get_cart']);
  // A GB create of the USD seller on /mcp is refused by the rule: no cart, no record.
  const gbKey = nextKey();
  const gb = await native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'GB', gbKey);
  assert.equal(errorOf(gb).detail.reason, 'seller_not_priced_in_market_currency');
  assert.deepEqual([gb.store, gb.referral, gb.handoff], [[], [], []]);

  // The rule off, the path's own switch still on: nothing of the path runs.
  h.setFlags([...HARDENING, h.NATIVE_DOOR_FLAG, h.CURRENCY_OFF]);
  ledger.resetStoreCartIdempotencyCountsForTest();
  const retryRuleOff = await native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'US', n);
  // What the door answers with the path's own switch off (the same request, a key nobody used).
  h.setFlags(HARDENING);
  const pathOff = await native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'US', nextKey());
  assert.equal(retryRuleOff.isError, true, retryRuleOff.raw);
  assert.equal(mask(retryRuleOff.raw), mask(pathOff.raw), 'answered exactly as with the path off');
  assert.deepEqual([retryRuleOff.store, retryRuleOff.referral, retryRuleOff.handoff], [[], [], []]);
  assert.equal(retryRuleOff.raw.includes(first.value.session_id), false, 'the record is not served');
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), {}, 'no ledger code ran');

  // Both on again: the record made under the rule is read back, and judged (US x USD: served).
  h.setFlags([...HARDENING, h.NATIVE_DOOR_FLAG, RULE]);
  const back = await native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'US', n);
  assert.equal(back.value.session_id, first.value.session_id);
  assert.deepEqual(tools(back), ['get_cart']);
});

test('(iii) US x a USD seller: the replay is byte-identical before and after the rule is turned on', async () => {
  // Without the hand-off record's label (it states the time of each read), the bytes are the same; with it, the
  // same but for that time.
  for (const [flags, same] of [[HARDENING.filter((f) => f !== h.HANDOFF_RECORD_FLAG), (x) => x], [HARDENING, mask]]) {
    ledger.resetStoreCartIdempotencyCountsForTest();
    h.setFlags(flags);
    const n = nextKey();
    const first = await ucp([[IDS.SIG_USD, 2]], 'US', n);
    assert.equal(first.isError, false, first.raw);
    assert.equal(first.value.currency, 'USD');
    const replayOff = await ucp([[IDS.SIG_USD, 2]], 'US', n);
    h.setFlags([...flags, RULE]);
    const replayOn = await ucp([[IDS.SIG_USD, 2]], 'US', n);
    assert.equal(same(replayOff.raw), same(first.raw));
    assert.equal(same(replayOn.raw), same(first.raw), 'the same bytes under the rule');
    assert.equal(replayOn.raw.replace(/\d{4}-\d\d-\d\dT[0-9:.]+Z/g, '').length, first.raw.replace(/\d{4}-\d\d-\d\dT[0-9:.]+Z/g, '').length);
    assert.deepEqual([tools(first), tools(replayOff), tools(replayOn)], [['create_cart'], ['get_cart'], ['get_cart']]);
    assert.deepEqual([replayOn.referral.length, replayOn.handoff.length], [0, 0]);
    assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 1, replayed: 2 });
    // No market named (answered as US, labelled): the same.
    const k = nextKey();
    h.setFlags(flags);
    const assumed = await ucp([[IDS.SIG_USD, 1]], undefined, k);
    h.setFlags([...flags, RULE]);
    const assumedOn = await ucp([[IDS.SIG_USD, 1]], undefined, k);
    assert.ok(assumed.value.market_assumed);
    assert.equal(same(assumedOn.raw), same(assumed.raw));
  }
});

test('(iv) a create the rule refuses writes NO ledger record, asks for NO referral and writes NO hand-off record; a later retry is judged again', async () => {
  h.setFlags([...HARDENING, RULE, h.BIND_ENFORCE]);
  const n = nextKey();
  const refused = await ucp([[IDS.SIG_USD, 1]], 'GB', n);
  assert.equal(errorOf(refused).detail.reason, 'seller_not_priced_in_market_currency');
  assert.deepEqual([refused.store, refused.referral, refused.handoff], [[], [], []]);
  assert.equal(door.referralCalls.length, 0);
  assert.deepEqual(pricing.cartReferralOutcomeCounts(), {}, 'the referral was not even due');
  // The claim was released: nothing was recorded.
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 1, released: 1 });
  // The same create again: judged again (a new claim), not a replay and not a conflict.
  const again = await ucp([[IDS.SIG_USD, 1]], 'GB', n);
  assert.equal(errorOf(again).detail.reason, 'seller_not_priced_in_market_currency');
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 2, released: 2 });
  // The rule off again: the same key now builds (so no record of the refusal stood in its way).
  h.setFlags([...HARDENING, h.BIND_ENFORCE]);
  const built = await ucp([[IDS.SIG_USD, 1]], 'GB', n);
  assert.equal(built.isError, false, built.raw);
  assert.deepEqual(tools(built), ['create_cart']);
  assert.equal(ledger.storeCartIdempotencyCounts().replayed, undefined);
  // A market the rule prices for a seller in that currency is built, tracked and recorded as ever.
  h.setFlags([...HARDENING, RULE, h.BIND_ENFORCE]);
  const gbp = await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey());
  assert.equal(gbp.isError, false, gbp.raw);
  assert.equal(gbp.value.currency, 'GBP');
  assert.deepEqual(gbp.referral.map((r) => r.body.market), ['GB']);
  assert.equal(gbp.handoff.length, 1);
  assert.equal(gbp.handoff[0].body.currency, 'GBP');
});

test('(iv) a seller in the market\'s currency whose STOREFRONT answers in another: refused by name, no record of any kind; the referral was asked for before the store answered (the one referral a refused checkout can leave)', async () => {
  // The door asks for a referral only when it is about to send a cart, and the cart carries the referral's members,
  // so the referral precedes the store's answer. A store that then answers in another currency is refused, and its
  // click row is one more of the rows no link carries (never clicked, named by no hand-off record).
  h.setFlags([...HARDENING, RULE]);
  const n = nextKey();
  const refused = await ucp([[IDS.SIG_GBP_USD_STORE, 1]], 'GB', n);
  assert.equal(refused.isError, true, refused.raw);
  assert.equal(errorOf(refused).detail.reason, 'seller_not_priced_in_market_currency');
  assert.deepEqual(errorOf(refused).detail.seller_currencies, ['USD']);
  assert.deepEqual(tools(refused), ['create_cart']);
  assert.equal(refused.referral.length, 1);
  assert.equal(refused.referral[0].storeToolCallsBefore, 0, 'asked before the store');
  assert.equal(refused.handoff.length, 0, 'no hand-off record for a refused checkout');
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 1, released: 1 }, 'no ledger record');
  const found = assertAnswerCurrency(whole(refused), 'GBP', 'store answered in USD');
  assert.deepEqual([found.money, found.priceCurrencies], [[], []], 'the store\'s USD answer is not shown');
  assert.equal(refused.raw.includes('pvt_click_id'), false, 'and no tracked link is handed out');
});

test('/mcp with its storefront switch on and the currency rule OFF (the path does not run): no hardening code runs for a checkout call, whatever hardening flags are on', async () => {
  // The same checkout calls in that state, with every hardening flag off and then on: the same answers, the same
  // traffic, and nothing counted by the ledger or the referral.
  const escOf = (body) => market.escId(body);
  const bare = { ...market.nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 1, { market: 'US' }) };
  const noEmail = JSON.parse(JSON.stringify(bare)); delete noEmail.quote.customer_email;
  const noKey = JSON.parse(JSON.stringify(bare)); delete noKey.idempotency_key;
  const unbound = escOf({ v: 2, i: [[IDS.SIG_USD, 1]], c: 'cart_store-a_0001', h: HOST.A, m: 'US' });
  const bound = escOf({ v: 3, i: [[IDS.SIG_USD, 1]], c: 'cart_store-a_0001', h: HOST.A, m: 'US', b: 'A'.repeat(43) });
  const calls = [
    ['create', 'create_checkout_session', bare],
    ['create again, the same key', 'create_checkout_session', bare],
    ['create, a 3-character key', 'create_checkout_session', { ...bare, idempotency_key: 'abc' }],
    ['create, no buyer email', 'create_checkout_session', noEmail],
    ['create, no key', 'create_checkout_session', noKey],
    ['create, GB', 'create_checkout_session', { ...bare, market: 'GB' }],
    ['get, an unbound id', 'get_checkout_session', { session_id: unbound }],
    ['get, a bound id', 'get_checkout_session', { session_id: bound }],
    ['update', 'update_checkout_session', { ...bare, session_id: unbound }],
    ['complete', 'complete_checkout_session', { idempotency_key: 'idem-complete-0001', session_id: unbound, payment_authorization: { type: 'none' } }],
    ['cancel', 'cancel_checkout_session', { idempotency_key: 'idem-cancel-0001', session_id: unbound }],
    ['payment link', 'create_payment_link', { idempotency_key: 'idem-link-0001', session_id: unbound, customer_email: 'buyer@example.test' }],
  ];
  const run = async (flags) => {
    door.resetHardening();
    h.setFlags(flags);
    const out = [];
    for (const [name, tool, args] of calls) {
      const a = await door.call('/mcp', tool, args, { buyer: A });
      out.push({ name, raw: mask(a.raw).replace(/q_[0-9a-f-]{36}/g, 'q_<random>'), http: a.http, store: a.store, gate: a.gate, upstream: a.upstream, referral: a.referral.length, handoff: a.handoff.length, notRun: a.log.filter((l) => l.event === 'mcp_storefront_cart_path').length });
    }
    return out;
  };
  const NOT_RUNNING = [h.NATIVE_DOOR_FLAG, h.CURRENCY_OFF];
  const plain = await run(NOT_RUNNING);
  for (const bind of [h.BIND_MINT, h.BIND_ENFORCE]) {
    ledger.resetStoreCartIdempotencyCountsForTest();
    pricing.resetCartReferralOutcomeCountsForTest();
    const hardened = await run([...NOT_RUNNING, ...HARDENING, bind]);
    for (const [i, [name]] of calls.entries()) assert.deepEqual(hardened[i], plain[i], `${bind}: ${name}`);
    assert.deepEqual(ledger.storeCartIdempotencyCounts(), {}, 'the ledger did not run');
    assert.deepEqual(pricing.cartReferralOutcomeCounts(), {}, 'no referral was due');
    assert.equal(door.referralCalls.length, 0);
  }
  // The state is the one meant: every checkout call logged that the path did not run, and no store was asked.
  assert.ok(plain.every((c) => c.notRun === 1 && c.store.length === 0 && c.referral === 0));
  // And it is the path-off answer: the same calls with the path's own switch off.
  const off = await run([]);
  for (const [i, [name]] of calls.entries()) assert.deepEqual({ ...plain[i], notRun: 0 }, off[i], `path off: ${name}`);
});

// ---- the whole table, with every hardening flag on ------------------------------------------------------------------

const MARKETS = Object.freeze([
  { label: 'US', sent: 'US', market: 'US' },
  { label: 'SG', sent: 'SG', market: 'SG' },
  { label: 'GB', sent: 'GB', market: 'GB' },
  { label: 'DE', sent: 'DE', market: 'DE' },
  { label: 'none', sent: undefined, market: 'US', assumed: true },
  { label: 'ZZ', sent: 'ZZ', market: 'ZZ' },
]);
const ROWS = Object.freeze([
  { name: 'USD', currency: 'USD', id: IDS.SIG_USD, seller: IDS.SELLER_A },
  { name: 'SGD', currency: 'SGD', id: IDS.SIG_SGD, seller: IDS.SELLER_S },
  { name: 'GBP', currency: 'GBP', id: IDS.SIG_GBP, seller: IDS.SELLER_G },
  { name: 'EUR', currency: 'EUR', id: IDS.SIG_EUR, seller: IDS.SELLER_E },
]);
const DOORS = Object.freeze([
  { path: '/ucp/mcp', create: 'create_checkout', get: 'get_checkout' },
  { path: '/mcp', create: 'create_checkout_session', get: 'get_checkout_session', native: true },
]);

test('the source has a currency for US, SG and GB, and none for DE or ZZ', () => {
  assert.deepEqual(MARKETS.map((m) => resolveServingCurrency(m.market) || null), ['USD', 'SGD', 'GBP', null, 'USD', null]);
});

for (const bind of ['mint', 'enforce']) {
  for (const m of MARKETS) {
    for (const at of DOORS) {
      test(`market ${m.label} on ${at.path}, every hardening flag on (binding ${bind}), the rule on: create, retry and re-read state no price outside the market's currency`, async () => {
        h.setFlags([...HARDENING, h.NATIVE_DOOR_FLAG, RULE, `${h.ID_BINDING_FLAG}=${bind}`]);
        const marketCurrency = resolveServingCurrency(m.market) || null;
        for (const row of ROWS) {
          const n = nextKey();
          const label = `${at.path} ${m.label} x ${row.name}`;
          const create = () => (at.native
            ? native(row.seller, [[row.id, 1]], m.sent, n)
            : ucp([[row.id, 1]], m.sent, n));
          const created = await create();
          const retried = await create();
          const answers = [['create', created], ['retry', retried]];
          const id = created.isError ? null : (at.native ? created.value.session_id : created.value.id);
          if (id) answers.push(['re-read', await door.call(at.path, at.get, at.native ? { session_id: id } : market.ucpGet(id), { buyer: A })]);
          const priced = Boolean(marketCurrency) && row.currency === marketCurrency && !(at.native && m.assumed);
          for (const [op, answer] of answers) {
            const found = assertAnswerCurrency(whole(answer), marketCurrency, `${label} ${op}`);
            assert.deepEqual(found.textMoney, [], `${label} ${op}: no money in text`);
            const served = [...new Set([...found.priceCurrencies.map((c) => c.value), ...found.money.map((x) => x.currency)])];
            if (priced) {
              assert.equal(answer.isError, false, `${label} ${op}: ${answer.raw}`);
              assert.deepEqual(served, [marketCurrency], `${label} ${op}`);
            } else {
              assert.equal(answer.isError, true, `${label} ${op}: ${answer.raw}`);
              assert.deepEqual(served, [], `${label} ${op}: no price at all`);
              assert.deepEqual([answer.store, answer.referral, answer.handoff], [[], [], []], `${label} ${op}: nobody is asked, nothing is recorded`);
            }
          }
          if (priced) {
            // A retry is the first checkout again, and mints nothing.
            assert.equal(at.native ? retried.value.session_id : retried.value.id, id, label);
            assert.deepEqual(tools(retried), ['get_cart'], label);
            assert.deepEqual([retried.referral.length, retried.handoff.length], [0, 0], label);
            // The referral was asked for with the market the buyer named, and for no assumed market.
            assert.deepEqual(created.referral.map((r) => r.body.market), m.assumed ? [] : [m.market], label);
          }
        }
      });
    }
  }
}
