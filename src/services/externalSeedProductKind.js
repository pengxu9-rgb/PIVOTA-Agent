const ACCESSORY_RE =
  /\b(accessor(?:y|ies)|brush|sponge|puff|applicator|sharpener|tweezer|curler|scissors|comb|mirror|case|bag|pouch|holder|tray|spatula|tool|tools|gua sha|roller|headband|scrunchie|scarf|hat|cap|tote|clip|clips|lash curler|refill case|soap dish|soap saver|washcloth|cloth|towel|gift wrap|wrapping cloth|blotting paper|keyring|key ring|keychain|key chain|charm|candles?|diffusers?|reed diffuser|home fragrance|(?:body\s+)?lotion\s+pump|replacement\s+pump)\b/i;
const STICKER_ACCESSORY_RE = /\b(stickers?|decals?)\b/i;
const TREATMENT_STICKER_RE = /\b(?:blemish|acne|pimple|spot|hydrocolloid|patch(?:es)?)\b/i;
const FALSE_LASH_ACCESSORY_RE = /\b(?:false|fake|faux|precut|individual)\s+lashes?\b|\black\s+segments?\b|\black\s+clusters?\b/i;
const PET_ACCESSORY_RE =
  /\b(?:dog|cat|pet|puppy|kitten|pooch)\b(?:\s+\w+){0,5}\s+\b(?:toy|toys|collar|leash|bowl|bandana|bed)\b|\b(?:toy|toys|collar|leash|bowl|bandana|bed)\b(?:\s+\w+){0,5}\s+\b(?:dog|cat|pet|puppy|kitten|pooch)\b/i;
const SAMPLE_LIKE_RE = /\b(?:deluxe\s+sample|samples?|sample\s+size|trial\s*kit|sachets?|sachetbook)\b/i;
const NON_MERCH_RE =
  /\b(?:e[-\s]?gift[-\s]?cards?|gift[-\s]?cards?|mystery\s+gifts?|donat(?:e|ion)|sample service|appointment|booking|shipping protection|package protection|route protection|order protection|free[-_\s]?gift|bogos(?:\.io)?|bogo bundle|sca[-_\s]?clone[-_\s]?freegift)\b/i;
const APPAREL_NON_MERCH_RE =
  /\b(?:apparel|clothing|hoodies?|sweatshirts?|sweaters?|t[-\s]?shirts?|tees?|shirts?|tank tops?|jackets?|coats?|pants?|shorts?|socks?|robes?|beanies?)\b/i;

const STRONG_BUNDLE_RE =
  /\b(?:bundles?|kits?|duos?|trios?|quartets?|routine|regimen|makeup\s+look|starter\s+set|travel\s+set|mini\s+set|value\s+set|gift\s+set|discovery\s+set|essentials?\s+set|sets?|advent\s+calendars?|holiday\s+calendars?|beauty\s+calendars?|(?:12|twelve)\s+days\s+of|(?:mask|ampoule|sheet)\s+packs)\b/i;
const COLLECTION_BUNDLE_RE =
  /\b(?:collection\s+(?:set|kit|bundle)|(?:complete|holiday|starter|travel|mini|gift|routine|regimen|essentials?|most[-\s]?loved)\s+collection|the\s+[^\n]{2,80}\s+collection)\b/i;
const COLLECTION_MEMBER_RE = /\bcollection\s*:\s*[^\n]+/i;
const FORMULA_PRODUCT_RE =
  /\b(skincare|skin care|makeup|cosmetic|haircare|hair care|fragrance|perfume|parfum|cologne|cleanser|cleansing|toner|essence|serum|ampoule|solution|suspension|emulsion|moisturi[sz]er|cream|lotion|balm|mask|patch(?:es)?|peel|exfoliant|exfoliator|treatment|oil|acid|acne control|sunscreen|spf|foundation|concealer|mascara|lash|lip(?:stick| gloss| balm| oil)?|gloss stick|match stix|skinstick|contour|packette|blush|bronzer|powder|highlighter|eyeshadow|eyeliner|brow|primer|setting spray|shampoo|conditioner|body wash|body lotion)\b/i;
