'use strict';

// Read-only "intelligence" handlers injected into the canonical executor as `localReads`
// (see safety-kernel/src/protocol/canonicalExecutor.js). They project Pivota's relationship graph and
// cross-merchant offers into the agent-facing Signal envelope. Read-only: no money, no state change, no
// user identity required. App-layer deps (the relationship recall, the offers fetch, the enable flag) are
// INJECTED so the kernel/executor never imports app DB code and these factories stay unit-testable.

const { relationshipEdgesToSignals } = require('./relationshipEdgeToSignal');
const { offersToSignals } = require('./offerToSignal');
const { intelToSignal } = require('./intelToSignal');
const { normalizeBuyerRegion, currencyForBuyerRegion } = require('../auroraBff/buyerRegion');
const { numericVariantId } = require('../services/ucpLiveOfferRead');

const DEFAULT_RELATIONS = Object.freeze(['competitive_alternative', 'niche_specialist', 'related_product']);

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// --- candidate snapshot hydration (the pure half of the injected hydrateCandidates) -----------------------
// The stored candidate_snapshot is a raw product spread frozen at edge-build time; two gaps are repaired at
// read time from the canonical catalog row the ref resolves to:
//   - title (the uncollapsed serving path stores none — titles are resolved at read time);
//   - the currency of an already-stored price amount (the snapshot writer never normalized a currency key,
//     and an amount must never reach an agent without its currency).
// A sig- or group-keyed ref can resolve to a DIFFERENT member listing than the one the amount was crawled
// from (the resolver collapses to the group's primary member), and members of one group can list in
// different currencies — so the currency is paired ONLY when the canonical row's own price amount equals
// the stored amount. No match → no fill: the projection then withholds the price, which is the honest
// outcome; a confidently wrong currency is the exact fabrication this repairs.
// The resolver I/O lives in the caller (server wiring); these stay pure and unit-testable.

// The currency keys relationshipEdgeToSignal reads — the predicate and the merge must mirror that full
// set, or a resolver currency can override a producer's own (e.g. a priceCurrency:'JPY' snapshot).
function snapshotHasOwnCurrency(snap) {
  return Boolean(snap.currency || snap.price_currency || snap.priceCurrency);
}

function candidateSnapshotNeedsHydration(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const needsTitle = !snap.title;
  const needsCurrency = snap.price != null && snap.price !== '' && !snapshotHasOwnCurrency(snap);
  return needsTitle || needsCurrency;
}

// Merge a resolved canonical entity into a stored candidate_snapshot, filling ONLY what the snapshot lacks.
// Returns the hydrated snapshot, or null when there is nothing to fill (caller keeps the edge as-is).
function hydrateCandidateSnapshotFromEntity(snapshot, entity) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const ent = entity && typeof entity === 'object' ? entity : null;
  if (!ent) return null;
  const title = !snap.title ? ent.title || ent.name || null : null;
  const displaySnap = ent.display_snapshot && typeof ent.display_snapshot === 'object' ? ent.display_snapshot : null;
  let currency = null;
  if (snap.price != null && snap.price !== '' && !snapshotHasOwnCurrency(snap) && displaySnap) {
    const storedAmt = Number(snap.price);
    const canonicalAmt = Number(displaySnap.price);
    // Same-listing guard (see header): only an amount match licenses the pairing.
    if (Number.isFinite(storedAmt) && Number.isFinite(canonicalAmt) && storedAmt === canonicalAmt) {
      currency = displaySnap.currency || null;
    }
  }
  if (!title && !currency) return null;
  return {
    ...snap,
    ...(title ? { title, brand: snap.brand || ent.brand || null } : {}),
    ...(currency ? { currency } : {}),
  };
}

// --- currency of a stored amount, from the listing's own offers ---------------------------------------------
// The builder stored bare amounts: prod 2026-09-27, all 4,964 serving edges with a candidate price had no
// currency key, and no edge's price_evidence had one. The catalog-row repair above cannot help seed rows —
// their product_payload carries no price; price and currency live on catalog_offers. So a stored amount is
// paired with the currency of the offers the SAME ref resolves to, and only when every offer whose price
// equals that amount agrees on ONE currency. No match, or two currencies, → no currency, and the projection
// withholds the amount. Never the market's currency: a SGD seed filed under the US partition is exactly the
// row a market default would mislabel.
function amountCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

