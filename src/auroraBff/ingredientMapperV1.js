const fs = require('node:fs');
const path = require('node:path');

const LOW_CONFIDENCE_THRESHOLD = 0.55;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_PRODUCT_CATALOG_PATH = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'external',
  'products',
  'product_catalog_seed.json',
);
const EXTERNAL_SOURCE_PRIORITY = Object.freeze(['amazon', 'google', 'reddit', 'xiaohongshu']);
const SOURCE_CONFIDENCE = Object.freeze({
  kb: 0.95,
  amazon: 0.78,
  google: 0.62,
  reddit: 0.56,
  xiaohongshu: 0.56,
});

const INGREDIENT_ALIAS_TO_CANONICAL = Object.freeze({
  ceramide: 'ceramide_np',
  ceramides: 'ceramide_np',
  ceramide_np: 'ceramide_np',
  vitamin_b5: 'panthenol',
  b5: 'panthenol',
  panthenol: 'panthenol',
  nicotinamide: 'niacinamide',
  niacinamide: 'niacinamide',
  zinc: 'zinc_pca',
  zinc_pca: 'zinc_pca',
  salicylic: 'salicylic_acid',
  salicylic_acid: 'salicylic_acid',
  bha: 'salicylic_acid',
  azelaic: 'azelaic_acid',
  azelaic_acid: 'azelaic_acid',
  vitamin_c: 'ascorbic_acid',
  ascorbic_acid: 'ascorbic_acid',
  retinol: 'retinol',
  benzoyl_peroxide: 'benzoyl_peroxide',
  bp: 'benzoyl_peroxide',
  sunscreen_filters: 'sunscreen_filters',
  glycerin: 'glycerin',
  hyaluronic_acid: 'hyaluronic_acid',
});

const INGREDIENT_NAME_MAP = Object.freeze({
  ceramide_np: 'Ceramide NP',
  panthenol: 'Panthenol (B5)',
  niacinamide: 'Niacinamide',
  zinc_pca: 'Zinc PCA',
  salicylic_acid: 'Salicylic acid (BHA)',
  azelaic_acid: 'Azelaic acid',
  ascorbic_acid: 'Vitamin C (Ascorbic acid)',
  retinol: 'Retinol',
  benzoyl_peroxide: 'Benzoyl peroxide',
  sunscreen_filters: 'UV filters',
  glycerin: 'Glycerin',
  hyaluronic_acid: 'Hyaluronic acid',
});

const INGREDIENT_PRIORITY_LEVELS = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

const ACTIVE_INGREDIENTS = new Set([
  'retinol',
  'salicylic_acid',
  'ascorbic_acid',
  'benzoyl_peroxide',
  'azelaic_acid',
]);

const STRONG_INGREDIENTS = new Set([
  'retinol',
  'salicylic_acid',
  'benzoyl_peroxide',
]);

const INGREDIENT_USAGE_GUIDANCE = Object.freeze({
  ceramide_np: ['AM/PM as barrier support', 'Prefer moisturizer or barrier serum forms'],
  panthenol: ['AM/PM soothing support', 'Use after cleansing on damp skin'],
  niacinamide: ['Start once daily if sensitive', 'Increase to AM/PM after tolerance'],
  zinc_pca: ['Best for oily zones', 'Keep cleanser gentle to avoid rebound oil'],
  salicylic_acid: ['Start 2-3 nights/week', 'Avoid pairing with retinoid same night'],
  azelaic_acid: ['Start 2-3 nights/week', 'Increase frequency only if comfortable'],
  ascorbic_acid: ['Prefer AM use', 'Always pair with sunscreen'],
  retinol: ['Night only and low frequency first', 'Barrier should be stable before use'],
  benzoyl_peroxide: ['Spot treatment first', 'Reduce if dryness/peeling appears'],
  sunscreen_filters: ['Daily AM final step', 'Reapply when sun exposure is extended'],
  glycerin: ['AM/PM hydration support', 'Layer with moisturizer for better retention'],
  hyaluronic_acid: ['Apply on damp skin', 'Seal with moisturizer'],
});

const RISKY_FOR_FRAGILE = new Set([
  'retinol',
  'salicylic_acid',
  'benzoyl_peroxide',
  'ascorbic_acid',
]);

