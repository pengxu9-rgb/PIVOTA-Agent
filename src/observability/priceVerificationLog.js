'use strict';

// HOW MUCH OF WHAT AN AGENT WAS QUOTED THE MERCHANT ACTUALLY CONFIRMED: one `price_verification_served` line
// per priced agent answer (search, get_product, get_offers, recommend_products, get_pdp_v2), and the door and
// caller on the live-read lines (`*_ucp_live_read`, pdp_live_read, get_offers events).
//
// WHY. Before this, coverage could not be measured: the search `.json` overlay logged nothing (its outcome
// lived only in the response's metadata.live_merchant_price), and the reader lines carried no door, agent or
// request id. The metrics in infra/gcp/monitoring/price_verification/ read this line:
// coverage = verified_count / total, per surface and door.
//
// LOG ONLY. PRICE_VERIFICATION_LOG (default off, read per call). Off: no line, no field, no header, nothing
// computed. On: the same responses, byte for byte (tests/price_verification_log_golden.node.test.cjs); only log
// lines change. Nothing here may throw into the request it measures.
//
// STATUS OF ONE PRICE, computed when the line is written (the rule the price-verification contract will
// publish):
//   live    the merchant answered DURING THIS REQUEST: a merchant answer (priceVerificationFacts) stamped at
//           or after the request started.
//   recent  the merchant answered BEFORE this request, within the surface's window (search and recommend
//           15 min, get_product and the PDP 10 min, get_offers 0): a per-instance cache, or an MCP read-cache
//           replay, which still says price_source 'merchant_live'. A replay is NEVER live, however fresh its
//           stamp: the merchant answered the request that filled the cache, not this one.
//   stored  everything else: Pivota's catalog copy, an older answer, or one with no time.
//   A search card the `.json` overlay answered from its per-instance cache (another request's read) is never
//   live either, even when that read landed after this request started (a concurrent burst): the overlay notes
//   each such answer's stamp (noteSearchOverlay) and the line counts a matching fact as a replay.
//   What dates an answer, and why `live` allows a reader memo's ~30 s: priceVerificationFacts (WHEN THE
//   MERCHANT ANSWERED). Which prices a door counts at all: priceVerificationFacts (WHAT COUNTS).
//
// WHERE EACH LINE IS WRITTEN: at the door that answered the agent, once.
//   MCP doors (mcp, ucp_mcp, public_mcp): from the facts the MCP surface read off the NATIVE tool value (the
//     UCP shaper and the public projection strip the price fields), handed over through the door's `observe`
//     channel. A read-cache replay carries the facts it was computed with.
//   invoke / REST (find_products_multi, get_pdp_v2): from the final body, in the invoke handler's res.json.
//   A loopback invoke (an MCP door's search, unscoped get_product, recommend's price checks) writes NO served
//     line: its door's line counts that answer. It reports the search overlay's time and skip reason to its
//     door's context instead (same process: the door's context is found by request id).
//
// REQUEST CONTEXT. An AsyncLocalStorage store opened at each door carries the door, the request id, the start
// time and the req (its caller is resolved after the door opens, so tier and agent are read when a line is
// written). The loopback call carries the context in X-Pivota-Price-Context, honoured only on a loopback
// self-call (callerLogFields.isLoopbackSelfCall) and only as log labels. The door is found by `door_key`, a
// random id this process mints when the door opens, never by request_id: request_id is the Cloud Run trace id,
// which a client can set, so two requests sending one trace id would otherwise share (and overwrite) one entry.
//
// FLIPPING THE FLAG ON. The public tier computes its facts with the answer and caches them with it
// (publicReadToolSurface), so an entry computed while the flag was off carries none: its replays write no line
// until it is recomputed, at most PUBLIC_READ_CACHE_STALE_MS (default 60 min) after the flip. The commerce
// surface computes its facts from the value on every call, so its replays are counted at once.

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { isLoopbackSelfCall, callerLogFields } = require('../attribution/callerLogFields');
const { mcpCallerTier } = require('./mcpToolCallOutcome');
const { FLAG, priceVerificationLogEnabled, priceFactOf, TOOL_SURFACES } = require('./priceVerificationFacts');

const EVENT = 'price_verification_served';
const CONTEXT_HEADER = 'X-Pivota-Price-Context';

