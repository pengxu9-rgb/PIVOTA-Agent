'use strict';

/*
 * THE SHARED VERIFIED-PRICE CACHE (verified-price plan PR-3; design sections 2.1-2.5).
 *
 * WHY. Every live merchant answer (search `.json` and UCP reads, get_product, the PDP reads, get_offers, the cart
 * mint) lived only in a per-process map, so one instance's answer could never serve another instance's request,
 * and a 429 one instance drew told no other instance to slow down. This records each VERIFIED answer once, for
 * the whole fleet, in Firestore (services/priceCacheStore.js), and shares a per-host backoff the same way.
 *
 * FLAGS (read per call; all default off):
 *   PRICE_CACHE_STORE  off | firestore
 *   PRICE_CACHE_MODE   off | write | read
 *     write  every writer records its verified answers and 429/5xx backoffs; NOTHING READS the cache, so every
 *            answer is byte-identical to off (shadow fill: the hit rate can be measured before anything uses it)
 *     read   as write, and a consumer may serve an answer from the cache as `recent` inside its own window
 *            (search: 15 min; services/liveMerchantSearchPrice.js is the only consumer today)
 *   PRICE_CACHE_FIRESTORE_DATABASE  the Firestore database id (default price-cache)
 * Both STORE and MODE must be on, or nothing is built: no client is loaded and no connection is opened.
 *
 * KEY. host | market | variant_id | currency, hashed (sha256 hex) to the doc id. host: lowercased, a trailing dot
 * and a leading `www.` dropped (one store, one key, as the search overlay's hostKey). market: the ISO-2 market the
 * CALLER DECLARED. variant_id: the merchant's numeric variant id (a Shopify gid is reduced to its number).
 *
 * THE CURRENCY RULE (ADR-026; Peng's market-currency rule). A price is written, and read, only when its currency
 * IS the declared market's currency (auroraBff/buyerRegion). No declared market: no write, no read. A market or a
 * currency is never defaulted here; a caller with none passes none, and nothing happens.
 *
 * VALUE. amount and compare_at as decimal strings, available, handle (the merchant's product handle, so a reader
 * can refuse another product's answer), source (merchant_ucp | merchant_storefront | merchant_cart), writer
 * (search | pdp | product | offers | cart), read_at, expire_at = read_at + 60 min (the Firestore TTL field; the
 * TTL sweep is lazy, so freshness is always judged from read_at, never from presence). A variant the merchant
 * said it does not have (`variant_gone`) is a tombstone: status variant_gone, no amount, expire_at = read_at +
 * 10 min; no consumer serves a price from one.
 *
 * L1. A per-process map (30 s) in front of every read, misses included, so a burst of identical searches costs
 * one Firestore read per instance. Reads are one getAll of at most 20 docs with a 150 ms timeout; a failed or
 * slow read fails open (the request proceeds exactly as with the cache off) and logs `price_cache_read_failed`.
 *
 * HOST BACKOFF. A merchant 429/430/5xx (search `.json`, UCP discovery or lookup) writes host_backoff/{host}:
 * 60 s, doubling (a repeat within 10 min of the last one ending) up to 10 min. Instances read it through their
 * own L1 (10 s) WITHOUT waiting: a stale entry is refreshed in the background and the read decides on what this
 * instance knows now, so honouring it adds no latency. Only services/priceHostBudget.js honours it, under
 * PRICE_HOST_BUDGET; the cache flags alone only write it.
 */

const crypto = require('crypto');
const { currencyForBuyerRegion } = require('../auroraBff/buyerRegion');

