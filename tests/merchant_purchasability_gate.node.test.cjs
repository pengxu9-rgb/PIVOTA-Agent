'use strict';

// The merchant-purchasability gate: the client, the decision rule, and the warm-handoff seam.
//
// NO NETWORK. The backend is a stubbed `fetchImpl` (the house pattern —
// tests/commerce_store_audit_worker.test.js, tests/cloud_run_identity_token.test.js) and the merchant
// is the existing fake UCP buyer-agent client. Nothing here resolves DNS.
//
// Discovered by `scripts/run_node_test_suites.cjs` (glob over tests/**/*.node.test.cjs), which is what
// the `node-tests` job of .github/workflows/pr-full-jest.yml runs.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GATE_FLAG_ENV,
  OPS_TOKEN_ENV,
  BASE_URL_ENV,
  SOURCE,
  isGateEnabled,
  normalizeDomain,
  normalizeMarket,
  buildFactUrl,
  parseFact,
  decide,
  createMerchantPurchasabilityClient,
} = require('../src/services/merchantPurchasabilityClient');

const { createWarmHandoffService } = require('../src/services/ucpWarmHandoff');
const { resolveCheckoutHandoff } = require('../src/services/checkoutHandoffResolver');

// ---- fixtures ------------------------------------------------------------------------------------------

const BASE = 'https://backend.example';
const TOKEN = 'admin-jwt-fixture';
// The incident merchant. PayPal-only rendered checkout, USD 8.00 against our indexed USD 14.95.
const MERCHANT = 'flowerbeauty.com';
const ORIGIN = `https://${MERCHANT}`;
const VARIANT = 'gid://shopify/ProductVariant/17281773207622';

function gateEnv(extra = {}) {
  return {
    [GATE_FLAG_ENV]: '1',
    [BASE_URL_ENV]: BASE,
    [OPS_TOKEN_ENV]: TOKEN,
    ...extra,
  };
}

/** A backend that answers one body, recording every request. */
function fakeBackend(body, { status = 200, ok = true, throws = null, hang = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw throws;
    if (hang) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return {
      ok,
      status,
      json: async () => body,
    };
  };
  return { fetchImpl, calls };
}

/** Collects structured log lines. */
function fakeLogger() {
  const lines = [];
  const sink = (level) => (detail) => lines.push({ level, ...detail });
  return { lines, warn: sink('warn'), info: sink('info'), error: sink('error') };
}

/** The merchant, faked. Same shape as tests/ucp_warm_handoff_service.test.js. */
function fakeMerchantClient({ reachableOrigins = [ORIGIN] } = {}) {
  const calls = { discover: [], createCart: [] };
  return {
    calls,
    client: {
      async discoverEndpoint(origin) {
        calls.discover.push(origin);
        if (reachableOrigins.includes(origin)) return { mcpEndpoint: `${origin}/api/ucp/mcp`, status: 200 };
        return { mcpEndpoint: undefined, status: 404 };
      },
      async createCart(endpoint, { lineItems }) {
        calls.createCart.push({ endpoint, lineItems });
        return {
          ok: true,
          status: 200,
          response: {
            result: {
              content: [{
                type: 'json',
                json: {
                  id: 'gid://shopify/Cart/fixture123',
                  continue_url: 'https://flowerbeauty.myshopify.com/cart/c/fixture123?key=KEYTAIL',
                  line_items: [{ item: { id: lineItems[0].item.id, title: 'Flower Beauty Fixture' }, quantity: lineItems[0].quantity }],
                },
              }],
            },
          },
        };
      },
      extractHandoffUrl(cart) {
        const j = cart && cart.response && cart.response.result && cart.response.result.content
          && cart.response.result.content[0] && cart.response.result.content[0].json;
        return j ? (j.continue_url || null) : null;
      },
    },
  };
}

function warmService({ env, backend, logger, now, ttlMs, negativeTtlMs, timeoutMs, merchant }) {
  const m = merchant || fakeMerchantClient();
  return {
    merchant: m,
    service: createWarmHandoffService({
      client: m.client,
      logger: logger || null,
      metrics: {},
      env,
      purchasability: {
        env,
        logger: logger || null,
        fetchImpl: backend ? backend.fetchImpl : undefined,
        ...(now ? { now } : {}),
        ...(ttlMs ? { ttlMs } : {}),
        ...(negativeTtlMs ? { negativeTtlMs } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      },
    }),
  };
}

const FACT_BROWSE_ONLY = { tier: 'browse_only', enforced: true, sweep_enabled: true };
const FACT_PURCHASE = { tier: 'purchase', enforced: true, sweep_enabled: true };
const FACT_NOT_ENFORCED = { tier: 'browse_only', enforced: false, sweep_enabled: true };

// ---- 0. the flag ---------------------------------------------------------------------------------------

test('the gateway switch is OFF by default and only the truthy allowlist arms it', () => {
  assert.equal(isGateEnabled({}), false);
  assert.equal(isGateEnabled({ [GATE_FLAG_ENV]: '' }), false);
  assert.equal(isGateEnabled({ [GATE_FLAG_ENV]: '0' }), false);
  assert.equal(isGateEnabled({ [GATE_FLAG_ENV]: 'false' }), false);
  assert.equal(isGateEnabled({ [GATE_FLAG_ENV]: 'off' }), false);
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on', 'enabled', ' on ']) {
    assert.equal(isGateEnabled({ [GATE_FLAG_ENV]: on }), true, on);
  }
});

// ---- 1. normalisation must agree with the backend's writer ----------------------------------------------

