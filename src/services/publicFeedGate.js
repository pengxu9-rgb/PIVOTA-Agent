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

/**
 * @param {Array<object>} rows   Raw lane rows, BEFORE projection.
 * @param {object}   opts
 * @param {function} opts.project   Row -> ACP-shaped item. Each lane keeps its
 *   own: the index lane's `toAcpFeedProduct` reads `product_entity_id`, the
 *   connected lane's `buildAcpFeedItem` reads `id`/`product_id`. Same target
 *   shape, different sources — which is exactly why the projection is the
 *   lane's and the policy is not.
 * @param {function} opts.isLinkable  Link-shape predicate (injected to avoid a
 *   require cycle: acpFeedSource already requires this module's siblings).
 * @param {object}   [opts.logger]
 * @param {string}   [opts.lane]   Label for the log lines only.
 * @param {object}   [opts.env]    Threaded to `isTestMerchantId` so the no-deploy
 *   rig escape hatch keeps working. Defaulting it here rather than threading it
 *   is a silent disablement, not a tidy-up.
 * @returns {{items: Array<object>, dropped: {rig: number, unlinkable: number, unquotable: number}}}
 */
function gatePublicFeedRows(rows, { project, isLinkable, logger, lane = 'unknown', env = process.env } = {}) {
  const input = Array.isArray(rows) ? rows : [];

  // 1. RIGS FIRST, and on the RAW row — `merchant_id` does not survive every
  //    projection (`buildAcpFeedItem` folds it into `brand` as a fallback and
  //    keeps no `merchant_id` key), so gating after projection would silently
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
  const linkable = projected.filter((p) => isLinkable(p));

  // 4. PRICE. Shopping ingesters REJECT price-less items, and a rejected item
  //    costs the whole submission's credibility where an absent one costs a row.
  const items = linkable.filter(isQuotableFeedItem);

  const dropped = {
    rig: input.length - withoutRigs.length,
    unlinkable: projected.length - linkable.length,
    unquotable: linkable.length - items.length,
  };

  if (logger) {
    if (dropped.rig) {
      logger.info({ lane, surface: 'acp_public_feed', dropped: dropped.rig, reason: 'test_merchant' },
        'acp feed: excluded test/demo merchant products');
    }
    if (dropped.unlinkable && logger.warn) {
      // WARN, not info: a row whose PDP link would not resolve is a data problem
      // upstream, not routine filtering. On the connected lane this fired on
      // 17 of 17 rows in production.
      logger.warn({ lane, surface: 'acp_public_feed', dropped: dropped.unlinkable, reason: 'unresolvable_pdp_id' },
        'acp feed: dropped items whose PDP link would not resolve');
    }
    if (dropped.unquotable) {
      logger.info({ lane, surface: 'acp_public_feed', dropped: dropped.unquotable, reason: 'not_price_quotable' },
        'acp feed: dropped items with no quotable price');
    }
  }

  return { items, dropped };
}

module.exports = { gatePublicFeedRows };
