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

test('first-party: no IPS row → BLOCKED (c1.v0.5 fails closed for every lane)', () => {
  // This assertion was inverted on 2026-07-31, bringing this repo in line with
  // the Python twin, which has failed closed here since 2026-07-29. It used to
  // read "no IPS row → public" on the c1.v0.3 carve-out.
  //
  // The carve-out ("IPS coverage is sparse for first-party merchants by
  // design") described a corpus where every first-party merchant was a retired
  // test rig, already blocked upstream. The first REAL merchant-sync arrival
  // (the 2026-07-29 Wix pilot) synced 20 rows with content_key NULL — rows that
  // can structurally never have an IPS row — and every one went trust-public
  // with no quality gate; public_not_renderable went red within the hour, and
  // only the gateway's own fail-closed lookup kept them off the wire.
  //
  // An unscored row must not be public. The lifecycle for a fresh sync is
  // blocked -> scored -> eligible -> public. If this assertion is being flipped
  // back to 'public', that lifecycle is being reopened AND this repo is being
  // put back into disagreement with the Python twin over one shared table —
  // measure the blast radius first.
  const trust = call({ ips: null });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('the index gate fails closed on a missing IPS row for EVERY lane', () => {
  // The gap the repair closes was lane-shaped: external-seed content already
  // failed closed here, first-party and merchant-synced content did not. Pin
  // all three lanes so a future edit cannot reintroduce a per-lane carve-out
  // without saying so out loud.
  for (const [lane, trust] of [
    ['first-party', call({ ips: null })],
    ['external_seed', callExternalSeed({ ips: null })],
    ['observed_seller', callObservedSeller({ ips: null })],
  ]) {
    assert.equal(trust.serving_decision, 'blocked', `${lane} must block on a missing IPS row`);
    assert.ok(
      trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE),
      `${lane} must report INDEX_NOT_SERVING_ELIGIBLE`,
    );
  }
});

test('a missing IPS row does not mask an earlier hard block', () => {
  // Ordering pin, and the reason the repair measured ZERO prod rows: all 20
  // rows in the gap set on 2026-07-31 were tombstoned rig rows, and the
  // lifecycle hard-block returns before the index gate is ever reached. If this
  // ordering flips, those rows start reporting INDEX_NOT_SERVING_ELIGIBLE and
  // the reason-code histogram stops being diagnostic.
  const trust = call({
    ips: null,
    product: activeMerchantProduct({ suppression_reason: 'demo_retired_2026_07' }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.ROW_TOMBSTONED));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
});

test('an IPS row with serving_eligible=false is NOT the same as a missing one', () => {
  // `!ips` must mean "no row", not "no opinion". The upserter builds the ips
  // object only when serving_eligible is non-null, so a present-but-false row
  // has to keep flowing through the eligibility branch below — that is what
  // makes the INDEX_ELIGIBLE_READ widening reachable at all.
  const trust = call({ ips: eligibleIps({ serving_eligible: false }) });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
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
  //
  // c1.v0.5 -> c1.v0.6 on 2026-07-31 for the OFFER_PRICE_MISSING gate, which
  // flips 4 measured prod rows 'public' -> 'blocked' and so is a real logic
  // change by the versioning rule.
  //
  // c1.v0.6 -> c1.v0.7 same day for the canonical-election gate
  // (NON_CANONICAL_DUPLICATE), which moves 121 measured prod rows
  // 'public' -> 'shadow'. This repo is the SECOND half of that pair —
  // pivota-backend#1649 is the first. Until both deploy, the twins disagree.
  assert.equal(POLICY_VERSION, 'c1.v0.7');
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

// --- domain normalisation parity with the Python twin -----------------------
// Both this file and services/catalog_trust_policy.py write catalog_row_trust
// for the SAME rows (Node via scripts/sync-external-seeds-to-catalog.cjs,
// Python via the trust cron), so a normalisation split makes serving_decision
// FLAP — last writer wins. Before pivota-backend#1639 a `www.mintree.us`
// quarantine blocked a `mintree.us` row on the Python side and not here, and
// every external-seed sync flipped it back to public.
const DOMAIN_FORMS = ['mintree.us', 'www.mintree.us', 'MINTREE.US', 'WWW.MinTree.US', '  mintree.us  '];

test('quarantine matches across every www./case/whitespace form, both sides', () => {
  for (const rowDomain of DOMAIN_FORMS) {
    for (const matchValue of DOMAIN_FORMS) {
      const trust = call({
        product: activeMerchantProduct({ source_domain: rowDomain }),
        merchant_store: activeMerchantStore({ domain: rowDomain }),
        active_quarantines: [
          { match_type: 'domain', match_value: matchValue, state: 'active', expires_at: null },
        ],
      });
      assert.ok(
        trust.serving_reason_codes.includes(REASON_CODES.SOURCE_QUARANTINED),
        `row=${JSON.stringify(rowDomain)} match_value=${JSON.stringify(matchValue)} not quarantined`,
      );
    }
  }
});

// Blanks are unreachable on this path (the `&& domain` short-circuit fires
// first), so this test documents the real reason they are safe rather than
// claiming the bareDomain guard is what protects them. The Python twin's
// quarantine_matches_source has no such short-circuit and DID match every
// domain-less row against a blank match_value — fixed in the same PR set.
test('a blank match_value quarantines nobody', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const trust = call({
      product: activeMerchantProduct({ source_domain: null }),
      merchant_store: activeMerchantStore({ domain: null }),
      active_quarantines: [
        { match_type: 'domain', match_value: blank, state: 'active', expires_at: null },
      ],
    });
    assert.ok(
      !trust.serving_reason_codes.includes(REASON_CODES.SOURCE_QUARANTINED),
      `blank match_value ${JSON.stringify(blank)} quarantined a domain-less row`,
    );
  }
});

test('lookalike domains are not over-blocked', () => {
  for (const rowDomain of ['notmintree.us', 'shop.mintree.us', 'mintree.us.evil.com']) {
    const trust = call({
      product: activeMerchantProduct({ source_domain: rowDomain }),
      merchant_store: activeMerchantStore({ domain: rowDomain }),
      active_quarantines: [
        { match_type: 'domain', match_value: 'mintree.us', state: 'active', expires_at: null },
      ],
    });
    assert.ok(
      !trust.serving_reason_codes.includes(REASON_CODES.SOURCE_QUARANTINED),
      `${rowDomain} was over-blocked`,
    );
  }
});


// ---- c1.v0.6: OFFER_PRICE_MISSING -------------------------------------------
//
// Mirror of pivota-backend#1649. The gap it closes is GRAIN, not a wrong
// predicate. pivota-backend's index_pipeline_state 'has_price' was always right
// — it asked about an unsuppressed, priced catalog_offers row belonging to the
// catalog_products row in front of it. But index_pipeline_state is keyed by
// CONTENT_KEY and stores the best sibling's state, while trust is keyed by
// PRODUCT_KEY and every product_key mints its own pivota_signature_id — its own
// public PDP. A price-less row sharing a content_key with a priced sibling
// therefore read the sibling's serving_eligible=true and published a price-less
// page.
//
// Measured on prod 2026-07-31: exactly 4 rows, all Tom Ford fragrances, each
// with one unsuppressed offer whose list_price, merchant_effective_price and
// estimated_best_price were ALL NULL — drained by the 2026-07-30 currency
// remediation without being suppressed. 2,535 further rows also lack a priced
// offer of their own and every one is already blocked upstream, which is why
// this gate ships ungated: its entire blast radius is those 4 rows.

test('price gate blocks a row with no priced offer of its own', () => {
  const trust = call({ row_has_priced_offer: false });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.OFFER_PRICE_MISSING));
});

