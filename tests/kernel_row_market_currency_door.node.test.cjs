'use strict';

// A CHECKOUT PIVOTA PRICES ITSELF, MARKET BY MARKET: a price for a market is in that market's currency, or the
// request is refused by name. The companion of tests/store_cart_market_currency_table.node.test.cjs, which holds the
// SELLER-STOREFRONT rows to the same rule.
//
// WHAT WAS WRONG. On `/mcp`, `market` is an argument of create_checkout_session only while the door's storefront
// path is on (AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED and AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET). A
// create for a merchant Pivota prices itself (a "kernel row") accepted it and dropped it: the cart was priced in the
// seller's own currency for any market named, one this gateway prices nothing in included.
//
// THE MATRIX. markets US, SG, GB, DE, none, ZZ
//           x a kernel row and a seller-storefront row (both priced in USD)
//           x `/mcp` and `/ucp/mcp`
//           x the `/mcp` storefront switch off / on  x  the currency rule off / on        = 96 cells.
// Each cell says what the door answers AND what it asked of the backend and of the seller's store. A priced answer is
// walked whole (assertAnswerCurrency, tests/_support/answerCurrencies.cjs) against the currency the gateway's one
// market -> currency source (`resolveServingCurrency`, src/services/buyerMarket.js) gives for the market. This file
// keeps no market table.
//
// THREE KINDS OF CELL THAT ARE NOT "PRICED IN THE MARKET'S CURRENCY OR REFUSED BY NAME", each pinned as what it is:
//   - `/mcp`, no market, kernel row: priced in the seller's own currency, with no market stated or assumed. This is
//     what the door answered before the rule, with every switch off too. The rule changes nothing for it;
//   - `/ucp/mcp`, kernel row: no priced answer in any market (the UCP checkout shape names no merchant, so the
//     pricing engine is never given one). Not a price, and not a refusal by name either;
//   - `/ucp/mcp`, storefront row, currency rule OFF: answered in the row's currency for any market. That is the
//     behaviour the currency rule exists to end; the cell asserts the walker REPORTS it, so it cannot pass quietly.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/storeCartMarketDoor.cjs');
const { assertAnswerCurrency, answerCurrencyProblems, collectAnswerCurrencies } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { IDS, HOST, ucpCreate, nativeCreate } = support;
const door = support.bootDoor({ port: 5521 });

test.before(() => door.listen());
test.after(() => door.close());
test.afterEach(() => { door.setQuoteCurrency(null); door.reset(); });

const MARKETS = Object.freeze([
  { label: 'US', sent: 'US' },
  { label: 'SG', sent: 'SG' },
  { label: 'GB', sent: 'GB' },
  { label: 'DE', sent: 'DE' },
  { label: 'none', sent: undefined },
  { label: 'ZZ', sent: 'ZZ' },
]);
const FLAGS = Object.freeze([
  { mcp: false, currency: false }, { mcp: false, currency: true }, { mcp: true, currency: false }, { mcp: true, currency: true },
]);
const SELLER_CURRENCY = 'USD'; // what both fixture rows are priced in

let key = 8000;
const nextKey = () => { key += 1; return key; };
const kernelCreate = (sent, n = nextKey()) => nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], n, sent === undefined ? {} : { market: sent });
const storefrontCreate = (sent, n = nextKey()) => nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], n, sent === undefined ? {} : { market: sent });
const servedCurrencies = (found) => [...new Set([...found.priceCurrencies.map((c) => c.value), ...found.money.map((m) => m.currency)])];
const storeTools = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);
const countryOf = (quoteBody) => (quoteBody && quoteBody.request_context && Object.prototype.hasOwnProperty.call(quoteBody.request_context, 'country') ? quoteBody.request_context.country : null);

