const test = require('node:test');
const assert = require('node:assert/strict');

const {
  POLICY_VERSION,
  REASON_CODES,
  deriveTrust,
} = require('../src/services/catalogTrustPolicy');

// Fixed clock for freshness tests.
const NOW = new Date('2026-05-26T12:00:00Z');
function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

// NB: this id must NOT be one of testMerchantPolicy's rigs. It used to be
// merch_efbc46b4619cfbdf — the founder's test store — so the whole happy path
// was modelled on a rig, and every 'resolves to public' assertion here started
// failing the moment the trust policy learned to block rigs (2026-07-27).
function activeMerchantProduct(overrides = {}) {
  return {
    product_key: 'pk_internal_1',
    content_key: 'ck_internal_1',
    source_domain: 'chydan.myshopify.com',
    merchant_id: 'merch_first_party_seller_1',
    platform: 'shopify',
    source_system: 'shopify',
    source_ref: 'gid://shopify/Product/1',
    source_product_id: '1',
    sync_status: 'live',
    suppression_reason: null,
    last_seen_in_sync_at: daysAgo(1),
    ...overrides,
  };
}

function approvedIdentity(overrides = {}) {
  return {
    source_listing_ref: 'merch_first_party_seller_1:1',
    identity_status: 'approved',
    identity_confidence: 0.95,
    live_read_enabled: true,
    review_required: false,
    sellable_item_group_id: 'sig_1c7611cfd2520d64ad08f3c36b2ef016',
    product_line_id: 'pl_niacinamide',
    review_family_id: 'rf_niacinamide_10',
    ...overrides,
  };
}

function eligibleIps(overrides = {}) {
  return {
    serving_eligible: true,
    pipeline_stage: 'serving',
    blocker_code: null,
    content_quality_score: 0.8,
    quality_scored_at: daysAgo(1),
    last_extracted_at: daysAgo(1),
    ...overrides,
  };
}

function activeMerchantStore(overrides = {}) {
  return {
    merchant_id: 'merch_first_party_seller_1',
    platform: 'shopify',
    domain: 'chydan.myshopify.com',
    status: 'active',
    last_sync: daysAgo(1),
    ...overrides,
  };
}

function activeExternalSeed(overrides = {}) {
  return {
    id: 4242,
    status: 'active',
    domain: 'theordinary.com',
    attached_product_key: 'pk_seed_1',
    last_seen_at: daysAgo(1),
    ...overrides,
  };
}

function externalSeedProduct(overrides = {}) {
  // Catalog row that mirrors an external_seed source (third-party scrape).
  // Identity gates apply to these because the merchant is NOT the source of
  // truth — see c1.v0.3 first-party carve-out for the contrast.
  return activeMerchantProduct({
    product_key: 'pk_seed_1',
    content_key: 'ck_seed_1',
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_system: 'external_product_seeds',
    source_ref: 'ext_4242',
    source_product_id: 'ext_4242',
    source_domain: 'theordinary.com',
    ...overrides,
  });
}

function call(overrides = {}) {
  return deriveTrust({
    subject_type: 'product',
    subject_key: 'pk_internal_1',
    product: activeMerchantProduct(),
    identity: approvedIdentity(),
    ips: eligibleIps(),
    merchant_store: activeMerchantStore(),
    now: NOW,
    ...overrides,
  });
}

function callExternalSeed(overrides = {}) {
  return deriveTrust({
    subject_type: 'product',
    subject_key: 'pk_seed_1',
    product: externalSeedProduct(),
    identity: approvedIdentity({ source_listing_ref: 'external_seed:ext_4242' }),
    ips: eligibleIps(),
    external_seed: activeExternalSeed(),
    now: NOW,
    ...overrides,
  });
}

function observedSellerProduct(overrides = {}) {
  // ADR-009: an external seed mirrored under its per-brand observed seller
  // (merch_obs_…) instead of the legacy 'external_seed' merchant bucket.
  return externalSeedProduct({
    product_key: 'pk_obs_1',
    content_key: 'ck_obs_1',
    merchant_id: 'merch_obs_8887b6c53f029191',
    source_domain: 'goongbe.us',
    ...overrides,
  });
}

