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
import {
  UCP_SPEC_VERSION, UCP_SPEC_BASE, UCP_SCHEMA_BASE, UCP_SERVICE_SCHEMA_BASE,
} from '../src/protocol/ucpSpecVersion.cjs';

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
    paymentHandlers: [{ namespace: 'cc.pivota.stripe_spt', id: 'stripe_spt', psp: 'stripe', pci: false }],
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
  // `capabilities` is a MAP keyed by id — the spec's shape, and a live conformant business profile's.
  const capIds = Object.keys(profile.ucp.capabilities);
  assert.ok(capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(capIds.includes('dev.ucp.common.identity_linking'));
  // `order` is NOT advertised over an mcp-only profile: neither of its operations has a UCP tool name, so a
  // platform could match the capability and then fail the call. See the reachability test below.
  assert.ok(!capIds.includes('dev.ucp.shopping.order'));
  // Each entry carries the REQUIRED members. `operations`/`title` are NOT spec members and are gone.
  const checkout = profile.ucp.capabilities['dev.ucp.shopping.checkout'][0];
  assert.equal(checkout.version, UCP_SPEC_VERSION);
  assert.equal(checkout.spec, `${UCP_SPEC_BASE}checkout`);
  assert.equal(checkout.schema, `${UCP_SCHEMA_BASE}shopping/checkout.json`);
  assert.equal(checkout.operations, undefined, 'operations is not a spec member');
  assert.equal(checkout.title, undefined, 'title is not a spec member');
  // EVERY advertised capability carries BOTH, because the spec marks them REQUIRED for all capabilities and
  // a validator rejects the whole document over one incomplete entry.
  for (const [id, entries] of Object.entries(profile.ucp.capabilities)) {
    assert.equal(typeof entries[0].spec, 'string', `${id} must publish a spec URL`);
    assert.equal(typeof entries[0].schema, 'string', `${id} must publish a schema URL`);
  }
  // TRANSPORTS ARE OPT-IN. No restBasePath was passed, so NO `rest` transport is advertised: the profile
  // must never point a platform at a door that does not speak UCP wire shapes. (It previously defaulted a
  // rest entry on unconditionally, and the gateway handed it the ACP base path — so UCP discovery advertised
  // the ACP door, which speaks ACP bodies. A platform following it failed on the first call.)
  // `services` is a MAP keyed by service id, each value an array of transport bindings.
  const transports = profile.ucp.services['dev.ucp.shopping'].map((s) => s.transport);
  assert.deepEqual(transports.sort(), ['mcp']);
  // A service entry carries the TRANSPORT's machine description, which the spec requires for rest/mcp and a
  // live conformant profile carries on every entry. We published none.
  const mcpBinding = profile.ucp.services['dev.ucp.shopping'].find((s) => s.transport === 'mcp');
  assert.equal(mcpBinding.spec, `${UCP_SPEC_BASE}overview`);
  assert.equal(mcpBinding.schema, `${UCP_SERVICE_SCHEMA_BASE}shopping/mcp.openrpc.json`);
  assert.equal(mcpBinding.version, UCP_SPEC_VERSION);

  // ...and it IS advertised when a real UCP-REST door is declared.
  const withRest = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    restBasePath: '/ucp/v1',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
  });
  const restBindings = withRest.ucp.services['dev.ucp.shopping'];
  assert.deepEqual(restBindings.map((s) => s.transport).sort(), ['mcp', 'rest']);
  assert.equal(restBindings.find((s) => s.transport === 'rest').endpoint, 'https://shop.pivota.cc/ucp/v1');
  // The schema is per TRANSPORT, not one constant reused: REST is OpenAPI where MCP is OpenRPC. A single
  // shared value would hand a REST platform the JSON-RPC description of a door it does not speak.
  assert.equal(
    restBindings.find((s) => s.transport === 'rest').schema,
    `${UCP_SERVICE_SCHEMA_BASE}shopping/rest.openapi.json`,
  );
  assert.notEqual(
    restBindings.find((s) => s.transport === 'rest').schema,
    restBindings.find((s) => s.transport === 'mcp').schema,
  );

  // A blank path is not a declared door: `restBasePath !== undefined` would advertise
  // `https://shop.pivota.cc` as a UCP REST endpoint (review finding on #1962).
  const blankRest = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    restBasePath: '   ',
    mcpEndpoint: 'https://shop.pivota.cc/mcp',
  });
  assert.deepEqual(blankRest.ucp.services['dev.ucp.shopping'].map((s) => s.transport), ['mcp']);
  // payment_handlers is a MAP keyed by the handler's REVERSE-DNS namespace, not by its local `id`.
  assert.ok(!Array.isArray(profile.ucp.payment_handlers));
  assert.deepEqual(Object.keys(profile.ucp.payment_handlers), ['cc.pivota.stripe_spt']);
  assert.equal(profile.ucp.payment_handlers['cc.pivota.stripe_spt'][0].id, 'stripe_spt');
  assert.equal(profile.ucp.payment_handlers.stripe_spt, undefined, 'never keyed by the local id');

  // signing_keys IS A SIBLING OF `ucp`, per spec — Key Discovery reads `profile.signing_keys`.
  assert.equal(profile.ucp.signing_keys, undefined, 'signing_keys must not be nested inside ucp');
  assert.equal(profile.signing_keys.length, 1);
  assert.equal(profile.signing_keys[0].kid, 'k1');
});

