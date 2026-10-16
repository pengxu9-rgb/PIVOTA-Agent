'use strict';

/*
 * LIVE OFFER READ through the merchant's own UCP catalog (get_offers, decision time).
 *
 * WHY. An offer's price and stock come from our stored crawl. The `get_offers` contract already defines
 * `stock_verified` / `merchant_price_verified` as "Pivota asked the MERCHANT'S own storefront moments ago",
 * and on 2026-10-14 every live offer carried null for both. Shopify stores now serve `lookup_catalog` on
 * their per-store UCP endpoint (`/api/ucp/mcp`, discovered from `/.well-known/ucp`): one call takes up to 10
 * `gid://shopify/ProductVariant/<n>` ids and answers exactly those variants, priced for
 * `context.address_country`, with `availability.available`. 20-store probe 2026-10-14: ~0.8s per call.
 *
 * WHAT IT DOES, per offer this answer returns (at most `maxOffers`, inside `budgetMs`):
 *   - the offer's own variant (execution_spec.variant_id, a numeric Shopify id) plus, when the offer lists
 *     `variants` (one offer per seller listing, pivota-backend #2622), up to 9 more, in ONE lookup;
 *   - for the buyer's DECLARED market only (no market: nothing is read; an undeclared buyer has no price);
 *   - and it trusts the answer only in the market's currency. A store that does not sell to the buyer's
 *     country answers in its own currency without saying so (us.laneige.com: USD for SG and GB; GB on
 *     fentybeauty.com: USD), so a currency mismatch is "this merchant does not price for you", never a price.
 *
 * OUTCOMES (`offer.live_read.status`):
 *   verified          price + stock from the merchant; offer price/currency/in_stock replaced by the live
 *                     values, both flags true, expected_item_total set (the handoff contract: abort if the
 *                     merchant's checkout shows a different total).
 *   currency_mismatch the merchant answered another currency for this market: merchant_price_verified=false,
 *                     price untouched (the stored price may still be an honest referral price elsewhere).
 *   variant_gone      the merchant does not return this variant: stock_verified=false, in_stock=false.
 *   not_ucp / error / timeout / skipped   nothing learned: flags untouched (null = we did not check).
 *
 * MODES (env UCP_LIVE_OFFER_READ): off (default) | shadow | enforce. Shadow reads and LOGS what enforce
 * would have changed (event `get_offers_ucp_live_read`), and returns the offers untouched, so agreement
 * between our stored offers and the merchants can be measured in production before any answer changes.
 *
 * NOT STORED. Results live only in this response and a seconds-long in-memory memo (request coalescing);
 * nothing is written back. Pivota stores its own judgement and reads merchant facts live (2026-10-14).
 */

const { currencyExponent, majorUnitsOf, isRestatedProductId } = require('./merchantVariantSource');
const { unwrapToolPayload } = require('./ucpBuyerAgentClient');

const { currencyForBuyerRegion } = require('../auroraBff/buyerRegion');

const MODES = Object.freeze({ OFF: 'off', SHADOW: 'shadow', ENFORCE: 'enforce' });
const STATUS = Object.freeze({
  VERIFIED: 'verified',
  CURRENCY_MISMATCH: 'currency_mismatch',
  VARIANT_GONE: 'variant_gone',
  NOT_UCP: 'not_ucp',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  SKIPPED: 'skipped',
});
const MAX_IDS_PER_LOOKUP = 10;

function readMode(env = process.env, key = 'UCP_LIVE_OFFER_READ') {
  const v = String(env[key] || '').trim().toLowerCase();
  return v === MODES.SHADOW || v === MODES.ENFORCE ? v : MODES.OFF;
}

