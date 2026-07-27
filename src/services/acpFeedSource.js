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

const ENV_TRUE = new Set(['1', 'true', 'yes', 'on']);

// The source selector. Default UNSET = today's `find_products` behaviour,
// byte-identical. Flipped by env, never by merge — this is a public,
// externally-ingested surface, so the deploy and the behaviour change are
// deliberately two separate events.
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
  const quotable = withoutRigs.filter(isQuotableFeedItem);
  if (quotable.length !== withoutRigs.length && logger?.info) {
    logger.info(
      { dropped: withoutRigs.length - quotable.length, surface: 'acp_public_feed', reason: 'not_price_quotable' },
      'acp feed: dropped items with no quotable price',
    );
  }
  return quotable;
}

module.exports = {
  ACP_FEED_SOURCE_ENV,
  ACP_FEED_SOURCE_INDEX,
  isIndexFeedSourceEnabled,
  resolveFeedMarket,
  fetchIndexFeedProducts,
};
