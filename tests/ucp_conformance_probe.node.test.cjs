'use strict';

/*
 * The conformance probe must be able to FAIL.
 *
 * A probe is a test that runs in production, and it has the same failure mode as any other test: it can
 * report PASS while the thing it names is broken. This repo has shipped that four times in three days — a
 * suite that never ran, a test whose assertions ran after it was scored, a substring check against a
 * document that could not contain the substring, a guard nothing constrained. A green probe pointed at a
 * live money surface is worth exactly as much as its ability to go red.
 *
 * So every invariant the probe claims is driven twice here: once on a conformant profile (must be silent)
 * and once on a profile violating that invariant (must produce that specific finding code). The fixtures
 * are both SHAPES the surface has actually served — the spec `{ucp:{…}}` maps live today, the legacy flat
 * arrays served until 2026-08-13 — because shape-tolerance is the probe's reason for existing, and a
 * probe that silently stopped reading the document after a restructure would report a clean PASS forever.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  readProfile,
  evaluateProfile,
  evaluateDoor,
  evaluateIntersection,
  readActiveIds,
} = require('../scripts/probe-ucp-conformance.cjs');

const DOOR = 'https://commerce.mcp.pivota.cc/ucp/mcp';
const PUB_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'pivota-order-1', use: 'sig' };

/** The shape production serves today (#1988): nested `ucp`, maps, signing_keys as a SIBLING. */
function specProfile(over = {}) {
  return {
    ucp: {
      version: '2026-04-08',
      services: { 'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp', endpoint: DOOR }] },
      capabilities: { 'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }] },
      payment_handlers: {},
      ...(over.ucp || {}),
    },
    signing_keys: [PUB_JWK],
    ...(over.top || {}),
  };
}

/** The shape it served until 2026-08-13: flat version, arrays. */
function legacyProfile(over = {}) {
  return {
    ucp_version: '2026-04-08',
    services: [{ transport: 'mcp', endpoint: DOOR }],
    capabilities: [{ id: 'dev.ucp.shopping.checkout', operations: ['create_checkout_session'] }],
    payment_handlers: [],
    signing_keys: [PUB_JWK],
    ...over,
  };
}

const codes = (findings) => findings.map((f) => f.code);
const fails = (findings) => findings.filter((f) => f.level === 'FAIL').map((f) => f.code);

describe('the probe reads BOTH shapes (a restructure must not read as an outage)', () => {
  test('spec shape: version, transport, capability and keys are all found', () => {
    const v = readProfile(specProfile());
    assert.equal(v.isSpecShape, true);
    assert.equal(v.version, '2026-04-08');
    assert.deepEqual(v.transports, [{ transport: 'mcp', endpoint: DOOR }]);
    assert.deepEqual(v.capabilityIds, ['dev.ucp.shopping.checkout']);
    assert.equal(v.signingKeysTopLevel.length, 1);
  });

  test('legacy shape: the same facts are found', () => {
    const v = readProfile(legacyProfile());
    assert.equal(v.isSpecShape, false);
    assert.equal(v.version, '2026-04-08');
    assert.deepEqual(v.transports, [{ transport: 'mcp', endpoint: DOOR }]);
    assert.deepEqual(v.capabilityIds, ['dev.ucp.shopping.checkout']);
  });

  test('a conformant profile in EITHER shape produces no FAIL', () => {
    assert.deepEqual(fails(evaluateProfile(specProfile()).findings), []);
    assert.deepEqual(fails(evaluateProfile(legacyProfile()).findings), []);
  });
});

describe('P2 — the version invariant (#1967: the seller silently lagged the buyer)', () => {
  test('a missing version FAILS', () => {
    const doc = specProfile(); delete doc.ucp.version;
    assert.ok(fails(evaluateProfile(doc).findings).includes('P2_NO_VERSION'));
  });
  test('a non-ISO version FAILS', () => {
    const doc = specProfile({ ucp: { version: 'latest' } });
    assert.ok(fails(evaluateProfile(doc).findings).includes('P2_BAD_VERSION'));
  });
});

describe('P3 — signing keys where Key Discovery reads them (#1988)', () => {
  test('keys nested under `ucp` FAIL — present, but invisible to a verifier', () => {
    const doc = specProfile();
    doc.ucp.signing_keys = doc.signing_keys;
    delete doc.signing_keys;
    assert.ok(fails(evaluateProfile(doc).findings).includes('P3_KEYS_NESTED'));
  });
  test('no keys at all FAILS', () => {
    const doc = specProfile(); delete doc.signing_keys;
    assert.ok(fails(evaluateProfile(doc).findings).includes('P3_KEYS_ABSENT'));
  });
  test('an empty key list WARNS but does not fail (none provisioned yet is legitimate)', () => {
    const doc = specProfile({ top: { signing_keys: [] } });
    const f = evaluateProfile(doc).findings;
    assert.deepEqual(fails(f), []);
    assert.ok(codes(f).includes('P3_KEYS_EMPTY'));
  });
  test('a PUBLISHED PRIVATE key FAILS loudly', () => {
    const doc = specProfile({ top: { signing_keys: [{ ...PUB_JWK, d: 'secret' }] } });
    assert.ok(fails(evaluateProfile(doc).findings).includes('P3_PRIVATE_KEY_PUBLISHED'));
  });
});

