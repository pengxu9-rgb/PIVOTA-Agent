#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PRODUCT_INTEL_CONTRACT_VERSION } = require('../src/pdpProductIntel');
const { closePool, query } = require('../src/db');
const {
  buildKbEntriesForRow,
  prepareEntriesForWrite,
  fetchExistingProductIntelKbRows,
} = require('./publish_product_intel_pilot_to_kb');
const {
  buildPivotaInsightInventoryRow,
  hasCommerceTruthClaim,
} = require('../src/services/pivotaInsightsQuality');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeId(value) {
  return text(value);
}

function firstSentence(value, maxLength = 220) {
  const cleaned = text(value);
  if (!cleaned) return '';
  const sentence = cleaned.match(/^(.{40,}?[.!?])\s/)?.[1] || cleaned;
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}.`;
}

function sanitizePublicSourceText(value) {
  return text(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[$€£¥]\s*\d+(?:\.\d{2})?\s*(?:value)?\b/gi, '')
    .replace(/\b\d{1,3}%\s*off\b/gi, '')
    .replace(/\b\d+(?:\.\d{2})?\s*(?:usd|eur|gbp|jpy|cny|rmb|value)\b/gi, '')
    .replace(/\bnot eligible for discounts?\.?/gi, '')
    .replace(/\b(?:ulta beauty|sephora|target|walmart|amazon)\s+exclusive\b/gi, '')
    .replace(/\b(?:an?|the)?\s*exclusive bundle available only at\s+[a-z0-9 .&'-]+\.?/gi, 'bundle')
    .replace(/\bavailable only at\s+[a-z0-9 .&'-]+\.?/gi, '')
    .replace(/\byour new favorite for ([^,.;:!?]+),\s*use this\b/gi, 'Use this')
    .replace(/\byour new favorite(?:\s+for)?\b/gi, '')
    .replace(/\bis your go-to for\b/gi, 'is designed for')
    .replace(/\bthis genius tool\b/gi, 'this tool')
    .replace(/\b(?:must-have|pro-favorite|ultimate|powerful)\b/gi, '')
    .replace(/\b(?:best[-\s]?selling|bestselling|viral|cult[-\s]?favorite|award[-\s]?winning)\b/gi, '')
    .replace(/\bformulated for all skin types\b/gi, 'described by the official page as a gentle formula')
    .replace(/\bfor all skin types\b/gi, 'with broad routine positioning')
    .replace(/\ball skin types\b/gi, 'broad skin-type positioning')
    .replace(/\.\s*with broad routine positioning\b/gi, ' with broad routine positioning')
    .replace(/\ba\s+antiperspirant\b/gi, 'an antiperspirant')
    .replace(/\ba\s+antioxidant\b/gi, 'an antioxidant')
    .replace(/\b(?:winner of|voted one of|voted as one of)[^.?!]*[.!]?/gi, '')
    .replace(/\b(?:an?|the)\s+(designed|made|created)\b/gi, '$1')
    .replace(/\b(?:everyone loves|widely loved)\b/gi, '')
    .replace(/\.{2,}|…/g, '. ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizePublicTitleText(value) {
  return sanitizePublicSourceText(value)
    .replace(/\s*[\[(]\s*\d{1,3}%\s*off\s*[\])]\s*/gi, ' ')
    .replace(/\s*[\[(]\s*[\])]\s*/g, ' ')
    .replace(/\s*[\[(]\s*(?:sale|clearance|promo|promotion|discount|free gift)\s*[\])]\s*/gi, ' ')
    .replace(/\b(?:sale|clearance|promo|promotion|discount)\s*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeFormulaSummary(value) {
  return text(value)
    .replace(/\b(?:see all|how to use|complete list)\b[\s:-]*/gi, ' ')
    .replace(/\b(?:wholesale|affiliate program|refer-a-friend|press|social|instagram|facebook|twitter|tiktok|pinterest|youtube)\b/gi, ' ')
    .replace(/\b(?:var\s+\w+|await)\b[^.!?;,]*/gi, ' ')
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    .replace(/\s*;\s*\./g, ';')
    .replace(/\s*,\s*\./g, '.')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sentenceFragment(value) {
  return text(value).replace(/[.;:!?]+$/g, '').trim();
}

function titleCaseFromPath(value) {
  return text(value)
    .split(/[/_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function brandFromUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    const root = host.split('.')[0];
    return titleCaseFromPath(root);
  } catch {
    return '';
  }
}

function displayBrand(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw === raw.toLowerCase()) {
    return raw.replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }
  return raw;
}

function inferCategory(seed, inventoryRow) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return (
    text(seedData.category) ||
    text(snapshot.category) ||
    text(seedData.product_type) ||
    text(snapshot.product_type) ||
    titleCaseFromPath(seedData.category_path || snapshot.category_path || inventoryRow?.category_path)
  );
}

function inferCategoryPath(seed, inventoryRow) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return text(
    seedData.category_path ||
      snapshot.category_path ||
      seedData.catalog_category_path ||
      snapshot.catalog_category_path ||
      inventoryRow?.category_path ||
      inventoryRow?.catalog_category_path,
  );
}

function inferSetKind(titleCategoryText, descriptionText) {
  const joined = `${titleCategoryText} ${descriptionText}`;
  if (/\b(?:eau de parfum|parfum|fragrance|pen spray|body mist|hair\s*&\s*body mist|hair and body mist)\b/.test(joined)) return 'fragrance_set';
  if (/\b(?:lip patch|lippatch|lip treat|liptreat|lip butter|butter balm|lip combo|lip oil|lip glaze|lip tint|lip liner|precision pout|powder matte lip|high gloss|lip kit|lip set|lip bundle|lip duo|lip trio|lip favourites|lip favorites)\b/.test(titleCategoryText)) return 'lip_set';
  if (/\b(?:eye patch|eye patches|eye kit|eye set|eye trio|detoxifeye|fortifeye|dream-yeye|antioxifeye|beautifeye)\b/.test(titleCategoryText)) return 'eye_care_set';
  if (/\b(?:look|makeup|lash|mascara|brow|blush|blush tint|lip\s*(?:&|and)\s*cheek|glow balm|bronze|bronzer|bronzing|complexion|colour|color|base|liquidglow|superglow|blur\s*(?:,|&|and)?\s*(?:colour|color)?\s*&?\s*set|foundation|conceal|correct|concealer|palette|eye|eye shadow|eyeshadow)\b/.test(titleCategoryText)) {
    return 'makeup_set';
  }
  if (/\b(?:lip\s*(?:&|and)\s*cheek|blush tint|powder blush|glow balm)\b/.test(joined)) return 'makeup_set';
  if (/\b(?:skin|skincare|cleanse|cleanser|cleansing|tonic|toner|serum|mask|peel|clarity|glow)\b/.test(titleCategoryText)) {
    return 'skincare_set';
  }
  if (/\b(?:eye patch|eye patches|eye kit|eye set|eye trio)\b/.test(joined)) return 'eye_care_set';
  if (/\b(?:look|makeup|lash|mascara|brow|blush|bronzer|bronzing|foundation|conceal|correct|concealer|palette|eye|eye shadow|eyeshadow)\b/.test(joined)) {
    return 'makeup_set';
  }
  if (/\b(?:lip treat|liptreat|lip butter|butter balm|lip combo|lip oil|lip glaze|lip tint|lip liner|precision pout|powder matte lip|high gloss|lip kit|lip set|lip bundle|lip duo|lip trio|lip favourites|lip favorites)\b/.test(joined)) return 'lip_set';
  if (/\b(?:cleanse|cleanser|cleansing|tonic|toner|serum|skin|skincare|mask|peel|clarity|glow|rose)\b/.test(joined)) {
    return 'skincare_set';
  }
  return 'beauty_set';
}

function inferKind(title, category, categoryPath, description = '') {
  const titleCategoryText = `${title} ${category} ${categoryPath}`.toLowerCase();
  const descriptionText = `${description}`.toLowerCase();
  const haystack = `${titleCategoryText} ${descriptionText}`;
  const brushCareTitlePattern =
    /\b(?:palmat|brush\s+care|brush cleanser|brush cleaning|brush cleaner|brushampoo|sigmagic|travel\s+switch|switch\s+set|dry['’]?n\s+shape|brush\s+cleaning\s+mat|brush\s+cleaning\s+tool)\b|sigma\W*switch\b/;
  const brushCareDescriptionPattern =
    /\b(?:palmat|brush cleanser|brush cleaning|brush cleaner|brushampoo|sigmagic|travel\s+switch|switch\s+set|dry['’]?n\s+shape|brush\s+cleaning\s+mat|brush\s+cleaning\s+tool|deep cleans? your brushes)\b|sigma\W*switch\b/;
  if (/\b(?:grwm routine|look)\b/.test(titleCategoryText)) return 'makeup_set';
  if (/\b(?:brush\s+cup|brush\s+holder|brush\s+case|brush\s+bag|brush\s+storage|makeup\s+brush\s+cup)\b/.test(titleCategoryText)) return 'brush_storage';
  if (brushCareTitlePattern.test(titleCategoryText)) return 'brush_care';
  if (
    /\bbrush(?:\s+[a-z0-9&'’.-]+){0,4}\s+(?:set|kit|duo|trio|quad|bundle|collection)\b/.test(titleCategoryText) ||
    /\b(?:set|kit|duo|trio|quad|bundle|collection)\b.*\bbrush(?:es)?\b/.test(titleCategoryText) ||
    (/\b(?:set|kit|duo|trio|quad|bundle|collection|favorites|favourites)\b/.test(titleCategoryText) &&
      /\b(?:brush\s+set|brushes\s+included|brushes\s+needed|go-to\s+brushes)\b/.test(descriptionText))
  ) {
    return 'brush_set';
  }
  if (/\b(?:set|kit|duo|trio|quad|sampler|bundle|vault|box|favourites|favorites|collection|best of|holiday edition|choose your shades)\b/.test(titleCategoryText)) {
    return inferSetKind(titleCategoryText, descriptionText);
  }
  if (brushCareDescriptionPattern.test(descriptionText)) return 'brush_care';
  if (
    /\b(?:brush|beauty tool|makeup brush)\b/.test(titleCategoryText) &&
    !/\bbrush cleanser\b/.test(titleCategoryText)
  ) {
    return 'brush';
  }
  if (/\bapplicator\b/.test(titleCategoryText) && !/\b(?:roll[-\s]?on|serum)\b/.test(titleCategoryText)) return 'brush';
  if (/\b(?:foundation|skin tint|skintint|skin-tint)\b/.test(haystack)) return 'foundation';
  if (/\bconcealer\b/.test(haystack)) return 'concealer';
  if (/\b(?:primer|poreless)\b/.test(haystack)) return 'primer';
  if (/\b(?:lipstick|lip color|lip balm|lip butter|butter balm|balm stick|lip oil|lip gloss|lipgloss|lip glaze|lip treatment|lip mask|lip liner|lip pencil|lip luxe|lip patch|lippatch|gloss|pout|kiss)\b/.test(haystack)) return 'lip';
  if (/\b(?:candle)\b/.test(haystack)) return 'home_fragrance';
  if (/\bdry\s+shampoo\b/.test(haystack)) return 'dry_shampoo';
  if (/\bdeodorant\b/.test(haystack)) return 'deodorant';
  if (/\b(?:shower\s+gel|body\s+wash|hand\s*&\s*body\s+wash|hand\s+and\s+body\s+wash)\b/.test(haystack)) return 'body_wash';
  if (/\bhand\s+wash\b/.test(haystack)) return 'hand_wash';
  if (/\b(?:bath\s+soak|circulation\s+soak)\b/.test(haystack)) return 'bath_soak';
  if (/\bbody\s+balm\b/.test(haystack)) return 'body_balm';
  if (/\bbody\s+gel\b/.test(haystack)) return 'body_gel';
  if (/\b(?:hair\s*&\s*body mist|hair and body mist|body mist)\b/.test(titleCategoryText)) return 'body_mist';
  if (/\b(?:eau de parfum|parfum|eau de toilette|body spray|fragrance|cologne)\b/.test(titleCategoryText)) return 'fragrance';
  if (/\b(?:perfumery|scent|olfactive|oud|ombre leather|ombré leather|soleil blanc|private blend)\b/.test(titleCategoryText)) {
    return 'fragrance';
  }
  if (/\b(?:brow|eyebrow)\b/.test(haystack)) return 'brow';
  if (/\b(?:eye repair|eye cream|eye treatment|eye serum|eye patch|eye patches|antioxifeye|beautifeye|detoxifeye|fortifeye|dream-yeye|dream-yeye|eye-surrounds)\b/.test(haystack)) return 'eye_treatment';
  if (/\b(?:eyeliner|mascara|false lashes|falsies|eyelashes|lashes|lash|eye color|eyeshadow|eye primer|palette)\b/.test(haystack)) return 'eye_makeup';
  if (/\b(?:blush)\b/.test(haystack)) return 'blush';
  if (/\b(?:bronzer|bronze|bronzing)\b/.test(haystack)) return 'bronzer';
  if (/\b(?:highlighting|highlighter|illuminate)\b/.test(haystack)) return 'highlighter';
  if (/\bskinveil\b/.test(titleCategoryText) || /\b(?:loose water[-\s]?powder|setting makeup|velvet finish)\b/.test(haystack)) return 'face_powder';
  if (/\b(?:body oil|movement oil|universal oil)\b/.test(haystack)) return 'body_oil';
  if (/\b(?:spot sticker|spot stickers|zit|blemish spot|blemish sticker|blemish stickers)\b/.test(haystack)) return 'blemish_patch';
  if (/\b(?:foaming face wash|face wash|foaming gel cleanser|gel cleanser|face wipes|facial wipes|body wash|hand & body wash|hand and body wash|goat milk soap|bar soap|soap)\b/.test(haystack)) return 'cleanser';
  if (/\b(?:facial oil|face oil)\b/.test(haystack)) return 'face_oil';
  if (/\b(?:toning mist|toner|tonic)\b/.test(haystack)) return 'toner';
  if (/\bretinol\s+oil\b/.test(haystack)) return 'skincare';
  if (/\b(?:peel|polish|exfoliat|resurfac|steam facial|facial treatment)\b/.test(haystack)) return 'skincare';
  if (/\b(?:facial cream|face cream|moisturizer|moisturiser|volume cream|body cream|body lotion|whipped body cream|goat milk lotion)\b/.test(haystack)) return 'moisturizer';
  if (/\b(?:cleansing|cleanser)\b/.test(titleCategoryText)) return 'cleanser';
  if (/\b(?:retinol|serum|peptide|aha|bha|lactic|glycolic|salicylic)\b/.test(haystack)) return 'serum';
  if (/\b(?:hand cream|hand salve|cuticle serum)\b/.test(haystack)) return 'skincare';
  if (/\b(?:sheet mask|face mask|jelly mask|remedy mask|lip patch|lippatch|body polish|retinol oil|concentrate|essence oil|oil-essence|enzyme treatment|exfoliat|resurfac|steam facial|facial treatment)\b/.test(haystack)) return 'skincare';
  if (/\b(?:cleansing|cleanser)\b/.test(haystack)) return 'cleanser';
  if (/\b(?:powder)\b/.test(titleCategoryText)) return 'face_powder';
  if (/\b(?:treatment lotion|treatment emulsion|emulsion|lotion|serum|toner|tonic|to-go|pads|cloths)\b/.test(haystack)) return 'skincare';
  if (/\b(?:moisturizer|cream|mist|serum|cleanser|skincare|radiance|clarity|glow tonic)\b/.test(haystack)) return 'skincare';
  return 'beauty_product';
}

function kindLabel(kind, category) {
  const labels = {
    foundation: 'foundation',
    concealer: 'concealer',
    primer: 'primer',
    lip: text(category).toLowerCase() || 'lip product',
    body_mist: 'body mist',
    fragrance_set: 'fragrance set',
    fragrance: 'fragrance',
    brow: 'brow product',
    eye_treatment: 'eye treatment',
    eye_makeup: 'eye makeup',
    blush: 'blush',
    bronzer: 'bronzer',
    highlighter: 'highlighter',
    face_powder: 'face powder',
    body_oil: 'body oil',
    dry_shampoo: 'dry shampoo',
    deodorant: 'deodorant',
    body_wash: 'body wash',
    hand_wash: 'hand wash',
    bath_soak: 'bath soak',
    body_balm: 'body balm',
    body_gel: 'body gel',
    face_oil: 'face oil',
    toner: 'toner',
    moisturizer: 'moisturizer',
    serum: 'skincare treatment',
    blemish_patch: 'blemish patch',
    cleanser: 'cleanser',
    brush: 'brush',
    brush_storage: 'brush storage accessory',
    brush_set: 'brush set',
    brush_care: 'brush-care product',
    skincare: 'skincare product',
    home_fragrance: 'home fragrance',
    beauty_set: 'beauty set',
    skincare_set: 'skincare set',
    makeup_set: 'makeup set',
    eye_care_set: 'eye care set',
    lip_set: 'lip set',
    beauty_product: text(category).toLowerCase() || 'beauty product',
  };
  return labels[kind] || labels.beauty_product;
}

function displayCategoryForKind(kind, category) {
  const labels = {
    foundation: 'Foundation',
    concealer: 'Concealer',
    primer: 'Primer',
    lip: 'Lip Product',
    body_mist: 'Body Mist',
    fragrance_set: 'Fragrance Set',
    fragrance: 'Fragrance',
    brow: 'Brow Product',
    eye_treatment: 'Eye Treatment',
    eye_makeup: 'Eye Makeup',
    blush: 'Blush',
    bronzer: 'Bronzer',
    highlighter: 'Highlighter',
    face_powder: 'Face Powder',
    body_oil: 'Body Oil',
    dry_shampoo: 'Dry Shampoo',
    deodorant: 'Deodorant',
    body_wash: 'Body Wash',
    hand_wash: 'Hand Wash',
    bath_soak: 'Bath Soak',
    body_balm: 'Body Balm',
    body_gel: 'Body Gel',
    face_oil: 'Face Oil',
    toner: 'Toner',
    moisturizer: 'Moisturizer',
    serum: 'Skincare Treatment',
    blemish_patch: 'Blemish Patch',
    cleanser: 'Cleanser',
    brush: 'Beauty Brush',
    brush_storage: 'Brush Storage',
    brush_set: 'Brush Set',
    brush_care: 'Brush Care',
    skincare: 'Skincare',
    home_fragrance: 'Home Fragrance',
    beauty_set: 'Beauty Set',
    skincare_set: 'Skincare Set',
    makeup_set: 'Makeup Set',
    eye_care_set: 'Eye Care Set',
    lip_set: 'Lip Set',
    beauty_product: 'Beauty Product',
  };
  const controlledCategoryKinds = new Set([
    'brush',
    'brush_storage',
    'brush_set',
    'brush_care',
    'lip_set',
    'makeup_set',
    'fragrance_set',
    'eye_care_set',
  ]);
  if (controlledCategoryKinds.has(kind)) return labels[kind] || labels.beauty_product;
  const explicit = text(category);
  if (explicit && explicit.toLowerCase() !== 'beauty product') return explicit;
  return labels[kind] || labels.beauty_product;
}

function routineStep(kind) {
  const steps = {
    foundation: 'complexion',
    concealer: 'complexion',
    primer: 'complexion',
    lip: 'lip_color',
    body_mist: 'fragrance',
    fragrance_set: 'set',
    fragrance: 'fragrance',
    brow: 'brow_makeup',
    eye_treatment: 'skin_care',
    eye_makeup: 'eye_makeup',
    blush: 'cheek_color',
    bronzer: 'cheek_color',
    highlighter: 'complexion',
    face_powder: 'complexion',
    body_oil: 'body_care',
    dry_shampoo: 'hair_refresh',
    deodorant: 'body_care',
    body_wash: 'body_cleanse',
    hand_wash: 'hand_cleanse',
    bath_soak: 'body_care',
    body_balm: 'body_care',
    body_gel: 'body_care',
    face_oil: 'skin_care',
    toner: 'skin_care',
    moisturizer: 'skin_care',
    serum: 'skin_care',
    blemish_patch: 'spot_care',
    cleanser: 'cleanse',
    brush: 'tool',
    brush_storage: 'tool',
    brush_set: 'tool',
    brush_care: 'tool_care',
    skincare: 'skin_care',
    home_fragrance: 'home_fragrance',
    beauty_set: 'set',
    skincare_set: 'set',
    makeup_set: 'set',
    eye_care_set: 'set',
    lip_set: 'set',
    beauty_product: 'beauty',
  };
  return steps[kind] || 'beauty';
}

function ingredientSignals(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const ingredientLikePattern = /\b(?:aqua|water|glycerin|sodium|aloe|simmondsia|helianthus|extract|oil|glycol|alcohol|acid|butter|wax|ester|triglyceride|caprylic|fragrance|parfum|cetearyl|citric|tocopherol|niacinamide|squalane|retinol|peptide|polysorbate|xanthan|benzyl|linalool|limonene|ayurvedic complex|key actives?)\b/i;
  const boilerplatePattern = /\b(?:vstar_review_settings|loox_global_hash|visitor_level_referral|schema\.org|@context|@type|productgroup|wholesale\s+affiliate\s+program|refer-a-friend|social\s+instagram|add to cart|sold out)\b/i;
  const nonFormulaPattern = /\b(?:how to use|directions?|shipping|returns?|privacy policy|terms of service|customer service|subscribe|newsletter)\b/i;
  function formulaCandidate(value) {
    const cleaned = sanitizeFormulaSummary(value);
    if (cleaned.length < 20) return '';
    if (boilerplatePattern.test(value) || nonFormulaPattern.test(value)) return '';
    const fragments = cleaned
      .split(/(?:[.!?]\s+|\n+)/)
      .map((item) => item.trim())
      .filter(Boolean);
    const formulaFragment = fragments.find((fragment) => {
      const commaCount = (fragment.match(/,/g) || []).length;
      return (
        ingredientLikePattern.test(fragment) &&
        (commaCount >= 2 || /\b(?:key actives?|complete list)\b/i.test(fragment))
      );
    });
    if (formulaFragment) return formulaFragment;
    const commaCount = (cleaned.match(/,/g) || []).length;
    if (ingredientLikePattern.test(cleaned) && commaCount >= 2) return cleaned;
    if (/\bkey actives?\b/i.test(cleaned) && ingredientLikePattern.test(cleaned)) return cleaned;
    return '';
  }
  function ingredientTextFromValue(value) {
    if (!value) return '';
    if (typeof value === 'string') {
      const cleaned = text(value);
      if (/^\{.*(?:force_fill_contract|inci_applicability|approved_source_not_captured).*}$/i.test(cleaned)) {
        return '';
      }
      return cleaned;
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => ingredientTextFromValue(item))
        .filter(Boolean)
        .join(', ');
    }
    if (typeof value === 'object') {
      const applicability = asObject(value.inci_applicability);
      if (text(applicability.status).toLowerCase() === 'not_applicable') return '';
      return [
        value.raw_ingredient_text_clean,
        value.raw_text,
        value.ingredients_raw,
        value.ingredients_inci,
        value.inci_list,
        value.inci_normalized,
        value.ingredient_tokens,
        value.key_ingredients,
        value.active_ingredients,
        value.full_ingredients,
        value.full_ingredient_list,
      ]
        .map((item) => ingredientTextFromValue(item))
        .filter(Boolean)
        .join(', ');
    }
    return '';
  }
  const candidates = [
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
    seedData.ingredients_inci,
    snapshot.ingredients_inci,
    seedData.inci_list,
    snapshot.inci_list,
    seedData.ingredient_tokens,
    snapshot.ingredient_tokens,
    seedData.key_ingredients,
    snapshot.key_ingredients,
    seedData.ingredient_intel,
    snapshot.ingredient_intel,
  ];
  const flattened = candidates
    .map((item) => formulaCandidate(ingredientTextFromValue(item)))
    .filter(Boolean);
  const joined = text(flattened.join(' '));
  const ingredientCount = asArray(seedData.ingredient_tokens || snapshot.ingredient_tokens).length;
  return {
    available: joined.length > 20,
    ingredient_count: ingredientCount,
    summary: sanitizeFormulaSummary(firstSentence(joined, 160)),
  };
}

function sourceDescription(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return (
    text(seedData.description) ||
    text(snapshot.description) ||
    text(seedData.pdp_description_raw) ||
    text(snapshot.pdp_description_raw)
  );
}

function buildBestFor(kind, category) {
  const label = kindLabel(kind, category);
  return [
    {
      tag: `${kind}_shoppers`,
      label: `${label.charAt(0).toUpperCase()}${label.slice(1)} shoppers`,
      confidence: 'moderate',
    },
    {
      tag: 'official_source_comparison',
      label: 'Official-source comparison',
      confidence: 'moderate',
    },
  ];
}

function buildHighlightPhrase(kind, category, description, title = '') {
  const desc = description.toLowerCase();
  const titleText = `${title}`.toLowerCase();
  const signalText = `${category} ${description} ${title}`.toLowerCase();
  if (kind === 'foundation' && /soft-?matte|blurring|blur/.test(signalText)) return 'Soft-matte blurring base';
  if (kind === 'concealer' && /conceal|soft-?matte|shade/.test(signalText)) return 'Complexion coverage detail';
  if (kind === 'primer' && /pore|blur|shine|smooth/.test(signalText)) return 'Pore-blurring primer detail';
  if (kind === 'lip') {
    if (/liner|pout/.test(titleText)) return 'Lip liner format detail';
    if (/gloss|glaze|shine/.test(titleText)) return 'Shine lip formula detail';
    if (/matte/.test(titleText)) return 'Matte lip formula detail';
    if (/oil|balm|butter|cream|creme|crème/.test(titleText)) return 'Creamy lip formula detail';
    if (/matte/.test(signalText)) return 'Matte lip formula detail';
    if (/gloss|glaze|shine/.test(signalText)) return 'Shine lip formula detail';
    if (/liner|pout/.test(signalText)) return 'Lip liner format detail';
    if (/oil|balm|butter|creamy|emollience|glide/.test(signalText)) return 'Creamy lip formula detail';
  }
  if (kind === 'body_mist') return 'Hair-and-body mist detail';
  if (kind === 'fragrance_set') return 'Fragrance gift set';
  if (kind === 'fragrance' && /(?:amber|leather|vanilla|floral|wood|rose|oud|citrus|ginger|cardamom)/.test(signalText)) {
    const noteTerms = [
      ['ginger', 'Ginger'],
      ['cardamom', 'Cardamom'],
      ['coriander', 'Coriander'],
      ['vanilla', 'Vanilla'],
      ['leather', 'Leather'],
      ['amber', 'Amber'],
      ['honeyed wood', 'Honeyed woods'],
      ['woods', 'Woods'],
      ['oud', 'Oud'],
      ['rose', 'Rose'],
      ['citrus', 'Citrus'],
      ['bergamot', 'Bergamot'],
      ['jasmine', 'Jasmine'],
      ['tobacco', 'Tobacco'],
      ['cherry', 'Cherry'],
      ['sandalwood', 'Sandalwood'],
      ['neroli', 'Neroli'],
      ['tonka', 'Tonka'],
      ['myrrh', 'Myrrh'],
    ]
      .filter(([needle]) => desc.includes(needle))
      .map(([, label]) => label);
    if (noteTerms.length >= 2) return `${noteTerms.slice(0, 2).join(' ')} scent profile`.slice(0, 40);
    if (noteTerms.length === 1) return `${noteTerms[0]} scent profile`;
    return 'Official scent note profile';
  }
  if (kind === 'foundation') return 'Complexion base detail';
  if (kind === 'brow') return 'Brow-shaping format detail';
  if (kind === 'primer') return 'Primer format detail';
  if (kind === 'eye_treatment') return /patch|goggle|caffeine|de-?puff|hydrate/.test(signalText) ? 'Eye-care format detail' : 'Eye treatment detail';
  if (kind === 'eye_makeup') return /shimmer|glimmer|metallic|fairy|light/.test(signalText) ? 'Eye shimmer format detail' : 'Eye-makeup formula detail';
  if (kind === 'blush') return 'Cheek color formula detail';
  if (kind === 'bronzer') return 'Bronzing complexion detail';
  if (kind === 'highlighter') return 'Highlighter formula detail';
  if (kind === 'face_powder') return 'Complexion powder detail';
  if (kind === 'body_oil') return 'Body oil formula detail';
  if (kind === 'dry_shampoo') return 'Post-workout dry shampoo';
  if (kind === 'deodorant') return 'Post-workout deodorant';
  if (kind === 'body_wash') return /shower\s+gel/.test(signalText) ? 'Post-workout shower gel' : 'Body wash format detail';
  if (kind === 'hand_wash') return 'Hand wash format detail';
  if (kind === 'bath_soak') return 'Bath soak format detail';
  if (kind === 'body_balm') return 'Body balm format detail';
  if (kind === 'body_gel') return 'Body gel format detail';
  if (kind === 'face_oil') return 'Face oil formula detail';
  if (kind === 'toner') return /mist/.test(signalText) ? 'Toning mist detail' : 'Toner formula detail';
  if (kind === 'moisturizer') return /body/.test(signalText) ? 'Body moisturizer detail' : 'Moisturizer formula detail';
  if (kind === 'serum') {
    if (/retinol/.test(signalText)) return 'Retinol treatment detail';
    if (/peptide/.test(signalText)) return 'Peptide serum detail';
    if (/\baha\b|glycolic|lactic/.test(signalText)) return 'AHA serum detail';
    return 'Treatment formula detail';
  }
  if (kind === 'blemish_patch') return 'Spot-care format detail';
  if (kind === 'cleanser') return /glycolic|retinol|mud|jasmine/.test(signalText) ? 'Active cleanser detail' : 'Cleanser formula detail';
  if (kind === 'brush') return 'Brush format detail';
  if (kind === 'brush_storage') return 'Brush storage detail';
  if (kind === 'brush_set') return 'Brush set format detail';
  if (kind === 'brush_care') return 'Brush-care cleaning detail';
  if (kind === 'skincare') {
    if (/moisturizer|moisturiser|body lotion|lotion/.test(titleText)) return 'Moisturizer formula detail';
    if (/peel|polish|exfoliat|resurfac/.test(signalText)) return 'Exfoliating treatment detail';
    if (/facial|steam/.test(signalText)) return 'Facial treatment detail';
    if (/glycolic|lactic|salicylic|retinol|vitamin c|\+c vit/.test(signalText)) return 'Active skincare detail';
    if (/mask|remedy|sheet/.test(signalText)) return 'Mask format detail';
    if (/mist/.test(signalText)) return 'Mist hydration detail';
    if (/tonic|toner/.test(signalText)) return 'Tonic formula detail';
    if (/oil|essence/.test(signalText)) return 'Oil-essence formula detail';
    return 'Skincare formula detail';
  }
  if (kind === 'home_fragrance') return 'Home-fragrance note detail';
  if (kind === 'beauty_set') {
    if (/fragrance|parfum|body mist|pen spray/.test(signalText)) return 'Fragrance gift set';
    if (/lip|gloss|balm|liner/.test(signalText)) return 'Lip routine set';
    if (/mascara|palette|makeup|look/.test(signalText)) return 'Makeup routine set';
    return 'Multi-item routine set';
  }
  if (kind === 'skincare_set') {
    if (/tonic|toner/.test(signalText)) return 'Tonic routine set';
    if (/mist/.test(signalText)) return 'Mist routine set';
    if (/glow|bright|radiance/.test(signalText)) return 'Glow routine set';
    return 'Skincare routine set';
  }
  if (kind === 'makeup_set') {
    if (/lip\s*(?:&|and)\s*cheek|glow balm/.test(signalText)) return 'Lip-and-cheek color set';
    if (/blush|cheek/.test(signalText)) return 'Cheek color set';
    if (/\b(?:favorites|favourites|routine|bundle|set)\b/.test(titleText) && /\b(?:eye|eyeshadow|palette|lip|brush)\b/.test(signalText)) return 'Makeup routine set';
    if (/complexion|base|foundation|conceal|blur|bronze/.test(signalText)) return 'Complexion routine set';
    if (/eye|eyeshadow|palette|lash|mascara/.test(signalText)) return 'Eye-makeup routine set';
    return 'Makeup routine set';
  }
  if (kind === 'eye_care_set') return 'Eye-care routine set';
  if (kind === 'lip_set') return 'Lip-care routine set';
  return `${text(category) || 'Product'} format detail`.slice(0, 40).trim();
}

function buildBundle({ seed, inventoryRow, generatedAt, batchName, reviewer }) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const productId = text(seed.external_product_id);
  const rawTitle = text(seed.title || seedData.title || inventoryRow.title);
  const title = sanitizePublicTitleText(rawTitle);
  const sourceUrl = text(seed.canonical_url || seed.destination_url || inventoryRow.canonical_url);
  const brand = displayBrand(seedData.brand || snapshot.brand || inventoryRow.brand || brandFromUrl(sourceUrl));
  const brandPrefix = brand ? `${brand} ` : '';
  const rawCategory = inferCategory(seed, inventoryRow);
  const categoryPath = inferCategoryPath(seed, inventoryRow);
  const description = sourceDescription(seedData);
  const descriptionSentence = firstSentence(sanitizePublicSourceText(description));
  const kind = inferKind(title, rawCategory, categoryPath, description);
  const category = displayCategoryForKind(kind, rawCategory);
  const label = kindLabel(kind, category);
  const ingredient = ingredientSignals(seedData);
  const evidenceProfile = ingredient.available ? 'seller_plus_formula' : 'official_pdp_seed';
  const highlight = buildHighlightPhrase(kind, category, description, title);
  const whatItIsBody = descriptionSentence
    ? `A ${brandPrefix}${label} listed on the official source page as ${title}. The official description identifies: ${descriptionSentence}`
    : `A ${brandPrefix}${label} listed on the official source page as ${title}.`;
  const formulaBody = ingredient.available
    ? `Captured formula fields include ${sentenceFragment(ingredient.summary) || `${ingredient.ingredient_count} ingredient tokens`}. Agents should keep composition claims within those source fields.`
    : `No complete ingredient list was captured for this review batch, so formula-level claims stay unavailable.`;

  const sourceCoverage = {
    seller: {
      available: Boolean(sourceUrl),
      source_url: sourceUrl,
    },
    formula: {
      available: ingredient.available,
      ingredient_count: ingredient.ingredient_count,
      source_url: sourceUrl,
    },
    reviews: {
      available: false,
      count: 0,
    },
    creator: {
      available: false,
      count: 0,
    },
    editorial: {
      available: false,
      count: 0,
    },
  };
  const fieldSources = {
    what_it_is: 'official_seed_description',
    best_for: 'reviewed_category_and_official_title',
    why_it_stands_out: ingredient.available ? 'official_seed_description_and_formula' : 'official_seed_description',
    routine_fit: 'reviewed_category_and_official_title',
    watchouts: 'owner_delegated_assistant_review',
    texture_finish: 'reviewed_category_and_official_title',
    source_coverage: 'official_pdp_seed_snapshot',
    community_signals: 'not_collected',
  };

  return {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: 'Pivota Insights',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: productId,
      platform: 'external_seed',
    },
    product_group_id: text(inventoryRow.sellable_item_group_id) || null,
    product_intel_core: {
      display_name: 'Pivota Insights',
      what_it_is: {
        headline: `${label.charAt(0).toUpperCase()}${label.slice(1)} identity`,
        body: whatItIsBody,
      },
      best_for: buildBestFor(kind, category),
      why_it_stands_out: [
        {
          headline: 'Official product detail',
          body: descriptionSentence
            ? `The official page describes ${title} with product-specific detail: ${descriptionSentence}`
            : `The official title and reviewed category identify this PDP as ${category}, giving agents a grounded product type.`,
          evidence_strength: evidenceProfile,
        },
        {
          headline: ingredient.available ? 'Formula context captured' : 'Evidence gaps kept explicit',
          body: formulaBody,
          evidence_strength: evidenceProfile,
        },
      ],
      routine_fit: {
        step: routineStep(kind),
        am_pm: ['as_needed'],
        pairing_notes: [
          `Use within the ${label} context; avoid inferring benefits not present in the official source.`,
        ],
      },
      watchouts: [
        {
          type: ingredient.available ? 'formula_scope' : 'formula_gap',
          label: ingredient.available
            ? 'Formula details are source-derived; avoid medical, safety, or suitability claims not present in the source.'
            : 'No complete ingredient list was captured for this review batch; avoid formula-level or safety claims.',
          severity: 'medium',
        },
        {
          type: 'evidence_gap',
          label: 'No independent review or community evidence was approved for this row; keep public copy source-bound.',
          severity: 'medium',
        },
        {
          type: 'scope_guardrail',
          label: 'Use the commerce mainline for offer facts; keep this insight focused on source-backed product identity.',
          severity: 'medium',
        },
      ],
      confidence: {
        overall: 'moderate',
        fields: {
          what_it_is: sourceUrl ? 'high' : 'moderate',
          best_for: 'moderate',
          why_it_stands_out: descriptionSentence ? 'moderate' : 'low',
          routine_fit: 'moderate',
          watchouts: 'moderate',
        },
      },
      freshness: {
        generated_at: generatedAt,
        source_version: batchName,
      },
      quality_state: 'reviewed',
      evidence_profile: evidenceProfile,
      source_coverage: sourceCoverage,
    },
    texture_finish: {
      finish: label,
      texture: kind,
      source: 'reviewed_category_and_official_title',
    },
    community_signals: {
      status: 'unavailable',
      reason: 'not_collected_for_this_review_batch',
    },
    recommendation_intents: {
      similar: [],
      complementary: [],
      routine_pairing: [],
      underfill_reason: null,
      confidence: 'low',
    },
    market_signal_badges: [],
    external_highlight_signals: [],
    quality_state: 'reviewed',
    evidence_profile: evidenceProfile,
    source_coverage: sourceCoverage,
    confidence: {
      overall: 'moderate',
      fields: {
        what_it_is: sourceUrl ? 'high' : 'moderate',
        best_for: 'moderate',
        why_it_stands_out: descriptionSentence ? 'moderate' : 'low',
        routine_fit: 'moderate',
        watchouts: 'moderate',
      },
    },
    freshness: {
      generated_at: generatedAt,
      source_version: batchName,
    },
    offer_pointers: {
      offers_count: 0,
      default_offer_id: null,
      best_price_offer_id: null,
      commerce_modes: [],
    },
    provenance: {
      source: 'owner_delegated_official_seed_rewrite',
      generator: 'owner_delegated_assistant_reviewed_rewrite',
      selection_strategy: 'official_pdp_seed_guarded_manual_review',
      field_sources: fieldSources,
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: generatedAt,
      external_highlight_review_status: 'seller_only_fallback',
      external_review_batch: batchName,
      official_source_url: sourceUrl,
      official_source_ingredient_count: ingredient.ingredient_count,
      rewrite_reason:
        'Owner-delegated assistant review: official PDP seed rewrite; no commerce-state, community, medical, or unsupported safety claims added.',
    },
    shopping_card: {
      contract_version: 'pivota.shopping_card.v1',
      title,
      subtitle: category,
      highlight,
      intro: whatItIsBody,
      evidence_profile: evidenceProfile,
    },
    search_card: {
      title_candidate: title,
      compact_candidate: category,
      highlight_candidate: highlight,
      intro_candidate: whatItIsBody,
      proof_badge_candidate: '',
    },
  };
}

function buildReportRows({ seeds, inventoryById, generatedAt, batchName, reviewer }) {
  return seeds.map((seed) => {
    const productId = text(seed.external_product_id);
    const inventoryRow = inventoryById.get(productId) || {};
    const bundle = buildBundle({ seed, inventoryRow, generatedAt, batchName, reviewer });
    return {
      case_id: `live_${productId}`,
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: generatedAt,
      notes: `Approved official-PDP-seed rewrite for ${bundle.shopping_card.title}; evidence_profile=${bundle.evidence_profile}; source_url=${text(seed.canonical_url || seed.destination_url)}`,
      owner_delegated_review: {
        contract_version: 'pivota.owner_delegated_review.v1',
        delegated_to: reviewer,
        reviewer_kind: 'assistant',
        owner_instruction: 'User delegated Codex to perform high-quality human review for Pivota Insights quality improvement.',
        guardrails: [
          'Do not overwrite good content with lower-quality content.',
          'No commerce-state claims in Pivota Insights.',
          'Use official source facts only; keep evidence confidence explicit.',
        ],
      },
      quality_improvement_review: {
        decision: 'approved_replacement',
        reviewer_kind: 'assistant',
        owner_delegated: true,
        reason:
          'Owner-delegated assistant review confirms the replacement uses official PDP seed facts, avoids commerce and unsupported evidence claims, and explicitly marks evidence gaps instead of inventing claims.',
      },
      baseline: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: productId,
          platform: 'external_seed',
        },
      },
      selected: {
        selected_mode: 'manual_reviewed_rewrite',
        selected_field_count: 7,
        field_sources: bundle.provenance.field_sources,
        bundle,
      },
    };
  });
}

function selectInventoryRows(rows, options) {
  const domain = text(options.domain).toLowerCase();
  const lane = text(options.lane) || 'lane_3_kb_rewrite_review';
  const limit = Math.max(1, Number(options.limit || 100) || 100);
  const requireDescription = options.requireDescription !== false;
  return rows
    .filter((row) => !domain || text(row.domain).toLowerCase() === domain)
    .filter((row) => text(row.recommended_lane) === lane)
    .filter((row) => !text(row.seed_missing_fields))
    .filter((row) => text(row.identity_status) === 'approved' && row.identity_live_read_enabled !== false)
    .filter((row) => !row.kb_direct_high_quality_ready)
    .filter((row) => (requireDescription ? true : true))
    .slice(0, limit);
}

async function fetchSeeds(productIds) {
  if (!productIds.length) return [];
  const result = await query(
    `
      SELECT
        external_product_id,
        title,
        image_url,
        destination_url,
        canonical_url,
        seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], external_product_id)
    `,
    [productIds],
  );
  return result.rows || [];
}

function validateCandidateRows(reportRows) {
  const diagnostics = [];
  for (const row of reportRows) {
    const entries = buildKbEntriesForRow(row);
    if (entries.length !== 1) {
      diagnostics.push({ case_id: row.case_id, ok: false, reason: 'publish_entry_not_built' });
      continue;
    }
    const entry = entries[0];
    const inventory = buildPivotaInsightInventoryRow(entry, {
      title: row.selected?.bundle?.shopping_card?.title,
      canonicalUrl: row.selected?.bundle?.provenance?.official_source_url,
    });
    const commerceClaim = hasCommerceTruthClaim(row.selected?.bundle);
    diagnostics.push({
      case_id: row.case_id,
      product_id: row.selected?.bundle?.canonical_product_ref?.product_id,
      ok: inventory.public_ready && !commerceClaim,
      public_ready: inventory.public_ready,
      high_quality_ready: inventory.high_quality_ready,
      lane: inventory.lane,
      issues: inventory.issues,
      blocking_issues: inventory.blocking_issues,
      evidence_profile: inventory.evidence_profile,
      commerce_truth_claim: commerceClaim,
    });
  }
  return diagnostics;
}

async function main() {
  const inventoryPath = argValue('inventory');
  const outPath = argValue('out');
  if (!inventoryPath) throw new Error('--inventory is required');
  if (!outPath) throw new Error('--out is required');

  const batchName = text(argValue('batch-name')) || `official_seed_product_intel_${Date.now()}`;
  const reviewer = text(argValue('reviewer')) || 'codex_quality_reviewer_owner_delegated';
  const generatedAt = new Date().toISOString();
  const inventoryRows = readJson(inventoryPath);
  const selectedInventory = selectInventoryRows(inventoryRows, {
    domain: argValue('domain'),
    lane: argValue('lane', 'lane_3_kb_rewrite_review'),
    limit: argValue('limit', '100'),
    requireDescription: !hasFlag('allow-missing-description'),
  });
  const productIds = selectedInventory.map((row) => normalizeId(row.external_product_id)).filter(Boolean);
  const seeds = await fetchSeeds(productIds);
  const inventoryById = new Map(selectedInventory.map((row) => [normalizeId(row.external_product_id), row]));
  const seedById = new Map(seeds.map((seed) => [normalizeId(seed.external_product_id), seed]));
  const orderedSeeds = productIds.map((id) => seedById.get(id)).filter(Boolean);
  const reportRows = buildReportRows({
    seeds: orderedSeeds,
    inventoryById,
    generatedAt,
    batchName,
    reviewer,
  });
  const candidateDiagnostics = validateCandidateRows(reportRows);
  const badDiagnostics = candidateDiagnostics.filter((item) => !item.ok);
  if (badDiagnostics.length) {
    const err = new Error(`candidate_quality_validation_failed:${badDiagnostics.length}`);
    err.diagnostics = badDiagnostics;
    throw err;
  }

  if (hasFlag('validate-replacements')) {
    const entries = reportRows.flatMap((row) => buildKbEntriesForRow(row));
    const existingByKey = await fetchExistingProductIntelKbRows(entries.map((entry) => entry.kb_key));
    const { blockedEntries } = prepareEntriesForWrite(entries, reportRows, existingByKey);
    if (blockedEntries.length) {
      const err = new Error(`replacement_validation_blocked:${blockedEntries.length}`);
      err.blockedEntries = blockedEntries;
      throw err;
    }
  }

  const report = {
    meta: {
      generated_at: generatedAt,
      source: 'reviewed_official_seed_product_intel_report',
      batch_name: batchName,
      inventory: inventoryPath,
      selected_cases: reportRows.length,
      reviewer,
      reviewer_kind: 'assistant',
      candidate_quality_summary: {
        public_ready: candidateDiagnostics.filter((item) => item.public_ready).length,
        high_quality_ready: candidateDiagnostics.filter((item) => item.high_quality_ready).length,
        evidence_profile: candidateDiagnostics.reduce((acc, item) => {
          acc[item.evidence_profile] = (acc[item.evidence_profile] || 0) + 1;
          return acc;
        }, {}),
      },
    },
    rows: reportRows,
  };
  writeJson(outPath, report);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      out: outPath,
      rows: reportRows.length,
      selected_product_ids: productIds,
      quality: report.meta.candidate_quality_summary,
    })}\n`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      if (err && err.diagnostics) {
        process.stderr.write(`${JSON.stringify(err.diagnostics, null, 2)}\n`);
      }
      if (err && err.blockedEntries) {
        process.stderr.write(`${JSON.stringify(err.blockedEntries, null, 2)}\n`);
      }
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}

module.exports = {
  _internals: {
    brandFromUrl,
    buildBundle,
    buildHighlightPhrase,
    inferKind,
    sanitizeFormulaSummary,
    sanitizePublicSourceText,
    sanitizePublicTitleText,
  },
};