test('normalizeDomain folds the way the backend `normalize_domain` does', () => {
  assert.equal(normalizeDomain('www.Judydoll.com'), 'judydoll.com');
  assert.equal(normalizeDomain('JUDYDOLL.COM'), 'judydoll.com');
  assert.equal(normalizeDomain('https://www.flowerbeauty.com/products/x?y=1'), 'flowerbeauty.com');
  assert.equal(normalizeDomain('flowerbeauty.com:443'), 'flowerbeauty.com');
  assert.equal(normalizeDomain('flowerbeauty.com.'), 'flowerbeauty.com');
  // Only ONE leading www. is stripped, exactly as the backend does.
  assert.equal(normalizeDomain('www.www.example.com'), 'www.example.com');
  for (const bad of ['', null, undefined, 'localhost', 'not a domain', '  ']) {
    assert.equal(normalizeDomain(bad), null, String(bad));
  }
});

test('normalizeMarket is exactly two letters, uppercased — never a longer code', () => {
  assert.equal(normalizeMarket('us'), 'US');
  assert.equal(normalizeMarket(' sg '), 'SG');
  for (const bad of ['', 'USA', 'U', 'EU-DE', '12', null, undefined]) {
    assert.equal(normalizeMarket(bad), null, String(bad));
  }
});

// ---- 2. the decision rule, without a transport ----------------------------------------------------------

test('decide(): `tier` is consulted ONLY when enforced === true', () => {
  assert.deepEqual(decide(FACT_PURCHASE), { offer: true, source: SOURCE.gate });
  assert.deepEqual(decide(FACT_BROWSE_ONLY), { offer: false, source: SOURCE.gate });
  // enforced false => every merchant reads browse_only; consuming it would take the catalogue browse-only.
  assert.deepEqual(decide(FACT_NOT_ENFORCED), { offer: true, source: SOURCE.previous });
  assert.deepEqual(decide({ tier: 'purchase', enforced: false, sweep_enabled: true }),
    { offer: true, source: SOURCE.previous });
  assert.deepEqual(decide(null), { offer: true, source: SOURCE.failed });

  // `decide` is EXPORTED, so it must carry the rule on its own rather than lean on parseFact
  // having already narrowed `tier` to two strings. A tier nobody here recognises is not a
  // browse-only verdict — it is an unknown, and an unknown fails OPEN. A prefix/substring test
  // (`startsWith('browse')`) reads each of these as a refusal.
  for (const tier of ['browse_pending', 'browsing', 'browse', 'unknown', '']) {
    assert.deepEqual(decide({ tier, enforced: true, sweep_enabled: true }),
      { offer: true, source: SOURCE.gate }, tier);
  }
});

test('parseFact(): tier is compared by EQUALITY, and a non-boolean `enforced` is malformed', () => {
  assert.deepEqual(parseFact({ tier: 'purchase', enforced: true, sweep_enabled: false }),
    { tier: 'purchase', enforced: true, sweep_enabled: false });
  // A loose compare (startsWith / includes / truthiness) would admit each of these.
  for (const tier of ['browse_only_pending', 'purchase_blocked', 'BROWSE_ONLY', 'browse', '', 'purchases']) {
    assert.equal(parseFact({ tier, enforced: true }), null, tier);
  }
  for (const enforced of ['true', 1, null, undefined]) {
    assert.equal(parseFact({ tier: 'browse_only', enforced }), null, String(enforced));
  }
  for (const body of [null, undefined, 'x', 42, ['tier']]) {
    assert.equal(parseFact(body), null, String(body));
  }
});

// ---- 3. the outbound call: URL, auth, and what is NOT in it ----------------------------------------------

test('the outbound URL carries EXACTLY domain and market — no buyer data, ever', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const client = createMerchantPurchasabilityClient({ env: gateEnv(), fetchImpl: backend.fetchImpl });
  await client.shouldOfferPurchase({ domain: 'www.FlowerBeauty.com', market: 'us' });

  assert.equal(backend.calls.length, 1);
  const url = new URL(backend.calls[0].url);
  assert.equal(url.origin + url.pathname, `${BASE}/ops/merchant-purchasability`);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['domain', 'market']);
  assert.equal(url.searchParams.get('domain'), 'flowerbeauty.com');
  assert.equal(url.searchParams.get('market'), 'US');

  // Nothing a buyer could be identified by may appear anywhere in the request line.
  const wire = backend.calls[0].url.toLowerCase();
  for (const leak of ['email', '@', 'buyer', 'address', 'postal', 'zip', 'phone', 'name', 'session', 'cart', 'variant', 'token']) {
    assert.equal(wire.includes(leak), false, `outbound URL leaked "${leak}": ${wire}`);
  }
});

test('auth is a Bearer JWT, never the X-ADMIN-KEY header these ops routes refuse', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const client = createMerchantPurchasabilityClient({ env: gateEnv(), fetchImpl: backend.fetchImpl });
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });

  const headers = backend.calls[0].options.headers;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  const names = Object.keys(headers).map((k) => k.toLowerCase());
  assert.equal(names.includes('x-admin-key'), false);
  assert.equal(backend.calls[0].options.method, 'GET');
  assert.equal(backend.calls[0].options.redirect, 'error');
});

test('a request with no market asks NOTHING and keeps the previous behaviour', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const logger = fakeLogger();
  const client = createMerchantPurchasabilityClient({ env: gateEnv(), fetchImpl: backend.fetchImpl, logger });

  for (const market of [undefined, null, '', 'USA', 'EU-DE']) {
    const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market });
    assert.deepEqual(decision, { offer: true, source: SOURCE.failed }, String(market));
  }
  // No market means no question — and certainly not a question keyed on this deployment's own market.
  assert.equal(backend.calls.length, 0);
  assert.equal(logger.lines.some((l) => l.event === 'merchant_purchasability_unkeyable'), true);
});

// ---- 4. fail OPEN on every failure -----------------------------------------------------------------------

