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
 * The functions below are a Node port. They exist so the Node mirrors mint into the
 * SAME keyspace as the Python writer instead of a parallel one.
 * `tests/content_key_authority.test.js` pins them to a shared conformance corpus
 * (`tests/fixtures/content_key_v1_cases.json`) that is generated from the Python
 * implementation and cross-checked against real prod rows. If the Python side ever
 * changes, that fixture is regenerated and BOTH sides move together — the fixture is
 * the contract, this file is a follower.
 *
 * EXACTLY HOW EQUIVALENT (do not overstate this)
 * ----------------------------------------------
 * Equivalent for every codepoint ASSIGNED IN BOTH RUNTIMES — verified by differential
 * fuzz, 8,913 inputs covering all 28 assigned Unicode general categories plus every
 * realistic brand/title/GTIN combination: zero disagreements. Also zero across all
 * 14,104 live catalog_products rows.
 *
 * NOT "byte-for-byte", and the difference matters. Node ships ICU's Unicode version;
 * this module's tables come from the Python runtime's (see PYTHON_UNICODE_VERSION).
 * Those versions differ, so a few thousand recently-assigned codepoints are letters
 * or digits to one and unassigned to the other. We ASSERT that rather than pin it:
 * pinning ICU across two runtimes is heavy machinery for codepoints no beauty catalog
 * contains, but a silent runtime upgrade moving keys is exactly the failure this
 * module exists to prevent — so the version is recorded here, exported, and asserted
 * in the test suite, where a change becomes a visible red instead of a quiet re-key.
 *
 * An earlier revision of this file DID claim "byte-for-byte" while approximating two
 * Python behaviours with JS character classes (`\p{Mark}` for combining class, `\s`
 * for Python whitespace, bare `\D` for Python's digit class). It disagreed with the
 * authority on 15.9% of realistic inputs. The lesson is in contentKeyUnicodeTable.js:
 * where JS has no equivalent property, derive the set from the authority — never
 * approximate it and call the result a port.
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

const {
  PYTHON_UNICODE_VERSION,
  PYTHON_WHITESPACE,
  hasNonzeroCombiningClass,
  isPythonWhitespace,
} = require('./contentKeyUnicodeTable');

const KEY_PREFIX = 'ck_';
const KEY_HEX_LEN = 32;

// Every `\s` in this module is Python's, built from the table — never JS's. The two
// classes differ in BOTH directions: JS has U+FEFF that Python lacks, Python has
// U+001C-001F and U+0085 that JS lacks. (Measured: Python's `str.isspace()` and its
// regex `\s` are the same 29 codepoints, so one class serves both.)
const PY_WS_CLASS = Array.from(PYTHON_WHITESPACE)
  .sort((a, b) => a - b)
  .map((cp) => `\\u{${cp.toString(16)}}`)
  .join('');
/** Runs of Python whitespace, for `re.sub(r"\s+", " ", ...)`. */
const PY_WS_RUN_RE = new RegExp(`[${PY_WS_CLASS}]+`, 'gu');
/** Python's `[^\w\s\-]`: everything outside letters, digits, underscore, ws, hyphen. */
const PY_NON_WORD_RE = new RegExp(`[^\\p{L}\\p{N}_${PY_WS_CLASS}-]`, 'gu');
/**
 * Python's `\s*\((r|tm)\)\s*` from catalog_identity.py.
 *
 * Deliberately NO `i` flag: the authority has no re.IGNORECASE, and normalizeBrand
 * lowercases before this runs, so the flag was both unrequested and unreachable.
 * Proven equivalent over all 1,114,112 codepoints — but in a module whose whole thesis
 * is "never approximate the authority", an extra flag is the kind of drift that later
 * becomes load-bearing.
 *
 * Hoisted out of normalizeBrand because rebuilding it per call was 0.82µs of that
 * function's 1.09µs.
 */
const PY_PAREN_MARK_RE = new RegExp(
  `[${PY_WS_CLASS}]*\\((r|tm)\\)[${PY_WS_CLASS}]*`,
  'gu',
);

// Brand-suffix tokens that carry no identity, so "Glow Recipe", "Glow Recipe Inc."
// and "Glow Recipe LLC" produce one brand. Mirrors _BRAND_SUFFIX_TOKENS in
// catalog_identity.py (the ®/™/(r)/(tm) entries there are already stripped before
// the token walk, so they are redundant in the set and omitted here — verified by
// probing all 18 suffix spellings against the authority, not by inspection).
const BRAND_SUFFIX_TOKENS = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'company']);

