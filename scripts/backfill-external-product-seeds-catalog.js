#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const axios = require('axios');
const { query, withClient } = require('../src/db');
const { lookupExternalSeedImageOverride } = require('../src/services/externalSeedImageOverrides');
const {
  EXTERNAL_SEED_MERCHANT_ID,
  ensureJsonObject,
  collectSeedImageUrls,
  normalizeSeedVariants,
  normalizeSeedAvailability,
  buildExternalSeedProduct,
} = require('../src/services/externalSeedProducts');
const { buildExternalSeedRecallDoc } = require('../src/services/externalSeedRecall');
const { enrichExternalSeedRowIngredients } = require('../src/services/externalSeedIngredientEnrichment');
const { isDisplayablePdpFaqItem } = require('../src/services/pdpFaqQuality');
const { buildPdpImageDedupeKey, normalizePdpImageUrl } = require('../src/utils/pdpImageUrls');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const MARKET_LOCALE_SEGMENT = {
  US: 'en-us',
  'EU-DE': 'de-de',
  SG: 'en-sg',
  JP: 'ja-jp',
};

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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

function readDelimitedIdsFile(filePath) {
  const path = normalizeNonEmptyString(filePath);
  if (!path) return [];
  return parseDelimitedIds(fs.readFileSync(path, 'utf8'));
}

function normalizeNonEmptyString(value) {
  const next = String(value || '').trim();
  return next || '';
}

function decodeBasicHtmlEntities(value) {
  const raw = normalizeNonEmptyString(value);
  if (!raw) return '';
  return raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, ' - ')
    .replace(/&hellip;/gi, '...')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const codePoint = Number.parseInt(dec, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    });
}

