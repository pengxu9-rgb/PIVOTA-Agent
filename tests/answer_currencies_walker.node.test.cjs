'use strict';

// THE ANSWER-CURRENCY WALKER ITSELF (tests/_support/answerCurrencies.cjs): the check every priced path's tests share.
// One case per thing it must see. The cases marked BLIND SPOT are answers an earlier version of the walker passed
// as clean; each one states a price in another currency than the market's (or with none), and must be reported.

const test = require('node:test');
const assert = require('node:assert/strict');

const walker = require('./_support/answerCurrencies.cjs');

const { collectAnswerCurrencies, answerCurrencyProblems, assertAnswerCurrency, textMoneyOf, isMoneyKey, textCurrencyIs } = walker;

const problems = (answer, currency = 'GBP') => answerCurrencyProblems(answer, currency);
const clean = (answer, currency = 'GBP') => assert.deepEqual(problems(answer, currency), []);

// ---- what it always saw ------------------------------------------------------------------------------------------

test('a priced answer in the market\'s currency keeps the rule; the same answer for another market does not', () => {
  const answer = { currency: 'GBP', line_items: [{ item: { id: 'p1', price: 2000 }, totals: [{ type: 'total', amount: 2000 }] }], totals: [{ type: 'total', amount: 2000 }] };
  clean(answer, 'GBP');
  assert.deepEqual(problems(answer, 'USD'), ["$.currency is GBP, the market's currency is USD"]);
  assert.deepEqual(problems(answer, null), ['$.currency states GBP for a market that has no currency', 'a price is quoted ($.line_items[0].item.price) for a market that has no currency']);
});

test('an answer with no price keeps the rule for any market, and for none', () => {
  const refusal = { error: { code: 'NO_MERCHANT_OFFER', message: 'No price can be stated for a buyer in GB.', detail: { reason: 'market_not_priced', market: 'GB' } } };
  clean(refusal, 'GBP');
  clean(refusal, null);
});

