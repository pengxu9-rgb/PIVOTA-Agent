const { buildSocialSummaryUserVisible } = require('./socialSummaryUserVisible');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function norm01(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return clamp01(n / 100);
  return clamp01(n);
}

function uniqStrings(items) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const token = String(raw == null ? '' : raw).trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return text;
  }
  return '';
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function splitTokens(value) {
  const text = normalizeText(value)
    .replace(/[>/_|]+/g, ' ')
    .replace(/[,:;()[\]{}]+/g, ' ')
    .trim();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

function dedupeTokens(tokens) {
  return Array.from(new Set((Array.isArray(tokens) ? tokens : []).map((x) => normalizeText(x)).filter(Boolean)));
}

function jaccardScore(left, right) {
  const a = new Set(dedupeTokens(left));
  const b = new Set(dedupeTokens(right));
  if (!a.size || !b.size) return null;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter += 1;
  }
  const union = a.size + b.size - inter;
  if (!union) return null;
  return clamp01(inter / union);
}

function extractCategoryTokens(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return dedupeTokens(value.flatMap((item) => extractCategoryTokens(item)));
  if (typeof value === 'string') return dedupeTokens(splitTokens(value));
  if (!isPlainObject(value)) return [];
  return dedupeTokens([
    ...extractCategoryTokens(value.category),
    ...extractCategoryTokens(value.category_name),
    ...extractCategoryTokens(value.categoryName),
    ...extractCategoryTokens(value.category_taxonomy),
    ...extractCategoryTokens(value.categoryTaxonomy),
    ...extractCategoryTokens(value.taxonomy),
    ...extractCategoryTokens(value.taxonomy_path),
    ...extractCategoryTokens(value.taxonomyPath),
    ...extractCategoryTokens(value.use_case),
    ...extractCategoryTokens(value.useCase),
    ...extractCategoryTokens(value.slug),
    ...extractCategoryTokens(value.name),
  ]);
}

function ingredientTokens(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return dedupeTokens(
      value
        .map((v) => String(v == null ? '' : v))
        .flatMap((x) => x.split(/[^a-zA-Z0-9]+/))
        .filter(Boolean),
    );
  }
  if (typeof value === 'string') {
    return dedupeTokens(
      value
        .split(/[^a-zA-Z0-9]+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 3),
    );
  }
  if (!isPlainObject(value)) return [];
  return ingredientTokens([
    ...(Array.isArray(value.ingredient_tokens) ? value.ingredient_tokens : []),
    ...(Array.isArray(value.ingredientTokens) ? value.ingredientTokens : []),
    ...(Array.isArray(value.key_ingredients) ? value.key_ingredients : []),
    ...(Array.isArray(value.keyIngredients) ? value.keyIngredients : []),
    ...(Array.isArray(value.ingredients) ? value.ingredients : []),
  ]);
}

function normalizeSkinTag(value) {
  const token = normalizeText(value);
  if (!token) return '';
  if (token === 'combination') return 'combination';
  if (token === 'combination skin') return 'combination';
  if (token === 'oily') return 'oily';
  if (token === 'dry') return 'dry';
  if (token === 'normal') return 'normal';
  if (token === 'sensitive' || token === 'high sensitivity' || token === 'reactive') return 'sensitive';
  if (token === 'impaired' || token === 'impaired_barrier' || token === 'damaged_barrier') return 'impaired_barrier';
  return token;
}

function extractSkinTags(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return dedupeTokens(value.map((v) => normalizeSkinTag(v)).filter(Boolean));
  if (typeof value === 'string') return extractSkinTags(value.split(/[|,/]+/));
  if (!isPlainObject(value)) return [];
  return dedupeTokens([
    ...extractSkinTags(value.skin_type_tags),
    ...extractSkinTags(value.skinTypeTags),
    ...extractSkinTags(value.suitable_for),
    ...extractSkinTags(value.suitableFor),
    ...extractSkinTags(value.profile_skin_tags),
    ...extractSkinTags(value.profileSkinTags),
    ...extractSkinTags(value.skinType),
    ...extractSkinTags(value.sensitivity),
    ...extractSkinTags(value.barrierStatus),
    ...extractSkinTags(value.goals),
  ]);
}