/** What one cell answers. `kind` names the assertion below; the rest is what that assertion needs. */
function expectedOf({ flags, row, doorPath, m }) {
  const pathOn = flags.mcp && flags.currency;
  const named = m.sent !== undefined;
  const marketCurrency = named ? (resolveServingCurrency(m.sent) || null) : null;
  if (doorPath === '/mcp') {
    // `market` is declared on create only while the storefront path is on.
    if (named && !pathOn) return { kind: 'market_not_an_argument' };
    if (row === 'kernel') {
      if (!named) return { kind: 'kernel_priced_no_market' };
      if (!marketCurrency) return { kind: 'refused', code: 'NO_MERCHANT_OFFER', reason: 'market_not_priced', quotes: 0 };
      if (marketCurrency !== SELLER_CURRENCY) return { kind: 'refused', code: 'NO_MERCHANT_OFFER', reason: 'seller_not_priced_in_market_currency', quotes: 1, marketCurrency };
      return { kind: 'kernel_priced', marketCurrency };
    }
    if (!named) {
      return pathOn
        ? { kind: 'refused', code: 'QUOTE_REQUIRED', reason: 'market_required_for_seller_storefront', quotes: 0 }
        : { kind: 'refused', code: 'OPERATION_NOT_ALLOWED', reason: 'ucp_storefront_checkout_unavailable', quotes: 1 };
    }
    if (!marketCurrency) return { kind: 'refused', code: 'NO_MERCHANT_OFFER', reason: 'market_not_priced', quotes: 0 };
    if (marketCurrency !== SELLER_CURRENCY) return { kind: 'refused', code: 'NO_MERCHANT_OFFER', reason: 'seller_not_priced_in_market_currency', quotes: 0 };
    return { kind: 'storefront_priced', status: 'completes_on_seller_storefront', marketCurrency, assumed: false };
  }
  // `/ucp/mcp`
  if (row === 'kernel') return { kind: 'ucp_kernel_unpriced' };
  // No market named: answered as US, labelled `market_assumed`, under either state of the currency rule.
  const ucpCurrency = named ? marketCurrency : resolveServingCurrency('US');
  if (!flags.currency) {
    return named && ucpCurrency !== SELLER_CURRENCY
      ? { kind: 'ucp_storefront_rule_off', marketCurrency: ucpCurrency }
      : { kind: 'storefront_priced', status: 'requires_escalation', marketCurrency: ucpCurrency, assumed: !named };
  }
  if (!ucpCurrency) return { kind: 'refused', code: 'NO_MERCHANT_OFFER', reason: 'market_not_priced', quotes: 0 };
  if (ucpCurrency !== SELLER_CURRENCY) return { kind: 'refused', code: 'NO_MERCHANT_OFFER', reason: 'seller_not_priced_in_market_currency', quotes: 0 };
  return { kind: 'storefront_priced', status: 'requires_escalation', marketCurrency: ucpCurrency, assumed: !named };
}

const cells = [];
for (const flags of FLAGS) for (const row of ['kernel', 'storefront']) for (const m of MARKETS) for (const doorPath of ['/mcp', '/ucp/mcp']) {
  cells.push({ flags, row, m, doorPath, expected: expectedOf({ flags, row, doorPath, m }) });
}

test('the matrix covers what it says, and the source prices US, SG and GB and has no currency for DE or ZZ', () => {
  assert.deepEqual(['US', 'SG', 'GB', 'DE', 'ZZ'].map((code) => resolveServingCurrency(code) || null), ['USD', 'SGD', 'GBP', null, null]);
  const count = (pick) => cells.filter(pick).length;
  const reason = (r) => count((c) => c.expected.kind === 'refused' && c.expected.reason === r);
  assert.deepEqual({
    cells: cells.length,
    market_not_an_argument: count((c) => c.expected.kind === 'market_not_an_argument'),
    kernel_priced: count((c) => c.expected.kind === 'kernel_priced'),
    kernel_priced_no_market: count((c) => c.expected.kind === 'kernel_priced_no_market'),
    storefront_priced: count((c) => c.expected.kind === 'storefront_priced'),
    ucp_kernel_unpriced: count((c) => c.expected.kind === 'ucp_kernel_unpriced'),
    ucp_storefront_rule_off: count((c) => c.expected.kind === 'ucp_storefront_rule_off'),
    market_not_priced: reason('market_not_priced'),
    seller_not_priced_in_market_currency: reason('seller_not_priced_in_market_currency'),
    market_required_for_seller_storefront: reason('market_required_for_seller_storefront'),
    ucp_storefront_checkout_unavailable: reason('ucp_storefront_checkout_unavailable'),
  }, {
    cells: 96,
    market_not_an_argument: 30, // /mcp, a named market, the storefront path not on: 5 markets x 2 rows x 3 flag sets
    kernel_priced: 1, // /mcp, path on, US
    kernel_priced_no_market: 4, // /mcp, no market, every flag set
    storefront_priced: 9, // /mcp path on US; /ucp/mcp US and none in all four flag sets
    ucp_kernel_unpriced: 24,
    ucp_storefront_rule_off: 8, // /ucp/mcp, rule off, SG GB DE ZZ, two flag sets
    market_not_priced: 8, // DE and ZZ: /mcp path on, kernel and storefront; /ucp/mcp rule on, storefront, two flag sets
    seller_not_priced_in_market_currency: 8, // SG and GB, the same cells
    market_required_for_seller_storefront: 1,
    ucp_storefront_checkout_unavailable: 3,
  });
});