test('the exports a caller had before are still there, and what they return still has the same members', () => {
  const found = assertAnswerCurrency({ currency: 'GBP', price: 5, market_currency: 'GBP' }, 'GBP');
  assert.deepEqual(found.priceCurrencies, [{ path: '$.currency', value: 'GBP' }]);
  assert.deepEqual(found.money.map(({ path, value }) => ({ path, value })), [{ path: '$.price', value: 5 }]);
  assert.deepEqual(found.otherCurrencyMentions, [{ path: '$.market_currency', value: 'GBP' }]);
  assert.throws(() => assertAnswerCurrency({ currency: 'USD', price: 5 }, 'GBP', 'cell'), /^Error: cell: \$\.currency is USD, the market's currency is GBP$/);
});

// ---- BLIND SPOT 1: a subtree under a `*currenc*` member ------------------------------------------------------------

test('BLIND SPOT 1: a price under a member whose name contains "currenc" is walked, and is a price', () => {
  const answer = { seller_currency_info: { price: 12, currency: 'USD' } };
  assert.deepEqual(problems(answer), ["$.seller_currency_info.currency is USD, the market's currency is GBP"]);
  const found = collectAnswerCurrencies(answer);
  assert.deepEqual(found.money, [{ path: '$.seller_currency_info.price', value: 12, currency: 'USD', currencyPath: '$.seller_currency_info.currency' }]);
  // ... at any depth, and in arrays under it.
  assert.equal(problems({ currencies_offered: [{ rows: [{ unit_price: 3, currency_code: 'EUR' }] }] }).length, 1);
});

test('a mention is still a mention: reported as one, with the codes it names, and never judged as a price', () => {
  // What real answers carry: what a guard dropped or withheld, a fill diagnostic, the market's and the seller's currency.
  const answer = {
    products: [{ product_id: 'p1', price: 20, currency: 'GBP' }],
    total: 1,
    metadata: {
      serving_currency_guard: { serving_currency: 'GBP', dropped_count: 2, dropped_currencies: ['USD', 'SGD'], withheld_currencies: ['USD'] },
      price_currency_fill: { filled: 3, missed: 1 },
    },
    market_currency: 'GBP',
    seller_currencies: ['USD'],
  };
  clean(answer, 'GBP');
  const found = collectAnswerCurrencies(answer);
  assert.deepEqual(found.priceCurrencies, [{ path: '$.products[0].currency', value: 'GBP' }], 'the one served price, and only it');
  assert.deepEqual(found.currencyMentions, [
    { path: '$.metadata.serving_currency_guard', currencies: [] },
    { path: '$.metadata.serving_currency_guard.serving_currency', currencies: ['GBP'] },
    { path: '$.metadata.serving_currency_guard.dropped_currencies', currencies: ['USD', 'SGD'] },
    { path: '$.metadata.serving_currency_guard.withheld_currencies', currencies: ['USD'] },
    { path: '$.metadata.price_currency_fill', currencies: [] },
    { path: '$.market_currency', currencies: ['GBP'] },
    { path: '$.seller_currencies', currencies: ['USD'] },
  ]);
  assert.deepEqual(found.otherCurrencyMentions.map((m) => m.path), found.currencyMentions.map((m) => m.path), 'the same members, raw and as codes');
  assert.deepEqual(found.otherCurrencyMentions[2].value, ['USD', 'SGD']);
  // A caller can ask the one question that matters: was USD SERVED, or only NAMED?
  const served = new Set([...found.priceCurrencies.map((c) => c.value), ...found.money.map((m) => m.currency), ...found.textMoney.map((t) => t.currency)]);
  const named = new Set(found.currencyMentions.flatMap((m) => m.currencies));
  assert.deepEqual([served.has('USD'), named.has('USD')], [false, true]);
});

test('a diagnostic that itself states a price is a price: the guard\'s list is a mention, a price beside it is not', () => {
  const answer = { metadata: { serving_currency_guard: { withheld_currencies: ['USD'], example: { price: 9, currency: 'USD' } } } };
  assert.deepEqual(problems(answer), ["$.metadata.serving_currency_guard.example.currency is USD, the market's currency is GBP"]);
  assert.deepEqual(collectAnswerCurrencies(answer).currencyMentions.map((m) => m.currencies), [[], ['USD']]);
});

// ---- BLIND SPOT 2: currencyCode ----------------------------------------------------------------------------------

test('BLIND SPOT 2: `currencyCode` labels a price', () => {
  const answer = { cost: { amount: '12.00', currencyCode: 'USD' } };
  assert.deepEqual(problems(answer), ["$.cost.currencyCode is USD, the market's currency is GBP"]);
  assert.deepEqual(collectAnswerCurrencies(answer).otherCurrencyMentions, [], 'it is a price label, not a mention');
  clean({ cost: { amount: '12.00', currencyCode: 'GBP' } });
  for (const key of ['currency', 'Currency', 'currency_code', 'CURRENCY_CODE', 'currencyCode', 'price_currency', 'priceCurrency']) {
    assert.equal(problems({ price: 1, [key]: 'USD' }).length, 1, key);
  }
});

// ---- BLIND SPOT 3: a currency given as an object -------------------------------------------------------------------

test('BLIND SPOT 3: a currency given as an object is read', () => {
  for (const key of ['code', 'currency_code', 'currencyCode', 'iso_code', 'isoCode']) {
    const answer = { price: 12, currency: { [key]: 'USD', symbol: 'x' } };
    assert.deepEqual(problems(answer), ["$.currency is USD, the market's currency is GBP"], key);
    assert.deepEqual(collectAnswerCurrencies(answer).money[0].currency, 'USD', key);
  }
  clean({ price: 12, currency: { code: 'GBP' } });
});

test('a currency object no code can be read from breaks the rule: an unreadable currency is not the market\'s', () => {
  const answer = { price: 12, currency: { name: 'pound' } };
  assert.deepEqual(problems(answer), ['$.currency labels a price with a currency that cannot be read', 'a price is quoted ($.price) with no currency beside it']);
  assert.deepEqual(collectAnswerCurrencies(answer).unreadableCurrencies, [{ path: '$.currency', value: { name: 'pound' } }]);
});

// ---- BLIND SPOT 4: money in free text ------------------------------------------------------------------------------

test('BLIND SPOT 4: money written in free text is seen, wherever the string is', () => {
  const cases = [
    ['$12.00', '$'], ['US$12', 'USD'], ['US$ 12', 'USD'], ['S$12', 'SGD'], ['£5', 'GBP'], ['€ 9,50', 'EUR'], ['¥1200', '¥'],
    ['USD 12', 'USD'], ['USD12', 'USD'], ['12 USD', 'USD'], ['12.00USD', 'USD'], ['Total: 12 SGD today', 'SGD'], ['from EUR 9', 'EUR'],
  ];
  for (const [text, currency] of cases) {
    assert.deepEqual(textMoneyOf(text).map((t) => t.currency), [currency], text);
  }
  // In an answer: a display string beside a correctly labelled price, a message, an array of notes.
  assert.deepEqual(problems({ currency: 'GBP', totals: [{ amount: 1200, display_text: 'Total $12.00' }] }), ["$.totals[0].display_text states money in text as $12.00, the market's currency is GBP"]);
  assert.deepEqual(problems({ error: { message: 'It costs USD 12 at the seller.' } }), ["$.error.message states money in text as USD 12, the market's currency is GBP"]);
  assert.deepEqual(problems({ notes: ['fine', 'was 12 USD'] }), ["$.notes[1] states money in text as 12 USD, the market's currency is GBP"]);
  assert.deepEqual(problems({ note: 'Total £12' }, null), ['$.note states money in text (£12) for a market that has no currency']);
});

test('text in the market\'s currency keeps the rule; an ambiguous sign is accepted only for the currencies it can mean', () => {
  clean({ note: 'Total £12, or GBP 12' }, 'GBP');
  clean({ note: 'Total $12' }, 'USD');
  clean({ note: 'Total $12' }, 'SGD');
  assert.equal(problems({ note: 'Total $12' }, 'GBP').length, 1);
  assert.equal(problems({ note: 'Total US$12' }, 'SGD').length, 1, 'US$ is never an SGD price');
  assert.equal(problems({ note: 'Total S$12' }, 'USD').length, 1);
  clean({ note: '¥1200' }, 'JPY');
  assert.equal(problems({ note: '¥1200' }, 'USD').length, 1);
});

test('what free text is NOT read as money (documented in the walker): words, a code with no number, product words, identifiers and links', () => {
  for (const text of [
    'priced in USD, and a price for GB must be in GBP', 'twelve dollars', '12 pounds', 'SPF 50', 'TOP 10 picks', 'Eye GEL 15ml', 'TRY 3 times',
    'ALL 4 shades', 'expires 2026-01-15T10:00:00.000Z', 'gid://shopify/ProductVariant/44000000000001', '50% off', 'USDA 12', '12 USDT',
  ]) {
    assert.deepEqual(textMoneyOf(text), [], text);
  }
  // A member that is an identifier or a link by name is not scanned: an opaque id can contain any letters.
  clean({ id: 'esc_x-USD12', continue_url: 'https://store-a.example/c?p=USD12', cart_token: '-GBP9-USD1', line_items: [{ variant_ids: ['$12'] }] }, 'GBP');
  assert.equal(problems({ title: 'esc_x-USD12' }).length, 1, 'the same text in a member that is not an id is read');
});

test('a string that is itself JSON (a tool result\'s content text) is parsed and walked', () => {
  const body = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ currency: 'USD', totals: [{ amount: 5 }] }) }, { type: 'text', text: JSON.stringify({ note: 'or $5' }) }] } };
  assert.deepEqual(problems(body), [
    "$.result.content[0].text<json>.currency is USD, the market's currency is GBP",
    "$.result.content[1].text<json>.note states money in text as $5, the market's currency is GBP",
  ]);
});

