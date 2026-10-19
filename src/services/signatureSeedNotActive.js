'use strict';

const { isExternalSeedSupplyMerchantId } = require('./externalSeedLane');

// The settled "this product's seed is not active" fact, read off a sig_ row the
// exact-signature resolver already returned — for the 404 that get_pdp_v2 ends
// in when nothing could build the product.
//
// WHY. get_pdp_v2's seed-status precheck answers a non-active seed with
// `404 PRODUCT_NOT_FOUND, details.reason = external_seed_not_active`, and
// agent.pivota.cc's PDP turns exactly that reason into a cached 404. But the
// precheck only fires for an `ext_`-shaped entry id. ADR-009 re-keyed seed rows
// onto observed sellers (`merch_obs_…`) whose source_product_id is a
// `<domain>:<hash>` id, so for those the precheck never runs, the content
// lookups (status = 'active' only) miss, and the route ends in a REASON-LESS
// 404. A reason-less 404 is also what a swallowed DB error produces, so the
// frontend rightly keeps it a 500 — and every retired re-keyed product 500s
// forever (sig_bec7d573…, sig_d839dd6f… on 2026-10-18: bingbot, ~half the LB
// 5xx alert).
//
// WHY IT IS SETTLED. The exact-signature resolver's seed LATERAL ranks ACTIVE
// FIRST, so a non-active winner means no active seed backs this row in that
// lane. And that query does not swallow its failures: a timeout becomes a 503,
// any other error propagates. So a non-active status here is a fact about the
// product, not about the read path.
//
// SCOPE — deliberately narrow:
//   - only the `catalog_products_signature_exact` ref, the one that carries the
//     joined seed status;
//   - only a seed-supply seller (sentinel or merch_obs_);
//   - only when the seed IS the id the content route keyed on (its
//     external_product_id equals the resolved product id), so the status is
//     about the row that failed to build and not some other attached seed;
//   - only for ids the precheck does NOT already cover (non-`ext_` ids), so the
//     existing `external_seed_status_precheck` exit stays byte-identical.
// The caller uses it ONLY to annotate a 404 the route was already returning, so
// it cannot turn any 200 into a 404.
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

module.exports = { readSignatureSeedNotActive };
