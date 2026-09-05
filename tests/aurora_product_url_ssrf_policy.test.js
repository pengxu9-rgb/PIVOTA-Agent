'use strict';

/*
 * SSRF policy for the aurora BFF product-URL fetch lane.
 *
 * THE HOLE THIS PINS. `src/auroraBff/routes.js` fetched the caller's product URL with a bare
 * `axios.get(productUrl, { validateStatus: (s) => s >= 200 && s < 500 })` — no address check anywhere in
 * the chain, and axios's default `maxRedirects: 5`, so a `302 -> http://127.0.0.1:PORT/` WAS followed.
 * The URL arrives from a REQUEST BODY (`POST /v1/product/analyze` `url`; `POST /v1/chat`
 * `anchor_product_url`, typed `z.string().min(1)`) behind `requireAuroraUid`, which accepts any non-empty
 * `X-Aurora-UID`. It is not blind: parsed ingredients/price/rating come back in the response, and the
 * competitor backfill re-fetches after the response is sent.
 *
 * WHY REAL LISTENING SOCKETS. A module spy is not proof: it only observes the transport it happens to
 * watch, so swapping transports later would leave a spy-only suite green while sockets open. A real
 * listener counts connection ATTEMPTS whatever made them. It is bound on `::`, NOT 127.0.0.1 — a v4-only
 * bind cannot observe a dial to `[::1]:port` (it just gets ECONNREFUSED), so an IPv6 case would assert
 * `count === 0` against a build that fully connected, which is the exact false-green this file exists to
 * avoid.
 *
 * WHERE A REAL SOCKET CANNOT BE USED. A "merchant" that is allowed through the fence must live at a
 * PUBLIC address, and a test cannot own one. So the hop-by-hop guards are pinned against an INJECTED
 * axios instance instead, where the falsifiable claim is that the forbidden URL is never handed to the
 * transport at all. Those tests deliberately make no `count === 0` assertion: with an injected transport
 * nothing could dial the port even if the hop were followed, so such an assertion could not fail.
 */

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const axios = require('axios');

const { createPublicUrlFetch, parsePublicHttpUrl } = require('../src/services/publicUrlFetch');
const { __internal } = require('../src/auroraBff/routes');

const { fetchProductHtmlWithUnblockChain } = __internal;

/** A bare TCP listener that counts connection ATTEMPTS. It never speaks HTTP: reaching the port at all
 *  is the SSRF, so a completed exchange is not what is being measured. */
