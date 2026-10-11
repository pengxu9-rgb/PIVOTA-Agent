'use strict';

// A NON-DEFAULT BUYER MARKET SEES ITS OWN-CURRENCY OFFERS ON EVERY SURFACE, NOT JUST SEARCH.
//
// A product can carry offers in several served currencies: today pivota-backend's retailer_ingest
// shopify_markets writes USD siblings (market 'US') beside a store's non-USD base offers, and
// pivota-backend #2553 adds SGD siblings (market 'SG') beside USD ones; a retailer's SGD-only
// listing can also sit beside a US one. Canonical search (canonicalCatalogSearch offerScope.currency, fed by
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
// to before. BUYER_MARKET_OFFER_SCOPE_MARKETS (default 'SG') lists the buyer markets it serves: a
// market merely priceable (JP, AU -- acquired, never served) gets no scope, so a stored foreign
// acquisition offer is never surfaced to that buyer.
//
// ROLLOUT: flip it only AFTER pivota-backend's migration 263, the AGENT_PDP_VIEW_MARKET_PRICES
// writes and the market_prices backfill, and watch the SG discovery page size when you do. A
// missing, NULL or stale summary falls back to the legacy columns per row, but the flag also
// changes which rows the strict readers return and when the buyer-market fallback pool is used
// (applyBuyerMarketFallback: a scoped page fewer than a page of priced rows is topped up from
// the pool rather than replaced), so the page an SG buyer sees does change at the flip.

const { resolveServingCurrency } = require('./buyerMarket');
const { parseMarketList } = require('./servedMarkets');

const FLAG = 'BUYER_MARKET_OFFER_SCOPE';
const MARKETS_ENV = 'BUYER_MARKET_OFFER_SCOPE_MARKETS';
const DEFAULT_SCOPE_MARKETS = 'SG';
// The summary version this reader understands (pivota-backend build_market_prices).
const MARKET_PRICES_VERSION = 1;

function isBuyerMarketOfferScopeEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env[FLAG] || '').trim());
}

/** The buyer markets the scope serves (BUYER_MARKET_OFFER_SCOPE_MARKETS, default SG). */
function scopeMarkets(env = process.env) {
  const raw = env[MARKETS_ENV] == null ? DEFAULT_SCOPE_MARKETS : env[MARKETS_ENV];
  return parseMarketList(raw, null);
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
  if (!scopeMarkets(env).includes(market)) return null;
  const currency = resolveServingCurrency(market, env);
  const deploymentCurrency = resolveServingCurrency('', env);
  if (!currency || currency === deploymentCurrency) return null;
  // Both values reach SQL as literals on some surfaces: allow only well-formed codes.
  if (!/^[A-Z]{2}$/.test(market) || !/^[A-Z]{3}$/.test(currency)) return null;
  return { market, currency };
}

/**
 * The serving currency a surface scopes offers to, for surfaces whose old rule ran for every
 * buyer (recommendations, the PDP member pick). Null when the flag is off, and for a currency
 * that is neither the deployment's nor a scope market's (a JP buyer's JPY: acquisition offers in
 * it are stored, never served).
 */
function resolveOfferScopeCurrency(servingCurrency, env = process.env) {
  if (!isBuyerMarketOfferScopeEnabled(env)) return null;
  const currency = String(servingCurrency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const allowed = new Set([resolveServingCurrency('', env), ...scopeMarkets(env).map((m) => resolveServingCurrency(m, env))]);
  return allowed.has(currency) ? currency : null;
}

/**
 * The SELECT expression for the summary: the column only while it was written by the write that
 * set refreshed_at (pivota-backend market_prices_fresh_sql), else NULL. A later write without the
 * summary -- a writer with the backend flag off, an old image, a repair script -- moves
 * refreshed_at and so retires it; the reader then serves the legacy columns.
 */
function marketPricesFreshSql(alias = 'apv') {
  const a = alias ? `${alias}.` : '';
  return `CASE WHEN ${a}market_prices_refreshed_at = ${a}refreshed_at AND ${a}market_prices->>'version' = '${MARKET_PRICES_VERSION}' THEN ${a}market_prices END`;
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
 * Reads the per-currency summary (pivota-backend migration 263, selected through
 * marketPricesFreshSql): {version: 1, currencies: {SGD: {price_min, price_max, offer_count,
 * offers}}}. When the scope's currency has an entry, the row's currency / price_min / price_max /
 * offer_count / offers become that currency's -- the same values the backend PDP route serves
 * the same buyer. Otherwise -- no scope, NULL (stale, not backfilled), an absent column, another
 * version, no entry -- the row is returned as is, and the invoke door's serving-currency guard
 * treats it exactly as it did before.
 */
function applyMarketPricesToIndexRow(row, scope) {
  if (!scope || !row || typeof row !== 'object') return row;
  const marketPrices = parseJsonObject(row.market_prices);
  if (!marketPrices || marketPrices.version !== MARKET_PRICES_VERSION) return row;
  const currencies = marketPrices.currencies && typeof marketPrices.currencies === 'object' ? marketPrices.currencies : null;
  const entry = currencies ? currencies[scope.currency] : null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return row;
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
  MARKETS_ENV,
  marketPricesFreshSql,
  isBuyerMarketOfferScopeEnabled,
  resolveBuyerMarketOfferScope,
  resolveOfferScopeCurrency,
  applyMarketPricesToIndexRow,
  isMarketPricesColumnKnownMissing,
  isMissingMarketPricesColumnError,
  markMarketPricesColumnMissing,
  resetMarketPricesColumnState,
};