const DOORS = new Set(['public_mcp', 'mcp', 'ucp_mcp', 'rest', 'invoke']);
const SURFACES = new Set(['search', 'get_product', 'get_offers', 'recommend_products', 'get_pdp_v2']);
const TIERS = new Set(['public', 'first_party', 'authenticated', 'unauthenticated', 'unknown']);
// The window a merchant answer counts as `recent` in (verified-price design, TTL decision 2026-10-22).
const TTL_MS = Object.freeze({
  search: 15 * 60 * 1000,
  recommend_products: 15 * 60 * 1000,
  get_product: 10 * 60 * 1000,
  get_pdp_v2: 10 * 60 * 1000,
  get_offers: 0,
});
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const MAX_THROTTLED_HOSTS = 8;
const MAX_ITEMS = 500;
// Door contexts a loopback call may report to, by request id. Same process only; bounded.
const OPEN_DOORS_MAX = 2000;

const als = new AsyncLocalStorage();
const openDoors = new Map(); // door_key -> store
const DOOR_KEY = /^[a-f0-9]{24}$/;

function token(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && TOKEN.test(s) ? s : null;
}

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function requestIdOf(req) {
  // Cloud Run's trace id ties this line to the request log; a loopback call carries its door's id instead.
  const trace = req && req.headers && req.headers['x-cloud-trace-context'];
  const id = typeof trace === 'string' ? trace.split('/')[0].trim() : '';
  return /^[A-Fa-f0-9]{8,64}$/.test(id) ? id.toLowerCase() : crypto.randomBytes(8).toString('hex');
}

/** The context an MCP door's loopback call carried, when it is a real loopback self-call; null otherwise. */
function inheritedContext(req) {
  try {
    if (!req || !isLoopbackSelfCall(req)) return null;
    const raw = req.headers && req.headers[CONTEXT_HEADER.toLowerCase()];
    if (typeof raw !== 'string' || raw.length > 512) return null;
    const out = {};
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq).trim();
      let v;
      try {
        v = token(decodeURIComponent(part.slice(eq + 1)));
      } catch {
        v = null;
      }
      if (!v) continue;
      if (k === 'door' && DOORS.has(v)) out.door = v;
      else if (k === 'tier' && TIERS.has(v)) out.tier = v;
      else if (k === 'caller_class') out.caller_class = v;
      else if (k === 'agent_id') out.agent_id = v;
      else if (k === 'request_id') out.request_id = v;
      else if (k === 'door_key' && DOOR_KEY.test(v)) out.door_key = v;
      else if (k === 'started_at_ms' && /^\d{10,16}$/.test(v)) out.started_at_ms = Number(v);
    }
    return out.door ? out : null;
  } catch {
    return null;
  }
}

function storeFor(req, door) {
  const inherited = inheritedContext(req);
  if (inherited) {
    return {
      ...inherited,
      req: null,
      via_loopback: true,
      started_at_ms: inherited.started_at_ms || Date.now(),
      // The door's own context, when that door is in this process and still open.
      parent: (inherited.door_key && openDoors.get(inherited.door_key)) || null,
    };
  }
  return { door, req, request_id: requestIdOf(req), door_key: crypto.randomBytes(12).toString('hex'), started_at_ms: Date.now() };
}

/**
 * Run `fn` inside a price context for `door` (an MCP door, whose loopback calls may report back to it).
 * Off: `fn()` exactly. Never throws on its own account.
 */
function runWithPriceDoor(req, door, fn) {
  if (!priceVerificationLogEnabled()) return fn();
  let store;
  try {
    store = storeFor(req, door);
  } catch {
    return fn();
  }
  if (store.via_loopback || !store.door_key) return als.run(store, fn);
  openDoors.set(store.door_key, store);
  if (openDoors.size > OPEN_DOORS_MAX) openDoors.delete(openDoors.keys().next().value);
  const close = () => {
    if (openDoors.get(store.door_key) === store) openDoors.delete(store.door_key);
  };
  let out;
  try {
    out = als.run(store, fn);
  } catch (e) {
    close();
    throw e;
  }
  if (out && typeof out.then === 'function') out.then(close, close);
  else close();
  return out;
}

/** Express middleware: the request runs inside a price context for `door` (invoke, rest). Off: next(). */
function priceContextMiddleware(door) {
  return function priceContext(req, res, next) {
    if (!priceVerificationLogEnabled()) return next();
    let store;
    try {
      store = storeFor(req, door);
    } catch {
      return next();
    }
    return als.run(store, next);
  };
}

/** Run `fn` inside a price context (tests). */
function runWithPriceContext(ctx, fn) {
  return als.run({ started_at_ms: Date.now(), request_id: crypto.randomBytes(8).toString('hex'), ...ctx }, fn);
}

