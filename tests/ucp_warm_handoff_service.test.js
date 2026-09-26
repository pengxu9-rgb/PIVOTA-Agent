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

  test('a redirected profile and a dead host are DISTINGUISHABLE in the log', async () => {
    // Under `redirect: 'manual'` (the buyer client's profile fetch) a redirected profile is not a thrown
    // error at all: discovery RESOLVES with the 3xx as its status. The lane classifies that ON THE STATUS
    // into its own reason and its own WARN-level event -- not folded into `not_ucp_reachable`, which is the
    // highest-volume info path in the lane (every brand with no profile lands there) and would bury a
    // fixable merchant misconfiguration as an info needle. A dead host still THROWS and lands on
    // `discovery_error` with the cause. Different event, different field, different reason, different
    // level -- and none of it is undici's wording.
    const recs = [];
    const svcRedirect = createWarmHandoffService({
      client: { async discoverEndpoint(origin) { return { mcpEndpoint: undefined, businessProfile: null, wellKnownUrl: `${origin}/.well-known/ucp`, status: 301 }; } },
      logger: { info: (rec) => recs.push({ level: 'info', ...rec }), warn: (rec) => recs.push({ level: 'warn', ...rec }), error: () => {} },
    });
    const redirectEntry = await svcRedirect.discoverBrandEndpointDetailed('https://cosrx.com');
    const redirect = recs.find((w) => w.event === 'ucp_warm_handoff_profile_redirected');
    const dns = await discoveryWarn(dnsFailure());

    expect(redirectEntry.reachable).toBe(false);
    expect(redirectEntry.reason).toBe('profile_redirected');
    expect(redirect).toBeDefined();
    expect(redirect.level).toBe('warn');
    expect(redirect.status).toBe(301);
    expect(redirect).not.toHaveProperty('cause');
    // And it is NOT the no-profile path: that one stays info-level and keeps its reason.
    expect(recs.find((w) => w.event === 'ucp_warm_handoff_not_reachable')).toBeUndefined();
    const svc404 = createWarmHandoffService({
      client: { async discoverEndpoint(origin) { return { mcpEndpoint: undefined, businessProfile: null, wellKnownUrl: `${origin}/.well-known/ucp`, status: 404 }; } },
      logger: { info: (rec) => recs.push({ level: 'info', ...rec }), warn: (rec) => recs.push({ level: 'warn', ...rec }), error: () => {} },
    });
    expect((await svc404.discoverBrandEndpointDetailed('https://nope.example')).reason).toBe('not_ucp_reachable');
    expect(recs.find((w) => w.event === 'ucp_warm_handoff_not_reachable').level).toBe('info');

    expect(dns.event).toBe('ucp_warm_handoff_discovery_error');
    expect(dns.reason).toBe('profile_unreachable');
    expect(dns.cause).toBe('getaddrinfo ENOTFOUND cosrx.com');
    // The errno rides along when the platform supplies one, and is simply absent when it does not.
    expect(dns.cause_code).toBe('ENOTFOUND');
  });

  test('a thrown fetch failure with an informative cause still logs it (the generic path is unchanged)', async () => {
    // `redirect: 'error'` is no longer how the client refuses a redirect, but this shape -- a TypeError
    // whose real reason is on .cause -- is exactly what every OTHER network-layer failure looks like.
    const err = new TypeError('fetch failed');
    err.cause = new Error('other side closed');
    const warn = await discoveryWarn(err);
    expect(warn.message).toBe('fetch failed');
    expect(warn.cause).toBe('other side closed');
    expect(warn).not.toHaveProperty('cause_code');
  });

  test('the cause OBJECT is never spread into the record', async () => {
    // The REAL shape a node fetch failure carries. Its own enumerable keys are errno/code/syscall/hostname
    // (measured on node 20 and 24) -- those, not the stack, are what a `{...cause}` spread would leak.
    // An earlier version of this test injected a `stack` and asserted its absence, which proved nothing:
    // Error.prototype's `stack` is NON-ENUMERABLE, so `{...err}` never carries it and the assertion held
    // no matter what the code did. Assert an ALLOWLIST on the key set instead of denylisting field names.
    const err = new TypeError('fetch failed');
    const cause = new Error('getaddrinfo ENOTFOUND cosrx.com');
    Object.assign(cause, { errno: -3008, code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'cosrx.com' });
    const warn = await discoveryWarn(err.cause ? err : Object.assign(err, { cause }));

    expect(Object.keys(warn).sort()).toEqual(['cause', 'cause_code', 'event', 'message', 'origin', 'reason']);
    expect(typeof warn.cause).toBe('string');
    // Named explicitly: a spread would land these, and only `code` is meant to survive (as cause_code).
    expect(warn).not.toHaveProperty('errno');
    expect(warn).not.toHaveProperty('syscall');
    expect(warn).not.toHaveProperty('hostname');
    expect(warn).not.toHaveProperty('code');
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

    // A non-string code is dropped rather than published: the only numeric one in this lane is
    // DOMException.code === 20 on an abort, a legacy constant that means nothing in a log.
    const numericCode = new TypeError('fetch failed');
    numericCode.cause = Object.assign(new Error('aborted'), { code: 20 });
    expect(await discoveryWarn(numericCode)).not.toHaveProperty('cause_code');

    // A throwing getter must not escape into the lane -- fetchCauseDetail is an ARGUMENT to note(), so it runs
    // BEFORE note()'s own try/catch. Discovery must still resolve (to an unreachable entry), not reject.
    const hostile = new TypeError('fetch failed');
    Object.defineProperty(hostile, 'cause', { get() { throw new Error('nope'); } });
    const hostileWarn = await discoveryWarn(hostile);
    expect(hostileWarn.reason).toBe('profile_unreachable');
    expect(hostileWarn).not.toHaveProperty('cause');
  });

  test('a dual-stack connect failure still reports a reason (AggregateError has an EMPTY message)', async () => {
    // Real shape for a host with both A and AAAA records: message is '', the per-family reasons are in
    // .errors. Reading `.message` alone would log cause_code with no cause -- on exactly the CDN-fronted
    // brands most likely to be dual-stack.
    const err = new TypeError('fetch failed');
    const agg = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:443'), new Error('connect ECONNREFUSED 127.0.0.1:443')],
      '',
    );
    agg.code = 'ECONNREFUSED';
    err.cause = agg;
    const warn = await discoveryWarn(err);
    expect(warn.cause).toBe('connect ECONNREFUSED ::1:443');
    expect(warn.cause_code).toBe('ECONNREFUSED');
  });

  // Both remaining call sites get their own test. Without them the helper can be wired at discovery and
  // forgotten at the other two, and every assertion above still passes.
  test('the in-chat preview lane carries the cause too', async () => {
    const warns = [];
    const svc = createWarmHandoffService({
      previewEnabled: true,
      client: {
        async discoverEndpoint(origin) { return { mcpEndpoint: `${origin}/api/ucp/mcp`, status: 200 }; },
        async createCart() {
          return { ok: true, status: 200, response: { result: { content: [{ type: 'json', json: { id: 'gid://shopify/Cart/abc', continue_url: 'https://cosrx.example.myshopify.com/cart/c/abc' } }] } } };
        },
        extractHandoffUrl() { return 'https://cosrx.example.myshopify.com/cart/c/abc'; },
        async createCheckoutPreview() { throw dnsFailure(); },
      },
      logger: { warn: (rec) => warns.push(rec), info: () => {}, error: () => {} },
    });
    const res = await svc.resolveWarmHandoff({
      brandDomain: 'cosrx.com',
      variantGid: 'gid://shopify/ProductVariant/51895645012184',
    });
    // The preview is best-effort: the handoff still resolves, and the failure is diagnosable.
    expect(res).not.toBeNull();
    const warn = warns.find((w) => w.event === 'ucp_inchat_preview_error');
    expect(warn.cause).toBe('getaddrinfo ENOTFOUND cosrx.com');
    expect(warn.cause_code).toBe('ENOTFOUND');
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
