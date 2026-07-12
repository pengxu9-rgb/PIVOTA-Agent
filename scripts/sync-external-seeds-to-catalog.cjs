#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, getPool, query, withClient } = require('../src/db');
const { upsertCatalogRowTrustMany } = require('../src/services/catalogRowTrustUpserter');
const {
  buildAgentSafeCommerceFacts,
  readCommerceFactsV1,
  validateCommerceFactsGateForSeedRow,
} = require('../src/commerce/commerceFacts');
const { classifyExternalSeedProductKind } = require('../src/services/externalSeedProductKind');
const { deriveOfferSellerIdentity } = require('../src/services/offerSellerIdentity');
// Fix Plan D · T1 — ONE shared, URL-free content_key fallback across both mirrors.
const { contentKeyFallback } = require('../src/services/retailerOfferIdentity');

const MERCHANT_ID = 'external_seed';
const PLATFORM = 'external_seed';
const SOURCE_SYSTEM = 'external_product_seeds_mirror_v1';
const CONFIRM_TOKEN = 'SYNC_REVIEWED_EXTERNAL_SEEDS_TO_CATALOG';
const NO_STRONG_IDENTIFIER = 'no_strong_identifier';
const MPN_CAPTURED_AS_BARCODE = 'mpn_captured_as_barcode';
const VALID_DIGIT_IDENTIFIER_LENGTHS = new Set([8, 12, 13, 14]);
const PLACEHOLDER_IDENTIFIER_VALUES = new Set(['n/a', 'na', 'none', 'null', 'unknown', 'not available', '0', '-']);
const STRONG_IDENTIFIER_PRIORITY = [
  ['gtin', ['gtin', 'gtins', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'gtin_8', 'gtin_12', 'gtin_13', 'gtin_14']],
  ['upc', ['upc', 'upcs', 'upca', 'upc_a', 'upc12', 'upc_12']],
  ['ean', ['ean', 'eans', 'ean8', 'ean13', 'ean_8', 'ean_13']],
  ['barcode', ['barcode', 'bar_code', 'barcodes']],
  ['mpn', ['mpn', 'manufacturer_part_number', 'manufacturerPartNumber', 'model_number', 'modelNumber']],
];

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value == null ? '' : value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readDelimitedIds(value) {
  return Array.from(
    new Set(
      asString(value)
        .split(/[\s,]+/g)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function readIdsFile(filePath) {
  const target = asString(filePath);
  if (!target) return [];
  const resolved = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
  return readDelimitedIds(fs.readFileSync(resolved, 'utf8'));
}

function resolveOutPath(filePath) {
  const target = asString(filePath);
  return target ? (path.isAbsolute(target) ? target : path.join(process.cwd(), target)) : '';
}

function writeJsonFile(filePath, payload) {
  const resolved = resolveOutPath(filePath);
  if (!resolved) return '';
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function normalizeBatchSize(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(1, Math.min(500, Math.floor(numeric)));
}

function chunkArray(items, size) {
  if (!items.length) return [];
  if (!size || items.length <= size) return [items];
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function stableHash(prefix, parts, length = 32) {
  const hash = crypto
    .createHash('sha256')
    .update(parts.map(asString).join('\n'))
    .digest('hex')
    .slice(0, length);
  return `${prefix}_${hash}`;
}

function normalizeText(value) {
  return asString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeVariantAxisKey(value) {
  const normalized = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  if (normalized === 'colour') return 'color';
  if (['shades', 'tone', 'tones', 'hue', 'undertone', 'skin_undertone'].includes(normalized)) return 'shade';
  if (['capacity', 'amount', 'weight', 'net_weight'].includes(normalized)) return 'volume';
  if (['count', 'quantity', 'ct'].includes(normalized)) return 'pack';
  if (['formula_variant', 'variant_formula', 'formula_type'].includes(normalized)) return 'formula';
  return normalized;
}

function displayLabelForVariantAxis(optionName, axisKind) {
  const normalized = normalizeVariantAxisKey(axisKind || optionName);
  if (normalized === 'shade') return 'Shade';
  if (normalized === 'color') return 'Color';
  if (normalized === 'size' || normalized === 'volume') return 'Size';
  if (normalized === 'pack') return 'Pack';
  if (normalized === 'format') return 'Format';
  if (normalized === 'formula') return 'Formula';
  if (normalized === 'scent') return 'Scent';
  if (normalized === 'strength') return 'Strength';
  return asString(optionName || axisKind || 'Option') || 'Option';
}

function isDisplayableVariantOptionValue(value) {
  const normalized = asString(value).toLowerCase();
  return Boolean(normalized && !['default', 'default title', 'title', 'option', 'variant'].includes(normalized));
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = asString(value).replace(/[^0-9.-]+/g, '');
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCurrency(value) {
  const currency = asString(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

function normalizeAvailability(value) {
  const normalized = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['available', 'instock', 'true'].includes(normalized)) return 'in_stock';
  if (['outofstock', 'soldout', 'unavailable', 'false'].includes(normalized)) return 'out_of_stock';
  return normalized || 'unknown';
}

function normalizeDigitIdentifier(value) {
  const digits = asString(value).replace(/\D+/g, '');
  if (!VALID_DIGIT_IDENTIFIER_LENGTHS.has(digits.length)) return '';
  if (/^0+$/.test(digits)) return '';
  return digits;
}

function normalizeMpn(value) {
  const text = asString(value);
  if (!text || PLACEHOLDER_IDENTIFIER_VALUES.has(text.toLowerCase())) return '';
  return text;
}

function normalizeStrongIdentifier(value, kind) {
  const normalizedKind = asString(kind).toLowerCase();
  const normalized =
    normalizedKind === 'mpn' ? normalizeMpn(value) : normalizeDigitIdentifier(value);
  return normalized ? { value: normalized, kind: normalizedKind } : null;
}

function* candidateIdentifierValues(source, keys) {
  if (!source || typeof source !== 'object') return;
  const lowered = new Map(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    if (!lowered.has(key.toLowerCase())) continue;
    const value = lowered.get(key.toLowerCase());
    if (Array.isArray(value)) {
      for (const item of value) yield item;
    } else {
      yield value;
    }
  }
  for (const nestedKey of [
    'raw',
    'snapshot',
    'variant',
    'product',
    'metadata',
    'platform_metadata',
    'catalog_meta',
    'catalogmeta',
    'commerce_facts_v1',
    'strong_identity',
    'raw_variant',
    'raw_product',
  ]) {
    const nested = lowered.get(nestedKey.toLowerCase());
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      yield* candidateIdentifierValues(nested, keys);
    }
  }
}

function pickStrongIdentifier(...sources) {
  for (const [kind, keys] of STRONG_IDENTIFIER_PRIORITY) {
    for (const source of sources) {
      for (const value of candidateIdentifierValues(source, keys)) {
        const identifier = normalizeStrongIdentifier(value, kind);
        if (identifier) return identifier;
      }
    }
  }
  return null;
}

function normalizeUrl(value) {
  const raw = asString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractHostname(value) {
  const url = normalizeUrl(value);
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pickSeedData(row) {
  return asObject(row.seed_data);
}

function pickSnapshot(row) {
  return asObject(pickSeedData(row).snapshot);
}

function readTerminalHoldContract(value) {
  const contract = asObject(value);
  const contractVersion = asString(contract.contract_version || contract.contractVersion).toLowerCase();
  const status = asString(contract.status).toLowerCase();
  const reason = asString(contract.reason || asArray(contract.reason_codes)[0] || status || contractVersion);
  if (contractVersion === 'external_seed.source_unavailable.v1' || status === 'source_unavailable') {
    return { held: true, blockerCode: 'source_unavailable', reason: reason || 'source_unavailable' };
  }
  if (
    contractVersion === 'external_seed.content_evidence_hold.v1' ||
    status === 'hold_for_evidence' ||
    status === 'content_evidence_hold'
  ) {
    return { held: true, blockerCode: 'content_evidence_hold', reason: reason || 'content_evidence_hold' };
  }
  if (
    contractVersion === 'external_seed.transaction_readiness_blocker.v1' &&
    (contract.transaction_ready === false || contract.transactionReady === false)
  ) {
    return { held: true, blockerCode: 'transaction_blocked', reason: reason || 'transaction_readiness_blocker' };
  }
  if (
    contractVersion === 'external_seed.non_merch_terminal_hold.v1' ||
    [
      'non_merch_terminal_hold',
      'sample_terminal_hold',
      'terminal_hold',
      'transaction_blocked',
    ].includes(status)
  ) {
    return { held: true, blockerCode: 'non_core_product', reason: reason || status || 'terminal_hold' };
  }
  return { held: false, blockerCode: '', reason: '' };
}

function seedTerminalHoldStatus(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  const family = asString(
    row?.product_family ||
      row?.external_seed_product_family ||
      seedData.product_family ||
      seedData.external_seed_product_family ||
      snapshot.product_family ||
      snapshot.external_seed_product_family,
  ).toLowerCase();
  if (family === 'non_merch' || family === 'non_merchandise') {
    return { held: true, blockerCode: 'non_core_product', reason: 'non_merch_product_family' };
  }
  const contracts = [
    seedData.source_unavailable_v1,
    snapshot.source_unavailable_v1,
    seedData.non_merch_terminal_hold_v1,
    snapshot.non_merch_terminal_hold_v1,
    seedData.content_evidence_hold_v1,
    snapshot.content_evidence_hold_v1,
    seedData.transaction_readiness_blocker_v1,
    snapshot.transaction_readiness_blocker_v1,
  ];
  for (const contract of contracts) {
    const status = readTerminalHoldContract(contract);
    if (status.held) return status;
  }
  return { held: false, blockerCode: '', reason: '' };
}

function pickBrand(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return (
    asString(seedData.brand?.name) ||
    asString(seedData.brand) ||
    asString(snapshot.brand?.name) ||
    asString(snapshot.brand) ||
    asString(seedData.vendor) ||
    asString(snapshot.vendor)
  );
}

function pickDescription(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return asString(
    seedData.pdp_description ||
      seedData.description ||
      seedData.pdp_description_raw ||
      snapshot.pdp_description ||
      snapshot.description ||
      snapshot.pdp_description_raw,
  );
}

function pickCanonicalUrl(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return (
    normalizeUrl(row.canonical_url) ||
    normalizeUrl(row.destination_url) ||
    normalizeUrl(seedData.canonical_url) ||
    normalizeUrl(seedData.product_url) ||
    normalizeUrl(seedData.source_url) ||
    normalizeUrl(seedData.destination_url) ||
    normalizeUrl(snapshot.canonical_url) ||
    normalizeUrl(snapshot.product_url) ||
    normalizeUrl(snapshot.source_url) ||
    normalizeUrl(snapshot.destination_url)
  );
}

function pickImageUrl(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return (
    normalizeUrl(row.image_url) ||
    normalizeUrl(seedData.image_url) ||
    normalizeUrl(snapshot.image_url) ||
    normalizeUrl(asArray(seedData.image_urls)[0]) ||
    normalizeUrl(asArray(snapshot.image_urls)[0]) ||
    normalizeUrl(asArray(seedData.images)[0]) ||
    normalizeUrl(asArray(snapshot.images)[0])
  );
}

function pickImageUrls(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return Array.from(
    new Set(
      [
        pickImageUrl(row),
        ...asArray(seedData.image_urls),
        ...asArray(seedData.images),
        ...asArray(snapshot.image_urls),
        ...asArray(snapshot.images),
      ]
        .map(normalizeUrl)
        .filter(Boolean),
    ),
  );
}

function titleCategoryText(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return [
    row.title,
    row.domain,
    seedData.title,
    seedData.category,
    seedData.leaf_category,
    seedData.product_type,
    seedData.category_path,
    seedData.description,
    snapshot.title,
    snapshot.category,
    snapshot.leaf_category,
    snapshot.product_type,
    snapshot.category_path,
    snapshot.description,
  ]
    .map(asString)
    .join(' ')
    .toLowerCase();
}

function normalizeCategoryToken(value) {
  return asString(value)
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCategoryPath(value) {
  const raw = Array.isArray(value) ? value.join('/') : asString(value);
  return raw
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/>/g, '/')
    .replace(/[_\s]+/g, '-')
    .replace(/-*\/-*/g, '/')
    .replace(/[^a-z0-9/-]+/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function titleizeCategory(value) {
  return (
    asString(value)
      .replace(/[_/-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Beauty Product'
  );
}

function explicitCategoryShape(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  const categoryPath = normalizeCategoryPath(
    seedData.catalog_category_path ||
      snapshot.catalog_category_path ||
      seedData.category_path ||
      snapshot.category_path,
  );
  if (!categoryPath || categoryPath.split('/').length < 3) return null;
  const productType = asString(
    seedData.product_type ||
      seedData.leaf_category ||
      snapshot.product_type ||
      snapshot.leaf_category ||
      seedData.category ||
      snapshot.category,
  );
  const normalizedType = normalizeCategoryToken(productType);
  if (!normalizedType || ['beauty', 'haircare', 'skincare', 'bodycare', 'makeup'].includes(normalizedType)) {
    return null;
  }
  const title = titleizeCategory(productType);
  return {
    productType: title,
    category: title,
    categoryPath,
  };
}

function titleOnlyCategoryText(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return [
    row.title,
    seedData.title,
    seedData.product_name,
    snapshot.title,
    snapshot.product_name,
  ]
    .map(asString)
    .join(' ')
    .toLowerCase();
}

function inferTitleCorrectionCategoryShape(row, explicitShape) {
  if (!explicitShape) return null;
  const explicitText = [
    explicitShape.productType,
    explicitShape.category,
    explicitShape.categoryPath,
  ]
    .map(asString)
    .join(' ')
    .toLowerCase();
  const explicitLooksMakeup = /\b(?:makeup|bronzer|blush|foundation|concealer|lip|eye-makeup|eyeshadow|mascara)\b/.test(
    explicitText,
  );
  if (!explicitLooksMakeup) return null;

  const titleText = titleOnlyCategoryText(row);
  if (/\b(?:eye\s+cream|eye\s+serum|eye\s+oil|eye\s+treatment|eye\s+balm)\b/.test(titleText)) {
    return { productType: 'Eye Treatment', category: 'Eye Treatment', categoryPath: 'beauty/skincare/eye-care' };
  }
  return null;
}

function inferHighConfidenceTitleCategoryShape(row) {
  const titleText = titleOnlyCategoryText(row);
  if (/\b(?:eye\s+cream|eye\s+serum|eye\s+oil|eye\s+treatment|eye\s+balm)\b/.test(titleText)) {
    return { productType: 'Eye Treatment', category: 'Eye Treatment', categoryPath: 'beauty/skincare/eye-care' };
  }
  if (/\b(?:make\s*up|makeup)\s+remover\s+wipes?\b/.test(titleText) || /\bcleansing\s+wipes?\b/.test(titleText)) {
    return { productType: 'Makeup Remover Wipes', category: 'Makeup Remover Wipes', categoryPath: 'beauty/skincare/cleanser' };
  }
  return null;
}

function seedLooksSetOrBundle(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  const productKind = asString(
    seedData.product_kind ||
      snapshot.product_kind ||
      seedData.product_family ||
      snapshot.product_family ||
      seedData.pdp_schema_profile ||
      snapshot.pdp_schema_profile,
  ).toLowerCase();
  if (['bundle', 'set', 'set_or_collection', 'collection'].includes(productKind)) return true;

  const componentCount = Math.max(
    asArray(seedData.bundle_components).length,
    asArray(seedData.bundle_component_refs).length,
    asArray(snapshot.bundle_components).length,
    asArray(snapshot.bundle_component_refs).length,
  );
  if (componentCount > 0) return true;

  const haystack = titleCategoryText(row);
  return /\b(?:set|sets|kit|kits|bundle|bundles|duo|trio|routine|regimen|discovery|collection|pair|gift\s+set|bauble)\b/.test(haystack);
}

function inferSetOrBundleCategoryShape(row) {
  if (!seedLooksSetOrBundle(row)) return null;
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  const haystack = [
    row.title,
    seedData.title,
    seedData.category,
    seedData.leaf_category,
    seedData.product_type,
    snapshot.title,
    snapshot.category,
    snapshot.leaf_category,
    snapshot.product_type,
  ]
    .map(asString)
    .join(' ')
    .toLowerCase();

  if (/\b(?:fragrance|perfume|parfum|eau\s+de\s+parfum|eau\s+de\s+toilette|scent)\b/.test(haystack)) {
    return { productType: 'Fragrance Set', category: 'Fragrance Set', categoryPath: 'beauty/fragrance/sets' };
  }
  if (/\b(?:shampoo|conditioner|hair|scalp)\b/.test(haystack)) {
    return { productType: 'Haircare Set', category: 'Haircare Set', categoryPath: 'beauty/haircare/sets' };
  }
  if (/\b(?:skin|skincare|face|facial|cleanse|cleansing|moisturi[sz]er|moisturi[sz]ing|serum|oil|cream|mask|spf|sunscreen|toner|eye)\b/.test(haystack)) {
    return { productType: 'Skincare Set', category: 'Skincare Set', categoryPath: 'beauty/skincare/sets' };
  }
  if (/\b(?:body|hand|lotion|wash|deodorant|soap)\b/.test(haystack)) {
    return { productType: 'Bodycare Set', category: 'Bodycare Set', categoryPath: 'beauty/bodycare/sets' };
  }
  return { productType: 'Beauty Set', category: 'Beauty Set', categoryPath: 'beauty/sets' };
}

function productKindValueForFamily(family) {
  const normalized = asString(family).toLowerCase();
  if (normalized === 'set_or_collection') return 'bundle';
  if (['single_formula', 'accessory', 'non_merch', 'sample', 'unknown_product'].includes(normalized)) {
    return normalized;
  }
  return '';
}

function classifyMirrorProductKind(row, categoryShape, context = {}) {
  const seedData = asObject(context.seedData || pickSeedData(row));
  const snapshot = asObject(context.snapshot || pickSnapshot(row));
  const category = asString(categoryShape?.category);
  const productType = asString(categoryShape?.productType || category);
  const categoryPath = asString(categoryShape?.categoryPath);
  return classifyExternalSeedProductKind({
    ...row,
    title: context.title || row.title,
    description: context.description || row.description,
    category,
    product_type: productType,
    category_path: categoryPath,
    catalog_category_path: categoryPath,
    seed_data: {
      ...seedData,
      category,
      product_type: productType,
      category_path: categoryPath,
      catalog_category_path: categoryPath,
      snapshot: {
        ...snapshot,
        category,
        product_type: productType,
        category_path: categoryPath,
        catalog_category_path: categoryPath,
      },
    },
  });
}

function inferCatalogMirrorCategory(row) {
  const highConfidenceTitleShape = inferHighConfidenceTitleCategoryShape(row);
  if (highConfidenceTitleShape) return highConfidenceTitleShape;

  const setOrBundleShape = inferSetOrBundleCategoryShape(row);
  if (setOrBundleShape) return setOrBundleShape;

  const explicitShape = explicitCategoryShape(row);
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  const explicitCategory = normalizeCategoryToken(
    seedData.leaf_category ||
      seedData.product_type ||
      seedData.category ||
      snapshot.leaf_category ||
      snapshot.product_type ||
      snapshot.category,
  );
  const titleCorrectionShape = inferTitleCorrectionCategoryShape(
    row,
    explicitShape || {
      productType: explicitCategory,
      category: explicitCategory,
      categoryPath: normalizeCategoryPath(seedData.category_path || snapshot.category_path),
    },
  );
  if (titleCorrectionShape) return titleCorrectionShape;
  if (explicitShape) return explicitShape;

  const haystack = `${explicitCategory} ${titleCategoryText(row)}`;

  if (/\b(?:sunscreen|sun\s*screen|spf\s*\d+|sun\s+stick|sun\s+cream)\b/.test(haystack)) {
    return { productType: 'Sunscreen', category: 'Sunscreen', categoryPath: 'beauty/skincare/sunscreen' };
  }
  if (/\b(?:highlighter|illuminator|luminizer|luminiser)\b/.test(haystack)) {
    return { productType: 'Highlighter', category: 'Highlighter', categoryPath: 'beauty/makeup/cheek/highlighter' };
  }
  if (/\b(?:setting powder|loose powder|pressed powder|finishing powder|face powder)\b/.test(haystack)) {
    return { productType: 'Face Powder', category: 'Face Powder', categoryPath: 'beauty/makeup/face/powder' };
  }
  if (/\b(?:foundation|skin tint|complexion tint)\b/.test(haystack)) {
    return { productType: 'Foundation', category: 'Foundation', categoryPath: 'beauty/makeup/face/foundation' };
  }
  if (/\b(?:concealer|corrector)\b/.test(haystack)) {
    return { productType: 'Concealer', category: 'Concealer', categoryPath: 'beauty/makeup/face/concealer' };
  }
  if (/\b(?:blush|blusher)\b/.test(haystack)) {
    return { productType: 'Blush', category: 'Blush', categoryPath: 'beauty/makeup/blush' };
  }
  if (/\b(?:bronzer|contour)\b/.test(haystack)) {
    return { productType: 'Bronzer', category: 'Bronzer', categoryPath: 'beauty/makeup/face/bronzer' };
  }
  if (/\b(?:lipstick|liquid lip|lip color|lip colour|lip gloss|lip oil|lip balm|lip liner|lip blush|lip kit)\b/.test(haystack)) {
    return { productType: 'Lip Color', category: 'Lip Color', categoryPath: 'beauty/makeup/lip' };
  }
  if (/\b(?:mascara|eyeliner|kyliner|eyeshadow|eye shadow|brow pencil|brow gel)\b/.test(haystack)) {
    return { productType: 'Eye Makeup', category: 'Eye Makeup', categoryPath: 'beauty/makeup/eye' };
  }
  if (/\b(?:primer|pore prep)\b/.test(haystack)) {
    return { productType: 'Primer', category: 'Primer', categoryPath: 'beauty/makeup/face/primer' };
  }
  if (/\b(?:toner|tonic|tonik|toning mist|face mist|rose water)\b/.test(haystack) && !/\bscalp tonic\b/.test(haystack)) {
    return { productType: 'Toner', category: 'Toner', categoryPath: 'beauty/skincare/toner' };
  }
  if (/\b(?:cleansing pad|cleansing pads|cotton rounds?|reusable pads?|bamboo velour)\b/.test(haystack)) {
    return { productType: 'Cleansing Pads', category: 'Cleansing Pads', categoryPath: 'beauty/accessories/cleansing-pads' };
  }
  if (/\b(?:eye serum|eye cream|eye oil|eye treatment|all in eye|lash serum|brow serum|eyebrow)\b/.test(haystack)) {
    return { productType: 'Eye Treatment', category: 'Eye Treatment', categoryPath: 'beauty/skincare/eye-care' };
  }
  if (/\b(?:face oil|facial oil|oil serum)\b/.test(haystack)) {
    return { productType: 'Face Oil', category: 'Face Oil', categoryPath: 'beauty/skincare/face-oil' };
  }
  if (/\b(?:cleansing oil|cleanser|oil to milk)\b/.test(haystack)) {
    return { productType: 'Cleanser', category: 'Cleanser', categoryPath: 'beauty/skincare/cleanser' };
  }
  if (/\b(?:face mask|herbal face mask|recovery mask)\b/.test(haystack)) {
    return { productType: 'Face Mask', category: 'Face Mask', categoryPath: 'beauty/skincare/mask' };
  }
  if (/\b(?:facial emulsion|face emulsion|moisturizer|moisturiser|cream|water gel|gel cream)\b/.test(haystack)) {
    return { productType: 'Moisturizer', category: 'Moisturizer', categoryPath: 'beauty/skincare/moisturizer' };
  }
  if (/\b(?:hair mask)\b/.test(haystack)) {
    return { productType: 'Hair Mask', category: 'Hair Mask', categoryPath: 'beauty/haircare/mask' };
  }
  if (/\b(?:shampoo|conditioner|hair milk|hair oil|scalp|hair density|hair shine)\b/.test(haystack)) {
    return { productType: 'Haircare', category: 'Haircare', categoryPath: 'beauty/haircare' };
  }
  if (/\b(?:serum|ampoule)\b/.test(haystack)) {
    return { productType: 'Serum', category: 'Serum', categoryPath: 'beauty/skincare/serum' };
  }

  const explicitTitle = explicitCategory
    ? explicitCategory.replace(/\b\w/g, (char) => char.toUpperCase())
    : 'Beauty Product';
  return {
    productType: explicitTitle,
    category: explicitTitle,
    categoryPath: normalizeCategoryPath(seedData.category_path || snapshot.category_path) || 'beauty',
  };
}

function variantOptionMap(variant) {
  const attrs = {};
  const labels = {};
  for (const option of asArray(variant.options)) {
    const name = displayLabelForVariantAxis(option?.name || option?.label || option?.axis, option?.axis_kind || option?.axisKind);
    const value = asString(option?.value || option?.label || option?.name);
    if (!name || !isDisplayableVariantOptionValue(value)) continue;
    const visibleAxis = inferVisibleVariantAxis(value, name);
    if (!visibleAxis) continue;
    attrs[visibleAxis] = value;
    labels[visibleAxis] = value;
  }
  for (const [key, value] of Object.entries(asObject(variant.option_values))) {
    if (!isDisplayableVariantOptionValue(value)) continue;
    const label = displayLabelForVariantAxis(key);
    const visibleAxis = inferVisibleVariantAxis(value, label);
    if (!visibleAxis) continue;
    attrs[visibleAxis] = asString(value);
    labels[visibleAxis] = asString(value);
  }
  const optionValue = asString(
    variant.option_value || variant.optionValue || variant.option1 || variant.selected || variant.label_value,
  );
  if (isDisplayableVariantOptionValue(optionValue)) {
    const label = displayLabelForVariantAxis(
      variant.option_name || variant.optionName || variant.axis || variant.axis_name,
      variant.axis_kind || variant.axisKind,
    );
    const visibleAxis = inferVisibleVariantAxis(optionValue, label);
    if (visibleAxis) {
      attrs[visibleAxis] = optionValue;
      labels[visibleAxis] = optionValue;
    }
  }
  const title = asString(variant.title || variant.name || variant.variant_title);
  const titleAxis = inferVisibleVariantAxis(
    title,
    displayLabelForVariantAxis(
      variant.option_name || variant.option_label || variant.optionName || variant.axis || 'Title',
      variant.axis_kind || variant.axisKind,
    ),
  );
  if (!Object.keys(attrs).length && isDisplayableVariantOptionValue(title) && titleAxis) {
    attrs[titleAxis] = title;
    labels[titleAxis] = title;
  }
  return { attrs, labels };
}

function inferVisibleVariantAxis(value, axis = '') {
  const label = asString(value);
  if (isNonUserFacingVariantLabel(label, axis)) return '';
  const axisLabel = asString(axis);
  const axisNorm = axisLabel.toLowerCase();
  if (axisLabel && !/^(?:title|option|default|name)$/i.test(axisLabel)) return axisLabel;
  if (/\b\d+(?:\.\d+)?\s*(?:ml|mL|l|oz|fl\.?\s*oz|g|kg|lb|lbs|ct|count|pack|pcs?|pieces?|capsules?|tablets?)\b/i.test(label)) {
    return 'Size';
  }
  if (
    /^(?:\d{1,3}\s*)?(?:fair|light|medium|tan|deep|dark|black|brown|blonde|brunette|red|pink|rose|coral|nude|beige|ivory|porcelain|almond|espresso|caramel|berry|plum|mauve|clear|white|blue|green|purple|gold|silver|bronze)(?:\b|[\s-])/i.test(
      label
    )
  ) {
    return 'Shade';
  }
  if (axisNorm === 'shade' || axisNorm === 'color' || axisNorm === 'colour') return axisLabel || 'Shade';
  return '';
}

function isNonUserFacingVariantLabel(value, axis = '') {
  const label = asString(value);
  if (!label) return true;
  const normalized = label.toLowerCase();
  const axisNorm = asString(axis).toLowerCase();
  if (/^(?:default(?:\s+title)?|single(?:\s+item)?|one\s+size|title)$/i.test(label)) return true;
  if (/\b(?:repeat\s+order|subscription|subscribe|auto[-\s]*ship|autoship|purchase\s+option)\b/i.test(label)) {
    return true;
  }
  if (
    axisNorm === 'title' &&
    /\b(?:save|free|sale|discount|off|worth|bundle\s+deal|regular\s+price|compare\s+at|limited\s+time)\b/i.test(label)
  ) {
    return true;
  }
  if (/\$\s*\d|\b\d+\s*%\s*off\b|\bsave\s+\d+\s*%/i.test(label)) return true;
  return normalized === 'n/a' || normalized === 'na';
}

function pickVariantId(variant, fallback) {
  return (
    asString(variant.variant_id) ||
    asString(variant.id) ||
    asString(variant.source_variant_id) ||
    asString(variant.sku) ||
    asString(variant.variant_sku) ||
    fallback
  );
}

function pickVariantSku(variant, fallback) {
  return asString(variant.sku || variant.variant_sku || variant.barcode || fallback);
}

function pickVariantTitle(variant, fallbackTitle) {
  const title = asString(variant.title || variant.name || variant.variant_title);
  return isNonUserFacingVariantLabel(title, 'Title') ? asString(fallbackTitle) : title || asString(fallbackTitle);
}

function pickReviewedRegionalPrice(row) {
  return (
    normalizeAmount(readCommerceFactsV1(row)?.regional_price?.amount) ??
    normalizeAmount(row.price_amount) ??
    normalizeAmount(pickSeedData(row).price_amount) ??
    normalizeAmount(pickSnapshot(row).price_amount)
  );
}

function pickRawVariantPrice(variant) {
  return (
    normalizeAmount(asObject(variant.price).current?.amount) ??
    normalizeAmount(asObject(variant.price).amount) ??
    normalizeAmount(variant.price_amount) ??
    normalizeAmount(variant.price)
  );
}

function hasSuspiciousVariantPriceDrift(rawVariantPrice, reviewedRegionalPrice) {
  if (!Number.isFinite(rawVariantPrice) || !Number.isFinite(reviewedRegionalPrice)) return false;
  if (rawVariantPrice <= 0 || reviewedRegionalPrice <= 0) return false;
  const high = Math.max(rawVariantPrice, reviewedRegionalPrice);
  const low = Math.min(rawVariantPrice, reviewedRegionalPrice);
  return high / low >= 50;
}

function isReviewedBrandIdentityForLiveBootstrap(identity) {
  return (
    asString(identity.identity_status).toLowerCase() === 'approved' &&
    identity.review_required !== true &&
    asString(identity.source_tier).toLowerCase() === 'brand' &&
    Boolean(asString(identity.sellable_item_group_id))
  );
}

function scoreMirrorServingQuality(mirror, options = {}) {
  const product = mirror?.product || {};
  const skus = Array.isArray(mirror?.skus) ? mirror.skus : [];
  const title = asString(product.title);
  const brand = asString(product.brand);
  const canonicalUrl = normalizeUrl(product.canonical_url);
  const imageUrl = normalizeUrl(product.image_url);
  const description = asString(product.description);
  const hasPrice = skus.some((item) => Number(item?.offer?.list_price) > 0 && asString(item?.offer?.currency));
  const identity = asObject(mirror?.row?.identity_listing);
  const identityLiveReadResolved =
    asString(identity.identity_status).toLowerCase() === 'approved' &&
    identity.live_read_enabled === true &&
    identity.review_required !== true;
  const identityBootstrapEligible =
    options.allowIdentityBootstrap === true &&
    identity.live_read_enabled !== true &&
    isReviewedBrandIdentityForLiveBootstrap(identity);
  const identityResolved = identityLiveReadResolved || identityBootstrapEligible;
  const terminalHold = seedTerminalHoldStatus(mirror?.row || {});

  const missing = [];
  if (!title) missing.push('missing_title');
  if (!brand) missing.push('missing_brand');
  if (!canonicalUrl) missing.push('missing_canonical_url');
  if (!imageUrl) missing.push('missing_image');
  if (!hasPrice) missing.push('missing_price');
  if (!identityResolved) missing.push('identity_not_live_approved');
  if (terminalHold.held) missing.push(terminalHold.blockerCode || 'terminal_hold');

  let score = 50;
  if (!missing.length) score = 70;
  if (description.length >= 40) score += 8;
  if (description.length >= 140) score += 7;
  if (skus.length > 0) score += 5;
  score = Math.max(0, Math.min(100, score));

  const servingEligible = !terminalHold.held && missing.length === 0 && score >= 60;
  return {
    servingEligible,
    contentQualityScore: score,
    blockerCode: servingEligible ? 'none' : (terminalHold.blockerCode || missing[0] || 'low_quality'),
    blockerDetail: servingEligible
      ? null
      : (terminalHold.reason || missing.join(',') || 'content_quality_score below serving threshold'),
    identityResolved,
    identityLiveReadResolved,
    identityBootstrapEligible,
    terminalHold: terminalHold.held,
    terminalHoldReason: terminalHold.reason,
    hasImage: Boolean(imageUrl),
    hasPrice,
    descriptionLength: description.length,
  };
}

function pickVariantPrice(variant, row) {
  const rawVariantPrice = pickRawVariantPrice(variant);
  const reviewedRegionalPrice = pickReviewedRegionalPrice(row);
  if (hasSuspiciousVariantPriceDrift(rawVariantPrice, reviewedRegionalPrice)) {
    return reviewedRegionalPrice;
  }
  return rawVariantPrice ?? reviewedRegionalPrice;
}

function pickVariantCurrency(variant, row) {
  return normalizeCurrency(
    asObject(variant.price).current?.currency ||
      asObject(variant.price).currency ||
      variant.price_currency ||
      variant.currency ||
      row.price_currency ||
      pickSeedData(row).price_currency ||
      pickSnapshot(row).price_currency,
  );
}

function pickVariantAvailability(variant, row) {
  const availability = variant.availability;
  if (availability && typeof availability === 'object') {
    if (availability.in_stock === true) return 'in_stock';
    if (availability.in_stock === false) return 'out_of_stock';
    return normalizeAvailability(availability.status);
  }
  return normalizeAvailability(availability || row.availability || pickSeedData(row).availability || pickSnapshot(row).availability);
}

function pickVariantImage(variant, fallbackImage) {
  return (
    normalizeUrl(variant.image_url) ||
    normalizeUrl(variant.swatch_image_url) ||
    normalizeUrl(variant.label_image_url) ||
    normalizeUrl(asArray(variant.images)[0]) ||
    normalizeUrl(asArray(variant.image_urls)[0]) ||
    fallbackImage
  );
}

function collectVariants(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  const raw = [...asArray(seedData.variants), ...asArray(snapshot.variants)];
  const title = asString(row.title || seedData.title || snapshot.title || row.external_product_id);
  const imageUrl = pickImageUrl(row);
  const byKey = new Map();
  raw.forEach((variant, index) => {
    const object = asObject(variant);
    if (!Object.keys(object).length) return;
    const rawVariantId = pickVariantId(object, `variant_${index + 1}`);
    const key = asString(rawVariantId) || pickVariantTitle(object, `variant_${index + 1}`);
    if (!key || byKey.has(key)) return;
    const strongIdentifier = pickStrongIdentifier(object, seedData, snapshot, row);
    byKey.set(key, {
      raw: object,
      raw_variant_id: rawVariantId,
      source_variant_id: `${row.external_product_id}:${rawVariantId}`,
      sku: pickVariantSku(object, rawVariantId),
      barcode: strongIdentifier?.value || null,
      strong_identifier_kind: strongIdentifier?.kind || null,
      title: pickVariantTitle(object, title),
      price_amount: pickVariantPrice(object, row),
      price_currency: pickVariantCurrency(object, row),
      availability: pickVariantAvailability(object, row),
      image_url: pickVariantImage(object, imageUrl),
      ...variantOptionMap(object),
    });
  });
  if (byKey.size > 0) return Array.from(byKey.values());
  const strongIdentifier = pickStrongIdentifier(seedData, snapshot, row);
  return [
    {
      raw: {},
      raw_variant_id: row.external_product_id,
      source_variant_id: `${row.external_product_id}:canonical`,
      sku: asString(seedData.variant_sku || snapshot.variant_sku || row.external_product_id),
      barcode: strongIdentifier?.value || null,
      strong_identifier_kind: strongIdentifier?.kind || null,
      title,
      price_amount: pickVariantPrice({}, row),
      price_currency: pickVariantCurrency({}, row),
      availability: pickVariantAvailability({}, row),
      image_url: imageUrl,
      attrs: {},
      labels: {},
    },
  ];
}

function isSourceUnavailable(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  return (
    seedData.source_unavailable === true ||
    snapshot.source_unavailable === true ||
    asString(seedData.source_status).toLowerCase() === 'source_unavailable' ||
    asString(snapshot.source_status).toLowerCase() === 'source_unavailable'
  );
}

function isRandomMystery(row) {
  const haystack = [
    row.title,
    row.canonical_url,
    pickSeedData(row).title,
    pickSnapshot(row).title,
    pickSeedData(row).product_url,
  ]
    .map(asString)
    .join(' ')
    .toLowerCase();
  return /\b(mystery|random|surprise|blind\s*box)\b/.test(haystack);
}

function isSig(value) {
  return /^sig_[a-f0-9]{16,64}$/i.test(asString(value));
}

function buildMirror(row) {
  const seedData = pickSeedData(row);
  const snapshot = pickSnapshot(row);
  const externalProductId = asString(row.external_product_id);
  const seedId = asString(row.id);
  const sourceDomain = asString(row.domain) || null;
  const brand = pickBrand(row);
  const title = asString(row.title || seedData.title || snapshot.title || externalProductId);
  const canonicalUrl = pickCanonicalUrl(row);
  const imageUrl = pickImageUrl(row);
  const imageUrls = pickImageUrls(row);
  const description = pickDescription(row);
  const categoryShape = inferCatalogMirrorCategory(row);
  const mirrorProductKind = classifyMirrorProductKind(row, categoryShape, {
    title,
    description,
    seedData,
    snapshot,
  });
  const productFamily = mirrorProductKind.family || 'unknown_product';
  const productKindValue = productKindValueForFamily(productFamily);
  const identity = asObject(row.identity_listing);
  const existingSigId = isSig(row.existing_pivota_signature_id)
    ? asString(row.existing_pivota_signature_id)
    : '';
  const identitySigId = isSig(identity.sellable_item_group_id)
    ? asString(identity.sellable_item_group_id)
    : '';
  const sigId = existingSigId || identitySigId || stableHash('sig', ['external_seed_catalog_sig', externalProductId], 32);
  const productGroupId = identitySigId || sigId;
  const productKey = `prod::external_seed::external_seed::${externalProductId}`;
  const facts = readCommerceFactsV1(row);
  const agentSafeCommerceFacts = buildAgentSafeCommerceFacts(row);
  const gate = validateCommerceFactsGateForSeedRow(row);
  const variants = collectVariants(row);
  // Fix Plan C — classify the offer by the ACTUAL SELLER (domain evidence), not the
  // ingest tier. Historically `sourceRole = source_tier==='brand' ? dtc : retailer`,
  // so agent-found D2C offers on the brand's OWN domain were mislabelled retailer.
  // Now we derive from: offer domain vs the product's official/brand domain, then a
  // data-driven known-retailer list, else "unknown" (never a guess). is_first_party
  // and product source_role/tier follow the same verdict so tags stay honest.
  const officialDomain =
    asString(identity.official_domain) ||
    asString(asObject(identity.strong_identity).official_domain) ||
    asString(asObject(identity.soft_identity).official_domain) ||
    null;
  const sellerIdentity = deriveOfferSellerIdentity({
    domain: sourceDomain || (row.domain ? asString(row.domain) : ''),
    canonicalUrl,
    officialDomain,
    brand,
  });
  const offerTypeValue = sellerIdentity.offer_type; // 'brand_direct' | 'retailer' | null
  const isFirstPartyValue = sellerIdentity.is_first_party === true;
  // Map the seller verdict onto the legacy source_role/source_tier vocabulary used
  // for display + product tags. Unknown keeps the honest 'unknown' role.
  let sourceRole;
  if (offerTypeValue === 'brand_direct') sourceRole = 'official_brand_dtc';
  else if (offerTypeValue === 'retailer') sourceRole = 'retailer_offer';
  else sourceRole = 'unknown';
  const sourceTier = offerTypeValue === 'brand_direct' ? 'brand' : (offerTypeValue === 'retailer' ? 'retailer' : 'unknown');
  const sellerName = sourceRole === 'official_brand_dtc' ? brand : asString(seedData.seller_or_retailer_name || snapshot.seller_or_retailer_name || extractHostname(canonicalUrl));
  // Fix Plan D — resolve-first (existing key) then the ONE shared, URL-free
  // fallback (brandCore + strict titleCore). Dropping the URL + stripping size
  // tokens is what lets a brand-direct key and a retailer key ever be equal, so an
  // independently-ingested D2C item and its Ulta/Sephora offer converge on one
  // content_key. Existing rows keep their key via existing_content_key.
  const contentKey =
    asString(row.existing_content_key) ||
    contentKeyFallback(brand, title);
  const freshness = {
    source: SOURCE_SYSTEM,
    mirrored_at: new Date().toISOString(),
    external_seed_updated_at: row.updated_at || null,
  };
  const linkOutFields = {
    source_role: sourceRole,
    source_listing_scope: sourceRole,
    merchant_display_name: sellerName,
    seller_or_retailer_name: sellerName,
    seller_name: sellerName,
    store_name: sellerName,
    purchase_route: 'external_link_out',
    commerce_mode: 'links_out',
    checkout_handoff: 'merchant_pdp',
    external_redirect_url: canonicalUrl,
  };
  const productPayload = {
    ...seedData,
    ...linkOutFields,
    brand,
    title,
    description,
    product_name: title,
    product_type: categoryShape.productType,
    category: categoryShape.category,
    ...(productKindValue ? { product_kind: productKindValue } : {}),
    product_family: productFamily,
    external_seed_product_family: productFamily,
    external_seed_product_kind_reasons: mirrorProductKind.reasons || [],
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    image_url: imageUrl,
    image_urls: imageUrls,
    images: imageUrls,
    price_amount: pickVariantPrice(variants[0]?.raw || {}, row),
    price_currency: pickVariantCurrency(variants[0]?.raw || {}, row),
    availability: pickVariantAvailability(variants[0]?.raw || {}, row),
    category_path: categoryShape.categoryPath,
    commerce_facts_v1: facts || seedData.commerce_facts_v1 || snapshot.commerce_facts_v1 || null,
    ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
    commerce_facts_gate: gate,
    snapshot: {
      ...snapshot,
      ...linkOutFields,
      brand,
      title,
      description,
      product_name: title,
      product_type: categoryShape.productType,
      category: categoryShape.category,
      ...(productKindValue ? { product_kind: productKindValue } : {}),
      product_family: productFamily,
      external_seed_product_family: productFamily,
      external_seed_product_kind_reasons: mirrorProductKind.reasons || [],
      external_product_id: externalProductId,
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      image_url: imageUrl,
      image_urls: imageUrls,
      images: imageUrls,
      category_path: categoryShape.categoryPath,
      commerce_facts_v1: facts || snapshot.commerce_facts_v1 || seedData.commerce_facts_v1 || null,
      ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
      commerce_facts_gate: gate,
    },
  };
  const skus = variants.map((variant) => {
    const skuKey = `${productKey}::${stableHash('sku', [variant.source_variant_id], 20)}`;
    const offerId = `offer:external_seed:${crypto
      .createHash('md5')
      .update([externalProductId, variant.source_variant_id, canonicalUrl].join('\n'))
      .digest('hex')}`;
    const skuPayload = {
      source: SOURCE_SYSTEM,
      external_product_id: externalProductId,
      raw_variant_id: variant.raw_variant_id,
      source_variant_id: variant.source_variant_id,
      variant_sku: variant.sku,
      barcode: variant.barcode,
      strong_identifier_kind: variant.strong_identifier_kind,
      source_url: canonicalUrl,
      external_redirect_url: canonicalUrl,
      price: variant.price_amount != null ? String(variant.price_amount) : '',
      price_amount: variant.price_amount,
      currency: variant.price_currency,
      availability: variant.availability,
      image_url: variant.image_url,
      swatch_image_url: variant.raw.swatch_image_url || null,
      label_image_url: variant.raw.label_image_url || null,
      options: variant.attrs,
      raw_variant: variant.raw,
    };
    const offerPayload = {
      source: SOURCE_SYSTEM,
      external_seed_id: seedId,
      external_product_id: externalProductId,
      domain: row.domain || extractHostname(canonicalUrl),
      market: row.market || 'US',
      product_title: title,
      variant_title: variant.title,
      variant_sku: variant.sku,
      raw_variant_id: variant.raw_variant_id,
      url: canonicalUrl,
      offer_url: canonicalUrl,
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      external_redirect_url: canonicalUrl,
      merchant_display_name: sellerName,
      price: variant.price_amount != null ? String(variant.price_amount) : '',
      price_amount: variant.price_amount,
      price_currency: variant.price_currency,
      availability: variant.availability,
      commerce_facts_v1: facts || null,
      ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
      // Provenance for the offer_type verdict (Fix Plan C) — keeps the derivation
      // auditable on the row itself and lets the backfill/reconcile agree.
      seller_identity: {
        rule: sellerIdentity.rule,
        evidence_domain: sellerIdentity.evidence_domain,
        official_domain: officialDomain,
      },
    };
    return {
      sku: {
        sku_key: skuKey,
        product_key: productKey,
        merchant_id: MERCHANT_ID,
        platform: PLATFORM,
        source_product_id: externalProductId,
        source_variant_id: variant.source_variant_id,
        source_domain: sourceDomain,
        sku: variant.sku,
        barcode: variant.barcode,
        title: variant.title,
        currency: variant.price_currency,
        image_url: variant.image_url,
        visible_attributes: variant.attrs,
        visible_option_labels: variant.labels,
        ingredient_ids: [],
        sku_payload: skuPayload,
        readiness_tier: 'referral_only',
      },
      offer: {
        offer_id: offerId,
        sku_key: skuKey,
        product_key: productKey,
        merchant_id: MERCHANT_ID,
        catalog_track: 'external_referral',
        truth_tier: 'observed',
        readiness_tier: 'referral_only',
        offer_mode: 'redirect',
        channel: 'external_referral',
        offer_type: offerTypeValue,
        is_first_party: isFirstPartyValue,
        availability: variant.availability,
        currency: variant.price_currency,
        list_price: variant.price_amount,
        merchant_effective_price: variant.price_amount,
        estimated_best_price: variant.price_amount,
        price_confidence: variant.price_amount > 0 ? 1 : null,
        source_system: SOURCE_SYSTEM,
        source_ref: seedId,
        source_domain: sourceDomain,
        offer_payload: offerPayload,
      },
    };
  });
  return {
    row,
    productKey,
    productGroupId,
    product: {
      product_key: productKey,
      merchant_id: MERCHANT_ID,
      platform: PLATFORM,
      source_product_id: externalProductId,
      catalog_track: 'external_referral',
      truth_tier: 'observed',
      readiness_tier: 'referral_only',
      source_system: SOURCE_SYSTEM,
      source_ref: seedId,
      source_domain: sourceDomain,
      title,
      description,
      brand,
      product_type: categoryShape.productType,
      category: categoryShape.category,
      canonical_url: canonicalUrl,
      image_url: imageUrl,
      product_payload: productPayload,
      freshness_json: freshness,
      category_path: categoryShape.categoryPath,
      category_confidence: 0.85,
      category_label_source: 'reviewed_ext_seed_mirror',
      pdp_scope: 'multi_merchant_canonical',
      pdp_scope_source: SOURCE_SYSTEM,
      pivota_signature_id: sigId,
      pivota_canonical_url: `https://agent.pivota.cc/products/${sigId}`,
      tags: ['external_seed', sourceRole, 'links_out'],
      pdp_lifecycle_stage: 'published',
      content_key: contentKey,
      sync_status: 'live',
    },
    skus,
    auditReasons: identifierAuditReasons(skus),
  };
}

function identifierAuditReasons(skus) {
  const reasons = {};
  for (const skuMirror of skus || []) {
    const sku = skuMirror.sku || {};
    if (!asString(sku.barcode)) {
      reasons[NO_STRONG_IDENTIFIER] = (reasons[NO_STRONG_IDENTIFIER] || 0) + 1;
    }
    if (sku.sku_payload?.strong_identifier_kind === 'mpn') {
      reasons[MPN_CAPTURED_AS_BARCODE] = (reasons[MPN_CAPTURED_AS_BARCODE] || 0) + 1;
    }
  }
  return reasons;
}

function mergeAuditReasons(mirrors) {
  const reasons = {};
  for (const mirror of mirrors || []) {
    for (const [reason, count] of Object.entries(mirror.auditReasons || {})) {
      const numeric = Number(count || 0);
      if (numeric > 0) reasons[reason] = (reasons[reason] || 0) + numeric;
    }
  }
  return reasons;
}

async function writeWriterAuditLog({ batchId, appliedRows, reasons }) {
  await query(
    `
      INSERT INTO writer_audit_log (
        writer_name,
        batch_id,
        dry_run_report_hash,
        applied_rows,
        skipped_rows,
        reasons,
        actor
      ) VALUES ($1, $2, NULL, $3, 0, $4::jsonb, $5)
    `,
    [
      SOURCE_SYSTEM,
      batchId,
      Number(appliedRows || 0),
      JSON.stringify(reasons || {}),
      'sync-external-seeds-to-catalog.cjs',
    ],
  );
}

async function fetchRows(ids, market) {
  const res = await query(
    `
      SELECT
        e.id,
        e.external_product_id,
        e.market,
        e.tool,
        e.domain,
        e.title,
        e.image_url,
        e.price_amount,
        e.price_currency,
        e.availability,
        e.canonical_url,
        e.destination_url,
        e.seed_data,
        e.status,
        e.updated_at,
        cp.pivota_signature_id AS existing_pivota_signature_id,
        cp.content_key AS existing_content_key,
        to_jsonb(pil.*) AS identity_listing
      FROM external_product_seeds e
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = $3
       AND cp.platform = $4
       AND cp.source_product_id = e.external_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = $3
       AND pil.product_id = e.external_product_id
      WHERE e.external_product_id = ANY($1::text[])
        AND ($2::text = '' OR upper(e.market) = upper($2::text))
      ORDER BY array_position($1::text[], e.external_product_id::text)
    `,
    [ids, market || '', MERCHANT_ID, PLATFORM],
  );
  return res.rows || [];
}

async function existingCounts(mirrors) {
  const productKeys = mirrors.map((item) => item.productKey);
  const skuKeys = mirrors.flatMap((item) => item.skus.map((sku) => sku.sku.sku_key));
  const offerIds = mirrors.flatMap((item) => item.skus.map((sku) => sku.offer.offer_id));
  const productIds = mirrors.map((item) => item.row.external_product_id);
  const [products, skus, offers, groups] = await Promise.all([
    query('SELECT count(*)::int AS n FROM catalog_products WHERE product_key = ANY($1::text[])', [productKeys]),
    query('SELECT count(*)::int AS n FROM catalog_skus WHERE sku_key = ANY($1::text[])', [skuKeys]),
    query('SELECT count(*)::int AS n FROM catalog_offers WHERE offer_id = ANY($1::text[])', [offerIds]),
    query(
      `
        SELECT count(*)::int AS n
        FROM product_group_members
        WHERE merchant_id = $1
          AND platform = $2
          AND platform_product_id = ANY($3::text[])
      `,
      [MERCHANT_ID, PLATFORM, productIds],
    ),
  ]);
  return {
    catalog_products: products.rows[0]?.n || 0,
    catalog_skus: skus.rows[0]?.n || 0,
    catalog_offers: offers.rows[0]?.n || 0,
    product_group_members: groups.rows[0]?.n || 0,
  };
}

function buildStaleDeletePlan(mirrors) {
  return mirrors.map((mirror) => ({
    product_key: mirror.productKey,
    sku_keys: mirror.skus.map((skuMirror) => skuMirror.sku.sku_key).filter(Boolean),
    offer_ids: mirror.skus.map((skuMirror) => skuMirror.offer.offer_id).filter(Boolean),
  }));
}

async function staleDeletePreview(mirrors, sampleLimit = 50) {
  if (!mirrors.length) {
    return {
      current_sku_rows: 0,
      current_offer_rows: 0,
      planned_stale_sku_deletes: 0,
      planned_stale_offer_deletes: 0,
      sample_stale_skus: [],
      sample_stale_offers: [],
    };
  }
  const plan = buildStaleDeletePlan(mirrors);
  const res = await query(
    `
      WITH planned AS (
        SELECT product_key, sku_keys, offer_ids
        FROM jsonb_to_recordset($1::jsonb) AS p(
          product_key text,
          sku_keys jsonb,
          offer_ids jsonb
        )
      ),
      current_skus AS (
        SELECT cs.product_key, cs.sku_key, cs.source_variant_id, cs.title, cs.visible_attributes
        FROM planned p
        JOIN catalog_skus cs
          ON cs.product_key = p.product_key
         AND cs.merchant_id = $2
         AND cs.platform = $3
      ),
      current_offers AS (
        SELECT co.product_key, co.offer_id, co.sku_key, co.list_price, co.merchant_effective_price
        FROM planned p
        JOIN catalog_offers co
          ON co.product_key = p.product_key
         AND co.merchant_id = $2
         AND co.source_system = $4
      ),
      stale_skus AS (
        SELECT cs.*
        FROM planned p
        JOIN current_skus cs
          ON cs.product_key = p.product_key
        WHERE NOT (
          cs.sku_key = ANY(ARRAY(SELECT jsonb_array_elements_text(p.sku_keys)))
        )
      ),
      stale_offers AS (
        SELECT co.*
        FROM planned p
        JOIN current_offers co
          ON co.product_key = p.product_key
        WHERE NOT (
          co.offer_id = ANY(ARRAY(SELECT jsonb_array_elements_text(p.offer_ids)))
        )
      )
      SELECT
        (SELECT count(*)::int FROM current_skus) AS current_sku_rows,
        (SELECT count(*)::int FROM current_offers) AS current_offer_rows,
        (SELECT count(*)::int FROM stale_skus) AS planned_stale_sku_deletes,
        (SELECT count(*)::int FROM stale_offers) AS planned_stale_offer_deletes,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(s) ORDER BY s.product_key, s.sku_key)
          FROM (
            SELECT * FROM stale_skus ORDER BY product_key, sku_key LIMIT $5
          ) s
        ), '[]'::jsonb) AS sample_stale_skus,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(o) ORDER BY o.product_key, o.offer_id)
          FROM (
            SELECT * FROM stale_offers ORDER BY product_key, offer_id LIMIT $5
          ) o
        ), '[]'::jsonb) AS sample_stale_offers
    `,
    [JSON.stringify(plan), MERCHANT_ID, PLATFORM, SOURCE_SYSTEM, Number(sampleLimit || 50)],
  );
  const row = res.rows[0] || {};
  return {
    current_sku_rows: Number(row.current_sku_rows || 0),
    current_offer_rows: Number(row.current_offer_rows || 0),
    planned_stale_sku_deletes: Number(row.planned_stale_sku_deletes || 0),
    planned_stale_offer_deletes: Number(row.planned_stale_offer_deletes || 0),
    sample_stale_skus: Array.isArray(row.sample_stale_skus) ? row.sample_stale_skus : [],
    sample_stale_offers: Array.isArray(row.sample_stale_offers) ? row.sample_stale_offers : [],
  };
}

async function fetchExistingSignatureRows(mirrors) {
  const sigs = Array.from(
    new Set(
      (mirrors || [])
        .map((mirror) => asString(mirror?.product?.pivota_signature_id))
        .filter(isSig),
    ),
  );
  if (!sigs.length) return [];
  const res = await query(
    `
      SELECT product_key, source_product_id, title, brand, canonical_url, pivota_signature_id
      FROM catalog_products
      WHERE pivota_signature_id = ANY($1::text[])
    `,
    [sigs],
  );
  return res.rows || [];
}

function filterMirrorsWithSignatureConflicts(mirrors, existingSignatureRows, skipped) {
  const bySig = new Map();
  for (const row of existingSignatureRows || []) {
    const sig = asString(row.pivota_signature_id);
    if (!isSig(sig)) continue;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(row);
  }

  const plannedBySig = new Map();
  const filtered = [];
  for (const mirror of mirrors || []) {
    const sig = asString(mirror?.product?.pivota_signature_id);
    const existingConflicts = (bySig.get(sig) || [])
      .filter((row) => asString(row.product_key) && asString(row.product_key) !== asString(mirror.productKey));
    const plannedConflict = plannedBySig.get(sig);
    if (isSig(sig) && (existingConflicts.length || (plannedConflict && plannedConflict.productKey !== mirror.productKey))) {
      skipped.push({
        external_product_id: asString(mirror.row?.external_product_id),
        reason: 'duplicate_pivota_signature_conflict',
        pivota_signature_id: sig,
        conflicting_products: [
          ...existingConflicts.slice(0, 5).map((row) => ({
            product_key: asString(row.product_key),
            source_product_id: asString(row.source_product_id),
            title: asString(row.title),
            canonical_url: asString(row.canonical_url),
          })),
          ...(plannedConflict ? [{
            product_key: asString(plannedConflict.productKey),
            source_product_id: asString(plannedConflict.row?.external_product_id),
            title: asString(plannedConflict.product?.title),
            canonical_url: asString(plannedConflict.product?.canonical_url),
          }] : []),
        ],
      });
      continue;
    }
    if (isSig(sig)) plannedBySig.set(sig, mirror);
    filtered.push(mirror);
  }
  return filtered;
}

async function applyMirrors(
  mirrors,
  dryRun,
  { upsertServingState = false, batchSize = 0, bootstrapReviewedIdentityLiveRead = false } = {},
) {
  const existingBefore = await existingCounts(mirrors);
  const stalePreview = await staleDeletePreview(mirrors);
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  const batches = chunkArray(mirrors, normalizedBatchSize);
  const auditReasons = mergeAuditReasons(mirrors);
  const totals = {
    mode: dryRun ? 'dry_run' : 'apply',
    existing_before: existingBefore,
    stale_delete_preview: stalePreview,
    batch_size: normalizedBatchSize || null,
    batches: batches.length,
    audit_reasons: auditReasons,
    product_upserts: 0,
    sku_upserts: 0,
    offer_upserts: 0,
    group_member_upserts: 0,
    group_member_preserved_existing_merges: 0,
    seed_attachment_updates: 0,
    index_state_upserts: 0,
    identity_live_read_updates: 0,
    catalog_row_trust_upserts: 0,
    stale_offer_deletes: 0,
    stale_sku_deletes: 0,
  };
  if (dryRun) return totals;
  if (!mirrors.length) return totals;
  let processed = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '60s'`);
        for (const mirror of batch) {
        const p = mirror.product;
        const productRes = await client.query(
          `
            INSERT INTO catalog_products (
              product_key,
              merchant_id,
              platform,
              source_product_id,
              catalog_track,
              truth_tier,
              readiness_tier,
              source_system,
              source_ref,
              source_domain,
              title,
              description,
              brand,
              product_type,
              category,
              canonical_url,
              image_url,
              product_payload,
              freshness_json,
              category_path,
              category_confidence,
              category_label_source,
              pdp_scope,
              pdp_scope_source,
              pdp_scope_set_at,
              pivota_signature_id,
              pivota_canonical_url,
              pivota_signature_minted_at,
              tags,
              pdp_lifecycle_stage,
              content_key,
              last_seen_in_sync_at,
              sync_status,
              updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21,$22,$23,$24,now(),
              $25,$26,now(),$27::jsonb,$28,$29,now(),$30,now()
            )
            ON CONFLICT (product_key) DO UPDATE SET
              catalog_track = EXCLUDED.catalog_track,
              truth_tier = EXCLUDED.truth_tier,
              readiness_tier = EXCLUDED.readiness_tier,
              source_system = EXCLUDED.source_system,
              source_ref = EXCLUDED.source_ref,
              source_domain = EXCLUDED.source_domain,
              title = EXCLUDED.title,
              description = EXCLUDED.description,
              brand = EXCLUDED.brand,
              product_type = EXCLUDED.product_type,
              category = EXCLUDED.category,
              canonical_url = EXCLUDED.canonical_url,
              image_url = EXCLUDED.image_url,
              product_payload = EXCLUDED.product_payload,
              freshness_json = EXCLUDED.freshness_json,
              category_path = EXCLUDED.category_path,
              category_confidence = EXCLUDED.category_confidence,
              category_label_source = EXCLUDED.category_label_source,
              pdp_scope = EXCLUDED.pdp_scope,
              pdp_scope_source = EXCLUDED.pdp_scope_source,
              pdp_scope_set_at = now(),
              pivota_signature_id = COALESCE(catalog_products.pivota_signature_id, EXCLUDED.pivota_signature_id),
              pivota_canonical_url = EXCLUDED.pivota_canonical_url,
              tags = EXCLUDED.tags,
              pdp_lifecycle_stage = EXCLUDED.pdp_lifecycle_stage,
              content_key = EXCLUDED.content_key,
              last_seen_in_sync_at = now(),
              sync_status = EXCLUDED.sync_status,
              updated_at = now()
          `,
          [
            p.product_key,
            p.merchant_id,
            p.platform,
            p.source_product_id,
            p.catalog_track,
            p.truth_tier,
            p.readiness_tier,
            p.source_system,
            p.source_ref,
            p.source_domain,
            p.title,
            p.description,
            p.brand,
            p.product_type,
            p.category,
            p.canonical_url,
            p.image_url,
            JSON.stringify(p.product_payload),
            JSON.stringify(p.freshness_json),
            p.category_path,
            p.category_confidence,
            p.category_label_source,
            p.pdp_scope,
            p.pdp_scope_source,
            p.pivota_signature_id,
            p.pivota_canonical_url,
            JSON.stringify(p.tags),
            p.pdp_lifecycle_stage,
            p.content_key,
            p.sync_status,
          ],
        );
        totals.product_upserts += Number(productRes.rowCount || 0);

        const seedAttachmentRes = await client.query(
          `
            UPDATE external_product_seeds
            SET
              attached_product_key = $1,
              updated_at = now()
            WHERE id = $2
              AND status = 'active'
              AND coalesce(attached_product_key, '') = ''
            RETURNING id
          `,
          [p.product_key, mirror.row.id],
        );
        totals.seed_attachment_updates += Number(seedAttachmentRes.rowCount || 0);

        if (upsertServingState) {
          const readiness = scoreMirrorServingQuality(mirror, {
            allowIdentityBootstrap: bootstrapReviewedIdentityLiveRead,
          });
          const indexRes = await client.query(
            `
              INSERT INTO index_pipeline_state (
                content_key,
                pivota_signature_id,
                merchant_id,
                pipeline_stage,
                blocker_code,
                blocker_detail,
                serving_eligible,
                content_quality_score,
                quality_rules_version,
                quality_scored_at,
                seed_audit_status,
                identity_resolved,
                product_group_id,
                has_image,
                has_price,
                description_length,
                consolidation_version,
                last_consolidated_at,
                created_at
              ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,$13,$14,$15,$16,now(),now()
              )
              ON CONFLICT (content_key) DO UPDATE SET
                pivota_signature_id = EXCLUDED.pivota_signature_id,
                merchant_id = EXCLUDED.merchant_id,
                pipeline_stage = EXCLUDED.pipeline_stage,
                blocker_code = EXCLUDED.blocker_code,
                blocker_detail = EXCLUDED.blocker_detail,
                serving_eligible = EXCLUDED.serving_eligible,
                content_quality_score = EXCLUDED.content_quality_score,
                quality_rules_version = EXCLUDED.quality_rules_version,
                quality_scored_at = now(),
                seed_audit_status = EXCLUDED.seed_audit_status,
                identity_resolved = EXCLUDED.identity_resolved,
                product_group_id = EXCLUDED.product_group_id,
                has_image = EXCLUDED.has_image,
                has_price = EXCLUDED.has_price,
                description_length = EXCLUDED.description_length,
                consolidation_version = EXCLUDED.consolidation_version,
                last_consolidated_at = now()
            `,
            [
              p.content_key,
              p.pivota_signature_id,
              p.merchant_id,
              readiness.servingEligible ? 'shadow_indexed' : 'extracted',
              readiness.blockerCode,
              readiness.blockerDetail,
              readiness.servingEligible,
              readiness.contentQualityScore,
              'external_product_seeds_mirror.v1',
              'passed',
              readiness.identityResolved,
              mirror.productGroupId,
              readiness.hasImage,
              readiness.hasPrice,
              readiness.descriptionLength,
              'external_product_seeds_mirror.v1',
            ],
          );
          totals.index_state_upserts += Number(indexRes.rowCount || 0);

          if (readiness.servingEligible === true) {
            const identityRes = await client.query(
              `
                UPDATE pdp_identity_listing
                SET
                  live_read_enabled = true,
                  identity_status = 'approved',
                  review_required = false,
                  updated_at = now()
                WHERE merchant_id = $1
                  AND product_id = $2
                  AND identity_status = 'approved'
                  AND review_required = false
                  AND coalesce(sellable_item_group_id, '') <> ''
                  AND coalesce(live_read_enabled, false) = false
                RETURNING source_listing_ref
              `,
              [MERCHANT_ID, mirror.row.external_product_id],
            );
            totals.identity_live_read_updates += Number(identityRes.rowCount || 0);
          }
        }

        for (const skuMirror of mirror.skus) {
          const s = skuMirror.sku;
          const skuRes = await client.query(
            `
              INSERT INTO catalog_skus (
                sku_key,
                product_key,
                merchant_id,
                platform,
                source_product_id,
                source_variant_id,
                source_domain,
                sku,
                barcode,
                title,
                currency,
                image_url,
                visible_attributes,
                visible_option_labels,
                ingredient_ids,
                sku_payload,
                readiness_tier,
                updated_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,now())
              ON CONFLICT (sku_key) DO UPDATE SET
                source_domain = EXCLUDED.source_domain,
                barcode = EXCLUDED.barcode,
                title = EXCLUDED.title,
                currency = EXCLUDED.currency,
                image_url = EXCLUDED.image_url,
                visible_attributes = EXCLUDED.visible_attributes,
                visible_option_labels = EXCLUDED.visible_option_labels,
                ingredient_ids = EXCLUDED.ingredient_ids,
                sku_payload = EXCLUDED.sku_payload,
                readiness_tier = EXCLUDED.readiness_tier,
                updated_at = now()
            `,
            [
              s.sku_key,
              s.product_key,
              s.merchant_id,
              s.platform,
              s.source_product_id,
              s.source_variant_id,
              s.source_domain,
              s.sku,
              s.barcode,
              s.title,
              s.currency,
              s.image_url,
              JSON.stringify(s.visible_attributes),
              JSON.stringify(s.visible_option_labels),
              JSON.stringify(s.ingredient_ids),
              JSON.stringify(s.sku_payload),
              s.readiness_tier,
            ],
          );
          totals.sku_upserts += Number(skuRes.rowCount || 0);

          const o = skuMirror.offer;
          const offerRes = await client.query(
            `
              INSERT INTO catalog_offers (
                offer_id,
                sku_key,
                product_key,
                merchant_id,
                catalog_track,
                truth_tier,
                readiness_tier,
                offer_mode,
                channel,
                offer_type,
                is_first_party,
                availability,
                currency,
                list_price,
                merchant_effective_price,
                estimated_best_price,
                price_confidence,
                source_system,
                source_ref,
                source_domain,
                offer_payload,
                updated_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,now())
              ON CONFLICT (offer_id) DO UPDATE SET
                -- Fix Plan C: self-correct the seller verdict. Prefer the freshly
                -- derived value; only fall back to the stored one when we lack
                -- domain evidence this run (COALESCE keeps a good label sticky
                -- rather than nulling it out). is_first_party follows offer_type.
                offer_type = COALESCE(EXCLUDED.offer_type, catalog_offers.offer_type),
                is_first_party = CASE
                  WHEN EXCLUDED.offer_type IS NOT NULL THEN EXCLUDED.is_first_party
                  ELSE catalog_offers.is_first_party
                END,
                availability = EXCLUDED.availability,
                currency = EXCLUDED.currency,
                list_price = EXCLUDED.list_price,
                merchant_effective_price = EXCLUDED.merchant_effective_price,
                estimated_best_price = EXCLUDED.estimated_best_price,
                price_confidence = EXCLUDED.price_confidence,
                source_system = EXCLUDED.source_system,
                source_ref = EXCLUDED.source_ref,
                source_domain = EXCLUDED.source_domain,
                offer_payload = EXCLUDED.offer_payload,
                updated_at = now()
            `,
            [
              o.offer_id,
              o.sku_key,
              o.product_key,
              o.merchant_id,
              o.catalog_track,
              o.truth_tier,
              o.readiness_tier,
              o.offer_mode,
              o.channel,
              o.offer_type,
              o.is_first_party,
              o.availability,
              o.currency,
              o.list_price,
              o.merchant_effective_price,
              o.estimated_best_price,
              o.price_confidence,
              o.source_system,
              o.source_ref,
              o.source_domain,
              JSON.stringify(o.offer_payload),
            ],
          );
          totals.offer_upserts += Number(offerRes.rowCount || 0);
        }

        const plannedSkuKeys = mirror.skus.map((skuMirror) => skuMirror.sku.sku_key).filter(Boolean);
        const plannedOfferIds = mirror.skus.map((skuMirror) => skuMirror.offer.offer_id).filter(Boolean);
        const staleOfferRes = await client.query(
          `
            DELETE FROM catalog_offers
            WHERE product_key = $1
              AND merchant_id = $2
              AND source_system = $3
              AND NOT (offer_id = ANY($4::text[]))
          `,
          [p.product_key, MERCHANT_ID, SOURCE_SYSTEM, plannedOfferIds],
        );
        totals.stale_offer_deletes += Number(staleOfferRes.rowCount || 0);
        const staleSkuRes = await client.query(
          `
            DELETE FROM catalog_skus
            WHERE product_key = $1
              AND merchant_id = $2
              AND platform = $3
              AND NOT (sku_key = ANY($4::text[]))
          `,
          [p.product_key, MERCHANT_ID, PLATFORM, plannedSkuKeys],
        );
        totals.stale_sku_deletes += Number(staleSkuRes.rowCount || 0);

        const groupRes = await client.query(
          `
            INSERT INTO product_group_members (
              product_group_id,
              merchant_id,
              platform,
              platform_product_id,
              is_primary,
              created_at,
              updated_at
            ) VALUES ($1,$2,$3,$4,true,now(),now())
            ON CONFLICT (merchant_id, platform, platform_product_id) DO UPDATE SET
              product_group_id = CASE
                WHEN product_group_members.product_group_id IS NULL
                  OR product_group_members.product_group_id = EXCLUDED.product_group_id
                THEN EXCLUDED.product_group_id
                ELSE product_group_members.product_group_id
              END,
              is_primary = CASE
                WHEN product_group_members.product_group_id IS NULL
                  OR product_group_members.product_group_id = EXCLUDED.product_group_id
                THEN EXCLUDED.is_primary
                ELSE product_group_members.is_primary
              END,
              updated_at = now()
            RETURNING product_group_id, product_group_id <> $1 AS preserved_existing_group
          `,
          [mirror.productGroupId, MERCHANT_ID, PLATFORM, mirror.row.external_product_id],
        );
        totals.group_member_upserts += Number(groupRes.rowCount || 0);
        if (groupRes.rows?.[0]?.preserved_existing_group) {
          totals.group_member_preserved_existing_merges += 1;
        }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });

    // C1 Phase 2: recompute trust for all product_keys in this batch after commit.
    // This must be awaited so the shared pool is still open when the process exits.
    const batchProductKeys = batch.map((m) => m.product.product_key).filter(Boolean);
    if (batchProductKeys.length) {
      totals.catalog_row_trust_upserts += await upsertCatalogRowTrustMany(getPool(), batchProductKeys);
    }

    processed += batch.length;
    if (batches.length > 1) {
      process.stderr.write(
        `sync-external-seeds-to-catalog apply batch ${batchIndex + 1}/${batches.length}: ` +
          `${processed}/${mirrors.length} mirrors committed\n`,
      );
    }
  }
  await writeWriterAuditLog({
    batchId: `sync-external-seeds-to-catalog:${new Date().toISOString()}`,
    appliedRows: totals.sku_upserts,
    reasons: auditReasons,
  });
  return totals;
}

function findDuplicateCanonicals(rows) {
  const byCanonical = new Map();
  for (const row of rows) {
    const canonical = pickCanonicalUrl(row);
    if (!canonical) continue;
    const key = `${extractHostname(canonical)}::${normalizeText(canonical)}`;
    const current = byCanonical.get(key) || [];
    current.push(row.external_product_id);
    byCanonical.set(key, current);
  }
  const duplicates = new Set();
  for (const ids of byCanonical.values()) {
    if (ids.length > 1) ids.forEach((id) => duplicates.add(id));
  }
  return duplicates;
}

function dedupeStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = asString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function buildAffectedProductsManifest({
  mirrors = [],
  skipped = [],
  missingIds = [],
  market = 'US',
  mode = 'dry_run',
  generatedAt = new Date().toISOString(),
} = {}) {
  const rows = (Array.isArray(mirrors) ? mirrors : []).map((mirror) => {
    const externalProductId = asString(mirror.row?.external_product_id);
    const sigId = asString(mirror.product?.pivota_signature_id);
    const contentKey = asString(mirror.product?.content_key);
    const productRefs = dedupeStrings([
      externalProductId,
      externalProductId ? `product:${externalProductId}` : '',
      sigId,
      sigId ? `product:${sigId}` : '',
      contentKey,
      mirror.productKey,
    ]);
    return {
      external_product_id: externalProductId,
      product_ref: externalProductId ? `product:${externalProductId}` : '',
      product_refs: productRefs,
      product_key: mirror.productKey,
      product_group_id: mirror.productGroupId,
      pivota_signature_id: sigId,
      sig_id: sigId,
      content_key: contentKey,
      market: asString(mirror.row?.market || market).toUpperCase(),
      brand: asString(mirror.product?.brand),
      title: asString(mirror.product?.title),
      canonical_url: asString(mirror.product?.canonical_url),
      domain: asString(mirror.product?.source_domain || mirror.row?.domain),
    };
  });

  return {
    generated_at: generatedAt,
    source: 'sync-external-seeds-to-catalog',
    mode,
    market: asString(market).toUpperCase(),
    affected_count: rows.length,
    external_product_ids: dedupeStrings(rows.map((row) => row.external_product_id)),
    sig_ids: dedupeStrings(rows.map((row) => row.pivota_signature_id)),
    content_keys: dedupeStrings(rows.map((row) => row.content_key)),
    affected_refs: dedupeStrings(rows.flatMap((row) => row.product_refs)),
    rows,
    skipped,
    missing_ids: missingIds,
  };
}

async function run() {
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun') || !hasFlag('apply');
  const write = !dryRun;
  const confirm = asString(argValue('confirm'));
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
  const ids = Array.from(
    new Set([
      ...readDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds')),
      ...readIdsFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile')),
    ]),
  );
  const market = asString(argValue('market', 'US')).toUpperCase();
  const out = resolveOutPath(argValue('out'));
  const affectedProductsOut = resolveOutPath(argValue('affected-products-out') || argValue('affectedProductsOut'));
  const allowRandom = hasFlag('allow-random');
  const allowDuplicateCanonical = hasFlag('allow-duplicate-canonical');
  const upsertServingState = hasFlag('upsert-serving-state') || hasFlag('upsertServingState');
  const bootstrapReviewedIdentityLiveRead =
    hasFlag('bootstrap-reviewed-identity-live-read') || hasFlag('bootstrapReviewedIdentityLiveRead');
  const batchSize = normalizeBatchSize(argValue('batch-size') || argValue('batchSize'));
  if (!ids.length) throw new Error('missing_external_product_ids');
  const rows = await fetchRows(ids, market);
  const missingIds = ids.filter((id) => !rows.some((row) => asString(row.external_product_id) === id));
  const duplicateCanonicals = findDuplicateCanonicals(rows);
  const skipped = [];
  let mirrors = [];
  for (const row of rows) {
    const id = asString(row.external_product_id);
    if (asString(row.status).toLowerCase() !== 'active') {
      skipped.push({ external_product_id: id, reason: 'inactive_seed' });
      continue;
    }
    if (isSourceUnavailable(row)) {
      skipped.push({ external_product_id: id, reason: 'source_unavailable_hold' });
      continue;
    }
    if (!allowRandom && isRandomMystery(row)) {
      skipped.push({ external_product_id: id, reason: 'random_or_mystery_item_hold' });
      continue;
    }
    if (!allowDuplicateCanonical && duplicateCanonicals.has(id)) {
      skipped.push({ external_product_id: id, reason: 'duplicate_canonical_url_identity_review_required' });
      continue;
    }
    const canonicalUrl = pickCanonicalUrl(row);
    if (!canonicalUrl) {
      skipped.push({ external_product_id: id, reason: 'missing_canonical_url' });
      continue;
    }
    const identity = asObject(row.identity_listing);
    if (identity.review_required === true || asString(identity.identity_status) === 'review_required') {
      skipped.push({ external_product_id: id, reason: 'identity_review_required' });
      continue;
    }
    const mirror = buildMirror(row);
    if (!mirror.product.brand || !mirror.product.title || !mirror.product.image_url) {
      skipped.push({
        external_product_id: id,
        reason: 'missing_required_catalog_surface',
        brand: mirror.product.brand,
        title: mirror.product.title,
        image_url: mirror.product.image_url,
      });
      continue;
    }
    mirrors.push(mirror);
  }
  const existingSignatureRows = await fetchExistingSignatureRows(mirrors);
  mirrors = filterMirrorsWithSignatureConflicts(mirrors, existingSignatureRows, skipped);
  const applied = await applyMirrors(mirrors, dryRun, {
    upsertServingState,
    batchSize,
    bootstrapReviewedIdentityLiveRead,
  });
  const report = {
    generated_at: new Date().toISOString(),
    mode: dryRun ? 'dry_run' : 'apply',
    batch_size: batchSize || null,
    bootstrap_reviewed_identity_live_read: bootstrapReviewedIdentityLiveRead,
    requested_ids: ids.length,
    fetched_rows: rows.length,
    mirror_rows: mirrors.length,
    planned_sku_rows: mirrors.reduce((sum, item) => sum + item.skus.length, 0),
    planned_offer_rows: mirrors.reduce((sum, item) => sum + item.skus.length, 0),
    planned_index_state_rows: upsertServingState ? mirrors.length : 0,
    missing_ids: missingIds,
    skipped,
    applied,
    sample: mirrors.slice(0, 20).map((mirror) => ({
      external_product_id: mirror.row.external_product_id,
      product_key: mirror.productKey,
      product_group_id: mirror.productGroupId,
      title: mirror.product.title,
      brand: mirror.product.brand,
      product_type: mirror.product.product_type,
      category: mirror.product.category,
      category_path: mirror.product.category_path,
      canonical_url: mirror.product.canonical_url,
      pivota_signature_id: mirror.product.pivota_signature_id,
      sku_rows: mirror.skus.length,
      first_sku: mirror.skus[0]?.sku,
      first_offer: mirror.skus[0]?.offer,
      serving_readiness: scoreMirrorServingQuality(mirror, {
        allowIdentityBootstrap: bootstrapReviewedIdentityLiveRead,
      }),
    })),
  };
  const affectedProductsManifest = buildAffectedProductsManifest({
    mirrors,
    skipped,
    missingIds,
    market,
    mode: report.mode,
    generatedAt: report.generated_at,
  });
  if (affectedProductsOut) {
    writeJsonFile(affectedProductsOut, affectedProductsManifest);
    report.affected_products_out = affectedProductsOut;
    report.affected_product_count = affectedProductsManifest.affected_count;
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (out) {
    writeJsonFile(out, report);
  }
}

if (require.main === module) {
  run()
    .catch((err) => {
      process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = {
  _internals: {
    inferCatalogMirrorCategory,
    normalizeCategoryToken,
    titleCategoryText,
    buildMirror,
    buildAffectedProductsManifest,
    filterMirrorsWithSignatureConflicts,
    scoreMirrorServingQuality,
  },
};
