'use strict';

// UCP_LIVE_PDP_READ=enforce, phase 1: the frontend PDP serves the merchant's cached live answer to the NEXT
// view. Pages are built by the real producer (pdpBuilder), the answers by the real reader's shape.

const test = require('node:test');
const assert = require('node:assert/strict');

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
require('node:test').after(() => clearInterval(keepAlive));

const { applyPdpLiveOverlay, createPdpLiveCache } = require('../src/services/pdpLiveOverlay');
const { STATUS } = require('../src/services/ucpLiveOfferRead');
const { buildPdpPayload } = require('../src/pdpBuilder');

const LEMON = '48087970185268';
const BERRY = '31760703160372';
const VANILLA = '31760703258676';
const HOST = 'us.laneige.com';

function verifiedRead(answers, { notFound = [], silent = [], country = 'US', currency = 'USD', status = STATUS.VERIFIED } = {}) {
  return {
    status,
    host: HOST,
    country,
    currency,
    live: new Map(Object.entries(answers)),
    notFound: new Set(notFound),
    askedIds: [...Object.keys(answers), ...notFound, ...silent],
  };
}

function sellerProduct(extra = {}) {
  const v = (id, title) => ({
    variant_id: id,
    title,
    options: [{ name: 'Flavor', value: title }],
    price: { amount: 26, currency: 'USD', compare_at: 30 },
    in_stock: false,
    inventory_quantity: 0,
  });
  return {
    product_id: 'ext_lsm',
    merchant_id: 'merch_obs_laneige',
    source: 'external_seed',
    title: 'Lip Sleeping Mask',
    image_url: 'https://cdn.example/lsm.jpg',
    price: { amount: 26, currency: 'USD' },
    currency: 'USD',
    destination_url: `https://${HOST}/products/lip-sleeping-mask`,
    default_variant_id: LEMON,
    variants: [v(LEMON, 'Lemon Sorbet'), v(BERRY, 'Berry'), v(VANILLA, 'Vanilla')],
    ...extra,
  };
}

/** A get_pdp_v2 response as the gateway assembles it around the producer's payload. */
function page(product = sellerProduct(), { offers } = {}) {
  const pdp = buildPdpPayload({ product, relatedProducts: [], entryPoint: 'agent' });
  const selector = (pdp.modules || []).find((m) => m.type === 'variant_selector');
  const modules = [{ type: 'canonical', required: true, data: { pdp_payload: pdp } }];
  if (selector) modules.push({ type: 'variant_selector', required: false, data: selector.data });
  if (offers) modules.push({ type: 'offers', required: false, data: offers });
  return { status: 'success', pdp_version: '2.0', modules, metadata: {} };
}

function cacheWith(read, opts) {
  const cache = createPdpLiveCache(opts);
  cache.record(read);
  return cache;
}

const cardOf = (p) => p.modules[0].data.pdp_payload.product;
const nested = (p, type) => p.modules[0].data.pdp_payload.modules.find((m) => m.type === type);
const top = (p, type) => p.modules.find((m) => m.type === type);
const byId = (list) => new Map(list.map((v) => [String(v.variant_id), v]));

// ------------------------------------------------------------- the cache

test('the cache keeps only what the merchant answered: a priced, stocked variant, or one it SAID is gone', () => {
  const cache = createPdpLiveCache();
  const kept = cache.record(verifiedRead({
    [LEMON]: { amount: 24, currency: 'USD', available: true },
    [BERRY]: { amount: null, currency: 'USD', available: true }, // unpriced: not an answer
  }, { notFound: [VANILLA], silent: ['77777777'] }));
  assert.equal(kept, 2, 'an id the merchant was asked about and said nothing of is not gone');
  const got = cache.answersFor(HOST, 'US', [LEMON, BERRY, VANILLA, '99999999']);
  assert.deepEqual([...got.keys()].sort(), [LEMON, VANILLA].sort());
  assert.equal(got.get(VANILLA).gone, true);
  assert.equal(cache.answersFor(HOST, 'SG', [LEMON]).size, 0, 'one market\'s answer is not another\'s');
  for (const status of [STATUS.TIMEOUT, STATUS.ERROR, STATUS.CURRENCY_MISMATCH, STATUS.SKIPPED, STATUS.NOT_UCP]) {
    assert.equal(createPdpLiveCache().record({ ...verifiedRead({ [LEMON]: { amount: 24, currency: 'USD', available: true } }), status }), 0, status);
  }
  // A variant answered in another currency than the read's is not kept.
  assert.equal(createPdpLiveCache().record(verifiedRead({ [LEMON]: { amount: 3700, currency: 'SGD', available: true } })), 0);
});