function extractPrice(priceLike) {
  const direct = toNumber(priceLike);
  if (direct != null && direct > 0) return direct;
  if (!isPlainObject(priceLike)) return null;
  const nested = toNumber(
    priceLike.amount ??
      priceLike.value ??
      priceLike.price ??
      priceLike.sale_price ??
      priceLike.salePrice ??
      priceLike.min ??
      priceLike.min_price ??
      priceLike.minPrice,
  );
  if (nested != null && nested > 0) return nested;
  return null;
}

function normalizeCandidateSource(raw) {
  if (isPlainObject(raw) && typeof raw.type === 'string' && raw.type.trim()) {
    return {
      type: raw.type.trim(),
      ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim() } : {}),
      ...(typeof raw.url === 'string' && raw.url.trim() ? { url: raw.url.trim() } : {}),
    };
  }
  if (typeof raw === 'string' && raw.trim()) return { type: raw.trim() };
  return { type: 'unknown' };
}

function inferPriceBand(rawBand, row) {
  const explicit = normalizeText(rawBand);
  if (['budget', 'mid', 'premium', 'luxury', 'unknown'].includes(explicit)) return explicit;
  const price = extractPrice(row?.price ?? row?.price_value ?? row?.priceValue ?? row?.amount);
  if (price == null) return 'unknown';
  if (price < 20) return 'budget';
  if (price < 55) return 'mid';
  if (price < 110) return 'premium';
  return 'luxury';
}

const SCORE_ALIASES = {
  category_use_case_match: ['category_score', 'category_match', 'categoryUseCaseMatch', 'use_case_match', 'query_overlap_score'],
  ingredient_functional_similarity: ['ingredient_similarity', 'ingredientSimilarity'],
  skin_fit_similarity: ['skinFitSimilarity'],
  social_reference_strength: ['social_reference_score', 'socialReferenceScore'],
  price_distance: ['priceDistance', 'price_similarity', 'priceSimilarity'],
  brand_constraint: ['brand_score', 'brandScore'],
  quality: ['quality_score', 'qualityScore'],
  score_total: ['similarity_score', 'similarityScore', 'scoreTotal'],
  brand_affinity: ['brandAffinity'],
  co_view: ['coView', 'coview', 'co_view_score'],
  kb_routine: ['kbRoutine', 'kb_routine_score'],
};

function readScoreAlias(rawBreakdown, key) {
  if (!isPlainObject(rawBreakdown)) return null;
  if (rawBreakdown[key] != null) return norm01(rawBreakdown[key], null);
  for (const alias of SCORE_ALIASES[key] || []) {
    if (rawBreakdown[alias] != null) return norm01(rawBreakdown[alias], null);
  }
  return null;
}

function normalizeCanonicalScoreBreakdown(raw, { similarityHint = null } = {}) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  const canonical = [
    'category_use_case_match',
    'ingredient_functional_similarity',
    'skin_fit_similarity',
    'social_reference_strength',
    'price_distance',
    'brand_constraint',
    'quality',
    'score_total',
    'brand_affinity',
    'co_view',
    'kb_routine',
  ];
  for (const key of canonical) {
    const v = readScoreAlias(src, key);
    if (v != null) out[key] = v;
  }
  if (out.score_total == null) {
    const hint = norm01(similarityHint, null);
    if (hint != null) out.score_total = hint;
  }
  return out;
}

function sanitizeUserReasonText(text) {
  let next = String(text == null ? '' : text).trim();
  if (!next) return '';
  next = next
    .replace(/\b(?:route_|dedupe_|internal_|fallback_|router\.)[a-z0-9_.-]*/gi, '')
    .replace(/\bref_?id\s*[:=]?\s*[a-z0-9_.-]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!next) return '';
  if (/^[a-z0-9_.-]+$/i.test(next) && /(?:route|dedupe|internal|fallback|code|ref)/i.test(next)) return '';
  return next;
}