function listenCounting() {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(Date.now());
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    // Without this a failed bind never settles and the test dies at the jest timeout with no cause.
    server.once('error', reject);
    server.listen(0, '::', () => resolve({
      port: server.address().port,
      get count() { return connections.length; },
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** A real HTTP server that answers every request with a redirect to `locationFor(req)`. */
function listenRedirecting(locationFor) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(302, { location: locationFor(req) });
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::', () => resolve({
      port: server.address().port,
      get seen() { return seen.slice(); },
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

describe('parsePublicHttpUrl is the one address rule', () => {
  test.each([
    ['IPv4 loopback', 'http://127.0.0.1/x'],
    ['IPv4 loopback with port', 'http://127.0.0.1:8080/x'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['RFC1918 10/8', 'https://10.0.0.9/x'],
    ['RFC1918 192.168/16', 'https://192.168.1.1/x'],
    ['RFC1918 172.16/12', 'https://172.16.0.1/x'],
    ['carrier-grade NAT', 'https://100.64.0.1/x'],
    ['unspecified', 'http://0.0.0.0/x'],
    ['IPv6 loopback', 'http://[::1]:8080/x'],
    ['IPv6 unique-local', 'https://[fd00::1]/x'],
    ['IPv6 link-local', 'https://[fe80::1]/x'],
    // The v4-mapped and 6to4 forms are the sharp end: they ride the v4 stack, and `URL.hostname` KEEPS
    // the brackets while `net.isIP('[::ffff:127.0.0.1]')` is 0, so a guard that forgets to strip them
    // waves every IPv6 literal straight through.
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/x'],
    ['IPv4-mapped metadata', 'https://[::ffff:169.254.169.254]/x'],
    ['6to4 for loopback', 'https://[2002:7f00:1::]/x'],
  ])('refuses %s', (_label, url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow(
      expect.objectContaining({ code: 'PIVOTA_SSRF_LITERAL' }),
    );
  });

  /*
   * ALTERNATE ENCODINGS of the same address. These are the classic literal-check bypasses, and they are
   * refused here because WHATWG `new URL()` NORMALISES every one of them back to dotted-quad before
   * `net.isIP` ever sees it (verified: each of these parses to hostname `127.0.0.1` / `169.254.169.254`).
   * Pinned rather than assumed: the guard's correctness rests on that normalisation, so if a future URL
   * implementation stopped folding one of these, the fence would silently open and this would say so.
   */
  test.each([
    ['decimal', 'http://2130706433/'],
    ['octal', 'http://0177.0.0.1/'],
    ['hex', 'http://0x7f000001/'],
    ['short form', 'http://127.1/'],
    ['trailing dot', 'http://127.0.0.1./'],
    ['metadata trailing dot', 'http://169.254.169.254./'],
    ['circled digits', 'http://\u2460\u2461\u2466.0.0.1/'],
    ['ideographic full stops', 'http://127\u30020\u30020\u30021/'],
    ['fully expanded v4-mapped', 'http://[0:0:0:0:0:ffff:127.0.0.1]/'],
  ])('refuses the %s encoding of a forbidden address', (_label, url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow(
      expect.objectContaining({ code: 'PIVOTA_SSRF_LITERAL' }),
    );
  });

  test.each([
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.com/x'],
    ['gopher', 'gopher://example.com/x'],
    ['data', 'data:text/html,hi'],
  ])('refuses the %s scheme', (_label, url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow(
      expect.objectContaining({ code: 'PIVOTA_SSRF_SCHEME' }),
    );
  });

  test('refuses userinfo', () => {
    expect(() => parsePublicHttpUrl('https://user:pass@cosrx.com/products/x')).toThrow(
      expect.objectContaining({ code: 'PIVOTA_SSRF_USERINFO' }),
    );
  });

  test.each([['', 'PIVOTA_SSRF_INVALID_URL'], ['not a url', 'PIVOTA_SSRF_INVALID_URL'], ['/relative', 'PIVOTA_SSRF_INVALID_URL']])(
    'refuses %p as unparseable', (url, code) => {
      expect(() => parsePublicHttpUrl(url)).toThrow(expect.objectContaining({ code }));
    },
  );

  /*
   * THE POSITIVE COUNTERPART, with EXACT values. Asserting only "does not throw" would let a mutant that
   * mangles the URL — dropping the port, the query, or the path — survive every refusal test above, and
   * this lane's whole job is fetching the page the caller named.
   */
  test.each([
    ['https://cosrx.com/products/x', 'https://cosrx.com/products/x'],
    ['http://www.cerave.com/skincare/moisturizers/m', 'http://www.cerave.com/skincare/moisturizers/m'],
    ['https://shop.example.com:8443/p?a=1&b=2', 'https://shop.example.com:8443/p?a=1&b=2'],
    ['https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=x', 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=x'],
    // A PUBLIC literal is allowed, unlike the sibling Shopify fence which refuses every literal. There a
    // storefront is never served on a raw address, so the whole form is illegitimate. Here the lane's
    // purpose is fetching arbitrary caller-named public pages, so a public literal buys an attacker
    // nothing they could not get by naming a hostname — and the forbidden ranges are still refused above.
    ['https://8.8.8.8/x', 'https://8.8.8.8/x'],
  ])('accepts %s and preserves it exactly', (input, expected) => {
    expect(parsePublicHttpUrl(input).toString()).toBe(expected);
  });
});

describe('the live lane never reaches a private address (real sockets)', () => {
  /*
   * Two independent signals, and BOTH are needed.
   *
   * The listener proves no socket reached the port whatever transport tried. But a listener can only
   * observe an address a test can bind, so for an address that is merely UNROUTABLE from the test host
   * (169.254.169.254 is, here) `count === 0` is satisfied by a working fence and by a three-second
   * connect timeout alike — it cannot fail, and measured against the unfenced lane it did not.
   *
   * So the request-built signal is asserted too. `routes.js` reaches the network through `axios.get` on
   * BOTH builds — directly on the unfenced one, and via the pinned transport on the fixed one, which
   * calls `.get` on this same module object — so a spy here observes either. Never called means the
   * refusal happened before a request existed, which is the actual claim, and it is falsifiable for every
   * address including the unroutable ones.
   */
  let getSpy;
  beforeEach(() => {
    // Spied, NOT stubbed: on the unfenced build this is the call that carries the SSRF, so letting it
    // through keeps the failure honest instead of masking it behind a mock.
    getSpy = jest.spyOn(axios, 'get');
  });
  afterEach(() => { getSpy.mockRestore(); });

  test.each([
    ['a loopback IPv4 product URL', (port) => `http://127.0.0.1:${port}/products/x`],
    ['a loopback IPv6 product URL', (port) => `http://[::1]:${port}/products/x`],
    ['an RFC1918 product URL', () => 'http://192.168.1.1/products/x'],
    ['the cloud metadata address', () => 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['an IPv4-mapped IPv6 loopback', (port) => `http://[::ffff:127.0.0.1]:${port}/products/x`],
  ])('%s is refused before any request is built', async (_label, urlFor) => {
    const listener = await listenCounting();
    try {
      const out = await fetchProductHtmlWithUnblockChain({
        productUrl: urlFor(listener.port),
        timeoutMs: 3000,
      });
      expect(out.ok).toBe(false);
      // The listener FIRST: it is the only signal that survives a transport the spy does not watch.
      expect(listener.count).toBe(0);
      // ...and the one that is falsifiable even when the address is unroutable from this host.
      expect(getSpy).not.toHaveBeenCalled();
      expect(out.failure_code).toBe('url_forbidden_address');
    } finally {
      await listener.close();
    }
  });

  /*
   * `localhost` is the payload the literal check CANNOT see — it is a hostname, so it parses cleanly and
   * only the resolver fence stands between it and loopback. Worth its own case precisely because it is
   * the most obvious thing an attacker types and the one guard the URL rule does not cover.
   */
  test('a hostname that resolves to loopback (localhost) is refused at the DNS layer', async () => {
    const listener = await listenCounting();
    try {
      const out = await fetchProductHtmlWithUnblockChain({
        productUrl: `http://localhost:${listener.port}/products/x`,
        timeoutMs: 3000,
      });
      expect(out.ok).toBe(false);
      expect(listener.count).toBe(0);
      // Unlike the literal cases, a request IS built here — the refusal happens when the socket asks for
      // an address — so `getSpy` is expected to have been called. The coded refusal is what proves the
      // resolver fence fired rather than, say, the port simply being closed.
      expect(out.attempts.map((a) => a.error_code)).toContain('pivota_ssrf_refused');
      // And it must be DISTINGUISHABLE from a merchant being down. Without a `pivota_ssrf` branch in
      // buildUrlFetchFailureCode this reported the same `url_fetch_failed` as any timeout, which made
      // abuse of this lane invisible in the field most likely to be dashboarded.
      expect(out.failure_code).toBe('url_forbidden_address');
    } finally {
      await listener.close();
    }
  });

  /*
   * THE REPORTED REDIRECT CASE, end to end on real sockets. A server answers `302 -> http://127.0.0.1:T/`
   * and T is a separate counting listener standing in for an internal service. On the unfixed build axios
   * followed that Location and T recorded a connection; the fence refuses the FIRST hop, so neither the
   * redirector nor T is ever dialled.
   */
  test('a 302 to loopback is never followed', async () => {
    const internal = await listenCounting();
    const redirector = await listenRedirecting(() => `http://127.0.0.1:${internal.port}/stolen`);
    try {
      const out = await fetchProductHtmlWithUnblockChain({
        productUrl: `http://127.0.0.1:${redirector.port}/r`,
        timeoutMs: 3000,
      });
      expect(out.ok).toBe(false);
      expect(internal.count).toBe(0);
      expect(redirector.seen).toEqual([]);
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      await redirector.close();
      await internal.close();
    }
  });
});

describe('the DNS answer is fenced, not just the literal (real socket + positive control)', () => {
  /*
   * A hostname that RESOLVES to loopback is the bypass a literal check alone cannot see. The stub lookup
   * below is the only way to exercise it hermetically: it answers `internal.example` with 127.0.0.1, and
   * a real listener records whether anything arrived.
   *
   * The POSITIVE CONTROL is what makes the refusal meaningful. Without it, `count === 0` is equally
   * satisfied by a fence that works and by a test whose stub never resolved at all.
   */
  function stubLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = (typeof options === 'function' || !options) ? {} : options;
    if (hostname !== 'internal.example') return dns.lookup(hostname, opts, cb);
    const records = [{ address: '127.0.0.1', family: 4 }];
    if (opts.all) return cb(null, records);
    return cb(null, records[0].address, records[0].family);
  }

  test('POSITIVE CONTROL: the same stub through an UNFENCED agent does reach the listener', async () => {
    const listener = await listenCounting();
    try {
      const agent = new http.Agent({ lookup: stubLookup });
      await axios.get(`http://internal.example:${listener.port}/x`, {
        httpAgent: agent, proxy: false, timeout: 4000, validateStatus: () => true,
      }).catch(() => {});
      expect(listener.count).toBeGreaterThan(0);
    } finally {
      await listener.close();
    }
  });

  test('a hostname resolving to loopback is refused by the fenced transport', async () => {
    const listener = await listenCounting();
    try {
      const fenced = createPublicUrlFetch({ axiosInstance: axios, lookup: stubLookup });
      await expect(
        fenced(`http://internal.example:${listener.port}/x`, { timeout: 4000, validateStatus: () => true }),
      ).rejects.toThrow(expect.objectContaining({ code: 'PIVOTA_SSRF_REFUSED' }));
      expect(listener.count).toBe(0);
    } finally {
      await listener.close();
    }
  });
});

describe('every redirect hop re-enters the fence', () => {
  /** An axios stand-in that records the URLs it is asked for and replays scripted responses. */
  function scriptedAxios(script) {
    const requested = [];
    const instance = {
      get: jest.fn(async (url, config) => {
        requested.push({ url, config });
        const entry = typeof script === 'function' ? script(url) : script[url];
        if (!entry) return { status: 200, headers: {}, data: 'FINAL' };
        return entry;
      }),
    };
    return { instance, requested };
  }

  test.each([
    // The first three use a HOSTNAME rather than a literal on purpose: with `127.0.0.1` in the Location
    // the literal check rejects first, so deleting the scheme or userinfo guard would leave the suite
    // green. Against a hostname each guard is the check that actually decides.
    ['a non-http scheme Location', 'file:///etc/passwd'],
    ['a userinfo Location', 'https://user:pass@www.cosrx.com/x'],
    ['a gopher Location', 'gopher://www.cosrx.com/x'],
    ['an IPv4 literal Location', 'http://127.0.0.1:9/x'],
    ['an IPv6 literal Location', 'http://[::1]:9/x'],
    ['a metadata Location', 'http://169.254.169.254/latest/'],
    ['a protocol-relative Location to loopback', '//127.0.0.1:9/x'],
  ])('%s is never turned into a request', async (_label, location) => {
    const { instance, requested } = scriptedAxios({
      'https://merchant.example/p': { status: 302, headers: { location }, data: '' },
    });
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await expect(fenced('https://merchant.example/p', { validateStatus: () => true })).rejects.toThrow();
    expect(requested.map((r) => r.url)).toEqual(['https://merchant.example/p']);
  });

  test('a legitimate https hop IS followed and the final response is returned', async () => {
    // The real case: cosrx.com 301s to www.cosrx.com. Refusing hops would break 6 of the 14 endpoints
    // measured on this lane, including the only http:// input, which reaches https BY redirecting.
    const { instance, requested } = scriptedAxios({
      'https://cosrx.com/p': { status: 301, headers: { location: 'https://www.cosrx.com/p' }, data: '' },
      'https://www.cosrx.com/p': { status: 200, headers: {}, data: '<html>LANDED</html>' },
    });
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    const res = await fenced('https://cosrx.com/p', { validateStatus: (s) => s >= 200 && s < 500 });
    expect(res.status).toBe(200);
    expect(res.data).toBe('<html>LANDED</html>');
    expect(requested.map((r) => r.url)).toEqual(['https://cosrx.com/p', 'https://www.cosrx.com/p']);
  });

  test('an http Location IS followed when it points at a public host (the cerave case)', async () => {
    const { instance, requested } = scriptedAxios({
      'http://www.cerave.com/p': { status: 301, headers: { location: 'https://www.cerave.com/p' }, data: '' },
      'https://www.cerave.com/p': { status: 200, headers: {}, data: 'OK' },
    });
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    const res = await fenced('http://www.cerave.com/p', { validateStatus: () => true });
    expect(res.status).toBe(200);
    expect(requested.map((r) => r.url)).toEqual(['http://www.cerave.com/p', 'https://www.cerave.com/p']);
  });

  test('a relative Location resolves against the hop it came from', async () => {
    const { instance, requested } = scriptedAxios({
      'https://cosrx.com/a/b': { status: 302, headers: { location: '../c' }, data: '' },
      'https://cosrx.com/c': { status: 200, headers: {}, data: 'OK' },
    });
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await fenced('https://cosrx.com/a/b', { validateStatus: () => true });
    expect(requested.map((r) => r.url)).toEqual(['https://cosrx.com/a/b', 'https://cosrx.com/c']);
  });

  test('a redirect loop is bounded by the hop cap', async () => {
    const { instance, requested } = scriptedAxios(() => ({
      status: 302, headers: { location: 'https://loop.example/x' }, data: '',
    }));
    const fenced = createPublicUrlFetch({ axiosInstance: instance, maxRedirectHops: 3 });
    await expect(fenced('https://loop.example/x', { validateStatus: () => true }))
      .rejects.toThrow(expect.objectContaining({ code: 'PIVOTA_URL_REDIRECT_CAP' }));
    expect(requested.length).toBe(4); // the original plus three hops
  });

  test.each([
    ['AxiosHeaders with a capitalised Location', (loc) => new axios.AxiosHeaders({ Location: loc })],
    ['a WHATWG Headers instance', (loc) => new Headers({ location: loc })],
  ])('the Location is read through .get() — %s', async (_label, makeHeaders) => {
    /*
     * THIS TEST WAS VACUOUS and an independent review caught it. It used
     * `new AxiosHeaders({ location })`, whose value is ALSO reachable as an own property — so deleting
     * the `.get()` branch entirely left the suite green while claiming to pin "the shape the actual
     * writer produces". Verified: `new AxiosHeaders({location:'x'}).location === 'x'`, but
     * `new AxiosHeaders({Location:'x'}).location === undefined` while `.get('location') === 'x'`.
     * Both shapes below are readable ONLY through `.get()`, so removing that branch now fails.
     */
    const requested = [];
    const instance = {
      get: jest.fn(async (url) => {
        requested.push(url);
        if (url === 'https://cosrx.com/p') {
          return { status: 301, headers: makeHeaders('https://www.cosrx.com/p'), data: '' };
        }
        return { status: 200, headers: makeHeaders(null), data: 'LANDED' };
      }),
    };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    const res = await fenced('https://cosrx.com/p', { validateStatus: () => true });
    expect(res.data).toBe('LANDED');
    expect(requested).toEqual(['https://cosrx.com/p', 'https://www.cosrx.com/p']);
  });

  test('a redirect with no Location is refused rather than treated as a body', async () => {
    const { instance } = scriptedAxios({
      'https://merchant.example/p': { status: 302, headers: {}, data: '' },
    });
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await expect(fenced('https://merchant.example/p', { validateStatus: () => true }))
      .rejects.toThrow(expect.objectContaining({ code: 'PIVOTA_URL_REDIRECT_NO_LOCATION' }));
  });
});

describe('the fence does not change what the lane fetches or how it reads it', () => {
  test('a caller-supplied transport or socketPath cannot unpick the fence', async () => {
    /*
     * axios checks `config.transport` BEFORE `maxRedirects`, so passing follow-redirects' http module
     * restored redirect-following with NO hop re-validation — reproduced in review: a
     * `302 -> http://127.0.0.1:PORT` was followed and its body returned. `socketPath` is checked before
     * host/port and dials a unix socket outright. Both are now stripped from the caller's config.
     */
    const calls = [];
    const instance = { get: jest.fn(async (url, config) => { calls.push(config); return { status: 200, headers: {}, data: 'OK' }; }) };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await fenced('https://cosrx.com/p', {
      validateStatus: () => true,
      transport: require('follow-redirects').http,
      socketPath: '/var/run/docker.sock',
      lookup: () => {},
      proxy: { host: '127.0.0.1', port: 1 },
      maxRedirects: 9,
    });
    expect(calls[0].transport).toBeUndefined();
    expect(calls[0].socketPath).toBeUndefined();
    expect(calls[0].lookup).toBeUndefined();
    expect(calls[0].proxy).toBe(false);
    expect(calls[0].maxRedirects).toBe(0);
  });

  test('a caller that omits validateStatus gets axios\'s own default, not "accept everything"', async () => {
    // Passing `validateStatus: () => true` inward and re-applying only a caller-SUPPLIED predicate
    // silently resolved a 503 for any caller that omitted one.
    const instance = { get: jest.fn(async () => ({ status: 503, headers: {}, data: 'nope' })) };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await expect(fenced('https://cosrx.com/p', {})).rejects.toThrow(
      expect.objectContaining({ code: 'ERR_BAD_RESPONSE' }),
    );
  });

  test('credential headers are dropped when a hop crosses to another origin', async () => {
    // follow-redirects, which this module replaced, strips these on a cross-host hop. Reusing the
    // caller's headers verbatim handed them to whatever host a merchant nominated.
    const seen = [];
    const instance = {
      get: jest.fn(async (url, config) => {
        seen.push({ url, headers: config.headers });
        if (url === 'https://merchant.example/p') {
          return { status: 302, headers: { location: 'https://other.example/p' }, data: '' };
        }
        return { status: 200, headers: {}, data: 'OK' };
      }),
    };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await fenced('https://merchant.example/p', {
      validateStatus: () => true,
      headers: { Accept: 'text/html', Authorization: 'Bearer SECRET', Cookie: 'sid=abc' },
    });
    expect(seen[0].headers.Authorization).toBe('Bearer SECRET');
    expect(seen[1].headers.Authorization).toBeUndefined();
    expect(seen[1].headers.Cookie).toBeUndefined();
    // ...and the non-credential headers survive the hop.
    expect(seen[1].headers.Accept).toBe('text/html');
  });

  test('a same-origin hop keeps the headers untouched', async () => {
    const seen = [];
    const instance = {
      get: jest.fn(async (url, config) => {
        seen.push(config.headers);
        if (url === 'https://merchant.example/a') {
          return { status: 302, headers: { location: 'https://merchant.example/b' }, data: '' };
        }
        return { status: 200, headers: {}, data: 'OK' };
      }),
    };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await fenced('https://merchant.example/a', {
      validateStatus: () => true,
      headers: { Authorization: 'Bearer SECRET' },
    });
    expect(seen[1].Authorization).toBe('Bearer SECRET');
  });

  test('a redirect-shape refusal is NOT reported on the address-refusal dial', () => {
    // routes.js maps `pivota_ssrf*` to `url_forbidden_address`, the dial that counts refused ADDRESSES.
    // A merchant redirect loop and a 3xx with no Location are ordinary upstream misbehaviour; naming
    // them PIVOTA_SSRF_* would have poisoned the signal this PR added with every looping storefront.
    expect('PIVOTA_URL_REDIRECT_CAP'.startsWith('PIVOTA_SSRF')).toBe(false);
    expect('PIVOTA_URL_REDIRECT_NO_LOCATION'.startsWith('PIVOTA_SSRF')).toBe(false);
  });

  test('the whole-chain deadline fires even when DNS never answers', async () => {
    /*
     * `maxRedirects: 0` drops axios off follow-redirects, whose timer is wall-clock, onto the raw
     * node:https path where `timeout` is a SOCKET timeout that never fires if no socket is assigned.
     * Measured: with maxRedirects:0 and a hanging lookup, axios NEVER rejects. In CI (no outbound
     * network) that turned a 17 s passing suite into 30 s timeouts. An AbortSignal is not socket-bound.
     */
    const instance = {
      defaults: {},
      get: jest.fn((url, config) => new Promise((resolve, reject) => {
        // Never settles on its own — exactly like a lookup that never calls back.
        config.signal.addEventListener('abort', () => {
          const err = new Error('canceled'); err.code = 'ERR_CANCELED'; reject(err);
        }, { once: true });
      })),
    };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    const started = Date.now();
    await expect(fenced('https://cosrx.com/p', { timeout: 300, validateStatus: () => true }))
      // Reported as a TIMEOUT so buildUrlFetchFailureCode still yields `url_fetch_timeout`; an
      // ERR_CANCELED would have reclassified every timeout on this lane as a generic failure.
      .rejects.toThrow(expect.objectContaining({ code: 'ECONNABORTED' }));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  function capture() {
    const calls = [];
    return {
      calls,
      instance: { get: jest.fn(async (url, config) => { calls.push({ url, config }); return { status: 200, headers: {}, data: 'OK' }; }) },
    };
  }

  test('axios never follows redirects itself, and never uses an env proxy', async () => {
    // Both are load-bearing. axios's own follower would re-dial a `Location: http://127.0.0.1` through
    // the pinned agent but NEVER re-run the literal check, because an IP literal skips DNS entirely and
    // the resolver is the only fence it would meet. And a proxy would carry the request on a socket the
    // agent never opened, bypassing the resolver outright. (The jest setup strips proxy env vars, so the
    // only way to pin `proxy: false` is on the config actually handed to axios.)
    const { instance, calls } = capture();
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await fenced('https://cosrx.com/p', { validateStatus: () => true });
    expect(calls[0].config.maxRedirects).toBe(0);
    expect(calls[0].config.proxy).toBe(false);
    expect(calls[0].config.httpAgent).toBeDefined();
    expect(calls[0].config.httpsAgent).toBeDefined();
  });

  test('the caller\'s decoded-byte cap, body type and headers are passed through untouched', async () => {
    /*
     * This is the regression the sibling PR hit and this lane must not: swapping to a node:https
     * transport would have dropped gzip negotiation and replaced axios's DECODED-byte
     * `maxContentLength` with a 2 MiB WIRE cap. Measured 2026-09-04, the lane's own 900,000-byte cap
     * already rejects the ulta search page, the cosrx PDP and the anua PDP against the UNMODIFIED code;
     * a wire cap would have silently admitted all three, changing which pages parse. Keeping axios is
     * what preserves that, and this pins that the config still arrives intact.
     */
    const { instance, calls } = capture();
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await fenced('https://cosrx.com/p', {
      timeout: 4500,
      maxContentLength: 900000,
      maxBodyLength: 900000,
      responseType: 'text',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      validateStatus: () => true,
    });
    expect(calls[0].config.maxContentLength).toBe(900000);
    expect(calls[0].config.maxBodyLength).toBe(900000);
    expect(calls[0].config.responseType).toBe('text');
    expect(calls[0].config.timeout).toBe(4500);
    expect(calls[0].config.headers).toEqual({ Accept: 'text/html,application/xhtml+xml' });
    // No accept-encoding override: axios negotiates gzip itself and decodes it, which is why this lane
    // did not need the manual zlib inflate its sibling had to add.
    expect(Object.keys(calls[0].config.headers).map((k) => k.toLowerCase())).not.toContain('accept-encoding');
  });

  test('the pinned agents INHERIT the configured keep-alive options, and add only the lookup', async () => {
    /*
     * Pinning an agent per request REPLACES `axios.defaults.httpAgent/httpsAgent`, which server.js sets
     * to keep-alive agents with `maxSockets: 128`. Bare agents here would have restored Node's default
     * of Infinity on a lane any `X-Aurora-UID` can drive, and dropped connection reuse on a 1200 ms
     * click path. So the configured options must survive with `lookup` added on top.
     */
    const configured = {
      defaults: {
        httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 128, maxFreeSockets: 32, scheduling: 'lifo' }),
        httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 128, maxFreeSockets: 32, scheduling: 'lifo' }),
      },
      get: jest.fn(async () => ({ status: 200, headers: {}, data: 'OK' })),
    };
    const calls = [];
    configured.get = jest.fn(async (url, config) => { calls.push(config); return { status: 200, headers: {}, data: 'OK' }; });
    const fenced = createPublicUrlFetch({ axiosInstance: configured });
    await fenced('https://cosrx.com/p', { validateStatus: () => true });
    for (const key of ['httpAgent', 'httpsAgent']) {
      expect(calls[0][key].options.maxSockets).toBe(128);
      expect(calls[0][key].options.keepAlive).toBe(true);
      expect(calls[0][key].options.maxFreeSockets).toBe(32);
      // ...and the fence is still the thing that decides where a socket may go.
      expect(typeof calls[0][key].options.lookup).toBe('function');
    }
    // A DIFFERENT object from the configured agent: the lookup must not be bolted onto the shared one.
    expect(calls[0].httpsAgent).not.toBe(configured.defaults.httpsAgent);
  });

  test('an unparseable redirect Location is refused with a coded error, not a bare TypeError', async () => {
    // The sink lowercases `err.code` into its attempt telemetry, so a bare ERR_INVALID_URL would report
    // as `err_invalid_url` while every other guard in this module reports `pivota_ssrf_*`.
    const instance = { get: jest.fn(async () => ({ status: 302, headers: { location: 'http://[bad' }, data: '' })) };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await expect(fenced('https://cosrx.com/p', { validateStatus: () => true }))
      .rejects.toThrow(expect.objectContaining({ code: 'PIVOTA_SSRF_INVALID_URL' }));
  });

  test('the caller\'s validateStatus still decides the final response, and throws axios-shaped', async () => {
    // The sink reads `err.response.status` and `err.code` to build its attempt telemetry, so a rejected
    // status must fail the way axios itself fails or the telemetry silently changes shape.
    const instance = { get: jest.fn(async () => ({ status: 503, headers: {}, data: 'nope' })) };
    const fenced = createPublicUrlFetch({ axiosInstance: instance });
    await expect(fenced('https://cosrx.com/p', { validateStatus: (s) => s >= 200 && s < 500 }))
      .rejects.toThrow(expect.objectContaining({ code: 'ERR_BAD_RESPONSE' }));

    const ok = { get: jest.fn(async () => ({ status: 404, headers: {}, data: 'missing' })) };
    const fenced2 = createPublicUrlFetch({ axiosInstance: ok });
    // 404 is INSIDE the lane's accepted band, so it must come back as a response, not an exception —
    // the lane inspects 4xx bodies for bot-challenge pages.
    const res = await fenced2('https://cosrx.com/p', { validateStatus: (s) => s >= 200 && s < 500 });
    expect(res.status).toBe(404);
  });
});
