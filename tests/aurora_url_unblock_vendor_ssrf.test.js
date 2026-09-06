'use strict';

/*
 * The UNBLOCK VENDOR is the one path in the product-URL lane where OUR socket is never opened.
 *
 * `fetchViaZenRows` hands `productUrl` to api.zenrows.com as a query PARAMETER and the vendor fetches it
 * from its own network, so the pinned transport in publicUrlFetch.js — and every guard inside it — is not
 * on this code path at all. Ungated, that is a paid account that will fetch an arbitrary caller-named
 * URL, including one resolving into private space on the vendor's side.
 *
 * REACHABILITY, stated precisely: `shouldTryUnblockVendor` fires only on a `challenge_type` or a
 * 403/406/429, and an address refusal carries neither (verified live in production:
 * `attempts: [{error_code: 'pivota_ssrf_refused'}]`, no status). So with the DEFAULT
 * AURORA_BFF_URL_UNBLOCK_ONLY_ON_BLOCKED=true the vendor already does not run for a refused address —
 * these tests therefore set it to 'false', which is the configuration the gap actually lives in. That is
 * not a contrived setting: URL_UNBLOCK_ENABLED defaults true and the provider defaults to zenrows, so a
 * single env flag is all that stands between the deployed default and an open vendor door.
 *
 * WHAT IS ASSERTED: not "the promise rejected", but that the vendor was never ASKED — no request to
 * api.zenrows.com was built. The url the vendor would have been given is the payload, so the only
 * meaningful observation is whether it was handed over.
 */

const ENV_KEYS = [
  'AURORA_BFF_URL_UNBLOCK_ENABLED',
  'AURORA_BFF_URL_UNBLOCK_PROVIDER',
  'AURORA_BFF_URL_UNBLOCK_ONLY_ON_BLOCKED',
  'AURORA_BFF_URL_UNBLOCK_ZENROWS_API_KEY',
  'ZENROWS_API_KEY',
];

/**
 * routes.js reads these flags at MODULE LOAD into consts, so the env must be set before the require and
 * the module registry reset per case. `process.env` is per jest WORKER, not per file, so the previous
 * values are restored in afterEach rather than left for whatever runs next in this worker.
 */
function loadLaneWithVendorEnabled(overrides = {}) {
  jest.resetModules();
  process.env.AURORA_BFF_URL_UNBLOCK_ENABLED = 'true';
  process.env.AURORA_BFF_URL_UNBLOCK_PROVIDER = 'zenrows';
  // The configuration the gap lives in: the vendor runs on ANY failure, not only a "blocked" one.
  process.env.AURORA_BFF_URL_UNBLOCK_ONLY_ON_BLOCKED = 'false';
  process.env.AURORA_BFF_URL_UNBLOCK_ZENROWS_API_KEY = 'test-key-not-a-real-credential';
  Object.assign(process.env, overrides);
  /*
   * THE AXIOS INSTANCE MUST COME FROM AFTER THE RESET, and this is not a detail. `jest.resetModules()`
   * clears the registry, so the `require('axios')` inside routes.js returns a DIFFERENT module object
   * than one required at the top of this file. Spying on the file-level instance watches an object the
   * lane never touches: every `expect(zenrowsCalls()).toHaveLength(0)` then passes trivially, against a
   * fixed build AND against main. That is exactly what the first draft of this file did — five green
   * negatives proving nothing. The spy is installed on the instance the lane actually resolved.
   */
  // eslint-disable-next-line global-require
  const axiosInstance = require('axios');
  // eslint-disable-next-line global-require
  const lane = require('../src/auroraBff/routes').__internal;
  return { lane, axiosInstance };
}

