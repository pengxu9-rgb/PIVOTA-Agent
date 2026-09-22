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
  /** the caller's remaining wall-clock budget was too small to ask — previous behaviour */
  skipped_budget: 'skipped_budget',
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
  // Rate limiters for the two "say it once" logs. Bounded by the same cache shape.
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
   * One read, cached. Returns a parsed fact or `null`. NEVER throws and never
   * rejects: every failure path is a `null`, which `decide` turns into the
   * previous behaviour.
   */
  async function fetchFact(domain, market, budgetMs) {
    const key = `${domain}\u0000${market}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const origin = baseUrl();
    let authorization = null;
    try {
      authorization = await resolveCredential();
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

    // THE CALLER'S REMAINING WINDOW, not just this module's own ceiling. Reviewed
    // against the live numbers: the click lane runs on a 2000 ms total budget
    // (`UCP_WARM_HANDOFF_CLICK_BUDGET_MS`) inside the backend's 2.5 s `wait_for`, and
    // an unclamped gate spending its own 1500 ms default first leaves the cart it is
    // gating unable to finish. A gate that turns fail-open into a cold redirect
    // catalogue-wide has failed open in name only. Same shape as `buildPreview`'s
    // `previewRemainingMs` in ucpWarmHandoff.js, and for the same reason.
    const callTimeoutMs = Number.isFinite(budgetMs) && budgetMs > 0
      ? Math.min(timeoutMs, Math.floor(budgetMs))
      : timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeoutMs);
    let fact = null;
    let failure = null;
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
      noteOnce('warn', 'merchant_purchasability_read_failed', `${key}\u0000${failure}`, {
        domain, market, failure, timeout_ms: callTimeoutMs,
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
  async function shouldOfferPurchase({ domain, market, budgetMs } = {}) {
    if (!isGateEnabled(env)) return { offer: true, source: SOURCE.disabled };

    // THE BUDGET FLOOR. A caller on a wall-clock budget (the click lane runs on 2000 ms
    // inside the backend's 2.5 s `wait_for`) hands us what is LEFT. Below the floor there is
    // no useful question to ask: the read cannot complete, and the milliseconds it burns
    // failing come out of the cart the lane still has to build. Skipping is the previous
    // behaviour, which is what every other non-answer here resolves to.
    if (Number.isFinite(budgetMs) && budgetMs < MIN_GATE_BUDGET_MS) {
      noteOnce('info', 'merchant_purchasability_skipped_budget', String(domain || '?'), {
        budget_ms: Math.max(0, Math.floor(budgetMs)),
        floor_ms: MIN_GATE_BUDGET_MS,
        detail: "too little of the caller's budget left to ask; keeping the previous behaviour.",
      });
      return { offer: true, source: SOURCE.skipped_budget };
    }

    const normalizedDomain = normalizeDomain(domain);
    // THE MARKET IS THE REQUEST'S, OR THERE IS NO QUESTION TO ASK. There is no
    // fallback to a configured or server-egress default: the fact is keyed on the
    // BUYER's market, and answering with the market our egress happens to sit in
    // is answering a question nobody asked (runbook §6 — judydoll.com resets TCP
    // from one of our egresses while answering through another). A request that
    // carries no market keeps the previous behaviour.
    const normalizedMarket = normalizeMarket(market);
    if (!normalizedDomain || !normalizedMarket) {
      // WARN, not info. This is what a MIS-DEPLOYED CALLER looks like from in here. The
      // click lane's only caller (pivota-backend `services/outbound_warm_handoff.py`) does
      // not send a market yet, so until that ships every click-lane request lands here and
      // the gate is inert on the very lane the flowerbeauty incident travelled. An inert
      // gate that logs at `info` is an inert gate nobody notices.
      noteOnce('warn', 'merchant_purchasability_unkeyable', `${normalizedDomain || '?'}\u0000${normalizedMarket || '?'}`, {
        has_domain: Boolean(normalizedDomain),
        has_market: Boolean(normalizedMarket),
        detail: 'no (domain, market) key for this request, so the gate cannot ask anything and keeps '
          + 'the previous behaviour. A caller that never sends `market` opts out of the gate entirely.',
      });
      return { offer: true, source: SOURCE.failed };
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

  return {
    shouldOfferPurchase,
    fetchFact,
    // exposed for observability/tests; holds facts only — never a credential, never buyer data.
    _cache: cache,
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
 * @returns {Promise<{ offer: boolean, source: 'gate'|'previous'|'disabled'|'failed' }>}
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
  buildFactUrl,
  parseFact,
  decide,
  createTtlCache,
  createMerchantPurchasabilityClient,
  getMerchantPurchasabilityClient,
  shouldOfferPurchase,
};
