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
// Versioning: POLICY_VERSION must bump on any change to derivation LOGIC — the
// mapping from inputs to a decision. It must NOT bump when only an INPUT the
// current logic cannot reach changes.
//
// CORRECTION 2026-07-28: this paragraph used to say "the backfill uses
// POLICY_VERSION to detect stale rows". It does not, and the error misled a
// reviewer into arguing a bump was mandatory. The backfill selects by
// `ORDER BY updated_at ASC NULLS FIRST` with NO policy_version predicate — it
// re-derives every row every pass. POLICY_VERSION appears only as one of five
// OR'd terms in the UPSERT write-guard (catalogRowTrustUpserter.js), so it is a
// write-trigger and an observability tag, never a row selector.
//
// The cost of a cosmetic bump is therefore one extra UPDATE per row, once — not
// re-derivation — plus, and this is the part that matters, it re-opens the
// split-brain window where the two services disagree on the version until both
// are deployed, and the updated_at churn defeats the cron's stalest-first
// ordering. The upside forgone is forensic: rows derived before and after the
// change become indistinguishable in the table.
//
// Worked example — P3, 2026-07-25. It changed how pdp_route_resolvable is
// COMPUTED (pdpRenderability learned the minted attached_product_key lane,
// flipping 2,051 rows to renderable). That input is read in exactly one place,
// deriveServingDecision, behind the default-OFF CATALOG_TRUST_RENDERABLE_GATE —
// so every derived decision and every reason code is byte-identical before and
// after, on all 14,104 rows. No bump. The version bumps the day the GATE flips,
// not the day the input gets more accurate.

// The one dependency this otherwise self-contained module takes. Importing is
// deliberate: inlining the rig ids here would make this a FIFTH copy of the
// list, and a rig excluded everywhere but here is precisely the bug this gate
// closes. testMerchantPolicy.js has no imports of its own, so there is no cycle.
const { TEST_MERCHANT_IDS } = require('./testMerchantPolicy');
const {
  isExternalSeedLaneProduct,
  isObservedSellerMerchantId,
} = require('./externalSeedLane');

