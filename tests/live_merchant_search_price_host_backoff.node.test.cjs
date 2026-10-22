'use strict';

// The search `.json` overlay's per-host backoff (SEARCH_OVERLAY_HOST_BACKOFF, default off) and what it tells the
// price_verification_served line: the hosts that refused or were skipped (overlay_throttled_hosts), and the
// overlay's per-instance cache answers counted as recent, never live (overlay_cache_not_live).
// No network: every merchant read is a fake fetchImpl; every host is a `.test` name nothing resolves.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOST_BACKOFF_FLAG, overlayLiveMerchantSearchPrices, _hostBackoff,
} = require('../src/services/liveMerchantSearchPrice');
const pv = require('../src/observability/priceVerificationLog');

const ORIGINAL_LOG_FLAG = process.env.PRICE_VERIFICATION_LOG;
const ON = { [HOST_BACKOFF_FLAG]: 'on' };
const T0 = Date.parse('2026-10-22T06:15:00.000Z');
const MIN = 60 * 1000;

test.beforeEach(() => _hostBackoff.clear());
test.afterEach(() => {
  _hostBackoff.clear();
  if (ORIGINAL_LOG_FLAG === undefined) delete process.env.PRICE_VERIFICATION_LOG;
  else process.env.PRICE_VERIFICATION_LOG = ORIGINAL_LOG_FLAG;
});

const body = { product: { variants: [{ id: 1, price: '30.00', price_currency: 'USD' }] } };
let seq = 0;
/** `n` cards on `host`, each a product URL no other test uses (the overlay's response cache is per process). */
function cards(host, n) {
  seq += 1;
  return Array.from({ length: n }, (_, i) => ({
    product_id: `sig_${seq}_${i}`, price: 28, currency: 'USD',
    destination_url: `https://${host}/products/p-${seq}-${i}`,
  }));
}
/** A fetch whose answer is chosen per host; records every URL it was asked for. */
function merchant(byHost) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const answer = byHost[new URL(url).hostname];
    const status = typeof answer === 'function' ? answer(url) : answer;
    await new Promise((resolve) => setImmediate(resolve));
    return status === 200 ? { ok: true, status: 200, json: async () => body } : { ok: false, status, headers: new Map() };
  };
  return { calls, fetchImpl };
}
const lmp = (r) => r.metadata.live_merchant_price;

test('flag off: a 429 changes nothing, every later page reads the host again, and no backoff state is kept', async () => {
  const m = merchant({ 'off.test': 429 });
  const first = await overlayLiveMerchantSearchPrices({ products: cards('off.test', 6) }, { fetchImpl: m.fetchImpl, env: {} });
  const second = await overlayLiveMerchantSearchPrices({ products: cards('off.test', 2) }, { fetchImpl: m.fetchImpl, env: { [HOST_BACKOFF_FLAG]: 'off' } });
  assert.equal(m.calls.length, 8, 'every card read, both pages');
  assert.deepEqual(lmp(first).failure_reasons, { http_429: 6 });
  assert.equal(lmp(first).fetch_attempt_count, 6);
  assert.deepEqual(lmp(second).failure_reasons, { http_429: 2 });
  assert.equal(_hostBackoff.size, 0);
});

