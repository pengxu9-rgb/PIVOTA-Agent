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
  resolveBusinessSigningKeys, toPublicSigningJwk,
} from '../src/protocol/ucpProfile.js';
import { UCP_SPEC_VERSION } from '../src/protocol/ucpSpecVersion.cjs';

// A structurally valid PUBLIC P-256 JWK (coordinates are dummy base64url — shape tests only).
const PUBLIC_JWK = Object.freeze({
  kty: 'EC', crv: 'P-256', x: 'eF9kdW1teV9jb29yZA', y: 'eV9kdW1teV9jb29yZA', kid: 'k1',
});

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
    signingKeys: [PUBLIC_JWK],
  });
  assert.match(profile.ucp.version, /^\d{4}-\d{2}-\d{2}$/);
  // The advertised version is the SHARED pin, never a literal of this module's own — the buyer-agent
  // profile reads the same constant, so the two roles cannot negotiate different spec lines. (They did:
  // this profile advertised the 2026-01-23 line while the buyer pinned, and #1962's tool vocabulary came
  // from, the 2026-04-08 line.) mcp-server/test/ucpSpecVersion.test.js pins both sides together.
  assert.equal(profile.ucp.version, UCP_SPEC_VERSION);
  // Mid-man rule: Pivota is NEVER merchant-of-record — the profile must say so
  // and state its actual role (the merchant settles on their own rails).
  assert.equal(profile.provider.merchant_of_record, false);
  assert.equal(profile.provider.role, 'commerce_index_passthrough');
  // capability ids are the dev.ucp.* names
  // `capabilities` is a MAP keyed by id — the spec's shape, and a live conformant business profile's.
  const capIds = Object.keys(profile.ucp.capabilities);
  assert.ok(capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(capIds.includes('dev.ucp.common.identity_linking'));
  assert.ok(capIds.includes('dev.ucp.shopping.order'));
  // Each entry carries the REQUIRED members. `operations`/`title` are NOT spec members and are gone.
  const checkout = profile.ucp.capabilities['dev.ucp.shopping.checkout'][0];
  assert.equal(checkout.version, UCP_SPEC_VERSION);
  assert.equal(checkout.spec, 'https://ucp.dev/2026-04-08/specification/checkout');
  assert.equal(checkout.schema, 'https://ucp.dev/2026-04-08/schemas/shopping/checkout.json');
  assert.equal(checkout.operations, undefined, 'operations is not a spec member');
  assert.equal(checkout.title, undefined, 'title is not a spec member');
  // payment_handlers is a MAP keyed by handler id, not an array.
  assert.ok(!Array.isArray(profile.ucp.payment_handlers));
  assert.ok(Array.isArray(profile.ucp.payment_handlers.stripe_spt));
  // TRANSPORTS ARE OPT-IN. No restBasePath was passed, so NO `rest` transport is advertised: the profile
  // must never point a platform at a door that does not speak UCP wire shapes. (It previously defaulted a
  // rest entry on unconditionally, and the gateway handed it the ACP base path — so UCP discovery advertised
  // the ACP door, which speaks ACP bodies. A platform following it failed on the first call.)
  // `services` is a MAP keyed by service id, each value an array of transport bindings.
  const transports = profile.ucp.services['dev.ucp.shopping'].map((s) => s.transport);
  assert.deepEqual(transports.sort(), ['mcp']);

  // ...and it IS advertised when a real UCP-REST door is declared.
  const withRest = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    restBasePath: '/ucp/v1',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
  });
  assert.deepEqual(withRest.ucp.services['dev.ucp.shopping'].map((s) => s.transport).sort(), ['mcp', 'rest']);
  assert.equal(
    withRest.ucp.services['dev.ucp.shopping'].find((s) => s.transport === 'rest').endpoint,
    'https://shop.pivota.cc/ucp/v1',
  );

  // A blank path is not a declared door: `restBasePath !== undefined` would advertise
  // `https://shop.pivota.cc` as a UCP REST endpoint (review finding on #1962).
  const blankRest = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    restBasePath: '   ',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
  });
  assert.deepEqual(blankRest.ucp.services['dev.ucp.shopping'].map((s) => s.transport), ['mcp']);
  assert.deepEqual(profile.ucp.payment_handlers, { stripe_spt: [{ id: 'stripe_spt', psp: 'stripe', pci: false }] });
  assert.equal(profile.ucp.signing_keys.length, 1);
  assert.equal(profile.ucp.signing_keys[0].kid, 'k1');
});

