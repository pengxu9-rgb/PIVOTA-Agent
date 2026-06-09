// Server glue for the MCP OAuth front door (CommonJS — required by src/server.js).
//
// Lets a native frontier MCP client (Claude / ChatGPT / Gemini) connect to POST /mcp with an
// OAuth access token instead of a pre-shared commerce API key. Additive + flag-gated
// (MCP_OAUTH_ENABLED=1): when off, every export is inert and the existing api-key channel is
// unchanged.
//
// Responsibilities (RESOURCE-server side only; the authorization server is external):
//   1. Serve RFC 9728 protected-resource metadata for discovery.
//   2. Emit an RFC 6750 WWW-Authenticate challenge (with resource_metadata) on unauthenticated
//      or invalid /mcp requests so the client can discover the AS and start the OAuth flow.
//   3. Verify an inbound Bearer access token → Pivota user_ref (channel auth + identity in one).
//
// The ESM safety-kernel primitives are loaded via dynamic import().

const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const API_KEY_PATTERN = /^ak_(live_)?[0-9a-f]{64}$/;
const PRIMITIVES = '../safety-kernel/src/identity/mcpOAuthResourceServer.js';

function mcpOAuthEnabled() {
  return String(process.env.MCP_OAUTH_ENABLED || '').trim() === '1';
}

function firstEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function requestHost(req) {
  return (req && typeof req.get === 'function' && req.get('host'))
    || (req && req.headers && req.headers.host)
    || undefined;
}

function resourceFor(req) {
  const explicit = firstEnv('MCP_OAUTH_RESOURCE');
  if (explicit) return explicit;
  const host = requestHost(req);
  return host ? `https://${host}/mcp` : undefined;
}

function resourceMetadataUrlFor(req) {
  const explicit = firstEnv('MCP_OAUTH_RESOURCE_METADATA_URL');
  if (explicit) return explicit;
  const host = requestHost(req);
  return host ? `https://${host}${RESOURCE_METADATA_PATH}` : undefined;
}

function authorizationServers() {
  const raw = firstEnv('MCP_OAUTH_AUTHORIZATION_SERVERS', 'MCP_OAUTH_ISSUER');
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()) : [];
    } catch {
      return [];
    }
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function scopesSupported() {
  const raw = firstEnv('MCP_OAUTH_SCOPES');
  return raw ? raw.split(/[,\s]+/).filter(Boolean) : [];
}

function issuersConfig() {
  // Reuse the SAME pinned-JWKS issuers used for X-Agent-User-JWT unless a dedicated set is given.
  const raw = firstEnv(
    'MCP_OAUTH_ISSUERS_JSON',
    'IDENTITY_ISSUERS_JSON',
    'AGENT_CHECKOUT_IDENTITY_ISSUERS_JSON',
    'PIVOTA_IDENTITY_ISSUERS_JSON',
  );
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MCP OAuth issuers config must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('MCP OAuth issuers config must be a non-empty array');
  }
  return parsed;
}

// verifiers are resource-scoped (aud === resource); cache per resource to avoid re-fetching JWKS.
const verifierCache = new Map();

async function getVerifier(resource) {
  if (!resource) return null;
  if (verifierCache.has(resource)) return verifierCache.get(resource);
  const issuers = issuersConfig();
  if (!issuers) {
    verifierCache.set(resource, null);
    return null;
  }
  const { createMcpAccessTokenVerifier } = await import(PRIMITIVES);
  const verifier = createMcpAccessTokenVerifier({
    issuers,
    resource,
    maxTokenAge: firstEnv('AGENT_CHECKOUT_IDENTITY_MAX_TOKEN_AGE', 'IDENTITY_MAX_TOKEN_AGE') || undefined,
  });
  verifierCache.set(resource, verifier);
  return verifier;
}

function parseBearer(req) {
  const raw = String(
    (req && typeof req.get === 'function' && req.get('authorization'))
      || (req && req.headers && req.headers.authorization)
      || '',
  ).trim();
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : '';
}