const FORMULA_VARIANT_TITLE_RE =
  /\b(?:foundation|concealer|mascara|lipstick|lip\s+gloss|lip\s+balm|lip\s+oil|blush|bronzer|powder|highlighter|eyeshadow|eyeliner|brow|primer|setting\s+spray)\b[\s\S]{0,120}(?:[—–-]\s*#?[a-z0-9][\w.-]*|#\s*[a-z0-9][\w.-]*)\b/i;
const FORMULA_COMPONENT_PAIR_RE =
  /\b(?:matte\s+lip\s+kit|lip\s+kit|matte\s+liquid\s+lipstick|lipstick|lip\s+liner|precision\s+pout\s+lip\s+liner|lip\s+gloss|gloss\s+drip|high\s+gloss|lip\s+glaze|lip\s+tint|butter\s+balm|lip\s+oil)\b[\s\S]{0,90}(?:&|\+|\band\b)[\s\S]{0,90}\b(?:matte\s+lip\s+kit|lip\s+kit|matte\s+liquid\s+lipstick|lipstick|lip\s+liner|precision\s+pout\s+lip\s+liner|lip\s+gloss|gloss\s+drip|high\s+gloss|lip\s+glaze|lip\s+tint|butter\s+balm|lip\s+oil)\b/i;
const SET_PHRASE_FORMULA_RE = /\bset\s+it\s+down\b/i;
const FORMULA_REFILL_PACKAGING_RE = /\b(?:refill\s+pouch|refill\s+pack|refill\s+pod)\b/i;
const FORMULA_CATEGORY_PATH_RE =
  /^beauty\/(?:skincare|skin-care|makeup\/(?:face|lip|eye|cheek|complexion|base)|fragrance|hair|haircare|body)(?:\/|$)/i;
const FORMULA_CATEGORY_TEXT_RE =
  /\b(?:skincare|skin care|makeup|cosmetics?|haircare|hair care|fragrance|perfumes?|parfums?|colognes?|cleansers?|toners?|essences?|serums?|ampoules?|solutions?|suspensions?|emulsions?|moisturi[sz]ers?|creams?|lotions?|balms?|masks?|patches|peels?|exfoliants?|exfoliators?|treatments?|oils?|acids?|sunscreens?|spf|foundations?|concealers?|foundations?\s*&\s*concealers?|mascaras?|lashes?|lipsticks?|lip\s+gloss(?:es)?|lip\s+balms?|lip\s+oils?|blush(?:es)?|bronzers?|powders?|highlighters?|eyeshadows?|eyeliners?|brows?|primers?|setting\s+sprays?|shampoos?|conditioners?|body\s+washes?|body\s+lotions?)\b/i;
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
    input.product_kind,
    input.product_family,
    input.category,
    input.product_type,
    input.canonical_url,
    input.destination_url,
    input.url,
    seedData.title,
    seedData.name,
    seedData.product_kind,
    seedData.product_family,
    seedData.category,
    seedData.product_type,
    seedData.productType,
    seedData.source_page_type,
    snapshot.title,
    snapshot.name,
    snapshot.product_kind,
    snapshot.product_family,
    snapshot.category,
    snapshot.product_type,
    snapshot.productType,
    snapshot.source_page_type,
  ]
    .map(asString)
    .filter(Boolean)
    .join(' ');
}

