'use strict';

/*
 * Pivota OUTBOUND UCP buyer-agent client.
 *
 * This is the buyer/agent side that DID NOT EXIST before this change — the repo only had the SELLER surface
 * (`safety-kernel/src/protocol/ucpProfile.js`, `/.well-known/ucp`, the ACP REST doors). Here Pivota acts as a
 * shopping agent that calls ANOTHER merchant's UCP MCP endpoint to search the catalog, build a cart, and
 * create a checkout — then STOPS, handing the shopper off to the merchant's own storefront checkout URL.
 *
 * Grounded in the live docs (fetched 2026-07-13):
 *   - shopify.dev/docs/agents/carts-and-checkout — tools: `get_product` (catalog), `create_cart`/`get_cart`/
 *     `update_cart`/`cancel_cart`, `create_checkout`/`get_checkout`/`update_checkout`/`cancel_checkout`, and
 *     `complete_checkout` (which THIS client never calls). Cart tools accept unauthenticated requests;
 *     checkout tools require auth or a signed request. Non-terminal checkout states carry a `continue_url`
 *     that hands the buyer to the merchant's storefront.
 *   - ucp.dev/2026-04-08/specification/cart-mcp — the MCP endpoint is discovered from the target business
 *     profile at `<business>/.well-known/ucp` (`services...endpoint`, e.g. "https://business.example.com/ucp/mcp").
 *     Every request carries `meta["ucp-agent"].profile` = the agent's hosted profile URL.
 *   - shopify.dev/docs/agents/profiles/auth-and-rate-limiting — trust tiers: ANONYMOUS (no auth header),
 *     SIGNED (RFC 9421 / ECDSA P-256 HTTP Message Signatures; pubkey in the agent profile — "No registration
 *     required", self-generated key), TOKEN (`Authorization: Bearer <jwt>` from the Dev Dashboard). Higher tiers
 *     unlock more; `complete_checkout` is trust-tier gated (TOKEN-only) and this client NEVER calls it at any tier.
 *
 * SIGNED-TIER SIGNATURE CONSTRUCTION (ucp.dev/2026-04-08/specification/signatures, fetched 2026-07-13):
 *   - Signature base covered components, in order (POST with body + idempotency): "@method" "@authority"
 *     "@path" ["@query" if present] "ucp-agent" "idempotency-key" "content-digest" "content-type".
 *   - Content-Digest: RFC 9530 `sha-256=:<base64(sha256(body))>:` — MUST be sha-256.
 *   - Signature-Input: `sig1=(<components>);created=<ts>;expires=<ts>;keyid="<jwk kid>"`. NO `alg` param — the
 *     algorithm is derived from the key's JWK `crv` (P-256 => ecdsa-p256-sha256).
 *   - Signature: `sig1=:<base64(raw r||s)>:` — ECDSA MUST be fixed-width raw r||s (IEEE P1363), NOT ASN.1/DER.
 *   - keyid matches a JWK `kid` published in our profile's `ucp.signing_keys`.
 *   - `ucp-agent` and `idempotency-key` are carried in the JSON-RPC `meta` (MCP requirement) AND mirrored as
 *     covered HTTP headers so the signature binds them; the body itself is bound via content-digest.
 *
 * HARD SAFETY BOUNDS (enforced in code, not just convention):
 *   - There is NO method that calls `complete_checkout`, submits payment, or opens/fetches a handoff URL.
 *     `refuseCompleteCheckout()` returns a hard refusal object and performs no network call.
 *   - Credentials AND the signing PRIVATE key come from ENV ONLY (never hardcoded). Neither value is ever
 *     logged/printed/returned; only booleans "present" and the derived tier are exposed via `describeTier()`.
 *   - Framework-agnostic: pure module using the global `fetch` (Node >= 18); `fetchImpl` is injectable for tests.
 */

const nodeCrypto = require('node:crypto');
const {
  buildUcpBuyerAgentProfile,
  DEFAULT_UCP_VERSION,
} = require('./ucpBuyerAgentProfile');

