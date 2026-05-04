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
  sanitizeSeedVariantDisplayFields,
  normalizeSeedAvailability,
  normalizeSeedReviewSummary,
  buildExternalSeedProduct,
} = require('../src/services/externalSeedProducts');
const { buildExternalSeedRecallDoc } = require('../src/services/externalSeedRecall');
const { enrichExternalSeedRowIngredients } = require('../src/services/externalSeedIngredientEnrichment');
const { isDisplayablePdpFaqItem } = require('../src/services/pdpFaqQuality');
const {
  deriveReviewContractFromSourceMeta,
} = require('../src/services/pivotaProductIntelReviewPolicy');
const { buildPdpImageDedupeKey, normalizePdpImageUrl } = require('../src/utils/pdpImageUrls');
const {
  attachCommerceFactsToSeedRow,
  validateCommerceFactsGateForSeedRow,
} = require('../src/commerce/commerceFacts');
const {
  applyLocalityFactsToSeedData,
  resolveExternalSeedLocalityFacts,
} = require('../src/services/externalSeedLocalityFacts');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const seedImageProbeCache = new Map();
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

function readTargetUrlOverridesFile(filePath) {
  const normalizedPath = normalizeNonEmptyString(filePath);
  if (!normalizedPath) return {};
  const raw = fs.readFileSync(normalizedPath, 'utf8');
  if (!normalizeNonEmptyString(raw)) return {};
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.exact)
      ? parsed.exact
      : null;
  const overrides = {};
  const addOverride = (key, url) => {
    const normalizedKey = normalizeNonEmptyString(key);
    const normalizedUrl = normalizeUrlLike(url);
    if (normalizedKey && normalizedUrl) overrides[normalizedKey] = normalizedUrl;
  };

  if (entries) {
    for (const entry of entries) {
      addOverride(
        entry?.seed_id || entry?.seedId || entry?.id || entry?.external_product_id || entry?.externalProductId,
        entry?.target_url || entry?.targetUrl || entry?.recovered_url || entry?.recoveredUrl || entry?.canonical_url || entry?.url,
      );
      addOverride(
        entry?.external_product_id || entry?.externalProductId,
        entry?.target_url || entry?.targetUrl || entry?.recovered_url || entry?.recoveredUrl || entry?.canonical_url || entry?.url,
      );
    }
    return overrides;
  }

  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        addOverride(key, value);
      } else if (value && typeof value === 'object') {
        addOverride(key, value.target_url || value.targetUrl || value.recovered_url || value.recoveredUrl || value.canonical_url || value.url);
      }
    }
  }
  return overrides;
}

function resolveTargetUrlOverride(row, overrides) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  return (
    normalizeUrlLike(source[normalizeNonEmptyString(row?.id)]) ||
    normalizeUrlLike(source[normalizeNonEmptyString(row?.external_product_id)]) ||
    ''
  );
}

function normalizeNonEmptyString(value) {
  const next = String(value || '').replace(/\u0000/g, '').replace(/\\u0000/gi, '').trim();
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
const SHOPIFY_DUPLICATE_COPY_SUFFIX_RE = /-copy(?:-\d+)?$/i;
const SHOPIFY_DUPLICATE_COUNTER_SUFFIX_RE = /-(\d{1,2})$/;

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

function buildReferenceTitleTokenSet(...values) {
  return new Set(
    values
      .flatMap((value) => normalizeTitleKey(value).split(/\s+/))
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function stripShopifyDuplicateHandleSuffix(handle, ...referenceValues) {
  let normalized = normalizeProductHandleToken(handle);
  if (!normalized) return normalized;

  let changed = false;
  const strippedCopy = normalized.replace(SHOPIFY_DUPLICATE_COPY_SUFFIX_RE, '');
  if (strippedCopy !== normalized) {
    normalized = strippedCopy;
    changed = true;
  }

  const duplicateCounterMatch = normalized.match(SHOPIFY_DUPLICATE_COUNTER_SUFFIX_RE);
  if (duplicateCounterMatch) {
    const counter = duplicateCounterMatch[1];
    const referenceTokens = buildReferenceTitleTokenSet(...referenceValues);
    if (!referenceTokens.has(counter)) {
      normalized = normalized.slice(0, -duplicateCounterMatch[0].length);
      changed = true;
    }
  }

  return changed ? normalized.replace(/-+$/g, '') : normalizeProductHandleToken(handle);
}

function normalizeShopifyDuplicateProductUrl(value, ...referenceValues) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return normalized;

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const productIndex = segments.findIndex((segment) => /^(?:products?|product)$/i.test(segment));
    if (productIndex === -1 || !segments[productIndex + 1]) return parsed.toString();

    const currentHandle = normalizeProductHandleToken(segments[productIndex + 1]);
    const strippedHandle = stripShopifyDuplicateHandleSuffix(currentHandle, ...referenceValues);
    if (!strippedHandle || strippedHandle === currentHandle) return parsed.toString();

    segments[productIndex + 1] = strippedHandle;
    parsed.pathname = `/${segments.join('/')}${parsed.pathname.endsWith('/') ? '/' : ''}`;
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function expandComparableUrlKeys(values, referenceValues = []) {
  const out = new Set();
  for (const value of values) {
    const normalized = normalizeUrlLike(value);
    if (!normalized) continue;
    const key = normalizeComparableUrlKey(normalized);
    if (key) out.add(key);
    const duplicateNormalized = normalizeShopifyDuplicateProductUrl(normalized, ...referenceValues);
    if (duplicateNormalized && duplicateNormalized !== normalized) {
      const duplicateKey = normalizeComparableUrlKey(duplicateNormalized);
      if (duplicateKey) out.add(duplicateKey);
    }
  }
  return out;
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

function productIdentityTokens(...values) {
  const stopTokens = new Set(['and', 'with', 'the', 'a', 'an', 'by', 'for']);
  return Array.from(
    new Set(
      values
        .flatMap((value) => normalizeTitleKey(value).split(/\s+/))
        .map((token) => token.trim())
        .filter((token) => token && !stopTokens.has(token)),
    ),
  );
}

function tokenOverlapScore(leftTokens, rightTokens) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (!left.size || !right.size) return { common: 0, containment: 0, jaccard: 0 };
  const common = Array.from(left).filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return {
    common,
    containment: common / Math.min(left.size, right.size),
    jaccard: common / union,
  };
}

function isVerifiedShopifyRedirectReplacement(targetUrl, product, row) {
  const productUrl = normalizeUrlLike(product?.url);
  if (!looksLikeDirectProductTargetUrl(targetUrl) || !looksLikeDirectProductTargetUrl(productUrl)) return false;
  if (isVerifiedShopifyMarketReplacement(targetUrl, productUrl)) return true;

  const targetHandle = extractShopifyHandleFromUrl(targetUrl);
  const productHandle = extractShopifyHandleFromUrl(productUrl);
  if (!targetHandle || !productHandle || targetHandle === productHandle) return false;

  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const leftTokens = productIdentityTokens(
    targetHandle,
    row?.title,
    row?.name,
    seedData.title,
    snapshot.title,
  );
  const rightTokens = productIdentityTokens(productHandle, product?.title);
  const score = tokenOverlapScore(leftTokens, rightTokens);
  return score.common >= 4 && score.containment >= 0.65 && score.jaccard >= 0.55;
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

function stripNullBytesFromString(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\\u0000/gi, '');
}

function stripNullBytesFromUtf8String(value) {
  const cleaned = stripNullBytesFromString(value);
  const bytes = Buffer.from(cleaned, 'utf8');
  if (!bytes.includes(0)) return cleaned;
  return Buffer.from(bytes.filter((byte) => byte !== 0)).toString('utf8');
}

function sanitizeJsonForPostgres(value) {
  if (typeof value === 'string' || value instanceof String) return stripNullBytesFromUtf8String(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonForPostgres(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, candidate]) => [
      stripNullBytesFromUtf8String(key),
      sanitizeJsonForPostgres(candidate),
    ]),
  );
}

function sanitizeTextForPostgres(value) {
  if (value === null || value === undefined) return value;
  return stripNullBytesFromUtf8String(value);
}

function stringifyPostgresJsonb(value) {
  return stripNullBytesFromUtf8String(JSON.stringify(sanitizeJsonForPostgres(value || {})));
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

function collectRawVariantImageUrls(variant) {
  const out = [];
  if (!variant || typeof variant !== 'object') return out;
  if (variant.image_url) out.push(variant.image_url);
  if (variant.image) out.push(variant.image);
  if (Array.isArray(variant.image_urls)) out.push(...variant.image_urls);
  if (Array.isArray(variant.images)) out.push(...variant.images);
  return out.map(normalizeNonEmptyString).filter(Boolean);
}

function hasNestedVariantImageSanitizationDelta(seedData) {
  const parsed = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsed.snapshot);
  const variants = [
    ...(Array.isArray(parsed.variants) ? parsed.variants : []),
    ...(Array.isArray(snapshot.variants) ? snapshot.variants : []),
  ];
  for (const variant of variants) {
    const rawUrls = collectRawVariantImageUrls(variant);
    for (const url of rawUrls) {
      const normalized = normalizePdpImageUrl(url) || normalizeUrlLike(url);
      if (!normalized || isDecorativeSeedImageUrl(normalized)) return true;
    }
  }
  return false;
}

function applySanitizedNestedVariantImages(nextRow) {
  const seedData = ensureJsonObject(nextRow?.seed_data);
  if (!hasNestedVariantImageSanitizationDelta(seedData)) return nextRow;
  const snapshot = ensureJsonObject(seedData.snapshot);
  const variants = normalizeSeedVariants(seedData, nextRow);
  if (!variants.length) return nextRow;
  const nextSeedData = {
    ...seedData,
    variants,
    snapshot: {
      ...snapshot,
      variants: cloneJsonValue(variants),
    },
  };
  return {
    ...nextRow,
    seed_data: nextSeedData,
  };
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

function collectRawProductImageUrls(product) {
  const out = [];
  if (!product || typeof product !== 'object') return out;
  if (product.image_url) out.push(product.image_url);
  if (product.image) out.push(product.image);
  if (Array.isArray(product.image_urls)) out.push(...product.image_urls);
  if (Array.isArray(product.images)) out.push(...product.images);
  return out.map(normalizeNonEmptyString).filter(Boolean);
}

function isDecorativeSeedImageUrl(value) {
  const normalized = normalizeUrlLike(value).toLowerCase();
  if (!normalized) return false;
  let pathname = normalized;
  let filename = '';
  let hostname = '';
  try {
    const parsed = new URL(normalized);
    hostname = String(parsed.hostname || '').toLowerCase();
    pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    filename = String(pathname.split('/').pop() || '').trim();
  } catch {
    pathname = normalized;
    filename = normalized.split('/').pop() || '';
  }
  const explicitFamilyHost = requiresExplicitGalleryFamilyMatch(hostname);
  return (
    normalized.endsWith('.svg') ||
    normalized.includes('.svg?') ||
    normalized.includes('data:image') ||
    /\/(?:ivborw0kggo|r0lgodlh|base64)/i.test(pathname) ||
    (filename.length > 120 && !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(filename)) ||
    normalized.includes('/menu.svg') ||
    normalized.includes('/close.svg') ||
    normalized.includes('/icon-') ||
    normalized.includes('icon-search') ||
    normalized.includes('icon-cart') ||
    normalized.includes('icon-account') ||
    normalized.includes('/logo.svg') ||
    normalized.includes('/tf_logo.svg') ||
    pathname.includes('/navigation/') ||
    pathname.includes('/navbar') ||
    pathname.includes('/homepage/') ||
    pathname.includes('/home-page/') ||
    pathname.includes('/brand-logo') ||
    pathname.includes('/brands-logo') ||
    pathname.includes('/icons/svg/') ||
    pathname.includes('/email-signup') ||
    pathname.includes('/popup') ||
    pathname.includes('/track-order') ||
    pathname.includes('/flyout') ||
    pathname.includes('/slot-a') ||
    pathname.includes('/slota/') ||
    pathname.includes('/heroes-slot') ||
    /(?:^|\/)gnav[-_]/i.test(pathname) ||
    /[_-]\d{2,3}x\d{2,3}_crop_center(?:[._-]|$)/i.test(normalized) ||
    normalized.includes('gnav-shop-') ||
    normalized.includes('shade-finder-hero-') ||
    pathname.includes('/cdn/shop/t/') ||
    /(?:^|[-_ ])find[-_ ]shade(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])try[-_ ]shade(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])get[-_ ]the[-_ ]look(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])best[-_ ]of[-_ ]beauty(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])best[-_ ]new[-_ ]brand(?:[-_ ]|$)/i.test(filename) ||
    (filename.includes('badge') && !/safety-badge|recycling-badge/i.test(filename)) ||
    /(?:^|[-_ ])(?:allure|award|awards|seal)(?:[-_ ]|$)/i.test(filename) ||
    (explicitFamilyHost && /(?:message|benefits?)/i.test(filename)) ||
    /(?:^|[-_ ])readers?[-_ ]/i.test(filename) ||
    /(?:^|[-_ ])allure[-_ ]/i.test(filename)
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
  primer: 'primer',
  primers: 'primer',
  liner: 'liner',
  lipstick: 'lipstick',
  lotion: 'lotion',
  lotions: 'lotion',
  mascara: 'mascara',
  mask: 'mask',
  mist: 'mist',
  mists: 'mist',
  moisturizer: 'moisturizer',
  oil: 'oil',
  patch: 'patch',
  patches: 'patch',
  pen: 'pen',
  powder: 'powder',
  powders: 'powder',
  brush: 'brush',
  brushes: 'brush',
  scrub: 'scrub',
  serum: 'serum',
  shampoo: 'shampoo',
  spray: 'mist',
  sprays: 'mist',
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
  'travel',
  'usage',
]);
const IMAGE_RELEVANCE_FAMILY_STOP_TOKENS = new Set([
  ...IMAGE_RELEVANCE_NOISE_TOKENS,
  'all',
  'always',
  'and',
  'best',
  'bestsellers',
  'body',
  'care',
  'closed',
  'closelid',
  'comfort',
  'day',
  'face',
  'find',
  'for',
  'full',
  'hair',
  'in',
  'http',
  'https',
  'it',
  'new',
  'of',
  'openlid',
  'online',
  'only',
  'optimist',
  'or',
  'primary',
  'pump',
  'out',
  'pore',
  'regular',
  'secondary',
  'set',
  'shop',
  'size',
  'skin',
  'sku',
  'the',
  'to',
  'tools',
  'www',
  'web',
]);
const STRICT_GALLERY_FAMILY_FILTER_HOSTS = new Set([
  'rarebeauty.com',
  'fentybeauty.com',
  'fentyskin.com',
  'naturium.com',
  'pixibeauty.com',
  'murad.com',
  'sigmabeauty.com',
  'kyliecosmetics.com',
  'beekman1802.com',
]);
const STRICT_GALLERY_EXPLICIT_FAMILY_MATCH_HOSTS = new Set([
  'fentybeauty.com',
  'fentyskin.com',
]);
const CONTENT_IMAGE_GENERIC_FAMILY_TOKENS = new Set([
  'after',
  'arm',
  'badge',
  'before',
  'benefit',
  'benefits',
  'circle',
  'claims',
  'details',
  'directions',
  'focus',
  'how',
  'image',
  'images',
  'imperfect',
  'ingredient',
  'ingredients',
  'infographic',
  'infographics',
  'message',
  'note',
  'notes',
  'overview',
  'pdp',
  'profile',
  'routine',
  'scent',
  'step',
  'to',
  'usage',
  'vibe',
]);

function requiresStrictGalleryFamilyFiltering(hostname) {
  const normalized = normalizeNonEmptyString(hostname).toLowerCase();
  if (!normalized) return false;
  for (const rootHost of STRICT_GALLERY_FAMILY_FILTER_HOSTS) {
    if (normalized === rootHost || normalized.endsWith(`.${rootHost}`)) return true;
  }
  return false;
}

