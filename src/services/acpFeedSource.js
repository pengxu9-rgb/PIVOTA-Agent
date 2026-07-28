'use strict';

// Where GET /acp/feed gets its products — the PRICED SERVING LANE.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
// The public ACP feed asks the backend for `find_products` with an EMPTY query.
// With no merchant_id the backend falls back to multi-search, which resolves to
// the `connected_catalog` lane: the live catalogs of CONNECTED Shopify stores,
// gated only by `_is_product_sellable`. Every connected store is a test rig, so
// `testMerchantPolicy` correctly empties it and the feed serves
// `{"version":"2026-04-17","count":0,"products":[]}`.
//
// Two separate errors were folded into one story, and both are now settled by
// founder policy (2026-07-27) and by measurement (pivota-backend
// docs/adr/ADR-018-connection-layer-and-priced-serving-lane.md):
//
//   1. A CATEGORY ERROR. "The feed is empty until a real merchant connects"
//      defined *real merchant* as *connected via product sync*. The founder
//      rejects that: every crawled merchant and product is real, and all three
//      connection layers are transactable — the layer describes HOW a
//      transaction executes, not WHETHER one can. Measured in prod: 12,542
//      crawled products from 53 sellers, and ZERO real merchants in layers 2
//      and 3 (the entire internal_merchant track is 5 rigs plus one
//      brand-authored row that was never synced). The feed is pointed at the
//      emptiest lane, not at the only real one.
//
//   2. THE CONSTRAINT WE NEVER ACTUALLY CITED. Shopping ingesters reject
//      price-less items, and until #1824 EVERY serving-eligible lane emitted
//      `price: null`. **Price, not merchant realness, is why the serving
//      catalog was never pointed at this feed.** #1824 fixed it; nothing
//      re-measured afterwards. Re-measured now: 4,782 serving-eligible rows,
//      100% carrying `has_price`, and 4,467 content_keys that pass every gate
//      WITH a priced, currency-bearing offer — up from the 0 served today.
//
// ── WHAT THIS MODULE IS ───────────────────────────────────────────────────────
// The whole swap, minus one line. `src/server.js` is owned elsewhere; this
// module exists so the change there is a single call substitution inside
// `getCommerceAcpRestAdapter()`'s `getProducts` closure, with every decision
// (flag, source selection, rig exclusion, price gate) already made and tested
// here.
//
// ══ OPERATOR PRECONDITION — THE TWO FLAGS ARE NOT INDEPENDENT ════════════════
//
//   ACP_FEED_SOURCE=index_feed  MUST NEVER be set without
//   INDEX_FEED_ELECTED_CANONICAL=1
//
// `isLinkableFeedProduct` below proves an id is WELL-FORMED. It cannot prove the
// id RESOLVES, and those differ in production. Of 600 sampled prod rows, 9 are
// `serving_eligible: true` AND `renderable: false` — well-formed sigs that pass
// this lane's own `ips.serving_eligible = TRUE` join and are nevertheless dead
// pages. That is ~1.5% of the feed.
//
// In 9 of those 9, the ELECTED canonical resolves 200. So the election
// preference is not a nice-to-have ranking tweak — it is the mitigation for the
// dead-link class, and an operator who flips only the source flag republishes a
// smaller version of the bug that nearly shipped in this very PR (every `link`
// a 500). Flip both, or neither.
//
// The durable fix is a renderability signal on the row, NOT another id-shape
// heuristic and NOT a hand-ported predicate: pivota-backend already has
// `services/pdp_renderability.pdp_will_render_expression`, documented as what a
// consumer deciding whether to ADVERTISE a URL should ask. The follow-up is to
// have the backend PERSIST it onto `index_pipeline_state` so this lane can add
// one `AND ips.<col> = TRUE`. A fourth drifting copy of that logic would be
// worse than the present gap.
//
// ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────────
// It does not open the money path. The ACP checkout doors stay dark
// (`AGENT_CHECKOUT_ACP_REST_ENABLED` unset; `POST /acp/checkout_sessions`
// 404s). This is feed CONTENT. Pivota stays a protocol mid-man: `link` is a
// Pivota canonical PDP, `external_redirect_url` is the signed /r attribution
// link to the MERCHANT's own destination, and settlement is the merchant's.

const { isTestMerchantId } = require('./testMerchantPolicy');
const { isQuotableFeedItem } = require('../acpFeedItem');

