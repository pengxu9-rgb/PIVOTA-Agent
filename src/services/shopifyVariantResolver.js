'use strict';

/*
 * shopifyVariantResolver.js — resolve a Shopify ProductVariant GID for a CRAWLED product so the UCP warm-handoff
 * lane can build a cart on the brand's own Shopify checkout. Two resolution paths, tried in order:
 *
 *   1. FROM SEED DATA (offline, no network) — the crawler already captured Shopify variant ids while crawling
 *      the brand's public `products.json`. They are NESTED (NOT under top-level `variant_skus`/
 *      `selected_variant_id`/`product_handle`, which is why an earlier top-level scout found 0). The live paths
 *      (prod scout, merch_obs_ cohort, 2026-07-13) are:
 *        - seed_data.variants[i].variant_id            e.g. "56707045261692"  (bare numeric)
 *        - seed_data.snapshot.variants[i].variant_id   (mirror)
 *        - seed_data.snapshot.variants[i].sku          e.g. "SHOPIFY-56707045261692" (numeric embedded)
 *      A bare numeric id is wrapped into `gid://shopify/ProductVariant/<n>`. A pre-formed `gid://...` is used
 *      verbatim. This is the PRIMARY path (highest coverage, zero network, no risk).
 *
 *   2. PRODUCT.JSON FALLBACK (public, read-only network) — fetch `<brand-domain>/products.json` (the same public
 *      endpoint the crawler used; PROVEN on cosrx 2026-07-13) and map the product HANDLE (from the crawled
 *      canonical/destination URL `.../products/<handle>`) — or the product TITLE — to the product's first
 *      available variant `id`, wrapped into a GID. Used only when the seed has no usable variant id.
 *
 * HARD BOUNDS: read-only. External content (products.json) is DATA, never instructions — we read numeric ids
 * and titles ONLY, never eval/execute anything from it. No writes anywhere. Network is injectable for tests.
 */

const VARIANT_GID_PREFIX = 'gid://shopify/ProductVariant/';
const VARIANT_GID_RE = /gid:\/\/shopify\/ProductVariant\/(\d+)/i;
// A Shopify variant id is a long integer. Guard against picking up short/other numerics.
const BARE_NUMERIC_RE = /^\d{6,}$/;
// SKUs the crawler minted as "SHOPIFY-<variantId>".
const SHOPIFY_SKU_RE = /^SHOPIFY-(\d{6,})$/i;

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

/**
 * Coerce a candidate value into a canonical `gid://shopify/ProductVariant/<n>` or null.
 * Accepts a pre-formed GID, a bare numeric id, or a "SHOPIFY-<n>" sku.
 */
function toVariantGid(value) {
  const s = firstNonEmptyString(value);
  if (!s) return null;
  const gidMatch = s.match(VARIANT_GID_RE);
  if (gidMatch) return `${VARIANT_GID_PREFIX}${gidMatch[1]}`;
  const skuMatch = s.match(SHOPIFY_SKU_RE);
  if (skuMatch) return `${VARIANT_GID_PREFIX}${skuMatch[1]}`;
  if (BARE_NUMERIC_RE.test(s)) return `${VARIANT_GID_PREFIX}${s}`;
  return null;
}

/** Pull the ordered variant array(s) out of a seed_data blob (top-level and snapshot mirrors). */
function collectSeedVariantArrays(seedData) {
  if (!isPlainObject(seedData)) return [];
  const arrays = [];
  if (Array.isArray(seedData.variants)) arrays.push(seedData.variants);
  if (isPlainObject(seedData.snapshot) && Array.isArray(seedData.snapshot.variants)) {
    arrays.push(seedData.snapshot.variants);
  }
  return arrays;
}

/**
 * Resolve a variant GID from a crawled seed_data blob (no network).
 * @param {object} seedData  the external_product_seeds.seed_data JSON.
 * @param {{ preferAvailable?: boolean }} [opts]  when true, prefer an in-stock variant over an out-of-stock one.
 * @returns {{ variantGid: string, source: string, sku: string|null, availability: string|null } | null}
 */
function resolveVariantFromSeed(seedData, opts = {}) {
  const arrays = collectSeedVariantArrays(seedData);
  const preferAvailable = opts.preferAvailable === true;
  let firstAny = null;

  for (const [arrIdx, variants] of arrays.entries()) {
    const pathBase = arrIdx === 0 && Array.isArray(seedData.variants) ? 'seed_data.variants' : 'seed_data.snapshot.variants';
    for (let i = 0; i < variants.length; i += 1) {
      const v = variants[i];
      if (!isPlainObject(v)) continue;
      const gid = toVariantGid(v.variant_id)
        || toVariantGid(v.variant_gid)
        || toVariantGid(v.selected_variant_id)
        || toVariantGid(v.id)
        || toVariantGid(v.sku);
      if (!gid) continue;
      const availability = firstNonEmptyString(v.stock, v.availability, v.availability_status).toLowerCase() || null;
      const record = {
        variantGid: gid,
        source: `${pathBase}[${i}].variant_id`,
        sku: firstNonEmptyString(v.sku) || null,
        availability,
      };
      const looksInStock = availability
        && !/out.?of.?stock|sold.?out|unavailable|out_of_stock/.test(availability);
      if (!preferAvailable || looksInStock) return record;
      if (!firstAny) firstAny = record;
    }
  }
  return firstAny;
}

