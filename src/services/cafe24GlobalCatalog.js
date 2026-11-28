'use strict';

/*
 * CAFE24 GLOBAL CATALOG LANE: SEARCH-ONLY, SHADOW-ONLY.
 *
 * WHAT IT IS. Cafe24 documents a platform-wide UCP catalog: discovery at
 * https://mcp-catalog.cafe24.com/.well-known/ucp, MCP endpoint https://mcp-catalog.cafe24.com/api/ucp/mcp, tools
 * search_catalog / get_product / lookup_catalog, UCP 2026-04-08, and our own HTTPS agent profile URL in
 * `arguments.meta["ucp-agent"].profile` on every call (Cafe24's published MCP documentation). No live Cafe24 answer
 * has been captured yet, so the shapes below follow the UCP 2026-04-08 catalog contract, not an observed response.
 * This module reads that catalog through the gateway's EXISTING UCP buyer client (ucpBuyerAgentClient.js) and turns
 * its answer into Pivota offer candidates.
 *
 * WHAT IT IS NOT.
 *   - Not buyable. Every candidate carries `buyable: false` and `execution.eligible: false` with named blockers. No
 *     Cafe24 checkout, payment, or order route is implemented or verified for this lane. A listing never acquires an
 *     executable flag here.
 *   - Not served. The only mode is `shadow`: the lane runs beside a served search page and LOGS COUNTS. The page is
 *     never changed. Under seller admission (ADR-033, Proposed) a seller no admission record covers is not shown, and
 *     no Cafe24 seller has one. Serving would be its own change.
 *   - Not stored. No result, id, price, or image is cached or written anywhere (Cafe24's catalog terms on caching
 *     and attribution are unverified; the Shopify catalog's forbid it). Only the discovery check is memoised.
 *   - Not a credential carrier. The client is built `forceAnonymous` and `allowTokenTier: false`, and a client that
 *     still reports any tier but anonymous, or would sign, is refused before a byte is sent (`credential_tier_refused`).
 *     The Bearer token, client credentials and signing key configured for other UCP work never reach Cafe24.
 *   - Not every search. The server hook observes only a door's search_catalog (src/server.js
 *     maybeShadowCafe24CatalogSearch), once per request.
 *
 * VERSIONS (three different things, kept apart):
 *   - MCP: this client sends stateless JSON-RPC `tools/call` with no `initialize` (the existing client's behaviour).
 *     A server that demands a session is reported as `mcp_session_required`, not worked around.
 *   - UCP: pinned to UCP_SPEC_VERSION (safety-kernel/src/protocol/ucpSpecVersion.cjs, 2026-04-08). A discovery
 *     profile advertising another version stops the lane (`ucp_version_unsupported`) because the parser below is
 *     written to the 2026-04-08 catalog shape.
 *   - Cafe24 REST API version (CAFE24_API_VERSION, backend Admin adapter): NOT used here and never sent.
 *
 * IDS ARE OPAQUE. A catalog id is kept byte-for-byte and never split to infer a mall, shop, product_no or
 * variant_code. Execution ids, if a route ever exists, come from a verified lookup contract, not from parsing.
 *
 * MONEY. UCP amounts are minor units; majorUnitsOf (merchantVariantSource.js) applies each currency's own exponent
 * (KRW 0, JPY 0, USD 2). An amount in a currency that is not the buyer market's is counted as a mismatch, never
 * converted. A catalog price is a LIST price (`price_kind: 'catalog_list'`), not a quote with shipping and tax.
 *
 * ENDPOINT. Discovery must name exactly PINNED_ENDPOINT (scheme, host, port and path); anything else stops the lane
 * (`endpoint_not_pinned`). Nothing else is ever contacted.
 *
 * BOUNDS. One page, at most MAX_RESULTS products. A per-process ceiling (CAFE24_CATALOG_SHADOW_PER_MIN, default 10,
 * 1..60), at most MAX_IN_FLIGHT calls at once, no retries, a per-call timeout, and a breaker that opens on 429 / 5xx /
 * timeout / transport failures (Retry-After honoured, capped at 1 h). Discovery + tools/list run at most once per
 * DISCOVERY_TTL_MS; a remembered discovery failure is not counted again. None of Cafe24's REST quotas are assumed to
 * apply to this endpoint.
 *
 * LOGS. A search that sent a request logs one `cafe24_catalog_shadow` line of counts and allowlisted codes. A search
 * refused before sending (no market, ceiling, breaker, ...) is only counted, and the counts are logged at most once a
 * minute as `cafe24_catalog_shadow_refusals` (on a timer, so the last window is not lost when traffic stops). A string
 * error code from the server is logged only when it is in KNOWN_CODES; any other string is logged as 'other'.
 *
 * FAILURES ARE NAMED SEPARATELY (REASON): a transport failure, an HTTP status, a JSON-RPC (MCP) error, an MCP tool
 * error, a UCP business error, and a schema mismatch are different outcomes. HTTP 200 alone is never success.
 *
 * SWITCH: CAFE24_CATALOG_SEARCH = off (default) | shadow (case-insensitive, trimmed), read per call. Any other value,
 * `enforce` included, is off.
 * CAFE24_CATALOG_DENY (1/true) is a kill switch that wins over everything.
 */