test('the cache forgets after its TTL, is bounded, and claims one read per product x market per TTL', () => {
  let t = 1000;
  const cache = createPdpLiveCache({ ttlMs: 600000, max: 2, now: () => t });
  cache.record(verifiedRead({ [LEMON]: { amount: 24, currency: 'USD', available: true } }));
  t += 599999;
  assert.equal(cache.answersFor(HOST, 'US', [LEMON]).size, 1);
  t += 2;
  assert.equal(cache.answersFor(HOST, 'US', [LEMON]).size, 0, 'stale after ten minutes');
  cache.record(verifiedRead({
    [LEMON]: { amount: 24, currency: 'USD', available: true },
    [BERRY]: { amount: 24, currency: 'USD', available: true },
    [VANILLA]: { amount: 24, currency: 'USD', available: true },
  }));
  assert.equal(cache.stats().answers, 2, 'bounded: the oldest goes first');
  assert.equal(cache.answersFor(HOST, 'US', [LEMON]).size, 0);

  assert.equal(cache.claimRead(HOST, 'US', [LEMON, BERRY]), true);
  assert.equal(cache.claimRead(HOST, 'US', [BERRY, LEMON]), false, 'same product, any id order');
  assert.equal(cache.claimRead(HOST, 'SG', [LEMON, BERRY]), true, 'another market is another read');
  cache.releaseRead(HOST, 'US', [LEMON, BERRY]);
  assert.equal(cache.claimRead(HOST, 'US', [LEMON, BERRY]), true, 'a released claim can be taken again');
  t += 600001;
  assert.equal(cache.claimRead(HOST, 'SG', [LEMON, BERRY]), true, 'a claim lapses with the TTL');
});

// ------------------------------------------------------------- the overlay, through the real producer

test('THROUGH THE REAL PRODUCER: every place the page shows the card\'s money moves together', () => {
  const p = page();
  const before = JSON.stringify(p);
  const cache = cacheWith(verifiedRead({
    [LEMON]: { amount: 24, currency: 'USD', available: true }, // repriced + back in stock
    [BERRY]: { amount: 26, currency: 'USD', available: true }, // price confirmed
  }, { notFound: [VANILLA] }));
  const out = applyPdpLiveOverlay(p, { market: 'us', cache });
  assert.ok(out);
  assert.equal(JSON.stringify(p), before, 'the input page is never mutated');
  const card = cardOf(out.payload);
  const v = byId(card.variants);
  assert.deepEqual(v.get(LEMON).price.current, { amount: 24, currency: 'USD' });
  assert.equal(v.get(LEMON).price.compare_at, undefined, 'a compare-at read beside a price the merchant no longer charges goes');
  assert.equal(v.get(LEMON).availability.in_stock, true);
  assert.equal(v.get(LEMON).live_read.status, STATUS.VERIFIED);
  assert.equal('available_quantity' in v.get(LEMON).availability, false, 'no stored count beside a live flag');
  assert.deepEqual(v.get(BERRY).price.current, { amount: 26, currency: 'USD' });
  assert.ok(v.get(BERRY).price.compare_at !== undefined, 'a confirmed price keeps its compare-at');
  assert.equal(v.get(VANILLA).availability.in_stock, false);
  assert.equal(v.get(VANILLA).live_read.status, STATUS.VARIANT_GONE);
  assert.equal(card.price.current.amount, 24, 'the card shows its default variant\'s live price');
  assert.equal(card.price_source, 'merchant_live');
  assert.equal(card.availability.in_stock, true);
  assert.deepEqual(
    { status: card.live_read.status, market: card.live_read.market, checked: card.live_read.checked, verified: card.live_read.verified, gone: card.live_read.gone },
    { status: STATUS.VERIFIED, market: 'US', checked: 3, verified: 2, gone: 1 },
  );
  const promo = nested(out.payload, 'price_promo');
  assert.equal(promo.data.price.amount, 24);
  assert.equal(promo.data.compare_at, undefined);
  for (const selector of [nested(out.payload, 'variant_selector'), top(out.payload, 'variant_selector')]) {
    const s = byId(selector.data.variants);
    assert.equal(s.get(LEMON).price.current.amount, 24);
    assert.equal(s.get(LEMON).availability.in_stock, true);
    assert.equal(s.get(VANILLA).availability.in_stock, false);
  }
  assert.deepEqual(
    { verified: out.stats.verified, gone: out.stats.gone, price_changed: out.stats.price_changed, stock_changed: out.stats.stock_changed },
    { verified: 2, gone: 1, price_changed: 1, stock_changed: 2 },
  );
});