// F7: a handler that cannot be addressed by a platform is DROPPED, never published under a synthesized key.
// The spec keys payment_handlers by a reverse-DNS handler namespace (com.google.pay) while the entry's `id`
// is a short local name (gpay) — so keying by `id` publishes a name no platform matches.
test('payment handlers are keyed by a reverse-DNS namespace, and un-addressable ones are dropped', () => {
  const build = (paymentHandlers) => buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/mcp', paymentHandlers,
  }).ucp.payment_handlers;

  // No namespace at all -> dropped. Publishing it under `id` would advertise `stripe_spt` as if it were a
  // reverse-DNS handler name, which is the defect this rule exists to prevent.
  assert.deepEqual(build([{ id: 'stripe_spt', psp: 'stripe' }]), {});
  // A namespace that is not reverse-DNS is not a namespace — `id` smuggled into the field is still dropped.
  assert.deepEqual(build([{ namespace: 'stripe_spt', id: 'stripe_spt' }]), {}, 'a bare local name is not a namespace');
  // A real one is published under its namespace, with the entry (including its own local id) intact.
  assert.deepEqual(build([{ namespace: 'com.google.pay', id: 'gpay' }]), {
    'com.google.pay': [{ namespace: 'com.google.pay', id: 'gpay' }],
  });
  // A TWO-label authority is legitimate (`com.stripe`); requiring three would silently drop a valid handler,
  // which is the same "withheld for a reason nothing announces" failure inverted.
  assert.deepEqual(build([{ namespace: 'com.stripe', id: 'spt' }]), {
    'com.stripe': [{ namespace: 'com.stripe', id: 'spt' }],
  });
  // Case and shape are literal — a platform matches these keys byte-for-byte.
  assert.deepEqual(build([{ namespace: 'COM.GOOGLE.PAY', id: 'gpay' }]), {}, 'uppercase is not the same key');
  assert.deepEqual(build([{ namespace: 'com.google.pay.', id: 'gpay' }]), {}, 'a trailing dot is malformed');

  // Callers may pass the spec's map form directly — and ITS KEYS get the same rule. Passing the map through
  // unvalidated would leave exactly one route to publishing a handler under an unmatchable name.
  assert.deepEqual(build({ 'com.google.pay': [{ id: 'gpay' }] }), { 'com.google.pay': [{ id: 'gpay' }] });
  assert.deepEqual(build({ stripe_spt: [{ id: 'stripe_spt' }] }), {}, 'a non-reverse-DNS map key is dropped');
  assert.deepEqual(
    build({ 'com.google.pay': [{ id: 'gpay' }], stripe_spt: [{ id: 'x' }] }),
    { 'com.google.pay': [{ id: 'gpay' }] },
    'the good key survives while the bad one is dropped',
  );
  // Absent config is an empty MAP, not an empty array — the spec member is an object.
  assert.deepEqual(build(undefined), {});
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
  const capIds = Object.keys(profile.ucp.capabilities);
  assert.ok(!capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(!capIds.includes('dev.ucp.shopping.ap2_mandate'));
  assert.ok(capIds.includes('dev.ucp.shopping.catalog.lookup'), 'non-omitted capabilities remain');
  // Operations are no longer a published member, so the withholding is asserted on what the document
  // ACTUALLY CARRIES — the serialized body. (A previous revision asserted `![].includes(...)`, which is
  // vacuously true and would have passed even if the operation were published in full.)
  //
  // NOT asserting `create_payment_link` here (#1987's finding, preserved): with an mcp transport declared,
  // the tool-reachability filter (#1981) drops it in EVERY configuration because it has no `ucpTool`, so
  // that assertion would hold with the omit filter deleted — vacuous, not weak. `complete_checkout_session`
  // IS reachable and belongs to the omitted capability, so it is the one that constrains the omission.
  const serialized = JSON.stringify(profile);
  assert.ok(!serialized.includes('complete_checkout_session'), 'operations of an omitted capability vanish with it');
  // ...and the same assertion detects a real leak: a profile that DOES advertise checkout names it.
  const withCheckout = JSON.stringify(buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
  }));
  assert.ok(withCheckout.includes('dev.ucp.shopping.checkout'), 'the serialized check is not vacuous');
  // The intersection can never resurrect an omitted capability.
  assert.deepEqual(activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout']), {});
  // Omitting nothing is the identity. A transport is required for ANY capability to be advertised (#1987),
  // so it is declared here rather than leaving the profile empty for an unrelated reason.
  const full = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
    omitCapabilityIds: [],
  });
  assert.ok(Object.keys(full.ucp.capabilities).includes('dev.ucp.shopping.checkout'));
});