function normalizePdpCopy(value) {
  return decodeBasicHtmlEntities(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, ' - ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeUrlLike(value) {
  const next = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(next) ? next : '';
}

function normalizeUrlKey(value) {
  return normalizeUrlLike(value).replace(/\/+$/, '').toLowerCase();
}

function normalizeTitleKey(value) {
  return normalizeNonEmptyString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const LOCALE_PATH_SEGMENT_RE = /^[a-z]{2}(?:-|_)[a-z]{2}$/i;
const NON_PRODUCT_PATH_RE =
  /(?:^|\/)(?:collections?|collection|category|catalogsearch|search|cart|account|customer|blog|blogs|pages?|faq|privacy|terms|wishlist|gift(?:ing)?|store-locator|customer-service|all-products|appointments?|booking|online-booking|locations?|contact-us)(?:\/|$)/i;

function normalizeComparableUrlKey(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] && LOCALE_PATH_SEGMENT_RE.test(segments[0])) segments.shift();
    if (segments[0] === 'product') segments[0] = 'products';
    parsed.pathname = `/${segments.join('/')}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return normalizeUrlKey(normalized);
  }
}

const SHOPIFY_MARKET_HANDLE_SUFFIX_RE = /-(?:eu|europe|ca|canada|us|usa|uk|gb|au|australia)$/i;

function normalizeProductHandleToken(value) {
  return normalizeVariantHintToken(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractShopifyHandleFromUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const matched = parsed.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products?\/([^/?#]+)/i);
    return normalizeProductHandleToken(matched?.[1] || '');
  } catch {
    return '';
  }
}

function stripShopifyMarketHandleSuffix(handle) {
  let normalized = normalizeProductHandleToken(handle);
  for (let idx = 0; idx < 3; idx += 1) {
    const stripped = normalized.replace(SHOPIFY_MARKET_HANDLE_SUFFIX_RE, '');
    if (stripped === normalized) break;
    normalized = stripped;
  }
  return normalized;
}

function isVerifiedShopifyMarketReplacement(targetUrl, productUrl) {
  const targetHandle = extractShopifyHandleFromUrl(targetUrl);
  const productHandle = extractShopifyHandleFromUrl(productUrl);
  if (!targetHandle || !productHandle || targetHandle === productHandle) return false;

  const targetBase = stripShopifyMarketHandleSuffix(targetHandle);
  const productBase = stripShopifyMarketHandleSuffix(productHandle);
  if (!targetBase || !productBase) return false;

  return productHandle.startsWith(`${targetBase}-`) || productBase === targetBase;
}

function looksLikeDirectProductTargetUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.toLowerCase();
    if (path === '/' || path === '') return false;
    if (NON_PRODUCT_PATH_RE.test(path)) return false;
    if (/\/products?\//.test(path) || /\/p\/[^/]+$/.test(path) || /\.html$/.test(path)) return true;
    const lastSegment = path.split('/').filter(Boolean).pop() || '';
    const hyphenCount = (lastSegment.match(/-/g) || []).length;
    return hyphenCount >= 2;
  } catch {
    return false;
  }
}

function looksLikeKnownNonProductUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.toLowerCase();
    return NON_PRODUCT_PATH_RE.test(path) || /(?:^|\/)contact-us(?:\.html)?(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
}

function uniqueStrings(values) {
  const out = [];
  for (const value of values) {
    const next = normalizeNonEmptyString(value);
    if (!next || out.includes(next)) continue;
    out.push(next);
  }
  return out;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function stableHash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function stableVariantSeedId(row, variant) {
  const parentKey = normalizeNonEmptyString(row?.id || row?.external_product_id || row?.destination_url);
  const variantKey = normalizeNonEmptyString(variant?.variant_id || variant?.id || variant?.sku || variant?.url);
  return `epsv_${stableHash(`${parentKey}|${variantKey}`, 24)}`;
}

function stableVariantExternalProductId(row, variant) {
  const parentKey = normalizeNonEmptyString(row?.external_product_id || row?.id || row?.destination_url);
  const variantKey = normalizeNonEmptyString(variant?.variant_id || variant?.id || variant?.sku || variant?.url);
  return `ext_${stableHash(`${parentKey}|${variantKey}`, 24)}`;
}

function normalizeVariantHintToken(value) {
  return normalizeNonEmptyString(value).toLowerCase();
}

function collectVariantHintTokensFromUrl(value) {
  const raw = normalizeUrlLike(value);
  if (!raw) return [];
  try {
    const parsed = new URL(raw);
    const out = [];
    for (const [key, paramValue] of parsed.searchParams.entries()) {
      const normalizedKey = normalizeVariantHintToken(key);
      const normalizedValue = normalizeVariantHintToken(paramValue);
      if (!normalizedValue) continue;
      if (!['v', 'variant', 'variant_id', 'sku', 'sku_id', 'pid'].includes(normalizedKey)) continue;
      out.push(normalizedValue);
    }
    return out;
  } catch {
    return [];
  }
}

function collectVariantIdentityTokens(variant) {
  const optionValues = [];
  if (Array.isArray(variant?.options)) {
    for (const option of variant.options) {
      if (!option || typeof option !== 'object') continue;
      optionValues.push(option.value, option.option_value);
    }
  }
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

function pickVariantByHints(variants, hints = []) {
  const safeVariants = Array.isArray(variants) ? variants.filter(Boolean) : [];
  const hintTokens = Array.from(
    new Set(
      hints
        .flatMap((hint) => {
          const normalized = normalizeNonEmptyString(hint);
          if (!normalized) return [];
          if (/^https?:\/\//i.test(normalized)) return collectVariantHintTokensFromUrl(normalized);
          return [normalized];
        })
        .map((item) => normalizeVariantHintToken(item))
        .filter(Boolean),
    ),
  );
  if (!safeVariants.length || !hintTokens.length) return null;
  const matches = safeVariants.filter((variant) => variantMatchesHintTokens(variant, hintTokens));
  return matches.length === 1 ? matches[0] : null;
}

function getVariantId(variant) {
  return normalizeNonEmptyString(variant?.variant_id || variant?.id || variant?.sku || variant?.sku_id);
}

function getVariantTitle(variant) {
  return normalizeNonEmptyString(
    variant?.option_value ||
      variant?.title ||
      (Array.isArray(variant?.options) ? variant.options.map((item) => item?.value).filter(Boolean).join(' / ') : '') ||
      variant?.sku,
  );
}

function isDefaultVariantTitle(value) {
  return /^(?:default|default title|title)$/i.test(normalizeNonEmptyString(value));
}

function collectVariantImageUrls(variant, options = {}) {
  return sanitizeSeedImageUrls(
    [
      ...(Array.isArray(variant?.image_urls) ? variant.image_urls : []),
      ...(Array.isArray(variant?.images) ? variant.images : []),
      variant?.image_url,
      variant?.image,
    ],
    options,
  );
}

function collectProductImageUrls(product, options = {}) {
  return sanitizeSeedImageUrls(
    [
      ...(Array.isArray(product?.image_urls) ? product.image_urls : []),
      ...(Array.isArray(product?.images) ? product.images : []),
      product?.image_url,
      product?.image,
    ],
    options,
  );
}

function isDecorativeSeedImageUrl(value) {
  const normalized = normalizeUrlLike(value).toLowerCase();
  if (!normalized) return false;
  return (
    normalized.endsWith('.svg') ||
    normalized.includes('.svg?') ||
    normalized.includes('/menu.svg') ||
    normalized.includes('/close.svg') ||
    normalized.includes('/icon-') ||
    normalized.includes('icon-search') ||
    normalized.includes('icon-cart') ||
    normalized.includes('icon-account') ||
    normalized.includes('/logo.svg') ||
    normalized.includes('/tf_logo.svg') ||
    /[_-]\d{2,3}x\d{2,3}_crop_center(?:[._-]|$)/i.test(normalized) ||
    normalized.includes('sealofapproval') ||
    normalized.includes('which_spf_is_right_for_you') ||
    normalized.includes('/screenshot_') ||
    normalized.includes('/screenshot20') ||
    normalized.includes('gnav-shop-') ||
    normalized.includes('shade-finder-hero-')
  );
}

const IMAGE_RELEVANCE_BUNDLE_TOKENS = new Set([
  'bundle',
  'bundles',
  'discovery',
  'discoveryset',
  'discoverysets',
  'duo',
  'duos',
  'kit',
  'kits',
  'pair',
  'pairs',
  'sample',
  'samples',
  'set',
  'sets',
  'trio',
  'trios',
  'vault',
  'wardrobe',
]);
const IMAGE_RELEVANCE_PRODUCT_TYPE_ALIASES = {
  balm: 'balm',
  blush: 'blush',
  bodywash: 'wash',
  bronzer: 'bronzer',
  cleanser: 'cleanser',
  concealer: 'concealer',
  conditioner: 'conditioner',
  cream: 'cream',
  essence: 'essence',
  eyeliner: 'eyeliner',
  foundation: 'foundation',
  gel: 'gel',
  gloss: 'gloss',
  highlighter: 'highlighter',
  liner: 'liner',
  lipstick: 'lipstick',
  lotion: 'lotion',
  mascara: 'mascara',
  mask: 'mask',
  mist: 'mist',
  moisturizer: 'moisturizer',
  oil: 'oil',
  patch: 'patch',
  patches: 'patch',
  pen: 'pen',
  powder: 'powder',
  scrub: 'scrub',
  serum: 'serum',
  shampoo: 'shampoo',
  spray: 'mist',
  stick: 'stick',
  toner: 'toner',
  wash: 'wash',
};
const IMAGE_RELEVANCE_NOISE_TOKENS = new Set([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'after',
  'alt',
  'beauty',
  'circle',
  'closed',
  'ecomm',
  'file',
  'files',
  'hero',
  'imperfect',
  'img',
  'image',
  'images',
  'lifestyle',
  'line',
  'mini',
  'model',
  'open',
  'pdp',
  'product',
  'products',
  'rare',
  'shop',
  'swatch',
  'thumb',
  'thumbnail',
  'design',
  'travel',
  'untitled',
  'usage',
]);

function tokenizeImageRelevanceValue(value) {
  return normalizeNonEmptyString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !IMAGE_RELEVANCE_NOISE_TOKENS.has(token));
}

function extractCanonicalImageProductTypes(values) {
  const out = [];
  for (const token of Array.isArray(values) ? values : []) {
    const canonical = IMAGE_RELEVANCE_PRODUCT_TYPE_ALIASES[token];
    if (!canonical || out.includes(canonical)) continue;
    out.push(canonical);
  }
  return out;
}

function extractImageFilenameTokens(value) {
  const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
  if (!normalized) return [];
  try {
    const parsed = new URL(normalized);
    const filename = decodeBasicHtmlEntities(decodeURIComponent(parsed.pathname.split('/').pop() || ''))
      .replace(/\.[a-z0-9]+$/i, '')
      .trim();
    return tokenizeImageRelevanceValue(filename);
  } catch {
    return tokenizeImageRelevanceValue(normalized);
  }
}

function extractImageSignatureTokens(values) {
  return uniqueStrings(
    (Array.isArray(values) ? values : [])
      .map((token) => normalizeNonEmptyString(token).toLowerCase())
      .filter(Boolean)
      .filter((token) => token.length >= 5)
      .filter((token) => /^[a-z]+$/.test(token))
      .filter((token) => !IMAGE_RELEVANCE_NOISE_TOKENS.has(token))
      .filter((token) => !IMAGE_RELEVANCE_BUNDLE_TOKENS.has(token))
      .filter((token) => !IMAGE_RELEVANCE_PRODUCT_TYPE_ALIASES[token]),
  );
}

function extractImageFilenameText(value) {
  const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return decodeBasicHtmlEntities(decodeURIComponent(parsed.pathname.split('/').pop() || ''))
      .replace(/\.[a-z0-9]+$/i, '')
      .trim()
      .toLowerCase();
  } catch {
    return normalizeNonEmptyString(normalized).toLowerCase();
  }
}

function buildSeedImageRelevanceContext(options = {}) {
  let normalizedProductUrl = '';
  const rawProductUrl = normalizeNonEmptyString(options.productUrl);
  if (rawProductUrl) {
    try {
      normalizedProductUrl = decodeBasicHtmlEntities(decodeURIComponent(new URL(rawProductUrl).pathname || ''));
    } catch {
      normalizedProductUrl = rawProductUrl;
    }
  }
  const values = uniqueStrings([
    options.productTitle,
    normalizedProductUrl,
    options.variantTitle && !isDefaultVariantTitle(options.variantTitle) ? options.variantTitle : '',
    ...(Array.isArray(options.additionalValues) ? options.additionalValues : []),
  ]);
  const tokens = values.flatMap((value) => tokenizeImageRelevanceValue(value));
  return {
    bundleLike: tokens.some((token) => IMAGE_RELEVANCE_BUNDLE_TOKENS.has(token)),
    productTypes: extractCanonicalImageProductTypes(tokens),
    signatureTokens: extractImageSignatureTokens(tokens),
  };
}

function imageAssetHostname(value) {
  const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
  if (!normalized) return '';
  try {
    return String(new URL(normalized).hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function isCollectionStyleSeedImageUrl(value) {
  const filename = extractImageFilenameText(value);
  if (!filename) return false;
  const hostname = imageAssetHostname(value);
  return (
    /(?:^|[-_ ])pdp[-_ ]bundle[-_ ]thumbnail(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])bundle[-_ ]thumbnail(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])fullgroup(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])groupshot(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])group[-_ ]shot(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])bulk[-_ ]20product(?:[-_ ]|$)/i.test(filename) ||
    (/rarebeauty\.com$/i.test(hostname) && /(?:^|[-_ ])collection(?:[-_ ]|$)/i.test(filename))
  );
}

function isProductRelevantSeedImageUrl(value, relevanceContext) {
  if (!relevanceContext) {
    return true;
  }
  if (!relevanceContext.bundleLike && isCollectionStyleSeedImageUrl(value)) return false;
  const imageTokens = extractImageFilenameTokens(value);
  if (
    !relevanceContext.bundleLike &&
    imageTokens.some((token) => IMAGE_RELEVANCE_BUNDLE_TOKENS.has(token)) &&
    extractCanonicalImageProductTypes(imageTokens).length > 1
  ) {
    return false;
  }
  if (
    !relevanceContext.bundleLike &&
    Array.isArray(relevanceContext.signatureTokens) &&
    relevanceContext.signatureTokens.length > 0
  ) {
    const imageSignatureTokens = extractImageSignatureTokens(imageTokens);
    if (
      imageSignatureTokens.length > 1 &&
      !imageSignatureTokens.some((token) => relevanceContext.signatureTokens.includes(token))
    ) {
      return false;
    }
  }
  if (relevanceContext.bundleLike || relevanceContext.productTypes.length !== 1) return true;
  const imageProductTypes = extractCanonicalImageProductTypes(imageTokens);
  if (imageProductTypes.length === 0) return true;
  return imageProductTypes.includes(relevanceContext.productTypes[0]);
}

function normalizeComparableImageKey(value) {
  const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
  if (!normalized) return '';
  const dedupeKey = buildPdpImageDedupeKey(normalized);
  if (dedupeKey) return dedupeKey;
  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return String(segments[segments.length - 1] || '').toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

function sanitizeSeedImageUrls(values, options = {}) {
  const relevanceContext =
    options && typeof options === 'object' && options.relevanceContext
      ? options.relevanceContext
      : buildSeedImageRelevanceContext(options);
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
    if (!normalized || isDecorativeSeedImageUrl(normalized)) continue;
    if (!isProductRelevantSeedImageUrl(normalized, relevanceContext)) continue;
    const comparableKey = normalizeComparableImageKey(normalized);
    if (!comparableKey || seen.has(comparableKey)) continue;
    seen.add(comparableKey);
    out.push(normalized);
  }
  return out;
}

function shouldMergeProductGalleryForSelectedVariant(selectedVariantImageUrls, productImageUrls) {
  const selectedKeys = uniqueStrings(
    (Array.isArray(selectedVariantImageUrls) ? selectedVariantImageUrls : [])
      .map(normalizeComparableImageKey)
      .filter(Boolean),
  );
  const productKeys = uniqueStrings(
    (Array.isArray(productImageUrls) ? productImageUrls : [])
      .map(normalizeComparableImageKey)
      .filter(Boolean),
  );
  if (selectedKeys.length === 0 || productKeys.length <= selectedKeys.length) return false;
  if (selectedKeys.length === 1) return selectedKeys[0] === productKeys[0];
  return selectedKeys.every((key) => productKeys.includes(key));
}

async function probeSeedImageUrl(url) {
  const target = normalizeUrlLike(url);
  if (!target) return { url, ok: false, status: null, content_type: null, error: 'invalid_url' };
  const requestConfig = {
    timeout: Number(process.env.EXTERNAL_SEED_BACKFILL_IMAGE_TIMEOUT_MS || 5000),
    headers: {
      Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      'User-Agent': 'Pivota external seed backfill/1.0',
    },
    validateStatus: () => true,
  };
  try {
    let response = await axios.head(target, requestConfig);
    if ([403, 405].includes(Number(response.status))) {
      response = await axios.get(target, {
        ...requestConfig,
        responseType: 'arraybuffer',
        headers: {
          ...requestConfig.headers,
          Range: 'bytes=0-0',
        },
        maxContentLength: 1024 * 64,
      });
    }
    const status = Number(response.status || 0);
    const contentType = normalizeNonEmptyString(response.headers?.['content-type']).toLowerCase();
    return {
      url: target,
      ok: status >= 200 && status < 400 && (!contentType || contentType.includes('image/')),
      status: status || null,
      content_type: contentType || null,
    };
  } catch (error) {
    return {
      url: target,
      ok: false,
      status: null,
      content_type: null,
      error: normalizeNonEmptyString(error?.code || error?.message || 'request_failed'),
    };
  }
}

function applyValidatedImageUrls(nextRow, validImageUrls, validation) {
  const seedData = ensureJsonObject(nextRow.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const imageUrl = validImageUrls[0] || '';
  const nextSeedData = {
    ...seedData,
    ...(imageUrl ? { image_url: imageUrl, image_urls: validImageUrls, images: validImageUrls } : {}),
    snapshot: {
      ...snapshot,
      ...(imageUrl ? { image_url: imageUrl, image_urls: validImageUrls, images: validImageUrls } : {}),
      diagnostics: {
        ...ensureJsonObject(snapshot.diagnostics),
        image_health_validation: validation,
      },
    },
  };
  return {
    ...nextRow,
    ...(imageUrl ? { image_url: imageUrl } : {}),
    seed_data: nextSeedData,
  };
}

async function validateNextRowImageHealth(nextRow) {
  const seedData = ensureJsonObject(nextRow.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const imageUrls = sanitizeSeedImageUrls([
    nextRow.image_url,
    seedData.image_url,
    ...(Array.isArray(seedData.image_urls) ? seedData.image_urls : []),
    snapshot.image_url,
    ...(Array.isArray(snapshot.image_urls) ? snapshot.image_urls : []),
  ]);
  if (!imageUrls.length) {
    return {
      nextRow,
      validation: {
        skipped: true,
        reason: 'no_candidate_images',
        scanned_count: 0,
        broken_count: 0,
      },
    };
  }
  const checks = [];
  for (const url of imageUrls) {
    checks.push(await probeSeedImageUrl(url));
  }
  const validImageUrls = checks.filter((item) => item.ok).map((item) => item.url);
  const broken = checks.filter((item) => !item.ok);
  const validation = {
    skipped: false,
    scanned_count: checks.length,
    valid_count: validImageUrls.length,
    broken_count: broken.length,
    broken_urls: broken.slice(0, 20),
  };
  if (!validImageUrls.length) {
    return {
      nextRow,
      validation: {
        ...validation,
        status: 'failed_no_valid_images',
      },
    };
  }
  return {
    nextRow: applyValidatedImageUrls(nextRow, validImageUrls, {
      ...validation,
      status: broken.length ? 'filtered_broken_images' : 'passed',
    }),
    validation: {
      ...validation,
      status: broken.length ? 'filtered_broken_images' : 'passed',
    },
  };
}

function normalizeDetailSectionHeading(value) {
  const heading = normalizeNonEmptyString(value);
  if (!heading) return '';
  if (/^(?:overview|what it is|give it to me quick)$/i.test(heading)) return 'Overview';
  if (/^(?:product details?|details?|about(?: the product)?|description)$/i.test(heading)) return 'Details';
  if (/^(?:features?|tell me more)$/i.test(heading)) return 'Details';
  if (/^(?:dimensions?|specifications?)$/i.test(heading)) return 'Dimensions';
  if (/^(?:benefits?|why it works|what it does|why we love it)$/i.test(heading)) return 'Benefits';
  if (/^(?:key ingredients?|highlight(?:ed)? ingredients?|ingredients story)$/i.test(heading)) {
    return 'Key Ingredients';
  }
  if (/^(?:clinical(?: results?| claims?)?|results?|proven results?)$/i.test(heading)) {
    return 'Clinical Results';
  }
  if (/^(?:how to use|how to apply|directions?|usage)$/i.test(heading)) return 'How to Use';
  if (/^(?:ingredients?|ingredients and safety|ingredient list|full ingredients?|full ingredient list|inci)$/i.test(heading)) {
    return 'Ingredients';
  }
  if (/^(?:faq|frequently asked questions?|q(?:uestions)?\s*&\s*a|questions?)$/i.test(heading)) {
    return 'FAQ';
  }
  return heading;
}

function stripTrailingPdpSectionNoise(value, { removeFreeFrom = false } = {}) {
  let next = normalizePdpCopy(value);
  if (!next) return '';
  const stopPatterns = [
    /\bFull Ingredients\b/i,
    /\bIngredients\b\s*[:\n]/i,
    /\bHow to Use\b\s*[:\n]/i,
    /\bDirections?\b\s*[:\n]/i,
    /\bFAQ\b\s*[:\n]/i,
    /\bFrequently Asked Questions?\b\s*[:\n]/i,
  ];
  if (removeFreeFrom) {
    stopPatterns.push(/\bFree\s+From\b\s*:?\s*/i);
    stopPatterns.push(/\bFree\s+of\s+potentially\s+harmful\b/i);
  }
  for (const pattern of stopPatterns) {
    const match = next.match(pattern);
    if (match && match.index > 20) next = next.slice(0, match.index).trim();
  }
  return next;
}

function isStorefrontBoilerplateDescription(value) {
  const normalized = normalizePdpCopy(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    normalized.includes('fenty beauty by rihanna was created') &&
    normalized.includes('unmatched offering of shades and colors') &&
    normalized.includes('browse our foundation line') &&
    normalized.includes('lip colors')
  );
}

function isPromotionalPdpDetailsSection(heading, body) {
  const normalizedHeading = normalizePdpCopy(heading)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const normalizedBody = normalizePdpCopy(body)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalizedHeading || !normalizedBody) return false;
  return (
    normalizedHeading === 'heavy on the hydration' &&
    /make a splash in juicy makeup skincare haircare must haves/.test(normalizedBody)
  );
}

function isReviewFormPdpDetailsSection(heading, body) {
  const normalizedHeading = normalizePdpCopy(heading)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const normalizedBody = normalizePdpCopy(body)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalizedHeading || !normalizedBody) return false;
  return (
    normalizedHeading === 'tell us about yourself' &&
    normalizedBody.includes('we ll never show your full name or email') &&
    normalizedBody.includes('enter a valid email') &&
    normalizedBody.includes('please fill all of the required fields')
  );
}

function findMarkerRange(value, pattern) {
  const text = normalizePdpCopy(value);
  const match = text.match(pattern);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

function minPositiveIndex(...indexes) {
  return indexes.filter((value) => Number.isInteger(value) && value >= 0).sort((a, b) => a - b)[0] ?? -1;
}

function cleanEncodedAccordionSegment(value) {
  return normalizePdpCopy(value)
    .replace(/^\s*[-*]\s*/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function expandEncodedAccordionSection(item) {
  const body = normalizePdpCopy(item?.body);
  if (!body) return [item];
  const quickMarker = findMarkerRange(body, /\bGIVE IT TO ME QUICK\s*:?\s*/i);
  const tellMarker = findMarkerRange(body, /\bTELL ME MORE\s*:?\s*/i);
  if (!quickMarker && !tellMarker) return [item];

  const dimensionsMarker = findMarkerRange(body, /\bDimensions(?:\s+(?:with base|mirror only)|\s*-\s*mirror only)?\s*:\s*/i);
  const sourceKind = normalizeNonEmptyString(item?.source_kind || item?.sourceKind) || 'unknown';
  const out = [];

  if (quickMarker) {
    const quickEnd = minPositiveIndex(
      tellMarker && tellMarker.start > quickMarker.end ? tellMarker.start : -1,
      dimensionsMarker && dimensionsMarker.start > quickMarker.end ? dimensionsMarker.start : -1,
    );
    const overviewBody = cleanEncodedAccordionSegment(body.slice(quickMarker.end, quickEnd === -1 ? body.length : quickEnd));
    if (overviewBody) {
      out.push({
        heading: 'Overview',
        body: overviewBody,
        source_kind: sourceKind,
      });
    }
  }

  if (tellMarker) {
    const detailsEnd =
      dimensionsMarker && dimensionsMarker.start > tellMarker.end ? dimensionsMarker.start : body.length;
    const detailsBody = cleanEncodedAccordionSegment(body.slice(tellMarker.end, detailsEnd));
    if (detailsBody) {
      out.push({
        heading: 'Details',
        body: detailsBody,
        source_kind: sourceKind,
      });
    }
  }

  if (dimensionsMarker) {
    const dimensionsBody = cleanEncodedAccordionSegment(body.slice(dimensionsMarker.start));
    if (dimensionsBody) {
      out.push({
        heading: 'Dimensions',
        body: dimensionsBody,
        source_kind: sourceKind,
      });
    }
  }

  return out.length > 0 ? out : [item];
}

function cleanPdpDescriptionCandidate(value, detailsSections = []) {
  let next = normalizePdpCopy(value);
  if (!next || isStorefrontBoilerplateDescription(next)) return '';

  const quickMarker = findMarkerRange(next, /\bGIVE IT TO ME QUICK\s*:?\s*/i);
  if (quickMarker) {
    const tellMarker = findMarkerRange(next, /\bTELL ME MORE\s*:?\s*/i);
    const dimensionsMarker = findMarkerRange(next, /\bDimensions(?:\s+(?:with base|mirror only)|\s*-\s*mirror only)?\s*:\s*/i);
    const quickEnd = minPositiveIndex(
      tellMarker && tellMarker.start > quickMarker.end ? tellMarker.start : -1,
      dimensionsMarker && dimensionsMarker.start > quickMarker.end ? dimensionsMarker.start : -1,
    );
    next = cleanEncodedAccordionSegment(next.slice(quickMarker.end, quickEnd === -1 ? next.length : quickEnd));
  }

  if (/\bTELL ME MORE\s*:?/i.test(next) || /\bDimensions(?:\s+(?:with base|mirror only)|\s*-\s*mirror only)?\s*:/i.test(next)) {
    const overview = detailsSections.find((section) => section.heading === 'Overview');
    if (overview?.body) return overview.body;
    return '';
  }

  return next;
}

function cleanPdpDetailsSectionBody(heading, value) {
  let next = normalizePdpCopy(value);
  if (!next) return '';
  if (isStorefrontBoilerplateDescription(next)) return '';
  if (isPromotionalPdpDetailsSection(heading, next)) return '';
  if (isReviewFormPdpDetailsSection(heading, next)) return '';
  if (heading === 'Ingredients') return cleanPdpIngredientsRaw(next);
  if (heading === 'How to Use' || heading === 'FAQ') return next;
  return stripTrailingPdpSectionNoise(next, { removeFreeFrom: true });
}

function sectionBodySignature(body) {
  return normalizeNonEmptyString(body)
    .replace(/^Benefits?\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function sectionContentSignature(heading, body) {
  const normalizedBody = sectionBodySignature(body);
  return `${heading.toLowerCase()}|${normalizedBody}`;
}

function findNearDuplicateSectionIndex(sections, heading, body) {
  const bodySignature = sectionBodySignature(body);
  if (bodySignature.length < 80) return -1;
  return sections.findIndex((section) => {
    if (section.heading !== heading) return false;
    const existingSignature = sectionBodySignature(section.body);
    if (existingSignature.length < 80) return false;
    return (
      bodySignature === existingSignature ||
      bodySignature.includes(existingSignature) ||
      existingSignature.includes(bodySignature)
    );
  });
}

function normalizeDetailsSections(value, maxItems = 24) {
  const items = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const originalItem of items) {
    const expandedItems = expandEncodedAccordionSection(originalItem);
    for (const item of expandedItems) {
      let heading = normalizeDetailSectionHeading(item?.heading);
      let body = normalizePdpCopy(item?.body);
      const sourceKind = normalizeNonEmptyString(item?.source_kind || item?.sourceKind) || 'unknown';
      if (!heading || !body) continue;
      if (heading === 'Details' && /^Benefits?\s*:/i.test(body)) {
        heading = 'Benefits';
        body = body.replace(/^Benefits?\s*:\s*/i, '').trim();
      }
      body = cleanPdpDetailsSectionBody(heading, body);
      if (!body) continue;
      const key = `${sectionContentSignature(heading, body)}|${sourceKind.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const duplicateIndex = findNearDuplicateSectionIndex(out, heading, body);
      if (duplicateIndex !== -1) {
        if (body.length > out[duplicateIndex].body.length) {
          out[duplicateIndex] = {
            heading,
            body,
            source_kind: sourceKind,
          };
        }
        continue;
      }
      out.push({
        heading,
        body,
        source_kind: sourceKind,
      });
      if (out.length >= Math.max(1, Number(maxItems) || 24)) break;
    }
    if (out.length >= Math.max(1, Number(maxItems) || 24)) break;
  }
  return out;
}

