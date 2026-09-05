'use strict';

const { EventEmitter } = require('node:events');
const nodeHttps = require('node:https');
const {
  createPublicOnlyLookup,
  createPublicNetworkFetch,
  createUcpBuyerAgentClient,
  isForbiddenNetworkAddress,
  toFetchResponse,
  MAX_MERCHANT_RESPONSE_BYTES,
} = require('../src/services/ucpBuyerAgentClient');

test.each([
  '127.0.0.1', '10.0.0.9', '169.254.169.254', '172.16.0.1',
  '192.168.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
  '::127.0.0.1', '::7f00:1', 'fe81::1', 'ff02::1',
  '240.0.0.1', '255.255.255.255',
])('forbids non-public address %s', (address) => {
  expect(isForbiddenNetworkAddress(address)).toBe(true);
});

test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permits public address %s', (address) => {
  expect(isForbiddenNetworkAddress(address)).toBe(false);
});

test('DNS lookup rejects a mixed public/private answer to prevent rebinding fallback', (done) => {
  const lookup = createPublicOnlyLookup((_host, _opts, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]));
  lookup('merchant.example', {}, (error) => {
    expect(error).toBeInstanceOf(Error);
    done();
  });
});

test('literal private storefront is rejected before an injected fetch is called', async () => {
  const fetchImpl = jest.fn();
  const client = createUcpBuyerAgentClient({ forceAnonymous: true, fetchImpl });
  await expect(client.discoverEndpoint('https://127.0.0.1')).rejects.toThrow('public address');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('DNS lookup answers autoSelectFamily {all: true} with an array of records', (done) => {
  const lookup = createPublicOnlyLookup((_host, _opts, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]));
  lookup('merchant.example', { all: true }, (error, addresses) => {
    expect(error).toBeNull();
    expect(addresses).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    done();
  });
});

test('DNS lookup still rejects a mixed public/private answer under {all: true}', (done) => {
  const lookup = createPublicOnlyLookup((_host, _opts, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.9', family: 4 },
  ]));
  lookup('merchant.example', { all: true }, (error, addresses) => {
    expect(error).toBeInstanceOf(Error);
    expect(addresses).toBeUndefined();
    done();
  });
});

test('legacy two-argument lookup call still gets the single-address shape', (done) => {
  const lookup = createPublicOnlyLookup((_host, _opts, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 },
  ]));
  lookup('merchant.example', (error, address, family) => {
    expect(error).toBeNull();
    expect(address).toBe('8.8.8.8');
    expect(family).toBe(4);
    done();
  });
});

test.each([204, 205, 304])('null-body status %s maps to a bodyless Response instead of throwing', (status) => {
  const res = toFetchResponse(status, { etag: '"abc"' }, Buffer.alloc(0));
  expect(res.status).toBe(status);
  expect(res.body).toBeNull();
});

test('a 1xx merchant response rejects with a clear error instead of a RangeError crash', () => {
  expect(() => toFetchResponse(101, {}, Buffer.alloc(0)))
    .toThrow('unsupported status 101');
});

test('a plain 200 keeps the buffered body', async () => {
  const res = toFetchResponse(200, { 'content-type': 'application/json' }, Buffer.from('{"ok":true}'));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ ok: true });
});

test('a merchant response beyond the 2MB cap destroys the request and rejects', async () => {
  const spy = jest.spyOn(nodeHttps, 'request').mockImplementation((_url, _opts, onResponse) => {
    const request = new EventEmitter();
    request.write = jest.fn();
    request.destroy = jest.fn((err) => { if (err) request.emit('error', err); });
    request.end = jest.fn(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      process.nextTick(() => {
        onResponse(response);
        const chunk = Buffer.alloc(1024 * 1024);
        response.emit('data', chunk);
        response.emit('data', chunk);
        response.emit('data', Buffer.alloc(1)); // 2MB + 1 byte
      });
    });
    return request;
  });
  try {
    const fetchImpl = createPublicNetworkFetch((_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]));
    await expect(fetchImpl('https://merchant.example/')).rejects.toThrow('size cap');
    const req = spy.mock.results[0].value;
    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(MAX_MERCHANT_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  } finally {
    spy.mockRestore();
  }
});