function currentPriceContext() {
  return als.getStore() || null;
}

/** Where this request's live work is recorded: the door's context for a loopback call, else its own. */
function recordTarget() {
  const store = currentPriceContext();
  if (!store) return null;
  return store.parent || store;
}

function addLiveSpan(target, startedAt, endedAt) {
  // Live work of one answer can overlap (parallel price checks): `added_ms` is the span it covered, from the
  // first read's start to the last one's end, never the sum.
  target.live_first_ms = Math.min(target.live_first_ms ?? startedAt, startedAt);
  target.live_last_ms = Math.max(target.live_last_ms ?? endedAt, endedAt);
}

/**
 * Time live price work this answer waited for (a promise; a plain value passes through). Returns `result`
 * itself when off or outside a context (the same object), else a promise of the same value.
 */
function trackLiveWork(result) {
  try {
    if (!priceVerificationLogEnabled() || !result || typeof result.then !== 'function') return result;
    const target = recordTarget();
    if (!target) return result;
    const startedAt = Date.now();
    const done = () => addLiveSpan(target, startedAt, Date.now());
    return result.then((value) => { done(); return value; }, (err) => { done(); throw err; });
  } catch {
    return result;
  }
}

/**
 * The search `.json` overlay's run in this request: why it did not run (`flag_off`, `page_gt_1`,
 * `budget_constraint`), or how long it took. Returns `result` (see trackLiveWork).
 */
function trackSearchOverlay(result, { skipped = null } = {}) {
  try {
    if (!priceVerificationLogEnabled()) return result;
    const target = recordTarget();
    if (!target) return result;
    target.search_overlay_calls = (target.search_overlay_calls || 0) + 1;
    if (skipped) {
      target.search_overlay_skipped = skipped;
      return result;
    }
    return trackLiveWork(result);
  } catch {
    return result;
  }
}

/**
 * What the search `.json` overlay saw that only the line needs (liveMerchantSearchPrice; never in the answer):
 * per host, the reads refused with a 429 / 5xx or skipped for a host backoff; and the stamp (price_as_of) of
 * each card it verified from its per-instance cache. Off or outside a context: nothing. Never throws.
 */
function noteSearchOverlay({ throttledHosts, cachedAnswerStamps } = {}) {
  try {
    if (!priceVerificationLogEnabled()) return;
    const target = recordTarget();
    if (!target) return;
    if (isObj(throttledHosts)) {
      for (const [host, n] of Object.entries(throttledHosts)) {
        if (!HOST.test(host) || !(Number.isInteger(n) && n > 0)) continue;
        if (!target.search_overlay_throttled_hosts) target.search_overlay_throttled_hosts = {};
        const hosts = target.search_overlay_throttled_hosts;
        if (!(host in hosts) && Object.keys(hosts).length >= 64) continue;
        hosts[host] = (hosts[host] || 0) + n;
      }
    }
    if (Array.isArray(cachedAnswerStamps)) {
      if (!target.search_overlay_cached_at) target.search_overlay_cached_at = [];
      for (const raw of cachedAnswerStamps) {
        const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
        if (Number.isFinite(at) && target.search_overlay_cached_at.length < MAX_ITEMS) target.search_overlay_cached_at.push(at);
      }
    }
  } catch {
    /* measurement only */
  }
}

/**
 * A tag for this request's search overlay reads (the door's key; a loopback call reports to its door), so a cache
 * entry this same request filled is not counted as another request's read. null when off or outside a context.
 */
function searchOverlayRequestTag() {
  try {
    if (!priceVerificationLogEnabled()) return null;
    const target = recordTarget();
    if (!target) return null;
    if (!target.overlay_tag) target.overlay_tag = target.door_key || crypto.randomBytes(12).toString('hex');
    return target.overlay_tag;
  } catch {
    return null;
  }
}

/** The noted hosts as a log field: the 8 with the most refusals (ties by name), or null when none. */
function throttledHostsField(hosts) {
  if (!isObj(hosts)) return null;
  const top = Object.entries(hosts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_THROTTLED_HOSTS);
  return top.length ? Object.fromEntries(top) : null;
}

function callerOf(store) {
  if (!store) return {};
  if (!store.req) {
    return { tier: store.tier || 'unknown', caller_class: store.caller_class || null, agent_id: store.agent_id || null };
  }
  const caller = callerLogFields(store.req);
  return {
    tier: mcpCallerTier(store.req, store.door),
    caller_class: token(caller.caller_auth_mode),
    agent_id: token(caller.caller_agent_id) || token(caller.caller_oauth_client_id),
  };
}