function requiresExplicitGalleryFamilyMatch(hostname) {
  const normalized = normalizeNonEmptyString(hostname).toLowerCase();
  if (!normalized) return false;
  for (const rootHost of STRICT_GALLERY_EXPLICIT_FAMILY_MATCH_HOSTS) {
    if (normalized === rootHost || normalized.endsWith(`.${rootHost}`)) return true;
  }
  return false;
}

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

function extractImageRelevanceUrlText(value) {
  const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return decodeBasicHtmlEntities(decodeURIComponent(parsed.pathname || ''))
      .replace(/\/+/g, ' ')
      .trim();
  } catch {
    return normalizeNonEmptyString(normalized);
  }
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
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
      .trim();
    return tokenizeImageRelevanceValue(filename);
  } catch {
    return tokenizeImageRelevanceValue(normalized);
  }
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

function isContentLikeSeedImageUrl(value) {
  const filename = extractImageFilenameText(value);
  if (!filename) return false;
  return (
    /(?:^|[-_ ])pdp[-_ ]usage(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])pdp[-_ ]details?[-_ ]image(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])imperfect[-_ ]circle(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])infographics?(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])ingredients?(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])overview(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])(?:how[-_ ]to|directions?|routine|step)(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])scent[-_ ]?(?:profile|note|notes|vibe)(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])before[-_ ]after(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])badge(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])arm[-_ ]focus(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])(?:allure|award|awards|seal)(?:[-_ ]|$)/i.test(filename)
  );
}