function str(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * A Shopify product handle in the one form both sides of a "same product" check are compared in:
 * percent-decoded, NFC, lowercased; letters, marks and digits of any script, `-` and `_`. KR/JP stores
 * name products in Hangul/kana, and their page URLs carry the handle percent-encoded. No captured
 * lookup_catalog answer shows which form its `handle` takes, so the URL's handle and the merchant's
 * answer both pass through here and either form compares equal. Anything else is null (no handle).
 */
function normalizeProductHandle(raw) {
  let h = str(raw);
  try {
    h = decodeURIComponent(h);
  } catch {
    return null; // a malformed escape names no handle
  }
  h = h.normalize('NFC').toLowerCase();
  return /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*$/u.test(h) ? h : null;
}

/**
 * The product handle a store page URL names: /products/<handle>, under an optional Markets locale
 * (/ko, /en-us, /zh-hant) and an optional /collections/<c>, with a `.json`/`.js` suffix dropped. Only
 * the path is read (a query string never matters). Any other path names no product: null.
 */
function productHandleFromUrl(url) {
  let path;
  try {
    path = new URL(str(url)).pathname;
  } catch {
    return null; // not a url
  }
  const m = path.match(/^(?:\/[a-z]{2}(?:-(?:[a-z]{2}|[a-z]{4}))?)?(?:\/collections\/[^/]+)?\/products\/([^/]+?)(?:\.json|\.js)?\/?$/i);
  return m ? normalizeProductHandle(m[1]) : null;
}

function numericVariantId(v) {
  const s = str(v);
  const m = /^(?:gid:\/\/shopify\/ProductVariant\/)?(\d{6,20})$/.exec(s);
  if (m) return m[1];
  return urlNamedVariantId(s);
}

/**
 * The Shopify variant a URL-SHAPED id names through `variant=N`, or null. Stored seed entries routinely
 * carry the JSON-LD offer `@id` as their `variant_id` (`/products/<handle>?variant=45253610242298#offer`),
 * so a reader that took only a gid or bare digits never saw those variants: the offer's options came
 * back unread (price null after a live-verified swap, gw#2451's golden cross-test) and a named variant
 * never matched its offer. The rules are pivota-backend's `url_named_variant_id`
 * (services/handover_variant_identity.py, #2627), so both sides name the same variant:
 *   - every `variant=` value is ASCII digits (here also 6-20 of them, as the bare form), and exactly one
 *     distinct value, or the URL names nothing;
 *   - a `selling_plan` makes it a SUBSCRIPTION offer of the variant, priced at the plan: nothing.
 */
function urlNamedVariantId(raw) {
  const s = str(raw);
  if (!s.includes('variant=')) return null;
  // The WHATWG parser silently strips tab/newline inside a URL (`?variant=4525\n3610242298` would parse
  // here and not in Python's urlparse): a control character names nothing, on both sides.
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  let params;
  try {
    params = new URL(s, 'https://variant.invalid').searchParams;
  } catch {
    return null;
  }
  if (params.has('selling_plan')) return null;
  const values = params.getAll('variant');
  if (!values.length || values.some((v) => !/^[0-9]+$/.test(v))) return null;
  const distinct = [...new Set(values)];
  return distinct.length === 1 && /^\d{6,20}$/.test(distinct[0]) ? distinct[0] : null;
}

function variantGid(numericId) {
  return `gid://shopify/ProductVariant/${numericId}`;
}

function hostOf(offer) {
  const spec = (offer && offer.execution_spec) || {};
  const raw = str(spec.merchant_domain) || str(offer && offer.merchant_id);
  const host = raw.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

/**
 * The ids one lookup asks for: the offer's own variant first, then listed options, at most 10, numeric
 * only. NONE when the offer names no numeric variant of its own: the first listed option is another
 * shade, and pricing the offer from it would stamp a different variant's price and stock as verified.
 */
/**
 * The product page a URL-SHAPED variant id itself names (`/products/<h>?variant=N#offer`), or null for a
 * bare or gid id. A relative id is read against a placeholder origin: only its path matters.
 */
function variantIdProductHandle(id) {
  const s = str(id);
  if (!s.includes('/products/')) return null;
  try {
    return productHandleFromUrl(new URL(s, 'https://variant.invalid').href);
  } catch {
    return null;
  }
}

/**
 * May this live answer price a variant stored under `id`? Only an answer for the SAME product page the
 * read's own variant was answered under (`ownHandle`), and never for an id whose own URL names another
 * product's page. A merchant answers any variant number it has, whichever product it belongs to: matched by
 * number alone, an option stored as another product's offer @id took that product's price (controller
 * review of #2453). No handle on either side: not this product's, by default.
 */
function liveAnswerIsSameProduct(live, id, ownHandle) {
  if (!live || !ownHandle || live.handle !== ownHandle) return false;
  const named = variantIdProductHandle(id);
  return !named || named === ownHandle;
}

/** The product handle of a product's own store page (the URLs `productHost` reads), or null. */
function productPageHandle(product) {
  for (const key of ['destination_url', 'external_redirect_url', 'source_url', 'merchant_canonical_url', 'canonical_url']) {
    const handle = productHandleFromUrl(product && product[key]);
    if (handle) return handle;
  }
  return null;
}

/** The product handle of the store page a FLAGGED offer points at (its seed's canonical/destination url). */
function flaggedOfferHandle(offer) {
  const src = (offer && offer.source) || {};
  for (const raw of [src.canonical_url, src.destination_url, offer && offer.url]) {
    const handle = productHandleFromUrl(raw);
    if (handle) return handle;
  }
  return null;
}

function lookupIdsFor(offer) {
  const spec = (offer && offer.execution_spec) || {};
  // An offer returned FLAGGED `requires_live_verification` (pivota-backend #2629) has no cart, so no
  // `execution_spec.variant_id`; the backend names the variant its stored entry is instead.
  const flag = offer && offer.requires_live_verification;
  const own = numericVariantId(spec.variant_id)
    || (flag && typeof flag === 'object' ? numericVariantId(flag.lookup_variant_id) : null);
  if (!own) return [];
  const ids = [];
  const add = (v) => {
    const n = numericVariantId(v);
    if (n && !ids.includes(n) && ids.length < MAX_IDS_PER_LOOKUP) ids.push(n);
  };
  add(own);
  for (const v of Array.isArray(offer && offer.variants) ? offer.variants : []) add(v && v.variant_id);
  return ids;
}

/**
 * A lookup_catalog answer: { error, variants: Map<id, {amount, currency, available}>, notFound: Set<id> }.
 *
 * `notFound` is what the merchant SAYS it does not have: Shopify answers a missing id with
 * `messages: [{ type: 'info', code: 'not_found', content: 'gid://shopify/ProductVariant/<n>' }]` (live,
 * rarebeauty.com 2026-10-14). Only that is evidence a variant is gone. Any other answer that lacks a variant
 * -- a rate limit or error carried in a 200 (`ucp.status: 'error'`, an `error` message) -- is `error`.
 */
function parseLookup(payload) {
  const out = { error: false, variants: new Map(), notFound: new Set() };
  if (!payload || typeof payload !== 'object') {
    out.error = true;
    return out;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if ((payload.ucp && payload.ucp.status === 'error') || messages.some((m) => m && m.type === 'error')) out.error = true;
  for (const m of messages) {
    if (!m || m.code !== 'not_found') continue;
    for (const match of String(m.content || '').matchAll(/ProductVariant\/(\d{6,20})/g)) out.notFound.add(match[1]);
  }
  out.variants = liveVariantsFrom(payload);
  return out;
}

/** variant numeric id -> { amount, currency, available } from a lookup_catalog payload. */
function liveVariantsFrom(payload) {
  const out = new Map();
  for (const product of Array.isArray(payload && payload.products) ? payload.products : []) {
    const handle = normalizeProductHandle(product && product.handle); // the form the page URL's handle is read in
    for (const v of Array.isArray(product && product.variants) ? product.variants : []) {
      const id = numericVariantId(v && v.id);
      if (!id) continue;
      const money = majorUnitsOf(v.price);
      const available = v.availability && typeof v.availability.available === 'boolean' ? v.availability.available : null;
      out.set(id, {
        amount: money ? money.amount : null,
        currency: str(v.price && v.price.currency).toUpperCase() || null,
        available,
        handle,
      });
    }
  }
  return out;
}

/** True when a cart permalink pins its checkout to `country` (`country=<CC>`, pivota-backend #2622). */
function cartPinnedTo(cartUrl, country) {
  const url = str(cartUrl);
  if (!url || !/^[A-Z]{2}$/.test(str(country))) return false;
  try {
    return new URL(url).searchParams.get('country') === country;
  } catch {
    return false;
  }
}

function roundTo(amount, currency) {
  const exp = currencyExponent(currency);
  if (exp === null) return amount;
  const f = 10 ** exp;
  return Math.round(amount * f) / f;
}

/**
 * Discovery + lookup shared by the offer and product readers: one endpoint memo per host (an hour; a host
 * with no UCP endpoint, 10 minutes) and a lookup memo that only coalesces (seconds).
 */
// At most this many merchant lookups in flight per process, across every reader and request; the rest
// wait their turn (each still bounded by its caller's deadline).
const MAX_CONCURRENT_LOOKUPS = 16;

// A discovery that failed to get an ANSWER (429, 5xx, unanswered, a thrown network error or timeout) is not
// cached as `not_ucp`; it is remembered for this long so a struggling store's /.well-known is not asked again
// by every page meanwhile. It surfaces as the same error it was.
const DISCOVERY_FAILURE_TTL_MS = 60 * 1000;

function createLookupCore({
  ucpClient, now, endpointTtlMs, memoTtlMs, maxConcurrent = MAX_CONCURRENT_LOOKUPS, endpointCache, discoveryInFlight, maxPerHost,
  discoveryFailures, discoveryFailureTtlMs = DISCOVERY_FAILURE_TTL_MS, log,
}) {
  const logLine = typeof log === 'function' ? (event, fields) => { try { log(event, fields); } catch { /* never costs a read */ } } : () => {};
  // PER-STORE cap (optional): at most `maxPerHost` lookups to one merchant host in flight from this core.
  // One over it is REFUSED at once (code `host_busy`), never queued: a burst of pages for one store
  // (a bot sweeping its catalogue) must not stack on it, and a read that does not happen is only
  // "not checked".
  const perHostCap = Number.isInteger(maxPerHost) && maxPerHost > 0 ? maxPerHost : null;
  const hostInFlight = new Map(); // host -> count
  const negativeEndpointTtlMs = 10 * 60 * 1000;
  let inFlight = 0;
  const waiting = []; // { resolve, reject, at }
  // A waiter older than any caller's budget has already given up: it is refused, never run (it would take
  // a slot for an answer nobody reads). A full queue refuses at once (review round 3 of #2438).
  const MAX_WAIT_MS = 3000;
  const MAX_QUEUE = 200;
  function release() {
    inFlight -= 1;
    while (waiting.length) {
      const next = waiting.shift();
      if (now() - next.at <= MAX_WAIT_MS) {
        inFlight += 1;
        next.resolve();
        return;
      }
      next.reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }
  }
  async function withSlot(run, deadline) {
    if (inFlight >= maxConcurrent) {
      if (waiting.length >= MAX_QUEUE) throw Object.assign(new Error('lookup_queue_full'), { code: 'timeout' });
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, at: now() };
        waiting.push(entry);
        // A caller with its own deadline gives up its place at that deadline, not at MAX_WAIT_MS.
        if (Number.isFinite(deadline)) {
          const t = setTimeout(() => {
            const i = waiting.indexOf(entry);
            if (i >= 0) {
              waiting.splice(i, 1);
              reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
            }
          }, Math.max(1, deadline - now()));
          if (typeof t.unref === 'function') t.unref();
          const settle = entry.resolve;
          entry.resolve = () => { clearTimeout(t); settle(); };
        }
      });
    } else {
      inFlight += 1;
    }
    try {
      return await run();
    } finally {
      release();
    }
  }
  // Cores may share discovery (the endpoint memo and the in-flight discoveries) while each keeps its own
  // lookup pool: get_offers, get_product and search each have one (review round 2 of #2439).
  const endpoints = endpointCache instanceof Map ? endpointCache : new Map(); // host -> { endpoint|null, until }
  const memo = new Map(); // `${host}|${country}|${ids}` -> { promise, until }

  // host -> in-flight discovery promise (concurrent callers share it, across cores when shared)
  const discovering = discoveryInFlight instanceof Map ? discoveryInFlight : new Map();

  // host -> { code, message, status, until }: the last transient discovery failure (shared when given)
  const failures = discoveryFailures instanceof Map ? discoveryFailures : new Map();

  function failureError(f) {
    return Object.assign(new Error(f.message), { code: f.code, ...(f.status !== undefined ? { status: f.status } : {}), cached: true });
  }

  function endpointFor(host) {
    const hit = endpoints.get(host);
    if (hit && hit.until > now()) return Promise.resolve(hit.endpoint);
    if (discovering.has(host)) return discovering.get(host);
    const failed = failures.get(host);
    if (failed && failed.until > now()) {
      // Counted on the shared entry: the reads this failure withheld, across every core sharing it.
      failed.hits = (failed.hits || 0) + 1;
      return Promise.reject(failureError(failed));
    }
    if (failed) {
      failures.delete(host);
      // One line per remembered failure, when it lapses: how many reads it withheld from this store.
      logLine('ucp_live_discovery_failure_lapsed', { host, code: failed.code, status: failed.status ?? null, reads_withheld: failed.hits || 0 });
    }
    const p = discover(host)
      .catch((e) => {
        if (discoveryFailureTtlMs > 0) {
          failures.delete(host);
          failures.set(host, {
            code: (e && e.code) || 'discovery_error',
            message: String((e && e.message) || 'discovery_error').slice(0, 80),
            status: e && Number.isFinite(Number(e.status)) ? Number(e.status) : undefined,
            until: now() + discoveryFailureTtlMs,
          });
          if (failures.size > 5000) failures.delete(failures.keys().next().value);
          logLine('ucp_live_discovery_failure_cached', {
            host,
            code: (e && e.code) || 'discovery_error',
            status: e && Number.isFinite(Number(e.status)) ? Number(e.status) : null,
            ttl_s: Math.round(discoveryFailureTtlMs / 1000),
          });
        }
        throw e;
      })
      .finally(() => discovering.delete(host));
    discovering.set(host, p);
    return p;
  }

  async function discover(host) {
    // A failure to ASK is not an answer: a timeout, a network error, a 429 or a 5xx is not cached (it would
    // report a UCP store as `not_ucp` for 10 minutes) and surfaces as `error`. Only a store that answered
    // without a UCP endpoint (404, a profile with no MCP service) is remembered as one.
    const d = await ucpClient.discoverEndpoint(`https://${host}`);
    const status = Number(d && d.status);
    const endpoint = (d && d.mcpEndpoint) || null;
    if (!endpoint && (status === 429 || status >= 500 || !Number.isFinite(status))) {
      throw Object.assign(new Error(`discovery_${Number.isFinite(status) ? status : 'unanswered'}`), {
        code: 'discovery_transient',
        ...(Number.isFinite(status) ? { status } : {}),
      });
    }
    endpoints.set(host, { endpoint, until: now() + (endpoint ? endpointTtlMs : negativeEndpointTtlMs) });
    if (endpoints.size > 5000) endpoints.delete(endpoints.keys().next().value);
    return endpoint;
  }

  /** One lookup per (host, country, ids) at a time: concurrent callers share the in-flight promise. */
  function lookup(host, endpoint, ids, country, { deadline, retried = false } = {}) {
    const key = `${host}|${country}|${ids.join(',')}`;
    const hit = memo.get(key);
    if (hit && hit.until > now()) {
      if (retried || !Number.isFinite(deadline)) return hit.promise;
      // The shared promise may still be QUEUED for a slot under another caller's earlier deadline. When it
      // gives up on that deadline, this caller, whose own has not passed, asks once more on its own
      // (review round 2 of #2439). The memo entry is gone by then: its own catch runs first.
      return hit.promise.catch((e) => {
        if (e && e.code === 'timeout' && deadline > now()) return lookup(host, endpoint, ids, country, { deadline, retried: true });
        throw e;
      });
    }
    if (perHostCap !== null && (hostInFlight.get(host) || 0) >= perHostCap) {
      return Promise.reject(Object.assign(new Error('host_busy'), { code: 'host_busy' }));
    }
    if (perHostCap !== null) hostInFlight.set(host, (hostInFlight.get(host) || 0) + 1);
    const promise = withSlot(async () => {
      const res = await ucpClient.lookupCatalog(endpoint, {
        ids: ids.map(variantGid),
        context: { address_country: country },
      });
      if (!res || res.error || !res.ok) {
        const err = new Error('lookup_failed');
        err.status = res && res.status;
        throw err;
      }
      return unwrapToolPayload(res);
    }, deadline);
    if (perHostCap !== null) {
      const done = () => {
        const n = (hostInFlight.get(host) || 1) - 1;
        if (n > 0) hostInFlight.set(host, n);
        else hostInFlight.delete(host);
      };
      promise.then(done, done);
    }
    memo.set(key, { promise, until: now() + memoTtlMs });
    promise.catch(() => {
      if (memo.get(key) && memo.get(key).promise === promise) memo.delete(key);
    });
    if (memo.size > 2000) memo.delete(memo.keys().next().value);
    return promise;
  }

  /** True when a lookup for exactly these ids is memoized and live: asking again sends nothing. */
  function isInFlight(host, ids, country) {
    const hit = memo.get(`${host}|${country}|${ids.join(',')}`);
    return Boolean(hit && hit.until > now());
  }

  /** Room for `n` more lookups to `host` under the per-store cap (always, when uncapped). */
  function hostHasRoom(host, n = 1) {
    return perHostCap === null || (hostInFlight.get(host) || 0) + n <= perHostCap;
  }

  return { endpointFor, lookup, hostHasRoom, isInFlight, endpoints, memo, discoveryFailures: failures, stats: () => ({ inFlight, waiting: waiting.length, hostsInFlight: hostInFlight.size }) };
}

