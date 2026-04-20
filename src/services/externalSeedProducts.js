const crypto = require('node:crypto');
const { lookupExternalSeedImageOverride } = require('./externalSeedImageOverrides');
const {
  resolveExternalSeedRecallDoc,
  normalizeNonEmptyString,
  resolveExternalSeedProtectionContract,
} = require('./externalSeedRecall');
const { isDisplayablePdpFaqItem } = require('./pdpFaqQuality');
const { normalizePdpImageUrl } = require('../utils/pdpImageUrls');

const SHOPIFY_ASSET_HASH_SUFFIX_RE =
  /^(.*?_[0-9a-z]+(?:[a-z])?)_(?:[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|[0-9a-f-]{16,})(\.[a-z0-9]+)$/i;
const {
  buildAuthoritativeIngredientView,
  mergeIngredientIntelWithAuthority,
} = require('./pdpIngredientAuthority');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const SUNSCREEN_CATEGORY_RE =
  /\b(sunscreen|sun\s*screen|broad\s+spectrum|spf\s*\d{2,3}\+?|pa\s*\+{2,4}|sun\s+(?:serum|fluid|cream|gel|milk|stick)|uv\s*(?:protection|shield|defen[cs]e|lock))\b/i;
const BEAUTY_CATEGORY_PATTERNS = [
  ['Brush', /\b(brush|makeup brush|foundation brush|powder brush|blush brush|shader brush|kabuki)\b/i],
  ['Shampoo', /\b(shampoo|dry shampoo|clarifying shampoo)\b/i],
  ['Conditioner', /\b(conditioner|deep conditioner|leave-in conditioner|leave in conditioner)\b/i],
  ['Hair Styling', /\b(edge control|styling gel|hair-thickening|hair thickening|detangling spray|hair clip|hair clips|edge styling)\b/i],
  ['Hair Care', /\b(hair care|hair repair|repair bundle|maintenance crew|detangling|leave-in|leave in|hair)\b/i],
  ['Sunscreen', SUNSCREEN_CATEGORY_RE],
  ['Fragrance', /\b(perfume|parfum|eau de parfum|eau de toilette|cologne|scent)\b|\bfragrance\b(?![-\s]?free)\b/i],
  ['Cleanser', /\b(cleanser|cleansing|face wash|facial wash|cleansing milk|cleansing foam|cleansing gel|wash)\b/i],
  ['Toner', /\b(toner|mist|pad)\b/i],
  [
    'Treatment',
    /\b(spot[-\s]?target(?:ing|ed)?|spot[-\s]?treatment|blemish|acne|clarifying treatment|targeting gel|treatment gel)\b/i,
  ],
  ['Serum', /\b(serum|essence|ampoule|concentrate)\b/i],
  ['Concealer', /\b(concealer)\b/i],
  ['Foundation', /\b(foundation|skin tint|foundation stick|cushion foundation)\b/i],
  ['Powder', /\b(powder|setting powder|pressed powder|loose powder|blurring powder|finishing powder)\b/i],
  ['Highlighter', /\b(highlighter|illuminator|luminizer|luminiser|killawatt)\b/i],
  ['Blush', /\b(blush|cheeks out|cheek tint|flush)\b/i],
  ['Bronzer', /\b(bronzer|contour)\b/i],
  ['Eyeshadow', /\b(eye\s?shadow|eyeshadow|eye color|eye colour)\b/i],
  ['Mascara', /\b(mascara)\b/i],
  ['Brow Pencil', /\b(brow pencil|eyebrow pencil|brow definer|brow sculptor|brow styler)\b/i],
  ['Lip Balm', /\b(lip balm|lip treatment)\b/i],
  ['Lipstick', /\b(lipstick|lip color|lip colour|liquid lip|lip luxe|lip lacquer|lip gloss)\b/i],
  ['Moisturizer', /\b(moisturizer|moisturiser|cream|lotion|gel cream|gel-cream|barrier cream)\b/i],
];
const BEAUTY_CATEGORY_DESCRIPTION_PATTERNS = BEAUTY_CATEGORY_PATTERNS.map(([label, pattern]) => {
  if (label === 'Powder') {
    return ['Powder', /\b(setting powder|pressed powder|loose powder|blurring powder|finishing powder)\b/i];
  }
  return [label, pattern];
});
const STRONG_ACTIVE_SOLUTION_INGREDIENT_IDS = new Set([
  'salicylic_acid',
  'niacinamide',
  'retinol',
  'azelaic_acid',
  'benzoyl_peroxide',
]);
const PRICE_MINOR_UNIT_HINT_RE =
  /\b(fragrance|perfume|parfum|cologne|sunscreen|sun\s*screen|spf|broad\s+spectrum|sun\s+(?:serum|fluid|cream|gel|milk|stick)|uv\s*(?:protection|shield|defen[cs]e|lock)|shampoo|conditioner|cleanser|toner|moisturizer|cream|serum|concealer|foundation|powder|mascara|lip|brow|hair|beauty|bundle|treatment|spot[-\s]?target(?:ing|ed)?|blemish|acne|salicylic|bha|aha|clarifying)\b/i;
const ZERO_DECIMAL_PRICE_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

function stableExternalProductId(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  const hash = crypto.createHash('sha256').update(u).digest('hex').slice(0, 24);
  return `ext_${hash}`;
}

function ensureJsonObject(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  if (typeof val !== 'string') return {};
  const trimmed = val.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSeedAvailability(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'in stock' || v === 'instock' || v === 'in_stock' || v === 'available') return 'in_stock';
  if (v === 'out of stock' || v === 'outofstock' || v === 'out_of_stock' || v === 'oos') return 'out_of_stock';
  return v;
}

function availabilityToInStock(availability) {
  const a = normalizeSeedAvailability(availability);
  if (!a) return null;
  if (a === 'in_stock') return true;
  if (a === 'out_of_stock') return false;
  return null;
}

function normalizeCurrency(value, fallback = 'USD') {
  return String(value || fallback).trim().toUpperCase() || fallback;
}

function isZeroDecimalPriceCurrency(value) {
  return ZERO_DECIMAL_PRICE_CURRENCIES.has(normalizeCurrency(value, ''));
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9.-]+/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    return normalizeAmount(value.amount ?? value.current?.amount ?? value.price_amount ?? value.value);
  }
  return 0;
}

function normalizeSeedReviewSummary(...values) {
  for (const value of values) {
    const source = ensureJsonObject(value);
    const rating = normalizeAmount(
      source.rating ??
        source.rating_value ??
        source.average_rating ??
        source.avg_rating ??
        source.reviewAverageValue,
    );
    const reviewCount = normalizeAmount(
      source.review_count ??
        source.reviewCount ??
        source.count ??
        source.total ??
        source.total_reviews ??
        source.review_count_total,
    );
    if (rating > 0 || reviewCount > 0) {
      return {
        ...(rating > 0 ? { rating } : {}),
        ...(reviewCount > 0 ? { review_count: reviewCount } : {}),
      };
    }
  }
  return null;
}

function shouldTreatAsMinorUnitPrice(rawValue, amount, context = {}) {
  if (!Number.isFinite(amount) || amount < 1000) return false;
  const currency = context.currency || context.price_currency || context.priceCurrency;
  if (isZeroDecimalPriceCurrency(currency)) return false;

  const rawText = String(rawValue ?? '').trim();
  const rawLooksMinorUnit =
    (typeof rawValue === 'number' && Number.isInteger(rawValue)) ||
    (/^\d+(?:\.0+)?$/.test(rawText) && !/[^\d.]/.test(rawText));
  if (!rawLooksMinorUnit) return false;

  const surfaceText = [
    context.category,
    context.title,
    context.description,
    context.canonicalUrl,
    context.destinationUrl,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!PRICE_MINOR_UNIT_HINT_RE.test(surfaceText)) return false;

  return amount / 100 <= 1000;
}

function normalizeExternalSeedPrice(rawValue, context = {}) {
  const amount = normalizeAmount(rawValue);
  if (!shouldTreatAsMinorUnitPrice(rawValue, amount, context)) return amount;
  return amount / 100;
}

function normalizeHttpUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

function normalizeExplicitBeautyCategory(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^external$/i.test(text)) return '';
  for (const [label, pattern] of BEAUTY_CATEGORY_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return text;
}

