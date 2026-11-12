'use strict';

// A STOREFRONT CHECKOUT'S CURRENCY FOLLOWS THE BUYER'S MARKET (AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET), through
// the real `/ucp/mcp` door: create_checkout and get_checkout for sellers Pivota is not connected to, with an in-process
// backend and in-process seller storefronts (tests/_support/storeCartMarketDoor.cjs says what is real and what is not).
//
// THE DEFECT THIS PINS THE END OF: the answer took the catalog row's currency, so a create naming GB asked the gate
// about GB, sent GB to the seller, and answered in USD.
//
// THE PRODUCT READ DOES NOT CHANGE: with the flag on or off, in every market, the door's product read is the same one
// request with no market on it. The rule is applied in the door, to the request's market, on what that read returned
// (a price, a currency label, or the currencies the read says it withheld money in).
//
// MARKET -> CURRENCY SOURCE: `resolveServingCurrency` (src/services/buyerMarket.js) over `BUYER_REGION_CURRENCY`
// (src/auroraBff/buyerRegion.js). GB -> GBP, SG -> SGD, US -> USD; DE and ZZ have none.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/storeCartMarketDoor.cjs');
const { assertAnswerCurrency, collectAnswerCurrencies } = require('./_support/answerCurrencies.cjs');

const { IDS, HOST, ucpCreate, ucpGet, escId, decodeEscId, gid } = support;
const door = support.bootDoor({ port: 4473 });
const ucp = (name, args, o) => door.call('/ucp/mcp', name, args, o);
const on = (fn) => door.withFlag(true, fn);
const off = (fn) => door.withFlag(false, fn);
const tools = (answer) => answer.store.filter((c) => c.kind === 'tool');
const reads = (answer) => answer.upstream.filter((u) => u.op === 'get_pdp_v2').map((u) => [u.product_id, u.market]);
// The product read exactly as it was sent to the page: the payload's own bytes.
const readPayloads = (answer) => answer.upstream.filter((u) => u.op === 'get_pdp_v2').map((u) => u.payload);
const theRead = (signature) => JSON.stringify({ product_ref: { product_id: signature }, include: ['product_overview'] });
const errorOf = (answer) => (answer.value && answer.value.error) || {};
const reasonOf = (answer) => (errorOf(answer).detail || {}).reason;

test.before(() => door.listen());
test.after(() => door.close());
test.beforeEach(() => { door.setGateEnforced(true); });

// ---- US: priced exactly as before ------------------------------------------------------------------------------

test('US market, USD row, USD store answer: priced by the store, and the whole answer is pinned', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'US')));
  assert.equal(created.isError, false);
  const v = created.value;
  assert.equal(v.status, 'requires_escalation');
  assert.equal(v.currency, 'USD');
  assert.deepEqual(v.line_items, [{
    id: 'li_1',
    item: { id: IDS.SIG_USD, title: `Store item ${IDS.VARIANT_USD}`, price: 2750 },
    quantity: 1,
    totals: [{ type: 'subtotal', amount: 2750 }, { type: 'total', amount: 2750 }],
  }]);
  assert.deepEqual(v.totals, [
    { type: 'subtotal', amount: 2750, display_text: "Subtotal (priced by the seller's storefront)" },
    { type: 'total', amount: 2750, display_text: 'Total before the shipping and tax the storefront adds at checkout' },
  ]);
  assert.deepEqual(v.messages.map((m) => m.code), ['checkout.priced_by_seller_storefront']);
  const link = new URL(v.continue_url);
  assert.equal(link.hostname, HOST.A, "continue_url is on the seller's own door host");
  assert.match(link.pathname, /^\/cart\/c\/cart_store-a_\d{4}$/);
  const id = decodeEscId(v.id);
  assert.deepEqual(id, { v: 2, i: [[IDS.SIG_USD, 1]], c: link.pathname.split('/').pop(), h: HOST.A, m: 'US' });
  assert.equal('market_assumed' in v, false);
  assert.deepEqual(Object.keys(v), ['ucp', 'id', 'status', 'continue_url', 'currency', 'line_items', 'totals', 'buyer', 'links', 'expires_at', 'messages']);
  // What was asked of whom: the gate about US, the store for a US cart, the product read as always (no market).
  assert.deepEqual(created.gate, [{ domain: HOST.A, market: 'US' }]);
  assert.deepEqual(tools(created).map((c) => [c.host, c.tool, c.arguments.cart.context]), [[HOST.A, 'create_cart', { address_country: 'US' }]]);
  assert.deepEqual(reads(created), [[IDS.SIG_USD, null]]);
  assertAnswerCurrency(v, 'USD');
});

