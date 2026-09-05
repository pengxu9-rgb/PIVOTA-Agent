'use strict';

/*
 * SSRF policy for the warm-handoff variant resolver.
 *
 * `brand_domain` arrives from the REQUEST BODY of /internal/ucp/warm-handoff/resolve, so every URL
 * shopifyVariantResolver builds is attacker-influenced. Two holes were measured against this module on
 * 2026-09-04 and are pinned here:
 *   1. an https storefront answering `302 -> http://127.0.0.1:PORT/...` was FOLLOWED (global fetch defaults
 *      to redirect:'follow'), landing three GETs on a plain-http loopback listener; and
 *   2. `brand_domain: '127.0.0.1:PORT'` connected straight there.
 *
 * WHY REAL LISTENERS RATHER THAN A MODULE SPY: the vulnerable build reaches the network through global
 * fetch, and undici connects via Node's INTERNAL bindings — spying `node:tls`.connect / `node:net`.connect /
 * `net.Socket.prototype.connect` observes ZERO calls even while undici is opening the socket (measured).
 * A spy-only test would therefore pass against the vulnerable code: green because it watched the wrong
 * door. A real listening socket counts connection attempts whatever transport made them, so these tests
 * fail against the unfixed module and cannot be satisfied by swapping transports later.
 *
 * Each test asserts the refusal happens BEFORE a request exists — zero accepted connections, plus a
 * never-called `nodeHttps.request` (the fixed transport) and a never-called global fetch (the old one) —
 * not merely that the promise rejected.
 */

const net = require('node:net');
const nodeHttps = require('node:https');
const { EventEmitter } = require('node:events');

const {
  resolveVariantViaProductsJson,
  resolveShopifyVariant,
  normalizeBrandOrigin,
} = require('../src/services/shopifyVariantResolver');
const { createPublicNetworkFetch } = require('../src/services/ucpBuyerAgentClient');

/** A bare TCP listener that counts connection ATTEMPTS — it never speaks TLS, because a completed
 *  handshake is not what is being measured: reaching the port at all is the SSRF. */
