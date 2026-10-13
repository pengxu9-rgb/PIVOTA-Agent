'use strict';

// SHADE LINES: rule `shade_line_v2`.
//
// WHAT IT IS FOR. One store often lists every shade of a colour line as its own product page:
//   "<LINE> <CODE> <NAME>"     e.g. "BRANDA AURA K2207 SAFFRON", "BRANDA TINT PRO 517 HARBOR MIST"
//   "<LINE> <CODE>"            e.g. "BRANDB LACQ NO.884"
//   "<LINE> - <NAME> #<CODE>"  e.g. "BRANDD ATELIER - PEAR SPRITZ #271"
//   "<LINE> - <NAME>"          e.g. "BRANDF Volume Lash - Ink Plum"
// The identity graph's multi-page shade-family rule (extractMultiPageShadeFamilyCandidate, rule v1)
// misses most of these: it needs a makeup context word (nail products have none, and the seed
// payload carries no category), it does not read a one-letter code prefix as a code, and it strips
// only the code, so the shade NAME stays in the line key and every shade becomes its own line.
// This rule keys the line on the LINE part alone, scoped to one store and one brand, and refuses
// anything that does not look like N shades of one product.
//
// FLAG: SHADE_LINE_RULE_V2_ENABLED (default OFF, read per call). Off, nothing here runs: the
// identity listing builder computes no candidate and the backfill is byte-identical to the code
// before this rule (tests/services/shade_line_rule_flag_off_golden.test.js). Line ids are sticky
// and drive the live PDP (picker, line images, review summary), so the write half stays off until
// the rollout is approved.
//
// HOW IT RUNS (flag on). Two halves:
//   1. extractShadeLineCandidate (per listing, pure): parse the title, check context and the
//      per-listing guards, and return the line part, the shade value and the facts the group
//      guards need. Called by buildIdentityListingFromProduct.
//   2. applyShadeLineGrouping (per batch, pure): group candidates by store + line text, apply the
//      group guards and give every surviving NEW member the same product_line_id.
//      Called by backfillPdpIdentityGraph after clusterIdentityListings and before operator
//      overrides, so an override still wins.
//
// WHERE THE DECISION IS RECORDED. soft_identity.shade_line ({rule_version, status, ...}), never
// match_basis: match_basis is substring-matched by search and projected on discovery cards, so a
// marker there would make "shade" or "set" queries match. status is one of
//   approved  - the listing is in the line; product_line_id is the line id
//   proposed  - the rule would place it in a line, but the listing already has a stored line id
//               (sticky): this is the re-key backlog, see shadeLineCardCollapse.js
//   refused   - with the named reason
// Existing rows are never moved: their stored id, review family and variant axes are left as the
// builder made them. The backfill FAILS CLOSED: if it cannot read which batch rows are already
// stored, it skips the whole pass for the batch and writes no decision.
//
// V1 ADOPTION. A v2 shade whose same-store siblings live in a v1 line (rule v1 keys some titles
// correctly already) joins that line instead of minting a second one -- but only when the v1 line
// is this store's alone (no other merchant or domain holds it, in the batch or stored), and the
// v1 siblings count in the brand / category / size / currency / price baselines. A batch only
// sees the siblings it contains (`--only-uncovered` batches see none); the read-only census
// (scripts/census-shade-lines.js) is the reconciliation.

// WHAT CHANGES FOR THE RELATIONSHIP GRAPH WHEN THE RULE IS ON (for the relgraph owner; no relgraph
// code is changed by this rule). The relgraph has no reader of pdp_identity_listing.product_line_id
// of its own. It takes a product's FAMILY from the first of product_family_id / product_line_id /
// variant_of on the object it is given:
//   - catalog_products.product_payload ->> product_line_id (catalogEntityResolution ~:581/:628,
//     productRelationshipGraphSources normalizeApprovedLiveExternalSeedRow ~:826-831): unchanged by
//     this rule, which writes only pdp_identity_listing. (Nothing stamps that payload key today.)
//   - a product / snapshot object that already carries product_line_id
//     (productRelationshipGraphSources ~:731 candidate snapshots, productIdentityKeys ~:1925,
//     familyIdentityKey ~:2082; productRelationshipGraph familyKeyFromRelationshipSnapshot ~:800).
//     The PDP stamps the identity listing's product_line_id on its product (server.js
//     decoratePdpPayloadWithIdentity ~:10693), so a PDP-built anchor or display snapshot of a shade the
//     rule lined up carries the NEW line id.
// For such a product, with the rule on:
//   1. Its family key changes from the derived `family:v1:<brand>::<title minus shade/size>::<cat>`
//      (or `family:<old per-page line id>`) to the explicit `family:<pl_ shade line id>`. Explicit
//      keys are compatible only when equal (familyIdentityKeysCompatible), so the siblings of one
//      shade line become ONE family exactly when each of them carries the line id -- and a sibling
//      whose object carries no line id (derived key) is no longer compatible with one that does.
//   2. Family grouping / same-family dedupe (dedupeNormalizedProducts, the raw-pool family index in
//      buildCandidatesByAnchorFromSources, assignRelationshipFamilyBucket at serving) then collapses
//      shades of one line into one candidate / bucket, and drops a candidate of the anchor's own
//      line ("same product or variant") -- the intended effect, since a shade is not an alternative
//      to its sibling. Shades of DIFFERENT stores stay separate families (the line is per store).
//   3. fanOutCandidatesToSiblingAnchors (when enabled) shares one representative's candidates
//      across every anchor of the line.
//   4. The same-brand cap on similar rails (#2415, relationshipGraphRecall) is keyed on brand, not
//      family, and reads no product_line_id; it is unchanged. Indirectly, fewer same-line sibling
//      cards reach it (step 2 removes them first), so the one same-brand slot it allows is less
//      often taken by a sibling shade.
//   5. Edges already written keep the family they were built with until the next relgraph build
//      rebuilds them; the line ids themselves move only for NEW listings (sticky ids; the re-key is
//      a separate, approved step, see shadeLineCardCollapse.js).