// Worked example 2 — the test-merchant gate, 2026-07-27. It adds a NEW arm to
// deriveServingDecision (a real logic change), but the arm sits after the
// lifecycle/index gates and every rig row in catalog_row_trust is already
// 'blocked' by those (measured: 1,561/1,561). So every decision and every
// reason code is byte-identical on all ~14k rows, and the same no-bump
// reasoning as P3 applies: bumping would cost a full rewrite and re-open the
// split-brain window for a change no row can currently observe. The version
// bumps the day a rig row would actually reach 'public', not the day the
// backstop is installed.
// Worked example 3 — the per-row price gate, 2026-07-31. This one DOES bump.
// OFFER_PRICE_MISSING flips 4 real decisions from 'public' to 'blocked' — rows
// CAN observe it, which is exactly the condition the versioning rule names.
//
// 🚨 SHIPS SECOND, RIGHT BEHIND pivota-backend#1649. The backend carries the
// same gate and the same bump; until BOTH are deployed the twins disagree and
// the 4 rows flap. Merge order: backend, then this.
//
// PARITY REPAIR, 2026-07-31, NO BUMP — the index gate learned to fail closed on
// a missing IPS row for EVERY lane, matching what the Python twin has done
// since c1.v0.5. It is a real logic change, so the rule says measure before
// deciding. Measured on prod the day it landed: the gap set — rows with no
// index_pipeline_state row that are NOT external-seed content — is 20 rows, all
// merch_efbc46b4619cfbdf (a KNOWN_TEST_MERCHANT_IDS rig) with content_key NULL,
// and all 20 are ALREADY blocked by BOTH twins via ROW_TOMBSTONED, which
// returns from the hard-block arm well before the index gate is reached. So
// every decision AND every reason code is byte-identical on all ~14k rows, and
// the same no-bump reasoning as P3 and the test-merchant gate applies: bumping
// would cost a full rewrite and re-open the split-brain window for a change no
// row can currently observe. The version bumps the day a first-party row
// actually reaches the gate.
// Worked example 4 — the canonical-election gate, 2026-07-31. Bumps: it moves
// 121 measured prod rows from 'public' to 'shadow'. Pairs with pivota-backend,
// backend first.
const POLICY_VERSION = 'c1.v0.7';

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
//   NON_CANONICAL_DUPLICATE — c1.v0.7 (2026-07-31). This row is NOT the elected
//     canonical for its content_key (content_canonical_election, mig 181): a
//     SIBLING row holds the one URL the sitemap advertises and that this row's
//     own PDP names in <link rel="canonical">. The row is real and renderable,
//     it is simply not the copy that represents this physical product publicly.
//
//     SHADOW, DELIBERATELY NOT BLOCKED, and the distinction is load-bearing.
//     The two surfaces read different tables: the PDP RENDERER gates on
//     index_pipeline_state.serving_eligible (content grain, unchanged here),
//     while public recall / discovery / the entity feed gate on
//     catalog_row_trust.serving_decision='public' (row grain — see
//     catalogServingIndex.fetchCatalogServingEligibleSourceSet in THIS repo).
//     Shadow drops the duplicate out of public promotion while its page KEEPS
//     ANSWERING 200 with its rel=canonical intact. Blocking would 404 URLs
//     Google may already have indexed AND destroy the canonical signal that
//     consolidates them onto the winner — strictly worse than the duplicate,
//     the same trap services/content_canonical_election documents.
//
//     THE GRAIN BRIDGE. index_pipeline_state is keyed by content_key and stores
//     ONE row's state; catalog_row_trust is keyed by product_key. Nothing
//     connected the two, so a non-elected sibling inherited the content verdict
//     and was promoted as if canonical. Measured on prod 2026-07-31: 121 of
//     6,814 trust-public rows, ALL on multi-row content_keys.
//
//     TRI-STATE: only an explicit false shadows. 32 multi-row content_keys have
//     no election yet and MUST NOT be demoted on absence.
//
// Advisory (does not flip decision):
//   IDENTITY_NOT_APPLICABLE_FIRST_PARTY — c1.v0.3+. Marks rows where the
//     merchant IS the source of truth, so the identity-pipeline gates (which
//     exist to verify scraped third-party content) don't apply. Emitted for
//     `product.merchant_id !== 'external_seed'` when identity is missing or
//     low-info.
//
// Blocked (no public surface):
//   TEST_MERCHANT_EXCLUDED           — 2026-07-27. merchant_id is a known rig
//     (testMerchantPolicy.js TEST_MERCHANT_IDS). Evaluated after the
//     lifecycle/index gates, so it only fires on a rig that would OTHERWISE
//     have reached public/shadow — an already-blocked rig keeps its real
//     reason. Fires on zero rows today; it is the backstop for the day a rig's
//     suppression is cleared. Baked-in ids only, never the env hatch: this
//     table is shared state written by both twins.
//   SOURCE_QUARANTINED               — catalog_source_quarantine active match.
//   ROW_TOMBSTONED                   — catalog_products.suppression_reason set.
//   EXTERNAL_SEED_INACTIVE           — external_product_seeds.status != 'active'.
//   MERCHANT_STORE_INACTIVE          — merchant_stores.status != 'active'.
//   INDEX_NOT_SERVING_ELIGIBLE       — index_pipeline_state.serving_eligible=false.
//   OFFER_PRICE_MISSING              — 2026-07-31. THIS product_key carries no
//     unsuppressed catalog_offers row with a price > 0 (src/services/pricedOfferSql,
//     byte-identical twin of pivota-backend services/priced_offer_sql.py).
//     Evaluated right after the index gate, so a row already blocked upstream
//     keeps its real reason and only a row that would otherwise reach
//     public/shadow is reclassified.
//
//     WHY IT CANNOT BE READ OFF ips.serving_eligible, which is the obvious
//     objection: index_pipeline_state is keyed by CONTENT_KEY (migration 098)
//     and both upserters join it 'ips.content_key = cp.content_key', but trust
//     is keyed by PRODUCT_KEY and every product_key mints its own
//     pivota_signature_id — its own public PDP. pivota-backend's
//     index_pipeline_state_service 'has_price' is per-row and always was
//     correct; its _select_content_key_state then stores the BEST row's state
//     for the whole content_key, so a price-less row sharing a content_key with
//     a priced sibling inherits serving_eligible=true and publishes a
//     price-less page. Measured on prod 2026-07-31: 4 Tom Ford fragrance PDPs,
//     each with exactly one unsuppressed offer whose list_price,
//     merchant_effective_price and estimated_best_price were ALL NULL, sitting
//     at trust 'public' behind a priced tomfordbeauty.com sibling. This gate
//     asks the price question of the row it is actually deciding.
//
//     TRI-STATE, like PDP_ROUTE_UNRESOLVABLE: only an explicit false blocks. A
//     producer that does not compute row_has_priced_offer is byte-identical to
//     c1.v0.5. NOT env-gated, unlike the renderable gate: its entire blast
//     radius measured on prod is those 4 rows, because the 2,535 other rows
//     lacking a priced offer of their own are ALREADY blocked upstream.
//
//     ⚠️ SAME TWIN-SYMMETRY RULE AS PDP_ROUTE_UNRESOLVABLE BELOW. This landed
//     as the mirror of pivota-backend#1649 — backend first, this repo second.
//   PUBLISH_STATE_NOT_PUBLIC         — catalog_products.publish_state != 'public'.
//   IDENTITY_CONFLICT                — identity_status='conflict'.
//   OFFER_SUPPRESSED                 — subject_type='offer' with offer.suppression_reason set.
//   PDP_ROUTE_UNRESOLVABLE           — c1.v0.5. The gateway has no resolvable
//     content route for the row, so its public PDP never answers with a real
//     product page: it is either a hard HTTP 500 or a generic noindex shell
//     carrying no product JSON-LD (both measured 2026-07-25). GATED on
//     CATALOG_TRUST_RENDERABLE_GATE, default OFF: turning it on demotes 1,376
//     rows out of 'public', which is a serving-surface decision for the
//     founder, not a code default. The predicate lives in
//     src/services/pdpRenderability.js (twin of pivota-backend
//     services/pdp_renderability.py); this module only consumes the boolean
//     its caller computed.
//
//     ⚠️ THE FLAG IS PER-SERVICE AND THE TWINS SHARE ONE DATABASE. pivota-backend
//     runs the same policy and writes the same catalog_row_trust table on a 6h
//     cron; this repo writes it from prod RUNTIME (pdpIdentityGraph calls
//     upsertCatalogRowTrustForSourceListingRefs on every live-read promotion
//     and identity override). Set CATALOG_TRUST_RENDERABLE_GATE on BOTH Railway
//     services or NEITHER: with it on one side only, the backend blocks the
//     1,376 and this repo re-derives them public on the next identity event, so
//     rows FLAP public↔blocked on the live serving surface. The same applies to
//     POLICY_VERSION — ship the two repos back to back.

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
  PDP_ROUTE_UNRESOLVABLE: 'PDP_ROUTE_UNRESOLVABLE',
  TEST_MERCHANT_EXCLUDED: 'TEST_MERCHANT_EXCLUDED',
  OFFER_PRICE_MISSING: 'OFFER_PRICE_MISSING',
  NON_CANONICAL_DUPLICATE: 'NON_CANONICAL_DUPLICATE',
});

