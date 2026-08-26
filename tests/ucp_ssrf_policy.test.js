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
