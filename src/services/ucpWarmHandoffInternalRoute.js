'use strict';

/*
 * ucpWarmHandoffInternalRoute.js — INTERNAL resolve endpoint for the warm-handoff CLICK lane.
 * (Phase 1 of Pivota_Warm_Handoff_Click_Lane_Spec_2026-07-22.md.)
 *
 * pivota-backend's public `GET /r` redirect calls this endpoint at CLICK time to upgrade a cold
 * brand redirect into a pre-built cart on the brand's own Shopify checkout:
 *
 *   POST /internal/ucp/warm-handoff/resolve   (X-Internal-Key auth; NEVER public)
 *   { brand_domain, variant_gid? | variant_id?, product_handle? | product_url?, product_title?,
 *     quantity?, attribution? }
 *   -> 200 { continue_url, cart_id, variant_gid }        on success
 *   -> 200 { continue_url: null, reason }                on any resolution miss (caller cold-redirects)
 *   -> 401/400/404                                       auth / validation / dark
 *
 * It is a thin wrapper over the EXISTING hardened lane (ucpWarmHandoff.js: H1 caches, budget,
 * metrics) plus shopifyVariantResolver for clicks whose token carries no Shopify variant id.
 * The click path gets a TIGHTER total budget than the serving path (default 2000ms vs 9000ms) —
 * a shopper is waiting on the 302.
 *
 * HARD BOUNDS (inherited, unchanged): cart-build + continue_url ONLY. Never complete_checkout,
 * never payment, never opens the continue_url. Failure of ANY kind resolves to continue_url:null
 * so the caller falls back to today's cold redirect — never a dead end, never a thrown error.
 *
 * Fail-closed mounting: the route 404s unless BOTH flags are on AND the internal key is
 * configured. An unconfigured key can never mean "open".
 */

const crypto = require('crypto');

const { createWarmHandoffService, createTtlCache, isWarmHandoffEnabled } = require('./ucpWarmHandoff');
const { toVariantGid, resolveShopifyVariant, extractProductHandle } = require('./shopifyVariantResolver');

const ROUTE_FLAG_ENV = 'UCP_WARM_HANDOFF_INTERNAL_ROUTE_ENABLED';
const INTERNAL_KEY_ENV = 'UCP_WARM_HANDOFF_INTERNAL_KEY';
const CLICK_BUDGET_ENV = 'UCP_WARM_HANDOFF_CLICK_BUDGET_MS';

const DEFAULT_CLICK_BUDGET_MS = 2000; // shopper is waiting on the 302 — much tighter than the 9s serving budget
const DEFAULT_VARIANT_FETCH_TIMEOUT_MS = 1200; // products.json fallback fetch
const VARIANT_CACHE_TTL_MS = 10 * 60 * 1000; // positive handle->gid memo
const VARIANT_NEGATIVE_TTL_MS = 60 * 1000; // unresolvable handles re-check sooner, don't hammer
const VARIANT_CACHE_MAX_ENTRIES = 500;

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

