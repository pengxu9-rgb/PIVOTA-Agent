'use strict';

/**
 * Fix A — read-time identity reconciliation for the sellable_item_group_id drift.
 *
 * get_pdp_v2 resolves a product through pdp_identity_listing.sellable_item_group_id
 * and checks serving_eligible on that resolved group's content_key. For a drifted
 * listing, that group is a stale/draft content_key (serving_eligible=false) even
 * though the product's OWN live catalog row IS serving-eligible — so the PDP
 * returns PRODUCT_NOT_SERVABLE for a product that is actually servable, and the
 * product also leaks into recommendations/chat (which gate on the own content_key)
 * as a broken card.
 *
 * This helper decides whether to reconcile: when the resolved group is NOT
 * servable but the product's own row (resolved by merchant+product_id only) IS,
 * prefer the own row. The caller swaps the eligibility and patches the canonical
 * ref so downstream content (which keys mostly on product_id) anchors on the
 * servable row.
 *
 * Flag-gated (default OFF) so it can be validated on staging before enable.
 * Fail-closed: any uncertainty keeps the original (blocked) decision.
 */

function isPdpIdentityReconcileEnabled() {
  return (
    String(process.env.AURORA_BFF_PDP_IDENTITY_RECONCILE_ENABLED || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

/**
 * @param {object} args
 * @param {object|null} args.servingEligibility  resolved (possibly drifted) eligibility row
 * @param {string} args.merchantId
 * @param {string} args.productId
 * @param {(a:{merchantId:string, productId:string}) => Promise<object|null>} args.fetchOwnRowEligibility
 *        resolves eligibility by merchant+product ONLY (the product's own catalog row)
 * @returns {Promise<null | {eligibility: object, refPatch: object, from_content_key: string, to_content_key: string}>}
 *          null = do not reconcile. Otherwise the own-row eligibility plus the
 *          fields to merge onto canonicalProductRef.
 */
async function reconcileToOwnServingRow({
  servingEligibility,
  merchantId,
  productId,
  fetchOwnRowEligibility,
}) {
  // Only act when a group resolved AND it is explicitly not servable. If there
  // was no eligibility at all, the missing-eligibility fail-closed path owns it.
  if (!servingEligibility || servingEligibility.serving_eligible === true) return null;
  // Never override an already-granted override.
  if (servingEligibility.eligibility_override_reason) return null;
  if (!merchantId || !productId || typeof fetchOwnRowEligibility !== 'function') return null;

  let ownRow;
  try {
    ownRow = await fetchOwnRowEligibility({ merchantId, productId });
  } catch (_) {
    return null; // fail-closed
  }
  if (!ownRow || ownRow.serving_eligible !== true) return null;

  const ownContentKey = String(ownRow.content_key || '').trim();
  const driftedContentKey = String(servingEligibility.content_key || '').trim();
  // Only a genuine drift: the own servable row is a different content_key than
  // the resolved (blocked) group. If they match, nothing to reconcile.
  if (!ownContentKey || ownContentKey === driftedContentKey) return null;

  return {
    eligibility: { ...ownRow, eligibility_override_reason: 'identity_reconciled_to_own_row' },
    // Re-anchor the FULL identity back to the originally-requested product: the
    // drift remaps it to a different (merchant) identity, so we must restore
    // merchant_id/product_id (not just content_key) or downstream content would
    // build for the drifted product.
    refPatch: {
      merchant_id: merchantId,
      product_id: productId,
      content_key: ownRow.content_key,
      contentKey: ownRow.content_key,
      ...(ownRow.product_key ? { product_key: ownRow.product_key } : {}),
      ...(ownRow.pivota_signature_id
        ? { pivota_signature_id: ownRow.pivota_signature_id }
        : {}),
    },
    from_content_key: driftedContentKey || null,
    to_content_key: ownContentKey,
  };
}

module.exports = {
  isPdpIdentityReconcileEnabled,
  reconcileToOwnServingRow,
};
