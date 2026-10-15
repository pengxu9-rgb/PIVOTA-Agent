'use strict';

/*
 * THE FRONTEND PDP LIVE OVERLAY (UCP_LIVE_PDP_READ=enforce), phase 1: no added latency.
 *
 * The PDP never waits on a merchant. A view whose product x buyer market has no merchant answer from the
 * last ten minutes starts one read in the background (sampled, per-store capped: the shadow read's rules)
 * and is served as stored. The read's per-variant answers go into this process's cache; the NEXT view of
 * that product in that market inside ten minutes shows the merchant's price and stock for every variant the
 * merchant answered, in the page's own currency.
 *
 * What the overlay may touch, and what it never does:
 *   - Only a page served normally (`served`). A read-only page, a verified-commerce page and an own-money-gap
 *     page are the own-money logic's verdicts; a live answer does not overrule them in phase 1 (the caller
 *     never asks for those).
 *   - Never a page whose commerce pdpBuilder blocked (the reader's `commerceBlocked`), and never a variant
 *     the own-money logic marked `current_own_offer_status: unavailable`.
 *   - Only answers in the page's currency: phase 1 never re-prices a page into another currency.
 *   - Every place the page shows the card's money moves together -- the card, its variants, its nested
 *     variant_selector and price_promo modules, the response's variant_selector module, and the offer row
 *     that sells the card's own listing (whose best-price mark is re-checked) -- or the page contradicts
 *     itself. Other sellers' offers are theirs and are not touched.
 *   - A stored compare-at is kept only when the merchant confirmed the stored price it was read with.
 *
 * Pure: `applyPdpLiveOverlay` returns a new payload (or null); the input is never mutated.
 */

const {
  commerceBlocked,
  numericVariantId,
  productCurrency,
  productHost,
  productVariantIds,
  roundTo,
  withLiveStock,
  STATUS,
} = require('./ucpLiveOfferRead');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Per-variant merchant answers, keyed host|country|variant id, plus the reads in flight or recently tried
 * (keyed host|country|ids) so one product x market is read at most once per TTL per process, whatever its
 * outcome. Bounded: the oldest entries go first.
 */
