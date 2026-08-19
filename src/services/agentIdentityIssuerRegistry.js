'use strict';

// Federated buyer identity — the gateway half.
//
// An agent registers ITS OWN user-token issuer in the Pivota developer portal (backend table
// agent_identity_issuers, PR pivota-backend#1774). This module pulls those bindings from the backend's
// internal registry and verifies an `X-Agent-User-JWT` against the issuer bound to the CALLING agent —
// so a Minds-minted user token is accepted on create_checkout only when presented with Minds' API key,
// and the user never leaves Minds' UI for a Pivota sign-in.
//
// WHAT IT IS NOT. Not a second verifier: every token still goes through safety-kernel's
// createUserTokenVerifier (pinned JWKS, asymmetric algs only, iss/aud/exp/iat, optional azp/scope) — one
// entry per binding, built lazily and memoized by the binding's own fields so a changed registration
// rebuilds it. Not a widening of the static IDENTITY_ISSUERS_JSON registry either: those issuers stay
// global; this path is consulted only when the static verifier does not know the token's issuer, and
// only for the agent the binding names.
//
// FAIL CLOSED, ALWAYS. No introspection key / no base URL ⇒ disabled (throws). Registry unreachable and
// nothing cached ⇒ throws. Binding missing for (agent, iss) ⇒ throws ISSUER_NOT_ALLOWED — after ONE
// forced refresh, so a registration made seconds ago is honoured without waiting for the TTL.
//
// The registry is fetched with the same X-Internal-Key the gateway already uses for api-key
// introspection (AGENT_AUTH_INTROSPECT_INTERNAL_KEY); no new secret.

const DEFAULT_TTL_MS = 60_000;
const MIN_FORCED_REFRESH_GAP_MS = 5_000;
const FETCH_TIMEOUT_MS = 5_000;
// A stale map is served while the backend is unreachable — but not forever: a disabled issuer or a
// revoked key must stop working within a bounded window even during an outage. Past this, verification
// fails closed (REGISTRY_UNAVAILABLE) rather than trusting an unrefreshable binding.
const DEFAULT_MAX_STALENESS_MS = 15 * 60_000;

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isEnabled(env = process.env) {
  const raw = String(env.AGENT_FEDERATED_IDENTITY_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

/** base64url-decode the JWT payload WITHOUT verification — only to pick a binding by `iss`. */
function peekIssuer(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return nonEmpty(claims?.iss) ? claims.iss : null;
  } catch {
    return null;
  }
}

/**
 * Issuer strings the PLATFORM already trusts (static user-token registry + the MCP OAuth registry).
 * A federated binding may never name one: that is an agent claiming to mint tokens for an issuer whose
 * subjects already map to real people's kernel user_refs (usr_ = sha256(iss|sub), agent-independent).
 * The backend refuses to register these, and this is the second, independent enforcement point — the
 * gateway is the only place that can see IDENTITY_ISSUERS_JSON / MCP_OAUTH_ISSUERS_JSON.
 */
function platformTrustedIssuers(env = process.env) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim().replace(/\/+$/, '').toLowerCase());
  };
  for (const name of [
    'IDENTITY_ISSUERS_JSON', 'AGENT_CHECKOUT_IDENTITY_ISSUERS_JSON', 'PIVOTA_IDENTITY_ISSUERS_JSON',
    'MCP_OAUTH_ISSUERS_JSON',
  ]) {
    const raw = env[name];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      for (const entry of Array.isArray(parsed) ? parsed : []) add(entry?.iss);
    } catch { /* a malformed registry is the static verifier's problem, not ours */ }
  }
  for (const name of ['MCP_OAUTH_AUTHORIZATION_SERVERS', 'AGENT_IDENTITY_RESERVED_ISSUERS']) {
    for (const part of String(env[name] || '').split(',')) add(part);
  }
  return out;
}

function issuerKey(iss) {
  return String(iss || '').trim().replace(/\/+$/, '').toLowerCase();
}