function pairCurrencyFromOfferPrices(amount, offerPrices) {
  const cents = amountCents(amount);
  if (cents == null || !Array.isArray(offerPrices)) return null;
  const currencies = new Set();
  for (const offer of offerPrices) {
    if (!offer || typeof offer !== 'object') continue;
    const code = typeof offer.currency === 'string' ? offer.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const amounts = Array.isArray(offer.amounts) ? offer.amounts : [];
    if (amounts.some((a) => amountCents(a) === cents)) currencies.add(code);
  }
  return currencies.size === 1 ? [...currencies][0] : null;
}

function storedAmountWithoutCurrency(snapshot, amount) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return amountCents(amount) != null && !snapshotHasOwnCurrency(snap);
}

// Fill `currency` on candidate_snapshot / anchor_snapshot where each holds (or, for the anchor, the
// comparison holds) an amount without one. Mutates the edges it was given, like hydrateCandidates.
// Returns { needed, filled } for metadata.
async function fillStoredAmountCurrencies(edges, resolveOfferPrices) {
  const needs = [];
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || typeof e !== 'object') continue;
    const cand = e.candidate_snapshot;
    if (e.candidate_product_ref && storedAmountWithoutCurrency(cand, cand && cand.price)) {
      needs.push({ edge: e, key: 'candidate_snapshot', ref: e.candidate_product_ref, amount: cand.price });
    }
    // The comparison's anchor amount is the one an agent sees; the anchor snapshot is where the mapper
    // reads its currency.
    const anchorAmount = e.price_evidence && typeof e.price_evidence === 'object' ? e.price_evidence.anchor_price_amount : null;
    if (e.anchor_ref && storedAmountWithoutCurrency(e.anchor_snapshot, anchorAmount)) {
      needs.push({ edge: e, key: 'anchor_snapshot', ref: e.anchor_ref, amount: anchorAmount });
    }
  }
  if (!needs.length) return { needed: 0, filled: 0 };
  const refs = [...new Set(needs.map((n) => String(n.ref).trim().toLowerCase()))];
  const byRef = await resolveOfferPrices(refs);
  if (!byRef || typeof byRef.get !== 'function') return { needed: needs.length, filled: 0 };
  let filled = 0;
  for (const n of needs) {
    const currency = pairCurrencyFromOfferPrices(n.amount, byRef.get(String(n.ref).trim().toLowerCase()));
    if (!currency) continue;
    const snap = n.edge[n.key] && typeof n.edge[n.key] === 'object' ? n.edge[n.key] : {};
    n.edge[n.key] = { ...snap, currency };
    filled += 1;
  }
  return { needed: needs.length, filled };
}

