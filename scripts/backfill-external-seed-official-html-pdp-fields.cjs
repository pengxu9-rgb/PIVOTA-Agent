#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { query, closePool } = require('../src/db');

const CONTRACT_VERSION = 'external_seed.official_html_pdp_fields.v1';
const PDP_CONTENT_ASSET_VERSION = 'pivota.pdp_content_asset.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const SHOPIFY_PRODUCT_JSON_VARIANT_HOSTS = new Set(['medicube.us', 'skin1004.com', 'tirtir.global']);
const REVIEW_SUMMARY_ONLY_OKENDO_HOSTS = new Set(['beautyofjoseon.com', 'kravebeauty.com']);
const REVIEW_SUMMARY_ONLY_GENERIC_HOSTS = new Set([...REVIEW_SUMMARY_ONLY_OKENDO_HOSTS, 'roundlab.com']);

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return '';
  return String(value).trim();
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return normalizeText(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, ' - ')
    .replace(/&deg;/gi, '°')
    .replace(/&times;/gi, 'x')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const codePoint = Number.parseInt(dec, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    });
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|div|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseDelimitedIds(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function readIdsFile(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized) return [];
  return parseDelimitedIds(fs.readFileSync(normalized, 'utf8'));
}

function stringifyPostgresJsonb(value) {
  let text = JSON.stringify(value || {});
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/\\+u0000/gi, '')
      .replace(/\u0000/g, '');
  }
  return text;
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pickRowUrl(row) {
  const seedData = ensureObject(row.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  for (const value of [
    row.canonical_url,
    row.destination_url,
    seedData.canonical_url,
    snapshot.canonical_url,
    seedData.destination_url,
    snapshot.destination_url,
  ]) {
    const text = normalizeText(value);
    if (/^https?:\/\//i.test(text)) return text;
  }
  return '';
}

function normalizeTitleTokens(value) {
  return Array.from(
    new Set(
      normalizeText(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !['the', 'and', 'with', 'for'].includes(token)),
    ),
  );
}

function scoreProductTitleMatch(sourceTitle, productTitle) {
  const sourceTokens = normalizeTitleTokens(sourceTitle);
  const productTokens = new Set(normalizeTitleTokens(productTitle));
  if (!sourceTokens.length || !productTokens.size) return 0;
  const shared = sourceTokens.filter((token) => productTokens.has(token)).length;
  return shared / Math.max(1, sourceTokens.length);
}

function buildShopifyProductJsonUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('.js')) url.pathname = `${url.pathname.replace(/\/+$/, '')}.js`;
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeShopifyProductJsonPrice(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (raw.includes('.')) return parsed;
  return Math.round((parsed / 100) * 100) / 100;
}

function isDisplayableShopifyVariantOption(option) {
  const name = normalizeText(option?.name);
  const value = normalizeText(option?.value);
  if (!name || !value) return false;
  if (/^(?:default|default title|title|single|n\/a)$/i.test(value)) return false;
  if (/^(?:default|default title|title)$/i.test(name) && /^(?:default|default title|title)$/i.test(value)) return false;
  return true;
}

function normalizeSpecLabel(value) {
  return normalizeText(value)
    .replace(/\b(\d+(?:\.\d+)?)\s*(ml|mL|ML)\b/g, '$1ml')
    .replace(/\b(\d+(?:\.\d+)?)\s*(g|G)\b/g, '$1g')
    .replace(/\bfl\.?\s*oz\.?\b/gi, 'fl oz')
    .replace(/\bpcs?\b/gi, 'pcs')
    .replace(/\bea\b/gi, 'ea')
    .replace(/\bct\b/gi, 'ct')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractSpecLabelFromText(value, options = {}) {
  const text = stripHtml(value);
  if (!text) return '';
  const requireLabel = Boolean(options.requireLabel);
  const labelPattern = /\b(?:size|net\s*(?:wt|weight|contents?)|contents?|volume|capacity|amount|quantity|count|includes?|pack(?:age)?(?:\s+includes?)?)\b/i;
  const lines = text
    .split(/[\n\r]+|(?<=\.)\s+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const patterns = [
    /\b\d+(?:\.\d+)?\s*(?:ml|mL|ML|g|G|grams?|oz|fl\.?\s*oz\.?)\b/i,
    /\b\d+\s*(?:\+|x|×)\s*\d+\s*(?:ea|pcs?|pieces?|pads?|sheets?|patches?|masks?|pairs?|count|ct)\b/i,
    /\b\d+(?:\.\d+)?\s*(?:ea|pcs?|pieces?|pads?|sheets?|patches?|masks?|pairs?|count|ct)\b/i,
  ];
  for (const line of lines) {
    if (requireLabel && !labelPattern.test(line)) continue;
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const label = normalizeSpecLabel(match[0]);
      if (label) return label;
    }
  }
  return '';
}

function deriveOfficialSingletonVariantOption(product, variant, options = {}) {
  const productOptions = asArray(product.options);
  const optionName = normalizeText(productOptions[0]?.name);
  const titleSpec = extractSpecLabelFromText(
    [
      variant?.title && !/^(?:default|default title|title)$/i.test(normalizeText(variant.title)) ? variant.title : '',
      product.title,
      options.productTitle,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const descriptionSpec = extractSpecLabelFromText(product.description || product.body_html || '', {
    requireLabel: true,
  });
  const value = titleSpec || descriptionSpec;
  if (!value) return null;
  return {
    name: /(?:ea|pcs|piece|pad|sheet|patch|mask|pair|count|ct|\+|x|×)/i.test(value)
      ? 'Pack'
      : optionName && !/^(?:default|default title|title)$/i.test(optionName)
        ? optionName
        : 'Size',
    value,
  };
}

function extractOfficialShopifyVariants(productJson, options = {}) {
  const product = ensureObject(productJson);
  const rawVariants = asArray(product.variants);
  if (rawVariants.length === 0) return [];
  const productTitle = normalizeText(options.productTitle);
  if (productTitle && scoreProductTitleMatch(productTitle, product.title) < 0.75) return [];

  const productOptions = asArray(product.options);
  const imageUrls = asArray(product.images)
    .map((image) => (typeof image === 'string' ? image : image?.src || image?.url))
    .map((image) => normalizeText(image))
    .filter(Boolean);
  const currency = normalizeText(options.currency || 'USD').toUpperCase();
  const productUrl = normalizeText(options.productUrl);

  const variants = rawVariants
    .map((variant) => {
      if (!variant || typeof variant !== 'object') return null;
      const variantId = normalizeText(variant.id || variant.variant_id);
      if (!variantId) return null;
      const optionEntries = [variant.option1, variant.option2, variant.option3]
        .map((value, index) => ({
          name: normalizeText(productOptions[index]?.name || `Option ${index + 1}`),
          value: normalizeText(value),
        }))
        .filter(isDisplayableShopifyVariantOption);
      let sourceOrigin = 'official_shopify_product_json';
      if (!optionEntries.length && rawVariants.length === 1) {
        const derived = deriveOfficialSingletonVariantOption(product, variant, options);
        if (derived) {
          optionEntries.push(derived);
          sourceOrigin = 'official_shopify_product_json_singleton_spec';
        }
      }
      if (!optionEntries.length) return null;

      const imageUrl =
        normalizeText(variant.featured_image?.src || variant.featured_image?.url || variant.image || '') ||
        imageUrls[0] ||
        '';
      const price = normalizeShopifyProductJsonPrice(variant.price);
      return {
        id: variantId,
        variant_id: variantId,
        sku: normalizeText(variant.sku) || variantId,
        title: normalizeText(variant.title) || optionEntries.map((entry) => entry.value).join(' / '),
        options: optionEntries,
        option_name: optionEntries.length === 1 ? optionEntries[0].name : undefined,
        option_value: optionEntries.length === 1 ? optionEntries[0].value : undefined,
        ...(price != null ? { price, price_amount: price, currency } : {}),
        ...(typeof variant.available === 'boolean' ? { available: variant.available, in_stock: variant.available } : {}),
        ...(variant.inventory_quantity != null ? { inventory_quantity: variant.inventory_quantity } : {}),
        ...(imageUrl ? { image_url: imageUrl, image_urls: [imageUrl], images: [imageUrl] } : {}),
        ...(productUrl ? { product_url: productUrl, deep_link: `${productUrl}${productUrl.includes('?') ? '&' : '?'}variant=${variantId}` } : {}),
        source_origin: sourceOrigin,
        source_quality_status: 'high',
      };
    })
    .filter(Boolean);

  if (rawVariants.length === 1) return variants.length === 1 ? variants : [];
  return variants.length > 1 ? variants : [];
}

function hashContent(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function looksLikeFullInci(value) {
  const text = normalizeText(value);
  if (text.length < 120) return false;
  const commaCount = (text.match(/,/g) || []).length;
  if (commaCount < 8) return false;
  if (/\b(?:cart|checkout|shipping|customer service|menu|ambassador)\b/i.test(text.slice(0, 250))) return false;
  return /\b(?:water|aqua|glycerin|butylene glycol|niacinamide|extract|acid|sodium|potassium|glycol|fragrance|tocopherol)\b/i.test(text);
}

function looksLikeShortOfficialInci(value) {
  const text = normalizeText(value);
  if (text.length < 35 || text.length > 220) return false;
  if ((text.match(/,/g) || []).length < 2) return false;
  if (/\b(?:cart|checkout|shipping|customer service|menu|ambassador|swiper|document\.addEventListener)\b/i.test(text)) return false;
  return /\b(?:polyisobutene|cellulose gum|pectin|copolymer|hydrocolloid|glycerin|water|aqua|sodium|acid)\b/i.test(text);
}

function looksLikeHowToUse(value) {
  const text = normalizeText(value);
  if (text.length < 45 || text.length > 1600) return false;
  if (/\b(?:checkout|shop all|ambassador|find your routine|mega menu|header menu)\b/i.test(text)) return false;
  return /\b(?:apply|use|massage|rinse|spray|sweep|wipe|shake|dispense|after cleansing|after completing|before|daily|morning|evening|night|leave on|pat)\b/i.test(text);
}

function looksLikeActiveIngredientList(value) {
  const text = normalizeText(value);
  if (text.length < 8 || text.length > 500) return false;
  if (/\b(?:cart|checkout|shipping|customer service|menu|ambassador|find your routine)\b/i.test(text)) return false;
  return /\b(?:ascorbic acid|niacinamide|salicylic acid|centella|tea tree|retinol|retinal|hyaluronic acid|panthenol|ceramide|peptide|vitamin c)\b/i.test(text);
}

function extractKnownHeroIngredients(value) {
  const text = normalizeText(value);
  const known = [
    'Ascorbic Acid',
    'Niacinamide',
    'Salicylic Acid',
    'Centella Asiatica Extract',
    'Tea Tree Extract',
    'Hyaluronic Acid',
    'Panthenol',
    'Ceramide',
    'Peptide',
    'Bakuchiol',
    'Retinol',
    'Azelaic Acid',
    'Glutathione',
  ];
  return known.filter((item) => new RegExp(`\\b${item.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text));
}

function looksLikeMedicubeIngredientName(value) {
  const text = normalizeText(value)
    .replace(/^\*+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 3 || text.length > 120) return false;
  if (/[.!?]/.test(text)) return false;
  if (/\b(?:helps?|boosts?|supports?|improves?|enhances?|provides?|protects?|targets?|soothes?|hydrates?)\b/i.test(text)) return false;
  return /\b(?:acid|extract|collagen|niacinamide|glutathione|vitamin|ceramide|panthenol|peptide|retinol|retinal|bakuchiol|hyaluronate|hyaluronic|cica|centella|pantothenic|buckthorn|exosome|salmon|pdrn)\b/i.test(text);
}

function extractMedicubeIngredientNameItems(htmlBlock) {
  return Array.from(String(htmlBlock || '').matchAll(/<div[^>]*class="[^"]*\bdesc_tit\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi))
    .map((match) => cleanSectionText(match[1]).replace(/\bcheck button\b/gi, '').trim())
    .filter(looksLikeMedicubeIngredientName);
}

function cleanSectionText(value) {
  return normalizeText(stripHtml(value))
    .replace(/\bSee All\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeJsonStringFragment(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw
      .replace(/\\u003c/gi, '<')
      .replace(/\\u003e/gi, '>')
      .replace(/\\u0026/gi, '&')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n');
  }
}

function extractShopifyProductDescriptionHtml(html) {
  const matches = String(html || '').matchAll(/"description"\s*:\s*"((?:\\.|[^"\\])*)"/g);
  for (const match of matches) {
    const decoded = decodeJsonStringFragment(match[1]);
    if (/\b(?:product__description|What It Is|Skin Concern|Product Benefits|Key Ingredients)\b/i.test(decoded)) {
      return decoded;
    }
  }
  return '';
}

function extractStrongLabeledParagraphSections(htmlFragment, allowedHeadings = []) {
  const allowed = new Set(allowedHeadings.map((item) => normalizeText(item).toLowerCase()));
  const sections = [];
  for (const match of String(htmlFragment || '').matchAll(/<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>([\s\S]*?)<\/p>/gi)) {
    const heading = cleanSectionText(match[1]).replace(/:$/, '').trim();
    const body = cleanSectionText(match[2]);
    if (!heading || body.length < 8) continue;
    if (allowed.size && !allowed.has(heading.toLowerCase())) continue;
    sections.push({ heading, body });
  }
  return sections;
}

const MEDICUBE_TOGGLE_LABELS = [
  'OVERVIEW',
  'STUDY RESULTS',
  'KEY INGREDIENTS',
  'FULL INGREDIENTS',
  'FORMULATED WITHOUT',
  'HOW TO APPLY',
  'HOW TO USE',
  'CLINICAL TEST',
  'WHY IS IT SPECIAL',
  'FAQ',
  'RECOMMENDED FOR',
];

function extractMedicubeLabeledBlock(html, label) {
  const source = String(html || '');
  const normalizedLabel = normalizeText(label).toUpperCase();
  const comments = Array.from(source.matchAll(/<!--\s*([A-Z][A-Z\s]+)\s*-->/gi))
    .map((match) => ({
      index: match.index,
      label: normalizeText(match[1]).toUpperCase(),
    }))
    .filter((match) => MEDICUBE_TOGGLE_LABELS.includes(match.label));
  const start = comments.find((match) => match.label === normalizedLabel);
  if (start) {
    const next = comments.find((match) => match.index > start.index && match.label !== normalizedLabel);
    return next ? source.slice(start.index, next.index) : source.slice(start.index, start.index + 7000);
  }

  const labelPattern = escapeRegExp(label).replace(/\s+/g, '\\s+');
  const anchorRe = new RegExp(
    `<a\\b[^>]*class="[^"]*\\bplus-minus-toggle\\b[^"]*"[^>]*>\\s*${labelPattern}\\s*<\\/a>`,
    'i',
  );
  const anchor = anchorRe.exec(source);
  if (!anchor) return '';
  const divStart = source.lastIndexOf('<div', anchor.index);
  const startIndex = divStart >= 0 && /class="[^"]*\btoggle_box\b/i.test(source.slice(divStart, anchor.index + anchor[0].length))
    ? divStart
    : anchor.index;
  const afterAnchor = anchor.index + anchor[0].length;
  const nextToggle = source.slice(afterAnchor).search(/<div\b[^>]*class="[^"]*\btoggle_box\b/i);
  const endIndex = nextToggle >= 0 ? afterAnchor + nextToggle : startIndex + 7000;
  return source.slice(startIndex, endIndex);
}

function cleanMedicubeToggleText(value, label = '') {
  const labelRe = label ? new RegExp(`^\\s*${escapeRegExp(label).replace(/\s+/g, '\\s+')}\\s*`, 'i') : null;
  let text = cleanSectionText(value)
    .replace(/\bplus-minus-toggle\b/gi, ' ')
    .replace(/\bFull Ingredients\b/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (labelRe) text = text.replace(labelRe, '').trim();
  return text;
}

function normalizeHowToUseCandidate(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= 1500) return text;
  return `${text.slice(0, 1490).replace(/\s+\S*$/, '')}...`;
}

function extractFirstParagraphAfter(html, markerRe) {
  const match = markerRe.exec(html);
  if (!match) return '';
  const slice = html.slice(match.index, match.index + 5000);
  const paragraph = slice.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return paragraph ? cleanSectionText(paragraph[1]) : '';
}

function extractInlineTextAfterMarker(html, markerRe, stopRe = /<section\b|<script\b|document\.addEventListener|<\/section>/i) {
  const match = markerRe.exec(html);
  if (!match) return '';
  const slice = html.slice(match.index + match[0].length, match.index + match[0].length + 2500);
  const stop = slice.search(stopRe);
  const raw = stop >= 0 ? slice.slice(0, stop) : slice;
  return cleanSectionText(raw);
}

function extractSkin1004Fields(html) {
  const fields = {};
  const descriptionSections = extractStrongLabeledParagraphSections(
    extractShopifyProductDescriptionHtml(html),
    ['What It Is', 'Skin Concern', 'Product Benefits', 'Key Ingredients'],
  );
  if (descriptionSections.length) {
    fields.pdp_details_sections = descriptionSections;
    const keyIngredients = descriptionSections.find((section) => /^key ingredients$/i.test(section.heading));
    if (keyIngredients?.body && looksLikeActiveIngredientList(keyIngredients.body)) {
      fields.pdp_active_ingredients_raw = keyIngredients.body;
    }
  }

  const fullIngredients =
    extractFirstParagraphAfter(html, /FULL INGREDIENTS/i) ||
    extractInlineTextAfterMarker(html, /FULL INGREDIENTS/i);
  if (looksLikeFullInci(fullIngredients) || looksLikeShortOfficialInci(fullIngredients)) {
    fields.pdp_ingredients_raw = fullIngredients;
  }

  const howMatch = html.match(/\bHOW TO USE\b[\s\S]{0,5000}?<div[^>]*class="[^"]*prhow-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const howTo = howMatch ? cleanSectionText(howMatch[1]) : '';
  if (looksLikeHowToUse(howTo)) fields.pdp_how_to_use_raw = howTo;

  const review = parseMetafieldReviews(html);
  if (review) fields.review_summary = review;
  return fields;
}

function extractMedicubeFields(html) {
  const fields = {};
  const fullIngredientsBlock = extractMedicubeLabeledBlock(html, 'FULL INGREDIENTS');
  const ingredientMatch = html.match(/<div[^>]*class="[^"]*\bwrite\b[^"]*"[^>]*id="test"[\s\S]*?<p[^>]*class="[^"]*\bdesc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const fullIngredientCandidates = [
    cleanMedicubeToggleText(fullIngredientsBlock, 'FULL INGREDIENTS'),
    ingredientMatch ? cleanSectionText(ingredientMatch[1]) : '',
  ];
  const fullIngredients = fullIngredientCandidates.find((candidate) => looksLikeFullInci(candidate)) || '';
  if (looksLikeFullInci(fullIngredients)) fields.pdp_ingredients_raw = fullIngredients;

  const keyIngredientsHtml = extractMedicubeLabeledBlock(html, 'KEY INGREDIENTS');
  const keyIngredientsToggle = cleanMedicubeToggleText(keyIngredientsHtml, 'KEY INGREDIENTS');
  const keyIngredientBlock = extractInlineTextAfterMarker(
    html,
    /\b(?:Key|Main) Ingredients?\b/i,
    /\bBenefits\b|\bHow to use\b|<section\b|<script\b|<\/section>/i,
  );
  const activeIngredientSource = keyIngredientsToggle || keyIngredientBlock;
  const activeItems = Array.from(
    new Set(
      [
        ...extractKnownHeroIngredients(activeIngredientSource),
        ...extractMedicubeIngredientNameItems(keyIngredientsHtml),
        ...(keyIngredientsHtml
          ? []
          : activeIngredientSource
              .split(/\n|>|•|\u2022|,/)
              .map((item) => normalizeText(item).replace(/\s+(?:improve|brightening|spot|targeting|red|dark).*/i, '').trim())
              .filter((item) => looksLikeActiveIngredientList(item))),
      ],
    ),
  );
  if (activeItems.length) {
    fields.pdp_active_ingredients_raw = activeItems.join(', ');
  }

  const labeledHowTo = normalizeHowToUseCandidate(
    cleanMedicubeToggleText(
      extractMedicubeLabeledBlock(html, 'HOW TO APPLY') || extractMedicubeLabeledBlock(html, 'HOW TO USE'),
      extractMedicubeLabeledBlock(html, 'HOW TO APPLY') ? 'HOW TO APPLY' : 'HOW TO USE',
    ),
  );
  if (looksLikeHowToUse(labeledHowTo)) fields.pdp_how_to_use_raw = labeledHowTo;

  const stripped = stripHtml(html);
  if (!fields.pdp_how_to_use_raw) {
    const howMatches = Array.from(stripped.matchAll(/\bHOW TO (?:USE|APPLY)\b/gi));
    for (const howMatch of howMatches) {
      if (howMatch.index < 2500) continue;
      const howSlice = stripped
        .slice(howMatch.index, howMatch.index + 1900)
        .replace(/^HOW TO (?:USE|APPLY)\s*/i, '')
        .split(/\b(?:FAQ|KEY INGREDIENTS|MAIN INGREDIENTS|FULL INGREDIENTS|CLINICAL TEST|STUDY RESULTS|REVIEW|WHAT'S IN IT|WHAT IS IT|FOR MAXIMUM|MEDICUBE DELIVERS)\b|✔/i)[0];
      const howTo = normalizeHowToUseCandidate(howSlice);
      if (looksLikeHowToUse(howTo)) {
        fields.pdp_how_to_use_raw = howTo;
        break;
      }
    }
  }

  const details = [];
  const overviewBlock = cleanMedicubeToggleText(extractMedicubeLabeledBlock(html, 'OVERVIEW'), 'OVERVIEW');
  if (overviewBlock) {
    const body = overviewBlock.length > 1400 ? truncateOfficialDetailText(overviewBlock) : overviewBlock;
    if (body.length >= 60) {
      fields.pdp_description_raw = body;
      details.push({ heading: 'Overview', body });
    }
  }
  const studyResultsBlock = cleanMedicubeToggleText(
    extractMedicubeLabeledBlock(html, 'STUDY RESULTS'),
    'STUDY RESULTS',
  );
  if (studyResultsBlock) {
    const body = studyResultsBlock.length > 1400 ? truncateOfficialDetailText(studyResultsBlock) : studyResultsBlock;
    if (body.length >= 60 && /\b(?:result|study|test|improvement|hydration|texture|tone|glow|elasticity)\b/i.test(body)) {
      details.push({ heading: 'Study Results', body });
    }
  }
  if (keyIngredientsToggle) {
    const body = keyIngredientsToggle.length > 1400 ? truncateOfficialDetailText(keyIngredientsToggle) : keyIngredientsToggle;
    if (body.length >= 40) details.push({ heading: 'Key Ingredients', body });
  }
  const keyIngredientsBlock = keyIngredientsToggle ? '' : extractMedicubeCommentBlock(html, 'KEY INGREDIENTS', 'CLINICAL TEST');
  if (keyIngredientsBlock) {
    const body = cleanSectionText(keyIngredientsBlock).replace(/\bFull Ingredients\b/gi, '').trim();
    if (body.length >= 60) details.push({ heading: 'Key Ingredients', body });
  }
  const clinicalBlock = extractMedicubeCommentBlock(html, 'CLINICAL TEST', 'product__description');
  if (clinicalBlock) {
    const body = cleanSectionText(clinicalBlock);
    if (body.length >= 60 && /\b(?:clinical|improvement|trial|test|hydration|texture|tone|glow)\b/i.test(body)) {
      details.push({ heading: 'Clinical Test', body });
    }
  }
  if (details.length > 0) fields.pdp_details_sections = details;
  return fields;
}

function extractMedicubeCommentBlock(html, startLabel, endLabel) {
  const start = html.search(new RegExp(`<!--\\s*${startLabel}\\s*-->`, 'i'));
  if (start < 0) return '';
  const rest = html.slice(start);
  const end = rest.search(new RegExp(`<!--\\s*${endLabel}\\s*-->|class="[^"]*${endLabel}`, 'i'));
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 4000);
}

function extractHtmlClassBlock(html, classToken, maxChars = 45000) {
  const match = html.match(new RegExp(`<div[^>]+class="[^"]*\\b${classToken}\\b[^"]*"[^>]*>`, 'i'));
  if (!match) return '';
  const start = match.index;
  const rest = html.slice(start, start + maxChars);
  const next = rest.slice(match[0].length).search(/<div[^>]+class="[^"]*\btab-content\s+tab-content-\d+\b/i);
  return next >= 0 ? rest.slice(0, match[0].length + next) : rest;
}

function normalizeTirtirFaqText(tabText) {
  return normalizeText(tabText)
    .replace(/\bRead more\b/gi, '')
    .replace(/(?:^|\n)\s*>\s*/g, '\n')
    .replace(/[ \t]*>[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function collectTirtirFaqEntries(tabText) {
  const normalized = normalizeTirtirFaqText(tabText);
  if (!normalized) return [];

  const entries = [];
  for (const match of normalized.matchAll(/Q:\s*([\s\S]*?)\s*A:\s*([\s\S]*?)(?=\s*Q:\s*|$)/gi)) {
    const question = normalizeText(match[1]);
    const answer = normalizeText(match[2]);
    if (question && answer) entries.push({ question, answer });
  }

  const numberedMatches = Array.from(normalized.matchAll(/(?:^|\n)\s*Q(?:uestion)?\s*\d*\s*[\.:]\s*/gi));
  for (let index = 0; index < numberedMatches.length; index += 1) {
    const start = numberedMatches[index].index + numberedMatches[index][0].length;
    const end = index + 1 < numberedMatches.length ? numberedMatches[index + 1].index : normalized.length;
    const block = normalizeText(normalized.slice(start, end));
    if (!block) continue;
    const questionEnd = block.indexOf('?');
    let question = '';
    let answer = '';
    if (questionEnd >= 0) {
      question = normalizeText(block.slice(0, questionEnd + 1));
      answer = normalizeText(block.slice(questionEnd + 1));
    } else {
      const [firstLine, ...rest] = block.split('\n');
      question = normalizeText(firstLine);
      answer = normalizeText(rest.join('\n'));
    }
    answer = answer.replace(/^A\s*[:.]?\s*/i, '').trim();
    if (question && answer) entries.push({ question, answer });
  }

  return entries;
}

function extractTirtirFaqHowToUse(tabText) {
  const entries = collectTirtirFaqEntries(tabText);
  for (const { question, answer } of entries) {
    if (!/\b(?:how|use|apply|wear|layer|routine)\b/i.test(question)) continue;
    if (looksLikeHowToUse(answer)) return answer;
  }
  return '';
}

function truncateOfficialDetailText(value) {
  const text = normalizeText(value).replace(/\bRead more\b/gi, '').trim();
  if (text.length < 120) return '';
  return text.length > 1400 ? `${text.slice(0, 1397).replace(/\s+\S*$/, '')}...` : text;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);
  return rows.filter((items) => items.some((item) => normalizeText(item)));
}

function extractTirtirSheetRef(html) {
  const match = html.match(/docs\.google\.com\/spreadsheets\/d\/([^/"']+)[^"']*gid=([0-9]+)/i);
  if (!match) return null;
  return {
    docId: match[1],
    gid: match[2],
    url: `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${match[2]}`,
  };
}

const TIRTIR_TITLE_STOPWORDS = new Set([
  'tirtir',
  'global',
  'the',
  'and',
  'with',
  'for',
  'set',
  'pack',
]);

function normalizeTirtirTitleTokens(value) {
  return Array.from(
    new Set(
      normalizeText(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !TIRTIR_TITLE_STOPWORDS.has(token)),
    ),
  );
}

function normalizeTirtirTitleKey(value) {
  return normalizeTirtirTitleTokens(value).join(' ');
}

function scoreTirtirSheetProductName(productTitle, sheetProductName) {
  const titleKey = normalizeTirtirTitleKey(productTitle);
  const sheetKey = normalizeTirtirTitleKey(sheetProductName);
  if (!titleKey || !sheetKey) return 0;
  if (sheetKey === titleKey) return 1;
  if (sheetKey.startsWith(`${titleKey} `) || sheetKey.includes(` ${titleKey} `)) return 0.95;
  const titleTokens = normalizeTirtirTitleTokens(productTitle);
  const sheetTokens = new Set(normalizeTirtirTitleTokens(sheetProductName));
  if (!titleTokens.length || !sheetTokens.size) return 0;
  const shared = titleTokens.filter((token) => sheetTokens.has(token)).length;
  return shared / Math.max(1, titleTokens.length);
}

function findTirtirSheetIngredientRow(rows, productTitle) {
  const title = normalizeText(productTitle);
  if (!title) return null;
  let best = null;
  for (const row of rows) {
    const productName = normalizeText(row[1]);
    const ingredients = normalizeText(row[2]);
    if (!productName || !looksLikeFullInci(ingredients)) continue;
    const score = scoreTirtirSheetProductName(title, productName);
    if (score < 0.8) continue;
    if (!best || score > best.score) best = { productName, ingredients, score };
  }
  return best;
}

async function fetchTirtirSheetIngredient(sheetRef, productTitle) {
  if (!sheetRef?.url) return null;
  const response = await fetch(sheetRef.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(Number(process.env.TIRTIR_INGREDIENT_SHEET_TIMEOUT_MS || 20000)),
    headers: { accept: 'text/csv,*/*' },
  });
  if (!response.ok) return null;
  const rows = parseCsvRows(await response.text());
  const match = findTirtirSheetIngredientRow(rows, productTitle);
  return match ? { ...match, sourceUrl: sheetRef.url } : null;
}

async function extractTirtirFields(html, options = {}) {
  const fields = {};

  const descriptionText = cleanSectionText(extractHtmlClassBlock(html, 'tab-content-0'));
  const detailBody = truncateOfficialDetailText(descriptionText);
  const detailSections = [];
  if (detailBody) detailSections.push({ heading: 'Official product details', body: detailBody });

  const faqText = cleanSectionText(extractHtmlClassBlock(html, 'tab-content-1'));
  const howTo = extractTirtirFaqHowToUse(faqText);
  if (looksLikeHowToUse(howTo)) fields.pdp_how_to_use_raw = howTo;

  let ingredientsText = cleanSectionText(extractHtmlClassBlock(html, 'tab-content-2'))
    .replace(/\bRead more\b/gi, '')
    .trim();
  const sheetRef = extractTirtirSheetRef(html);
  const sheetIngredient =
    !looksLikeFullInci(ingredientsText)
      ? await fetchTirtirSheetIngredient(sheetRef, options.productTitle)
      : null;
  if (sheetIngredient?.ingredients) {
    ingredientsText = sheetIngredient.ingredients;
    detailSections.push({
      heading: 'Variant ingredient source',
      body: `Official TIRTIR ingredient sheet is variant-level and product-name matched before storage. This PDP stores the listed default variant ingredient row; shade-specific pigments may vary by variant. Stored variant: ${sheetIngredient.productName}.`,
    });
  }
  if (looksLikeFullInci(ingredientsText)) fields.pdp_ingredients_raw = ingredientsText;
  if (detailSections.length > 0) fields.pdp_details_sections = detailSections;

  const review = parseOkendoReviewSummary(html) || parseMetafieldReviews(html);
  if (review) fields.review_summary = review;
  return fields;
}

function parseOkendoAggregate(html) {
  const raw = String(html || '');
  const scriptMatch = raw.match(/<script[^>]+data-oke-metafield-data[^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(scriptMatch[1]));
      const rating = Number(parsed?.averageRating || parsed?.rating || 0);
      const reviewCount = Number(parsed?.reviewCount || parsed?.review_count || parsed?.count || 0);
      if (Number.isFinite(rating) && rating > 0 && Number.isFinite(reviewCount) && reviewCount > 0) {
        return { rating, review_count: Math.round(reviewCount) };
      }
    } catch {
      // Fall through to the rendered aria-label/count parser.
    }
  }

  const widgetMatch =
    raw.match(/aria-label="Rated\s+([0-9.]+)\s+out of 5 stars Based on\s+([0-9,]+)\s+reviews"/i) ||
    raw.match(/<div[^>]+class="[^"]*\boke-w-ratingAverageModule-count\b[^"]*"[^>]*>\s*Based on\s+([0-9,]+)\s+reviews/i);
  if (!widgetMatch) return null;
  const rating = widgetMatch.length >= 3 ? Number(widgetMatch[1]) : 0;
  const reviewCountRaw = widgetMatch.length >= 3 ? widgetMatch[2] : widgetMatch[1];
  const reviewCount = Number(String(reviewCountRaw || '').replace(/,/g, ''));
  if (!Number.isFinite(reviewCount) || reviewCount <= 0) return null;
  return {
    rating: Number.isFinite(rating) && rating > 0 ? rating : 0,
    review_count: Math.round(reviewCount),
  };
}

function parseOkendoReviewSummary(html) {
  const raw = String(html || '');
  if (!/\bdata-oke-widget\b/i.test(raw) && !/\bokeReviews\b/i.test(raw)) return null;
  const aggregate = parseOkendoAggregate(raw);
  if (!aggregate || !aggregate.rating || !aggregate.review_count) return null;

  const previewItems = [];
  for (const match of raw.matchAll(/<li[^>]+class="[^"]*\boke-w-reviews-list-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = match[1];
    const body = cleanSectionText((block.match(/<div[^>]+class="[^"]*\boke-reviewContent-body\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
    if (!hasUsefulReviewText(body)) continue;
    const title = cleanSectionText((block.match(/<div[^>]+class="[^"]*\boke-reviewContent-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
    const author = cleanSectionText((block.match(/<strong[^>]+class="[^"]*\boke-w-reviewer-name\b[^"]*"[^>]*>([\s\S]*?)<\/strong>/i) || [])[1]);
    const ratingMatch = block.match(/Rated\s+([0-9.]+)\s+out of 5 stars/i);
    const rating = Number(ratingMatch?.[1] || 5) || 5;
    const idHash = crypto
      .createHash('sha1')
      .update(`okendo|${author}|${title}|${body}`)
      .digest('hex')
      .slice(0, 16);
    previewItems.push({
      review_id: `okendo_${idHash}`,
      rating: Math.max(1, Math.min(5, Math.round(rating))),
      author_label: author || 'Verified buyer',
      ...(title ? { title } : {}),
      text_snippet: body.slice(0, 360),
      source: 'merchant_public',
      source_kind: 'okendo_rendered_html',
      source_scope: 'merchant_public',
      public_visible: true,
      verified_buyer: /\bVerified Buyer\b/i.test(block),
      content_review_state: 'approved',
    });
    if (previewItems.length >= 6) break;
  }

  return {
    rating: aggregate.rating,
    scale: 5,
    review_count: aggregate.review_count,
    exact_item_review_count: aggregate.review_count,
    aggregation_scope: 'product',
    source_origin: 'official_okendo_reviews_html',
    ...(previewItems.length > 0 ? { preview_items: previewItems } : {}),
  };
}

function parseMetafieldReviews(html) {
  const match = html.match(/MetafieldReviews\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const rating = Number(parsed?.rating?.value || parsed?.rating || parsed?.average_rating || 0);
    const reviewCount = Number(parsed?.rating_count || parsed?.review_count || parsed?.count || 0);
    if (!Number.isFinite(rating) || rating <= 0 || !Number.isFinite(reviewCount) || reviewCount <= 0) return null;
    return {
      rating,
      scale: Number(parsed?.rating?.scale_max || 5) || 5,
      review_count: Math.round(reviewCount),
      source_origin: 'official_html_metafield_reviews',
    };
  } catch {
    return null;
  }
}

function extractYotpoContext(host, html) {
  if (host !== 'fentybeauty.com') return null;
  const raw = String(html || '');
  const appKey = normalizeText(
    (raw.match(/\byotpoKey\s*:\s*["']([^"']+)["']/i) || [])[1] ||
      (raw.match(/\byotpo-key=["']([^"']+)["']/i) || [])[1] ||
      (raw.match(/"yotpoStoreId"\s*:\s*"([^"]+)"/i) || [])[1],
  );
  const productId = normalizeText(
    (raw.match(/\bresourceId["']?\s*:\s*["']?(\d{6,})["']?/i) || [])[1] ||
      (raw.match(/shopify_[A-Z]{2}_(\d{6,})_\d{6,}/i) || [])[1] ||
      (raw.match(/"product"\s*:\s*\{[\s\S]{0,500}?"id"\s*:\s*"(\d{6,})"/i) || [])[1],
  );
  if (!appKey || !productId) return null;
  return { appKey, productId };
}

function extractBazaarvoiceProductId(html) {
  const raw = String(html || '');
  const match =
    raw.match(/data-bv-productId=["']([^"']+)["']/i) ||
    raw.match(/data-bv-product-id=["']([^"']+)["']/i);
  return normalizeText(match?.[1]);
}

function decodeMaybeUriComponent(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

function extractAttribute(value, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, 'i');
  const match = String(value || '').match(re);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function extractStampedContext(host, html) {
  const widgetMatch =
    html.match(/<div[^>]+id="stamped-main-widget"[^>]*>/i) ||
    html.match(/<span[^>]+class="[^"]*stamped-product-reviews-badge[^"]*"[^>]*>/i);
  const widgetHtml = widgetMatch ? widgetMatch[0] : '';
  const productId =
    extractAttribute(widgetHtml, 'data-product-id') ||
    extractAttribute(widgetHtml, 'data-id');
  if (!productId) return null;

  const apiKeyMatch = html.match(/StampedFn\.init\s*\(\s*\{[\s\S]{0,500}?apiKey:\s*['"]([^'"]+)['"]/i);
  const shopMatch =
    html.match(/shop=([a-z0-9-]+\.myshopify\.com)/i) ||
    html.match(/Shopify\.shop\s*=\s*["']([^"']+\.myshopify\.com)["']/i);
  const fallbackShopByHost = {
    'medicube.us': 'medicube-us.myshopify.com',
    'skin1004.com': 'skin1004-us.myshopify.com',
  };
  const shop = shopMatch ? shopMatch[1] : fallbackShopByHost[host];
  if (!shop) return null;
  return {
    productId,
    shop,
    apiKey: apiKeyMatch ? apiKeyMatch[1] : '',
  };
}

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': 'Mozilla/5.0 Pivota official review source audit',
      accept: 'application/json,*/*',
    },
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function buildStampedUrl(pathName, context, params = {}) {
  const paramsOut = new URLSearchParams({
    storeUrl: context.shop,
    productId: context.productId,
    ...params,
  });
  if (context.apiKey) paramsOut.set('apiKey', context.apiKey);
  return `https://stamped.io/api/widget/${pathName}?${paramsOut.toString()}`;
}

function hasUsefulReviewText(value) {
  const text = normalizeText(value);
  if (text.length < 55 || text.length > 700) return false;
  if (text.split(/\s+/).filter(Boolean).length < 10) return false;
  if (/^(?:great|good|love it|perfect|nice|bien)$/i.test(text)) return false;
  if (!looksLikeEnglishReviewText(text)) return false;
  if (looksLikeOperationalOrPriceReviewText(text)) return false;
  if (looksLikePromotionalOrCrossBrandReviewText(text)) return false;
  return true;
}

function looksLikeOperationalOrPriceReviewText(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return true;
  if (
    /\b(?:refund|customer service|ship(?:ped|ping)?|delivery|delivered|arrived|tracking)\b/i.test(text) ||
    /\b(?:my|the|this|that)\s+order\b/i.test(text) ||
    /\border\s*(?:#|number|status|has|had|was|is|placed|delayed|cancel(?:led|ed)?|not\s+ship)/i.test(text)
  ) {
    return true;
  }
  if (/\b(?:price|pricing|pricey|cost|markup|discount|sale)\b/i.test(text)) {
    return true;
  }
  if (/^\s*i have a question\b/i.test(text)) return true;
  return false;
}

function looksLikePromotionalOrCrossBrandReviewText(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return true;
  if (/\bhttps?:\/\/|\bbit\.ly\b|\bwww\./i.test(text)) return true;
  if (/\bt&cs?\s+apply\b|\bshop\s+(?:in-store|online)\b|\bspend\s*\$?\d+\b|\bbonus\b/i.test(text)) return true;
  if (/\b(?:lancome|myer|mother'?s day sets?)\b/i.test(text)) return true;
  if (/\bwrong\s+(?:one|product|shade|item)\b/i.test(text)) return true;
  return false;
}

function looksLikeEnglishReviewText(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return false;
  const englishMatches = text.match(
    /\b(?:the|and|with|skin|this|that|my|it|is|was|for|to|in|of|on|after|before|help|helps|helped|feel|feels|use|using|love|great|really|very|lightweight|soothing|sticky|redness|irritation|sensitive|oily|dry|combo|acne|routine|absorb|absorbs|works|worked)\b/g,
  ) || [];
  const nonEnglishMatches = text.match(
    /\b(?:soy|encanto|encantó|piel|cara|grasosa|recomendado|producto|sensacion|sensación|apenas|probando|luminosa|luminoso|maquillaje|duro|duró|intacto|corrio|corrió|indispensable|muy|nada|esto|ayudo|ayudó|tengo|uso|para|pero|como|bien|feliz)\b/g,
  ) || [];
  if (nonEnglishMatches.length >= 3 && englishMatches.length < 5) return false;
  return true;
}

function normalizeStampedPreviewItems(rows) {
  const seenText = new Set();
  return asArray(rows)
    .filter((row) => hasUsefulReviewText(row?.reviewMessage))
    .filter((row) => {
      const key = normalizeText(row?.reviewMessage).toLowerCase().slice(0, 240);
      if (!key || seenText.has(key)) return false;
      seenText.add(key);
      return true;
    })
    .slice(0, 6)
    .map((row) => ({
      review_id: String(row.id || row.reviewId || ''),
      rating: Number(row.reviewRating || row.rating || 5) || 5,
      author_label: normalizeText(row.author || row.authorName || 'Verified buyer'),
      ...(normalizeText(row.reviewTitle) ? { title: normalizeText(row.reviewTitle) } : {}),
      text_snippet: normalizeText(row.reviewMessage).slice(0, 360),
      source: 'merchant_public',
      source_kind: 'stamped_reviews_api',
      source_scope: 'merchant_public',
      public_visible: true,
      verified_buyer: Number(row.reviewVerifiedType) > 0 || Boolean(row.verified),
      content_review_state: 'approved',
    }))
    .filter((row) => row.review_id && row.text_snippet);
}

function distributionFromStampedRows(rows, total) {
  const normalizedTotal = Math.round(Number(total || 0));
  if (!normalizedTotal || rows.length !== normalizedTotal) return null;
  const counts = new Map();
  for (const row of rows) {
    const rating = Math.max(1, Math.min(5, Math.round(Number(row?.reviewRating || row?.rating || 0))));
    if (!rating) continue;
    counts.set(rating, (counts.get(rating) || 0) + 1);
  }
  if (!counts.size) return null;
  return Array.from({ length: 5 }, (_, index) => {
    const stars = 5 - index;
    const count = counts.get(stars) || 0;
    return {
      stars,
      count,
      percent: normalizedTotal > 0 ? count / normalizedTotal : 0,
    };
  });
}

function normalizeYotpoPreviewItems(rows) {
  return asArray(rows)
    .filter((row) => Number(row?.score || 0) >= 4)
    .filter((row) => !row?.deleted)
    .filter((row) => !row?.language || String(row.language).toLowerCase().startsWith('en'))
    .filter((row) => hasUsefulReviewText(row?.content))
    .slice(0, 6)
    .map((row) => ({
      review_id: `yotpo_${String(row.id || row.source_review_id || '')}`,
      rating: Math.max(1, Math.min(5, Math.round(Number(row.score || 0) || 5))),
      author_label: normalizeText(row?.user?.display_name || 'Verified buyer'),
      ...(normalizeText(row.title) && !/^(?:great|good|love it|perfect|nice)$/i.test(normalizeText(row.title))
        ? { title: normalizeText(row.title).slice(0, 90) }
        : {}),
      text_snippet: normalizeText(row.content).slice(0, 360),
      source: 'merchant_public',
      source_kind: 'yotpo_reviews_api',
      source_scope: 'merchant_public',
      public_visible: true,
      verified_buyer: Boolean(row.verified_buyer),
      content_review_state: 'approved',
    }))
    .filter((row) => row.review_id !== 'yotpo_' && row.text_snippet);
}

function distributionFromYotpoBottomline(bottomline) {
  const reviewCount = Math.round(Number(bottomline?.total_review || 0));
  const distribution = ensureObject(bottomline?.star_distribution);
  if (!reviewCount || Object.keys(distribution).length === 0) return null;
  return Array.from({ length: 5 }, (_, index) => {
    const stars = 5 - index;
    const count = Math.max(0, Math.round(Number(distribution[String(stars)] || 0)));
    return {
      stars,
      count,
      percent: reviewCount > 0 ? count / reviewCount : 0,
    };
  });
}

async function fetchYotpoReviewSummary(host, html) {
  const context = extractYotpoContext(host, html);
  if (!context) return null;
  const params = new URLSearchParams({
    page: '1',
    per_page: '20',
  });
  const reviewsUrl = `https://api.yotpo.com/v1/widget/${encodeURIComponent(context.appKey)}/products/${encodeURIComponent(
    context.productId,
  )}/reviews.json?${params.toString()}`;
  const payload = await fetchJson(reviewsUrl, Number(process.env.OFFICIAL_YOTPO_TIMEOUT_MS || 15000));
  const bottomline = ensureObject(payload?.response?.bottomline);
  const rows = asArray(payload?.response?.reviews);
  const rating = Number(bottomline.average_score || 0);
  const reviewCount = Math.round(Number(bottomline.total_review || 0));
  const previewItems = normalizeYotpoPreviewItems(rows);
  if (!Number.isFinite(rating) || rating <= 0 || !Number.isFinite(reviewCount) || reviewCount <= 0) return null;
  if (previewItems.length === 0) return null;

  const starDistribution = distributionFromYotpoBottomline(bottomline);
  return {
    rating,
    scale: 5,
    review_count: reviewCount,
    exact_item_review_count: reviewCount,
    aggregation_scope: 'product',
    source_origin: 'official_yotpo_reviews_api',
    source_url: reviewsUrl,
    ...(starDistribution ? {
      star_distribution: starDistribution,
      rating_distribution: starDistribution,
    } : {}),
    preview_items: previewItems,
  };
}

async function fetchStampedReviewSummary(host, html) {
  if (!['medicube.us', 'skin1004.com', 'roundlab.com'].includes(host)) return null;
  const context = extractStampedContext(host, html);
  if (!context) return null;

  const reviewsUrl = buildStampedUrl('reviews', context, { page: '1', take: '20' });
  const reviews = await fetchJson(reviewsUrl);
  const reviewRows = asArray(reviews?.data);

  let widget = null;
  if (context.apiKey) {
    widget = await fetchJson(buildStampedUrl('', context));
  }

  const rating = Number(widget?.rating || reviews?.rating || 0);
  const reviewCount = Math.round(Number(widget?.count || reviews?.total || 0));
  if (!Number.isFinite(rating) || rating <= 0 || !Number.isFinite(reviewCount) || reviewCount <= 0) return null;

  const starDistribution = distributionFromStampedRows(reviewRows, reviews?.total);
  return {
    rating,
    scale: 5,
    review_count: reviewCount,
    exact_item_review_count: reviewCount,
    aggregation_scope: 'product',
    source_origin: 'official_stamped_reviews_api',
    source_url: reviewsUrl,
    ...(starDistribution ? {
      star_distribution: starDistribution,
      rating_distribution: starDistribution,
    } : {}),
    preview_items: normalizeStampedPreviewItems(reviewRows),
  };
}

function normalizeBazaarvoicePreviewItems(rows) {
  return asArray(rows)
    .filter((row) => Number(row?.Rating || 0) >= 4)
    .filter((row) => hasUsefulReviewText(row?.ReviewText))
    .filter((row) => !looksLikeBazaarvoiceOperationalOrPriceReview(row))
    .slice(0, 6)
    .map((row) => {
      const title = normalizeBazaarvoiceReviewTitle(row.Title);
      return {
        review_id: String(row.Id || ''),
        rating: Number(row.Rating || 0) || 5,
        author_label: normalizeText(row.UserNickname || row.UserLocation || 'Reviewer'),
        ...(title ? { title } : {}),
        text_snippet: normalizeText(row.ReviewText).slice(0, 360),
        source: 'merchant_public',
        source_kind: 'bazaarvoice_reviews_api',
        source_scope: 'merchant_public',
        public_visible: true,
        content_review_state: 'approved',
      };
    })
    .filter((row) => row.review_id && row.text_snippet);
}

function normalizeBazaarvoiceReviewTitle(value) {
  const title = normalizeText(value);
  if (!title) return '';
  if (/^(?:\.{2,}|great|great product|amazing|perfect|love it|good product)$/i.test(title)) return '';
  return title.slice(0, 90);
}

function looksLikeBazaarvoiceOperationalOrPriceReview(row) {
  const text = normalizeText([row?.Title, row?.ReviewText].filter(Boolean).join(' ')).toLowerCase();
  return looksLikeOperationalOrPriceReviewText(text) || /\b(?:administration|est[ée]e lauder)\b/i.test(text);
}

function distributionFromBazaarvoiceStats(stats) {
  const reviewCount = Math.round(Number(stats?.TotalReviewCount || 0));
  const rows = asArray(stats?.RatingDistribution);
  if (!reviewCount || rows.length === 0) return null;
  const counts = new Map();
  for (const row of rows) {
    const stars = Math.max(1, Math.min(5, Math.round(Number(row?.RatingValue || 0))));
    const count = Math.max(0, Math.round(Number(row?.Count || 0)));
    if (stars && count >= 0) counts.set(stars, count);
  }
  if (!counts.size) return null;
  return Array.from({ length: 5 }, (_, index) => {
    const stars = 5 - index;
    const count = counts.get(stars) || 0;
    return {
      stars,
      count,
      percent: reviewCount > 0 ? count / reviewCount : 0,
    };
  });
}

async function fetchBazaarvoiceReviewSummary(host, html) {
  if (host !== 'theordinary.com') return null;
  const productId = extractBazaarvoiceProductId(html);
  if (!productId) return null;

  const params = new URLSearchParams({
    passkey: 'cazbSxrBRsuLsrg4jHS2ic5CfRDhxH7JCC4k93f4AGIT8',
    apiversion: '5.5',
    displaycode: '17731-en_us',
    sort: 'totalpositivefeedbackcount:desc',
    stats: 'reviews',
    filteredstats: 'reviews',
    include: 'authors,products,comments',
    limit: '20',
    offset: '0',
    limit_comments: '3',
  });
  params.append('filter', 'isratingsonly:eq:false');
  params.append('filter', `productid:eq:${productId}`);
  params.append('filter', 'contentlocale:eq:en*');
  params.append('filter', 'rating:gte:4');
  params.append('filter_reviews', 'contentlocale:eq:en*');
  params.append('filter_reviewcomments', 'contentlocale:eq:en*');
  params.append('filter_comments', 'contentlocale:eq:en*');

  const reviewsUrl = `https://api.bazaarvoice.com/data/reviews.json?${params.toString()}`;
  const payload = await fetchJson(reviewsUrl, Number(process.env.OFFICIAL_BAZAARVOICE_TIMEOUT_MS || 15000));
  const rows = asArray(payload?.Results);
  const stats = ensureObject(payload?.Includes?.Products?.[productId]?.ReviewStatistics);
  const rating = Number(stats.AverageOverallRating || 0);
  const reviewCount = Math.round(Number(stats.TotalReviewCount || payload?.TotalResults || 0));
  if (!Number.isFinite(rating) || rating <= 0 || !Number.isFinite(reviewCount) || reviewCount <= 0) return null;

  const starDistribution = distributionFromBazaarvoiceStats(stats);
  return {
    rating,
    scale: Number(stats.OverallRatingRange || 5) || 5,
    review_count: reviewCount,
    exact_item_review_count: reviewCount,
    aggregation_scope: 'product',
    source_origin: 'official_bazaarvoice_reviews_api',
    source_url: reviewsUrl,
    ...(starDistribution ? {
      star_distribution: starDistribution,
      rating_distribution: starDistribution,
    } : {}),
    preview_items: normalizeBazaarvoicePreviewItems(rows),
  };
}

function normalizeFentyShadeText(value) {
  return decodeHtmlEntities(value)
    .toLowerCase()
    .replace(/[$]/g, 's')
    .replace(/[’‘`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/#/g, '')
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFentyShadeTokens(productTitle) {
  const title = normalizeText(productTitle);
  const suffix = title.split(/\s+[—-]\s+/).pop() || '';
  const normalizedSuffix = normalizeFentyShadeText(suffix);
  const values = [suffix];
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value || '').match(/#?\d{1,3}[a-z]?|[a-z][a-z0-9'$]+(?:\s+[a-z][a-z0-9'$]+){0,3}/gi) || [])
        .map((value) => normalizeFentyShadeText(value))
        .concat(normalizedSuffix)
        .filter(Boolean)
        .filter((value) => !['soft matte longwear foundation', 'naturally luminous longwear foundation'].includes(value)),
    ),
  );
}

function extractFentyFullIngredientModalHtml(html) {
  const source = String(html || '');
  const modalMatch = source.match(/<modal\b[^>]*title=["']Full ingredients["'][\s\S]*?<\/modal>/i);
  if (!modalMatch) return '';
  const contentMatch = modalMatch[0].match(
    /<div\b[^>]*class=["'][^"']*\bproduct-ingredients-modal__content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/modal>/i,
  );
  return contentMatch?.[1] || modalMatch[0];
}

function labelContainsFentyShade(label, shadeTokens) {
  const normalizedLabel = normalizeFentyShadeText(label);
  if (!normalizedLabel || !shadeTokens.length) return false;
  const labelWords = new Set(normalizedLabel.split(/\s+/).filter(Boolean));
  return shadeTokens.some((shade) => {
    const normalizedShade = normalizeFentyShadeText(shade);
    if (!normalizedShade) return false;
    if (labelWords.has(normalizedShade)) return true;
    if (normalizedLabel.includes(normalizedShade)) return true;
    const shadeWords = normalizedShade.split(/\s+/).filter(Boolean);
    return shadeWords.length > 1 && shadeWords.length <= 4 && shadeWords.every((word) => labelWords.has(word));
  });
}

function extractFentyFullIngredients(html, productTitle = '') {
  const modalHtml = extractFentyFullIngredientModalHtml(html);
  if (!modalHtml) return '';
  const paragraphs = Array.from(modalHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
    .map((match) => {
      const text = cleanSectionText(match[1]);
      const colonIndex = text.indexOf(':');
      const label = colonIndex > 0 ? text.slice(0, colonIndex) : '';
      const labelLimit = /^\s*shades?\b/i.test(label) ? 900 : 180;
      if (colonIndex > 0 && colonIndex < labelLimit) {
        return {
          label,
          body: normalizeText(text.slice(colonIndex + 1)),
          full: text,
        };
      }
      return { label: '', body: text, full: text };
    })
    .filter((item) => looksLikeFullInci(item.body || item.full));
  if (!paragraphs.length) return '';

  const shadeTokens = extractFentyShadeTokens(productTitle);
  const shadeMatch = paragraphs.find((item) => labelContainsFentyShade(item.label, shadeTokens));
  if (shadeMatch) return shadeMatch.body;
  if (paragraphs.length === 1) return paragraphs[0].body || paragraphs[0].full;
  return '';
}

function extractFentyKeyIngredients(html) {
  const items = Array.from(
    String(html || '').matchAll(/class=["'][^"']*\bproduct-ingredients__item-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi),
  )
    .map((match) => cleanSectionText(decodeMaybeUriComponent(match[1])))
    .filter((item) => item.length >= 3 && item.length <= 120)
    .filter((item) => !/\b(?:ingredients?|benefits?|claims?|how to)\b/i.test(item));
  const text = Array.from(new Set(items)).join(', ');
  return looksLikeActiveIngredientList(text) || /\b(?:extract|squalane|shea butter|vitamin|oil|peptide|acid|niacinamide)\b/i.test(text)
    ? text
    : '';
}

function extractFentyFields(html, options = {}) {
  const fields = {};
  const fullIngredients = extractFentyFullIngredients(html, options.productTitle);
  if (looksLikeFullInci(fullIngredients)) fields.pdp_ingredients_raw = fullIngredients;
  return fields;
}

async function extractOfficialHtmlFields(host, html, options = {}) {
  let fields = {};
  if (host === 'skin1004.com') fields = extractSkin1004Fields(html);
  else if (host === 'medicube.us') fields = extractMedicubeFields(html);
  else if (host === 'tirtir.global') fields = await extractTirtirFields(html, options);
  else if (host === 'theordinary.com') fields = {};
  else if (host === 'fentybeauty.com') fields = extractFentyFields(html, options);
  else if (!options.reviewSummaryOnly || !REVIEW_SUMMARY_ONLY_GENERIC_HOSTS.has(host)) return {};

  if (options.reviewSummaryOnly && REVIEW_SUMMARY_ONLY_OKENDO_HOSTS.has(host)) {
    const okendoReview = parseOkendoReviewSummary(html) || parseMetafieldReviews(html);
    if (okendoReview) {
      fields.review_summary = {
        ...ensureObject(fields.review_summary),
        ...okendoReview,
        source_origin: okendoReview.source_origin || fields.review_summary?.source_origin,
      };
    }
  }

  const stampedReview = await fetchStampedReviewSummary(host, html);
  if (stampedReview) {
    fields.review_summary = {
      ...ensureObject(fields.review_summary),
      ...stampedReview,
      source_origin: stampedReview.source_origin || fields.review_summary?.source_origin,
    };
  }
  const bazaarvoiceReview = await fetchBazaarvoiceReviewSummary(host, html);
  if (bazaarvoiceReview) {
    fields.review_summary = {
      ...ensureObject(fields.review_summary),
      ...bazaarvoiceReview,
      source_origin: bazaarvoiceReview.source_origin || fields.review_summary?.source_origin,
    };
  }
  const yotpoReview = await fetchYotpoReviewSummary(host, html);
  if (yotpoReview) {
    fields.review_summary = {
      ...ensureObject(fields.review_summary),
      ...yotpoReview,
      source_origin: yotpoReview.source_origin || fields.review_summary?.source_origin,
    };
  }
  return fields;
}

function mergeReviewSummary(existing, incoming) {
  const next = {
    ...ensureObject(existing),
    rating: incoming.rating,
    scale: incoming.scale,
    review_count: incoming.review_count,
    source_origin: incoming.source_origin,
    updated_at: new Date().toISOString(),
  };
  for (const key of [
    'aggregation_scope',
    'exact_item_review_count',
    'product_line_review_count',
    'source_url',
    'star_distribution',
    'rating_distribution',
    'preview_items',
  ]) {
    if (incoming[key] !== undefined) next[key] = incoming[key];
  }
  return next;
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function mergeReviewSummaryForPreviewOnly(existing, incoming) {
  const existingSummary = ensureObject(existing);
  const incomingSummary = ensureObject(incoming);
  const merged = mergeReviewSummary(existingSummary, incomingSummary);
  const existingRating = positiveNumber(existingSummary.rating || existingSummary.average_rating);
  const existingReviewCount = Math.round(
    positiveNumber(existingSummary.review_count || existingSummary.count || existingSummary.total),
  );
  const incomingPreviewCount = reviewPreviewCount(incomingSummary);
  if (!existingRating || !existingReviewCount || incomingPreviewCount === 0) return merged;

  merged.rating = existingRating;
  merged.review_count = existingReviewCount;
  merged.exact_item_review_count = Math.round(
    positiveNumber(existingSummary.exact_item_review_count) || existingReviewCount,
  );
  if (positiveNumber(existingSummary.scale)) merged.scale = positiveNumber(existingSummary.scale);
  if (existingSummary.source_origin) merged.source_origin = existingSummary.source_origin;
  if (existingSummary.source_url) merged.source_url = existingSummary.source_url;
  else delete merged.source_url;
  if (incomingSummary.source_origin) merged.preview_source_origin = incomingSummary.source_origin;
  if (incomingSummary.source_url) merged.preview_source_url = incomingSummary.source_url;

  if (Array.isArray(existingSummary.star_distribution)) merged.star_distribution = existingSummary.star_distribution;
  else delete merged.star_distribution;
  if (Array.isArray(existingSummary.rating_distribution)) merged.rating_distribution = existingSummary.rating_distribution;
  else delete merged.rating_distribution;

  merged.aggregate_preserved_from_existing = true;
  merged.aggregate_preserved_at = new Date().toISOString();
  return merged;
}

function reviewPreviewCount(summary) {
  const safe = ensureObject(summary);
  return asArray(safe.preview_items).length || asArray(safe.snippets).length;
}

function hasReviewAggregate(summary) {
  const safe = ensureObject(summary);
  return (
    positiveNumber(safe.rating || safe.average_rating) > 0 &&
    Math.round(positiveNumber(safe.review_count || safe.count || safe.total)) > 0
  );
}

function mergeDetails(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const section of [...asArray(existing), ...asArray(incoming)]) {
    const heading = normalizeText(section?.heading || section?.title);
    const body = normalizeText(section?.body || section?.content || section?.text);
    if (!heading || body.length < 20) continue;
    const key = `${heading.toLowerCase()}::${body.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ heading, body });
  }
  return out.slice(0, 8);
}

function buildSnapshotContract(existing) {
  return {
    ...ensureObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'catalog_intelligence',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: new Date().toISOString(),
  };
}

function mergeQualitySummary(existing, patchKeys) {
  const next = { ...ensureObject(existing) };
  const now = new Date().toISOString();
  const set = (key, sourceKind) => {
    next[key] = {
      source_origin: 'official_html',
      source_quality_status: 'high',
      source_kinds: [sourceKind],
      reason_codes: [],
      updated_at: now,
    };
  };
  if (patchKeys.includes('pdp_description_raw')) set('description_raw', 'official_pdp_overview');
  if (patchKeys.includes('pdp_ingredients_raw')) set('ingredients_raw', 'official_pdp_full_ingredients');
  if (patchKeys.includes('pdp_active_ingredients_raw')) set('active_ingredients_raw', 'official_pdp_key_ingredients');
  if (patchKeys.includes('pdp_how_to_use_raw')) set('how_to_use_raw', 'official_pdp_how_to_use');
  if (patchKeys.includes('pdp_details_sections')) set('details_sections', 'official_pdp_details_section');
  if (patchKeys.includes('variants')) set('variants', 'official_shopify_product_json');
  return next;
}

function mergeContentAsset(existing, patch) {
  const next = {
    contract_version: PDP_CONTENT_ASSET_VERSION,
    owner: 'pivota',
    fields: {
      ...ensureObject(ensureObject(existing).fields),
    },
  };
  const now = new Date().toISOString();
  const set = (fieldKey, value, sourceKind) => {
    next.fields[fieldKey] = {
      review_state: 'assistant_reviewed',
      overwrite_policy: 'preserve_best_available',
      source_quality_status: 'high',
      source_origin: 'official_html',
      source_kind: sourceKind,
      content_hash: hashContent(value),
      updated_at: now,
    };
  };
  if (patch.pdp_ingredients_raw) set('ingredients_raw', patch.pdp_ingredients_raw, 'official_pdp_full_ingredients');
  if (patch.pdp_active_ingredients_raw) set('active_ingredients_raw', patch.pdp_active_ingredients_raw, 'official_pdp_key_ingredients');
  if (patch.pdp_how_to_use_raw) set('how_to_use_raw', patch.pdp_how_to_use_raw, 'official_pdp_how_to_use');
  if (patch.pdp_description_raw) set('description_raw', patch.pdp_description_raw, 'official_pdp_overview');
  if (patch.pdp_details_sections?.length) set('details_sections', patch.pdp_details_sections, 'official_pdp_details_section');
  return next;
}

function clearRecoveredStrictPdpSourceBlocker(seedData, snapshot, patchKeys) {
  const contentPatchKeys = patchKeys.filter((key) => key !== 'review_summary');
  if (!contentPatchKeys.length) return false;
  const existingRootMarker = ensureObject(seedData.strict_pdp_source_blocker_v1);
  const existingSnapshotMarker = ensureObject(snapshot.strict_pdp_source_blocker_v1);
  const existingMarker = Object.keys(existingRootMarker).length ? existingRootMarker : existingSnapshotMarker;
  if (!Object.keys(existingMarker).length) return false;

  const recoveredAt = new Date().toISOString();
  const recoveryMarker = {
    contract_version: 'external_seed.strict_pdp_source_recovery.v1',
    recovered_at: recoveredAt,
    recovery_source: 'official_html_public_pdp',
    recovered_fields: contentPatchKeys,
    previous_marker: existingMarker,
    reason_codes: [
      'official_public_pdp_recovered_after_strict_source_blocker',
      'field_level_quality_gate_retained',
    ],
  };
  seedData.strict_pdp_source_recovery_v1 = recoveryMarker;
  snapshot.strict_pdp_source_recovery_v1 = recoveryMarker;
  delete seedData.strict_pdp_source_blocker_v1;
  delete snapshot.strict_pdp_source_blocker_v1;
  return true;
}

function buildSeedDataPatch(row, extracted, options = {}) {
  const seedData = JSON.parse(JSON.stringify(ensureObject(row.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const patchKeys = [];
  const reviewSummaryOnly = options.reviewSummaryOnly === true;
  const missingFieldsOnly = options.missingFieldsOnly === true;
  const readExistingQuality = (summaryKey, assetKey = summaryKey) => {
    const summaries = [
      ensureObject(seedData.pdp_field_quality_summary),
      ensureObject(snapshot.pdp_field_quality_summary),
      ensureObject(seedData.pdp_content_asset_v1).fields,
      ensureObject(snapshot.pdp_content_asset_v1).fields,
    ];
    for (const summary of summaries) {
      const item = ensureObject(summary?.[summaryKey] || summary?.[assetKey]);
      const status = normalizeText(item.source_quality_status).toLowerCase();
      const origin = normalizeText(item.source_origin).toLowerCase();
      if (status || origin) return { status, origin };
    }
    return { status: '', origin: '' };
  };
  const isForceFilledExisting = (summaryKey, assetKey = summaryKey) => {
    const quality = readExistingQuality(summaryKey, assetKey);
    return quality.status.startsWith('force_filled') || quality.origin === 'pivota_force_fill';
  };
  const hasExisting = (fieldKey) => {
    if (!missingFieldsOnly) return false;
    if (fieldKey === 'pdp_description_raw') {
      if (isForceFilledExisting('description_raw')) return false;
      return normalizeText(seedData.pdp_description_raw || snapshot.pdp_description_raw || seedData.description || snapshot.description).length >= 80;
    }
    if (fieldKey === 'pdp_ingredients_raw') {
      if (isForceFilledExisting('ingredients_raw')) return false;
      return looksLikeFullInci(seedData.pdp_ingredients_raw || snapshot.pdp_ingredients_raw);
    }
    if (fieldKey === 'pdp_active_ingredients_raw') {
      if (isForceFilledExisting('active_ingredients_raw')) return false;
      return (
        looksLikeActiveIngredientList(seedData.pdp_active_ingredients_raw || snapshot.pdp_active_ingredients_raw) ||
        asArray(seedData.active_ingredients || snapshot.active_ingredients).length > 0
      );
    }
    if (fieldKey === 'pdp_how_to_use_raw') {
      if (isForceFilledExisting('how_to_use_raw')) return false;
      return looksLikeHowToUse(seedData.pdp_how_to_use_raw || snapshot.pdp_how_to_use_raw);
    }
    if (fieldKey === 'pdp_details_sections') {
      return asArray(seedData.pdp_details_sections || snapshot.pdp_details_sections).length > 0;
    }
    if (fieldKey === 'variants') {
      return asArray(seedData.variants || snapshot.variants).length > 0;
    }
    return false;
  };

  if (!reviewSummaryOnly && extracted.pdp_description_raw && !hasExisting('pdp_description_raw')) {
    seedData.description = extracted.pdp_description_raw;
    seedData.pdp_description_raw = extracted.pdp_description_raw;
    snapshot.description = extracted.pdp_description_raw;
    snapshot.pdp_description_raw = extracted.pdp_description_raw;
    patchKeys.push('pdp_description_raw');
  }
  if (!reviewSummaryOnly && extracted.pdp_ingredients_raw && !hasExisting('pdp_ingredients_raw')) {
    seedData.pdp_ingredients_raw = extracted.pdp_ingredients_raw;
    seedData.raw_ingredient_text_clean = extracted.pdp_ingredients_raw;
    snapshot.pdp_ingredients_raw = extracted.pdp_ingredients_raw;
    snapshot.raw_ingredient_text_clean = extracted.pdp_ingredients_raw;
    patchKeys.push('pdp_ingredients_raw');
  }
  if (!reviewSummaryOnly && extracted.pdp_active_ingredients_raw && !hasExisting('pdp_active_ingredients_raw')) {
    const activeItems = Array.from(
      new Set(
        extracted.pdp_active_ingredients_raw
          .split(/,|;|\n/)
          .map((item) => normalizeText(item))
          .filter(Boolean),
      ),
    );
    seedData.pdp_active_ingredients_raw = extracted.pdp_active_ingredients_raw;
    seedData.active_ingredients = activeItems;
    snapshot.pdp_active_ingredients_raw = extracted.pdp_active_ingredients_raw;
    snapshot.active_ingredients = activeItems;
    patchKeys.push('pdp_active_ingredients_raw');
  }
  if (!reviewSummaryOnly && extracted.pdp_how_to_use_raw && !hasExisting('pdp_how_to_use_raw')) {
    seedData.pdp_how_to_use_raw = extracted.pdp_how_to_use_raw;
    snapshot.pdp_how_to_use_raw = extracted.pdp_how_to_use_raw;
    patchKeys.push('pdp_how_to_use_raw');
  }
  if (!reviewSummaryOnly && asArray(extracted.pdp_details_sections).length > 0 && !hasExisting('pdp_details_sections')) {
    const merged = mergeDetails(seedData.pdp_details_sections || snapshot.pdp_details_sections, extracted.pdp_details_sections);
    seedData.pdp_details_sections = merged;
    snapshot.pdp_details_sections = merged;
    patchKeys.push('pdp_details_sections');
  }
  if (extracted.review_summary) {
    const existing = ensureObject(seedData.review_summary || snapshot.review_summary);
    const incomingPreviewCount = reviewPreviewCount(extracted.review_summary);
    const existingPreviewCount = reviewPreviewCount(existing);
    if (reviewSummaryOnly && reviewPreviewCount(existing) > 0) {
      const sameAuthoritativeSource =
        normalizeText(existing.source_origin) &&
        normalizeText(existing.source_origin) === normalizeText(extracted.review_summary.source_origin);
      if (!options.refreshReviewPreview || !sameAuthoritativeSource) {
        seedData.snapshot = snapshot;
        return { seedData, patchKeys };
      }
    }
    if (
      missingFieldsOnly &&
      hasReviewAggregate(existing) &&
      existingPreviewCount > 0 &&
      incomingPreviewCount <= existingPreviewCount
    ) {
      seedData.snapshot = snapshot;
      return { seedData, patchKeys };
    }
    if (reviewSummaryOnly && incomingPreviewCount === 0) {
      seedData.snapshot = snapshot;
      return { seedData, patchKeys };
    }
    const incoming = reviewSummaryOnly || missingFieldsOnly
      ? mergeReviewSummaryForPreviewOnly(existing, extracted.review_summary)
      : mergeReviewSummary(existing, extracted.review_summary);
    seedData.review_summary = incoming;
    snapshot.review_summary = incoming;
    patchKeys.push('review_summary');
  }
  if (!reviewSummaryOnly && asArray(extracted.variants).length > 0 && !hasExisting('variants')) {
    seedData.variants = extracted.variants;
    snapshot.variants = extracted.variants;
    const variantSkus = extracted.variants.map((variant) => normalizeText(variant.sku || variant.sku_id)).filter(Boolean);
    if (variantSkus.length > 0) {
      seedData.variant_skus = Array.from(new Set(variantSkus));
      snapshot.variant_skus = seedData.variant_skus;
    }
    patchKeys.push('variants');
  }

  if (patchKeys.some((key) => key !== 'review_summary')) {
    const quality = mergeQualitySummary(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary, patchKeys);
    seedData.pdp_field_quality_summary = quality;
    snapshot.pdp_field_quality_summary = quality;
    seedData.pdp_content_asset_v1 = mergeContentAsset(seedData.pdp_content_asset_v1 || snapshot.pdp_content_asset_v1, extracted);
    snapshot.pdp_content_asset_v1 = seedData.pdp_content_asset_v1;
    seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract);
    snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract);
    clearRecoveredStrictPdpSourceBlocker(seedData, snapshot, patchKeys);
  }

  if (patchKeys.length > 0) {
    seedData.official_html_pdp_fields_v1 = {
      contract_version: CONTRACT_VERSION,
      source_origin: 'official_html',
      updated_at: new Date().toISOString(),
      fields: patchKeys,
    };
    snapshot.official_html_pdp_fields_v1 = seedData.official_html_pdp_fields_v1;
  }

  seedData.snapshot = snapshot;
  return { seedData, patchKeys };
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(Number(process.env.OFFICIAL_HTML_PDP_TIMEOUT_MS || 20000)),
    headers: {
      'user-agent': 'Mozilla/5.0 Pivota official PDP field audit',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  const html = await response.text();
  return {
    status: response.status,
    final_url: response.url,
    html,
  };
}

async function fetchOfficialShopifyVariants(url, row) {
  const host = hostFromUrl(url);
  if (!SHOPIFY_PRODUCT_JSON_VARIANT_HOSTS.has(host)) return [];
  const jsonUrl = buildShopifyProductJsonUrl(url);
  if (!jsonUrl) return [];
  const productJson = await fetchJson(jsonUrl, Number(process.env.OFFICIAL_SHOPIFY_JSON_TIMEOUT_MS || 15000));
  return extractOfficialShopifyVariants(productJson, {
    productTitle: row.title,
    currency: row.price_currency || row.seed_data?.price_currency || row.seed_data?.snapshot?.price_currency || 'USD',
    productUrl: url,
  });
}

async function fetchRows(ids, market) {
  const res = await query(
    `
      SELECT id, external_product_id, title, domain, market, canonical_url, destination_url, price_currency, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR market = $2::text)
      ORDER BY array_position($1::text[], external_product_id::text)
    `,
    [ids, market],
  );
  return res.rows || [];
}

function buildServingPayloadPatch(seedData, patchKeys) {
  const snapshot = ensureObject(seedData.snapshot);
  const patch = {};
  const copyFirst = (targetKey, ...sourceKeys) => {
    for (const key of sourceKeys) {
      if (seedData[key] !== undefined) {
        patch[targetKey] = seedData[key];
        return;
      }
      if (snapshot[key] !== undefined) {
        patch[targetKey] = snapshot[key];
        return;
      }
    }
  };

  if (patchKeys.includes('review_summary')) {
    copyFirst('review_summary', 'review_summary');
  }
  if (patchKeys.includes('pdp_description_raw')) {
    copyFirst('description', 'description', 'pdp_description_raw');
    copyFirst('pdp_description_raw', 'pdp_description_raw', 'description');
  }
  if (patchKeys.includes('pdp_ingredients_raw')) {
    copyFirst('pdp_ingredients_raw', 'pdp_ingredients_raw');
    copyFirst('raw_ingredient_text_clean', 'raw_ingredient_text_clean', 'pdp_ingredients_raw');
  }
  if (patchKeys.includes('pdp_active_ingredients_raw')) {
    copyFirst('pdp_active_ingredients_raw', 'pdp_active_ingredients_raw');
    copyFirst('active_ingredients', 'active_ingredients');
  }
  if (patchKeys.includes('pdp_how_to_use_raw')) {
    copyFirst('pdp_how_to_use_raw', 'pdp_how_to_use_raw');
  }
  if (patchKeys.includes('pdp_details_sections')) {
    copyFirst('pdp_details_sections', 'pdp_details_sections');
  }
  if (patchKeys.includes('variants')) {
    copyFirst('variants', 'variants');
    copyFirst('variant_skus', 'variant_skus');
  }
  copyFirst('pdp_field_quality_summary', 'pdp_field_quality_summary');
  copyFirst('official_html_pdp_fields_v1', 'official_html_pdp_fields_v1');
  copyFirst('external_seed_snapshot_contract', 'external_seed_snapshot_contract');
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

async function syncServingMirrors(externalProductId, seedData, patchKeys) {
  const payloadPatch = buildServingPayloadPatch(seedData, patchKeys);
  if (Object.keys(payloadPatch).length === 0) {
    return { catalog_products: 0, pdp_identity_listing: 0 };
  }
  const payloadJson = stringifyPostgresJsonb(payloadPatch);
  const reviewSummaryJson = payloadPatch.review_summary
    ? stringifyPostgresJsonb(payloadPatch.review_summary)
    : null;
  const catalogRes = await query(
    `
      UPDATE catalog_products
      SET product_payload = COALESCE(product_payload, '{}'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE merchant_id = 'external_seed'
        AND platform = 'external_seed'
        AND source_product_id = $1
    `,
    [externalProductId, payloadJson],
  );
  const identityRes = await query(
    `
      UPDATE pdp_identity_listing
      SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
          review_summary = CASE
            WHEN $3::jsonb IS NULL THEN review_summary
            ELSE $3::jsonb
          END,
          updated_at = NOW()
      WHERE source_listing_ref = $1
    `,
    [`external_seed:${externalProductId}`, payloadJson, reviewSummaryJson],
  );
  return {
    catalog_products: Number(catalogRes.rowCount || 0),
    pdp_identity_listing: Number(identityRes.rowCount || 0),
  };
}

async function main() {
  const ids = [
    ...parseDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds')),
    ...readIdsFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile')),
  ];
  if (ids.length === 0) throw new Error('missing_external_product_ids');
  const market = normalizeText(argValue('market') || 'US').toUpperCase();
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir'));
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  const reviewSummaryOnly = hasFlag('review-summary-only') || hasFlag('reviewSummaryOnly');
  const refreshReviewPreview = hasFlag('refresh-review-preview') || hasFlag('refreshReviewPreview');
  const missingFieldsOnly = hasFlag('missing-fields-only') || hasFlag('missingFieldsOnly');
  const rows = await fetchRows(Array.from(new Set(ids)), market);
  const results = [];

  for (const row of rows) {
    const url = pickRowUrl(row);
    const host = hostFromUrl(url);
    const result = {
      external_product_id: row.external_product_id,
      title: row.title,
      domain: row.domain,
      url,
      host,
      status: 'skipped',
      patch_keys: [],
    };
    if (!url || !host) {
      result.reason = 'missing_url';
      results.push(result);
      continue;
    }
    try {
      const fetched = await fetchHtml(url);
      result.http_status = fetched.status;
      result.final_url = fetched.final_url;
      const extracted = await extractOfficialHtmlFields(host, fetched.html, { productTitle: row.title, reviewSummaryOnly });
      const officialVariants = await fetchOfficialShopifyVariants(fetched.final_url || url, row);
      if (officialVariants.length > 0) extracted.variants = officialVariants;
      const { seedData, patchKeys } = buildSeedDataPatch(row, extracted, {
        reviewSummaryOnly,
        refreshReviewPreview,
        missingFieldsOnly,
      });
      result.patch_keys = patchKeys;
      result.extracted_summary = {
        ingredients_chars: normalizeText(extracted.pdp_ingredients_raw).length,
        how_to_chars: normalizeText(extracted.pdp_how_to_use_raw).length,
        details_sections_count: asArray(extracted.pdp_details_sections).length,
        variant_count: asArray(extracted.variants).length,
        review_count: extracted.review_summary?.review_count || 0,
        rating: extracted.review_summary?.rating || 0,
        review_preview_count: reviewPreviewCount(extracted.review_summary),
        review_preview_samples: asArray(extracted.review_summary?.preview_items)
          .slice(0, 3)
          .map((item) => ({
            rating: item.rating,
            title: item.title,
            text_snippet: item.text_snippet,
            source_kind: item.source_kind,
          })),
      };
      if (patchKeys.length === 0) {
        result.reason = 'no_official_html_fields';
        results.push(result);
        continue;
      }
      result.status = dryRun ? 'dry_run' : 'updated';
      if (!dryRun) {
        await query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                updated_at = NOW()
            WHERE external_product_id = $1
          `,
          [row.external_product_id, stringifyPostgresJsonb(seedData)],
        );
        result.serving_mirror_sync = await syncServingMirrors(row.external_product_id, seedData, patchKeys);
      } else {
        result.serving_mirror_sync = { planned: true };
      }
    } catch (error) {
      result.status = 'failed';
      result.error = error?.message || String(error);
    }
    results.push(result);
  }

  const summary = {
    scanned: rows.length,
    dry_run: results.filter((item) => item.status === 'dry_run').length,
    updated: results.filter((item) => item.status === 'updated').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    by_field: results.reduce((acc, item) => {
      for (const key of item.patch_keys || []) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };

  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    market,
    summary,
    results,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, dryRun ? 'dry-run.json' : 'apply.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  _internals: {
    findTirtirSheetIngredientRow,
    extractTirtirFaqHowToUse,
    extractSkin1004Fields,
    extractMedicubeFields,
    extractFentyFields,
    extractFentyFullIngredients,
    extractOfficialShopifyVariants,
    fetchStampedReviewSummary,
    fetchBazaarvoiceReviewSummary,
    fetchYotpoReviewSummary,
    parseOkendoReviewSummary,
    buildSeedDataPatch,
    buildServingPayloadPatch,
    hasUsefulReviewText,
    clearRecoveredStrictPdpSourceBlocker,
    buildShopifyProductJsonUrl,
    normalizeTirtirTitleKey,
    scoreTirtirSheetProductName,
    stringifyPostgresJsonb,
  },
};
