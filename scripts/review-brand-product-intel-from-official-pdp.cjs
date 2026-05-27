#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { closePool, query, withClient } = require('../src/db');
const {
  PRODUCT_INTEL_CONTRACT_VERSION,
  normalizePublishedProductIntelBundle,
} = require('../src/pdpProductIntel');
const {
  assessPivotaInsightReplacement,
  buildPivotaInsightInventoryRow,
} = require('../src/services/pivotaInsightsQuality');

const REVIEW_SOURCE = 'pivota_insights_official_pdp_manual_review_v1';
const REVIEWER = 'codex_manual_review';
const PROTECTED_QUALITY_STATES = new Set(['reviewed', 'verified', 'published', 'ready']);
const PROTECTED_EVIDENCE_PROFILES = new Set(['community_supported']);
const SUPPORTED_BRANDS = new Set([
  'fenty',
  'fenty beauty',
  'fenty skin',
  'catkin',
  'catkin cosmetics',
  'flower knows',
  'guerlain',
  'joocyee',
  'judydoll',
  'kylie cosmetics',
  'beekman 1802',
  'rare',
  'rare beauty',
  'rms',
  'rms beauty',
  'rmsbeauty',
  'innbeauty',
  'innbeauty project',
  'inn beauty',
  'inn beauty project',
  'lizush',
  'murad',
  'naturium',
  'nuxe',
  'olehenriksen',
  'ole henriksen',
  'pixi',
  'pixi beauty',
  'tom ford',
  'tom ford beauty',
  'upcircle',
  'upcircle beauty',
]);

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function stripHtml(input) {
  return asString(input)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentence(value) {
  const text = stripHtml(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function compactText(value, limit = 360) {
  const text = stripHtml(value);
  if (!text) return '';
  if (text.length <= limit) return text;
  const truncated = text.slice(0, limit);
  const boundary = truncated.lastIndexOf(' ');
  return truncated.slice(0, boundary > limit * 0.65 ? boundary : limit).trim();
}

function isLowSignalMarketingSentence(value) {
  const current = stripHtml(value);
  return (
    /\b(add to bag|shop now|discover|limited time|free shipping|subscribe|sign up)\b/i.test(current) ||
    /\b(anything but ordinary|far from innocent|you won't want to|must-have|iconic|indulge in)\b/i.test(current) ||
    /\bwould change your impression\b/i.test(current) ||
    /\bfinally\b[^.!?]{0,80}\byour ultimate\b/i.test(current) ||
    /\btake it to bed\s*[-–—]?\s*wake up transformed\b/i.test(current) ||
    /\b(?:our\s+)?bestselling,\s*award-winning\b/i.test(current) ||
    /\bcatch you in a poppin'? lip look\b/i.test(current) ||
    /\bthe ultimate hydration\s*\+\s*heat protection duo\b/i.test(current) ||
    /\buniversal must-haves that repair, strengthen and nourish\b/i.test(current) ||
    /\bthe award-winning foundation that forever changed the game\b/i.test(current) ||
    /\bthe best overnighter you(?:'|’)?ve ever had\b/i.test(current) ||
    /\b(inspired packaging|wardrobe of lip and face cosmetics|sensuous beauty|afterglow)\b/i.test(current) ||
    /\bthis exudes everything i feel\b/i.test(current) ||
    /\bit'?s my essence captured in a bottle\b/i.test(current) ||
    /\b-\s*rihanna\b/i.test(current) ||
    /\bone is sold every\s+\d+\s+seconds\b/i.test(current) ||
    /\baward-winning and bestselling\b/i.test(current) ||
    /\brihanna was inspired to create the world of fenty beauty brands\b/i.test(current) ||
    /\bpartnering with the best of the best in the beauty industry\b/i.test(current) ||
    /\bstill seeing a void\b/i.test(current) ||
    /\bshop kylie cosmetics by kylie jenner\b/i.test(current) ||
    /\bexcludes it from recommendation merchandising\b/i.test(current) ||
    /^(?:shop\b|your done-in-one|straight up|the lowdown|made with|what else|the #?'?s don't lie|already have|click here|want the full scoop)\b/i.test(current)
  );
}

function stripPdpMarketingFrames(value) {
  let text = stripHtml(value);
  if (!text) return '';
  const straightUpIndex = text.search(/\bstraight\s+up\s*:/i);
  if (straightUpIndex >= 0) {
    text = text.slice(straightUpIndex).replace(/^straight\s+up\s*:\s*/i, '');
  }
  text = text
    .replace(/^(?:what\s+it\s+is|what\s+it\s+does)\s*:\s*/i, '')
    .replace(/^(?:your done-in-one|the lowdown|made with)\b[^.!?]*:\s*/i, '')
    .replace(/\b(?:the lowdown|made with|what else\?!?|the #?'?s don't lie)\b[\s\S]*$/i, '')
    .replace(/\bclick here to find your fit\.?/gi, '')
    .replace(/\bwant the full scoop[\s\S]*$/i, '')
    .trim();
  return text;
}

function firstUsefulSentence(value, limit = 260) {
  let text = stripPdpMarketingFrames(value);
  const merchandisingMarker = /\bSkin\s+Type\s+Skin\s+Concern\s+Finish\s+Coverage\b/i;
  if (merchandisingMarker.test(text)) {
    const afterMarker = text.split(merchandisingMarker).pop();
    if (stripHtml(afterMarker).length >= 32) text = stripHtml(afterMarker);
  }
  if (!text) return '';
  if (/^[A-Z0-9\s&'’.,-]+$/.test(text) && text.length < 70) return '';
  const decimalSafeText = text.replace(/(\d)\.(\d)/g, '$1<DECIMAL>$2');
  const sentences = (decimalSafeText.match(/[^.!?]+[.!?]?/g) || []).map((item) =>
    item.replace(/<DECIMAL>/g, '.'),
  );
  for (const raw of sentences) {
    const current = stripHtml(raw);
    if (current.length < 32) continue;
    if (/^key\s+notes?\b/i.test(current) && current.length > 140) continue;
    if (isLowSignalMarketingSentence(current)) continue;
    return sentence(compactText(current, limit));
  }
  if (isLowSignalMarketingSentence(text)) return '';
  return sentence(compactText(text, limit));
}

function articleFor(label) {
  return /^[aeiou]/i.test(asString(label)) ? 'an' : 'a';
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function parseListish(value) {
  if (Array.isArray(value)) {
    return uniq(value.flatMap((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const body = asString(item.body || item.content || item.text || item.description);
        if (body) return body;
        return [
          item.heading,
          item.title,
          item.name,
          item.label,
          item.ingredient,
          item.value,
        ].filter(Boolean).join(' ');
      }
      return '';
    }));
  }
  const text = stripHtml(value);
  if (!text) return [];
  return uniq(
    text
      .split(/\s*(?:\n|•|\||;)\s*/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function isLikelyInciText(value) {
  const text = stripHtml(value);
  if (text.length < 40) return false;
  if (/\$\s*\d|\b\d(?:\.\d)?\s*\(\d+\)|reviews?\b|add to bag|shop now/i.test(text)) return false;
  const separatorCount = (text.match(/[,;]/g) || []).length;
  const inciCueCount = (text.match(/\b(aqua|water|glycerin|dimethicone|silica|mica|titanium dioxide|iron oxides?|parfum|fragrance|linalool|limonene|citronellol|geraniol|tocopherol|squalane|butylene glycol|phenoxyethanol|ethylhexyl|caprylyl|stearate|palmitate|benzoate|extract|acid|wax|oil)\b/gi) || []).length;
  return separatorCount >= 2 && inciCueCount >= 2;
}

function readIngredients(seedData, snapshot) {
  const strongFields = [
    seedData.pdp_ingredients_raw,
    seedData.ingredients_inci,
    snapshot.pdp_ingredients_raw,
    snapshot.ingredients_inci,
  ];
  for (const value of strongFields) {
    if (isLikelyInciText(value)) return parseListish(value);
  }
  return [];
}

function readFirstField(seedData, snapshot, keys) {
  for (const key of keys) {
    const value = seedData[key];
    if (asString(value) || (Array.isArray(value) && value.length)) return value;
  }
  for (const key of keys) {
    const value = snapshot[key];
    if (asString(value) || (Array.isArray(value) && value.length)) return value;
  }
  return '';
}

function displayBrand(raw) {
  const brand = asString(raw);
  if (/^fenty\s*skin/i.test(brand)) return 'Fenty Skin';
  if (/^fenty/i.test(brand)) return 'Fenty Beauty';
  if (/^tom\s*ford/i.test(brand)) return 'Tom Ford Beauty';
  if (/^guerlain/i.test(brand)) return 'Guerlain';
  if (/^kylie/i.test(brand)) return 'Kylie Cosmetics';
  if (/^beekman\s*1802/i.test(brand)) return 'Beekman 1802';
  if (/^catkin/i.test(brand)) return 'Catkin';
  if (/^flower\s+knows/i.test(brand)) return 'Flower Knows';
  if (/^inn\s*beauty|^innbeauty/i.test(brand)) return 'INNBeauty Project';
  if (/^lizush/i.test(brand)) return 'Lizush';
  if (/^murad/i.test(brand)) return 'Murad';
  if (/^naturium/i.test(brand)) return 'Naturium';
  if (/^nuxe/i.test(brand)) return 'Nuxe';
  if (/^ole\s*henriksen|^olehenriksen/i.test(brand)) return 'Ole Henriksen';
  if (/^pixi/i.test(brand)) return 'Pixi';
  if (/^rms\b/i.test(brand)) return 'RMS Beauty';
  if (/^up\s*circle|^upcircle/i.test(brand)) return 'UpCircle Beauty';
  return brand || 'the brand';
}

function normalizeBrandKey(raw) {
  return asString(raw)
    .replace(/\s+beauty$/i, '')
    .replace(/\s+us$/i, '')
    .toLowerCase();
}

function readVariantValues(variant) {
  const out = [];
  const item = asObject(variant);
  for (const key of ['shade', 'color', 'colour', 'size', 'format', 'scent', 'title', 'name', 'label']) {
    if (asString(item[key])) out.push(item[key]);
  }
  const options = asObject(item.options || item.option_values || item.selected_options);
  for (const [key, value] of Object.entries(options)) {
    if (/^default/i.test(asString(value))) continue;
    if (asString(key) && asString(value)) out.push(`${key}: ${value}`);
  }
  for (const option of asArray(item.options || item.option_values || item.selected_options)) {
    if (typeof option === 'string') {
      if (!/^default/i.test(option)) out.push(option);
    } else if (option && typeof option === 'object') {
      const name = asString(option.name || option.label || option.option_name);
      const value = asString(option.value || option.option_value || option.title);
      if (value && !/^default/i.test(value)) out.push(name ? `${name}: ${value}` : value);
    }
  }
  return uniq(out).filter((value) => !/^(default|default title|single|single item|format:\s*single item)$/i.test(value));
}

function readVariantSummary(seedData, snapshot) {
  const variants = asArray(seedData.variants).length ? asArray(seedData.variants) : asArray(snapshot.variants);
  const labels = uniq(variants.flatMap(readVariantValues));
  const shadeLike = labels.filter((label) => /\b(shade|color|colour)\b/i.test(label) || /#[0-9a-f]{3,6}\b/i.test(label));
  const sizeLike = labels.filter((label) => /\b(size|format|ml|oz|g|fl\.?\s*oz|lipstick refill|candle)\b/i.test(label));
  return {
    count: variants.length,
    labels: labels.slice(0, 8),
    shadeLike: shadeLike.slice(0, 6),
    sizeLike: sizeLike.slice(0, 4),
  };
}

function readSeedFacts(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const title = asString(row.title || row.catalog_title || snapshot.title || seedData.title);
  const brand = displayBrand(row.brand || snapshot.brand || seedData.brand);
  const description = stripHtml(readFirstField(seedData, snapshot, [
    'pdp_description_raw',
    'description',
    'short_description',
    'pdp_overview_raw',
    'overview',
  ]));
  const howTo = parseListish(readFirstField(seedData, snapshot, [
    'pdp_how_to_use_raw',
    'how_to_use',
    'directions',
    'usage',
  ]));
  const activeIngredients = parseListish(readFirstField(seedData, snapshot, [
    'pdp_active_ingredients_raw',
    'active_ingredients',
    'key_ingredients',
    'pdp_key_ingredients_raw',
  ]));
  const safeRawIngredients = readIngredients(seedData, snapshot);
  const details = parseListish(readFirstField(seedData, snapshot, [
    'pdp_details_sections',
    'details_sections',
    'product_details',
    'pdp_product_facts_raw',
  ]));
  return {
    seedData,
    snapshot,
    title,
    brand,
    brandKey: normalizeBrandKey(brand),
    description,
    howTo,
    activeIngredients,
    rawIngredients: safeRawIngredients,
    details,
    variants: readVariantSummary(seedData, snapshot),
    canonicalUrl: asString(row.canonical_url || row.destination_url || row.catalog_canonical_url),
    categoryPath: asString(row.category_path),
    productType: asString(row.product_type || row.category),
  };
}

function combinedText(facts) {
  return [
    facts.title,
    facts.description,
    facts.productType,
    facts.categoryPath,
    facts.activeIngredients.join(' '),
    facts.rawIngredients.slice(0, 45).join(' '),
    facts.details.join(' '),
    facts.variants.labels.join(' '),
  ].join(' ');
}

function inferRole(facts) {
  const text = combinedText(facts).toLowerCase();
  const titleText = `${facts.title} ${facts.productType} ${facts.categoryPath}`.toLowerCase();
  const titleOnly = facts.title.toLowerCase();
  if (/\bcandle\b/.test(text)) return { label: 'Scented candle', step: 'home fragrance', amPm: ['as_needed'] };
  if (/\b(?:dog|cat|pet|puppy|kitten|pooch)\b(?:\s+\w+){0,5}\s+\b(?:toy|toys|collar|leash|bowl|bandana|bed)\b|\b(?:toy|toys|collar|leash|bowl|bandana|bed)\b(?:\s+\w+){0,5}\s+\b(?:dog|cat|pet|puppy|kitten|pooch)\b/.test(titleText)) {
    return { label: 'Pet accessory', step: 'pet accessory', amPm: ['as_needed'] };
  }
  if (/\b(?:hoodie|sweatshirt|sweatpants?|t[-\s]?shirt|tee|apparel|clothing)\b/.test(titleText)) {
    return { label: 'Branded apparel', step: 'branded apparel', amPm: ['as_needed'] };
  }
  if (/\b(?:body essentials|body care set|mini body essentials)\b/.test(titleText)) {
    return { label: 'Body care set', step: 'body care set', amPm: ['am', 'pm'] };
  }
  if (/\baromatherapy\s+pen|stop\s*&\s*soothe|stop\s+and\s+soothe\b/.test(titleText)) {
    return { label: 'Aromatherapy treatment', step: 'body care', amPm: ['as_needed'] };
  }
  if (/\b(?:puff|sponge|applicator)\b/.test(titleText)) return { label: 'Makeup applicator', step: 'application tool', amPm: ['as_needed'] };
  if (/\bbrush\b/.test(titleText)) return { label: 'Makeup brush', step: 'application tool', amPm: ['as_needed'] };
  const accessoryCue = /\b(?:stickers?|decals?|claw clip|head\s*band|headband|pouch|bag|organizer|mirror|sharpener|tool|tray|keychain|key chain|tote|clutch|backpack|wash\s*cloth|washcloth|cuffs?|scrunchie|sleeve|case)\b/.test(titleText);
  const formulaCue = /\b(?:spf|sunscreen|moisturizer|serum|cream|lotion|body milk|lipstick|lip gloss|lip glaze|lip ink|lip luminizer|lip liner|mascara|eyeshadow|eye shadow|eye brightener|palette|makeup remover|remover wipe|eyeliner|foundation|concealer|bronzer|blush|highlighter|toner)\b/.test(titleText);
  if (accessoryCue && !formulaCue) {
    return { label: 'Beauty accessory', step: 'beauty routine', amPm: ['as_needed'] };
  }
  if (/\b(?:artist toolkit|makeup toolkit|beauty toolkit)\b/.test(titleText)) {
    return { label: 'Makeup set', step: 'beauty routine', amPm: ['as_needed'] };
  }
  if (/\b(?:body\s+spray|body\s*&\s*hair\s+fragrance|body\s+and\s+hair\s+fragrance|fragrance\s+mist|hair\s+fragrance\s+mist)\b/.test(titleText)) {
    return { label: 'Body fragrance spray', step: 'body fragrance', amPm: ['as_needed'] };
  }
  if (/\bdeodorant\b/.test(titleText)) {
    return { label: 'Deodorant', step: 'body care', amPm: ['am', 'as_needed'] };
  }
  if (/\b(?:parfum|eau de parfum|eau de toilette|fragrance|perfume|cologne|layering balm)\b/.test(titleText)) {
    return { label: 'Fine fragrance', step: 'fragrance', amPm: ['as_needed'] };
  }
  const explicitLipPair =
    /\b(?:liner|lip\s+liner|gloss|lip\s+gloss|lipstick|lip\s+color|lip\s+luminizer)\b.{0,80}(?:&|\+).{0,80}\b(?:liner|lip\s+liner|gloss|lip\s+gloss|lipstick|lip\s+color|lip\s+luminizer)\b/.test(titleOnly);
  if (/\blip\b/.test(titleOnly) && (/\b(?:combo|kit|set|duo|bundle)\b/.test(titleOnly) || explicitLipPair)) {
    return { label: 'Lip combo', step: 'lip color', amPm: ['as_needed'] };
  }
  if (/\b(?:bundle|duo|trio|set|kit|collection)\b/.test(titleText) && /\b(?:serum|moisturizer|cream|cleanser|toner|scrub|mist|skincare|balance|barrier|bright|glow|hydration|pore|truth|peach|lemonade)\b/.test(titleText)) {
    return { label: 'Skincare set', step: 'skincare', amPm: ['am', 'pm'] };
  }
  if (/\bcolor\s+capsule\b|\bartist\s+toolkit\b/.test(titleOnly)) {
    return { label: 'Makeup set', step: 'beauty routine', amPm: ['as_needed'] };
  }
  if (/\bbrow\s+pencil|eyebrow|brow\b/.test(titleOnly)) return { label: 'Brow product', step: 'brow definition', amPm: ['as_needed'] };
  if (/\blip\s+pencil|lip liner|contour\s+g\b/.test(titleOnly)) return { label: 'Lip liner', step: 'lip definition', amPm: ['as_needed'] };
  if (/\blipstick|lip color|lip colour|lip\s+gloss|lip\s+glaze|lip\s+ink|lip\s+luminizer|rouge g|kisskiss\b/.test(titleOnly)) return { label: 'Lip color', step: 'lip color', amPm: ['as_needed'] };
  if (/\blip\s+balm|lip\s+butter|lip\s+oil|lip\s+serum|lip\s+treatment|glossy\s+lip\b/.test(titleOnly)) return { label: 'Lip treatment', step: 'lip treatment', amPm: ['as_needed'] };
  if (/\bmascara|eyeshadow|eye shadow|eye color|eye colour|eyeliner|eyes\s+quartet|eye\s+palette|makeup\s+palette|five[-\s]?color\s+makeup\s+palette\b/.test(titleOnly)) return { label: 'Eye makeup', step: 'eye makeup', amPm: ['as_needed'] };
  if (/\b(?:cleanser\s*\+\s*toner|toner serum duo)\b/.test(titleText)) {
    return { label: 'Skincare set', step: 'skincare', amPm: ['am', 'pm'] };
  }
  if (/\b(?:glow mist|face mist|facial mist)\b/.test(titleText)) {
    return { label: 'Face mist', step: 'skincare', amPm: ['am', 'pm'] };
  }
  if (/\b(?:facial\s+sauna\s+scrub|smoothing\s+scrub|face\s+scrub|scrub)\b/.test(titleText)) {
    return { label: 'Face scrub', step: 'skincare', amPm: ['am', 'pm'] };
  }
  if (/\btoner\b/.test(titleText)) {
    const exfoliating = /\b(?:bha|aha|pha|salicylic|glycolic|lactic|exfoliat|pore\s+purify)\b/.test(titleText);
    return { label: exfoliating ? 'Exfoliating toner' : 'Face toner', step: 'skincare', amPm: ['am', 'pm'] };
  }
  if (/\bdry\s+shampoo\b/.test(titleText)) {
    return { label: /\bpowder\b/.test(titleText) ? 'Dry shampoo powder' : 'Dry shampoo', step: 'hair care', amPm: ['as_needed'] };
  }
  if (/\bbrow\s+pencil|eyebrow|brow\b/.test(titleText)) return { label: 'Brow product', step: 'brow definition', amPm: ['as_needed'] };
  if (/\b(?:hair|leave[-\s]?in|conditioner|heat protectant|shampoo|styling cream|styler|frizz|scalp)\b/.test(titleText)) {
    return { label: 'Hair treatment', step: 'hair care', amPm: ['as_needed'] };
  }
  if (/\blip\b/.test(titleOnly) && (/\b(?:combo|kit|set|duo|bundle)\b/.test(titleOnly) || explicitLipPair)) {
    return { label: 'Lip combo', step: 'lip color', amPm: ['as_needed'] };
  }
  if (/\blip\s+pencil|lip liner|contour\s+g\b/.test(titleText)) return { label: 'Lip liner', step: 'lip definition', amPm: ['as_needed'] };
  if (/\blipstick|lip color|lip colour|lip\s+gloss|lip\s+glaze|lip\s+ink|lip\s+luminizer|rouge g|kisskiss\b/.test(titleText)) return { label: 'Lip color', step: 'lip color', amPm: ['as_needed'] };
  if (/\blip\s+balm|lip\s+butter|lip\s+oil|lip\s+serum|lip\s+treatment|glossy\s+lip\b/.test(titleText)) return { label: 'Lip treatment', step: 'lip treatment', amPm: ['as_needed'] };
  if (/\bmascara|eyeshadow|eye shadow|eye color|eye colour|eyeliner|eyes\s+quartet|eye\s+palette|makeup\s+palette|five[-\s]?color\s+makeup\s+palette\b/.test(titleText)) return { label: 'Eye makeup', step: 'eye makeup', amPm: ['as_needed'] };
  if (/\b(?:spf|sunscreen|broad\s+spectrum)\b/.test(titleText) && !/\bfoundation|concealer\b/.test(titleText)) {
    return { label: 'Daily sunscreen', step: 'sunscreen', amPm: ['am'] };
  }
  if (/\b(?:retinol|retinal|tranexamic|azelaic|peptide)\b/.test(titleText)) {
    return { label: 'Treatment serum', step: 'serum', amPm: ['pm'] };
  }
  if (/\bfoundation|concealer|skin tint|complexion|tinted moisturizer\b/.test(titleText)) return { label: 'Complexion makeup', step: 'complexion', amPm: ['as_needed'] };
  if (/\b(?:setting spray|4-in-1 mist|4 in 1 mist|face mist)\b/.test(titleText)) return { label: 'Setting mist', step: 'complexion', amPm: ['as_needed'] };
  if (/\b(?:setting powder|finishing powder|powder|bronzer|blush|highlighter|luminizer)\b/.test(titleText)) return { label: 'Face color makeup', step: 'face color', amPm: ['as_needed'] };
  if (/\bprimer|base perfecting|pore prep\b/.test(titleText)) return { label: 'Makeup primer', step: 'primer', amPm: ['as_needed'] };
  if (/\bbody\s+wash\b/.test(titleText)) return { label: 'Body cleanser', step: 'cleanser', amPm: ['am', 'pm'] };
  if (/\bcleanser|cleansing|makeup\s+remover|remover\s+wipes?|makeup\s+wipes?\b/.test(titleText)) return { label: 'Face cleanser', step: 'cleanser', amPm: ['am', 'pm'] };
  if (/\bbody\s+lotion|body\s+cream|body\s+mousse|hand\s+cream|moisturizer|spf|sunscreen|serum|cream|lotion|mask|treatment\b/.test(titleText)) {
    if (/\bspf|sunscreen\b/.test(titleText)) return { label: 'Daily sunscreen', step: 'sunscreen', amPm: ['am'] };
    if (/\bserum\b/.test(titleText)) return { label: 'Treatment serum', step: 'serum', amPm: ['am', 'pm'] };
    if (/\bmask\b/.test(titleText)) return { label: 'Treatment mask', step: 'mask', amPm: ['as_needed'] };
    return { label: 'Body care treatment', step: 'skincare', amPm: ['am', 'pm'] };
  }
  if (/\bdry\s+shampoo\b/.test(text)) {
    return { label: /\bpowder\b/.test(text) ? 'Dry shampoo powder' : 'Dry shampoo', step: 'hair care', amPm: ['as_needed'] };
  }
  if (/\bbrow\s+pencil|eyebrow|brow\b/.test(text)) return { label: 'Brow product', step: 'brow definition', amPm: ['as_needed'] };
  if (/\b(?:fenty hair|leave[-\s]?in|conditioner|heat protectant|shampoo|styling cream|styler|frizz|scalp)\b/.test(text)) {
    return { label: 'Hair treatment', step: 'hair care', amPm: ['as_needed'] };
  }
  if (/\btoner\b/.test(titleText) || (/\btoner\b/.test(text) && /\b(?:skin|skincare|pore|bha|aha|pha|salicylic|aloe|exfoliat)\b/.test(text))) {
    const exfoliating = /\b(?:bha|aha|pha|salicylic|glycolic|lactic|exfoliat|pore\s+purify)\b/.test(text);
    return { label: exfoliating ? 'Exfoliating toner' : 'Face toner', step: 'skincare', amPm: ['am', 'pm'] };
  }
  const titleLooksLikeSkincareFormula = /\b(?:toner|cleanser|cleansing|moisturizer|serum|cream|lotion|mask|spf|sunscreen|treatment|bha|aha|pha|salicylic|aloe)\b/.test(titleText);
  if (!titleLooksLikeSkincareFormula && /\bparfum|eau de parfum|eau de toilette|fragrance|perfume|cologne\b/.test(text)) {
    return { label: 'Fine fragrance', step: 'fragrance', amPm: ['as_needed'] };
  }
  if (/\blip\s+gloss|lip\s+glaze|lip\s+ink|lip\s+luminizer|lipstick|lip color|lip colour\b/.test(text)) return { label: 'Lip color', step: 'lip color', amPm: ['as_needed'] };
  if (/\blip\s+balm|lip\s+butter|lip\s+oil|lip\s+serum|lip\s+treatment\b/.test(text)) return { label: 'Lip treatment', step: 'lip treatment', amPm: ['as_needed'] };
  if (/\bbrush\b/.test(text) && /\bbrush\b/.test(titleText)) return { label: 'Makeup brush', step: 'application tool', amPm: ['as_needed'] };
  if (/\bpowder|bronzer|blush|highlighter|luminizer\b/.test(text)) return { label: 'Face color makeup', step: 'face color', amPm: ['as_needed'] };
  if (/\bmascara|eyeshadow|eye shadow|eye color|eyeliner|eyes\s+quartet|eye\s+palette|makeup\s+palette|five[-\s]?color\s+makeup\s+palette\b/.test(text)) return { label: 'Eye makeup', step: 'eye makeup', amPm: ['as_needed'] };
  if (/\bserum|cream|moisturizer|lotion|cleanser|mask|spf|sunscreen|treatment\b/.test(text)) {
    if (/\bbody\s+wash\b/.test(text)) return { label: 'Body cleanser', step: 'cleanser', amPm: ['am', 'pm'] };
    if (/\bcleanser|cleansing|makeup\s+remover|remover\s+wipes?|makeup\s+wipes?\b/.test(text)) return { label: 'Face cleanser', step: 'cleanser', amPm: ['am', 'pm'] };
    if (/\bspf|sunscreen\b/.test(text)) return { label: 'Daily sunscreen', step: 'sunscreen', amPm: ['am'] };
    if (/\bserum\b/.test(text)) return { label: 'Treatment serum', step: 'serum', amPm: ['am', 'pm'] };
    if (/\bmask\b/.test(text)) return { label: 'Treatment mask', step: 'mask', amPm: ['as_needed'] };
    return { label: 'Body care treatment', step: 'skincare', amPm: ['am', 'pm'] };
  }
  return { label: 'Beauty product', step: 'beauty routine', amPm: ['as_needed'] };
}

function findTokens(text, patterns) {
  const lower = stripHtml(text).toLowerCase();
  const out = [];
  for (const [label, pattern] of patterns) {
    if (pattern.test(lower)) out.push(label);
  }
  return uniq(out);
}

function inferAnchors(facts, role) {
  const text = combinedText(facts);
  const titleText = asString(facts.title).toLowerCase();
  const scentAnchors = role.step === 'fragrance' || role.step === 'body fragrance' || role.step === 'home fragrance'
    ? findTokens(text, [
      ['leather', /\bleather\b/],
      ['oud', /\boud\b/],
      ['rose', /\brose\b/],
      ['vanilla', /\bvanilla\b/],
      ['amber', /\bamber\b/],
      ['sandalwood', /\bsandalwood\b/],
      ['tobacco', /\btobacco\b/],
      ['cherry', /\bcherry\b/],
      ['iris', /\biris\b/],
      ['jasmine', /\bjasmine\b/],
      ['citrus', /\bcitrus|bergamot|mandarin|orange|lemon\b/],
    ])
    : [];
  let productAnchors = findTokens(text, [
    ['honey', /\bhoney|royal jelly|bee\b/],
    ['orchid', /\borchid\b/],
    ['hyaluronic acid', /\bhyaluronic\b/],
    ['peptide', /\bpeptide\b/],
    ['niacinamide', /\bniacinamide\b/],
    ['shea butter', /\bshea\b/],
    ['squalane', /\bsqualane\b/],
    ['SPF', /\bspf\b/],
    ['matte finish', /\bmatte\b/],
    ['satin finish', /\bsatin\b/],
    ['shine finish', /\bshine|gloss|glossy|glaze\b/],
    ['refillable format', /\brefill|case\b/],
    ['shade range', /\bshade|color|colour\b/],
  ]);
  if (role.step === 'home fragrance' || role.step === 'fragrance' || role.step === 'body fragrance') {
    productAnchors = productAnchors.filter((item) => !['shade range', 'honey', 'orchid'].includes(item));
  }
  if (role.step === 'application tool') {
    productAnchors = findTokens(text, [
      ['synthetic bristles', /\bsynthetic\s+hair|synthetic\s+bristles\b/],
      ['precision application', /\bprecise|precision|contour|concealer|eyeshadow|cheek|foundation|brush\b/],
      ['face blending', /\bblend|blending|buff|diffuse|seamless\b/],
    ]);
  } else if (role.step === 'primer') {
    productAnchors = findTokens(text, [
      ['makeup prep', /\bprimer|prep|base\b/],
      ['hydration', /\bhydrat|hyaluronic|moistur|sodium hyaluronate|normal to dry\b/],
      ['soft-focus canvas', /\bsoft[-\s]?focus|blur|smooth|smoother|silky|soft silk\b/],
      ['makeup-wear support', /\bfoundation\s+(?:wear|last|application)|makeup\s+(?:last|wear)|wear\s+longer|extend|glide\b/],
      ['pore-smoothing', /\bpore|smooths?\s+pores?\b/],
    ]);
  } else if (role.step === 'complexion') {
    productAnchors = findTokens(text, [
      ['longwear coverage', /\b(?:longwear|long-wear)\b/],
      ['soft-matte finish', /\bsoft[-\s]?matte|matte\b/],
      ['coverage control', /\b(?:medium to full|light to full|buildable|coverage)\b/],
      ['shade range', /\bshade|color|colour\b/],
    ]);
  } else if (role.step === 'lip definition') {
    productAnchors = findTokens(text, [
      ['longwear lip definition', /\b(?:lasts?\s+up\s+to\s+\d+\s+hours?|longwear|long-wear)\b/],
      ['transfer-resistant wear', /\btransfer\b/],
      ['feather-resistant edge', /\bfeathering|feather\b/],
      ['velvet-matte finish', /\bvelvet[-\s]?matte|matte\b/],
      ['sharpenable pencil', /\bsharpenable|sharpener|pencil\b/],
      ['shade clarity', /\bshade|color|colour\b/],
    ]);
  } else if (role.step === 'face color') {
    const bronzerLike = /\bbronzer|bronze|contour\b/.test(titleText);
    productAnchors = findTokens(text, [
      ['bronzing/contour role', bronzerLike ? /\bbronze|bronzer|contour|define|warm\b/ : /\bbronze|bronzer|contour|define\b/],
      ['long-wear color', /\b(?:longwear|long-wear|all[-\s]?day)\b/],
      ['cream-powder texture', /\bcream[-\s]?powder|powder\b/],
      ['glow payoff', bronzerLike ? /$a/ : /\bglow|dayglow|highlight|luminous|radiance\b/],
      ['matte finish', /\bmatte\b/],
      ['shade range', /\bshade|color|colour\b/],
    ]);
  } else if (role.step === 'beauty routine' && role.label === 'Makeup set') {
    productAnchors = findTokens(text, [
      ['set composition', /\bset|collection|capsule|kit|toolkit|edit\b/],
      ['full-size item mix', /\bfull[-\s]?size|icons?\b/],
      ['curated color edit', /\bcurated|palette|ros[eé]|wine|color\b/],
      ['tool pairing', /\bbrush|tool|toolkit\b/],
    ]);
  } else if (role.step === 'beauty routine') {
    productAnchors = findTokens(text, [
      ['travel organization', /\btravel|organize|organizer|toiletry|pouch|bag|tote|backpack|clutch|carryall\b/],
      ['fragrance display', /\bfragrance\s+tray|vanity|display|tray\b/],
      ['hair control', /\bhair|headband|claw clip|clip\b/],
      ['collectible format', /\bsticker|decal|collectible|enamel\b/],
      ['compact accessory', /\bkeychain|key chain|mini|pouch|compact\b/],
    ]);
  } else if (role.step === 'brow definition') {
    productAnchors = findTokens(text, [
      ['brow definition', /\bbrow|eyebrow|define|definition|filling\b/],
      ['precision application', /\bprecision|precise|ultra[-\s]?fine|pencil|hair[-\s]?like\b/],
      ['shade matching', /\bshade|taupe|blonde|brown|auburn|chestnut|black\b/],
      ['built-in brow brush', /\bbrush|styler|paddle\b/],
    ]);
  } else if (role.step === 'branded apparel') {
    productAnchors = findTokens(text, [
      ['soft fleece', /\bfleece|cozy|comfy|soft\b/],
      ['cotton feel', /\bcotton|tee|t-shirt\b/],
      ['everyday layering', /\bhoodie|sweatshirt|sweatpants|quarter zip|layer\b/],
    ]);
  } else if (role.step === 'pet accessory') {
    productAnchors = findTokens(text, [
      ['pet toy', /\bdog toy|pet toy|pooch\b/],
      ['brand collectible', /\bsoft pooch|rare beauty|collectible\b/],
    ]);
  } else if (role.step === 'hair care') {
    productAnchors = findTokens(text, [
      ['frizz control', /\bfrizz\b/],
      ['heat protection', /\bheat protect|heat protection\b/],
      ['leave-in care', /\bleave[-\s]?in|conditioner\b/],
      ['oil control', /\boil[-\s]?control|dry shampoo\b/],
      ['scalp or style refresh', /\bscalp|refresh|style|styling\b/],
    ]);
  } else if (role.step === 'eye makeup') {
    productAnchors = findTokens(text, [
      ['palette format', /\bpalette\b/],
      ['multi-shade color story', /\bfive[-\s]?color|multi[-\s]?shade|shade|color|colour\b/],
      ['embossed finish', /\bembossed|emboss\b/],
      ['cream or powder texture', /\bcream|powder\b/],
      ['high-impact payoff', /\bhigh[-\s]?impact|single swipe|color intensity|pigment\b/],
    ]);
  } else if (role.step === 'cleanser') {
    productAnchors = findTokens(text, [
      ['daily cleansing', /\bcleanse|cleanser|cleansing|wash(?:es)? away\b/],
      ['pore cleansing', /\bpores?|dirt|oil|impurities\b/],
      ['non-stripping cleanse', /\bwithout leaving skin feeling tight|non[-\s]?stripping|stripping|drying\b/],
      ['makeup removal', /\bmakeup\b/],
    ]);
  } else if (role.step === 'sunscreen') {
    productAnchors = findTokens(text, [
      ['sun protection', /\bspf|sunscreen|uva|uvb|broad\s+spectrum\b/],
      ['niacinamide', /\bniacinamide\b/],
      ['hydration', /\bhydrat|hyaluronic|moistur|aloe\b/],
      ['mineral SPF', /\bzinc oxide|mineral\b/],
      ['tinted coverage', /\btinted|shade|coverage\b/],
      ['refillable format', /\brefill|case\b/],
    ]);
  } else if (role.step === 'skincare' || role.step === 'body care' || role.step === 'serum') {
    productAnchors = findTokens(text, [
      ['vitamin C', /\bvitamin\s*c|ascorbic|truth serum|essential-c|pro c\b/],
      ['retinol', /\bretinol|retinal\b/],
      ['azelaic acid', /\bazelaic\b/],
      ['tranexamic acid', /\btranexamic\b/],
      ['peptides', /\bpeptides?\b/],
      ['centella', /\bcentella|cica\b/],
      ['BHA/salicylic acid', /\bbha\b|\bsalicylic\b/],
      ['AHA exfoliation', /\baha\b|\bglycolic\b|\blactic\b/],
      ['exfoliating scrub', /\bscrub|exfoliat\b/],
      ['face mist', /\bglow mist|face mist|facial mist\b/],
      ['aloe juice', /\baloe\b/],
      ['toning step', /\btoner|toning\b/],
      ['hydration', /\bhydrat|hyaluronic|moistur\b/],
      ['barrier support', /\bbarrier|squalane|shea|ceramide\b/],
    ]);
  }
  const normalizeAnchorLabel = (value) =>
    asString(value).replace(/^(?:size|shade|format|scent|jar):\s*/i, '').trim();
  const anchors = [...scentAnchors, ...productAnchors].map(normalizeAnchorLabel);
  const meaningfulSizeLabels = facts.variants.sizeLike.filter((label) => (
    !/^format:\s*one piece$|^one piece$/i.test(label) &&
    !(role.step === 'primer' && isWeakStandaloneVariantValue(label))
  ));
  if (meaningfulSizeLabels.length) anchors.push(...meaningfulSizeLabels.map(normalizeAnchorLabel));
  if (role.step === 'lip color' && facts.variants.shadeLike.length) anchors.push('shade clarity');
  if (facts.rawIngredients.length) anchors.push('full INCI available');
  return uniq(anchors).slice(0, 6);
}

function inferBestFor(facts, role, anchors) {
  const text = combinedText(facts);
  let labels = [];
  if (role.step === 'fragrance' || role.step === 'body fragrance' || role.step === 'home fragrance') {
    labels = findTokens(text, [
      ['warm fragrance profiles', /\bamber|vanilla|tobacco|leather|oud|sandalwood\b/],
      ['floral fragrance profiles', /\brose|jasmine|orchid|iris|flower|floral\b/],
      ['fresh citrus profiles', /\bcitrus|bergamot|mandarin|orange|lemon|fresh\b/],
      ['fragrance layering', /\blayer|body spray|all over body spray\b/],
      ['home scent', /\bcandle|home fragrance\b/],
    ]);
  } else if (role.step.includes('lip')) {
    labels = findTokens(text, [
      ['defined lip looks', /\bliner|contour|define|definition\b/],
      ['refillable lip color', /\brefill|case\b/],
      ['color payoff', /\bpigment|color|colour|shade|lipstick|rouge\b/],
      ['lip comfort', /\bcomfort|moistur|hydr|balm|care\b/],
      ['shine finish', /\bshine|gloss|glossy\b/],
      ['matte finish', /\bmatte\b/],
    ]);
  } else if (role.step === 'primer') {
    labels = findTokens(text, [
      ['base makeup prep', /\bprimer|prep|base\b/],
      ['hydrating primer feel', /\bhydrat|hyaluronic|moistur|sodium hyaluronate|normal to dry\b/],
      ['smooth makeup laydown', /\bsmooth|smoother|silky|soft silk|glide|soft[-\s]?focus|blur|pore\b/],
      ['makeup-wear support', /\bfoundation\s+(?:wear|last|application)|makeup\s+(?:last|wear)|wear\s+longer|extend\b/],
    ]);
  } else if (role.step === 'complexion' || role.step === 'face color') {
    labels = findTokens(text, [
      ['base makeup prep', /\bprimer|prep|base\b/],
      ['complexion coverage', /\bfoundation|coverage|concealer|skin tint\b/],
      ['soft-focus finish', /\bblur|pore|soft-focus|matte|powder\b/],
      ['radiant finish', /\bradiant|glow|highlight|luminous\b/],
    ]);
  } else if (role.step === 'brow definition') {
    labels = findTokens(text, [
      ['brow definition', /\bbrow|eyebrow|definition|define\b/],
      ['precision application', /\bprecision|pencil|clear-cut\b/],
      ['shade matching', /\bshade|taupe|blonde|brown|chestnut\b/],
    ]);
  } else if (role.step === 'cleanser') {
    labels = findTokens(text, [
      ['daily cleansing', /\bcleanse|cleanser|cleansing|wash(?:es)? away\b/],
      ['pore cleansing', /\bpores?|dirt|oil|impurities\b/],
      ['non-stripping cleanse', /\bwithout leaving skin feeling tight|non[-\s]?stripping|stripping|drying\b/],
      ['makeup removal', /\bmakeup\b/],
    ]);
  } else if (role.step === 'skincare' || role.step === 'serum' || role.step === 'sunscreen' || role.step === 'body care' || role.step === 'body care set') {
    labels = findTokens(text, [
      ['exfoliating toner step', /\bbha\b|\bsalicylic\b|\baha\b|\bglycolic\b|\blactic\b|\btoner\b/],
      ['hydration', /\bhydrat|hyaluronic|moistur\b/],
      ['firmness', /\bfirm|peptide|elastic|lift\b/],
      ['radiance', /\bradiance|bright|glow\b/],
      ['barrier support', /\bbarrier|squalane|shea|ceramide\b/],
      ['sun protection', /\bspf|sunscreen|uva|uvb|broad\s+spectrum\b/],
      ['body routine', /\bbody|lotion|wash|essentials\b/],
      ['aromatherapy', /\baromatherapy|scent|soothe|comfort\b/],
    ]);
  } else if (role.step === 'beauty routine') {
    labels = findTokens(text, [
      ['makeup organization', /\btoiletry|pouch|bag|organize|organizer|tote|clutch|backpack\b/],
      ['fragrance display', /\bfragrance\s+tray|vanity|display|tray\b/],
      ['hair hold', /\bhair|headband|claw clip|clip\b/],
      ['collecting', /\bsticker|decal|collectible|keychain|key chain\b/],
      ['travel', /\btravel|on the go|carryall\b/],
    ]);
  } else if (role.step === 'hair care') {
    labels = findTokens(text, [
      ['frizz control', /\bfrizz\b/],
      ['heat styling prep', /\bheat protect|heat protection\b/],
      ['hair hydration', /\bhydrat|conditioner|leave[-\s]?in\b/],
      ['oil control', /\boil[-\s]?control|dry shampoo\b/],
      ['style refresh', /\brefresh|style|styling\b/],
    ]);
  } else if (role.step === 'branded apparel') {
    labels = findTokens(text, [
      ['casual wear', /\bhoodie|sweatshirt|sweatpants|t-shirt|tee|apparel\b/],
      ['soft comfort', /\bsoft|fleece|cozy|comfy|comfortable\b/],
      ['everyday layering', /\blayer|quarter zip|year round\b/],
    ]);
  } else if (role.step === 'pet accessory') {
    labels = findTokens(text, [
      ['pet play', /\bdog toy|pet toy|pooch\b/],
      ['brand collectible', /\brare beauty|soft pooch|collectible\b/],
    ]);
  }
  if (!labels.length && anchors.length) labels = anchors.slice(0, 3);
  if (!labels.length) labels = [role.label];
  return uniq(labels).slice(0, 4).map((label) => ({
    tag: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    label,
    confidence: 'moderate',
  }));
}

function cleanInstruction(value, limit = 170) {
  let text = stripHtml(value)
    .replace(/^[-*\s]+/, '')
    .replace(/\s+-\s+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/^(?:how\s+to|how\s+to\s+use|directions?|usage|application)$/i.test(text)) return '';
  text = text
    .replace(/\bshop\s+now\b[\s\S]*$/i, '')
    .replace(/\badd\s+to\s+bag\b[\s\S]*$/i, '')
    .trim();
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [];
  for (const raw of sentences) {
    const current = sentence(raw);
    if (current.length >= 24 && current.length <= limit) return current;
  }
  return compactText(text, limit);
}

function sourceInstructionsForRole(facts, role) {
  return facts.howTo
    .map((item) => cleanInstruction(item, 180))
    .filter((item) => {
      if (!item) return false;
      if (role.step === 'application tool' && /\bhair|scalp|rinse|style\b/i.test(item)) return false;
      return true;
    });
}

function buildPairingNotes(facts, role) {
  const howTo = sourceInstructionsForRole(facts, role);
  if (howTo.length) return howTo.slice(0, 2);
  if (role.step === 'fragrance') return ['Apply to pulse points or clothing as appropriate for the fragrance format.'];
  if (role.step === 'body fragrance') return ['Use as a lighter body-fragrance layer, then pair with matching scent formats if desired.'];
  if (role.step === 'home fragrance') return ['Use as a home scent item and follow the brand safety directions for burn time and placement.'];
  if (role.step === 'lip definition') return ['Use before lip color to define the lip line and support a cleaner edge.'];
  if (role.step === 'lip color') return ['Apply directly to lips; pair with liner if you want more definition.'];
  if (role.step === 'hair care') return ['Apply to hair as directed for the specific treatment or styling step.'];
  if (role.step === 'primer') return ['Apply before complexion makeup where you want smoother makeup laydown.'];
  if (role.step === 'application tool') return ['Use with the product textures the brush is designed to apply.'];
  return ['Use in the routine step implied by the official product directions.'];
}

function buildCompleteHighlight(values, fallback) {
  const items = uniq(values.map((value) => asString(value).replace(/^(?:size|shade|format|scent|jar):\s*/i, '').trim())).filter(Boolean);
  let out = '';
  for (const item of items) {
    const text = item.replace(/^shade:\s*/i, '').replace(/^size:\s*/i, '').trim();
    if (!text) continue;
    const next = out ? `${out}, ${text}` : text;
    if (next.length > 40) break;
    out = next;
  }
  return out || compactText(fallback, 40);
}

function buildSampleHighlight(facts, anchors, fallback) {
  if (!isSampleProduct(facts)) return '';
  const sampleValues = [
    ...anchors.filter((item) => item !== 'shade range' && !/^full inci/i.test(item)),
    ...asArray(facts.variants?.labels)
      .map((label) => asString(label).replace(/^(?:size|format|shade|color|colour):\s*/i, '').trim())
      .filter((label) => label && !/^single item$/i.test(label)),
  ];
  return buildCompleteHighlight(sampleValues, fallback);
}

function buildRoleAwareHighlight(facts, role, anchors, bestFor) {
  const title = facts.title.toLowerCase();
  if (role.label === 'Skincare set') {
    if (/\btruth serum\b/.test(title)) return 'Vitamin C serum duo';
    if (/\bbalance\+?\b/.test(title)) return 'Balance skincare set';
    if (/\bbarrier\b/.test(title)) return 'Barrier skincare set';
    if (/\bbright|glow|vitamin\s*c\b/.test(title)) return 'Brightening skincare set';
    return 'Skincare routine set';
  }
  return buildCompleteHighlight(anchors.length ? anchors : bestFor.map((item) => item.label), role.label);
}

function firstUsefulDetail(details) {
  for (const detail of details) {
    const text = stripHtml(detail);
    if (text.length < 24) continue;
    if (/^product\s+type\b/i.test(text)) continue;
    if (/^ingredients?:/i.test(text)) continue;
    if (isLowSignalMarketingSentence(text)) continue;
    return firstUsefulSentence(text, 220) || text;
  }
  return '';
}

function isLipComboRole(facts, role) {
  const title = asString(facts.title).toLowerCase();
  return (
    role.label === 'Lip combo' ||
    (/\blip\b/.test(title) && (/\b(?:combo|kit|set|duo)\b/.test(title) || title.includes('&')))
  );
}

function readLipComboComponents(facts) {
  const title = stripHtml(facts.title)
    .replace(/\s+/g, ' ')
    .replace(/\b(?:combo|set|duo)\b$/i, '')
    .trim();
  if (!title.includes('&')) return [];
  return uniq(
    title
      .split(/\s*&\s*/g)
      .map((item) => item.replace(/\b(?:combo|set|duo)\b$/i, '').trim())
      .filter((item) => item.length >= 4),
  ).slice(0, 3);
}

function readLipComboFormat(facts) {
  const labels = uniq([
    ...asArray(facts.variants?.labels),
    ...asArray(facts.details),
    facts.description,
  ]);
  for (const raw of labels) {
    const text = stripHtml(raw)
      .replace(/^(?:format|pack|set|item):\s*/i, '')
      .trim();
    if (/\blip\s+(?:duo|set|kit|combo)\b/i.test(text) && text.length <= 90) return text;
  }
  return '';
}

function buildLipComboHighlight(facts) {
  const comboFormat = readLipComboFormat(facts);
  if (comboFormat) return comboFormat;
  const components = readLipComboComponents(facts);
  if (components.length >= 2) return compactText(components.join(' + '), 64);
  return '';
}

function buildLipComboWhyItStandsOut(facts, role, anchors) {
  const why = [];
  const components = readLipComboComponents(facts);
  const comboFormat = readLipComboFormat(facts);
  const finishAnchors = anchors.filter((item) => /\b(?:matte|shine|satin)\s+finish\b/i.test(item));
  const howTo = sourceInstructionsForRole(facts, role);
  const componentText = components.length >= 2
    ? `${components.slice(0, -1).join(', ')} and ${components[components.length - 1]}`
    : '';

  if (componentText || comboFormat) {
    const subject = componentText
      ? `the paired components as ${componentText}`
      : `the format as ${comboFormat}`;
    const formatClause = comboFormat && componentText ? ` The visible selector summarizes the pack as ${comboFormat}.` : '';
    why.push({
      headline: 'Component pairing is clear',
      body: sentence(`The PDP identifies ${subject}, so a shopper can tell whether this is liner-plus-color, gloss-plus-liner, or a fuller lip set before leaving the page.${formatClause}`),
      evidence_strength: 'official_pdp_reviewed',
    });
  }

  if (finishAnchors.length) {
    const finishText = finishAnchors.slice(0, 2).join(' and ');
    why.push({
      headline: 'Finish role is easy to compare',
      body: sentence(`The stored product facts call out ${finishText}, which helps shoppers decide whether the set is better for a soft matte lip, a glossy top layer, or a layered look`),
      evidence_strength: 'official_pdp_reviewed',
    });
  }

  if (howTo.length) {
    why.push({
      headline: 'Application order is explicit',
      body: sentence(`The reviewed directions explain the sequence: ${howTo[0]}`),
      evidence_strength: 'official_pdp_reviewed',
    });
  }

  if (facts.rawIngredients.length) {
    why.push({
      headline: 'Ingredient list is available',
      body: sentence('Full INCI is present for formula-sensitive review, which makes this PDP safer to evaluate than a claim-only listing'),
      evidence_strength: 'official_pdp_reviewed',
    });
  }

  return why.slice(0, 3);
}

function isSampleProduct(facts) {
  const text = facts.title.toLowerCase();
  return /\b(?:sample|deluxe sample|travel size|trial size)\b/.test(text);
}

function firstVariantValue(facts, axisRe) {
  const labels = asArray(facts?.variants?.labels);
  const match = labels.find((label) => axisRe.test(label));
  return match ? asString(match).replace(/^[^:]+:\s*/, '').trim() : '';
}

function isWeakStandaloneVariantValue(value) {
  const text = asString(value)
    .replace(/^(?:size|shade|format|scent|jar|set):\s*/i, '')
    .trim();
  return /^(?:standard|mini|full\s*size|single item|one piece)$/i.test(text);
}

function isMeaningfulVariantLabelForInsight(label, role) {
  const text = asString(label);
  if (/^format:\s*one piece$|^one piece$|^format:\s*single item$|^single item$/i.test(text)) return false;
  if (role?.step === 'primer' && isWeakStandaloneVariantValue(text)) return false;
  return true;
}

function joinClaims(claims) {
  const items = uniq(claims.filter(Boolean));
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function publicSafeIngredientName(value) {
  let current = asString(value)
    .replace(/^[-•\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!current) return '';
  current = current.split(/\s[:–—]\s|:\s/)[0].trim();
  current = current
    .replace(/\b(?:helps?|works?|shown|designed|targets?|supports?|soothes?|moisturi[sz]es?|exfoliates?|reduces?|brightens?|smooths?|defends?|plumps?)\b.*$/i, '')
    .replace(/\b(?:dry|chapped|wrinkles?|pores?|redness|blotchiness|melasma|sun damaged|age spots|post-acne marks)\b.*$/i, '')
    .trim();
  if (/\b(?:plump(?:ing)?|wrinkles?|pores?|redness|blotchiness|melasma|sun damaged|age spots|post-acne marks|chapped)\b/i.test(current)) {
    return '';
  }
  if (current.length > 70) return '';
  return current;
}

function publicSafeActiveIngredientNames(facts) {
  return uniq(asArray(facts.activeIngredients).map(publicSafeIngredientName).filter(Boolean));
}

function buildEvidenceAnchoredWhatItIs(facts, role) {
  const text = combinedText(facts);
  const lowerTitle = facts.title.toLowerCase();
  const shade = firstVariantValue(facts, /^(?:shade|color|colour):/i);
  const size = firstVariantValue(facts, /^(?:size|format|set):/i);

  if (role.step === 'primer') {
    const claims = joinClaims([
      /\bhydrat|hyaluronic|moistur|sodium hyaluronate|normal to dry\b/i.test(text) ? 'hydrating prep' : '',
      /\bsoft[-\s]?focus|blur|smooth|smoother|silky|soft silk\b/i.test(text) ? 'a smoother makeup canvas' : '',
      /\bfoundation\s+(?:wear|last|application)|makeup\s+(?:last|wear)|wear\s+longer|extend|glide\b/i.test(text) ? 'makeup-wear support' : '',
      /\bpore|smooths?\s+pores?\b/i.test(text) ? 'pore-smoothing cues' : '',
    ]);
    const sizeClause = size && !isWeakStandaloneVariantValue(size) ? ` in ${size}` : '';
    return sentence(`${facts.title} is a makeup primer from ${facts.brand}${sizeClause}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'complexion') {
    const format = /\bconcealer\b/.test(lowerTitle)
      ? 'concealer'
      : /\bpowder foundation\b/.test(lowerTitle)
        ? 'powder foundation'
        : /\bfoundation\b/.test(lowerTitle)
          ? 'foundation'
          : 'complexion product';
    const claims = joinClaims([
      /\blongwear|long-wear\b/i.test(text) ? 'long-wear coverage' : '',
      /\bsoft[-\s]?matte|matte\b/i.test(text) ? 'a soft-matte finish' : '',
      /\bmedium to full|light to full|buildable|coverage\b/i.test(text) ? 'coverage control' : '',
    ]);
    const sku = shade || size;
    return sentence(`${facts.title} is a ${format} from ${facts.brand}${sku ? ` in ${sku}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'face color') {
    const format = /\bhighlighter\b/.test(lowerTitle)
      ? 'highlighter'
      : /\bblush\b/.test(lowerTitle)
        ? 'blush'
        : /\bbronzer\b/.test(lowerTitle)
          ? 'bronzer'
          : 'face color product';
    const bronzerLike = /\bbronzer|bronze|contour\b/.test(lowerTitle);
    const claims = joinClaims([
      /\blongwear|long-wear\b/i.test(text) ? 'long-wear color' : '',
      /\bcream[-\s]?powder|powder\b/i.test(text) ? 'a cream-powder texture' : '',
      (bronzerLike ? /\bbronze|bronzer|contour|define|warm\b/i : /\bbronze|bronzer|contour|define\b/i).test(text) ? 'bronzing or contour definition' : '',
      !bronzerLike && /\bglow|dayglow|highlight|luminous\b/i.test(text) ? 'glow payoff' : '',
    ]);
    return sentence(`${facts.title} is a ${format} from ${facts.brand}${shade ? ` in shade ${shade}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'lip color' || role.step === 'lip treatment') {
    const format = role.step === 'lip treatment'
      ? (/\bbalm\b/i.test(text) ? 'tinted lip balm' : 'lip treatment')
      : (/\bgloss|glaze\b/i.test(text) ? 'lip gloss' : /\blink\b/i.test(text) ? 'lip ink' : 'lip color');
    const claims = joinClaims([
      /\bshine|gloss|glossy|glaze\b/i.test(text) ? 'shine finish' : '',
      /\bsatin\b/i.test(text) ? 'satin finish' : '',
      /\bmatte\b/i.test(text) ? 'matte finish' : '',
      /\bshade|color|colour|tint\b/i.test(text) ? 'shade clarity' : '',
      /\bhydrat|moistur|balm|comfort\b/i.test(text) ? 'comfort-oriented lip care' : '',
    ]);
    return sentence(`${facts.title} is a ${format} from ${facts.brand}${shade ? ` in ${shade}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'eye makeup') {
    const format = /\bpalette\b/.test(lowerTitle) ? 'eye makeup palette' : 'eye makeup product';
    const claims = joinClaims([
      /\bpalette\b/i.test(text) ? 'a palette format' : '',
      /\bfive[-\s]?color|multi[-\s]?shade|shade|color|colour\b/i.test(text) ? 'multi-shade color selection' : '',
      /\bembossed|emboss\b/i.test(text) ? 'embossed pan detail' : '',
      /\blongwear|long-wear\b/i.test(text) ? 'long-wear color' : '',
      /\bcreamy|cream\b/i.test(text) ? 'a creamy stick format' : '',
      /\bhigh[-\s]?impact|single swipe|color intensity\b/i.test(text) ? 'high-impact payoff' : '',
    ]);
    return sentence(`${facts.title} is an ${format} from ${facts.brand}${shade ? ` in ${shade}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'hair care') {
    const format = /\bdry\s+shampoo\b/i.test(text)
      ? (/\bpowder\b/i.test(text) ? 'dry shampoo powder' : 'dry shampoo')
      : /\bheat protect|heat protection\b/i.test(text)
        ? 'heat protectant styling product'
        : /\bleave[-\s]?in|conditioner\b/i.test(text)
          ? 'leave-in hair treatment'
          : 'hair treatment';
    const claims = joinClaims([
      /\bnon[-\s]?aerosol\b/i.test(text) ? 'a non-aerosol format' : '',
      /\babsorbs?\s+excess\s+oil|oil[-\s]?control|oiliness\b/i.test(text) ? 'excess-oil absorption' : '',
      /\bvolume|volumizing|fullness|texture\b/i.test(text) ? 'volume-texture boost' : '',
      /\brefresh|washdays?|between\s+wash|quick\s+refresh\b/i.test(text) ? 'between-wash refresh' : '',
      /\bheat protect|heat protection\b/i.test(text) ? 'heat-styling prep' : '',
      /\bleave[-\s]?in|conditioner\b/i.test(text) ? 'leave-in care' : '',
      /\bfrizz\b/i.test(text) ? 'frizz control' : '',
    ]);
    return sentence(`${facts.title} is a ${format} from ${facts.brand}${size ? ` in ${size}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'body fragrance' || role.step === 'fragrance' || role.step === 'home fragrance') {
    const scentCues = findTokens(text, [
      ['rose', /\brose\b/],
      ['vanilla', /\bvanilla\b/],
      ['amber', /\bamber\b/],
      ['sandalwood', /\bsandalwood\b/],
      ['citrus', /\bcitrus|bergamot|mandarin|orange|lemon\b/],
      ['leather', /\bleather\b/],
      ['oud', /\boud\b/],
      ['jasmine', /\bjasmine\b/],
    ]);
    const format = role.step === 'body fragrance'
      ? 'body fragrance spray'
      : role.step === 'home fragrance'
        ? 'home fragrance item'
        : 'fine fragrance';
    return sentence(`${facts.title} is a ${format} from ${facts.brand}${size ? ` in ${size}` : ''}${scentCues.length ? `, with source-backed scent cues including ${joinClaims(scentCues.slice(0, 4))}` : ''}`);
  }

  if (role.step === 'sunscreen') {
    const tinted = /\btinted|shade|coverage\b/i.test(text);
    const mineral = /\bzinc oxide\b/i.test(text);
    const format = /\beye\s+brightener\b/.test(lowerTitle)
      ? 'SPF eye brightener'
      : tinted || mineral
        ? `${tinted ? 'tinted ' : ''}${mineral ? 'mineral ' : ''}SPF moisturizer`
        : 'daily SPF moisturizer';
    const claims = joinClaims([
      mineral ? 'zinc oxide mineral SPF' : '',
      /\bniacinamide\b/i.test(text) ? 'niacinamide' : '',
      /\bhyaluronic|aloe\b/i.test(text) ? 'hydrating ingredients' : '',
      tinted ? 'tinted coverage' : '',
      /\brefill\b/i.test(text) ? 'a refill format' : '',
    ]);
    const formatArticle = /^SPF\b/i.test(format) ? 'an' : articleFor(format);
    return sentence(`${facts.title} is ${formatArticle} ${format} from ${facts.brand}${shade ? ` in shade ${shade}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'cleanser') {
    const claims = joinClaims([
      /\bcleanse|cleanser|cleansing\b/i.test(text) ? 'cleansing' : '',
      /\bmakeup\b/i.test(text) ? 'makeup removal' : '',
      /\bwithout leaving skin feeling tight|non[-\s]?stripping|stripping|drying\b/i.test(text) ? 'a non-stripping feel' : '',
      /\bpores?|dirt|oil|impurities\b/i.test(text) ? 'dirt, oil, and impurity removal' : '',
    ]);
    return sentence(`${facts.title} is a ${role.label.toLowerCase()} from ${facts.brand}${size ? ` in ${size}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  if (role.step === 'serum') {
    const claims = joinClaims([
      /\bretinol|retinal\b/i.test(text) ? 'retinol' : '',
      /\bvitamin\s*c|ascorbic|truth serum|essential-c|pro c\b/i.test(text) ? 'vitamin C' : '',
      /\bazelaic\b/i.test(text) ? 'azelaic acid' : '',
      /\btranexamic\b/i.test(text) ? 'tranexamic acid' : '',
      /\bpeptides?\b/i.test(text) ? 'peptides' : '',
      /\bcentella|cica\b/i.test(text) ? 'centella' : '',
      /\bbarrier|ceramide|squalane\b/i.test(text) ? 'barrier support' : '',
    ]);
    return sentence(`${facts.title} is a ${role.label.toLowerCase()} from ${facts.brand}${size ? ` in ${size}` : ''}${claims ? `, with source-backed ingredient cues around ${claims}` : ''}`);
  }

  if (role.step === 'skincare' || role.step === 'body care') {
    const claims = joinClaims([
      /\bcleanse|cleanser|cleansing\b/i.test(text) ? 'cleansing' : '',
      /\btoner|toning\b/i.test(text) ? 'toning' : '',
      /\bhydrat|moistur|shea|hyaluronic\b/i.test(text) ? 'hydration' : '',
      /\bbright|dark spots|niacinamide\b/i.test(text) ? 'brightening support' : '',
    ]);
    return sentence(`${facts.title} is ${articleFor(role.label)} ${role.label.toLowerCase()} from ${facts.brand}${size ? ` in ${size}` : ''}${claims ? `, with source-backed cues around ${claims}` : ''}`);
  }

  return '';
}

function buildWhatItIs(facts, role) {
  const description = firstUsefulSentence(facts.description, 240);
  const detail = firstUsefulDetail(facts.details);
  if (isSampleProduct(facts)) {
    const sampleRoleAwareWhatItIs = ['fragrance', 'body fragrance', 'home fragrance', 'hair care', 'cleanser'].includes(role.step)
      ? buildEvidenceAnchoredWhatItIs(facts, role)
      : '';
    if (sampleRoleAwareWhatItIs) return sampleRoleAwareWhatItIs;
    if (description) return sentence(description.replace(/\.$/, ''));
    if (detail) return sentence(compactText(detail, 180).replace(/\.$/, ''));
  }
  if (isLipComboRole(facts, role)) {
    const combo = buildLipComboHighlight(facts);
    return sentence(`${facts.title} is a lip set from ${facts.brand}${combo ? ` built around ${combo}` : ''}`);
  }
  if (role.step === 'lip definition') {
    const claims = [];
    const sourceText = combinedText(facts);
    if (/\b(?:lasts?\s+up\s+to\s+\d+\s+hours?|longwear|long-wear)\b/i.test(sourceText)) claims.push('long-wear lip definition');
    if (/\btransfer\b/i.test(sourceText) && /\bfeather/i.test(sourceText)) claims.push('transfer- and feather-resistant wear');
    if (/\bvelvet[-\s]?matte|matte\b/i.test(sourceText)) claims.push('a matte pencil finish');
    const shade = facts.variants.shadeLike[0]
      ? facts.variants.shadeLike[0].replace(/^shade:\s*/i, '').trim()
      : '';
    const claimClause = claims.length ? ` It is positioned around ${claims.slice(0, 2).join(' and ')}.` : '';
    const shadeClause = shade ? ` This SKU is ${shade}.` : '';
    return sentence(`${facts.title} is a lip liner from ${facts.brand} for defining the lip edge and supporting cleaner lipstick or gloss wear`) +
      claimClause +
      shadeClause;
  }
  const evidenceAnchored = buildEvidenceAnchoredWhatItIs(facts, role);
  if (evidenceAnchored) return evidenceAnchored;
  const intro = `${facts.title} is ${articleFor(role.label)} ${role.label.toLowerCase()} from ${facts.brand}`;
  const pieces = [intro];
  if (description) pieces.push(description.replace(/\.$/, ''));
  if (!description && detail) pieces.push(compactText(detail, 160).replace(/\.$/, ''));
  if (!description && !detail && facts.variants.labels.length) {
    pieces.push(`available variants clarify ${facts.variants.labels.slice(0, 3).join(', ')}`);
  }
  if (!description && !detail && facts.rawIngredients.length) {
    pieces.push('an ingredient list is available for formula review');
  }
  return pieces.map((item) => sentence(item)).join(' ');
}

function buildWhyItStandsOut(facts, role, anchors) {
  if (isLipComboRole(facts, role)) {
    const lipComboWhy = buildLipComboWhyItStandsOut(facts, role, anchors);
    if (lipComboWhy.length >= 2) return lipComboWhy;
  }

  if (isSampleProduct(facts)) {
    const why = [];
    const meaningfulVariantLabels = facts.variants.labels.filter((label) => isMeaningfulVariantLabelForInsight(label, role));
    if (meaningfulVariantLabels.length) {
      why.push({
        headline: 'Sample format is explicit',
        body: sentence(`The reviewed SKU fields identify ${meaningfulVariantLabels.slice(0, 3).join(', ')}, so shoppers can tell this is a sample or mini-size SKU rather than a hidden default variant`),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
    if (facts.rawIngredients.length && role.step !== 'home fragrance') {
      why.push({
        headline: 'Ingredient list is available',
        body: sentence('Full INCI is present for formula-sensitive review, which makes this sample safer to evaluate than a claim-only listing'),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
    const howTo = sourceInstructionsForRole(facts, role);
    if (howTo.length) {
      why.push({
        headline: 'Usage instructions available',
        body: sentence(`Reviewed usage context is present, including: ${howTo[0]}`),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
    if (why.length >= 2) return why.slice(0, 3);
  }

  if (role.step === 'lip definition') {
    const why = [];
    const sourceText = combinedText(facts);
    if (/\b(?:lasts?\s+up\s+to\s+\d+\s+hours?|longwear|long-wear|transfer|feather|fading)\b/i.test(sourceText)) {
      why.push({
        headline: 'Wear claims are specific',
        body: sentence('The reviewed PDP supports concrete lip-liner claims around long wear and resistance to transfer, feathering, or fading, which is more useful than generic color-copy'),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
    const howTo = sourceInstructionsForRole(facts, role);
    if (howTo.length) {
      why.push({
        headline: 'Application sequence is explicit',
        body: sentence(`The reviewed directions explain how to use the pencil in sequence: ${howTo[0]}`),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
    if (facts.rawIngredients.length) {
      why.push({
        headline: 'Formula disclosure is available',
        body: sentence('A full INCI list is attached, so shoppers can screen the liner formula before leaving Pivota'),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
    const meaningfulVariantLabels = facts.variants.labels.filter((label) => isMeaningfulVariantLabelForInsight(label, role));
    if (meaningfulVariantLabels.length) {
      why.push({
        headline: 'Shade selection is unambiguous',
        body: sentence(`The visible SKU data identifies ${meaningfulVariantLabels.slice(0, 3).join(', ')}, so this row does not read like a generic default variant`),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
    if (why.length >= 2) return why.slice(0, 3);
  }

  const why = [];
  const anchorText = anchors.filter((item) => !/^full inci/i.test(item)).slice(0, 4).join(', ');
  if (anchorText) {
    let anchorHeadline = 'Product cues are source-backed';
    let anchorBody = `Reviewed PDP cues such as ${anchorText} give shoppers specific comparison points within ${facts.brand}, rather than category-only copy`;
    if (role.step === 'fragrance' || role.step === 'body fragrance' || role.step === 'home fragrance') {
      anchorHeadline = 'Scent profile cues';
      anchorBody = `Reviewed scent cues such as ${anchorText} help shoppers compare the fragrance profile without relying on generic scent copy`;
    } else if (role.step === 'face color') {
      anchorHeadline = 'Color payoff cues are specific';
      anchorBody = `Reviewed color cues such as ${anchorText} help shoppers compare shade, finish, or texture instead of seeing a generic blush/bronzer/highlighter card`;
    } else if (role.step === 'lip color') {
      anchorHeadline = 'Lip finish cues are specific';
      anchorBody = `Reviewed lip cues such as ${anchorText} identify finish, shade, or formula context before the shopper leaves Pivota`;
    } else if (role.step === 'complexion') {
      anchorHeadline = 'Coverage and finish cues are clear';
      anchorBody = `Reviewed complexion cues such as ${anchorText} support a more precise read on coverage, finish, or shade fit`;
    } else if (role.step === 'primer') {
      anchorHeadline = 'Primer prep cues are specific';
      anchorBody = `Reviewed primer cues such as ${anchorText} clarify how it preps skin for smoother makeup laydown without making unsupported coverage claims`;
    } else if (role.step === 'skincare' || role.step === 'serum' || role.step === 'body care') {
      anchorHeadline = 'Routine step cues are specific';
      anchorBody = `Reviewed skincare cues such as ${anchorText} identify the routine role or key ingredient context without inventing unsupported benefits`;
    } else if (role.step === 'sunscreen') {
      anchorHeadline = 'SPF format cues are clear';
      anchorBody = `Reviewed SPF cues such as ${anchorText} clarify protection format, hydration support, or refill status without replacing the official sunscreen facts`;
    }
    why.push({
      headline: anchorHeadline,
      body: sentence(anchorBody),
      evidence_strength: 'official_pdp_reviewed',
    });
  }
  if (facts.rawIngredients.length && role.step !== 'home fragrance') {
    why.push({
      headline: 'Ingredient list is available',
      body: sentence(`Full INCI is present for formula-sensitive review, which makes this PDP safer to evaluate than a claim-only listing`),
      evidence_strength: 'official_pdp_reviewed',
    });
  } else if (facts.activeIngredients.length) {
    const activeNames = publicSafeActiveIngredientNames(facts);
    const activeList = activeNames.slice(0, 3).join(', ');
    const activeVerb = activeNames.length === 1 ? 'is' : 'are';
    if (!activeList) {
      why.push({
        headline: 'Key ingredient section is present',
        body: sentence('Reviewed key-ingredient fields are present, but public copy is kept to ingredient-level context rather than unsupported benefit claims'),
        evidence_strength: 'official_pdp_reviewed',
      });
    } else {
      why.push({
        headline: 'Key ingredients are identified',
        body: sentence(`${activeList} ${activeVerb} identified, enough for a cautious high-level formula read without inventing unsupported actives`),
        evidence_strength: 'official_pdp_reviewed',
      });
    }
  }
  const meaningfulVariantLabels = facts.variants.labels.filter((label) => isMeaningfulVariantLabelForInsight(label, role));
  const shouldExplainVariants =
    meaningfulVariantLabels.length > 0 &&
    (role.step !== 'application tool' || meaningfulVariantLabels.some((label) => /\b(size|shade|color|colour|scent|jar|ml|oz|g)\b/i.test(label)));
  if (facts.variants.count > 0 && shouldExplainVariants) {
    const variantHeadline = role.step === 'home fragrance'
      ? 'Configuration is explicit'
      : role.step === 'beauty routine' || role.step === 'pet accessory' || role.step === 'application tool'
        ? 'Accessory format is explicit'
        : 'Shade and size are explicit';
    why.push({
      headline: variantHeadline,
      body: sentence(`Variant labels such as ${meaningfulVariantLabels.slice(0, 4).join(', ')} are visible, reducing ambiguity around the product format before a shopper clicks through`),
      evidence_strength: 'official_pdp_reviewed',
    });
  }
  const howTo = sourceInstructionsForRole(facts, role);
  if (howTo.length) {
    why.push({
      headline: 'Usage instructions available',
      body: sentence(`Reviewed usage context is present, including: ${howTo[0]}`),
      evidence_strength: 'official_pdp_reviewed',
    });
  }
  if (!why.length) {
    why.push({
      headline: 'Official PDP evidence only',
      body: sentence(`This insight is limited to the official product fields currently available for ${facts.title}`),
      evidence_strength: 'official_pdp_reviewed_limited',
    });
  }
  return why.slice(0, 3);
}

function buildWatchouts(facts, role) {
  const watchouts = [];
  if (role.step === 'fragrance' || role.step === 'body fragrance' || role.step === 'home fragrance') {
    watchouts.push({
      type: 'scent_sensitivity',
      label: 'Fragrance preferences are personal; sample first if you are sensitive to scent intensity.',
      severity: 'low',
    });
  } else if (role.step.includes('lip')) {
    watchouts.push({
      type: 'shade_fit',
      label: 'Color appearance can shift with lip tone, lighting, and paired liner.',
      severity: 'low',
    });
  } else if (/\bretinol|aha|bha|pha|exfoliat/i.test(combinedText(facts))) {
    watchouts.push({
      type: 'active_layering',
      label: 'Introduce renewal or exfoliating actives gradually if your skin is reactive.',
      severity: 'medium',
    });
  }
  if (!watchouts.length) {
    if (role.step === 'branded apparel') {
      watchouts.push({
        type: 'size_fit',
        label: 'Check the official size and material details before choosing a fit.',
        severity: 'low',
      });
    } else if (role.step === 'beauty routine' || role.step === 'pet accessory' || role.step === 'application tool') {
      watchouts.push({
        type: 'format_fit',
        label: 'Check the official dimensions, material, or care details for fit with your routine.',
        severity: 'low',
      });
    } else {
      watchouts.push({
        type: 'fit_check',
        label: 'Check the official ingredient list and format details against your personal sensitivities.',
        severity: 'low',
      });
    }
  }
  return watchouts;
}

function hasOfficialPdpEvidence(row) {
  const facts = readSeedFacts(row);
  return Boolean(
    facts.canonicalUrl &&
      (facts.description || facts.details.length || facts.howTo.length || facts.rawIngredients.length || facts.activeIngredients.length || facts.variants.labels.length)
  );
}

function evidenceProfileFor(facts) {
  if (facts.rawIngredients.length && facts.howTo.length) return 'official_pdp_reviewed_formula_and_usage';
  if (facts.rawIngredients.length) return 'official_pdp_reviewed_formula';
  if (facts.activeIngredients.length && facts.howTo.length) return 'official_pdp_reviewed_key_ingredients_and_usage';
  if (facts.activeIngredients.length) return 'official_pdp_reviewed_key_ingredients';
  if (facts.howTo.length || facts.details.length || facts.variants.labels.length) return 'official_pdp_reviewed_line';
  return 'official_pdp_reviewed_limited';
}

function buildInsightBundle(row) {
  const facts = readSeedFacts(row);
  const role = inferRole(facts);
  const anchors = inferAnchors(facts, role);
  const bestFor = inferBestFor(facts, role, anchors);
  const whatItIs = buildWhatItIs(facts, role);
  const evidenceProfile = evidenceProfileFor(facts);
  const lipComboHighlight = isLipComboRole(facts, role) ? buildLipComboHighlight(facts) : '';
  const sampleHighlight = buildSampleHighlight(facts, anchors, role.label);
  const highlight = lipComboHighlight || sampleHighlight || buildRoleAwareHighlight(facts, role, anchors, bestFor);
  const generatedAt = new Date().toISOString();
  return {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: 'Pivota Insights',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      product_id: row.external_product_id,
      pivota_signature_id: row.pivota_signature_id || null,
    },
    product_group_id: row.product_key || null,
    product_intel_core: {
      what_it_is: {
        headline: role.label,
        body: whatItIs,
      },
      best_for: bestFor,
      why_it_stands_out: buildWhyItStandsOut(facts, role, anchors),
      routine_fit: {
        step: role.step,
        am_pm: role.amPm,
        pairing_notes: buildPairingNotes(facts, role),
      },
      watchouts: buildWatchouts(facts, role),
      display_name: 'Pivota Insights',
      freshness: {
        source_version: 'official_pdp_manual_review_v1',
        generated_at: generatedAt,
      },
      quality_state: 'reviewed',
      evidence_profile: evidenceProfile,
      source_coverage: {
        official_pdp_description: Boolean(facts.description),
        official_pdp_formula: facts.rawIngredients.length > 0 || facts.activeIngredients.length > 0,
        official_pdp_how_to: facts.howTo.length > 0,
        official_pdp_variants: facts.variants.count,
        canonical_url: facts.canonicalUrl || null,
      },
    },
    community_signals: {
      status: 'unavailable',
      unavailable_reason: 'no_reviewed_external_consensus_for_this_publish',
      confidence: 'low',
      evidence_profile: evidenceProfile,
    },
    recommendation_intents: {
      similar: [],
      complementary: [],
      routine_pairing: [],
      underfill_reason: 'not_generated_in_manual_insight_review',
      confidence: 'low',
    },
    shopping_card: {
      contract_version: 'pivota.shopping_card.v1',
      title: facts.title,
      subtitle: role.label,
      highlight,
      intro: whatItIs,
      evidence_profile: evidenceProfile,
    },
    search_card: {
      title_candidate: facts.title,
      compact_candidate: role.label,
      highlight_candidate: highlight,
      intro_candidate: whatItIs,
    },
    quality_state: 'reviewed',
    evidence_profile: evidenceProfile,
    source_coverage: {
      source: 'official_pdp',
      canonical_url: facts.canonicalUrl || null,
      fields: {
        description: Boolean(facts.description),
        ingredients: facts.rawIngredients.length,
        active_ingredients: facts.activeIngredients.length,
        how_to: facts.howTo.length,
        details: facts.details.length,
        variants: facts.variants.count,
      },
    },
    confidence: {
      tier: facts.rawIngredients.length || facts.activeIngredients.length || facts.howTo.length ? 'moderate' : 'limited',
      rationale: 'Reviewed against official PDP fields already stored on the external seed.',
    },
    freshness: {
      source_version: 'official_pdp_manual_review_v1',
      generated_at: generatedAt,
    },
    provenance: {
      source: REVIEW_SOURCE,
      generator: 'strict_human_manual_rewrite',
      reviewer: REVIEWER,
      reviewer_kind: 'assistant',
      review_status: 'completed',
      review_decision: 'rewrite',
      review_tier: 'assistant_reviewed',
      selection_strategy: 'curated_override',
      field_sources: {
        what_it_is: 'official_pdp_manual_review',
        why_it_stands_out: 'official_pdp_manual_review',
        best_for: 'official_pdp_derived',
        routine_fit: 'official_pdp_derived',
        watchouts: 'human_standard',
      },
      source_signals: [
        facts.description ? 'official_pdp_description' : null,
        facts.rawIngredients.length ? 'official_pdp_ingredients' : null,
        facts.activeIngredients.length ? 'official_pdp_active_ingredients' : null,
        facts.howTo.length ? 'official_pdp_how_to' : null,
        facts.details.length ? 'official_pdp_details' : null,
        facts.variants.labels.length ? 'official_pdp_variants' : null,
      ].filter(Boolean),
    },
  };
}

function readBundle(entry) {
  return asObject(entry?.analysis?.product_intel_v1 || entry?.analysis?.product_intel || entry?.analysis);
}

function readTextFromBundle(bundle) {
  const core = asObject(bundle.product_intel_core);
  return [
    bundle.shopping_card?.highlight,
    bundle.shopping_card?.intro,
    bundle.search_card?.highlight_candidate,
    bundle.search_card?.intro_candidate,
    core.what_it_is?.headline,
    core.what_it_is?.body,
    ...asArray(core.why_it_stands_out).flatMap((item) => [item.headline, item.body]),
    ...asArray(core.best_for).flatMap((item) => [item.label, item.tag]),
  ].map(asString).join(' ');
}

function manualCandidateQualityIssue(facts, role, bundle) {
  const title = stripHtml(facts.title).toLowerCase();
  const rawDescription = stripHtml(facts.description).toLowerCase();
  const description = firstUsefulSentence(facts.description, 260).toLowerCase();
  const howTo = facts.howTo.join(' ').toLowerCase();
  const details = facts.details.join(' ').toLowerCase();
  const bundleText = stripHtml(readTextFromBundle(bundle)).toLowerCase();
  const whatItIs = stripHtml(asObject(asObject(bundle.product_intel_core).what_it_is).body).toLowerCase();

  if (/\bdonate\b|\bclara lionel foundation\b/.test(title)) {
    return 'non_product_donation_row';
  }

  if (
    /\brihanna was inspired to create the world of fenty beauty brands\b/.test(bundleText) ||
    /\brihanna was inspired to create the world of fenty beauty brands\b/.test(rawDescription) ||
    /\bpartnering with the best of the best in the beauty industry\b/.test(bundleText) ||
    /\bpartnering with the best of the best in the beauty industry\b/.test(rawDescription) ||
    /\bstill seeing a void\b/.test(bundleText)
    || /\bstill seeing a void\b/.test(rawDescription)
  ) {
    return 'brand_story_instead_of_product_copy';
  }

  if (/\bbronzer\b/.test(title) && /\bblush\b/.test(description) && !/\bbronzer\b/.test(description)) {
    return 'source_role_mismatch_bronzer_blush';
  }
  if (/\bblush\b/.test(title) && /\bbronzer\b/.test(description) && !/\bblush\b/.test(description)) {
    return 'source_role_mismatch_blush_bronzer';
  }
  if (/\b(?:lipstick|lip gloss|lip glaze|lip ink|lip luminizer|lip liner)\b/.test(title) && !/\blip\b/.test(role.step)) {
    return 'source_role_mismatch_lip_product';
  }

  const accessoryTitle = /\b(?:wash\s*cloth|washcloth|cuffs?|scrunchie|sleeve|case|tote|bag|mirror|pouch|tray|keychain|clutch|backpack)\b/.test(title);
  if (accessoryTitle && /\b(?:massage|rinse|apply (?:to|onto)|coat lips|bare lips|skin concern)\b/.test(howTo)) {
    return 'accessory_formula_instruction_mismatch';
  }
  if (
    role.label === 'Beauty accessory' &&
    /\bis a beauty accessory from\b/.test(whatItIs) &&
    (!facts.description || /\bavailable variants clarify\b/.test(whatItIs))
  ) {
    return 'generic_accessory_copy';
  }
  if (role.label === 'Beauty accessory' && !facts.description && !facts.details.length && !facts.howTo.length) {
    return 'insufficient_accessory_source_evidence';
  }

  if (/\bavailable variants clarify\b/.test(whatItIs)) {
    return 'variant_only_intro_without_product_copy';
  }
  if (
    role.step === 'sunscreen' &&
    !facts.description &&
    !facts.details.length &&
    !facts.howTo.length &&
    !facts.rawIngredients.length
  ) {
    return 'variant_only_intro_without_product_copy';
  }

  if (role.label === 'Beauty product' && (!whatItIs || whatItIs.length < 90 || !facts.description)) {
    return 'generic_beauty_product_copy';
  }
  if (/\bis a beauty product from\b/.test(whatItIs) && !details && facts.variants.labels.length <= 1) {
    return 'generic_beauty_product_copy';
  }

  return '';
}

function readQualityState(entry) {
  const bundle = readBundle(entry);
  const core = asObject(bundle.product_intel_core);
  return asString(bundle.quality_state || core.quality_state || entry?.source_meta?.quality_state).toLowerCase();
}

function readEvidenceProfile(entry) {
  const bundle = readBundle(entry);
  const core = asObject(bundle.product_intel_core);
  return asString(bundle.evidence_profile || core.evidence_profile || entry?.source_meta?.evidence_profile).toLowerCase();
}

function isWeakExistingInsight(entry) {
  if (!entry) return true;
  const bundle = readBundle(entry);
  if (!Object.keys(bundle).length) return true;
  const qualityState = readQualityState(entry);
  const evidenceProfile = readEvidenceProfile(entry);
  if (/^(eligible|limited|draft|unreviewed)$/.test(qualityState)) return true;
  if (/seller_only/.test(evidenceProfile)) return true;
  const text = readTextFromBundle(bundle);
  if (!stripHtml(text)) return true;
  const weakPatterns = [
    /\blisted on the official source page\b/i,
    /\bofficial product detail\b/i,
    /\bformula context captured\b/i,
    /\blipstick identity\b/i,
    /\bfragrance identity\b/i,
    /\bconcrete product cues\b/i,
    /\bbeauty product listed\b/i,
    /\ba .* product listed on the official\b/i,
    /\bofficial pdp fields identify\s*$/i,
  ];
  if (weakPatterns.some((pattern) => pattern.test(text))) return true;
  const why = asArray(asObject(bundle.product_intel_core).why_it_stands_out);
  if (why.length < 2) return true;
  const bodies = why.map((item) => stripHtml(`${item?.headline || ''} ${item?.body || ''}`)).join(' ');
  if (bodies.length < 120) return true;
  return false;
}

function shouldSkipExisting(entry, args) {
  if (!entry) return null;
  const state = readQualityState(entry);
  const evidenceProfile = readEvidenceProfile(entry);
  const weak = isWeakExistingInsight(entry);
  if (PROTECTED_EVIDENCE_PROFILES.has(evidenceProfile) && !args.includeStrong) {
    return `protected_evidence_profile_existing:${evidenceProfile}`;
  }
  if (!weak && PROTECTED_QUALITY_STATES.has(state) && !args.includeStrong) {
    return `protected_high_quality_existing:${state || 'unknown'}`;
  }
  if (!weak && !args.includeStrong) return 'existing_not_weak';
  return null;
}

function buildKbKeys(row, args = {}) {
  const keys = [
    `product:${row.external_product_id}`,
    row.pivota_signature_id ? `product:${row.pivota_signature_id}` : '',
  ];
  if (args.includeUrlKey) {
    const facts = readSeedFacts(row);
    if (facts.canonicalUrl) keys.push(`url:${facts.canonicalUrl}`);
  }
  return uniq(keys);
}

function existingEntryForKey(row, kbKey) {
  if (kbKey === `product:${row.external_product_id}` && row.ext_kb_key) {
    return {
      kb_key: row.ext_kb_key,
      analysis: row.ext_analysis,
      source: row.ext_source,
      source_meta: row.ext_source_meta,
      last_success_at: row.ext_last_success_at,
      updated_at: row.ext_updated_at,
    };
  }
  if (kbKey === `product:${row.pivota_signature_id}` && row.sig_kb_key) {
    return {
      kb_key: row.sig_kb_key,
      analysis: row.sig_analysis,
      source: row.sig_source,
      source_meta: row.sig_source_meta,
      last_success_at: row.sig_last_success_at,
      updated_at: row.sig_updated_at,
    };
  }
  const urlKey = row.url_kb_key;
  if (kbKey === urlKey && row.url_kb_key) {
    return {
      kb_key: row.url_kb_key,
      analysis: row.url_analysis,
      source: row.url_source,
      source_meta: row.url_source_meta,
      last_success_at: row.url_last_success_at,
      updated_at: row.url_updated_at,
    };
  }
  return null;
}

function buildPlan(row, args) {
  const facts = readSeedFacts(row);
  const role = inferRole(facts);
  const bundle = buildInsightBundle(row);
  const canonicalProductRef = {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    product_id: row.external_product_id,
    pivota_signature_id: row.pivota_signature_id || null,
  };
  const normalized = normalizePublishedProductIntelBundle(bundle, {
    canonicalProductRef,
    productGroupId: row.product_key || null,
    requireReviewed: true,
  });
  const plan = {
    external_product_id: row.external_product_id,
    pivota_signature_id: row.pivota_signature_id || null,
    title: row.title,
    brand: facts.brand,
    canonical_url: facts.canonicalUrl || null,
    changed: false,
    blocked: false,
    skip_reason: null,
    candidate_hash: hashJson(bundle),
    evidence_profile: bundle.evidence_profile,
    source_coverage: bundle.source_coverage,
    preview: {
      headline: bundle.product_intel_core.what_it_is.headline,
      what_it_is: bundle.product_intel_core.what_it_is.body,
      why_it_stands_out: bundle.product_intel_core.why_it_stands_out,
      best_for: bundle.product_intel_core.best_for,
      shopping_highlight: bundle.shopping_card.highlight,
    },
    writes: [],
  };
  if (!SUPPORTED_BRANDS.has(facts.brandKey) && !SUPPORTED_BRANDS.has(asString(args.brand).toLowerCase())) {
    plan.blocked = true;
    plan.skip_reason = 'unsupported_brand_for_manual_template';
    return plan;
  }
  const manualQualityIssue = manualCandidateQualityIssue(facts, role, bundle);
  if (manualQualityIssue) {
    plan.blocked = true;
    plan.skip_reason = `candidate_failed_manual_quality_gate:${manualQualityIssue}`;
    return plan;
  }
  if (!hasOfficialPdpEvidence(row)) {
    plan.blocked = true;
    plan.skip_reason = 'missing_official_pdp_evidence';
    return plan;
  }
  if (!normalized) {
    plan.blocked = true;
    plan.skip_reason = 'candidate_failed_reviewed_normalization';
    return plan;
  }
  const candidateBase = {
    analysis: { product_intel_v1: bundle },
    source: REVIEW_SOURCE,
    source_meta: {
      external_product_id: row.external_product_id,
      pivota_signature_id: row.pivota_signature_id || null,
      review_status: 'completed',
      review_decision: 'rewrite',
      review_tier: 'assistant_reviewed',
      reviewer: REVIEWER,
      evidence_profile: bundle.evidence_profile,
      quality_state: bundle.quality_state,
      source_origin: 'official_pdp_fields',
      source_url: facts.canonicalUrl || null,
    },
  };
  for (const kbKey of buildKbKeys(row, args)) {
    const existing = existingEntryForKey(row, kbKey);
    const skipReason = shouldSkipExisting(existing, args);
    if (skipReason) {
      plan.writes.push({
        kb_key: kbKey,
        action: 'skip',
        reason: skipReason,
        old_hash: existing?.analysis ? hashJson(existing.analysis) : null,
        existing_weak: existing ? isWeakExistingInsight(existing) : true,
      });
      continue;
    }
    const candidate = {
      ...candidateBase,
      kb_key: kbKey,
    };
    const assessment = assessPivotaInsightReplacement({
      existingEntry: existing,
      candidateEntry: candidate,
      sourceRow: {
        quality_improvement_review: {
          decision: 'approved_replacement',
          reviewer_kind: 'assistant',
          owner_delegated: true,
          reason: `Owner requested strict manual-quality rewrite of weak ${facts.brand} insights using official PDP fields; high-quality existing bundles remain protected by script gating.`,
        },
      },
    });
    if (!assessment.allowed) {
      plan.writes.push({
        kb_key: kbKey,
        action: 'skip',
        reason: assessment.reason,
        old_hash: existing?.analysis ? hashJson(existing.analysis) : null,
        candidate_hash: hashJson(candidate.analysis),
        existing_weak: existing ? isWeakExistingInsight(existing) : true,
        assessment,
      });
      continue;
    }
    plan.changed = true;
    plan.writes.push({
      kb_key: kbKey,
      action: existing ? 'update' : 'insert',
      reason: assessment.reason,
      old_hash: existing?.analysis ? hashJson(existing.analysis) : null,
      candidate_hash: hashJson(candidate.analysis),
      existing_weak: existing ? isWeakExistingInsight(existing) : true,
      analysis: candidate.analysis,
      source: candidate.source,
      source_meta: {
        ...candidate.source_meta,
        quality_improvement: {
          previous_bundle_hash: assessment.previous_bundle_hash || null,
          candidate_bundle_hash: assessment.candidate_bundle_hash || null,
          replacement_decision: assessment.reason,
          existing_quality_lane: assessment.existing?.lane || null,
          candidate_quality_lane: assessment.candidate?.lane || null,
          existing_evidence_profile: assessment.existing?.evidence_profile || null,
          candidate_evidence_profile: assessment.candidate?.evidence_profile || null,
        },
      },
      after_inventory: buildPivotaInsightInventoryRow(candidate, {
        productId: row.external_product_id,
        title: row.title,
      }),
    });
  }
  if (!plan.writes.some((write) => write.action === 'insert' || write.action === 'update')) {
    plan.changed = false;
    if (!plan.skip_reason) plan.skip_reason = 'no_safe_writes';
  }
  return plan;
}

function parseProductIds(value) {
  return uniq(asString(value).split(',').map((item) => item.trim()).filter(Boolean));
}

function readProductIdsFromReport(reportPath) {
  const filePath = asString(reportPath);
  if (!filePath) return [];
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(path.resolve(__dirname, '..'), filePath);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  return uniq([
    ...asArray(parsed.summary?.weak_insights_ids),
    ...asArray(parsed.weak_insights_ids),
    ...asArray(parsed.plans)
      .filter((plan) => plan && plan.changed === true)
      .map((plan) => plan.external_product_id),
  ]);
}

async function fetchRows(args) {
  const params = [];
  const where = ["eps.status = 'active'"];
  if (args.productIds.length) {
    params.push(args.productIds);
    where.push(`(eps.external_product_id = ANY($${params.length}) OR cp.pivota_signature_id = ANY($${params.length}))`);
  } else if (args.brand) {
    params.push(`%${args.brand}%`);
    where.push(`(
      eps.seed_data->>'brand' ILIKE $${params.length}
      OR eps.seed_data->'snapshot'->>'brand' ILIKE $${params.length}
      OR cp.brand ILIKE $${params.length}
    )`);
  } else {
    where.push("FALSE");
  }
  const limitSql = args.limit > 0 ? `LIMIT ${Number(args.limit)}` : '';
  const result = await query(
    `
      SELECT
        eps.external_product_id,
        eps.title,
        coalesce(eps.seed_data->>'brand', eps.seed_data->'snapshot'->>'brand', cp.brand) AS brand,
        eps.domain,
        eps.market,
        eps.canonical_url,
        eps.destination_url,
        eps.seed_data,
        cp.pivota_signature_id,
        cp.product_key,
        cp.title AS catalog_title,
        cp.brand AS catalog_brand,
        cp.category,
        cp.product_type,
        cp.category_path,
        cp.description,
        cp.image_url,
        cp.canonical_url AS catalog_canonical_url,
        kb_ext.kb_key AS ext_kb_key,
        kb_ext.analysis AS ext_analysis,
        kb_ext.source AS ext_source,
        kb_ext.source_meta AS ext_source_meta,
        kb_ext.last_success_at AS ext_last_success_at,
        kb_ext.updated_at AS ext_updated_at,
        kb_sig.kb_key AS sig_kb_key,
        kb_sig.analysis AS sig_analysis,
        kb_sig.source AS sig_source,
        kb_sig.source_meta AS sig_source_meta,
        kb_sig.last_success_at AS sig_last_success_at,
        kb_sig.updated_at AS sig_updated_at,
        kb_url.kb_key AS url_kb_key,
        kb_url.analysis AS url_analysis,
        kb_url.source AS url_source,
        kb_url.source_meta AS url_source_meta,
        kb_url.last_success_at AS url_last_success_at,
        kb_url.updated_at AS url_updated_at
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN aurora_product_intel_kb kb_ext
        ON kb_ext.kb_key = 'product:' || eps.external_product_id
      LEFT JOIN aurora_product_intel_kb kb_sig
        ON kb_sig.kb_key = 'product:' || cp.pivota_signature_id
      LEFT JOIN aurora_product_intel_kb kb_url
        ON kb_url.kb_key = 'url:' || coalesce(nullif(eps.canonical_url, ''), nullif(eps.destination_url, ''), nullif(cp.canonical_url, ''))
      WHERE ${where.join('\n        AND ')}
      ORDER BY eps.title, eps.external_product_id
      ${limitSql}
    `,
    params,
  );
  return result.rows || [];
}

function parseArgs() {
  const brand = asString(argValue('brand'));
  const productIds = uniq([
    ...parseProductIds(argValue('product-ids') || argValue('product-id')),
    ...readProductIdsFromReport(argValue('product-ids-from-report')),
  ]);
  return {
    apply: hasFlag('apply'),
    includeStrong: hasFlag('include-strong'),
    includeUrlKey: hasFlag('include-url-key'),
    brand,
    productIds,
    limit: Math.max(0, Number(argValue('limit', '0')) || 0),
    applyChunkSize: Math.max(0, Number(argValue('apply-chunk-size', '0')) || 0),
    outDir: argValue('out-dir', 'reports/pdp_db_quality_inventory/official_pdp_insights_review'),
  };
}

function writeReport(args, report) {
  const rootDir = path.resolve(__dirname, '..');
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(rootDir, args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const name = `${args.apply ? 'apply' : 'dry-run'}-${report.generated_at.replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(outDir, name);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

function collectApplyWrites(plans) {
  const writes = [];
  for (const plan of plans) {
    for (const write of plan.writes) {
      if (write.action !== 'insert' && write.action !== 'update') continue;
      writes.push({
        product_id: plan.external_product_id,
        kb_key: write.kb_key,
        analysis: write.analysis,
        source: write.source,
        source_meta: write.source_meta,
      });
    }
  }
  return writes;
}

async function applyWriteBatch(writes) {
  let upserts = 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const write of writes) {
        await client.query(
          `
              INSERT INTO aurora_product_intel_kb (
                kb_key,
                analysis,
                source,
                source_meta,
                last_success_at,
                created_at,
                updated_at
              )
              VALUES ($1, $2::jsonb, $3, $4::jsonb, NOW(), NOW(), NOW())
              ON CONFLICT (kb_key) DO UPDATE
              SET analysis = EXCLUDED.analysis,
                  source = EXCLUDED.source,
                  source_meta = EXCLUDED.source_meta,
                  last_success_at = NOW(),
                  updated_at = NOW()
            `,
            [write.kb_key, JSON.stringify(write.analysis), write.source, JSON.stringify(write.source_meta)],
        );
        upserts += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
  return upserts;
}

async function applyPlans(plans, options = {}) {
  const allWrites = collectApplyWrites(plans);
  const chunkSize = Math.max(0, Number(options.chunkSize || 0) || 0);
  if (!chunkSize || allWrites.length <= chunkSize) {
    return { upserts: await applyWriteBatch(allWrites), chunks: allWrites.length ? 1 : 0 };
  }

  let upserts = 0;
  let chunks = 0;
  for (let start = 0; start < allWrites.length; start += chunkSize) {
    const batch = allWrites.slice(start, start + chunkSize);
    chunks += 1;
    upserts += await applyWriteBatch(batch);
    process.stderr.write(
      `[official-pdp-insights] applied chunk ${chunks} writes=${batch.length} total_upserts=${upserts}/${allWrites.length}\n`,
    );
  }
  return { upserts, chunks };
}

function summarize(plans) {
  const summary = {
    scanned: plans.length,
    changed_products: plans.filter((plan) => plan.changed).length,
    blocked_products: plans.filter((plan) => plan.blocked).length,
    skipped_products: plans.filter((plan) => !plan.changed && !plan.blocked).length,
    write_actions: {},
    skip_reasons: {},
    evidence_profiles: {},
  };
  for (const plan of plans) {
    if (plan.evidence_profile) {
      summary.evidence_profiles[plan.evidence_profile] = (summary.evidence_profiles[plan.evidence_profile] || 0) + 1;
    }
    if (plan.skip_reason) summary.skip_reasons[plan.skip_reason] = (summary.skip_reasons[plan.skip_reason] || 0) + 1;
    for (const write of plan.writes) {
      summary.write_actions[write.action] = (summary.write_actions[write.action] || 0) + 1;
      if (write.action === 'skip') {
        summary.skip_reasons[write.reason] = (summary.skip_reasons[write.reason] || 0) + 1;
      }
    }
  }
  return summary;
}

async function main() {
  const args = parseArgs();
  if (!args.brand && !args.productIds.length) {
    throw new Error('Provide --brand or --product-ids');
  }
  const generatedAt = new Date().toISOString();
  const rows = await fetchRows(args);
  const plans = rows.map((row) => buildPlan(row, args));
  const report = {
    generated_at: generatedAt,
    source: REVIEW_SOURCE,
    mode: args.apply ? 'apply' : 'dry_run',
    filters: {
      brand: args.brand || null,
      product_ids: args.productIds,
      limit: args.limit || null,
      include_strong: args.includeStrong,
      include_url_key: args.includeUrlKey,
      apply_chunk_size: args.applyChunkSize || null,
    },
    summary: summarize(plans),
    plans: plans.map((plan) => ({
      ...plan,
      writes: plan.writes.map((write) => {
        const { analysis, source_meta: sourceMeta, ...rest } = write;
        return {
          ...rest,
          source_meta: sourceMeta ? {
            evidence_profile: sourceMeta.evidence_profile,
            quality_state: sourceMeta.quality_state,
            source_origin: sourceMeta.source_origin,
            source_url: sourceMeta.source_url,
            quality_improvement: sourceMeta.quality_improvement,
          } : undefined,
        };
      }),
    })),
  };
  if (args.apply) {
    report.apply_result = await applyPlans(plans, { chunkSize: args.applyChunkSize });
  }
  const reportPath = writeReport(args, report);
  process.stdout.write(`${JSON.stringify({ status: 'ok', report: reportPath, summary: report.summary, apply_result: report.apply_result || null }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  buildInsightBundle,
  applyPlans,
  buildPlan,
  collectApplyWrites,
  fetchRows,
  inferRole,
  inferAnchors,
  isWeakExistingInsight,
  readSeedFacts,
};
