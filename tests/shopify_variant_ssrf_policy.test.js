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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      get count() { return connections.length; },
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** Assert nothing was dialled and no transport was even invoked. */
function expectNoRequestWasBuilt({ listener, httpsSpy, fetchSpy }) {
  // Ordered weakest-to-strongest so a failure names the most specific thing that went wrong.
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(httpsSpy).not.toHaveBeenCalled();
  expect(listener.count).toBe(0);
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

  test.each(['cosrx.com', 'www.cosrx.com', 'http://cosrx.com', 'https://anua.us'])(
    'a real storefront host still normalises: %s',
    (brandDomain) => {
      expect(normalizeBrandOrigin(brandDomain)).toMatch(/^https:\/\//);
    },
  );

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
    // Not a synthetic answer: this is the real resolver being asked about a real loopback hostname.
    await new Promise((done, fail) => {
      lookup('localhost', { all: true }, (error, addresses) => {
        try {
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toMatch(/non-public address/);
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

  test('every products.json request asks the transport to refuse redirects', async () => {
    // `redirect` is consumed by createPublicNetworkFetch and never reaches node:https, so it is asserted
    // where it is passed. An injected fetchImpl is the module's own documented test seam.
    const calls = [];
    const fetchImpl = jest.fn(async (url, options) => {
      calls.push({ url, options });
      return { ok: false, status: 302, json: async () => ({}) };
    });
    const result = await resolveVariantViaProductsJson(
      { brandDomain: 'merchant.example', handle: 'some-product' },
      { fetchImpl, maxPages: 1, timeoutMs: 3000 },
    );
    expect(result).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.options.redirect === 'error')).toBe(true);
  });

  test('the pinned transport surfaces a 3xx instead of following its Location', async () => {
    // Pins no-follow independently of the address gates: if someone later relaxes normalizeBrandOrigin,
    // a merchant Location still must not become a second request.
    const target = await listenCounting();
    const requested = [];
    const spy = jest.spyOn(nodeHttps, 'request').mockImplementation((url, _opts, onResponse) => {
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
    try {
      const fetchImpl = createPublicNetworkFetch((_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]));
      const res = await fetchImpl('https://merchant.example/products/x.js');
      expect(res.status).toBe(302);
      expect(res.ok).toBe(false); // so fetchProductsJson reads it as a miss, not as a body
      expect(requested).toEqual(['https://merchant.example/products/x.js']);
      expect(target.count).toBe(0);
    } finally {
      spy.mockRestore();
      await target.close();
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
      await expect(fetchImpl(url)).rejects.toThrow('public address');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
