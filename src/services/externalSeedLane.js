'use strict';

// Gateway-side adapter for the ONE seed-lane predicate.
//
// WHY THIS FILE EXISTS
// --------------------
// The legacy synthetic merchant `external_seed` is being retired: ADR-009
// phase 3 re-keys catalog_products rows from the sentinel onto per-domain
// observed sellers (`merch_obs_…`). 1,365 rows written by the SAME writer are
// ALREADY re-keyed in prod, so any reader that still keys on the literal
// `merchant_id === 'external_seed'` is ALREADY treating two halves of one
// corpus differently — and would drop or misclassify the remaining ~8,974 the
// moment they flip.
//
// The re-key touches `merchant_id` and NOTHING ELSE (ADR-009 D4.2 — product_key
// and signatures are explicitly frozen). So `platform` and `source_system`
// survive the flip untouched and are the durable discriminators. That is the
// pattern ~15 merged gateway PRs (#1770–#1799) already established, and
// pdpRenderability.isSeedRoutedLane is its canonical statement: a 4-way OR over
// merchant_id OR platform OR source_system OR an `ext_`/`ext:` id prefix.
//
// This module does NOT restate that predicate. It imports it, and adds only the
// thing pdpRenderability deliberately does not carry: tolerance for the loose,
// alias-riddled product objects the serving surfaces pass around
// (`merchantId` vs `merchant_id`, `product_id` vs `id`, payload-nested
// platform). pdpRenderability is a strict twin of pivota-backend
// services/pdp_renderability.py and is row-shaped by contract; putting
// JS-only alias normalization there would be exactly the Python/Node twin
// drift this project keeps paying for. Hence a separate, dependency-free
// adapter instead.
//
// SCOPE — this answers LANE MEMBERSHIP ONLY: "did the external-seed writer
// produce this row?" It is deliberately NOT a synonym for any call site's
// full notion of "external". Call sites that also treat `platform = 'external'`
// or `source = 'external'` or `retrieval_source = 'external_seed'` as external
// keep those legs locally and OR them with this one — otherwise migrating the
// merchant_id leg would silently change behaviour for rows that were never
// part of this migration.
//
// It is also NOT a trust or test-merchant gate. Test/demo rigs are excluded by
// testMerchantPolicy, which must be composed ALONGSIDE this predicate, never
// replaced by it (see RecommendationEngine's externalSeedSourceOnly branch).

const {
  EXTERNAL_SEED_MERCHANT_ID,
  SEED_ROUTED_SOURCE_SYSTEMS,
  isSeedRoutedLane,
  seedRoutedLaneSql,
} = require('./pdpRenderability');

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return '';
}

/**
 * Every id field a migrated call site was reading, PLUS `source_product_id`/`sourceProductId`.
 *
 * Those two are deliberate additions, not restorations: they are the exact fields the canonical
 * predicate and its SQL twin are defined over, so reading them keeps JS and SQL agreeing. The
 * consequence is disclosed rather than hidden — `{source_product_id:'ext_abc', merchant_id:'merch_shopify_1'}`
 * was false before this module and is true now. Fail-closed direction (it routes a row INTO the
 * seed lane, where the gates are stricter), and `pdpRenderability` already defines an `ext_`-prefixed
 * id under a normal merchant as seed-routed. `product_data.*` is the same shape of addition.
 *
 * The pre-migration legs were `product_id || productId || id` — a FALLBACK
 * chain, so a row carrying BOTH a plain `source_product_id` and an `ext_`
 * `product_id` matched on the latter. Collapsing that into a single
 * "source_product_id wins" pick silently NARROWED the predicate:
 * `{source_product_id:'8123456789012', product_id:'ext_abc123'}` stopped being
 * external. So every candidate is tested, not just the first non-empty one.
 *
 * @param {Record<string, unknown>} row
 * @returns {string[]}
 */
function readSeedLaneIdCandidates(row) {
  const out = [];
  for (const value of [row.source_product_id, row.sourceProductId, row.product_id, row.productId, row.id]) {
    const text = firstNonEmptyString(value);
    if (text !== '' && !out.includes(text)) out.push(text);
  }
  return out.length ? out : [''];
}

/**
 * Normalize a loose serving-surface product/row into the fields
 * isSeedRoutedLane is defined over.
 *
 * Every alias here is one a migrated call site was already reading — including
 * `merchant.id`, which RecommendationEngine's getMerchantId reads and which is
 * a real serving shape (chat/search items are constructed carrying a nested
 * `merchant` object — src/server.js:27398 — and ~13 readers use it). Omitting
 * it broke rows that still carry the sentinel TODAY, with no re-key involved.
 *
 * `sourceProductId` here is only the FIRST id candidate; it exists for
 * debugging and for the delegation test. Lane membership is decided over the
 * WHOLE candidate list — see isExternalSeedLaneProduct.
 *
 * @param {unknown} product
 * @returns {{merchantId: string, platform: string, sourceSystem: string, sourceProductId: string}}
 */
