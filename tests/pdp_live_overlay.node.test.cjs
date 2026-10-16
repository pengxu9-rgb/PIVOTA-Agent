'use strict';

// UCP_LIVE_PDP_READ=enforce, phase 1: the frontend PDP serves the merchant's cached live answer to the NEXT
// view. Pages are built by the real producer (pdpBuilder), the answers by the real reader's shape.

const test = require('node:test');
const assert = require('node:assert/strict');

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
require('node:test').after(() => clearInterval(keepAlive));

const { applyPdpLiveOverlay, createPdpLiveCache } = require('../src/services/pdpLiveOverlay');
const { parseLookup, STATUS } = require('../src/services/ucpLiveOfferRead');
const { buildPdpPayload } = require('../src/pdpBuilder');

const LEMON = '48087970185268';
const BERRY = '31760703160372';
const VANILLA = '31760703258676';
const HOST = 'us.laneige.com';

// The merchant's answers name the product page they came from (lookup_catalog's `handle`).
const HANDLE = 'lip-sleeping-mask';
function verifiedRead(answers, { notFound = [], silent = [], country = 'US', currency = 'USD', status = STATUS.VERIFIED, handle = HANDLE } = {}) {
  return {
    status,
    host: HOST,
    country,
    currency,
    live: new Map(Object.entries(answers).map(([id, a]) => [id, { handle, ...a }])),
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
  // A merchant that recognised NONE of the asked ids (a page id, a barcode sku asked as a variant) said
  // nothing about this product's variants: no "gone" is recorded from it.
  assert.equal(createPdpLiveCache().record(verifiedRead({}, { notFound: [LEMON, BERRY], status: STATUS.VARIANT_GONE })), 0);
  // A variant answered in another currency than the read's is not kept.
  assert.equal(createPdpLiveCache().record(verifiedRead({ [LEMON]: { amount: 3700, currency: 'SGD', available: true } })), 0);
});