test('a variant the own-money logic marked unavailable is never re-enabled by a live answer', () => {
  const product = sellerProduct();
  product.variants[0] = { ...product.variants[0], current_own_offer_status: 'unavailable' };
  const p = page(product);
  const cache = cacheWith(verifiedRead({
    [LEMON]: { amount: 24, currency: 'USD', available: true },
    [BERRY]: { amount: 25, currency: 'USD', available: true },
  }));
  const out = applyPdpLiveOverlay(p, { market: 'US', cache });
  const v = byId(cardOf(out.payload).variants);
  assert.equal(v.get(LEMON).current_own_offer_status, 'unavailable');
  assert.equal(v.get(LEMON).live_read, undefined);
  assert.equal(v.get(BERRY).price.current.amount, 25);
});

test('nothing changes for a blocked page, another currency, an undeclared market, or no fresh answer', () => {
  const answers = { [LEMON]: { amount: 24, currency: 'USD', available: true } };
  const blocked = page(sellerProduct({ transaction_ready: false }));
  assert.equal(cardOf(blocked).commerce_suppressed, true);
  assert.equal(applyPdpLiveOverlay(blocked, { market: 'US', cache: cacheWith(verifiedRead(answers)) }), null);
  const open = page();
  const sgd = cacheWith(verifiedRead({ [LEMON]: { amount: 37, currency: 'SGD', available: true } }, { country: 'US', currency: 'SGD' }));
  assert.equal(applyPdpLiveOverlay(open, { market: 'US', cache: sgd }), null, 'phase 1 never re-prices into another currency');
  assert.equal(applyPdpLiveOverlay(open, { market: '', cache: cacheWith(verifiedRead(answers)) }), null);
  assert.equal(applyPdpLiveOverlay(open, { market: 'SG', cache: cacheWith(verifiedRead(answers)) }), null);
  assert.equal(applyPdpLiveOverlay(open, { market: 'US', cache: createPdpLiveCache() }), null);
});

test('the offer row selling the card\'s listing moves with it; another seller\'s does not; best price is re-checked', () => {
  const offers = {
    default_offer_id: 'of_card',
    best_price_offer_id: 'of_card',
    offers: [
      { offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
        price: { amount: 22, currency: 'USD' }, inventory: { in_stock: true },
        variants: [{ variant_id: LEMON, price: { current: { amount: 22, currency: 'USD' } }, availability: { in_stock: true } }] },
      // Even an id that collides with the card's: another seller's row is never this merchant's answer to give.
      { offer_id: 'of_sephora', merchant_id: 'merch_obs_sephora', product_id: 'ext_seph', selected_variant_id: LEMON,
        price: { amount: 23, currency: 'USD' }, inventory: { in_stock: true } },
    ],
  };
  const p = page(sellerProduct(), { offers });
  const cache = cacheWith(verifiedRead({ [LEMON]: { amount: 24, currency: 'USD', available: true } }));
  const isCardOffer = (card, offer) => offer.merchant_id === card.merchant_id && offer.product_id === 'ext_lsm';
  const out = applyPdpLiveOverlay(p, { market: 'US', cache, isCardOffer });
  const data = top(out.payload, 'offers').data;
  const [mine, theirs] = data.offers;
  assert.equal(mine.price.amount, 24);
  assert.equal(mine.inventory.in_stock, true);
  assert.equal(mine.variants[0].price.current.amount, 24);
  assert.equal(mine.live_read.status, STATUS.VERIFIED);
  assert.equal(theirs, offers.offers[1], 'another seller\'s offer is the same object');
  assert.equal(data.best_price_offer_id, 'of_sephora', 'the card\'s offer is no longer the cheapest');
  assert.equal(out.stats.best_price_moved, true);
  assert.equal(p.modules[2].data.best_price_offer_id, 'of_card', 'input untouched');
  // Still cheapest: the mark stays.
  const cheap = cacheWith(verifiedRead({ [LEMON]: { amount: 21, currency: 'USD', available: true } }));
  assert.equal(top(applyPdpLiveOverlay(p, { market: 'US', cache: cheap, isCardOffer }).payload, 'offers').data.best_price_offer_id, 'of_card');
});