test('US market, USD row: flag on answers byte for byte what flag off answers, and sends exactly what flag off sends, on create and on get_checkout', async (t) => {
  // One instant for both runs, so `expires_at` is the same bytes; the stores restart their cart numbering each run.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-15T10:00:00.000Z') });
  const run = async () => {
    door.reset();
    const created = await ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'US'));
    const got = await ucp('get_checkout', ucpGet(created.value.id));
    return { created, got };
  };
  const before = await off(run);
  const after = await on(run);
  assert.equal(before.created.value.status, 'requires_escalation');
  assert.equal(before.got.value.messages[0].code, 'checkout.priced_by_seller_storefront');
  assert.equal(after.created.raw, before.created.raw, 'create: identical bytes');
  assert.equal(after.got.raw, before.got.raw, 'get_checkout: identical bytes');
  assert.deepEqual(after.created.store, before.created.store, 'the store was sent the same requests');
  assert.deepEqual(after.got.store, before.got.store);
  assert.deepEqual(after.created.gate, before.created.gate);
  assert.deepEqual(after.got.gate, before.got.gate);
  // Nothing differs underneath either: the same product reads, byte for byte, and the same log lines.
  assert.deepEqual(after.created.upstream, before.created.upstream);
  assert.deepEqual(after.got.upstream, before.got.upstream);
  assert.deepEqual([readPayloads(after.created), readPayloads(after.got)], [[theRead(IDS.SIG_USD)], [theRead(IDS.SIG_USD)]]);
  assert.deepEqual(after.created.log, before.created.log);
  assert.deepEqual(after.got.log, before.got.log);
});

// ---- the product read is the same request, flag off and on, in every market ---------------------------------------

test('the product read of a storefront checkout is one request with no market on it: US, SG, GB, DE, no market; flag off and on; create and get_checkout', async () => {
  const rowsByName = { USD: IDS.SIG_USD, GBP: IDS.SIG_GBP, SGD: IDS.SIG_SGD, EUR: IDS.SIG_EUR };
  for (const flag of [off, on]) {
    for (const market of ['US', 'SG', 'GB', 'DE', undefined]) {
      for (const [name, signature] of Object.entries(rowsByName)) {
        const label = `${flag === on ? 'on' : 'off'} ${market} ${name}`;
        const created = await flag(() => ucp('create_checkout', ucpCreate([[signature, 1]], market)));
        assert.deepEqual(readPayloads(created), [theRead(signature)], `create ${label}`);
        // The id this create minted, else the id a create for this market mints.
        const id = created.isError ? escId({ v: 1, i: [[signature, 1]], ...(market === undefined ? { m: 'US', a: 1 } : { m: market }) }) : created.value.id;
        const got = await flag(() => ucp('get_checkout', ucpGet(id)));
        assert.deepEqual(readPayloads(got), [theRead(signature)], `get_checkout ${label}`);
      }
    }
  }
});

test('the priced log line names the variant-id route; no buyer data, no cart id', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'US')));
  assert.deepEqual(created.log, [{ event: 'ucp_merchant_door_pricing', outcome: 'priced', seller_host: HOST.A, lines: 1, source: 'url' }]);
});

// ---- a market whose currency the seller is not priced in ---------------------------------------------------------

test('before the rule (flag off): a GB create for a USD seller is answered in USD (the defect)', async () => {
  const created = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB')));
  assert.equal(created.value.currency, 'USD');
  assert.equal(created.value.messages[0].code, 'checkout.priced_by_seller_storefront');
  assert.deepEqual(reads(created), [[IDS.SIG_USD, null]]);
});