const VALID_SUBJECT_TYPES = new Set(['product', 'offer', 'listing', 'content_key']);

const TRUTHY_FLAG = new Set(['1', 'true', 'yes', 'on']);

function flagOn(name) {
  return TRUTHY_FLAG.has(String(process.env[name] ?? '').trim().toLowerCase());
}

// ADR-008 SLICE 1 read flag. When ON, the index-pipeline serving gate widens
// from serving_eligible to (serving_eligible OR index_eligible) — the
// OFFER-FREE citation floor. Default OFF ⇒ byte-identical to before.
//
// ⚠️ THIS ARM IS CURRENTLY UNREACHABLE FROM THE UPSERTERS, DELIBERATELY.
// Neither this repo's product join (catalogRowTrustUpserter.js /
// scripts/backfill-catalog-row-trust.cjs) nor the Python twin selects
// ips.index_eligible, so `ips.index_eligible === true` is never satisfied and
// both writers compute serving_eligible-only regardless of the flag. That is
// what keeps them AGREEING, and agreement is the whole point: they share one
// catalog_row_trust table and the UPSERT rewrites a row whenever
// serving_decision differs.
//
// Selecting the column would break that today, because the flag is set
// ASYMMETRICALLY in prod: INDEX_ELIGIBLE_READ=1 on the pivota-backend `web`
// service, UNSET on the PIVOTA-Agent service (verified 2026-07-25). Wire the
// column up and the ~100 prod rows with index_eligible=true AND
// serving_eligible<>true would be derived `public` by the backend cron and
// `blocked` by this repo on the next identity event — flapping forever.
//
// Known consequence of leaving it unreachable: the citation READ path
// (pivot_query_service.py) DOES honor index_eligible, so those ~100 rows are
// recall-eligible there while trust keeps blocking them. Closing that gap is a
// founder call, not a code default, and it is a THREE-part change — select the
// column in both joins, and set INDEX_ELIGIBLE_READ on both Railway services in
// the same operation. Do not do one part.
function indexEligibleReadEnabled() {
  return flagOn('INDEX_ELIGIBLE_READ');
}