function listenCounting() {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(Date.now());
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    // Without this a failed bind never settles and the test dies at the 15 s jest timeout with no cause.
    server.once('error', reject);
    // Bound on `::`, NOT 127.0.0.1. A v4-only bind cannot observe a dial to `[::1]:port` — it just gets
    // ECONNREFUSED — so the IPv6 cases would assert `count === 0` against a build that fully connected,
    // which is the exact false-green this file's header argues against. Verified: a server on `::`
    // records connections from both 127.0.0.1 and ::1.
    server.listen(0, '::', () => resolve({
      server,
      port: server.address().port,
      get count() { return connections.length; },
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** Assert nothing was dialled and no transport was even invoked. */
function expectNoRequestWasBuilt({ listener, httpsSpy, fetchSpy }) {
  // The LISTENER first, deliberately. Jest reports only the first failing assertion, and the listener is
  // the one signal that survives a transport neither spy watches — swap the module to raw node:net and
  // both spies stay silent while sockets open. Asserting the spies first would hide exactly the case the
  // socket exists to catch.
  expect(listener.count).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(httpsSpy).not.toHaveBeenCalled();
}

describe('normalizeBrandOrigin refuses IP-literal origins', () => {
  test.each([
    '127.0.0.1', '127.0.0.1:8080', '169.254.169.254', '10.0.0.9', '192.168.1.1',
    '[::1]', '[::1]:8080', '[fd00::1]', '[::ffff:127.0.0.1]',
    // A PUBLIC literal is refused too: a Shopify shop is never served on a raw address, so the whole
    // literal form is rejected rather than a range list that a public-looking literal could sidestep.
    '8.8.8.8', 'https://8.8.8.8',
  ])('%s is not a brand origin', (brandDomain) => {
    expect(normalizeBrandOrigin(brandDomain)).toBeNull();
  });

  // Asserting only `/^https:\/\//` here let a mutant that dropped the port and stripped `www.` survive
  // all 76 tests across this file and the sibling resolver suite. The exact origin is the contract:
  // the host must survive verbatim, and so must a non-default port.
  test.each([
    ['cosrx.com', 'https://cosrx.com'],
    ['www.cosrx.com', 'https://www.cosrx.com'],
    ['http://cosrx.com', 'https://cosrx.com'],
    ['https://anua.us', 'https://anua.us'],
    ['shop.example.com:8443', 'https://shop.example.com:8443'],
    ['https://cosrx.com/products/x', 'https://cosrx.com'],
  ])('a real storefront host normalises exactly: %s -> %s', (brandDomain, expected) => {
    expect(normalizeBrandOrigin(brandDomain)).toBe(expected);
  });

  test('userinfo in a brand origin is refused', () => {
    expect(normalizeBrandOrigin('https://user:pass@cosrx.com')).toBeNull();
  });
});

describe('the products.json fallback never reaches a private address', () => {
  let httpsSpy;
  let fetchSpy;

  beforeEach(() => {
    httpsSpy = jest.spyOn(nodeHttps, 'request');
    // Spied but NOT stubbed: on the vulnerable build this is the transport that carried the SSRF, so a
    // call here is itself the regression. Calling through keeps the failure honest rather than masking it.
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    httpsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  test('a literal IPv4 brand_domain is refused before any request is built', async () => {
    const listener = await listenCounting();
    try {
      const result = await resolveVariantViaProductsJson(
        { brandDomain: `127.0.0.1:${listener.port}`, handle: 'some-product' },
        { maxPages: 1, timeoutMs: 3000 },
      );
      expect(result).toBeNull();
      expectNoRequestWasBuilt({ listener, httpsSpy, fetchSpy });
    } finally {
      await listener.close();
    }
  });

  test('a bracketed IPv6 literal brand_domain is refused before any request is built', async () => {
    const listener = await listenCounting();
    try {
      const result = await resolveVariantViaProductsJson(
        { brandDomain: `[::1]:${listener.port}`, handle: 'some-product' },
        { maxPages: 1, timeoutMs: 3000 },
      );
      expect(result).toBeNull();
      expectNoRequestWasBuilt({ listener, httpsSpy, fetchSpy });
    } finally {
      await listener.close();
    }
  });

  test('the transport carries a public-only DNS resolver, which refuses a loopback hostname', async () => {
    /*
     * A hostname is not an IP literal, so it clears the literal gate and must be stopped by DNS instead —
     * the merchant-DNS-answers-private case, and the shape a rebind attempt takes.
     *
     * Proved WITHOUT letting a socket be created. Driving a real `https.request` at a loopback-resolving
     * host makes the fence reject inside the DNS callback, and if any test file in this jest worker has
     * left a global http interceptor installed (nock 14 / @mswjs/interceptors), its MockHttpSocket
     * re-emits that rejection as an UNHANDLED error and fails this file for a reason unrelated to the
     * fence — seen in a full parallel run while every assertion itself held. Asserting on the `lookup`
     * the transport installs is both deterministic and STRONGER: it shows the resolver hands Node a
     * public-only resolver, and that that resolver refuses the REAL system DNS answer for `localhost`.
     */
    const seenOptions = [];
    httpsSpy.mockImplementation((_url, opts, onResponse) => {
      seenOptions.push(opts);
      const request = new EventEmitter();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = jest.fn(() => {
        const response = new EventEmitter();
        response.statusCode = 404;
        response.headers = {};
        response.resume = jest.fn();
        process.nextTick(() => { onResponse(response); response.emit('end'); });
      });
      return request;
    });

    const result = await resolveVariantViaProductsJson(
      { brandDomain: 'merchant.example', handle: 'some-product' },
      { maxPages: 1, timeoutMs: 3000 },
    );
    expect(result).toBeNull();
    // The vulnerable build never reaches node:https at all — it calls global fetch instead.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seenOptions.length).toBeGreaterThan(0);

    const { lookup } = seenOptions[0];
    expect(typeof lookup).toBe('function');

    /*
     * The security property, asserted so it cannot go red on the environment: asked about a hostname
     * that resolves to loopback, the installed resolver hands the socket NO address.
     *
     * Only that is asserted — not the message. `createPublicOnlyLookup` refuses with "non-public
     * address" on a host where `localhost` resolves normally, but a container without a `localhost`
     * entry fails the same call with ENOTFOUND. Both mean "no address reached the socket"; pinning the
     * string would turn a missing hosts entry into a red build. The message-level contract is pinned
     * synthetically in tests/ucp_ssrf_policy.test.js, which can inject the underlying resolver — this
     * lookup wraps the real one, so it cannot be fed a fake answer from here.
     */
    await new Promise((done, fail) => {
      lookup('localhost', { all: true }, (error, addresses) => {
        try {
          expect(error).toBeInstanceOf(Error);
          expect(addresses).toBeUndefined();
          done();
        } catch (assertionError) { fail(assertionError); }
      });
    });
  });

  test('the whole route path (resolveShopifyVariant, allowNetworkFallback) is fenced too', async () => {
    // The live caller is ucpWarmHandoffInternalRoute -> resolveShopifyVariant with allowNetworkFallback,
    // and server.js passes no fetchImpl. Drive that exact entry point, not just the inner helper.
    const listener = await listenCounting();
    try {
      const result = await resolveShopifyVariant(
        { seedData: {}, brandDomain: `127.0.0.1:${listener.port}`, handle: 'some-product' },
        { allowNetworkFallback: true, preferAvailable: true, maxPages: 1, timeoutMs: 3000 },
      );
      expect(result).toBeNull();
      expectNoRequestWasBuilt({ listener, httpsSpy, fetchSpy });
    } finally {
      await listener.close();
    }
  });
});

describe('a merchant redirect to loopback is never followed', () => {
  /*
   * The measured regression: an https storefront answering `302 -> http://127.0.0.1:PORT/products/x.js`
   * had its Location FOLLOWED, landing three GETs on a plain-http loopback listener
   * (/products/x.js, /products/x.json, /products.json?limit=250&page=1).
   *
   * This is pinned WITHOUT a self-signed merchant server on purpose. Jest copies `process.env` into the
   * test sandbox, so NODE_TLS_REJECT_UNAUTHORIZED cannot be made to reach Node's TLS layer from inside a
   * test (verified: the handshake still fails with DEPTH_ZERO_SELF_SIGNED_CERT). A real-server version
   * therefore never completes the merchant handshake on the VULNERABLE build, never reaches the redirect,
   * and passes green while proving nothing. Stubbing the transport instead keeps the failure real: the
   * vulnerable build routes through global fetch and trips the first assertion below.
   */
  test('a merchant 302 is answered through the pinned transport and its Location is never fetched', async () => {
    const target = await listenCounting(); // stands in for the internal service the Location points at
    const built = [];
    const httpsSpy = jest.spyOn(nodeHttps, 'request').mockImplementation((url, _opts, onResponse) => {
      built.push(typeof url === 'string' ? url : url.href);
      const request = new EventEmitter();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = jest.fn(() => {
        const response = new EventEmitter();
        response.statusCode = 302;
        response.headers = { location: `http://127.0.0.1:${target.port}/products/some-product.js` };
        response.resume = jest.fn();
        process.nextTick(() => { onResponse(response); response.emit('end'); });
      });
      return request;
    });
    // Rejecting rather than returning keeps a vulnerable build off the real network, so this test stays
    // hermetic in both directions; the assertion that matters is that it is never CALLED.
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => { throw new Error('global fetch must not be the transport here'); });
    try {
      const result = await resolveVariantViaProductsJson(
        { brandDomain: 'merchant.example', handle: 'some-product' },
        { maxPages: 1, timeoutMs: 3000 },
      );

      // 1. The redirect-following transport is gone. This is the assertion the vulnerable build fails.
      expect(fetchSpy).not.toHaveBeenCalled();
      // 2. Every request went to the merchant's own origin — the Location was never turned into one.
      expect(built.length).toBeGreaterThan(0);
      expect(built.every((u) => u.startsWith('https://merchant.example/'))).toBe(true);
      expect(built.some((u) => u.includes(String(target.port)))).toBe(false);
      // 3. Strongest form: nothing ever connected to the address the merchant nominated.
      expect(target.count).toBe(0);
      // 4. A 3xx is a miss, so the lane cold-redirects rather than parsing a redirect body as a product.
      expect(result).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      httpsSpy.mockRestore();
      await target.close();
    }
  });

  /*
   * Redirects ARE followed now, because refusing them broke half the live cohort: measured 2026-09-04,
   * cosrx.com, skin1004.com and anua.us all 301 on `<origin>/products/<handle>.js`, the only per-handle
   * surface carrying `available`. What must never happen is following one to a private address.
   */
  test.each([
    // The first two use a HOSTNAME, not a literal, on purpose: with `127.0.0.1` in the Location the
    // IP-literal check rejects it first, so deleting the https-only guard or the userinfo guard left the
    // whole suite green. Against a hostname, each of those guards is the check that actually decides.
    ['a plain-http Location', 'http://www.cosrx.com/products/some-product.js'],
    ['a userinfo Location', 'https://user:pass@www.cosrx.com/products/some-product.js'],
    ['an https IPv4 literal', 'https://127.0.0.1:PORT/products/some-product.js'],
    ['an https IPv6 literal', 'https://[::1]:PORT/products/some-product.js'],
    ['a protocol-relative Location', '//127.0.0.1:PORT/products/some-product.js'],
  ])('%s is never turned into a request', async (_label, template) => {
    // No listener here on purpose: the transport is injected, so nothing could dial the port even if the
    // hop WERE followed — a `count === 0` assertion would be unfalsifiable. What is falsifiable, and what
    // actually matters, is that the loopback URL is never handed to the transport at all.
    const requested = [];
    const fetchImpl = jest.fn(async (url) => {
      requested.push(url);
      return {
        ok: false,
        status: 302,
        headers: { get: (h) => (h === 'location' ? template.replace('PORT', '8081') : null) },
        json: async () => ({}),
      };
    });
    const result = await resolveVariantViaProductsJson(
      { brandDomain: 'merchant.example', handle: 'some-product' },
      { fetchImpl, maxPages: 1, timeoutMs: 3000 },
    );
    expect(result).toBeNull();
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((u) => u.startsWith('https://merchant.example/'))).toBe(true);
    expect(requested.some((u) => /127\.0\.0\.1|\[::1\]|8081|cosrx/.test(u))).toBe(false);
  });

  test('a legitimate https redirect IS followed, and the hop re-enters the same fence', async () => {
    // The real case this protects: cosrx.com/products/<handle>.js 301s to www.cosrx.com. Refusing it
    // cost the only per-handle surface that carries `available` and forced a ~760 KB listing walk.
    const requested = [];
    const fetchImpl = jest.fn(async (url) => {
      requested.push(url);
      if (url === 'https://cosrx.com/products/some-product.js') {
        return {
          ok: false,
          status: 301,
          headers: { get: (h) => (h === 'location' ? 'https://www.cosrx.com/products/some-product.js' : null) },
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ id: 1, variants: [{ id: 44445555666677, sku: 'X', available: true }] }),
      };
    });
    const result = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', handle: 'some-product' },
      { fetchImpl, maxPages: 1, timeoutMs: 3000 },
    );
    expect(requested).toEqual([
      'https://cosrx.com/products/some-product.js',
      'https://www.cosrx.com/products/some-product.js',
    ]);
    expect(result).toMatchObject({
      variantGid: 'gid://shopify/ProductVariant/44445555666677',
      // The whole point of following: this surface is the one that reports stock.
      stockKnown: true,
      availability: 'available',
    });
  });

  test('a redirect loop is capped instead of spinning', async () => {
    const requested = [];
    const fetchImpl = jest.fn(async (url) => {
      requested.push(url);
      return {
        ok: false,
        status: 302,
        headers: { get: (h) => (h === 'location' ? 'https://merchant.example/loop' : null) },
        json: async () => ({}),
      };
    });
    const result = await resolveVariantViaProductsJson(
      { brandDomain: 'merchant.example', handle: 'some-product' },
      { fetchImpl, maxPages: 1, timeoutMs: 3000 },
    );
    expect(result).toBeNull();
    // 3 surfaces tried, each allowed at most 1 + MAX_REDIRECT_HOPS(3) requests.
    expect(requested.length).toBeLessThanOrEqual(12);
    expect(fetchImpl).toHaveBeenCalled();
  });

  test('a gzipped listing is decoded, and compression is actually requested', async () => {
    // Not cosmetic: the transport counts WIRE bytes against a 2 MiB cap, and medicube.us's listing
    // measured 2,040,790 bytes uncompressed (97.3% of the cap) versus 342,704 gzipped.
    const zlib = require('node:zlib');
    const payload = { products: [{ handle: 'some-product', title: 'T', variants: [{ id: 99998888777766, available: true }] }] };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
    const seenHeaders = [];
    const fetchImpl = jest.fn(async (url, options) => {
      seenHeaders.push(options.headers);
      if (!url.includes('/products.json?')) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === 'content-encoding' ? 'gzip' : null) },
        arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
        json: async () => { throw new Error('body is gzipped; json() must not be used'); },
      };
    });
    const result = await resolveVariantViaProductsJson(
      { brandDomain: 'merchant.example', handle: 'some-product' },
      { fetchImpl, maxPages: 1, timeoutMs: 3000 },
    );
    expect(result).toMatchObject({ variantGid: 'gid://shopify/ProductVariant/99998888777766' });
    expect(seenHeaders.every((h) => h['accept-encoding'] === 'gzip')).toBe(true);
    expect(seenHeaders.length).toBeGreaterThan(0);
  });

  test('the pinned transport surfaces a 3xx instead of following its Location', async () => {
    // Pins no-follow independently of the address gates: if someone later relaxes normalizeBrandOrigin,
    // a merchant Location still must not become a second request.
    let target = null;
    let spy = null;
    const requested = [];
    try {
    target = await listenCounting();
    spy = jest.spyOn(nodeHttps, 'request').mockImplementation((url, _opts, onResponse) => {
      requested.push(typeof url === 'string' ? url : url.href);
      const request = new EventEmitter();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = jest.fn(() => {
        const response = new EventEmitter();
        response.statusCode = 302;
        response.headers = { location: `http://127.0.0.1:${target.port}/products/x.js` };
        response.resume = jest.fn();
        process.nextTick(() => { onResponse(response); response.emit('end'); });
      });
      return request;
    });
      const fetchImpl = createPublicNetworkFetch((_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]));
      const res = await fetchImpl('https://merchant.example/products/x.js');
      expect(res.status).toBe(302);
      // Surfaced, not followed: the transport itself never turns a Location into a second request.
      expect(res.ok).toBe(false);
      expect(requested).toEqual(['https://merchant.example/products/x.js']);
      expect(target.count).toBe(0);
    } finally {
      if (spy) spy.mockRestore();
      if (target) await target.close();
    }
  });
});

