'use strict';

// MERCHANT-SOURCED VARIANT IDENTITY — ask the storefront for the id our crawl cannot carry.
//
// THE PROBLEM. Pivota's seed cohort publishes no real variant identity: `src/pdpBuilder.js buildVariants`
// manufactures `variant_id: product.product_id` (or `${product_id}-${n}`) for a crawled row, and
// `buyerIntake`'s resolver correctly refuses those — a forged variant id does not fail loudly, it PRICES A
// DIFFERENT CART. So every seed row hits `no_real_variant_identity` at intake and cannot open a checkout.
//
// THE OBSERVATION (probed live 2026-08-27, murad.com — a plain referral seed with zero Pivota onboarding).
// The merchant's OWN storefront publishes exactly what we lack:
//   * `GET https://<host>/.well-known/ucp` -> service `dev.ucp.shopping`, transport mcp, an endpoint URL;
//   * `tools/call search_catalog` on that endpoint returns products carrying `url`, `handle`, and
//     `variants[] { id: "gid://shopify/ProductVariant/…", sku, title, price, availability }`.
// Every tool requires `meta["ucp-agent"].profile`; anonymous calls are refused `invalid_profile_url`.
// Pivota already publishes such a profile and the buyer-agent client already sends it.
//
// THE JOIN IS THE WHOLE SAFETY ARGUMENT. We do NOT match on title — a fuzzy match would silently buy the
// wrong product, which is the same class of defect as a forged id. We match on the MERCHANT PDP URL the seed
// row was crawled from, compared origin+path only (query/fragment/case/trailing-slash normalised away).
// `search_catalog` is only a way to enumerate candidates; the URL is what selects one. Anything other than
// EXACTLY ONE URL-matching product returns null, and null means the caller refuses.
//
// WHAT THIS DOES NOT DO. It returns identity, not a price and not a purchase. The seed cohort still cannot be
// priced by pivota-backend's quote engine (Shopify-only, needs the SELLER's own store — see the SCOPE note in
// buyerIntake's resolver). The payoff of a real GID is the merchant's OWN UCP cart/checkout, which is where
// an agentic card would pay. Multi-variant products still refuse as `ambiguous` upstream — correctly: this
// module's job is to make that refusal about REAL options instead of about missing identity.

const DEFAULT_TIMEOUT_MS = 6000;
// A storefront search can page; we only ever want the entry whose URL is ours, so a small window is enough
// and bounds what one intake costs. If the row is not in the first page by title, we refuse rather than page
// the merchant's catalogue on a checkout path.
const MAX_CANDIDATES = 25;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** The product node inside whatever envelope the canonical read used (mirrors buyerIntake.productOfRead). */
function productOfRead(result) {
  const r = isPlainObject(result) ? result : {};
  if (isPlainObject(r.product)) return r.product;
  if (isPlainObject(r.data) && isPlainObject(r.data.product)) return r.data.product;
  return r;
}

/**
 * Compare two storefront URLs as IDENTITY: scheme-insensitive, host lowercased and `www.`-insensitive, path
 * without a trailing slash, and query/fragment ignored (our crawled url carries utm_* the merchant's does
 * not). Returns null for anything unparseable so a bad url can never match a bad url.
 */
function urlIdentity(raw) {
  const s = str(raw);
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (!host) return null;
  return `${host}${path}`;
}

/**
 * The MERCHANT's pdp url on our product read — never Pivota's own canonical url.
 *
 * `canonical_url`/`url` on a seed row point at agent.pivota.cc (verified live), so reading them would make us
 * "join" our own page against a merchant catalogue and match nothing — or worse, match a merchant who happens
 * to proxy us. Only the fields that are defined to carry the origin PDP are consulted, and a host that is one
 * of ours is refused outright.
 */
function merchantPdpUrlOf(product, selfHosts) {
  for (const field of ['destination_url', 'external_redirect_url', 'source_url']) {
    const identity = urlIdentity(product[field]);
    if (!identity) continue;
    const host = identity.split('/')[0];
    if (selfHosts.has(host)) continue;
    return { raw: str(product[field]), identity, host };
  }
  return null;
}

