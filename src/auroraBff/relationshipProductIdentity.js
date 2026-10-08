'use strict';

// One identity contract for the relationship graph: are two listings the same product, options
// (shade / size / style / scent) of one product, or distinct products? The build prefilter, the
// builder, the serving guard, the pair policy and recall all ask compareProductIdentity; none of
// them re-derives "same product" from titles on its own.
//
// Order of evidence:
//   1. Structured keys. An equal listing id / pivota signature, content_key, canonical entity or
//      product group, GTIN or canonical URL proves the same product. A DIFFERENT non-empty key
//      proves nothing: shades of one product carry different signatures and content keys.
//   2. One consolidated title rule set, applied only when both brands resolve to the same brand
//      (names first, brand ids only when both sides have nothing but ids).
// A false "same" hides a good edge at read time, so every title rule fails closed: an unknown
// product job, a differing formula marker (SPF, %, intense, finish...) or an unclassified
// functional constraint keeps the pair distinct.

const { optionRole, normalizedTitle, title: snapshotTitle, COSMETIC_ROLES } = require('./relationshipPairPolicy');

const RELATIONS = Object.freeze({
  SAME_PRODUCT: 'same_product',
  SAME_FAMILY_VARIANT: 'same_family_variant',
  DISTINCT: 'distinct',
  UNKNOWN: 'unknown',
});

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value) {
  if (value == null || typeof value === 'object') return '';
  return normalizeString(value, 1024);
}

// ---------------------------------------------------------------------------------------------
// Shade lexicon. familyIdentityKey (recall dedupe / serving family buckets) strips a recognised
// terminal shade with exactly these words; the title rules below use the same words.
// ---------------------------------------------------------------------------------------------
const SHADE_LEXICON = new Set([
  'almond', 'amber', 'banana', 'beige', 'berry', 'black', 'bronze', 'brown', 'caramel', 'champagne',
  'chestnut', 'clear', 'cocoa', 'cool', 'copper', 'coral', 'dark', 'deep', 'espresso', 'fair',
  'golden', 'honey', 'ivory', 'light', 'maple', 'mauve', 'medium', 'mocha', 'neutral', 'nude',
  'olive', 'opal', 'peach', 'pearl', 'pink', 'plum', 'porcelain', 'red', 'rose', 'sand',
  'tan', 'translucent', 'vanilla', 'warm', 'white', 'wine',
]);

const SHADE_DESCRIPTOR_LEXICON = new Set([
  'beige', 'cool', 'dark', 'deep', 'fair', 'golden', 'light', 'medium', 'neutral', 'tan', 'warm',
]);

// Words that may follow a shade NUMBER ("23 Natural Beige", "21 Light Beige").
const NUMERIC_SHADE_WORDS = new Set([...SHADE_LEXICON, ...SHADE_DESCRIPTOR_LEXICON, 'natural', 'bright', 'soft']);

