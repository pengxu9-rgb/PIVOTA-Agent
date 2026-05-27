'use strict';

// Layer C1 — catalogTrustPolicy
//
// Pure function: (inputs) -> catalog_row_trust shape.
//
// Inputs are collected from the existing tables this module does NOT own:
//   catalog_products, catalog_offers, index_pipeline_state,
//   pdp_identity_listing, external_product_seeds, merchant_stores,
//   catalog_source_quarantine, pdp_identity_override.
//
// Output is a row matching db/migrations/136_catalog_row_trust.sql.
//
// Contract: every reader downstream depends on (serving_decision,
// serving_reason_codes). The other fields are advisory and used for ranking,
// debugging, and shadow-comparison.
//
// Versioning: POLICY_VERSION must bump on any change to derivation logic.
// The backfill job uses POLICY_VERSION to detect stale rows.

const POLICY_VERSION = 'c1.v0.4';

// ---- Reason codes (authoritative vocabulary) -------------------------------
//
// Public:
//   none required, but PUBLIC_PASSTHROUGH may be set for traceability.
//
// Shadow (would have served under legacy gates, but contract says caution):
//   IDENTITY_REVIEW_REQUIRED_LIVE_READ — pdp_identity_listing.identity_status=
//     'review_required' AND live_read_enabled=true. Audit counted ~60 of these
//     among external mirror rows.
//   IDENTITY_CONFIDENCE_NULL — IPS serving_eligible=true but no identity row
//     or identity_confidence IS NULL. Only emitted for non-first-party sources
//     (i.e., external_seed). For first-party merchants the corresponding
//     advisory is IDENTITY_NOT_APPLICABLE_FIRST_PARTY (see below).
//   IDENTITY_LIVE_READ_DISABLED — identity_status='approved' but
//     live_read_enabled=false. First-party sources are exempt.
//   FRESHNESS_UNVERIFIED — never observed a verification timestamp.
//
// Advisory (does not flip decision):
//   IDENTITY_NOT_APPLICABLE_FIRST_PARTY — c1.v0.3+. Marks rows where the
//     merchant IS the source of truth, so the identity-pipeline gates (which
//     exist to verify scraped third-party content) don't apply. Emitted for
//     `product.merchant_id !== 'external_seed'` when identity is missing or
//     low-info.
//
// Blocked (no public surface):
//   SOURCE_QUARANTINED               — catalog_source_quarantine active match.
//   ROW_TOMBSTONED                   — catalog_products.suppression_reason set.
//   EXTERNAL_SEED_INACTIVE           — external_product_seeds.status != 'active'.
//   MERCHANT_STORE_INACTIVE          — merchant_stores.status != 'active'.
//   INDEX_NOT_SERVING_ELIGIBLE       — index_pipeline_state.serving_eligible=false.
//   PUBLISH_STATE_NOT_PUBLIC         — catalog_products.publish_state != 'public'.
//   IDENTITY_CONFLICT                — identity_status='conflict'.
//   OFFER_SUPPRESSED                 — subject_type='offer' with offer.suppression_reason set.

const REASON_CODES = Object.freeze({
  PUBLIC_PASSTHROUGH: 'PUBLIC_PASSTHROUGH',

  IDENTITY_REVIEW_REQUIRED_LIVE_READ: 'IDENTITY_REVIEW_REQUIRED_LIVE_READ',
  IDENTITY_CONFIDENCE_NULL: 'IDENTITY_CONFIDENCE_NULL',
  IDENTITY_LIVE_READ_DISABLED: 'IDENTITY_LIVE_READ_DISABLED',
  IDENTITY_NOT_APPLICABLE_FIRST_PARTY: 'IDENTITY_NOT_APPLICABLE_FIRST_PARTY',
  FRESHNESS_UNVERIFIED: 'FRESHNESS_UNVERIFIED',

  SOURCE_QUARANTINED: 'SOURCE_QUARANTINED',
  ROW_TOMBSTONED: 'ROW_TOMBSTONED',
  EXTERNAL_SEED_INACTIVE: 'EXTERNAL_SEED_INACTIVE',
  MERCHANT_STORE_INACTIVE: 'MERCHANT_STORE_INACTIVE',
  INDEX_NOT_SERVING_ELIGIBLE: 'INDEX_NOT_SERVING_ELIGIBLE',
  PUBLISH_STATE_NOT_PUBLIC: 'PUBLISH_STATE_NOT_PUBLIC',
  IDENTITY_CONFLICT: 'IDENTITY_CONFLICT',
  OFFER_SUPPRESSED: 'OFFER_SUPPRESSED',
});

