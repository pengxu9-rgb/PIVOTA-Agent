'use strict';

// A STORE THAT ANSWERED A MARKET'S CART IN ANOTHER CURRENCY IS NOT ASKED AGAIN FOR A WHILE
// (AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_ENABLED, default OFF). Through the real doors, over the
// store-cart-by-market fixture with the hardening fixture's partners, referral route and hand-off route
// (tests/_support/storeCartMarketDoor.cjs, tests/_support/storeCartHardeningDoor.cjs).
//
// THE CASE. A seller whose rows are in the market's currency (GBP, for GB) and whose STOREFRONT answers the cart in
// another (USD). The create is refused by name, correctly; but the cart was built at the store and a referral was
// minted for it, and before this every retry did both again. Pinned here, on `/ucp/mcp` and `/mcp`:
//   - switch off: every attempt builds a cart and mints a referral (what main does);
//   - switch on: the first attempt does; every retry is refused with the same bytes and asks nobody anything;
//   - the entry is for (seller, market): other markets and other sellers are answered exactly as with the switch off;
//   - it expires (the memo's clock is set by the test: nothing here waits), and a store that then answers in the
//     market's currency is served;
//   - the whole market x seller-currency table with the memo on states no price outside the market's currency.
// The memo's own rules (bounds, TTL parsing, the key) are in mcp-server/test/storeCartCurrencyMismatchMemo.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const market = require('./_support/storeCartMarketDoor.cjs');
const h = require('./_support/storeCartHardeningDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { IDS, HOST } = market;
const ORIGINAL_ENV = { ...process.env };
const door = h.bootHardeningDoor({ base: market, backendBase: 'http://backend.store-cart-market.test', port: 4479 });
const TTL_ENV = 'AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_TTL_MS';
const MAX_ENV = 'AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_MAX_ENTRIES';
let ledger = null;
let pricing = null;
let memoModule = null;
let memo = null;
// The memo's clock, as this file sets it. Starts at an arbitrary fixed time.
const clock = { t: 1_800_000_000_000 };

test.before(async () => {
  await door.listen();
  ledger = await import(path.join(door.root, 'mcp-server/src/storefrontCartIdempotency.js'));
  pricing = await import(path.join(door.root, 'mcp-server/src/ucpMerchantDoorPricing.js'));
  memoModule = await import(path.join(door.root, 'mcp-server/src/storeCartCurrencyMismatchMemo.js'));
  memo = memoModule.storeCartCurrencyMismatchMemo;
});
test.after(async () => {
  memo.resetForTest();
  await door.close();
  process.env = { ...ORIGINAL_ENV };
});
test.beforeEach(() => {
  door.resetHardening();
  for (const host of Object.values(HOST)) door.setStoreCurrency(host, null);
  ledger.resetStoreCartIdempotencyCountsForTest();
  pricing.resetCartReferralOutcomeCountsForTest();
  memo.resetForTest();
  clock.t = 1_800_000_000_000;
  memo.useClockForTest(() => clock.t);
  delete process.env[TTL_ENV];
  delete process.env[MAX_ENV];
  h.setFlags([]);
});

const A = Object.freeze({ ...market.BUYER, 'X-Agent-API-Key': h.KEY_A });
const HARDENING = [h.IDEMPOTENCY_FLAG, h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.HANDOFF_RECORD_FLAG, h.ATTRIBUTION_FLAG];
const RULE = h.CURRENCY_FLAG;
const MEMO = h.MISMATCH_MEMO_FLAG;
const ALL_ON = [...HARDENING, h.NATIVE_DOOR_FLAG, RULE, MEMO];
const ALL_BUT_MEMO = [...HARDENING, h.NATIVE_DOOR_FLAG, RULE];
let keySeq = 7000;
const nextKey = () => (keySeq += 1);
const tools = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);
const errorOf = (answer) => (answer.value && answer.value.error) || null;
const ucp = (items, sent, n) => door.call('/ucp/mcp', 'create_checkout', market.ucpCreate(items, sent, n), { buyer: A });
const native = (seller, items, sent, n) => door.call('/mcp', 'create_checkout_session', market.nativeCreate(seller, items, n, sent === undefined ? {} : { market: sent }), { buyer: A });
const whole = (answer) => JSON.parse(answer.raw);
const DOORS = Object.freeze([
  { path: '/ucp/mcp', create: (seller, id, sent, n) => ucp([[id, 1]], sent, n), idOf: (a) => a.value.id },
  { path: '/mcp', create: (seller, id, sent, n) => native(seller, [[id, 1]], sent, n), idOf: (a) => a.value.session_id },
]);
const memoLines = (answer) => answer.log.filter((l) => l.outcome === 'store_not_asked');

