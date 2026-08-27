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

const { createUcpBuyerAgentClient, FAILURE_REASON, classifyUcpFailure } = require('./ucpBuyerAgentClient');
const defaultWarmHandoffMetrics = require('../observability/ucpWarmHandoffMetrics');
// Shared with ucpOrderWebhookReceiver: undici hides the real network reason on `.cause`. See that module.
const { fetchCauseDetail } = require('../observability/fetchCauseDetail');

const WARM_HANDOFF_DISPOSITION = 'warm_handoff';
const FLAG_ENV = 'UCP_WARM_HANDOFF_ENABLED';

// H1 resilience defaults (all overridable). Bounded so a slow brand can't hang the handoff — any breach falls
// back to the cold redirect.
const DEFAULT_ENDPOINT_TTL_MS = 10 * 60 * 1000; // reachable endpoint cached 10 min
const DEFAULT_NEGATIVE_TTL_MS = 60 * 1000; // unreachable domain negative-cached only 60s (re-check sooner, don't hammer)
const DEFAULT_CACHE_MAX_ENTRIES = 500; // bounded LRU-ish cap on distinct brand domains
const DEFAULT_CALL_TIMEOUT_MS = 6000; // per-call timeout for the warm-handoff client
const DEFAULT_CALL_RETRY_ATTEMPTS = 1; // at most one retry of an idempotent GET on the serving path
const DEFAULT_TOTAL_BUDGET_MS = 9000; // total discover->cart(->preview) wall-clock budget
// SEPARATE additive flag (Phase 1 in-chat priced preview). DEFAULT OFF. When OFF the warm-handoff result is
// byte-identical to before this preview existed (no `preview` key). When ON, after building the cart the lane
// also fetches a create_checkout PRICED preview (synthetic address, no PII) to enrich the result with
// { item, shipping_options, tax, total, currency, continue_url }. It NEVER completes checkout or pays.
const INCHAT_PREVIEW_FLAG_ENV = 'UCP_INCHAT_PREVIEW_ENABLED';
// Below this there is no point starting a create_checkout at all — it would time out inside the
// remaining window and cost the shopper the wait for nothing.
const MIN_PREVIEW_BUDGET_MS = 400;

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
 * A tiny bounded TTL cache (explicit, per the H1 mandate). Entries expire after their own `expiresAt`; a
 * distinct positive vs. negative TTL lets unreachable domains re-check sooner without hammering. When the entry
 * count exceeds `maxEntries` the oldest insertion is evicted (Map preserves insertion order). Time is injectable
 * for deterministic tests.
 * @param {{ maxEntries?: number, now?: () => number }} [opts]
 */
function createTtlCache({ maxEntries = DEFAULT_CACHE_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt != null && now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      // Refresh insertion order so recently-set keys survive eviction longest.
      if (store.has(key)) store.delete(key);
      const expiresAt = Number.isFinite(ttlMs) && ttlMs > 0 ? now() + ttlMs : null;
      store.set(key, { value, expiresAt });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    delete(key) { store.delete(key); },
    get size() { return store.size; },
    clear() { store.clear(); },
  };
}

/** Bare host of an https origin (for a low-cardinality, PII-free metric/log label). */
function hostOf(origin) {
  try { return new URL(origin).host; } catch { return firstNonEmptyString(origin) || 'unknown'; }
}

/**
 * Create a warm-handoff service. The UCP buyer-agent client and its per-domain endpoint discovery are cached
 * for the lifetime of the service instance.
 * @param {{
 *   client?: object,            // a pre-built ucpBuyerAgentClient (tests inject a fake). Default: env-configured.
 *   clientOptions?: object,     // options forwarded to createUcpBuyerAgentClient when client is not supplied.
 *   logger?: { warn?: Function, info?: Function },
 *   metrics?: object,           // observability sink (default: src/observability/ucpWarmHandoffMetrics).
 *   totalBudgetMs?: number,     // total discover->cart(->preview) wall-clock budget (default env or 9000).
 *   endpointTtlMs?: number,     // positive endpoint-cache TTL (default 10min).
 *   negativeTtlMs?: number,     // negative (unreachable) cache TTL (default 60s, shorter — re-check sooner).
 *   cacheMaxEntries?: number,   // bounded cache cap (default 500).
 *   now?: () => number,         // injectable clock for tests.
 * }} [deps]
 */
