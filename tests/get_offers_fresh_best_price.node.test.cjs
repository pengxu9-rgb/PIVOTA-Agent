'use strict';

// get_offers' best_offer under the FRESH-PRICE contract of pivota-backend #2635: offers.resolve marks an offer
// whose price is not fresh `price_stale: true` and names `best_price_offer_id`, the cheapest FRESH offer in ONE
// currency. Before this the gateway ranked on price alone, so a cheap stale price was the headline answer.
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

const STALE = { price_stale: true, price_checked_at: null };
const FRESH = { price_checked_at: '2026-10-15T08:00:00+00:00' };
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

test('mapOffersResolveResponse relays best_price_offer_id only when the backend sent the key', () => {
  assert.deepEqual(Object.keys(mapOffersResolveResponse({ offers: [] })), ['offers', 'product_group_id']);
  assert.equal(mapOffersResolveResponse({ offers: [], best_price_offer_id: 'of:b' }).best_price_offer_id, 'of:b');
  const nulled = mapOffersResolveResponse({ offers: [], best_price_offer_id: null });
  assert.ok(Object.prototype.hasOwnProperty.call(nulled, 'best_price_offer_id'));
  assert.equal(nulled.best_price_offer_id, null);
});

// ------------------------------------------------------------------------------------------------ fresh first

test('a FRESH cheaper offer wins', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:a', 'a.example.com', 24, 'USD', FRESH),
        offer('of:b', 'b.example.com', 19, 'USD', FRESH),
        offer('of:c', 'c.example.com', 26, 'USD', STALE),
      ],
    },
  });
  assert.deepEqual(best(res), { merchant: 'b.example.com', price: 19 });
});

test('a STALE cheaper offer loses to a FRESH dearer one, and is shown as stale', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:cheap', 'cheap.example.com', 13, 'USD', STALE),
        offer('of:fresh', 'fresh.example.com', 19.5, 'USD', FRESH),
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
  assert.equal(fresh.value.price_as_of, '2026-10-15T08:00:00+00:00');
  assert.equal(fresh.freshness.observed_at, '2026-10-15T08:00:00+00:00');
  // Everything an agent sees passes through the shared sanitizer: the flag and the date come through.
  const { sanitizeResult } = require('../safety-kernel/src/protocol/resultSanitizer.js');
  const out = sanitizeResult(res);
  const cheapOut = out.signals.find((s) => s.value.merchant_id === 'cheap.example.com');
  assert.equal(cheapOut.value.price_stale, true);
  assert.equal(out.best_offer.value.price_as_of, '2026-10-15T08:00:00+00:00');
});

test('the same, with the backend sending no best_price_offer_id: the gateway skips the stale price itself', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:cheap', 'cheap.example.com', 13, 'USD', STALE),
        offer('of:fresh', 'fresh.example.com', 19.5, 'USD', FRESH),
      ],
    },
  });
  assert.deepEqual(best(res), { merchant: 'fresh.example.com', price: 19.5 });
});

test('every price stale: the cheapest stale one is best, and it says so', async () => {
  const res = await runScenario({
    backend: {
      offers: [offer('of:a', 'a.example.com', 21, 'USD', STALE), offer('of:b', 'b.example.com', 18, 'USD', STALE)],
      best_price_offer_id: null,
    },
  });
  assert.deepEqual(best(res), { merchant: 'b.example.com', price: 18 });
  assert.equal(res.best_offer.value.price_stale, true);
});

// ------------------------------------------------------------------------------------------- live read

const LIVE_STORES = {
  'flag.example.com': { handle: 'cream', US: [{ id: '42222222', amount: 1700, currency: 'USD', available: true }] },
};

function staleLiveReadable(extra = {}) {
  return offer('of:flag', 'flag.example.com', 15, 'USD', {
    ...STALE,
    execution_spec: { merchant_domain: 'flag.example.com', variant_id: '42222222', cart_url: 'https://flag.example.com/cart/42222222:1?country=US' },
    ...extra,
  });
}

test('an offer the gateway LIVE-VERIFIED this request is fresh, whatever the backend flagged; its live price applies', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: LIVE_STORES,
    backend: {
      offers: [staleLiveReadable(), offer('of:other', 'other.example.com', 18, 'USD', FRESH)],
      // Picked by the backend BEFORE the live read, on the stored facts: superseded by it.
      best_price_offer_id: 'of:other',
    },
  });
  const flag = signalOf(res, 'flag.example.com');
  assert.equal(flag.value.live_read.status, 'verified');
  assert.deepEqual(best(res), { merchant: 'flag.example.com', price: 17 }, 'the live $17, not the stored $15');
  assert.equal('price_stale' in flag.value, false);
  assert.equal(flag.value.price_as_of, new Date(FIXED_NOW).toISOString());
  assert.equal(flag.freshness.observed_at, new Date(FIXED_NOW).toISOString());
});

test('a stale-flagged offer the live read could NOT verify stays stale and loses', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: {}, // not a UCP store: the read fails, nothing is verified
    backend: {
      offers: [staleLiveReadable(), offer('of:other', 'other.example.com', 18, 'USD', FRESH)],
    },
  });
  assert.notEqual(signalOf(res, 'flag.example.com').value.live_read.status, 'verified');
  assert.equal(signalOf(res, 'flag.example.com').value.price_stale, true);
  assert.deepEqual(best(res), { merchant: 'other.example.com', price: 18 });
});

