'use strict';

/*
 * THE PDP FIRST-VIEW LIVE REFRESH (UCP_LIVE_PDP_REFRESH = off | shadow | on; default off).
 *
 * The storefront PDP is ISR-cached for an hour, so get_pdp_v2 runs about once an hour per product and the
 * server-side next-view overlay (pdpLiveOverlay.js) almost never reaches a visit. Instead the browser asks
 * for the merchant's live price and stock AFTER the page renders:
 *
 *   1. get_pdp_v2, on a normally served page whose request opted in (`options.live_refresh: true`), adds a
 *      top-level `live_refresh: { v: 1, token, market }` descriptor (`descriptor`). The token
 *      (pdpLiveRefreshToken.js) binds the product, merchant, host, handle, market, page currency and variant
 *      ids; nothing else is trusted.
 *   2. The browser posts `pdp_live_read { live_refresh_token, page }` (`read`). The page is checked against
 *      the token; the merchant is read ONLY from the token (`syntheticProduct`), through the same reader,
 *      cache, claim and per-store cap as the server-side PDP read; the answer is applied by THE overlay
 *      (`applyPdpLiveOverlay`, never re-implemented here or in the browser), and the parts of the page the
 *      overlay replaced come back as a `patch`.
 *
 * Shadow: tokens are issued, reads happen and are logged, no patch is returned.
 */

const { applyPdpLiveOverlay, canonicalCard, cardHandle, pageCurrency } = require('./pdpLiveOverlay');
const { commerceBlocked, productHost, productVariantIds, STATUS } = require('./ucpLiveOfferRead');
const { signRefreshToken, verifyRefreshToken, DEFAULT_TTL_S } = require('./pdpLiveRefreshToken');
const { currencyForBuyerRegion } = require('../auroraBff/buyerRegion');
const { isDeepStrictEqual } = require('node:util');

const MODES = Object.freeze({ OFF: 'off', SHADOW: 'shadow', ON: 'on' });
const MAX_PAGE_BYTES = 256 * 1024;
const DESCRIPTOR_EVENT = 'get_pdp_v2_live_refresh_issued';
const READ_EVENT = 'pdp_live_read';
const INVALID_TOKEN = 'INVALID_LIVE_REFRESH_TOKEN';

