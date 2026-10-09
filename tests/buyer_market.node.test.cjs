'use strict';

// Stage 0a: a named market is the BUYER's market (a currency), not a seed partition.
// See src/services/buyerMarket.js for why. The SQL-level proof is
// tests/integration/find_products_multi_buyer_market_postgres.test.js; this file pins the
// resolver and the REST boundary.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { resolveBuyerMarketScope, resolveBuyerBudgetConstraint, resolveServingCurrency, isEnabled, FLAG } = require(path.join(ROOT, 'src/services/buyerMarket'));
const { marketsForRequest } = require(path.join(ROOT, 'src/services/servedMarkets'));
const { extractIntentRuleBased } = require(path.join(ROOT, 'src/findProductsMulti/intent'));

const ON = { [FLAG]: 'on' };

// Peng 2026-09-26: a wrong-currency result is a wrong result. The same rule as the backend seed
// lanes (pivota-backend #2389): silence is US, one priced market is its currency, anything else
// serves nothing. Not behind the flag.
test('serving currency: silence is USD, a priced market is its own currency, anything else is null', () => {
  for (const silent of [undefined, null, '', '   ', false, 0, []]) {
    assert.strictEqual(resolveServingCurrency(silent), 'USD', JSON.stringify(silent));
  }
  for (const [requested, currency] of [['US', 'USD'], [' us ', 'USD'], ['SG', 'SGD'], ['sg', 'SGD'], ['JP', 'JPY'],
    ['KR', 'KRW'], ['GB', 'GBP'], [['SG'], 'SGD']]) {
    assert.strictEqual(resolveServingCurrency(requested), currency, JSON.stringify(requested));
  }
  for (const unpriced of ['ZZ', 'DE', 'EU-DE', 'en-US', 'usa', 'US,SG', 'US SG', ['US', 'SG'], 'x']) {
    assert.strictEqual(resolveServingCurrency(unpriced), null, JSON.stringify(unpriced));
  }
});

test('the serving currency is resolved flag on AND flag off, whatever the partitions', () => {
  for (const env of [{}, ON, { ...ON, CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'US,SG' }]) {
    for (const requested of [undefined, '', 'US', 'SG', 'JP', 'ZZ', 'US,SG', 'en-US']) {
      assert.strictEqual(resolveBuyerMarketScope(requested, env).servingCurrency, resolveServingCurrency(requested),
        `requested=${JSON.stringify(requested)} env=${JSON.stringify(env)}`);
    }
  }
});

test('flag off: every input resolves exactly as marketsForRequest, with no buyer currency', () => {
  for (const requested of [undefined, null, '', '   ', 'SG', 'sg', 'US', 'JP', 'ZZ', 'US,SG', 'en-US', false, ['SG']]) {
    for (const env of [{}, { [FLAG]: 'off' }, { [FLAG]: '' }, { CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'US,JP' }]) {
      assert.deepStrictEqual(
        resolveBuyerMarketScope(requested, env),
        { markets: marketsForRequest(requested, env), buyerMarket: null, buyerCurrency: null, servingCurrency: resolveServingCurrency(requested) },
        `requested=${JSON.stringify(requested)} env=${JSON.stringify(env)}`,
      );
    }
  }
});

test('flag values: on/true/1/yes enable, anything else does not', () => {
  for (const v of ['on', 'ON', 'true', '1', 'yes', ' on ']) assert.strictEqual(isEnabled({ [FLAG]: v }), true, v);
  for (const v of [undefined, '', 'off', 'false', '0', 'enabled']) assert.strictEqual(isEnabled({ [FLAG]: v }), false, String(v));
});

test('SG (the Meitu case): served partitions plus SG, priced in SGD', () => {
  assert.deepStrictEqual(resolveBuyerMarketScope('SG', ON), { markets: ['US', 'SG'], buyerMarket: 'SG', buyerCurrency: 'SGD', servingCurrency: 'SGD' });
  // The door's own parse: case and surrounding whitespace are presentation.
  assert.deepStrictEqual(resolveBuyerMarketScope(' sg ', ON), { markets: ['US', 'SG'], buyerMarket: 'SG', buyerCurrency: 'SGD', servingCurrency: 'SGD' });
});

test('a named SERVED market keeps the scalar bind (one element) and gains its currency', () => {
  assert.deepStrictEqual(resolveBuyerMarketScope('US', ON), { markets: ['US'], buyerMarket: 'US', buyerCurrency: 'USD', servingCurrency: 'USD' });
});