function normalizeFaqItems(value, maxItems = 24) {
  const items = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const question = normalizeNonEmptyString(item?.question)
      .replace(/^(?:q(?:uestion)?\s*[:/-]\s*)/i, '')
      .trim();
    const answer = normalizeNonEmptyString(item?.answer)
      .replace(/^(?:a(?:nswer)?\s*[:/-]\s*)/i, '')
      .trim();
    const sourceKind = normalizeNonEmptyString(item?.source_kind || item?.sourceKind) || 'merchant_faq';
    const sourceUrl = normalizeUrlLike(item?.source_url || item?.sourceUrl);
    const sourceTitle = normalizeNonEmptyString(item?.source_title || item?.sourceTitle);
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

function stableComparableJson(value) {
  if (Array.isArray(value)) return value.map((item) => stableComparableJson(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableComparableJson(value[key]);
    }
    return out;
  }
  return value;
}

function normalizeFieldCaptureStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalized = normalizeNonEmptyString(rawValue).toLowerCase();
    if (!normalized) continue;
    next[key] = normalized === 'present' ? 'present' : 'missing';
  }
  return Object.keys(next).length > 0 ? next : null;
}

function deriveFieldCaptureStatus(reportedStatus, fields) {
  const next = {
    ...(normalizeFieldCaptureStatus(reportedStatus) || {}),
  };

  const truthyFields = {
    description_raw: normalizeNonEmptyString(fields?.description_raw),
    details_sections: Array.isArray(fields?.details_sections) ? fields.details_sections : [],
    ingredients_raw: normalizeNonEmptyString(fields?.ingredients_raw),
    active_ingredients_raw: normalizeNonEmptyString(fields?.active_ingredients_raw),
    how_to_use_raw: normalizeNonEmptyString(fields?.how_to_use_raw),
    faq_items: Array.isArray(fields?.faq_items) ? fields.faq_items : [],
  };

  if (truthyFields.description_raw) next.description_raw = 'present';
  else if (Object.prototype.hasOwnProperty.call(next, 'description_raw')) next.description_raw = 'missing';
  if (truthyFields.details_sections.length > 0) next.details_sections = 'present';
  else if (Object.prototype.hasOwnProperty.call(next, 'details_sections')) next.details_sections = 'missing';
  if (truthyFields.ingredients_raw) next.ingredients_raw = 'present';
  else if (Object.prototype.hasOwnProperty.call(next, 'ingredients_raw')) next.ingredients_raw = 'missing';
  if (truthyFields.active_ingredients_raw) next.active_ingredients_raw = 'present';
  else if (Object.prototype.hasOwnProperty.call(next, 'active_ingredients_raw')) next.active_ingredients_raw = 'missing';
  if (truthyFields.how_to_use_raw) next.how_to_use_raw = 'present';
  else if (Object.prototype.hasOwnProperty.call(next, 'how_to_use_raw')) next.how_to_use_raw = 'missing';
  if (truthyFields.faq_items.length > 0) next.faq_items = 'present';
  else if (Object.prototype.hasOwnProperty.call(next, 'faq_items')) next.faq_items = 'missing';

  return Object.keys(next).length > 0 ? next : null;
}

function findPdpDetailsSection(sections, headingPattern) {
  const normalizedSections = normalizeDetailsSections(sections);
  return normalizedSections.find((section) => headingPattern.test(section.heading)) || null;
}

function findPdpDetailsSections(sections, headingPattern) {
  const normalizedSections = normalizeDetailsSections(sections);
  return normalizedSections.filter((section) => headingPattern.test(section.heading));
}

function cleanPdpIngredientsRaw(value) {
  let next = normalizeNonEmptyString(value).replace(/\r/g, '');
  if (!next) return '';

  const ingredientHeadings = Array.from(next.matchAll(/\bIngredients\b\s*[:\n]*/gi));
  if (ingredientHeadings.length > 0) {
    const lastHeading = ingredientHeadings[ingredientHeadings.length - 1];
    next = next.slice(lastHeading.index + lastHeading[0].length).trim();
  }

  const stopPatterns = [/\bHow to Use\b/i, /\bDirections?\b/i, /\bDetails\b/i, /\bBenefits\b/i, /\bWhat it is\b/i];
  for (const pattern of stopPatterns) {
    const match = next.match(pattern);
    if (match && match.index > 20) next = next.slice(0, match.index).trim();
  }

  next = next
    .replace(/\bFull Ingredients\b\s*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!next) return '';
  if (/^such as\b/i.test(next)) return '';
  if (
    /\b(?:is inspired by|beauty capital of the world|natural resources|powerful vitality|breathes vibrancy|ideal choice for|free from harsh chemicals)\b/i.test(
      next,
    )
  ) {
    return '';
  }
  if (/\b(?:meaning it is not greasy|instead it absorbs|exfoliates dead skin cells|Details The)\b/i.test(next)) {
    return '';
  }
  if (/\b(?:Dibuyi|Ethylhexy\/|benzovi|Polvsilicone|Vitis-idata|Salicylâte|Propylheptyi|Polyglycery1|Dimethyisiloxyethy|Houttuvnia|Onza Sativo|Giycerin)\b/i.test(next)) {
    return '';
  }

  const commaCount = (next.match(/,/g) || []).length;
  const sentenceLikeText = next.replace(/\b\d+\.\d+\b/g, '');
  const sentenceCount = (sentenceLikeText.match(/[.!?]/g) || []).length;
  if (sentenceCount > 0 && commaCount < 4) return '';
  if (next.length < 20 || commaCount < 1) return '';
  return next;
}

function cleanPdpActiveIngredientsRaw(value) {
  const next = normalizeNonEmptyString(value)
    .replace(/\bFull Ingredients\b[\s\S]*$/i, '')
    .replace(/\bFree\s+From\s*:?\s*[\s\S]*$/i, '')
    .trim();
  if (!next || !/[A-Za-z0-9]/.test(next)) return '';
  if (next.length < 3) return '';
  return next;
}

function looksLikeSunscreenContext(value) {
  return /\b(?:spf|sunscreen|sun\s*(?:screen|stick|protection|defense|cream)?|uv\s*(?:filter|protection)|pa\+)\b/i.test(
    normalizeNonEmptyString(value),
  );
}

function scoreHowToUseCandidate(body, contextText) {
  const normalized = normalizeNonEmptyString(body).toLowerCase();
  if (!normalized) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (/[.!?)]$/.test(normalized)) score += 1;
  if (normalized.length >= 60 && normalized.length <= 360) score += 1;

  if (looksLikeSunscreenContext(contextText)) {
    if (/\b(?:sun|spf|uv|protection|protective)\b/.test(normalized)) score += 4;
    if (/\b(?:reapply|every\s+2|every\s+3|2[–-]3\s+hours?)\b/.test(normalized)) score += 4;
    if (/\b(?:final|last)\s+step\b/.test(normalized)) score += 2;
    if (/\b(?:generously|exposed)\b/.test(normalized)) score += 1;
    if (/\b(?:toner|cotton\s+pad|few\s+drops?|after\s+cleansing|morning\s+and\s+night)\b/.test(normalized)) {
      score -= 8;
    }
  }

  return score;
}

