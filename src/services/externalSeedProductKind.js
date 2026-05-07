const ACCESSORY_RE =
  /\b(brush|sponge|puff|applicator|sharpener|tweezer|curler|scissors|comb|mirror|case|bag|pouch|holder|spatula|tool|tools|gua sha|roller|headband|scrunchie|scarf|hat|cap|tote|clip|clips|lash curler|refill case|keyring|key ring|keychain|key chain|charm)\b/i;
const STICKER_ACCESSORY_RE = /\b(stickers?|decals?)\b/i;
const TREATMENT_STICKER_RE = /\b(?:blemish|acne|pimple|spot|hydrocolloid|patch(?:es)?)\b/i;
const NON_MERCH_RE =
  /\b(?:e[-\s]?gift[-\s]?cards?|gift[-\s]?cards?|donat(?:e|ion)|sample service|appointment|booking|shipping protection|package protection|route protection|order protection)\b/i;

const STRONG_BUNDLE_RE =
  /\b(?:bundles?|kits?|duos?|trios?|quartets?|routine|regimen|makeup\s+look|starter\s+set|travel\s+set|mini\s+set|value\s+set|gift\s+set|discovery\s+set|essentials?\s+set|sets?)\b/i;
const COLLECTION_BUNDLE_RE =
  /\b(?:collection\s+(?:set|kit|bundle)|(?:complete|holiday|starter|travel|mini|gift|routine|regimen|essentials?|most[-\s]?loved)\s+collection|the\s+[^\n]{2,80}\s+collection)\b/i;
const COLLECTION_MEMBER_RE = /\bcollection\s*:\s*[^\n]+/i;
const FORMULA_PRODUCT_RE =
  /\b(skincare|skin care|makeup|cosmetic|haircare|hair care|fragrance|perfume|parfum|cologne|cleanser|cleansing|toner|essence|serum|ampoule|solution|suspension|emulsion|moisturi[sz]er|cream|lotion|balm|mask|patch(?:es)?|peel|exfoliant|exfoliator|treatment|oil|acid|acne control|sunscreen|spf|foundation|concealer|mascara|lash|lip(?:stick| gloss| balm| oil)?|blush|bronzer|powder|highlighter|eyeshadow|eyeliner|brow|primer|setting spray|shampoo|conditioner|body wash|body lotion)\b/i;

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return String(value || '').trim();
}

function collectExternalSeedProductKindText(input = {}) {
  const seedData = asPlainObject(input.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  return [
    input.title,
    input.name,
    input.display_name,
    input.category,
    input.product_type,
    input.canonical_url,
    input.destination_url,
    input.url,
    seedData.title,
    seedData.name,
    seedData.category,
    seedData.product_type,
    seedData.productType,
    seedData.source_page_type,
    snapshot.title,
    snapshot.name,
    snapshot.category,
    snapshot.product_type,
    snapshot.productType,
    snapshot.source_page_type,
  ]
    .map(asString)
    .filter(Boolean)
    .join(' ');
}

function classifyExternalSeedProductKind(input = {}) {
  const text = collectExternalSeedProductKindText(input);
  const reasons = [];

  if (NON_MERCH_RE.test(text)) {
    reasons.push('non_merch_signal');
    return { family: 'non_merch', reasons };
  }
  if (STICKER_ACCESSORY_RE.test(text) && !TREATMENT_STICKER_RE.test(text)) {
    reasons.push('sticker_accessory_signal');
    return { family: 'accessory', reasons };
  }
  if (ACCESSORY_RE.test(text)) {
    reasons.push('accessory_signal');
    return { family: 'accessory', reasons };
  }
  if (STRONG_BUNDLE_RE.test(text)) {
    reasons.push('bundle_set_signal');
    return { family: 'set_or_collection', reasons };
  }
  if (COLLECTION_BUNDLE_RE.test(text) && !COLLECTION_MEMBER_RE.test(text)) {
    reasons.push('collection_bundle_signal');
    return { family: 'set_or_collection', reasons };
  }
  if (FORMULA_PRODUCT_RE.test(text)) {
    reasons.push('formula_signal');
    return { family: 'single_formula', reasons };
  }
  return { family: 'unknown_product', reasons };
}

function isSingleFormulaExternalSeed(input = {}) {
  return classifyExternalSeedProductKind(input).family === 'single_formula';
}

function isIngredientAuthorityEligibleExternalSeed(input = {}) {
  const family = classifyExternalSeedProductKind(input).family;
  return !['set_or_collection', 'non_merch', 'accessory'].includes(family);
}

module.exports = {
  ACCESSORY_RE,
  NON_MERCH_RE,
  STRONG_BUNDLE_RE,
  COLLECTION_BUNDLE_RE,
  COLLECTION_MEMBER_RE,
  FORMULA_PRODUCT_RE,
  STICKER_ACCESSORY_RE,
  TREATMENT_STICKER_RE,
  classifyExternalSeedProductKind,
  collectExternalSeedProductKindText,
  isIngredientAuthorityEligibleExternalSeed,
  isSingleFormulaExternalSeed,
};