test('a populated non-served partition is KEPT alongside the served list, never swapped out', () => {
  // Prod 2026-09-17: JP holds 331 serving-eligible rows. Binding only ['US'] would delete them.
  assert.deepStrictEqual(resolveBuyerMarketScope('JP', ON), { markets: ['US', 'JP'], buyerMarket: 'JP', buyerCurrency: 'JPY', servingCurrency: 'JPY' });
  const env = { ...ON, CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'US,JP' };
  assert.deepStrictEqual(resolveBuyerMarketScope('JP', env), { markets: ['US', 'JP'], buyerMarket: 'JP', buyerCurrency: 'JPY', servingCurrency: 'JPY' });
});

test('markets[0] is always a served (lane) market when a buyer currency applies', () => {
  for (const code of ['SG', 'US', 'JP', 'GB', 'KR', 'HK', 'AU', 'CA', 'FR', 'SE']) {
    const scope = resolveBuyerMarketScope(code, ON);
    assert.ok(scope.buyerCurrency, code);
    assert.strictEqual(scope.markets[0], 'US', code);
  }
});

test('flag on, but nothing the door can price: partitions unchanged (the serving currency decides what is served)', () => {
  for (const requested of [undefined, null, '', '   ', 'ZZ', 'DE', 'US,SG', 'en-US', false]) {
    assert.deepStrictEqual(
      resolveBuyerMarketScope(requested, ON),
      { markets: marketsForRequest(requested, ON), buyerMarket: null, buyerCurrency: null, servingCurrency: resolveServingCurrency(requested) },
      JSON.stringify(requested),
    );
  }
});

test('a buyer market never relabels a currency explicitly written in the budget', () => {
  for (const [query, currency] of [
    ['lip gloss under USD 25', 'USD'],
    ['lip gloss under EUR 25', 'EUR'],
    ['lip gloss under GBP 25', 'GBP'],
    ['lip gloss under SGD 25', 'SGD'],
    ['lip gloss under S$25', 'SGD'],
    ['lip gloss under $25', 'USD'],
  ]) {
    const parsed = extractIntentRuleBased(query, [], []).hard_constraints.price;
    assert.equal(parsed.currency, currency, query);
    assert.equal(resolveBuyerBudgetConstraint({
      constraint: parsed, buyerCurrency: 'SGD', queryCurrency: parsed.currency,
    }).currency, currency, query);
  }
  const unstated = extractIntentRuleBased('lip gloss under 25', [], []).hard_constraints.price;
  assert.equal(resolveBuyerBudgetConstraint({ constraint: unstated, buyerCurrency: 'SGD' }).currency, 'SGD');
  assert.equal(resolveBuyerBudgetConstraint({ constraint: unstated, buyerCurrency: 'SGD', callerCurrency: 'EUR' }).currency, 'EUR');
  assert.equal(resolveBuyerBudgetConstraint({ constraint: unstated, buyerCurrency: null }), unstated);
});

test('REST boundary: `serving_market` is the same buyer market (the backend proxies the discovery hop here); `market` wins when both are sent; neither without the flag', () => {
  const { buildFindProductsMultiPayloadFromQuery } = require('../src/server')._debug;
  const prev = process.env.FIND_PRODUCTS_BUYER_MARKET;
  try {
    process.env.FIND_PRODUCTS_BUYER_MARKET = 'off';
    assert.equal('market' in (buildFindProductsMultiPayloadFromQuery({ query: 'serum', serving_market: 'SG' }).search || {}), false);
    process.env.FIND_PRODUCTS_BUYER_MARKET = 'on';
    assert.strictEqual(buildFindProductsMultiPayloadFromQuery({ query: 'serum', serving_market: 'SG' }).search.market, 'SG');
    assert.strictEqual(buildFindProductsMultiPayloadFromQuery({ query: 'serum', market: 'US', serving_market: 'SG' }).search.market, 'US');
    assert.equal('market' in buildFindProductsMultiPayloadFromQuery({ query: 'serum' }).search, false);
  } finally {
    if (prev === undefined) delete process.env.FIND_PRODUCTS_BUYER_MARKET; else process.env.FIND_PRODUCTS_BUYER_MARKET = prev;
  }
});