test('UCP profile requires an https baseUrl and rejects unknown advertised capabilities', () => {
  assert.throws(() => buildUcpProfile({ baseUrl: 'http://insecure' }), /must be https/);
  assert.throws(() => buildUcpProfile({}), /baseUrl is required/);
  assert.throws(() => buildUcpProfile({ baseUrl: 'https://x', capabilities: ['not_a_capability'] }), /unknown capability/);
});

test('activeCapabilityIntersection returns only capabilities both sides support', () => {
  const profile = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp' });
  const active = activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout', 'dev.ucp.some.future.thing']);
  // A MAP of id -> [{version}], per the spec's "Capability Declaration in Responses".
  assert.deepEqual(Object.keys(active), ['dev.ucp.shopping.checkout']);
  assert.deepEqual(active['dev.ucp.shopping.checkout'], [{ version: UCP_SPEC_VERSION }]);
  assert.deepEqual(activeCapabilityIntersection(profile, []), {});

  // Step 3: an extension whose parents are all absent is PRUNED, so a platform is never told a modifier is
  // active while what it modifies is not.
  assert.deepEqual(Object.keys(activeCapabilityIntersection(profile, ['dev.ucp.shopping.fulfillment'])), []);
  // ...and the guard must not cost the real case.
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(
      profile, ['dev.ucp.shopping.fulfillment', 'dev.ucp.shopping.checkout'],
    )).sort(),
    ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.fulfillment'],
  );
});

// The two details of the intersection's orphan rule that our own capability set cannot exercise: Pivota
// publishes exactly ONE extension, single-parent and one level deep. Both were unconstrained, and both are
// spec text rather than preference — so they are driven here against hand-built profile documents, which is
// all activeCapabilityIntersection consumes.
const syntheticProfile = (capabilities) => ({
  ucp: { version: UCP_SPEC_VERSION, services: {}, capabilities, payment_handlers: {} },
});
const entry = (ext) => [ext === undefined ? { version: UCP_SPEC_VERSION } : { version: UCP_SPEC_VERSION, extends: ext }];

test('intersection step 3: a MULTI-parent extension survives on ANY ONE parent (some, not every)', () => {
  // Spec: "For multi-parent extensions (extends: ["a", "b"]): at least one parent must be present."
  const profile = syntheticProfile({
    'dev.ucp.shopping.checkout': entry(),
    'dev.ucp.shopping.cart': entry(),
    // cosrx publishes exactly this: fulfillment extending BOTH checkout and cart.
    'dev.ucp.shopping.fulfillment': entry(['dev.ucp.shopping.checkout', 'dev.ucp.shopping.cart']),
  });

  // ONE parent present is enough. Requiring ALL parents (`.every`) would delete the extension here — a
  // stricter-than-spec rule that silently withholds fulfillment from every platform that negotiates
  // checkout without cart, which is the same class of silent loss as declaring a parent we do not need.
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(profile, [
      'dev.ucp.shopping.checkout', 'dev.ucp.shopping.fulfillment',
    ])).sort(),
    ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.fulfillment'],
    'one of two parents present must keep the extension',
  );
  // The other parent alone is equally sufficient — not an artefact of declaration order.
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(profile, [
      'dev.ucp.shopping.cart', 'dev.ucp.shopping.fulfillment',
    ])).sort(),
    ['dev.ucp.shopping.cart', 'dev.ucp.shopping.fulfillment'],
  );
  // NONE present still prunes: `.some` is the rule, not "never prune".
  assert.deepEqual(Object.keys(activeCapabilityIntersection(profile, ['dev.ucp.shopping.fulfillment'])), []);
  // A single-parent extension in the spec's OTHER form (a bare string, not an array) obeys the same rule.
  const single = syntheticProfile({
    'dev.ucp.shopping.checkout': entry(),
    'dev.ucp.shopping.discount': entry('dev.ucp.shopping.checkout'),
  });
  assert.deepEqual(Object.keys(activeCapabilityIntersection(single, ['dev.ucp.shopping.discount'])), []);
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(single, [
      'dev.ucp.shopping.discount', 'dev.ucp.shopping.checkout',
    ])).sort(),
    ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.discount'],
  );
});

