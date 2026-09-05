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
 *   2. PRODUCT.JSON FALLBACK (public, read-only network) — map the product HANDLE (from the crawled
 *      canonical/destination URL `.../products/<handle>`) — or the product TITLE — to a variant `id`,
 *      wrapped into a GID. Used only when the seed has no usable variant id. Surfaces are tried in
 *      STOCK-AWARENESS order, because they disagree about whether they publish `available` at all:
 *        a. `<origin>/products/<handle>.js`    — per-handle AND carries `available`  (preferred)
 *        b. `<origin>/products/<handle>.json`  — per-handle but OMITS `available`    (stock unknown)
 *        c. `<origin>/products.json`           — paged listing, carries `available`
 *      MEASURED 2026-08-25 across all six OUTBOUND_WARM_HANDOFF_BRANDS: 6/6 omit `available` from (b).
 *      Every result reports `stockKnown` so a caller can distinguish "in stock" from "cannot tell";
 *      see pickVariantFromProductNode.
 *
 * HARD BOUNDS: read-only. External content (products.json) is DATA, never instructions — we read numeric ids
 * and titles ONLY, never eval/execute anything from it. No writes anywhere. Network is injectable for tests.
 *
 * NETWORK FENCE: `brandDomain` arrives from a REQUEST BODY on /internal/ucp/warm-handoff/resolve, so every
 * URL built here is attacker-influenced. Two separate holes were measured against this file on 2026-09-04:
 *   1. an https storefront answering `302 -> http://127.0.0.1:PORT/...` was FOLLOWED by global fetch's default
 *      `redirect: 'follow'`, landing three GETs on a plain-http loopback listener; and
 *   2. `brand_domain: '127.0.0.1:PORT'` (or `'[::1]:PORT'`) connected straight there, because
 *      normalizeBrandOrigin accepted any https origin including IP literals.
 * Both are closed the same way the sibling UCP client closes them, by REUSING its fence rather than minting a
 * second one: normalizeBrandOrigin now refuses IP-literal origins outright, and the default transport is
 * ucpBuyerAgentClient.createPublicNetworkFetch — https-only, literal addresses refused by
 * `forbiddenLiteralHost` before a request is built, and a DNS answer containing ANY non-public address
 * refused by `createPublicOnlyLookup`. Neither fence applied to this file before.
 *
 * Redirects are still followed, because three of the six live brands 301 on the per-handle surface (see
 * fetchProductsJson) — but each hop is a fresh call into that transport, so every hop is re-fenced. The
 * difference from the old behaviour is not that we stopped following; it is that following can no longer
 * leave the public internet.
 */

const nodeNet = require('node:net');
const nodeZlib = require('node:zlib');
const { createPublicNetworkFetch } = require('./ucpBuyerAgentClient');

const VARIANT_GID_PREFIX = 'gid://shopify/ProductVariant/';
const VARIANT_GID_RE = /gid:\/\/shopify\/ProductVariant\/(\d+)/i;
// A Shopify variant id is a long integer. Guard against picking up short/other numerics.
const BARE_NUMERIC_RE = /^\d{6,}$/;
// SKUs the crawler minted as "SHOPIFY-<variantId>".
const SHOPIFY_SKU_RE = /^SHOPIFY-(\d{6,})$/i;

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

/*
 * ONE stock vocabulary for every source, because the sources do not speak the same language:
 * products.json carries a BOOLEAN `available`, while the crawled seed carries FREE TEXT — "Out of
 * Stock", "sold_out", "unavailable", schema.org's "OutOfStock". A guard that compares against a
 * single literal silently misses every other spelling; `checkoutHandoffResolver.UNAVAILABLE_STATUSES`
 * already documents five of them. Normalising at the SOURCE means the downstream guard compares one
 * canonical token and cannot drift from whichever producer it happens to be reading.
 */
