'use strict';

// GET_OFFERS_LIVE_CART: a flagged (freshness-gated) offer the merchant's live read just verified is asked for
// again with a SIGNED ASSERTION of that answer, so offers.resolve mints its cart (contract 2026-10-15).
//
// The first pass's live read is the REAL offer reader over a fake UCP client (the producer of `live_read`),
// and the backend is a fake offers.resolve that verifies the token the way the contract says the backend
// does. No merchant store and no backend is contacted.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The reader's deadline timers are unref'd; keep the loop alive for the file (see ucp_live_product_read).
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
require('node:test').after(() => clearInterval(keepAlive));

const {
  liveCartMode,
  readOfferLiveVerificationSecret,
  signOfferLiveVerification,
  offerLiveVerificationClaims,
  acceptedSecondPassOffer,
  adoptLiveCartOffer,
} = require('../src/services/offerLiveVerification');
const { createUcpLiveOfferReader } = require('../src/services/ucpLiveOfferRead');
const { makeGetOffers, mapOffersResolveResponse } = require('../src/agentSignals/intelligenceReads');

const SECRET = 'test-secret-offer-live-verification-0123456789';
const RB = 'www.rarebeauty.com';
const BLISS = '43734829564039';
const OTHER = '99999999999';

// ------------------------------------------------------------------------------------------------- token

test('signing reproduces the contract TEST VECTOR byte for byte', () => {
  const claims = { a: 24, av: true, c: 'USD', exp: 1792058120, h: 'us.laneige.com', iat: 1792058000, m: 'US', sid: 'eps_17a34f48ed404126a2970a5e', v: 1, vid: '31760703160372' };
  assert.equal(
    signOfferLiveVerification(claims, { secret: SECRET }),
    'v1.eyJhIjoyNCwiYXYiOnRydWUsImMiOiJVU0QiLCJleHAiOjE3OTIwNTgxMjAsImgiOiJ1cy5sYW5laWdlLmNvbSIsImlhdCI6MTc5MjA1ODAwMCwibSI6IlVTIiwic2lkIjoiZXBzXzE3YTM0ZjQ4ZWQ0MDQxMjZhMjk3MGE1ZSIsInYiOjEsInZpZCI6IjMxNzYwNzAzMTYwMzcyIn0.3rRzGuQVTiyP0IM1ZQ89T_x8HhfSowV2g_2N_YFfvgo',
  );
  // The serialisation is fixed: the caller's key order does not change the bytes.
  const shuffled = { vid: claims.vid, v: 1, sid: claims.sid, m: 'US', iat: claims.iat, h: claims.h, exp: claims.exp, c: 'USD', av: true, a: 24 };
  assert.equal(signOfferLiveVerification(shuffled, { secret: SECRET }), signOfferLiveVerification(claims, { secret: SECRET }));
});

test('iat is now (unix seconds) and exp = iat + 120 when the caller names neither', () => {
  const t = signOfferLiveVerification({ a: 24, av: false, c: 'USD', h: RB, m: 'US', sid: 'eps_rb', vid: BLISS }, { secret: SECRET, now: 1792058000999 });
  const claims = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.iat, 1792058000);
  assert.equal(claims.exp, 1792058120);
  assert.equal(claims.av, false);
  assert.deepEqual(Object.keys(claims), ['a', 'av', 'c', 'exp', 'h', 'iat', 'm', 'sid', 'v', 'vid']);
});

test('nothing is signed with a short secret, or for a claim the backend would reject', () => {
  const ok = { a: 24, av: true, c: 'USD', h: RB, m: 'US', sid: 'eps_rb', vid: BLISS };
  assert.ok(signOfferLiveVerification(ok, { secret: SECRET, now: 0 }));
  assert.equal(signOfferLiveVerification(ok, { secret: 'x'.repeat(31), now: 0 }), null, '31 bytes');
  assert.ok(signOfferLiveVerification(ok, { secret: 'x'.repeat(32), now: 0 }), '32 bytes');
  assert.equal(signOfferLiveVerification(ok, { now: 0 }), null, 'no secret');
  const bad = [
    { a: 0 }, { a: -1 }, { a: Infinity }, { a: '24' }, { av: 'true' }, { av: undefined }, { c: 'usd' }, { c: 'US' },
    { m: 'USA' }, { m: 'us' }, { sid: '' }, { sid: 42 }, { vid: 'gid://shopify/ProductVariant/1' }, { vid: 1234567 },
    { h: '' }, { v: 2 }, { iat: 100, exp: 401 }, { iat: 100, exp: 100 }, { iat: 1.5 },
  ];
  for (const b of bad) assert.equal(signOfferLiveVerification({ ...ok, ...b }, { secret: SECRET, now: 0 }), null, JSON.stringify(b));
  assert.ok(signOfferLiveVerification({ ...ok, iat: 100, exp: 400 }, { secret: SECRET }), 'a 300 s window is the most the backend accepts');
  // offers.resolve takes tokens of at most 2 KB.
  assert.ok(signOfferLiveVerification({ ...ok, sid: 's'.repeat(1000) }, { secret: SECRET, now: 0 }).length <= 2048);
  assert.equal(signOfferLiveVerification({ ...ok, sid: 's'.repeat(1600) }, { secret: SECRET, now: 0 }), null);
});