// --- product_ref → anchor identity -------------------------------------------------------------------------
// The graph stores anchors as `product:<id>` (sig_…, ext_…, pg_…, a source id), `url:<url>` or
// `text:<brand>:<name>`. An agent holds the forms search_catalog / get_product hand out: a bare
// `pivota_signature_id` (sig_…), a `product_id`, a `pivota_canonical_url`
// (https://agent.pivota.cc/products/<id>) — or a `product:sig_…` ref from a previous get_alternatives. Only
// the three graph namespaces are read as prefixes: `retailer:…` / `ulta:…` are ids whose colon is part of
// the id. Anything naming a product id takes the SAME path as `product_id` (identity hydration + every ref
// form), so the two arguments can never disagree about which edges a product has.
const PIVOTA_PRODUCT_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*pivota\.cc\/products\/([^/?#]+)/i;

function parseProductRefArg(value) {
  const ref = nonEmpty(value) ? value.trim() : '';
  if (!ref) return { productId: null, refs: [] };
  if (/^https?:\/\//i.test(ref)) {
    const m = PIVOTA_PRODUCT_URL.exec(ref);
    if (!m) return { productId: null, refs: [`url:${ref}`] };
    let id = m[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep the raw segment */
    }
    return { productId: id, refs: [] };
  }
  const ns = /^(product|url|text):(.+)$/i.exec(ref);
  if (ns && ns[1].toLowerCase() === 'product') return { productId: ns[2].trim(), refs: [ref] };
  if (ns) return { productId: null, refs: [ref] };
  return { productId: ref, refs: [] };
}

function uniqueRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    if (!nonEmpty(r)) continue;
    const k = r.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.trim());
  }
  return out;
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
    // Optional async (lowercased refs[]) => Map<ref, Array<{currency, amounts[]}>>: the offers each ref
    // resolves to. Pairs a stored bare amount with its listing's currency (fillStoredAmountCurrencies).
    // Fail-open: absence/throw leaves the amounts currency-less, and the projection then withholds them.
    resolveOfferPrices,
    // Optional (market) => currency|null: the one currency a price may be served in for that market.
    // Absent = no market check; null = the market cannot be priced, so no price is served.
    servingCurrencyForMarket,
  } = deps;
  if (typeof listApprovedRelationshipEdgesForAnchor !== 'function') {
    throw new Error('makeGetAlternatives requires listApprovedRelationshipEdgesForAnchor');
  }

  async function anchorRefsForProductId(productId, merchantId) {
    if (typeof buildAnchorRefsFromProduct !== 'function') return [productId];
    let anchorProduct = { product_id: productId, merchant_id: merchantId };
    if (typeof hydrateAnchorProduct === 'function') {
      try {
        anchorProduct = (await hydrateAnchorProduct(anchorProduct)) || anchorProduct;
      } catch {
        /* fail-open: keep thin refs so source-keyed (ext_) edges still match */
      }
    }
    const refs = buildAnchorRefsFromProduct(anchorProduct);
    return Array.isArray(refs) ? refs : [];
  }

  return async function getAlternatives(params = {}) {
    const p = (params && params.payload) || params || {};
    const anchorId = nonEmpty(p.product_ref) ? p.product_ref : nonEmpty(p.product_id) ? p.product_id : null;
    const subject = { kind: 'product', id: anchorId };

    // Fail closed unless the agent surface is explicitly enabled.
    if (typeof isEnabled === 'function' && !isEnabled()) {
      return { subject, signals: [], metadata: { reason: 'disabled' } };
    }

    // Anchor refs: every graph-namespaced ref product_ref names verbatim, plus the full ref set of each
    // product id named (product_id, and the id inside product_ref) — see parseProductRefArg.
    const fromRef = parseProductRefArg(p.product_ref);
    const productIds = uniqueRefs([nonEmpty(p.product_id) ? p.product_id : null, fromRef.productId]);
    let anchorRefs = fromRef.refs.slice();
    for (const productId of productIds) {
      anchorRefs = anchorRefs.concat(await anchorRefsForProductId(productId, p.merchant_id));
    }
    anchorRefs = uniqueRefs(anchorRefs);
    if (anchorRefs.length === 0) {
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

    // Pair each stored bare amount with its listing's offer currency. Fail-open: a miss leaves the amount
    // currency-less and the projection withholds it.
    let currencyFill = null;
    if (typeof resolveOfferPrices === 'function' && Array.isArray(edges) && edges.length) {
      try {
        currencyFill = await fillStoredAmountCurrencies(edges, resolveOfferPrices);
      } catch {
        currencyFill = { error: true };
      }
    }

    const servingCurrency =
      typeof servingCurrencyForMarket === 'function' ? servingCurrencyForMarket(market) || null : undefined;
    const signals = relationshipEdgesToSignals(edges, {
      anchorId,
      maxPriceRatio: typeof p.max_price_ratio === 'number' ? p.max_price_ratio : null,
      includeDupes,
      limit,
      servingCurrency,
    });
    return {
      subject,
      signals,
      metadata: {
        relation_types: relationTypes,
        anchor_ref_count: anchorRefs.length,
        edge_count: Array.isArray(edges) ? edges.length : 0,
        ...(servingCurrency !== undefined ? { serving_currency: servingCurrency } : {}),
        ...(currencyFill ? { price_currency_fill: currencyFill } : {}),
      },
    };
  };
}

