'use strict';

/*
 * merchantPurchasabilityClient.js — the gateway's CONSUMER of the backend's
 * per-merchant×market PURCHASABILITY FACT (pivota-backend WP6, #2240).
 *
 * WHAT THE FACT IS. The backend renders a merchant's landed Shopify checkout and
 * records a positive fact ONLY when that checkout's OWN accept-list named a CARD
 * gateway and the line was charged at the price we hold, measured from the buyer
 * market's vantage, fresh within a TTL (72 h by default). Nothing weaker counts:
 * `ready_for_complete` means a cart was PRICED, and `/.well-known/ucp`
 * `payment_handlers: ["dev.shopify.card"]` is a platform constant every Shopify
 * store repeats. Both were "yes" for flowerbeauty.com on 2026-09-22, whose
 * rendered checkout offered PayPal ONLY and charged USD 8.00 against our indexed
 * USD 14.95. This module exists so the gateway stops reading those two as payment.
 *
 * Contract: pivota-backend docs/runbooks/merchant_purchasability.md, section
 * "Gateway (PIVOTA-Agent) change". The five rules it states, and where each lives:
 *
 *   1. GET /ops/merchant-purchasability?domain=<domain>&market=<ISO-2>   -> buildFactUrl
 *   2. Act on `tier` ONLY when `enforced === true`                       -> decide()
 *   3. Cache <= 5 minutes per (domain, market), bounded                  -> MAX_TTL_MS, cache
 *   4. FAIL OPEN on transport error / timeout / non-200 / malformed      -> every catch here
 *   5. Log loudly when sweep_enabled=false && enforced=true              -> noteMisorderedArming
 *
 * And one rule of this gateway's own (backend #2352 made its half true):
 *
 *   6. An UNKEYABLE request (no usable market) under ENFORCEMENT is NOT offered a
 *      purchase. A fact is per (merchant, market); "market unknown" means "no fact",
 *      and the enforced rule is "no fresh positive fact -> browse-only". Whether the
 *      backend is enforcing is learned WITHOUT a market from the same ops route, which
 *      since #2352 answers a market-less call with 200 `{tier: browse_only,
 *      reason: market_unknown, enforced, sweep_enabled}`             -> fetchEnforcement
 *
 * THE DECISION TABLE (docs/merchant-purchasability-gate.md §5 carries the same one, and
 * tests/merchant_purchasability_gate.node.test.cjs pins every row):
 *
 *   switch off                               -> offer  source 'disabled'
 *   budget below the floor                   -> offer  source 'skipped_budget'
 *   keyable, backend answered, enforced      -> tier   source 'gate'
 *   keyable, backend answered, not enforced  -> offer  source 'previous'
 *   keyable, no usable answer                -> offer  source 'failed'
 *   unkeyable, enforced=false                -> offer  source 'unkeyable_unenforced'
 *   unkeyable, enforced=true                 -> NO     source 'unkeyable_enforced', reason 'market_unknown'
 *   unkeyable, enforcement unknown           -> offer  source 'failed', reason 'market_unknown'
 *
 * ⚠️ RULE 2 IS NOT A NICETY. With the backend dial off, `is_purchasable` returns
 * False for EVERY merchant — because nothing is enforced, not because the merchant
 * is browse-only — so the route answers `tier: "browse_only"` for the whole
 * catalogue. A consumer that read `tier` alone would take every merchant
 * browse-only on the day it shipped.
 *
 * ⚠️ RULE 4 IS NOT SYMMETRY WITH THE BACKEND, IT IS THE OPPOSITE OF IT, ON PURPOSE.
 * The backend's `is_purchasable` fails CLOSED on a database error: a payment gate
 * that cannot prove payment must not permit it. That is the guarantee. A SECOND
 * fail-closed layer in front of it does not add a second guarantee — it turns one
 * backend blip into a catalogue-wide outage. One is the guarantee; two is an
 * incident. So every failure here resolves to the PREVIOUS behaviour.
 *
 * ---- AUTH: WHAT THE BRIEF ASSUMED, AND WHAT THIS REPO ACTUALLY HAS ------------
 *
 * The backend runbook says to "reuse the same ops credential the gateway already
 * uses for its store-audit reads". SURVEYED AGAINST THIS REPO ON 2026-09-22:
 * there is no such caller. This gateway calls NO backend `/ops/...` route at all;
 * it has no admin JWT, no module that mints or signs one (`jsonwebtoken` is not a
 * dependency and every `jose` use is VERIFICATION), and no `ADMIN_JWT`-shaped env
 * var anywhere including env.example. Its one admin rail is
 * `server.js::fetchBackendAdmin`, which sends `X-ADMIN-KEY: ADMIN_API_KEY` to
 * `/agent/internal/*` — and the runbook names that header explicitly as the thing
 * that will 401 here, because these ops routes depend on `require_admin`
 * (Bearer JWT, role admin/super_admin) and deliberately NOT on
 * `require_admin_or_key`.
 *
 * So the credential was READ FROM THE ENVIRONMENT and never minted here:
 * `PIVOTA_OPS_ADMIN_TOKEN` holds an admin/super_admin JWT issued by the backend,
 * and it travels as `Authorization: Bearer <token>`. Unconfigured is not an error
 * and not a refusal — `shouldOfferPurchase` answers `source: 'failed'`, i.e. the
 * previous behaviour, which is what rule 4 requires of every other failure too.
 *
 * ---- AND WHY THAT STANDING JWT IS NO LONGER THE PRIMARY CREDENTIAL ------------
 *
 * A standing admin JWT in an env var expires on a calendar date, and BECAUSE OF
 * RULE 4 it expires SILENTLY: the backend starts answering 401, every failure here
 * resolves to the previous behaviour, and the gate is DISARMED while every dial on
 * both sides still reads "on". `merchant_purchasability_read_failed` is logged once
 * per five minutes and nothing else happens. A gate that disarms itself on a date
 * nobody has written down is not a gate.
 *
 * This service already runs on Cloud Run with its own service account, and
 * `cloudRunIdentityToken.js` already knows how to ask the metadata server for a
 * Google-signed OIDC identity token for a named audience — that is the EXISTING
 * OWNER of this problem in this repo (four store-audit callers use it), so this
 * module reuses it rather than growing a second metadata client. The backend
 * verifies such a token against Google's certificates and an allow-list of service
 * accounts (pivota-backend `utils/gateway_oidc_auth.py`).
 *
 * The chain, in order, and every step of it inside rule 4's fail-open semantics:
 *
 *   1. `PIVOTA_OPS_OIDC_AUDIENCE` is set  -> ask the metadata server. This is the
 *      preferred rail whenever the audience env is set, whatever else is present.
 *   2. no identity token came back (local dev, no metadata server, a timeout)
 *      -> use `PIVOTA_OPS_ADMIN_TOKEN` if it is set. A DEV FALLBACK, not a rail.
 *   3. neither -> the existing "not configured" behaviour: log once, previous
 *      behaviour, nothing refused.
 *
 * ⚠️ THE AUDIENCE MUST MATCH THE BACKEND'S `OPS_GATEWAY_OIDC_AUDIENCE` BYTE FOR
 * BYTE. An audience is a string compare on the backend, not a URL compare, so a
 * trailing slash or an `http://` is a DIFFERENT audience and every read 401s —
 * which, again, fails open and is therefore silent. See
 * docs/merchant-purchasability-gate.md.
 *
 * ---- PII -----------------------------------------------------------------------
 *
 * The outbound URL carries EXACTLY two values: a merchant domain and a two-letter
 * market. No buyer, no email, no address, no variant, no cart, no session. The
 * logs carry the same two plus the decision. `assertNoBuyerData` is asserted by a
 * test rather than trusted, because "only domain and market" is the kind of claim
 * that stays true until somebody adds a third argument.
 */