test('flag off: the answer is the same object, byte for byte, whatever the flag value that means off', async () => {
  const scenario = () => ({
    products: [
      { product_id: 'a', price: 28, currency: 'USD', destination_url: 'https://same-a.test/products/x' },
      { product_id: 'b', price: 28, currency: 'USD', destination_url: 'https://same-b.test/products/y' },
    ],
  });
  test.mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    const outs = [];
    for (const env of [{}, { [HOST_BACKOFF_FLAG]: '' }, { [HOST_BACKOFF_FLAG]: 'off' }, { [HOST_BACKOFF_FLAG]: '0' }]) {
      // A different path per run, so the response cache never answers; the hosts' answers stay the same.
      const page = scenario();
      for (const c of page.products) c.destination_url = `${c.destination_url}-${outs.length}`;
      const m = merchant({ 'same-a.test': 429, 'same-b.test': 200 });
      const out = await overlayLiveMerchantSearchPrices(page, { fetchImpl: m.fetchImpl, env });
      outs.push(JSON.stringify(out).replace(/-\d"/g, '"'));
    }
    assert.equal(new Set(outs).size, 1);
    assert.equal(_hostBackoff.size, 0);
  } finally {
    test.mock.timers.reset();
  }
});

test('flag on: one 429 backs the host off for every later read on the instance; other hosts are untouched', async () => {
  const m = merchant({ 'busy.test': 429, 'calm.test': 200 });
  const first = await overlayLiveMerchantSearchPrices({ products: cards('busy.test', 8) }, { fetchImpl: m.fetchImpl, env: ON });
  // Four readers were already in flight when the first 429 landed; the four queued behind them never go out.
  assert.equal(m.calls.length, 4);
  assert.deepEqual(lmp(first).failure_reasons, { http_429: 4, host_backoff: 4 });
  assert.equal(lmp(first).fetch_attempt_count, 4, 'a skipped card is not an attempt');
  assert.ok(first.products.every((p) => p.price === 28 && p.price_source === 'catalog_offer'), 'skipped cards keep the stored price');

  // Another request (another page): the busy host is not read at all; the calm one is.
  m.calls.length = 0;
  const second = await overlayLiveMerchantSearchPrices({ products: [...cards('busy.test', 3), ...cards('calm.test', 2)] }, { fetchImpl: m.fetchImpl, env: ON });
  assert.deepEqual(m.calls.map((u) => new URL(u).hostname), ['calm.test', 'calm.test']);
  assert.deepEqual(lmp(second).failure_reasons, { host_backoff: 3 });
  assert.equal(lmp(second).verified_count, 2);
  assert.equal(lmp(second).fetch_attempt_count, 2);
  assert.deepEqual(second.products.slice(0, 3).map((p) => [p.price, p.price_source]), Array(3).fill([28, 'catalog_offer']));
});

test('flag on: 60 s, doubling on a repeat up to 10 min; a 2xx clears it; in-flight refusals do not double it', async () => {
  test.mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    let status = 429;
    const m = merchant({ 'slow.test': () => status });
    const page = (n = 1) => overlayLiveMerchantSearchPrices({ products: cards('slow.test', n) }, { fetchImpl: m.fetchImpl, env: ON });

    await page(8); // four 429s from the four readers in flight together, then four skips
    assert.deepEqual(_hostBackoff.get('slow.test'), { until: T0 + MIN, ms: MIN, status: 429 });

    test.mock.timers.tick(MIN - 1);
    m.calls.length = 0;
    assert.deepEqual(lmp(await page()).failure_reasons, { host_backoff: 1 });
    assert.equal(m.calls.length, 0, 'still backed off 1 ms before the end');

    const expected = [2, 4, 8, 10, 10].map((n) => n * MIN);
    for (const ms of expected) {
      test.mock.timers.tick(_hostBackoff.get('slow.test').until - Date.now());
      m.calls.length = 0;
      assert.deepEqual(lmp(await page()).failure_reasons, { http_429: 1 }, 'read again once the backoff ends');
      assert.equal(m.calls.length, 1);
      assert.equal(_hostBackoff.get('slow.test').ms, ms);
    }

    test.mock.timers.tick(_hostBackoff.get('slow.test').until - Date.now());
    status = 200;
    assert.equal(lmp(await page()).verified_count, 1);
    assert.equal(_hostBackoff.has('slow.test'), false, 'a 2xx clears the host');

    status = 503;
    await page();
    assert.equal(_hostBackoff.get('slow.test').ms, MIN, 'a 5xx backs off too, from the start again');
    test.mock.timers.tick(MIN + 10 * MIN);
    await page();
    assert.equal(_hostBackoff.get('slow.test').ms, MIN, 'a refusal 10 min after the last backoff ended is not a repeat');
  } finally {
    test.mock.timers.reset();
  }
});

test('flag on: a 403, a 404 or a network error is not a reason to back off', async () => {
  for (const status of [403, 404]) {
    await overlayLiveMerchantSearchPrices({ products: cards(`s${status}.test`, 1) }, { fetchImpl: merchant({ [`s${status}.test`]: status }).fetchImpl, env: ON });
  }
  await overlayLiveMerchantSearchPrices({ products: cards('neterr.test', 1) }, { fetchImpl: async () => { throw new Error('reset'); }, env: ON });
  assert.equal(_hostBackoff.size, 0);
});

