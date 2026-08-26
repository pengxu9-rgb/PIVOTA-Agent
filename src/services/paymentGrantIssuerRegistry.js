'use strict';

// Payment-grant issuer registry — the gateway half of pivota-backend's payment_grant_issuers
// (#1886). Which PSPs may authorize money, pulled from the backend instead of frozen into
// PAYMENT_ISSUERS_JSON at deploy time.
//
// SHAPE, and why it differs from agentIdentityIssuerRegistry: identity bindings are per-(agent,
// iss) with a verifier per binding. Payment issuers are ONE global list feeding ONE
// createSignedGrantVerifier, so the mechanic here is merge-then-fingerprint: static env issuers
// + registry rows, and the verifier is REBUILT only when the merged list actually changes.
//
// TRUST ORDERING. Static env issuers (the platform canary lives there) are pinned: a registry
// row that names a static iss is dropped at ingest, loudly — a DB row must never be able to
// replace platform-pinned trust. Registry rows are additive only.
//
// FAIL-CLOSED STALENESS, in the direction that matters: when the backend has been unreachable
// past maxStalenessMs, REGISTRY rows are dropped (a portal revocation must take effect within a
// bounded window even during an outage) while STATIC issuers keep working (they are deploy-time
// Pivota config; an outage should not turn the canary off). This is the opposite trade from
// serving a stale map forever and the same one the identity registry makes.
//
// ONE MORE GUARD the identity twin does not need: buildIssuerRegistry HARD-THROWS on any
// configured iss containing '|' — while building the WHOLE registry, so one bad row would take
// every payment issuer down. The backend refuses piped issuers at two layers now, but a
// legacy/manual DB row must not be able to poison static trust: malformed rows are dropped at
// ingest here, with an error-level line naming the row.