test('non-200, malformed body, throw and timeout ALL fail open to the previous behaviour', async () => {
  const cases = [
    ['500', fakeBackend(null, { ok: false, status: 500 })],
    ['404', fakeBackend(null, { ok: false, status: 404 })],
    ['malformed', fakeBackend({ tier: 'maybe', enforced: true })],
    ['empty body', fakeBackend({})],
    ['html body', fakeBackend('<html>502</html>')],
    ['throw', fakeBackend(null, { throws: new Error('ECONNREFUSED') })],
  ];
  for (const [label, backend] of cases) {
    const client = createMerchantPurchasabilityClient({ env: gateEnv(), fetchImpl: backend.fetchImpl });
    const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
    assert.deepEqual(decision, { offer: true, source: SOURCE.failed }, label);
  }
});

test('a hanging backend is ABORTED by the timeout and fails open', async () => {
  const backend = fakeBackend(null, { hang: true });
  const logger = fakeLogger();
  const client = createMerchantPurchasabilityClient({
    env: gateEnv(), fetchImpl: backend.fetchImpl, logger, timeoutMs: 20,
  });
  const started = Date.now();
  const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.deepEqual(decision, { offer: true, source: SOURCE.failed });
  // The abort fired: without a timeout this promise never settles and the test times out instead.
  assert.ok(Date.now() - started < 2000);
  assert.equal(logger.lines.some((l) => l.event === 'merchant_purchasability_read_failed' && l.failure === 'timeout'), true);
});

test('the per-call budget is CAPPED at 2s — MEASURED, not read off the constant', async () => {
  // Asserting `MAX_TIMEOUT_MS === 2000` would pass with the Math.min deleted: the constant would
  // still be 2000 and a caller asking for 60s would still get 60s. So this MEASURES the abort.
  const backend = fakeBackend(null, { hang: true });
  const client = createMerchantPurchasabilityClient({
    env: gateEnv(), fetchImpl: backend.fetchImpl, timeoutMs: 60_000,
  });
  const started = Date.now();
  const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  const elapsed = Date.now() - started;
  assert.deepEqual(decision, { offer: true, source: SOURCE.failed });
  assert.ok(elapsed < 4000, `a 60s request must be capped to 2s; took ${elapsed}ms`);
  assert.ok(elapsed >= 1500, `it must still WAIT the budget, not abort instantly; took ${elapsed}ms`);
});

test('an unconfigured credential is not an outage: previous behaviour, logged once', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const logger = fakeLogger();
  const client = createMerchantPurchasabilityClient({
    env: { [GATE_FLAG_ENV]: '1', [BASE_URL_ENV]: BASE }, fetchImpl: backend.fetchImpl, logger,
  });
  const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.deepEqual(decision, { offer: true, source: SOURCE.failed });
  assert.equal(backend.calls.length, 0);
  assert.equal(logger.lines.filter((l) => l.event === 'merchant_purchasability_not_configured').length, 1);
});

// ---- 5. enforced=false: unchanged, and said once ---------------------------------------------------------

test('enforced=false keeps the previous behaviour and logs ONCE per interval', async () => {
  const backend = fakeBackend(FACT_NOT_ENFORCED);
  const logger = fakeLogger();
  let clock = 1_000_000;
  const client = createMerchantPurchasabilityClient({
    env: gateEnv(), fetchImpl: backend.fetchImpl, logger, now: () => clock,
  });

  for (let i = 0; i < 4; i += 1) {
    const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
    assert.deepEqual(decision, { offer: true, source: SOURCE.previous });
  }
  const notEnforced = logger.lines.filter((l) => l.event === 'merchant_purchasability_not_enforced');
  assert.equal(notEnforced.length, 1);
  assert.equal(notEnforced[0].domain, MERCHANT);
  assert.equal(notEnforced[0].market, 'US');
});

// ---- 6. the misordered-arming alarm ---------------------------------------------------------------------

test('sweep_enabled=false with enforced=true is logged LOUDLY (error), once per interval', async () => {
  const backend = fakeBackend({ tier: 'browse_only', enforced: true, sweep_enabled: false });
  const logger = fakeLogger();
  let clock = 1_000_000;
  const client = createMerchantPurchasabilityClient({
    // A SHORT fact cache, so the second call genuinely re-reads the backend and re-sees the
    // misordered pair — while the log guard's own 5-minute interval has NOT elapsed. Reusing the
    // cache TTL here would expire the guard too and the test would pass without a rate limiter.
    env: gateEnv(), fetchImpl: backend.fetchImpl, logger, now: () => clock, ttlMs: 1000,
  });

  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  clock += 2000; // past the fact cache, well inside the log interval
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(backend.calls.length, 2, 'the fact was genuinely re-read');

  const alarms = logger.lines.filter((l) => l.event === 'merchant_purchasability_misordered_arming');
  assert.equal(alarms.length, 1, 'once per interval, not once per call');
  assert.equal(alarms[0].level, 'error');
  assert.equal(alarms[0].sweep_enabled, false);
  assert.equal(alarms[0].enforced, true);

  // A healthy pair raises no alarm.
  const healthy = fakeBackend(FACT_BROWSE_ONLY);
  const logger2 = fakeLogger();
  const client2 = createMerchantPurchasabilityClient({ env: gateEnv(), fetchImpl: healthy.fetchImpl, logger: logger2 });
  await client2.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(logger2.lines.some((l) => l.event === 'merchant_purchasability_misordered_arming'), false);
});

// ---- 7. the cache ----------------------------------------------------------------------------------------

test('a fact is cached per (domain, market): hit inside 5 min, miss after', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  let clock = 1_000_000;
  const client = createMerchantPurchasabilityClient({
    env: gateEnv(), fetchImpl: backend.fetchImpl, now: () => clock,
  });

  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(backend.calls.length, 1);

  clock += 4 * 60 * 1000 + 59_000; // 4m59s — inside the window
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(backend.calls.length, 1, 'cache HIT inside 5 minutes');

  clock += 2000; // 5m01s — outside it
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(backend.calls.length, 2, 'cache MISS after 5 minutes');

  // A DIFFERENT market is a different key — a US fact never answers for SG.
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'SG' });
  assert.equal(backend.calls.length, 3);
  assert.equal(new URL(backend.calls[2].url).searchParams.get('market'), 'SG');
});