test('price gate leaves a priced row public', () => {
  const trust = call({ row_has_priced_offer: true });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.OFFER_PRICE_MISSING));
});

test('price gate is inert when the input is absent', () => {
  // Tri-state, and the reason it must be. Only the upserter and the backfill
  // driver compute this input. Reading an ABSENT input as "not priced" would
  // mass-demote the catalog the first time any other producer called
  // deriveTrust.
  const trust = call();
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.OFFER_PRICE_MISSING));
});

test('price gate ignores a null input rather than treating it as falsy', () => {
  // `=== false`, not `!rowHasPricedOffer`. null must fall through.
  const trust = call({ row_has_priced_offer: null });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.OFFER_PRICE_MISSING));
});

test('price gate does not mask an earlier block reason', () => {
  // Ordering: the index gate answers for the content_key and runs FIRST, so a
  // row already blocked there keeps reporting INDEX_NOT_SERVING_ELIGIBLE. If
  // this ever flips, the reason-code histogram collapses onto the newest gate
  // and the two grains become indistinguishable in the data.
  const trust = call({
    ips: eligibleIps({ serving_eligible: false }),
    row_has_priced_offer: false,
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE));
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.OFFER_PRICE_MISSING));
});

test('price gate applies to external_seed supply', () => {
  // The 4 prod rows are external-seed mirror rows, so the lane that actually
  // regressed must be covered — not just the first-party fixture.
  const trust = callExternalSeed({ row_has_priced_offer: false });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.OFFER_PRICE_MISSING));
});

