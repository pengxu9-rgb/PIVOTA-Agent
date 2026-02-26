const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveIngredientRecommendation, normalizeMarket } = require('./ingredientKbV2/resolve');
const { renderAllowedTemplate } = require('./claimsTemplates/render');

const DEFAULT_CATALOG_PATH = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'external',
  'products',
  'product_catalog_seed.json',
);

const EVIDENCE_RANK = Object.freeze({
  A: 3,
  B: 2,
  C: 1,
});

const REPAIR_INGREDIENT_IDS = Object.freeze(['ceramide_np', 'panthenol']);

const FRAGILE_RISK_TAGS = new Set(['acid', 'retinoid', 'high_alcohol', 'fragrance', 'strong']);
const PREGNANCY_RISK_TAGS = new Set(['retinoid', 'strong']);
const INGREDIENT_CANONICAL_ALIASES = Object.freeze({
  ceramides: 'ceramide_np',
  niacinamide_low_pct: 'niacinamide',
  bha_gentle: 'salicylic_acid',
  bha_lha: 'salicylic_acid',
  bha: 'salicylic_acid',
  retinoid_later: 'retinol',
  vitamin_c_gentle: 'ascorbic_acid',
  benzoyl_peroxide_spot: 'benzoyl_peroxide',
});

function parseBooleanEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

const PHOTO_ACTION_SOFT_EVIDENCE_GATE_ENABLED = parseBooleanEnv(
  'AURORA_PHOTO_ACTION_SOFT_EVIDENCE_GATE_ENABLED',
  true,
);

const catalogCache = {
  path: '',
  mtimeMs: -1,
  items: [],
};

function normalizeLang(lang) {
  const token = String(lang || '').trim().toLowerCase();
  if (token === 'zh' || token === 'cn' || token === 'zh-cn') return 'zh';
  return 'en';
}

function normalizeRiskTier(riskTier) {
  const token = String(riskTier || '').trim().toLowerCase();
  if (token === 'sensitive' || token === 'barrier_irritated' || token === 'pregnancy_unknown' || token === 'low') {
    return token;
  }
  return 'low';
}

function normalizeIngredientCanonicalId(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return '';
  if (Object.prototype.hasOwnProperty.call(INGREDIENT_CANONICAL_ALIASES, token)) {
    return INGREDIENT_CANONICAL_ALIASES[token];
  }
  return token;
}

function normalizeEvidenceGrade(value, fallback = 'B') {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'A' || token === 'B' || token === 'C') return token;
  return fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function normalizeRetrievalSource(value, fallback = 'catalog') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'catalog' || raw === 'external_seed' || raw === 'llm_fallback') return raw;
  if (raw.includes('external')) return 'external_seed';
  if (raw.includes('llm')) return 'llm_fallback';
  return fallback;
}

function normalizeRetrievalReason(value, retrievalSource) {
  const direct = pickFirstString(value);
  if (direct) return direct;
  const source = normalizeRetrievalSource(retrievalSource, 'catalog');
  if (source === 'external_seed') return 'external_seed_supplement';
  if (source === 'llm_fallback') return 'catalog_empty_or_filtered';
  return 'catalog_search_match';
}

function extractDirectUrl(candidate) {
  return pickFirstString(
    candidate && candidate.pdp_url,
    candidate && candidate.url,
    candidate && candidate.product_url,
    candidate && candidate.purchase_path,
  );
}

function buildCandidateStableKey(candidate) {
  const productId = pickFirstString(candidate && candidate.product_id, candidate && candidate.productId);
  const merchantId = pickFirstString(candidate && candidate.merchant_id, candidate && candidate.merchantId);
  const url = extractDirectUrl(candidate).toLowerCase();
  return `${productId.toLowerCase()}::${merchantId.toLowerCase()}::${url}`;
}