test('GET_OFFERS_LIVE_CART is off unless shadow or on; the secret needs 32 bytes', () => {
  assert.equal(liveCartMode({}), 'off');
  assert.equal(liveCartMode({ GET_OFFERS_LIVE_CART: ' ON ' }), 'on');
  assert.equal(liveCartMode({ GET_OFFERS_LIVE_CART: 'shadow' }), 'shadow');
  assert.equal(liveCartMode({ GET_OFFERS_LIVE_CART: 'enforce' }), 'off');
  assert.equal(liveCartMode({ GET_OFFERS_LIVE_CART: 'true' }), 'off');
  assert.equal(readOfferLiveVerificationSecret({}), '');
  assert.equal(readOfferLiveVerificationSecret({ OFFER_LIVE_VERIFICATION_SECRET: 'short' }), '');
  assert.equal(readOfferLiveVerificationSecret({ OFFER_LIVE_VERIFICATION_SECRET: ` ${SECRET} ` }), SECRET);
});

// ------------------------------------------------------------------------------------ fakes (no network)

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

function liveVariant(id, amount, currency, available) {
  return { id: `gid://shopify/ProductVariant/${id}`, title: 'Shade', price: { amount, currency }, availability: { available } };
}

/** A fake UCP store (the shape live Shopify stores answer in): per country, the variants it answers. */
function fakeUcpClient(store) {
  return {
    async discoverEndpoint(base) {
      return { mcpEndpoint: `${base}/api/ucp/mcp` };
    },
    async lookupCatalog(endpoint, { ids, context }) {
      const variants = (store[context.address_country] || []).filter((v) => ids.includes(v.id));
      const missing = ids.filter((id) => !variants.some((v) => v.id === id));
      return toolResult({
        products: variants.length ? [{ id: 'gid://shopify/Product/1', handle: store.handle, variants }] : [],
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}

const rareBeauty = {
  US: [liveVariant(BLISS, 2500, 'USD', true), liveVariant(OTHER, 2500, 'USD', false)],
  handle: 'soft-pinch-liquid-blush',
};

function realReader(store = rareBeauty) {
  const r = createUcpLiveOfferReader({ ucpClient: fakeUcpClient(store), mode: 'enforce' });
  return (offers, ctx) => r.readOffers(offers, ctx);
}

function flaggedOffer(extra = {}) {
  // As offers.resolve returns it to an opted-in caller (pivota-backend #2629): no cart, no stock claim.
  return {
    offer_id: `of:external_seed:eps_rb:${BLISS}`,
    merchant_id: RB,
    price: 22,
    currency: 'USD',
    availability: 'unknown',
    purchase_route: 'affiliate_outbound',
    affiliate_url: 'https://api.pivota.cc/r?token=first',
    execution_spec: { merchant_domain: RB, variant_id: null, cart_url: null },
    requires_live_verification: { reasons: ['stale_snapshot'], price_stale: true, lookup_variant_id: BLISS },
    source: { type: 'external_seed', seed_id: 'eps_rb', canonical_url: `https://${RB}/products/soft-pinch-liquid-blush` },
    variants: [{ variant_id: BLISS, title: 'Bliss', price: 22, price_stale: true }, { variant_id: OTHER, title: 'Other', price: 22, price_stale: true }],
    ...extra,
  };
}

function freshOffer(extra = {}) {
  return {
    offer_id: 'of:other',
    merchant_id: 'other-store',
    price: 30,
    currency: 'USD',
    in_stock: true,
    purchase_route: 'affiliate_outbound',
    affiliate_url: 'https://api.pivota.cc/r?token=fresh-first',
    execution_spec: { variant_id: null, cart_url: null },
    source: { type: 'external_seed', seed_id: 'eps_other' },
    ...extra,
  };
}

/** The backend's check, as the contract states it: MAC over the RECEIVED part1, constant-time, window. */
function verifyToken(token, secret = SECRET, nowSec = Math.floor(Date.now() / 1000)) {
  const [ver, part1, mac] = String(token).split('.');
  if (ver !== 'v1' || !part1 || !mac) return null;
  const want = crypto.createHmac('sha256', secret).update(`offer_live_verification.v1.${part1}`).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const c = JSON.parse(Buffer.from(part1, 'base64url').toString('utf8'));
  if (c.exp <= nowSec || c.exp - c.iat > 300 || c.iat > nowSec + 30) return null;
  return c;
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** The backend's minting of an accepted seed, per the contract. */
function mintedOffer(o, c) {
  const { requires_live_verification: _f, availability: _a, ...rest } = clone(o);
  return {
    ...rest,
    price: c.a,
    currency: c.c,
    in_stock: c.av,
    affiliate_url: 'https://api.pivota.cc/r?token=minted',
    execution_spec: c.av
      ? { merchant_domain: RB, variant_id: c.vid, cart_url: `https://${RB}/cart/${c.vid}:1?country=${c.m}`, expected_item_total: c.a, expected_currency: c.c, expected_quantity: 1 }
      : { merchant_domain: RB, variant_id: null, cart_url: null },
    variants: [{ variant_id: c.vid, title: 'Bliss', price: c.a, in_stock: c.av }, { variant_id: OTHER, title: 'Other', price: 22, price_stale: true }],
    live_verification: { status: 'verified', source: 'gateway_live_read', checked_at: new Date(c.iat * 1000).toISOString(), amount: c.a, currency: c.c, variant_id: c.vid },
  };
}

/**
 * A fake offers.resolve. The first call returns `offers`; a call carrying live_verifications verifies each
 * token and returns every offer again (a fresh click id on each), the accepted flagged ones minted.
 */
function fakeBackend(offers, { mint = mintedOffer, secondPass = null, calls = [] } = {}) {
  const fetchOffers = async (args) => {
    calls.push(args);
    if (!args.live_verifications) return { offers: offers.map(clone) };
    if (secondPass) return secondPass(args);
    const accepted = new Map();
    for (const t of args.live_verifications) {
      const c = verifyToken(t);
      if (c) accepted.set(c.sid, c);
    }
    return {
      offers: offers.map((o) => {
        const c = o.requires_live_verification && accepted.get(o.source.seed_id);
        if (c && c.vid === o.requires_live_verification.lookup_variant_id && c.m === 'US' && c.c === 'USD') return mint(o, c);
        return { ...clone(o), affiliate_url: `${o.affiliate_url}-second` };
      }),
      live_verification_assertions: { received: args.live_verifications.length, accepted: accepted.size, rejected: {} },
    };
  };
  return { fetchOffers, calls };
}

function getOffers(offers, { mode = 'on', secret = SECRET, readOffersLive = realReader(), backend = {}, ...deps } = {}) {
  const be = fakeBackend(offers, backend);
  const logs = [];
  const handler = makeGetOffers({
    fetchOffers: be.fetchOffers,
    readOffersLive,
    liveVerificationOptIn: () => true,
    liveCartMode: () => mode,
    liveVerificationSecret: () => secret,
    log: (event, fields) => logs.push({ event, ...fields }),
    ...deps,
  });
  return { run: (payload = { product_id: 'sig_rb', market: 'US' }) => handler({ payload }), calls: be.calls, logs };
}

const signalFor = (res, merchantId) => res.signals.find((s) => s.value.merchant_id === merchantId);
// Shadow logs when its unawaited second call settles: let it.
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ------------------------------------------------------------------------------------- the offer reader

test('the reader keeps what the merchant answered on a verified live_read; the agent signal never shows it', async () => {
  const { offers } = await realReader()([flaggedOffer()], { market: 'US', currency: 'USD' });
  const lr = offers[0].live_read;
  assert.equal(lr.status, 'verified');
  assert.equal(lr.amount, 25);
  assert.equal(lr.currency, 'USD');
  assert.equal(lr.available, true);
  assert.equal(lr.variant_id, BLISS, 'the id the lookup asked for first');
  assert.equal(lr.host, RB);
  assert.equal(lr.handle, 'soft-pinch-liquid-blush');
  const { run } = getOffers([flaggedOffer()], { mode: 'off' });
  const res = await run();
  assert.deepEqual(Object.keys(res.best_offer.value.live_read).sort(), ['checked_at', 'expected_total_withheld', 'status', 'stored_price']);
});

// -------------------------------------------------------------------------------------------- the modes

test('off: no second call, and the answer is exactly today\'s', async () => {
  const { run, calls, logs } = getOffers([flaggedOffer(), freshOffer()], { mode: 'off' });
  const res = await run();
  assert.equal(calls.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'live_verifications'), false);
  assert.equal(logs.length, 0);
  const today = await makeGetOffers({ fetchOffers: fakeBackend([flaggedOffer(), freshOffer()]).fetchOffers, readOffersLive: realReader(), liveVerificationOptIn: () => true })(
    { payload: { product_id: 'sig_rb', market: 'US' } },
  );
  const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (['checked_at', 'observed_at', 'expected_total_expires_at'].includes(k) ? undefined : v)));
  assert.deepEqual(strip(res), strip(today));
});

test('shadow: the second call is made with the same arguments plus the tokens (a dry run), the first pass is served, and the log says what would change', async () => {
  const { run, calls, logs } = getOffers([flaggedOffer(), freshOffer()], { mode: 'shadow' });
  const res = await run();
  await settle();
  assert.equal(calls.length, 2);
  const { live_verifications: tokens, live_verifications_dry_run: dryRun, signal, ...rest } = calls[1];
  assert.deepEqual(rest, calls[0], 'the same arguments');
  assert.equal(dryRun, true, 'the backend records no issued clicks for a dry run');
  assert.ok(signal instanceof AbortSignal);
  assert.equal(calls[0].include_live_verification, true);
  assert.equal(tokens.length, 1);
  const claims = verifyToken(tokens[0]);
  assert.deepEqual(
    { a: claims.a, av: claims.av, c: claims.c, h: claims.h, m: claims.m, sid: claims.sid, v: claims.v, vid: claims.vid, ttl: claims.exp - claims.iat },
    { a: 25, av: true, c: 'USD', h: RB, m: 'US', sid: 'eps_rb', v: 1, vid: BLISS, ttl: 120 },
  );
  const rb = signalFor(res, RB);
  assert.equal(rb.value.execution_spec.cart_url, null, 'the first pass, no cart');
  assert.equal(rb.value.affiliate_url, 'https://api.pivota.cc/r?token=first');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'get_offers_live_cart');
  assert.equal(logs[0].mode, 'shadow');
  assert.equal(logs[0].asserted, 1);
  assert.equal(logs[0].accepted, 1);
  assert.equal(logs[0].cart_minted, 1);
  assert.ok(Number.isFinite(logs[0].ms));
  assert.deepEqual(logs[0].would_replace, [{ seed_id: 'eps_rb', cart_minted: true, expected_item_total: 25, expected_currency: 'USD' }]);
  assert.deepEqual(logs[0].backend, { received: 1, accepted: 1, rejected: {} });
});

test('shadow never waits for the second call: the answer returns at once, the log comes when it settles', { timeout: 5000 }, async () => {
  const gate = deferred();
  let seen = null;
  const { run, calls, logs } = getOffers([flaggedOffer()], {
    mode: 'shadow',
    backend: { secondPass: async (args) => { seen = args; await gate.promise; return { offers: [mintedOffer(flaggedOffer(), verifyToken(args.live_verifications[0]))] }; } },
  });
  const res = await run();
  assert.equal(calls.length, 2, 'fired');
  assert.equal(logs.length, 0, 'not awaited');
  assert.equal(res.best_offer.value.execution_spec.cart_url, null);
  assert.equal(seen.signal.aborted, false);
  gate.resolve();
  await settle();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].accepted, 1);
  // A shadow call that never answers is aborted at the deadline, and logged as a timeout.
  const hung = getOffers([flaggedOffer()], { mode: 'shadow', liveCartTimeoutMs: 300, backend: { secondPass: (args) => { seen = args; return new Promise(() => {}); } } });
  const t0 = Date.now();
  await hung.run();
  assert.ok(Date.now() - t0 < 250, 'returned before the deadline');
  assert.equal(seen.signal.aborted, false);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(seen.signal.aborted, true);
  assert.equal(hung.logs[0].error, 'timeout');
});

