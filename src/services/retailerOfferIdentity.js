'use strict';
/**
 * Fix Plan D — cross-seller identity spine (ONE shared MATCHING normalizer + resolver).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A *matching* key. `identityMatchKey(brand, title)` = `brandCore|titleCore`, used to
 * resolve an incoming offer against catalog products that already exist, so the same
 * product sold by a brand's own site and by Ulta lands on one identity. `titleCore`
 * removes brand tokens and strips size/pack/mini/jumbo/travel/refill tokens while
 * PRESERVING shades — deliberately stricter on SIZE than
 * pdp_identity_listing.title_core_norm (which keeps "100ml" and so blocks the exact
 * cross-size collapse this plan needs), and shade-preserving so distinct shades never
 * silently merge.
 *
 * WHAT THIS MODULE IS NOT (issue #1916)
 * -------------------------------------
 * It does NOT mint `content_key`. It used to: from 2026-07-12 it exported
 * `contentKeyFallback(brand, title) = stableHash('ck', [brandCore, titleCore])`, the
 * third formula this repo invented for a key it does not own. `content_key` is minted
 * by pivota-backend/services/catalog_identity.py and mirrored in Node by
 * `src/services/contentKey.js` — that is the only minter. Measured on prod 2026-08-07:
 * of 14,104 stored keys, ZERO were produced by `contentKeyFallback`, including the 985
 * mirror rows minted after it shipped. A key minted here could never collide with a
 * Python-minted key, so the row would split away from its own product's serving
 * decision (`index_pipeline_state.content_key` is a PRIMARY KEY).
 *
 * The two keys have OPPOSITE size policy on purpose — this one strips size to match
 * across it, `contentKey.js` keeps size because the authority treats 30ml and 50ml as
 * different products. That is precisely why one can never be substituted for the other.
 *
 * HOW COLLAPSE ACTUALLY HAPPENS
 * -----------------------------
 * 1. RESOLVE-FIRST is the collapse mechanism, and the only one. Before minting a self
 *    identity, a mirror resolves `identityMatchKey` against existing catalog products
 *    and REUSES the matched product's stored content_key / product_group_id. Two
 *    spellings of one product converge because one row already holds the key — never
 *    because two hashes happened to agree.
 * 2. CONSERVATIVE: only an EXACT match auto-reuses identity. A near (token-jaccard)
 *    match is NEVER auto-merged — it is surfaced for review. Wrong merges (someone
 *    else's price/availability on your PDP) are worse than no merge, per the plan's
 *    risk note.
 *
 * The pure functions here are ported/centralised from the offline merge tool
 * scripts/scan-beauty-sku-merge-candidates.js (lines ~95-152) so intake and the
 * offline SKU-merge scanner share ONE normalization. No I/O in the pure section, so
 * the sync write path, the T2 backfill, and the jest tests all share one rule.
 */

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Pure normalization (single source of truth — mirror scan-beauty-sku-merge)
// ---------------------------------------------------------------------------

// Size / quantity tokens. Requires the decimal to survive normalization, so
// `normalizeText` keeps `.` `%` `+`.
const SIZE_RE =
  /\b\d+(?:\.\d+)?\s*(?:ml|milliliter|milliliters|l|liter|liters|fl\s*oz|floz|oz|ounce|ounces|g|gram|grams|kg|count|ct|pc|pcs|piece|pieces|sheets?|pads?|capsules?|tablets?)\b|\b\d+\s*(?:-|x)?\s*(?:pack|pk)\b|\bpack\s*of\s*\d+\b/gi;

// Non-size "form/packaging" tokens that do NOT change product identity.
const FORM_VARIANT_RE = /\b(?:mini|jumbo|travel\s*size|value\s*size|deluxe\s*mini|trial\s*size|sample\s*size|refill|refillable|tester)\b/gi;

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'without', 'skin', 'face', 'facial', 'beauty', 'new',
]);

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join('/');
  return String(value).trim();
}