for (const cell of cells) {
  const { flags, row, m, doorPath, expected } = cell;
  const name = `${doorPath} ${row} row, market ${m.label}, storefront switch ${flags.mcp ? 'on' : 'off'}, currency rule ${flags.currency ? 'on' : 'off'}: ${expected.kind}${expected.reason ? ` ${expected.reason}` : ''}`;
  test(name, async () => {
    const answer = await door.withFlags(flags, () => (doorPath === '/mcp'
      ? door.call('/mcp', 'create_checkout_session', row === 'kernel' ? kernelCreate(m.sent) : storefrontCreate(m.sent))
      : door.call('/ucp/mcp', 'create_checkout', ucpCreate([[row === 'kernel' ? IDS.SIG_CONNECTED : IDS.SIG_USD, 1]], m.sent, nextKey()))));
    const body = JSON.parse(answer.raw);
    const found = collectAnswerCurrencies(body);

    if (expected.kind === 'market_not_an_argument') {
      assert.equal(answer.value.error.code, 'INVALID_ARGUMENTS');
      assert.match(answer.value.error.message, /unknown argument "market"/);
      assert.deepEqual([found.money, found.priceCurrencies, answer.upstream, answer.quotes, answer.store, answer.gate], [[], [], [], [], [], []], 'refused before anything is read, priced or asked');
      return;
    }
    if (expected.kind === 'refused') {
      assert.equal(answer.isError, true);
      assert.equal(answer.value.error.code, expected.code);
      assert.equal(answer.value.error.detail.reason, expected.reason, 'the refusal is named');
      assert.equal(answer.value.error.retriable, false);
      assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []], 'no price, no price label and no money in text');
      assert.equal(answer.quotes.length, expected.quotes, 'the quotes the backend was asked for');
      assert.deepEqual(storeTools(answer), [], 'no seller storefront was asked for a cart');
      if (expected.reason === 'market_not_priced') {
        assert.equal(answer.value.error.detail.market, m.sent, 'the market is named');
        assert.ok(answer.value.error.message.includes(m.sent));
        assert.equal(answer.value.market_assumed, undefined, 'never answered as another market');
      }
      if (row === 'kernel' && expected.reason === 'seller_not_priced_in_market_currency') {
        assert.deepEqual(answer.value.error.detail, { reason: expected.reason, market: m.sent, market_currency: expected.marketCurrency, seller_currencies: [SELLER_CURRENCY] });
        assert.deepEqual(answer.quotes.map(countryOf), [m.sent], 'the one quote carried the market');
      }
      if (row === 'kernel' && expected.reason === 'market_not_priced') assert.deepEqual(answer.upstream, [], 'nothing was read or priced');
      return;
    }
    if (expected.kind === 'kernel_priced' || expected.kind === 'kernel_priced_no_market') {
      // No market named: nothing is assumed, so the currency is the seller's own and the quote carries no market.
      const currency = expected.kind === 'kernel_priced' ? expected.marketCurrency : SELLER_CURRENCY;
      assert.equal(answer.isError, false);
      assertAnswerCurrency(body, currency, name);
      assert.equal(answer.value.status, 'ready_for_payment');
      assert.equal(answer.value.currency, currency);
      assert.deepEqual(answer.value.totals, { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, 'the amounts are the quote\'s own');
      assert.deepEqual(servedCurrencies(found), [currency]);
      assert.equal(answer.value.market_assumed, undefined);
      assert.deepEqual(answer.upstream, [{ op: 'quotes.preview', merchant_id: IDS.SELLER_CONNECTED }], 'one quote, nothing else');
      assert.deepEqual(answer.quotes.map(countryOf), [expected.kind === 'kernel_priced' ? m.sent : null], 'the quote carries the market the request named, and none when it named none');
      assert.deepEqual(answer.store, []);
      return;
    }
    if (expected.kind === 'storefront_priced') {
      assert.equal(answer.isError, false);
      assertAnswerCurrency(body, expected.marketCurrency, name);
      assert.equal(answer.value.status, expected.status);
      assert.equal(answer.value.currency, expected.marketCurrency);
      assert.ok(found.money.length > 0, 'a price is stated');
      assert.deepEqual(servedCurrencies(found), [expected.marketCurrency]);
      assert.equal(answer.value.market_assumed ? answer.value.market_assumed.code : null, expected.assumed ? 'US' : null);
      assert.deepEqual(storeTools(answer), ['create_cart'], 'the seller built one cart');
      assert.deepEqual(answer.quotes, [], 'the backend was not asked for a quote');
      return;
    }
    if (expected.kind === 'ucp_kernel_unpriced') {
      assert.equal(answer.isError, true);
      assert.equal(answer.value.error.code, 'MERCHANT_UNAVAILABLE');
      assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []], 'no price is stated');
      assert.equal(answer.quotes.length, 1);
      assert.equal(answer.quotes[0].merchant_id, undefined, 'the quote names no merchant: this door cannot price the row');
      assert.equal(countryOf(answer.quotes[0]), null);
      assert.deepEqual(answer.store, []);
      return;
    }
    assert.equal(expected.kind, 'ucp_storefront_rule_off');
    // The currency rule is off: the answer is in the row's currency whatever the market. Reported, not hidden.
    assert.equal(answer.isError, false);
    assert.equal(answer.value.currency, SELLER_CURRENCY);
    assert.ok(answerCurrencyProblems(body, expected.marketCurrency).length > 0, 'the walker reports this answer');
  });
}