const { createRefreshingCloudRunIdTokenProvider } = require('./cloudRunIdentityToken');

const OPS_PATH = '/ops/merchant-purchasability';

/** The gateway-side kill switch. Default OFF: this ships dark and arms independently of the backend dial. */
const GATE_FLAG_ENV = 'MERCHANT_PURCHASABILITY_GATE_ENABLED';

/**
 * Env carrying an admin/super_admin Bearer JWT for the backend's ops routes. Read, never minted.
 * SINCE THE OIDC FOLLOW-UP THIS IS A DEV FALLBACK, not the production rail: it is consulted only
 * when no Google identity token could be obtained.
 */
const OPS_TOKEN_ENV = 'PIVOTA_OPS_ADMIN_TOKEN';

/**
 * Env carrying the AUDIENCE for the gateway's Google identity token. Setting it switches this
 * client onto the OIDC rail. It must equal the backend's `OPS_GATEWAY_OIDC_AUDIENCE` exactly;
 * the recommended value is the backend's canonical https origin (`https://api.pivota.cc`).
 *
 * Unset = the pre-OIDC behaviour, unchanged, including every log line.
 */
const OIDC_AUDIENCE_ENV = 'PIVOTA_OPS_OIDC_AUDIENCE';

/** Backend origin. Same variable the rest of the gateway uses for the backend. */
const BASE_URL_ENV = 'PIVOTA_API_BASE';

/**
 * HARD CEILING on the per-call budget, not a default. This sits on the checkout
 * door's critical path; the runbook says at most 2 s and a caller that asks for
 * more does not get it.
 */
const MAX_TIMEOUT_MS = 2000;
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * HARD CEILING on the cache TTL, not a default. The fact changes at sweep cadence
 * (hourly by default), so a short cache costs nothing — but a LONG one delays a
 * demotion, which is the whole thing this rail exists to deliver. 5 minutes is the
 * runbook's number and `Math.min` is why a caller cannot widen it.
 */
const MAX_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Failures are cached too, briefly. Not caching them at all would mean a backend
 * that is down costs every single checkout the full timeout — the fail-open rule
 * would hold while the latency it buys turns into its own incident. 30 s is short
 * enough that recovery is picked up within one sweep tick's noise.
 */
const DEFAULT_NEGATIVE_TTL_MS = 30 * 1000;

/** Bounded, because an unbounded map keyed on a caller-influenced domain is a memory leak with a name. */
const DEFAULT_CACHE_MAX_ENTRIES = 500;

/** Once per interval, per (domain, market) — loud, not chatty. */
const LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Below this many milliseconds of remaining budget the gate is SKIPPED rather than
 * attempted. See `shouldOfferPurchase`'s `budgetMs`: a gate that starts with 50 ms
 * left cannot answer, and the time it spends failing is taken from the lane that
 * still has to build a cart.
 */
const MIN_GATE_BUDGET_MS = 300;

const TIER_PURCHASE = 'purchase';
const TIER_BROWSE_ONLY = 'browse_only';

/**
 * The backend's `reason` on a market-less ops answer (pivota-backend #2352,
 * `db/merchant_purchasability.MARKET_UNKNOWN`), and the `reason` this client puts on
 * every UNKEYABLE decision whose missing half is the market.
 */
const REASON_MARKET_UNKNOWN = 'market_unknown';
/** The `reason` on an unkeyable decision whose missing half is the merchant domain. */
const REASON_DOMAIN_UNKNOWN = 'domain_unknown';

/**
 * The enforcement answer is GLOBAL on the backend (`MERCHANT_PURCHASABILITY_ENFORCE` is one
 * process-wide dial, not a per-merchant field), so it is cached under ONE key, not per domain.
 */
const ENFORCEMENT_CACHE_KEY = 'enforced';

/** The answers, and what each one means to a caller. */
const SOURCE = Object.freeze({
  /** the gateway switch is off — nothing was asked, nothing changed */
  disabled: 'disabled',
  /** the backend answered and IS enforcing — `offer` is the gate's decision */
  gate: 'gate',
  /** the backend answered and is NOT enforcing — keep the previous behaviour */
  previous: 'previous',
  /** nothing usable came back — keep the previous behaviour (fail OPEN) */
  failed: 'failed',
  /** the caller's remaining wall-clock budget was too small to ask — previous behaviour */
  skipped_budget: 'skipped_budget',
  /**
   * no (domain, market) key for this request, and the backend says it is NOT enforcing —
   * previous behaviour (`offer: true`), `reason` says which half was missing
   */
  unkeyable_unenforced: 'unkeyable_unenforced',
  /**
   * no (domain, market) key for this request, and the backend IS enforcing: there is no fact,
   * so there is no positive fact, so the purchase is NOT offered (`offer: false`). Every seam
   * takes this exactly as it takes a `gate` decline.
   */
  unkeyable_enforced: 'unkeyable_enforced',
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * The shared structured logger, loaded lazily and defensively — the same shape
 * `checkoutHandoffResolver.getWarmHandoffLogger` uses, and for the same reason: a
 * logging require that throws must never break the serving path.
 *
 * ⚠️ THIS IS A DEFAULT, NOT A CONVENIENCE. Review of the first cut found BOTH
 * production construction sites (`checkoutHandoffResolver.js` and
 * `ucpWarmHandoffInternalRoute.js`) reaching this module with no logger — the click
 * lane literally passes `logger: deps.logger || null` — so every event in here,
 * including the `error`-level misordered-arming alarm that is the whole point of
 * reading `sweep_enabled`, went to a `null` logger and was never emitted anywhere.
 * A gate whose alarms cannot fire is a gate nobody can operate. So the logger is
 * defaulted HERE, at the bottom, where no caller can forget it.
 */
function defaultLogger() {
  try {
    // eslint-disable-next-line global-require
    return require('../logger');
  } catch {
    return null;
  }
}

/** The repo's truthy-flag spelling (ucpWarmHandoff.js, ucpCheckoutEscalation.js). */
function isFlagOn(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value === undefined || value === null ? '' : value).trim());
}