const {
  createUcpBuyerAgentClient,
  createMerchantDoorFetch,
  TRUST_TIER,
  unwrapToolPayload,
  profileAdvertisesCapability,
} = require('./ucpBuyerAgentClient');
const { majorUnitsOf } = require('./merchantVariantSource');
const { currencyForBuyerRegion, normalizeBuyerRegion } = require('../auroraBff/buyerRegion');
const { UCP_SPEC_VERSION } = require('../../safety-kernel/src/protocol/ucpSpecVersion.cjs');

const SOURCE = 'cafe24_global_catalog';
const PLATFORM = 'cafe24';
const ATTRIBUTION = 'Cafe24 Global Catalog';
const CATALOG_ORIGIN = 'https://mcp-catalog.cafe24.com';
const CATALOG_HOST = 'mcp-catalog.cafe24.com';
const PINNED_ENDPOINT = `${CATALOG_ORIGIN}/api/ucp/mcp`;
const SEARCH_CAPABILITY = 'dev.ucp.shopping.catalog.search';

const MODE_FLAG = 'CAFE24_CATALOG_SEARCH';
const DENY_FLAG = 'CAFE24_CATALOG_DENY';
const PER_MIN_FLAG = 'CAFE24_CATALOG_SHADOW_PER_MIN';
const MODES = Object.freeze({ OFF: 'off', SHADOW: 'shadow' });

const MAX_RESULTS = 10;
const MAX_IN_FLIGHT = 2;
const CALL_TIMEOUT_MS = 2500;
const DEFAULT_PER_MIN = 10;
const MAX_PER_MIN = 60;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_FAILURE_RETRY_MS = 5 * 60 * 1000;
const BREAKER_FAILURES = 3;
const BREAKER_BASE_MS = 60 * 1000;
const BREAKER_MAX_MS = 10 * 60 * 1000;
const RETRY_AFTER_MAX_MS = 60 * 60 * 1000;
const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 300;
const MAX_IMAGES = 3;
const MAX_VARIANTS = 50;
const MAX_QUERY_LENGTH = 200;
const REFUSAL_LOG_INTERVAL_MS = 60 * 1000;
// A server-supplied STRING code is logged only when it is one of these (UCP 2026-04-08 message / error codes and the
// profile refusals seen from UCP servers); any other string is logged as 'other', never as itself, because a
// one-word code can still be the buyer's query echoed back. Integer JSON-RPC codes are logged as they are.
const KNOWN_CODES = Object.freeze(new Set([
  'invalid_request', 'invalid_params', 'invalid_argument', 'not_found', 'unauthorized', 'forbidden',
  'rate_limited', 'too_many_requests', 'internal_error', 'unavailable', 'timeout',
  'unsupported_country', 'unsupported_currency', 'unsupported_version', 'version_unsupported',
  'capability_unsupported', 'profile_unreachable', 'profile_invalid', 'invalid_profile',
  'session_required', 'session_not_found',
]));
const OTHER_CODE = 'other';

const REASON = Object.freeze({
  OK: 'ok',
  OFF: 'off',
  DENIED: 'denied',
  NO_QUERY: 'no_query',
  NO_MARKET: 'no_market',
  MARKET_NOT_PRICED: 'market_not_priced',
  LOCAL_RATE_LIMIT: 'local_rate_limit',
  IN_FLIGHT_CAP: 'in_flight_cap',
  BREAKER_OPEN: 'breaker_open',
  NO_PROFILE_URL: 'no_profile_url',
  DISCOVERY_FAILED: 'discovery_failed',
  ENDPOINT_NOT_PINNED: 'endpoint_not_pinned',
  CREDENTIAL_TIER_REFUSED: 'credential_tier_refused',
  UCP_VERSION_UNSUPPORTED: 'ucp_version_unsupported',
  CAPABILITY_NOT_ADVERTISED: 'capability_not_advertised',
  TOOL_NOT_LISTED: 'tool_not_listed',
  TIMEOUT: 'timeout',
  TRANSPORT_ERROR: 'transport_error',
  HTTP_401: 'http_401',
  HTTP_403: 'http_403',
  HTTP_429: 'http_429',
  HTTP_5XX: 'http_5xx',
  HTTP_4XX: 'http_4xx',
  MCP_SESSION_REQUIRED: 'mcp_session_required',
  PROFILE_REFUSED: 'profile_refused',
  MCP_ERROR: 'mcp_error',
  TOOL_ERROR: 'tool_error',
  UCP_BUSINESS_ERROR: 'ucp_business_error',
  SCHEMA_MISMATCH: 'schema_mismatch',
  UNPARSEABLE: 'unparseable',
});