/**
 * get_offers — project cross-merchant offers → offer Signals.
 * @param {{ fetchOffers?: (args:object) => Promise<{offers:Array, product_group_id?:string}> }} deps
 *   fetchOffers is the backend offers source (agent_pdp_view.offers). If absent, the tool fails closed
 *   with `offers_source_unavailable` (no fabricated competition) until the backend op is wired.
 */
/**
 * THE MARKET A get_offers CALLER DECLARED, whether or not anything is priced for it: the ISO-2 code,
 * or null when the caller declared none or sent something that is not a market at all ('USA', 'en-US',
 * a list). Invalid input is absent input (buyerRegion.js); a well-formed code is a declaration.
 */
function getOffersDeclaredMarket(p) {
  const raw = p && typeof p === 'object' ? (p.market !== undefined ? p.market : p.buyer_market) : null;
  return normalizeBuyerRegion(raw) || null;
}

/**
 * THE BUYER MARKET A get_offers CALLER STATED, or null. ISO-2 and priceable only (the repo's one
 * normaliser, ADR-024): a locale, a list, a three-letter code or a well-formed code nothing is priced
 * for is never forwarded (makeGetOffers answers the last with no offers). Never defaulted: get_offers resolves offers through the backend's
 * `offers.resolve`, whose cart-minting gate (pivota-backend #2411) keys on `payload.market`, and a
 * caller that states none gets the referral-only answer it always got.
 */
function getOffersBuyerMarket(p) {
  const region = getOffersDeclaredMarket(p);
  return region && currencyForBuyerRegion(region) ? region : null;
}

/**
 * THE OFFERS A DECLARED BUYER MARKET MAY BE SHOWN (ADR-026): only those priced in that market's
 * currency. The backend's offers.resolve does not filter on `payload.market` — it keys only its
 * cart-minting gate on it — so before this a market=US caller was handed a GBP seed's offer, and a KRW
 * one, each as `buyer_safe`. The offer's OWN currency is compared against the market's; a market is
 * never inferred from the currency. An offer with no currency cannot be shown to be in the market's
 * currency, and is withheld with the others.
 *
 * `marketCurrency` comes from `currencyForBuyerRegion`, the gateway's one market -> currency map
 * (ADR-024; equal to the registry's pricing-region currencies, and the function the generated
 * registry projection replaces under ADR-026 P1).
 */
function offersInMarketCurrency(offers, marketCurrency) {
  const kept = [];
  let withheld = 0;
  for (const offer of offers) {
    const currency = offer && typeof offer.currency === 'string' ? offer.currency.trim().toUpperCase() : '';
    if (currency && currency === marketCurrency) kept.push(offer);
    else withheld += 1;
  }
  return { kept, withheld };
}

/**
 * Does this offer sell exactly variant `vid`? What the offer would BUY decides: the variant its cart is built
 * for (execution_spec.variant_id, else the cart permalink's own /cart/<id>:<qty>). With no cart, the
 * backend's `source.variant_match: 'exact'` statement, or every internal checkout item naming it.
 * `source.variant_id` alone never counts: the seed lane's fallback offer for an unmatched sku_id copies the
 * requested id there while selling no particular variant.
 */
// A cart that names no single variant we can read (several lines, a token cart, an add-to-cart form) is
// still a cart: it decides, and it is not the named variant.
const UNREADABLE_CART = '\u0000unreadable-cart';

function offerCartVariant(offer) {
  const spec = (offer && offer.execution_spec) || {};
  const named = spec.variant_id != null ? String(spec.variant_id).trim() : '';
  const raw = String(spec.cart_url || '').trim();
  if (named) {
    // BOTH SAY WHICH VARIANT: they must agree, or the offer names no readable cart (a cart on B beside
    // `variant_id: A` would otherwise match a request for A; controller review of #2453).
    if (!raw) return named;
    const inCart = cartUrlVariant(raw);
    return inCart !== UNREADABLE_CART && sameVariant(inCart, named) ? named : UNREADABLE_CART;
  }
  if (!raw) return '';
  return cartUrlVariant(raw);
}