function isGateEnabled(env = process.env) {
  return isFlagOn(env && env[GATE_FLAG_ENV]);
}

/**
 * Fold a domain the way the backend's `normalize_domain` does: lowercase, strip
 * one leading `www.`. A scheme, a path, a port or a credential is stripped first
 * so a caller holding a URL cannot key a row that does not exist.
 *
 * THIS MUST AGREE WITH THE WRITER. The runbook's own census note says a population
 * row spelled `www.Judydoll.com` does not join to the fact row `judydoll.com`
 * unless it is folded exactly this way — a mismatch here is not an error, it is a
 * 404 that reads as "no fact" and silently keeps the previous behaviour forever.
 */
function normalizeDomain(value) {
  let text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!text) return null;
  if (text.includes('://')) {
    try { text = new URL(text).hostname; } catch { return null; }
  } else {
    text = text.split('/')[0];
    // A bare `user:pass@host` or `host:port` — take the host.
    if (text.includes('@')) text = text.slice(text.lastIndexOf('@') + 1);
    if (text.includes(':')) text = text.slice(0, text.indexOf(':'));
  }
  text = text.replace(/\.$/, '');
  if (text.startsWith('www.')) text = text.slice(4);
  // A hostname, not a sentence: labels of letters/digits/hyphens, at least one dot.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text)) return null;
  return text;
}

/** The backend's `normalize_market`: exactly two letters, uppercased. Anything else is not a market. */
function normalizeMarket(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^[A-Za-z]{2}$/.test(text)) return null;
  return text.toUpperCase();
}

/**
 * ONE carrier value -> ONE ISO-2 market, or null. A carrier may be a single value (`"us"`), a
 * list (`"US,SG"`, `"US SG"`, `"US;US"`, `["US", "SG"]` — search scopes are legitimately
 * multi-valued), or garbage. It yields a market ONLY when EVERY entry normalises to ISO-2 AND the
 * entries reduce to EXACTLY ONE distinct market:
 *
 *   "us" -> US      "US,US" -> US      "US, us" -> US
 *   "US,SG" -> null (two markets: which one is the buyer's is not ours to guess)
 *   "USA" -> null   "US,USA" -> null (an entry we cannot read is not ignored)   "" -> null
 *
 * Taking the FIRST entry of "US,SG" would gate an SG buyer against the US fact — the
 * wrong-market answer that looks like an answer.
 */
function carrierMarket(value) {
  let entries;
  if (Array.isArray(value)) entries = value;
  else if (typeof value === 'string') entries = value.split(/[\s,;|]+/);
  else return null;
  entries = entries.map((e) => (typeof e === 'string' ? e.trim() : e)).filter((e) => e !== '');
  if (entries.length === 0) return null;
  const markets = new Set();
  for (const entry of entries) {
    const market = typeof entry === 'string' ? normalizeMarket(entry) : null;
    if (!market) return null;
    markets.add(market);
  }
  return markets.size === 1 ? [...markets][0] : null;
}

/**
 * THE BUYER MARKET FROM A REQUEST'S CARRIERS, in the caller's precedence order: the FIRST carrier
 * that yields a market (`carrierMarket`) wins, and a carrier that does not — absent, blank,
 * "USA", "US,SG" — is SKIPPED, not decisive. So `{search: {market: "USA"}, market: "US"}` is US.
 * No carrier yields one => `undefined` (unkeyable). NEVER a default. The ONE rule for every door
 * that hands this gate a market (`offersGateBuyerMarket`, `checkoutHandoffResolver.requestBuyerMarket`).
 */
function selectBuyerMarket(...carriers) {
  for (const carrier of carriers) {
    const market = carrierMarket(carrier);
    if (market) return market;
  }
  return undefined;
}

/**
 * The outbound URL. Two query values and no others — the shape a test can assert
 * on rather than a promise in a comment.
 */
function buildFactUrl(baseUrl, domain, market) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  const url = new URL(`${origin}${OPS_PATH}`);
  url.searchParams.set('domain', domain);
  url.searchParams.set('market', market);
  return url.toString();
}

/**
 * The ENFORCEMENT PROBE's URL: the same route with the domain ONLY and no `market` key at
 * all. Since pivota-backend #2352 the route answers that shape with 200 and
 * `reason: market_unknown` (before it, a 422 — which this client reads as a failure and
 * fails open on). The domain is still required by the route (`min_length=3`); it carries no
 * more than the keyed read does, and strictly less.
 */
function buildEnforcementProbeUrl(baseUrl, domain) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  const url = new URL(`${origin}${OPS_PATH}`);
  url.searchParams.set('domain', domain);
  return url.toString();
}

/**
 * Parse the market-less answer. STRICT on purpose: `enforced` is taken from it ONLY when the
 * body says it is the market-unknown answer (`reason === 'market_unknown'` and
 * `tier === 'browse_only'`). A body that is anything else — an old backend, a proxy page, a
 * keyed answer nobody asked for — is `null`, i.e. a failure, i.e. fail OPEN. A loose parse
 * here would be the one place a malformed body could turn into a refusal.
 */