test('OFFER_PRICE_MISSING is in the reason vocabulary', () => {
  assert.equal(REASON_CODES.OFFER_PRICE_MISSING, 'OFFER_PRICE_MISSING');
});


// ---- c1.v0.7: NON_CANONICAL_DUPLICATE (the grain bridge) --------------------
//
// index_pipeline_state is keyed by content_key and stores ONE row's state;
// catalog_row_trust is keyed by product_key. content_canonical_election (mig
// 181) elects the ONE sig per content_key that the sitemap advertises and that
// every sibling's PDP names in <link rel="canonical">. Nothing connected the
// two, so a non-elected sibling inherited the content-grained verdict and was
// promoted as though it were the canonical.
//
// Measured on prod 2026-07-31: 121 of 6,814 trust-public rows, ALL on multi-row
// content_keys. The 4 Tom Ford rows behind OFFER_PRICE_MISSING were 4 of them —
// the election had already picked the priced tomfordbeauty.com row correctly in
// every case, which is why this is the general rule and the price gate is now a
// backstop beneath it.

test('a non-elected duplicate SHADOWS rather than blocking', () => {
  // Shadow, not blocked, and the distinction is the whole design. The PDP
  // RENDERER gates on index_pipeline_state.serving_eligible (content grain);
  // public recall/discovery/feed gate on serving_decision='public' (row grain,
  // catalogServingIndex). Shadow drops the duplicate out of promotion while its
  // page keeps answering 200 with rel=canonical intact. Blocking would 404 URLs
  // Google may already have indexed and destroy the canonical signal.
  const trust = call({ row_is_elected_canonical: false });
  assert.equal(trust.serving_decision, 'shadow');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.NON_CANONICAL_DUPLICATE));
});

test('the elected canonical stays public', () => {
  const trust = call({ row_is_elected_canonical: true });
  assert.equal(trust.serving_decision, 'public');
  assert.ok(!trust.serving_reason_codes.includes(REASON_CODES.NON_CANONICAL_DUPLICATE));
});

test('an absent election never demotes', () => {
  // 32 multi-row content_keys still have NO election row and the join
  // legitimately yields NULL. Unlike the other tri-states here, null is a NORMAL
  // production value — reading it as "not canonical" would shadow every
  // uncovered row.
  assert.equal(call().serving_decision, 'public');
  assert.equal(call({ row_is_elected_canonical: null }).serving_decision, 'public');
});

test('a non-elected duplicate does not mask a hard block', () => {
  // The election gate lives in the SHADOW block, reached only after every hard
  // block has passed. A tombstoned duplicate keeps reporting ROW_TOMBSTONED.
  const trust = call({
    row_is_elected_canonical: false,
    product: activeMerchantProduct({ suppression_reason: 'demo_retired_2026_07' }),
  });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.ROW_TOMBSTONED));
});

test('the price gate still BLOCKS a non-elected duplicate', () => {
  // Defence in depth. OFFER_PRICE_MISSING is a hard block and runs first, so a
  // duplicate that is also price-less stays blocked rather than being softened
  // to shadow. If this ever inverts, the 4 Tom Ford rows quietly return to a
  // rendering state with no price.
  const trust = call({ row_is_elected_canonical: false, row_has_priced_offer: false });
  assert.equal(trust.serving_decision, 'blocked');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.OFFER_PRICE_MISSING));
});

test('NON_CANONICAL_DUPLICATE applies to external_seed supply', () => {
  const trust = callExternalSeed({ row_is_elected_canonical: false });
  assert.equal(trust.serving_decision, 'shadow');
  assert.ok(trust.serving_reason_codes.includes(REASON_CODES.NON_CANONICAL_DUPLICATE));
});

