// The one place that answers "is this row an external seed?".
//
// WHY IT EXISTS. Five functions answered it independently — server.js:15417,
// findProductsMulti/policy.js:415, pdpBuilder.js:233,
// findProductsInvokeSemanticOwnerExecution.js:111, and a sixth in pivota-agent-ui's
// ProductDetailClient.tsx:281 — and no two agreed. One compared merchant_id case-SENSITIVELY
// while the others lowercased; one accepted `source` substrings; two accepted
// `platform === 'external'`; the field lists ranged from two aliases to six.
//
// THE MEASUREMENT THAT MATTERS (prod, 2026-09-10, and re-checked against the live agent door
// rather than the table, because a stored shape is not a served fact):
//
//   catalog_products.platform    external_seed=13896  shopify=1545  wix=40  url_audit=34
//                                brand_authored=1     — 'external' occurs ZERO times
//   catalog_products.merchant_id  all 13,896 external_seed rows carry a real merch_* id;
//                                 NONE is the literal 'external_seed'
//   served rows (search_catalog)  platform='external_seed' on 90/90; source ∈ {merchant_public,
//                                 pdp_ingredient_fields, canonical_chain, title_url_anchor,
//                                 catalog_intelligence, brand_seed_map} — never 'external_seed'
//
// So all five predicates return FALSE for every external seed in production. The branches they
// gate — the dominant-brand external detection at server.js:15462, `cacheInternalProducts` at
// :13271, `upstreamExternalOnly` at :13280 — are unreachable, and the metric that would have
// shown it reports 0. They were written against a vocabulary the data stopped using.
//
// WHAT THIS MODULE DOES NOT DO: change that. `isExternalSeedRow` deliberately keeps today's
// semantics, so adopting it is behaviour-preserving. `isExternalSeedRowCorrected` is the
// predicate the data actually calls for, and `externalSeedDisagreement` reports where the two
// differ. Flipping 13,896 rows from false to true across five decision sites at once is not a
// refactor, and it is not obvious it should be flipped at all — under ADR-020 the target model
// is that external-vs-internal stops being a product distinction. That decision deserves its own
// change, taken on measured evidence rather than as a side effect of tidying.

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

// THE ANSWER THE DATA CALLS FOR. Not wired to anything yet — see the module header.
function isExternalSeedRowCorrected(row) {
  const f = externalSeedFields(row);
  if (!f) return false;
  return isExternalSeedRow(row) || OBSERVED_SEED_PLATFORMS.includes(f.platform);
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
