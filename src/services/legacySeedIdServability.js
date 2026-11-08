'use strict';

// Search must not serve an id get_product cannot open (FIX_PLAN D-06).
//
// THE COHORT. pivota-backend's enrichment ingest mints a seed's external_product_id as
// `<host-slug>:<16 hex>` (services/catalog_enrichment_agent/ingestion.py `_build_seed_inserts`:
// `f"{merchant_slug}:{seed_id.split(':')[-1]}"`, e.g. `shop-a:4263b7e739ebca01`). A seed whose
// catalog mirror row was re-keyed (ADR-009) is served under its observed seller (`merch_obs_…`) and a
// `sig_` id, and opens. A seed with NO mirror row is served as the retired shared bucket
// (the sentinel seller id), with that raw id, no signature and no link.
//
// WHY IT CANNOT OPEN. The commerce get_product is merchant-scoped. For the shared bucket and a non-`sig_`
// id, externalSeedLane.isSeedSupplyUnservableUpstream is false, so invokeCommerceKernelRawUpstream sends
// it to the backend's /agent/shop/v1/invoke get_product_detail. That handler reads products_cache only
// (routes/agent_shop_gateway.py `_handle_get_product_detail`), never external_product_seeds, so it answers
// PRODUCT_NOT_FOUND, which maps to NO_MERCHANT_OFFER. Measured on the 11-02 synthetic run: 6 such rows
// on 4 hosts from one query, 2 followed, 2 NO_MERCHANT_OFFER. The unscoped lane cannot open them either:
// it reads signature ids only (publicReadChainResolvability, 0 of 5 sampled `brand-x:…` ids resolved).
// There is no current row to re-key them to (no mirror row, so no signature), so the answer is to stop
// serving them, not to resolve them.
//
// DROP ONLY THIS COHORT. All three must hold: the retired bucket as the seller, the legacy id shape, and
// no `sig_` signature on the row. `ext_…` / `ext:…` seed ids, `sig_` ids and every re-keyed seller keep
// serving exactly as before.

const { isExternalSeedSupplyMerchantId, isSeedSupplyUnservableUpstream } = require('./externalSeedLane');

// `<slug>:<16 lowercase hex>`. The slug is `_normalize_token(domain)` with spaces turned to '-', so only
// [a-z0-9] runs joined by single '-'.
const LEGACY_SEED_PRODUCT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*:[0-9a-f]{16}$/;

function text(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

function isLegacySeedProductId(productId) {
  const pid = text(productId);
  if (!LEGACY_SEED_PRODUCT_ID_RE.test(pid)) return false;
  // `ext:<…>` is the seed-routed id prefix (pdpRenderability.isSeedRoutedLane), not this cohort.
  return !pid.startsWith('ext:');
}

function rowMerchantId(row) {
  return text(row.merchant_id) || text(row.merchantId);
}

function rowProductId(row) {
  return text(row.product_id) || text(row.productId) || text(row.id);
}

function rowCarriesSignature(row) {
  return [row.pivota_signature_id, row.signature_id, row.product_id, row.id].some((v) => text(v).startsWith('sig_'));
}

/** True only for a row get_product provably cannot open: shared bucket + legacy id + no signature. */
function isUnopenableLegacySeedRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const mid = rowMerchantId(row);
  const pid = rowProductId(row);
  if (!isLegacySeedProductId(pid) || rowCarriesSignature(row)) return false;
  // The seller test is get_product's OWN routing test, so the two cannot drift: seed supply that the
  // dispatcher would NOT keep on this gateway's seed lane goes to the backend's products_cache-only detail.
  // For a non-`sig_` id that leaves exactly the shared bucket (an observed seller stays on the seed lane).
  return isExternalSeedSupplyMerchantId(mid) && !isSeedSupplyUnservableUpstream(mid, pid);
}

function isLegacySeedIdFilterEnabled(env = process.env) {
  const raw = String(env.SEARCH_DROP_LEGACY_SEED_IDS ?? '').trim().toLowerCase();
  if (raw === '') return true; // default ON: a row get_product cannot open is not a search result
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Remove the cohort from a search body's `products`. Returns the body unchanged (same object) when nothing
 * is dropped, the filter is off, or the body carries no products array.
 * @returns {{ body: any, droppedCount: number, droppedIds: string[] }}
 */
function dropUnopenableLegacySeedRows(body, env = process.env) {
  if (!isLegacySeedIdFilterEnabled(env) || !body || typeof body !== 'object' || !Array.isArray(body.products)) {
    return { body, droppedCount: 0, droppedIds: [] };
  }
  const droppedIds = [];
  const kept = body.products.filter((row) => {
    if (!isUnopenableLegacySeedRow(row)) return true;
    droppedIds.push(rowProductId(row));
    return false;
  });
  if (!droppedIds.length) return { body, droppedCount: 0, droppedIds };
  return { body: { ...body, products: kept }, droppedCount: droppedIds.length, droppedIds };
}

module.exports = {
  LEGACY_SEED_PRODUCT_ID_RE,
  dropUnopenableLegacySeedRows,
  isLegacySeedIdFilterEnabled,
  isLegacySeedProductId,
  isUnopenableLegacySeedRow,
};