test('business signing keys: env-sourced, validated, and NEVER private', () => {
  // Env accepts a single JWK object or a JSON array of JWKs.
  const single = resolveBusinessSigningKeys({ env: { UCP_BUSINESS_SIGNING_PUBLIC_JWK: JSON.stringify(PUBLIC_JWK) } });
  assert.equal(single.length, 1);
  assert.equal(single[0].kid, 'k1');
  const asArray = resolveBusinessSigningKeys({ env: { UCP_BUSINESS_SIGNING_PUBLIC_JWK: JSON.stringify([PUBLIC_JWK]) } });
  assert.equal(asArray.length, 1);
  // Absent/blank env -> [] (current behavior preserved).
  assert.deepEqual(resolveBusinessSigningKeys({ env: {} }), []);
  assert.deepEqual(resolveBusinessSigningKeys({ env: { UCP_BUSINESS_SIGNING_PUBLIC_JWK: '  ' } }), []);
  // Unparseable env throws (a silently-empty profile would mask a rotation typo).
  assert.throws(
    () => resolveBusinessSigningKeys({ env: { UCP_BUSINESS_SIGNING_PUBLIC_JWK: '{not json' } }),
    /not valid JSON/,
  );
  // A key carrying private material ("d") is REFUSED loudly — never published.
  assert.throws(
    () => resolveBusinessSigningKeys({ env: { UCP_BUSINESS_SIGNING_PUBLIC_JWK: JSON.stringify({ ...PUBLIC_JWK, d: 'secret' }) } }),
    /private material/,
  );
  assert.throws(() => buildUcpProfile({ baseUrl: 'https://x', signingKeys: [{ ...PUBLIC_JWK, d: 'secret' }] }), /private material/);
  // Wrong curve/type/missing coordinates are dropped, not published.
  assert.deepEqual(resolveBusinessSigningKeys({ signingKeys: [{ kty: 'EC', crv: 'P-384', x: 'x', y: 'y' }] }), []);
  assert.deepEqual(resolveBusinessSigningKeys({ signingKeys: [{ kty: 'RSA', n: 'n', e: 'e' }] }), []);
  assert.deepEqual(resolveBusinessSigningKeys({ signingKeys: [{ kty: 'EC', crv: 'P-256', x: 'x' }] }), []);
  // A kid-less key gets the house default kid (pivota-order-1) so it stays addressable by verifiers.
  const noKid = toPublicSigningJwk({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' });
  assert.equal(noKid.kid, 'pivota-order-1');
  // `use` is republished only when it is a string; anything else collapses to 'sig'.
  assert.equal(toPublicSigningJwk({ ...PUBLIC_JWK, use: { odd: true } }).use, 'sig');
});

test('omitCapabilityIds withholds a capability (and its operations) from the profile', () => {
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    omitCapabilityIds: ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.ap2_mandate'],
  });
  const capIds = Object.keys(profile.ucp.capabilities);
  assert.ok(!capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(!capIds.includes('dev.ucp.shopping.ap2_mandate'));
  assert.ok(capIds.includes('dev.ucp.shopping.catalog.search'), 'non-omitted capabilities remain');
  const allOps = [];  // operations are no longer published; the withholding is asserted by id below
  assert.ok(!allOps.includes('create_payment_link'), 'operations of an omitted capability vanish with it');
  assert.ok(!allOps.includes('complete_checkout_session'));
  // The intersection can never resurrect an omitted capability.
  assert.deepEqual(activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout']), {});
  // Omitting nothing is the identity.
  const full = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', omitCapabilityIds: [] });
  assert.ok(Object.keys(full.ucp.capabilities).includes('dev.ucp.shopping.checkout'));
});

test('UCP profile requires an https baseUrl and rejects unknown advertised capabilities', () => {
  assert.throws(() => buildUcpProfile({ baseUrl: 'http://insecure' }), /must be https/);
  assert.throws(() => buildUcpProfile({}), /baseUrl is required/);
  assert.throws(() => buildUcpProfile({ baseUrl: 'https://x', capabilities: ['not_a_capability'] }), /unknown capability/);
});

test('activeCapabilityIntersection returns only capabilities both sides support', () => {
  const profile = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' });
  const active = activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout', 'dev.ucp.some.future.thing']);
  // A MAP of id -> [{version}], per the spec's "Capability Declaration in Responses".
  assert.deepEqual(Object.keys(active), ['dev.ucp.shopping.checkout']);
  assert.deepEqual(active['dev.ucp.shopping.checkout'], [{ version: UCP_SPEC_VERSION }]);
  assert.deepEqual(activeCapabilityIntersection(profile, []), {});

  // Step 3 of the intersection algorithm: an extension whose parents are all absent is PRUNED, so a platform
  // is never told a modifier is active while what it modifies is not.
  assert.deepEqual(Object.keys(activeCapabilityIntersection(profile, ['dev.ucp.shopping.fulfillment'])), []);
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(profile, ['dev.ucp.shopping.fulfillment', 'dev.ucp.shopping.checkout'])).sort(),
    ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.fulfillment'],
  );
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
  const bindings = profileOut.body.ucp.services['dev.ucp.shopping'];
  assert.equal(bindings.find((s) => s.transport === 'rest').endpoint, 'https://shop.pivota.cc/acp');
  assert.equal(bindings.find((s) => s.transport === 'mcp').endpoint, 'https://shop.pivota.cc/mcp');

  const activeOut = await active.handler({
    body: { capabilities: ['dev.ucp.shopping.checkout', 'dev.ucp.some.future.thing'] },
  });
  assert.equal(activeOut.status, 200);
  // The response is the spec's shape: `{ ucp: { version, capabilities: { id: [{version}] } } }`. It used to
  // answer `{ ucp_version, active_capabilities: [...] }` — neither key exists in the spec.
  assert.equal(activeOut.body.ucp.version, UCP_SPEC_VERSION);
  assert.deepEqual(Object.keys(activeOut.body.ucp.capabilities), ['dev.ucp.shopping.checkout']);
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
      headers: { 'ucp-agent-capabilities': 'dev.ucp.shopping.catalog.search, dev.ucp.shopping.checkout' },
    }),
    ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.checkout'],
  );
});

