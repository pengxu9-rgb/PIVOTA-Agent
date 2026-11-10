'use strict';

/*
 * THE MARKET OF A REQUEST THAT NAMES NONE (decision D-10, 2026-11-08).
 *
 * WHY. Before this, a request with no market was answered in two contradictory ways at once: discovery
 * (search, alternatives) silently served the US partition and USD, while the live merchant reads and the
 * purchasability gate refused to run ("no market: nothing is read"). A partner that sent no market was
 * therefore shown US prices it was never told were US, and those prices were never checked with the merchant.
 *
 * THE RULE, ONE PLACE. A request that names no market is answered AS US, and the answer says so:
 *   - the market is resolved to US here, and US is what goes downstream (so live reads and the gate run as US);
 *   - every answer that assumed it carries `market_assumed` (marketAssumedLabel below).
 * A request that names a market is passed through exactly as it arrived: a valid one keeps its answer
 * byte-for-byte, and an invalid one ('USA', 'en-US', 'ZZ') is refused or ignored exactly as it was before.
 *
 * "NAMES NO MARKET" means absent, null or a blank string. Nothing else: a market is never inferred from a
 * currency, a language, a header or a buyer address.
 */

const ASSUMED_MARKET = 'US';

const MARKET_ASSUMED_MESSAGE =
  'No market was named in this request, so it was answered for a US buyer: prices, currency, stock and ' +
  'checkout links are for the US. Send `market` (ISO 3166-1 alpha-2) to choose another.';

/** True when the raw value names no market at all (absent, null, or a blank string). */
function marketIsUnnamed(raw) {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

/**
 * The market a request is answered for.
 * @returns {{ market: any, assumed: boolean }} `market` is US when assumed, else the raw value UNCHANGED (the
 *   caller's own parsing then applies to it exactly as before).
 */
function resolveRequestMarket(raw) {
  if (marketIsUnnamed(raw)) return { market: ASSUMED_MARKET, assumed: true };
  return { market: raw, assumed: false };
}

/** The member an answer carries when its market was assumed. A fresh object per call (callers may mutate). */
function marketAssumedLabel() {
  return { code: ASSUMED_MARKET, message: MARKET_ASSUMED_MESSAGE };
}

module.exports = {
  ASSUMED_MARKET,
  MARKET_ASSUMED_MESSAGE,
  marketIsUnnamed,
  resolveRequestMarket,
  marketAssumedLabel,
};
