'use strict';

// Unit tests for the INTERNAL warm-handoff click-lane resolve handler
// (src/services/ucpWarmHandoffInternalRoute.js — Phase 1 of
// Pivota_Warm_Handoff_Click_Lane_Spec_2026-07-22.md). Pure handler tests with injected
// deps: no network, no express, no real warm-handoff service.

const {
  createUcpWarmHandoffInternalHandler,
  ROUTE_FLAG_ENV,
  INTERNAL_KEY_ENV,
  REQUIRE_AVAILABLE_ENV,
} = require('../src/services/ucpWarmHandoffInternalRoute');

const KEY = 'test-internal-key-1';

function envOn(overrides = {}) {
  return {
    UCP_WARM_HANDOFF_ENABLED: '1',
    [ROUTE_FLAG_ENV]: '1',
    [INTERNAL_KEY_ENV]: KEY,
    ...overrides,
  };
}

function makeHandler({ env = envOn(), service, fetchImpl, metrics } = {}) {
  return createUcpWarmHandoffInternalHandler({ env, service, fetchImpl, ...(metrics ? { metrics } : {}) });
}

function authedRequest(body, headers = {}) {
  return { headers: { 'x-internal-key': KEY, ...headers }, body };
}

const COSRX_GID = 'gid://shopify/ProductVariant/51895645012184';

describe('ucpWarmHandoffInternalRoute — fail-closed mounting', () => {
  test('404 when the route flag is off', async () => {
    const handler = makeHandler({ env: envOn({ [ROUTE_FLAG_ENV]: '0' }) });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', variant_gid: COSRX_GID }));
    expect(out.status).toBe(404);
  });

  test('404 when the master warm-handoff flag is off (route flag alone is not enough)', async () => {
    const handler = makeHandler({ env: envOn({ UCP_WARM_HANDOFF_ENABLED: '0' }) });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', variant_gid: COSRX_GID }));
    expect(out.status).toBe(404);
  });

  test('404 when the internal key is unconfigured — unset key can never mean open', async () => {
    const handler = makeHandler({ env: envOn({ [INTERNAL_KEY_ENV]: '' }) });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', variant_gid: COSRX_GID }));
    expect(out.status).toBe(404);
  });

  test('401 on a wrong key', async () => {
    const handler = makeHandler();
    const out = await handler({
      headers: { 'x-internal-key': 'wrong' },
      body: { brand_domain: 'cosrx.com', variant_gid: COSRX_GID },
    });
    expect(out.status).toBe(401);
  });

  test('401 on a missing key header', async () => {
    const handler = makeHandler();
    const out = await handler({ headers: {}, body: { brand_domain: 'cosrx.com' } });
    expect(out.status).toBe(401);
  });
});

describe('ucpWarmHandoffInternalRoute — validation', () => {
  test('400 when brand_domain is missing', async () => {
    const service = { resolveWarmHandoff: jest.fn() };
    const handler = makeHandler({ service });
    const out = await handler(authedRequest({ variant_gid: COSRX_GID }));
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('brand_domain_required');
    expect(service.resolveWarmHandoff).not.toHaveBeenCalled();
  });

  test('variant_unresolved (200, null) when nothing resolves a variant — service never called', async () => {
    const service = { resolveWarmHandoff: jest.fn() };
    const handler = makeHandler({ service });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com' }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ continue_url: null, reason: 'variant_unresolved' });
    expect(service.resolveWarmHandoff).not.toHaveBeenCalled();
  });
});