// Outcomes that say the catalog (not our input) is struggling: they feed the breaker.
const BREAKER_REASONS = new Set([
  REASON.TIMEOUT, REASON.TRANSPORT_ERROR, REASON.HTTP_429, REASON.HTTP_5XX,
]);

// Every candidate is blocked from execution by these, whatever else is true.
const ALWAYS_BLOCKED = Object.freeze([
  // No Cafe24 checkout / payment / order route is implemented or verified for this lane.
  'execution_route_unverified',
  // Seller admission (ADR-033, Proposed): no admission record covers a Cafe24 seller.
  'seller_not_admitted',
]);

function str(v) {
  return v == null ? '' : String(v).trim();
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function truthyFlag(v) {
  return ['1', 'true', 'on', 'yes'].includes(str(v).toLowerCase());
}

function readMode(env = process.env) {
  if (truthyFlag(env[DENY_FLAG])) return MODES.OFF;
  return str(env[MODE_FLAG]).toLowerCase() === MODES.SHADOW ? MODES.SHADOW : MODES.OFF;
}

/** An integer, clamped to 1..MAX_PER_MIN; anything that is not an integer is the default. */
function perMinuteCeiling(env = process.env) {
  const raw = str(env[PER_MIN_FLAG]);
  if (!/^-?\d+$/.test(raw)) return DEFAULT_PER_MIN;
  return Math.max(1, Math.min(Number(raw), MAX_PER_MIN));
}

/** A server-supplied code for a log line: an integer as is, a known code as is, any other string 'other', else null. */
function safeCode(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const c = v.trim().toLowerCase();
  return KNOWN_CODES.has(c) ? c : OTHER_CODE;
}

/** An opaque id: a non-empty string (or a finite number, stringified) of bounded length, kept exactly. */
function opaqueId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  if (!v.trim() || v.length > MAX_ID_LENGTH) return null;
  return v;
}

/** An https URL, or null. Never fetched here: catalog data is data. */
function httpsUrl(v) {
  const s = str(v);
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.toString();
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
}

function clip(s, n) {
  const t = str(s);
  return t.length > n ? t.slice(0, n) : t;
}

/**
 * The message an MCP streamable-HTTP server sent as `text/event-stream`. The shared client JSON.parses the body and
 * keeps `{ raw }` when that fails; an SSE body is `event: message\ndata: {...}` lines. The LAST data line that parses
 * as a JSON-RPC message is the answer. Anything else is null.
 */
function parseSseRaw(raw) {
  if (typeof raw !== 'string' || !raw.includes('data:')) return null;
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const msg = JSON.parse(line.slice(5).trim());
      if (isPlainObject(msg) && msg.jsonrpc === '2.0') last = msg;
    } catch { /* not a JSON line */ }
  }
  return last;
}

function jsonRpcMessageOf(callResult) {
  const r = callResult && callResult.response;
  if (isPlainObject(r) && typeof r.raw === 'string') return parseSseRaw(r.raw);
  return isPlainObject(r) ? r : null;
}

function errorCodeOf(err) {
  return isPlainObject(err) ? safeCode(err.code) : null;
}

function errorTextOf(err) {
  if (!isPlainObject(err)) return '';
  const data = err.data;
  const dataCode = isPlainObject(data) ? str(data.code) : (typeof data === 'string' ? data : '');
  return `${str(err.message)} ${dataCode}`.toLowerCase();
}

function retryAfterMs(value, nowMs) {
  const s = str(value);
  if (!s) return null;
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(s);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(at - nowMs, RETRY_AFTER_MAX_MS));
}

/**
 * Classify ONE tools/call answer (or the error it threw). Returns { reason, http_status?, mcp_error_code?,
 * payload? }. Only `ok` carries a payload, and only when that payload has a `products` array.
 */
