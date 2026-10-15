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
const { isRestatedProductId } = require('./merchantVariantSource');
const { compareOffersForPresentation, computeOfferTotal } = require('../offers/offersPriority');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
// A read that got no answer (timeout, error, no endpoint) may be tried again sooner: a cold store's first
// discovery commonly times out.
const DEFAULT_RETRY_MS = 2 * 60 * 1000;
// Bounds: products tried, and variant answers (a product carries up to 30 variants).
const DEFAULT_MAX_READS = 5000;
const DEFAULT_MAX_ANSWERS = 30000;

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
function createPdpLiveCache({
  ttlMs = DEFAULT_TTL_MS,
  retryMs = DEFAULT_RETRY_MS,
  maxReads = DEFAULT_MAX_READS,
  maxAnswers = DEFAULT_MAX_ANSWERS,
  now = () => Date.now(),
} = {}) {
  const answers = new Map();
  const tried = new Map();

  function bound(map, max) {
    while (map.size > max) map.delete(map.keys().next().value);
  }
  function fresh(map, key) {
    const hit = map.get(key);
    if (!hit) return null;
    if (now() - hit.at > (hit.ttl ?? ttlMs)) {
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
      // A merchant that recognised NONE of the ids asked was not asked about its variants: an id that is
      // not a variant id (a restated page id, a barcode sku) answers not_found too. No answer, not "gone".
      if (!read.live || read.live.size === 0) return 0;
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
      bound(answers, maxAnswers);
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
      bound(tried, maxReads);
      return true;
    },
    /** A read that got no answer may be tried again after `retryMs`, not the full TTL. */
    retryReadSoon(host, country, ids) {
      const hit = tried.get(readKey(host, country, ids));
      if (hit) hit.ttl = Math.min(retryMs, ttlMs);
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

/**
 * An id on the page that is not the merchant's variant id: the product's (or page's) own id restated, or a
 * sku standing in for a missing id (pdpBuilder falls back to it). Asked as a variant, such an id answers
 * not_found, which is not evidence the product is gone (review of #2448).
 */
function notAVariantId(v, owner) {
  const id = str(v && v.variant_id);
  if (!id) return true;
  for (const key of ['product_id', 'source_product_id', 'platform_product_id']) {
    const pid = str(owner && owner[key]);
    if (pid && isRestatedProductId(id, pid)) return true;
  }
  const sku = str(v && (v.sku_id || v.sku));
  return Boolean(sku) && sku === id;
}

function withoutFields(obj, fields) {
  if (!fields.some((f) => Object.prototype.hasOwnProperty.call(obj, f))) return obj;
  const out = { ...obj };
  for (const f of fields) delete out[f];
  return out;
}

/** A stock flag in the shape the field already has: a string stays a string, an object an object. */
function liveAvailability(stored, inStock) {
  if (typeof stored === 'string') return inStock ? 'in_stock' : 'out_of_stock';
  return withLiveStock(stored, inStock);
}

/** One variant with the merchant's answer, or the same object when there is none to give it. */
function patchVariant(v, owner, o) {
  if (!isObj(v) || v.current_own_offer_status === 'unavailable' || notAVariantId(v, owner)) return v;
  const id = numericVariantId(v.variant_id);
  const hit = id ? o.answers.get(id) : null;
  if (!hit) return v;
  if (hit.gone) {
    return { ...v, availability: liveAvailability(v.availability, false), live_read: { status: STATUS.VARIANT_GONE, checked_at: o.checkedAt } };
  }
  const amount = roundTo(hit.amount, o.currency);
  let next = {
    ...v,
    price: livePrice(v.price, amount, o.currency),
    availability: liveAvailability(v.availability, hit.available),
    live_read: { status: STATUS.VERIFIED, checked_at: o.checkedAt },
  };
  if (next.price === amount && 'currency' in v) next.currency = o.currency;
  delete next.inventory_quantity; // a stored count beside a live in/out-of-stock flag would contradict it
  // Savings copy was computed against the stored price: it does not describe a different one.
  if (priceAmountOf(v.price) !== amount) next = withoutFields(next, o.presentationFields);
  return next;
}

/** A variant list (selector) patched from the card's patched variants, by id. */
function patchListFrom(list, patchedById, o) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((v) => {
    const p = isObj(v) ? patchedById.get(numericVariantId(v.variant_id)) : null;
    if (!p || v.current_own_offer_status === 'unavailable') return v;
    changed = true;
    let next = { ...v, availability: p.availability, live_read: p.live_read };
    if (p.live_read.status === STATUS.VERIFIED) {
      next.price = isObj(v.price) || v.price == null ? p.price : priceAmountOf(p.price);
      if (priceAmountOf(v.price) !== priceAmountOf(p.price)) next = withoutFields(next, o.presentationFields);
    }
    delete next.inventory_quantity;
    return next;
  });
  return changed ? out : list;
}

function patchModules(modules, patchedById, defaultPrice, o) {
  if (!Array.isArray(modules)) return modules;
  let changed = false;
  const out = modules.map((m) => {
    if (!isObj(m) || !isObj(m.data)) return m;
    if (m.type === 'variant_selector' && Array.isArray(m.data.variants)) {
      const variants = patchListFrom(m.data.variants, patchedById, o);
      if (variants === m.data.variants) return m;
      changed = true;
      return { ...m, data: { ...m.data, variants } };
    }
    if (m.type === 'price_promo' && defaultPrice) {
      changed = true;
      const { compare_at: _stale, ...data } = m.data;
      const confirmed = priceAmountOf(m.data.price) === defaultPrice.current.amount;
      return {
        ...m,
        data: {
          ...data,
          price: { ...(isObj(m.data.price) ? m.data.price : {}), amount: defaultPrice.current.amount, currency: defaultPrice.current.currency },
          ...(defaultPrice.compare_at !== undefined ? { compare_at: defaultPrice.compare_at } : {}),
          // A promotion was read beside the stored price; it does not describe a different one.
          ...(confirmed ? {} : { promotions: [] }),
        },
      };
    }
    return m;
  });
  return changed ? out : modules;
}

/** commerce facts on an offer row restated with the merchant's answer (or dropped where they would contradict). */
function patchFacts(facts, { amount, inStock, confirmed, checkedAt }) {
  if (!isObj(facts)) return facts;
  const next = { ...facts };
  if (amount !== null && isObj(facts.regional_price)) {
    next.regional_price = {
      ...facts.regional_price,
      amount,
      captured_at: checkedAt,
      ...(confirmed ? {} : {
        display_raw: null,
        compare_at_amount: null,
        compare_at_currency: null,
        compare_at_display_raw: null,
      }),
    };
  }
  if (isObj(facts.availability)) {
    next.availability = { ...facts.availability, status: inStock ? 'in_stock' : 'out_of_stock', captured_at: checkedAt };
  }
  return next;
}

const FACT_KEYS = ['commerce_facts_v1', 'commerce_facts', 'agent_safe_commerce_facts'];

/**
 * The offer row that sells the card's own listing, with the merchant's answer. The whole row is left as it
 * is unless it is priced in the page's currency on the card's store, and the own-money logic did not
 * withhold it: half a row re-priced would carry two currencies.
 */
function patchOffer(offer, o) {
  if (offer.current_own_offer_status === 'unavailable') return offer;
  if (priceCurrencyOf(offer.price, offer.currency) !== o.currency) return offer;
  const offerHost = productHost(offer);
  if (offerHost && offerHost !== o.host) return offer;
  const variants = Array.isArray(offer.variants) ? offer.variants.map((v) => patchVariant(v, offer, o)) : offer.variants;
  const variantsChanged = Array.isArray(offer.variants) && variants.some((v, i) => v !== offer.variants[i]);
  const selectedRaw = { variant_id: offer.selected_variant_id || offer.variant_id || offer.default_variant_id };
  const selectedId = notAVariantId(selectedRaw, offer) ? null : numericVariantId(selectedRaw.variant_id);
  const hit = selectedId ? o.answers.get(selectedId) : null;
  if (!variantsChanged && !hit) return offer;
  let next = { ...offer, ...(variantsChanged ? { variants } : {}) };
  if (hit) {
    const inStock = hit.gone ? false : hit.available;
    const amount = hit.gone ? null : roundTo(hit.amount, o.currency);
    const confirmed = amount === null || priceAmountOf(offer.price) === amount;
    if (amount !== null) next.price = livePrice(offer.price, amount, o.currency);
    if (isObj(offer.inventory) || offer.availability === undefined) {
      const { available_quantity: _q, quantity: _qq, ...inv } = isObj(offer.inventory) ? offer.inventory : {};
      next.inventory = { ...inv, in_stock: inStock };
    }
    if (offer.availability !== undefined && offer.availability !== null) next.availability = liveAvailability(offer.availability, inStock);
    if (typeof offer.in_stock === 'boolean') next.in_stock = inStock;
    for (const key of FACT_KEYS) {
      if (isObj(offer[key])) next[key] = patchFacts(offer[key], { amount, inStock, confirmed, checkedAt: o.checkedAt });
    }
    if (!confirmed) next = withoutFields(next, o.presentationFields);
    next.live_read = { status: hit.gone ? STATUS.VARIANT_GONE : STATUS.VERIFIED, checked_at: o.checkedAt };
  }
  return next;
}

function inPresentationOrder(offers) {
  for (let i = 1; i < offers.length; i += 1) {
    if (compareOffersForPresentation(offers[i - 1], offers[i]) > 0) return false;
  }
  return true;
}

/**
 * The offers module after the card's own row moved. Its producer's rules, not new ones:
 *   - order: the row is re-placed by `compareOffersForPresentation` (in stock first, then total), others
 *     keep their order -- only when the list was in that order to begin with;
 *   - best price: the lowest `computeOfferTotal` (price + shipping) among the offers in the page currency,
 *     re-checked only when the row's total changed.
 */
function patchOffersModule(data, isCardOffer, card, o) {
  const before = data.offers;
  let rowIndex = -1;
  const patched = before.map((offer, j) => {
    if (!isObj(offer) || !isCardOffer(card, offer)) return offer;
    const next = patchOffer(offer, o);
    if (next !== offer && rowIndex < 0) rowIndex = j;
    return next;
  });
  if (rowIndex < 0) return { data, moved: false };
  const row = patched[rowIndex];
  const old = before[rowIndex];
  const totalChanged = computeOfferTotal(row) !== computeOfferTotal(old);
  const stockChanged = offerInStock(row) !== offerInStock(old);
  let offers = patched;
  if ((totalChanged || stockChanged) && offers.length > 1 && inPresentationOrder(before)) {
    const others = offers.filter((_, j) => j !== rowIndex);
    const at = others.findIndex((other) => compareOffersForPresentation(row, other) < 0);
    offers = at < 0 ? [...others, row] : [...others.slice(0, at), row, ...others.slice(at)];
  }
  const next = { ...data, offers };
  let moved = false;
  if (totalChanged && data.best_price_offer_id) {
    const inCurrency = offers.filter((x) => isObj(x) && priceCurrencyOf(x.price, x.currency) === o.currency);
    const candidates = inCurrency.length ? inCurrency : offers.filter(isObj);
    let best = null;
    for (const x of candidates) if (!best || computeOfferTotal(x) < computeOfferTotal(best)) best = x;
    if (best && Number.isFinite(computeOfferTotal(best)) && str(best.offer_id) && str(best.offer_id) !== str(data.best_price_offer_id)) {
      next.best_price_offer_id = str(best.offer_id);
      moved = true;
    }
  }
  return { data: next, moved };
}

function offerInStock(offer) {
  if (isObj(offer.inventory) && typeof offer.inventory.in_stock === 'boolean') return offer.inventory.in_stock;
  if (isObj(offer.availability) && typeof offer.availability.in_stock === 'boolean') return offer.availability.in_stock;
  if (typeof offer.availability === 'string') return /in.?stock|available/i.test(offer.availability) && !/out|unavailable/i.test(offer.availability);
  return null;
}

/**
 * @param {object} payload  the get_pdp_v2 response as built
 * @param {{ market?: string, cache, isCardOffer?: (card, offer) => boolean, presentationFields?: string[],
 *   now?: () => number }} ctx
 * @returns {{ payload: object, stats: object } | null}  null: nothing to change
 */
function applyPdpLiveOverlay(payload, { market, cache, isCardOffer, presentationFields = [], now = () => Date.now() } = {}) {
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
  const o = { answers, currency, checkedAt, host, presentationFields: Array.isArray(presentationFields) ? presentationFields : [] };
  const stored = Array.isArray(card.variants) ? card.variants : [];
  const variants = stored.map((v) => patchVariant(v, card, o));
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
    if (stockOf(before.availability) !== stockOf(v.availability)) stats.stock_changed += 1;
    if (v.live_read.status === STATUS.VERIFIED && priceAmountOf(before.price) !== priceAmountOf(v.price)) stats.price_changed += 1;
  });

  let nextCard = { ...card, variants };
  // The card shows its DEFAULT variant's money. Only a card that names no default falls back to its first
  // variant (pdpBuilder's rule); a default the merchant was not asked about leaves the card's price as is.
  const defaultRaw = str(card.default_variant_id) || (stored[0] ? str(stored[0].variant_id) : '');
  const defaultPatched = patchedById.get(numericVariantId(defaultRaw)) || null;
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
    if (priceAmountOf(card.price) !== amount) nextCard = withoutFields(nextCard, o.presentationFields);
  }
  const anyInStock = variants.some((v) => isObj(v) && v.live_read && stockOf(v.availability) === true);
  const allAnswered = stored.length > 0 && stored.every((v, i) => variants[i] !== v);
  if (anyInStock || allAnswered) {
    nextCard.availability = liveAvailability(card.availability, anyInStock);
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

  let bestPriceMoved = null;
  const modules = payload.modules.map((m, i) => {
    if (i === index) return m; // replaced below, once the card is final
    if (!isObj(m) || !isObj(m.data)) return m;
    if (m.type === 'variant_selector') return patchModules([m], patchedById, null, o)[0];
    if (m.type === 'offers' && Array.isArray(m.data.offers) && typeof isCardOffer === 'function') {
      const { data, moved } = patchOffersModule(m.data, isCardOffer, card, o);
      if (data === m.data) return m;
      if (moved) bestPriceMoved = data.best_price_offer_id;
      return { ...m, data };
    }
    return m;
  });
  if (bestPriceMoved) {
    stats.best_price_moved = true;
    if (nextCard.best_price_offer_id) nextCard.best_price_offer_id = bestPriceMoved;
  }
  const nextPdp = { ...pdp, product: nextCard, modules: patchModules(pdp.modules, patchedById, defaultPrice, o) };
  modules[index] = { ...payload.modules[index], data: { ...payload.modules[index].data, pdp_payload: nextPdp } };
  return { payload: { ...payload, modules }, stats: { ...stats, host, market: country, age_ms: now() - Date.parse(checkedAt) } };
}

function stockOf(availability) {
  if (isObj(availability)) return typeof availability.in_stock === 'boolean' ? availability.in_stock : null;
  if (typeof availability === 'string') return availability === 'in_stock' ? true : availability === 'out_of_stock' ? false : null;
  return null;
}

module.exports = { applyPdpLiveOverlay, createPdpLiveCache, DEFAULT_TTL_MS };
