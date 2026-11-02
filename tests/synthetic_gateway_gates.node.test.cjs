'use strict';

// THE GATEWAY-SIDE SYNTHETIC GATES (src/guardrails/syntheticContext.js): what a synthetic call (our own eval
// traffic, in enforce) does not do on this side. Each case runs the real function twice, once inside a synthetic
// invoke context and once inside a real one, so the gate is shown to change only the synthetic call.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');

const BACKEND = 'http://backend.synthetic-gates.test';
const SYN_SECRET = 'synthetic-assertion-secret-for-gate-tests';
const GATEWAY_KEY = 'gateway-service-key';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_API_KEY = GATEWAY_KEY;
process.env.PIVOTA_API_BASE = BACKEND;
process.env.UPSTREAM_RETRY_BASE_MS = '50';
process.env.UPSTREAM_RETRY_MAX_MS = '60';
delete process.env.DATABASE_URL;

const app = require('../src/server');
const ctx = require('../src/guardrails/syntheticContext');
const breaker = require('../src/findProductsMulti/llmModelBreaker');
const callers = require('../src/guardrails/syntheticCallers');
const loopback = require('../src/guardrails/loopbackCallerAssertion');

const D = app._debug;
const SYNTHETIC = { synthetic: true, synthetic_caller: 'https://as.pivota.test|mcpc_eval', gw_request_id: 'gw-req-1', api_key: GATEWAY_KEY };
const REAL = { synthetic: false, api_key: GATEWAY_KEY };

function inContext(store, fn) {
  return ctx.INVOKE_AUTH_CONTEXT.run(store, fn);
}

function withEnv(vars, fn) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

test('the server reads the one shared invoke context', () => {
  assert.equal(D.INVOKE_AUTH_CONTEXT, ctx.INVOKE_AUTH_CONTEXT);
  assert.equal(ctx.isSyntheticCall(), false, 'outside any request');
  assert.equal(inContext(SYNTHETIC, () => ctx.isSyntheticCall()), true);
  assert.equal(inContext(REAL, () => ctx.isSyntheticCall()), false);
  assert.equal(inContext({ synthetic: 'true' }, () => ctx.isSyntheticCall()), false, 'only the boolean true');
  assert.equal(inContext(SYNTHETIC, () => ctx.syntheticLiveReadsAllowed()), false);
  assert.equal(inContext(SYNTHETIC, () => ctx.sharedCacheWritesAllowed()), false);
  assert.equal(inContext(REAL, () => ctx.syntheticLiveReadsAllowed() && ctx.sharedCacheWritesAllowed()), true);
});

// ---- no live reads (decision A2) ---------------------------------------------------------------------------

