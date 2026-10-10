'use strict';

// A NON-DEFAULT BUYER MARKET SEES ITS OWN-CURRENCY OFFERS ON EVERY SURFACE, NOT JUST SEARCH.
//
// A product can carry offers in several currencies: a store's base USD offers and their SGD
// siblings (pivota-backend retailer_ingest shopify_markets, market 'SG'), or a retailer's SGD-only
// listing beside a US one. Canonical search (canonicalCatalogSearch offerScope.currency, fed by
// server.js servedOfferCurrency) already scopes offers to the buyer's currency. The other surfaces
// did not: the discovery feed served agent_pdp_view's single modal currency (USD wins a tie), the
// strict-public feed hard-coded market 'US' / currency 'USD', recommendations dropped any product
// with an offer in a second currency, and the PDP member join picked one catalog_offers row per
// member without looking at currency. In every case an SG buyer lost the product, because the
// invoke door's serving-currency guard then (rightly) dropped the USD card.
//
// THE RULE, mirrored from canonical search: the buyer's market decides ONE currency
// (buyerMarket.resolveServingCurrency); offers in that currency are the ones shown, priced and
// counted; nothing is converted; nothing is inferred from offers.market (a DEFAULT 'US' most
// writers never set -- pivota-backend services/region_pricing).
//
// Flag: BUYER_MARKET_OFFER_SCOPE (default off), read per call. Off = every surface byte-identical
// to before. Roll out AFTER pivota-backend's migration 263 + AGENT_PDP_VIEW_MARKET_PRICES writes +
// the market_prices backfill: the discovery feed reads agent_pdp_view.market_prices and falls back
// to the legacy columns while it is NULL or absent, so an early flip is safe, just not yet useful
// there.

const { resolveServingCurrency } = require('./buyerMarket');
const { parseMarketList } = require('./servedMarkets');

const FLAG = 'BUYER_MARKET_OFFER_SCOPE';

function isBuyerMarketOfferScopeEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env[FLAG] || '').trim());
}

/**
 * The market + currency a surface must scope offers to, or null for "unchanged".
 *
 * Null when the flag is off, when the request names no single market, when the market cannot be
 * priced, and -- deliberately -- when it is priced in the deployment's own currency (a US buyer on
 * the US deployment): that buyer keeps today's results byte for byte. Only a market priced in
 * ANOTHER currency (SG -> SGD) gets a scope.
 */
function resolveBuyerMarketOfferScope(buyerMarket, env = process.env) {
  if (!isBuyerMarketOfferScopeEnabled(env)) return null;
  const named = parseMarketList(buyerMarket, null);
  if (named.length !== 1) return null;
  const market = String(named[0]).trim().toUpperCase();
  const currency = resolveServingCurrency(market, env);
  const deploymentCurrency = resolveServingCurrency('', env);
  if (!currency || currency === deploymentCurrency) return null;
  // Both values reach SQL as literals on some surfaces: allow only well-formed codes.
  if (!/^[A-Z]{2}$/.test(market) || !/^[A-Z]{3}$/.test(currency)) return null;
  return { market, currency };
}

/**
 * The serving currency a surface scopes offers to, for surfaces whose old rule ran for every
 * buyer (recommendations, the PDP member pick). Null when the flag is off.
 */
function resolveOfferScopeCurrency(servingCurrency, env = process.env) {
  if (!isBuyerMarketOfferScopeEnabled(env)) return null;
  const currency = String(servingCurrency || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * One agent_pdp_view row as the scoped buyer sees it.
 *
 * Reads `row.market_prices[scope.market]` (pivota-backend migration 263:
 * {currency, price_min, price_max, offer_count, offers}). When the entry exists and is priced in
 * the scope's currency, the row's currency / price_min / price_max / offer_count / offers become
 * that market's. Otherwise -- no scope, a NULL or absent column (not backfilled, not migrated),
 * no entry (not priced for that market) -- the row is returned as is, and the invoke door's
 * serving-currency guard treats it exactly as it did before.
 */
function applyMarketPricesToIndexRow(row, scope) {
  if (!scope || !row || typeof row !== 'object') return row;
  const marketPrices = parseJsonObject(row.market_prices);
  const entry = marketPrices ? marketPrices[scope.market] : null;
  if (!entry || typeof entry !== 'object') return row;
  if (String(entry.currency || '').trim().toUpperCase() !== scope.currency) return row;
  const offers = (Array.isArray(entry.offers) ? entry.offers : [])
    .filter((offer) => offer && String(offer.currency || '').trim().toUpperCase() === scope.currency);
  return {
    ...row,
    currency: scope.currency,
    price_min: entry.price_min ?? null,
    price_max: entry.price_max ?? null,
    offer_count: Number.isFinite(Number(entry.offer_count)) ? Number(entry.offer_count) : offers.length,
    offers,
  };
}

// FEATURE DETECTION for agent_pdp_view.market_prices. Numbered migrations do not self-apply in
// prod (pivota-backend's schema_guard adds the column on the backend's boot), and the gateway can
// be flipped first. A statement naming the column then fails with 42703; the caller re-runs its
// legacy statement and this remembers the absence for a while, so a missing column costs one
// failed statement per process per window, not one per request.
const MISSING_COLUMN_RETRY_MS = 10 * 60 * 1000;
let marketPricesColumnMissingUntil = 0;

function isMarketPricesColumnKnownMissing(now = Date.now()) {
  return now < marketPricesColumnMissingUntil;
}

function isMissingMarketPricesColumnError(err) {
  const message = String(err?.message || err || '');
  return (err?.code === '42703' || /column .* does not exist/i.test(message)) && message.includes('market_prices');
}

function markMarketPricesColumnMissing(now = Date.now()) {
  marketPricesColumnMissingUntil = now + MISSING_COLUMN_RETRY_MS;
}

function resetMarketPricesColumnState() {
  marketPricesColumnMissingUntil = 0;
}

module.exports = {
  FLAG,
  isBuyerMarketOfferScopeEnabled,
  resolveBuyerMarketOfferScope,
  resolveOfferScopeCurrency,
  applyMarketPricesToIndexRow,
  isMarketPricesColumnKnownMissing,
  isMissingMarketPricesColumnError,
  markMarketPricesColumnMissing,
  resetMarketPricesColumnState,
};
