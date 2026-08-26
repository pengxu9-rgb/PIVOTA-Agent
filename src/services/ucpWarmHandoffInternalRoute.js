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
const {
  toVariantGid, resolveShopifyVariant, extractProductHandle, normalizeBrandOrigin,
} = require('./shopifyVariantResolver');

/*
 * The variant-miss returns below never reach the warm-handoff service, which is what normally records
 * the H1 outcome — so before this, a decline was completely invisible. That matters most for the
 * DEFAULT-ON sold-out guard: without a dial you cannot tell whether it is declining 1% of clicks or
 * 90%, which makes its kill switch un-actionable exactly when you need it.
 *
 * The metric reason is the CANONICAL H1 taxonomy tag, not the route's wire string: `out_of_stock`
 * already exists in that taxonomy (see ucpWarmHandoffMetrics.recordWarmHandoffOutcome), so these
 * declines land in whatever already watches it. The HTTP `reason` stays `variant_out_of_stock` —
 * that is a published response contract, and two names for one condition is a reporting problem,
 * not a reason to break a wire format.
 */
const METRIC_REASON_BY_MISS = {
  variant_out_of_stock: 'out_of_stock',
  variant_unresolved: 'variant_invalid',
};

// Required eagerly, exactly as ucpWarmHandoff.js does. A lazy try/catch loader here would defend
// against nothing: that module already requires this same metrics module at ITS top level, and this
// route requires that module at top level in turn — so a metrics require failure takes the route
// down before any lazy branch could run. An unreachable guard is worse than no guard; it reads as
// protection that does not exist.
const defaultMetrics = require('../observability/ucpWarmHandoffMetrics');

const ROUTE_FLAG_ENV = 'UCP_WARM_HANDOFF_INTERNAL_ROUTE_ENABLED';
const INTERNAL_KEY_ENV = 'UCP_WARM_HANDOFF_INTERNAL_KEY';
const CLICK_BUDGET_ENV = 'UCP_WARM_HANDOFF_CLICK_BUDGET_MS';
// Kill switch for the out-of-stock decline. DEFAULT ON — see requireAvailable() below.
const REQUIRE_AVAILABLE_ENV = 'UCP_WARM_HANDOFF_REQUIRE_AVAILABLE';
const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

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

/**
 * A DEFAULT-ON knob. `isFlagOn` cannot express this: under it an unset var reads as OFF, which for
 * this guard would mean a deploy that simply forgot the var quietly builds dead carts again. So the
 * decline is on unless someone explicitly turns it off, and only an explicit off-value counts —
 * a typo'd value leaves the protection ON rather than silently disarming it.
 */