function withDeadline(promise, deadline, now) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error('timeout'), { code: 'timeout' })),
      Math.max(1, deadline - now()),
    );
    if (typeof t.unref === 'function') t.unref();
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * @param {{
 *   ucpClient: { discoverEndpoint: Function, lookupCatalog: Function },
 *   mode?: string,               // off | shadow | enforce (default: env UCP_LIVE_OFFER_READ)
 *   maxOffers?: number,          // offers read per answer (default 3)
 *   budgetMs?: number,           // whole-answer budget (default 3000)
 *   endpointTtlMs?: number,      // discovery memo (default 1h); a host with no UCP endpoint: 10 min
 *   memoTtlMs?: number,          // lookup memo, request coalescing only (default 30s)
 *   expectedTotalTtlMs?: number, // how long expected_item_total is offered as valid (default 10 min)
 *   now?: () => number,
 *   log?: (event: string, fields: object) => void,
 * }} deps
 */
function createUcpLiveOfferReader(deps = {}) {
  const { ucpClient } = deps;
  if (!ucpClient || typeof ucpClient.discoverEndpoint !== 'function' || typeof ucpClient.lookupCatalog !== 'function') {
    throw new Error('createUcpLiveOfferReader requires a ucp client with discoverEndpoint() and lookupCatalog()');
  }
  const mode = deps.mode || readMode();
  const maxOffers = Number.isInteger(deps.maxOffers) ? deps.maxOffers : 3;
  // 3s: a cold host (discovery + lookup) measured 0.8-2.6s from a laptop, 2026-10-14; warm ~0.8s.
  const budgetMs = Number.isFinite(deps.budgetMs) ? deps.budgetMs : 3000;
  const endpointTtlMs = Number.isFinite(deps.endpointTtlMs) ? deps.endpointTtlMs : 60 * 60 * 1000;
  const memoTtlMs = Number.isFinite(deps.memoTtlMs) ? deps.memoTtlMs : 30 * 1000;
  const expectedTotalTtlMs = Number.isFinite(deps.expectedTotalTtlMs) ? deps.expectedTotalTtlMs : 10 * 60 * 1000;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  const core = deps.core || createLookupCore({ ucpClient, now, endpointTtlMs, memoTtlMs });
  const { endpointFor, lookup } = core;

  /** The live read of one offer: { status, live?, liveVariants? }. Never throws. */
  async function readOne(offer, { country, currency, deadline }) {
    const host = hostOf(offer);
    const ids = lookupIdsFor(offer);
    if (!host || ids.length === 0) return { status: STATUS.SKIPPED, reason: !host ? 'no_host' : 'no_variant_id' };
    const remaining = () => deadline - now();
    const race = (p) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), Math.max(1, remaining()));
        if (typeof t.unref === 'function') t.unref();
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
      });
    try {
      if (remaining() <= 0) return { status: STATUS.TIMEOUT };
      const endpoint = await race(endpointFor(host));
      if (!endpoint) return { status: STATUS.NOT_UCP, host };
      const parsed = parseLookup(await race(lookup(host, endpoint, ids, country)));
      // An answer that says it failed is not believed, whatever variants it also carries.
      if (parsed.error) return { status: STATUS.ERROR, host, reason: 'merchant_error' };
      const liveVariants = parsed.variants;
      const own = liveVariants.get(ids[0]);
      if (!own) {
        if (parsed.notFound.has(ids[0])) return { status: STATUS.VARIANT_GONE, host, liveVariants };
        return { status: STATUS.ERROR, host, reason: 'variant_not_answered' };
      }
      if (offer && offer.requires_live_verification) {
        // A FLAGGED offer's link was not re-checked either (destination_stale / never_verified): the
        // variant must belong to the product the offer's page names, or it is another product's.
        const want = flaggedOfferHandle(offer);
        if (!want || !own.handle) return { status: STATUS.ERROR, host, reason: 'handle_unknown' };
        if (own.handle !== want) return { status: STATUS.ERROR, host, reason: 'other_product' };
      }
      if (own.currency && own.currency !== currency) {
        return { status: STATUS.CURRENCY_MISMATCH, host, live: own, liveVariants };
      }
      if (own.amount === null || own.available === null || !own.currency) return { status: STATUS.ERROR, host, reason: 'unreadable_variant' };
      return { status: STATUS.VERIFIED, host, live: own, liveVariants };
    } catch (e) {
      return { status: e && e.code === 'timeout' ? STATUS.TIMEOUT : STATUS.ERROR, host, reason: str(e && e.message).slice(0, 80) };
    }
  }

  /** The offer as enforce serves it, from the stored offer and one read. Pure. */
  function applyRead(offer, read, { currency, country }) {
    const out = {
      ...offer,
      live_read: { status: read.status, source: 'merchant_ucp_lookup_catalog', checked_at: new Date(now()).toISOString() },
    };
    const spec = { ...(offer.execution_spec || {}) };
    const clearExpected = () => {
      for (const k of ['expected_item_total', 'expected_currency', 'expected_quantity', 'expected_total_expires_at']) delete spec[k];
      out.execution_spec = spec;
    };
    if (read.status === STATUS.VERIFIED) {
      const { amount, available } = read.live;
      const price = roundTo(amount, currency);
      if (Number.isFinite(Number(offer.price)) && Number(offer.price) !== price) {
        out.live_read.stored_price = Number(offer.price);
      }
      out.price = price;
      out.currency = currency;
      out.in_stock = available;
      delete out.availability;
      out.stock_verified = true;
      out.merchant_price_verified = true;
      out.price_source = 'merchant_live';
      // THE TOTAL A CHECKOUT MUST SHOW, offered only when the cart the buyer follows is PINNED to this
      // market (`country=<CC>`, pivota-backend #2622). An unpinned cart prices by the session's geolocation,
      // and the get_offers contract tells the agent to abort a handoff whose total differs -- so a total in
      // the market's currency beside an unpinned cart would abort or mislead.
      if (cartPinnedTo(spec.cart_url, country)) {
        Object.assign(spec, {
          expected_item_total: price,
          expected_currency: currency,
          expected_quantity: 1,
          expected_total_expires_at: new Date(now() + expectedTotalTtlMs).toISOString(),
        });
        out.execution_spec = spec;
      } else {
        clearExpected();
        out.live_read.expected_total_withheld = spec.cart_url ? 'cart_not_pinned_to_market' : 'no_cart';
      }
    } else if (read.status === STATUS.CURRENCY_MISMATCH) {
      out.merchant_price_verified = false;
      out.live_read.merchant_currency = read.live && read.live.currency;
      clearExpected();
    } else if (read.status === STATUS.VARIANT_GONE) {
      // We asked, and the merchant said it does not have it: a CHECKED out-of-stock.
      out.stock_verified = true;
      out.in_stock = false;
      delete out.availability;
      clearExpected();
    }
    if (read.liveVariants && Array.isArray(offer.variants) && read.status !== STATUS.CURRENCY_MISMATCH) {
      // An option is priced only from an answer on the product page the offer's own variant was answered on.
      const ownHandle = read.live && read.live.handle ? read.live.handle : null;
      out.variants = offer.variants.map((v) => {
        const live = read.liveVariants.get(numericVariantId(v && v.variant_id));
        if (!live || live.currency !== currency || live.amount === null || live.available === null) return v;
        if (!liveAnswerIsSameProduct(live, v && v.variant_id, ownHandle)) return v;
        return { ...v, price: roundTo(live.amount, currency), currency, in_stock: live.available, live_verified: true };
      });
    }
    if (offer.requires_live_verification && Array.isArray(out.variants)) {
      // A flagged offer's options are the stale read: only what the merchant just answered keeps a price.
      out.variants = out.variants.map((v) => (v && v.live_verified ? v : { ...v, price: null, currency: null, in_stock: null }));
    }
    return out;
  }

  /**
   * @param {object[]} offers  the offers this answer returns (backend offers.resolve shape)
   * @param {{ market?: string, currency?: string }} ctx  the buyer's DECLARED market and its currency
   * @returns {Promise<{ offers: object[], stats: object|null }>}
   */
  async function readOffers(offers, ctx = {}) {
    const list = Array.isArray(offers) ? offers : [];
    const country = str(ctx.market).toUpperCase();
    const currency = str(ctx.currency).toUpperCase();
    if (mode === MODES.OFF || !list.length || !/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) {
      return { offers: list, stats: null };
    }
    if (mode === MODES.SHADOW) {
      // Shadow never touches the answer: not its latency (the read runs after the answer is returned) and
      // not its content (no stats in it). The comparison exists only in the log.
      readAndLog(list, { country, currency }).catch(() => {});
      return { offers: list, stats: null };
    }
    const { reads, stats } = await readAndLog(list, { country, currency });
    const applied = list.map((o, i) => (i < reads.length ? applyRead(o, reads[i], { currency, country }) : o));
    return { offers: applied, stats };
  }

  async function readAndLog(list, { country, currency }) {
    const deadline = now() + budgetMs;
    const targets = list.slice(0, Math.max(0, maxOffers));
    const reads = await Promise.all(targets.map((o) => readOne(o, { country, currency, deadline })));
    const stats = { mode, market: country, currency, read: reads.length, by_status: {}, price_changed: 0, stock_changed: 0 };
    reads.forEach((r, i) => {
      stats.by_status[r.status] = (stats.by_status[r.status] || 0) + 1;
      if (r.status === STATUS.VERIFIED) {
        const o = targets[i];
        if (Number(o.price) !== roundTo(r.live.amount, currency)) stats.price_changed += 1;
        const storedStock = o.in_stock === true ? true : o.in_stock === false ? false : null;
        if (storedStock !== r.live.available) stats.stock_changed += 1;
      }
    });
    log('get_offers_ucp_live_read', {
      ...stats,
      hosts: reads.map((r, i) => ({ host: r.host || hostOf(targets[i]), status: r.status, ...(r.reason ? { reason: r.reason } : {}) })),
    });
    return { reads, stats };
  }

  return { mode, readOffers, applyRead, _caches: { endpoints: core.endpoints, memo: core.memo } };
}

