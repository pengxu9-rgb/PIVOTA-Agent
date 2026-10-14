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

const { currencyExponent, majorUnitsOf } = require('./merchantVariantSource');
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

// The markets a currency is priced in (buyerRegion's one map), for currencies exactly ONE market uses.
// EUR (FR/HR/FI) names no single market and so gets none.
const SINGLE_MARKET_FOR_CURRENCY = (() => {
  const byCurrency = new Map();
  for (const region of ['US', 'GB', 'JP', 'FR', 'HR', 'FI', 'AU', 'SE', 'KR', 'HK', 'SG', 'CA']) {
    const c = currencyForBuyerRegion(region);
    if (!c) continue;
    byCurrency.set(c, byCurrency.has(c) ? null : region);
  }
  return byCurrency;
})();

/** The market a listing priced in `currency` is the home listing for, or null (none, or ambiguous). */
function marketForCurrency(currency) {
  return SINGLE_MARKET_FOR_CURRENCY.get(str(currency).toUpperCase()) || null;
}

function str(v) {
  return v == null ? '' : String(v).trim();
}

function numericVariantId(v) {
  const s = str(v);
  const m = /^(?:gid:\/\/shopify\/ProductVariant\/)?(\d{6,20})$/.exec(s);
  return m ? m[1] : null;
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
function lookupIdsFor(offer) {
  const spec = (offer && offer.execution_spec) || {};
  if (!numericVariantId(spec.variant_id)) return [];
  const ids = [];
  const add = (v) => {
    const n = numericVariantId(v);
    if (n && !ids.includes(n) && ids.length < MAX_IDS_PER_LOOKUP) ids.push(n);
  };
  add(spec.variant_id);
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
    for (const v of Array.isArray(product && product.variants) ? product.variants : []) {
      const id = numericVariantId(v && v.id);
      if (!id) continue;
      const money = majorUnitsOf(v.price);
      const available = v.availability && typeof v.availability.available === 'boolean' ? v.availability.available : null;
      out.set(id, {
        amount: money ? money.amount : null,
        currency: str(v.price && v.price.currency).toUpperCase() || null,
        available,
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
function createLookupCore({ ucpClient, now, endpointTtlMs, memoTtlMs }) {
  const negativeEndpointTtlMs = 10 * 60 * 1000;
  const endpoints = new Map(); // host -> { endpoint|null, until }
  const memo = new Map(); // `${host}|${country}|${ids}` -> { promise, until }

  const discovering = new Map(); // host -> in-flight discovery promise (concurrent callers share it)

  function endpointFor(host) {
    const hit = endpoints.get(host);
    if (hit && hit.until > now()) return Promise.resolve(hit.endpoint);
    if (discovering.has(host)) return discovering.get(host);
    const p = discover(host).finally(() => discovering.delete(host));
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
      throw Object.assign(new Error(`discovery_${Number.isFinite(status) ? status : 'unanswered'}`), { code: 'discovery_transient' });
    }
    endpoints.set(host, { endpoint, until: now() + (endpoint ? endpointTtlMs : negativeEndpointTtlMs) });
    if (endpoints.size > 5000) endpoints.delete(endpoints.keys().next().value);
    return endpoint;
  }

  /** One lookup per (host, country, ids) at a time: concurrent callers share the in-flight promise. */
  function lookup(host, endpoint, ids, country) {
    const key = `${host}|${country}|${ids.join(',')}`;
    const hit = memo.get(key);
    if (hit && hit.until > now()) return hit.promise;
    const promise = (async () => {
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
    })();
    memo.set(key, { promise, until: now() + memoTtlMs });
    promise.catch(() => {
      if (memo.get(key) && memo.get(key).promise === promise) memo.delete(key);
    });
    if (memo.size > 2000) memo.delete(memo.keys().next().value);
    return promise;
  }

  return { endpointFor, lookup, endpoints, memo };
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

  const core = createLookupCore({ ucpClient, now, endpointTtlMs, memoTtlMs });
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
      out.variants = offer.variants.map((v) => {
        const live = read.liveVariants.get(numericVariantId(v && v.variant_id));
        if (!live || live.currency !== currency || live.amount === null) return v;
        return { ...v, price: roundTo(live.amount, currency), currency, in_stock: live.available, live_verified: true };
      });
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
 * MARKET. The caller's declared market when it names one; otherwise the listing's own home market, from
 * its currency when exactly one market prices in it (USD -> US, SGD -> SG, GBP -> GB; EUR names none).
 * The second asks "is what we show still what the merchant sells this listing for", which needs no buyer.
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
    const declaredCurrency = /^[A-Z]{2}$/.test(declared) ? currencyForBuyerRegion(declared) : '';
    const homeCurrency = productCurrency(product);
    const country = declaredCurrency ? declared : marketForCurrency(homeCurrency);
    const currency = declaredCurrency || (country ? homeCurrency : '');
    const host = productHost(product);
    const ids = productVariantIds(product);
    if (!country || !currency) return { status: STATUS.SKIPPED, reason: 'no_market' };
    if (!host || !ids.length) return { status: STATUS.SKIPPED, reason: !host ? 'no_host' : 'no_variant_id', country, currency };
    const deadline = now() + budgetMs;
    try {
      const endpoint = await withDeadline(core.endpointFor(host), deadline, now);
      if (!endpoint) return { status: STATUS.NOT_UCP, host, country, currency };
      const chunks = [];
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_LOOKUP) chunks.push(ids.slice(i, i + MAX_IDS_PER_LOOKUP));
      const payloads = await withDeadline(
        Promise.all(chunks.map((chunk) => core.lookup(host, endpoint, chunk, country))),
        deadline,
        now,
      );
      const live = new Map();
      const notFound = new Set();
      for (const payload of payloads) {
        const parsed = parseLookup(payload);
        if (parsed.error) return { status: STATUS.ERROR, host, country, currency, reason: 'merchant_error' };
        for (const [id, v] of parsed.variants) live.set(id, v);
        for (const id of parsed.notFound) notFound.add(id);
      }
      if (live.size === 0) {
        if (notFound.size) return { status: STATUS.VARIANT_GONE, host, country, currency, live, notFound, askedIds: ids };
        return { status: STATUS.ERROR, host, country, currency, reason: 'nothing_answered' };
      }
      const answeredCurrencies = new Set([...live.values()].map((v) => v.currency).filter(Boolean));
      if (answeredCurrencies.size !== 1 || !answeredCurrencies.has(currency)) {
        return { status: STATUS.CURRENCY_MISMATCH, host, country, currency, merchantCurrency: [...answeredCurrencies].join(',') };
      }
      return { status: STATUS.VERIFIED, host, country, currency, live, notFound, askedIds: ids };
    } catch (e) {
      return { status: e && e.code === 'timeout' ? STATUS.TIMEOUT : STATUS.ERROR, host, country, currency, reason: str(e && e.message).slice(0, 80) };
    }
  }

  /** The product as enforce serves it, from the stored product and one read. Pure: returns a copy. */
  function applyProductRead(product, read) {
    const checkedAt = new Date(now()).toISOString();
    const out = { ...product };
    const summary = { status: read.status, market: read.country || null, source: 'merchant_ucp_lookup_catalog', checked_at: checkedAt };
    if (read.status === STATUS.CURRENCY_MISMATCH) summary.merchant_currency = read.merchantCurrency;
    if (read.status !== STATUS.VERIFIED && read.status !== STATUS.VARIANT_GONE) {
      out.live_read = summary;
      return out;
    }
    const asked = new Set(read.askedIds || []);
    let verified = 0;
    let gone = 0;
    out.variants = (Array.isArray(product.variants) ? product.variants : []).map((v) => {
      const id = numericVariantId(v && v.variant_id);
      if (!id || !asked.has(id)) return v;
      const live = read.live.get(id);
      if (!live) {
        // Gone only when the merchant SAID so (a `not_found` naming this id); silence is not evidence.
        if (!read.notFound || !read.notFound.has(id)) return v;
        gone += 1;
        return { ...v, availability: { ...(v.availability || {}), in_stock: false }, live_read: { status: 'gone' } };
      }
      if (live.amount === null || live.available === null) return v;
      verified += 1;
      const next = {
        ...v,
        price: { ...(v.price || {}), current: { amount: roundTo(live.amount, read.currency), currency: read.currency } },
        availability: { ...(v.availability || {}), in_stock: live.available },
        live_read: { status: STATUS.VERIFIED },
      };
      delete next.current_own_offer_status;
      return next;
    });
    const defaultId = numericVariantId(product.default_variant_id) || (out.variants[0] && numericVariantId(out.variants[0].variant_id));
    const defaultLive = defaultId ? read.live.get(defaultId) : null;
    if (defaultLive && defaultLive.amount !== null) {
      out.price = roundTo(defaultLive.amount, read.currency);
      out.currency = read.currency;
      out.price_source = 'merchant_live';
    }
    const allAsked = (Array.isArray(product.variants) ? product.variants : []).every((v) => asked.has(numericVariantId(v && v.variant_id)));
    const anyInStock = out.variants.some((v) => v && v.availability && v.availability.in_stock === true && v.live_read);
    if (anyInStock) out.availability = { ...(product.availability || {}), in_stock: true };
    else if (verified + gone > 0 && allAsked) out.availability = { ...(product.availability || {}), in_stock: false };
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
    if (mode === MODES.SHADOW) {
      // Shadow never touches the answer, its latency included: the read runs after it is served.
      readAndLog(result, product, ctx).catch(() => {});
      return null;
    }
    return readAndLog(result, product, ctx);
  }

  async function readAndLog(result, product, ctx) {
    const read = await readLive(product, ctx);
    const stats = {
      mode,
      product_id: product.product_id || null,
      host: read.host || null,
      market: read.country || null,
      status: read.status,
      reason: read.reason || null,
    };
    if (read.status === STATUS.VERIFIED || read.status === STATUS.VARIANT_GONE) {
      const preview = applyProductRead(product, read);
      const byId = new Map((Array.isArray(product.variants) ? product.variants : []).map((v) => [numericVariantId(v && v.variant_id), v]));
      stats.verified = preview.live_read.verified;
      stats.gone = preview.live_read.gone;
      stats.stock_changed = preview.variants.filter((v) => {
        const before = byId.get(numericVariantId(v && v.variant_id));
        return v && v.live_read && before && (before.availability || {}).in_stock !== (v.availability || {}).in_stock;
      }).length;
      stats.price_changed = preview.variants.filter((v) => {
        const before = byId.get(numericVariantId(v && v.variant_id));
        const b = before && before.price && before.price.current && before.price.current.amount;
        const a = v && v.live_read && v.price && v.price.current && v.price.current.amount;
        return a != null && Number(b) !== Number(a);
      }).length;
      log('get_product_ucp_live_read', stats);
      return result.product && typeof result.product === 'object' ? { ...result, product: preview } : preview;
    }
    log('get_product_ucp_live_read', stats);
    const annotated = applyProductRead(product, read);
    return result.product && typeof result.product === 'object' ? { ...result, product: annotated } : annotated;
  }

  return { mode, readProduct, applyProductRead, readLive };
}

module.exports = {
  parseLookup,
  cartPinnedTo,
  createUcpLiveOfferReader,
  createUcpLiveProductReader,
  createLookupCore,
  marketForCurrency,
  productHost,
  productVariantIds,
  readMode,
  lookupIdsFor,
  liveVariantsFrom,
  numericVariantId,
  hostOf,
  MODES,
  STATUS,
};
