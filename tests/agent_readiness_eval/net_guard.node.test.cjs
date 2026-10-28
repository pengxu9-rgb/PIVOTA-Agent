'use strict';

// FIRST: no test in this directory may reach a non-loopback host (see _net_guard.cjs).
require('./_net_guard.cjs');

// The guard itself. Every probe here aims at a documentation-only address (RFC 5737 TEST-NET ranges) or an
// RFC 6761 `.invalid` name, so even a broken guard could not reach a real service; a working guard refuses
// each one before a socket or a resolver is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');

const { state, isLoopbackLiteral, throwingFetch } = require('./_net_guard.cjs');

const GUARD_CODE = 'ERR_READINESS_NET_GUARD';

/** The guarded call either throws synchronously or fails asynchronously; both must carry the guard's code. */
async function expectRefused(label, fn) {
  const before = state.blocked.length;
  const connectsBefore = state.originalConnectCalls;
  let code = null;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') await out;
    else if (out && typeof out.on === 'function') {
      await new Promise((resolve, reject) => {
        out.on('error', reject);
        out.on('connect', () => reject(new Error('connected')));
        out.on('response', () => reject(new Error('responded')));
        setTimeout(resolve, 500);
      });
    }
  } catch (err) {
    code = err.code || (err.cause && err.cause.code) || null;
  }
  assert.equal(code, GUARD_CODE, `${label}: expected the guard to refuse`);
  assert.equal(state.blocked.length, before + 1, `${label}: one refusal recorded`);
  assert.equal(state.originalConnectCalls, connectsBefore, `${label}: the real connect was never reached`);
}

test('fetch (undici) to a name and to a non-loopback literal is refused before any connect or lookup', async () => {
  await expectRefused('fetch name', () => fetch('http://guard-check.invalid/'));
  await expectRefused('fetch https name', () => fetch('https://guard-check.invalid/'));
  await expectRefused('fetch literal', () => fetch('http://192.0.2.1:8080/'));
  await expectRefused('fetch ipv6 literal', () => fetch('http://[2001:db8::1]:8080/'));
});

test('http.request / https.request are refused', async () => {
  await expectRefused('http.request', () => http.request({ host: '198.51.100.1', port: 9, path: '/', agent: false }).end());
  await expectRefused('https.request', () => https.request('https://guard-check.invalid/').end());
  await expectRefused('http.get name', () => http.get('http://guard-check.invalid/'));
});

test('net.connect / tls.connect are refused, including the implicit "localhost" default', async () => {
  await expectRefused('net.connect', () => net.connect({ host: '203.0.113.1', port: 9 }));
  await expectRefused('net.connect(port, host)', () => net.connect(9, '203.0.113.2'));
  await expectRefused('net.connect no host', () => net.connect(9));
  await expectRefused('tls.connect', () => tls.connect({ host: 'guard-check.invalid', port: 443 }));
  await expectRefused('new Socket().connect', () => new net.Socket().connect(9, 'guard-check.invalid'));
});

test('DNS resolution is refused for every name', async () => {
  await expectRefused('dns.lookup', () => dns.lookup('guard-check.invalid', () => {}));
  await expectRefused('dns.resolve4', () => dns.resolve4('guard-check.invalid', () => {}));
  await expectRefused('dns.promises.lookup', () => dns.promises.lookup('guard-check.invalid'));
  await expectRefused('Resolver', () => new dns.Resolver().resolve4('guard-check.invalid', () => {}));
});

test('UDP to a non-loopback address is refused', async () => {
  const sock = dgram.createSocket('udp4');
  try {
    await expectRefused('dgram.send', () => sock.send(Buffer.from('x'), 9, '192.0.2.1'));
  } finally {
    sock.close();
  }
});

test('loopback IP literals are allowed (that is how the stub and local-gateway tests run)', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const before = state.originalConnectCalls;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await res.text(), 'ok');
    assert.equal(state.originalConnectCalls, before + 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
  for (const h of ['127.0.0.1', '127.5.6.7', '::1', '[::1]', '::ffff:127.0.0.1']) assert.equal(isLoopbackLiteral(h), true, h);
  for (const h of ['localhost', '0.0.0.0', '10.0.0.1', '192.0.2.1', '::', '2001:db8::1', 'guard-check.invalid', '127.0.0.1.nip.io', '']) {
    assert.equal(isLoopbackLiteral(h), false, h);
  }
});

test('throwingFetch counts and throws on any call', async () => {
  const f = throwingFetch();
  await assert.rejects(() => f('http://127.0.0.1:1/'), /must not be called/);
  assert.deepEqual(f.calls, ['http://127.0.0.1:1/']);
});

test('every eval test file installs the guard as its first statement', () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.node.test.cjs'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('//'));
    assert.equal(code[0], "'use strict';", f);
    assert.equal(code[1], "require('./_net_guard.cjs');", `${f}: the guard must be the first require`);
  }
});

test('one guard per process, its state never on globalThis (jest shares the patched prototype across test files)', () => {
  // A second load (a jest worker loads the module once per test file) finds the installed guard: the same
  // state, and net.Socket.prototype.connect is not wrapped again.
  const guardPath = require.resolve('./_net_guard.cjs');
  const routingGuardPath = require.resolve('../search_routing_net_guard.cjs');
  const connectBefore = net.Socket.prototype.connect;
  delete require.cache[guardPath];
  const again = require('./_net_guard.cjs');
  assert.equal(again.state, state);
  assert.equal(net.Socket.prototype.connect, connectBefore);
  // The search-routing guard has the same shape.
  const routing = require('../search_routing_net_guard.cjs');
  const connectWithRouting = net.Socket.prototype.connect;
  delete require.cache[routingGuardPath];
  const routingAgain = require('../search_routing_net_guard.cjs');
  assert.equal(routingAgain.state, routing.state);
  assert.equal(net.Socket.prototype.connect, connectWithRouting);
  // Nothing either guard keeps is reachable from globalThis, where jest's teardown of a test file's
  // sandbox would turn it into a self-recursing setter for every later socket in the worker.
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    let value;
    try {
      value = globalThis[key];
    } catch (_) {
      continue;
    }
    assert.notEqual(value, state, `globalThis.${key} holds the readiness guard state`);
    assert.notEqual(value, routing.state, `globalThis.${key} holds the search-routing guard state`);
  }
  assert.equal(globalThis.__READINESS_NET_GUARD__, undefined);
  assert.equal(globalThis.__SEARCH_ROUTING_NET_GUARD__, undefined);
  // Counting still works through the shared state.
  const passed = state.passed;
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const socket = net.connect(server.address().port, '127.0.0.1', () => {
        socket.destroy();
        server.close();
        try {
          assert.ok(state.passed > passed);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      socket.on('error', reject);
    });
  });
});
