'use strict';

/*
 * offersPriority.js — offer presentation order AND the per-offer commerce stamp.
 *
 * ---- THE MERCHANT-PURCHASABILITY GATE, PATH 3 OF 3 ---------------------------------------
 *
 * `enrichOfferCommerceMetadata` stamps `merchant_checkout_url` — a direct "check out
 * here" link — onto EVERY served offer, one layer earlier than the warm handoff and
 * without passing through it at all. A handoff URL is still a recommendation: a page
 * that sends a shopper to a checkout which cannot take their card wastes the same trip
 * whether we call it a purchase, a handoff or a link (docs/merchant-purchasability-gate.md
 * §8, the flowerbeauty.com incident).
 *
 * So the same switch (`MERCHANT_PURCHASABILITY_GATE_ENABLED`, default OFF) and the same
 * `shouldOfferPurchase` — the SAME process singleton and therefore the same bounded cache
 * the warm-handoff seam uses — decide whether that URL is stamped. When the backend is
 * enforcing and says `browse_only` for this merchant × market, the URL is NOT STAMPED.
 * The OFFER SURVIVES: browse/referral is exactly what is left, and dropping the row would
 * delete a result the shopper asked for to avoid a link they did not.
 *
 * ⚠️ THE DECISION IS TAKEN BEFORE THE URL IS BUILT, NOT AFTER. `resolveOfferPurchasability
 * Decisions` runs first and hands `annotateOffersWithCommerceMetadata` a set of declined
 * domains; `enrichOfferCommerceMetadata` then never constructs the `merchant_checkout_url`
 * key at all. Building it and stripping it afterwards would be one refactor away from
 * leaking it, and it is in the mutant sweep.
 *
 * ⚠️ THIS IS A BATCH, AND A BATCH IS WHY THE DOC CALLED IT A FOLLOW-UP. A page of offers
 * spans MANY merchants while the client is a per-merchant read, so three bounds apply and
 * all three are asserted:
 *   1. DEDUPE — N offers for the same merchant × market are ONE question (a `Set` of
 *      distinct domains here, plus the client's own ≤5-minute cache behind it).
 *   2. CONCURRENCY — at most `GATE_CONCURRENCY` reads in flight, so a page of 40 merchants
 *      is not 40 simultaneous sockets.
 *   3. A TOTAL WALL-CLOCK BUDGET — the per-call ceiling must NOT multiply by ceil(M/C).
 *      `GATE_BATCH_BUDGET_MS` bounds the WHOLE batch; each read is clamped to what is left,
 *      and below the client's own `MIN_GATE_BUDGET_MS` floor the remaining merchants are
 *      not asked at all and keep the previous behaviour. Same shape as the warm-handoff
 *      seam's budget clamp, for the same reason: fail-open in name is a cold page in fact
 *      if the gate eats the request.
 *
 * With the switch OFF nothing is asked, no domain is even parsed, and every function here
 * is byte-identical to before this change — pinned by snapshot, not asserted.
 */

const {
  MIN_GATE_BUDGET_MS,
  isGateEnabled,
  getMerchantPurchasabilityClient,
  selectBuyerMarket,
} = require('../services/merchantPurchasabilityClient');

/** At most this many purchasability reads in flight for one page of offers. */
const GATE_CONCURRENCY = 4;

/**
 * HARD WALL-CLOCK CEILING for the WHOLE batch, not per merchant. Without it a page across
 * M merchants costs ceil(M / GATE_CONCURRENCY) × the client's per-call timeout — the client's
 * 1.5 s becoming 15 s on a 40-merchant page against a slow-but-not-dead backend.
 */
const GATE_BATCH_BUDGET_MS = 1200;

function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeUrl(value) {
  const s = asString(value);
  return s ? s : null;
}

function readPurchaseRoute(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return '';
  return asString(o.purchase_route ?? o.purchaseRoute).toLowerCase();
}

function hasInternalPayload(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return false;
  return Boolean(o.internal_checkout ?? o.internalCheckout);
}

function readCheckoutUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(
    o.checkout_url ??
      o.checkoutUrl ??
      o.purchase_url ??
      o.purchaseUrl ??
      o.internal_checkout_url ??
      o.internalCheckoutUrl,
  );
}

function readAffiliateUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(
    o.affiliate_url ??
      o.affiliateUrl ??
      o.external_redirect_url ??
      o.externalRedirectUrl ??
      o.external_url ??
      o.externalUrl,
  );
}

function readGenericUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(o.url);
}

function readMerchantCheckoutSession(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  const session =
    o.merchant_checkout_session ??
    o.merchantCheckoutSession ??
    o.checkout_session ??
    o.checkoutSession ??
    o.internal_checkout ??
    o.internalCheckout;
  return session && typeof session === 'object' ? session : null;
}

function isInternalOffer(offer) {
  const route = readPurchaseRoute(offer);
  if (route === 'internal_checkout') return true;
  if (hasInternalPayload(offer)) return true;
  if (readCheckoutUrl(offer)) return true;
  return false;
}

function isExternalOffer(offer) {
  const route = readPurchaseRoute(offer);
  if (route === 'affiliate_outbound') return true;
  if (readAffiliateUrl(offer)) return true;
  return false;
}

function inferCommerceMode(offer) {
  if (isInternalOffer(offer) || readMerchantCheckoutSession(offer)) return 'merchant_embedded_checkout';
  if (isExternalOffer(offer) || readGenericUrl(offer)) return 'links_out';
  return 'merchant_embedded_checkout';
}

function inferCheckoutHandoff(offer) {
  return inferCommerceMode(offer) === 'merchant_embedded_checkout' ? 'embedded' : 'redirect';
}

/**
 * The ONE spelling of "the URL this offer would be stamped with". The gate must ask about
 * exactly the host the shopper would be sent to, so the decision and the stamp read the
 * same expression — a second, drifting copy is how a gate ends up asking about a merchant
 * other than the one in the link.
 */
function readOfferStampedCheckoutUrl(offer) {
  return (
    readCheckoutUrl(offer) ||
    readAffiliateUrl(offer) ||
    readGenericUrl(offer)
  );
}

