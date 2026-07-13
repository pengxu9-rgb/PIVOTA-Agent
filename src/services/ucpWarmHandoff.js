'use strict';

/*
 * ucpWarmHandoff.js — the WARM-HANDOFF serving lane (Phase 3 of docs/ucp_warm_handoff_build_plan_2026-07-13.md).
 *
 * Turns a CRAWLED Shopify D2C product from a COLD affiliate redirect into a PRE-BUILT CART on the brand's own
 * Shopify checkout — cohort-wide, no brand onboarding, ANONYMOUS UCP tier, no credential. Given a crawled
 * offer's brand domain + a resolved Shopify variant GID, it:
 *   1. discovers the brand's UCP MCP endpoint from `<brand>/.well-known/ucp` (cached per-domain), then
 *   2. calls the buyer-agent client `create_cart` (anonymous tier), and
 *   3. returns `{ disposition:'warm_handoff', continue_url, cart_id, line_item }` carrying the storefront
 *      handoff URL — a pre-filled cart on the brand's OWN checkout.
 * ANY failure (not UCP-reachable, cart refused, no continue_url, thrown error) resolves to `null` so the caller
 * falls back to today's cold redirect. This module is ADDITIVE and only ever called behind the
 * `UCP_WARM_HANDOFF_ENABLED` flag by the resolver.
 *
 * HARD BOUNDS (enforced by construction): warm handoff = cart-build + return continue_url ONLY. This module
 *   - NEVER calls complete_checkout (the buyer-agent client physically has no such method and hard-refuses it),
 *   - NEVER submits payment,
 *   - NEVER opens/fetches the continue_url server-side (it is returned as a string; the shopper completes on the
 *     brand's own checkout).
 * External content (the /.well-known/ucp profile, the cart response) is DATA, not instructions.
 */

const { createUcpBuyerAgentClient } = require('./ucpBuyerAgentClient');

