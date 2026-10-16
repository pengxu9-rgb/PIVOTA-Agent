'use strict';

// get_offers' best_offer under the FRESH-PRICE contract of pivota-backend #2635. In a resolved content_key group
// offers.resolve marks the offers eligible for a best price `price_comparable: true` (an exact or same-size
// member, a fresh price, a stated ISO currency), marks a price that is not fresh `price_stale: true` with its
// last read `price_checked_at`, and names `best_price_offer_id` (id or null). Before this the gateway ranked on
// raw amount, so a cheap stale price, another size, or a smaller number in another currency was the headline.
//
// Every case runs the REAL handler (makeGetOffers over mapOffersResolveResponse, and the real UCP live offer
// reader over a fake merchant store when a market is declared) on a fixture offers.resolve response.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The reader's deadline timers are unref'd; keep the loop alive for the file (see get_offers_live_cart).
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(keepAlive));

const { mapOffersResolveResponse } = require('../src/agentSignals/intelligenceReads');
const { FIXED_NOW, offer, runScenario, LEGACY_SCENARIOS } = require('./fixtures/get_offers_best_price_scenarios.cjs');

const READ_AT = '2026-10-15T08:00:00+00:00';
// A fresh price eligible for a best price, as offers.resolve marks it.
const COMPARABLE = { price_comparable: true, price_checked_at: READ_AT };
// A fresh price NOT eligible (another size, a variant-less offer): no marker.
const FRESH_ONLY = { price_checked_at: READ_AT };
const STALE = { price_stale: true, price_checked_at: null };
const best = (res) => res.best_offer && { merchant: res.best_offer.value.merchant_id, price: res.best_offer.value.price };
const signalOf = (res, merchant) => res.signals.find((s) => s.value.merchant_id === merchant);

// ------------------------------------------------------------------------------------------------- parity

test('neither field sent: every answer is byte-identical to origin/main (golden)', async () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/get_offers_best_offer_parity_golden.json'), 'utf8'));
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(LEGACY_SCENARIOS).sort());
  for (const [name, scn] of Object.entries(LEGACY_SCENARIOS)) {
    const res = await runScenario(scn);
    assert.equal(JSON.stringify(res, null, 2), JSON.stringify(golden[name], null, 2), name);
  }
  // The golden pins today's raw-amount pick across currencies, which only the contract changes.
  assert.equal(golden.no_market_mixed_currencies.best_offer.value.currency, 'GBP');
});

test('LOW 4: price_checked_at ALONE does not switch the contract on: no price_as_of, observed_at is still updated_at', async () => {
  const scn = LEGACY_SCENARIOS.no_market_mixed_currencies;
  const withRead = JSON.parse(JSON.stringify(scn));
  for (const o of withRead.backend.offers) o.price_checked_at = READ_AT;
  const res = await runScenario(withRead);
  const legacy = await runScenario(scn);
  assert.equal(JSON.stringify(res), JSON.stringify(legacy));
  assert.equal('price_as_of' in res.signals[0].value, false);
});

test('mapOffersResolveResponse relays best_price_offer_id only when the backend sent the key', () => {
  assert.deepEqual(Object.keys(mapOffersResolveResponse({ offers: [] })), ['offers', 'product_group_id']);
  assert.equal(mapOffersResolveResponse({ offers: [], best_price_offer_id: 'of:b' }).best_price_offer_id, 'of:b');
  const nulled = mapOffersResolveResponse({ offers: [], best_price_offer_id: null });
  assert.ok(Object.prototype.hasOwnProperty.call(nulled, 'best_price_offer_id'));
  assert.equal(nulled.best_price_offer_id, null);
});

// -------------------------------------------------------------------------------------- the comparable set

test('H1: a null best_price_offer_id over two sizes names NO best price, never the cheapest other size', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:brand50', 'brand.example.com', 30, 'USD', FRESH_ONLY),
        offer('of:mini15', 'mini.example.com', 12, 'USD', FRESH_ONLY),
      ],
      best_price_offer_id: null,
    },
  });
  assert.equal(res.best_offer, null);
  assert.deepEqual(res.metadata.best_price, { offer_id: null, reason: 'no_fresh_comparable_price', offers_resolve_offer_id: null });
  assert.equal(res.signals.length, 2, 'both offers are still listed');
});