test('flag on: a backed-off host still answers from the response cache (a cached read is no new request)', async () => {
  const first = cards('cached.test', 1);
  const m = merchant({ 'cached.test': (url) => (url === `${first[0].destination_url}.json` ? 200 : 429) });
  await overlayLiveMerchantSearchPrices({ products: first }, { fetchImpl: m.fetchImpl, env: ON });
  await overlayLiveMerchantSearchPrices({ products: cards('cached.test', 1) }, { fetchImpl: m.fetchImpl, env: ON });
  assert.ok(_hostBackoff.has('cached.test'));
  m.calls.length = 0;
  const out = await overlayLiveMerchantSearchPrices({ products: [...first, ...cards('cached.test', 1)] }, { fetchImpl: m.fetchImpl, env: ON });
  assert.equal(m.calls.length, 0);
  assert.equal(lmp(out).cache_hit_count, 1);
  assert.equal(out.products[0].price_source, 'merchant_live');
  assert.deepEqual(lmp(out).failure_reasons, { host_backoff: 1 });
});

// ---- the price_verification_served line ----

function sink() {
  const lines = [];
  return { lines, info: (obj, msg) => lines.push({ ...obj, msg }) };
}

test('the line names the hosts that refused or were skipped (flag on or off), at most 8, most refusals first', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  for (const env of [{}, ON]) {
    _hostBackoff.clear();
    const log = sink();
    const products = [
      ...cards('a-throttle.test', 6), ...cards('ok.test', 1),
      ...[...'bcdefghijk'].flatMap((c, i) => cards(`${c}-throttle.test`, i < 2 ? 2 : 1)),
    ];
    const m = merchant(Object.fromEntries([...'abcdefghijk'].map((c) => [`${c}-throttle.test`, 429]).concat([['ok.test', 200]])));
    await pv.runWithPriceContext({ door: 'rest' }, async () => {
      const out = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: m.fetchImpl, env });
      pv.logPriceVerificationServed(log, { surface: 'search', items: out.products });
    });
    const line = log.lines[0];
    assert.deepEqual(Object.keys(line.overlay_throttled_hosts).length, 8);
    assert.equal(line.overlay_throttled_hosts['a-throttle.test'], 6, 'a 429 and a backoff skip both count');
    assert.equal(line.overlay_throttled_hosts['b-throttle.test'], 2);
    assert.equal(line.overlay_throttled_hosts['c-throttle.test'], 2);
    assert.deepEqual(Object.keys(line.overlay_throttled_hosts).slice(3), ['d-throttle.test', 'e-throttle.test', 'f-throttle.test', 'g-throttle.test', 'h-throttle.test']);
    assert.equal('ok.test' in line.overlay_throttled_hosts, false);
    assert.equal(line.live, 1);
  }
});

test('a line without a refusal or a cache answer carries neither field; flag off, nothing is noted', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  const log = sink();
  await pv.runWithPriceContext({ door: 'rest' }, async () => {
    const out = await overlayLiveMerchantSearchPrices({ products: cards('clean.test', 2) }, { fetchImpl: merchant({ 'clean.test': 200 }).fetchImpl, env: ON });
    pv.logPriceVerificationServed(log, { surface: 'search', items: out.products });
  });
  assert.equal('overlay_throttled_hosts' in log.lines[0], false);
  assert.equal('overlay_cache_not_live' in log.lines[0], false);
  assert.equal(log.lines[0].live, 2);

  delete process.env.PRICE_VERIFICATION_LOG;
  await pv.runWithPriceContext({ door: 'rest' }, async () => {
    await overlayLiveMerchantSearchPrices({ products: cards('quiet.test', 1) }, { fetchImpl: merchant({ 'quiet.test': 429 }).fetchImpl, env: ON });
    const store = pv.currentPriceContext();
    assert.equal(store.search_overlay_throttled_hosts, undefined);
    assert.equal(store.search_overlay_cached_at, undefined);
  });
  assert.equal(_hostBackoff.has('quiet.test'), true, 'the backoff itself does not depend on the log flag');
});

