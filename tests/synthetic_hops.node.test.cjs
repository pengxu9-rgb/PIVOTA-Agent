'use strict';

// THE SYNTHETIC HOP LINE (src/guardrails/syntheticHops.js): every outgoing HTTP request a synthetic call makes
// logs one line, whatever client makes it, and nothing is logged outside a synthetic call. Only loopback
// sockets are opened here.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');

const { INVOKE_AUTH_CONTEXT } = require('../src/guardrails/syntheticContext');
const diagnosticsChannel = require('node:diagnostics_channel');
const { hopFields, backendHosts, installSyntheticHopLog, BACKEND_BASE_ENVS, DEFAULT_PIVOTA_API_BASE } = require('../src/guardrails/syntheticHops');

const SYN = { synthetic: true, synthetic_caller: 'iss|mcpc_eval', gw_request_id: 'gw-hop-1' };
const hop = (origin, path, headers = {}, method = 'GET') => ({
  method,
  origin,
  path,
  hasHeader: (name) => Object.keys(headers).some((k) => k.toLowerCase() === name),
});

test('hopFields: nothing outside a synthetic call, or for a real one', () => {
  assert.equal(hopFields(hop('https://backend.test', '/x')), null);
  assert.equal(INVOKE_AUTH_CONTEXT.run({ synthetic: false }, () => hopFields(hop('https://backend.test', '/x'))), null);
  assert.equal(INVOKE_AUTH_CONTEXT.run({ synthetic: 'true' }, () => hopFields(hop('https://backend.test', '/x'))), null);
});

test('hopFields: a backend hop says whether the assertion is attached; a loopback hop, the loopback marker', () => {
  const env = { PIVOTA_API_BASE: 'https://backend.test' };
  const at = (h) => INVOKE_AUTH_CONTEXT.run(SYN, () => hopFields(h, { env }));
  assert.deepEqual(at(hop('https://backend.test', '/agent/shop/v1/invoke?k=secret', { 'X-Pivota-Synthetic-Assertion': 'v1.a.b' }, 'post')), {
    gateway_request_id: 'gw-hop-1',
    target: 'backend',
    method: 'POST',
    host: 'backend.test',
    path: '/agent/shop/v1/invoke',
    marker: 'attached',
  });
  assert.equal(at(hop('https://backend.test', '/x')).marker, 'missing');
  // The loopback marker does not count for the backend, nor the assertion for the loopback.
  assert.equal(at(hop('https://backend.test', '/x', { 'X-Pivota-Loopback-Synthetic': 'sv1.a.b' })).marker, 'missing');
  assert.equal(at(hop('http://127.0.0.1:3000', '/agent/shop/v1/invoke', { 'X-Pivota-Loopback-Synthetic': 'sv1.a.b' })).marker, 'attached');
  assert.equal(at(hop('http://127.0.0.1:3000', '/x', { 'X-Pivota-Synthetic-Assertion': 'v1.a.b' })).marker, 'missing');
  for (const h of ['http://localhost:3000', 'http://[::1]:3000']) assert.equal(at(hop(h, '/x')).target, 'loopback', h);
});

test('hopFields: an external hop names its host only, never a path or query, and has no marker', () => {
  const f = INVOKE_AUTH_CONTEXT.run(SYN, () => hopFields(hop('https://llm.example.test', '/v1/models/x:generate?key=SECRET'), { env: {} }));
  assert.deepEqual(f, { gateway_request_id: 'gw-hop-1', target: 'external', method: 'GET', host: 'llm.example.test', path: null, marker: null });
});

