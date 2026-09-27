'use strict';

// THE BUYER'S MARKET IS A CURRENCY, NOT A PARTITION -- Stage 0a of the market design.
//
// WHY THIS EXISTS. `external_product_seeds.market` is a SERVING PARTITION, not the buyer's
// market: every serving-eligible SGD seed (614 on prod, 2026-09-18 -- jsmbeauty.sg, cocomo.sg,
// makeupforever.sg) is filed under 'US', and the 'SG' partition holds zero rows. So a caller
// that does the right thing and names `market=SG` binds the empty partition and gets nothing,
// while a caller that names nothing gets SGD and USD rows mixed on one page. Both are wrong,
// and the partner report that started this (Meitu, 2026-09-15) hit the first one.
//
// The fix is not to move rows between partitions (DO NOT set SEED_MARKET=SG -- see
// servedMarkets.js) and not to drop the caller's market. It is to read the named market as
// what it is -- where the buyer is -- and turn it into the one thing the lanes can honour
// today: the currency the buyer is priced in. The lanes bind the partitions this deployment
// serves, and the EXISTING offer-currency scope (the same one `search.currency` already
// drives, through both lanes' SQL and the post-filter) narrows them to that currency.
//
// THE NAMED PARTITION IS KEPT, NOT SWAPPED OUT. Some named markets ARE populated partitions
// (prod 2026-09-17, serving-eligible: JP 331, EU-DE 50, KR 27, GB 19, CN 6). Binding only the
// served list would take a JP buyer's 331 JP rows away -- a new branch deleting more than the
// old one. So a named market outside the served list is bound ALONGSIDE it, and the currency
// scope decides. That makes the bind a list (`= ANY`) -- but only for requests that name a
// market this deployment does not serve, which today bind one empty partition and return
// nothing. Silent requests and a named served market (US) keep the scalar plan.
//
// WHAT IT DOES NOT DO:
//   - It never infers a market from a currency, a language or a header (buyerRegion.js owns
//     region -> currency, one direction only).
//   - A market it cannot price (no currency for it, or more than one market named) is left
//     EXACTLY as it was: bound as a partition. Its servingCurrency is null, though, so the
//     door serves it nothing (resolveServingCurrency, 2026-09-27).
//   - A caller's explicit currency no longer wins over the buyer's for the OFFERS served (it
//     did until 2026-09-27; Peng's currency rule overturned that). It still denotes a budget's
//     unit (resolveBuyerBudgetConstraint).
//
// ⚠️ BEHAVIOUR CHANGE WHEN ON: a caller naming `US` stops seeing the SGD rows filed under the
// US partition -- which is correct (a US buyer was never meant to see SGD prices), and is why
// the flip needs the partner told first.
//
// Flag: FIND_PRODUCTS_BUYER_MARKET=on (default off). Read per call.

const { parseMarketList, marketsForRequest, servedMarkets } = require('./servedMarkets');
const { currencyForBuyerRegion } = require('../auroraBff/buyerRegion');

const FLAG = 'FIND_PRODUCTS_BUYER_MARKET';

function isEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env[FLAG] || '').trim());
}

/**
 * THE CURRENCY EVERY SERVED ROW MUST BE PRICED IN -- or null, which means serve nothing.
 *
 * Peng 2026-09-26: a result priced in another currency is a wrong result and must never reach
 * the agent frontend. Measured on prod over the 7 days before this change: of the market-less
 * find_products_multi pages, 24 were SGD-only and 13 mixed SGD+USD -- the SGD seeds are filed
 * under the 'US' partition (see the top of this file), so binding ['US'] cannot keep them out.
 *
 * The rule is the backend's (#2389, external_seed_search.fetch_external_seed_rows), spelled once
 * here for this door:
 *   - no market (absent, empty, whitespace)  -> the deployment's default market, servedMarkets()[0]
 *     -- the market `markets[0]` already names, US in prod (#2389's DEFAULT_SEED_SERVING_MARKET) --
 *     so USD
 *   - exactly one market with a known currency -> that currency (SG -> SGD, JP -> JPY)
 *   - anything else the caller wrote (an unpriced code 'ZZ'/'DE', a locale 'en-US', two markets
 *     'US,SG') -> null: nothing can be shown to be priced for that buyer, so nothing is served.
 *
 * Unlike the partition widening below, this is NOT behind FIND_PRODUCTS_BUYER_MARKET: which
 * partitions a lane reads is a rollout choice, but a wrong-currency page is wrong either way.
 * It never infers a market from a currency, and a caller's `currency` does not override it.
 */
function resolveServingCurrency(requested, env = process.env) {
  const named = parseMarketList(requested, null);
  if (named.length === 1) return currencyForBuyerRegion(named[0]) || null;
  // Two markets ('US,SG') or text that is no market ('en-US') is null. Only silence is the default.
  const written = Array.isArray(requested) ? requested.join(',') : (requested ? String(requested) : '');
  return written.trim() ? null : (currencyForBuyerRegion(servedMarkets(env)[0]) || null);
}

/**
 * What one request binds. `requested` is the door's own raw value (`search.market ||
 * metadata.market`), passed through unchanged -- this function applies the door's parsing,
 * it never re-derives the door's precedence.
 *
 * Returns:
 *   markets        the partitions the lanes bind (always non-empty; the served list first,
 *                  so `markets[0]` is still a lane market)
 *   buyerMarket    the single named market, when it was read as a buyer market; else null
 *   buyerCurrency  that market's currency; else null
 *   servingCurrency  the currency every served row must carry, flag or no flag -- see
 *                  resolveServingCurrency; null means serve nothing
 *
 * With the flag off -- or when the request names no market, several markets, or one this
 * module cannot price -- `markets` is exactly `marketsForRequest(requested)` and `buyerMarket`
 * / `buyerCurrency` are null. `servingCurrency` is resolved either way.
 */
function resolveBuyerMarketScope(requested, env = process.env) {
  const servingCurrency = resolveServingCurrency(requested, env);
  const unchanged = { markets: marketsForRequest(requested, env), buyerMarket: null, buyerCurrency: null, servingCurrency };
  if (!isEnabled(env)) return unchanged;
  const named = parseMarketList(requested, null);
  if (named.length !== 1) return unchanged;
  const buyerCurrency = currencyForBuyerRegion(named[0]);
  if (!buyerCurrency) return unchanged;
  const served = servedMarkets(env);
  const markets = served.includes(named[0]) ? served : [...served, named[0]];
  return { markets, buyerMarket: named[0], buyerCurrency, servingCurrency };
}

// A budget's unit and the currency of the offers shown to a buyer are separate
// choices. The rule-based parser reports a currency only when the query itself
// names one (including a bare '$', which it has long treated as USD). The intent
// resolver can stamp USD on an unqualified budget, so its currency alone cannot
// establish that the shopper asked for dollars.
function resolveBuyerBudgetConstraint({ constraint, buyerCurrency, callerCurrency, queryCurrency }) {
  if (!constraint || !buyerCurrency) return constraint;
  return {
    ...constraint,
    currency: queryCurrency || callerCurrency || buyerCurrency,
  };
}

module.exports = {
  FLAG,
  isEnabled,
  resolveBuyerMarketScope,
  resolveServingCurrency,
  resolveBuyerBudgetConstraint,
};
