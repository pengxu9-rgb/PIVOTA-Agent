'use strict';

// THE SYNTHETIC HOP LINE (src/guardrails/syntheticHops.js): every outgoing HTTP request a synthetic call makes
// logs one line, whatever client makes it, and nothing is logged outside a synthetic call. Only loopback
// sockets are opened here.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');

const { INVOKE_AUTH_CONTEXT } = require('../src/guardrails/syntheticContext');
const { hopFields, backendHosts, installSyntheticHopLog, BACKEND_BASE_ENVS } = require('../src/guardrails/syntheticHops');

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