/**
 * Door, caller and request id for a live-read line. {} when the flag is off or the read runs outside any
 * request (a background job). Never throws.
 */
function priceContextLogFields(env = process.env) {
  try {
    if (!priceVerificationLogEnabled(env)) return {};
    const store = currentPriceContext();
    if (!store) return {};
    const c = callerOf(store);
    return {
      door: store.door || null,
      tier: c.tier,
      caller_class: c.caller_class,
      agent_id: c.agent_id,
      request_id: store.request_id || null,
      ...(store.via_loopback ? { via_loopback: true } : {}),
    };
  } catch {
    return {};
  }
}

/** The header a loopback invoke call carries so its lines name the door and caller that asked. */
function priceContextHeaders(env = process.env) {
  try {
    if (!priceVerificationLogEnabled(env)) return {};
    const store = currentPriceContext();
    if (!store || !store.door) return {};
    const c = callerOf(store);
    const parts = [
      ['door', store.door], ['tier', c.tier], ['caller_class', c.caller_class], ['agent_id', c.agent_id],
      ['request_id', store.request_id], ['door_key', store.door_key],
      ['started_at_ms', String(store.started_at_ms || '')],
    ].filter(([, v]) => token(v)).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    return { [CONTEXT_HEADER]: parts.join(';') };
  } catch {
    return {};
  }
}

/**
 * 'live' | 'recent' | 'stored' for one fact (priceVerificationFacts.priceFactOf), or null when it carries no
 * price (not counted). Pure.
 */
function classifyFact(fact, { startedAtMs, nowMs = Date.now(), ttlMs = 0, replay = false } = {}) {
  if (!isObj(fact) || fact.priced !== true) return null;
  if (fact.merchant !== true || !Number.isFinite(fact.at)) return 'stored';
  // One second of slack: an answer stamped while the request was being admitted is still this request's. A
  // replay is never live: a cache entry filled half a second ago still answered another request.
  if (!replay && Number.isFinite(startedAtMs) && fact.at >= startedAtMs - 1000) return 'live';
  return ttlMs > 0 && nowMs - fact.at <= ttlMs ? 'recent' : 'stored';
}

/** As classifyFact, for a priced object. */
function classifyPrice(item, o) {
  return classifyFact(priceFactOf(item), o);
}

/**
 * { live, recent, stored, total } over facts. Pure. `o.cachedAt` (epoch ms, one per answer the search overlay
 * served from its cache): a fact that would be live and carries one of those stamps is counted as a replay,
 * each stamp once; `cache_not_live` says how many were.
 */
function countFacts(facts, o = {}) {
  const counts = { live: 0, recent: 0, stored: 0, total: 0 };
  if (!Array.isArray(facts)) return counts;
  let cached = null;
  if (Array.isArray(o.cachedAt) && o.cachedAt.length) {
    cached = new Map();
    for (const at of o.cachedAt) if (Number.isFinite(at)) cached.set(at, (cached.get(at) || 0) + 1);
    counts.cache_not_live = 0;
  }
  for (const fact of facts.slice(0, MAX_ITEMS)) {
    let status = classifyFact(fact, o);
    if (!status) continue;
    if (status === 'live' && cached && cached.get(fact.at) > 0) {
      cached.set(fact.at, cached.get(fact.at) - 1);
      status = classifyFact(fact, { ...o, replay: true });
      counts.cache_not_live += 1;
    }
    counts[status] += 1;
    counts.total += 1;
  }
  return counts;
}