test('backendHosts: every backend base variable, comma lists, and a port is honoured when given', () => {
  assert.ok(BACKEND_BASE_ENVS.includes('PIVOTA_API_BASE') && BACKEND_BASE_ENVS.includes('AURORA_BFF_RECO_BACKEND_BASE_URLS'));
  const env = { PIVOTA_API_BASE: 'https://api.test', AURORA_BFF_RECO_BACKEND_BASE_URLS: 'https://a.test, http://127.0.0.1:5000', REVIEWS_BACKEND: 'nope' };
  const hosts = backendHosts(env);
  for (const h of ['api.test', 'a.test', '127.0.0.1:5000']) assert.ok(hosts.has(h), h);
  assert.equal(hosts.has('127.0.0.1'), false, 'a base with a port does not claim the host on every port');
  const at = (origin) => INVOKE_AUTH_CONTEXT.run(SYN, () => hopFields(hop(origin, '/x'), { env }).target);
  assert.equal(at('https://api.test:8443'), 'backend', 'no port in the base: any port');
  assert.equal(at('http://127.0.0.1:5000'), 'backend', 'a backend on a loopback port is the backend');
  assert.equal(at('http://127.0.0.1:5001'), 'loopback');
});

// Every client this process uses, over a real loopback socket, inside and outside a synthetic call.
test('every HTTP client logs a hop inside a synthetic call, and none outside one', async (t) => {
  const server = http.createServer((req, res) => res.end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const savedApiBase = process.env.PIVOTA_API_BASE;
  process.env.PIVOTA_API_BASE = base;
  t.after(() => {
    if (savedApiBase === undefined) delete process.env.PIVOTA_API_BASE;
    else process.env.PIVOTA_API_BASE = savedApiBase;
  });
  const logged = [];
  const handle = installSyntheticHopLog({ log: { info: (fields, msg) => logged.push({ msg, ...fields }) } });
  t.after(() => handle.uninstall());

  const signed = { 'X-Pivota-Synthetic-Assertion': 'v1.body.mac' };
  const clients = {
    'http.request': (headers) =>
      new Promise((resolve, reject) => {
        const req = http.request(`${base}/h`, { method: 'POST', headers }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end('{}');
      }),
    'http.get': (headers) => new Promise((resolve, reject) => http.get(`${base}/g`, { headers }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject)),
    axios: (headers) => axios.get(`${base}/a`, { headers, proxy: false }),
    'axios.create': (headers) => axios.create({ baseURL: base, proxy: false }).post('/c', { a: 1 }, { headers }),
    fetch: (headers) => fetch(`${base}/f`, { method: 'POST', headers, body: '{}' }).then((r) => r.text()),
  };
  for (const [name, send] of Object.entries(clients)) {
    logged.length = 0;
    await INVOKE_AUTH_CONTEXT.run(SYN, () => send(signed));
    await INVOKE_AUTH_CONTEXT.run(SYN, () => send({}));
    assert.deepEqual(logged.map((l) => [l.msg, l.target, l.marker, l.gateway_request_id]), [
      ['synthetic_hop', 'backend', 'attached', 'gw-hop-1'],
      ['synthetic_hop', 'backend', 'missing', 'gw-hop-1'],
    ], name);
    logged.length = 0;
    await send(signed);
    await INVOKE_AUTH_CONTEXT.run({ synthetic: false }, () => send(signed));
    assert.deepEqual(logged, [], `${name}: nothing outside a synthetic call`);
  }
});

test('a hop line that cannot be written never fails the request; installing twice subscribes once', async (t) => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let calls = 0;
  const handle = installSyntheticHopLog({ log: { info: () => { calls += 1; throw new Error('log sink down'); } } });
  t.after(() => handle.uninstall());
  assert.equal(installSyntheticHopLog({ log: { info: () => { throw new Error('second'); } } }), handle);
  const body = await INVOKE_AUTH_CONTEXT.run(SYN, () => fetch(`http://127.0.0.1:${server.address().port}/`).then((r) => r.text()));
  assert.equal(body, 'ok');
  assert.equal(calls, 1, 'one subscriber, and it was asked');
});

test('backendHosts: lists split like the routes do, a trailing dot is the same host, unset PIVOTA_API_BASE is its default', () => {
  assert.ok(BACKEND_BASE_ENVS.includes('AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS'));
  const hosts = backendHosts({ AURORA_BFF_RECO_BACKEND_BASE_URLS: 'https://a.test;https://b.test | https://c.test\nhttps://d.test.', REVIEWS_API_BASE: '' });
  for (const h of ['a.test', 'b.test', 'c.test', 'd.test']) assert.ok(hosts.has(h), h);
  assert.equal(DEFAULT_PIVOTA_API_BASE, 'http://localhost:8080');
  assert.ok(hosts.has('localhost:8080'), 'the code default when PIVOTA_API_BASE is unset');
  assert.equal(backendHosts({ PIVOTA_API_BASE: 'https://api.test' }).has('localhost:8080'), false, 'only when unset');
  const at = (origin, env) => INVOKE_AUTH_CONTEXT.run(SYN, () => hopFields(hop(origin, '/x'), { env }).target);
  assert.equal(at('https://api.test./x', { PIVOTA_API_BASE: 'https://api.test' }), 'backend', 'a trailing dot on the request');
  assert.equal(at('https://api.test', { PIVOTA_API_BASE: 'https://API.test.' }), 'backend', 'and on the base');
  assert.equal(at('http://localhost:8080', {}), 'backend');
});

test('backendHosts is memoised on the variables\' values', () => {
  const env = { PIVOTA_API_BASE: 'https://m1.test' };
  const first = backendHosts(env);
  assert.equal(backendHosts({ ...env }), first, 'same values: the same set, not recomputed');
  const changed = backendHosts({ PIVOTA_API_BASE: 'https://m2.test' });
  assert.notEqual(changed, first);
  assert.ok(changed.has('m2.test') && !changed.has('m1.test'));
});

test('undici headers are read only as the flat array Node hands over; anything else is no header', () => {
  const at = (headers) => INVOKE_AUTH_CONTEXT.run(SYN, () => {
    const logged = [];
    const handle = installSyntheticHopLog({ log: { info: (f) => logged.push(f) }, env: { PIVOTA_API_BASE: 'https://api.test' } });
    try {
      diagnosticsChannel.channel('undici:request:create').publish({ request: { method: 'POST', origin: 'https://api.test', path: '/x', headers } });
    } finally {
      handle.uninstall();
    }
    return logged.map((f) => f.marker);
  });
  assert.deepEqual(at(['x-pivota-synthetic-assertion', 'v1.a.b', 'accept', '*/*']), ['attached']);
  assert.deepEqual(at(['accept', '*/*']), ['missing']);
  assert.deepEqual(at('x-pivota-synthetic-assertion: v1.a.b\r\n'), ['missing'], 'a string is not read');
  assert.deepEqual(at({ 'x-pivota-synthetic-assertion': 'v1.a.b' }), ['missing'], 'nor an object');
});

test('a real request is not touched: the subscribers back out on the store before reading anything', () => {
  let touched = 0;
  const spy = new Proxy({}, { get: () => { touched += 1; return undefined; }, has: () => { touched += 1; return false; } });
  const handle = installSyntheticHopLog({ log: { info: () => {} } });
  try {
    for (const name of ['http.client.request.start', 'undici:request:create']) {
      diagnosticsChannel.channel(name).publish({ request: spy });
      INVOKE_AUTH_CONTEXT.run({ synthetic: false }, () => diagnosticsChannel.channel(name).publish({ request: spy }));
    }
    assert.equal(touched, 0, 'outside a synthetic call, the request object is never read');
    INVOKE_AUTH_CONTEXT.run(SYN, () => diagnosticsChannel.channel('undici:request:create').publish({ request: spy }));
    assert.ok(touched > 0, 'inside one, it is');
  } finally {
    handle.uninstall();
  }
});

test('a request object that throws never escapes the subscriber (it would be an uncaughtException)', async () => {
  const hostile = new Proxy({}, { get: () => { throw new Error('hostile request'); } });
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  const handle = installSyntheticHopLog({ log: { info: () => {} } });
  try {
    for (const name of ['http.client.request.start', 'undici:request:create']) {
      INVOKE_AUTH_CONTEXT.run(SYN, () => diagnosticsChannel.channel(name).publish({ request: hostile }));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaught, []);
  } finally {
    handle.uninstall();
    process.off('uncaughtException', onUncaught);
  }
});