describe('the unblock vendor is never handed a non-public URL', () => {
  let saved;
  let getSpy;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    if (getSpy) getSpy.mockRestore();
    getSpy = null;
    // `process.env` is per jest WORKER, not per file, so these must be put back or they leak into
    // whatever this worker runs next.
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.resetModules();
  });

  /** Spy the instance the LANE resolved, then hand back its lane. See loadLaneWithVendorEnabled. */
  function armLane(overrides) {
    const { lane, axiosInstance } = loadLaneWithVendorEnabled(overrides);
    getSpy = jest.spyOn(axiosInstance, 'get');
    return lane;
  }

  const zenrowsCalls = () => getSpy.mock.calls.filter(([url]) => String(url).includes('api.zenrows.com'));

  /*
   * NOTE ON WHAT THESE FOUR PROVE. They pass on unfixed main and pass with BOTH new guards deleted —
   * they are held up by the `parsePublicHttpUrl(urlText)` input gate shipped in #2144, not by anything
   * in this change. They are kept as coverage of the vendor door for literal forms, but they are NOT
   * evidence for this PR; the tests that are appear below.
   */
  test.each([
    ['an IP literal (refused before any attempt runs)', 'http://127.0.0.1:8080/admin'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['an RFC1918 address', 'http://192.168.1.1/'],
    ['a bracketed IPv6 loopback', 'http://[::1]:8080/x'],
  ])('%s is never proxied through the vendor', async (_label, productUrl) => {
    const { fetchProductHtmlWithUnblockChain } = armLane();
    const out = await fetchProductHtmlWithUnblockChain({ productUrl, timeoutMs: 3000 });

    expect(out.ok).toBe(false);
    // THE assertion: our paid account was never asked to fetch it.
    expect(zenrowsCalls()).toHaveLength(0);
    expect(out.used_unblock_vendor).toBe(false);
    expect(out.failure_code).toBe('url_forbidden_address');
  });

  test('a HOSTNAME whose DNS answer is private is never proxied through the vendor', async () => {
    /*
     * The case the early literal gate CANNOT see, and the reason this needed a second guard rather than
     * a tightened first one: `localhost` parses as a perfectly ordinary hostname. On main it survives the
     * gate, fails the three direct attempts at the resolver, and is then handed to the vendor.
     */
    const { fetchProductHtmlWithUnblockChain } = armLane();
    const out = await fetchProductHtmlWithUnblockChain({
      productUrl: 'http://localhost:8080/admin',
      timeoutMs: 3000,
    });

    expect(out.ok).toBe(false);
    expect(zenrowsCalls()).toHaveLength(0);
    expect(out.used_unblock_vendor).toBe(false);
    // The refusal is recorded, so an operator can see the vendor was withheld and why.
    expect(out.attempts.some((a) => String(a.error_code || '').startsWith('pivota_ssrf'))).toBe(true);
  });

  test('the EVIDENCE guard alone: an ssrf-refused attempt withholds the vendor even when the host now resolves public', async () => {
    /*
     * ISOLATES GUARD (a). Both guards independently close this door, so each masks the other under
     * mutation — dropping either one left all six tests green, and only dropping BOTH failed. A comment
     * claiming "a test kills each separately" has to be made true rather than asserted.
     *
     * This is the case only guard (a) can catch, and it is a real one rather than a contrivance: DNS
     * REBINDING between the direct attempt and the vendor precheck. The attempt is refused at the
     * resolver (private answer), then the precheck resolves the same name and gets a PUBLIC answer.
     * Guard (b) is satisfied and would hand the URL to the vendor; guard (a) refuses on what we actually
     * observed. cosrx.com is used precisely because it really does resolve public, so the precheck
     * genuinely passes here.
     */
    const { fetchProductHtmlWithUnblockChain } = armLane();
    getSpy.mockImplementation(async (url) => {
      if (String(url).includes('api.zenrows.com')) {
        return { status: 200, headers: {}, data: '<html>via vendor</html>' };
      }
      const err = new Error('merchant endpoint resolved to a non-public address');
      err.code = 'PIVOTA_SSRF_REFUSED';
      throw err;
    });

    const out = await fetchProductHtmlWithUnblockChain({
      productUrl: 'https://cosrx.com/products/some-product',
      timeoutMs: 3000,
    });

    expect(out.attempts.some((a) => String(a.error_code || '').startsWith('pivota_ssrf'))).toBe(true);
    expect(zenrowsCalls()).toHaveLength(0);
    expect(out.used_unblock_vendor).toBe(false);
  });

  test('the PRECHECK guard alone: a private host is withheld even when no attempt recorded an ssrf refusal', async () => {
    /*
     * ISOLATES GUARD (b) *as wired into the lane*. The unit tests below pin `createPublicHostCheck`
     * itself, but nothing there proves this function ever calls it — and guard (a) masks it in every
     * other lane case, so deleting the precheck block left all fifteen tests green.
     *
     * The case only the precheck can catch is a private host that produced NO ssrf evidence. Here the
     * direct attempts are made to fail for an UNRELATED reason (ECONNRESET) so `fenceRefusedAddress` is
     * false, while the URL still resolves to loopback. That models the real gap this guard exists for:
     * the direct loop can be skipped entirely when the deadline breaks it before the first attempt, and
     * then there is no evidence to read.
     */
    const { fetchProductHtmlWithUnblockChain } = armLane();
    getSpy.mockImplementation(async (url) => {
      if (String(url).includes('api.zenrows.com')) {
        return { status: 200, headers: {}, data: '<html>via vendor</html>' };
      }
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    });

    const out = await fetchProductHtmlWithUnblockChain({
      productUrl: 'http://localhost:8080/admin',
      timeoutMs: 3000,
    });

    // No ssrf evidence exists among the DIRECT attempts, so guard (a) cannot be what refuses this.
    // The precheck's own record is excluded deliberately: it writes `pivota_ssrf_refused` itself, which
    // would otherwise make this assertion describe the guard under test rather than its input.
    const directAttempts = out.attempts.filter((a) => a.strategy !== 'vendor_precheck');
    expect(directAttempts.length).toBeGreaterThan(0);
    expect(directAttempts.some((a) => String(a.error_code || '').startsWith('pivota_ssrf'))).toBe(false);
    // ...and the vendor still never saw it.
    expect(zenrowsCalls()).toHaveLength(0);
    expect(out.used_unblock_vendor).toBe(false);
    // The precheck records WHY it withheld the vendor.
    expect(out.attempts.some((a) => a.strategy === 'vendor_precheck')).toBe(true);
  });

  test('F1: the vendor is sent the NORMALISED url, not the raw string we validated', async () => {
    /*
     * Validating one string and transmitting another. Our own fetches go out normalised, but the vendor
     * was handed the caller's raw input, and the two can disagree about the HOST:
     *   Node WHATWG : http://cosrx.com\@127.0.0.1/  ->  host cosrx.com  (backslash = path delimiter)
     *   Python urllib: same bytes                    ->  host 127.0.0.1
     * We do not control the vendor's parser. The only safe string to send is the one we judged.
     */
    const { fetchProductHtmlWithUnblockChain } = armLane();
    getSpy.mockImplementation(async (url) => {
      if (String(url).includes('api.zenrows.com')) {
        return { status: 200, headers: {}, data: '<html>via vendor</html>' };
      }
      const err = new Error('blocked'); err.code = 'ECONNRESET'; throw err;
    });

    await fetchProductHtmlWithUnblockChain({
      productUrl: 'http://cosrx.com\\@127.0.0.1/',
      timeoutMs: 3000,
    });

    expect(zenrowsCalls().length).toBeGreaterThan(0);
    const sent = zenrowsCalls()[0][1].params.url;
    // The host must be unambiguous in the string the vendor receives.
    expect(sent).toBe('http://cosrx.com/@127.0.0.1/');
    expect(sent).not.toContain('\\');
  });

  test('F4: a refusal on the www HOST VARIANT does not withhold the vendor for a public canonical url', async () => {
    /*
     * The evidence guard must reason about the url the VENDOR will get, not about a different host that
     * happened to be tried. A merchant whose `www.` label CNAMEs into private space would otherwise lose
     * the fallback for a perfectly public canonical URL — safe direction, but a silent feature loss.
     */
    const { fetchProductHtmlWithUnblockChain } = armLane();
    getSpy.mockImplementation(async (url) => {
      if (String(url).includes('api.zenrows.com')) {
        return { status: 200, headers: {}, data: '<html>via vendor</html>' };
      }
      if (String(url).includes('www.cosrx.com')) {
        const bad = new Error('resolved to a non-public address');
        bad.code = 'PIVOTA_SSRF_REFUSED';
        throw bad;
      }
      const err = new Error('blocked'); err.code = 'ECONNRESET'; throw err;
    });

    const out = await fetchProductHtmlWithUnblockChain({
      productUrl: 'https://cosrx.com/products/x',
      timeoutMs: 3000,
      allowHostVariant: true,
    });

    // The variant WAS refused...
    expect(out.attempts.some((a) => String(a.error_code || '') === 'pivota_ssrf_refused')).toBe(true);
    // ...and the vendor still ran for the canonical url, which is public.
    expect(zenrowsCalls().length).toBeGreaterThan(0);
    expect(zenrowsCalls()[0][1].params.url).toBe('https://cosrx.com/products/x');
  });

  test('F2: an address refusal outranks a preceding 403 on the failure_code dial', async () => {
    /*
     * In the DEFAULT config the precheck is only reachable AFTER a 403/406/429 — that is what lets the
     * vendor run at all — so a status-first `buildUrlFetchFailureCode` reported `url_fetch_forbidden_403`
     * and the `url_forbidden_address` dial stayed silent for exactly the case this PR added.
     */
    const { fetchProductHtmlWithUnblockChain } = armLane({
      AURORA_BFF_URL_UNBLOCK_ONLY_ON_BLOCKED: 'true',
    });
    getSpy.mockImplementation(async (url) => {
      if (String(url).includes('api.zenrows.com')) {
        return { status: 200, headers: {}, data: '<html>via vendor</html>' };
      }
      return { status: 403, headers: {}, data: 'forbidden' };
    });

    const out = await fetchProductHtmlWithUnblockChain({
      productUrl: 'http://localhost:8080/admin',
      timeoutMs: 3000,
    });

    expect(zenrowsCalls()).toHaveLength(0);
    expect(out.attempts.some((a) => a.strategy === 'vendor_precheck')).toBe(true);
    expect(out.failure_code).toBe('url_forbidden_address');
  });

  test('POSITIVE CONTROL: a public host that merely fails IS still escalated to the vendor', async () => {
    /*
     * Without this the suite is satisfied by a build that simply never calls the vendor, which would
     * "pass" while deleting a shipped feature. A public hostname that fails for an ordinary reason must
     * still reach zenrows — the gate discriminates on ADDRESS, not on failure.
     */
    const { fetchProductHtmlWithUnblockChain } = armLane();
    getSpy.mockImplementation(async (url) => {
      if (String(url).includes('api.zenrows.com')) {
        return { status: 200, headers: {}, data: '<html>via vendor</html>' };
      }
      const err = new Error('blocked'); err.code = 'ECONNRESET';
      throw err;
    });

    const out = await fetchProductHtmlWithUnblockChain({
      productUrl: 'https://cosrx.com/products/some-product',
      timeoutMs: 3000,
    });

    expect(zenrowsCalls().length).toBeGreaterThan(0);
    // ...and the vendor's url parameter is the caller's public URL, unchanged.
    expect(zenrowsCalls()[0][1].params.url).toBe('https://cosrx.com/products/some-product');
    expect(out.ok).toBe(true);
    expect(out.used_unblock_vendor).toBe(true);
  });
});