function nonNegInt(v) {
  return Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Why a search answer's prices were not overlaid in this request, or null when the overlay ran here and did not
 * skip. `lane_not_overlaid` only when the answer carries no overlay outcome at all (the lane never calls the
 * overlay). An answer that carries one although this request recorded no overlay call was overlaid by another
 * request's compute (a cache revalidation, or a door context the loopback could not find): its own skip reason,
 * else `overlay_not_observed`.
 */
function searchSkipReason(work, overlayOutcome) {
  if (!work.overlay_calls) {
    if (!isObj(overlayOutcome)) return 'lane_not_overlaid';
    return token(overlayOutcome.skipped_reason) || 'overlay_not_observed';
  }
  return work.overlay_skipped || (isObj(overlayOutcome) ? token(overlayOutcome.skipped_reason) : null) || null;
}

/**
 * The search `.json` overlay's outcome (metadata.live_merchant_price, or its compact copy from
 * priceVerificationFacts.overlayOutcomeOf) as flat `overlay_*` log fields.
 */
function searchOverlayLogFields(liveMerchantPrice) {
  const m = isObj(liveMerchantPrice) ? liveMerchantPrice : null;
  if (!m) return { overlay_ran: false };
  const out = { overlay_ran: m.attempted === true };
  const skipped = token(m.skipped_reason);
  if (skipped) out.overlay_skipped_reason = skipped;
  const ints = {
    overlay_eligible: m.eligible_count, overlay_fetch_attempts: m.fetch_attempt_count,
    overlay_cache_hits: m.cache_hit_count, overlay_verified: m.verified_count, overlay_drifted: m.drift_count,
    overlay_gone: m.gone_count, overlay_dropped_gone: m.dropped_gone_count,
  };
  for (const [k, v] of Object.entries(ints)) if (nonNegInt(v) !== undefined) out[k] = v;
  if (m.deadline_exceeded === true) out.overlay_deadline_exceeded = true;
  if (isObj(m.failure_reasons)) {
    const reasons = {};
    for (const [k, v] of Object.entries(m.failure_reasons).slice(0, 20)) {
      if (TOKEN.test(k) && nonNegInt(v) !== undefined) reasons[k] = v;
    }
    if (Object.keys(reasons).length) out.overlay_failure_reasons = reasons;
  }
  if (isObj(m.ucp)) {
    out.overlay_ucp = {
      mode: token(m.ucp.mode),
      planned: nonNegInt(m.ucp.planned_count) ?? null,
      settled: nonNegInt(m.ucp.settled_count) ?? null,
      verified: nonNegInt(m.ucp.verified_count) ?? null,
    };
  }
  return out;
}

/** What this request recorded about live work (its own, and its loopback calls'). */
function recordedLiveWork(store) {
  if (!store) return { added_ms: 0, overlay_calls: 0, overlay_skipped: null };
  const span = Number.isFinite(store.live_first_ms) && Number.isFinite(store.live_last_ms)
    ? Math.max(0, store.live_last_ms - store.live_first_ms) : 0;
  return {
    added_ms: span,
    overlay_calls: store.search_overlay_calls || 0,
    overlay_skipped: store.search_overlay_skipped || null,
  };
}

/**
 * Write one `price_verification_served` line. Give either `items` (priced objects as served) or `facts`
 * (priceVerificationFacts). Off: nothing. Never throws.
 *
 * @param {{ info: Function }} logger
 * @param {{ surface: string, items?: object[], facts?: object[], market?: string, added_ms?: number,
 *   skipped_reason?: string, extra?: object, door?: string, env?: object, nowMs?: number, replay?: boolean }} f
 *   replay: the facts are a read-cache replay's (never live).
 */
function logPriceVerificationServed(logger, f = {}) {
  try {
    const env = f.env || process.env;
    if (!priceVerificationLogEnabled(env)) return false;
    if (!logger || typeof logger.info !== 'function' || !SURFACES.has(f.surface)) return false;
    const store = currentPriceContext();
    const nowMs = Number.isFinite(f.nowMs) ? f.nowMs : Date.now();
    const startedAtMs = store && Number.isFinite(store.started_at_ms) ? store.started_at_ms : nowMs;
    const facts = Array.isArray(f.facts)
      ? f.facts
      : (Array.isArray(f.items) ? f.items.slice(0, MAX_ITEMS).map(priceFactOf) : []);
    const replay = f.replay === true;
    // What this request's search overlay noted (noteSearchOverlay). A replay ran no overlay of its own.
    const overlay = f.surface === 'search' && !replay && store ? store : null;
    const counts = countFacts(facts, {
      startedAtMs, nowMs, ttlMs: TTL_MS[f.surface], replay,
      cachedAt: overlay ? overlay.search_overlay_cached_at : null,
    });
    const throttled = overlay ? throttledHostsField(overlay.search_overlay_throttled_hosts) : null;
    const ctx = priceContextLogFields(env);
    const door = DOORS.has(f.door) ? f.door : (ctx.door || 'unknown');
    const market = token(f.market);
    const added = Number(f.added_ms);
    logger.info(
      {
        event: EVENT,
        surface: f.surface,
        door,
        tier: ctx.tier || 'unknown',
        caller_class: ctx.caller_class || null,
        agent_id: ctx.agent_id || null,
        request_id: ctx.request_id || null,
        market: market ? market.toUpperCase() : null,
        live: counts.live,
        recent: counts.recent,
        stored: counts.stored,
        verified_count: counts.live + counts.recent,
        total: counts.total,
        added_ms: Number.isFinite(added) && added >= 0 ? Math.round(added) : 0,
        skipped_reason: token(f.skipped_reason),
        ...(isObj(f.extra) ? f.extra : {}),
        // Search only, and only when non-zero: overlay answers from the per-instance cache counted as recent or
        // stored instead of live; the hosts that refused (429 / 5xx) or were skipped for a backoff, by count.
        ...(counts.cache_not_live ? { overlay_cache_not_live: counts.cache_not_live } : {}),
        ...(throttled ? { overlay_throttled_hosts: throttled } : {}),
      },
      EVENT,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The MCP door's half: collects the price facts the surface hands to `observe`, then writes the line for
 * the tool call. `create` returns null when off, so the door's observe stays the recorder's own.
 */
function createMcpPriceCapture() {
  if (!priceVerificationLogEnabled()) return null;
  let facts = null;
  let cacheHit;
  return {
    note(fields) {
      try {
        if (!isObj(fields)) return;
        if (isObj(fields.price_facts)) facts = fields.price_facts;
        if ('cache_hit' in fields) cacheHit = fields.cache_hit;
      } catch {
        /* measurement only */
      }
    },
    /**
     * @param {{ info: Function }} logger
     * @param {{ door: string, out: object, market?: string }} o  out: the adapter's JSON-RPC answer
     */
    log(logger, { door, out, market } = {}) {
      try {
        if (!facts || !TOOL_SURFACES[facts.tool]) return false;
        const result = out && isObj(out.body) ? out.body.result : null;
        if (!isObj(result) || result.isError === true) return false;
        const store = currentPriceContext();
        const work = recordedLiveWork(store);
        const replay = cacheHit === true || cacheHit === 'stale';
        let skipped = null;
        if (facts.surface === 'search') {
          skipped = replay ? 'mcp_read_cache_replay' : searchSkipReason(work, facts.overlay);
        } else if (replay) {
          skipped = 'mcp_read_cache_replay';
        }
        return logPriceVerificationServed(logger, {
          surface: facts.surface,
          door,
          facts: facts.items,
          market: (!replay && store && store.search_market) || facts.market || market,
          // A replay waited for nothing live, and none of its prices is live.
          added_ms: replay ? 0 : work.added_ms,
          replay,
          skipped_reason: skipped,
          extra: {
            ...(cacheHit !== undefined ? { cache_hit: cacheHit } : {}),
            ...(facts.surface === 'search' ? searchOverlayLogFields(facts.overlay) : {}),
          },
        });
      } catch {
        return false;
      }
    },
  };
}

/** This MCP door's price capture (one per request), or null when off, outside a door, or on a loopback. */
function mcpPriceCapture() {
  try {
    if (!priceVerificationLogEnabled()) return null;
    const store = currentPriceContext();
    if (!store || store.via_loopback) return null;
    if (!store.mcp_capture) store.mcp_capture = createMcpPriceCapture();
    return store.mcp_capture;
  } catch {
    return null;
  }
}

/** The tool call's line, from the facts its surface handed over (see createMcpPriceCapture). Never throws. */
function logMcpPriceVerificationServed(logger, out, { market } = {}) {
  try {
    const store = currentPriceContext();
    const capture = store && !store.via_loopback ? store.mcp_capture : null;
    if (!capture) return false;
    return capture.log(logger, { door: store.door, out, market });
  } catch {
    return false;
  }
}

module.exports = {
  FLAG,
  EVENT,
  CONTEXT_HEADER,
  TTL_MS,
  priceVerificationLogEnabled,
  priceContextMiddleware,
  runWithPriceDoor,
  runWithPriceContext,
  currentPriceContext,
  recordedLiveWork,
  trackLiveWork,
  trackSearchOverlay,
  noteSearchOverlay,
  searchOverlayRequestTag,
  priceContextLogFields,
  priceContextHeaders,
  inheritedContext,
  classifyFact,
  classifyPrice,
  countFacts,
  searchOverlayLogFields,
  searchSkipReason,
  logPriceVerificationServed,
  createMcpPriceCapture,
  mcpPriceCapture,
  logMcpPriceVerificationServed,
  _openDoors: openDoors,
};
