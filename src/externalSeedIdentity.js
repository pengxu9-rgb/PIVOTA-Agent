// The LEGACY external-seed predicate, kept only until its call sites stop asking the question.
//
// THIS IS NOT THE OWNER. The owner is src/services/externalSeedLane.js —
// "Gateway-side adapter for the ONE seed-lane predicate" — over
// src/services/pdpRenderability.js's `isSeedRoutedLane`, built across ~15 PRs (#1770–#1799)
// for the ADR-009 phase-3 re-key, and already imported by src/server.js:102-103. An earlier
// version of this header called THIS module "the one place that answers: is this row an
// external seed?", which was simply false: I enumerated the predicates by grepping for
// `is*External*Seed*` NAMES, and the canonical one is called `isSeedRoutedLane`, so it never
// matched. Consolidating a scattered concern is exactly when an N+1th implementation is most
// tempting and most harmful.
//
// WHY IT STILL EXISTS RATHER THAN BEING DELETED. Deleting it means putting the seller
// comparison back inline at server.js:15417 and findProductsMulti/policy.js — and
// tests/scripts/external_seed_merchant_literal_ratchet.test.js is shrink-only per file
// (`count > baseline[file] || 0` fails), so that is a migration REGRESSION the guard
// correctly refuses. The literal cannot be relocated; it can only be removed. Removing it
// means the call sites stop asking the seller question, which is branch deletion, which is
// blocked on the mint sites below. So this file is a waypoint, and it says so.
//
// WHAT IT IS NOT INTERCHANGEABLE WITH. `isExternalSeedLaneProduct` is NOT a superset of this
// predicate, measured on real shapes:
//
//   shape                          legacy(here)   lane owner
//   served canonical-chain seed    false          TRUE
//   source = 'external_seed'       TRUE           false
//   source_product_id 'ext_…'      false          TRUE
//
// It both widens (the 13,896 canonical-chain rows) and NARROWS (it does not read `source` at
// all). The owner's own header says as much: lane membership "is deliberately NOT a synonym
// for any call site's full notion of external" and call sites must keep their local legs and
// OR them. So a blind delegation here would silently arm branches slated for deletion AND
// drop a leg. That is why this is a shim and not a forwarder.
//
// CORRECTION TO WHAT THIS FILE USED TO CLAIM. It said `isExternalSeedRow` is "the union of
// what the five accept today" and "never NARROWS a call site". Both false. It is the union of
// the TWO predicates it actually replaced (server.js:15417 and policy.js), verified over
// 879,841 row shapes with zero narrowings against those two. Against the other implementations
// it is strictly narrower: pdpBuilder.js:233 also accepts `purchase_route` ∈
// {affiliate_outbound, merchant_site, external_redirect, links_out} and `commerce_mode` ∈
// {links_out, affiliate_outbound, merchant_site} and normalises with stripHtml, and
// findProductsInvokeSemanticOwnerExecution.js:111 matches `source` by SUBSTRING. Delegating
// either of those to this module would flip branches — pdpBuilder's is exported and used at
// 18 sites, including PDP redirect resolution and renderability.
//
// A SIXTH implementation exists and was missed by the original survey:
// src/services/pdpIngredientAuthority.js:954, keyed additionally on `external_seed_id` and
// `external_seed_recall`. `external_seed_id` IS set on products (src/server.js:17317), so it
// is plausibly the one predicate here that does fire.
//
// PRODUCTION MEASUREMENT, and the limit of what it proves. catalog_products.platform is
// external_seed=13896, shopify=1545, wix=40, url_audit=34, brand_authored=1 — 'external' never
// occurs; zero catalog_products/catalog_offers rows carry the sentinel seller id; served
// rows carry platform='external_seed' 90/90 and never source='external_seed'. That is about DB
// columns and served JSON. These predicates run on IN-MEMORY objects, and
// buildBeautyExternalSeedMainlineProduct (src/server.js:16635, consumed at :17301) mints
// the sentinel seller, platform='external' AND source='external_seed' — true on every leg. So "all five are false in production" does NOT hold for the objects these branches
// filter, and the branches are NOT dead. Deleting them is blocked until the MINT sites stop
// minting the sentinel, which is ADR-009 phase 3's job.

const SEED_MERCHANT_ID = 'external_seed';

// Accepted by at least one legacy predicate today. Kept as data so the union is inspectable
// and so a test can range over every spelling rather than the one someone remembered.
const LEGACY_SEED_SOURCES = Object.freeze([
  'external_seed',
  'external_product_seeds',
  'external_seed_db',
]);

// What production actually emits. `external` is here ONLY because two legacy predicates check
// it; it matches nothing, and the test says so, so nobody re-adds it believing it works.
const LEGACY_SEED_PLATFORMS = Object.freeze(['external']);
const OBSERVED_SEED_PLATFORMS = Object.freeze(['external_seed']);

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Every field any legacy predicate reads, in one place, so a caller cannot miss an alias.
function externalSeedFields(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    merchantId: norm(row.merchant_id || row.merchantId || (row.merchant && row.merchant.id)),
    source: norm(
      row.source || row.product_source || row.productSource || row.detail_source || row.query_source,
    ),
    platform: norm(row.platform || row.source_platform),
    catalogTrack: norm(row.catalog_track || row.catalogTrack),
  };
}

// TODAY'S ANSWER. Behaviour-preserving by construction: the union of what the five legacy
// predicates accept. Note this is case-insensitive on merchant_id, where server.js:15417 was
// case-SENSITIVE — a widening that brings it in line with the other four and that affects zero
// production rows, since no row carries 'external_seed' as a merchant_id in any casing.
function isExternalSeedRow(row) {
  const f = externalSeedFields(row);
  if (!f) return false;
  return (
    f.merchantId === SEED_MERCHANT_ID ||
    LEGACY_SEED_SOURCES.includes(f.source) ||
    LEGACY_SEED_PLATFORMS.includes(f.platform)
  );
}

// THE ANSWER THE DATA CALLS FOR — delegated to the owner rather than invented here. An earlier
// version added `platform === 'external_seed'` locally and presented it as a finding; that arm
// already existed in isSeedRoutedLane, along with a source_system arm and an ext_/ext: id-prefix
// arm this module never had. Still wired to nothing: see the header for why the branches it
// would arm cannot be deleted yet.
function isExternalSeedRowCorrected(row) {
  if (!row || typeof row !== 'object') return false;
  const { isExternalSeedLaneProduct } = require('./services/externalSeedLane');
  // OR, not replace — the owner does not read `source`, which this predicate's call sites do.
  return isExternalSeedRow(row) || isExternalSeedLaneProduct(row);
}

// Non-null when the two answers differ, so the size of the pending decision can be measured on
// live traffic instead of argued about.
function externalSeedDisagreement(row) {
  const legacy = isExternalSeedRow(row);
  const corrected = isExternalSeedRowCorrected(row);
  if (legacy === corrected) return null;
  const f = externalSeedFields(row) || {};
  return { legacy, corrected, platform: f.platform, source: f.source, merchant_id: f.merchantId };
}

module.exports = {
  isExternalSeedRow,
  isExternalSeedRowCorrected,
  externalSeedDisagreement,
  externalSeedFields,
  SEED_MERCHANT_ID,
  LEGACY_SEED_SOURCES,
  LEGACY_SEED_PLATFORMS,
  OBSERVED_SEED_PLATFORMS,
};
