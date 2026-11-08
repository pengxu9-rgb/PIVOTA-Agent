'use strict';

/*
 * RECOMMENDATION PRICE TIERS ON LIST ROWS (FIX_PLAN Phase 1 item 1.17; D-03 / D-16).
 *
 * THE RULE. Search and recommend lists use a RECENT price and never block on live reads; the live check runs where
 * the buyer acts on one product (get_product, get_offers), and the merchant's own cart price is final. This module
 * is the list half: it says, on every search / recommend_products / get_alternatives row, how old the price is
 * and where it came from, and keeps a price nobody has read for a week from being the answer.
 *
 * FLAGS (read per call; both default off, and off this module changes nothing at all):
 *   LIST_ROW_PRICE_AS_OF     off | on
 *     on   every list row carries `price_as_of` (ISO-8601 UTC, or null when nothing dates the price) and
 *          `price_source`, one token:
 *            live    the merchant answered during this request (search: the `.json` overlay or the UCP catalog
 *                    read, internal price_source 'merchant_live'; recommend: the PDP's merchant answer);
 *            cache   the fleet's verified-price cache answered (services/priceCache.js, PRICE_CACHE_MODE=read;
 *                    internal price_source 'merchant_cache'), read within its 15-min window;
 *            stored  anything else: our stored copy, dated by the freshest read the backend gave us, in this
 *                    order: the row's own `price_as_of` (the canonical lane's catalog_offers.price_checked_at,
 *                    CANONICAL_CATALOG_SERVED_PRICE_AS_OF), its `price_checked_at`, then a seed row's
 *                    seed_data.snapshot.extracted_at (the seed refresh's last price read: set when it re-read
 *                    the price, removed when it refused one; pivota-backend routes/employee_products.py); else
 *                    null.
 *          On a row this token REPLACES the internal provenance value (merchant_live / catalog_offer / ...): the
 *          served row speaks the three-token contract, the internal names never leave.
 *   PRICE_STALENESS_DEMOTE   off | shadow | on
 *     A PRICED row is STALE when its price_as_of is older than STALE_AFTER_MS (7 days), or when nothing dates it
 *     (an undated stored price cannot be shown to be fresh; the shadow line counts those apart, `undated`).
 *     on      a stale row carries `price_may_have_changed: true`, and is DEMOTED: its rank key is its position
 *             plus STALE_RANK_PENALTY (2.5), then a stable sort -- so it falls behind at most the next two fresh
 *             rows and never past a third (a small penalty: relevance still dominates). On a CHEAPEST or
 *             PRICE-CAPPED query a stale row is never the answer: every fresh row is served ahead of every stale
 *             one (stable partition). If no row is fresh the order stands (the answer is never emptied) and the
 *             summary says `no_fresh_row`.
 *     shadow  nothing served changes; one `list_price_staleness_shadow` line per list says what would move:
 *             counts and positions only, never a price, a host or a product id (the price-log rules).
 *
 * WHAT A CHEAPEST OR PRICE-CAPPED QUERY IS (the callers decide; isCheapestQuery is the text half):
 *   search             a budget constraint (price_min / price_max, or one the intent parser read from the query,
 *                      resolveBeautyMainlineBudgetConstraint) -- the mainline filters on STORED prices and ranks
 *                      by relevance, never by price, so the cap was judged on the stored number -- or a query
 *                      that asks for the cheapest (isCheapestQuery).
 *   recommend_products an enforcing price_max ceiling, or a need that asks for the cheapest.
 *   get_alternatives   max_price_ratio (equal-or-cheaper) or relation 'dupe' (the value-seeking ask).
 *
 * Pure apart from the optional `log`; the rows are copied, never mutated (search rows can be shared by caches).
 */

const LIST_FLAG = 'LIST_ROW_PRICE_AS_OF';
const STALENESS_FLAG = 'PRICE_STALENESS_DEMOTE';
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_RANK_PENALTY = 2.5;
// A stamp this far in the future is another clock's error, not a fresh read.
const CLOCK_SKEW_MS = 5 * 1000;
const TOKENS = new Set(['live', 'cache', 'stored']);
const INTERNAL_LIVE = new Set(['merchant_live']);
const INTERNAL_CACHE = new Set(['merchant_cache']);

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function listRowPriceAsOfEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(str(env && env[LIST_FLAG]));
}