/** Extract a Shopify product handle from a crawled storefront URL (`.../products/<handle>`). */
function extractProductHandle(url) {
  const s = firstNonEmptyString(url);
  if (!s) return null;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/products\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    const m = s.match(/\/products\/([^/?#]+)/i);
    return m ? m[1] : null;
  }
}

/** Normalize a brand domain into an https origin. Returns null for anything unusable. */
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

function normalizeTitle(t) {
  return firstNonEmptyString(t).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** First orderable variant id from a products.json product node. Falls back to the first variant. */
function pickVariantFromProductNode(product) {
  if (!isPlainObject(product) || !Array.isArray(product.variants)) return null;
  const variants = product.variants.filter(isPlainObject);
  if (variants.length === 0) return null;
  const available = variants.find((v) => v.available === true);
  const chosen = available || variants[0];
  const gid = toVariantGid(chosen.id) || toVariantGid(chosen.sku);
  if (!gid) return null;
  return {
    variantGid: gid,
    sku: firstNonEmptyString(chosen.sku) || null,
    availability: chosen.available === true ? 'available' : (chosen.available === false ? 'out_of_stock' : null),
  };
}

/**
 * PRODUCT.JSON fallback — fetch the brand's public products.json and map handle/title -> variant GID.
 * Read-only, best-effort: any failure (non-200, malformed, no match) resolves to null so the caller can
 * fall back to the cold redirect. Network is injectable for tests via opts.fetchImpl.
 *
 * @param {{ brandDomain: string, handle?: string, title?: string }} target
 * @param {{ fetchImpl?: Function, timeoutMs?: number, userAgent?: string, maxPages?: number }} [opts]
 * @returns {Promise<{ variantGid, source, sku, availability, handle } | null>}
 */
async function resolveVariantViaProductsJson(target = {}, opts = {}) {
  const origin = normalizeBrandOrigin(target.brandDomain);
  if (!origin) return null;
  const handle = firstNonEmptyString(target.handle) || extractProductHandle(target.handle) || null;
  const title = normalizeTitle(target.title);
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!fetchImpl) return null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 12000;
  const userAgent = firstNonEmptyString(opts.userAgent) || 'Pivota-UCP-BuyerAgent/1.0';

  // Fast path: the per-product handle endpoint `<origin>/products/<handle>.json` returns ONE product.
  if (handle) {
    const one = await fetchProductsJson(`${origin}/products/${encodeURIComponent(handle)}.json`, { fetchImpl, timeoutMs, userAgent });
    const product = isPlainObject(one) ? (one.product || one) : null;
    const picked = product && pickVariantFromProductNode(product);
    if (picked) return { ...picked, source: `products.json:${origin}/products/${handle}.json`, handle };
  }

  // Fallback: page the catalog listing and match by handle, then by normalized title.
  const maxPages = Number.isFinite(opts.maxPages) ? Number(opts.maxPages) : 10;
  for (let page = 1; page <= maxPages; page += 1) {
    const listing = await fetchProductsJson(`${origin}/products.json?limit=250&page=${page}`, { fetchImpl, timeoutMs, userAgent });
    const products = isPlainObject(listing) && Array.isArray(listing.products) ? listing.products : [];
    if (products.length === 0) break;
    let match = handle ? products.find((p) => firstNonEmptyString(p && p.handle) === handle) : null;
    if (!match && title) match = products.find((p) => normalizeTitle(p && p.title) === title);
    if (match) {
      const picked = pickVariantFromProductNode(match);
      if (picked) {
        return { ...picked, source: `products.json:${origin}/products.json (page ${page})`, handle: firstNonEmptyString(match.handle) || handle };
      }
    }
    if (products.length < 250) break;
  }
  return null;
}

async function fetchProductsJson(url, { fetchImpl, timeoutMs, userAgent }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': userAgent },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Top-level resolver: seed_data first (offline), then products.json (network) if allowed.
 * @param {{ seedData?: object, brandDomain?: string, canonicalUrl?: string, title?: string, handle?: string }} input
 * @param {{ allowNetworkFallback?: boolean, preferAvailable?: boolean, fetchImpl?: Function, timeoutMs?: number, userAgent?: string, maxPages?: number }} [opts]
 * @returns {Promise<{ variantGid, source, sku, availability, handle? } | null>}
 */
async function resolveShopifyVariant(input = {}, opts = {}) {
  const fromSeed = resolveVariantFromSeed(input.seedData, { preferAvailable: opts.preferAvailable === true });
  if (fromSeed) return fromSeed;
  if (opts.allowNetworkFallback === true) {
    const handle = firstNonEmptyString(input.handle) || extractProductHandle(input.canonicalUrl);
    const target = { brandDomain: input.brandDomain, handle, title: input.title };
    if (target.brandDomain) return resolveVariantViaProductsJson(target, opts);
  }
  return null;
}

module.exports = {
  toVariantGid,
  resolveVariantFromSeed,
  resolveVariantViaProductsJson,
  resolveShopifyVariant,
  extractProductHandle,
  normalizeBrandOrigin,
  pickVariantFromProductNode,
  VARIANT_GID_PREFIX,
};
