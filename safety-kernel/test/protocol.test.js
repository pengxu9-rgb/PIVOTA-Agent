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
  assert.match(profile.ucp_version, /^\d{4}-\d{2}-\d{2}$/);
  // The advertised version is the SHARED pin, never a literal of this module's own — the buyer-agent
  // profile reads the same constant, so the two roles cannot negotiate different spec lines. (They did:
  // this profile advertised the 2026-01-23 line while the buyer pinned, and #1962's tool vocabulary came
  // from, the 2026-04-08 line.) mcp-server/test/ucpSpecVersion.test.js pins both sides together.
  assert.equal(profile.ucp_version, UCP_SPEC_VERSION);
  // Mid-man rule: Pivota is NEVER merchant-of-record — the profile must say so
  // and state its actual role (the merchant settles on their own rails).
  assert.equal(profile.provider.merchant_of_record, false);
  assert.equal(profile.provider.role, 'commerce_index_passthrough');
  // capability ids are the dev.ucp.* names
  const capIds = profile.capabilities.map((c) => c.id);
  assert.ok(capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(capIds.includes('dev.ucp.common.identity_linking'));
  // `order` is NOT advertised over an mcp-only profile: neither of its operations has a UCP tool name, so a
  // platform could match the capability and then fail the call. See the reachability test below.
  assert.ok(!capIds.includes('dev.ucp.shopping.order'));
  // each capability lists its canonical operations
  const checkout = profile.capabilities.find((c) => c.id === 'dev.ucp.shopping.checkout');
  assert.ok(checkout.operations.includes('complete_checkout_session'));
  // TRANSPORTS ARE OPT-IN. No restBasePath was passed, so NO `rest` transport is advertised: the profile
  // must never point a platform at a door that does not speak UCP wire shapes. (It previously defaulted a
  // rest entry on unconditionally, and the gateway handed it the ACP base path — so UCP discovery advertised
  // the ACP door, which speaks ACP bodies. A platform following it failed on the first call.)
  const transports = profile.services.map((s) => s.transport);
  assert.deepEqual(transports.sort(), ['mcp']);

  // ...and it IS advertised when a real UCP-REST door is declared.
  const withRest = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    restBasePath: '/ucp/v1',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
  });
  assert.deepEqual(withRest.services.map((s) => s.transport).sort(), ['mcp', 'rest']);
  assert.equal(
    withRest.services.find((s) => s.transport === 'rest').endpoint,
    'https://shop.pivota.cc/ucp/v1',
  );

  // A blank path is not a declared door: `restBasePath !== undefined` would advertise
  // `https://shop.pivota.cc` as a UCP REST endpoint (review finding on #1962).
  const blankRest = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    restBasePath: '   ',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
  });
  assert.deepEqual(blankRest.services.map((s) => s.transport), ['mcp']);
  assert.deepEqual(profile.payment_handlers, [{ id: 'stripe_spt', psp: 'stripe', pci: false }]);
  assert.equal(profile.signing_keys.length, 1);
  assert.equal(profile.signing_keys[0].kid, 'k1');
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
    // A transport is required for ANY capability to be advertised (the no-transport rule in
    // ucpProfile.js); this test is about omitCapabilityIds, so give it a door and keep the subject single.
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
    omitCapabilityIds: ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.ap2_mandate'],
  });
  const capIds = profile.capabilities.map((c) => c.id);
  assert.ok(!capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(!capIds.includes('dev.ucp.shopping.ap2_mandate'));
  assert.ok(capIds.includes('dev.ucp.shopping.catalog.lookup'), 'non-omitted capabilities remain');
  const allOps = profile.capabilities.flatMap((c) => c.operations || []);
  // NOT asserting create_payment_link here: with an mcp transport declared, the tool-reachability filter
  // (#1981) drops it in EVERY configuration because it has no `ucpTool`, so the assertion would hold with
  // the omit filter deleted — vacuous, not weak. The omitted capability's own operations are checked below.
  assert.ok(!allOps.includes('complete_checkout_session'), 'operations of an omitted capability vanish with it');
  // The intersection can never resurrect an omitted capability.
  assert.deepEqual(activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout']), []);
  // Omitting nothing is the identity.
  const full = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
    omitCapabilityIds: [],
  });
  assert.ok(full.capabilities.map((c) => c.id).includes('dev.ucp.shopping.checkout'));
});