const VALID_SUBJECT_TYPES = new Set(['product', 'offer', 'listing', 'content_key']);

// Freshness thresholds (ms). Tuned to keep external_seed which refreshes ~24h
// in the 'fresh' bucket and to mark internal merchant catalog stale after a
// week without sync.
const FRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ---- Public API ------------------------------------------------------------

/**
 * Derive the catalog_row_trust row for a single subject.
 *
 * @param {Object} inputs
 * @param {string} inputs.subject_type   'product' | 'offer' | 'listing' | 'content_key'
 * @param {string} inputs.subject_key    stable subject identifier (caller-defined)
 * @param {Object} [inputs.product]      catalog_products row (or null)
 * @param {Object} [inputs.offer]        catalog_offers row (subject_type=offer)
 * @param {Object} [inputs.identity]     pdp_identity_listing row (or null)
 * @param {Object} [inputs.ips]          index_pipeline_state row (or null)
 * @param {Object} [inputs.external_seed] external_product_seeds row (or null)
 * @param {Object} [inputs.merchant_store] merchant_stores row (or null)
 * @param {Object} [inputs.override]     pdp_identity_override row (or null)
 * @param {Array}  [inputs.active_quarantines] active catalog_source_quarantine rows
 * @param {Date}   [inputs.now]          injectable clock (defaults to new Date())
 *
 * @returns {Object} catalog_row_trust row (without updated_at — DB default)
 */
function deriveTrust(inputs) {
  const now = inputs.now instanceof Date ? inputs.now : new Date();
  const subject_type = inputs.subject_type;
  const subject_key = inputs.subject_key;

  if (!VALID_SUBJECT_TYPES.has(subject_type)) {
    throw new Error(`invalid subject_type: ${subject_type}`);
  }
  if (!subject_key || typeof subject_key !== 'string') {
    throw new Error('subject_key is required');
  }

  const product = inputs.product || null;
  const offer = inputs.offer || null;
  const identity = inputs.identity || null;
  const ips = inputs.ips || null;
  const externalSeed = inputs.external_seed || null;
  const merchantStore = inputs.merchant_store || null;
  const override = inputs.override || null;
  const activeQuarantines = Array.isArray(inputs.active_quarantines)
    ? inputs.active_quarantines
    : [];

  const reasons = [];

  // ---- Source lifecycle ----------------------------------------------------
  const sourceLifecycle = deriveSourceLifecycle({
    product,
    externalSeed,
    merchantStore,
    activeQuarantines,
    reasons,
    now,
  });

  // ---- Identity ------------------------------------------------------------
  const identityDecision = deriveIdentity({ identity, override, reasons });

  // ---- Freshness -----------------------------------------------------------
  const freshness = deriveFreshness({ product, ips, externalSeed, now });
  if (freshness.state === 'unverified') {
    reasons.push(REASON_CODES.FRESHNESS_UNVERIFIED);
  }

  // ---- Serving decision ----------------------------------------------------
  const serving = deriveServingDecision({
    subject_type,
    product,
    offer,
    ips,
    sourceLifecycle,
    identityDecision,
    reasons,
  });

  return {
    subject_type,
    subject_key,
    product_key: product?.product_key ?? null,
    // The identity listing's PK doubles as the source_listing_ref;
    // for external_seed rows the external_product_seeds.id is preferred.
    source_listing_ref:
      identity?.source_listing_ref ??
      (externalSeed?.id != null ? String(externalSeed.id) : null) ??
      product?.source_ref ?? null,
    content_key: product?.content_key ?? null,
    source_id: null,  // forward-compat — Layer A1 source registry not yet shipped
    source_domain:
      product?.source_domain ??
      externalSeed?.domain ??
      merchantStore?.domain ??
      null,

    source_lifecycle_state: sourceLifecycle.state,
    source_last_checked_at:
      externalSeed?.last_seen_at ??
      merchantStore?.last_sync ??
      null,

    identity_status: identityDecision.status,
    identity_confidence: identityDecision.confidence,
    // Phase 1: only the sellable_item_group_id is populated directly from
    // pdp_identity_listing. matched_product_key / matched_content_key require
    // a sibling-row lookup (resolved in Phase 2 dual-write); leave null here.
    matched_product_key: null,
    matched_content_key: null,
    matched_sellable_item_group_id: identity?.sellable_item_group_id ?? null,

    freshness_state: freshness.state,
    last_verified_at: freshness.last_verified_at,
    verification_source: freshness.verification_source,

    serving_decision: serving.decision,
    serving_reason_codes: dedupe(reasons),

    manual_override_id: override?.id ?? null,
    policy_version: POLICY_VERSION,
  };
}

