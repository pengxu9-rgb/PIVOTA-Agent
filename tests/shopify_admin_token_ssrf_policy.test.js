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

/*
 * `fetchShopifyMerchantCurrency` returns early unless DATABASE_URL is set, and server.js reads env at
 * require time, so this has to be set BEFORE the require below — not in a beforeAll.
 *
 * process.env is per WORKER, not per test file, so leaving it set leaks into every suite that runs
 * after this one in the same worker and can switch those suites onto database paths they are written
 * to skip. That is not hypothetical: it made tests/integration/invoke.get_discovery_feed.test.js fail
 * in a full-suite run while passing in isolation. Restored in afterAll below.
 */
const PRIOR_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = PRIOR_DATABASE_URL || 'postgres://stub/stub';
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

/*
 * Read a node:https.request call WITHOUT assuming which transport made it. The fenced transport calls
 * `request(url, opts, cb)`; axios calls `request(options, cb)` with the host in `options.hostname`.
 * An earlier version of this harness hard-coded the first shape, so against the vulnerable build the
 * fake threw `onResponse is not a function` and sixteen tests went red on a HARNESS error rather than
 * on their assertion — red for the wrong reason is not evidence the test catches the vulnerability.
 */
function describeHttpsCall(args) {
  const onResponse = args.find((a) => typeof a === 'function');
  const objects = args.filter((a) => a && typeof a === 'object');
  const urlObj = objects.find((a) => a instanceof URL);
  const opts = objects.find((a) => !(a instanceof URL)) || {};
  const host = (urlObj && urlObj.hostname) || opts.hostname || opts.host || null;
  const path = (urlObj && `${urlObj.pathname}${urlObj.search}`) || opts.path || '';
  return {
    onResponse,
    opts,
    host,
    path,
    // Rebuilt rather than read off arg 0: axios passes an options object there, so stringifying it
    // yields "[object Object]" and an assertion on the exact URL could never hold for that build.
    url: host ? `https://${host}${path}` : null,
    headers: opts.headers || {},
  };
}

/* Every door a request could leave by, SPIED BUT NOT STUBBED. On the vulnerable build axios is the
 * transport that carried the leak, so a call here is itself the regression; calling through keeps the
 * failure honest and lets the assertion — not a fake — be the thing that fails. */