describe('ucpWarmHandoffInternalRoute — resolution', () => {
  test('direct variant_gid resolves through the service to a continue_url', async () => {
    const service = {
      resolveWarmHandoff: jest.fn().mockResolvedValue({
        continue_url: 'https://cosrx-renewal.myshopify.com/cart/c/abc?key=k',
        cart_id: 'gid://shopify/Cart/abc',
      }),
    };
    const handler = makeHandler({ service });
    const out = await handler(
      authedRequest({ brand_domain: 'cosrx.com', variant_gid: COSRX_GID, quantity: 2 }),
    );
    expect(out.status).toBe(200);
    expect(out.body.continue_url).toBe('https://cosrx-renewal.myshopify.com/cart/c/abc?key=k');
    expect(out.body.cart_id).toBe('gid://shopify/Cart/abc');
    expect(out.body.variant_gid).toBe(COSRX_GID);
    expect(service.resolveWarmHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ brandDomain: 'cosrx.com', variantGid: COSRX_GID, quantity: 2 }),
    );
  });

  test('bare numeric variant_id is wrapped into a GID', async () => {
    const service = {
      resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x.myshopify.com/cart/c/1?key=k' }),
    };
    const handler = makeHandler({ service });
    const out = await handler(
      authedRequest({ brand_domain: 'cosrx.com', variant_id: '51895645012184' }),
    );
    expect(out.status).toBe(200);
    expect(service.resolveWarmHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ variantGid: COSRX_GID }),
    );
  });

  test('attribution passes through to the service verbatim', async () => {
    const service = {
      resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x.myshopify.com/cart/c/1?key=k' }),
    };
    const handler = makeHandler({ service });
    await handler(
      authedRequest({
        brand_domain: 'cosrx.com',
        variant_gid: COSRX_GID,
        attribution: { pivota_click_id: 'clk_1' },
      }),
    );
    expect(service.resolveWarmHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: { pivota_click_id: 'clk_1' } }),
    );
  });

  test('service fallback (null) returns 200 continue_url:null — never a 5xx on the click path', async () => {
    const service = { resolveWarmHandoff: jest.fn().mockResolvedValue(null) };
    const handler = makeHandler({ service });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', variant_gid: COSRX_GID }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ continue_url: null, reason: 'fallback' });
  });

  test('a throwing service still resolves to 200 continue_url:null', async () => {
    const service = { resolveWarmHandoff: jest.fn().mockRejectedValue(new Error('boom')) };
    const handler = makeHandler({ service });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', variant_gid: COSRX_GID }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ continue_url: null, reason: 'fallback' });
  });
});