test('search: a synthetic call makes no storefront read, a real one does', async () => {
  const fetched = [];
  D.useSearchOverlayFetchForTest(async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ product: { variants: [{ id: 41, price: '19.00' }] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  const page = () => ({
    status: 'success',
    products: [{ product_id: 'sig_1', price: 25, currency: 'USD', source_variant_id: '41', destination_url: 'https://shop.example.test/products/serum' }],
  });
  try {
    await withEnv({ SERVE_LIVE_MERCHANT_PRICE: 'on', UCP_LIVE_SEARCH_READ: undefined }, async () => {
      const syn = await inContext(SYNTHETIC, () => D.maybeOverlayLiveSearchPrice(page(), { query: 'serum' }, { buyerMarket: 'US' }));
      assert.deepEqual(fetched, []);
      assert.deepEqual(syn, page(), 'the stored answer, unchanged');
      await inContext(REAL, () => D.maybeOverlayLiveSearchPrice(page(), { query: 'serum' }, { buyerMarket: 'US' }));
      assert.ok(fetched.length >= 1 && fetched[0].includes('/products/serum.json'), 'the real call reads the storefront');
    });
  } finally {
    D.useSearchOverlayFetchForTest(null);
  }
});

test('get_product and get_offers: no live reader, no seed opt-in, no live cart for a synthetic call', async () => {
  await withEnv({ UCP_LIVE_OFFER_READ: undefined, UCP_LIVE_PRODUCT_READ: undefined, GET_OFFERS_LIVE_CART: 'on' }, async () => {
    // Off flags: a real call has no reader either, so the gate is shown on the cart mode and the opt-in below.
    assert.equal(await inContext(SYNTHETIC, () => D.liveProductRead({ product: {} }, {})), null);
    assert.equal(await inContext(SYNTHETIC, () => D.readOffersLive([{ offer_id: 'o1' }], {})), null);
    assert.equal(inContext(SYNTHETIC, () => D.getOffersLiveCartMode()), 'off');
    assert.equal(inContext(REAL, () => D.getOffersLiveCartMode()), 'on');
    assert.equal(inContext(SYNTHETIC, () => D.liveOfferVerificationOptIn()), false);
  });
  await withEnv({ UCP_LIVE_OFFER_READ: 'enforce', UCP_LIVE_PRODUCT_READ: 'shadow' }, async () => {
    assert.equal(inContext(REAL, () => D.liveOfferVerificationOptIn()), true, 'an enforcing reader opts in for a real call');
    assert.equal(inContext(SYNTHETIC, () => D.liveOfferVerificationOptIn()), false);
    assert.equal(await inContext(SYNTHETIC, () => D.readOffersLive([{ offer_id: 'o1' }], {})), null);
    assert.equal(await inContext(SYNTHETIC, () => D.liveProductRead({ product: {} }, {})), null);
  });
});

test('merchant variant sourcing is off for a synthetic call, on its flag for a real one', () => {
  withEnv({ MERCHANT_VARIANT_SOURCING_ENABLED: '1' }, () => {
    assert.equal(inContext(REAL, () => D.merchantVariantSourcingLive()), true);
    assert.equal(inContext(SYNTHETIC, () => D.merchantVariantSourcingLive()), false);
  });
  withEnv({ MERCHANT_VARIANT_SOURCING_ENABLED: undefined }, () => {
    assert.equal(inContext(REAL, () => D.merchantVariantSourcingLive()), false);
  });
});

test('get_pdp_v2: no background live read and no live-refresh token for a synthetic call', () => {
  // The shadow read returns before it looks for a reader: false whatever the flags.
  const payload = { product: { product_id: 'p1' } };
  assert.equal(inContext(SYNTHETIC, () => D.shadowPdpLiveRead(payload, { market: 'US', random: () => 0 })), false);
  const page = { product: { product_id: 'p1' }, modules: [] };
  assert.equal(inContext(SYNTHETIC, () => D.withPdpLiveRefreshDescriptor(page, { optedIn: true, market: 'US' })), page);
});

// ---- §D shared caches ----------------------------------------------------------------------------------------

test('the product detail and product group caches are read-through for a synthetic call', () => {
  const key = `syn-gates-${Date.now()}`;
  inContext(SYNTHETIC, () => {
    D.setProductDetailCache(key, { product: { id: 'from-synthetic' } });
    D.setResolveProductGroupCache(key, { group: 'from-synthetic' });
  });
  assert.equal(D.getProductDetailCacheEntry(key), null, 'a synthetic call stores no product detail');
  assert.equal(D.getResolveProductGroupCacheEntry(key), null, 'a synthetic call stores no product group');
  inContext(REAL, () => {
    D.setProductDetailCache(key, { product: { id: 'from-real' } });
    D.setResolveProductGroupCache(key, { group: 'from-real' });
  });
  // A synthetic call still reads what a real one stored.
  assert.equal(inContext(SYNTHETIC, () => D.getProductDetailCacheEntry(key))?.value?.product?.id, 'from-real');
  assert.equal(inContext(SYNTHETIC, () => D.getResolveProductGroupCacheEntry(key))?.value?.group, 'from-real');
});

// ---- P3-a: every upstream attempt carries a fresh assertion -------------------------------------------------

test('a retried upstream call re-signs the synthetic assertion on every attempt', async () => {
  const seen = [];
  nock(BACKEND)
    .post('/agent/shop/v1/invoke')
    .reply(function reply() {
      seen.push(this.req.headers[callers.SYNTHETIC_ASSERTION_HEADER.toLowerCase()]);
      return [503, { error: { message: 'TEMPORARY_UNAVAILABLE' } }];
    })
    .post('/agent/shop/v1/invoke')
    .reply(function reply() {
      seen.push(this.req.headers[callers.SYNTHETIC_ASSERTION_HEADER.toLowerCase()]);
      return [200, { status: 'success', products: [] }];
    });
  try {
    await withEnv({ SYNTHETIC_ASSERTION_SECRET: SYN_SECRET }, () => inContext(SYNTHETIC, async () => {
      const headers = callers.withSyntheticAssertion({ 'X-API-Key': GATEWAY_KEY, 'Content-Type': 'application/json' }, SYNTHETIC);
      const res = await D.callUpstreamWithOptionalRetry('find_products', {
        method: 'POST', url: `${BACKEND}/agent/shop/v1/invoke`, headers, data: { operation: 'find_products', payload: {} }, timeout: 5000,
      });
      assert.equal(res.status, 200);
    }));
  } finally {
    nock.cleanAll();
  }
  assert.equal(seen.length, 2);
  assert.ok(seen.every((h) => typeof h === 'string' && h.startsWith('v1.')));
  assert.notEqual(seen[0], seen[1], 'the retry sent a freshly signed assertion, not the first attempt\'s');
});

test('withFreshSyntheticAssertion leaves a config with no assertion, or no synthetic context, unchanged', () => {
  withEnv({ SYNTHETIC_ASSERTION_SECRET: SYN_SECRET }, () => {
    const plain = { url: `${BACKEND}/x`, headers: { 'X-API-Key': GATEWAY_KEY } };
    assert.equal(inContext(SYNTHETIC, () => D.withFreshSyntheticAssertion(plain)), plain);
    const signed = { url: `${BACKEND}/x`, headers: callers.withSyntheticAssertion({ 'X-API-Key': GATEWAY_KEY }, SYNTHETIC) };
    assert.equal(inContext(REAL, () => D.withFreshSyntheticAssertion(signed)), signed, 'nothing to re-sign it with');
    const fresh = inContext(SYNTHETIC, () => D.withFreshSyntheticAssertion(signed));
    assert.notEqual(fresh.headers[callers.SYNTHETIC_ASSERTION_HEADER], signed.headers[callers.SYNTHETIC_ASSERTION_HEADER]);
    assert.equal(fresh.headers['X-API-Key'], GATEWAY_KEY);
  });
});

// ---- G6: LLM cap and the shared model breaker ----------------------------------------------------------------

test('the synthetic LLM slot: none for a real call, one in flight, an hourly budget', () => {
  ctx.__resetSyntheticLlmStateForTests();
  let now = 1_000_000;
  ctx.__setClockForTests(() => now);
  try {
    assert.equal(inContext(REAL, () => ctx.acquireSyntheticLlmSlot()), null);
    const release = inContext(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot({ env: { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '2' } }));
    assert.equal(typeof release, 'function');
    assert.equal(inContext(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot({ env: { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '2' } })), false, 'one in flight');
    release();
    release(); // idempotent
    const second = inContext(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot({ env: { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '2' } }));
    assert.equal(typeof second, 'function');
    second();
    assert.equal(inContext(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot({ env: { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '2' } })), false, 'budget spent');
    now += 60 * 60 * 1000;
    const nextHour = inContext(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot({ env: { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '2' } }));
    assert.equal(typeof nextHour, 'function', 'a new hour, a new budget');
    nextHour();
    assert.equal(inContext(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot({ env: { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '0' } })), false);
  } finally {
    ctx.__setClockForTests(null);
    ctx.__resetSyntheticLlmStateForTests();
  }
});

test('a synthetic call reads the model breaker but never moves it', () => {
  const notFound = Object.assign(new Error('model not found'), { status: 404, code: 'model_not_found' });
  breaker.__resetModelBreakersForTests();
  try {
    // A synthetic failure does not open it.
    inContext(SYNTHETIC, () => breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: notFound }));
    assert.equal(breaker.isModelBreakerOpen('rerank', 'openai', 'm'), false);
    assert.equal(inContext(SYNTHETIC, () => breaker.acquireModelCall('rerank', 'openai', 'm')), true, 'closed: it may call');

    // A real failure opens it; a synthetic call respects that, and its success does not close it.
    inContext(REAL, () => breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: notFound }));
    assert.equal(breaker.isModelBreakerOpen('rerank', 'openai', 'm'), true);
    assert.equal(inContext(SYNTHETIC, () => breaker.acquireModelCall('rerank', 'openai', 'm')), false);
    inContext(SYNTHETIC, () => breaker.recordModelSuccess('rerank', 'openai', 'm'));
    assert.equal(breaker.isModelBreakerOpen('rerank', 'openai', 'm'), true);

    // Half-open (cooldown passed): a synthetic call is never the probe; a real one is.
    const later = Date.now() + 31 * 60 * 1000;
    breaker.__setClockForTests(() => later);
    assert.equal(breaker.isModelBreakerOpen('rerank', 'openai', 'm'), false);
    assert.equal(inContext(SYNTHETIC, () => breaker.acquireModelCall('rerank', 'openai', 'm')), false);
    assert.equal(inContext(REAL, () => breaker.acquireModelCall('rerank', 'openai', 'm')), true);
  } finally {
    breaker.__setClockForTests(() => Date.now());
    breaker.__resetModelBreakersForTests();
  }
});

