'use strict';

// Unit tests for the INTERNAL warm-handoff click-lane resolve handler
// (src/services/ucpWarmHandoffInternalRoute.js — Phase 1 of
// Pivota_Warm_Handoff_Click_Lane_Spec_2026-07-22.md). Pure handler tests with injected
// deps: no network, no express, no real warm-handoff service.

const {
  createUcpWarmHandoffInternalHandler,
  ROUTE_FLAG_ENV,
  INTERNAL_KEY_ENV,
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

function makeHandler({ env = envOn(), service, fetchImpl } = {}) {
  return createUcpWarmHandoffInternalHandler({ env, service, fetchImpl });
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