describe('ucpWarmHandoffInternalRoute — products.json variant fallback + memo', () => {
  const PRODUCT_NODE = {
    handle: 'peptide-132-hair-home-care-kit',
    title: 'Peptide-132 Hair Home Care Kit',
    variants: [{ id: 51895645012184, available: true }],
  };

  // URL-aware fixture matching Shopify's real shapes, MEASURED 2026-08-25 on all six warm-handoff
  // brands. The three public surfaces do NOT agree, and the differences are load-bearing here:
  //   /products/<handle>.js    -> the product object DIRECTLY, variants carry `available`
  //   /products/<handle>.json  -> { product: {...} }, variants OMIT `available` entirely
  //   /products.json           -> { products: [...] }, variants carry `available`
  // The resolver's fast path asks `.js` first precisely because it is the only per-handle surface
  // that can answer the stock question. Do not "simplify" this fixture by giving `.json` an
  // `available` field it never sends — that is what let an inert preference ship green.
  function fetchImplReturningProducts() {
    const stripAvailable = (node) => ({
      ...node,
      variants: node.variants.map(({ available, ...rest }) => rest),
    });
    return jest.fn().mockImplementation(async (url) => {
      const u = String(url);
      const body = u.includes(`/products/${PRODUCT_NODE.handle}.js`)
        ? PRODUCT_NODE
        : (u.includes(`/products/${PRODUCT_NODE.handle}.json`)
          ? { product: stripAvailable(PRODUCT_NODE) }
          : { products: [PRODUCT_NODE] });
      return { ok: true, status: 200, json: async () => body };
    });
  }

  test('product_handle resolves via products.json; second call hits the memo (single fetch)', async () => {
    const service = {
      resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x.myshopify.com/cart/c/1?key=k' }),
    };
    const fetchImpl = fetchImplReturningProducts();
    const handler = makeHandler({ service, fetchImpl });
    const body = { brand_domain: 'cosrx.com', product_handle: 'peptide-132-hair-home-care-kit' };

    const first = await handler(authedRequest(body));
    expect(first.status).toBe(200);
    expect(first.body.variant_gid).toBe(COSRX_GID);

    const second = await handler(authedRequest(body));
    expect(second.status).toBe(200);
    expect(second.body.variant_gid).toBe(COSRX_GID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('product_url handle extraction feeds the same fallback', async () => {
    const service = {
      resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x.myshopify.com/cart/c/1?key=k' }),
    };
    const fetchImpl = fetchImplReturningProducts();
    const handler = makeHandler({ service, fetchImpl });
    const out = await handler(
      authedRequest({
        brand_domain: 'cosrx.com',
        product_url: 'https://www.cosrx.com/products/peptide-132-hair-home-care-kit?utm=x',
      }),
    );
    expect(out.status).toBe(200);
    expect(out.body.variant_gid).toBe(COSRX_GID);
  });

  test('a failing products.json fetch degrades to variant_unresolved (service never called)', async () => {
    const service = { resolveWarmHandoff: jest.fn() };
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'));
    const handler = makeHandler({ service, fetchImpl });
    const out = await handler(
      authedRequest({ brand_domain: 'unreachable-brand.example', product_handle: 'anything' }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ continue_url: null, reason: 'variant_unresolved' });
    expect(service.resolveWarmHandoff).not.toHaveBeenCalled();
  });
});

/*
 * OUT-OF-STOCK DECLINE. The lane would rather cold-redirect to a PDP that honestly says "sold out"
 * than hand the shopper a cart that dies at checkout. MEASURED 2026-08-25: 123/968 products across
 * the six warm-handoff brands lead with an out-of-stock variants[0], and 115 of those are fully sold
 * out — no variant choice rescues them, so declining is the only honest outcome.
 */
describe('ucpWarmHandoffInternalRoute — requireAvailable (out-of-stock decline)', () => {
  const SOLD_OUT_HANDLE = 'all-gone-kit';
  const LIVE_GID = 'gid://shopify/ProductVariant/51895645012184';

  // `.js` is the surface that carries stock; the resolver asks it first.
  function fetchSoldOut() {
    return jest.fn().mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes(`/products/${SOLD_OUT_HANDLE}.js`)
        ? { handle: SOLD_OUT_HANDLE, variants: [{ id: 51895645012184, available: false }] }
        : { products: [{ handle: SOLD_OUT_HANDLE, variants: [{ id: 51895645012184, available: false }] }] }),
    }));
  }

  // A storefront that publishes no stock at all — `available` absent everywhere.
  function fetchStockSilent() {
    return jest.fn().mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes(`/products/${SOLD_OUT_HANDLE}.json`)
        ? { product: { handle: SOLD_OUT_HANDLE, variants: [{ id: 51895645012184, sku: 'X' }] } }
        : { products: [{ handle: SOLD_OUT_HANDLE, variants: [{ id: 51895645012184, sku: 'X' }] }] }),
    }));
  }

  const service = () => ({
    resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x.myshopify.com/cart/c/1?key=k' }),
  });

  test('declines a sold-out product with a DISTINCT reason, and never builds a cart', async () => {
    const svc = service();
    const handler = makeHandler({ service: svc, fetchImpl: fetchSoldOut() });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: SOLD_OUT_HANDLE }));

    expect(out.status).toBe(200);
    expect(out.body.continue_url).toBeNull();
    expect(out.body.reason).toBe('variant_out_of_stock');
    // The whole point: the cart-building service is never reached for a dead variant.
    expect(svc.resolveWarmHandoff).not.toHaveBeenCalled();
  });

  test('the decline is DEFAULT-ON — an env that never mentions the knob still declines', async () => {
    const env = envOn();
    expect(env[REQUIRE_AVAILABLE_ENV]).toBeUndefined(); // guard: the knob really is unset
    const handler = makeHandler({ env, service: service(), fetchImpl: fetchSoldOut() });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: SOLD_OUT_HANDLE }));
    expect(out.body.reason).toBe('variant_out_of_stock');
  });

  test('the kill switch restores the old permissive behaviour', async () => {
    const svc = service();
    const handler = makeHandler({
      env: envOn({ [REQUIRE_AVAILABLE_ENV]: '0' }),
      service: svc,
      fetchImpl: fetchSoldOut(),
    });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: SOLD_OUT_HANDLE }));
    expect(out.body.continue_url).toBe('https://x.myshopify.com/cart/c/1?key=k');
    expect(svc.resolveWarmHandoff).toHaveBeenCalled();
  });

  test('a typo’d knob value leaves the protection ON (only an explicit off-value disarms)', async () => {
    const handler = makeHandler({
      env: envOn({ [REQUIRE_AVAILABLE_ENV]: 'flase' }),
      service: service(),
      fetchImpl: fetchSoldOut(),
    });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: SOLD_OUT_HANDLE }));
    expect(out.body.reason).toBe('variant_out_of_stock');
  });

  test('UNKNOWN stock is not a decline — a storefront that publishes no `available` still resolves', async () => {
    const svc = service();
    const handler = makeHandler({ service: svc, fetchImpl: fetchStockSilent() });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: SOLD_OUT_HANDLE }));
    expect(out.body.continue_url).toBe('https://x.myshopify.com/cart/c/1?key=k');
    expect(out.body.variant_gid).toBe(LIVE_GID);
  });

  test('a caller-supplied variant hint BYPASSES the stock guard entirely', async () => {
    const svc = service();
    const fetchImpl = fetchSoldOut();
    const handler = makeHandler({ service: svc, fetchImpl });
    const out = await handler(authedRequest({
      brand_domain: 'cosrx.com',
      product_handle: SOLD_OUT_HANDLE,
      variant_id: '51895645012184',
    }));
    expect(out.body.continue_url).toBe('https://x.myshopify.com/cart/c/1?key=k');
    expect(out.body.variant_gid).toBe(LIVE_GID);
    // The hint short-circuits before any resolution, so no stock lookup happens at all.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a sold-out verdict is memoised on the SHORT negative TTL, not the 10-minute positive one', async () => {
    const clock = { t: 1_000_000 };
    const fetchImpl = fetchSoldOut();
    const handler = createUcpWarmHandoffInternalHandler({
      env: envOn(), service: service(), fetchImpl, now: () => clock.t,
    });
    const req = () => handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: SOLD_OUT_HANDLE }));

    expect((await req()).body.reason).toBe('variant_out_of_stock');
    await req();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second call served from the memo

    clock.t += 61 * 1000; // past the 60s negative TTL, well inside the 10min positive one
    expect((await req()).body.reason).toBe('variant_out_of_stock');
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1); // re-checked, so a restock is picked up
  });
});