// MCP tool names (verbatim from the live spec). complete_checkout is listed for the refusal guard ONLY.
const TOOL = Object.freeze({
  GET_PRODUCT: 'get_product',
  CREATE_CART: 'create_cart',
  GET_CART: 'get_cart',
  CREATE_CHECKOUT: 'create_checkout',
  GET_CHECKOUT: 'get_checkout',
  COMPLETE_CHECKOUT: 'complete_checkout', // NEVER invoked by this client.
});

const TRUST_TIER = Object.freeze({
  ANONYMOUS: 'anonymous',
  SIGNED: 'signed',
  TOKEN: 'token',
});

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function normalizeBaseUrl(u, field) {
  const s = firstNonEmpty(u);
  if (!s) throw new Error(`${field} is required`);
  let parsed;
  try { parsed = new URL(s); } catch { throw new Error(`${field} must be a valid URL: ${s}`); }
  if (parsed.protocol !== 'https:') throw new Error(`${field} must be https: ${s}`);
  return parsed;
}

/**
 * Create a UCP buyer-agent client.
 * @param {{
 *   credential?: string,        // JWT/token for the TOKEN tier. Defaults to env UCP_AGENT_CREDENTIAL. Never logged.
 *   profileUrl?: string,        // agent profile HTTPS URL. Defaults to env UCP_AGENT_PROFILE_URL.
 *   ucpVersion?: string,
 *   fetchImpl?: Function,       // injectable fetch (default: global fetch). Tests pass a fixture fetch.
 *   userAgent?: string,
 *   timeoutMs?: number,
 * }} [options]
 */
