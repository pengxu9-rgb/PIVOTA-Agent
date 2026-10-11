'use strict';

// IS THE STOREFRONT'S PRODUCT PAGE STILL THERE? Only the store may say it is not.
//
// Why this exists (2026-10-09): a product its brand had removed (judydoll "Sheer Tinted Highlighter") was served
// by search as in stock, and the UCP storefront escalation handed buyers a continue_url to a 404. The live price
// overlay had SEEN the 404 (`failure_reasons.http_404`) and kept the card anyway, because a failed read was only
// ever a price question. A throttled sample of served storefront rows found ~5% with a dead product page.
//
// THE EVIDENCE RULE. A 404 alone is not proof: a WAF or CDN can answer 404 to an unfamiliar client, and the backend
// sweep refuses to retire on one for exactly that reason (pivota-backend services/external_seed_destination_liveness).
// The proof used here is that the 404 CAME FROM SHOPIFY: Shopify stamps `powered-by: Shopify` (and often
// `x-shopid`) on its own responses, including the 404 for a handle the store no longer has, and a block page from a
// CDN that never reached the store does not carry it. Measured 2026-10-09 on judydoll.com, kosas.com and
// glossier.com: `404` + `powered-by: Shopify` for removed handles, `200` + the same header for live ones. A
// Cloudflare challenge (`cf-mitigated`) is never evidence of anything.
//
// EXCEPT A HEADLESS STOREFRONT. A Hydrogen app on Oxygen stamps `powered-by: Shopify, Oxygen, Hydrogen` on every
// response, and it has no `/products/<handle>.json` route at all: that URL is 404 for LIVE products. Measured
// 2026-10-11 on hydrogen.shop: `/products/the-full-stack` 200, `/products/the-full-stack.json` 404, both with that
// header and no x-shopid. So a `.json` 404 from Hydrogen/Oxygen is not an answer; the HTML product page is asked
// instead (a removed handle there is a real 404 with the same header), and a live HTML page is `unknown`, because it
// carries no variant ids.
//
// WHAT "GONE" MEANS HERE: a buyer following this link lands on the store's own "page not found". It is a serving
// fact, not a retirement: nothing is written, the verdict lives in this process for TTL_MS, and the backend's
// corroborated sweep remains the only thing that withdraws a row.
//
// SHAPE: only `https://<host>/products/<handle>` (the same shape liveMerchantSearchPrice reads). Anything else is
// `unknown`, never gone.

const { createPublicNetworkFetch } = require('./ucpBuyerAgentClient');

const TTL_MS = 120000;
const MAX_ENTRIES = 1000;
const DEFAULT_TIMEOUT_MS = 1500;
// A product's stored variant ids are capped; above the cap the page is live with `variantIds: null` (cannot tell).
const MAX_VARIANT_IDS = 250;
const MERCHANT_HEADERS = Object.freeze({
  'User-Agent': 'PivotaCatalog/1.0',
  Accept: 'application/json',
});
const HTML_HEADERS = Object.freeze({
  'User-Agent': 'PivotaCatalog/1.0',
  Accept: 'text/html',
});

let defaultFetch = null;
const goneCache = new Map(); // product .json URL -> { status, expires }
const liveCache = new Map(); // product .json URL -> { variantIds, expires }

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

/** The product page behind a storefront URL, or null when the URL is not `https://<host>/products/<handle>`. */
function productPageOf(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const match = url.pathname.match(/^\/products\/([a-z0-9][a-z0-9-]*)\/?$/i);
  if (!match) return null;
  return {
    host: url.hostname.toLowerCase(),
    handle: match[1],
    jsonUrl: `${url.origin}/products/${match[1]}.json`,
    htmlUrl: `${url.origin}/products/${match[1]}`,
  };
}

function headerOf(response, name) {
  const headers = response && response.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(',') : String(value || '');
}

/** A Hydrogen/Oxygen (headless) storefront: its `/products/<handle>.json` is 404 for live products. */
function isHeadlessStorefront(response) {
  return /\b(hydrogen|oxygen)\b/i.test(headerOf(response, 'powered-by'));
}

/** A 404/410 that Shopify itself served, on whatever page was asked. */
function shopifyStamped404(response) {
  const status = Number(response && response.status);
  if (status !== 404 && status !== 410) return false;
  if (headerOf(response, 'cf-mitigated')) return false;
  return /\bshopify\b/i.test(headerOf(response, 'powered-by')) || /^\d+$/.test(headerOf(response, 'x-shopid').trim());
}