test('UCP profile requires an https baseUrl and rejects unknown advertised capabilities', () => {
  assert.throws(() => buildUcpProfile({ baseUrl: 'http://insecure' }), /must be https/);
  assert.throws(() => buildUcpProfile({}), /baseUrl is required/);
  assert.throws(() => buildUcpProfile({ baseUrl: 'https://x', capabilities: ['not_a_capability'] }), /unknown capability/);
});

test('activeCapabilityIntersection returns only capabilities both sides support', () => {
  const profile = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp' });
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
    'dev.ucp.shopping.buyer_consent',
    'dev.ucp.common.identity_linking',
  ];
  // Reverse-DNS of pivota.cc — the domain this gateway serves from. The spec's example of a vendor
  // capability is `com.example.installments`; Shopify publishes `dev.shopify.catalog` the same way.
  const VENDOR_PREFIX = 'cc.pivota.';

  for (const [key, cap] of Object.entries(CANONICAL_CAPABILITIES)) {
    const known = SPEC_CAPABILITY_IDS.includes(cap.ucp);
    const vendor = cap.ucp.startsWith(VENDOR_PREFIX);
    assert.ok(known || vendor, `${key} advertises "${cap.ucp}", which is neither a spec id nor ours to mint`);
    // A vendor id must NOT squat the standard namespace. Asserted on the PREFIX CONSTANT, not on `cap.ucp`:
    // `cap.ucp.startsWith('cc.pivota.') && !cap.ucp.startsWith('dev.ucp.')` is a tautology, so the obvious
    // spelling of this check constrains nothing. What must hold is that our vendor prefix itself is outside
    // the spec's namespace — which is what makes `known || vendor` above a real disjunction.
    assert.equal(VENDOR_PREFIX.startsWith('dev.ucp.'), false, 'the vendor prefix must be outside dev.ucp.*');
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

test('every capability ID is bound to its operations IN THE CONTRACT, published or not', () => {
  // Asserted on the contract rather than the profile, because the profile only publishes what is currently
  // REACHABLE — so swapping the ids of two withheld capabilities changes no published byte and survives any
  // profile-level check. It would ship silently the day those operations gain a UCP tool name. This is the
  // binding the whole change is about, so it is pinned where it is always true.
  const byUcpId = {};
  for (const [key, cap] of Object.entries(CANONICAL_CAPABILITIES)) {
    assert.equal(byUcpId[cap.ucp], undefined, `${cap.ucp} is advertised by two capabilities (${key})`);
    byUcpId[cap.ucp] = operationsForCapability(key, { includeRefusalOnly: false });
  }
  assert.deepEqual(byUcpId, {
    'dev.ucp.shopping.catalog.search': ['search_catalog'],
    'dev.ucp.shopping.catalog.lookup': ['get_product'],
    'cc.pivota.insights': ['get_alternatives', 'get_offers', 'get_intel'],
    'dev.ucp.shopping.checkout': [
      'create_checkout_session', 'update_checkout_session', 'get_checkout_session',
      'complete_checkout_session', 'create_payment_link', 'cancel_checkout_session',
    ],
    'dev.ucp.shopping.order': ['get_order', 'request_after_sales'],
    'dev.ucp.common.identity_linking': ['start_identity_linking'],
    'dev.ucp.shopping.ap2_mandate': [],
    'dev.ucp.shopping.fulfillment': [],
  });
});

test('the PUBLISHED id is bound to its operations — not just the internal key', () => {
  // The gap this closes: every other test here asserts `operationsForCapability('<internal key>')`, and the
  // keys `catalog_search`/`catalog_lookup`/`insights` never appear on the wire. Swapping the two catalog
  // `ucp` values — so the profile advertises "search" with operations ["get_product"] and "lookup" with
  // ["search_catalog"], precisely inverted — passed the entire suite. Nothing bound an ID to its operations,
  // which is the whole subject of this change.
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
  });
  const byId = Object.fromEntries(profile.capabilities.map((c) => [c.id, c.operations]));
  assert.deepEqual(byId, {
    'dev.ucp.shopping.catalog.lookup': ['get_product'],
    'dev.ucp.shopping.checkout': [
      'create_checkout_session', 'update_checkout_session', 'get_checkout_session', 'complete_checkout_session',
    ],
    'dev.ucp.common.identity_linking': ['start_identity_linking'],
    'dev.ucp.shopping.fulfillment': undefined, // a modifier carries no operations of its own
  });
  // No id may be advertised twice — two entries sharing one id is undetectable downstream.
  const ids = profile.capabilities.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a capability is advertised ONLY where the advertised door can actually serve it', () => {
  // Fixing a capability id turns a silently-DEAD advertisement into an actively-LYING one unless
  // reachability is checked with it. `dev.ucp.shopping.discovery` matched no platform, so nothing behind it
  // was called; the real `dev.ucp.shopping.catalog.search` makes the intersection SUCCEED and then
  // `tools/call search_catalog` hard-fails, because the UCP dialect does not expose that tool.
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
  });
  const ids = profile.capabilities.map((c) => c.id);
  // Withheld: every operation behind these is absent from the UCP dialect today.
  assert.ok(!ids.includes('dev.ucp.shopping.catalog.search'), 'search_catalog has no ucpTool — do not advertise it');
  assert.ok(!ids.includes('cc.pivota.insights'), 'the insights ops have no ucpTool — do not advertise them');
  assert.ok(!ids.includes('dev.ucp.shopping.order'), 'the order ops have no ucpTool — do not advertise them');
  // …and every operation that IS advertised carries an evidenced UCP tool name, or is not tool-served at all.
  for (const c of profile.capabilities) {
    for (const id of c.operations || []) {
      const op = CANONICAL_OPERATIONS.find((o) => o.id === id);
      assert.ok(op.ucpTool || op.kernel === 'external', `${c.id} advertises ${id}, which no UCP tool exposes`);
    }
  }
  // With NO mcp transport this filter has nothing to act on — there is no tool surface for an operation
  // to be absent from. It is the NO-TRANSPORT rule that decides that case, and it withholds everything:
  // a capability with no door at all is not reachable by any measure. (This assertion previously required
  // catalog.search to be PRESENT here, which was true while a transport-less profile still advertised its
  // full set; founder decision 2026-08-13 changed that. The reachability filter below/above is unchanged —
  // it still governs which capabilities appear when a door IS advertised.)
  const noTransport = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' });
  assert.deepEqual(noTransport.services, []);
  assert.deepEqual(noTransport.capabilities, [], 'no door at all => nothing advertised');
});

