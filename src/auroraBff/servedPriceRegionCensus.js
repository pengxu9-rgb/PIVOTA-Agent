'use strict';

// ADR-024's TRIPWIRE: a per-region census of the prices we ACTUALLY SERVED.
//
// The decision owner resolved the FX question by declining the ranker and asking for a measurement
// instead (ADR-024, "Resolved questions", 2026-08-21):
//
//   "FX-ranking -- DECIDED: not built ... With pricing-region gating and no fallback, every served
//    pool is single-currency by construction, so ranking never needs a rate. The residual case -- a
//    foreign-currency row inside a region's pool -- is mislabeled supply (see the 433-EUR-as-US
//    anomaly), an ingestion defect for the Phase 0 invariant, not a ranking problem to absorb.
//    TRIPWIRE instead of a ranker: count `unknown`-classified rows actually served, per region;
//    materially nonzero means clean data, not convert it."
//
// This module is that count, and nothing else. It is the enforcement arm of "no FX-ranking": the only
// honest way to hold the no-conversion line is to be able to answer, per region and per day, HOW OFTEN
// a buyer was shown a price we could not evaluate in their own currency. Without the number, "every
// served pool is single-currency by construction" is a belief; with it, it is a claim that can be
// falsified by our own telemetry.
//
// WHAT A NONZERO `served_priced_foreign` MEANS -- the ADR's reading, not a new one. It is MISLABELED
// SUPPLY: an ingestion defect, of the same family as the 433 EUR offers stamped `market='US'` by one
// `universal_product_sync` merchant (23% of all servable non-USD offers, ADR-024 Phase 0 item 2). The
// correct response is to CLEAN THE DATA -- quarantine or reclassify the rows, fix the writer -- and
// NEVER to convert the price into the buyer's currency. A converted price is not a price any merchant
// will honour at checkout, and this repo has already shipped the comparison-across-units defect four
// times in four layers (ADR-024, "The recurring failure mode this ADR must not feed"). The census
// exists so that the fifth time is caught by a dashboard instead of by a buyer.
//
// ZERO INFLUENCE. This is a READ-ONLY census taken at the point of serving, after selection, after
// ranking, after the guardrail. It never reorders, never filters, never rewrites a row, and never
// reads back into any decision. Nothing here may become an input to what we serve -- the moment a
// count changes an answer, the tripwire has become the ranker the ADR declined.

const { readRecoCandidatePriceForCeiling } = require('./recoPriceCeiling');
const { currencyForBuyerRegion } = require('./buyerRegion');

// The three buckets, and the exact meta keys they are reported under. ONE list, because the route
// stamps these into `recommendation_meta` and buildRecoRequestedEventData projects them back out of
// it -- two sites that must agree on spelling or the event silently carries nothing.
const SERVED_PRICE_REGION_CENSUS_KEYS = Object.freeze({
  priced_in_region: 'served_priced_in_region',
  priced_foreign: 'served_priced_foreign',
  unpriced: 'served_unpriced',
});

const SERVED_PRICE_REGION_CENSUS_META_KEYS = Object.freeze(Object.values(SERVED_PRICE_REGION_CENSUS_KEYS));

// A currency is THREE ASCII LETTERS here -- a shape test, deliberately NOT the ceiling lane's
// 14-currency allowlist.
//
// The two questions are different. The ceiling asks "can I COMPARE against this?", so an unrecognized
// unit must read as no-currency and refuse a verdict. The census asks "was this row priced in a unit
// that is not the buyer's?", and for that an unrecognized-but-well-formed code is the LOUDEST possible
// answer: an INR row served to a US buyer is exactly the mislabeled supply the tripwire is for, and
// scoring it `unpriced` would file the repo's own founding defect (Mintree INR, ADR-024 failure #1)
// under "no price at all".
function normalizeCensusCurrencyShape(value) {
  const token = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(token) ? token : '';
}