function createSyntheticProductId({ name, url, brand } = {}) {
  const seed = `${String(name || '').trim()}|${String(url || '').trim()}|${String(brand || '').trim()}`;
  return `neutral_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

function toFiniteNumberOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizePriceInfo(raw) {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!node) return { amount: null, currency: '', priceLabel: '' };

  const amount =
    toFiniteNumberOrNull(node.amount) ??
    toFiniteNumberOrNull(node.value) ??
    toFiniteNumberOrNull(node.price) ??
    toFiniteNumberOrNull(node.usd) ??
    toFiniteNumberOrNull(node.cny);
  const currency = pickFirstString(node.currency, node.currency_code, node.currencyCode, node.code).toUpperCase();
  const label = pickFirstString(node.label, node.display, node.display_value);
  return {
    amount,
    currency,
    priceLabel: label,
  };
}

function normalizeSocialProof(raw) {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!node) return null;
  const rating = toFiniteNumberOrNull(node.rating ?? node.rating_value ?? node.score);
  const reviews = toFiniteNumberOrNull(node.review_count ?? node.reviews ?? node.mention_count);
  const summary = pickFirstString(node.summary, node.sentiment, node.label, node.note);
  if (rating == null && reviews == null && !summary) return null;
  return {
    ...(rating != null ? { rating: round3(rating) } : {}),
    ...(reviews != null ? { review_count: Math.max(0, Math.trunc(reviews)) } : {}),
    ...(summary ? { summary } : {}),
  };
}

function normalizeNeutralCandidate(raw, { fallbackSource = 'catalog', fallbackReason = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = pickFirstString(raw.name, raw.title, raw.display_name, raw.displayName);
  const brand = pickFirstString(raw.brand, raw.brand_name, raw.brandName);
  const directUrl = extractDirectUrl(raw);
  const productId =
    pickFirstString(raw.product_id, raw.productId) ||
    createSyntheticProductId({ name, url: directUrl, brand });
  if (!productId || (!name && !directUrl)) return null;

  const retrievalSource = normalizeRetrievalSource(
    pickFirstString(raw.retrieval_source, raw.retrievalSource, raw.source, raw.source_type, fallbackSource),
    fallbackSource,
  );
  const retrievalReason = normalizeRetrievalReason(
    pickFirstString(raw.retrieval_reason, raw.retrievalReason, fallbackReason),
    retrievalSource,
  );
  const parsedPrice = normalizePriceInfo(raw.price);
  const amount =
    parsedPrice.amount ??
    toFiniteNumberOrNull(raw.price_amount) ??
    toFiniteNumberOrNull(raw.priceAmount) ??
    toFiniteNumberOrNull(raw.price_value) ??
    toFiniteNumberOrNull(raw.priceValue) ??
    toFiniteNumberOrNull(raw.price);
  const currency = pickFirstString(
    raw.currency,
    raw.currency_code,
    raw.currencyCode,
    parsedPrice.currency,
  ).toUpperCase();
  const priceLabel = pickFirstString(raw.price_label, raw.priceLabel, parsedPrice.priceLabel);
  const socialProof = normalizeSocialProof(
    raw.social_proof ||
      raw.socialProof ||
      {
        rating: raw.rating_value,
        review_count: raw.review_count,
        summary: pickFirstString(raw.social_summary, raw.socialSummary),
      },
  );
  const benefitTags = asArray(raw.benefit_tags || raw.benefitTags)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const ingredientIds = asArray(raw.ingredient_ids)
    .map((item) => normalizeIngredientCanonicalId(item))
    .filter(Boolean);
  const canonicalRefRaw = (raw.canonical_product_ref && typeof raw.canonical_product_ref === 'object' && !Array.isArray(raw.canonical_product_ref))
    ? raw.canonical_product_ref
    : (raw.canonicalProductRef && typeof raw.canonicalProductRef === 'object' && !Array.isArray(raw.canonicalProductRef))
      ? raw.canonicalProductRef
      : null;
  const canonicalRef = canonicalRefRaw
    ? {
        product_id: pickFirstString(canonicalRefRaw.product_id, canonicalRefRaw.productId),
        merchant_id: pickFirstString(canonicalRefRaw.merchant_id, canonicalRefRaw.merchantId),
      }
    : null;

  return {
    product_id: productId,
    merchant_id: pickFirstString(raw.merchant_id, raw.merchantId),
    name: name || productId,
    brand: brand || null,
    image_url: pickFirstString(raw.image_url, raw.imageUrl, raw.thumbnail_url, raw.thumbnailUrl),
    category: pickFirstString(raw.category, raw.category_name, raw.categoryName, raw.product_type, raw.productType),
    ingredient_ids: ingredientIds,
    risk_tags: asArray(raw.risk_tags).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean),
    benefit_tags: benefitTags,
    usage_note_en: pickFirstString(raw.usage_note_en),
    usage_note_zh: pickFirstString(raw.usage_note_zh),
    cautions_en: asArray(raw.cautions_en).map((item) => String(item || '').trim()).filter(Boolean),
    cautions_zh: asArray(raw.cautions_zh).map((item) => String(item || '').trim()).filter(Boolean),
    ...(amount != null ? { price: round3(amount) } : {}),
    ...(currency ? { currency } : {}),
    ...(priceLabel ? { price_label: priceLabel } : {}),
    ...(socialProof ? { social_proof: socialProof } : {}),
    ...(canonicalRef && canonicalRef.product_id ? { canonical_product_ref: canonicalRef } : {}),
    ...(pickFirstString(raw.product_group_id, raw.productGroupId) ? { product_group_id: pickFirstString(raw.product_group_id, raw.productGroupId) } : {}),
    retrieval_source: retrievalSource,
    retrieval_reason: retrievalReason,
    why_match: pickFirstString(raw.why_match, raw.why, raw.reason),
    direct_url: directUrl,
  };
}

function defaultBuildExternalSearchCta(query, reason = 'strict_filter_all_dropped_fallback') {
  const title = String(query || '').trim() || 'skincare';
  return {
    title,
    url: `https://www.google.com/search?q=${encodeURIComponent(title)}`,
    source: 'fallback',
    reason,
  };
}