function normalizeIngredientToken(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return '';
  const aliases = {
    'ascorbic acid': 'ascorbic_acid',
    'azelaic acid': 'azelaic_acid',
    'benzoyl peroxide': 'benzoyl_peroxide',
    benzoyl: 'benzoyl_peroxide',
    bpo: 'benzoyl_peroxide',
    ceramide: 'ceramide_np',
    ceramides: 'ceramide_np',
    'ceramide np': 'ceramide_np',
    glycerin: 'glycerin',
    glycerine: 'glycerin',
    'hyaluronic acid': 'hyaluronic_acid',
    hyaluronic: 'hyaluronic_acid',
    hyaluron: 'hyaluronic_acid',
    'sodium hyaluronate': 'hyaluronic_acid',
    niacinamide: 'niacinamide',
    panthenol: 'panthenol',
    'vitamin b5': 'panthenol',
    'provitamin b5': 'panthenol',
    b5: 'panthenol',
    peptide: 'peptides',
    peptides: 'peptides',
    'multi peptide': 'peptides',
    'multi-peptide': 'peptides',
    'copper peptide': 'peptides',
    'copper peptides': 'peptides',
    tripeptide: 'peptides',
    tetrapeptide: 'peptides',
    hexapeptide: 'peptides',
    retinol: 'retinol',
    retinoid: 'retinol',
    'vitamin a': 'retinol',
    salicylic: 'salicylic_acid',
    'salicylic acid': 'salicylic_acid',
    bha: 'salicylic_acid',
    'vitamin c': 'ascorbic_acid',
    'zinc pca': 'zinc_pca',
    zinc: 'zinc_pca',
  };
  return aliases[normalized] || normalized.replace(/\s+/g, '_');
}

function appendStructuredIngredientIds(out, raw) {
  if (raw == null) return;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        appendStructuredIngredientIds(out, JSON.parse(trimmed));
        return;
      } catch {}
    }
    for (const token of trimmed.split(/[;,|]/)) {
      const normalized = normalizeIngredientToken(token);
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) appendStructuredIngredientIds(out, item);
    return;
  }
  if (typeof raw === 'object') {
    for (const key of [
      'ingredient_ids',
      'ingredientIds',
      'reviewed_ingredient_ids',
      'reviewedIngredientIds',
      'canonical_ingredient_ids',
      'canonicalIngredientIds',
      'platform_metadata',
      'platformMetadata',
      'beauty_meta',
      'beautyMeta',
    ]) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        appendStructuredIngredientIds(out, raw[key]);
      }
    }
    return;
  }
  const normalized = normalizeIngredientToken(raw);
  if (normalized && !out.includes(normalized)) out.push(normalized);
}

function collectStructuredIngredientIds(row, seedData, snapshot) {
  const out = [];
  for (const candidate of [
    row?.reviewed_ingredient_ids,
    row?.canonical_ingredient_ids,
    row?.ingredient_ids,
    row?.platform_metadata,
    seedData?.reviewed_ingredient_ids,
    seedData?.canonical_ingredient_ids,
    seedData?.ingredient_ids,
    seedData?.platform_metadata,
    snapshot?.reviewed_ingredient_ids,
    snapshot?.canonical_ingredient_ids,
    snapshot?.ingredient_ids,
    snapshot?.platform_metadata,
  ]) {
    appendStructuredIngredientIds(out, candidate);
  }
  return out;
}