test('intersection step 4: pruning REPEATS to a fixed point, so a transitive chain collapses', () => {
  // Spec: "Repeat pruning: Continue step 3 until no more capabilities are removed (handles transitive
  // extension chains)." A grandchild whose parent is itself pruned must go too — a single pass leaves it
  // pointing at a capability the same response has already removed.
  //
  // Declaration order is deliberate: the CHILD is visited before the PARENT, so on a single pass the child
  // is judged while its parent is still present and survives. That ordering is what makes this a real test
  // of the loop rather than of iteration luck.
  const profile = syntheticProfile({
    'cc.pivota.grandchild': entry(['cc.pivota.child']),
    'cc.pivota.child': entry(['dev.ucp.shopping.cart']),
    'dev.ucp.shopping.cart': entry(),
    'dev.ucp.shopping.checkout': entry(),
  });

  // The platform names child + grandchild but NOT `dev.ucp.shopping.cart`, so `child` is orphaned on pass 1
  // and `grandchild` is orphaned only by pass 2.
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(profile, [
      'cc.pivota.grandchild', 'cc.pivota.child', 'dev.ucp.shopping.checkout',
    ])),
    ['dev.ucp.shopping.checkout'],
    'the whole chain collapses; a single pass would leave the grandchild orphaned',
  );
  // The chain SURVIVES intact when its root parent is present — the fixed point terminates, it does not
  // grind everything away.
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(profile, [
      'cc.pivota.grandchild', 'cc.pivota.child', 'dev.ucp.shopping.cart',
    ])).sort(),
    ['cc.pivota.child', 'cc.pivota.grandchild', 'dev.ucp.shopping.cart'],
  );
});

test('an EMPTY extends array is an orphan, not a root', () => {
  // The spec prunes "any capability where `extends` is SET but none of its parents are in the intersection".
  // `[]` is set and has no present parent, so it prunes. Treating it as a root instead would let a malformed
  // platform document turn this guard off from the OUTSIDE — the counterparty controls this field, not us.
  const profile = syntheticProfile({
    'dev.ucp.shopping.checkout': entry(),
    'cc.pivota.parentless': entry([]),
  });
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout', 'cc.pivota.parentless'])),
    ['dev.ucp.shopping.checkout'],
    'an extension declaring no parents can never satisfy "at least one parent present"',
  );
});

test('the intersection reports each capability\'s OWN version, not the profile-level one', () => {
  // Step 2 (mutual version selection) is not implemented, but the entry's own version is still what a
  // platform reads back. Reporting the document-level version for every capability would silently flatten a
  // per-capability version the day one exists — and nothing else distinguishes the two reads.
  const profile = {
    ucp: {
      version: '2026-04-08',
      services: {},
      payment_handlers: {},
      capabilities: {
        'dev.ucp.shopping.checkout': [{ version: '2026-01-23' }], // deliberately NOT the profile version
        'dev.ucp.shopping.cart': [{ version: '2026-04-08' }],
      },
    },
  };
  const active = activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.cart']);
  assert.deepEqual(active['dev.ucp.shopping.checkout'], [{ version: '2026-01-23' }], 'the entry\'s own version');
  assert.deepEqual(active['dev.ucp.shopping.cart'], [{ version: '2026-04-08' }]);
  // ...and the profile-level version is the FALLBACK when an entry carries none, rather than `undefined`.
  const noVersion = activeCapabilityIntersection(
    { ucp: { version: '2026-04-08', capabilities: { 'dev.ucp.shopping.cart': [{}] } } },
    ['dev.ucp.shopping.cart'],
  );
  assert.deepEqual(noVersion['dev.ucp.shopping.cart'], [{ version: '2026-04-08' }]);
});

