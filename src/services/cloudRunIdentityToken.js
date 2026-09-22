'use strict';

/*
 * Cloud Run service-to-service authentication for Store Audit workers.
 *
 * Shared by the commerce probe worker and the UCP probe worker; each passes
 * its own audience (or the env var name it is configured under). The audience
 * is supplied by deployment configuration and must be the exact Cloud Run web
 * service origin. The metadata request is deliberately fixed; it never
 * derives a URL from a merchant or receipt payload.
 */

// Fixed Cloud Run metadata endpoint. Merchant URLs never influence auth.
const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

function cloudRunAudience(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   audience?: string,        // explicit audience; wins over audienceEnvVar
 *   audienceEnvVar?: string,  // env var to read the audience from when `audience` is not supplied
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
function createCloudRunIdTokenProvider({
  audience,
  audienceEnvVar = 'STORE_AUDIT_COMMERCE_PROBE_ID_TOKEN_AUDIENCE',
  fetchImpl = global.fetch,
} = {}) {
  const validAudience = cloudRunAudience(audience != null ? audience : process.env[audienceEnvVar]);
  let pending;
  async function getToken() {
    if (!validAudience || typeof fetchImpl !== 'function') return null;
    if (!pending) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      pending = Promise.resolve(fetchImpl(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(validAudience)}&format=full`, {
        headers: { 'metadata-flavor': 'Google' }, redirect: 'error', signal: controller.signal,
      }))
        .then(async (response) => (response && response.ok ? String(await response.text()).trim() || null : null))
        .catch(() => null)
        .finally(() => clearTimeout(timer));
    }
    return pending;
  }
  return { audience: validAudience, getToken };
}

/*
 * ---- THE REFRESHING VARIANT -------------------------------------------------------------------
 *
 * `createCloudRunIdTokenProvider` above caches its in-flight promise FOREVER: `pending` is set on
 * the first call and never cleared, so the first token a worker mints is the only token it will
 * ever have. That is survivable for a batch worker that outlives one token's hour by accident and
 * is restarted by Cloud Run anyway; it is NOT survivable for a long-lived serving process that
 * consults a gate on the checkout path — an hour after boot every read would 401, the gate fails
 * OPEN by design, and it would disarm itself exactly the way the standing admin JWT it replaces
 * did. That is the whole defect this follow-up exists to remove, so it must not be reintroduced
 * one layer down.
 *
 * So this variant reads `exp` out of the token it was handed and refreshes BEFORE it. The `exp`
 * read is NOT a verification and is not treated as one: this is our own token, handed to us by
 * the metadata server over a link we trust, and the only thing `exp` decides here is WHEN TO ASK
 * AGAIN. A token whose `exp` cannot be parsed is not rejected — it is simply cached for a short
 * fixed window instead, because the backend is the thing that verifies, and a client that
 * second-guessed the signature would be duplicating a check it cannot do correctly.
 *
 * `createCloudRunIdTokenProvider` is deliberately left byte-identical for its four existing
 * callers (commerce/UCP store-audit workers and receipt clients). Changing the caching of a
 * credential under four money-path callers is a different change with a different review.
 */

/** Refresh this long before `exp`. A Cloud Run identity token lives an hour. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Used when `exp` is missing or unparseable. Short, because the alternative to a short cache is
 * a WRONG one: caching an unknown-lifetime credential for an hour is how a gate goes quiet.
 */
const UNKNOWN_EXP_TTL_MS = 60 * 1000;

/** Nothing is cached longer than this regardless of what `exp` claims. */
const MAX_CACHE_MS = 55 * 60 * 1000;

/**
 * Serving-path default. The metadata server is link-local and answers in single-digit
 * milliseconds; anything slower than this is a hang, and this sits in front of a checkout.
 */
const DEFAULT_METADATA_TIMEOUT_MS = 1000;

/**
 * Read `exp` (seconds since epoch) out of a JWT WITHOUT verifying it. Returns null for anything
 * that is not a three-segment token with a numeric `exp`.
 *
 * ⚠️ The decoded payload is used for ONE number and is never returned, logged or stored.
 */
function readTokenExpiryMs(token) {
  try {
    const segments = String(token || '').split('.');
    if (segments.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    const exp = payload && payload.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/**
 * An identity-token provider that REFRESHES.
 *
 * @param {{
 *   audience?: string,
 *   audienceEnvVar?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,          // metadata budget; default 1000, never more than 1000
 *   now?: () => number,
 *   env?: object,
 * }} [options]
 * @returns {{ audience: string|null, getToken: () => Promise<string|null> }}
 */
function createRefreshingCloudRunIdTokenProvider({
  audience,
  audienceEnvVar = 'PIVOTA_OPS_OIDC_AUDIENCE',
  fetchImpl = global.fetch,
  timeoutMs,
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const source = audience != null ? audience : (env && env[audienceEnvVar]);
  const validAudience = cloudRunAudience(source);
  // A CEILING, not a default: a caller cannot widen the budget on the checkout path.
  const budgetMs = Math.min(
    DEFAULT_METADATA_TIMEOUT_MS,
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Number(timeoutMs) : DEFAULT_METADATA_TIMEOUT_MS,
  );

  // THE TOKEN LIVES HERE AND NOWHERE ELSE. Two closure variables, no object, no map, no key —
  // so there is no structure holding a credential for a logger, a metric or a cache dump to
  // serialise. `_cache` on the purchasability client holds facts; it never sees this.
  let cachedToken = null;
  let cachedUntil = 0;
  let inflight = null;

  async function fetchToken() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await fetchImpl(
        `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(validAudience)}&format=full`,
        {
          method: 'GET',
          headers: { 'Metadata-Flavor': 'Google' },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (!response || response.ok !== true) return null;
      const token = String(await response.text()).trim();
      return token || null;
    } catch {
      // Unreachable metadata server (local dev, a non-GCP host, a timeout) is a `null`, never a
      // throw: the caller's fallback chain is what decides what that means.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToken() {
    if (!validAudience || typeof fetchImpl !== 'function') return null;
    if (cachedToken && now() < cachedUntil) return cachedToken;
    // Collapse a stampede: one metadata call, however many concurrent checkouts ask.
    if (!inflight) {
      inflight = fetchToken()
        .then((token) => {
          if (!token) {
            // NOT cached: a failure must not pin the process to "no credential" until a TTL.
            cachedToken = null;
            cachedUntil = 0;
            return null;
          }
          const expiryMs = readTokenExpiryMs(token);
          const ttl = expiryMs === null
            ? UNKNOWN_EXP_TTL_MS
            : (expiryMs - REFRESH_SKEW_MS) - now();
          cachedToken = token;
          // A token already inside its refresh window is still RETURNED (it is valid for another
          // five minutes) — it is simply not cached, so the next call fetches a fresh one.
          cachedUntil = ttl > 0 ? now() + Math.min(ttl, MAX_CACHE_MS) : 0;
          return token;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return { audience: validAudience, getToken };
}

module.exports = {
  cloudRunAudience,
  createCloudRunIdTokenProvider,
  createRefreshingCloudRunIdTokenProvider,
  readTokenExpiryMs,
  REFRESH_SKEW_MS,
  UNKNOWN_EXP_TTL_MS,
  DEFAULT_METADATA_TIMEOUT_MS,
  METADATA_IDENTITY_URL,
};
