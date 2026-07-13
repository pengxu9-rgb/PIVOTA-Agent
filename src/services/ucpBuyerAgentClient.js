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
 *     SIGNED (RFC 9421 / ECDSA P-256 HTTP Message Signatures; pubkey in the agent profile), TOKEN
 *     (`Authorization: Bearer <jwt>` from the Dev Dashboard). Higher tiers unlock more; `complete_checkout`
 *     is trust-tier gated.
 *
 * HARD SAFETY BOUNDS (enforced in code, not just convention):
 *   - There is NO method that calls `complete_checkout`, submits payment, or opens/fetches a handoff URL.
 *     `refuseCompleteCheckout()` returns a hard refusal object and performs no network call.
 *   - Credentials come from ENV ONLY (never hardcoded). The credential value is NEVER logged/printed/returned;
 *     only a boolean "present" and the derived tier are exposed via `describeTier()`.
 *   - Framework-agnostic: pure module using the global `fetch` (Node >= 18); `fetchImpl` is injectable for tests.
 */

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

  // Trust tier is derived purely from what we can present. We support ANONYMOUS + TOKEN here; SIGNED requires
  // an ECDSA signing key (founder-provisioned) and is intentionally out of scope for this probe client.
  const tier = credential ? TRUST_TIER.TOKEN : TRUST_TIER.ANONYMOUS;

  function requireFetch() {
    if (!fetchImpl) {
      throw new Error('No fetch implementation available (Node >= 18 required, or pass options.fetchImpl).');
    }
    return fetchImpl;
  }

  function requestMeta() {
    // Referenced on every UCP request so the merchant can fetch our capability profile for negotiation.
    return { 'ucp-agent': { profile: profileUrl } };
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
   */
  function buildProfile() {
    return buildUcpBuyerAgentProfile({ profileUrl, ucpVersion });
  }

  /**
   * Non-secret description of the negotiating identity: tier + whether a credential is present (boolean),
   * the requested scopes, and the profile URL. NEVER includes the credential value.
   */
  function describeTier() {
    return {
      tier,
      has_credential: Boolean(credential),
      profile_url: profileUrl,
      ucp_version: ucpVersion,
      requested_scopes: buildProfile().agent.requested_scopes,
      // We only ever support anonymous/token here; complete_checkout is refused at ALL tiers by this client.
      supports_signed_tier: false,
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
    const body = {
      jsonrpc: '2.0',
      id: cryptoId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
        _meta: requestMeta(),
      },
      meta: requestMeta(),
    };
    const res = await withTimeout((signal) => doFetch(endpoint, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
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

  /** Catalog search for the merchant's product(s). Uses `get_product`. */
  async function catalogSearch(mcpEndpoint, { query, productId, sku } = {}) {
    const args = {};
    if (query) args.query = query;
    if (productId) args.id = productId;
    if (sku) args.sku = sku;
    return callTool(mcpEndpoint, TOOL.GET_PRODUCT, args);
  }

  /**
   * Build a cart. line_items = [{ item: { id, title, price, image_url }, quantity }].
   * Cart tools accept unauthenticated (anonymous) requests per the spec.
   */
  async function createCart(mcpEndpoint, { lineItems, context, attribution } = {}) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      throw new Error('createCart requires a non-empty lineItems array');
    }
    const args = { line_items: lineItems };
    if (context) args.context = context;
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
};