// ---- BLIND SPOT 5: `price_amount`-style members, paired with their currency ---------------------------------------

test('BLIND SPOT 5: `price_amount`-style members are amounts, each paired with the currency in its scope', () => {
  // A bare amount under a name the walker did not know, beside nothing: a price with no currency.
  assert.deepEqual(problems({ offers: [{ price_amount: 12 }] }), ['a price is quoted ($.offers[0].price_amount) with no currency beside it']);
  assert.deepEqual(problems({ current_price: 12 }), ['a price is quoted ($.current_price) with no currency beside it']);
  // Paired with its sibling currency.
  const found = collectAnswerCurrencies({ offers: [{ price_amount: 12, price_currency: 'USD' }, { price_amount: 9, price_currency: 'GBP' }] });
  assert.deepEqual(found.money, [
    { path: '$.offers[0].price_amount', value: 12, currency: 'USD', currencyPath: '$.offers[0].price_currency' },
    { path: '$.offers[1].price_amount', value: 9, currency: 'GBP', currencyPath: '$.offers[1].price_currency' },
  ]);
  for (const key of ['price_amount', 'priceAmount', 'current_price', 'currentPrice', 'original_price', 'anchor_price_amount', 'unit_price_effective_amount', 'shipping_fee', 'amount_total', 'total_price']) {
    assert.equal(isMoneyKey(key), true, key);
  }
  for (const key of ['price_ratio', 'price_as_of', 'price_source', 'total_count', 'strict_total', 'quantity', 'count', 'dropped_count']) assert.equal(isMoneyKey(key), false, key);
});