/** Registrable-ish host of that URL, normalised the way the gate client normalises a domain. */
function readOfferMerchantDomain(offer) {
  const url = readOfferStampedCheckoutUrl(offer);
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function declinedSetOf(options) {
  const set = options && options.declinedDomains;
  return set instanceof Set && set.size > 0 ? set : null;
}

/**
 * Checkout/cart-shaped paths. A PDP or a category page is NOT one of these and is never stripped.
 *
 * ⚠️ THE FIRST CUT ANCHORED AT THE START OF THE PATH AND MISSED THE TWO COMMONEST REAL SHAPES.
 * Probed declined and surviving verbatim: `https://merchant.com/12345678/checkouts/abcdef` (the
 * classic Shopify web checkout, shop-id prefixed) and `https://merchant.com/en-gb/cart/12345:1`
 * (a locale-prefixed permalink). A suppression rule that only recognises the tidy shape suppresses
 * only the tidy shape. So an OPTIONAL locale segment and an OPTIONAL numeric shop segment, in
 * either order, precede the checkout segment. `/cart/c/<token>` and `/checkouts/cn/<token>` are
 * covered by the trailing `(\/|$|\?)`.
 */
const LOCALE_SEG = '(?:\\/[a-z]{2}(?:-[a-z]{2})?)?';
const SHOP_SEG = '(?:\\/\\d+)?';
const CHECKOUT_PATH_RE = new RegExp(
  `^${LOCALE_SEG}${SHOP_SEG}${LOCALE_SEG}\\/(cart|checkouts?|checkout-[^/]*)(\\/|$|\\?)`,
  'i',
);

/**
 * Field names that PROMISE a checkout. The byte-equal arm below strips the stamped URL from these
 * unconditionally — whatever its shape — because a field called `checkout_url` carrying the URL we
 * were about to publish as `merchant_checkout_url` IS the "buy here" link.
 */
const CHECKOUT_NAMED_FIELDS = new Set([
  'merchant_checkout_url', 'merchantCheckoutUrl',
  'checkout_url', 'checkoutUrl',
  'purchase_url', 'purchaseUrl',
  'internal_checkout_url', 'internalCheckoutUrl',
  'continue_url', 'continueUrl',
]);

/** "Buyable here" payloads. A declined merchant carries none of these, whatever they contain. */
const BUYABLE_SIGNAL_FIELDS = [
  'internal_checkout', 'internalCheckout',
  'merchant_checkout_session', 'merchantCheckoutSession',
  'checkout_session', 'checkoutSession',
  'merchant_checkout_url', 'merchantCheckoutUrl',
];

function parseUrlish(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || !/^https?:\/\//i.test(s)) return null;
  try { return new URL(s); } catch { return null; }
}

function hostKeyOf(parsed) {
  return parsed ? parsed.hostname.toLowerCase().replace(/^www\./, '') : null;
}

/** Same normalisation `offerDedupeKey` uses in src/server.js: case, query/fragment, trailing slash. */
function normalizeUrlForCompare(value) {
  return String(value || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * ⚠️ SUPPRESSING `merchant_checkout_url` ALONE IS NOT SUPPRESSING THE CHECKOUT.
 *
 * Review of the first cut: the SAME storefront cart URL is served on an offer under
 * `external_redirect_url`, `url`, `action.url` and anywhere else a producer put it —
 * `offerDedupeKey` (src/server.js) reads five spellings for exactly that reason. Withholding one
 * key while three aliases still carry `https://merchant/cart/1:1` withholds nothing.
 *
 * So for a DECLINED merchant every field anywhere in the offer whose value is that merchant's
 * CHECKOUT url is removed — compared the way `offerDedupeKey` compares (host, no query/fragment,
 * no trailing slash), matching either the exact URL that would have been stamped or any
 * cart/checkout-shaped path on that host.
 *
 * ⚠️ AND PDP / BROWSE LINKS STAY. That is the entire point of the fallback: the offer survives as
 * a browse/referral result. A redirect offer whose only URL is the product page keeps it — the
 * stamped URL is only stripped by the byte-equal arm when it is itself checkout-shaped.
 */
function isSuppressedCheckoutUrl(value, domain, stampedUrl, fieldName) {
  const parsed = parseUrlish(value);
  if (!parsed || hostKeyOf(parsed) !== domain) return false;
  // ARM 1 — SHAPE. A cart/checkout path on the declined host, in ANY field, at any depth.
  if (CHECKOUT_PATH_RE.test(parsed.pathname)) return true;
  // ARM 2 — BYTE-EQUAL TO THE STAMPED URL, and UNCONDITIONAL on shape. The first cut gated this on
  // the stamped URL being checkout-SHAPED, i.e. it switched itself off in exactly the case the
  // shape arm had already failed to recognise — two guards that fail together are one guard.
  if (normalizeUrlForCompare(value) !== normalizeUrlForCompare(stampedUrl)) return false;
  // ...but only out of a field that CLAIMS to be a checkout. A redirect offer whose only URL is the
  // product page has that URL stamped as its "checkout url"; stripping it from `external_redirect_url`
  // and `url` too would leave a row with no way to reach the product at all, and browse/referral IS
  // the fallback this gate exists to fall back TO (docs §8, and the standing constraint that the
  // OFFER survives). Both probe shapes in the review are checkout-SHAPED, so arm 1 removes them from
  // every field regardless. ⚠️ Deliberate narrowing of the review instruction — called out in the PR.
  return CHECKOUT_NAMED_FIELDS.has(fieldName);
}

const MAX_STRIP_DEPTH = 8;
const DROP = Symbol('drop');

/**
 * Deep copy of `node` with every suppressed URL value removed.
 *
 * ⚠️ TWO THINGS THE FIRST CUT GOT WRONG, BOTH ONLY ON DECLINED ROWS (so neither was visible in a
 * snapshot of a purchasable one):
 *
 *  1. IT REBUILT EVERY OBJECT AS A PLAIN ONE. `Object.entries(new Date())` is `[]`, so a `Date` on
 *     a declined offer came back as `{}` — and a Buffer, a RegExp or a class instance the same way.
 *     Anything that is not a plain object or an array is now copied BY REFERENCE: it cannot contain
 *     a URL-valued own enumerable key we would have stripped, and mangling it is a real data loss.
 *  2. AT THE DEPTH CAP IT RETURNED THE SUBTREE BY REFERENCE, UNSTRIPPED — i.e. the one place the
 *     walk gives up was the one place a checkout URL was guaranteed to survive. Past the cap the
 *     field is DROPPED instead: a suppression that cannot see what it is suppressing must fail
 *     CLOSED. Eight levels is far past anything an offer row carries, so this is a guard, not a
 *     behaviour.
 */
function stripCheckoutUrlsDeep(node, domain, stampedUrl, depth = 0) {
  if (node === null || typeof node !== 'object') return node;
  if (depth > MAX_STRIP_DEPTH) return DROP;
  if (Array.isArray(node)) {
    const out = [];
    for (const v of node) {
      if (typeof v === 'string') {
        // An array element has no field name of its own; it inherits the array's, which is why the
        // caller passes it down. Shape-matching applies either way.
        if (!isSuppressedCheckoutUrl(v, domain, stampedUrl, null)) out.push(v);
        continue;
      }
      const stripped = stripCheckoutUrlsDeep(v, domain, stampedUrl, depth + 1);
      if (stripped !== DROP) out.push(stripped);
    }
    return out;
  }
  // Not a plain object (Date, Buffer, RegExp, a class instance): copied by reference, never rebuilt.
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (!isSuppressedCheckoutUrl(v, domain, stampedUrl, k)) out[k] = v;
      continue;
    }
    const stripped = stripCheckoutUrlsDeep(v, domain, stampedUrl, depth + 1);
    if (stripped !== DROP) out[k] = stripped;
  }
  return out;
}

/**
 * THE BROWSE / REFERRAL SHAPE, in the repo's OWN vocabulary — surveyed, not invented:
 *   `purchase_route: 'affiliate_outbound'`  — what `isExternalOffer` reads, what src/server.js:10029
 *                                             already stamps on a links-out row, and one of the four
 *                                             tokens `checkoutHandoffResolver.isCurrentPolicyDirect`
 *                                             treats as NOT direct.
 *   `commerce_mode: 'links_out'`            — likewise refused by `isCurrentPolicyDirect`, and
 *                                             mapped to `product_snippet` (not `merchant_listing`)
 *                                             by `pdpProductIntel.inferStructuredDataMode`.
 *   `checkout_handoff: 'redirect'`          — likewise.
 * Nothing new is added to a shared vocabulary: widening one needs its own measured no-change
 * invariant, and a declined row is precisely the links-out row this repo already describes.
 */
const DECLINED_PURCHASE_ROUTE = 'affiliate_outbound';
const DECLINED_CHECKOUT_HANDOFF = 'redirect';

function enrichOfferCommerceMetadata(offer, options) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return offer;

  const checkoutUrl = readOfferStampedCheckoutUrl(offer);
  const merchantCheckoutSession = readMerchantCheckoutSession(offer);

  // THE SEAM.
  // `declinedDomains` is empty (and this is `false`) on every path where the switch is off, the
  // backend is not enforcing, or the read failed — i.e. the previous behaviour, byte for byte.
  // (No market under ENFORCEMENT is a decline since backend #2352: no fact can exist for it.)
  const declined = declinedSetOf(options);
  const domain = readOfferMerchantDomain(offer);
  const merchantNotPurchasable = Boolean(checkoutUrl && declined && declined.has(domain));

  if (merchantNotPurchasable) {
    // ⚠️ A URL IS NOT THE ONLY THING THAT SAYS "BUYABLE HERE".
    //
    // The first cut removed the checkout URLs and left every other purchase signal standing.
    // Probed: a declined `{purchase_route:'internal_checkout', checkout_url:<cart>,
    // internal_checkout:{continue_url,token}}` was served as `purchase_route:'internal_checkout'`,
    // `internal_checkout:{token}`, `merchant_checkout_session:{token}`,
    // `commerce_mode:'merchant_embedded_checkout'`, `checkout_handoff:'embedded'` — so
    // `isInternalOffer` was still TRUE, `compareOffersForPresentation` could still rank it as an
    // internal offer and `pickDefaultOfferId` could still make it the page's DEFAULT. The URL was
    // gone and the offer still said, in five other ways, that Pivota sells this here.
    //
    // So a declined merchant loses the whole claim, not one field of it: the payloads, the route,
    // the mode and the handoff.
    //
    // DELETE, NOT "SKIP" — this function runs MORE THAN ONCE over the same offer (the PDP lane
    // annotates inside `buildOffersFromGroupMembers` and its callers annotate the result again), and
    // a conditional spread can only ADD a key. Removing explicitly makes the decision hold whichever
    // pass stamped it, and makes suppression idempotent.
    const base = stripCheckoutUrlsDeep(offer, domain, checkoutUrl);
    for (const field of BUYABLE_SIGNAL_FIELDS) delete base[field];
    // Both spellings, so `readPurchaseRoute` cannot find a stale camelCase twin.
    delete base.purchaseRoute;
    base.purchase_route = DECLINED_PURCHASE_ROUTE;

    // ⚠️ THE MODE IS COMPUTED **AFTER** THE STRIP, ON THE STRIPPED ROW. Computing it first (what the
    // first cut did, then froze with a `suppressedEarlier` flag) reads the very signals this branch
    // has just removed and hands back `merchant_embedded_checkout` for a merchant we have declined.
    // The stripped row has no internal payload and no checkout URL, so `inferCommerceMode` answers
    // `links_out` whenever any link survives; its "nothing at all" fallback is
    // `merchant_embedded_checkout`, which is the one answer a declined row must never carry, so that
    // case is pinned to the browse shape instead. There is no label to freeze: `purchase_route`
    // above makes `isExternalOffer` true, so a LATER pass recomputes the same values from the row
    // itself and suppression stays idempotent.
    // `base.purchase_route` is set ABOVE, so `isExternalOffer(base)` is true and `inferCommerceMode`
    // can only answer `links_out` here — including for a row with no link left at all. That is why
    // there is no "no link" fallback: it would be dead code, and a dead branch reads as a decision
    // somebody made. The mutant that computes this from the UNSTRIPPED offer is killed.
    return {
      ...base,
      commerce_mode: inferCommerceMode(base),
      seller_of_record: 'merchant',
      payment_processor_owner: 'merchant',
      order_system_of_record: 'merchant_store_platform',
      checkout_handoff: DECLINED_CHECKOUT_HANDOFF,
      order_writeback_mode: 'merchant_direct',
    };
  }

  const commerceMode = inferCommerceMode(offer);
  return {
    ...offer,
    commerce_mode: commerceMode,
    seller_of_record: 'merchant',
    payment_processor_owner: 'merchant',
    order_system_of_record: 'merchant_store_platform',
    checkout_handoff: inferCheckoutHandoff(offer),
    order_writeback_mode: 'merchant_direct',
    ...(checkoutUrl ? { merchant_checkout_url: checkoutUrl } : {}),
    ...(merchantCheckoutSession ? { merchant_checkout_session: merchantCheckoutSession } : {}),
  };
}