function createWarmHandoffService(deps = {}) {
  // Bounded per-call timeout + at-most-one idempotent retry on the LIVE serving path so a slow brand can't hang
  // the handoff. Caller-supplied clientOptions win.
  const clientOptions = {
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    retryAttempts: DEFAULT_CALL_RETRY_ATTEMPTS,
    ...(isPlainObject(deps.clientOptions) ? deps.clientOptions : {}),
  };
  const client = deps.client || createUcpBuyerAgentClient(clientOptions);
  const logger = deps.logger || null;
  const metrics = deps.metrics || defaultWarmHandoffMetrics;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const totalBudgetMs = Number.isFinite(deps.totalBudgetMs)
    ? Number(deps.totalBudgetMs)
    : (Number.isFinite(Number(process.env.UCP_WARM_HANDOFF_BUDGET_MS))
      ? Number(process.env.UCP_WARM_HANDOFF_BUDGET_MS)
      : DEFAULT_TOTAL_BUDGET_MS);
  const endpointTtlMs = Number.isFinite(deps.endpointTtlMs) ? Number(deps.endpointTtlMs) : DEFAULT_ENDPOINT_TTL_MS;
  const negativeTtlMs = Number.isFinite(deps.negativeTtlMs) ? Number(deps.negativeTtlMs) : DEFAULT_NEGATIVE_TTL_MS;
  const cacheMaxEntries = Number.isFinite(deps.cacheMaxEntries) ? Number(deps.cacheMaxEntries) : DEFAULT_CACHE_MAX_ENTRIES;
  // In-chat priced preview is a SEPARATE additive flag (default OFF). Tests may force it via deps.previewEnabled.
  const previewEnabled = typeof deps.previewEnabled === 'boolean'
    ? deps.previewEnabled
    : isInchatPreviewEnabled(deps && deps.env ? deps.env : process.env);
  // Explicit, bounded, TTL'd endpoint cache. Value = { mcpEndpoint: string|null, reachable, reason }.
  const endpointCache = createTtlCache({ maxEntries: cacheMaxEntries, now });
  // Hosts that have EVER resolved reachable in this process — used to detect reachability drift (a brand that
  // used to expose UCP starts failing discovery). PII-free (host only).
  const everReachable = new Set();

  function note(level, event, detail) {
    if (logger && typeof logger[level] === 'function') {
      try { logger[level]({ event, ...detail }); } catch { /* logging must never throw the lane */ }
    }
  }

  function safeMetric(fn, arg) {
    if (metrics && typeof metrics[fn] === 'function') {
      try { metrics[fn](arg); } catch { /* metrics must never throw the lane */ }
    }
  }

  /**
   * Discover the brand's UCP MCP endpoint with an explicit bounded TTL cache (+ negative cache for unreachable
   * domains) and reachability-drift detection. Returns { mcpEndpoint, reachable, reason }.
   */
  async function discoverBrandEndpointDetailed(origin) {
    const cached = endpointCache.get(origin);
    if (cached !== undefined) return cached;

    let entry = { mcpEndpoint: null, reachable: false, reason: FAILURE_REASON.NOT_UCP_REACHABLE };
    try {
      const disco = await client.discoverEndpoint(origin);
      const status = disco && Number(disco.status);
      if (disco && disco.mcpEndpoint) {
        entry = { mcpEndpoint: disco.mcpEndpoint, reachable: true, reason: null };
      } else if (status >= 300 && status < 400) {
        // The client refuses a redirected profile (UCP MUST NOT follow) and hands the 3xx back as its
        // status. That is NOT "the brand exposes no UCP" — it is a merchant that put a redirect in front of
        // its profile, which someone can go fix — so it gets its own reason (a taxonomy/metric label of its
        // own, not folded into not_ucp_reachable) and a WARN, not the info line the highest-volume
        // no-profile path uses. Classified on the STATUS, never on any error wording.
        entry = { mcpEndpoint: null, reachable: false, reason: FAILURE_REASON.PROFILE_REDIRECTED };
        note('warn', 'ucp_warm_handoff_profile_redirected', { origin, status });
      } else {
        entry = { mcpEndpoint: null, reachable: false, reason: FAILURE_REASON.NOT_UCP_REACHABLE };
        note('info', 'ucp_warm_handoff_not_reachable', { origin, status: disco && disco.status });
      }
    } catch (err) {
      entry = { mcpEndpoint: null, reachable: false, reason: classifyUcpFailure({ thrown: err, phase: 'discovery' }) };
      note('warn', 'ucp_warm_handoff_discovery_error', {
        origin, message: err && err.message, ...fetchCauseDetail(err), reason: entry.reason,
      });
    }

    if (entry.reachable) {
      everReachable.add(hostOf(origin));
    } else if (everReachable.has(hostOf(origin))) {
      // A previously-reachable brand is now failing discovery: emit a reachability-drift signal (cohort coverage
      // is changing). Emitted on the fresh check that flips reachable->unreachable (negative TTL rate-limits it).
      note('warn', 'ucp_warm_handoff_reachability_drift', { origin, brand_domain: hostOf(origin), reason: entry.reason });
      safeMetric('recordReachabilityDrift', { brandDomain: hostOf(origin) });
    }

    endpointCache.set(origin, entry, entry.reachable ? endpointTtlMs : negativeTtlMs);
    return entry;
  }

  /** Back-compat: discover (and cache) the brand's UCP MCP endpoint; returns the endpoint string or null. */
  async function discoverBrandEndpoint(origin) {
    const detailed = await discoverBrandEndpointDetailed(origin);
    return detailed ? detailed.mcpEndpoint : null;
  }

  /**
   * Resolve a warm handoff for a crawled product. EVERY failure path resolves to a clean `null` (cold-redirect
   * fallback), tagged with an H1 taxonomy `reason` for observability. Success behavior is unchanged.
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
    const startedAt = now();
    const origin = normalizeBrandOrigin(params.brandDomain);
    const variantGid = firstNonEmptyString(params.variantGid);

    // Terminal fallback: record the tagged reason + latency, then return null so the caller cold-redirects.
    function fallback(reason, brandDomain) {
      safeMetric('recordWarmHandoffOutcome', { outcome: 'fallback', reason, brandDomain });
      safeMetric('observeWarmHandoffLatency', { outcome: 'fallback', latencyMs: now() - startedAt });
      return null;
    }

    if (!origin || !variantGid) {
      // No usable inputs — this is not a UCP failure; tag as invalid_input for visibility.
      return fallback(FAILURE_REASON.INVALID_INPUT, hostOf(origin || firstNonEmptyString(params.brandDomain)));
    }
    const brandLabel = hostOf(origin);

    const detailed = await discoverBrandEndpointDetailed(origin);
    if (!detailed || !detailed.mcpEndpoint) {
      return fallback((detailed && detailed.reason) || FAILURE_REASON.NOT_UCP_REACHABLE, brandLabel);
    }
    const mcpEndpoint = detailed.mcpEndpoint;

    // Total-latency guard: if discovery already burned the budget, bail to cold redirect rather than risk a hang.
    if (now() - startedAt > totalBudgetMs) {
      note('info', 'ucp_warm_handoff_budget_exceeded', { origin, phase: 'pre_cart' });
      return fallback(FAILURE_REASON.TIMEOUT, brandLabel);
    }

    const quantity = Number.isInteger(params.quantity) && params.quantity > 0 ? params.quantity : 1;
    let cart;
    try {
      cart = await client.createCart(mcpEndpoint, {
        lineItems: [{ item: { id: variantGid }, quantity }],
        ...(isPlainObject(params.context) ? { context: params.context } : {}),
        ...(isPlainObject(params.attribution) ? { attribution: params.attribution } : {}),
      });
    } catch (err) {
      const reason = classifyUcpFailure({ thrown: err, phase: 'create_cart' });
      note('warn', 'ucp_warm_handoff_create_cart_error', {
        origin, message: err && err.message, ...fetchCauseDetail(err), reason,
      });
      return fallback(reason, brandLabel);
    }

    if (!cart || !cart.ok || cart.error) {
      // Classify the merchant's own error (out-of-stock / invalid-variant / discontinued / schema) so the cold
      // fallback is tagged; never surface a broken cart.
      const reason = classifyUcpFailure({
        status: cart && cart.status,
        errorMessage: cart && cart.error && (cart.error.message || cart.error.code),
        phase: 'create_cart',
      });
      note('info', 'ucp_warm_handoff_cart_refused', {
        origin,
        status: cart && cart.status,
        error_code: cart && cart.error && cart.error.code,
        reason,
      });
      return fallback(reason, brandLabel);
    }

    const continueUrl = client.extractHandoffUrl(cart);
    if (!continueUrl) {
      note('info', 'ucp_warm_handoff_no_continue_url', { origin, status: cart.status });
      return fallback(FAILURE_REASON.NO_CONTINUE_URL, brandLabel);
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
    //
    // BOUNDED BY WHAT IS LEFT, not by "the budget is not yet spent". The old check was a START GATE: it let the
    // preview begin at budget-minus-1ms and then take its own full per-call ceiling on top. Measured against a
    // 2000ms click budget: 1954ms without the preview, 3455ms with it — past the BACKEND caller's hard 2.5s
    // `asyncio.wait_for`, which aborts to a COLD redirect. So enabling the flag did not degrade to cart-only as
    // designed; it threw the whole warm handoff away. The shopper is waiting on a 302 for this.
    const previewRemainingMs = totalBudgetMs - (now() - startedAt);
    if (previewEnabled && cartId && typeof client.createCheckoutPreview === 'function'
      && previewRemainingMs >= MIN_PREVIEW_BUDGET_MS) {
      const preview = await buildPreview({
        mcpEndpoint, cartId, variantGid, quantity, origin, budgetMs: previewRemainingMs,
      });
      if (preview) result.preview = preview;
    }

    // SUCCESS — the lane returned a warm cart + continue_url. Record success + latency (no PII, no URL material).
    safeMetric('recordWarmHandoffOutcome', { outcome: 'success', reason: 'ok', brandDomain: brandLabel });
    safeMetric('observeWarmHandoffLatency', { outcome: 'success', latencyMs: now() - startedAt });
    return result;
  }

  /** Fetch + normalize the create_checkout priced preview. Never throws; returns null on any failure. */
  async function buildPreview({ mcpEndpoint, cartId, variantGid, quantity, origin, budgetMs }) {
    try {
      const pv = await client.createCheckoutPreview(mcpEndpoint, {
        cartId,
        lineItems: [{ item: { id: variantGid }, quantity }],
        // The caller's REMAINING window, so this call cannot outlive the budget it was admitted
        // under. Without it the per-call ceiling applied on top of an almost-exhausted budget.
        ...(Number.isFinite(budgetMs) ? { timeoutMs: Math.max(1, Math.floor(budgetMs)) } : {}),
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
        // THE HOP THAT ACTUALLY DELIVERS IT. This whitelist — not the client's normalized
        // object — is what `ucpWarmHandoffInternalRoute` receives as `handoff.preview`, so a
        // field lifted in `normalizePricedCheckout` and omitted here reaches the route as
        // `undefined` and is published as a constant `null`. Lifting the id without this line
        // is a no-op with a green test suite, which is exactly how it was first written.
        checkout_id: p.checkout_id || null,
        checkout_status: p.status || null,
        // True when the merchant still needs a delivery address / payment entered on the STOREFRONT to finalize.
        requires_escalation: Boolean(pv.requires_escalation),
        messages: Array.isArray(p.messages) ? p.messages : [],
      };
    } catch (err) {
      note('warn', 'ucp_inchat_preview_error', { origin, message: err && err.message, ...fetchCauseDetail(err) });
      return null;
    }
  }

  return {
    resolveWarmHandoff,
    discoverBrandEndpoint,
    discoverBrandEndpointDetailed,
    WARM_HANDOFF_DISPOSITION,
    // exposed for observability/tests; never contains secrets or URL key material.
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
  createTtlCache,
  isWarmHandoffEnabled,
  isInchatPreviewEnabled,
  normalizeBrandOrigin,
  WARM_HANDOFF_DISPOSITION,
  FLAG_ENV,
  INCHAT_PREVIEW_FLAG_ENV,
};