function extractImageFamilyTokens(values, productTypes = []) {
  const out = [];
  for (const token of Array.isArray(values) ? values : []) {
    if (!token || token.length < 4) continue;
    if (!/[a-z]/i.test(token) || /^\d+x\d+$/i.test(token)) continue;
    if (IMAGE_RELEVANCE_FAMILY_STOP_TOKENS.has(token)) continue;
    const canonicalType = IMAGE_RELEVANCE_PRODUCT_TYPE_ALIASES[token];
    if (canonicalType && productTypes.includes(canonicalType)) continue;
    if (out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

function buildSeedImageRelevanceContext(options = {}) {
  const values = uniqueStrings([
    options.productTitle,
    extractImageRelevanceUrlText(options.productUrl),
    options.variantTitle && !isDefaultVariantTitle(options.variantTitle) ? options.variantTitle : '',
    ...(Array.isArray(options.additionalValues) ? options.additionalValues.filter(Boolean) : []),
  ]);
  const tokens = values.flatMap((value) => tokenizeImageRelevanceValue(value));
  const productTypes = extractCanonicalImageProductTypes(tokens);
  return {
    bundleLike: tokens.some((token) => IMAGE_RELEVANCE_BUNDLE_TOKENS.has(token)),
    productTypes,
    familyTokens: extractImageFamilyTokens(tokens, productTypes),
    strictFamilyFiltering: requiresStrictGalleryFamilyFiltering(imageAssetHostname(options.productUrl)),
    requireExplicitFamilyMatch: requiresExplicitGalleryFamilyMatch(imageAssetHostname(options.productUrl)),
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

function hasSeedImageFamilyOverlap(imageTokens, familyTokens) {
  return imageTokens.some((token) =>
    token.length >= 4 &&
    familyTokens.some(
      (familyToken) =>
        familyToken.length >= 4 &&
        (token === familyToken || token.includes(familyToken) || familyToken.includes(token)),
    ),
  );
}

function isProductRelevantSeedImageUrl(value, relevanceContext) {
  if (!relevanceContext) {
    return true;
  }
  if (isContentLikeSeedImageUrl(value)) return false;
  if (!relevanceContext.bundleLike && isCollectionStyleSeedImageUrl(value)) return false;
  const imageTokens = extractImageFilenameTokens(value);
  const imageProductTypes = extractCanonicalImageProductTypes(imageTokens);
  if (!relevanceContext.bundleLike && relevanceContext.productTypes.length === 1 && imageProductTypes.length > 0) {
    if (!imageProductTypes.includes(relevanceContext.productTypes[0])) return false;
  }
  if (relevanceContext.bundleLike || !relevanceContext.strictFamilyFiltering || relevanceContext.familyTokens.length === 0) {
    return true;
  }
  const overlapsFamily = hasSeedImageFamilyOverlap(imageTokens, relevanceContext.familyTokens);
  if (overlapsFamily) return true;
  const imageFamilyTokens = extractImageFamilyTokens(imageTokens, relevanceContext.productTypes || []);
  if (imageFamilyTokens.length === 0) return !relevanceContext.requireExplicitFamilyMatch;
  return false;
}

function isRelevantSeedContentImageUrl(value, relevanceContext) {
  if (!relevanceContext || !relevanceContext.strictFamilyFiltering || relevanceContext.familyTokens.length === 0) {
    return true;
  }
  const imageTokens = extractImageFilenameTokens(value);
  const overlapsFamily = hasSeedImageFamilyOverlap(imageTokens, relevanceContext.familyTokens);
  if (overlapsFamily) return true;
  const imageFamilyTokens = extractImageFamilyTokens(imageTokens, relevanceContext.productTypes || []);
  const specificFamilyTokens = imageFamilyTokens.filter((token) => !CONTENT_IMAGE_GENERIC_FAMILY_TOKENS.has(token));
  if (specificFamilyTokens.length === 0) return !relevanceContext.requireExplicitFamilyMatch;
  return false;
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
  const mode =
    options && typeof options === 'object' && normalizeNonEmptyString(options.mode)
      ? normalizeNonEmptyString(options.mode).toLowerCase()
      : 'gallery';
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
    if (!normalized || isDecorativeSeedImageUrl(normalized)) continue;
    if (mode !== 'content' && !isProductRelevantSeedImageUrl(normalized, relevanceContext)) continue;
    const comparableKey = normalizeComparableImageKey(normalized);
    if (!comparableKey || seen.has(comparableKey)) continue;
    seen.add(comparableKey);
    out.push(normalized);
  }
  return out;
}

function extractContentLikeSeedImageUrls(values, options = {}) {
  const relevanceContext =
    options && typeof options === 'object' && options.relevanceContext
      ? options.relevanceContext
      : buildSeedImageRelevanceContext(options);
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizePdpImageUrl(value) || normalizeUrlLike(value);
    if (
      !normalized ||
      isDecorativeSeedImageUrl(normalized) ||
      !isContentLikeSeedImageUrl(normalized) ||
      !isRelevantSeedContentImageUrl(normalized, relevanceContext)
    ) {
      continue;
    }
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
  if (seedImageProbeCache.has(target)) return seedImageProbeCache.get(target);
  const probePromise = probeSeedImageUrlUncached(target);
  seedImageProbeCache.set(target, probePromise);
  return probePromise;
}

async function probeSeedImageUrlUncached(target) {
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
  const variantSanitizedNextRow = applySanitizedNestedVariantImages(nextRow);
  const seedData = ensureJsonObject(variantSanitizedNextRow.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const imageUrls = sanitizeSeedImageUrls([
    variantSanitizedNextRow.image_url,
    seedData.image_url,
    ...(Array.isArray(seedData.image_urls) ? seedData.image_urls : []),
    snapshot.image_url,
    ...(Array.isArray(snapshot.image_urls) ? snapshot.image_urls : []),
  ]);
  if (!imageUrls.length) {
    return {
      nextRow: variantSanitizedNextRow,
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
      nextRow: variantSanitizedNextRow,
      validation: {
        ...validation,
        status: 'failed_no_valid_images',
      },
    };
  }
  return {
    nextRow: applyValidatedImageUrls(variantSanitizedNextRow, validImageUrls, {
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

const EXTERNAL_SEED_PRODUCT_KINDS = new Set([
  'single_formula',
  'bundle',
  'accessory',
  'fragrance',
  'general_merchandise',
]);

function normalizeProductKind(value) {
  const normalized = normalizeNonEmptyString(value)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return EXTERNAL_SEED_PRODUCT_KINDS.has(normalized) ? normalized : '';
}

function normalizeBundleComponents(value, maxItems = 24) {
  const items = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const name = normalizeNonEmptyString(item?.name);
    const quantity = normalizeNonEmptyString(item?.quantity);
    const sourceKind = normalizeNonEmptyString(item?.source_kind || item?.sourceKind) || 'catalog_intelligence_bundle_component';
    const rawText = normalizeNonEmptyString(item?.raw_text || item?.rawText);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      ...(quantity ? { quantity } : {}),
      source_kind: sourceKind,
      ...(rawText ? { raw_text: rawText } : {}),
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

const PDP_FIELD_QUALITY_KEYS = [
  'description_raw',
  'details_sections',
  'ingredients_raw',
  'active_ingredients_raw',
  'how_to_use_raw',
  'faq_items',
];
const PDP_CONTENT_ASSET_CONTRACT_VERSION = 'pivota.pdp_content_asset.v1';
const EXTERNAL_SEED_SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const PDP_CONTENT_ASSET_KEYS = [
  'description',
  ...PDP_FIELD_QUALITY_KEYS,
];
const PROTECTED_PDP_CONTENT_REVIEW_STATES = new Set([
  'assistant_reviewed',
  'human_reviewed',
  'locked',
]);
const MANUAL_ONLY_PDP_CONTENT_POLICIES = new Set([
  'manual_only',
  'locked',
]);
const LEGACY_EXTERNAL_SEED_PDP_SHADOW_FIELDS = [
  'details_sections',
  'detail_sections',
  'details',
  'faq_items',
  'faq',
  'questions',
  'how_to_use',
  'howToUse',
];

function buildExternalSeedSnapshotContract() {
  return {
    contract_version: EXTERNAL_SEED_SNAPSHOT_CONTRACT_VERSION,
    source: 'catalog_intelligence',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: new Date().toISOString(),
  };
}

function deleteLegacyExternalSeedPdpShadowFields(target) {
  if (!target || typeof target !== 'object') return;
  for (const fieldName of LEGACY_EXTERNAL_SEED_PDP_SHADOW_FIELDS) {
    delete target[fieldName];
  }
}

function normalizeFieldQualitySummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next = {};
  for (const key of PDP_FIELD_QUALITY_KEYS) {
    const raw = value?.[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const sourceQualityStatus = normalizeNonEmptyString(raw.source_quality_status || raw.sourceQualityStatus).toLowerCase();
    const sourceOrigin = normalizeNonEmptyString(raw.source_origin || raw.sourceOrigin).toLowerCase();
    next[key] = {
      ...(sourceOrigin ? { source_origin: sourceOrigin } : {}),
      ...(sourceQualityStatus ? { source_quality_status: sourceQualityStatus } : {}),
      source_kinds: Array.isArray(raw.source_kinds)
        ? raw.source_kinds.map((item) => normalizeNonEmptyString(item)).filter(Boolean)
        : [],
      reason_codes: Array.isArray(raw.reason_codes)
        ? raw.reason_codes.map((item) => normalizeNonEmptyString(item)).filter(Boolean)
        : [],
    };
  }
  return Object.keys(next).length > 0 ? next : null;
}

function readFieldQualityStatus(summary, key) {
  return normalizeNonEmptyString(summary?.[key]?.source_quality_status).toLowerCase();
}

function isSurfaceablePdpField(summary, key) {
  const status = readFieldQualityStatus(summary, key);
  if (!status) return true;
  return status === 'high' || status === 'medium';
}

function mergeFieldQualitySummaries(existing, incoming) {
  const next = {};
  const existingSummary = normalizeFieldQualitySummary(existing);
  const incomingSummary = normalizeFieldQualitySummary(incoming);
  for (const key of PDP_FIELD_QUALITY_KEYS) {
    const row = incomingSummary?.[key] || existingSummary?.[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    next[key] = {
      ...row,
      source_kinds: Array.isArray(row.source_kinds) ? [...row.source_kinds] : [],
      reason_codes: Array.isArray(row.reason_codes) ? [...row.reason_codes] : [],
    };
  }
  return Object.keys(next).length > 0 ? next : null;
}

function normalizePdpContentAssetContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawFields = ensureJsonObject(value.fields);
  const fields = {};
  for (const key of PDP_CONTENT_ASSET_KEYS) {
    const raw = ensureJsonObject(rawFields[key] || value[key]);
    if (!Object.keys(raw).length) continue;
    const reviewState = normalizeNonEmptyString(raw.review_state || raw.reviewState).toLowerCase();
    const overwritePolicy = normalizeNonEmptyString(raw.overwrite_policy || raw.overwritePolicy).toLowerCase();
    const sourceQualityStatus = normalizeNonEmptyString(raw.source_quality_status || raw.sourceQualityStatus).toLowerCase();
    const sourceOrigin = normalizeNonEmptyString(raw.source_origin || raw.sourceOrigin).toLowerCase();
    const contentHash = normalizeNonEmptyString(raw.content_hash || raw.contentHash);
    const updatedAt = normalizeNonEmptyString(raw.updated_at || raw.updatedAt);
    fields[key] = {
      ...(reviewState ? { review_state: reviewState } : {}),
      ...(overwritePolicy ? { overwrite_policy: overwritePolicy } : {}),
      ...(sourceQualityStatus ? { source_quality_status: sourceQualityStatus } : {}),
      ...(sourceOrigin ? { source_origin: sourceOrigin } : {}),
      ...(contentHash ? { content_hash: contentHash } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    };
  }
  if (!Object.keys(fields).length) return null;
  return {
    contract_version: normalizeNonEmptyString(value.contract_version || value.contractVersion) || PDP_CONTENT_ASSET_CONTRACT_VERSION,
    owner: normalizeNonEmptyString(value.owner) || 'pivota',
    fields,
  };
}

function canonicalizePdpContentAssetValue(fieldKey, value) {
  if (fieldKey === 'details_sections') return normalizeDetailsSections(value);
  if (fieldKey === 'faq_items') return normalizeFaqItems(value);
  return normalizeNonEmptyString(value);
}

function hasPdpContentAssetValue(fieldKey, value) {
  const normalized = canonicalizePdpContentAssetValue(fieldKey, value);
  if (Array.isArray(normalized)) return normalized.length > 0;
  return Boolean(normalized);
}

function hashPdpContentAssetValue(fieldKey, value) {
  if (!hasPdpContentAssetValue(fieldKey, value)) return '';
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(canonicalizePdpContentAssetValue(fieldKey, value)))
    .digest('hex')
    .slice(0, 16);
}

function measurePdpContentAssetValue(fieldKey, value) {
  const normalized = canonicalizePdpContentAssetValue(fieldKey, value);
  if (Array.isArray(normalized)) {
    const bodies = normalized.map((item) => {
      if (fieldKey === 'faq_items') {
        return `${normalizeNonEmptyString(item?.question)} ${normalizeNonEmptyString(item?.answer)}`.trim();
      }
      return `${normalizeNonEmptyString(item?.heading)} ${normalizeNonEmptyString(item?.body || item?.content || item?.text)}`.trim();
    });
    const charCount = bodies.reduce((sum, body) => sum + body.length, 0);
    return {
      item_count: normalized.length,
      char_count: charCount,
      score: normalized.length * 120 + charCount,
    };
  }
  const text = String(normalized || '');
  return {
    item_count: text ? 1 : 0,
    char_count: text.length,
    score: text.length,
  };
}

function normalizePdpContentAssetSummaryKey(fieldKey) {
  return fieldKey === 'description' ? 'description_raw' : fieldKey;
}

function shouldPreserveExistingPdpContent({
  fieldKey,
  incomingValue,
  existingValue,
  incomingSummary,
  existingSummary,
  assetField,
}) {
  const hasExisting = hasPdpContentAssetValue(fieldKey, existingValue);
  const hasIncoming = hasPdpContentAssetValue(fieldKey, incomingValue);
  if (!hasExisting) return { preserve: false, reason: '', existingApproved: false };

  const summaryKey = normalizePdpContentAssetSummaryKey(fieldKey);
  const incomingSurfaceable = isSurfaceablePdpField(incomingSummary, summaryKey);
  const existingSurfaceable = isSurfaceablePdpField(existingSummary, summaryKey);
  const reviewState = normalizeNonEmptyString(assetField?.review_state).toLowerCase();
  const overwritePolicy = normalizeNonEmptyString(assetField?.overwrite_policy).toLowerCase();
  const hasExistingQualityEvidence = Boolean(
    existingSummary?.[summaryKey] &&
      typeof existingSummary[summaryKey] === 'object' &&
      !Array.isArray(existingSummary[summaryKey]),
  );
  const hasExistingAssetField = Boolean(
    assetField &&
      typeof assetField === 'object' &&
      !Array.isArray(assetField) &&
      Object.keys(assetField).length > 0,
  );
  const existingApproved =
    PROTECTED_PDP_CONTENT_REVIEW_STATES.has(reviewState) ||
    MANUAL_ONLY_PDP_CONTENT_POLICIES.has(overwritePolicy) ||
    ((hasExistingQualityEvidence || hasExistingAssetField) && existingSurfaceable);
  if (!hasIncoming) {
    return existingApproved
      ? { preserve: true, reason: 'preserve_existing_when_incoming_empty', existingApproved }
      : { preserve: false, reason: '', existingApproved };
  }

  const incomingHash = hashPdpContentAssetValue(fieldKey, incomingValue);
  const existingHash = hashPdpContentAssetValue(fieldKey, existingValue);
  if (incomingHash && existingHash && incomingHash === existingHash) {
    return { preserve: false, reason: 'same_content', existingApproved };
  }
  if (
    PROTECTED_PDP_CONTENT_REVIEW_STATES.has(reviewState) ||
    MANUAL_ONLY_PDP_CONTENT_POLICIES.has(overwritePolicy)
  ) {
    return { preserve: true, reason: 'preserve_reviewed_pivota_asset', existingApproved };
  }
  if (!hasExistingQualityEvidence && !hasExistingAssetField) {
    return { preserve: false, reason: '', existingApproved };
  }
  if (existingSurfaceable && !incomingSurfaceable) {
    return { preserve: true, reason: 'preserve_surfaceable_existing_over_unsurfaceable_incoming', existingApproved };
  }
  if (!existingSurfaceable || !incomingSurfaceable) {
    return { preserve: false, reason: '', existingApproved };
  }

  const existingRichness = measurePdpContentAssetValue(fieldKey, existingValue);
  const incomingRichness = measurePdpContentAssetValue(fieldKey, incomingValue);
  const scoreGap = existingRichness.score - incomingRichness.score;
  const charGap = existingRichness.char_count - incomingRichness.char_count;
  const itemGap = existingRichness.item_count - incomingRichness.item_count;
  const materiallyRicher =
    scoreGap >= (Array.isArray(canonicalizePdpContentAssetValue(fieldKey, existingValue)) ? 90 : 50) &&
    charGap >= 40;
  const structurallyRicher =
    itemGap > 0 &&
    scoreGap >= 40;
  if (materiallyRicher || structurallyRicher) {
    return { preserve: true, reason: 'preserve_richer_existing_content_asset', existingApproved };
  }
  return { preserve: false, reason: '', existingApproved };
}

function appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
  fieldKey,
  candidateValue,
  reasonCode,
  incomingSummary,
  extractorMode,
}) {
  if (!hasPdpContentAssetValue(fieldKey, candidateValue)) return snapshotQuarantine;
  const next = snapshotQuarantine && typeof snapshotQuarantine === 'object'
    ? cloneJsonValue(snapshotQuarantine)
    : {
        contract_version: 'external_seed.snapshot_quarantine.v1',
        source: 'catalog_intelligence',
      };
  if (normalizeNonEmptyString(extractorMode)) next.extractor_mode = normalizeNonEmptyString(extractorMode);
  next.updated_at = new Date().toISOString();
  const preservedCandidates = ensureJsonObject(next.preserved_candidates);
  const summaryKey = normalizePdpContentAssetSummaryKey(fieldKey);
  preservedCandidates[fieldKey] = {
    value: cloneJsonValue(canonicalizePdpContentAssetValue(fieldKey, candidateValue)),
    ...(reasonCode ? { reason_code: reasonCode, reason_codes: [reasonCode] } : {}),
    ...(normalizeNonEmptyString(incomingSummary?.[summaryKey]?.source_quality_status)
      ? { source_quality_status: normalizeNonEmptyString(incomingSummary[summaryKey].source_quality_status).toLowerCase() }
      : {}),
    ...(normalizeNonEmptyString(incomingSummary?.[summaryKey]?.source_origin)
      ? { source_origin: normalizeNonEmptyString(incomingSummary[summaryKey].source_origin).toLowerCase() }
      : {}),
  };
  next.preserved_candidates = preservedCandidates;
  return next;
}

function buildNextPdpContentAssetContract({
  existing,
  fieldValues,
  fieldQualitySummary,
}) {
  const existingContract = normalizePdpContentAssetContract(existing);
  const nextFields = {};
  for (const fieldKey of PDP_CONTENT_ASSET_KEYS) {
    const value = fieldValues?.[fieldKey];
    if (!hasPdpContentAssetValue(fieldKey, value)) continue;
    const existingField = ensureJsonObject(existingContract?.fields?.[fieldKey]);
    const summaryKey = normalizePdpContentAssetSummaryKey(fieldKey);
    const contentHash = hashPdpContentAssetValue(fieldKey, value);
    const reviewState = normalizeNonEmptyString(existingField.review_state).toLowerCase() || 'unreviewed';
    const overwritePolicy = normalizeNonEmptyString(existingField.overwrite_policy).toLowerCase() || 'preserve_best_available';
    const sourceQualityStatus = normalizeNonEmptyString(fieldQualitySummary?.[summaryKey]?.source_quality_status).toLowerCase()
      || normalizeNonEmptyString(existingField.source_quality_status).toLowerCase();
    const sourceOrigin = normalizeNonEmptyString(fieldQualitySummary?.[summaryKey]?.source_origin).toLowerCase()
      || normalizeNonEmptyString(existingField.source_origin).toLowerCase();
    nextFields[fieldKey] = {
      review_state: reviewState,
      overwrite_policy: overwritePolicy,
      ...(sourceQualityStatus ? { source_quality_status: sourceQualityStatus } : {}),
      ...(sourceOrigin ? { source_origin: sourceOrigin } : {}),
      ...(contentHash ? { content_hash: contentHash } : {}),
      updated_at: new Date().toISOString(),
    };
  }
  if (!Object.keys(nextFields).length) return null;
  return {
    contract_version: PDP_CONTENT_ASSET_CONTRACT_VERSION,
    owner: normalizeNonEmptyString(existingContract?.owner) || 'pivota',
    fields: nextFields,
  };
}

function buildSnapshotQuarantine({
  existing,
  representativeProduct,
  fieldQualitySummary,
  extractorMode,
  rawFieldValues,
}) {
  const existingQuarantine = ensureJsonObject(existing);
  const quarantinedFieldsFromExtractor = ensureJsonObject(representativeProduct?.quarantined_pdp_fields);
  const fields = {};
  const reasonCodes = {};
  const sourceStatus = {};
  const sourceOrigin = {};

  for (const key of PDP_FIELD_QUALITY_KEYS) {
    const status = readFieldQualityStatus(fieldQualitySummary, key);
    const valueFromExtractor = quarantinedFieldsFromExtractor[key];
    const fallbackValue = rawFieldValues?.[key];
    const hasFallbackValue =
      Array.isArray(fallbackValue) ? fallbackValue.length > 0 : Boolean(normalizeNonEmptyString(fallbackValue));
    const candidateValue = valueFromExtractor !== undefined ? valueFromExtractor : hasFallbackValue ? fallbackValue : undefined;
    if (candidateValue === undefined) continue;
    if (status !== 'quarantined' && status !== 'low') continue;
    fields[key] = cloneJsonValue(candidateValue);
    if (Array.isArray(fieldQualitySummary?.[key]?.reason_codes) && fieldQualitySummary[key].reason_codes.length > 0) {
      reasonCodes[key] = [...fieldQualitySummary[key].reason_codes];
    }
    if (status) sourceStatus[key] = status;
    if (normalizeNonEmptyString(fieldQualitySummary?.[key]?.source_origin)) {
      sourceOrigin[key] = normalizeNonEmptyString(fieldQualitySummary[key].source_origin);
    }
  }

  if (!Object.keys(fields).length) {
    if (!Object.keys(existingQuarantine).length) return null;
    return existingQuarantine;
  }

  return {
    ...existingQuarantine,
    contract_version: 'external_seed.snapshot_quarantine.v1',
    source: 'catalog_intelligence',
    ...(normalizeNonEmptyString(extractorMode) ? { extractor_mode: normalizeNonEmptyString(extractorMode) } : {}),
    updated_at: new Date().toISOString(),
    fields,
    ...(Object.keys(reasonCodes).length ? { reason_codes_by_field: reasonCodes } : {}),
    ...(Object.keys(sourceStatus).length ? { source_quality_status_by_field: sourceStatus } : {}),
    ...(Object.keys(sourceOrigin).length ? { source_origin_by_field: sourceOrigin } : {}),
  };
}

function countSnapshotQuarantineFields(snapshotQuarantine) {
  const fields = ensureJsonObject(snapshotQuarantine?.fields);
  return Object.keys(fields).length;
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
  let next = normalizePdpCopy(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '');
  if (!next) return '';

  const explicitIngredientHeadings = Array.from(
    next.matchAll(/(?:^|[\n\r])(?:Full\s+)?Ingredients\b\s*:?\s*/gi),
  );
  if (explicitIngredientHeadings.length > 0) {
    const lastHeading = explicitIngredientHeadings[explicitIngredientHeadings.length - 1];
    next = next.slice(lastHeading.index + lastHeading[0].length).trim();
  } else {
    const inlineFullIngredients = next.match(/\bFull Ingredients\b\s*:?\s*/i);
    if (inlineFullIngredients) {
      next = next.slice(inlineFullIngredients.index + inlineFullIngredients[0].length).trim();
    }
  }

  const stopPatterns = [/\bHow to Use\b/i, /\bDirections?\b/i, /\bDetails\b/i, /\bBenefits\b/i, /\bWhat it is\b/i];
  for (const pattern of stopPatterns) {
    const match = next.match(pattern);
    if (match && match.index > 20) next = next.slice(0, match.index).trim();
  }
  const tailStopPatterns = [
    /\bPETA-certified\b/i,
    /\bcruelty-free\b/i,
    /\bThe color and texture\b/i,
    /\bHow to Pair\b/i,
    /\bClinically Proven\b/i,
    /\bConsumer Trial Test\b/i,
    /\bMade for:\b/i,
  ];
  for (const pattern of tailStopPatterns) {
    const match = next.match(pattern);
    if (match && match.index > 20) next = next.slice(0, match.index).trim();
  }

  next = next
    .replace(/\bFull Ingredients\b\s*$/i, '')
    .replace(/\s*:\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
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

function extractFullIngredientsFromText(value) {
  const normalized = normalizePdpCopy(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  if (!normalized) return '';
  const match = normalized.match(/\bFull Ingredients\b\s*:?\s*([\s\S]+)$/i);
  if (!match) return '';
  return cleanPdpIngredientsRaw(match[1]);
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

  const rawSections = Array.isArray(detailsSections) ? detailsSections : [];
  for (const section of rawSections) {
    const extracted = extractFullIngredientsFromText(section?.body || section?.content || section?.text || '');
    if (extracted) return extracted;
  }

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
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const normalizedTargetUrl = normalizeShopifyDuplicateProductUrl(
    targetUrl,
    row?.title,
    row?.name,
    seedData.title,
    snapshot.title,
    snapshot.name,
  );
  const requestBody = {
    brand: deriveCatalogExtractBrand(normalizedTargetUrl, row) || row?.id,
    domain: normalizedTargetUrl,
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

function normalizeRepresentativeProductUrlForSeedTarget(productUrl, targetUrl) {
  const normalizedProductUrl = normalizeUrlLike(productUrl);
  const normalizedTargetUrl = normalizeUrlLike(targetUrl);
  if (!normalizedProductUrl || !normalizedTargetUrl) return normalizedProductUrl;

  try {
    const productParsed = new URL(normalizedProductUrl);
    const targetParsed = new URL(normalizedTargetUrl);
    if (productParsed.hostname.toLowerCase() !== targetParsed.hostname.toLowerCase()) return normalizedProductUrl;

    const productSegments = productParsed.pathname.split('/').filter(Boolean);
    const targetSegments = targetParsed.pathname.split('/').filter(Boolean);
    if (!productSegments[0] || !LOCALE_PATH_SEGMENT_RE.test(productSegments[0])) return normalizedProductUrl;
    if (productSegments[1] !== 'products' && productSegments[1] !== 'product') return normalizedProductUrl;

    if (targetSegments[0] && LOCALE_PATH_SEGMENT_RE.test(targetSegments[0])) {
      productSegments[0] = targetSegments[0];
    } else {
      productSegments.shift();
    }
    productParsed.pathname = `/${productSegments.join('/')}`;
    return productParsed.toString();
  } catch {
    return normalizedProductUrl;
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
  const directProductTarget = looksLikeDirectProductTargetUrl(targetUrl);

  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const rawCandidates = [
    targetUrl,
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    snapshot.canonical_url,
  ].filter(Boolean);
  const referenceValues = [
    row?.title,
    row?.name,
    seedData.title,
    seedData.name,
    seedData.product_title,
    snapshot.title,
    snapshot.name,
    snapshot.product_title,
  ];

  const candidateKeys = new Set(
    rawCandidates
      .map(normalizeUrlKey)
      .filter(Boolean),
  );
  const comparableKeys = expandComparableUrlKeys(rawCandidates, referenceValues);

  for (const product of products) {
    const productKey = normalizeUrlKey(product?.url);
    const comparableProductKey = normalizeComparableUrlKey(product?.url);
    if (directProductTarget && looksLikeKnownNonProductUrl(product?.url)) continue;
    if (candidateKeys.has(productKey) || comparableKeys.has(comparableProductKey)) return product;
  }

  if (directProductTarget) {
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

  if (directProductTarget && products.length === 1) {
    const product = products[0];
    if (isVerifiedShopifyRedirectReplacement(targetUrl, product, row)) return product;
  }

  if (directProductTarget) return null;
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

  if (mapped.length > 0) {
    return mapped.map((variant) => ({
      ...variant,
      ...sanitizeSeedVariantDisplayFields(variant),
    }));
  }
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
    ...(normalizeProductKind(next.product_kind) ? { product_kind: normalizeProductKind(next.product_kind) } : {}),
    ...(Array.isArray(next.bundle_components)
      ? { bundle_components: normalizeBundleComponents(next.bundle_components) }
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
      ...(normalizeProductKind(snapshot.product_kind)
        ? { product_kind: normalizeProductKind(snapshot.product_kind) }
        : {}),
      ...(Array.isArray(snapshot.bundle_components)
        ? { bundle_components: normalizeBundleComponents(snapshot.bundle_components) }
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

function clearStructuredIngredientFieldsForIdentityRepair(seedData) {
  if (!seedData || typeof seedData !== 'object') return;
  const fields = [
    'raw_ingredient_text_clean',
    'inci_list',
    'ingredient_tokens',
    'active_ingredients',
    'activeIngredients',
    'key_ingredients',
    'keyIngredients',
    'ingredient_intel',
  ];
  for (const target of [seedData, seedData.snapshot]) {
    if (!target || typeof target !== 'object') continue;
    for (const field of fields) {
      delete target[field];
    }
  }
}

function deleteLegacyVariantShadowContainers(target) {
  if (!target || typeof target !== 'object') return;
  delete target.skus;
  delete target.variantOptions;
  delete target.variant_options;
  delete target.choices;
  if (target.product && typeof target.product === 'object') {
    delete target.product.variants;
    delete target.product.skus;
    delete target.product.variantOptions;
    delete target.product.variant_options;
    delete target.product.choices;
    if (Object.keys(target.product).length === 0) delete target.product;
  }
}

function cleanupPersistedSeedData(seedData, { clearSyntheticDescription = false, authoritativeSnapshot = false } = {}) {
  if (!seedData || typeof seedData !== 'object') return seedData;
  const snapshot = ensureJsonObject(seedData.snapshot);

  deleteLegacyVariantShadowContainers(seedData);
  deleteLegacyVariantShadowContainers(snapshot);
  delete snapshot.snapshot_quarantine;

  if (authoritativeSnapshot) {
    deleteLegacyExternalSeedPdpShadowFields(seedData);
    deleteLegacyExternalSeedPdpShadowFields(snapshot);
    seedData.external_seed_snapshot_contract = buildExternalSeedSnapshotContract();
    snapshot.external_seed_snapshot_contract = buildExternalSeedSnapshotContract();
  }

  if (clearSyntheticDescription) {
    delete seedData.description;
    delete snapshot.description;
    delete seedData.seed_description_origin;
    delete snapshot.seed_description_origin;
  }

  seedData.snapshot = snapshot;
  return seedData;
}

function formatExtractedSizeDetailValue(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return '';
  const match = normalized.match(/\b(\d+(?:\.\d+)?)\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/i);
  if (!match) return '';
  const amount = normalizeNonEmptyString(match[1]);
  const normalizedUnit = normalizeNonEmptyString(match[2])
    .toLowerCase()
    .replace(/fluid\s*ounces?/g, 'fl oz')
    .replace(/fl\.?\s*oz\.?/g, 'fl oz')
    .replace(/m\s*l/g, 'ml')
    .replace(/\s+/g, ' ')
    .trim();
  if (!amount || !normalizedUnit) return '';
  const displayUnit =
    normalizedUnit === 'ml'
      ? 'mL'
      : normalizedUnit === 'l'
        ? 'L'
        : normalizedUnit;
  return `${amount} ${displayUnit}`.trim();
}

function getExtractedSizeDetailPriority(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (!normalized) return 99;
  if (/\b(?:fl\.?\s*oz|oz|lb|lbs)\b/.test(normalized)) return 1;
  if (/\b(?:ml|m l|g|kg|l|mm|cm)\b/.test(normalized)) return 2;
  return 3;
}

function buildExtractedSizeDetailLabel(...values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const formatted = formatExtractedSizeDetailValue(value);
    if (!formatted) continue;
    const key = formatted.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(formatted);
  }
  if (!unique.length) return '';
  unique.sort((left, right) => getExtractedSizeDetailPriority(left) - getExtractedSizeDetailPriority(right));
  return unique.slice(0, 2).join(' / ');
}

function extractAnchoredQuantitativeSizeValues(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return [];
  const flattened = normalized
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|li|div|ul|ol|section|article|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flattened) return [];

  const segments = [];
  const anchoredRe = /\b(?:net\s*(?:weight|wt|content|contents)|size)\s*[:\-]\s*([^\n\r<]{1,120})/gi;
  let match;
  while ((match = anchoredRe.exec(flattened))) {
    const segment = normalizeNonEmptyString(match[1]);
    if (segment) segments.push(segment);
  }

  const out = [];
  const seen = new Set();
  const quantityRe = /\b(\d+(?:\.\d+)?)\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/gi;
  for (const segment of segments) {
    let quantityMatch;
    while ((quantityMatch = quantityRe.exec(segment))) {
      const formatted = formatExtractedSizeDetailValue(`${quantityMatch[1]} ${quantityMatch[2]}`);
      if (!formatted) continue;
      const key = formatted.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(formatted);
    }
  }
  return out;
}

function splitAnchoredQuantitativeSizeEvidence(...values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    for (const extracted of extractAnchoredQuantitativeSizeValues(value)) {
      const key = extracted.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(extracted);
    }
  }

  if (!unique.length) {
    return { netContent: '', netSize: '' };
  }

  let metric = '';
  let imperial = '';
  for (const value of unique) {
    const normalized = value.toLowerCase();
    if (!metric && /\b(?:ml|m l|g|kg|l|mm|cm)\b/.test(normalized)) {
      metric = value;
      continue;
    }
    if (!imperial && /\b(?:fl\.?\s*oz|oz|lb|lbs)\b/.test(normalized)) {
      imperial = value;
    }
  }

  return {
    netContent: metric || unique[0] || '',
    netSize: imperial || unique.find((item) => item !== (metric || unique[0])) || '',
  };
}

function isPlaceholderSingleSkuValue(value) {
  return /^(?:default(?:\s+title)?|title|single)$/i.test(normalizeNonEmptyString(value));
}

function shouldHydrateDirectPdpSizeEvidence(row, representativeProduct, targetUrl) {
  if (!representativeProduct || typeof representativeProduct !== 'object') return false;
  if (!looksLikeDirectProductTargetUrl(targetUrl)) return false;

  const explicitEvidence = [
    representativeProduct?.volume,
    representativeProduct?.product_volume,
    representativeProduct?.productVolume,
    representativeProduct?.net_content,
    representativeProduct?.netContent,
    representativeProduct?.net_size,
    representativeProduct?.netSize,
    representativeProduct?.size_detail_label,
    representativeProduct?.sizeDetailLabel,
  ]
    .map((item) => normalizeNonEmptyString(item))
    .filter(Boolean);
  if (explicitEvidence.length > 0) return false;

  const representativeVariants = Array.isArray(representativeProduct?.variants)
    ? representativeProduct.variants.filter((variant) => variant && typeof variant === 'object')
    : [];
  const seedVariants = normalizeSeedVariants(ensureJsonObject(row?.seed_data), row);
  const candidateVariant = representativeVariants[0] || seedVariants[0] || null;
  if (!candidateVariant) return false;

  const optionName = normalizeNonEmptyString(candidateVariant?.option_name || candidateVariant?.optionName);
  const optionValue = normalizeNonEmptyString(candidateVariant?.option_value || candidateVariant?.optionValue || candidateVariant?.title);
  if (!optionName && !optionValue) return false;

  return (
    /^(?:option|title)$/i.test(optionName || 'Option') &&
    isPlaceholderSingleSkuValue(optionValue)
  );
}

async function fetchDirectPdpAnchoredSizeEvidence(targetUrl) {
  const normalizedTargetUrl = normalizeUrlLike(targetUrl);
  if (!normalizedTargetUrl) return null;

  let response;
  try {
    response = await axios.get(normalizedTargetUrl, {
      timeout: Number(process.env.EXTERNAL_SEED_BACKFILL_DIRECT_PDP_TIMEOUT_MS || 15000),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Pivota external seed backfill/1.0',
      },
      responseType: 'text',
      validateStatus: () => true,
      maxContentLength: 1024 * 1024 * 2,
    });
  } catch {
    return null;
  }

  const status = Number(response?.status || 0);
  const body = typeof response?.data === 'string' ? response.data : '';
  if (!(status >= 200 && status < 400) || !normalizeNonEmptyString(body)) return null;

  const anchored = splitAnchoredQuantitativeSizeEvidence(body);
  const netContent = normalizeNonEmptyString(anchored.netContent);
  const netSize = normalizeNonEmptyString(anchored.netSize);
  if (!netContent && !netSize) return null;

  return {
    html: body,
    netContent,
    netSize,
    sizeDetailLabel: buildExtractedSizeDetailLabel('', '', '', netContent, netSize),
  };
}

async function maybeHydrateRepresentativeProductSizeEvidence(row, representativeProduct, targetUrl) {
  if (!shouldHydrateDirectPdpSizeEvidence(row, representativeProduct, targetUrl)) return representativeProduct;
  const extracted = await fetchDirectPdpAnchoredSizeEvidence(
    normalizeRepresentativeProductUrlForSeedTarget(representativeProduct?.url, targetUrl) || targetUrl,
  );
  if (!extracted) return representativeProduct;
  return {
    ...representativeProduct,
    ...(extracted.netContent ? { net_content: extracted.netContent } : {}),
    ...(extracted.netSize ? { net_size: extracted.netSize } : {}),
    ...(extracted.sizeDetailLabel ? { size_detail_label: extracted.sizeDetailLabel } : {}),
    pivota_backfill_direct_html: extracted.html,
  };
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
  const representativeProductUrl =
    normalizeRepresentativeProductUrlForSeedTarget(representativeProduct?.url, targetUrl) ||
    normalizeUrlLike(targetUrl) ||
    normalizeUrlLike(row?.canonical_url);
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
  const rawRepresentativeProductImageUrls = collectRawProductImageUrls(representativeProduct);
  const extractedGalleryCandidates = [
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
  ];
  const extractedImageUrls = sanitizeSeedImageUrls(extractedGalleryCandidates, {
    relevanceContext: imageRelevanceContext,
    mode: 'gallery',
  });
  const extractedGalleryContentImageUrls = extractContentLikeSeedImageUrls([
    ...rawRepresentativeProductImageUrls,
    ...(Array.isArray(representativeProduct?.variants)
      ? representativeProduct.variants.flatMap((variant) => collectRawVariantImageUrls(variant))
      : []),
    ...(Array.isArray(response?.variants)
      ? response.variants.flatMap((variant) => collectRawVariantImageUrls(variant))
      : []),
  ]);
  const existingImageUrls = fallbackPollutedRow
    ? []
    : sanitizeSeedImageUrls(collectSeedImageUrls(seedData, row), {
        relevanceContext: imageRelevanceContext,
        mode: 'gallery',
      });
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
  ], { mode: 'gallery' });
  let mergedImageUrls = extractedImageUrls.length > 0 ? extractedImageUrls : existingImageUrls;
  const manualImageOverrideApplied = mergedImageUrls.length === 0 && overrideImageUrls.length > 0;
  if (manualImageOverrideApplied) mergedImageUrls = overrideImageUrls;
  const richestVariantImageUrls = sanitizeSeedImageUrls([
    ...(selectedVariantImageUrls.length > 0 ? selectedVariantImageUrls : []),
    ...(effectiveSnapshotVariants.length === 1 ? effectiveSnapshotVariants[0]?.image_urls || [] : []),
  ], { relevanceContext: imageRelevanceContext, mode: 'gallery' });
  if (richestVariantImageUrls.length > mergedImageUrls.length) {
    mergedImageUrls = sanitizeSeedImageUrls([...richestVariantImageUrls, ...mergedImageUrls], {
      relevanceContext: imageRelevanceContext,
      mode: 'gallery',
    });
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
  const normalizedRepresentativeIngredientsSectionBody = normalizeNonEmptyString(
    pdpDetailsSections.find((section) => section?.heading === 'Ingredients')?.body,
  );
  const normalizedRepresentativeHowToSectionBody = normalizeNonEmptyString(
    pdpDetailsSections.find((section) => section?.heading === 'How to Use')?.body,
  );
  const rawRepresentativePdpDetailsSections = Array.isArray(representativeProduct?.details_sections)
    ? representativeProduct.details_sections
    : Array.isArray(representativeProduct?.pdp_details_sections)
      ? representativeProduct.pdp_details_sections
      : [];
  const productDescriptionRaw = cleanPdpDescriptionCandidate(
    representativeProduct?.description_raw ||
      representativeProduct?.pdp_description_raw,
    pdpDetailsSections,
  );
  const liveExtractedDescription = cleanPdpDescriptionCandidate(rawLiveExtractedDescription, pdpDetailsSections);
  const pdpIngredientsRaw = normalizeNonEmptyString(
    representativeProduct?.ingredients_raw ||
      representativeProduct?.pdp_ingredients_raw ||
      normalizedRepresentativeIngredientsSectionBody,
  );
  const pdpActiveIngredientsRaw = normalizeNonEmptyString(
    representativeProduct?.active_ingredients_raw ||
      representativeProduct?.pdp_active_ingredients_raw,
  );
  const pdpHowToUseRaw = normalizeNonEmptyString(
    representativeProduct?.how_to_use_raw ||
      representativeProduct?.pdp_how_to_use_raw ||
      normalizedRepresentativeHowToSectionBody,
  );
  const pdpFaqItems = normalizeFaqItems(
    representativeProduct?.faq_items ||
      representativeProduct?.pdp_faq_items,
  );
  const extractedContentImageUrls = extractContentLikeSeedImageUrls(
    [
      ...(Array.isArray(representativeProduct?.content_image_urls)
        ? representativeProduct.content_image_urls
        : Array.isArray(representativeProduct?.contentImageUrls)
          ? representativeProduct.contentImageUrls
          : []),
      ...extractedGalleryContentImageUrls,
    ],
    { relevanceContext: imageRelevanceContext },
  );
  const incomingPdpFieldQualitySummary = normalizeFieldQualitySummary(
    representativeProduct?.field_quality_summary ||
      representativeProduct?.pdp_field_quality_summary,
  );
  const existingPdpFieldQualitySummary = normalizeFieldQualitySummary(
    seedData.pdp_field_quality_summary ||
      snapshot.pdp_field_quality_summary,
  );
  const pdpFieldQualitySummary = mergeFieldQualitySummaries(
    existingPdpFieldQualitySummary,
    incomingPdpFieldQualitySummary,
  );
  const existingPdpContentAsset = normalizePdpContentAssetContract(
    seedData.pdp_content_asset_v1 || snapshot.pdp_content_asset_v1,
  );
  const surfaceableProductDescriptionRaw = isSurfaceablePdpField(incomingPdpFieldQualitySummary, 'description_raw')
    ? productDescriptionRaw
    : '';
  const surfaceablePdpDetailsSections = isSurfaceablePdpField(incomingPdpFieldQualitySummary, 'details_sections')
    ? pdpDetailsSections
    : [];
  const surfaceablePdpIngredientsRaw = isSurfaceablePdpField(incomingPdpFieldQualitySummary, 'ingredients_raw')
    ? pdpIngredientsRaw
    : '';
  const surfaceablePdpActiveIngredientsRaw = isSurfaceablePdpField(incomingPdpFieldQualitySummary, 'active_ingredients_raw')
    ? pdpActiveIngredientsRaw
    : '';
  const surfaceablePdpHowToUseRaw = isSurfaceablePdpField(incomingPdpFieldQualitySummary, 'how_to_use_raw')
    ? pdpHowToUseRaw
    : '';
  const surfaceablePdpFaqItems = isSurfaceablePdpField(incomingPdpFieldQualitySummary, 'faq_items')
    ? pdpFaqItems
    : [];
  let snapshotQuarantine = buildSnapshotQuarantine({
    existing: seedData.snapshot_quarantine || snapshot.snapshot_quarantine,
    representativeProduct,
    fieldQualitySummary: incomingPdpFieldQualitySummary,
    extractorMode: response?.mode,
    rawFieldValues: {
      description_raw: productDescriptionRaw,
      details_sections: pdpDetailsSections,
      ingredients_raw: pdpIngredientsRaw,
      active_ingredients_raw: pdpActiveIngredientsRaw,
      how_to_use_raw: pdpHowToUseRaw,
      faq_items: pdpFaqItems,
    },
  });
  const extractedProductKind = normalizeProductKind(
    representativeProduct?.product_kind ||
      representativeProduct?.productKind,
  );
  const existingProductKind = normalizeProductKind(seedData.product_kind || snapshot.product_kind);
  const identityRepairBackfill = isIdentityRepairBackfill(row, seedData, snapshot, targetUrl, representativeProduct);
  const nextProductKind = extractedProductKind || (identityRepairBackfill ? '' : existingProductKind);
  const extractedBundleComponents = normalizeBundleComponents(
    representativeProduct?.bundle_components ||
      representativeProduct?.bundleComponents,
  );
  const existingBundleComponents = normalizeBundleComponents(
    Array.isArray(seedData.bundle_components) && seedData.bundle_components.length > 0
      ? seedData.bundle_components
      : snapshot.bundle_components,
  );
  const nextBundleComponents =
    nextProductKind === 'bundle'
      ? (extractedBundleComponents.length > 0 ? extractedBundleComponents : existingBundleComponents)
      : [];
  const existingPdpDescriptionRaw = cleanPdpDescriptionCandidate(
    identityRepairBackfill || !isSurfaceablePdpField(pdpFieldQualitySummary, 'description_raw')
      ? ''
      : seedData.pdp_description_raw || snapshot.pdp_description_raw,
    pdpDetailsSections,
  );
  const descriptionRawDecision = shouldPreserveExistingPdpContent({
    fieldKey: 'description_raw',
    incomingValue: surfaceableProductDescriptionRaw,
    existingValue: existingPdpDescriptionRaw,
    incomingSummary: incomingPdpFieldQualitySummary,
    existingSummary: existingPdpFieldQualitySummary,
    assetField: existingPdpContentAsset?.fields?.description_raw,
  });
  if (descriptionRawDecision.preserve && hasPdpContentAssetValue('description_raw', surfaceableProductDescriptionRaw)) {
    snapshotQuarantine = appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
      fieldKey: 'description_raw',
      candidateValue: surfaceableProductDescriptionRaw,
      reasonCode: descriptionRawDecision.reason,
      incomingSummary: incomingPdpFieldQualitySummary,
      extractorMode: response?.mode,
    });
  }
  const nextPdpDescriptionRaw =
    descriptionRawDecision.preserve
      ? existingPdpDescriptionRaw
      : (surfaceableProductDescriptionRaw || (descriptionRawDecision.existingApproved ? existingPdpDescriptionRaw : ''));
  const existingPdpDetailsSections = identityRepairBackfill
    ? []
    : !isSurfaceablePdpField(existingPdpFieldQualitySummary, 'details_sections')
      ? []
      : normalizeDetailsSections(
        Array.isArray(seedData.pdp_details_sections) && seedData.pdp_details_sections.length > 0
          ? seedData.pdp_details_sections
          : snapshot.pdp_details_sections,
      );
  const detailsDecision = shouldPreserveExistingPdpContent({
    fieldKey: 'details_sections',
    incomingValue: surfaceablePdpDetailsSections,
    existingValue: existingPdpDetailsSections,
    incomingSummary: incomingPdpFieldQualitySummary,
    existingSummary: existingPdpFieldQualitySummary,
    assetField: existingPdpContentAsset?.fields?.details_sections,
  });
  if (detailsDecision.preserve && hasPdpContentAssetValue('details_sections', surfaceablePdpDetailsSections)) {
    snapshotQuarantine = appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
      fieldKey: 'details_sections',
      candidateValue: surfaceablePdpDetailsSections,
      reasonCode: detailsDecision.reason,
      incomingSummary: incomingPdpFieldQualitySummary,
      extractorMode: response?.mode,
    });
  }
  let nextPdpDetailsSections =
    detailsDecision.preserve
      ? existingPdpDetailsSections
      : surfaceablePdpDetailsSections.length > 0
      ? surfaceablePdpDetailsSections
      : identityRepairBackfill
        ? []
        : !detailsDecision.existingApproved
          ? []
        : existingPdpDetailsSections;
  const hasKnownProductKind = Boolean(nextProductKind);
  const supportsFormulaPdpFields = !hasKnownProductKind || nextProductKind === 'single_formula';
  const supportsHowToUsePdpField = supportsFormulaPdpFields || nextProductKind === 'bundle';
  if (!supportsFormulaPdpFields) {
    nextPdpDetailsSections = nextPdpDetailsSections.filter(
      (section) => !/^(?:Ingredients|Key Ingredients|Active Ingredients)$/i.test(section.heading),
    );
  }
  if (!supportsHowToUsePdpField) {
    nextPdpDetailsSections = nextPdpDetailsSections.filter(
      (section) => !/^How to Use$/i.test(section.heading),
    );
  }
  const existingPdpIngredientsRaw = identityRepairBackfill || !isSurfaceablePdpField(existingPdpFieldQualitySummary, 'ingredients_raw')
    ? ''
    : normalizeNonEmptyString(seedData.pdp_ingredients_raw || snapshot.pdp_ingredients_raw);
  const candidatePdpIngredientsRaw = supportsFormulaPdpFields
    ? pickPdpIngredientsRaw(
        surfaceablePdpIngredientsRaw || normalizedRepresentativeIngredientsSectionBody,
        rawRepresentativePdpDetailsSections.length > 0
          ? rawRepresentativePdpDetailsSections
          : pdpDetailsSections.length > 0
            ? pdpDetailsSections
            : nextPdpDetailsSections,
        '',
      )
    : '';
  const ingredientsDecision = shouldPreserveExistingPdpContent({
    fieldKey: 'ingredients_raw',
    incomingValue: candidatePdpIngredientsRaw,
    existingValue: existingPdpIngredientsRaw,
    incomingSummary: incomingPdpFieldQualitySummary,
    existingSummary: existingPdpFieldQualitySummary,
    assetField: existingPdpContentAsset?.fields?.ingredients_raw,
  });
  if (ingredientsDecision.preserve && hasPdpContentAssetValue('ingredients_raw', candidatePdpIngredientsRaw)) {
    snapshotQuarantine = appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
      fieldKey: 'ingredients_raw',
      candidateValue: candidatePdpIngredientsRaw,
      reasonCode: ingredientsDecision.reason,
      incomingSummary: incomingPdpFieldQualitySummary,
      extractorMode: response?.mode,
    });
  }
  const nextPdpIngredientsRaw = supportsFormulaPdpFields
    ? (ingredientsDecision.preserve
      ? existingPdpIngredientsRaw
      : pickPdpIngredientsRaw(
          candidatePdpIngredientsRaw,
          rawRepresentativePdpDetailsSections.length > 0
            ? rawRepresentativePdpDetailsSections
            : pdpDetailsSections.length > 0
              ? pdpDetailsSections
              : nextPdpDetailsSections,
          ingredientsDecision.existingApproved ? existingPdpIngredientsRaw : '',
        ))
    : '';
  const existingPdpActiveIngredientsRaw = identityRepairBackfill || !isSurfaceablePdpField(existingPdpFieldQualitySummary, 'active_ingredients_raw')
    ? ''
    : normalizeNonEmptyString(seedData.pdp_active_ingredients_raw || snapshot.pdp_active_ingredients_raw);
  const candidatePdpActiveIngredientsRaw = supportsFormulaPdpFields
    ? cleanPdpActiveIngredientsRaw(surfaceablePdpActiveIngredientsRaw)
    : '';
  const activeIngredientsDecision = shouldPreserveExistingPdpContent({
    fieldKey: 'active_ingredients_raw',
    incomingValue: candidatePdpActiveIngredientsRaw,
    existingValue: existingPdpActiveIngredientsRaw,
    incomingSummary: incomingPdpFieldQualitySummary,
    existingSummary: existingPdpFieldQualitySummary,
    assetField: existingPdpContentAsset?.fields?.active_ingredients_raw,
  });
  if (activeIngredientsDecision.preserve && hasPdpContentAssetValue('active_ingredients_raw', candidatePdpActiveIngredientsRaw)) {
    snapshotQuarantine = appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
      fieldKey: 'active_ingredients_raw',
      candidateValue: candidatePdpActiveIngredientsRaw,
      reasonCode: activeIngredientsDecision.reason,
      incomingSummary: incomingPdpFieldQualitySummary,
      extractorMode: response?.mode,
    });
  }
  const nextPdpActiveIngredientsRaw = supportsFormulaPdpFields
    ? cleanPdpActiveIngredientsRaw(
        activeIngredientsDecision.preserve
          ? existingPdpActiveIngredientsRaw
          : (candidatePdpActiveIngredientsRaw || (activeIngredientsDecision.existingApproved ? existingPdpActiveIngredientsRaw : '')),
      )
    : '';
  const pdpHowToUseContext = [
    representativeProduct?.title,
    seedData.title,
    snapshot.title,
    row?.title,
    representativeProduct?.category,
    seedData.category,
    snapshot.category,
    surfaceableProductDescriptionRaw,
    nextPdpActiveIngredientsRaw,
  ].join(' ');
  const existingPdpHowToUseRaw = identityRepairBackfill || !isSurfaceablePdpField(existingPdpFieldQualitySummary, 'how_to_use_raw')
    ? ''
    : normalizeNonEmptyString(seedData.pdp_how_to_use_raw || snapshot.pdp_how_to_use_raw);
  const candidatePdpHowToUseRaw = supportsHowToUsePdpField
    ? pickPdpHowToUseRaw(
        surfaceablePdpHowToUseRaw || normalizedRepresentativeHowToSectionBody,
        pdpDetailsSections.length > 0 ? pdpDetailsSections : nextPdpDetailsSections,
        '',
        pdpHowToUseContext,
      )
    : '';
  const howToDecision = shouldPreserveExistingPdpContent({
    fieldKey: 'how_to_use_raw',
    incomingValue: candidatePdpHowToUseRaw,
    existingValue: existingPdpHowToUseRaw,
    incomingSummary: incomingPdpFieldQualitySummary,
    existingSummary: existingPdpFieldQualitySummary,
    assetField: existingPdpContentAsset?.fields?.how_to_use_raw,
  });
  if (howToDecision.preserve && hasPdpContentAssetValue('how_to_use_raw', candidatePdpHowToUseRaw)) {
    snapshotQuarantine = appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
      fieldKey: 'how_to_use_raw',
      candidateValue: candidatePdpHowToUseRaw,
      reasonCode: howToDecision.reason,
      incomingSummary: incomingPdpFieldQualitySummary,
      extractorMode: response?.mode,
    });
  }
  const nextPdpHowToUseRaw = supportsHowToUsePdpField
    ? pickPdpHowToUseRaw(
        howToDecision.preserve ? '' : candidatePdpHowToUseRaw,
        nextPdpDetailsSections,
        howToDecision.existingApproved ? existingPdpHowToUseRaw : '',
        pdpHowToUseContext,
      )
    : '';
  nextPdpDetailsSections = filterDuplicateHowToSections(nextPdpDetailsSections, nextPdpHowToUseRaw);
  const existingPdpFaqItems = identityRepairBackfill
    ? []
    : !isSurfaceablePdpField(existingPdpFieldQualitySummary, 'faq_items')
      ? []
      : normalizeFaqItems(
        Array.isArray(seedData.pdp_faq_items) && seedData.pdp_faq_items.length > 0
          ? seedData.pdp_faq_items
          : snapshot.pdp_faq_items,
      );
  const faqDecision = shouldPreserveExistingPdpContent({
    fieldKey: 'faq_items',
    incomingValue: surfaceablePdpFaqItems,
    existingValue: existingPdpFaqItems,
    incomingSummary: incomingPdpFieldQualitySummary,
    existingSummary: existingPdpFieldQualitySummary,
    assetField: existingPdpContentAsset?.fields?.faq_items,
  });
  if (faqDecision.preserve && hasPdpContentAssetValue('faq_items', surfaceablePdpFaqItems)) {
    snapshotQuarantine = appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
      fieldKey: 'faq_items',
      candidateValue: surfaceablePdpFaqItems,
      reasonCode: faqDecision.reason,
      incomingSummary: incomingPdpFieldQualitySummary,
      extractorMode: response?.mode,
    });
  }
  const nextPdpFaqItems =
    faqDecision.preserve
      ? existingPdpFaqItems
      : surfaceablePdpFaqItems.length > 0
      ? surfaceablePdpFaqItems
      : identityRepairBackfill
        ? []
        : !faqDecision.existingApproved
          ? []
        : existingPdpFaqItems;
  const existingContentImageUrls = identityRepairBackfill
    ? []
    : extractContentLikeSeedImageUrls(
        Array.isArray(seedData.content_image_urls) && seedData.content_image_urls.length > 0
          ? seedData.content_image_urls
          : snapshot.content_image_urls,
        { relevanceContext: imageRelevanceContext },
      );
  const nextContentImageUrls =
    extractedContentImageUrls.length > 0
      ? extractedContentImageUrls
      : identityRepairBackfill
        ? []
        : existingContentImageUrls;
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
    if (surfaceableProductDescriptionRaw) return 'pdp_product_description';
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
  const clearSyntheticLegacyDescription =
    !manualDescription &&
    !liveExtractedDescription &&
    !surfaceableProductDescriptionRaw &&
    (
      nextDescriptionOrigin === 'synthetic_summary' ||
      looksLikeSyntheticSummaryText(fallbackSeedDescription) ||
      looksLikeSyntheticSummaryText(seedData.description) ||
      looksLikeSyntheticSummaryText(snapshot.description)
    );
  const displayDescriptionDecision = shouldPreserveExistingPdpContent({
    fieldKey: 'description',
    incomingValue: normalizeNonEmptyString(liveExtractedDescription || nextPdpDescriptionRaw || surfaceableProductDescriptionRaw),
    existingValue: clearSyntheticLegacyDescription ? '' : fallbackSeedDescription,
    incomingSummary: incomingPdpFieldQualitySummary,
    existingSummary: existingPdpFieldQualitySummary,
    assetField: existingPdpContentAsset?.fields?.description,
  });
  if (displayDescriptionDecision.preserve && hasPdpContentAssetValue('description', normalizeNonEmptyString(liveExtractedDescription || nextPdpDescriptionRaw || surfaceableProductDescriptionRaw))) {
    snapshotQuarantine = appendPreservedContentCandidateToSnapshotQuarantine(snapshotQuarantine, {
      fieldKey: 'description',
      candidateValue: normalizeNonEmptyString(liveExtractedDescription || nextPdpDescriptionRaw || surfaceableProductDescriptionRaw),
      reasonCode: displayDescriptionDecision.reason,
      incomingSummary: incomingPdpFieldQualitySummary,
      extractorMode: response?.mode,
    });
  }
  const description = manualDescription ||
    (
      clearSyntheticLegacyDescription
        ? ''
        : normalizeNonEmptyString(
            (
              displayDescriptionDecision.preserve
                ? fallbackSeedDescription
                : (liveExtractedDescription || nextPdpDescriptionRaw || surfaceableProductDescriptionRaw)
            ) ||
              (!suppressStaleDescriptionFallback && displayDescriptionDecision.existingApproved
                ? fallbackSeedDescription
                : ''),
          )
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
  const crossProductBackfillBlock = buildCrossProductBackfillBlock(
    row,
    seedData,
    snapshot,
    targetUrl,
    representativeProduct,
    representativeProductUrl,
  );
  if (crossProductBackfillBlock) {
    const blockedSnapshot = {
      ...snapshot,
      diagnostics: {
        ...ensureJsonObject(snapshot.diagnostics),
        catalog_backfill_blocked: crossProductBackfillBlock,
      },
    };
    const blockedSeedData = {
      ...seedData,
      snapshot: blockedSnapshot,
    };
    const nextRow = {
      title: normalizeNonEmptyString(row?.title),
      canonical_url: normalizeNonEmptyString(row?.canonical_url),
      destination_url: normalizeNonEmptyString(row?.destination_url),
      image_url: normalizeNonEmptyString(row?.image_url),
      price_amount: typeof row?.price_amount === 'number' ? row.price_amount : parsePrice(row?.price_amount),
      price_currency: normalizeNonEmptyString(row?.price_currency),
      availability: normalizeNonEmptyString(row?.availability),
      seed_data: blockedSeedData,
    };
    return {
      changed: JSON.stringify(comparableSeedData(row?.seed_data)) !== JSON.stringify(comparableSeedData(blockedSeedData)),
      nextRow,
      representativeProduct,
      snapshot: blockedSnapshot,
      blocked: crossProductBackfillBlock,
    };
  }

  const nextPdpContentAsset = buildNextPdpContentAssetContract({
    existing: existingPdpContentAsset,
    fieldValues: {
      description,
      description_raw: nextPdpDescriptionRaw,
      details_sections: nextPdpDetailsSections,
      ingredients_raw: nextPdpIngredientsRaw,
      active_ingredients_raw: nextPdpActiveIngredientsRaw,
      how_to_use_raw: nextPdpHowToUseRaw,
      faq_items: nextPdpFaqItems,
    },
    fieldQualitySummary: pdpFieldQualitySummary,
  });
  const nextReviewSummary = normalizeSeedReviewSummary(
    representativeProduct?.review_summary,
    representativeProduct?.reviewSummary,
    representativeProduct?.reviews_summary,
    representativeProduct?.reviewsSummary,
    seedData.review_summary,
    seedData.reviewSummary,
    snapshot.review_summary,
    snapshot.reviewSummary,
    seedData.reviews_summary,
    snapshot.reviews_summary,
  );
  const extractedVolume = normalizeNonEmptyString(
    representativeProduct?.volume ||
      (
        normalizeNonEmptyString(selectedSnapshotVariant?.option_name).toLowerCase() === 'size'
          ? selectedSnapshotVariant?.option_value
          : ''
      ),
  );
  const extractedProductVolume = normalizeNonEmptyString(
    representativeProduct?.product_volume || representativeProduct?.productVolume,
  );
  const anchoredSizeEvidence = splitAnchoredQuantitativeSizeEvidence(
    representativeProduct?.pivota_backfill_direct_html,
    representativeProduct?.description,
    representativeProduct?.description_html,
    nextPdpDescriptionRaw,
    nextPdpHowToUseRaw,
    ...nextPdpDetailsSections.map((section) => section?.body),
  );
  const extractedNetContent = normalizeNonEmptyString(
    representativeProduct?.net_content ||
      representativeProduct?.netContent ||
      anchoredSizeEvidence.netContent,
  );
  const extractedNetSize = normalizeNonEmptyString(
    representativeProduct?.net_size ||
      representativeProduct?.netSize ||
      anchoredSizeEvidence.netSize,
  );
  const representativeProductVariant = Array.isArray(representativeProduct?.variants)
    ? representativeProduct.variants.find((variant) => variant && typeof variant === 'object') || representativeProduct.variants[0]
    : null;
  const extractedSizeDetailLabel = normalizeNonEmptyString(
    representativeProduct?.size_detail_label ||
      representativeProduct?.sizeDetailLabel ||
      buildExtractedSizeDetailLabel(
        representativeProduct?.product_volume,
        representativeProduct?.productVolume,
        representativeProduct?.volume,
        representativeProduct?.net_content,
        representativeProduct?.netContent,
        representativeProduct?.net_size,
        representativeProduct?.netSize,
        anchoredSizeEvidence.netContent,
        anchoredSizeEvidence.netSize,
        representativeProductVariant?.option_value,
        representativeProductVariant?.title,
        selectedSnapshotVariant?.option_value,
        selectedSnapshotVariant?.title,
      ),
  );
  const existingVolume = normalizeNonEmptyString(seedData.volume || snapshot.volume);
  const existingProductVolume = normalizeNonEmptyString(seedData.product_volume || snapshot.product_volume);
  const existingNetContent = normalizeNonEmptyString(seedData.net_content || snapshot.net_content);
  const existingNetSize = normalizeNonEmptyString(seedData.net_size || snapshot.net_size);
  const existingSizeDetailLabel = normalizeNonEmptyString(seedData.size_detail_label || snapshot.size_detail_label);
  const nextVolume = extractedVolume || (identityRepairBackfill ? '' : existingVolume);
  const nextProductVolume = extractedProductVolume || (identityRepairBackfill ? '' : existingProductVolume);
  const nextNetContent = extractedNetContent || (identityRepairBackfill ? '' : existingNetContent);
  const nextNetSize = extractedNetSize || (identityRepairBackfill ? '' : existingNetSize);
  const nextSizeDetailLabel = extractedSizeDetailLabel || (identityRepairBackfill ? '' : existingSizeDetailLabel);

  const nextSnapshot = {
    ...snapshot,
    source: 'catalog_intelligence',
    extracted_at: new Date().toISOString(),
    canonical_url: representativeProductUrl || normalizeUrlLike(snapshot.canonical_url) || normalizeUrlLike(targetUrl),
    title,
    description: clearSyntheticLegacyDescription
      ? ''
      : manualDescription || liveExtractedDescription || surfaceableProductDescriptionRaw
        ? liveExtractedDescription ||
          surfaceableProductDescriptionRaw ||
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
    ...(nextContentImageUrls.length > 0 ? { content_image_urls: nextContentImageUrls } : {}),
    ...(selectedVariantId ? { selected_variant_id: selectedVariantId, default_variant_id: selectedVariantId } : {}),
    ...(selectedVariantTitle && !isDefaultVariantTitle(selectedVariantTitle) ? { variant_title: selectedVariantTitle } : {}),
    ...(nextProductKind ? { product_kind: nextProductKind } : {}),
    ...(nextBundleComponents.length > 0 ? { bundle_components: nextBundleComponents } : {}),
    ...(nextVolume ? { volume: nextVolume } : {}),
    ...(nextProductVolume ? { product_volume: nextProductVolume } : {}),
    ...(nextNetContent ? { net_content: nextNetContent } : {}),
    ...(nextNetSize ? { net_size: nextNetSize } : {}),
    ...(nextSizeDetailLabel ? { size_detail_label: nextSizeDetailLabel } : {}),
    ...(nextDescriptionOrigin ? { seed_description_origin: nextDescriptionOrigin } : {}),
    ...(pdpFieldCaptureStatus ? { pdp_field_capture_status: pdpFieldCaptureStatus } : {}),
    ...(pdpFieldQualitySummary ? { pdp_field_quality_summary: pdpFieldQualitySummary } : {}),
    ...(nextReviewSummary ? { review_summary: nextReviewSummary } : {}),
    pdp_content_asset_v1: nextPdpContentAsset || undefined,
    ...(snapshotQuarantine ? { snapshot_quarantine: snapshotQuarantine } : {}),
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
  if (!nextVolume) delete nextSnapshot.volume;
  if (!nextProductVolume) delete nextSnapshot.product_volume;
  if (!nextNetContent) delete nextSnapshot.net_content;
  if (!nextNetSize) delete nextSnapshot.net_size;
  if (!nextSizeDetailLabel) delete nextSnapshot.size_detail_label;

  let nextSeedData = {
    ...seedData,
    title,
    ...(description ? { description } : {}),
    ...(nextPdpDescriptionRaw ? { pdp_description_raw: nextPdpDescriptionRaw } : {}),
    ...(nextPdpDetailsSections.length > 0 ? { pdp_details_sections: nextPdpDetailsSections } : {}),
    ...(nextPdpIngredientsRaw ? { pdp_ingredients_raw: nextPdpIngredientsRaw } : {}),
    ...(nextPdpActiveIngredientsRaw ? { pdp_active_ingredients_raw: nextPdpActiveIngredientsRaw } : {}),
    ...(nextPdpHowToUseRaw ? { pdp_how_to_use_raw: nextPdpHowToUseRaw } : {}),
    ...(nextPdpFaqItems.length > 0 ? { pdp_faq_items: nextPdpFaqItems } : {}),
    ...(nextContentImageUrls.length > 0 ? { content_image_urls: nextContentImageUrls } : {}),
    ...(selectedVariantId ? { selected_variant_id: selectedVariantId, default_variant_id: selectedVariantId } : {}),
    ...(selectedVariantTitle && !isDefaultVariantTitle(selectedVariantTitle) ? { variant_title: selectedVariantTitle } : {}),
    ...(nextProductKind ? { product_kind: nextProductKind } : {}),
    ...(nextBundleComponents.length > 0 ? { bundle_components: nextBundleComponents } : {}),
    ...(nextVolume ? { volume: nextVolume } : {}),
    ...(nextProductVolume ? { product_volume: nextProductVolume } : {}),
    ...(nextNetContent ? { net_content: nextNetContent } : {}),
    ...(nextNetSize ? { net_size: nextNetSize } : {}),
    ...(nextSizeDetailLabel ? { size_detail_label: nextSizeDetailLabel } : {}),
    ...(nextDescriptionOrigin ? { seed_description_origin: nextDescriptionOrigin } : {}),
    ...(pdpFieldCaptureStatus ? { pdp_field_capture_status: pdpFieldCaptureStatus } : {}),
    ...(pdpFieldQualitySummary ? { pdp_field_quality_summary: pdpFieldQualitySummary } : {}),
    ...(nextReviewSummary ? { review_summary: nextReviewSummary } : {}),
    pdp_content_asset_v1: nextPdpContentAsset || undefined,
    ...(snapshotQuarantine ? { snapshot_quarantine: snapshotQuarantine } : {}),
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
  if (!nextVolume) {
    delete nextSeedData.volume;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.volume;
  }
  if (!nextProductVolume) {
    delete nextSeedData.product_volume;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.product_volume;
  }
  if (!nextNetContent) {
    delete nextSeedData.net_content;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.net_content;
  }
  if (!nextNetSize) {
    delete nextSeedData.net_size;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.net_size;
  }
  if (!nextSizeDetailLabel) {
    delete nextSeedData.size_detail_label;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.size_detail_label;
  }
  if (!nextPdpHowToUseRaw) {
    delete nextSeedData.pdp_how_to_use_raw;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_how_to_use_raw;
  }
  if (nextProductKind !== 'bundle') {
    delete nextSeedData.bundle_components;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.bundle_components;
  }
  if (!nextPdpDescriptionRaw) {
    delete nextSeedData.pdp_description_raw;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_description_raw;
  }
  if (nextPdpDetailsSections.length === 0) {
    delete nextSeedData.pdp_details_sections;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_details_sections;
  }
  if (nextPdpFaqItems.length === 0) {
    delete nextSeedData.pdp_faq_items;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.pdp_faq_items;
  }
  if (nextContentImageUrls.length === 0) {
    delete nextSeedData.content_image_urls;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.content_image_urls;
  }
  if (!nextProductKind) {
    delete nextSeedData.product_kind;
    if (nextSeedData.snapshot && typeof nextSeedData.snapshot === 'object') delete nextSeedData.snapshot.product_kind;
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
  if (identityRepairBackfill) {
    clearStructuredIngredientFieldsForIdentityRepair(nextSeedData);
  }
  if (shouldClearStaleSeedActiveIngredients(nextSeedData, nextPdpActiveIngredientsRaw)) {
    delete nextSeedData.active_ingredients;
    delete nextSeedData.activeIngredients;
    delete nextSeedData.snapshot.active_ingredients;
    delete nextSeedData.snapshot.activeIngredients;
  }
  const authoritativeSnapshot =
    Boolean(nextPdpDescriptionRaw) ||
    nextPdpDetailsSections.length > 0 ||
    Boolean(nextPdpIngredientsRaw) ||
    Boolean(nextPdpActiveIngredientsRaw) ||
    Boolean(nextPdpHowToUseRaw) ||
    nextPdpFaqItems.length > 0;
  cleanupPersistedSeedData(nextSeedData, {
    clearSyntheticDescription: clearSyntheticLegacyDescription,
    authoritativeSnapshot,
  });
  nextSeedData = applyLocalityFactsToSeedData(
    nextSeedData,
    resolveExternalSeedLocalityFacts({
      row: {
        ...row,
        title,
        canonical_url: representativeProductUrl || row?.canonical_url,
        destination_url: destinationUrl || row?.destination_url,
        price_currency: currency,
        price_amount: priceAmount,
        availability,
      },
      seedData: nextSeedData,
      snapshot: ensureJsonObject(nextSeedData.snapshot),
    }),
  );
  const nextDerived = ensureJsonObject(nextSeedData.derived);
  nextSeedData.derived = {
    ...nextDerived,
    recall: buildExternalSeedRecallDoc({
      row: { ...row, ...row, title, description, canonical_url: representativeProductUrl || row?.canonical_url, destination_url: destinationUrl || row?.destination_url },
      seedData: nextSeedData,
      snapshot: ensureJsonObject(nextSeedData.snapshot),
    }),
  };
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

const TITLE_IDENTITY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'by',
  'for',
  'from',
  'in',
  'of',
  'off',
  'on',
  'plus',
  'the',
  'to',
  'with',
]);

function titleIdentityTokens(value) {
  return uniqueStrings(
    normalizeNonEmptyString(value)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !TITLE_IDENTITY_STOPWORDS.has(token)),
  );
}

function titleIdentityOverlapRatio(left, right) {
  const leftTokens = titleIdentityTokens(left);
  const rightTokens = titleIdentityTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token)).length;
  return shared / Math.min(leftTokens.length, rightTokens.length);
}

function normalizeTitleIdentityKey(value) {
  return titleIdentityTokens(value).join(' ');
}

function looksLikeCrossProductTitleDrift(existingTitle, extractedTitle) {
  const existing = normalizeNonEmptyString(existingTitle);
  const extracted = normalizeNonEmptyString(extractedTitle);
  if (!existing || !extracted) return false;
  const existingKey = normalizeTitleIdentityKey(existing);
  const extractedKey = normalizeTitleIdentityKey(extracted);
  if (!existingKey || !extractedKey || existingKey === extractedKey) return false;
  if (existingKey.includes(extractedKey) || extractedKey.includes(existingKey)) return false;
  return titleIdentityOverlapRatio(existing, extracted) < 0.35;
}

function buildCrossProductBackfillBlock(row, seedData, snapshot, targetUrl, representativeProduct, representativeProductUrl) {
  const extractedTitle = normalizeNonEmptyString(representativeProduct?.title);
  if (!extractedTitle) return null;
  const rowTitle = normalizeNonEmptyString(row?.title);
  const rowUrlKey = normalizeComparableUrlKey(row?.canonical_url || row?.destination_url);
  const extractedUrlKey = normalizeComparableUrlKey(representativeProductUrl || representativeProduct?.url);
  const rowTitleAligned =
    !rowTitle || !looksLikeCrossProductTitleDrift(rowTitle, extractedTitle);
  const rowUrlAligned =
    !rowUrlKey || !extractedUrlKey || rowUrlKey === extractedUrlKey;
  if (rowTitleAligned && rowUrlAligned) return null;
  const existingTitle =
    normalizeNonEmptyString(seedData?.title) ||
    normalizeNonEmptyString(snapshot?.title) ||
    normalizeNonEmptyString(row?.title);
  if (!looksLikeCrossProductTitleDrift(existingTitle, extractedTitle)) return null;
  return {
    reason: 'cross_product_title_drift',
    existing_title: existingTitle,
    extracted_title: extractedTitle,
    row_title: normalizeNonEmptyString(row?.title),
    target_url: normalizeUrlLike(targetUrl),
    extracted_url: normalizeUrlLike(representativeProductUrl || representativeProduct?.url),
    overlap_ratio: Number(titleIdentityOverlapRatio(existingTitle, extractedTitle).toFixed(3)),
  };
}

function isIdentityRepairBackfill(row, seedData, snapshot, targetUrl, representativeProduct) {
  const targetKey = normalizeComparableUrlKey(targetUrl);
  const storedUrlKeys = uniqueStrings([
    row?.canonical_url,
    row?.destination_url,
    seedData?.canonical_url,
    seedData?.destination_url,
    snapshot?.canonical_url,
    snapshot?.destination_url,
  ].map(normalizeComparableUrlKey).filter(Boolean));
  const targetRepointsStoredUrl = Boolean(targetKey && storedUrlKeys.length > 0 && !storedUrlKeys.includes(targetKey));
  const rowTitle = normalizeNonEmptyString(row?.title);
  const preservedTitle =
    normalizeNonEmptyString(seedData?.title) ||
    normalizeNonEmptyString(snapshot?.title);
  const extractedTitle = normalizeNonEmptyString(representativeProduct?.title);
  return (
    targetRepointsStoredUrl ||
    looksLikeCrossProductTitleDrift(rowTitle, preservedTitle) ||
    looksLikeCrossProductTitleDrift(rowTitle, extractedTitle)
  );
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
      stringifyPostgresJsonb(payload.product),
      stringifyPostgresJsonb(ensureJsonObject(payload.product.review_summary)),
      sanitizeTextForPostgres(
        normalizeUrlLike(payload.product.canonical_url || payload.product.url || payload.product.destination_url),
      ),
    ],
  );
  return {
    matched_rows: Number(result?.rowCount || 0),
    refreshed: Number(result?.rowCount || 0) > 0,
    source_listing_ref: payload.source_listing_ref,
  };
}