function inferExternalSeedBeautyCategory({
  explicitCategory,
  title,
  description,
  canonicalUrl,
  destinationUrl,
  ingredientIds,
} = {}) {
  const explicit = normalizeExplicitBeautyCategory(explicitCategory);
  const primarySurfaceText = [title, canonicalUrl, destinationUrl]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (explicit) {
    if (explicit === 'Fragrance' && SUNSCREEN_CATEGORY_RE.test(primarySurfaceText)) return 'Sunscreen';
    return explicit;
  }
  const descriptionText = String(description || '').trim();
  const surfaceText = [primarySurfaceText, descriptionText].filter(Boolean).join(' ');
  if (!surfaceText) return '';

  const normalizedIngredientIds = Array.isArray(ingredientIds)
    ? ingredientIds.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (
    /\bsolution\b/i.test(surfaceText) &&
    normalizedIngredientIds.some((value) => STRONG_ACTIVE_SOLUTION_INGREDIENT_IDS.has(value))
  ) {
    return 'Serum';
  }

  for (const [label, pattern] of BEAUTY_CATEGORY_PATTERNS) {
    if (pattern.test(primarySurfaceText)) return label;
  }

  for (const [label, pattern] of BEAUTY_CATEGORY_DESCRIPTION_PATTERNS) {
    if (pattern.test(descriptionText)) return label;
  }

  if (
    /\b(spot[-\s]?target(?:ing|ed)?|spot[-\s]?treatment|blemish|acne|clarifying treatment|targeting gel|treatment gel)\b/i.test(surfaceText)
  ) {
    return 'Treatment';
  }

  return '';
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function normalizeFaqItems(value, maxItems = 24) {
  const items = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const question = firstNonEmptyString(item?.question).replace(/^(?:q(?:uestion)?\s*[:/-]\s*)/i, '').trim();
    const answer = firstNonEmptyString(item?.answer).replace(/^(?:a(?:nswer)?\s*[:/-]\s*)/i, '').trim();
    const sourceKind = firstNonEmptyString(item?.source_kind, item?.sourceKind) || 'merchant_faq';
    const sourceUrl = normalizeHttpUrl(item?.source_url || item?.sourceUrl);
    const sourceTitle = firstNonEmptyString(item?.source_title, item?.sourceTitle);
    if (!question || !answer) continue;
    if (
      !isDisplayablePdpFaqItem({
        question,
        answer,
        source_url: sourceUrl,
        source_title: sourceTitle,
      })
    ) {
      continue;
    }
    const key = `${question.toLowerCase()}|${answer.toLowerCase()}|${sourceKind.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      question,
      answer,
      source_kind: sourceKind,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      ...(sourceTitle ? { source_title: sourceTitle } : {}),
    });
    if (out.length >= Math.max(1, Number(maxItems) || 24)) break;
  }
  return out;
}

function normalizeStringList(value, maxItems = 64) {
  const out = [];
  const seen = new Set();

  const append = (candidate) => {
    const normalized = normalizeIngredientSignalToken(candidate);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  const visit = (input) => {
    if (!input) return;
    if (typeof input === 'string') {
      input
        .split(/[,\n;|•]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach(append);
      return;
    }
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (typeof input !== 'object') return;
    append(
      input.name ||
        input.title ||
        input.label ||
        input.value ||
        input.ingredient_name ||
        input.display_name ||
        input.inci_name,
    );
  };

  visit(value);
  return out.slice(0, maxItems);
}

function normalizeIngredientSignalToken(value) {
  const text = String(value || '')
    .replace(/\[more\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/^key ingredients?$/i.test(text)) return '';
  return text;
}

function appendIngredientSignalTokens(out, value) {
  if (!value) return;

  if (typeof value === 'string') {
    const parts = value.split(/[,\n;|/]+/);
    for (const part of parts) {
      const token = normalizeIngredientSignalToken(part);
      if (!token || out.includes(token)) continue;
      out.push(token);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) appendIngredientSignalTokens(out, item);
    return;
  }

  if (typeof value !== 'object') return;

  appendIngredientSignalTokens(out, value.inci);
  appendIngredientSignalTokens(out, value.inci_name);
  appendIngredientSignalTokens(out, value.ingredient_name);
  appendIngredientSignalTokens(out, value.name);
  appendIngredientSignalTokens(out, value.display_name);
  appendIngredientSignalTokens(out, value.title);
}

function collectSeedIngredientSignalTokens(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsedSeedData.snapshot);
  const ingredientIntel = ensureJsonObject(parsedSeedData.ingredient_intel);
  const snapshotIngredientIntel = ensureJsonObject(snapshot.ingredient_intel);
  const derived = ensureJsonObject(parsedSeedData.derived);
  const recall = ensureJsonObject(derived.recall);
  const science = ensureJsonObject(parsedSeedData.science);
  const snapshotScience = ensureJsonObject(snapshot.science);
  const assessment = ensureJsonObject(parsedSeedData.assessment);
  const snapshotAssessment = ensureJsonObject(snapshot.assessment);

  const out = [];
  const sources = [
    row?.ingredient_tokens,
    row?.key_ingredients,
    row?.hero_ingredients,
    row?.active_ingredients,
    parsedSeedData.ingredient_tokens,
    parsedSeedData.key_ingredients,
    parsedSeedData.keyIngredients,
    parsedSeedData.hero_ingredients,
    parsedSeedData.heroIngredients,
    parsedSeedData.active_ingredients,
    parsedSeedData.activeIngredients,
    parsedSeedData.ingredient_names,
    parsedSeedData.ingredientNames,
    parsedSeedData.ingredients,
    recall.ingredient_tokens,
    parsedSeedData.likely_key_ingredients_or_signals,
    parsedSeedData.likelyKeyIngredientsOrSignals,
    science.key_ingredients,
    science.keyIngredients,
    assessment.hero_ingredient,
    assessment.heroIngredient,
    ingredientIntel.inci_normalized,
    ingredientIntel.inciNormalized,
    ingredientIntel.key_ingredients,
    ingredientIntel.keyIngredients,
    ingredientIntel.inci_raw,
    ingredientIntel.raw_ingredient_text_clean,
    ingredientIntel.inci_list,
    snapshot.ingredient_tokens,
    snapshot.key_ingredients,
    snapshot.keyIngredients,
    snapshot.hero_ingredients,
    snapshot.heroIngredients,
    snapshot.active_ingredients,
    snapshot.activeIngredients,
    snapshot.ingredient_names,
    snapshot.ingredientNames,
    snapshot.ingredients,
    snapshot.likely_key_ingredients_or_signals,
    snapshot.likelyKeyIngredientsOrSignals,
    snapshotScience.key_ingredients,
    snapshotScience.keyIngredients,
    snapshotAssessment.hero_ingredient,
    snapshotAssessment.heroIngredient,
    snapshotIngredientIntel.inci_normalized,
    snapshotIngredientIntel.inciNormalized,
    snapshotIngredientIntel.key_ingredients,
    snapshotIngredientIntel.keyIngredients,
    snapshotIngredientIntel.inci_raw,
    snapshotIngredientIntel.raw_ingredient_text_clean,
    snapshotIngredientIntel.inci_list,
  ];
  for (const source of sources) appendIngredientSignalTokens(out, source);
  return out;
}

function appendImageUrls(out, value) {
  if (!value) return;

  if (typeof value === 'string') {
    const url = normalizePdpImageUrl(value);
    if (!url || out.includes(url)) return;
    out.push(url);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) appendImageUrls(out, item);
    return;
  }

  if (typeof value !== 'object') return;
  appendImageUrls(out, value.image_url);
  appendImageUrls(out, value.url);
  appendImageUrls(out, value.src);
  appendImageUrls(out, value.contentUrl);
}

function normalizeImageFamilyToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function extractImageFamilyKey(url) {
  const normalizedUrl = normalizePdpImageUrl(url);
  if (!normalizedUrl) return '';
  try {
    const parsed = new URL(normalizedUrl);
    const rawFilename = String(parsed.pathname.split('/').pop() || '').trim().toLowerCase();
    const filename = rawFilename.replace(SHOPIFY_ASSET_HASH_SUFFIX_RE, '$1$2');
    if (!filename) return '';

    const tfSkuMatch = filename.match(/^(tf_sku_[a-z0-9]+(?:_us)?)_\d+x\d+_[0-9a-z]+(?:[a-z])?\.[a-z0-9]+$/i);
    if (tfSkuMatch) return tfSkuMatch[1].toLowerCase();

    const genericSizedMatch = filename.match(/^(.*?)_\d+x\d+_[0-9a-z]+(?:[a-z])?\.[a-z0-9]+$/i);
    if (genericSizedMatch) return genericSizedMatch[1].toLowerCase();

    return filename.replace(/\.[a-z0-9]+$/i, '');
  } catch {
    return '';
  }
}

function narrowVariantImageUrls(imageUrls, rawVariant) {
  const normalized = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  if (normalized.length <= 1) return normalized;

  const primaryImageUrl = normalizePdpImageUrl(rawVariant?.image_url || rawVariant?.image || '');
  const primaryFamilyKey = extractImageFamilyKey(primaryImageUrl);
  const variantTokens = [
    rawVariant?.sku,
    rawVariant?.sku_id,
    rawVariant?.variant_id,
    rawVariant?.id,
  ]
    .map(normalizeImageFamilyToken)
    .filter((token) => token.length >= 4);

  let filtered = primaryFamilyKey
    ? normalized.filter((url) => extractImageFamilyKey(url) === primaryFamilyKey)
    : [];

  if (!filtered.length && variantTokens.length) {
    filtered = normalized.filter((url) => {
      const haystack = normalizeImageFamilyToken(url);
      return variantTokens.some((token) => haystack.includes(token));
    });
  }

  if (!filtered.length) return normalized;

  const out = [];
  for (const url of filtered) {
    if (out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

function normalizeOptionText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeOptionNameKey(name) {
  return normalizeOptionText(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const VARIANT_OPTION_QUERY_PARAM_LABELS = new Map([
  ['size', 'Size'],
  ['option', 'Option'],
  ['color', 'Color'],
  ['colour', 'Color'],
  ['shade', 'Shade'],
  ['scent', 'Scent'],
  ['pack', 'Pack'],
  ['count', 'Count'],
  ['quantity', 'Quantity'],
  ['qty', 'Quantity'],
  ['volume', 'Size'],
  ['format', 'Format'],
  ['finish', 'Finish'],
  ['style', 'Style'],
]);

function getVariantOptionQueryParamLabel(name) {
  const normalized = normalizeOptionNameKey(name);
  if (!normalized) return '';
  return VARIANT_OPTION_QUERY_PARAM_LABELS.get(normalized) || '';
}

function isCombinedColorSizeOptionName(name) {
  const normalized = normalizeOptionNameKey(name);
  return normalized.includes('color') && normalized.includes('size');
}

function parseCombinedColorSizeValue(value) {
  const parts = normalizeOptionText(value)
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const [color, size] = parts;
  if (!color || !size) return null;
  if (!/\d/.test(size) && !/\b(size|fit|pack|count|ml|g|oz|lb|kg|cm|mm)\b/i.test(size)) {
    return null;
  }
  return { color, size };
}

function normalizeOptionEntries(options) {
  const out = [];
  const seen = new Set();

  const append = (name, value) => {
    const optionName = normalizeOptionText(name);
    const optionValue = normalizeOptionText(value);
    if (!optionName || !optionValue) return;

    const normalizedEntries = isCombinedColorSizeOptionName(optionName)
      ? (() => {
          const parsed = parseCombinedColorSizeValue(optionValue);
          return parsed
            ? [
                { name: 'Color', value: parsed.color },
                { name: 'Size', value: parsed.size },
              ]
            : [{ name: 'Variant', value: optionValue }];
        })()
      : [{ name: optionName, value: optionValue }];

    normalizedEntries.forEach((entry) => {
      const key = `${entry.name.toLowerCase()}|${entry.value.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(entry);
    });
  };

  (Array.isArray(options) ? options : []).forEach((option) => {
    if (option && typeof option === 'object' && option.name && option.value != null) {
      append(option.name, option.value);
      return;
    }
    if (option && typeof option === 'object') {
      const name = option.name || option.option_name || option.label || option.key || option.title;
      const value = option.value ?? option.option_value ?? option.selected ?? option.label_value;
      append(name, value);
    }
  });

  return out;
}