function callObservedSeller(overrides = {}) {
  return deriveTrust({
    subject_type: 'product',
    subject_key: 'pk_obs_1',
    product: observedSellerProduct(),
    identity: approvedIdentity({ source_listing_ref: 'merch_obs_8887b6c53f029191:ext_4242' }),
    ips: eligibleIps(),
    external_seed: activeExternalSeed(),
    now: NOW,
    ...overrides,
  });
}

// ---- HAPPY PATH -------------------------------------------------------------

test('approved merchant row with eligible IPS resolves to public', () => {
  const trust = call();
  assert.equal(trust.serving_decision, 'public');
  assert.equal(trust.source_lifecycle_state, 'active');
  assert.equal(trust.identity_status, 'approved');
  assert.equal(trust.freshness_state, 'fresh');
  assert.deepEqual(trust.serving_reason_codes, [REASON_CODES.PUBLIC_PASSTHROUGH]);
  assert.equal(trust.policy_version, POLICY_VERSION);
});

// ---- HARD BLOCKS ------------------------------------------------------------

test('tombstoned catalog row blocks regardless of identity', () => {
  const trust = call({
    product: activeMerchantProduct({ suppression_reason: 'stale_after_sync' }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.equal(trust.source_lifecycle_state, 'tombstoned');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.ROW_TOMBSTONED));
});

test('inactive external seed blocks even with IPS eligible', () => {
  const trust = call({
    external_seed: activeExternalSeed({ status: 'disabled' }),
    merchant_store: null,
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.equal(trust.source_lifecycle_state, 'inactive');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.EXTERNAL_SEED_INACTIVE));
});

test('inactive merchant store blocks', () => {
  const trust = call({
    merchant_store: activeMerchantStore({ status: 'inactive' }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.equal(trust.source_lifecycle_state, 'inactive');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.MERCHANT_STORE_INACTIVE));
});

test('quarantined domain blocks', () => {
  const trust = call({
    active_quarantines: [{
      match_type: 'domain',
      match_value: 'CHYDAN.MyShopify.com',
      state: 'active',
      expires_at: null,
    }],
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.equal(trust.source_lifecycle_state, 'quarantined');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.SOURCE_QUARANTINED));
});

test('expired quarantine does not match', () => {
  const expiredAt = new Date(NOW.getTime() - 1000);
  const trust = call({
    now: NOW,
    active_quarantines: [{
      match_type: 'domain',
      match_value: 'chydan.myshopify.com',
      state: 'active',
      expires_at: expiredAt,
    }],
  });
  // expires_at <= now → not quarantined
  assert.notEqual(trust.source_lifecycle_state, 'quarantined');
});

test('IPS not serving_eligible blocks', () => {
  const trust = call({ ips: eligibleIps({ serving_eligible: false }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('sync_status != live blocks (catalog row not promoted)', () => {
  const trust = call({ product: activeMerchantProduct({ sync_status: 'stale' }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.PUBLISH_STATE_NOT_PUBLIC));
});

test('identity_status=conflict blocks', () => {
  const trust = call({ identity: approvedIdentity({ identity_status: 'conflict' }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFLICT));
});

test('suppressed offer blocks', () => {
  const trust = deriveTrust({
    subject_type: 'offer',
    subject_key: 'offer_1',
    product: activeMerchantProduct(),
    offer: { suppression_reason: 'price_anomaly' },
    identity: approvedIdentity(),
    ips: eligibleIps(),
    merchant_store: activeMerchantStore(),
    now: NOW,
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.OFFER_SUPPRESSED));
});

// ---- SHADOW (the 580-violation gate, external_seed cohort) ------------------

test('external_seed: no identity row → shadow with IDENTITY_CONFIDENCE_NULL', () => {
  // 504 of audit's 580 — IPS-eligible external mirror rows without identity row.
  const trust = callExternalSeed({ identity: null });
  assert.equal(trust.serving_decision, 'shadow');
  assert.equal(trust.identity_status, 'unknown');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
});

test('external_seed: review_required with live_read_enabled → shadow (audit\'s 60 cases)', () => {
  const trust = callExternalSeed({
    identity: approvedIdentity({
      source_listing_ref: 'external_seed:ext_4242',
      identity_status: 'review_required',
      live_read_enabled: true,
      review_required: true,
    }),
  });
  assert.equal(trust.serving_decision, 'shadow');
  assert.equal(trust.identity_status, 'review_required');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_REVIEW_REQUIRED_LIVE_READ));
});

test('external_seed: approved + live_read disabled → shadow', () => {
  const trust = callExternalSeed({
    identity: approvedIdentity({ source_listing_ref: 'external_seed:ext_4242', live_read_enabled: false }),
  });
  assert.equal(trust.serving_decision, 'shadow');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_LIVE_READ_DISABLED));
});

test('external_seed: approved + null confidence → shadow', () => {
  const trust = callExternalSeed({
    identity: approvedIdentity({ source_listing_ref: 'external_seed:ext_4242', identity_confidence: null }),
  });
  assert.equal(trust.serving_decision, 'shadow');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
});

test('external_seed: approved + review_required flag set → degrades to shadow', () => {
  // catches the case where status=approved but review_required=true was set
  // by a later signal — the audit cited readers that ignore review_required.
  const trust = callExternalSeed({
    identity: approvedIdentity({ source_listing_ref: 'external_seed:ext_4242', review_required: true }),
  });
  assert.equal(trust.serving_decision, 'shadow');
  assert.equal(trust.identity_status, 'review_required');
});

// ---- IPS-NULL EXTERNAL_SEED BLOCK (c1.v0.4) ---------------------------------
//
// Phase 3c parity surfaced 80 external_seed catalog rows with public trust but
// no index_pipeline_state row. c1.v0.4 closes this: external_seed catalogs
// require IPS to opine (existence + serving_eligible=true). First-party rows
// keep the legacy "ips=null means OK" behavior because IPS doesn't process
// them by design.

test('external_seed: no IPS row → blocked with INDEX_NOT_SERVING_ELIGIBLE (c1.v0.4)', () => {
  const trust = callExternalSeed({ ips: null });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('external_seed: IPS row present + serving_eligible=true → public (unchanged)', () => {
  const trust = callExternalSeed();
  assert.equal(trust.serving_decision, 'public');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.PUBLIC_PASSTHROUGH));
});

test('external_seed: IPS row present + serving_eligible=false → blocked (unchanged)', () => {
  const trust = callExternalSeed({ ips: eligibleIps({ serving_eligible: false }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('first-party: no IPS row → public (c1.v0.4 keeps the c1.v0.3 carve-out)', () => {
  // MOYU/GR/PawStyle case — first-party merchants don't get IPS coverage, but
  // the merchant is the source of truth, so absence of IPS does not block.
  const trust = call({ ips: null });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('first-party: IPS row present + serving_eligible=false STILL blocks (unchanged)', () => {
  const trust = call({ ips: eligibleIps({ serving_eligible: false }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

// ---- FIRST-PARTY CARVE-OUT (c1.v0.3) ----------------------------------------
//
// Internal merchants (anything that's not external_seed) are the source of
// truth for their own products. The identity pipeline exists to verify scraped
// third-party content; first-party merchants get a separate, looser gate.

test('first-party: no identity row → public with IDENTITY_NOT_APPLICABLE_FIRST_PARTY', () => {
  // Reproduces the MOYU/GR test-merchant case: no pdp_identity_listing row,
  // IPS eligible, sync_status=live. Legacy gates shadowed these; c1.v0.3
  // serves them.
  const trust = call({ identity: null });
  assert.equal(trust.serving_decision, 'public');
  assert.equal(trust.identity_status, 'unknown');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
});

test('first-party: approved identity but null confidence → public (first-party exempt)', () => {
  const trust = call({
    identity: approvedIdentity({ identity_confidence: null }),
  });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
});

test('first-party: approved + live_read disabled → public (live_read is for external content)', () => {
  const trust = call({
    identity: approvedIdentity({ live_read_enabled: false }),
  });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_LIVE_READ_DISABLED));
});

test('first-party: review_required STILL gates to shadow (moderation signal, not identity gap)', () => {
  const trust = call({
    identity: approvedIdentity({
      identity_status: 'review_required',
      live_read_enabled: true,
      review_required: true,
    }),
  });
  assert.equal(trust.serving_decision, 'shadow');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_REVIEW_REQUIRED_LIVE_READ));
});

test('first-party: identity_status=conflict STILL blocks (data quality issue)', () => {
  const trust = call({
    identity: approvedIdentity({ identity_status: 'conflict' }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFLICT));
});

test('first-party: hard gates (suppression, IPS, sync_status) STILL block regardless of identity', () => {
  const tombstoned = call({
    product: activeMerchantProduct({ suppression_reason: 'manual_takedown' }),
    identity: null,
  });
  assert.equal(tombstoned.serving_decision, 'blocked');
  assert.ok(tombstoned.serving_reason_codes.includes(REASON_CODES.ROW_TOMBSTONED));

  const ipsBlocked = call({
    identity: null,
    ips: eligibleIps({ serving_eligible: false }),
  });
  assert.equal(ipsBlocked.serving_decision, 'blocked');
  assert.ok(ipsBlocked.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));

  const archived = call({
    product: activeMerchantProduct({ sync_status: 'archived' }),
    identity: null,
  });
  assert.equal(archived.serving_decision, 'blocked');
  assert.ok(archived.serving_reason_codes.includes(REASON_CODES.PUBLISH_STATE_NOT_PUBLIC));
});

// ---- OVERRIDES --------------------------------------------------------------

test('active force_exact_group override forces approved + confidence 1', () => {
  const trust = call({
    identity: approvedIdentity({ identity_status: 'review_required', identity_confidence: 0.2 }),
    override: { id: 'ov_99', action_type: 'force_exact_group', active: true },
  });
  assert.equal(trust.identity_status, 'approved');
  assert.equal(trust.identity_confidence, 1.0);
  assert.equal(trust.serving_decision, 'public');
  assert.equal(trust.manual_override_id, 'ov_99');
});

test('active force_review_required override degrades to shadow', () => {
  const trust = call({
    override: { id: 'ov_100', action_type: 'force_review_required', active: true },
  });
  assert.equal(trust.identity_status, 'review_required');
  assert.equal(trust.serving_decision, 'shadow');
});

test('inactive override is ignored', () => {
  const trust = call({
    override: { id: 'ov_1', action_type: 'force_review_required', active: false },
  });
  assert.equal(trust.serving_decision, 'public');
});

// ---- FRESHNESS --------------------------------------------------------------

test('last_seen 1d ago → fresh', () => {
  const trust = call({
    product: activeMerchantProduct({ last_seen_in_sync_at: daysAgo(1) }),
    ips: eligibleIps({ last_extracted_at: null, quality_scored_at: null }),
  });
  assert.equal(trust.freshness_state, 'fresh');
});

test('last_seen 14d ago → stale', () => {
  const trust = call({
    product: activeMerchantProduct({ last_seen_in_sync_at: daysAgo(14) }),
    ips: eligibleIps({ last_extracted_at: null, quality_scored_at: null }),
  });
  assert.equal(trust.freshness_state, 'stale');
});

test('last_seen 60d ago → expired', () => {
  const trust = call({
    product: activeMerchantProduct({ last_seen_in_sync_at: daysAgo(60) }),
    ips: eligibleIps({ last_extracted_at: null, quality_scored_at: null }),
  });
  assert.equal(trust.freshness_state, 'expired');
});

test('no timestamps anywhere → unverified', () => {
  const trust = call({
    product: activeMerchantProduct({ last_seen_in_sync_at: null }),
    ips: eligibleIps({ last_extracted_at: null, quality_scored_at: null }),
    merchant_store: activeMerchantStore({ last_sync: null }),
  });
  assert.equal(trust.freshness_state, 'unverified');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.FRESHNESS_UNVERIFIED));
});

// ---- VALIDATION -------------------------------------------------------------

test('invalid subject_type throws', () => {
  assert.throws(
    () => deriveTrust({ subject_type: 'banana', subject_key: 'x' }),
    /invalid subject_type/,
  );
});

test('missing subject_key throws', () => {
  assert.throws(
    () => deriveTrust({ subject_type: 'product', subject_key: '' }),
    /subject_key is required/,
  );
});

// ---- SHAPE CONTRACT ---------------------------------------------------------

test('output row has all migration columns and reason_codes is bounded vocab', () => {
  const trust = call();
  const expectedKeys = [
    'subject_type', 'subject_key', 'product_key', 'source_listing_ref',
    'content_key', 'source_id', 'source_domain',
    'source_lifecycle_state', 'source_last_checked_at',
    'identity_status', 'identity_confidence',
    'matched_product_key', 'matched_content_key', 'matched_sellable_item_group_id',
    'freshness_state', 'last_verified_at', 'verification_source',
    'serving_decision', 'serving_reason_codes',
    'manual_override_id', 'policy_version',
  ];
  for (const k of expectedKeys) {
    assert.ok(k in trust, `missing key: ${k}`);
  }
  const vocab = new Set(Object.values(REASON_CODES));
  for (const r of trust.serving_reason_codes) {
    assert.ok(vocab.has(r), `reason code not in vocabulary: ${r}`);
  }
});

// ---- ADR-009 OBSERVED-SELLER TIER (Option C) --------------------------------
//
// merch_obs_ observed sellers are external-seed CONTENT (subject to the index/
// quality gate, like the legacy 'external_seed' lump) but are the brand's own
// authoritative D2C crawl (exempt from the identity-COVERAGE shadow gates, like
// a first-party merchant). Hard identity gates still apply.

test('observed_seller: no IPS row → blocked like external_seed (gate applies)', () => {
  const trust = callObservedSeller({ ips: null });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('observed_seller: IPS present + serving_eligible=true → public', () => {
  const trust = callObservedSeller();
  assert.equal(trust.serving_decision, 'public');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.PUBLIC_PASSTHROUGH));
});

test('observed_seller: IPS present + serving_eligible=false → blocked', () => {
  const trust = callObservedSeller({ ips: eligibleIps({ serving_eligible: false }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('observed_seller: no identity row → public, exempt from coverage gate (Option C)', () => {
  // Key behavior: unlike the legacy 'external_seed' lump (IDENTITY_CONFIDENCE_NULL
  // shadow), an observed seller's own D2C crawl is authoritative and exempt.
  const trust = callObservedSeller({ identity: null });
  assert.equal(trust.serving_decision, 'public');
  assert.equal(trust.identity_status, 'unknown');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
});

test('observed_seller: approved + null confidence → public (exempt)', () => {
  const trust = callObservedSeller({ identity: approvedIdentity({ identity_confidence: null }) });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
});

test('observed_seller: identity_status=conflict STILL blocks (hard gate)', () => {
  const trust = callObservedSeller({ identity: approvedIdentity({ identity_status: 'conflict' }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFLICT));
});

test('observed_seller: review_required STILL shadows (hard gate)', () => {
  const trust = callObservedSeller({ identity: approvedIdentity({ review_required: true }) });
  assert.notEqual(trust.serving_decision, 'public');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_REVIEW_REQUIRED_LIVE_READ));
});

// ---- c1.v0.5: CATALOG_TRUST_RENDERABLE_GATE --------------------------------
//
// Mirrors tests/test_catalog_trust_policy.py case-for-case. The gap this
// closes: 1,825 rows were 'public' while the invariant said their PDP could not
// render. Measured live 2026-07-25 — 449 render perfectly (the invariant was
// wrong) and 1,376 serve a hard HTTP 500, not a shell. Blocking those 1,376
// darkens 1,011 products with no renderable sibling row, so it is flag-gated.

function withRenderableGate(value, fn) {
  const previous = process.env.CATALOG_TRUST_RENDERABLE_GATE;
  if (value === null) delete process.env.CATALOG_TRUST_RENDERABLE_GATE;
  else process.env.CATALOG_TRUST_RENDERABLE_GATE = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CATALOG_TRUST_RENDERABLE_GATE;
    else process.env.CATALOG_TRUST_RENDERABLE_GATE = previous;
  }
}

test('renderable gate OFF by default leaves an unrenderable row public', () => {
  const trust = withRenderableGate(null, () => call({ pdp_route_resolvable: false }));
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.PDP_ROUTE_UNRESOLVABLE));
});

test('renderable gate ON blocks a row with no PDP content route', () => {
  const trust = withRenderableGate('true', () => call({ pdp_route_resolvable: false }));
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.PDP_ROUTE_UNRESOLVABLE));
});

test('renderable gate ON leaves a renderable row public', () => {
  const trust = withRenderableGate('on', () => call({ pdp_route_resolvable: true }));
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.PDP_ROUTE_UNRESOLVABLE));
});

test('renderable gate ON is inert when the input is absent (tri-state)', () => {
  // A producer not yet taught to compute the input supplies nothing. Reading
  // that as "not renderable" would mass-demote the catalog.
  const trust = withRenderableGate('1', () => call());
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.PDP_ROUTE_UNRESOLVABLE));
});

test('renderable gate does not mask an earlier block reason', () => {
  const trust = withRenderableGate('1', () =>
    call({ ips: eligibleIps({ serving_eligible: false }), pdp_route_resolvable: false }),
  );
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.PDP_ROUTE_UNRESOLVABLE));
});

// ---- c1.v0.5 parity repairs (arms the Python twin had and this one did not) --

test('observed_seller with seed_kind=cross is NOT identity-coverage exempt', () => {
  // A retailer-sourced observed seller (no-D2C brand crawled from a
  // marketplace) is not authoritative for its own content, so a missing
  // identity must shadow rather than pass through as brand-official. Python
  // has enforced this since the ADR-009 amendment; Node did not, so the two
  // twins disagreed live on these rows.
  const trust = callObservedSeller({
    product: observedSellerProduct({ seed_kind: 'cross' }),
    identity: null,
  });
  assert.notEqual(trust.serving_decision, 'public');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
});

test('observed_seller with seed_kind=self keeps the exemption', () => {
  const trust = callObservedSeller({
    product: observedSellerProduct({ seed_kind: 'self' }),
    identity: null,
  });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY));
});

test('INDEX_ELIGIBLE_READ widening matches the Python twin', () => {
  const previous = process.env.INDEX_ELIGIBLE_READ;
  try {
    delete process.env.INDEX_ELIGIBLE_READ;
    const off = call({ ips: eligibleIps({ serving_eligible: false, index_eligible: true }) });
    assert.equal(off.serving_decision, 'blocked');

    process.env.INDEX_ELIGIBLE_READ = 'true';
    const on = call({ ips: eligibleIps({ serving_eligible: false, index_eligible: true }) });
    assert.notEqual(on.serving_decision, 'blocked');

    const neither = call({ ips: eligibleIps({ serving_eligible: false, index_eligible: false }) });
    assert.equal(neither.serving_decision, 'blocked');
  } finally {
    if (previous === undefined) delete process.env.INDEX_ELIGIBLE_READ;
    else process.env.INDEX_ELIGIBLE_READ = previous;
  }
});

test('POLICY_VERSION is pinned to the Python twin', () => {
  // A version MISMATCH between the twins is the catastrophic failure mode.
  // Both repos write the same catalog_row_trust table against one Postgres and
  // the UPSERT refreshes a row whenever policy_version differs. pivota-backend
  // stamps rows from a 6h cron; THIS repo stamps them from prod RUNTIME
  // (pdpIdentityGraph calls upsertCatalogRowTrustForSourceListingRefs on every
  // live-read promotion and identity override). A split-brain rewrites ~14k
  // rows forever and makes /__trust_health's version_distribution a permanent
  // false alarm.
  //
  // Nothing pinned this string before, in either repo — reverting the bump left
  // every test green. Bump it here AND in pivota-backend
  // services/catalog_trust_policy.py, and merge the two PRs back to back
  // (backend first).
  assert.equal(POLICY_VERSION, 'c1.v0.5');
});

// ---- TEST/DEMO MERCHANT GATE (2026-07-27) -----------------------------------
//
// Closes the Regime B gap from the ADR-018 census: before this arm, the only
// thing keeping a rig out of 'public' HERE was suppression data, not policy.

test('rig merchant that would otherwise be public is blocked', () => {
  const trust = call({
    product: activeMerchantProduct({ merchant_id: 'merch_test_ownist_001' }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.TEST_MERCHANT_EXCLUDED));
});

test('every baked-in rig id is blocked by the gate', () => {
  const { TEST_MERCHANT_IDS } = require('../src/services/testMerchantPolicy');
  for (const id of TEST_MERCHANT_IDS) {
    const trust = call({ product: activeMerchantProduct({ merchant_id: id }) });
    assert.equal(trust.serving_decision, 'blocked', `${id} should be blocked`);
    assert.ok(
      trust.serving_reason_codes.includes(REASON_CODES.TEST_MERCHANT_EXCLUDED),
      `${id} should carry TEST_MERCHANT_EXCLUDED`,
    );
  }
});

// This is the test that pins the no-POLICY_VERSION-bump argument: an
// already-blocked rig must keep reporting its REAL reason, so output stays
// byte-identical on every row that exists in prod today.
// Guards every negative assertion below: `!includes(undefined)` is vacuously
// true, so if TEST_MERCHANT_EXCLUDED were ever dropped from REASON_CODES these
// would pass while proving nothing. The Python twin raises AttributeError and
// is safe by construction; this keeps the JS suite equally strict.
test('TEST_MERCHANT_EXCLUDED exists in the reason-code vocabulary', () => {
  assert.equal(REASON_CODES.TEST_MERCHANT_EXCLUDED, 'TEST_MERCHANT_EXCLUDED');
});

test('already-blocked rig keeps its real reason, not TEST_MERCHANT_EXCLUDED', () => {
  const trust = call({
    product: activeMerchantProduct({
      merchant_id: 'merch_test_ownist_001',
      suppression_reason: 'demo_retired_2026_07',
    }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.equal(trust.source_lifecycle_state, 'tombstoned');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.ROW_TOMBSTONED));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.TEST_MERCHANT_EXCLUDED));
});

test('non-rig merchant is unaffected', () => {
  const trust = call();
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.TEST_MERCHANT_EXCLUDED));
});