// c1.v0.5 gate: does 'public' have to imply a renderable PDP? Default OFF ⇒
// byte-identical to c1.v0.4. See the PDP_ROUTE_UNRESOLVABLE note above for why
// this is a founder flag and not a straight fix.
function renderableGateEnabled() {
  return flagOn('CATALOG_TRUST_RENDERABLE_GATE');
}

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
 * @param {boolean} [inputs.pdp_route_resolvable] c1.v0.5 tri-state: true when the
 *   gateway can resolve a PDP content route for the row, false when it cannot
 *   (the PDP answers with a 500 or a bare noindex shell), null/undefined when
 *   the caller did not compute it.
 *   Absence NEVER blocks, so producers not yet taught to supply it keep their
 *   c1.v0.4 output exactly.
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
  const pdpRouteResolvable =
    inputs.pdp_route_resolvable == null ? null : Boolean(inputs.pdp_route_resolvable);
  // Same tri-state contract. true = this product_key has its own unsuppressed
  // priced offer, false = it does not, null/absent = not computed and the
  // OFFER_PRICE_MISSING gate stays silent.
  const rowHasPricedOffer =
    inputs.row_has_priced_offer == null ? null : Boolean(inputs.row_has_priced_offer);
  // Tri-state. true = this row IS its content_key's elected canonical,
  // false = a sibling holds the canonical URL, null = no election exists.
  const rowIsElectedCanonical =
    inputs.row_is_elected_canonical == null ? null : Boolean(inputs.row_is_elected_canonical);
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
    pdpRouteResolvable,
    rowHasPricedOffer,
    rowIsElectedCanonical,
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

// Bare host: trimmed, lowercased, no leading `www.`. Byte-equivalent to the
// Python twin `services/source_quarantine.bare_domain` and to the SQL
// `sql_bare_domain`, and it MUST stay that way: both this file and the Python
// `catalog_trust_policy` write `catalog_row_trust` for the same rows (Node via
// scripts/sync-external-seeds-to-catalog.cjs, Python via the trust cron), so a
// normalisation split makes `serving_decision` FLAP — last writer wins.
//
// Before this existed, a `www.mintree.us` quarantine blocked a `mintree.us` row
// on the Python side and not here, so every external-seed sync flipped it back
// to `public`. See pivota-backend#1639.
function bareDomain(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text.startsWith('www.') ? text.slice(4) : text;
}

