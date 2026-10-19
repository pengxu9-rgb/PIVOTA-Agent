'use strict';

const { isExternalSeedSupplyMerchantId } = require('./externalSeedLane');

// The settled "this product's seed is not active" fact, for the 404 that
// get_pdp_v2 ends in when nothing could build a sig_ product.
//
// WHY. get_pdp_v2's seed-status precheck answers a non-active seed with
// `404 PRODUCT_NOT_FOUND, details.reason = external_seed_not_active`, and
// agent.pivota.cc's PDP turns exactly that reason into a 404 that ISR caches for
// an hour. But the precheck only fires for an `ext_`-shaped entry id. ADR-009
// re-keyed seed rows onto observed sellers (`merch_obs_…`) whose source_product_id
// is a `<domain>:<hash>` id, so for those the precheck never runs, the content
// lookups (status = 'active' only) miss, and the route ends in a REASON-LESS 404.
// A reason-less 404 is also what a swallowed DB error produces, so the frontend
// rightly keeps it a 500. The result: every retired re-keyed product 500s forever
// (sig_bec7d573…, sig_d839dd6f… on 2026-10-18: bingbot, ~half the LB 5xx alert).
//
// TWO STEPS, because a wrong reason costs a cached 404 on a live product.
//
// 1. readSignatureSeedNotActive (sync) — CANDIDATE. The exact-signature
//    resolver's seed LATERAL joins on `eps.external_product_id =
//    cp.source_product_id` and ranks ACTIVE FIRST, so a non-active winner means
//    that join found no active seed. That is narrower than what the renderer
//    accepts (the content lookup also matches id::text and three seed_data
//    paths), and the resolver's outer catch turns a non-timeout error into a
//    null ref, which never reaches here at all. So the candidate alone proves
//    nothing about the content lookup that actually failed.
//
// 2. settleSignatureSeedNotActive (async) — SETTLED. THE GUARANTEE is the fresh
//    check: a FRESH, UNCAUGHT statement over the content lookup's FULL match set
//    (ACTIVE_SEED_MATCH_SQL below) must complete and find no active seed for the
//    id. It cannot be fooled by a swallowed error, a shared in-flight promise, a
//    stage timeout or a cached negative, because it asks the database itself,
//    now, and any failure withholds.
//    The swallowed-failure ledger (pdpSwallowedFailureLedger) is DEFENCE IN
//    DEPTH, not the guarantee: it also withholds when this request saw a failure
//    (and skips the fresh check then), but it does not see failures inside
//    another request's shared in-flight promise, the identity rescue's own
//    budget timeout, or the 10-minute negative cache.
//    The canonical ref must also still be the one the signature resolved to.
//    Any failure, any doubt, or any active match → null, and the 404 stays
//    reason-less exactly as before.
//
// SCOPE of the candidate — deliberately narrow:
//   - only the `catalog_products_signature_exact` ref, the one that carries the
//     joined seed status;
//   - only a seed-supply seller (sentinel or merch_obs_);
//   - only when the seed IS the id the content route keyed on (its
//     external_product_id equals the resolved product id);
//   - only for ids the precheck does NOT already cover (non-`ext_` ids), so the
//     existing `external_seed_status_precheck` exit stays byte-identical.
// The caller uses the result ONLY to annotate a 404 the route was already
// returning, so it cannot turn any 200 into a 404.
function readSignatureSeedNotActive(signatureProductRef, { resolvedMerchantId, resolvedProductId } = {}) {
  if (!signatureProductRef || typeof signatureProductRef !== 'object') return null;
  if (signatureProductRef.source !== 'catalog_products_signature_exact') return null;
  const merchantId = String(resolvedMerchantId || '').trim();
  const productId = String(resolvedProductId || '').trim();
  if (!merchantId || !productId) return null;
  if (!isExternalSeedSupplyMerchantId(merchantId)) return null;
  const lowerProductId = productId.toLowerCase();
  if (lowerProductId.startsWith('ext_') || lowerProductId.startsWith('ext:')) return null;
  const status = String(signatureProductRef.external_seed_status || '').trim().toLowerCase();
  if (!status || status === 'active') return null;
  const seedProductId = String(signatureProductRef.external_seed_external_product_id || '').trim();
  if (seedProductId !== productId) return null;
  return {
    reason: 'external_seed_not_active',
    external_seed_status: status,
    external_seed_id: String(signatureProductRef.external_seed_id || '').trim() || null,
    external_product_id: seedProductId,
  };
}

// THE CONTENT LOOKUP'S MATCH SET, as one statement that does not catch.
//
// TWIN of fetchExternalSeedProductDetailFromDb (src/server.js): its exact matches
// (`external_product_id = $1`, `id::text = $1`) and its seed_data fallback
// (`seed_data->>'external_product_id'`, `seed_data->>'product_id'`,
// `seed_data->'snapshot'->>'product_id'`), all under `status = 'active'`. If that
// lookup learns a new way to match a seed, add it here too, or this check can
// call an id "retired" while the renderer would still find its seed.
//
// Split into EXISTS branches with the `seed_data ? 'k'` guard, so each one can use
// its migration-040 partial index. `seed_data ? 'k' AND seed_data->>'k' = $1` is
// equivalent to `seed_data->>'k' = $1` for a non-null $1, so the match set is
// unchanged. The single OR form the content lookup uses cannot use those indexes
// (pdpRouteIdExistence.js documents the same trap).
const ACTIVE_SEED_MATCH_BRANCHES = Object.freeze([
  ['external_product_id', `external_product_id = $1`],
  ['seed_id', `id::text = $1`],
  ['seed_data_external_product_id', `seed_data ? 'external_product_id' AND seed_data->>'external_product_id' = $1`],
  ['seed_data_product_id', `seed_data ? 'product_id' AND seed_data->>'product_id' = $1`],
  ['seed_snapshot_product_id', `seed_data ? 'snapshot' AND seed_data->'snapshot'->>'product_id' = $1`],
]);