function bindingKey(agentId, iss) {
  return `${agentId}\u0000${iss}`;
}

/** The fields a verifier is built from; anything else changing must not invalidate it. */
function verifierKey(entry) {
  return JSON.stringify({
    iss: entry.iss, aud: entry.aud, algs: entry.algs, jwksUri: entry.jwksUri,
    azp: entry.azp ?? null, requiredScopes: entry.requiredScopes ?? null,
  });
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agentId = nonEmpty(raw.agent_id) ? raw.agent_id.trim() : null;
  const iss = nonEmpty(raw.iss) ? raw.iss.trim() : null;
  const jwksUri = nonEmpty(raw.jwksUri) ? raw.jwksUri.trim() : null;
  const aud = nonEmpty(raw.aud) ? raw.aud.trim() : null;
  const algs = Array.isArray(raw.algs) && raw.algs.length ? raw.algs.map(String) : ['RS256', 'ES256'];
  if (!agentId || !iss || !jwksUri || !aud) return null;
  return {
    agentId, iss, jwksUri, aud, algs,
    azp: nonEmpty(raw.azp) ? raw.azp.trim() : null,
    requiredScopes: Array.isArray(raw.requiredScopes) && raw.requiredScopes.length ? raw.requiredScopes.map(String) : null,
  };
}

/**
 * @param {{
 *   baseUrl?: string, internalKey?: string, ttlMs?: number, env?: object,
 *   fetchImpl?: typeof fetch, createVerifier?: (config:object)=>Promise<Function>|Function,
 *   maxTokenAge?: string, logger?: {warn:Function,info?:Function}, now?: ()=>number,
 * }} opts
 */