function refreshMode(env = process.env) {
  const raw = String(env.UCP_LIVE_PDP_REFRESH ?? '').trim().toLowerCase();
  return raw === MODES.ON || raw === MODES.SHADOW ? raw : MODES.OFF;
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function zeroStats() {
  return { verified: 0, gone: 0, price_changed: 0, stock_changed: 0, best_price_moved: false };
}

function amountOf(price) {
  if (price === null || price === undefined) return null;
  if (typeof price === 'number' || typeof price === 'string') {
    const n = Number(price);
    return Number.isFinite(n) ? n : null;
  }
  if (!isObj(price)) return null;
  const raw = isObj(price.current) && price.current.amount !== undefined ? price.current.amount : price.amount;
  const n = Number(raw);
  return raw === null || raw === undefined || !Number.isFinite(n) ? null : n;
}

function inStockOf(availability) {
  if (isObj(availability)) return typeof availability.in_stock === 'boolean' ? availability.in_stock : null;
  if (typeof availability === 'string') return availability === 'in_stock' ? true : availability === 'out_of_stock' ? false : null;
  return null;
}

const readKeyOf = (claims) => `${claims.h}|${claims.m}|${[...claims.ids].sort().join(',')}`;

/** The product the merchant is asked about: built ONLY from the token. The browser's page never picks it. */
function syntheticProduct(claims) {
  return {
    product_id: claims.pid,
    merchant_id: claims.mid,
    destination_url: `https://${claims.h}/products/${encodeURIComponent(claims.hd)}`,
    default_variant_id: claims.ids[0],
    variants: claims.ids.map((id) => ({ variant_id: id })),
    currency: claims.c,
  };
}

/** The page's card read by the overlay's own rules, and whether it is the one the token names. */
function pageMatchesClaims(page, claims) {
  if (!isObj(page) || !Array.isArray(page.modules)) return { ok: false, field: 'page' };
  const found = canonicalCard(page);
  if (!found) return { ok: false, field: 'card' };
  const { card } = found;
  if (str(card.product_id) !== claims.pid) return { ok: false, field: 'pid' };
  if (str(card.merchant_id) !== claims.mid) return { ok: false, field: 'mid' };
  const host = productHost(card);
  if (host !== claims.h) return { ok: false, field: 'h' };
  if (cardHandle(card, host) !== claims.hd) return { ok: false, field: 'hd' };
  if (pageCurrency(card) !== claims.c) return { ok: false, field: 'c' };
  const ids = productVariantIds(card);
  const claimed = new Set(claims.ids);
  if (ids.length !== claimed.size || !ids.every((id) => claimed.has(id))) return { ok: false, field: 'ids' };
  return { ok: true, found };
}

/** Fresh cached answers the overlay would use for THIS page: same currency, same product page (handle). */
function usableAnswers(cache, claims) {
  const answers = cache.answersFor(claims.h, claims.m, claims.ids);
  let n = 0;
  for (const a of answers.values()) {
    if (a && a.currency === claims.c && Array.isArray(a.handles) && a.handles.includes(claims.hd)) n += 1;
  }
  return n;
}

/** Why a read gave the overlay nothing, in the response's reason vocabulary (null: none of those). */
function reasonOfRead(read) {
  if (!read) return null;
  if (read.status === STATUS.SKIPPED && read.reason === 'host_busy') return 'host_busy';
  if (read.status === STATUS.TIMEOUT) return 'timeout';
  if (read.status === STATUS.NOT_UCP) return 'not_ucp';
  if (read.status === STATUS.CURRENCY_MISMATCH) return 'currency_mismatch';
  return null;
}

/** The first module of `type` whose object the overlay replaced: its new data, or undefined. */
function replacedData(beforeList, afterList, type) {
  if (!Array.isArray(beforeList) || !Array.isArray(afterList)) return undefined;
  for (let i = 0; i < afterList.length; i += 1) {
    const a = afterList[i];
    if (isObj(a) && a.type === type && a !== beforeList[i] && isObj(a.data)) return a.data;
  }
  return undefined;
}

function hasModule(list, type) {
  return Array.isArray(list) && list.some((m) => isObj(m) && m.type === type);
}

/**
 * The parts of the page the overlay returned NEW objects for (it keeps the identity of what it did not
 * touch). The card as a shallow key diff; module data whole.
 */
function buildPatch(before, after) {
  const b = canonicalCard(before);
  const a = canonicalCard(after);
  const patch = {};
  if (a.card !== b.card) {
    const set = {};
    for (const [k, v] of Object.entries(a.card)) {
      if (!Object.prototype.hasOwnProperty.call(b.card, k) || !isDeepStrictEqual(v, b.card[k])) set[k] = v;
    }
    const unset = Object.keys(b.card).filter((k) => !Object.prototype.hasOwnProperty.call(a.card, k));
    if (Object.keys(set).length || unset.length) patch.product = { set, unset };
  }
  const modules = {};
  const promo = replacedData(b.pdp.modules, a.pdp.modules, 'price_promo');
  if (promo) modules.price_promo = promo;
  // The storefront keeps ONE variant_selector: the response's own when it has one (it replaces the nested
  // copy), else the canonical payload's.
  const selector = hasModule(before.modules, 'variant_selector')
    ? replacedData(before.modules, after.modules, 'variant_selector')
    : replacedData(b.pdp.modules, a.pdp.modules, 'variant_selector');
  if (selector) modules.variant_selector = selector;
  if (Object.keys(modules).length) patch.modules = modules;
  const offers = replacedData(before.modules, after.modules, 'offers');
  if (offers) patch.offers = { offers: offers.offers, best_price_offer_id: offers.best_price_offer_id ?? null };
  const intel = replacedData(before.modules, after.modules, 'product_intel');
  if (intel) patch.product_intel = { offer_pointers: intel.offer_pointers };
  return Object.keys(patch).length ? patch : null;
}

/**
 * @param {{
 *   mode?: () => string, secrets: () => { current: string, previous: string }, ttlS?: () => number,
 *   getReader: () => ({ readLive: Function } | null), cache: () => object,
 *   isCardOfferFor?: (listingId: string) => (card, offer) => boolean, presentationFields?: string[],
 *   now?: () => number, log?: (event, fields) => void, warn?: (event, fields) => void,
 * }} deps
 */
function createPdpLiveRefresh(deps = {}) {
  const modeOf = typeof deps.mode === 'function' ? deps.mode : () => refreshMode(process.env);
  const secretsOf = typeof deps.secrets === 'function' ? deps.secrets : () => ({ current: '', previous: '' });
  const ttlOf = typeof deps.ttlS === 'function' ? deps.ttlS : () => DEFAULT_TTL_S;
  const getReader = typeof deps.getReader === 'function' ? deps.getReader : () => null;
  const cacheOf = typeof deps.cache === 'function' ? deps.cache : () => null;
  const isCardOfferFor = typeof deps.isCardOfferFor === 'function' ? deps.isCardOfferFor : () => () => false;
  const presentationFields = Array.isArray(deps.presentationFields) ? deps.presentationFields : [];
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const warn = typeof deps.warn === 'function' ? deps.warn : log;
  // Reads in flight in THIS process, by product x market: a second browser waits on the first's read.
  const inFlight = new Map();
  let warnedNoSecret = false;

  function safeLog(event, fields) {
    try {
      log(event, fields);
    } catch {
      /* the log line never costs the answer */
    }
  }

  /**
   * The get_pdp_v2 descriptor for a page the caller serves normally (the caller only asks on that branch).
   * @returns {{ v: 1, token: string, market: string } | null}
   */
  function descriptor(payload, { optedIn = false, market, cardListingId = '' } = {}) {
    if (optedIn !== true) return null; // no line for callers that never asked (agents)
    const country = str(market).toUpperCase();
    const out = (reason, host = null, token = null) => {
      safeLog(DESCRIPTOR_EVENT, { issued: Boolean(token), reason, host, market: /^[A-Z]{2}$/.test(country) ? country : null });
      return token ? { v: 1, token, market: country } : null;
    };
    try {
      if (modeOf() === MODES.OFF) return out('disabled');
      const { current } = secretsOf() || {};
      if (!current) {
        if (!warnedNoSecret) {
          warnedNoSecret = true;
          try {
            warn('pdp_live_refresh_secret_missing', { reason: 'UCP_LIVE_PDP_REFRESH_SECRET unset or shorter than 32 bytes' });
          } catch {
            /* logged once or not at all */
          }
        }
        return out('no_secret');
      }
      if (!getReader()) return out('no_reader');
      if (!/^[A-Z]{2}$/.test(country)) return out('no_market');
      const marketCurrency = currencyForBuyerRegion(country);
      if (!marketCurrency) return out('market_not_priced');
      const found = canonicalCard(payload);
      if (!found) return out('no_card');
      const { pdp, card } = found;
      if (commerceBlocked(pdp, card)) return out('commerce_blocked');
      const host = productHost(card);
      if (!host) return out('no_host');
      const ids = productVariantIds(card);
      if (!ids.length) return out('no_variant_id', host);
      const handle = cardHandle(card, host);
      if (!handle) return out('no_handle', host);
      const currency = pageCurrency(card);
      if (currency !== marketCurrency) return out('currency_mismatch', host);
      const variants = Array.isArray(card.variants) ? card.variants : [];
      if (!variants.some((v) => isObj(v) && v.current_own_offer_status !== 'unavailable')) return out('all_withheld', host);
      const pid = str(card.product_id);
      const mid = str(card.merchant_id);
      if (!pid || !mid) return out('no_identity', host);
      const iat = Math.floor(now() / 1000);
      const token = signRefreshToken({
        v: 1,
        op: 'pdp_live_read',
        pid,
        mid,
        lid: str(cardListingId),
        h: host,
        hd: handle,
        m: country,
        c: currency,
        ids,
        iat,
        exp: iat + ttlOf(),
      }, current);
      return token ? out(null, host, token) : out('no_secret', host);
    } catch {
      return null;
    }
  }

  async function runRead(reader, cache, claims) {
    const startedAt = now();
    let read;
    try {
      read = await reader.readLive(syntheticProduct(claims), { market: claims.m });
    } catch {
      read = { status: STATUS.ERROR, reason: 'exception' };
    }
    // Recorded exactly as the server-side PDP read records (shadowPdpLiveRead): a store too busy to take
    // the read does not count as tried; a read the merchant did not answer may be tried again sooner.
    try {
      if (read && read.status === STATUS.SKIPPED && read.reason === 'host_busy') {
        cache.releaseRead(claims.h, claims.m, claims.ids);
      } else if (!cache.record(read) && (!read || read.status !== STATUS.SKIPPED)) {
        cache.retryReadSoon(claims.h, claims.m, claims.ids);
      }
    } catch {
      /* the record is optional */
    }
    return { read, ms: now() - startedAt };
  }

  /**
   * pdp_live_read.
   * @param {{ token?: string, page?: object, market?: string }} input  market: the request's declared market
   * @returns {Promise<{ httpStatus: number, body: object }>}  never throws
   */
  async function read({ token, page, market } = {}) {
    const startedAt = now();
    const mode = modeOf();
    const ctx = { claims: null, source: null, readMs: null, pageBytes: null, readStatus: null, mismatch: null };
    const respond = (outcome, reason, { stats = zeroStats(), checkedAt = null, patch = null } = {}) => {
      const c = ctx.claims;
      safeLog(READ_EVENT, {
        outcome,
        reason,
        source: ctx.source,
        mode,
        host: c ? c.h : null,
        market: c ? c.m : null,
        product_id: c ? c.pid : null,
        token_age_s: c ? Math.max(0, Math.floor(startedAt / 1000) - c.iat) : null,
        read_ms: ctx.readMs,
        total_ms: now() - startedAt,
        page_bytes: ctx.pageBytes,
        read_status: ctx.readStatus,
        mismatch: ctx.mismatch,
        patched: Boolean(patch),
        ...stats,
      });
      return {
        httpStatus: 200,
        body: {
          status: 'success',
          live_refresh: { mode, outcome, reason, source: ctx.source, checked_at: checkedAt, stats },
          ...(patch ? { patch } : {}),
        },
      };
    };
    try {
      if (mode === MODES.OFF) return respond('skipped', 'disabled');
      const { current, previous } = secretsOf() || {};
      const reader = getReader();
      const cache = cacheOf();
      if (!current || !reader || !cache) return respond('skipped', 'disabled');

      const verified = verifyRefreshToken(token, { secrets: [current, previous], nowSec: Math.floor(now() / 1000) });
      if (!verified.ok && verified.error === 'expired') {
        ctx.claims = verified.claims;
        return respond('skipped', 'token_expired');
      }
      if (!verified.ok) {
        safeLog(READ_EVENT, { outcome: 'rejected', reason: verified.error, mode, total_ms: now() - startedAt });
        return { httpStatus: 400, body: { error: INVALID_TOKEN, message: 'The live refresh token is not valid' } };
      }
      const claims = verified.claims;
      ctx.claims = claims;

      const declared = str(market).toUpperCase();
      if (declared && declared !== claims.m) return respond('skipped', 'market_changed');

      try {
        const json = JSON.stringify(page);
        ctx.pageBytes = json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
      } catch {
        ctx.pageBytes = null;
        return respond('skipped', 'page_mismatch');
      }
      if (ctx.pageBytes > MAX_PAGE_BYTES) return respond('skipped', 'page_too_large');

      // A token whose market no longer prices in its currency (a region map change) is not read.
      if (currencyForBuyerRegion(claims.m) !== claims.c) return respond('skipped', 'currency_mismatch');

      const match = pageMatchesClaims(page, claims);
      if (!match.ok) {
        ctx.mismatch = match.field;
        return respond('skipped', 'page_mismatch');
      }
      if (commerceBlocked(match.found.pdp, match.found.card)) return respond('skipped', 'commerce_blocked');

      // NO await between the in-flight check and the claim: two requests cannot both start a read.
      let result = null;
      if (usableAnswers(cache, claims) > 0) {
        ctx.source = 'cache';
      } else {
        const key = readKeyOf(claims);
        const pending = inFlight.get(key);
        if (pending) {
          ctx.source = 'coalesced';
          const waitedFrom = now();
          result = await pending;
          ctx.readMs = now() - waitedFrom;
        } else if (cache.claimRead(claims.h, claims.m, claims.ids)) {
          ctx.source = 'read';
          const p = runRead(reader, cache, claims);
          inFlight.set(key, p);
          try {
            result = await p;
          } finally {
            inFlight.delete(key);
          }
          ctx.readMs = result.ms;
        } else {
          return respond('no_answer', 'recently_tried');
        }
        ctx.readStatus = result && result.read ? result.read.status || null : null;
      }

      const out = applyPdpLiveOverlay(page, {
        market: claims.m,
        cache,
        isCardOffer: isCardOfferFor(claims.lid),
        presentationFields,
        now,
      });
      if (!out) return respond('no_answer', reasonOfRead(result && result.read));

      const stats = {
        verified: out.stats.verified || 0,
        gone: out.stats.gone || 0,
        price_changed: out.stats.price_changed || 0,
        stock_changed: out.stats.stock_changed || 0,
        best_price_moved: out.stats.best_price_moved === true,
      };
      const before = match.found.card;
      const after = canonicalCard(out.payload).card;
      // Visible: a variant's price or stock, a variant gone, the best price moved -- or the card's OWN shown
      // price or stock flipping (a card that disagreed with its variants). A card flag the page never showed
      // (unknown -> known) is not a change the merchant made.
      const cardPriceBefore = amountOf(before.price);
      const cardStockBefore = inStockOf(before.availability);
      const visible = stats.price_changed > 0 || stats.stock_changed > 0 || stats.gone > 0 || stats.best_price_moved
        || (cardPriceBefore !== null && cardPriceBefore !== amountOf(after.price))
        || (cardStockBefore !== null && cardStockBefore !== inStockOf(after.availability));
      const checkedAt = isObj(after.live_read) ? after.live_read.checked_at || null : null;
      if (!visible) return respond('confirmed', null, { stats, checkedAt });
      const patch = mode === MODES.ON ? buildPatch(page, out.payload) : null;
      return respond('applied', null, { stats, checkedAt, patch });
    } catch {
      return respond('no_answer', null);
    }
  }

  return { descriptor, read, inFlightCount: () => inFlight.size };
}

module.exports = {
  createPdpLiveRefresh,
  refreshMode,
  syntheticProduct,
  pageMatchesClaims,
  buildPatch,
  MODES,
  MAX_PAGE_BYTES,
  INVALID_TOKEN,
};
