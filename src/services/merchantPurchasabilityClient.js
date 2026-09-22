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
 * So the credential is READ FROM THE ENVIRONMENT and never minted here:
 * `PIVOTA_OPS_ADMIN_TOKEN` holds an admin/super_admin JWT issued by the backend,
 * and it travels as `Authorization: Bearer <token>`. Unconfigured is not an error
 * and not a refusal — `shouldOfferPurchase` answers `source: 'failed'`, i.e. the
 * previous behaviour, which is what rule 4 requires of every other failure too.
 * This module holds no credential logic beyond reading that string; if this repo
 * ever grows a real ops-JWT caller, point `token` at it and delete the env read.
 *
 * ---- PII -----------------------------------------------------------------------
 *
 * The outbound URL carries EXACTLY two values: a merchant domain and a two-letter
 * market. No buyer, no email, no address, no variant, no cart, no session. The
 * logs carry the same two plus the decision. `assertNoBuyerData` is asserted by a
 * test rather than trusted, because "only domain and market" is the kind of claim
 * that stays true until somebody adds a third argument.
 */

const OPS_PATH = '/ops/merchant-purchasability';

/** The gateway-side kill switch. Default OFF: this ships dark and arms independently of the backend dial. */
const GATE_FLAG_ENV = 'MERCHANT_PURCHASABILITY_GATE_ENABLED';

/** Env carrying an admin/super_admin Bearer JWT for the backend's ops routes. Read, never minted. */
const OPS_TOKEN_ENV = 'PIVOTA_OPS_ADMIN_TOKEN';

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

const TIER_PURCHASE = 'purchase';
const TIER_BROWSE_ONLY = 'browse_only';