// ---- P3-d robustness ---------------------------------------------------------------------------------------

test('the loopback synthetic marker has its own key and version, and carries a caller of any valid length', () => {
  const secret = Buffer.alloc(32, 7);
  const longCaller = `https://as.pivota.test/${'i'.repeat(480)}|mcpc_${'c'.repeat(500)}`;
  const req = (value) => ({
    headers: { [loopback.LOOPBACK_SYNTHETIC_HEADER.toLowerCase()]: value },
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
  });
  const marker = loopback.signLoopbackSynthetic({ caller: longCaller, requestId: 'gw-1' }, { secret });
  assert.ok(marker.length > 1024, 'longer than the caller assertion allows');
  assert.ok(marker.startsWith('sv1.'));
  assert.deepEqual(loopback.verifyLoopbackSynthetic(req(marker), { secret }), { synthetic_caller: longCaller, gw_request_id: 'gw-1' });
  // A caller assertion signed with the same process secret never verifies as a synthetic marker.
  const callerToken = loopback.signLoopbackCaller({ tier: 'partner', key: 'k', agentId: 'a', callId: 'c' }, { secret });
  assert.equal(loopback.verifyLoopbackSynthetic(req(callerToken), { secret }), null);
  // Nor does a marker re-labelled with the caller assertion's version.
  assert.equal(loopback.verifyLoopbackSynthetic(req(marker.replace(/^sv1\./, 'v1.')), { secret }), null);
});