// ------------------------------------------------------------- server wiring

test('server: the overlay is enforce-only, and the background read is claimed once per product x market', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const builder = path.join(__dirname, '..', 'src', 'pdpBuilder.js');
  const run = (env) => {
    const code = `
      const { livePdpOverlay, ucpLivePdpCache, shadowPdpLiveRead } = require(${JSON.stringify(server)})._debug;
      const { buildPdpPayload } = require(${JSON.stringify(builder)});
      const pdp = buildPdpPayload({ relatedProducts: [], entryPoint: 'agent', product: {
        product_id: 'ext_lsm', merchant_id: 'merch_obs_laneige', title: 'LSM', image_url: 'https://cdn.example/a.jpg',
        currency: 'USD', price: { amount: 26, currency: 'USD' }, destination_url: 'https://lsm.invalid/products/lsm',
        variants: [{ variant_id: '${LEMON}', title: 'Lemon', price: { amount: 26, currency: 'USD' }, in_stock: false }] } });
      const page = { modules: [{ type: 'canonical', data: { pdp_payload: pdp } }] };
      const cache = ucpLivePdpCache();
      cache.record({ status: 'verified', host: 'lsm.invalid', country: 'US', currency: 'USD', askedIds: ['${LEMON}'],
        live: new Map([['${LEMON}', { amount: 24, currency: 'USD', available: true }]]), notFound: new Set() });
      const served = livePdpOverlay(page, { market: 'US' });
      const price = served.modules[0].data.pdp_payload.product.price.current.amount;
      // An .invalid host never resolves: no store is contacted from a test; only the claim is under test.
      const first = shadowPdpLiveRead(page, { market: 'US', pageState: 'served', random: () => 0 });
      const second = shadowPdpLiveRead(page, { market: 'US', pageState: 'served', random: () => 0 });
      console.log(JSON.stringify({ same: served === page, price, first, second }));
      setTimeout(() => process.exit(0), 50);`;
    const childEnv = { ...process.env };
    for (const k of ['UCP_LIVE_PDP_READ', 'UCP_LIVE_PDP_READ_SAMPLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete childEnv[k];
    Object.assign(childEnv, env);
    const r = spawnSync(process.execPath, ['-e', code], { env: childEnv, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    return JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"same"')));
  };
  assert.deepEqual(run({}), { same: true, price: 26, first: false, second: false });
  assert.deepEqual(run({ UCP_LIVE_PDP_READ: 'shadow' }), { same: true, price: 26, first: true, second: false });
  assert.deepEqual(run({ UCP_LIVE_PDP_READ: 'enforce' }), { same: false, price: 24, first: true, second: false });
});

test('STRUCTURAL: only the normally served get_pdp_v2 return takes the overlay', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf('      const shadowPdpRead = (pageState) => shadowPdpLiveRead(responsePayload, {');
  assert.ok(i > 0);
  const block = src.slice(i, src.indexOf('} catch (err) {', i));
  assert.equal((block.match(/livePdpOverlay\(/g) || []).length, 1);
  assert.match(block, /return res\.json\(canonicalOwnMoneyGap\s+\? withoutCanonicalPurchaseActions\(responsePayload\)\s+: livePdpOverlay\(responsePayload, \{\s+market: offersGateBuyerMarket\(payload, metadata\),/);
  const g = src.indexOf('function getUcpLivePdpReader()');
  assert.match(src.slice(g, g + 700), /mode: MODES\.SHADOW,/, 'the reader itself never touches the page');
});