test('the switch is this file\'s to set: the fixture clears it, and it is off unless named', () => {
  assert.ok(h.PER_CALL_FLAGS.includes(MEMO));
  assert.equal(MEMO, memoModule.STORE_CART_CURRENCY_MISMATCH_MEMO_FLAG);
  process.env[MEMO] = '1';
  h.setFlags([]);
  assert.equal(process.env[MEMO], undefined);
  assert.equal(memoModule.currencyMismatchMemoEnabled(), false);
});

for (const at of DOORS) {
  test(`${at.path}, switch OFF: each attempt at a seller whose storefront answers GB in USD builds a cart and mints a referral (as before)`, async () => {
    h.setFlags(ALL_BUT_MEMO);
    const n = nextKey();
    const first = await at.create(IDS.SELLER_H, IDS.SIG_GBP_USD_STORE, 'GB', n);
    const retry = await at.create(IDS.SELLER_H, IDS.SIG_GBP_USD_STORE, 'GB', n);
    assert.equal(errorOf(first).detail.reason, 'seller_not_priced_in_market_currency');
    assert.equal(retry.raw, first.raw);
    assert.deepEqual([tools(first), tools(retry)], [['create_cart'], ['create_cart']]);
    assert.deepEqual([first.referral.length, retry.referral.length], [1, 1]);
    assert.deepEqual([memo.size(), memo.counts()], [0, {}], 'nothing is remembered');
    assert.deepEqual([memoLines(first), memoLines(retry)], [[], []]);
    assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 2, released: 2 });
  });

  test(`${at.path}, switch ON: the first attempt is refused on the store's answer; every retry is the same bytes with NO store call, NO referral, NO hand-off record`, async () => {
    h.setFlags(ALL_ON);
    const n = nextKey();
    const first = await at.create(IDS.SELLER_H, IDS.SIG_GBP_USD_STORE, 'GB', n);
    assert.equal(first.isError, true, first.raw);
    assert.equal(errorOf(first).code, 'NO_MERCHANT_OFFER');
    assert.equal(errorOf(first).detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual([errorOf(first).detail.market, errorOf(first).detail.market_currency, errorOf(first).detail.seller_currencies], ['GB', 'GBP', ['USD']]);
    assert.deepEqual(tools(first), ['create_cart']);
    assert.deepEqual([first.referral.length, first.handoff.length], [1, 0]);
    assert.deepEqual(memo.counts(), { remembered: 1 });

    for (const [name, key] of [['the same key', n], ['the same key again', n], ['a new key', nextKey()]]) {
      clock.t += 1000;
      const retry = await at.create(IDS.SELLER_H, IDS.SIG_GBP_USD_STORE, 'GB', key);
      assert.deepEqual(errorOf(retry), errorOf(first), name);
      assert.equal(retry.raw, first.raw, `${name}: byte for byte`);
      assert.deepEqual(retry.store, [], `${name}: the store is not asked, not even for its profile`);
      assert.deepEqual([retry.referral, retry.handoff], [[], []], name);
      assert.deepEqual(memoLines(retry).map((l) => [l.reason, l.market, l.expected_currency, l.store_currency, l.seller_host]),
        [['store_currency_not_market_currency_remembered', 'GB', 'GBP', 'USD', HOST.H]], name);
      const found = assertAnswerCurrency(whole(retry), 'GBP', `${at.path} ${name}`);
      assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []], `${name}: no price at all`);
    }
    assert.equal(door.referralCalls.length, 1, 'one referral in all: the first attempt\'s');
    assert.deepEqual(memo.counts(), { remembered: 1, refused_without_store: 3 });
    // Each attempt claimed and released: a refusal from the entry records nothing, exactly as the first.
    assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 4, released: 4 });
    assert.equal(memo.size(), 1);
  });
}