describe('P5 — transports and capabilities agree in BOTH directions (#1987)', () => {
  test('capabilities with NO transport FAIL (the state the rollback used to produce)', () => {
    const doc = specProfile({ ucp: { services: {} } });
    assert.ok(fails(evaluateProfile(doc).findings).includes('P5_CAPS_WITHOUT_TRANSPORT'));
  });
  test('a transport with NO capabilities FAILS — the map-shape trap, caught from the outside', () => {
    // This is the exact production outcome that `services.length > 0` would have caused once `services`
    // became a map: a lit door advertising nothing. The probe sees it without knowing the code.
    const doc = specProfile({ ucp: { capabilities: {} } });
    assert.ok(fails(evaluateProfile(doc).findings).includes('P5_TRANSPORT_WITHOUT_CAPS'));
  });
  test('neither transport nor capability is silent — an honestly dark profile is not a defect', () => {
    const doc = specProfile({ ucp: { services: {}, capabilities: {} } });
    assert.deepEqual(fails(evaluateProfile(doc).findings), []);
  });
});

describe('P4/P6 — an advertised door must exist, refuse, and name ITSELF (#1966, #1979)', () => {
  const metadata = { resource: DOOR, authorization_servers: ['https://api.pivota.cc'] };
  const challenge = `Bearer error="invalid_token", resource_metadata="https://commerce.mcp.pivota.cc/.well-known/oauth-protected-resource/ucp/mcp"`;

  test('401 + metadata naming the door itself is clean', () => {
    const f = evaluateDoor(DOOR, { status: 401, wwwAuthenticate: challenge, metadata, metadataStatus: 200 });
    assert.deepEqual(f, []);
  });
  test('an advertised endpoint that 404s FAILS (advertised but not executable)', () => {
    assert.ok(fails(evaluateDoor(DOOR, { status: 404 })).includes('P4_ADVERTISED_DOOR_404'));
  });
  test('a money door answering an UNAUTHENTICATED call FAILS', () => {
    assert.ok(fails(evaluateDoor(DOOR, { status: 200 })).includes('P4_DOOR_UNAUTHENTICATED'));
  });
  test('a 401 with no resource_metadata FAILS', () => {
    assert.ok(fails(evaluateDoor(DOOR, { status: 401, wwwAuthenticate: 'Bearer error="invalid_token"' }))
      .includes('P6_NO_RESOURCE_METADATA'));
  });
  test('metadata naming a DIFFERENT resource FAILS — the exact #1979 defect', () => {
    const wrong = { resource: 'https://commerce.mcp.pivota.cc/mcp' }; // the native door, from /ucp/mcp's challenge
    const f = evaluateDoor(DOOR, { status: 401, wwwAuthenticate: challenge, metadata: wrong, metadataStatus: 200 });
    assert.ok(fails(f).includes('P6_RESOURCE_MISMATCH'));
  });
  test('an unfetchable metadata URL FAILS', () => {
    const f = evaluateDoor(DOOR, { status: 401, wwwAuthenticate: challenge, metadataStatus: 404 });
    assert.ok(fails(f).includes('P6_METADATA_UNFETCHABLE'));
  });
});

describe('P7 — the intersection may never invent a capability', () => {
  const advertised = ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.catalog.lookup'];
  test('returning only what was advertised AND requested is clean', () => {
    assert.deepEqual(evaluateIntersection(advertised, ['dev.ucp.shopping.checkout'], ['dev.ucp.shopping.checkout']), []);
  });
  test('returning an UNADVERTISED id FAILS', () => {
    const f = evaluateIntersection(advertised, ['dev.ucp.shopping.order'], ['dev.ucp.shopping.order']);
    assert.ok(fails(f).includes('P7_UNADVERTISED_IN_INTERSECTION'));
  });
  test('returning something the platform never asked for FAILS', () => {
    const f = evaluateIntersection(advertised, ['dev.ucp.shopping.checkout'], ['dev.ucp.shopping.catalog.lookup']);
    assert.ok(fails(f).includes('P7_UNREQUESTED_IN_INTERSECTION'));
  });
  test('the active list is read from either response shape', () => {
    assert.deepEqual(readActiveIds({ active_capabilities: [{ id: 'a' }] }), ['a']);
    assert.deepEqual(readActiveIds({ ucp: { capabilities: { a: [{}] } } }), ['a']);
    assert.deepEqual(readActiveIds({ capabilities: ['a'] }), ['a']);
    assert.deepEqual(readActiveIds({}), []);
  });
});
