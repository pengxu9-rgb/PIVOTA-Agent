'use strict';

/*
 * SSRF + Admin-credential-exfiltration policy for the Shopify shop-currency lookup.
 *
 * `fetchShopifyMerchantCurrency` reads `merchant_stores.domain` and sends
 * `https://<domain>/admin/api/2024-07/shop.json` with a LIVE `X-Shopify-Access-Token`. Until this
 * change the column reached the URL with only `String(...).trim()` applied — no suffix check, no
 * private-range check, no scheme or port constraint — from ~13 search/browse response paths whenever
 * a result carried `platform === 'shopify'`.
 *
 * WHY THE CREDENTIAL IS THE PRIMARY PROPERTY, NOT THE SSRF: a plain SSRF makes this process fetch a
 * URL. This one hands a working Shopify Admin credential to whatever host a single row names. Every
 * writer of that column lives in the pivota-backend repo, and the value that actually lands in it is
 * the upstream shop.json `myshopify_domain` — the OAuth guard validates the *input* and then persists
 * a different, unvalidated value — so nothing upstream constrains what arrives here.
 *
 * WHY REAL LISTENERS RATHER THAN ONLY MODULE SPIES: the vulnerable build reaches the network through
 * axios, and a transport swap can move the connection to bindings no spy watches. A real listening
 * socket counts connection ATTEMPTS whatever transport made them, so these tests cannot be satisfied
 * by changing transports later.
 *
 * WHY TOKEN CONFINEMENT IS ASSERTED AT THE REQUEST-BUILD DOOR AND NOT ON THE WIRE: reaching
 * `https://127.0.0.1:PORT` sends a TLS ClientHello first, so a plain-TCP listener never sees the
 * header in plaintext, and a self-signed TLS listener is rejected at the handshake before any header
 * is written. The real exfiltration target is an attacker-controlled host holding a VALID
 * certificate, which no hermetic test can stand up. The checkable invariant — and the actual security
 * property — is therefore: whenever a request carrying the token is BUILT, its host is
 * `*.myshopify.com`. That is asserted across every transport door this file can watch.
 */

const net = require('node:net');
const nodeHttps = require('node:https');
const { EventEmitter } = require('node:events');
const nodeDns = require('node:dns');
const axios = require('axios');

jest.mock('../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(),
}));

const { query } = require('../src/db');
const logger = require('../src/logger');
const { normalizeShopifyAdminHost } = require('../src/services/shopifyAdminHost');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub/stub';
const { _debug } = require('../src/server');
const { fetchShopifyMerchantCurrency, SHOPIFY_MERCHANT_CURRENCY_CACHE } = _debug;

const TOKEN = 'shpat_LIVE_ADMIN_TOKEN_SENTINEL';

/** A bare TCP listener that counts connection ATTEMPTS. A completed handshake is not what is being
 *  measured: reaching the port at all is the SSRF. */