test('on: the verified flagged offer is replaced by the backend\'s minted one, keeping the first pass\'s live read', async () => {
  const { run, calls, logs } = getOffers([flaggedOffer(), freshOffer()], { mode: 'on' });
  const first = (await realReader()([flaggedOffer()], { market: 'US', currency: 'USD' })).offers[0];
  const res = await run();
  assert.equal(calls.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1], 'live_verifications_dry_run'), false, 'on is not a dry run');
  const rb = signalFor(res, RB);
  assert.equal(rb.value.execution_spec.cart_url, `https://${RB}/cart/${BLISS}:1?country=US`);
  assert.equal(rb.value.execution_spec.variant_id, BLISS);
  assert.equal(rb.value.execution_spec.expected_item_total, 25, 'pinned to US: the backend\'s total from the live price');
  assert.equal(rb.value.affiliate_url, 'https://api.pivota.cc/r?token=minted');
  assert.equal(rb.value.price, 25);
  assert.equal(rb.value.in_stock, true);
  assert.equal(rb.value.availability, null);
  assert.equal(rb.value.stock_verified, true);
  assert.equal(rb.value.merchant_price_verified, true);
  assert.equal(rb.value.live_read.status, 'verified');
  assert.equal(rb.value.live_read.stored_price, 22);
  assert.equal(rb.value.live_read.expected_total_withheld, undefined, 'the first pass\'s "no_cart" no longer holds');
  assert.equal(typeof rb.value.live_read.checked_at, 'string');
  // The options as the merchant answered them (the first pass), never the backend's stale ones.
  assert.deepEqual(rb.value.variants.map((v) => [v.variant_id, v.price, v.in_stock, v.live_verified]), [
    [BLISS, 25, true, true],
    [OTHER, 25, false, true],
  ]);
  assert.deepEqual(first.variants.map((v) => v.price_stale), [true, true], 'the backend\'s stale options are not served');
  // Everything else in the first pass is unchanged: the fresh offer keeps its first-pass click id.
  assert.equal(signalFor(res, 'other-store').value.affiliate_url, 'https://api.pivota.cc/r?token=fresh-first');
  assert.equal(res.signals.length, 2);
  assert.equal(res.metadata.offer_count, 2);
  assert.equal(logs[0].mode, 'on');
  assert.equal(logs[0].would_replace, undefined);
  assert.equal(logs[0].cart_minted, 1);
});