async function maybePersistPreservedImageHealth(row, targetUrl, options, reason, extraPayload = {}) {
  if (!options.validateImageHealth) return null;
  const validationResult = await validateNextRowImageHealth({
    ...row,
    seed_data: ensureJsonObject(row?.seed_data),
  });
  const validation = validationResult.validation || {};
  if (validation.skipped || validation.status === 'failed_no_valid_images') return null;
  const nextRow = validationResult.nextRow || row;
  const changed =
    normalizeNonEmptyString(row?.image_url) !== normalizeNonEmptyString(nextRow?.image_url) ||
    JSON.stringify(comparableSeedData(row?.seed_data)) !== JSON.stringify(comparableSeedData(nextRow?.seed_data)) ||
    (
      hasNestedVariantImageSanitizationDelta(row?.seed_data) &&
      !hasNestedVariantImageSanitizationDelta(nextRow?.seed_data)
    );
  if (!changed) return null;

  let identityListingRefresh = null;
  if (!options.dryRun) {
    await query(
      `
        UPDATE external_product_seeds
        SET
          image_url = CASE WHEN $2 <> '' THEN $2 ELSE image_url END,
          seed_data = $3::jsonb,
          updated_at = now()
        WHERE id = $1
      `,
      [
        row.id,
        sanitizeTextForPostgres(nextRow.image_url),
        stringifyPostgresJsonb(nextRow.seed_data),
      ],
    );
    await withClient(async (client) => {
      identityListingRefresh = await refreshPdpIdentityListingSourcePayload(client, row, nextRow);
    });
  }

  return {
    status: options.dryRun ? 'dry_run' : 'updated',
    reason,
    row,
    targetUrl,
    payload: {
      ...extraPayload,
      nextRow,
      image_health_validation: validation,
      identity_listing_refresh: identityListingRefresh,
      preserved_image_health_only: true,
      variant_seed_rows: [],
    },
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
        sanitizeTextForPostgres(row.market),
        sanitizeTextForPostgres(row.tool),
        sanitizeTextForPostgres(row.destination_url),
        sanitizeTextForPostgres(row.canonical_url),
        sanitizeTextForPostgres(row.domain),
        sanitizeTextForPostgres(row.title),
        sanitizeTextForPostgres(row.image_url),
        row.price_amount,
        sanitizeTextForPostgres(row.price_currency),
        sanitizeTextForPostgres(row.availability),
        sanitizeTextForPostgres(row.status),
        sanitizeTextForPostgres(row.notes),
        sanitizeTextForPostgres(row.created_by_employee_id),
        sanitizeTextForPostgres(row.attached_product_key),
        sanitizeTextForPostgres(row.attached_variant_id),
        stringifyPostgresJsonb(row.seed_data),
        sanitizeTextForPostgres(row.utm_template),
        sanitizeTextForPostgres(row.partner_type),
        sanitizeTextForPostgres(row.disclosure_text),
        sanitizeTextForPostgres(row.external_product_id),
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

function buildMinimalFailureSeedData(row, targetUrl, error) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const imageUrls = sanitizeSeedImageUrls(collectSeedImageUrls(seedData, row));
  const normalizedTargetUrl = normalizeUrlLike(targetUrl);
  const variants = normalizeSeedVariants(seedData, row);
  return {
    brand: sanitizeTextForPostgres(seedData.brand || snapshot.brand || row?.brand || ''),
    title: sanitizeTextForPostgres(seedData.title || snapshot.title || row?.title || ''),
    canonical_url:
      normalizedTargetUrl ||
      normalizeUrlLike(seedData.canonical_url) ||
      normalizeUrlLike(snapshot.canonical_url) ||
      normalizeUrlLike(row?.canonical_url),
    destination_url:
      normalizedTargetUrl ||
      normalizeUrlLike(seedData.destination_url) ||
      normalizeUrlLike(snapshot.destination_url) ||
      normalizeUrlLike(row?.destination_url),
    image_url: imageUrls[0] || sanitizeTextForPostgres(row?.image_url || ''),
    image_urls: imageUrls,
    images: imageUrls,
    snapshot: {
      source: 'catalog_intelligence',
      extracted_at: new Date().toISOString(),
      canonical_url:
        normalizedTargetUrl ||
        normalizeUrlLike(snapshot.canonical_url) ||
        normalizeUrlLike(row?.canonical_url),
      diagnostics: {
        failure_category: 'unknown',
        error: sanitizeTextForPostgres(error?.message || error || 'unknown_error'),
      },
      image_url: imageUrls[0] || sanitizeTextForPostgres(row?.image_url || ''),
      image_urls: imageUrls,
      images: imageUrls,
      variants,
    },
  };
}

async function persistFailureSeedData(row, candidates = []) {
  let lastError = null;
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
    if (!candidate || typeof candidate !== 'object') continue;
    try {
      await query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb, updated_at = now()
          WHERE id = $1
        `,
        [row.id, stringifyPostgresJsonb(candidate)],
      );
      return { persisted: true };
    } catch (error) {
      lastError = error;
      if (String(error?.code || '').trim() !== '22021') {
        throw error;
      }
    }
  }
  if (lastError) throw lastError;
  return { persisted: false };
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

async function extractSeedCommerceFacts(targetUrl, row, baseUrl) {
  const requestBody = {
    ...buildExtractRequestBody(targetUrl, row),
    limit: 10,
  };
  const response = await axios.post(`${baseUrl.replace(/\/$/, '')}/api/extract-v2`, requestBody, {
    timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data || {};
}

function collectSeedVariantMatchKeys(variant) {
  return uniqueStrings(
    [
      variant?.sku,
      variant?.variant_sku,
      variant?.id,
      variant?.variant_id,
    ]
      .map((item) => normalizeNonEmptyString(item).toLowerCase())
      .filter(Boolean),
  );
}

function collectPrimaryVariantSkuKeys(seedData, snapshot, row, nextRow) {
  const variants = normalizeSeedVariants(seedData, row);
  if (!variants.length) return new Set();

  const selectedVariantId = normalizeNonEmptyString(
    seedData.selected_variant_id ||
    snapshot.selected_variant_id ||
    seedData.default_variant_id ||
    snapshot.default_variant_id,
  ).toLowerCase();
  const topLevelPriceAmount = parsePrice(
    nextRow?.price_amount ??
    row?.price_amount ??
    seedData.price_amount ??
    snapshot.price_amount,
  );

  const selectedVariants = variants.filter((variant) => {
    const variantId = normalizeNonEmptyString(variant?.id || variant?.variant_id).toLowerCase();
    return Boolean(selectedVariantId && variantId && variantId === selectedVariantId);
  });
  if (selectedVariants.length) {
    return new Set(selectedVariants.flatMap((variant) => collectSeedVariantMatchKeys(variant)));
  }

  const priceMatchedVariants = variants.filter((variant) => {
    const variantPrice = parsePrice(variant?.price);
    return topLevelPriceAmount != null && variantPrice != null && topLevelPriceAmount === variantPrice;
  });
  if (priceMatchedVariants.length) {
    return new Set(priceMatchedVariants.flatMap((variant) => collectSeedVariantMatchKeys(variant)));
  }

  return new Set(collectSeedVariantMatchKeys(variants[0]));
}

function scoreCommerceFactsOfferCandidate({
  candidate,
  targetUrlKeys,
  titleKey,
  variantSkus,
  primaryVariantSkus,
  topLevelPriceAmount,
}) {
  if (!candidate || typeof candidate !== 'object') return Number.NEGATIVE_INFINITY;
  const offerUrlKey = normalizeComparableUrlKey(candidate?.url_canonical);
  const offerTitleKey = normalizeTitleKey(candidate?.product_title);
  const offerSku = normalizeNonEmptyString(candidate?.variant_sku).toLowerCase();
  const offerAmount = parsePrice(candidate?.commerce_facts_v1?.regional_price?.amount);

  let score = 0;

  if (offerUrlKey && targetUrlKeys.has(offerUrlKey)) score += 100;
  if (titleKey && offerTitleKey === titleKey) {
    score += 40;
  } else if (titleKey && offerTitleKey) {
    score -= 100;
  }

  if (offerSku && primaryVariantSkus.has(offerSku)) {
    score += 60;
  } else if (offerSku && variantSkus.has(offerSku)) {
    score += 15;
  }

  if (topLevelPriceAmount != null && offerAmount != null && topLevelPriceAmount === offerAmount) {
    score += 30;
  }

  return score;
}

function findCommerceFactsOfferForBackfill(row, nextRow, responseV2 = {}) {
  const offers = Array.isArray(responseV2?.offers_v2) ? responseV2.offers_v2 : [];
  if (!offers.length) return null;
  const seedData = ensureJsonObject(nextRow?.seed_data || row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const targetUrlKeys = expandComparableUrlKeys(
    [
      nextRow?.canonical_url,
      nextRow?.destination_url,
      row?.canonical_url,
      row?.destination_url,
      seedData.canonical_url,
      seedData.destination_url,
      snapshot.canonical_url,
      snapshot.destination_url,
    ],
    [
      nextRow?.title,
      row?.title,
      seedData.title,
      snapshot.title,
    ],
  );
  const titleKey = normalizeTitleKey(nextRow?.title || row?.title || seedData.title || snapshot.title);
  const variantSkus = new Set(
    normalizeSeedVariants(seedData, row)
      .flatMap((variant) => collectSeedVariantMatchKeys(variant))
      .filter(Boolean),
  );
  const primaryVariantSkus = collectPrimaryVariantSkuKeys(seedData, snapshot, row, nextRow);
  const topLevelPriceAmount = parsePrice(
    nextRow?.price_amount ??
    row?.price_amount ??
    seedData.price_amount ??
    snapshot.price_amount,
  );

  let bestOffer = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of offers) {
    const score = scoreCommerceFactsOfferCandidate({
      candidate,
      targetUrlKeys,
      titleKey,
      variantSkus,
      primaryVariantSkus,
      topLevelPriceAmount,
    });
    if (score > bestScore) {
      bestScore = score;
      bestOffer = candidate;
    }
  }

  return bestScore > 0 ? bestOffer : null;
}

function findCommerceFactsForBackfill(row, nextRow, responseV2 = {}) {
  const offer = findCommerceFactsOfferForBackfill(row, nextRow, responseV2);
  return offer?.commerce_facts_v1 || null;
}

function applyOfferCommerceFactsToVariants(nextRow, responseV2 = {}) {
  const offers = Array.isArray(responseV2?.offers_v2) ? responseV2.offers_v2 : [];
  if (!offers.length || !nextRow || typeof nextRow !== 'object') return nextRow;

  const seedData = ensureJsonObject(nextRow.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const parentUrlKeys = expandComparableUrlKeys(
    [nextRow.canonical_url, nextRow.destination_url, seedData.canonical_url, seedData.destination_url, snapshot.canonical_url, snapshot.destination_url],
    [nextRow.title, seedData.title, snapshot.title],
  );
  const titleKey = normalizeTitleKey(nextRow.title || seedData.title || snapshot.title);

  const patchVariantList = (variants) => {
    if (!Array.isArray(variants) || !variants.length) return variants;
    return variants.map((variant) => {
      const variantSkuKeys = collectSeedVariantMatchKeys(variant);
      if (!variantSkuKeys.length) return variant;
      const currentPriceAmount = parsePrice(variant?.price);
      let bestOffer = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const offer of offers) {
        const offerSku = normalizeNonEmptyString(offer?.variant_sku).toLowerCase();
        if (!offerSku || !variantSkuKeys.includes(offerSku)) continue;
        let score = 0;
        const offerUrlKey = normalizeComparableUrlKey(offer?.url_canonical);
        if (offerUrlKey && parentUrlKeys.has(offerUrlKey)) score += 80;
        const offerTitleKey = normalizeTitleKey(offer?.product_title);
        if (titleKey && offerTitleKey === titleKey) score += 30;
        const offerAmount = parsePrice(offer?.commerce_facts_v1?.regional_price?.amount);
        if (currentPriceAmount != null && offerAmount != null && currentPriceAmount === offerAmount) score += 40;
        if (score > bestScore) {
          bestScore = score;
          bestOffer = offer;
        }
      }
      const facts = bestOffer?.commerce_facts_v1;
      const regionalPrice = ensureJsonObject(facts?.regional_price);
      const availability = ensureJsonObject(facts?.availability);
      if (!facts || bestScore <= 0) return variant;
      const patched = { ...cloneJsonValue(variant) };
      if (regionalPrice.amount != null) {
        patched.price = normalizeNonEmptyString(regionalPrice.display_raw) || String(regionalPrice.amount);
      }
      if (normalizeNonEmptyString(regionalPrice.currency)) {
        patched.currency = normalizeNonEmptyString(regionalPrice.currency).toUpperCase();
      }
      if (normalizeNonEmptyString(availability.status) === 'in_stock') patched.stock = 'In Stock';
      if (normalizeNonEmptyString(availability.status) === 'out_of_stock') patched.stock = 'Out of Stock';
      return patched;
    });
  };

  const patchedSeedVariants = patchVariantList(Array.isArray(seedData.variants) ? seedData.variants : []);
  const patchedSnapshotVariants = patchVariantList(Array.isArray(snapshot.variants) ? snapshot.variants : []);

  return {
    ...nextRow,
    seed_data: {
      ...seedData,
      ...(patchedSeedVariants.length ? { variants: patchedSeedVariants } : {}),
      snapshot: {
        ...snapshot,
        ...(patchedSnapshotVariants.length ? { variants: patchedSnapshotVariants } : {}),
      },
    },
  };
}

function applyMatchedCommerceFactsToTopLevel(nextRow, matchedOffer) {
  const facts = matchedOffer?.commerce_facts_v1;
  const regionalPrice = ensureJsonObject(facts?.regional_price);
  const availability = ensureJsonObject(facts?.availability);
  if (!facts || regionalPrice.amount == null) return nextRow;
  const seedData = ensureJsonObject(nextRow?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const nextAvailability = normalizeNonEmptyString(availability.status || nextRow?.availability || seedData.availability);
  return {
    ...nextRow,
    price_amount: regionalPrice.amount,
    price_currency: normalizeNonEmptyString(regionalPrice.currency).toUpperCase() || nextRow?.price_currency,
    availability: nextAvailability || nextRow?.availability,
    seed_data: {
      ...seedData,
      price_amount: regionalPrice.amount,
      price_currency: normalizeNonEmptyString(regionalPrice.currency).toUpperCase() || seedData.price_currency,
      ...(nextAvailability ? { availability: nextAvailability } : {}),
      snapshot: {
        ...snapshot,
        price_amount: regionalPrice.amount,
        price_currency: normalizeNonEmptyString(regionalPrice.currency).toUpperCase() || snapshot.price_currency,
        ...(nextAvailability ? { availability: nextAvailability } : {}),
      },
    },
  };
}

function attachCommerceFactsGateToRow(nextRow, gate) {
  const seedData = ensureJsonObject(nextRow?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return {
    ...nextRow,
    seed_data: {
      ...seedData,
      commerce_facts_gate: gate,
      snapshot: {
        ...snapshot,
        commerce_facts_gate: gate,
      },
    },
  };
}

function enrichPayloadWithCommerceFacts({ row, payload, responseV2, market }) {
  const nextRow = payload?.nextRow && typeof payload.nextRow === 'object' ? payload.nextRow : {};
  const matchedOffer = findCommerceFactsOfferForBackfill(row, nextRow, responseV2);
  const rawFacts = matchedOffer?.commerce_facts_v1 || null;
  const patchedTopLevel = applyMatchedCommerceFactsToTopLevel(nextRow, matchedOffer);
  const patchedVariants = applyOfferCommerceFactsToVariants(patchedTopLevel, responseV2);
  const withFacts = attachCommerceFactsToSeedRow(patchedVariants, rawFacts, { market: market || row?.market });
  const gate = validateCommerceFactsGateForSeedRow(withFacts);
  const gatedRow = attachCommerceFactsGateToRow(withFacts, gate);
  return {
    ...payload,
    nextRow: gatedRow,
    commerce_facts_v2: {
      requested: Boolean(responseV2),
      matched: Boolean(rawFacts),
      gate,
      counters_by_site_market: Array.isArray(responseV2?.counters_by_site_market)
        ? responseV2.counters_by_site_market
        : [],
    },
    changed:
      payload.changed ||
      JSON.stringify(comparableSeedData(payload.nextRow?.seed_data)) !== JSON.stringify(comparableSeedData(gatedRow.seed_data)),
  };
}

async function processRow(row, options) {
  const targetUrl = normalizeTargetUrlForMarket(
    resolveTargetUrlOverride(row, options?.targetUrlOverrides) || pickSeedTargetUrl(row),
    row?.market,
  );
  if (!targetUrl) {
    return { status: 'skipped', reason: 'missing_target_url', row };
  }

  try {
    const response = await extractSeed(targetUrl, row, options.baseUrl);
    const responseV2 = options.includeCommerceFacts
      ? await extractSeedCommerceFacts(targetUrl, row, options.baseUrl)
      : null;
    const products = Array.isArray(response?.products) ? response.products : [];
    let representativeProduct = chooseRepresentativeProduct(response, targetUrl, row);
    if (looksLikeDirectProductTargetUrl(targetUrl) && products.length === 0) {
      const preservedImageHealth = await maybePersistPreservedImageHealth(
        row,
        targetUrl,
        options,
        'preserved_image_health_catalog_empty_direct_pdp',
        { diagnostics: response?.diagnostics || null },
      );
      if (preservedImageHealth) return preservedImageHealth;
      return {
        status: 'skipped',
        reason: 'catalog_empty_direct_pdp',
        row,
        targetUrl,
        payload: {
          diagnostics: response?.diagnostics || null,
        },
      };
    }
    if (looksLikeDirectProductTargetUrl(targetUrl) && products.length > 0 && !representativeProduct) {
      const candidateProductUrls = products
        .map((product) => normalizeUrlLike(product?.url))
        .filter(Boolean)
        .slice(0, 10);
      const preservedImageHealth = await maybePersistPreservedImageHealth(
        row,
        targetUrl,
        options,
        'preserved_image_health_representative_product_not_found',
        {
          diagnostics: response?.diagnostics || null,
          candidate_product_urls: candidateProductUrls,
        },
      );
      if (preservedImageHealth) return preservedImageHealth;
      return {
        status: 'skipped',
        reason: 'representative_product_not_found',
        row,
        targetUrl,
        payload: {
          diagnostics: response?.diagnostics || null,
          candidate_product_urls: candidateProductUrls,
        },
      };
    }
    representativeProduct = await maybeHydrateRepresentativeProductSizeEvidence(row, representativeProduct, targetUrl);
    if (representativeProduct && Array.isArray(response?.products)) {
      const matchedIndex = response.products.findIndex((product) => product === chooseRepresentativeProduct(response, targetUrl, row));
      if (matchedIndex >= 0) response.products[matchedIndex] = representativeProduct;
    }
    let payload = buildSeedUpdatePayload(row, response, targetUrl);
    if (options.includeCommerceFacts) {
      payload = enrichPayloadWithCommerceFacts({
        row,
        payload,
        responseV2,
        market: options.market,
      });
    }
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
        JSON.stringify(comparableSeedData(enrichedNextRow.seed_data)) ||
      (
        hasNestedVariantImageSanitizationDelta(row?.seed_data) &&
        !hasNestedVariantImageSanitizationDelta(enrichedNextRow.seed_data)
      );
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
            sanitizeTextForPostgres(enrichedPayload.nextRow.title),
            sanitizeTextForPostgres(enrichedPayload.nextRow.canonical_url),
            sanitizeTextForPostgres(enrichedPayload.nextRow.destination_url),
            sanitizeTextForPostgres(enrichedPayload.nextRow.image_url),
            enrichedPayload.nextRow.price_amount,
            sanitizeTextForPostgres(enrichedPayload.nextRow.price_currency),
            sanitizeTextForPostgres(enrichedPayload.nextRow.availability),
            stringifyPostgresJsonb(enrichedPayload.nextRow.seed_data),
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
    const minimalFailureSeedData = buildMinimalFailureSeedData(row, targetUrl, error);
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
      await persistFailureSeedData(row, [persistedSeedData, minimalFailureSeedData]);
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

function ensureDirectory(dirPath) {
  const normalized = normalizeNonEmptyString(dirPath);
  if (!normalized) return '';
  fs.mkdirSync(normalized, { recursive: true });
  return normalized;
}

function safeReportFileStem(value, fallback = 'row') {
  const normalized = normalizeNonEmptyString(value).replace(/[^a-z0-9._-]+/gi, '-');
  return normalized || fallback;
}

function serializeBackfillResult(result) {
  const row = result?.row && typeof result.row === 'object' ? result.row : {};
  const payload = result?.payload && typeof result.payload === 'object' ? result.payload : {};
  const nextRow = payload?.nextRow && typeof payload.nextRow === 'object' ? payload.nextRow : null;
  const seedData = ensureJsonObject(nextRow?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const contentImageUrls = sanitizeSeedImageUrls(
    Array.isArray(seedData.content_image_urls) && seedData.content_image_urls.length > 0
      ? seedData.content_image_urls
      : snapshot.content_image_urls,
    { mode: 'content' },
  );
  const sectionMediaCount = normalizeDetailsSections(
    Array.isArray(seedData.pdp_details_sections) && seedData.pdp_details_sections.length > 0
      ? seedData.pdp_details_sections
      : snapshot.pdp_details_sections,
  ).reduce((sum, section) => sum + sanitizeSeedImageUrls(section?.media_urls, { mode: 'content' }).length, 0);
  return {
    status: normalizeNonEmptyString(result?.status),
    reason: normalizeNonEmptyString(result?.reason),
    target_url: normalizeUrlLike(result?.targetUrl),
    row: {
      id: normalizeNonEmptyString(row?.id),
      external_product_id: normalizeNonEmptyString(row?.external_product_id),
      title: normalizeNonEmptyString(row?.title),
      brand: normalizeNonEmptyString(row?.brand),
      domain: normalizeNonEmptyString(row?.domain),
      canonical_url: normalizeUrlLike(row?.canonical_url),
      destination_url: normalizeUrlLike(row?.destination_url),
      seed_snapshot_contract: ensureJsonObject(ensureJsonObject(row?.seed_data).external_seed_snapshot_contract),
    },
    payload: {
      changed: Boolean(payload?.changed),
      next_row: nextRow,
      next_row_summary: nextRow
        ? {
            external_product_id: normalizeNonEmptyString(nextRow?.external_product_id),
            title: normalizeNonEmptyString(nextRow?.title),
            canonical_url: normalizeUrlLike(nextRow?.canonical_url),
            destination_url: normalizeUrlLike(nextRow?.destination_url),
            image_url: normalizeUrlLike(nextRow?.image_url),
            image_count: collectSeedImageUrls(seedData).length,
            variant_count: normalizeSeedVariants(seedData.variants).length,
            details_section_count: Array.isArray(seedData.pdp_details_sections) ? seedData.pdp_details_sections.length : 0,
            faq_count: Array.isArray(seedData.pdp_faq_items) ? seedData.pdp_faq_items.length : 0,
            how_to_use_present: Boolean(normalizeNonEmptyString(seedData.pdp_how_to_use_raw)),
            ingredients_present: Boolean(normalizeNonEmptyString(seedData.pdp_ingredients_raw)),
            active_ingredients_present: Boolean(normalizeNonEmptyString(seedData.pdp_active_ingredients_raw)),
            seed_snapshot_contract: ensureJsonObject(seedData.external_seed_snapshot_contract),
            content_image_count: contentImageUrls.length,
            section_media_count: sectionMediaCount,
          }
        : null,
      variant_seed_rows: Array.isArray(payload?.variant_seed_rows) ? payload.variant_seed_rows : [],
      identity_listing_refresh: payload?.identity_listing_refresh || null,
      image_health_validation: payload?.image_health_validation || null,
      diagnostics: payload?.diagnostics || null,
      commerce_facts_v2: payload?.commerce_facts_v2 || null,
    },
    error: result?.error
      ? {
          message: normalizeNonEmptyString(result.error?.message || result.error),
          stack: normalizeNonEmptyString(result.error?.stack),
        }
      : null,
  };
}

function writeBackfillReport({ outDir, options, rows, summary, results, insightsCoverage }) {
  const reportDir = ensureDirectory(outDir);
  if (!reportDir) return null;

  const serializedResults = Array.isArray(results) ? results.map((result) => serializeBackfillResult(result)) : [];
  const metadata = {
    generated_at: new Date().toISOString(),
    options: {
      market: normalizeNonEmptyString(options?.market),
      dry_run: Boolean(options?.dryRun),
      include_commerce_facts: Boolean(options?.includeCommerceFacts),
      skip_insights: Boolean(options?.skipInsights),
      expand_variants: Boolean(options?.expandVariants),
      limit: Number(options?.limit || 0),
      offset: Number(options?.offset || 0),
      concurrency: Number(options?.concurrency || 0),
      external_product_ids: Array.isArray(options?.externalProductIds) ? options.externalProductIds : [],
      external_product_id: normalizeNonEmptyString(options?.externalProductId),
      seed_id: normalizeNonEmptyString(options?.seedId),
      domain: normalizeNonEmptyString(options?.domain),
      brand: normalizeNonEmptyString(options?.brand),
    },
    rows_fetched: Array.isArray(rows) ? rows.length : 0,
  };

  fs.writeFileSync(
    path.join(reportDir, 'backfill-summary.json'),
    JSON.stringify(
      {
        ...metadata,
        summary,
        pivota_insights: insightsCoverage,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(reportDir, 'backfill-results.json'), JSON.stringify(serializedResults, null, 2));

  const rowsDir = ensureDirectory(path.join(reportDir, 'rows'));
  for (const result of serializedResults) {
    const stem = safeReportFileStem(
      result?.row?.external_product_id || result?.row?.id || result?.target_url,
      'row',
    );
    fs.writeFileSync(path.join(rowsDir, `${stem}.json`), JSON.stringify(result, null, 2));
  }

  return {
    out_dir: reportDir,
    result_count: serializedResults.length,
  };
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
        SELECT kb_key, analysis, source_meta
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
        .filter((row) => isDisplayableProductIntelKbRow(row))
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

function isDisplayableProductIntelKbRow(row) {
  const analysis = ensureJsonObject(row?.analysis);
  const bundle = ensureJsonObject(analysis.product_intel_v1 || analysis.product_intel);
  if (!bundle || !Object.keys(bundle).length) return false;

  const sourceMeta = ensureJsonObject(row?.source_meta);
  const metaReview = deriveReviewContractFromSourceMeta(sourceMeta);
  if (metaReview.approved === true) return true;

  const provenanceReview = deriveReviewContractFromSourceMeta(bundle.provenance);
  if (provenanceReview.approved === true) return true;

  const qualityState = normalizeNonEmptyString(
    bundle.quality_state ||
      bundle.qualityState ||
      bundle.product_intel_core?.quality_state ||
      sourceMeta.quality_state,
  ).toLowerCase();
  const evidenceProfile = normalizeNonEmptyString(
    bundle.evidence_profile ||
      bundle.evidenceProfile ||
      bundle.product_intel_core?.evidence_profile ||
      sourceMeta.evidence_profile,
  ).toLowerCase();
  return qualityState === 'verified' && evidenceProfile === 'pivota_reviewed';
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
  const targetUrlOverrides = readTargetUrlOverridesFile(
    argValue('target-url-overrides-file') ||
      argValue('targetUrlOverridesFile') ||
      argValue('target-url-overrides') ||
      argValue('targetUrlOverrides') ||
      '',
  );
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
    includeCommerceFacts: hasFlag('include-commerce-facts') || hasFlag('includeCommerceFacts'),
    skipInsights: hasFlag('skip-insights') || hasFlag('skipInsights'),
    insightsOutDir: argValue('insights-out-dir') || argValue('insightsOutDir') || '',
    insightsSkipGemini: hasFlag('insights-skip-gemini') || hasFlag('insightsSkipGemini'),
    outDir: argValue('out-dir') || argValue('outDir') || '',
    targetUrlOverrides,
    validateImageHealth:
      !(hasFlag('dry-run') || hasFlag('dryRun')) &&
      !hasFlag('skip-image-health-validation') &&
      !hasFlag('skipImageHealthValidation'),
    baseUrl: DEFAULT_CATALOG_BASE_URL,
  };

  const rows = await fetchRows(options);
  const printableOptions = {
    ...options,
    targetUrlOverrides: undefined,
    targetUrlOverridesCount: Object.keys(targetUrlOverrides).length,
  };
  delete printableOptions.targetUrlOverrides;
  console.log(JSON.stringify({ rows: rows.length, ...printableOptions }, null, 2));

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
    commerce_facts_hold: results.filter((result) => result.payload?.commerce_facts_v2?.gate?.status === 'hold').length,
  };
  console.log(JSON.stringify(summary, null, 2));

  const insightsCoverage = await preparePivotaInsightsForBackfill(results, options);
  console.log(JSON.stringify({ pivota_insights: insightsCoverage }, null, 2));
  const report = writeBackfillReport({
    outDir: options.outDir,
    options,
    rows,
    summary,
    results,
    insightsCoverage,
  });
  if (report?.out_dir) {
    console.log(JSON.stringify({ report }, null, 2));
  }
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
  readTargetUrlOverridesFile,
  resolveTargetUrlOverride,
  buildExtractRequestBody,
  extractSeedCommerceFacts,
  findCommerceFactsOfferForBackfill,
  findCommerceFactsForBackfill,
  enrichPayloadWithCommerceFacts,
  chooseRepresentativeProduct,
  buildSeedUpdatePayload,
  buildVariantSeedRows,
  buildFailureSeedData,
  comparableSeedData,
  normalizeComparableUrlKey,
  normalizeTargetUrlForMarket,
  recoverTargetUrlFromDiagnostics,
  sanitizeSeedImageUrls,
  sanitizeJsonForPostgres,
  sanitizeTextForPostgres,
  stringifyPostgresJsonb,
  validateNextRowImageHealth,
  hasNestedVariantImageSanitizationDelta,
  buildIdentityListingSourcePayload,
  collectBackfilledExternalProductIds,
  filterProductIdsMissingPivotaInsights,
  isDisplayableProductIntelKbRow,
  cleanPdpIngredientsRaw,
  pickPdpIngredientsRaw,
  preparePivotaInsightsForBackfill,
  runPivotaInsightsCoverageForProductIds,
  serializeBackfillResult,
  writeBackfillReport,
};