// ---- the advertised capability ids must exist in the UCP vocabulary ----------------------------------------
//
// `dev.ucp.shopping.discovery` was advertised here for the life of this file and exists nowhere in the spec.
// Negotiation is a set INTERSECTION, so it matched no platform and our five discovery operations were
// invisible to every caller — silently, because a profile that advertises a fiction still parses.
//
// The list below is the SPEC's, transcribed from ucp.dev/2026-04-08 (specification/overview + /catalog). It is
// deliberately NOT derived from CANONICAL_CAPABILITIES: the tests that let the wrong id survive asserted our
// own constant back at itself, which can never fail. A vendor id is allowed only under a reverse-DNS
// namespace we actually own, which is the spec's own escape hatch for non-standard capabilities.
test('every advertised capability id is a real UCP id, or a vendor id under a domain we own', () => {
  const SPEC_CAPABILITY_IDS = [
    'dev.ucp.shopping.catalog.search',
    'dev.ucp.shopping.catalog.lookup',
    'dev.ucp.shopping.cart',
    'dev.ucp.shopping.checkout',
    'dev.ucp.shopping.discount',
    'dev.ucp.shopping.fulfillment',
    'dev.ucp.shopping.order',
    'dev.ucp.shopping.ap2_mandate',
    'dev.ucp.common.identity_linking',
  ];
  // Reverse-DNS of pivota.cc — the domain this gateway serves from. The spec's example of a vendor
  // capability is `com.example.installments`; Shopify publishes `dev.shopify.catalog` the same way.
  const VENDOR_PREFIX = 'cc.pivota.';

  for (const [key, cap] of Object.entries(CANONICAL_CAPABILITIES)) {
    const known = SPEC_CAPABILITY_IDS.includes(cap.ucp);
    const vendor = cap.ucp.startsWith(VENDOR_PREFIX);
    assert.ok(known || vendor, `${key} advertises "${cap.ucp}", which is neither a spec id nor ours to mint`);
    // A vendor id must NOT squat the standard namespace — that is how a fiction gets mistaken for a standard.
    if (vendor) assert.ok(!cap.ucp.startsWith('dev.ucp.'), `${key} mints an id inside the spec's namespace`);
  }
});

test('the three discovery operations are split by what each id actually promises', () => {
  // The spec defines `.search` as "Search for products using query text and filters" and `.lookup` as
  // "Retrieve products or variants by identifier". Pivota's alternatives/offers/intel are neither: they are
  // its own decision layer, so they live under the vendor id rather than being advertised as something a
  // platform can expect from a standard catalog capability.
  assert.deepEqual(operationsForCapability('catalog_search', { includeRefusalOnly: false }), ['search_catalog']);
  assert.deepEqual(operationsForCapability('catalog_lookup', { includeRefusalOnly: false }), ['get_product']);
  assert.deepEqual(
    operationsForCapability('insights', { includeRefusalOnly: false }).sort(),
    ['get_alternatives', 'get_intel', 'get_offers'],
  );
  // and no operation was lost or duplicated in the split
  const all = ['catalog_search', 'catalog_lookup', 'insights']
    .flatMap((c) => operationsForCapability(c, { includeRefusalOnly: false }));
  assert.equal(new Set(all).size, all.length, 'an operation must not appear under two capabilities');
  assert.deepEqual(all.sort(), ['get_alternatives', 'get_intel', 'get_offers', 'get_product', 'search_catalog']);
});

test('the vendor capability is a ROOT capability — `extends` would make it prunable', () => {
  // `extends` is a pruning key: intersection step 3 removes any capability whose declared parents are all
  // absent. Declaring these reads as extending catalog.lookup would delete Pivota's whole decision layer for
  // a platform that does not negotiate that standard capability — and they do not need it.
  assert.equal(CANONICAL_CAPABILITIES.insights.extends, undefined);
  assert.equal(CANONICAL_CAPABILITIES.catalog_search.extends, undefined);
  assert.equal(CANONICAL_CAPABILITIES.catalog_lookup.extends, undefined);
});