test('on: an accepted offer the backend still mints no cart for (its own gates) is served live, and counted as no cart', async () => {
  const gated = (o, c) => ({ ...mintedOffer(o, c), execution_spec: { merchant_domain: RB, variant_id: null, cart_url: null } });
  for (const mode of ['on', 'shadow']) {
    const { run, logs } = getOffers([flaggedOffer()], { mode, backend: { mint: gated } });
    const res = await run();
    await settle();
    assert.equal(logs[0].accepted, 1, mode);
    assert.equal(logs[0].cart_minted, 0, mode);
    assert.equal(res.best_offer.value.execution_spec.cart_url, null, mode);
    if (mode === 'on') {
      assert.equal(res.best_offer.value.affiliate_url, 'https://api.pivota.cc/r?token=minted');
      assert.equal(res.best_offer.value.live_read.expected_total_withheld, 'no_cart');
    } else {
      assert.deepEqual(logs[0].would_replace.map((w) => w.cart_minted), [false]);
    }
  }
});

test('on: a cart the backend did not pin to the market carries no total, and says why', async () => {
  const unpinned = (o, c) => {
    const m = mintedOffer(o, c);
    m.execution_spec.cart_url = `https://${RB}/cart/${c.vid}:1`;
    return m;
  };
  const res = await getOffers([flaggedOffer()], { backend: { mint: unpinned } }).run();
  const v = res.best_offer.value;
  assert.equal(v.execution_spec.cart_url, `https://${RB}/cart/${BLISS}:1`);
  assert.equal(v.execution_spec.expected_item_total, null);
  assert.equal(v.live_read.expected_total_withheld, 'cart_not_pinned_to_market');
});