function annotateOffersWithCommerceMetadata(offers, options) {
  const arr = Array.isArray(offers) ? offers : [];
  return arr.map((offer) => enrichOfferCommerceMetadata(offer, options));
}

/**
 * Ask the merchant-purchasability gate about every DISTINCT merchant on this page of
 * offers, and answer with the set of domains whose `merchant_checkout_url` must not be
 * stamped for this market.
 *
 * FAILS OPEN, ALWAYS: the empty set is the previous behaviour, and it is what every
 * failure, every non-enforcing backend, every missing market and the switch-off path all
 * return. Nothing here throws into the serving path.
 *
 * @param {Array} offers
 * @param {{ market?: string, env?: object, budgetMs?: number, now?: Function,
 *           shouldOfferPurchase?: Function, concurrency?: number }} [options]
 * @returns {Promise<Set<string>>}
 */
async function resolveOfferPurchasabilityDecisions(offers, options = {}) {
  const declined = new Set();
  const env = options.env || process.env;

  // THE SWITCH, READ FIRST AND HERE. Off means nothing is asked — not "asked and ignored".
  // A page of offers is the latency-sensitive surface in this repo; paying for a read whose
  // answer is discarded is the defect, so the flag is checked before a single domain is
  // parsed. A test with the switch off asserts the injected gate is called ZERO times.
  if (!isGateEnabled(env)) return declined;

  const arr = Array.isArray(offers) ? offers : [];
  if (arr.length === 0) return declined;

  // DEDUPE FIRST: N offers for one merchant × market are ONE question.
  const domains = [...new Set(arr.map((offer) => readOfferMerchantDomain(offer)).filter(Boolean))];
  if (domains.length === 0) return declined;

  const gate = typeof options.shouldOfferPurchase === 'function'
    ? options.shouldOfferPurchase
    : (args) => getMerchantPurchasabilityClient().shouldOfferPurchase(args);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = now();
  const totalBudgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0
    ? Math.min(options.budgetMs, GATE_BATCH_BUDGET_MS)
    : GATE_BATCH_BUDGET_MS;
  const concurrency = Math.max(
    1,
    Math.min(
      Number.isFinite(options.concurrency) && options.concurrency > 0 ? options.concurrency : GATE_CONCURRENCY,
      domains.length,
    ),
  );

  // ⚠️ A BUDGET THAT IS ONLY CHECKED BETWEEN READS IS ADVISORY, NOT A BOUND. Measured on the first
  // cut: 12 merchants where ONE read takes 5 s — the loop checks the clock, starts that read, and
  // the page waits 5003 ms for a 1200 ms "budget". The clock check bounds how many reads are
  // STARTED; only a deadline bounds how long the batch TAKES. So the whole batch races a timer, and
  // a read that lands after it is DISCARDED — its merchant keeps the previous behaviour, which is
  // what every other non-answer here resolves to.
  //
  // NOTE ON WHAT IS **NOT** HERE. An `if (abandoned) return;` at the head of this loop would be
  // UNREACHABLE: `MIN_GATE_BUDGET_MS` (300 ms) is greater than zero and the deadline is set to the
  // same `remainingTotalMs` the loop measures against, so every worker exits on the FLOOR before
  // the timer can ever fire. An unreachable guard reads as protection that does not exist, so it is
  // not written. The flag below is different: a worker can be INSIDE an `await` when the deadline
  // fires, and that is the result this guard (and the defensive copy at the end) drops.
  let abandoned = false;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= domains.length) return;
      // THE BATCH BUDGET FLOOR. What is LEFT of the page's budget, not the client's own
      // ceiling — otherwise the ceiling multiplies by ceil(M / concurrency). Below the
      // client's floor there is no useful question left to ask, so the remaining merchants
      // keep the previous behaviour rather than each paying a doomed timeout.
      const remainingMs = totalBudgetMs - (now() - startedAt);
      if (remainingMs < MIN_GATE_BUDGET_MS) return;
      let decision = null;
      try {
        decision = await gate({
          domain: domains[index],
          market: options.market,
          budgetMs: remainingMs,
        });
      } catch {
        decision = null; // fail open: the client does not throw, and a future one must not either
      }
      // STRICTLY `=== false`. A loose compare would take `undefined`/`''`/`0` from a
      // malformed or future answer as a refusal, which is fail-CLOSED by accident.
      // A result that arrives after the deadline is DROPPED, not applied to a page already served.
      if (!abandoned && decision && decision.offer === false) declined.add(domains[index]);
    }
  }

  const workers = Promise.all(Array.from({ length: concurrency }, () => worker()));
  const remainingTotalMs = Math.max(0, totalBudgetMs - (now() - startedAt));
  let deadlineTimer = null;
  const deadline = new Promise((resolve) => {
    // ⚠️ NOT `unref()`d — see the identical note in merchantPurchasabilityClient.fetchFact. When
    // every read hangs, this timer is the ONLY thing that can settle the race below, so an unref'd
    // one lets node drain the loop and exit with the batch promise still pending. It is bounded by
    // `remainingTotalMs` and cleared in the `finally`, so it holds the loop only while the caller
    // is waiting on it regardless.
    deadlineTimer = setTimeout(() => { abandoned = true; resolve(); }, remainingTotalMs);
  });
  try {
    await Promise.race([workers, deadline]);
  } finally {
    abandoned = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  // A COPY: the workers may still be unwinding, and a page must be answered from what was decided
  // BEFORE the deadline, never from a set something else is still writing to.
  return new Set(declined);
}