function defaultDedupeExternalSearchCtas(ctas, maxItems = 6) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(ctas)) {
    if (!raw || typeof raw !== 'object') continue;
    const title = pickFirstString(raw.title, raw.name, raw.query);
    const url = pickFirstString(raw.url);
    if (!title && !url) continue;
    const key = `${title.toLowerCase()}::${url.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(pickFirstString(raw.source) ? { source: pickFirstString(raw.source).toLowerCase() } : {}),
      ...(pickFirstString(raw.reason) ? { reason: pickFirstString(raw.reason) } : {}),
    });
    if (out.length >= Math.max(1, Math.trunc(Number(maxItems) || 6))) break;
  }
  return out;
}

function normalizeSearchQueries({ ingredientId, ingredientName, issueType, lang }) {
  const queries = [];
  const seen = new Set();
  const push = (value) => {
    const q = String(value || '').trim();
    if (!q) return;
    const key = q.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(q);
  };
  push(ingredientName);
  push(ingredientId);
  if (ingredientName && issueType) push(`${ingredientName} ${issueType} skincare`);
  if (ingredientId && issueType) push(`${ingredientId} ${issueType} skincare`);
  if (queries.length === 0) push(normalizeLang(lang) === 'zh' ? '护肤 成分 推荐' : 'skincare ingredient recommendation');
  return queries.slice(0, 4);
}

function computeSuitabilityScore({
  overlapCount = 0,
  evidenceGrade = 'C',
  citationsCount = 0,
  hasDirectUrl = false,
} = {}) {
  const overlapSignal = overlapCount > 0 ? 1 : 0.58;
  const evidenceSignal = (EVIDENCE_RANK[normalizeEvidenceGrade(evidenceGrade, 'C')] || 1) / 3;
  const citationSignal = clamp01(Number(citationsCount || 0) / 3);
  const urlSignal = hasDirectUrl ? 1 : 0.75;
  return round3((overlapSignal * 0.46) + (evidenceSignal * 0.28) + (citationSignal * 0.16) + (urlSignal * 0.1));
}

function parseCatalogProduct(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const productId = String(raw.product_id || '').trim();
  const name = String(raw.name || '').trim();
  if (!productId || !name) return null;
  const marketScope = asArray(raw.market_scope).map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
  return {
    product_id: productId,
    name,
    brand: String(raw.brand || '').trim() || null,
    market_scope: marketScope.length ? marketScope : ['EU', 'US'],
    ingredient_ids: asArray(raw.ingredient_ids).map((item) => normalizeIngredientCanonicalId(item)).filter(Boolean),
    risk_tags: asArray(raw.risk_tags).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean),
    usage_note_en: String(raw.usage_note_en || '').trim(),
    usage_note_zh: String(raw.usage_note_zh || '').trim(),
    cautions_en: asArray(raw.cautions_en).map((item) => String(item || '').trim()).filter(Boolean),
    cautions_zh: asArray(raw.cautions_zh).map((item) => String(item || '').trim()).filter(Boolean),
  };
}

function loadCatalog(catalogPath) {
  const targetPath = path.resolve(catalogPath || process.env.AURORA_PRODUCT_REC_CATALOG_PATH || DEFAULT_CATALOG_PATH);
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (
    catalogCache.path === targetPath &&
    Number.isFinite(catalogCache.mtimeMs) &&
    catalogCache.mtimeMs === Number(stat.mtimeMs) &&
    Array.isArray(catalogCache.items)
  ) {
    return catalogCache.items;
  }
  const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  const items = asArray(parsed).map(parseCatalogProduct).filter(Boolean);
  catalogCache.path = targetPath;
  catalogCache.mtimeMs = Number(stat.mtimeMs);
  catalogCache.items = items;
  return items;
}

function getTopIssueType(issues) {
  const rows = asArray(issues)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      issue_type: String(item.issue_type || '').trim().toLowerCase(),
      severity: Number(item.severity_0_4) || 0,
    }))
    .filter((item) => item.issue_type);
  if (!rows.length) return 'redness';
  rows.sort((a, b) => b.severity - a.severity);
  return rows[0].issue_type;
}

function getActionIngredientIds(actions) {
  return Array.from(
    new Set(
      asArray(actions)
        .map((item) =>
          normalizeIngredientCanonicalId(
            pickFirstString(
              item && item.ingredient_canonical_id,
              item && item.ingredientCanonicalId,
              item && item.ingredient_id,
              item && item.ingredientId,
            ),
          ),
        )
        .filter(Boolean),
    ),
  );
}

function gradeMeets(actualGrade, minGrade) {
  const actual = EVIDENCE_RANK[normalizeEvidenceGrade(actualGrade, 'C')] || 0;
  const required = EVIDENCE_RANK[normalizeEvidenceGrade(minGrade, 'B')] || 0;
  return actual >= required;
}

function shouldFilterByRisk(product, riskTier) {
  const tags = new Set(asArray(product && product.risk_tags));
  if (riskTier === 'barrier_irritated' || riskTier === 'sensitive') {
    for (const tag of FRAGILE_RISK_TAGS) {
      if (tags.has(tag)) return true;
    }
  }
  if (riskTier === 'pregnancy_unknown') {
    for (const tag of PREGNANCY_RISK_TAGS) {
      if (tags.has(tag)) return true;
    }
  }
  return false;
}

function buildEvidenceByIngredient({
  ingredientIds,
  market,
  riskTier,
  minCitations,
  minEvidenceGrade,
  artifactPath,
  softEvidenceGateEnabled = PHOTO_ACTION_SOFT_EVIDENCE_GATE_ENABLED,
} = {}) {
  const out = new Map();
  const minCitationsN = Number.isFinite(Number(minCitations)) ? Math.max(0, Math.trunc(Number(minCitations))) : 1;
  const minEvidence = normalizeEvidenceGrade(minEvidenceGrade, 'B');
  for (const ingredientId of asArray(ingredientIds)) {
    const normalizedId = normalizeIngredientCanonicalId(ingredientId);
    if (!normalizedId) continue;
    const evidence = resolveIngredientRecommendation({
      ingredientId: normalizedId,
      market,
      riskTier,
      artifactPath,
    });
    const citations = asArray(evidence.citations);
    const citationsCount = citations.length;
    const evidenceGrade = normalizeEvidenceGrade(evidence.evidence_grade, 'C');
    const evidenceGradeScore = (EVIDENCE_RANK[evidenceGrade] || 1) / 3;
    const citationScore = minCitationsN > 0 ? clamp01(citationsCount / Math.max(1, minCitationsN)) : clamp01(citationsCount / 2);
    const minGradeScore = (EVIDENCE_RANK[minEvidence] || 2) / 3;
    const confidencePenalty = evidenceGradeScore >= minGradeScore ? 0 : Math.max(0, minGradeScore - evidenceGradeScore) * 0.2;
    const evidenceScore = round3(Math.max(0, Math.min(1, evidenceGradeScore * 0.65 + citationScore * 0.35 - confidencePenalty)));
    const hardPass = citationsCount >= minCitationsN && gradeMeets(evidenceGrade, minEvidence) && evidenceGrade !== 'C';
    out.set(normalizedId, {
      ingredient_id: normalizedId,
      evidence_grade: evidenceGrade,
      citations,
      citations_count: citationsCount,
      pass: softEvidenceGateEnabled ? true : hardPass,
      evidence_score: evidenceScore,
      do_not_mix: asArray(evidence.do_not_mix),
      safety_flags: asArray(evidence.safety_flags),
    });
  }
  return out;
}

function toCitationIds(citations) {
  return asArray(citations)
    .map((item) => String((item && item.hash) || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function scoreCandidate({ overlapCount, evidenceGrade, citationsCount, evidenceScore = null }) {
  const overlapScore = Number(overlapCount || 0) * 10;
  const evidenceRankScore = (EVIDENCE_RANK[normalizeEvidenceGrade(evidenceGrade, 'C')] || 0) * 20;
  const citationScore = Math.min(12, Number(citationsCount || 0) * 1.5);
  const evidenceSoftBonus = Number.isFinite(Number(evidenceScore)) ? clamp01(Number(evidenceScore)) * 12 : 0;
  return overlapScore + evidenceRankScore + citationScore + evidenceSoftBonus;
}

function buildProductOutput({
  product,
  issueType,
  ingredientId,
  evidence,
  market,
  lang,
  internalTestMode,
  fallbackToGeneric,
} = {}) {
  const ingredientName = String(ingredientId || '').trim() || (normalizeLang(lang) === 'zh' ? '该成分' : 'this ingredient');
  const whyRendered = fallbackToGeneric
    ? renderAllowedTemplate({ templateType: 'generic_safe', issueType, ingredientName, market, lang })
    : renderAllowedTemplate({ templateType: 'product_why_match', issueType, ingredientName, market, lang });
  const howRendered = renderAllowedTemplate({ templateType: 'how_to_use', issueType, ingredientName, market, lang });

  const cautionsSource = normalizeLang(lang) === 'zh' ? product.cautions_zh : product.cautions_en;
  const cautions = Array.from(
    new Set(
      [
        ...asArray(cautionsSource),
        ...asArray(evidence.do_not_mix).map((item) => (normalizeLang(lang) === 'zh' ? `避免同步叠加：${item}` : `Avoid pairing with: ${item}`)),
        ...asArray(evidence.safety_flags).map((item) => (normalizeLang(lang) === 'zh' ? `留意：${item}` : `Watch-out: ${item}`)),
      ].filter(Boolean),
    ),
  ).slice(0, 5);

  const usageNote = normalizeLang(lang) === 'zh' ? product.usage_note_zh : product.usage_note_en;
  const howToUse = usageNote ? `${howRendered.text} ${usageNote}`.slice(0, 240) : howRendered.text;

  const out = {
    product_id: product.product_id,
    name: product.name,
    ...(product.brand ? { brand: product.brand } : {}),
    retrieval_source: 'catalog',
    retrieval_reason: 'catalog_evidence_match',
    why_match: whyRendered.text,
    why_match_template_key: whyRendered.template_key,
    why_match_template_fallback: Boolean(whyRendered.fallback),
    why_match_template_reason: String(whyRendered.reason || 'ok'),
    how_to_use: howToUse,
    cautions,
    evidence: {
      evidence_grade: normalizeEvidenceGrade(evidence.evidence_grade, 'C'),
      citation_ids: toCitationIds(evidence.citations),
      ingredient_id: ingredientId,
    },
  };

  if (internalTestMode) {
    out.internal_debug = {
      market,
      issue_type: issueType,
      template_fallback: whyRendered.fallback,
      why_match_reason: whyRendered.reason,
      citations_count: Number(evidence.citations_count || 0),
      evidence_grade: normalizeEvidenceGrade(evidence.evidence_grade, 'C'),
      citation_ids: toCitationIds(evidence.citations),
    };
  }

  return out;
}

function buildNeutralProductOutput({
  candidate,
  issueType,
  ingredientId,
  ingredientName,
  evidence,
  market,
  lang,
  internalTestMode,
  fallbackToGeneric,
  overlapCount = 0,
} = {}) {
  const directUrl = extractDirectUrl(candidate);
  const base = buildProductOutput({
    product: {
      product_id: candidate.product_id,
      name: candidate.name,
      brand: candidate.brand,
      usage_note_en: candidate.usage_note_en,
      usage_note_zh: candidate.usage_note_zh,
      cautions_en: candidate.cautions_en,
      cautions_zh: candidate.cautions_zh,
    },
    issueType,
    ingredientId: ingredientId || ingredientName,
    evidence,
    market,
    lang,
    internalTestMode,
    fallbackToGeneric,
  });

  const retrievalSource = normalizeRetrievalSource(
    pickFirstString(candidate.retrieval_source, candidate.source),
    'catalog',
  );
  const retrievalReason = normalizeRetrievalReason(candidate.retrieval_reason, retrievalSource);
  const suitabilityScore = computeSuitabilityScore({
    overlapCount,
    evidenceGrade: evidence && evidence.evidence_grade ? evidence.evidence_grade : 'C',
    citationsCount: evidence && evidence.citations_count ? evidence.citations_count : 0,
    hasDirectUrl: Boolean(directUrl),
  });

  const out = {
    ...base,
    retrieval_source: retrievalSource,
    retrieval_reason: retrievalReason,
    suitability_score: suitabilityScore,
    ...(candidate && candidate.merchant_id ? { merchant_id: candidate.merchant_id } : {}),
    ...(candidate && candidate.category ? { category: candidate.category } : {}),
    ...(candidate && candidate.image_url ? { image_url: candidate.image_url } : {}),
    ...(Array.isArray(candidate && candidate.benefit_tags) && candidate.benefit_tags.length ? { benefit_tags: candidate.benefit_tags.slice(0, 8) } : {}),
    ...(Number.isFinite(Number(candidate && candidate.price)) ? { price: round3(Number(candidate.price)) } : {}),
    ...(pickFirstString(candidate && candidate.currency) ? { currency: pickFirstString(candidate.currency).toUpperCase() } : {}),
    ...(pickFirstString(candidate && candidate.price_label) ? { price_label: pickFirstString(candidate.price_label) } : {}),
    ...(candidate && candidate.social_proof && typeof candidate.social_proof === 'object' ? { social_proof: candidate.social_proof } : {}),
    ...(candidate && candidate.product_group_id ? { product_group_id: candidate.product_group_id } : {}),
    ...(candidate && candidate.canonical_product_ref && typeof candidate.canonical_product_ref === 'object'
      ? { canonical_product_ref: candidate.canonical_product_ref }
      : {}),
    ...(directUrl ? { pdp_url: directUrl, url: directUrl, product_url: directUrl, purchase_path: directUrl } : {}),
  };

  if (internalTestMode) {
    out.internal_debug = {
      ...(out.internal_debug || {}),
      overlap_count: Math.max(0, Math.trunc(Number(overlapCount) || 0)),
      has_direct_url: Boolean(directUrl),
      retrieval_source: retrievalSource,
      retrieval_reason: retrievalReason,
      suitability_score: suitabilityScore,
    };
  }

  return out;
}

function buildProductRecommendations({
  moduleId,
  issues,
  actions,
  market,
  lang,
  riskTier,
  qualityGrade,
  minCitations,
  minEvidenceGrade,
  repairOnlyWhenDegraded,
  internalTestMode,
  artifactPath,
  catalogPath,
  softEvidenceGateEnabled = PHOTO_ACTION_SOFT_EVIDENCE_GATE_ENABLED,
} = {}) {
  const normalizedMarket = normalizeMarket(market);
  const normalizedLang = normalizeLang(lang);
  const normalizedRiskTier = normalizeRiskTier(riskTier);
  const minCitationsN = Number.isFinite(Number(minCitations)) ? Math.max(0, Math.trunc(Number(minCitations))) : 1;
  const minEvidence = normalizeEvidenceGrade(minEvidenceGrade, 'B');

  const catalog = loadCatalog(catalogPath);
  if (!catalog.length) {
    return { products: [], suppressed_reason: 'NO_MATCH', debug: { module_id: moduleId, catalog_items: 0 } };
  }

  const issueType = getTopIssueType(issues);
  const actionIngredientIds = getActionIngredientIds(actions);
  const evidenceMapBase = buildEvidenceByIngredient({
    ingredientIds: actionIngredientIds,
    market: normalizedMarket,
    riskTier: normalizedRiskTier,
    minCitations: minCitationsN,
    minEvidenceGrade: minEvidence,
    artifactPath,
    softEvidenceGateEnabled,
  });

  const shouldForceRepairOnly = Boolean(repairOnlyWhenDegraded) && String(qualityGrade || '').trim().toLowerCase() === 'degraded';
  const evidenceIngredientIds = shouldForceRepairOnly
    ? Array.from(new Set([...actionIngredientIds, ...REPAIR_INGREDIENT_IDS]))
    : actionIngredientIds;
  const evidenceMap = shouldForceRepairOnly
    ? buildEvidenceByIngredient({
        ingredientIds: evidenceIngredientIds,
        market: normalizedMarket,
      riskTier: normalizedRiskTier,
      minCitations: minCitationsN,
      minEvidenceGrade: minEvidence,
      artifactPath,
      softEvidenceGateEnabled,
    })
    : evidenceMapBase;
  const eligibleEvidence = Array.from(evidenceMap.values()).filter((item) => item.pass);
  const useRepairFallback = shouldForceRepairOnly;
  const repairEligibleIngredientIds = useRepairFallback
    ? REPAIR_INGREDIENT_IDS.filter((ingredientId) => {
        const evidence = evidenceMap.get(ingredientId);
        if (!evidence) return false;
        return softEvidenceGateEnabled ? true : Boolean(evidence.pass);
      })
    : [];

  if (!softEvidenceGateEnabled && useRepairFallback && !repairEligibleIngredientIds.length) {
    return {
      products: [],
      suppressed_reason: 'LOW_EVIDENCE',
      debug: {
        module_id: moduleId,
        market: normalizedMarket,
        risk_tier: normalizedRiskTier,
        issue_type: issueType,
        ingredient_ids: actionIngredientIds,
        repair_fallback: true,
        repair_eligible_ingredients: [],
        soft_evidence_gate_enabled: false,
      },
    };
  }

  if (!softEvidenceGateEnabled && !eligibleEvidence.length && !useRepairFallback) {
    return {
      products: [],
      suppressed_reason: 'LOW_EVIDENCE',
      debug: {
        module_id: moduleId,
        market: normalizedMarket,
        risk_tier: normalizedRiskTier,
        issue_type: issueType,
        ingredient_ids: actionIngredientIds,
        soft_evidence_gate_enabled: false,
      },
    };
  }

  const candidates = [];
  let filteredByRisk = 0;
  let filteredByMarket = 0;
  let filteredByNoOverlap = 0;
  for (const product of catalog) {
    if (!asArray(product.market_scope).includes(normalizedMarket)) {
      filteredByMarket += 1;
      continue;
    }
    if (shouldFilterByRisk(product, normalizedRiskTier)) {
      filteredByRisk += 1;
      continue;
    }

    const productIngredients = asArray(product.ingredient_ids);
    const overlap = useRepairFallback
      ? productIngredients.filter((id) => repairEligibleIngredientIds.includes(id))
      : productIngredients.filter((id) => evidenceMap.has(id) && (softEvidenceGateEnabled || evidenceMap.get(id).pass));
    if (!overlap.length) {
      filteredByNoOverlap += 1;
      continue;
    }

    const primaryIngredientId = overlap[0];
    const primaryEvidence = evidenceMap.get(primaryIngredientId) || {
      evidence_grade: 'C',
      citations: [],
      citations_count: 0,
      do_not_mix: [],
      safety_flags: [],
    };
    const output = buildProductOutput({
      product,
      issueType,
      ingredientId: primaryIngredientId,
      evidence: primaryEvidence,
      market: normalizedMarket,
      lang: normalizedLang,
      internalTestMode,
      fallbackToGeneric: useRepairFallback,
    });
    candidates.push({
      output,
      score: scoreCandidate({
        overlapCount: overlap.length,
        evidenceGrade: primaryEvidence.evidence_grade,
        citationsCount: primaryEvidence.citations_count,
        evidenceScore: primaryEvidence.evidence_score,
      }),
    });
  }

  if (!candidates.length) {
    const suppressedReason = useRepairFallback
      ? 'DEGRADED'
      : filteredByRisk > 0 && filteredByNoOverlap === 0
        ? 'RISK_TIER'
        : 'NO_MATCH';
    return {
      products: [],
      suppressed_reason: suppressedReason,
      debug: {
        module_id: moduleId,
        market: normalizedMarket,
        risk_tier: normalizedRiskTier,
        issue_type: issueType,
        filtered_by_market: filteredByMarket,
        filtered_by_risk: filteredByRisk,
        filtered_by_no_overlap: filteredByNoOverlap,
        repair_fallback: useRepairFallback,
        soft_evidence_gate_enabled: Boolean(softEvidenceGateEnabled),
      },
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    products: candidates.slice(0, 3).map((item) => item.output),
    suppressed_reason: null,
    debug: {
      module_id: moduleId,
      market: normalizedMarket,
      risk_tier: normalizedRiskTier,
      issue_type: issueType,
      candidate_count: candidates.length,
      repair_fallback: useRepairFallback,
      soft_evidence_gate_enabled: Boolean(softEvidenceGateEnabled),
    },
  };
}

async function buildIngredientProductRecommendationsNeutral({
  moduleId,
  ingredientId,
  ingredientName,
  issueType,
  market,
  lang,
  riskTier,
  qualityGrade,
  minCitations,
  minEvidenceGrade,
  repairOnlyWhenDegraded,
  internalTestMode,
  artifactPath,
  catalogPath,
  maxProducts = 3,
  fallbackCandidateBuilder = null,
  llmFallbackRecoverFn = null,
  externalSearchCtaBuilder = null,
  dedupeExternalSearchCtas = null,
  softEvidenceGateEnabled = PHOTO_ACTION_SOFT_EVIDENCE_GATE_ENABLED,
} = {}) {
  const normalizedIngredientId = normalizeIngredientCanonicalId(ingredientId);
  if (!normalizedIngredientId) {
    return {
      products: [],
      suppressed_reason: 'NO_MATCH',
      products_empty_reason: 'ingredient_id_missing',
      external_search_ctas: [],
      debug: { module_id: moduleId || null, reason: 'ingredient_id_missing' },
    };
  }

  const normalizedIssueType = String(issueType || '').trim().toLowerCase() || 'redness';
  const normalizedMarket = normalizeMarket(market);
  const normalizedLang = normalizeLang(lang);
  const normalizedRiskTier = normalizeRiskTier(riskTier);
  const minCitationsN = Number.isFinite(Number(minCitations)) ? Math.max(0, Math.trunc(Number(minCitations))) : 1;
  const minEvidence = normalizeEvidenceGrade(minEvidenceGrade, 'B');
  const maxProductsN = Math.max(1, Math.min(6, Math.trunc(Number(maxProducts) || 3)));
  const buildCta = typeof externalSearchCtaBuilder === 'function' ? externalSearchCtaBuilder : defaultBuildExternalSearchCta;
  const dedupeCtas = typeof dedupeExternalSearchCtas === 'function' ? dedupeExternalSearchCtas : defaultDedupeExternalSearchCtas;

  const evidenceMap = buildEvidenceByIngredient({
    ingredientIds: [normalizedIngredientId],
    market: normalizedMarket,
    riskTier: normalizedRiskTier,
    minCitations: minCitationsN,
    minEvidenceGrade: minEvidence,
    artifactPath,
    softEvidenceGateEnabled,
  });
  const evidence = evidenceMap.get(normalizedIngredientId) || {
    ingredient_id: normalizedIngredientId,
    evidence_grade: 'C',
    citations: [],
    citations_count: 0,
    pass: false,
    do_not_mix: [],
    safety_flags: [],
  };

  const internalReco = buildProductRecommendations({
    moduleId: moduleId || `ingredient_${normalizedIngredientId}`,
    issues: [{ issue_type: normalizedIssueType, severity_0_4: 2 }],
    actions: [{ ingredient_id: normalizedIngredientId }],
    market: normalizedMarket,
    lang: normalizedLang,
    riskTier: normalizedRiskTier,
    qualityGrade,
    minCitations: minCitationsN,
    minEvidenceGrade: minEvidence,
    repairOnlyWhenDegraded,
    internalTestMode,
    artifactPath,
    catalogPath,
    softEvidenceGateEnabled,
  });

  if (!softEvidenceGateEnabled && !evidence.pass) {
    return {
      products: [],
      suppressed_reason: 'LOW_EVIDENCE',
      products_empty_reason: 'low_evidence',
      external_search_ctas: [],
      debug: {
        module_id: moduleId || null,
        ingredient_id: normalizedIngredientId,
        issue_type: normalizedIssueType,
        candidate_count: 0,
        candidate_count_internal: 0,
        candidate_count_external: 0,
        filtered_by_safety: 0,
        filtered_by_url: 0,
        evidence_score: Number(evidence && evidence.evidence_score || 0),
        evidence_pass: false,
        fallback_stage: 'hard_evidence_gate',
        products_count: 0,
        lookup_queries: normalizeSearchQueries({
          ingredientId: normalizedIngredientId,
          ingredientName,
          issueType: normalizedIssueType,
          lang: normalizedLang,
        }),
        retrieval_source_counts: {},
        soft_evidence_gate_enabled: false,
      },
    };
  }

  const pool = [];
  const seen = new Set();
  const externalSearchCtas = [];
  const sourceCounter = { catalog: 0, external_seed: 0, llm_fallback: 0 };
  let filteredBySafety = 0;
  let filteredByUrl = 0;
  let fallbackStage = 'internal_external_pool';
  const isSearchLikeUrl = (value) => {
    const token = String(value || '').trim().toLowerCase();
    return token.includes('google.com/search') || token.includes('/search?');
  };
  const mergeCandidate = (candidate, { defaultSource = 'catalog', defaultReason = '' } = {}) => {
    const normalized = normalizeNeutralCandidate(candidate, {
      fallbackSource: defaultSource,
      fallbackReason: defaultReason,
    });
    if (!normalized) return;
    if (shouldFilterByRisk(normalized, normalizedRiskTier)) {
      filteredBySafety += 1;
      return;
    }
    const directUrl = extractDirectUrl(normalized);
    const hasInvalidUrl = Boolean(directUrl) && (!String(directUrl).trim().toLowerCase().startsWith('https://') || isSearchLikeUrl(directUrl));
    if (hasInvalidUrl) {
      filteredByUrl += 1;
      return;
    }
    const key = buildCandidateStableKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(normalized);
    const sourceKey = normalizeRetrievalSource(normalized.retrieval_source, 'catalog');
    sourceCounter[sourceKey] = Number(sourceCounter[sourceKey] || 0) + 1;
  };

  for (const product of asArray(internalReco && internalReco.products)) {
    mergeCandidate(product, { defaultSource: 'catalog', defaultReason: 'catalog_evidence_match' });
  }

  const lookupQueries = normalizeSearchQueries({
    ingredientId: normalizedIngredientId,
    ingredientName,
    issueType: normalizedIssueType,
    lang: normalizedLang,
  });

  const fallbackQueries = lookupQueries.slice(0, 1);
  if (typeof fallbackCandidateBuilder === 'function') {
    fallbackStage = 'internal_external_pool';
    for (const query of fallbackQueries) {
      try {
        const fallbackOut = await fallbackCandidateBuilder({
          query,
          limit: maxProductsN * 3,
          allowExternalSeed: true,
        });
        for (const row of asArray(fallbackOut && fallbackOut.products)) {
          mergeCandidate(row, { defaultSource: 'catalog', defaultReason: 'catalog_search_match' });
        }
        for (const cta of asArray(fallbackOut && fallbackOut.external_search_ctas)) {
          externalSearchCtas.push(cta);
        }
      } catch {
        // Non-blocking fallback path by design.
      }
    }
  }

  if (!pool.length && typeof llmFallbackRecoverFn === 'function') {
    fallbackStage = 'llm_fallback';
    try {
      const recovered = await llmFallbackRecoverFn({
        queries: fallbackQueries.length > 0 ? fallbackQueries : lookupQueries.slice(0, 1),
        maxProducts: maxProductsN * 2,
      });
      for (const row of asArray(recovered && recovered.products)) {
        mergeCandidate(row, { defaultSource: 'llm_fallback', defaultReason: 'catalog_empty_or_filtered' });
      }
      for (const cta of asArray(recovered && recovered.external_search_ctas)) {
        externalSearchCtas.push(cta);
      }
    } catch {
      // Non-blocking fallback path by design.
    }
  }

  const fallbackToGeneric = String(qualityGrade || '').trim().toLowerCase() === 'degraded' && repairOnlyWhenDegraded === true;
  const outputs = pool
    .map((candidate) => {
      const overlapCount = asArray(candidate.ingredient_ids).filter((id) => id === normalizedIngredientId).length;
      return buildNeutralProductOutput({
        candidate,
        issueType: normalizedIssueType,
        ingredientId: normalizedIngredientId,
        ingredientName,
        evidence,
        market: normalizedMarket,
        lang: normalizedLang,
        internalTestMode,
        fallbackToGeneric,
        overlapCount,
      });
    })
    .sort((a, b) => {
      const scoreDiff = Number(b && b.suitability_score || 0) - Number(a && a.suitability_score || 0);
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
      const gradeDiff =
        (EVIDENCE_RANK[normalizeEvidenceGrade(b && b.evidence && b.evidence.evidence_grade, 'C')] || 0) -
        (EVIDENCE_RANK[normalizeEvidenceGrade(a && a.evidence && a.evidence.evidence_grade, 'C')] || 0);
      if (gradeDiff !== 0) return gradeDiff;
      const citationDiff =
        asArray(b && b.evidence && b.evidence.citation_ids).length -
        asArray(a && a.evidence && a.evidence.citation_ids).length;
      if (citationDiff !== 0) return citationDiff;
      return String(a && a.name || '').localeCompare(String(b && b.name || ''));
    })
    .slice(0, maxProductsN);

  let dedupedCtas = dedupeCtas(externalSearchCtas, 6);
  if (!outputs.length && !dedupedCtas.length) {
    fallbackStage = fallbackStage === 'llm_fallback' ? 'google_cta_after_llm' : 'google_cta';
    dedupedCtas = dedupeCtas(
      [
        buildCta(
          lookupQueries[0] || ingredientName || normalizedIngredientId,
          'strict_filter_all_dropped_fallback',
        ),
      ],
      6,
    );
  }

  const suppressedReason = outputs.length ? null : 'NO_MATCH';
  const productsEmptyReason = outputs.length
    ? null
    : dedupedCtas.length
      ? 'strict_filter_fallback_only'
      : suppressedReason || 'no_candidate';

  return {
    products: outputs,
    suppressed_reason: suppressedReason,
    products_empty_reason: productsEmptyReason,
    external_search_ctas: dedupedCtas,
    debug: {
      module_id: moduleId || null,
      ingredient_id: normalizedIngredientId,
      issue_type: normalizedIssueType,
      candidate_count: pool.length,
      candidate_count_internal: Number(sourceCounter.catalog || 0),
      candidate_count_external: Number(sourceCounter.external_seed || 0),
      filtered_by_safety: filteredBySafety,
      filtered_by_url: filteredByUrl,
      evidence_score: Number(evidence && evidence.evidence_score || 0),
      fallback_stage: fallbackStage,
      products_count: outputs.length,
      lookup_queries: lookupQueries,
      retrieval_source_counts: outputs.reduce((acc, item) => {
        const key = normalizeRetrievalSource(item && item.retrieval_source, 'catalog');
        acc[key] = Number(acc[key] || 0) + 1;
        return acc;
      }, {}),
      soft_evidence_gate_enabled: Boolean(softEvidenceGateEnabled),
    },
  };
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  normalizeRiskTier,
  normalizeEvidenceGrade,
  loadCatalog,
  buildProductRecommendations,
  buildIngredientProductRecommendationsNeutral,
};