test('a caller cannot widen the cache past 5 minutes', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  let clock = 1_000_000;
  const client = createMerchantPurchasabilityClient({
    env: gateEnv(), fetchImpl: backend.fetchImpl, now: () => clock, ttlMs: 60 * 60 * 1000,
  });
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  clock += 5 * 60 * 1000 + 1;
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(backend.calls.length, 2, 'the 5-minute ceiling is a Math.min, not a default');
});

test('the cache is BOUNDED: the oldest entry is evicted, not retained', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const client = createMerchantPurchasabilityClient({
    env: gateEnv(), fetchImpl: backend.fetchImpl, cacheMaxEntries: 3,
  });
  for (let i = 0; i < 25; i += 1) {
    await client.shouldOfferPurchase({ domain: `merchant${i}.example`, market: 'US' });
  }
  assert.equal(client._cache.size, 3, 'an unbounded map keyed on a domain is a memory leak with a name');
});

// ---- 8. THE SEAM: switch OFF is byte-identical ------------------------------------------------------------

// The pinned response. With the gateway switch off this must be produced verbatim, whatever the backend
// would have said — which is why the backend below answers `browse_only` and is never consulted.
const PINNED_HANDOFF = {
  disposition: 'warm_handoff',
  continue_url: 'https://flowerbeauty.myshopify.com/cart/c/fixture123?key=KEYTAIL',
  cart_id: 'gid://shopify/Cart/fixture123',
  line_item: { variant_gid: VARIANT, quantity: 1, title: 'Flower Beauty Fixture' },
  mcp_endpoint: `${ORIGIN}/api/ucp/mcp`,
};

test('SWITCH OFF: the door answer is byte-identical and the backend is never called', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const env = { [BASE_URL_ENV]: BASE, [OPS_TOKEN_ENV]: TOKEN }; // switch absent == OFF
  const { service, merchant } = warmService({ env, backend });

  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });

  assert.deepEqual(handoff, PINNED_HANDOFF);
  assert.equal(backend.calls.length, 0, 'the switch is off: nothing is asked of the backend');
  assert.deepEqual(merchant.calls.discover, [ORIGIN]);
  assert.equal(merchant.calls.createCart.length, 1);
});

test('SWITCH OFF is byte-identical even with the backend enforcing browse_only', async () => {
  // The same merchant the gate WOULD decline. Off is off.
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const off = warmService({ env: { [GATE_FLAG_ENV]: 'false', [BASE_URL_ENV]: BASE, [OPS_TOKEN_ENV]: TOKEN }, backend });
  const handoff = await off.service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
  assert.deepEqual(handoff, PINNED_HANDOFF);
  assert.equal(backend.calls.length, 0);
});

// ---- 9. THE SEAM: on + enforced + browse_only --------------------------------------------------------------

test('ON + enforced + browse_only: no purchase offered, and the merchant is not even contacted', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const logger = fakeLogger();
  const { service, merchant } = warmService({ env: gateEnv(), backend, logger });

  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });

  assert.equal(handoff, null, 'null IS the fallback: every caller cold-redirects on it');
  assert.deepEqual(merchant.calls.discover, [], 'a merchant we will not sell for is not contacted');
  assert.deepEqual(merchant.calls.createCart, []);
  assert.equal(backend.calls.length, 1);

  const declined = logger.lines.find((l) => l.event === 'ucp_warm_handoff_merchant_not_purchasable');
  assert.ok(declined, 'the refusal is logged');
  assert.equal(declined.brand_domain, MERCHANT);
  assert.equal(declined.market, 'US');
  assert.equal(declined.source, SOURCE.gate);
});

test('ON + enforced + purchase: byte-identical to the switch-off answer', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const { service } = warmService({ env: gateEnv(), backend });
  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
  assert.deepEqual(handoff, PINNED_HANDOFF);
  assert.equal(backend.calls.length, 1, 'the gate was consulted');
});

test('ON + enforced=false: byte-identical, because `tier` is browse_only for EVERYONE in that state', async () => {
  const backend = fakeBackend(FACT_NOT_ENFORCED);
  const logger = fakeLogger();
  const { service } = warmService({ env: gateEnv(), backend, logger });
  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
  assert.deepEqual(handoff, PINNED_HANDOFF);
  assert.equal(logger.lines.filter((l) => l.event === 'merchant_purchasability_not_enforced').length, 1);
});

test('ON + backend 500 / timeout / malformed: byte-identical (FAIL OPEN)', async () => {
  for (const [label, backend] of [
    ['500', fakeBackend(null, { ok: false, status: 500 })],
    ['malformed', fakeBackend({ tier: 'nope', enforced: true })],
    ['throw', fakeBackend(null, { throws: new Error('ETIMEDOUT') })],
  ]) {
    const { service } = warmService({ env: gateEnv(), backend, timeoutMs: 50 });
    const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
    assert.deepEqual(handoff, PINNED_HANDOFF, label);
  }
  // And the hang, separately, so the abort is what resolves it.
  const hanging = fakeBackend(null, { hang: true });
  const { service } = warmService({ env: gateEnv(), backend: hanging, timeoutMs: 20 });
  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
  assert.deepEqual(handoff, PINNED_HANDOFF, 'timeout');
});

test('ON + enforced + browse_only but NO market on the request: byte-identical (no question to ask)', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const { service } = warmService({ env: gateEnv(), backend });
  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT });
  assert.deepEqual(handoff, PINNED_HANDOFF);
  assert.equal(backend.calls.length, 0, 'the deployment market is NOT substituted for the buyer market');
});