// The exact half of that match set, in the order the content lookup tries it.
// fetchExternalSeedProductDetailFromDb iterates THIS list (its `matched_via`
// labels are these names), so the lookup and the fresh check cannot drift.
const SEED_EXACT_MATCHES = Object.freeze(
  ACTIVE_SEED_MATCH_BRANCHES.filter(([name]) => name === 'external_product_id' || name === 'seed_id'),
);

// The seed_data half of that match set, as ONE guarded disjunction, for
// fetchExternalSeedProductDetailFromDb's fallback lookup. Each arm carries its
// `seed_data ? 'k'` guard, so the planner can prove every arm implies its
// partial index's predicate and answers with a BitmapOr over the three indexes.
// The unguarded `->> = $1 OR …` form it replaces could not use them, and
// seq-scanned external_product_seeds on every miss: ~2.1s (5.6s under load) per
// lookup, twice per not-found PDP. That was enough to push the retired-seed 404
// past agent.pivota.cc's 9s+3s budget (PIVOTA-Agent#2461 follow-up). Local
// EXPLAIN on a 200k-row copy with migration 040's indexes: 75 ms seq scan →
// 0.02 ms, the same row chosen, under a forced generic plan too. Built from
// ACTIVE_SEED_MATCH_BRANCHES so the two cannot drift.
const SEED_DATA_FALLBACK_MATCH_CLAUSE = `(${ACTIVE_SEED_MATCH_BRANCHES.filter(([name]) =>
  name.startsWith('seed_data_') || name.startsWith('seed_snapshot_'),
)
  .map(([, clause]) => `(${clause})`)
  .join(' OR ')})`;

const ACTIVE_SEED_MATCH_SQL = `
  SELECT
    ${ACTIVE_SEED_MATCH_BRANCHES.map(
      ([name, clause]) =>
        `EXISTS (SELECT 1 FROM external_product_seeds WHERE status = 'active' AND ${clause}) AS ${name}`,
    ).join(',\n    ')}
`;

// True ONLY when the statement completed and every branch answered an explicit
// `false`. Throws on any query failure or malformed answer; the caller treats a
// throw as "unknown".
async function confirmNoActiveSeedMatches(productId, { queryFn }) {
  const id = String(productId || '').trim();
  if (!id) throw new Error('product_id is required');
  if (typeof queryFn !== 'function') throw new Error('no database is configured');
  const res = await queryFn(ACTIVE_SEED_MATCH_SQL, [id]);
  const row = res && Array.isArray(res.rows) ? res.rows[0] : null;
  if (!row || typeof row !== 'object') throw new Error('active seed match query returned no row');
  for (const [name] of ACTIVE_SEED_MATCH_BRANCHES) {
    if (typeof row[name] !== 'boolean') {
      throw new Error(`active seed match column ${name} is not boolean`);
    }
  }
  return ACTIVE_SEED_MATCH_BRANCHES.every(([name]) => row[name] === false);
}

/**
 * @returns {Promise<object|null>} the details to put on the 404, or null to keep it reason-less.
 */
async function settleSignatureSeedNotActive(candidate, {
  queryFn,
  isLedgerClean,
  legacyDetailFallbackEnabled = false,
  canonicalRefUnchanged = false,
  onWithheld = null,
} = {}) {
  if (!candidate) return null;
  const withhold = (why) => {
    try {
      if (typeof onWithheld === 'function') onWithheld(why);
    } catch {
      // diagnostics only
    }
    return null;
  };
  // The legacy seed fallback (findExternalSeedProductById) is a second content
  // lookup with its own match rules; with it on, the twin above is not the whole
  // match set. Default off in prod; when on, stay reason-less.
  if (legacyDetailFallbackEnabled) return withhold('legacy_detail_fallback_enabled');
  // The candidate describes the ref the SIGNATURE resolved to. Later stages
  // (identity reconciliation's refPatch) may move canonicalProductRef; if they
  // did, the product that failed to build is not the one the candidate is about.
  if (canonicalRefUnchanged !== true) return withhold('canonical_ref_changed');
  if (typeof isLedgerClean !== 'function' || !isLedgerClean()) return withhold('swallowed_failure_on_request');
  let noActiveSeed = false;
  try {
    noActiveSeed = await confirmNoActiveSeedMatches(candidate.external_product_id, { queryFn });
  } catch (err) {
    return withhold(`active_seed_check_failed:${String(err?.message || err).slice(0, 80)}`);
  }
  if (!noActiveSeed) return withhold('active_seed_matches');
  // Re-read: nothing may have failed while the check ran.
  if (!isLedgerClean()) return withhold('swallowed_failure_on_request');
  return candidate;
}

module.exports = {
  SEED_DATA_FALLBACK_MATCH_CLAUSE,
  SEED_EXACT_MATCHES,
  readSignatureSeedNotActive,
  settleSignatureSeedNotActive,
  __internal: { ACTIVE_SEED_MATCH_BRANCHES, ACTIVE_SEED_MATCH_SQL, confirmNoActiveSeedMatches },
};