test('H1: only a price_comparable offer can be best; a cheaper non-comparable size never is', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:brand50', 'brand.example.com', 30, 'USD', COMPARABLE),
        offer('of:mini15', 'mini.example.com', 12, 'USD', FRESH_ONLY),
      ],
      best_price_offer_id: 'of:brand50',
    },
  });
  assert.deepEqual(best(res), { merchant: 'brand.example.com', price: 30 });
  assert.deepEqual(res.metadata.best_price, {
    offer_id: 'of:brand50', price: 30, currency: 'USD', source: 'offers_resolve', offers_resolve_offer_id: 'of:brand50',
  });
});

test('a FRESH cheaper comparable offer wins, and the claim is the backend\'s when the picks agree', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:a', 'a.example.com', 24, 'USD', COMPARABLE),
        offer('of:b', 'b.example.com', 19, 'USD', COMPARABLE),
        offer('of:c', 'c.example.com', 16, 'USD', STALE),
      ],
      best_price_offer_id: 'of:b',
    },
  });
  assert.deepEqual(best(res), { merchant: 'b.example.com', price: 19 });
  assert.equal(res.metadata.best_price.source, 'offers_resolve');
});

test('a STALE cheaper offer loses to a FRESH dearer one, and is shown as stale and undated', async () => {
  const res = await runScenario({
    now: FIXED_NOW,
    backend: {
      offers: [
        offer('of:cheap', 'cheap.example.com', 13, 'USD', { ...STALE, price_comparable: true }),
        offer('of:fresh', 'fresh.example.com', 19.5, 'USD', COMPARABLE),
      ],
      best_price_offer_id: 'of:fresh',
    },
  });
  assert.deepEqual(best(res), { merchant: 'fresh.example.com', price: 19.5 });
  const cheap = signalOf(res, 'cheap.example.com');
  // Kept in the list, its price relayed, but flagged and never dated as current.
  assert.equal(cheap.value.price, 13);
  assert.equal(cheap.value.price_stale, true);
  assert.equal(cheap.value.price_as_of, null);
  assert.equal(cheap.freshness.observed_at, null, 'updated_at is a row write, not a price read');
  const fresh = signalOf(res, 'fresh.example.com');
  assert.equal('price_stale' in fresh.value, false);
  assert.equal(fresh.value.price_as_of, READ_AT);
  assert.equal(fresh.freshness.observed_at, READ_AT);
  // Everything an agent sees passes through the shared sanitizer: the flag and the date come through.
  const { sanitizeResult } = require('../safety-kernel/src/protocol/resultSanitizer.js');
  const out = sanitizeResult(res);
  assert.equal(out.signals.find((s) => s.value.merchant_id === 'cheap.example.com').value.price_stale, true);
  assert.equal(out.best_offer.value.price_as_of, READ_AT);
});

test('M3: every price stale names NO best price, even though offers are listed', async () => {
  for (const id of [null, undefined]) {
    const res = await runScenario({
      backend: {
        offers: [
          offer('of:a', 'a.example.com', 21, 'USD', { ...STALE, price_comparable: true }),
          offer('of:b', 'b.example.com', 18, 'USD', STALE),
        ],
        ...(id === null ? { best_price_offer_id: null } : {}),
      },
    });
    assert.equal(res.best_offer, null, String(id));
    assert.equal(res.metadata.best_price.reason, 'no_fresh_comparable_price');
    assert.equal(signalOf(res, 'b.example.com').value.price_stale, true);
  }
});

// ------------------------------------------------------------------------------------------ one ranking