test('an unlabelled amount is reported even when ANOTHER row of the same answer is labelled', () => {
  // Before: "a price with no currency" was reported only when the whole answer had no label at all.
  const answer = { offers: [{ price: 20, currency: 'GBP' }, { price: 15 }] };
  assert.deepEqual(problems(answer), ['a price is quoted ($.offers[1].price) with no currency beside it']);
  // An amount takes the nearest label above it: a line under a labelled checkout is labelled.
  clean({ currency: 'GBP', line_items: [{ item: { price: 5 }, totals: [{ amount: 5 }] }] });
  // ... the NEAREST one: a row's own label wins over the page's, whatever the member order.
  const nested = collectAnswerCurrencies({ currency: 'GBP', rows: [{ price: 5, currency: 'USD' }] });
  assert.equal(nested.money[0].currency, 'USD');
});

// ---- a row count is not money ------------------------------------------------------------------------------------

test('`total` beside a page of rows is a row count, not a price with no currency', () => {
  for (const sibling of ['products', 'page', 'page_size', 'returned', 'has_next_page']) {
    const answer = { [sibling]: sibling === 'products' ? [] : 1, total: 0 };
    clean(answer, 'GBP');
    clean(answer, null);
    assert.deepEqual(collectAnswerCurrencies(answer).counts, [{ path: '$.total', value: 0 }], sibling);
    assert.deepEqual(collectAnswerCurrencies(answer).money, [], sibling);
  }
  // A real search page: priced rows, and a count.
  clean({ products: [{ product_id: 'p1', price: 20, currency: 'GBP' }], total: 1, page: 1, page_size: 20 }, 'GBP');
  // Elsewhere `total` is money, as before: a cart total with no currency is a price with no currency.
  assert.deepEqual(problems({ total: 12 }), ['a price is quoted ($.total) with no currency beside it']);
  assert.deepEqual(problems({ pricing: { subtotal: 10, total: 12 } }).length, 2);
  // A count does not hide a price beside it.
  assert.deepEqual(problems({ products: [{ price: 5 }], total: 1 }), ['a price is quoted ($.products[0].price) with no currency beside it']);
});

// ---- escapes closed after review -----------------------------------------------------------------------------------

test('ESCAPE (a): a prefixed dollar sign is its own currency, never a bare `$` and never a shorter prefix', () => {
  const cases = [['CA$5', 'CAD'], ['R$ 9', 'BRL'], ['MX$10', 'MXN'], ['NT$100', 'TWD'], ['AU$7', 'AUD'], ['C$5', 'CAD'], ['A$5', 'AUD'], ['HK$8', 'HKD'], ['NZ$8', 'NZD'], ['US$8', 'USD'], ['S$8', 'SGD']];
  for (const [text, currency] of cases) {
    assert.deepEqual(textMoneyOf(`from ${text} each`), [{ currency, match: text }], text);
  }
  // Before: CA$ read as A$ (AUD); R$, MX$, NT$, AU$ read as a bare `$`, which a USD answer accepts.
  for (const text of ['CA$5', 'R$5', 'MX$5', 'NT$5', 'AU$5']) {
    assert.equal(answerCurrencyProblems({ note: `Total ${text}` }, 'USD').length, 1, `${text} is not a USD price`);
  }
  assert.deepEqual(answerCurrencyProblems({ note: 'Total CA$5' }, 'CAD'), []);
  assert.equal(answerCurrencyProblems({ note: 'Total CA$5' }, 'AUD').length, 1, 'CA$ is not AUD');
  // A prefix this file has no currency for is reported as written, and is no market's currency (not even a dollar one).
  assert.deepEqual(textMoneyOf('XY$5'), [{ currency: 'XY$', match: 'XY$5' }]);
  for (const market of ['USD', 'SGD', 'AUD', 'CAD']) assert.equal(answerCurrencyProblems({ note: 'XY$5' }, market).length, 1, market);
  // A bare `$` is still a bare `$`.
  assert.deepEqual(textMoneyOf('Total $5'), [{ currency: '$', match: '$5' }]);
});