/*
 * Gaps closed after review. Each of these covers a path that a surviving mutant proved untested.
 */
describe('ucpWarmHandoffInternalRoute — seed lane, kill-switch vocabulary, memo keying', () => {
  const HANDLE = 'peptide-132-hair-home-care-kit';
  const GID = 'gid://shopify/ProductVariant/51895645012184';
  const seedWith = (stock) => ({
    snapshot: { variants: [{ sku: 'SHOPIFY-51895645012184', variant_id: '51895645012184', ...(stock ? { stock } : {}) }] },
  });
  const svc = () => ({
    resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x.myshopify.com/cart/c/1?key=k' }),
  });

  // The seed lane resolves BEFORE the network and is the resolver's documented primary path, so the
  // guard has to fire here too. It previously fired for exactly one of these spellings.
  test.each(['out_of_stock', 'Out of Stock', 'out of stock', 'sold_out', 'Sold Out', 'unavailable', 'OutOfStock'])(
    'declines a seed-resolved sold-out variant spelled %p',
    async (stock) => {
      const service = svc();
      const handler = makeHandler({ service, fetchImpl: jest.fn() });
      const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith(stock) }));
      expect([stock, out.body.continue_url, out.body.reason]).toEqual([stock, null, 'variant_out_of_stock']);
      expect(service.resolveWarmHandoff).not.toHaveBeenCalled();
    },
  );

  test('an IN-STOCK seed still builds the cart — the guard is not a blanket seed refusal', async () => {
    const service = svc();
    const handler = makeHandler({ service, fetchImpl: jest.fn() });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('In Stock') }));
    expect(out.body.continue_url).toBe('https://x.myshopify.com/cart/c/1?key=k');
    expect(out.body.variant_gid).toBe(GID);
  });

  test('a seed with NO stock signal is unknown, not sold out, and still resolves', async () => {
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn() });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith(null) }));
    expect(out.body.variant_gid).toBe(GID);
  });

  // An operator reaching for the kill switch mid-incident is as likely to type `false` as `0`.
  test.each(['0', 'false', 'FALSE', 'no', 'off', 'OFF', ' false '])('kill-switch off-value %p disarms the guard', async (value) => {
    const service = svc();
    const handler = makeHandler({
      env: envOn({ [REQUIRE_AVAILABLE_ENV]: value }),
      service,
      fetchImpl: jest.fn(),
    });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('Out of Stock') }));
    expect([value, out.body.continue_url]).toEqual([value, 'https://x.myshopify.com/cart/c/1?key=k']);
  });

  test.each(['1', 'true', '', 'flase', 'disabled', 'null'])('non-off value %p leaves the guard ON', async (value) => {
    const handler = makeHandler({
      env: envOn({ [REQUIRE_AVAILABLE_ENV]: value }),
      service: svc(),
      fetchImpl: jest.fn(),
    });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('Out of Stock') }));
    expect([value, out.body.reason]).toEqual([value, 'variant_out_of_stock']);
  });

  test("one request's sold-out seed does not suppress another request that sent none", async () => {
    // Same brand + handle, different seed_data. Without seed in the memo key the first verdict
    // would silently answer the second request for the whole negative TTL.
    const service = svc();
    const fetchImpl = jest.fn().mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes(`/products/${HANDLE}.js`)
        ? { handle: HANDLE, variants: [{ id: 51895645012184, available: true }] }
        : { products: [{ handle: HANDLE, variants: [{ id: 51895645012184, available: true }] }] }),
    }));
    const handler = makeHandler({ service, fetchImpl });

    const withStaleSeed = await handler(authedRequest({
      brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('Out of Stock'),
    }));
    expect(withStaleSeed.body.reason).toBe('variant_out_of_stock');

    const noSeed = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE }));
    expect(noSeed.body.continue_url).toBe('https://x.myshopify.com/cart/c/1?key=k');
  });

  test('a successful resolve is memoised on the LONG positive TTL', async () => {
    const clock = { t: 5_000_000 };
    const fetchImpl = jest.fn().mockImplementation(async () => ({
      ok: true, status: 200, json: async () => ({ handle: HANDLE, variants: [{ id: 51895645012184, available: true }] }),
    }));
    const handler = createUcpWarmHandoffInternalHandler({ env: envOn(), service: svc(), fetchImpl, now: () => clock.t });
    const req = () => handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE }));

    expect((await req()).body.variant_gid).toBe(GID);
    clock.t += 61 * 1000; // past the 60s NEGATIVE ttl — a positive entry must survive it
    expect((await req()).body.variant_gid).toBe(GID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('flipping the kill switch takes effect IMMEDIATELY, not after the memo ages out', async () => {
    // env is read per request, so the cached verdict must not outlive the setting that produced it.
    const env = envOn();
    const service = svc();
    const handler = makeHandler({ env, service, fetchImpl: jest.fn() });
    const body = { brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('Out of Stock') };

    expect((await handler(authedRequest(body))).body.reason).toBe('variant_out_of_stock');

    env[REQUIRE_AVAILABLE_ENV] = '0'; // operator disarms the guard mid-incident
    expect((await handler(authedRequest(body))).body.continue_url).toBe('https://x.myshopify.com/cart/c/1?key=k');

    env[REQUIRE_AVAILABLE_ENV] = '1'; // and re-arms it
    expect((await handler(authedRequest(body))).body.reason).toBe('variant_out_of_stock');
  });

  test('a non-ASCII handle is percent-encoded in the URL but kept raw in the reported source', async () => {
    // cosrx.com's first listed product really is `advanced-the-vitamin-c-23-serum-번들`.
    const unicodeHandle = 'advanced-the-vitamin-c-23-serum-번들';
    const seen = [];
    const fetchImpl = jest.fn().mockImplementation(async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ handle: unicodeHandle, variants: [{ id: 51895645012184, available: true }] }) };
    });
    const handler = makeHandler({ service: svc(), fetchImpl });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: unicodeHandle }));

    expect(out.body.variant_gid).toBe(GID);
    expect(seen[0]).toBe(`https://cosrx.com/products/${encodeURIComponent(unicodeHandle)}.js`);
    expect(seen[0]).not.toContain('번들'); // the raw form would be an invalid request target
  });
});

