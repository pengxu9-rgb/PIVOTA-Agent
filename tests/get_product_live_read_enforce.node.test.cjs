'use strict';

// UCP_LIVE_PRODUCT_READ=enforce READINESS (PR-5, verified-price design section 3: "on any non-verified outcome the
// stored product is served with `live_read` explaining why"). Every outcome the agent get_product read can
// reach, on the product shape the real detail lane serves (src/server.js normalizePdpV2ToProductDetail: a
// scalar headline price, variant prices under price.current). For each non-verified outcome the served product
// is the stored one, byte for byte, plus `live_read`: no price is dropped, blanked or re-dated.
//
// And price_verification_served (src/observability/priceVerificationFacts): a get_product price is `live` only
// when this request's read re-priced the HEADLINE, `stored` otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');

// The readers' deadline timers are unref'd (right in prod); keep the loop alive for the file's duration.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(keepAlive));

const { createUcpLiveProductReader, STATUS } = require('../src/services/ucpLiveOfferRead');
const { priceFactsOf } = require('../src/observability/priceVerificationFacts');
const { classifyFact, TTL_MS } = require('../src/observability/priceVerificationLog');

const NOW = Date.parse('2026-10-27T09:00:00.000Z');
const ROSE = '43734829564039';
const PLUM = '43734829564040';
const gid = (id) => `gid://shopify/ProductVariant/${id}`;

/** The stored get_product result, as the unscoped detail lane hands it to the reader. */
function storedResult(extra = {}) {
  return {
    product: {
      product_id: 'sig_pr5_tint',
      title: 'Tint',
      brand: 'Brand T',
      price: 25,
      currency: 'USD',
      availability: 'in_stock',
      in_stock: true,
      destination_url: 'https://store.pr5.test/products/tint',
      default_variant_id: ROSE,
      variants: [
        { variant_id: ROSE, title: 'Rose', price: { current: { amount: 25, currency: 'USD' } }, availability: { in_stock: true } },
        { variant_id: PLUM, title: 'Plum', price: { current: { amount: 27, currency: 'USD' } }, availability: { in_stock: true } },
      ],
      ...extra,
    },
  };
}

const answer = (payload) => ({ ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
const variantAnswer = (id, minor, currency, available = true) => ({ id: gid(id), price: { amount: minor, currency }, availability: { available } });

/** A merchant client. `lookup(ids, country)` returns the tool answer, throws, or never settles. */
function client({ discover, lookup } = {}) {
  const calls = [];
  return {
    calls,
    async discoverEndpoint(base) {
      calls.push(['discover', base]);
      return discover ? discover(base) : { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 };
    },
    async lookupCatalog(endpoint, { ids, context }) {
      calls.push(['lookup', ids.length, context.address_country]);
      return lookup(ids, context.address_country);
    },
  };
}
const merchantAnswers = (variants) => () => answer({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants }], messages: [] });

function enforceReader(ucpClient, { log, budgetMs } = {}) {
  return createUcpLiveProductReader({
    ucpClient,
    mode: 'enforce',
    now: () => NOW,
    log: log || (() => {}),
    ...(budgetMs ? { budgetMs } : {}),
  });
}

/** The served product must be the stored one exactly, plus `live_read`. */
function assertStoredServed(out, stored, label) {
  assert.ok(out && out.product, `${label}: a product is served`);
  const { live_read: lr, ...rest } = out.product;
  assert.deepEqual(rest, stored.product, `${label}: the stored product, unchanged (price ${stored.product.price} ${stored.product.currency})`);
  assert.equal(out.product.price, 25, `${label}: the price is never dropped or blanked`);
  assert.equal(out.product.price_as_of, undefined, `${label}: an unread price is never dated`);
  assert.ok(lr && typeof lr === 'object', `${label}: live_read explains why it was not verified`);
  assert.notEqual(lr.status, STATUS.VERIFIED, label);
  assert.equal(lr.source, 'merchant_ucp_lookup_catalog');
  assert.equal(lr.checked_at, new Date(NOW).toISOString());
  return lr;
}

// ------------------------------------------------------------------------------------- every non-verified outcome