test('one entry serves both doors: refused on /ucp/mcp, the /mcp retry is refused with /mcp\'s own switch-off bytes and no store call', async () => {
  // What /mcp answers from the store itself (switch off).
  h.setFlags(ALL_BUT_MEMO);
  const control = await native(IDS.SELLER_H, [[IDS.SIG_GBP_USD_STORE, 1]], 'GB', nextKey());
  assert.deepEqual(tools(control), ['create_cart']);
  h.setFlags(ALL_ON);
  await ucp([[IDS.SIG_GBP_USD_STORE, 1]], 'GB', nextKey());
  const onNative = await native(IDS.SELLER_H, [[IDS.SIG_GBP_USD_STORE, 1]], 'GB', nextKey());
  assert.equal(onNative.raw, control.raw);
  assert.deepEqual([onNative.store, onNative.referral], [[], []]);
});

test('THE ENTRY IS FOR (SELLER, MARKET): with a GB entry for one seller, every other market and every other seller is answered as with the switch off, traffic included', async () => {
  // A GBP seller whose storefront is made to answer in USD: GB is a mismatch.
  const requests = [
    ['US x USD seller', (n) => ucp([[IDS.SIG_USD, 1]], 'US', n)],
    ['SG x SGD seller', (n) => ucp([[IDS.SIG_SGD, 1]], 'SG', n)],
    ['GB x another GBP seller (unguarded page)', (n) => ucp([[IDS.SIG_GBP_UNGUARDED, 1]], 'GB', n)],
    ['US x the mismatching seller (its rows are GBP: the row rule)', (n) => ucp([[IDS.SIG_GBP, 1]], 'US', n)],
    ['SG x the mismatching seller', (n) => ucp([[IDS.SIG_GBP, 1]], 'SG', n)],
    ['no market x the mismatching seller', (n) => ucp([[IDS.SIG_GBP, 1]], undefined, n)],
    ['no market x USD seller', (n) => ucp([[IDS.SIG_USD, 1]], undefined, n)],
    ['DE x the mismatching seller', (n) => ucp([[IDS.SIG_GBP, 1]], 'DE', n)],
    ['DE x EUR seller', (n) => ucp([[IDS.SIG_EUR, 1]], 'DE', n)],
    ['ZZ x USD seller', (n) => ucp([[IDS.SIG_USD, 1]], 'ZZ', n)],
    ['a malformed market', (n) => ucp([[IDS.SIG_USD, 1]], 'USA', n)],
    ['/mcp US x USD seller', (n) => native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'US', n)],
    ['/mcp SG x SGD seller', (n) => native(IDS.SELLER_S, [[IDS.SIG_SGD, 1]], 'SG', n)],
    ['/mcp no market x USD seller', (n) => native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], undefined, n)],
    ['/mcp DE x USD seller', (n) => native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'DE', n)],
    ['/mcp ZZ x USD seller', (n) => native(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 'ZZ', n)],
  ];
  const shape = (a) => ({
    raw: a.raw.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>').replace(/clk_[0-9a-f]{24}/g, 'clk_<n>').replace(/cart_store-([a-z])_\d{4}/g, 'cart_store-$1_<n>').replace(/esc_[A-Za-z0-9_-]+/g, 'esc_<id>'),
    isError: a.isError, tools: tools(a), referral: a.referral.map((r) => r.body), handoff: a.handoff.length,
  });
  const run = async (flags, withEntry) => {
    door.resetHardening();
    memo.resetForTest();
    memo.useClockForTest(() => clock.t);
    door.setStoreCurrency(HOST.G, 'USD');
    h.setFlags(flags);
    if (withEntry) {
      const gb = await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey());
      assert.equal(errorOf(gb).detail.reason, 'seller_not_priced_in_market_currency');
      assert.deepEqual(tools(gb), ['create_cart']);
    }
    const out = [];
    for (const [name, send] of requests) out.push([name, shape(await send(nextKey()))]);
    return out;
  };
  const off = await run(ALL_BUT_MEMO, true);
  const on = await run(ALL_ON, true);
  assert.equal(memo.size(), 1, 'one entry: (the mismatching seller, GB)');
  assert.deepEqual(memo.counts(), { remembered: 1 }, 'none of these read it');
  for (const [i, [name]] of requests.entries()) assert.deepEqual(on[i][1], off[i][1], name);
  // The table says what it should: the priced markets are priced by their stores, the others are refused by name.
  const byName = Object.fromEntries(on);
  assert.deepEqual([byName['US x USD seller'].isError, byName['SG x SGD seller'].isError, byName['GB x another GBP seller (unguarded page)'].isError, byName['no market x USD seller'].isError], [false, false, false, false]);
  assert.deepEqual([byName['US x USD seller'].tools, byName['SG x SGD seller'].tools, byName['GB x another GBP seller (unguarded page)'].tools], [['create_cart'], ['create_cart'], ['create_cart']]);
  for (const name of ['DE x the mismatching seller', 'DE x EUR seller', 'ZZ x USD seller', '/mcp DE x USD seller', '/mcp ZZ x USD seller']) {
    assert.match(byName[name].raw, /market_not_priced/, name);
    assert.deepEqual(byName[name].tools, [], name);
  }
  assert.match(byName['a malformed market'].raw, /ucp_market_invalid/);
  assert.match(byName['/mcp no market x USD seller'].raw, /market_required_for_seller_storefront/);
  for (const name of ['US x the mismatching seller (its rows are GBP: the row rule)', 'SG x the mismatching seller', 'no market x the mismatching seller']) {
    assert.match(byName[name].raw, /is priced in GBP/, `${name}: refused on its rows, not on anything remembered`);
    assert.deepEqual(byName[name].tools, [], name);
  }
});