// The ONLY id shape the public PDP route resolves. Verified against live prod:
//   /products/sig_1b4d53ca07835e10cdaada553bc26ed6  -> 200
//   /products/ext_0feb1c58f18d9f6694955e7e          -> 500 (same as a bogus id)
// An `ext_*` source_product_id is indistinguishable from garbage to that route.
const PIVOTA_SIGNATURE_ID = /^sig_[a-z0-9]+$/i;

/**
 * Project a PRODUCT-ENTITY-INDEX-FEED item into the shape `buildAcpFeedItem`
 * expects.
 *
 * THIS FUNCTION IS THE WHOLE POINT, and it is worth saying why in full, because
 * the bug it fixes was invisible to every unit test written against this module.
 *
 * The lane's item sets `id = source_product_id` (an `ext_*` seed id), because
 * its own consumers key on the source listing. `buildAcpFeedItem` reads `o.id`
 * FIRST and builds `link = buildPublicProductUrl(id)`. So handing a raw lane
 * item to the mapper produces `/products/ext_…` — and every single `link` in
 * the feed is a live 500. A shopping ingester that fetches those drops the whole
 * submission; one that doesn't fetch them publishes dead links under our name.
 *
 * The correct value is already on the row (`product_entity_id` /
 * `canonical_sig_id` = `sig_…`); the projection simply has to use it. The tests
 * could not see this because they fed synthetic `{id:'a', price, currency}`
 * stubs that never went near a real lane row — which is exactly the
 * no-op-behind-a-success-signal shape this repo keeps hitting.
 *
 * @param {object} item One item from getProductEntityIndexFeed.
 */
function toAcpFeedProduct(item) {
  const o = item && typeof item === 'object' ? item : {};
  return {
    // The canonical signature, NEVER source_product_id. `id` is what the PDP
    // URL is built from, so getting this wrong is not a cosmetic field error.
    id: o.product_entity_id || o.canonical_sig_id || o.sellable_item_group_id,
    title: o.title || o.name,
    // The lane carries the seed description; without this every feed item is
    // description-less, which several ingesters treat as low quality.
    description: o.description,
    image_url: o.image_url,
    price: o.price ?? o.price_amount,
    currency: o.currency ?? o.price_currency,
    availability: o.availability,
    brand: o.brand,
    merchant_id: o.merchant_id,
    connection_layer: o.connection_layer,
    execution_path: o.execution_path,
    // NOT SET, deliberately — and the earlier version of this comment justified
    // that with a safety property that IS NOT TRUE, which is the exact defect
    // family this PR keeps fixing, committed inside the fix.
    //
    // It claimed "attribution rides on the PDP's own outbound buttons". Checked
    // against a live PDP (sig_1b4d53ca07835e10cdaada553bc26ed6, 364 KB): it
    // contains ZERO `pivota.cc/r?` links, and its two embedded
    // `external_redirect_url` values are a RAW MERCHANT URL
    // (www.tomfordbeauty.com/products/…). There is no attribution hop on that
    // row in either lane.
    //
    // So omitting the field is still right, but for a different reason: nothing
    // is lost that exists. What IS lost is the direct-to-merchant link for an
    // agent that follows tool links programmatically rather than rendering the
    // PDP — it gets the Pivota PDP and nothing else. Whether that matters is a
    // product question, not a safety one.
    // external_redirect_url: intentionally omitted.
  };
}

/**
 * Would this item produce a PDP link that actually resolves?
 *
 * Sibling to `isQuotableFeedItem`. A price gate without a link gate protects
 * the cheaper of the two failure modes: a mispriced item is one bad row, a
 * dead link is a dead row that also burns crawl budget and trust.
 */
function isLinkableFeedProduct(product) {
  const id = String((product && product.id) || '').trim();
  return PIVOTA_SIGNATURE_ID.test(id);
}

const ENV_TRUE = new Set(['1', 'true', 'yes', 'on']);

// The source selector. Default UNSET = today's `find_products` behaviour,
// byte-identical. Flipped by env, never by merge — this is a public,
// externally-ingested surface, so the deploy and the behaviour change are
// deliberately two separate events.
// FOUR env vars, not three — `ACP_FEED_MARKET` below is the fourth and was
// missing from the PR's own flag list. It defaults to 'US', which matches the
// lane's existing default, so it changes nothing unset; it is named here so the
// list of things an operator can change is complete.
const ACP_FEED_SOURCE_ENV = 'ACP_FEED_SOURCE';
const ACP_FEED_SOURCE_INDEX = 'index_feed';

function isIndexFeedSourceEnabled(env = process.env) {
  return String(env?.[ACP_FEED_SOURCE_ENV] || '').trim().toLowerCase() === ACP_FEED_SOURCE_INDEX;
}