const DEFAULT_TTL_MS = 60_000;
const MIN_FORCED_REFRESH_GAP_MS = 5_000;
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STALENESS_MS = 15 * 60_000;

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isEnabled(env) {
  const raw = String(env.PAYMENT_ISSUER_REGISTRY_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

/** base64url-decode a compact JWT's payload WITHOUT verification — only to pick `iss` for the
 * refresh-on-miss path. Same shape as the identity registry's peekIssuer. */
function peekGrantIssuer(authorization) {
  try {
    const token = [authorization?.token, authorization?.grant, authorization?.credential]
      .find((x) => nonEmpty(x));
    if (!token) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return nonEmpty(claims?.iss) ? claims.iss : null;
  } catch {
    return null;
  }
}

// The alg names buildIssuerRegistry accepts — a row carrying anything else makes it THROW,
// for the whole registry. Same pattern the backend validates against.
const ALLOWED_ALG_RE = /^(?:RS|PS|ES)\d{3}$|^EdDSA$/;

/** Registry row -> verifier config entry, or null (dropped).
 *
 * The bar here is deliberately EVERYTHING buildIssuerRegistry hard-throws on — pipe in iss,
 * non-https jwksUri, unknown algs — because it throws while building the ENTIRE registry, so
 * one bad row would take static trust down with it. Review of this PR proved the original
 * pipe-only guard insufficient: an http jwksUri row sailed through ingest and every payment
 * attempt (canary included) then failed on the build. The backend enforces https and no-pipe
 * as DB CHECK constraints, but algs is route-validated only — a hand-inserted row is exactly
 * the case this exists for. */
function normalizeEntry(raw, logger) {
  if (!raw || typeof raw !== 'object') return null;
  const iss = nonEmpty(raw.iss) ? raw.iss.trim() : null;
  const jwksUri = nonEmpty(raw.jwksUri) ? raw.jwksUri.trim() : null;
  const aud = nonEmpty(raw.aud) ? raw.aud.trim() : null;
  if (!iss || !jwksUri || !aud) return null;
  if (iss.includes('|')) {
    logger.error({ iss }, 'payment issuer row contains a piped iss; dropped (would poison the whole verifier registry)');
    return null;
  }
  let jwksOk = false;
  try {
    jwksOk = new URL(jwksUri).protocol === 'https:';
  } catch { jwksOk = false; }
  if (!jwksOk) {
    logger.error({ iss }, 'payment issuer row has a non-https jwksUri; dropped (would poison the whole verifier registry)');
    return null;
  }
  const algs = Array.isArray(raw.algs) && raw.algs.length ? raw.algs.map(String) : ['RS256', 'ES256'];
  if (!algs.every((a) => ALLOWED_ALG_RE.test(a))) {
    logger.error({ iss }, 'payment issuer row carries a non-allowlisted alg; dropped (would poison the whole verifier registry)');
    return null;
  }
  const methods = (Array.isArray(raw.methods) && raw.methods.length ? raw.methods.map(String) : ['signed_grant'])
    .filter((m) => m === 'signed_grant' || m === 'ap2_mandate');
  if (!methods.length) return null; // a row trusted for nothing we can enforce is not trust
  return {
    iss,
    jwksUri,
    aud,
    algs,
    methods,
    // NOTE: buildIssuerRegistry does not currently READ azp — carried for the fingerprint and
    // for the day the kernel enforces it, but it is not an enforced constraint on this path.
    ...(nonEmpty(raw.azp) ? { azp: raw.azp.trim() } : {}),
  };
}

function fingerprintOf(entries) {
  // Sorted: identical sets in different orders are the same trust and must not rebuild. The
  // backend serves ORDER BY id today, but the fingerprint should not depend on that staying true.
  return JSON.stringify(
    entries.map((e) => [e.iss, e.jwksUri, e.aud, e.algs, e.azp || null, e.methods || ['signed_grant']]).sort(),
  );
}

/**
 * @param {{
 *   staticIssuers?: object[], env?: object, ttlMs?: number, maxStalenessMs?: number,
 *   fetchImpl?: typeof fetch, logger?: {warn:Function,error:Function,info?:Function},
 *   now?: ()=>number, buildVerifier?: (issuers:object[])=>Promise<Function>,
 * }} opts
 */
function createPaymentGrantIssuerRegistry(opts = {}) {
  const env = opts.env || process.env;
  const baseUrl = String(env.PIVOTA_API_BASE ?? '').replace(/\/+$/, '');
  const internalKey = String(env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY ?? '').trim();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const maxStalenessMs = Number.isFinite(opts.maxStalenessMs)
    ? opts.maxStalenessMs
    : (Number(env.PAYMENT_ISSUER_REGISTRY_MAX_STALENESS_MS) > 0
      ? Number(env.PAYMENT_ISSUER_REGISTRY_MAX_STALENESS_MS)
      : DEFAULT_MAX_STALENESS_MS);
  const staticIssuers = Array.isArray(opts.staticIssuers) ? opts.staticIssuers.filter(Boolean) : [];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const logger = opts.logger || { warn() {}, error() {}, info() {} };
  const now = opts.now || (() => Date.now());

  const enabled = isEnabled(env) && !!baseUrl && !!internalKey;
  const registryUrl = `${baseUrl}/agent/internal/payment-issuers`;
  const staticIss = new Set(staticIssuers.map((e) => String(e?.iss || '').trim()).filter(Boolean));

  let registryRows = []; // normalized entries from the backend
  let fetchedAt = 0;
  let lastForcedAt = 0;
  let inflight = null;
  let lastStaleLogAt = 0;

  async function fetchOnce() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetchImpl(registryUrl, {
        method: 'GET',
        headers: { 'X-Internal-Key': internalKey, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`registry HTTP ${resp.status}`);
      const body = await resp.json();
      const next = [];
      const seenIss = new Set();
      for (const raw of Array.isArray(body?.issuers) ? body.issuers : []) {
        const e = normalizeEntry(raw, logger);
        if (!e) continue;
        if (seenIss.has(e.iss)) {
          // buildIssuerRegistry throws on duplicate iss for the whole registry. The backend's
          // partial unique index makes this impossible through the API; first row wins here.
          logger.error({ iss: e.iss }, 'duplicate payment issuer row; dropped (would poison the whole verifier registry)');
          continue;
        }
        if (staticIss.has(e.iss)) {
          // Static trust is pinned at deploy time; a DB row must never replace it. Loud,
          // because it means someone registered an issuer the platform already carries.
          logger.warn({ iss: e.iss }, 'payment issuer row shadows a static env issuer; dropped');
          continue;
        }
        seenIss.add(e.iss);
        next.push(e);
      }
      registryRows = next;
      fetchedAt = now();
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh({ force = false } = {}) {
    if (!enabled) return false;
    const age = now() - fetchedAt;
    if (!force && fetchedAt && age < ttlMs) return true;
    if (force && lastForcedAt && now() - lastForcedAt < MIN_FORCED_REFRESH_GAP_MS) return fetchedAt > 0;
    if (force) lastForcedAt = now();
    if (force && inflight) await inflight; // a forced refresh must be a genuine re-read
    if (!inflight) {
      inflight = fetchOnce()
        .catch((err) => {
          logger.warn({ err: err?.message || String(err) }, 'payment issuer registry refresh failed');
          return fetchedAt > 0;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  function methodsOf(entry) {
    const m = Array.isArray(entry?.methods) && entry.methods.length ? entry.methods : ['signed_grant'];
    return m;
  }

  /** The merged list split per authorization method. Static env entries may declare `methods`
   * too; without one they are signed_grant-only — AP2 trust is never implicit. The kernel's
   * verifier config does not read `methods`, so each per-method list is emitted WITHOUT it. */
  function issuersByMethod(list) {
    const strip = ({ methods: _m, ...entry }) => entry;
    return {
      signed_grant: list.filter((e) => methodsOf(e).includes('signed_grant')).map(strip),
      ap2_mandate: list.filter((e) => methodsOf(e).includes('ap2_mandate')).map(strip),
    };
  }

  /** The merged list the verifier is built from, applying the staleness drop. */
  function currentIssuers() {
    const registryFresh = enabled && fetchedAt > 0 && now() - fetchedAt <= maxStalenessMs;
    if (enabled && fetchedAt > 0 && !registryFresh && registryRows.length) {
      // Once a minute, not once per payment attempt: currentIssuers() runs 1-2x per attempt,
      // and a >15m outage at any volume would otherwise be a log storm of one repeated fact.
      if (now() - lastStaleLogAt >= 60_000) {
        lastStaleLogAt = now();
        logger.error(
          { stale_ms: now() - fetchedAt, dropped: registryRows.length },
          'payment issuer registry stale beyond bound; serving STATIC issuers only until it refreshes',
        );
      }
    }
    return registryFresh ? [...staticIssuers, ...registryRows] : [...staticIssuers];
  }

  /**
   * A verifyPaymentAuthorization with the same call shape as the product of
   * createPaymentAuthorizationVerifier, that refreshes on TTL, force-refreshes once on an
   * unknown iss (a PSP registered moments ago works immediately), and rebuilds the inner
   * verifier only when the merged issuer list actually changes.
   */
  function createVerifier(buildVerifier) {
    const build = buildVerifier || opts.buildVerifier;
    if (typeof build !== 'function') throw new Error('createVerifier requires a buildVerifier(issuers) factory');
    let innerPromise = null;
    let innerFingerprint = null;

    async function innerFor(issuers) {
      const fp = fingerprintOf(issuers);
      if (!innerPromise || innerFingerprint !== fp) {
        innerFingerprint = fp;
        // Async IIFE, NOT Promise.resolve(build(...)): createSignedGrantVerifier throws
        // SYNCHRONOUSLY, and with Promise.resolve the throw escaped before assignment — the
        // fingerprint said "new list" while innerPromise still held the OLD verifier, so a
        // snapshot that both revoked an issuer and carried a poison row kept the revoked
        // issuer verifying indefinitely. Review reproduced it; the IIFE turns the sync throw
        // into a rejection the cleanup below actually sees.
        innerPromise = (async () => build(issuersByMethod(issuers).signed_grant, issuersByMethod(issuers)))();
        innerPromise.catch(() => {
          // A build that failed must not wedge the verifier on a bad fingerprint forever.
          if (innerFingerprint === fp) { innerPromise = null; innerFingerprint = null; }
        });
      }
      return innerPromise;
    }

    return async function verifyPaymentAuthorization(authorization, ...rest) {
      await refresh();
      let issuers = currentIssuers();
      const iss = peekGrantIssuer(authorization);
      if (iss && !issuers.some((e) => e.iss === iss)) {
        await refresh({ force: true });
        issuers = currentIssuers();
      }
      const split = issuersByMethod(issuers);
      if (!split.signed_grant.length && !split.ap2_mandate.length) {
        const err = new Error('no trusted payment issuers are configured');
        err.code = 'PAYMENT_AUTHZ_UNAVAILABLE';
        throw err;
      }
      const inner = await innerFor(issuers);
      return inner(authorization, ...rest);
    };
  }

  return Object.freeze({
    enabled,
    refresh,
    createVerifier,
    _debug: {
      currentIssuers,
      issuersByMethod: () => issuersByMethod(currentIssuers()),
      size: () => registryRows.length,
      fetchedAt: () => fetchedAt,
      peekGrantIssuer,
    },
  });
}

module.exports = { createPaymentGrantIssuerRegistry, peekGrantIssuer };