test('ESCAPE (b): a label object that names a code is still walked: a price inside it is a price', () => {
  const answer = { currency: { code: 'GBP', price: { amount: 10, currency: 'USD' } } };
  assert.deepEqual(answerCurrencyProblems(answer, 'GBP'), ["$.currency.price.currency is USD, the market's currency is GBP"]);
  const found = collectAnswerCurrencies(answer);
  assert.deepEqual(found.priceCurrencies, [{ path: '$.currency', value: 'GBP' }, { path: '$.currency.price.currency', value: 'USD' }]);
  assert.deepEqual(found.money, [{ path: '$.currency.price.amount', value: 10, currency: 'USD', currencyPath: '$.currency.price.currency' }]);
  // The member that named the code is not counted a second time, whatever it is called.
  for (const key of ['code', 'currency_code', 'currencyCode', 'iso_code', 'isoCode']) {
    assert.deepEqual(collectAnswerCurrencies({ price: 1, currency: { [key]: 'GBP', note: 'x' } }).priceCurrencies, [{ path: '$.currency', value: 'GBP' }], key);
  }
  // Text inside a label object is scanned too.
  assert.equal(answerCurrencyProblems({ currency: { code: 'GBP', display: 'US$10' } }, 'GBP').length, 1);
});

test('ESCAPE (c): price-currency-code spellings label a price, so a line labelled that way is judged on its own label', () => {
  for (const key of ['priceCurrencyCode', 'price_currency_code', 'currency-code', 'Currency-Code', 'ccy', 'CCY', 'settlement_currency', 'settlementCurrency']) {
    // A USD line under a GBP checkout: before, the line's amount took the checkout's GBP and passed.
    const answer = { currency: 'GBP', line_items: [{ price: 5, [key]: 'USD' }] };
    assert.deepEqual(answerCurrencyProblems(answer, 'GBP'), [`$.line_items[0].${key} is USD, the market's currency is GBP`], key);
    const found = collectAnswerCurrencies(answer);
    assert.deepEqual([found.money[0].currency, found.money[0].currencyPath], ['USD', `$.line_items[0].${key}`], key);
    assert.deepEqual(found.otherCurrencyMentions, [], `${key} is a price label, not a mention`);
    assert.deepEqual(answerCurrencyProblems({ currency: 'GBP', line_items: [{ price: 5, [key]: 'GBP' }] }, 'GBP'), [], key);
  }
});

test('ESCAPE (c): an EMPTY label is "no label here" and stops inheritance: the amount beside it has no currency', () => {
  // THE RULE: an object whose only price-label members are empty says its own money has no currency. Its amounts,
  // and those below it down to the next real label, never take the label of an object further out.
  for (const empty of ['', '   ', null, true, 0, 12, { name: 'pound' }, []]) {
    const answer = { currency: 'GBP', line_items: [{ price: 5, currency: empty, totals: [{ amount: 5 }] }] };
    const label = JSON.stringify(empty);
    const found = collectAnswerCurrencies(answer);
    assert.deepEqual(found.money.map((m) => [m.path, m.currency]), [['$.line_items[0].price', null], ['$.line_items[0].totals[0].amount', null]], label);
    const problems = answerCurrencyProblems(answer, 'GBP').filter((line) => /no currency beside it/.test(line));
    assert.deepEqual(problems, ['a price is quoted ($.line_items[0].price) with no currency beside it', 'a price is quoted ($.line_items[0].totals[0].amount) with no currency beside it'], label);
  }
  // A real label below the empty one labels again; a sibling line is untouched; an absent label still inherits.
  const mixed = collectAnswerCurrencies({ currency: 'GBP', line_items: [{ price: 1, currency: '', offer: { price: 2, currency: 'GBP' } }, { price: 3 }] });
  assert.deepEqual(mixed.money.map((m) => m.currency), [null, 'GBP', 'GBP']);
  // Two label members on one object: the readable one is the label.
  assert.deepEqual(answerCurrencyProblems({ price: 5, currency: '', currency_code: 'GBP' }, 'GBP'), []);
  // An empty label beside NO amount is not a problem: an unpriced row says `price: null, currency: null`.
  assert.deepEqual(answerCurrencyProblems({ currency: 'GBP', product: { price: null, currency: null, title: 'x' } }, 'GBP'), []);
  assert.deepEqual(answerCurrencyProblems({ product: { price: null, currency: null } }, null), []);
});

