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

function readMode(env = process.env) {
  const v = String(env.UCP_LIVE_OFFER_READ || '').trim().toLowerCase();
  return v === MODES.SHADOW || v === MODES.ENFORCE ? v : MODES.OFF;
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

/** The ids one lookup asks for: the offer's own variant first, then listed options, at most 10, numeric only. */
function lookupIdsFor(offer) {
  const spec = (offer && offer.execution_spec) || {};
  const ids = [];
  const add = (v) => {
    const n = numericVariantId(v);
    if (n && !ids.includes(n) && ids.length < MAX_IDS_PER_LOOKUP) ids.push(n);
  };
  add(spec.variant_id);
  for (const v of Array.isArray(offer && offer.variants) ? offer.variants : []) add(v && v.variant_id);
  return ids;
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

function roundTo(amount, currency) {
  const exp = currencyExponent(currency);
  if (exp === null) return amount;
  const f = 10 ** exp;
  return Math.round(amount * f) / f;
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
  const negativeEndpointTtlMs = 10 * 60 * 1000;
  const memoTtlMs = Number.isFinite(deps.memoTtlMs) ? deps.memoTtlMs : 30 * 1000;
  const expectedTotalTtlMs = Number.isFinite(deps.expectedTotalTtlMs) ? deps.expectedTotalTtlMs : 10 * 60 * 1000;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  const endpoints = new Map(); // host -> { endpoint|null, until }
  const memo = new Map(); // `${host}|${country}|${ids}` -> { payload, until }

  async function endpointFor(host) {
    const hit = endpoints.get(host);
    if (hit && hit.until > now()) return hit.endpoint;
    let endpoint = null;
    try {
      const d = await ucpClient.discoverEndpoint(`https://${host}`);
      endpoint = (d && d.mcpEndpoint) || null;
    } catch {
      endpoint = null;
    }
    endpoints.set(host, { endpoint, until: now() + (endpoint ? endpointTtlMs : negativeEndpointTtlMs) });
    return endpoint;
  }

  async function lookup(host, endpoint, ids, country) {
    const key = `${host}|${country}|${ids.join(',')}`;
    const hit = memo.get(key);
    if (hit && hit.until > now()) return hit.payload;
    const res = await ucpClient.lookupCatalog(endpoint, {
      ids: ids.map(variantGid),
      context: { address_country: country },
    });
    if (!res || res.error || !res.ok) {
      const err = new Error('lookup_failed');
      err.status = res && res.status;
      throw err;
    }
    const payload = unwrapToolPayload(res);
    memo.set(key, { payload, until: now() + memoTtlMs });
    if (memo.size > 2000) memo.delete(memo.keys().next().value);
    return payload;
  }

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
      const payload = await race(lookup(host, endpoint, ids, country));
      const liveVariants = liveVariantsFrom(payload);
      const own = liveVariants.get(ids[0]);
      if (!own) return { status: STATUS.VARIANT_GONE, host, liveVariants };
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
  function applyRead(offer, read, { currency }) {
    const out = { ...offer, live_read: { status: read.status, source: 'merchant_ucp_lookup_catalog' } };
    const spec = { ...(offer.execution_spec || {}) };
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
      Object.assign(spec, {
        expected_item_total: price,
        expected_currency: currency,
        expected_quantity: 1,
        expected_total_expires_at: new Date(now() + expectedTotalTtlMs).toISOString(),
      });
      out.execution_spec = spec;
    } else if (read.status === STATUS.CURRENCY_MISMATCH) {
      out.merchant_price_verified = false;
      out.live_read.merchant_currency = read.live && read.live.currency;
    } else if (read.status === STATUS.VARIANT_GONE) {
      out.stock_verified = false;
      out.in_stock = false;
      delete out.availability;
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
      hosts: reads.map((r, i) => ({ host: r.host || hostOf(targets[i]), status: r.status })),
    });
    if (mode !== MODES.ENFORCE) return { offers: list, stats };
    const applied = list.map((o, i) => (i < reads.length ? applyRead(o, reads[i], { currency }) : o));
    return { offers: applied, stats };
  }

  return { mode, readOffers, applyRead, _caches: { endpoints, memo } };
}

module.exports = {
  createUcpLiveOfferReader,
  readMode,
  lookupIdsFor,
  liveVariantsFrom,
  numericVariantId,
  hostOf,
  MODES,
  STATUS,
};