/*
 * DECLINE OBSERVABILITY. The variant-miss returns never reach the warm-handoff service, which is what
 * normally records the H1 outcome — so a decline was invisible. For a DEFAULT-ON guard that is the
 * difference between an actionable kill switch and a guess.
 */
describe('ucpWarmHandoffInternalRoute — miss metrics', () => {
  const HANDLE = 'peptide-132-hair-home-care-kit';
  const seedWith = (stock) => ({
    snapshot: { variants: [{ sku: 'SHOPIFY-51895645012184', variant_id: '51895645012184', ...(stock ? { stock } : {}) }] },
  });
  const svc = () => ({
    resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x.myshopify.com/cart/c/1?key=k' }),
  });
  const sink = () => ({ recordWarmHandoffOutcome: jest.fn() });

  test('a sold-out decline counts on the CANONICAL taxonomy tag, not the wire string', async () => {
    const metrics = sink();
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('Out of Stock') }));

    expect(out.body.reason).toBe('variant_out_of_stock'); // wire contract, unchanged
    expect(metrics.recordWarmHandoffOutcome).toHaveBeenCalledWith({
      outcome: 'fallback',
      reason: 'out_of_stock', // the tag existing dashboards already watch
      brandDomain: 'cosrx.com',
    });
  });

  test('an unresolvable variant counts as variant_invalid', async () => {
    const metrics = sink();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const handler = makeHandler({ service: svc(), fetchImpl, metrics });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: 'nope' }));

    expect(out.body.reason).toBe('variant_unresolved');
    expect(metrics.recordWarmHandoffOutcome).toHaveBeenCalledWith({
      outcome: 'fallback', reason: 'variant_invalid', brandDomain: 'cosrx.com',
    });
  });

  test('a SUCCESS is not double-counted here — the service owns that outcome', async () => {
    const metrics = sink();
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('In Stock') }));

    expect(out.body.continue_url).toBe('https://x.myshopify.com/cart/c/1?key=k');
    expect(metrics.recordWarmHandoffOutcome).not.toHaveBeenCalled();
  });

  test('a service-level fallback is not counted here either — no double count with the service', async () => {
    const metrics = sink();
    const service = { resolveWarmHandoff: jest.fn().mockResolvedValue(null) };
    const handler = makeHandler({ service, fetchImpl: jest.fn(), metrics });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('In Stock') }));

    expect(out.body.reason).toBe('fallback');
    expect(metrics.recordWarmHandoffOutcome).not.toHaveBeenCalled();
  });

  test('a THROWING metrics sink cannot turn a cold redirect into a 5xx', async () => {
    const metrics = { recordWarmHandoffOutcome: jest.fn(() => { throw new Error('sink exploded'); }) };
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('sold out') }));

    expect(out.status).toBe(200);
    expect(out.body.continue_url).toBeNull();
    expect(out.body.reason).toBe('variant_out_of_stock');
  });

  test('a malformed metrics sink is ignored rather than thrown through', async () => {
    for (const metrics of [{}, { recordWarmHandoffOutcome: 'not a function' }]) {
      const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
      const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedWith('sold out') }));
      expect(out.status).toBe(200);
    }
  });
});