/**
 * THE BUYER MARKET FOR THE OFFERS PATH, in this door's existing spellings.
 *
 * Lives here, with the seam it keys, rather than in `src/server.js`: the first cut put it there and
 * it had ZERO coverage — the mutant that defaults it to `'US'` survived the whole suite, which is
 * precisely the substitution the gate must never make. It is a pure function of two request objects,
 * so it belongs where a test can reach it.
 *
 * ⚠️ CALLER-SUPPLIED ONLY. `servedMarkets.primaryMarket()` answers the DEPLOYMENT's market ('US' by
 * default) and the fact is keyed on the BUYER's; a positive fact from another vantage is evidence
 * for a human, never permission for the door. No market => `undefined` => no fact can be read =>
 * under backend enforcement every merchant on the page is declined (the delete path, backend #2352);
 * unenforced, today's exact behaviour. Logged `merchant_purchasability_unkeyable` either way.
 */
function offersGateBuyerMarket(payload, metadata) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const p = obj(payload);
  const search = p ? obj(p.search) : null;
  const m = obj(metadata);
  // Precedence unchanged (search, payload, metadata); the FIRST carrier that yields ONE ISO-2
  // market wins — an unreadable or multi-market carrier is skipped, not decisive. See
  // `selectBuyerMarket` and docs/merchant-purchasability-gate.md §5.
  return selectBuyerMarket(search && search.market, p && p.market, m && m.market);
}