/*
 * LIVE PRODUCT READ (get_product, the PDP's variants). Same source and rules as the offer read: the
 * merchant's own `lookup_catalog`, trusted only in the market's currency, nothing stored.
 *
 * WHY. A product page's variant prices and stock come from our stored rows through the gateway's own-money
 * read, and it can say the opposite of the merchant: us.laneige.com Lip Sleeping Mask served all 15 flavours
 * `current_own_offer_status: unavailable` with no price (2026-10-14), while the merchant's lookup answered
 * Berry in stock at $24.
 *
 * MARKET. Only the market the caller declares (ADR-026: a market is data, never inferred from a listing's
 * currency). No declared market, no live read (`no_market`).
 *
 * PER VARIANT (`variant.live_read.status`):
 *   verified   price.current and availability.in_stock replaced by the merchant's; the gateway's own-money
 *              verdict (`current_own_offer_status`) is dropped, being a statement about our stored row
 *              that the merchant's answer supersedes.
 *   gone       looked up, and the merchant's answer for the same request lists other variants but not
 *              this one: availability.in_stock false.
 * PRODUCT (`product.live_read`): { status, market, checked, verified, gone, checked_at }; the product
 * price/currency/availability follow the default variant's live answer when it has one.
 * currency_mismatch, not_ucp, timeout and error change nothing.
 */