function normalizeFamilyText(value, max = 512) {
  const text = normalizeString(value, max)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9#./'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function normalizeFamilyKeySegment(value, max = 512) {
  return normalizeFamilyText(value, max)
    .replace(/#/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shadeTokens(value) {
  return normalizeFamilyKeySegment(value, 256).split(/\s+/g).filter(Boolean);
}

function isRecognizedNumericShadeSegment(value) {
  const tokens = shadeTokens(value);
  if (!tokens.length) return false;
  if (!/^\d+(?:\.\d+)?[a-z]?$/.test(tokens[0])) return false;
  return tokens.slice(1).every((token) => SHADE_DESCRIPTOR_LEXICON.has(token));
}

function isRecognizedLexiconShadeSegment(value) {
  const tokens = shadeTokens(value);
  return Boolean(tokens.length) && tokens.every((token) => SHADE_LEXICON.has(token));
}

// ---------------------------------------------------------------------------------------------
// Variant-core helpers (formerly relationshipPairPolicy.isSameFamilyVariant's body).
// ---------------------------------------------------------------------------------------------
const FORM_OR_FORMULA = /\b(?:liquid|powder|cream|gel|balm|stick|mousse|cushion|pencil|pen|oil|mist|spray|solid|loose|pressed|hydrating|long[ -]?wear|radiant|radiance|intense|waterproof|washable|tubing|retinol|retinal|aha|bha|fragrance[ -]?free|oil[ -]?free)\b|\b\d+(?:\.\d+)?\s*%|\bspf\s*\d+/;
function variantCore(snapshot = {}) {
  const value = normalizedTitle(snapshot)
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|ml|oz|grams?|g|litres?|liters?)\b/g, ' ')
    .replace(/\s*#[^#]*$/, '').replace(/\s+/g, ' ').trim();
  const parts = value.split(/\s+-\s*|\s*[,|]\s*/);
  const role = optionRole(snapshot);
  const productPart = (part) => {
    const partRole = optionRole({title:part});
    // Decorative lash/nail option names can also be cosmetic shade nouns such
    // as 'Blush'. Only their actual product job makes such a segment substantive.
    if (['lashes','nails'].includes(role)) return partRole === role;
    return Boolean(partRole) || FORM_OR_FORMULA.test(part);
  };
  // A generic collection head is not a product identity. Retain substantive
  // tails rather than treating different products/formulas as collection options.
  // In lash/nail listings, descriptive option segments can surround the shared
  // product noun, so compare the head plus all product-bearing segments.
  const productParts = parts.slice(1).filter(productPart);
  if (!productPart(parts[0]) && !productParts.length && /[,|]/.test(value) &&
      !/^(?:shade|colou?r|style|scent|flavou?r)\s*:/i.test(scalar(snapshot.variant_title || snapshot.variant_detail_label))) return value;
  return [parts[0], ...productParts].join(' | ').replace(/\s+/g, ' ').trim();
}
function decorativeStructure(snapshot = {}) {
  const role = optionRole(snapshot);
  if (!['lashes','nails'].includes(role)) return {markers:[],unresolved:false};
  let remaining = normalizedTitle(snapshot);
  const markers = [];
  const consume = (pattern, marker) => {
    remaining = remaining.replace(pattern, (match) => {
      const values = typeof marker === 'function' ? marker(match) : [marker];
      markers.push(...values);
      return ' ';
    });
  };
  // Resolve negatives before positives, so 'non-magnetic' is not magnetic and
  // 'no glue required' cannot simultaneously require glue. Synonyms share modes.
  consume(/\b(?:non[ -]?magnetic|(?:not|no)[ -]?magnetic|without[ -]?magnets?)\b/g,'attachment:non_magnetic');
  consume(/\b(?:magnetic|magnets?)\b/g,'attachment:magnetic');
  consume(/\b(?:no[ -]?glue(?:[ -]?(?:is[ -]?)?(?:required|needed|necessary))?|(?:does[ -]?not|doesn['’]?t|not)[ -]?(?:require|need)[ -]?(?:(?:lash|nail)[ -]?)?glue|without[ -]?(?:(?:lash|nail)[ -]?)?glue|glue[ -]?(?:is[ -]?)?not[ -]?(?:required|needed|necessary)|glue[ -]?free|glueless|self[ -]?adhesive|pre[ -]?glued|pre[ -]?applied[ -]?adhesive|adhesive[ -]?tabs|stick[ -]?on)\b/g,'attachment:self_adhesive');
  consume(/\b(?:glue[ -]?(?:on|required|needed)|requires?[ -]?(?:(?:nail|lash)[ -]?)?glue|with[ -]?(?:(?:nail|lash)[ -]?)?glue)\b/g,'attachment:glue_required');
  consume(/\badhesive\b/g,'attachment:adhesive_unspecified');
  if (role === 'lashes') {
    consume(/\b(?:no|non|not|without)[ -]?(?:strip|individual|cluster)(?:[ -]?lashes?)?\b/g, (match) => [`construction:non_${match.match(/strip|individual|cluster/)[0]}`]);
    consume(/\b(?:(?:no|non|not|without)[ -]?(?:human[ -]?hair|mink|silk|synthetic(?:[ -]?fib(?:er|re)s?)?)|(?:human[ -]?hair|mink|silk|synthetic(?:[ -]?fib(?:er|re)s?)?)[ -]?free)\b/g, (match) => [`material:excluded_${match.match(/human[ -]?hair|mink|silk|synthetic/)[0].replace(/[ -]/g,'_')}`]);
    for (const [kind,pattern] of [
      ['strip',/\bstrip(?:[ -]?lashes?)?\b/g],
      ['individual',/\bindividual(?:[ -]?lashes?)?\b/g],
      ['cluster',/\b(?:cluster(?:[ -]?lashes?)?|lash[ -]?clusters?)\b/g],
      ['extension',/\bextensions?\b/g],
    ]) consume(pattern,`construction:${kind}`);
    consume(/\b(?:synthetic(?:[ -]?fib(?:er|re)s?)?|artificial(?:[ -]?fib(?:er|re)s?)?|faux[ -]?(?:mink|silk))\b/g,'material:synthetic');
    consume(/\bhuman[ -]?hair\b/g,'material:human_hair');
    consume(/\bmink\b/g,'material:mink');
    consume(/\bsilk\b/g,'material:silk');
  }
  if (role === 'nails') {
    consume(/\b(?:no[ -]?(?:(?:uv|led)[ -]?)?(?:lamp|light|cur(?:e|ing))(?:[ -]?(?:is[ -]?)?(?:required|needed|necessary))?|(?:does[ -]?not|doesn['’]?t|not)[ -]?(?:need|require)[ -]?(?:(?:uv|led)[ -]?)?(?:lamp|light|cur(?:e|ing))|(?:lamp|light)[ -]?free|air[ -]?dry(?:ing)?)\b/g,'curing:no_light');
    consume(/\b(?:(?:(?:uv|led)[ -]?)?cur(?:e|ing)[ -]?(?:required|needed)|(?:uv|led)[ -]?(?:lamp|light)(?:[ -]?(?:required|needed))?|(?:requires?|needs?)[ -]?(?:(?:uv|led)[ -]?)?(?:lamp|light|cur(?:e|ing)))\b/g, (match) => {
      const light = match.match(/uv|led/)?.[0];
      return light ? ['curing:light_required',`curing_light:${light}`] : ['curing:required_unspecified'];
    });
  }
  // Unknown functional declarations must not vanish into the ornamental tail.
  // Fail variant identity closed until that constraint can be classified.
  const unresolved = /\b(?:attachment|application|adhesion|adhesive|glue|magnetic|fib(?:er|re)s?|material|hair|synthetic|mink|silk|strip|individual|cluster|curing|cure|lamp|uv|led|requires?|required|needed|technology|system)\b/.test(remaining);
  return {markers:[...new Set(markers)].sort(),unresolved};
}
function formulaMarkers(snapshot = {}) {
  const value = normalizedTitle(snapshot);
  const markers = value.match(/\b\d+(?:\.\d+)?\s*%|\bspf\s*\d+|\b(?:intense|waterproof|washable|tubing|retinol|retinal|aha|bha|fragrance[ -]?free|oil[ -]?free)\b/g) || [];
  // Attachment is a shopper constraint, independently of decorative style names.
  markers.push(...decorativeStructure(snapshot).markers);
  // Finish is meaningful for complexion/lip products. A lash collection's named
  // 'Glow Up' style remains an option, not a different cosmetic formulation.
  if (['powder', 'setting_powder', 'foundation', 'blush', 'bronzer', 'contour', 'lipstick', 'lip_gloss'].includes(optionRole(snapshot))) {
    markers.push(...(value.match(/\b(?:matte|glow|dewy|satin|shimmer|luminous)\b/g) || []));
  }
  return markers.sort().join('|');
}
// "Intense Black" names a shade; only a free-standing "intense" names a formula.
const INTENSE_SHADE = new RegExp(`\\bintense(?=\\s+(?:${[...SHADE_LEXICON].join('|')})\\b)`, 'gi');
function formulaMarkerSet(snapshot = {}) {
  const title = snapshotTitle(snapshot).replace(INTENSE_SHADE, ' ');
  return [...new Set(formulaMarkers({ ...snapshot, title, name: title }).split('|').map((marker) => marker.replace(/\s+/g, '')).filter(Boolean))].sort().join('|');
}
function hasExplicitVariant(snapshot = {}) {
  if (/#/.test(normalizedTitle(snapshot))) return true;
  const role = optionRole(snapshot);
  // In these product roles a named shade, lash/nail style or lip-mask flavour is
  // an option. Other separator tails need structured option evidence.
  if (['lashes', 'nails', 'lip_mask', ...COSMETIC_ROLES.map(([name]) => name)].includes(role)) return /\s+-\s*|[,|]/.test(normalizedTitle(snapshot));
  return /^(?:shade|colou?r|style|scent|flavou?r)\s*:/i.test(scalar(snapshot.variant_title || snapshot.variant_detail_label));
}

// ---------------------------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------------------------
function brandNameText(snapshot = {}) {
  for (const raw of [snapshot.brand, snapshot.brand_name, snapshot.brandName, snapshot.vendor, snapshot.vendor_name, snapshot.vendorName]) {
    const value = isPlainObject(raw) ? scalar(raw.name) : scalar(raw);
    if (value) return value;
  }
  return '';
}

function normalizeBrandKey(value) {
  const key = normalizeString(value, 200)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
  const stripped = key.replace(/(?:beauty|cosmetics|skincare|official)$/, '');
  return stripped || key;
}

// Names are compared with names and ids with ids. A brand_id on one side and a brand name on the
// other cannot be compared, so the brand is unresolved rather than silently "different" or skipped.
function compareBrands(a = {}, b = {}) {
  const aName = normalizeBrandKey(brandNameText(a));
  const bName = normalizeBrandKey(brandNameText(b));
  if (aName && bName) return aName === bName ? 'same' : 'different';
  const aId = normalizeBrandKey(scalar(a.brand_id ?? a.brandId));
  const bId = normalizeBrandKey(scalar(b.brand_id ?? b.brandId));
  if (aId && bId && !aName && !bName) return aId === bId ? 'same' : 'different';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Structured keys
// ---------------------------------------------------------------------------------------------
const LISTING_ID_FIELDS = [
  'product_ref', 'productRef', 'product_id', 'productId', 'external_product_id', 'externalProductId',
  'source_product_id', 'sourceProductId', 'pivota_signature_id', 'pivotaSignatureId', 'sig_id', 'sigId',
  'sku_id', 'skuId', 'product_key', 'productKey', 'id',
];
const CONTENT_KEY_FIELDS = ['content_key', 'contentKey'];
const CANONICAL_ENTITY_FIELDS = [
  'canonical_entity_id', 'canonicalEntityId', 'canonical_product_id', 'canonicalProductId',
  'product_group_id', 'productGroupId', 'catalog_entity_id', 'catalogEntityId',
];
const GTIN_FIELDS = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'upc', 'ean', 'barcode'];
const URL_FIELDS = ['canonical_url', 'canonicalUrl', 'url', 'destination_url', 'destinationUrl', 'pdp_url', 'pdpUrl'];

function identityToken(value, minLength) {
  const raw = scalar(value);
  if (!raw) return '';
  const text = raw.replace(/^[a-z][a-z0-9_+-]*:/i, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length >= minLength ? text : '';
}

function fieldTokens(snapshot, fields, minLength) {
  const out = new Set();
  for (const field of fields) {
    const token = identityToken(snapshot[field], minLength);
    if (token) out.add(token);
  }
  return out;
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function parseUrl(value) {
  const raw = scalar(value);
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return {
      raw: raw.toLowerCase(),
      key: `${url.hostname.toLowerCase().replace(/^www\./, '')}${path}`,
      variant: normalizeString(url.searchParams.get('variant') || url.searchParams.get('variant_id') || url.searchParams.get('sku'), 120),
    };
  } catch {
    return null;
  }
}

function firstUrl(snapshot) {
  for (const field of URL_FIELDS) {
    const parsed = parseUrl(snapshot[field]);
    if (parsed && parsed.key.includes('/')) return parsed;
  }
  return null;
}

// Three strengths of structured evidence:
//   listing  - equal ref, listing id / pivota signature, or the identical URL: one listing, whatever
//              the brand is spelled ("Fenty Beauty" / "FENTY BEAUTY by Rihanna").
//   keyed    - canonical entity / product group, or the same PDP path once the query is dropped: the
//              same product only when the brands do not disagree.
//   support  - content_key and GTIN. In prod both are shared by different products (one content_key
//              spans 11 O HUI products; two different sets share a GTIN), so they may confirm a title
//              rule but never create a match.
function compareStructured(a, b, { anchorRef = '', candidateRef = '' } = {}) {
  const out = { listing: null, keyed: null, support: [] };
  const aRef = scalar(anchorRef).toLowerCase();
  const bRef = scalar(candidateRef).toLowerCase();
  const aIds = fieldTokens(a, LISTING_ID_FIELDS, 6);
  const bIds = fieldTokens(b, LISTING_ID_FIELDS, 6);
  // Refs join the listing-id pool unprefixed: 'product:ext_1' and 'external:ext_1' are one listing.
  const aRefToken = identityToken(anchorRef, 4);
  const bRefToken = identityToken(candidateRef, 4);
  if (aRefToken) aIds.add(aRefToken);
  if (bRefToken) bIds.add(bRefToken);
  const aUrl = firstUrl(a);
  const bUrl = firstUrl(b);
  if (aRef && bRef && aRef === bRef) out.listing = { relation: RELATIONS.SAME_PRODUCT, reasons: ['equal_product_ref'] };
  else if (intersects(aIds, bIds)) out.listing = { relation: RELATIONS.SAME_PRODUCT, reasons: ['equal_listing_id'] };
  else if (aUrl && bUrl && aUrl.raw === bUrl.raw) out.listing = { relation: RELATIONS.SAME_PRODUCT, reasons: ['identical_url'] };
  if (intersects(fieldTokens(a, CANONICAL_ENTITY_FIELDS, 4), fieldTokens(b, CANONICAL_ENTITY_FIELDS, 4))) {
    out.keyed = { relation: RELATIONS.SAME_PRODUCT, reasons: ['equal_canonical_entity'] };
  } else if (aUrl && bUrl && aUrl.key === bUrl.key) {
    // One PDP path, two selected options (?variant=): two options of one product.
    out.keyed = aUrl.variant && bUrl.variant && aUrl.variant !== bUrl.variant
      ? { relation: RELATIONS.SAME_FAMILY_VARIANT, reasons: ['equal_canonical_url_different_variant'] }
      : { relation: RELATIONS.SAME_PRODUCT, reasons: ['equal_canonical_url'] };
  }
  if (intersects(fieldTokens(a, CONTENT_KEY_FIELDS, 6), fieldTokens(b, CONTENT_KEY_FIELDS, 6))) out.support.push('content_key_agrees');
  const gtins = (snapshot) => new Set(GTIN_FIELDS.map((field) => scalar(snapshot[field]).replace(/\D+/g, '').replace(/^0+/, ''))
    .filter((value) => value.length >= 7));
  if (intersects(gtins(a), gtins(b))) out.support.push('gtin_agrees');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Title rules
// ---------------------------------------------------------------------------------------------
const SEPARATORS = new Set(['-', ',', '|']);
const LISTING_TAG = /[[(]\s*(?:deal|hot deal|sale|subscription|new|best seller|bestseller|online exclusive|imperfect box)\s*[\])]/g;
const SIZE_UNIT = '(?:fl\\.?\\s*oz|ml|oz|grams?|g|kg|l|litres?|liters?|ea|pcs|pieces|count|ct|sheets|pads|masks|wipes|patches|capsules|pairs?)';
const SIZE_PATTERN = new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s*${SIZE_UNIT}\\b(?:\\s*[x×]\\s*\\d+(?:[.,]\\d+)?\\s*${SIZE_UNIT}?\\b)?`, 'g');
const SIZE_WORDS = /\b(?:mini|travel[ -]sized?|full[ -]sized?|larger?[ -]size|jumbo|value[ -](?:size|pack)|deluxe[ -]size|refill)\b/g;
const PACK_WORDS = /\b(?:case|pack) of \d+\b|\b\d+\s*box(?:es)?\s*=?|\b\d+[ -]?(?:pack|pk)\b/g;
const RETAILER_TAILS = new Set([
  'sephora', 'ulta', 'ulta beauty', 'amazon', 'target', 'walmart', 'nordstrom', 'boots', 'cult beauty',
  'yesstyle', 'olive young', 'stylevana', 'tiktok exclusive',
]);
const AUDIENCE_WORDS = new Set(['men', 'man', 'women', 'woman', 'kids', 'kid', 'children', 'child', 'baby', 'babies', 'teen', 'teens', 'him', 'her', 'boys', 'girls', 'toddler', 'toddlers']);
const SET_WORDS = new Set(['set', 'sets', 'kit', 'kits', 'starter', 'bundle', 'duo', 'trio', 'gift', 'collection', 'routine', 'regimen']);
// Base words of a shade-bearing product when the option-role vocabulary does not name it ("Boy Brow",
// "Glow Cushion Compact", "Daily Tinted Fluid Sunscreen").
const COLOUR_NOUN = /\b(?:brow|brows|lip|lips|lash|lashes|eye|eyes|cheek|cheeks|blush|nail|nails|tint|tinted|gloss|liner|shadow|cushion|concealer|foundation|powder|bronzer|highlighter|contour|palette|stain|colou?r)\b/;
const OPTION_LABELS = new Set(['style', 'shade', 'color', 'colour', 'scent', 'flavor', 'flavour', 'tone']);
const COLOUR_ROLES = new Set(COSMETIC_ROLES.map(([name]) => name).filter((name) => name !== 'perfume'));
const OPTION_ROLES = new Set([...COLOUR_ROLES, 'lashes', 'nails', 'lip_mask']);

function wordsOf(value) {
  return normalizeString(value, 200).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function startsWithTokens(tokens, prefix) {
  return prefix.length > 0 && prefix.length <= tokens.length && prefix.every((token, index) => tokens[index] === token);
}

function trimSeparators(tokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && SEPARATORS.has(tokens[start])) start += 1;
  while (end > start && SEPARATORS.has(tokens[end - 1])) end -= 1;
  return tokens.slice(start, end).filter((token, index, list) => !(SEPARATORS.has(token) && SEPARATORS.has(list[index - 1])));
}

// Listing tokens keep ',', '-' (spaced dash) and '|' as separator tokens; everything a listing adds
// around one product (merchant/brand prefix, deal tags, retailer tail, size, count, mini/refill) is
// removed. Product-name words, strengths, SPF and finish words are never removed.
function listingTitleTokens(snapshot = {}, brandTexts = []) {
  let text = normalizeString(snapshotTitle(snapshot), 600).normalize('NFKC').toLowerCase()
    .replace(/[™®©]/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(LISTING_TAG, ' ')
    .replace(SIZE_PATTERN, ' ')
    .replace(PACK_WORDS, ' ')
    .replace(SIZE_WORDS, ' ')
    .replace(/&/g, ' and ')
    .replace(/#\s*/g, ' # ')
    .replace(/\b(?:no|n[°º])\.?\s*(?=\d)/g, ' no ')
    .replace(/\s+-+\s*|\s*-+\s+/g, ' \u0001 ')
    .replace(/-/g, ' ')
    .replace(/'/g, '')
    .replace(/\.(?!\d)|(?<!\d)\./g, ' ')
    .replace(/[^a-z0-9%+#.,|\u0001 ]+/g, ' ')
    .replace(/([,|\u0001])/g, ' $1 ');
  let tokens = trimSeparators(text.split(/\s+/).filter(Boolean).map((token) => (token === '\u0001' ? '-' : token)));
  // A short merchant / store code before a pipe ("WH | Gentle Care Shampoo").
  if (tokens.length > 2 && tokens[1] === '|' && tokens[0].length <= 3 && !/\d/.test(tokens[0])) tokens = tokens.slice(2);
  const brands = brandTexts.map(wordsOf).filter((words) => words.length).sort((x, y) => y.length - x.length);
  for (const brand of brands) {
    if (startsWithTokens(tokens, brand)) { tokens = trimSeparators(tokens.slice(brand.length)); break; }
  }
  while (tokens.length > 1 && ['the', 'new'].includes(tokens[0])) tokens = tokens.slice(1);
  // Trailing "| <retailer or brand>".
  const lastPipe = tokens.lastIndexOf('|');
  if (lastPipe > 0) {
    const tail = tokens.slice(lastPipe + 1).join(' ');
    if (RETAILER_TAILS.has(tail) || brands.some((brand) => brand.join(' ') === tail)) tokens = tokens.slice(0, lastPipe);
  }
  return trimSeparators(tokens);
}

function wordKey(tokens) {
  return tokens.filter((token) => !SEPARATORS.has(token)).join(' ');
}

function structuredVariantLabel(snapshot = {}) {
  return normalizeFamilyKeySegment(scalar(snapshot.variant_title || snapshot.variantTitle || snapshot.variant_detail_label ||
    snapshot.variantDetailLabel || snapshot.sku_title || snapshot.skuTitle), 256);
}

// Same product, possibly another listing or size: equal listing words, or one listing that is the
// other plus a description tail after ',', a spaced dash or 'for <audience/use>'. Two DIFFERENT tails
// are never stripped, and "For Ever" is a product name, not a 'for' tail.
function sameProductTitleRule(aTokens, bTokens) {
  const aKey = wordKey(aTokens);
  const bKey = wordKey(bTokens);
  if (!aKey || !bKey) return '';
  if (aKey === bKey) return 'listing_title_equal';
  const [shorter, longer] = aTokens.length < bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (!startsWithTokens(longer, shorter) || !wordKey(shorter)) return '';
  const rest = longer.slice(shorter.length);
  // A tail naming another audience ("for Men", "for Kids") or a set ("- Starter Set", "- Kit") is
  // another product, not a description of this one.
  if (rest.some((token) => SET_WORDS.has(token)) || (rest.includes('for') && rest.some((token) => AUDIENCE_WORDS.has(token)))) return '';
  if ([',', '-'].includes(rest[0]) && rest.slice(1).some((token) => !SEPARATORS.has(token))) return 'listing_description_tail';
  if (rest[0] === 'for' && rest[1] && !SEPARATORS.has(rest[1]) && rest[1] !== 'ever') return 'listing_description_tail';
  return '';
}

function optionValueKind(slot, { label, separated, role, terminal, numericTail, shadeBearing }) {
  if (!slot.length || slot.length > 4) return '';
  if (label === '#' || (label === 'no' && shadeBearing)) return 'marker';
  if (OPTION_LABELS.has(label)) return 'labelled';
  if (OPTION_LABELS.has(slot[0]) && slot.length >= 2) return 'labelled';
  if (slot[0] === '#' && slot.length >= 2) return 'marker';
  if (slot.length === 1 && /^[a-z]{1,3}\d{2,3}[a-z]?$/.test(slot[0]) && shadeBearing) return 'code';
  if (/^\d{1,3}[a-z]?$/.test(slot[0]) && numericTail.length > 1 && numericTail.slice(1).every((word) => NUMERIC_SHADE_WORDS.has(word))) {
    return 'numeric_shade';
  }
  if (slot.length === 1 && /^\d{1,3}$/.test(slot[0]) && terminal && COLOUR_ROLES.has(role)) return 'numeric_shade';
  if (slot.length === 1 && /^\d+(?:\.\d+)?mm$/.test(slot[0])) return 'length';
  if (label === 'in' && COLOUR_ROLES.has(role) && slot.length <= 3) return 'named_shade';
  if (slot.every((word) => SHADE_LEXICON.has(word)) && shadeBearing) return 'lexicon_shade';
  // A named shade after a spaced dash in a shade-bearing job ("Highlighter - Trophy Wife"), as long as
  // the name carries no product job or formula of its own.
  const slotText = slot.join(' ');
  if (separated && OPTION_ROLES.has(role) && slot.length <= 3 && !optionRole({ title: slotText }) && !FORM_OR_FORMULA.test(slotText)) {
    return 'named_option';
  }
  return '';
}

// Two listings that differ only in one terminal option slot: "#23 Natural Beige" / "#27 Honey Beige",
// "- Style A" / "- Style B", "in Hope" / "in Joy", "Berry" / "Vanilla" (lip mask), "18mm" / "16mm",
// "MN230" / "DP320". The shared base must name the product (two or more words); a slot inside the
// name ("Snail 96 Mucin" / "Snail 92 Mucin") is never an option.
function optionSlotRule(aTokens, bTokens, role) {
  const min = Math.min(aTokens.length, bTokens.length);
  let p = 0;
  while (p < min && aTokens[p] === bTokens[p]) p += 1;
  let s = 0;
  while (s < min - p && aTokens[aTokens.length - 1 - s] === bTokens[bTokens.length - 1 - s]) s += 1;
  const slotA = aTokens.slice(p, aTokens.length - s);
  const slotB = bTokens.slice(p, bTokens.length - s);
  if (!slotA.length && !slotB.length) return '';
  if (slotA.some((token) => SEPARATORS.has(token)) || slotB.some((token) => SEPARATORS.has(token))) return '';
  const suffix = aTokens.slice(aTokens.length - s);
  const base = aTokens.slice(0, p);
  let label = '';
  if (base.length && (OPTION_LABELS.has(base[base.length - 1]) || ['#', 'no', 'in'].includes(base[base.length - 1]))) label = base.pop();
  const separated = SEPARATORS.has(base[base.length - 1]);
  if (wordKey(base).split(' ').filter(Boolean).length < 2) return '';
  const suffixShadeWords = suffix.length > 0 && suffix.every((word) => NUMERIC_SHADE_WORDS.has(word));
  const terminal = suffix.length === 0 || SEPARATORS.has(suffix[0]) || suffixShadeWords;
  if (!terminal) return '';
  const shadeBearing = OPTION_ROLES.has(role) || (!role && COLOUR_NOUN.test(wordKey(base)));
  const kind = (slot) => optionValueKind(slot, {
    label, separated, role, shadeBearing, terminal: suffix.length === 0,
    numericTail: suffixShadeWords ? slot.concat(suffix) : slot,
  });
  // The base listing against one of its options ("Tinted Sunscreen" / "Tinted Sunscreen MN230").
  if (!slotA.length || !slotB.length) {
    const present = kind(slotA.length ? slotA : slotB);
    return present && suffix.length === 0 ? `option_value_vs_base:${present}` : '';
  }
  const aKind = kind(slotA);
  const bKind = kind(slotB);
  return aKind && bKind ? `option_slot:${aKind}` : '';
}

// The pre-2026-10-08 pair-policy rule, kept verbatim as one rule: a shared variant core plus an
// explicit option marker, for the same known product job.
function explicitVariantCoreRule(a, b, aRole, bRole) {
  if (!aRole || !bRole || aRole !== bRole) return '';
  const aCore = variantCore(a);
  const bCore = variantCore(b);
  return aCore && aCore === bCore && aCore.split(/\s+/).length >= 2 && (hasExplicitVariant(a) || hasExplicitVariant(b))
    ? 'explicit_variant_core' : '';
}

function result(relation, basis, reasons) {
  return { relation, basis, reasons };
}

function compareProductIdentity(a = {}, b = {}, options = {}) {
  const left = isPlainObject(a) ? a : {};
  const right = isPlainObject(b) ? b : {};
  const brand = compareBrands(left, right);
  const structured = compareStructured(left, right, options);
  if (structured.listing) return result(structured.listing.relation, 'structured', structured.listing.reasons);
  // A product key shared by two different brands is a data defect, not identity evidence.
  if (structured.keyed && brand !== 'different') return result(structured.keyed.relation, 'structured', structured.keyed.reasons);
  if (brand === 'unknown') return result(RELATIONS.UNKNOWN, 'title', ['brand_unresolved']);
  if (brand === 'different') return result(RELATIONS.DISTINCT, 'title', structured.keyed ? ['different_brand', 'structured_key_brand_conflict'] : ['different_brand']);
  const titled = compareTitles(left, right);
  // content_key / GTIN only confirm what the title rules already decided.
  if (structured.support.length && [RELATIONS.SAME_PRODUCT, RELATIONS.SAME_FAMILY_VARIANT].includes(titled.relation)) {
    return { ...titled, reasons: [...titled.reasons, ...structured.support] };
  }
  return titled;
}

function compareTitles(left, right) {
  if (!snapshotTitle(left) || !snapshotTitle(right)) return result(RELATIONS.UNKNOWN, 'title', ['title_missing']);

  const brandTexts = [brandNameText(left), brandNameText(right)].filter(Boolean);
  const aTokens = listingTitleTokens(left, brandTexts);
  const bTokens = listingTitleTokens(right, brandTexts);
  if (!wordKey(aTokens) || !wordKey(bTokens)) return result(RELATIONS.UNKNOWN, 'title', ['title_empty_after_normalization']);
  const aRole = optionRole(left);
  const bRole = optionRole(right);

  // A formula difference (SPF, %, waterproof, intense, fragrance-free) vetoes every same / variant rule.
  if (formulaMarkerSet(left) !== formulaMarkerSet(right)) return result(RELATIONS.DISTINCT, 'title', ['formula_marker_differs']);
  const sameRule = sameProductTitleRule(aTokens, bTokens);
  if (sameRule) {
    const aVariant = structuredVariantLabel(left);
    const bVariant = structuredVariantLabel(right);
    if (aVariant && bVariant && aVariant !== bVariant) return result(RELATIONS.SAME_FAMILY_VARIANT, 'title', [sameRule, 'structured_variant_differs']);
    // In shade/style-bearing jobs a separator tail names the option ("- Magnetic, Rose").
    if (sameRule === 'listing_description_tail' && aRole && aRole === bRole && OPTION_ROLES.has(aRole) &&
        !decorativeStructure(left).unresolved && !decorativeStructure(right).unresolved) {
      return result(RELATIONS.SAME_FAMILY_VARIANT, 'title', ['option_tail']);
    }
    return result(RELATIONS.SAME_PRODUCT, 'title', [sameRule]);
  }

  if (decorativeStructure(left).unresolved || decorativeStructure(right).unresolved) {
    return result(RELATIONS.DISTINCT, 'title', ['decorative_constraint_unresolved']);
  }
  if (aRole && bRole && aRole !== bRole) return result(RELATIONS.DISTINCT, 'title', ['different_product_role']);
  const coreRule = explicitVariantCoreRule(left, right, aRole, bRole);
  if (coreRule) return result(RELATIONS.SAME_FAMILY_VARIANT, 'title', [coreRule]);
  const slotRule = optionSlotRule(aTokens, bTokens, aRole && aRole === bRole ? aRole : '');
  if (slotRule) return result(RELATIONS.SAME_FAMILY_VARIANT, 'title', [slotRule]);
  return result(RELATIONS.DISTINCT, 'title', ['no_identity_rule_matched']);
}

function isSameProductOrVariant(a, b, options) {
  const { relation } = compareProductIdentity(a, b, options);
  return relation === RELATIONS.SAME_PRODUCT || relation === RELATIONS.SAME_FAMILY_VARIANT;
}

module.exports = {
  RELATIONS,
  compareProductIdentity,
  isSameProductOrVariant,
  compareBrands,
  SHADE_LEXICON,
  SHADE_DESCRIPTOR_LEXICON,
  normalizeFamilyText,
  normalizeFamilyKeySegment,
  isRecognizedNumericShadeSegment,
  isRecognizedLexiconShadeSegment,
  variantCore,
  decorativeStructure,
  formulaMarkers,
  __internal: {
    listingTitleTokens,
    sameProductTitleRule,
    optionSlotRule,
    explicitVariantCoreRule,
    compareStructured,
    normalizeBrandKey,
    formulaMarkerSet,
    hasExplicitVariant,
  },
};