/** `annotateOffersWithCommerceMetadata`, with the gate consulted first. */
async function annotateOffersWithCommerceMetadataGated(offers, options = {}) {
  const declinedDomains = await resolveOfferPurchasabilityDecisions(offers, options);
  return annotateOffersWithCommerceMetadata(offers, { declinedDomains });
}

function summarizeOfferCommerceMetadata(offers, options) {
  const arr = annotateOffersWithCommerceMetadata(offers, options);
  const modes = Array.from(
    new Set(arr.map((offer) => asString(offer?.commerce_mode)).filter(Boolean)),
  );
  return {
    offers: arr,
    commerce_modes: modes,
    seller_of_record: 'merchant',
    payment_processor_owner: 'merchant',
    order_system_of_record: 'merchant_store_platform',
    order_writeback_mode: 'merchant_direct',
  };
}

function readOfferCurrency(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return '';
  return asString(
    o?.price?.currency ??
      o?.price?.current?.currency ??
      o?.currency,
  ).toUpperCase();
}

function offerHasAvailableInventory(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return false;
  const inStock = o?.inventory?.in_stock ?? o?.inventory?.inStock ?? o?.in_stock ?? o?.inStock;
  return inStock !== false;
}

function computeOfferTotal(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return Number.POSITIVE_INFINITY;
  const price = Number(o?.price?.amount ?? o?.price?.current?.amount);
  if (!Number.isFinite(price) || price <= 0) return Number.POSITIVE_INFINITY;
  const shipping = Number(o?.shipping?.cost?.amount ?? 0) || 0;
  return price + shipping;
}