/** Lowercase, strip diacritics/symbols, keep a-z0-9 plus `.` `%` `+` (needed by SIZE_RE). */
function normalizeText(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[™®©]/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9.%+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Brand core: normalized, minus corporate/vertical suffixes so "Benefit Cosmetics"
 * and "Benefit" collapse, and "Estée Lauder"/"Estee Lauder" match. */
function brandCore(value) {
  // Brands never carry meaningful decimals/percent/plus — drop the `.%+` that
  // normalizeText keeps for SIZE_RE, so "e.l.f." collapses to "e l f".
  return normalizeText(value)
    .replace(/[.%+]/g, ' ')
    .replace(/\b(?:inc|llc|ltd|co|company|corp|cosmetics|cosmetic|beauty|skincare|skin\s*care|paris|professional|makeup)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleWithoutBrand(title, brand) {
  const out = normalizeText(title);
  if (!out) return out;
  // Remove the brand however it appears in the title: the union of the FULL
  // normalized brand tokens (e.g. "benefit", "cosmetics") and the suffix-stripped
  // brandCore tokens. Removing each token individually means "Benefit Cosmetics
  // Hoola…" and "Benefit Hoola…" both reduce to the same core.
  const tokens = Array.from(
    new Set(
      `${normalizeText(brand)} ${brandCore(brand)}`
        .split(/\s+/)
        .filter(Boolean),
    ),
  );
  if (!tokens.length) return out;
  return out
    .replace(new RegExp(`\\b(?:${tokens.map(escapeRegex).join('|')})\\b`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** STRICT title-core: brand removed, size + form tokens stripped, shades kept. */
function titleCore(title, brand) {
  return titleWithoutBrand(title, brand)
    .replace(SIZE_RE, ' ')
    .replace(FORM_VARIANT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coreTokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));
}

function jaccard(left, right) {
  const a = new Set(Array.isArray(left) ? left : coreTokens(left));
  const b = new Set(Array.isArray(right) ? right : coreTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function stableHash(prefix, parts, length = 32) {
  const hash = crypto.createHash('sha256').update(parts.map(asString).join('\n')).digest('hex').slice(0, length);
  return `${prefix}_${hash}`;
}

/** Deterministic exact-match identity key (brandCore | titleCore). */
function identityMatchKey(brand, title) {
  return `${brandCore(brand)}|${titleCore(title, brand)}`;
}

// ---------------------------------------------------------------------------
// DB resolver — resolve a {brand,title} against existing D2C/canonical catalog
// identity. `queryFn(sql, params) -> {rows}` is injected (from ../src/db in the
// scripts; a fake in tests). Reads only; never writes.
// ---------------------------------------------------------------------------

// Known third-party retailer hosts — a candidate product whose ONLY evidence host
// is a retailer is NOT a trustworthy D2C fold-into target (Plan C precedence rule 0
// / task_49450b1b: ~65 pdp_identity_listing.official_domain rows are contaminated
// with retailer hosts). We reuse Plan C's list so it stays single-sourced.
let KNOWN_RETAILER_HOSTS = null;
function knownRetailerHosts() {
  if (KNOWN_RETAILER_HOSTS) return KNOWN_RETAILER_HOSTS;
  try {
    // eslint-disable-next-line global-require
    const { DEFAULT_KNOWN_RETAILER_DOMAINS, knownRetailerDomains } = require('./offerSellerIdentity');
    KNOWN_RETAILER_HOSTS = new Set(
      (typeof knownRetailerDomains === 'function' ? knownRetailerDomains() : DEFAULT_KNOWN_RETAILER_DOMAINS) || [],
    );
  } catch {
    KNOWN_RETAILER_HOSTS = new Set([
      'ulta.com', 'sephora.com', 'target.com', 'nordstrom.com', 'dermstore.com',
      'amazon.com', 'walmart.com', 'oliveyoung.com', 'global.oliveyoung.com',
    ]);
  }
  return KNOWN_RETAILER_HOSTS;
}

function hostOf(url) {
  const raw = asString(url);
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isRetailerHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  for (const base of knownRetailerHosts()) {
    if (h === base || h.endsWith(`.${base}`)) return true;
  }
  return false;
}

/**
 * Build an in-memory identity index for the given brands from existing catalog
 * products that are NOT retailer offers (the fold-into universe). Returns a Map
 * keyed by identityMatchKey -> { content_key, product_group_id, product_key, title,
 * brand, count } plus a per-brand token list for fuzzy scoring.
 *
 * @param {(sql:string, params:any[]) => Promise<{rows:any[]}>} queryFn
 * @param {string[]} brands raw brand strings
 * @param {object} [opts]
 * @param {string[]} [opts.excludeProductKeys] retailer product_keys to exclude
 */
async function buildCatalogIdentityIndex(queryFn, brands, opts = {}) {
  const brandCores = Array.from(new Set((brands || []).map(brandCore).filter(Boolean)));
  if (!brandCores.length) return { exact: new Map(), byBrand: new Map(), candidateCount: 0 };
  // Fetch products for these brands that carry at least one non-retailer offer.
  // We over-fetch by brandCore prefix via lower(brand) match in JS (brand column is
  // unnormalized), so pull a superset by a coarse ILIKE-free equality on trimmed
  // lower(brand) plus a token-any match, then filter precisely in JS.
  const res = await queryFn(
    `
      SELECT p.product_key, p.content_key, p.brand, p.title, p.canonical_url,
             pgm.product_group_id
      FROM catalog_products p
      JOIN catalog_offers o
        ON o.product_key = p.product_key
       AND o.suppression_reason IS NULL
       AND coalesce(o.offer_type, 'brand_direct') <> 'retailer'
      LEFT JOIN product_group_members pgm
        ON pgm.merchant_id = p.merchant_id
       AND pgm.platform = p.platform
       AND pgm.platform_product_id = p.source_product_id
      WHERE p.content_key IS NOT NULL
        AND p.suppression_reason IS NULL
        AND p.brand IS NOT NULL
        AND btrim(lower(p.brand)) <> ''
    `,
    [],
  );
  const exclude = new Set((opts.excludeProductKeys || []).map(String));
  const exact = new Map();
  const byBrand = new Map();
  let candidateCount = 0;
  const brandCoreSet = new Set(brandCores);
  for (const row of res.rows || []) {
    const bc = brandCore(row.brand);
    if (!brandCoreSet.has(bc)) continue;
    if (exclude.has(String(row.product_key))) continue;
    // Contamination guard: skip candidate whose only evidence host is a retailer.
    if (isRetailerHost(hostOf(row.canonical_url))) continue;
    candidateCount += 1;
    const key = identityMatchKey(row.brand, row.title);
    const entry = {
      content_key: row.content_key,
      product_group_id: row.product_group_id || null,
      product_key: row.product_key,
      brand: row.brand,
      title: row.title,
    };
    if (!exact.has(key)) {
      exact.set(key, { ...entry, count: 1 });
    } else {
      exact.get(key).count += 1;
    }
    if (!byBrand.has(bc)) byBrand.set(bc, []);
    byBrand.get(bc).push({ ...entry, tokens: coreTokens(titleCore(row.title, row.brand)) });
  }
  return { exact, byBrand, candidateCount };
}

/**
 * Resolve a single {brand,title} against a prebuilt index.
 * @returns {{decision:'reuse_exact'|'review_fuzzy'|'self_mint', match?:object, score?:number}}
 */
function resolveAgainstIndex(index, brand, title, opts = {}) {
  const fuzzyThreshold = typeof opts.fuzzyThreshold === 'number' ? opts.fuzzyThreshold : 0.72;
  const key = identityMatchKey(brand, title);
  const exact = index.exact.get(key);
  if (exact && exact.content_key) {
    return { decision: 'reuse_exact', match: exact, score: 1 };
  }
  const bc = brandCore(brand);
  const candidates = index.byBrand.get(bc) || [];
  if (!candidates.length) return { decision: 'self_mint' };
  const myTokens = coreTokens(titleCore(title, brand));
  let best = null;
  let bestScore = 0;
  for (const cand of candidates) {
    const score = jaccard(myTokens, cand.tokens);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  if (best && bestScore >= fuzzyThreshold) {
    return { decision: 'review_fuzzy', match: best, score: bestScore };
  }
  return { decision: 'self_mint', score: bestScore };
}

module.exports = {
  // pure normalization (single source of truth)
  asString,
  normalizeText,
  brandCore,
  titleWithoutBrand,
  titleCore,
  coreTokens,
  jaccard,
  stableHash,
  identityMatchKey,
  SIZE_RE,
  FORM_VARIANT_RE,
  // retailer-host guard
  hostOf,
  isRetailerHost,
  knownRetailerHosts,
  // DB resolver
  buildCatalogIdentityIndex,
  resolveAgainstIndex,
};