describe('createPublicHostCheck is the vendor-side address rule (isolates guard (b))', () => {
  /*
   * ISOLATES GUARD (b). In the lane, guard (a) masks this one under mutation, so the check is pinned
   * directly. A mutant that makes it answer `ok: true` on a resolver error survives every lane test and
   * dies here.
   */
  const { createPublicHostCheck } = require('../src/services/publicUrlFetch');

  test.each([
    ['an IPv4 literal', 'http://127.0.0.1:8080/x', 'PIVOTA_SSRF_LITERAL'],
    ['the metadata address', 'http://169.254.169.254/', 'PIVOTA_SSRF_LITERAL'],
    ['an IPv6 literal', 'http://[::1]/x', 'PIVOTA_SSRF_LITERAL'],
    ['a non-http scheme', 'file:///etc/passwd', 'PIVOTA_SSRF_SCHEME'],
    ['userinfo', 'https://u:p@cosrx.com/x', 'PIVOTA_SSRF_USERINFO'],
  ])('refuses %s before any resolution', async (_label, url, code) => {
    await expect(createPublicHostCheck()(url)).resolves.toEqual({ ok: false, code, reason: 'address_refused', url: null });
  });

  test('refuses a hostname whose DNS answer is private', async () => {
    const check = createPublicHostCheck();
    await expect(check('http://localhost:8080/x')).resolves.toEqual({
      ok: false, code: 'PIVOTA_SSRF_REFUSED', reason: 'address_refused', url: null,
    });
  });

  test('refuses a MIXED public+private answer, not just an all-private one', async () => {
    // The bypass a naive "is the first record public?" check waves through. The rule lives in
    // createPublicOnlyLookup and is reused here rather than restated, so this pins that reuse.
    const mixed = (hostname, options, cb) => cb(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(createPublicHostCheck(mixed)('http://mixed.example/x')).resolves.toEqual({
      ok: false, code: 'PIVOTA_SSRF_REFUSED', reason: 'address_refused', url: null,
    });
  });

  test('an UNRESOLVABLE host is allowed through — a DNS failure is not evidence of a private address', async () => {
    /*
     * This distinction is load-bearing and I got it wrong first: the check originally treated ANY
     * resolver error as a refusal, which deleted the unblock vendor for every host our resolver cannot
     * see. An existing suite caught it — `escalates to zenrows when native attempts are blocked` uses
     * the fixture host `blocked.example`, which does not resolve at all — and a transient DNS blip would
     * have disabled the fallback fleet-wide.
     *
     * Failing open here is bounded: the vendor fetches from ITS network, so an unresolvable name cannot
     * reach OUR private space through this path. Our own egress stays fenced by createPublicUrlFetch.
     */
    const nxdomain = (hostname, options, cb) => {
      const err = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      cb(err);
    };
    await expect(createPublicHostCheck(nxdomain)('https://blocked.example/product')).resolves.toEqual({
      ok: true, code: null, reason: 'unresolved', url: 'https://blocked.example/product',
    });
  });

  test('a definite private answer is still refused, and says so distinctly', async () => {
    // The counterpart to the above: the two outcomes must stay DISTINGUISHABLE, or the fix that made
    // unresolvable hosts pass would also have made private ones pass.
    const priv = (hostname, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await expect(createPublicHostCheck(priv)('https://evil.example/x')).resolves.toEqual({
      ok: false, code: 'PIVOTA_SSRF_REFUSED', reason: 'address_refused', url: null,
    });
  });

  test('POSITIVE COUNTERPART: an all-public answer is allowed', async () => {
    const publicOnly = (hostname, options, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
    await expect(createPublicHostCheck(publicOnly)('https://cosrx.com/x')).resolves.toEqual({
      ok: true, code: null, reason: 'public', url: 'https://cosrx.com/x',
    });
  });
});
