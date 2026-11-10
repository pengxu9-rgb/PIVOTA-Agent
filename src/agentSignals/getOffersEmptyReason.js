'use strict';

// WHY AN EMPTY get_offers ANSWER IS EMPTY (GET_OFFERS_EMPTY_REASON, default off; the `/mcp` door only).
//
// offers.resolve knows why it returned no offer (its `metadata.sources`, `mapping.candidates` and
// `metadata.buyer_currency_filtered`); the gateway kept only the offers, so a partner saw
// `offer_count: 0` and nothing else, and could not tell "no stored offer" from "withheld" from "our lookup
// failed". This module turns what the backend said into ONE token from a fixed vocabulary.
//
// NEVER FREE TEXT: the backend's fields are only ever COMPARED against literals here. No string the
// backend sent is copied into an answer, so an error message, a seed id or a blocker we do not know
// cannot reach a partner through this path.
//
// THE DOOR. The reason is added only while a call runs inside `runOnEmptyReasonDoor`, which only the
// `/mcp` door's view of the tool surface opens (mcp-server/src/getOffersEmptyReasonDoor.js), and only
// with the flag on. Every other caller of get_offers (the UCP door, the strict invoke route, internal
// reads) never opens it and is answered exactly as before.

const { AsyncLocalStorage } = require('node:async_hooks');

const door = new AsyncLocalStorage();

/** Run `fn` as a get_offers call of the door that names empty answers. */
function runOnEmptyReasonDoor(fn) {
  return door.run(true, fn);
}

function emptyReasonDoorActive() {
  return door.getStore() === true;
}

// The whole vocabulary this module can put in `metadata.reason`. The four reasons makeGetOffers already
// gives (variant_not_offered, no_offer_in_market_currency, market_not_priced, offers_source_unavailable)
// are its own and unchanged.
const EMPTY_REASONS = Object.freeze({
  // No stored offer is linked to this product id.
  NO_SEED: 'no_seed_for_product',
  // A stored offer exists but is priced or filed for another market.
  NOT_IN_MARKET: 'seed_not_in_market',
  // The store's own live answer no longer lists the item.
  OUT_OF_STOCK: 'seed_out_of_stock',
  // A stored offer exists, its facts are too old to serve, and the store could not confirm it just now.
  NEEDS_LIVE_VERIFICATION: 'offer_needs_live_verification',
  // A stored offer exists and is withheld by a serving rule (its page is gone, its link cannot be issued).
  NOT_SERVABLE: 'seed_not_servable',
  // Our own lookup failed or timed out: nothing is known about the product's offers.
  LOOKUP_UNAVAILABLE: 'offer_lookup_unavailable',
  // Empty, and the backend named nothing we can classify. The same token the partner-door view uses.
  NO_OFFER: 'no_offer_for_product',
});
const EMPTY_REASON_SET = new Set(Object.values(EMPTY_REASONS));

// offers.resolve's freshness blockers (pivota-backend `_FRESHNESS_ONLY_LIVE_VERIFICATION_REASONS`) and
// its market blockers (external_seed_audit).
const FRESHNESS_BLOCKERS = new Set(['stale_snapshot', 'destination_stale', 'destination_never_verified']);
const MARKET_BLOCKERS = new Set(['locale_market_mismatch', 'price_currency_mismatch']);
// A live read that may answer differently on a second try (services/ucpLiveOfferRead STATUS).
const RETRIABLE_LIVE_STATUSES = new Set(['timeout', 'error']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);

/**
 * The reason an offers.resolve answer with NO offer is empty: one of EMPTY_REASONS, never null.
 * Pure. Reads `metadata.sources[].status|row_count`, `mapping.candidates[].kind|reason|blockers` and
 * whether `metadata.buyer_currency_filtered` has a key; compares, never copies.
 */
function emptyReasonFromOffersResolve(res) {
  const metadata = isObj(res) && isObj(res.metadata) ? res.metadata : {};
  const sources = list(metadata.sources);
  const candidates = list(isObj(res) && isObj(res.mapping) ? res.mapping.candidates : null).filter(
    (c) => c.kind === 'external_seed',
  );
  if (sources.some((s) => s.status === 'error')) return EMPTY_REASONS.LOOKUP_UNAVAILABLE;
  const held = candidates.filter((c) => c.reason === 'external_seed_requires_live_verification');
  const blockersOf = (c) => (Array.isArray(c.blockers) ? c.blockers : []);
  const freshnessOnly = (c) => blockersOf(c).length > 0 && blockersOf(c).every((b) => FRESHNESS_BLOCKERS.has(b));
  if (held.some(freshnessOnly)) return EMPTY_REASONS.NEEDS_LIVE_VERIFICATION;
  const currencyFiltered = isObj(metadata.buyer_currency_filtered) && Object.keys(metadata.buyer_currency_filtered).length > 0;
  if (currencyFiltered || held.some((c) => blockersOf(c).some((b) => MARKET_BLOCKERS.has(b)))) {
    return EMPTY_REASONS.NOT_IN_MARKET;
  }
  const seedRowsRead = sources.some(
    (s) => typeof s.source === 'string' && s.source.startsWith('external_product_seeds') && Number(s.row_count) > 0,
  );
  if (held.length > 0 || seedRowsRead || candidates.some((c) => c.reason === 'filtered_external_seed')) {
    return EMPTY_REASONS.NOT_SERVABLE;
  }
  // Only a lookup that RAN and found no row says there is no stored offer.
  const seedLookupRan = sources.some((s) => typeof s.source === 'string' && s.source.startsWith('external_product_seeds'));
  return seedLookupRan ? EMPTY_REASONS.NO_SEED : EMPTY_REASONS.NO_OFFER;
}

/**
 * The reason and retry hint for an EMPTY get_offers answer on the reason door.
 *   current      the reason makeGetOffers already chose (or null)
 *   backend      the token emptyReasonFromOffersResolve produced for the fetch (or anything else)
 *   unverified   the flagged offers the live-verification filter withheld
 * Returns { reason, retriable }: `reason` is always a fixed token; `retriable` says whether the same
 * call may answer differently shortly.
 */
function decideEmptyReason({ current = null, backend = null, unverified = [] } = {}) {
  if (current === EMPTY_REASONS.NEEDS_LIVE_VERIFICATION) {
    const statuses = (Array.isArray(unverified) ? unverified : []).map((o) =>
      isObj(o) && isObj(o.live_read) && typeof o.live_read.status === 'string' ? o.live_read.status : '',
    );
    if (statuses.length > 0 && statuses.every((s) => s === 'variant_gone')) {
      return { reason: EMPTY_REASONS.OUT_OF_STOCK, retriable: false };
    }
    return { reason: current, retriable: statuses.some((s) => RETRIABLE_LIVE_STATUSES.has(s)) };
  }
  if (current) return { reason: current, retriable: false };
  const reason = typeof backend === 'string' && EMPTY_REASON_SET.has(backend) ? backend : EMPTY_REASONS.NO_OFFER;
  return { reason, retriable: reason === EMPTY_REASONS.LOOKUP_UNAVAILABLE };
}

module.exports = {
  EMPTY_REASONS,
  runOnEmptyReasonDoor,
  emptyReasonDoorActive,
  emptyReasonFromOffersResolve,
  decideEmptyReason,
};