test('`textCurrencyIs` is exported as a function: "is money written like this money in that market\'s currency"', () => {
  assert.equal(typeof textCurrencyIs, 'function');
  // ISO codes: only themselves.
  assert.deepEqual([textCurrencyIs('GBP', 'GBP'), textCurrencyIs('USD', 'GBP')], [true, false]);
  // The ambiguous signs, as `textMoneyOf` reports them.
  const dollar = ['USD', 'SGD', 'AUD', 'CAD', 'HKD', 'NZD', 'TWD'];
  for (const market of dollar) assert.equal(textCurrencyIs('$', market), true, market);
  for (const market of ['GBP', 'EUR', 'JPY', 'CNY', 'MXN', 'BRL']) assert.equal(textCurrencyIs('$', market), false, market);
  assert.deepEqual(['JPY', 'CNY', 'USD', 'KRW'].map((market) => textCurrencyIs('¥', market)), [true, true, false, false]);
  // No currency, an unknown spelling, a market with none, an inherited property name: never.
  for (const [currency, market] of [['XY$', 'USD'], ['', 'USD'], [null, 'USD'], ['USD', null], ['USD', ''], ['$', null], ['$', 'usd'], ['toString', 'USD'], ['constructor', 'USD'], [null, null], [undefined, undefined], ['', ''], ['usd', 'usd'], ['$', '$']]) {
    assert.equal(textCurrencyIs(currency, market), false, JSON.stringify([currency, market]));
  }
  // It is the rule the walker itself applies, and it cannot be edited through the export.
  assert.equal(textCurrencyIs(textMoneyOf('$5')[0].currency, 'SGD'), true);
  assert.equal(textCurrencyIs(textMoneyOf('US$5')[0].currency, 'SGD'), false);
  assert.deepEqual(Object.keys(walker).sort(), ['answerCurrencyProblems', 'assertAnswerCurrency', 'collectAnswerCurrencies', 'isMoneyKey', 'textCurrencyIs', 'textMoneyOf']);
  assert.ok(Object.values(walker).every((value) => typeof value === 'function'), 'only functions are exported: no shared set a caller could edit');
});

test('stated limits stay stated: what the header says is not read, is not read (so a change here is a decision)', () => {
  for (const key of ['amount_minor', 'price_cents', 'total_cents', 'line_total', 'grand_total', 'value', 'discount', 'savings', 'msrp', 'prices']) assert.equal(isMoneyKey(key), false, key);
  for (const text of ['12usd', 'Usd 12', '12 €', '12$', 'USD 12', '￥1200']) assert.deepEqual(textMoneyOf(text), [], text);
  assert.deepEqual(collectAnswerCurrencies({ prices: [12, 15], by_currency_map: { USD: 12 }, pair: [12, 'USD'], price_text: '1,299.00' }).money, []);
});

// ---- robustness ----------------------------------------------------------------------------------------------------

test('cycles are not followed, and non-objects are fine', () => {
  const a = { currency: 'GBP', price: 1 };
  a.self = a;
  clean(a);
  for (const v of [null, undefined, 5, true, [], {}]) clean(v);
  assert.deepEqual(problems('costs $5'), ["$ states money in text as $5, the market's currency is GBP"]);
});