function priceStalenessMode(env = process.env) {
  const v = str(env && env[STALENESS_FLAG]).toLowerCase();
  if (v === 'shadow') return 'shadow';
  return /^(1|true|yes|on|enabled)$/.test(v) ? 'on' : 'off';
}

/** Whether anything in this module runs for this request (else every caller leaves its answer untouched). */
function listPriceTiersActive(env = process.env) {
  return listRowPriceAsOfEnabled(env) || priceStalenessMode(env) !== 'off';
}

// "cheapest", "the lowest price", "least expensive", 最便宜 / 最低价. "cheap" alone is an adjective of the product
// (a "cheap dupe"), not a request to be answered with the minimum.
const CHEAPEST_RE = /\b(?:cheapest|lowest[\s-]+(?:price|priced|cost)|least[\s-]+expensive|most[\s-]+affordable)\b|最便宜|最低价|最低價/i;

function isCheapestQuery(text) {
  return CHEAPEST_RE.test(str(text));
}

/** An ISO-8601 instant as its UTC ISO string, or null (unparseable, or in the future past the skew). */
function isoOrNull(raw, nowMs) {
  if (raw === undefined || raw === null || raw === '') return null;
  let ms = NaN;
  if (raw instanceof Date) ms = raw.getTime();
  else if (typeof raw === 'string') ms = /^\d{4}-\d{2}-\d{2}T/.test(raw.trim()) ? Date.parse(raw.trim()) : NaN;
  if (!Number.isFinite(ms) || ms > nowMs + CLOCK_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/** A seed row's last price read: seed_data.snapshot.extracted_at, or undefined. */
function seedReadAt(node) {
  const seed = isObj(node.seed_data) ? node.seed_data : null;
  const snap = seed && isObj(seed.snapshot) ? seed.snapshot : null;
  return snap ? snap.extracted_at : undefined;
}

function amountOf(node) {
  for (const v of [node.price, node.price_amount]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
    if (isObj(v)) {
      const cur = isObj(v.current) ? v.current.amount : v.amount;
      if (cur !== undefined && cur !== null && Number.isFinite(Number(cur))) return Number(cur);
    }
  }
  return null;
}

/**
 * The tier of one priced node: { price_source, price_as_of, priced, stale, undated }. Pure.
 * `hint` (optional) is what the caller knows that the node does not say: { live?: boolean, as_of?: string }.
 */
function priceTierOf(node, { nowMs = Date.now(), hint = null } = {}) {
  const n = isObj(node) ? node : {};
  const internal = str(n.price_source);
  let source;
  if (TOKENS.has(internal)) source = internal;
  else if (INTERNAL_LIVE.has(internal) || (hint && hint.live === true)) source = 'live';
  else if (INTERNAL_CACHE.has(internal)) source = 'cache';
  else source = 'stored';
  const candidates = source === 'stored'
    ? [hint && hint.as_of, n.price_as_of, n.price_checked_at, seedReadAt(n)]
    : [hint && hint.as_of, n.price_as_of];
  let asOf = null;
  for (const raw of candidates) {
    asOf = isoOrNull(raw, nowMs);
    if (asOf) break;
  }
  const amount = amountOf(n);
  const priced = amount !== null && amount > 0;
  const undated = asOf === null;
  const stale = priced && (undated || nowMs - Date.parse(asOf) > STALE_AFTER_MS);
  return { price_source: source, price_as_of: asOf, priced, stale, undated: priced && undated };
}

/**
 * The order a list takes under the staleness rule: indexes into `tiers`. Pure.
 * `answerGuard` (cheapest / price-capped): every fresh row ahead of every stale row. Otherwise the positional
 * penalty: key = index + STALE_RANK_PENALTY for a stale row, stable.
 */
function stalenessOrder(tiers, { answerGuard = false } = {}) {
  const idx = tiers.map((_, i) => i);
  if (answerGuard) {
    const fresh = idx.filter((i) => !tiers[i].stale);
    if (!fresh.length) return idx;
    return [...fresh, ...idx.filter((i) => tiers[i].stale)];
  }
  return idx
    .map((i) => ({ i, key: i + (tiers[i].stale ? STALE_RANK_PENALTY : 0) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.i);
}

/**
 * Apply the flags to one list. Returns { rows, summary } where `rows` IS `rows` (same array) when nothing changes,
 * and `summary` is null when both flags are off.
 *
 * @param {Array} rows
 * @param {{
 *   node?: (row) => object|null,          the priced object of a row (search: the row; recommend: value.product;
 *                                         alternatives: value.related)
 *   withNode?: (row, node) => object,     a copy of `row` carrying `node`
 *   hint?: (row, index) => object|null,   see priceTierOf
 *   answerGuard?: boolean,                a cheapest / price-capped list
 *   surface?: string, env?: object, nowMs?: number, log?: (event, fields) => void,
 * }} opts
 */
function applyListPriceTiers(rows, opts = {}) {
  const env = opts.env || process.env;
  const asOfOn = listRowPriceAsOfEnabled(env);
  const mode = priceStalenessMode(env);
  if (!Array.isArray(rows) || (!asOfOn && mode === 'off')) return { rows, summary: null };
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const nodeOf = typeof opts.node === 'function' ? opts.node : (row) => row;
  const withNode = typeof opts.withNode === 'function' ? opts.withNode : (_row, node) => node;
  const answerGuard = opts.answerGuard === true;
  const tiers = rows.map((row, i) => {
    let hint = null;
    try {
      hint = typeof opts.hint === 'function' ? opts.hint(row, i) : null;
    } catch {
      hint = null;
    }
    return priceTierOf(nodeOf(row), { nowMs, hint });
  });
  const order = mode === 'off' ? null : stalenessOrder(tiers, { answerGuard });
  const moved = order ? order.reduce((n, from, to) => n + (from !== to ? 1 : 0), 0) : 0;
  const summary = {
    surface: str(opts.surface) || null,
    mode,
    as_of: asOfOn,
    rows: rows.length,
    priced: tiers.filter((t) => t.priced).length,
    stale: tiers.filter((t) => t.stale).length,
    undated: tiers.filter((t) => t.undated).length,
    by_source: tiers.reduce((acc, t) => { acc[t.price_source] = (acc[t.price_source] || 0) + 1; return acc; }, {}),
    answer_guard: answerGuard,
    moved,
    top_was_stale: tiers.length > 0 && tiers[0].stale,
    no_fresh_row: tiers.some((t) => t.priced) && tiers.every((t) => !t.priced || t.stale),
  };
  if (mode === 'shadow' && typeof opts.log === 'function') {
    try {
      opts.log('list_price_staleness_shadow', summary);
    } catch {
      /* the line never costs the answer */
    }
  }
  const relabel = asOfOn || mode === 'on';
  if (!relabel) return { rows, summary };
  const stamped = rows.map((row, i) => {
    const node = nodeOf(row);
    if (!isObj(node)) return row;
    const next = { ...node };
    if (asOfOn) {
      next.price_as_of = tiers[i].price_as_of;
      next.price_source = tiers[i].price_source;
    }
    if (mode === 'on' && tiers[i].stale) next.price_may_have_changed = true;
    return withNode(row, next);
  });
  return { rows: mode === 'on' ? order.map((i) => stamped[i]) : stamped, summary };
}

module.exports = {
  LIST_FLAG,
  STALENESS_FLAG,
  STALE_AFTER_MS,
  STALE_RANK_PENALTY,
  listRowPriceAsOfEnabled,
  priceStalenessMode,
  listPriceTiersActive,
  isCheapestQuery,
  isoOrNull,
  priceTierOf,
  stalenessOrder,
  applyListPriceTiers,
};
