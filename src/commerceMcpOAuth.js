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

// THE DOORS THIS RESOURCE SERVER PROTECTS, and the ONE identifier each one publishes.
//
// `/ucp/mcp` is the same commerce surface as `/mcp` with the UCP spec's tool spelling, and both go
// through this same OAuth front door. They are NOT the same RFC 9728 protected resource, though:
// §3.3 requires the `resource` value in a metadata document to be the identifier the document's own
// well-known URL was built from. When `/ucp/mcp` challenged with the ROOT metadata URL, a client
// following the challenge read `resource: https://host/mcp` — an identifier for a different endpoint
// than the one it had just called. A strict client that checks the two agree has nothing to request a
// token for; a lenient one mints for `/mcp` and works by luck.
const NATIVE_DOOR_PATH = '/mcp';
const UCP_DOOR_PATH = '/ucp/mcp';
const DOOR_PATHS = [UCP_DOOR_PATH, NATIVE_DOOR_PATH]; // longest first: /ucp/mcp before /mcp

/**
 * Which door is this request about, as a canonical path — for a door request (`POST /ucp/mcp`) and for
 * a metadata request (`GET /.well-known/oauth-protected-resource/ucp/mcp`) alike, since both have to
 * resolve to the same identifier or the document contradicts the challenge that pointed at it.
 *
 * Normalized (lowercase, trailing slashes stripped), never compared raw: Express routes
 * case-insensitively and tolerates trailing slashes, so `/UCP/MCP` and `/ucp/mcp/` reach the door and
 * are served. Same rule and same reason as `isCommerceMcpJsonRpcPath` in src/server.js — a raw compare
 * there was already shown to hand the money path different hosted-payment defaults (#1971).
 * Anything unrecognized falls back to the native door, which is the pre-existing behaviour.
 */
function doorPathFor(req) {
  const raw = String((req && req.path) || '').toLowerCase().replace(/\/+$/, '');
  const suffix = raw.startsWith(RESOURCE_METADATA_PATH) ? raw.slice(RESOURCE_METADATA_PATH.length) : raw;
  return DOOR_PATHS.includes(suffix) ? suffix : NATIVE_DOOR_PATH;
}

/** The configured identifier for the NATIVE door — unchanged behaviour, and the origin every door inherits. */
function nativeResource(req) {
  const explicit = firstEnv('MCP_OAUTH_RESOURCE');
  if (explicit) return explicit;
  const host = requestHost(req);
  return host ? `https://${host}${NATIVE_DOOR_PATH}` : undefined;
}

/**
 * The resource identifier for the door this request is about.
 *
 * The UCP identifier is derived from the NATIVE one's origin, never from the request's Host header:
 * this service answers on both `commerce.mcp.pivota.cc` and its Railway domain, and an audience that
 * changed with the hostname a client happened to use would make tokens unverifiable across the two.
 */
function resourceFor(req) {
  const native = nativeResource(req);
  if (!native) return undefined;
  if (doorPathFor(req) === NATIVE_DOOR_PATH) return native;
  let origin;
  try {
    origin = new URL(native).origin;
  } catch {
    return native; // malformed config: keep today's single-identifier behaviour rather than invent one
  }
  return `${origin}${UCP_DOOR_PATH}`;
}

/**
 * Audiences a token may carry AT THIS DOOR. The door's own identifier, plus — on the UCP door only —
 * the native identifier, because `/ucp/mcp` shipped and went live advertising the native resource, so
 * a client that already minted against it must not be broken by this fix. Both name this same server.
 * Drop the legacy member once no client mints for it (see the PR).
 */
function acceptedResourcesFor(req) {
  const primary = resourceFor(req);
  if (!primary) return [];
  const native = nativeResource(req);
  return native && native !== primary ? [primary, native] : [primary];
}

/**
 * RFC 9728 §3.3 path-insertion: the metadata for a resource at `https://host/ucp/mcp` lives at
 * `https://host/.well-known/oauth-protected-resource/ucp/mcp`, so the document's own URL encodes the
 * identifier it declares. Built on the RESOURCE's origin for the same cross-hostname reason above.
 *
 * `MCP_OAUTH_RESOURCE_METADATA_URL` still overrides — but only for the native door. It is a single
 * value; honouring it on `/ucp/mcp` would point that door back at a document describing `/mcp` and
 * re-create the exact mismatch this function exists to fix.
 */