test('a vendor capability override must be hosted on the authority its NAME claims', () => {
  const build = (docs) => buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc', restBasePath: '/ucp/v1', vendorCapabilityDocs: docs,
  }).ucp.capabilities['cc.pivota.insights'];

  // `cc.pivota.*` claims pivota.cc. Documents hosted anywhere else are refused rather than published: the
  // capability name asserts an authority, and a validating platform checks the origin against it.
  assert.equal(build({
    'cc.pivota.insights': {
      spec: 'https://ucp.dev/2026-04-08/specification/catalog',
      schema: 'https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json',
    },
  }), undefined, 'documents on someone else\'s origin are not ours to advertise');
  // Half-matching is still refused — the mismatch is what matters, not which member carries it.
  assert.equal(build({
    'cc.pivota.insights': {
      spec: 'https://pivota.cc/ucp/insights',
      schema: 'https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json',
    },
  }), undefined);
  // ...and the matching case still publishes, so this guard does not simply disable the escape hatch.
  const ok = build({
    'cc.pivota.insights': {
      spec: 'https://pivota.cc/ucp/insights',
      schema: 'https://pivota.cc/ucp/schemas/insights.json',
    },
  });
  assert.ok(ok, 'documents on the claimed authority publish normally');
});

test('the profile builder and the intersection prune orphans by the SAME rule', () => {
  // F4: these were two implementations that disagreed — the builder required ALL parents, the intersection
  // any one. The rule is the spec's, and there is now one function; this pins the agreement at the seam
  // rather than trusting that the shared helper stays shared.
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
    omitCapabilityIds: ['dev.ucp.shopping.checkout'],
  });
  const published = Object.keys(profile.ucp.capabilities);
  assert.ok(!published.includes('dev.ucp.shopping.checkout'), 'the kill-switch withheld the parent');
  assert.ok(
    !published.includes('dev.ucp.shopping.fulfillment'),
    'the builder drops the orphaned modifier when its only parent is withheld',
  );
  // And the intersection reaches the same verdict for the same input, from the other direction.
  assert.deepEqual(
    Object.keys(activeCapabilityIntersection(profile, [
      'dev.ucp.shopping.fulfillment', 'dev.ucp.shopping.checkout',
    ])),
    [],
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

  // Spec: "Profile responses MUST include a Cache-Control header with `public` and `max-age` of at least 60
  // seconds… MUST NOT be served with `private`, `no-store`, or `no-cache`." We sent no Cache-Control at all.
  const cacheControl = profileOut.headers['cache-control'];
  assert.ok(cacheControl, 'the profile response must carry Cache-Control');
  assert.match(cacheControl, /(^|[\s,])public([\s,]|$)/, 'must be publicly cacheable');
  const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);
  assert.ok(maxAge >= 60, `max-age must be at least 60, got ${maxAge}`);
  for (const forbidden of ['private', 'no-store', 'no-cache']) {
    assert.ok(!cacheControl.includes(forbidden), `Cache-Control must not carry ${forbidden}`);
  }

  const activeOut = await active.handler({
    body: { capabilities: ['dev.ucp.shopping.checkout', 'dev.ucp.some.future.thing'] },
  });
  assert.equal(activeOut.status, 200);
  // The response is the spec's shape: `{ ucp: { version, capabilities: { id: [{version}] } } }`. It used to
  // answer `{ ucp_version, active_capabilities: [...] }` — neither key exists in the spec.
  assert.equal(activeOut.body.ucp.version, UCP_SPEC_VERSION);
  assert.deepEqual(Object.keys(activeOut.body.ucp.capabilities), ['dev.ucp.shopping.checkout']);
  // ...and this one is genuinely per-request, so it must NOT be advertised as a shared cacheable document.
  assert.equal(activeOut.headers['cache-control'], undefined);
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
  //
  // `operations` is not a spec member and is no longer PUBLISHED, so the binding is asserted one step further
  // out — on the WIRE TOOL NAMES each advertised id makes callable. That is the strongest available form of
  // this assertion: it is what a platform reading the id actually gets to invoke, and it needs no restatement
  // of the reachability filter (an operation with no `ucpTool` contributes no tool by definition).
  //
  // The swapped-ids mutant still dies: id `…catalog.lookup` would resolve to the key holding `search_catalog`
  // and publish ['search_catalog'] where ['get_product'] is asserted (and vice versa) — the two catalog ids
  // now each carry exactly one tool, so the swap is visible as an exact inversion of the map below.
  const keyForId = (id) => Object.keys(CANONICAL_CAPABILITIES).find((k) => CANONICAL_CAPABILITIES[k].ucp === id);
  const toolsFor = (id) => {
    const key = keyForId(id);
    assert.ok(key, `advertised id ${id} belongs to no capability in the contract`);
    return operationsForCapability(key, { includeRefusalOnly: false })
      .map((opId) => canonicalOp(opId).ucpTool).filter(Boolean).sort();
  };
  assert.deepEqual(
    Object.fromEntries(Object.keys(profile.ucp.capabilities).map((id) => [id, toolsFor(id)])),
    {
      'dev.ucp.shopping.catalog.search': ['search_catalog'],
      'dev.ucp.shopping.catalog.lookup': ['get_product'],
      'dev.ucp.shopping.checkout': ['complete_checkout', 'create_checkout', 'get_checkout', 'update_checkout'],
      // No tool: identity linking happens at the OAuth edge, which is why it stays advertisable with none.
      'dev.ucp.common.identity_linking': [],
      // A modifier has no operations of its own; what stands behind it is checkout's tools plus its config.
      'dev.ucp.shopping.fulfillment': [],
    },
  );
  // No id may be advertised twice — a MAP makes that structurally impossible, which is the point, so this
  // pins that the builder never silently collapses two contract keys onto one published id.
  const contractIds = Object.keys(CANONICAL_CAPABILITIES).map((k) => CANONICAL_CAPABILITIES[k].ucp);
  assert.equal(new Set(contractIds).size, contractIds.length, 'two capabilities share one published id');
});