function listenCounting() {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(Date.now());
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    // Without this a failed bind never settles and the test dies at the jest timeout with no cause.
    server.once('error', reject);
    // Bound on `::`, NOT 127.0.0.1. A v4-only bind cannot observe a dial to `[::1]:port` — it just
    // gets ECONNREFUSED — so the IPv6 case would assert `count === 0` against a build that fully
    // connected, which is the exact false-green this file's header argues against.
    server.listen(0, '::', () => resolve({
      port: server.address().port,
      get count() { return connections.length; },
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/* Every door a request could leave by. `outgoing` collects { host, headers } from each. */
function watchTransports() {
  const outgoing = [];
  const httpsSpy = jest.spyOn(nodeHttps, 'request').mockImplementation((url, opts, onResponse) => {
    outgoing.push({ door: 'https', host: url && url.hostname, headers: (opts && opts.headers) || {} });
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
  // Spied but NOT stubbed: on the vulnerable build axios is the transport that carried the leak, so
  // a call here is itself the regression. Calling through keeps the failure honest.
  const axiosSpy = jest.spyOn(axios, 'get');
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  return {
    outgoing,
    httpsSpy,
    axiosSpy,
    fetchSpy,
    /** Requests seen at ANY door, normalised — including the ones the axios spy saw call through. */
    all() {
      const fromAxios = axiosSpy.mock.calls.map(([url, cfg]) => ({
        door: 'axios',
        host: (() => { try { return new URL(String(url)).hostname; } catch { return String(url); } })(),
        headers: (cfg && cfg.headers) || {},
      }));
      return outgoing.concat(fromAxios);
    },
    restore() { httpsSpy.mockRestore(); axiosSpy.mockRestore(); fetchSpy.mockRestore(); },
  };
}

/** Assert nothing was dialled and no transport was even invoked. */
function expectNoRequestWasBuilt(listener, t) {
  // The LISTENER first, deliberately. Jest reports only the first failing assertion, and the listener
  // is the one signal that survives a transport no spy watches. Asserting the spies first would hide
  // exactly the case the socket exists to catch.
  expect(listener.count).toBe(0);
  expect(t.all()).toEqual([]);
  expect(t.fetchSpy).not.toHaveBeenCalled();
}

function storeRow(domain) {
  query.mockResolvedValue({ rows: [{ domain, api_key: TOKEN }] });
}

/** Requests that actually carried the live Admin credential, at any door. */
function tokenBearingRequests(t) {
  return t.all().filter((r) => (
    r.headers['X-Shopify-Access-Token'] === TOKEN || r.headers['x-shopify-access-token'] === TOKEN
  ));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Negative results are cached for 10 minutes. Without this every test after the first would be
  // served from cache, make no call, and pass against ANY build — vacuously.
  SHOPIFY_MERCHANT_CURRENCY_CACHE.clear();
});

describe('normalizeShopifyAdminHost refuses everything that is not a Shopify Admin host', () => {
  test.each([
    // Private and link-local literals — the classic SSRF targets.
    ['127.0.0.1'], ['127.0.0.1:8080'], ['169.254.169.254'], ['10.0.0.9'], ['192.168.1.1'],
    ['[::1]'], ['[::1]:8080'], ['[::ffff:127.0.0.1]'], ['metadata.google.internal'],
    // A PUBLIC host is refused just as hard. A range check alone would still export the credential
    // to an attacker-owned domain, which is the whole point of pinning by shape instead.
    ['evil.example'], ['8.8.8.8'],
    // Suffix confusion.
    ['notmyshopify.com'], ['shop.myshopify.com.evil.example'], ['myshopify.com'],
    ['shop.myshopify.com.'], ['a.b.myshopify.com'], ['-shop.myshopify.com'],
    // Authority confusion: the real host is what precedes `@` / follows the last `/`.
    ['shop.myshopify.com@evil.example'], ['evil.example/#.myshopify.com'],
    ['evil.example/shop.myshopify.com'], ['https://evil.example/@shop.myshopify.com'],
    // Encoding tricks. `。` (U+3002) is the sharp one: WHATWG URL parsing applies IDNA and would map
    // it onto a real dot, so a parse-then-check guard reads this as a valid shop.
    ['shop。myshopify.com'], ['shop%2emyshopify.com'], ['shop\t.myshopify.com'],
    ['shop.myshopify.com\nevil.example'], ['ѕhop.myshopify.com'],
    // Port and scheme constraints.
    ['shop.myshopify.com:8080'], ['http://shop.myshopify.com:22'], ['ftp://shop.myshopify.com'],
    [''], ['   '], [null], [undefined], [{}], [[]],
  ])('%p is not an Admin host', (value) => {
    expect(normalizeShopifyAdminHost(value)).toBeNull();
  });

  // The positive counterpart. Asserting only "not null" here would let a mutant returning the raw
  // input survive every refusal above, so the EXACT canonical host is the contract.
  test.each([
    ['shop.myshopify.com', 'shop.myshopify.com'],
    ['Shop.MyShopify.Com', 'shop.myshopify.com'],
    ['  shop.myshopify.com  ', 'shop.myshopify.com'],
    ['https://shop.myshopify.com', 'shop.myshopify.com'],
    ['https://shop.myshopify.com/', 'shop.myshopify.com'],
    ['http://shop.myshopify.com/admin', 'shop.myshopify.com'],
    ['cosrx-renewal.myshopify.com', 'cosrx-renewal.myshopify.com'],
    ['92sfrj-bi.myshopify.com', '92sfrj-bi.myshopify.com'],
  ])('%s normalises exactly to %s', (raw, expected) => {
    expect(normalizeShopifyAdminHost(raw)).toBe(expected);
  });
});

describe('the shop-currency lookup never dials a host the token may not reach', () => {
  let t;
  beforeEach(() => { t = watchTransports(); });
  afterEach(() => { t.restore(); });

  test('a literal IPv4 domain is refused before any request is built', async () => {
    const listener = await listenCounting();
    try {
      storeRow(`127.0.0.1:${listener.port}`);
      await expect(fetchShopifyMerchantCurrency('m1')).resolves.toBeNull();
      expectNoRequestWasBuilt(listener, t);
    } finally {
      await listener.close();
    }
  });

  test('a bracketed IPv6 literal domain is refused before any request is built', async () => {
    const listener = await listenCounting();
    try {
      storeRow(`[::1]:${listener.port}`);
      await expect(fetchShopifyMerchantCurrency('m2')).resolves.toBeNull();
      expectNoRequestWasBuilt(listener, t);
    } finally {
      await listener.close();
    }
  });

  test('a public but non-Shopify domain is refused before any request is built', async () => {
    const listener = await listenCounting();
    try {
      // Shaped like a real row a migration could produce: a custom storefront domain. The Admin API
      // is not served there, so this lookup was already doomed — but on the vulnerable build it
      // still spent the credential to find that out.
      storeRow('shop.brand-example.com');
      await expect(fetchShopifyMerchantCurrency('m3')).resolves.toBeNull();
      expectNoRequestWasBuilt(listener, t);
    } finally {
      await listener.close();
    }
  });

  test('a suffix-confusion domain is refused before any request is built', async () => {
    const listener = await listenCounting();
    try {
      storeRow('shop.myshopify.com.evil.example');
      await expect(fetchShopifyMerchantCurrency('m4')).resolves.toBeNull();
      expectNoRequestWasBuilt(listener, t);
    } finally {
      await listener.close();
    }
  });
});

describe('the Admin token is confined to *.myshopify.com', () => {
  let t;
  beforeEach(() => { t = watchTransports(); });
  afterEach(() => { t.restore(); });

  test.each([
    ['127.0.0.1'],
    ['169.254.169.254'],
    ['evil.example'],
    ['shop.myshopify.com@evil.example'],
    ['shop.myshopify.com.evil.example'],
    ['shop。myshopify.com'],
  ])('no request carrying the token is ever built for %s', async (domain) => {
    storeRow(domain);
    await fetchShopifyMerchantCurrency(`tok-${domain}`);
    // Stated as an EMPTY LIST rather than as a loop over the requests that were made. A loop body is
    // skipped entirely when nothing was sent, so it would pass against any build that happens to make
    // no request — including one that is broken for unrelated reasons — and could never fail.
    expect(tokenBearingRequests(t)).toEqual([]);
    // The token must not have reached any other header either.
    expect(JSON.stringify(t.all())).not.toContain(TOKEN);
  });

  // The positive counterpart, without which every assertion above is satisfiable by a build that
  // simply never calls Shopify. This pins that the working lookup still works, that it goes to
  // exactly one host, and that it still carries the credential there.
  test('a valid shop row still sends the token to its myshopify host and returns the currency', async () => {
    t.httpsSpy.mockImplementation((url, opts, onResponse) => {
      t.outgoing.push({ door: 'https', host: url.hostname, headers: opts.headers || {} });
      const request = new EventEmitter();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = jest.fn(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        response.resume = jest.fn();
        process.nextTick(() => {
          onResponse(response);
          response.emit('data', Buffer.from(JSON.stringify({ shop: { currency: 'KRW' } })));
          response.emit('end');
        });
      });
      return request;
    });

    storeRow('cosrx-renewal.myshopify.com');
    await expect(fetchShopifyMerchantCurrency('good')).resolves.toBe('KRW');

    // The mirror of the refusal assertion above: exactly one token-bearing request, to that host.
    expect(tokenBearingRequests(t).map((r) => r.host)).toEqual(['cosrx-renewal.myshopify.com']);
    expect(t.all()).toHaveLength(1);
    // The exact URL, not merely the host: a mutant that kept the host but moved the path off the
    // Admin API would otherwise survive.
    expect(t.httpsSpy.mock.calls[0][0].href)
      .toBe('https://cosrx-renewal.myshopify.com/admin/api/2024-07/shop.json');
  });

  test('the transport hands node a public-only DNS resolver, and it refuses a private answer', async () => {
    // A `*.myshopify.com` name that resolves inward cannot be staged against real DNS, so the fence
    // is asserted where it is installed: the resolver the transport pins onto the request. This is
    // deterministic AND stronger — it shows the refusal applies to whatever the system resolver says.
    // The spy must be installed BEFORE the lookup is built. `createPublicOnlyLookup(lookup =
    // nodeDns.lookup)` captures the function VALUE at construction, so spying afterwards leaves the
    // closure holding the real resolver — the first version of this test did exactly that, made a
    // REAL DNS query for the shop, and reported the public answer as "the fence admitted 127.0.0.1".
    const dnsSpy = jest.spyOn(nodeDns, 'lookup');
    try {
      storeRow('cosrx-renewal.myshopify.com');
      await fetchShopifyMerchantCurrency('dns');

      expect(t.httpsSpy).toHaveBeenCalled();
      const { lookup } = t.httpsSpy.mock.calls[0][1];
      expect(typeof lookup).toBe('function');

      // Both directions are driven through the SAME resolver instance — one call could not show both.
      const drive = (answer) => new Promise((resolve) => {
        dnsSpy.mockImplementation((_h, _o, cb) => cb(null, answer));
        lookup('cosrx-renewal.myshopify.com', { all: true }, (err, addresses) => resolve({ err, addresses }));
      });

      const refused = await drive([{ address: '127.0.0.1', family: 4 }]);
      expect(refused.err).toBeTruthy();
      expect(refused.err.code).toBe('PIVOTA_SSRF_REFUSED');

      // A mixed answer is refused too: falling back from the public address to the private one after
      // a connection failure is the standard rebinding bypass.
      const mixed = await drive([{ address: '23.227.38.65', family: 4 }, { address: '10.0.0.9', family: 4 }]);
      expect(mixed.err).toBeTruthy();
      expect(mixed.err.code).toBe('PIVOTA_SSRF_REFUSED');

      // Positive control. Without it, the two assertions above are equally satisfied by a resolver
      // that refuses EVERYTHING — taking every real merchant offline while looking perfectly green.
      const admitted = await drive([{ address: '23.227.38.65', family: 4 }]);
      expect(admitted.err).toBeFalsy();
      expect(admitted.addresses).toEqual([{ address: '23.227.38.65', family: 4 }]);
    } finally {
      dnsSpy.mockRestore();
    }
  });

  test('redirects are refused, so a hop cannot replay the token to another host', async () => {
    // axios follows up to 5 redirects and follow-redirects strips only `authorization`/`cookie` on a
    // cross-host hop — a CUSTOM header such as X-Shopify-Access-Token is REPLAYED to the target.
    // Verified against node_modules/follow-redirects/index.js:475.
    t.httpsSpy.mockImplementation((url, opts, onResponse) => {
      t.outgoing.push({ door: 'https', host: url.hostname, headers: opts.headers || {} });
      const request = new EventEmitter();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = jest.fn(() => {
        const response = new EventEmitter();
        response.statusCode = 302;
        response.headers = { location: 'https://evil.example/collect' };
        response.resume = jest.fn();
        process.nextTick(() => { onResponse(response); response.emit('end'); });
      });
      return request;
    });

    storeRow('cosrx-renewal.myshopify.com');
    await expect(fetchShopifyMerchantCurrency('redir')).resolves.toBeNull();

    // Exactly one request: the hop was not taken.
    expect(t.all()).toHaveLength(1);
    expect(t.all()[0].host).toBe('cosrx-renewal.myshopify.com');
  });
});

describe('the refusal does not leak the row into the logs', () => {
  let warnSpy;
  let t;

  beforeEach(() => {
    t = watchTransports();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warnSpy.mockRestore(); t.restore(); });

  test.each([
    ['169.254.169.254'],
    ['evil.example'],
    ['shop.myshopify.com@evil.example'],
  ])('neither the domain nor the token appears in any log call for %s', async (domain) => {
    storeRow(domain);
    await fetchShopifyMerchantCurrency('log-test');

    // Something IS logged — a silent refusal would be unoperable. The contract is what it may carry.
    expect(warnSpy).toHaveBeenCalled();
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain(domain);
    expect(logged).not.toContain(TOKEN);
    // The merchant id is the safe handle for finding the offending row.
    expect(logged).toContain('log-test');
  });

  test('a transport failure logs a code, never the message that echoes the URL', async () => {
    // normalizeBaseUrl builds `${field} must be https: ${s}` — the offending URL is IN the message —
    // and a DNS/connect failure carries the host too. Forwarding err.message would put the very
    // value this function refuses to trust into the log pipeline.
    t.httpsSpy.mockImplementation(() => {
      const request = new EventEmitter();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = jest.fn(() => {
        const err = new Error('getaddrinfo ENOTFOUND cosrx-renewal.myshopify.com');
        err.code = 'ENOTFOUND';
        process.nextTick(() => request.emit('error', err));
      });
      return request;
    });

    storeRow('cosrx-renewal.myshopify.com');
    await expect(fetchShopifyMerchantCurrency('boom')).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalled();
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('ENOTFOUND');
    expect(logged).not.toContain('getaddrinfo ENOTFOUND cosrx-renewal.myshopify.com');
    expect(logged).not.toContain(TOKEN);
  });
});