function isQuarantined({ product, externalSeed, merchantStore, activeQuarantines, now }) {
  if (!activeQuarantines.length) return false;
  const nowMs = (now instanceof Date ? now : new Date()).getTime();

  const domain = bareDomain(
    product?.source_domain ?? externalSeed?.domain ?? merchantStore?.domain ?? ''
  );
  const merchantId = product?.merchant_id ?? merchantStore?.merchant_id ?? null;
  const platform = product?.platform ?? merchantStore?.platform ?? null;
  const sourceSystem = product?.source_system ?? null;
  const sourceRef = product?.source_system_ref ?? null;

  for (const q of activeQuarantines) {
    if (q.state !== 'active') continue;
    if (q.expires_at && new Date(q.expires_at).getTime() <= nowMs) continue;

    if (q.match_type === 'domain' && domain) {
      // Both sides through bareDomain.
      //
      // The `wanted &&` guard is belt-and-braces HERE — the enclosing `&& domain`
      // already makes a blank unreachable on this path, so no test can kill it.
      // It is kept because the Python twin's `quarantine_matches_source` has NO
      // such enclosing guard and DID match every domain-less row against a blank
      // match_value; keeping the two shaped alike is what stops the next reader
      // "simplifying" one of them back apart.
      const wanted = bareDomain(q.match_value);
      if (wanted && wanted === domain) return true;
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
  // ADR-009: this labels HOW the row's facts were obtained. It tested the
  // retired sentinel seller, which no row carries any more, so scraped supply
  // silently began reporting itself as a merchant sync — the platform arms
  // below catch it first. Ask the lane instead: a crawled row is a scrape
  // whatever seller it now sits under, and whatever platform it mirrors.
  if (isExternalSeedLaneProduct(product)) return 'external_seed_scrape';
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
  pdpRouteResolvable = null,
  rowHasPricedOffer = null,
  rowIsElectedCanonical = null,
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
  // hasn't quality-gated yet.
  //
  // c1.v0.5 (2026-07-29), PARITY REPAIR LANDED HERE 2026-07-31: a missing IPS
  // row now fails CLOSED for EVERY lane, not only external-seed content. The
  // first-party carve-out this replaces let ips=null fall through to public on
  // the theory that "first-party merchants are the source of truth and IPS
  // coverage there is sparse by design". Both halves of that theory failed the
  // first time a real merchant-sync row arrived:
  //
  //   * Measured 2026-07-29 (Wix pilot merch_e68c20b0189746d0): 20 rows synced
  //     with content_key NULL — structurally incapable of ever having an IPS
  //     row — and every one went trust-public with NO quality gate, no scoring,
  //     no eligibility. Only the gateway's own fail-closed eligibility lookup
  //     kept them from serving, and public_not_renderable went red (20 > 0)
  //     within the hour.
  //   * "Sparse by design" described a corpus where every first-party merchant
  //     was a retired test rig whose rows were already blocked upstream.
  //
  // An unscored row must not be public. The correct lifecycle for a fresh sync
  // is blocked -> scored -> eligible -> public, and rows without a content_key
  // stay blocked until identity is repaired.
  //
  // The Python twin has enforced this since 2026-07-29; this repo did not, so
  // the two disagreed in CODE. It fires on ZERO prod rows today (measured
  // 2026-07-31, see the PARITY REPAIR note above the version constant), which
  // is why it carries no POLICY_VERSION bump — it is the backstop for the next
  // uncovered first-party row, not a live demotion.
  // ADR-009 observed-seller trust tier (docs/adr009_observed_seller_trust_decision.md,
  // Option C). Classify by content SOURCE, not the legacy merchant_id='external_seed'
  // string: external seeds now mirror under per-brand observed sellers (merch_obs_…).
  //   - isExternalSeedContent: legacy 'external_seed' lump OR an observed seller —
  //     both are scraped supply and must clear the index/quality gate.
  //   - isObservedSeller: the brand's own D2C crawl (merch_obs_), authoritative for
  //     its own content, so exempt from the identity-COVERAGE shadow gates (below)
  //     like a first-party merchant — but NOT from the index/quality gate.
  const _merchantId = product ? String(product.merchant_id || '') : '';
  // The lane predicate adds the source_system and seed-id arms this hand-rolled
  // trio lacked, so a mirrored row whose platform is its upstream's (the minted
  // lane) is no longer missed.
  //
  // BE PRECISE ABOUT WHAT THIS GATES — an earlier version of this comment said
  // "the index/quality gate", which is wrong. This flag has exactly ONE
  // consumer, isIdentityCoverageExempt below; the index/quality gate (`!ips` ->
  // blocked, and ipsEligible) never reads it. So widening does not gate more
  // rows on quality — it strips the identity-COVERAGE exemption, i.e. public ->
  // shadow. Safe for exposure, but a live serving demotion, which is why it
  // needs a POLICY_VERSION bump and the Python twin moving with it.
  // Measured on prod 2026-08-17: the new arms catch ZERO rows the old trio did
  // not, so today's demotion blast radius is 0.
  const isExternalSeedContent =
    isExternalSeedLaneProduct(product) || isObservedSellerMerchantId(_merchantId);
  const isObservedSeller = isObservedSellerMerchantId(_merchantId);
  if (product) {
    if (!ips) {
      reasons.push(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE);
      return { decision: 'blocked' };
    }
    if (ips) {
      // ADR-008 SLICE 1 parity with the Python twin: the citation read surface
      // accepts the OFFER-FREE index_eligible floor when INDEX_ELIGIBLE_READ is
      // ON. Flag OFF ⇒ serving_eligible-only, byte-identical to before.
      const ipsEligible =
        ips.serving_eligible === true ||
        (indexEligibleReadEnabled() && ips.index_eligible === true);
      if (!ipsEligible) {
        reasons.push(REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE);
        return { decision: 'blocked' };
      }
    }
    const syncStatus = String(product.sync_status ?? '').toLowerCase();
    if (syncStatus && syncStatus !== 'live') {
      reasons.push(REASON_CODES.PUBLISH_STATE_NOT_PUBLIC);
      return { decision: 'blocked' };
    }

    // PER-ROW price gate. Immediately after the index gate on purpose: the
    // index gate answers for the CONTENT_KEY, this one answers for the
    // PRODUCT_KEY being decided, and a row that fails the coarse gate must keep
    // reporting INDEX_NOT_SERVING_ELIGIBLE rather than being relabelled. See the
    // OFFER_PRICE_MISSING entry in the reason-code vocabulary above for the
    // grain argument and the measured 4-row blast radius.
    //
    // Tri-state: only an explicit false blocks. `=== false` and not
    // `!rowHasPricedOffer` — the difference IS the contract, since null must
    // fall through untouched.
    if (rowHasPricedOffer === false) {
      reasons.push(REASON_CODES.OFFER_PRICE_MISSING);
      return { decision: 'blocked' };
    }
  }

  // Test/demo merchant gate. Placed here for the same reason as the
  // renderability gate below: AFTER the lifecycle/index gates, so a rig that is
  // already blocked keeps reporting its real reason (ROW_TOMBSTONED,
  // MERCHANT_STORE_INACTIVE, …) and ONLY a rig that would otherwise reach
  // public/shadow is reclassified. Measured 2026-07-27: all 1,561 rig rows in
  // catalog_row_trust are already 'blocked', so this arm fires on zero rows
  // today and every decision and reason code is byte-identical — which is
  // exactly why POLICY_VERSION does NOT bump for this change (see the
  // versioning note at the top of this file, and the P3 worked example).
  //
  // Why this gate exists at all: before it, the ONLY thing keeping a rig out of
  // 'public' here was data — suppression_reason making the lifecycle
  // 'tombstoned'. Clear the suppression and the rig derived straight through to
  // 'public', while notTestMerchantSql correctly excluded it on every other
  // serving lane. That split-brain was the gap ADR-018's census left open.
  //
  // Reads the BAKED-IN list only (TEST_MERCHANT_IDS), never the env hatch
  // getTestMerchantIds(). catalog_row_trust is shared state written by BOTH
  // this service and the pivota-backend twin; a per-service env var would make
  // the two derive different decisions for the same row and flap it
  // public↔blocked, the same hazard documented for CATALOG_TRUST_RENDERABLE_GATE.
  // Code-only inputs here; the env hatch still applies on the runtime lanes.
  if (product && TEST_MERCHANT_IDS.includes(String(product.merchant_id ?? '').trim())) {
    reasons.push(REASON_CODES.TEST_MERCHANT_EXCLUDED);
    return { decision: 'blocked' };
  }

  // c1.v0.5 renderability gate. Deliberately AFTER the lifecycle/index gates so
  // a row that is already blocked keeps reporting its real reason, and only
  // rows that would otherwise reach public/shadow are reclassified. Tri-state:
  // only an explicit false blocks — an absent input leaves the decision exactly
  // as c1.v0.4.
  if (renderableGateEnabled() && pdpRouteResolvable === false) {
    reasons.push(REASON_CODES.PDP_ROUTE_UNRESOLVABLE);
    return { decision: 'blocked' };
  }

  // Shadow conditions — would have served under legacy gates, but the
  // contract gates them out of public reads.
  //
  // c1.v0.3 + ADR-009 Option C: exempt from the identity-COVERAGE shadow gates
  // both (a) connected first-party merchants (the merchant IS the source of
  // truth — the pipeline exists to verify scraped third-party content) and
  // (b) per-brand observed sellers (merch_obs_, the brand's own D2C crawl,
  // authoritative for its own content). The legacy anonymous 'external_seed'
  // lump stays subject. review_required and IDENTITY_CONFLICT still apply to
  // everyone (explicit moderation/data-quality signals, not coverage gaps).
  //
  // BUT an observed seller is only "the brand's own crawl" when the seed is
  // seed_kind='self'. A RETAILER-sourced observed seller — a no-D2C brand
  // crawled from a marketplace (VODANA→Amazon), tagged seed_kind='cross' by
  // derive_seed_seller — is NOT authoritative for its own content and must stay
  // subject to the shadow gate (else it serves PUBLIC as brand-official). Gate
  // on the EXPLICIT 'cross' only: missing / 'self' / legacy-null stays exempt,
  // so no existing public observed-seller row is demoted. This arm was present
  // in the Python twin only; the two disagreed live until c1.v0.5.
  const _seedKind = product ? String(product.seed_kind ?? '').trim().toLowerCase() : '';
  const isObservedSellerExempt = isObservedSeller && _seedKind !== 'cross';
  const isIdentityCoverageExempt =
    !!product && (!isExternalSeedContent || isObservedSellerExempt);

  if (identityDecision.status === 'review_required') {
    reasons.push(REASON_CODES.IDENTITY_REVIEW_REQUIRED_LIVE_READ);
  }

  const missingConfidence =
    (identityDecision.status === 'unknown' || identityDecision.status === 'approved') &&
    identityDecision.confidence == null;
  if (missingConfidence) {
    if (isIdentityCoverageExempt) {
      reasons.push(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY);
    } else {
      reasons.push(REASON_CODES.IDENTITY_CONFIDENCE_NULL);
    }
  }

  if (identityDecision.status === 'approved' && identityDecision.liveRead === false) {
    if (!isIdentityCoverageExempt) {
      reasons.push(REASON_CODES.IDENTITY_LIVE_READ_DISABLED);
    }
  }

  // c1.v0.7: a row that is not its content_key's elected canonical is a
  // duplicate of a sibling that holds the public URL. It SHADOWS — see the
  // NON_CANONICAL_DUPLICATE entry above for why shadow and not blocked, and for
  // the 121-row measured blast radius.
  //
  // `=== false` and not `!rowIsElectedCanonical`: null means no election exists
  // for this content_key, which must leave the decision untouched.
  if (rowIsElectedCanonical === false) {
    reasons.push(REASON_CODES.NON_CANONICAL_DUPLICATE);
  }

  const shadow =
    identityDecision.status === 'review_required' ||
    reasons.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL) ||
    reasons.includes(REASON_CODES.IDENTITY_LIVE_READ_DISABLED) ||
    reasons.includes(REASON_CODES.NON_CANONICAL_DUPLICATE) ||
    (identityDecision.status === 'unknown' && !isIdentityCoverageExempt);

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
