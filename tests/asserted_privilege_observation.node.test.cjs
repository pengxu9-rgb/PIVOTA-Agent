'use strict';

// The measurement that unblocks the self-asserted `partner_tier` fix.
//
// `buildRawAuthClaims` resolves partner_tier from request metadata and request headers — every source
// caller-controlled — and `partnerTierPolicies` hands `flagship` a 90 rpm / 12,000-per-day budget and
// `allow_checkout_handoff`. The no-fallback fix is to delete those sources and refuse an unprovable
// assertion, but that sends every caller to `none` (20 rpm, or 0), and prod logs had no retained evidence
// about who relies on it. These pin the observer that answers the question going forwards.
//
// What must stay true: SILENT when nothing is asserted (so any emitted line is a finding, and the hot path
// pays nothing), COMPLETE across every source buildRawAuthClaims reads (under-counting would make the
// enforcement decision on incomplete data), and NEVER carrying a credential.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  observeAssertedPrivilege,
  resolveCredentialPartnerTier,
  PARTNER_TIER_SOURCES,
} = require('../src/services/assertedPrivilegeObservation');

test('silent when nothing is asserted — the common case', () => {
  assert.equal(
    observeAssertedPrivilege({
      req: { headers: {}, invokeAuth: { key_fingerprint: 'fp_1' } },
      operation: 'find_products_multi',
      metadata: {},
    }),
    null,
  );
  assert.equal(observeAssertedPrivilege(), null, 'must tolerate being called with nothing');
});

test('catches a tier asserted through metadata', () => {
  const out = observeAssertedPrivilege({
    req: { headers: {}, invokeAuth: { key_fingerprint: 'fp_1', agent_id: 'agent_x' } },
    operation: 'GET_PDP_V2',
    metadata: { partner_tier: 'flagship' },
  });

  assert.equal(out.asserted_partner_tier, 'flagship');
  assert.equal(out.asserted_partner_tier_source, 'metadata.partner_tier');
  assert.equal(out.operation, 'get_pdp_v2');
  assert.equal(out.key_fingerprint, 'fp_1');
  assert.equal(out.agent_id, 'agent_x');
});

test('catches a tier asserted through either header spelling', () => {
  for (const header of ['x-pivota-partner-tier', 'X-Partner-Tier']) {
    const out = observeAssertedPrivilege({
      req: { headers: { [header]: 'flagship' } },
      operation: 'find_products',
      metadata: {},
    });
    assert.ok(out, `${header} must be observed`);
    assert.equal(out.asserted_partner_tier, 'flagship');
    assert.match(out.asserted_partner_tier_source, /^header:/);
  }
});

test('COVERS EVERY SOURCE buildRawAuthClaims READS — a missed one under-counts silently', () => {
  // If a source is added to buildRawAuthClaims and not here, this observation quietly under-reports and the
  // enforcement decision gets made on incomplete data. Assert the list, and assert each entry actually fires.
  assert.deepEqual(
    PARTNER_TIER_SOURCES.map((s) => s.source),
    [
      'metadata.partner_tier',
      'metadata.partnerTier',
      'header:x-pivota-partner-tier',
      'header:x-partner-tier',
    ],
  );

  const byMetadata = (key) =>
    observeAssertedPrivilege({ req: { headers: {} }, metadata: { [key]: 'approved' } });
  const byHeader = (name) =>
    observeAssertedPrivilege({ req: { headers: { [name]: 'approved' } }, metadata: {} });

  assert.equal(byMetadata('partner_tier').asserted_partner_tier_source, 'metadata.partner_tier');
  assert.equal(byMetadata('partnerTier').asserted_partner_tier_source, 'metadata.partnerTier');
  assert.equal(byHeader('x-pivota-partner-tier').asserted_partner_tier_source, 'header:x-pivota-partner-tier');
  assert.equal(byHeader('x-partner-tier').asserted_partner_tier_source, 'header:x-partner-tier');
});

test('enforcement_would_downgrade is the decision field, and it is true today', () => {
  // The credential carries no tier — introspection returns agent-level identity only — so every asserted tier
  // is currently unprovable. A sustained zero on this counter is the green light to ship enforcement.
  const out = observeAssertedPrivilege({
    req: { headers: {}, invokeAuth: { key_fingerprint: 'fp_1' } },
    metadata: { partner_tier: 'flagship' },
  });
  assert.equal(out.credential_partner_tier, null);
  assert.equal(out.enforcement_would_downgrade, true);

  // …and it goes false the moment a credential can prove the same tier, so the field stays meaningful when
  // introspection starts returning one.
  const proven = observeAssertedPrivilege({
    req: { headers: {}, invokeAuth: { key_fingerprint: 'fp_1', partner_tier: 'flagship' } },
    metadata: { partner_tier: 'flagship' },
  });
  assert.equal(proven.credential_partner_tier, 'flagship');
  assert.equal(proven.enforcement_would_downgrade, false);
});

test('the sibling self-asserted identity fields are counted by NAME, not by value', () => {
  const out = observeAssertedPrivilege({
    req: { headers: {} },
    metadata: { org_id: 'org_victim', principal_id: 'someone_else', agent_id: 'agent_claimed' },
  });

  assert.deepEqual(out.other_asserted_fields.sort(), ['agent_id', 'org_id', 'principal_id']);
  // Values are caller-supplied strings that could carry anything. This is a measurement, not an audit trail.
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('org_victim'));
  assert.ok(!serialized.includes('someone_else'));
});

test('an assertion on a sibling field alone still emits', () => {
  const out = observeAssertedPrivilege({ req: { headers: {} }, metadata: { org_id: 'org_1' } });
  assert.ok(out);
  assert.equal(out.asserted_partner_tier, null);
  assert.deepEqual(out.other_asserted_fields, ['org_id']);
});

test('NEVER carries a credential', () => {
  const out = observeAssertedPrivilege({
    req: {
      headers: {
        authorization: 'Bearer ak_live_secret_value',
        'x-api-key': 'ak_live_secret_value',
        'x-checkout-token': 'tok_secret_value',
        'x-partner-tier': 'flagship',
      },
      invokeAuth: { key_fingerprint: 'fp_1', raw_token: 'ak_live_secret_value' },
    },
    metadata: { partner_tier: 'flagship' },
  });

  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('ak_live_secret_value'), 'must not carry an api key');
  assert.ok(!serialized.includes('tok_secret_value'), 'must not carry a checkout token');
  assert.ok(serialized.includes('fp_1'), 'the fingerprint IS the point — it identifies without exposing');
});

test('resolveCredentialPartnerTier returns null today, by fact and not by stub', () => {
  assert.equal(resolveCredentialPartnerTier({ agent_id: 'a', key_fingerprint: 'f', auth_mode: 'api_key' }), null);
  assert.equal(resolveCredentialPartnerTier({}), null);
  assert.equal(resolveCredentialPartnerTier({ partner_tier: 'flagship' }), 'flagship');
});