// Ignore values that can ONLY have come from a polluted `Object.prototype`. `source_system` is now
// load-bearing for BOTH the candidate stamp and the price join, so `Object.prototype.source_system`
// would otherwise mark every catalog row as seed-lane. The real gate (testMerchantPolicy) is
// SQL-side and unreachable from JS pollution, so this is defence in depth.
//
// Deliberately NOT a bare `Object.hasOwn` own-properties-only read: that also drops fields defined
// on a LEGITIMATE prototype (a class instance with getters, an `Object.create(base)` row), which
// would misclassify a real seed row as internal — the exact inversion this module exists to prevent.
// Pollution lives on Object.prototype specifically, so that is what is excluded.
function own(obj, key) {
  if (!obj) return undefined;
  if (Object.hasOwn(obj, key)) return obj[key];
  // Inherited: fine, UNLESS the only provider is Object.prototype itself.
  return Object.hasOwn(Object.prototype, key) ? undefined : obj[key];
}

function readSeedLaneFields(product) {
  const row = product && typeof product === 'object' && !Array.isArray(product) ? product : {};
  const payloadRaw = own(row, 'product_data');
  const payload = payloadRaw && typeof payloadRaw === 'object' ? payloadRaw : {};
  const merchantRaw = own(row, 'merchant');
  const merchant = merchantRaw && typeof merchantRaw === 'object' && !Array.isArray(merchantRaw)
    ? merchantRaw
    : {};
  return {
    merchantId: firstNonEmptyString(
      own(row, 'merchant_id'),
      own(row, 'merchantId'),
      own(merchant, 'id'),
      own(merchant, 'merchant_id'),
      own(payload, 'merchant_id'),
    ),
    platform: firstNonEmptyString(
      own(row, 'platform'),
      own(row, 'platform_metadata')?.platform,
      own(payload, 'platform'),
      own(payload, 'platform_metadata')?.platform,
    ),
    sourceSystem: firstNonEmptyString(own(row, 'source_system'), own(row, 'sourceSystem'), own(payload, 'source_system')),
    sourceProductId: readSeedLaneIdCandidates(row)[0],
  };
}

/**
 * "Was this row produced by the external-seed writer?" — the loose-object form
 * of pdpRenderability.isSeedRoutedLane.
 *
 * Answers TRUE identically for a row still carrying the `external_seed`
 * sentinel and for the same row after ADR-009 phase 3 re-keys it to
 * `merch_obs_…`, because the platform / source_system legs are untouched by the
 * re-key. That equivalence is the whole point of the migration and is what the
 * parity tests assert.
 *
 * DISCLOSED WIDENING — id-prefix case sensitivity. The pre-migration legs were
 * `pid.startsWith('ext_')`: case-SENSITIVE and `ext_` only. The canonical
 * predicate lowercases and also accepts `ext:`, so `id:'EXT_ABC'` reads as seed
 * lane here where it did not before. Kept deliberately: seedRoutedLaneSql — the
 * SQL twin, used at seven sites in this same change and by src/server.js for
 * PDP signature resolution — ALREADY matches that row today, so narrowing the
 * JS half would manufacture a JS/SQL split of exactly the kind this migration
 * exists to remove. Widening on an id prefix is the riskier direction, so it is
 * stated here rather than left to be discovered.
 *
 * @param {unknown} product
 * @returns {boolean}
 */
function isExternalSeedLaneProduct(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return false;
  const fields = readSeedLaneFields(product);
  return readSeedLaneIdCandidates(product).some((sourceProductId) =>
    isSeedRoutedLane({ ...fields, sourceProductId }),
  );
}

// ADR-009 — "is this MERCHANT ID external-seed supply?", for the call sites that
// hold only an id and no row. Distinct from isExternalSeedLaneProduct (which
// needs a row) and from isSeedRoutedLane, which deliberately has NO merch_obs_
// arm: the lane predicate answers "is this row seed-ROUTED" from row evidence,
// whereas this answers "does this seller supply via the seed pipeline" from the
// id shape alone. server.js:isExternalSeedListingMerchantId is the same test;
// this is the module-level twin so services need not reach into the app entry.
//
// The merch_obs_ arm is what the A9-4 re-key made necessary: seed supply used to
// live under one shared sentinel seller and now lives under per-brand observed
// sellers, so an id-shaped test that names only the sentinel stopped matching
// any live row.
function isExternalSeedSupplyMerchantId(merchantId) {
  const mid = firstNonEmptyString(merchantId);
  if (!mid) return false;
  return mid === EXTERNAL_SEED_MERCHANT_ID || mid.startsWith('merch_obs_');
}

// ADR-009 — "is this seller the brand's OWN D2C crawl?" (a per-brand observed
// seller). Narrower than isExternalSeedSupplyMerchantId on purpose: the retired
// shared bucket is scraped supply but is NOT anyone's own storefront, so callers
// that exempt a brand from identity-coverage gates must ask THIS, not that.
// Owned here so the prefix lives in one watched place instead of being retyped.
function isObservedSellerMerchantId(merchantId) {
  return firstNonEmptyString(merchantId).startsWith('merch_obs_');
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  SEED_ROUTED_SOURCE_SYSTEMS,
  isExternalSeedLaneProduct,
  isExternalSeedSupplyMerchantId,
  isObservedSellerMerchantId,
  readSeedLaneFields,
  readSeedLaneIdCandidates,
  // Re-exported so a SQL call site needs one import, and so the JS and SQL
  // twins of this predicate can never be sourced from different modules.
  seedRoutedLaneSql,
};