function hasApiKey(req) {
  const fromHeader = String(
    (req && typeof req.get === 'function' && req.get('x-agent-api-key'))
      || (req && req.headers && req.headers['x-agent-api-key'])
      || '',
  ).trim();
  if (fromHeader) return true;
  const bearer = parseBearer(req);
  return Boolean(bearer) && API_KEY_PATTERN.test(bearer);
}

/**
 * Mount the discovery routes. Safe to call unconditionally; returns the document only when the
 * front door is enabled AND has authorization servers configured (else 404, i.e. "no OAuth here").
 */
function registerMcpOAuthDiscoveryRoutes(app, opts = {}) {
  const logger = opts.logger;
  const handler = async (req, res) => {
    if (!mcpOAuthEnabled()) return res.status(404).json({ error: 'not_found' });
    try {
      const { buildProtectedResourceMetadata } = await import(PRIMITIVES);
      const doc = buildProtectedResourceMetadata({
        resource: resourceFor(req),
        authorizationServers: authorizationServers(),
        scopesSupported: scopesSupported(),
        resourceName: firstEnv('MCP_OAUTH_RESOURCE_NAME') || 'Pivota Commerce MCP',
      });
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).json(doc);
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn({ err: (err && err.message) || String(err) }, 'mcp oauth metadata unavailable');
      }
      return res.status(404).json({ error: 'not_found' });
    }
  };
  app.get(RESOURCE_METADATA_PATH, handler);
  // path-suffixed variant per the MCP spec convention for a resource at /mcp
  app.get(`${RESOURCE_METADATA_PATH}/mcp`, handler);
}

/**
 * Resolve the MCP OAuth outcome for an inbound /mcp request.
 * Returns one of:
 *   { mode: 'disabled' }                                  -> feature off; caller uses api-key channel
 *   { mode: 'apikey' }                                    -> an api key was presented; use api-key channel
 *   { mode: 'oauth', user_ref, claims, scopes }           -> verified OAuth identity (channel + identity)
 *   { mode: 'challenge', status, wwwAuthenticate, body }  -> caller must send this 401/403 challenge
 */
async function resolveMcpOAuthIdentity(req) {
  if (!mcpOAuthEnabled()) return { mode: 'disabled' };
  if (hasApiKey(req)) return { mode: 'apikey' };

  const { buildWwwAuthenticate } = await import(PRIMITIVES);
  const resourceMetadataUrl = resourceMetadataUrlFor(req);
  const challenge = (status, error, errorDescription) => ({
    mode: 'challenge',
    status,
    wwwAuthenticate: buildWwwAuthenticate({ resourceMetadataUrl, error, errorDescription }),
    body: { error: 'UNAUTHORIZED', message: errorDescription },
  });

  const token = parseBearer(req);
  if (!token) {
    // discovery handshake: tell the client where to authenticate
    return challenge(401, 'invalid_token', 'Authentication required');
  }

  let verifier;
  try {
    verifier = await getVerifier(resourceFor(req));
  } catch (err) {
    return challenge(401, 'invalid_token', `OAuth not configured: ${(err && err.message) || 'error'}`);
  }
  if (!verifier) return challenge(401, 'invalid_token', 'OAuth authorization server not configured');

  try {
    const { user_ref, claims, scopes } = await verifier(token);
    return { mode: 'oauth', user_ref, claims, scopes };
  } catch (err) {
    const insufficient = err && err.code === 'INSUFFICIENT_SCOPE';
    return challenge(
      insufficient ? 403 : 401,
      insufficient ? 'insufficient_scope' : 'invalid_token',
      'Access token verification failed',
    );
  }
}

// test seam
function __resetVerifierCache() {
  verifierCache.clear();
}

module.exports = {
  mcpOAuthEnabled,
  resourceFor,
  resourceMetadataUrlFor,
  authorizationServers,
  scopesSupported,
  registerMcpOAuthDiscoveryRoutes,
  resolveMcpOAuthIdentity,
  __resetVerifierCache,
};