const L1_TTL_MS = 30 * 1000;
const L1_MAX = 5000;
const HARD_EXPIRY_MS = 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
// An answer stamped this far in the future is another clock's error, not a fresh price.
const CLOCK_SKEW_MS = 5 * 1000;
// After a failed store read, this instance reads from its L1 only for a while: a store that is down costs
// each request nothing, not 150 ms.
const READ_PAUSE_MS = 5 * 1000;
const READ_FAILURE_LOG_EVERY_MS = 60 * 1000;
const BACKOFF_L1_TTL_MS = 10 * 1000;
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;
// Write cost: an answer identical to the one this instance last saw for the key (same status, amount, compare-at,
// stock, handle and source) is not written again until that one is this old. The doc's read_at then lags the
// truth by at most this much, well inside every consumer window (10 and 15 min).
const UNCHANGED_REWRITE_MS = 5 * 60 * 1000;
// KNOWN EDGE, TO SETTLE BEFORE PRICE_CACHE_MODE=read: the skip compares against what THIS instance last saw. When
// instance A wrote $10, instance B then wrote $12, and A reads $10 again inside 5 min, A skips and the store keeps
// B's $12 until A's window ends. Harmless in write mode (nothing reads the store); before read mode either compare
// against the store's doc (L1-refreshed) or drop the skip for keys another writer touched.


const SOURCES = new Set(['merchant_ucp', 'merchant_storefront', 'merchant_cart']);
const WRITERS = new Set(['search', 'pdp', 'product', 'offers', 'cart']);
// A hostname with an alphabetic (or punycode) top-level label: never an IP literal.
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const STOREFRONT_VARIANT = /^[A-Za-z0-9_.:-]{1,64}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/;
const DECIMAL = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/;

function str(v) {
  return v == null ? '' : String(v).trim();
}

function flagMode(raw, allowed) {
  const v = str(raw).toLowerCase();
  return allowed.includes(v) ? v : 'off';
}

/** { store, mode, database, active, read }: what the two flags say right now. Pure. */
function priceCacheSettings(env = process.env) {
  const store = flagMode(env && env.PRICE_CACHE_STORE, ['firestore']);
  const mode = flagMode(env && env.PRICE_CACHE_MODE, ['write', 'read']);
  const active = store !== 'off' && mode !== 'off';
  return {
    store,
    mode,
    database: str(env && env.PRICE_CACHE_FIRESTORE_DATABASE) || 'price-cache',
    active,
    read: active && mode === 'read',
  };
}

/** One store, one key: lowercased, a trailing dot and a leading `www.` dropped. '' when not a hostname. */
function normalizeCacheHost(raw) {
  let h = str(raw).toLowerCase();
  if (/^https?:\/\//.test(h)) {
    try {
      h = new URL(h).hostname;
    } catch {
      return '';
    }
  }
  h = h.replace(/\.+$/, '').replace(/^www\./, '');
  return HOST.test(h) ? h : '';
}

/** The declared market (ISO-2 Pivota prices) and its currency, or null. Never a default. */
function declaredMarket(raw) {
  const market = str(raw).toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) return null;
  const currency = currencyForBuyerRegion(market);
  return currency ? { market, currency } : null;
}

/** The merchant's variant id as the key spells it: a Shopify gid's number, else a short storefront id. */
function normalizeVariantId(raw) {
  const v = str(raw);
  const gid = v.match(/^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/);
  if (gid) return gid[1];
  if (/^\d{1,20}$/.test(v)) return v;
  return STOREFRONT_VARIANT.test(v) && !v.includes('/') ? v : '';
}

/**
 * The normalized key of one price, or null when it breaks the currency rule (no declared market, or a currency
 * other than the market's) or names no host / variant. Pure.
 */
function priceCacheKey({ host, market, variant_id: variantId, currency } = {}) {
  const h = normalizeCacheHost(host);
  const m = declaredMarket(market);
  const v = normalizeVariantId(variantId);
  if (!h || !m || !v) return null;
  if (str(currency).toUpperCase() !== m.currency) return null;
  return { host: h, market: m.market, variant_id: v, currency: m.currency };
}

/** hex sha256 of `host|market|variant_id|currency` (a normalized key). */
function priceCacheDocId(key) {
  return crypto.createHash('sha256').update(`${key.host}|${key.market}|${key.variant_id}|${key.currency}`).digest('hex');
}