function normalizeWhyCandidateObject(raw, { lang = 'EN' } = {}) {
  const fallbackSummary = String(lang || '').toUpperCase() === 'CN'
    ? '基于可用证据与特征匹配生成的候选。'
    : 'Candidate selected from available evidence and feature matching.';

  if (isPlainObject(raw)) {
    const summary = sanitizeUserReasonText(raw.summary) || sanitizeUserReasonText(raw.reason) || fallbackSummary;
    const boundaryUserVisible = sanitizeUserReasonText(raw.boundary_user_visible ?? raw.boundaryUserVisible);
    const reasons = uniqStrings([
      ...(Array.isArray(raw.reasons_user_visible) ? raw.reasons_user_visible : []),
      ...(Array.isArray(raw.reasons) ? raw.reasons : []),
      ...(typeof raw.summary === 'string' ? [raw.summary] : []),
    ]
      .map((x) => sanitizeUserReasonText(x))
      .filter(Boolean)).slice(0, 3);
    return {
      summary,
      reasons_user_visible: reasons.length ? reasons : [fallbackSummary],
      ...(boundaryUserVisible ? { boundary_user_visible: boundaryUserVisible } : {}),
    };
  }

  const legacy = uniqStrings(
    (Array.isArray(raw) ? raw : [raw])
      .map((x) => sanitizeUserReasonText(x))
      .filter(Boolean),
  );
  const summary = legacy[0] || fallbackSummary;
  const reasons = legacy.slice(0, 3);
  return {
    summary,
    reasons_user_visible: reasons.length ? reasons : [fallbackSummary],
  };
}

function buildBoundaryUserVisible(block, lang) {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  if (block === 'related_products') {
    return isCn
      ? '同品牌/同页面关联项仅用于参考，不等同于跨品牌替代。'
      : 'Related products are contextual references and not cross-brand substitutes.';
  }
  if (block === 'dupes') {
    return isCn
      ? '平替偏向预算友好，仍需关注配方差异与耐受性。'
      : 'Dupe suggestions prioritize price-fit; verify formula differences and tolerance.';
  }
  return isCn
    ? '竞品默认跨品牌，用于同品类/功效/价位的横向比较。'
    : 'Competitors are cross-brand by default for side-by-side category/benefit/price comparison.';
}

function sourceQualityByType(sourceType) {
  const token = normalizeText(sourceType);
  if (!token) return 0.55;
  if (token === 'catalog_search') return 0.8;
  if (token === 'kb_backfill') return 0.7;
  if (token === 'ingredient_index') return 0.75;
  if (token === 'dupe_pipeline') return 0.73;
  if (token === 'on_page_related') return 0.52;
  return 0.62;
}

function computePriceDistance(block, anchorPrice, candidatePrice) {
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) return 0.5;
  if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) return 0.4;
  const closeness = clamp01(1 - Math.abs(anchorPrice - candidatePrice) / Math.max(anchorPrice, candidatePrice));
  if (block !== 'dupes') return closeness;
  const cheapness = candidatePrice <= anchorPrice ? 1 : clamp01(anchorPrice / candidatePrice);
  return clamp01(cheapness * 0.7 + closeness * 0.3);
}

function computeSkinFitSimilarity(anchorTags, candidateTags) {
  const a = dedupeTokens(anchorTags.map((x) => normalizeSkinTag(x)).filter(Boolean));
  const b = dedupeTokens(candidateTags.map((x) => normalizeSkinTag(x)).filter(Boolean));
  if (!a.length) return 0.5;
  if (!b.length) return 0.45;
  const overlap = jaccardScore(a, b);
  return overlap == null ? 0.45 : overlap;
}

function computeSocialStrength(candidate) {
  const base = norm01(
    candidate?.social_ref_score ??
      candidate?.socialReferenceScore ??
      candidate?.candidateSocialScore ??
      candidate?.rating_value,
    null,
  );
  const mentionCount = toNumber(
    candidate?.social_stats?.mention_count ??
      candidate?.social_stats?.mentions ??
      candidate?.mention_count ??
      candidate?.review_count,
  );
  const supportBoost = mentionCount && mentionCount > 0
    ? Math.min(0.16, Math.log10(1 + mentionCount) * 0.06)
    : 0;
  if (base == null) return clamp01(0.4 + supportBoost * 0.5);
  return clamp01(base + supportBoost);
}

function ensureEvidenceRefObject(item) {
  if (isPlainObject(item)) return { ...item };
  const text = String(item == null ? '' : item).trim();
  if (!text) return null;
  return { id: text };
}

