'use strict';

// THE DOOR CAP DATES A LIVE STOCK ANSWER, NOT ONLY A LIVE PRICE (DOOR_CACHE_PRICE_FRESHNESS_CAP).
//
// The published limit for keeping a merchant's answer applies to price AND availability (10 min,
// priceVerificationFacts.DOOR_CAP_WINDOW_MS). The product reader (services/ucpLiveOfferRead applyProductRead)
// dates the headline price (`price_as_of`) only when the DEFAULT variant answered a price and stock, but moves
// the product's `in_stock` / `availability` on ANY live variant answer. So a read where only another variant
// answered (or the merchant said every variant is gone) served live stock with nothing dated: the cap did not
// fire, and the public tier could replay that stock on its own clock: up to 60 min by default (10 min fresh,
// then served stale until 60 min after it was stored; the stale window counts from the store, not after the ttl).
//
// Through the real producer (createUcpLiveProductReader, enforce) into the real public tier
// (createPublicReadToolSurface, its read cache and cache policy), with only the merchant client, the executor
// and the clock faked. Nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert/strict');

// The commerce schema declares get_product's `market` (and the public description its confirmed-price sentence)
// only while the live product read is on; it reads this once, at its module's load (the first import below).
process.env.UCP_LIVE_PRODUCT_READ = 'enforce';

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(keepAlive));

const { createUcpLiveProductReader, STATUS } = require('../src/services/ucpLiveOfferRead');
const facts = require('../src/observability/priceVerificationFacts');

const NOW = Date.parse('2026-11-23T09:00:00.000Z');
const MIN = 60 * 1000;
const ROSE = '43734829564039';
const PLUM = '43734829564040';
const gid = (id) => `gid://shopify/ProductVariant/${id}`;

function storedResult(extra = {}) {
  return {
    product: {
      product_id: 'sig_cap_tint',
      title: 'Tint',
      brand: 'Brand T',
      price: 25,
      currency: 'USD',
      availability: { in_stock: false },
      in_stock: false,
      destination_url: 'https://store.cap.test/products/tint',
      default_variant_id: ROSE,
      variants: [
        { variant_id: ROSE, title: 'Rose', price: { current: { amount: 25, currency: 'USD' } }, availability: { in_stock: false } },
        { variant_id: PLUM, title: 'Plum', price: { current: { amount: 27, currency: 'USD' } }, availability: { in_stock: false } },
      ],
      ...extra,
    },
  };
}

const answer = (payload) => ({ ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
const variantAnswer = (id, minor, available = true) => ({ id: gid(id), price: { amount: minor, currency: 'USD' }, availability: { available } });
const merchantAnswers = (variants) => answer({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants }], messages: [] });
const goneAnswer = () => answer({ products: [], messages: [ROSE, PLUM].map((id) => ({ type: 'info', code: 'not_found', content: gid(id) })) });

function client(lookup) {
  return {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog() { return lookup(); },
  };
}

/** What the real reader serves for this merchant answer, read at `atMs`. */
async function produce(lookup, atMs, extra) {
  const reader = createUcpLiveProductReader({ ucpClient: client(lookup), mode: 'enforce', now: () => atMs, log: () => {} });
  return reader.readProduct(storedResult(extra), { market: 'US' });
}

const SCENARIOS = {
  // Only a non-default variant answered: the product goes in stock, the headline price stays stored.
  stockOnly: () => merchantAnswers([variantAnswer(PLUM, 2500)]),
  // The merchant said every variant is gone: the product goes out of stock, nothing is priced.
  gone: goneAnswer,
  // The default variant answered price and stock: the headline is re-priced and dated (the existing path).
  priceAndStock: () => merchantAnswers([variantAnswer(ROSE, 2300), variantAnswer(PLUM, 2500)]),
  // The default variant answered a price and OUT of stock, and the read could not ask every variant (one has no
  // merchant id): the headline is re-priced and dated, the product's stock stays stored (and undated).
  priceOnlyDefaultSoldOut: () => merchantAnswers([variantAnswer(ROSE, 2300, false)]),
};
const UNASKED_VARIANT = { variant_id: 'shade-3', title: 'Coral', price: { current: { amount: 26, currency: 'USD' } }, availability: { in_stock: false } };
const withUnaskedVariant = (extra = {}) => ({ variants: [...storedResult().product.variants, UNASKED_VARIANT], ...extra });

