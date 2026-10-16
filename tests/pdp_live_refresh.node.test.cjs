'use strict';

// The browser's first-view live refresh (UCP_LIVE_PDP_REFRESH). Pages are built by the real producer
// (pdpBuilder), the merchant answers by the real reader over a FAKE UCP client (no store is contacted), and
// the patch is checked against THE overlay's own output.

const test = require('node:test');
const assert = require('node:assert/strict');

// The reader's deadline timers are unref'd: keep the loop alive for this file (CI's Node 20).
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
require('node:test').after(() => clearInterval(keepAlive));

const { createPdpLiveRefresh, syntheticProduct, MAX_PAGE_BYTES } = require('../src/services/pdpLiveRefresh');
const { verifyRefreshToken, signRefreshToken } = require('../src/services/pdpLiveRefreshToken');
const { applyPdpLiveOverlay, createPdpLiveCache, canonicalCard } = require('../src/services/pdpLiveOverlay');
const { createUcpLiveProductReader, STATUS } = require('../src/services/ucpLiveOfferRead');
const { buildPdpPayload } = require('../src/pdpBuilder');

const SECRET = 's'.repeat(48);
const LEMON = '48087970185268';
const BERRY = '31760703160372';
const VANILLA = '31760703258676';
const HOST = 'us.laneige.com';
const HANDLE = 'lip-sleeping-mask';
const SAVINGS = ['payment_offer_summary', 'payment_pricing', 'payment_offer_badges'];

// ------------------------------------------------------------- fixtures

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
    destination_url: `https://${HOST}/products/${HANDLE}`,
    default_variant_id: LEMON,
    variants: [v(LEMON, 'Lemon Sorbet'), v(BERRY, 'Berry'), v(VANILLA, 'Vanilla')],
    ...extra,
  };
}

function cardOffers() {
  return {
    default_offer_id: 'of_card',
    best_price_offer_id: 'of_card',
    offers: [
      { offer_id: 'of_card', merchant_id: 'merch_obs_laneige', product_id: 'ext_lsm', selected_variant_id: LEMON,
        price: { amount: 22, currency: 'USD' }, inventory: { in_stock: true },
        variants: [{ variant_id: LEMON, price: { current: { amount: 22, currency: 'USD' } }, availability: { in_stock: true } }] },
      { offer_id: 'of_sephora', merchant_id: 'merch_obs_sephora', product_id: 'ext_seph', selected_variant_id: LEMON,
        price: { amount: 23, currency: 'USD' }, inventory: { in_stock: true } },
    ],
  };
}

/** A get_pdp_v2 response as the gateway assembles it around the producer's payload. */
function page(product = sellerProduct(), { offers, intel = false, cardExtra } = {}) {
  const pdp = buildPdpPayload({ product, relatedProducts: [], entryPoint: 'agent' });
  if (cardExtra) Object.assign(pdp.product, cardExtra);
  const selector = (pdp.modules || []).find((m) => m.type === 'variant_selector');
  const modules = [{ type: 'canonical', required: true, data: { pdp_payload: pdp } }];
  if (selector) modules.push({ type: 'variant_selector', required: false, data: selector.data });
  if (offers) modules.push({ type: 'offers', required: false, data: offers });
  if (intel && offers) {
    modules.push({ type: 'product_intel', required: false,
      data: { offer_pointers: { best_price_offer_id: offers.best_price_offer_id, default_offer_id: offers.default_offer_id } } });
  }
  return { status: 'success', pdp_version: '2.0', modules, metadata: {} };
}

