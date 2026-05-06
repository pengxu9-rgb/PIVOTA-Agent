#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { query, closePool } = require('../src/db');

const CONTRACT_VERSION = 'external_seed.official_html_pdp_fields.v1';
const PDP_CONTENT_ASSET_VERSION = 'pivota.pdp_content_asset.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

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
  return /\b(?:apply|use|massage|rinse|after cleansing|before|daily|morning|evening|night|leave on|pat)\b/i.test(text);
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

function cleanSectionText(value) {
  return normalizeText(stripHtml(value))
    .replace(/\bSee All\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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
  const fullIngredients =
    extractFirstParagraphAfter(html, /FULL INGREDIENTS/i) ||
    extractInlineTextAfterMarker(html, /FULL INGREDIENTS/i);
  if (looksLikeFullInci(fullIngredients) || looksLikeShortOfficialInci(fullIngredients)) {
    fields.pdp_ingredients_raw = fullIngredients;
  }

  const howMatch = html.match(/<h2[^>]*>\s*HOW TO USE\s*<\/h2>[\s\S]{0,3000}?<div[^>]*class="[^"]*prhow-txt[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  const howTo = howMatch ? cleanSectionText(howMatch[1]) : '';
  if (looksLikeHowToUse(howTo)) fields.pdp_how_to_use_raw = howTo;

  const review = parseMetafieldReviews(html);
  if (review) fields.review_summary = review;
  return fields;
}

function extractMedicubeFields(html) {
  const fields = {};
  const ingredientMatch = html.match(/<div[^>]*class="[^"]*\bwrite\b[^"]*"[^>]*id="test"[\s\S]*?<p[^>]*class="[^"]*\bdesc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const fullIngredients = ingredientMatch ? cleanSectionText(ingredientMatch[1]) : '';
  if (looksLikeFullInci(fullIngredients)) fields.pdp_ingredients_raw = fullIngredients;

  const keyIngredientBlock = extractInlineTextAfterMarker(
    html,
    /\b(?:Key|Main) Ingredients?\b/i,
    /\bBenefits\b|\bHow to use\b|<section\b|<script\b|<\/section>/i,
  );
  const activeItems = Array.from(
    new Set(
      [
        ...extractKnownHeroIngredients(keyIngredientBlock),
        ...keyIngredientBlock
          .split(/\n|>|•|\u2022|,/)
          .map((item) => normalizeText(item).replace(/\s+(?:improve|brightening|spot|targeting|red|dark).*/i, '').trim())
          .filter((item) => looksLikeActiveIngredientList(item)),
      ],
    ),
  );
  if (activeItems.length) {
    fields.pdp_active_ingredients_raw = activeItems.join(', ');
  }

  const stripped = stripHtml(html);
  const howMatches = Array.from(stripped.matchAll(/\bHOW TO USE\b/gi));
  for (const howMatch of howMatches) {
    if (howMatch.index < 2500) continue;
    const howSlice = stripped
      .slice(howMatch.index, howMatch.index + 1900)
      .replace(/^HOW TO USE\s*/i, '')
      .split(/\b(?:FAQ|KEY INGREDIENTS|MAIN INGREDIENTS|FULL INGREDIENTS|CLINICAL TEST|REVIEW|WHAT'S IN IT|WHAT IS IT|FOR MAXIMUM|MEDICUBE DELIVERS)\b|✔/i)[0];
    const howTo = normalizeText(howSlice);
    if (looksLikeHowToUse(howTo)) {
      fields.pdp_how_to_use_raw = howTo;
      break;
    }
  }

  const details = [];
  const keyIngredientsBlock = extractMedicubeCommentBlock(html, 'KEY INGREDIENTS', 'CLINICAL TEST');
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

function extractTirtirFaqHowToUse(tabText) {
  const normalized = normalizeText(tabText).replace(/\bRead more\b/gi, '').trim();
  if (!normalized) return '';
  const qaMatches = Array.from(
    normalized.matchAll(/Q:\s*([\s\S]*?)\s*A:\s*([\s\S]*?)(?=\s*Q:\s*|$)/gi),
  );
  for (const match of qaMatches) {
    const question = normalizeText(match[1]);
    const answer = normalizeText(match[2]);
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

  const review = parseMetafieldReviews(html);
  if (review) fields.review_summary = review;
  return fields;
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
  if (text.length < 35 || text.length > 700) return false;
  if (text.split(/\s+/).filter(Boolean).length < 7) return false;
  if (/^(?:great|good|love it|perfect|nice|bien)$/i.test(text)) return false;
  return true;
}

function normalizeStampedPreviewItems(rows) {
  return asArray(rows)
    .filter((row) => hasUsefulReviewText(row?.reviewMessage))
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

async function fetchStampedReviewSummary(host, html) {
  if (!['medicube.us', 'skin1004.com'].includes(host)) return null;
  const context = extractStampedContext(host, html);
  if (!context) return null;

  const reviewsUrl = buildStampedUrl('reviews', context, { page: '1', take: '20' });
  const reviews = await fetchJson(reviewsUrl);
  const reviewRows = asArray(reviews?.data);

  let widget = null;
  if (context.apiKey) {
    widget = await fetchJson(buildStampedUrl('', context));
  }

  const rating = Number(widget?.rating || reviews?.rating || reviews?.ratingAll || 0);
  const reviewCount = Math.round(Number(widget?.count || reviews?.total || reviews?.totalAll || 0));
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

async function extractOfficialHtmlFields(host, html, options = {}) {
  let fields = {};
  if (host === 'skin1004.com') fields = extractSkin1004Fields(html);
  else if (host === 'medicube.us') fields = extractMedicubeFields(html);
  else if (host === 'tirtir.global') fields = await extractTirtirFields(html, options);
  else return {};

  const stampedReview = await fetchStampedReviewSummary(host, html);
  if (stampedReview) {
    fields.review_summary = {
      ...ensureObject(fields.review_summary),
      ...stampedReview,
      source_origin: stampedReview.source_origin || fields.review_summary?.source_origin,
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
  if (patchKeys.includes('pdp_ingredients_raw')) set('ingredients_raw', 'official_pdp_full_ingredients');
  if (patchKeys.includes('pdp_active_ingredients_raw')) set('active_ingredients_raw', 'official_pdp_key_ingredients');
  if (patchKeys.includes('pdp_how_to_use_raw')) set('how_to_use_raw', 'official_pdp_how_to_use');
  if (patchKeys.includes('pdp_details_sections')) set('details_sections', 'official_pdp_details_section');
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
  if (patch.pdp_details_sections?.length) set('details_sections', patch.pdp_details_sections, 'official_pdp_details_section');
  return next;
}

function buildSeedDataPatch(row, extracted) {
  const seedData = JSON.parse(JSON.stringify(ensureObject(row.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const patchKeys = [];

  if (extracted.pdp_ingredients_raw) {
    seedData.pdp_ingredients_raw = extracted.pdp_ingredients_raw;
    seedData.raw_ingredient_text_clean = extracted.pdp_ingredients_raw;
    snapshot.pdp_ingredients_raw = extracted.pdp_ingredients_raw;
    snapshot.raw_ingredient_text_clean = extracted.pdp_ingredients_raw;
    patchKeys.push('pdp_ingredients_raw');
  }
  if (extracted.pdp_active_ingredients_raw) {
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
  if (extracted.pdp_how_to_use_raw) {
    seedData.pdp_how_to_use_raw = extracted.pdp_how_to_use_raw;
    snapshot.pdp_how_to_use_raw = extracted.pdp_how_to_use_raw;
    patchKeys.push('pdp_how_to_use_raw');
  }
  if (asArray(extracted.pdp_details_sections).length > 0) {
    const merged = mergeDetails(seedData.pdp_details_sections || snapshot.pdp_details_sections, extracted.pdp_details_sections);
    seedData.pdp_details_sections = merged;
    snapshot.pdp_details_sections = merged;
    patchKeys.push('pdp_details_sections');
  }
  if (extracted.review_summary) {
    const existing = ensureObject(seedData.review_summary || snapshot.review_summary);
    const incoming = mergeReviewSummary(existing, extracted.review_summary);
    seedData.review_summary = incoming;
    snapshot.review_summary = incoming;
    patchKeys.push('review_summary');
  }

  if (patchKeys.some((key) => key !== 'review_summary')) {
    const quality = mergeQualitySummary(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary, patchKeys);
    seedData.pdp_field_quality_summary = quality;
    snapshot.pdp_field_quality_summary = quality;
    seedData.pdp_content_asset_v1 = mergeContentAsset(seedData.pdp_content_asset_v1 || snapshot.pdp_content_asset_v1, extracted);
    snapshot.pdp_content_asset_v1 = seedData.pdp_content_asset_v1;
    seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract);
    snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract);
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

async function fetchRows(ids, market) {
  const res = await query(
    `
      SELECT id, external_product_id, title, domain, market, canonical_url, destination_url, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR market = $2::text)
      ORDER BY array_position($1::text[], external_product_id::text)
    `,
    [ids, market],
  );
  return res.rows || [];
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
      const extracted = await extractOfficialHtmlFields(host, fetched.html, { productTitle: row.title });
      const { seedData, patchKeys } = buildSeedDataPatch(row, extracted);
      result.patch_keys = patchKeys;
      result.extracted_summary = {
        ingredients_chars: normalizeText(extracted.pdp_ingredients_raw).length,
        how_to_chars: normalizeText(extracted.pdp_how_to_use_raw).length,
        details_sections_count: asArray(extracted.pdp_details_sections).length,
        review_count: extracted.review_summary?.review_count || 0,
        rating: extracted.review_summary?.rating || 0,
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
          [row.external_product_id, JSON.stringify(seedData)],
        );
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
    normalizeTirtirTitleKey,
    scoreTirtirSheetProductName,
  },
};