const MAX_PRODUCT_VARIANT_IDS = 30;

/** An availability object with the merchant's live flag, and no stored quantity left to contradict it. */
function withLiveStock(availability, inStock) {
  const { available_quantity: _staleQuantity, ...rest } = availability && typeof availability === 'object' ? availability : {};
  return { ...rest, in_stock: inStock };
}

/**
 * A result whose commerce the PDP DELIBERATELY blocked: pdpBuilder's `commerceSuppressed` (non-merch, a dead
 * page's `source_unavailable_v1` hold, `transaction_ready: false`) ships no actions and
 * `availability: { in_stock: false, available_quantity: 0 }`. A live answer must never un-block it.
 */
function commerceBlocked(result, product) {
  // pdpBuilder's own verdict, carried on the product (the get_product detail normalizer keeps `product`
  // only): the one marker the real path delivers (review round 3 of #2438).
  if (product && product.commerce_suppressed === true) return true;
  if (result && Array.isArray(result.actions) && result.actions.length === 0) return true;
  if (product && product.transaction_ready === false) return true;
  if (product && product.source_unavailable_v1) return true;
  return false;
}

/** Caller-supplied log fields (scalars only, short keys): never objects, URLs or free text. */
function logFieldsOf(ctx) {
  const fields = ctx && ctx.logFields && typeof ctx.logFields === 'object' ? ctx.logFields : {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v)) out[k] = v;
  }
  return out;
}

function productTarget(result) {
  if (!result || typeof result !== 'object') return null;
  return result.product && typeof result.product === 'object' ? result.product : result;
}

function productHost(product) {
  for (const key of ['destination_url', 'external_redirect_url', 'source_url', 'merchant_canonical_url']) {
    const raw = str(product && product[key]);
    if (!/^https?:\/\//i.test(raw)) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !/(^|\.)pivota\.cc$/.test(host)) return host;
    } catch {
      /* not a url */
    }
  }
  return null;
}

function productVariantIds(product) {
  const ids = [];
  const add = (v) => {
    const n = numericVariantId(v);
    if (n && !ids.includes(n) && ids.length < MAX_PRODUCT_VARIANT_IDS) ids.push(n);
  };
  add(product && product.default_variant_id);
  for (const v of Array.isArray(product && product.variants) ? product.variants : []) add(v && v.variant_id);
  return ids;
}

function productCurrency(product) {
  const direct = str(product && product.currency).toUpperCase();
  if (direct) return direct;
  for (const v of Array.isArray(product && product.variants) ? product.variants : []) {
    const c = str(v && v.price && v.price.current && v.price.current.currency).toUpperCase();
    if (c) return c;
  }
  return '';
}

/**
 * @param {{ ucpClient, mode?, budgetMs?, endpointTtlMs?, memoTtlMs?, now?, log? }} deps
 *   mode defaults to env UCP_LIVE_PRODUCT_READ (off | shadow | enforce).
 */
