const crypto = require('node:crypto');
const { query } = require('../db');

const RELATION_TYPES = new Set(['dupe', 'competitive_alternative', 'niche_specialist', 'related_product']);
const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired']);
const ANCHOR_TYPES = new Set(['product', 'need']);
const PRICE_FRESHNESS_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MARKET = 'US';
const DEFAULT_VERTICAL = 'beauty';

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
  push(src.url || src.canonical_url || src.canonicalUrl || src.pdp_url || src.pdpUrl, 'url');
  const brand = pickFirstString(src.brand, src.brand_name, src.brandName, src.vendor);
  const name = extractProductName(src);
  if (brand && name) push(`${brand}:${name}`, 'text');
  return refs;
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

async function listApprovedRelationshipEdgesForAnchor({
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
    return (Array.isArray(res?.rows) ? res.rows : []).map(mapRowToEdge).filter(Boolean);
  } catch (err) {
    const code = normalizeString(err && err.code, 20);
    if (code === 'NO_DATABASE' || code === '42P01') return [];
    throw err;
  }
}

async function getRelationshipGraphCandidatesForAnchor({
  anchor,
  market = DEFAULT_MARKET,
  limit = 120,
  queryFn = query,
} = {}) {
  const anchorRefs = buildAnchorRefsFromProduct(anchor);
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

  await queryFn(
    `
      INSERT INTO relationship_candidate_labels (
        id, edge_id, anchor_type, anchor_ref, anchor_snapshot,
        candidate_product_ref, candidate_snapshot, relation_type,
        display_label, market, vertical, category_taxonomy, use_case,
        label_state, score_total, score_breakdown,
        price_evidence, source_refs, evidence_grade,
        why_candidate, tradeoffs, watchouts,
        human_review, reason_flags, source_report, provenance,
        reviewed_at, last_verified_at, expires_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5::jsonb,
        $6, $7::jsonb, $8,
        $9, $10, $11, $12::jsonb, $13,
        $14, $15, $16::jsonb,
        $17::jsonb, $18::jsonb, $19,
        $20::jsonb, $21::jsonb, $22::jsonb,
        $23::jsonb, $24, $25, $26::jsonb,
        $27::timestamptz, $28::timestamptz, $29::timestamptz, now()
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
  buildAnchorRefsFromProduct,
  listApprovedRelationshipEdgesForAnchor,
  getRelationshipGraphCandidatesForAnchor,
  upsertRelationshipEdge,
  upsertRelationshipCandidateLabel,
  reviewStatusToLabelState,
  extractReasonFlags,
  __internal: {
    extractBrand,
    getPriceRatio,
    getPriceObservedAt,
    normalizeSourceRefs,
    countAuthoritativeSources,
    buildEdgeId,
  },
};
