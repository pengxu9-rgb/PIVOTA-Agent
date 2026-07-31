'use strict';

/**
 * Single source of truth for "does THIS catalog_products row carry a real price?".
 *
 * NODE TWIN of pivota-backend `services/priced_offer_sql.py`. The two emit a
 * BYTE-IDENTICAL SQL string and the test suites on both sides pin it — same
 * arrangement as `pdpRenderability.seedRouteResolvesSql`, and for the same
 * reason: this repo and pivota-backend both write `catalog_row_trust` against
 * one Postgres, so a predicate edit in one repo only is a split-brain with no
 * flag to blame. Rows would FLAP public<->blocked on the live serving surface.
 *
 * Consumers that must agree:
 *   * src/services/catalogRowTrustUpserter.js — the per-row input behind the
 *     OFFER_PRICE_MISSING gate in catalogTrustPolicy.js (steady state);
 *   * scripts/backfill-catalog-row-trust.cjs — the same input in the backfill
 *     driver, which carries its OWN copy of the join;
 *   * pivota-backend services/index_pipeline_state_service (`has_price`) and
 *     services/catalog_invariant_checks (`public_without_priced_offer`), the
 *     check that fails the build when the rest of us get it wrong.
 *
 * WHAT COUNTS AS PRICED (and why):
 *
 *   * `suppressed_at IS NULL` — a suppressed offer is withdrawn supply. It must
 *     not keep a row public, which is exactly what the un-suppressed half of
 *     the 2026-07-30 currency remediation left behind.
 *   * `coalesce(merchant_effective_price, list_price) > 0` — the same coalesce
 *     order the served surface prints. `estimated_best_price` is DELIBERATELY
 *     EXCLUDED: it is a derived estimate, not a merchant-quoted price, and a
 *     PDP must not be published on the strength of our own guess.
 *
 *     Measured on prod 2026-07-31: 0 unsuppressed offers are priced by
 *     `merchant_effective_price` while `list_price` is null-or-zero, so the
 *     coalesce is a no-op on today's corpus and changes no row's verdict. It is
 *     here so the predicate stays right the day a writer populates only the
 *     effective price — a rewrite of the price columns is precisely how this
 *     class of defect arrives (the 2026-07-30 drain).
 *
 *     `> 0` rather than `IS NOT NULL`: a 0.00 price is not buyable either, and
 *     the invariant this backs has always asked `> 0`.
 *
 * The 2026-07-30 remediation NULLed prices on placeholder/discontinued offers
 * WITHOUT suppressing the offer rows, so an unsuppressed offer carrying no
 * price at all is a real and recurring state — 432 such rows on prod
 * 2026-07-31. It is not an anomaly to code around; it is the honest
 * representation of "we do not know this price", and every gate here must read
 * it as "not buyable".
 */

/** The buyable-price expression for one `catalog_offers` row. */
function pricedOfferPriceExpr(alias = 'co') {
  return `coalesce(${alias}.merchant_effective_price, ${alias}.list_price)`;
}

/**
 * `EXISTS` over `catalog_offers` for one product_key's real price.
 *
 * `productKeyExpr` is SQL, not a value — pass the correlated column
 * (`cp.product_key`), never a bind placeholder.
 *
 * `extraPredicate` is appended as an extra `AND` conjunct for callers that
 * narrow further. It must be a literal SQL fragment; it is never a place to
 * interpolate user input.
 *
 * Emits `EXISTS` and not `(SELECT TRUE ... LIMIT 1)` on purpose: EXISTS is
 * TRUE/FALSE and never NULL, so an ABSENT key in a consumer's row object
 * unambiguously means "this query did not compute it" rather than "no priced
 * offer". The trust policy's tri-state gate depends on that distinction.
 */
function pricedOfferExistsSql(productKeyExpr, { alias = 'co', extraPredicate = '' } = {}) {
  const extra = extraPredicate ? `\n          AND ${extraPredicate}` : '';
  return (
    'EXISTS (\n' +
    '        SELECT 1\n' +
    `        FROM catalog_offers ${alias}\n` +
    `        WHERE ${alias}.product_key = ${productKeyExpr}\n` +
    `          AND ${alias}.suppressed_at IS NULL\n` +
    `          AND ${pricedOfferPriceExpr(alias)} > 0` +
    `${extra}\n` +
    '    )'
  );
}

module.exports = {
  pricedOfferPriceExpr,
  pricedOfferExistsSql,
};