function readExpectedCurrency(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return '';
  return asString(
    o?.agent_safe_commerce_facts?.currency_target ??
      o?.commerce_facts_v1?.currency_target ??
      o?.commerce_facts?.currency_target,
  ).toUpperCase();
}

function offerMatchesExpectedCurrency(offer) {
  const expected = readExpectedCurrency(offer);
  const observed = readOfferCurrency(offer);
  if (!expected || !observed) return false;
  return expected === observed;
}

function scoreCommerceFactsCompleteness(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return 0;
  const facts = o.agent_safe_commerce_facts || o.commerce_facts_v1 || o.commerce_facts || {};
  let score = 0;
  if (facts?.regional_price?.amount != null && readOfferCurrency(offer)) score += 1;
  if (asString(facts?.availability?.status)) score += 1;
  if (asString(facts?.shipping?.status) && asString(facts?.shipping?.status).toLowerCase() !== 'unknown') score += 1;
  if (asString(facts?.returns?.status) && asString(facts?.returns?.status).toLowerCase() !== 'unknown') score += 1;
  if (Array.isArray(facts?.promotions) && facts.promotions.length > 0) score += 1;
  return score;
}

function scoreOfferForPriority(offer) {
  return offer && typeof offer === 'object' ? 0 : 99;
}