// ---- the kernel row, in detail (the storefront path on) --------------------------------------------------------

const ON = { mcp: true, currency: true };
const kernel = (sent, n) => door.withFlags(ON, () => door.call('/mcp', 'create_checkout_session', kernelCreate(sent, n)));
const refusedFor = (answer, reason) => {
  assert.equal(answer.isError, true);
  assert.equal(answer.value.error.detail.reason, reason);
  const found = collectAnswerCurrencies(JSON.parse(answer.raw));
  assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []]);
};

test('a seller priced in SGD: SG is priced in SGD with the quote\'s own amounts; US and GB are refused, naming SGD', async () => {
  door.setQuoteCurrency('SGD');
  const sg = await kernel('SG');
  assert.equal(sg.isError, false);
  assertAnswerCurrency(JSON.parse(sg.raw), resolveServingCurrency('SG'), 'SG, a seller priced in SGD');
  assert.equal(sg.value.currency, 'SGD');
  assert.deepEqual(sg.value.totals, { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, 'nothing is converted');
  assert.deepEqual(sg.quotes.map(countryOf), ['SG']);
  for (const market of ['US', 'GB']) {
    const answer = await kernel(market);
    refusedFor(answer, 'seller_not_priced_in_market_currency');
    assert.deepEqual(answer.value.error.detail, { reason: 'seller_not_priced_in_market_currency', market, market_currency: resolveServingCurrency(market), seller_currencies: ['SGD'] });
    assert.deepEqual(answer.quotes.map(countryOf), [market]);
  }
});

test('a market the source has no currency for is refused before any quote, whatever the seller is priced in', async () => {
  for (const [market, sellerCurrency] of [['DE', 'EUR'], ['ZZ', 'USD'], ['ZZ', 'SGD']]) {
    door.setQuoteCurrency(sellerCurrency);
    const answer = await kernel(market);
    refusedFor(answer, 'market_not_priced');
    assert.deepEqual(answer.value.error.detail, { reason: 'market_not_priced', market });
    assert.deepEqual([answer.upstream, answer.quotes, answer.store, answer.gate], [[], [], [], []], `${market}: nothing was read, priced or asked`);
  }
});

test('a market is read in any letter case, and travels upper-cased', async () => {
  door.setQuoteCurrency('SGD');
  const answer = await kernel('sg');
  assert.equal(answer.isError, false);
  assert.equal(answer.value.currency, 'SGD');
  assert.deepEqual(answer.quotes.map(countryOf), ['SG']);
  door.setQuoteCurrency(null);
  refusedFor(await kernel('gb'), 'seller_not_priced_in_market_currency');
  refusedFor(await kernel('de'), 'market_not_priced');
});

test('a session priced for a market reads back in that market\'s currency', async () => {
  door.setQuoteCurrency('SGD');
  const created = await kernel('SG');
  const read = await door.withFlags(ON, () => door.call('/mcp', 'get_checkout_session', { session_id: created.value.session_id }));
  assert.equal(read.isError, false);
  assertAnswerCurrency(JSON.parse(read.raw), 'SGD', 'the re-read');
  assert.equal(read.value.currency, 'SGD');
});

test('buyer intake answers first: a create intake refuses is refused as before, market or not, with no quote', async () => {
  for (const market of ['DE', 'SG', 'US']) {
    const args = kernelCreate(market);
    delete args.quote.customer_email;
    const answer = await door.withFlags(ON, () => door.call('/mcp', 'create_checkout_session', args));
    assert.equal(answer.value.error.detail.reason, 'acp_buyer_email_required', market);
    assert.deepEqual(answer.quotes, []);
  }
});

// A DECIDED BEHAVIOUR, NOT AN OVERSIGHT (owner decision): a create for a merchant Pivota prices itself that names NO
// market stays exactly as it was: answered in the seller's own currency, not judged against any market, and not
// labelled as assumed for one. To revisit when the checkout tools take a REQUIRED market; until then this test is
// the pin, and a change here is a change to that decision.
test('no market named: priced in the seller\'s own currency, nothing assumed, the quote carries no market (as before the rule)', async () => {
  for (const sellerCurrency of ['USD', 'SGD']) {
    door.setQuoteCurrency(sellerCurrency);
    const answer = await kernel(undefined);
    assert.equal(answer.isError, false);
    assert.equal(answer.value.currency, sellerCurrency);
    assert.equal(answer.value.market_assumed, undefined);
    assert.deepEqual(answer.quotes.map(countryOf), [null]);
  }
});

// THE BOUNDS ANSWER FIRST. A cart with two lines for one product and variant is refused on the request alone, as on
// every door, whatever market it names: one this gateway prices (US), one whose currency the seller is not in (SG),
// one it prices nothing in (DE, ZZ), or none. Nothing is read, priced or asked.
for (const market of ['SG', 'DE', 'ZZ', 'US', undefined]) {
  test(`a duplicate line and market ${market || 'none'}: the duplicate-line refusal, with no call anywhere`, async () => {
    const args = kernelCreate(market);
    args.quote.items = [args.quote.items[0], { ...args.quote.items[0], quantity: 2 }];
    const answer = await door.withFlags(ON, () => door.call('/mcp', 'create_checkout_session', args));
    assert.equal(answer.isError, true);
    assert.equal(answer.value.error.detail.reason, 'duplicate_line_for_product_variant');
    assert.deepEqual(answer.value.error.detail.duplicate_lines, [[1, 2]]);
    assert.deepEqual([answer.upstream, answer.quotes, answer.store, answer.gate], [[], [], [], []]);
    const found = collectAnswerCurrencies(JSON.parse(answer.raw));
    assert.deepEqual([found.money, found.priceCurrencies], [[], []]);
  });
}

test('the quote body is the same request as before, plus the market: nothing else is added to it', async () => {
  const strip = (quoteBody) => { const { request_context: rc, ...rest } = quoteBody; const { request_id: _id, country, ...context } = rc; return { ...rest, request_context: context, country: country === undefined ? null : country }; };
  const named = await kernel('US');
  const unnamed = await kernel(undefined);
  assert.deepEqual(strip(named.quotes[0]), { ...strip(unnamed.quotes[0]), country: 'US' });
  assert.equal(JSON.stringify(named.quotes[0]).includes('market_currency'), false, 'the market\'s currency is the gateway\'s own check, not a request to the pricing engine');
  assert.equal(Object.prototype.hasOwnProperty.call(named.quotes[0].request_context, 'currency'), false);
});

test('update_checkout_session takes no market on this door (unchanged), and create says what a named market does', async () => {
  const created = await kernel('US');
  const update = await door.withFlags(ON, () => door.call('/mcp', 'update_checkout_session', {
    idempotency_key: support.idem(nextKey()), session_id: created.value.session_id, market: 'SG',
    quote: { merchant_id: IDS.SELLER_CONNECTED, items: [{ product_id: IDS.SOURCE_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 2 }], customer_email: 'buyer@example.test' },
  }));
  assert.equal(update.value.error.code, 'INVALID_ARGUMENTS');
  assert.deepEqual(update.quotes, []);
  const list = await door.withFlags(ON, () => door.post('/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' }));
  const create = list.body.result.tools.find((tool) => tool.name === 'create_checkout_session');
  const described = create.inputSchema.properties.market.description;
  for (const word of ['seller_not_priced_in_market_currency', 'market_not_priced', 'nothing is converted or relabelled']) assert.ok(described.includes(word), word);
  assert.equal(described.includes('ignored'), false, 'a named market is no longer described as ignored');
});

test('the storefront seller of the fixture is the one the matrix says it is', () => {
  assert.equal(support.CATALOG[IDS.SIG_USD].currency, SELLER_CURRENCY);
  assert.equal(support.STORE_CURRENCY[HOST.A], SELLER_CURRENCY);
});
