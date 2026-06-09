// MCP OAuth Resource Server primitives.
//
// This is the front door that lets a native frontier MCP client (Claude, ChatGPT, Gemini)
// connect to /mcp WITHOUT a pre-shared commerce API key, per the MCP Authorization spec
// (2025-06-18) which builds on:
//   - RFC 9728 OAuth 2.0 Protected Resource Metadata  (discovery)
//   - RFC 6750 Bearer token usage                       (the WWW-Authenticate challenge)
//   - RFC 8707 Resource Indicators                      (access-token audience === this resource)
//   - RFC 8414 / RFC 7591 are implemented by the *authorization server* (DCR + consent), which
//     is configured here only by reference (authorizationServers). We are the RESOURCE server.
//
// Boundary: this module verifies an inbound OAuth *access token* and maps it to a Pivota
// `user_ref`. The same token both (a) authenticates the connecting client at the channel and
// (b) identifies the human who authorized the connection — there is no separate API key and no
// separate X-Agent-User-JWT for native OAuth clients. The model-supplied identity is never used.
//
// Fail closed on every crypto/structure error. Token-embedded `jku`/`x5u` are ignored by
// construction — jose only uses the pinned key set we configure per issuer.

import { jwtVerify, createRemoteJWKSet, createLocalJWKSet, decodeJwt } from 'jose';
import { deriveUserRefFromClaims } from './userTokenVerifier.js';

const DEFAULT_ALGS = ['RS256', 'ES256', 'EdDSA'];
const ASYMMETRIC_ALG = /^(?:RS|PS|ES)\d{3}$|^EdDSA$/;

export class McpOAuthError extends Error {
  constructor(message, code = 'INVALID_TOKEN', status = 401) {
    super(message);
    this.name = 'McpOAuthError';
    this.code = code;
    this.status = status;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function assertHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError(`${label} must be an absolute URL`, 'BAD_CONFIG', 500);
  }
  if (url.protocol !== 'https:') {
    // loopback is allowed for local dev only
    const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (!isLoopback) throw new McpOAuthError(`${label} must be https`, 'BAD_CONFIG', 500);
  }
  return url;
}

/**
 * RFC 9728 Protected Resource Metadata document served at
 * GET /.well-known/oauth-protected-resource (and the path-suffixed variant for /mcp).
 *
 * @param {{ resource:string, authorizationServers:string[], scopesSupported?:string[],
 *           bearerMethodsSupported?:string[], resourceName?:string }} cfg
 */
export function buildProtectedResourceMetadata(cfg = {}) {
  const resource = cfg.resource;
  if (!nonEmpty(resource)) throw new McpOAuthError('resource is required', 'BAD_CONFIG', 500);
  assertHttpsUrl(resource, 'resource');

  const authorizationServers = Array.isArray(cfg.authorizationServers) ? cfg.authorizationServers : [];
  if (authorizationServers.length === 0) {
    throw new McpOAuthError('at least one authorization server is required', 'BAD_CONFIG', 500);
  }
  for (const as of authorizationServers) assertHttpsUrl(as, 'authorization server issuer');

  const doc = {
    resource,
    authorization_servers: authorizationServers,
    bearer_methods_supported: Array.isArray(cfg.bearerMethodsSupported) && cfg.bearerMethodsSupported.length
      ? cfg.bearerMethodsSupported
      : ['header'],
  };
  if (Array.isArray(cfg.scopesSupported) && cfg.scopesSupported.length) {
    doc.scopes_supported = cfg.scopesSupported;
  }
  if (nonEmpty(cfg.resourceName)) doc.resource_name = cfg.resourceName;
  return doc;
}

/**
 * RFC 6750 challenge. MCP requires the `resource_metadata` parameter so the client can discover
 * the authorization server from a 401. Always emitted on an unauthenticated/invalid MCP request.
 *
 * @param {{ resourceMetadataUrl:string, error?:string, errorDescription?:string }} cfg
 */
export function buildWwwAuthenticate(cfg = {}) {
  const parts = ['Bearer'];
  const params = [];
  if (cfg.error) params.push(`error="${sanitizeHeaderValue(cfg.error)}"`);
  if (cfg.errorDescription) params.push(`error_description="${sanitizeHeaderValue(cfg.errorDescription)}"`);
  if (nonEmpty(cfg.resourceMetadataUrl)) {
    params.push(`resource_metadata="${sanitizeHeaderValue(cfg.resourceMetadataUrl)}"`);
  }
  return params.length ? `${parts[0]} ${params.join(', ')}` : parts[0];
}