// ══ THE COUPLING, NOW ENFORCED IN CODE RATHER THAN IN A COMMENT ══════════════
//
// The header above states the precondition — `ACP_FEED_SOURCE=index_feed` must
// never be set without `INDEX_FEED_ELECTED_CANONICAL=1` — and until this commit
// that statement was the ENTIRE mechanism. Nothing read the second flag on this
// path. The two flags happened to agree in prod, so the correct behaviour was
// the operator's, not the code's, and the code would have gone on working "by
// luck" until the day someone unset one of them.
//
// What is lost when they disagree is not a ranking nicety. Of 600 sampled prod
// rows, 9 are `serving_eligible: true` AND `renderable: false` — well-formed
// sigs that pass this lane's own join and are nevertheless dead pages, i.e.
// ~1.5% of the feed. In 9 of those 9 the ELECTED canonical resolves 200. The
// election preference IS the mitigation for the dead-link class, so a lane
// running without it publishes known-dead links under our name on a public,
// externally-ingested surface.
//
// Hence: source-selected + election-off is not a degraded mode, it is a mode
// this lane refuses. `isIndexFeedLaneServable` is what a caller asks; the throw
// inside `fetchIndexFeedProducts` is the belt to that braces, unreachable on the
// correct path and loud on a mis-wired one.
const INDEX_FEED_ELECTED_CANONICAL_ENV = 'INDEX_FEED_ELECTED_CANONICAL';

// NOTE ON WHICH env THIS READS. `productEntityIndexFeed` reads
// `process.env.INDEX_FEED_ELECTED_CANONICAL` DIRECTLY and cannot be injected;
// this helper honours the injected `env` so the gate stays unit-testable. In
// production the caller passes no `env`, so both default to the same
// `process.env` object and the gate provably describes the lane it guards. A
// caller that injects a DIFFERENT env is testing, not serving.
function isElectedCanonicalEnabled(env = process.env) {
  return ENV_TRUE.has(String(env?.[INDEX_FEED_ELECTED_CANONICAL_ENV] || '').trim().toLowerCase());
}

// The predicate a caller must ask before serving this lane. Deliberately NOT
// folded into `isIndexFeedSourceEnabled`: that one answers "which source did the
// operator name?", which is also what the mis-configuration warning needs to
// distinguish from "no source named at all".
function isIndexFeedLaneServable(env = process.env) {
  return isIndexFeedSourceEnabled(env) && isElectedCanonicalEnabled(env);
}

// The feed's market. Non-US offers are correctly LABELLED (measured: 0 offers
// have a NULL currency) but a US shopping ingester may still reject or mis-rank
// them, and 160 of the ~5,774 representative best-offers behind the serving
// lane are non-USD. Pinning the market is the cheap half of the currency gate;
// the other half — auditing the 2,497 USD-labelled offers that carry no
// `source_domain`, and so have UNVERIFIABLE currency provenance — belongs to
// the currency workstream, and this module deliberately does not duplicate it.
// Suppression is the shared containment: condemned offers get
// `suppression_reason='source_currency_or_channel_defect'` (466 today) and the
// lane's `o.suppressed_at IS NULL` predicate drops them for free.
function resolveFeedMarket(env = process.env) {
  const raw = String(env?.ACP_FEED_MARKET || '').trim();
  return (raw || 'US').toUpperCase();
}