const { createHash } = require('crypto');

const SHADE_LINE_RULE_FLAG = 'SHADE_LINE_RULE_V2_ENABLED';
const SHADE_LINE_RULE_VERSION = 'shade_line_v2';
const SHADE_LINE_MAX_PRICE_RATIO = 1.5;
const SHADE_LINE_MIN_MEMBERS = 2;

const SHADE_LINE_REFUSALS = Object.freeze({
  NO_CONTEXT: 'no_shade_context',
  NON_SHADE_SUFFIX: 'non_shade_suffix',
  SIZE_MISMATCH: 'size_mismatch',
  MISSING_BRAND: 'missing_brand',
  MISSING_STORE: 'missing_store',
  NOT_APPROVED: 'identity_not_approved',
  REVIEWED_MERGE: 'reviewed_merge_kept',
  BRAND_MISMATCH: 'brand_mismatch',
  BRAND_ONLY_UNSCOPED: 'brand_only_line_unscoped',
  CATEGORY_MISMATCH: 'category_mismatch',
  CURRENCY_MISMATCH: 'currency_mismatch',
  PRICE_OUTLIER: 'price_outlier',
  DUPLICATE_SHADE: 'duplicate_shade_value',
  LINE_TOO_SMALL: 'line_too_small',
  SHORT_CODE_UNCONFIRMED: 'short_code_unconfirmed',
  SHORT_CODE_SKINCARE: 'short_code_skincare_line',
});

function isShadeLineRuleEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env?.[SHADE_LINE_RULE_FLAG] || '').trim());
}

function asString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stableHash(prefix, parts) {
  // Same shape as pdpIdentityGraph.stableHash, so a line id minted here is indistinguishable
  // in form from every other product_line_id.
  const payload = JSON.stringify(parts || []);
  return `${prefix}_${createHash('sha1').update(payload).digest('hex').slice(0, 24)}`;
}