test('M2: ONE ranking -- the gateway\'s compare over the comparable fresh set; the backend id only sources the claim', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        // Cheapest, but the backend's own live check FAILED on it: the gateway's stock tier ranks it below.
        offer('of:a', 'a.example.com', 18, 'USD', { ...COMPARABLE, stock_verified: false }),
        offer('of:b', 'b.example.com', 20, 'USD', COMPARABLE),
      ],
      best_price_offer_id: 'of:a',
    },
  });
  assert.deepEqual(best(res), { merchant: 'b.example.com', price: 20 });
  assert.deepEqual(res.metadata.best_price, {
    offer_id: 'of:b', price: 20, currency: 'USD', source: 'gateway', offers_resolve_offer_id: 'of:a',
  });
});

test('a best_price_offer_id the answer does not serve (market-currency filter) is reported, not followed', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    backend: {
      offers: [offer('of:gbp', 'uk.example.co.uk', 5, 'GBP', COMPARABLE), offer('of:usd', 'us.example.com', 22, 'USD', COMPARABLE)],
      best_price_offer_id: 'of:gbp',
    },
  });
  assert.deepEqual(best(res), { merchant: 'us.example.com', price: 22 });
  assert.equal(res.metadata.best_price.source, 'gateway');
  assert.equal(res.metadata.best_price.offers_resolve_offer_id, 'of:gbp');
});

test('LOW 1: with no market and limit > 10, the best price is among the SERVED signals only', async () => {
  const offers = [];
  for (let i = 0; i < 11; i += 1) offers.push(offer(`of:${i}`, `s${i}.example.com`, 40 - i, 'USD', COMPARABLE));
  offers.push(offer('of:cheapest', 'cheapest.example.com', 5, 'USD', COMPARABLE));
  const res = await runScenario({ payload: { limit: 12 }, backend: { offers, best_price_offer_id: 'of:cheapest' } });
  assert.equal(res.signals.length, 10);
  assert.ok(res.signals.includes(res.best_offer), 'best_offer is a served signal');
  assert.deepEqual(best(res), { merchant: 's9.example.com', price: 31 });
  assert.equal(res.metadata.best_price.source, 'gateway');
});

// ------------------------------------------------------------------------------------------- live read

const LIVE_STORES = {
  'flag.example.com': { handle: 'cream', US: [{ id: '42222222', amount: 1700, currency: 'USD', available: true }] },
};

function liveReadable(host, vid, price, extra = {}) {
  return offer(`of:${host.split('.')[0]}`, host, price, 'USD', {
    execution_spec: { merchant_domain: host, variant_id: vid, cart_url: `https://${host}/cart/${vid}:1?country=US` },
    ...extra,
  });
}

test('an offer the gateway LIVE-VERIFIED this request is fresh, whatever the backend flagged; its live price applies', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: LIVE_STORES,
    backend: {
      offers: [
        liveReadable('flag.example.com', '42222222', 15, { ...STALE, price_comparable: true }),
        offer('of:other', 'other.example.com', 18, 'USD', COMPARABLE),
      ],
      // Picked by the backend BEFORE the live read, on the stored facts.
      best_price_offer_id: 'of:other',
    },
  });
  const flag = signalOf(res, 'flag.example.com');
  assert.equal(flag.value.live_read.status, 'verified');
  assert.deepEqual(best(res), { merchant: 'flag.example.com', price: 17 }, 'the live $17, not the stored $15');
  assert.equal(res.metadata.best_price.source, 'gateway');
  assert.equal('price_stale' in flag.value, false);
  assert.equal(flag.value.price_as_of, new Date(FIXED_NOW).toISOString());
  assert.equal(flag.freshness.observed_at, new Date(FIXED_NOW).toISOString());
});

test('the backend\'s pick, re-read live, is still the best price -- sourced to the gateway\'s read', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: LIVE_STORES,
    backend: {
      offers: [liveReadable('flag.example.com', '42222222', 17, COMPARABLE), offer('of:other', 'other.example.com', 18, 'USD', COMPARABLE)],
      best_price_offer_id: 'of:flag',
    },
  });
  assert.deepEqual(best(res), { merchant: 'flag.example.com', price: 17 });
  assert.equal(res.metadata.best_price.source, 'gateway');
});