test('REST boundary: `market` reaches search.market only under the flag', () => {
  const prior = process.env[FLAG];
  const { buildFindProductsMultiPayloadFromQuery } = require(path.join(ROOT, 'src/server'))._debug;
  try {
    delete process.env[FLAG];
    const off = buildFindProductsMultiPayloadFromQuery({ query: 'lip gloss', market: 'SG', catalog_surface: 'beauty' });
    assert.strictEqual('market' in off.search, false);
    // Flag off, the whole payload is what it was: nothing but `market` differs from a request without it.
    assert.deepStrictEqual(off, buildFindProductsMultiPayloadFromQuery({ query: 'lip gloss', catalog_surface: 'beauty' }));

    process.env[FLAG] = 'on';
    const on = buildFindProductsMultiPayloadFromQuery({ query: 'lip gloss', market: 'SG', catalog_surface: 'beauty' });
    assert.strictEqual(on.search.market, 'SG');
    // Verbatim: the door parses it, the boundary does not re-derive it.
    assert.strictEqual(buildFindProductsMultiPayloadFromQuery({ query: 'x', market: ' sg' }).search.market, 'sg');
    assert.strictEqual('market' in buildFindProductsMultiPayloadFromQuery({ query: 'x', market: '  ' }).search, false);
    assert.strictEqual('market' in buildFindProductsMultiPayloadFromQuery({ query: 'x' }).search, false);
    assert.strictEqual(buildFindProductsMultiPayloadFromQuery({ query: 'x', market: ['SG', 'US'] }).search.market, 'SG');
  } finally {
    if (prior === undefined) delete process.env[FLAG]; else process.env[FLAG] = prior;
  }
});

test('live search price never overlays an already budget-filtered result for parsed prose or structured bounds', async () => {
  const prior = process.env.SERVE_LIVE_MERCHANT_PRICE;
  const { maybeOverlayLiveSearchPrice } = require(path.join(ROOT, 'src/server'))._debug;
  const response = { products: [], metadata: { query_source: 'beauty_external_seed_mainline' } };
  try {
    process.env.SERVE_LIVE_MERCHANT_PRICE = 'on';
    for (const query of [
      'lip gloss at most SGD 29', 'lip gloss up to 29', 'lip gloss 29元以下',
      'lip gloss <=29', 'lip gloss under 29', 'lip gloss from 20 to 29',
    ]) {
      const result = await maybeOverlayLiveSearchPrice(response, { query });
      assert.strictEqual(result.metadata.live_merchant_price.skipped_reason, 'budget_constraint', query);
      assert.strictEqual(result.metadata.live_merchant_price.attempted, false, query);
    }
    const structured = await maybeOverlayLiveSearchPrice(response, { query: 'lip gloss', min_price: 20, max_price: 29 });
    assert.strictEqual(structured.metadata.live_merchant_price.skipped_reason, 'budget_constraint');
    assert.strictEqual(await maybeOverlayLiveSearchPrice(response, { query: 'lip gloss' }), response);
  } finally {
    if (prior === undefined) delete process.env.SERVE_LIVE_MERCHANT_PRICE;
    else process.env.SERVE_LIVE_MERCHANT_PRICE = prior;
  }
});

// #2295 introduced the silent-request default as its own helper; it is now resolveServingCurrency's
// silent branch, so one function owns the rule. The deployment's default is servedMarkets()[0].
test('the silent default is the deployment\'s default market, whatever the flag', () => {
  for (const env of [{}, ON, { [FLAG]: 'off' }]) {
    for (const requested of [undefined, null, '', '   ', false]) {
      assert.strictEqual(resolveServingCurrency(requested, env), 'USD', `requested=${JSON.stringify(requested)}`);
    }
  }
  assert.strictEqual(resolveServingCurrency(undefined, { CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'SG,US' }), 'SGD');
  assert.strictEqual(resolveServingCurrency(undefined, { CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'US,JP' }), 'USD');
  // A named market never falls back to the default -- 'en-US' and 'usa' are markets no currency is
  // known for (as #2389 reads them), not silence.
  for (const requested of ['en-US', 'usa', 'ZZ', 'US,SG']) {
    assert.strictEqual(resolveServingCurrency(requested, { CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'SG,US' }), null, requested);
  }
  assert.strictEqual(resolveServingCurrency('US', { CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'SG,US' }), 'USD');
});
