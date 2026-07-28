'use strict';

/**
 * THE gate for anything published on the public ACP feed, whichever lane
 * produced it.
 *
 * WHY THIS MODULE EXISTS (issue #1847). The index lane and the connected
 * fallback lane each hand-assembled their own filter chain, and they were not
 * the same chain:
 *
 *   index lane      rigs -> project -> LINKABLE -> quotable
 *   connected lane  rigs -> project ->     ??    -> quotable
 *
 * The connected lane had no link-shape gate. Measured on prod 2026-07-28, an
 * unsigned `GET /acp/feed` with a JSON body returned 17 rows, and every one
 * carried an `ext_*` id whose PDP answers HTTP 500 — a public feed publishing
 * dead links under our name. Seven of the 17 were Mintree at 847-3927.70
 * labelled "USD" (the INR-served-as-USD defect), which the sitemap, the
 * canonical feed and the PDP route all correctly withhold.
 *
 * That is not a regression of any block. It is a door that never read the gate.
 * The containment was applied to the index/serving path, every consumer that
 * READS that path is clean, and this lane reads none of it.
 *
 * So the policy — WHICH gates, in WHAT order, with what logging — lives here
 * once. A lane supplies its rows and its projection; it does not get to choose
 * the policy. Adding a lane that forgets a gate now requires deliberately not
 * calling this function, rather than merely forgetting a line.
 *
 * WHAT THIS DOES NOT COVER, stated plainly so nobody reads it as total:
 *   - Currency correctness. An INR price mislabelled "USD" is indistinguishable
 *     from a real USD price at this layer — `isQuotableFeedItem` can only see
 *     that A currency is present. Detecting the mislabel needs the offer's
 *     suppression state (`source_currency_or_channel_defect`), which lives in
 *     pivota-backend and reaches the index lane through `serving_eligible`.
 *     The index lane is therefore currency-safe by construction; the connected
 *     lane is NOT, and cannot be made so from here. That remains #1847's open
 *     half and belongs upstream.
 *   - Renderability beyond id SHAPE. `isLinkableFeedProduct` proves an id is
 *     well-formed, never that it resolves — see the note in acpFeedSource.
 */

const { isTestMerchantId } = require('./testMerchantPolicy');
const { isQuotableFeedItem } = require('../acpFeedItem');
const { isUsableTitleText } = require('./productEntityIndexFeed');

// OWNED HERE, not injected. The first cut took `isLinkable` as a parameter to
// dodge a require cycle with acpFeedSource — the cycle is real (a direct
// require resolves `undefined` under the production load order, verified) —
// but the injection re-opened the very hole this module closes: a lane could
// pass `isLinkable: () => true` and still be "calling the shared gate". Rig and
// price were hard-wired and un-opt-out-able; the link gate, the one #1847
// exists to add, was the only one a caller could neutralise.
//
// Moving the predicate here kills the cycle and the opt-out together.
// `acpFeedSource` re-exports both names so existing importers are unaffected.
const PIVOTA_SIGNATURE_ID = /^sig_[a-z0-9]+$/i;

/**
 * Would this item produce a PDP link that actually resolves?
 *
 * Sibling to `isQuotableFeedItem`. A price gate without a link gate protects
 * the cheaper of the two failure modes: a mispriced item is one bad row, a
 * dead link is a dead row that also burns crawl budget and trust.
 *
 * Proves an id is WELL-FORMED, never that it resolves.
 */
function isLinkableFeedProduct(product) {
  const id = String((product && product.id) || '').trim();
  return PIVOTA_SIGNATURE_ID.test(id);
}

/**
 * @param {Array<object>} rows   Raw lane rows, BEFORE projection.
 * @param {object}   opts
 * @param {function} opts.project   Row -> ACP-shaped item. Each lane keeps its
 *   own: the index lane's `toAcpFeedProduct` reads `product_entity_id`, the
 *   connected lane's `buildAcpFeedItem` reads `id`/`product_id`. Same target
 *   shape, different sources — which is exactly why the projection is the
 *   lane's and the policy is not.
 * @param {object}   [opts.logger]
 * @param {string}   [opts.lane]   Label for the log lines only.
 * @param {object}   [opts.env]    Threaded to `isTestMerchantId` so the no-deploy
 *   rig escape hatch keeps working. Defaulting it here rather than threading it
 *   is a silent disablement, not a tidy-up.
 * @returns {{items: Array<object>, dropped: {rig: number, unlinkable: number, untitled: number, unquotable: number}}}
 */