/** The variant a one-line cart permalink (`/cart/<id>:<qty>`) carries, or UNREADABLE_CART. */
function cartUrlVariant(raw) {
  let path = '';
  try {
    path = new URL(raw).pathname;
  } catch {
    return UNREADABLE_CART;
  }
  const m = path.match(/^\/cart\/(\d{1,20}):\d+\/?$/); // exactly ONE line: /cart/<id>:<qty>
  return m ? m[1] : UNREADABLE_CART;
}

/**
 * One variant, however it is spelled: the same string, or the same Shopify variant number through a gid, bare
 * digits or a URL-shaped id (`/products/x?variant=N#offer`, the JSON-LD offer @id stored entries carry; the
 * backend's `source.variant_id` is often that form while an agent names the bare number).
 */
function sameVariant(a, b) {
  const x = String(a == null ? '' : a).trim();
  const y = String(b == null ? '' : b).trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const nx = numericVariantId(x);
  return Boolean(nx) && nx === numericVariantId(y);
}

function offerIsVariant(offer, vid) {
  if (!offer || typeof offer !== 'object') return false;
  const cart = offerCartVariant(offer);
  // WHEN THERE IS A CART, THE CART DECIDES: it is what the buyer would buy. An attached seed can build its
  // cart from the operator's attached variant whatever shade was asked for, while the backend still calls
  // the offer an `exact` match -- so a different cart is never this variant (review round 4 of #2438).
  if (cart) return cart !== UNREADABLE_CART && sameVariant(cart, vid);
  // No cart (sold out, a non-Shopify store, a referral-only downgrade): the backend's own statement that
  // the offer IS the named variant, `source.variant_match: 'exact'` (pivota-backend #2622). Its fallback
  // offer for an unmatched sku_id says 'fallback' and is withheld (review round 3 of #2438).
  if (offer.source && offer.source.variant_match === 'exact' && sameVariant(offer.source.variant_id, vid)) return true;
  const items = Array.isArray(offer.internal_checkout_items) ? offer.internal_checkout_items : [];
  return items.length > 0 && items.every((it) => it && sameVariant(it.variant_id, vid));
}