test('a merchant out of stock is NOT asserted (it can never mint a cart): no second call, the first pass as it is', async () => {
  const sold = { ...rareBeauty, US: [liveVariant(BLISS, 2500, 'USD', false)] };
  for (const mode of ['shadow', 'on']) {
    const { run, calls, logs } = getOffers([flaggedOffer()], { mode, readOffersLive: realReader(sold) });
    const res = await run();
    await settle();
    assert.equal(calls.length, 1, mode);
    assert.equal(logs.length, 0, mode);
    assert.equal(res.best_offer.value.in_stock, false);
    assert.equal(res.best_offer.value.stock_verified, true);
    assert.equal(res.best_offer.value.execution_spec.cart_url, null);
    assert.equal(res.best_offer.value.live_read.expected_total_withheld, 'no_cart');
  }
});

// ---------------------------------------------------------------------------------- what is not asserted

test('nothing is asserted for an unflagged offer, an unverified flagged one, or a handle mismatch: no second call', async () => {
  const cases = [
    { name: 'unflagged verified offer', offers: [freshOffer({ merchant_id: RB, execution_spec: { merchant_domain: RB, variant_id: BLISS, cart_url: `https://${RB}/cart/${BLISS}:1?country=US` }, source: { type: 'external_seed', seed_id: 'eps_rb', canonical_url: `https://${RB}/products/soft-pinch-liquid-blush` } })] },
    { name: 'merchant says the variant is gone', offers: [flaggedOffer()], readOffersLive: realReader({ ...rareBeauty, US: [] }) },
    { name: 'merchant answers another product', offers: [flaggedOffer({ source: { type: 'external_seed', seed_id: 'eps_rb', canonical_url: `https://${RB}/products/other-thing` } })] },
    {
      name: 'a verified live_read whose handle is not the page\'s',
      offers: [flaggedOffer()],
      readOffersLive: async (offers, ctx) => {
        const res = await realReader()(offers, ctx);
        return { ...res, offers: res.offers.map((o) => ({ ...o, live_read: { ...o.live_read, handle: 'soft-pinch-liquid-blush-mini' } })) };
      },
    },
    {
      name: 'a verified live_read with no handle',
      offers: [flaggedOffer()],
      readOffersLive: async (offers, ctx) => {
        const res = await realReader()(offers, ctx);
        return { ...res, offers: res.offers.map((o) => ({ ...o, live_read: { ...o.live_read, handle: null } })) };
      },
    },
    {
      name: 'a page with no handle and a verified live_read with none either',
      offers: [flaggedOffer({ source: { type: 'external_seed', seed_id: 'eps_rb', canonical_url: `https://${RB}/pages/blush` } })],
      readOffersLive: async (offers) => ({ offers: offers.map((o) => ({ ...o, live_read: { status: 'verified', amount: 25, currency: 'USD', available: true, variant_id: BLISS, host: RB, handle: null } })), stats: {} }),
    },
    {
      name: 'no id to compare: neither lookup_variant_id nor a cart variant, and none read',
      offers: [flaggedOffer({ requires_live_verification: { reasons: ['stale_snapshot'] } })],
      readOffersLive: async (offers) => ({ offers: offers.map((o) => ({ ...o, live_read: { status: 'verified', amount: 25, currency: 'USD', available: true, variant_id: null, host: RB, handle: 'soft-pinch-liquid-blush' } })), stats: {} }),
    },
    { name: 'no live read at all', offers: [flaggedOffer(), freshOffer()], readOffersLive: null },
    { name: 'no seed id', offers: [flaggedOffer({ source: { type: 'external_seed', canonical_url: `https://${RB}/products/soft-pinch-liquid-blush` } })] },
    // The reader reads the offer's own cart variant first; the backend compares against lookup_variant_id.
    {
      name: 'the read looked up another id than lookup_variant_id',
      offers: [flaggedOffer({ execution_spec: { merchant_domain: RB, variant_id: OTHER, cart_url: null } })],
      readOffersLive: realReader({ ...rareBeauty, US: [liveVariant(BLISS, 2500, 'USD', true), liveVariant(OTHER, 2500, 'USD', true)] }),
    },
  ];
  for (const c of cases) {
    const { run, calls, logs } = getOffers(c.offers, { mode: 'on', ...('readOffersLive' in c ? { readOffersLive: c.readOffersLive } : {}) });
    await run();
    assert.equal(calls.length, 1, c.name);
    assert.equal(logs.length, 0, c.name);
  }
});