test('an answer from the overlay cache is recent, never live, even when filled after this request started', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  const products = cards('burst.test', 2);
  const m = merchant({ 'burst.test': 200 });
  const log = sink();
  // Request B started first; request A's reads land after B started; B then reads the cache A filled.
  const startedB = Date.now() - 500;
  await pv.runWithPriceContext({ door: 'rest' }, async () => {
    const a = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: m.fetchImpl, env: {} });
    pv.logPriceVerificationServed(log, { surface: 'search', items: a.products });
  });
  await pv.runWithPriceContext({ door: 'rest', started_at_ms: startedB }, async () => {
    const b = await overlayLiveMerchantSearchPrices({ products: [...products, ...cards('burst.test', 1)] }, { fetchImpl: m.fetchImpl, env: {} });
    assert.equal(lmp(b).cache_hit_count, 2);
    assert.deepEqual(b.products.map((p) => p.price_source), ['merchant_live', 'merchant_live', 'merchant_live']);
    pv.logPriceVerificationServed(log, { surface: 'search', items: b.products });
  });
  const [a, b] = log.lines;
  assert.deepEqual([a.live, a.recent, a.stored, a.verified_count, a.total], [2, 0, 0, 2, 2]);
  assert.equal('overlay_cache_not_live' in a, false);
  assert.deepEqual([b.live, b.recent, b.stored, b.verified_count, b.total], [1, 2, 0, 3, 3], 'the one read B made itself is live');
  assert.equal(b.overlay_cache_not_live, 2);
});

test('the overlay reports to its door from a loopback call, and a replay line ignores what was noted', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  const door = { door: 'mcp', started_at_ms: Date.now() - 500, request_id: 'door' };
  await pv.runWithPriceContext({ door: 'mcp', via_loopback: true, parent: door }, async () => {
    await overlayLiveMerchantSearchPrices({ products: cards('loop.test', 1) }, { fetchImpl: merchant({ 'loop.test': 503 }).fetchImpl, env: {} });
  });
  assert.deepEqual(door.search_overlay_throttled_hosts, { 'loop.test': 1 });

  const log = sink();
  await pv.runWithPriceContext(door, async () => {
    pv.logPriceVerificationServed(log, { surface: 'search', items: [], replay: true });
    pv.logPriceVerificationServed(log, { surface: 'get_product', items: [] });
    pv.logPriceVerificationServed(log, { surface: 'search', items: [] });
  });
  assert.equal('overlay_throttled_hosts' in log.lines[0], false, 'a replay ran no overlay');
  assert.equal('overlay_throttled_hosts' in log.lines[1], false, 'search lines only');
  assert.deepEqual(log.lines[2].overlay_throttled_hosts, { 'loop.test': 1 });
});

test('countFacts: each noted stamp turns one would-be-live fact into a replay, and nothing else', () => {
  const started = T0;
  const at = T0 + 200;
  const fact = { priced: true, merchant: true, at };
  const o = { startedAtMs: started, nowMs: T0 + 1000, ttlMs: 15 * MIN };
  assert.deepEqual(pv.countFacts([fact, fact], o), { live: 2, recent: 0, stored: 0, total: 2 });
  assert.deepEqual(pv.countFacts([fact, fact], { ...o, cachedAt: [at] }), { live: 1, recent: 1, stored: 0, total: 2, cache_not_live: 1 });
  // An older cached answer was recent anyway; a stamp that matches nothing changes nothing.
  const older = { priced: true, merchant: true, at: T0 - 5 * MIN };
  assert.deepEqual(pv.countFacts([older, fact], { ...o, cachedAt: [older.at, T0 + 999] }), { live: 1, recent: 1, stored: 0, total: 2, cache_not_live: 0 });
  // Past the window, a cached answer is stored, as any replay would be.
  assert.deepEqual(pv.countFacts([fact], { ...o, ttlMs: 0, cachedAt: [at] }), { live: 0, recent: 0, stored: 1, total: 1, cache_not_live: 1 });
});
