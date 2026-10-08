const { brand: pairBrand, sharedSpecificNameWords } = require('./relationshipPairPolicy');
const {
  isSameProductOrVariant,
  normalizeFamilyKeySegment,
  isRecognizedNumericShadeSegment,
  isRecognizedLexiconShadeSegment,
} = require('./relationshipProductIdentity');
const { coverageCatalogJoinSql, prioritizeUncoveredProducts, productAnchorRefs, loadCoverageSuppressedIds } = require('./relationshipGraphCoverage');
const { readPriceWithCurrency, comparablePriceRatio } = require('./relationshipPriceCurrency');
const { withoutRelationshipPairContext } = require('./relationshipCandidatePairContext');

const DEFAULT_MARKET = 'US';
const DEFAULT_SOURCE_LIMIT = 1000;

const EXTERNAL_SEED_RECALL_SQL_FIELDS = Object.freeze({
  brandDisplay:
    "coalesce(seed_data->'derived'->'recall'->>'brand', seed_data->>'brand', seed_data->>'brand_name', seed_data->>'vendor', seed_data->>'vendor_name', seed_data->'snapshot'->>'brand', seed_data->'snapshot'->>'brand_name', seed_data->'snapshot'->>'vendor', seed_data->'snapshot'->>'vendor_name', '')",
  categoryDisplay:
    "coalesce(seed_data->'derived'->'recall'->>'category', seed_data->>'category', seed_data->'product'->>'category', seed_data->'snapshot'->>'category', seed_data->>'product_type', seed_data->'product'->>'product_type', seed_data->'snapshot'->>'product_type', '')",
  retrievalTitleDisplay: "coalesce(seed_data->'derived'->'recall'->>'retrieval_title', seed_data->>'title', seed_data->'snapshot'->>'title', '')",
  retrievalSummaryDisplay: "coalesce(seed_data->'derived'->'recall'->>'retrieval_summary', seed_data->>'description', seed_data->'snapshot'->>'description', '')",
  ingredientTokensDisplay: "coalesce(seed_data#>>'{derived,recall,ingredient_tokens}', seed_data#>>'{ingredient_tokens}', seed_data#>>'{snapshot,ingredient_tokens}', '')",
  aliasTokensDisplay: "coalesce(seed_data#>>'{derived,recall,alias_tokens}', seed_data#>>'{search_aliases}', seed_data#>>'{aliases}', seed_data#>>'{snapshot,search_aliases}', seed_data#>>'{snapshot,aliases}', '')",
  vertical: "lower(coalesce(seed_data->'derived'->'recall'->>'vertical', ''))",
});

// Codes that mean "this source isn't deployed in this env" — safe to skip.
// Deliberately EXCLUDES 42703 (undefined_column) and 42883 (undefined_function):
// those signal code-vs-schema drift (e.g., a column rename that left a SELECT stale)
// and must surface as errors, not silent empty results.
const SOURCE_MISSING_CODES = new Set([
  'NO_DATABASE',
  '42P01', // undefined_table
  '42704', // undefined_object (covers vector type missing when pgvector ext is absent)
  '0A000', // feature_not_supported (vector ops without extension)
]);

const SOURCE_PRIORITY = {
  relationship_graph_transitive_recall: 0.09,
  approved_live_external_seed: 0.09,
  aurora_dupe_kb: 0.18,
  ingredient_kb: 0.12,
  product_intel_kb: 0.11,
  vector_recall: 0.1,
  external_product_seed: 0.08,
  external_seed: 0.08,
  products_cache: 0.06,
};

const EVIDENCE_GRADE_RANK = {
  A: 4,
  B: 3,
  C: 2,
  D: 1,
};

const BEAUTY_TEXT_PATTERNS = [
  '%beauty%',
  '%skincare%',
  '%skin care%',
  '%serum%',
  '%moisturizer%',
  '%cleanser%',
  '%sunscreen%',
  '%spf%',
  '%makeup%',
  '%cosmetic%',
  '%fragrance%',
  '%hair%',
];