function resourceMetadataUrlFor(req) {
  const doorPath = doorPathFor(req);
  if (doorPath === NATIVE_DOOR_PATH) {
    const explicit = firstEnv('MCP_OAUTH_RESOURCE_METADATA_URL');
    if (explicit) return explicit;
  }
  const resource = resourceFor(req);
  if (resource) {
    try {
      return `${new URL(resource).origin}${RESOURCE_METADATA_PATH}${doorPath}`;
    } catch {
      /* fall through to the request host */
    }
  }
  const host = requestHost(req);
  return host ? `https://${host}${RESOURCE_METADATA_PATH}${doorPath}` : undefined;
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

// verifiers are resource-scoped (aud ∈ resources); cache per resource SET to avoid re-fetching JWKS.
// The cache key is the joined set, so the native door and the UCP door — which accept different sets —
// never share a verifier and cannot borrow each other's audience rule.
const verifierCache = new Map();

async function getVerifier(resources) {
  const list = (Array.isArray(resources) ? resources : [resources]).filter(Boolean);
  if (list.length === 0) return null;
  const resource = list.length === 1 ? list[0] : list;
  // JSON, not join(' '): a joined key is AMBIGUOUS — the one-member set ["a b"] and the two-member set
  // ["a", "b"] collapse to the same string, so one door can be served the other's cached verifier. Not
  // theoretical: with MCP_OAUTH_RESOURCE unset the identifier is built from the Host header, and Node
  // accepts a Host containing a space, so a caller can choose which key it lands on. Nobody gains an
  // audience they can mint for (the borrow hands over identifiers, not signing keys), but a legitimate
  // client's correctly-minted token starts being refused — a denial of service on a live charge door,
  // planted by an unauthenticated request.
  const cacheKey = JSON.stringify(list);
  if (verifierCache.has(cacheKey)) return verifierCache.get(cacheKey);
  const issuers = issuersConfig();
  if (!issuers) {
    verifierCache.set(cacheKey, null);
    return null;
  }
  const { createMcpAccessTokenVerifier } = await import(PRIMITIVES);
  const verifier = createMcpAccessTokenVerifier({
    issuers,
    resource,
    maxTokenAge: firstEnv('AGENT_CHECKOUT_IDENTITY_MAX_TOKEN_AGE', 'IDENTITY_MAX_TOKEN_AGE') || undefined,
  });
  verifierCache.set(cacheKey, verifier);
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
 *
 * opts.suppressForRequest: predicate for hosts whose /mcp is NOT this OAuth-protected resource
 * (the anonymous public read tier) — RFC 9728 metadata claiming OAuth protection there would be
 * a false statement about the auth model, so those requests 404.
 */
function registerMcpOAuthDiscoveryRoutes(app, opts = {}) {
  const logger = opts.logger;
  const suppressForRequest = typeof opts.suppressForRequest === 'function' ? opts.suppressForRequest : null;
  const handler = async (req, res) => {
    if (!mcpOAuthEnabled()) return res.status(404).json({ error: 'not_found' });
    if (suppressForRequest && suppressForRequest(req)) return res.status(404).json({ error: 'not_found' });
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
  // RFC 9728 §3.3 path-insertion, one document per door. The handler reads the door back out of its
  // own path (doorPathFor), so each URL declares the identifier it was built from:
  //   …/oauth-protected-resource/mcp      -> resource https://host/mcp
  //   …/oauth-protected-resource/ucp/mcp  -> resource https://host/ucp/mcp
  // The bare root path stays mounted and keeps describing the NATIVE door: it is what native clients
  // discovered before this change, and re-pointing it would break them to fix nothing.
  app.get(`${RESOURCE_METADATA_PATH}${NATIVE_DOOR_PATH}`, handler);
  app.get(`${RESOURCE_METADATA_PATH}${UCP_DOOR_PATH}`, handler);
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
    verifier = await getVerifier(acceptedResourcesFor(req));
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
  acceptedResourcesFor,
  doorPathFor,
  resourceMetadataUrlFor,
  authorizationServers,
  scopesSupported,
  registerMcpOAuthDiscoveryRoutes,
  resolveMcpOAuthIdentity,
  __resetVerifierCache,
};