function createUcpBuyerAgentClient(options = {}) {
  const credential = firstNonEmpty(options.credential, process.env.UCP_AGENT_CREDENTIAL);
  const profileUrl = firstNonEmpty(
    options.profileUrl,
    process.env.UCP_AGENT_PROFILE_URL,
    'https://agent.pivota.cc/.well-known/ucp-agent',
  );
  const ucpVersion = firstNonEmpty(options.ucpVersion, process.env.UCP_AGENT_VERSION, DEFAULT_UCP_VERSION);
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const userAgent = firstNonEmpty(options.userAgent, 'Pivota-UCP-BuyerAgent/1.0');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 15000;
  const signatureTtlSec = Number.isFinite(options.signatureTtlSec) ? Number(options.signatureTtlSec) : 300;

  // SIGNED tier: load our OWN ECDSA P-256 private key from env ONLY (PEM or JWK). Never logged. The public half
  // lives in the hosted profile's `ucp.signing_keys`; `keyid` must match its JWK `kid`.
  const signingPrivateRaw = firstNonEmpty(options.signingPrivateKey, process.env.UCP_AGENT_SIGNING_PRIVATE_KEY);
  let signingKeyObject;
  let signingKeyId;
  if (signingPrivateRaw) {
    const loaded = loadSigningPrivateKey(signingPrivateRaw);
    signingKeyObject = loaded.keyObject;
    signingKeyId = firstNonEmpty(options.signingKeyId, process.env.UCP_AGENT_SIGNING_KEY_ID, loaded.kid);
    if (!signingKeyId) {
      throw new Error('UCP signing key present but no keyid — set UCP_AGENT_SIGNING_KEY_ID or embed "kid" in the JWK.');
    }
  }
  const canSign = Boolean(signingKeyObject);
  // Optional explicit public JWK(s) to publish in the profile (else the profile module reads env). Never private.
  const signingKeysToPublish = Array.isArray(options.signingKeys) ? options.signingKeys : undefined;

  // Trust tier is derived by descending capability: a Bearer token (TOKEN) beats a signing key (SIGNED) beats
  // nothing (ANONYMOUS). complete_checkout is refused at ALL of them by this client.
  const tier = credential ? TRUST_TIER.TOKEN : (canSign ? TRUST_TIER.SIGNED : TRUST_TIER.ANONYMOUS);

  function requireFetch() {
    if (!fetchImpl) {
      throw new Error('No fetch implementation available (Node >= 18 required, or pass options.fetchImpl).');
    }
    return fetchImpl;
  }

  // The UCP-agent profile pointer. Carried in JSON-RPC meta (MCP requirement) and, when signing, mirrored as a
  // structured-field HTTP header `ucp-agent: profile="<url>"` so the RFC 9421 signature can cover it.
  function ucpAgentMeta() {
    return { profile: profileUrl };
  }
  function ucpAgentHeaderValue() {
    return `profile="${profileUrl}"`;
  }

  function requestMeta(idempotencyKey) {
    // Referenced on every UCP request so the merchant can fetch our capability profile for negotiation.
    const meta = { 'ucp-agent': ucpAgentMeta() };
    if (idempotencyKey) meta['idempotency-key'] = idempotencyKey;
    return meta;
  }

  function authHeaders() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': userAgent,
    };
    // TOKEN tier only. Never logged. ANONYMOUS/SIGNED send no Authorization header.
    if (tier === TRUST_TIER.TOKEN) headers.authorization = `Bearer ${credential}`;
    return headers;
  }

  /**
   * The agent capability profile we publish/serve. Requests catalog+cart+checkout scopes, never completion.
   * Publishes our PUBLIC signing JWK(s) (from options.signingKeys or env) so SIGNED-tier verifiers can find them.
   */
  function buildProfile() {
    return buildUcpBuyerAgentProfile({ profileUrl, ucpVersion, signingKeys: signingKeysToPublish });
  }

  /**
   * Non-secret description of the negotiating identity: tier + whether a credential is present (boolean),
   * the requested scopes, and the profile URL. NEVER includes the credential value.
   */
  function describeTier() {
    const profile = buildProfile();
    return {
      tier,
      has_credential: Boolean(credential),
      // Boolean only — the private key value is NEVER exposed.
      has_signing_key: canSign,
      signing_key_id: canSign ? signingKeyId : undefined,
      published_signing_key_ids: (profile.ucp.signing_keys || []).map((k) => k && k.kid).filter(Boolean),
      profile_url: profileUrl,
      ucp_version: ucpVersion,
      requested_scopes: profile.agent.requested_scopes,
      // SIGNED tier is now implemented (RFC 9421). complete_checkout is STILL refused at ALL tiers by this client.
      supports_signed_tier: canSign,
      completes_checkout: false,
    };
  }

  /**
   * Discover a target business's UCP MCP endpoint from its `/.well-known/ucp` profile.
   * @param {string} businessBaseUrl  https origin of the merchant storefront (e.g. https://cosrx.com)
   * @returns {Promise<{ mcpEndpoint: string|undefined, businessProfile: object, wellKnownUrl: string }>}
   */
  async function discoverEndpoint(businessBaseUrl) {
    const base = normalizeBaseUrl(businessBaseUrl, 'businessBaseUrl');
    const wellKnownUrl = new URL('/.well-known/ucp', base.origin).toString();
    const doFetch = requireFetch();
    const res = await withTimeout((signal) => doFetch(wellKnownUrl, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': userAgent },
      signal,
    }), timeoutMs);
    if (!res.ok) {
      return { mcpEndpoint: undefined, businessProfile: null, wellKnownUrl, status: res.status };
    }
    const businessProfile = await res.json();
    const mcpEndpoint = extractMcpEndpoint(businessProfile);
    return { mcpEndpoint, businessProfile, wellKnownUrl, status: res.status };
  }

  /**
   * Low-level MCP tool call (JSON-RPC 2.0 `tools/call`) against a discovered endpoint.
   * Never call this with TOOL.COMPLETE_CHECKOUT — a guard throws.
   */
  async function callTool(mcpEndpoint, toolName, args = {}) {
    if (toolName === TOOL.COMPLETE_CHECKOUT) {
      throw new Error('ucpBuyerAgentClient: complete_checkout is hard-disabled (cart-build + handoff only).');
    }
    const endpoint = normalizeBaseUrl(mcpEndpoint, 'mcpEndpoint').toString();
    const doFetch = requireFetch();
    // Idempotency key is minted for signed (state-changing) requests; it lives in meta AND is a covered header.
    const idempotencyKey = tier === TRUST_TIER.SIGNED ? cryptoId() : undefined;
    const meta = requestMeta(idempotencyKey);
    // LIVE-VERIFIED shape (cosrx create_cart inputSchema, 2026-07-13): the tool's own fields sit DIRECTLY
    // alongside `meta` inside params.arguments (e.g. { meta, cart: { line_items: [...] } }). They are NOT
    // wrapped under an `input` object, and `meta` lives at params.arguments.meta. Sending an `input` wrapper
    // (or hoisting meta to params._meta / body.meta only) fails the live schema validation.
    const argumentsWithMeta = { meta, ...args };
    const body = {
      jsonrpc: '2.0',
      id: cryptoId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: argumentsWithMeta,
      },
    };
    const bodyString = JSON.stringify(body);

    const headers = authHeaders();
    if (tier === TRUST_TIER.SIGNED) {
      // Mirror the meta pointers as covered HTTP headers, then sign. The private key never leaves this scope.
      headers['ucp-agent'] = ucpAgentHeaderValue();
      headers['idempotency-key'] = idempotencyKey;
      const created = Math.floor(Date.now() / 1000);
      const expires = created + signatureTtlSec;
      const { headers: sigHeaders } = signUcpRequest({
        method: 'POST',
        url: endpoint,
        bodyString,
        ucpAgentValue: headers['ucp-agent'],
        idempotencyKey,
        keyObject: signingKeyObject,
        keyid: signingKeyId,
        created,
        expires,
      });
      Object.assign(headers, sigHeaders);
    }

    const res = await withTimeout((signal) => doFetch(endpoint, {
      method: 'POST',
      headers,
      body: bodyString,
      signal,
    }), timeoutMs);
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return {
      ok: res.ok,
      status: res.status,
      tool: toolName,
      tier,
      response: parsed,
      // JSON-RPC error (e.g. auth/tier refusal) is surfaced without throwing so the probe can log it.
      error: parsed && parsed.error ? parsed.error : (res.ok ? undefined : { code: res.status, message: text }),
    };
  }

  /**
   * Catalog search via `get_product`. NOTE (live-verified cosrx 2026-07-13): the per-merchant UCP endpoint
   * exposes cart + checkout tools ONLY and returns "Tool not found" for `get_product`. Product discovery is
   * the Global Catalog / our own crawled index — do NOT point this at a per-merchant endpoint.
   */
  async function catalogSearch(mcpEndpoint, { query, productId, sku } = {}) {
    const args = {};
    if (query) args.query = query;
    if (productId) args.id = productId;
    if (sku) args.sku = sku;
    return callTool(mcpEndpoint, TOOL.GET_PRODUCT, args);
  }

  /**
   * Build a cart. line_items = [{ item: { id: "gid://shopify/ProductVariant/<n>" }, quantity }].
   * LIVE-VERIFIED (cosrx, 2026-07-13): create_cart's tool field is a `cart` object wrapping `line_items`,
   * i.e. arguments = { meta, cart: { line_items: [...] } }. Cart tools accept unauthenticated (anonymous)
   * requests per the spec, and the returned cart carries a storefront `continue_url` (warm handoff).
   */
  async function createCart(mcpEndpoint, { lineItems, context, attribution } = {}) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      throw new Error('createCart requires a non-empty lineItems array');
    }
    const cart = { line_items: lineItems };
    if (context) cart.context = context;
    const args = { cart };
    if (attribution) args.attribution = attribution;
    return callTool(mcpEndpoint, TOOL.CREATE_CART, args);
  }

  /**
   * Create a checkout from a cart. Checkout tools require auth/signed per spec — at anonymous tier this is
   * expected to be refused, which is itself a probe finding (captured, not forced).
   */
  async function createCheckout(mcpEndpoint, { cartId, buyer } = {}) {
    if (!cartId) throw new Error('createCheckout requires cartId');
    const args = { cart_id: cartId };
    if (buyer) args.buyer = buyer;
    return callTool(mcpEndpoint, TOOL.CREATE_CHECKOUT, args);
  }

  /**
   * HARD REFUSAL: Pivota never completes checkout / submits payment in this probe. This performs NO network
   * call. It documents that completion is trust-tier gated and hands off to the storefront instead.
   */
  function refuseCompleteCheckout() {
    return {
      refused: true,
      tool: TOOL.COMPLETE_CHECKOUT,
      reason: 'pivota_policy_no_autonomous_payment',
      detail:
        'Pivota buyer-agent never calls complete_checkout, submits payment, or opens a handoff URL. Payment '
        + 'completion is trust-tier gated by the merchant/platform; the shopper completes on the merchant\'s '
        + 'own storefront checkout via the returned continue_url/checkout_url.',
      tier,
    };
  }

  /**
   * Extract the storefront handoff URL from a cart/checkout response without opening it.
   * Per spec, non-terminal states carry `continue_url`; some variants also expose `checkout_url`.
   */
  function extractHandoffUrl(toolResult) {
    const payload = unwrapToolPayload(toolResult);
    if (!payload || typeof payload !== 'object') return undefined;
    return firstNonEmpty(payload.continue_url, payload.checkout_url, payload.permalink, payload.url);
  }

  return {
    TOOL,
    TRUST_TIER,
    tier,
    buildProfile,
    describeTier,
    discoverEndpoint,
    callTool,
    catalogSearch,
    createCart,
    createCheckout,
    refuseCompleteCheckout,
    extractHandoffUrl,
  };
}