test('the loopback carrier is active only on this host AND, when PORT is set, on this port', () => {
  assert.equal(loopback.loopbackAssertionStatus('http://127.0.0.1:8080').active, true);
  assert.equal(loopback.loopbackAssertionStatus('http://127.0.0.1:8080', { expectedPort: '8080' }).active, true);
  assert.equal(loopback.loopbackAssertionStatus('http://127.0.0.1:9090', { expectedPort: '8080' }).active, false);
  assert.equal(loopback.loopbackAssertionStatus('http://localhost', { expectedPort: '80' }).active, true);
  assert.equal(loopback.loopbackAssertionStatus('http://10.0.0.5:8080', { expectedPort: '8080' }).active, false);
  assert.equal(loopback.loopbackAssertionStatus('http://127.0.0.1:9090', { expectedPort: undefined }).active, true);
});

test('a caller entry longer than the backend accepts is invalid, so the boot refuses it', () => {
  const env = {
    SYNTHETIC_CALLERS_JSON: JSON.stringify([{ iss: 'https://as.pivota.test', client_id: `mcpc_${'x'.repeat(600)}` }]),
  };
  const { entries } = callers.parseSyntheticCallers(env, { ownIssuers: ['https://as.pivota.test'] });
  assert.equal(entries[0].valid, false);
  assert.equal(entries[0].reason, 'value_too_long');
  assert.equal(callers.syntheticConfigStatus(env, { ownIssuers: ['https://as.pivota.test'] }).ok, false);
});

