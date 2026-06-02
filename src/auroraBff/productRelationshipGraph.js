const crypto = require('node:crypto');
const { query } = require('../db');
const logger = require('../logger');
const {
  resolveRelationshipGraphRefsToCanonicalEntities,
} = require('../services/catalogEntityResolution');
const productRelationshipGraphSources = require('./productRelationshipGraphSources');

const relationshipGraphSourcesInternal = productRelationshipGraphSources.__internal || {};
const familyIdentityKey =
  relationshipGraphSourcesInternal.familyIdentityKey ||
  productRelationshipGraphSources.familyIdentityKey ||
  (() => '');
const familyIdentityKeysCompatible =
  relationshipGraphSourcesInternal.familyIdentityKeysCompatible ||
  productRelationshipGraphSources.familyIdentityKeysCompatible ||
  ((left, right) => Boolean(left && right && left === right));

const RELATION_TYPES = new Set(['dupe', 'competitive_alternative', 'niche_specialist', 'related_product']);
const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired']);
const ANCHOR_TYPES = new Set(['product', 'need']);
const PRICE_FRESHNESS_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MARKET = 'US';
const DEFAULT_VERTICAL = 'beauty';
const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_FLAG = 'AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED';
const RELATIONSHIP_GRAPH_PG_COLLAPSE_ALIAS_FLAG = 'AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED';

const AUTHORITATIVE_SOURCE_TYPES = new Set([
  'official_pdp',
  'seller_pdp',
  'catalog_intelligence',
  'ingredient_kb',
  'product_intel_kb',
  'external_product_seed',
  'external_seed',
  'products_cache',
  'aurora_dupe_kb',
  'relationship_graph',
]);