// ---- helpers ---------------------------------------------------------------

function extractMcpEndpoint(businessProfile) {
  if (!businessProfile || typeof businessProfile !== 'object') return undefined;
  const services = businessProfile.services ?? businessProfile.ucp?.services;
  // services can be an array (seller-style [{transport,endpoint}]) or an object keyed by service name.
  const bindings = [];
  if (Array.isArray(services)) bindings.push(...services);
  else if (services && typeof services === 'object') {
    for (const v of Object.values(services)) {
      if (Array.isArray(v)) bindings.push(...v);
      else if (v && typeof v === 'object') bindings.push(v);
    }
  }
  const mcp = bindings.find((b) => b && String(b.transport).toLowerCase() === 'mcp' && (b.endpoint || b.url));
  return mcp ? firstNonEmpty(mcp.endpoint, mcp.url) : undefined;
}

function unwrapToolPayload(toolResult) {
  if (!toolResult || typeof toolResult !== 'object') return undefined;
  const r = toolResult.response ?? toolResult;
  // JSON-RPC success: { result: { ... } } or MCP content wrapper { result: { content: [...] } }.
  const result = r.result ?? r;
  if (result && Array.isArray(result.content)) {
    for (const c of result.content) {
      if (c && c.type === 'json' && c.json) return c.json;
      if (c && c.type === 'text' && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { /* not json */ }
      }
    }
  }
  if (result && (result.continue_url || result.checkout_url || result.id || result.line_items)) return result;
  return result;
}

