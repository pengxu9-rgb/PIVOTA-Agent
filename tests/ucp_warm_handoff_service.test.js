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

// ---- fetch-failure diagnosis: log the CAUSE, not just "fetch failed" -------
//
// undici collapses every network-layer failure into the same opaque `TypeError: fetch failed` and puts the
// real reason on `.cause`. These payloads are the shapes it really produces (measured on node 20 and 24).
// Since the buyer client now REFUSES redirected profiles (UCP 2026-04-08 requires it), a brand that serves
// /.well-known/ucp only behind a 301 silently leaves the UCP cohort — and with message-only logging that is
// byte-identical to the brand's DNS being dead. `classifyUcpFailure` maps both to `profile_unreachable`, so
// this log line is the only place the two can be told apart.
describe('warm handoff logs the underlying cause of a fetch failure', () => {
  /** Exactly what `fetch(url, { redirect: 'error' })` throws when the profile 302s. */
  function redirectRefusal() {
    const err = new TypeError('fetch failed');
    err.cause = new Error('unexpected redirect');
    return err;
  }

  /** Exactly what fetch throws for a host that does not resolve. */
  function dnsFailure() {
    const err = new TypeError('fetch failed');
    const cause = new Error('getaddrinfo ENOTFOUND cosrx.com');
    cause.code = 'ENOTFOUND';
    err.cause = cause;
    return err;
  }

  function serviceThatThrows(err) {
    const warns = [];
    const svc = createWarmHandoffService({
      client: { async discoverEndpoint() { throw err; } },
      logger: { warn: (rec) => warns.push(rec), info: () => {}, error: () => {} },
    });
    return { svc, warns };
  }

  async function discoveryWarn(err, origin = 'https://cosrx.com') {
    const { svc, warns } = serviceThatThrows(err);
    await svc.discoverBrandEndpointDetailed(origin);
    return warns.find((w) => w.event === 'ucp_warm_handoff_discovery_error');
  }

  test('a refused redirect and a dead host are DISTINGUISHABLE in the log', async () => {
    const redirect = await discoveryWarn(redirectRefusal());
    const dns = await discoveryWarn(dnsFailure());

    // The property that matters. Both carry the same useless `message` and the same `reason` -- the cause
    // is the ONLY thing that separates "this merchant redirects its profile, go fix it" from "this host is
    // gone". Asserted as a difference, not just as two literals, so the test states the discriminator.
    expect(redirect.message).toBe(dns.message);
    expect(redirect.reason).toBe(dns.reason);
    expect(redirect.reason).toBe('profile_unreachable');
    expect(redirect.cause).not.toBe(dns.cause);

    expect(redirect.cause).toBe('unexpected redirect');
    expect(dns.cause).toBe('getaddrinfo ENOTFOUND cosrx.com');
    // The errno rides along when the platform supplies one, and is simply absent when it does not.
    expect(dns.cause_code).toBe('ENOTFOUND');
    expect(redirect).not.toHaveProperty('cause_code');
  });

  test('the cause OBJECT is never spread into the record', async () => {
    const err = redirectRefusal();
    err.cause.stack = 'Error: unexpected redirect\n    at Object.<anonymous> (/app/secret/path.js:1:1)';
    const warn = await discoveryWarn(err);
    // A cause spread wholesale drags a stack (and, for some error shapes, request detail) into the log.
    expect(warn).not.toHaveProperty('stack');
    expect(JSON.stringify(warn)).not.toContain('/app/secret/path.js');
    expect(typeof warn.cause).toBe('string');
  });

  test('tolerates every other cause shape without adding noise', async () => {
    const bare = new TypeError('fetch failed'); // no cause at all -- the pre-undici / non-fetch shape
    const bareWarn = await discoveryWarn(bare);
    expect(bareWarn).not.toHaveProperty('cause');
    expect(bareWarn).not.toHaveProperty('cause_code');
    expect(bareWarn.message).toBe('fetch failed');

    const stringCause = new TypeError('fetch failed');
    stringCause.cause = 'plain string cause';
    expect((await discoveryWarn(stringCause)).cause).toBe('plain string cause');

    const objectCause = new TypeError('fetch failed');
    objectCause.cause = { notAnError: true }; // no .message -- must not emit `cause: undefined`
    expect(await discoveryWarn(objectCause)).not.toHaveProperty('cause');

    const longCause = new TypeError('fetch failed');
    longCause.cause = new Error('x'.repeat(5000)); // bounded so one bad cause can't bloat the line
    expect((await discoveryWarn(longCause)).cause).toHaveLength(200);
  });

  test('the cart lane carries the cause too, not only discovery', async () => {
    const warns = [];
    const svc = createWarmHandoffService({
      client: {
        async discoverEndpoint(origin) { return { mcpEndpoint: `${origin}/api/ucp/mcp`, status: 200 }; },
        async createCart() { throw dnsFailure(); },
        extractHandoffUrl() { return null; },
      },
      logger: { warn: (rec) => warns.push(rec), info: () => {}, error: () => {} },
    });
    await svc.resolveWarmHandoff({
      brandDomain: 'cosrx.com',
      variantGid: 'gid://shopify/ProductVariant/51895645012184',
    });
    const warn = warns.find((w) => w.event === 'ucp_warm_handoff_create_cart_error');
    expect(warn.cause).toBe('getaddrinfo ENOTFOUND cosrx.com');
    expect(warn.cause_code).toBe('ENOTFOUND');
  });
});
