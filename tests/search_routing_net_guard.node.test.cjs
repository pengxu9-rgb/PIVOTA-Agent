'use strict';

// FIRST: the guard under test, so nothing below can reach a non-loopback host.
const netGuard = require('./search_routing_net_guard.cjs');

// The guard stays installed for every later file a jest worker runs. server.listen(port, '::') runs
// dns.lookup('::') inside node, so a guard that refused it broke a later file that binds '::' (a listener
// that has to see both v4 and v6 dials) depending only on which shard put the two files together. Every
// probe here aims at a documentation-only address (RFC 5737 / RFC 3849) or an RFC 6761 `.invalid` name.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dns = require('node:dns');

const GUARD_CODE = 'ERR_SEARCH_ROUTING_NET_GUARD';
const { state } = netGuard;

/** The guarded call throws synchronously or fails asynchronously; either way it carries the guard's code. */
async function expectRefused(label, fn) {
  const before = state.blocked.length;
  const connectsBefore = state.originalConnectCalls;
  let code = null;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') await out;
  } catch (err) {
    code = err.code || (err.cause && err.cause.code) || null;
  }
  assert.equal(code, GUARD_CODE, `${label}: expected the guard to refuse`);
  assert.equal(state.blocked.length, before + 1, `${label}: one refusal recorded`);
  assert.equal(state.originalConnectCalls, connectsBefore, `${label}: the real connect was never reached`);
}

test('a server can bind the unspecified addresses', async () => {
  for (const host of ['::', '0.0.0.0']) {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    assert.ok(server.address().port > 0, host);
    await new Promise((r) => server.close(r));
  }
});

test('a lookup of an IP literal passes; a dial to a non-loopback literal is still refused', async () => {
  const blockedBefore = state.blocked.length;
  for (const literal of ['::', '0.0.0.0', '192.0.2.1', '2001:db8::1']) {
    const address = await new Promise((resolve, reject) => {
      dns.lookup(literal, (err, addr) => (err ? reject(err) : resolve(addr)));
    });
    assert.equal(address, literal);
    assert.equal((await dns.promises.lookup(literal)).address, literal);
  }
  assert.equal(state.blocked.length, blockedBefore, 'no refusal for a literal lookup');
  await expectRefused('net.connect to 192.0.2.1', () => net.connect({ host: '192.0.2.1', port: 9 }));
  await expectRefused('net.connect to [2001:db8::1]', () => net.connect({ host: '2001:db8::1', port: 9 }));
  await expectRefused('net.connect to ::', () => net.connect({ host: '::', port: 9 }));
});

test('names, reverse lookups, lookupService and resolve* stay refused', async () => {
  await expectRefused('dns.lookup of a name', () => dns.lookup('guard-check.invalid', () => {}));
  await expectRefused('dns.lookup of localhost', () => dns.lookup('localhost', () => {}));
  await expectRefused('dns.promises.lookup of a name', () => dns.promises.lookup('guard-check.invalid'));
  await expectRefused('dns.reverse of a literal', () => dns.reverse('192.0.2.1', () => {}));
  await expectRefused('dns.lookupService of a literal', () => dns.lookupService('192.0.2.1', 9, () => {}));
  await expectRefused('dns.resolve4 of a literal', () => dns.resolve4('192.0.2.1', () => {}));
  await expectRefused('dns.promises.resolve4 of a name', () => dns.promises.resolve4('guard-check.invalid'));
  await expectRefused('Resolver.resolve4 of a name', () => new dns.Resolver().resolve4('guard-check.invalid', () => {}));
});