function createPdpLiveCache({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const answers = new Map();
  const tried = new Map();

  function bound(map) {
    while (map.size > max) map.delete(map.keys().next().value);
  }
  function fresh(map, key) {
    const hit = map.get(key);
    if (!hit) return null;
    if (now() - hit.at > ttlMs) {
      map.delete(key);
      return null;
    }
    return hit;
  }
  const answerKey = (host, country, id) => `${host}|${country}|${id}`;
  const readKey = (host, country, ids) => `${host}|${country}|${[...ids].sort().join(',')}`;

  return {
    /** From the reader's `onRead`: only a merchant's own per-variant answer is kept. */
    record(read) {
      if (!read || (read.status !== STATUS.VERIFIED && read.status !== STATUS.VARIANT_GONE)) return 0;
      const host = str(read.host).toLowerCase();
      const country = str(read.country).toUpperCase();
      const currency = str(read.currency).toUpperCase();
      if (!host || !country || !currency) return 0;
      const at = now();
      let kept = 0;
      for (const id of read.askedIds || []) {
        const v = read.live && read.live.get(id);
        if (v && v.amount !== null && v.available !== null && str(v.currency).toUpperCase() === currency) {
          answers.delete(answerKey(host, country, id));
          answers.set(answerKey(host, country, id), { gone: false, amount: v.amount, available: v.available, currency, at });
          kept += 1;
        } else if (!v && read.notFound && read.notFound.has(id)) {
          // Gone only when the merchant SAID so; silence is not evidence.
          answers.delete(answerKey(host, country, id));
          answers.set(answerKey(host, country, id), { gone: true, currency, at });
          kept += 1;
        }
      }
      bound(answers);
      return kept;
    },
    /** Fresh answers for these ids: Map id -> { gone, amount, available, currency, at }. */
    answersFor(host, country, ids) {
      const out = new Map();
      for (const id of ids) {
        const hit = fresh(answers, answerKey(host, country, id));
        if (hit) out.set(id, hit);
      }
      return out;
    },
    /** True (and marks it tried) when this product x market has had no read inside the TTL. */
    claimRead(host, country, ids) {
      const key = readKey(host, country, ids);
      if (fresh(tried, key)) return false;
      tried.delete(key);
      tried.set(key, { at: now() });
      bound(tried);
      return true;
    },
    /** A read that never reached the merchant (the store was busy) does not count as tried. */
    releaseRead(host, country, ids) {
      tried.delete(readKey(host, country, ids));
    },
    stats() {
      return { answers: answers.size, tried: tried.size };
    },
  };
}

/** The card the canonical module serves, and where it sits. */
function canonicalCard(payload) {
  const modules = Array.isArray(payload && payload.modules) ? payload.modules : [];
  const index = modules.findIndex((m) => isObj(m) && m.type === 'canonical');
  const pdp = index >= 0 && isObj(modules[index].data) ? modules[index].data.pdp_payload : null;
  const card = isObj(pdp) && isObj(pdp.product) ? pdp.product : null;
  return card ? { index, pdp, card } : null;
}

function priceAmountOf(price) {
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

function priceCurrencyOf(price, fallback) {
  if (isObj(price)) {
    const c = str((isObj(price.current) && price.current.currency) || price.currency).toUpperCase();
    if (c) return c;
  }
  return str(fallback).toUpperCase();
}

/**
 * A price in its own shape with the merchant's amount. An object keeps its other keys; its compare-at stays
 * only when the merchant confirmed the stored amount it was read beside. A scalar stays a scalar.
 */
function livePrice(stored, amount, currency) {
  if (stored !== null && stored !== undefined && !isObj(stored)) return amount;
  const base = isObj(stored) ? stored : {};
  const confirmed = isObj(stored)
    && priceAmountOf(stored) === amount
    && priceCurrencyOf(stored, currency) === currency;
  const { compare_at: compareAt, ...rest } = base;
  const next = {
    ...rest,
    ...('amount' in base ? { amount } : {}),
    ...('currency' in base ? { currency } : {}),
    current: { ...(isObj(base.current) ? base.current : {}), amount, currency },
  };
  if (confirmed && compareAt !== undefined) next.compare_at = compareAt;
  return next;
}

/** One variant with the merchant's answer, or the same object when there is none to give it. */
function patchVariant(v, answers, currency, checkedAt) {
  if (!isObj(v) || v.current_own_offer_status === 'unavailable') return v;
  const id = numericVariantId(v.variant_id);
  const hit = id ? answers.get(id) : null;
  if (!hit) return v;
  if (hit.gone) {
    return { ...v, availability: withLiveStock(v.availability, false), live_read: { status: STATUS.VARIANT_GONE, checked_at: checkedAt } };
  }
  const amount = roundTo(hit.amount, currency);
  const next = {
    ...v,
    price: livePrice(v.price, amount, currency),
    availability: withLiveStock(v.availability, hit.available),
    live_read: { status: STATUS.VERIFIED, checked_at: checkedAt },
  };
  if (next.price === amount && 'currency' in v) next.currency = currency;
  delete next.inventory_quantity; // a stored count beside a live in/out-of-stock flag would contradict it
  return next;
}

/** A variant list (card, selector) patched from the card's patched variants, by id. */
function patchListFrom(list, patchedById) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((v) => {
    const p = isObj(v) ? patchedById.get(numericVariantId(v.variant_id)) : null;
    if (!p || v.current_own_offer_status === 'unavailable') return v;
    changed = true;
    const next = { ...v, availability: p.availability, live_read: p.live_read };
    if (p.live_read.status === STATUS.VERIFIED) next.price = isObj(v.price) || v.price == null ? p.price : priceAmountOf(p.price);
    delete next.inventory_quantity;
    return next;
  });
  return changed ? out : list;
}

function patchModules(modules, patchedById, defaultPrice) {
  if (!Array.isArray(modules)) return modules;
  let changed = false;
  const out = modules.map((m) => {
    if (!isObj(m) || !isObj(m.data)) return m;
    if (m.type === 'variant_selector' && Array.isArray(m.data.variants)) {
      const variants = patchListFrom(m.data.variants, patchedById);
      if (variants === m.data.variants) return m;
      changed = true;
      return { ...m, data: { ...m.data, variants } };
    }
    if (m.type === 'price_promo' && defaultPrice) {
      changed = true;
      const { compare_at: _stale, ...data } = m.data;
      return {
        ...m,
        data: {
          ...data,
          price: { ...(isObj(m.data.price) ? m.data.price : {}), amount: defaultPrice.current.amount, currency: defaultPrice.current.currency },
          ...(defaultPrice.compare_at !== undefined ? { compare_at: defaultPrice.compare_at } : {}),
        },
      };
    }
    return m;
  });
  return changed ? out : modules;
}

function offerInStock(offer) {
  if (isObj(offer.inventory) && typeof offer.inventory.in_stock === 'boolean') return offer.inventory.in_stock;
  if (isObj(offer.availability) && typeof offer.availability.in_stock === 'boolean') return offer.availability.in_stock;
  return null;
}

/** The offer row that sells the card's own listing, with the merchant's answer. */
function patchOffer(offer, answers, currency, checkedAt) {
  const variants = Array.isArray(offer.variants)
    ? offer.variants.map((v) => patchVariant(v, answers, currency, checkedAt))
    : offer.variants;
  const variantsChanged = Array.isArray(offer.variants) && variants.some((v, i) => v !== offer.variants[i]);
  const selectedId = numericVariantId(offer.selected_variant_id || offer.variant_id || offer.default_variant_id);
  const hit = selectedId ? answers.get(selectedId) : null;
  const ownMoney = offer.current_own_offer_status !== 'unavailable';
  const sameCurrency = priceCurrencyOf(offer.price, offer.currency) === currency;
  if (!variantsChanged && !(hit && ownMoney && sameCurrency)) return offer;
  const next = { ...offer, ...(variantsChanged ? { variants } : {}) };
  if (hit && ownMoney && sameCurrency) {
    const inStock = hit.gone ? false : hit.available;
    if (!hit.gone) next.price = livePrice(offer.price, roundTo(hit.amount, currency), currency);
    if (isObj(offer.inventory) || !isObj(offer.availability)) {
      const { available_quantity: _q, quantity: _qq, ...inv } = isObj(offer.inventory) ? offer.inventory : {};
      next.inventory = { ...inv, in_stock: inStock };
    }
    if (isObj(offer.availability)) next.availability = withLiveStock(offer.availability, inStock);
    next.live_read = { status: hit.gone ? STATUS.VARIANT_GONE : STATUS.VERIFIED, checked_at: checkedAt };
  }
  return next;
}

/**
 * The best-price mark after the card's own offer moved: kept when its offer is still (one of) the cheapest
 * buyable offer(s) in the page currency, else moved to the cheapest one.
 */
function bestPriceOfferId(offers, current, currency) {
  const priced = offers.filter((o) => isObj(o)
    && str(o.offer_id)
    && o.current_own_offer_status !== 'unavailable'
    && offerInStock(o) !== false
    && priceCurrencyOf(o.price, o.currency) === currency
    && (priceAmountOf(o.price) || 0) > 0);
  if (!priced.length) return current;
  const min = Math.min(...priced.map((o) => priceAmountOf(o.price)));
  const keep = priced.find((o) => str(o.offer_id) === str(current));
  if (keep && priceAmountOf(keep.price) === min) return current;
  return str(priced.find((o) => priceAmountOf(o.price) === min).offer_id);
}

/**
 * @param {object} payload  the get_pdp_v2 response as built
 * @param {{ market?: string, cache, isCardOffer?: (card, offer) => boolean, now?: () => number }} ctx
 * @returns {{ payload: object, stats: object } | null}  null: nothing to change
 */
function applyPdpLiveOverlay(payload, { market, cache, isCardOffer, now = () => Date.now() } = {}) {
  const country = str(market).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || !cache || !isObj(payload)) return null;
  const found = canonicalCard(payload);
  if (!found) return null;
  const { index, pdp, card } = found;
  if (commerceBlocked(pdp, card)) return null;
  const host = productHost(card);
  const ids = productVariantIds(card);
  // The page's currency as the PDP normalizer reads it: the card's own, then its price's, then a variant's.
  const currency = str(card.currency).toUpperCase() || priceCurrencyOf(card.price, '') || productCurrency(card);
  if (!host || !ids.length || !currency) return null;
  const answers = new Map([...cache.answersFor(host, country, ids)].filter(([, a]) => a.currency === currency));
  if (!answers.size) return null;

  const checkedAt = new Date(Math.min(...[...answers.values()].map((a) => a.at))).toISOString();
  const stored = Array.isArray(card.variants) ? card.variants : [];
  const variants = stored.map((v) => patchVariant(v, answers, currency, checkedAt));
  const patchedById = new Map();
  variants.forEach((v, i) => {
    if (v !== stored[i]) patchedById.set(numericVariantId(v.variant_id), v);
  });
  if (!patchedById.size) return null;

  const stats = { verified: 0, gone: 0, price_changed: 0, stock_changed: 0 };
  variants.forEach((v, i) => {
    if (v === stored[i]) return;
    if (v.live_read.status === STATUS.VERIFIED) stats.verified += 1;
    else stats.gone += 1;
    const before = stored[i];
    if (((before.availability || {}).in_stock) !== v.availability.in_stock) stats.stock_changed += 1;
    if (v.live_read.status === STATUS.VERIFIED && priceAmountOf(before.price) !== priceAmountOf(v.price)) stats.price_changed += 1;
  });

  const nextCard = { ...card, variants };
  const defaultId = numericVariantId(card.default_variant_id) || (stored[0] && numericVariantId(stored[0].variant_id));
  const defaultPatched = defaultId ? patchedById.get(defaultId) : null;
  let defaultPrice = null;
  if (defaultPatched && defaultPatched.live_read.status === STATUS.VERIFIED) {
    const amount = priceAmountOf(defaultPatched.price);
    defaultPrice = livePrice(isObj(card.price) ? card.price : null, amount, currency);
    if (isObj(defaultPatched.price) && defaultPatched.price.compare_at === undefined) delete defaultPrice.compare_at;
    nextCard.price = card.price !== null && card.price !== undefined && !isObj(card.price) ? amount : defaultPrice;
    if ('price_amount' in card) nextCard.price_amount = amount;
    if ('priceAmount' in card) nextCard.priceAmount = amount;
    if ('currency' in card) nextCard.currency = currency;
    nextCard.price_source = 'merchant_live';
  }
  const anyInStock = variants.some((v) => isObj(v) && v.live_read && v.availability.in_stock === true);
  const allAnswered = stored.length > 0 && stored.every((v) => answers.has(numericVariantId(v && v.variant_id))
    && (v || {}).current_own_offer_status !== 'unavailable');
  if (anyInStock || allAnswered) {
    nextCard.availability = withLiveStock(card.availability, anyInStock);
    if (typeof card.in_stock === 'boolean') nextCard.in_stock = anyInStock;
  }
  nextCard.live_read = {
    status: STATUS.VERIFIED,
    market: country,
    source: 'merchant_ucp_lookup_catalog',
    checked_at: checkedAt,
    checked: ids.length,
    verified: stats.verified,
    gone: stats.gone,
  };

  const nextPdp = { ...pdp, product: nextCard, modules: patchModules(pdp.modules, patchedById, defaultPrice) };
  const modules = payload.modules.map((m, i) => {
    if (i === index) return { ...m, data: { ...m.data, pdp_payload: nextPdp } };
    if (!isObj(m) || !isObj(m.data)) return m;
    if (m.type === 'variant_selector') return patchModules([m], patchedById, null)[0];
    if (m.type === 'offers' && Array.isArray(m.data.offers) && typeof isCardOffer === 'function') {
      const offers = m.data.offers.map((o) => (isObj(o) && isCardOffer(card, o) ? patchOffer(o, answers, currency, checkedAt) : o));
      if (offers.every((o, j) => o === m.data.offers[j])) return m;
      const data = { ...m.data, offers };
      if (m.data.best_price_offer_id) {
        data.best_price_offer_id = bestPriceOfferId(offers, m.data.best_price_offer_id, currency);
        if (data.best_price_offer_id !== m.data.best_price_offer_id) stats.best_price_moved = true;
      }
      return { ...m, data };
    }
    return m;
  });
  if (stats.best_price_moved && nextCard.best_price_offer_id) {
    const offersModule = modules.find((m) => isObj(m) && m.type === 'offers' && isObj(m.data));
    nextCard.best_price_offer_id = offersModule.data.best_price_offer_id;
  }
  return { payload: { ...payload, modules }, stats: { ...stats, host, market: country, age_ms: now() - Date.parse(checkedAt) } };
}

module.exports = { applyPdpLiveOverlay, createPdpLiveCache, DEFAULT_TTL_MS };
