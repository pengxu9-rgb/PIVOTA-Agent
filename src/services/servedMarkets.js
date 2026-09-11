'use strict';

/**
 * WHICH MARKETS THIS DEPLOYMENT SERVES — one place, list-valued.
 *
 * WHY THIS EXISTS. Making Singapore servable took two env vars that do not know about each
 * other, and the second one could not express the answer:
 *
 *   PIVOTA_SERVING_PRICING_REGIONS=US,SG  (backend) decides whether an SGD-priced row clears
 *     the `no_us_offer` blocker and gets index_pipeline_state.serving_eligible = TRUE. It is a
 *     COMMA LIST and works.
 *   CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET (here) decides which seed rows the door recalls.
 *     It was a SINGLE value bound to a scalar `AND market = $1`, so `SG` swapped US OFF and
 *     `US,SG` produced the literal string 'US,SG' and matched zero rows.
 *
 * So a row could be serving_eligible and still invisible, and no configuration could fix it.
 * An audit of the whole route found THIRTY market/region/currency gates across the two repos,
 * eight independent implementations of "what market is this", over three different columns —
 * and exactly one of the eight was list-valued. This module is the start of there being one.
 *
 * ⚠️ IT IS NOT THE ONLY ONE YET. Still outside it, and documented rather than silently left:
 *   - `src/markets/market.js` enumerates `z.enum(['US','JP'])` and `normalizeMarket('SG')`
 *     silently returns 'US'. The door does not import it, which is the only reason SG rows can
 *     exist at all. It should either learn the real market list or be deleted.
 *   - `catalog_offers.market` is NOT NULL DEFAULT 'US' (backend db/catalog.py:300) and no
 *     external-seed writer sets it, so every gate keyed on that column is reading a constant.
 *   - `src/server.js:17366` widens the market only when `safeMarket === 'KR'`, a literal.
 *
 * BACKWARD COMPATIBLE BY CONSTRUCTION. Unset or a single value yields a one-element list and
 * the emitted SQL matches exactly the rows the scalar `=` matched. Widening is opt-in, and is
 * a deliberate act by whoever sets the env — which matters, because serving two markets from
 * one door mixes their pricing into one shopper's results unless the request names a market.
 */

const DEFAULT_MARKET = 'US';

/** Split a comma/whitespace list into upper-case market codes, order preserved, deduped. */
function parseMarketList(raw, fallback = DEFAULT_MARKET) {
  const out = [];
  for (const part of String(raw == null ? '' : raw).split(/[,\s]+/)) {
    const code = part.trim().toUpperCase();
    // A market code is two letters. Anything else is a typo or a locale ("en-US"), and
    // silently binding it would match no rows — the failure this module exists to stop.
    if (/^[A-Z]{2}$/.test(code) && !out.includes(code)) out.push(code);
  }
  if (out.length) return out;
  // `fallback: null` means "no fallback — an empty list is a real answer". Without this,
  // `marketsForRequest` could not tell "the request named no market" from "the request named
  // one", because the empty parse coerced back to ['US'] and the deployment list was never
  // consulted. Caught by this module's own test, which is why the parameter is explicit.
  if (fallback === null) return [];
  const fb = String(fallback || DEFAULT_MARKET).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(fb) ? [fb] : [DEFAULT_MARKET];
}

/**
 * The markets this deployment serves, from the environment. Always at least one element.
 */
function servedMarkets(env = process.env) {
  return parseMarketList(env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET, DEFAULT_MARKET);
}

/**
 * The markets to bind for ONE request.
 *
 * A request that names a market gets exactly that market — a shopper asking for SG must not be
 * served US pricing alongside it. Only when the request is silent does the deployment's full
 * served list apply. `requested` may be a string or a list.
 */
function marketsForRequest(requested, env = process.env) {
  const asked = parseMarketList(requested, null);
  if (asked.length) return asked;
  return servedMarkets(env);
}

/**
 * THE ONE PLACE A LANE DECIDES WHICH MARKETS IT BINDS — and the reason it is a function rather
 * than two lines inlined at each lane.
 *
 * The served list has now been lost TWICE by being resolved correctly and then collapsed with
 * `[0]` thousands of lines before the bind: once at the lane default, once at the caller. Both
 * times every constant, every default and every regex stayed correct while the door bound a
 * single market. Inline logic cannot be driven by a test; this can.
 *
 * `inherited` is the list the caller already resolved. If it is present it WINS — re-deriving
 * from `fallbackName` is exactly the collapse, because `fallbackName` is a single name and
 * `marketsForRequest` of one name can only ever return one element.
 */
function laneMarkets(inherited, fallbackName, env = process.env) {
  if (Array.isArray(inherited) && inherited.length) return inherited;
  return marketsForRequest(fallbackName, env);
}

/** The single market to stamp on an outgoing card when a row carries none. */
function primaryMarket(env = process.env) {
  return servedMarkets(env)[0];
}

/**
 * THE PREDICATE AND ITS PARAM, AS A PAIR — so the default deployment's QUERY PLAN is provably
 * unchanged, not merely probably.
 *
 * `market` is the LEADING column of the partial indexes these recall lanes depend on
 * (db/migrations/034_external_seed_recall_vertical_fastpath.sql, 039_*), and every one of them
 * is `ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT n`. A scalar `=`
 * carries the index's sort order; a ScalarArrayOpExpr does not reliably, and the array length
 * is unknown at plan time for a bound parameter, so the planner may add a Sort. These lanes
 * ALREADY return 57014 timeouts, so that is not a risk worth taking for the common case.
 *
 * One market — which is every deployment today — emits exactly the SQL that shipped before.
 * The array form appears only when someone has actually opted into more than one market.
 * Returned together because a predicate and its parameter must not be able to disagree; that
 * mismatch is precisely the bug this change already made once.
 */
function marketBind(markets, paramRef) {
  const list = Array.isArray(markets) ? markets : parseMarketList(markets);
  // An EMPTY list would emit `market = ANY($1::text[])` with `[]` — valid SQL that matches
  // nothing, silently. Every caller goes through servedMarkets()/marketsForRequest(), which
  // never return empty, so reaching this means a caller built a list by hand and got it wrong.
  // Fail loudly rather than serve an empty catalogue.
  if (!list.length) {
    throw new Error('marketBind: empty market list would silently match zero rows');
  }
  return list.length === 1
    ? { sql: `market = ${paramRef}`, value: list[0] }
    : { sql: `market = ANY(${paramRef}::text[])`, value: list };
}

module.exports = {
  DEFAULT_MARKET,
  marketBind,
  parseMarketList,
  servedMarkets,
  marketsForRequest,
  laneMarkets,
  primaryMarket,
};
