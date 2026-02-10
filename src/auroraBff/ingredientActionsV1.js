const { inferRiskTier, resolveIngredientRecommendation } = require('./ingredientKbV2/resolve');
const { mergeIngredientActionWithEvidence } = require('./ingredientKbV2/merge');

function normalizeLang(language) {
  return String(language || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function clampToAllowedFrequency(frequency, isFragile) {
  if (!isFragile) return frequency;
  if (frequency === 'daily') return '2-3x_week';
  return frequency;
}

function toAction({ issueType, ingredient, evidenceRegionIds, language, isFragile } = {}) {
  const lang = normalizeLang(language);
  const evidenceIds = Array.isArray(evidenceRegionIds)
    ? evidenceRegionIds.filter((item) => typeof item === 'string' && item.trim()).slice(0, 3)
    : [];
  const whySuffix = evidenceIds.length ? ` (${evidenceIds.join(', ')})` : '';

  const cautions = Array.isArray(ingredient.cautions) ? ingredient.cautions.slice() : [];
  if (isFragile && ingredient.strong) {
    cautions.unshift(
      lang === 'CN'
        ? '当前屏障/敏感信号偏高，先以修护为主；若要尝试该成分，请降低频率并做局部测试。'
        : 'Barrier/sensitivity looks fragile; prioritize repair first and use reduced frequency with patch test.',
    );
  }

  return {
    action_type: 'ingredient',
    ingredient_id: ingredient.id,
    ingredient_name: lang === 'CN' && ingredient.name_cn ? ingredient.name_cn : ingredient.name,
    why:
      lang === 'CN'
        ? `针对 ${issueType} 信号（来自高亮照片区域）${whySuffix}`
        : `Targets ${issueType} based on highlighted photo evidence${whySuffix}`,
    how_to_use: {
      time: ingredient.time,
      frequency: clampToAllowedFrequency(ingredient.frequency, isFragile),
      notes: lang === 'CN' && ingredient.notes_cn ? ingredient.notes_cn : ingredient.notes,
    },
    cautions,
    evidence_issue_types: [issueType],
  };
}

const ISSUE_INGREDIENT_MAP = Object.freeze({
  redness: [
    {
      id: 'panthenol',
      name: 'Panthenol',
      name_cn: '泛醇',
      time: 'AM_PM',
      frequency: 'daily',
      notes: 'Use as barrier-support base layer after cleansing.',
      notes_cn: '洁面后先用作修护底层。',
      strong: false,
      cautions: ['Stop and simplify routine if burning or swelling appears.'],
    },
    {
      id: 'ceramides',
      name: 'Ceramides',
      name_cn: '神经酰胺',
      time: 'AM_PM',
      frequency: 'daily',
      notes: 'Layer on damp skin to reduce water loss.',
      notes_cn: '可在微湿皮肤上叠加以降低水分流失。',
      strong: false,
      cautions: [],
    },
    {
      id: 'niacinamide_low_pct',
      name: 'Niacinamide (low %)',
      name_cn: '低浓度烟酰胺',
      time: 'PM',
      frequency: '2-3x_week',
      notes: 'Start at low strength and increase only if tolerated.',
      notes_cn: '先低浓度、低频尝试，耐受后再加。',
      strong: false,
      cautions: ['Pause if stinging lasts more than 10 minutes.'],
    },
  ],
  shine: [
    {
      id: 'niacinamide',
      name: 'Niacinamide',
      name_cn: '烟酰胺',
      time: 'AM_PM',
      frequency: 'daily',
      notes: 'Can help with visible oil control over 2-4 weeks.',
      notes_cn: '通常 2-4 周可观察到控油改善。',
      strong: false,
      cautions: [],
    },
    {
      id: 'zinc_pca',
      name: 'Zinc PCA',
      name_cn: 'PCA 锌',
      time: 'AM_PM',
      frequency: 'daily',
      notes: 'Use in lightweight layer; avoid over-drying cleansers.',
      notes_cn: '建议轻薄叠加，避免过度清洁。',
      strong: false,
      cautions: [],
    },
    {
      id: 'bha_gentle',
      name: 'Gentle BHA',
      name_cn: '温和 BHA',
      time: 'PM',
      frequency: '2-3x_week',
      notes: 'Use on non-consecutive nights only.',
      notes_cn: '隔天夜间使用，不要连用。',
      strong: true,
      cautions: ['Do not layer with retinoid in same routine.'],
    },
  ],
  texture: [
    {
      id: 'bha_lha',
      name: 'BHA/LHA',
      name_cn: 'BHA/LHA',
      time: 'PM',
      frequency: '2-3x_week',
      notes: 'Introduce slowly after barrier feels stable.',
      notes_cn: '屏障稳定后再低频引入。',
      strong: true,
      cautions: ['Pause if peeling or persistent redness appears.'],
    },
    {
      id: 'azelaic_acid',
      name: 'Azelaic Acid',
      name_cn: '壬二酸',
      time: 'PM',
      frequency: '2-3x_week',
      notes: 'Start with thin layer and monitor dryness.',
      notes_cn: '薄涂起步，观察是否干燥。',
      strong: true,
      cautions: ['Avoid stacking with strong acids in same night.'],
    },
    {
      id: 'retinoid_later',
      name: 'Retinoid (later stage)',
      name_cn: '维A类（后续阶段）',
      time: 'PM',
      frequency: 'weekly',
      notes: 'Only after skin is calm and stable for at least 1 week.',
      notes_cn: '至少稳定 1 周后再考虑引入。',
      strong: true,
      cautions: ['Not first choice during active irritation period.'],
    },
  ],
  tone: [
    {
      id: 'vitamin_c_gentle',
      name: 'Gentle Vitamin C',
      name_cn: '温和维C',
      time: 'AM',
      frequency: '2-3x_week',
      notes: 'Pair with SPF every morning.',
      notes_cn: '白天配合防晒。',
      strong: true,
      cautions: ['Skip if stinging persists.'],
    },
    {
      id: 'niacinamide',
      name: 'Niacinamide',
      name_cn: '烟酰胺',
      time: 'AM_PM',
      frequency: 'daily',
      notes: 'Supports tone-evening and barrier together.',
      notes_cn: '兼顾提亮与屏障支持。',
      strong: false,
      cautions: [],
    },
    {
      id: 'azelaic_acid',
      name: 'Azelaic Acid',
      name_cn: '壬二酸',
      time: 'PM',
      frequency: '2-3x_week',
      notes: 'Use low frequency initially; increase only if comfortable.',
      notes_cn: '先低频使用，耐受后再调整。',
      strong: true,
      cautions: ['Avoid over-exfoliation in parallel.'],
    },
  ],
  acne: [
    {
      id: 'bha',
      name: 'BHA',
      name_cn: 'BHA',
      time: 'PM',
      frequency: '2-3x_week',
      notes: 'Focus on breakout-prone zones only.',
      notes_cn: '优先点涂/局部在易爆痘区域。',
      strong: true,
      cautions: ['Do not combine with multiple acids in same night.'],
    },
    {
      id: 'benzoyl_peroxide_spot',
      name: 'Benzoyl Peroxide (spot)',
      name_cn: '过氧化苯甲酰（点涂）',
      time: 'PM',
      frequency: 'weekly',
      notes: 'Use as spot treatment only at first.',
      notes_cn: '初期仅作点涂。',
      strong: true,
      cautions: ['Can be drying; reduce frequency if irritation appears.'],
    },
    {
      id: 'sulfur',
      name: 'Sulfur',
      name_cn: '硫磺',
      time: 'PM',
      frequency: 'weekly',
      notes: 'Use short-contact if skin is reactive.',
      notes_cn: '敏感时建议短接触法。',
      strong: true,
      cautions: ['Stop if burning or severe dryness occurs.'],
    },
  ],
});

const TEMPLATE_TO_INGREDIENT_ID = Object.freeze({
  panthenol: 'panthenol',
  ceramides: 'ceramide_np',
  niacinamide_low_pct: 'niacinamide',
  niacinamide: 'niacinamide',
  zinc_pca: 'zinc_pca',
  bha_gentle: 'salicylic_acid',
  bha_lha: 'salicylic_acid',
  bha: 'salicylic_acid',
  azelaic_acid: 'azelaic_acid',
  retinoid_later: 'retinol',
  vitamin_c_gentle: 'ascorbic_acid',
  benzoyl_peroxide_spot: 'benzoyl_peroxide',
  sulfur: 'sulfur',
});

function normalizeMarket(input, language) {
  const token = String(input || '').trim().toUpperCase();
  if (token === 'EU' || token === 'CN' || token === 'JP' || token === 'US') return token;
  return normalizeLang(language) === 'CN' ? 'CN' : 'US';
}

function resolveIngredientId(templateId) {
  const key = String(templateId || '').trim();
  if (!key) return '';
  if (Object.prototype.hasOwnProperty.call(TEMPLATE_TO_INGREDIENT_ID, key)) {
    return TEMPLATE_TO_INGREDIENT_ID[key];
  }
  return key;
}

function mapIngredientActions({
  issueType,
  evidenceRegionIds,
  language,
  barrierStatus,
  sensitivity,
  market,
  contraindications,
} = {}) {
  const key = String(issueType || '').trim().toLowerCase();
  const templates = ISSUE_INGREDIENT_MAP[key];
  if (!Array.isArray(templates) || templates.length === 0) return [];

  const resolvedMarket = normalizeMarket(market, language);
  const riskTier = inferRiskTier({ barrierStatus, sensitivity, contraindications });
  const sensitiveHigh = String(sensitivity || '').trim().toLowerCase() === 'high';
  const barrierImpaired = String(barrierStatus || '').trim().toLowerCase() === 'impaired';
  const isFragile = sensitiveHigh || barrierImpaired;

  const selected = [];
  for (const template of templates) {
    if (!template || typeof template !== 'object') continue;
    if (isFragile && template.strong && selected.length >= 2) continue;
    selected.push(template);
    if (selected.length >= 3) break;
  }

  return selected.map((ingredient) => {
    const action = toAction({ issueType: key, ingredient, evidenceRegionIds, language, isFragile });
    const ingredientId = resolveIngredientId(ingredient.id);
    const evidence = resolveIngredientRecommendation({
      ingredientId,
      market: resolvedMarket,
      riskTier,
    });
    return mergeIngredientActionWithEvidence({
      action,
      evidence,
      market: resolvedMarket,
    });
  });
}

module.exports = {
  mapIngredientActions,
};
