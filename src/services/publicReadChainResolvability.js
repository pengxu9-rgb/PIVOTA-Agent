'use strict';

// Would the public tier's get_product actually serve this search row?
//
// Extracted from src/server.js so the decision is unit-testable WITHOUT a database. That matters more than
// usual here: this predicate runs on the hottest public path, its failure mode is deleting real products from
// search, and the branch that produces it (resolveCatalogProductRefFromPivotaSignature) has several return
// shapes that carry different subsets of the columns.
//
// DROP ONLY WHAT IS PROVABLY DEAD. This is the opposite asymmetry from services/pdpRenderability.js: there,
// under-advertising costs a withheld sitemap URL, so unproven lanes fail CLOSED. Here a false negative
// deletes a product search would have served, so every unproven lane fails OPEN and the honest,
// non-retriable NO_MERCHANT_OFFER error covers whatever slips through.

const { isSeedRoutedLane } = require('./pdpRenderability');

// The resolver has fallback branches that return only { merchant_id, product_id, platform, product_key } —
// no external_seed_* columns at all. Value-checking `external_seed_id` cannot tell those apart from an exact
// row whose LEFT JOIN found no seed, and guessing wrong in the "absent" direction would mass-drop healthy
// seed-routed rows (most of the catalog). So we discriminate on KEY PRESENCE: the exact branch always sets
// these keys, even to undefined; the fallback branches never set them at all.
const SEED_FIELDS = ['external_seed_id', 'external_seed_status'];

function seedFieldsKnown(ref) {
  return SEED_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(ref, field));
}

/**
 * Is this row seed-ROUTED? Asks pdpRenderability's OWN lane-dispatch export, so the two files cannot drift
 * on what "seed-routed" means. This used to pin seedRouteOk:true on the full pdpRouteResolvable — an
 * approximation valid only while every non-seed arm returned false, which the 2026-07-29 wix flip ended:
 * the pin read wix merchant rows as "seed-routed", the chain then demanded a seed they don't have, and
 * every wix product would have vanished from public search. Lane membership and lane verdict are different
 * questions; this function asks ONLY membership. Pinned by
 * tests/public_read_chain_seed_routed_probe.node.test.cjs.
 */
function isSeedRoutedRef(ref) {
  return isSeedRoutedLane({
    merchantId: ref.merchant_id,
    platform: ref.platform,
    sourceSystem: ref.source_system,
    sourceProductId: ref.product_id,
  });
}

/**
 * @param {string|null} productId the id the projector will advertise
 * @param {object|null} ref result of resolveCatalogProductRefFromPivotaSignature, or null
 * @param {(id:string)=>boolean} isSignatureId
 * @returns {boolean} false ONLY when the row is provably unfetchable
 */
function chainRowResolvable(productId, ref, isSignatureId) {
  const pid = String(productId || '').trim();
  if (!pid) return false;
  // Cohort 1 — the unscoped public detail lane only understands Pivota signature ids. Measured on prod
  // 2026-07-25: 0 of 5 sampled non-signature ids (`rejuran:...`) resolved, and every id that DID resolve
  // was a sig_.
  if (!isSignatureId(pid)) return false;
  // No catalog row behind the signature ⇒ get_pdp_v2 has nothing to serve and answers PRODUCT_NOT_FOUND.
  if (!ref || typeof ref !== 'object') return false;

  if (!isSeedRoutedRef(ref)) return true; // another lane — no evidence it is dead, keep it
  if (!seedFieldsKnown(ref)) return true; // resolver did not report the seed route — unknown, keep it

  // Cohort 2 — a seed-routed row whose content route has no acceptable seed. Mirrors seedRouteResolvesSql's
  // acceptance rule and get_pdp_v2's precheck: a seed that exists but is not active is a 404, and a blank
  // status is let through by that precheck.
  const status = String(ref.external_seed_status || '').trim().toLowerCase();
  if (!ref.external_seed_id) return false;
  return status === '' || status === 'active';
}

module.exports = { chainRowResolvable, isSeedRoutedRef, seedFieldsKnown };