test('the gate keys on the REQUEST market, so SG and US are answered separately', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    const market = new URL(url).searchParams.get('market');
    return { ok: true, status: 200, json: async () => (market === 'SG' ? FACT_BROWSE_ONLY : FACT_PURCHASE) };
  };
  const env = gateEnv();
  const m = fakeMerchantClient();
  const service = createWarmHandoffService({
    client: m.client, metrics: {}, env, purchasability: { env, fetchImpl },
  });

  assert.deepEqual(
    await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' }),
    PINNED_HANDOFF,
  );
  assert.equal(
    await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'SG' }),
    null,
  );
  assert.equal(calls.length, 2);
});

// ---- 10. the resolver lane, end to end ----------------------------------------------------------------------

function handoffInput({ market } = {}) {
  return {
    access_scope: { allow_checkout_handoff: true },
    context: { raw_user_goal: 'checkout_handoff' },
    ...(market ? { metadata: { market } } : {}),
    payload: {
      handoff_descriptor: {
        kind: 'pivota_agent_checkout_handoff',
        status: 'eligible',
        // `transactable` clears the deliverability conjunct; the ABSENT `commerce_path` is what makes
        // validateDescriptor answer `policy_not_supported` — the crawled-redirect branch, and the only
        // branch that tries the warm handoff. (A descriptor that fails EARLIER never reaches it, which
        // is how the first cut of this fixture silently tested nothing.)
        source_deliverability_status: 'transactable',
        merchant: { domain: MERCHANT },
        merchant_domain: MERCHANT,
        brand_domain: MERCHANT,
        variant_gid: VARIANT,
        product: { product_id: 'p_fixture' },
      },
    },
  };
}

async function resolveWithGate({ env, backend, market }) {
  const m = fakeMerchantClient();
  return {
    merchant: m,
    output: await resolveCheckoutHandoff(handoffInput({ market }), {
      env,
      warmHandoffOptions: {
        client: m.client,
        metrics: {},
        env,
        purchasability: { env, fetchImpl: backend.fetchImpl },
      },
    }),
  };
}

test('resolver lane: browse_only removes the purchase affordance and restores the BLOCK', async () => {
  const env = { ...gateEnv(), UCP_WARM_HANDOFF_ENABLED: '1' };
  const armed = await resolveWithGate({ env, backend: fakeBackend(FACT_BROWSE_ONLY), market: 'US' });
  const open = await resolveWithGate({ env, backend: fakeBackend(FACT_PURCHASE), market: 'US' });

  // The gated answer is the door's pre-existing browse/referral shape…
  assert.equal(armed.output.status, 'blocked');
  assert.equal(armed.output.checkout_handoff.status, 'blocked');
  assert.equal(armed.output.checkout_handoff.order_created, false);
  assert.equal(armed.output.checkout_handoff.payment_submitted, false);
  assert.equal(armed.merchant.calls.createCart.length, 0);

  // …and the ungated one is the purchase affordance it replaces.
  assert.equal(open.output.status, 'resolved');
  assert.equal(open.output.checkout_handoff.status, 'warm_handoff_ready');
  assert.equal(open.output.serviceability.orderable_offer, true);
  assert.ok(open.output.checkout_handoff.continue_url);
});

test('resolver lane: with the gateway switch OFF the block/affordance split is unchanged', async () => {
  const env = { [BASE_URL_ENV]: BASE, [OPS_TOKEN_ENV]: TOKEN, UCP_WARM_HANDOFF_ENABLED: '1' };
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const { output } = await resolveWithGate({ env, backend, market: 'US' });
  assert.equal(output.status, 'resolved');
  assert.equal(output.checkout_handoff.status, 'warm_handoff_ready');
  assert.equal(backend.calls.length, 0);
});

test('resolver lane: the market comes from the REQUEST (metadata.market), never a default', async () => {
  const env = { ...gateEnv(), UCP_WARM_HANDOFF_ENABLED: '1' };
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const withMarket = await resolveWithGate({ env, backend, market: 'SG' });
  assert.equal(withMarket.output.status, 'blocked');
  assert.equal(new URL(backend.calls[0].url).searchParams.get('market'), 'SG');

  // No market on the request => no question => the previous behaviour, NOT the served market.
  const backend2 = fakeBackend(FACT_BROWSE_ONLY);
  const without = await resolveWithGate({ env, backend: backend2 });
  assert.equal(without.output.status, 'resolved');
  assert.equal(backend2.calls.length, 0);
});

// ---- 11. buildFactUrl, directly ------------------------------------------------------------------------------

test('buildFactUrl encodes and never accepts a third parameter', () => {
  const url = new URL(buildFactUrl('https://b.example/', 'a b.com', 'US'));
  assert.equal(url.pathname, '/ops/merchant-purchasability');
  assert.equal(url.searchParams.get('domain'), 'a b.com');
  assert.equal([...url.searchParams].length, 2);
  // A trailing slash on the base must not double up.
  assert.equal(new URL(buildFactUrl('https://b.example///', 'x.com', 'US')).pathname, '/ops/merchant-purchasability');
});

// ---- 12. THE PROD SHAPE: the logger must actually be wired -------------------------------------------------
//
// Review of the first cut found BOTH production construction sites reaching the client with no
// logger — a ternary whose grouping discarded it — so the `error`-level misordered-arming alarm,
// the one signal an operator has that the two backend dials are armed in the wrong order, was
// written to `null` and emitted nowhere. Every test in this file passed, because every test in
// this file injected its own logger.
//
// So this constructs the service EXACTLY as production does (no `env`, no `purchasability`, no
// injected transport) and asserts the alarm reaches the SHARED MODULE LOGGER. The transport is
// still faked: `global.fetch` is the default `fetchImpl`, so stubbing it keeps the suite offline.