function gatePublicFeedRows(rows, { project, logger, lane = 'unknown', env = process.env } = {}) {
  // `source` is emitted ALONGSIDE `lane`, not instead of it. The index lane's
  // other log lines (server.js error/warn) still carry `source: 'index_feed'`,
  // so dropping it here would make a `source=index_feed` query return a partial
  // view of that lane — worse than either name alone.
  const logBase = { lane, source: lane, surface: 'acp_public_feed' };
  const input = Array.isArray(rows) ? rows : [];

  // 1. RIGS FIRST, and on the RAW row — `merchant_id` does not survive every
  //    projection (`buildAcpFeedItem` keeps no `merchant_id` key; it
  //    used to fold it into `brand` as a fallback, removed in #1851), so gating after projection would silently
  //    stop excluding rigs on the connected lane. That ordering is load-bearing,
  //    not incidental.
  //    `env` is THREADED, not defaulted inside isTestMerchantId: the index lane
  //    passes its own env so an operator can exclude a newly-spotted rig by
  //    setting a var, with no deploy. Dropping that argument while extracting
  //    this function silently disabled the escape hatch — caught by the existing
  //    `acp_feed_source` test, which is exactly what that test is for.
  const withoutRigs = input.filter((r) => !isTestMerchantId(r?.merchant_id, env));

  // 2. Project into the ACP shape BEFORE the remaining gates, so they see what
  //    the feed will actually EMIT rather than what the lane happened to return.
  const projected = withoutRigs.map((r) => project(r));

  // 3. LINK SHAPE. The gate the connected lane never had.
  const linkable = projected.filter(isLinkableFeedProduct);

  // 4. TITLE. A feed item whose name is missing — or is a URL that slipped
  //    through the lane's own chain — is not publishable: `title` is the field
  //    an ingester displays as the product name, so a URL there is worse than
  //    an absent row. #1852 measured 3,952 of 4,375 live rows (90%) publishing
  //    the PDP URL as their title.
  //
  //    THIS COUNTER IS THE RESIDUE METRIC. The lane fix reaches the real title
  //    via `cp.title`, and probing 6 affected rows across 6 brands found a
  //    proper name on every one, so this is expected to drop ~0. If it drops
  //    thousands in prod, the premise was wrong and the corpus genuinely lacks
  //    titles — which is a data-authoring problem, not a mapper one. Watch
  //    `reason: 'no_usable_title'` after deploy rather than assuming.
  // SHARED predicate, not an inline copy — review found the `/i` flag unpinned
  // on both copies and nothing stopping them drifting.
  const titled = linkable.filter((p) => isUsableTitleText(p?.title));

  // 5. PRICE. Shopping ingesters REJECT price-less items, and a rejected item
  //    costs the whole submission's credibility where an absent one costs a row.
  const items = titled.filter(isQuotableFeedItem);

  const dropped = {
    rig: input.length - withoutRigs.length,
    unlinkable: projected.length - linkable.length,
    untitled: linkable.length - titled.length,
    unquotable: titled.length - items.length,
  };

  // `logger?.info?.(...)` — BOTH optional links matter, and my first fix only
  // had the first. `logger?.info(...)` guards a null LOGGER, not a missing
  // METHOD: with `logger = {}` it still throws. Caught by the test written for
  // this very finding, one line after writing it.
  //
  // The chain this replaced
  // used optional calls throughout, so a partial logger silently skipped. The
  // first draft here guarded only the warn branch, which meant a logger with no
  // `.info` THREW: `fetchIndexFeedProducts` rejects, the adapter's guard() turns
  // it into a bare 500, and the public feed answers an unlogged error. That is
  // the exact failure #1846 fixed one layer up, reintroduced while extracting.
  {
    if (dropped.rig) {
      logger?.info?.({ ...logBase, dropped: dropped.rig, reason: 'test_merchant' },
        'acp feed: excluded test/demo merchant products');
    }
    if (dropped.unlinkable) {
      // WARN, not info: a row whose PDP link would not resolve is a data problem
      // upstream, not routine filtering. On the connected lane this fired on
      // 17 of 17 rows in production.
      logger?.warn?.({ ...logBase, dropped: dropped.unlinkable, reason: 'unresolvable_pdp_id' },
        'acp feed: dropped items whose PDP link would not resolve');
    }
    if (dropped.untitled) {
      logger?.warn?.({ ...logBase, dropped: dropped.untitled, reason: 'no_usable_title' },
        'acp feed: dropped items with no usable title (a URL is not a name)');
    }
    if (dropped.unquotable) {
      logger?.info?.({ ...logBase, dropped: dropped.unquotable, reason: 'not_price_quotable' },
        'acp feed: dropped items with no quotable price');
    }
  }

  return { items, dropped };
}

module.exports = { gatePublicFeedRows, isLinkableFeedProduct, PIVOTA_SIGNATURE_ID };