test('IT EXPIRES: the refusal stands for one TTL after the store answered, then the store is asked again; a store that now answers in GBP is served', async () => {
  h.setFlags(ALL_ON);
  process.env[TTL_ENV] = '120000';
  door.setStoreCurrency(HOST.G, 'USD');
  const first = await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey());
  assert.equal(errorOf(first).detail.reason, 'seller_not_priced_in_market_currency');
  assert.deepEqual(tools(first), ['create_cart']);
  // The store fixes its currency straight away.
  door.setStoreCurrency(HOST.G, null);
  clock.t += 119999;
  const held = await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey());
  assert.equal(held.raw, first.raw);
  assert.deepEqual(held.store, []);
  clock.t += 1;
  const served = await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey());
  assert.equal(served.isError, false, served.raw);
  assert.equal(served.value.currency, 'GBP');
  assert.deepEqual(tools(served), ['create_cart']);
  assert.deepEqual(served.referral.map((r) => r.body.market), ['GB']);
  assert.equal(served.handoff.length, 1);
  assert.deepEqual(memo.counts(), { remembered: 1, refused_without_store: 1, expired: 1 });
  assert.equal(memo.size(), 0);
  // An invalid TTL is the default (ten minutes), not "for ever" and not "never".
  process.env[TTL_ENV] = 'soon';
  door.setStoreCurrency(HOST.G, 'USD');
  await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey());
  clock.t += 599999;
  assert.deepEqual((await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey())).store, []);
  clock.t += 1;
  assert.deepEqual(tools(await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey())), ['create_cart']);
});

test('A RETRY UNDER A RECORDED KEY IS STILL JUDGED AGAIN: a GB checkout recorded while the store answered GBP is read back from the store, not answered from an entry', async () => {
  h.setFlags(ALL_ON);
  const n = nextKey();
  const created = await ucp([[IDS.SIG_GBP, 1]], 'GB', n);
  assert.equal(created.isError, false, created.raw);
  // The store starts answering in USD: a new create is refused and remembered.
  door.setStoreCurrency(HOST.G, 'USD');
  const fresh = await ucp([[IDS.SIG_GBP, 1]], 'GB', nextKey());
  assert.equal(errorOf(fresh).detail.reason, 'seller_not_priced_in_market_currency');
  assert.equal(memo.size(), 1);
  ledger.resetStoreCartIdempotencyCountsForTest();
  // The recorded key: read back through the re-read (get_cart on the recorded cart, which the store still answers
  // in the currency it was built in), judged by the currency rule there, and served as the same checkout.
  const replay = await ucp([[IDS.SIG_GBP, 1]], 'GB', n);
  assert.equal(replay.isError, false, replay.raw);
  assert.equal(replay.value.id, created.value.id);
  assert.deepEqual(tools(replay), ['get_cart']);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { replayed: 1 });
  assertAnswerCurrency(whole(replay), 'GBP', 'the replay');
  assert.deepEqual(memo.counts(), { remembered: 1 }, 'the replay read nothing from the memo');
});

