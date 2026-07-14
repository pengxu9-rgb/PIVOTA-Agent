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
// SEPARATE additive flag (Phase 1 in-chat priced preview). DEFAULT OFF. When OFF the warm-handoff result is
// byte-identical to before this preview existed (no `preview` key). When ON, after building the cart the lane
// also fetches a create_checkout PRICED preview (synthetic address, no PII) to enrich the result with
// { item, shipping_options, tax, total, currency, continue_url }. It NEVER completes checkout or pays.
const INCHAT_PREVIEW_FLAG_ENV = 'UCP_INCHAT_PREVIEW_ENABLED';

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

function isFlagOn(value) {
  const raw = firstNonEmptyString(value).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Is the warm-handoff lane enabled? Flag-gated, DEFAULT OFF. */
function isWarmHandoffEnabled(env = process.env) {
  return isFlagOn(env && env[FLAG_ENV]);
}

/** Is the Phase 1 in-chat priced preview enrichment enabled? SEPARATE flag, DEFAULT OFF. */
function isInchatPreviewEnabled(env = process.env) {
  return isFlagOn(env && env[INCHAT_PREVIEW_FLAG_ENV]);
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
  // In-chat priced preview is a SEPARATE additive flag (default OFF). Tests may force it via deps.previewEnabled.
  const previewEnabled = typeof deps.previewEnabled === 'boolean'
    ? deps.previewEnabled
    : isInchatPreviewEnabled(deps && deps.env ? deps.env : process.env);
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

    const cartId = extractCartId(cart);
    const result = {
      disposition: WARM_HANDOFF_DISPOSITION,
      continue_url: continueUrl,
      cart_id: cartId,
      line_item: buildLineItemSummary(cart, variantGid, quantity),
      mcp_endpoint: mcpEndpoint,
    };

    // PHASE 1 in-chat PRICED PREVIEW enrichment. Only when the SEPARATE flag is ON. Flag OFF => `result` above is
    // returned unchanged (byte-identical to today's warm handoff). Any preview failure is swallowed so the warm
    // handoff still succeeds with just the continue_url. HARD BOUND: create_checkout preview only — no payment,
    // no completion, the continue_url is never opened.
    if (previewEnabled && cartId && typeof client.createCheckoutPreview === 'function') {
      const preview = await buildPreview({ mcpEndpoint, cartId, variantGid, quantity, origin });
      if (preview) result.preview = preview;
    }

    return result;
  }

  /** Fetch + normalize the create_checkout priced preview. Never throws; returns null on any failure. */
  async function buildPreview({ mcpEndpoint, cartId, variantGid, quantity, origin }) {
    try {
      const pv = await client.createCheckoutPreview(mcpEndpoint, {
        cartId,
        lineItems: [{ item: { id: variantGid }, quantity }],
      });
      if (!pv || !pv.ok || !pv.priced) {
        note('info', 'ucp_inchat_preview_unavailable', { origin, status: pv && pv.status });
        return null;
      }
      const p = pv.priced;
      return {
        item: p.item || null,
        shipping_options: Array.isArray(p.shipping_options) ? p.shipping_options : [],
        tax: p.tax != null ? p.tax : null,
        subtotal: p.subtotal != null ? p.subtotal : null,
        total: p.total != null ? p.total : null,
        currency: p.currency || null,
        // The shopper still pays on the merchant storefront; this is the same handoff URL, surfaced for display.
        continue_url: p.continue_url || null,
        checkout_status: p.status || null,
        // True when the merchant still needs a delivery address / payment entered on the STOREFRONT to finalize.
        requires_escalation: Boolean(pv.requires_escalation),
        messages: Array.isArray(p.messages) ? p.messages : [],
      };
    } catch (err) {
      note('warn', 'ucp_inchat_preview_error', { origin, message: err && err.message });
      return null;
    }
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
  isInchatPreviewEnabled,
  normalizeBrandOrigin,
  WARM_HANDOFF_DISPOSITION,
  FLAG_ENV,
  INCHAT_PREVIEW_FLAG_ENV,
};
