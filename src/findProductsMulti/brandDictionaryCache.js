'use strict';

// Catalog-wide brand dictionary for find_products_multi brand detection.
//
// brandLexicon's dynamic detection is bootstrapped from the RECALLED candidate
// products (collectDynamicBrandAliases) — a chicken-and-egg: if the initial
// recall misses a brand's products, the brand isn't detected, so it can't be
// brand-scoped, so recall keeps missing them (e.g. "The Ordinary Niacinamide"
// fell to ingredient recall + off-brand external-seed junk). This caches the
// catalog's OWN brand set (catalog_products.brand) so detection can recognize a
// brand even when the initial candidates don't include it.
//
// Flag-gated by GATEWAY_DYNAMIC_BRAND_DETECT (default OFF): when off the set
// stays empty and matchCatalogBrand returns null, so brand detection is
// byte-identical to today. Best-effort + TTL'd; never throws into the hot path.

const TTL_MS = Number(process.env.GATEWAY_DYNAMIC_BRAND_TTL_MS || 3600000) || 3600000;
const CAP = Number(process.env.GATEWAY_DYNAMIC_BRAND_CAP || 5000) || 5000;
const MIN_LEN = 4;

// Generic category/beauty words excluded so a single-word brand that collides
// with a common term can't turn an ordinary category query into a brand query.
const STOPWORDS = new Set([
  'beauty', 'cosmetics', 'fragrance', 'perfume', 'parfum', 'skincare',
  'makeup', 'serum', 'toner', 'cleanser', 'cream', 'lotion', 'mask',
  'hair', 'skin', 'face', 'body', 'lip', 'lips', 'eye', 'eyes', 'sun',
  'spf', 'gel', 'oil', 'foam', 'balm', 'mist', 'kids', 'the', 'and',
  'for', 'with', 'shampoo', 'conditioner', 'moisturizer', 'sunscreen',
]);

let _set = new Set();
let _loadedAt = 0;
let _loading = null;

function enabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.GATEWAY_DYNAMIC_BRAND_DETECT || '').trim().toLowerCase(),
  );
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9&\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detection keys for ONE raw catalog brand. `normalize` turns every separator
// into a space, so a brand written with one — `A'PIEU`, `Kiehl's`, `L'Oreal` —
// is indexed as the multi-token span `a pieu`, while the same brand queried as
// `APIEU` normalises to the single token `apieu` and matches nothing. Measured
// 2026-09-11: `matchCatalogBrand("a pieu")` returned null against a dictionary
// holding `apieu`. The static lexicon side-steps this by hand-listing both
// spellings per brand (`kiehls: ["kiehl's", 'kiehls', 'kiehl s']`); the dynamic
// dictionary has no such list, so it must index both forms itself.
//
// Emits the normalised span AND its separator-free squash, so either spelling
// of the query finds the brand. No-op for a brand with no internal separator,
// where the two forms are the same string.
function brandAliases(rawBrand) {
  const full = normalize(rawBrand);
  if (!full) return [];
  const out = [full];
  const squashed = full.replace(/[\s\-]/g, '');
  if (squashed && squashed !== full) out.push(squashed);
  return out;
}

// ONE admission rule, used by BOTH the loader and the matcher. They previously
// each spelled `length >= MIN_LEN` inline; a key admitted under one and rejected
// under the other is a key that can never match, which is the state `3ce` was in.
//
// Below MIN_LEN a key must carry a digit. `3ce` qualifies; `vdl` and `nyx` do
// not and stay unmatched — a three-letter all-alphabetic span is not
// distinguishable from noise without a signal this cache does not have, and the
// cost of guessing is a category query silently scoped to a brand.
function admissibleKey(key) {
  const k = String(key || '');
  if (!k || STOPWORDS.has(k)) return false;
  if (k.length >= MIN_LEN) return true;
  return k.length >= 3 && /[0-9]/.test(k);
}

async function refresh() {
  let query;
  try {
    ({ query } = require('../db'));
  } catch (_) {
    return;
  }
  if (typeof query !== 'function') return;
  let rows;
  try {
    const res = await query(
      `SELECT LOWER(TRIM(brand)) AS b, COUNT(*) AS n
         FROM catalog_products
        WHERE brand IS NOT NULL AND TRIM(brand) <> ''
        GROUP BY LOWER(TRIM(brand))
        ORDER BY n DESC
        LIMIT $1`,
      [CAP],
    );
    rows = (res && res.rows) || [];
  } catch (_) {
    return; // best-effort: keep any prior cache, never break recall
  }
  const next = new Set();
  for (const row of rows) {
    for (const b of brandAliases(row && row.b)) {
      if (admissibleKey(b)) next.add(b);
    }
  }
  _set = next;
  _loadedAt = Date.now();
}

// Non-blocking warm: kick a refresh if enabled + stale, but never await it on
// the hot path (the first request may see an empty set; it warms within ~1).
function maybeRefresh() {
  if (!enabled() || _loading) return;
  if (_set.size && Date.now() - _loadedAt < TTL_MS) return;
  _loading = Promise.resolve()
    .then(refresh)
    .catch(() => {})
    .finally(() => {
      _loading = null;
    });
}

function getBrandSet() {
  return _set;
}

// Longest contiguous whole-token span of the query that is a known catalog
// brand. Returns the matched brand string, or null. Sync (reads the cache).
function matchCatalogBrand(normalizedQuery) {
  if (!enabled()) return null;
  maybeRefresh();
  if (!_set.size) return null;
  const tokens = String(normalizedQuery || '')
    .split(/\s+/)
    .filter(Boolean);
  for (let size = Math.min(4, tokens.length); size >= 1; size -= 1) {
    for (let i = 0; i + size <= tokens.length; i += 1) {
      const span = tokens.slice(i, i + size).join(' ');
      if (admissibleKey(span) && _set.has(span)) {
        return span;
      }
      // The query may spell a separator the catalog brand does not, or the
      // reverse: `A'PIEU` arrives here as the two tokens `a pieu` while the
      // dictionary holds `apieu`. Both forms were indexed, so try the squash.
      const squashed = span.replace(/[\s\-]/g, '');
      if (squashed !== span && admissibleKey(squashed) && _set.has(squashed)) {
        return squashed;
      }
    }
  }
  return null;
}

// Read-only diagnostic snapshot. Kicks a (non-blocking) warm so a second call
// reflects a freshly-loaded set. Returns counts + config only — never the full
// brand list — so it's safe to expose. Used by the /internal/diag/brand-dict
// route to disambiguate flag-off vs cache-empty vs brand-absent.
function debugState() {
  const on = enabled();
  if (on) maybeRefresh();
  return {
    enabled: on,
    flag_raw_present: Boolean(String(process.env.GATEWAY_DYNAMIC_BRAND_DETECT || '').trim()),
    cache_size: _set.size,
    loaded_at: _loadedAt || null,
    loading: Boolean(_loading),
    ttl_ms: TTL_MS,
    cap: CAP,
    min_len: MIN_LEN,
  };
}

// Test hook: seed the cache without a DB.
function __setBrandSetForTest(values) {
  _set = new Set(values || []);
  _loadedAt = Date.now();
}

module.exports = {
  enabled,
  refresh,
  maybeRefresh,
  getBrandSet,
  matchCatalogBrand,
  brandAliases,
  admissibleKey,
  debugState,
  __setBrandSetForTest,
};