const OUTCOMES = [
  {
    name: 'no_market: no declared market, nothing is asked',
    ctx: {},
    expect: { status: STATUS.SKIPPED, reason: 'no_market', market: null },
    calls: 0,
  },
  {
    name: 'market_not_priced: a market Pivota does not price is refused, never swapped',
    ctx: { market: 'ZZ' },
    expect: { status: STATUS.SKIPPED, reason: 'market_not_priced', market: null, market_basis: 'declared' },
    calls: 0,
  },
  {
    name: 'no_host: no merchant page to ask',
    result: () => storedResult({ destination_url: null }),
    ctx: { market: 'US' },
    expect: { status: STATUS.SKIPPED, reason: 'no_host', market: 'US' },
    calls: 0,
  },
  {
    name: 'too_many_variants_to_reprice: another currency needs every variant read, one has no id',
    result: () => {
      const r = storedResult();
      r.product.variants = [...r.product.variants, { variant_id: 'shade-3', title: 'Coral', price: { current: { amount: 26, currency: 'USD' } } }];
      return r;
    },
    ctx: { market: 'SG' },
    expect: { status: STATUS.SKIPPED, reason: 'too_many_variants_to_reprice', market: 'SG' },
    calls: 0,
  },
  {
    name: 'not_ucp: the store answered with no UCP endpoint',
    client: () => client({ discover: () => ({ mcpEndpoint: null, status: 404 }), lookup: () => assert.fail('never looked up') }),
    ctx: { market: 'US' },
    expect: { status: STATUS.NOT_UCP, market: 'US' },
    calls: 1,
  },
  {
    name: 'timeout: the merchant does not answer within the budget',
    client: () => client({ lookup: () => new Promise(() => {}) }),
    ctx: { market: 'US' },
    budgetMs: 40,
    realClock: true,
    expect: { status: STATUS.TIMEOUT, market: 'US', reason: 'timeout' },
    calls: 2,
  },
  {
    name: 'error: the lookup throws',
    client: () => client({ lookup: () => { throw Object.assign(new Error('socket hang up'), { status: 502 }); } }),
    ctx: { market: 'US' },
    expect: { status: STATUS.ERROR, market: 'US', reason: 'socket hang up' },
    calls: 2,
  },
  {
    name: 'error: discovery failed transiently (503), which is not "not UCP"',
    client: () => client({ discover: () => ({ mcpEndpoint: null, status: 503 }), lookup: () => assert.fail('never looked up') }),
    ctx: { market: 'US' },
    expect: { status: STATUS.ERROR, market: 'US', reason: 'discovery_503' },
    calls: 1,
  },
  {
    name: 'error: a 200 whose answer is a merchant error (with a price in it)',
    client: () => client({ lookup: () => answer({
      ucp: { status: 'error' },
      products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [variantAnswer(ROSE, 100, 'USD')] }],
      messages: [{ type: 'error', code: 'rate_limited' }],
    }) }),
    ctx: { market: 'US' },
    expect: { status: STATUS.ERROR, market: 'US', reason: 'merchant_error' },
    calls: 2,
  },
  {
    name: 'error: the merchant answered nothing about any variant',
    client: () => client({ lookup: () => answer({ products: [], messages: [] }) }),
    ctx: { market: 'US' },
    expect: { status: STATUS.ERROR, market: 'US', reason: 'nothing_answered' },
    calls: 2,
  },
  {
    name: 'currency_mismatch: the store prices this market in another currency',
    client: () => client({ lookup: merchantAnswers([variantAnswer(ROSE, 3200, 'SGD'), variantAnswer(PLUM, 3400, 'SGD')]) }),
    ctx: { market: 'US' },
    expect: { status: STATUS.CURRENCY_MISMATCH, market: 'US', merchant_currency: 'SGD' },
    calls: 2,
  },
];

for (const o of OUTCOMES) {
  test(`enforce, ${o.name}: the stored product is served with live_read`, async () => {
    const c = o.client ? o.client() : client({ lookup: () => assert.fail('never looked up') });
    const reader = o.realClock
      ? createUcpLiveProductReader({ ucpClient: c, mode: 'enforce', budgetMs: o.budgetMs, log: () => {} })
      : enforceReader(c, { budgetMs: o.budgetMs });
    const stored = o.result ? o.result() : storedResult();
    const snapshot = JSON.parse(JSON.stringify(stored));
    const out = await reader.readProduct(stored, o.ctx);
    assert.deepEqual(stored, snapshot, 'the stored result is never mutated');
    if (o.realClock) {
      // A real clock stamps its own time: compare everything else.
      const { live_read: lr, ...rest } = out.product;
      assert.deepEqual(rest, stored.product);
      assert.equal(out.product.price, 25);
      for (const [k, v] of Object.entries(o.expect)) assert.equal(lr[k], v, `live_read.${k}`);
    } else {
      const lr = assertStoredServed(out, stored, o.name);
      for (const [k, v] of Object.entries(o.expect)) assert.equal(lr[k], v, `live_read.${k}`);
    }
    assert.equal(c.calls.length, o.calls, 'merchant calls');
    // price_verification_served: stored, never live.
    const facts = withPriceLog(() => priceFactsOf('get_product', out));
    assert.equal(classifyFact(facts.price_facts.items[0], { startedAtMs: NOW - 50, nowMs: NOW, ttlMs: TTL_MS.get_product }), 'stored');
  });
}