test('an internal error while classifying fails closed for a listed client only', () => {
  const env = {
    SYNTHETIC_CALLERS_JSON: JSON.stringify([{ iss: 'https://as.pivota.test', client_id: 'mcpc_eval' }]),
    SYNTHETIC_TRAFFIC_MODE: 'enforce',
  };
  const exploding = (clientId) => ({
    get iss() { throw new Error('boom'); },
    client_id: clientId,
  });
  assert.deepEqual(
    callers.classifySyntheticCaller(exploding('mcpc_eval'), { env, ownIssuers: ['https://as.pivota.test'] }),
    { listed: true, valid: false, reason: 'classify_error' },
  );
  assert.equal(callers.classifySyntheticCaller(exploding('mcpc_partner'), { env, ownIssuers: ['https://as.pivota.test'] }), null);
  // A client id that merely contains the listed one is not matched.
  assert.equal(callers.classifySyntheticCaller(exploding('mcpc_eva'), { env, ownIssuers: ['https://as.pivota.test'] }), null);
});

test('a synthetic product-detail read never leads the in-flight join; a real one does, and a synthetic one may join it', async () => {
  let upstreamCalls = 0;
  const scope = nock(BACKEND)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => body?.operation === 'get_product_detail')
    .delay(150)
    .reply(() => {
      upstreamCalls += 1;
      return [200, { product: { product_id: 'p_join', merchant_id: 'merch_join', title: `t${upstreamCalls}`, price: 10, currency: 'USD' } }];
    });
  const read = (merchantId) => D.fetchProductDetailForOffers({ merchantId, productId: 'p_join', bypassCache: false });
  try {
    // Synthetic first: the real call that follows must make its own read, not join it.
    const synFirst = [inContext(SYNTHETIC, () => read('merch_join_a')), inContext(REAL, () => read('merch_join_a'))];
    await Promise.all(synFirst);
    assert.equal(upstreamCalls, 2, 'the real call did not join the synthetic one');

    // Real first: the synthetic call joins it (one read).
    upstreamCalls = 0;
    await Promise.all([inContext(REAL, () => read('merch_join_b')), inContext(SYNTHETIC, () => read('merch_join_b'))]);
    assert.equal(upstreamCalls, 1, 'the synthetic call joined the real leader');
  } finally {
    scope.persist(false);
    nock.cleanAll();
  }
});