test('a stale-flagged offer the live read could NOT verify stays stale and loses', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: {}, // not a UCP store: the read fails, nothing is verified
    backend: {
      offers: [
        liveReadable('flag.example.com', '42222222', 15, { ...STALE, price_comparable: true }),
        offer('of:other', 'other.example.com', 18, 'USD', COMPARABLE),
      ],
    },
  });
  assert.notEqual(signalOf(res, 'flag.example.com').value.live_read.status, 'verified');
  assert.equal(signalOf(res, 'flag.example.com').value.price_stale, true);
  assert.deepEqual(best(res), { merchant: 'other.example.com', price: 18 });
});

test('M1: a CURRENCY_MISMATCH live read makes the backend\'s pick stale and sets it aside', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: { 'mm.example.com': { handle: 'cream', US: [{ id: '44444444', amount: 1200, currency: 'GBP', available: true }] } },
    backend: {
      offers: [liveReadable('mm.example.com', '44444444', 15, COMPARABLE), offer('of:other', 'other.example.com', 18, 'USD', COMPARABLE)],
      best_price_offer_id: 'of:mm',
    },
  });
  const mm = signalOf(res, 'mm.example.com');
  assert.equal(mm.value.live_read.status, 'currency_mismatch');
  assert.equal(mm.value.merchant_price_verified, false);
  assert.equal(mm.value.price_stale, true);
  assert.deepEqual(best(res), { merchant: 'other.example.com', price: 18 });
  assert.equal(res.metadata.best_price.source, 'gateway');
});

test('M1: a currency_mismatch on ANOTHER offer still sets the backend\'s claim aside (sourced to the gateway)', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: { 'mm.example.com': { handle: 'cream', US: [{ id: '44444444', amount: 1200, currency: 'GBP', available: true }] } },
    backend: {
      offers: [offer('of:other', 'other.example.com', 14, 'USD', COMPARABLE), liveReadable('mm.example.com', '44444444', 15, COMPARABLE)],
      best_price_offer_id: 'of:other',
    },
  });
  assert.deepEqual(best(res), { merchant: 'other.example.com', price: 14 });
  assert.equal(res.metadata.best_price.source, 'gateway');
});

test('a backend pick the live read found GONE is not the best price: the merchant no longer has it', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: { 'gone.example.com': { handle: 'cream', US: [] } },
    backend: {
      offers: [liveReadable('gone.example.com', '43333333', 16, COMPARABLE), offer('of:other', 'other.example.com', 18, 'USD', COMPARABLE)],
      best_price_offer_id: 'of:gone',
    },
  });
  assert.equal(signalOf(res, 'gone.example.com').value.live_read.status, 'variant_gone');
  assert.deepEqual(best(res), { merchant: 'other.example.com', price: 18 });
  assert.equal(res.metadata.best_price.source, 'gateway');
});

test('a live-verified freshness-gated SEED offer (requires_live_verification) competes as fresh', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    liveVerificationOptIn: true,
    stores: LIVE_STORES,
    backend: {
      offers: [
        offer('of:flag', 'flag.example.com', 15, 'USD', {
          price_comparable: true,
          in_stock: undefined,
          availability: 'unknown',
          execution_spec: { merchant_domain: 'flag.example.com', variant_id: null, cart_url: null },
          requires_live_verification: { reasons: ['stale_snapshot'], price_stale: true, lookup_variant_id: '42222222' },
          source: { type: 'external_seed', seed_id: 'eps_flag', canonical_url: 'https://flag.example.com/products/cream' },
        }),
        offer('of:other', 'other.example.com', 18, 'USD', COMPARABLE),
      ],
      best_price_offer_id: 'of:other',
    },
  });
  assert.equal(signalOf(res, 'flag.example.com').value.live_read.status, 'verified');
  assert.deepEqual(best(res), { merchant: 'flag.example.com', price: 17 });
});

// --------------------------------------------------------------------------------------------- currency