/** Variant ids published by a merchant catalogue product, de-duplicated, in order. */
function variantIdsOf(catalogProduct) {
  const out = [];
  for (const v of Array.isArray(catalogProduct.variants) ? catalogProduct.variants : []) {
    if (!isPlainObject(v)) continue;
    const id = str(v.id) || str(v.variant_id);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Walk an unwrapped UCP tool payload for product-shaped nodes carrying a `url`. */
function collectCatalogProducts(payload, out = []) {
  if (out.length >= MAX_CANDIDATES) return out;
  if (Array.isArray(payload)) {
    for (const v of payload) collectCatalogProducts(v, out);
    return out;
  }
  if (!isPlainObject(payload)) return out;
  if (str(payload.url) && (Array.isArray(payload.variants) || str(payload.handle))) out.push(payload);
  for (const v of Object.values(payload)) collectCatalogProducts(v, out);
  return out;
}

/**
 * Build the merchant-variant source for `createDefaultVariantResolver`'s optional fallback.
 *
 * @param {{ ucpClient: object, isEnabled?: () => boolean, selfHosts?: string[], logger?: object,
 *           timeoutMs?: number, unwrap?: (toolResult:any)=>any }} deps
 * @returns {(productRead:object, product_id:string, ctx:object)=>Promise<string[]|null>}
 */
function createMerchantVariantSource(deps = {}) {
  const { ucpClient, isEnabled, logger, unwrap } = deps;
  if (!ucpClient || typeof ucpClient.discoverEndpoint !== 'function' || typeof ucpClient.searchCatalog !== 'function') {
    throw new Error('createMerchantVariantSource requires a ucp client with discoverEndpoint() and searchCatalog()');
  }
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const selfHosts = new Set(
    (Array.isArray(deps.selfHosts) ? deps.selfHosts : [])
      .map((h) => str(h).toLowerCase().replace(/^www\./, ''))
      .filter(Boolean),
  );

  return async function sourceMerchantVariants(productRead, product_id) {
    if (typeof isEnabled === 'function' && !isEnabled()) return null;
    const product = productOfRead(productRead);
    const pdp = merchantPdpUrlOf(product, selfHosts);
    if (!pdp) return null;

    // The search term is the merchant's OWN handle when their url gives us one (the most selective text we
    // hold), else the crawled title. Neither SELECTS the product — the url match below does — so a poor term
    // costs a miss, never a wrong answer.
    const handle = pdp.identity.split('/').pop();
    const query = handle && handle !== '/' ? handle.replace(/[-_]+/g, ' ') : str(product.title);
    if (!query) return null;

    let ids = null;
    try {
      ids = await withTimeout(async () => {
        const endpoint = await ucpClient.discoverEndpoint(`https://${pdp.host}`);
        const mcpEndpoint = typeof endpoint === 'string' ? endpoint : str(endpoint && endpoint.endpoint);
        if (!mcpEndpoint) return null;
        const raw = await ucpClient.searchCatalog(mcpEndpoint, { query });
        const payload = typeof unwrap === 'function' ? unwrap(raw) : raw;
        const matches = collectCatalogProducts(payload).filter((p) => urlIdentity(p.url) === pdp.identity);
        // EXACTLY ONE. Zero means the storefront did not surface the row we crawled; more than one means the
        // catalogue publishes the same url twice and we cannot tell which is the purchasable one. Both are
        // refusals, because the only thing worse than no variant id is a confidently wrong one.
        if (matches.length !== 1) return null;
        const variantIds = variantIdsOf(matches[0]);
        return variantIds.length > 0 ? variantIds : null;
      }, timeoutMs);
    } catch (err) {
      // Fail closed: the caller's existing refusal stands. The merchant's error text is never surfaced —
      // it can carry their internal detail — only that the lookup did not answer.
      logger?.warn?.({ product_id, merchant_host: pdp.host, err: err?.message || String(err) },
        'merchant variant source did not answer');
      return null;
    }
    if (ids && logger?.info) {
      logger.info({ product_id, merchant_host: pdp.host, variant_count: ids.length },
        'merchant variant source resolved storefront variants');
    }
    return ids;
  };
}

/** Bound the whole lookup: discovery + search share one deadline, so intake cost stays predictable. */
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('merchant variant source timed out')), ms);
    if (t.unref) t.unref();
    Promise.resolve()
      .then(fn)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

module.exports = { createMerchantVariantSource, urlIdentity, variantIdsOf, collectCatalogProducts };