/**
 * True only for a product `.json` 404/410 that Shopify itself served. See the evidence rule above: a headless
 * storefront's `.json` 404 is never gone here (readStorefrontProductPage asks its HTML page instead).
 */
function shopifySaysGone(response) {
  return shopifyStamped404(response) && !isHeadlessStorefront(response);
}

function noteGone(jsonUrl, status, now = Date.now()) {
  if (!jsonUrl) return;
  liveCache.delete(jsonUrl);
  remember(goneCache, jsonUrl, { status: Number(status) || 404, expires: now + TTL_MS });
}

/** The cached gone verdict for this product .json URL, or null. */
function knownGone(jsonUrl, now = Date.now()) {
  const hit = goneCache.get(jsonUrl);
  if (!hit) return null;
  if (hit.expires <= now) { goneCache.delete(jsonUrl); return null; }
  return { status: hit.status };
}

function variantIdsOf(body) {
  const variants = body && body.product && Array.isArray(body.product.variants) ? body.product.variants : null;
  if (!variants) return null;
  if (variants.length > MAX_VARIANT_IDS) return 'too_many';
  return new Set(variants.map((v) => String(v && v.id != null ? v.id : '')).filter((id) => /^\d+$/.test(id)));
}

/**
 * One bounded read of a storefront product page. Never throws.
 * @returns {Promise<{state:'gone'|'live'|'unknown', reason:string, host?:string, handle?:string, status?:number,
 *   variantIds?:Set<string>|null, cacheHit?:boolean, headless?:boolean}>}
 *   `variantIds: null` on a live page = more than MAX_VARIANT_IDS variants: which ones are sold is not known.
 */
async function readStorefrontProductPage(rawUrl, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  const page = productPageOf(rawUrl);
  if (!page) return { state: 'unknown', reason: 'not_a_product_page' };
  const base = { host: page.host, handle: page.handle };
  const gone = knownGone(page.jsonUrl, now());
  if (gone) return { ...base, state: 'gone', reason: `http_${gone.status}`, status: gone.status, cacheHit: true };
  const live = liveCache.get(page.jsonUrl);
  if (live && live.expires > now()) return { ...base, state: 'live', reason: 'ok', variantIds: live.variantIds, cacheHit: true };

  const doFetch = fetchImpl || (defaultFetch = defaultFetch || createPublicNetworkFetch());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(page.jsonUrl, { redirect: 'error', signal: controller.signal, headers: MERCHANT_HEADERS });
    if (shopifySaysGone(response)) {
      noteGone(page.jsonUrl, response.status, now());
      return { ...base, state: 'gone', reason: `http_${response.status}`, status: Number(response.status) };
    }
    if (shopifyStamped404(response) && isHeadlessStorefront(response)) {
      // A headless store's .json 404 says nothing: ask the product page a buyer would land on.
      const html = await doFetch(page.htmlUrl, { redirect: 'error', signal: controller.signal, headers: HTML_HEADERS });
      if (shopifyStamped404(html)) {
        noteGone(page.jsonUrl, html.status, now());
        return { ...base, state: 'gone', reason: `http_${html.status}`, status: Number(html.status), headless: true };
      }
      return { ...base, state: 'unknown', reason: html && html.ok ? 'headless_storefront' : `headless_http_${Number(html && html.status) || 0}` };
    }
    if (!response || !response.ok) return { ...base, state: 'unknown', reason: `http_${Number(response && response.status) || 0}` };
    let body;
    try { body = await response.json(); } catch { return { ...base, state: 'unknown', reason: 'invalid_json' }; }
    let variantIds = variantIdsOf(body);
    if (!variantIds) return { ...base, state: 'unknown', reason: 'no_variants' };
    if (variantIds === 'too_many') variantIds = null;
    remember(liveCache, page.jsonUrl, { variantIds, expires: now() + TTL_MS });
    return { ...base, state: 'live', reason: 'ok', variantIds };
  } catch {
    return { ...base, state: 'unknown', reason: controller.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

function resetForTests() {
  goneCache.clear();
  liveCache.clear();
}

module.exports = {
  TTL_MS,
  MAX_VARIANT_IDS,
  productPageOf,
  isHeadlessStorefront,
  shopifySaysGone,
  noteGone,
  knownGone,
  readStorefrontProductPage,
  resetForTests,
};