function createUcpLiveProductReader(deps = {}) {
  const { ucpClient } = deps;
  if (!ucpClient || typeof ucpClient.discoverEndpoint !== 'function' || typeof ucpClient.lookupCatalog !== 'function') {
    throw new Error('createUcpLiveProductReader requires a ucp client with discoverEndpoint() and lookupCatalog()');
  }
  const mode = deps.mode || readMode(process.env, 'UCP_LIVE_PRODUCT_READ');
  // The log line's name: the agent get_product read by default; the frontend PDP shadow names its own.
  const event = typeof deps.event === 'string' && deps.event ? deps.event : 'get_product_ucp_live_read';
  const budgetMs = Number.isFinite(deps.budgetMs) ? deps.budgetMs : 3000;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const core = deps.core || createLookupCore({
    ucpClient,
    now,
    endpointTtlMs: Number.isFinite(deps.endpointTtlMs) ? deps.endpointTtlMs : 60 * 60 * 1000,
    memoTtlMs: Number.isFinite(deps.memoTtlMs) ? deps.memoTtlMs : 30 * 1000,
  });

  /** { status, country, currency, host, live: Map, askedIds } — never throws. */
  async function readLive(product, ctx) {
    const declared = str(ctx && ctx.market).toUpperCase();
    const homeCurrency = productCurrency(product);
    if (declared && !(/^[A-Z]{2}$/.test(declared) && currencyForBuyerRegion(declared))) {
      // A market the caller named and Pivota does not price is not quietly swapped for another one
      // (get_offers answers the same input `market_not_priced`).
      return { status: STATUS.SKIPPED, reason: 'market_not_priced', basis: 'declared' };
    }
    // ADR-026: a market is data the buyer states, never inferred from a listing's currency (a USD price may
    // only mean the crawl's US vantage). No declared market, no live read.
    if (!declared) return { status: STATUS.SKIPPED, reason: 'no_market' };
    const basis = 'declared';
    const country = declared;
    const currency = currencyForBuyerRegion(declared);
    const host = productHost(product);
    const ids = productVariantIds(product);
    if (!host || !ids.length) return { status: STATUS.SKIPPED, reason: !host ? 'no_host' : 'no_variant_id', country, currency, basis };
    const allVariants = Array.isArray(product.variants) ? product.variants : [];
    const allVariantIds = allVariants.map((v) => numericVariantId(v && v.variant_id));
    if (currency !== homeCurrency && homeCurrency && (allVariants.length > ids.length || allVariantIds.some((id) => !id))) {
      // Re-pricing in another currency must cover EVERY variant, or the page would mix currencies.
      return { status: STATUS.SKIPPED, reason: 'too_many_variants_to_reprice', country, currency, basis };
    }
    const deadline = now() + budgetMs;
    try {
      const endpoint = await withDeadline(core.endpointFor(host), deadline, now);
      if (!endpoint) return { status: STATUS.NOT_UCP, host, country, currency, basis };
      const chunks = [];
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_LOOKUP) chunks.push(ids.slice(i, i + MAX_IDS_PER_LOOKUP));
      // A capped core: the whole product's NEW sends fit, or none is sent (half a read is a wasted
      // request). A chunk already in flight (a second viewer of the same product) shares that lookup
      // and sends nothing, so it does not count (review round 2 of #2446).
      const sends = typeof core.isInFlight === 'function'
        ? chunks.filter((chunk) => !core.isInFlight(host, chunk, country)).length
        : chunks.length;
      if (sends > 0 && typeof core.hostHasRoom === 'function' && !core.hostHasRoom(host, sends)) {
        return { status: STATUS.SKIPPED, reason: 'host_busy', host, country, currency, basis };
      }
      const payloads = await withDeadline(
        Promise.all(chunks.map((chunk) => core.lookup(host, endpoint, chunk, country))),
        deadline,
        now,
      );
      const live = new Map();
      const notFound = new Set();
      for (const payload of payloads) {
        const parsed = parseLookup(payload);
        if (parsed.error) return { status: STATUS.ERROR, host, country, currency, basis, reason: 'merchant_error' };
        for (const [id, v] of parsed.variants) live.set(id, v);
        for (const id of parsed.notFound) notFound.add(id);
      }
      if (live.size === 0) {
        if (notFound.size) return { status: STATUS.VARIANT_GONE, host, country, currency, basis, live, notFound, askedIds: ids };
        return { status: STATUS.ERROR, host, country, currency, basis, reason: 'nothing_answered' };
      }
      if (currency !== homeCurrency && homeCurrency) {
        // Re-pricing into ANOTHER currency needs a priced, stocked answer for EVERY variant; one variant left
        // at its stored price would make a mixed-currency page (review round 3 of #2438).
        const complete = allVariantIds.every((id) => {
          const v = live.get(id);
          return v && v.currency === currency && v.amount !== null && v.available !== null;
        });
        if (!complete) return { status: STATUS.SKIPPED, reason: 'incomplete_reprice', host, country, currency, basis };
      }
      const answeredCurrencies = new Set([...live.values()].map((v) => v.currency).filter(Boolean));
      if (answeredCurrencies.size !== 1 || !answeredCurrencies.has(currency)) {
        return { status: STATUS.CURRENCY_MISMATCH, host, country, currency, basis, merchantCurrency: [...answeredCurrencies].join(',') };
      }
      return { status: STATUS.VERIFIED, host, country, currency, basis, live, notFound, askedIds: ids };
    } catch (e) {
      if (e && e.code === 'host_busy') return { status: STATUS.SKIPPED, reason: 'host_busy', host, country, currency, basis };
      return { status: e && e.code === 'timeout' ? STATUS.TIMEOUT : STATUS.ERROR, host, country, currency, basis, reason: str(e && e.message).slice(0, 80) };
    }
  }

  /** The product as enforce serves it, from the stored product and one read. Pure: returns a copy. */
  function applyProductRead(product, read) {
    const checkedAt = new Date(now()).toISOString();
    const out = { ...product };
    const summary = {
      status: read.status,
      market: read.country || null,
      market_basis: read.basis || null,
      ...(read.reason ? { reason: read.reason } : {}),
      source: 'merchant_ucp_lookup_catalog',
      checked_at: checkedAt,
    };
    if (read.status === STATUS.CURRENCY_MISMATCH) summary.merchant_currency = read.merchantCurrency;
    if (read.status !== STATUS.VERIFIED && read.status !== STATUS.VARIANT_GONE) {
      out.live_read = summary;
      return out;
    }
    if (!Array.isArray(product.variants)) {
      out.live_read = summary;
      return out;
    }
    const asked = new Set(read.askedIds || []);
    // THE PRODUCT'S OWN PAGE: an answer the merchant gave under another product's handle prices nothing here
    // (the same binding the PDP overlay and the search read apply; controller review of #2453).
    const pageHandle = productPageHandle(product);
    const sameProduct = (v, live) => liveAnswerIsSameProduct(live, v && v.variant_id, pageHandle);
    let verified = 0;
    let gone = 0;
    out.variants = product.variants.map((v) => {
      const id = numericVariantId(v && v.variant_id);
      if (!id || !asked.has(id)) return v;
      const live = read.live.get(id);
      if (live && !sameProduct(v, live)) return v;
      if (!live) {
        // Gone only when the merchant SAID so (a `not_found` naming this id); silence is not evidence.
        if (!read.notFound || !read.notFound.has(id)) return v;
        gone += 1;
        return { ...v, availability: withLiveStock(v.availability, false), live_read: { status: STATUS.VARIANT_GONE } };
      }
      if (live.amount === null || live.available === null) return v;
      verified += 1;
      const amount = roundTo(live.amount, read.currency);
      const next = {
        ...v,
        availability: withLiveStock(v.availability, live.available),
        live_read: { status: STATUS.VERIFIED },
      };
      if (v.price == null || typeof v.price === 'object') {
        // The stored compare-at is a different read's number (and maybe currency): not shown beside a live one.
        const { compare_at: _staleCompareAt, ...priceRest } = v.price || {};
        next.price = { ...priceRest, current: { amount, currency: read.currency } };
      } else {
        next.price = amount; // a scalar price stays a scalar
        next.currency = read.currency;
      }
      delete next.current_own_offer_status;
      delete next.inventory_quantity; // a stored count beside a live in/out-of-stock flag would contradict it
      return next;
    });
    const defaultId = numericVariantId(product.default_variant_id) || (out.variants[0] && numericVariantId(out.variants[0].variant_id));
    const defaultLive = defaultId ? read.live.get(defaultId) : null;
    const defaultVariant = (out.variants || []).find((v) => numericVariantId(v && v.variant_id) === defaultId);
    if (defaultLive && defaultLive.amount !== null && sameProduct(defaultVariant || { variant_id: defaultId }, defaultLive)) {
      out.price = roundTo(defaultLive.amount, read.currency);
      out.currency = read.currency;
      out.price_source = 'merchant_live';
    }
    const allAsked = (Array.isArray(product.variants) ? product.variants : []).every((v) => asked.has(numericVariantId(v && v.variant_id)));
    const anyInStock = out.variants.some((v) => v && v.availability && v.availability.in_stock === true && v.live_read);
    if (anyInStock) out.availability = withLiveStock(product.availability, true);
    else if (verified + gone > 0 && allAsked) out.availability = withLiveStock(product.availability, false);
    out.live_read = { ...summary, checked: asked.size, verified, gone };
    return out;
  }

  /**
   * @param {object} result  the get_product result ({ product } or the product itself)
   * @param {{ market?: string }} ctx
   * @returns {Promise<object|null>} the result to serve (enforce), or null (unchanged)
   */
  async function readProduct(result, ctx = {}) {
    if (mode === MODES.OFF) return null;
    const product = productTarget(result);
    if (!product) return null;
    if (commerceBlocked(result, product)) {
      log(event, { mode, ...logFieldsOf(ctx), product_id: product.product_id || null, status: STATUS.SKIPPED, reason: 'commerce_blocked' });
      return null;
    }
    if (mode === MODES.SHADOW) {
      // Shadow never touches the answer, its latency included: the read runs after it is served.
      readAndLog(result, product, ctx).catch(() => {});
      return null;
    }
    return readAndLog(result, product, ctx);
  }

  async function readAndLog(result, product, ctx) {
    const read = await readLive(product, ctx);
    // The caller's own record of the merchant's answer (the frontend PDP's cache): the raw read, never
    // the page. A throwing recorder costs the record, not the read.
    if (typeof ctx.onRead === 'function') {
      try {
        ctx.onRead(read);
      } catch {
        /* the record is optional */
      }
    }
    const stats = {
      mode,
      ...logFieldsOf(ctx),
      product_id: product.product_id || null,
      host: read.host || null,
      market: read.country || null,
      status: read.status,
      reason: read.reason || null,
      market_basis: read.basis || null,
    };
    if (read.status === STATUS.VERIFIED || read.status === STATUS.VARIANT_GONE) {
      const preview = applyProductRead(product, read);
      const byId = new Map((Array.isArray(product.variants) ? product.variants : []).map((v) => [numericVariantId(v && v.variant_id), v]));
      stats.verified = preview.live_read.verified;
      stats.gone = preview.live_read.gone;
      stats.stock_changed = (preview.variants || []).filter((v) => {
        const before = byId.get(numericVariantId(v && v.variant_id));
        return v && v.live_read && before && (before.availability || {}).in_stock !== (v.availability || {}).in_stock;
      }).length;
      stats.price_changed = (preview.variants || []).filter((v) => {
        const before = byId.get(numericVariantId(v && v.variant_id));
        const b = before && before.price && before.price.current && before.price.current.amount;
        const a = v && v.live_read && v.price && v.price.current && v.price.current.amount;
        return a != null && Number(b) !== Number(a);
      }).length;
      // THE PAGE SAYS UNAVAILABLE, THE MERCHANT SAYS IN STOCK: a variant our own-money verdict or stored
      // stock marks unavailable that the merchant answered available (the Laneige 15-flavour case).
      stats.own_unavailable_live_in_stock = (preview.variants || []).filter((v) => {
        const before = byId.get(numericVariantId(v && v.variant_id));
        const shownUnavailable = before && (ctx.pageShowsAllUnavailable === true
          || before.current_own_offer_status === 'unavailable'
          || (before.availability || {}).in_stock === false);
        return shownUnavailable && v && v.live_read && (v.availability || {}).in_stock === true;
      }).length;
      log(event, stats);
      return result.product && typeof result.product === 'object' ? { ...result, product: preview } : preview;
    }
    log(event, stats);
    const annotated = applyProductRead(product, read);
    return result.product && typeof result.product === 'object' ? { ...result, product: annotated } : annotated;
  }

  return { mode, readProduct, applyProductRead, readLive };
}