// ---------------------------------------------------------------------------
// ADR-009 — trust classification follows the seed LANE, not the retired seller.
//
// Three readers here asked about the sentinel merchant or retyped the
// observed-seller prefix. The A9-4 re-key moved scraped supply onto per-brand
// observed sellers, so `merchant_id === 'external_seed'` is now permanently
// false for every catalog row and `deriveVerificationSource` began reporting
// SCRAPED rows as merchant syncs — it falls through to the platform arms.
//
// NOTE for whoever edits these: `verification_source` names whichever freshness
// SIGNAL is newest, not the row's class — so each fixture makes the product's
// own sync the most recent, or `identity_resolver` wins and the test measures
// the picker instead of the classifier. That mistake cost a red run here.
// ---------------------------------------------------------------------------

test('verification_source: a re-keyed mirror row is still a SCRAPE, not a sync', () => {
  // The row mirrors a shopify storefront, so the platform arm below would claim
  // 'shopify_sync' — which is exactly what shipped after the re-key.
  const trust = call({
    product: activeMerchantProduct({
      merchant_id: 'merch_obs_7f3a2b1c9d4e5f60',
      platform: 'shopify',
      source_system: 'external_product_seeds_mirror_v1',
      last_seen_in_sync_at: NOW,
    }),
    ips: eligibleIps({ last_extracted_at: daysAgo(5), quality_scored_at: daysAgo(5) }),
  });
  assert.equal(trust.verification_source, 'external_seed_scrape');
});

test('verification_source: the MINTED lane is a scrape too (no ext_ id, shopify platform)', () => {
  const trust = call({
    product: activeMerchantProduct({
      merchant_id: 'merch_obs_7f3a2b1c9d4e5f60',
      platform: 'shopify',
      source_system: 'catalog_enrichment_agent_v1',
      source_product_id: 'ilia-the-spf-and-go-makeup-edit',
      last_seen_in_sync_at: NOW,
    }),
    ips: eligibleIps({ last_extracted_at: daysAgo(5), quality_scored_at: daysAgo(5) }),
  });
  assert.equal(trust.verification_source, 'external_seed_scrape');
});

test('PRESERVATION: the retired sentinel lump is still a scrape', () => {
  const trust = call({
    product: activeMerchantProduct({
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds',
      last_seen_in_sync_at: NOW,
    }),
  });
  assert.equal(trust.verification_source, 'external_seed_scrape');
});

test('CONTROL: a genuinely connected shopify merchant still reports a sync', () => {
  // Without this, every assertion above would pass on a function that returned
  // 'external_seed_scrape' unconditionally.
  const trust = call({
    product: activeMerchantProduct({ last_seen_in_sync_at: NOW }),
    ips: eligibleIps({ last_extracted_at: daysAgo(5), quality_scored_at: daysAgo(5) }),
  });
  assert.equal(trust.verification_source, 'shopify_sync');
});

test('seed content is recognised by its LANE even under a seller that is neither the sentinel nor merch_obs_', () => {
  // The arm the hand-rolled trio lacked. 54 such rows exist on prod: seed-routed
  // supply whose merchant is neither the retired lump nor an observed seller.
  // Classified by merchant alone they read as FIRST-PARTY and skip the
  // identity-coverage gate, i.e. scraped content would serve as brand-official.
  // (Uses a real such seller from that cohort. NOT the retired rig id, which
  // short-circuits on TEST_MERCHANT_EXCLUDED before this gate is reached.)
  const trust = call({
    product: activeMerchantProduct({
      merchant_id: 'merch_924da2be8503e5f7',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
    }),
    identity: approvedIdentity({ identity_confidence: null }),
  });
  assert.ok(
    trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL),
    `expected the coverage gate to apply; got ${JSON.stringify(trust.serving_reason_codes)}`,
  );
  assert.ok(
    !trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY),
    'scraped supply must not be exempted as first-party',
  );
});

test('CONTROL: a genuinely first-party merchant IS exempt from the coverage gate', () => {
  // Proves the assertion above discriminates rather than always holding.
  const trust = call({
    product: activeMerchantProduct(),
    identity: approvedIdentity({ identity_confidence: null }),
  });
  assert.ok(
    trust.serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY),
    `expected first-party exemption; got ${JSON.stringify(trust.serving_reason_codes)}`,
  );
});
