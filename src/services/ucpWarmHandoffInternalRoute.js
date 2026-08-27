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
 * What the merchant asserted about price, in a form that cannot be misread.
 *
 * NOT A LANDED TOTAL, and the audit's B7 assumption that it would be is wrong. The live
 * create_checkout schema has no `shipping_address` field — Shopify collects the delivery address
 * on the STOREFRONT, so shipping and tax quotes are not returned at this step at all
 * (ucpBuyerAgentClient.js:1017, 1253; live-verified against cosrx 2026-07-13). On the real path
 * `total === subtotal`, `shipping_options` is `[]`, `tax` is `null`, and the checkout comes back
 * `requires_escalation`. Publishing that as a grand total would be quoting a number the buyer
 * will not be charged.
 *
 * So this emits a PRE-SHIPPING SUBTOTAL, named as one, with the two exclusions stated explicitly
 * rather than left for a caller to infer.
 *
 * MINOR UNITS, ALWAYS, AND SAID SO IN THE KEY. The live payload's `totals[].amount` is minor
 * units (integer cents) and `pickMoney` passes it through with no coercion, as a number OR a
 * string. `1600 USD` is $16.00 — a bare `total: 1600` beside a currency code is the same
 * amount-without-its-unit hazard as a missing currency, one level down, and a 100x error in the
 * direction that overstates. The key says `_minor` so the scale travels with the number.
 */
function pricedTotals(preview) {
  if (!isPlainObject(preview)) return null;

  // Money arrives as a NUMBER OR A STRING — `pickMoney` is documented "no math, no coercion", and
  // the live cosrx payload carries strings. Requiring a number made this inert on the only
  // merchant shape anyone has actually verified.
  const minor = (v) => {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    // Integer minor units only. A decimal point here means the merchant is NOT using the
    // convention we are about to publish under, and guessing which it is would be the whole bug.
    if (!/^\d{1,15}$/.test(t)) return null;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null;
  };

  const subtotal = minor(preview.subtotal != null ? preview.subtotal : preview.total);
  const rawCurrency = typeof preview.currency === 'string' ? preview.currency.trim().toUpperCase() : '';
  // ISO 4217 SHAPE, not merely non-empty. `firstNonEmptyString` STRINGIFIES, so a numeric 42
  // arrived as the currency code "42". `XXX` is excluded: it is the ISO code meaning "no
  // currency", which is an assertion that there is no unit, not a unit.
  const currency = /^[A-Z]{3}$/.test(rawCurrency) && rawCurrency !== 'XXX' ? rawCurrency : null;

  // AMOUNT AND CURRENCY MOVE TOGETHER. Either both, or neither.
  if (subtotal === null || !currency) return null;

  return {
    subtotal_minor: subtotal,
    currency,
    tax_minor: minor(preview.tax),
    // Stated, not implied. On the live path both are false every time, and a caller that assumes
    // otherwise quotes a number the buyer will not be charged.
    includes_shipping: Array.isArray(preview.shipping_options) && preview.shipping_options.length > 0,
    includes_tax: minor(preview.tax) !== null,
    // True when the merchant still needs an address or payment on the STOREFRONT — which, per the
    // live schema, is ALWAYS on this path. Kept so a caller can tell a genuinely-final quote from
    // this one if a merchant ever returns one.
    requires_escalation: preview.requires_escalation === true,
    // The merchant's handle on this checkout, when it gave one. Null is honest and common: a
    // merchant may price a preview without naming an id. A caller must treat null as "no
    // mintable checkout here", never as a reason to fabricate one.
    checkout_id: typeof preview.checkout_id === 'string' && preview.checkout_id.trim()
      ? preview.checkout_id.trim()
      : null,
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
        // WHAT THE MERCHANT ASSERTED ABOUT PRICE — a PRE-SHIPPING SUBTOTAL in minor units,
        // not a landed total. See pricedTotals: the live schema returns no shipping or tax at
        // this step because Shopify collects the address on the storefront.
        //
        // The service already builds this (create_checkout against the merchant, synthetic
        // address, no PII, never completed and never paid) and the route was dropping it. Its
        // value over the storefront `.js` endpoint the backend otherwise reads is that it NAMES
        // ITS CURRENCY — `.js` carries a bare unit price with no currency code at all.
        //
        // Shape-gated, not spread: only the money fields cross, and only when the amount arrives
        // WITH its currency and in a scale we can name.
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