const {
  resetMerchantPurchasabilityClientForTest,
  isIsolatingDeps,
  createTtlCache,
  MIN_GATE_BUDGET_MS,
} = require('../src/services/merchantPurchasabilityClient');
const sharedLogger = require('../src/logger');

/** Run `fn` with process.env, global.fetch and the shared logger's sinks captured. */
async function withProdEnvironment(body, fn) {
  const savedFetch = global.fetch;
  const savedEnv = {};
  for (const k of [GATE_FLAG_ENV, BASE_URL_ENV, OPS_TOKEN_ENV]) savedEnv[k] = process.env[k];
  const savedSinks = { warn: sharedLogger.warn, info: sharedLogger.info, error: sharedLogger.error };

  const lines = [];
  const calls = [];
  process.env[GATE_FLAG_ENV] = '1';
  process.env[BASE_URL_ENV] = BASE;
  process.env[OPS_TOKEN_ENV] = TOKEN;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => body };
  };
  for (const level of ['warn', 'info', 'error']) {
    sharedLogger[level] = (detail) => { lines.push({ level, ...detail }); };
  }
  resetMerchantPurchasabilityClientForTest();
  try {
    return await fn({ lines, calls });
  } finally {
    global.fetch = savedFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    Object.assign(sharedLogger, savedSinks);
    resetMerchantPurchasabilityClientForTest();
  }
}

test('PROD SHAPE (no env, no options, logger null): the misordered-arming alarm REACHES a log', async () => {
  // `logger: deps.logger || null` is literally what ucpWarmHandoffInternalRoute passes.
  await withProdEnvironment({ tier: 'browse_only', enforced: true, sweep_enabled: false }, async ({ lines, calls }) => {
    const m = fakeMerchantClient();
    const service = createWarmHandoffService({
      totalBudgetMs: 2000,
      clientOptions: { timeoutMs: 1500 },
      logger: null,
      metrics: {},
      client: m.client,
    });
    const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });

    assert.equal(handoff, null, 'enforced browse_only still declines');
    assert.equal(calls.length, 1, 'the backend was read through the default global fetch');
    const alarm = lines.find((l) => l.event === 'merchant_purchasability_misordered_arming');
    assert.ok(alarm, `no alarm reached the shared logger; saw: ${JSON.stringify(lines.map((l) => l.event))}`);
    assert.equal(alarm.level, 'error');
    assert.equal(alarm.sweep_enabled, false);
  });
});

test('PROD SHAPE via the resolver lane (logger supplied): the alarm reaches THAT logger', async () => {
  await withProdEnvironment({ tier: 'browse_only', enforced: true, sweep_enabled: false }, async () => {
    const logger = fakeLogger();
    const m = fakeMerchantClient();
    const service = createWarmHandoffService({ logger, metrics: {}, client: m.client });
    await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
    assert.equal(logger.lines.some((l) => l.event === 'merchant_purchasability_misordered_arming'), true);
  });
});

test('a logger-only dep configures the shared singleton; anything that changes the ANSWER forks', () => {
  assert.equal(isIsolatingDeps(undefined), false);
  assert.equal(isIsolatingDeps({}), false);
  assert.equal(isIsolatingDeps({ logger: fakeLogger() }), false);
  for (const k of ['env', 'fetchImpl', 'now', 'ttlMs', 'negativeTtlMs', 'timeoutMs', 'cacheMaxEntries', 'baseUrl', 'token']) {
    assert.equal(isIsolatingDeps({ [k]: 1 }), true, k);
  }
});

// ---- 13. THE CLICK LANE IS INERT UNTIL THE BACKEND SENDS A MARKET -------------------------------------------
//
// The only caller of the internal click route (pivota-backend
// `services/outbound_warm_handoff.py`) posts {brand_domain, product_url, product_handle?,
// attribution?} — no market. That is the lane the flowerbeauty incident travelled, so until the
// backend adds `market` the gate cannot fire there at all. This pins the WARN so a mis-deployed
// backend is visible in a log rather than silently un-gated.

test('CLICK LANE: a body with no market logs `unkeyable` at WARN, once per interval', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const logger = fakeLogger();
  const { service } = warmService({ env: gateEnv(), backend, logger });

  for (let i = 0; i < 3; i += 1) {
    // exactly the shape the route builds today from that payload: no `market` key at all
    const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, quantity: 1 });
    assert.deepEqual(handoff, PINNED_HANDOFF, 'inert, not refusing — the gate must not fail closed here');
  }
  assert.equal(backend.calls.length, 0, 'nothing is asked without a market');

  const unkeyable = logger.lines.filter((l) => l.event === 'merchant_purchasability_unkeyable');
  assert.equal(unkeyable.length, 1, 'once per interval, not once per click');
  assert.equal(unkeyable[0].level, 'warn', 'a permanently inert gate must not hide at info level');
  assert.equal(unkeyable[0].has_market, false);
  assert.equal(unkeyable[0].has_domain, true);
});

test('CLICK LANE: the route forwards `body.market` when the backend does send it', async () => {
  const { createUcpWarmHandoffInternalHandler } = require('../src/services/ucpWarmHandoffInternalRoute');
  const seen = [];
  const env = {
    UCP_WARM_HANDOFF_INTERNAL_ROUTE_ENABLED: '1',
    UCP_WARM_HANDOFF_ENABLED: '1',
    UCP_WARM_HANDOFF_INTERNAL_KEY: 'click-key',
    UCP_WARM_HANDOFF_REQUIRE_AVAILABLE: '0',
  };
  const handler = createUcpWarmHandoffInternalHandler({
    env,
    metrics: {},
    service: {
      async resolveWarmHandoff(args) {
        seen.push(args);
        return { disposition: 'warm_handoff', continue_url: 'https://x.example/cart/c/1', cart_id: 'c1' };
      },
    },
  });

  const post = (body) => handler({ headers: { 'x-internal-key': 'click-key' }, body });
  await post({ brand_domain: MERCHANT, variant_gid: VARIANT, market: 'SG' });
  await post({ brand_domain: MERCHANT, variant_gid: VARIANT }); // today's backend payload

  assert.equal(seen.length, 2);
  assert.equal(seen[0].market, 'SG', 'a market on the body reaches the gate');
  assert.equal('market' in seen[1], false, 'and its absence is an absence, not a substituted default');
});

