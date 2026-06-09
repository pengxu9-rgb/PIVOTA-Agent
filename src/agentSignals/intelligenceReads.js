'use strict';

// Read-only "intelligence" handlers injected into the canonical executor as `localReads`
// (see safety-kernel/src/protocol/canonicalExecutor.js). They project Pivota's relationship graph and
// cross-merchant offers into the agent-facing Signal envelope. Read-only: no money, no state change, no
// user identity required. App-layer deps (the relationship recall, the offers fetch, the enable flag) are
// INJECTED so the kernel/executor never imports app DB code and these factories stay unit-testable.

const { relationshipEdgesToSignals } = require('./relationshipEdgeToSignal');
const { offersToSignals } = require('./offerToSignal');

const DEFAULT_RELATIONS = Object.freeze(['competitive_alternative', 'niche_specialist', 'related_product']);

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * get_alternatives — project relationship-graph edges → alternative/related Signals.
 * @param {{
 *   listApprovedRelationshipEdgesForAnchor: Function,  // src/auroraBff/productRelationshipGraph
 *   buildAnchorRefsFromProduct?: Function,
 *   isEnabled?: () => boolean,                          // agent-surface flag gate (fail-closed if absent)
 *   defaultMarket?: string,
 * }} deps
 */
function makeGetAlternatives(deps = {}) {
  const {
    listApprovedRelationshipEdgesForAnchor,
    buildAnchorRefsFromProduct,
    isEnabled,
    defaultMarket = 'US',
  } = deps;
  if (typeof listApprovedRelationshipEdgesForAnchor !== 'function') {
    throw new Error('makeGetAlternatives requires listApprovedRelationshipEdgesForAnchor');
  }
  return async function getAlternatives(params = {}) {
    const p = (params && params.payload) || params || {};
    const anchorId = nonEmpty(p.product_ref) ? p.product_ref : nonEmpty(p.product_id) ? p.product_id : null;
    const subject = { kind: 'product', id: anchorId };

    // Fail closed unless the agent surface is explicitly enabled.
    if (typeof isEnabled === 'function' && !isEnabled()) {
      return { subject, signals: [], metadata: { reason: 'disabled' } };
    }

    // Anchor refs: an explicit product_ref, else built from {product_id, merchant_id}.
    let anchorRefs;
    if (nonEmpty(p.product_ref)) {
      anchorRefs = [p.product_ref];
    } else if (typeof buildAnchorRefsFromProduct === 'function') {
      anchorRefs = buildAnchorRefsFromProduct({ product_id: p.product_id, merchant_id: p.merchant_id });
    } else {
      anchorRefs = nonEmpty(p.product_id) ? [p.product_id] : [];
    }
    if (!Array.isArray(anchorRefs) || anchorRefs.length === 0) {
      return { subject, signals: [], metadata: { reason: 'no_anchor' } };
    }

    // Dupe intent-gate: dupes are returned ONLY when explicitly requested (a cheaper similar product is
    // exactly what a value-seeking shopper wants, but never a silent default).
    const includeDupes = p.include_dupes === true || p.relation === 'dupe';
    let relationTypes;
    if (nonEmpty(p.relation)) relationTypes = [p.relation];
    else relationTypes = includeDupes ? DEFAULT_RELATIONS.concat('dupe') : DEFAULT_RELATIONS.slice();

    const market = nonEmpty(p.market) ? p.market : defaultMarket;
    const limit = Number.isInteger(p.limit) ? p.limit : 20;

    const edges = await listApprovedRelationshipEdgesForAnchor({
      anchorType: 'product',
      anchorRefs,
      market,
      relationTypes,
      limit: Math.max(limit * 3, 60), // overfetch so post-filters (grade/price-ratio) still fill `limit`
    });

    const signals = relationshipEdgesToSignals(edges, {
      anchorId,
      maxPriceRatio: typeof p.max_price_ratio === 'number' ? p.max_price_ratio : null,
      includeDupes,
      limit,
    });
    return {
      subject,
      signals,
      metadata: { relation_types: relationTypes, anchor_ref_count: anchorRefs.length, edge_count: Array.isArray(edges) ? edges.length : 0 },
    };
  };
}

/**
 * get_offers — project cross-merchant offers → offer Signals.
 * @param {{ fetchOffers?: (args:object) => Promise<{offers:Array, product_group_id?:string}> }} deps
 *   fetchOffers is the backend offers source (agent_pdp_view.offers). If absent, the tool fails closed
 *   with `offers_source_unavailable` (no fabricated competition) until the backend op is wired.
 */
function makeGetOffers(deps = {}) {
  const { fetchOffers } = deps;
  return async function getOffers(params = {}) {
    const p = (params && params.payload) || params || {};
    const subject = { kind: 'product', id: nonEmpty(p.product_id) ? p.product_id : p.product_group_id || null };
    if (typeof fetchOffers !== 'function') {
      return { subject, best_offer: null, signals: [], metadata: { reason: 'offers_source_unavailable' } };
    }
    const limit = Number.isInteger(p.limit) ? p.limit : 10;
    const res = await fetchOffers({
      merchant_id: p.merchant_id,
      product_id: p.product_id,
      product_group_id: p.product_group_id,
      currency: p.currency,
      limit,
    });
    const offers = res && Array.isArray(res.offers) ? res.offers : [];
    const { best_offer, signals } = offersToSignals(offers, { productId: p.product_id, limit });
    return {
      subject,
      best_offer,
      signals,
      metadata: { offer_count: offers.length, product_group_id: (res && res.product_group_id) || p.product_group_id || null },
    };
  };
}

// Map a backend `offers.resolve` response → makeGetOffers' fetchOffers result shape ({offers, product_group_id}).
// Pure. offers.resolve already returns offers in normalize_offer shape (1:1 with offerToSignal), and is
// cross-merchant by construction (it resolves to a canonical product_group and aggregates offers across ALL
// member merchants). `mapping.canonical_product_group_id` carries the resolved group.
function mapOffersResolveResponse(res, fallbackGroupId = null) {
  const offers = res && Array.isArray(res.offers) ? res.offers : [];
  const groupId =
    (res && res.mapping && res.mapping.canonical_product_group_id) ||
    (res && res.product_group_id) ||
    fallbackGroupId ||
    null;
  return { offers, product_group_id: groupId };
}

module.exports = { makeGetAlternatives, makeGetOffers, mapOffersResolveResponse, DEFAULT_RELATIONS };