test('no market declared: no live read, nothing asserted', async () => {
  const { run, calls } = getOffers([flaggedOffer()]);
  await run({ product_id: 'sig_rb' });
  assert.equal(calls.length, 1);
});

test('no secret (or a short one) means no assertions and no second call', async () => {
  for (const secret of ['', 'x'.repeat(31)]) {
    const { run, calls } = getOffers([flaggedOffer()], { mode: 'on', liveVerificationSecret: () => readOfferLiveVerificationSecret({ OFFER_LIVE_VERIFICATION_SECRET: secret }) });
    const res = await run();
    assert.equal(calls.length, 1, JSON.stringify(secret));
    assert.equal(res.best_offer.value.execution_spec.cart_url, null);
  }
});

test('an agent cannot hand get_offers its own live_verifications: they are never forwarded', async () => {
  const { run, calls } = getOffers([freshOffer()], { mode: 'on' });
  await run({ product_id: 'sig_rb', market: 'US', live_verifications: ['v1.x.y'], liveVerifications: ['v1.x.y'] });
  assert.equal(calls.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'live_verifications'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'liveVerifications'), false);
});

// ----------------------------------------------------------------------------- the second pass's answer

test('a second call that fails or times out serves the first pass, and a slow one is ABORTED', { timeout: 5000 }, async () => {
  let failingArgs = null;
  const failing = getOffers([flaggedOffer(), freshOffer()], { backend: { secondPass: async (args) => { failingArgs = args; throw new Error('upstream 502'); } } });
  const a = await failing.run();
  assert.equal(signalFor(a, RB).value.execution_spec.cart_url, null);
  assert.equal(signalFor(a, RB).value.affiliate_url, 'https://api.pivota.cc/r?token=first');
  assert.equal(a.signals.length, 2);
  assert.equal(failing.logs[0].error, 'fetch_failed');
  assert.equal(failingArgs.signal.aborted, false, 'an answered call is not aborted');
  // A fetchOffers that throws synchronously is a failed call too.
  const syncFetch = (args) => {
    if (args.live_verifications) throw new Error('sync');
    return Promise.resolve({ offers: [flaggedOffer()] });
  };
  const sync = getOffers([flaggedOffer()], { fetchOffers: syncFetch });
  assert.equal((await sync.run()).best_offer.value.execution_spec.cart_url, null);
  assert.equal(sync.logs[0].error, 'fetch_failed');

  let slowArgs = null;
  const slow = getOffers([flaggedOffer(), freshOffer()], { liveCartTimeoutMs: 20, backend: { secondPass: (args) => { slowArgs = args; return new Promise(() => {}); } } });
  const t0 = Date.now();
  const b = await slow.run();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(slowArgs.signal.aborted, true, 'the request itself is cancelled, not merely abandoned');
  assert.equal(signalFor(b, RB).value.execution_spec.cart_url, null);
  assert.equal(slow.logs[0].error, 'timeout');

  for (const answer of [null, {}, { offers: 'x' }]) {
    const empty = getOffers([flaggedOffer()], { backend: { secondPass: async () => answer } });
    assert.equal((await empty.run()).best_offer.value.execution_spec.cart_url, null);
    assert.equal(empty.logs[0].error, 'no_offers', JSON.stringify(answer));
  }
});

test('a log sink that throws never costs the answer', async () => {
  for (const mode of ['shadow', 'on']) {
    const res = await getOffers([flaggedOffer()], { mode, log: () => { throw new Error('log down'); } }).run();
    assert.equal(res.signals.length, 1, mode);
    assert.equal(res.best_offer.value.execution_spec.cart_url, mode === 'on' ? `https://${RB}/cart/${BLISS}:1?country=US` : null, mode);
  }
});

test('a second answer that breaks the comparison serves the first pass (and never rejects in shadow)', async () => {
  const hostile = { get source() { throw new Error('boom'); } };
  for (const mode of ['on', 'shadow']) {
    const g = getOffers([flaggedOffer()], { mode, backend: { secondPass: async () => ({ offers: [hostile] }) } });
    const res = await g.run();
    await settle();
    assert.equal(res.best_offer.value.execution_spec.cart_url, null, mode);
  }
});