describe('ucpWarmHandoffInternalRoute — miss metric labels and cardinality', () => {
  const HANDLE = 'peptide-132-hair-home-care-kit';
  const seedOOS = () => ({ snapshot: { variants: [{ variant_id: '51895645012184', stock: 'Out of Stock' }] } });
  const svc = () => ({ resolveWarmHandoff: jest.fn().mockResolvedValue({ continue_url: 'https://x/c/1' }) });
  const sink = () => ({ recordWarmHandoffOutcome: jest.fn(), observeWarmHandoffLatency: jest.fn() });

  // The service lane records hostOf(normalizeBrandOrigin(...)). If this lane recorded the raw caller
  // string, one brand would split across series and the dial would under-report.
  test.each([
    ['cosrx.com', 'cosrx.com'],
    ['https://cosrx.com', 'cosrx.com'],
    ['https://cosrx.com/', 'cosrx.com'],
    ['http://cosrx.com/products/x', 'cosrx.com'],
    ['  COSRX.com  ', 'cosrx.com'],
  ])('brand_domain %p is normalised to the bare host %p', async (given, expected) => {
    const metrics = sink();
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    await handler(authedRequest({ brand_domain: given, product_handle: HANDLE, seed_data: seedOOS() }));
    expect([given, metrics.recordWarmHandoffOutcome.mock.calls[0][0].brandDomain]).toEqual([given, expected]);
  });

  test('a brand_domain that cannot be parsed collapses to a single `unknown` series', async () => {
    // Otherwise unparseable junk becomes the cardinality vector that normalising was meant to close.
    const metrics = sink();
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    for (const junk of ['https://not a url', '%%%', 'http://', '://x']) {
      await handler(authedRequest({ brand_domain: junk, product_handle: HANDLE, seed_data: seedOOS() }));
    }
    const labels = metrics.recordWarmHandoffOutcome.mock.calls.map((c) => c[0].brandDomain);
    expect(new Set(labels)).toEqual(new Set(['unknown']));
  });

  test('a request with nothing to resolve from mints NO metric series', async () => {
    // This return needs no network. Counting it would let a caller mint unbounded permanent
    // `brand_domain` series at zero cost — the outcome counter is a Map that is never trimmed.
    const metrics = sink();
    const fetchImpl = jest.fn();
    const handler = makeHandler({ service: svc(), fetchImpl, metrics });

    for (let i = 0; i < 50; i += 1) {
      const out = await handler(authedRequest({ brand_domain: `junk-${i}.example` }));
      expect(out.body.reason).toBe('variant_unresolved'); // wire vocabulary unchanged
      expect(out.body.continue_url).toBeNull();
    }
    expect(metrics.recordWarmHandoffOutcome).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled(); // and it really was the zero-network path
  });

  test('a miss that DID cost a fetch is still counted', async () => {
    const metrics = sink();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const handler = makeHandler({ service: svc(), fetchImpl, metrics });
    await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: 'nope' }));
    expect(metrics.recordWarmHandoffOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fallback', reason: 'variant_invalid' }),
    );
  });

  test('the counter and the latency histogram move together', async () => {
    // The service lane pairs them; a counter without a histogram makes any rate derived from the
    // histogram disagree with the counter.
    const metrics = sink();
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedOOS() }));
    expect(metrics.recordWarmHandoffOutcome).toHaveBeenCalledTimes(1);
    expect(metrics.observeWarmHandoffLatency).toHaveBeenCalledTimes(1);
    expect(metrics.observeWarmHandoffLatency.mock.calls[0][0].outcome).toBe('fallback');
    expect(Number.isFinite(metrics.observeWarmHandoffLatency.mock.calls[0][0].latencyMs)).toBe(true);
  });

  test('a sink that only implements ONE of the two recorders is still safe', async () => {
    for (const metrics of [
      { recordWarmHandoffOutcome: jest.fn() },
      { observeWarmHandoffLatency: jest.fn() },
    ]) {
      const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
      const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedOOS() }));
      expect(out.status).toBe(200);
    }
  });

  test('a malformed recorder is SKIPPED, not called-and-swallowed', async () => {
    // `status === 200` alone cannot tell "the typeof guard skipped it" from "it threw and the
    // containment catch ate it" — which is the thing this is supposed to prove. So make the
    // malformed member observable: a callable that records invocation and then throws. If the
    // guard is doing its job it is never invoked at all, and the SECOND recorder still runs.
    const invoked = [];
    const badButCallable = (...args) => { invoked.push(args); throw new TypeError('not a real recorder'); };
    badButCallable.notAFunctionMarker = true;
    const metrics = {
      // typeof this is 'object', so the guard must skip it outright
      recordWarmHandoffOutcome: { call: badButCallable },
      observeWarmHandoffLatency: jest.fn(),
    };
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedOOS() }));

    expect(out.status).toBe(200);
    expect(invoked).toHaveLength(0);
    // ...and skipping the bad one must not abort the good one, which a throw-into-catch would.
    expect(metrics.observeWarmHandoffLatency).toHaveBeenCalledTimes(1);
  });

  /*
   * NOTE for the next person running mutation tests here: dropping the `typeof` guard on the LATENCY
   * recorder is an EQUIVALENT mutant, and no test row can kill it. That call is the last statement
   * inside the containment try, so "the guard skipped it" and "it threw and the catch swallowed it"
   * produce identical observable behaviour. The guard on the OUTCOME recorder is a different story
   * and IS killable — dropping it makes the outcome throw before the latency call, which the test
   * above detects. Do not add a vacuous row here to make the survivor go away.
   */
  test('the same holds with the roles reversed — a malformed LATENCY recorder is skipped', async () => {
    const invoked = [];
    const metrics = {
      recordWarmHandoffOutcome: jest.fn(),
      observeWarmHandoffLatency: { call: (...a) => { invoked.push(a); throw new TypeError('nope'); } },
    };
    const handler = makeHandler({ service: svc(), fetchImpl: jest.fn(), metrics });
    const out = await handler(authedRequest({ brand_domain: 'cosrx.com', product_handle: HANDLE, seed_data: seedOOS() }));

    expect(out.status).toBe(200);
    expect(invoked).toHaveLength(0);
    expect(metrics.recordWarmHandoffOutcome).toHaveBeenCalledTimes(1);
  });

});