test('enforce, variant_gone: the merchant says one variant is gone; prices are kept, that variant goes out of stock', async () => {
  const c = client({ lookup: () => answer({ products: [], messages: [{ type: 'info', code: 'not_found', content: gid(ROSE) }, { type: 'info', code: 'not_found', content: gid(PLUM) }] }) });
  const out = await enforceReader(c).readProduct(storedResult(), { market: 'US' });
  const p = out.product;
  assert.equal(p.live_read.status, STATUS.VARIANT_GONE);
  assert.equal(p.price, 25);
  assert.deepEqual(p.variants.map((v) => [v.price.current.amount, v.availability.in_stock, v.live_read.status]), [[25, false, 'variant_gone'], [27, false, 'variant_gone']]);
  assert.equal(p.price_as_of, undefined);
  assert.equal(p.price_source, undefined, 'a gone answer prices nothing');
});

test('enforce: a reader that throws still serves the stored product, live_read error/reader_error', async () => {
  const c = client({ lookup: merchantAnswers([variantAnswer(ROSE, 2300, 'USD'), variantAnswer(PLUM, 2500, 'USD')]) });
  const reader = enforceReader(c, { log: () => { throw new Error('log sink down'); } });
  const stored = storedResult();
  const out = await reader.readProduct(stored, { market: 'US' });
  const lr = assertStoredServed(out, stored, 'reader_error');
  assert.equal(lr.status, STATUS.ERROR);
  assert.equal(lr.reason, 'reader_error');
});

test('enforce: a bare product (no { product } envelope) is annotated the same way', async () => {
  const stored = storedResult().product;
  const out = await enforceReader(client({ lookup: () => assert.fail('never') })).readProduct(stored, {});
  assert.equal(out.price, 25);
  assert.equal(out.live_read.reason, 'no_market');
  assert.equal(out.product, undefined, 'no envelope is invented');
});

test('shadow and off never touch the answer, whatever happens', async () => {
  for (const mode of ['shadow', 'off']) {
    const reader = createUcpLiveProductReader({ ucpClient: client({ lookup: () => { throw new Error('x'); } }), mode, log: () => { throw new Error('y'); } });
    assert.equal(await reader.readProduct(storedResult(), { market: 'US' }), null, mode);
  }
});

// ------------------------------------------------------------------------------------- verified, and how it counts

function withPriceLog(fn) {
  const prior = process.env.PRICE_VERIFICATION_LOG;
  process.env.PRICE_VERIFICATION_LOG = 'on';
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PRICE_VERIFICATION_LOG;
    else process.env.PRICE_VERIFICATION_LOG = prior;
  }
}
const classify = (out, startedAtMs = NOW - 50) => {
  const facts = withPriceLog(() => priceFactsOf('get_product', out)).price_facts;
  return { status: classifyFact(facts.items[0], { startedAtMs, nowMs: NOW, ttlMs: TTL_MS.get_product }), market: facts.market };
};

test('verified: the headline is re-priced and dated by THIS read; counted live, for the declared market', async () => {
  const c = client({ lookup: merchantAnswers([variantAnswer(ROSE, 2300, 'USD'), variantAnswer(PLUM, 2500, 'USD')]) });
  const out = await enforceReader(c).readProduct(storedResult(), { market: 'US' });
  const p = out.product;
  assert.equal(p.price, 23);
  assert.equal(p.currency, 'USD');
  assert.equal(p.price_source, 'merchant_live');
  assert.equal(p.price_as_of, new Date(NOW).toISOString());
  assert.equal(p.price_as_of, p.live_read.checked_at);
  assert.equal(p.live_read.status, STATUS.VERIFIED);
  assert.equal(p.live_read.market, 'US');
  assert.deepEqual(p.variants.map((v) => v.price.current.amount), [23, 25]);
  assert.deepEqual(classify(out), { status: 'live', market: 'US' });
  // The same answer replayed 11 minutes later is not live and is outside get_product's 10-minute window.
  const facts = withPriceLog(() => priceFactsOf('get_product', out)).price_facts;
  assert.equal(classifyFact(facts.items[0], { startedAtMs: NOW + 11 * 60e3, nowMs: NOW + 11 * 60e3, ttlMs: TTL_MS.get_product }), 'stored');
  assert.equal(classifyFact(facts.items[0], { startedAtMs: NOW + 5 * 60e3, nowMs: NOW + 5 * 60e3, ttlMs: TTL_MS.get_product }), 'recent');
});