function createAgentIdentityIssuerRegistry(opts = {}) {
  const env = opts.env || process.env;
  const baseUrl = String(opts.baseUrl ?? env.PIVOTA_API_BASE ?? '').replace(/\/+$/, '');
  const internalKey = String(opts.internalKey ?? env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY ?? '').trim();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const maxStalenessMs = Number.isFinite(opts.maxStalenessMs)
    ? opts.maxStalenessMs
    : (Number(env.AGENT_FEDERATED_IDENTITY_MAX_STALENESS_MS) > 0
      ? Number(env.AGENT_FEDERATED_IDENTITY_MAX_STALENESS_MS)
      : DEFAULT_MAX_STALENESS_MS);
  const trustedIssuers = opts.trustedIssuers instanceof Set ? opts.trustedIssuers : platformTrustedIssuers(env);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const logger = opts.logger || { warn() {}, info() {} };
  const now = opts.now || (() => Date.now());
  const maxTokenAge = opts.maxTokenAge
    || env.AGENT_CHECKOUT_IDENTITY_MAX_TOKEN_AGE || env.IDENTITY_MAX_TOKEN_AGE || undefined;

  const enabled = isEnabled(env) && !!baseUrl && !!internalKey;
  const registryUrl = `${baseUrl}/agent/internal/identity-issuers`;

  let bindings = new Map(); // bindingKey -> entry
  let fetchedAt = 0;
  let lastForcedAt = 0;
  let inflight = null;
  const verifiers = new Map(); // verifierKey -> Promise<verify fn>

  async function defaultCreateVerifier(config) {
    const { createUserTokenVerifier } = await import('../../safety-kernel/src/identity/userTokenVerifier.js');
    return createUserTokenVerifier(config);
  }
  const createVerifier = opts.createVerifier || defaultCreateVerifier;

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
      const next = new Map();
      for (const raw of Array.isArray(body?.issuers) ? body.issuers : []) {
        const e = normalizeEntry(raw);
        if (!e) continue;
        if (trustedIssuers.has(issuerKey(e.iss))) {
          // Refused at ingest, not at verification: such a binding must never be usable, and the drop
          // is loud because it means the backend's own reserved-issuer guard let one through.
          logger.warn({ agent_id: e.agentId, iss: e.iss }, 'federated issuer binding names a platform-trusted issuer; dropped');
          continue;
        }
        next.set(bindingKey(e.agentId, e.iss), e);
      }
      bindings = next;
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
    if (force && inflight) {
      // Do not adopt an in-flight NON-forced fetch as "the forced refresh": await it, then fetch again
      // so a just-registered binding is genuinely re-read.
      await inflight;
    }
    if (!inflight) {
      inflight = fetchOnce()
        .catch((err) => {
          logger.warn({ err: err?.message || String(err) }, 'agent identity issuer registry refresh failed');
          return fetchedAt > 0; // stale cache is still a cache
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  function makeError(message, code) {
    const err = new Error(message);
    err.name = 'UserTokenError';
    err.code = code;
    return err;
  }

  async function verifierFor(entry) {
    const key = verifierKey(entry);
    if (!verifiers.has(key)) {
      const p = Promise.resolve(createVerifier({
        issuers: [{
          iss: entry.iss, aud: entry.aud, algs: entry.algs, jwksUri: entry.jwksUri,
          ...(entry.azp ? { azp: entry.azp } : {}),
          ...(entry.requiredScopes ? { requiredScopes: entry.requiredScopes } : {}),
        }],
        ...(maxTokenAge ? { maxTokenAge } : {}),
      }));
      p.catch(() => verifiers.delete(key)); // a verifier that cannot be built is retried next time
      verifiers.set(key, p);
      // Bound the memo: a rotating set of registrations must not grow without limit.
      if (verifiers.size > 512) verifiers.delete(verifiers.keys().next().value);
    }
    const v = verifiers.get(key);
    // Touch: re-inserting moves the key to the end so the size-cap eviction below drops the LEAST
    // recently used verifier rather than the oldest-created one.
    verifiers.delete(key);
    verifiers.set(key, v);
    return v;
  }

  /**
   * Verify `token` for `agentId`. Resolves `{ user_ref, claims, ... }` exactly as the kernel verifier does,
   * plus `issuer_binding: { agent_id, iss }`. Throws (UserTokenError-shaped) on every other outcome.
   */
  async function verifyForAgent(token, agentId) {
    if (!enabled) throw makeError('federated identity disabled or not configured', 'FEDERATED_DISABLED');
    if (!nonEmpty(agentId)) throw makeError('no calling agent to bind the issuer to', 'AGENT_UNKNOWN');
    const iss = peekIssuer(token);
    if (!iss) throw makeError('malformed token', 'TOKEN_MALFORMED');

    const ok = await refresh();
    if (fetchedAt > 0 && now() - fetchedAt > maxStalenessMs) {
      // One last forced attempt, then fail closed: an unrefreshable map cannot be trusted to reflect a
      // revocation.
      await refresh({ force: true });
      if (now() - fetchedAt > maxStalenessMs) {
        throw makeError('identity issuer registry is stale', 'REGISTRY_UNAVAILABLE');
      }
    }
    let entry = bindings.get(bindingKey(agentId, iss));
    if (!entry) {
      // A registration made moments ago: one forced refresh before refusing.
      await refresh({ force: true });
      entry = bindings.get(bindingKey(agentId, iss));
    }
    if (!entry) {
      if (!ok && fetchedAt === 0) throw makeError('identity issuer registry unavailable', 'REGISTRY_UNAVAILABLE');
      throw makeError('issuer is not registered to the calling agent', 'ISSUER_NOT_ALLOWED');
    }
    const verify = await verifierFor(entry);
    const verified = await verify(token);
    return { ...verified, issuer_binding: { agent_id: entry.agentId, iss: entry.iss } };
  }

  return Object.freeze({
    enabled,
    trustedIssuerCount: trustedIssuers.size,
    verifyForAgent,
    refresh,
    _debug: {
      peekIssuer,
      size: () => bindings.size,
      fetchedAt: () => fetchedAt,
      has: (agentId, iss) => bindings.has(bindingKey(agentId, iss)),
    },
  });
}

module.exports = { createAgentIdentityIssuerRegistry, peekIssuer, isEnabled };