// ---- the whole table, with every hardening flag and the memo on --------------------------------------------------------

const MARKETS = Object.freeze([
  { label: 'US', sent: 'US', market: 'US' },
  { label: 'SG', sent: 'SG', market: 'SG' },
  { label: 'GB', sent: 'GB', market: 'GB' },
  { label: 'DE', sent: 'DE', market: 'DE' },
  { label: 'none', sent: undefined, market: 'US', assumed: true },
  { label: 'ZZ', sent: 'ZZ', market: 'ZZ' },
]);
const ROWS = Object.freeze([
  { name: 'USD', currency: 'USD', store: 'USD', id: IDS.SIG_USD, seller: IDS.SELLER_A },
  { name: 'SGD', currency: 'SGD', store: 'SGD', id: IDS.SIG_SGD, seller: IDS.SELLER_S },
  { name: 'GBP', currency: 'GBP', store: 'GBP', id: IDS.SIG_GBP, seller: IDS.SELLER_G },
  { name: 'EUR', currency: 'EUR', store: 'EUR', id: IDS.SIG_EUR, seller: IDS.SELLER_E },
  { name: 'GBP row, storefront answers USD', currency: 'GBP', store: 'USD', id: IDS.SIG_GBP_USD_STORE, seller: IDS.SELLER_H },
]);

test('the source has a currency for US, SG and GB, and none for DE or ZZ', () => {
  assert.deepEqual(MARKETS.map((m) => resolveServingCurrency(m.market) || null), ['USD', 'SGD', 'GBP', null, 'USD', null]);
});

for (const m of MARKETS) {
  for (const at of DOORS) {
    test(`market ${m.label} on ${at.path}, every hardening flag and the memo on: three attempts at each seller state no price outside the market's currency, and only a mismatching storefront is ever remembered`, async () => {
      h.setFlags([...ALL_ON, h.BIND_ENFORCE]);
      const marketCurrency = resolveServingCurrency(m.market) || null;
      for (const row of ROWS) {
        const label = `${at.path} ${m.label} x ${row.name}`;
        const n = nextKey();
        const attempts = [];
        for (let i = 0; i < 3; i += 1) attempts.push(await at.create(row.seller, row.id, m.sent, n));
        const nativeAssumed = at.path === '/mcp' && m.assumed;
        const rowsInMarket = Boolean(marketCurrency) && row.currency === marketCurrency && !nativeAssumed;
        const priced = rowsInMarket && row.store === marketCurrency;
        const mismatch = rowsInMarket && row.store !== marketCurrency;
        for (const [i, answer] of attempts.entries()) {
          const found = assertAnswerCurrency(whole(answer), marketCurrency, `${label} attempt ${i + 1}`);
          assert.deepEqual(found.textMoney, [], `${label} attempt ${i + 1}: no money in text`);
          const served = [...new Set([...found.priceCurrencies.map((c) => c.value), ...found.money.map((x) => x.currency)])];
          if (priced) {
            assert.equal(answer.isError, false, `${label} attempt ${i + 1}: ${answer.raw}`);
            assert.deepEqual(served, [marketCurrency], label);
            assert.deepEqual(tools(answer), [i === 0 ? 'create_cart' : 'get_cart'], label);
          } else {
            assert.equal(answer.isError, true, `${label} attempt ${i + 1}: ${answer.raw}`);
            assert.deepEqual(served, [], `${label} attempt ${i + 1}: no price at all`);
            assert.equal(answer.raw, attempts[0].raw, `${label} attempt ${i + 1}: the first attempt's bytes`);
            // Only the first attempt at a mismatching storefront reaches the store (and the referral route).
            const asked = mismatch && i === 0;
            assert.deepEqual([tools(answer), answer.referral.length, answer.handoff.length], [asked ? ['create_cart'] : [], asked && !m.assumed ? 1 : 0, 0], `${label} attempt ${i + 1}`);
          }
        }
        if (priced) assert.equal(at.idOf(attempts[2]), at.idOf(attempts[0]), label);
        assert.equal(memo.size(), mismatch ? 1 : 0, `${label}: remembered only for a mismatching storefront`);
        if (mismatch) assert.deepEqual(memo.counts(), { remembered: 1, refused_without_store: 2 }, label);
        memo.resetForTest();
        memo.useClockForTest(() => clock.t);
      }
    });
  }
}