const AVAILABILITY_AVAILABLE = 'available';
const AVAILABILITY_OUT_OF_STOCK = 'out_of_stock';
const UNAVAILABLE_TEXT_RE = /out.?of.?stock|sold.?out|unavailable|discontinued|backorder/i;
const AVAILABLE_TEXT_RE = /^(available|in.?stock|instock|true|yes)$/i;

/**
 * Map any source's stock signal onto `'available' | 'out_of_stock' | null`.
 * `null` means "we could not determine it" — an unparseable string is NEVER read as a negative,
 * because a false "sold out" silently deletes a live product from the lane.
 */
function normalizeAvailability(raw) {
  if (raw === true) return AVAILABILITY_AVAILABLE;
  if (raw === false) return AVAILABILITY_OUT_OF_STOCK;
  const s = firstNonEmptyString(raw);
  if (!s) return null;
  if (UNAVAILABLE_TEXT_RE.test(s)) return AVAILABILITY_OUT_OF_STOCK;
  if (AVAILABLE_TEXT_RE.test(s)) return AVAILABILITY_AVAILABLE;
  return null;
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
 * @returns {{ variantGid: string, source: string, sku: string|null, availability: string|null,
 *            stockKnown: boolean, preferAvailableApplied: boolean } | null}
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
      const rawAvailability = firstNonEmptyString(v.stock, v.availability, v.availability_status);
      // Normalised to the SAME token the products.json paths emit, so one guard covers both lanes.
      const availability = normalizeAvailability(rawAvailability);
      const looksInStock = Boolean(rawAvailability) && availability !== AVAILABILITY_OUT_OF_STOCK;
      const record = {
        variantGid: gid,
        source: `${pathBase}[${i}].variant_id`,
        sku: firstNonEmptyString(v.sku) || null,
        availability,
        rawAvailability: rawAvailability || null,
        // Same contract as the products.json paths: `false` means "the source told us nothing about
        // stock", NOT "out of stock". A caller must never read an absent field as a negative.
        stockKnown: availability !== null,
        preferAvailableApplied: Boolean(preferAvailable && looksInStock),
      };
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
    // A Shopify storefront is ALWAYS a domain name — Shopify does not serve a shop on a raw address —
    // so an IP-literal `brand_domain` is never a legitimate brand and is refused here, before a URL is
    // handed to any transport. The transport fence would catch the private ranges anyway; this rejects
    // the whole literal form, so there is no per-range list to keep in sync and nothing to bypass with a
    // public-looking literal. Brackets are stripped first because `new URL('https://[::1]/').hostname`
    // KEEPS them and `net.isIP('[::1]')` is 0 — testing the unstripped host would wave every IPv6 through.
    if (nodeNet.isIP(String(u.hostname || '').replace(/^\[|\]$/g, '')) !== 0) return null;
    // Credentials in a storefront origin are refused as hygiene, NOT as a fence: `u.origin` below already
    // drops userinfo, so the pre-existing code never transmitted it. A brand_domain carrying credentials
    // is malformed rather than a storefront, and the route treats the resulting miss as free (uncounted,
    // unmemoized) so refusing it cannot be used to mint metric series.
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function normalizeTitle(t) {
  return firstNonEmptyString(t).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Pick a variant from a storefront product node.
 *
 * STOCK IS NOT ALWAYS KNOWABLE. Shopify's three public product surfaces do NOT agree on `available`:
 *   - `<origin>/products.json` (LISTING)        -> variants carry `available`            [stock known]
 *   - `<origin>/products/<handle>.js`           -> variants carry `available`            [stock known]
 *   - `<origin>/products/<handle>.json`         -> variants OMIT `available` entirely    [stock UNKNOWN]
 * MEASURED 2026-08-25 on all six OUTBOUND_WARM_HANDOFF_BRANDS (cosrx.com, beautyofjoseon.com,
 * skin1004.com, anua.us, medicube.us, mixsoon.us): 6/6 omit it from the per-handle `.json` and 6/6
 * carry it on `.js` and on the listing.
 *
 * So `variants.find((v) => v.available === true)` cannot match on a `.json` node — not because
 * everything is sold out, but because the FIELD IS ABSENT. Reporting that as "no preference
 * applied" instead of silently falling through to variants[0] is the whole point of `stockKnown`:
 * a caller must be able to tell "I picked an in-stock variant" apart from "I could not tell".
 *
 * @param {object} product  a storefront product node (listing entry, `.js` body, or `.json` product)
 * @param {{ preferAvailable?: boolean }} [opts]  prefer an in-stock variant when stock is knowable.
 *   DEFAULTS TO TRUE: this lane builds carts, and there is no caller who wants the sold-out variant
 *   when a live one is sitting next to it. Pass an explicit `false` for a verbatim variants[0] pick.
 * @returns {{ variantGid, sku, availability, stockKnown, preferAvailableApplied } | null}
 */
function pickVariantFromProductNode(product, opts = {}) {
  if (!isPlainObject(product) || !Array.isArray(product.variants)) return null;
  const variants = product.variants.filter(isPlainObject);
  if (variants.length === 0) return null;
  const preferAvailable = opts.preferAvailable !== false;

  // Prefer a variant that is BOTH in stock and actually usable — a variant whose id yields no GID is
  // not a candidate, or the preference could turn a previously-resolvable product into a miss.
  const available = variants.find((v) => normalizeAvailability(v.available) === AVAILABILITY_AVAILABLE
    && (toVariantGid(v.id) || toVariantGid(v.sku)));
  const chosen = (preferAvailable && available) || variants[0];

  const gid = toVariantGid(chosen.id) || toVariantGid(chosen.sku);
  if (!gid) return null;
  const availability = normalizeAvailability(chosen.available);
  return {
    variantGid: gid,
    sku: firstNonEmptyString(chosen.sku) || null,
    availability,
    // Describes the variant we ACTUALLY RETURN, not the node it came from: a node can publish stock
    // for some variants and not the one we picked, and the guard downstream reads this one's state.
    stockKnown: availability !== null,
    // True whenever the preference selected an in-stock variant — NOT only when it changed position.
    // Keying it on `!== variants[0]` made it read false for every healthy single-variant product,
    // i.e. a dial that reads zero precisely when things are fine.
    preferAvailableApplied: Boolean(preferAvailable && available),
  };
}

// One pinned transport for the whole module. `createPublicNetworkFetch` only builds closures and there is
// no require cycle to defer, so there is nothing to gain from constructing it lazily.
const publicFetch = createPublicNetworkFetch();

/**
 * PRODUCT.JSON fallback — fetch the brand's public products.json and map handle/title -> variant GID.
 * Read-only, best-effort: any failure (non-200, malformed, no match) resolves to null so the caller can
 * fall back to the cold redirect. Network is injectable for tests via opts.fetchImpl.
 *
 * @param {{ brandDomain: string, handle?: string, title?: string }} target
 * @param {{ fetchImpl?: Function, timeoutMs?: number, userAgent?: string, maxPages?: number,
 *          preferAvailable?: boolean }} [opts]
 * @returns {Promise<{ variantGid, source, sku, availability, stockKnown, preferAvailableApplied, handle } | null>}
 */
async function resolveVariantViaProductsJson(target = {}, opts = {}) {
  const origin = normalizeBrandOrigin(target.brandDomain);
  if (!origin) return null;
  const handle = firstNonEmptyString(target.handle) || extractProductHandle(target.handle) || null;
  const title = normalizeTitle(target.title);
  const preferAvailable = opts.preferAvailable !== false;
  // NOT global fetch. Global fetch follows redirects by default and its DNS lookup cannot be bound, which
  // is exactly how a merchant 302 walked this lane onto loopback. An explicit opts.fetchImpl still wins so
  // tests can drive fixtures, matching how createUcpBuyerAgentClient treats its own injected fetch.
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : publicFetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 12000;
  const userAgent = firstNonEmptyString(opts.userAgent) || 'Pivota-UCP-BuyerAgent/1.0';

  // Holds a per-handle pick whose stock could not be read, used only if no stock-bearing surface answers.
  let unknownStockPick = null;

  // Fast path: the per-product handle endpoint. `.js` is tried FIRST because it is the only per-handle
  // surface that carries `available` (see pickVariantFromProductNode) — `.json` omits it on all six
  // measured brands, which made `preferAvailable` inert here. `.json` stays as the immediate fallback
  // for any storefront where `.js` is unavailable; the common case is still ONE fetch, so the click
  // lane's tight budget is unchanged.
  if (handle) {
    const encoded = encodeURIComponent(handle);
    const perHandle = [
      { url: `${origin}/products/${encoded}.js`, label: `${origin}/products/${handle}.js` },
      { url: `${origin}/products/${encoded}.json`, label: `${origin}/products/${handle}.json` },
    ];
    for (const { url, label } of perHandle) {
      const one = await fetchProductsJson(url, { fetchImpl, timeoutMs, userAgent });
      const product = isPlainObject(one) ? (one.product || one) : null;
      const picked = product && pickVariantFromProductNode(product, { preferAvailable });
      if (!picked) continue;
      // A pick whose stock we could not read is NOT good enough when the caller asked to prefer
      // in-stock: fall through to a surface that does carry `available` rather than silently
      // returning a variants[0] guess dressed up as a preference-honouring answer.
      if (preferAvailable && !picked.stockKnown) {
        // Keep it: if no stock-bearing surface answers either, this is still better than nothing
        // (it is exactly what this lane returned before stock was consulted at all).
        if (!unknownStockPick) unknownStockPick = { ...picked, source: `products.json:${label}`, handle };
        continue;
      }
      return { ...picked, source: `products.json:${label}`, handle };
    }
  }

  // Fallback: page the catalog listing and match by handle, then by normalized title.
  //
  // TRAFFIC GUARD: if we already hold a usable (stock-blind) pick we are here only to UPGRADE stock
  // knowledge, and that is not worth a ten-page walk on a click path — each page is limit=250, and
  // `fetchProductsJson` cannot tell a 429 from a 404, so an unanswered `.js` under rate limiting
  // would otherwise make us send 12 requests instead of 1: being throttled would cause us to
  // generate MORE traffic. All six warm-handoff brands' catalogs fit in one or two pages, so a
  // single page keeps the stock rescue for essentially the whole cohort while capping the burst.
  const maxPages = Number.isFinite(opts.maxPages) ? Number(opts.maxPages) : 10;
  const pageLimit = unknownStockPick ? Math.min(maxPages, 1) : maxPages;
  for (let page = 1; page <= pageLimit; page += 1) {
    const listing = await fetchProductsJson(`${origin}/products.json?limit=250&page=${page}`, { fetchImpl, timeoutMs, userAgent });
    const products = isPlainObject(listing) && Array.isArray(listing.products) ? listing.products : [];
    if (products.length === 0) break;
    let match = handle ? products.find((p) => firstNonEmptyString(p && p.handle) === handle) : null;
    if (!match && title) match = products.find((p) => normalizeTitle(p && p.title) === title);
    if (match) {
      const picked = pickVariantFromProductNode(match, { preferAvailable });
      if (picked) {
        return { ...picked, source: `products.json:${origin}/products.json (page ${page})`, handle: firstNonEmptyString(match.handle) || handle };
      }
    }
    if (products.length < 250) break;
  }
  return unknownStockPick;
}

/*
 * REDIRECTS ARE FOLLOWED, but every hop is re-fenced.
 *
 * Not following at all was tried first and is WRONG here, and the measurement that said otherwise was
 * scoped to the wrong endpoint. `/products.json` does answer 200 directly on all six
 * OUTBOUND_WARM_HANDOFF_BRANDS (apex and www, 12/12) — but that is not the surface this lane hits first.
 * The first request is `<origin>/products/<handle>.js`, and measured 2026-09-04 THREE of the six 301 there:
 *   cosrx.com    -> www.cosrx.com
 *   skin1004.com -> www.skin1004.com
 *   anua.us      -> anua.com          (a DIFFERENT apex, not a www prefix)
 * Refusing the hop costs those brands the only per-handle surface that carries `available`: the lane falls
 * through to `.json` (no `available`, so stock unknown), then to a ~760 KB listing walk — three fetches and
 * a thousandfold more bytes on a click path budgeted at 1200 ms per fetch, and if that listing times out
 * the caller gets `availability: null`, which ucpWarmHandoffInternalRoute does NOT decline. So refusing
 * redirects silently disarms the sold-out guard for half the cohort.
 *
 * Following safely is not the same as what global fetch did. Global fetch followed with NO fence at all,
 * which is how a merchant 302 walked this lane onto loopback. Here every hop is a fresh call into the
 * pinned transport, so each one independently re-applies https-only, `forbiddenLiteralHost` and the
 * public-only DNS resolver — a `302 -> http://127.0.0.1:PORT` is refused at the hop, not followed. The
 * Location is additionally rejected here if it is not https or is an IP literal, so a bad hop dies before
 * a request is built at all. Hops are capped, which also terminates a redirect loop.
 */
// Bounds the DECODED body, and is deliberately larger than the transport's 2 MiB wire cap
// (ucpBuyerAgentClient MAX_MERCHANT_RESPONSE_BYTES) — a gzipped listing legitimately inflates several
// times over. It is a zip-bomb stop, not a size policy: the wire cap is what limits ordinary bodies.
const MAX_DECODED_BODY_BYTES = 8 * 1024 * 1024;
// TWO, not three. Every redirect measured on the live cohort is a SINGLE hop (cosrx.com -> www,
// skin1004.com -> www, anua.us -> anua.com), so one spare hop covers everything seen plus a chained
// canonicalisation. It is a cap on merchant-facing traffic as much as on loops: each surface may
// redirect, so N hops costs up to 3*(1+N) requests per resolve — 9 at two hops, 12 at three, against 3
// before. A brand that genuinely needs a third hop loses its warm cart and cold-redirects; a brand that
// 302s everything cannot make this lane amplify without bound.
const MAX_REDIRECT_HOPS = 2;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Resolve a Location against the URL it came from, then refuse anything that is not a public https host. */
function nextHopUrl(location, currentUrl) {
  const raw = firstNonEmptyString(location);
  if (!raw) return null;
  let next;
  try { next = new URL(raw, currentUrl); } catch { return null; }
  if (next.protocol !== 'https:') return null;
  if (next.username || next.password) return null;
  // Same literal rule as normalizeBrandOrigin: brackets stripped before isIP, or every IPv6 literal
  // would read as a hostname. The transport refuses these too; this just stops the request earlier.
  if (nodeNet.isIP(String(next.hostname || '').replace(/^\[|\]$/g, '')) !== 0) return null;
  return next.toString();
}

async function fetchProductsJson(url, { fetchImpl, timeoutMs, userAgent }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  // One budget for the WHOLE chain, not per hop: the click path cares how long it waits, and a per-hop
  // timer would let a 3-hop redirect spend three times the budget it was given.
  const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    let currentUrl = url;
    for (let hop = 0; ; hop += 1) {
      const res = await fetchImpl(currentUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': userAgent,
          // The pinned transport is node:https, which — unlike global fetch — neither advertises nor
          // decodes compression. Asking for it back matters twice: the transport's 2 MiB cap counts
          // WIRE bytes, and medicube.us's listing measured 2,040,790 bytes uncompressed on 2026-09-04
          // against a 2,097,152 cap (97.3%, ~56 KB of headroom) versus 342,704 gzipped. Without this
          // header one more product on that storefront silently deletes its listing fallback.
          'accept-encoding': 'gzip',
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res) return null;

      if (REDIRECT_STATUSES.has(res.status)) {
        if (hop >= MAX_REDIRECT_HOPS) return null;
        const next = nextHopUrl(res.headers && res.headers.get && res.headers.get('location'), currentUrl);
        if (!next) return null;
        currentUrl = next;
        continue;
      }

      if (!res.ok) return null;
      return await decodeJson(res);
    }
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read a JSON body, inflating it first when the storefront honoured `accept-encoding: gzip`.
 * `res.json()` cannot do this itself — node:https hands back the bytes exactly as they arrived.
 *
 * The inflated size is bounded as well as the wire size. A 2 MiB cap on compressed bytes is not a bound
 * on memory: gzip of a repetitive JSON body reaches ~1000:1, so a merchant could answer inside the wire
 * cap and still expand to gigabytes here. `maxOutputLength` makes zlib throw instead, which the caller's
 * catch folds into the same null as any other unreadable body.
 */
async function decodeJson(res) {
  const encoding = String((res.headers && res.headers.get && res.headers.get('content-encoding')) || '')
    .trim()
    .toLowerCase();
  if (encoding !== 'gzip' && encoding !== 'deflate') return res.json();
  const raw = Buffer.from(await res.arrayBuffer());
  // The ASYNC inflate, not gunzipSync: this runs on a click path that walks up to `maxPages` listings,
  // and each synchronous inflate blocks the event loop for the whole server (~1.4 ms per measured
  // medicube.us page). The async form hands it to the threadpool instead.
  const inflate = encoding === 'gzip' ? nodeZlib.gunzip : nodeZlib.inflate;
  const decoded = await new Promise((resolve, reject) => {
    inflate(raw, { maxOutputLength: MAX_DECODED_BODY_BYTES }, (err, out) => (err ? reject(err) : resolve(out)));
  });
  return JSON.parse(decoded.toString('utf8'));
}

/**
 * Top-level resolver: seed_data first (offline), then products.json (network) if allowed.
 *
 * `preferAvailable` is a PREFERENCE, not a guarantee: it reorders the pick when stock is knowable and
 * does nothing when it is not (see pickVariantFromProductNode). Read `stockKnown` on the result to tell
 * the two apart. `requireAvailable` is the guarantee — it declines rather than returning a variant
 * that is known to be out of stock, so the caller can cold-redirect instead of building a dead cart.
 *
 * @param {{ seedData?: object, brandDomain?: string, canonicalUrl?: string, title?: string, handle?: string }} input
 * @param {{ allowNetworkFallback?: boolean, preferAvailable?: boolean, requireAvailable?: boolean,
 *          fetchImpl?: Function, timeoutMs?: number, userAgent?: string, maxPages?: number }} [opts]
 * @returns {Promise<{ variantGid, source, sku, availability, stockKnown, preferAvailableApplied, handle? } | null>}
 */
async function resolveShopifyVariant(input = {}, opts = {}) {
  const resolved = await resolveShopifyVariantInner(input, opts);
  // Decline a KNOWN out-of-stock variant only when the caller opted in. An UNKNOWN stock state is not a
  // negative — declining on `stockKnown === false` would silently drop every storefront that does not
  // publish `available`, which is the mirror of the bug this guard exists to prevent.
  if (opts.requireAvailable === true && resolved && resolved.availability === AVAILABILITY_OUT_OF_STOCK) return null;
  return resolved;
}

async function resolveShopifyVariantInner(input = {}, opts = {}) {
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
  AVAILABILITY_AVAILABLE,
  AVAILABILITY_OUT_OF_STOCK,
  normalizeAvailability,
  toVariantGid,
  resolveVariantFromSeed,
  resolveVariantViaProductsJson,
  resolveShopifyVariant,
  extractProductHandle,
  normalizeBrandOrigin,
  pickVariantFromProductNode,
  VARIANT_GID_PREFIX,
};