const BEAUTY_VERTICAL_TERMS = [
  'beauty',
  'skincare',
  'skin care',
  'makeup',
  'cosmetic',
  'cosmetics',
  'fragrance',
  'hair',
  'haircare',
  'hair care',
  'serum',
  'moisturizer',
  'cleanser',
  'sunscreen',
  'spf',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceJson(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asPlainObject(value) {
  if (isPlainObject(value)) return value;
  const parsed = coerceJson(value);
  return isPlainObject(parsed) ? parsed : null;
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  if (isPlainObject(value)) {
    return toNumberOrNull(
      value.amount ??
        value.value ??
        value.price ??
        value.min ??
        value.min_price ??
        value.minPrice ??
        value.sale_price ??
        value.salePrice,
    );
  }
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeLimit(limit, fallback = DEFAULT_SOURCE_LIMIT) {
  const n = Number(limit);
  const base = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(1, Math.min(5000, base));
}

function normalizeMarket(value) {
  return normalizeString(value || DEFAULT_MARKET, 24).toUpperCase() || DEFAULT_MARKET;
}

function normalizeEvidenceGrade(value, fallback = 'B') {
  const grade = normalizeString(value, 8).toUpperCase();
  if (EVIDENCE_GRADE_RANK[grade]) return grade;
  return fallback;
}

function betterEvidenceGrade(left, right) {
  const l = normalizeEvidenceGrade(left, '');
  const r = normalizeEvidenceGrade(right, '');
  return (EVIDENCE_GRADE_RANK[r] || 0) > (EVIDENCE_GRADE_RANK[l] || 0) ? r : l || r || 'B';
}

function normalizeProductRef(value, fallbackPrefix = 'product') {
  const text = normalizeString(value, 512);
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return `url:${text}`;
  if (/^[a-z][a-z0-9_+-]*:/i.test(text)) return text;
  const prefix = normalizeLower(fallbackPrefix, 40) || 'product';
  return `${prefix}:${text}`;
}

function stripRefPrefix(value) {
  return normalizeString(value, 512).replace(/^[a-z][a-z0-9_+-]*:/i, '');
}

const RETAILER_OR_MARKETPLACE_HOST_TOKENS = new Set([
  'amazon',
  'boots',
  'iherb',
  'moidaus',
  'sephora',
  'skincupid',
  'target',
  'tiktok',
  'ulta',
  'walmart',
  'yesstyle',
]);

function inferBrandFromOfficialUrl(value) {
  const text = normalizeString(value, 500);
  if (!/^https?:\/\//i.test(text)) return '';
  let host = '';
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return '';
  }
  const parts = host.split('.').filter(Boolean);
  while (['www', 'shop', 'us', 'global'].includes(parts[0])) parts.shift();
  const root = parts[0] || '';
  if (!root || RETAILER_OR_MARKETPLACE_HOST_TOKENS.has(root)) return '';
  const words = root
    .replace(/(beauty|cosmetics|skincare|skin|official)$/i, ' $1')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (!words.length) return '';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function normalizeTokenText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTokenText(item)).filter(Boolean).join(' ');
  }
  if (isPlainObject(value)) {
    return [
      value.name,
      value.label,
      value.title,
      value.tag,
      value.headline,
      value.body,
      value.step,
      value.category,
      value.inci_name,
      value.inci,
    ].map((item) => normalizeTokenText(item)).filter(Boolean).join(' ');
  }
  return normalizeString(value, 2000);
}

function normalizeTextList(value, max = 20) {
  const input = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const raw of input.flatMap((item) => {
    if (Array.isArray(item)) return item;
    if (isPlainObject(item)) {
      return [item.name, item.label, item.title, item.tag, item.headline, item.body, item.step, item.category];
    }
    if (typeof item === 'string' && /[,|;>]/.test(item)) return item.split(/[,|;>]/g);
    return [item];
  })) {
    const text = normalizeString(raw, 140);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeCategoryTaxonomy(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    for (const token of normalizeTextList(value, 12)) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function collectTextFragments(value, maxFragments = 32, depth = 0) {
  if (depth > 4 || maxFragments <= 0) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    const text = normalizeString(value, 400);
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(...collectTextFragments(item, maxFragments - out.length, depth + 1));
      if (out.length >= maxFragments) break;
    }
    return out;
  }
  if (isPlainObject(value)) {
    const preferredKeys = [
      'what_it_is', 'whatItIs', 'routine_fit', 'routineFit', 'best_for',
      'why_it_stands_out', 'watchouts', 'pairing_notes', 'am_pm',
      'headline',
      'body',
      'label',
      'tag',
      'name',
      'title',
      'summary',
      'description',
      'step',
      'texture',
      'finish',
    ];
    const out = [];
    for (const key of preferredKeys) {
      if (!(key in value)) continue;
      out.push(...collectTextFragments(value[key], maxFragments - out.length, depth + 1));
      if (out.length >= maxFragments) break;
    }
    return out;
  }
  return [];
}

function extractProductIntelBundle(value) {
  const obj = asPlainObject(value);
  if (!obj) return null;
  return (
    asPlainObject(obj.product_intel_v1) ||
    asPlainObject(obj.product_intel) ||
    (asPlainObject(obj.product_intel_core) || asPlainObject(obj.core) ? obj : null)
  );
}

function extractProductIntelCore(bundle) {
  const obj = asPlainObject(bundle);
  return asPlainObject(obj?.product_intel_core) || asPlainObject(obj?.core) || null;
}

function normalizeSourceRefs(value, fallbackRef = null) {
  const refs = [];
  const seen = new Set();
  const push = (raw) => {
    const src = typeof raw === 'string' ? { type: raw } : isPlainObject(raw) ? raw : null;
    if (!src) return;
    const type = normalizeLower(src.type || src.source_type || src.source, 80);
    const name = normalizeString(src.name || src.label || src.title || src.table || src.source_id || src.id, 180);
    const url = normalizeString(src.url || src.href || src.canonical_url || src.source_ref, 500);
    const observedAt = toIsoOrNull(src.observed_at || src.observedAt);
    if (!type && !name && !url) return;
    const key = `${type}::${name}::${url}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      ...(type ? { type } : {}),
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
      ...(typeof src.authoritative === 'boolean' ? { authoritative: src.authoritative }
        : src.authority === true ? { authoritative: true } : {}),
      ...(src.evidence_kind ? { evidence_kind: normalizeString(src.evidence_kind, 80) } : {}),
      ...(src.evidence_profile ? { evidence_profile: normalizeString(src.evidence_profile, 120) } : {}),
      ...(src.confidence != null ? { confidence: typeof src.confidence === 'number' ? clamp01(src.confidence) : normalizeString(src.confidence, 80) } : {}),
      ...(src.review_status ? { review_status: normalizeString(src.review_status, 80) } : {}),
      ...(observedAt ? { observed_at: observedAt } : {}),
    });
  };
  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else {
    push(value);
  }
  push(fallbackRef);
  return refs.slice(0, 16);
}

function mergeSourceRefs(...refsLists) {
  return normalizeSourceRefs(refsLists.flatMap((refs) => (Array.isArray(refs) ? refs : [refs])).filter(Boolean));
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function firstObject(...values) {
  for (const value of values) {
    const obj = asPlainObject(value);
    if (obj) return obj;
  }
  return {};
}

function sourceTypesFromRefs(sourceRefs) {
  return normalizeSourceRefs(sourceRefs).map((ref) => normalizeLower(ref.type)).filter(Boolean);
}

function sourceStrength(sourceRefs) {
  let strength = 0;
  for (const ref of normalizeSourceRefs(sourceRefs)) {
    strength = Math.max(strength, (SOURCE_PRIORITY[ref.type] || 0) * (ref.authoritative === false ? 0.35 : 1));
  }
  return strength;
}

function normalizeProductCandidateSnapshot(input = {}, options = {}) {
  const row = asPlainObject(input) || {};
  const productPayload = firstObject(row.product_payload, row.productPayload);
  const productData = firstObject(row.product_data, row.productData, row.product, row.sku, row.item);
  const seedData = firstObject(row.seed_data, row.seedData);
  const snapshot = firstObject(row.snapshot, productPayload.snapshot, productData.snapshot, seedData.snapshot, seedData.product, seedData.sku);
  const product = {
    ...seedData,
    ...productData,
    ...snapshot,
  };
  const analysis = firstObject(row.analysis, product.analysis);
  const intelBundle =
    extractProductIntelBundle(row.product_intel) ||
    extractProductIntelBundle(row.productIntel) ||
    extractProductIntelBundle(analysis) ||
    extractProductIntelBundle(product);
  const intelCore = extractProductIntelCore(intelBundle);
  const canonicalProductRef = firstObject(intelBundle?.canonical_product_ref, row.canonical_product_ref);
  const sourceMeta = firstObject(row.source_meta, row.sourceMeta, intelBundle?.provenance, product.provenance);
  const variants = firstArray(product.variants, seedData.variants, snapshot.variants);
  const firstVariant = firstObject(variants[0]);
  const officialSourceUrl = pickFirstString(
    row.official_source_url,
    row.officialSourceUrl,
    product.official_source_url,
    product.officialSourceUrl,
    sourceMeta.official_source_url,
    sourceMeta.officialSourceUrl,
    sourceMeta.source_url,
    sourceMeta.sourceUrl,
  );

  const productId = pickFirstString(
    row.product_id,
    row.productId,
    row.external_product_id,
    row.externalProductId,
    row.attached_product_key,
    row.sku_key,
    row.product_key,
    product.product_id,
    product.productId,
    product.sku_id,
    product.skuId,
    product.id,
    product.external_product_id,
    canonicalProductRef.product_id,
    canonicalProductRef.productId,
    canonicalProductRef.external_product_id,
  );
  const rawRef = pickFirstString(
    options.productRef,
    row.product_ref,
    row.productRef,
    product.product_ref,
    product.productRef,
    productId,
    row.kb_key && /^product:/i.test(String(row.kb_key)) ? row.kb_key : '',
    product.url,
    product.canonical_url,
    row.canonical_url,
    row.destination_url,
    officialSourceUrl,
  );

  const brand = pickFirstString(
    row.brand,
    row.brand_name,
    row.brandName,
    product.brand,
    product.brand_name,
    product.brandName,
    product.vendor,
    product.vendor_name,
    seedData.brand,
    sourceMeta.brand,
    canonicalProductRef.brand,
    inferBrandFromOfficialUrl(officialSourceUrl),
  );
  const name = pickFirstString(
    row.name,
    row.title,
    row.product_name,
    row.productName,
    product.name,
    product.display_name,
    product.displayName,
    product.title,
    product.product_name,
    product.productName,
    firstVariant.title,
    intelBundle?.search_card?.title_candidate,
    intelBundle?.searchCard?.titleCandidate,
    intelBundle?.shopping_card?.title,
    intelBundle?.shoppingCard?.title,
    intelCore?.what_it_is?.headline,
    intelCore?.whatItIs?.headline,
  );
  const categoryTaxonomy = normalizeCategoryTaxonomy(
    row.category_taxonomy,
    row.categoryTaxonomy,
    product.category_taxonomy,
    product.categoryTaxonomy,
    row.category,
    product.category,
    product.product_type,
    product.productType,
    product.product_category,
    intelCore?.routine_fit?.step,
    intelCore?.routineFit?.step,
    intelCore?.best_for,
  );
  const category = pickFirstString(row.category, product.category, product.product_type, categoryTaxonomy[0]);
  // The amount and its currency come from ONE record. `product` is a spread of seed_data /
  // product_data / snapshot, so its price fields are read from the layer the spread would take them
  // from, and that layer's currency goes with them.
  const productLayers = [seedData, productData, snapshot];
  const pricedAt = readPriceWithCurrency(
    [
      [row, 'price'],
      [row, 'price_amount'],
      [row, 'priceAmount'],
      [productLayers, 'price'],
      [productLayers, 'price_amount'],
      [productLayers, 'priceAmount'],
      [productLayers, 'sale_price'],
      [productLayers, 'salePrice'],
      [firstVariant, 'price'],
      [firstVariant, 'price_amount'],
    ],
    toNumberOrNull,
  );
  const price = pricedAt.amount;
  const availability = pickFirstString(
    row.availability,
    row.availability_status,
    row.availabilityStatus,
    product.availability,
    product.availability_status,
    product.availabilityStatus,
    seedData.availability,
    seedData.availability_status,
    seedData.availabilityStatus,
    snapshot.availability,
    snapshot.availability_status,
    snapshot.availabilityStatus,
    firstVariant.availability,
    firstVariant.availability_status,
    firstVariant.availabilityStatus,
  );
  const url = pickFirstString(
    row.canonical_url,
    row.destination_url,
    row.url,
    canonicalProductRef.canonical_url,
    canonicalProductRef.url,
    intelBundle?.source_coverage?.canonical_url,
    intelCore?.source_coverage?.canonical_url,
    product.canonical_url,
    product.canonicalUrl,
    product.destination_url,
    product.destinationUrl,
    product.url,
    product.pdp_url,
    product.pdpUrl,
    firstVariant.url,
    officialSourceUrl,
  );
  const observedAt =
    toIsoOrNull(options.observedAt) ||
    toIsoOrNull(row.observed_at || row.observedAt) ||
    toIsoOrNull(row.last_success_at) ||
    toIsoOrNull(row.verified_at) ||
    toIsoOrNull(row.updated_at) ||
    toIsoOrNull(row.cached_at) ||
    toIsoOrNull(row.created_at) ||
    toIsoOrNull(intelCore?.freshness?.generated_at) ||
    null;
  const sourceType = normalizeLower(options.sourceType || row._source_type || row.source_type || row.sourceType || row.source, 80);
  const sourceName = normalizeString(options.sourceName || options.table || row.source || row.kb_key || row.id, 180);
  const fallbackSourceRef = sourceType && (!row._source_type || options.sourceType)
    ? {
      type: sourceType,
      name: sourceName || sourceType,
      url,
      authoritative: options.authoritative !== false,
      ...firstObject(options.sourceEvidence),
      observed_at: observedAt,
    }
    : null;
  const sourceRefs = normalizeSourceRefs(row.source_refs || row.sourceRefs || product.source_refs, fallbackSourceRef);
  const intelText = collectTextFragments(intelCore).join(' ');
  const description = pickFirstString(
    row.description,
    row.summary,
    product.description,
    product.body_html,
    product.bodyHtml,
    product.pdp_description_raw,
    seedData.pdp_description_raw,
    seedData.description,
    intelCore?.what_it_is?.body,
    intelCore?.whatItIs?.body,
    intelText,
  );
  const ingredientText = row.ingredient_evidence_conflict === true || row.ingredient_evidence_incomplete === true ? '' : [
    row.ingredient_text,
    product.ingredient_text,
    row.raw_ingredient_text_clean,
    row.inci_list,
    row.raw_inci,
    product.raw_ingredient_text_clean,
    product.inci_list,
    product.raw_inci,
    normalizeTokenText(product.ingredients),
    normalizeTokenText(product.ingredient_ids),
    normalizeTokenText(coerceJson(row.normalized_ingredients_json) || row.normalized_ingredients_json),
    normalizeTokenText(coerceJson(row.active_ingredients_json) || row.active_ingredients_json),
  ].map((item) => normalizeString(item, 6000)).find(Boolean) || '';
  const tags = normalizeTextList(
    [
      row.tags,
      product.tags,
      product.labels,
      product.ingredient_ids,
      categoryTaxonomy,
      intelCore?.best_for,
      intelCore?.routine_fit?.am_pm,
      intelCore?.routineFit?.am_pm,
    ].flat(),
    32,
  );
  const variantTitle = pickFirstString(
    row.variant_title,
    row.variantTitle,
    productPayload.variant_title,
    productPayload.variantTitle,
    product.variant_title,
    product.variantTitle,
    seedData.variant_title,
    seedData.variantTitle,
    snapshot.variant_title,
    snapshot.variantTitle,
    canonicalProductRef.variant_title, canonicalProductRef.variantTitle,
  );
  const variantDetailLabel = pickFirstString(
    row.variant_detail_label,
    row.variantDetailLabel,
    productPayload.variant_detail_label,
    productPayload.variantDetailLabel,
    product.variant_detail_label,
    product.variantDetailLabel,
    seedData.variant_detail_label,
    seedData.variantDetailLabel,
    snapshot.variant_detail_label,
    snapshot.variantDetailLabel,
    canonicalProductRef.variant_detail_label, canonicalProductRef.variantDetailLabel,
  );
  const ref = normalizeProductRef(rawRef || (brand && name ? `text:${brand}:${name}` : name ? `text:${name}` : ''));
  if (!ref) return null;

  return {
    product_ref: ref,
    product_id: productId || ref.replace(/^[a-z][a-z0-9_+-]*:/i, ''),
    source_product_id: pickFirstString(row.source_product_id, row.sourceProductId, product.source_product_id, product.sourceProductId),
    pivota_signature_id: pickFirstString(
      row.pivota_signature_id,
      row.pivotaSignatureId,
      row.sig_id,
      row.sigId,
      product.pivota_signature_id,
      product.pivotaSignatureId,
      canonicalProductRef.pivota_signature_id,
      canonicalProductRef.pivotaSignatureId,
    ),
    content_key: pickFirstString(row.content_key, row.contentKey, product.content_key, product.contentKey),
    product_key: pickFirstString(row.product_key, row.productKey, product.product_key, product.productKey, canonicalProductRef.product_key),
    merchant_id: pickFirstString(row.merchant_id, row.merchantId, product.merchant_id, canonicalProductRef.merchant_id),
    platform: pickFirstString(row.platform, product.platform, canonicalProductRef.platform),
    market: pickFirstString(row.market, product.market, canonicalProductRef.market),
    sku_key: pickFirstString(row.sku_key, product.sku_key),
    brand,
    name,
    category,
    category_taxonomy: categoryTaxonomy,
    price,
    // Always present beside `price` (null when unknown), so a merge that spreads one record over
    // another moves the amount and its currency together.
    price_currency: pricedAt.currency,
    ...(availability ? { availability } : {}),
    ...(url ? { url } : {}),
    ...(description ? { description } : {}),
    ...(ingredientText ? { ingredient_text: ingredientText } : {}),
    ...(Array.isArray(row.ingredient_evidence) ? { ingredient_evidence: row.ingredient_evidence.slice(0, 8) } : {}),
    ...(row.ingredient_evidence_conflict === true ? { ingredient_evidence_conflict: true } : {}),
    ...(row.ingredient_evidence_incomplete === true ? { ingredient_evidence_incomplete: true } : {}),
    ...(row.ingredient_text_truncated === true ? { ingredient_text_truncated: true } : {}),
    ...(row.product_intel_evidence_incomplete === true ? { product_intel_evidence_incomplete: true } : {}),
    ...(tags.length ? { tags } : {}),
    ...(variantTitle ? { variant_title: variantTitle } : {}),
    ...(variantDetailLabel ? { variant_detail_label: variantDetailLabel } : {}),
    source_refs: sourceRefs,
    evidence_grade: normalizeEvidenceGrade(
      options.evidenceGrade ||
        row.evidence_grade ||
        row.evidenceGrade ||
        (sourceType === 'aurora_dupe_kb' && row.verified === true ? 'A' : 'B'),
      'B',
    ),
    observed_at: observedAt,
    price_observed_at: toIsoOrNull(row.price_observed_at || row.priceObservedAt) || observedAt,
    product_family_id: pickFirstString(
      row.product_family_id,
      row.productFamilyId,
      product.product_family_id,
      product.productFamilyId,
      product.product_line_id,
      product.productLineId,
      product.variant_of,
      product.variantOf,
    ),
    ...(intelBundle ? { product_intel: intelBundle } : {}),
    ...(row.product_intel_binding ? { product_intel_binding: row.product_intel_binding } : {}),
    ...(row._product_intel_record_ref ? { _product_intel_record_ref: row._product_intel_record_ref } : {}),
    ...(row._graph_seller_identity_key ? { _graph_seller_identity_key: row._graph_seller_identity_key, _graph_seller_record: row._graph_seller_record } : {}),
    ...(intelText ? { intel_text: intelText } : {}),
    _source_type: sourceType || '',
  };
}

function normalizeProductsCacheRow(row = {}) {
  return normalizeProductCandidateSnapshot(row, {
    sourceType: 'products_cache',
    sourceName: 'products_cache',
    observedAt: row.updated_at || row.cached_at || row.created_at,
    authoritative: true,
    evidenceGrade: 'B',
  });
}

function normalizeExternalProductSeedRow(row = {}) {
  return normalizeProductCandidateSnapshot(row, {
    sourceType: 'external_product_seed',
    sourceName: row.external_product_id || row.id || 'external_product_seeds',
    observedAt: row.updated_at || row.created_at,
    authoritative: true,
    evidenceGrade: row.evidence_grade || 'B',
  });
}

function normalizeCatalogProductRow(row = {}) {
  const productPayload = firstObject(row.product_payload, row.productData, row.product_data);
  const productRef = pickFirstString(
    row.product_ref,
    row.pivota_signature_id ? `product:${row.pivota_signature_id}` : '',
    row.source_product_id ? `product:${row.source_product_id}` : '',
    row.product_key,
  );
  return normalizeProductCandidateSnapshot(
    {
      ...productPayload,
      ...row,
      product_ref: productRef,
      product_id: row.source_product_id || row.pivota_signature_id || row.product_key,
      name: row.title || productPayload.title || productPayload.name,
      source_refs: row.source_refs,
    },
    {
      productRef,
      sourceType: 'catalog_products',
      sourceName: row.product_key || row.source_product_id || 'catalog_products',
      observedAt: row.updated_at || row.created_at,
      authoritative: true,
      evidenceGrade: 'B',
    },
  );
}

function normalizeApprovedLiveExternalSeedRow(row = {}) {
  const seedData = firstObject(row.seed_data, row.seedData);
  const catalogPayload = firstObject(row.catalog_product_payload, row.product_payload, row.productPayload);
  const productId = pickFirstString(row.external_product_id, row.externalProductId, row.id);
  const brand = pickFirstString(row.catalog_brand, row.brand, seedData.brand, catalogPayload.brand);
  const title = pickFirstString(row.catalog_title, row.title, seedData.title, catalogPayload.title, catalogPayload.name);
  const category = pickFirstString(
    row.catalog_category,
    row.catalog_product_type,
    row.catalog_category_path,
    row.category,
    seedData.category,
    seedData.product_type,
    catalogPayload.category,
    catalogPayload.product_type,
  );
  const canonicalUrl = pickFirstString(
    row.catalog_canonical_url,
    row.canonical_url,
    row.destination_url,
    seedData.canonical_url,
    catalogPayload.canonical_url,
    catalogPayload.url,
  );
  const description = pickFirstString(
    row.catalog_description,
    row.description,
    seedData.pdp_description_raw,
    seedData.description,
    catalogPayload.description,
    catalogPayload.body_html,
  );
  const productFamilyId = pickFirstString(
    row.product_family_id,
    row.sellable_item_group_id,
    row.product_line_id,
    row.review_family_id,
    catalogPayload.product_family_id,
    catalogPayload.product_line_id,
  );

  return normalizeProductCandidateSnapshot(
    {
      ...row,
      product_ref: productId ? `product:${productId}` : row.product_ref,
      external_product_id: productId,
      title,
      brand,
      category,
      canonical_url: canonicalUrl,
      description,
      product_family_id: productFamilyId,
      seed_data: {
        ...seedData,
        product_id: productId || seedData.product_id,
        title: title || seedData.title,
        brand: brand || seedData.brand,
        category: category || seedData.category,
        canonical_url: canonicalUrl || seedData.canonical_url,
        description: description || seedData.description,
        product_family_id: productFamilyId || seedData.product_family_id,
      },
      product_data: {
        ...catalogPayload,
        product_id: productId || catalogPayload.product_id,
        title: title || catalogPayload.title,
        brand: brand || catalogPayload.brand,
        category: category || catalogPayload.category,
        product_type: pickFirstString(row.catalog_product_type, catalogPayload.product_type),
        category_taxonomy: normalizeCategoryTaxonomy(
          row.catalog_category_path,
          row.catalog_category,
          row.catalog_product_type,
          catalogPayload.category_taxonomy,
          catalogPayload.category_path,
        ),
        canonical_url: canonicalUrl || catalogPayload.canonical_url,
        description: description || catalogPayload.description,
        product_family_id: productFamilyId || catalogPayload.product_family_id,
      },
      source_refs: mergeSourceRefs(
        row.source_refs,
        { type: 'approved_live_external_seed', name: productId || row.id || 'external_product_seeds', authoritative: true, url: canonicalUrl },
        { type: 'external_product_seed', name: productId || row.id || 'external_product_seeds', authoritative: true, url: row.canonical_url || row.destination_url },
        row.catalog_product_key ? { type: 'catalog_products', name: row.catalog_product_key, authoritative: true, url: canonicalUrl } : null,
      ),
    },
    {
      sourceType: 'approved_live_external_seed',
      sourceName: productId || row.id || 'external_product_seeds',
      observedAt: row.catalog_updated_at || row.updated_at || row.created_at,
      authoritative: true,
      evidenceGrade: row.evidence_grade || 'B',
    },
  );
}

// Normalize representations of immutable identifiers, never infer them from
// titles/family names or from the target being hydrated. Conflicting aliases
// are evidence contradictions, not a precedence choice.
function normalizeProductIntelCanonicalRef(input = {}) {
  const canonical = firstObject(input);
  const result = { ...canonical };
  const aliases = { product_key: ['product_key', 'productKey'], pivota_signature_id: ['pivota_signature_id', 'pivotaSignatureId'],
    product_id: ['product_id', 'productId'], source_product_id: ['source_product_id', 'sourceProductId'],
    product_ref: ['product_ref', 'productRef'], merchant_id: ['merchant_id', 'merchantId'],
    variant_title: ['variant_title', 'variantTitle'], variant_detail_label: ['variant_detail_label', 'variantDetailLabel'] };
  for (const [field, names] of Object.entries(aliases)) {
    const rawValues = names.map((name) => canonical[name]).filter((value) => value != null && value !== '');
    if (rawValues.some((value) => String(value).length > 512 || /[\x00-\x1f]/.test(String(value)))) return null;
    const values = rawValues.map((value) => normalizeString(value, 512)).filter(Boolean);
    const compare = field.startsWith('variant_') ? (value) => value.toLowerCase()
      : field === 'product_id' ? (value) => value.replace(/^product:(?=(?:sig_|ext_))/i, '') : (value) => value;
    if (new Set(values.map(compare)).size > 1) return null;
    if (values.length) result[field] = field === 'product_id' ? compare(values[0]) : values[0];
  }
  const signatures = [result.pivota_signature_id, ...[result.product_ref, result.product_id]
    .map((value) => normalizeString(value).replace(/^product:/i, '')).filter((value) => /^sig_/i.test(value))].filter(Boolean);
  if (new Set(signatures).size > 1) return null;
  if (signatures.length) result.pivota_signature_id = signatures[0];
  return result;
}

function normalizeProductIntelKbRow(row = {}) {
  const analysis = firstObject(row.analysis);
  const bundle = extractProductIntelBundle(row.product_intel) || extractProductIntelBundle(analysis);
  if (!bundle) return null;
  const canonical = normalizeProductIntelCanonicalRef(bundle?.canonical_product_ref);
  if (!canonical) return null;
  const core = extractProductIntelCore(bundle) || {};
  const sourceMeta = firstObject(row.source_meta);
  const evidenceProfile = pickFirstString(bundle.evidence_profile, core.evidence_profile, sourceMeta.evidence_profile) || 'unknown';
  const qualityState = normalizeLower(bundle.quality_state || core.quality_state || sourceMeta.quality_state);
  const reviewDecision = normalizeLower(bundle.provenance?.review_decision || sourceMeta.review_decision);
  const denied = ['reject', 'reject_external', 'rejected', 'blocked', 'failed', 'fail', 'suppressed', 'needs_review'];
  if ([bundle.quality_state, core.quality_state, sourceMeta.quality_state,
    bundle.provenance?.review_decision, sourceMeta.review_decision].some((state) => denied.includes(normalizeLower(state)))) return null;
  // KB membership documents a product; it does not verify market consensus. Preserve the
  // source's actual profile and confidence so reviewers can distinguish seller facts from proof.
  const authoritative = /official_pdp_reviewed/.test(evidenceProfile) && qualityState === 'reviewed';
  const confidence = firstObject(bundle.confidence, sourceMeta.confidence);
  const projectedBundle = {
    ...bundle,
    canonical_product_ref: canonical,
    evidence_profile: evidenceProfile,
    ...(bundle.quality_state === undefined && qualityState ? { quality_state: qualityState } : {}),
    ...(bundle.confidence === undefined && Object.keys(confidence).length ? { confidence } : {}),
    ...(bundle.freshness === undefined && sourceMeta.freshness ? { freshness: sourceMeta.freshness } : {}),
    ...(Object.keys(sourceMeta).length ? { provenance: { ...sourceMeta, ...firstObject(bundle.provenance) } } : {}),
  };
  const productRef = pickFirstString(
    row.product_ref,
    row.productRef,
    canonical.pivota_signature_id ? `product:${canonical.pivota_signature_id}` : '',
    canonical.product_ref,
    canonical.productRef,
    canonical.product_id,
    canonical.productId,
    row.kb_key && /^product:/i.test(String(row.kb_key)) ? row.kb_key : '',
    row.kb_key,
  );
  const normalized = normalizeProductCandidateSnapshot(
    {
      ...row,
      product_ref: productRef,
      product_intel: projectedBundle,
      source_refs: row.source_refs,
    },
    {
      productRef,
      sourceType: 'product_intel_kb',
      sourceName: row.source || row.kb_key || 'aurora_product_intel_kb',
      observedAt: row.last_success_at || row.updated_at || row.created_at,
      authoritative,
      evidenceGrade: authoritative ? 'B' : 'C',
      sourceEvidence: { evidence_kind: 'product_context', evidence_profile: evidenceProfile,
        ...(confidence.tier ? { confidence: confidence.tier } : {}) },
    },
  );
  if (!normalized || evidenceIdentityConflicts(normalized, canonical)) return null;
  return { ...normalized, _product_intel_record_ref: normalizeString(row.kb_key || row._product_intel_record_ref || productRef, 512) };
}

function normalizeIngredientKbRow(row = {}, options = {}) {
  const table = normalizeString(options.table || row.table || 'ingredient_kb', 120);
  if (!ingredientRowAllowed(row, table)) return null;
  if (Array.isArray(row.ingredient_evidence) && row.ingredient_evidence.length) return {
    ...normalizeProductCandidateSnapshot(row),
    ...(row.reviewed_ingredient_identity_key ? { reviewed_ingredient_identity_key: row.reviewed_ingredient_identity_key } : {}),
  };
  const normalized = normalizeProductCandidateSnapshot(
    {
      ...row,
      product_ref: pickFirstString(row.product_ref, row.pivota_signature_id ? `product:${row.pivota_signature_id}` : '', row.product_key, row.sku_key, row.source_ref),
      name: pickFirstString(row.product_name, row.name, row.product_key, row.sku_key),
      description: [row.raw_ingredient_text_clean, row.inci_list, row.raw_inci].filter(Boolean).join(' '),
      url: /^https?:\/\//i.test(row.source_ref || '') ? row.source_ref : row.url,
      source_refs: mergeSourceRefs(row.source_refs, coerceJson(row.evidence_refs_json)),
    },
    {
      sourceType: 'ingredient_kb',
      sourceName: table,
      observedAt: table === 'public.relgraph_reviewed_ingredient_evidence' ? row.source_observed_at : row.updated_at || row.created_at,
      authoritative: true,
      evidenceGrade: 'B',
      sourceEvidence: { evidence_kind: 'ingredient_list', review_status: row.review_status || row.audit_status || 'kb_reviewed' },
    },
  );
  if (!normalized || !normalized.ingredient_text) return null;
  return { ...normalized, ingredient_evidence: [{
    table, sku_key: normalizeString(row.sku_key), product_key: normalizeString(row.product_key),
    ...Object.fromEntries(['product_ref', 'product_id', 'source_product_id', 'pivota_signature_id', 'merchant_id',
      'platform', 'market', 'variant_title', 'variant_detail_label', 'url'].map((field) => [field, normalized[field] || ''])),
    ingredient_text: normalized.ingredient_text, observed_at: normalized.observed_at,
    source_refs: normalized.source_refs, source_system: normalizeString(row.source_system),
    parse_status: normalizeString(row.parse_status), review_status: normalizeString(row.review_status),
    audit_status: normalizeString(row.audit_status), ingest_allowed: row.ingest_allowed ?? null,
  }] };
}

function ingredientRowAllowed(row, table) {
  const denied = new Set(['reject', 'rejected', 'blocked', 'failed', 'fail', 'needs_review']);
  if (row.ingest_allowed === false || row.ingest_allowed === 'false') return false;
  if ([row.review_status, row.audit_status, row.parse_status].some((value) => denied.has(normalizeLower(value)))) return false;
  if (table === 'public.beauty_sku_ingredients') return true; // Reviewed, trusted authority store.
  if (Array.isArray(row.ingredient_evidence) && row.ingredient_evidence.length) {
    return row.ingredient_evidence.every((evidence) => ingredientRowAllowed(evidence, evidence.table));
  }
  return row.ingest_allowed === true || normalizeLower(row.parse_status) === 'ok';
}

function normalizeLegacyDupeCandidate(item, row, relationHint) {
  const candidate = normalizeProductCandidateSnapshot(item, {
    sourceType: 'aurora_dupe_kb',
    sourceName: row.kb_key || row.source || 'aurora_dupe_kb',
    observedAt: row.verified_at || row.updated_at || row.created_at,
    authoritative: row.verified === true,
    evidenceGrade: row.verified === true ? 'A' : 'B',
  });
  if (!candidate) return null;
  return {
    ...candidate,
    relation_hint: relationHint,
    legacy_dupe_kb_key: normalizeString(row.kb_key, 256),
  };
}

function normalizeLegacyDupeKbRow(row = {}) {
  const sourceRow = asPlainObject(row) || {};
  const original = normalizeProductCandidateSnapshot(sourceRow.original || { product_ref: sourceRow.kb_key }, {
    sourceType: 'aurora_dupe_kb',
    sourceName: sourceRow.kb_key || sourceRow.source || 'aurora_dupe_kb',
    observedAt: sourceRow.verified_at || sourceRow.updated_at || sourceRow.created_at,
    authoritative: sourceRow.verified === true,
    evidenceGrade: sourceRow.verified === true ? 'A' : 'B',
  });
  const dupes = (Array.isArray(sourceRow.dupes) ? sourceRow.dupes : coerceJson(sourceRow.dupes) || [])
    .map((item) => normalizeLegacyDupeCandidate(item, sourceRow, 'dupe'))
    .filter(Boolean);
  const comparables = (Array.isArray(sourceRow.comparables) ? sourceRow.comparables : coerceJson(sourceRow.comparables) || [])
    .map((item) => normalizeLegacyDupeCandidate(item, sourceRow, 'competitive_alternative'))
    .filter(Boolean);
  return {
    kb_key: normalizeString(sourceRow.kb_key, 256),
    original,
    dupes,
    comparables,
    verified: sourceRow.verified === true,
    verified_at: toIsoOrNull(sourceRow.verified_at),
    source: normalizeString(sourceRow.source || 'aurora_dupe_kb', 120),
    source_meta: firstObject(sourceRow.source_meta),
    updated_at: toIsoOrNull(sourceRow.updated_at),
  };
}

function isSourceMissingError(err) {
  const code = normalizeString(err && err.code, 20);
  if (SOURCE_MISSING_CODES.has(code)) return true;
  const msg = normalizeLower(err && (err.message || err.detail || err.toString()), 1000);
  // Only swallow whole-table/extension absence; column or function drift must throw.
  return (
    /relation .* does not exist/.test(msg) ||
    /schema .* does not exist/.test(msg) ||
    /type .*vector.* does not exist/.test(msg) ||
    /extension .*vector.* is not available/.test(msg)
  );
}

async function guardedRows(queryFn, sql, params = []) {
  if (typeof queryFn !== 'function') return [];
  try {
    const res = await queryFn(sql, params);
    return Array.isArray(res?.rows) ? res.rows : [];
  } catch (err) {
    if (isSourceMissingError(err)) return [];
    throw err;
  }
}

async function tableExists(queryFn, regclassName) {
  const rows = await guardedRows(queryFn, `SELECT to_regclass($1) AS table_name`, [regclassName]);
  return Boolean(rows?.[0]?.table_name);
}

async function loadProductsCacheCandidates({ queryFn, limit = DEFAULT_SOURCE_LIMIT } = {}) {
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        COALESCE(
          NULLIF(platform_product_id, ''),
          NULLIF(product_data->>'product_id', ''),
          NULLIF(product_data->>'id', ''),
          id::text
        ) AS product_ref,
        product_data,
        cached_at
      FROM products_cache
      WHERE lower(to_jsonb(product_data)::text) LIKE ANY($2::text[])
      ORDER BY cached_at DESC NULLS LAST, id DESC
      LIMIT $1
    `,
    [normalizeLimit(limit), BEAUTY_TEXT_PATTERNS],
  );
  return rows.map(normalizeProductsCacheRow).filter(Boolean);
}

async function loadExternalProductSeedCandidates({ queryFn, limit = DEFAULT_SOURCE_LIMIT, market = DEFAULT_MARKET } = {}) {
  const normalizedMarket = normalizeMarket(market);
  const rowLimit = normalizeLimit(limit);
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        id,
        external_product_id,
        attached_product_key,
        title,
        availability,
        price_amount,
        price_currency,
        market,
        canonical_url,
        destination_url,
        jsonb_strip_nulls(jsonb_build_object(
          'brand', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.brandDisplay}, ''),
          'brand_name', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.brandDisplay}, ''),
          'category', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.categoryDisplay}, ''),
          'product_type', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.vertical}, ''),
          'pdp_description_raw', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummaryDisplay}, ''),
          'description', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummaryDisplay}, ''),
          'ingredient_tokens', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.ingredientTokensDisplay}, ''),
          'search_aliases', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokensDisplay}, ''),
          'snapshot', jsonb_strip_nulls(jsonb_build_object(
            'title', NULLIF(coalesce(seed_data->'snapshot'->>'title', seed_data->>'title', title, ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitleDisplay}), ''),
            'brand', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.brandDisplay}, ''),
            'category', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.categoryDisplay}, ''),
            'product_type', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.vertical}, ''),
            'description', NULLIF(${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummaryDisplay}, '')
          ))
        )) AS seed_data,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE COALESCE(status, 'active') = 'active'
        AND upper(COALESCE(market, $2)) = $2
        AND ${EXTERNAL_SEED_RECALL_SQL_FIELDS.vertical} = ANY($3::text[])
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id ASC
      LIMIT $1
    `,
    [rowLimit, normalizedMarket, BEAUTY_VERTICAL_TERMS],
  );
  return rows.map(normalizeExternalProductSeedRow).filter(Boolean);
}

function normalizeAffectedRefTerms(refs = []) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const text = normalizeString(value, 512);
    if (!text) return;
    const candidates = [text, stripRefPrefix(text)];
    if (!/^[a-z][a-z0-9_+-]*:/i.test(text)) candidates.push(`product:${text}`);
    for (const candidate of candidates) {
      const normalized = normalizeString(candidate, 512);
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
  };
  for (const ref of Array.isArray(refs) ? refs : []) push(ref);
  return out;
}

async function loadAffectedProductAnchorCandidates({
  queryFn,
  refs = [],
  market = DEFAULT_MARKET,
  limit = DEFAULT_SOURCE_LIMIT,
  prioritizeUncovered = false,
  uncoveredCooldownDays = 7,
  coverageSiblingRefs = true,
  coverageSuppressedIds,
} = {}) {
  const suppressedIds = prioritizeUncovered
    ? (coverageSuppressedIds || await loadCoverageSuppressedIds({ queryFn, market })) : [];
  const terms = normalizeAffectedRefTerms(refs);
  if (!terms.length) return [];
  const normalizedMarket = normalizeMarket(market);
  const rowLimit = normalizeLimit(limit);
  const [externalSeedRows, productsCacheRows, catalogRows] = await Promise.all([
    guardedRows(
      queryFn,
      `
        SELECT
          eps.id,
          eps.external_product_id,
          eps.attached_product_key,
          eps.title,
          COALESCE(
            NULLIF(eps.seed_data->>'category', ''),
            NULLIF(eps.seed_data->>'product_type', ''),
            NULLIF(eps.seed_data->'snapshot'->>'category', ''),
            NULLIF(eps.seed_data->'snapshot'->>'product_type', ''),
            NULLIF(cp.category, ''),
            NULLIF(cp.product_type, ''),
            NULLIF(cp.category_path, '')
          ) AS category,
          eps.price_amount,
          eps.price_currency,
          eps.market,
          eps.canonical_url,
          eps.destination_url,
          eps.seed_data,
          eps.updated_at,
          eps.created_at,
          cp.product_key,
          cp.source_product_id,
          cp.pivota_signature_id,
          cp.content_key,${prioritizeUncovered ? `\n          CASE WHEN coverage.relgraph_priority > 0 THEN true ELSE false END AS relgraph_uncovered_live, coverage.relgraph_priority, coverage.relgraph_last_activity,` : ''}
          COALESCE(
            'product:' || NULLIF(cp.pivota_signature_id, ''),
            'product:' || NULLIF(eps.external_product_id, ''),
            eps.id
          ) AS product_ref
        FROM external_product_seeds eps
        LEFT JOIN catalog_products cp
          ON cp.source_product_id = eps.external_product_id
          -- Path-C / retailer-lane seeds point at their catalog row only through
          -- attached_product_key (same join as the affected-products selector).
          OR cp.product_key = eps.attached_product_key${prioritizeUncovered ? `\n        LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id\n        ${coverageCatalogJoinSql('cp', { marketSql: '$2', suppressedIdsSql: '$4::text[]', cooldownDays: uncoveredCooldownDays, coverageSiblingRefs })}` : ''}
        WHERE ${prioritizeUncovered ? 'coverage.relgraph_priority >= 0 AND ' : ''}COALESCE(eps.status, 'active') = 'active'
          AND upper(COALESCE(eps.market, $2)) = $2
          AND (
            eps.id = ANY($1::text[])
            OR eps.external_product_id = ANY($1::text[])
            OR eps.attached_product_key = ANY($1::text[])
            OR ('product:' || eps.external_product_id) = ANY($1::text[])
            OR cp.product_key = ANY($1::text[])
            OR cp.source_product_id = ANY($1::text[])
            OR cp.pivota_signature_id = ANY($1::text[])
            OR ('product:' || cp.pivota_signature_id) = ANY($1::text[])
            OR cp.content_key = ANY($1::text[])
          )
        ORDER BY ${prioritizeUncovered ? 'relgraph_uncovered_live DESC, relgraph_priority DESC, relgraph_last_activity ASC NULLS FIRST, ' : ''}eps.updated_at DESC NULLS LAST, eps.created_at DESC NULLS LAST, eps.id ASC
        LIMIT $3
      `,
      [terms, normalizedMarket, rowLimit, ...(prioritizeUncovered ? [suppressedIds] : [])],
    ),
    guardedRows(
      queryFn,
      `
        SELECT
          COALESCE(
            'product:' || NULLIF(cp.pivota_signature_id, ''),
            NULLIF(pc.platform_product_id, ''),
            NULLIF(pc.product_data->>'product_id', ''),
            NULLIF(pc.product_data->>'id', ''),
            pc.id::text
          ) AS product_ref,
          pc.product_data,
          pc.cached_at,
          cp.product_key,
          cp.source_product_id,
          cp.pivota_signature_id,
          cp.content_key${prioritizeUncovered ? `,\n          CASE WHEN coverage.relgraph_priority > 0 THEN true ELSE false END AS relgraph_uncovered_live, coverage.relgraph_priority, coverage.relgraph_last_activity` : ''}
        FROM products_cache pc
        LEFT JOIN catalog_products cp
          ON cp.source_product_id = COALESCE(
            NULLIF(pc.platform_product_id, ''),
            NULLIF(pc.product_data->>'product_id', ''),
            NULLIF(pc.product_data->>'id', '')
          )${prioritizeUncovered ? `\n        LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id\n        ${coverageCatalogJoinSql('cp', { marketSql: '$3', suppressedIdsSql: '$4::text[]', cooldownDays: uncoveredCooldownDays, coverageSiblingRefs })}` : ''}
        WHERE ${prioritizeUncovered ? 'coverage.relgraph_priority >= 0 AND ' : ''}(
          pc.platform_product_id = ANY($1::text[])
          OR pc.product_data->>'product_id' = ANY($1::text[])
          OR pc.product_data->>'id' = ANY($1::text[])
          OR ('product:' || pc.platform_product_id) = ANY($1::text[])
          OR ('product:' || (pc.product_data->>'product_id')) = ANY($1::text[])
          OR cp.product_key = ANY($1::text[])
          OR cp.source_product_id = ANY($1::text[])
          OR cp.pivota_signature_id = ANY($1::text[])
          OR ('product:' || cp.pivota_signature_id) = ANY($1::text[])
          OR cp.content_key = ANY($1::text[])
        )
        ORDER BY ${prioritizeUncovered ? 'relgraph_uncovered_live DESC, relgraph_priority DESC, relgraph_last_activity ASC NULLS FIRST, ' : ''}pc.cached_at DESC NULLS LAST, pc.id DESC
        LIMIT $2
      `,
      [terms, rowLimit, ...(prioritizeUncovered ? [normalizedMarket, suppressedIds] : [])],
    ),
    guardedRows(
      queryFn,
      `
        SELECT
          cp.product_key,
          cp.source_product_id,
          cp.pivota_signature_id,
          cp.content_key,
          cp.title,
          cp.description,
          cp.brand,
          cp.product_type,
          cp.category,
          cp.category_path,
          cp.category_label,
          cp.canonical_url,
          cp.pivota_canonical_url,
          cp.product_payload,
          cp.updated_at,
          cp.created_at,${prioritizeUncovered ? `\n          CASE WHEN coverage.relgraph_priority > 0 THEN true ELSE false END AS relgraph_uncovered_live, coverage.relgraph_priority, coverage.relgraph_last_activity,` : ''}
          COALESCE(
            'product:' || NULLIF(cp.pivota_signature_id, ''),
            'product:' || NULLIF(cp.source_product_id, ''),
            cp.product_key
          ) AS product_ref
        FROM catalog_products cp${prioritizeUncovered ? `\n        LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id\n        ${coverageCatalogJoinSql('cp', { marketSql: '$3', suppressedIdsSql: '$4::text[]', cooldownDays: uncoveredCooldownDays, coverageSiblingRefs })}` : ''}
        WHERE ${prioritizeUncovered ? 'coverage.relgraph_priority >= 0 AND (' : ''}cp.product_key = ANY($1::text[])
           OR cp.source_product_id = ANY($1::text[])
           OR cp.pivota_signature_id = ANY($1::text[])
           OR ('product:' || cp.pivota_signature_id) = ANY($1::text[])
           OR ('product:' || cp.source_product_id) = ANY($1::text[])
           OR cp.content_key = ANY($1::text[])${prioritizeUncovered ? ')' : ''}
        ORDER BY ${prioritizeUncovered ? 'relgraph_uncovered_live DESC, relgraph_priority DESC, relgraph_last_activity ASC NULLS FIRST, ' : ''}cp.updated_at DESC NULLS LAST, cp.product_key ASC
        LIMIT $2
      `,
      [terms, rowLimit, ...(prioritizeUncovered ? [normalizedMarket, suppressedIds] : [])],
    ),
  ]);

  const products = dedupeNormalizedProducts([
    ...externalSeedRows.map(normalizeExternalProductSeedRow),
    ...productsCacheRows.map(normalizeProductsCacheRow),
    ...catalogRows.map(normalizeCatalogProductRow),
  ].filter(Boolean));
  if (!prioritizeUncovered) return products;
  const uncoveredRows = [...externalSeedRows, ...productsCacheRows, ...catalogRows]
    .filter((row) => row.relgraph_uncovered_live === true);
  const byRef = new Map();
  for (const row of uncoveredRows) {
    for (const ref of productAnchorRefs(row)) {
      const previous = byRef.get(ref);
      if (!previous || (row.relgraph_priority ?? 3) > (previous.relgraph_priority ?? 3) ||
        ((row.relgraph_priority ?? 3) === (previous.relgraph_priority ?? 3) &&
          new Date(row.relgraph_last_activity || 0) < new Date(previous.relgraph_last_activity || 0))) byRef.set(ref, row);
    }
  }
  for (const product of products) {
    const matches = productAnchorRefs(product).map((ref) => byRef.get(ref)).filter(Boolean);
    matches.sort((a, b) => (b.relgraph_priority ?? 3) - (a.relgraph_priority ?? 3) ||
      new Date(a.relgraph_last_activity || 0) - new Date(b.relgraph_last_activity || 0));
    product._relgraph_priority = matches[0]?.relgraph_priority;
    product._relgraph_last_activity = matches[0]?.relgraph_last_activity;
    product._relgraph_uncovered_live = matches.length > 0;
  }
  return prioritizeUncoveredProducts(products, products.filter((product) => product._relgraph_uncovered_live));
}

async function loadApprovedLiveExternalSeedAnchors({
  queryFn,
  limit = DEFAULT_SOURCE_LIMIT,
  market = DEFAULT_MARKET,
  missingCandidateLabelsOnly = false,
} = {}) {
  const normalizedMarket = normalizeMarket(market);
  const canFilterMissingLabels =
    missingCandidateLabelsOnly === true &&
    (await tableExists(queryFn, 'public.relationship_candidate_labels'));
  const missingLabelsCte = canFilterMissingLabels
    ? `
      WITH existing_labels AS MATERIALIZED (
        SELECT DISTINCT lower(anchor_ref) AS anchor_ref
        FROM relationship_candidate_labels rcl
        WHERE rcl.anchor_type = 'product'
          AND upper(COALESCE(rcl.market, $2)) = $2
      )
    `
    : '';
  const missingLabelsJoin = canFilterMissingLabels
    ? `
      LEFT JOIN existing_labels
        ON existing_labels.anchor_ref = lower('product:' || eps.external_product_id)
      `
    : '';
  const missingLabelsPredicate = canFilterMissingLabels
    ? 'AND existing_labels.anchor_ref IS NULL'
    : '';
  const rows = await guardedRows(
    queryFn,
    `
      ${missingLabelsCte}
      SELECT
        eps.id,
        eps.external_product_id,
        eps.attached_product_key,
        eps.title,
        eps.price_amount,
        eps.price_currency,
        eps.market,
        eps.canonical_url,
        eps.destination_url,
        eps.seed_data,
        eps.updated_at,
        eps.created_at,
        cp.product_key AS catalog_product_key,
        cp.title AS catalog_title,
        cp.brand AS catalog_brand,
        cp.category AS catalog_category,
        cp.product_type AS catalog_product_type,
        cp.category_path AS catalog_category_path,
        cp.description AS catalog_description,
        cp.canonical_url AS catalog_canonical_url,
        cp.image_url AS catalog_image_url,
        cp.pivota_signature_id,
        cp.updated_at AS catalog_updated_at
      FROM external_product_seeds eps
      JOIN catalog_products cp
        ON cp.product_key = eps.attached_product_key
       AND cp.sync_status = 'live'
      JOIN catalog_row_trust crt
        ON crt.subject_type = 'product'
       AND crt.subject_key = cp.product_key
       AND crt.serving_decision = 'public'
      ${missingLabelsJoin}
      WHERE COALESCE(eps.status, 'active') = 'active'
        AND eps.attached_product_key IS NOT NULL
        AND upper(COALESCE(eps.market, $2)) = $2
        ${missingLabelsPredicate}
      ORDER BY eps.updated_at DESC NULLS LAST, eps.created_at DESC NULLS LAST, eps.id ASC
      LIMIT $1
    `,
    [normalizeLimit(limit, DEFAULT_SOURCE_LIMIT), normalizedMarket],
  );
  return rows.map(normalizeApprovedLiveExternalSeedRow).filter(Boolean);
}

function evidenceTargets(products = [], market = DEFAULT_MARKET) {
  const targets = (Array.isArray(products) ? products : []).map((product) => {
    const item = normalizeProductCandidateSnapshot(product);
    if (!item) return null;
    const ids = [item.product_id, item.source_product_id, item.pivota_signature_id, item.sku_key,
      /^product:/i.test(item.product_ref) ? stripRefPrefix(item.product_ref) : ''].filter(Boolean);
    return { target_key: evidenceTargetKey(item), product_key: item.product_key || '', signature: evidenceSignature(item), ids: [...new Set(ids)],
      refs: [...new Set([item.product_ref, ...ids.map((id) => normalizeProductRef(id))])],
      urls: item.url ? [item.url] : [], merchant_id: item.merchant_id || '', platform: item.platform || '',
      brand: pairBrand(item), market: normalizeMarket(item.market || market),
      variant_title: normalizeLower(item.variant_title), variant_detail_label: normalizeLower(item.variant_detail_label) };
  }).filter(Boolean);
  const byListing = new Map();
  for (const target of targets) {
    const existing = byListing.get(target.target_key);
    if (!existing) { byListing.set(target.target_key, target); continue; }
    for (const field of ['ids', 'refs', 'urls']) existing[field] = [...new Set([...existing[field], ...target[field]])];
  }
  return [...byListing.values()];
}

function evidenceTargetKey(product) {
  if (product.product_key) return `product_key:${product.product_key}`;
  if (evidenceSignature(product)) return `signature:${evidenceSignature(product)}`;
  if (product.url) return `url:${product.url}`;
  const id = product.source_product_id || product.product_id || product.sku_key;
  if (product.merchant_id && id) return `merchant:${product.merchant_id}:platform:${product.platform || ''}:id:${id}`;
  if (/^ext_/i.test(id || '')) return `external_id:${id}`;
  // Sparse products still get a deterministic request bucket, but exact-identity matching
  // below will abstain rather than borrow a formula using this unscoped identifier.
  return `unbound:${product.product_ref || ''}:id:${id || ''}`;
}

// Targeted loads cap records PER listing. A selected product must not lose its older evidence
// because unrelated products have more recent rows in the global discovery window.
function targetedEvidenceSql(sql, targets, predicate, reviewedLane = false) {
  if (!targets.length) return sql;
  return `WITH evidence_targets AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS t(target_key text, product_key text, signature text, ids text[], refs text[], urls text[], merchant_id text, platform text, brand text, market text, variant_title text, variant_detail_label text${reviewedLane ? ', reviewed_identity_keys text[]' : ''})
  ) SELECT matched.*, target.target_key AS _evidence_target_key FROM evidence_targets target CROSS JOIN LATERAL (
    ${sql.replace(/WHERE /, `WHERE (${predicate}) AND `)}
  ) matched`;
}

function boundedEvidenceRows(rows, targeted) {
  if (!targeted) return rows;
  const grouped = new Map();
  for (const row of rows) {
    const key = row._evidence_target_key || '';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.values()].flatMap((matches) => matches.slice(0, 4).map((row) => ({
    ...row, _evidence_load_incomplete: matches.length > 4,
  })));
}

function intelCanonicalAliasGuardSql() {
  const aliases = { product_key:'productKey', pivota_signature_id:'pivotaSignatureId', product_id:'productId',
    source_product_id:'sourceProductId', product_ref:'productRef', merchant_id:'merchantId',
    variant_title:'variantTitle', variant_detail_label:'variantDetailLabel' };
  return Object.entries(aliases).map(([field, alias]) => {
    const value = (name) => {
      const raw = `btrim(doc.canonical->>'${name}')`;
      if (field.startsWith('variant_')) return `lower(${raw})`;
      if (field === 'product_id') return `(CASE WHEN ${raw} ~* '^product:(sig_|ext_)' THEN substring(${raw} FROM 9) ELSE ${raw} END)`;
      return raw;
    };
    return `AND (NULLIF(btrim(doc.canonical->>'${field}'), '') IS NULL OR NULLIF(btrim(doc.canonical->>'${alias}'), '') IS NULL OR ${value(field)} = ${value(alias)})`;
  }).join('\n      ');
}

function targetedIntelSql(sql, targets) {
  if (!targets.length) return sql;
  const projection = sql.replace(/WHERE analysis IS NOT NULL[\s\S]*$/, 'WHERE kb_key IN (SELECT kb_key FROM selected_evidence)');
  // Materialize only compact identity fields once, then rank exact matches per target. A
  // LATERAL OR over analysis would repeatedly scan/deTOAST every bundle for every product.
  return `WITH evidence_targets AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS t(target_key text, product_key text, signature text, ids text[], refs text[], urls text[], merchant_id text, platform text, brand text, market text, variant_title text, variant_detail_label text)
  ), document_identity AS MATERIALIZED (
    SELECT kb_key, last_success_at, updated_at, lower(btrim(COALESCE(source_meta->>'brand', ''))) AS brand,
      COALESCE(analysis#>'{product_intel_v1,canonical_product_ref}', analysis#>'{product_intel,canonical_product_ref}', analysis->'canonical_product_ref') AS canonical,
      COALESCE(analysis#>>'{product_intel_v1,source_coverage,canonical_url}', analysis#>>'{product_intel,source_coverage,canonical_url}', analysis#>>'{source_coverage,canonical_url}',
        analysis#>>'{product_intel_v1,canonical_product_ref,canonical_url}', analysis#>>'{product_intel,canonical_product_ref,canonical_url}', analysis#>>'{canonical_product_ref,canonical_url}',
        analysis#>>'{product_intel_v1,provenance,official_source_url}', analysis#>>'{product_intel,provenance,official_source_url}', analysis#>>'{provenance,official_source_url}', source_meta->>'official_source_url') AS source_url
    FROM aurora_product_intel_kb WHERE analysis IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[
        analysis#>>'{product_intel_v1,provenance,review_decision}', analysis#>>'{product_intel,provenance,review_decision}',
        analysis#>>'{provenance,review_decision}', source_meta->>'review_decision',
        analysis#>>'{product_intel_v1,quality_state}', analysis#>>'{product_intel,quality_state}',
        analysis->>'quality_state', source_meta->>'quality_state']) state(value)
        WHERE lower(btrim(state.value)) IN ('reject', 'reject_external', 'rejected', 'blocked', 'failed', 'fail', 'suppressed', 'needs_review'))
  ), evidence_matches AS (
    SELECT doc.kb_key, target.target_key,
      row_number() OVER (PARTITION BY target.target_key ORDER BY doc.last_success_at DESC NULLS LAST, doc.updated_at DESC NULLS LAST, doc.kb_key ASC) AS evidence_rank
    FROM document_identity doc JOIN evidence_targets target ON (
      (target.product_key <> '' AND (doc.canonical->>'product_key' = target.product_key OR doc.canonical->>'productKey' = target.product_key))
      OR (target.signature <> '' AND (doc.canonical->>'pivota_signature_id' = target.signature
        OR doc.canonical->>'pivotaSignatureId' = target.signature
        OR doc.canonical->>'product_id' IN (target.signature, 'product:' || target.signature)
        OR doc.canonical->>'productId' IN (target.signature, 'product:' || target.signature)
        OR doc.canonical->>'product_ref' = 'product:' || target.signature
        OR doc.canonical->>'productRef' = 'product:' || target.signature OR doc.kb_key = 'product:' || target.signature))
      OR doc.source_url = ANY(target.urls)
      OR (doc.canonical->>'product_id' ~* '^(product:)?ext_'
        AND (doc.canonical->>'product_id' = ANY(target.ids) OR doc.canonical->>'product_id' = ANY(target.refs)))
      OR (doc.kb_key ~* '^product:ext_' AND doc.kb_key = ANY(target.refs))
      OR (target.merchant_id <> '' AND doc.canonical->>'merchant_id' = target.merchant_id
        AND COALESCE(doc.canonical->>'platform', '') = target.platform
        AND (doc.canonical->>'product_id' = ANY(target.ids) OR doc.kb_key = ANY(target.refs)))
    )
      -- Reject explicit listing conflicts BEFORE ranking. An unrelated store's newer
      -- recycled ids must not consume the cap and hide older exact listing evidence.
      AND (target.product_key = '' OR (COALESCE(btrim(doc.canonical->>'product_key'), '') IN ('', target.product_key)
        AND COALESCE(btrim(doc.canonical->>'productKey'), '') IN ('', target.product_key)))
      AND (target.signature = '' OR (COALESCE(btrim(doc.canonical->>'pivota_signature_id'), '') IN ('', target.signature)
        AND COALESCE(btrim(doc.canonical->>'pivotaSignatureId'), '') IN ('', target.signature)))
      AND (target.signature = '' OR COALESCE(NULLIF(btrim(doc.canonical->>'pivota_signature_id'), ''),
        NULLIF(btrim(doc.canonical->>'pivotaSignatureId'), ''),
        CASE WHEN COALESCE(doc.canonical->>'product_ref', doc.canonical->>'productRef') ~* '^product:sig_'
            THEN substring(COALESCE(doc.canonical->>'product_ref', doc.canonical->>'productRef') FROM 9)
          WHEN COALESCE(doc.canonical->>'product_id', doc.canonical->>'productId') ~* '^sig_'
            THEN COALESCE(doc.canonical->>'product_id', doc.canonical->>'productId')
          WHEN COALESCE(doc.canonical->>'product_id', doc.canonical->>'productId') ~* '^product:sig_'
            THEN substring(COALESCE(doc.canonical->>'product_id', doc.canonical->>'productId') FROM 9)
          WHEN doc.kb_key ~* '^product:sig_' THEN substring(doc.kb_key FROM 9) END, '') IN ('', target.signature))
      AND (target.signature = '' OR NOT EXISTS (SELECT 1 FROM unnest(ARRAY[
        NULLIF(btrim(doc.canonical->>'pivota_signature_id'), ''), NULLIF(btrim(doc.canonical->>'pivotaSignatureId'), ''),
        CASE WHEN btrim(doc.canonical->>'product_id') ~* '^(product:)?sig_' THEN regexp_replace(btrim(doc.canonical->>'product_id'), '^product:', '', 'i') END,
        CASE WHEN btrim(doc.canonical->>'productId') ~* '^(product:)?sig_' THEN regexp_replace(btrim(doc.canonical->>'productId'), '^product:', '', 'i') END,
        CASE WHEN btrim(doc.canonical->>'product_ref') ~* '^(product:)?sig_' THEN regexp_replace(btrim(doc.canonical->>'product_ref'), '^product:', '', 'i') END,
        CASE WHEN btrim(doc.canonical->>'productRef') ~* '^(product:)?sig_' THEN regexp_replace(btrim(doc.canonical->>'productRef'), '^product:', '', 'i') END
      ]) signature(value) WHERE signature.value IS NOT NULL AND signature.value <> target.signature))
      ${intelCanonicalAliasGuardSql()}
      AND (lower(target.merchant_id) IN ('', 'external_seed')
        OR (lower(btrim(COALESCE(doc.canonical->>'merchant_id', ''))) IN ('', 'external_seed', lower(target.merchant_id))
          AND lower(btrim(COALESCE(doc.canonical->>'merchantId', ''))) IN ('', 'external_seed', lower(target.merchant_id))))
      AND (lower(target.merchant_id) IN ('', 'external_seed') OR target.platform = ''
        OR lower(btrim(COALESCE(doc.canonical->>'merchant_id', doc.canonical->>'merchantId', ''))) <> lower(target.merchant_id)
        OR lower(btrim(COALESCE(doc.canonical->>'platform', ''))) <> lower(target.platform)
        OR NOT EXISTS (SELECT 1 FROM unnest(ARRAY[doc.canonical->>'product_id', doc.canonical->>'productId',
          doc.canonical->>'source_product_id', doc.canonical->>'sourceProductId']) scoped_id(value)
          WHERE NULLIF(btrim(scoped_id.value), '') IS NOT NULL AND NOT (btrim(scoped_id.value) = ANY(target.ids) OR btrim(scoped_id.value) = ANY(target.refs))))
      AND upper(btrim(COALESCE(doc.canonical->>'market', ''))) IN ('', target.market)
      AND (target.platform = '' OR lower(btrim(COALESCE(doc.canonical->>'platform', ''))) IN ('', lower(target.platform)))
      AND (COALESCE(target.variant_title, '') = '' OR (lower(btrim(COALESCE(doc.canonical->>'variant_title', ''))) IN ('', target.variant_title)
        AND lower(btrim(COALESCE(doc.canonical->>'variantTitle', ''))) IN ('', target.variant_title)))
      AND (COALESCE(target.variant_detail_label, '') = '' OR (lower(btrim(COALESCE(doc.canonical->>'variant_detail_label', ''))) IN ('', target.variant_detail_label)
        AND lower(btrim(COALESCE(doc.canonical->>'variantDetailLabel', ''))) IN ('', target.variant_detail_label)))
      AND (target.brand = '' OR (doc.brand IN ('', target.brand)
        AND lower(btrim(COALESCE(doc.canonical->>'brand', ''))) IN ('', target.brand)))
  ), selected_evidence AS (SELECT DISTINCT kb_key FROM evidence_matches WHERE evidence_rank <= $1),
  projected_evidence AS MATERIALIZED (${projection})
  SELECT projected.*, matched.target_key AS _evidence_target_key
  FROM projected_evidence projected JOIN evidence_matches matched USING(kb_key)
  WHERE matched.evidence_rank <= $1 ORDER BY matched.target_key, matched.evidence_rank`;
}

async function loadProductIntelKbRows({ queryFn, limit = DEFAULT_SOURCE_LIMIT, targetProducts = [], market = DEFAULT_MARKET } = {}) {
  const targets = evidenceTargets(targetProducts, market);
  const rows = await guardedRows(
    queryFn,
    targetedIntelSql(`
      SELECT
        kb_key,
        jsonb_strip_nulls(jsonb_build_object(
          'product_intel_v1', jsonb_strip_nulls(jsonb_build_object(
            'canonical_product_ref', COALESCE(
              analysis#>'{product_intel_v1,canonical_product_ref}', analysis#>'{product_intel,canonical_product_ref}',
              analysis#>'{canonical_product_ref}'
            ),
            'product_intel_core', COALESCE(
              analysis#>'{product_intel_v1,product_intel_core}', analysis#>'{product_intel,product_intel_core}',
              analysis#>'{product_intel_core}',
              analysis#>'{core}'
            ),
            'search_card', COALESCE(
              analysis#>'{product_intel_v1,search_card}', analysis#>'{product_intel,search_card}',
              analysis#>'{search_card}'
            ),
            'shopping_card', COALESCE(
              analysis#>'{product_intel_v1,shopping_card}', analysis#>'{product_intel,shopping_card}',
              analysis#>'{shopping_card}'
            ),
            'provenance', COALESCE(analysis#>'{product_intel_v1,provenance}', analysis#>'{product_intel,provenance}', analysis->'provenance'),
            'confidence', COALESCE(analysis#>'{product_intel_v1,confidence}', analysis#>'{product_intel,confidence}', analysis->'confidence'),
            'evidence_profile', COALESCE(analysis#>'{product_intel_v1,evidence_profile}', analysis#>'{product_intel,evidence_profile}', analysis->'evidence_profile'),
            'freshness', COALESCE(analysis#>'{product_intel_v1,freshness}', analysis#>'{product_intel,freshness}', analysis->'freshness'),
            'source_coverage', COALESCE(analysis#>'{product_intel_v1,source_coverage}', analysis#>'{product_intel,source_coverage}', analysis->'source_coverage'),
            'quality_state', COALESCE(analysis#>'{product_intel_v1,quality_state}', analysis#>'{product_intel,quality_state}', analysis->'quality_state'),
            'market_signal_badges', COALESCE(analysis#>'{product_intel_v1,market_signal_badges}', analysis#>'{product_intel,market_signal_badges}', analysis->'market_signal_badges'),
            'external_highlight_signals', COALESCE(analysis#>'{product_intel_v1,external_highlight_signals}', analysis#>'{product_intel,external_highlight_signals}', analysis->'external_highlight_signals')
          ))
        )) AS analysis,
        source,
        source_meta,
        last_success_at,
        created_at,
        updated_at
      FROM aurora_product_intel_kb
      WHERE analysis IS NOT NULL
      ORDER BY last_success_at DESC NULLS LAST, updated_at DESC NULLS LAST, kb_key ASC
      LIMIT $1
    `, targets),
    targets.length ? [5, JSON.stringify(targets)] : [normalizeLimit(limit)],
  );
  const publicRows = boundedEvidenceRows(rows, targets.length).map((row) => {
    const intel = normalizeProductIntelKbRow(row);
    return intel ? { ...intel, ...(row._evidence_load_incomplete ? { product_intel_evidence_incomplete: true } : {}) } : null;
  }).filter(Boolean);
  if (!await tableExists(queryFn, 'public.relgraph_reviewed_seller_evidence')) return publicRows;
  const { validateGraphSellerEvidence, graphSellerBundle, __internal: {publicSellerCollisionSql,publicSellerProtectedSql} } = require('../services/relationshipReviewedInsightsRefresh');
  const hasPublicSellerProtection = await tableExists(queryFn, 'public.aurora_product_intel_kb');
  const { identityKey: sellerIdentityKey } = require('../services/relationshipReviewedIngredientEvidence');
  const keyMap = new Map();
  for (const product of targetProducts) {
    const normalized = normalizeProductCandidateSnapshot(product); if (!normalized) continue;
    try { const bucket = evidenceTargetKey(normalized); if (!keyMap.has(bucket)) keyMap.set(bucket, new Set());
      keyMap.get(bucket).add(sellerIdentityKey({ ...product, market: product.market || market })); } catch (_) {}
  }
  const sellerTargets = targets.map(target => ({ ...target, reviewed_identity_keys: [...(keyMap.get(target.target_key) || [])] }));
  const sellerRows = await guardedRows(queryFn, targetedEvidenceSql(`
    SELECT evidence_id,identity_key,source_observed_at,source_url,proof
    FROM public.relgraph_reviewed_seller_evidence
    WHERE ${hasPublicSellerProtection ? `NOT EXISTS(SELECT 1 FROM public.aurora_product_intel_kb public_kb WHERE ${publicSellerCollisionSql("proof#>'{source,identity}'","proof#>>'{source,source_url}'")} AND ${publicSellerProtectedSql()}) AND` : ''} proof @> '{"schema":"relgraph.reviewed_seller_evidence.v1","graph_only":true,"public_insights_eligible":false}'::jsonb
    ORDER BY source_observed_at DESC,evidence_id ASC LIMIT $1
  `, sellerTargets, 'identity_key = ANY(target.reviewed_identity_keys)', true),
  targets.length ? [5, JSON.stringify(sellerTargets)] : [normalizeLimit(limit)]);
  const normalizedSellerRows = boundedEvidenceRows(sellerRows, targets.length).map(row => {
    let proof;try { proof=validateGraphSellerEvidence(coerceJson(row.proof),{requireCurrent:false});
      if(proof.evidence_id!==row.evidence_id||proof.identity_key!==row.identity_key||proof.source.source_url!==row.source_url||
        toIsoOrNull(proof.source.source_observed_at)!==toIsoOrNull(row.source_observed_at)) return null;
    } catch (_) {return null;}
    const intel=normalizeProductIntelKbRow({kb_key:`graph-seller:${row.evidence_id}`,analysis:{product_intel_v1:graphSellerBundle(proof)},
      source:'relgraph_graph_only_seller_consensus',last_success_at:row.source_observed_at});
    return intel?{...intel,_graph_seller_identity_key:row.identity_key,_graph_seller_record:row.evidence_id,
      ...(row._evidence_load_incomplete?{product_intel_evidence_incomplete:true}:{})}:null;
  }).filter(Boolean);
  return [...publicRows,...normalizedSellerRows];
}

async function loadIngredientKbCandidates({ queryFn, limit = DEFAULT_SOURCE_LIMIT, targetProducts = [], market = DEFAULT_MARKET } = {}) {
  const targets = evidenceTargets(targetProducts, market);
  const perTableLimit = normalizeLimit(limit);
  const out = [];
  // An optional append-only lane carries actual capture time and exact source/review
  // proof. Absence leaves the established ingredient stores unchanged.
  if (await tableExists(queryFn, 'public.relgraph_reviewed_ingredient_evidence')) {
    const { validateReviewedIngredientEvidence, identityKey } = require('../services/relationshipReviewedIngredientEvidence');
    const keyMap = new Map();
    for (const product of targetProducts) {
      const normalized = normalizeProductCandidateSnapshot(product);
      if (!normalized) continue;
      try {
        const bucket = evidenceTargetKey(normalized);
        if (!keyMap.has(bucket)) keyMap.set(bucket, new Set());
        keyMap.get(bucket).add(identityKey({ ...product, market: product.market || market }));
      } catch (_) { /* Sparse/conflicting identity cannot bind the exact lane. */ }
    }
    const reviewedTargets = targets.map(target => ({ ...target, reviewed_identity_keys: [...(keyMap.get(target.target_key) || [])] }));
    const rows = await guardedRows(queryFn, targetedEvidenceSql(`
      SELECT evidence_id, identity_key, product_key, pivota_signature_id, product_id, source_product_id,
        merchant_id, platform, market, variant_title, variant_detail_label, ingredient_text,
        formula_sha256, raw_source_sha256, source_url, source_observed_at, proof
      FROM public.relgraph_reviewed_ingredient_evidence
      WHERE proof->>'schema' = 'relgraph.reviewed_ingredient_evidence.v1'
        AND proof->>'parse_status' = 'OK' AND proof->>'review_status' = 'APPROVED'
        AND proof->>'audit_status' = 'PASS' AND proof->>'ingest_allowed' = 'true'
      ORDER BY source_observed_at DESC, evidence_id ASC LIMIT $1
    `, reviewedTargets, `identity_key = ANY(target.reviewed_identity_keys) AND ((target.product_key <> '' AND product_key = target.product_key)
        OR (target.signature <> '' AND pivota_signature_id = target.signature)
        OR (product_id ~* '^ext_' AND product_id = ANY(target.ids))
        OR (source_product_id ~* '^ext_' AND source_product_id = ANY(target.ids)))
      AND (target.product_key = '' OR product_key = '' OR product_key = target.product_key)
      AND (target.signature = '' OR pivota_signature_id = '' OR pivota_signature_id = target.signature)
      AND upper(market) = target.market
      AND (target.merchant_id IN ('', 'external_seed') OR merchant_id IN ('', 'external_seed') OR lower(merchant_id) = lower(target.merchant_id))
      AND (target.platform = '' OR platform = '' OR lower(platform) = lower(target.platform))
      AND (COALESCE(target.variant_title, '') = '' OR variant_title = '' OR lower(variant_title) = target.variant_title)
      AND (COALESCE(target.variant_detail_label, '') = '' OR variant_detail_label = '' OR lower(variant_detail_label) = target.variant_detail_label)
      AND (product_id !~* '^ext_' OR cardinality(target.ids) = 0 OR product_id = ANY(target.ids))
      AND (source_product_id !~* '^ext_' OR cardinality(target.ids) = 0 OR source_product_id = ANY(target.ids))`, true),
    targets.length ? [5, JSON.stringify(reviewedTargets)] : [perTableLimit]);
    out.push(...boundedEvidenceRows(rows, targets.length).map(row => {
      let proof;
      try {
        proof = validateReviewedIngredientEvidence(coerceJson(row.proof), { requireCurrent: false });
        if (proof.evidence_id !== row.evidence_id || proof.identity_key !== row.identity_key || proof.ingredient_text !== row.ingredient_text ||
          proof.formula_sha256 !== row.formula_sha256 || proof.raw_source_sha256 !== row.raw_source_sha256 || proof.source_url !== row.source_url ||
          proof.source_observed_at !== toIsoOrNull(row.source_observed_at) || Object.entries(proof.identity).some(([field, value]) => value !== row[field])) return null;
      } catch (_) { return null; }
      const ingredient = normalizeIngredientKbRow({ ...row, raw_inci: row.ingredient_text, source_ref: row.source_url,
        parse_status: proof.parse_status, review_status: proof.review_status, audit_status: proof.audit_status, ingest_allowed: proof.ingest_allowed,
        evidence_refs_json: [{ type: 'reviewed_ingredient_source', name: row.evidence_id, url: row.source_url, authoritative: true,
          observed_at: row.source_observed_at, ...proof.identity }], source_system: 'relgraph_reviewed_ingredient_evidence_v1' },
      { table: 'public.relgraph_reviewed_ingredient_evidence' });
      if (ingredient) ingredient.ingredient_evidence = ingredient.ingredient_evidence.map(evidence => ({ ...evidence,
        evidence_id: row.evidence_id, identity_key: row.identity_key, formula_sha256: row.formula_sha256,
        raw_source_sha256: row.raw_source_sha256, source_capture_ref: proof.source_capture.capture_id,
        review_refs: proof.reviews.map(review => ({ provider: review.provider, review_id: review.review_id, reviewed_at: review.reviewed_at })) }));
      return ingredient ? { ...ingredient, reviewed_ingredient_identity_key: row.identity_key,
        ...(row._evidence_load_incomplete ? { ingredient_evidence_incomplete: true } : {}) } : null;
    }).filter(Boolean));
  }
  if (await tableExists(queryFn, 'public.beauty_sku_ingredients')) {
    const rows = await guardedRows(
      queryFn,
      targetedEvidenceSql(`
        SELECT
          sku_key,
          product_key,
          merchant_id,
          raw_inci,
          normalized_ingredients_json,
          active_ingredients_json,
          evidence_refs_json,
          source_system,
          to_jsonb(beauty_sku_ingredients)->>'parse_status' AS parse_status,
          to_jsonb(beauty_sku_ingredients)->>'review_status' AS review_status,
          to_jsonb(beauty_sku_ingredients)->>'audit_status' AS audit_status,
          to_jsonb(beauty_sku_ingredients)->>'ingest_allowed' AS ingest_allowed,
          created_at,
          updated_at
        FROM public.beauty_sku_ingredients
        WHERE lower(COALESCE(to_jsonb(beauty_sku_ingredients)->>'review_status', '')) NOT IN ('reject', 'rejected', 'blocked', 'failed', 'fail', 'needs_review')
          AND lower(COALESCE(to_jsonb(beauty_sku_ingredients)->>'audit_status', '')) NOT IN ('reject', 'rejected', 'blocked', 'failed', 'fail', 'needs_review')
          AND lower(COALESCE(to_jsonb(beauty_sku_ingredients)->>'parse_status', '')) NOT IN ('reject', 'rejected', 'blocked', 'failed', 'fail', 'needs_review')
          AND lower(COALESCE(to_jsonb(beauty_sku_ingredients)->>'ingest_allowed', '')) <> 'false'
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, sku_key ASC
        LIMIT $1
      `, targets, `((target.product_key <> '' AND product_key = target.product_key)
          OR (target.signature <> '' AND sku_key IN (target.signature, 'product:' || target.signature))
          OR (sku_key ~* '^(product:)?ext_' AND (sku_key = ANY(target.ids) OR sku_key = ANY(target.refs)))
          OR (target.merchant_id <> '' AND target.platform = '' AND merchant_id = target.merchant_id
            AND (sku_key = ANY(target.ids) OR sku_key = ANY(target.refs))))
        AND (target.product_key = '' OR COALESCE(product_key, '') IN ('', target.product_key))
        AND (target.merchant_id = '' OR COALESCE(merchant_id, '') IN ('', target.merchant_id))`),
      targets.length ? [5, JSON.stringify(targets)] : [perTableLimit],
    );
    out.push(...boundedEvidenceRows(rows, targets.length).map((row) => {
      const ingredient = normalizeIngredientKbRow(row, { table: 'public.beauty_sku_ingredients' });
      return ingredient ? { ...ingredient, ...(row._evidence_load_incomplete ? { ingredient_evidence_incomplete: true } : {}) } : null;
    }).filter(Boolean));
  }
  if (await tableExists(queryFn, 'pci_kb.sku_ingredients')) {
    const rows = await guardedRows(
      queryFn,
      targetedEvidenceSql(`
        SELECT
          sku_key,
          market,
          brand,
          product_name,
          source_ref,
          parse_status,
          review_status,
          audit_status,
          ingest_allowed,
          raw_ingredient_text_clean,
          inci_list,
          created_at
        FROM pci_kb.sku_ingredients
        WHERE (
          ingest_allowed = TRUE
          OR upper(COALESCE(parse_status, '')) = 'OK'
        )
          AND ingest_allowed IS DISTINCT FROM FALSE
          AND lower(COALESCE(review_status, '')) NOT IN ('reject', 'rejected', 'blocked', 'failed', 'fail', 'needs_review')
          AND lower(COALESCE(audit_status, '')) NOT IN ('reject', 'rejected', 'blocked', 'failed', 'fail', 'needs_review')
          AND lower(COALESCE(parse_status, '')) NOT IN ('reject', 'rejected', 'blocked', 'failed', 'fail', 'needs_review')
        ORDER BY created_at DESC NULLS LAST, sku_key ASC
        LIMIT $1
      `, targets, `((target.signature <> '' AND sku_key IN (target.signature, 'product:' || target.signature))
          OR (sku_key ~* '^(product:)?ext_' AND (sku_key = ANY(target.ids) OR sku_key = ANY(target.refs))) OR source_ref = ANY(target.urls))
        AND (target.signature = '' OR sku_key !~* '^(product:)?sig_'
          OR regexp_replace(sku_key, '^product:', '', 'i') = target.signature)
        AND (target.brand = '' OR lower(btrim(COALESCE(brand, ''))) IN ('', target.brand))
        AND upper(COALESCE(market, '')) IN ('', target.market)`),
      targets.length ? [5, JSON.stringify(targets)] : [perTableLimit],
    );
    out.push(...boundedEvidenceRows(rows, targets.length).map((row) => {
      const ingredient = normalizeIngredientKbRow(row, { table: 'pci_kb.sku_ingredients' });
      return ingredient ? { ...ingredient, ...(row._evidence_load_incomplete ? { ingredient_evidence_incomplete: true } : {}) } : null;
    }).filter(Boolean));
  }
  const seen = new Set();
  return out.filter((row) => {
    const key = JSON.stringify([row.product_ref, row.ingredient_evidence]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

async function loadLegacyDupeKbRows({ queryFn, limit = DEFAULT_SOURCE_LIMIT } = {}) {
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        kb_key,
        original,
        dupes,
        comparables,
        verified,
        verified_at,
        verified_by,
        source,
        source_meta,
        created_at,
        updated_at
      FROM aurora_dupe_kb
      WHERE verified = TRUE OR verified_at IS NOT NULL
      ORDER BY verified_at DESC NULLS LAST, updated_at DESC NULLS LAST, kb_key ASC
      LIMIT $1
    `,
    [normalizeLimit(limit)],
  );
  return rows.map(normalizeLegacyDupeKbRow).filter((row) => row.original || row.dupes.length || row.comparables.length);
}

function vectorLiteral(vec) {
  return `[${vec.map((n) => Number(n)).filter((n) => Number.isFinite(n)).join(',')}]`;
}

async function loadProductsCacheVectorRecallCandidates({
  queryFn,
  queryVector,
  limit = 200,
} = {}) {
  if (!Array.isArray(queryVector) || !queryVector.length) return [];
  const dim = queryVector.length;
  const col = dim === 768 ? 'embedding_768' : dim === 1536 ? 'embedding_1536' : '';
  if (!col) return [];
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        COALESCE(
          NULLIF(pc.platform_product_id, ''),
          NULLIF(pc.product_data->>'product_id', ''),
          NULLIF(pc.product_data->>'id', ''),
          pc.id::text
        ) AS product_ref,
        pc.product_data,
        pc.cached_at,
        1 - (pce.${col} <=> $1::vector) AS vector_score
      FROM products_cache_embeddings pce
      JOIN products_cache pc
        ON COALESCE(NULLIF(pc.platform_product_id, ''), NULLIF(pc.product_data->>'product_id', ''), pc.id::text) = pce.product_id
      WHERE pce.${col} IS NOT NULL
      ORDER BY pce.${col} <=> $1::vector
      LIMIT $2
    `,
    [vectorLiteral(queryVector), normalizeLimit(limit, 200)],
  );
  return rows.map((row) => ({
    ...normalizeProductCandidateSnapshot(row, {
      sourceType: 'vector_recall',
      sourceName: 'products_cache_embeddings',
      observedAt: row.updated_at || row.cached_at,
      authoritative: false,
      evidenceGrade: 'C',
    }),
    vector_score: clamp01(row.vector_score, 0),
  })).filter((row) => row && row.product_ref);
}

function productIdentityKeys(product = {}) {
  const item = normalizeProductCandidateSnapshot(product) || product;
  const keys = [];
  const push = (prefix, value) => {
    const text = normalizeLower(value, 512);
    if (!text) return;
    keys.push(`${prefix}:${text}`);
  };
  push('ref', item.product_ref);
  push('id', item.product_id || item.productId || item.id || String(item.product_ref || '').replace(/^[a-z][a-z0-9_+-]*:/i, ''));
  push('family', item.product_family_id || item.productFamilyId || item.product_line_id || item.productLineId || item.variant_of || item.variantOf);
  push('url', item.url || item.canonical_url || item.canonicalUrl || item.pdp_url || item.pdpUrl);
  const brand = pickFirstString(item.brand, item.brand_name, item.brandName, item.vendor);
  const name = pickFirstString(item.name, item.title, item.product_name, item.productName);
  if (brand && name) push('text', `${brand}:${name}`);
  else if (name) push('name', name);
  return Array.from(new Set(keys));
}

const STRUCTURED_VARIANT_ALLOW_LABELS = new Set([
  'shade',
  'color',
  'colour',
  'tone',
  'finish',
  'size',
]);

const STRUCTURED_VARIANT_BLOCK_LABELS = new Set([
  'format',
  'set',
  'gift set',
  'bundle',
  'kit',
  'routine',
  'servings',
  'serving',
  'type',
  'refill',
  'edition',
  'pack',
  'scent',
  'fragrance',
]);

function terminalVariantSegment(title) {
  const text = normalizeString(title, 512).replace(/[\u2010-\u2015]/g, '-');
  const match = text.match(/\s(?:-{1,2})\s*([^-\u2010-\u2015]+?)\s*$/);
  if (!match) return null;
  return {
    base: text.slice(0, match.index).trim(),
    segment: match[1].trim(),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickStructuredVariantField(raw = {}, fields = []) {
  const row = asPlainObject(raw) || {};
  const productPayload = firstObject(row.product_payload, row.productPayload);
  const productData = firstObject(row.product_data, row.productData, row.product, row.sku, row.item);
  const seedData = firstObject(row.seed_data, row.seedData);
  const snapshot = firstObject(row.snapshot, productPayload.snapshot, productData.snapshot, seedData.snapshot, seedData.product, seedData.sku);
  const variantObjects = [row, productPayload, productData, seedData, snapshot];
  for (const source of variantObjects) {
    for (const field of fields) {
      const value = normalizeString(source[field], 256);
      if (value) return value;
    }
  }
  return '';
}

function parseStructuredVariantLabelValue(rawValue) {
  const text = normalizeString(rawValue, 256);
  if (!text || !text.includes(':')) return null;
  const colonIndex = text.indexOf(':');
  const label = normalizeFamilyKeySegment(text.slice(0, colonIndex), 80);
  const value = normalizeString(text.slice(colonIndex + 1), 256);
  if (!label || !value) return null;
  return { label, value };
}

function extractStructuredVariantShade(raw = {}) {
  const variantTitle = pickStructuredVariantField(raw, ['variant_title', 'variantTitle']);
  const variantDetailLabel = pickStructuredVariantField(raw, ['variant_detail_label', 'variantDetailLabel']);
  for (const fieldValue of [variantTitle, variantDetailLabel]) {
    if (!fieldValue) continue;
    const parsed = parseStructuredVariantLabelValue(fieldValue);
    if (!parsed) return '';
    if (STRUCTURED_VARIANT_BLOCK_LABELS.has(parsed.label)) return '';
    if (STRUCTURED_VARIANT_ALLOW_LABELS.has(parsed.label)) return parsed.value;
    return '';
  }
  return '';
}

function stripStructuredVariantValueFromTitle(title, raw = {}) {
  const variantValue = extractStructuredVariantShade(raw);
  const normalizedValue = normalizeFamilyKeySegment(variantValue, 256);
  if (!normalizedValue) return '';
  const normalizedTitle = normalizeFamilyKeySegment(title, 512);
  if (!normalizedTitle) return '';
  const valueTokens = normalizedValue.split(/\s+/g).filter(Boolean);
  if (!valueTokens.length) return '';
  const phrasePattern = valueTokens.map(escapeRegExp).join('\\s+');
  const pattern = new RegExp(`(^|\\s)${phrasePattern}(?=\\s|$)`, 'g');
  const stripped = normalizedTitle.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
  if (stripped === normalizedTitle) return '';
  const strippedTokens = stripped.split(/\s+/g).filter(Boolean);
  if (stripped.length < 3 || strippedTokens.length < 2) return '';
  return stripped;
}

function stripTerminalSizeSuffix(title) {
  const sizePattern = String.raw`\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|ml|g)`;
  const pattern = new RegExp(String.raw`(?:\s+|(?:\s*[-\u2010-\u2015]\s*))${sizePattern}(?:\s*/\s*${sizePattern})?\s*$`, 'i');
  return normalizeString(title, 512).replace(pattern, '').replace(/\s*[-\u2010-\u2015]\s*$/, '').trim();
}

function stripRecognizedShadeSizeSuffix(title, raw = {}) {
  const withStructuredVariantStripped = stripStructuredVariantValueFromTitle(title, raw);
  if (withStructuredVariantStripped) return withStructuredVariantStripped;

  const withSizeStripped = stripTerminalSizeSuffix(title);
  if (withSizeStripped && withSizeStripped !== normalizeString(title, 512)) return withSizeStripped;

  const terminal = terminalVariantSegment(title);
  if (!terminal || !terminal.base || !terminal.segment) return normalizeString(title, 512);
  if (
    isRecognizedNumericShadeSegment(terminal.segment) ||
    isRecognizedLexiconShadeSegment(terminal.segment)
  ) {
    return terminal.base;
  }
  return normalizeString(title, 512);
}

function familyCategoryGuard(item = {}, raw = {}) {
  const rawObj = asPlainObject(raw) || {};
  const productData = firstObject(rawObj.product_data, rawObj.productData, rawObj.product, rawObj.sku, rawObj.item);
  const seedData = firstObject(rawObj.seed_data, rawObj.seedData);
  const snapshot = firstObject(rawObj.snapshot, productData.snapshot, seedData.snapshot, seedData.product, seedData.sku);
  return normalizeFamilyKeySegment(
    pickFirstString(
      item.category,
      item.product_type,
      item.productType,
      rawObj.category,
      rawObj.product_type,
      rawObj.productType,
      productData.category,
      productData.product_type,
      productData.productType,
      seedData.category,
      seedData.product_type,
      seedData.productType,
      snapshot.category,
      snapshot.product_type,
      snapshot.productType,
    ),
    160,
  );
}

function familyIdentityKey(product = {}) {
  const item = normalizeProductCandidateSnapshot(product) || product;
  const family = pickFirstString(
    item.product_family_id,
    item.productFamilyId,
    item.product_line_id,
    item.productLineId,
    item.variant_of,
    item.variantOf,
  );
  if (family) return `family:${normalizeLower(family, 512)}`;
  const brand = pickFirstString(item.brand, item.brand_name, item.brandName, item.vendor);
  const name = pickFirstString(item.name, item.title, item.product_name, item.productName);
  if (brand && name) {
    const normalizedBrand = normalizeFamilyKeySegment(brand, 160);
    const strippedTitle = normalizeFamilyKeySegment(stripRecognizedShadeSizeSuffix(name, product), 512);
    if (normalizedBrand && strippedTitle) {
      return `family:v1:${normalizedBrand}::${strippedTitle}::${familyCategoryGuard(item, product)}`;
    }
  }
  if (item.url) return `url:${normalizeLower(item.url, 512)}`;
  return `ref:${normalizeLower(item.product_ref, 512)}`;
}

function familyIdentityKeyParts(key) {
  const text = normalizeString(key, 1200);
  if (!text.startsWith('family:v1:')) {
    return { key: text, base_key: text, category_guard: '', derived: false };
  }
  const rest = text.slice('family:v1:'.length);
  const parts = rest.split('::');
  if (parts.length < 3) {
    return { key: text, base_key: text, category_guard: '', derived: false };
  }
  const brand = parts[0] || '';
  const title = parts[1] || '';
  const category = parts.slice(2).join('::') || '';
  return {
    key: text,
    base_key: `family:v1:${brand}::${title}`,
    category_guard: category,
    derived: true,
  };
}

function familyIdentityKeysCompatible(leftKey, rightKey) {
  const left = familyIdentityKeyParts(leftKey);
  const right = familyIdentityKeyParts(rightKey);
  if (!left.key || !right.key) return false;
  if (left.key === right.key) return true;
  if (!left.derived || !right.derived || left.base_key !== right.base_key) return false;
  return !left.category_guard || !right.category_guard || left.category_guard === right.category_guard;
}

function createFamilyDedupeIndex() {
  return {
    keysByBase: new Map(),
    categoriesByKey: new Map(),
  };
}

function groupCompatibleWithFamilyKey(index, groupKey, familyKey) {
  const groupCategories = index.categoriesByKey.get(groupKey) || new Set();
  const candidateCategory = familyIdentityKeyParts(familyKey).category_guard;
  if (!candidateCategory) return true;
  if (!groupCategories.size) return true;
  return groupCategories.has(candidateCategory);
}

function resolveFamilyDedupeKey(index, familyKey) {
  const parts = familyIdentityKeyParts(familyKey);
  const existingKeys = index.keysByBase.get(parts.base_key) || [];
  for (const existingKey of existingKeys) {
    if (
      familyIdentityKeysCompatible(existingKey, familyKey) &&
      groupCompatibleWithFamilyKey(index, existingKey, familyKey)
    ) {
      return existingKey;
    }
  }
  return familyKey;
}

function rememberFamilyDedupeKey(index, groupKey, familyKey = groupKey) {
  const parts = familyIdentityKeyParts(groupKey);
  const keys = index.keysByBase.get(parts.base_key) || [];
  if (!keys.includes(groupKey)) {
    keys.push(groupKey);
    index.keysByBase.set(parts.base_key, keys);
  }
  const familyParts = familyIdentityKeyParts(familyKey);
  if (familyParts.category_guard) {
    if (!index.categoriesByKey.has(groupKey)) index.categoriesByKey.set(groupKey, new Set());
    index.categoriesByKey.get(groupKey).add(familyParts.category_guard);
  } else if (!index.categoriesByKey.has(groupKey)) {
    index.categoriesByKey.set(groupKey, new Set());
  }
}

function mergeFamilyDedupeCandidate(byFamily, index, candidate) {
  const familyKey = familyIdentityKey(candidate);
  const key = resolveFamilyDedupeKey(index, familyKey);
  byFamily.set(key, mergeDuplicateCandidate(byFamily.get(key), candidate));
  rememberFamilyDedupeKey(index, key, familyKey);
  return key;
}

function tokenSet(value) {
  const text = normalizeTokenText(value).toLowerCase();
  return new Set(text.split(/[^a-z0-9]+/g).filter((token) => token.length >= 3));
}

function overlapScore(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits += 1;
  }
  return hits / Math.max(a.size, b.size);
}

// A shared category is a shelf, not evidence that two products are alike. Two equal one-word
// categories ("mask", "sunscreen") overlap 1.0, and through the max() in scoreCandidateForAnchor
// that alone scored every same-shelf pair 1.0. Category agreement is capped at the exact-category
// floor, and catch-all shelves (beauty/haircare/general -> "general") count for nothing.
const CATEGORY_MATCH_CEILING = 0.72;
const PLACEHOLDER_CATEGORY_TOKENS = new Set([
  'default',
  'general',
  'misc',
  'miscellaneous',
  'none',
  'other',
  'others',
  'uncategorized',
  'unknown',
]);

function informativeTokenText(value, excluded = PLACEHOLDER_CATEGORY_TOKENS) {
  return Array.from(tokenSet(value)).filter((token) => !excluded.has(token)).join(' ');
}

function categoryTokens(product = {}) {
  return [...tokenSet(product.category), ...tokenSet(product.category_taxonomy)];
}

function hasIntersectingIdentity(left, right) {
  const a = new Set(productIdentityKeys(left));
  for (const key of productIdentityKeys(right)) {
    if (a.has(key)) return true;
  }
  return false;
}

function buildIntelIndex(intelRows = []) {
  const index = new Map();
  for (const raw of Array.isArray(intelRows) ? intelRows : []) {
    const intel = normalizeProductIntelKbRow(raw) || (!raw.analysis && !raw.product_intel ? normalizeProductCandidateSnapshot(raw) : null);
    if (!intel) continue;
    for (const key of evidenceIdentityKeys(intel)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(intel);
    }
  }
  return index;
}

function findIntelForCandidate(candidate, intelIndex) {
  if (!intelIndex || typeof intelIndex.get !== 'function') return [];
  const matches = [];
  const seen = new Set();
  for (const key of evidenceIdentityKeys(candidate)) {
    for (const row of intelIndex.get(key) || []) {
      const ref = row._graph_seller_identity_key ? row._product_intel_record_ref : row.product_ref || key;
      if (seen.has(ref)) continue;
      if (!compatibleEvidenceIdentity(candidate, row)) continue;
      seen.add(ref);
      matches.push(row);
    }
  }
  return matches;
}

function mergeCandidateWithIntel(candidate, intelRows) {
  const graphLane=intelRows.some(row=>row._graph_seller_identity_key);
  const protectedIntel = bundle => {
    const {isProtectedPivotaInsight}=require('../services/pivotaInsightsQuality');const meta=bundle?.provenance||{};
    return bundle && (isProtectedPivotaInsight({analysis:{product_intel_v1:bundle},source_meta:meta})||/human/i.test(meta.reviewer_kind||meta.review_tier||'')||
      [bundle.quality_state,bundle.product_intel_core?.quality_state,meta.quality_state,meta.review_decision].some(value=>/^(reject|reject_external|rejected|blocked|needs_review|suppressed|fail|failed)$/i.test(String(value||''))));
  };
  if(graphLane&&protectedIntel(candidate.product_intel)) return candidate;
  const intel = [...intelRows].filter((row) => {
    if(!row.product_intel||!compatibleEvidenceIdentity(candidate,row))return false;
    if(!row._graph_seller_identity_key)return true;
    try {return require('../services/relationshipReviewedIngredientEvidence').identityKey(candidate)===row._graph_seller_identity_key;}catch(_){return false;}
  }).sort((a, b) => (graphLane ? Number(Boolean(protectedIntel(b.product_intel)))-Number(Boolean(protectedIntel(a.product_intel))) : 0)||
    String(b.observed_at || '').localeCompare(String(a.observed_at || '')))[0];
  if (!intel) return candidate;
  return {
    ...candidate,
    source_refs: mergeSourceRefs(candidate.source_refs, intel.source_refs),
    product_intel: intel.product_intel,
    product_intel_binding: {
      schema: 'relgraph.product_intel_binding.v1',
      source_record_ref: intel._product_intel_record_ref || intel.product_ref,
      identity: Object.fromEntries(['product_key', 'pivota_signature_id', 'product_id', 'source_product_id',
        'merchant_id', 'platform', 'market', 'variant_title', 'variant_detail_label', 'brand', 'url']
        .map((field) => [field, field === 'pivota_signature_id' ? evidenceSignature(intel) : intel[field] || ''])),
      matched_identity_keys: evidenceIdentityKeys(intel).filter((key) => evidenceIdentityKeys(candidate).includes(key)),
    },
    ...(intel.product_intel_evidence_incomplete ? { product_intel_evidence_incomplete: true } : {}),
    intel_text: intel.intel_text,
    description: candidate.description || intel.description,
    category: candidate.category || intel.category,
    category_taxonomy: candidate.category_taxonomy?.length ? candidate.category_taxonomy : intel.category_taxonomy,
  };
}

// Evidence joins use exact listing identifiers only. Names and family ids remain useful for
// recall/deduplication, but cannot bind a formula or source confidence to another variant.
function evidenceIdentityKeys(product = {}) {
  const keys = new Set();
  const add = (kind, value) => { const text = normalizeString(value, 512); if (text) keys.add(`${kind}:${text}`); };
  add('product_key', product.product_key);
  add('signature', evidenceSignature(product));
  const ids = [product.product_id, product.source_product_id, product.sku_key,
    /^product:/i.test(product.product_ref || '') ? stripRefPrefix(product.product_ref) : ''];
  // Catalog source ids are often recycled between stores. A raw id/ref without an exact key,
  // signature, URL, or merchant scope cannot bind another listing's ingredients.
  for (const value of ids.filter(Boolean)) {
    if (/^ext_/i.test(value)) add('external_id', value);
    if (product.merchant_id) add(`merchant_id:${product.merchant_id}:platform:${product.platform || ''}`, value);
  }
  add('url', product.url);
  return [...keys];
}

function evidenceSignature(product = {}) {
  return product.pivota_signature_id || (/^product:sig_/i.test(product.product_ref || '') ? stripRefPrefix(product.product_ref) : '');
}

function evidenceIdentityConflicts(product, evidence) {
  const merchant = (item) => normalizeLower(item.merchant_id) === 'external_seed' ? '' : normalizeLower(item.merchant_id);
  for (const field of ['pivota_signature_id', 'product_key', 'market']) {
    if (product[field] && evidence[field] && (field === 'market'
      ? normalizeMarket(product[field]) !== normalizeMarket(evidence[field])
      : product[field] !== evidence[field])) return true;
  }
  if (evidenceSignature(product) && evidenceSignature(evidence) && evidenceSignature(product) !== evidenceSignature(evidence)) return true;
  if (merchant(product) && merchant(evidence) && merchant(product) !== merchant(evidence)) return true;
  if (product.brand && evidence.brand && pairBrand(product) !== pairBrand(evidence)) return true;
  for (const field of ['variant_title', 'variant_detail_label']) {
    if (product[field] && evidence[field] && normalizeLower(product[field]) !== normalizeLower(evidence[field])) return true;
  }
  if (product.platform && evidence.platform && normalizeLower(product.platform) !== normalizeLower(evidence.platform)) return true;
  const canonical = evidence.product_intel?.canonical_product_ref;
  if (canonical && merchant(product) && merchant(product) === merchant(evidence) && product.platform &&
    normalizeLower(product.platform) === normalizeLower(evidence.platform)) {
    const ownerIds = new Set([product.product_id, product.source_product_id, product.sku_key, product.product_key,
      evidenceSignature(product), product.product_ref, stripRefPrefix(product.product_ref)].filter(Boolean));
    if ([canonical.product_id, canonical.productId, canonical.source_product_id, canonical.sourceProductId]
      .filter(Boolean).some((id) => !ownerIds.has(id) && !ownerIds.has(stripRefPrefix(id)))) return true;
  }
  return false;
}

function compatibleEvidenceIdentity(product, evidence) {
  if (evidenceIdentityConflicts(product, evidence)) return false;
  const keys = new Set(evidenceIdentityKeys(product));
  return evidenceIdentityKeys(evidence).some((key) => keys.has(key));
}

function buildIngredientIndex(rows) {
  const index = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeIngredientKbRow(raw);
    if (!row) continue;
    for (const key of evidenceIdentityKeys(row)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
  }
  return index;
}

function mergeCandidateWithIngredients(candidate, index) {
  const matches = new Set(evidenceIdentityKeys(candidate).flatMap((key) => index.get(key) || []));
  const rows = [...matches].filter((row) => {
    if (!compatibleEvidenceIdentity(candidate, row)) return false;
    if (!row.reviewed_ingredient_identity_key) return true;
    try { return require('../services/relationshipReviewedIngredientEvidence').identityKey(candidate) === row.reviewed_ingredient_identity_key; }
    catch (_) { return false; }
  });
  if (!rows.length) return candidate;
  const evidence = [...(candidate.ingredient_evidence || []), ...rows.flatMap((row) => row.ingredient_evidence || [])];
  const unique = [...new Map(evidence.map((row) => [JSON.stringify(row), row])).values()].slice(0, 8);
  const texts = [candidate.ingredient_text, ...rows.map((row) => row.ingredient_text)].filter(Boolean);
  const conflicting = candidate.ingredient_evidence_conflict === true || new Set(texts.map(ingredientFormulaKey)).size > 1;
  const incomplete = candidate.ingredient_evidence_incomplete === true || rows.some((row) => row.ingredient_evidence_incomplete);
  const { ingredient_text: _previous, ...rest } = candidate;
  return { ...rest,
    ...(conflicting ? { ingredient_evidence_conflict: true } : {}),
    ...(incomplete ? { ingredient_evidence_incomplete: true } : {}),
    ...(!conflicting && !incomplete ? { ingredient_text: texts[0] } : {}),
    ingredient_evidence: unique,
    source_refs: mergeSourceRefs(candidate.source_refs, ...rows.map((row) => row.source_refs)),
  };
}

function ingredientFormulaKey(value) {
  return normalizeLower(value, 6000).replace(/[^a-z0-9]+/g, ' ').trim();
}

function ingredientEvidenceForSnapshot(snapshot) {
  if (snapshot.ingredient_evidence?.length) return snapshot.ingredient_evidence;
  return snapshot.ingredient_text ? [{ table: 'product_snapshot', product_ref: snapshot.product_ref,
    product_key: snapshot.product_key, ingredient_text: snapshot.ingredient_text,
    observed_at: snapshot.observed_at, source_refs: snapshot.source_refs || [] }] : [];
}

function enrichProductsWithEvidence(products = [], { intelRows = [], ingredientRows = [] } = {}) {
  const intelIndex = buildIntelIndex(intelRows);
  const ingredientIndex = buildIngredientIndex(ingredientRows);
  return (Array.isArray(products) ? products : []).map((raw) => {
    const normalized = normalizeProductCandidateSnapshot(raw);
    if (!normalized) return null;
    const product = { ...raw, ...normalized }; // Retain caller metadata and protected label fields.
    return mergeCandidateWithIngredients(mergeCandidateWithIntel(product, findIntelForCandidate(product, intelIndex)), ingredientIndex);
  }).filter(Boolean);
}

async function enrichProductRelationshipGraphProducts({ queryFn, products = [], limit = DEFAULT_SOURCE_LIMIT, market = DEFAULT_MARKET } = {}) {
  const batchSize = Math.min(200, normalizeLimit(limit));
  const intelRows = [];
  const ingredientRows = [];
  for (let offset = 0; offset < products.length; offset += batchSize) {
    const targetProducts = products.slice(offset, offset + batchSize);
    const [intel, ingredients] = await Promise.all([
      loadProductIntelKbRows({ queryFn, targetProducts, market }),
      loadIngredientKbCandidates({ queryFn, targetProducts, market }),
    ]);
    intelRows.push(...intel); ingredientRows.push(...ingredients);
  }
  const enriched = enrichProductsWithEvidence(products, { intelRows, ingredientRows });
  return { products: enriched, intelRows, ingredientRows, diagnostics: {
    targeted_products: products.length, products_with_ingredients: enriched.filter((row) => row.ingredient_text).length,
    ingredient_conflicts: enriched.filter((row) => row.ingredient_evidence_conflict).length,
    products_with_intel: enriched.filter((row) => row.product_intel).length,
    requested_products: products.length, targeted_products_complete: enriched.length === products.length,
    evidence_records_per_product_per_source_limit: 4,
    ingredient_loads_incomplete: enriched.filter((row) => row.ingredient_evidence_incomplete).length,
    intel_loads_incomplete: enriched.filter((row) => row.product_intel_evidence_incomplete).length,
  } };
}

function normalizeLegacyRows(legacyDupes = []) {
  return (Array.isArray(legacyDupes) ? legacyDupes : [])
    .map((row) => {
      if (row && Array.isArray(row.dupes) && Array.isArray(row.comparables) && row.original !== undefined) {
        return row;
      }
      return normalizeLegacyDupeKbRow(row);
    })
    .filter(Boolean);
}

function legacySignalsForAnchor(anchor, legacyRows) {
  const explicitCandidates = [];
  const candidateKeys = new Set();
  const dupeCandidateKeys = new Set();
  for (const row of legacyRows) {
    const original = row.original || { product_ref: row.kb_key };
    const rowMatchesAnchor =
      hasIntersectingIdentity(anchor, original) ||
      normalizeLower(row.kb_key) === normalizeLower(anchor.product_ref);
    if (!rowMatchesAnchor) continue;
    for (const candidate of [...(row.dupes || []), ...(row.comparables || [])]) {
      explicitCandidates.push(candidate);
      for (const key of productIdentityKeys(candidate)) {
        candidateKeys.add(key);
        if (row.verified === true && (row.dupes || []).includes(candidate)) dupeCandidateKeys.add(key);
      }
    }
  }
  return { explicitCandidates, candidateKeys, dupeCandidateKeys };
}

function scoreCandidateForAnchor(anchor, candidate, { legacyMatch = false, intelMatch = false } = {}) {
  const anchorText = [
    anchor.name,
    anchor.category,
    normalizeTokenText(anchor.category_taxonomy),
    anchor.description,
    anchor.ingredient_text,
    normalizeTokenText(anchor.tags),
  ].filter(Boolean).join(' ');
  const candidateText = [
    candidate.name,
    candidate.category,
    normalizeTokenText(candidate.category_taxonomy),
    candidate.description,
    candidate.ingredient_text,
    normalizeTokenText(candidate.tags),
    candidate.intel_text,
  ].filter(Boolean).join(' ');
  const nameScore = overlapScore(anchor.name, candidate.name);
  const anchorCategory = informativeTokenText(anchor.category);
  const candidateCategory = informativeTokenText(candidate.category);
  const categoryMatch = Math.min(
    CATEGORY_MATCH_CEILING,
    Math.max(
      overlapScore(anchorCategory, candidateCategory),
      overlapScore(informativeTokenText(anchor.category_taxonomy), informativeTokenText(candidate.category_taxonomy)),
      overlapScore(anchor.name, candidateCategory),
    ),
  );
  const categoryScoreBase = Math.max(categoryMatch, nameScore * 0.65);
  const exactCategory = Boolean(anchorCategory) &&
    normalizeLower(anchor.category) === normalizeLower(candidate.category);
  // Tags that only repeat a category (retailer rows carry tags = [category leaf]) are the category
  // term again; they must not re-enter as product evidence below.
  const shelfTokens = new Set([...PLACEHOLDER_CATEGORY_TOKENS, ...categoryTokens(anchor), ...categoryTokens(candidate)]);
  // Curated dupe evidence (aurora_dupe_kb) is evidence about THIS pair and lifts category agreement.
  // A product-intel row is evidence that the candidate is documented, not that it resembles the
  // anchor; it counts in evidence_quality below, never in similarity.
  const categoryUseCase = clamp01(
    Math.max(categoryScoreBase, exactCategory ? 0.72 : 0) +
      (legacyMatch ? 0.12 : 0),
    0,
  );
  const ingredientOverlap = overlapScore(anchor.ingredient_text, candidate.ingredient_text);
  const descriptionOverlap = overlapScore(
    informativeTokenText(anchor.description, shelfTokens),
    informativeTokenText(candidate.description, shelfTokens),
  );
  const tagOverlap = overlapScore(informativeTokenText(anchor.tags, shelfTokens), informativeTokenText(candidate.tags, shelfTokens));
  const textOverlap = overlapScore(anchorText, candidateText);
  const ingredientScore = Math.max(
    ingredientOverlap,
    descriptionOverlap,
    tagOverlap,
    textOverlap * 0.75,
    categoryUseCase * 0.72,
  );
  const sourceBonus = sourceStrength(candidate.source_refs);
  const explicitScore = clamp01(candidate.similarity_score ?? candidate.score_total ?? candidate.vector_score, 0);
  // score_total = base + (1 - base) * pair evidence.
  //
  // 2026-09-26 JP/AU dry run (gateway cecd89171, shard 0): 764 of 1,184 competitive_alternative
  // edges scored exactly 0.93 and 371 exactly 0.80. The old score was max(channels) + constants:
  // every exact-category pair sat on the 0.72 shelf floor, then +0.08 for an external-seed source
  // or +0.05 +0.05 +0.11 for a product-intel row, and name / ingredient / description agreement
  // changed nothing. 94.8% of edges scored >= 0.8 and the score did not rank.
  //
  // `base` is the strongest coarse channel (a vector/explicit score, or category agreement with its
  // 0.72 shelf cap). Pair evidence is graded and only ever adds: shared name words, shared INCI,
  // shared informative description or tag words, whole-text overlap. Two products on the same
  // shelf with nothing else in common stay at the shelf floor; a same-shelf pair named and
  // formulated alike approaches 1. Provenance (source strength, product intel) is not similarity
  // and lives in evidence_quality / availability_confidence.
  const pairEvidence = clamp01(
    0.4 * nameScore +
      0.3 * ingredientOverlap +
      0.15 * Math.max(descriptionOverlap, tagOverlap) +
      0.15 * textOverlap,
    0,
  );
  const base = Math.max(explicitScore, categoryUseCase);
  const similarityScore = clamp01(base + (1 - base) * pairEvidence, 0);
  const candidatePrice = toNumberOrNull(candidate.price);
  const priceRatio = comparablePriceRatio(
    readPriceWithCurrency([[anchor, 'price']], toNumberOrNull),
    readPriceWithCurrency([[candidate, 'price']], toNumberOrNull),
  );
  const priceAdvantage = priceRatio == null ? 0 : clamp01(1 - Math.min(priceRatio, 1), 0);

  return {
    category_use_case_match: Number(categoryUseCase.toFixed(4)),
    ingredient_functional_similarity: Number(clamp01(ingredientScore, 0).toFixed(4)),
    price_advantage: Number(priceAdvantage.toFixed(4)),
    evidence_quality: Number(clamp01(0.62 + sourceBonus + (legacyMatch ? 0.08 : 0) + (intelMatch ? 0.05 : 0), 0).toFixed(4)),
    availability_confidence: Number(clamp01(0.66 + (candidatePrice != null ? 0.08 : 0) + sourceBonus / 2, 0).toFixed(4)),
    social_reference_strength: normalizeSourceRefs(candidate.source_refs).some((ref) =>
      ['verified_review', 'verified_reviews', 'review_aggregate'].includes(ref.type) && ref.authoritative === true) ? 0.2 : 0,
    score_total: Number(similarityScore.toFixed(4)),
  };
}

function shouldKeepScoredCandidate(candidate, score, legacyMatch) {
  if (legacyMatch) return true;
  if (score.category_use_case_match >= 0.35) return true;
  if (score.score_total >= 0.45) return true;
  return sourceTypesFromRefs(candidate.source_refs).includes('product_intel_kb') && score.score_total >= 0.35;
}

function compareScoredCandidates(a, b) {
  const scoreDelta = Number(b.similarity_score || b.score_total || 0) - Number(a.similarity_score || a.score_total || 0);
  if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
  const catDelta = Number(b.category_use_case_match || 0) - Number(a.category_use_case_match || 0);
  if (Math.abs(catDelta) > 0.0001) return catDelta;
  const gradeDelta = (EVIDENCE_GRADE_RANK[normalizeEvidenceGrade(b.evidence_grade)] || 0) - (EVIDENCE_GRADE_RANK[normalizeEvidenceGrade(a.evidence_grade)] || 0);
  if (gradeDelta) return gradeDelta;
  // Cheaper first, but only between two amounts in one known currency.
  const priceA = readPriceWithCurrency([[a, 'price']], toNumberOrNull);
  const priceB = readPriceWithCurrency([[b, 'price']], toNumberOrNull);
  if (
    priceA.amount != null &&
    priceB.amount != null &&
    priceA.currency &&
    priceA.currency === priceB.currency &&
    priceA.amount !== priceB.amount
  ) return priceA.amount - priceB.amount;
  return normalizeLower(a.product_ref).localeCompare(normalizeLower(b.product_ref));
}

// Reserve half the bounded pool for documented cross-brand opportunities when
// they exist. Similarity alone ranks near-identical house variants first; brand
// diversity is a retrieval opportunity, never evidence of recommendation utility.
function selectCandidateOpportunities(anchor, candidates, maxPerAnchor = 24) {
  const cap = Math.max(1, Math.trunc(Number(maxPerAnchor) || 24));
  const ranked = candidates.filter((candidate) => !isSameProductOrVariant(anchor, candidate)).sort(compareScoredCandidates);
  const anchorBrand = pairBrand(anchor);
  // Resolve lazily: the builder consumes this source module; execution happens
  // after both modules are initialized, and shares its structural admission rules.
  const { inferRelationship } = require('./productRelationshipGraphBuilder').__internal;
  const crossBrand = ranked.filter((candidate) => anchorBrand && pairBrand(candidate) &&
    pairBrand(candidate) !== anchorBrand && candidate.category_use_case_match >= 0.55 &&
    (candidate._legacy_match || sharedSpecificNameWords(anchor, candidate).length >= 2 ||
      overlapScore(anchor.ingredient_text, candidate.ingredient_text) >= 0.1 ||
      overlapScore(anchor.description, candidate.description) >= 0.15) &&
    ['dupe', 'competitive_alternative'].includes(inferRelationship(anchor, candidate, candidate).relation_type));
  const reserved = [];
  const seenBrands = new Set();
  const reserve = Math.min(Math.ceil(cap / 2), crossBrand.length);
  for (const candidate of crossBrand) {
    if (seenBrands.has(pairBrand(candidate))) continue;
    reserved.push(candidate); seenBrands.add(pairBrand(candidate));
    if (reserved.length >= reserve) break;
  }
  for (const candidate of crossBrand) {
    if (reserved.length >= reserve) break;
    if (!reserved.includes(candidate)) reserved.push(candidate);
  }
  const chosen = new Set(reserved);
  for (const candidate of ranked) {
    if (chosen.size >= cap) break;
    chosen.add(candidate);
  }
  return [...chosen].sort(compareScoredCandidates);
}

// A retrieval budget, not a recommendation threshold. The existing final cap
// remains the only post-evidence opportunity cap. Callers can use the same
// bounded budget for offline A/B evaluation without changing semantic guards.
const MAX_CANDIDATE_HYDRATION_SHORTLIST = 100;
function normalizeCandidateHydrationShortlistLimit(maxPerAnchor = 24, requestedLimit) {
  const finalCap = Math.max(1, Math.min(MAX_CANDIDATE_HYDRATION_SHORTLIST,
    Math.trunc(Number(maxPerAnchor) || 24)));
  const requested = Number(requestedLimit);
  const budget = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : finalCap * 3;
  return Math.min(MAX_CANDIDATE_HYDRATION_SHORTLIST, Math.max(finalCap, budget));
}

// Once anchors are admitted, one anchor must not consume every exact-evidence
// slot before another receives its first candidate. Source lanes are interleaved
// as well; catalog recall cannot displace all candidates from the existing pool.
// Identity deduplication is performed by the caller using exact listing keys.
function interleaveCandidateHydrationTargets(anchors = [], candidateMaps = []) {
  const pools = anchors.map((anchor) => {
    const lanes = candidateMaps.map((map) => map?.[anchor.product_ref] || []);
    const items = [];
    for (let index = 0; index < Math.max(0, ...lanes.map((lane) => lane.length)); index += 1) {
      for (const lane of lanes) if (lane[index]) items.push(lane[index]);
    }
    return items;
  });
  const targets = [];
  for (let index = 0; index < Math.max(0, ...pools.map((pool) => pool.length)); index += 1) {
    for (const pool of pools) if (pool[index]) targets.push(pool[index]);
  }
  return targets;
}

// Fields that name one listing. They move as a block from a single record, never field by field.
const LISTING_IDENTITY_FIELDS = [
  'product_ref',
  'product_id',
  'product_key',
  'source_product_id',
  'pivota_signature_id',
  'content_key',
];

// A retailer-lane catalog row and the external_product_seeds row attached to it collapse into one
// family. Serving reads edges by `product:sig_<hash>` and the affected selector emits the sig, so
// when only one side carries a pivota signature, that side owns the merged identity.
function listingIdentityOwner(preferred, secondary) {
  const hasSig = (item) => Boolean(normalizeString(item?.pivota_signature_id));
  return !hasSig(preferred) && hasSig(secondary) ? secondary : preferred;
}

function mergeDuplicateCandidate(existing, candidate) {
  if (!existing) return candidate;
  const evidenceOnly = (item) => ['ingredient_kb', 'product_intel_kb'].includes(item._source_type);
  const preferred = evidenceOnly(existing) !== evidenceOnly(candidate)
    ? evidenceOnly(existing) ? candidate : existing
    : compareScoredCandidates(existing, candidate) <= 0 ? existing : candidate;
  const secondary = preferred === existing ? candidate : existing;
  const identityOwner = listingIdentityOwner(preferred, secondary);
  const identity = Object.fromEntries(LISTING_IDENTITY_FIELDS.map((field) => [field, identityOwner[field]]));
  const sameListing = compatibleEvidenceIdentity(preferred, secondary);
  const evidenceOwner = identityOwner !== preferred && !sameListing ? identityOwner : preferred;
  const otherEvidence = evidenceOwner === preferred ? secondary : preferred;
  const shareEvidence = compatibleEvidenceIdentity(evidenceOwner, otherEvidence);
  const formulaConflict = evidenceOwner.ingredient_evidence_conflict || (shareEvidence && (
    otherEvidence.ingredient_evidence_conflict || (evidenceOwner.ingredient_text && otherEvidence.ingredient_text &&
      ingredientFormulaKey(evidenceOwner.ingredient_text) !== ingredientFormulaKey(otherEvidence.ingredient_text))));
  const formulaIncomplete = evidenceOwner.ingredient_evidence_incomplete || (shareEvidence && otherEvidence.ingredient_evidence_incomplete);
  const attributedIngredients = shareEvidence
    ? [...ingredientEvidenceForSnapshot(evidenceOwner), ...ingredientEvidenceForSnapshot(otherEvidence)]
    : evidenceOwner.ingredient_evidence || [];
  const ingredientEvidence = [...new Map(attributedIngredients.map((row) => [JSON.stringify(row), row])).values()].slice(0, 8);
  return {
    ...secondary,
    ...preferred,
    ...identity,
    source_refs: mergeSourceRefs(evidenceOwner.source_refs, shareEvidence ? otherEvidence.source_refs
      : normalizeSourceRefs(otherEvidence.source_refs).filter((ref) => !['ingredient_kb', 'product_intel_kb'].includes(ref.type))),
    evidence_grade: betterEvidenceGrade(existing.evidence_grade, candidate.evidence_grade),
    category_taxonomy: normalizeCategoryTaxonomy(existing.category_taxonomy, candidate.category_taxonomy),
    tags: normalizeTextList([existing.tags, candidate.tags].flat(), 32),
    description: pickFirstString(preferred.description, secondary.description),
    ingredient_text: formulaConflict || formulaIncomplete ? undefined
      : normalizeString(evidenceOwner.ingredient_text || (shareEvidence ? otherEvidence.ingredient_text : ''), 6000),
    ingredient_evidence: ingredientEvidence.length ? ingredientEvidence : undefined,
    ingredient_evidence_conflict: Boolean(formulaConflict),
    ingredient_evidence_incomplete: Boolean(formulaIncomplete),
    product_intel: evidenceOwner.product_intel || (shareEvidence ? otherEvidence.product_intel : undefined),
    product_intel_binding: evidenceOwner.product_intel ? evidenceOwner.product_intel_binding
      : shareEvidence ? otherEvidence.product_intel_binding : undefined,
    product_intel_evidence_incomplete: Boolean(evidenceOwner.product_intel_evidence_incomplete || (shareEvidence && otherEvidence.product_intel_evidence_incomplete)),
    intel_text: evidenceOwner.intel_text || (shareEvidence ? otherEvidence.intel_text : undefined),
  };
}

function dedupeNormalizedProducts(products = []) {
  const byKey = new Map();
  const familyIndex = createFamilyDedupeIndex();
  for (const raw of Array.isArray(products) ? products : []) {
    const product = normalizeProductCandidateSnapshot(raw);
    if (!product) continue;
    mergeFamilyDedupeCandidate(byKey, familyIndex, product);
  }
  return Array.from(byKey.values()).sort((a, b) => normalizeLower(a.product_ref).localeCompare(normalizeLower(b.product_ref)));
}

function fanOutCandidatesToSiblingAnchors(candidatesByAnchor, allAnchors = [], representativeAnchors = []) {
  const out = { ...(isPlainObject(candidatesByAnchor) ? candidatesByAnchor : {}) };
  const representatives = (Array.isArray(representativeAnchors) ? representativeAnchors : [])
    .map((anchor) => normalizeProductCandidateSnapshot(anchor))
    .filter(Boolean);
  const anchors = (Array.isArray(allAnchors) ? allAnchors : [])
    .map((anchor) => normalizeProductCandidateSnapshot(anchor))
    .filter(Boolean);
  if (!anchors.length || !representatives.length) return out;

  const repEntries = representatives
    .map((rep) => ({
      ref: normalizeProductRef(rep.product_ref),
      familyKey: familyIdentityKey(rep),
      candidates: out[normalizeProductRef(rep.product_ref)] || out[normalizeLower(normalizeProductRef(rep.product_ref))] || [],
    }))
    .filter((entry) => entry.ref && entry.familyKey && Array.isArray(entry.candidates) && entry.candidates.length > 0);

  for (const anchor of anchors) {
    const anchorRef = normalizeProductRef(anchor.product_ref);
    if (!anchorRef || Array.isArray(out[anchorRef])) continue;
    const anchorFamilyKey = familyIdentityKey(anchor);
    if (!anchorFamilyKey) continue;
    const rep = repEntries.find((entry) =>
      entry.ref !== anchorRef && familyIdentityKeysCompatible(anchorFamilyKey, entry.familyKey)
    );
    if (!rep) continue;
    out[anchorRef] = rep.candidates;
  }
  return out;
}

function buildCandidatesByAnchorFromSources({
  anchors = [],
  products = [],
  productsByAnchor = {},
  legacyDupes = [],
  intelRows = [],
  ingredientRows = [],
  maxPerAnchor = 24,
  includeTransitiveRecall = true,
  maxBridgePerAnchor = 8,
  maxBridgeCandidates = 8,
  maxTransitivePerAnchor = 8,
  fanOutFamilyCandidatesToSiblingAnchors = false,
  includeLegacyExplicitCandidates = true,
  enforceTotalCandidateLimit = false,
} = {}) {
  const normalizedAnchors = enrichProductsWithEvidence(anchors, { intelRows, ingredientRows });
  const familyDedupedAnchors = dedupeNormalizedProducts(normalizedAnchors);
  const normalizedProducts = (Array.isArray(products) ? products : [])
    .map((product) => normalizeProductCandidateSnapshot(product))
    .filter(Boolean);
  const normalizedIntelRows = (Array.isArray(intelRows) ? intelRows : [])
    .map((row) => normalizeProductIntelKbRow(row) || (!row.analysis && !row.product_intel ? normalizeProductCandidateSnapshot(row) : null))
    .filter(Boolean);
  const intelIndex = buildIntelIndex(normalizedIntelRows);
  const ingredientIndex = buildIngredientIndex(ingredientRows);
  const legacyRows = normalizeLegacyRows(legacyDupes);
  const out = {};

  for (const anchor of familyDedupedAnchors) {
    const anchorFamilyKey = familyIdentityKey(anchor);
    const legacy = legacySignalsForAnchor(anchor, legacyRows);
    const rawPool = [...normalizedProducts, ...(productsByAnchor[anchor.product_ref] || []), ...normalizedIntelRows, ...(includeLegacyExplicitCandidates ? legacy.explicitCandidates : [])];
    const rawByFamily = new Map();
    const rawFamilyIndex = createFamilyDedupeIndex();
    const identityToFamilyKey = new Map();
    for (const rawCandidate of rawPool) {
      const normalized = normalizeProductCandidateSnapshot(rawCandidate);
      const baseCandidate = normalized ? mergeCandidateWithIngredients({ ...rawCandidate, ...normalized }, ingredientIndex) : null;
      if (!baseCandidate) continue;
      if (isSameProductOrVariant(anchor, baseCandidate)) continue;
      if (familyIdentityKeysCompatible(anchorFamilyKey, familyIdentityKey(baseCandidate))) continue;
      if (hasIntersectingIdentity(anchor, baseCandidate)) continue;
      const intelMatches = findIntelForCandidate(baseCandidate, intelIndex);
      const enriched = mergeCandidateWithIntel(baseCandidate, intelMatches);
      if (familyIdentityKeysCompatible(anchorFamilyKey, familyIdentityKey(enriched))) continue;
      const candidateKeys = productIdentityKeys(enriched);
      const legacyMatch = candidateKeys.some((key) => legacy.candidateKeys.has(key));
      const familyKey = familyIdentityKey(enriched);
      const existingKey = candidateKeys.map((key) => identityToFamilyKey.get(key)).find(Boolean);
      const key = existingKey || resolveFamilyDedupeKey(rawFamilyIndex, familyKey);
      const mergeInput = {
        ...enriched,
        _legacy_match: legacyMatch,
        _intel_match: intelMatches.length > 0 || sourceTypesFromRefs(enriched.source_refs).includes('product_intel_kb'),
      };
      const previous = rawByFamily.get(key);
      const merged = mergeDuplicateCandidate(previous, mergeInput);
      rawByFamily.set(key, {
        ...merged,
        _legacy_match: Boolean(previous?._legacy_match || mergeInput._legacy_match || merged._legacy_match),
        _intel_match: Boolean(previous?._intel_match || mergeInput._intel_match || merged._intel_match),
      });
      rememberFamilyDedupeKey(rawFamilyIndex, key, familyKey);
      for (const identityKey of candidateKeys) identityToFamilyKey.set(identityKey, key);
    }

    const byFamily = new Map();
    const scoredFamilyIndex = createFamilyDedupeIndex();
    for (const enriched of rawByFamily.values()) {
      const candidateKeys = productIdentityKeys(enriched);
      const legacyMatch = Boolean(enriched._legacy_match) || candidateKeys.some((key) => legacy.candidateKeys.has(key));
      const score = scoreCandidateForAnchor(anchor, enriched, {
        legacyMatch,
        intelMatch: Boolean(enriched._intel_match) || sourceTypesFromRefs(enriched.source_refs).includes('product_intel_kb'),
      });
      if (!shouldKeepScoredCandidate(enriched, score, legacyMatch)) continue;
      const scored = {
        ...enriched,
        ...score,
        similarity_score: score.score_total,
        score_breakdown: score,
        ...(candidateKeys.some((key) => legacy.dupeCandidateKeys.has(key)) ? {
          curated_pair_evidence: { anchor_ref: anchor.product_ref, candidate_ref: enriched.product_ref,
            relation_type: 'dupe', verified: true },
        } : {}),
        source_refs: mergeSourceRefs(
          enriched.source_refs,
          legacyMatch ? { type: 'aurora_dupe_kb', name: 'legacy_match', authoritative: true } : null,
        ),
        why_candidate: {
          summary: legacyMatch
            ? 'Legacy dupe/comparable evidence plus source overlap.'
            : 'Source overlap across category, product text, ingredient, or product-intel evidence.',
          reasons_user_visible: [
            'Category or use-case evidence is aligned.',
            'Candidate source provenance is available.',
          ],
        },
      };
      mergeFamilyDedupeCandidate(byFamily, scoredFamilyIndex, scored);
    }
    out[anchor.product_ref] = selectCandidateOpportunities(anchor, Array.from(byFamily.values()), maxPerAnchor);
  }

  const withSiblingFanout = fanOutFamilyCandidatesToSiblingAnchors
    ? fanOutCandidatesToSiblingAnchors(out, normalizedAnchors, familyDedupedAnchors)
    : out;

  const result = !includeTransitiveRecall ? withSiblingFanout : augmentCandidatesWithTransitiveRecall({
    anchors: familyDedupedAnchors,
    candidatesByAnchor: withSiblingFanout,
    maxPerAnchor,
    maxBridgePerAnchor,
    maxBridgeCandidates,
    maxTransitivePerAnchor,
  });
  if (!enforceTotalCandidateLimit) return result;
  const anchorsByRef = new Map(normalizedAnchors.map((anchor) => [anchor.product_ref, anchor]));
  return Object.fromEntries(Object.entries(result).map(([ref, rows]) => [ref,
    selectCandidateOpportunities(anchorsByRef.get(ref) || {}, rows, maxPerAnchor)]));
}

function candidateMapList(candidatesByAnchor, productRef) {
  const normalizedRef = normalizeProductRef(productRef);
  return (
    candidatesByAnchor[normalizedRef] ||
    candidatesByAnchor[String(normalizedRef).replace(/^product:/, '')] ||
    candidatesByAnchor[normalizeLower(normalizedRef)] ||
    []
  );
}

function normalizeCandidatePreservingFields(input) {
  const normalized = normalizeProductCandidateSnapshot(input);
  if (!normalized) return null;
  return {
    ...normalized,
    ...(isPlainObject(input) ? input : {}),
    product_ref: normalized.product_ref,
    product_id: normalized.product_id,
    brand: normalized.brand,
    name: normalized.name,
    category: normalized.category,
    category_taxonomy: normalizeCategoryTaxonomy(
      isPlainObject(input) ? input.category_taxonomy || input.categoryTaxonomy : null,
      normalized.category_taxonomy,
    ),
    source_refs: mergeSourceRefs(isPlainObject(input) ? input.source_refs || input.sourceRefs : null, normalized.source_refs),
    tags: normalizeTextList([isPlainObject(input) ? input.tags : null, normalized.tags].flat(), 32),
  };
}

function sourceHasProductIntel(candidate) {
  return sourceTypesFromRefs(candidate.source_refs).includes('product_intel_kb');
}

// Two-hop score = direct score * (floor + (1 - floor) * hop confidence): a perfect path keeps the
// direct score, a 0.55 path (the recall cutoff) keeps 89% of it.
const TRANSITIVE_HOP_DECAY_FLOOR = 0.75;

function buildTransitiveRecallCandidate({ anchor, bridge, candidate } = {}) {
  const anchorToBridge = clamp01(bridge?.similarity_score ?? bridge?.score_total, 0);
  const bridgeToCandidate = clamp01(candidate?.similarity_score ?? candidate?.score_total, 0);
  const hopConfidence = Math.sqrt(anchorToBridge * bridgeToCandidate);
  if (hopConfidence < 0.55) return null;

  // The second-hop row's similarity_score / score_total describe it against the BRIDGE. They must
  // not reach scoreCandidateForAnchor, which would read them as an explicit score against the
  // anchor and make every two-hop candidate as strong as its bridge's own best match.
  const { vector_score: _bridgeVector, ...directCandidate } = withoutRelationshipPairContext(candidate);
  const baseScore = scoreCandidateForAnchor(anchor, directCandidate, {
    intelMatch: sourceHasProductIntel(candidate),
  });
  if (baseScore.category_use_case_match < 0.25 && baseScore.score_total < 0.35) return null;

  const categoryUseCase = clamp01(Math.max(
    baseScore.category_use_case_match,
    Math.min(
      clamp01(bridge.category_use_case_match, 0),
      clamp01(candidate.category_use_case_match, 0),
    ) * 0.85,
  ));
  const ingredientSimilarity = clamp01(Math.max(
    baseScore.ingredient_functional_similarity,
    Math.min(
      clamp01(bridge.ingredient_functional_similarity, 0),
      clamp01(candidate.ingredient_functional_similarity, 0),
    ) * 0.85,
  ));
  // A two-hop candidate's score is the DIRECT pair score for (anchor, candidate) — the same
  // evidence formula as a first-hop candidate — decayed by the path confidence. It can never exceed
  // the direct score: before #2290 this was max(direct, bridged category, bridged ingredient,
  // hop * 0.92), so a candidate whose direct score was 0.788 (identical tag list) came back at 1.0
  // through a bridge and outranked every first-hop candidate in the top-24 and the fan-in ranking.
  // The bridged category / ingredient components above are kept for the builder's category gate.
  const scoreTotal = clamp01(baseScore.score_total * (TRANSITIVE_HOP_DECAY_FLOOR + (1 - TRANSITIVE_HOP_DECAY_FLOOR) * hopConfidence));
  const transitiveScore = {
    ...baseScore,
    category_use_case_match: Number(categoryUseCase.toFixed(4)),
    ingredient_functional_similarity: Number(ingredientSimilarity.toFixed(4)),
    evidence_quality: Number(clamp01(Math.max(baseScore.evidence_quality, 0.68)).toFixed(4)),
    availability_confidence: Number(clamp01(baseScore.availability_confidence).toFixed(4)),
    social_reference_strength: Number(clamp01(baseScore.social_reference_strength).toFixed(4)),
    score_total: Number(scoreTotal.toFixed(4)),
    transitive_path_confidence: Number(hopConfidence.toFixed(4)),
  };

  return {
    ...directCandidate,
    ...transitiveScore,
    similarity_score: transitiveScore.score_total,
    score_breakdown: transitiveScore,
    source_refs: mergeSourceRefs(
      directCandidate.source_refs,
      {
        type: 'relationship_graph_transitive_recall',
        name: 'two_hop_candidate',
        authoritative: false,
      },
    ),
    transitive_bridge_ref: bridge.product_ref,
    transitive_path_confidence: transitiveScore.transitive_path_confidence,
    why_candidate: {
      summary: 'Two-hop recall candidate surfaced through another inter-related product; requires normal review before publish.',
      reasons_user_visible: [
        'Candidate is connected through an already plausible intermediate product.',
        'Direct category/use-case evidence is still checked before review.',
      ],
    },
  };
}

function augmentCandidatesWithTransitiveRecall({
  anchors = [],
  candidatesByAnchor = {},
  maxPerAnchor = 24,
  maxBridgePerAnchor = 8,
  maxBridgeCandidates = 8,
  maxTransitivePerAnchor = 8,
} = {}) {
  const normalizedAnchors = (Array.isArray(anchors) ? anchors : [])
    .map((anchor) => normalizeCandidatePreservingFields(anchor))
    .filter(Boolean);
  const out = {};
  for (const [key, value] of Object.entries(candidatesByAnchor || {})) {
    const normalizedRef = normalizeProductRef(key);
    out[normalizedRef] = (Array.isArray(value) ? value : [])
      .map((candidate) => normalizeCandidatePreservingFields(candidate))
      .filter(Boolean)
      .sort(compareScoredCandidates)
      .slice(0, Math.max(1, Number(maxPerAnchor) || 24));
  }

  for (const anchor of normalizedAnchors) {
    const anchorRef = anchor.product_ref;
    const directList = candidateMapList(out, anchorRef);
    if (!directList.length) {
      out[anchorRef] = [];
      continue;
    }

    const anchorIdentity = new Set(productIdentityKeys(anchor));
    const anchorFamilyKey = familyIdentityKey(anchor);
    const directIdentity = new Set(directList.flatMap((candidate) => productIdentityKeys(candidate)));
    const directFamilyKeys = directList.map((candidate) => familyIdentityKey(candidate)).filter(Boolean);
    const transitiveByFamily = new Map();
    const transitiveFamilyIndex = createFamilyDedupeIndex();
    const bridges = directList
      .filter((bridge) => normalizeProductRef(bridge.product_ref) !== anchorRef)
      .filter((bridge) => !familyIdentityKeysCompatible(anchorFamilyKey, familyIdentityKey(bridge)))
      .slice(0, Math.max(1, Number(maxBridgePerAnchor) || 8));

    for (const bridge of bridges) {
      const bridgeFamilyKey = familyIdentityKey(bridge);
      const bridgeList = candidateMapList(out, bridge.product_ref)
        .filter((candidate) => !hasIntersectingIdentity(bridge, candidate))
        .filter((candidate) => !familyIdentityKeysCompatible(bridgeFamilyKey, familyIdentityKey(candidate)))
        .slice(0, Math.max(1, Number(maxBridgeCandidates) || 8));
      for (const secondHop of bridgeList) {
        const secondHopKeys = productIdentityKeys(secondHop);
        if (secondHopKeys.some((key) => anchorIdentity.has(key) || directIdentity.has(key))) continue;
        const secondHopFamilyKey = familyIdentityKey(secondHop);
        if (familyIdentityKeysCompatible(anchorFamilyKey, secondHopFamilyKey)) continue;
        if (directFamilyKeys.some((key) => familyIdentityKeysCompatible(key, secondHopFamilyKey))) continue;
        const transitive = buildTransitiveRecallCandidate({ anchor, bridge, candidate: secondHop });
        if (!transitive) continue;
        mergeFamilyDedupeCandidate(transitiveByFamily, transitiveFamilyIndex, transitive);
      }
    }

    const transitiveRows = Array.from(transitiveByFamily.values())
      .sort(compareScoredCandidates)
      .slice(0, Math.max(0, Number(maxTransitivePerAnchor) || 0));
    const combinedByFamily = new Map();
    const combinedFamilyIndex = createFamilyDedupeIndex();
    for (const row of directList) {
      mergeFamilyDedupeCandidate(combinedByFamily, combinedFamilyIndex, row);
    }
    for (const row of transitiveRows) {
      mergeFamilyDedupeCandidate(combinedByFamily, combinedFamilyIndex, row);
    }
    out[anchorRef] = selectCandidateOpportunities(anchor, Array.from(combinedByFamily.values()),
      Math.max(1, Number(maxPerAnchor) || 24) + Math.max(0, Number(maxTransitivePerAnchor) || 0));
  }

  return out;
}

async function loadProductRelationshipGraphSourceInputs({
  queryFn,
  limit = DEFAULT_SOURCE_LIMIT,
  market = DEFAULT_MARKET,
  queryVector,
  affectedRefs = [],
  includeApprovedLiveExternalSeedAnchors = false,
  approvedLiveExternalSeedAnchorLimit = limit,
  missingCandidateLabelsOnly = false,
  prioritizeUncovered = false,
  uncoveredCooldownDays = 7,
  coverageSiblingRefs = true,
} = {}) {
  const coverageSuppressedIds = prioritizeUncovered
    ? await loadCoverageSuppressedIds({ queryFn, market }) : undefined;
  const sourceLimit = normalizeLimit(limit);
  const approvedLiveExternalSeedAnchors = includeApprovedLiveExternalSeedAnchors
    ? await loadApprovedLiveExternalSeedAnchors({
      queryFn,
      limit: approvedLiveExternalSeedAnchorLimit,
      market,
      missingCandidateLabelsOnly,
    })
    : [];
  const productsCache = await loadProductsCacheCandidates({ queryFn, limit: sourceLimit * 4 });
  const externalSeeds = await loadExternalProductSeedCandidates({ queryFn, limit: sourceLimit * 3, market });
  const ingredientRows = await loadIngredientKbCandidates({ queryFn, limit: sourceLimit * 2 });
  const intelRows = await loadProductIntelKbRows({ queryFn, limit: sourceLimit * 2 });
  const legacyDupes = await loadLegacyDupeKbRows({ queryFn, limit: sourceLimit * 2 });
  const vectorRows = await loadProductsCacheVectorRecallCandidates({ queryFn, queryVector, limit: sourceLimit });
  const affectedProducts = await loadAffectedProductAnchorCandidates({
    queryFn,
    refs: prioritizeUncovered && !affectedRefs.length
      ? [...productsCache, ...externalSeeds, ...ingredientRows, ...vectorRows, ...intelRows, ...approvedLiveExternalSeedAnchors].flatMap(productAnchorRefs)
      : affectedRefs,
    prioritizeUncovered,
    uncoveredCooldownDays,
    coverageSiblingRefs,
    coverageSuppressedIds,
    market,
    limit: Math.max(sourceLimit, Array.isArray(affectedRefs) ? affectedRefs.length * 3 : sourceLimit),
  });
  const products = dedupeNormalizedProducts(enrichProductsWithEvidence([
    ...affectedProducts,
    ...productsCache,
    ...externalSeeds,
    ...vectorRows,
    ...intelRows,
    ...approvedLiveExternalSeedAnchors,
  ], { intelRows, ingredientRows }));
  return {
    products: prioritizeUncovered
      ? prioritizeUncoveredProducts(products, affectedProducts.filter((product) => product._relgraph_uncovered_live))
      : products,
    ...(prioritizeUncovered ? { eligibleAffectedProducts: affectedProducts } : {}),
    approvedLiveExternalSeedAnchors,
    productsCache,
    externalSeeds,
    ingredientRows,
    intelRows,
    legacyDupes,
    vectorRows,
    affectedProducts,
    source_counts: {
      affected_products: affectedProducts.length,
      products_cache: productsCache.length,
      external_product_seeds: externalSeeds.length,
      ingredient_kb: ingredientRows.length,
      product_intel_kb: intelRows.length,
      aurora_dupe_kb: legacyDupes.length,
      vector_recall: vectorRows.length,
      approved_live_external_seed_anchors: approvedLiveExternalSeedAnchors.length,
      products: products.length,
    },
  };
}

module.exports = {
  isSourceMissingError,
  normalizeProductCandidateSnapshot,
  normalizeProductsCacheRow,
  normalizeExternalProductSeedRow,
  normalizeCatalogProductRow,
  normalizeApprovedLiveExternalSeedRow,
  normalizeProductIntelKbRow,
  normalizeProductIntelCanonicalRef,
  normalizeIngredientKbRow,
  enrichProductsWithEvidence,
  enrichProductRelationshipGraphProducts,
  normalizeLegacyDupeKbRow,
  augmentCandidatesWithTransitiveRecall,
  dedupeNormalizedProducts,
  familyIdentityKey,
  familyIdentityKeysCompatible,
  buildCandidatesByAnchorFromSources,
  normalizeCandidateHydrationShortlistLimit,
  interleaveCandidateHydrationTargets,
  loadApprovedLiveExternalSeedAnchors,
  loadProductsCacheCandidates,
  loadAffectedProductAnchorCandidates,
  loadExternalProductSeedCandidates,
  loadProductIntelKbRows,
  loadIngredientKbCandidates,
  loadLegacyDupeKbRows,
  loadProductsCacheVectorRecallCandidates,
  loadProductRelationshipGraphSourceInputs,
  __internal: {
    BEAUTY_TEXT_PATTERNS,
    SOURCE_PRIORITY,
    TRANSITIVE_HOP_DECAY_FLOOR,
    clamp01,
    compareScoredCandidates,
    createFamilyDedupeIndex,
    extractStructuredVariantShade,
    familyIdentityKey,
    familyIdentityKeyParts,
    familyIdentityKeysCompatible,
    rememberFamilyDedupeKey,
    resolveFamilyDedupeKey,
    buildTransitiveRecallCandidate,
    selectCandidateOpportunities,
    fanOutCandidatesToSiblingAnchors,
    inferBrandFromOfficialUrl,
    mergeSourceRefs,
    buildIngredientIndex,
    mergeCandidateWithIngredients,
    buildIntelIndex,
    findIntelForCandidate,
    mergeCandidateWithIntel,
    evidenceIdentityKeys,
    compatibleEvidenceIdentity,
    overlapScore,
    productIdentityKeys,
    normalizeAffectedRefTerms,
    scoreCandidateForAnchor,
    sourceStrength,
    tableExists,
  },
};