test('GB market, USD row: refused by name, the seller is never contacted, no price is stated', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB')));
  assert.equal(created.isError, true);
  const error = errorOf(created);
  assert.equal(error.code, 'NO_MERCHANT_OFFER');
  assert.equal(error.retriable, false);
  assert.deepEqual(error.detail, {
    reason: 'seller_not_priced_in_market_currency',
    market: 'GB',
    market_currency: 'GBP',
    seller_currencies: ['USD'],
    storefront_items: [IDS.SIG_USD],
    seller_hosts: [HOST.A],
    storefront_urls: { [IDS.SIG_USD]: `https://${HOST.A}/products/calm-serum?variant=${IDS.VARIANT_USD}` },
  });
  assert.match(error.message, /No price can be stated for a buyer in GB/);
  assert.match(error.message, /is priced in USD, and a price for GB must be in GBP/);
  assert.match(error.message, /Nothing was converted or relabelled, and no cart was built/);
  assert.equal('market_assumed' in error, false);
  assert.deepEqual(created.store, [], 'ZERO store calls: no profile read, no cart');
  assert.deepEqual(created.gate, [{ domain: HOST.A, market: 'GB' }], 'the gate was asked as before');
  // ONE read, with no market: the row it returned states USD, and that is judged against GB's currency here.
  assert.deepEqual(readPayloads(created), [theRead(IDS.SIG_USD)]);
  const found = assertAnswerCurrency(created.value, 'GBP');
  assert.deepEqual(found.money, [], 'no amount anywhere in the answer');
  assert.deepEqual(found.priceCurrencies, []);
  assert.deepEqual(created.log, [{
    event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency',
    market: 'GB', expected_currency: 'GBP', row_currency: 'USD', seller_host: HOST.A,
  }]);
});

test('GB market, a USD row served by a page the money guard does not cover: the same refusal, with one read and no store call', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD_UNGUARDED, 1]], 'GB')));
  assert.equal(reasonOf(created), 'seller_not_priced_in_market_currency');
  assert.deepEqual(errorOf(created).detail.seller_currencies, ['USD']);
  assert.deepEqual(created.store, []);
  assert.deepEqual(readPayloads(created), [theRead(IDS.SIG_USD_UNGUARDED)]);
  assert.deepEqual(assertAnswerCurrency(created.value, 'GBP').money, []);
});

for (const [market, signature, host, sellerCurrency] of [['GB', IDS.SIG_SGD, HOST.S, 'SGD'], ['GB', IDS.SIG_EUR, HOST.E, 'EUR'], ['SG', IDS.SIG_GBP, HOST.G, 'GBP'], ['US', IDS.SIG_SGD, HOST.S, 'SGD']]) {
  test(`${market} market, a seller priced in ${sellerCurrency} (its money withheld by the read): the same named refusal, naming ${sellerCurrency}; one read, no store call`, async () => {
    const marketCurrency = { GB: 'GBP', SG: 'SGD', US: 'USD' }[market];
    const created = await on(() => ucp('create_checkout', ucpCreate([[signature, 1]], market)));
    assert.equal(created.isError, true);
    const error = errorOf(created);
    assert.equal(error.code, 'NO_MERCHANT_OFFER');
    assert.equal(error.retriable, false);
    assert.equal(error.detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual([error.detail.market, error.detail.market_currency, error.detail.seller_currencies, error.detail.seller_hosts], [market, marketCurrency, [sellerCurrency], [host]]);
    assert.match(error.message, new RegExp(`is priced in ${sellerCurrency}, and a price for ${market} must be in ${marketCurrency}`));
    assert.deepEqual(created.store, [], 'ZERO store calls');
    assert.deepEqual(readPayloads(created), [theRead(signature)]);
    const found = assertAnswerCurrency(created.value, marketCurrency);
    assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []]);
    assert.deepEqual(created.log, [{
      event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency',
      market, expected_currency: marketCurrency, row_currency: sellerCurrency, seller_host: host,
    }]);
    // Flag off, the same request is the unnamed "no price" it always was.
    const before = await off(() => ucp('create_checkout', ucpCreate([[signature, 1]], market)));
    assert.equal(errorOf(before).code, 'NO_MERCHANT_OFFER');
    assert.equal(reasonOf(before), undefined);
  });
}