/** The four answers, and what each one means to a caller. */
const SOURCE = Object.freeze({
  /** the gateway switch is off — nothing was asked, nothing changed */
  disabled: 'disabled',
  /** the backend answered and IS enforcing — `offer` is the gate's decision */
  gate: 'gate',
  /** the backend answered and is NOT enforcing — keep the previous behaviour */
  previous: 'previous',
  /** nothing usable came back — keep the previous behaviour (fail OPEN) */
  failed: 'failed',
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
      const expiresAt = Number.isFinite(ttlMs) && ttlMs > 0 ? now() + ttlMs : null;
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
 *   token?: string,
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
  const logger = deps.logger || null;
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
  // Rate limiters for the two "say it once" logs. Bounded by the same cache shape.
  const logGuards = createTtlCache({ maxEntries: DEFAULT_CACHE_MAX_ENTRIES, now });

  function note(level, event, detail) {
    if (logger && typeof logger[level] === 'function') {
      try { logger[level]({ event, ...detail }); } catch { /* logging must never throw the lane */ }
    }
  }

  /** Emit `event` at most once per LOG_INTERVAL_MS per key. */
  function noteOnce(level, event, key, detail) {
    const guardKey = `${event} ${key}`;
    if (logGuards.get(guardKey) !== undefined) return;
    logGuards.set(guardKey, true, LOG_INTERVAL_MS);
    note(level, event, detail);
  }

  function baseUrl() {
    return String(deps.baseUrl || (env && env[BASE_URL_ENV]) || '').trim();
  }

  function token() {
    return String(deps.token || (env && env[OPS_TOKEN_ENV]) || '').trim();
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
    noteOnce('error', 'merchant_purchasability_misordered_arming', `${domain} ${market}`, {
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
   * One read, cached. Returns a parsed fact or `null`. NEVER throws and never
   * rejects: every failure path is a `null`, which `decide` turns into the
   * previous behaviour.
   */
  async function fetchFact(domain, market) {
    const key = `${domain} ${market}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const origin = baseUrl();
    const bearer = token();
    if (!origin || !bearer || typeof fetchImpl !== 'function') {
      // Unconfigured is not an outage and not a refusal. Said once so an operator
      // who armed the switch without the credential finds out from a log rather
      // than from the gate silently never firing.
      noteOnce('warn', 'merchant_purchasability_not_configured', 'global', {
        has_base_url: Boolean(origin),
        has_token: Boolean(bearer),
        has_fetch: typeof fetchImpl === 'function',
        detail: `${GATE_FLAG_ENV} is on but the ops read is unconfigured; keeping the previous behaviour.`,
      });
      cache.set(key, null, negativeTtlMs);
      return null;
    }

    let url;
    try {
      url = buildFactUrl(origin, domain, market);
    } catch {
      cache.set(key, null, negativeTtlMs);
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let fact = null;
    let failure = null;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          // Bearer, NOT X-ADMIN-KEY: these ops routes depend on `require_admin`
          // and deliberately not on `require_admin_or_key`, so the header rail
          // this repo uses elsewhere would 401 and look like a routing problem.
          authorization: `Bearer ${bearer}`,
        },
        signal: controller.signal,
      });
      if (!response || response.ok !== true) {
        failure = `status_${response && response.status ? response.status : 'unknown'}`;
      } else {
        const body = await response.json();
        fact = parseFact(body);
        if (!fact) failure = 'malformed_body';
      }
    } catch (error) {
      // A timeout arrives here as an AbortError. Deliberately not distinguished
      // in the OUTCOME — every one of them is the previous behaviour — only in
      // the log, so an operator can tell a slow backend from a broken one.
      failure = controller.signal.aborted ? 'timeout' : `threw_${(error && error.name) || 'Error'}`;
    } finally {
      clearTimeout(timer);
    }

    if (failure) {
      noteOnce('warn', 'merchant_purchasability_read_failed', `${key} ${failure}`, {
        domain, market, failure, timeout_ms: timeoutMs,
        detail: 'failing OPEN to the previous behaviour; the backend already fails closed and two '
          + 'fail-closed layers turn a blip into an outage.',
      });
      cache.set(key, null, negativeTtlMs);
      return null;
    }

    noteMisorderedArming(fact, domain, market);
    cache.set(key, fact, ttlMs);
    return fact;
  }

  /**
   * THE DECISION HELPER. `{ offer, source }` and nothing else — a caller that only
   * reads `offer` gets the safe answer, and `source` is there so a log or a metric
   * can tell "the gate said no" apart from "we never asked".
   *
   * @param {{ domain: string, market: string }} args
   * @returns {Promise<{ offer: boolean, source: 'gate'|'previous'|'disabled'|'failed' }>}
   */
  async function shouldOfferPurchase({ domain, market } = {}) {
    if (!isGateEnabled(env)) return { offer: true, source: SOURCE.disabled };

    const normalizedDomain = normalizeDomain(domain);
    // THE MARKET IS THE REQUEST'S, OR THERE IS NO QUESTION TO ASK. There is no
    // fallback to a configured or server-egress default: the fact is keyed on the
    // BUYER's market, and answering with the market our egress happens to sit in
    // is answering a question nobody asked (runbook §6 — judydoll.com resets TCP
    // from one of our egresses while answering through another). A request that
    // carries no market keeps the previous behaviour.
    const normalizedMarket = normalizeMarket(market);
    if (!normalizedDomain || !normalizedMarket) {
      noteOnce('info', 'merchant_purchasability_unkeyable', `${normalizedDomain || '?'} ${normalizedMarket || '?'}`, {
        has_domain: Boolean(normalizedDomain),
        has_market: Boolean(normalizedMarket),
        detail: 'no (domain, market) key for this request; keeping the previous behaviour.',
      });
      return { offer: true, source: SOURCE.failed };
    }

    const fact = await fetchFact(normalizedDomain, normalizedMarket);
    const decision = decide(fact);

    if (decision.source === SOURCE.previous) {
      noteOnce('info', 'merchant_purchasability_not_enforced', `${normalizedDomain} ${normalizedMarket}`, {
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

  return {
    shouldOfferPurchase,
    fetchFact,
    // exposed for observability/tests; holds facts only — never a credential, never buyer data.
    _cache: cache,
  };
}

/** Process-wide singleton, so one cache serves every call site. Created lazily. */
let singleton = null;
function getMerchantPurchasabilityClient(deps) {
  if (deps || !singleton) {
    const created = createMerchantPurchasabilityClient(deps);
    if (deps) return created;
    singleton = created;
  }
  return singleton;
}

/**
 * Module-level convenience with the singleton's cache. This is what the seam calls.
 * @returns {Promise<{ offer: boolean, source: 'gate'|'previous'|'disabled'|'failed' }>}
 */
async function shouldOfferPurchase(args, deps) {
  return getMerchantPurchasabilityClient(deps).shouldOfferPurchase(args || {});
}

module.exports = {
  GATE_FLAG_ENV,
  OPS_TOKEN_ENV,
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
  buildFactUrl,
  parseFact,
  decide,
  createTtlCache,
  createMerchantPurchasabilityClient,
  getMerchantPurchasabilityClient,
  shouldOfferPurchase,
};