/**
 * 'priced_in_region' | 'priced_foreign' | 'unpriced' for ONE served row.
 *
 * The price is read with `readRecoCandidatePriceForCeiling` -- the reader the serving path already
 * uses, and the one an existing test pins against `extractCatalogCandidatePrice` so the two cannot
 * drift about what a row costs. It reads exactly what `mergeRecoPlanWithGroundedCandidate` emits: the
 * row's `price` object (`{amount, currency}`) and its sibling `currency` scalar. Re-deriving a price
 * here would be a second reader to keep in sync, which is how #2065 happened.
 *
 * `unpriced` covers "no price at all" AND "an amount with no readable unit", because neither can be
 * evaluated in the buyer's currency and neither is EVIDENCE of foreign supply. Keeping the second case
 * out of `priced_foreign` is what stops the tripwire from crying wolf about our own missing metadata.
 */
function classifyServedRowPriceForRegion(row, region) {
  const price = readRecoCandidatePriceForCeiling(row, { normalizeCurrency: normalizeCensusCurrencyShape });
  const amount = price ? Number(price.amount) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return 'unpriced';
  const currency = normalizeCensusCurrencyShape(price.currency);
  if (!currency) return 'unpriced';
  // A region we do not price for has NO expected currency (buyerRegion.js returns '' rather than
  // fabricating USD). Every priced row is then foreign, and that is the honest reading rather than a
  // pedantic one: ADR-024 resolved the thin-region fallback as NONE -- "a region with no priced offers
  // gets an honest empty answer, not foreign-priced filler with a marker" -- so serving priced rows
  // into such a region is precisely the fallback the ADR forbids, and the tripwire should say so.
  const expected = normalizeCensusCurrencyShape(currencyForBuyerRegion(region));
  if (!expected) return 'priced_foreign';
  return currency === expected ? 'priced_in_region' : 'priced_foreign';
}

/**
 * The census over the FINAL served rows: `{served_priced_in_region, served_priced_foreign,
 * served_unpriced}`.
 *
 * Always all three, always integers, even for an empty answer -- an absent `served_priced_foreign` and
 * a zero one are the same dashboard reading otherwise, and "we served nothing foreign" is the whole
 * claim being measured. The three sum to the number of rows served, so each count carries its own
 * denominator.
 *
 * `rows` is READ, never touched: no sort, no map that is kept, no property written. A caller may pass
 * the live response array.
 */
function buildServedPriceRegionCensus(rows, region) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = { priced_in_region: 0, priced_foreign: 0, unpriced: 0 };
  for (const row of list) {
    counts[classifyServedRowPriceForRegion(row, region)] += 1;
  }
  return {
    [SERVED_PRICE_REGION_CENSUS_KEYS.priced_in_region]: counts.priced_in_region,
    [SERVED_PRICE_REGION_CENSUS_KEYS.priced_foreign]: counts.priced_foreign,
    [SERVED_PRICE_REGION_CENSUS_KEYS.unpriced]: counts.unpriced,
  };
}

/**
 * The census fields to project from a `recommendation_meta` into the reco_requested event, or `{}`.
 *
 * ALL THREE OR NONE. A lane that does not stamp the census (chat, the agent-signals door) emits no
 * census fields at all and its events stay byte-identical -- the same rule buyer_region/region_source
 * follow. All-or-none rather than field-by-field because a `served_priced_foreign` arriving without
 * its two siblings is a numerator with no denominator, and a partial census on a dashboard reads as a
 * rate it is not.
 */
function pickServedPriceRegionCensusEventFields(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const key of SERVED_PRICE_REGION_CENSUS_META_KEYS) {
    const raw = meta[key];
    // `typeof raw === 'number'` FIRST, and not Number(raw): `Number(null)`, `Number('')`, `Number([])`
    // and `Number(false)` are all a finite, integral 0, so a coercing check would read a MISSING census
    // as a census reporting zero foreign rows -- the exact shape of the bug that shipped a priceless
    // product as free in #2069. A census that was never taken must project nothing.
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return {};
    out[key] = raw;
  }
  return out;
}

module.exports = {
  SERVED_PRICE_REGION_CENSUS_KEYS,
  SERVED_PRICE_REGION_CENSUS_META_KEYS,
  normalizeCensusCurrencyShape,
  classifyServedRowPriceForRegion,
  buildServedPriceRegionCensus,
  pickServedPriceRegionCensusEventFields,
};
