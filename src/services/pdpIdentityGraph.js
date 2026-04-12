const { createHash, randomUUID } = require('crypto');
const logger = require('../logger');
const { query, withClient } = require('../db');
const {
  EXTERNAL_SEED_MERCHANT_ID,
  buildExternalSeedProduct,
} = require('./externalSeedProducts');
const {
  _internals: productGroundingResolverInternals = {},
} = require('./productGroundingResolver');
const {
  normalizePdpImageUrl,
  buildPdpImageDedupeKey,
} = require('../utils/pdpImageUrls');

const normalizeResolverText =
  typeof productGroundingResolverInternals.normalizeTextForResolver === 'function'
    ? productGroundingResolverInternals.normalizeTextForResolver
    : (value) => String(value || '').trim().toLowerCase();

const tokenizeResolverQuery =
  typeof productGroundingResolverInternals.tokenizeNormalizedResolverQuery === 'function'
    ? productGroundingResolverInternals.tokenizeNormalizedResolverQuery
    : (value) =>
        String(value || '')
          .trim()
          .toLowerCase()
          .split(/\s+/g)
          .filter(Boolean);

const PDP_IDENTITY_GRAPH_ENABLED =
  String(process.env.PDP_IDENTITY_GRAPH_ENABLED || '').trim().toLowerCase() === 'true';
const PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE =
  String(process.env.PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE || '').trim().toLowerCase() === 'true';
const PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST = new Set(
  String(process.env.PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST || '')
    .split(',')
    .map((item) => normalizeResolverText(item))
    .filter(Boolean),
);
const PDP_IDENTITY_GRAPH_REVIEW_QUEUE_LIMIT = Math.max(
  1,
  Math.min(1000, Number(process.env.PDP_IDENTITY_GRAPH_REVIEW_QUEUE_LIMIT || 250) || 250),
);

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function uniqueStrings(values, limit = 100) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(asString(value));
}

function normalizeComparableUrl(value) {
  const raw = asString(value);
  if (!isHttpUrl(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname.toLowerCase()}`;
  } catch {
    return '';
  }
}

function normalizeComparableDomain(value) {
  const raw = asString(value);
  if (!raw) return '';
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return raw.toLowerCase();
  try {
    const parsed = new URL(raw);
    return asString(parsed.host).toLowerCase();
  } catch {
    return '';
  }
}

function looksLikeRelationMissing(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('does not exist') &&
    (message.includes('pdp_identity_listing') ||
      message.includes('pdp_identity_review_queue') ||
      message.includes('pdp_identity_override'))
  );
}

function stableHash(prefix, parts) {
  const payload = JSON.stringify(parts || []);
  return `${prefix}_${createHash('sha1').update(payload).digest('hex').slice(0, 24)}`;
}

function buildSourceListingRef({ merchantId, productId }) {
  const mid = asString(merchantId);
  const pid = asString(productId);
  if (!mid || !pid) return '';
  return `${mid}:${pid}`;
}

function buildGroupMember(row) {
  const payload = asPlainObject(row?.source_payload) || {};
  const variantAxes = asPlainObject(row?.variant_axes) || {};
  const merchantName = firstNonEmptyString(
    row?.merchant_name,
    row?.merchantName,
    payload.merchant_name,
    payload.merchantName,
    payload.store_name,
    payload.storeName,
    payload.seller_name,
    payload.sellerName,
    payload.seller_of_record,
    payload.sellerOfRecord,
  );
  return {
    source_listing_ref: asString(row?.source_listing_ref),
    merchant_id: asString(row?.merchant_id),
    product_id: asString(row?.product_id),
    source_kind: asString(row?.source_kind),
    source_tier: asString(row?.source_tier),
    ...(merchantName ? { merchant_name: merchantName } : {}),
    ...(Object.keys(variantAxes).length ? { variant_axes: variantAxes } : {}),
    is_primary: row?.is_primary === true,
  };
}

function normalizeBrandToken(value) {
  return normalizeResolverText(value).replace(/\s+/g, ' ').trim();
}

function normalizeTitleToken(value) {
  return normalizeResolverText(value).replace(/\s+/g, ' ').trim();
}

function normalizeAxisValue(value) {
  return normalizeResolverText(value)
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectDeepStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectDeepStrings(item, out));
    return out;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectDeepStrings(item, out));
  }
  return out;
}

function parseQuantityToken(text, units) {
  const raw = normalizeResolverText(text);
  if (!raw) return '';
  const unitPattern = units.join('|').replace(/\s+/g, '\\s*');
  const match = raw.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})\\b`, 'i'));
  if (!match) return '';
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const unit = asString(match[2]).toLowerCase().replace(/\s+/g, '');
  return `${amount}${unit}`;
}

function parsePackToken(text) {
  const raw = normalizeResolverText(text);
  if (!raw) return '';
  const explicit = raw.match(/\b(pack of|set of)\s*(\d+)\b/i);
  if (explicit) return `${Number(explicit[2]) || 0}pack`;
  const short = raw.match(/\b(\d+)\s*(pack|ct|count|pcs|pieces)\b/i);
  if (short) return `${Number(short[1]) || 0}pack`;
  if (/\bduo\b/i.test(raw)) return '2pack';
  if (/\btrio\b/i.test(raw)) return '3pack';
  return '';
}

function pickIdentityVariant(product) {
  const defaultVariantId = firstNonEmptyString(
    product?.default_variant_id,
    product?.defaultVariantId,
    product?.selected_variant_id,
    product?.selectedVariantId,
  );
  const variants = asArray(product?.variants);
  return (
    variants.find((item) => firstNonEmptyString(item?.variant_id, item?.id) === defaultVariantId) ||
    variants[0] ||
    null
  );
}

function collectVariantOptionEntries(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => ({
        name: firstNonEmptyString(item?.name, item?.label, item?.key),
        value: firstNonEmptyString(item?.value, item?.text, item?.option, item?.name),
      }))
      .filter((item) => item.name || item.value);
  }
  const objectValue = asPlainObject(value);
  if (!objectValue) return [];
  return Object.entries(objectValue)
    .map(([name, optionValue]) => ({
      name,
      value: firstNonEmptyString(optionValue?.value, optionValue?.text, optionValue),
    }))
    .filter((item) => item.name || item.value);
}

function collectVariantOptionTexts(variant) {
  if (!variant) return [];
  return uniqueStrings(
    [
      variant?.title,
      variant?.option1,
      variant?.option2,
      variant?.option3,
      ...collectVariantOptionEntries(variant?.options).map((item) => item.value),
      ...collectVariantOptionEntries(variant?.selected_options).map((item) => item.value),
      ...collectVariantOptionEntries(variant?.selectedOptions).map((item) => item.value),
    ],
    16,
  );
}

function parseNamedAxisFromOptions(product, names) {
  const variant = pickIdentityVariant(product);
  const optionEntries = [
    ...collectVariantOptionEntries(variant?.options),
    ...collectVariantOptionEntries(variant?.selected_options),
    ...collectVariantOptionEntries(variant?.selectedOptions),
  ];
  for (const option of optionEntries) {
    const name = normalizeResolverText(option?.name);
    if (!name) continue;
    if (!names.some((candidate) => name.includes(candidate))) continue;
    const value = normalizeAxisValue(option?.value);
    if (value) return value;
  }
  const flatCandidates = [
    product?.color,
    product?.colour,
    product?.shade,
    variant?.color,
    variant?.colour,
    variant?.shade,
    variant?.option1,
    variant?.option2,
    variant?.option3,
  ];
  for (const candidate of flatCandidates) {
    const value = normalizeAxisValue(candidate);
    if (!value) continue;
    return value;
  }
  return '';
}

function extractVariantAxes(product) {
  const variants = asArray(product?.variants);
  const identityVariant = pickIdentityVariant(product);
  const texts = uniqueStrings(
    collectDeepStrings([
      product?.title,
      product?.name,
      product?.display_name,
      product?.subtitle,
      product?.variant_title,
      product?.product_type,
      collectVariantOptionTexts(identityVariant),
    ]),
    32,
  );
  const joined = texts.join(' ');
  const size =
    parseNamedAxisFromOptions(product, ['size']) ||
    (/\btravel size\b/i.test(joined)
      ? 'travel_size'
      : /\bjumbo\b/i.test(joined)
        ? 'jumbo'
        : /\bmini\b/i.test(joined)
          ? 'mini'
          : '');
  const volume = parseQuantityToken(joined, ['ml', 'm l', 'g', 'kg', 'oz', 'fl oz']);
  const pack = parsePackToken(joined);
  const shade = parseNamedAxisFromOptions(product, ['shade', 'tone', 'hue']);
  const color = parseNamedAxisFromOptions(product, ['color', 'colour']);
  const normalized = {
    ...(size ? { size } : {}),
    ...(volume ? { volume } : {}),
    ...(pack ? { pack } : {}),
    ...(shade ? { shade } : {}),
    ...(color ? { color } : {}),
    multi_variant: variants.length > 1,
  };
  return normalized;
}