const CONTENT_KEY = /^(description|images|image_urls|media)/;
/** What the browser sends back: the raw module slice of the contract, content keys dropped, over the wire. */
function browserSlice(p) {
  const found = canonicalCard(p);
  const product = Object.fromEntries(Object.entries(found.card).filter(([k]) => !CONTENT_KEY.test(k)));
  const modules = [{ type: 'canonical', data: { pdp_payload: {
    product,
    actions: found.pdp.actions,
    modules: (found.pdp.modules || []).filter((m) => m.type === 'price_promo' || m.type === 'variant_selector'),
  } } }];
  for (const type of ['variant_selector', 'offers', 'product_intel']) {
    const m = p.modules.find((x) => x.type === type);
    if (m) modules.push({ type, data: m.data });
  }
  return JSON.parse(JSON.stringify({ modules }));
}

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}
function lv(id, amount, available) {
  return { id: `gid://shopify/ProductVariant/${id}`, price: { amount, currency: 'USD' }, availability: { available } };
}
/** A fake UCP client in the live lookup_catalog shape. `gate`: lookups wait for it. */
function fakeClient(answers, { gate = null, hang = false, handle = HANDLE } = {}) {
  const calls = { discover: 0, lookup: 0 };
  return {
    calls,
    async discoverEndpoint(base) { calls.discover += 1; return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog(endpoint, { ids }) {
      calls.lookup += 1;
      if (hang) await new Promise(() => {});
      if (gate) await gate;
      const vs = answers.filter((v) => ids.includes(v.id));
      const missing = ids.filter((id) => !vs.some((v) => v.id === id));
      return toolResult({
        products: vs.length ? [{ id: 'gid://shopify/Product/1', handle, variants: vs }] : [],
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}
const LIVE = [lv(LEMON, 2400, true), lv(BERRY, 2600, true), lv(VANILLA, 2600, false)];

function countingReader(client, opts = {}) {
  const real = createUcpLiveProductReader({ ucpClient: client, mode: 'shadow', ...opts });
  const r = { calls: 0, readLive: (...args) => { r.calls += 1; return real.readLive(...args); } };
  return r;
}

function setup({ mode = 'on', client = fakeClient(LIVE), reader, cache = createPdpLiveCache(), secrets, now, readerOpts, budget, ttlS } = {}) {
  const logs = [];
  const warns = [];
  const r = reader === undefined ? countingReader(client, readerOpts) : reader;
  const svc = createPdpLiveRefresh({
    mode: () => mode,
    secrets: () => secrets || { current: SECRET, previous: '' },
    getReader: () => r,
    cache: () => cache,
    ...(budget ? { budget: () => budget } : {}),
    ...(ttlS ? { ttlS: () => ttlS } : {}),
    isCardOfferFor: (lid) => (card, offer) => offer.merchant_id === card.merchant_id && offer.product_id === lid,
    presentationFields: SAVINGS,
    log: (event, fields) => logs.push({ event, ...fields }),
    warn: (event, fields) => warns.push({ event, ...fields }),
    ...(now ? { now } : {}),
  });
  return { svc, reader: r, client, cache, logs, warns };
}

function issue(svc, p, extra = {}) {
  return svc.descriptor(p, { optedIn: true, market: 'US', cardListingId: 'ext_lsm', ...extra });
}

function recordedCache(answers = LIVE) {
  const cache = createPdpLiveCache();
  const live = new Map(answers.map((v) => [v.id.split('/').pop(), {
    amount: v.price.amount / 100, currency: 'USD', available: v.availability.available, handle: HANDLE,
  }]));
  cache.record({ status: STATUS.VERIFIED, host: HOST, country: 'US', currency: 'USD', live, notFound: new Set(), askedIds: [...live.keys()] });
  return cache;
}

const readLines = (logs) => logs.filter((l) => l.event === 'pdp_live_read');

// ------------------------------------------------------------- the descriptor

test('descriptor: issued on an eligible served page, its token binding the card exactly', () => {
  const { svc, logs } = setup();
  const p = page();
  const d = issue(svc, p);
  assert.equal(d.v, 1);
  assert.equal(d.market, 'US');
  const v = verifyRefreshToken(d.token, { secrets: [SECRET] });
  assert.equal(v.ok, true);
  const { iat, exp, ...claims } = v.claims;
  assert.deepEqual(claims, {
    v: 1, op: 'pdp_live_read', pid: 'ext_lsm', mid: 'merch_obs_laneige', lid: 'ext_lsm', h: HOST, hd: HANDLE,
    m: 'US', c: 'USD', ids: [LEMON, BERRY, VANILLA],
  });
  assert.equal(exp - iat, 21600, 'default 6 h');
  assert.deepEqual(logs.at(-1), { event: 'get_pdp_v2_live_refresh_issued', issued: true, reason: null, host: HOST, market: 'US' });
});

test('descriptor: none for a blocked page, no handle, another currency, no opt-in, flag off, no secret, no reader', () => {
  const none = (p, opts = {}, extra = {}) => {
    const { svc, logs, warns } = setup(opts);
    const d = issue(svc, p, extra);
    return { d, line: logs.at(-1), warns, svc };
  };
  const cases = {
    commerce_blocked: none(page(sellerProduct({ transaction_ready: false }))),
    no_handle: none(page(sellerProduct({ destination_url: `https://${HOST}/lip-sleeping-mask` }))),
    // A page priced in USD for a buyer in SG: the overlay never re-prices into another currency.
    currency_mismatch: none(page(), {}, { market: 'SG' }),
    disabled: none(page(), { mode: 'off' }),
    no_secret: none(page(), { secrets: { current: '', previous: SECRET } }),
    no_reader: none(page(), { reader: null }),
    no_market: none(page(), {}, { market: undefined }),
    all_withheld: none(page(sellerProduct({
      variants: sellerProduct().variants.map((v) => ({ ...v, current_own_offer_status: 'unavailable' })),
    }), { cardExtra: { currency: 'USD' } })),
  };
  for (const [reason, { d, line }] of Object.entries(cases)) {
    assert.equal(d, null, reason);
    assert.equal(line.event, 'get_pdp_v2_live_refresh_issued', reason);
    assert.equal(line.issued, false, reason);
    assert.equal(line.reason, reason, reason);
  }
  // Not opted in: no descriptor and no line (agents never ask).
  const { svc, logs } = setup();
  assert.equal(svc.descriptor(page(), { optedIn: false, market: 'US' }), null);
  assert.equal(svc.descriptor(page(), { market: 'US' }), null);
  assert.equal(logs.length, 0);
  // No secret: one warning per process, not one per page.
  const { svc: s2, warns } = setup({ secrets: { current: '', previous: '' } });
  issue(s2, page());
  issue(s2, page());
  assert.equal(warns.filter((w) => w.event === 'pdp_live_refresh_secret_missing').length, 1);
});

// ------------------------------------------------------------- the read

test('claim -> read -> record -> patch: the merchant is read once, from the token, and the answer is cached', async () => {
  const { svc, reader, client, cache, logs } = setup();
  const p = page();
  const token = issue(svc, p).token;
  const res = await svc.read({ token, page: browserSlice(p), market: 'US' });
  assert.equal(res.httpStatus, 200);
  const lr = res.body.live_refresh;
  assert.deepEqual({ mode: lr.mode, outcome: lr.outcome, reason: lr.reason, source: lr.source },
    { mode: 'on', outcome: 'applied', reason: null, source: 'read' });
  // Lemon repriced 26 -> 24; Lemon and Berry back in stock; Vanilla answered, still out of stock.
  assert.deepEqual(lr.stats, { verified: 3, gone: 0, price_changed: 1, stock_changed: 2, best_price_moved: false });
  assert.match(lr.checked_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(reader.calls, 1);
  assert.equal(client.calls.lookup, 1);
  // Recorded: the next view answers from the cache and the product x market is claimed.
  assert.equal(cache.answersFor(HOST, 'US', [LEMON, BERRY, VANILLA]).size, 3);
  assert.equal(cache.claimRead(HOST, 'US', [LEMON, BERRY, VANILLA]), false);
  const patch = res.body.patch;
  assert.ok(patch && patch.product && patch.modules);
  assert.equal(patch.product.set.price.current.amount, 24);
  assert.equal(patch.product.set.price_source, 'merchant_live');
  assert.equal(patch.modules.price_promo.price.amount, 24);
  assert.equal(new Map(patch.modules.variant_selector.variants.map((v) => [v.variant_id, v])).get(LEMON).availability.in_stock, true);
  const line = readLines(logs).at(-1);
  for (const key of ['outcome', 'reason', 'source', 'mode', 'host', 'market', 'product_id', 'token_age_s', 'read_ms',
    'total_ms', 'page_bytes', 'verified', 'gone', 'price_changed', 'stock_changed', 'best_price_moved']) {
    assert.ok(key in line, key);
  }
  assert.equal(line.host, HOST);
  assert.equal(line.product_id, 'ext_lsm');
  assert.ok(line.page_bytes > 0);
});

test('the read target comes ONLY from the token', async () => {
  const product = syntheticProduct({ pid: 'p', mid: 'm', h: HOST, hd: HANDLE, c: 'USD', ids: [BERRY, LEMON] });
  assert.deepEqual(product, {
    product_id: 'p', merchant_id: 'm', destination_url: `https://${HOST}/products/${HANDLE}`,
    default_variant_id: BERRY, variants: [{ variant_id: BERRY }, { variant_id: LEMON }], currency: 'USD',
  });
  const seen = [];
  const reader = { async readLive(prod, ctx) { seen.push({ prod, ctx }); return { status: STATUS.TIMEOUT, host: HOST, country: 'US', currency: 'USD' }; } };
  const { svc } = setup({ reader });
  const p = page();
  const token = issue(svc, p).token;
  const slice = browserSlice(p);
  slice.modules[0].data.pdp_payload.product.source_url = 'https://evil.example.com/products/x';
  await svc.read({ token, page: slice, market: 'US' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prod.destination_url, `https://${HOST}/products/${HANDLE}`);
  assert.equal('source_url' in seen[0].prod, false);
  assert.deepEqual(seen[0].ctx, { market: 'US' });
});

test('a fresh cache answer means no read (source: cache)', async () => {
  const { svc, reader } = setup({ cache: recordedCache() });
  const p = page();
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(reader.calls, 0);
  assert.equal(res.body.live_refresh.source, 'cache');
  assert.equal(res.body.live_refresh.outcome, 'applied');
  assert.ok(res.body.patch);
});

test('host_busy releases the claim; it answers no_answer/host_busy', async () => {
  const reader = { calls: 0, async readLive() { reader.calls += 1; return { status: STATUS.SKIPPED, reason: 'host_busy', host: HOST, country: 'US', currency: 'USD' }; } };
  const { svc, cache } = setup({ reader });
  const p = page();
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(res.body.live_refresh.outcome, 'no_answer');
  assert.equal(res.body.live_refresh.reason, 'host_busy');
  assert.equal(res.body.patch, undefined);
  assert.equal(cache.claimRead(HOST, 'US', [LEMON, BERRY, VANILLA]), true, 'a store too busy to take the read does not count as tried');
});

test('a timeout calls retryReadSoon: the product may be read again after the retry window, not the TTL', async () => {
  let t = 1_000_000;
  const cache = createPdpLiveCache({ ttlMs: 600000, retryMs: 120000, now: () => t });
  const { svc } = setup({ cache, client: fakeClient(LIVE, { hang: true }), readerOpts: { budgetMs: 30 } });
  const p = page();
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(res.body.live_refresh.outcome, 'no_answer');
  assert.equal(res.body.live_refresh.reason, 'timeout');
  t += 119999;
  assert.equal(cache.claimRead(HOST, 'US', [LEMON, BERRY, VANILLA]), false);
  t += 2;
  assert.equal(cache.claimRead(HOST, 'US', [LEMON, BERRY, VANILLA]), true, 'retried after two minutes');
});

test('recently_tried: a product x market already tried in this process is not read again', async () => {
  const { svc, reader, cache } = setup();
  cache.claimRead(HOST, 'US', [VANILLA, LEMON, BERRY]);
  const p = page();
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(reader.calls, 0);
  assert.deepEqual([res.body.live_refresh.outcome, res.body.live_refresh.reason], ['no_answer', 'recently_tried']);
});

test('two concurrent calls make ONE merchant read: the second waits on the first (coalesced)', async () => {
  let open;
  const gate = new Promise((res) => { open = res; });
  const client = fakeClient(LIVE, { gate });
  const { svc, reader } = setup({ client });
  const p = page();
  const token = issue(svc, p).token;
  const a = svc.read({ token, page: browserSlice(p), market: 'US' });
  const b = svc.read({ token, page: browserSlice(p), market: 'US' });
  await new Promise((res) => setImmediate(res));
  assert.equal(svc.inFlightCount(), 1);
  open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(reader.calls, 1);
  assert.equal(client.calls.lookup, 1);
  assert.deepEqual([ra.body.live_refresh.source, rb.body.live_refresh.source].sort(), ['coalesced', 'read']);
  assert.ok(ra.body.patch && rb.body.patch);
  assert.deepEqual(ra.body.patch, rb.body.patch);
  assert.equal(svc.inFlightCount(), 0);
});

test('page_mismatch for EACH binding: product, merchant, host, handle, currency, variant ids', async () => {
  const p = page();
  const mutations = {
    pid: (c) => { c.product_id = 'ext_other'; },
    mid: (c) => { c.merchant_id = 'merch_other'; },
    h: (c) => { for (const k of ['destination_url', 'external_redirect_url', 'source_url', 'url', 'canonical_url']) if (c[k]) c[k] = String(c[k]).replace(HOST, 'other.example.com'); },
    hd: (c) => { for (const k of ['destination_url', 'external_redirect_url', 'source_url', 'canonical_url']) if (c[k]) c[k] = String(c[k]).replace(HANDLE, 'other-product'); },
    c: (c) => { c.currency = 'SGD'; c.price = { ...c.price, currency: 'SGD', current: { ...(c.price.current || {}), currency: 'SGD' } }; },
    ids: (c) => { c.variants = c.variants.slice(0, 2); },
    ids_added: (c) => { c.variants = [...c.variants, { ...c.variants[0], variant_id: '11111111111111' }]; },
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    const { svc, reader, logs } = setup({ cache: recordedCache() });
    const token = issue(svc, p).token;
    const slice = browserSlice(p);
    mutate(slice.modules[0].data.pdp_payload.product);
    const res = await svc.read({ token, page: slice, market: 'US' });
    assert.deepEqual([res.httpStatus, res.body.live_refresh.outcome, res.body.live_refresh.reason], [200, 'skipped', 'page_mismatch'], field);
    assert.equal(res.body.patch, undefined, field);
    assert.equal(reader.calls, 0, field);
    assert.equal(readLines(logs).at(-1).mismatch, field === 'ids_added' ? 'ids' : field, field);
  }
  // No canonical card at all.
  const { svc } = setup();
  const token = issue(svc, p).token;
  for (const bad of [undefined, null, {}, { modules: [] }, { modules: [{ type: 'offers', data: {} }] }]) {
    const res = await svc.read({ token, page: bad, market: 'US' });
    assert.equal(res.body.live_refresh.reason, 'page_mismatch');
  }
});

test('the variant ids bind as a set: the same variants in another order still match', async () => {
  const { svc } = setup({ cache: recordedCache() });
  const p = page();
  const token = issue(svc, p).token;
  const slice = browserSlice(p);
  const card = slice.modules[0].data.pdp_payload.product;
  card.variants = [...card.variants].reverse();
  const res = await svc.read({ token, page: slice, market: 'US' });
  assert.equal(res.body.live_refresh.outcome, 'applied');
});

test('market_changed, page_too_large, token_expired, commerce_blocked: skipped, never read', async () => {
  let t = Date.now();
  const { svc, reader } = setup({ now: () => t });
  const p = page();
  const token = issue(svc, p).token;
  const reason = async (input) => (await svc.read({ token, page: browserSlice(p), ...input })).body.live_refresh;
  assert.deepEqual(await reason({ market: 'SG' }), { mode: 'on', outcome: 'skipped', reason: 'market_changed', source: null, checked_at: null,
    stats: { verified: 0, gone: 0, price_changed: 0, stock_changed: 0, best_price_moved: false } });
  const big = browserSlice(p);
  big.modules[0].data.pdp_payload.product.title = 'x'.repeat(MAX_PAGE_BYTES);
  assert.equal((await svc.read({ token, page: big, market: 'US' })).body.live_refresh.reason, 'page_too_large');
  const blocked = browserSlice(p);
  blocked.modules[0].data.pdp_payload.actions = [];
  assert.equal((await svc.read({ token, page: blocked, market: 'US' })).body.live_refresh.reason, 'commerce_blocked');
  // No declared market on the request: the token's market is used.
  assert.equal((await reason({})).reason, null);
  reader.calls = 0;
  t += 86400 * 1000 + 1000;
  const expired = await svc.read({ token, page: browserSlice(p), market: 'US' });
  assert.deepEqual([expired.httpStatus, expired.body.live_refresh.outcome, expired.body.live_refresh.reason], [200, 'skipped', 'token_expired']);
  assert.equal(reader.calls, 0);
});

test('a malformed or forged token is a 400 INVALID_LIVE_REFRESH_TOKEN; flag off answers disabled to anything', async () => {
  const { svc, reader } = setup();
  const p = page();
  const token = issue(svc, p).token;
  for (const bad of [undefined, '', 'v1.x.y', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')]) {
    const res = await svc.read({ token: bad, page: browserSlice(p), market: 'US' });
    assert.equal(res.httpStatus, 400, String(bad));
    assert.equal(res.body.error, 'INVALID_LIVE_REFRESH_TOKEN');
  }
  const forged = signRefreshToken(verifyRefreshToken(token, { secrets: [SECRET] }).claims, 'f'.repeat(40));
  assert.equal((await svc.read({ token: forged, page: browserSlice(p) })).httpStatus, 400);
  assert.equal(reader.calls, 0);
  // Previous secret verifies (rotation).
  const { svc: rotated } = setup({ secrets: { current: 'n'.repeat(40), previous: SECRET }, cache: recordedCache() });
  assert.equal((await rotated.read({ token, page: browserSlice(p), market: 'US' })).body.live_refresh.outcome, 'applied');
  // Rollback: off answers skipped/disabled, even to garbage; no reader, no secret: disabled too.
  for (const opts of [{ mode: 'off' }, { reader: null }, { secrets: { current: '', previous: SECRET } }]) {
    const { svc: s } = setup(opts);
    for (const t of [token, 'garbage']) {
      const res = await s.read({ token: t, page: browserSlice(p), market: 'US' });
      assert.deepEqual([res.httpStatus, res.body.live_refresh.outcome, res.body.live_refresh.reason], [200, 'skipped', 'disabled']);
    }
  }
});

test('shadow reads and logs but returns no patch; a merchant that only confirmed returns confirmed, no patch', async () => {
  const { svc, reader, logs } = setup({ mode: 'shadow' });
  const p = page();
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(reader.calls, 1);
  assert.equal(res.body.live_refresh.mode, 'shadow');
  assert.equal(res.body.live_refresh.outcome, 'applied', 'what on would have done');
  assert.equal(res.body.patch, undefined);
  assert.equal(readLines(logs).at(-1).patched, false);

  // Stored: in stock at 26 everywhere; the merchant says the same.
  const product = sellerProduct({
    variants: sellerProduct().variants.map((v) => ({ ...v, in_stock: true, inventory_quantity: 5 })),
  });
  const same = [lv(LEMON, 2600, true), lv(BERRY, 2600, true), lv(VANILLA, 2600, true)];
  const { svc: on } = setup({ client: fakeClient(same) });
  const p2 = page(product);
  const r2 = await on.read({ token: issue(on, p2).token, page: browserSlice(p2), market: 'US' });
  assert.equal(r2.body.live_refresh.outcome, 'confirmed');
  assert.equal(r2.body.live_refresh.stats.verified, 3);
  assert.equal(r2.body.patch, undefined);
});

test('visible: the card\'s OWN shown price flipping counts; a card flag it never showed (unknown -> known) does not', async () => {
  const product = sellerProduct({
    variants: sellerProduct().variants.map((v) => ({ ...v, price: { amount: 26, currency: 'USD' }, in_stock: true, inventory_quantity: 5 })),
  });
  const same = [lv(LEMON, 2600, true), lv(BERRY, 2600, true), lv(VANILLA, 2600, true)];
  // The card disagreed with its variants (30 vs 26); the merchant confirms 26: the card's price moves.
  const stale = page(product);
  const card = stale.modules[0].data.pdp_payload.product;
  card.price = { current: { amount: 30, currency: 'USD' } };
  const { svc } = setup({ client: fakeClient(same) });
  const res = await svc.read({ token: issue(svc, stale).token, page: browserSlice(stale), market: 'US' });
  assert.equal(res.body.live_refresh.stats.price_changed, 0, 'no variant price changed');
  assert.equal(res.body.live_refresh.outcome, 'applied');
  assert.equal(res.body.patch.product.set.price.current.amount, 26);
  // The same page with a consistent card: its availability goes {} -> { in_stock: true }, which is not a change.
  const consistent = page(product);
  assert.deepEqual(canonicalCard(consistent).card.availability, {});
  const { svc: s2 } = setup({ client: fakeClient(same) });
  const r2 = await s2.read({ token: issue(s2, consistent).token, page: browserSlice(consistent), market: 'US' });
  assert.equal(r2.body.live_refresh.outcome, 'confirmed');
  // A card that showed no price of its own, its variants confirmed: not a change either.
  const unpriced = page(product);
  delete unpriced.modules[0].data.pdp_payload.product.price;
  const { svc: s3 } = setup({ client: fakeClient(same) });
  const r3 = await s3.read({ token: issue(s3, unpriced).token, page: browserSlice(unpriced), market: 'US' });
  assert.equal(r3.body.live_refresh.outcome, 'confirmed');
});

test('a withheld variant is untouched by the patch; savings copy beside a changed price is unset', async () => {
  const product = sellerProduct();
  product.variants[1] = { ...product.variants[1], current_own_offer_status: 'unavailable' };
  const p = page(product, { cardExtra: { payment_offer_summary: 'Save 10% with Shop Pay', payment_pricing: { savings: 3 } } });
  const { svc } = setup({ client: fakeClient([lv(LEMON, 2400, true), lv(BERRY, 1000, true), lv(VANILLA, 2600, true)]) });
  const slice = browserSlice(p);
  const res = await svc.read({ token: issue(svc, p).token, page: slice, market: 'US' });
  const set = res.body.patch.product.set;
  const sent = new Map(slice.modules[0].data.pdp_payload.product.variants.map((v) => [v.variant_id, v]));
  const got = new Map(set.variants.map((v) => [v.variant_id, v]));
  assert.deepEqual(got.get(BERRY), sent.get(BERRY), 'the own-money verdict is never overruled');
  assert.equal(got.get(BERRY).live_read, undefined);
  assert.equal(got.get(LEMON).price.current.amount, 24);
  assert.deepEqual(res.body.patch.product.unset.sort(), ['payment_offer_summary', 'payment_pricing']);
  for (const k of ['purchase_eligible', 'current_own_offer_status', 'commerce_mode']) assert.equal(k in set, false, k);
  assert.equal('actions' in res.body.patch, false);
});

test('the offer row selling the card moves; best price and product_intel pointers move with it', async () => {
  const p = page(sellerProduct(), { offers: cardOffers(), intel: true });
  const { svc } = setup({ cache: recordedCache() });
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(res.body.live_refresh.stats.best_price_moved, true);
  assert.equal(res.body.patch.offers.best_price_offer_id, 'of_sephora');
  assert.equal(res.body.patch.offers.offers.find((o) => o.offer_id === 'of_card').price.amount, 24);
  assert.deepEqual(res.body.patch.product_intel, { offer_pointers: { best_price_offer_id: 'of_sephora', default_offer_id: 'of_card' } });
});

test('a part the overlay did not replace is not in the patch (another seller\'s offers, no intel)', async () => {
  const offers = cardOffers();
  offers.offers = offers.offers.filter((o) => o.offer_id === 'of_sephora');
  offers.best_price_offer_id = 'of_sephora';
  offers.default_offer_id = 'of_sephora';
  const p = page(sellerProduct(), { offers, intel: true });
  const { svc } = setup({ cache: recordedCache() });
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(res.body.live_refresh.outcome, 'applied');
  assert.ok(res.body.patch.product);
  assert.deepEqual(Object.keys(res.body.patch).sort(), ['modules', 'product']);
});

test('the patch\'s variant_selector is the response\'s own when the page has one, else the canonical payload\'s', async () => {
  const p = page();
  const topSelector = p.modules.find((m) => m.type === 'variant_selector');
  topSelector.data = { ...topSelector.data, from: 'response' };
  const { svc } = setup({ cache: recordedCache() });
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(res.body.patch.modules.variant_selector.from, 'response');
  // No response-level selector: the nested one.
  const bare = page();
  bare.modules = bare.modules.filter((m) => m.type !== 'variant_selector');
  const { svc: s2 } = setup({ cache: recordedCache() });
  const r2 = await s2.read({ token: issue(s2, bare).token, page: browserSlice(bare), market: 'US' });
  assert.ok(Array.isArray(r2.body.patch.modules.variant_selector.variants));
});

test('the per-store read budget: over it, no read, the claim released, no_answer/host_busy', async () => {
  const { createHostReadBudget } = require('../src/services/hostReadBudget');
  const budget = createHostReadBudget({ limit: () => 1 });
  assert.equal(budget.take(HOST), true, 'another read (the server-side PDP read, say) spent the minute');
  const { svc, reader, cache } = setup({ budget });
  const p = page();
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.deepEqual([res.body.live_refresh.outcome, res.body.live_refresh.reason], ['no_answer', 'host_busy']);
  assert.equal(reader.calls, 0);
  assert.equal(cache.claimRead(HOST, 'US', [LEMON, BERRY, VANILLA]), true, 'the claim was released');
  // A cache hit spends nothing.
  const { svc: s2, reader: r2 } = setup({ budget, cache: recordedCache() });
  const hit = await s2.read({ token: issue(s2, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(hit.body.live_refresh.source, 'cache');
  assert.equal(r2.calls, 0);
  // Room again: one read spends one.
  const roomy = createHostReadBudget({ limit: () => 1 });
  const { svc: s3, reader: r3 } = setup({ budget: roomy });
  assert.equal((await s3.read({ token: issue(s3, p).token, page: browserSlice(p), market: 'US' })).body.live_refresh.source, 'read');
  assert.equal(r3.calls, 1);
  assert.equal(roomy.take(HOST), false);
});

test('the card\'s own offer row moving is visible even when no card variant or card price moved', async () => {
  const product = sellerProduct({
    variants: sellerProduct().variants.map((v) => ({ ...v, price: { amount: 26, currency: 'USD' }, in_stock: true, inventory_quantity: 5 })),
  });
  const same = [lv(LEMON, 2600, true), lv(BERRY, 2600, true), lv(VANILLA, 2600, true)];
  // The row was stale at $22; the merchant confirms $26 (what the card already shows).
  const offers = { default_offer_id: 'of_card', best_price_offer_id: 'of_card', offers: [cardOffers().offers[0]] };
  const p = page(product, { offers });
  const { svc } = setup({ client: fakeClient(same) });
  const res = await svc.read({ token: issue(svc, p).token, page: browserSlice(p), market: 'US' });
  assert.equal(res.body.live_refresh.stats.price_changed, 0);
  assert.equal(res.body.live_refresh.outcome, 'applied');
  assert.equal(res.body.patch.offers.offers[0].price.amount, 26);
  // Its stock only: the row said out of stock, the merchant says in stock at the same price.
  const stockOnly = { offers: [{ ...cardOffers().offers[0], price: { amount: 26, currency: 'USD' }, inventory: { in_stock: false },
    variants: [{ variant_id: LEMON, price: { current: { amount: 26, currency: 'USD' } }, availability: { in_stock: true } }] }] };
  const p2 = page(product, { offers: stockOnly });
  const { svc: s2 } = setup({ client: fakeClient(same) });
  const r2 = await s2.read({ token: issue(s2, p2).token, page: browserSlice(p2), market: 'US' });
  assert.equal(r2.body.live_refresh.outcome, 'applied');
  assert.equal(r2.body.patch.offers.offers[0].inventory.in_stock, true);
});

test('lowering the TTL shortens tokens already issued: a token older-lived than the current TTL is token_expired', async () => {
  const { svc: issuer } = setup({ ttlS: 86400 });
  const p = page();
  const token = issue(issuer, p).token;
  const { svc, reader } = setup({ ttlS: 21600, cache: recordedCache() });
  const res = await svc.read({ token, page: browserSlice(p), market: 'US' });
  assert.deepEqual([res.httpStatus, res.body.live_refresh.reason], [200, 'token_expired']);
  assert.equal(reader.calls, 0);
  const { svc: same } = setup({ ttlS: 86400, cache: recordedCache() });
  assert.equal((await same.read({ token, page: browserSlice(p), market: 'US' })).body.live_refresh.outcome, 'applied');
});

// ------------------------------------------------------------- property: the patch IS the overlay

/** A reference applier: what the browser does with a patch (by the contract), on the sent page. */
function applyPatch(slice, patch) {
  const out = JSON.parse(JSON.stringify(slice));
  const pdp = out.modules[0].data.pdp_payload;
  if (patch.product) {
    for (const k of patch.product.unset) delete pdp.product[k];
    Object.assign(pdp.product, patch.product.set);
  }
  const replace = (list, type, data) => {
    const m = list.find((x) => x.type === type);
    if (m) m.data = data;
  };
  if (patch.modules && patch.modules.price_promo) replace(pdp.modules, 'price_promo', patch.modules.price_promo);
  if (patch.modules && patch.modules.variant_selector) {
    if (out.modules.some((m) => m.type === 'variant_selector')) replace(out.modules, 'variant_selector', patch.modules.variant_selector);
    else replace(pdp.modules, 'variant_selector', patch.modules.variant_selector);
  }
  if (patch.offers) {
    const m = out.modules.find((x) => x.type === 'offers');
    m.data = { ...m.data, offers: patch.offers.offers, best_price_offer_id: patch.offers.best_price_offer_id };
  }
  if (patch.product_intel) {
    const m = out.modules.find((x) => x.type === 'product_intel');
    m.data = { ...m.data, offer_pointers: patch.product_intel.offer_pointers };
  }
  return out;
}

/** The parts the storefront shows. The nested selector is the response's when it has one. */
function shown(p) {
  const found = canonicalCard(p);
  const top = (type) => (p.modules.find((m) => m.type === type) || {}).data;
  const nested = (type) => ((found.pdp.modules || []).find((m) => m.type === type) || {}).data;
  return JSON.parse(JSON.stringify({
    card: found.card,
    price_promo: nested('price_promo'),
    variant_selector: top('variant_selector') || nested('variant_selector'),
    offers: top('offers') ? { offers: top('offers').offers, best_price_offer_id: top('offers').best_price_offer_id } : null,
    pointers: top('product_intel') ? top('product_intel').offer_pointers : null,
  }));
}

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('PROPERTY: applying the patch to the page equals the overlay\'s output, over random pages and answers', async () => {
  const rand = prng(20261016);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  let applied = 0;
  for (let i = 0; i < 150; i += 1) {
    const product = sellerProduct({
      ...(rand() < 0.3 ? { payment_offer_summary: 'Save', payment_pricing: { s: 1 } } : {}),
    });
    product.variants = product.variants.map((v) => ({
      ...v,
      price: pick([{ amount: 26, currency: 'USD', compare_at: 30 }, { amount: 24, currency: 'USD' }, 26]),
      in_stock: rand() < 0.5,
      ...(rand() < 0.2 ? { current_own_offer_status: 'unavailable' } : {}),
    }));
    if (product.variants.every((v) => v.current_own_offer_status === 'unavailable')) delete product.variants[0].current_own_offer_status;
    const withOffers = rand() < 0.6;
    const p = page(product, { offers: withOffers ? cardOffers() : undefined, intel: withOffers && rand() < 0.5 });
    const answers = [LEMON, BERRY, VANILLA]
      .filter(() => rand() < 0.85)
      .map((id) => lv(id, pick([2600, 2400, 2100, 2900]), rand() < 0.7));
    const { svc, cache } = setup({ client: fakeClient(answers) });
    const token = issue(svc, p).token;
    const slice = browserSlice(p);
    const res = await svc.read({ token, page: slice, market: 'US' });
    const expected = applyPdpLiveOverlay(slice, {
      market: 'US',
      cache,
      isCardOffer: (card, offer) => offer.merchant_id === card.merchant_id && offer.product_id === 'ext_lsm',
      presentationFields: SAVINGS,
    });
    if (!res.body.patch) {
      assert.notEqual(res.body.live_refresh.outcome === 'applied' && res.body.live_refresh.mode === 'on', true, `case ${i}`);
      continue;
    }
    applied += 1;
    assert.ok(expected, `case ${i}`);
    assert.deepEqual(shown(applyPatch(slice, res.body.patch)), shown(expected.payload), `case ${i}`);
  }
  assert.ok(applied > 40, `enough applied cases (${applied})`);
});

// ------------------------------------------------------------- the server wiring

test('STRUCTURAL: only the normally served get_pdp_v2 arm carries the descriptor; pdp_live_read is dispatched', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf("      shadowPdpRead(canonicalOwnMoneyGap ? 'own_money_gap' : 'served');");
  assert.ok(i > 0);
  const tail = src.slice(i, src.indexOf('} catch (err) {', i));
  // The own-money-gap arm is withoutCanonicalPurchaseActions alone; the served arm wraps the overlay.
  assert.match(tail, /\? withoutCanonicalPurchaseActions\(responsePayload\)\s+: withPdpLiveRefreshDescriptor\(livePdpOverlay\(responsePayload, \{/);
  assert.match(tail, /optedIn: options\.live_refresh === true,\s+market: offersGateBuyerMarket\(payload, metadata\),\s+cardListingId: servedCardListingId,/);
  // Exactly one call site: never the read-only or verified-commerce arms above it.
  assert.equal(src.split('withPdpLiveRefreshDescriptor(livePdpOverlay(').length - 1, 1);
  const d = src.indexOf("if (operation === 'pdp_live_read') {");
  assert.ok(d > 0);
  assert.match(src.slice(d, d + 900), /pdpLiveRefresh\(\)\.read\(\{\s+token: payload\?\.live_refresh_token,\s+page: payload\?\.page,\s+market: offersGateBuyerMarket\(payload, metadata\),/);
  const { OperationEnum } = require('../src/schema');
  assert.ok(OperationEnum.options.includes('pdp_live_read'));
  const { __test__: { operationRateLimit } } = require('../src/guardrails/gatewayGuardrails');
  // Its own, wider bucket than get_pdp_v2's (one storefront key carries every shopper).
  assert.ok(operationRateLimit('pdp_live_read', {}).capacity > operationRateLimit('get_pdp_v2', {}).capacity);
});