// ---- Source lifecycle ------------------------------------------------------

function deriveSourceLifecycle({ product, externalSeed, merchantStore, activeQuarantines, reasons, now }) {
  // Quarantine wins over everything.
  if (isQuarantined({ product, externalSeed, merchantStore, activeQuarantines, now })) {
    reasons.push(REASON_CODES.SOURCE_QUARANTINED);
    return { state: 'quarantined' };
  }

  // Tombstone (PR #666 / migration 135).
  if (product?.suppression_reason) {
    reasons.push(REASON_CODES.ROW_TOMBSTONED);
    return { state: 'tombstoned' };
  }

  // External seed lifecycle.
  if (externalSeed) {
    const status = String(externalSeed.status ?? '').toLowerCase();
    if (status === 'active') return { state: 'active' };
    if (status === 'disabled' || status === 'inactive') {
      reasons.push(REASON_CODES.EXTERNAL_SEED_INACTIVE);
      return { state: 'inactive' };
    }
    if (status === 'suspect') return { state: 'suspect' };
    return { state: 'unknown' };
  }

  // Merchant store lifecycle.
  if (merchantStore) {
    const status = String(merchantStore.status ?? '').toLowerCase();
    if (status === 'active') return { state: 'active' };
    if (status === 'inactive' || status === 'disconnected') {
      reasons.push(REASON_CODES.MERCHANT_STORE_INACTIVE);
      return { state: 'inactive' };
    }
    return { state: 'unknown' };
  }

  return { state: 'unknown' };
}

function isQuarantined({ product, externalSeed, merchantStore, activeQuarantines, now }) {
  if (!activeQuarantines.length) return false;
  const nowMs = (now instanceof Date ? now : new Date()).getTime();

  const domain = String(
    product?.source_domain ?? externalSeed?.domain ?? merchantStore?.domain ?? ''
  ).toLowerCase();
  const merchantId = product?.merchant_id ?? merchantStore?.merchant_id ?? null;
  const platform = product?.platform ?? merchantStore?.platform ?? null;
  const sourceSystem = product?.source_system ?? null;
  const sourceRef = product?.source_system_ref ?? null;

  for (const q of activeQuarantines) {
    if (q.state !== 'active') continue;
    if (q.expires_at && new Date(q.expires_at).getTime() <= nowMs) continue;

    if (q.match_type === 'domain' && domain &&
        String(q.match_value).toLowerCase() === domain) {
      return true;
    }
    if (q.match_type === 'merchant_platform' && merchantId && platform &&
        q.match_value === `${merchantId}:${platform}`) {
      return true;
    }
    if (q.match_type === 'source_system_ref' && sourceSystem && sourceRef &&
        q.match_value === `${sourceSystem}:${sourceRef}`) {
      return true;
    }
  }
  return false;
}