// ---- 14. THE GATE MUST NOT EAT THE CALLER'S BUDGET ----------------------------------------------------------

test('BUDGET: the gate is clamped to what is LEFT, so the cart below still gets built', async () => {
  // A backend that hangs. Without the clamp the gate would burn its own 1500ms ceiling out of a
  // 1200ms remaining budget and the handoff would cold-redirect for every merchant at once.
  const backend = fakeBackend(null, { hang: true });
  let clock = 5_000_000;
  const m = fakeMerchantClient();
  const env = gateEnv();
  const service = createWarmHandoffService({
    client: m.client,
    metrics: {},
    env,
    now: () => clock,
    totalBudgetMs: 1200,
    purchasability: { env, fetchImpl: backend.fetchImpl, timeoutMs: 1500 },
  });

  // The fake clock does not advance, so the abort must come from the CLAMPED real timer.
  const started = Date.now();
  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
  const elapsed = Date.now() - started;

  assert.deepEqual(handoff, PINNED_HANDOFF, 'fail open — and the cart still got built');
  assert.equal(m.calls.createCart.length, 1);
  assert.ok(elapsed < 1400, `the gate must not outlive the 1200ms budget; took ${elapsed}ms`);
});

test('BUDGET: below the floor the gate is SKIPPED outright (previous behaviour)', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const logger = fakeLogger();
  let clock = 5_000_000;
  const env = gateEnv();
  const m = fakeMerchantClient();
  const service = createWarmHandoffService({
    client: m.client,
    metrics: {},
    env,
    logger,
    // Budget already all but spent by the time resolveWarmHandoff is entered.
    totalBudgetMs: 100,
    now: () => clock,
    purchasability: { env, fetchImpl: backend.fetchImpl, logger, now: () => clock },
  });

  const handoff = await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
  assert.deepEqual(handoff, PINNED_HANDOFF, 'skipping is the PREVIOUS behaviour, never a refusal');
  assert.equal(backend.calls.length, 0, 'no read is attempted below the floor');
  const skipped = logger.lines.find((l) => l.event === 'merchant_purchasability_skipped_budget');
  assert.ok(skipped);
  assert.equal(skipped.floor_ms, MIN_GATE_BUDGET_MS);
});

test('BUDGET: a comfortable budget still consults the gate', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  let clock = 5_000_000;
  const env = gateEnv();
  const m = fakeMerchantClient();
  const service = createWarmHandoffService({
    client: m.client, metrics: {}, env, totalBudgetMs: 9000, now: () => clock,
    purchasability: { env, fetchImpl: backend.fetchImpl, now: () => clock },
  });
  assert.equal(
    await service.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' }),
    null,
  );
  assert.equal(backend.calls.length, 1);
});

// ---- 15. NO CREDENTIAL IN ANY LOG ---------------------------------------------------------------------------
//
// The URL test greps the WIRE. It says nothing about the logs, and a `token: bearer` field added to
// the read-failure log passed every test in the first cut. Logs are shipped, indexed and read by
// more people than the wire is, so the credential must not be in them either.

test('NO LOG LINE, ON ANY PATH, CARRIES THE CREDENTIAL', async () => {
  const SECRET = 'eyJhbGciOiJIUzI1NiJ9.SUPERSECRETJWTPAYLOAD.c2lnbmF0dXJl';
  const paths = [
    ['ok/purchase', fakeBackend(FACT_PURCHASE)],
    ['ok/browse_only', fakeBackend(FACT_BROWSE_ONLY)],
    ['not enforced', fakeBackend(FACT_NOT_ENFORCED)],
    ['misordered', fakeBackend({ tier: 'browse_only', enforced: true, sweep_enabled: false })],
    ['500', fakeBackend(null, { ok: false, status: 500 })],
    ['malformed', fakeBackend({ tier: 'nope', enforced: true })],
    ['throw', fakeBackend(null, { throws: new Error('ECONNREFUSED') })],
  ];

  const all = [];
  for (const [label, backend] of paths) {
    const logger = fakeLogger();
    const client = createMerchantPurchasabilityClient({
      env: { [GATE_FLAG_ENV]: '1', [BASE_URL_ENV]: BASE, [OPS_TOKEN_ENV]: SECRET },
      fetchImpl: backend.fetchImpl,
      logger,
    });
    await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
    // and the unconfigured / unkeyable / budget paths
    await client.shouldOfferPurchase({ domain: MERCHANT });
    await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US', budgetMs: 10 });
    for (const line of logger.lines) all.push({ label, line });
  }
  assert.ok(all.length >= paths.length, 'the matrix must actually produce logs');

  for (const { label, line } of all) {
    const rendered = JSON.stringify(line);
    assert.equal(rendered.includes(SECRET), false, `${label}/${line.event} logged the credential: ${rendered}`);
    assert.equal(/eyJ[A-Za-z0-9_-]{6,}/.test(rendered), false, `${label}/${line.event} logged a JWT-shaped string: ${rendered}`);
    for (const forbidden of ['authorization', 'bearer', 'token', 'jwt', 'credential', 'secret']) {
      assert.equal(
        rendered.toLowerCase().includes(forbidden), false,
        `${label}/${line.event} logged a "${forbidden}" field: ${rendered}`,
      );
    }
  }
});