test('GB market, GBP row, GBP store answer: priced in GBP, on create and on get_checkout', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP, 1]], 'GB')));
  assert.equal(created.isError, false);
  assert.equal(created.value.currency, 'GBP');
  assert.deepEqual(created.value.totals.map((x) => x.amount), [2100, 2100]);
  assert.equal(created.value.messages[0].code, 'checkout.priced_by_seller_storefront');
  assert.equal(decodeEscId(created.value.id).m, 'GB');
  assert.deepEqual(tools(created).map((c) => [c.tool, c.arguments.cart.context]), [['create_cart', { address_country: 'GB' }]]);
  assert.deepEqual(readPayloads(created), [theRead(IDS.SIG_GBP)]);
  assertAnswerCurrency(created.value, 'GBP');
  const got = await on(() => ucp('get_checkout', ucpGet(created.value.id)));
  assert.equal(got.value.currency, 'GBP');
  assert.deepEqual(got.value.totals.map((x) => x.amount), [2100, 2100]);
  assert.deepEqual(tools(got).map((c) => c.tool), ['get_cart']);
  assert.deepEqual(readPayloads(got), [theRead(IDS.SIG_GBP)]);
  assertAnswerCurrency(got.value, 'GBP');
});

test('before the rule (flag off): the same GB create for a GBP seller could not be priced at all', async () => {
  const created = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP, 1]], 'GB')));
  assert.equal(errorOf(created).code, 'NO_MERCHANT_OFFER', 'its GBP price is withheld by the read, and nothing said the seller is priced in GBP');
  assert.deepEqual(created.store, []);
});

test("GB market, a GBP row with a catalog price, the store answers in USD: the store's price is not shown; the answer is the GBP catalog price", async (t) => {
  // The row served by a page the money guard does not cover still states its GBP price on a read with no market.
  door.setStoreCurrency(HOST.V, 'USD');
  t.after(() => door.setStoreCurrency(HOST.V, null));
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP_UNGUARDED, 1]], 'GB')));
  assert.equal(created.isError, false);
  assert.equal(created.value.currency, 'GBP');
  assert.deepEqual(created.value.totals.map((x) => x.amount), [2000, 2000], "the catalog's 20.00, not the store's 21.00 USD");
  assert.equal(created.value.messages[0].code, 'checkout.completes_on_seller_storefront');
  assert.equal(JSON.stringify(created.value).includes('USD'), false, 'USD appears nowhere in a GB answer');
  assert.equal(decodeEscId(created.value.id).v, 1, 'no store cart is carried');
  assert.deepEqual(tools(created).map((c) => c.tool), ['create_cart']);
  assertAnswerCurrency(created.value, 'GBP');
  assert.deepEqual(created.log, [{
    event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'store_currency_not_market_currency',
    market: 'GB', expected_currency: 'GBP', row_currency: 'GBP', store_currency: 'USD', seller_host: HOST.V,
  }]);
  const got = await on(() => ucp('get_checkout', ucpGet(created.value.id)));
  assert.equal(got.value.currency, 'GBP');
  assert.deepEqual(got.value.totals.map((x) => x.amount), [2000, 2000]);
  assert.deepEqual(got.store, []);
  assertAnswerCurrency(got.value, 'GBP');
});

