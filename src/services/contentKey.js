'use strict';
/**
 * content_key — the ONE minting formula, mirrored from the cross-service authority.
 *
 * AUTHORITY (do not fork this)
 * ----------------------------
 * `content_key` is NOT owned by this repo. It is minted by
 * `pivota-backend/services/catalog_identity.py::make_content_key`, whose composition
 * has been locked since 2026-05-12:
 *
 *     content_key = "ck_" + sha256(
 *         normalize_brand(brand) + "::" +
 *         normalize_title(title) + "::" +
 *         (normalize_gtin(gtin) or "")
 *     )[:32]
 *
 * That writer is live and still minting (writer_audit_log: universal_product_sync,
 * shopify_products_sync, catalog_enrichment_agent_v1). Measured on prod 2026-08-07,
 * this formula reproduces 12,441 of 14,104 stored catalog_products.content_key values
 * (88.2%) — including every row minted since 2026-06. The remaining 11.8% are two
 * retired pre-2026-05-25 generations (see docs/adr / issue #1916) plus 63 rows whose
 * brand/title were rewritten after minting.
 *
 * The functions below are a byte-for-byte Node port. They exist so the Node mirrors
 * mint into the SAME keyspace as the Python writer instead of a parallel one.
 * `tests/content_key_authority.test.js` pins them to a shared conformance corpus
 * (`tests/fixtures/content_key_v1_cases.json`) that is generated from the Python
 * implementation and cross-checked against real prod rows. If the Python side ever
 * changes, that fixture is regenerated and BOTH sides move together — the fixture is
 * the contract, this file is a follower.
 *
 * WHY THIS FILE, AND NOT A LOCAL FORMULA
 * --------------------------------------
 * Between 2026-05-17 and 2026-07-12 this repo minted content_key three different ways
 * (URL-in-key D2C, no-URL retailer, then a brand-core/title-core "unified" hash), each
 * unaware that Python already owned the key. None of them can ever collide with a
 * Python-minted key, so a Node-minted row silently splits away from its own product's
 * serving decision (`index_pipeline_state.content_key` is a PRIMARY KEY — one serving
 * decision per content). A second definition of a shared key is not a fallback; it is
 * a fork. There is exactly one formula, and it lives here.
 *
 * NOT TO BE CONFUSED WITH: `retailerOfferIdentity.identityMatchKey()`. That is a
 * MATCHING key (brandCore|titleCore, size-stripped) used to resolve a new offer
 * against rows that already exist. It is deliberately looser than content_key and it
 * is never hashed into one.
 */

const crypto = require('node:crypto');

const KEY_PREFIX = 'ck_';
const KEY_HEX_LEN = 32;

// Brand-suffix tokens that carry no identity, so "Glow Recipe", "Glow Recipe Inc."
// and "Glow Recipe LLC" produce one brand. Mirrors _BRAND_SUFFIX_TOKENS in
// catalog_identity.py (the ®/™/(r)/(tm) entries there are already stripped before
// the token walk, so they are redundant in the set and omitted here).
const BRAND_SUFFIX_TOKENS = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'company']);

/** Lowercase, strip ®/™/(r)/(tm) and trailing corporate suffixes, collapse space. */
function normalizeBrand(brand) {
  if (typeof brand !== 'string' || !brand) return '';
  let text = brand.trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/[®™]/g, '');
  text = text.replace(/\s*\((r|tm)\)\s*/gi, ' ');
  const tokens = text.split(/\s+/g).filter(Boolean);
  while (tokens.length > 0) {
    const candidate = tokens[tokens.length - 1].replace(/[.,]+$/g, '');
    if (!BRAND_SUFFIX_TOKENS.has(candidate)) break;
    tokens.pop();
  }
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * NFKD + strip combining marks, lowercase, drop punctuation except hyphen and
 * underscore, collapse space. `[^\p{L}\p{N}_\s-]` is the JS spelling of Python's
 * `[^\w\s\-]` under `re.UNICODE`.
 *
 * Size tokens are KEPT ON PURPOSE — the authority treats 30ml and 50ml as different
 * products. (retailerOfferIdentity.titleCore strips them; that is a matching key with
 * the opposite policy, and the two must not be interchanged.)
 */
function normalizeTitle(title) {
  if (typeof title !== 'string' || !title) return '';
  let text = title.normalize('NFKD');
  text = text.replace(/\p{Mark}/gu, '');
  text = text.toLowerCase();
  text = text.replace(/[^\p{L}\p{N}_\s-]/gu, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalize a GTIN to its 14-digit GS1 form so UPC-A / EAN-13 / GTIN-14 spellings
 * of one product collide. 15+ digits is malformed — passed through rather than
 * truncated, so unrelated codes never silently merge.
 */
function normalizeGtin(gtin) {
  if (typeof gtin !== 'string' || !gtin) return '';
  const digits = gtin.trim().replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 14) return digits.padStart(14, '0');
  return digits;
}

/**
 * The content_key for a (brand, title, gtin) triple.
 *
 * Returns `null` when brand or title normalize to empty. That null is load-bearing:
 * hashing empty inputs would mint one all-collide key that every untitled row shares,
 * which is worse than no key at all (content_key is nullable for exactly this case).
 * Callers must handle null and leave content_key NULL — never substitute a placeholder.
 *
 * @param {string|null|undefined} brand
 * @param {string|null|undefined} title
 * @param {string|null|undefined} [gtin]
 * @returns {string|null}
 */
function makeContentKey(brand, title, gtin = null) {
  const brandNorm = normalizeBrand(brand);
  const titleNorm = normalizeTitle(title);
  if (!brandNorm || !titleNorm) return null;
  const gtinNorm = normalizeGtin(gtin);
  const digest = crypto
    .createHash('sha256')
    .update(`${brandNorm}::${titleNorm}::${gtinNorm}`, 'utf8')
    .digest('hex')
    .slice(0, KEY_HEX_LEN);
  return `${KEY_PREFIX}${digest}`;
}

/** True iff value has the content_key shape (`ck_` + 32 lowercase hex). */
function isContentKey(value) {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(KEY_PREFIX)) return false;
  const rest = value.slice(KEY_PREFIX.length);
  return rest.length === KEY_HEX_LEN && /^[0-9a-f]+$/.test(rest);
}

module.exports = {
  KEY_PREFIX,
  KEY_HEX_LEN,
  normalizeBrand,
  normalizeTitle,
  normalizeGtin,
  makeContentKey,
  isContentKey,
};