function cryptoId() {
  try {
    // eslint-disable-next-line global-require
    return require('node:crypto').randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ---- RFC 9421 signing (SIGNED tier) ---------------------------------------

/**
 * Load an ECDSA P-256 PRIVATE key from a PEM or JWK string into a Node KeyObject. Never logs the material.
 * @param {string} raw  PEM (PKCS8/SEC1) or a JWK JSON string. From env only.
 * @returns {{ keyObject: import('crypto').KeyObject, kid: string|undefined }}
 */
function loadSigningPrivateKey(raw) {
  const s = firstNonEmpty(raw);
  if (!s) return { keyObject: undefined, kid: undefined };
  if (s.startsWith('{')) {
    let jwk;
    try { jwk = JSON.parse(s); } catch { throw new Error('UCP_AGENT_SIGNING_PRIVATE_KEY is not valid JSON (JWK)'); }
    if (!jwk || jwk.d === undefined) throw new Error('signing JWK is missing private component "d"');
    return { keyObject: nodeCrypto.createPrivateKey({ key: jwk, format: 'jwk' }), kid: jwk.kid };
  }
  return { keyObject: nodeCrypto.createPrivateKey(s), kid: undefined };
}

/** RFC 9530 Content-Digest for a request body. Always sha-256. */
function contentDigestFor(bodyString) {
  const hash = nodeCrypto.createHash('sha256').update(bodyString, 'utf8').digest('base64');
  return `sha-256=:${hash}:`;
}

/**
 * Build the RFC 9421 signature base + Signature-Input params for a UCP MCP request. Pure/deterministic given
 * its inputs (used directly by tests). Component values are the exact HTTP field / derived-component values.
 * @returns {{ base: string, params: string, covered: string[], contentDigest: string }}
 */
function buildUcpSignatureBase({ method, url, bodyString, ucpAgentValue, idempotencyKey, keyid, created, expires }) {
  const u = new URL(url);
  const contentDigest = bodyString != null ? contentDigestFor(bodyString) : undefined;
  const fields = [];
  fields.push(['@method', String(method || 'POST').toUpperCase()]);
  fields.push(['@authority', u.host]);
  fields.push(['@path', u.pathname]);
  if (u.search) fields.push(['@query', u.search]);
  if (ucpAgentValue) fields.push(['ucp-agent', ucpAgentValue]);
  if (idempotencyKey) fields.push(['idempotency-key', idempotencyKey]);
  if (contentDigest) fields.push(['content-digest', contentDigest]);
  if (bodyString != null) fields.push(['content-type', 'application/json']);

  const covered = fields.map(([name]) => name);
  const inner = covered.map((n) => `"${n}"`).join(' ');
  let params = `(${inner})`;
  if (created != null) params += `;created=${created}`;
  if (expires != null) params += `;expires=${expires}`;
  params += `;keyid="${keyid}"`; // NO alg param — derived from JWK crv per the spec.

  const lines = fields.map(([name, value]) => `"${name}": ${value}`);
  lines.push(`"@signature-params": ${params}`);
  return { base: lines.join('\n'), params, covered, contentDigest };
}

/**
 * Sign a UCP MCP request. Returns the HTTP headers to attach (content-digest, signature-input, signature) plus
 * the covered components (for logging/tests). The private key + signature never leak any private material.
 */
function signUcpRequest({ method, url, bodyString, ucpAgentValue, idempotencyKey, keyObject, keyid, created, expires }) {
  const { base, params, covered, contentDigest } = buildUcpSignatureBase({
    method, url, bodyString, ucpAgentValue, idempotencyKey, keyid, created, expires,
  });
  // ECDSA P-256 over SHA-256, raw r||s (IEEE P1363) per RFC 9421 — NOT DER.
  const sig = nodeCrypto.sign('sha256', Buffer.from(base, 'utf8'), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  const headers = {
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${sig.toString('base64')}:`,
  };
  if (contentDigest) headers['content-digest'] = contentDigest;
  return { headers, covered, signatureBase: base };
}

async function withTimeout(run, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return run(undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createUcpBuyerAgentClient,
  TOOL,
  TRUST_TIER,
  // Exposed for deterministic signing tests (no live network). Not part of the public client surface.
  loadSigningPrivateKey,
  contentDigestFor,
  buildUcpSignatureBase,
  signUcpRequest,
};