/*
 * LIVE SEARCH-CARD READ (search_catalog). Same source as the offer and product reads, with the narrower
 * claim a search card can carry (review of #2439):
 *
 *   - A card stands for the PRODUCT; it names one variant (its cheapest stored offer). So the read CONFIRMS
 *     or CORRECTS that variant's price in the card's own currency, and may RAISE the card to in stock when
 *     the merchant says that variant is available -- it never lowers a card to out of stock and never drops
 *     one: one sold-out shade is not a sold-out product, and `in_stock_only` pages were filtered on stock
 *     before this runs. A gone page stays the `.json` overlay's to judge (storefrontProductPage).
 *   - Only a REAL variant: `source_variant_id` that restates the product (the same filter as the `.json`
 *     overlay's targetOf), else the URL's `?variant=`. And the merchant's answer must be for the SAME product
 *     page (its `handle`), or it is not this card's.
 *   - The card's currency never changes: a declared market whose currency is not the card's is not read.
 *
 * `plan(cards, ctx)` says, synchronously, which cards this read will try, so the overlay can start the
 * `.json` reads for the rest at once instead of after it.
 */
function searchCardVariantId(card) {
  let own = str(card && card.source_variant_id);
  const productKey = str(card && (card.product_key || card.catalog_product_key));
  const sourceProductId = str(card && card.source_product_id);
  if (own && (isRestatedProductId(own, productKey) || isRestatedProductId(own, sourceProductId)
    || own === 'default' || own.endsWith('-default'))) own = '';
  if (!own) {
    try {
      own = new URL(str(card && card.destination_url)).searchParams.get('variant') || '';
    } catch {
      own = '';
    }
  }
  return numericVariantId(own);
}

function searchCardHandle(card) {
  for (const key of ['destination_url', 'merchant_canonical_url', 'source_url']) {
    // Markets subfolders and collection paths carry the same handle: /en-us/products/x, /collections/c/products/x.
    const handle = productHandleFromUrl(card && card[key]);
    if (handle) return handle;
  }
  return null;
}

/**
 * A card search serves as NOT buyable: a transaction hold, a dead-source hold, a suppressed PDP, a citation.
 * The live read never touches one (it would raise a held card back to buyable; review round 2 of #2439).
 */
function searchCardHeld(card) {
  if (!card || typeof card !== 'object') return true;
  return card.commerce_suppressed === true
    || card.transaction_ready === false
    || card.buyable === false
    || Boolean(card.non_merch_terminal_hold_v1)
    || Boolean(card.transaction_readiness_blocker_v1)
    || Boolean(card.source_unavailable_v1)
    || str(card.catalog_track).toLowerCase() === 'citation';
}

function cardHost(card) {
  return productHost({
    destination_url: card && card.destination_url,
    source_url: card && card.source_url,
    merchant_canonical_url: card && card.merchant_canonical_url,
  });
}

/**
 * @param {{ ucpClient, mode?, budgetMs?, maxCards?, now?, log?, core? }} deps
 *   mode defaults to env UCP_LIVE_SEARCH_READ (off | shadow | enforce).
 */
// Log-only: the per-read diagnostics (`readAll`'s host / HTTP status) for `summarize`, keyed by the reads Map.
const diagnostics = new WeakMap();
const MAX_LOGGED_HOSTS = 8;

/** A reason as a log label: a short code only (an exception message could carry a URL). */
function logReason(reason) {
  const r = str(reason).toLowerCase();
  if (!r) return null;
  return /^[a-z0-9_]{1,40}$/.test(r) ? r : 'exception';
}