function pickBestHowToUseSection(detailsSections, rawValue, fallbackValue, contextText) {
  const raw = normalizeNonEmptyString(rawValue);
  const fallback = normalizeNonEmptyString(fallbackValue);
  const candidates = [
    ...findPdpDetailsSections(detailsSections, /^How to Use$/i).map((section) => section.body),
    raw,
    fallback,
  ]
    .map(normalizeNonEmptyString)
    .filter(Boolean);

  if (!candidates.length) return '';
  if (!looksLikeSunscreenContext(contextText)) {
    return candidates[0];
  }

  return candidates
    .map((body, index) => ({
      body,
      index,
      score: scoreHowToUseCandidate(body, contextText),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].body;
}

function filterDuplicateHowToSections(detailsSections, selectedHowTo) {
  const sections = normalizeDetailsSections(detailsSections);
  const howToSections = sections.filter((section) => /^How to Use$/i.test(section.heading));
  if (howToSections.length <= 1) return sections;
  const selectedSignature = sectionBodySignature(selectedHowTo);
  return sections.filter((section) => {
    if (!/^How to Use$/i.test(section.heading)) return true;
    if (!selectedSignature) return false;
    const sectionSignature = sectionBodySignature(section.body);
    return sectionSignature === selectedSignature || selectedSignature.includes(sectionSignature) || sectionSignature.includes(selectedSignature);
  });
}

function pickPdpHowToUseRaw(rawValue, detailsSections, fallbackValue = '', contextText = '') {
  const raw = normalizeNonEmptyString(rawValue);
  const sectionBody = normalizeNonEmptyString(pickBestHowToUseSection(detailsSections, raw, fallbackValue, contextText));
  const fallback = normalizeNonEmptyString(fallbackValue);
  if (looksLikeSunscreenContext(contextText) && sectionBody && sectionBody !== raw) {
    return sectionBody;
  }
  if (
    sectionBody &&
    (!raw ||
      sectionBody.length > raw.length + 30 ||
      (raw.length < 120 && sectionBody.toLowerCase().startsWith(raw.toLowerCase())) ||
      (raw && !/[.!?)]$/.test(raw)))
  ) {
    return sectionBody;
  }
  return raw || sectionBody || fallback;
}

function pickPdpIngredientsRaw(rawValue, detailsSections, fallbackValue = '') {
  const cleanedRaw = cleanPdpIngredientsRaw(rawValue);
  if (cleanedRaw) return cleanedRaw;

  const sectionBody = findPdpDetailsSection(detailsSections, /^Ingredients$/i)?.body;
  const cleanedSection = cleanPdpIngredientsRaw(sectionBody);
  if (cleanedSection) return cleanedSection;

  return cleanPdpIngredientsRaw(fallbackValue);
}

function looksLikeSyntheticSummaryText(value) {
  return /\bOFFICIAL:\b[\s\S]*\/\/\/\s*SOCIAL HIGHLIGHTS:/i.test(normalizeNonEmptyString(value));
}

const CATALOG_EXTRACT_BRAND_BY_HOST = {
  'beautyofjoseon.com': 'Beauty of Joseon',
  'byoma.com': 'BYOMA',
  'fentybeauty.com': 'Fenty Beauty',
  'firstaidbeauty.com': 'First Aid Beauty',
  'guerlain.com': 'Guerlain',
  'jurlique.com': 'Jurlique',
  'kyliecosmetics.com': 'Kylie Cosmetics',
  'kravebeauty.com': 'KraveBeauty',
  'naturium.com': 'Naturium',
  'olehenriksen.com': 'Olehenriksen',
  'pixibeauty.com': 'Pixi',
  'rarebeauty.com': 'Rare Beauty',
  'roundlab.com': 'Round Lab',
  'sigmabeauty.com': 'Sigma Beauty',
  'skin1004.com': 'SKIN1004',
  'theordinary.com': 'The Ordinary',
  'tomfordbeauty.com': 'Tom Ford Beauty',
  'us.nuxe.com': 'Nuxe',
};

function getHostname(value) {
  try {
    return new URL(normalizeUrlLike(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function deriveCatalogExtractBrand(targetUrl, row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const hostCandidates = uniqueStrings([
    getHostname(targetUrl),
    getHostname(row?.canonical_url),
    getHostname(row?.destination_url),
    getHostname(seedData.canonical_url),
    getHostname(snapshot.canonical_url),
    normalizeNonEmptyString(row?.domain).toLowerCase(),
  ]);
  for (const host of hostCandidates) {
    if (CATALOG_EXTRACT_BRAND_BY_HOST[host]) return CATALOG_EXTRACT_BRAND_BY_HOST[host];
    const hostWithoutWww = host.replace(/^www\./, '');
    if (CATALOG_EXTRACT_BRAND_BY_HOST[hostWithoutWww]) return CATALOG_EXTRACT_BRAND_BY_HOST[hostWithoutWww];
  }

  const explicitBrand = normalizeNonEmptyString(seedData.brand || snapshot.brand || row?.brand);
  if (explicitBrand) return explicitBrand;

  return normalizeNonEmptyString(row?.domain || row?.title || row?.external_product_id || row?.id);
}

function buildExtractRequestBody(targetUrl, row) {
  const requestBody = {
    brand: deriveCatalogExtractBrand(targetUrl, row) || row?.id,
    domain: targetUrl,
    limit: 50,
  };

  const market = normalizeNonEmptyString(row?.market);
  if (market) requestBody.market = market.toUpperCase();
  return requestBody;
}

function normalizeTargetUrlForMarket(value, market) {
  const normalized = normalizeUrlLike(value);
  const localeSegment = MARKET_LOCALE_SEGMENT[normalizeNonEmptyString(market).toUpperCase()];
  if (!normalized || !localeSegment) return normalized;

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!segments[0] || !LOCALE_PATH_SEGMENT_RE.test(segments[0])) return parsed.toString();
    if (segments[0].toLowerCase() === localeSegment) return parsed.toString();
    segments[0] = localeSegment;
    parsed.pathname = `/${segments.join('/')}${parsed.pathname.endsWith('/') ? '/' : ''}`;
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = normalizeNonEmptyString(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function recoverTargetUrlFromDiagnostics(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const trace = Array.isArray(snapshot?.diagnostics?.http_trace) ? snapshot.diagnostics.http_trace : [];

  for (const entry of trace) {
    const url = normalizeUrlLike(entry?.url);
    if (!url) continue;
    if (looksLikeKnownNonProductUrl(url)) continue;
    if (looksLikeDirectProductTargetUrl(url)) return url;
  }

  return '';
}

function pickSeedTargetUrl(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const variantDestinationUrl = normalizeUrlLike(row?.destination_url || seedData.destination_url || snapshot.destination_url);
  if (isVariantExpandedSeed(seedData) && collectVariantHintTokensFromUrl(variantDestinationUrl).length > 0) {
    return variantDestinationUrl;
  }
  const currentUrl = normalizeUrlLike(row?.canonical_url || row?.destination_url);
  const recoveredUrl =
    looksLikeKnownNonProductUrl(currentUrl) || !currentUrl ? recoverTargetUrlFromDiagnostics(row) : '';
  if (recoveredUrl) return recoveredUrl;
  const candidates = [
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
    row?.domain ? `https://${row.domain}` : '',
  ];

  return candidates.map(normalizeUrlLike).find(Boolean) || '';
}

function chooseRepresentativeProduct(response, targetUrl, row) {
  const products = Array.isArray(response?.products) ? response.products : [];
  if (!products.length) return null;

  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const rawCandidates = [
    targetUrl,
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    snapshot.canonical_url,
  ].filter(Boolean);

  const candidateKeys = new Set(
    rawCandidates
      .map(normalizeUrlKey)
      .filter(Boolean),
  );
  const comparableKeys = new Set(
    [
      ...rawCandidates,
    ]
      .map(normalizeComparableUrlKey)
      .filter(Boolean),
  );

  for (const product of products) {
    const productKey = normalizeUrlKey(product?.url);
    const comparableProductKey = normalizeComparableUrlKey(product?.url);
    if (candidateKeys.has(productKey) || comparableKeys.has(comparableProductKey)) return product;
  }

  if (looksLikeDirectProductTargetUrl(targetUrl)) {
    const titleKeys = new Set(
      [
        row?.title,
        row?.name,
        seedData.title,
        seedData.name,
        seedData.product_title,
        snapshot.title,
        snapshot.name,
        snapshot.product_title,
      ]
        .map(normalizeTitleKey)
        .filter(Boolean),
    );
    if (titleKeys.size > 0) {
      const exactTitleMatches = products.filter((product) => titleKeys.has(normalizeTitleKey(product?.title)));
      if (exactTitleMatches.length === 1) return exactTitleMatches[0];
    }
  }

  if (looksLikeDirectProductTargetUrl(targetUrl) && products.length === 1) {
    const product = products[0];
    if (isVerifiedShopifyMarketReplacement(targetUrl, product?.url)) return product;
  }

  if (looksLikeDirectProductTargetUrl(targetUrl)) return null;
  return products[0];
}

function mapSnapshotVariants(product, response, existingSeedData) {
  const responseVariants = Array.isArray(response?.variants) ? response.variants : [];
  const productDetailSections = normalizeDetailsSections(product?.details_sections || product?.pdp_details_sections);
  const findResponseVariantMatch = (variant) => {
    const strongTokens = [
      variant?.id,
      variant?.variant_id,
      variant?.sku,
      variant?.sku_id,
    ]
      .map((item) => normalizeVariantHintToken(item))
      .filter(Boolean);
    if (strongTokens.length > 0) {
      const strongMatch = responseVariants.find((candidate) => {
        const candidateTokens = [
          candidate?.id,
          candidate?.variant_id,
          candidate?.sku,
          candidate?.sku_id,
        ]
          .map((item) => normalizeVariantHintToken(item))
          .filter(Boolean);
        return candidateTokens.some((token) => strongTokens.includes(token));
      });
      if (strongMatch) return strongMatch;
    }

    const optionValue = normalizeVariantHintToken(variant?.option_value || variant?.title);
    if (!optionValue) return null;
    const optionMatches = responseVariants.filter((candidate) => {
      const candidateValue = normalizeVariantHintToken(candidate?.option_value || candidate?.title);
      return candidateValue && candidateValue === optionValue;
    });
    return optionMatches.length === 1 ? optionMatches[0] : null;
  };
  const representativeVariants =
    Array.isArray(product?.variants) && product.variants.length > 0
      ? product.variants
      : product?.url
        ? responseVariants.filter(
            (variant) => normalizeUrlKey(variant?.product_url || variant?.url) === normalizeUrlKey(product?.url),
          )
        : responseVariants;

  const mapped = representativeVariants
    .map((variant, idx) => {
      if (!variant || typeof variant !== 'object') return null;
      const responseVariant = findResponseVariantMatch(variant) || {};
      const imageRelevanceContext = buildSeedImageRelevanceContext({
        productTitle: product?.title,
        productUrl: product?.url,
        variantTitle: variant?.option_value || variant?.title || responseVariant?.option_value || responseVariant?.title,
      });
      const imageUrls = sanitizeSeedImageUrls([
        ...(Array.isArray(variant.image_urls) ? variant.image_urls : []),
        ...(Array.isArray(responseVariant.image_urls) ? responseVariant.image_urls : []),
        variant.image_url,
        responseVariant.image_url,
      ], { relevanceContext: imageRelevanceContext });
      const sku = normalizeNonEmptyString(
        variant.sku || variant.sku_id || responseVariant.sku || responseVariant.sku_id || variant.id || `variant-${idx + 1}`,
      );
      const variantUrl = normalizeUrlLike(
        variant.deep_link ||
          responseVariant.deep_link ||
          variant.url ||
          responseVariant.url ||
          variant.product_url ||
          responseVariant.product_url,
      );
      return {
        sku,
        variant_id: normalizeNonEmptyString(variant.id || variant.variant_id || responseVariant.id || responseVariant.variant_id || sku),
        url: variantUrl,
        ...(normalizeUrlLike(variant.deep_link || responseVariant.deep_link)
          ? { deep_link: normalizeUrlLike(variant.deep_link || responseVariant.deep_link) }
          : {}),
        ...(normalizeUrlLike(variant.product_url || responseVariant.product_url)
          ? { product_url: normalizeUrlLike(variant.product_url || responseVariant.product_url) }
          : {}),
        option_name: normalizeNonEmptyString(variant.option_name || responseVariant.option_name),
        option_value: normalizeNonEmptyString(variant.option_value || responseVariant.option_value),
        price: normalizeNonEmptyString(variant.price || responseVariant.price),
        currency: normalizeNonEmptyString(variant.currency || responseVariant.currency),
        stock: normalizeNonEmptyString(variant.stock || responseVariant.stock),
        image_url: imageUrls[0] || '',
        image_urls: imageUrls,
        description: cleanPdpDescriptionCandidate(
          variant.description || responseVariant.description,
          productDetailSections,
        ),
      };
    })
    .filter(Boolean);

  if (mapped.length > 0) return mapped;
  return normalizeSeedVariants(existingSeedData, null);
}

function comparableSeedData(value) {
  const next = ensureJsonObject(value);
  const snapshot = ensureJsonObject(next.snapshot);
  const rootIngredientIntel = ensureJsonObject(next.ingredient_intel);
  const snapshotIngredientIntel = ensureJsonObject(snapshot.ingredient_intel);
  return stableComparableJson({
    ...next,
    ...(Array.isArray(next.pdp_details_sections)
      ? { pdp_details_sections: normalizeDetailsSections(next.pdp_details_sections) }
      : {}),
    ...(Array.isArray(next.pdp_faq_items)
      ? { pdp_faq_items: normalizeFaqItems(next.pdp_faq_items) }
      : {}),
    ...(Array.isArray(next.variants) ? { variants: normalizeSeedVariants(next, null) } : {}),
    ingredient_intel: {
      ...rootIngredientIntel,
      external_seed_enrichment: {
        ...ensureJsonObject(rootIngredientIntel.external_seed_enrichment),
        synced_at: null,
      },
    },
    snapshot: {
      ...snapshot,
      extracted_at: null,
      ...(Array.isArray(snapshot.pdp_details_sections)
        ? { pdp_details_sections: normalizeDetailsSections(snapshot.pdp_details_sections) }
        : {}),
      ...(Array.isArray(snapshot.pdp_faq_items)
        ? { pdp_faq_items: normalizeFaqItems(snapshot.pdp_faq_items) }
        : {}),
      ...(Array.isArray(snapshot.variants) ? { variants: normalizeSeedVariants(snapshot, null) } : {}),
      ingredient_intel: {
        ...snapshotIngredientIntel,
        external_seed_enrichment: {
          ...ensureJsonObject(snapshotIngredientIntel.external_seed_enrichment),
          synced_at: null,
        },
      },
    },
  });
}

function shouldClearStaleSeedActiveIngredients(seedData, nextPdpActiveIngredientsRaw) {
  if (normalizeNonEmptyString(nextPdpActiveIngredientsRaw)) return false;
  const currentActiveIngredients = uniqueStrings([
    ...((Array.isArray(seedData?.active_ingredients) ? seedData.active_ingredients : [])),
    ...((Array.isArray(seedData?.activeIngredients) ? seedData.activeIngredients : [])),
    ...((Array.isArray(seedData?.snapshot?.active_ingredients) ? seedData.snapshot.active_ingredients : [])),
    ...((Array.isArray(seedData?.snapshot?.activeIngredients) ? seedData.snapshot.activeIngredients : [])),
  ]);
  return currentActiveIngredients.length > 0;
}

function buildSeedUpdatePayload(row, response, targetUrl) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const manualOverrides = ensureJsonObject(seedData.manual_overrides);
  const manualDescription = normalizeNonEmptyString(manualOverrides.description);
  const existingDescriptionOrigin = normalizeNonEmptyString(
    seedData.seed_description_origin || snapshot.seed_description_origin,
  );
  const fallbackPollutedRow =
    looksLikeKnownNonProductUrl(row?.canonical_url || row?.destination_url) &&
    looksLikeDirectProductTargetUrl(targetUrl);
  const representativeProduct = chooseRepresentativeProduct(response, targetUrl, row);
  const representativeProductUrl = normalizeUrlLike(representativeProduct?.url) || normalizeUrlLike(targetUrl) || normalizeUrlLike(row?.canonical_url);
  const snapshotVariants = mapSnapshotVariants(representativeProduct, response, seedData);
  const effectiveSnapshotVariants = fallbackPollutedRow && !representativeProduct ? [] : snapshotVariants;
  const selectedSnapshotVariant = pickVariantByHints(effectiveSnapshotVariants, [
    seedData.selected_variant_id,
    seedData.default_variant_id,
    seedData.variant_id,
    seedData.sku_id,
    seedData.variant_title,
    snapshot.selected_variant_id,
    snapshot.default_variant_id,
    snapshot.variant_id,
    snapshot.sku_id,
    snapshot.variant_title,
    row?.selected_variant_id,
    row?.default_variant_id,
    targetUrl,
    row?.destination_url,
    row?.canonical_url,
  ]);
  const selectedVariantId = getVariantId(selectedSnapshotVariant);
  const selectedVariantTitle = getVariantTitle(selectedSnapshotVariant);
  const imageRelevanceContext = buildSeedImageRelevanceContext({
    productTitle: representativeProduct?.title || row?.title || snapshot?.title,
    productUrl: representativeProductUrl || targetUrl || row?.destination_url || row?.canonical_url,
    variantTitle: selectedVariantTitle || seedData.variant_title || snapshot.variant_title,
    additionalValues: [
      row?.title,
      seedData.variant_title,
      snapshot.variant_title,
      seedData.brand,
    ],
  });
  const selectedVariantImageUrls = collectVariantImageUrls(selectedSnapshotVariant, { relevanceContext: imageRelevanceContext });
  const representativeProductImageUrls = collectProductImageUrls(representativeProduct, {
    relevanceContext: imageRelevanceContext,
  });
  const hasLiveVariantImages =
    Array.isArray(response?.variants) &&
    response.variants.length > 0 &&
    effectiveSnapshotVariants.some((variant) => Array.isArray(variant.image_urls) && variant.image_urls.length > 0);
  const selectedVariantUsesProductGallery = shouldMergeProductGalleryForSelectedVariant(
    selectedVariantImageUrls,
    representativeProductImageUrls,
  );
  const extractedImageUrls = sanitizeSeedImageUrls([
    ...(selectedVariantImageUrls.length > 0 ? selectedVariantImageUrls : []),
    ...(selectedVariantImageUrls.length > 0 && selectedVariantUsesProductGallery
      ? representativeProductImageUrls
      : []),
    ...(selectedVariantImageUrls.length > 0 || selectedSnapshotVariant
      ? []
      : [
          ...representativeProductImageUrls,
          ...(hasLiveVariantImages ? effectiveSnapshotVariants.flatMap((variant) => variant.image_urls || []) : []),
        ]),
  ], { relevanceContext: imageRelevanceContext });
  const existingImageUrls = fallbackPollutedRow
    ? []
    : sanitizeSeedImageUrls(collectSeedImageUrls(seedData, row), { relevanceContext: imageRelevanceContext });
  const imageOverride = lookupExternalSeedImageOverride(
    representativeProductUrl,
    targetUrl,
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
  );
  const overrideImageUrls = sanitizeSeedImageUrls([
    ...(Array.isArray(imageOverride?.image_urls) ? imageOverride.image_urls : []),
    imageOverride?.image_url,
  ]);
  let mergedImageUrls = extractedImageUrls.length > 0 ? extractedImageUrls : existingImageUrls;
  const manualImageOverrideApplied = mergedImageUrls.length === 0 && overrideImageUrls.length > 0;
  if (manualImageOverrideApplied) mergedImageUrls = overrideImageUrls;
  const richestVariantImageUrls = sanitizeSeedImageUrls([
    ...(selectedVariantImageUrls.length > 0 ? selectedVariantImageUrls : []),
    ...(effectiveSnapshotVariants.length === 1 ? effectiveSnapshotVariants[0]?.image_urls || [] : []),
  ], { relevanceContext: imageRelevanceContext });
  if (richestVariantImageUrls.length > mergedImageUrls.length) {
    mergedImageUrls = sanitizeSeedImageUrls([...richestVariantImageUrls, ...mergedImageUrls]);
  }
  const imageUrl = mergedImageUrls[0] || '';
  const variantSkus = uniqueStrings(effectiveSnapshotVariants.map((variant) => variant.sku));
  const variantsForPrice = selectedSnapshotVariant ? [selectedSnapshotVariant] : effectiveSnapshotVariants;
  const variantPrices = variantsForPrice
    .map((variant) => parsePrice(variant.price))
    .filter((value) => typeof value === 'number' && value > 0);
  const anyInStock = effectiveSnapshotVariants.some((variant) => {
    const normalized = normalizeSeedAvailability(variant.stock);
    return normalized !== 'out_of_stock';
  });
  const availability =
    effectiveSnapshotVariants.length > 0
      ? anyInStock
        ? 'in_stock'
        : 'out_of_stock'
      : normalizeSeedAvailability(row?.availability || seedData.availability || snapshot.availability) || '';
  const failureCategory = normalizeNonEmptyString(response?.diagnostics?.failure_category || snapshot?.diagnostics?.failure_category);
  const rawLiveExtractedDescription = normalizePdpCopy(
    representativeProduct?.variants?.find((variant) => variant.description)?.description ||
      effectiveSnapshotVariants.find((variant) => variant.description)?.description,
  );
  const pdpDetailsSections = normalizeDetailsSections(
    representativeProduct?.details_sections ||
      representativeProduct?.pdp_details_sections,
  );
  const productDescriptionRaw = cleanPdpDescriptionCandidate(
    representativeProduct?.description_raw ||
      representativeProduct?.pdp_description_raw,
    pdpDetailsSections,
  );
  const liveExtractedDescription = cleanPdpDescriptionCandidate(rawLiveExtractedDescription, pdpDetailsSections);
  const pdpIngredientsRaw = normalizeNonEmptyString(
    representativeProduct?.ingredients_raw ||
      representativeProduct?.pdp_ingredients_raw,
  );
  const pdpActiveIngredientsRaw = normalizeNonEmptyString(
    representativeProduct?.active_ingredients_raw ||
      representativeProduct?.pdp_active_ingredients_raw,
  );
  const pdpHowToUseRaw = normalizeNonEmptyString(
    representativeProduct?.how_to_use_raw ||
      representativeProduct?.pdp_how_to_use_raw,
  );
  const pdpFaqItems = normalizeFaqItems(
    representativeProduct?.faq_items ||
      representativeProduct?.pdp_faq_items,
  );
  const existingPdpDescriptionRaw = cleanPdpDescriptionCandidate(
    seedData.pdp_description_raw || snapshot.pdp_description_raw,
    pdpDetailsSections,
  );
  const nextPdpDescriptionRaw =
    productDescriptionRaw ||
    existingPdpDescriptionRaw;
  let nextPdpDetailsSections =
    pdpDetailsSections.length > 0
      ? pdpDetailsSections
      : normalizeDetailsSections(
          Array.isArray(seedData.pdp_details_sections) && seedData.pdp_details_sections.length > 0
            ? seedData.pdp_details_sections
            : snapshot.pdp_details_sections,
        );
  const nextPdpIngredientsRaw = pickPdpIngredientsRaw(
    pdpIngredientsRaw,
    nextPdpDetailsSections,
    normalizeNonEmptyString(seedData.pdp_ingredients_raw || snapshot.pdp_ingredients_raw),
  );
  const nextPdpActiveIngredientsRaw = cleanPdpActiveIngredientsRaw(
    pdpActiveIngredientsRaw ||
      normalizeNonEmptyString(seedData.pdp_active_ingredients_raw || snapshot.pdp_active_ingredients_raw),
  );
  const pdpHowToUseContext = [
    representativeProduct?.title,
    seedData.title,
    snapshot.title,
    row?.title,
    representativeProduct?.category,
    seedData.category,
    snapshot.category,
    productDescriptionRaw,
    nextPdpActiveIngredientsRaw,
  ].join(' ');
  const nextPdpHowToUseRaw = pickPdpHowToUseRaw(
    pdpHowToUseRaw,
    nextPdpDetailsSections,
    normalizeNonEmptyString(seedData.pdp_how_to_use_raw || snapshot.pdp_how_to_use_raw),
    pdpHowToUseContext,
  );
  nextPdpDetailsSections = filterDuplicateHowToSections(nextPdpDetailsSections, nextPdpHowToUseRaw);
  const nextPdpFaqItems =
    pdpFaqItems.length > 0
      ? pdpFaqItems
      : normalizeFaqItems(
          Array.isArray(seedData.pdp_faq_items) && seedData.pdp_faq_items.length > 0
            ? seedData.pdp_faq_items
            : snapshot.pdp_faq_items,
        );
  const pdpFieldCaptureStatus = deriveFieldCaptureStatus(
    normalizeFieldCaptureStatus(representativeProduct?.field_capture_status) ||
      normalizeFieldCaptureStatus(representativeProduct?.pdp_field_capture_status) ||
      normalizeFieldCaptureStatus(seedData.pdp_field_capture_status) ||
      normalizeFieldCaptureStatus(snapshot.pdp_field_capture_status),
    {
      description_raw: nextPdpDescriptionRaw,
      details_sections: nextPdpDetailsSections,
      ingredients_raw: nextPdpIngredientsRaw,
      active_ingredients_raw: nextPdpActiveIngredientsRaw,
      how_to_use_raw: nextPdpHowToUseRaw,
      faq_items: nextPdpFaqItems,
    },
  );
  const suppressStaleDescriptionFallback =
    (failureCategory === 'no_product_urls' || failureCategory === 'non_product_fallback_page') &&
    !manualDescription &&
    !liveExtractedDescription &&
    !productDescriptionRaw;
  const nextDescriptionOrigin = (() => {
    if (manualDescription) return existingDescriptionOrigin || 'legacy_unknown';
    if (liveExtractedDescription) return 'pdp_variant_description';
    if (productDescriptionRaw) return 'pdp_product_description';
    if (existingDescriptionOrigin) return existingDescriptionOrigin;
    const legacyDescription =
      cleanPdpDescriptionCandidate(snapshot.description, nextPdpDetailsSections) ||
      cleanPdpDescriptionCandidate(seedData.description, nextPdpDetailsSections) ||
      cleanPdpDescriptionCandidate(row?.description, nextPdpDetailsSections);
    if (looksLikeSyntheticSummaryText(legacyDescription)) return 'synthetic_summary';
    if (legacyDescription) return 'legacy_unknown';
    return '';
  })();
  const fallbackSeedDescription = cleanPdpDescriptionCandidate(
    (fallbackPollutedRow ? seedData.description : snapshot.description) || seedData.description,
    nextPdpDetailsSections,
  );
  const description = manualDescription ||
    normalizeNonEmptyString(
      liveExtractedDescription ||
        productDescriptionRaw ||
        (!suppressStaleDescriptionFallback
          ? fallbackSeedDescription
          : ''),
    ) ||
    '';
  const title =
    normalizeNonEmptyString(representativeProduct?.title || seedData.title || snapshot.title || row?.title) || row?.id;
  const currency =
    normalizeNonEmptyString(
      selectedSnapshotVariant?.currency ||
        effectiveSnapshotVariants.find((variant) => variant.currency)?.currency ||
        row?.price_currency ||
        seedData.price_currency ||
        snapshot.price_currency,
    ) || 'USD';
  const priceAmount =
    variantPrices.length > 0
      ? Math.min(...variantPrices)
      : typeof row?.price_amount === 'number'
        ? row.price_amount
        : parsePrice(seedData.price_amount ?? snapshot.price_amount) || null;
  const destinationUrl =
    (selectedSnapshotVariant ? normalizeUrlLike(selectedSnapshotVariant.url) : '') ||
    representativeProductUrl ||
    (fallbackPollutedRow ? normalizeUrlLike(targetUrl) : normalizeUrlLike(row?.destination_url)) ||
    normalizeUrlLike(targetUrl);

  const nextSnapshot = {
    ...snapshot,
    source: 'catalog_intelligence',
    extracted_at: new Date().toISOString(),
    canonical_url: representativeProductUrl || normalizeUrlLike(snapshot.canonical_url) || normalizeUrlLike(targetUrl),
    title,
    description:
      manualDescription || liveExtractedDescription || productDescriptionRaw
        ? liveExtractedDescription ||
          productDescriptionRaw ||
          cleanPdpDescriptionCandidate(snapshot.description, nextPdpDetailsSections)
        : suppressStaleDescriptionFallback
          ? ''
          : description || cleanPdpDescriptionCandidate(snapshot.description, nextPdpDetailsSections),
    ...(nextPdpDescriptionRaw ? { pdp_description_raw: nextPdpDescriptionRaw } : {}),
    ...(nextPdpDetailsSections.length > 0 ? { pdp_details_sections: nextPdpDetailsSections } : {}),
    ...(nextPdpIngredientsRaw ? { pdp_ingredients_raw: nextPdpIngredientsRaw } : {}),
    ...(nextPdpActiveIngredientsRaw ? { pdp_active_ingredients_raw: nextPdpActiveIngredientsRaw } : {}),
    ...(nextPdpHowToUseRaw ? { pdp_how_to_use_raw: nextPdpHowToUseRaw } : {}),
    ...(nextPdpFaqItems.length > 0 ? { pdp_faq_items: nextPdpFaqItems } : {}),
    ...(selectedVariantId ? { selected_variant_id: selectedVariantId, default_variant_id: selectedVariantId } : {}),
    ...(selectedVariantTitle && !isDefaultVariantTitle(selectedVariantTitle) ? { variant_title: selectedVariantTitle } : {}),
    ...(nextDescriptionOrigin ? { seed_description_origin: nextDescriptionOrigin } : {}),
    ...(pdpFieldCaptureStatus ? { pdp_field_capture_status: pdpFieldCaptureStatus } : {}),
    image_url: imageUrl || normalizeNonEmptyString(snapshot.image_url),
    image_urls: mergedImageUrls,
    images: mergedImageUrls,
    variants: effectiveSnapshotVariants.length > 0 ? effectiveSnapshotVariants : normalizeSeedVariants(fallbackPollutedRow ? {} : seedData, null),
    diagnostics:
      manualImageOverrideApplied
        ? {
            ...(response?.diagnostics && typeof response.diagnostics === 'object' ? response.diagnostics : {}),
            manual_image_override: {
              applied: true,
              source: imageOverride?.source || 'manual_seed_override',
              note: imageOverride?.note || 'Manual image override applied',
            },
          }
        : response?.diagnostics || snapshot.diagnostics || null,
    variant_skus: variantSkus.length > 0 ? variantSkus : uniqueStrings(snapshot.variant_skus || []),
  };
  if (!nextPdpIngredientsRaw) delete nextSnapshot.pdp_ingredients_raw;
  if (!nextPdpActiveIngredientsRaw) delete nextSnapshot.pdp_active_ingredients_raw;

  const nextSeedData = {
    ...seedData,
    ...(description ? { description } : {}),
    ...(nextPdpDescriptionRaw ? { pdp_description_raw: nextPdpDescriptionRaw } : {}),
    ...(nextPdpDetailsSections.length > 0 ? { pdp_details_sections: nextPdpDetailsSections } : {}),
    ...(nextPdpIngredientsRaw ? { pdp_ingredients_raw: nextPdpIngredientsRaw } : {}),
    ...(nextPdpActiveIngredientsRaw ? { pdp_active_ingredients_raw: nextPdpActiveIngredientsRaw } : {}),
    ...(nextPdpHowToUseRaw ? { pdp_how_to_use_raw: nextPdpHowToUseRaw } : {}),
    ...(nextPdpFaqItems.length > 0 ? { pdp_faq_items: nextPdpFaqItems } : {}),
    ...(selectedVariantId ? { selected_variant_id: selectedVariantId, default_variant_id: selectedVariantId } : {}),
    ...(selectedVariantTitle && !isDefaultVariantTitle(selectedVariantTitle) ? { variant_title: selectedVariantTitle } : {}),
    ...(nextDescriptionOrigin ? { seed_description_origin: nextDescriptionOrigin } : {}),
    ...(pdpFieldCaptureStatus ? { pdp_field_capture_status: pdpFieldCaptureStatus } : {}),
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(mergedImageUrls.length > 0 ? { image_urls: mergedImageUrls, images: mergedImageUrls } : {}),
    ...(effectiveSnapshotVariants.length > 0 ? { variants: effectiveSnapshotVariants } : {}),
    snapshot: nextSnapshot,
  };
  if (!nextPdpIngredientsRaw) {
    delete nextSeedData.pdp_ingredients_raw;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_ingredients_raw;
  }
  if (!nextPdpActiveIngredientsRaw) {
    delete nextSeedData.pdp_active_ingredients_raw;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_active_ingredients_raw;
  }
  if (!nextPdpDescriptionRaw) {
    delete nextSeedData.pdp_description_raw;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_description_raw;
  }
  if (nextPdpDetailsSections.length === 0) {
    delete nextSeedData.pdp_details_sections;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_details_sections;
  }
  if (!description || isStorefrontBoilerplateDescription(nextSeedData.description)) {
    delete nextSeedData.description;
  }
  if (!description && !nextPdpDescriptionRaw) {
    delete nextSeedData.seed_description_origin;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') {
      delete nextSeedData.snapshot.seed_description_origin;
    }
  }
  if (
    nextSeedData.snapshot &&
    typeof nextSeedData.snapshot === 'object' &&
    isStorefrontBoilerplateDescription(nextSeedData.snapshot.description)
  ) {
    delete nextSeedData.snapshot.description;
  }
  const nextDerived = ensureJsonObject(nextSeedData.derived);
  nextSeedData.derived = {
    ...nextDerived,
    recall: buildExternalSeedRecallDoc({
      row: { ...row, ...row, title, description, canonical_url: representativeProductUrl || row?.canonical_url, destination_url: destinationUrl || row?.destination_url },
      seedData: nextSeedData,
      snapshot: nextSnapshot,
    }),
  };
  if (shouldClearStaleSeedActiveIngredients(nextSeedData, nextPdpActiveIngredientsRaw)) {
    delete nextSeedData.active_ingredients;
    delete nextSeedData.activeIngredients;
    delete nextSeedData.snapshot.active_ingredients;
    delete nextSeedData.snapshot.activeIngredients;
  }
  if (!description && suppressStaleDescriptionFallback) {
    delete nextSeedData.description;
  }

  const nextRow = {
    title,
    canonical_url: representativeProductUrl || normalizeNonEmptyString(row?.canonical_url),
    destination_url: destinationUrl || normalizeNonEmptyString(row?.destination_url),
    image_url: imageUrl || normalizeNonEmptyString(row?.image_url),
    price_amount: priceAmount,
    price_currency: currency,
    availability: availability || normalizeNonEmptyString(row?.availability),
    seed_data: nextSeedData,
  };

  const changed =
    normalizeNonEmptyString(row?.title) !== nextRow.title ||
    normalizeNonEmptyString(row?.canonical_url) !== nextRow.canonical_url ||
    normalizeNonEmptyString(row?.destination_url) !== nextRow.destination_url ||
    normalizeNonEmptyString(row?.image_url) !== nextRow.image_url ||
    (typeof row?.price_amount === 'number' ? row.price_amount : parsePrice(row?.price_amount)) !== nextRow.price_amount ||
    normalizeNonEmptyString(row?.price_currency).toUpperCase() !== nextRow.price_currency ||
    normalizeNonEmptyString(row?.availability) !== nextRow.availability ||
    JSON.stringify(comparableSeedData(row?.seed_data)) !== JSON.stringify(comparableSeedData(nextSeedData));

  return {
    changed,
    nextRow,
    representativeProduct,
    snapshot: nextSnapshot,
  };
}

function isVariantExpandedSeed(seedData) {
  return normalizeNonEmptyString(seedData?.source_listing_scope).toLowerCase() === 'variant' ||
    Boolean(normalizeNonEmptyString(seedData?.parent_external_product_id || seedData?.parent_seed_id));
}

function hasExplicitVariantUrl(url, variant) {
  const hintTokens = collectVariantHintTokensFromUrl(url);
  return hintTokens.length > 0 && variantMatchesHintTokens(variant, hintTokens);
}

function buildVariantSeedRows(row, payload) {
  const nextRow = payload?.nextRow || {};
  const seedData = ensureJsonObject(nextRow.seed_data);
  if (isVariantExpandedSeed(seedData)) return [];

  const snapshot = ensureJsonObject(seedData.snapshot);
  const variants = Array.isArray(snapshot.variants) ? snapshot.variants : [];
  if (variants.length <= 1) return [];

  const parentExternalProductId = normalizeNonEmptyString(
    row?.external_product_id || seedData.external_product_id || seedData.product_id,
  );
  const parentSeedId = normalizeNonEmptyString(row?.id);
  const baseCanonicalUrl = normalizeUrlLike(nextRow.canonical_url || snapshot.canonical_url || row?.canonical_url);
  const baseDestinationUrl = normalizeUrlLike(nextRow.destination_url || snapshot.destination_url || row?.destination_url);
  const rows = [];

  for (const variant of variants) {
    const variantId = getVariantId(variant);
    const variantTitle = getVariantTitle(variant);
    const variantUrl = normalizeUrlLike(variant?.deep_link || variant?.url);
    if (!variantId || !variantTitle || isDefaultVariantTitle(variantTitle)) continue;
    if (!variantUrl || !hasExplicitVariantUrl(variantUrl, variant)) continue;

    const imageUrls = collectVariantImageUrls(variant);
    const priceAmount = parsePrice(variant.price);
    const priceCurrency = normalizeNonEmptyString(variant.currency || nextRow.price_currency || row?.price_currency) || 'USD';
    const availability = normalizeSeedAvailability(variant.stock || variant.availability || nextRow.availability || row?.availability) || '';
    const externalProductId = stableVariantExternalProductId({ ...row, external_product_id: parentExternalProductId }, variant);
    const seedId = stableVariantSeedId({ ...row, external_product_id: parentExternalProductId }, variant);
    const variantSeed = {
      ...cloneJsonValue(variant),
      url: variantUrl,
      variant_id: variantId,
      id: variantId,
      title: variantTitle,
      ...(imageUrls.length > 0 ? { image_url: imageUrls[0], image_urls: imageUrls, images: imageUrls } : {}),
    };
    const childSeedData = {
      ...cloneJsonValue(seedData),
      external_product_id: externalProductId,
      product_id: externalProductId,
      parent_external_product_id: parentExternalProductId || undefined,
      parent_seed_id: parentSeedId || undefined,
      source_listing_scope: 'variant',
      selected_variant_id: variantId,
      default_variant_id: variantId,
      variant_title: variantTitle,
      destination_url: variantUrl,
      canonical_url: baseCanonicalUrl || baseDestinationUrl || variantUrl,
      ...(priceAmount != null ? { price_amount: priceAmount } : {}),
      price_currency: priceCurrency,
      ...(availability ? { availability } : {}),
      ...(imageUrls.length > 0 ? { image_url: imageUrls[0], image_urls: imageUrls, images: imageUrls } : {}),
      variants: [variantSeed],
      snapshot: {
        ...cloneJsonValue(snapshot),
        destination_url: variantUrl,
        canonical_url: baseCanonicalUrl || baseDestinationUrl || variantUrl,
        selected_variant_id: variantId,
        default_variant_id: variantId,
        variant_title: variantTitle,
        ...(priceAmount != null ? { price_amount: priceAmount } : {}),
        price_currency: priceCurrency,
        ...(availability ? { availability } : {}),
        ...(imageUrls.length > 0 ? { image_url: imageUrls[0], image_urls: imageUrls, images: imageUrls } : {}),
        variants: [variantSeed],
      },
    };

    const childRow = {
      id: seedId,
      market: normalizeNonEmptyString(row?.market) || 'US',
      tool: normalizeNonEmptyString(row?.tool) || '*',
      destination_url: variantUrl,
      canonical_url: baseCanonicalUrl || baseDestinationUrl || variantUrl,
      domain: normalizeNonEmptyString(row?.domain),
      title: normalizeNonEmptyString(nextRow.title || row?.title),
      image_url: imageUrls[0] || normalizeNonEmptyString(nextRow.image_url || row?.image_url),
      price_amount: priceAmount != null ? priceAmount : nextRow.price_amount ?? row?.price_amount ?? null,
      price_currency: priceCurrency,
      availability: availability || normalizeNonEmptyString(nextRow.availability || row?.availability),
      status: 'active',
      notes: `variant seed expanded from ${parentExternalProductId || parentSeedId || 'external seed'}`,
      created_by_employee_id: normalizeNonEmptyString(row?.created_by_employee_id),
      attached_product_key: null,
      attached_variant_id: null,
      utm_template: row?.utm_template || null,
      partner_type: row?.partner_type || null,
      disclosure_text: row?.disclosure_text || null,
      external_product_id: externalProductId,
      seed_data: childSeedData,
    };
    childSeedData.derived = {
      ...ensureJsonObject(childSeedData.derived),
      recall: buildExternalSeedRecallDoc({
        row: childRow,
        seedData: childSeedData,
        snapshot: childSeedData.snapshot,
      }),
    };
    rows.push({ ...childRow, seed_data: childSeedData });
  }

  return rows;
}

function buildIdentityListingSourcePayload(row, nextRow) {
  const refreshedRow = {
    ...(row || {}),
    ...(nextRow || {}),
    seed_data: ensureJsonObject(nextRow?.seed_data || row?.seed_data),
    external_product_id:
      normalizeNonEmptyString(row?.external_product_id) ||
      normalizeNonEmptyString(nextRow?.external_product_id) ||
      normalizeNonEmptyString(nextRow?.seed_data?.external_product_id) ||
      normalizeNonEmptyString(nextRow?.seed_data?.product_id),
    status: normalizeNonEmptyString(row?.status) || 'active',
  };
  const product = buildExternalSeedProduct(refreshedRow);
  const merchantId =
    normalizeNonEmptyString(product?.merchant_id) ||
    EXTERNAL_SEED_MERCHANT_ID;
  const productId =
    normalizeNonEmptyString(product?.product_id || product?.id) ||
    normalizeNonEmptyString(refreshedRow.external_product_id);
  if (!merchantId || !productId || !product) return null;
  return {
    source_listing_ref: `${merchantId}:${productId}`,
    product,
  };
}

async function refreshPdpIdentityListingSourcePayload(client, row, nextRow) {
  const payload = buildIdentityListingSourcePayload(row, nextRow);
  if (!payload?.source_listing_ref || !payload?.product) {
    return { matched_rows: 0, refreshed: false, reason: 'missing_identity_payload' };
  }
  const result = await client.query(
    `
      UPDATE pdp_identity_listing
      SET
        source_payload = $2::jsonb,
        review_summary = $3::jsonb,
        official_url = COALESCE(NULLIF($4, ''), official_url),
        updated_at = now()
      WHERE source_listing_ref = $1
        AND source_payload IS DISTINCT FROM $2::jsonb
    `,
    [
      payload.source_listing_ref,
      JSON.stringify(payload.product),
      JSON.stringify(ensureJsonObject(payload.product.review_summary)),
      normalizeUrlLike(payload.product.canonical_url || payload.product.url || payload.product.destination_url),
    ],
  );
  return {
    matched_rows: Number(result?.rowCount || 0),
    refreshed: Number(result?.rowCount || 0) > 0,
    source_listing_ref: payload.source_listing_ref,
  };
}

async function upsertVariantSeedRows(client, rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    await client.query(
      `
        INSERT INTO external_product_seeds (
          id,
          market,
          tool,
          destination_url,
          canonical_url,
          domain,
          title,
          image_url,
          price_amount,
          price_currency,
          availability,
          status,
          notes,
          created_by_employee_id,
          attached_product_key,
          attached_variant_id,
          seed_data,
          utm_template,
          partner_type,
          disclosure_text,
          external_product_id,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, now()
        )
        ON CONFLICT (market, tool, external_product_id)
          WHERE status = 'active' AND external_product_id IS NOT NULL
        DO UPDATE SET
          destination_url = EXCLUDED.destination_url,
          canonical_url = EXCLUDED.canonical_url,
          domain = EXCLUDED.domain,
          title = EXCLUDED.title,
          image_url = EXCLUDED.image_url,
          price_amount = EXCLUDED.price_amount,
          price_currency = EXCLUDED.price_currency,
          availability = EXCLUDED.availability,
          notes = EXCLUDED.notes,
          seed_data = EXCLUDED.seed_data,
          utm_template = EXCLUDED.utm_template,
          partner_type = EXCLUDED.partner_type,
          disclosure_text = EXCLUDED.disclosure_text,
          updated_at = now()
      `,
      [
        row.id,
        row.market,
        row.tool,
        row.destination_url,
        row.canonical_url,
        row.domain,
        row.title,
        row.image_url,
        row.price_amount,
        row.price_currency,
        row.availability,
        row.status,
        row.notes,
        row.created_by_employee_id,
        row.attached_product_key,
        row.attached_variant_id,
        JSON.stringify(row.seed_data),
        row.utm_template,
        row.partner_type,
        row.disclosure_text,
        row.external_product_id,
      ],
    );
  }
}

function buildFailureSeedData(row, targetUrl, error) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const existingImageUrls = sanitizeSeedImageUrls(collectSeedImageUrls(seedData, row));
  const imageOverride = lookupExternalSeedImageOverride(
    targetUrl,
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
  );
  const overrideImageUrls = sanitizeSeedImageUrls([
    ...(Array.isArray(imageOverride?.image_urls) ? imageOverride.image_urls : []),
    imageOverride?.image_url,
  ]);
  const manualImageOverrideApplied = existingImageUrls.length === 0 && overrideImageUrls.length > 0;
  const currentImageUrls = existingImageUrls.length > 0 ? existingImageUrls : overrideImageUrls;
  const nextSeedData = {
    ...seedData,
    snapshot: {
      ...snapshot,
      source: 'catalog_intelligence',
      extracted_at: new Date().toISOString(),
      canonical_url: normalizeUrlLike(snapshot.canonical_url) || normalizeUrlLike(targetUrl),
      diagnostics: {
        ...(snapshot.diagnostics && typeof snapshot.diagnostics === 'object' ? snapshot.diagnostics : {}),
        failure_category: 'unknown',
        error: String(error?.message || error || 'unknown_error'),
        ...(manualImageOverrideApplied
          ? {
              manual_image_override: {
                applied: true,
                source: imageOverride?.source || 'manual_seed_override',
                note: imageOverride?.note || 'Manual image override applied after extraction failure',
              },
            }
          : {}),
      },
      image_url: currentImageUrls[0] || snapshot.image_url || seedData.image_url || '',
      image_urls: currentImageUrls,
      images: currentImageUrls,
      variants: normalizeSeedVariants(seedData, row),
    },
  };
  nextSeedData.derived = {
    ...ensureJsonObject(nextSeedData.derived),
    recall: buildExternalSeedRecallDoc({
      row: {
        ...row,
        canonical_url: normalizeUrlLike(snapshot.canonical_url) || normalizeUrlLike(targetUrl) || row?.canonical_url,
        destination_url: normalizeUrlLike(targetUrl) || row?.destination_url,
      },
      seedData: nextSeedData,
      snapshot: ensureJsonObject(nextSeedData.snapshot),
    }),
  };
  return nextSeedData;
}

async function fetchRows(options) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `market = $1`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [options.market];
  let idx = params.length;

  const addParam = (value) => {
    params.push(value);
    idx += 1;
    return `$${idx}`;
  };

  let seedIdsBind = null;
  if (options.seedId) where.push(`id::text = ${addParam(options.seedId)}`);
  if (Array.isArray(options.seedIds) && options.seedIds.length > 0) {
    seedIdsBind = addParam(options.seedIds.map((value) => normalizeNonEmptyString(value)).filter(Boolean));
    where.push(`id::text = ANY(${seedIdsBind}::text[])`);
  }
  let externalProductIdsBind = null;
  if (options.externalProductId) where.push(`external_product_id = ${addParam(options.externalProductId)}`);
  if (Array.isArray(options.externalProductIds) && options.externalProductIds.length > 0) {
    externalProductIdsBind = addParam(options.externalProductIds.map((value) => normalizeNonEmptyString(value)).filter(Boolean));
    where.push(`external_product_id = ANY(${externalProductIdsBind}::text[])`);
  }
  if (options.domain) where.push(`domain = ${addParam(options.domain)}`);
  if (options.brand) where.push(`lower(coalesce(seed_data->>'brand', '')) = lower(${addParam(options.brand)})`);

  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;

  const sql = `
    SELECT
      id,
      external_product_id,
      market,
      tool,
      destination_url,
      canonical_url,
      domain,
      title,
      image_url,
      price_amount,
      price_currency,
      availability,
      notes,
      created_by_employee_id,
      seed_data,
      utm_template,
      partner_type,
      disclosure_text,
      status,
      attached_product_key,
      attached_variant_id,
      created_at,
      updated_at
    FROM external_product_seeds
    WHERE ${where.join('\n      AND ')}
    ORDER BY ${
      seedIdsBind
        ? `array_position(${seedIdsBind}::text[], id::text) ASC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC NULLS LAST`
        : externalProductIdsBind
          ? `array_position(${externalProductIdsBind}::text[], external_product_id::text) ASC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC NULLS LAST`
        : 'updated_at DESC NULLS LAST, created_at DESC NULLS LAST'
    }
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;

  const res = await query(sql, params);
  return res.rows || [];
}

async function extractSeed(targetUrl, row, baseUrl) {
  const requestBody = buildExtractRequestBody(targetUrl, row);
  const response = await axios.post(`${baseUrl.replace(/\/$/, '')}/api/extract`, requestBody, {
    timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data || {};
}

async function processRow(row, options) {
  const targetUrl = normalizeTargetUrlForMarket(pickSeedTargetUrl(row), row?.market);
  if (!targetUrl) {
    return { status: 'skipped', reason: 'missing_target_url', row };
  }

  try {
    const response = await extractSeed(targetUrl, row, options.baseUrl);
    const products = Array.isArray(response?.products) ? response.products : [];
    const representativeProduct = chooseRepresentativeProduct(response, targetUrl, row);
    if (looksLikeDirectProductTargetUrl(targetUrl) && products.length > 0 && !representativeProduct) {
      return {
        status: 'skipped',
        reason: 'representative_product_not_found',
        row,
        targetUrl,
        payload: {
          diagnostics: response?.diagnostics || null,
          candidate_product_urls: products
            .map((product) => normalizeUrlLike(product?.url))
            .filter(Boolean)
            .slice(0, 10),
        },
      };
    }
    const payload = buildSeedUpdatePayload(row, response, targetUrl);
    const enrichment = await enrichExternalSeedRowIngredients({
      row: {
        ...row,
        ...payload.nextRow,
        seed_data: payload.nextRow.seed_data,
      },
      ingredientId:
        normalizeNonEmptyString(row?.ingredient_id) ||
        normalizeNonEmptyString(ensureJsonObject(row?.seed_data).ingredient_id),
      ingredientName:
        normalizeNonEmptyString(row?.ingredient_name) ||
        normalizeNonEmptyString(ensureJsonObject(row?.seed_data).ingredient_name),
    });
    let enrichedNextRow =
      enrichment?.row && typeof enrichment.row === 'object'
        ? {
            ...payload.nextRow,
            seed_data: ensureJsonObject(enrichment.row.seed_data),
          }
        : payload.nextRow;
    let imageHealthValidation = null;
    if (options.validateImageHealth) {
      const validationResult = await validateNextRowImageHealth(enrichedNextRow);
      imageHealthValidation = validationResult.validation;
      if (validationResult.validation?.status === 'failed_no_valid_images') {
        return {
          status: 'skipped',
          reason: 'image_health_validation_failed',
          row,
          targetUrl,
          payload: {
            ...payload,
            nextRow: enrichedNextRow,
            ingredient_enrichment: enrichment || null,
            image_health_validation: imageHealthValidation,
            variant_seed_rows: [],
          },
        };
      }
      enrichedNextRow = validationResult.nextRow;
    }
    const changed =
      payload.changed ||
      JSON.stringify(comparableSeedData(payload.nextRow.seed_data)) !==
        JSON.stringify(comparableSeedData(enrichedNextRow.seed_data));
    const enrichedPayload = {
      ...payload,
      changed,
      nextRow: enrichedNextRow,
      ingredient_enrichment: enrichment || null,
      image_health_validation: imageHealthValidation,
    };
    const variantSeedRows = options.expandVariants ? buildVariantSeedRows(row, enrichedPayload) : [];
    const hasVariantSeedRows = variantSeedRows.length > 0;
    if (options.dryRun || (!enrichedPayload.changed && !hasVariantSeedRows)) {
      let identityListingRefresh = null;
      if (!options.dryRun) {
        await withClient(async (client) => {
          identityListingRefresh = await refreshPdpIdentityListingSourcePayload(client, row, enrichedPayload.nextRow);
        });
        if (identityListingRefresh?.refreshed) {
          return {
            status: 'updated',
            reason: 'identity_listing_refreshed',
            row,
            targetUrl,
            payload: {
              ...enrichedPayload,
              variant_seed_rows: variantSeedRows,
              identity_listing_refresh: identityListingRefresh,
            },
          };
        }
      }
      return {
        status: enrichedPayload.changed || hasVariantSeedRows ? 'dry_run' : 'skipped',
        reason: enrichedPayload.changed || hasVariantSeedRows ? null : 'unchanged',
        row,
        targetUrl,
        payload: {
          ...enrichedPayload,
          variant_seed_rows: variantSeedRows,
          identity_listing_refresh: identityListingRefresh,
        },
      };
    }

    let identityListingRefresh = null;
    await withClient(async (client) => {
      if (enrichedPayload.changed) {
        await client.query(
          `
            UPDATE external_product_seeds
            SET
              title = CASE WHEN $2 <> '' THEN $2 ELSE title END,
              canonical_url = CASE WHEN $3 <> '' THEN $3 ELSE canonical_url END,
              destination_url = CASE WHEN $4 <> '' THEN $4 ELSE destination_url END,
              image_url = CASE WHEN $5 <> '' THEN $5 ELSE image_url END,
              price_amount = COALESCE($6, price_amount),
              price_currency = CASE WHEN $7 <> '' THEN $7 ELSE price_currency END,
              availability = CASE WHEN $8 <> '' THEN $8 ELSE availability END,
              seed_data = $9::jsonb,
              updated_at = now()
            WHERE id = $1
          `,
          [
            row.id,
            enrichedPayload.nextRow.title,
            enrichedPayload.nextRow.canonical_url,
            enrichedPayload.nextRow.destination_url,
            enrichedPayload.nextRow.image_url,
            enrichedPayload.nextRow.price_amount,
            enrichedPayload.nextRow.price_currency,
            enrichedPayload.nextRow.availability,
            JSON.stringify(enrichedPayload.nextRow.seed_data),
          ],
        );
        identityListingRefresh = await refreshPdpIdentityListingSourcePayload(client, row, enrichedPayload.nextRow);
      }
      if (hasVariantSeedRows) {
        await upsertVariantSeedRows(client, variantSeedRows);
      }
    });

    return {
      status: 'updated',
      row,
      targetUrl,
      payload: {
        ...enrichedPayload,
        variant_seed_rows: variantSeedRows,
        identity_listing_refresh: identityListingRefresh,
      },
    };
  } catch (error) {
    const nextSeedData = buildFailureSeedData(row, targetUrl, error);
    const failureEnrichment = await enrichExternalSeedRowIngredients({
      row: {
        ...row,
        seed_data: nextSeedData,
      },
      ingredientId:
        normalizeNonEmptyString(row?.ingredient_id) ||
        normalizeNonEmptyString(ensureJsonObject(row?.seed_data).ingredient_id),
      ingredientName:
        normalizeNonEmptyString(row?.ingredient_name) ||
        normalizeNonEmptyString(ensureJsonObject(row?.seed_data).ingredient_name),
    });
    const persistedSeedData =
      failureEnrichment?.row && typeof failureEnrichment.row === 'object'
        ? ensureJsonObject(failureEnrichment.row.seed_data)
        : nextSeedData;
    if (!options.dryRun) {
      await query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb, updated_at = now()
          WHERE id = $1
        `,
        [row.id, JSON.stringify(persistedSeedData)],
      );
    }
    return { status: 'failed', row, targetUrl, error };
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function collectBackfilledExternalProductIds(results, { includeDryRun = false } = {}) {
  const allowStatuses = includeDryRun ? new Set(['updated', 'dry_run']) : new Set(['updated']);
  return uniqueStrings(
    (Array.isArray(results) ? results : [])
      .filter((result) => result && allowStatuses.has(result.status))
      .flatMap((result) => [
        result?.row?.external_product_id,
        result?.payload?.nextRow?.external_product_id,
        result?.payload?.nextRow?.seed_data?.external_product_id,
        ...(Array.isArray(result?.payload?.variant_seed_rows)
          ? result.payload.variant_seed_rows.map((row) => row?.external_product_id)
          : []),
      ]),
  );
}