test('verified, but the merchant answered only a non-default variant: the headline stays stored and undated', async () => {
  const c = client({ lookup: merchantAnswers([variantAnswer(PLUM, 2500, 'USD')]) });
  const out = await enforceReader(c).readProduct(storedResult(), { market: 'US' });
  const p = out.product;
  assert.equal(p.live_read.status, STATUS.VERIFIED);
  assert.equal(p.live_read.verified, 1);
  assert.equal(p.price, 25, 'the stored headline');
  assert.equal(p.price_as_of, undefined);
  assert.equal(classify(out).status, 'stored');
});

test('a stale merchant_live from an earlier read does not make an unread headline live', async () => {
  // The frontend PDP overlay can hand the detail lane a card already marked merchant_live from its cache.
  const stale = storedResult({ price_source: 'merchant_live' });
  const c = client({ lookup: merchantAnswers([variantAnswer(PLUM, 2500, 'USD')]) });
  const out = await enforceReader(c).readProduct(stale, { market: 'US' });
  assert.equal(out.product.live_read.status, STATUS.VERIFIED, 'the read verified a variant');
  assert.equal(out.product.price_as_of, undefined, 'but not the headline');
  assert.equal(classify(out).status, 'stored', 'so the headline is not counted live');
  const noMarket = await enforceReader(client({ lookup: () => assert.fail('never') })).readProduct(stale, {});
  assert.equal(classify(noMarket).status, 'stored');
});

test('facts: the answer\'s own metadata.market wins; only get_product reads live_read.market; search cards keep their dating', () => {
  const product = { price: 23, currency: 'USD', price_source: 'merchant_live', price_as_of: new Date(NOW).toISOString(), live_read: { status: 'verified', market: 'us', checked_at: new Date(NOW).toISOString() } };
  withPriceLog(() => {
    assert.equal(priceFactsOf('get_product', { product }).price_facts.market, 'US');
    assert.equal(priceFactsOf('get_product', { product, metadata: { market: 'SG' } }).price_facts.market, 'SG');
    assert.equal(priceFactsOf('get_product', { product: { ...product, live_read: { status: 'skipped', reason: 'no_market', market: null } } }).price_facts.market, null);
    assert.equal(priceFactsOf('get_product', { product: { ...product, live_read: { status: 'verified', market: 'USA' } } }).price_facts.market, null, 'ISO-2 only');
    // A search card the live read verified carries no price_as_of of its own: its live_read still dates it.
    // It names a market in its live_read too: only a get_product reads one from there.
    const card = { product_id: 'p', price: 10, currency: 'USD', price_source: 'merchant_live', live_read: { status: 'verified', market: 'US', checked_at: new Date(NOW).toISOString() } };
    const searchFact = priceFactsOf('search_catalog', { products: [card] }).price_facts.items[0];
    assert.equal(searchFact.at, NOW);
    assert.equal(priceFactsOf('search_catalog', { products: [card] }).price_facts.market, null, 'search reads no live_read market');
    assert.equal(priceFactsOf('get_offers', { signals: [{ value: card }] }).price_facts.market, null, 'nor does get_offers');
    assert.equal(priceFactsOf('recommend_products', { signals: [{ value: { product: card } }] }).price_facts.market, null, 'nor recommend');
    // The same object as a get_product: its live_read does not date the headline.
    assert.equal(priceFactsOf('get_product', { product: card }).price_facts.items[0].at, null);
  });
});

test('R2: a default variant answered with a price but no stock does not re-price or date the headline', async () => {
  const c = client({ lookup: merchantAnswers([{ id: gid(ROSE), price: { amount: 2300, currency: 'USD' }, availability: { available: null } }, variantAnswer(PLUM, 2100, 'USD')]) });
  const out = await enforceReader(c).readProduct(storedResult(), { market: 'US' });
  const p = out.product;
  assert.equal(p.live_read.status, STATUS.VERIFIED, 'Plum was read');
  assert.equal(p.price, 25, 'headline stays stored, like its variant');
  assert.equal(p.price_as_of, undefined);
  assert.equal(p.price_source, undefined);
  assert.equal(p.variants[0].live_read, undefined);
  assert.equal(classify(out).status, 'stored');
});