function parseEnforcementProbe(body) {
  if (!isPlainObject(body)) return null;
  if (body.reason !== REASON_MARKET_UNKNOWN) return null;
  if (typeof body.tier !== 'string' || body.tier.trim() !== TIER_BROWSE_ONLY) return null;
  if (typeof body.enforced !== 'boolean') return null;
  const sweepEnabled = typeof body.sweep_enabled === 'boolean' ? body.sweep_enabled : null;
  return { tier: TIER_BROWSE_ONLY, enforced: body.enforced, sweep_enabled: sweepEnabled };
}

/**
 * Read the fields this gateway is allowed to act on, and NOTHING else. An
 * allow-list rather than a spread: a field the backend adds later cannot start
 * steering this decision because somebody forgot it existed.
 *
 * `tier` is compared by EQUALITY against the two strings the route documents.
 * Not `startsWith`, not `includes`, not a truthiness test: a loose compare is how
 * a future `browse_only_pending` would read as browse-only (or a
 * `purchase_blocked` as purchase) without anyone choosing that.
 */
function parseFact(body) {
  if (!isPlainObject(body)) return null;
  const tier = typeof body.tier === 'string' ? body.tier.trim() : null;
  if (tier !== TIER_PURCHASE && tier !== TIER_BROWSE_ONLY) return null;
  if (typeof body.enforced !== 'boolean') return null;
  const sweepEnabled = typeof body.sweep_enabled === 'boolean' ? body.sweep_enabled : null;
  return { tier, enforced: body.enforced, sweep_enabled: sweepEnabled };
}

/**
 * The decision, as a pure function of a parsed fact. Separated from the fetch so
 * the rule can be tested without a transport, and so there is exactly one place
 * where `enforced` gates `tier`.
 */
function decide(fact) {
  if (!fact) return { offer: true, source: SOURCE.failed };
  if (fact.enforced !== true) return { offer: true, source: SOURCE.previous };
  return { offer: fact.tier !== TIER_BROWSE_ONLY, source: SOURCE.gate };
}

/**
 * The decision for an UNKEYABLE request, as a pure function of what is known about
 * enforcement. `enforced` is `true`, `false`, or anything else (`null`/`undefined`: not known —
 * the probe failed, could not be asked, or nothing is cached).
 *
 * ⚠️ ONLY A LITERAL `true` REFUSES. Unknown is NOT enforced: an absent, stale or failed
 * enforcement read resolves to the previous behaviour (`source: 'failed'`), exactly as every
 * other non-answer in this module does. Defaulting unknown to "enforced" would be the second
 * fail-closed layer rule 4 forbids — one backend blip would take every market-less click cold.
 */
function decideUnkeyable(enforced, reason = REASON_MARKET_UNKNOWN) {
  if (enforced === true) return { offer: false, source: SOURCE.unkeyable_enforced, reason };
  if (enforced === false) return { offer: true, source: SOURCE.unkeyable_unenforced, reason };
  return { offer: true, source: SOURCE.failed, reason };
}

/**
 * Bounded TTL cache. Same shape as `ucpWarmHandoff.createTtlCache` and for the
 * same reasons; kept local so this module has no dependency on the warm-handoff
 * lane it gates.
 */
function createTtlCache({ maxEntries = DEFAULT_CACHE_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt != null && now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (store.has(key)) store.delete(key);
      // A NON-POSITIVE OR NON-FINITE TTL MEANS "DO NOT CACHE", NOT "CACHE FOREVER".
      // The shape this was copied from (`ucpWarmHandoff.createTtlCache`) stores such an
      // entry with `expiresAt: null`, i.e. immortal — which on THIS cache would pin a
      // merchant's tier for the life of the process the moment a TTL computed to 0.
      // That is the opposite of what a 0 means everywhere else in this rail: the backend
      // runbook says a TTL of 0 must never be read as "never expires", because it would
      // make every fact permanent rather than instant.
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
      const expiresAt = now() + ttlMs;
      store.set(key, { value, expiresAt });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    delete(key) { store.delete(key); },
    get size() { return store.size; },
    clear() { store.clear(); },
  };
}

/**
 * @param {{
 *   env?: object,
 *   baseUrl?: string,
 *   token?: string,              // static admin JWT; the DEV FALLBACK rail
 *   oidcAudience?: string,       // overrides PIVOTA_OPS_OIDC_AUDIENCE
 *   idTokenProvider?: { getToken: () => Promise<string|null> },
 *   metadataFetchImpl?: Function,// transport for the METADATA server only, never the backend
 *   fetchImpl?: Function,
 *   logger?: { warn?: Function, info?: Function, error?: Function },
 *   timeoutMs?: number,          // capped at MAX_TIMEOUT_MS
 *   ttlMs?: number,              // capped at MAX_TTL_MS
 *   negativeTtlMs?: number,      // also capped at MAX_TTL_MS
 *   cacheMaxEntries?: number,
 *   now?: () => number,
 * }} [deps]
 */