function createUcpLiveSearchReader(deps = {}) {
  const { ucpClient } = deps;
  if (!ucpClient || typeof ucpClient.discoverEndpoint !== 'function' || typeof ucpClient.lookupCatalog !== 'function') {
    throw new Error('createUcpLiveSearchReader requires a ucp client with discoverEndpoint() and lookupCatalog()');
  }
  const mode = deps.mode || readMode(process.env, 'UCP_LIVE_SEARCH_READ');
  // Inside search's own 2.5s page deadline (liveMerchantSearchPrice PAGE_DEADLINE_MS), leaving a planned card
  // UCP does not settle ~1.3s for its `.json` read. A warm lookup answers in ~0.8s (probe 2026-10-14).
  const budgetMs = Number.isFinite(deps.budgetMs) ? deps.budgetMs : 1200;
  const maxCards = Number.isInteger(deps.maxCards) ? deps.maxCards : 20;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  // Search fans out per page: its own, smaller lookup pool, so it cannot starve the offer/product reads.
  const core = deps.core || createLookupCore({ ucpClient, now, endpointTtlMs: 60 * 60 * 1000, memoTtlMs: 30 * 1000, maxConcurrent: 8 });
  // A store whose discovery failed to ANSWER (timeout, 5xx; never cached by the core) is not planned for a
  // minute, so one hanging well-known does not cost every search page the whole budget.
  const DISCOVERY_BACKOFF_MS = 60 * 1000;
  const backoff = new Map(); // host -> until
  const backedOff = (host) => {
    const until = backoff.get(host);
    if (until === undefined) return false;
    // A slow but healthy discovery that outran this read's budget has since cached its endpoint: no backoff.
    const known = core.endpoints && core.endpoints.get(host);
    if (known && known.until > now()) {
      backoff.delete(host);
      return false;
    }
    if (until > now()) return true;
    backoff.delete(host);
    return false;
  };

  /** index -> { host, country, currency, basis, id, handle } for the cards this read will try. Sync, pure. */
  function plan(cards, ctx = {}) {
    const planned = new Map();
    if (mode === MODES.OFF || !Array.isArray(cards)) return planned;
    const declared = str(ctx.market).toUpperCase();
    // ADR-026: only a market the request states is read, never one inferred from a card's currency.
    if (!declared || !(/^[A-Z]{2}$/.test(declared) && currencyForBuyerRegion(declared))) return planned;
    cards.slice(0, maxCards).forEach((card, index) => {
      if (!card || typeof card !== 'object' || searchCardHeld(card)) return;
      if (!(Number(card.price) > 0)) return; // as the `.json` read: a $0 card is a held or unpriced one
      const id = searchCardVariantId(card);
      const host = cardHost(card);
      const handle = searchCardHandle(card); // no handle, no "same product" check: not read
      const cardCurrency = str(card.currency || card.price_currency).toUpperCase();
      if (!id || !host || !handle || !cardCurrency || backedOff(host)) return;
      if (currencyForBuyerRegion(declared) !== cardCurrency) return; // the card's currency never changes
      planned.set(index, { host, country: declared, currency: cardCurrency, basis: 'declared', id, handle });
    });
    return planned;
  }

  /** @returns {Promise<Map<number, object>>} index -> read, for planned cards. Never throws. */
  async function readAll(planned) {
    const reads = new Map();
    // LOG-ONLY diagnostics, beside `reads` and never in them: what builds an answer is unchanged.
    const meta = new Map(); // index -> { host, httpStatus }
    diagnostics.set(reads, meta);
    const groups = new Map();
    for (const [index, p] of planned) {
      meta.set(index, { host: p.host, httpStatus: null });
      const key = `${p.host}|${p.country}`;
      if (!groups.has(key)) groups.set(key, { host: p.host, country: p.country, items: [] });
      groups.get(key).items.push({ index, ...p });
    }
    const deadline = now() + budgetMs;
    await Promise.all([...groups.values()].map(async (g) => {
      try {
        let endpoint;
        try {
          endpoint = await withDeadline(core.endpointFor(g.host), deadline, now);
        } catch (e) {
          backoff.set(g.host, now() + DISCOVERY_BACKOFF_MS);
          if (backoff.size > 2000) backoff.delete(backoff.keys().next().value);
          throw e;
        }
        if (!endpoint) {
          for (const it of g.items) reads.set(it.index, { status: STATUS.NOT_UCP });
          return;
        }
        const ids = [...new Set(g.items.map((it) => it.id))];
        const chunks = [];
        for (let i = 0; i < ids.length; i += MAX_IDS_PER_LOOKUP) chunks.push(ids.slice(i, i + MAX_IDS_PER_LOOKUP));
        const parsed = await withDeadline(
          Promise.all(chunks.map((chunk) => core.lookup(g.host, endpoint, chunk, g.country, { deadline }).then(parseLookup))),
          deadline,
          now,
        );
        if (parsed.some((p) => p.error)) {
          for (const it of g.items) reads.set(it.index, { status: STATUS.ERROR, reason: 'merchant_error' });
          return;
        }
        const live = new Map();
        for (const p of parsed) for (const [id, v] of p.variants) live.set(id, v);
        for (const it of g.items) {
          const v = live.get(it.id);
          const base = { market: it.country, market_basis: it.basis };
          if (!v) reads.set(it.index, { status: STATUS.ERROR, ...base, reason: 'variant_not_answered' });
          else if (!it.handle || !v.handle) reads.set(it.index, { status: STATUS.ERROR, ...base, reason: 'handle_unknown' });
          else if (v.handle !== it.handle) reads.set(it.index, { status: STATUS.ERROR, ...base, reason: 'other_product' });
          else if (v.currency !== it.currency) reads.set(it.index, { status: STATUS.CURRENCY_MISMATCH, ...base });
          else if (v.amount === null || v.available === null) reads.set(it.index, { status: STATUS.ERROR, ...base, reason: 'unreadable_variant' });
          else reads.set(it.index, { status: STATUS.VERIFIED, ...base, amount: roundTo(v.amount, it.currency), currency: it.currency, available: v.available });
        }
      } catch (e) {
        const status = e && e.code === 'timeout' ? STATUS.TIMEOUT : STATUS.ERROR;
        const httpStatus = e && Number.isFinite(Number(e.status)) && Number(e.status) > 0 ? Number(e.status) : null;
        for (const it of g.items) {
          reads.set(it.index, { status, reason: str(e && e.message).slice(0, 80) });
          const m = meta.get(it.index);
          if (httpStatus !== null && m) m.httpStatus = httpStatus;
        }
      }
    }));
    return reads;
  }

  /**
   * The `search_ucp_live_read` line. Besides the totals: `by_reason` (why reads were not verified) and,
   * per merchant HOST (a hostname, never a URL), its status counts and the HTTP status of failed lookups
   * -- so 429s can be read per store. At most MAX_LOGGED_HOSTS hosts by volume; the rest are summed
   * into `other_hosts`, so one page cannot blow up the line.
   */
  function summarize(cards, reads) {
    const stats = { mode, read: reads.size, by_status: {}, by_reason: {}, price_changed: 0, stock_raised: 0 };
    const meta = diagnostics.get(reads) || new Map();
    const perHost = new Map();
    for (const [index, r] of reads) {
      stats.by_status[r.status] = (stats.by_status[r.status] || 0) + 1;
      const reason = logReason(r.reason);
      if (reason) stats.by_reason[reason] = (stats.by_reason[reason] || 0) + 1;
      const m = meta.get(index) || {};
      const host = str(m.host) || 'unknown';
      if (!perHost.has(host)) perHost.set(host, { host, read: 0, by_status: {}, http_status: {} });
      const h = perHost.get(host);
      h.read += 1;
      h.by_status[r.status] = (h.by_status[r.status] || 0) + 1;
      if (m.httpStatus) h.http_status[m.httpStatus] = (h.http_status[m.httpStatus] || 0) + 1;
      if (r.status !== STATUS.VERIFIED) continue;
      const card = cards[index] || {};
      if (Math.abs(Number(card.price) - r.amount) > 0.01) stats.price_changed += 1;
      if (r.available === true && card.in_stock !== true) stats.stock_raised += 1;
    }
    const ranked = [...perHost.values()].sort((a, b) => b.read - a.read || a.host.localeCompare(b.host));
    stats.hosts = ranked.slice(0, MAX_LOGGED_HOSTS);
    const rest = ranked.slice(MAX_LOGGED_HOSTS);
    if (rest.length) {
      const other = { hosts: rest.length, read: 0, by_status: {}, http_status: {} };
      for (const h of rest) {
        other.read += h.read;
        for (const [k, v] of Object.entries(h.by_status)) other.by_status[k] = (other.by_status[k] || 0) + v;
        for (const [k, v] of Object.entries(h.http_status)) other.http_status[k] = (other.http_status[k] || 0) + v;
      }
      stats.other_hosts = other;
    }
    return stats;
  }

  /**
   * @returns {Promise<Map<number, object>|null>} enforce: index -> read for planned cards; shadow/off: null
   *   at once (shadow logs the comparison after the page is served).
   */
  async function readCards(cards, ctx = {}, planned = plan(cards, ctx)) {
    if (mode === MODES.OFF || !planned.size) return null;
    if (mode === MODES.SHADOW) {
      const before = cards.slice(); // the caller rewrites its cards while this read is in flight
      readAll(planned).then((reads) => log('search_ucp_live_read', summarize(before, reads))).catch(() => {});
      return null;
    }
    const before = cards.slice();
    const reads = await readAll(planned);
    try {
      log('search_ucp_live_read', summarize(before, reads));
    } catch {
      /* the log line never costs the answer */
    }
    return reads;
  }

  return { mode, plan, readCards };
}

module.exports = {
  normalizeProductHandle,
  productHandleFromUrl,
  createUcpLiveSearchReader,
  searchCardVariantId,
  searchCardHandle,
  searchCardHeld,
  MAX_CONCURRENT_LOOKUPS,
  commerceBlocked,
  parseLookup,
  cartPinnedTo,
  createUcpLiveOfferReader,
  createUcpLiveProductReader,
  createLookupCore,
  productHost,
  productVariantIds,
  readMode,
  lookupIdsFor,
  liveVariantsFrom,
  numericVariantId,
  urlNamedVariantId,
  hostOf,
  productCurrency,
  roundTo,
  withLiveStock,
  MODES,
  STATUS,
};