test('an offer the second pass still flags is not replaced', async () => {
  const stillFlagged = getOffers([flaggedOffer(), freshOffer()], { backend: { secondPass: async () => ({ offers: [flaggedOffer({ affiliate_url: 'x-second' }), freshOffer()] }) } });
  const res = await stillFlagged.run();
  assert.equal(signalFor(res, RB).value.affiliate_url, 'https://api.pivota.cc/r?token=first');
  assert.equal(stillFlagged.logs[0].accepted, 0);
});

test('a second-pass offer is adopted only when the backend accepted THIS assertion, at the asserted facts', async () => {
  const variants = {
    'no live_verification': (m) => { delete m.live_verification; },
    'live_verification not verified': (m) => { m.live_verification.status = 'rejected'; },
    'verified for another variant': (m) => { m.live_verification.variant_id = OTHER; },
    'another price': (m) => { m.price = 24; },
    'another currency': (m) => { m.currency = 'CAD'; },
    'another stock': (m) => { m.in_stock = false; },
    'another seed': (m) => { m.source.seed_id = 'eps_x'; },
    'a cart for another variant': (m) => { m.execution_spec.variant_id = OTHER; },
    'a total other than the asserted amount': (m) => { m.execution_spec.expected_item_total = 24; },
  };
  for (const [name, change] of Object.entries(variants)) {
    const mint = (o, c) => { const m = mintedOffer(o, c); change(m); return m; };
    const { run, logs } = getOffers([flaggedOffer()], { backend: { mint } });
    const res = await run();
    assert.equal(res.best_offer.value.affiliate_url, 'https://api.pivota.cc/r?token=first', name);
    assert.equal(logs[0].accepted, 0, name);
  }
  // Two unflagged offers for one seed: ambiguous, neither is taken.
  const twice = getOffers([flaggedOffer()], {
    backend: { secondPass: async (args) => {
      const c = verifyToken(args.live_verifications[0]);
      return { offers: [mintedOffer(flaggedOffer(), c), { ...mintedOffer(flaggedOffer(), c), offer_id: 'dup' }] };
    } },
  });
  assert.equal((await twice.run()).best_offer.value.affiliate_url, 'https://api.pivota.cc/r?token=first');
});

test('acceptedSecondPassOffer / adoptLiveCartOffer: pure checks', () => {
  const claims = { a: 25, av: true, c: 'USD', h: RB, m: 'US', sid: 'eps_rb', v: 1, vid: BLISS };
  const m = mintedOffer(flaggedOffer(), { ...claims, iat: 1, exp: 121 });
  assert.equal(acceptedSecondPassOffer([m], claims), m);
  assert.equal(acceptedSecondPassOffer([{ ...m, requires_live_verification: { reasons: ['stale_snapshot'] } }], claims), null);
  assert.equal(acceptedSecondPassOffer(null, claims), null);
  assert.equal(acceptedSecondPassOffer([null, { offer_id: 'no-source' }, m], claims), m, 'junk entries are skipped');
  // A cart that names no variant and no total is still the backend's; one that names them must name ours.
  const bare = { ...m, execution_spec: { ...m.execution_spec, variant_id: null, expected_item_total: null } };
  assert.equal(acceptedSecondPassOffer([bare], claims), bare);
  const { variant_id: _v, expected_item_total: _t, ...noKeys } = m.execution_spec;
  assert.ok(acceptedSecondPassOffer([{ ...m, execution_spec: noKeys }], claims));
  assert.ok(acceptedSecondPassOffer([{ ...m, execution_spec: undefined }], claims));
  assert.equal(acceptedSecondPassOffer([{ ...m, execution_spec: { ...m.execution_spec, expected_item_total: 25.01 } }], claims), null);
  const first = { ...flaggedOffer(), live_read: { status: 'verified', checked_at: 'T', expected_total_withheld: 'no_cart' }, variants: [{ variant_id: BLISS, live_verified: true }] };
  const out = adoptLiveCartOffer(first, { ...m, availability: 'out_of_stock' }, { market: 'us' });
  assert.equal(out.availability, undefined);
  assert.deepEqual(out.live_read, { status: 'verified', checked_at: 'T' });
  assert.deepEqual(out.variants, first.variants);
  assert.equal(out.execution_spec.expected_item_total, 25);
  assert.equal(out.price_source, 'merchant_live');
});