test('the PDP identity cache is read-through for a synthetic call, and it never leads that join', async () => {
  const pdp = require('../src/services/pdpIdentityGraph').__liveSyntheticPdpForTests;
  const key = `merch_x::p_${Date.now()}`;
  inContext(SYNTHETIC, () => pdp.write(key, { product: { id: 'syn' } }));
  assert.equal(pdp.read(key), undefined, 'a synthetic call stores nothing, a negative entry included');
  inContext(SYNTHETIC, () => pdp.write(`${key}:neg`, null));
  assert.equal(pdp.read(`${key}:neg`), undefined);
  inContext(REAL, () => pdp.write(key, { product: { id: 'real' } }));
  assert.equal(inContext(SYNTHETIC, () => pdp.read(key))?.product?.id, 'real', 'it reads what a real call stored');

  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const syn = inContext(SYNTHETIC, () => pdp.lead(`${key}:join`, pending));
  assert.equal(pdp.inflight(`${key}:join`), undefined, 'a synthetic read is not registered for others to join');
  const real = inContext(REAL, () => pdp.lead(`${key}:join2`, pending));
  assert.equal(pdp.inflight(`${key}:join2`), pending, 'a real read is');
  settle({ product: { id: 'x' } });
  await Promise.all([syn, real]);
  assert.equal(pdp.inflight(`${key}:join2`), undefined, 'evicted once settled');
});

test('the shop currency: no Shopify Admin lookup and no cache entry for a synthetic call', async () => {
  const warns = [];
  const logger = require('../src/logger');
  const realWarn = logger.warn.bind(logger);
  logger.warn = (obj, msg, ...rest) => {
    warns.push(String(msg || ''));
    return realWarn(obj, msg, ...rest);
  };
  try {
    inContext(SYNTHETIC, () => D.setCachedShopifyMerchantCurrency('merch_ccy_syn', 'EUR'));
    assert.equal(D.getCachedShopifyMerchantCurrency('merch_ccy_syn'), null, 'a synthetic call stores no currency');
    inContext(REAL, () => D.setCachedShopifyMerchantCurrency('merch_ccy_real', 'EUR'));
    assert.equal(inContext(SYNTHETIC, () => D.getCachedShopifyMerchantCurrency('merch_ccy_real')), 'EUR', 'it reads a real entry');
    assert.equal(await inContext(SYNTHETIC, () => D.fetchShopifyMerchantCurrency('merch_ccy_real')), 'EUR');

    // With a database configured, a real miss goes to merchant_stores (here: unreachable, so it logs and gives up);
    // a synthetic miss never gets that far.
    await withEnv({ DATABASE_URL: 'postgres://nobody:none@127.0.0.1:1/none' }, async () => {
      assert.equal(await inContext(SYNTHETIC, () => D.fetchShopifyMerchantCurrency('merch_ccy_miss')), null);
      assert.deepEqual(warns.filter((m) => m.includes('Shopify currency')), []);
      assert.equal(await inContext(REAL, () => D.fetchShopifyMerchantCurrency('merch_ccy_miss')), null);
      assert.ok(warns.some((m) => m.includes('Shopify currency')), 'the real miss looked the store up');
    });
  } finally {
    logger.warn = realWarn;
  }
});

test('an unset or blank LLM budget is the default, not zero', () => {
  ctx.__resetSyntheticLlmStateForTests();
  try {
    for (const env of [{}, { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '' }, { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: '  ' }, { SYNTHETIC_LLM_MAX_CALLS_PER_HOUR: 'many' }]) {
      const release = inContext(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot({ env }));
      assert.equal(typeof release, 'function', JSON.stringify(env));
      release();
    }
  } finally {
    ctx.__resetSyntheticLlmStateForTests();
  }
});