const fractionDigits = new Map();
function amountString(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!fractionDigits.has(currency)) {
    let digits = 2;
    try {
      digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    } catch {
      digits = 2;
    }
    fractionDigits.set(currency, digits);
  }
  const s = n.toFixed(fractionDigits.get(currency));
  return DECIMAL.test(s) ? s : null;
}

function msOf(v) {
  if (v == null) return NaN;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/**
 * The doc for one verified answer, or null when it is not one the cache may hold. Pure.
 * entry: { host, market, variant_id, currency, amount, compare_at?, available?, handle?, source, writer, read_at? }
 */
function verifiedPriceDoc(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return null;
  const key = priceCacheKey(entry);
  if (!key || !SOURCES.has(entry.source) || !WRITERS.has(entry.writer)) return null;
  const amount = amountString(entry.amount, key.currency);
  if (!amount) return null;
  const readAt = Number.isFinite(msOf(entry.read_at)) ? msOf(entry.read_at) : nowMs;
  if (readAt > nowMs + CLOCK_SKEW_MS || nowMs - readAt > HARD_EXPIRY_MS) return null;
  const compareAt = entry.compare_at != null ? amountString(entry.compare_at, key.currency) : null;
  const handle = str(entry.handle).toLowerCase();
  return {
    key,
    doc: {
      ...key,
      status: 'verified',
      amount,
      compare_at: compareAt && Number(compareAt) > Number(amount) ? compareAt : null,
      available: typeof entry.available === 'boolean' ? entry.available : null,
      handle: HANDLE.test(handle) ? handle : null,
      source: entry.source,
      writer: entry.writer,
      read_at: new Date(readAt),
      expire_at: new Date(readAt + HARD_EXPIRY_MS),
    },
  };
}

/** The tombstone doc for a variant the merchant said it does not have, or null. Pure. */
function variantGoneDoc(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return null;
  const m = declaredMarket(entry.market);
  // A tombstone carries no price; its currency is the market's (the key's), whatever the caller passed.
  const key = m && priceCacheKey({ ...entry, currency: m.currency });
  if (!key || !SOURCES.has(entry.source) || !WRITERS.has(entry.writer)) return null;
  const handle = str(entry.handle).toLowerCase();
  return {
    key,
    doc: {
      ...key,
      status: 'variant_gone',
      amount: null,
      compare_at: null,
      available: false,
      handle: HANDLE.test(handle) ? handle : null,
      source: entry.source,
      writer: entry.writer,
      read_at: new Date(nowMs),
      expire_at: new Date(nowMs + TOMBSTONE_TTL_MS),
    },
  };
}

/**
 * A stored doc as a consumer may serve it inside `ttlMs`, or null (absent, a tombstone, too old, from the
 * future, another key's doc, or malformed). Pure.
 */
function servableAnswer(doc, key, { nowMs, ttlMs }) {
  if (!doc || typeof doc !== 'object' || doc.status !== 'verified') return null;
  if (doc.host !== key.host || doc.market !== key.market || doc.variant_id !== key.variant_id || doc.currency !== key.currency) return null;
  const readAt = msOf(doc.read_at);
  if (!Number.isFinite(readAt) || readAt > nowMs + CLOCK_SKEW_MS) return null;
  const age = Math.max(0, nowMs - readAt);
  if (age > Math.min(Number(ttlMs) || 0, HARD_EXPIRY_MS)) return null;
  if (typeof doc.amount !== 'string' || !DECIMAL.test(doc.amount) || !(Number(doc.amount) > 0)) return null;
  return {
    amount: Number(doc.amount),
    currency: doc.currency,
    available: typeof doc.available === 'boolean' ? doc.available : null,
    handle: typeof doc.handle === 'string' ? doc.handle : null,
    source: doc.source,
    writer: doc.writer,
    read_at_ms: readAt,
    age_ms: age,
  };
}

/**
 * The cache over one store. `store` is a PriceCacheStore (services/priceCacheStore.js).
 * @param {{ store: object, now?: () => number, log?: Function, read?: () => boolean }} deps
 */
function createPriceCache({ store, now = () => Date.now(), log = () => {}, read = () => false } = {}) {
  const l1 = new Map(); // docId -> { doc|null, at }
  const backoffL1 = new Map(); // host -> { until, ms, status, at, remote }
  const refreshing = new Map(); // host -> promise
  let readsPausedUntil = -Infinity;
  let lastReadFailureLogAt = -Infinity;
  let readFailuresSinceLog = 0;
  const logLine = (event, fields) => {
    try { log(event, fields); } catch { /* never costs an answer */ }
  };

  function l1Set(map, k, v) {
    map.delete(k);
    map.set(k, v);
    while (map.size > L1_MAX) map.delete(map.keys().next().value);
  }

  function sameAnswer(a, b) {
    return ['status', 'amount', 'compare_at', 'available', 'handle', 'source'].every((k) => a[k] === b[k]);
  }

  function put(built) {
    if (!built) return false;
    const id = priceCacheDocId(built.key);
    const prev = l1.get(id);
    if (prev && prev.doc && msOf(prev.doc.read_at) > msOf(built.doc.read_at)) return false;
    if (prev && prev.doc && sameAnswer(prev.doc, built.doc)
      && msOf(built.doc.read_at) - msOf(prev.doc.read_at) < UNCHANGED_REWRITE_MS) return false;
    l1Set(l1, id, { doc: built.doc, at: now() });
    try {
      store.putPrice(id, built.doc);
    } catch {
      return false;
    }
    return true;
  }

  function noteReadFailure(err, n) {
    readsPausedUntil = now() + READ_PAUSE_MS;
    readFailuresSinceLog += 1;
    if (now() - lastReadFailureLogAt < READ_FAILURE_LOG_EVERY_MS) return;
    lastReadFailureLogAt = now();
    logLine('price_cache_read_failed', {
      reason: err && err.code === 'timeout' ? 'timeout' : 'error',
      docs: n,
      failures: readFailuresSinceLog,
    });
    readFailuresSinceLog = 0;
  }

  /**
   * The servable answers for `keys` (aligned; null for a miss) inside `ttlMs`. Read mode only: otherwise every
   * entry is null at once and nothing is read. Never rejects.
   */
  async function lookup(keys, { ttlMs } = {}) {
    const list = Array.isArray(keys) ? keys : [];
    const out = list.map(() => null);
    if (!read() || !list.length) return out;
    const t = now();
    const ids = list.map((k) => {
      const key = priceCacheKey(k);
      return key ? { key, id: priceCacheDocId(key) } : null;
    });
    const missing = [];
    for (const it of ids) {
      if (!it) continue;
      const hit = l1.get(it.id);
      if (!(hit && t - hit.at <= L1_TTL_MS) && !missing.includes(it.id)) missing.push(it.id);
    }
    const fetchable = t >= readsPausedUntil ? missing.slice(0, 20) : [];
    if (fetchable.length) {
      try {
        const got = await store.getPrices(fetchable);
        const at = now();
        for (const id of fetchable) {
          const doc = got instanceof Map ? got.get(id) || null : null;
          const prev = l1.get(id);
          // A doc this instance wrote meanwhile (newer) is not replaced by an older one the read brought back.
          if (prev && prev.doc && (!doc || msOf(prev.doc.read_at) > msOf(doc.read_at))) {
            l1Set(l1, id, { doc: prev.doc, at });
          } else {
            l1Set(l1, id, { doc, at });
          }
        }
      } catch (err) {
        noteReadFailure(err, fetchable.length);
      }
    }
    const at = now();
    ids.forEach((it, i) => {
      if (!it) return;
      const hit = l1.get(it.id);
      out[i] = hit ? servableAnswer(hit.doc, it.key, { nowMs: at, ttlMs }) : null;
    });
    return out;
  }

  function refreshBackoff(host) {
    if (refreshing.has(host)) return;
    const p = Promise.resolve()
      .then(() => store.getHostBackoff(host))
      .then((doc) => {
        const at = now();
        const prev = backoffL1.get(host);
        const until = doc ? msOf(doc.backoff_until) : NaN;
        const ms = doc && Number.isFinite(Number(doc.backoff_ms)) ? Number(doc.backoff_ms) : BACKOFF_BASE_MS;
        // The later of what this instance set and what the fleet set.
        if (Number.isFinite(until) && (!prev || until > prev.until)) {
          l1Set(backoffL1, host, { until, ms, status: Number(doc.last_status) || null, at, remote: true });
        } else if (prev) {
          l1Set(backoffL1, host, { ...prev, at });
        } else {
          l1Set(backoffL1, host, { until: -Infinity, ms: 0, status: null, at, remote: false });
        }
      })
      .catch(() => {
        const prev = backoffL1.get(host);
        l1Set(backoffL1, host, prev ? { ...prev, at: now() } : { until: -Infinity, ms: 0, status: null, at: now(), remote: false });
      })
      .finally(() => refreshing.delete(host));
    refreshing.set(host, p);
  }

  /** True while the fleet (or this instance) has `host` backed off. Sync: a stale L1 entry refreshes behind. */
  function hostBackedOff(rawHost) {
    const host = normalizeCacheHost(rawHost);
    if (!host) return false;
    const t = now();
    const entry = backoffL1.get(host);
    if (!entry || t - entry.at > BACKOFF_L1_TTL_MS) refreshBackoff(host);
    // A backoff that ends more than 10 min from now is a clock that stepped back: expired.
    return Boolean(entry && entry.until > t && entry.until - t <= BACKOFF_MAX_MS + 1000);
  }

  /** A merchant refused (429 / 430 / 5xx): back the host off for the fleet. A refusal while backed off waits. */
  function noteHostRefusal(rawHost, status) {
    const host = normalizeCacheHost(rawHost);
    const s = Number(status);
    if (!host || !(s === 429 || s === 430 || (s >= 500 && s <= 599))) return false;
    const t = now();
    const prev = backoffL1.get(host);
    if (prev && prev.until > t && prev.until - t <= BACKOFF_MAX_MS + 1000) return false;
    const sinceEnd = prev && Number.isFinite(prev.until) ? t - prev.until : -1;
    const ms = sinceEnd >= 0 && sinceEnd < BACKOFF_MAX_MS ? Math.min(Math.max(prev.ms, BACKOFF_BASE_MS) * 2, BACKOFF_MAX_MS) : BACKOFF_BASE_MS;
    l1Set(backoffL1, host, { until: t + ms, ms, status: s, at: t, remote: false });
    try {
      store.putHostBackoff(host, {
        host,
        backoff_until: new Date(t + ms),
        backoff_ms: ms,
        last_status: s,
        reason: s === 429 ? 'http_429' : s === 430 ? 'http_430' : 'http_5xx',
        set_at: new Date(t),
        read_at: new Date(t),
      });
    } catch {
      /* the local backoff still holds */
    }
    return true;
  }

  return {
    recordVerifiedPrice: (entry) => put(verifiedPriceDoc(entry, now())),
    recordVariantGone: (entry) => put(variantGoneDoc(entry, now())),
    lookup,
    hostBackedOff,
    noteHostRefusal,
    _l1: l1,
    _backoffL1: backoffL1,
    _refreshing: refreshing,
  };
}

// ---- the process's one cache, built on first ACTIVE use --------------------------------------------------------

let runtime = null;
let storeFactory = null; // tests: (settings) => PriceCacheStore
function defaultLog(event, fields) {
  try {
    // Failures are warnings (they reach error reporting); the stats and warm-up lines are info.
    const level = /_failed$|_reset$/.test(event) ? 'warn' : 'info';
    require('../logger')[level]({ event, ...fields }, event);
  } catch {
    /* ignored */
  }
}
let runtimeLog = defaultLog;

function defaultStoreFactory(settings) {
  const { createFirestorePriceCacheStore } = require('./priceCacheStore');
  return createFirestorePriceCacheStore({ database: settings.database, log: runtimeLog });
}

/** The process cache, or null when the flags are off (then nothing is built, loaded or connected). */
function activePriceCache(env = process.env) {
  const settings = priceCacheSettings(env);
  if (!settings.active) return null;
  if (!runtime) {
    const store = (storeFactory || defaultStoreFactory)(settings);
    runtime = createPriceCache({
      store,
      log: (event, fields) => runtimeLog(event, fields),
      read: () => priceCacheSettings(process.env).read,
    });
    runtime.store = store;
  }
  return runtime;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

module.exports = {
  // The writers' and readers' API: each a no-op (false / null / all-null) while the flags are off.
  recordVerifiedPrice: (entry) => safe(() => { const c = activePriceCache(); return c ? c.recordVerifiedPrice(entry) : false; }, false),
  recordVariantGone: (entry) => safe(() => { const c = activePriceCache(); return c ? c.recordVariantGone(entry) : false; }, false),
  noteHostRefusal: (host, status) => safe(() => { const c = activePriceCache(); return c ? c.noteHostRefusal(host, status) : false; }, false),
  /** True while the shared backoff names `host` (always false with the cache off). */
  sharedHostBackedOff: (host) => safe(() => { const c = activePriceCache(); return c ? c.hostBackedOff(host) : false; }, false),
  priceCacheReadEnabled: (env = process.env) => priceCacheSettings(env).read,
  /**
   * At boot, before the server listens: build the store, load the Firestore client and make one read, so the
   * first request on a new instance never pays the client's load and channel setup on the event loop. Flags off:
   * nothing at all. Never rejects.
   */
  async warmPriceCache(opts) {
    try {
      const c = activePriceCache();
      if (!c) return { skipped: true };
      const out = typeof c.store.warm === 'function' ? await c.store.warm(opts) : { ok: true, ms: 0 };
      runtimeLog('price_cache_warm', { ok: out.ok, ms: out.ms });
      return out;
    } catch {
      return { ok: false };
    }
  },
  async lookupRecentPrices(keys, opts) {
    try {
      const c = priceCacheSettings(process.env).read ? activePriceCache() : null;
      return c ? await c.lookup(keys, opts) : (Array.isArray(keys) ? keys.map(() => null) : []);
    } catch {
      return Array.isArray(keys) ? keys.map(() => null) : [];
    }
  },
  setPriceCacheLog(fn) {
    runtimeLog = typeof fn === 'function' ? fn : defaultLog;
  },
  // Pure parts, for the readers and tests.
  priceCacheSettings,
  priceCacheKey,
  priceCacheDocId,
  normalizeCacheHost,
  normalizeVariantId,
  declaredMarket,
  verifiedPriceDoc,
  variantGoneDoc,
  servableAnswer,
  createPriceCache,
  activePriceCache,
  TTL_MS: Object.freeze({ search: 15 * 60 * 1000, recommend: 15 * 60 * 1000, get_product: 10 * 60 * 1000, pdp: 10 * 60 * 1000, get_offers: 0, cart: 0 }),
  HARD_EXPIRY_MS,
  TOMBSTONE_TTL_MS,
  UNCHANGED_REWRITE_MS,
  L1_TTL_MS,
  BACKOFF_L1_TTL_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  _setStoreFactoryForTest(fn) {
    storeFactory = typeof fn === 'function' ? fn : null;
    runtime = null;
  },
  _resetForTest() {
    runtime = null;
  },
};