// ---- Identity --------------------------------------------------------------

function deriveIdentity({ identity, override, reasons }) {
  // Manual override of identity wins (rare but authoritative).
  if (override?.action_type === 'force_exact_group' && override?.active) {
    return { status: 'approved', confidence: 1.0, liveRead: true, reviewRequired: false };
  }
  if (override?.action_type === 'force_review_required' && override?.active) {
    return {
      status: 'review_required',
      confidence: identity?.identity_confidence ?? null,
      liveRead: identity?.live_read_enabled === true,
      reviewRequired: true,
    };
  }

  if (!identity) {
    // No identity row at all. The 504 external-mirror cases in the audit
    // largely fall here.
    return { status: 'unknown', confidence: null, liveRead: null, reviewRequired: null };
  }

  const status = String(identity.identity_status ?? '').toLowerCase();
  const liveRead = identity.live_read_enabled === true;
  const reviewRequired = identity.review_required === true;
  const rawConfidence = identity.identity_confidence;
  const confidence = rawConfidence == null
    ? null
    : clamp(Number(rawConfidence), 0, 1);

  if (status === 'conflict') {
    reasons.push(REASON_CODES.IDENTITY_CONFLICT);
    return { status: 'conflict', confidence, liveRead, reviewRequired };
  }

  if (status === 'approved') {
    if (reviewRequired) {
      // Approved but flagged for review — degrade to review_required so
      // downstream readers don't treat as fully trusted.
      return { status: 'review_required', confidence, liveRead, reviewRequired };
    }
    return { status: 'approved', confidence, liveRead, reviewRequired };
  }

  if (status === 'review_required') {
    return { status: 'review_required', confidence, liveRead, reviewRequired };
  }

  // Any other value — treat as unknown.
  return { status: 'unknown', confidence, liveRead, reviewRequired };
}

// ---- Freshness -------------------------------------------------------------

function deriveFreshness({ product, ips, externalSeed, now }) {
  const candidates = [
    { ts: ips?.last_extracted_at, src: 'identity_resolver' },
    { ts: product?.last_seen_in_sync_at, src: deriveVerificationSource(product) },
    { ts: externalSeed?.last_seen_at, src: 'external_seed_scrape' },
    { ts: ips?.quality_scored_at, src: 'index_pipeline' },
  ];

  let chosen = null;
  for (const c of candidates) {
    if (!c.ts) continue;
    const t = c.ts instanceof Date ? c.ts : new Date(c.ts);
    if (Number.isNaN(t.getTime())) continue;
    if (!chosen || t.getTime() > chosen.ts.getTime()) {
      chosen = { ts: t, src: c.src };
    }
  }

  if (!chosen) {
    return { state: 'unverified', last_verified_at: null, verification_source: null };
  }

  const age = now.getTime() - chosen.ts.getTime();
  let state;
  if (age <= FRESH_MAX_AGE_MS) state = 'fresh';
  else if (age <= STALE_MAX_AGE_MS) state = 'stale';
  else state = 'expired';

  return {
    state,
    last_verified_at: chosen.ts.toISOString(),
    verification_source: chosen.src,
  };
}

function deriveVerificationSource(product) {
  if (!product) return null;
  if (product.merchant_id === 'external_seed') return 'external_seed_scrape';
  if (product.platform === 'shopify') return 'shopify_sync';
  if (product.platform === 'wix') return 'wix_sync';
  return 'merchant_sync';
}

// ---- Serving decision ------------------------------------------------------