// ---- 16. a TTL of zero means DO NOT CACHE, never "cache forever" ---------------------------------------------

test('createTtlCache: a non-positive or non-finite TTL does not store an immortal entry', () => {
  let clock = 1000;
  const cache = createTtlCache({ maxEntries: 10, now: () => clock });
  for (const ttl of [0, -1, NaN, Infinity, undefined, null]) {
    cache.clear();
    cache.set('k', 'v', ttl);
    assert.equal(cache.get('k'), undefined, `ttl=${String(ttl)} must not be cached`);
    assert.equal(cache.size, 0, `ttl=${String(ttl)} must not occupy the cache`);
  }
  cache.set('k', 'v', 50);
  assert.equal(cache.get('k'), 'v');
  clock += 51;
  assert.equal(cache.get('k'), undefined);
});

// ---- 17. the shared cache must actually be SHARED ------------------------------------------------------------
//
// `isIsolatingDeps` can be correct while the function that calls it is not. A mutant that forks a
// fresh client for ANY deps object — the shape the first cut shipped — leaves `isIsolatingDeps`
// untouched and every assertion about it passing, while each construction site quietly gets its
// own cache: the 5-minute bound becomes decorative and each lane re-reads the backend separately.
// So this asserts the OBSERVABLE consequence, on the client objects themselves.

test('getMerchantPurchasabilityClient: a logger-only dep returns the SHARED singleton', () => {
  resetMerchantPurchasabilityClientForTest();
  try {
    const { getMerchantPurchasabilityClient } = require('../src/services/merchantPurchasabilityClient');
    const a = getMerchantPurchasabilityClient();
    const b = getMerchantPurchasabilityClient({ logger: fakeLogger() });
    const c = getMerchantPurchasabilityClient({ logger: null });
    assert.equal(a, b, 'a logger must not fork a second cache');
    assert.equal(b, c, 'nor must an explicitly null one');
    assert.equal(a._cache, b._cache, 'and the cache object itself must be the same one');

    // Anything that changes the ANSWER forks, so a test can never write into the shared cache.
    const isolated = getMerchantPurchasabilityClient({ env: gateEnv() });
    assert.notEqual(isolated, a);
    assert.notEqual(isolated._cache, a._cache);
    assert.notEqual(getMerchantPurchasabilityClient({ fetchImpl: async () => ({}) }), a);
    assert.notEqual(getMerchantPurchasabilityClient({ now: () => 0 }), a);
  } finally {
    resetMerchantPurchasabilityClientForTest();
  }
});

test('the shared singleton really does serve one cache across construction sites', async () => {
  await withProdEnvironment(FACT_PURCHASE, async ({ calls }) => {
    const a = fakeMerchantClient();
    const b = fakeMerchantClient();
    // Two independently-constructed services, exactly as the two prod lanes build them.
    const one = createWarmHandoffService({ client: a.client, metrics: {}, logger: null });
    const two = createWarmHandoffService({ client: b.client, metrics: {}, logger: null });

    await one.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });
    await two.resolveWarmHandoff({ brandDomain: MERCHANT, variantGid: VARIANT, market: 'US' });

    assert.equal(calls.length, 1, 'the second lane must hit the FIRST lane cached fact, not re-read');
  });
});

// ---- THE QUIET-EVENT-LOOP GUARD ------------------------------------------------------------------------
//
// WHAT THIS CATCHES, AND WHY A NORMAL TEST CANNOT. Every await in this file is settled, on the
// hanging-backend paths, ONLY by the abort timer inside `fetchFact`. If that timer is ever
// `unref()`d, node drains the loop and EXITS with the promise still pending — and the failure does
// not look like a failing assertion. Under `node --test --test-isolation=process`, which is what CI
// runs, it is reported as `cancelledByParent` / "Promise resolution is still pending but the event
// loop has already resolved", and it cancels EVERY LATER TEST IN THE FILE (measured: `# fail 0,
// cancelled 46`). It passed locally because other handles happened to keep the loop alive — which
// is exactly why the guard has to run the case in a CHILD with nothing else on its loop.
//
// The same defect, with the same symptom, is already written down in
// `src/services/merchantVariantSource.js`. This is its second visit.

const { spawnSync } = require('node:child_process');
const nodePath = require('node:path');

function runOnAQuietLoop(source) {
  const result = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: nodePath.join(__dirname, '..'),
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

test('QUIET LOOP: a hanging read still settles when the abort timer is the ONLY thing on the loop', () => {
  const clientPath = JSON.stringify(nodePath.join(__dirname, '..', 'src', 'services', 'merchantPurchasabilityClient.js'));
  const out = runOnAQuietLoop(`
    const { createMerchantPurchasabilityClient } = require(${clientPath});
    const client = createMerchantPurchasabilityClient({
      env: { MERCHANT_PURCHASABILITY_GATE_ENABLED: '1', PIVOTA_API_BASE: 'https://b.example', PIVOTA_OPS_ADMIN_TOKEN: 't' },
      timeoutMs: 20,
      logger: { warn() {}, info() {}, error() {} },
      // Settles on the abort and on NOTHING else.
      fetchImpl: (url, options) => new Promise((_r, rej) => {
        options.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      }),
    });
    let settled = false;
    client.shouldOfferPurchase({ domain: 'flowerbeauty.com', market: 'US' })
      .then((d) => { settled = true; console.log('SETTLED:' + d.offer + ':' + d.source); });
    process.on('exit', () => { if (!settled) console.log('PENDING_AT_EXIT'); });
  `);
  assert.ok(!out.includes('PENDING_AT_EXIT'), `the loop drained with the read still pending — an unref'd timer:\n${out}`);
  assert.ok(out.includes('SETTLED:true:failed'), `expected a fail-open settlement, got:\n${out}`);
});