// The gate must not read the env hatch: catalog_row_trust is shared state and a
// per-service env var would make the twins disagree and flap rows.
test('env hatch does NOT affect the trust gate (twins share this table)', () => {
  const prev = process.env.PIVOTA_TEST_MERCHANT_IDS;
  process.env.PIVOTA_TEST_MERCHANT_IDS = 'merch_env_only_rig';
  try {
    const trust = call({
      product: activeMerchantProduct({ merchant_id: 'merch_env_only_rig' }),
    });
    assert.equal(trust.serving_decision, 'public');
    assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.TEST_MERCHANT_EXCLUDED));
  } finally {
    if (prev === undefined) delete process.env.PIVOTA_TEST_MERCHANT_IDS;
    else process.env.PIVOTA_TEST_MERCHANT_IDS = prev;
  }
});

// The transition the no-POLICY_VERSION-bump argument assumes is EMPTY in prod,
// made explicit so the assumption is testable rather than implied.
// identity_status='review_required' shadows every row — there is no first-party
// or observed-seller exemption from it (unlike the identity-COVERAGE gates), so
// it is the one reachable path by which a rig could have been 'shadow' rather
// than 'blocked'. Census 2026-07-28, grouped by serving_decision (not filtered
// to 'blocked'): all 1,561 rig rows are 'blocked' — zero public AND zero shadow.
test('rig in the shadow lane is blocked', () => {
  const trust = call({
    product: activeMerchantProduct({ merchant_id: 'merch_test_ownist_001' }),
    identity: approvedIdentity({ identity_status: 'review_required' }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.TEST_MERCHANT_EXCLUDED));
});