const SCORING_FIELDS = [
  'category_use_case_match',
  'ingredient_functional_similarity',
  'skin_fit_similarity',
  'price_advantage',
  'evidence_quality',
  'availability_confidence',
  'social_reference_strength',
  'score_total',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRelationshipGraphFamilyCollapseEnabled(env = process.env) {
  return (
    String(env?.[RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_FLAG] || '') === 'true' ||
    String(env?.[RELATIONSHIP_GRAPH_PG_COLLAPSE_ALIAS_FLAG] || '') === 'true'
  );
}

function buildPublicProductUrl(entityId) {
  const normalizedEntityId = normalizeString(entityId, 260);
  return normalizedEntityId ? `https://agent.pivota.cc/products/${normalizedEntityId}` : '';
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
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
  if (typeof value === 'object' && !Array.isArray(value)) {
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

function stableJson(value) {
  try {
    return JSON.stringify(value == null ? null : value);
  } catch {
    return 'null';
  }
}

function normalizeJsonbParam(value, fallback) {
  if (value === undefined) return stableJson(fallback);
  return stableJson(value);
}

function normalizeArray(value, max = 16) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function normalizeCategoryTaxonomy(value) {
  if (Array.isArray(value)) {
    const out = [];
    const seen = new Set();
    for (const raw of value) {
      const token = normalizeString(raw, 120);
      const key = token.toLowerCase();
      if (!token || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
      if (out.length >= 12) break;
    }
    return out;
  }
  const text = normalizeString(value, 240);
  return text ? [text] : [];
}

function normalizeScoreBreakdown(value) {
  const src = isPlainObject(value) ? value : {};
  const out = { ...src };
  for (const field of SCORING_FIELDS) {
    if (out[field] == null || out[field] === '') continue;
    out[field] = Number(clamp01(out[field], 0).toFixed(4));
  }
  return out;
}

function normalizeSourceRefs(value) {
  const refs = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const src = typeof raw === 'string' ? { type: raw } : isPlainObject(raw) ? raw : null;
    if (!src) continue;
    const type = normalizeLower(src.type || src.source_type || src.source, 80);
    const url = normalizeString(src.url || src.href || src.canonical_url, 500);
    const name = normalizeString(src.name || src.label || src.title, 180);
    if (!type && !url && !name) continue;
    const key = `${type}::${url}::${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      ...(type ? { type } : {}),
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
      ...(src.authoritative === true || src.authority === true ? { authoritative: true } : {}),
      ...(src.observed_at ? { observed_at: toIsoOrNull(src.observed_at) || normalizeString(src.observed_at, 80) } : {}),
    });
    if (refs.length >= 16) break;
  }
  return refs;
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function extractBrand(snapshot) {
  const obj = isPlainObject(snapshot) ? snapshot : {};
  return normalizeLower(
    pickFirstString(
      obj.brand_id,
      obj.brandId,
      obj.brand,
      obj.brand_name,
      obj.brandName,
      obj.vendor,
      obj.vendor_name,
      obj.vendorName,
    ),
    200,
  );
}

function extractPrice(snapshot) {
  const obj = isPlainObject(snapshot) ? snapshot : {};
  return toNumberOrNull(obj.price ?? obj.price_amount ?? obj.priceAmount ?? obj.sale_price ?? obj.salePrice);
}

function extractProductName(snapshot) {
  const obj = isPlainObject(snapshot) ? snapshot : {};
  return pickFirstString(obj.name, obj.display_name, obj.displayName, obj.title, obj.product_name, obj.productName);
}

function buildDefaultDisplayLabel(relationType, priceRatio) {
  if (relationType === 'dupe') {
    return priceRatio != null && priceRatio <= 0.85 ? 'budget_alternative' : 'alternative';
  }
  if (relationType === 'competitive_alternative') return 'alternative';
  if (relationType === 'niche_specialist') return 'niche_specialist';
  return 'related_product';
}

function evidenceGradeRank(value) {
  const grade = normalizeUpperEvidenceGrade(value);
  if (grade === 'A') return 4;
  if (grade === 'B') return 3;
  if (grade === 'C') return 2;
  if (grade === 'D') return 1;
  return 0;
}

function normalizeUpperEvidenceGrade(value) {
  const text = normalizeString(value, 8).toUpperCase();
  if (['A', 'B', 'C', 'D'].includes(text)) return text;
  return '';
}

function getPriceRatio(edge) {
  const price = isPlainObject(edge.price_evidence) ? edge.price_evidence : {};
  const explicit = toNumberOrNull(price.price_ratio ?? price.priceRatio);
  if (explicit != null) return explicit;
  const anchorPrice = toNumberOrNull(
    price.anchor_price_amount ?? price.anchorPriceAmount ?? extractPrice(edge.anchor_snapshot),
  );
  const candidatePrice = toNumberOrNull(
    price.candidate_price_amount ?? price.candidatePriceAmount ?? extractPrice(edge.candidate_snapshot),
  );
  if (anchorPrice == null || candidatePrice == null || anchorPrice <= 0) return null;
  return candidatePrice / anchorPrice;
}

function getCandidatePrice(edge) {
  const price = isPlainObject(edge.price_evidence) ? edge.price_evidence : {};
  return toNumberOrNull(price.candidate_price_amount ?? price.candidatePriceAmount ?? extractPrice(edge.candidate_snapshot));
}

function getPriceObservedAt(edge) {
  const price = isPlainObject(edge.price_evidence) ? edge.price_evidence : {};
  return toIsoOrNull(
    price.candidate_price_observed_at ??
      price.candidatePriceObservedAt ??
      price.observed_at ??
      price.observedAt,
  );
}

function hasOnPageSource(edge) {
  return normalizeSourceRefs(edge.source_refs).some((ref) => normalizeLower(ref.type) === 'on_page_related');
}

function countAuthoritativeSources(edge) {
  return normalizeSourceRefs(edge.source_refs).filter((ref) => {
    const type = normalizeLower(ref.type);
    return ref.authoritative === true || AUTHORITATIVE_SOURCE_TYPES.has(type);
  }).length;
}

function buildEdgeId(edge) {
  const seed = [
    normalizeLower(edge.market || DEFAULT_MARKET),
    normalizeLower(edge.anchor_type),
    normalizeLower(edge.anchor_ref),
    normalizeLower(edge.candidate_product_ref),
    normalizeLower(edge.relation_type),
  ].join('|');
  return `prel_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function coerceRelationshipEdge(input = {}, options = {}) {
  const src = isPlainObject(input) ? input : {};
  const relationType = normalizeLower(src.relation_type || src.relationType, 64);
  const priceRatio = getPriceRatio({
    ...src,
    price_evidence: src.price_evidence || src.priceEvidence,
    anchor_snapshot: src.anchor_snapshot || src.anchorSnapshot,
    candidate_snapshot: src.candidate_snapshot || src.candidateSnapshot,
  });
  const edge = {
    id: normalizeString(src.id, 128),
    anchor_type: normalizeLower(src.anchor_type || src.anchorType || 'product', 24),
    anchor_ref: normalizeString(src.anchor_ref || src.anchorRef, 260),
    anchor_snapshot: isPlainObject(src.anchor_snapshot || src.anchorSnapshot)
      ? { ...(src.anchor_snapshot || src.anchorSnapshot) }
      : {},
    candidate_product_ref: normalizeString(src.candidate_product_ref || src.candidateProductRef, 260),
    candidate_snapshot: isPlainObject(src.candidate_snapshot || src.candidateSnapshot)
      ? { ...(src.candidate_snapshot || src.candidateSnapshot) }
      : {},
    relation_type: relationType,
    display_label: normalizeLower(src.display_label || src.displayLabel || buildDefaultDisplayLabel(relationType, priceRatio), 80),
    market: normalizeString(src.market || DEFAULT_MARKET, 24).toUpperCase() || DEFAULT_MARKET,
    vertical: normalizeLower(src.vertical || DEFAULT_VERTICAL, 32) || DEFAULT_VERTICAL,
    category_taxonomy: normalizeCategoryTaxonomy(src.category_taxonomy || src.categoryTaxonomy),
    use_case: normalizeString(src.use_case || src.useCase, 240),
    score_total: Number(clamp01(src.score_total ?? src.scoreTotal ?? src.score_breakdown?.score_total, 0).toFixed(4)),
    score_breakdown: normalizeScoreBreakdown(src.score_breakdown || src.scoreBreakdown),
    price_evidence: isPlainObject(src.price_evidence || src.priceEvidence)
      ? { ...(src.price_evidence || src.priceEvidence) }
      : {},
    source_refs: normalizeSourceRefs(src.source_refs || src.sourceRefs),
    evidence_grade: normalizeUpperEvidenceGrade(src.evidence_grade || src.evidenceGrade),
    review_status: normalizeLower(src.review_status || src.reviewStatus || 'pending', 32),
    why_candidate: isPlainObject(src.why_candidate || src.whyCandidate)
      ? { ...(src.why_candidate || src.whyCandidate) }
      : {},
    tradeoffs: normalizeArray(src.tradeoffs, 12),
    watchouts: normalizeArray(src.watchouts, 12),
    provenance: isPlainObject(src.provenance) ? { ...src.provenance } : {},
    last_verified_at: toIsoOrNull(src.last_verified_at || src.lastVerifiedAt),
    expires_at: toIsoOrNull(src.expires_at || src.expiresAt),
    created_at: toIsoOrNull(src.created_at || src.createdAt) || null,
    updated_at: toIsoOrNull(src.updated_at || src.updatedAt) || null,
  };
  if (!edge.id && options.generateId !== false) edge.id = buildEdgeId(edge);
  return edge;
}

function validateRelationshipEdge(input = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const edge = coerceRelationshipEdge(input);
  const errors = [];

  if (!edge.id) errors.push('missing_id');
  if (!ANCHOR_TYPES.has(edge.anchor_type)) errors.push('invalid_anchor_type');
  if (!edge.anchor_ref) errors.push('missing_anchor_ref');
  if (!edge.candidate_product_ref) errors.push('missing_candidate_product_ref');
  if (!RELATION_TYPES.has(edge.relation_type)) errors.push('invalid_relation_type');
  if (!REVIEW_STATUSES.has(edge.review_status)) errors.push('invalid_review_status');
  if (edge.vertical !== DEFAULT_VERTICAL) errors.push('non_beauty_vertical');
  if (!edge.market) errors.push('missing_market');
  if (!edge.source_refs.length) errors.push('missing_source_refs');

  const categoryScore = toNumberOrNull(edge.score_breakdown.category_use_case_match);
  const scoreTotal = toNumberOrNull(edge.score_total);
  if (scoreTotal == null || scoreTotal < 0 || scoreTotal > 1) errors.push('invalid_score_total');
  for (const field of SCORING_FIELDS) {
    if (edge.score_breakdown[field] == null) continue;
    const value = toNumberOrNull(edge.score_breakdown[field]);
    if (value == null || value < 0 || value > 1) errors.push(`invalid_score_${field}`);
  }

  if (edge.review_status === 'approved') {
    if (!edge.last_verified_at) errors.push('approved_missing_last_verified_at');
    if (!edge.expires_at) errors.push('approved_missing_expires_at');
    if (edge.expires_at && new Date(edge.expires_at).getTime() <= nowMs) errors.push('approved_edge_expired');
  }

  const anchorBrand = extractBrand(edge.anchor_snapshot);
  const candidateBrand = extractBrand(edge.candidate_snapshot);
  const sameBrand = Boolean(anchorBrand && candidateBrand && anchorBrand === candidateBrand);
  const priceRatio = getPriceRatio(edge);

  if (edge.relation_type === 'dupe' || edge.relation_type === 'competitive_alternative') {
    if (!anchorBrand || !candidateBrand) errors.push(`${edge.relation_type}_brand_missing`);
    if (sameBrand) errors.push(`${edge.relation_type}_same_brand_blocked`);
    if (hasOnPageSource(edge)) errors.push(`${edge.relation_type}_on_page_source_blocked`);
    if (categoryScore == null) {
      errors.push(`${edge.relation_type}_category_missing`);
    } else if (categoryScore < 0.55) {
      errors.push(`${edge.relation_type}_category_below_threshold`);
    }
  }

  if (edge.relation_type === 'dupe') {
    if (scoreTotal == null || scoreTotal < 0.82) errors.push('dupe_similarity_below_threshold');
    if (getCandidatePrice(edge) == null) errors.push('dupe_candidate_price_missing');
    if (priceRatio == null) {
      errors.push('dupe_price_ratio_missing');
    } else if (priceRatio > 1.0) {
      errors.push('dupe_price_ratio_above_threshold');
    }
    const observedAt = getPriceObservedAt(edge);
    if (!observedAt) {
      errors.push('dupe_price_observed_at_missing');
    } else if (nowMs - new Date(observedAt).getTime() > PRICE_FRESHNESS_MS) {
      errors.push('dupe_price_stale');
    }
  }

  if (edge.relation_type === 'niche_specialist') {
    if (edge.anchor_type !== 'need') errors.push('niche_specialist_anchor_must_be_need');
    if (evidenceGradeRank(edge.evidence_grade) < evidenceGradeRank('B')) errors.push('niche_specialist_evidence_below_b');
    if (countAuthoritativeSources(edge) < 1 && edge.source_refs.length < 2) {
      errors.push('niche_specialist_source_evidence_too_weak');
    }
  }

  if (edge.relation_type === 'related_product') {
    if (!sameBrand && !hasOnPageSource(edge)) errors.push('related_product_requires_same_brand_or_on_page');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: edge,
  };
}

function isApprovedFreshEdge(edge, nowMs = Date.now()) {
  const normalized = coerceRelationshipEdge(edge);
  if (normalized.review_status !== 'approved') return false;
  if (!normalized.last_verified_at || !normalized.expires_at) return false;
  return new Date(normalized.expires_at).getTime() > nowMs;
}

function mapRowToEdge(row) {
  if (!row) return null;
  return coerceRelationshipEdge({
    id: row.id,
    anchor_type: row.anchor_type,
    anchor_ref: row.anchor_ref,
    anchor_snapshot: row.anchor_snapshot,
    candidate_product_ref: row.candidate_product_ref,
    candidate_snapshot: row.candidate_snapshot,
    relation_type: row.relation_type,
    display_label: row.display_label,
    market: row.market,
    vertical: row.vertical,
    category_taxonomy: row.category_taxonomy,
    use_case: row.use_case,
    score_total: row.score_total,
    score_breakdown: row.score_breakdown,
    price_evidence: row.price_evidence,
    source_refs: row.source_refs,
    evidence_grade: row.evidence_grade,
    review_status: row.review_status,
    why_candidate: row.why_candidate,
    tradeoffs: row.tradeoffs,
    watchouts: row.watchouts,
    provenance: row.provenance,
    last_verified_at: row.last_verified_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function buildAnchorRefsFromProduct(anchor = {}) {
  const src = isPlainObject(anchor) ? anchor : {};
  const refs = [];
  const push = (value, prefix = '') => {
    const normalized = normalizeString(value, 260);
    if (!normalized) return;
    const ref = prefix ? `${prefix}:${normalized}` : normalized;
    if (!refs.map((x) => x.toLowerCase()).includes(ref.toLowerCase())) refs.push(ref);
  };
  push(src.product_id || src.productId || src.sku_id || src.skuId || src.id, 'product');
  push(src.product_id || src.productId || src.sku_id || src.skuId || src.id);
  // External-seed anchors are stored as `product:ext_<hash>`. At serving time the
  // canonical product_id may be a pivota signature while the ext_ key lives on
  // external_product_id/source_product_id — derive a ref from it too so curated
  // edges match regardless of which identity the upstream resolver selected.
  const externalId =
    src.external_product_id ||
    src.externalProductId ||
    src.external_seed_product_id ||
    src.externalSeedProductId ||
    src.source_product_id ||
    src.sourceProductId;
  push(externalId, 'product');
  push(externalId);
  push(src.url || src.canonical_url || src.canonicalUrl || src.pdp_url || src.pdpUrl, 'url');
  const brand = pickFirstString(src.brand, src.brand_name, src.brandName, src.vendor);
  const name = extractProductName(src);
  if (brand && name) push(`${brand}:${name}`, 'text');
  return refs;
}

function relationshipEdgeCandidateTokens(edgeInput = {}) {
  const edge = coerceRelationshipEdge(edgeInput);
  const snapshot = isPlainObject(edge.candidate_snapshot) ? edge.candidate_snapshot : {};
  const values = [
    snapshot.product_id,
    snapshot.productId,
    snapshot.external_product_id,
    snapshot.externalProductId,
    snapshot.source_product_id,
    snapshot.sourceProductId,
    snapshot.id,
    snapshot.url,
    snapshot.canonical_url,
    snapshot.canonicalUrl,
    stripRelationshipRefPrefix(edge.candidate_product_ref),
    edge.candidate_product_ref,
  ];
  const tokens = [];
  const seen = new Set();
  for (const value of values) {
    const token = normalizeLower(value, 512);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens.length ? tokens : [normalizeLower(edge.id, 160)].filter(Boolean);
}

function dedupeApprovedRelationshipEdges(edges = []) {
  const out = [];
  const seen = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const relationType = normalizeLower(edge.relation_type, 64);
    const keys = relationshipEdgeCandidateTokens(edge).map((token) => `${relationType}|${token}`);
    if (keys.some((key) => seen.has(key))) continue;
    out.push(edge);
    for (const key of keys) seen.add(key);
  }
  return out;
}

function getRelationshipGraphResolution(resolutionMap, ref) {
  if (!resolutionMap || !ref) return null;
  const normalized = normalizeLower(ref, 512);
  const stripped = stripRelationshipRefPrefix(normalized);
  if (typeof resolutionMap.get === 'function') {
    return (
      resolutionMap.get(normalized) ||
      resolutionMap.get(stripped) ||
      resolutionMap.get(`product:${stripped}`) ||
      null
    );
  }
  if (isPlainObject(resolutionMap)) {
    return (
      resolutionMap[normalized] ||
      resolutionMap[stripped] ||
      resolutionMap[`product:${stripped}`] ||
      null
    );
  }
  return null;
}

function familyKeyFromRelationshipSnapshot(snapshot = {}, ref = '') {
  const snap = isPlainObject(snapshot) ? snapshot : {};
  const shaped = {
    ...snap,
    product_ref: normalizeLower(ref, 512),
    name: extractProductName(snap) || snap.title || snap.name,
    title: snap.title || extractProductName(snap),
    brand: pickFirstString(
      typeof snap.brand === 'string' ? snap.brand : isPlainObject(snap.brand) ? snap.brand.name : '',
      snap.brand_name,
      snap.brandName,
      snap.vendor,
    ),
    category: pickFirstString(snap.category, snap.category_name, snap.categoryName),
    product_type: pickFirstString(snap.product_type, snap.productType),
  };
  const explicitFamily = pickFirstString(
    shaped.product_family_id,
    shaped.productFamilyId,
    shaped.product_line_id,
    shaped.productLineId,
    shaped.variant_of,
    shaped.variantOf,
  );
  const key = familyIdentityKey(shaped);
  if (key && String(key).startsWith('family:')) {
    return {
      family_key: key,
      family_key_source: explicitFamily ? 'product_family_id' : 'derived_family_key',
    };
  }
  return {
    family_key: '',
    family_key_source: '',
  };
}

function buildFallbackRelationshipResolution(ref = '', snapshot = {}) {
  const normalizedRef = normalizeLower(ref, 512);
  const snap = isPlainObject(snapshot) ? snapshot : {};
  const family = familyKeyFromRelationshipSnapshot(snap, normalizedRef);
  return {
    input_ref: normalizeString(ref, 512),
    normalized_ref: normalizedRef,
    family_key: family.family_key || `ref:${normalizedRef}`,
    family_key_source: family.family_key_source || 'fallback_ref',
    product_group_id: null,
    pivota_signature_id: null,
    canonical_entity_id: null,
    canonical_url: null,
    pivota_canonical_url: null,
    display_snapshot: Object.keys(snap).length ? { ...snap } : null,
    display_snapshot_source: Object.keys(snap).length ? 'edge_snapshot' : 'fallback_ref',
    resolved: false,
  };
}

function resolveRelationshipEdgeRefContext(ref, snapshot, resolutionMap) {
  const resolved = getRelationshipGraphResolution(resolutionMap, ref);
  const fallback = buildFallbackRelationshipResolution(ref, snapshot);
  if (!resolved) return fallback;
  if (resolved.family_key && resolved.family_key_source !== 'fallback_ref') {
    return {
      ...fallback,
      ...resolved,
      display_snapshot: resolved.display_snapshot || fallback.display_snapshot,
      display_snapshot_source: resolved.display_snapshot_source || fallback.display_snapshot_source,
    };
  }
  if (fallback.family_key_source !== 'fallback_ref') {
    return {
      ...resolved,
      ...fallback,
      product_group_id: resolved.product_group_id || fallback.product_group_id,
      pivota_signature_id: resolved.pivota_signature_id || fallback.pivota_signature_id,
      canonical_entity_id: resolved.canonical_entity_id || fallback.canonical_entity_id,
      canonical_url: resolved.canonical_url || fallback.canonical_url,
      pivota_canonical_url: resolved.pivota_canonical_url || fallback.pivota_canonical_url,
      display_snapshot: resolved.display_snapshot || fallback.display_snapshot,
      display_snapshot_source: resolved.display_snapshot_source || fallback.display_snapshot_source,
    };
  }
  return {
    ...fallback,
    ...resolved,
    display_snapshot: resolved.display_snapshot || fallback.display_snapshot,
    display_snapshot_source: resolved.display_snapshot_source || fallback.display_snapshot_source,
  };
}

function relationshipLabelTierRank(edgeInput = {}, edge = {}) {
  const state = normalizeLower(
    edgeInput.label_state ||
      edgeInput.labelState ||
      edgeInput.provenance?.label_state ||
      edgeInput.provenance?.labelState,
    80,
  );
  if (state === 'human_approved') return 2;
  if (state === 'ai_approved') return 1;
  if (normalizeLower(edge.review_status, 32) === 'approved') return 2;
  return 0;
}

function timeRank(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function latestIso(values = []) {
  let best = 0;
  for (const value of values) {
    best = Math.max(best, timeRank(value));
  }
  return best > 0 ? new Date(best).toISOString() : null;
}

function compareRelationshipFamilyRepresentatives(left, right) {
  if (left.labelTier !== right.labelTier) return right.labelTier - left.labelTier;
  const gradeDelta = evidenceGradeRank(right.edge.evidence_grade) - evidenceGradeRank(left.edge.evidence_grade);
  if (gradeDelta) return gradeDelta;
  const scoreDelta = (Number(right.edge.score_total) || 0) - (Number(left.edge.score_total) || 0);
  if (scoreDelta) return scoreDelta;
  const verifiedDelta = timeRank(right.edge.last_verified_at) - timeRank(left.edge.last_verified_at);
  if (verifiedDelta) return verifiedDelta;
  const updatedDelta = timeRank(right.edge.updated_at) - timeRank(left.edge.updated_at);
  if (updatedDelta) return updatedDelta;
  return normalizeString(left.edge.id, 160).localeCompare(normalizeString(right.edge.id, 160));
}

function assignRelationshipFamilyBucket(buckets, entry) {
  for (const bucket of buckets) {
    if (bucket.market !== entry.edge.market) continue;
    if (bucket.anchor_type !== entry.edge.anchor_type) continue;
    if (bucket.relation_type !== entry.edge.relation_type) continue;
    if (!familyIdentityKeysCompatible(bucket.anchor_family_key, entry.anchorContext.family_key)) continue;
    if (!familyIdentityKeysCompatible(bucket.candidate_family_key, entry.candidateContext.family_key)) continue;
    return bucket;
  }
  const bucket = {
    market: entry.edge.market,
    anchor_type: entry.edge.anchor_type,
    relation_type: entry.edge.relation_type,
    anchor_family_key: entry.anchorContext.family_key,
    candidate_family_key: entry.candidateContext.family_key,
    anchorContext: entry.anchorContext,
    candidateContext: entry.candidateContext,
    entries: [],
  };
  buckets.push(bucket);
  return bucket;
}

function relationshipDisplayContextRank(context = {}) {
  if (context.family_key_source === 'product_family_id') return 0;
  const source = normalizeLower(context.display_snapshot_source, 80);
  if (source === 'product_family_id') return 0;
  if (source === 'product_group_primary') return 1;
  if (source === 'catalog_published') return 2;
  if (source === 'catalog_validated') return 3;
  if (source === 'catalog_candidate') return 4;
  if (source === 'catalog_draft') return 5;
  if (source === 'canonical_catalog') return 6;
  if (source === 'edge_snapshot') return 7;
  return 8;
}

function pickRelationshipFamilyDisplayContext(entries = [], representative = null) {
  const ranked = entries
    .map((entry) => ({
      entry,
      rank: relationshipDisplayContextRank(entry.candidateContext),
      representative: representative && entry.edge.id === representative.edge.id ? 0 : 1,
    }))
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.representative !== right.representative) return left.representative - right.representative;
      return normalizeString(left.entry.candidateContext.normalized_ref, 512).localeCompare(
        normalizeString(right.entry.candidateContext.normalized_ref, 512),
      );
    });
  return ranked[0]?.entry?.candidateContext || representative?.candidateContext || {};
}

function buildCollapsedRelationshipFamilyEdge(bucket) {
  const entries = bucket.entries.slice().sort(compareRelationshipFamilyRepresentatives);
  const representative = entries[0];
  const winningTierEntries = entries.filter((entry) => entry.labelTier === representative.labelTier);
  const scoreTotal = Math.max(...winningTierEntries.map((entry) => Number(entry.edge.score_total) || 0));
  const bestEvidence = winningTierEntries
    .slice()
    .sort((left, right) => evidenceGradeRank(right.edge.evidence_grade) - evidenceGradeRank(left.edge.evidence_grade))[0];
  const mergedSourceRefs = normalizeSourceRefs(
    winningTierEntries.flatMap((entry) => normalizeSourceRefs(entry.edge.source_refs)),
  );
  const candidateContext = pickRelationshipFamilyDisplayContext(entries, representative);
  const candidateSnapshot =
    candidateContext.display_snapshot ||
    representative.edge.candidate_snapshot ||
    {};
  const candidateCanonicalEntityId = pickFirstString(
    candidateContext.canonical_entity_id,
    candidateSnapshot.canonical_entity_id,
    candidateSnapshot.product_id,
    candidateSnapshot.id,
  );
  const candidateCanonicalUrl = pickFirstString(
    candidateContext.pivota_canonical_url,
    candidateContext.canonical_url,
    candidateSnapshot.pivota_canonical_url,
    candidateSnapshot.canonical_url,
    candidateSnapshot.url,
    candidateCanonicalEntityId ? buildPublicProductUrl(candidateCanonicalEntityId) : '',
  );
  const collapsed = {
    ...representative.edge,
    score_total: Number(scoreTotal.toFixed(4)),
    evidence_grade: bestEvidence?.edge.evidence_grade || representative.edge.evidence_grade,
    source_refs: mergedSourceRefs,
    expires_at: latestIso(winningTierEntries.map((entry) => entry.edge.expires_at)),
    last_verified_at: latestIso(winningTierEntries.map((entry) => entry.edge.last_verified_at)),
    updated_at: latestIso(winningTierEntries.map((entry) => entry.edge.updated_at)),
    candidate_family_key: bucket.candidate_family_key,
    anchor_family_key: bucket.anchor_family_key,
    candidate_offer_group_id: candidateContext.product_group_id || null,
    anchor_offer_group_id: bucket.anchorContext.product_group_id || null,
    candidate_display_snapshot: candidateSnapshot,
    candidate_display_snapshot_source: candidateContext.display_snapshot_source || null,
    candidate_product_group_id: candidateContext.product_group_id || null,
    candidate_pivota_signature_id: candidateContext.pivota_signature_id || null,
    candidate_canonical_entity_id: candidateCanonicalEntityId || null,
    candidate_canonical_url: candidateCanonicalUrl || null,
    provenance: {
      ...(isPlainObject(representative.edge.provenance) ? representative.edge.provenance : {}),
      relationship_family_collapse: {
        version: 1,
        anchor_family_key: bucket.anchor_family_key,
        candidate_family_key: bucket.candidate_family_key,
        anchor_offer_group_id: bucket.anchorContext.product_group_id || null,
        candidate_offer_group_id: candidateContext.product_group_id || null,
        collapsed_edge_count: entries.length,
        representative_edge_id: representative.edge.id,
        score_total_max: Number(scoreTotal.toFixed(4)),
        evidence_grade_best: bestEvidence?.edge.evidence_grade || representative.edge.evidence_grade || null,
      },
    },
  };
  return collapsed;
}

function collapseApprovedRelationshipEdgesToFamilies(edges = [], { resolutionMap, limit = 120 } = {}) {
  const buckets = [];
  const stats = {
    raw_edge_count: Array.isArray(edges) ? edges.length : 0,
    collapsed_edge_count: 0,
    dropped_self_edge_count: 0,
    unresolved_ref_count: 0,
    derived_family_count: 0,
    fallback_ref_count: 0,
  };
  const unresolvedRefs = new Set();
  const derivedFamilies = new Set();
  const fallbackRefs = new Set();

  for (const rawEdge of Array.isArray(edges) ? edges : []) {
    const edge = coerceRelationshipEdge(rawEdge);
    const anchorContext = edge.anchor_type === 'product'
      ? resolveRelationshipEdgeRefContext(edge.anchor_ref, edge.anchor_snapshot, resolutionMap)
      : {
          input_ref: edge.anchor_ref,
          normalized_ref: normalizeLower(edge.anchor_ref, 512),
          family_key: `${edge.anchor_type}:${normalizeLower(edge.anchor_ref, 512)}`,
          family_key_source: 'anchor_ref',
          product_group_id: null,
          resolved: true,
        };
    const candidateContext = resolveRelationshipEdgeRefContext(
      edge.candidate_product_ref,
      edge.candidate_snapshot,
      resolutionMap,
    );

    for (const context of [anchorContext, candidateContext]) {
      if (context.resolved === false && context.normalized_ref) unresolvedRefs.add(context.normalized_ref);
      if (context.family_key_source === 'derived_family_key' && context.family_key) derivedFamilies.add(context.family_key);
      if (context.family_key_source === 'fallback_ref' && context.normalized_ref) fallbackRefs.add(context.normalized_ref);
    }

    if (
      edge.anchor_type === 'product' &&
      anchorContext.family_key &&
      candidateContext.family_key &&
      familyIdentityKeysCompatible(anchorContext.family_key, candidateContext.family_key)
    ) {
      stats.dropped_self_edge_count += 1;
      continue;
    }

    const entry = {
      edge,
      rawEdge,
      anchorContext,
      candidateContext,
      labelTier: relationshipLabelTierRank(rawEdge, edge),
    };
    const bucket = assignRelationshipFamilyBucket(buckets, entry);
    bucket.entries.push(entry);
  }

  const collapsed = buckets
    .map(buildCollapsedRelationshipFamilyEdge)
    .sort((left, right) => {
      const scoreDelta = (Number(right.score_total) || 0) - (Number(left.score_total) || 0);
      if (scoreDelta) return scoreDelta;
      const updatedDelta = timeRank(right.updated_at) - timeRank(left.updated_at);
      if (updatedDelta) return updatedDelta;
      return normalizeString(left.id, 160).localeCompare(normalizeString(right.id, 160));
    });
  const cappedLimit = Math.max(1, Math.min(500, Number(limit) || collapsed.length || 120));
  const out = collapsed.slice(0, cappedLimit);
  stats.collapsed_edge_count = out.length;
  stats.unresolved_ref_count = unresolvedRefs.size;
  stats.derived_family_count = derivedFamilies.size;
  stats.fallback_ref_count = fallbackRefs.size;
  Object.defineProperty(out, '__collapse_stats', {
    value: stats,
    enumerable: false,
    configurable: true,
  });
  return out;
}

function edgeToRecoCandidate(edgeInput) {
  const edge = coerceRelationshipEdge(edgeInput);
  const snapshot = edge.candidate_snapshot || {};
  const scoreBreakdown = {
    ...edge.score_breakdown,
    score_total: edge.score_total,
  };
  const candidatePrice = getCandidatePrice(edge);
  return {
    product_id: pickFirstString(
      snapshot.product_id,
      snapshot.productId,
      snapshot.sku_id,
      snapshot.skuId,
      snapshot.id,
      edge.candidate_product_ref,
    ),
    brand_id: pickFirstString(snapshot.brand_id, snapshot.brandId, snapshot.brand, snapshot.brand_name, snapshot.vendor),
    name: extractProductName(snapshot) || edge.candidate_product_ref,
    url: pickFirstString(snapshot.url, snapshot.canonical_url, snapshot.canonicalUrl, snapshot.pdp_url, snapshot.pdpUrl),
    category_taxonomy: edge.category_taxonomy.length ? edge.category_taxonomy : normalizeCategoryTaxonomy(snapshot.category_taxonomy || snapshot.category),
    category_match: scoreBreakdown.category_use_case_match,
    similarity_score: edge.score_total,
    price: candidatePrice != null ? candidatePrice : snapshot.price,
    relationship_edge_id: edge.id,
    relationship_type: edge.relation_type,
    display_label: edge.display_label,
    use_case: edge.use_case,
    source: { type: 'relationship_graph', name: edge.id },
    source_type: 'relationship_graph',
    score_breakdown: scoreBreakdown,
    why_candidate: edge.why_candidate,
    tradeoffs: edge.tradeoffs,
    watchouts: edge.watchouts,
    evidence_refs: edge.source_refs,
    price_evidence: edge.price_evidence,
  };
}

function splitEdgesForRecoBlocks(edges = []) {
  const out = {
    candidates: [],
    competitors: [],
    related_products: [],
    dupes: [],
  };
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!isApprovedFreshEdge(edge)) continue;
    const candidate = edgeToRecoCandidate(edge);
    if (edge.relation_type === 'dupe') {
      out.dupes.push(candidate);
    } else if (edge.relation_type === 'related_product') {
      out.related_products.push(candidate);
    } else {
      out.competitors.push(candidate);
    }
  }
  return out;
}

function stripRelationshipRefPrefix(ref) {
  return normalizeString(ref, 260).replace(/^[a-z][a-z0-9_+-]*:/i, '').trim();
}

// Adapts an approved edge into the PDP "similar products" item shape consumed by
// the recall pipeline + buildRecommendations (server.js / pdpBuilder.js). External
// seed is the only catalog the curated graph spans, so candidate ids map to the
// `external_seed` merchant. Returns null when the candidate has no usable id.
function relationshipEdgeToSimilarItem(edgeInput = {}) {
  const src = isPlainObject(edgeInput) ? edgeInput : {};
  const edge = coerceRelationshipEdge(edgeInput);
  const displaySnap = isPlainObject(src.candidate_display_snapshot || src.candidateDisplaySnapshot)
    ? { ...(src.candidate_display_snapshot || src.candidateDisplaySnapshot) }
    : {};
  const fallbackSnap = isPlainObject(edge.candidate_snapshot) ? edge.candidate_snapshot : {};
  const snap = Object.keys(displaySnap).length ? displaySnap : fallbackSnap;
  // Display hydration applies ONLY to flag-on collapsed edges (they carry candidate_family_key /
  // candidate_* display fields). Flag-off raw edges must keep the original product_id/url/price
  // precedence byte-for-byte, since relationshipEdgeToSimilarItem is shared by both flag states.
  const isCollapsedEdge = Boolean(
    src.candidate_family_key ||
      src.candidateFamilyKey ||
      src.candidate_display_snapshot ||
      src.candidateDisplaySnapshot ||
      src.candidate_canonical_entity_id ||
      src.candidateCanonicalEntityId ||
      src.candidate_canonical_url ||
      src.candidateCanonicalUrl ||
      src.candidate_product_family_id ||
      src.candidateProductFamilyId,
  );
  const canonicalEntityId = isCollapsedEdge
    ? pickFirstString(
        src.candidate_canonical_entity_id,
        src.candidateCanonicalEntityId,
        src.candidate_product_family_id,
        src.candidateProductFamilyId,
        snap.canonical_entity_id,
        snap.canonicalEntityId,
        snap.product_family_id,
        snap.productFamilyId,
        snap.product_id,
        snap.productId,
        snap.id,
      )
    : '';
  const productId = isCollapsedEdge
    ? pickFirstString(
        canonicalEntityId,
        snap.product_id,
        snap.productId,
        snap.id,
        stripRelationshipRefPrefix(edge.candidate_product_ref),
      )
    : pickFirstString(
        snap.product_id,
        snap.productId,
        snap.id,
        stripRelationshipRefPrefix(edge.candidate_product_ref),
      );
  if (!productId) return null;
  const brand = pickFirstString(
    typeof snap.brand === 'string' ? snap.brand : isPlainObject(snap.brand) ? snap.brand.name : '',
    snap.brand_name,
    snap.brandName,
    snap.vendor,
  );
  const url = isCollapsedEdge
    ? pickFirstString(
        src.candidate_canonical_url,
        src.candidateCanonicalUrl,
        snap.pivota_canonical_url,
        snap.pivotaCanonicalUrl,
        snap.canonical_url,
        snap.canonicalUrl,
        snap.url,
        snap.pdp_url,
        snap.pdpUrl,
        canonicalEntityId ? buildPublicProductUrl(canonicalEntityId) : '',
      )
    : pickFirstString(snap.url, snap.canonical_url, snap.canonicalUrl, snap.pdp_url, snap.pdpUrl);
  const imageUrl = pickFirstString(snap.image_url, snap.image, Array.isArray(snap.images) ? snap.images[0] : '');
  const name = extractProductName(snap);
  const reason = pickFirstString(edge.display_label, edge.relation_type);
  const price = isCollapsedEdge
    ? getCandidatePrice(edge) ?? toNumberOrNull(snap.price ?? snap.price_amount ?? snap.priceAmount)
    : getCandidatePrice(edge);
  return {
    product_id: productId,
    external_product_id: productId,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    ...(name ? { title: name } : {}),
    ...(brand ? { brand } : {}),
    ...(snap.category ? { category: normalizeString(snap.category, 240) } : {}),
    ...(url ? { url, canonical_url: url } : {}),
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(price != null ? { price } : {}),
    source: 'relationship_graph',
    recommendation_source: 'relationship_graph',
    ...(reason ? { reason, recommendation_reason: reason } : {}),
    ...(Number.isFinite(edge.score_total) ? { x_score: edge.score_total } : {}),
    relationship_edge_id: edge.id,
    relationship_type: edge.relation_type,
    ...(edge.display_label ? { display_label: edge.display_label } : {}),
  };
}

async function listApprovedRelationshipEdgesForAnchorUncollapsed({
  anchorType = 'product',
  anchorRefs,
  market = DEFAULT_MARKET,
  relationTypes,
  limit = 120,
  queryFn = query,
} = {}) {
  const refs = (Array.isArray(anchorRefs) ? anchorRefs : [anchorRefs])
    .map((item) => normalizeLower(item, 260))
    .filter(Boolean);
  if (!refs.length) return [];
  const rels = (Array.isArray(relationTypes) ? relationTypes : [])
    .map((item) => normalizeLower(item, 64))
    .filter((item) => RELATION_TYPES.has(item));
  const params = [
    normalizeLower(anchorType, 24) || 'product',
    refs,
    normalizeLower(market || DEFAULT_MARKET, 24) || DEFAULT_MARKET.toLowerCase(),
    Math.max(1, Math.min(500, Number(limit) || 120)),
  ];
  let relationSql = '';
  if (rels.length) {
    params.push(rels);
    relationSql = `AND relation_type = ANY($${params.length}::text[])`;
  }
  try {
    const res = await queryFn(
      `
        SELECT
          id, anchor_type, anchor_ref, anchor_snapshot, candidate_product_ref, candidate_snapshot,
          relation_type, display_label, market, vertical, category_taxonomy, use_case,
          score_total, score_breakdown, price_evidence, source_refs, evidence_grade,
          review_status, why_candidate, tradeoffs, watchouts, provenance,
          last_verified_at, expires_at, created_at, updated_at
        FROM product_relationship_edges
        WHERE anchor_type = $1
          AND lower(anchor_ref) = ANY($2::text[])
          AND lower(market) = $3
          AND vertical = 'beauty'
          AND review_status = 'approved'
          AND last_verified_at IS NOT NULL
          AND expires_at > now()
          ${relationSql}
        ORDER BY score_total DESC, updated_at DESC
        LIMIT $4
      `,
      params,
    );
    const edges = (Array.isArray(res?.rows) ? res.rows : []).map(mapRowToEdge).filter(Boolean);
    return dedupeApprovedRelationshipEdges(edges);
  } catch (err) {
    const code = normalizeString(err && err.code, 20);
    if (code === 'NO_DATABASE' || code === '42P01') return [];
    throw err;
  }
}

async function listApprovedRelationshipEdgesForAnchor(options = {}) {
  const {
    anchor,
    anchorType = 'product',
    anchorRefs,
    market = DEFAULT_MARKET,
    relationTypes,
    limit = 120,
    queryFn = query,
  } = isPlainObject(options) ? options : {};

  if (!isRelationshipGraphFamilyCollapseEnabled()) {
    return listApprovedRelationshipEdgesForAnchorUncollapsed({
      anchorType,
      anchorRefs,
      market,
      relationTypes,
      limit,
      queryFn,
    });
  }

  const normalizedAnchorType = normalizeLower(anchorType, 24) || 'product';
  const requestedLimit = Math.max(1, Math.min(500, Number(limit) || 120));
  const baseRefs =
    normalizedAnchorType === 'product' && isPlainObject(anchor)
      ? buildAnchorRefsFromProduct(anchor)
      : (Array.isArray(anchorRefs) ? anchorRefs : [anchorRefs]).filter(Boolean);
  if (!baseRefs.length) return [];

  const expandedRefs =
    normalizedAnchorType === 'product'
      ? await expandAnchorRefsWithGroupSiblings(baseRefs, { queryFn })
      : baseRefs;
  const rawEdges = await listApprovedRelationshipEdgesForAnchorUncollapsed({
    anchorType: normalizedAnchorType,
    anchorRefs: expandedRefs,
    market,
    relationTypes,
    limit: 500,
    queryFn,
  });

  const refsToResolve = [];
  const pushRef = (ref, snapshot) => {
    const normalizedRef = normalizeString(ref, 512);
    if (!normalizedRef) return;
    refsToResolve.push({ ref: normalizedRef, snapshot: isPlainObject(snapshot) ? snapshot : null });
  };
  for (const edge of rawEdges) {
    pushRef(edge.anchor_ref, edge.anchor_snapshot);
    pushRef(edge.candidate_product_ref, edge.candidate_snapshot);
  }
  let collapsed;
  try {
    const resolutionMap = await resolveRelationshipGraphRefsToCanonicalEntities(refsToResolve, { queryFn });
    collapsed = collapseApprovedRelationshipEdgesToFamilies(rawEdges, {
      resolutionMap,
      anchorRefs: expandedRefs,
      limit: requestedLimit,
    });
  } catch (err) {
    // Fail closed to uncollapsed serving: flag-on must never be worse than flag-off.
    // A transient resolver/collapse failure degrades to the raw (uncollapsed) edges
    // rather than discarding them.
    logger.warn?.(
      {
        kind: 'metric',
        name: 'aurora_bff_relationship_graph_family_collapse_error',
        error: err?.message,
      },
      'aurora bff: relationship graph family collapse failed; serving uncollapsed edges',
    );
    return rawEdges.slice(0, requestedLimit);
  }
  const stats = collapsed.__collapse_stats || {};
  logger.info?.(
    {
      kind: 'metric',
      name: 'aurora_bff_relationship_graph_family_collapse',
      raw_edge_count: rawEdges.length,
      collapsed_edge_count: collapsed.length,
      dropped_self_edge_count: stats.dropped_self_edge_count || 0,
      unresolved_ref_count: stats.unresolved_ref_count || 0,
      derived_family_count: stats.derived_family_count || 0,
      fallback_ref_count: stats.fallback_ref_count || 0,
      collapse_enabled: true,
    },
    'aurora bff: relationship graph family collapse',
  );
  return collapsed;
}

// Read-time alias expansion (per docs/SIG_EXT_FRONT_FACING_FIX.md). A queried
// product may be a NON-PRIMARY listing in a product group whose relation-graph
// edges live on a sibling listing's `product:ext_<hash>` anchor. Without
// expansion, that listing returns zero edges even though its product group has
// them (measured: 432 listings across 144 groups). Resolve the queried product's
// group via `product_group_members` and add every sibling `ext_*` to the anchor
// ref list. Edges stay stored on `ext_*`; identity is resolved at read time and
// never stamped. Standalone products (no group) get no siblings — a safe no-op.
//
// NOTE: adds one product_group_members lookup per anchor resolution. A versioned
// cache keyed on group-membership version is the follow-up for hot paths.
async function expandAnchorRefsWithGroupSiblings(baseRefs = [], { queryFn = query } = {}) {
  const refs = Array.isArray(baseRefs) ? baseRefs.slice() : [];
  const extKeys = Array.from(new Set(
    refs
      .map((r) => String(r || '').replace(/^product:/i, ''))
      .map((k) => k.toLowerCase())
      .filter((k) => /^ext_/i.test(k)),
  ));
  if (!extKeys.length) return refs;
  try {
    const res = await queryFn(
      `
        WITH anchor_keys AS (SELECT unnest($1::text[]) AS k),
        groups AS (
          SELECT DISTINCT pgm.product_group_id
          FROM product_group_members pgm
          JOIN anchor_keys ak ON ak.k = pgm.platform_product_id
          WHERE pgm.merchant_id = $2
            AND pgm.platform = $3
            AND pgm.product_group_id IS NOT NULL
        )
        SELECT DISTINCT pgm.platform_product_id AS sibling
        FROM product_group_members pgm
        JOIN groups g ON g.product_group_id = pgm.product_group_id
      `,
      [extKeys, EXTERNAL_SEED_MERCHANT_ID, EXTERNAL_SEED_MERCHANT_ID],
    );
    const seen = new Set(refs.map((r) => String(r).toLowerCase()));
    for (const row of (Array.isArray(res?.rows) ? res.rows : [])) {
      const sibling = normalizeString(row.sibling, 260);
      if (!sibling) continue;
      for (const ref of [`product:${sibling}`, sibling]) {
        if (!seen.has(ref.toLowerCase())) {
          refs.push(ref);
          seen.add(ref.toLowerCase());
        }
      }
    }
  } catch (err) {
    const code = normalizeString(err && err.code, 20);
    // Missing table / no DB → no expansion (graph still serves base refs).
    if (code !== 'NO_DATABASE' && code !== '42P01') throw err;
  }
  return refs;
}

async function getRelationshipGraphCandidatesForAnchor({
  anchor,
  market = DEFAULT_MARKET,
  limit = 120,
  queryFn = query,
} = {}) {
  const baseRefs = buildAnchorRefsFromProduct(anchor);
  const anchorRefs = await expandAnchorRefsWithGroupSiblings(baseRefs, { queryFn });
  const edges = await listApprovedRelationshipEdgesForAnchor({
    anchorType: 'product',
    anchorRefs,
    market,
    limit,
    queryFn,
  });
  const blocks = splitEdgesForRecoBlocks(edges);
  return {
    ...blocks,
    meta: {
      query_attempted: anchorRefs.length ? 1 : 0,
      relationship_graph_edge_count: edges.length,
      attempted_sources: ['product_relationship_edges'],
      reason_counts: edges.length ? { relationship_graph_hit: edges.length } : { relationship_graph_miss: 1 },
    },
  };
}

async function upsertRelationshipEdge(input = {}, { queryFn = query, nowMs = Date.now() } = {}) {
  const validation = validateRelationshipEdge(input, { nowMs });
  if (!validation.ok) {
    const err = new Error(`invalid_product_relationship_edge:${validation.errors.join(',')}`);
    err.code = 'INVALID_PRODUCT_RELATIONSHIP_EDGE';
    err.errors = validation.errors;
    throw err;
  }
  const edge = validation.value;
  await queryFn(
    `
      INSERT INTO product_relationship_edges (
        id, anchor_type, anchor_ref, anchor_snapshot, candidate_product_ref, candidate_snapshot,
        relation_type, display_label, market, vertical, category_taxonomy, use_case,
        score_total, score_breakdown, price_evidence, source_refs, evidence_grade,
        review_status, why_candidate, tradeoffs, watchouts, provenance,
        last_verified_at, expires_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5, $6::jsonb,
        $7, $8, $9, $10, $11::jsonb, $12,
        $13, $14::jsonb, $15::jsonb, $16::jsonb, $17,
        $18, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb,
        $23::timestamptz, $24::timestamptz, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        anchor_type = EXCLUDED.anchor_type,
        anchor_ref = EXCLUDED.anchor_ref,
        anchor_snapshot = EXCLUDED.anchor_snapshot,
        candidate_product_ref = EXCLUDED.candidate_product_ref,
        candidate_snapshot = EXCLUDED.candidate_snapshot,
        relation_type = EXCLUDED.relation_type,
        display_label = EXCLUDED.display_label,
        market = EXCLUDED.market,
        vertical = EXCLUDED.vertical,
        category_taxonomy = EXCLUDED.category_taxonomy,
        use_case = EXCLUDED.use_case,
        score_total = EXCLUDED.score_total,
        score_breakdown = EXCLUDED.score_breakdown,
        price_evidence = EXCLUDED.price_evidence,
        source_refs = EXCLUDED.source_refs,
        evidence_grade = EXCLUDED.evidence_grade,
        review_status = EXCLUDED.review_status,
        why_candidate = EXCLUDED.why_candidate,
        tradeoffs = EXCLUDED.tradeoffs,
        watchouts = EXCLUDED.watchouts,
        provenance = EXCLUDED.provenance,
        last_verified_at = EXCLUDED.last_verified_at,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `,
    [
      edge.id,
      edge.anchor_type,
      edge.anchor_ref,
      normalizeJsonbParam(edge.anchor_snapshot, {}),
      edge.candidate_product_ref,
      normalizeJsonbParam(edge.candidate_snapshot, {}),
      edge.relation_type,
      edge.display_label,
      edge.market,
      edge.vertical,
      normalizeJsonbParam(edge.category_taxonomy, []),
      edge.use_case,
      edge.score_total,
      normalizeJsonbParam(edge.score_breakdown, {}),
      normalizeJsonbParam(edge.price_evidence, {}),
      normalizeJsonbParam(edge.source_refs, []),
      edge.evidence_grade || null,
      edge.review_status,
      normalizeJsonbParam(edge.why_candidate, {}),
      normalizeJsonbParam(edge.tradeoffs, []),
      normalizeJsonbParam(edge.watchouts, []),
      normalizeJsonbParam(edge.provenance, {}),
      edge.last_verified_at,
      edge.expires_at,
    ],
  );
  return edge;
}

const LABEL_STATES = new Set([
  'generated',
  'prefilter_rejected',
  'review_ready',
  'human_approved',
  'human_rejected',
  'needs_evidence',
]);

const REVIEW_STATUS_TO_LABEL_STATE = {
  approved: 'human_approved',
  rejected: 'human_rejected',
  pending: 'needs_evidence',
};

function reviewStatusToLabelState(status) {
  return REVIEW_STATUS_TO_LABEL_STATE[normalizeLower(status, 80)] || '';
}

function extractReasonFlags(humanReview) {
  return collectFlagsFromHumanReview(humanReview, () => true);
}

// Failure flags = flags from reviewer-decision lanes that voted reject.
// Use this for Phase B preflight-gate sizing and Phase D recalibration —
// the broader extractReasonFlags() mixes positive-signal flags (from
// approving lanes on rejected edges) and inflates negative-signal counts.
function extractFailureReasonFlags(humanReview) {
  return collectFlagsFromHumanReview(
    humanReview,
    (decision) => normalizeLower(decision && decision.status, 32) === 'reject',
  );
}

function collectFlagsFromHumanReview(humanReview, lanePredicate) {
  if (!isPlainObject(humanReview)) return [];
  const raw = humanReview.reviewer_decisions || humanReview.reviewerDecisions;
  const decisions = Array.isArray(raw)
    ? raw
    : isPlainObject(raw)
      ? Object.values(raw)
      : [];
  const flags = new Set();
  for (const decision of decisions) {
    if (!isPlainObject(decision)) continue;
    if (!lanePredicate(decision)) continue;
    const list = Array.isArray(decision.flags) ? decision.flags : [];
    for (const item of list) {
      const flag = normalizeLower(item, 160);
      if (flag) flags.add(flag);
    }
  }
  return Array.from(flags).sort();
}

async function upsertRelationshipCandidateLabel(input = {}, { queryFn = query } = {}) {
  const labelState = normalizeLower(input.label_state, 80);
  if (!LABEL_STATES.has(labelState)) {
    const err = new Error(`invalid_label_state:${labelState || 'missing'}`);
    err.code = 'INVALID_LABEL_STATE';
    throw err;
  }

  // human_approved labels must pass the full runtime-edge validation —
  // they are what the view serves to production.
  let edge = null;
  if (labelState === 'human_approved') {
    const validation = validateRelationshipEdge(input, { nowMs: Date.now() });
    if (!validation.ok) {
      const err = new Error(`invalid_product_relationship_edge:${validation.errors.join(',')}`);
      err.code = 'INVALID_PRODUCT_RELATIONSHIP_EDGE';
      err.errors = validation.errors;
      throw err;
    }
    edge = validation.value;
  } else {
    edge = coerceRelationshipEdge(input);
  }

  const anchorType = ANCHOR_TYPES.has(edge.anchor_type) ? edge.anchor_type : 'product';
  const anchorRef = normalizeString(edge.anchor_ref, 260);
  const candidateRef = normalizeString(edge.candidate_product_ref, 260);
  const relationType = RELATION_TYPES.has(edge.relation_type) ? edge.relation_type : null;
  const market = normalizeString(edge.market || DEFAULT_MARKET, 32);
  if (!anchorRef || !candidateRef || !relationType || !market) {
    const err = new Error('label_missing_identity_fields');
    err.code = 'LABEL_MISSING_IDENTITY';
    throw err;
  }

  const id = normalizeString(input.id || edge.id, 160) || buildEdgeId({
    anchor_ref: anchorRef,
    candidate_product_ref: candidateRef,
    relation_type: relationType,
    market,
  });
  const edgeId = normalizeString(input.edge_id || edge.id || id, 160);
  const humanReview = isPlainObject(input.human_review) ? input.human_review : null;
  const reasonFlags = Array.isArray(input.reason_flags) && input.reason_flags.length
    ? input.reason_flags
        .map((flag) => normalizeLower(flag, 160))
        .filter(Boolean)
    : extractReasonFlags(humanReview);

  const prefilterReasons = Array.isArray(input.prefilter_reasons)
    ? input.prefilter_reasons
        .map((reason) => normalizeLower(reason, 240))
        .filter(Boolean)
    : null;

  if (labelState === 'prefilter_rejected' && (!prefilterReasons || prefilterReasons.length === 0)) {
    const err = new Error('missing_prefilter_reasons');
    err.code = 'MISSING_PREFILTER_REASONS';
    throw err;
  }

  await queryFn(
    `
      INSERT INTO relationship_candidate_labels (
        id, edge_id, anchor_type, anchor_ref, anchor_snapshot,
        candidate_product_ref, candidate_snapshot, relation_type,
        display_label, market, vertical, category_taxonomy, use_case,
        label_state, score_total, score_breakdown,
        price_evidence, source_refs, evidence_grade,
        why_candidate, tradeoffs, watchouts,
        human_review, reason_flags, prefilter_reasons, source_report, provenance,
        reviewed_at, last_verified_at, expires_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5::jsonb,
        $6, $7::jsonb, $8,
        $9, $10, $11, $12::jsonb, $13,
        $14, $15, $16::jsonb,
        $17::jsonb, $18::jsonb, $19,
        $20::jsonb, $21::jsonb, $22::jsonb,
        $23::jsonb, $24, $25, $26, $27::jsonb,
        $28::timestamptz, $29::timestamptz, $30::timestamptz, now()
      )
      ON CONFLICT (market, anchor_type, lower(anchor_ref), lower(candidate_product_ref), relation_type)
      DO UPDATE SET
        edge_id = EXCLUDED.edge_id,
        anchor_snapshot = EXCLUDED.anchor_snapshot,
        candidate_snapshot = EXCLUDED.candidate_snapshot,
        display_label = EXCLUDED.display_label,
        vertical = EXCLUDED.vertical,
        category_taxonomy = EXCLUDED.category_taxonomy,
        use_case = EXCLUDED.use_case,
        label_state = EXCLUDED.label_state,
        score_total = EXCLUDED.score_total,
        score_breakdown = EXCLUDED.score_breakdown,
        price_evidence = EXCLUDED.price_evidence,
        source_refs = EXCLUDED.source_refs,
        evidence_grade = EXCLUDED.evidence_grade,
        why_candidate = EXCLUDED.why_candidate,
        tradeoffs = EXCLUDED.tradeoffs,
        watchouts = EXCLUDED.watchouts,
        human_review = EXCLUDED.human_review,
        reason_flags = EXCLUDED.reason_flags,
        prefilter_reasons = EXCLUDED.prefilter_reasons,
        source_report = EXCLUDED.source_report,
        provenance = EXCLUDED.provenance,
        reviewed_at = EXCLUDED.reviewed_at,
        last_verified_at = EXCLUDED.last_verified_at,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `,
    [
      id,
      edgeId,
      anchorType,
      anchorRef,
      normalizeJsonbParam(edge.anchor_snapshot, {}),
      candidateRef,
      normalizeJsonbParam(edge.candidate_snapshot, {}),
      relationType,
      edge.display_label || null,
      market,
      DEFAULT_VERTICAL,
      normalizeJsonbParam(edge.category_taxonomy, []),
      edge.use_case || null,
      labelState,
      Number.isFinite(Number(edge.score_total)) ? Number(edge.score_total) : null,
      normalizeJsonbParam(edge.score_breakdown, {}),
      normalizeJsonbParam(edge.price_evidence, {}),
      normalizeJsonbParam(edge.source_refs, []),
      edge.evidence_grade || null,
      normalizeJsonbParam(edge.why_candidate, {}),
      normalizeJsonbParam(edge.tradeoffs, []),
      normalizeJsonbParam(edge.watchouts, []),
      humanReview ? normalizeJsonbParam(humanReview, {}) : null,
      reasonFlags,
      prefilterReasons,
      normalizeString(input.source_report, 260) || null,
      normalizeJsonbParam(edge.provenance, {}),
      input.reviewed_at || null,
      edge.last_verified_at || null,
      edge.expires_at || null,
    ],
  );
  return { id, edge_id: edgeId, label_state: labelState };
}

module.exports = {
  RELATION_TYPES,
  REVIEW_STATUSES,
  LABEL_STATES,
  PRICE_FRESHNESS_MS,
  coerceRelationshipEdge,
  validateRelationshipEdge,
  isApprovedFreshEdge,
  edgeToRecoCandidate,
  splitEdgesForRecoBlocks,
  relationshipEdgeToSimilarItem,
  stripRelationshipRefPrefix,
  buildAnchorRefsFromProduct,
  expandAnchorRefsWithGroupSiblings,
  listApprovedRelationshipEdgesForAnchor,
  listApprovedRelationshipEdgesForAnchorUncollapsed,
  collapseApprovedRelationshipEdgesToFamilies,
  getRelationshipGraphCandidatesForAnchor,
  upsertRelationshipEdge,
  upsertRelationshipCandidateLabel,
  reviewStatusToLabelState,
  extractReasonFlags,
  extractFailureReasonFlags,
  __internal: {
    extractBrand,
    getPriceRatio,
    getPriceObservedAt,
    normalizeSourceRefs,
    countAuthoritativeSources,
    buildEdgeId,
    isRelationshipGraphFamilyCollapseEnabled,
    RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_FLAG,
    RELATIONSHIP_GRAPH_PG_COLLAPSE_ALIAS_FLAG,
    buildFallbackRelationshipResolution,
    resolveRelationshipEdgeRefContext,
  },
};