test("GB market, a GBP seller whose money the read withheld, the store answers in USD: no price in GBP exists, and the refusal names what the storefront answered in", async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP_USD_STORE, 1]], 'GB')));
  assert.equal(created.isError, true);
  const error = errorOf(created);
  assert.equal(error.code, 'NO_MERCHANT_OFFER');
  assert.deepEqual(error.detail, {
    reason: 'seller_not_priced_in_market_currency', market: 'GB', market_currency: 'GBP', seller_currencies: ['USD'],
    storefront_items: [IDS.SIG_GBP_USD_STORE], seller_hosts: [HOST.H],
    storefront_urls: { [IDS.SIG_GBP_USD_STORE]: `https://${HOST.H}/products/eye-gel?variant=${IDS.VARIANT_GBP_USD_STORE}` },
  });
  assert.match(error.message, /storefront \(store-h\.example\) answered in USD, and a price for GB must be in GBP/);
  assert.doesNotMatch(error.message, /no cart was built/, 'a cart WAS asked for: the message does not say otherwise');
  assert.deepEqual(tools(created).map((c) => c.tool), ['create_cart'], 'the seller was asked once: the read said it is priced in GBP');
  const found = assertAnswerCurrency(created.value, 'GBP');
  assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []]);
  assert.deepEqual(created.log, [
    { event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'store_currency_not_market_currency', market: 'GB', expected_currency: 'GBP', row_currency: null, store_currency: 'USD', seller_host: HOST.H },
    { event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency', market: 'GB', expected_currency: 'GBP', row_currency: null, store_currency: 'USD', seller_host: HOST.H },
  ]);
});

test('two products in one GB cart: each is read once, with no market, and both are named in the refusal', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1], [IDS.SIG_USD_SECOND, 2]], 'GB')));
  assert.equal(reasonOf(created), 'seller_not_priced_in_market_currency');
  assert.deepEqual(errorOf(created).detail.storefront_items, [IDS.SIG_USD, IDS.SIG_USD_SECOND]);
  assert.deepEqual(readPayloads(created).sort(), [theRead(IDS.SIG_USD), theRead(IDS.SIG_USD_SECOND)].sort(), 'two reads for two products: nothing is read twice');
  assert.deepEqual(created.store, []);
});

// ---- a market with no currency -----------------------------------------------------------------------------------

for (const [market, signature, host] of [['DE', IDS.SIG_USD, HOST.A], ['DE', IDS.SIG_EUR, HOST.E], ['ZZ', IDS.SIG_USD, HOST.A]]) {
  test(`market ${market} (no currency in the source), row of ${host}: refused by name, never answered as US`, async () => {
    const created = await on(() => ucp('create_checkout', ucpCreate([[signature, 1]], market)));
    assert.equal(created.isError, true);
    const error = errorOf(created);
    assert.equal(error.code, 'NO_MERCHANT_OFFER');
    assert.deepEqual(error.detail, { reason: 'market_not_priced', market, storefront_items: [signature], seller_hosts: [host] });
    assert.match(error.message, new RegExp(`No price can be stated for a buyer in ${market}`));
    assert.equal('market_assumed' in error, false);
    assert.deepEqual(created.store, []);
    assert.deepEqual(created.gate, [], 'not even the gate is asked');
    assert.deepEqual(reads(created), [[signature, null]], 'one read, to learn it is a storefront cart at all');
    const found = assertAnswerCurrency(created.value, null);
    assert.deepEqual([found.money, found.priceCurrencies, found.otherCurrencyMentions], [[], [], []]);
    assert.deepEqual(created.log, [{
      event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'market_not_priced', market,
      expected_currency: null, row_currency: null, seller_host: host,
    }]);
  });
}

test('before the rule (flag off): DE and ZZ were answered with the USD price', async () => {
  for (const market of ['DE', 'ZZ']) {
    const created = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], market)));
    assert.equal(created.value.currency, 'USD', market);
  }
});

test('a market value that is not a country code: refused by name, the value is not echoed', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'USA')));
  assert.equal(errorOf(created).code, 'QUOTE_REQUIRED');
  assert.deepEqual(errorOf(created).detail, { reason: 'ucp_market_invalid', rejected_field: 'checkout.context.address_country' });
  assert.equal(JSON.stringify(created.value).includes('USA'), false);
  assert.deepEqual([created.store, created.gate], [[], []]);
});

test('a cart of a connected merchant is not a storefront cart: an unpriced market does not refuse it, and its answer is unchanged', async () => {
  for (const market of ['US', 'GB', 'DE']) {
    const before = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_CONNECTED, 1]], market)));
    const after = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_CONNECTED, 1]], market)));
    assert.equal(after.raw, before.raw, market);
    assert.ok(after.upstream.some((u) => u.op === 'quotes.preview'), 'the kernel path ran');
  }
});

