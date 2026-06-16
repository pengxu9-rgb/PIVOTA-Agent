'use strict';

// Read-only "intelligence" handlers injected into the canonical executor as `localReads`
// (see safety-kernel/src/protocol/canonicalExecutor.js). They project Pivota's relationship graph and
// cross-merchant offers into the agent-facing Signal envelope. Read-only: no money, no state change, no
// user identity required. App-layer deps (the relationship recall, the offers fetch, the enable flag) are
// INJECTED so the kernel/executor never imports app DB code and these factories stay unit-testable.

const { relationshipEdgesToSignals } = require('./relationshipEdgeToSignal');
const { offersToSignals } = require('./offerToSignal');
const { intelToSignal } = require('./intelToSignal');

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
    // Optional async (anchorProduct) => hydratedAnchorProduct. Resolves the queried product to its full
    // identity set (sig + grouped source ids) so the graph's sig-keyed AND source-keyed edges both match.
    // Flag-gated + fail-open in the injected impl; absence/throw => today's thin refs (no regression).
    hydrateAnchorProduct,
    // Optional async (edges) => void. Fills candidate_snapshot.title/brand for edges that lack them — the
    // stored candidate_snapshot has NO title in prod (titles are resolved at read-time), so without this
    // get_alternatives returns brand-only, title-less candidates. Fail-open in the injected impl.
    hydrateCandidates,
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
      let anchorProduct = { product_id: p.product_id, merchant_id: p.merchant_id };
      if (typeof hydrateAnchorProduct === 'function') {
        try {
          anchorProduct = (await hydrateAnchorProduct(anchorProduct)) || anchorProduct;
        } catch {
          /* fail-open: keep thin refs so source-keyed (ext_) edges still match */
        }
      }
      anchorRefs = buildAnchorRefsFromProduct(anchorProduct);
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

    // Fill candidate titles when the stored snapshot lacks them (uncollapsed serving path) so agents get a
    // named alternative, not a bare brand. Fail-open: any resolver hiccup keeps the edges as-is.
    if (typeof hydrateCandidates === 'function' && Array.isArray(edges) && edges.length) {
      try {
        await hydrateCandidates(edges);
      } catch {
        /* keep raw edges — never fail the read over a title hydration miss */
      }
    }

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

/**
 * get_intel — project the product-intelligence KB (why / fit / evidence) → a decision Signal.
 * The KB is keyed by `product:<identity>` keys; the agent's product identity may be any of several
 * (sig / canonical product_id / source id), so `resolveKbKeys` is INJECTED to build the candidate keys
 * (and may hydrate identity). Reads are batch-first with a per-key fallback. Fail-closed when disabled.
 * @param {{
 *   getProductIntelKbEntry?: (kbKey:string) => Promise<object|null>,
 *   getProductIntelKbEntries?: (kbKeys:string[]) => Promise<Map<string,object>>,
 *   resolveKbKeys?: (params:object) => Promise<string[]>,   // params → candidate kb keys
 *   isEnabled?: () => boolean,                              // agent-surface flag gate (fail-closed if absent)
 *   isReviewed?: (bundle:object) => boolean,                // require-reviewed quality gate (fail-closed)
 *   filterPublicSafeClaims?: (claims:object[]) => object[], // FTC public-safe claim filter (absent → no claims)
 * }} deps
 */
function makeGetIntel(deps = {}) {
  const { getProductIntelKbEntry, getProductIntelKbEntries, resolveKbKeys, isEnabled, isReviewed, filterPublicSafeClaims } =
    deps;
  if (typeof getProductIntelKbEntry !== 'function' && typeof getProductIntelKbEntries !== 'function') {
    throw new Error('makeGetIntel requires getProductIntelKbEntry or getProductIntelKbEntries');
  }
  return async function getIntel(params = {}) {
    const p = (params && params.payload) || params || {};
    const productId = nonEmpty(p.product_id) ? p.product_id : nonEmpty(p.product_ref) ? p.product_ref : null;
    const subject = { kind: 'product', id: productId };

    // Fail closed unless the agent surface is explicitly enabled.
    if (typeof isEnabled === 'function' && !isEnabled()) {
      return { subject, signals: [], metadata: { reason: 'disabled' } };
    }

    let kbKeys = [];
    if (typeof resolveKbKeys === 'function') {
      try {
        kbKeys = (await resolveKbKeys(p)) || [];
      } catch {
        kbKeys = [];
      }
    }
    if ((!Array.isArray(kbKeys) || kbKeys.length === 0) && nonEmpty(productId)) {
      kbKeys = [`product:${productId}`];
    }
    kbKeys = (Array.isArray(kbKeys) ? kbKeys : []).filter((k) => nonEmpty(k));
    if (kbKeys.length === 0) {
      return { subject, signals: [], metadata: { reason: 'no_kb_keys' } };
    }

    let entry = null;
    if (typeof getProductIntelKbEntries === 'function' && kbKeys.length > 1) {
      try {
        const map = await getProductIntelKbEntries(kbKeys);
        if (map && typeof map.get === 'function') {
          for (const k of kbKeys) {
            if (map.get(k)) {
              entry = map.get(k);
              break;
            }
          }
        }
      } catch {
        entry = null;
      }
    }
    if (!entry && typeof getProductIntelKbEntry === 'function') {
      for (const k of kbKeys) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const e = await getProductIntelKbEntry(k);
          if (e) {
            entry = e;
            break;
          }
        } catch {
          /* try next key */
        }
      }
    }
    if (!entry) {
      return { subject, signals: [], metadata: { reason: 'not_found', kb_key_count: kbKeys.length } };
    }

    const signal = intelToSignal(entry, { productId, isReviewed, filterPublicSafeClaims });
    return {
      subject,
      signals: signal ? [signal] : [],
      metadata: {
        kb_key: entry.kb_key || null,
        source: entry.source || null,
        ...(signal ? {} : { reason: 'no_reviewed_signal' }),
      },
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

module.exports = { makeGetAlternatives, makeGetOffers, makeGetIntel, mapOffersResolveResponse, DEFAULT_RELATIONS };