const WARM_HANDOFF_DISPOSITION = 'warm_handoff';
const FLAG_ENV = 'UCP_WARM_HANDOFF_ENABLED';

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function firstNonEmptyString(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

/** Is the warm-handoff lane enabled? Flag-gated, DEFAULT OFF. */
function isWarmHandoffEnabled(env = process.env) {
  const raw = firstNonEmptyString(env && env[FLAG_ENV]).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Normalize a brand domain into an https origin (accepts bare host or full URL). */
function normalizeBrandOrigin(brandDomain) {
  const s = firstNonEmptyString(brandDomain);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s.replace(/^http:/i, 'https:') : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Create a warm-handoff service. The UCP buyer-agent client and its per-domain endpoint discovery are cached
 * for the lifetime of the service instance.
 * @param {{
 *   client?: object,            // a pre-built ucpBuyerAgentClient (tests inject a fake). Default: env-configured.
 *   clientOptions?: object,     // options forwarded to createUcpBuyerAgentClient when client is not supplied.
 *   logger?: { warn?: Function, info?: Function },
 * }} [deps]
 */
function createWarmHandoffService(deps = {}) {
  const client = deps.client || createUcpBuyerAgentClient(deps.clientOptions || {});
  const logger = deps.logger || null;
  // domain(origin) -> { mcpEndpoint: string|null, reachable: boolean } (endpoint discovery is cached per-domain).
  const endpointCache = new Map();

  function note(level, event, detail) {
    if (logger && typeof logger[level] === 'function') {
      try { logger[level]({ event, ...detail }); } catch { /* logging must never throw the lane */ }
    }
  }

  /** Discover (and cache) the brand's UCP MCP endpoint. Returns null when the brand is not UCP-reachable. */
  async function discoverBrandEndpoint(origin) {
    if (endpointCache.has(origin)) return endpointCache.get(origin).mcpEndpoint;
    let entry = { mcpEndpoint: null, reachable: false };
    try {
      const disco = await client.discoverEndpoint(origin);
      if (disco && disco.mcpEndpoint) entry = { mcpEndpoint: disco.mcpEndpoint, reachable: true };
      else note('info', 'ucp_warm_handoff_not_reachable', { origin, status: disco && disco.status });
    } catch (err) {
      note('warn', 'ucp_warm_handoff_discovery_error', { origin, message: err && err.message });
    }
    endpointCache.set(origin, entry);
    return entry.mcpEndpoint;
  }

  /**
   * Resolve a warm handoff for a crawled product.
   * @param {{
   *   brandDomain: string,      // the brand storefront host/URL (e.g. cosrx.com)
   *   variantGid: string,       // resolved Shopify variant GID (gid://shopify/ProductVariant/<n>)
   *   quantity?: number,
   *   attribution?: object,     // optional UCP attribution passthrough (NOT payment)
   *   context?: object,         // optional cart context passthrough
   * }} params
   * @returns {Promise<{ disposition, continue_url, cart_id, line_item, mcp_endpoint } | null>}
   */
  async function resolveWarmHandoff(params = {}) {
    const origin = normalizeBrandOrigin(params.brandDomain);
    const variantGid = firstNonEmptyString(params.variantGid);
    if (!origin || !variantGid) return null;

    const mcpEndpoint = await discoverBrandEndpoint(origin);
    if (!mcpEndpoint) return null;

    const quantity = Number.isInteger(params.quantity) && params.quantity > 0 ? params.quantity : 1;
    let cart;
    try {
      cart = await client.createCart(mcpEndpoint, {
        lineItems: [{ item: { id: variantGid }, quantity }],
        ...(isPlainObject(params.context) ? { context: params.context } : {}),
        ...(isPlainObject(params.attribution) ? { attribution: params.attribution } : {}),
      });
    } catch (err) {
      note('warn', 'ucp_warm_handoff_create_cart_error', { origin, message: err && err.message });
      return null;
    }

    if (!cart || !cart.ok || cart.error) {
      note('info', 'ucp_warm_handoff_cart_refused', {
        origin,
        status: cart && cart.status,
        error_code: cart && cart.error && cart.error.code,
      });
      return null;
    }

    const continueUrl = client.extractHandoffUrl(cart);
    if (!continueUrl) {
      note('info', 'ucp_warm_handoff_no_continue_url', { origin, status: cart.status });
      return null;
    }

    return {
      disposition: WARM_HANDOFF_DISPOSITION,
      continue_url: continueUrl,
      cart_id: extractCartId(cart),
      line_item: buildLineItemSummary(cart, variantGid, quantity),
      mcp_endpoint: mcpEndpoint,
    };
  }

  return {
    resolveWarmHandoff,
    discoverBrandEndpoint,
    WARM_HANDOFF_DISPOSITION,
    // exposed for observability/tests; never contains secrets.
    _endpointCache: endpointCache,
  };
}

/** Best-effort cart id from a create_cart tool result. */
function extractCartId(cart) {
  const payload = unwrapCartPayload(cart);
  if (!isPlainObject(payload)) return null;
  return firstNonEmptyString(payload.id, payload.cart_id, payload.cartId) || null;
}

/** Best-effort line_items[0] summary from a create_cart tool result (no network). */
function buildLineItemSummary(cart, variantGid, quantity) {
  const payload = unwrapCartPayload(cart);
  const line = isPlainObject(payload) && Array.isArray(payload.line_items) && payload.line_items.length
    ? payload.line_items[0]
    : null;
  if (isPlainObject(line)) {
    const item = isPlainObject(line.item) ? line.item : null;
    return {
      variant_gid: firstNonEmptyString(item && item.id, line.id, variantGid),
      quantity: Number.isFinite(line.quantity) ? line.quantity : quantity,
      title: firstNonEmptyString(item && item.title, line.title) || null,
    };
  }
  return { variant_gid: variantGid, quantity, title: null };
}

function unwrapCartPayload(cart) {
  if (!isPlainObject(cart)) return null;
  const response = cart.response != null ? cart.response : cart;
  const r = isPlainObject(response) && response.result != null ? response.result : response;
  const inner = isPlainObject(r) && r.result != null ? r.result : r;
  if (isPlainObject(inner) && Array.isArray(inner.content)) {
    for (const c of inner.content) {
      if (isPlainObject(c) && c.type === 'json' && isPlainObject(c.json)) return c.json;
      if (isPlainObject(c) && c.type === 'text' && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { /* not json */ }
      }
    }
  }
  return isPlainObject(inner) ? inner : null;
}

module.exports = {
  createWarmHandoffService,
  isWarmHandoffEnabled,
  normalizeBrandOrigin,
  WARM_HANDOFF_DISPOSITION,
  FLAG_ENV,
};