// ---- no market named ---------------------------------------------------------------------------------------------

test('no market named: still answered as US and labelled, in USD only', async () => {
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]])));
  assert.equal(created.isError, false);
  assert.equal(created.value.currency, 'USD');
  assert.equal(created.value.market_assumed.code, 'US');
  assert.deepEqual(created.value.messages.map((m) => m.code), ['checkout.priced_by_seller_storefront', 'market_assumed']);
  assert.deepEqual(decodeEscId(created.value.id).m, 'US');
  assert.equal(decodeEscId(created.value.id).a, 1);
  assert.deepEqual(readPayloads(created), [theRead(IDS.SIG_USD)], 'the assumed market is not put on the read either');
  assertAnswerCurrency(created.value, 'USD');
  const got = await on(() => ucp('get_checkout', ucpGet(created.value.id)));
  assert.equal(got.value.currency, 'USD');
  assert.equal(got.value.market_assumed.code, 'US');
  assertAnswerCurrency(got.value, 'USD');
});

test('no market named, a seller priced in GBP: no GBP price is shown as a US one', async () => {
  // The row states GBP: refused by name, for the assumed US, and it says it was assumed.
  const stated = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP_UNGUARDED, 1]])));
  assert.equal(reasonOf(stated), 'seller_not_priced_in_market_currency');
  assert.deepEqual([errorOf(stated).detail.market, errorOf(stated).detail.market_currency, errorOf(stated).detail.seller_currencies], ['US', 'USD', ['GBP']]);
  assert.equal(errorOf(stated).market_assumed.code, 'US');
  assert.match(errorOf(stated).message, /No market was named, so this was decided for a US buyer/);
  assert.deepEqual(stated.store, []);
  assert.deepEqual(assertAnswerCurrency(stated.value, 'USD').money, []);
  // The same row, market US named: the same refusal, not labelled as assumed.
  const named = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP_UNGUARDED, 1]], 'US')));
  assert.equal(reasonOf(named), 'seller_not_priced_in_market_currency');
  assert.equal('market_assumed' in errorOf(named), false);
  assert.deepEqual(named.store, []);
  // A row whose GBP money the product read withheld: the same named refusal (the read says it withheld GBP), where
  // flag off gives the unnamed "no price". Neither shows a price or asks the seller, and both read once.
  const before = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP, 1]])));
  const after = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP, 1]])));
  assert.equal(errorOf(before).code, 'NO_MERCHANT_OFFER');
  assert.equal(reasonOf(before), undefined);
  assert.equal(reasonOf(after), 'seller_not_priced_in_market_currency');
  assert.deepEqual([errorOf(after).detail.market, errorOf(after).detail.market_currency, errorOf(after).detail.seller_currencies], ['US', 'USD', ['GBP']]);
  assert.equal(errorOf(after).market_assumed.code, 'US');
  assert.deepEqual([before.store, after.store], [[], []]);
  assert.deepEqual(readPayloads(after), readPayloads(before));
  assert.deepEqual(readPayloads(after), [theRead(IDS.SIG_GBP)]);
});

test('before the rule (flag off): a row stating GBP was answered in GBP to a US buyer', async () => {
  const created = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP_UNGUARDED, 1]], 'US')));
  assert.equal(created.value.currency, 'GBP');
});

// ---- get_checkout on ids from before the rule --------------------------------------------------------------------

