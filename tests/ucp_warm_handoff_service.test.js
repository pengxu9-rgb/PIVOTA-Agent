'use strict';

const {
  createWarmHandoffService,
  isWarmHandoffEnabled,
  normalizeBrandOrigin,
  WARM_HANDOFF_DISPOSITION,
} = require('../src/services/ucpWarmHandoff');

// A fake UCP buyer-agent client: discovers an endpoint for reachable origins and returns a fixture cart with a
// storefront continue_url. Records every call so tests can assert the HARD BOUNDS (no complete_checkout, URL
// never opened).
function fakeClient({ reachableOrigins = ['https://cosrx.com'], cartResult, discoverError } = {}) {
  const calls = { discover: [], createCart: [], other: [] };
  return {
    client: {
      async discoverEndpoint(origin) {
        calls.discover.push(origin);
        if (discoverError) throw new Error('boom');
        if (reachableOrigins.includes(origin)) {
          return { mcpEndpoint: `${origin}/api/ucp/mcp`, status: 200 };
        }
        return { mcpEndpoint: undefined, status: 404 };
      },
      async createCart(endpoint, { lineItems }) {
        calls.createCart.push({ endpoint, lineItems });
        if (cartResult) return cartResult;
        return {
          ok: true,
          status: 200,
          response: {
            result: {
              content: [{
                type: 'json',
                json: {
                  id: 'gid://shopify/Cart/abc123',
                  continue_url: 'https://cosrx-renewal.myshopify.com/cart/c/abc123?key=SECRETKEYTAIL',
                  line_items: [{ item: { id: lineItems[0].item.id, title: 'COSRX Snail 96' }, quantity: lineItems[0].quantity }],
                },
              }],
            },
          },
        };
      },
      extractHandoffUrl(cart) {
        const j = cart && cart.response && cart.response.result && cart.response.result.content
          && cart.response.result.content[0] && cart.response.result.content[0].json;
        return j ? (j.continue_url || null) : (cart && cart.continue_url) || null;
      },
    },
    calls,
  };
}

describe('isWarmHandoffEnabled flag (default OFF)', () => {
  test('off for empty/false/absent', () => {
    expect(isWarmHandoffEnabled({})).toBe(false);
    expect(isWarmHandoffEnabled({ UCP_WARM_HANDOFF_ENABLED: '' })).toBe(false);
    expect(isWarmHandoffEnabled({ UCP_WARM_HANDOFF_ENABLED: 'false' })).toBe(false);
    expect(isWarmHandoffEnabled({ UCP_WARM_HANDOFF_ENABLED: '0' })).toBe(false);
  });
  test('on for 1/true/yes/on', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(isWarmHandoffEnabled({ UCP_WARM_HANDOFF_ENABLED: v })).toBe(true);
    }
  });
});

describe('normalizeBrandOrigin', () => {
  test('coerces host or url to https origin; rejects junk', () => {
    expect(normalizeBrandOrigin('cosrx.com')).toBe('https://cosrx.com');
    expect(normalizeBrandOrigin('https://cosrx.com/products/x')).toBe('https://cosrx.com');
    expect(normalizeBrandOrigin('')).toBeNull();
  });
});

describe('createWarmHandoffService.resolveWarmHandoff', () => {
  test('returns a warm_handoff with the storefront continue_url on a fixture cart', async () => {
    const { client, calls } = fakeClient();
    const svc = createWarmHandoffService({ client });
    const r = await svc.resolveWarmHandoff({
      brandDomain: 'cosrx.com',
      variantGid: 'gid://shopify/ProductVariant/51895645012184',
    });
    expect(r).not.toBeNull();
    expect(r.disposition).toBe(WARM_HANDOFF_DISPOSITION);
    expect(r.continue_url).toBe('https://cosrx-renewal.myshopify.com/cart/c/abc123?key=SECRETKEYTAIL');
    expect(r.cart_id).toBe('gid://shopify/Cart/abc123');
    expect(r.line_item.variant_gid).toBe('gid://shopify/ProductVariant/51895645012184');
    expect(r.line_item.quantity).toBe(1);
    // HARD BOUND: cart-build only. The client fake exposes no complete_checkout and none was called.
    expect(calls.other).toEqual([]);
    expect(calls.createCart).toHaveLength(1);
  });

  test('caches per-domain endpoint discovery across calls', async () => {
    const { client, calls } = fakeClient();
    const svc = createWarmHandoffService({ client });
    await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: 'gid://shopify/ProductVariant/1' });
    await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: 'gid://shopify/ProductVariant/2' });
    expect(calls.discover).toEqual(['https://cosrx.com']); // discovered once, reused
    expect(calls.createCart).toHaveLength(2);
  });

  test('returns null (cold-redirect fallback) when the brand is not UCP-reachable', async () => {
    const { client, calls } = fakeClient({ reachableOrigins: [] });
    const svc = createWarmHandoffService({ client });
    const r = await svc.resolveWarmHandoff({ brandDomain: 'not-shopify.example', variantGid: 'gid://shopify/ProductVariant/1' });
    expect(r).toBeNull();
    expect(calls.createCart).toHaveLength(0); // never attempted a cart against a non-UCP brand
  });

  test('returns null when the cart is refused', async () => {
    const { client } = fakeClient({ cartResult: { ok: false, status: 422, error: { code: 422, message: 'variant unavailable' } } });
    const svc = createWarmHandoffService({ client });
    const r = await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: 'gid://shopify/ProductVariant/1' });
    expect(r).toBeNull();
  });

  test('returns null when the cart builds but carries no continue_url', async () => {
    const { client } = fakeClient({ cartResult: { ok: true, status: 200, response: { result: { content: [{ type: 'json', json: { id: 'c1' } }] } } } });
    const svc = createWarmHandoffService({ client });
    const r = await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: 'gid://shopify/ProductVariant/1' });
    expect(r).toBeNull();
  });

  test('returns null (never throws) when discovery errors', async () => {
    const { client } = fakeClient({ discoverError: true });
    const svc = createWarmHandoffService({ client });
    const r = await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: 'gid://shopify/ProductVariant/1' });
    expect(r).toBeNull();
  });

  test('returns null for missing brandDomain or variantGid', async () => {
    const { client } = fakeClient();
    const svc = createWarmHandoffService({ client });
    expect(await svc.resolveWarmHandoff({ variantGid: 'gid://shopify/ProductVariant/1' })).toBeNull();
    expect(await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com' })).toBeNull();
  });
});
