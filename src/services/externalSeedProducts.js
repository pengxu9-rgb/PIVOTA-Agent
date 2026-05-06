const crypto = require('node:crypto');
const { lookupExternalSeedImageOverride } = require('./externalSeedImageOverrides');
const {
  resolveExternalSeedRecallDoc,
  normalizeNonEmptyString,
  resolveExternalSeedProtectionContract,
} = require('./externalSeedRecall');
const { isDisplayablePdpFaqItem } = require('./pdpFaqQuality');
const {
  buildPdpImageDedupeKey,
  classifyShopifyLikeAsset,
  normalizePdpImageUrl,
} = require('../utils/pdpImageUrls');

const SHOPIFY_ASSET_HASH_SUFFIX_RE =
  /^(.*?_[0-9a-z]+(?:[a-z])?)_(?:[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|[0-9a-f-]{16,})(\.[a-z0-9]+)$/i;
const {
  buildAuthoritativeIngredientView,
  mergeIngredientIntelWithAuthority,
} = require('./pdpIngredientAuthority');
const {
  classifyExternalSeedProductKind,
  isIngredientAuthorityEligibleExternalSeed,
} = require('./externalSeedProductKind');
const {
  buildAgentSafeCommerceFacts,
  readCommerceFactsV1,
} = require('../commerce/commerceFacts');
const {
  hasLocalityFactsValue,
  resolveExternalSeedLocalityFacts,
} = require('./externalSeedLocalityFacts');
const {
  buildCatalogImageCacheVisibleUrl,
} = require('./catalogImageCacheStorage');

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
const MAKEUP_FORM_FACTOR_PATTERNS = [
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
];
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
const EXTERNAL_SEED_SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
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

function normalizeBundleComponentRefsForRuntime(value, maxItems = 12) {
  const items = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const productId = normalizeNonEmptyString(item.product_id || item.external_product_id);
    const merchantId = normalizeNonEmptyString(item.merchant_id) || EXTERNAL_SEED_MERCHANT_ID;
    const title = normalizeNonEmptyString(item.title || item.name);
    if (!productId || !title) continue;
    const key = `${merchantId}:${productId}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const inheritanceScope = Array.isArray(item.inheritance_scope)
      ? item.inheritance_scope
          .map((scope) => normalizeNonEmptyString(scope).toLowerCase())
          .filter(Boolean)
      : [];
    out.push({
      merchant_id: merchantId,
      product_id: productId,
      external_product_id: productId,
      title,
      ...(normalizeNonEmptyString(item.component_role || item.role)
        ? { component_role: normalizeNonEmptyString(item.component_role || item.role) }
        : {}),
      ...(normalizeNonEmptyString(item.size_label || item.size)
        ? { size_label: normalizeNonEmptyString(item.size_label || item.size) }
        : {}),
      ...(normalizeNonEmptyString(item.canonical_url || item.url)
        ? { canonical_url: normalizeNonEmptyString(item.canonical_url || item.url) }
        : {}),
      ...(normalizeNonEmptyString(item.source_url) ? { source_url: normalizeNonEmptyString(item.source_url) } : {}),
      ...(inheritanceScope.length ? { inheritance_scope: inheritanceScope } : {}),
      ...(normalizeNonEmptyString(item.review_state)
        ? { review_state: normalizeNonEmptyString(item.review_state).toLowerCase() }
        : {}),
      ...(normalizeNonEmptyString(item.source_kind || item.source)
        ? { source_kind: normalizeNonEmptyString(item.source_kind || item.source) }
        : {}),
    });
    if (out.length >= Math.max(1, Number(maxItems) || 12)) break;
  }
  return out;
}

function normalizePdpFieldQualitySummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next = {};
  for (const key of [
    'description_raw',
    'details_sections',
    'ingredients_raw',
    'active_ingredients_raw',
    'how_to_use_raw',
    'faq_items',
  ]) {
    const row = value?.[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const sourceQualityStatus = normalizeNonEmptyString(row.source_quality_status || row.sourceQualityStatus).toLowerCase();
    const sourceOrigin = normalizeNonEmptyString(row.source_origin || row.sourceOrigin).toLowerCase();
    next[key] = {
      ...(sourceQualityStatus ? { source_quality_status: sourceQualityStatus } : {}),
      ...(sourceOrigin ? { source_origin: sourceOrigin } : {}),
    };
  }
  return Object.keys(next).length > 0 ? next : null;
}

function normalizeExternalSeedSnapshotContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const contractVersion = normalizeNonEmptyString(value.contract_version || value.contractVersion);
  return {
    contract_version: contractVersion || EXTERNAL_SEED_SNAPSHOT_CONTRACT_VERSION,
    authoritative: value.authoritative === true || value.structured_fields_authoritative === true,
    legacy_fields_quarantined: value.legacy_fields_quarantined === true || value.legacyFieldsQuarantined === true,
  };
}

function hasAuthoritativeExternalSeedSnapshotContract(seedData, snapshot) {
  const contract =
    normalizeExternalSeedSnapshotContract(seedData?.external_seed_snapshot_contract) ||
    normalizeExternalSeedSnapshotContract(snapshot?.external_seed_snapshot_contract);
  return contract?.authoritative === true && contract?.legacy_fields_quarantined === true;
}

function deleteLegacyExternalSeedPdpShadowFields(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  for (const fieldName of LEGACY_EXTERNAL_SEED_PDP_SHADOW_FIELDS) {
    delete target[fieldName];
  }
}

function readPdpFieldQualityStatus(summary, key) {
  return normalizeNonEmptyString(summary?.[key]?.source_quality_status).toLowerCase();
}

function isSurfaceablePdpField(summary, key) {
  const status = readPdpFieldQualityStatus(summary, key);
  if (!status) return true;
  return status === 'high' || status === 'medium';
}

function buildApprovedRuntimeSeedData(seedData, pdpFieldQualitySummary) {
  const nextSeedData = cloneJsonValue(ensureJsonObject(seedData));
  const snapshot = ensureJsonObject(nextSeedData.snapshot);
  const authoritativeSnapshotContract = hasAuthoritativeExternalSeedSnapshotContract(nextSeedData, snapshot);

  delete nextSeedData.snapshot_quarantine;
  delete nextSeedData.active_ingredients;
  delete snapshot.active_ingredients;

  const gatedScalarFields = [
    ['pdp_description_raw', 'description_raw'],
    ['pdp_ingredients_raw', 'ingredients_raw'],
    ['pdp_active_ingredients_raw', 'active_ingredients_raw'],
    ['pdp_how_to_use_raw', 'how_to_use_raw'],
  ];
  for (const [fieldName, qualityKey] of gatedScalarFields) {
    if (isSurfaceablePdpField(pdpFieldQualitySummary, qualityKey)) continue;
    delete nextSeedData[fieldName];
    delete snapshot[fieldName];
  }

  if (!isSurfaceablePdpField(pdpFieldQualitySummary, 'faq_items')) {
    delete nextSeedData.pdp_faq_items;
    delete snapshot.pdp_faq_items;
  }
  if (!isSurfaceablePdpField(pdpFieldQualitySummary, 'details_sections')) {
    delete nextSeedData.pdp_details_sections;
    delete snapshot.pdp_details_sections;
  }

  if (authoritativeSnapshotContract) {
    deleteLegacyExternalSeedPdpShadowFields(nextSeedData);
    deleteLegacyExternalSeedPdpShadowFields(snapshot);
  } else if (Array.isArray(nextSeedData.pdp_details_sections) && nextSeedData.pdp_details_sections.length > 0) {
    nextSeedData.details_sections = cloneJsonValue(nextSeedData.pdp_details_sections);
  } else {
    delete nextSeedData.details_sections;
  }
  if (!authoritativeSnapshotContract && Array.isArray(snapshot.pdp_details_sections) && snapshot.pdp_details_sections.length > 0) {
    snapshot.details_sections = cloneJsonValue(snapshot.pdp_details_sections);
  } else {
    delete snapshot.details_sections;
  }

  nextSeedData.snapshot = snapshot;
  return nextSeedData;
}

function shouldExposeAuthorityActiveItems(authority) {
  if (!authority || !Array.isArray(authority.active_items) || authority.active_items.length === 0) return false;
  const sourceOrigin = normalizeNonEmptyString(authority.source_origin).toLowerCase();
  return [
    'ingredients_inci',
    'pdp_section',
    'active_block',
    'active_section',
    'existing_authority',
    'otc_drug_facts',
    'drug_facts',
  ].includes(sourceOrigin);
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

function normalizeReviewModerationState(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (!normalized) return '';
  if (['approved', 'approve', 'published', 'public', 'visible', 'live', 'pass'].includes(normalized)) {
    return 'approved';
  }
  if (['pending', 'queued', 'queue', 'draft', 'review_required', 'employee_review_required'].includes(normalized)) {
    return 'pending';
  }
  if (['rejected', 'reject', 'blocked', 'hidden', 'private', 'removed'].includes(normalized)) {
    return 'rejected';
  }
  return normalized;
}

function normalizeReviewMediaItems(items, limit = 6) {
  const safeItems = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const item of safeItems) {
    if (!item || typeof item !== 'object') continue;
    const type = normalizeNonEmptyString(item.type || item.media_type).toLowerCase() || 'image';
    const url = type === 'image'
      ? normalizePdpImageUrl(item.url || item.image_url || item.src)
      : normalizeHttpUrl(item.url || item.src || item.media_url || item.video_url);
    if (!url) continue;
    const key = buildPdpImageDedupeKey(url) || `${type}:${url.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type,
      url,
      ...(normalizePdpImageUrl(item.thumbnail_url || item.thumbnail || item.thumb_url)
        ? { thumbnail_url: normalizePdpImageUrl(item.thumbnail_url || item.thumbnail || item.thumb_url) }
        : {}),
      ...(normalizeNonEmptyString(item.source) ? { source: normalizeNonEmptyString(item.source) } : {}),
      ...(normalizeNonEmptyString(item.source_kind || item.sourceKind)
        ? { source_kind: normalizeNonEmptyString(item.source_kind || item.sourceKind) }
        : {}),
      ...(normalizeNonEmptyString(item.source_scope || item.sourceScope)
        ? { source_scope: normalizeNonEmptyString(item.source_scope || item.sourceScope) }
        : {}),
      ...(normalizeReviewModerationState(
        item.content_review_state || item.contentReviewState || item.moderation_status || item.moderationStatus,
      )
        ? {
            content_review_state: normalizeReviewModerationState(
              item.content_review_state || item.contentReviewState || item.moderation_status || item.moderationStatus,
            ),
          }
        : {}),
      ...(typeof item.public_visible === 'boolean' ? { public_visible: item.public_visible } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeReviewPreviewItems(items, limit = 6) {
  const safeItems = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const [index, item] of safeItems.entries()) {
    if (!item || typeof item !== 'object') continue;
    const reviewId = normalizeNonEmptyString(item.review_id || item.id || `review_${index + 1}`);
    const textSnippet = normalizeNonEmptyString(
      item.text_snippet || item.textSnippet || item.text || item.body,
    );
    const title = normalizeNonEmptyString(item.title || item.headline);
    const media = normalizeReviewMediaItems(item.media || item.images, 4);
    if (!reviewId || (!textSnippet && !title && media.length === 0)) continue;
    const key = reviewId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const normalized = {
      review_id: reviewId,
      ...(Number.isFinite(Number(item.rating || item.score))
        ? { rating: normalizeAmount(item.rating || item.score) }
        : {}),
      ...(normalizeNonEmptyString(item.author_label || item.authorLabel || item.author || item.user)
        ? { author_label: normalizeNonEmptyString(item.author_label || item.authorLabel || item.author || item.user) }
        : {}),
      ...(title ? { title } : {}),
      ...(textSnippet ? { text_snippet: textSnippet } : {}),
      ...(media.length ? { media } : {}),
      ...(normalizeNonEmptyString(item.source) ? { source: normalizeNonEmptyString(item.source) } : {}),
      ...(normalizeNonEmptyString(item.source_kind || item.sourceKind)
        ? { source_kind: normalizeNonEmptyString(item.source_kind || item.sourceKind) }
        : {}),
      ...(normalizeNonEmptyString(item.source_scope || item.sourceScope)
        ? { source_scope: normalizeNonEmptyString(item.source_scope || item.sourceScope) }
        : {}),
      ...(normalizeReviewModerationState(
        item.content_review_state ||
          item.contentReviewState ||
          item.moderation_status ||
          item.moderationStatus ||
          item.approval_status ||
          item.approvalStatus,
      )
        ? {
            content_review_state: normalizeReviewModerationState(
              item.content_review_state ||
                item.contentReviewState ||
                item.moderation_status ||
                item.moderationStatus ||
                item.approval_status ||
                item.approvalStatus,
            ),
          }
        : {}),
      ...(typeof item.public_visible === 'boolean' ? { public_visible: item.public_visible } : {}),
      ...(item.verified_buyer === true ? { verified_buyer: true } : {}),
    };
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeReviewSummaryQuestions(items, limit = 12) {
  const safeItems = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const item of safeItems) {
    if (!item || typeof item !== 'object') continue;
    const question = normalizeNonEmptyString(item.question || item.title);
    const answer = normalizeNonEmptyString(item.answer || item.body);
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      question,
      ...(answer ? { answer } : {}),
      ...(normalizeNonEmptyString(item.source) ? { source: normalizeNonEmptyString(item.source) } : {}),
      ...(normalizeNonEmptyString(item.source_label || item.sourceLabel)
        ? { source_label: normalizeNonEmptyString(item.source_label || item.sourceLabel) }
        : {}),
      ...(item.support_count != null ? { support_count: normalizeAmount(item.support_count) } : {}),
      ...(item.replies != null ? { replies: normalizeAmount(item.replies) } : {}),
      ...(normalizeReviewModerationState(
        item.content_review_state ||
          item.contentReviewState ||
          item.moderation_status ||
          item.moderationStatus ||
          item.approval_status ||
          item.approvalStatus,
      )
        ? {
            content_review_state: normalizeReviewModerationState(
              item.content_review_state ||
                item.contentReviewState ||
                item.moderation_status ||
                item.moderationStatus ||
                item.approval_status ||
                item.approvalStatus,
            ),
          }
        : {}),
      ...(typeof item.public_visible === 'boolean' ? { public_visible: item.public_visible } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeReviewDistributionRows(value) {
  const rows = Array.isArray(value) ? value : [];
  const out = [];
  for (const row of rows) {
    const stars = normalizeAmount(row?.stars || row?.star || row?.rating || row?.score);
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) continue;
    const count = row?.count != null ? normalizeAmount(row.count) : undefined;
    const percent = row?.percent != null ? Number(row.percent) : row?.ratio != null ? Number(row.ratio) : undefined;
    out.push({
      stars,
      ...(Number.isFinite(count) && count >= 0 ? { count } : {}),
      ...(Number.isFinite(percent) ? { percent } : {}),
    });
  }
  return out;
}

function normalizeReviewBrandCard(value) {
  const source = ensureJsonObject(value);
  const name = normalizeNonEmptyString(source.name);
  const subtitle = normalizeNonEmptyString(source.subtitle);
  if (!name && !subtitle) return null;
  return {
    ...(name ? { name } : {}),
    ...(subtitle ? { subtitle } : {}),
  };
}

function normalizeSeedReviewSummary(...values) {
  const out = {};
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
    const scale = normalizeAmount(source.scale ?? source.rating_scale);
    const previewItems = normalizeReviewPreviewItems(source.preview_items || source.snippets);
    const questions = normalizeReviewSummaryQuestions(source.questions);
    const brandCard = normalizeReviewBrandCard(source.brand_card);
    const starDistribution = normalizeReviewDistributionRows(
      source.star_distribution || source.rating_distribution,
    );

    if (rating > 0 && out.rating == null) out.rating = rating;
    if (reviewCount > 0 && out.review_count == null) out.review_count = reviewCount;
    if (scale > 0 && out.scale == null) out.scale = scale;
    if (previewItems.length > 0 && !Array.isArray(out.preview_items)) out.preview_items = previewItems;
    if (questions.length > 0 && !Array.isArray(out.questions)) out.questions = questions;
    if (brandCard && !out.brand_card) out.brand_card = brandCard;
    if (starDistribution.length > 0 && !Array.isArray(out.star_distribution)) {
      out.star_distribution = starDistribution;
      out.rating_distribution = starDistribution;
    }
    if (normalizeNonEmptyString(source.aggregation_scope) && !out.aggregation_scope) {
      out.aggregation_scope = normalizeNonEmptyString(source.aggregation_scope);
    }
    if (normalizeAmount(source.exact_item_review_count) > 0 && out.exact_item_review_count == null) {
      out.exact_item_review_count = normalizeAmount(source.exact_item_review_count);
    }
    if (normalizeAmount(source.product_line_review_count) > 0 && out.product_line_review_count == null) {
      out.product_line_review_count = normalizeAmount(source.product_line_review_count);
    }
    if (normalizeNonEmptyString(source.scope_label) && !out.scope_label) {
      out.scope_label = normalizeNonEmptyString(source.scope_label);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
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

function inferPrimaryMakeupFormFactor(text) {
  const primarySurfaceText = String(text || '').trim();
  if (!primarySurfaceText) return '';
  for (const [label, pattern] of MAKEUP_FORM_FACTOR_PATTERNS) {
    if (pattern.test(primarySurfaceText)) return label;
  }
  return '';
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
  const primaryMakeupFormFactor = inferPrimaryMakeupFormFactor(primarySurfaceText);
  const descriptionText = String(description || '').trim();
  if (explicit) {
    if (explicit === 'Sunscreen' && primaryMakeupFormFactor) return primaryMakeupFormFactor;
    if (explicit === 'Fragrance' && SUNSCREEN_CATEGORY_RE.test(primarySurfaceText)) return 'Sunscreen';
    if (
      explicit === 'Cleanser' &&
      !/\b(cleanser|cleansing|face wash|facial wash|wash|makeup remover|oil cleanser|cleansing oil)\b/i.test(primarySurfaceText) &&
      /\b(serum|ampoule|essence|before using your moisturizer|layered well with other skincare|breakout-prone skin)\b/i.test(
        descriptionText,
      )
    ) {
      return 'Serum';
    }
    return explicit;
  }
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

  if (primaryMakeupFormFactor) return primaryMakeupFormFactor;

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
    if (!url || isNonProductSeedImageUrl(url)) return;
    const dedupeKey = buildPdpImageDedupeKey(url) || url.toLowerCase();
    const alreadySeen = out.some((existing) => {
      const existingKey = buildPdpImageDedupeKey(existing) || String(existing || '').toLowerCase();
      return existingKey === dedupeKey;
    });
    if (alreadySeen) return;
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

function normalizeCatalogImageCacheVisibleUrl(value) {
  const normalized = normalizePdpImageUrl(value);
  if (!normalized) return '';
  return buildCatalogImageCacheVisibleUrl({ cachedUrl: normalized }) || normalized;
}

function normalizeCatalogImageCacheVisibleUrls(values) {
  if (!Array.isArray(values)) return normalizeCatalogImageCacheVisibleUrl(values);
  return values.map((value) => normalizeCatalogImageCacheVisibleUrl(value)).filter(Boolean);
}

function collectCachedSeedImageUrls(seedData) {
  const parsedSeedData = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsedSeedData.snapshot);
  const out = [];
  const appendCacheContract = (contract) => {
    const normalized = ensureJsonObject(contract);
    appendImageUrls(out, normalizeCatalogImageCacheVisibleUrls(normalized.visible_image_urls));
    if (Array.isArray(normalized.assets)) {
      normalized.assets.forEach((asset) => {
        appendImageUrls(out, normalizeCatalogImageCacheVisibleUrl(asset?.visible_url || asset?.cached_url));
      });
    }
  };
  appendCacheContract(parsedSeedData.image_asset_cache_v1);
  appendCacheContract(snapshot.image_asset_cache_v1);
  return out;
}

function collectSeedImageCacheAssetEntries(seedData) {
  const parsedSeedData = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsedSeedData.snapshot);
  const out = [];
  const appendCacheContract = (contract) => {
    const normalized = ensureJsonObject(contract);
    if (!Array.isArray(normalized.assets)) return;
    normalized.assets.forEach((asset) => {
      const originalUrl = normalizePdpImageUrl(asset?.original_url || asset?.source_url);
      const cachedUrl = normalizeCatalogImageCacheVisibleUrl(asset?.visible_url || asset?.cached_url);
      if (!originalUrl || !cachedUrl) return;
      out.push({ original_url: originalUrl, cached_url: cachedUrl });
    });
  };
  appendCacheContract(parsedSeedData.image_asset_cache_v1);
  appendCacheContract(snapshot.image_asset_cache_v1);
  return out;
}

function buildSeedImageCacheUrlMap(seedData) {
  const out = new Map();
  collectSeedImageCacheAssetEntries(seedData).forEach((asset) => {
    const originalUrl = normalizePdpImageUrl(asset.original_url);
    const cachedUrl = normalizePdpImageUrl(asset.cached_url);
    if (!originalUrl || !cachedUrl) return;
    const keys = [
      buildPdpImageDedupeKey(originalUrl),
      originalUrl,
      originalUrl.toLowerCase(),
    ].filter(Boolean);
    keys.forEach((key) => {
      if (!out.has(key)) out.set(key, cachedUrl);
    });
  });
  return out;
}

function rewriteSeedImageUrlsThroughCache(urls, cacheUrlMap) {
  if (!Array.isArray(urls) || urls.length === 0 || !(cacheUrlMap instanceof Map) || cacheUrlMap.size === 0) {
    return Array.isArray(urls) ? urls : [];
  }
  const out = [];
  urls.forEach((url) => {
    const normalized = normalizePdpImageUrl(url);
    if (!normalized) return;
    const cachedUrl =
      cacheUrlMap.get(buildPdpImageDedupeKey(normalized)) ||
      cacheUrlMap.get(normalized) ||
      cacheUrlMap.get(normalized.toLowerCase()) ||
      normalized;
    appendImageUrls(out, cachedUrl);
  });
  return out;
}

function classifySeedGalleryAsset(url) {
  const normalized = normalizePdpImageUrl(url);
  if (!normalized) return '';
  try {
    return classifyShopifyLikeAsset(new URL(normalized));
  } catch {
    return '';
  }
}

function filterMixedShopifyContentFromGallery(urls) {
  const normalizedUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (normalizedUrls.length < 2) return normalizedUrls;
  const assetKinds = normalizedUrls.map((url) => classifySeedGalleryAsset(url));
  const hasProductAssets = assetKinds.includes('product');
  const hasContentAssets = assetKinds.includes('content');
  if (!hasProductAssets || !hasContentAssets) return normalizedUrls;
  const filtered = normalizedUrls.filter((url) => classifySeedGalleryAsset(url) !== 'content');
  return filtered.length > 0 ? filtered : normalizedUrls;
}

const SEED_IMAGE_RELEVANCE_PRODUCT_TYPE_ALIASES = {
  balm: 'balm',
  blush: 'blush',
  bronzer: 'bronzer',
  brush: 'brush',
  brushes: 'brush',
  cleanser: 'cleanser',
  concealer: 'concealer',
  cream: 'cream',
  essence: 'essence',
  eyeshadow: 'eyeshadow',
  foundation: 'foundation',
  gloss: 'gloss',
  highlighter: 'highlighter',
  lipstick: 'lipstick',
  lotion: 'lotion',
  lotions: 'lotion',
  mascara: 'mascara',
  mask: 'mask',
  mist: 'mist',
  mists: 'mist',
  moisturizer: 'moisturizer',
  powder: 'powder',
  powders: 'powder',
  primer: 'primer',
  primers: 'primer',
  serum: 'serum',
  spray: 'mist',
  sprays: 'mist',
  stick: 'stick',
  toner: 'toner',
  wash: 'wash',
};

const SEED_IMAGE_RELEVANCE_NOISE_TOKENS = new Set([
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
  'alt',
  'beauty',
  'closed',
  'ecomm',
  'file',
  'files',
  'hero',
  'image',
  'images',
  'img',
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
]);

const SEED_IMAGE_RELEVANCE_FAMILY_STOP_TOKENS = new Set([
  ...SEED_IMAGE_RELEVANCE_NOISE_TOKENS,
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
  'find',
  'for',
  'full',
  'hair',
  'http',
  'https',
  'new',
  'of',
  'openlid',
  'online',
  'only',
  'optimist',
  'or',
  'primary',
  'pump',
  'regular',
  'secondary',
  'set',
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
const EXPLICIT_SIBLING_GALLERY_TOKENS = new Set(['mini', 'refill', 'travel', 'jumbo', 'huez']);
const EXPLICIT_SIBLING_GALLERY_GROUPS = [['mini', 'travel']];

function extractExplicitSiblingGalleryTokensFromText(value) {
  const text = normalizeNonEmptyString(value).toLowerCase();
  if (!text) return [];
  const out = [];
  for (const token of EXPLICIT_SIBLING_GALLERY_TOKENS) {
    const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`, 'i');
    if (re.test(text)) out.push(token);
  }
  return out;
}

function extractExplicitSiblingGalleryTokens(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    for (const token of extractExplicitSiblingGalleryTokensFromText(value)) {
      if (!out.includes(token)) out.push(token);
    }
  }
  for (const group of EXPLICIT_SIBLING_GALLERY_GROUPS) {
    if (!group.some((token) => out.includes(token))) continue;
    for (const token of group) {
      if (!out.includes(token)) out.push(token);
    }
  }
  return out;
}

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

function tokenizeSeedImageRelevanceValue(value) {
  return normalizeNonEmptyString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !SEED_IMAGE_RELEVANCE_NOISE_TOKENS.has(token));
}

function extractSeedImageRelevanceUrlText(value) {
  const normalized = normalizePdpImageUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return decodeURIComponent(parsed.pathname || '')
      .replace(/\/+/g, ' ')
      .trim();
  } catch {
    return normalizeNonEmptyString(normalized);
  }
}

function extractSeedImageFilenameTokens(value) {
  const normalized = normalizePdpImageUrl(value);
  if (!normalized) return [];
  try {
    const parsed = new URL(normalized);
    const filename = decodeURIComponent(parsed.pathname.split('/').pop() || '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
      .trim();
    return tokenizeSeedImageRelevanceValue(filename);
  } catch {
    return tokenizeSeedImageRelevanceValue(normalized);
  }
}

function extractSeedImageFilenameText(value) {
  const normalized = normalizePdpImageUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return decodeURIComponent(parsed.pathname.split('/').pop() || '')
      .replace(/\.[a-z0-9]+$/i, '')
      .trim()
      .toLowerCase();
  } catch {
    return normalizeNonEmptyString(normalized).toLowerCase();
  }
}

function extractSeedImageCanonicalProductTypes(tokens) {
  const out = [];
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const canonical = SEED_IMAGE_RELEVANCE_PRODUCT_TYPE_ALIASES[token];
    if (!canonical || out.includes(canonical)) continue;
    out.push(canonical);
  }
  return out;
}

function extractSeedImageFamilyTokens(tokens, productTypes = []) {
  const out = [];
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!token || token.length < 4) continue;
    if (!/[a-z]/i.test(token) || /^\d+x\d+$/i.test(token)) continue;
    if (SEED_IMAGE_RELEVANCE_FAMILY_STOP_TOKENS.has(token)) continue;
    const canonical = SEED_IMAGE_RELEVANCE_PRODUCT_TYPE_ALIASES[token];
    if (canonical && productTypes.includes(canonical)) continue;
    if (out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

function buildSeedGalleryRelevanceContext(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsedSeedData.snapshot);
  const values = [
    row?.title,
    extractSeedImageRelevanceUrlText(row?.canonical_url),
    extractSeedImageRelevanceUrlText(row?.destination_url),
    parsedSeedData.variant_title,
    snapshot.variant_title,
  ].filter(Boolean);
  const tokens = values.flatMap((value) => tokenizeSeedImageRelevanceValue(value));
  const productTypes = extractSeedImageCanonicalProductTypes(tokens);
  const explicitSiblingTokens = extractExplicitSiblingGalleryTokens(values);
  const productUrl = normalizeNonEmptyString(row?.canonical_url || row?.destination_url);
  let productHostname = '';
  try {
    productHostname = new URL(productUrl).hostname.toLowerCase();
  } catch {}
  return {
    productTypes,
    familyTokens: extractSeedImageFamilyTokens(tokens, productTypes),
    disallowedSiblingTokens: Array.from(EXPLICIT_SIBLING_GALLERY_TOKENS).filter(
      (token) => !explicitSiblingTokens.includes(token),
    ),
    strictFamilyFiltering: requiresStrictGalleryFamilyFiltering(productHostname),
    requireExplicitFamilyMatch: requiresExplicitGalleryFamilyMatch(productHostname),
  };
}

function isContentLikeSeedImageUrl(value) {
  const filename = extractSeedImageFilenameText(value);
  if (!filename) return false;
  return (
    /(?:^|[-_ ])pdp[-_ ]usage(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])pdp[-_ ]details?[-_ ]image(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])imperfect[-_ ]circle(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])infographics?(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])ingredients?(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])overview(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])texture(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])application(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])comparison(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])consumer[-_ ]perception(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])(?:how[-_ ]to|directions?|routine|step)(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])scent[-_ ]?(?:profile|note|notes|vibe)(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])before[-_ ]after(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])badge(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])arm[-_ ]focus(?:[-_ ]|$)/i.test(filename) ||
    /(?:^|[-_ ])(?:allure|award|awards|seal)(?:[-_ ]|$)/i.test(filename)
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

function isRelevantSeedGalleryImageUrl(value, relevanceContext) {
  if (!relevanceContext) return true;
  if (isContentLikeSeedImageUrl(value)) return false;
  const imageTokens = extractSeedImageFilenameTokens(value);
  const explicitSiblingTokens = extractExplicitSiblingGalleryTokens([extractSeedImageFilenameText(value)]);
  if (
    Array.isArray(relevanceContext.disallowedSiblingTokens) &&
    relevanceContext.disallowedSiblingTokens.length > 0 &&
    explicitSiblingTokens.some((token) => relevanceContext.disallowedSiblingTokens.includes(token))
  ) {
    return false;
  }
  const imageProductTypes = extractSeedImageCanonicalProductTypes(imageTokens);
  if (relevanceContext.productTypes.length === 1 && imageProductTypes.length > 0) {
    if (!imageProductTypes.includes(relevanceContext.productTypes[0])) return false;
  }
  if (!relevanceContext.strictFamilyFiltering || !relevanceContext.familyTokens.length) return true;
  if (hasSeedImageFamilyOverlap(imageTokens, relevanceContext.familyTokens)) return true;
  const imageFamilyTokens = extractSeedImageFamilyTokens(imageTokens, relevanceContext.productTypes || []);
  if (imageFamilyTokens.length === 0) return !relevanceContext.requireExplicitFamilyMatch;
  return false;
}

function isRelevantSeedContentImageUrl(value, relevanceContext) {
  if (!relevanceContext || !relevanceContext.strictFamilyFiltering || !relevanceContext.familyTokens.length) return true;
  const imageTokens = extractSeedImageFilenameTokens(value);
  const explicitSiblingTokens = extractExplicitSiblingGalleryTokens([extractSeedImageFilenameText(value)]);
  if (
    Array.isArray(relevanceContext.disallowedSiblingTokens) &&
    relevanceContext.disallowedSiblingTokens.length > 0 &&
    explicitSiblingTokens.some((token) => relevanceContext.disallowedSiblingTokens.includes(token))
  ) {
    return false;
  }
  if (hasSeedImageFamilyOverlap(imageTokens, relevanceContext.familyTokens)) return true;
  const imageFamilyTokens = extractSeedImageFamilyTokens(imageTokens, relevanceContext.productTypes || []);
  const specificFamilyTokens = imageFamilyTokens.filter((token) => !CONTENT_IMAGE_GENERIC_FAMILY_TOKENS.has(token));
  if (specificFamilyTokens.length === 0) return !relevanceContext.requireExplicitFamilyMatch;
  return false;
}

function filterSeedGalleryByRelevance(urls, relevanceContext) {
  const normalizedUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!normalizedUrls.length) return normalizedUrls;
  const filtered = normalizedUrls.filter((url) => isRelevantSeedGalleryImageUrl(url, relevanceContext));
  return filtered.length > 0 ? filtered : normalizedUrls;
}

function extractSeparatedContentImageUrls(urls, relevanceContext = null) {
  const normalizedUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
  const out = [];
  const seen = new Set();
  for (const url of normalizedUrls) {
    const normalized = normalizePdpImageUrl(url);
    if (
      !normalized ||
      isNonProductSeedImageUrl(normalized) ||
      !isContentLikeSeedImageUrl(normalized) ||
      !isRelevantSeedContentImageUrl(normalized, relevanceContext)
    ) {
      continue;
    }
    const dedupeKey = buildPdpImageDedupeKey(normalized) || normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(normalized);
  }
  return out;
}

function decodeUrlPathnameForImageFilter(value) {
  try {
    return decodeURIComponent(new URL(value).pathname || '').toLowerCase();
  } catch {
    return String(value || '').toLowerCase();
  }
}

function isNonProductSeedImageUrl(value) {
  const normalized = normalizePdpImageUrl(value);
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  const pathname = decodeUrlPathnameForImageFilter(normalized);
  const filename = String(pathname.split('/').pop() || '').trim();
  let hostname = '';
  try {
    hostname = String(new URL(normalized).hostname || '').toLowerCase();
  } catch {}
  const explicitFamilyHost = requiresExplicitGalleryFamilyMatch(hostname);
  if (!filename) return true;
  if (
    lower.endsWith('.svg') ||
    lower.includes('.svg?') ||
    lower.includes('data:image') ||
    /\/(?:ivborw0kggo|r0lgodlh|base64)/i.test(pathname)
  ) {
    return true;
  }
  if (filename.length > 120 && !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(filename)) {
    return true;
  }
  if (
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
    pathname.includes('/menu.') ||
    /\/(?:cart|account|search)(?:[._/-]|$)/i.test(pathname) ||
    pathname.includes('/flyout') ||
    pathname.includes('/slot-a') ||
    pathname.includes('/slota/') ||
    pathname.includes('/heroes-slot') ||
    /(?:^|\/)gnav[-_]/i.test(pathname) ||
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
  ) {
    return true;
  }
  return false;
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
  ['weight', 'Size'],
  ['net weight', 'Size'],
  ['net wt', 'Size'],
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
  const hasVisualOrScentAxis = /\b(color|colour|shade|tone|hue|scent|fragrance|flavo[u]?r)\b/.test(normalized);
  return hasVisualOrScentAxis && /\b(size|volume|weight)\b/.test(normalized);
}

function inferCombinedVariantPrimaryLabel(name) {
  const normalized = normalizeOptionNameKey(name);
  if (/\b(scent|fragrance|flavo[u]?r)\b/.test(normalized)) return 'Scent';
  if (/\b(shade|tone|hue)\b/.test(normalized)) return 'Shade';
  return 'Color';
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
                { name: inferCombinedVariantPrimaryLabel(optionName), value: parsed.color },
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

function decodeVariantHintText(value) {
  const raw = normalizeOptionText(value);
  if (!raw) return '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded
    .replace(/https?:\/\//gi, ' ')
    .replace(/[/?#=&%]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\.(?:jpg|jpeg|png|webp|gif|avif|html?|js)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatVariantQuantityDisplayValue(amount, unit) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return '';
  const normalizedUnit = String(unit || '')
    .toLowerCase()
    .replace(/fluid\s*ounces?/g, 'fl oz')
    .replace(/fl\.?\s*oz\.?/g, 'fl oz')
    .replace(/m\s*l/g, 'ml')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim();
  if (!normalizedUnit) return '';
  const displayAmount = String(numericAmount).replace(/\.0+$/, '');
  if (normalizedUnit === 'fl oz') return `${displayAmount} fl oz`;
  if (['oz', 'lb', 'lbs'].includes(normalizedUnit)) return `${displayAmount} ${normalizedUnit}`;
  return `${displayAmount}${normalizedUnit.replace(/\s+/g, '')}`;
}

function extractVariantQuantityDisplayValue(value) {
  const decoded = decodeVariantHintText(value);
  if (!decoded) return '';
  const match = decoded.match(/\b(\d+(?:\.\d+)?)\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/i);
  if (!match) return '';
  return formatVariantQuantityDisplayValue(match[1], match[2]);
}

function collectInferredProductLevelVariantOptions(seedData, row) {
  const parsed = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsed.snapshot);
  const candidates = [
    row?.title,
    parsed.title,
    snapshot.title,
    row?.canonical_url,
    row?.destination_url,
    parsed.canonical_url,
    parsed.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
    row?.image_url,
    parsed.image_url,
    snapshot.image_url,
    ...(Array.isArray(parsed.image_urls) ? parsed.image_urls : []),
    ...(Array.isArray(snapshot.image_urls) ? snapshot.image_urls : []),
  ];
  for (const candidate of candidates) {
    const value = extractVariantQuantityDisplayValue(candidate);
    if (value) return [{ name: 'Size', value }];
  }
  return [];
}

function scoreProductLevelVariantOptionCandidate(option) {
  const value = normalizeOptionText(option?.value);
  if (!value) return -1;
  if (extractVariantQuantityDisplayValue(value)) {
    const compact = value.toLowerCase().replace(/\s+/g, '');
    if (/(?:ml|g|kg|mm|cm|l)\b/.test(value.toLowerCase()) || compact.endsWith('ml')) return 40;
    if (/(?:fl\s*oz|oz|lb|lbs)\b/.test(value.toLowerCase()) || compact.includes('floz')) return 30;
    return 20;
  }
  if (/\b(full size|travel size|jumbo|mini|refill|regular|standard|one size)\b/i.test(value)) return 10;
  return 0;
}

function pickPrimaryProductLevelVariantOption(candidates = []) {
  const normalized = normalizeOptionEntries(candidates).filter((option) => normalizeOptionText(option?.value));
  if (!normalized.length) return [];
  const ranked = normalized
    .map((option, index) => ({ option, index, score: scoreProductLevelVariantOptionCandidate(option) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    });
  return ranked[0]?.option ? [ranked[0].option] : [];
}

function shouldInferProductLevelVariantOptions(seedData, row) {
  const parsed = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsed.snapshot);
  const text = [
    row?.title,
    row?.canonical_url,
    row?.destination_url,
    row?.domain,
    parsed?.title,
    snapshot?.title,
    parsed?.brand,
    snapshot?.brand,
    parsed?.category,
    snapshot?.category,
    parsed?.product_type,
    snapshot?.product_type,
    parsed?.productType,
    snapshot?.productType,
  ]
    .map((value) => normalizeOptionText(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (!text) return false;
  return !/\b(e[-\s]?gift[-\s]?cards?|gift[-\s]?cards?|donat(?:e|ion)|sample service|appointment|booking|shipping protection|package protection|route protection|order protection|brush|sponge|puff|applicator|sharpener|tweezer|curler|scissors|comb|mirror|case|bag|pouch|holder|spatula|tool|tools|gua sha|roller|headband|scrunchie|scarf|hat|cap|tote|clip|clips|lash curler|refill case|bundle|set|kit|collection|duo|trio|routine|makeup look|mini set|travel set|starter set|value set|collection set|collection kit|collection bundle)\b/i.test(
    text,
  );
}

function collectProductLevelVariantOptions(seedData, row = null, options = {}) {
  const parsed = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsed.snapshot);
  const candidates = [
    ['Size', parsed.size],
    ['Size', snapshot.size],
    ['Size', parsed.product_size],
    ['Size', snapshot.product_size],
    ['Size', parsed.selected_size],
    ['Size', snapshot.selected_size],
    ['Size', parsed.volume],
    ['Size', snapshot.volume],
    ['Size', parsed.product_volume],
    ['Size', snapshot.product_volume],
    ['Size', parsed.capacity],
    ['Size', snapshot.capacity],
    ['Size', parsed.net_content],
    ['Size', snapshot.net_content],
    ['Size', parsed.net_size],
    ['Size', snapshot.net_size],
  ];
  if (options.includeInferredHints) {
    for (const item of collectInferredProductLevelVariantOptions(parsed, row)) {
      candidates.push([item.name, item.value]);
    }
  }
  return pickPrimaryProductLevelVariantOption(
    candidates
      .map(([name, value]) => ({ name, value }))
      .filter((item) => normalizeOptionText(item.value)),
  );
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

const NON_DISPLAYABLE_IDENTITY_OPTION_NAMES = new Set([
  'offer',
  'sku',
  'sku id',
  'variant sku',
  'barcode',
  'upc',
  'ean',
  'gtin',
  'product id',
  'variant id',
]);

const GENERIC_VARIANT_OPTION_NAMES = new Set([
  'option',
  'variant',
  'variants',
  'title',
  'selection',
  'choose a size',
  'choose size',
  'select size',
]);

const VARIANT_AXIS_LABELS = Object.freeze({
  shade: 'Shade',
  color: 'Color',
  size: 'Size',
  volume: 'Size',
  pack: 'Pack',
  format: 'Format',
  scent: 'Scent',
  strength: 'Strength',
});

const NON_DISPLAYABLE_VARIANT_VALUES = new Set([
  'default',
  'default title',
  'title',
  'variant',
]);

const LOCALE_LIKE_VARIANT_VALUES = new Set([
  'us',
  'usa',
  'uk',
  'eu',
  'fr',
  'de',
  'es',
  'it',
  'ca',
  'au',
  'jp',
  'kr',
  'cn',
]);

function isVariantIdentityValue(value, rawVariant) {
  const normalized = normalizeOptionText(value).toLowerCase();
  if (!normalized) return false;
  const compact = normalized.replace(/[\s-]+/g, '');
  if (/^\d{8,14}$/.test(compact)) return true;

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

  return /^[a-z]{0,4}\d{6,}[a-z0-9-]*$/i.test(normalized) && normalized.length >= 8 && !/\s/.test(normalized);
}

function isNonDisplayableVariantOption(option, rawVariant) {
  const optionName = normalizeOptionNameKey(option?.name);
  const optionValue = normalizeOptionText(option?.value);
  if (!optionName || !optionValue) return true;
  if (NON_DISPLAYABLE_VARIANT_VALUES.has(optionValue.toLowerCase())) return true;
  if (NON_DISPLAYABLE_IDENTITY_OPTION_NAMES.has(optionName)) {
    return isSkuLikeVariantText(optionValue, rawVariant) || isVariantIdentityValue(optionValue, rawVariant);
  }
  if (GENERIC_VARIANT_OPTION_NAMES.has(optionName)) {
    return isVariantIdentityValue(optionValue, rawVariant);
  }
  return false;
}

function filterDisplayableVariantOptions(options, rawVariant) {
  return (Array.isArray(options) ? options : []).filter(
    (option) => !isNonDisplayableVariantOption(option, rawVariant),
  );
}

function buildVariantContext(seedData, row) {
  const parsed = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsed.snapshot);
  const text = [
    row?.title,
    row?.canonical_url,
    row?.destination_url,
    row?.domain,
    parsed?.brand,
    snapshot?.brand,
    parsed?.category,
    snapshot?.category,
    parsed?.product_type,
    snapshot?.product_type,
    parsed?.productType,
    snapshot?.productType,
    ...(Array.isArray(parsed?.tags) ? parsed.tags : []),
    ...(Array.isArray(snapshot?.tags) ? snapshot.tags : []),
  ]
    .map((value) => normalizeOptionText(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
  const allowsShadeAxis =
    /\b(tinted?|skin tint|shade|color[-\s]?correct|tone[-\s]?up|tone[-\s]?correct|lip tint|tint balm|honey tint|lipstick|lip gloss|lip oil|lip balm|foundation|concealer|bronzer|blush|highlighter|powder|eyeshadow|eyeliner|brow|mascara|makeup|cosmetic)\b/i.test(
      text,
    );
  const skincareLike =
    /\b(serum|essence|ampoule|moisturi[sz]er|cream|cleanser|toner|lotion|balm|mask|treatment|sunscreen|spf|sun protection|skin care|skincare|barrier|retinol|niacinamide|vitamin c|acid)\b/i.test(
      text,
    );
  const lipSurfaceLike =
    /\b(lip|lips|gloss|lipstick|topper|tinted)\b/i.test(text);
  return {
    text,
    allowsShadeAxis,
    skincareLike,
    lipSurfaceLike,
  };
}

function parseVariantQuantityValue(value) {
  const normalized = normalizeOptionText(value);
  if (!normalized) return '';
  const match = normalized.match(/\b(\d+(?:\.\d+)?)\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/i);
  if (!match) return '';
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const unit = String(match[2] || '')
    .toLowerCase()
    .replace(/fluid\s*ounces?/g, 'fl oz')
    .replace(/fl\.?\s*oz\.?/g, 'fl oz')
    .replace(/\s+/g, '');
  return `${amount}${unit}`;
}

function formatSeedSizeDetailValue(value) {
  const normalized = normalizeOptionText(value);
  if (!normalized) return '';
  const match = normalized.match(/\b(\d+(?:\.\d+)?)\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/i);
  if (!match) return '';
  const amount = String(match[1] || '').trim();
  const normalizedUnit = String(match[2] || '')
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

function getSeedSizeDetailPriority(value) {
  const normalized = normalizeOptionText(value).toLowerCase();
  if (!normalized) return 99;
  if (/\b(?:fl\.?\s*oz|oz|lb|lbs)\b/.test(normalized)) return 1;
  if (/\b(?:ml|m l|g|kg|l|mm|cm)\b/.test(normalized)) return 2;
  return 3;
}

function buildSeedSizeDetailLabel(...values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const formatted = formatSeedSizeDetailValue(value);
    if (!formatted) continue;
    const key = formatted.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(formatted);
  }
  if (!unique.length) return '';
  unique.sort((left, right) => getSeedSizeDetailPriority(left) - getSeedSizeDetailPriority(right));
  return unique.slice(0, 2).join(' / ');
}

function parseVariantPackValue(value) {
  const normalized = normalizeOptionText(value);
  if (!normalized) return '';
  if (/^\s*single\s*$/i.test(normalized)) return '1pack';
  const additive = normalized.match(/\b(\d+)\s*\+\s*(\d+)\s*(masks?|pads?|sheets?|sachets?|pcs|pieces|ct|count|units?)\b/i);
  if (additive) return `${(Number(additive[1]) || 0) + (Number(additive[2]) || 0)}pack`;
  const explicit = normalized.match(/\b(pack of|set of)\s*(\d+)\b/i);
  if (explicit) return `${Number(explicit[2]) || 0}pack`;
  const short = normalized.match(/\b(\d+)\s*-?\s*(pack|ct|count|pcs|pieces|masks?|pads?|sheets?|sachets?|units?)\b/i);
  if (short) return `${Number(short[1]) || 0}pack`;
  if (/\bduo\b/i.test(normalized)) return '2pack';
  if (/\btrio\b/i.test(normalized)) return '3pack';
  return '';
}

function parseVariantFormatValue(value) {
  const normalized = normalizeOptionText(value);
  if (!normalized) return '';
  if (/\brefill\b/i.test(normalized)) return 'Refill';
  if (/\btravel size\b/i.test(normalized)) return 'Travel Size';
  if (/\bfull size\b/i.test(normalized)) return 'Full Size';
  if (/\bmini\b/i.test(normalized)) return 'Mini';
  if (/\bjumbo\b/i.test(normalized)) return 'Jumbo';
  if (/\bregular\b/i.test(normalized)) return 'Regular';
  return '';
}

function parseVariantStrengthValue(value) {
  const normalized = normalizeOptionText(value);
  if (!normalized) return '';
  const percent = normalized.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (percent) return `${percent[1]}%`;
  const spf = normalized.match(/\bspf\s*(\d{1,3})\b/i);
  if (spf) return `SPF ${spf[1]}`;
  return '';
}

function inferVariantAxisKind(option, context = {}) {
  const optionName = normalizeOptionNameKey(option?.name);
  const optionValue = normalizeOptionText(option?.value);
  if (!optionValue || NON_DISPLAYABLE_VARIANT_VALUES.has(optionValue.toLowerCase())) {
    return { axis_kind: 'non_displayable', display_label: '', normalized_value: '' };
  }

  const volume = parseVariantQuantityValue(optionValue);
  const pack = parseVariantPackValue(optionValue);
  const format = parseVariantFormatValue(optionValue);
  const strength = parseVariantStrengthValue(optionValue);
  const localeLike = LOCALE_LIKE_VARIANT_VALUES.has(optionValue.toLowerCase());

  if (['shade', 'tone', 'hue'].includes(optionName)) {
    if (!context.allowsShadeAxis) {
      if (volume) return { axis_kind: 'volume', display_label: VARIANT_AXIS_LABELS.volume, normalized_value: optionValue };
      if (format) return { axis_kind: 'format', display_label: VARIANT_AXIS_LABELS.format, normalized_value: format };
      if (localeLike) return { axis_kind: 'non_displayable', display_label: '', normalized_value: '' };
      return { axis_kind: 'non_displayable', display_label: '', normalized_value: '' };
    }
    return { axis_kind: 'shade', display_label: VARIANT_AXIS_LABELS.shade, normalized_value: optionValue };
  }
  if (['color', 'colour'].includes(optionName)) {
    if (!context.allowsShadeAxis || localeLike) {
      if (volume) return { axis_kind: 'volume', display_label: VARIANT_AXIS_LABELS.volume, normalized_value: optionValue };
      if (format) return { axis_kind: 'format', display_label: VARIANT_AXIS_LABELS.format, normalized_value: format };
      if (localeLike || (context.skincareLike && !context.lipSurfaceLike)) {
        return { axis_kind: 'non_displayable', display_label: '', normalized_value: '' };
      }
    }
    return { axis_kind: 'color', display_label: VARIANT_AXIS_LABELS.color, normalized_value: optionValue };
  }
  if (optionName === 'size') {
    return { axis_kind: volume ? 'volume' : 'size', display_label: volume ? VARIANT_AXIS_LABELS.volume : VARIANT_AXIS_LABELS.size, normalized_value: optionValue };
  }
  if (['volume', 'voume', 'capacity', 'amount', 'weight', 'net weight', 'net wt', 'ml', 'm l'].includes(optionName)) {
    return { axis_kind: 'volume', display_label: VARIANT_AXIS_LABELS.volume, normalized_value: optionValue };
  }
  if (['pack', 'count', 'quantity', 'ct', 'ct.', 'sachet', 'unit', 'unité'].includes(optionName) || pack) {
    return { axis_kind: 'pack', display_label: VARIANT_AXIS_LABELS.pack, normalized_value: optionValue };
  }
  if (['format', 'type', 'benefit'].includes(optionName) || format) {
    return { axis_kind: 'format', display_label: VARIANT_AXIS_LABELS.format, normalized_value: format || optionValue };
  }
  if (['strength', 'concentration'].includes(optionName) || strength) {
    return { axis_kind: 'strength', display_label: VARIANT_AXIS_LABELS.strength, normalized_value: strength || optionValue };
  }
  if (['scent', 'fragrance', 'flavor', 'flavour'].includes(optionName)) {
    return { axis_kind: 'scent', display_label: VARIANT_AXIS_LABELS.scent, normalized_value: optionValue };
  }
  if (GENERIC_VARIANT_OPTION_NAMES.has(optionName)) {
    if (volume) return { axis_kind: 'volume', display_label: VARIANT_AXIS_LABELS.volume, normalized_value: optionValue };
    if (pack) return { axis_kind: 'pack', display_label: VARIANT_AXIS_LABELS.pack, normalized_value: optionValue };
    if (format) return { axis_kind: 'format', display_label: VARIANT_AXIS_LABELS.format, normalized_value: format };
    if (strength) return { axis_kind: 'strength', display_label: VARIANT_AXIS_LABELS.strength, normalized_value: strength };
    if (context.allowsShadeAxis) {
      return { axis_kind: 'shade', display_label: VARIANT_AXIS_LABELS.shade, normalized_value: optionValue };
    }
    return { axis_kind: 'non_displayable', display_label: '', normalized_value: '' };
  }
  return { axis_kind: 'non_displayable', display_label: '', normalized_value: '' };
}

function rewriteSeedImageUrlThroughCache(url, cacheUrlMap) {
  const rewritten = rewriteSeedImageUrlsThroughCache([url], cacheUrlMap);
  return rewritten[0] || normalizePdpImageUrl(url) || '';
}

function normalizeVariantVisualFields(rawVariant, fallbackImageUrl, cacheUrlMap) {
  const rawSwatchImageUrl = normalizeHttpUrl(
    rawVariant?.swatch_image_url ||
      rawVariant?.label_image_url ||
      rawVariant?.thumbnail_url ||
      rawVariant?.thumbnail ||
      rawVariant?.swatch?.image_url ||
      rawVariant?.swatch?.imageUrl ||
      rawVariant?.swatch?.url,
  );
  const rawImageUrl = normalizeHttpUrl(rawVariant?.image_url || rawVariant?.image) || fallbackImageUrl || '';
  const swatchImageUrl = rewriteSeedImageUrlThroughCache(rawSwatchImageUrl, cacheUrlMap);
  const imageUrl = rewriteSeedImageUrlThroughCache(rawImageUrl, cacheUrlMap);
  const swatchHex = firstNonEmptyString(
    rawVariant?.color_hex,
    rawVariant?.swatch?.hex,
    rawVariant?.beauty_meta?.shade_hex,
    rawVariant?.shade_hex,
    rawVariant?.hex,
  );
  return {
    image_url: imageUrl,
    swatch_image_url: swatchImageUrl || '',
    swatch_hex: swatchHex || '',
  };
}

function applySeedVariantDisplayContract({ options, rawVariant, context, imageUrl, imageCacheUrlMap }) {
  const visual = normalizeVariantVisualFields(rawVariant, imageUrl, imageCacheUrlMap);
  const normalizedOptions = [];
  const seen = new Set();
  for (const option of Array.isArray(options) ? options : []) {
    const normalizedValue = normalizeOptionText(option?.value);
    if (!normalizedValue) continue;
    const contract = inferVariantAxisKind(option, context);
    if (contract.axis_kind === 'non_displayable') continue;
    const needsVisual = ['shade', 'color'].includes(contract.axis_kind);
    const hasVisual = Boolean(visual.swatch_image_url || visual.swatch_hex || visual.image_url);
    if (needsVisual && !hasVisual) continue;
    const key = `${contract.axis_kind}|${normalizedValue.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedOptions.push({
      name: contract.display_label || option.name,
      value: contract.normalized_value || normalizedValue,
      axis_kind: contract.axis_kind,
    });
  }
  return {
    options: normalizedOptions,
    axis_kind: normalizedOptions.length === 1 ? normalizedOptions[0].axis_kind : undefined,
    display_label:
      normalizedOptions.length === 1 ? `${normalizedOptions[0].name}: ${normalizedOptions[0].value}` : undefined,
    visual: {
      image_url: visual.image_url || undefined,
      swatch_image_url: visual.swatch_image_url || undefined,
      swatch_hex: visual.swatch_hex || undefined,
      source: visual.swatch_image_url ? 'swatch_image' : visual.swatch_hex ? 'swatch_hex' : visual.image_url ? 'variant_image' : undefined,
    },
    source_quality_status:
      normalizedOptions.some((item) => ['shade', 'color'].includes(item.axis_kind))
        ? visual.swatch_image_url || visual.image_url
          ? 'captured'
          : visual.swatch_hex
            ? 'inferred'
            : 'blocked'
        : normalizedOptions.length
          ? 'captured'
          : 'blocked',
  };
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
  appendImageUrls(out, collectCachedSeedImageUrls(parsedSeedData));
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
  const relevanceContext = buildSeedGalleryRelevanceContext(seedData, row);
  const out = filterSeedGalleryByRelevance(
    filterMixedShopifyContentFromGallery(collectSeedImageUrls(seedData, row)),
    relevanceContext,
  );
  if (out.length > 0) return out;

  const override = resolveSeedImageOverride(seedData, row);
  if (!override) return out;

  appendImageUrls(out, override.image_urls);
  appendImageUrls(out, override.image_url);
  return filterSeedGalleryByRelevance(filterMixedShopifyContentFromGallery(out), relevanceContext);
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

function normalizeOptions(rawVariant, optionName, optionValue, productOptionNames = [], fallbackOptions = []) {
  const urlOptions = collectVariantOptionsFromRawVariantUrl(rawVariant);
  const shouldUseFallbackOptions = (options) =>
    fallbackOptions.length > 0 &&
    Array.isArray(options) &&
    options.length === 1 &&
    GENERIC_VARIANT_OPTION_NAMES.has(normalizeOptionNameKey(options[0]?.name)) &&
    ['single', 'default', 'default title', 'title', 'variant'].includes(
      normalizeOptionText(options[0]?.value).toLowerCase(),
    );
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
        if (shouldUseFallbackOptions(normalized)) return fallbackOptions;
        if (shouldPreferUrlVariantOptions(normalized, urlOptions, rawVariant)) return urlOptions;
        const displayable = filterDisplayableVariantOptions(normalized, rawVariant);
        if (displayable.length > 0) return displayable;
      }
    }

    if (source && typeof source === 'object') {
      const normalized = normalizeOptionEntries(
        Object.entries(source).map(([name, value]) => ({ name, value })),
      );
      if (normalized.length > 0) {
        if (shouldUseFallbackOptions(normalized)) return fallbackOptions;
        if (shouldPreferUrlVariantOptions(normalized, urlOptions, rawVariant)) return urlOptions;
        const displayable = filterDisplayableVariantOptions(normalized, rawVariant);
        if (displayable.length > 0) return displayable;
      }
    }
  }

  if (Array.isArray(rawVariant?.options)) {
    const normalized = normalizeOptionEntries(rawVariant.options);
    if (normalized.length > 0) {
      if (shouldUseFallbackOptions(normalized)) return fallbackOptions;
      if (shouldPreferUrlVariantOptions(normalized, urlOptions, rawVariant)) return urlOptions;
      const displayable = filterDisplayableVariantOptions(normalized, rawVariant);
      if (displayable.length > 0) return displayable;
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
  if (tupleOptions.length > 0) {
    if (shouldUseFallbackOptions(tupleOptions)) return fallbackOptions;
    const displayable = filterDisplayableVariantOptions(tupleOptions, rawVariant);
    if (displayable.length > 0) return displayable;
  }

  if (optionName || optionValue) {
    const direct = normalizeOptionEntries([
      { name: optionName || 'Variant', value: optionValue || 'Default' },
    ]);
    if (direct.length > 0) {
      if (shouldUseFallbackOptions(direct)) return fallbackOptions;
      if (shouldPreferUrlVariantOptions(direct, urlOptions, rawVariant)) return urlOptions;
      const displayable = filterDisplayableVariantOptions(direct, rawVariant);
      if (displayable.length > 0) return displayable;
    }
  }

  if (urlOptions.length > 0) return urlOptions;

  const fallbackDisplayable = filterDisplayableVariantOptions(fallbackOptions, rawVariant);
  return fallbackDisplayable.length > 0 ? fallbackDisplayable : [];
}

function sanitizeSeedVariantDisplayFields(rawVariant, productOptionNames = [], fallbackOptions = []) {
  const optionName = String(rawVariant?.option_name || '').trim();
  const optionValue = String(rawVariant?.option_value || '').trim();
  const sku = String(
    rawVariant?.sku || rawVariant?.sku_id || rawVariant?.variant_sku || rawVariant?.variant_id || rawVariant?.id || '',
  ).trim();
  const options = normalizeOptions(rawVariant, optionName, optionValue, productOptionNames, fallbackOptions);
  const rawTitle = String(rawVariant?.title || rawVariant?.name || optionValue || sku || '').trim();
  const inferredTitle = options.map((option) => option.value).filter(Boolean).join(' / ');
  const rawTitleIsSkuLike = rawTitle && isSkuLikeVariantText(rawTitle, rawVariant);
  const title =
    (rawTitle && !rawTitleIsSkuLike ? rawTitle : inferredTitle) ||
    (rawTitleIsSkuLike ? 'Default' : rawTitle) ||
    'Default';
  const directOptionDisplayable =
    optionName &&
    optionValue &&
    !isNonDisplayableVariantOption({ name: optionName, value: optionValue }, rawVariant);

  return {
    title,
    options,
    option_name: directOptionDisplayable ? optionName : undefined,
    option_value: directOptionDisplayable ? optionValue : undefined,
  };
}

function normalizeSeedVariants(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const rawVariants = getRawSeedVariants(parsedSeedData);
  const productOptionNames = getSeedProductOptionNames(parsedSeedData);
  const productLevelOptions = collectProductLevelVariantOptions(parsedSeedData, row, {
    includeInferredHints: rawVariants.length === 1 && shouldInferProductLevelVariantOptions(parsedSeedData, row),
  });
  const variantContext = buildVariantContext(parsedSeedData, row);

  if (!rawVariants.length) return [];

  const productImageUrls = normalizeSeedImageUrls(parsedSeedData, row);
  const imageCacheUrlMap = buildSeedImageCacheUrlMap(parsedSeedData);
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
      const cachedImageUrls = rewriteSeedImageUrlsThroughCache(imageUrls, imageCacheUrlMap);
      const narrowedImageUrls = narrowVariantImageUrls(cachedImageUrls, rawVariant);
      const normalizedImageUrls = narrowedImageUrls.length > 0 ? narrowedImageUrls : productImageUrls;
      const imageUrl = normalizedImageUrls[0];
      const displayFields = sanitizeSeedVariantDisplayFields(rawVariant, productOptionNames, productLevelOptions);
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
      const contractedDisplay = applySeedVariantDisplayContract({
        options: displayFields.options,
        rawVariant,
        context: variantContext,
        imageUrl,
        imageCacheUrlMap,
      });
      const contractedTitle =
        contractedDisplay.options.map((option) => option.value).filter(Boolean).join(' / ') ||
        (contractedDisplay.source_quality_status !== 'blocked' &&
        displayFields.title &&
        !NON_DISPLAYABLE_VARIANT_VALUES.has(displayFields.title.toLowerCase())
          ? displayFields.title
          : 'Default');

      return {
        id: variantId,
        variant_id: variantId,
        sku_id: sku || variantId,
        sku: sku || variantId,
        title: contractedTitle || `Variant ${idx + 1}`,
        options: contractedDisplay.options,
        price,
        currency,
        pricing: { current: { amount: price, currency } },
        inventory_quantity: availableQuantity ?? (inStock === true ? 999 : inStock === false ? 0 : null),
        in_stock: inStock,
        available: typeof inStock === 'boolean' ? inStock : undefined,
        availability: availability || undefined,
        option_name: contractedDisplay.options.length === 1 ? contractedDisplay.options[0].name : undefined,
        option_value: contractedDisplay.options.length === 1 ? contractedDisplay.options[0].value : undefined,
        description: description || undefined,
        image_url: imageUrl || undefined,
        images: normalizedImageUrls,
        image_urls: normalizedImageUrls,
        ...(contractedDisplay.axis_kind ? { axis_kind: contractedDisplay.axis_kind } : {}),
        ...(contractedDisplay.display_label ? { display_label: contractedDisplay.display_label } : {}),
        ...(contractedDisplay.visual?.swatch_image_url
          ? { label_image_url: contractedDisplay.visual.swatch_image_url }
          : contractedDisplay.visual?.image_url
            ? { label_image_url: contractedDisplay.visual.image_url }
            : {}),
        ...(contractedDisplay.visual?.swatch_image_url ? { swatch_image_url: contractedDisplay.visual.swatch_image_url } : {}),
        ...(contractedDisplay.visual ? { visual: contractedDisplay.visual } : {}),
        ...(contractedDisplay.source_quality_status ? { source_quality_status: contractedDisplay.source_quality_status } : {}),
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
    nextSeedData.variants = cloneJsonValue(canonicalVariants);
    snapshot.variants = cloneJsonValue(canonicalVariants);
    if (nextSeedData.product && typeof nextSeedData.product === 'object' && Array.isArray(nextSeedData.product.variants)) {
      nextSeedData.product = {
        ...nextSeedData.product,
        variants: cloneJsonValue(canonicalVariants),
      };
    }
    if (snapshot.product && typeof snapshot.product === 'object' && Array.isArray(snapshot.product.variants)) {
      snapshot.product = {
        ...snapshot.product,
        variants: cloneJsonValue(canonicalVariants),
      };
    }
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
  const commerceFacts = readCommerceFactsV1({ ...row, seed_data: seedData });
  const agentSafeCommerceFacts = commerceFacts ? buildAgentSafeCommerceFacts(commerceFacts) : null;
  const localityFacts = resolveExternalSeedLocalityFacts({ row, seedData, snapshot });
  const shouldExposeLocalityFacts = hasLocalityFactsValue(localityFacts);
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
  const pdpFieldQualitySummary = normalizePdpFieldQualitySummary(
    seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary,
  );
  const runtimeSeedData = buildApprovedRuntimeSeedData(seedData, pdpFieldQualitySummary);
  const runtimeSnapshot = ensureJsonObject(runtimeSeedData.snapshot);
  const galleryRelevanceContext = buildSeedGalleryRelevanceContext(runtimeSeedData, row);

  const title =
    String(
      recall.retrieval_title || snapshot.title || row.title || seedData.title || canonicalUrl || destinationUrl || externalProductId,
    ).trim() ||
    externalProductId;
  const description = firstNonEmptyString(
    prefersStoredRecallSummary ? recall.retrieval_summary : '',
    runtimeSnapshot.description,
    runtimeSeedData.description,
    !prefersStoredRecallSummary ? recall.retrieval_summary : '',
  );
  const categoryDescription = firstNonEmptyString(
    runtimeSnapshot.description,
    runtimeSeedData.description,
    description,
  );
  const pdpDescriptionRaw = firstNonEmptyString(
    runtimeSnapshot.pdp_description_raw,
    runtimeSeedData.pdp_description_raw,
  );
  const pdpIngredientsRaw = firstNonEmptyString(
    runtimeSnapshot.pdp_ingredients_raw,
    runtimeSeedData.pdp_ingredients_raw,
  );
  const pdpActiveIngredientsRaw = firstNonEmptyString(
    runtimeSnapshot.pdp_active_ingredients_raw,
    runtimeSeedData.pdp_active_ingredients_raw,
  );
  const pdpHowToUseRaw = firstNonEmptyString(
    runtimeSnapshot.pdp_how_to_use_raw,
    runtimeSeedData.pdp_how_to_use_raw,
  );
  const pdpFaqItems = normalizeFaqItems(
    Array.isArray(runtimeSnapshot.pdp_faq_items) && runtimeSnapshot.pdp_faq_items.length > 0
      ? runtimeSnapshot.pdp_faq_items
      : runtimeSeedData.pdp_faq_items,
  );
  const rawIngredientTextClean = firstNonEmptyString(
    ingredientIntel.raw_ingredient_text_clean,
    snapshotIngredientIntel.raw_ingredient_text_clean,
    runtimeSeedData.raw_ingredient_text_clean,
    runtimeSnapshot.raw_ingredient_text_clean,
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
  );
  const inciList = normalizeStringList(
    ingredientIntel.inci_list ||
      snapshotIngredientIntel.inci_list ||
      ingredientIntel.inci_normalized ||
      snapshotIngredientIntel.inci_normalized ||
      runtimeSeedData.inci_list ||
      runtimeSnapshot.inci_list ||
      seedData.inci_list ||
      snapshot.inci_list,
  );
  const fallbackIngredientsInci = normalizeStringList(
    runtimeSeedData.ingredients_inci ||
      runtimeSnapshot.ingredients_inci ||
      seedData.ingredients_inci ||
      snapshot.ingredients_inci ||
      runtimeSeedData.ingredientsInci ||
      runtimeSnapshot.ingredientsInci ||
      seedData.ingredientsInci ||
      snapshot.ingredientsInci,
    256,
  );
  const activeIngredients = [];
  const keyIngredients = normalizeStringList(
    runtimeSnapshot.key_ingredients ||
      runtimeSnapshot.keyIngredients ||
      runtimeSeedData.key_ingredients ||
      runtimeSeedData.keyIngredients ||
      science.key_ingredients ||
      science.keyIngredients ||
      snapshotScience.key_ingredients ||
      snapshotScience.keyIngredients,
    24,
  );
  const pdpDetailsSections = isSurfaceablePdpField(pdpFieldQualitySummary, 'details_sections')
    ? Array.isArray(runtimeSnapshot.pdp_details_sections)
      ? runtimeSnapshot.pdp_details_sections
      : Array.isArray(runtimeSeedData.pdp_details_sections)
        ? runtimeSeedData.pdp_details_sections
        : []
    : [];
  const derivedSeparatedContentImageUrls = extractSeparatedContentImageUrls(
    collectSeedImageUrls(runtimeSeedData, row),
    galleryRelevanceContext,
  );
  const contentImageUrls = [];
  appendImageUrls(contentImageUrls, extractSeparatedContentImageUrls(runtimeSnapshot.content_image_urls, galleryRelevanceContext));
  appendImageUrls(contentImageUrls, extractSeparatedContentImageUrls(runtimeSeedData.content_image_urls, galleryRelevanceContext));
  appendImageUrls(contentImageUrls, derivedSeparatedContentImageUrls);
  const pdpFieldCaptureStatus =
    (runtimeSnapshot.pdp_field_capture_status && typeof runtimeSnapshot.pdp_field_capture_status === 'object')
      ? runtimeSnapshot.pdp_field_capture_status
      : (runtimeSeedData.pdp_field_capture_status && typeof runtimeSeedData.pdp_field_capture_status === 'object')
        ? runtimeSeedData.pdp_field_capture_status
        : undefined;
  const seedDescriptionOrigin = firstNonEmptyString(
    runtimeSnapshot.seed_description_origin,
    runtimeSeedData.seed_description_origin,
  );
  const sourcePageType = firstNonEmptyString(
    runtimeSnapshot.source_page_type,
    runtimeSeedData.source_page_type,
    row.source_page_type,
  );
  const contentQuality = firstNonEmptyString(
    runtimeSnapshot.content_quality,
    runtimeSeedData.content_quality,
    row.content_quality,
  );
  const sourceUrl = firstNonEmptyString(
    runtimeSnapshot.source_url,
    runtimeSeedData.source_url,
    row.source_url,
    canonicalUrl,
    destinationUrl,
  );
  const volume = firstNonEmptyString(
    runtimeSnapshot.volume,
    runtimeSeedData.volume,
    seedData.volume,
    snapshot.volume,
  );
  const productVolume = firstNonEmptyString(
    runtimeSnapshot.product_volume,
    runtimeSnapshot.productVolume,
    runtimeSeedData.product_volume,
    runtimeSeedData.productVolume,
    seedData.product_volume,
    seedData.productVolume,
    snapshot.product_volume,
    snapshot.productVolume,
  );
  const netContent = firstNonEmptyString(
    runtimeSnapshot.net_content,
    runtimeSnapshot.netContent,
    runtimeSeedData.net_content,
    runtimeSeedData.netContent,
    seedData.net_content,
    seedData.netContent,
    snapshot.net_content,
    snapshot.netContent,
  );
  const netSize = firstNonEmptyString(
    runtimeSnapshot.net_size,
    runtimeSnapshot.netSize,
    runtimeSeedData.net_size,
    runtimeSeedData.netSize,
    seedData.net_size,
    seedData.netSize,
    snapshot.net_size,
    snapshot.netSize,
  );
  const explicitSizeDetailLabel = firstNonEmptyString(
    runtimeSnapshot.size_detail_label,
    runtimeSnapshot.sizeDetailLabel,
    runtimeSeedData.size_detail_label,
    runtimeSeedData.sizeDetailLabel,
    seedData.size_detail_label,
    seedData.sizeDetailLabel,
    snapshot.size_detail_label,
    snapshot.sizeDetailLabel,
  );
  const reviewSummary = normalizeSeedReviewSummary(
    runtimeSnapshot.review_summary,
    runtimeSnapshot.reviewSummary,
    runtimeSeedData.review_summary,
    runtimeSeedData.reviewSummary,
    runtimeSnapshot.reviews_summary,
    runtimeSeedData.reviews_summary,
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
  const productKind = classifyExternalSeedProductKind({
    ...row,
    title,
    description,
    category: explicitCategory || row.category,
    product_type: explicitCategory || row.product_type,
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    seed_data: seedData,
  });
  const productFamily = productKind.family;
  const forcedCategory =
    productFamily === 'non_merch'
      ? 'Gift Card'
      : productFamily === 'accessory'
        ? explicitCategory || 'Accessory'
        : '';
  const ingredientTokens = collectSeedIngredientSignalTokens(seedData, row);
  const ingredientIds = collectStructuredIngredientIds(row, seedData, snapshot);
  const inferredCategory = inferExternalSeedBeautyCategory({
    explicitCategory,
    title,
    description: categoryDescription,
    canonicalUrl,
    destinationUrl,
    ingredientIds,
  });
  const category =
    forcedCategory ||
    (productFamily === 'set_or_collection' ? inferredCategory || 'Set' : inferredCategory);
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
  const cachedSeedImageUrls = collectCachedSeedImageUrls(seedData);
  let imageUrls = cachedSeedImageUrls.length > 0 ? cachedSeedImageUrls : normalizeSeedImageUrls(seedData, row);
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
  const sizeDetailLabel =
    explicitSizeDetailLabel ||
    buildSeedSizeDetailLabel(
      productVolume,
      volume,
      netContent,
      netSize,
      selectedVariant?.option_value,
      selectedVariant?.title,
      variants[0]?.option_value,
      variants[0]?.title,
    );
  const primaryVariantImageUrls = collectPrimaryVariantImageUrls(variants);
  if (!cachedSeedImageUrls.length && primaryVariantImageUrls.length > 0) {
    imageUrls = Array.from(new Set([...primaryVariantImageUrls, ...imageUrls]));
  }
  if (contentImageUrls.length > 0 && imageUrls.length > 0) {
    const contentKeys = new Set(
      contentImageUrls
        .map((url) => buildPdpImageDedupeKey(url) || normalizePdpImageUrl(url))
        .filter(Boolean),
    );
    const nonContentImageUrls = imageUrls.filter((url) => {
      const key = buildPdpImageDedupeKey(url) || normalizePdpImageUrl(url);
      return key && !contentKeys.has(key);
    });
    if (nonContentImageUrls.length > 0) {
      imageUrls = nonContentImageUrls;
    }
  }
  imageUrls = filterMixedShopifyContentFromGallery(imageUrls);
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
    imageUrls = filterMixedShopifyContentFromGallery(imageUrls);
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

  const authorityInput = {
    product_id: externalProductId,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    source: 'external_seed',
    title,
    description,
    category: normalizedCategory || explicitCategory || '',
    product_type: normalizedCategory || explicitCategory || '',
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    seed_data: runtimeSeedData,
    raw_ingredient_text_clean:
      runtimeSeedData.raw_ingredient_text_clean ||
      runtimeSnapshot.raw_ingredient_text_clean ||
      ingredientIntel.raw_ingredient_text_clean ||
      snapshotIngredientIntel.raw_ingredient_text_clean,
    inci_list:
      runtimeSeedData.inci_list ||
      runtimeSnapshot.inci_list ||
      seedData.inci_list ||
      snapshot.inci_list ||
      ingredientIntel.inci_list ||
      snapshotIngredientIntel.inci_list,
    ingredients_inci:
      Array.isArray(runtimeSeedData.ingredients_inci) && runtimeSeedData.ingredients_inci.length > 0
        ? runtimeSeedData.ingredients_inci
        : Array.isArray(runtimeSnapshot.ingredients_inci) && runtimeSnapshot.ingredients_inci.length > 0
          ? runtimeSnapshot.ingredients_inci
          : Array.isArray(seedData.ingredients_inci) && seedData.ingredients_inci.length > 0
            ? seedData.ingredients_inci
            : Array.isArray(snapshot.ingredients_inci) && snapshot.ingredients_inci.length > 0
              ? snapshot.ingredients_inci
              : undefined,
    pdp_ingredients_raw: isSurfaceablePdpField(pdpFieldQualitySummary, 'ingredients_raw')
      ? runtimeSeedData.pdp_ingredients_raw || runtimeSnapshot.pdp_ingredients_raw
      : undefined,
    pdp_active_ingredients_raw: isSurfaceablePdpField(pdpFieldQualitySummary, 'active_ingredients_raw')
      ? runtimeSeedData.pdp_active_ingredients_raw || runtimeSnapshot.pdp_active_ingredients_raw
      : undefined,
    details_sections: pdpDetailsSections.length > 0 ? pdpDetailsSections : undefined,
    ingredient_intel: ingredientIntel,
  };
  const authority = isIngredientAuthorityEligibleExternalSeed(authorityInput)
    ? buildAuthoritativeIngredientView(authorityInput)
    : {
        items: [],
        active_items: [],
        source_origin: 'none',
        purity_status: 'suppressed',
        suppressed_reason: `product_family_${productFamily}`,
        generated_at: new Date().toISOString(),
      };
  const mergedIngredientIntel = mergeIngredientIntelWithAuthority(ingredientIntel, authority);
  const bundleComponentRefs =
    normalizeBundleComponentRefsForRuntime(runtimeSeedData.bundle_component_refs).length > 0
      ? normalizeBundleComponentRefsForRuntime(runtimeSeedData.bundle_component_refs)
      : normalizeBundleComponentRefsForRuntime(runtimeSnapshot.bundle_component_refs).length > 0
        ? normalizeBundleComponentRefsForRuntime(runtimeSnapshot.bundle_component_refs)
        : normalizeBundleComponentRefsForRuntime(seedData.bundle_component_refs).length > 0
          ? normalizeBundleComponentRefsForRuntime(seedData.bundle_component_refs)
          : normalizeBundleComponentRefsForRuntime(snapshot.bundle_component_refs);

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
    product_family: productFamily,
    external_seed_product_family: productFamily,
    external_seed_product_kind_reasons: productKind.reasons,
    ...(seedData.parent_external_product_id ? { parent_external_product_id: String(seedData.parent_external_product_id).trim() } : {}),
    ...(seedData.source_listing_scope ? { source_listing_scope: String(seedData.source_listing_scope).trim() } : {}),
    ...(ingredientIds.length ? { ingredient_ids: ingredientIds } : {}),
    url: canonicalUrl || destinationUrl || undefined,
    canonical_url: canonicalUrl || undefined,
    destination_url: destinationUrl || undefined,
    external_seed_id: row.id ? String(row.id) : undefined,
    seed_data: runtimeSeedData,
    external_seed_recall: recall,
    external_seed_quality_state: protection.quality_state,
    external_seed_suppression_flags: protection.suppression_flags,
    external_seed_quality_signals: recall.quality_signals || undefined,
    ...(commerceFacts ? { commerce_facts_v1: commerceFacts, commerce_facts: commerceFacts } : {}),
    ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
    ...(shouldExposeLocalityFacts
      ? {
          locality_facts_v1: localityFacts,
          locality_facts: localityFacts,
          local_authority: localityFacts,
        }
      : {}),
    ...(localityFacts.brand_origin ? { brand_origin: localityFacts.brand_origin } : {}),
    ...(localityFacts.brand_origin_country ? { brand_origin_country: localityFacts.brand_origin_country } : {}),
    ...(localityFacts.brand_home_market ? { brand_home_market: localityFacts.brand_home_market } : {}),
    ...(localityFacts.market_availability ? { market_availability: localityFacts.market_availability } : {}),
    ...(localityFacts.available_markets?.length ? { available_markets: localityFacts.available_markets } : {}),
    ...(localityFacts.local_purchase_markets?.length ? { local_purchase_markets: localityFacts.local_purchase_markets } : {}),
    ...(localityFacts.local_retail_channels?.length ? { local_retail_channels: localityFacts.local_retail_channels } : {}),
    ...(localityFacts.local_retail_channels?.length
      ? { local_retail_channel: localityFacts.local_retail_channels.map((channel) => channel.channel).filter(Boolean) }
      : {}),
    ...(typeof localityFacts.travel_size === 'boolean' ? { travel_size: localityFacts.travel_size } : {}),
    ...(localityFacts.creator_local_reason ? { creator_local_reason: localityFacts.creator_local_reason } : {}),
    ...(options.matchSource ? { external_seed_match_source: String(options.matchSource).trim() } : {}),
    variants,
    ...(selectedVariant?.variant_id ? { selected_variant_id: selectedVariant.variant_id } : {}),
    ...(selectedVariant?.variant_id ? { default_variant_id: selectedVariant.variant_id } : {}),
    ...(selectedVariant?.title ? { variant_title: String(selectedVariant.title).trim() } : {}),
    ...(volume ? { volume } : {}),
    ...(productVolume ? { product_volume: productVolume } : {}),
    ...(netContent ? { net_content: netContent } : {}),
    ...(netSize ? { net_size: netSize } : {}),
    ...(sizeDetailLabel ? { size_detail_label: sizeDetailLabel } : {}),
    ...(rawIngredientTextClean ? { raw_ingredient_text_clean: rawIngredientTextClean } : {}),
    ...(inciList.length ? { inci_list: inciList } : {}),
    ...(activeIngredients.length ? { active_ingredients: activeIngredients } : {}),
    ...(keyIngredients.length ? { key_ingredients: keyIngredients } : {}),
    ...(isSurfaceablePdpField(pdpFieldQualitySummary, 'description_raw') && pdpDescriptionRaw
      ? { pdp_description_raw: pdpDescriptionRaw }
      : {}),
    ...(pdpDetailsSections.length ? { pdp_details_sections: pdpDetailsSections } : {}),
    ...(contentImageUrls.length ? { content_image_urls: contentImageUrls } : {}),
    ...(bundleComponentRefs.length ? { bundle_component_refs: bundleComponentRefs } : {}),
    ...(isSurfaceablePdpField(pdpFieldQualitySummary, 'ingredients_raw') && pdpIngredientsRaw
      ? { pdp_ingredients_raw: pdpIngredientsRaw }
      : {}),
    ...(isSurfaceablePdpField(pdpFieldQualitySummary, 'active_ingredients_raw') && pdpActiveIngredientsRaw
      ? { pdp_active_ingredients_raw: pdpActiveIngredientsRaw }
      : {}),
    ...(isSurfaceablePdpField(pdpFieldQualitySummary, 'how_to_use_raw') && pdpHowToUseRaw
      ? { pdp_how_to_use_raw: pdpHowToUseRaw }
      : {}),
    ...(isSurfaceablePdpField(pdpFieldQualitySummary, 'faq_items') && pdpFaqItems.length
      ? { pdp_faq_items: pdpFaqItems }
      : {}),
    ...(seedDescriptionOrigin ? { seed_description_origin: seedDescriptionOrigin } : {}),
    ...(sourcePageType ? { source_page_type: sourcePageType } : {}),
    ...(contentQuality ? { content_quality: contentQuality } : {}),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(reviewSummary ? { review_summary: reviewSummary } : {}),
    ...(pdpFieldCaptureStatus ? { pdp_field_capture_status: pdpFieldCaptureStatus } : {}),
    ...(pdpFieldQualitySummary ? { pdp_field_quality_summary: pdpFieldQualitySummary } : {}),
    ...(Object.keys(ingredientIntel).length ? { ingredient_intel: ingredientIntel } : {}),
    ...(ingredientTokens.length ? { ingredient_tokens: ingredientTokens } : {}),
    ...(authority.items.length
      ? { ingredients_inci: authority.items }
      : fallbackIngredientsInci.length && productFamily !== 'set_or_collection'
        ? { ingredients_inci: fallbackIngredientsInci }
        : {}),
    ...(shouldExposeAuthorityActiveItems(authority) ? { active_ingredients: authority.active_items } : {}),
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
  const commerceFacts = readCommerceFactsV1({ ...row, seed_data: effectiveSeedData });
  const agentSafeCommerceFacts = commerceFacts ? buildAgentSafeCommerceFacts(commerceFacts) : null;
  const snapshot = ensureJsonObject(effectiveSeedData.snapshot);
  const localityFacts = resolveExternalSeedLocalityFacts({ row, seedData: effectiveSeedData, snapshot });
  const shouldExposeLocalityFacts = hasLocalityFactsValue(localityFacts);
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
  const cachedImageUrls = collectCachedSeedImageUrls(effectiveSeedData);
  const imageUrl = firstNonEmptyString(
    cachedImageUrls[0],
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
    ...(row.market ? { market: String(row.market).trim().toUpperCase() } : {}),
    url: canonicalUrl || destinationUrl || undefined,
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    ...(destinationUrl ? { destination_url: destinationUrl } : {}),
    ...(row.id ? { external_seed_id: String(row.id) } : {}),
    ...(reviewSummary ? { review_summary: reviewSummary } : {}),
    external_seed_recall: recall,
    external_seed_quality_state: protection.quality_state,
    external_seed_suppression_flags: protection.suppression_flags,
    ...(commerceFacts ? { commerce_facts_v1: commerceFacts, commerce_facts: commerceFacts } : {}),
    ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
    ...(shouldExposeLocalityFacts
      ? {
          locality_facts_v1: localityFacts,
          locality_facts: localityFacts,
          local_authority: localityFacts,
        }
      : {}),
    ...(localityFacts.brand_origin ? { brand_origin: localityFacts.brand_origin } : {}),
    ...(localityFacts.brand_origin_country ? { brand_origin_country: localityFacts.brand_origin_country } : {}),
    ...(localityFacts.brand_home_market ? { brand_home_market: localityFacts.brand_home_market } : {}),
    ...(localityFacts.market_availability ? { market_availability: localityFacts.market_availability } : {}),
    ...(localityFacts.available_markets?.length ? { available_markets: localityFacts.available_markets } : {}),
    ...(localityFacts.local_purchase_markets?.length ? { local_purchase_markets: localityFacts.local_purchase_markets } : {}),
    ...(localityFacts.local_retail_channels?.length ? { local_retail_channels: localityFacts.local_retail_channels } : {}),
    ...(localityFacts.local_retail_channels?.length
      ? { local_retail_channel: localityFacts.local_retail_channels.map((channel) => channel.channel).filter(Boolean) }
      : {}),
    ...(typeof localityFacts.travel_size === 'boolean' ? { travel_size: localityFacts.travel_size } : {}),
    ...(localityFacts.creator_local_reason ? { creator_local_reason: localityFacts.creator_local_reason } : {}),
    ...(brand ? { vendor: brand, brand } : {}),
    ...(normalizedCategory ? { category: normalizedCategory } : {}),
  };
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  stableExternalProductId,
  ensureJsonObject,
  normalizeSeedAvailability,
  normalizeSeedReviewSummary,
  availabilityToInStock,
  inferExternalSeedBeautyCategory,
  inferExternalSeedSkincareCategory: inferExternalSeedBeautyCategory,
  collectSeedImageUrls,
  collectCachedSeedImageUrls,
  normalizeSeedImageUrls,
  normalizeSeedVariants,
  sanitizeSeedVariantDisplayFields,
  canonicalizeExternalSeedSnapshot,
  buildExternalSeedProduct,
  buildExternalSeedBrandSearchProduct,
};