/**
 * Split on runs of PYTHON whitespace — the semantics of `str.split()` with no args.
 *
 * NOT `/\s+/`. The two definitions differ in both directions and `normalizeBrand` has
 * no punctuation pass to absorb the difference, so it lands straight in the key:
 * U+FEFF (a UTF-8 BOM decoded into a CSV field) is JS-whitespace but not Python's,
 * while U+0085 and U+001C-001F are Python's but not JS's.
 */
function pythonSplit(text) {
  const tokens = [];
  let current = '';
  for (const ch of text) {
    if (isPythonWhitespace(ch.codePointAt(0))) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** `str.strip()` — trim PYTHON whitespace, for the same reason as pythonSplit. */
function pythonStrip(text) {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && isPythonWhitespace(chars[start].codePointAt(0))) start += 1;
  while (end > start && isPythonWhitespace(chars[end - 1].codePointAt(0))) end -= 1;
  return chars.slice(start, end).join('');
}

/** Lowercase, strip ®/™/(r)/(tm) and trailing corporate suffixes, collapse space. */
function normalizeBrand(brand) {
  if (typeof brand !== 'string' || !brand) return '';
  let text = pythonStrip(brand).toLowerCase();
  if (!text) return '';
  text = text.replace(/[®™]/g, '');
  text = text.replace(PY_PAREN_MARK_RE, ' ');
  const tokens = pythonSplit(text);
  while (tokens.length > 0) {
    const candidate = tokens[tokens.length - 1].replace(/[.,]+$/g, '');
    if (!BRAND_SUFFIX_TOKENS.has(candidate)) break;
    tokens.pop();
  }
  return pythonStrip(tokens.join(' ').replace(PY_WS_RUN_RE, ' '));
}

/**
 * NFKD, drop marks with a NONZERO combining class, lowercase, replace everything
 * outside `\w\s-` with a space, collapse space.
 *
 * The mark step is `unicodedata.combining(c) != 0`, NOT `\p{Mark}`. 1,589 codepoints
 * are category Mark with combining class 0 (Indic and Thai vowel signs, mostly).
 * Python KEEPS those here — and then the class replacement below turns each into a
 * SPACE, because a mark is not `\w`. Deleting them instead, as `\p{Mark}` would, also
 * moves the token boundary. That single mistranslation forked every Thai and
 * Devanagari title; Korean and Japanese were unaffected, which is why an ASCII/CJK
 * fixture could not see it.
 *
 * `[^\p{L}\p{N}_\s-]` IS a correct spelling of Python's `[^\w\s\-]` under re.UNICODE —
 * verified across all 1,114,112 codepoints, zero disagreements among those assigned
 * in both runtimes.
 *
 * Size tokens are KEPT ON PURPOSE — the authority treats 30ml and 50ml as different
 * products. (retailerOfferIdentity.titleCore strips them; that is a matching key with
 * the opposite policy, and the two must not be interchanged.)
 */
function normalizeTitle(title) {
  if (typeof title !== 'string' || !title) return '';
  const decomposed = title.normalize('NFKD');
  let text = '';
  for (const ch of decomposed) {
    if (!hasNonzeroCombiningClass(ch.codePointAt(0))) text += ch;
  }
  text = text.toLowerCase();
  text = text.replace(PY_NON_WORD_RE, ' ');
  return pythonStrip(text.replace(PY_WS_RUN_RE, ' '));
}

/**
 * Canonicalize a GTIN to its 14-digit GS1 form so UPC-A / EAN-13 / GTIN-14 spellings
 * of one product collide. 15+ digits is malformed — passed through rather than
 * truncated, so unrelated codes never silently merge.
 *
 * Two things here are deliberate and were both wrong in the first port:
 *   - `\P{Nd}` with the `u` flag, not `\D`. Bare JS `\D` is `[^0-9]`, while Python's
 *     `\D` under re.UNICODE is "not category Nd" — 650 codepoints are digits to
 *     Python and not to JS, so a fullwidth or Arabic-Indic GTIN silently became ''
 *     and vanished from the key.
 *   - length and padding counted in CODEPOINTS, not UTF-16 code units, because
 *     `zfill` counts codepoints. Astral digits (Osmanya, Brahmi, Chakma) are two
 *     units each, so `.length`/`padStart` would both under-count.
 */
function normalizeGtin(gtin) {
  if (typeof gtin !== 'string' || !gtin) return '';
  const digits = Array.from(pythonStrip(gtin)).filter((ch) => !/\P{Nd}/u.test(ch));
  if (!digits.length) return '';
  if (digits.length <= 14) return '0'.repeat(14 - digits.length) + digits.join('');
  return digits.join('');
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
  PYTHON_UNICODE_VERSION,
  normalizeBrand,
  normalizeTitle,
  normalizeGtin,
  makeContentKey,
  isContentKey,
};