function createMerchantPurchasabilityClient(deps = {}) {
  const env = isPlainObject(deps.env) ? deps.env : process.env;
  // `logger: null` is an EXPLICIT choice (a test asking for silence) and is honoured.
  // An ABSENT key is not a choice — it is the prod shape, and it gets the real logger.
  const logger = Object.prototype.hasOwnProperty.call(deps, 'logger')
    ? (deps.logger || null)
    : defaultLogger();
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : global.fetch;

  // `Math.min` on BOTH, so a caller (or a future config read) can shorten these and
  // can never widen them past what the runbook allows.
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS,
  );
  const ttlMs = Math.min(
    MAX_TTL_MS,
    Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? Number(deps.ttlMs) : DEFAULT_TTL_MS,
  );
  const negativeTtlMs = Math.min(
    MAX_TTL_MS,
    Number.isFinite(deps.negativeTtlMs) && deps.negativeTtlMs > 0
      ? Number(deps.negativeTtlMs)
      : DEFAULT_NEGATIVE_TTL_MS,
  );
  const cache = createTtlCache({
    maxEntries: Number.isFinite(deps.cacheMaxEntries) && deps.cacheMaxEntries > 0
      ? Number(deps.cacheMaxEntries)
      : DEFAULT_CACHE_MAX_ENTRIES,
    now,
  });
  // THE ENFORCEMENT FLAG, learned without a market (see `fetchEnforcement`). One key; same TTL
  // ceilings as the facts. Values: `true` / `false` / `null` (a failed read, negative-cached).
  const enforcementCache = createTtlCache({ maxEntries: 1, now });
  // FRESHNESS. Every read that can carry `enforced` (a keyed fact read or the market-less probe)
  // takes a ticket from this counter when it STARTS; a result is written only if no read that
  // started LATER has already written. Without it a slow probe that started before a keyed read
  // could land after it and pin a stale `enforced` for another five minutes.
  let enforcementReadSeq = 0;
  let enforcementWrittenSeq = 0;
  // SINGLE-FLIGHT. At most one market-less probe in flight per client: a cold cache under a burst
  // of market-less requests (a click storm, an offers page at concurrency 4) costs ONE read.
  let enforcementInFlight = null;
  // Rate limiters for the "say it once" logs. Bounded by the same cache shape.
  const logGuards = createTtlCache({ maxEntries: DEFAULT_CACHE_MAX_ENTRIES, now });

  function note(level, event, detail) {
    if (logger && typeof logger[level] === 'function') {
      try { logger[level]({ event, ...detail }); } catch { /* logging must never throw the lane */ }
    }
  }

  /** Emit `event` at most once per LOG_INTERVAL_MS per key. */
  function noteOnce(level, event, key, detail) {
    const guardKey = `${event}\u0000${key}`;
    if (logGuards.get(guardKey) !== undefined) return;
    logGuards.set(guardKey, true, LOG_INTERVAL_MS);
    note(level, event, detail);
  }

  function baseUrl() {
    return String(deps.baseUrl || (env && env[BASE_URL_ENV]) || '').trim();
  }

  /** The DEV FALLBACK: a static admin JWT from the environment (or injected for a test). */
  function staticToken() {
    return String(deps.token || (env && env[OPS_TOKEN_ENV]) || '').trim();
  }

  /** The configured audience, if any. Its PRESENCE is what switches the rail. */
  function oidcAudience() {
    return String(deps.oidcAudience || (env && env[OIDC_AUDIENCE_ENV]) || '').trim();
  }

  // Built once per client, lazily — so a process that never arms the audience never constructs
  // a metadata client, and a test can inject one.
  let identityProviderInstance;
  function identityProvider() {
    if (identityProviderInstance === undefined) {
      if (deps.idTokenProvider && typeof deps.idTokenProvider.getToken === 'function') {
        identityProviderInstance = deps.idTokenProvider;
      } else {
        identityProviderInstance = createRefreshingCloudRunIdTokenProvider({
          audience: oidcAudience(),
          // The METADATA transport, deliberately separate from `fetchImpl`: `fetchImpl` is the
          // BACKEND transport, and a test that stubs the backend must not thereby find itself
          // stubbing the metadata server too (nor the reverse in production, where a proxy or a
          // retry wrapper on one has no business wrapping the other).
          fetchImpl: typeof deps.metadataFetchImpl === 'function' ? deps.metadataFetchImpl : global.fetch,
          now,
        });
      }
    }
    return identityProviderInstance;
  }

  /**
   * The credential for one read, as `{ value, rail }`, or `null` for "not configured".
   *
   * NEVER THROWS. Every failure is a step down the chain, and the bottom of the chain is the
   * previous behaviour — because rule 4 is not suspended for auth. A gate that REFUSED a
   * purchase because it could not authenticate itself would be the fail-closed second layer
   * this whole module exists to avoid.
   */
  async function resolveCredential() {
    const audience = oidcAudience();
    if (audience) {
      let identity = null;
      try {
        identity = await identityProvider().getToken();
      } catch {
        identity = null;
      }
      if (identity) return { value: identity, rail: 'gateway_identity' };
      noteOnce('warn', 'merchant_purchasability_identity_unavailable', 'global', {
        audience,
        has_static_fallback: Boolean(staticToken()),
        detail: 'the audience is configured but the Cloud Run metadata server did not answer with '
          + 'an identity. On a deployed revision that is an ARMING MISTAKE (a wrong audience, or '
          + 'the service account lacking the role); off GCP it is simply local dev. Falling back.',
      });
    }
    const fallback = staticToken();
    if (fallback) return { value: fallback, rail: 'static_admin_jwt' };
    return null;
  }

  /**
   * The backend's `sweep_enabled: false` with `enforced: true` is the MISORDERED
   * ARMING state: the consumers refuse while nothing gathers facts anywhere, so
   * every merchant ages out to browse_only one by one. It is not this gateway's to
   * fix — the dials live on the backend and the worker — but it is exactly the
   * state where somebody needs to be told before the catalogue drains.
   */
  function noteMisorderedArming(fact, domain, market) {
    if (!fact || fact.enforced !== true || fact.sweep_enabled !== false) return;
    noteOnce('error', 'merchant_purchasability_misordered_arming', `${domain}\u0000${market}`, {
      domain,
      market,
      enforced: true,
      sweep_enabled: false,
      detail: 'backend is ENFORCING with the sweep DISABLED: facts are not being refreshed and every '
        + 'merchant will age out to browse_only through the TTL. Arm MERCHANT_PURCHASABILITY_SWEEP_ENABLED '
        + 'on the WORKER, or unset MERCHANT_PURCHASABILITY_ENFORCE.',
    });
  }

  /**
   * THE ONE DEADLINE. Every backend read in this module — the keyed fact read and the
   * market-less enforcement probe alike — runs inside this, so the probe cannot have a budget
   * of its own: it is capped at `min(timeoutMs, budgetMs)` exactly as the fact read is, and
   * a request makes AT MOST ONE of the two reads (keyable -> fact, unkeyable -> probe), so the
   * caller's window is never spent twice.
   *
   * ⚠️ THE DEADLINE STARTS HERE, NOT AFTER THE CREDENTIAL. Review of the first cut: the timer was
   * created AFTER `await resolveCredential()`, so the metadata server's own 1 s ceiling sat
   * OUTSIDE both this module's `timeoutMs` and the caller's `budgetMs` — a caller that handed us
   * 300 ms could still wait 1300 ms. A budget with a step outside it is not a budget. The
   * controller is armed first and the credential is resolved INSIDE its window.
   */
  function callTimeoutFor(budgetMs) {
    return Number.isFinite(budgetMs) && budgetMs > 0
      ? Math.min(timeoutMs, Math.floor(budgetMs))
      : timeoutMs;
  }

  async function withinDeadline(budgetMs, body) {
    const controller = new AbortController();
    // ⚠️ THIS TIMER IS DELIBERATELY **NOT** `unref()`d, AND THAT IS NOT AN OVERSIGHT.
    // It is the ONLY thing that can settle the promise this function returns when the backend
    // hangs: the read is awaiting a fetch that resolves on nothing but this abort. An unref'd
    // timer does not hold the event loop open, so with nothing else ref'd node drains the loop
    // and EXITS with that promise still pending — which under `node --test
    // --test-isolation=process` (what CI runs) is reported as `cancelledByParent` /
    // "Promise resolution is still pending but the event loop has already resolved", and takes
    // every later test in the file with it. Measured: 46 cancelled on `780bc075`.
    // The timer is bounded (<= MAX_TIMEOUT_MS) and cleared in the `finally` below, so holding the
    // loop for its duration is exactly as long as the caller is waiting anyway — not a leak.
    // Same rule, same reasoning, already written down in
    // `src/services/merchantVariantSource.js` ("The timer is deliberately NOT `unref()`d").
    const timer = setTimeout(() => controller.abort(), callTimeoutFor(budgetMs));
    try {
      return await body(controller);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One authenticated GET against the ops route, entirely inside `controller`'s deadline.
   * Returns `{ value }` (the parser's non-null answer) or `{ failure }`. NEVER throws.
   * `failure === 'not_configured'` has already been logged here; every other failure is the
   * caller's to log, with its own key.
   */
  async function opsGet(controller, buildUrl, parse) {
    const origin = baseUrl();
    let authorization = null;
    try {
      // RACED AGAINST THE DEADLINE. `resolveCredential` takes no signal of its own (the metadata
      // client owns its 1 s ceiling), so an abort resolves this to `null` and the read becomes the
      // ordinary "unconfigured" previous behaviour instead of blowing the budget.
      authorization = await Promise.race([
        resolveCredential(),
        new Promise((resolve) => {
          if (controller.signal.aborted) { resolve(null); return; }
          controller.signal.addEventListener('abort', () => resolve(null), { once: true });
        }),
      ]);
    } catch {
      // Belt and braces: `resolveCredential` is written not to throw, and if it ever does the
      // answer is still the previous behaviour rather than an exception on the checkout path.
      authorization = null;
    }
    if (!origin || !authorization || typeof fetchImpl !== 'function') {
      // Unconfigured is not an outage and not a refusal. Said once so an operator
      // who armed the switch without the credential finds out from a log rather
      // than from the gate silently never firing.
      //
      // BOOLEANS AND A RAIL NAME ONLY. Note there is no field whose NAME contains "token"
      // either: a leak test greps every emitted line for that word, and a field named for a
      // credential is one refactor away from carrying one.
      noteOnce('warn', 'merchant_purchasability_not_configured', 'global', {
        has_base_url: Boolean(origin),
        has_authorization: Boolean(authorization),
        oidc_configured: Boolean(oidcAudience()),
        has_fetch: typeof fetchImpl === 'function',
        detail: `${GATE_FLAG_ENV} is on but the ops read is unconfigured; keeping the previous behaviour.`,
      });
      return { failure: 'not_configured' };
    }

    let url;
    try {
      url = buildUrl(origin);
    } catch {
      return { failure: 'bad_url' };
    }

    // THE CALLER'S REMAINING WINDOW is applied by `withinDeadline`, which arms the deadline
    // BEFORE the credential step. The click lane runs on a 2000 ms total budget
    // (`UCP_WARM_HANDOFF_CLICK_BUDGET_MS`) inside the backend's 2.5 s `wait_for`, and an
    // unclamped gate spending its own 1500 ms default first leaves the cart it is gating unable
    // to finish. A gate that turns fail-open into a cold redirect catalogue-wide has failed open
    // in name only. Same shape as `buildPreview`'s `previewRemainingMs` in ucpWarmHandoff.js.
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          // Bearer, NOT X-ADMIN-KEY: this ops route depends on
          // `require_admin_or_gateway_identity` and deliberately not on
          // `require_admin_or_key`, so the header rail this repo uses elsewhere
          // would 401 and look like a routing problem. Both rails — the Google
          // identity token and the static admin JWT — travel in this same header;
          // the backend tells them apart itself.
          authorization: `Bearer ${authorization.value}`,
        },
        signal: controller.signal,
      });
      if (!response || response.ok !== true) {
        return { failure: `status_${response && response.status ? response.status : 'unknown'}` };
      }
      const value = parse(await response.json());
      return value ? { value } : { failure: 'malformed_body' };
    } catch (error) {
      // A timeout arrives here as an AbortError. Deliberately not distinguished
      // in the OUTCOME — every one of them is the previous behaviour — only in
      // the log, so an operator can tell a slow backend from a broken one.
      return { failure: controller.signal.aborted ? 'timeout' : `threw_${(error && error.name) || 'Error'}` };
    }
  }

  /**
   * One read, cached. Returns a parsed fact or `null`. NEVER throws and never
   * rejects: every failure path is a `null`, which `decide` turns into the
   * previous behaviour.
   */
  async function fetchFact(domain, market, budgetMs) {
    const key = `${domain}\u0000${market}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const enforcementTicket = ++enforcementReadSeq;
    return withinDeadline(budgetMs, async (controller) => {
      const { value: fact, failure } = await opsGet(
        controller,
        (origin) => buildFactUrl(origin, domain, market),
        parseFact,
      );
      if (failure) {
        if (failure !== 'not_configured' && failure !== 'bad_url') {
          noteOnce('warn', 'merchant_purchasability_read_failed', `${key}\u0000${failure}`, {
            domain, market, failure,
            detail: 'failing OPEN to the previous behaviour; the backend already fails closed and two '
              + 'fail-closed layers turn a blip into an outage.',
          });
        }
        cache.set(key, null, negativeTtlMs);
        // A FAILED keyed read says nothing about the dial, so it does NOT touch the enforcement
        // cache: a known `enforced` survives it (pinned by a test).
        return null;
      }
      noteMisorderedArming(fact, domain, market);
      cache.set(key, fact, ttlMs);
      // `enforced` is ONE backend-wide dial, and every keyed answer carries it — so a keyed read
      // is also a fresh enforcement read, and an unkeyable request right after it need not probe.
      // Same TTL ceiling as the fact it came with; written only if nothing newer already was.
      writeEnforcement(enforcementTicket, fact.enforced);
      return fact;
    });
  }

  /**
   * IS THE BACKEND ENFORCING? — learned WITHOUT a market. Returns `true`, `false`, or `null`
   * (not known). NEVER throws.
   *
   * Cache first (≤ 5 minutes, one global key: the dial is backend-wide). On a miss, the
   * market-less probe `GET /ops/merchant-purchasability?domain=<domain>` (pivota-backend #2352
   * answers it 200 with `reason: market_unknown` and the live `enforced`). A failed probe is
   * cached as `null` for the NEGATIVE TTL only, so a backend that is down costs one timeout
   * per 30 s rather than one per request, and recovery is picked up just as fast.
   *
   * ⚠️ `null` IS NOT `true`. An absent, expired or failed read is "not known", which
   * `decideUnkeyable` resolves to the previous behaviour. Nothing here defaults to enforced.
   *
   * The route requires a domain, so a request with NO domain either reads the cache (or joins a
   * probe already in flight) or answers `null` — it is not given a made-up domain to ask with.
   *
   * SINGLE-FLIGHT and FRESHEST-WINS: see `enforcementInFlight` and `writeEnforcement`.
   */
  async function fetchEnforcement(domain, budgetMs) {
    const cached = enforcementCache.get(ENFORCEMENT_CACHE_KEY);
    if (cached !== undefined) return cached;
    // SINGLE-FLIGHT: a probe is already out — wait for IT, inside THIS caller's own deadline. A
    // caller whose deadline expires first gets `null` (not known => fail open), exactly as its own
    // timed-out probe would have given it; the shared probe keeps running for everyone else.
    if (enforcementInFlight) return awaitWithinDeadline(enforcementInFlight, budgetMs);
    if (!domain) return null;

    const ticket = ++enforcementReadSeq;
    const probe = withinDeadline(budgetMs, (controller) => runEnforcementProbe(controller, domain, ticket))
      .catch(() => null) // `runEnforcementProbe` does not throw; the share must never reject either
      .finally(() => { if (enforcementInFlight === probe) enforcementInFlight = null; });
    enforcementInFlight = probe;
    return probe;
  }

  async function runEnforcementProbe(controller, domain, ticket) {
    const { value: probe, failure } = await opsGet(
      controller,
      (origin) => buildEnforcementProbeUrl(origin, domain),
      parseEnforcementProbe,
    );
    if (failure) {
      if (failure !== 'not_configured' && failure !== 'bad_url') {
        noteOnce('warn', 'merchant_purchasability_enforcement_read_failed', failure, {
          domain, failure,
          detail: 'the market-less enforcement read failed, so enforcement is NOT KNOWN and a request '
            + 'with no market keeps the previous behaviour (fail OPEN). A status_422 here means the '
            + 'backend predates pivota-backend #2352.',
        });
      }
      return writeEnforcement(ticket, null);
    }
    noteMisorderedArming(probe, domain, '?');
    return writeEnforcement(ticket, probe.enforced);
  }

  /**
   * Write one enforcement answer, FRESHEST WINS, and return the value the caller should act on.
   *
   *   - a result from a read that started BEFORE the one that last wrote is dropped (the newer
   *     answer stays cached, and is what the caller gets back);
   *   - a failure (`null`) never erases a KNOWN value — a failed read says nothing about the dial;
   *   - otherwise: a boolean for the TTL (≤ 5 min), a failure for the negative TTL (30 s).
   */
  function writeEnforcement(ticket, value) {
    const cached = enforcementCache.get(ENFORCEMENT_CACHE_KEY);
    if (ticket < enforcementWrittenSeq) return cached !== undefined ? cached : value;
    if (value === null && typeof cached === 'boolean') return cached;
    enforcementWrittenSeq = ticket;
    enforcementCache.set(ENFORCEMENT_CACHE_KEY, value, value === null ? negativeTtlMs : ttlMs);
    return value;
  }

  /**
   * Await a promise the caller did not start, bounded by the caller's OWN deadline
   * (`min(timeoutMs, budgetMs)`, the same clamp as every read). Resolves `null` on expiry.
   * ⚠️ NOT `unref()`d, for the reason written on `withinDeadline`: when the shared read hangs,
   * this timer is the only thing that settles this caller.
   */
  function awaitWithinDeadline(promise, budgetMs) {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), callTimeoutFor(budgetMs));
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * THE DECISION HELPER. `{ offer, source }` (plus `reason` on an unkeyable request) and
   * nothing else — a caller that only reads `offer` gets the safe answer, and `source` is
   * there so a log or a metric can tell "the gate said no" apart from "we never asked".
   * The full table is in the header of this file.
   *
   * @param {{ domain: string, market: string, budgetMs?: number }} args
   * @returns {Promise<{ offer: boolean, source: string, reason?: string }>}
   */
  async function shouldOfferPurchase({ domain, market, budgetMs } = {}) {
    if (!isGateEnabled(env)) return { offer: true, source: SOURCE.disabled };

    // THE BUDGET FLOOR. A caller on a wall-clock budget (the click lane runs on 2000 ms
    // inside the backend's 2.5 s `wait_for`) hands us what is LEFT. Below the floor there is
    // no useful question to ask: the read cannot complete, and the milliseconds it burns
    // failing come out of the cart the lane still has to build. Skipping is the previous
    // behaviour, which is what every other non-answer here resolves to. It applies to the
    // enforcement probe exactly as to the keyed read: it is checked before either.
    if (Number.isFinite(budgetMs) && budgetMs < MIN_GATE_BUDGET_MS) {
      noteOnce('info', 'merchant_purchasability_skipped_budget', String(domain || '?'), {
        budget_ms: Math.max(0, Math.floor(budgetMs)),
        floor_ms: MIN_GATE_BUDGET_MS,
        detail: "too little of the caller's budget left to ask; keeping the previous behaviour.",
      });
      return { offer: true, source: SOURCE.skipped_budget };
    }

    const normalizedDomain = normalizeDomain(domain);
    // THE MARKET IS THE REQUEST'S, OR THERE IS NO FACT TO READ. There is no
    // fallback to a configured or server-egress default: the fact is keyed on the
    // BUYER's market, and answering with the market our egress happens to sit in
    // is answering a question nobody asked (runbook §6 — judydoll.com resets TCP
    // from one of our egresses while answering through another).
    const normalizedMarket = normalizeMarket(market);
    if (!normalizedDomain || !normalizedMarket) {
      return decideUnkeyableRequest(normalizedDomain, normalizedMarket, budgetMs);
    }

    const fact = await fetchFact(normalizedDomain, normalizedMarket, budgetMs);
    const decision = decide(fact);

    if (decision.source === SOURCE.previous) {
      noteOnce('info', 'merchant_purchasability_not_enforced', `${normalizedDomain}\u0000${normalizedMarket}`, {
        domain: normalizedDomain,
        market: normalizedMarket,
        tier: fact ? fact.tier : null,
        detail: 'backend reports enforced=false; `tier` is browse_only for EVERY merchant in that state, '
          + 'so it is not consulted. Keeping the previous behaviour.',
      });
    } else if (decision.source === SOURCE.gate && decision.offer === false) {
      note('warn', 'merchant_purchasability_browse_only', {
        domain: normalizedDomain,
        market: normalizedMarket,
        tier: fact.tier,
        detail: 'no fresh positive card-payment fact for this merchant in this market; purchase not offered.',
      });
    }

    return decision;
  }

  /**
   * The UNKEYABLE branch: no (domain, market) key, so no fact can be read. Under enforcement
   * that is a decline (no fact => no positive fact => browse-only); otherwise, and whenever
   * enforcement is not known, the previous behaviour.
   */
  async function decideUnkeyableRequest(normalizedDomain, normalizedMarket, budgetMs) {
    const reason = normalizedMarket ? REASON_DOMAIN_UNKNOWN : REASON_MARKET_UNKNOWN;
    // WARN, not info. A caller that never sends a market is the commonest way this gate is
    // inert (unenforced) or declines (enforced) on a whole lane — the click lane's caller
    // (pivota-backend `services/outbound_warm_handoff.py`) sends a market only when it OBSERVED
    // one. Either way somebody should be able to see it.
    noteOnce('warn', 'merchant_purchasability_unkeyable', `${normalizedDomain || '?'}\u0000${normalizedMarket || '?'}`, {
      has_domain: Boolean(normalizedDomain),
      has_market: Boolean(normalizedMarket),
      reason,
      detail: 'no (domain, market) key for this request, so there is no purchasability fact for it. '
        + 'Under enforcement that means browse-only; unenforced or unknown, the previous behaviour.',
    });
    let enforced = null;
    try {
      enforced = await fetchEnforcement(normalizedDomain, budgetMs);
    } catch {
      enforced = null; // `fetchEnforcement` does not throw; if it ever does, fail OPEN
    }
    const decision = decideUnkeyable(enforced, reason);
    if (decision.source === SOURCE.unkeyable_enforced) {
      // Once per interval per merchant, NOT once per request: under enforcement a lane whose
      // caller sends no market declines on every click, and a per-click line would storm.
      noteOnce('warn', 'merchant_purchasability_browse_only', `${normalizedDomain || '?'}\u0000${reason}`, {
        domain: normalizedDomain,
        market: normalizedMarket,
        reason,
        detail: 'the backend is ENFORCING and this request names no usable market, so no purchasability '
          + 'fact can exist for it; purchase not offered (browse and links-out are unchanged).',
      });
    }
    return decision;
  }

  return {
    shouldOfferPurchase,
    fetchFact,
    fetchEnforcement,
    // exposed for observability/tests; hold facts / the enforcement flag only — never a
    // credential, never buyer data.
    _cache: cache,
    _enforcementCache: enforcementCache,
  };
}

/**
 * Process-wide singleton, so ONE bounded cache serves every call site.
 *
 * ⚠️ A `logger` IS NOT AN ISOLATION REQUEST. The first cut forked a fresh client for ANY
 * deps at all, and the warm-handoff service's construction expression then discarded the
 * logger entirely on the prod shape — so the singleton was built with `logger: null` and
 * the `error`-level misordered-arming alarm could never reach a log anywhere. A logger
 * changes where events GO; it does not change what is cached, so it configures the
 * singleton rather than forking one. Anything that DOES change the answer — an injected
 * env, transport, clock, credential or TTL — forks, because a test must never write into
 * the cache the rest of the process reads.
 */
let singleton = null;
const ISOLATING_KEYS = Object.freeze([
  'env', 'fetchImpl', 'now', 'ttlMs', 'negativeTtlMs', 'timeoutMs', 'cacheMaxEntries', 'baseUrl', 'token',
  // The OIDC rail's three. All of them change the ANSWER (which credential is sent, and to a
  // stubbed metadata server or the real one), so all of them must fork rather than configure the
  // process singleton — same rule as `token` above, for the same reason.
  'oidcAudience', 'idTokenProvider', 'metadataFetchImpl',
]);

function isIsolatingDeps(deps) {
  return isPlainObject(deps)
    && ISOLATING_KEYS.some((k) => Object.prototype.hasOwnProperty.call(deps, k));
}

function getMerchantPurchasabilityClient(deps) {
  if (isIsolatingDeps(deps)) return createMerchantPurchasabilityClient(deps);
  if (!singleton) singleton = createMerchantPurchasabilityClient(isPlainObject(deps) ? deps : {});
  return singleton;
}

/** Tests only: drop the process singleton so the next call rebuilds it. */
function resetMerchantPurchasabilityClientForTest() {
  singleton = null;
}

/**
 * Module-level convenience with the singleton's cache. This is what the seam calls.
 * @returns {Promise<{ offer: boolean, source: string, reason?: string }>}
 */
async function shouldOfferPurchase(args, deps) {
  return getMerchantPurchasabilityClient(deps).shouldOfferPurchase(args || {});
}

module.exports = {
  MIN_GATE_BUDGET_MS,
  ISOLATING_KEYS,
  isIsolatingDeps,
  resetMerchantPurchasabilityClientForTest,
  GATE_FLAG_ENV,
  OPS_TOKEN_ENV,
  OIDC_AUDIENCE_ENV,
  BASE_URL_ENV,
  OPS_PATH,
  MAX_TIMEOUT_MS,
  MAX_TTL_MS,
  TIER_PURCHASE,
  TIER_BROWSE_ONLY,
  SOURCE,
  isGateEnabled,
  normalizeDomain,
  normalizeMarket,
  carrierMarket,
  selectBuyerMarket,
  REASON_MARKET_UNKNOWN,
  REASON_DOMAIN_UNKNOWN,
  buildFactUrl,
  buildEnforcementProbeUrl,
  parseFact,
  parseEnforcementProbe,
  decide,
  decideUnkeyable,
  createTtlCache,
  createMerchantPurchasabilityClient,
  getMerchantPurchasabilityClient,
  shouldOfferPurchase,
};