function makeGetOffers(deps = {}) {
  // `readOffersLive` (optional): the merchant's own live read of the offers this answer returns, for a
  // DECLARED market (services/ucpLiveOfferRead). Absent, or answering nothing, the answer is unchanged.
  // `variantIdEnabled`: honour `variant_id` (GET_OFFERS_VARIANT_ID; needs pivota-backend #2622 live). Off,
  // the argument is ignored entirely: not forwarded, not filtered on.
  const { fetchOffers, readOffersLive, variantIdEnabled = false } = deps;
  // `liveVerificationOptIn` (optional, () => boolean): ask offers.resolve for FRESHNESS-GATED seed offers,
  // flagged `requires_live_verification` (pivota-backend #2629) -- true only while the live read
  // ENFORCES, because only a live `verified` read may serve one. Absent or false: today's fetch.
  const liveVerificationOptIn = typeof deps.liveVerificationOptIn === 'function' ? deps.liveVerificationOptIn : () => false;
  return async function getOffers(params = {}) {
    const p = (params && params.payload) || params || {};
    const subject = { kind: 'product', id: nonEmpty(p.product_id) ? p.product_id : p.product_group_id || null };
    if (typeof fetchOffers !== 'function') {
      return { subject, best_offer: null, signals: [], metadata: { reason: 'offers_source_unavailable' } };
    }
    const limit = Number.isInteger(p.limit) ? p.limit : 10;
    const declared = getOffersDeclaredMarket(p);
    const marketCurrency = declared ? currencyForBuyerRegion(declared) : '';
    // A declared market nothing is priced in has no offer it may be shown (the door serves it nothing,
    // as search does: buyerMarket.resolveServingCurrency). Answered here, without a backend call.
    if (declared && !marketCurrency) {
      return {
        subject,
        best_offer: null,
        signals: [],
        metadata: {
          offer_count: 0,
          product_group_id: p.product_group_id || null,
          market: declared,
          market_currency: null,
          reason: 'market_not_priced',
        },
      };
    }
    const market = getOffersBuyerMarket(p);
    const res = await fetchOffers({
      merchant_id: p.merchant_id,
      product_id: p.product_id,
      // A listing's option named for its own cart (one offer per listing lists them in `variants`).
      ...(variantIdEnabled && nonEmpty(p.variant_id) ? { variant_id: String(p.variant_id).trim() } : {}),
      product_group_id: p.product_group_id,
      currency: p.currency,
      // The caller's limit, market or not. The filter runs after the backend's cut, so a declared market
      // can get fewer in-currency offers than exist; over-fetching would fix that here but the backend
      // records every link offers.resolve returns as issued to the agent (ADR-025), withheld ones too.
      // Filtering before the cut belongs inside offers.resolve.
      limit,
      // Only when the caller stated one: the fetch's argument shape is byte-identical otherwise.
      ...(market ? { market } : {}),
      // Only when a live read will run and enforce (a declared market and the reader in enforce).
      ...(market && liveVerificationOptIn() ? { include_live_verification: true } : {}),
    });
    const fetchedAll = res && Array.isArray(res.offers) ? res.offers : [];
    // A NAMED VARIANT gets only offers that ARE that variant. offers.resolve does not guarantee it: a seed
    // with no matching variant falls back to a variant-less offer at the row price, and the internal lane
    // picks its own first eligible variant -- either would hand the agent another shade's cart (review of
    // #2438). Matched on the offer's own variant (execution_spec / source) or its checkout items.
    const namedVariant = variantIdEnabled && nonEmpty(p.variant_id) ? String(p.variant_id).trim() : '';
    const fetched = namedVariant ? fetchedAll.filter((o) => offerIsVariant(o, namedVariant)) : fetchedAll;
    const withheldOtherVariant = fetchedAll.length - fetched.length;
    // No market declared: today's referral-only answer, every offer the backend returned.
    const { kept, withheld } = market
      ? offersInMarketCurrency(fetched, marketCurrency)
      : { kept: fetched, withheld: 0 };
    // A declared market's offers are cut to the caller's limit BEFORE projecting: offersToSignals picks
    // best_offer from every offer it is handed and only then caps signals, so an uncut list can name a
    // best_offer that is not among the signals returned. offer_count is then the count returned. (No
    // market: the list is passed as it always was.)
    const cut = market ? kept.slice(0, Math.max(1, Math.min(limit, 10))) : kept;
    // THE MERCHANT'S OWN ANSWER, at decision time. After the cut (only what this answer returns is read)
    // and before projection (so best_offer ranks on what the merchant said). Fail-open: a reader that
    // throws costs the live read, never the answer.
    let offers = cut;
    let liveRead = null;
    if (market && typeof readOffersLive === 'function' && cut.length) {
      try {
        const res = await readOffersLive(cut, { market, currency: marketCurrency });
        if (res && Array.isArray(res.offers) && res.offers.length === cut.length) offers = res.offers;
        liveRead = (res && res.stats) || null;
      } catch {
        liveRead = { error: 'live_read_failed' };
      }
    }
    // A FLAGGED offer (its stored facts are stale; pivota-backend #2629) is served only when the merchant's
    // live read just verified it; otherwise it is withheld exactly as offers.resolve used to drop it.
    const beforeUnverified = offers.length;
    offers = offers.filter((o) => !(o && o.requires_live_verification) || (o.live_read && o.live_read.status === 'verified'));
    const withheldUnverified = beforeUnverified - offers.length;
    const { best_offer, signals } = offersToSignals(offers, { productId: p.product_id, limit });
    // ONE reason for an empty answer, in filter order: the variant filter runs first, so when it left
    // nothing the currency filter had nothing to judge.
    let emptyReason = null;
    if (offers.length === 0) {
      if (namedVariant && fetched.length === 0 && withheldOtherVariant > 0) emptyReason = 'variant_not_offered';
      // The LAST filter that emptied the answer names it: the live-verification one runs after currency.
      else if (withheldUnverified > 0) emptyReason = 'offer_needs_live_verification';
      else if (market && withheld > 0) emptyReason = 'no_offer_in_market_currency';
    }
    return {
      subject,
      best_offer,
      signals,
      metadata: {
        offer_count: offers.length,
        product_group_id: (res && res.product_group_id) || p.product_group_id || null,
        ...(namedVariant
          ? {
              variant_id: namedVariant,
              withheld_other_variant_count: withheldOtherVariant,
            }
          : {}),
        ...(market
          ? {
              market,
              market_currency: marketCurrency,
              withheld_other_currency_count: withheld,
              ...(withheldUnverified > 0 ? { withheld_unverified_count: withheldUnverified } : {}),
              ...(liveRead ? { live_read: liveRead } : {}),
            }
          : {}),
        ...(emptyReason ? { reason: emptyReason } : {}),
      },
    };
  };
}