// Letters of EVERY script are kept: "BRANDX 甲油胶 01" and "BRANDX 卸甲水 02" (or two Cyrillic product
// names) are two lines, not one line keyed on the brand alone. Accents come off LATIN letters only
// (é -> e); a mark on any other script is part of the letter (Cyrillic й is not и), and the text is
// recomposed (NFC), so Hangul stays syllables.
function normalizeLineText(value) {
  return asString(value)
    .normalize('NFKD')
    .replace(/([a-z])\p{M}+/giu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Title parsing
// ---------------------------------------------------------------------------------------------

// Bracketed annotations are store bookkeeping, never part of the product's name:
// "[DISCONTINUED]", "[PRE ORDER]", "【NEW】".
function stripBracketTags(title) {
  return asString(title)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT_TOKEN_RE = /^(?:ml|m\.?l\.?|l|g|gr|gram|grams|kg|mg|oz|fl|floz|fl\.?oz\.?|lb|lbs|mm|cm|pcs?|pieces?|pack|packs|ct|count|ea|caps|capsules|sheets?|x)$/i;
const SUN_FACTOR_TOKEN_RE = /^(?:spf|pa|uv|upf)$/i;
const YEAR_RE = /^(?:19|20)\d{2}$/;
// A version or generation is not a shade: "Palette V2", "V12", "Mk2", "Version 3", "Gen 2".
const VERSION_TOKEN_RE = /^(?:v|mk)\d+$/i;
const VERSION_WORD_RE = /^(?:v|ver|version|gen|generation|mk|mark|edition|ed|series|vol|volume)\.?$/i;
// A letter (or two) and ONE digit: the shortest code shape, confirmed per line (see the group pass).
const SHORT_CODE_RE = /^([a-z]{1,2})\d$/i;
const SHORT_CODE_SKINCARE_LINE_RE = /\b(?:serum|essence|ampoule|toner|cleanser|moisturi[sz]er|cream|lotion|mask|vitamin|treatment|booster|peel|spf)\b/;

// A code is the short identifier a store prints in front of (or instead of) a shade name.
// Returns the normalized code, or ''.
function readCodeToken(token, previousToken = '', nextToken = '', { last = false } = {}) {
  const raw = asString(token).replace(/[,:;)]+$/, '').replace(/^[(]+/, '');
  if (!raw) return '';
  if (SUN_FACTOR_TOKEN_RE.test(asString(previousToken))) return '';
  if (/^(?:spf|pa|uv|upf)\d/i.test(raw)) return '';
  if (VERSION_TOKEN_RE.test(raw) || VERSION_WORD_RE.test(asString(previousToken))) return '';
  const nextIsUnit = UNIT_TOKEN_RE.test(asString(nextToken).replace(/[.,]+$/, ''));
  // NO.884, NO.Q14, NO.Q6
  let match = raw.match(/^(?:no\.?|n°|nº)([a-z]{0,2}\d{1,4}[a-z]?)$/i);
  if (match) return match[1].toLowerCase();
  match = raw.match(/^#([a-z]{0,2}\d{1,4}[a-z]?)$/i);
  if (match) return match[1].toLowerCase();
  if (nextIsUnit) return '';
  // One- or two-letter prefix: K2207, RX318, T41.
  match = raw.match(/^([a-z]{1,2}\d{2,5}[a-z]?)$/i);
  if (match) return match[1].toLowerCase();
  // A letter and ONE digit (R7) is a code only as the title's last token: "<LINE> R7". Inside a
  // title it is too often part of the name (a vitamin, a step, a generation). Even then it must be
  // confirmed by the line: see SHORT_CODE_UNCONFIRMED / SHORT_CODE_SKINCARE.
  if (last) {
    match = raw.match(/^([a-z]{1,2}\d)$/i);
    if (match) return match[1].toLowerCase();
  }
  // Bare number: 517, 88, 03N. Not a year ("Holiday 2024"), not a product descriptor
  // (24H / 10X / 3D / 24K), and not a size glued to its unit (15G / 30L) -- but a zero-padded
  // number is a code even when its letter is a unit letter (05G, 06L): no size is written "05 g".
  match = raw.match(/^(\d{2,4}[a-z]?)$/i);
  const gluedUnit = match && /[gl]$/i.test(match[1]) && !/^0/.test(match[1]);
  if (match && !YEAR_RE.test(match[1]) && !/[hxdk]$/i.test(match[1]) && !gluedUnit) return match[1].toLowerCase();
  return '';
}

// "NO." "884" and "#" "271" written as two tokens.
function joinSplitCodePrefixes(tokens) {
  const out = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    const next = tokens[idx + 1];
    if (/^(?:no\.?|n°|nº|#)$/i.test(token) && next && /^[a-z]{0,2}\d{1,4}[a-z]?[,:;]?$/i.test(next)) {
      out.push(`${token.startsWith('#') ? '#' : 'no.'}${next}`);
      idx += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function tokenizeTitle(title) {
  const spaced = asString(title)
    // "Lacquer-405" -> "Lacquer 405": a code glued to the line word by a hyphen.
    .replace(/([a-z])-(\d)/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!spaced) return [];
  return joinSplitCodePrefixes(spaced.split(' ').filter(Boolean));
}

function findFirstCode(tokens, startIndex = 0) {
  for (let idx = startIndex; idx < tokens.length; idx += 1) {
    const code = readCodeToken(tokens[idx], tokens[idx - 1], tokens[idx + 1], { last: idx === tokens.length - 1 });
    if (code) return { index: idx, code };
  }
  return null;
}

// Parses one title into { format, line, code, name }. `line` is the raw text before the shade.
function parseShadeLineTitle(rawTitle) {
  const title = stripBracketTags(rawTitle);
  if (!title) return null;

  // "<LINE> - <TAIL>": the separator names the boundary explicitly.
  const separated = title.match(/^(.*\S)\s+[-–—]\s+(.+)$/);
  if (separated) {
    const line = separated[1].trim();
    let tail = separated[2].trim();
    // "<NAME> #<CODE>" (trailing hash code).
    const trailingHash = tail.match(/^(.*?)\s*#\s*([a-z]{0,2}\d{1,4}[a-z]?)$/i);
    if (trailingHash && trailingHash[1].trim()) {
      return { format: 'separator_name_hash_code', line, code: trailingHash[2].toLowerCase(), name: trailingHash[1].trim() };
    }
    const tailTokens = tokenizeTitle(tail);
    const leading = tailTokens.length ? readCodeToken(tailTokens[0], '', tailTokens[1], { last: tailTokens.length === 1 }) : '';
    if (leading) {
      tail = tailTokens.slice(1).join(' ');
      return { format: 'separator_code_name', line, code: leading, name: tail };
    }
    return { format: 'separator_name', line, code: '', name: tail };
  }

  // "<LINE> <CODE> [<NAME>]": the first code token after at least one line token.
  const tokens = tokenizeTitle(title);
  if (tokens.length < 2) return null;
  const found = findFirstCode(tokens, 1);
  if (!found) return null;
  const line = tokens.slice(0, found.index).join(' ');
  const name = tokens.slice(found.index + 1).join(' ');
  return {
    format: name ? 'code_name' : 'code_only',
    line,
    code: found.code,
    name,
  };
}

// ---------------------------------------------------------------------------------------------
// Guards on one listing
// ---------------------------------------------------------------------------------------------

const BUNDLE_WORD_RE = /\b(?:set|sets|kit|kits|bundle|bundles|duo|trio|gift set|gift box|value pack|multipack)\b/;
const NON_SHADE_SUFFIX_RULES = [
  ['mini', /\b(?:mini|minis|travel|travel size|sample|samples|deluxe sample|refill|refills|jumbo|full size)\b/],
  ['sun_factor', /\b(?:spf|pa|uv|upf)\s*\d*\b|\bpa\+/],
  ['size', /\b\d+(?:[.,]\d+)?\s*(?:ml|m l|l|g|gr|gram|grams|kg|mg|oz|fl oz|floz|lb|lbs|mm|cm|pcs|pc|pieces|pack|ct|count|ea)\b/],
  [
    'product_noun',
    /\b(?:lipstick|lip gloss|mascara|foundation|concealer|serum|cleanser|toner|moisturi[sz]er|lotion|primer|brush|brushes|tool|tools|sticker|stickers|decal|decals)\b/,
  ],
];

// The nail SYSTEM around the colours (base, top, builder, remover, cuticle oil, file, ...) is not
// a shade, whatever its code. A system word inside a colour NAME is ("Rose Oil", "Base Camp
// Beige", "Desert Tip"), so a name is refused only when it is a known system phrase, or when it
// is made of system words and their qualifiers alone ("Base", "Matte Top", "Builder Gel Clear").
const NAIL_SYSTEM_NOUNS = new Set([
  'base', 'top', 'builder', 'rubber', 'bond', 'bonder', 'dehydrator', 'prep', 'remover', 'acetone',
  'cuticle', 'oil', 'lamp', 'file', 'files', 'buffer', 'glue', 'tip', 'tips', 'extension', 'polygel',
  'foil', 'stencil',
]);
const NAIL_SYSTEM_QUALIFIERS = new Set([
  'gel', 'coat', 'no', 'wipe', 'free', 'clear', 'glass', 'nail', 'nails', 'uv', 'led', 'soak', 'off',
  'hard', 'soft', 'poly', 'liquid', 'strong', 'strength', 'cover', 'gels',
]);
const NAIL_SYSTEM_PHRASE_RE = /\b(?:top coat|base coat|top gel|base gel|builder gel|rubber base|no wipe|cuticle oil|nail file|polish remover|gel remover|acetone|dehydrator|polygel|poly gel)\b/;

function isNailSystemName(normalizedName) {
  if (NAIL_SYSTEM_PHRASE_RE.test(normalizedName)) return true;
  const words = normalizedName.split(' ').filter(Boolean);
  return (
    words.some((word) => NAIL_SYSTEM_NOUNS.has(word)) &&
    words.every((word) => NAIL_SYSTEM_NOUNS.has(word) || NAIL_SYSTEM_QUALIFIERS.has(word) || FINISH_WORDS.has(word))
  );
}
const FINISH_WORDS = new Set([
  'matte', 'matt', 'gloss', 'glossy', 'shine', 'shimmer', 'glitter', 'satin', 'cream', 'creme', 'metallic',
  'sheer', 'velvet', 'frost', 'frosted', 'pearl', 'pearly', 'chrome', 'jelly', 'neon', 'holo', 'holographic',
  'finish', 'effect', 'and',
]);

function detectNonShadeSuffix({ title, name }) {
  const normalizedTitle = normalizeLineText(stripBracketTags(title));
  if (BUNDLE_WORD_RE.test(normalizedTitle)) return 'set';
  const normalizedName = normalizeLineText(name);
  if (!normalizedName) return '';
  for (const [kind, pattern] of NON_SHADE_SUFFIX_RULES) {
    if (pattern.test(normalizedName)) return kind;
  }
  if (isNailSystemName(normalizedName)) return 'nail_system';
  const words = normalizedName.split(' ').filter(Boolean);
  if (words.length && words.every((word) => FINISH_WORDS.has(word))) return 'finish_only';
  return '';
}

// Nail products carry no makeup context word, and the seed payload's product_type is the
// placeholder 'external' with no category. So: the catalog category / type when the caller has
// one, else the v1 makeup context, else a nail vocabulary. "gel" alone is too broad (shower gel,
// cleansing gel, eye gel), so it counts only with no body/skin/hair word beside it.
const NAIL_CONTEXT_RE = /\b(?:nail|nails|polish|lacquer|lacquers|manicure|pedicure|enamel|soak off|builder gel|gel colou?r|gel polish|colou?r gel)\b/;
const GEL_CONTEXT_RE = /\bgels?\b/;
const GEL_EXCLUSION_RE = /\b(?:shower|bath|body|hair|styling|cleansing|cleanser|wash|face|facial|eye|aloe|hand|sanitizer|serum|moisturi[sz]\w*|cream|lotion|tooth\w*|gum|lubricant|cooling|soothing|after sun)\b/;
const SHADE_CATEGORY_RE = /\b(?:nail|nails|polish|lacquer|manicure|makeup|make up|cosmetic|cosmetics|lip|lips|lipstick|eye|eyes|eyeshadow|eyeliner|brow|face|foundation|concealer|blush|bronzer|highlighter|powder|mascara|color|colour)\b/;
const NON_SHADE_CATEGORY_RE = /\b(?:skincare|skin care|hair|haircare|fragrance|perfume|bath|body care|supplement|wellness|tool|tools|device|accessor\w*)\b/;

function isPlaceholderCategory(normalized) {
  // 'external' is the seed payload's placeholder, not a category.
  return !normalized || normalized === 'external' || normalized === 'external seed';
}

// The category as path segments ("beauty/nails/gel polish" -> ['beauty','nails','gel polish']).
function readCategoryPath(product, sourceMeta) {
  const meta = asPlainObject(sourceMeta) || {};
  const candidates = [meta.catalog_category_path, product?.category_path, product?.categoryPath, product?.category];
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate.filter(Boolean).join('/') : asString(candidate);
    const segments = value
      .split(/[/>|]+/)
      .map((segment) => normalizeLineText(segment))
      .filter(Boolean);
    if (segments.length && !isPlaceholderCategory(segments.join(' '))) return segments;
  }
  return [];
}

function readProductType(product, sourceMeta) {
  const meta = asPlainObject(sourceMeta) || {};
  for (const candidate of [meta.catalog_product_type, product?.product_type, product?.productType]) {
    const normalized = normalizeLineText(candidate);
    if (!isPlaceholderCategory(normalized)) return normalized;
  }
  return '';
}

// Two category paths agree when one is a prefix of the other ("beauty/nails" and
// "beauty/nails/gel polish"); they disagree when they branch ("…/gel polish" vs "…/remover").
function categoryPathsCompatible(left = [], right = []) {
  if (!left.length || !right.length) return true;
  const length = Math.min(left.length, right.length);
  for (let idx = 0; idx < length; idx += 1) {
    if (left[idx] !== right[idx]) return false;
  }
  return true;
}

function hasShadeLineContext({ product, categoryText, makeupContext }) {
  if (categoryText) {
    // Non-shade first: "skincare/face/serum" names a face but is not a shade category.
    if (NON_SHADE_CATEGORY_RE.test(categoryText)) return false;
    if (SHADE_CATEGORY_RE.test(categoryText)) return true;
  }
  if (typeof makeupContext === 'function' ? makeupContext() : makeupContext) return true;
  const haystack = normalizeLineText(
    [product?.title, product?.name, product?.product_type, product?.category, ...(Array.isArray(product?.tags) ? product.tags : [])]
      .filter(Boolean)
      .join(' '),
  );
  if (!haystack) return false;
  if (NAIL_CONTEXT_RE.test(haystack)) return true;
  return GEL_CONTEXT_RE.test(haystack) && !GEL_EXCLUSION_RE.test(haystack);
}

function buildShadeKey({ code, name }) {
  // The code is the store's identity for a shade; the name only when there is no code.
  return code ? `code:${code}` : `name:${normalizeLineText(name)}`;
}

// "BRANDX 731 PAPAYA": the line is the brand and nothing else.
function isBrandOnlyLine(lineNorm, brandNorm) {
  const brandTokens = new Set(normalizeLineText(brandNorm).split(' ').filter(Boolean));
  const lineTokens = asString(lineNorm).split(' ').filter(Boolean);
  return lineTokens.length > 0 && lineTokens.every((token) => brandTokens.has(token));
}

/**
 * Per-listing half. Returns null when the title is not a shade-line title at all, or
 * { refused: <reason>, ... } when it is one but a guard refuses it, or the candidate.
 *
 * @param {object} args
 * @param {object} args.product          the listing's source payload
 * @param {object} [args.sourceMeta]     catalog_category_path / catalog_product_type when known
 * @param {object} [args.axes]           the listing's variant axes (a size/volume/pack axis refuses)
 * @param {string} args.merchantId
 * @param {string} [args.storeDomain]    the listing's source domain (one store = merchant + domain)
 * @param {string} [args.brandNorm]
 * @param {boolean|function} [args.makeupContext] the v1 makeup-context result (or a thunk for it)
 * @param {{amount:number,currency:string}|null|function} [args.price] (or a thunk for it, read
 *        only once every per-listing guard has passed)
 * @param {object|null} [args.v1Family]  extractMultiPageShadeFamilyCandidate's result
 */
function extractShadeLineCandidate({
  product,
  sourceMeta = {},
  axes = {},
  merchantId = '',
  storeDomain = '',
  brandNorm = '',
  makeupContext = false,
  price = null,
  v1Family = null,
} = {}) {
  const title = asString(product?.title || product?.name || product?.display_name);
  if (!title) return null;
  const parsed = parseShadeLineTitle(title);
  if (!parsed) return null;
  const lineNorm = normalizeLineText(parsed.line);
  const nameNorm = normalizeLineText(parsed.name);
  if (!lineNorm || (!parsed.code && !nameNorm)) return null;
  const shadeValue = normalizeLineText([parsed.code, parsed.name].filter(Boolean).join(' '));
  const categoryPath = readCategoryPath(product, sourceMeta);
  const productType = readProductType(product, sourceMeta);
  const base = {
    rule_version: SHADE_LINE_RULE_VERSION,
    format: parsed.format,
    line_norm: lineNorm,
    code: parsed.code || '',
    name_norm: nameNorm,
    shade_value: shadeValue,
    shade_key: buildShadeKey(parsed),
    category_path: categoryPath,
    product_type: productType,
    brand_norm: asString(brandNorm),
    store: '',
    price: null,
  };

  const categoryText = [...categoryPath, productType].filter(Boolean).join(' ');
  if (!hasShadeLineContext({ product, categoryText, makeupContext })) {
    return { ...base, refused: SHADE_LINE_REFUSALS.NO_CONTEXT };
  }
  const suffix = detectNonShadeSuffix({ title, name: parsed.name });
  if (suffix) {
    return { ...base, refused: `${SHADE_LINE_REFUSALS.NON_SHADE_SUFFIX}:${suffix}` };
  }
  const safeAxes = asPlainObject(axes) || {};
  // Every shade of a line usually shares one size ("15 ml"); that is fine. Members whose sizes
  // DIFFER are refused per group (size_mismatch): a second size would turn the line's picker into
  // a size picker (resolveProductLineOptionAxis prefers an implicit size baseline).
  base.size_signature = ['size', 'volume', 'pack']
    .map((key) => normalizeLineText(safeAxes[key]))
    .map((value, idx) => (value ? `${['size', 'volume', 'pack'][idx]}:${value}` : ''))
    .filter(Boolean)
    .join('|') || '-';
  // The shortest code shape (a letter + one digit) on a skincare line is a vitamin or a formula
  // number ("Glow Serum B5"), not a shade, whatever the category says.
  // Only a BARE short code needs confirming: "NO.Q6" / "#Q6" are marked as codes by their prefix.
  const lastToken = asString(tokenizeTitle(stripBracketTags(title)).slice(-1)[0]).replace(/[,:;)]+$/, '');
  const shortCode = parsed.code && !parsed.name ? (lastToken.match(SHORT_CODE_RE) || [])[1] : '';
  base.short_code_prefix = shortCode ? shortCode.toLowerCase() : '';
  if (base.short_code_prefix && SHORT_CODE_SKINCARE_LINE_RE.test(lineNorm)) {
    return { ...base, refused: SHADE_LINE_REFUSALS.SHORT_CODE_SKINCARE };
  }
  if (!base.brand_norm) return { ...base, refused: SHADE_LINE_REFUSALS.MISSING_BRAND };
  const mid = asString(merchantId);
  if (!mid) return { ...base, refused: SHADE_LINE_REFUSALS.MISSING_STORE };
  const store = `${mid}@${asString(storeDomain).toLowerCase() || '-'}`;

  const resolvedPrice = typeof price === 'function' ? price() : price;
  const candidate = {
    ...base,
    store,
    price:
      resolvedPrice && Number.isFinite(Number(resolvedPrice.amount)) && Number(resolvedPrice.amount) > 0
        ? { amount: Number(resolvedPrice.amount), currency: asString(resolvedPrice.currency).toUpperCase() }
        : null,
  };

  // Rule v1 already strips the WHOLE shade for this title (its descriptor is the same value), so
  // its line key already groups these siblings. Leave it to v1; a v2 sibling in the same store
  // line ADOPTS the v1 line when it is this store's alone (applyShadeLineGrouping).
  const v1Value = normalizeLineText(v1Family?.value);
  if (v1Value && v1Value === shadeValue) {
    return { ...candidate, superseded_by: 'variant_family_v1' };
  }
  return candidate;
}

// ---------------------------------------------------------------------------------------------
// Group guards over a batch
// ---------------------------------------------------------------------------------------------

function modalValue(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildShadeLineKey({ store, brandNorm, lineNorm }) {
  return `${SHADE_LINE_RULE_VERSION}:${store}:${brandNorm}:${lineNorm}`;
}

/**
 * Decides one group (same store + same line text). Returns
 *   { approved: [entry], refused: [{ entry, reason }], line_key, product_line_id, review_family_id }
 * `adopt` ({ product_line_id, review_family_id, members, shade_keys, reference }) is the v1 line that
 * same-store siblings of this line already live in: the group joins it, and its known members
 * (`reference`: their candidates) count in the brand / category / size / currency / price
 * baselines, so a new shade must agree with the line it joins. `existingMemberCountFor` is how
 * many listings outside the batch already hold the proposed line id.
 */
function decideShadeLineGroup(entries, { existingMemberCountFor = () => 0, adopt = null } = {}) {
  const refused = [];
  let alive = entries.slice();
  const reference = Array.isArray(adopt?.reference) ? adopt.reference : [];
  const baseline = (pick) => [...alive.map((entry) => pick(entry.candidate)), ...reference.map(pick)];
  const refuse = (predicate, reason) => {
    const keep = [];
    for (const entry of alive) {
      if (predicate(entry)) refused.push({ entry, reason });
      else keep.push(entry);
    }
    alive = keep;
  };

  const brand = modalValue(baseline((candidate) => candidate.brand_norm));
  refuse((entry) => entry.candidate.brand_norm !== brand, SHADE_LINE_REFUSALS.BRAND_MISMATCH);

  // A brand-only line ("BRANDX 731 PAPAYA") would gather every coded item the brand sells at the
  // store, so it needs proof that its members are one kind of product: a known category AND a
  // known product type on every member (and the category check below makes them match).
  if (alive.length && isBrandOnlyLine(alive[0].candidate.line_norm, brand)) {
    refuse(
      (entry) => !entry.candidate.category_path.length || !entry.candidate.product_type,
      SHADE_LINE_REFUSALS.BRAND_ONLY_UNSCOPED,
    );
  }

  const productType = modalValue(baseline((candidate) => candidate.product_type));
  const categoryKey = modalValue(baseline((candidate) => candidate.category_path.join('/')));
  const modalCategory = categoryKey ? categoryKey.split('/') : [];
  // An unknown category or type is not a different one; only two KNOWN values disagree.
  refuse(
    (entry) =>
      Boolean(productType && entry.candidate.product_type && entry.candidate.product_type !== productType) ||
      !categoryPathsCompatible(entry.candidate.category_path, modalCategory),
    SHADE_LINE_REFUSALS.CATEGORY_MISMATCH,
  );

  // One size across the line is fine, and a member that states NO size is compatible with it
  // (stores often omit the size on some shade pages). Only two members that state DIFFERENT
  // sizes disagree: the one that differs from the line's size is not a shade of it.
  const sizedOrBlank = (candidate) => (candidate.size_signature && candidate.size_signature !== '-' ? candidate.size_signature : '');
  const sizeSignature = modalValue(baseline(sizedOrBlank));
  refuse(
    (entry) => Boolean(sizeSignature && sizedOrBlank(entry.candidate) && sizedOrBlank(entry.candidate) !== sizeSignature),
    SHADE_LINE_REFUSALS.SIZE_MISMATCH,
  );

  const currency = modalValue(baseline((candidate) => candidate.price?.currency || ''));
  refuse(
    (entry) => Boolean(currency && entry.candidate.price && entry.candidate.price.currency !== currency),
    SHADE_LINE_REFUSALS.CURRENCY_MISMATCH,
  );

  const lineMedian = median([
    ...alive.map((entry) => entry.candidate.price?.amount),
    ...reference.filter((candidate) => !currency || candidate.price?.currency === currency).map((candidate) => candidate.price?.amount),
  ]);
  if (lineMedian) {
    refuse((entry) => {
      const amount = entry.candidate.price?.amount;
      if (!amount) return false;
      const ratio = Math.max(amount / lineMedian, lineMedian / amount);
      return ratio > SHADE_LINE_MAX_PRICE_RATIO;
    }, SHADE_LINE_REFUSALS.PRICE_OUTLIER);
  }

  // A short code (R7) groups only when the line confirms the shape: at least two members (counting
  // the line's known v1 members) carry codes with the same letter prefix.
  const shortPrefixCounts = new Map();
  for (const candidate of [...alive.map((entry) => entry.candidate), ...reference]) {
    if (candidate.short_code_prefix) {
      shortPrefixCounts.set(candidate.short_code_prefix, (shortPrefixCounts.get(candidate.short_code_prefix) || 0) + 1);
    }
  }
  refuse(
    (entry) => Boolean(entry.candidate.short_code_prefix) && (shortPrefixCounts.get(entry.candidate.short_code_prefix) || 0) < 2,
    SHADE_LINE_REFUSALS.SHORT_CODE_UNCONFIRMED,
  );

  const shadeCounts = new Map();
  for (const key of adopt?.shade_keys || []) shadeCounts.set(key, (shadeCounts.get(key) || 0) + 1);
  for (const entry of alive) {
    shadeCounts.set(entry.candidate.shade_key, (shadeCounts.get(entry.candidate.shade_key) || 0) + 1);
  }
  // Two pages for one shade are not two options; neither new page is chosen over the other (a v1
  // sibling already in the line keeps its place).
  refuse((entry) => shadeCounts.get(entry.candidate.shade_key) > 1, SHADE_LINE_REFUSALS.DUPLICATE_SHADE);

  const lineKey = entries.length
    ? buildShadeLineKey({ store: entries[0].candidate.store, brandNorm: brand, lineNorm: entries[0].candidate.line_norm })
    : '';
  const productLineId = adopt?.product_line_id || (lineKey ? stableHash('pl', [lineKey]) : '');
  const reviewFamilyId = adopt?.product_line_id
    ? adopt.review_family_id || adopt.product_line_id
    : lineKey
      ? stableHash('rf', [lineKey])
      : '';
  const existing = productLineId ? Number(existingMemberCountFor(productLineId)) || 0 : 0;
  const adoptedMembers = Number(adopt?.members) || 0;
  if (alive.length + existing + adoptedMembers < SHADE_LINE_MIN_MEMBERS) {
    refuse(() => true, SHADE_LINE_REFUSALS.LINE_TOO_SMALL);
  }
  return {
    approved: alive,
    refused,
    line_key: lineKey,
    product_line_id: productLineId,
    review_family_id: reviewFamilyId,
    adopted: Boolean(adopt?.product_line_id),
  };
}

// "merch_x@shop.example": one store is one seller of record on one domain. An unknown domain
// ('-') never matches anything, so a line whose store cannot be told is never treated as one store.
function sameStore(left, right) {
  const split = (value) => {
    const text = asString(value);
    const at = text.lastIndexOf('@');
    const merchant = at >= 0 ? text.slice(0, at) : text;
    const domain = (at >= 0 ? text.slice(at + 1) : '').toLowerCase().replace(/^www\./, '');
    return { merchant, domain: domain === '-' ? '' : domain };
  };
  const a = split(left);
  const b = split(right);
  return Boolean(a.merchant && a.merchant === b.merchant && a.domain && a.domain === b.domain);
}

function buildStoreKey(merchantId, domain) {
  return `${asString(merchantId)}@${asString(domain).toLowerCase() || '-'}`;
}

/** The v1 line ids that v2 shades in this batch could adopt (for the store-scope read). */
function collectAdoptableV1LineIds(listings, { storedLines = new Map() } = {}) {
  const ids = new Set();
  for (const listing of Array.isArray(listings) ? listings : []) {
    const candidate = asPlainObject(listing?.shade_line_candidate);
    if (!candidate?.superseded_by) continue;
    const stored = storedLines instanceof Map ? storedLines.get(asString(listing.source_listing_ref)) : null;
    const lineId = asString(stored?.product_line_id) || asString(listing.product_line_id);
    if (lineId) ids.add(lineId);
  }
  return [...ids];
}

function withShadeLineDecision(listing, decision) {
  const softIdentity = asPlainObject(listing.soft_identity) || {};
  return {
    ...listing,
    soft_identity: {
      ...softIdentity,
      shade_line: { rule_version: SHADE_LINE_RULE_VERSION, ...decision },
    },
  };
}

/**
 * Batch half. `listings` are built identity listings carrying `shade_line_candidate`
 * (buildIdentityListingFromProduct). Returns { listings, stats }.
 *   existingMemberCounts: Map(shade-line product_line_id -> listings outside this batch holding it)
 *   storedLines:          Map(source_listing_ref -> { product_line_id, review_family_id }) for the
 *                         batch's listings that already exist; their stored line is never moved.
 */
function applyShadeLineGrouping(listings, {
  existingMemberCounts = new Map(),
  storedLines = new Map(),
  lineStores = new Map(),
} = {}) {
  const safe = Array.isArray(listings) ? listings : [];
  const groups = new Map();
  const v1Siblings = new Map();
  const decisions = new Map();
  const stats = { candidates: 0, approved: 0, proposed: 0, adopted: 0, adoption_not_store_scoped: 0, refused: {}, lines: 0 };
  const countRefusal = (reason) => {
    stats.refused[reason] = (stats.refused[reason] || 0) + 1;
  };
  const storedOf = (listing) =>
    (storedLines instanceof Map ? storedLines.get(asString(listing?.source_listing_ref)) : null) || null;

  safe.forEach((listing, index) => {
    const candidate = asPlainObject(listing?.shade_line_candidate);
    if (!candidate) return;
    if (candidate.refused === SHADE_LINE_REFUSALS.NO_CONTEXT) {
      // Any title with a code-like token parses ("Bright C23 Serum"); without a shade context it
      // was never a shade-line candidate, so it is counted and the listing is left untouched.
      countRefusal(candidate.refused);
      return;
    }
    if (candidate.superseded_by) {
      const groupKey = `${candidate.store}|${candidate.line_norm}`;
      const siblings = v1Siblings.get(groupKey) || [];
      siblings.push({ listing, candidate });
      v1Siblings.set(groupKey, siblings);
      return;
    }
    stats.candidates += 1;
    if (candidate.refused) {
      decisions.set(index, { refused: candidate.refused });
      return;
    }
    if (listing.matched_by_rule === 'reviewed_multi_offer_merge') {
      decisions.set(index, { refused: SHADE_LINE_REFUSALS.REVIEWED_MERGE });
      return;
    }
    if (listing.identity_status !== 'approved') {
      decisions.set(index, { refused: SHADE_LINE_REFUSALS.NOT_APPROVED });
      return;
    }
    const groupKey = `${candidate.store}|${candidate.line_norm}`;
    const group = groups.get(groupKey) || [];
    group.push({ index, listing, candidate });
    groups.set(groupKey, group);
  });

  const existingMemberCountFor = (lineId) =>
    existingMemberCounts instanceof Map ? existingMemberCounts.get(lineId) || 0 : 0;
  // Every store that holds a line: the batch's own listings, plus the stored members outside the
  // batch (`lineStores`; null = unknown, which never allows an adoption).
  const lineIdOf = (listing) => asString(storedOf(listing)?.product_line_id) || asString(listing?.product_line_id);
  const batchStoresByLine = new Map();
  for (const listing of safe) {
    const lineId = lineIdOf(listing);
    if (!lineId) continue;
    const stores = batchStoresByLine.get(lineId) || [];
    stores.push(asString(asPlainObject(listing?.shade_line_candidate)?.store) || buildStoreKey(listing?.merchant_id, ''));
    batchStoresByLine.set(lineId, stores);
  }
  const isStoreScopedLine = (lineId, store) => {
    if (!(lineStores instanceof Map)) return false;
    const stores = [...(batchStoresByLine.get(lineId) || []), ...(lineStores.get(lineId) || [])];
    return stores.length > 0 && stores.every((other) => sameStore(other, store));
  };
  for (const [groupKey, entries] of groups.entries()) {
    const siblings = v1Siblings.get(groupKey) || [];
    const v1LineId = siblings.length ? modalValue(siblings.map(({ listing }) => lineIdOf(listing))) : '';
    // Adopt the v1 line only when it is THIS store's line. A v1 key is not store-scoped, so a v1
    // line that also holds another seller's (or another domain's) pages is not widened with this
    // store's shades: the store line is minted instead, and the census reports the v1 siblings.
    const scoped = Boolean(v1LineId) && isStoreScopedLine(v1LineId, entries[0].candidate.store);
    if (v1LineId && !scoped) stats.adoption_not_store_scoped += 1;
    const adopt = scoped
      ? {
          product_line_id: v1LineId,
          review_family_id: modalValue(
            siblings.map(({ listing }) => asString(storedOf(listing)?.review_family_id) || asString(listing.review_family_id)),
          ),
          members: siblings.length,
          shade_keys: siblings.map(({ candidate }) => candidate.shade_key),
          reference: siblings.map(({ candidate }) => candidate),
        }
      : null;
    const decision = decideShadeLineGroup(entries, { existingMemberCountFor, adopt });
    decision.v1_line_not_store_scoped = Boolean(v1LineId && !scoped) ? v1LineId : '';
    for (const { entry, reason } of decision.refused) {
      decisions.set(entry.index, {
        refused: reason,
        ...(decision.product_line_id ? { proposed_product_line_id: decision.product_line_id } : {}),
      });
    }
    if (decision.approved.length) {
      stats.lines += 1;
      if (decision.adopted) stats.adopted += 1;
    }
    for (const entry of decision.approved) {
      decisions.set(entry.index, {
        approved: true,
        store: entry.candidate.store,
        line_key: decision.line_key,
        product_line_id: decision.product_line_id,
        review_family_id: decision.review_family_id,
        adopted: decision.adopted,
        v1_line_not_store_scoped: decision.v1_line_not_store_scoped,
      });
    }
  }

  const out = safe.map((listing, index) => {
    const decision = decisions.get(index);
    if (!decision) return listing;
    if (decision.refused) {
      countRefusal(decision.refused);
      return withShadeLineDecision(listing, {
        status: 'refused',
        reason: decision.refused,
        ...(decision.proposed_product_line_id ? { proposed_product_line_id: decision.proposed_product_line_id } : {}),
      });
    }
    const candidate = listing.shade_line_candidate;
    const stored = storedOf(listing);
    const storedLineId = asString(stored?.product_line_id);
    if (storedLineId && storedLineId !== decision.product_line_id) {
      // Already stored in another line: nothing about the row moves (its id is sticky, and its
      // axes and review family stay as built). The proposal is the re-key backlog.
      stats.proposed += 1;
      return withShadeLineDecision(listing, {
        status: 'proposed',
        proposed_product_line_id: decision.product_line_id,
        proposed_review_family_id: decision.review_family_id,
        stored_product_line_id: storedLineId,
        store: decision.store,
        shade_value: candidate.shade_value,
        ...(decision.v1_line_not_store_scoped ? { v1_line_not_store_scoped: decision.v1_line_not_store_scoped } : {}),
      });
    }
    stats.approved += 1;
    const axes = asPlainObject(listing.variant_axes) || {};
    const hasColourAxis = Boolean(asString(axes.shade) || asString(axes.color));
    return withShadeLineDecision(
      {
        ...listing,
        product_line_id: decision.product_line_id,
        review_family_id: decision.review_family_id,
        // The picker (buildProductLineOptions) reads the option value from variant_axes.
        variant_axes: hasColourAxis ? axes : { ...axes, shade: candidate.shade_value },
      },
      {
        status: 'approved',
        product_line_id: decision.product_line_id,
        review_family_id: decision.review_family_id,
        line_key: decision.line_key,
        // The store (seller of record @ domain) this member was lined up in: card collapse buckets
        // by it, so one card never folds another merchant's listings.
        store: decision.store,
        shade_value: candidate.shade_value,
        format: candidate.format,
        ...(decision.adopted ? { adopted_v1_line: true } : {}),
        ...(decision.v1_line_not_store_scoped ? { v1_line_not_store_scoped: decision.v1_line_not_store_scoped } : {}),
      },
    );
  });

  return { listings: out, stats };
}

function readShadeLineDecision(row) {
  let decision = row?.shade_line;
  if (typeof decision === 'string') {
    try {
      decision = JSON.parse(decision);
    } catch (_) {
      decision = null;
    }
  }
  return asPlainObject(decision) || asPlainObject(asPlainObject(row?.soft_identity)?.shade_line) || null;
}

/**
 * The line id a stored row was placed in BY THIS RULE, or ''. The decision must be `approved` and
 * name the row's stored product_line_id: a sticky row whose rebuild only PROPOSES a line is not in
 * that line yet.
 */
function readVerifiedShadeLineId(row) {
  const lineId = asString(row?.product_line_id);
  if (!lineId) return '';
  const decision = readShadeLineDecision(row);
  if (!decision || decision.rule_version !== SHADE_LINE_RULE_VERSION) return '';
  return decision.status === 'approved' && asString(decision.product_line_id) === lineId ? lineId : '';
}

/** The line id a row's latest rebuild proposes (approved or proposed), whatever its stored id. */
function readProposedShadeLineId(row) {
  const decision = readShadeLineDecision(row);
  if (!decision || decision.rule_version !== SHADE_LINE_RULE_VERSION) return '';
  if (decision.status === 'approved') return asString(decision.product_line_id);
  if (decision.status === 'proposed') return asString(decision.proposed_product_line_id);
  return '';
}

module.exports = {
  SHADE_LINE_RULE_FLAG,
  SHADE_LINE_RULE_VERSION,
  SHADE_LINE_MAX_PRICE_RATIO,
  SHADE_LINE_MIN_MEMBERS,
  SHADE_LINE_REFUSALS,
  applyShadeLineGrouping,
  buildStoreKey,
  collectAdoptableV1LineIds,
  decideShadeLineGroup,
  extractShadeLineCandidate,
  isShadeLineRuleEnabled,
  parseShadeLineTitle,
  readProposedShadeLineId,
  readShadeLineDecision,
  readVerifiedShadeLineId,
  _internals: {
    buildShadeLineKey,
    categoryPathsCompatible,
    detectNonShadeSuffix,
    hasShadeLineContext,
    isBrandOnlyLine,
    normalizeLineText,
    readCategoryPath,
    readCodeToken,
    readProductType,
    sameStore,
    stripBracketTags,
  },
};