function classifyCallOutcome({ thrown, callResult } = {}) {
  if (thrown) {
    return { reason: thrown.name === 'AbortError' ? REASON.TIMEOUT : REASON.TRANSPORT_ERROR };
  }
  if (!callResult || typeof callResult !== 'object') return { reason: REASON.UNPARSEABLE };
  const status = Number(callResult.status) || 0;
  const msg = jsonRpcMessageOf(callResult);
  const rpcError = msg && isPlainObject(msg.error) ? msg.error : null;
  const base = { http_status: status || undefined, mcp_error_code: rpcError ? errorCodeOf(rpcError) : undefined };
  const text = rpcError ? errorTextOf(rpcError) : '';
  // Our agent profile refused (measured on another UCP server, 2026-08-13: `-32001 { code: 'profile_unreachable' }`).
  if (/profile/.test(text)) {
    return { ...base, reason: REASON.PROFILE_REFUSED };
  }
  if (/session/.test(text) || (status === 400 && /session/.test(str(callResult.response && callResult.response.raw).toLowerCase()))) {
    return { ...base, reason: REASON.MCP_SESSION_REQUIRED };
  }
  if (status === 401) return { ...base, reason: REASON.HTTP_401 };
  if (status === 403) return { ...base, reason: REASON.HTTP_403 };
  if (status === 429) return { ...base, reason: REASON.HTTP_429 };
  if (status >= 500) return { ...base, reason: REASON.HTTP_5XX };
  if (status >= 400) return { ...base, reason: rpcError ? REASON.MCP_ERROR : REASON.HTTP_4XX };
  if (!msg) return { ...base, reason: REASON.UNPARSEABLE };
  if (rpcError) {
    return { ...base, reason: rpcError.code === -32601 ? REASON.TOOL_NOT_LISTED : REASON.MCP_ERROR };
  }
  const result = isPlainObject(msg.result) ? msg.result : null;
  if (!result) return { ...base, reason: REASON.SCHEMA_MISMATCH };
  if (result.isError === true) return { ...base, reason: REASON.TOOL_ERROR };
  const payload = unwrapToolPayload({ response: msg });
  if (!isPlainObject(payload)) return { ...base, reason: REASON.UNPARSEABLE };
  const ucpStatus = isPlainObject(payload.ucp) ? str(payload.ucp.status).toLowerCase() : '';
  const errorMessages = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((m) => isPlainObject(m) && str(m.type).toLowerCase() === 'error');
  if (!Array.isArray(payload.products)) {
    if (ucpStatus === 'error' || errorMessages.length) {
      const code = errorMessages.length ? safeCode(errorMessages[0].code) : null;
      return { ...base, reason: REASON.UCP_BUSINESS_ERROR, ucp_error_code: code };
    }
    return { ...base, reason: REASON.SCHEMA_MISMATCH };
  }
  return { ...base, reason: REASON.OK, payload };
}

function sellerOf(node) {
  if (!isPlainObject(node)) return null;
  const s = isPlainObject(node.seller) ? node.seller : (isPlainObject(node.merchant) ? node.merchant : null);
  if (!s) return null;
  const name = clip(s.name, MAX_TITLE_LENGTH) || null;
  const url = httpsUrl(s.url || s.links?.home);
  const domain = str(s.domain).toLowerCase() || (url ? hostOf(url) : null) || null;
  const platformSellerId = opaqueId(s.id);
  if (!name && !domain && !platformSellerId) return null;
  return { name, domain, platform_seller_id: platformSellerId };
}

function selectedOptionsOf(v) {
  const raw = Array.isArray(v.selected_options) ? v.selected_options : (Array.isArray(v.options) ? v.options : []);
  const out = [];
  for (const o of raw) {
    if (!isPlainObject(o)) continue;
    const name = clip(o.name, 100);
    const value = clip(isPlainObject(o.value) ? o.value.label || o.value.name : o.value ?? o.label, 200);
    if (name && value) out.push({ name, value });
  }
  return out;
}