function sanitizeHeaderValue(value) {
  // strip CR/LF and the quote char to avoid header injection / breaking the quoted-string
  return String(value).replace(/[\r\n"]/g, '');
}

function normalizeIssuers(issuers) {
  if (!Array.isArray(issuers) || issuers.length === 0) {
    throw new McpOAuthError('at least one issuer is required', 'BAD_CONFIG', 500);
  }
  const registry = new Map();
  for (const entry of issuers) {
    if (!entry || !nonEmpty(entry.iss)) {
      throw new McpOAuthError('each issuer needs a non-empty iss', 'BAD_CONFIG', 500);
    }
    if (entry.iss.includes('|')) {
      // `${iss}|${sub}` is the user_ref preimage; a '|' in iss would make it ambiguous.
      throw new McpOAuthError(`issuer ${entry.iss} must not contain '|'`, 'BAD_CONFIG', 500);
    }
    const algs = entry.algs === undefined ? DEFAULT_ALGS : entry.algs;
    if (!Array.isArray(algs) || algs.length === 0 || algs.some((a) => typeof a !== 'string' || !ASYMMETRIC_ALG.test(a))) {
      throw new McpOAuthError(`issuer ${entry.iss} alg allowlist must be a non-empty asymmetric set`, 'BAD_CONFIG', 500);
    }
    let jwks;
    if (entry.jwks) {
      jwks = createLocalJWKSet(entry.jwks);
    } else if (entry.jwksUri) {
      jwks = createRemoteJWKSet(assertHttpsUrl(entry.jwksUri, `issuer ${entry.iss} jwksUri`));
    } else {
      throw new McpOAuthError(`issuer ${entry.iss} needs jwksUri or jwks`, 'BAD_CONFIG', 500);
    }
    if (registry.has(entry.iss)) throw new McpOAuthError(`duplicate issuer ${entry.iss}`, 'BAD_CONFIG', 500);
    const requiredScopes = entry.requiredScopes != null ? [].concat(entry.requiredScopes).map(String) : null;
    registry.set(entry.iss, { jwks, algs, requiredScopes });
  }
  return registry;
}

function clampClockTolerance(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return 5;
  return Math.min(n, 30);
}

function extractScopes(payload) {
  // OAuth `scope` is a space-delimited string; some IdPs use `scp` (array or string).
  if (typeof payload.scope === 'string') return payload.scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(payload.scp)) return payload.scp.map(String);
  if (typeof payload.scp === 'string') return payload.scp.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * Build the access-token verifier.
 *
 * The access token's audience MUST equal `resource` (RFC 8707) so a token minted for another
 * resource cannot be replayed at this MCP server. Subject identity → user_ref via the same
 * derivation used everywhere else (parity with userTokenVerifier).
 *
 * @param {{ issuers:Array<{iss:string,jwksUri?:string,jwks?:object,algs?:string[],requiredScopes?:string[]}>,
 *           resource:string, maxTokenAge?:string|number, clockToleranceSeconds?:number }} config
 * @returns {(token:string) => Promise<{ user_ref:string, claims:object, scopes:string[] }>}
 */
export function createMcpAccessTokenVerifier(config = {}) {
  const resource = config.resource;
  if (!nonEmpty(resource)) throw new McpOAuthError('resource is required', 'BAD_CONFIG', 500);
  const registry = normalizeIssuers(config.issuers);
  const ct = clampClockTolerance(config.clockToleranceSeconds);
  const maxTokenAge = config.maxTokenAge;

  return async function verifyAccessToken(token) {
    if (!nonEmpty(token)) throw new McpOAuthError('missing access token', 'INVALID_TOKEN');

    // Peek iss (UNVERIFIED) only to select the pinned key set. jose then re-checks iss === entry.iss
    // against that issuer's keys, so a forged/spoofed iss cannot validate.
    let unsafeIss;
    try {
      unsafeIss = decodeJwt(token)?.iss;
    } catch {
      throw new McpOAuthError('malformed token', 'INVALID_TOKEN');
    }
    const entry = nonEmpty(unsafeIss) ? registry.get(unsafeIss) : undefined;
    if (!entry) throw new McpOAuthError('untrusted issuer', 'INVALID_TOKEN');

    let payload;
    try {
      ({ payload } = await jwtVerify(token, entry.jwks, {
        issuer: unsafeIss,
        audience: resource, // RFC 8707: token must be bound to THIS resource
        algorithms: entry.algs,
        clockTolerance: ct,
        ...(maxTokenAge != null ? { maxTokenAge } : {}),
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat'],
      }));
    } catch (err) {
      throw new McpOAuthError(`token verification failed: ${err?.code || err?.message || 'invalid'}`, 'INVALID_TOKEN');
    }

    if (payload.iss !== unsafeIss) throw new McpOAuthError('issuer mismatch', 'INVALID_TOKEN');
    if (!nonEmpty(payload.sub)) throw new McpOAuthError('token missing sub', 'INVALID_TOKEN');

    const scopes = extractScopes(payload);
    if (entry.requiredScopes) {
      const missing = entry.requiredScopes.filter((s) => !scopes.includes(s));
      if (missing.length) {
        throw new McpOAuthError(`insufficient_scope: missing ${missing.join(' ')}`, 'INSUFFICIENT_SCOPE', 403);
      }
    }

    const user_ref = deriveUserRefFromClaims(payload.iss, payload.sub);
    return { user_ref, claims: payload, scopes };
  };
}