function buildEvidenceRefs(anchor, candidate, features, { maxEvidenceRefs = 6 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (ref) => {
    const obj = ensureEvidenceRefObject(ref);
    if (!obj) return;
    const key = JSON.stringify({
      id: obj.id || null,
      source_type: obj.source_type || null,
      url: obj.url || null,
      excerpt: obj.excerpt || null,
    });
    if (seen.has(key)) return;
    seen.add(key);
    out.push(obj);
  };

  for (const ref of Array.isArray(candidate?.evidence_refs) ? candidate.evidence_refs : []) push(ref);

  const candidateCategory = pickFirstString(candidate?.category, candidate?.category_taxonomy, candidate?.categoryTaxonomy);
  if (features.category_use_case_match >= 0.45 && candidateCategory) {
    push({ source_type: 'taxonomy', excerpt: `Category/use-case: ${candidateCategory}` });
  }

  const ingredientSignal = Array.isArray(candidate?.key_ingredients)
    ? candidate.key_ingredients
    : Array.isArray(candidate?.ingredient_tokens)
      ? candidate.ingredient_tokens
      : [];
  if (features.ingredient_functional_similarity >= 0.4 && ingredientSignal.length) {
    push({
      source_type: 'ingredient',
      excerpt: `Ingredient overlap: ${ingredientSignal.slice(0, 4).join(', ')}`,
    });
  }

  const anchorPrice = extractPrice(anchor?.price);
  const candidatePrice = extractPrice(candidate?.price);
  if (features.price_distance >= 0.35 && Number.isFinite(anchorPrice) && Number.isFinite(candidatePrice)) {
    push({
      source_type: 'price',
      excerpt: `Price: anchor ${anchorPrice}, candidate ${candidatePrice}`,
    });
  }

  if (features.social_reference_strength >= 0.35) {
    const socialScore = norm01(
      candidate?.social_ref_score ?? candidate?.socialReferenceScore ?? candidate?.candidateSocialScore,
      null,
    );
    if (socialScore != null) {
      push({ source_type: 'social', excerpt: `Social reference strength: ${socialScore.toFixed(2)}` });
    }
  }

  return out.slice(0, Math.max(1, Math.min(10, Number(maxEvidenceRefs) || 6)));
}

function normalizeFeatureBundle(block, anchor, candidate) {
  const rawBreakdown = normalizeCanonicalScoreBreakdown(candidate?.score_breakdown ?? candidate?.scoreBreakdown, {
    similarityHint: candidate?.similarity_score ?? candidate?.similarityScore,
  });

  const anchorCategoryTokens = extractCategoryTokens(
    anchor?.category_taxonomy ?? anchor?.categoryTaxonomy ?? anchor?.category ?? anchor?.use_case ?? anchor?.useCase,
  );
  const candidateCategoryTokens = extractCategoryTokens(
    candidate?.category_taxonomy ?? candidate?.categoryTaxonomy ?? candidate?.category ?? candidate?.use_case ?? candidate?.useCase,
  );

  const categoryUseCaseMatch = rawBreakdown.category_use_case_match != null
    ? rawBreakdown.category_use_case_match
    : jaccardScore(anchorCategoryTokens, candidateCategoryTokens) ?? 0.5;

  const anchorIngredientTokens = ingredientTokens(
    anchor?.ingredient_tokens ?? anchor?.ingredientTokens ?? anchor?.key_ingredients ?? anchor?.keyIngredients,
  );
  const candidateIngredientTokens = ingredientTokens(
    candidate?.ingredient_tokens ?? candidate?.ingredientTokens ?? candidate?.key_ingredients ?? candidate?.keyIngredients,
  );
  const ingredientFunctionalSimilarity = rawBreakdown.ingredient_functional_similarity != null
    ? rawBreakdown.ingredient_functional_similarity
    : jaccardScore(anchorIngredientTokens, candidateIngredientTokens) ?? 0.4;

  const anchorSkinTags = extractSkinTags(
    anchor?.profile_skin_tags ?? anchor?.profileSkinTags ?? anchor?.skin_tags ?? anchor?.profile,
  );
  const candidateSkinTags = extractSkinTags(
    candidate?.skin_type_tags ?? candidate?.skinTypeTags ?? candidate?.suitable_for ?? candidate?.suitableFor,
  );
  const skinFitSimilarity = rawBreakdown.skin_fit_similarity != null
    ? rawBreakdown.skin_fit_similarity
    : computeSkinFitSimilarity(anchorSkinTags, candidateSkinTags);

  const socialReferenceStrength = rawBreakdown.social_reference_strength != null
    ? rawBreakdown.social_reference_strength
    : computeSocialStrength(candidate);

  const anchorPrice = extractPrice(anchor?.price);
  const candidatePrice = extractPrice(candidate?.price);
  const priceDistance = rawBreakdown.price_distance != null
    ? rawBreakdown.price_distance
    : computePriceDistance(block, anchorPrice, candidatePrice);

  const anchorBrand = normalizeText(anchor?.brand_id ?? anchor?.brandId ?? anchor?.brand);
  const candidateBrand = normalizeText(candidate?.brand_id ?? candidate?.brandId ?? candidate?.brand);
  const crossBrand = Boolean(anchorBrand && candidateBrand && anchorBrand !== candidateBrand);
  const brandConstraint = rawBreakdown.brand_constraint != null
    ? rawBreakdown.brand_constraint
    : crossBrand
      ? 1
      : 0;

  const sourceType = pickFirstString(candidate?.source?.type, candidate?.source_type, candidate?.sourceType, 'unknown');
  const sourceQuality = sourceQualityByType(sourceType);
  const evidenceCoverage = clamp01((Array.isArray(candidate?.evidence_refs) ? candidate.evidence_refs.length : 0) / 4);
  const quality = rawBreakdown.quality != null
    ? rawBreakdown.quality
    : clamp01(sourceQuality * 0.6 + evidenceCoverage * 0.4);

  const brandAffinity = rawBreakdown.brand_affinity != null
    ? rawBreakdown.brand_affinity
    : crossBrand
      ? 0.55
      : 1;
  const coView = rawBreakdown.co_view != null
    ? rawBreakdown.co_view
    : norm01(candidate?.co_view_score ?? candidate?.coViewScore, 0.5);
  const kbRoutine = rawBreakdown.kb_routine != null
    ? rawBreakdown.kb_routine
    : norm01(candidate?.kb_routine_score ?? candidate?.kbRoutineScore, 0.5);

  return {
    category_use_case_match: clamp01(categoryUseCaseMatch),
    ingredient_functional_similarity: clamp01(ingredientFunctionalSimilarity),
    skin_fit_similarity: clamp01(skinFitSimilarity),
    social_reference_strength: clamp01(socialReferenceStrength),
    price_distance: clamp01(priceDistance),
    brand_constraint: clamp01(brandConstraint),
    quality: clamp01(quality),
    brand_affinity: clamp01(brandAffinity),
    co_view: clamp01(coView),
    kb_routine: clamp01(kbRoutine),
  };
}

function getScoreWeights(block) {
  if (block === 'dupes') {
    return {
      category_use_case_match: 0.28,
      ingredient_functional_similarity: 0.22,
      skin_fit_similarity: 0.15,
      social_reference_strength: 0.1,
      price_distance: 0.25,
    };
  }
  if (block === 'related_products') {
    return {
      brand_affinity: 0.45,
      co_view: 0.35,
      kb_routine: 0.2,
    };
  }
  return {
    category_use_case_match: 0.3,
    ingredient_functional_similarity: 0.22,
    skin_fit_similarity: 0.18,
    social_reference_strength: 0.15,
    price_distance: 0.1,
    quality: 0.05,
  };
}

function computeTopFeatures(features, weights) {
  const out = [];
  for (const [feature, weight] of Object.entries(weights || {})) {
    const value = clamp01(features[feature] ?? 0);
    const contribution = Number((value * weight).toFixed(6));
    out.push({ feature, value, weight, contribution });
  }
  out.sort((a, b) => {
    if (b.contribution !== a.contribution) return b.contribution - a.contribution;
    return String(a.feature).localeCompare(String(b.feature));
  });
  return out;
}

function buildReasonTemplate(feature, value, block, lang) {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  const high = value >= 0.75;
  const med = value >= 0.5;

  if (feature === 'category_use_case_match') {
    return isCn
      ? (high ? '与目标产品在品类和使用场景上高度一致。' : med ? '与目标产品在品类场景上较为接近。' : '品类场景相关性中等。')
      : (high ? 'Strong category/use-case match with the anchor product.' : med ? 'Good category/use-case alignment with the anchor product.' : 'Moderate category/use-case alignment.');
  }
  if (feature === 'ingredient_functional_similarity') {
    return isCn
      ? (high ? '关键成分功能高度相似。' : med ? '成分功能有较好重合。' : '成分功能相似度中等。')
      : (high ? 'Key ingredient functions are highly similar.' : med ? 'Ingredient functional profile is well aligned.' : 'Ingredient functional similarity is moderate.');
  }
  if (feature === 'skin_fit_similarity') {
    return isCn
      ? (high ? '对当前肤质画像匹配度高。' : med ? '与当前肤质画像较匹配。' : '与当前肤质画像匹配度一般。')
      : (high ? 'High match to the current skin profile.' : med ? 'Good match to the current skin profile.' : 'Moderate match to the current skin profile.');
  }
  if (feature === 'social_reference_strength') {
    return isCn
      ? (high ? '社交/公开反馈信号较强。' : med ? '社交参考信号中等偏上。' : '社交参考信号有限。')
      : (high ? 'Strong social/public reference signal.' : med ? 'Moderately strong social reference signal.' : 'Limited social reference signal.');
  }
  if (feature === 'price_distance') {
    if (block === 'dupes') {
      return isCn
        ? (high ? '价格更友好，替代性更强。' : med ? '价格层级接近并具备替代潜力。' : '价格优势有限。')
        : (high ? 'More budget-friendly with strong dupe potential.' : med ? 'Price is close/cheaper with viable dupe potential.' : 'Price advantage is limited.');
    }
    return isCn
      ? (high ? '价格带与目标产品接近。' : med ? '价格差距可接受。' : '价格差异较大。')
      : (high ? 'Price band is close to the anchor product.' : med ? 'Price distance is acceptable.' : 'Price distance is relatively large.');
  }
  if (feature === 'brand_constraint') {
    return isCn
      ? (high ? '跨品牌候选，便于横向比较。' : '同品牌相关候选，更多用于关联参考。')
      : (high ? 'Cross-brand candidate for direct comparison.' : 'Same-brand relation signal, mainly for related context.');
  }
  if (feature === 'quality') {
    return isCn
      ? (high ? '来源质量与证据覆盖较好。' : '来源质量与证据覆盖中等。')
      : (high ? 'Source quality and evidence coverage are strong.' : 'Source quality and evidence coverage are moderate.');
  }
  if (feature === 'brand_affinity') {
    return isCn
      ? (high ? '品牌关联度高，属于强相关产品。' : '品牌关联度中等。')
      : (high ? 'High brand affinity indicates strong relation.' : 'Moderate brand affinity relation.');
  }
  if (feature === 'co_view') {
    return isCn
      ? (high ? '共现浏览信号较强。' : '共现浏览信号中等。')
      : (high ? 'Strong co-view signal.' : 'Moderate co-view signal.');
  }
  if (feature === 'kb_routine') {
    return isCn
      ? (high ? '在常见护理组合中关联度较高。' : '在常见护理组合中有一定关联。')
      : (high ? 'Strong KB routine association.' : 'Moderate KB routine association.');
  }
  return isCn ? '来自可用证据的综合匹配。' : 'Composite match from available evidence.';
}

function buildSummary(block, candidateName, topFeatures, lang) {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  const name = pickFirstString(candidateName, 'This product');
  const lead = topFeatures[0]?.feature || 'category_use_case_match';
  const second = topFeatures[1]?.feature || '';
  const leadText = buildReasonTemplate(lead, topFeatures[0]?.value || 0, block, lang)
    .replace(/[。.]$/, '');
  const secondText = second
    ? buildReasonTemplate(second, topFeatures[1]?.value || 0, block, lang).replace(/[。.]$/, '')
    : '';

  if (isCn) {
    if (secondText) return `${name} 入选原因：${leadText}，且${secondText}。`;
    return `${name} 入选原因：${leadText}。`;
  }
  if (secondText) return `${name} is selected because ${leadText.toLowerCase()} and ${secondText.toLowerCase()}.`;
  return `${name} is selected because ${leadText.toLowerCase()}.`;
}

function ensureCandidateShape(candidate, lang) {
  const row = isPlainObject(candidate) ? { ...candidate } : {};
  const source = normalizeCandidateSource(row.source ?? row.source_type ?? row.sourceType);
  return {
    ...row,
    source,
    evidence_refs: Array.isArray(row.evidence_refs)
      ? row.evidence_refs.map((x) => ensureEvidenceRefObject(x)).filter(Boolean)
      : [],
    price_band: inferPriceBand(row.price_band ?? row.priceBand, row),
    why_candidate: normalizeWhyCandidateObject(row.why_candidate ?? row.whyCandidate, { lang }),
  };
}

function scoreCandidate(block, anchor, cand, opts = {}) {
  const lang = opts.lang || 'EN';
  const candidate = ensureCandidateShape(cand, lang);
  const features = normalizeFeatureBundle(block, anchor, candidate);
  const weights = getScoreWeights(block);
  const top = computeTopFeatures(features, weights);
  const scoreTotalRaw = top.reduce((sum, row) => sum + row.contribution, 0);
  const scoreTotal = Number(clamp01(scoreTotalRaw).toFixed(3));

  const scoreBreakdown = {
    category_use_case_match: Number(features.category_use_case_match.toFixed(3)),
    ingredient_functional_similarity: Number(features.ingredient_functional_similarity.toFixed(3)),
    skin_fit_similarity: Number(features.skin_fit_similarity.toFixed(3)),
    social_reference_strength: Number(features.social_reference_strength.toFixed(3)),
    price_distance: Number(features.price_distance.toFixed(3)),
    brand_constraint: Number(features.brand_constraint.toFixed(3)),
    ...(block === 'competitors' ? { quality: Number(features.quality.toFixed(3)) } : {}),
    ...(block === 'related_products'
      ? {
        brand_affinity: Number(features.brand_affinity.toFixed(3)),
        co_view: Number(features.co_view.toFixed(3)),
        kb_routine: Number(features.kb_routine.toFixed(3)),
      }
      : {}),
    score_total: scoreTotal,
  };

  const evidenceRefs = buildEvidenceRefs(anchor, candidate, features, {
    maxEvidenceRefs: opts.max_evidence_refs,
  });

  return {
    ...candidate,
    score_breakdown: scoreBreakdown,
    similarity_score: scoreTotal,
    evidence_refs: evidenceRefs,
    _score_meta: {
      top_features: top,
      weights,
    },
  };
}

function attachExplanations(block, anchor, rankedList, opts = {}) {
  const lang = opts.lang || 'EN';
  const scoredRows = (Array.isArray(rankedList) ? rankedList : [])
    .map((row) => scoreCandidate(block, anchor, row, opts))
    .sort((a, b) => {
      const scoreA = Number(a?.score_breakdown?.score_total || 0);
      const scoreB = Number(b?.score_breakdown?.score_total || 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      const socialA = Number(a?.score_breakdown?.social_reference_strength || 0);
      const socialB = Number(b?.score_breakdown?.social_reference_strength || 0);
      if (socialB !== socialA) return socialB - socialA;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    });

  return scoredRows.map((row) => {
    const topFeatures = Array.isArray(row?._score_meta?.top_features)
      ? row._score_meta.top_features.slice(0, 3)
      : [];
    const reasons = topFeatures
      .map((f) => buildReasonTemplate(f.feature, f.value, block, lang))
      .map((x) => sanitizeUserReasonText(x))
      .filter(Boolean)
      .slice(0, 3);

    const whyObject = {
      summary: sanitizeUserReasonText(buildSummary(block, row.name, topFeatures, lang)) || normalizeWhyCandidateObject(null, { lang }).summary,
      reasons_user_visible: reasons.length ? reasons : normalizeWhyCandidateObject(row.why_candidate, { lang }).reasons_user_visible,
      boundary_user_visible:
        sanitizeUserReasonText(
          (isPlainObject(row.why_candidate) && row.why_candidate.boundary_user_visible)
            ? row.why_candidate.boundary_user_visible
            : buildBoundaryUserVisible(block, lang),
        ) || buildBoundaryUserVisible(block, lang),
    };

    const socialSummary = buildSocialSummaryUserVisible(row.social_raw ?? row.socialRaw, { lang });

    const next = {
      ...row,
      why_candidate: whyObject,
      ...(socialSummary ? { social_summary_user_visible: socialSummary } : {}),
    };
    delete next.social_raw;
    delete next.socialRaw;
    if (!socialSummary) delete next.social_summary_user_visible;
    delete next._score_meta;
    return next;
  });
}

module.exports = {
  normalizeCanonicalScoreBreakdown,
  normalizeWhyCandidateObject,
  sanitizeUserReasonText,
  scoreCandidate,
  attachExplanations,
};