function withEnv(vars, fn) {
  const prior = {};
  for (const k of Object.keys(vars)) {
    prior[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(vars)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  return Promise.resolve(out).finally(restore);
}

/**
 * The public tier over an executor whose get_product answers what the real reader produced (read at `readAtMs`).
 * Returns how many upstream reads `get_product` took at each probe time (ms after NOW).
 */
async function publicReplays(scenario, { cap, readAtMs = NOW, probesMin, extra, clocks = {} }) {
  return withEnv({
    DOOR_CACHE_PRICE_FRESHNESS_CAP: cap ? 'on' : undefined,
    PUBLIC_READ_CACHE_ENABLED: undefined,
    PUBLIC_READ_CACHE_TTL_MS: undefined,
    PUBLIC_READ_CACHE_STALE_MS: undefined,
    ...clocks,
  }, async () => {
    const produced = await produce(SCENARIOS[scenario], readAtMs, extra);
    let upstream = 0;
    const executor = {
      async execute(opId) {
        if (opId !== 'get_product') throw new Error(`unexpected op ${opId}`);
        upstream += 1;
        return structuredClone(produced);
      },
    };
    const { createPublicReadToolSurface } = await import('../mcp-server/src/publicReadToolSurface.js');
    const realNow = Date.now;
    const seen = [];
    try {
      const surface = createPublicReadToolSurface(executor, {});
      for (const m of probesMin) {
        Date.now = () => NOW + m * MIN;
        const value = await surface.callTool('get_product', { product_id: 'sig_cap_tint' }, {});
        // A stale hit revalidates in the background; let it settle before the next probe.
        await new Promise((r) => setImmediate(r));
        seen.push({ m, upstream, availability: value.availability, price: value.price ?? null });
      }
    } finally {
      Date.now = realNow;
    }
    return { produced, seen };
  });
}

test('producer: a stock-only live answer moves the product\'s stock and dates it; the stored price stays undated', async () => {
  for (const scenario of ['stockOnly', 'gone']) {
    const out = await produce(SCENARIOS[scenario], NOW);
    const p = out.product;
    assert.ok([STATUS.VERIFIED, STATUS.VARIANT_GONE].includes(p.live_read.status), scenario);
    assert.equal(p.in_stock, scenario === 'stockOnly', `${scenario}: live stock is served`);
    assert.equal(p.price, 25, `${scenario}: the stored headline price`);
    assert.equal(p.price_as_of, undefined, `${scenario}: a verified read that left the price stored never dates the price`);
    assert.notEqual(p.price_source, 'merchant_live', scenario);
    assert.equal(p.availability_as_of, new Date(NOW).toISOString(), `${scenario}: the live stock answer is dated`);
    assert.equal(facts.earliestMerchantAnswerMs('get_product', out), NOW, `${scenario}: the cap reads that date`);
  }
});

test('producer: no live stock answer, no stock date (an unread product, a variant that answered no stock)', async () => {
  const noMarket = await createUcpLiveProductReader({ ucpClient: client(() => assert.fail('never asked')), mode: 'enforce', now: () => NOW, log: () => {} })
    .readProduct(storedResult(), {});
  assert.equal(noMarket.product.availability_as_of, undefined);
  assert.equal(facts.earliestMerchantAnswerMs('get_product', noMarket), null);
  // A variant that answered a price but no stock is not a stock answer (and leaves `in_stock` stored).
  const noStock = await produce(() => merchantAnswers([{ id: gid(PLUM), price: { amount: 2500, currency: 'USD' }, availability: { available: null } }]), NOW);
  assert.equal(noStock.product.in_stock, false, 'stored');
  assert.equal(noStock.product.availability_as_of, undefined);
  assert.equal(facts.earliestMerchantAnswerMs('get_product', noStock), null);
});

test('public tier, cap ON: a stock-only live answer is replayed only until it is 10 min old', async () => {
  for (const scenario of ['stockOnly', 'gone']) {
    // Probes at 0 (compute), 5 (fresh hit), then 10, 15 and 30 min: the (fixed) answer is past its mark, so never stored again.
    const { seen } = await publicReplays(scenario, { cap: true, probesMin: [0, 5, 10, 15, 30] });
    assert.deepEqual(seen.map((s) => s.upstream), [1, 1, 2, 3, 4], `${scenario}: ${JSON.stringify(seen)}`);
    assert.equal(seen[0].availability, scenario === 'stockOnly' ? 'in_stock' : 'out_of_stock', 'the live stock is what is served');
  }
  // A stock answer already past the window when computed is not stored at all.
  const old = await publicReplays('stockOnly', { cap: true, readAtMs: NOW - 11 * MIN, probesMin: [0, 1] });
  assert.deepEqual(old.seen.map((s) => s.upstream), [1, 2]);
});

test('public tier, cap ON: what the tier SERVES decides which answer dates it', async () => {
  // The price withheld (untrusted), the live stock served: the stock answer caps the entry.
  const stockServed = await publicReplays('stockOnly', { cap: true, probesMin: [0, 5, 15, 20], extra: { commerce_verification: { required: false, price_trusted: false, availability_trusted: true } } });
  assert.deepEqual(stockServed.seen.map((s) => [s.price, s.availability]), Array(4).fill([null, 'in_stock']));
  assert.deepEqual(stockServed.seen.map((s) => s.upstream), [1, 1, 2, 3], 'capped by the served stock answer: past its mark, never stored again (uncapped, 20 would be a fresh hit)');
  // The live stock withheld (untrusted), the stored price served: no merchant answer is served, so the tier keeps
  // its own clock (15 min: served stale, revalidated in the background).
  const stockWithheld = await publicReplays('stockOnly', { cap: true, probesMin: [0, 5, 15, 20], extra: { commerce_verification: { required: false, price_trusted: true, availability_trusted: false } } });
  assert.deepEqual(stockWithheld.seen.map((s) => [s.price, s.availability]), Array(4).fill([{ amount: 25, currency: 'USD' }, 'unknown']));
  assert.deepEqual(stockWithheld.seen.map((s) => s.upstream), [1, 1, 2, 2], 'its own clock');
  // The live PRICE withheld (untrusted), the STORED stock served: the price answer is not served, so its
  // price_as_of dates nothing and the tier keeps its own clock.
  const priceWithheld = await publicReplays('priceOnlyDefaultSoldOut', { cap: true, probesMin: [0, 5, 15, 20], extra: withUnaskedVariant({ commerce_verification: { required: false, price_trusted: false, availability_trusted: true } }) });
  const p = priceWithheld.produced.product;
  assert.equal(p.price_as_of, new Date(NOW).toISOString(), 'the headline was re-priced and dated');
  assert.equal(p.price_source, 'merchant_live');
  assert.equal(p.availability_as_of, undefined, 'not every variant was asked: the product stock stays stored');
  assert.equal(p.in_stock, false, 'stored');
  assert.deepEqual(priceWithheld.seen.map((s) => [s.price, s.availability]), Array(4).fill([null, 'out_of_stock']));
  assert.deepEqual(priceWithheld.seen.map((s) => s.upstream), [1, 1, 2, 2], 'its own clock (a served price would have capped it: 20 would recompute)');
});

test('public tier, cap ON: a price+stock answer is capped exactly as before (by price_as_of)', async () => {
  const { produced, seen } = await publicReplays('priceAndStock', { cap: true, probesMin: [0, 5, 10, 15] });
  assert.equal(produced.product.price_as_of, new Date(NOW).toISOString());
  assert.equal(produced.product.price_source, 'merchant_live');
  assert.deepEqual(seen.map((s) => s.upstream), [1, 1, 2, 3]);
});

test('public tier, cap OFF: every clock exactly as before (10 min fresh, then served stale up to 60 min)', async () => {
  for (const scenario of ['stockOnly', 'gone', 'priceAndStock']) {
    // 0 compute; 5 fresh; 15 stale-served (+1 background revalidation); 20 fresh again from that revalidation.
    const { seen } = await publicReplays(scenario, { probesMin: [0, 5, 15, 20] });
    assert.deepEqual(seen.map((s) => s.upstream), [1, 1, 2, 2], `${scenario}: ${JSON.stringify(seen)}`);
  }
});

test('public tier: a fresh window longer than the stale one keeps the entry fresh for the whole fresh window', async () => {
  // PUBLIC_READ_CACHE_TTL_MS > PUBLIC_READ_CACHE_STALE_MS: fresh until 20 min (the stale window never opens),
  // which is why the description's bound is the LONGER of the two.
  const clocks = { PUBLIC_READ_CACHE_TTL_MS: String(20 * MIN), PUBLIC_READ_CACHE_STALE_MS: String(5 * MIN) };
  const { seen } = await publicReplays('stockOnly', { probesMin: [0, 15, 19, 21], clocks });
  assert.deepEqual(seen.map((s) => s.upstream), [1, 1, 1, 2]);
});

// ---------------------------------------------------------------------------------- the public description's bound

async function publicGetProductDescription(vars) {
  return withEnv(vars, async () => {
    const { createPublicReadToolSurface } = await import('../mcp-server/src/publicReadToolSurface.js');
    const surface = createPublicReadToolSurface({ execute: async () => ({}) }, {});
    const tool = surface.tools.find((t) => t.name === 'get_product');
    assert.ok(tool.inputSchema.properties.market, 'market is declared while the live product read is on');
    return tool.description;
  });
}
const CLOCKS = { PUBLIC_READ_CACHE_ENABLED: undefined, PUBLIC_READ_CACHE_TTL_MS: undefined, PUBLIC_READ_CACHE_STALE_MS: undefined };

test('description: states the bound the cache keeps, never a shorter one', async () => {
  const off = await publicGetProductDescription({ ...CLOCKS, DOOR_CACHE_PRICE_FRESHNESS_CAP: undefined });
  assert.match(off, /`price_check\.confirmed_with_merchant` is true \(the merchant's answer may be up to about an hour old\)/);
  const on = await publicGetProductDescription({ ...CLOCKS, DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on' });
  assert.match(on, /\(the merchant's answer may be up to about 10 minutes old\)/);
  assert.doesNotMatch(on, /hour/);
  // The tier's own clock, when set: the longer of its fresh and stale windows (the cap only ever shortens it).
  const longer = await publicGetProductDescription({ ...CLOCKS, PUBLIC_READ_CACHE_STALE_MS: String(90 * MIN), DOOR_CACHE_PRICE_FRESHNESS_CAP: undefined });
  assert.match(longer, /up to about 90 minutes old/);
  const shorter = await publicGetProductDescription({ ...CLOCKS, PUBLIC_READ_CACHE_TTL_MS: String(3 * MIN), PUBLIC_READ_CACHE_STALE_MS: String(5 * MIN), DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on' });
  assert.match(shorter, /up to about 5 minutes old/);
  // A fresh window longer than the stale one: the entry is replayed for the fresh window (test above).
  const ttlLonger = await publicGetProductDescription({ ...CLOCKS, PUBLIC_READ_CACHE_TTL_MS: String(20 * MIN), PUBLIC_READ_CACHE_STALE_MS: String(5 * MIN), DOOR_CACHE_PRICE_FRESHNESS_CAP: undefined });
  assert.match(ttlLonger, /up to about 20 minutes old/);
  const noCache = await publicGetProductDescription({ ...CLOCKS, PUBLIC_READ_CACHE_ENABLED: '0' });
  // No door replay, but the reader's lookup memo (30 s) can hand this request an answer read just before it.
  assert.match(noCache, /\(the merchant answered within about the last minute\)/);
  // The rest of the sentence is what it was.
  for (const d of [off, on]) {
    assert.match(d, /Send `market` \(the buyer's country, ISO 3166-1 alpha-2\) whenever you know it/);
    assert.match(d, /Without it the product is answered for a US buyer, and the answer says so in `market_assumed`\. A price here is for discovery only: never quote it to a buyer as the final price\.$/);
  }
});
