const crypto = require('crypto');

function normalizeRecoLang(locale) {
  const raw = String(locale || '').trim().toLowerCase();
  return raw === 'cn' || raw === 'zh' || raw.startsWith('zh-') ? 'CN' : 'EN';
}

function localizeStepLabel(step, lang = 'EN') {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  const map = {
    cleanser: isCn ? '洁面' : 'cleanser',
    toner: isCn ? '化妆水' : 'toner',
    essence: isCn ? '精华水' : 'essence',
    serum: isCn ? '精华' : 'serum',
    moisturizer: isCn ? '保湿' : 'moisturizer',
    sunscreen: isCn ? '防晒' : 'sunscreen',
    treatment: isCn ? '功效产品' : 'treatment',
    mask: isCn ? '面膜' : 'mask',
    oil: isCn ? '护肤油' : 'face oil',
  };
  return map[String(step || '').trim().toLowerCase()] || (isCn ? '护肤产品' : 'skincare product');
}

function mirrorProfileShape(profile, currentRoutine) {
  const base = profile && typeof profile === 'object' && !Array.isArray(profile) ? { ...profile } : {};
  const skinType = base.skinType || base.skin_type || null;
  const sensitivity = base.sensitivity || base.sensitivity_level || null;
  const barrierStatus = base.barrierStatus || base.barrier_status || null;
  const budgetTier = base.budgetTier || base.budget_tier || null;
  const goals = Array.isArray(base.goals) ? base.goals : Array.isArray(base.concerns) ? base.concerns : [];
  const concerns = Array.isArray(base.concerns) ? base.concerns : Array.isArray(base.goals) ? base.goals : [];

  if (skinType) {
    base.skinType = base.skinType || skinType;
    base.skin_type = base.skin_type || skinType;
  }
  if (sensitivity) base.sensitivity = sensitivity;
  if (barrierStatus) {
    base.barrierStatus = base.barrierStatus || barrierStatus;
    base.barrier_status = base.barrier_status || barrierStatus;
  }
  if (budgetTier) {
    base.budgetTier = base.budgetTier || budgetTier;
    base.budget_tier = base.budget_tier || budgetTier;
  }
  const pregnancyStatus = base.pregnancyStatus || base.pregnancy_status || null;
  if (pregnancyStatus) {
    base.pregnancyStatus = base.pregnancyStatus || pregnancyStatus;
    base.pregnancy_status = base.pregnancy_status || pregnancyStatus;
  }
  if (goals.length) base.goals = goals;
  if (concerns.length) base.concerns = concerns;
  if (currentRoutine) {
    base.currentRoutine = base.currentRoutine || currentRoutine;
    base.current_routine = base.current_routine || currentRoutine;
  }
  return base;
}

function buildRecoMessage({ requestText, targetStep, targetIngredient, concerns, lang }) {
  const text = String(requestText || '').trim();
  if (text) return text;

  if (targetIngredient) {
    return lang === 'CN'
      ? `推荐含有${targetIngredient}的护肤产品。`
      : `Recommend skincare products with ${targetIngredient}.`;
  }

  if (targetStep) {
    const label = localizeStepLabel(targetStep, lang);
    return lang === 'CN'
      ? `推荐适合我的${label}产品。`
      : `Recommend a ${label} that suits me.`;
  }

  if (Array.isArray(concerns) && concerns.length > 0) {
    const concern = String(concerns[0] || '').trim();
    if (concern) {
      return lang === 'CN'
        ? `推荐适合${concern}诉求的护肤产品。`
        : `Recommend skincare products for ${concern}.`;
    }
  }

  return lang === 'CN'
    ? '按我的肤况与目标推荐护肤产品。'
    : 'Recommend skincare products for my profile and goals.';
}

function buildIngredientContext({ targetIngredient, entrySource }) {
  const query = String(targetIngredient || '').trim();
  if (!query) return null;
  return {
    query,
    candidates: [query],
    ingredient_candidates: [query],
    source: entrySource || 'v2_reco_step_based',
  };
}

function createRecoContext({ request, lang }) {
  const entrySource = String(request?.params?.entry_source || 'v2_reco_step_based').trim() || 'v2_reco_step_based';
  const userMessage = String(request?.params?.user_message || request?.params?.message || request?.params?.text || '').trim();
  const seed = `${entrySource}|${userMessage}|${Date.now()}`;
  const traceId = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
  return {
    lang,
    state: String(request?.thread_state?.state || '').trim() || null,
    trigger_source: entrySource,
    request_id: `v2_reco_${traceId}`,
    trace_id: `v2_reco_${traceId}`,
    brief_id: null,
  };
}

async function runRecoStepBasedCatalogBridge({ request, logger } = {}) {
  const { __internal } = require('../routes');
  if (!__internal || typeof __internal.generateProductRecommendations !== 'function') {
    throw new Error('recoStepBasedCatalogBridge: generateProductRecommendations unavailable');
  }

  const lang = normalizeRecoLang(request?.context?.locale);
  const targetIngredient = String(request?.params?.target_ingredient || '').trim();
  const targetStep = String(request?.params?.target_step || '').trim();
  const concerns = Array.isArray(request?.params?._extracted_concerns) ? request.params._extracted_concerns : [];
  const profile = mirrorProfileShape(request?.context?.profile, request?.context?.current_routine || null);
  const message = buildRecoMessage({
    requestText: request?.params?._user_question || request?.params?.message || request?.params?.text || '',
    targetStep,
    targetIngredient,
    concerns,
    lang,
  });
  const ingredientContext = buildIngredientContext({
    targetIngredient,
    entrySource: request?.params?.entry_source,
  });

  return __internal.generateProductRecommendations({
    ctx: createRecoContext({ request, lang }),
    profile,
    recentLogs: Array.isArray(request?.context?.recent_logs) ? request.context.recent_logs : [],
    message,
    ingredientContext,
    includeAlternatives: false,
    debug: false,
    logger,
    recoTriggerSource: request?.params?.entry_source || 'v2_reco_step_based',
  });
}

module.exports = {
  runRecoStepBasedCatalogBridge,
  __internal: {
    normalizeRecoLang,
    localizeStepLabel,
    mirrorProfileShape,
    buildRecoMessage,
    buildIngredientContext,
  },
};
