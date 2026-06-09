// Canonical contract + UCP profile tests — the protocol-edge foundation (one canonical contract; UCP
// discovery). All adapters (UCP/ACP/MCP) normalize into the canonical operations, which bind to the kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_CAPABILITIES, CANONICAL_OPERATIONS, canonicalOp, operationsForCapability,
  MUTATING_OPERATIONS, USER_SCOPED_OPERATIONS, PAYMENT_AUTHZ_OPERATIONS,
} from '../src/protocol/canonicalContract.js';
import {
  buildUcpProfile, activeCapabilityIntersection,
  createUcpRouteHandlers, parsePlatformCapabilities,
} from '../src/protocol/ucpProfile.js';

test('every canonical operation references a real capability + has the required fields', () => {
  for (const op of CANONICAL_OPERATIONS) {
    assert.ok(CANONICAL_CAPABILITIES[op.capability], `${op.id} → unknown capability ${op.capability}`);
    assert.equal(typeof op.id, 'string');
    assert.equal(typeof op.mutating, 'boolean');
    assert.equal(typeof op.requiresUserRef, 'boolean');
    assert.equal(typeof op.requiresPaymentAuthz, 'boolean');
    assert.ok('kernel' in op);
  }
});

test('canonicalOp throws on an unknown operation (adapters can never route an unknown op)', () => {
  assert.equal(canonicalOp('create_checkout_session').capability, 'checkout');
  assert.throws(() => canonicalOp('definitely_not_an_op'), /unknown canonical operation/);
});

test('safety flags are correct: complete needs user_ref + payment authz + is mutating; reads need neither', () => {
  const complete = canonicalOp('complete_checkout_session');
  assert.equal(complete.mutating, true);
  assert.equal(complete.requiresUserRef, true);
  assert.equal(complete.requiresPaymentAuthz, true);
  assert.equal(complete.kernel, 'create_order+mint_confirmation+submit_payment');

  for (const readId of ['search_catalog', 'get_product']) {
    const r = canonicalOp(readId);
    assert.equal(r.mutating, false);
    assert.equal(r.requiresUserRef, false);
    assert.equal(r.requiresPaymentAuthz, false);
  }
  // only complete requires payment authorization (the delegated-token / AP2-mandate gate)
  assert.deepEqual(PAYMENT_AUTHZ_OPERATIONS, ['complete_checkout_session']);
  // mutating ops are exactly the writes
  assert.deepEqual([...MUTATING_OPERATIONS].sort(), ['cancel_checkout_session', 'complete_checkout_session', 'create_checkout_session', 'create_payment_link', 'request_after_sales', 'update_checkout_session'].sort());
  // get_order is user-scoped (closes the L3 leak at the contract level)
  assert.ok(USER_SCOPED_OPERATIONS.includes('get_order'));
});

test('operationsForCapability groups the checkout lifecycle', () => {
  assert.deepEqual(operationsForCapability('checkout').sort(), [
    'cancel_checkout_session', 'complete_checkout_session', 'create_checkout_session',
    'create_payment_link', 'get_checkout_session', 'update_checkout_session',
  ].sort());
});

test('UCP profile: version, services, capabilities (dev.ucp.*), payment_handlers, signing_keys', () => {
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
    paymentHandlers: [{ id: 'stripe_spt', psp: 'stripe', pci: false }],
    signingKeys: [{ kid: 'k1', kty: 'EC' }],
  });
  assert.match(profile.ucp_version, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(profile.provider.merchant_of_record, true);
  // capability ids are the dev.ucp.* names
  const capIds = profile.capabilities.map((c) => c.id);
  assert.ok(capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(capIds.includes('dev.ucp.common.identity_linking'));
  assert.ok(capIds.includes('dev.ucp.shopping.order'));
  // each capability lists its canonical operations
  const checkout = profile.capabilities.find((c) => c.id === 'dev.ucp.shopping.checkout');
  assert.ok(checkout.operations.includes('complete_checkout_session'));
  // services include rest + mcp
  const transports = profile.services.map((s) => s.transport);
  assert.deepEqual(transports.sort(), ['mcp', 'rest']);
  assert.deepEqual(profile.payment_handlers, [{ id: 'stripe_spt', psp: 'stripe', pci: false }]);
  assert.equal(profile.signing_keys.length, 1);
});

test('UCP profile requires an https baseUrl and rejects unknown advertised capabilities', () => {
  assert.throws(() => buildUcpProfile({ baseUrl: 'http://insecure' }), /must be https/);
  assert.throws(() => buildUcpProfile({}), /baseUrl is required/);
  assert.throws(() => buildUcpProfile({ baseUrl: 'https://x', capabilities: ['not_a_capability'] }), /unknown capability/);
});

test('activeCapabilityIntersection returns only capabilities both sides support', () => {
  const profile = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' });
  const active = activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout', 'dev.ucp.some.future.thing']);
  assert.deepEqual(active.map((c) => c.id), ['dev.ucp.shopping.checkout']);
  assert.deepEqual(activeCapabilityIntersection(profile, []), []);
});

test('UCP routes expose /.well-known/ucp and active capability intersection', async () => {
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    restBasePath: '/acp',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
  });
  const routes = createUcpRouteHandlers(profile);
  const wellKnown = routes.find((r) => r.method === 'GET' && r.path === '/.well-known/ucp');
  const active = routes.find((r) => r.method === 'POST' && r.path === '/ucp/capabilities');

  const profileOut = await wellKnown.handler();
  assert.equal(profileOut.status, 200);
  assert.equal(profileOut.body.services.find((s) => s.transport === 'rest').endpoint, 'https://shop.pivota.cc/acp');
  assert.equal(profileOut.body.services.find((s) => s.transport === 'mcp').endpoint, 'https://shop.pivota.cc/mcp');

  const activeOut = await active.handler({
    body: { capabilities: ['dev.ucp.shopping.checkout', 'dev.ucp.some.future.thing'] },
  });
  assert.equal(activeOut.status, 200);
  assert.deepEqual(activeOut.body.active_capabilities.map((c) => c.id), ['dev.ucp.shopping.checkout']);
});

test('UCP platform capability parser accepts JSON UCP-Agent and comma-separated capability headers', () => {
  assert.deepEqual(
    parsePlatformCapabilities({
      headers: { 'ucp-agent': JSON.stringify({ capabilities: ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.order'] }) },
    }),
    ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.order'],
  );
  assert.deepEqual(
    parsePlatformCapabilities({
      headers: { 'ucp-agent-capabilities': 'dev.ucp.shopping.discovery, dev.ucp.shopping.checkout' },
    }),
    ['dev.ucp.shopping.discovery', 'dev.ucp.shopping.checkout'],
  );
});