test('a capability is advertised ONLY where the advertised door can actually serve it', () => {
  // Fixing a capability id turns a silently-DEAD advertisement into an actively-LYING one unless
  // reachability is checked with it. `dev.ucp.shopping.discovery` matched no platform, so nothing behind it
  // was called; the real `dev.ucp.shopping.catalog.search` would have made the intersection SUCCEED and then
  // `tools/call search_catalog` hard-fail, because the UCP dialect did not expose that tool. It was withheld
  // for exactly that reason until 2026-08-18, when `search_catalog` gained its evidenced `ucpTool` + mapper —
  // and the SAME rule, unchanged, is what now publishes it. Both directions of the rule are asserted here.
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
  });
  const ids = Object.keys(profile.ucp.capabilities);
  // Published BECAUSE its operation is now reachable — not by an edit to the builder.
  assert.ok(ids.includes('dev.ucp.shopping.catalog.search'), 'search_catalog carries a ucpTool — advertise it');
  // Withheld: every operation behind this is still absent from the UCP dialect.
  assert.ok(!ids.includes('dev.ucp.shopping.order'), 'the order ops have no ucpTool — do not advertise them');
  // …and every advertised capability leaves at least one operation a platform can actually reach: an
  // evidenced UCP tool name, or an operation that is not tool-served at all (`kernel: 'external'`). A
  // capability whose whole operation set fails that test is the "correct id in front of an absent tool"
  // defect, and is the reason the three above are withheld.
  for (const id of ids) {
    const key = Object.keys(CANONICAL_CAPABILITIES).find((k) => CANONICAL_CAPABILITIES[k].ucp === id);
    if (CANONICAL_CAPABILITIES[key].extends) continue; // a modifier rides on what it extends
    const reachable = operationsForCapability(key, { includeRefusalOnly: false })
      .filter((opId) => {
        const op = CANONICAL_OPERATIONS.find((o) => o.id === opId);
        return Boolean(op.ucpTool) || op.kernel === 'external';
      });
    assert.ok(reachable.length > 0, `${id} is advertised but no operation behind it is reachable`);
  }
  // With NO mcp transport this filter has nothing to act on — there is no tool surface for an operation
  // to be absent from. It is the NO-TRANSPORT rule that decides that case, and it withholds everything:
  // a capability with no door at all is not reachable by any measure. (This assertion previously required
  // catalog.search to be PRESENT here, which was true while a transport-less profile still advertised its
  // full set; founder decision 2026-08-13 changed that. The reachability filter below/above is unchanged —
  // it still governs which capabilities appear when a door IS advertised.)
  const noTransport = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' });
  assert.deepEqual(noTransport.ucp.services, {}, 'the map form is EMPTY, not an array');
  assert.deepEqual(noTransport.ucp.capabilities, {}, 'no door at all => nothing advertised');
});