function compareOffersForPresentation(a, b) {
  const aInStock = offerHasAvailableInventory(a) ? 1 : 0;
  const bInStock = offerHasAvailableInventory(b) ? 1 : 0;
  if (aInStock !== bInStock) return bInStock - aInStock;

  const aCurrencyMatch = offerMatchesExpectedCurrency(a) ? 1 : 0;
  const bCurrencyMatch = offerMatchesExpectedCurrency(b) ? 1 : 0;
  if (aCurrencyMatch !== bCurrencyMatch) return bCurrencyMatch - aCurrencyMatch;

  const aTotal = computeOfferTotal(a);
  const bTotal = computeOfferTotal(b);
  if (aTotal !== bTotal) return aTotal < bTotal ? -1 : 1;

  const completenessDelta = scoreCommerceFactsCompleteness(b) - scoreCommerceFactsCompleteness(a);
  if (completenessDelta !== 0) return completenessDelta;

  return scoreOfferForPriority(a) - scoreOfferForPriority(b);
}

function prioritizeOffers(offers) {
  const arr = Array.isArray(offers) ? offers.slice() : [];
  if (arr.length <= 1) return arr;

  const scored = arr.map((o, idx) => ({ o, idx }));
  scored.sort((a, b) => compareOffersForPresentation(a.o, b.o) || a.idx - b.idx);
  return scored.map((x) => x.o);
}

function pickDefaultOfferId(offers) {
  const prioritized = prioritizeOffers(offers);
  return prioritized[0]?.offer_id || null;
}

function readResolveResponseOffers(upstreamData) {
  const data = upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData) ? upstreamData : null;
  if (!data) return [];
  if (Array.isArray(data.offers)) return data.offers;
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.offers)) {
    return data.data.offers;
  }
  return [];
}

function prioritizeOffersResolveResponse(upstreamData, options) {
  const data = upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData) ? upstreamData : null;
  if (!data) return upstreamData;

  if (Array.isArray(data.offers)) {
    const prioritized = prioritizeOffers(data.offers);
    const summary = summarizeOfferCommerceMetadata(prioritized, options);
    return {
      ...data,
      offers: summary.offers,
      ...(pickDefaultOfferId(summary.offers) ? { default_offer_id: pickDefaultOfferId(summary.offers) } : {}),
      metadata: {
        ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}),
        commerce_modes: summary.commerce_modes,
        seller_of_record: summary.seller_of_record,
        payment_processor_owner: summary.payment_processor_owner,
        order_system_of_record: summary.order_system_of_record,
        order_writeback_mode: summary.order_writeback_mode,
      },
    };
  }

  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.offers)) {
    const prioritized = prioritizeOffers(data.data.offers);
    const summary = summarizeOfferCommerceMetadata(prioritized, options);
    return {
      ...data,
      data: {
        ...data.data,
        offers: summary.offers,
        ...(pickDefaultOfferId(summary.offers) ? { default_offer_id: pickDefaultOfferId(summary.offers) } : {}),
      },
      metadata: {
        ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}),
        commerce_modes: summary.commerce_modes,
        seller_of_record: summary.seller_of_record,
        payment_processor_owner: summary.payment_processor_owner,
        order_system_of_record: summary.order_system_of_record,
        order_writeback_mode: summary.order_writeback_mode,
      },
    };
  }

  return upstreamData;
}

/** `prioritizeOffersResolveResponse`, with the gate consulted first. Same bounds, same fail-open. */
async function prioritizeOffersResolveResponseGated(upstreamData, options = {}) {
  const declinedDomains = await resolveOfferPurchasabilityDecisions(
    readResolveResponseOffers(upstreamData),
    options,
  );
  return prioritizeOffersResolveResponse(upstreamData, { declinedDomains });
}

module.exports = {
  GATE_BATCH_BUDGET_MS,
  offersGateBuyerMarket,
  GATE_CONCURRENCY,
  readOfferMerchantDomain,
  resolveOfferPurchasabilityDecisions,
  annotateOffersWithCommerceMetadataGated,
  prioritizeOffersResolveResponseGated,
  annotateOffersWithCommerceMetadata,
  enrichOfferCommerceMetadata,
  compareOffersForPresentation,
  computeOfferTotal,
  isInternalOffer,
  pickDefaultOfferId,
  prioritizeOffers,
  prioritizeOffersResolveResponse,
  summarizeOfferCommerceMetadata,
};