describe('single-address lookup shape has no fallback, so the family matters', () => {
  // Node uses this shape only when autoSelectFamily is OFF (older runtime,
  // --no-network-family-autoselection, net.setDefaultAutoSelectFamily(false)).
  // There is no second attempt on it: whichever record comes back decides the
  // request. `verbatim: true` keeps resolver order, commonly AAAA first — and
  // the store-audit crawl subnet has no IPv6 route at all (a v6 connect there
  // answers ENETUNREACH, measured 2026-09-04), so returning the AAAA would fail
  // every dual-stack merchant outright the moment that flag changes.
  test('a dual-stack answer returns the IPv4 record, not the resolver-first AAAA', (done) => {
    const lookup = createPublicOnlyLookup((_h, _o, cb) => cb(null, [
      { address: '2620:127:f00f:e::', family: 6 },
      { address: '23.227.38.74', family: 4 },
    ]));
    lookup('merchant.example', {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('23.227.38.74');
      expect(family).toBe(4);
      done();
    });
  });

  test('a v6-only answer still returns v6 rather than nothing', (done) => {
    // Filtering to a family that is not there would turn a reachable
    // merchant into a resolution failure, which is worse than the hazard.
    const lookup = createPublicOnlyLookup((_h, _o, cb) => cb(null, [
      { address: '2606:4700:4700::1111', family: 6 },
    ]));
    lookup('merchant.example', {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('2606:4700:4700::1111');
      expect(family).toBe(6);
      done();
    });
  });

  test('the {all: true} shape is untouched and still returns every record in order', (done) => {
    // Happy Eyeballs owns the ordering on that path; preferring a family there
    // would override the interleaving Node does deliberately.
    const lookup = createPublicOnlyLookup((_h, _o, cb) => cb(null, [
      { address: '2620:127:f00f:e::', family: 6 },
      { address: '23.227.38.74', family: 4 },
    ]));
    lookup('merchant.example', { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([
        { address: '2620:127:f00f:e::', family: 6 },
        { address: '23.227.38.74', family: 4 },
      ]);
      done();
    });
  });

  test('a mixed public/private answer is still refused in the single shape', (done) => {
    // The SSRF fence must not be weakened by the family preference: picking the
    // public v4 out of a mixed answer is exactly the fallback the guard exists
    // to stop.
    // PUBLIC v4 + PRIVATE v6 on purpose. The earlier fixture had it the other
    // way round, so the family preference selected the private record and any
    // single-record check would have refused it — the test passed without
    // exercising the hazard it names. This ordering is the one where a guard
    // that only checked the PREFERRED record would wave the answer through.
    const lookup = createPublicOnlyLookup((_h, _o, cb) => cb(null, [
      { address: '23.227.38.74', family: 4 },
      { address: 'fc00::1', family: 6 },
    ]));
    lookup('merchant.example', {}, (error, address) => {
      expect(error).toBeInstanceOf(Error);
      expect(address).toBeUndefined();
      done();
    });
  });
});

describe('in-house refusals carry a code, so the probe can tell them apart', () => {
  // The probe records a throw as `profile_unreachable:threw=<code>`. Without a
  // code every refusal this module raises collapses into threw=unknown —
  // indistinguishable from each other and from an opaque failure, which is the
  // same ambiguity the qualifier was added to remove. Asserted against the REAL
  // producer: a hand-built error with the code set proves only that the test
  // author knows the string.
  test('the DNS-time SSRF refusal is coded', (done) => {
    const lookup = createPublicOnlyLookup((_h, _o, cb) => cb(null, [
      { address: '10.0.0.9', family: 4 },
    ]));
    lookup('merchant.example', {}, (error) => {
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('PIVOTA_SSRF_REFUSED');
      done();
    });
  });

  test('the same refusal under {all: true} is coded identically', (done) => {
    const lookup = createPublicOnlyLookup((_h, _o, cb) => cb(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]));
    lookup('merchant.example', { all: true }, (error) => {
      expect(error.code).toBe('PIVOTA_SSRF_REFUSED');
      done();
    });
  });

  test('a literal private storefront is coded distinctly from the DNS refusal', async () => {
    // Two different refusals with two different fixes: one is the merchant's
    // DNS, the other is the URL we were handed. Sharing a code would merge them
    // back together in the stored reason.
    const client = createUcpBuyerAgentClient({ forceAnonymous: true });
    await expect(client.discoverEndpoint('https://127.0.0.1')).rejects.toMatchObject({
      code: 'PIVOTA_SSRF_LITERAL',
    });
  });
});