test('a capability with no hosted spec/schema is WITHHELD, never published as a partial entry', () => {
  // The spec marks `spec` and `schema` REQUIRED for ALL capabilities, and a validator that enforces that
  // answers `profile_malformed` for the WHOLE DOCUMENT — so a partial vendor entry does not degrade itself,
  // it takes checkout, catalog and fulfillment down with it. `cc.pivota.insights` has no hosted documents.
  //
  // ISOLATED WITH A **REST** TRANSPORT ON PURPOSE. Two other rules would otherwise mask this one and make
  // the test vacuous: with no transport at all nothing is advertised (#1987), and behind an MCP transport
  // the tool-reachability filter (#1981) withholds insights anyway because none of its operations has a
  // `ucpTool`. A rest-only profile clears both — the transport exists, and reachability does not apply
  // without an mcp endpoint — so the ONLY thing that can withhold insights here is the missing documents.
  const restOnly = (extra) => buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc', restBasePath: '/ucp/v1', ...extra,
  });

  const withheld = restOnly();
  assert.ok(Object.keys(withheld.ucp.capabilities).length > 0, 'the fixture must advertise SOMETHING');
  assert.ok(Object.keys(withheld.ucp.capabilities).includes('dev.ucp.shopping.catalog.search'),
    'a capability WITH documents is published over this transport — so the withholding below is specific');
  assert.ok(!Object.keys(withheld.ucp.capabilities).includes('cc.pivota.insights'));
  assert.ok(!JSON.stringify(withheld).includes('cc.pivota'), 'no trace of the vendor capability anywhere');

  // ...and it is WITHHELD, not deleted: hosting the documents publishes it again with no code change.
  const withDocs = restOnly({
    vendorCapabilityDocs: {
      'cc.pivota.insights': {
        spec: 'https://pivota.cc/ucp/insights',
        schema: 'https://pivota.cc/ucp/schemas/insights.json',
      },
    },
  });
  const insights = withDocs.ucp.capabilities['cc.pivota.insights'];
  assert.ok(insights, 'supplying real documents publishes the capability');
  assert.equal(insights[0].spec, 'https://pivota.cc/ucp/insights');
  assert.equal(insights[0].schema, 'https://pivota.cc/ucp/schemas/insights.json');
  // HALF an override is still a malformed entry, so it withholds exactly as an absent one does.
  const halfDocs = restOnly({
    vendorCapabilityDocs: { 'cc.pivota.insights': { spec: 'https://pivota.cc/ucp/insights' } },
  });
  assert.equal(halfDocs.ucp.capabilities['cc.pivota.insights'], undefined);
});

// EVERY published spec/schema URL, as a LITERAL — not composed from the constants that produced it.
//
// This is the assertion class the whole workstream keeps failing. `assert.equal(checkout.spec,
// `${UCP_SPEC_BASE}checkout`)` compares the output to a constant imported from the module under test, so it
// pins the SUFFIX and nothing else: reverting UCP_SCHEMA_BASE to the singular `schema/` — the exact 404 this
// change exists to fix — left every such assertion green. Measured: a `common/` -> `shopping/` typo on
// identity_linking, a `fulfilment` misspelling, and a `catalog` -> `catalog-search` slip all shipped 404s
// with the full suite passing.
//
// So the table below is written out by hand, and every entry was fetched and observed 200 on 2026-08-14.
// If a path changes, this fails and someone must re-fetch the new one before editing it — which is the only
// mechanism that has actually caught a dead URL in this repo.
const PUBLISHED_CAPABILITY_DOCS = Object.freeze({
  'dev.ucp.shopping.catalog.search': {
    spec: 'https://ucp.dev/2026-04-08/specification/catalog',
    schema: 'https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json',
  },
  'dev.ucp.shopping.catalog.lookup': {
    spec: 'https://ucp.dev/2026-04-08/specification/catalog',
    schema: 'https://ucp.dev/2026-04-08/schemas/shopping/catalog_lookup.json',
  },
  'dev.ucp.shopping.checkout': {
    spec: 'https://ucp.dev/2026-04-08/specification/checkout',
    schema: 'https://ucp.dev/2026-04-08/schemas/shopping/checkout.json',
  },
  'dev.ucp.shopping.order': {
    spec: 'https://ucp.dev/2026-04-08/specification/order',
    schema: 'https://ucp.dev/2026-04-08/schemas/shopping/order.json',
  },
  'dev.ucp.common.identity_linking': {
    // Two spellings that do NOT follow from the id: the page is hyphenated, and the schema lives under
    // `common/` rather than `shopping/`. Both were mutated to the "obvious" form and both 404'd.
    spec: 'https://ucp.dev/2026-04-08/specification/identity-linking',
    schema: 'https://ucp.dev/2026-04-08/schemas/common/identity_linking.json',
  },
  'dev.ucp.shopping.ap2_mandate': {
    // The page is PLURAL and hyphenated where the capability id is singular with an underscore.
    spec: 'https://ucp.dev/2026-04-08/specification/ap2-mandates',
    schema: 'https://ucp.dev/2026-04-08/schemas/shopping/ap2_mandate.json',
  },
  'dev.ucp.shopping.fulfillment': {
    spec: 'https://ucp.dev/2026-04-08/specification/fulfillment',
    schema: 'https://ucp.dev/2026-04-08/schemas/shopping/fulfillment.json',
  },
});