function collectExternalSeedProductKindContentText(input = {}) {
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

function collectExternalSeedProductKindPrimaryContentText(input = {}) {
  const seedData = asPlainObject(input.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  return [
    input.title,
    input.name,
    input.display_name,
    input.canonical_url,
    input.destination_url,
    input.url,
    seedData.title,
    seedData.name,
    snapshot.title,
    snapshot.name,
  ]
    .map(asString)
    .filter(Boolean)
    .join(' ');
}

function collectCategoryTextCandidates(input = {}) {
  const seedData = asPlainObject(input.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  return [
    input.category,
    input.product_type,
    input.productType,
    input.catalog_category,
    input.catalogCategory,
    seedData.category,
    seedData.product_type,
    seedData.productType,
    seedData.catalog_category,
    seedData.catalogCategory,
    snapshot.category,
    snapshot.product_type,
    snapshot.productType,
    snapshot.catalog_category,
    snapshot.catalogCategory,
  ]
    .map(asString)
    .filter(Boolean);
}

function normalizeExplicitProductFamily(value) {
  const normalized = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  if (['non_merch', 'non_merchandise'].includes(normalized)) return 'non_merch';
  if (['bundle', 'set', 'set_or_collection', 'collection'].includes(normalized)) return 'set_or_collection';
  if (['accessory', 'tool', 'beauty_tool'].includes(normalized)) return 'accessory';
  if (['sample', 'sample_like'].includes(normalized)) return 'sample';
  if (['single_formula', 'formula'].includes(normalized)) return 'single_formula';
  return '';
}

function resolveExplicitProductFamily(input = {}) {
  const seedData = asPlainObject(input.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const candidates = [
    { value: input.product_family, reason: 'explicit_product_family_signal' },
    { value: seedData.product_family, reason: 'explicit_product_family_signal' },
    { value: snapshot.product_family, reason: 'explicit_product_family_signal' },
    { value: input.product_kind, reason: 'explicit_product_kind_signal' },
    { value: seedData.product_kind, reason: 'explicit_product_kind_signal' },
    { value: snapshot.product_kind, reason: 'explicit_product_kind_signal' },
  ];
  for (const candidate of candidates) {
    const family = normalizeExplicitProductFamily(candidate.value);
    if (family) return { family, reason: candidate.reason };
  }
  return null;
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

function hasFormulaCategoryText(input = {}) {
  return collectCategoryTextCandidates(input).some((value) => FORMULA_CATEGORY_TEXT_RE.test(value));
}

function hasToolCategoryPath(input = {}) {
  return collectCategoryPathCandidates(input).some((value) =>
    TOOL_CATEGORY_PATH_RE.test(normalizeCategoryPath(value)),
  );
}

function classifyExternalSeedProductKind(input = {}) {
  const text = collectExternalSeedProductKindText(input);
  const contentText = collectExternalSeedProductKindContentText(input);
  const primaryContentText = collectExternalSeedProductKindPrimaryContentText(input);
  const reasons = [];

  if (NON_MERCH_RE.test(text)) {
    reasons.push('non_merch_signal');
    return { family: 'non_merch', reasons };
  }
  if (APPAREL_NON_MERCH_RE.test(text)) {
    reasons.push('apparel_non_merch_signal');
    return { family: 'non_merch', reasons };
  }
  const explicitFamily = resolveExplicitProductFamily(input);
  const sampleLike = SAMPLE_LIKE_RE.test(text);
  if (sampleLike && (!explicitFamily || ['sample', 'single_formula'].includes(explicitFamily.family))) {
    reasons.push('sample_like_signal');
    return { family: 'sample', reasons };
  }
  const strongBundleSignal = STRONG_BUNDLE_RE.test(text);
  const collectionBundleSignal = COLLECTION_BUNDLE_RE.test(text) && !COLLECTION_MEMBER_RE.test(text);
  const strongBundleContentSignal = STRONG_BUNDLE_RE.test(contentText);
  const collectionBundleContentSignal =
    COLLECTION_BUNDLE_RE.test(contentText) && !COLLECTION_MEMBER_RE.test(contentText);
  const primaryBundleContentSignal =
    STRONG_BUNDLE_RE.test(primaryContentText) ||
    (COLLECTION_BUNDLE_RE.test(primaryContentText) && !COLLECTION_MEMBER_RE.test(primaryContentText));
  const formulaCategoryPathSignal = hasFormulaCategoryPath(input);
  const formulaCategoryTextSignal = hasFormulaCategoryText(input);
  const formulaVariantTitleSignal = FORMULA_VARIANT_TITLE_RE.test(primaryContentText);
  const formulaComponentPairSignal = FORMULA_COMPONENT_PAIR_RE.test(primaryContentText);
  if (
    explicitFamily?.family === 'single_formula' &&
    !SET_PHRASE_FORMULA_RE.test(text) &&
    (strongBundleSignal || collectionBundleSignal || formulaComponentPairSignal)
  ) {
    reasons.push(
      formulaComponentPairSignal
        ? 'formula_component_pair_overrides_single_formula_signal'
        : strongBundleSignal
        ? 'bundle_set_overrides_single_formula_signal'
        : 'collection_bundle_overrides_single_formula_signal',
    );
    return { family: 'set_or_collection', reasons };
  }
  if (formulaComponentPairSignal && !SET_PHRASE_FORMULA_RE.test(text)) {
    reasons.push('formula_component_pair_signal');
    return { family: 'set_or_collection', reasons };
  }
  if (
    explicitFamily?.family === 'set_or_collection' &&
    (formulaCategoryPathSignal || formulaCategoryTextSignal || formulaVariantTitleSignal) &&
    FORMULA_PRODUCT_RE.test(text) &&
    !formulaComponentPairSignal &&
    !primaryBundleContentSignal &&
    (!strongBundleContentSignal || FORMULA_PRODUCT_RE.test(primaryContentText)) &&
    (!collectionBundleContentSignal || FORMULA_PRODUCT_RE.test(primaryContentText))
  ) {
    reasons.push(
      formulaCategoryPathSignal
        ? 'stale_bundle_kind_overridden_by_formula_category'
        : formulaCategoryTextSignal
          ? 'stale_bundle_kind_overridden_by_formula_category_text'
          : 'stale_bundle_kind_overridden_by_formula_variant_title',
    );
    return { family: 'single_formula', reasons };
  }
  if (
    explicitFamily?.family === 'accessory' &&
    !hasToolCategoryPath(input) &&
    !PET_ACCESSORY_RE.test(text) &&
    !(STICKER_ACCESSORY_RE.test(text) && !TREATMENT_STICKER_RE.test(text)) &&
    !FALSE_LASH_ACCESSORY_RE.test(text) &&
    (formulaCategoryPathSignal || FORMULA_PRODUCT_RE.test(contentText)) &&
    !ACCESSORY_RE.test(primaryContentText)
  ) {
    reasons.push(
      formulaCategoryPathSignal
        ? 'stale_accessory_kind_overridden_by_formula_category'
        : 'stale_accessory_kind_overridden_by_formula_signal',
    );
    return { family: 'single_formula', reasons };
  }
  if (explicitFamily) {
    return { family: explicitFamily.family, reasons: [explicitFamily.reason] };
  }
  if (hasToolCategoryPath(input)) {
    reasons.push('tool_category_path_signal');
    return { family: 'accessory', reasons };
  }
  if (STICKER_ACCESSORY_RE.test(text) && !TREATMENT_STICKER_RE.test(text)) {
    reasons.push('sticker_accessory_signal');
    return { family: 'accessory', reasons };
  }
  if (FALSE_LASH_ACCESSORY_RE.test(text)) {
    reasons.push('false_lash_accessory_signal');
    return { family: 'accessory', reasons };
  }
  if (PET_ACCESSORY_RE.test(text)) {
    reasons.push('pet_accessory_signal');
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
  if (strongBundleSignal) {
    reasons.push('bundle_set_signal');
    return { family: 'set_or_collection', reasons };
  }
  if (collectionBundleSignal) {
    reasons.push('collection_bundle_signal');
    return { family: 'set_or_collection', reasons };
  }
  if (formulaCategoryPathSignal) {
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
  SAMPLE_LIKE_RE,
  STRONG_BUNDLE_RE,
  COLLECTION_BUNDLE_RE,
  COLLECTION_MEMBER_RE,
  FORMULA_PRODUCT_RE,
  FORMULA_CATEGORY_TEXT_RE,
  FORMULA_VARIANT_TITLE_RE,
  FORMULA_REFILL_PACKAGING_RE,
  FALSE_LASH_ACCESSORY_RE,
  PET_ACCESSORY_RE,
  SET_PHRASE_FORMULA_RE,
  STICKER_ACCESSORY_RE,
  TREATMENT_STICKER_RE,
  classifyExternalSeedProductKind,
  collectCategoryTextCandidates,
  collectExternalSeedProductKindText,
  isIngredientAuthorityEligibleExternalSeed,
  isSingleFormulaExternalSeed,
};