// --- the landed total actually reaches the caller (audit item 9) -------------------------------
//
// `pricedTotals` is unit-tested next door. These drive the REAL handler, because a projection that
// is correct and never called is indistinguishable from one that is broken: the mutant that
// removed the spread from the response body left every unit test green.

describe('merchant price assertion on the internal route', () => {
  // LIVE shape: string amounts in minor units, no shipping, no tax, escalation required.
  const PRICED = {
    continue_url: 'https://brand.com/checkouts/cn/abc',
    cart_id: 'cart_1',
    preview: { subtotal: '1600', total: '1600', currency: 'USD', tax: null,
               shipping_options: [], requires_escalation: true },
  };

  function serviceReturning(handoff) {
    return { resolveWarmHandoff: async () => handoff };
  }

  it('surfaces the merchant subtotal alongside the handoff url', async () => {
    const handler = makeHandler({ service: serviceReturning(PRICED) });
    const out = await handler(authedRequest({ brand_domain: 'brand.com', variant_gid: COSRX_GID }));

    expect(out.status).toBe(200);
    expect(out.body.continue_url).toBe(PRICED.continue_url);
    expect(out.body.preview).toEqual({
      subtotal_minor: 1600,
      currency: 'USD',
      tax_minor: null,
      includes_shipping: false,
      includes_tax: false,
      requires_escalation: true,
    });
  });

  it('omits the key entirely when the lane produced no priced preview', async () => {
    // The preview flag is DEFAULT OFF, so this is the ordinary path. An absent key rather than a
    // null one, so a caller cannot mistake "the flag is off" for "the merchant quoted nothing".
    const handler = makeHandler({
      service: serviceReturning({ continue_url: PRICED.continue_url, cart_id: 'cart_1' }),
    });
    const out = await handler(authedRequest({ brand_domain: 'brand.com', variant_gid: COSRX_GID }));

    expect(out.status).toBe(200);
    expect(out.body.continue_url).toBe(PRICED.continue_url);
    expect('preview' in out.body).toBe(false);
  });

  it('omits the key when the merchant quoted an amount with no usable currency', async () => {
    const handler = makeHandler({
      service: serviceReturning({ ...PRICED, preview: { total: '4500', currency: '' } }),
    });
    const out = await handler(authedRequest({ brand_domain: 'brand.com', variant_gid: COSRX_GID }));

    expect(out.status).toBe(200);
    expect(out.body.continue_url).toBe(PRICED.continue_url);
    expect('preview' in out.body).toBe(false);
  });

  it('never echoes the handoff url or merchant text back inside the preview', async () => {
    const handler = makeHandler({
      service: serviceReturning({
        ...PRICED,
        preview: { ...PRICED.preview, continue_url: 'https://brand.com/checkouts/cn/secret',
                   messages: ['merchant text'] },
      }),
    });
    const out = await handler(authedRequest({ brand_domain: 'brand.com', variant_gid: COSRX_GID }));

    expect(out.body.preview.continue_url).toBeUndefined();
    expect(out.body.preview.messages).toBeUndefined();
  });
});