test('the cache forgets after its TTL, is bounded, and claims one read per product x market per TTL', () => {
  let t = 1000;
  const cache = createPdpLiveCache({ ttlMs: 600000, retryMs: 120000, maxAnswers: 2, now: () => t });
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
  // A read that got no answer may be tried again after the retry window, not the full TTL.
  assert.equal(cache.claimRead(HOST, 'JP', [LEMON]), true);
  cache.retryReadSoon(HOST, 'JP', [LEMON]);
  t += 119999;
  assert.equal(cache.claimRead(HOST, 'JP', [LEMON]), false);
  t += 2;
  assert.equal(cache.claimRead(HOST, 'JP', [LEMON]), true, 'retried after two minutes');
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
  // The list was in presentation order (in stock, then total): the dearer row now sits after the cheaper.
  assert.deepEqual(data.offers.map((x) => x.offer_id), ['of_sephora', 'of_card']);
  const [theirs, mine] = data.offers;
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

// ------------------------------------------------------------- a row that names no selected variant

// pivota-agent-ui#434 (the native226 row): a card offer row with no selected_variant_id / variant_id /
// default_variant_id was re-priced and restocked only inside its variants[]; the row's own inventory and
// facts kept saying in stock, and the storefront reads those first.
function unnamedRow(variants, extra = {}) {
  return {
    offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm',
    price: { amount: 26, currency: 'USD' }, inventory: { in_stock: true },
    commerce_facts_v1: { regional_price: { amount: 26, currency: 'USD' }, availability: { status: 'in_stock' } },
    variants,
    ...extra,
  };
}
const rowVariant = (id) => ({ variant_id: id, price: { current: { amount: 26, currency: 'USD' } }, availability: { in_stock: true } });
const ownRow = (card, offer) => offer.merchant_id === card.merchant_id && offer.product_id === 'ext_lsm';
const unnamedRowOf = (out) => top(out.payload, 'offers').data.offers[0];

test('a row naming no variant stands for its ONE variant: gone or out of stock at the merchant reads so at the row level', () => {
  // Berry is NOT the card's default (Lemon is): the row's one variant is what it stands for.
  for (const [label, read] of [
    ['gone', verifiedRead({ [LEMON]: { amount: 26, currency: 'USD', available: true } }, { notFound: [BERRY] })],
    ['out of stock', verifiedRead({ [BERRY]: { amount: 26, currency: 'USD', available: false } })],
  ]) {
    const offers = { default_offer_id: 'of_card', best_price_offer_id: 'of_card', offers: [unnamedRow([rowVariant(BERRY)])] };
    const out = applyPdpLiveOverlay(page(sellerProduct(), { offers }), { market: 'US', cache: cacheWith(read), isCardOffer: ownRow });
    const row = unnamedRowOf(out);
    assert.equal(row.inventory.in_stock, false, label);
    assert.equal(row.commerce_facts_v1.availability.status, 'out_of_stock', label);
    assert.equal(row.variants[0].availability.in_stock, false, label);
    assert.equal(row.live_read.status, label === 'gone' ? STATUS.VARIANT_GONE : STATUS.VERIFIED, label);
  }
});

test('a multi-variant row naming no variant stands for the CARD\'s default when it carries it', () => {
  const offers = { offers: [unnamedRow([rowVariant(BERRY), rowVariant(LEMON)])] };
  const read = verifiedRead({ [LEMON]: { amount: 24, currency: 'USD', available: false }, [BERRY]: { amount: 26, currency: 'USD', available: true } });
  const row = unnamedRowOf(applyPdpLiveOverlay(page(sellerProduct(), { offers }), { market: 'US', cache: cacheWith(read), isCardOffer: ownRow }));
  assert.equal(row.inventory.in_stock, false, 'the card default (Lemon) is out of stock');
  assert.equal(row.price.amount, 24);
  assert.equal(row.commerce_facts_v1.regional_price.amount, 24);
});

test('a multi-variant row without the card default, or whose implied variant is withheld, keeps its row-level claim', () => {
  const read = verifiedRead({
    [LEMON]: { amount: 24, currency: 'USD', available: false },
    [BERRY]: { amount: 20, currency: 'USD', available: false },
    [VANILLA]: { amount: 20, currency: 'USD', available: false },
  });
  const multi = applyPdpLiveOverlay(page(sellerProduct(), { offers: { offers: [unnamedRow([rowVariant(BERRY), rowVariant(VANILLA)])] } }),
    { market: 'US', cache: cacheWith(read), isCardOffer: ownRow });
  const row = unnamedRowOf(multi);
  assert.equal(row.inventory.in_stock, true, 'no variant to stand for: the row-level claim is not touched');
  assert.equal(row.price.amount, 26);
  assert.equal(row.live_read, undefined);
  assert.equal(row.variants[0].availability.in_stock, false, 'its variants still move');
  // The one variant, withheld on the card or marked on the row: not implied.
  const withheld = sellerProduct();
  withheld.variants[0] = { ...withheld.variants[0], current_own_offer_status: 'unavailable' };
  const w = unnamedRowOf(applyPdpLiveOverlay(page(withheld, { offers: { offers: [unnamedRow([rowVariant(LEMON)])] } }),
    { market: 'US', cache: cacheWith(read), isCardOffer: ownRow }));
  assert.equal(w.inventory.in_stock, true);
  const marked = unnamedRowOf(applyPdpLiveOverlay(page(sellerProduct(), { offers: { offers: [unnamedRow([{ ...rowVariant(LEMON), current_own_offer_status: 'unavailable' }])] } }),
    { market: 'US', cache: cacheWith(read), isCardOffer: ownRow }));
  assert.equal(marked.inventory.in_stock, true);
  // A "variant" whose id is only its sku standing in (pdpBuilder's fallback) is not a variant to stand for.
  const skuOnly = unnamedRowOf(applyPdpLiveOverlay(page(sellerProduct(), { offers: { offers: [unnamedRow([{ ...rowVariant(LEMON), sku: LEMON }])] } }),
    { market: 'US', cache: cacheWith(read), isCardOffer: ownRow }));
  assert.equal(skuOnly.inventory.in_stock, true);
  // Another currency or another store: untouched, as for a named row.
  const sgd = unnamedRowOf(applyPdpLiveOverlay(page(sellerProduct(), { offers: { offers: [unnamedRow([rowVariant(LEMON)], { price: { amount: 35, currency: 'SGD' } })] } }),
    { market: 'US', cache: cacheWith(read), isCardOffer: ownRow }));
  assert.equal(sgd.inventory.in_stock, true);
  const elsewhere = unnamedRowOf(applyPdpLiveOverlay(page(sellerProduct(), { offers: { offers: [unnamedRow([rowVariant(LEMON)], { destination_url: 'https://www.sephora.com/products/x' })] } }),
    { market: 'US', cache: cacheWith(read), isCardOffer: ownRow }));
  assert.equal(elsewhere.inventory.in_stock, true);
});

// ------------------------------------------------------------- review of #2448

test('review 2: best price follows the producer (price + shipping), and a confirmed price never moves it', () => {
  const offers = {
    best_price_offer_id: 'of_card',
    offers: [
      { offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
        price: { amount: 22, currency: 'USD' }, shipping: { cost: { amount: 0, currency: 'USD' } }, inventory: { in_stock: true } },
      { offer_id: 'of_other', merchant_id: 'merch_obs_other', product_id: 'ext_other', selected_variant_id: 'P1',
        price: { amount: 20, currency: 'USD' }, shipping: { cost: { amount: 8, currency: 'USD' } }, inventory: { in_stock: true } },
    ],
  };
  const isCardOffer = (card, offer) => offer.offer_id === 'of_card';
  const p = page(sellerProduct(), { offers });
  const confirmed = applyPdpLiveOverlay(p, { market: 'US', isCardOffer,
    cache: cacheWith(verifiedRead({ [LEMON]: { amount: 22, currency: 'USD', available: true } })) });
  assert.equal(top(confirmed.payload, 'offers').data.best_price_offer_id, 'of_card');
  assert.equal(confirmed.stats.best_price_moved, undefined);
  // $27 + free shipping vs $20 + $8: still the card's ($27 < $28).
  const dearer = applyPdpLiveOverlay(p, { market: 'US', isCardOffer,
    cache: cacheWith(verifiedRead({ [LEMON]: { amount: 27, currency: 'USD', available: true } })) });
  assert.equal(top(dearer.payload, 'offers').data.best_price_offer_id, 'of_card');
  const dearest = applyPdpLiveOverlay(p, { market: 'US', isCardOffer,
    cache: cacheWith(verifiedRead({ [LEMON]: { amount: 29, currency: 'USD', available: true } })) });
  assert.equal(top(dearest.payload, 'offers').data.best_price_offer_id, 'of_other');
  // A mark the producer settled on its own evidence is not re-settled by a mere confirmation.
  const tie = {
    best_price_offer_id: 'of_other',
    offers: [
      { offer_id: 'of_card', merchant_id: 'm', product_id: 'ext_lsm', selected_variant_id: LEMON, price: { amount: 22, currency: 'USD' }, inventory: { in_stock: true } },
      { offer_id: 'of_other', merchant_id: 'n', product_id: 'x', price: { amount: 23, currency: 'USD' }, inventory: { in_stock: true } },
    ],
  };
  const tied = applyPdpLiveOverlay(page(sellerProduct(), { offers: tie }), { market: 'US', isCardOffer,
    cache: cacheWith(verifiedRead({ [LEMON]: { amount: 22, currency: 'USD', available: true } })) });
  assert.equal(top(tied.payload, 'offers').data.best_price_offer_id, 'of_other');
});

test('review 3: an id that is not a variant id (restated page id, sku stand-in) is never marked gone', () => {
  // A page whose only variant id is the page id: the read asks that id alone, the merchant recognises
  // nothing, and nothing is recorded -- so nothing on the page changes.
  const PAGE_ID = '8123456789012';
  const product = sellerProduct({ default_variant_id: PAGE_ID });
  product.variants = [{ variant_id: PAGE_ID, title: 'Default', price: { amount: 26, currency: 'USD' }, in_stock: true }];
  const cache = cacheWith(verifiedRead({}, { notFound: [PAGE_ID], status: STATUS.VARIANT_GONE }));
  assert.equal(applyPdpLiveOverlay(page(product), { market: 'US', cache }), null);
  // A page mixing a real variant with a sku standing in for a missing id: the real one is read, the sku
  // (pdpBuilder's fallback id) is not "gone" because the merchant has no variant by that number.
  const SKU = '0812345678901';
  const mixed = sellerProduct();
  mixed.variants = [
    { variant_id: LEMON, title: 'Lemon', options: [{ name: 'Flavor', value: 'Lemon' }], price: { amount: 26, currency: 'USD' }, in_stock: true },
    { sku: SKU, title: 'Mint', options: [{ name: 'Flavor', value: 'Mint' }], price: { amount: 26, currency: 'USD' }, in_stock: true },
  ];
  const p = page(mixed);
  assert.ok(cardOf(p).variants.some((v) => String(v.variant_id) === SKU), 'the producer used the sku as the id');
  const out = applyPdpLiveOverlay(p, { market: 'US',
    cache: cacheWith(verifiedRead({ [LEMON]: { amount: 24, currency: 'USD', available: true } }, { notFound: [SKU] })) });
  const v = byId(cardOf(out.payload).variants);
  assert.equal(v.get(LEMON).price.current.amount, 24);
  assert.equal(v.get(SKU).live_read, undefined);
  assert.equal(v.get(SKU).availability.in_stock, true);
});

test('review 4+7: a seed offer row keeps one stock story, its facts follow, and stale savings copy goes', () => {
  const offers = {
    best_price_offer_id: 'of_card',
    offers: [{
      offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
      price: { amount: 26, currency: 'USD' }, availability: 'in_stock', inventory: { in_stock: true }, payment_pricing: { note: 'stored' },
      commerce_facts_v1: {
        regional_price: { amount: 26, currency: 'USD', display_raw: '$26.00', compare_at_amount: 30, compare_at_currency: 'USD' },
        availability: { status: 'in_stock', confidence: 'medium' },
      },
    }],
  };
  const isCardOffer = () => true;
  const promoted = sellerProduct({ promotions: [{ title: 'Stored: 10% off' }] });
  const gone = applyPdpLiveOverlay(page(promoted, { offers }), {
    market: 'US', isCardOffer, presentationFields: ['payment_pricing'],
    cache: cacheWith(verifiedRead({ [BERRY]: { amount: 26, currency: 'USD', available: true } }, { notFound: [LEMON] })),
  });
  const row = top(gone.payload, 'offers').data.offers[0];
  assert.equal(row.availability, 'out_of_stock', 'a string stays a string, and agrees with inventory');
  assert.equal(row.inventory.in_stock, false);
  assert.equal(row.commerce_facts_v1.availability.status, 'out_of_stock');
  assert.equal(row.commerce_facts_v1.regional_price.amount, 26, 'a gone answer carries no price');
  assert.deepEqual(row.payment_pricing, { note: 'stored' }, 'the price did not change: its copy stays');
  assert.equal(nested(gone.payload, 'price_promo').data.promotions.length, 1, 'no new price: the promotion stays');
  const repriced = applyPdpLiveOverlay(page(promoted, { offers }), {
    market: 'US', isCardOffer, presentationFields: ['payment_pricing'],
    cache: cacheWith(verifiedRead({ [LEMON]: { amount: 24, currency: 'USD', available: true } })),
  });
  const r2 = top(repriced.payload, 'offers').data.offers[0];
  assert.equal(r2.availability, 'in_stock');
  assert.equal(r2.commerce_facts_v1.regional_price.amount, 24);
  assert.equal(r2.commerce_facts_v1.regional_price.display_raw, null);
  assert.equal(r2.commerce_facts_v1.regional_price.compare_at_amount, null);
  assert.equal('payment_pricing' in r2, false, 'savings copy computed against $26 does not describe $24');
  const promo = nested(repriced.payload, 'price_promo');
  assert.deepEqual(promo.data.promotions, []);
});

test('review 5: a default the merchant was not asked about keeps the card\'s price', () => {
  const product = sellerProduct({ default_variant_id: 'X-SKU-BLUE', price: { amount: 30, currency: 'USD' } });
  product.variants = [
    { variant_id: LEMON, title: 'Red', options: [{ name: 'Color', value: 'Red' }], price: { amount: 26, currency: 'USD' }, in_stock: true },
    { variant_id: 'X-SKU-BLUE', title: 'Blue', options: [{ name: 'Color', value: 'Blue' }], price: { amount: 30, currency: 'USD' }, in_stock: true },
  ];
  const p = page(product);
  const out = applyPdpLiveOverlay(p, { market: 'US', cache: cacheWith(verifiedRead({ [LEMON]: { amount: 18, currency: 'USD', available: true } })) });
  const card = cardOf(out.payload);
  assert.equal(String(card.default_variant_id), 'X-SKU-BLUE');
  assert.equal(card.price.current.amount, cardOf(p).price.current.amount, 'the card still shows Blue\'s price');
  assert.equal(card.price_source, cardOf(p).price_source);
  assert.equal(byId(card.variants).get(LEMON).price.current.amount, 18, 'Red itself is updated');
});

test('review 6: the card\'s own row in another currency is left whole (no two-currency row)', () => {
  const offers = {
    offers: [{
      offer_id: 'of_jp', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
      price: { amount: 3300, currency: 'JPY' },
      variants: [{ variant_id: LEMON, price: { current: { amount: 3300, currency: 'JPY' } } }],
    }],
  };
  const p = page(sellerProduct(), { offers });
  const out = applyPdpLiveOverlay(p, { market: 'US', isCardOffer: () => true,
    cache: cacheWith(verifiedRead({ [LEMON]: { amount: 24, currency: 'USD', available: true } })) });
  assert.equal(top(out.payload, 'offers').data.offers[0], offers.offers[0]);
});

// ------------------------------------------------------------- PR controller review of #2448, round 2

const rowOf = (out, id) => top(out.payload, 'offers').data.offers.find((x) => x.offer_id === id);
const lemonAt = (amount, extra = {}) => cacheWith(verifiedRead({ [LEMON]: { amount, currency: 'USD', available: true } }, extra));

test('round 2 #1: a row whose variant the CARD shows unavailable is left whole (the row lost the marker)', () => {
  const product = sellerProduct();
  product.variants[0] = { ...product.variants[0], current_own_offer_status: 'unavailable' };
  const offers = {
    best_price_offer_id: 'of_other',
    offers: [
      { offer_id: 'of_other', merchant_id: 'n', product_id: 'x', price: { amount: 22, currency: 'USD' }, inventory: { in_stock: true } },
      // What the offer projection emits: no current_own_offer_status on the row or its variants.
      { offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
        price: { amount: 26, currency: 'USD' }, inventory: { in_stock: false },
        variants: [{ variant_id: LEMON, price: { current: { amount: 26, currency: 'USD' } }, availability: { in_stock: false } }] },
    ],
  };
  const isCardOffer = (card, offer) => offer.offer_id === 'of_card';
  const cache = cacheWith(verifiedRead({
    [LEMON]: { amount: 19, currency: 'USD', available: true },
    [BERRY]: { amount: 26, currency: 'USD', available: true },
  }));
  const out = applyPdpLiveOverlay(page(product, { offers }), { market: 'US', cache, isCardOffer });
  assert.equal(rowOf(out, 'of_card'), offers.offers[1], 'the row is the same object');
  assert.equal(top(out.payload, 'offers').data.best_price_offer_id, 'of_other');
  assert.equal(byId(cardOf(out.payload).variants).get(LEMON).current_own_offer_status, 'unavailable');
  // And a row that carries the marker itself is left whole too.
  const marked = { offers: [{ ...offers.offers[1], current_own_offer_status: 'unavailable' }] };
  const out2 = applyPdpLiveOverlay(page(sellerProduct(), { offers: marked }), { market: 'US', cache, isCardOffer });
  assert.equal(rowOf(out2, 'of_card'), marked.offers[0]);
  // A row selling another variant keeps its copy of the withheld one as it is, and takes its own.
  const berryRow = { offers: [{ ...offers.offers[1], selected_variant_id: BERRY,
    variants: [...offers.offers[1].variants, { variant_id: BERRY, price: { current: { amount: 26, currency: 'USD' } }, availability: { in_stock: true } }] }] };
  const out3 = applyPdpLiveOverlay(page(product, { offers: berryRow }), { market: 'US', cache, isCardOffer });
  const r3 = byId(rowOf(out3, 'of_card').variants);
  assert.equal(r3.get(LEMON), berryRow.offers[0].variants[0], 'the withheld variant\'s copy is untouched');
  assert.equal(r3.get(BERRY).live_read.status, STATUS.VERIFIED);
});

test('round 2 #2: an answer for another product page (its handle) is never this card\'s', () => {
  const other = cacheWith(verifiedRead({ [LEMON]: { amount: 99, currency: 'USD', available: true } }, { handle: 'some-other-product' }));
  assert.equal(applyPdpLiveOverlay(page(), { market: 'US', cache: other }), null);
  // Nor is a "gone" read beside another page's answers.
  const goneElsewhere = cacheWith(verifiedRead({ [BERRY]: { amount: 5, currency: 'USD', available: true } },
    { notFound: [LEMON], handle: 'some-other-product' }));
  assert.equal(applyPdpLiveOverlay(page(), { market: 'US', cache: goneElsewhere }), null);
  // A card with no product page on the merchant's store has nothing to match: unchanged.
  const noPage = sellerProduct({ destination_url: `https://${HOST}/pages/landing` });
  assert.equal(applyPdpLiveOverlay(page(noPage), { market: 'US', cache: lemonAt(24) }), null);
  // A product page on ANOTHER store names no page of this one.
  const elsewhere = sellerProduct({ destination_url: `https://${HOST}/pages/landing`, source_url: `https://other-store.example/products/${HANDLE}` });
  assert.equal(applyPdpLiveOverlay(page(elsewhere), { market: 'US', cache: lemonAt(24) }), null);
  // A Markets subfolder is the same page.
  const sub = sellerProduct({ destination_url: `https://${HOST}/en-us/products/${HANDLE}` });
  const out = applyPdpLiveOverlay(page(sub), { market: 'US', cache: lemonAt(24) });
  assert.equal(cardOf(out.payload).price.current.amount, 24);
});

test('a KR store page (percent-encoded Hangul handle) takes the answer the merchant gave for that page only', () => {
  // The answer as the real reader parses a lookup_catalog payload; its `handle` in either form.
  const KO = '라네즈-립-슬리핑-마스크';
  const enc = encodeURIComponent(KO);
  const answeredAs = (handle) => cacheWith({
    status: STATUS.VERIFIED, host: HOST, country: 'US', currency: 'USD', notFound: new Set(), askedIds: [LEMON],
    live: parseLookup({ products: [{ id: 'gid://shopify/Product/1', handle,
      variants: [{ id: `gid://shopify/ProductVariant/${LEMON}`, price: { amount: 2400, currency: 'USD' }, availability: { available: true } }] }] }).variants,
  });
  const kr = sellerProduct({ destination_url: `https://${HOST}/ko/products/${enc}` });
  for (const handle of [KO, enc]) {
    const out = applyPdpLiveOverlay(page(kr), { market: 'US', cache: answeredAs(handle) });
    assert.ok(out, `answered as ${handle}`);
    assert.equal(cardOf(out.payload).price.current.amount, 24);
  }
  // zh-hant, an underscore handle and a .json link are the same page too.
  for (const [url, handle] of [[`https://${HOST}/zh-hant/products/${HANDLE}`, HANDLE], [`https://${HOST}/products/lip_mask`, 'lip_mask'],
    [`https://${HOST}/products/${HANDLE}.json`, HANDLE]]) {
    const out = applyPdpLiveOverlay(page(sellerProduct({ destination_url: url })), { market: 'US', cache: answeredAs(handle) });
    assert.ok(out, url);
  }
  // Another Korean product's answer is never this page's.
  assert.equal(applyPdpLiveOverlay(page(kr), { market: 'US', cache: answeredAs('라네즈-립-밤') }), null);
});

test('round 2 #3: agent-safe facts price and every promotion follow a changed price', () => {
  const facts = {
    regional_price: { amount: 26, currency: 'USD', display_raw: '$26.00' },
    availability: { status: 'in_stock' },
    promotions: [{ label: '10% off', confidence: 'high' }],
  };
  const offers = {
    offers: [{
      offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
      price: { amount: 26, currency: 'USD' }, inventory: { in_stock: true }, promotions: [{ label: '10% off' }],
      commerce_facts_v1: facts,
      agent_safe_commerce_facts: { price: { amount: 26, currency: 'USD', display_raw: '$26.00' }, availability: { status: 'in_stock' }, promotions: [{ label: '10% off' }] },
    }],
  };
  const out = applyPdpLiveOverlay(page(sellerProduct(), { offers }), { market: 'US', isCardOffer: () => true, cache: lemonAt(20) });
  const row = rowOf(out, 'of_card');
  assert.equal(row.agent_safe_commerce_facts.price.amount, 20);
  assert.equal(row.agent_safe_commerce_facts.price.display_raw, null);
  assert.deepEqual(row.agent_safe_commerce_facts.promotions, []);
  assert.deepEqual(row.commerce_facts_v1.promotions, []);
  assert.deepEqual(row.promotions, []);
  // Confirmed: promotions stay.
  const same = rowOf(applyPdpLiveOverlay(page(sellerProduct(), { offers }), { market: 'US', isCardOffer: () => true, cache: lemonAt(26) }), 'of_card');
  assert.equal(same.promotions.length, 1);
  assert.equal(same.agent_safe_commerce_facts.promotions.length, 1);
});

test('round 2 #4: order and best price key on the rows whose total changed, by the producer\'s comparator', () => {
  const offers = {
    best_price_offer_id: 'of_other',
    offers: [
      { offer_id: 'of_other', merchant_id: 'n', product_id: 'x', price: { amount: 22, currency: 'USD' }, inventory: { in_stock: true } },
      { offer_id: 'of_lemon', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
        price: { amount: 26, currency: 'USD' }, inventory: { in_stock: true } },
      { offer_id: 'of_berry', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: BERRY,
        price: { amount: 26, currency: 'USD' }, inventory: { in_stock: true } },
    ],
  };
  const isCardOffer = (card, offer) => offer.merchant_id === 'merch_obs_laneige';
  const cache = cacheWith(verifiedRead({
    [LEMON]: { amount: 26, currency: 'USD', available: true }, // confirmed: changes nothing
    [BERRY]: { amount: 10, currency: 'USD', available: true },
  }));
  const out = applyPdpLiveOverlay(page(sellerProduct(), { offers }), { market: 'US', cache, isCardOffer });
  const data = top(out.payload, 'offers').data;
  assert.equal(data.best_price_offer_id, 'of_berry');
  assert.deepEqual(data.offers.map((x) => x.offer_id), ['of_berry', 'of_other', 'of_lemon']);
});

test('round 2 #5: the card claims `verified` only when its default variant was re-read', () => {
  const onlyBerry = applyPdpLiveOverlay(page(), { market: 'US',
    cache: cacheWith(verifiedRead({ [BERRY]: { amount: 20, currency: 'USD', available: true } })) });
  const card = cardOf(onlyBerry.payload);
  assert.equal(card.live_read.status, 'variants_only');
  assert.equal(card.price.current.amount, 26, 'the default variant\'s stored price, not re-read');
  assert.notEqual(card.price_source, 'merchant_live');
  const defaultGone = applyPdpLiveOverlay(page(), { market: 'US',
    cache: cacheWith(verifiedRead({ [BERRY]: { amount: 20, currency: 'USD', available: true } }, { notFound: [LEMON] })) });
  assert.equal(cardOf(defaultGone.payload).live_read.status, STATUS.VARIANT_GONE);
  assert.equal(cardOf(applyPdpLiveOverlay(page(), { market: 'US', cache: lemonAt(24) }).payload).live_read.status, STATUS.VERIFIED);
});

test('round 2 #6 + host guard: www. is the same store on the row; another store is not', () => {
  const row = (url) => ({ offers: [{ offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
    price: { amount: 26, currency: 'USD' }, inventory: { in_stock: true }, destination_url: url }] });
  const www = row(`https://www.${HOST}/products/${HANDLE}`);
  assert.equal(rowOf(applyPdpLiveOverlay(page(sellerProduct(), { offers: www }), { market: 'US', isCardOffer: () => true, cache: lemonAt(24) }), 'of_card').price.amount, 24);
  const elsewhere = row(`https://other-store.example/products/${HANDLE}`);
  const out = applyPdpLiveOverlay(page(sellerProduct(), { offers: elsewhere }), { market: 'US', isCardOffer: () => true, cache: lemonAt(24) });
  assert.equal(rowOf(out, 'of_card'), elsewhere.offers[0]);
});

test('round 2 #7: product_intel offer pointers move with the best-price mark', () => {
  const offers = {
    best_price_offer_id: 'of_card',
    offers: [
      { offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON, price: { amount: 22, currency: 'USD' }, inventory: { in_stock: true } },
      { offer_id: 'of_other', merchant_id: 'n', product_id: 'x', price: { amount: 23, currency: 'USD' }, inventory: { in_stock: true } },
    ],
  };
  const p = page(sellerProduct(), { offers });
  p.modules.push({ type: 'product_intel', data: { offer_pointers: { default_offer_id: 'of_card', best_price_offer_id: 'of_card' } } });
  const out = applyPdpLiveOverlay(p, { market: 'US', isCardOffer: (c, o) => o.offer_id === 'of_card', cache: lemonAt(24) });
  assert.equal(top(out.payload, 'offers').data.best_price_offer_id, 'of_other');
  assert.equal(top(out.payload, 'product_intel').data.offer_pointers.best_price_offer_id, 'of_other');
  assert.equal(top(out.payload, 'product_intel').data.offer_pointers.default_offer_id, 'of_card');
});

test('one variant gone and the rest unanswered never marks the whole card sold out', () => {
  const out = applyPdpLiveOverlay(page(sellerProduct({ in_stock: true })), { market: 'US',
    cache: cacheWith(verifiedRead({ [BERRY]: { amount: 26, currency: 'USD', available: false } }, { notFound: [LEMON] })) });
  const card = cardOf(out.payload);
  assert.equal(byId(card.variants).get(LEMON).availability.in_stock, false);
  assert.equal(card.availability.in_stock, cardOf(page(sellerProduct({ in_stock: true }))).availability.in_stock,
    'Vanilla was not answered: the card keeps its stored stock');
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
        live: new Map([['${LEMON}', { amount: 24, currency: 'USD', available: true, handle: 'lsm' }]]), notFound: new Set() });
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

test('THROUGH THE SERVER: the real reader fills the cache, the next view is served live, a busy store releases its claim', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const builder = path.join(__dirname, '..', 'src', 'pdpBuilder.js');
  const code = `
    const srv = require(${JSON.stringify(server)})._debug;
    const { buildPdpPayload } = require(${JSON.stringify(builder)});
    const LEMON = '${LEMON}';
    let open; const gate = new Promise((r) => { open = r; });
    const wrap = (payload) => ({ ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    // A fake merchant: no store is contacted. busy.example never answers until the gate opens.
    srv.useUcpLiveClientForTest({
      async discoverEndpoint(base) { return { mcpEndpoint: base + '/api/ucp/mcp', status: 200 }; },
      async lookupCatalog(endpoint, { ids }) {
        if (endpoint.includes('busy.example')) await gate;
        const vs = ids.filter((id) => id.endsWith('/' + LEMON))
          .map((id) => ({ id, price: { amount: 2400, currency: 'USD' }, availability: { available: true } }));
        return wrap({ products: vs.length ? [{ id: 'gid://shopify/Product/1', handle: 'lsm', variants: vs }] : [],
          messages: ids.filter((id) => !id.endsWith('/' + LEMON)).map((id) => ({ type: 'info', code: 'not_found', content: id })) });
      },
    });
    const cardPage = (host, variants) => {
      const pdp = buildPdpPayload({ relatedProducts: [], entryPoint: 'agent', product: {
        product_id: 'ext_lsm', merchant_id: 'merch_obs_laneige', title: 'LSM', image_url: 'https://cdn.example/a.jpg',
        currency: 'USD', price: { amount: 26, currency: 'USD' }, destination_url: 'https://' + host + '/products/lsm', variants } });
      return { modules: [
        { type: 'canonical', data: { pdp_payload: pdp } },
        { type: 'offers', data: { best_price_offer_id: 'of_card', offers: [
          { offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
            price: { amount: 26, currency: 'USD' }, inventory: { in_stock: false } },
          { offer_id: 'of_other', merchant_id: 'merch_obs_other', product_id: 'ext_other', price: { amount: 25, currency: 'USD' }, inventory: { in_stock: true } },
        ] } },
      ] };
    };
    (async () => {
      const page = cardPage('us.laneige.com', [{ variant_id: LEMON, title: 'Lemon', price: { amount: 26, currency: 'USD' }, in_stock: false }]);
      const started = srv.shadowPdpLiveRead(page, { market: 'US', pageState: 'served', random: () => 0 });
      let served = page;
      for (let i = 0; i < 200 && served === page; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        served = srv.livePdpOverlay(page, { market: 'US' });
      }
      const card = served.modules[0].data.pdp_payload.product;
      const row = served.modules[1].data.offers.find((o) => o.offer_id === 'of_card');
      // A store busy with one product's full read (3 lookups) refuses a second product, and releases its claim.
      const many = Array.from({ length: 30 }, (_, i) => ({ variant_id: String(100000000001 + i), title: 'S' + i, price: { amount: 5, currency: 'USD' } }));
      srv.shadowPdpLiveRead(cardPage('busy.example', many), { market: 'US', pageState: 'served', random: () => 0 });
      await new Promise((r) => setTimeout(r, 50));
      const other = cardPage('busy.example', [{ variant_id: '200000000001', title: 'X', price: { amount: 5, currency: 'USD' } }]);
      srv.shadowPdpLiveRead(other, { market: 'US', pageState: 'served', random: () => 0 });
      await new Promise((r) => setTimeout(r, 50));
      const reclaimed = srv.shadowPdpLiveRead(other, { market: 'US', pageState: 'served', random: () => 0 });
      open();
      console.log(JSON.stringify({ started, price: card.price.current.amount, inStock: card.availability.in_stock,
        rowPrice: row.price.amount, rowInStock: row.inventory.in_stock, reclaimed }));
      setTimeout(() => process.exit(0), 50);
    })();`;
  const childEnv = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete childEnv[k];
  Object.assign(childEnv, { UCP_LIVE_PDP_READ: 'enforce', UCP_LIVE_PDP_READ_SAMPLE: '1' });
  const r = spawnSync(process.execPath, ['-e', code], { env: childEnv, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const out = JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"started"')));
  assert.deepEqual(out, { started: true, price: 24, inStock: true, rowPrice: 24, rowInStock: true, reclaimed: true });
});

test('STRUCTURAL: only the normally served get_pdp_v2 return takes the overlay', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf('      const shadowPdpRead = (pageState) => shadowPdpLiveRead(responsePayload, {');
  assert.ok(i > 0);
  const block = src.slice(i, src.indexOf('} catch (err) {', i));
  assert.equal((block.match(/livePdpOverlay\(/g) || []).length, 1);
  // The served arm: the overlay, inside the first-view refresh descriptor (pdpLiveRefresh.js), which adds a
  // top-level `live_refresh` and changes nothing else.
  assert.match(block, /return res\.json\(canonicalOwnMoneyGap\s+\? withoutCanonicalPurchaseActions\(responsePayload\)\s+: withPdpLiveRefreshDescriptor\(livePdpOverlay\(responsePayload, \{\s+market: offersGateBuyerMarket\(payload, metadata\),/);
  const g = src.indexOf('function getUcpLivePdpReader()');
  assert.match(src.slice(g, g + 700), /mode: MODES\.SHADOW,/, 'the reader itself never touches the page');
});