/** Constant-time key comparison (length leak is fine; content leak is not). */
function timingSafeKeyMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function clickBudgetMs(env) {
  const raw = Number(env[CLICK_BUDGET_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLICK_BUDGET_MS;
}

/**
 * Handler factory (dep-injectable for tests). Returns `async handler({ headers, body }) -> { status, body }`.
 * @param {object} [deps]
 * @param {object} [deps.env]        env override (default process.env, read PER REQUEST so flag flips apply live)
 * @param {object} [deps.service]    warm-handoff service override ({ resolveWarmHandoff })
 * @param {Function} [deps.fetchImpl] fetch override for the products.json variant fallback
 * @param {object} [deps.logger]
 * @param {Function} [deps.now]
 */
function createUcpWarmHandoffInternalHandler(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const variantCache = createTtlCache({ maxEntries: VARIANT_CACHE_MAX_ENTRIES, now });
  // Lazily constructed on the first ELIGIBLE request so a flag-off deploy never builds the client.
  let serviceSingleton = null;

  function resolveService(env) {
    if (deps.service && typeof deps.service.resolveWarmHandoff === 'function') return deps.service;
    if (!serviceSingleton) {
      const budget = clickBudgetMs(env);
      serviceSingleton = createWarmHandoffService({
        totalBudgetMs: budget,
        // Per-call ceiling can never exceed the whole click budget.
        clientOptions: { timeoutMs: Math.min(1500, budget) },
        logger: deps.logger || null,
      });
    }
    return serviceSingleton;
  }

  async function resolveVariantGid({ body, brandDomain, env }) {
    const direct = toVariantGid(body.variant_gid) || toVariantGid(body.variant_id);
    if (direct) return direct;

    const handle = firstNonEmptyString(body.product_handle) || extractProductHandle(body.product_url);
    const cacheKey = `${brandDomain}::${handle || firstNonEmptyString(body.product_title)}`;
    if (handle || firstNonEmptyString(body.product_title)) {
      const cached = variantCache.get(cacheKey);
      if (cached !== undefined) return cached; // may be null (negative-cached miss)
    } else {
      return null; // nothing to resolve from
    }

    let resolved = null;
    try {
      resolved = await resolveShopifyVariant(
        {
          seedData: isPlainObject(body.seed_data) ? body.seed_data : undefined,
          brandDomain,
          handle,
          canonicalUrl: firstNonEmptyString(body.product_url) || undefined,
          title: firstNonEmptyString(body.product_title) || undefined,
        },
        {
          preferAvailable: true,
          allowNetworkFallback: true,
          timeoutMs: DEFAULT_VARIANT_FETCH_TIMEOUT_MS,
          ...(typeof deps.fetchImpl === 'function' ? { fetchImpl: deps.fetchImpl } : {}),
        },
      );
    } catch {
      resolved = null; // resolution must never throw the lane
    }
    const gid = resolved && resolved.variantGid ? resolved.variantGid : null;
    variantCache.set(cacheKey, gid, gid ? VARIANT_CACHE_TTL_MS : VARIANT_NEGATIVE_TTL_MS);
    return gid;
  }

  return async function handleWarmHandoffResolve({ headers = {}, body = {} } = {}) {
    const env = deps.env || process.env;

    // Fail-closed dark: both flags on AND a configured key, else the route does not exist.
    const configuredKey = firstNonEmptyString(env[INTERNAL_KEY_ENV]);
    if (!isFlagOn(env[ROUTE_FLAG_ENV]) || !isWarmHandoffEnabled(env) || !configuredKey) {
      return { status: 404, body: { error: 'not_found' } };
    }

    const provided = firstNonEmptyString(headers['x-internal-key'] || headers['X-Internal-Key']);
    if (!timingSafeKeyMatch(provided, configuredKey)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }

    if (!isPlainObject(body)) {
      return { status: 400, body: { error: 'invalid_body' } };
    }
    const brandDomain = firstNonEmptyString(body.brand_domain);
    if (!brandDomain) {
      return { status: 400, body: { error: 'brand_domain_required' } };
    }

    const variantGid = await resolveVariantGid({ body, brandDomain, env });
    if (!variantGid) {
      return { status: 200, body: { continue_url: null, reason: 'variant_unresolved' } };
    }

    const quantity = Number.isInteger(body.quantity) && body.quantity > 0 ? body.quantity : 1;
    let handoff = null;
    try {
      handoff = await resolveService(env).resolveWarmHandoff({
        brandDomain,
        variantGid,
        quantity,
        ...(isPlainObject(body.attribution) ? { attribution: body.attribution } : {}),
      });
    } catch {
      handoff = null; // the service is contract-bound to return null, but belt and braces
    }

    if (!handoff || !firstNonEmptyString(handoff.continue_url)) {
      return { status: 200, body: { continue_url: null, reason: 'fallback' } };
    }
    return {
      status: 200,
      body: {
        continue_url: handoff.continue_url,
        cart_id: firstNonEmptyString(handoff.cart_id) || null,
        variant_gid: variantGid,
      },
    };
  };
}

module.exports = {
  createUcpWarmHandoffInternalHandler,
  ROUTE_FLAG_ENV,
  INTERNAL_KEY_ENV,
  CLICK_BUDGET_ENV,
  DEFAULT_CLICK_BUDGET_MS,
};