// --- get_intel KB keys ------------------------------------------------------------------------------------
// The KB is keyed `product:<id>` (sig_…, ext_…, a source id such as ulta:…) and `url:<url>` (exact,
// case-sensitive). The request names the product by product_id, product_ref or pivota_signature_id, in any
// of the forms parseProductRefArg reads. Every one of them used to be wrapped as `product:<raw value>`, so a
// `product:sig_…` ref asked for `product:product:sig_…` and a Pivota product URL for `product:https://…` —
// both measured live 2026-09-27 as reason:not_found, kb_key_count:1, for a sig whose intel product_id finds.
function intelIdentityProductId(params = {}) {
  const p = params || {};
  for (const v of [p.product_id, p.product_ref, p.pivota_signature_id]) {
    const id = parseProductRefArg(v).productId;
    if (id) return id;
  }
  return null;
}

// Candidate KB keys, most specific first: the hydrated identity (when the resolver found one), then the
// request's own ids. A `url:` ref (or a merchant URL) is looked up as the KB's own `url:` key; a `text:`
// ref names no KB key.
function buildIntelKbKeys(params = {}, identity = null) {
  const p = params || {};
  const keys = [];
  const add = (key) => {
    if (!keys.includes(key)) keys.push(key);
  };
  const product = (v) => {
    const s = v == null ? '' : String(v).trim();
    if (s) add(`product:${s}`);
  };
  const url = (v) => {
    const s = v == null ? '' : String(v).trim();
    if (s) add(`url:${s}`);
  };
  if (identity && typeof identity === 'object') {
    product(identity.canonical_entity_id);
    product(identity.pivota_signature_id);
    for (const sig of Array.isArray(identity.member_sig_ids) ? identity.member_sig_ids : []) product(sig);
    for (const src of Array.isArray(identity.member_source_ids) ? identity.member_source_ids : []) product(src);
    url(identity.canonical_url);
  }
  // Always include the request-provided identities (covers the flag-off / unresolved path).
  for (const v of [p.pivota_signature_id, p.product_id, p.product_ref]) {
    const parsed = parseProductRefArg(v);
    product(parsed.productId);
    for (const ref of parsed.refs) {
      const m = /^url:(.+)$/i.exec(ref);
      if (m) url(m[1]);
    }
  }
  return keys;
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
    if (!Array.isArray(kbKeys) || kbKeys.length === 0) {
      kbKeys = buildIntelKbKeys(p, null);
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

module.exports = {
  getOffersBuyerMarket,
  makeGetAlternatives,
  makeGetOffers,
  makeGetIntel,
  mapOffersResolveResponse,
  DEFAULT_RELATIONS,
  candidateSnapshotNeedsHydration,
  hydrateCandidateSnapshotFromEntity,
  pairCurrencyFromOfferPrices,
  fillStoredAmountCurrencies,
  parseProductRefArg,
  buildIntelKbKeys,
  intelIdentityProductId,
};
