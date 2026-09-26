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
// alias key -> { brand, n, beauty_n, categorized_n }. Accent-folded, and kept
// apart from _set so the detection set above stays byte-identical.
let _beauty = new Map();
// suffix-stripped name -> the same stats entry as _beauty (GATEWAY_CATALOG_BRAND_LONG_TAIL)
let _beautyStripped = new Map();
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
    // nb / nc feed ONLY the catalog-beauty map below; the detection set reads
    // `b` alone, exactly as before. Bare `beauty` counts as beauty: measured
    // 2026-09-25, Charlotte Tilbury holds 13 of its 17 rows at the bare root,
    // so `LIKE 'beauty/%'` alone scored a pure beauty brand at 24%.
    const res = await query(
      `SELECT LOWER(TRIM(brand)) AS b, COUNT(*) AS n,
              COUNT(*) FILTER (WHERE category_path = 'beauty' OR category_path LIKE 'beauty/%') AS nb,
              COUNT(*) FILTER (WHERE category_path IS NOT NULL AND TRIM(category_path) <> '') AS nc,
              COUNT(*) FILTER (WHERE category_path ~ '^beauty/[^/]+/[^/]+') AS nl
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
  _beauty = buildBeautyBrandStats(rows);
  _beautyStripped = buildStrippedBrandIndex(_beauty);
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

// ---------------------------------------------------------------------------
// Catalog BEAUTY brands (GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT, default OFF).
//
// The search-quality contract decides target_domain from the static lexicon
// only (~60 brands), so a brand the catalog stocks by the hundred — Round Lab,
// 145 beauty rows — classed `other` and fell to the backend's external-seed
// lane (price withheld, rendered "0"). This map lets resolveBeautyBrandBrowseQuery
// recognise a brand whose catalog rows are predominantly beauty.
//
// Keys are accent-FOLDED (kosé -> kose). `normalize` above turns é into a
// space, so "Kosé" indexed as `kos` and was never admissible; the query side
// (brandLexicon.normalizeBrandText) already folds, so the two now agree.
const MIN_BEAUTY_ROWS = 3;
// Share over CATEGORISED rows: a NULL path says nothing about the brand. At
// 0.6, measured 2026-09-25 over 461 prod brands, the only beauty-stocked
// brands left out are genuinely mixed ones (GR: 116 fashion/apparel rows).
const MIN_BEAUTY_SHARE = 0.6;

function beautyContractEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT || '').trim().toLowerCase(),
  );
}

function foldAccents(value) {
  return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function buildBeautyBrandStats(rows) {
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const brand = normalize(foldAccents(row && row.b));
    if (!brand) continue;
    const n = Number(row.n) || 0;
    const nb = Number(row.nb) || 0;
    const nc = Number(row.nc) || 0;
    const nl = Number(row.nl) || 0;
    for (const key of brandAliases(brand)) {
      if (!admissibleKey(key) && !ONBOARDED_BRAND_KEYS.has(key)) continue;
      // Two raw spellings can fold to one key ("Kosé" and "KOSE"): one brand, summed.
      const prior = out.get(key);
      out.set(key, prior
        ? {
          brand: prior.brand,
          n: prior.n + n,
          beauty_n: prior.beauty_n + nb,
          categorized_n: prior.categorized_n + nc,
          beauty_leaf_n: prior.beauty_leaf_n + nl,
        }
        : { brand, n, beauty_n: nb, categorized_n: nc, beauty_leaf_n: nl });
    }
  }
  return out;
}

// LONG TAIL (GATEWAY_CATALOG_BRAND_LONG_TAIL, default OFF). A retailer ingest adds a
// brand a few rows at a time: Danessa Myricks Beauty arrived 2026-09-25 with 2 rows (lip
// gloss + brush, both beauty) and sat below MIN_BEAUTY_ROWS, unroutable by name. A
// MULTI-token brand whose categorised rows are ALL beauty, at least 2 of them at a beauty
// LEAF (beauty/<area>/<leaf>), qualifies from 2 rows. The leaf requirement is what keeps a
// misfile out: Shake Baby's 2 rows are diet-drink sticks filed at bare `beauty/makeup`.
// Single tokens keep the 3-row floor -- a one-word brand is the one that collides with words.
const LONG_TAIL_MIN_BEAUTY_ROWS = 2;

function longTailEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.GATEWAY_CATALOG_BRAND_LONG_TAIL || '').trim().toLowerCase(),
  );
}

// ONBOARDED BRANDS (GATEWAY_CATALOG_BRAND_ALLOWLIST, default OFF). A brand the
// retailer-ingest pipeline wrote on purpose (data/beauty/onboarded_catalog_brands.json:
// canonical == the catalog_products.brand the job wrote, plus the store spellings it
// respelled) needs no row-count evidence -- the floors exist to filter noise from random
// vendors, and an onboarded brand is not random. It qualifies from ONE beauty-leaf row,
// with the same majority-beauty share. Single-word ordinary-word brands (KISS) are still
// held to brand-only queries by brandLexicon.
function loadOnboardedBrandKeys() {
  const keys = new Set();
  let doc = null;
  try {
    doc = require('../../data/beauty/onboarded_catalog_brands.json');
  } catch (_) {
    return keys;
  }
  for (const brand of Array.isArray(doc && doc.brands) ? doc.brands : []) {
    for (const spelling of [brand && brand.canonical, ...((brand && brand.store_spellings) || [])]) {
      for (const key of brandAliases(normalize(foldAccents(spelling)))) {
        if (admissibleKey(key) || isShortOnboardedKeyShape(key)) keys.add(key);
      }
    }
  }
  return keys;
}
// admissibleKey refuses a 3-letter all-alphabetic key (vdl, nyx) because nothing tells a
// short brand from noise. An onboarded brand IS that signal: OPI (11 beauty rows in prod,
// 2026-09-26) was never indexed at all, by the detection set or this map. Short keys enter
// the beauty map only, and qualify only through the allowlist path below.
function isShortOnboardedKeyShape(key) {
  return /^[a-z0-9&]{3}$/.test(String(key || '')) && !STOPWORDS.has(key);
}
const ONBOARDED_BRAND_KEYS = loadOnboardedBrandKeys();

function allowlistEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.GATEWAY_CATALOG_BRAND_ALLOWLIST || '').trim().toLowerCase(),
  );
}

function isOnboardedBrand(brand) {
  const key = normalize(foldAccents(brand));
  return Boolean(key) && (ONBOARDED_BRAND_KEYS.has(key) || ONBOARDED_BRAND_KEYS.has(key.replace(/[\s\-]/g, '')));
}

function qualifiesAsBeautyBrand(stats) {
  if (!stats || !stats.categorized_n) return false;
  // A short onboarded key (OPI) is in the map only because it is onboarded: it qualifies
  // through the allowlist or not at all, so it stays inert while that flag is off.
  const onlyViaAllowlist = !admissibleKey(String(stats.brand || '').replace(/[\s\-]/g, '')) &&
    !admissibleKey(String(stats.brand || ''));
  if (
    !onlyViaAllowlist &&
    stats.beauty_n >= MIN_BEAUTY_ROWS &&
    stats.beauty_n / stats.categorized_n >= MIN_BEAUTY_SHARE
  ) {
    return true;
  }
  if (
    allowlistEnabled() &&
    isOnboardedBrand(stats.brand) &&
    stats.beauty_n >= 1 &&
    (stats.beauty_leaf_n || 0) >= 1 &&
    stats.beauty_n / stats.categorized_n >= MIN_BEAUTY_SHARE
  ) {
    return true;
  }
  return (
    !onlyViaAllowlist &&
    longTailEnabled() &&
    String(stats.brand || '').split(' ').filter(Boolean).length >= 2 &&
    stats.beauty_n >= LONG_TAIL_MIN_BEAUTY_ROWS &&
    stats.beauty_n === stats.categorized_n &&
    (stats.beauty_leaf_n || 0) >= LONG_TAIL_MIN_BEAUTY_ROWS
  );
}

// Store-spelled brands carry a suffix buyers do not type: "Danessa Myricks Beauty",
// "Tower 28 Beauty", "Round Lab US", "Tirtir Global". The catalog holds the suffixed
// spelling only, so "Danessa Myricks" matched no key at all. This maps the suffix-stripped
// name to the catalog brand it came from. It is matched ONLY against a query that is the
// name alone (brandLexicon enforces that): "first aid" is a brand name AND a phrase.
const STRIPPABLE_BRAND_SUFFIXES = new Set([
  'beauty', 'cosmetics', 'cosmetic', 'makeup', 'skincare',
  'us', 'usa', 'uk', 'jp', 'kr', 'global', 'official', 'store',
]);

function stripBrandSuffixes(brand) {
  const tokens = String(brand || '').split(' ').filter(Boolean);
  while (tokens.length > 1 && STRIPPABLE_BRAND_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function buildStrippedBrandIndex(stats) {
  const out = new Map();
  const seen = new Set();
  for (const entry of stats.values()) {
    if (seen.has(entry.brand)) continue; // the squashed alias points at the same entry
    seen.add(entry.brand);
    const stripped = stripBrandSuffixes(entry.brand);
    if (!stripped || stripped === entry.brand) continue;
    for (const key of brandAliases(stripped)) {
      if (!admissibleKey(key)) continue;
      // "celimax us" and "celimax jp" both strip to "celimax": the better-stocked wins.
      const prior = out.get(key);
      if (!prior || entry.beauty_n > prior.beauty_n) out.set(key, entry);
    }
  }
  return out;
}

// The catalog beauty brand a query names when the query IS the brand's suffix-stripped
// name (exact span, either spelling). Same shape as matchCatalogBeautyBrand. The caller
// must pass the query's core tokens only (stop/suffix words removed) -- this does no
// span search, on purpose.
function matchCatalogBeautyBrandByStrippedName(coreQuery) {
  if (!enabled() || !beautyContractEnabled() || !longTailEnabled()) return null;
  maybeRefresh();
  if (!_beautyStripped.size) return null;
  const span = normalize(foldAccents(coreQuery));
  if (!span) return null;
  const squashed = span.replace(/[\s\-]/g, '');
  const entry = _beautyStripped.get(span) || (squashed !== span ? _beautyStripped.get(squashed) : null);
  if (!entry) return null;
  // A stripped name must never shadow a real catalog brand of that exact spelling.
  if (_beauty.has(span)) return null;
  return qualifiesAsBeautyBrand(entry) ? { alias: span, ...entry } : null;
}

// Longest contiguous whole-token span of the query that is a catalog brand. If
// that brand is predominantly beauty, returns { brand, alias, n, beauty_n,
// categorized_n } where `brand` is the CANONICAL spaced key (so `roundlab` and
// `round lab` resolve to one identity); otherwise null. The longest known brand
// is THE brand: a non-beauty match never falls back to a shorter sub-span.
function matchCatalogBeautyBrand(normalizedQuery, options = {}) {
  if (!enabled() || !beautyContractEnabled()) return null;
  maybeRefresh();
  if (!_beauty.size) return null;
  const tokens = normalize(foldAccents(normalizedQuery)).split(/\s+/).filter(Boolean);
  const shortKeysYield = shortKeysYieldEnabled();
  let deferredShortKey = null;
  let regularBrandRefused = false;
  // An ordinary word that is also a catalog brand ("bubble", "merit") must not outrank a
  // short key: live 2026-09-26, "opi bubble bath" (an OPI shade) found the 3-row brand
  // "bubble", which brandLexicon then refuses as ambiguous -- leaving no brand at all.
  const isWeakRegularKey = typeof options.isWeakRegularKey === 'function' ? options.isWeakRegularKey : () => false;
  let weakRegular = null;
  for (let size = Math.min(4, tokens.length); size >= 1; size -= 1) {
    for (let i = 0; i + size <= tokens.length; i += 1) {
      const span = tokens.slice(i, i + size).join(' ');
      const squashed = span.replace(/[\s\-]/g, '');
      const key = _beauty.has(span) ? span : (squashed !== span && _beauty.has(squashed) ? squashed : null);
      if (!key) continue;
      // A short onboarded key (OPI) is in the map only for the allowlist. With that flag
      // off it must be invisible -- not merely unqualified -- or, as the longest match, it
      // would end the search and hide a real brand elsewhere in the query ("opi olaplex").
      if (!admissibleKey(key) && !allowlistEnabled()) continue;
      const stats = _beauty.get(key);
      // GATEWAY_CATALOG_SHORT_KEY_YIELDS: with the allowlist on, the same scan let "opi"
      // (token 0) end the search before "olaplex" (token 1) was looked at -- live
      // 2026-09-26, "opi olaplex" served 6 OPI rows. A short key is held back while the
      // scan looks for a regular brand elsewhere in the query; it answers only if none does.
      if (shortKeysYield && !admissibleKey(key)) {
        if (!deferredShortKey && qualifiesAsBeautyBrand(stats)) deferredShortKey = { alias: span, ...stats };
        continue;
      }
      if (regularBrandRefused) continue;
      if (shortKeysYield && isWeakRegularKey(key)) {
        // It still ends the search for other regular brands, exactly as before; only a short
        // key found anywhere in the query outranks it.
        if (qualifiesAsBeautyBrand(stats)) weakRegular = { alias: span, ...stats };
        regularBrandRefused = true;
        continue;
      }
      if (qualifiesAsBeautyBrand(stats)) return { alias: span, ...stats };
      if (!shortKeysYield) return null;
      // The longest regular brand is not beauty: no shorter regular span may answer (the
      // rule above), but a short key elsewhere in the query still can, whatever its position.
      regularBrandRefused = true;
    }
  }
  return deferredShortKey || weakRegular;
}

// Default OFF: matchCatalogBeautyBrand is unchanged unless this is set.
function shortKeysYieldEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.GATEWAY_CATALOG_SHORT_KEY_YIELDS || '').trim().toLowerCase(),
  );
}

// STRIPPED NAME + MORE WORDS (GATEWAY_CATALOG_BRAND_STRIPPED_CATEGORY, default OFF).
// "Danessa Myricks blush" -- the likeliest agent phrasing -- leads with the stripped name
// of "Danessa Myricks Beauty" and adds a product word. Claimed only when the stripped name
// is MULTI-token (a one-word stripped name is too collision-prone to anchor a span), it is
// the query's LEADING span, and at least one more word follows (the name alone is the
// brand-only matcher's job). The caller passes core tokens (stop/suffix words removed)
// and applies the ordinary-word list.
function strippedCategoryEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.GATEWAY_CATALOG_BRAND_STRIPPED_CATEGORY || '').trim().toLowerCase(),
  );
}

function matchCatalogBeautyBrandByStrippedLeadingSpan(coreTokens) {
  if (!enabled() || !beautyContractEnabled() || !longTailEnabled() || !strippedCategoryEnabled()) return null;
  maybeRefresh();
  if (!_beautyStripped.size) return null;
  const tokens = (Array.isArray(coreTokens) ? coreTokens : [])
    .map((token) => normalize(foldAccents(token)))
    .filter(Boolean);
  for (let size = Math.min(4, tokens.length - 1); size >= 2; size -= 1) {
    const span = tokens.slice(0, size).join(' ');
    const entry = _beautyStripped.get(span);
    if (!entry) continue;
    if (_beauty.has(span)) return null; // a real brand of that exact spelling wins elsewhere
    return qualifiesAsBeautyBrand(entry) ? { alias: span, ...entry } : null;
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
  _beauty = new Map();
  _beautyStripped = new Map();
  _loadedAt = Date.now();
}

// Test hook: seed the beauty map through the SAME builder the loader uses.
// rows: [{ b, n, nb, nc }]
function __setBeautyBrandRowsForTest(rows) {
  _beauty = buildBeautyBrandStats(rows);
  _beautyStripped = buildStrippedBrandIndex(_beauty);
  _loadedAt = Date.now();
}

module.exports = {
  enabled,
  beautyContractEnabled,
  refresh,
  maybeRefresh,
  getBrandSet,
  matchCatalogBrand,
  matchCatalogBeautyBrand,
  matchCatalogBeautyBrandByStrippedName,
  matchCatalogBeautyBrandByStrippedLeadingSpan,
  allowlistEnabled,
  strippedCategoryEnabled,
  isOnboardedBrand,
  longTailEnabled,
  stripBrandSuffixes,
  MIN_BEAUTY_ROWS,
  LONG_TAIL_MIN_BEAUTY_ROWS,
  MIN_BEAUTY_SHARE,
  __setBeautyBrandRowsForTest,
  brandAliases,
  admissibleKey,
  debugState,
  __setBrandSetForTest,
};