test('cross-currency offers are never compared: the first comparable offer\'s currency is the basis', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:usd', 'us.example.com', 30, 'USD', COMPARABLE),
        offer('of:gbp', 'uk.example.co.uk', 20, 'GBP', COMPARABLE),
        offer('of:jpy', 'jp.example.jp', 2000, 'JPY', STALE),
      ],
      best_price_offer_id: 'of:usd',
    },
  });
  // GBP 20 is the smaller NUMBER; it is not a smaller price.
  assert.deepEqual(best(res), { merchant: 'us.example.com', price: 30 });
  assert.equal(res.metadata.best_price.currency, 'USD');
});

test('a stale or non-comparable offer ranked first does not set the currency basis', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:usd-stale', 'stale.example.com', 10, 'USD', { ...STALE, price_comparable: true }),
        offer('of:usd-size', 'size.example.com', 9, 'USD', FRESH_ONLY),
        offer('of:gbp', 'uk.example.co.uk', 20, 'GBP', COMPARABLE),
        offer('of:usd', 'us.example.com', 30, 'USD', COMPARABLE),
      ],
      best_price_offer_id: 'of:gbp',
    },
  });
  assert.deepEqual(best(res), { merchant: 'uk.example.co.uk', price: 20 });
});

test('LOW 3: a comparable offer with no stated ISO currency is never in the pool', async () => {
  for (const currency of [null, '', 'dollars']) {
    const res = await runScenario({
      backend: {
        offers: [
          offer('of:blank', 'blank.example.com', 5, currency, COMPARABLE),
          offer('of:usd', 'us.example.com', 22, 'USD', COMPARABLE),
        ],
        best_price_offer_id: 'of:usd',
      },
    });
    assert.deepEqual(best(res), { merchant: 'us.example.com', price: 22 }, String(currency));
  }
  const none = await runScenario({
    backend: { offers: [offer('of:blank', 'blank.example.com', 5, '', COMPARABLE)], best_price_offer_id: null },
  });
  assert.equal(none.best_offer, null);
});

// ------------------------------------------------------------------------------------------ price_as_of

test('LOW 2: price_checked_at is relayed only as a valid ISO timestamp that is not in the future', async () => {
  const cases = [
    [READ_AT, READ_AT],
    ['2026-10-16T11:59:00Z', '2026-10-16T11:59:00Z'],
    ['2026-10-17T08:00:00+00:00', null], // after FIXED_NOW
    ['yesterday', null],
    ['2026-10-15', null],
    ['2026-13-45T99:00:00Z', null],
    [12345, null],
  ];
  for (const [given, want] of cases) {
    const res = await runScenario({
      now: FIXED_NOW,
      backend: { offers: [offer('of:a', 'a.example.com', 20, 'USD', { price_comparable: true, price_checked_at: given })], best_price_offer_id: 'of:a' },
    });
    assert.equal(res.signals[0].value.price_as_of, want, String(given));
    assert.equal(res.signals[0].freshness.observed_at, want, String(given));
  }
});

test('a variant_gone read on ANOTHER offer still sources the claim to the gateway', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: { 'gone.example.com': { handle: 'cream', US: [] } },
    backend: {
      offers: [offer('of:other', 'other.example.com', 14, 'USD', COMPARABLE), liveReadable('gone.example.com', '43333333', 15, COMPARABLE)],
      best_price_offer_id: 'of:other',
    },
  });
  assert.equal(signalOf(res, 'gone.example.com').value.live_read.status, 'variant_gone');
  assert.deepEqual(best(res), { merchant: 'other.example.com', price: 14 });
  assert.equal(res.metadata.best_price.source, 'gateway');
});

test('a `price_stale` key alone switches the contract on: the stale price is flagged and is not best', async () => {
  const res = await runScenario({
    backend: { offers: [offer('of:a', 'a.example.com', 12, 'USD', { price_stale: true }), offer('of:b', 'b.example.com', 20, 'USD')] },
  });
  assert.equal(signalOf(res, 'a.example.com').value.price_stale, true);
  assert.equal(res.best_offer, null);
  assert.equal(res.metadata.best_price.reason, 'no_fresh_comparable_price');
  assert.equal('offers_resolve_offer_id' in res.metadata.best_price, false, 'the backend sent no id');
});