const INGREDIENT_RULES = Object.freeze([
  {
    rule_id: 'R_BARRIER_001',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 92, role: 'hero' }],
      addConflictMessage: 'Barrier appears fragile, so repair-first strategy is applied.',
    },
  },
  {
    rule_id: 'R_BARRIER_002',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addTargets: [{ ingredient_id: 'panthenol', basePriority: 86, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_BARRIER_003',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addTargets: [{ ingredient_id: 'glycerin', basePriority: 72, role: 'support' }],
    },
  },
  {
    rule_id: 'R_BARRIER_004',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addAvoids: [{ ingredient_id: 'retinol', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_BARRIER_005',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addAvoids: [{ ingredient_id: 'salicylic_acid', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_SENS_001',
    when: { sensitivityIn: ['high'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'panthenol', basePriority: 80, role: 'hero' }],
      addConflictMessage: 'High sensitivity detected; aggressive actives are deprioritized.',
    },
  },
  {
    rule_id: 'R_SENS_002',
    when: { sensitivityIn: ['high'] },
    then: {
      addAvoids: [{ ingredient_id: 'retinol', severity: 'avoid' }],
    },
  },
  {
    rule_id: 'R_SENS_003',
    when: { sensitivityIn: ['high'] },
    then: {
      addAvoids: [{ ingredient_id: 'benzoyl_peroxide', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_SENS_004',
    when: { sensitivityIn: ['high', 'medium'] },
    then: {
      addAvoids: [{ ingredient_id: 'ascorbic_acid', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_SENS_005',
    when: { sensitivityIn: ['medium'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 66, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_001',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      setIntensity: 'active',
      addTargets: [{ ingredient_id: 'salicylic_acid', basePriority: 78, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_ACNE_002',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 70, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_003',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      addTargets: [{ ingredient_id: 'zinc_pca', basePriority: 67, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_004',
    when: { concernsAny: ['acne', 'breakout', 'blemish'], minConfidence: 0.65 },
    then: {
      addTargets: [{ ingredient_id: 'azelaic_acid', basePriority: 64, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_005',
    when: { concernsAny: ['acne', 'breakout', 'blemish'], minConfidence: 0.7 },
    then: {
      addTargets: [{ ingredient_id: 'benzoyl_peroxide', basePriority: 60, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_006',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      addConflictMessage: 'Avoid stacking multiple strong acne actives on the same night.',
    },
  },
  {
    rule_id: 'R_REDNESS_001',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'panthenol', basePriority: 84, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_REDNESS_002',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 76, role: 'support' }],
    },
  },
  {
    rule_id: 'R_REDNESS_003',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      addAvoids: [{ ingredient_id: 'retinol', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_REDNESS_004',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      addAvoids: [{ ingredient_id: 'salicylic_acid', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_001',
    when: { concernsAny: ['texture', 'pores', 'roughness'] },
    then: {
      setIntensity: 'active',
      addTargets: [{ ingredient_id: 'salicylic_acid', basePriority: 73, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_002',
    when: { concernsAny: ['texture', 'pores', 'roughness'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 64, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_003',
    when: { concernsAny: ['texture', 'pores', 'roughness'], minConfidence: 0.7 },
    then: {
      addTargets: [{ ingredient_id: 'retinol', basePriority: 58, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_004',
    when: { concernsAny: ['texture', 'pores', 'roughness'] },
    then: {
      addConflictMessage: 'Keep exfoliating acids and retinoids on separate nights.',
    },
  },
  {
    rule_id: 'R_TONE_001',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'] },
    then: {
      addTargets: [{ ingredient_id: 'ascorbic_acid', basePriority: 71, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_TONE_002',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 69, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TONE_003',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'], minConfidence: 0.7 },
    then: {
      addTargets: [{ ingredient_id: 'azelaic_acid', basePriority: 62, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TONE_004',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'] },
    then: {
      addTargets: [{ ingredient_id: 'sunscreen_filters', basePriority: 95, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_DEHY_001',
    when: { concernsAny: ['dehydration', 'dryness', 'tightness'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'hyaluronic_acid', basePriority: 74, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_DEHY_002',
    when: { concernsAny: ['dehydration', 'dryness', 'tightness'] },
    then: {
      addTargets: [{ ingredient_id: 'glycerin', basePriority: 68, role: 'support' }],
    },
  },
  {
    rule_id: 'R_DEHY_003',
    when: { concernsAny: ['dehydration', 'dryness', 'tightness'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 72, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_001',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'], minConfidence: 0.65 },
    then: {
      setIntensity: 'active',
      addTargets: [{ ingredient_id: 'retinol', basePriority: 70, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_002',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 62, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_003',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'] },
    then: {
      addTargets: [{ ingredient_id: 'sunscreen_filters', basePriority: 95, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_004',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'] },
    then: {
      addConflictMessage: 'If irritation appears, pull back to repair-only for 7-14 days.',
    },
  },
  {
    rule_id: 'R_SKINTYPE_001',
    when: { skinTypeIn: ['oily', 'combination'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 60, role: 'support' }],
    },
  },
  {
    rule_id: 'R_SKINTYPE_002',
    when: { skinTypeIn: ['oily', 'combination'] },
    then: {
      addTargets: [{ ingredient_id: 'zinc_pca', basePriority: 55, role: 'support' }],
    },
  },
  {
    rule_id: 'R_SKINTYPE_003',
    when: { skinTypeIn: ['dry'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 74, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_SKINTYPE_004',
    when: { skinTypeIn: ['dry'] },
    then: {
      addTargets: [{ ingredient_id: 'hyaluronic_acid', basePriority: 66, role: 'support' }],
    },
  },
  {
    rule_id: 'R_GOAL_001',
    when: { concernsAny: ['goal_acne', 'goal_breakout'] },
    then: {
      addTargets: [{ ingredient_id: 'salicylic_acid', basePriority: 60, role: 'support' }],
    },
  },
  {
    rule_id: 'R_GOAL_002',
    when: { concernsAny: ['goal_redness', 'goal_barrier'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 70, role: 'support' }],
    },
  },
  {
    rule_id: 'R_GOAL_003',
    when: { concernsAny: ['goal_dark_spots', 'goal_brightening'] },
    then: {
      addTargets: [{ ingredient_id: 'ascorbic_acid', basePriority: 58, role: 'support' }],
    },
  },
  {
    rule_id: 'R_BASE_001',
    when: { minConfidence: 0 },
    then: {
      addTargets: [{ ingredient_id: 'sunscreen_filters', basePriority: 96, role: 'hero' }],
    },
  },
]);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const productCatalogCache = {
  path: '',
  mtimeMs: -1,
  items: [],
};

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizePriceTier(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  if (token === 'low' || token === 'budget' || token === 'entry') return 'low';
  if (token === 'high' || token === 'premium' || token === 'lux' || token === 'luxury') return 'high';
  if (token === 'mid' || token === 'middle' || token === 'medium') return 'mid';
  return null;
}

function parseNumericPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseRatingValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 5) return null;
  return Math.round(n * 100) / 100;
}

function parseRatingCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(0, Math.trunc(n));
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  return text;
}

function normalizeSource(value) {
  const token = normalizeToken(value);
  if (!token) return 'kb';
  if (token === 'xhs' || token === 'xiaohongshu') return 'xiaohongshu';
  if (token === 'amazon' || token === 'google' || token === 'reddit' || token === 'kb') return token;
  return 'kb';
}

function normalizeQueryKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
}

function resolveCanonicalIngredientId(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  return INGREDIENT_ALIAS_TO_CANONICAL[token] || token;
}

function resolveIngredientName(ingredientId) {
  const canonical = resolveCanonicalIngredientId(ingredientId);
  if (!canonical) return 'Ingredient';
  return INGREDIENT_NAME_MAP[canonical] || canonical.replace(/_/g, ' ');
}

function parseCatalogProduct(raw) {
  const obj = normalizeObject(raw);
  if (!obj) return null;
  const productId = String(obj.product_id || obj.productId || '').trim();
  const name = String(obj.name || obj.title || '').trim();
  if (!productId || !name) return null;
  const ingredientIds = asArray(obj.ingredient_ids || obj.ingredients || obj.ingredientIds)
    .map((value) => resolveCanonicalIngredientId(value))
    .filter(Boolean);
  const explicitTier = normalizePriceTier(
    obj.price_tier || obj.priceTier || obj.price_band || obj.priceBand || obj.budget_tier || obj.budgetTier,
  );
  const price = parseNumericPrice(obj.price || obj.price_usd || obj.priceUsd || obj.amount);
  const currency = String(obj.currency || (obj.price_cny ? 'CNY' : 'USD') || '').trim() || null;
  let priceTier = explicitTier;
  if (!priceTier && price != null) {
    // Fallback bucketing by rough USD-like thresholds.
    if (price < 20) priceTier = 'low';
    else if (price > 60) priceTier = 'high';
    else priceTier = 'mid';
  }
  if (!priceTier) priceTier = 'mid';

  return {
    product_id: productId,
    name,
    brand: String(obj.brand || '').trim() || null,
    ingredient_ids: ingredientIds,
    price,
    currency,
    price_tier: priceTier,
    thumb_url: normalizeUrl(obj.thumb_url || obj.thumbUrl || obj.image_url || obj.imageUrl || obj.image),
    rating_value: parseRatingValue(obj.rating_value || obj.ratingValue || obj.rating),
    rating_count: parseRatingCount(obj.rating_count || obj.ratingCount || obj.review_count || obj.reviewCount),
    pdp_url: normalizeUrl(obj.pdp_url || obj.pdpUrl || obj.url || obj.link),
    source: normalizeSource(obj.source || 'kb'),
    source_confidence:
      parseNumericPrice(obj.source_confidence || obj.sourceConfidence) ??
      SOURCE_CONFIDENCE.kb,
    fallback_type: String(obj.fallback_type || obj.fallbackType || 'catalog').trim().toLowerCase() || 'catalog',
    open_target: String(obj.open_target || obj.openTarget || 'external').trim().toLowerCase() || 'external',
  };
}

function loadProductCatalog(catalogPath) {
  const resolved = path.resolve(catalogPath || process.env.AURORA_PRODUCT_REC_CATALOG_PATH || DEFAULT_PRODUCT_CATALOG_PATH);
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.statSync(resolved);
  if (
    productCatalogCache.path === resolved &&
    Number(productCatalogCache.mtimeMs) === Number(stat.mtimeMs) &&
    Array.isArray(productCatalogCache.items)
  ) {
    return productCatalogCache.items;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    parsed = null;
  }
  const rows = asArray(parsed).map(parseCatalogProduct).filter(Boolean);
  productCatalogCache.path = resolved;
  productCatalogCache.mtimeMs = Number(stat.mtimeMs);
  productCatalogCache.items = rows;
  return rows;
}

function priorityLevelFromScore(score) {
  const s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  if (s >= 75) return INGREDIENT_PRIORITY_LEVELS.HIGH;
  if (s >= 45) return INGREDIENT_PRIORITY_LEVELS.MEDIUM;
  return INGREDIENT_PRIORITY_LEVELS.LOW;
}

function normalizeBudgetTier(value) {
  const token = normalizePriceTier(value);
  return token || 'unknown';
}

function confidenceLevelFromScore(score) {
  const s = clamp01(score);
  if (s < LOW_CONFIDENCE_THRESHOLD) return 'low';
  if (s <= MEDIUM_CONFIDENCE_THRESHOLD) return 'medium';
  return 'high';
}

function normalizeValueNode(node) {
  if (!node) return { value: null, confidence: 0, evidence: [] };
  if (typeof node === 'string') return { value: node, confidence: 0.65, evidence: [] };
  if (typeof node !== 'object' || Array.isArray(node)) return { value: null, confidence: 0, evidence: [] };
  const value = typeof node.value === 'string' ? node.value : null;
  const confidenceObj = node.confidence && typeof node.confidence === 'object' ? node.confidence : null;
  const confidence = confidenceObj ? clamp01(confidenceObj.score) : 0.65;
  const evidence = Array.isArray(node.evidence) ? node.evidence : [];
  return { value, confidence, evidence };
}

function normalizeMultiNode(node) {
  if (!node) return { values: [], confidence: 0, evidence: [] };
  if (Array.isArray(node)) return { values: node.map((v) => normalizeToken(v)).filter(Boolean), confidence: 0.65, evidence: [] };
  if (typeof node !== 'object') return { values: [], confidence: 0, evidence: [] };
  const rawValues = Array.isArray(node.values) ? node.values : [];
  const values = rawValues.map((v) => normalizeToken(v)).filter(Boolean);
  const confidenceObj = node.confidence && typeof node.confidence === 'object' ? node.confidence : null;
  const confidence = confidenceObj ? clamp01(confidenceObj.score) : values.length ? 0.65 : 0;
  const evidence = Array.isArray(node.evidence) ? node.evidence : [];
  return { values, confidence, evidence };
}

function pickConcerns(artifact) {
  const out = [];
  const concerns = asArray(artifact && artifact.concerns);
  for (const item of concerns) {
    if (!item) continue;
    if (typeof item === 'string') {
      const id = normalizeToken(item);
      if (!id) continue;
      out.push({ id, confidence: 0.62, evidence: [] });
      continue;
    }
    if (typeof item !== 'object' || Array.isArray(item)) continue;
    const id = normalizeToken(item.id || item.concern_id || item.value);
    if (!id) continue;
    const confidenceObj = item.confidence && typeof item.confidence === 'object' ? item.confidence : null;
    const confidence = confidenceObj ? clamp01(confidenceObj.score) : 0.62;
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    out.push({ id, confidence, evidence });
  }
  return out;
}

function mapGoalsToConcernTokens(goalValues) {
  const out = [];
  for (const goal of asArray(goalValues)) {
    const token = normalizeToken(goal);
    if (!token) continue;
    out.push(`goal_${token}`);
    if (token.includes('acne')) out.push('acne');
    if (token.includes('red')) out.push('redness');
    if (token.includes('barrier')) out.push('barrier');
    if (token.includes('dark') || token.includes('spot') || token.includes('tone') || token.includes('bright')) out.push('tone');
    if (token.includes('wrinkle') || token.includes('aging') || token.includes('anti_age')) out.push('anti_aging');
  }
  return out;
}

function hasTokenMatch(value, tokens) {
  const base = normalizeToken(value);
  if (!base) return false;
  for (const rawToken of asArray(tokens)) {
    const token = normalizeToken(rawToken);
    if (!token) continue;
    if (base === token) return true;
    if (base.includes(token) || token.includes(base)) return true;
  }
  return false;
}

function computeArtifactOverallConfidence(artifact) {
  const skinType = normalizeValueNode(artifact && artifact.skinType);
  const barrier = normalizeValueNode(artifact && artifact.barrierStatus);
  const sensitivity = normalizeValueNode(artifact && artifact.sensitivity);
  const goals = normalizeMultiNode(artifact && artifact.goals);
  const concerns = pickConcerns(artifact);

  const weighted = [
    { score: skinType.value ? skinType.confidence : 0, weight: 0.25 },
    { score: barrier.value ? barrier.confidence : 0, weight: 0.25 },
    { score: sensitivity.value ? sensitivity.confidence : 0, weight: 0.25 },
    { score: goals.values.length ? goals.confidence : 0, weight: 0.25 },
  ];
  const weightedScore = weighted.reduce((sum, item) => sum + item.score * item.weight, 0);
  const concernBoost =
    concerns.length > 0
      ? Math.min(0.1, concerns.reduce((sum, item) => sum + clamp01(item.confidence), 0) / concerns.length * 0.12)
      : 0;

  let score = clamp01(weightedScore + concernBoost);
  const rationale = [];

  const usePhoto = artifact && artifact.use_photo === true;
  const photos = asArray(artifact && artifact.photos);
  const qcTokens = photos
    .map((item) => normalizeToken(item && item.qc_status))
    .filter(Boolean);
  const hasFailQc = qcTokens.some((token) => token === 'fail' || token === 'failed' || token === 'reject' || token === 'rejected');
  const hasDegradedQc = qcTokens.some((token) => token === 'degraded' || token === 'warn' || token === 'low' || token === 'warning');

  if (hasFailQc) {
    score = Math.min(score, LOW_CONFIDENCE_THRESHOLD - 0.01);
    rationale.push('photo_qc_failed');
  } else if (hasDegradedQc) {
    score = clamp01(score - 0.1);
    rationale.push('photo_qc_degraded');
  }

  if (!usePhoto) {
    score = Math.min(score, MEDIUM_CONFIDENCE_THRESHOLD);
    rationale.push('no_photo_input');
  }

  const analysisSource = normalizeToken(artifact && artifact.analysis_context && artifact.analysis_context.analysis_source);
  if (analysisSource === 'baseline_low_confidence' || analysisSource === 'retake') {
    score = Math.min(score, LOW_CONFIDENCE_THRESHOLD - 0.01);
    rationale.push('low_confidence_fallback');
  }

  const level = confidenceLevelFromScore(score);
  return { score, level, rationale };
}

function collectCurrentRoutineTokens(profile) {
  const routine = profile && profile.currentRoutine !== undefined ? profile.currentRoutine : null;
  if (!routine) return [];
  const text =
    typeof routine === 'string'
      ? routine
      : (() => {
          try {
            return JSON.stringify(routine);
          } catch {
            return '';
          }
        })();
  return normalizeToken(text).split('_').filter(Boolean);
}

function ruleMatches(rule, context) {
  const when = rule && rule.when && typeof rule.when === 'object' ? rule.when : {};
  if (Number.isFinite(Number(when.minConfidence)) && context.overallConfidence.score < Number(when.minConfidence)) return false;
  if (Array.isArray(when.concernsAny) && when.concernsAny.length > 0) {
    const matched = when.concernsAny.some((token) => context.concernTokens.has(normalizeToken(token)));
    if (!matched) return false;
  }
  if (Array.isArray(when.barrierStatusIn) && when.barrierStatusIn.length > 0) {
    if (!hasTokenMatch(context.barrierStatus, when.barrierStatusIn)) return false;
  }
  if (Array.isArray(when.sensitivityIn) && when.sensitivityIn.length > 0) {
    if (!hasTokenMatch(context.sensitivity, when.sensitivityIn)) return false;
  }
  if (Array.isArray(when.skinTypeIn) && when.skinTypeIn.length > 0) {
    if (!hasTokenMatch(context.skinType, when.skinTypeIn)) return false;
  }
  return true;
}

function mergeIntensity(current, incoming) {
  const c = normalizeToken(current);
  const n = normalizeToken(incoming);
  const valid = new Set(['gentle', 'balanced', 'active']);
  const base = valid.has(c) ? c : 'balanced';
  if (!valid.has(n)) return base;
  if (base === 'gentle' || n === 'gentle') return 'gentle';
  if (base === 'active' || n === 'active') return 'active';
  return 'balanced';
}

function buildRuleEvidence(ruleId, supports = []) {
  return {
    source: 'rule',
    supports: Array.isArray(supports) ? supports : [],
    ref: { type: 'rule_id', id: String(ruleId || '').trim() || 'rule_unknown' },
    reliabilityWeight: 0.9,
  };
}

function buildConfidence(score, rationale) {
  const normalized = clamp01(score);
  return {
    score: normalized,
    level: confidenceLevelFromScore(normalized),
    rationale: Array.from(new Set(asArray(rationale).map((r) => String(r || '').trim()).filter(Boolean))).slice(0, 6),
  };
}

function normalizeIngredientGuidance(ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(INGREDIENT_USAGE_GUIDANCE, id)) {
    return INGREDIENT_USAGE_GUIDANCE[id].slice(0, 4);
  }
  return ['Introduce gradually and monitor skin response.'];
}

function buildLowConfidencePlan({ artifact, profile, overallConfidence } = {}) {
  const evidence = [
    buildRuleEvidence('R_LOWCONF_001', ['overall_confidence']),
    { source: 'profile', supports: ['goals', 'sensitivity'], reliabilityWeight: 0.6 },
  ];
  const targets = [
    { ingredient_id: 'ceramide_np', role: 'hero', priority: 90 },
    { ingredient_id: 'panthenol', role: 'hero', priority: 86 },
    { ingredient_id: 'sunscreen_filters', role: 'hero', priority: 95 },
  ].map((item) => ({
    ...item,
    ingredient_name: resolveIngredientName(item.ingredient_id),
    usage_guidance: normalizeIngredientGuidance(item.ingredient_id),
    confidence: buildConfidence(Math.min(0.72, overallConfidence.score + 0.12), ['low_confidence_gentle_only']),
    evidence,
  }));

  const avoid = ['retinol', 'salicylic_acid', 'benzoyl_peroxide'].map((ingredientId) => ({
    ingredient_id: ingredientId,
    ingredient_name: resolveIngredientName(ingredientId),
    reason: ['Low-confidence mode: avoid high-irritation actives until better evidence is available.'],
    severity: 'avoid',
    confidence: buildConfidence(0.82, ['low_confidence_safety_guard']),
    evidence: [buildRuleEvidence('R_LOWCONF_002', ['avoid'])],
  }));

  return {
    created_at: new Date().toISOString(),
    intensity: 'gentle',
    targets,
    avoid,
    conflicts: [
      {
        id: 'low_confidence_guard',
        description: 'Because confidence is low, this plan stays on repair + hydration + sunscreen.',
        evidence: [buildRuleEvidence('R_LOWCONF_003', ['conflicts'])],
      },
    ],
  };
}

function buildIngredientPlan({ artifact, profile } = {}) {
  const overallConfidence = computeArtifactOverallConfidence(artifact || {});
  if (overallConfidence.level === 'low') {
    return {
      ...buildLowConfidencePlan({ artifact, profile, overallConfidence }),
      confidence: buildConfidence(overallConfidence.score, overallConfidence.rationale),
    };
  }

  const skinTypeNode = normalizeValueNode(artifact && artifact.skinType);
  const barrierNode = normalizeValueNode(artifact && artifact.barrierStatus);
  const sensitivityNode = normalizeValueNode(artifact && artifact.sensitivity);
  const goalsNode = normalizeMultiNode(artifact && artifact.goals);
  const concernItems = pickConcerns(artifact);
  const concernTokens = new Set(concernItems.map((item) => item.id));
  for (const goalToken of mapGoalsToConcernTokens(goalsNode.values)) concernTokens.add(goalToken);

  const context = {
    skinType: skinTypeNode.value,
    barrierStatus: barrierNode.value,
    sensitivity: sensitivityNode.value,
    concernTokens,
    overallConfidence,
  };

  const currentRoutineTokens = collectCurrentRoutineTokens(profile);
  const barrierFragile = hasTokenMatch(barrierNode.value, ['impaired', 'compromised', 'damaged', 'weak']);
  const sensitivityHigh = hasTokenMatch(sensitivityNode.value, ['high']);

  const targetMap = new Map();
  const avoidMap = new Map();
  const conflicts = [];
  let intensity = 'balanced';

  for (const rule of INGREDIENT_RULES) {
    if (!ruleMatches(rule, context)) continue;
    const then = rule.then && typeof rule.then === 'object' ? rule.then : {};
    intensity = mergeIntensity(intensity, then.setIntensity);

    for (const target of asArray(then.addTargets)) {
      const ingredientId = normalizeToken(target && target.ingredient_id);
      if (!ingredientId) continue;
      const basePriority = Math.max(1, Math.min(100, Number(target.basePriority || 50)));
      const role = String(target && target.role || 'support') === 'hero' ? 'hero' : 'support';
      const current = targetMap.get(ingredientId) || {
        ingredient_id: ingredientId,
        role,
        basePriority: 0,
        rationale: [],
        evidence: [],
      };
      current.role = current.role === 'hero' || role === 'hero' ? 'hero' : 'support';
      current.basePriority = Math.max(current.basePriority, basePriority);
      current.rationale.push(rule.rule_id);
      current.evidence.push(buildRuleEvidence(rule.rule_id, ['ingredient_targets']));
      targetMap.set(ingredientId, current);
    }

    for (const avoid of asArray(then.addAvoids)) {
      const ingredientId = normalizeToken(avoid && avoid.ingredient_id);
      if (!ingredientId) continue;
      const severity = String(avoid && avoid.severity || 'caution').toLowerCase() === 'avoid' ? 'avoid' : 'caution';
      const current = avoidMap.get(ingredientId) || {
        ingredient_id: ingredientId,
        reason: [],
        severity,
        evidence: [],
      };
      current.severity = current.severity === 'avoid' || severity === 'avoid' ? 'avoid' : 'caution';
      current.reason.push(`Triggered by ${rule.rule_id}`);
      current.evidence.push(buildRuleEvidence(rule.rule_id, ['ingredient_avoid']));
      avoidMap.set(ingredientId, current);
    }

    if (typeof then.addConflictMessage === 'string' && then.addConflictMessage.trim()) {
      conflicts.push({
        id: rule.rule_id,
        description: then.addConflictMessage.trim(),
        evidence: [buildRuleEvidence(rule.rule_id, ['conflicts'])],
      });
    }
  }

  const targets = Array.from(targetMap.values())
    .map((target) => {
      const ingredientId = target.ingredient_id;
      const base = Number(target.basePriority || 0);
      let barrierMult = 1;
      let sensitivityMult = 1;
      let routineMult = 1;
      if (barrierFragile && RISKY_FOR_FRAGILE.has(ingredientId)) barrierMult = 0.55;
      if (sensitivityHigh && STRONG_INGREDIENTS.has(ingredientId)) sensitivityMult = 0.5;
      if (currentRoutineTokens.some((token) => token.includes(ingredientId))) routineMult = 0.85;

      const computedPriority = Math.max(
        5,
        Math.min(
          100,
          Math.round(base * clamp01(overallConfidence.score || 0.6) * barrierMult * sensitivityMult * routineMult),
        ),
      );
      return {
        ingredient_id: ingredientId,
        ingredient_name: resolveIngredientName(ingredientId),
        role: target.role,
        priority: computedPriority,
        usage_guidance: normalizeIngredientGuidance(ingredientId),
        confidence: buildConfidence(Math.min(0.95, overallConfidence.score * 0.9 + 0.08), target.rationale),
        evidence: target.evidence.slice(0, 8),
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 10);

  const avoid = Array.from(avoidMap.values())
    .map((item) => ({
      ingredient_id: item.ingredient_id,
      ingredient_name: resolveIngredientName(item.ingredient_id),
      reason: Array.from(new Set(item.reason.map((raw) => String(raw || '').trim()).filter(Boolean))).slice(0, 4),
      severity: item.severity,
      confidence: buildConfidence(Math.min(0.95, overallConfidence.score * 0.85 + 0.1), ['rule_based_avoid']),
      evidence: item.evidence.slice(0, 8),
    }))
    .slice(0, 10);

  if (barrierFragile || sensitivityHigh) intensity = 'gentle';
  if (overallConfidence.level === 'medium' && intensity === 'active') intensity = 'balanced';

  return {
    created_at: new Date().toISOString(),
    intensity,
    targets,
    avoid,
    conflicts: conflicts.slice(0, 8),
    confidence: buildConfidence(overallConfidence.score, overallConfidence.rationale),
  };
}

function mapIntensityV2(intensityToken) {
  const level = (() => {
    const token = normalizeToken(intensityToken);
    if (token === 'gentle' || token === 'balanced' || token === 'active') return token;
    return 'balanced';
  })();
  if (level === 'gentle') {
    return {
      level,
      label: 'Gentle',
      explanation: 'Barrier-first, lower-irritation progression.',
    };
  }
  if (level === 'active') {
    return {
      level,
      label: 'Active',
      explanation: 'Targeted actives with tighter tolerance monitoring.',
    };
  }
  return {
    level: 'balanced',
    label: 'Balanced',
    explanation: 'Moderate treatment intensity with repair support.',
  };
}

function dedupeTargetsByCanonicalId(targets) {
  const map = new Map();
  for (const raw of asArray(targets)) {
    const obj = normalizeObject(raw);
    if (!obj) continue;
    const canonicalId = resolveCanonicalIngredientId(obj.ingredient_id || obj.ingredientId);
    if (!canonicalId) continue;
    const current = map.get(canonicalId);
    const score = Math.max(0, Math.min(100, Math.round(Number(obj.priority || obj.priority_score_0_100 || 0))));
    const next = {
      ingredient_id: canonicalId,
      priority_score_0_100: score,
      role: String(obj.role || '').toLowerCase() === 'hero' ? 'hero' : 'support',
      usage_guidance: asArray(obj.usage_guidance).map((entry) => String(entry || '').trim()).filter(Boolean),
      rationale: asArray(obj?.confidence?.rationale).map((entry) => String(entry || '').trim()).filter(Boolean),
      confidence_score: Number(obj?.confidence?.score),
    };
    if (!current || next.priority_score_0_100 > current.priority_score_0_100) {
      map.set(canonicalId, next);
    } else if (current && next.usage_guidance.length) {
      const merged = Array.from(new Set([...current.usage_guidance, ...next.usage_guidance])).slice(0, 6);
      current.usage_guidance = merged;
      current.rationale = Array.from(new Set([...current.rationale, ...next.rationale])).slice(0, 6);
      map.set(canonicalId, current);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.priority_score_0_100 - a.priority_score_0_100);
}

function normalizeAvoidByCanonicalId(avoidItems) {
  const map = new Map();
  for (const raw of asArray(avoidItems)) {
    const obj = normalizeObject(raw);
    if (!obj) continue;
    const canonicalId = resolveCanonicalIngredientId(obj.ingredient_id || obj.ingredientId);
    if (!canonicalId) continue;
    const severity = String(obj.severity || 'caution').trim().toLowerCase() === 'avoid' ? 'avoid' : 'caution';
    const existing = map.get(canonicalId);
    const reasons = asArray(obj.reason).map((entry) => String(entry || '').trim()).filter(Boolean);
    if (!existing) {
      map.set(canonicalId, {
        ingredient_id: canonicalId,
        severity,
        reason: reasons,
      });
      continue;
    }
    existing.severity = existing.severity === 'avoid' || severity === 'avoid' ? 'avoid' : 'caution';
    existing.reason = Array.from(new Set([...existing.reason, ...reasons])).slice(0, 6);
    map.set(canonicalId, existing);
  }
  return map;
}

function scoreCatalogCandidateForIngredient(candidate, ingredientId, budgetTier) {
  const containsIngredient = new Set(asArray(candidate.ingredient_ids)).has(ingredientId);
  if (!containsIngredient) return -1;
  let score = 1;
  if (budgetTier !== 'unknown') {
    if (candidate.price_tier === budgetTier) score += 0.25;
    else score -= 0.05;
  }
  if (candidate.brand) score += 0.05;
  if (candidate.price != null) score += 0.03;
  return score;
}

function buildExternalSearchUrl(source, queryText) {
  const q = String(queryText || '').trim();
  if (!q) return null;
  const encoded = encodeURIComponent(q);
  if (source === 'amazon') return `https://www.amazon.com/s?k=${encoded}`;
  if (source === 'reddit') return `https://www.reddit.com/search/?q=${encoded}`;
  if (source === 'xiaohongshu') return `https://www.xiaohongshu.com/search_result?keyword=${encoded}`;
  if (source === 'google') return `https://www.google.com/search?q=${encoded}`;
  return null;
}

function buildExternalFallbackCandidates({ ingredientId, ingredientName, budgetTier }) {
  const id = resolveCanonicalIngredientId(ingredientId) || normalizeToken(ingredientId) || 'ingredient';
  const readableName = String(ingredientName || resolveIngredientName(id)).trim() || 'Ingredient';
  const budgetHint =
    budgetTier && budgetTier !== 'unknown'
      ? budgetTier === 'low'
        ? 'budget'
        : budgetTier === 'high'
          ? 'premium'
          : 'mid-range'
      : 'best';
  const query = `${readableName} skincare product ${budgetHint}`;
  const fallbackTiers = budgetTier === 'unknown'
    ? ['mid', 'high', 'low', 'low']
    : [budgetTier, budgetTier, 'low', 'mid'];
  const hosts = {
    amazon: 'amazon.com',
    google: 'google.com',
    reddit: 'reddit.com',
    xiaohongshu: 'xiaohongshu.com',
  };
  const labels = {
    amazon: 'Amazon',
    google: 'Google',
    reddit: 'Reddit',
    xiaohongshu: 'Xiaohongshu',
  };

  const out = [];
  for (let idx = 0; idx < EXTERNAL_SOURCE_PRIORITY.length; idx += 1) {
    const source = EXTERNAL_SOURCE_PRIORITY[idx];
    const pdpUrl = buildExternalSearchUrl(source, query);
    if (!pdpUrl) continue;
    const priceTier = fallbackTiers[idx] || fallbackTiers[fallbackTiers.length - 1] || 'mid';
    out.push({
      product_id: `ext_${source}_${id}`,
      name: `${labels[source]}: ${readableName}`,
      brand: labels[source],
      price: null,
      currency: null,
      price_tier: normalizeBudgetTier(priceTier),
      why_match: `Fallback search candidate for ${readableName}.`,
      source_block: idx === 2 ? 'dupe' : 'competitor',
      thumb_url: `https://www.google.com/s2/favicons?domain=${hosts[source]}&sz=64`,
      rating_value: null,
      rating_count: null,
      pdp_url: pdpUrl,
      source,
      source_confidence: SOURCE_CONFIDENCE[source] || 0.5,
      fallback_type: 'search',
      open_target: 'external',
    });
  }
  return {
    query,
    normalized_query: normalizeQueryKey(query),
    candidates: out,
  };
}

function normalizeExternalExecutorCandidate(rawCandidate, {
  idx = 0,
  ingredientId,
  ingredientLabel,
  budgetTier,
} = {}) {
  const candidate = normalizeObject(rawCandidate);
  if (!candidate) return null;

  const source = normalizeSource(candidate.source || candidate.source_type || candidate.sourceType || 'google');
  const candidateName = String(candidate.name || candidate.title || '').trim();
  const fallbackName = `${source.toUpperCase()} · ${ingredientLabel || resolveIngredientName(ingredientId)}`;
  const name = candidateName || fallbackName;
  const productId = String(candidate.product_id || candidate.productId || '').trim() ||
    `ext_exec_${source}_${normalizeToken(ingredientId)}_${idx + 1}`;
  if (!productId || !name) return null;

  let price = parseNumericPrice(
    candidate.price ??
    candidate.price_amount ??
    candidate.priceAmount ??
    candidate.amount ??
    candidate.price_usd ??
    candidate.priceUsd,
  );
  const currency = String(candidate.currency || '').trim() || null;
  const ratingValue = parseRatingValue(candidate.rating_value ?? candidate.ratingValue ?? candidate.rating);
  const ratingCount = parseRatingCount(
    candidate.rating_count ??
    candidate.ratingCount ??
    candidate.review_count ??
    candidate.reviewCount,
  );
  let priceTier = normalizePriceTier(
    candidate.price_tier ||
    candidate.priceTier ||
    candidate.price_band ||
    candidate.priceBand,
  );
  if (!priceTier && price != null) {
    if (price < 20) priceTier = 'low';
    else if (price > 60) priceTier = 'high';
    else priceTier = 'mid';
  }
  if (!priceTier) priceTier = budgetTier === 'unknown' ? 'mid' : normalizeBudgetTier(budgetTier);

  const sourceConfidence =
    parseNumericPrice(candidate.source_confidence || candidate.sourceConfidence) ??
    SOURCE_CONFIDENCE[source] ??
    SOURCE_CONFIDENCE.google;

  return {
    product_id: productId,
    name,
    brand: String(candidate.brand || '').trim() || null,
    ...(price != null ? { price } : {}),
    ...(currency ? { currency } : {}),
    price_tier: priceTier,
    why_match: String(candidate.why_match || candidate.whyMatch || '').trim() ||
      `Realtime external executor candidate from ${source}.`,
    source_block: String(candidate.source_block || candidate.sourceBlock || '').trim() || 'competitor',
    ...(normalizeUrl(candidate.thumb_url || candidate.thumbUrl || candidate.image_url || candidate.imageUrl)
      ? { thumb_url: normalizeUrl(candidate.thumb_url || candidate.thumbUrl || candidate.image_url || candidate.imageUrl) }
      : {}),
    ...(ratingValue != null ? { rating_value: ratingValue } : {}),
    ...(ratingCount != null ? { rating_count: ratingCount } : {}),
    ...(normalizeUrl(candidate.pdp_url || candidate.pdpUrl || candidate.url || candidate.link)
      ? { pdp_url: normalizeUrl(candidate.pdp_url || candidate.pdpUrl || candidate.url || candidate.link) }
      : {}),
    source,
    source_confidence: sourceConfidence,
    fallback_type: String(candidate.fallback_type || candidate.fallbackType || 'external').trim().toLowerCase() || 'external',
    open_target: String(candidate.open_target || candidate.openTarget || 'external').trim().toLowerCase() || 'external',
    __executor: true,
  };
}

function resolveExternalInputForIngredient(mapLike, ingredientId) {
  const mapObj = normalizeObject(mapLike);
  if (!mapObj) return null;
  const canonicalId = resolveCanonicalIngredientId(ingredientId);
  const keys = Array.from(new Set(
    [
      canonicalId,
      normalizeToken(canonicalId),
      ingredientId,
      normalizeToken(ingredientId),
    ].filter(Boolean),
  ));
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(mapObj, key)) continue;
    return mapObj[key];
  }
  return null;
}

function selectIngredientProducts({
  ingredientId,
  budgetTier,
  catalogRows,
  maxCompetitors = 2,
  maxDupes = 1,
  externalCandidates = null,
  externalMeta = null,
}) {
  const candidates = asArray(catalogRows)
    .map((row) => normalizeObject(row))
    .filter(Boolean)
    .map((row) => ({
      product: row,
      score: scoreCatalogCandidateForIngredient(row, ingredientId, budgetTier),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  const unique = [];
  const seen = new Set();
  for (const entry of candidates) {
    const productId = String(entry.product.product_id || '').trim();
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    unique.push(entry.product);
  }

  const toProductView = (product, sourceBlock, reasonText) => ({
    product_id: String(product.product_id || ''),
    name: String(product.name || ''),
    brand: String(product.brand || ''),
    ...(product.price != null ? { price: Number(product.price) } : {}),
    ...(product.currency ? { currency: String(product.currency) } : {}),
    price_tier: normalizeBudgetTier(product.price_tier),
    why_match: reasonText,
    source_block: sourceBlock,
    ...(normalizeUrl(product.thumb_url) ? { thumb_url: normalizeUrl(product.thumb_url) } : {}),
    ...(parseRatingValue(product.rating_value) != null ? { rating_value: parseRatingValue(product.rating_value) } : {}),
    ...(parseRatingCount(product.rating_count) != null ? { rating_count: parseRatingCount(product.rating_count) } : {}),
    ...(normalizeUrl(product.pdp_url) ? { pdp_url: normalizeUrl(product.pdp_url) } : {}),
    source: normalizeSource(product.source || 'kb'),
    source_confidence:
      parseNumericPrice(product.source_confidence) ??
      SOURCE_CONFIDENCE[normalizeSource(product.source || 'kb')] ??
      SOURCE_CONFIDENCE.kb,
    fallback_type: String(product.fallback_type || 'catalog').trim().toLowerCase() || 'catalog',
    open_target: String(product.open_target || 'external').trim().toLowerCase() || 'external',
  });

  const ingredientLabel = resolveIngredientName(ingredientId);
  const fallbackPack = buildExternalFallbackCandidates({
    ingredientId,
    ingredientName: ingredientLabel,
    budgetTier,
  });
  const externalExecutorCandidates = asArray(externalCandidates)
    .map((candidate, idx) =>
      normalizeExternalExecutorCandidate(candidate, {
        idx,
        ingredientId,
        ingredientLabel,
        budgetTier,
      }))
    .filter(Boolean);
  const fallbackCandidates = Array.isArray(fallbackPack.candidates) ? fallbackPack.candidates : [];
  const fallbackCandidateRows = [];
  const seenFallback = new Set();
  const pushFallback = (candidate) => {
    const row = normalizeObject(candidate);
    if (!row) return;
    const key = String(row.product_id || row.pdp_url || '').trim().toLowerCase();
    if (!key || seenFallback.has(key)) return;
    seenFallback.add(key);
    fallbackCandidateRows.push(row);
  };
  for (const row of externalExecutorCandidates) pushFallback(row);
  for (const row of fallbackCandidates) pushFallback(row);
  const fallbackGoogleUrl =
    normalizeUrl(
      fallbackCandidates.find((candidate) => normalizeSource(candidate.source) === 'google')?.pdp_url,
    ) || normalizeUrl(buildExternalSearchUrl('google', `${ingredientLabel} skincare product`));
  const fallbackPrimaryUrl =
    normalizeUrl(fallbackCandidateRows[0]?.pdp_url) ||
    fallbackGoogleUrl ||
    null;
  const localCatalogMissing = unique.length === 0;
  const localCatalogInsufficient = unique.length < Math.max(1, maxCompetitors + maxDupes);

  if (!unique.length && !fallbackCandidates.length) {
    return {
      competitors: [],
      dupes: [],
      external_fallback_used: false,
      missing_catalog_signal: {
        ingredient_id: ingredientId,
        ingredient_name: ingredientLabel,
        query: fallbackPack.query,
        normalized_query: fallbackPack.normalized_query,
        source: 'catalog_miss',
        candidate_url: fallbackGoogleUrl,
        capture_mode: 'sync_external_fallback',
        status: 'catalog_miss_no_external_candidate',
      },
    };
  }

  const remaining = unique.slice();
  const takeByTier = (tier) => {
    const idx = remaining.findIndex((row) => normalizeBudgetTier(row.price_tier) === tier);
    if (idx < 0) return null;
    return remaining.splice(idx, 1)[0];
  };

  let dupe = null;
  if (budgetTier === 'unknown') {
    dupe = takeByTier('low') || remaining.shift() || null;
  } else {
    dupe = takeByTier('low') || takeByTier(budgetTier) || remaining.shift() || null;
  }

  const competitors = [];
  if (budgetTier === 'unknown') {
    const tierOrder = ['mid', 'high', 'low'];
    for (const tier of tierOrder) {
      if (competitors.length >= maxCompetitors) break;
      const picked = takeByTier(tier);
      if (picked) competitors.push(picked);
    }
  } else {
    const tierOrder = [budgetTier, 'mid', 'high', 'low'];
    for (const tier of tierOrder) {
      if (competitors.length >= maxCompetitors) break;
      const picked = takeByTier(tier);
      if (picked) competitors.push(picked);
    }
  }
  while (competitors.length < maxCompetitors && remaining.length) {
    competitors.push(remaining.shift());
  }

  const selectedProductIds = new Set();
  const competitorRows = competitors
      .slice(0, maxCompetitors)
      .map((product) => {
        selectedProductIds.add(String(product.product_id || ''));
        return toProductView(
          product,
          'competitor',
          `Contains ${ingredientLabel} and fits the current tolerance strategy.`,
        );
      });

  const dupeRows = dupe
    ? [
        toProductView(
          dupe,
          'dupe',
          `Budget-friendly alternative featuring ${ingredientLabel}.`,
        ),
      ].slice(0, maxDupes)
    : [];
  if (dupe) selectedProductIds.add(String(dupe.product_id || ''));

  const fallbackQueue = fallbackCandidateRows.filter((candidate) => !selectedProductIds.has(String(candidate.product_id || '')));
  let fallbackUsed = false;
  let externalExecutorUsed = false;

  while (competitorRows.length < maxCompetitors && fallbackQueue.length) {
    const candidate = fallbackQueue.shift();
    if (!candidate) break;
    fallbackUsed = true;
    if (candidate.__executor === true) externalExecutorUsed = true;
    competitorRows.push(
      toProductView(
        candidate,
        'competitor',
        `Fallback from ${String(candidate.source || 'external')} while catalog coverage is incomplete.`,
      ),
    );
  }
  while (dupeRows.length < maxDupes && fallbackQueue.length) {
    const candidate = fallbackQueue.shift();
    if (!candidate) break;
    fallbackUsed = true;
    if (candidate.__executor === true) externalExecutorUsed = true;
    dupeRows.push(
      toProductView(
        candidate,
        'dupe',
        `Fallback from ${String(candidate.source || 'external')} while catalog coverage is incomplete.`,
      ),
    );
  }

  const metaObj = normalizeObject(externalMeta);
  const normalizedMetaQuery = normalizeQueryKey(metaObj?.query || metaObj?.normalized_query || fallbackPack.query);
  const missingSignal = localCatalogMissing || localCatalogInsufficient || fallbackUsed
    ? {
        ingredient_id: ingredientId,
        ingredient_name: ingredientLabel,
        query: String(metaObj?.query || fallbackPack.query || '').trim() || fallbackPack.query,
        normalized_query: normalizedMetaQuery || fallbackPack.normalized_query,
        source: localCatalogMissing ? 'catalog_miss' : 'catalog_partial',
        candidate_url: fallbackPrimaryUrl,
        capture_mode: String(
          metaObj?.capture_mode ||
          (externalExecutorUsed ? 'sync_external_executor' : 'sync_external_fallback'),
        ).trim() || 'sync_external_fallback',
        status: String(
          metaObj?.status ||
          (
            fallbackUsed
              ? (externalExecutorUsed ? 'external_executor_returned' : 'external_fallback_returned')
              : (localCatalogMissing ? 'catalog_miss' : 'catalog_partial')
          ),
        ).trim() || (localCatalogMissing ? 'catalog_miss' : 'catalog_partial'),
        ...(String(metaObj?.failure_reason || '').trim()
          ? { failure_reason: String(metaObj.failure_reason).trim() }
          : {}),
      }
    : null;

  return {
    competitors: competitorRows.slice(0, maxCompetitors),
    dupes: dupeRows.slice(0, maxDupes),
    external_fallback_used: fallbackUsed,
    ...(missingSignal ? { missing_catalog_signal: missingSignal } : {}),
  };
}

function buildIngredientPlanV2({
  plan,
  profile,
  catalogPath,
  externalCandidatesByIngredient = null,
  externalMetaByIngredient = null,
} = {}) {
  const base = normalizeObject(plan);
  if (!base) return null;
  const profileObj = normalizeObject(profile) || {};
  const budgetTier = normalizeBudgetTier(profileObj.budgetTier);
  const catalog = loadProductCatalog(catalogPath);

  const avoidMap = normalizeAvoidByCanonicalId(base.avoid);
  const conflictRows = asArray(base.conflicts).map((item) => normalizeObject(item)).filter(Boolean);

  const targetsDeduped = dedupeTargetsByCanonicalId(base.targets);
  const filteredTargets = [];
  const missingCatalogSignals = [];
  let externalFallbackUsed = false;
  for (const target of targetsDeduped) {
    const avoid = avoidMap.get(target.ingredient_id);
    if (avoid) {
      conflictRows.push({
        id: `target_avoid_${target.ingredient_id}`,
        description: `${resolveIngredientName(target.ingredient_id)} is deprioritized because it is listed in avoid/caution.`,
      });
      continue;
    }
    filteredTargets.push(target);
  }

  const targets = filteredTargets.slice(0, 10).map((target) => {
    const externalCandidates = resolveExternalInputForIngredient(
      externalCandidatesByIngredient,
      target.ingredient_id,
    );
    const externalMeta = resolveExternalInputForIngredient(
      externalMetaByIngredient,
      target.ingredient_id,
    );
    const selection = selectIngredientProducts({
      ingredientId: target.ingredient_id,
      budgetTier,
      catalogRows: catalog,
      maxCompetitors: 2,
      maxDupes: 1,
      externalCandidates,
      externalMeta,
    });
    if (selection.external_fallback_used) externalFallbackUsed = true;
    if (selection.missing_catalog_signal) {
      missingCatalogSignals.push({
        ...selection.missing_catalog_signal,
        ingredient_id: target.ingredient_id,
        ingredient_name: resolveIngredientName(target.ingredient_id),
      });
    }
    const why = target.rationale.length
      ? target.rationale.map((entry) => `Rule signal: ${entry}`).slice(0, 4)
      : ['Matched by profile + concern signals.'];
    const usageGuidance = target.usage_guidance.length
      ? target.usage_guidance.slice(0, 4)
      : normalizeIngredientGuidance(target.ingredient_id).slice(0, 4);

    return {
      ingredient_id: target.ingredient_id,
      ingredient_name: resolveIngredientName(target.ingredient_id),
      priority_score_0_100: target.priority_score_0_100,
      priority_level: priorityLevelFromScore(target.priority_score_0_100),
      why,
      usage_guidance: usageGuidance,
      products: {
        competitors: Array.isArray(selection.competitors) ? selection.competitors : [],
        dupes: Array.isArray(selection.dupes) ? selection.dupes : [],
      },
      external_fallback_used: Boolean(selection.external_fallback_used),
    };
  });

  const avoid = Array.from(avoidMap.values())
    .slice(0, 10)
    .map((item) => ({
      ingredient_id: item.ingredient_id,
      ingredient_name: resolveIngredientName(item.ingredient_id),
      severity: item.severity,
      reason: item.reason.length ? item.reason.slice(0, 4) : ['Potential irritation or conflict with current plan.'],
    }));

  const conflicts = conflictRows.slice(0, 8).map((row, idx) => ({
    id: String(row.id || `conflict_${idx + 1}`),
    description: String(row.description || row.message || '').trim() || 'Potential routine conflict detected.',
  }));

  const out = {
    schema_version: 'aurora.ingredient_plan.v2',
    created_at: new Date().toISOString(),
    intensity: mapIntensityV2(base.intensity),
    targets,
    avoid,
    conflicts,
    budget_context: {
      effective_tier: budgetTier,
      source: budgetTier === 'unknown' ? 'unknown' : 'profile',
      diversified_when_unknown: budgetTier === 'unknown',
    },
  };
  if (externalFallbackUsed) out.external_fallback_used = true;
  if (missingCatalogSignals.length) {
    out.__missing_catalog_queries = Array.from(
      new Map(
        missingCatalogSignals
          .map((item) => normalizeObject(item))
          .filter(Boolean)
          .map((item) => [String(item.normalized_query || ''), item]),
      ).values(),
    );
  }
  return out;
}

module.exports = {
  LOW_CONFIDENCE_THRESHOLD,
  MEDIUM_CONFIDENCE_THRESHOLD,
  INGREDIENT_RULES,
  computeArtifactOverallConfidence,
  buildIngredientPlan,
  buildIngredientPlanV2,
};