function deriveServingDecision({
  subject_type,
  product,
  offer,
  ips,
  sourceLifecycle,
  identityDecision,
  reasons,
}) {
  // Offer-specific block: suppressed offers never surface.
  if (subject_type === 'offer' && offer?.suppression_reason) {
    reasons.push(REASON_CODES.OFFER_SUPPRESSED);
    return { decision: 'blocked' };
  }

  // Hard blocks.
  const blocked = sourceLifecycle.state === 'quarantined'
    || sourceLifecycle.state === 'tombstoned'
    || sourceLifecycle.state === 'inactive'
    || identityDecision.status === 'conflict';

  if (blocked) return { decision: 'blocked' };

  // Index pipeline gate. All public readers honor this today; the contract
  // makes it explicit. sync_status='live' is the equivalent for catalog rows
  // before they reach IPS — see migration 084.
  //
  // c1.v0.4: for non-first-party (external_seed) catalog rows, a missing IPS
  // row is treated as INDEX_NOT_SERVING_ELIGIBLE. Pre-c1.v0.4 the policy let
  // ips=null pass on the assumption "no IPS opinion = no reason to block",
  // but Phase 3c parity found 80 external_seed catalog products with public
  // trust + no IPS row — i.e., shipping content that the index pipeline
  // hasn't quality-gated yet. First-party rows (MOYU/GR/PawStyle/etc.) keep
  // the legacy behavior since first-party merchants are the source of truth
  // for their own content and IPS coverage is sparse there by design.
  if (product) {
    const isFirstPartyCatalog = product.merchant_id !== 'external_seed';
    if (!isFirstPartyCatalog && !ips) {
      reasons.push(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE);
      return { decision: 'blocked' };
    }
    if (ips && ips.serving_eligible !== true) {
      reasons.push(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE);
      return { decision: 'blocked' };
    }
    const syncStatus = String(product.sync_status ?? '').toLowerCase();
    if (syncStatus && syncStatus !== 'live') {
      reasons.push(REASON_CODES.PUBLISH_STATE_NOT_PUBLIC);
      return { decision: 'blocked' };
    }
  }

  // Shadow conditions — would have served under legacy gates, but the
  // contract gates them out of public reads.
  //
  // c1.v0.3: first-party sources (any merchant_id other than 'external_seed')
  // are exempt from the identity-pipeline shadow gates. For internal Shopify/
  // Wix/etc. merchants, the merchant IS the source of truth — the identity
  // pipeline exists to verify scraped third-party content. review_required
  // and IDENTITY_CONFLICT still apply (those are explicit moderation/data-
  // quality signals, not identity-coverage gaps).
  const isFirstParty = !!product && product.merchant_id !== 'external_seed';

  if (identityDecision.status === 'review_required') {
    reasons.push(REASON_CODES.IDENTITY_REVIEW_REQUIRED_LIVE_READ);
  }

  const missingConfidence =
    (identityDecision.status === 'unknown' || identityDecision.status === 'approved') &&
    identityDecision.confidence == null;
  if (missingConfidence) {
    if (isFirstParty) {
      reasons.push(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY);
    } else {
      reasons.push(REASON_CODES.IDENTITY_CONFIDENCE_NULL);
    }
  }

  if (identityDecision.status === 'approved' && identityDecision.liveRead === false) {
    if (!isFirstParty) {
      reasons.push(REASON_CODES.IDENTITY_LIVE_READ_DISABLED);
    }
  }

  const shadow =
    identityDecision.status === 'review_required' ||
    reasons.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL) ||
    reasons.includes(REASON_CODES.IDENTITY_LIVE_READ_DISABLED) ||
    (identityDecision.status === 'unknown' && !isFirstParty);

  if (shadow) {
    return { decision: 'shadow' };
  }

  reasons.push(REASON_CODES.PUBLIC_PASSTHROUGH);
  return { decision: 'public' };
}

// ---- Utilities -------------------------------------------------------------

function clamp(value, lo, hi) {
  if (Number.isNaN(value)) return null;
  return Math.min(hi, Math.max(lo, value));
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

module.exports = {
  POLICY_VERSION,
  REASON_CODES,
  VALID_SUBJECT_TYPES,
  deriveTrust,
};