function requireAvailable(env) {
  const raw = firstNonEmptyString(env && env[REQUIRE_AVAILABLE_ENV]).toLowerCase();
  return !OFF_VALUES.has(raw);
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
/**
 * The `brand_domain` metric label MUST be the bare host, for two reasons.
 *
 * 1. The service lane records `hostOf(normalizeBrandOrigin(...))`. Recording the raw caller string
 *    here would split one brand across series — `cosrx.com` and `https://cosrx.com/` are the same
 *    brand — and silently under-report the very dial this exists to provide.
 * 2. CARDINALITY. `cleanLabel` sanitises the charset but bounds neither cardinality nor length, and
 *    the outcome counter is a Map that is never trimmed. `brand_domain` is caller-supplied, so
 *    every distinct string is a permanent time series. Collapsing to a host shrinks that surface.
 */
function brandLabelFor(brandDomain) {
  const origin = normalizeBrandOrigin(brandDomain);
  if (!origin) return 'unknown';
  try { return new URL(origin).host; } catch { return 'unknown'; }
}

/**
 * Count a variant-resolution miss on the H1 outcome counter. Never throws: a metrics failure must not
 * turn a cold-redirect into a 5xx on a path where a shopper is waiting on the 302.
 *
 * Latency is observed alongside the counter because the service lane pairs them — recording one
 * without the other makes any panel that derives a rate from the histogram disagree with the counter.
 */
function recordVariantMiss({ reason, brandDomain, metrics, latencyMs }) {
  // The typeof checks stay: `deps.metrics` is an injection seam and a partial sink is a legitimate
  // thing to inject. A null check on `sink` would NOT stay — `defaultMetrics` is a required module,
  // so it can never be falsy, and an unreachable guard reads as protection that does not exist.
  const sink = metrics || defaultMetrics;
  try {
    if (typeof sink.recordWarmHandoffOutcome === 'function') {
      sink.recordWarmHandoffOutcome({
        outcome: 'fallback',
        reason: METRIC_REASON_BY_MISS[reason] || 'variant_invalid',
        brandDomain: brandLabelFor(brandDomain),
      });
    }
    if (typeof sink.observeWarmHandoffLatency === 'function') {
      sink.observeWarmHandoffLatency({ outcome: 'fallback', latencyMs });
    }
  } catch { /* metrics must never throw the lane */ }
}

/**
 * The money half of a priced preview, or null.
 *
 * Deliberately a projection rather than a passthrough: the preview also carries `continue_url`,
 * `messages` and shipping options, and this route's caller (the backend's serving path) wants a
 * total to quote, not a second copy of the handoff URL it already has. Narrowing here keeps the
 * internal contract small enough to reason about.
 */
function pricedTotals(preview) {
  if (!isPlainObject(preview)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const total = num(preview.total);
  // ISO 4217 SHAPE, not merely non-empty. `firstNonEmptyString` STRINGIFIES, so a numeric 42
  // arrived as the currency code "42" and a total was published under it — nonsense presented as
  // a real unit. Three letters is the same rule the backend's shop-currency reader applies.
  const rawCurrency = typeof preview.currency === 'string' ? preview.currency.trim().toUpperCase() : '';
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
  // AMOUNT AND CURRENCY MOVE TOGETHER. Either both, or neither.
  if (total === null || !currency) return null;
  return {
    total,
    currency,
    subtotal: num(preview.subtotal),
    tax: num(preview.tax),
    // True when the merchant still needs an address or payment entered on the STOREFRONT, i.e.
    // this total is the best we can compute without the buyer. A caller must not present it as
    // final when this is set.
    requires_escalation: preview.requires_escalation === true,
  };
}

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

  /**
   * @returns {Promise<{ gid: string|null, reason: string|null }>} `reason` is set only on a miss, and
   *   distinguishes "we could not name a variant" from "we named one and it is sold out".
   */
  async function resolveVariantGid({ body, brandDomain, env }) {
    // The caller-supplied hint (pivota-backend Constraint 6) is authoritative and BYPASSES the picker
    // entirely — including the stock guard. The backend chose that variant against the seed prices it
    // published; second-guessing its stock here would silently drop the hinted lane, which is the
    // population the hint exists to serve.
    const direct = toVariantGid(body.variant_gid) || toVariantGid(body.variant_id);
    if (direct) return { gid: direct, reason: null };

    const handle = firstNonEmptyString(body.product_handle) || extractProductHandle(body.product_url);
    // The memo key must cover EVERY input that can change the verdict. `seed_data` is caller-supplied
    // and resolves BEFORE the network, so without it in the key one request's stale sold-out seed
    // blob would suppress a live cart for every other request on the same handle until the TTL
    // expired. The kill-switch state is in the key for the same reason: flipping it must take effect
    // immediately, not after a cached verdict from the previous setting ages out.
    const seedFingerprint = isPlainObject(body.seed_data)
      ? crypto.createHash('sha1').update(JSON.stringify(body.seed_data)).digest('hex').slice(0, 12)
      : '-';
    const cacheKey = [
      brandDomain,
      handle || firstNonEmptyString(body.product_title),
      seedFingerprint,
      requireAvailable(env) ? 'ra1' : 'ra0',
    ].join('::');
    if (handle || firstNonEmptyString(body.product_title)) {
      const cached = variantCache.get(cacheKey);
      if (cached !== undefined) return cached; // may be a negative-cached miss
    } else {
      // Nothing to resolve FROM — a malformed request, not a lane outcome. Deliberately NOT counted:
      // this return needs no network, so counting it would let a caller mint an unbounded number of
      // permanent `brand_domain` series at zero cost. Every other miss costs a real fetch first.
      return { gid: null, reason: 'no_variant_input' };
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

    // Decline a KNOWN sold-out variant: a cold redirect lands the shopper on a PDP that says "sold
    // out" honestly, which beats a cart that dies at checkout. Only `out_of_stock` declines — an
    // UNKNOWN stock state (a storefront that does not publish `available`) must still resolve, or
    // this guard would drop every such brand. See shopifyVariantResolver.pickVariantFromProductNode.
    const soldOut = Boolean(resolved && resolved.availability === 'out_of_stock' && requireAvailable(env));
    const gid = !soldOut && resolved && resolved.variantGid ? resolved.variantGid : null;
    const reason = gid ? null : (soldOut ? 'variant_out_of_stock' : 'variant_unresolved');
    const entry = { gid, reason };
    // A sold-out verdict rides the SHORT negative TTL, never the 10-minute positive memo — stock is
    // the one input here that changes under us, and re-stocking must not wait out a long cache.
    variantCache.set(cacheKey, entry, gid ? VARIANT_CACHE_TTL_MS : VARIANT_NEGATIVE_TTL_MS);
    return entry;
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

    const variantStartedAt = now();
    const { gid: variantGid, reason: variantMissReason } = await resolveVariantGid({ body, brandDomain, env });
    if (!variantGid) {
      const reason = variantMissReason || 'variant_unresolved';
      if (reason !== 'no_variant_input') {
        recordVariantMiss({ reason, brandDomain, metrics: deps.metrics, latencyMs: now() - variantStartedAt });
      }
      // The wire reason stays in the shipped vocabulary; `no_variant_input` is reported as the
      // generic unresolved so the response contract is unchanged.
      return { status: 200, body: { continue_url: null, reason: reason === 'no_variant_input' ? 'variant_unresolved' : reason } };
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
        // THE LANDED TOTAL, when the priced-preview flag produced one.
        //
        // The service already builds this (create_checkout against the merchant, synthetic
        // address, no PII, never completed and never paid) and the route was dropping it on the
        // floor. It is what lets a caller quote a total that INCLUDES shipping and tax — the
        // storefront `.js` endpoint the backend otherwise reads carries a bare unit price with no
        // currency code at all, so it cannot answer "what will the buyer actually be charged".
        //
        // Shape-gated, not spread: only the money fields are surfaced, and only when the total
        // arrives WITH its currency. An amount whose unit we cannot name is not a smaller truth
        // than no amount, it is a different and wrong one — quoting 4500 as dollars when the
        // merchant meant yen is worse than saying nothing.
        ...(pricedTotals(handoff.preview) ? { preview: pricedTotals(handoff.preview) } : {}),
      },
    };
  };
}

module.exports = {
  REQUIRE_AVAILABLE_ENV,
  pricedTotals,
  createUcpWarmHandoffInternalHandler,
  ROUTE_FLAG_ENV,
  INTERNAL_KEY_ENV,
  CLICK_BUDGET_ENV,
  DEFAULT_CLICK_BUDGET_MS,
};