test('the vendor capability is a ROOT capability — `extends` would make it prunable', () => {
  // `extends` is a pruning key: intersection step 3 removes any capability whose declared parents are all
  // absent. Declaring these reads as extending catalog.lookup would delete Pivota's whole decision layer for
  // a platform that does not negotiate that standard capability — and they do not need it.
  assert.equal(CANONICAL_CAPABILITIES.insights.extends, undefined);
  assert.equal(CANONICAL_CAPABILITIES.catalog_search.extends, undefined);
  assert.equal(CANONICAL_CAPABILITIES.catalog_lookup.extends, undefined);
});

// NO TRANSPORT => NO CAPABILITIES (founder decision 2026-08-13). The same rule as the refusal-only and
// empty-capability filters, one level up: a capability with no door to reach it is a promise a platform
// cannot act on. This is the state the documented rollback produces — unsetting
// AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED withholds the only transport — and the profile used to keep
// advertising checkout, order, catalog and identity with `services: []`.
test('NO transport => NO capabilities advertised (and any transport restores them)', () => {
  const dark = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' }); // no mcpEndpoint, no restBasePath
  assert.deepEqual(dark.services, [], 'precondition: nothing speaks for this profile');
  assert.deepEqual(dark.capabilities, [], 'a profile with no transport must promise nothing');
  // The rest of the document still stands: this is an honest empty profile, not a broken one.
  assert.match(dark.ucp_version, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dark.provider.merchant_of_record, false);
  assert.ok(Array.isArray(dark.signing_keys));

  // The SAME config with a door lit advertises the full set — the filter keys on the transport and on
  // nothing else. Without this half, `capabilities: []` would also satisfy a profile that had simply
  // stopped advertising anything at all.
  const lit = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp' });
  assert.ok(lit.capabilities.length > 0, 'a lit transport must advertise the capabilities behind it');
  assert.ok(lit.capabilities.map((c) => c.id).includes('dev.ucp.shopping.checkout'));

  // A REST-only door counts too: the rule is "some transport", not "the MCP one".
  const restOnly = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', restBasePath: '/ucp/v1' });
  assert.deepEqual(restOnly.services.map((s) => s.transport), ['rest']);
  assert.ok(restOnly.capabilities.length > 0, 'a REST transport is a door like any other');

  // An intersection cannot resurrect what the profile does not advertise.
  assert.deepEqual(activeCapabilityIntersection(dark, ['dev.ucp.shopping.checkout']), []);
});