function imagesOf(product) {
  const out = [];
  for (const m of Array.isArray(product.media) ? product.media : []) {
    if (!isPlainObject(m)) continue;
    const type = str(m.type).toLowerCase();
    if (type && type !== 'image') continue;
    const url = httpsUrl(m.url);
    if (url) out.push(url);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function normalizeVariant(v, expectedCurrency) {
  if (!isPlainObject(v)) return null;
  const variantId = opaqueId(v.id);
  if (!variantId) return null;
  const money = majorUnitsOf(v.price);
  const currency = str(v.price && v.price.currency).toUpperCase() || null;
  const available = isPlainObject(v.availability) && typeof v.availability.available === 'boolean'
    ? v.availability.available : null;
  return {
    variant_id: variantId,
    title: clip(v.title, MAX_TITLE_LENGTH) || null,
    selected_options: selectedOptionsOf(v),
    price: money ? money.amount : null,
    currency: money ? currency : null,
    priced_for_market: Boolean(money && expectedCurrency && currency === expectedCurrency),
    in_stock: available,
    seller: sellerOf(v),
  };
}

/**
 * One UCP catalog product -> one Pivota offer candidate (never buyable). Null when the product has no usable id.
 * The top-level price is set only when every priced variant agrees on price and currency: a product minimum is not
 * an offer for an arbitrary variant.
 */
function normalizeCatalogProduct(product, { market, answeredAtMs } = {}) {
  if (!isPlainObject(product)) return null;
  const productId = opaqueId(product.id);
  if (!productId) return null;
  const expectedCurrency = currencyForBuyerRegion(market) || null;
  const variants = (Array.isArray(product.variants) ? product.variants : [])
    .slice(0, MAX_VARIANTS)
    .map((v) => normalizeVariant(v, expectedCurrency))
    .filter(Boolean);
  const merchant = sellerOf(product) || variants.map((v) => v.seller).find(Boolean) || null;
  const priced = variants.filter((v) => v.price !== null);
  const samePrice = priced.length > 0 && priced.length === variants.length
    && priced.every((v) => v.price === priced[0].price && v.currency === priced[0].currency);
  const price = samePrice ? priced[0].price : null;
  const currency = samePrice ? priced[0].currency : null;
  const stock = variants.map((v) => v.in_stock);
  const inStock = stock.includes(true) ? true : (stock.length && stock.every((s) => s === false) ? false : null);

  const blockers = [...ALWAYS_BLOCKED];
  if (!merchant) blockers.push('merchant_unresolved');
  if (!variants.length) blockers.push('variants_missing');
  if (!priced.length) blockers.push('price_unreadable');
  else if (!priced.some((v) => v.priced_for_market)) blockers.push('currency_not_market');
  if (inStock === null) blockers.push('availability_unknown');

  return {
    source: SOURCE,
    platform: PLATFORM,
    product_id: productId,
    title: clip(product.title, MAX_TITLE_LENGTH) || null,
    url: httpsUrl(product.url),
    images: imagesOf(product),
    merchant,
    price,
    currency,
    price_kind: 'catalog_list',
    price_varies_by_variant: priced.length > 0 && !samePrice,
    in_stock: inStock,
    market: normalizeBuyerRegion(market) || null,
    variants: variants.map(({ seller, ...rest }) => rest),
    buyable: false,
    execution: { eligible: false, blockers },
    provenance: {
      source: SOURCE,
      attribution: ATTRIBUTION,
      endpoint_host: CATALOG_HOST,
      ucp_version: UCP_SPEC_VERSION,
      answered_at_ms: Number.isFinite(answeredAtMs) ? answeredAtMs : null,
      stored: false,
    },
  };
}

/** Counts for the shadow log line. Counts only: no id, title, url, price, or query text. */
function summarizeCandidates(candidates) {
  const sellers = new Set();
  const out = {
    products: candidates.length,
    variants: 0,
    priced: 0,
    priced_in_market: 0,
    currency_mismatch: 0,
    in_stock: 0,
    with_merchant: 0,
    sellers: 0,
  };
  for (const c of candidates) {
    out.variants += c.variants.length;
    if (c.variants.some((v) => v.price !== null)) out.priced += 1;
    if (c.variants.some((v) => v.priced_for_market)) out.priced_in_market += 1;
    else if (c.variants.some((v) => v.price !== null)) out.currency_mismatch += 1;
    if (c.in_stock === true) out.in_stock += 1;
    if (c.merchant) {
      out.with_merchant += 1;
      sellers.add(c.merchant.domain || c.merchant.platform_seller_id || c.merchant.name);
    }
  }
  out.sellers = sellers.size;
  return out;
}

function toolNamesOf(listResult) {
  const msg = jsonRpcMessageOf(listResult);
  const tools = msg && isPlainObject(msg.result) && Array.isArray(msg.result.tools) ? msg.result.tools : [];
  return tools.filter(isPlainObject);
}

/**
 * The lane. One per process (see `defaultLane`); tests build their own with a fake fetch and clock.
 *
 * @param {{ fetchImpl?: Function, now?: () => number, env?: object, logger?: object, profileUrl?: string }} options
 */
function createCafe24CatalogLane(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const envOf = () => options.env || process.env;
  const logger = options.logger || null;
  // The merchant-door transport: createPublicNetworkFetch with MERCHANT_DOOR_RELAY off, the door relay (capped at
  // this lane's per-call budget) with it on. This lane injects its own fetch into the client, so it has to choose here.
  const baseFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : createMerchantDoorFetch(undefined, { timeoutMs: CALL_TIMEOUT_MS });
  // The refusal flush timer. Unref'd, so it never holds the process open; injectable for tests.
  const scheduleTimer = typeof options.setTimer === 'function'
    ? options.setTimer
    : (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; };
  const cancelTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (t) => clearTimeout(t);

  let discovery = null; // { ok, reason, endpoint, checkedAtMs }
  let discoveryInFlight = null;
  let inFlight = 0;
  let windowStartMs = 0;
  let windowCount = 0;
  let consecutiveFailures = 0;
  let breakerUntilMs = 0;
  let breakerMs = 0;
  let refusals = {};
  let refusalsSinceMs = null;
  let refusalTimer = null;

  // A client per call, so the Retry-After of THIS call's answer is read without sharing state across calls.
  // Returns null when the client would carry any credential or signature: the options above should make that
  // impossible, and this check keeps it so if either option is ever dropped.
  function clientFor(observed) {
    const client = createUcpBuyerAgentClient({
      forceAnonymous: true,
      allowTokenTier: false,
      retryAttempts: 0,
      timeoutMs: CALL_TIMEOUT_MS,
      ...(options.profileUrl ? { profileUrl: options.profileUrl } : {}),
      merchantFetchImpl: async (url, init) => {
        const res = await baseFetch(url, init);
        try { observed.retryAfter = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null; } catch { /* ignore */ }
        return res;
      },
    });
    const tier = client.describeTier();
    if (tier.tier !== TRUST_TIER.ANONYMOUS || tier.signs_requests || tier.has_credential || tier.has_client_credentials) {
      return null;
    }
    return client;
  }

  // Only outcomes of a request actually sent move the breaker. A breaker reason counts toward opening it; any
  // other answered outcome (the server replied) resets the count.
  function noteBreaker(outcome, retryAfter) {
    const t = now();
    if (!BREAKER_REASONS.has(outcome.reason)) {
      consecutiveFailures = 0;
      if (outcome.reason === REASON.OK) breakerMs = 0;
      return;
    }
    consecutiveFailures += 1;
    const hinted = retryAfterMs(retryAfter, t);
    if (hinted !== null && hinted > 0) {
      breakerUntilMs = Math.max(breakerUntilMs, t + hinted);
      return;
    }
    if (consecutiveFailures >= BREAKER_FAILURES) {
      breakerMs = breakerMs ? Math.min(breakerMs * 2, BREAKER_MAX_MS) : BREAKER_BASE_MS;
      breakerUntilMs = t + breakerMs;
      consecutiveFailures = 0;
    }
  }

  function takeSlot() {
    const t = now();
    if (t < breakerUntilMs) return REASON.BREAKER_OPEN;
    if (inFlight >= MAX_IN_FLIGHT) return REASON.IN_FLIGHT_CAP;
    if (t - windowStartMs >= 60 * 1000) { windowStartMs = t; windowCount = 0; }
    if (windowCount >= perMinuteCeiling(envOf())) return REASON.LOCAL_RATE_LIMIT;
    windowCount += 1;
    inFlight += 1;
    return null;
  }

  async function runDiscovery() {
    const observed = {};
    const client = clientFor(observed);
    if (!client) return { ok: false, reason: REASON.CREDENTIAL_TIER_REFUSED, sent: false };
    if (!client.describeTier().profile_url) return { ok: false, reason: REASON.NO_PROFILE_URL, sent: false };
    let found;
    try {
      found = await client.discoverEndpoint(CATALOG_ORIGIN);
    } catch (e) {
      return { ok: false, reason: e && e.name === 'AbortError' ? REASON.TIMEOUT : REASON.DISCOVERY_FAILED, sent: true };
    }
    if (!found || !found.businessProfile) {
      return { ok: false, reason: REASON.DISCOVERY_FAILED, http_status: found && found.status, sent: true };
    }
    const endpoint = httpsUrl(found.mcpEndpoint);
    if (endpoint !== PINNED_ENDPOINT) return { ok: false, reason: REASON.ENDPOINT_NOT_PINNED, sent: true };
    const bp = found.businessProfile;
    const ucp = isPlainObject(bp.ucp) ? bp.ucp : bp;
    const versions = [ucp.version, ...(Array.isArray(ucp.supported_versions) ? ucp.supported_versions : [])]
      .map(str).filter(Boolean);
    if (versions.length && !versions.includes(UCP_SPEC_VERSION)) {
      return { ok: false, reason: REASON.UCP_VERSION_UNSUPPORTED, sent: true };
    }
    if (!profileAdvertisesCapability(bp, SEARCH_CAPABILITY)) {
      return { ok: false, reason: REASON.CAPABILITY_NOT_ADVERTISED, sent: true };
    }
    let listed;
    try {
      listed = await client.listTools(endpoint);
    } catch (e) {
      return { ok: false, reason: e && e.name === 'AbortError' ? REASON.TIMEOUT : REASON.TRANSPORT_ERROR, sent: true };
    }
    const listOutcome = classifyListOutcome(listed);
    if (listOutcome) return { ok: false, ...listOutcome, sent: true };
    const search = toolNamesOf(listed).find((t) => t.name === 'search_catalog');
    if (!search) return { ok: false, reason: REASON.TOOL_NOT_LISTED, sent: true };
    const props = isPlainObject(search.inputSchema) && isPlainObject(search.inputSchema.properties)
      ? search.inputSchema.properties : null;
    if (props && !Object.prototype.hasOwnProperty.call(props, 'catalog')) {
      return { ok: false, reason: REASON.SCHEMA_MISMATCH, sent: true };
    }
    return { ok: true, reason: REASON.OK, endpoint, sent: true };
  }

  function classifyListOutcome(listed) {
    const status = Number(listed && listed.status) || 0;
    if (status === 401) return { reason: REASON.HTTP_401, http_status: status };
    if (status === 403) return { reason: REASON.HTTP_403, http_status: status };
    if (status === 429) return { reason: REASON.HTTP_429, http_status: status };
    if (status >= 500) return { reason: REASON.HTTP_5XX, http_status: status };
    const msg = jsonRpcMessageOf(listed);
    if (msg && isPlainObject(msg.error)) {
      const text = errorTextOf(msg.error);
      if (/session/.test(text)) return { reason: REASON.MCP_SESSION_REQUIRED, mcp_error_code: errorCodeOf(msg.error) };
      if (/profile/.test(text)) return { reason: REASON.PROFILE_REFUSED, mcp_error_code: errorCodeOf(msg.error) };
      return { reason: REASON.MCP_ERROR, mcp_error_code: errorCodeOf(msg.error) };
    }
    if (status >= 400) return { reason: REASON.HTTP_4XX, http_status: status };
    if (!msg) return { reason: REASON.UNPARSEABLE };
    return null;
  }

  // Returns the discovery verdict and whether THIS call ran it (`ranNow`). A remembered verdict sent nothing.
  async function ensureDiscovery() {
    const t = now();
    if (discovery) {
      const ttl = discovery.ok ? DISCOVERY_TTL_MS : DISCOVERY_FAILURE_RETRY_MS;
      if (t - discovery.checkedAtMs < ttl) return { ...discovery, ranNow: false };
    }
    if (discoveryInFlight) return { ...(await discoveryInFlight), ranNow: false };
    discoveryInFlight = runDiscovery()
      .catch(() => ({ ok: false, reason: REASON.DISCOVERY_FAILED, sent: true }))
      .then((d) => {
        discovery = { ...d, checkedAtMs: now() };
        discoveryInFlight = null;
        return discovery;
      });
    return { ...(await discoveryInFlight), ranNow: true };
  }

  /**
   * One bounded search. Never throws. Returns { reason, sent, candidates, latency_ms, http_status?, mcp_error_code?,
   * ucp_error_code?, phase? }. `sent` is true only when a request left this process for it. `candidates` is empty
   * unless reason is `ok`. Runs whatever the mode: callers gate on readMode().
   */
  async function search({ query, market, limit } = {}) {
    const started = now();
    const done = (fields, candidates = []) => ({
      sent: false, ...fields, candidates, latency_ms: Math.max(0, now() - started),
    });
    if (truthyFlag(envOf()[DENY_FLAG])) return done({ reason: REASON.DENIED });
    const q = clip(query, MAX_QUERY_LENGTH);
    if (!q) return done({ reason: REASON.NO_QUERY });
    const region = normalizeBuyerRegion(market);
    if (!region) return done({ reason: REASON.NO_MARKET });
    if (!currencyForBuyerRegion(region)) return done({ reason: REASON.MARKET_NOT_PRICED });
    const refused = takeSlot();
    if (refused) return done({ reason: refused });
    try {
      const d = await ensureDiscovery();
      if (!d.ok) {
        const sent = d.ranNow === true && d.sent === true;
        if (sent) noteBreaker(d, null);
        return done({
          reason: d.reason, sent, http_status: d.http_status, mcp_error_code: d.mcp_error_code, phase: 'discovery',
        });
      }
      const pageSize = Math.max(1, Math.min(Number.parseInt(limit, 10) || MAX_RESULTS, MAX_RESULTS));
      const observed = {};
      const client = clientFor(observed);
      if (!client) return done({ reason: REASON.CREDENTIAL_TIER_REFUSED });
      let outcome;
      try {
        const callResult = await client.callTool(d.endpoint, 'search_catalog', {
          catalog: {
            query: q,
            context: { address_country: region },
            pagination: { limit: pageSize },
          },
        }, { retry: false });
        outcome = classifyCallOutcome({ callResult });
      } catch (e) {
        outcome = classifyCallOutcome({ thrown: e });
      }
      noteBreaker(outcome, observed.retryAfter);
      const { payload, ...fields } = outcome;
      if (outcome.reason !== REASON.OK) return done({ ...fields, sent: true });
      const answeredAtMs = now();
      const candidates = payload.products.slice(0, pageSize)
        .map((p) => normalizeCatalogProduct(p, { market: region, answeredAtMs }))
        .filter(Boolean);
      if (payload.products.length && !candidates.length) {
        return done({ ...fields, sent: true, reason: REASON.SCHEMA_MISMATCH });
      }
      return done({ ...fields, sent: true }, candidates);
    } finally {
      inFlight -= 1;
    }
  }

  function info(fields, message) {
    try {
      if (logger && typeof logger.info === 'function') logger.info(fields, message);
    } catch { /* a log failure never reaches the page */ }
  }

  // Refusals (nothing sent) are counted. The first refusal of a window starts a timer that logs the window's counts
  // REFUSAL_LOG_INTERVAL_MS later, so counts are logged at most once per interval and the last window is never lost.
  // If the timer could not be started, the window is logged by the first refusal after it has expired instead (the
  // counts are then held only until the next refusal, never indefinitely while traffic continues).
  function countRefusal(reason) {
    const t = now();
    if (refusalsSinceMs === null) {
      refusalsSinceMs = t;
      try { refusalTimer = scheduleTimer(flushRefusals, REFUSAL_LOG_INTERVAL_MS); } catch { refusalTimer = null; }
    }
    refusals[reason] = (refusals[reason] || 0) + 1;
    if (refusalTimer === null && t - refusalsSinceMs >= REFUSAL_LOG_INTERVAL_MS) flushRefusals();
  }

  function flushRefusals() {
    if (refusalTimer !== null) {
      try { cancelTimer(refusalTimer); } catch { /* ignore */ }
      refusalTimer = null;
    }
    if (refusalsSinceMs === null) return;
    const counts = refusals;
    const windowMs = Math.max(0, now() - refusalsSinceMs);
    refusals = {};
    refusalsSinceMs = null;
    info({ event: 'cafe24_catalog_shadow_refusals', window_ms: windowMs, counts }, 'cafe24 catalog shadow refusals');
  }

  /**
   * SHADOW: run a search beside a served page and log what was learned. Returns a promise that never rejects; the
   * caller does not await it and nothing it learns reaches the page.
   */
  async function observeSearch({ query, market } = {}) {
    if (readMode(envOf()) !== MODES.SHADOW) return { reason: REASON.OFF, sent: false, candidates: [] };
    let result;
    try {
      result = await search({ query, market });
    } catch {
      result = { reason: REASON.TRANSPORT_ERROR, sent: false, candidates: [], latency_ms: null };
    }
    try {
      if (!result.sent) {
        countRefusal(result.reason);
      } else {
        info({
          event: 'cafe24_catalog_shadow',
          reason: result.reason,
          phase: result.phase || 'search',
          latency_ms: result.latency_ms,
          http_status: result.http_status,
          mcp_error_code: safeCode(result.mcp_error_code),
          ucp_error_code: safeCode(result.ucp_error_code),
          market: normalizeBuyerRegion(market) || null,
          ...summarizeCandidates(result.candidates || []),
        }, 'cafe24 catalog shadow search');
      }
    } catch { /* a log failure never reaches the page */ }
    return result;
  }

  function stateForTest() {
    return { inFlight, windowCount, breakerUntilMs, consecutiveFailures, discovery, refusals };
  }

  return { search, observeSearch, flushRefusals, stateForTest };
}

let defaultLaneInstance = null;
function defaultLane(logger) {
  if (!defaultLaneInstance) defaultLaneInstance = createCafe24CatalogLane({ logger });
  return defaultLaneInstance;
}

module.exports = {
  createCafe24CatalogLane,
  defaultLane,
  readMode,
  perMinuteCeiling,
  classifyCallOutcome,
  normalizeCatalogProduct,
  summarizeCandidates,
  parseSseRaw,
  retryAfterMs,
  MODES,
  REASON,
  SOURCE,
  CATALOG_ORIGIN,
  CATALOG_HOST,
  PINNED_ENDPOINT,
  MAX_RESULTS,
  MAX_IN_FLIGHT,
  ALWAYS_BLOCKED,
};