function clampLimit(value, fallback = 20, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Fetch the ACP feed's products from the priced serving lane.
 *
 * @param {object} query      The feed request's filter object (limit / cursor / page).
 * @param {object} deps
 * @param {Function} deps.getProductEntityIndexFeed  The lane (src/services/productEntityIndexFeed).
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {Promise<Array<object>>} products, rig-free and price-quotable.
 */
async function fetchIndexFeedProducts(query = {}, deps = {}) {
  const { getProductEntityIndexFeed, env = process.env, logger } = deps;
  if (typeof getProductEntityIndexFeed !== 'function') {
    throw new Error('fetchIndexFeedProducts requires getProductEntityIndexFeed');
  }

  // Fail CLOSED on the one misconfiguration the header names (see
  // `isIndexFeedLaneServable`). Scoped to the mis-wired combination only —
  // source-selected AND election-off — so a caller that drives this lane
  // directly with neither flag set (every existing unit test) is unaffected,
  // while the state that would republish ~1.5% dead links cannot serve at all.
  // A throw, not a silent empty list: on this surface an empty feed and a
  // refused feed must not look the same, and an exception is the only one of the
  // two the route's 503 handler reports.
  if (isIndexFeedSourceEnabled(env) && !isElectedCanonicalEnabled(env)) {
    throw new Error(
      `acp feed: ${ACP_FEED_SOURCE_ENV}=${ACP_FEED_SOURCE_INDEX} requires ${INDEX_FEED_ELECTED_CANONICAL_ENV}=1 `
        + '(the elected canonical is the mitigation for serving_eligible-but-unrenderable rows; '
        + 'without it ~1.5% of feed links are dead). Set both flags, or neither.',
    );
  }

  const result = await getProductEntityIndexFeed(
    {
      limit: clampLimit(query?.limit),
      cursor: query?.cursor,
      page: query?.page,
      market: resolveFeedMarket(env),
      tool: 'acp_public_feed',
      // Apply the price gate in SQL so LIMIT counts QUOTABLE rows. Without it
      // the JS gate below trims after the fact and every page silently
      // under-delivers by ~24% (prod: ~4,467 priced of ~5,887), with no cursor
      // in the ACP feed body to recover the difference.
      priced_only: true,
    },
    {},
  );

  const products = asArray(result?.products);

  // Defence in depth, NOT redundancy — but the two legs are NOT equivalent, and
  // it is worth being exact about which one covers what.
  //
  // The SQL gate (`activeCatalogProductSourceWhere`) has BOTH legs: merchant-id
  // AND the `pivota-review-demo%` source_domain prefix. The domain leg exists
  // because one demo domain is live under two distinct merchant_ids, so a
  // re-connected demo store under a NEW id is still caught.
  //
  // This runtime leg has only the merchant-id leg, because the lane's item does
  // not project `source_domain`. It is the leg that actually stopped the
  // 2026-07-23 leak (all 20 feed items were rigs) when the SQL gate did not
  // reach the lane in play — but be clear-eyed: in that same scenario it would
  // NOT catch a demo store re-connected under an unknown merchant_id. Closing
  // that would mean projecting source_domain onto the item; noted rather than
  // done, because for THIS lane the SQL domain leg is in play and verified.
  const withoutRigs = products.filter((p) => !isTestMerchantId(p?.merchant_id, env));
  if (withoutRigs.length !== products.length && logger?.info) {
    logger.info(
      { dropped: products.length - withoutRigs.length, surface: 'acp_public_feed', source: 'index_feed' },
      'acp feed: excluded test/demo merchant products',
    );
  }

  // THE PRICE GATE IS APPLIED HERE, not left to the caller.
  //
  // It has to be: the lane's best-offer join is a LEFT JOIN LATERAL, so a row
  // with no priced, currency-bearing, unsuppressed offer comes back with
  // `price: null` rather than being dropped. This module advertises itself as
  // "the whole swap minus one line" and the server.js integration as a single
  // call substitution — so if the gate lived in the caller, an integrator doing
  // exactly what the handoff says would ship price-null items to ChatGPT/Google.
  // That is the precise failure this lane exists to prevent, and a documented
  // requirement is not a gate.
  // Project into the ACP shape BEFORE gating, so both gates see what the feed
  // will actually emit rather than what the lane happens to return.
  const projected = withoutRigs.map(toAcpFeedProduct);

  const linkable = projected.filter(isLinkableFeedProduct);
  if (linkable.length !== projected.length && logger?.warn) {
    // warn, not info: a lane row without a resolvable signature is a data
    // problem upstream, not routine filtering.
    logger.warn(
      { dropped: projected.length - linkable.length, surface: 'acp_public_feed', reason: 'unresolvable_pdp_id' },
      'acp feed: dropped items whose PDP link would not resolve',
    );
  }

  const quotable = linkable.filter(isQuotableFeedItem);
  if (quotable.length !== linkable.length && logger?.info) {
    logger.info(
      { dropped: linkable.length - quotable.length, surface: 'acp_public_feed', reason: 'not_price_quotable' },
      'acp feed: dropped items with no quotable price',
    );
  }
  return quotable;
}

module.exports = {
  ACP_FEED_SOURCE_ENV,
  INDEX_FEED_ELECTED_CANONICAL_ENV,
  PIVOTA_SIGNATURE_ID,
  toAcpFeedProduct,
  isLinkableFeedProduct,
  ACP_FEED_SOURCE_INDEX,
  isIndexFeedSourceEnabled,
  isElectedCanonicalEnabled,
  isIndexFeedLaneServable,
  resolveFeedMarket,
  fetchIndexFeedProducts,
};