function watchTransports() {
  const httpsSpy = jest.spyOn(nodeHttps, 'request');
  const axiosSpy = jest.spyOn(axios, 'get');
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  return {
    httpsSpy,
    axiosSpy,
    fetchSpy,
    /*
     * Requests at the WIRE door, normalised to { host, headers }.
     *
     * Only node:https is counted, and that is not a narrowing: axios's http adapter reaches the
     * network through `https.request`, so a call through axios is recorded HERE too — verified
     * against the vulnerable build. Counting the axios door as well double-counted one request as
     * two, which made the positive counterpart below fail against a build that was in fact doing the
     * working lookup correctly. `axiosSpy` is still watched, but as its own signal rather than as a
     * second row. A transport that bypassed node:https entirely would be caught by `fetchSpy` and,
     * whatever it used, by the real listening socket.
     */
    all() {
      return httpsSpy.mock.calls.map((args) => {
        const { host, headers } = describeHttpsCall(args);
        return { door: 'https', host, headers };
      });
    },
    /** Stage a canned response, for the few tests that need the call to COMPLETE. Arity-tolerant, so
     *  it answers axios and the fenced transport alike. */
    stage({ statusCode, headers = {}, body = null }) {
      httpsSpy.mockImplementation((...args) => {
        const { onResponse } = describeHttpsCall(args);
        const request = new EventEmitter();
        for (const noop of ['write', 'destroy', 'abort', 'flushHeaders', 'setNoDelay', 'setSocketKeepAlive', 'setHeader', 'removeHeader']) {
          request[noop] = jest.fn();
        }
        request.getHeader = jest.fn();
        request.setTimeout = jest.fn(() => request);
        request.end = jest.fn(() => {
          const response = new EventEmitter();
          response.statusCode = statusCode;
          response.headers = headers;
          response.resume = jest.fn();
          response.setEncoding = jest.fn();
          response.destroy = jest.fn();
          process.nextTick(() => {
            if (typeof onResponse === 'function') onResponse(response);
            if (body !== null) response.emit('data', Buffer.from(body));
            response.emit('end');
          });
        });
        return request;
      });
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
  // The transport the vulnerable build used, named explicitly: reaching it at all is the regression.
  expect(t.axiosSpy).not.toHaveBeenCalled();
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

afterAll(() => {
  if (PRIOR_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PRIOR_DATABASE_URL;
});

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
    t.stage({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shop: { currency: 'KRW' } }),
    });

    storeRow('cosrx-renewal.myshopify.com');
    await expect(fetchShopifyMerchantCurrency('good')).resolves.toBe('KRW');

    // The mirror of the refusal assertion above: exactly one token-bearing request, to that host.
    expect(tokenBearingRequests(t).map((r) => r.host)).toEqual(['cosrx-renewal.myshopify.com']);
    expect(t.all()).toHaveLength(1);
    // The exact URL, not merely the host: a mutant that kept the host but moved the path off the
    // Admin API would otherwise survive.
    expect(describeHttpsCall(t.httpsSpy.mock.calls[0]).url)
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
      t.stage({ statusCode: 404 });
      storeRow('cosrx-renewal.myshopify.com');
      await fetchShopifyMerchantCurrency('dns');

      expect(t.httpsSpy).toHaveBeenCalled();
      // The vulnerable build reaches node:https through axios, which passes NO lookup at all — so on
      // that build this destructure yields undefined and the assertion below is what fails.
      const { lookup } = describeHttpsCall(t.httpsSpy.mock.calls[0]).opts;
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

  /*
   * Defence in depth, and honestly labelled: this does NOT fail against main.
   *
   * The risk is real — follow-redirects strips only `authorization`/`cookie` on a cross-host hop
   * (node_modules/follow-redirects/index.js:475), so a CUSTOM header such as X-Shopify-Access-Token
   * is replayed to the redirect target. But a staged 302 does not reproduce the second hop through a
   * fake ClientRequest (measured: axios made one request, not two), so a hop-counting assertion here
   * would pass against the leaking build and prove nothing.
   *
   * What IS discriminating is the mechanism the fix installs. `redirect: 'error'` makes the transport
   * REJECT a 3xx with PIVOTA_REDIRECT_REFUSED; drop that option and node:https simply returns the 302
   * as a response, the caller falls out on `status !== 200`, and nothing is logged at all. So the
   * coded warn below is what pins the flag — a hop count could not.
   */
  test('a 3xx is refused with a coded error rather than followed', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      t.stage({ statusCode: 302, headers: { location: 'https://evil.example/collect' } });

      storeRow('cosrx-renewal.myshopify.com');
      await expect(fetchShopifyMerchantCurrency('redir')).resolves.toBeNull();

      // Exactly one token-bearing request, and it went to the shop. No hop was taken.
      expect(tokenBearingRequests(t).map((r) => r.host)).toEqual(['cosrx-renewal.myshopify.com']);
      expect(t.all().every((r) => r.host === 'cosrx-renewal.myshopify.com')).toBe(true);
      // The refusal was the transport's, not an incidental non-200.
      expect(JSON.stringify(warnSpy.mock.calls)).toContain('PIVOTA_REDIRECT_REFUSED');
    } finally {
      warnSpy.mockRestore();
    }
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

  /*
   * The second column is the string the VULNERABLE build actually puts in the log, which is not
   * always the raw column value: for `shop.myshopify.com@evil.example` axios resolves the userinfo
   * form and logs `getaddrinfo ENOTFOUND evil.example`. Asserting only on the raw value there passed
   * against the leaking build — the leak was real and the assertion simply looked for the wrong text.
   */
  test.each([
    ['169.254.169.254', '169.254.169.254'],
    ['evil.example', 'evil.example'],
    ['shop.myshopify.com@evil.example', 'evil.example'],
  ])('no part of %s, and no token, reaches a log call', async (domain, leaked) => {
    storeRow(domain);
    await fetchShopifyMerchantCurrency('log-test');

    // Something IS logged — a silent refusal would be unoperable. The contract is what it may carry.
    expect(warnSpy).toHaveBeenCalled();
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain(domain);
    expect(logged).not.toContain(leaked);
    expect(logged).not.toContain(TOKEN);
    // The merchant id is the safe handle for finding the offending row.
    expect(logged).toContain('log-test');
  });

  test('a refused row is logged once per cache window, not once per request', async () => {
    /*
     * The refusal path is the one an attacker can drive repeatedly, and it sits on ~13 search/browse
     * paths, so an unguarded warn here is a log-volume amplifier.
     *
     * It is NOT enough to rely on the negative cache to suppress the repeat:
     * `getCachedShopifyMerchantCurrency` ends in `hit.currency || null`, so a negative entry reads
     * back as null and the `if (cached) return cached` guard does not fire. Every call runs the whole
     * body again. Measured before the fix: five calls, five warns.
     */
    storeRow('evil.example');
    for (let i = 0; i < 5; i += 1) await fetchShopifyMerchantCurrency('m-repeat');
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