/*
 * These pin a DEPENDENCY, not a regression this change fixes: `forbiddenLiteralHost` (added by #2141)
 * is what makes routing this module through createPublicNetworkFetch sufficient. They pass on main and
 * are here so that a later edit to the shared fence cannot silently reopen this module's hole — the
 * bracket handling in particular, since `new URL('https://[::1]/').hostname` KEEPS the brackets and
 * `net.isIP('[::1]')` is 0, so an unstripped literal test would wave every IPv6 through while Node
 * strips them itself and connects WITHOUT a DNS lookup, leaving the public-only resolver blind too.
 */
describe('the shared fence refuses IP literals, including bracketed IPv6', () => {
  test.each([
    'https://[::1]/products.json',
    'https://[0:0:0:0:0:ffff:7f00:1]/products.json',
    'https://[fd00::1]/products.json',
    'https://127.0.0.1/products.json',
  ])('%s is refused with no request built', async (url) => {
    const spy = jest.spyOn(nodeHttps, 'request');
    try {
      const fetchImpl = createPublicNetworkFetch((_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]));
      // By CODE, not message: 'must resolve to a public address' (literal gate, PIVOTA_SSRF_LITERAL) and
      // 'resolved to a non-public address' (DNS gate, PIVOTA_SSRF_REFUSED) BOTH contain 'public address',
      // so a substring match cannot tell "refused before a request" from "refused after one was built".
      await expect(fetchImpl(url)).rejects.toMatchObject({ code: 'PIVOTA_SSRF_LITERAL' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
