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
    // NOT SET, deliberately, and this is a real degradation to be honest about:
    // this lane does not mint the signed `/r` attribution deep-link (that is
    // stamped by pivota-backend on the find_products path), so an agent that
    // follows tool links programmatically loses the direct attributed hop.
    // Attribution is not lost outright — the D1 decision's primary mechanism is
    // that `link` is a Pivota PDP whose own outbound buttons are attributed —
    // but the secondary hop is absent until the lane learns to mint one.
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
  PIVOTA_SIGNATURE_ID,
  toAcpFeedProduct,
  isLinkableFeedProduct,
  ACP_FEED_SOURCE_INDEX,
  isIndexFeedSourceEnabled,
  resolveFeedMarket,
  fetchIndexFeedProducts,
};