test('an id minted before the rule for GB with a USD store cart is not re-served: refused, and the cart is not read', async () => {
  const minted = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB')));
  const id = decodeEscId(minted.value.id);
  assert.deepEqual([id.v, id.m, minted.value.currency], [2, 'GB', 'USD'], 'the defect minted a GB id over a USD cart');
  const stillServedOff = await off(() => ucp('get_checkout', ucpGet(minted.value.id)));
  assert.equal(stillServedOff.value.currency, 'USD');
  const got = await on(() => ucp('get_checkout', ucpGet(minted.value.id)));
  assert.equal(got.isError, true);
  assert.equal(errorOf(got).code, 'NO_MERCHANT_OFFER');
  assert.equal(reasonOf(got), 'seller_not_priced_in_market_currency');
  assert.deepEqual([errorOf(got).detail.market, errorOf(got).detail.market_currency, errorOf(got).detail.seller_currencies], ['GB', 'GBP', ['USD']]);
  assert.deepEqual(got.store, [], 'the seller is not asked for the cart');
  assert.deepEqual(readPayloads(got), [theRead(IDS.SIG_USD)]);
  assert.deepEqual(assertAnswerCurrency(got.value, 'GBP').money, []);
  // The same for a catalog-priced id (no cart) minted for GB.
  const catalogId = escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'GB' });
  assert.equal((await off(() => ucp('get_checkout', ucpGet(catalogId)))).value.currency, 'USD');
  const gotCatalog = await on(() => ucp('get_checkout', ucpGet(catalogId)));
  assert.equal(reasonOf(gotCatalog), 'seller_not_priced_in_market_currency');
  assert.deepEqual(assertAnswerCurrency(gotCatalog.value, 'GBP').money, []);
});

test('an id minted before the rule over a USD cart, for a USD row served by a page the money guard does not cover: the cart is not read either', async () => {
  const minted = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD_UNGUARDED, 1]], 'GB')));
  assert.deepEqual([decodeEscId(minted.value.id).v, decodeEscId(minted.value.id).m, minted.value.currency], [2, 'GB', 'USD']);
  const got = await on(() => ucp('get_checkout', ucpGet(minted.value.id)));
  assert.equal(reasonOf(got), 'seller_not_priced_in_market_currency');
  assert.deepEqual(got.store, [], 'no get_cart, no profile read');
  assert.deepEqual(readPayloads(got), [theRead(IDS.SIG_USD_UNGUARDED)]);
  assert.deepEqual(assertAnswerCurrency(got.value, 'GBP').money, []);
});

test("a re-read of a store cart that answers in USD, for a GB id: the store's price is never shown, and the log says why", async (t) => {
  // A GBP row with a catalog price (a page the money guard does not cover): the catalog's GBP price is the answer.
  door.reset();
  door.setStoreCurrency(HOST.V, 'USD');
  t.after(() => door.setStoreCurrency(HOST.V, null));
  const created = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP_UNGUARDED, 1]], 'GB')));
  assert.equal(created.value.messages[0].code, 'checkout.completes_on_seller_storefront');
  const cartId = 'cart_store-v_0001';
  const id = escId({ v: 2, i: [[IDS.SIG_GBP_UNGUARDED, 1]], c: cartId, h: HOST.V, m: 'GB' });
  const got = await on(() => ucp('get_checkout', ucpGet(id)));
  assert.deepEqual(tools(got).map((c) => [c.tool, c.arguments.id]), [['get_cart', cartId]], 'the cart exists and was read');
  assert.equal(got.value.currency, 'GBP');
  assert.deepEqual(got.value.totals.map((x) => x.amount), [2000, 2000], "the catalog's GBP price, not the cart's USD one");
  assert.equal(JSON.stringify(got.value).includes('USD'), false);
  assertAnswerCurrency(got.value, 'GBP');
  assert.deepEqual(got.log, [{
    event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'store_currency_not_market_currency',
    market: 'GB', expected_currency: 'GBP', row_currency: 'GBP', store_currency: 'USD', seller_host: HOST.V,
  }]);
  // A GBP seller whose money the read withheld: there is no catalog price to fall back to, so it is the named refusal.
  door.reset();
  const refused = await on(() => ucp('create_checkout', ucpCreate([[IDS.SIG_GBP_USD_STORE, 1]], 'GB')));
  assert.equal(reasonOf(refused), 'seller_not_priced_in_market_currency');
  const withheldId = escId({ v: 2, i: [[IDS.SIG_GBP_USD_STORE, 1]], c: 'cart_store-h_0001', h: HOST.H, m: 'GB' });
  const gotWithheld = await on(() => ucp('get_checkout', ucpGet(withheldId)));
  assert.deepEqual(tools(gotWithheld).map((c) => [c.tool, c.arguments.id]), [['get_cart', 'cart_store-h_0001']]);
  assert.equal(reasonOf(gotWithheld), 'seller_not_priced_in_market_currency');
  assert.deepEqual(errorOf(gotWithheld).detail.seller_currencies, ['USD']);
  assert.deepEqual(assertAnswerCurrency(gotWithheld.value, 'GBP').money, []);
});