function collectVariantOptionsFromUrl(value) {
  const raw = normalizeHttpUrl(value);
  if (!raw) return [];
  try {
    const parsed = new URL(raw);
    const out = [];
    const seen = new Set();
    for (const [key, paramValue] of parsed.searchParams.entries()) {
      const label = getVariantOptionQueryParamLabel(key);
      const valueText = normalizeOptionText(paramValue);
      if (!label || !valueText) continue;
      const dedupeKey = `${label.toLowerCase()}|${valueText.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ name: label, value: valueText });
    }
    return out;
  } catch {
    return [];
  }
}

function collectVariantOptionsFromRawVariantUrl(rawVariant) {
  const urls = [
    rawVariant?.deep_link,
    rawVariant?.url,
    rawVariant?.product_url,
  ];
  for (const url of urls) {
    const options = collectVariantOptionsFromUrl(url);
    if (options.length > 0) return options;
  }
  return [];
}

function isSkuLikeVariantText(value, rawVariant) {
  const normalized = normalizeOptionText(value).toLowerCase();
  if (!normalized) return false;
  const identityTokens = [
    rawVariant?.sku,
    rawVariant?.sku_id,
    rawVariant?.variant_sku,
    rawVariant?.variant_id,
    rawVariant?.id,
  ]
    .map((item) => normalizeOptionText(item).toLowerCase())
    .filter(Boolean);
  if (identityTokens.includes(normalized)) return true;
  return /^[a-z]*\d[a-z0-9-]*$/i.test(normalized) && normalized.length >= 4 && !/\s/.test(normalized);
}

function shouldPreferUrlVariantOptions(options, urlOptions, rawVariant) {
  if (!urlOptions.length) return false;
  if (!options.length) return true;
  return options.every((option) => {
    const optionName = normalizeOptionNameKey(option?.name);
    if (!['offer', 'option', 'variant', 'sku', 'sku id'].includes(optionName)) return false;
    return isSkuLikeVariantText(option?.value, rawVariant);
  });
}

function collectSeedImageUrls(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const out = [];
  appendImageUrls(out, parsedSeedData.snapshot?.image_url);
  appendImageUrls(out, parsedSeedData.snapshot?.image_urls);
  appendImageUrls(out, parsedSeedData.snapshot?.images);
  appendImageUrls(out, row?.image_url);
  appendImageUrls(out, parsedSeedData.image_url);
  appendImageUrls(out, parsedSeedData.image_urls);
  appendImageUrls(out, parsedSeedData.images);
  return out;
}

function resolveSeedImageOverride(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsedSeedData.snapshot);
  return lookupExternalSeedImageOverride(
    snapshot.canonical_url,
    snapshot.destination_url,
    row?.canonical_url,
    row?.destination_url,
    parsedSeedData.canonical_url,
    parsedSeedData.destination_url,
  );
}

function normalizeSeedImageUrls(seedData, row) {
  const out = collectSeedImageUrls(seedData, row);
  if (out.length > 0) return out;

  const override = resolveSeedImageOverride(seedData, row);
  if (!override) return out;

  appendImageUrls(out, override.image_urls);
  appendImageUrls(out, override.image_url);
  return out;
}

function collectPrimaryVariantImageUrls(variants) {
  const primaryVariant =
    Array.isArray(variants) && variants.length > 0 && variants[0] && typeof variants[0] === 'object'
      ? variants[0]
      : null;
  if (!primaryVariant) return [];

  const out = [];
  appendImageUrls(out, primaryVariant.image_urls);
  appendImageUrls(out, primaryVariant.images);
  appendImageUrls(out, primaryVariant.image_url);
  return out;
}

function normalizeVariantHintToken(value) {
  return String(value || '').trim().toLowerCase();
}

function collectVariantHintTokensFromUrl(value) {
  const raw = normalizeHttpUrl(value);
  if (!raw) return [];
  try {
    const parsed = new URL(raw);
    const out = [];
    for (const [key, paramValue] of parsed.searchParams.entries()) {
      const normalizedKey = normalizeVariantHintToken(key);
      const normalizedValue = normalizeVariantHintToken(paramValue);
      if (!normalizedValue) continue;
      if (
        !['v', 'variant', 'variant_id', 'sku', 'sku_id', 'pid'].includes(normalizedKey) &&
        !getVariantOptionQueryParamLabel(key)
      ) {
        continue;
      }
      out.push(normalizedValue);
    }
    return out;
  } catch {
    return [];
  }
}

function collectVariantIdentityTokens(variant) {
  const optionValues = normalizeOptionEntries(variant?.options).map((item) => item.value);
  return Array.from(
    new Set(
      [
        variant?.variant_id,
        variant?.id,
        variant?.sku,
        variant?.sku_id,
        variant?.option_name,
        variant?.option_value,
        variant?.title,
        ...optionValues,
      ]
        .map((item) => normalizeVariantHintToken(item))
        .filter(Boolean),
    ),
  );
}

function variantMatchesHintTokens(variant, hintTokens = []) {
  const variantTokens = collectVariantIdentityTokens(variant);
  if (!variantTokens.length || !Array.isArray(hintTokens) || !hintTokens.length) return false;
  return hintTokens.some((token) => variantTokens.includes(normalizeVariantHintToken(token)));
}

function findVariantsMatchingPrimaryImage(variants, primaryImageUrl) {
  const normalizedPrimary = normalizePdpImageUrl(primaryImageUrl);
  if (!normalizedPrimary || !Array.isArray(variants)) return [];
  return variants.filter((variant) => {
    const urls = [];
    appendImageUrls(urls, variant?.image_url);
    appendImageUrls(urls, variant?.image_urls);
    appendImageUrls(urls, variant?.images);
    return urls.some((url) => normalizePdpImageUrl(url) === normalizedPrimary);
  });
}

function findVariantsMatchingPrice(variants, rawPrice, priceContext) {
  const normalizedPrice = normalizeExternalSeedPrice(rawPrice, priceContext);
  if (!(normalizedPrice > 0) || !Array.isArray(variants)) return [];
  return variants.filter((variant) => normalizeAmount(variant?.price) === normalizedPrice);
}

function moveVariantToFront(variants, targetVariantId) {
  const targetId = String(targetVariantId || '').trim();
  if (!targetId || !Array.isArray(variants) || variants.length <= 1) return variants;
  const index = variants.findIndex((variant) => String(variant?.variant_id || variant?.id || '').trim() === targetId);
  if (index <= 0) return variants;
  return [variants[index], ...variants.slice(0, index), ...variants.slice(index + 1)];
}

function resolveSelectedSeedVariant({
  variants,
  row,
  seedData,
  snapshot,
  destinationUrl,
  canonicalUrl,
  priceContext,
} = {}) {
  const safeVariants = Array.isArray(variants) ? variants.filter(Boolean) : [];
  if (safeVariants.length <= 1) return safeVariants[0] || null;

  const explicitHintTokens = Array.from(
    new Set(
      [
        seedData?.selected_variant_id,
        seedData?.default_variant_id,
        seedData?.variant_id,
        seedData?.sku_id,
        seedData?.variant_title,
        snapshot?.selected_variant_id,
        snapshot?.default_variant_id,
        snapshot?.variant_id,
        snapshot?.sku_id,
        snapshot?.variant_title,
        row?.selected_variant_id,
        row?.default_variant_id,
        ...collectVariantHintTokensFromUrl(destinationUrl),
        ...collectVariantHintTokensFromUrl(canonicalUrl),
      ]
        .map((item) => normalizeVariantHintToken(item))
        .filter(Boolean),
    ),
  );

  const explicitMatches = explicitHintTokens.length
    ? safeVariants.filter((variant) => variantMatchesHintTokens(variant, explicitHintTokens))
    : [];
  const primaryImageUrl =
    snapshot?.image_url || row?.image_url || seedData?.image_url || null;
  const imageMatches = findVariantsMatchingPrimaryImage(safeVariants, primaryImageUrl);
  const priceMatches = findVariantsMatchingPrice(
    safeVariants,
    row?.price_amount ?? seedData?.price_amount ?? snapshot?.price_amount,
    priceContext,
  );

  let candidate = null;
  if (explicitMatches.length === 1) {
    candidate = explicitMatches[0];
  } else if (explicitMatches.length > 1) {
    const priceMatchIds = new Set(
      priceMatches.map((variant) => String(variant?.variant_id || variant?.id || '').trim()).filter(Boolean),
    );
    const imageMatchIds = new Set(
      imageMatches.map((variant) => String(variant?.variant_id || variant?.id || '').trim()).filter(Boolean),
    );
    const priceNarrowed = priceMatchIds.size
      ? explicitMatches.filter((variant) =>
          priceMatchIds.has(String(variant?.variant_id || variant?.id || '').trim()),
        )
      : [];
    const imageNarrowed = imageMatchIds.size
      ? explicitMatches.filter((variant) =>
          imageMatchIds.has(String(variant?.variant_id || variant?.id || '').trim()),
        )
      : [];
    if (priceNarrowed.length === 1) {
      candidate = priceNarrowed[0];
    } else if (imageNarrowed.length === 1) {
      candidate = imageNarrowed[0];
    }
  } else if (!explicitMatches.length && imageMatches.length === 1 && priceMatches.length === 1) {
    const imageVariantId = String(imageMatches[0]?.variant_id || imageMatches[0]?.id || '').trim();
    const priceVariantId = String(priceMatches[0]?.variant_id || priceMatches[0]?.id || '').trim();
    if (imageVariantId && imageVariantId === priceVariantId) {
      candidate = imageMatches[0];
    }
  }

  if (!candidate) return null;

  if (imageMatches.length === 1) {
    const imageVariantId = String(imageMatches[0]?.variant_id || imageMatches[0]?.id || '').trim();
    const candidateId = String(candidate?.variant_id || candidate?.id || '').trim();
    if (imageVariantId && candidateId && imageVariantId !== candidateId) return null;
  }
  if (priceMatches.length === 1) {
    const priceVariantId = String(priceMatches[0]?.variant_id || priceMatches[0]?.id || '').trim();
    const candidateId = String(candidate?.variant_id || candidate?.id || '').trim();
    if (priceVariantId && candidateId && priceVariantId !== candidateId) return null;
  }

  return candidate;
}

function normalizeProductOptionNames(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.keys(raw).map((key) => String(key).trim()).filter(Boolean);
  }
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((option) => {
      if (typeof option === 'string') return option.trim();
      if (option && typeof option === 'object') {
        return String(option.name || option.title || option.label || '').trim();
      }
      return '';
    })
    .filter(Boolean);
}

function getSeedProductOptionNames(parsedSeedData) {
  const candidates = [
    parsedSeedData?.snapshot?.options,
    parsedSeedData?.options,
    parsedSeedData?.snapshot?.product?.options,
    parsedSeedData?.product?.options,
    parsedSeedData?.snapshot?.product_options,
    parsedSeedData?.product_options,
    parsedSeedData?.snapshot?.product?.product_options,
    parsedSeedData?.product?.product_options,
    parsedSeedData?.snapshot?.choices,
    parsedSeedData?.choices,
    parsedSeedData?.snapshot?.product?.choices,
    parsedSeedData?.product?.choices,
    parsedSeedData?.snapshot?.variantOptions,
    parsedSeedData?.variantOptions,
    parsedSeedData?.snapshot?.product?.variantOptions,
    parsedSeedData?.product?.variantOptions,
  ];
  for (const candidate of candidates) {
    const names = normalizeProductOptionNames(candidate);
    if (names.length > 0) return names;
  }
  return [];
}

function getRawSeedVariants(parsedSeedData) {
  const collections = [
    parsedSeedData?.snapshot?.variants,
    parsedSeedData?.variants,
    parsedSeedData?.snapshot?.product?.variants,
    parsedSeedData?.product?.variants,
    parsedSeedData?.snapshot?.skus,
    parsedSeedData?.skus,
    parsedSeedData?.snapshot?.product?.skus,
    parsedSeedData?.product?.skus,
  ];
  for (const collection of collections) {
    if (Array.isArray(collection) && collection.length > 0) {
      return collection;
    }
  }
  return [];
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function stripLegacyVariantContainers(seedData) {
  const next = cloneJsonValue(seedData);

  delete next.variants;
  delete next.skus;
  delete next.variantOptions;
  delete next.variant_options;
  delete next.choices;
  if (next.product && typeof next.product === 'object') {
    delete next.product.variants;
    delete next.product.skus;
    delete next.product.variantOptions;
    delete next.product.variant_options;
    delete next.product.choices;
  }

  const snapshot = ensureJsonObject(next.snapshot);
  delete snapshot.skus;
  delete snapshot.variantOptions;
  delete snapshot.variant_options;
  delete snapshot.choices;
  if (snapshot.product && typeof snapshot.product === 'object') {
    delete snapshot.product.variants;
    delete snapshot.product.skus;
    delete snapshot.product.variantOptions;
    delete snapshot.product.variant_options;
    delete snapshot.product.choices;
  }
  next.snapshot = snapshot;
  return next;
}

function normalizeOptions(rawVariant, optionName, optionValue, productOptionNames = []) {
  const urlOptions = collectVariantOptionsFromRawVariantUrl(rawVariant);
  const directOptionSources = [
    rawVariant?.options,
    rawVariant?.choices,
    rawVariant?.variantOptions,
    rawVariant?.variant_options,
    rawVariant?.selections,
    rawVariant?.selected_options,
  ];

  for (const source of directOptionSources) {
    if (Array.isArray(source)) {
      const normalized = normalizeOptionEntries(source);
      if (normalized.length > 0) {
        return shouldPreferUrlVariantOptions(normalized, urlOptions, rawVariant) ? urlOptions : normalized;
      }
    }

    if (source && typeof source === 'object') {
      const normalized = normalizeOptionEntries(
        Object.entries(source).map(([name, value]) => ({ name, value })),
      );
      if (normalized.length > 0) {
        return shouldPreferUrlVariantOptions(normalized, urlOptions, rawVariant) ? urlOptions : normalized;
      }
    }
  }

  if (Array.isArray(rawVariant?.options)) {
    const normalized = normalizeOptionEntries(rawVariant.options);
    if (normalized.length > 0) {
      return shouldPreferUrlVariantOptions(normalized, urlOptions, rawVariant) ? urlOptions : normalized;
    }
  }

  const tupleOptions = normalizeOptionEntries(
    [rawVariant?.option1, rawVariant?.option2, rawVariant?.option3]
      .map((value, index) => {
        if (value == null || value === '') return null;
        return {
          name: productOptionNames[index] || `Option ${index + 1}`,
          value,
        };
      })
      .filter(Boolean),
  );
  if (tupleOptions.length > 0) return tupleOptions;

  if (optionName || optionValue) {
    const direct = normalizeOptionEntries([
      { name: optionName || 'Variant', value: optionValue || 'Default' },
    ]);
    if (direct.length > 0) {
      return shouldPreferUrlVariantOptions(direct, urlOptions, rawVariant) ? urlOptions : direct;
    }
  }

  return urlOptions;
}

function normalizeSeedVariants(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const rawVariants = getRawSeedVariants(parsedSeedData);
  const productOptionNames = getSeedProductOptionNames(parsedSeedData);

  if (!rawVariants.length) return [];

  const productImageUrls = normalizeSeedImageUrls(parsedSeedData, row);
  const fallbackCurrency = normalizeCurrency(
    row?.price_currency || parsedSeedData.price_currency || parsedSeedData.snapshot?.price_currency,
    'USD',
  );

  return rawVariants
    .map((rawVariant, idx) => {
      if (!rawVariant || typeof rawVariant !== 'object') return null;

      const optionName = String(rawVariant.option_name || '').trim();
      const optionValue = String(rawVariant.option_value || '').trim();
      const sku = String(
        rawVariant.sku || rawVariant.sku_id || rawVariant.variant_sku || rawVariant.variant_id || rawVariant.id || '',
      ).trim();
      const variantId = String(rawVariant.variant_id || rawVariant.id || sku || `seed-variant-${idx + 1}`).trim();
      const currency = normalizeCurrency(
        rawVariant.currency || rawVariant.price_currency || rawVariant.pricing?.current?.currency,
        fallbackCurrency,
      );
      const price = normalizeAmount(
        rawVariant.price_amount ?? rawVariant.price ?? rawVariant.pricing?.current?.amount ?? rawVariant.pricing,
      );
      const rawAvailability =
        rawVariant.availability ??
        rawVariant.stock_status ??
        rawVariant.stock ??
        row?.availability ??
        parsedSeedData.availability ??
        parsedSeedData.snapshot?.availability;
      let inStock;
      if (typeof rawVariant.in_stock === 'boolean') {
        inStock = rawVariant.in_stock;
      } else if (typeof rawVariant.available === 'boolean') {
        inStock = rawVariant.available;
      } else if (rawVariant.inventory_quantity != null && rawVariant.inventory_quantity !== '') {
        inStock = Number(rawVariant.inventory_quantity) > 0;
      } else if (rawVariant.available_quantity != null && rawVariant.available_quantity !== '') {
        inStock = Number(rawVariant.available_quantity) > 0;
      } else {
        inStock = availabilityToInStock(rawAvailability);
      }

      const rawQty =
        rawVariant.available_quantity ??
        rawVariant.inventory_quantity ??
        rawVariant.quantity ??
        rawVariant.stock_quantity ??
        rawVariant.stock;
      const availableQuantity =
        rawQty == null || rawQty === ''
          ? undefined
          : Number.isFinite(Number(rawQty))
            ? Math.max(0, Math.floor(Number(rawQty)))
            : undefined;
      if (availableQuantity != null) {
        inStock = availableQuantity > 0;
      }

      const imageUrls = normalizeSeedImageUrls(
        {
          image_url: rawVariant.image_url || rawVariant.image,
          image_urls: rawVariant.image_urls,
          images: rawVariant.images,
        },
        null,
      );
      const narrowedImageUrls = narrowVariantImageUrls(imageUrls, rawVariant);
      const normalizedImageUrls = narrowedImageUrls.length > 0 ? narrowedImageUrls : productImageUrls;
      const imageUrl = normalizedImageUrls[0];
      const options = normalizeOptions(rawVariant, optionName, optionValue, productOptionNames);
      const rawTitle = String(rawVariant.title || rawVariant.name || optionValue || sku || '').trim();
      const inferredTitle = options.map((option) => option.value).filter(Boolean).join(' / ');
      const title =
        (rawTitle && !isSkuLikeVariantText(rawTitle, rawVariant) ? rawTitle : inferredTitle) ||
        rawTitle ||
        `Variant ${idx + 1}`;
      const url = normalizeHttpUrl(rawVariant.deep_link || rawVariant.url || rawVariant.product_url);
      const availability = normalizeSeedAvailability(rawAvailability);
      const description = String(
        rawVariant.description || rawVariant.description_html || rawVariant.summary || rawVariant.body_html || '',
      ).trim();
      const swatchHex = firstNonEmptyString(
        rawVariant.color_hex,
        rawVariant.swatch?.hex,
        rawVariant.beauty_meta?.shade_hex,
        rawVariant.shade_hex,
        rawVariant.hex,
      );

      return {
        id: variantId,
        variant_id: variantId,
        sku_id: sku || variantId,
        sku: sku || variantId,
        title,
        options,
        price,
        currency,
        pricing: { current: { amount: price, currency } },
        inventory_quantity: availableQuantity ?? (inStock === true ? 999 : inStock === false ? 0 : null),
        in_stock: inStock,
        available: typeof inStock === 'boolean' ? inStock : undefined,
        availability: availability || undefined,
        option_name: optionName || undefined,
        option_value: optionValue || undefined,
        description: description || undefined,
        image_url: imageUrl || undefined,
        images: normalizedImageUrls,
        image_urls: normalizedImageUrls,
        ...(swatchHex ? { color_hex: swatchHex, swatch: { hex: swatchHex } } : {}),
        ...(rawVariant.beauty_meta && typeof rawVariant.beauty_meta === 'object'
          ? { beauty_meta: rawVariant.beauty_meta }
          : {}),
        ...(url ? { url } : {}),
        ...(normalizeHttpUrl(rawVariant.deep_link) ? { deep_link: normalizeHttpUrl(rawVariant.deep_link) } : {}),
        ...(normalizeHttpUrl(rawVariant.product_url) ? { product_url: normalizeHttpUrl(rawVariant.product_url) } : {}),
      };
    })
    .filter(Boolean);
}

function canonicalizeExternalSeedSnapshot(seedData, row, options = {}) {
  const nextSeedData = cloneJsonValue(ensureJsonObject(seedData));
  const snapshot = ensureJsonObject(nextSeedData.snapshot);
  const canonicalVariants = normalizeSeedVariants(nextSeedData, row);
  if (canonicalVariants.length > 0) {
    snapshot.variants = cloneJsonValue(canonicalVariants);
  } else if (!Array.isArray(snapshot.variants)) {
    snapshot.variants = [];
  }
  nextSeedData.snapshot = snapshot;

  if (options.stripLegacy === true) {
    return stripLegacyVariantContainers(nextSeedData);
  }
  return nextSeedData;
}

function buildExternalSeedProduct(row, options = {}) {
  if (!row || typeof row !== 'object') return null;

  const seedData = canonicalizeExternalSeedSnapshot(row.seed_data, row, { stripLegacy: false });
  const snapshot = ensureJsonObject(seedData.snapshot);
  const ingredientIntel = ensureJsonObject(seedData.ingredient_intel);
  const snapshotIngredientIntel = ensureJsonObject(snapshot.ingredient_intel);
  const science = ensureJsonObject(seedData.science);
  const snapshotScience = ensureJsonObject(snapshot.science);
  const destinationUrl = String(
    snapshot.destination_url || row.destination_url || seedData.destination_url || '',
  ).trim();
  const canonicalUrl = String(
    snapshot.canonical_url || row.canonical_url || seedData.canonical_url || '',
  ).trim();

  const externalProductId =
    String(
      row.external_product_id || seedData.external_product_id || seedData.product_id || snapshot.product_id || '',
    ).trim() || stableExternalProductId(canonicalUrl || destinationUrl);

  if (!externalProductId) return null;
  const recall = resolveExternalSeedRecallDoc({ row, seedData, snapshot });
  const storedRecall = ensureJsonObject(seedData?.derived?.recall);
  const prefersStoredRecallSummary =
    normalizeNonEmptyString(storedRecall.retrieval_summary) ||
    normalizeNonEmptyString(storedRecall.retrieval_body);

  const title =
    String(
      recall.retrieval_title || snapshot.title || row.title || seedData.title || canonicalUrl || destinationUrl || externalProductId,
    ).trim() ||
    externalProductId;
  const description = firstNonEmptyString(
    prefersStoredRecallSummary ? recall.retrieval_summary : '',
    snapshot.description,
    row.description,
    row.seed_description,
    seedData.description,
    !prefersStoredRecallSummary ? recall.retrieval_summary : '',
  );
  const categoryDescription = firstNonEmptyString(
    snapshot.description,
    row.description,
    seedData.description,
  );
  const pdpDescriptionRaw = firstNonEmptyString(
    seedData.pdp_description_raw,
    snapshot.pdp_description_raw,
  );
  const pdpIngredientsRaw = firstNonEmptyString(
    seedData.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
  );
  const pdpActiveIngredientsRaw = firstNonEmptyString(
    seedData.pdp_active_ingredients_raw,
    snapshot.pdp_active_ingredients_raw,
  );
  const pdpHowToUseRaw = firstNonEmptyString(
    seedData.pdp_how_to_use_raw,
    snapshot.pdp_how_to_use_raw,
  );
  const pdpFaqItems = normalizeFaqItems(
    Array.isArray(seedData.pdp_faq_items) && seedData.pdp_faq_items.length > 0
      ? seedData.pdp_faq_items
      : snapshot.pdp_faq_items,
  );
  const rawIngredientTextClean = firstNonEmptyString(
    ingredientIntel.raw_ingredient_text_clean,
    snapshotIngredientIntel.raw_ingredient_text_clean,
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
  );
  const inciList = normalizeStringList(
    ingredientIntel.inci_list ||
      snapshotIngredientIntel.inci_list ||
      ingredientIntel.inci_normalized ||
      snapshotIngredientIntel.inci_normalized,
  );
  const activeIngredients = normalizeStringList(
    seedData.active_ingredients ||
      seedData.activeIngredients ||
      snapshot.active_ingredients ||
      snapshot.activeIngredients ||
      science.key_ingredients ||
      science.keyIngredients ||
      snapshotScience.key_ingredients ||
      snapshotScience.keyIngredients,
    24,
  );
  const keyIngredients = normalizeStringList(
    seedData.key_ingredients ||
      seedData.keyIngredients ||
      snapshot.key_ingredients ||
      snapshot.keyIngredients ||
      science.key_ingredients ||
      science.keyIngredients ||
      snapshotScience.key_ingredients ||
      snapshotScience.keyIngredients,
    24,
  );
  const pdpDetailsSections = Array.isArray(seedData.pdp_details_sections)
    ? seedData.pdp_details_sections
    : Array.isArray(snapshot.pdp_details_sections)
      ? snapshot.pdp_details_sections
      : [];
  const pdpFieldCaptureStatus =
    (seedData.pdp_field_capture_status && typeof seedData.pdp_field_capture_status === 'object')
      ? seedData.pdp_field_capture_status
      : (snapshot.pdp_field_capture_status && typeof snapshot.pdp_field_capture_status === 'object')
        ? snapshot.pdp_field_capture_status
        : undefined;
  const seedDescriptionOrigin = firstNonEmptyString(
    seedData.seed_description_origin,
    snapshot.seed_description_origin,
  );
  const sourcePageType = firstNonEmptyString(
    seedData.source_page_type,
    snapshot.source_page_type,
    row.source_page_type,
  );
  const contentQuality = firstNonEmptyString(
    seedData.content_quality,
    snapshot.content_quality,
    row.content_quality,
  );
  const sourceUrl = firstNonEmptyString(
    seedData.source_url,
    snapshot.source_url,
    row.source_url,
    canonicalUrl,
    destinationUrl,
  );
  const reviewSummary = normalizeSeedReviewSummary(
    seedData.review_summary,
    seedData.reviewSummary,
    snapshot.review_summary,
    snapshot.reviewSummary,
    seedData.reviews_summary,
    snapshot.reviews_summary,
  );
  const brand = firstNonEmptyString(
    recall.brand,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    seedData.vendor_name,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
    snapshot.vendor_name,
    row.seed_brand,
    row.seed_vendor,
    row.brand,
    row.vendor,
  ) || undefined;
  const explicitCategory =
    normalizeExplicitBeautyCategory(recall.category) ||
    normalizeExplicitBeautyCategory(seedData.category) ||
    normalizeExplicitBeautyCategory(seedData.product?.category) ||
    normalizeExplicitBeautyCategory(snapshot.category) ||
    normalizeExplicitBeautyCategory(seedData.product_type) ||
    normalizeExplicitBeautyCategory(seedData.productType) ||
    normalizeExplicitBeautyCategory(snapshot.product_type) ||
    normalizeExplicitBeautyCategory(snapshot.productType) ||
    normalizeExplicitBeautyCategory(row.seed_category) ||
    normalizeExplicitBeautyCategory(row.seed_product_type) ||
    normalizeExplicitBeautyCategory(row.category) ||
    normalizeExplicitBeautyCategory(row.product_type);
  const ingredientTokens = collectSeedIngredientSignalTokens(seedData, row);
  const ingredientIds = collectStructuredIngredientIds(row, seedData, snapshot);
  const category = inferExternalSeedBeautyCategory({
    explicitCategory,
    title,
    description: categoryDescription,
    canonicalUrl,
    destinationUrl,
    ingredientIds,
  });
  const normalizedCategory = category || undefined;

  let variants = normalizeSeedVariants(seedData, row);
  const priceContext = {
    title,
    description: categoryDescription || description,
    category: normalizedCategory || explicitCategory || '',
    canonicalUrl,
    destinationUrl,
  };
  variants = variants.map((variant) => {
    const variantCurrency = normalizeCurrency(
      variant.currency || row.price_currency || seedData.price_currency || snapshot.price_currency,
      'USD',
    );
    const normalizedPrice = normalizeExternalSeedPrice(variant.price, {
      ...priceContext,
      currency: variantCurrency,
      title: [title, variant.title].filter(Boolean).join(' '),
      description: variant.description || description || categoryDescription,
    });
    return {
      ...variant,
      price: normalizedPrice,
      pricing: {
        current: {
          amount: normalizedPrice,
          currency: variantCurrency,
        },
      },
    };
  });
  let imageUrls = normalizeSeedImageUrls(seedData, row);
  const selectedVariant = resolveSelectedSeedVariant({
    variants,
    row,
    seedData,
    snapshot,
    destinationUrl,
    canonicalUrl,
    priceContext,
  });
  if (selectedVariant?.variant_id) {
    variants = moveVariantToFront(variants, selectedVariant.variant_id);
  }
  const primaryVariantImageUrls = collectPrimaryVariantImageUrls(variants);
  if (primaryVariantImageUrls.length > 0) {
    imageUrls = Array.from(new Set([...primaryVariantImageUrls, ...imageUrls]));
  }
  if (!imageUrls.length && variants.length) {
    imageUrls = Array.from(
      new Set(
        variants.flatMap((variant) => {
          const urls = [];
          appendImageUrls(urls, variant.image_urls);
          appendImageUrls(urls, variant.images);
          appendImageUrls(urls, variant.image_url);
          return urls;
        }),
      ),
    );
  }
  const imageUrl = imageUrls[0] || undefined;

  const currency = normalizeCurrency(
    row.price_currency || seedData.price_currency || snapshot.price_currency || variants[0]?.currency,
    'USD',
  );
  const rawAmount = row.price_amount ?? seedData.price_amount ?? snapshot.price_amount;
  let price = normalizeExternalSeedPrice(rawAmount, {
    ...priceContext,
    currency,
  });
  if (!(price > 0) && variants.length > 0) {
    const variantPrices = variants.map((variant) => normalizeAmount(variant.price)).filter((value) => value > 0);
    price = variantPrices.length ? Math.min(...variantPrices) : 0;
  }

  const availability = normalizeSeedAvailability(row.availability || seedData.availability || snapshot.availability);
  const variantStates = variants.map((variant) => (typeof variant?.in_stock === 'boolean' ? variant.in_stock : null));
  const explicitVariantStates = variantStates.filter((value) => value !== null);
  const inStock =
    explicitVariantStates.length > 0
      ? explicitVariantStates.some(Boolean)
        ? true
        : explicitVariantStates.length === variantStates.length
          ? false
          : null
      : variants.length > 0
        ? null
        : availabilityToInStock(availability);

  if (!variants.length) {
    variants = [
      {
        id: externalProductId,
        variant_id: externalProductId,
        sku_id: externalProductId,
        sku: externalProductId,
        title: 'Default',
        options: [],
        price,
        currency,
        pricing: { current: { amount: price, currency } },
        inventory_quantity: inStock === true ? 999 : inStock === false ? 0 : null,
        in_stock: inStock,
        available: typeof inStock === 'boolean' ? inStock : undefined,
        image_url: imageUrl,
        images: imageUrls,
        image_urls: imageUrls,
      },
    ];
  }

  const merchantName =
    String(seedData.merchant_display_name || brand || row.domain || 'External').trim() || 'External';
  const protection = resolveExternalSeedProtectionContract({
    row,
    seedData,
    snapshot,
    stored: recall,
    exclusionFlags: recall.exclusion_flags,
  });

  const authority = buildAuthoritativeIngredientView({
    product_id: externalProductId,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    seed_data: seedData,
    raw_ingredient_text_clean:
      seedData.raw_ingredient_text_clean ||
      snapshot.raw_ingredient_text_clean ||
      ingredientIntel.raw_ingredient_text_clean ||
      snapshotIngredientIntel.raw_ingredient_text_clean,
    inci_list:
      seedData.inci_list ||
      snapshot.inci_list ||
      ingredientIntel.inci_list ||
      snapshotIngredientIntel.inci_list,
    ingredients_inci: Array.isArray(seedData.ingredients_inci) ? seedData.ingredients_inci : undefined,
    active_ingredients: Array.isArray(seedData.active_ingredients)
      ? seedData.active_ingredients
      : Array.isArray(snapshot.active_ingredients)
        ? snapshot.active_ingredients
        : undefined,
    pdp_ingredients_raw: seedData.pdp_ingredients_raw || snapshot.pdp_ingredients_raw,
    pdp_active_ingredients_raw:
      seedData.pdp_active_ingredients_raw || snapshot.pdp_active_ingredients_raw,
    details_sections:
      Array.isArray(seedData.details_sections) && seedData.details_sections.length
        ? seedData.details_sections
        : Array.isArray(snapshot.details_sections)
          ? snapshot.details_sections
          : undefined,
    ingredient_intel: ingredientIntel,
  });
  const mergedIngredientIntel = mergeIngredientIntelWithAuthority(ingredientIntel, authority);

  return {
    id: externalProductId,
    product_id: externalProductId,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    merchant_name: merchantName,
    platform: 'external',
    platform_product_id: externalProductId,
    title,
    description,
    price,
    currency,
    image_url: imageUrl,
    images: imageUrls,
    image_urls: imageUrls,
    inventory_quantity: inStock === true ? 999 : inStock === false ? 0 : null,
    in_stock: inStock,
    availability: availability || undefined,
    product_type: normalizedCategory || 'external',
    source: 'external_seed',
    ...(seedData.parent_external_product_id ? { parent_external_product_id: String(seedData.parent_external_product_id).trim() } : {}),
    ...(seedData.source_listing_scope ? { source_listing_scope: String(seedData.source_listing_scope).trim() } : {}),
    ...(ingredientIds.length ? { ingredient_ids: ingredientIds } : {}),
    url: canonicalUrl || destinationUrl || undefined,
    canonical_url: canonicalUrl || undefined,
    destination_url: destinationUrl || undefined,
    external_seed_id: row.id ? String(row.id) : undefined,
    seed_data: seedData,
    external_seed_recall: recall,
    external_seed_quality_state: protection.quality_state,
    external_seed_suppression_flags: protection.suppression_flags,
    external_seed_quality_signals: recall.quality_signals || undefined,
    ...(options.matchSource ? { external_seed_match_source: String(options.matchSource).trim() } : {}),
    variants,
    ...(selectedVariant?.variant_id ? { selected_variant_id: selectedVariant.variant_id } : {}),
    ...(selectedVariant?.variant_id ? { default_variant_id: selectedVariant.variant_id } : {}),
    ...(selectedVariant?.title ? { variant_title: String(selectedVariant.title).trim() } : {}),
    ...(rawIngredientTextClean ? { raw_ingredient_text_clean: rawIngredientTextClean } : {}),
    ...(inciList.length ? { inci_list: inciList } : {}),
    ...(activeIngredients.length ? { active_ingredients: activeIngredients } : {}),
    ...(keyIngredients.length ? { key_ingredients: keyIngredients } : {}),
    ...(pdpDescriptionRaw ? { pdp_description_raw: pdpDescriptionRaw } : {}),
    ...(pdpDetailsSections.length ? { pdp_details_sections: pdpDetailsSections } : {}),
    ...(pdpIngredientsRaw ? { pdp_ingredients_raw: pdpIngredientsRaw } : {}),
    ...(pdpActiveIngredientsRaw ? { pdp_active_ingredients_raw: pdpActiveIngredientsRaw } : {}),
    ...(pdpHowToUseRaw ? { pdp_how_to_use_raw: pdpHowToUseRaw } : {}),
    ...(pdpFaqItems.length ? { pdp_faq_items: pdpFaqItems } : {}),
    ...(seedDescriptionOrigin ? { seed_description_origin: seedDescriptionOrigin } : {}),
    ...(sourcePageType ? { source_page_type: sourcePageType } : {}),
    ...(contentQuality ? { content_quality: contentQuality } : {}),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(reviewSummary ? { review_summary: reviewSummary } : {}),
    ...(pdpFieldCaptureStatus ? { pdp_field_capture_status: pdpFieldCaptureStatus } : {}),
    ...(Object.keys(ingredientIntel).length ? { ingredient_intel: ingredientIntel } : {}),
    ...(ingredientTokens.length ? { ingredient_tokens: ingredientTokens } : {}),
    ...(authority.items.length ? { ingredients_inci: authority.items } : {}),
    ...(authority.active_items.length ? { active_ingredients: authority.active_items } : {}),
    ...(Object.keys(mergedIngredientIntel).length ? { ingredient_intel: mergedIngredientIntel } : {}),
    ...(brand ? { vendor: brand, brand } : {}),
    ...(normalizedCategory ? { category: normalizedCategory } : {}),
  };
}

function buildExternalSeedBrandSearchProduct(row) {
  if (!row || typeof row !== 'object') return null;

  const seedData = ensureJsonObject(row.seed_data);
  const rowSeedRecall = ensureJsonObject(row.seed_recall);
  const storedSeedRecall = ensureJsonObject(seedData?.derived?.recall);
  const effectiveSeedData =
    Object.keys(storedSeedRecall).length > 0 || Object.keys(rowSeedRecall).length <= 0
      ? seedData
      : {
          ...seedData,
          derived: {
            ...ensureJsonObject(seedData?.derived),
            recall: rowSeedRecall,
          },
        };
  const snapshot = ensureJsonObject(effectiveSeedData.snapshot);
  const recall = resolveExternalSeedRecallDoc({ row, seedData: effectiveSeedData, snapshot });
  const protection = resolveExternalSeedProtectionContract({
    row,
    seedData: effectiveSeedData,
    snapshot,
    stored: recall,
    exclusionFlags: recall.exclusion_flags,
  });
  if (protection.suppression_flags?.exclude_from_recall === true) return null;
  const destinationUrl = String(
    row.destination_url || snapshot.destination_url || effectiveSeedData.destination_url || '',
  ).trim();
  const canonicalUrl = String(
    row.canonical_url || snapshot.canonical_url || effectiveSeedData.canonical_url || '',
  ).trim();
  const externalProductId =
    String(
      row.external_product_id ||
        effectiveSeedData.external_product_id ||
        effectiveSeedData.product_id ||
        snapshot.product_id ||
        '',
    ).trim() || stableExternalProductId(canonicalUrl || destinationUrl);
  if (!externalProductId) return null;

  const title =
    firstNonEmptyString(
      recall.retrieval_title,
      row.title,
      row.seed_title,
      snapshot.title,
      effectiveSeedData.title,
      canonicalUrl,
      destinationUrl,
      externalProductId,
    ) || externalProductId;
  const description = firstNonEmptyString(
    recall.retrieval_summary,
    row.seed_description,
    row.description,
    snapshot.description,
    effectiveSeedData.description,
  );
  const brand = firstNonEmptyString(
    recall.brand,
    row.seed_brand,
    row.seed_merchant_display_name,
    row.seed_vendor,
    effectiveSeedData.brand,
    snapshot.brand,
    effectiveSeedData.merchant_display_name,
    snapshot.merchant_display_name,
    effectiveSeedData.vendor,
    snapshot.vendor,
    row.brand,
    row.vendor,
  );
  const explicitCategory =
    normalizeExplicitBeautyCategory(
      recall.category,
      row.seed_category,
      row.seed_product_type,
      row.snapshot_category,
      row.snapshot_product_type,
      effectiveSeedData.category,
      effectiveSeedData.product_type,
      snapshot.category,
      snapshot.product_type,
      row.category,
      row.product_type,
    ) || null;
  const normalizedCategory = inferExternalSeedBeautyCategory({
    explicitCategory,
    title,
    description,
    canonicalUrl,
    destinationUrl,
    ingredientIds: [],
  });
  const imageUrl = firstNonEmptyString(
    row.image_url,
    snapshot.image_url,
    effectiveSeedData.image_url,
  );
  const imageUrls = imageUrl ? [imageUrl] : [];
  const price = normalizeAmount(row.price_amount ?? effectiveSeedData.price_amount ?? snapshot.price_amount);
  const currency = normalizeCurrency(
    row.price_currency || effectiveSeedData.price_currency || snapshot.price_currency,
    'USD',
  );
  const availability = normalizeSeedAvailability(
    row.availability || effectiveSeedData.availability || snapshot.availability,
  );
  const inStock = availabilityToInStock(availability);
  const merchantName =
    String(
      firstNonEmptyString(
        row.seed_merchant_display_name,
        effectiveSeedData.merchant_display_name,
        snapshot.merchant_display_name,
        brand,
        row.domain,
        'External',
      ) || 'External',
    ).trim() || 'External';
  const reviewSummary = normalizeSeedReviewSummary(
    effectiveSeedData.review_summary,
    effectiveSeedData.reviewSummary,
    snapshot.review_summary,
    snapshot.reviewSummary,
    effectiveSeedData.reviews_summary,
    snapshot.reviews_summary,
  );

  return {
    id: externalProductId,
    product_id: externalProductId,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    merchant_name: merchantName,
    platform: 'external',
    platform_product_id: externalProductId,
    title,
    ...(description ? { description } : {}),
    price,
    currency,
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(imageUrls.length ? { images: imageUrls, image_urls: imageUrls } : {}),
    inventory_quantity: inStock === true ? 999 : inStock === false ? 0 : null,
    in_stock: inStock,
    ...(availability ? { availability } : {}),
    product_type: normalizedCategory || explicitCategory || 'external',
    source: 'external_seed',
    url: canonicalUrl || destinationUrl || undefined,
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    ...(destinationUrl ? { destination_url: destinationUrl } : {}),
    ...(row.id ? { external_seed_id: String(row.id) } : {}),
    ...(reviewSummary ? { review_summary: reviewSummary } : {}),
    external_seed_recall: recall,
    external_seed_quality_state: protection.quality_state,
    external_seed_suppression_flags: protection.suppression_flags,
    ...(brand ? { vendor: brand, brand } : {}),
    ...(normalizedCategory ? { category: normalizedCategory } : {}),
  };
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  stableExternalProductId,
  ensureJsonObject,
  normalizeSeedAvailability,
  availabilityToInStock,
  inferExternalSeedBeautyCategory,
  inferExternalSeedSkincareCategory: inferExternalSeedBeautyCategory,
  collectSeedImageUrls,
  normalizeSeedImageUrls,
  normalizeSeedVariants,
  canonicalizeExternalSeedSnapshot,
  buildExternalSeedProduct,
  buildExternalSeedBrandSearchProduct,
};
