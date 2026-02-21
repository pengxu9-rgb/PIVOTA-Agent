const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('crypto');

const DEFAULT_CATALOG_PATH = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'external',
  'products',
  'product_catalog_seed.json',
);
const DEFAULT_CATALOG_PATH_RESOLVED = path.resolve(DEFAULT_CATALOG_PATH);

const ROUTINE_SLOTS = Object.freeze([
  'cleanser',
  'moisturizer',
  'sunscreen',
  'treatment',
  'toner',
  'optional',
]);

const SLOT_PRIORITY = Object.freeze({
  sunscreen: 0,
  moisturizer: 1,
  treatment: 2,
  cleanser: 3,
  toner: 4,
  optional: 5,
});

const RISK_TAGS_FOR_FRAGILE = new Set(['acid', 'retinoid', 'strong', 'active']);

const catalogCache = {
  path: '',
  mtimeMs: -1,
  items: [],
};

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

function parseBoolEnv(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (token === 'true' || token === '1' || token === 'yes' || token === 'y' || token === 'on') return true;
  if (token === 'false' || token === '0' || token === 'no' || token === 'n' || token === 'off') return false;
  return fallback;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function confidenceLevel(score) {
  const s = clamp01(score);
  if (s < 0.55) return 'low';
  if (s <= 0.75) return 'medium';
  return 'high';
}

function parseCatalogProduct(raw) {
  const obj = normalizeObject(raw);
  if (!obj) return null;
  const productId = String(obj.product_id || '').trim();
  const name = String(obj.name || '').trim();
  if (!productId || !name) return null;
  return {
    product_id: productId,
    name,
    brand: String(obj.brand || '').trim() || null,
    market_scope: asArray(obj.market_scope).map((m) => String(m || '').trim().toUpperCase()).filter(Boolean),
    ingredient_ids: asArray(obj.ingredient_ids).map((id) => normalizeToken(id)).filter(Boolean),
    risk_tags: asArray(obj.risk_tags).map((tag) => normalizeToken(tag)).filter(Boolean),
    usage_note_en: String(obj.usage_note_en || '').trim(),
    usage_note_zh: String(obj.usage_note_zh || '').trim(),
    cautions_en: asArray(obj.cautions_en).map((entry) => String(entry || '').trim()).filter(Boolean),
    cautions_zh: asArray(obj.cautions_zh).map((entry) => String(entry || '').trim()).filter(Boolean),
    price_band: String(obj.price_band || '').trim() || null,
  };
}

function loadCatalog(catalogPath) {
  const resolved = path.resolve(catalogPath || process.env.AURORA_PRODUCT_REC_CATALOG_PATH || DEFAULT_CATALOG_PATH);
  const usingDefaultSeedCatalog = resolved === DEFAULT_CATALOG_PATH_RESOLVED;
  const allowSeedCatalog =
    parseBoolEnv(process.env.AURORA_PRODUCT_REC_ALLOW_SEED_CATALOG, false) ||
    parseBoolEnv(process.env.INTERNAL_TEST_MODE, false);
  if (usingDefaultSeedCatalog && !allowSeedCatalog) {
    return [];
  }
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.statSync(resolved);
  if (
    catalogCache.path === resolved &&
    Number.isFinite(catalogCache.mtimeMs) &&
    catalogCache.mtimeMs === Number(stat.mtimeMs) &&
    Array.isArray(catalogCache.items)
  ) {
    return catalogCache.items;
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const items = asArray(parsed).map(parseCatalogProduct).filter(Boolean);
  catalogCache.path = resolved;
  catalogCache.mtimeMs = Number(stat.mtimeMs);
  catalogCache.items = items;
  return items;
}

function inferRoutineSlot(product, targetIds) {
  const ingredientIds = new Set(asArray(product && product.ingredient_ids));
  const riskTags = new Set(asArray(product && product.risk_tags));
  if (ingredientIds.has('sunscreen_filters') || riskTags.has('sunscreen') || riskTags.has('uv')) return 'sunscreen';
  if (
    ingredientIds.has('retinol') ||
    ingredientIds.has('salicylic_acid') ||
    ingredientIds.has('azelaic_acid') ||
    ingredientIds.has('benzoyl_peroxide') ||
    ingredientIds.has('ascorbic_acid') ||
    riskTags.has('retinoid') ||
    riskTags.has('acid')
  ) {
    return 'treatment';
  }
  if (
    ingredientIds.has('ceramide_np') ||
    ingredientIds.has('panthenol') ||
    ingredientIds.has('glycerin') ||
    ingredientIds.has('hyaluronic_acid') ||
    riskTags.has('repair')
  ) {
    return 'moisturizer';
  }
  if (targetIds.has('cleanser_surfactants')) return 'cleanser';
  return 'optional';
}

function normalizeProfileSignals(profile) {
  const p = normalizeObject(profile) || {};
  return {
    skinType: normalizeToken(p.skinType),
    barrierStatus: normalizeToken(p.barrierStatus),
    sensitivity: normalizeToken(p.sensitivity),
    budgetTier: normalizeToken(p.budgetTier),
    region: normalizeToken(p.region),
  };
}

function isFragileProfile(profileSignals) {
  if (!profileSignals) return false;
  return (
    profileSignals.sensitivity === 'high' ||
    profileSignals.barrierStatus === 'impaired' ||
    profileSignals.barrierStatus === 'compromised' ||
    profileSignals.barrierStatus === 'damaged'
  );
}

function resolveBudgetBand(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  if (token.includes('low') || token.includes('budget') || token.includes('entry')) return 'low';
  if (token.includes('high') || token.includes('premium') || token.includes('lux')) return 'high';
  return 'mid';
}

function resolveProductBudgetBand(product) {
  const explicit = normalizeToken(product && product.price_band);
  if (explicit === 'low' || explicit === 'mid' || explicit === 'high') return explicit;
  if (normalizeToken(product && product.name).includes('lab')) return 'mid';
  return 'mid';
}

function buildTargetMap(ingredientPlan) {
  const map = new Map();
  const targets = asArray(ingredientPlan && ingredientPlan.targets);
  for (const target of targets) {
    const obj = normalizeObject(target);
    if (!obj) continue;
    const id = normalizeToken(obj.ingredient_id);
    if (!id) continue;
    map.set(id, {
      ingredient_id: id,
      priority: Math.max(0, Math.min(100, Number(obj.priority || 0))),
      role: String(obj.role || 'support') === 'hero' ? 'hero' : 'support',
    });
  }
  return map;
}

function buildAvoidMap(ingredientPlan) {
  const map = new Map();
  for (const avoid of asArray(ingredientPlan && ingredientPlan.avoid)) {
    const obj = normalizeObject(avoid);
    if (!obj) continue;
    const id = normalizeToken(obj.ingredient_id);
    if (!id) continue;
    const severity = String(obj.severity || 'caution').toLowerCase() === 'avoid' ? 'avoid' : 'caution';
    map.set(id, {
      ingredient_id: id,
      severity,
      reason: asArray(obj.reason).map((r) => String(r || '').trim()).filter(Boolean),
    });
  }
  return map;
}

function buildCandidateFromSeed(seedItem, targetIds) {
  const obj = normalizeObject(seedItem);
  if (!obj) return null;
  const productId =
    String(obj.product_id || obj.id || obj.sku_id || '').trim() ||
    `seed_${randomUUID().slice(0, 8)}`;
  const name =
    String(obj.name || obj.title || obj.display_name || '').trim() ||
    String(obj.product_name || '').trim();
  if (!name) return null;
  const reasonText = asArray(obj.reasons).map((r) => String(r || '').trim()).filter(Boolean).join(' ').toLowerCase();
  const slot =
    reasonText.includes('spf') || reasonText.includes('sunscreen')
      ? 'sunscreen'
      : reasonText.includes('night') || reasonText.includes('retinol') || reasonText.includes('acid')
        ? 'treatment'
        : reasonText.includes('moistur') || reasonText.includes('repair')
          ? 'moisturizer'
          : inferRoutineSlot({ ingredient_ids: [] }, targetIds);
  return {
    product_id: productId,
    name,
    brand: String(obj.brand || '').trim() || null,
    ingredient_ids: [],
    risk_tags: [],
    market_scope: [],
    usage_note_en: '',
    usage_note_zh: '',
    cautions_en: [],
    cautions_zh: [],
    price_band: null,
    __slot_hint: slot,
  };
}

function buildCandidateScore({
  product,
  targetMap,
  avoidMap,
  profileSignals,
  fragile,
  disallowTreatment,
  routineSlot,
}) {
  const ingredientIds = new Set(asArray(product && product.ingredient_ids));
  const riskTags = new Set(asArray(product && product.risk_tags));

  const avoidHits = [];
  for (const [ingredientId, avoid] of avoidMap.entries()) {
    if (!ingredientIds.has(ingredientId)) continue;
    avoidHits.push({
      ingredient_id: ingredientId,
      severity: avoid.severity,
      reason: asArray(avoid.reason).join('; ') || `Matched ${ingredientId}`,
    });
  }
  if (avoidHits.some((hit) => hit.severity === 'avoid')) {
    return { excluded: true, reason: 'avoid_hit', avoidHits };
  }

  if (fragile) {
    const risky = Array.from(riskTags).some((tag) => RISK_TAGS_FOR_FRAGILE.has(tag));
    if (risky && routineSlot === 'treatment') {
      return { excluded: true, reason: 'fragile_profile_high_risk', avoidHits };
    }
  }

  if (disallowTreatment && routineSlot === 'treatment') {
    return { excluded: true, reason: 'low_confidence_no_treatment', avoidHits };
  }

  const targetTotalPriority = Math.max(
    1,
    Array.from(targetMap.values()).reduce((sum, item) => sum + Number(item.priority || 0), 0),
  );
  const matchedIngredients = [];
  let coverageWeighted = 0;
  for (const [ingredientId, target] of targetMap.entries()) {
    if (!ingredientIds.has(ingredientId)) continue;
    const contribution = Number(target.priority || 0);
    coverageWeighted += contribution;
    matchedIngredients.push({
      ingredient_id: ingredientId,
      contribution,
      reason: `Supports target ${ingredientId}`,
    });
  }
  const coverage = Math.max(0, Math.min(1, coverageWeighted / targetTotalPriority));

  let skinFit = 0.65;
  if (profileSignals.skinType === 'oily' && riskTags.has('lightweight')) skinFit = 0.9;
  if (profileSignals.skinType === 'dry' && riskTags.has('repair')) skinFit = 0.9;

  let barrierFit = 0.65;
  if (fragile) barrierFit = riskTags.has('repair') ? 0.95 : routineSlot === 'treatment' ? 0.2 : 0.6;
  if (!fragile && routineSlot === 'treatment') barrierFit = 0.82;

  const budgetTarget = resolveBudgetBand(profileSignals.budgetTier);
  const productBudget = resolveProductBudgetBand(product);
  let budgetFit = 0.65;
  if (budgetTarget && productBudget) budgetFit = budgetTarget === productBudget ? 1 : 0.45;

  let availability = 0.7;
  const region = String(profileSignals.region || '').toUpperCase();
  if (region && Array.isArray(product.market_scope) && product.market_scope.length > 0) {
    availability = product.market_scope.includes(region) ? 1 : 0.3;
  }

  const cautionPenalty =
    avoidHits.filter((hit) => hit.severity === 'caution').length > 0
      ? Math.min(0.35, 0.12 * avoidHits.filter((hit) => hit.severity === 'caution').length)
      : 0;

  const score01 =
    0.45 * coverage +
    0.15 * skinFit +
    0.15 * barrierFit +
    0.1 * budgetFit +
    0.1 * availability -
    0.05 * cautionPenalty;

  return {
    excluded: false,
    score: Math.max(0, Math.min(100, Math.round(score01 * 100))),
    matchedIngredients,
    avoidHits,
    components: { coverage, skinFit, barrierFit, budgetFit, availability, cautionPenalty },
  };
}

function buildFitExplanations({ product, routineSlot, scoreBreakdown, language }) {
  const isCN = String(language || '').toUpperCase() === 'CN';
  const lines = [];
  if (scoreBreakdown.coverage > 0.45) {
    lines.push(isCN ? '与目标成分覆盖度较高。' : 'Strong ingredient overlap with your targets.');
  } else {
    lines.push(isCN ? '与目标成分有部分匹配。' : 'Partial overlap with your target ingredients.');
  }
  if (scoreBreakdown.barrierFit >= 0.8) {
    lines.push(isCN ? '对当前屏障状态更友好。' : 'Better aligned with current barrier tolerance.');
  }
  if (routineSlot === 'sunscreen') {
    lines.push(isCN ? '放在早间流程末步使用。' : 'Use as the final AM step.');
  } else if (routineSlot === 'treatment') {
    lines.push(isCN ? '建议夜间低频引入并观察耐受。' : 'Introduce at night with low frequency first.');
  } else {
    lines.push(isCN ? '可作为基础步骤稳定使用。' : 'Works as a stable baseline routine step.');
  }
  if (product && product.brand) {
    lines.push(isCN ? `品牌：${product.brand}` : `Brand: ${product.brand}`);
  }
  return lines.slice(0, 5);
}

function buildProductsBySlot() {
  return {
    cleanser: [],
    moisturizer: [],
    sunscreen: [],
    treatment: [],
    toner: [],
    optional: [],
  };
}

function toLegacyRecommendationsPayload(bundle, { language } = {}) {
  const bySlot = normalizeObject(bundle && bundle.products_by_slot) || buildProductsBySlot();
  const pickUnique = (slot, seenProductKeys) => {
    const list = asArray(bySlot[slot]);
    for (const candidateRaw of list) {
      const candidate = normalizeObject(candidateRaw);
      if (!candidate) continue;
      const key = String(
        candidate.product_id ||
          `${String(candidate.brand || '').trim().toLowerCase()}::${String(candidate.name || '').trim().toLowerCase()}`,
      )
        .trim()
        .toLowerCase();
      if (!key) continue;
      if (seenProductKeys.has(key)) continue;
      seenProductKeys.add(key);
      return candidate;
    }
    return null;
  };
  const seenProductKeys = new Set();
  const mapped = [
    { slot: 'am', source_slot: 'cleanser' },
    { slot: 'am', source_slot: 'moisturizer' },
    { slot: 'am', source_slot: 'sunscreen' },
    { slot: 'pm', source_slot: 'cleanser' },
    { slot: 'pm', source_slot: 'treatment' },
    { slot: 'pm', source_slot: 'moisturizer' },
  ]
    .map((row) => {
      const candidate = pickUnique(row.source_slot, seenProductKeys);
      if (!candidate) return null;
      return { slot: row.slot, candidate };
    })
    .filter(Boolean);

  const recommendations = mapped.map((row) => {
    const candidate = row.candidate;
    const fitReasons = asArray(candidate.fit_explanations).map((item) => String(item || '').trim()).filter(Boolean);
    return {
      slot: row.slot,
      product_id: candidate.product_id,
      name: candidate.name,
      brand: candidate.brand || null,
      reasons: fitReasons.slice(0, 6),
      matched_ingredients: asArray(candidate.matched_ingredients),
      routine_slot: candidate.routine_slot,
      score: Number(candidate.score || 0),
      price_band: candidate.price_band || null,
      confidence: normalizeObject(bundle && bundle.confidence) || {
        score: 0.6,
        level: 'medium',
        rationale: ['rule_based_matcher'],
      },
      language: String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN',
    };
  });

  return {
    recommendations,
    products_by_slot: bySlot,
    top_messages: asArray(bundle && bundle.top_messages),
    confidence: normalizeObject(bundle && bundle.confidence) || {
      score: 0.6,
      level: 'medium',
      rationale: ['rule_based_matcher'],
    },
  };
}

function buildProductRecommendationsBundle({
  ingredientPlan,
  artifact,
  profile,
  language,
  maxPerSlot = 4,
  catalogPath,
  seedRecommendations,
  disallowTreatment = false,
} = {}) {
  const plan = normalizeObject(ingredientPlan) || {};
  const profileSignals = normalizeProfileSignals(profile);
  const fragile = isFragileProfile(profileSignals);
  const targetMap = buildTargetMap(plan);
  const avoidMap = buildAvoidMap(plan);
  const targetIds = new Set(Array.from(targetMap.keys()));

  const products = loadCatalog(catalogPath);
  const fromCatalog = asArray(products);
  const fromSeed = asArray(seedRecommendations)
    .map((item) => buildCandidateFromSeed(item, targetIds))
    .filter(Boolean);

  const allCandidates = fromCatalog.length ? fromCatalog : fromSeed;
  const bySlot = buildProductsBySlot();

  for (const product of allCandidates) {
    const slot = product.__slot_hint || inferRoutineSlot(product, targetIds);
    if (!Object.prototype.hasOwnProperty.call(bySlot, slot)) continue;
    const scored = buildCandidateScore({
      product,
      targetMap,
      avoidMap,
      profileSignals,
      fragile,
      disallowTreatment,
      routineSlot: slot,
    });
    if (scored.excluded) continue;
    const fitExplanations = buildFitExplanations({
      product,
      routineSlot: slot,
      scoreBreakdown: scored.components,
      language,
    });
    bySlot[slot].push({
      product_id: product.product_id,
      routine_slot: slot,
      name: product.name,
      brand: product.brand,
      score: scored.score,
      price_band: product.price_band || null,
      matched_ingredients: scored.matchedIngredients,
      avoided_ingredient_hits: scored.avoidHits,
      fit_explanations: fitExplanations,
      evidence: [{ source: 'rule', supports: ['product_match'], ref: { type: 'rule_id', id: 'PM_V1_SCORE' } }],
    });
  }

  for (const slot of ROUTINE_SLOTS) {
    bySlot[slot] = asArray(bySlot[slot])
      .sort((a, b) => {
        const diff = Number(b.score || 0) - Number(a.score || 0);
        if (diff !== 0) return diff;
        return String(a.product_id || '').localeCompare(String(b.product_id || ''));
      })
      .slice(0, Math.max(1, Math.min(8, Math.trunc(Number(maxPerSlot) || 4))));
  }

  const flattened = ROUTINE_SLOTS
    .slice()
    .sort((a, b) => (SLOT_PRIORITY[a] || 99) - (SLOT_PRIORITY[b] || 99))
    .flatMap((slot) => asArray(bySlot[slot]).slice(0, 2));

  const avgScore =
    flattened.length > 0
      ? flattened.reduce((sum, item) => sum + Number(item.score || 0), 0) / flattened.length / 100
      : 0.45;
  const planConfidenceScore = clamp01(
    normalizeObject(plan.confidence) && Number.isFinite(Number(plan.confidence.score))
      ? Number(plan.confidence.score)
      : 0.62,
  );
  const confidenceScore = clamp01(avgScore * 0.7 + planConfidenceScore * 0.3);
  const confidence = {
    score: confidenceScore,
    level: confidenceLevel(confidenceScore),
    rationale: [
      flattened.length ? 'slot_candidates_available' : 'limited_candidates',
      `avg_slot_score_${Math.round(avgScore * 100)}`,
      `plan_confidence_${Math.round(planConfidenceScore * 100)}`,
    ],
  };

  const topMessages = [];
  if (confidence.level === 'low') {
    topMessages.push(
      String(language || '').toUpperCase() === 'CN'
        ? '当前证据偏弱，推荐以温和基础步骤为主。'
        : 'Evidence is limited; recommendations are intentionally conservative.',
    );
  } else {
    topMessages.push(
      String(language || '').toUpperCase() === 'CN'
        ? '已按成分目标、耐受与风险规则排序候选产品。'
        : 'Candidates are ranked by ingredient coverage, tolerance, and safety rules.',
    );
  }

  return {
    bundle_id: `rb_${randomUUID()}`,
    created_at: new Date().toISOString(),
    diagnosis_artifact_id: normalizeObject(artifact) ? String(artifact.artifact_id || '').trim() || null : null,
    ingredient_plan_id: normalizeObject(plan) ? String(plan.plan_id || '').trim() || null : null,
    products_by_slot: bySlot,
    top_messages: topMessages,
    confidence,
  };
}

module.exports = {
  buildProductRecommendationsBundle,
  toLegacyRecommendationsPayload,
};
