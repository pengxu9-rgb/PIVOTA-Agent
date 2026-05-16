const ACCESSORY_RE =
  /\b(accessor(?:y|ies)|brush|sponge|puff|applicator|sharpener|tweezer|curler|scissors|comb|mirror|case|bag|pouch|holder|spatula|tool|tools|gua sha|roller|headband|scrunchie|scarf|hat|cap|tote|clip|clips|lash curler|refill case|soap dish|soap saver|washcloth|cloth|gift wrap|wrapping cloth|blotting paper|keyring|key ring|keychain|key chain|charm)\b/i;
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
  /\b(skincare|skin care|makeup|cosmetic|haircare|hair care|fragrance|perfume|parfum|cologne|cleanser|cleansing|toner|essence|serum|ampoule|solution|suspension|emulsion|moisturi[sz]er|cream|lotion|balm|mask|patch(?:es)?|peel|exfoliant|exfoliator|treatment|oil|acid|acne control|sunscreen|spf|foundation|concealer|mascara|lash|lip(?:stick| gloss| balm| oil)?|gloss stick|match stix|skinstick|contour|packette|blush|bronzer|powder|highlighter|eyeshadow|eyeliner|brow|primer|setting spray|shampoo|conditioner|body wash|body lotion)\b/i;
const SET_PHRASE_FORMULA_RE = /\bset\s+it\s+down\b/i;
const FORMULA_REFILL_PACKAGING_RE = /\b(?:refill\s+pouch|refill\s+pack|refill\s+pod)\b/i;
const FORMULA_CATEGORY_PATH_RE =
  /^beauty\/(?:skincare|skin-care|makeup\/(?:face|lip|eye|cheek|complexion|base)|fragrance|hair|haircare|body)(?:\/|$)/i;
const TOOL_CATEGORY_PATH_RE = /^beauty\/(?:tools?|beauty-tools)(?:\/|$)/i;

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

function collectCategoryPathCandidates(input = {}) {
  const seedData = asPlainObject(input.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const values = [];
  for (const value of [
    input.catalog_category_path,
    input.category_path,
    input.categoryPath,
    seedData.catalog_category_path,
    seedData.category_path,
    seedData.categoryPath,
    snapshot.catalog_category_path,
    snapshot.category_path,
    snapshot.categoryPath,
  ]) {
    if (Array.isArray(value)) {
      const joined = value.map((part) => asString(part)).filter(Boolean).join('/');
      if (joined) values.push(joined);
      continue;
    }
    const text = asString(value);
    if (text) values.push(text);
  }
  return values;
}

function normalizeCategoryPath(value) {
  return asString(value)
    .toLowerCase()
    .replace(/\\+/g, '/')
    .replace(/[_\s-]+/g, '-')
    .replace(/-?\/-?/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function hasFormulaCategoryPath(input = {}) {
  return collectCategoryPathCandidates(input).some((value) =>
    FORMULA_CATEGORY_PATH_RE.test(normalizeCategoryPath(value)),
  );
}

function hasToolCategoryPath(input = {}) {
  return collectCategoryPathCandidates(input).some((value) =>
    TOOL_CATEGORY_PATH_RE.test(normalizeCategoryPath(value)),
  );
}

function classifyExternalSeedProductKind(input = {}) {
  const text = collectExternalSeedProductKindText(input);
  const reasons = [];

  if (NON_MERCH_RE.test(text)) {
    reasons.push('non_merch_signal');
    return { family: 'non_merch', reasons };
  }
  if (hasToolCategoryPath(input)) {
    reasons.push('tool_category_path_signal');
    return { family: 'accessory', reasons };
  }
  if (STICKER_ACCESSORY_RE.test(text) && !TREATMENT_STICKER_RE.test(text)) {
    reasons.push('sticker_accessory_signal');
    return { family: 'accessory', reasons };
  }
  if (FORMULA_REFILL_PACKAGING_RE.test(text) && FORMULA_PRODUCT_RE.test(text)) {
    reasons.push('formula_refill_packaging_signal');
    return { family: 'single_formula', reasons };
  }
  if (SET_PHRASE_FORMULA_RE.test(text) && FORMULA_PRODUCT_RE.test(text)) {
    reasons.push('set_phrase_formula_signal');
    return { family: 'single_formula', reasons };
  }
  if (STRONG_BUNDLE_RE.test(text)) {
    reasons.push('bundle_set_signal');
    return { family: 'set_or_collection', reasons };
  }
  if (COLLECTION_BUNDLE_RE.test(text) && !COLLECTION_MEMBER_RE.test(text)) {
    reasons.push('collection_bundle_signal');
    return { family: 'set_or_collection', reasons };
  }
  if (hasFormulaCategoryPath(input)) {
    reasons.push('formula_category_path_signal');
    return { family: 'single_formula', reasons };
  }
  if (ACCESSORY_RE.test(text)) {
    reasons.push('accessory_signal');
    return { family: 'accessory', reasons };
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
  FORMULA_REFILL_PACKAGING_RE,
  SET_PHRASE_FORMULA_RE,
  STICKER_ACCESSORY_RE,
  TREATMENT_STICKER_RE,
  classifyExternalSeedProductKind,
  collectExternalSeedProductKindText,
  isIngredientAuthorityEligibleExternalSeed,
  isSingleFormulaExternalSeed,
};
