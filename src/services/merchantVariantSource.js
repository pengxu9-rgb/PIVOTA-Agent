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
// A separate, larger ceiling on NODES VISITED: the candidate cap alone cannot bound a deeply nested response
// that contains few product-shaped nodes. Both exhausting is reported as `truncated`.
const MAX_VISITS = 5000;

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
 * The `?variant=<n>` a crawled PDP deep link may carry — the merchant's own name for the exact SKU this row
 * was crawled as. `urlIdentity` deliberately drops the query (utm noise differs between our crawl and their
 * catalogue), so the one query field that carries IDENTITY is read separately, before it is discarded.
 */
function variantHintOf(raw) {
  const s = str(raw);
  if (!s) return null;
  try {
    const v = str(new URL(s).searchParams.get('variant'));
    return /^[A-Za-z0-9_-]+$/.test(v) ? v : null;
  } catch {
    return null;
  }
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
    return { raw: str(product[field]), identity, host, variantHint: variantHintOf(product[field]) };
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

/**
 * Walk an unwrapped UCP tool payload for product-shaped nodes carrying a `url`.
 *
 * Returns `{ nodes, truncated }`: `truncated` is what stops the visit budget from silently deciding the
 * uniqueness question above. A bounded walk that ran out of budget has NOT seen the whole catalogue, so it
 * cannot assert "exactly one entry carries this url" — the caller refuses instead of answering.
 */
function collectCatalogProducts(payload, state) {
  const st = state || { nodes: [], visits: 0, truncated: false };
  if (st.nodes.length >= MAX_CANDIDATES || st.visits >= MAX_VISITS) {
    st.truncated = true;
    return st;
  }
  st.visits += 1;
  if (Array.isArray(payload)) {
    for (const v of payload) collectCatalogProducts(v, st);
    return st;
  }
  if (!isPlainObject(payload)) return st;
  if (str(payload.url) && (Array.isArray(payload.variants) || str(payload.handle))) st.nodes.push(payload);
  for (const v of Object.values(payload)) collectCatalogProducts(v, st);
  return st;
}

/**
 * Does this storefront variant id name the variant the crawled url pinned?
 *
 * Shopify publishes `gid://shopify/ProductVariant/<n>` while a PDP deep link carries the bare `<n>`, so the
 * comparison is on the id's trailing numeric segment — anchored, never a substring match (`…/51348961657135`
 * must not be satisfied by a hint of `1657135`).
 */
function idNamesVariant(variantId, hint) {
  const id = str(variantId);
  const h = str(hint);
  if (!id || !h) return false;
  if (id === h) return true;
  const tail = id.split('/').pop();
  return tail === h;
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

  // ONE storefront lookup per (product, pdp url) — the caller resolves items in a loop and a cart may name
  // the same product twice, so without this a 50-item cart could aim 50 sequential round trips at one
  // merchant host. Bounded and short-lived: entries expire so a checkout never serves a stale catalogue.
  const inflight = new Map();
  function memoKeyFor(product_id, identity) { return `${product_id}\u0000${identity}`; }

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

    const memoKey = memoKeyFor(product_id, pdp.identity);
    if (inflight.has(memoKey)) return inflight.get(memoKey);

    let ids = null;
    const lookup = withTimeout(async () => {
        // `discoverEndpoint` answers `{ mcpEndpoint, businessProfile, wellKnownUrl, status }` — the key is
        // `mcpEndpoint`, as ucpWarmHandoff and ucpStoreAuditProbe both read it. An earlier revision read a
        // `.endpoint` key the client has never emitted, which made this whole source a silent no-op in
        // production while every test passed on a hand-written double that invented that shape. A bare string
        // is still accepted so a caller may pass a known endpoint directly.
        const discovery = await ucpClient.discoverEndpoint(`https://${pdp.host}`);
        const mcpEndpoint = typeof discovery === 'string'
          ? str(discovery)
          : str(discovery && discovery.mcpEndpoint);
        if (!mcpEndpoint) return null;
        const raw = await ucpClient.searchCatalog(mcpEndpoint, { query });
        const payload = typeof unwrap === 'function' ? unwrap(raw) : raw;
        const walk = collectCatalogProducts(payload);
        const matches = walk.nodes.filter((p) => urlIdentity(p.url) === pdp.identity);
        // EXACTLY ONE. Zero means the storefront did not surface the row we crawled; more than one means the
        // catalogue publishes the same url twice and we cannot tell which is the purchasable one. Both are
        // refusals, because the only thing worse than no variant id is a confidently wrong one.
        //
        // AND THE BUDGET MUST NEVER DECIDE UNIQUENESS. The walk is bounded so one checkout cannot traverse an
        // unbounded response, but a truncated walk cannot prove "exactly one" — a second entry carrying our
        // url may sit just past the cut. So an exhausted budget REFUSES whatever it was holding rather than
        // answering from a partial view (a merchant re-publishing a product, a common archived-listing
        // pattern, is precisely how two entries share one url).
        if (walk.truncated) return null;
        if (matches.length !== 1) return null;
        const variantIds = variantIdsOf(matches[0]);
        if (variantIds.length === 0) return null;
        // THE CRAWLED URL MAY ITSELF NAME A VARIANT. Shopify PDP deep links carry `?variant=<n>`, and the row
        // was crawled, priced and displayed as THAT variant — so resolving it to a sibling would open a
        // checkout on a different SKU than the one the shopper was shown, which is the exact "prices a
        // different cart" harm this join exists to prevent. When the crawl names a variant, only that variant
        // may be returned; if the catalogue does not publish it, refuse rather than substitute.
        if (pdp.variantHint) {
          const pinned = variantIds.filter((id) => idNamesVariant(id, pdp.variantHint));
          return pinned.length === 1 ? pinned : null;
        }
        return variantIds;
    }, timeoutMs);
    // Memoize the IN-FLIGHT promise, so concurrent items for one product share a single round trip, and drop
    // it once settled — a cart is short, and holding catalogue answers past it would serve a stale SKU.
    inflight.set(memoKey, lookup.catch(() => null));
    try {
      ids = await lookup;
    } catch (err) {
      // Fail closed: the caller's existing refusal stands. The merchant's error text is never surfaced —
      // it can carry their internal detail — only that the lookup did not answer.
      logger?.warn?.({ product_id, merchant_host: pdp.host, err: err?.message || String(err) },
        'merchant variant source did not answer');
      return null;
    } finally {
      inflight.delete(memoKey);
    }
    if (ids && logger?.info) {
      logger.info({ product_id, merchant_host: pdp.host, variant_count: ids.length },
        'merchant variant source resolved storefront variants');
    }
    return ids;
  };
}

/**
 * Bound the whole lookup: discovery + search share one deadline, so intake cost stays predictable.
 *
 * The timer is deliberately NOT `unref()`d. An unref'd timer does not hold the event loop open, so when the
 * merchant call is the only pending work the loop drains and the deadline NEVER FIRES — the lookup then hangs
 * for as long as the socket does, and the caller's refusal never arrives. (Caught by CI, which runs this file
 * with a quiet loop: node:test reported "Promise resolution is still pending but the event loop has already
 * resolved". It passed locally only because other handles happened to keep the loop alive.) Both exits clear
 * the timer, so a ref'd timer cannot outlive the call it bounds.
 */
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('merchant variant source timed out')), ms);
    Promise.resolve()
      .then(fn)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

module.exports = { createMerchantVariantSource, urlIdentity, variantIdsOf, collectCatalogProducts, variantHintOf, idNamesVariant };