test('every capability publishes the EXACT measured spec/schema URL, not a composed one', () => {
  // Built with a REST transport so the tool-reachability filter does not withhold most of the table: this
  // test is about the URLs, and a capability that never appears cannot have its URL checked.
  const profile = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', restBasePath: '/ucp/v1' });
  const published = profile.ucp.capabilities;

  for (const [id, entries] of Object.entries(published)) {
    const expected = PUBLISHED_CAPABILITY_DOCS[id];
    assert.ok(expected, `${id} is advertised but has no verified URL pair in this table — measure it first`);
    assert.equal(entries[0].spec, expected.spec, `${id} spec URL`);
    assert.equal(entries[0].schema, expected.schema, `${id} schema URL`);
  }
  // ...and the table is not aspirational: the capabilities it covers really are the advertised ones, so a
  // capability silently dropping out of the profile cannot make this pass by vacancy.
  assert.ok(Object.keys(published).length >= 5, `expected the full read+write set, got ${Object.keys(published).length}`);

  // The SERVICE entries carry their own pair, from a third tree again (`/services/`, not `/schemas/`).
  const bindings = profile.ucp.services['dev.ucp.shopping'];
  assert.deepEqual(bindings.map((b) => b.spec), ['https://ucp.dev/2026-04-08/specification/overview']);
  assert.deepEqual(bindings.map((b) => b.schema), ['https://ucp.dev/2026-04-08/services/shopping/rest.openapi.json']);
  const withMcp = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp' });
  assert.equal(
    withMcp.ucp.services['dev.ucp.shopping'][0].schema,
    'https://ucp.dev/2026-04-08/services/shopping/mcp.openrpc.json',
  );

  // Nothing anywhere in the document may use the SINGULAR schema base, which 404s at every path.
  assert.ok(!JSON.stringify(profile).includes('/2026-04-08/schema/'), 'the singular schema base is a 404');
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
  assert.deepEqual(dark.ucp.services, {}, 'precondition: nothing speaks for this profile');
  assert.deepEqual(dark.ucp.capabilities, {}, 'a profile with no transport must promise nothing');
  // The rest of the document still stands: this is an honest empty profile, not a broken one.
  assert.match(dark.ucp.version, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dark.provider.merchant_of_record, false);
  assert.ok(Array.isArray(dark.signing_keys));

  // The SAME config with a door lit advertises the full set — the filter keys on the transport and on
  // nothing else. Without this half, an empty map would also satisfy a profile that had simply stopped
  // advertising anything at all.
  //
  // THIS HALF IS THE ONE THAT CATCHES THE PORT HAZARD. #1987 wrote the rule as `services.length > 0` while
  // `services` was an ARRAY; the spec's shape makes it a MAP, and `{}.length` is `undefined`, so a
  // mechanical port yields `undefined > 0` === false and the profile advertises NOTHING IN PRODUCTION —
  // while the dark half above stays green, because empty is exactly what it expects. Only asserting the LIT
  // case can fail on that mistake, which is why both halves are mandatory here.
  const lit = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp' });
  assert.ok(Object.keys(lit.ucp.capabilities).length > 0, 'a lit transport must advertise the capabilities behind it');
  assert.ok(Object.keys(lit.ucp.capabilities).includes('dev.ucp.shopping.checkout'));

  // A REST-only door counts too: the rule is "some transport", not "the MCP one".
  const restOnly = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', restBasePath: '/ucp/v1' });
  assert.deepEqual(restOnly.ucp.services['dev.ucp.shopping'].map((s) => s.transport), ['rest']);
  assert.ok(Object.keys(restOnly.ucp.capabilities).length > 0, 'a REST transport is a door like any other');

  // An intersection cannot resurrect what the profile does not advertise.
  assert.deepEqual(activeCapabilityIntersection(dark, ['dev.ucp.shopping.checkout']), {});
});