test('an id minted for a market with no currency is refused by name on re-read', async () => {
  const id = escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'DE' });
  assert.equal((await off(() => ucp('get_checkout', ucpGet(id)))).value.currency, 'USD', 'before: re-served in USD');
  const got = await on(() => ucp('get_checkout', ucpGet(id)));
  assert.equal(errorOf(got).code, 'NO_MERCHANT_OFFER');
  assert.deepEqual(errorOf(got).detail, { reason: 'market_not_priced', market: 'DE', storefront_items: [IDS.SIG_USD], seller_hosts: [HOST.A] });
  assert.deepEqual([got.store, got.gate], [[], []]);
  assert.deepEqual(assertAnswerCurrency(got.value, null).money, []);
});

test('an id that carries no market is never re-served for an implied US: v1, v2 without `m`, and a malformed `m`', async () => {
  // A backend that does not enforce the gate yet: there, before the rule, such ids ARE re-served.
  door.setGateEnforced(false);
  const minted = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'US')));
  const { c, h } = decodeEscId(minted.value.id);
  const v1 = escId({ v: 1, i: [[IDS.SIG_USD, 1]] });
  const v2 = escId({ v: 2, i: [[IDS.SIG_USD, 1]], c, h });
  const beforeV1 = await off(() => ucp('get_checkout', ucpGet(v1)));
  const beforeV2 = await off(() => ucp('get_checkout', ucpGet(v2)));
  assert.deepEqual([beforeV1.value.currency, beforeV1.value.totals[0].amount], ['USD', 2500], 'before: the catalog price, as if for US');
  assert.deepEqual([beforeV2.value.currency, beforeV2.value.totals[0].amount], ['USD', 2750], "before: the store's cart, as if for US");
  for (const [label, id] of [['v1', v1], ['v2 without m', v2]]) {
    const got = await on(() => ucp('get_checkout', ucpGet(id)));
    assert.equal(got.isError, true, label);
    assert.equal(errorOf(got).code, 'OPERATION_NOT_ALLOWED', label);
    assert.deepEqual(errorOf(got).detail, { reason: 'ucp_escalation_reread_unconfirmed' }, label);
    assert.match(errorOf(got).message, /created before checkouts recorded their market/, label);
    assert.equal('market_assumed' in errorOf(got), false, label);
    assert.deepEqual([got.store, got.gate], [[], []], `${label}: neither the seller nor the gate is asked`);
    assert.deepEqual(assertAnswerCurrency(got.value, null).money, [], label);
    assert.deepEqual(got.log, [{
      event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'market_unrecorded', market: null,
      expected_currency: null, row_currency: null, seller_host: HOST.A,
    }], label);
  }
  // A malformed or blank `m` is no id of this door at all, flag on or off: unknown checkout, nothing read.
  for (const m of ['usa', '', 'U1', 5]) {
    const id = escId({ v: 2, i: [[IDS.SIG_USD, 1]], c, h, m });
    const before = await off(() => ucp('get_checkout', ucpGet(id)));
    const got = await on(() => ucp('get_checkout', ucpGet(id)));
    assert.equal(errorOf(got).code, 'QUOTE_NOT_FOUND', JSON.stringify(m));
    assert.equal(got.raw, before.raw, JSON.stringify(m));
    assert.deepEqual([got.store, got.upstream, got.gate], [[], [], []], JSON.stringify(m));
  }
});

// ---- the rule is the flag's ---------------------------------------------------------------------------------------

test('the helper sees what a wrong answer looks like (the flag-off GB answer breaks the rule)', async () => {
  const created = await off(() => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB')));
  assert.throws(() => assertAnswerCurrency(created.value, 'GBP'), /is USD, the market's currency is GBP/);
  assert.ok(collectAnswerCurrencies(created.value).money.length >= 5);
  assert.equal(gid(IDS.VARIANT_USD), tools(created)[0].arguments.cart.line_items[0].item.id);
});
