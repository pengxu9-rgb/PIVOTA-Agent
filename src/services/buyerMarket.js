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
//     EXACTLY as it was: bound as a partition. That is today's behaviour, not a new answer.
//   - A caller's explicit currency still wins over the buyer's.
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
 * What one request binds. `requested` is the door's own raw value (`search.market ||
 * metadata.market`), passed through unchanged -- this function applies the door's parsing,
 * it never re-derives the door's precedence.
 *
 * Returns:
 *   markets        the partitions the lanes bind (always non-empty; the served list first,
 *                  so `markets[0]` is still a lane market)
 *   buyerMarket    the single named market, when it was read as a buyer market; else null
 *   buyerCurrency  that market's currency; else null
 *
 * With the flag off -- or when the request names no market, several markets, or one this
 * module cannot price -- `markets` is exactly `marketsForRequest(requested)` and the other
 * two are null, so the SQL is the SQL that shipped before.
 */
function resolveBuyerMarketScope(requested, env = process.env) {
  const unchanged = { markets: marketsForRequest(requested, env), buyerMarket: null, buyerCurrency: null };
  if (!isEnabled(env)) return unchanged;
  const named = parseMarketList(requested, null);
  if (named.length !== 1) return unchanged;
  const buyerCurrency = currencyForBuyerRegion(named[0]);
  if (!buyerCurrency) return unchanged;
  const served = servedMarkets(env);
  const markets = served.includes(named[0]) ? served : [...served, named[0]];
  return { markets, buyerMarket: named[0], buyerCurrency };
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
  resolveBuyerBudgetConstraint,
};