async function filterProductIdsMissingPivotaInsights(productIds) {
  const ids = uniqueStrings(productIds);
  if (ids.length === 0) return { missing_product_ids: [], check_error: null };

  try {
    const keys = ids.map((id) => `product:${id}`);
    const res = await query(
      `
        SELECT kb_key
        FROM aurora_product_intel_kb
        WHERE kb_key = ANY($1::text[])
          AND last_error IS NULL
          AND (
            analysis ? 'product_intel_v1'
            OR analysis ? 'product_intel'
          )
      `,
      [keys],
    );
    const covered = new Set(
      (res.rows || [])
        .map((row) => normalizeNonEmptyString(row?.kb_key).replace(/^product:/, ''))
        .filter(Boolean),
    );
    return {
      missing_product_ids: ids.filter((id) => !covered.has(id)),
      check_error: null,
    };
  } catch (error) {
    return {
      missing_product_ids: ids,
      check_error: normalizeNonEmptyString(error?.message || error),
    };
  }
}

function runPivotaInsightsCoverageForProductIds(productIds, options = {}) {
  const ids = uniqueStrings(productIds);
  if (ids.length === 0) {
    return { status: 'skipped', reason: 'no_missing_products', product_ids: [] };
  }

  const rootDir = path.resolve(__dirname, '..');
  const generatedAt = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = normalizeNonEmptyString(options.outDir) ||
    path.join(rootDir, 'reports', 'pivota-insights-backfill', generatedAt);
  const args = [
    path.join(rootDir, 'scripts', 'pivota_insights_coverage_batch.js'),
    '--product-ids',
    ids.join(','),
    '--out-dir',
    outDir,
  ];
  if (options.skipGemini) args.push('--skip-gemini');

  const child = spawnSync(process.execPath, args, {
    cwd: rootDir,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = normalizeNonEmptyString(child.stdout);
  const stderr = normalizeNonEmptyString(child.stderr);
  if (child.status !== 0) {
    return {
      status: 'failed',
      product_ids: ids,
      out_dir: outDir,
      exit_code: child.status,
      error: stderr || stdout || 'pivota_insights_coverage_failed',
    };
  }

  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }

  return {
    status: 'ok',
    product_ids: ids,
    out_dir: outDir,
    result: parsed || stdout,
  };
}

async function preparePivotaInsightsForBackfill(results, options = {}) {
  if (options.dryRun) return { status: 'skipped', reason: 'dry_run' };
  if (options.skipInsights) return { status: 'skipped', reason: 'skip_insights' };

  const productIds = collectBackfilledExternalProductIds(results);
  const missingCheck = await filterProductIdsMissingPivotaInsights(productIds);
  if (missingCheck.missing_product_ids.length === 0) {
    return {
      status: 'skipped',
      reason: 'already_covered',
      product_ids: productIds,
      check_error: missingCheck.check_error,
    };
  }

  return {
    ...runPivotaInsightsCoverageForProductIds(missingCheck.missing_product_ids, {
      outDir: options.insightsOutDir,
      skipGemini: options.insightsSkipGemini,
    }),
    checked_product_ids: productIds,
    check_error: missingCheck.check_error,
  };
}

async function main() {
  const limit = Math.max(1, Math.min(Number(argValue('limit') || 50), 1000));
  const offset = Math.max(0, Number(argValue('offset') || 0));
  const concurrency = Math.max(1, Math.min(Number(argValue('concurrency') || 3), 10));
  const externalProductId = argValue('external-product-id') || argValue('externalProductId') || null;
  const externalProductIds = Array.from(
    new Set([
      ...parseDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds') || ''),
      ...readDelimitedIdsFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile') || ''),
    ]),
  );
  if (externalProductId && externalProductIds.length > 0) externalProductIds.unshift(externalProductId);
  const options = {
    seedId: argValue('seed-id') || argValue('seedId') || null,
    externalProductId: externalProductIds.length > 0 ? null : externalProductId,
    externalProductIds,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    limit,
    offset,
    concurrency,
    dryRun: hasFlag('dry-run') || hasFlag('dryRun'),
    expandVariants: hasFlag('expand-variants') || hasFlag('expandVariants'),
    skipInsights: hasFlag('skip-insights') || hasFlag('skipInsights'),
    insightsOutDir: argValue('insights-out-dir') || argValue('insightsOutDir') || '',
    insightsSkipGemini: hasFlag('insights-skip-gemini') || hasFlag('insightsSkipGemini'),
    validateImageHealth:
      !(hasFlag('dry-run') || hasFlag('dryRun')) &&
      !hasFlag('skip-image-health-validation') &&
      !hasFlag('skipImageHealthValidation'),
    baseUrl: DEFAULT_CATALOG_BASE_URL,
  };

  const rows = await fetchRows(options);
  console.log(JSON.stringify({ rows: rows.length, ...options }, null, 2));

  const results = await mapWithConcurrency(rows, concurrency, async (row) => processRow(row, options));
  const summary = {
    scanned: rows.length,
    updated: results.filter((result) => result.status === 'updated').length,
    dry_run: results.filter((result) => result.status === 'dry_run').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    variant_seed_rows: results.reduce(
      (sum, result) => sum + (Array.isArray(result.payload?.variant_seed_rows) ? result.payload.variant_seed_rows.length : 0),
      0,
    ),
  };
  console.log(JSON.stringify(summary, null, 2));

  const insightsCoverage = await preparePivotaInsightsForBackfill(results, options);
  console.log(JSON.stringify({ pivota_insights: insightsCoverage }, null, 2));
  if (insightsCoverage.status === 'failed') {
    process.exitCode = 1;
  }

  if (summary.failed > 0) {
    const failed = results
      .filter((result) => result.status === 'failed')
      .map((result) => ({
        id: result.row?.id,
        targetUrl: result.targetUrl,
        error: String(result.error?.message || result.error || ''),
      }));
    console.error(JSON.stringify({ failed }, null, 2));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchRows,
  processRow,
  pickSeedTargetUrl,
  parseDelimitedIds,
  readDelimitedIdsFile,
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  buildSeedUpdatePayload,
  buildVariantSeedRows,
  buildFailureSeedData,
  comparableSeedData,
  normalizeComparableUrlKey,
  normalizeTargetUrlForMarket,
  recoverTargetUrlFromDiagnostics,
  sanitizeSeedImageUrls,
  validateNextRowImageHealth,
  buildIdentityListingSourcePayload,
  collectBackfilledExternalProductIds,
  filterProductIdsMissingPivotaInsights,
  preparePivotaInsightsForBackfill,
  runPivotaInsightsCoverageForProductIds,
};