test('a live-verified freshness-gated SEED offer (requires_live_verification) competes as fresh', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    liveVerificationOptIn: true,
    stores: LIVE_STORES,
    backend: {
      offers: [
        offer('of:flag', 'flag.example.com', 15, 'USD', {
          in_stock: undefined,
          availability: 'unknown',
          execution_spec: { merchant_domain: 'flag.example.com', variant_id: null, cart_url: null },
          requires_live_verification: { reasons: ['stale_snapshot'], price_stale: true, lookup_variant_id: '42222222' },
          source: { type: 'external_seed', seed_id: 'eps_flag', canonical_url: 'https://flag.example.com/products/cream' },
        }),
        offer('of:other', 'other.example.com', 18, 'USD', FRESH),
      ],
      best_price_offer_id: 'of:other',
    },
  });
  assert.equal(signalOf(res, 'flag.example.com').value.live_read.status, 'verified');
  assert.deepEqual(best(res), { merchant: 'flag.example.com', price: 17 });
});

test('a backend pick the live read found GONE is not honoured: the merchant no longer has it', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    stores: { 'gone.example.com': { handle: 'cream', US: [] } },
    backend: {
      offers: [
        offer('of:gone', 'gone.example.com', 16, 'USD', {
          ...FRESH,
          execution_spec: { merchant_domain: 'gone.example.com', variant_id: '43333333', cart_url: 'https://gone.example.com/cart/43333333:1?country=US' },
        }),
        offer('of:other', 'other.example.com', 18, 'USD', FRESH),
      ],
      best_price_offer_id: 'of:gone',
    },
  });
  assert.equal(signalOf(res, 'gone.example.com').value.live_read.status, 'variant_gone');
  assert.deepEqual(best(res), { merchant: 'other.example.com', price: 18 });
});

// --------------------------------------------------------------------------------------------- currency

test('cross-currency offers are never compared: the first fresh offer\'s currency is the basis (no market)', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:usd', 'us.example.com', 30, 'USD', FRESH),
        offer('of:gbp', 'uk.example.co.uk', 20, 'GBP', FRESH),
        offer('of:jpy', 'jp.example.jp', 2000, 'JPY', STALE),
      ],
    },
  });
  // GBP 20 is the smaller NUMBER; it is not a smaller price.
  assert.deepEqual(best(res), { merchant: 'us.example.com', price: 30 });
});

test('a stale offer ranked first does not set the currency basis; the first FRESH one does', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:usd-stale', 'stale.example.com', 10, 'USD', STALE),
        offer('of:gbp', 'uk.example.co.uk', 20, 'GBP', FRESH),
        offer('of:usd', 'us.example.com', 30, 'USD', FRESH),
      ],
    },
  });
  assert.deepEqual(best(res), { merchant: 'uk.example.co.uk', price: 20 });
});

// --------------------------------------------------------------------------------------- backend's pick

test('best_price_offer_id is honoured when it names a served offer', async () => {
  const res = await runScenario({
    backend: {
      offers: [
        offer('of:a', 'a.example.com', 18, 'USD', FRESH),
        offer('of:b', 'b.example.com', 22, 'USD', FRESH),
      ],
      // The gateway's own order would name a.example.com; the backend's pick decides.
      best_price_offer_id: 'of:b',
      metadata: { best_price: { offer_id: 'of:b', price: 22, currency: 'USD', fresh_priced: 2, stale_priced: 0 } },
    },
  });
  assert.deepEqual(best(res), { merchant: 'b.example.com', price: 22 });
});

test('best_price_offer_id naming an offer this answer does not serve, or a null one, falls back to the fresh pick', async () => {
  for (const id of ['of:gone', null]) {
    const res = await runScenario({
      backend: {
        offers: [offer('of:a', 'a.example.com', 18, 'USD', STALE), offer('of:b', 'b.example.com', 22, 'USD', FRESH)],
        best_price_offer_id: id,
      },
    });
    assert.deepEqual(best(res), { merchant: 'b.example.com', price: 22 }, String(id));
  }
});

test('best_price_offer_id naming an offer the gateway reads as STALE is not honoured', async () => {
  const res = await runScenario({
    backend: {
      offers: [offer('of:a', 'a.example.com', 18, 'USD', STALE), offer('of:b', 'b.example.com', 22, 'USD', FRESH)],
      best_price_offer_id: 'of:a',
    },
  });
  assert.deepEqual(best(res), { merchant: 'b.example.com', price: 22 });
});

test('best_price_offer_id naming an offer withheld by the market-currency filter is not honoured', async () => {
  const res = await runScenario({
    payload: { market: 'US' },
    backend: {
      offers: [offer('of:gbp', 'uk.example.co.uk', 5, 'GBP', FRESH), offer('of:usd', 'us.example.com', 22, 'USD', FRESH)],
      best_price_offer_id: 'of:gbp',
    },
  });
  assert.deepEqual(best(res), { merchant: 'us.example.com', price: 22 });
});
