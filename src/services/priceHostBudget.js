'use strict';

/*
 * THE MERCHANT POLITENESS BUDGET (verified-price plan PR-3; design section 2.4): 60 merchant reads per minute per
 * host across the fleet, 25% of it kept for get_offers and the cart, so search can never starve the quote path.
 *
 * Firestore is not a counter store (one doc takes about one write a second), so the budget is two layers:
 *   - a TOKEN BUCKET per host in each instance, ceil(60 / PRICE_HOST_BUDGET_INSTANCES) reads a minute
 *     (instances default 4 = the service's min-instances -> 15 a minute), refilled continuously. A read of the
 *     reserved classes (offers, cart) may take the last token; any other read (search, product, pdp) only while
 *     more than 25% of the bucket is left;
 *   - the SHARED BACKOFF (services/priceCache.js host_backoff), honoured when the cache is on.
 *
 * PRICE_HOST_BUDGET (read per call, default off): off | shadow | on.
 *   off     nothing is counted; every read is admitted (today).
 *   shadow  counted, every read still admitted; what `on` would have refused goes to one
 *           `price_host_budget_shadow` line a minute.
 *   on      a read over the bucket is refused as `host_budget`, a read to a backed-off host as `host_backoff`;
 *           the caller treats it as a read that did not happen (the stored price stands).
 * It is its own flag ON PURPOSE: PRICE_CACHE_MODE=write must leave every answer byte-identical, and a refused
 * read changes one.
 */

const RESERVED = new Set(['offers', 'cart']);
const RESERVE_SHARE = 0.25;
const FLEET_READS_PER_MIN = 60;
const DEFAULT_INSTANCES = 4;
const MAX_HOSTS = 5000;
const SHADOW_LOG_EVERY_MS = 60 * 1000;
const MAX_LOGGED_HOSTS = 8;

function budgetMode(env = process.env) {
  const v = String((env && env.PRICE_HOST_BUDGET) || '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
}

/** Reads per minute per host for ONE instance: ceil(60 / PRICE_HOST_BUDGET_INSTANCES), instances 1..1000. */
function perInstanceReadsPerMinute(env = process.env) {
  const raw = String((env && env.PRICE_HOST_BUDGET_INSTANCES) || '').trim();
  const n = Number(raw);
  const instances = raw && Number.isFinite(n) && n >= 1 ? Math.min(1000, Math.floor(n)) : DEFAULT_INSTANCES;
  return Math.ceil(FLEET_READS_PER_MIN / instances);
}

/**
 * @param {{ capacity?: () => number, now?: () => number, reserveShare?: number, maxHosts?: number }} opts
 * @returns {{ take(host: string, klass: string): boolean, tokens(host: string): number }}
 */
function createHostTokenBuckets({ capacity = () => perInstanceReadsPerMinute(process.env), now = () => Date.now(), reserveShare = RESERVE_SHARE, maxHosts = MAX_HOSTS } = {}) {
  const buckets = new Map(); // host -> { tokens, at }
  function level(host, cap, t) {
    const b = buckets.get(host);
    if (!b) return cap;
    const refill = (Math.max(0, t - b.at) / 60000) * cap;
    return Math.min(cap, b.tokens + refill);
  }
  return {
    take(host, klass) {
      const key = String(host || '');
      if (!key) return true;
      const cap = Math.max(1, Number(capacity()) || 1);
      const t = now();
      const tokens = level(key, cap, t);
      // The reserve: a non-reserved read must leave at least reserveShare of the bucket behind.
      const floor = RESERVED.has(klass) ? 0 : cap * reserveShare;
      const ok = tokens - 1 >= floor - 1e-9;
      buckets.delete(key);
      buckets.set(key, { tokens: ok ? tokens - 1 : tokens, at: t });
      while (buckets.size > maxHosts) buckets.delete(buckets.keys().next().value);
      return ok;
    },
    tokens: (host) => level(String(host || ''), Math.max(1, Number(capacity()) || 1), now()),
  };
}

/**
 * The gate every merchant read asks first. `admit(host, klass)` -> null (go ahead) | 'host_budget' |
 * 'host_backoff'. Never throws (a broken gate admits).
 * @param {{ env?: () => object, now?: () => number, normalizeHost?: Function, sharedBackedOff?: Function, log?: Function }} deps
 */
function createHostReadGate(deps = {}) {
  const env = typeof deps.env === 'function' ? deps.env : () => process.env;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const normalizeHost = typeof deps.normalizeHost === 'function' ? deps.normalizeHost : (h) => String(h || '').toLowerCase();
  const sharedBackedOff = typeof deps.sharedBackedOff === 'function' ? deps.sharedBackedOff : () => false;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const buckets = deps.buckets || createHostTokenBuckets({ capacity: () => perInstanceReadsPerMinute(env()), now });
  let shadow = { since: now(), budget: 0, backoff: 0, hosts: new Map() };

  function flushShadow(t) {
    if (t - shadow.since < SHADOW_LOG_EVERY_MS) return;
    if (shadow.budget || shadow.backoff) {
      const hosts = [...shadow.hosts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_LOGGED_HOSTS);
      try {
        log('price_host_budget_shadow', {
          would_refuse_budget: shadow.budget,
          would_refuse_backoff: shadow.backoff,
          window_s: Math.round((t - shadow.since) / 1000),
          hosts: Object.fromEntries(hosts),
        });
      } catch {
        /* never costs a read */
      }
    }
    shadow = { since: t, budget: 0, backoff: 0, hosts: new Map() };
  }

  return {
    admit(rawHost, klass) {
      try {
        const mode = budgetMode(env());
        if (mode === 'off') return null;
        const host = normalizeHost(rawHost);
        if (!host) return null;
        const t = now();
        let refusal = null;
        if (sharedBackedOff(host)) refusal = 'host_backoff';
        // A backed-off host spends no token: the read is not made under `on`.
        else if (!buckets.take(host, klass)) refusal = 'host_budget';
        if (mode === 'on') return refusal;
        if (refusal) {
          shadow[refusal === 'host_budget' ? 'budget' : 'backoff'] += 1;
          if (shadow.hosts.has(host) || shadow.hosts.size < 64) shadow.hosts.set(host, (shadow.hosts.get(host) || 0) + 1);
        }
        flushShadow(t);
        return null;
      } catch {
        return null;
      }
    },
    buckets,
  };
}

let gate = null;
/** The process gate (built on first use; costs nothing while PRICE_HOST_BUDGET is off). */
function processHostReadGate() {
  if (!gate) {
    const priceCache = require('./priceCache');
    gate = createHostReadGate({
      normalizeHost: priceCache.normalizeCacheHost,
      sharedBackedOff: priceCache.sharedHostBackedOff,
      log: (event, fields) => {
        try {
          require('../logger').info({ event, ...fields }, event);
        } catch {
          /* ignored */
        }
      },
    });
  }
  return gate;
}

module.exports = {
  budgetMode,
  perInstanceReadsPerMinute,
  createHostTokenBuckets,
  createHostReadGate,
  processHostReadGate,
  RESERVED,
  RESERVE_SHARE,
  _resetForTest() {
    gate = null;
  },
};
