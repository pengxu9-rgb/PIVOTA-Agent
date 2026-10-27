// WHAT THE AGENT get_product LIVE READ DID FOR THE PRICE IT SERVES, for the doors whose answer shape drops the
// native `live_read` / `price_as_of` / `price_source` (the UCP shaper, the public projection). Under
// UCP_LIVE_PRODUCT_READ=enforce every product carries `live_read` (src/services/ucpLiveOfferRead), and a
// verified price and a stored fallback would otherwise reach those doors in the identical shape.
//
// null when the product carries no `live_read` object: the read is off or in shadow (shadow never touches the
// answer), so those answers stay exactly what they were.
//
// The headline price is the merchant's only when the read re-priced it: `live_read.status: verified` AND the
// reader's own `price_as_of` stamp equal to its `checked_at` (it stamps exactly then). A verified read that
// answered other variants, or a stale `price_source: merchant_live` handed over by an earlier read, is stored.
//
// `reason` is a fixed token or absent: a failed read's free-text error never reaches a buyer.

const REASONS = new Set([
  "no_market", "market_not_priced", "no_host", "no_variant_id", "too_many_variants_to_reprice", "incomplete_reprice",
  "host_busy", "merchant_error", "nothing_answered", "reader_error", "currency_mismatch", "variant_gone",
  "not_ucp", "timeout", "error", "headline_not_read",
]);
const ISO2 = /^[A-Z]{2}$/;

function isObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * The headline verdict, and, when the headline was read, how many variants the read confirmed (`read_variants`)
 * and how many it did not (`stored_variants`): the merchant was silent on them, said they are gone, or the read
 * never asked (a product has more variants than one read covers, MAX_PRODUCT_VARIANT_IDS). EVERY variant counts,
 * priced or not: the UCP shaper publishes an unpriced or 0-priced variant at the PRODUCT price, which is the
 * live headline, and a price the merchant never gave for that variant must not sit under "read from the
 * merchant". A door that shows the variants must not call them read while any of them is not.
 * @param {object} product the native get_product product
 * @returns {null | { live: boolean, market: string|null, as_of?: string, read_variants?: number, stored_variants?: number, reason?: string }}
 */
export function productPriceCheck(product) {
  const lr = isObj(product) && isObj(product.live_read) ? product.live_read : null;
  if (!lr) return null;
  const market = typeof lr.market === "string" && ISO2.test(lr.market) ? lr.market : null;
  const checkedAt = typeof lr.checked_at === "string" ? lr.checked_at : null;
  if (lr.status === "verified" && checkedAt && product.price_as_of === checkedAt) {
    const variants = (Array.isArray(product.variants) ? product.variants : []).filter(isObj);
    const read = variants.filter((v) => isObj(v.live_read) && v.live_read.status === "verified").length;
    return { live: true, market, as_of: checkedAt, read_variants: read, stored_variants: variants.length - read };
  }
  // Why it is stored: the reader's reason when it is one of ours, else the read's status.
  const reason = lr.status === "verified" ? "headline_not_read"
    : typeof lr.reason === "string" && REASONS.has(lr.reason) ? lr.reason
      : typeof lr.status === "string" && REASONS.has(lr.status) ? lr.status : undefined;
  return { live: false, market, ...(reason ? { reason } : {}) };
}
