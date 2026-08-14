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
  assert.deepEqual(build([{ namespace: 'stripe_spt', id: 'stripe_spt' }]), {});
  assert.deepEqual(build([{ namespace: 'pivota.cc', id: 'x' }]), {}, 'two labels is not reverse-DNS');
  // A real one is published under its namespace, with the entry (including its own local id) intact.
  assert.deepEqual(build([{ namespace: 'com.google.pay', id: 'gpay' }]), {
    'com.google.pay': [{ namespace: 'com.google.pay', id: 'gpay' }],
  });
  // Callers may pass the spec's map form directly; it is passed through untouched.
  assert.deepEqual(build({ 'com.google.pay': [{ id: 'gpay' }] }), { 'com.google.pay': [{ id: 'gpay' }] });
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
    omitCapabilityIds: ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.ap2_mandate'],
  });
  const capIds = Object.keys(profile.ucp.capabilities);
  assert.ok(!capIds.includes('dev.ucp.shopping.checkout'));
  assert.ok(!capIds.includes('dev.ucp.shopping.ap2_mandate'));
  assert.ok(capIds.includes('dev.ucp.shopping.catalog.lookup'), 'non-omitted capabilities remain');
  // Operations are no longer a published member, so the withholding is asserted on what the document
  // ACTUALLY CARRIES — the serialized body. (A previous revision asserted `![].includes(...)`, which is
  // vacuously true and would have passed even if the operation were published in full.)
  const serialized = JSON.stringify(profile);
  assert.ok(!serialized.includes('create_payment_link'), 'operations of an omitted capability vanish with it');
  assert.ok(!serialized.includes('complete_checkout_session'));
  // ...and the same assertion detects a real leak: a profile that DOES advertise checkout names it.
  const withCheckout = JSON.stringify(buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' }));
  assert.ok(withCheckout.includes('dev.ucp.shopping.checkout'), 'the serialized check is not vacuous');
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
  // The swapped-ids mutant still dies: id `…catalog.lookup` would resolve to the key holding `search_catalog`,
  // which has no UCP tool at all, so its tool list would be empty instead of ['get_product'].
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
  // was called; the real `dev.ucp.shopping.catalog.search` makes the intersection SUCCEED and then
  // `tools/call search_catalog` hard-fails, because the UCP dialect does not expose that tool.
  const profile = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
  });
  const ids = Object.keys(profile.ucp.capabilities);
  // Withheld: every operation behind these is absent from the UCP dialect today.
  assert.ok(!ids.includes('dev.ucp.shopping.catalog.search'), 'search_catalog has no ucpTool — do not advertise it');
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
  // With NO mcp transport there is no tool surface to be absent from, so nothing is filtered on that basis.
  const noTransport = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' });
  assert.ok(Object.keys(noTransport.ucp.capabilities).includes('dev.ucp.shopping.catalog.search'));
});

test('a capability with no hosted spec/schema is WITHHELD, never published as a partial entry', () => {
  // The spec marks `spec` and `schema` REQUIRED for ALL capabilities, and a validator that enforces that
  // answers `profile_malformed` for the WHOLE DOCUMENT — so a partial vendor entry does not degrade itself,
  // it takes checkout, catalog and fulfillment down with it. `cc.pivota.insights` has no hosted documents.
  const withMcp = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp' });
  const noTransport = buildUcpProfile({ baseUrl: 'https://shop.pivota.cc' });
  // Withheld on BOTH paths. Reachability (#1981) already hides it behind an MCP transport, so without this
  // rule the mcp-less profile — the one a REST-only or future deployment publishes — would still ship it.
  assert.ok(!Object.keys(withMcp.ucp.capabilities).includes('cc.pivota.insights'));
  assert.ok(!Object.keys(noTransport.ucp.capabilities).includes('cc.pivota.insights'),
    'withholding must not depend on the transport — the missing documents are the reason');
  assert.ok(!JSON.stringify(noTransport).includes('cc.pivota'), 'no trace of the vendor capability anywhere');

  // ...and it is WITHHELD, not deleted: hosting the documents publishes it again with no code change.
  const withDocs = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
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
  const halfDocs = buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    vendorCapabilityDocs: { 'cc.pivota.insights': { spec: 'https://pivota.cc/ucp/insights' } },
  });
  assert.equal(halfDocs.ucp.capabilities['cc.pivota.insights'], undefined);
});

test('the vendor capability is a ROOT capability — `extends` would make it prunable', () => {
  // `extends` is a pruning key: intersection step 3 removes any capability whose declared parents are all
  // absent. Declaring these reads as extending catalog.lookup would delete Pivota's whole decision layer for
  // a platform that does not negotiate that standard capability — and they do not need it.
  assert.equal(CANONICAL_CAPABILITIES.insights.extends, undefined);
  assert.equal(CANONICAL_CAPABILITIES.catalog_search.extends, undefined);
  assert.equal(CANONICAL_CAPABILITIES.catalog_lookup.extends, undefined);
});
