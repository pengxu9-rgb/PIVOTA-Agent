'use strict';

// ADR-024 Phase 1: buyer_region is a REQUEST dimension, not a global constant.
//
// Today the whole lane is US by construction -- the stored serving verdict bakes a US-offer test at
// index-build time, the price ceiling stamps 'USD' as a literal, and the recall pool cache has no
// region dimension at all. None of that is wrong for today's traffic; what is wrong is that it is
// INVISIBLE. As Minds and other agentic partners route buyers from many regions through one endpoint,
// the silent US default becomes a permanent wrong-region path that nothing measures.
//
// So this module does two small things, and refuses a third:
//   1. It RESOLVES a caller-supplied region to `{ region, regionSource }`, where regionSource is
//      'explicit' when the caller actually said so and 'defaulted' when we filled in 'US'. That pair
//      is the telemetry dimension the ADR asks for: the default must be a MEASURED transition.
//   2. It maps region -> the currency that region is priced in, in ONE place, so the ceiling path
//      stops writing 'USD' as a literal.
//   3. It NEVER infers region from currency, from language, or from an Accept-Language header. The
//      resolved buyer_region is the only source. Inferring the other way is how the repo has shipped
//      the same currency defect four times in four layers (ADR-024, "the recurring failure mode").
//
// INVALID INPUT IS ABSENT INPUT, NOT AN ERROR. A malformed `buyer_region` degrades to the default and
// reports regionSource 'defaulted' -- it must never 400 a request that would otherwise have succeeded,
// because a partner rolling out a new field would then take an outage for a typo. The rejection is
// observable in telemetry instead (regionSource stays 'defaulted' while the caller believes it sent
// one), which is the signal an operator can actually act on.

const DEFAULT_BUYER_REGION = 'US';
const BUYER_REGION_SOURCE_EXPLICIT = 'explicit';
const BUYER_REGION_SOURCE_DEFAULTED = 'defaulted';

// Region -> the currency an offer for that region is priced in. Deliberately the ADR's Phase 1 set:
// every currency here is already inside the decision layer's 14-currency allowlist
// (RECO_PRICE_CEILING_KNOWN_CURRENCIES), and every one of them is held by real servable supply
// measured on prod 2026-08-21 (GBP 780, EUR 608, JPY 333, AUD 26, SEK 25, KRW 23, HKD 22, SGD 14,
// CAD 12). A region NOT in this map resolves to no currency at all -- see currencyForBuyerRegion.
const BUYER_REGION_CURRENCY = Object.freeze({
  US: 'USD',
  GB: 'GBP',
  JP: 'JPY',
  FR: 'EUR',
  AU: 'AUD',
  SE: 'SEK',
  KR: 'KRW',
  HK: 'HKD',
  SG: 'SGD',
  CA: 'CAD',
});

/**
 * ISO-3166-1 alpha-2, or '' when the input is not one.
 *
 * An ALLOWLIST on SHAPE: exactly two ASCII letters after trimming, upcased. 'gb' normalizes to 'GB'
 * (case is presentation, not meaning), but 'usa', '1X', 'G' and 'GBR' are NOT two ASCII letters and so
 * are not a region -- they return '' and the caller defaults. Whitespace INSIDE the token ('g b') is
 * not trimmable and is rejected for the same reason; only leading/trailing whitespace is forgiven, so
 * 'gb ' normalizes to 'GB'.
 *
 * Shape only: this does not assert the code is an ASSIGNED country. An unassigned-but-well-formed code
 * ('ZZ') passes here and then simply has no currency, which is the honest outcome -- we know what the
 * caller said, and we know we cannot price for it.
 */
function normalizeBuyerRegion(raw) {
  if (typeof raw !== 'string') return '';
  const token = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(token) ? token : '';
}

/**
 * `{ region, regionSource }`. Never throws, never returns an empty region.
 *
 * regionSource is the load-bearing half. 'defaulted' says "nobody told us, we assumed US" -- and an
 * operator watching that dimension can see, per partner, whether the assumption is still safe.
 */
function resolveBuyerRegion(raw) {
  const region = normalizeBuyerRegion(raw);
  if (!region) {
    return { region: DEFAULT_BUYER_REGION, regionSource: BUYER_REGION_SOURCE_DEFAULTED };
  }
  return { region, regionSource: BUYER_REGION_SOURCE_EXPLICIT };
}

/**
 * True when the caller SENT something for buyer_region that we could not read.
 *
 * Distinct from "absent": absent is the steady state and is not worth a log line, while a present but
 * unreadable value is a partner integration bug that would otherwise be completely silent (the request
 * succeeds, in the wrong region, forever).
 */
function isRejectedBuyerRegionInput(raw) {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return normalizeBuyerRegion(raw) === '';
}

/**
 * The currency a region prices in, or '' when we do not model that region.
 *
 * '' rather than a USD fallback ON PURPOSE: stamping USD on a region we have never priced is exactly
 * the fabrication ADR-024 commitment 5 refuses. Callers decide what "we cannot price this region"
 * means for them -- the ceiling path below treats it as "keep today's USD behavior", because a ceiling
 * that silently changes unit is worse than one that stays where it was.
 */
function currencyForBuyerRegion(region) {
  const normalized = normalizeBuyerRegion(region);
  if (!normalized) return '';
  return BUYER_REGION_CURRENCY[normalized] || '';
}

/**
 * The region carried by a request context, defaulted.
 *
 * `ctx` is the object every reco call site already threads (it is how `lang` reaches recall), so the
 * region rides the same wire. A ctx with no region at all yields 'US' -- which is precisely today's
 * behavior, so a call path this PR did not touch cannot change what it serves.
 */
function buyerRegionFromContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return DEFAULT_BUYER_REGION;
  return normalizeBuyerRegion(ctx.buyer_region) || DEFAULT_BUYER_REGION;
}

module.exports = {
  DEFAULT_BUYER_REGION,
  BUYER_REGION_SOURCE_EXPLICIT,
  BUYER_REGION_SOURCE_DEFAULTED,
  BUYER_REGION_CURRENCY,
  normalizeBuyerRegion,
  resolveBuyerRegion,
  isRejectedBuyerRegionInput,
  currencyForBuyerRegion,
  buyerRegionFromContext,
};