test('with the live readers built, a real call uses them and a synthetic one does not (server, own process)', () => {
  // A fresh process: the readers and the merchant variant source are built once per process from the flags.
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const ucpClientModule = path.join(__dirname, '..', 'src', 'services', 'ucpBuyerAgentClient.js');
  const code = `
    const contacted = [];
    // The merchant variant source's client, recorded: it must never be dialled for a synthetic call.
    require(${JSON.stringify(ucpClientModule)}).createUcpBuyerAgentClient = () => ({
      async discoverEndpoint(url) { contacted.push(url); return { mcpEndpoint: 'https://shop.example.test/api/mcp' }; },
      async searchCatalog() { return { products: [] }; },
    });
    const app = require(${JSON.stringify(server)});
    const D = app._debug;
    D.useUcpLiveClientForTest({
      async discoverEndpoint() { throw new Error('no store may be contacted in this test'); },
      async lookupCatalog() { throw new Error('no store may be contacted in this test'); },
    });
    const SYN = { synthetic: true, synthetic_caller: 'iss|mcpc_eval', gw_request_id: 'gw-1' };
    const REAL = { synthetic: false };
    const run = (store, fn) => D.INVOKE_AUTH_CONTEXT.run(store, fn);
    const product = { product: { product_id: 'p1', merchant_id: 'm1', destination_url: 'https://shop.example.test/products/serum',
      variants: [{ variant_id: '41', price: { current: { amount: 20, currency: 'USD' } } }] } };
    // A page with no merchant host: the shadow read is taken (true) and skips before any network call.
    const page = { modules: [{ type: 'canonical', data: { pdp_payload: { product: {
      product_id: 'sig_x', price: { current: { amount: 24, currency: 'USD' } }, variants: [{ variant_id: '41' }] } } } }] };
    (async () => {
      const out = {
        product_real: run(REAL, () => D.liveProductRead(product, { market: 'US' })) !== null,
        product_syn: run(SYN, () => D.liveProductRead(product, { market: 'US' })) !== null,
        offers_real: run(REAL, () => D.readOffersLive([{ offer_id: 'o1', merchant_id: 'm1' }], { market: 'US' })) !== null,
        offers_syn: run(SYN, () => D.readOffersLive([{ offer_id: 'o1', merchant_id: 'm1' }], { market: 'US' })) !== null,
        pdp_real: run(REAL, () => D.shadowPdpLiveRead(page, { market: 'US', random: () => 0 })),
        pdp_syn: run(SYN, () => D.shadowPdpLiveRead(page, { market: 'US', random: () => 0 })),
      };
      const source = D.buildMerchantVariantSource(null);
      const read = { product: { product_id: 'p1', destination_url: 'https://shop.example.test/products/serum', title: 'Serum' } };
      await run(SYN, () => source.details(read, 'p1'));
      out.sourcing_syn = contacted.length;
      await run(REAL, () => source.details(read, 'p1'));
      out.sourcing_real = contacted.length;
      console.log('RESULT ' + JSON.stringify(out));
      setTimeout(() => process.exit(0), 50);
    })().catch((e) => { console.error(e); process.exit(1); });`;
  const env = { ...process.env, NODE_ENV: 'test', UCP_LIVE_PRODUCT_READ: 'shadow', UCP_LIVE_OFFER_READ: 'shadow', UCP_LIVE_PDP_READ: 'shadow',
    MERCHANT_VARIANT_SOURCING_ENABLED: '1', MERCHANT_VARIANT_SOURCING_BRANDS: 'shop.example.test' };
  for (const k of ['UCP_LIVE_PDP_READ_SAMPLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'DATABASE_URL']) delete env[k];
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
  assert.deepEqual(out, {
    product_real: true, product_syn: false,
    offers_real: true, offers_syn: false,
    pdp_real: true, pdp_syn: false,
    sourcing_syn: 0, sourcing_real: 1,
  });
});

test('a marker signed with the raw process secret (no derived key) is refused', () => {
  const crypto = require('crypto');
  const secret = Buffer.alloc(32, 9);
  const payload = Buffer.from(JSON.stringify({ s: 1, c: 'iss|mcpc_eval', r: 'gw-1', ts: Math.floor(Date.now() / 1000) })).toString('base64url');
  const input = `sv1.${payload}`;
  const raw = `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
  const req = { headers: { [loopback.LOOPBACK_SYNTHETIC_HEADER.toLowerCase()]: raw }, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' };
  assert.equal(loopback.verifyLoopbackSynthetic(req, { secret }), null);
  const good = loopback.signLoopbackSynthetic({ caller: 'iss|mcpc_eval', requestId: 'gw-1' }, { secret });
  req.headers[loopback.LOOPBACK_SYNTHETIC_HEADER.toLowerCase()] = good;
  assert.deepEqual(loopback.verifyLoopbackSynthetic(req, { secret }), { synthetic_caller: 'iss|mcpc_eval', gw_request_id: 'gw-1' });
});

test('a retry re-signs the loopback marker too, and the fresh one verifies on this process', () => {
  const H = loopback.LOOPBACK_SYNTHETIC_HEADER;
  const first = loopback.loopbackSyntheticHeaders(SYNTHETIC, { nowSec: Math.floor(Date.now() / 1000) - 3600 })[H];
  const config = { url: 'http://127.0.0.1:8080/agent/shop/v1/invoke', headers: { 'X-API-Key': GATEWAY_KEY, [H]: first } };
  const req = (value) => ({ headers: { [H.toLowerCase()]: value }, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' });
  assert.equal(loopback.verifyLoopbackSynthetic(req(first)), null, 'an hour old: past the window');
  const fresh = inContext(SYNTHETIC, () => D.withFreshSyntheticAssertion(config));
  assert.notEqual(fresh.headers[H], first);
  assert.deepEqual(loopback.verifyLoopbackSynthetic(req(fresh.headers[H])), { synthetic_caller: SYNTHETIC.synthetic_caller, gw_request_id: SYNTHETIC.gw_request_id });
  assert.equal(inContext(REAL, () => D.withFreshSyntheticAssertion(config)), config, 'nothing to re-sign it with');
});

test('an entry that is not plain ASCII, or carries the caller separator, is invalid and refuses the boot', () => {
  for (const clientId of ['mcpc_éval', 'mcpc|eval', 'mcpc eval', 'mcpc\teval']) {
    const env = { SYNTHETIC_CALLERS_JSON: JSON.stringify([{ iss: 'https://as.pivota.test', client_id: clientId }]) };
    const { entries } = callers.parseSyntheticCallers(env, { ownIssuers: ['https://as.pivota.test'] });
    assert.equal(entries[0].reason, 'value_not_plain_ascii', JSON.stringify(clientId));
    assert.equal(callers.syntheticConfigStatus(env, { ownIssuers: ['https://as.pivota.test'] }).ok, false);
  }
});

test('the fail-closed match names a listed client_id only, never a key name or the issuer', () => {
  const env = {
    SYNTHETIC_CALLERS_JSON: JSON.stringify([{ iss: 'https://as.pivota.test', client_id: 'mcpc_eval' }]),
    SYNTHETIC_TRAFFIC_MODE: 'enforce',
  };
  const exploding = (clientId) => ({ get iss() { throw new Error('boom'); }, client_id: clientId });
  for (const id of ['iss', 'client_id', 'https://as.pivota.test', 'mcpc_eval2']) {
    assert.equal(callers.classifySyntheticCaller(exploding(id), { env, ownIssuers: ['https://as.pivota.test'] }), null, id);
  }
  assert.equal(callers.classifySyntheticCaller(exploding('mcpc_eval'), { env, ownIssuers: ['https://as.pivota.test'] }).reason, 'classify_error');
});

test('a rerank over the synthetic cap is a skip, not a logged failure', () => {
  assert.deepEqual(D.llmRerankFailureOutcome(new Error('rerank_llm_failed: synthetic_llm_cap')), { applied: false, skipped_reason: 'llm_synthetic_cap' });
  assert.deepEqual(D.llmRerankFailureOutcome(new Error('rerank_llm_failed: deadline 1800ms exceeded')), { applied: false, error: true });
  assert.deepEqual(D.llmRerankFailureOutcome(null), { applied: false, error: true });
});