test('offerLiveVerificationClaims reads only the live answer, in the market currency', async () => {
  const { offers } = await realReader()([flaggedOffer()], { market: 'US', currency: 'USD' });
  const o = offers[0];
  assert.deepEqual(offerLiveVerificationClaims(o, { market: 'US', currency: 'USD' }), { a: 25, av: true, c: 'USD', h: RB, m: 'US', sid: 'eps_rb', v: 1, vid: BLISS });
  assert.equal(offerLiveVerificationClaims(o, { market: 'US', currency: 'CAD' }), null, 'another currency');
  assert.equal(offerLiveVerificationClaims(o, { market: 'USA', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, requires_live_verification: undefined }, { market: 'US', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, live_read: { ...o.live_read, status: 'currency_mismatch' } }, { market: 'US', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, live_read: { ...o.live_read, amount: 0 } }, { market: 'US', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, live_read: { ...o.live_read, available: null } }, { market: 'US', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, live_read: { ...o.live_read, available: false } }, { market: 'US', currency: 'USD' }), null, 'out of stock');
  assert.equal(offerLiveVerificationClaims({ ...o, live_read: { ...o.live_read, host: null } }, { market: 'US', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, live_read: { ...o.live_read, currency: 'CAD' } }, { market: 'US', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, currency: 'CAD' }, { market: 'US', currency: 'USD' }), null);
  assert.equal(offerLiveVerificationClaims({ ...o, source: { ...o.source, seed_id: '' } }, { market: 'US', currency: 'USD' }), null, 'no seed id');
  const noId = { ...o, requires_live_verification: { reasons: ['stale_snapshot'] }, live_read: { ...o.live_read, variant_id: null } };
  assert.equal(offerLiveVerificationClaims(noId, { market: 'US', currency: 'USD' }), null, 'no id the backend could compare');
  // No lookup_variant_id: the backend compares against execution_spec.variant_id, which the read used.
  const bySpec = { ...o, requires_live_verification: { reasons: ['stale_snapshot'] }, execution_spec: { merchant_domain: RB, variant_id: BLISS } };
  assert.equal(offerLiveVerificationClaims(bySpec, { market: 'US', currency: 'USD' }).vid, BLISS);
});

test('at most 10 assertions per call', async () => {
  const many = Array.from({ length: 12 }, (_, i) => flaggedOffer({ offer_id: `o${i}`, source: { type: 'external_seed', seed_id: `eps_${i}`, canonical_url: `https://${RB}/products/soft-pinch-liquid-blush` } }));
  const fake = async (offers) => ({ offers: offers.map((o) => ({ ...o, currency: 'USD', live_read: { status: 'verified', amount: 25, currency: 'USD', available: true, variant_id: BLISS, host: RB, handle: 'soft-pinch-liquid-blush' } })), stats: {} });
  const { run, calls } = getOffers(many, { readOffersLive: fake });
  await run({ product_id: 'sig_rb', market: 'US', limit: 10 });
  assert.equal(calls[1].live_verifications.length, 10);
});

// ------------------------------------------------------------------------------------ wiring and schemas

test('mapOffersResolveResponse keeps the backend\'s assertion counts, only when present', () => {
  assert.deepEqual(mapOffersResolveResponse({ offers: [], metadata: { live_verification_assertions: { received: 1, accepted: 0, rejected: { expired: 1 } } } }), {
    offers: [], product_group_id: null, live_verification_assertions: { received: 1, accepted: 0, rejected: { expired: 1 } },
  });
  assert.deepEqual(mapOffersResolveResponse({ offers: [] }), { offers: [], product_group_id: null });
});

test('STRUCTURAL: the server sends liveVerifications only when makeGetOffers built some, and wires the flag and secret', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const start = src.indexOf('get_offers: makeGetOffers({');
  const block = src.slice(start, start + 5000);
  assert.match(block, /liveCartMode: \(\) => require\('\.\/services\/offerLiveVerification'\)\.liveCartMode\(\),/);
  assert.match(block, /liveVerificationSecret: \(\) => require\('\.\/services\/offerLiveVerification'\)\.readOfferLiveVerificationSecret\(\),/);
  assert.match(block, /\.\.\.\(Array\.isArray\(live_verifications\) && live_verifications\.length\s*\?\s*\{\s*liveVerifications: live_verifications,/);
  // The dry-run marker rides only with assertions, and only when makeGetOffers asked for it (shadow).
  assert.match(block, /liveVerifications: live_verifications,[\s\S]{0,200}\.\.\.\(live_verifications_dry_run \? \{ liveVerificationsDryRun: true \} : \{\}\),\s*\}\s*: \{\}\),/);
  // The abort signal reaches the upstream request (axios `signal`).
  assert.match(block, /\}, \{\}, signal \? \{ signal \} : \{\}\),/);
  const inv = src.slice(src.indexOf('async function invokeCommerceKernelRawUpstream('));
  assert.match(inv.slice(0, 20000), /timeout: selfInvoked \? resolveSelfInvokeBudget\(timeout\) : timeout,\s*\.\.\.\(options && options\.signal \? \{ signal: options\.signal \} : \{\}\),/);
});

test('the get_offers tool input schemas never accept live_verifications from an agent', async () => {
  const surfaceMod = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const executor = { async execute() { return { subject: null, best_offer: null, signals: [], metadata: {} }; } };
  const surface = surfaceMod.createCommerceToolSurface(executor, { cache: false });
  const tool = surface.tools.find((t) => t.name === 'get_offers');
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const k of ['live_verifications', 'liveVerifications']) assert.equal(k in tool.inputSchema.properties, false, k);
  await assert.rejects(() => surface.callTool('get_offers', { product_id: 'p1', market: 'US', live_verifications: ['v1.x.y'] }, { agent_id: 'a' }));
  const ucp = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'ucpArgumentAdapter.js')).href);
  const schema = ucp.ucpInputSchemasFor({}).get_offers;
  assert.doesNotMatch(JSON.stringify(schema), /live_?verifications/i);
});