function serializeVariantAxes(axes) {
  const source = asPlainObject(axes) || {};
  const pairs = ['size', 'volume', 'pack', 'shade', 'color']
    .map((key) => [key, normalizeAxisValue(source[key])])
    .filter(([, value]) => Boolean(value));
  if (!pairs.length) return '';
  return pairs.map(([key, value]) => `${key}:${value}`).join('|');
}

function stripAxisTokensFromTitle(title, axes) {
  let normalized = normalizeTitleToken(title);
  const values = ['size', 'volume', 'pack', 'shade', 'color']
    .map((key) => normalizeResolverText(axes?.[key]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (!value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized.replace(new RegExp(`\\b${escaped}\\b`, 'g'), ' ');
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function extractOfficialHandle(product, officialUrl) {
  const explicit = firstNonEmptyString(
    product?.handle,
    product?.product_handle,
    product?.platform_metadata?.handle,
    product?.platformMetadata?.handle,
    product?.seed_data?.handle,
    product?.raw?.handle,
  );
  if (explicit) return normalizeTitleToken(explicit);
  const normalizedUrl = normalizeComparableUrl(officialUrl);
  if (!normalizedUrl) return '';
  try {
    const parsed = new URL(normalizedUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const productsIdx = parts.findIndex((part) => part === 'products');
    const handle =
      productsIdx >= 0 && parts[productsIdx + 1]
        ? parts[productsIdx + 1]
        : parts[parts.length - 1] || '';
    return normalizeTitleToken(handle);
  } catch {
    return '';
  }
}

function extractOfficialUrl(product) {
  const candidates = [
    product?.source_url,
    product?.sourceUrl,
    product?.canonical_url,
    product?.canonicalUrl,
    product?.destination_url,
    product?.destinationUrl,
    product?.url,
    product?.product_url,
    product?.productUrl,
    product?.online_store_url,
    product?.onlineStoreUrl,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeComparableUrl(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function extractStrongIdentity(product, axes) {
  const gtins = uniqueStrings(
    collectDeepStrings([
      product?.gtin,
      product?.gtin12,
      product?.gtin13,
      product?.gtin14,
      product?.barcode,
      product?.barcodes,
      product?.upc,
      product?.ean,
      product?.isbn,
      product?.variants?.map((item) => [item?.gtin, item?.barcode, item?.upc, item?.ean]),
    ])
      .map((item) => asString(item).replace(/[^0-9]/g, ''))
      .filter((item) => item.length >= 8),
    6,
  );
  const officialUrl = extractOfficialUrl(product);
  const officialDomain = normalizeComparableDomain(officialUrl);
  const officialHandle = extractOfficialHandle(product, officialUrl);
  const mpn = firstNonEmptyString(
    product?.mpn,
    product?.manufacturer_part_number,
    product?.manufacturerPartNumber,
    product?.variants?.[0]?.mpn,
  );
  const stableVariantId =
    asArray(product?.variants).length <= 1
      ? firstNonEmptyString(
          product?.default_variant_id,
          product?.defaultVariantId,
          product?.variants?.[0]?.variant_id,
          product?.variants?.[0]?.sku_id,
          product?.variants?.[0]?.sku,
        )
      : '';
  return {
    ...(gtins.length ? { gtins } : {}),
    ...(mpn ? { mpn: normalizeTitleToken(mpn) } : {}),
    ...(officialUrl ? { official_url: officialUrl } : {}),
    ...(officialDomain ? { official_domain: officialDomain } : {}),
    ...(officialHandle ? { official_handle: officialHandle } : {}),
    ...(stableVariantId ? { stable_variant_id: normalizeTitleToken(stableVariantId) } : {}),
    ...(serializeVariantAxes(axes) ? { variant_axes_signature: serializeVariantAxes(axes) } : {}),
  };
}

function normalizeTitleCore(title, brand, axes) {
  let normalized = normalizeTitleToken(title);
  const brandToken = normalizeBrandToken(brand);
  if (brandToken && normalized.startsWith(`${brandToken} `)) {
    normalized = normalized.slice(brandToken.length).trim();
  }
  normalized = stripAxisTokensFromTitle(normalized, axes);
  const tokens = tokenizeResolverQuery(normalized).filter(
    (token) => !['refill', 'tester', 'sample', 'travel', 'size', 'jumbo'].includes(token),
  );
  return tokens.join(' ').trim() || normalized;
}

function extractSoftIdentity(product, axes) {
  const brand = firstNonEmptyString(
    product?.brand?.name,
    product?.brand,
    product?.brand_name,
    product?.vendor,
    product?.vendor_name,
  );
  const title = firstNonEmptyString(product?.title, product?.name, product?.display_name);
  const officialUrl = extractOfficialUrl(product);
  const officialDomain = normalizeComparableDomain(officialUrl);
  const titleCore = normalizeTitleCore(title, brand, axes);
  return {
    ...(brand ? { brand_norm: normalizeBrandToken(brand) } : {}),
    ...(title ? { title_norm: normalizeTitleToken(title) } : {}),
    ...(titleCore ? { title_core_norm: titleCore } : {}),
    ...(officialDomain ? { official_domain: officialDomain } : {}),
    ...(serializeVariantAxes(axes) ? { variant_axes_signature: serializeVariantAxes(axes) } : {}),
  };
}

function computeIdentityConfidence({ sourceTier, strongIdentity, softIdentity, axes }) {
  let score = sourceTier === 'brand' ? 0.6 : 0.42;
  if (Array.isArray(strongIdentity?.gtins) && strongIdentity.gtins.length > 0) score += 0.2;
  if (strongIdentity?.official_url) score += 0.12;
  if (strongIdentity?.official_handle) score += 0.08;
  if (softIdentity?.brand_norm) score += 0.06;
  if (softIdentity?.title_core_norm) score += 0.06;
  if (serializeVariantAxes(axes)) score += 0.06;
  if (axes?.multi_variant === true) score -= 0.12;
  return Math.max(0.05, Math.min(0.99, Number(score.toFixed(4))));
}

function chooseSourceTier(product, sourceKind) {
  if (sourceKind === 'external_seed') return 'brand';
  const domain = normalizeComparableDomain(extractOfficialUrl(product));
  const brand = normalizeBrandToken(
    firstNonEmptyString(product?.brand?.name, product?.brand, product?.vendor),
  );
  if (domain && brand && domain.includes(brand.replace(/\s+/g, ''))) {
    return 'brand';
  }
  return 'merchant';
}

function buildIdentityListingFromProduct({
  merchantId,
  productId,
  product,
  sourceKind,
  sourceMeta = {},
} = {}) {
  const normalizedProduct = asPlainObject(product);
  const mid = asString(merchantId || normalizedProduct?.merchant_id || normalizedProduct?.merchantId);
  const pid = asString(productId || normalizedProduct?.product_id || normalizedProduct?.id);
  if (!mid || !pid || !normalizedProduct) return null;
  const sourceListingRef = buildSourceListingRef({ merchantId: mid, productId: pid });
  const axes = extractVariantAxes(normalizedProduct);
  const strongIdentity = extractStrongIdentity(normalizedProduct, axes);
  const softIdentity = extractSoftIdentity(normalizedProduct, axes);
  const sourceTier = chooseSourceTier(normalizedProduct, sourceKind);
  const identityConfidence = computeIdentityConfidence({
    sourceTier,
    strongIdentity,
    softIdentity,
    axes,
  });
  const lineKey =
    (strongIdentity.official_domain && strongIdentity.official_handle
      ? `${strongIdentity.official_domain}:${strongIdentity.official_handle}`
      : '') ||
    (softIdentity.brand_norm && softIdentity.title_core_norm
      ? `${softIdentity.brand_norm}:${softIdentity.title_core_norm}`
      : '') ||
    sourceListingRef;
  let matchedByRule = 'singleton_source_ref';
  let matchBasis = [];
  let reviewRequired = false;
  let reviewReasonCodes = [];
  let sellableItemKey = '';
  const axisSignature = serializeVariantAxes(axes);
  if (axes.multi_variant === true && !axisSignature) {
    reviewRequired = true;
    reviewReasonCodes.push('multi_variant_exact_item_unresolved');
  }

  if (Array.isArray(strongIdentity.gtins) && strongIdentity.gtins.length > 0) {
    matchedByRule = 'strong_gtin';
    matchBasis = strongIdentity.gtins.map((item) => `gtin:${item}`);
    sellableItemKey = `gtin:${strongIdentity.gtins.slice().sort().join('|')}`;
  } else if (strongIdentity.official_url && !reviewRequired) {
    matchedByRule = axisSignature ? 'official_url_axes' : 'official_url_route';
    matchBasis = [
      `official_url:${strongIdentity.official_url}`,
      ...(axisSignature ? [`variant_axes:${axisSignature}`] : []),
    ];
    sellableItemKey = `${strongIdentity.official_url}|${axisSignature || 'route'}`;
  } else if (
    softIdentity.brand_norm &&
    softIdentity.title_core_norm &&
    axisSignature &&
    !reviewRequired
  ) {
    matchedByRule = 'soft_brand_title_axes';
    matchBasis = [
      `brand:${softIdentity.brand_norm}`,
      `title_core:${softIdentity.title_core_norm}`,
      `variant_axes:${axisSignature}`,
    ];
    sellableItemKey = `${softIdentity.brand_norm}|${softIdentity.title_core_norm}|${axisSignature}`;
  } else {
    reviewRequired = true;
    reviewReasonCodes.push('insufficient_exact_item_evidence');
    matchBasis = [`source_listing_ref:${sourceListingRef}`];
    sellableItemKey = sourceListingRef;
  }

  const sellableItemGroupId = stableHash('sig', [sellableItemKey]);
  const productLineId = stableHash('pl', [lineKey]);
  const reviewFamilyId = stableHash('rf', [lineKey]);
  const reviewSummary =
    asPlainObject(normalizedProduct.review_summary) ||
    asPlainObject(normalizedProduct.reviews_summary) ||
    asPlainObject(normalizedProduct.reviews?.summary) ||
    {};

  return {
    source_listing_ref: sourceListingRef,
    merchant_id: mid,
    product_id: pid,
    source_kind: asString(sourceKind || 'internal') || 'internal',
    source_tier: sourceTier,
    live_read_enabled: PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE && !reviewRequired,
    sellable_item_group_id: sellableItemGroupId,
    product_line_id: productLineId,
    review_family_id: reviewFamilyId,
    identity_status: reviewRequired ? 'review_required' : 'approved',
    identity_confidence: identityConfidence,
    matched_by_rule: matchedByRule,
    match_basis: matchBasis,
    strong_identity: strongIdentity,
    soft_identity: softIdentity,
    variant_axes: axes,
    official_url: strongIdentity.official_url || null,
    official_domain: strongIdentity.official_domain || softIdentity.official_domain || null,
    brand_norm: softIdentity.brand_norm || null,
    title_norm: softIdentity.title_norm || null,
    title_core_norm: softIdentity.title_core_norm || null,
    review_required: reviewRequired,
    review_reason_codes: reviewReasonCodes,
    source_payload: normalizedProduct,
    review_summary: reviewSummary,
    source_meta: asPlainObject(sourceMeta) || {},
  };
}

function buildSoftExactClusterKey(listing) {
  const brand = asString(listing?.soft_identity?.brand_norm || listing?.brand_norm);
  const titleCore = asString(listing?.soft_identity?.title_core_norm || listing?.title_core_norm);
  const axisSignature = serializeVariantAxes(listing?.variant_axes);
  if (!brand || !titleCore || !axisSignature) return '';
  return `${brand}|${titleCore}|${axisSignature}`;
}

function findStrongIdentityConflict(listings) {
  const officialUrls = new Set();
  const gtins = new Set();
  for (const listing of listings || []) {
    const strong = asPlainObject(listing?.strong_identity) || {};
    const officialUrl = asString(strong.official_url);
    if (officialUrl) officialUrls.add(officialUrl);
    asArray(strong.gtins).forEach((item) => {
      const gtin = asString(item).replace(/[^0-9]/g, '');
      if (gtin) gtins.add(gtin);
    });
  }
  if (officialUrls.size > 1) return 'conflicting_official_url';
  if (gtins.size > 1) return 'conflicting_gtin';
  return '';
}

function clusterIdentityListings(listings) {
  const safeListings = Array.isArray(listings) ? listings : [];
  const groups = new Map();
  for (const listing of safeListings) {
    const key = buildSoftExactClusterKey(listing);
    if (!key || listing?.identity_status === 'review_required') continue;
    const current = groups.get(key) || [];
    current.push(listing);
    groups.set(key, current);
  }

  const decisions = new Map();
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const conflict = findStrongIdentityConflict(group);
    if (conflict) {
      decisions.set(key, { conflict });
      continue;
    }
    const [brand, titleCore] = key.split('|');
    const lineKey = `${brand}|${titleCore}`;
    decisions.set(key, {
      sellable_item_group_id: stableHash('sig', [`soft_exact_cluster:${key}`]),
      product_line_id: stableHash('pl', [`soft_line_cluster:${lineKey}`]),
      review_family_id: stableHash('rf', [`soft_line_cluster:${lineKey}`]),
    });
  }

  if (!decisions.size) return safeListings;
  return safeListings.map((listing) => {
    const key = buildSoftExactClusterKey(listing);
    const decision = decisions.get(key);
    if (!decision) return listing;
    if (decision.conflict) {
      return {
        ...listing,
        identity_status: 'review_required',
        live_read_enabled: false,
        review_required: true,
        review_reason_codes: uniqueStrings([
          ...asArray(listing.review_reason_codes),
          decision.conflict,
        ]),
      };
    }
    return {
      ...listing,
      sellable_item_group_id: decision.sellable_item_group_id,
      product_line_id: decision.product_line_id || listing.product_line_id,
      review_family_id: decision.review_family_id || listing.review_family_id,
      matched_by_rule:
        listing.matched_by_rule === 'official_url_axes'
          ? 'official_url_soft_exact_cluster'
          : listing.matched_by_rule === 'soft_brand_title_axes'
            ? 'soft_exact_cluster'
            : listing.matched_by_rule,
      match_basis: uniqueStrings([
        ...asArray(listing.match_basis),
        `soft_exact_cluster:${key}`,
      ]),
    };
  });
}

function parseIdentityRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...row,
    identity_confidence:
      row.identity_confidence == null ? null : Number(row.identity_confidence),
    live_read_enabled: row.live_read_enabled === true,
    review_required: row.review_required === true,
    match_basis: Array.isArray(row.match_basis) ? row.match_basis : [],
    review_reason_codes: Array.isArray(row.review_reason_codes) ? row.review_reason_codes : [],
    strong_identity: asPlainObject(row.strong_identity) || {},
    soft_identity: asPlainObject(row.soft_identity) || {},
    variant_axes: asPlainObject(row.variant_axes) || {},
    source_payload: asPlainObject(row.source_payload) || {},
    review_summary: asPlainObject(row.review_summary) || {},
  };
}

function buildImageEntriesForListing(listing, kind = 'exact_item') {
  const payload = asPlainObject(listing?.source_payload) || {};
  const candidates = [];
  const push = (value, overrides = {}) => {
    const url = normalizePdpImageUrl(
      typeof value === 'string' ? value : value?.url || value?.image_url || value?.src,
    );
    if (!url) return;
    candidates.push({
      type: 'image',
      url,
      alt_text: firstNonEmptyString(value?.alt_text, payload.title, payload.name),
      source: kind,
      source_scope: kind,
      source_tier: asString(listing?.source_tier) || undefined,
      source_kind: asString(listing?.source_kind) || undefined,
      merchant_id: asString(listing?.merchant_id) || undefined,
      product_id: asString(listing?.product_id) || undefined,
      ...overrides,
    });
  };
  push(payload.image_url);
  asArray(payload.images).forEach((item) => push(item));
  asArray(payload.image_urls).forEach((item) => push(item));
  const seen = new Set();
  return candidates.filter((item) => {
    const key = buildPdpImageDedupeKey(item.url) || item.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreListingCompleteness(listing) {
  const payload = asPlainObject(listing?.source_payload) || {};
  let score = listing?.source_tier === 'brand' ? 8 : 4;
  if (firstNonEmptyString(payload.title, payload.name)) score += 2;
  if (firstNonEmptyString(payload.description, payload.pdp_description_raw)) score += 2;
  if (
    firstNonEmptyString(payload.raw_ingredient_text_clean) ||
    asArray(payload.inci_list).length > 0
  ) {
    score += 2;
  }
  if (buildImageEntriesForListing(listing).length > 0) score += 2;
  if (Number(payload.review_summary?.review_count || payload.reviews_summary?.review_count || 0) > 0) {
    score += 1;
  }
  score += Number(listing?.identity_confidence || 0);
  return score;
}

function sortListingsForAuthority(listings) {
  return [...(Array.isArray(listings) ? listings : [])].sort((a, b) => {
    const tierDelta =
      (a?.source_tier === 'brand' ? 1 : 0) - (b?.source_tier === 'brand' ? 1 : 0);
    if (tierDelta !== 0) return tierDelta > 0 ? -1 : 1;
    return scoreListingCompleteness(b) - scoreListingCompleteness(a);
  });
}

function mergeStarDistributions(summaries) {
  const counts = new Map();
  for (const summary of summaries) {
    const rows = Array.isArray(summary?.star_distribution)
      ? summary.star_distribution
      : Array.isArray(summary?.rating_distribution)
        ? summary.rating_distribution
        : [];
    for (const row of rows) {
      const stars = Number(row?.stars || 0);
      if (!Number.isFinite(stars) || stars < 1 || stars > 5) continue;
      const existing = Number(counts.get(stars) || 0);
      let count = Number(row?.count);
      if (!Number.isFinite(count)) {
        const percent = Number(row?.percent);
        const reviewCount = Number(summary?.review_count || 0);
        if (Number.isFinite(percent) && reviewCount > 0) {
          count = percent > 1 ? Math.round((percent / 100) * reviewCount) : Math.round(percent * reviewCount);
        }
      }
      if (!Number.isFinite(count) || count <= 0) continue;
      counts.set(stars, existing + count);
    }
  }
  if (!counts.size) return undefined;
  return Array.from({ length: 5 }, (_, idx) => {
    const stars = 5 - idx;
    return {
      stars,
      count: Number(counts.get(stars) || 0),
    };
  });
}

function aggregateReviewSummary(listings, fallbackSummary = null) {
  const summaries = listings
    .map((listing) => asPlainObject(listing?.review_summary) || {})
    .filter((summary) => Number(summary.review_count || summary.count || summary.total || 0) > 0);
  const fallback = asPlainObject(fallbackSummary);
  if (!summaries.length && fallback) {
    return {
      ...fallback,
      review_count: Number(fallback.review_count || fallback.count || fallback.total || 0) || 0,
      rating: Number(fallback.rating || fallback.average_rating || fallback.avg_rating || 0) || 0,
      scale: Number(fallback.scale || fallback.rating_scale || 5) || 5,
    };
  }
  if (!summaries.length) return null;
  let totalCount = 0;
  let weightedRating = 0;
  const previewItems = [];
  const seenPreviewIds = new Set();
  for (const summary of summaries) {
    const count = Number(summary.review_count || summary.count || summary.total || 0) || 0;
    const rating = Number(summary.rating || summary.average_rating || summary.avg_rating || 0) || 0;
    totalCount += count;
    weightedRating += rating * count;
    const items = Array.isArray(summary.preview_items)
      ? summary.preview_items
      : Array.isArray(summary.snippets)
        ? summary.snippets
        : [];
    for (const item of items) {
      const id = firstNonEmptyString(item?.review_id, item?.id);
      if (!id || seenPreviewIds.has(id)) continue;
      seenPreviewIds.add(id);
      previewItems.push(item);
      if (previewItems.length >= 6) break;
    }
  }
  const starDistribution = mergeStarDistributions(summaries);
  const top = summaries[0] || {};
  return {
    scale: Number(top.scale || top.rating_scale || 5) || 5,
    rating: totalCount > 0 ? Number((weightedRating / totalCount).toFixed(2)) : 0,
    review_count: totalCount,
    ...(starDistribution ? { star_distribution: starDistribution, rating_distribution: starDistribution } : {}),
    ...(previewItems.length ? { preview_items: previewItems } : {}),
    ...(asPlainObject(top.brand_card) ? { brand_card: top.brand_card } : {}),
  };
}

function buildReviewScopeMetadata(exactSummary, lineSummary) {
  const exactCount = Number(exactSummary?.review_count || 0) || 0;
  const lineCount = Number(lineSummary?.review_count || 0) || 0;
  const aggregationScope = lineCount > exactCount ? 'product_line' : 'exact_item';
  const fallbackScale =
    Number(lineSummary?.scale || exactSummary?.scale || lineSummary?.rating_scale || exactSummary?.rating_scale || 5) ||
    5;
  const buildScopedSummary = (scope, summary, count) => {
    const src = asPlainObject(summary) || {};
    const reviewCount = Number.isFinite(Number(count))
      ? Math.max(0, Number(count))
      : Number(src.review_count || src.count || src.total || 0) || 0;
    const previewItems = Array.isArray(src.preview_items)
      ? src.preview_items
      : Array.isArray(src.snippets)
        ? src.snippets
        : [];
    const distribution = Array.isArray(src.star_distribution)
      ? src.star_distribution
      : Array.isArray(src.rating_distribution)
        ? src.rating_distribution
        : undefined;
    return {
      scale: Number(src.scale || src.rating_scale || fallbackScale) || fallbackScale,
      rating: Number(src.rating || src.average_rating || src.avg_rating || 0) || 0,
      review_count: reviewCount,
      ...(distribution ? { star_distribution: distribution, rating_distribution: distribution } : {}),
      ...(previewItems.length ? { preview_items: previewItems } : { preview_items: [] }),
      ...(asPlainObject(src.brand_card) ? { brand_card: src.brand_card } : {}),
      scope_label:
        scope === 'product_line'
          ? `Based on product-line reviews (${reviewCount})`
          : `Based on exact-item reviews (${reviewCount})`,
    };
  };
  const scopedSummaries = {
    product_line: buildScopedSummary('product_line', lineSummary || exactSummary, lineCount || exactCount),
    exact_item: buildScopedSummary('exact_item', exactSummary, exactCount),
  };
  const active =
    aggregationScope === 'product_line'
      ? scopedSummaries.product_line || scopedSummaries.exact_item
      : scopedSummaries.exact_item || scopedSummaries.product_line;
  if (!active) return null;
  return {
    ...active,
    aggregation_scope: aggregationScope,
    exact_item_review_count: exactCount,
    product_line_review_count: lineCount || exactCount,
    scoped_summaries: scopedSummaries,
    scope_label: active.scope_label,
    filters: [
      { id: 'product_line', label: 'Product line', count: lineCount || exactCount },
      { id: 'exact_item', label: 'Exact item', count: exactCount || 0 },
    ],
    tabs: [
      { id: 'product_line', label: 'Product line', count: lineCount || exactCount, default: aggregationScope === 'product_line' },
      { id: 'exact_item', label: 'Exact item', count: exactCount || 0, default: aggregationScope === 'exact_item' },
    ],
  };
}

function fillMissingString(target, source, keys) {
  const next = { ...(target || {}) };
  const src = asPlainObject(source) || {};
  for (const key of keys) {
    if (asString(next[key])) continue;
    const candidate = src[key];
    if (asString(candidate)) next[key] = candidate;
  }
  return next;
}

function composeSyntheticCanonicalProduct({
  requestedListing,
  exactListings,
  lineListings,
  fallbackProduct = null,
} = {}) {
  const sortedExact = sortListingsForAuthority(exactListings);
  const sortedLine = sortListingsForAuthority(lineListings);
  const baseListing = requestedListing || sortedExact[0] || sortedLine[0] || null;
  const basePayload = asPlainObject(baseListing?.source_payload) || asPlainObject(fallbackProduct) || {};
  if (!baseListing && !Object.keys(basePayload).length) return null;

  let product = {
    ...basePayload,
    merchant_id: asString(baseListing?.merchant_id || basePayload.merchant_id) || undefined,
    product_id: asString(baseListing?.product_id || basePayload.product_id || basePayload.id) || undefined,
    source: 'synthetic_canonical',
    canonical_scope: 'synthetic',
  };

  for (const listing of sortedExact) {
    const payload = asPlainObject(listing?.source_payload) || {};
    product = fillMissingString(product, payload, [
      'title',
      'name',
      'subtitle',
      'brand',
      'brand_name',
      'vendor',
      'description',
      'pdp_description_raw',
      'raw_ingredient_text_clean',
      'pdp_ingredients_raw',
      'pdp_active_ingredients_raw',
      'pdp_how_to_use_raw',
      'source_url',
      'canonical_url',
      'destination_url',
      'url',
      'product_url',
      'handle',
    ]);
    if (!Array.isArray(product.inci_list) || product.inci_list.length === 0) {
      const nextInci = asArray(payload.inci_list);
      if (nextInci.length > 0) product.inci_list = nextInci;
    }
    if (!Array.isArray(product.active_ingredients) || product.active_ingredients.length === 0) {
      const nextActive = asArray(payload.active_ingredients);
      if (nextActive.length > 0) product.active_ingredients = nextActive;
    }
    if (!Array.isArray(product.pdp_details_sections) || product.pdp_details_sections.length === 0) {
      const nextSections = asArray(payload.pdp_details_sections || payload.details_sections);
      if (nextSections.length > 0) product.pdp_details_sections = nextSections;
    }
  }

  const exactImages = [];
  const previewImages = [];
  const exactSeen = new Set();
  const previewSeen = new Set();
  for (const listing of sortedExact) {
    for (const item of buildImageEntriesForListing(listing, 'exact_item')) {
      const key = buildPdpImageDedupeKey(item.url) || item.url;
      if (!key || exactSeen.has(key)) continue;
      exactSeen.add(key);
      exactImages.push(item);
    }
  }
  for (const listing of sortedLine) {
    if (
      asString(listing?.sellable_item_group_id) &&
      asString(listing?.sellable_item_group_id) === asString(baseListing?.sellable_item_group_id)
    ) {
      continue;
    }
    const firstImage = buildImageEntriesForListing(listing, 'product_line_preview')[0];
    if (!firstImage) continue;
    const key = buildPdpImageDedupeKey(firstImage.url) || firstImage.url;
    if (!key || previewSeen.has(key) || exactSeen.has(key)) continue;
    previewSeen.add(key);
    previewImages.push(firstImage);
  }

  const fallbackSummary =
    asPlainObject(fallbackProduct?.review_summary) ||
    asPlainObject(fallbackProduct?.reviews_summary) ||
    null;
  const exactSummary = aggregateReviewSummary(sortedExact, fallbackSummary);
  const lineSummary = aggregateReviewSummary(sortedLine, exactSummary || fallbackSummary);
  const scopedReviewSummary = buildReviewScopeMetadata(exactSummary, lineSummary);

  product = {
    ...product,
    ...(exactImages[0] ? { image_url: exactImages[0].url } : {}),
    ...(exactImages.length ? { images: exactImages, image_urls: exactImages } : {}),
    ...(previewImages.length ? { line_preview_images: previewImages } : {}),
    ...(scopedReviewSummary ? { review_summary: scopedReviewSummary } : {}),
    gallery_scope: 'exact_item',
    preview_scope: 'product_line',
  };

  return {
    product,
    canonical_product_ref: baseListing
      ? {
          merchant_id: asString(baseListing.merchant_id),
          product_id: asString(baseListing.product_id),
        }
      : null,
  };
}

function normalizeIdentityRows(rows) {
  const out = [];
  for (const row of rows || []) {
    const parsed = parseIdentityRow(row);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out;
}

function isBrandAllowedForLive(product) {
  if (!PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST.size) return true;
  const brand = normalizeBrandToken(
    firstNonEmptyString(product?.brand?.name, product?.brand, product?.vendor, product?.brand_name),
  );
  return brand ? PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST.has(brand) : false;
}

async function maybeBuildLiveSyntheticPdp({
  merchantId,
  productId,
  canonicalProduct = null,
  queryFn = query,
} = {}) {
  if (!PDP_IDENTITY_GRAPH_ENABLED || !process.env.DATABASE_URL || typeof queryFn !== 'function') {
    return null;
  }
  if (!isBrandAllowedForLive(canonicalProduct)) return null;

  try {
    const sourceRowRes = await queryFn(
      `
        SELECT *
        FROM pdp_identity_listing
        WHERE merchant_id = $1
          AND product_id = $2
          AND identity_status = 'approved'
          AND live_read_enabled = true
        LIMIT 1
      `,
      [merchantId, productId],
    );
    const sourceRow = parseIdentityRow(sourceRowRes?.rows?.[0]);
    if (!sourceRow) return null;

    const exactRowsRes = await queryFn(
      `
        SELECT *
        FROM pdp_identity_listing
        WHERE sellable_item_group_id = $1
          AND identity_status = 'approved'
          AND live_read_enabled = true
        ORDER BY
          CASE WHEN source_tier = 'brand' THEN 0 ELSE 1 END,
          identity_confidence DESC NULLS LAST,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST
      `,
      [sourceRow.sellable_item_group_id],
    );
    const lineRowsRes = await queryFn(
      `
        SELECT *
        FROM pdp_identity_listing
        WHERE product_line_id = $1
          AND identity_status = 'approved'
          AND live_read_enabled = true
        ORDER BY
          CASE WHEN source_tier = 'brand' THEN 0 ELSE 1 END,
          identity_confidence DESC NULLS LAST,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST
      `,
      [sourceRow.product_line_id],
    );
    const exactListings = normalizeIdentityRows(exactRowsRes?.rows);
    const lineListings = normalizeIdentityRows(lineRowsRes?.rows);
    const composed = composeSyntheticCanonicalProduct({
      requestedListing: sourceRow,
      exactListings,
      lineListings,
      fallbackProduct: canonicalProduct,
    });
    if (!composed?.product) return null;
    return {
      synthetic_product: composed.product,
      canonical_product_ref: composed.canonical_product_ref,
      sellable_item_group_id: asString(sourceRow.sellable_item_group_id) || null,
      product_line_id: asString(sourceRow.product_line_id) || null,
      review_family_id: asString(sourceRow.review_family_id) || null,
      identity_confidence: Number(sourceRow.identity_confidence || 0) || 0,
      match_basis: Array.isArray(sourceRow.match_basis) ? sourceRow.match_basis : [],
      canonical_scope: 'synthetic',
      group_members: exactListings.map((item, idx) => ({
        ...buildGroupMember(item),
        is_primary:
          idx === 0 &&
          asString(item.merchant_id) === asString(composed.canonical_product_ref?.merchant_id) &&
          asString(item.product_id) === asString(composed.canonical_product_ref?.product_id),
      })),
    };
  } catch (err) {
    if (looksLikeRelationMissing(err)) return null;
    logger.warn(
      {
        err: err?.message || String(err),
        merchant_id: merchantId,
        product_id: productId,
      },
      'PDP identity graph live read failed',
    );
    return null;
  }
}

async function listLivePdpIdentityRowsForRefs({
  sourceListingRefs = [],
  queryFn = query,
} = {}) {
  if (!process.env.DATABASE_URL || typeof queryFn !== 'function') {
    return [];
  }
  const refs = uniqueStrings(sourceListingRefs, 500);
  if (!refs.length) return [];

  try {
    const result = await queryFn(
      `
        SELECT *
        FROM pdp_identity_listing
        WHERE source_listing_ref = ANY($1::text[])
          AND identity_status = 'approved'
          AND live_read_enabled = true
      `,
      [refs],
    );
    return normalizeIdentityRows(result?.rows);
  } catch (err) {
    if (looksLikeRelationMissing(err)) return [];
    logger.warn(
      {
        err: err?.message || String(err),
        refs_count: refs.length,
      },
      'PDP identity graph discovery listing read failed',
    );
    return [];
  }
}

async function promotePdpIdentityLiveRead({
  brand = null,
  sourceListingRefs = [],
  limit = 500,
  dryRun = false,
  requireBrandSource = true,
  createdBy = 'admin',
  queryFn = query,
  withClientFn = withClient,
} = {}) {
  if (!process.env.DATABASE_URL || typeof queryFn !== 'function') {
    return {
      dry_run: dryRun === true,
      candidate_rows_scanned: 0,
      groups_considered: 0,
      groups_eligible: 0,
      rows_to_enable: 0,
      overrides_to_write: 0,
      updated_rows: 0,
      brand_filter: normalizeBrandToken(brand) || null,
      require_brand_source: requireBrandSource === true,
      sample_refs: [],
      reason: 'db_not_configured',
    };
  }

  const refs = uniqueStrings(sourceListingRefs, 500);
  const normalizedBrand = normalizeBrandToken(brand);
  const normalizedLimit = Math.max(1, Math.min(5000, Number(limit) || 500));

  try {
    const params = [];
    const where = [
      `identity_status = 'approved'`,
      `review_required = false`,
      `live_read_enabled = false`,
    ];
    if (refs.length) {
      params.push(refs);
      where.push(`source_listing_ref = ANY($${params.length}::text[])`);
    } else if (normalizedBrand) {
      params.push(normalizedBrand);
      where.push(`brand_norm = $${params.length}`);
    }
    params.push(normalizedLimit);
    const candidatesRes = await queryFn(
      `
        SELECT *
        FROM pdp_identity_listing
        WHERE ${where.join(' AND ')}
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT $${params.length}
      `,
      params,
    );
    const candidateRows = normalizeIdentityRows(candidatesRes?.rows);
    const candidateGroupIds = uniqueStrings(
      candidateRows.map((row) => asString(row?.sellable_item_group_id)),
      normalizedLimit,
    );
    if (!candidateGroupIds.length) {
      return {
        dry_run: dryRun === true,
        candidate_rows_scanned: candidateRows.length,
        groups_considered: 0,
        groups_eligible: 0,
        rows_to_enable: 0,
        overrides_to_write: 0,
        updated_rows: 0,
        brand_filter: normalizedBrand || null,
        require_brand_source: requireBrandSource === true,
        sample_refs: [],
      };
    }

    const groupRowsRes = await queryFn(
      `
        SELECT *
        FROM pdp_identity_listing
        WHERE sellable_item_group_id = ANY($1::text[])
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      `,
      [candidateGroupIds],
    );
    const groupRows = normalizeIdentityRows(groupRowsRes?.rows);
    const groups = new Map();
    for (const row of groupRows) {
      const groupId = asString(row?.sellable_item_group_id);
      if (!groupId) continue;
      const current = groups.get(groupId) || [];
      current.push(row);
      groups.set(groupId, current);
    }

    const eligibleGroups = [];
    for (const [groupId, rows] of groups.entries()) {
      const safeRows = Array.isArray(rows) ? rows : [];
      if (!safeRows.length) continue;
      if (
        !safeRows.every(
          (row) =>
            asString(row?.identity_status) === 'approved' &&
            row?.review_required !== true,
        )
      ) {
        continue;
      }
      if (
        requireBrandSource === true &&
        !safeRows.some((row) => asString(row?.source_tier).toLowerCase() === 'brand')
      ) {
        continue;
      }
      const rowsToEnable = safeRows.filter((row) => row?.live_read_enabled !== true);
      if (!rowsToEnable.length) continue;
      eligibleGroups.push({
        sellable_item_group_id: groupId,
        brand_norm: asString(safeRows[0]?.brand_norm) || null,
        rows: safeRows,
        rows_to_enable: rowsToEnable,
      });
    }

    const rowsToEnable = eligibleGroups.flatMap((group) => group.rows_to_enable);
    const sourceRefsToEnable = uniqueStrings(
      rowsToEnable.map((row) => asString(row?.source_listing_ref)),
      5000,
    );
    const sampleRefs = sourceRefsToEnable.slice(0, 20);

    if (dryRun === true || !sourceRefsToEnable.length) {
      return {
        dry_run: true,
        candidate_rows_scanned: candidateRows.length,
        groups_considered: groups.size,
        groups_eligible: eligibleGroups.length,
        rows_to_enable: sourceRefsToEnable.length,
        overrides_to_write: sourceRefsToEnable.length,
        updated_rows: 0,
        brand_filter: normalizedBrand || null,
        require_brand_source: requireBrandSource === true,
        sample_refs: sampleRefs,
      };
    }

    const written = await withClientFn(async (client) => {
      await client.query('BEGIN');
      try {
        for (const row of rowsToEnable) {
          const sourceRef = asString(row?.source_listing_ref);
          const payload = {
            source_listing_ref: sourceRef,
            reason: 'eligible_exact_item_group_batch',
            sellable_item_group_id: asString(row?.sellable_item_group_id) || null,
            product_line_id: asString(row?.product_line_id) || null,
            review_family_id: asString(row?.review_family_id) || null,
            brand_norm: asString(row?.brand_norm) || null,
          };
          const overrideId = stableHash('ovr', ['approve_live_read', sourceRef, payload.reason]);
          await client.query(
            `
              INSERT INTO pdp_identity_override (
                id,
                source_listing_ref,
                action_type,
                payload,
                created_by,
                active,
                updated_at
              ) VALUES ($1,$2,'approve_live_read',$3::jsonb,$4,true, now())
              ON CONFLICT (id) DO UPDATE SET
                payload = EXCLUDED.payload,
                created_by = EXCLUDED.created_by,
                active = EXCLUDED.active,
                updated_at = now()
            `,
            [
              overrideId,
              sourceRef,
              JSON.stringify(payload),
              asString(createdBy) || 'admin',
            ],
          );
        }

        const updateRes = await client.query(
          `
            UPDATE pdp_identity_listing
            SET
              live_read_enabled = true,
              identity_status = 'approved',
              review_required = false,
              updated_at = now()
            WHERE source_listing_ref = ANY($1::text[])
          `,
          [sourceRefsToEnable],
        );
        await client.query('COMMIT');
        return {
          updated_rows: Number(updateRes?.rowCount || 0),
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });

    return {
      dry_run: false,
      candidate_rows_scanned: candidateRows.length,
      groups_considered: groups.size,
      groups_eligible: eligibleGroups.length,
      rows_to_enable: sourceRefsToEnable.length,
      overrides_to_write: sourceRefsToEnable.length,
      updated_rows: written.updated_rows,
      brand_filter: normalizedBrand || null,
      require_brand_source: requireBrandSource === true,
      sample_refs: sampleRefs,
    };
  } catch (err) {
    if (looksLikeRelationMissing(err)) {
      return {
        dry_run: dryRun === true,
        candidate_rows_scanned: 0,
        groups_considered: 0,
        groups_eligible: 0,
        rows_to_enable: 0,
        overrides_to_write: 0,
        updated_rows: 0,
        brand_filter: normalizedBrand || null,
        require_brand_source: requireBrandSource === true,
        sample_refs: [],
        reason: 'identity_tables_not_ready',
      };
    }
    throw err;
  }
}

async function fetchBackfillProducts({ limit = 500, brandFilter = null, queryFn = query } = {}) {
  const normalizedLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
  const normalizedBrandFilter = normalizeBrandToken(brandFilter);
  const internalRows = [];
  const externalRows = [];
  const titleBrandPattern = normalizedBrandFilter ? `%${normalizedBrandFilter}%` : null;

  const internalParams = [EXTERNAL_SEED_MERCHANT_ID];
  const internalWhere = ['merchant_id <> $1'];
  if (normalizedBrandFilter) {
    internalParams.push(normalizedBrandFilter);
    const brandParam = `$${internalParams.length}`;
    internalParams.push(titleBrandPattern);
    const titleParam = `$${internalParams.length}`;
    internalWhere.push(`
      (
        lower(trim(coalesce(
          product_data #>> '{brand,name}',
          product_data->>'brand',
          product_data->>'brand_name',
          product_data->>'vendor',
          product_data->>'vendor_name',
          ''
        ))) = ${brandParam}
        OR lower(coalesce(product_data->>'title', product_data->>'name', '')) LIKE ${titleParam}
      )
    `);
  }
  internalParams.push(normalizedLimit);
  const internalLimitParam = `$${internalParams.length}`;

  const internalRes = await queryFn(
    `
      SELECT merchant_id, platform_product_id, product_data, cached_at
      FROM products_cache
      WHERE ${internalWhere.join(' AND ')}
      ORDER BY cached_at DESC NULLS LAST
      LIMIT ${internalLimitParam}
    `,
    internalParams,
  );
  const seenInternal = new Set();
  for (const row of internalRes?.rows || []) {
    const product = asPlainObject(row?.product_data) || {};
    const merchantId = asString(row?.merchant_id || product.merchant_id || product.merchantId);
    const productId = asString(product.product_id || product.id || row?.platform_product_id);
    const sourceListingRef = buildSourceListingRef({ merchantId, productId });
    if (!sourceListingRef || seenInternal.has(sourceListingRef)) continue;
    const brand = normalizeBrandToken(firstNonEmptyString(product.brand?.name, product.brand, product.vendor));
    if (normalizedBrandFilter && brand !== normalizedBrandFilter) continue;
    seenInternal.add(sourceListingRef);
    internalRows.push({
      merchant_id: merchantId,
      product_id: productId,
      source_kind: 'internal',
      product,
      source_meta: {
        cached_at: row?.cached_at || null,
      },
    });
  }

  const externalParams = [];
  const externalWhere = [`status = 'active'`];
  if (normalizedBrandFilter) {
    externalParams.push(normalizedBrandFilter);
    const brandParam = `$${externalParams.length}`;
    externalParams.push(titleBrandPattern);
    const titleParam = `$${externalParams.length}`;
    externalWhere.push(`
      (
        lower(trim(coalesce(
          seed_data #>> '{brand,name}',
          seed_data->>'brand',
          seed_data->>'brand_name',
          seed_data->>'vendor',
          seed_data->>'vendor_name',
          ''
        ))) = ${brandParam}
        OR lower(coalesce(title, seed_data->>'title', seed_data->>'name', '')) LIKE ${titleParam}
      )
    `);
  }
  externalParams.push(normalizedLimit);
  const externalLimitParam = `$${externalParams.length}`;

  const externalRes = await queryFn(
    `
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
        seed_data,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE ${externalWhere.join(' AND ')}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT ${externalLimitParam}
    `,
    externalParams,
  );
  const seenExternal = new Set();
  for (const row of externalRes?.rows || []) {
    const product = buildExternalSeedProduct(row);
    const merchantId = EXTERNAL_SEED_MERCHANT_ID;
    const productId = asString(product?.product_id || row?.external_product_id || row?.id);
    const sourceListingRef = buildSourceListingRef({ merchantId, productId });
    if (!product || !sourceListingRef || seenExternal.has(sourceListingRef)) continue;
    const brand = normalizeBrandToken(firstNonEmptyString(product.brand?.name, product.brand, product.vendor));
    if (normalizedBrandFilter && brand !== normalizedBrandFilter) continue;
    seenExternal.add(sourceListingRef);
    externalRows.push({
      merchant_id: merchantId,
      product_id: productId,
      source_kind: 'external_seed',
      product,
      source_meta: {
        external_seed_id: row?.id || null,
        market: row?.market || null,
        tool: row?.tool || null,
        updated_at: row?.updated_at || null,
      },
    });
  }

  return [...internalRows, ...externalRows];
}

async function loadIdentityOverrides({ queryFn = query } = {}) {
  try {
    const result = await queryFn(
      `
        SELECT *
        FROM pdp_identity_override
        WHERE active = true
        ORDER BY created_at DESC NULLS LAST
      `,
      [],
    );
    return result?.rows || [];
  } catch (err) {
    if (looksLikeRelationMissing(err)) return [];
    throw err;
  }
}

function applyIdentityOverrides(listing, overrides = []) {
  const sourceRef = asString(listing?.source_listing_ref);
  const next = { ...listing };
  for (const row of overrides) {
    const payload = asPlainObject(row?.payload) || {};
    const actionType = asString(row?.action_type);
    const appliesToSource =
      sourceRef &&
      (sourceRef === asString(row?.source_listing_ref) ||
        sourceRef === asString(payload.source_listing_ref));
    if (!appliesToSource) continue;
    if (actionType === 'force_exact_group' && asString(payload.target_sellable_item_group_id)) {
      next.sellable_item_group_id = asString(payload.target_sellable_item_group_id);
    }
    if (actionType === 'force_product_line' && asString(payload.target_product_line_id)) {
      next.product_line_id = asString(payload.target_product_line_id);
      next.review_family_id =
        asString(payload.target_review_family_id) || asString(payload.target_product_line_id);
    }
    if (actionType === 'force_review_family' && asString(payload.target_review_family_id)) {
      next.review_family_id = asString(payload.target_review_family_id);
    }
    if (actionType === 'approve_live_read') {
      next.identity_status = 'approved';
      next.live_read_enabled = true;
      next.review_required = false;
      next.review_reason_codes = [];
    }
    if (actionType === 'deny_live_read') {
      next.live_read_enabled = false;
    }
    if (actionType === 'force_review_required') {
      next.identity_status = 'review_required';
      next.review_required = true;
      next.live_read_enabled = false;
      next.review_reason_codes = uniqueStrings([
        ...asArray(next.review_reason_codes),
        ...asArray(payload.reason_codes),
      ]);
    }
    if (actionType === 'prefer_source_tier' && asString(payload.source_tier)) {
      next.source_tier = asString(payload.source_tier);
    }
  }
  return next;
}

function buildReviewQueueEntries(listings) {
  const entries = [];
  for (const listing of listings || []) {
    if (listing?.identity_status !== 'review_required') continue;
    const sourceRef = asString(listing?.source_listing_ref);
    if (!sourceRef) continue;
    entries.push({
      id: stableHash('rq', [sourceRef, listing.review_reason_codes || []]),
      source_listing_ref: sourceRef,
      candidate_listing_ref: null,
      queue_type: 'exact_item_identity_review',
      status: 'pending',
      reason_codes: asArray(listing.review_reason_codes),
      evidence: {
        strong_identity: listing.strong_identity || {},
        soft_identity: listing.soft_identity || {},
        variant_axes: listing.variant_axes || {},
        match_basis: listing.match_basis || [],
      },
      proposed_sellable_item_group_id: asString(listing?.sellable_item_group_id) || null,
      proposed_product_line_id: asString(listing?.product_line_id) || null,
    });
    if (entries.length >= PDP_IDENTITY_GRAPH_REVIEW_QUEUE_LIMIT) break;
  }
  return entries;
}

async function writeIdentityRows({ listings, reviewQueueEntries, dryRun = false, withClientFn = withClient } = {}) {
  const safeListings = Array.isArray(listings) ? listings : [];
  const safeQueue = Array.isArray(reviewQueueEntries) ? reviewQueueEntries : [];
  if (dryRun || safeListings.length === 0) {
    return {
      written_rows: 0,
      review_queue_rows: 0,
    };
  }

  return withClientFn(async (client) => {
    await client.query('BEGIN');
    try {
      for (const listing of safeListings) {
        await client.query(
          `
            INSERT INTO pdp_identity_listing (
              source_listing_ref,
              merchant_id,
              product_id,
              source_kind,
              source_tier,
              live_read_enabled,
              sellable_item_group_id,
              product_line_id,
              review_family_id,
              identity_status,
              identity_confidence,
              matched_by_rule,
              match_basis,
              strong_identity,
              soft_identity,
              variant_axes,
              source_payload,
              review_summary,
              official_url,
              official_domain,
              brand_norm,
              title_norm,
              title_core_norm,
              review_required,
              review_reason_codes,
              updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,
              $17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24,$25::jsonb, now()
            )
            ON CONFLICT (source_listing_ref) DO UPDATE SET
              merchant_id = EXCLUDED.merchant_id,
              product_id = EXCLUDED.product_id,
              source_kind = EXCLUDED.source_kind,
              source_tier = EXCLUDED.source_tier,
              live_read_enabled = EXCLUDED.live_read_enabled,
              sellable_item_group_id = EXCLUDED.sellable_item_group_id,
              product_line_id = EXCLUDED.product_line_id,
              review_family_id = EXCLUDED.review_family_id,
              identity_status = EXCLUDED.identity_status,
              identity_confidence = EXCLUDED.identity_confidence,
              matched_by_rule = EXCLUDED.matched_by_rule,
              match_basis = EXCLUDED.match_basis,
              strong_identity = EXCLUDED.strong_identity,
              soft_identity = EXCLUDED.soft_identity,
              variant_axes = EXCLUDED.variant_axes,
              source_payload = EXCLUDED.source_payload,
              review_summary = EXCLUDED.review_summary,
              official_url = EXCLUDED.official_url,
              official_domain = EXCLUDED.official_domain,
              brand_norm = EXCLUDED.brand_norm,
              title_norm = EXCLUDED.title_norm,
              title_core_norm = EXCLUDED.title_core_norm,
              review_required = EXCLUDED.review_required,
              review_reason_codes = EXCLUDED.review_reason_codes,
              updated_at = now()
          `,
          [
            listing.source_listing_ref,
            listing.merchant_id,
            listing.product_id,
            listing.source_kind,
            listing.source_tier,
            listing.live_read_enabled === true,
            listing.sellable_item_group_id,
            listing.product_line_id,
            listing.review_family_id,
            listing.identity_status,
            listing.identity_confidence,
            listing.matched_by_rule,
            JSON.stringify(asArray(listing.match_basis)),
            JSON.stringify(asPlainObject(listing.strong_identity) || {}),
            JSON.stringify(asPlainObject(listing.soft_identity) || {}),
            JSON.stringify(asPlainObject(listing.variant_axes) || {}),
            JSON.stringify(asPlainObject(listing.source_payload) || {}),
            JSON.stringify(asPlainObject(listing.review_summary) || {}),
            listing.official_url,
            listing.official_domain,
            listing.brand_norm,
            listing.title_norm,
            listing.title_core_norm,
            listing.review_required === true,
            JSON.stringify(asArray(listing.review_reason_codes)),
          ],
        );
      }

      for (const entry of safeQueue) {
        await client.query(
          `
            INSERT INTO pdp_identity_review_queue (
              id,
              source_listing_ref,
              candidate_listing_ref,
              queue_type,
              status,
              reason_codes,
              evidence,
              proposed_sellable_item_group_id,
              proposed_product_line_id,
              updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9, now())
            ON CONFLICT (id) DO UPDATE SET
              status = EXCLUDED.status,
              reason_codes = EXCLUDED.reason_codes,
              evidence = EXCLUDED.evidence,
              proposed_sellable_item_group_id = EXCLUDED.proposed_sellable_item_group_id,
              proposed_product_line_id = EXCLUDED.proposed_product_line_id,
              updated_at = now()
          `,
          [
            entry.id,
            entry.source_listing_ref,
            entry.candidate_listing_ref,
            entry.queue_type,
            entry.status,
            JSON.stringify(asArray(entry.reason_codes)),
            JSON.stringify(asPlainObject(entry.evidence) || {}),
            entry.proposed_sellable_item_group_id,
            entry.proposed_product_line_id,
          ],
        );
      }

      await client.query('COMMIT');
      return {
        written_rows: safeListings.length,
        review_queue_rows: safeQueue.length,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function backfillPdpIdentityGraph({
  limit = 500,
  brand = null,
  dryRun = false,
  queryFn = query,
  withClientFn = withClient,
} = {}) {
  const sourceRows = await fetchBackfillProducts({
    limit,
    brandFilter: brand,
    queryFn,
  });
  const overrides = await loadIdentityOverrides({ queryFn }).catch((err) => {
    if (looksLikeRelationMissing(err)) return [];
    throw err;
  });
  const listings = clusterIdentityListings(
    sourceRows
      .map((row) =>
        buildIdentityListingFromProduct({
          merchantId: row.merchant_id,
          productId: row.product_id,
          product: row.product,
          sourceKind: row.source_kind,
          sourceMeta: row.source_meta,
        }),
      )
      .filter(Boolean),
  )
    .map((listing) => applyIdentityOverrides(listing, overrides));

  const reviewQueueEntries = buildReviewQueueEntries(listings);
  const writeResult = await writeIdentityRows({
    listings,
    reviewQueueEntries,
    dryRun,
    withClientFn,
  });

  return {
    dry_run: dryRun === true,
    source_rows_scanned: sourceRows.length,
    identity_rows_built: listings.length,
    review_queue_rows_built: reviewQueueEntries.length,
    ...writeResult,
  };
}

async function listPdpIdentityShadowRows({
  limit = 100,
  status = null,
  brand = null,
  queryFn = query,
} = {}) {
  try {
    const params = [];
    const where = [];
    if (status) {
      params.push(asString(status));
      where.push(`identity_status = $${params.length}`);
    }
    if (brand) {
      params.push(normalizeBrandToken(brand));
      where.push(`brand_norm = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    const sql = `
      SELECT *
      FROM pdp_identity_listing
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $${params.length}
    `;
    const result = await queryFn(sql, params);
    return normalizeIdentityRows(result?.rows);
  } catch (err) {
    if (looksLikeRelationMissing(err)) return [];
    throw err;
  }
}

async function listPdpIdentityReviewQueue({
  limit = 100,
  status = null,
  queryFn = query,
} = {}) {
  try {
    const params = [];
    const where = [];
    if (status) {
      params.push(asString(status));
      where.push(`status = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    const sql = `
      SELECT *
      FROM pdp_identity_review_queue
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $${params.length}
    `;
    const result = await queryFn(sql, params);
    return result?.rows || [];
  } catch (err) {
    if (looksLikeRelationMissing(err)) return [];
    throw err;
  }
}

async function listPdpIdentityOverrides({
  limit = 100,
  queryFn = query,
} = {}) {
  try {
    const result = await queryFn(
      `
        SELECT *
        FROM pdp_identity_override
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT $1
      `,
      [Math.max(1, Math.min(500, Number(limit) || 100))],
    );
    return result?.rows || [];
  } catch (err) {
    if (looksLikeRelationMissing(err)) return [];
    throw err;
  }
}

async function applyPdpIdentityOverride({
  actionType,
  sourceListingRef,
  payload = {},
  createdBy = 'admin',
  active = true,
  queryFn = query,
} = {}) {
  const action = asString(actionType);
  const sourceRef = asString(sourceListingRef || payload?.source_listing_ref);
  if (!action || !sourceRef) {
    throw new Error('MISSING_OVERRIDE_INPUT');
  }
  const overridePayload = {
    ...payload,
    source_listing_ref: sourceRef,
  };
  try {
    const overrideId =
      asString(payload?.id) || stableHash('ovr', [action, sourceRef, overridePayload]);
    const result = await queryFn(
      `
        INSERT INTO pdp_identity_override (
          id,
          source_listing_ref,
          action_type,
          payload,
          created_by,
          active,
          updated_at
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6, now())
        ON CONFLICT (id) DO UPDATE SET
          payload = EXCLUDED.payload,
          created_by = EXCLUDED.created_by,
          active = EXCLUDED.active,
          updated_at = now()
        RETURNING *
      `,
      [
        overrideId,
        sourceRef,
        action,
        JSON.stringify(overridePayload),
        asString(createdBy) || 'admin',
        active !== false,
      ],
    );

    if (action === 'approve_live_read' || action === 'deny_live_read' || action === 'force_review_required') {
      const liveReadEnabled = action === 'approve_live_read';
      const identityStatus =
        action === 'force_review_required'
          ? 'review_required'
          : 'approved';
      await queryFn(
        `
          UPDATE pdp_identity_listing
          SET
            live_read_enabled = $2,
            identity_status = $3,
            review_required = $4,
            updated_at = now()
          WHERE source_listing_ref = $1
        `,
        [sourceRef, liveReadEnabled, identityStatus, action === 'force_review_required'],
      );
    }

    return result?.rows?.[0] || null;
  } catch (err) {
    if (looksLikeRelationMissing(err)) {
      const missing = new Error('PDP_IDENTITY_TABLES_NOT_READY');
      missing.code = 'PDP_IDENTITY_TABLES_NOT_READY';
      throw missing;
    }
    throw err;
  }
}

module.exports = {
  buildSourceListingRef,
  buildIdentityListingFromProduct,
  composeSyntheticCanonicalProduct,
  maybeBuildLiveSyntheticPdp,
  listLivePdpIdentityRowsForRefs,
  promotePdpIdentityLiveRead,
  backfillPdpIdentityGraph,
  listPdpIdentityShadowRows,
  listPdpIdentityReviewQueue,
  listPdpIdentityOverrides,
  applyPdpIdentityOverride,
  _internals: {
    extractVariantAxes,
    extractStrongIdentity,
    extractSoftIdentity,
    normalizeTitleCore,
    buildReviewScopeMetadata,
    aggregateReviewSummary,
    applyIdentityOverrides,
    clusterIdentityListings,
    fetchBackfillProducts,
  },
};
