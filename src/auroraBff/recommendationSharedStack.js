const crypto = require('crypto');

const { resolveIngredientRecallProfile } = require('../services/ingredientRecallRegistry');
const {
  RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  resolveRecoTargetStepIntent,
  getRecoTargetFamilyRelation,
  normalizeRecoTargetStep,
} = require('./recoTargetStep');
const { __internal: recoHybridInternal } = require('./usecases/recoHybridResolveCandidates');

const normalizeProductType =
  recoHybridInternal && typeof recoHybridInternal.normalizeProductType === 'function'
    ? recoHybridInternal.normalizeProductType
    : (value) => normalizeRecoTargetStep(value);
const classifySkincareCandidate =
  recoHybridInternal && typeof recoHybridInternal.classifySkincareCandidate === 'function'
    ? recoHybridInternal.classifySkincareCandidate
    : () => ({ classification: 'ambiguous', hard_reject: false, penalty: 0.18, reason: 'fallback_ambiguous' });
const classifySkincareCandidateDomain =
  recoHybridInternal && typeof recoHybridInternal.classifySkincareCandidateDomain === 'function'
    ? recoHybridInternal.classifySkincareCandidateDomain
    : (value) => String(classifySkincareCandidate(value)?.classification || 'ambiguous').trim() || 'ambiguous';
const isSkincareCandidate =
  recoHybridInternal && typeof recoHybridInternal.isSkincareCandidate === 'function'
    ? recoHybridInternal.isSkincareCandidate
    : () => true;

const RECOMMENDATION_STEP_QUERY_POLICY_V1 = 'recommendation_step_query_policy_v1';
const RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1 = 'recommendation_viable_threshold_policy_v1';
const RECOMMENDATION_RECO_POLICY_V1 = 'recommendation_step_aware_reco_policy_v1';
const CONCERN_FRAMEWORK_POLICY_V1 = 'recommendation_concern_framework_policy_v1';
const CONCERN_SEMANTIC_PLAN_VERSION = 'concern_semantic_plan_v1';
const CANDIDATE_POOL_SIGNATURE_VERSION = 'recommendation_viable_pool_signature_v1';
const RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION = 'recommendation_raw_pool_debug_signature_v1';
const GROUP_SEMANTICS_VERSION = 'recommendation_group_semantics_v1';

const STEP_QUERY_ALIASES = Object.freeze({
  cleanser: Object.freeze(['cleanser', 'face wash', 'cleansing gel', 'cleansing foam', 'gentle cleanser', '洁面', '洗面奶']),
  toner: Object.freeze(['toner', 'skin toner', 'mist', '爽肤水', '化妆水']),
  essence: Object.freeze(['essence', 'first essence', '精华水', '精粹']),
  serum: Object.freeze(['serum', 'ampoule', 'repair serum', 'hydrating serum', '精华', '安瓶', '原液']),
  moisturizer: Object.freeze(['moisturizer', 'face cream', 'barrier cream', 'gel cream', 'lotion', 'emulsion', 'day cream', 'night cream', '面霜', '保湿霜', '保湿乳', '乳液', '日霜', '晚霜']),
  sunscreen: Object.freeze(['sunscreen', 'sun screen', 'spf', 'sunblock', '防晒', '隔离防晒']),
  treatment: Object.freeze(['treatment', 'spot treatment', 'retinol treatment', 'acid treatment', '祛痘', '刷酸', '点涂']),
  mask: Object.freeze(['mask', 'sleeping mask', 'sheet mask', 'overnight mask', 'facial mask', '面膜', '睡眠面膜', '泥膜']),
  oil: Object.freeze(['face oil', 'facial oil', 'oil serum', '护肤油', '面油']),
});

const STEP_THRESHOLDS = Object.freeze({
  default: Object.freeze({
    min_viable_count_for_step: 1,
    min_viable_quality_for_step: 0.72,
    allow_soft_target_same_family_only: true,
  }),
});

const EXPLICIT_SUNSCREEN_SIGNAL_RE = /\b(spf(?:\s*\d{1,3}\+?)?|sunscreen|sun screen|sun fluid|sun cream|sun lotion|broad spectrum|uv filters?|pa\+{1,4}|防晒|防曬)\b/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function uniqCaseInsensitiveStrings(items, max = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value == null ? null : value);
}

function makeSignature(prefix, payload) {
  const digest = crypto.createHash('sha1').update(stableSerialize(payload)).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function inferSlotForStep(step) {
  const normalized = normalizeRecoTargetStep(step);
  if (normalized === 'sunscreen') return 'am';
  if (normalized === 'mask' || normalized === 'treatment') return 'pm';
  return 'other';
}

function normalizeQueryToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinUniqueQueryParts(...parts) {
  return uniqCaseInsensitiveStrings(
    parts
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .map((item) => normalizeQueryToken(item))
      .filter(Boolean),
    12,
  ).join(' ');
}

function normalizeStringArray(values, max = 12) {
  return uniqCaseInsensitiveStrings(
    (Array.isArray(values) ? values : [values])
      .flatMap((item) => {
        if (Array.isArray(item)) return item;
        return [item];
      })
      .map((item) => normalizeQueryToken(item))
      .filter(Boolean),
    max,
  );
}

function collectRecoContextGoalTerms(recoContext) {
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  return normalizeStringArray([
    ...(Array.isArray(hard.active_goals) ? hard.active_goals : []),
    ...(Array.isArray(soft.background_goals) ? soft.background_goals : []),
    ...(Array.isArray(soft.active_goals) ? soft.active_goals : []),
  ], 6);
}

function collectRecoContextIngredientTerms(recoContext) {
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  return normalizeStringArray([
    ...(Array.isArray(hard.ingredient_targets) ? hard.ingredient_targets : []),
    ...(Array.isArray(soft.ingredient_targets) ? soft.ingredient_targets : []),
  ], 6);
}

function collectRecoContextConcernTerms(recoContext) {
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  const out = [];
  const barrierStatus = pickFirstTrimmed(hard.barrier_status, soft.barrier_status);
  const sensitivity = pickFirstTrimmed(hard.sensitivity, soft.sensitivity);
  if (barrierStatus === 'impaired' || barrierStatus === 'reactive') out.push('barrier repair');
  if (barrierStatus === 'healthy') out.push('skin barrier');
  if (sensitivity === 'high' || sensitivity === 'medium') out.push('sensitive skin');
  const riskAxes = Array.isArray(soft.risk_axes) ? soft.risk_axes : [];
  for (const item of riskAxes) {
    const text = normalizeQueryToken(item);
    if (!text) continue;
    out.push(text.replace(/:/g, ' '));
  }
  return normalizeStringArray(out, 6);
}

function collectProfileGoalTerms(profileSummary, recoContext = null) {
  const raw = [];
  if (typeof profileSummary?.goal_primary === 'string') raw.push(profileSummary.goal_primary);
  if (Array.isArray(profileSummary?.goals)) raw.push(...profileSummary.goals);
  raw.push(...collectRecoContextGoalTerms(recoContext));
  return uniqCaseInsensitiveStrings(
    raw
      .map((item) => normalizeQueryToken(item))
      .filter(Boolean)
      .flatMap((item) => item.split(/[|,/;]+/g).map((token) => token.trim()).filter(Boolean)),
    6,
  );
}

function collectIngredientTerms(ingredientContext, recoContext = null) {
  const ctx = isPlainObject(ingredientContext) ? ingredientContext : {};
  const candidates = Array.isArray(ctx.candidates) ? ctx.candidates : [];
  const rawTerms = normalizeStringArray([
    normalizeQueryToken(ctx.query),
    ...candidates.map((item) => normalizeQueryToken(item)),
    ...collectRecoContextIngredientTerms(recoContext),
  ], 6);
  const ingredientId = pickFirstTrimmed(
    ctx.ingredient_id,
    ctx.ingredientId,
    ctx.canonical_ingredient_id,
    ctx.canonicalIngredientId,
  );
  const recallProfile = resolveIngredientRecallProfile({
    target: ctx,
    query: rawTerms.join(' '),
    ingredientId,
  });
  const canonicalTerms = normalizeStringArray([
    pickFirstTrimmed(recallProfile?.display_name, recallProfile?.ingredient_name),
    ...(Array.isArray(recallProfile?.exact_phrases) ? recallProfile.exact_phrases.slice(0, 2) : []),
    ...(Array.isArray(recallProfile?.alias_phrases) ? recallProfile.alias_phrases.slice(0, 2) : []),
  ], 6);
  return uniqCaseInsensitiveStrings(
    [
      ...canonicalTerms,
      ...rawTerms,
    ].filter(Boolean),
    4,
  );
}

function isSeedTermCompatibleWithTargetStep(seedTerm, targetStep) {
  const normalizedStep = normalizeRecoTargetStep(targetStep);
  const normalizedSeed = normalizeQueryToken(seedTerm);
  if (!normalizedStep || !normalizedSeed) return Boolean(normalizedSeed);
  const recallProfile = resolveIngredientRecallProfile({ query: normalizedSeed });
  const expectedFamilies = Array.isArray(recallProfile?.expected_step_families)
    ? recallProfile.expected_step_families.map((item) => normalizeRecoTargetStep(item)).filter(Boolean)
    : [];
  if (expectedFamilies.length) {
    return expectedFamilies.includes(normalizedStep);
  }
  const stepIntent = resolveRecoTargetStepIntent({ text: normalizedSeed });
  const seedStep = normalizeRecoTargetStep(stepIntent?.resolved_target_step);
  if (!seedStep) return true;
  return getRecoTargetFamilyRelation(normalizedStep, seedStep) !== 'incompatible_family';
}

function collectConcernTerms(profileSummary, ingredientContext, recoContext = null) {
  const raw = [
    ...collectProfileGoalTerms(profileSummary, recoContext),
    normalizeQueryToken(ingredientContext && ingredientContext.goal),
    ...collectRecoContextConcernTerms(recoContext),
  ];
  return uniqCaseInsensitiveStrings(
    raw
      .filter(Boolean)
      .flatMap((item) => item.split(/[|,/;]+/g).map((token) => token.trim()).filter(Boolean)),
    6,
  );
}

function getStepPolicy(step) {
  const normalized = normalizeRecoTargetStep(step) || 'default';
  return STEP_THRESHOLDS[normalized] || STEP_THRESHOLDS.default;
}

function looksLikeGenericSingleProductAsk(text) {
  const normalized = normalizeQueryToken(text).toLowerCase();
  if (!normalized) return false;
  if (
    /\b(cleanser|face wash|serum|essence|toner|sunscreen|sun screen|spf|sunblock|moisturizer|moisturiser|cream|lotion|gel cream|mask|retinol|retinoid|acid|treatment|oil)\b/.test(normalized)
    || /(防晒|洁面|洗面奶|精华|面霜|乳液|面膜|刷酸|维a|护肤油)/.test(normalized)
  ) {
    return false;
  }
  if (
    /\b(products|routine|regimen|steps|kit|set|compare|alternatives?)\b/.test(normalized)
    || /(套装|流程|步骤|routine|平替|替代)/.test(normalized)
  ) {
    return false;
  }
  return (
    /\bwhat product should i use\b/.test(normalized)
    || /\bwhich product should i use\b/.test(normalized)
    || /\bwhat should i use\b/.test(normalized)
    || /\bwhat do you recommend\b/.test(normalized)
    || /\bwhat should i get\b/.test(normalized)
    || /\bwhat should i buy\b/.test(normalized)
    || /\bwhat can i use\b/.test(normalized)
  );
}

function collectConcernFrameworkSignals({ text = '', focus = '', profileSummary = null } = {}) {
  const normalized = `${normalizeQueryToken(text)} ${normalizeQueryToken(focus)}`.trim().toLowerCase();
  const goals = Array.isArray(profileSummary?.goals) ? profileSummary.goals.map((item) => normalizeQueryToken(item).toLowerCase()) : [];
  const skinType = normalizeQueryToken(profileSummary?.skin_type || profileSummary?.skinType || profileSummary?.skin_type_tendency).toLowerCase();
  const sensitivity = normalizeQueryToken(profileSummary?.sensitivity || profileSummary?.sensitivity_tendency).toLowerCase();
  const barrier = normalizeQueryToken(profileSummary?.barrier_status || profileSummary?.barrierStatus).toLowerCase();
  const haystack = [normalized, skinType, sensitivity, barrier, ...goals].filter(Boolean).join(' ');
  return {
    oily: /\boily\b|出油|油皮|控油|sebum|shine|greasy/.test(haystack),
    acne: /\bacne\b|\bbreakout\b|blemish|spot|pore|痘|闭口|粉刺|毛孔/.test(haystack),
    dry: /\bdry\b|dehydrat|干燥|缺水|起皮|脱皮/.test(haystack),
    redness: /redness|flush|泛红|发红|红血丝/.test(haystack),
    sensitive: /\bsensitive\b|敏感|刺激|stinging|reactive/.test(haystack),
    barrier: /barrier|repair|修护|屏障|受损|impaired/.test(haystack),
  };
}

function buildConcernRoleDescriptor({
  roleId,
  rank,
  preferredStep,
  labelEn,
  labelZh,
  whyEn,
  whyZh,
  queryTerms = [],
  alternateSteps = [],
  fitKeywords = [],
  ingredientHypotheses = [],
  productTypeHypotheses = [],
  frequency = 'daily',
  routineSlots = [],
  supportOnly = false,
  isCn = false,
} = {}) {
  const normalizedPreferredStep = normalizeRecoTargetStep(preferredStep) || preferredStep || 'treatment';
  return {
    role_id: String(roleId || '').trim() || null,
    rank: Number.isFinite(Number(rank)) ? Number(rank) : null,
    preferred_step: normalizedPreferredStep,
    alternate_steps: uniqCaseInsensitiveStrings(
      (Array.isArray(alternateSteps) ? alternateSteps : [alternateSteps])
        .map((value) => normalizeRecoTargetStep(value))
        .filter(Boolean),
      4,
    ),
    slot: inferSlotForStep(normalizedPreferredStep),
    label: isCn ? labelZh : labelEn,
    why_this_role: isCn ? whyZh : whyEn,
    query_terms: uniqCaseInsensitiveStrings(queryTerms, 6),
    fit_keywords: uniqCaseInsensitiveStrings(fitKeywords, 10),
    ingredient_hypotheses: uniqCaseInsensitiveStrings(ingredientHypotheses, 8),
    product_type_hypotheses: uniqCaseInsensitiveStrings(
      [
        normalizedPreferredStep,
        ...(Array.isArray(productTypeHypotheses) ? productTypeHypotheses : [productTypeHypotheses]),
      ]
        .map((value) => normalizeRecoTargetStep(value) || normalizeQueryToken(value))
        .filter(Boolean),
      4,
    ),
    frequency: String(frequency || '').trim() || 'daily',
    routine_slots: uniqCaseInsensitiveStrings(
      (Array.isArray(routineSlots) ? routineSlots : [routineSlots])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => value === 'am' || value === 'pm' || value === 'optional'),
      3,
    ),
    support_only: supportOnly === true,
  };
}

function buildConcernSemanticPlanFallback({ text = '', focus = '', profileSummary = null } = {}) {
  const signals = collectConcernFrameworkSignals({ text, focus, profileSummary });
  const isCn = /[\u4e00-\u9fff]/.test(`${text} ${focus}`);
  const coreRoles = [];
  const supportRoles = [];

  if (signals.oily || signals.acne) {
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'oil_control_treatment',
        rank: 1,
        preferredStep: 'treatment',
        labelEn: 'Oil-control treatment',
        labelZh: '控油功效产品',
        whyEn: 'Start with a targeted oil-control step to manage shine, congestion, or clogged pores.',
        whyZh: '先用针对控油和毛孔的功效产品，把出油和堵塞问题压住。',
        queryTerms: ['oil control serum', 'oil balance serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
        alternateSteps: ['serum'],
        fitKeywords: ['oil control', 'oil balance', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
        ingredientHypotheses: signals.acne ? ['Niacinamide', 'Zinc PCA', 'Salicylic acid'] : ['Niacinamide', 'Zinc PCA'],
        productTypeHypotheses: ['treatment', 'serum'],
        frequency: 'daily_once_or_twice',
        routineSlots: ['am', 'pm'],
        isCn,
      }),
    );
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'lightweight_moisturizer',
        rank: 2,
        preferredStep: 'moisturizer',
        labelEn: 'Lightweight moisturizer',
        labelZh: '轻薄保湿',
        whyEn: 'Keep hydration light and breathable so skin stays balanced without feeling heavy.',
        whyZh: '保湿需要轻薄透气，维持水油平衡但不要厚重闷脸。',
        queryTerms: ['lightweight moisturizer oily skin', 'gel cream oily skin', 'barrier lotion oily skin'],
        fitKeywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
        ingredientHypotheses: ['Glycerin', 'Ceramide NP', 'Panthenol'],
        productTypeHypotheses: ['moisturizer'],
        frequency: 'daily_twice',
        routineSlots: ['am', 'pm'],
        isCn,
      }),
    );
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'daily_sunscreen',
        rank: 3,
        preferredStep: 'sunscreen',
        labelEn: 'Daily sunscreen',
        labelZh: '日常防晒',
        whyEn: 'Daytime UV protection still matters, but it is supporting care rather than the first fix.',
        whyZh: '白天防晒仍然重要，但它是支持步骤，不是第一优先修复点。',
        queryTerms: ['oil control sunscreen', 'lightweight sunscreen oily skin', 'spf oily skin'],
        fitKeywords: ['oil control', 'lightweight', 'uv filters', 'spf', 'non-greasy'],
        ingredientHypotheses: ['UV filters'],
        productTypeHypotheses: ['sunscreen'],
        frequency: 'daily_am',
        routineSlots: ['am'],
        isCn,
      }),
    );
    if (signals.dry || signals.barrier) {
      supportRoles.push(
        buildConcernRoleDescriptor({
          roleId: 'hydrating_mask_support',
          rank: 1,
          preferredStep: 'mask',
          labelEn: 'Optional hydrating mask',
          labelZh: '可选补水面膜',
          whyEn: 'Only add an occasional mask if oily skin also feels dehydrated or tight.',
          whyZh: '只有在油皮同时缺水或紧绷时，才补充偶尔使用的补水面膜。',
          queryTerms: ['hydrating mask dehydrated oily skin', 'smoothing mask oily dehydrated skin'],
          fitKeywords: ['hydrating mask', 'soothing mask', 'smoothing mask', 'overnight mask'],
          ingredientHypotheses: ['Hyaluronic acid', 'Panthenol'],
          productTypeHypotheses: ['mask'],
          frequency: 'optional_weekly',
          routineSlots: ['optional', 'pm'],
          supportOnly: true,
          isCn,
        }),
      );
    }
  } else if (signals.barrier || signals.sensitive || signals.redness || signals.dry) {
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'barrier_moisturizer',
        rank: 1,
        preferredStep: 'moisturizer',
        labelEn: 'Barrier-support moisturizer',
        labelZh: '屏障修护保湿',
        whyEn: 'Use a barrier-first moisturizer to reduce irritation and improve baseline comfort.',
        whyZh: '先用屏障修护保湿把耐受和舒适度稳住。',
        queryTerms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
        fitKeywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin', 'fragrance free'],
        ingredientHypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
        productTypeHypotheses: ['moisturizer'],
        frequency: 'daily_twice',
        routineSlots: ['am', 'pm'],
        isCn,
      }),
    );
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'soothing_treatment',
        rank: 2,
        preferredStep: 'treatment',
        labelEn: 'Soothing treatment',
        labelZh: '舒缓功效产品',
        whyEn: 'Add a gentle soothing treatment if redness or reactivity is still active.',
        whyZh: '如果泛红和敏感还在，补一个温和舒缓的功效步骤。',
        queryTerms: ['soothing serum sensitive skin', 'cica serum redness', 'panthenol treatment'],
        alternateSteps: ['serum'],
        fitKeywords: ['soothing', 'cica', 'panthenol', 'redness', 'calming'],
        ingredientHypotheses: ['Panthenol', 'Madecassoside'],
        productTypeHypotheses: ['treatment', 'serum'],
        frequency: 'daily_once',
        routineSlots: ['pm'],
        isCn,
      }),
    );
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'daily_sunscreen',
        rank: 3,
        preferredStep: 'sunscreen',
        labelEn: 'Daily sunscreen',
        labelZh: '日常防晒',
        whyEn: 'Protect the routine during the day while the barrier is recovering.',
        whyZh: '在白天保护修护流程，避免恢复期继续受刺激。',
        queryTerms: ['sensitive skin sunscreen', 'barrier sunscreen', 'spf sensitive skin'],
        fitKeywords: ['sensitive skin', 'barrier', 'spf', 'lightweight'],
        ingredientHypotheses: ['UV filters'],
        productTypeHypotheses: ['sunscreen'],
        frequency: 'daily_am',
        routineSlots: ['am'],
        isCn,
      }),
    );
  } else {
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'targeted_treatment',
        rank: 1,
        preferredStep: 'treatment',
        labelEn: 'Targeted treatment',
        labelZh: '针对性功效产品',
        whyEn: 'Start with the role that addresses the main skin concern directly.',
        whyZh: '先上最针对当前问题的功效步骤。',
        queryTerms: ['targeted treatment skincare', 'skin concern serum', 'treatment skincare'],
        alternateSteps: ['serum'],
        fitKeywords: ['targeted', 'treatment', 'serum'],
        ingredientHypotheses: ['Niacinamide'],
        productTypeHypotheses: ['treatment', 'serum'],
        frequency: 'daily_once',
        routineSlots: ['pm'],
        isCn,
      }),
    );
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'supporting_moisturizer',
        rank: 2,
        preferredStep: 'moisturizer',
        labelEn: 'Supporting moisturizer',
        labelZh: '配套保湿',
        whyEn: 'Pair the active step with a moisturizer that keeps the routine tolerable.',
        whyZh: '搭配一个能稳住耐受的保湿步骤。',
        queryTerms: ['supporting moisturizer skincare', 'barrier moisturizer', 'light moisturizer'],
        fitKeywords: ['barrier', 'light moisturizer', 'supportive'],
        ingredientHypotheses: ['Glycerin', 'Ceramide NP'],
        productTypeHypotheses: ['moisturizer'],
        frequency: 'daily_twice',
        routineSlots: ['am', 'pm'],
        isCn,
      }),
    );
    coreRoles.push(
      buildConcernRoleDescriptor({
        roleId: 'daily_sunscreen',
        rank: 3,
        preferredStep: 'sunscreen',
        labelEn: 'Daily sunscreen',
        labelZh: '日常防晒',
        whyEn: 'Protect the routine during the day so the treatment work is not undermined.',
        whyZh: '白天用防晒把前面的护理效果保住。',
        queryTerms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
        fitKeywords: ['spf', 'uv filters', 'broad spectrum'],
        ingredientHypotheses: ['UV filters'],
        productTypeHypotheses: ['sunscreen'],
        frequency: 'daily_am',
        routineSlots: ['am'],
        isCn,
      }),
    );
  }

  const primaryConcern = signals.oily || signals.acne
    ? (isCn ? '油脂分泌与堵塞' : 'oil control and congestion')
    : signals.barrier || signals.sensitive || signals.redness || signals.dry
      ? (isCn ? '屏障与敏感稳定' : 'barrier support and tolerance')
      : (isCn ? '针对当前主诉的护理' : 'targeted concern control');
  const ingredientHypotheses = uniqCaseInsensitiveStrings(
    [
      ...coreRoles.flatMap((role) => Array.isArray(role.ingredient_hypotheses) ? role.ingredient_hypotheses : []),
      ...supportRoles.flatMap((role) => Array.isArray(role.ingredient_hypotheses) ? role.ingredient_hypotheses : []),
    ],
    12,
  );
  const productTypeHypotheses = uniqCaseInsensitiveStrings(
    [
      ...coreRoles.flatMap((role) => Array.isArray(role.product_type_hypotheses) ? role.product_type_hypotheses : []),
      ...supportRoles.flatMap((role) => Array.isArray(role.product_type_hypotheses) ? role.product_type_hypotheses : []),
    ],
    8,
  );
  const routineShell = {
    am_core_roles: coreRoles.filter((role) => role.routine_slots.includes('am')).map((role) => role.role_id).filter(Boolean),
    pm_core_roles: coreRoles.filter((role) => role.routine_slots.includes('pm')).map((role) => role.role_id).filter(Boolean),
    optional_support_roles: supportRoles.map((role) => role.role_id).filter(Boolean),
    frequency: Object.fromEntries(
      [...coreRoles, ...supportRoles]
        .filter((role) => role && role.role_id)
        .map((role) => [role.role_id, role.frequency || null]),
    ),
    role_to_step_mapping: Object.fromEntries(
      [...coreRoles, ...supportRoles]
        .filter((role) => role && role.role_id)
        .map((role) => [role.role_id, role.preferred_step || null]),
    ),
  };

  return {
    plan_id: makeSignature('concernplan', {
      version: CONCERN_SEMANTIC_PLAN_VERSION,
      text: normalizeQueryToken(text).toLowerCase(),
      focus: normalizeQueryToken(focus).toLowerCase(),
      core_roles: coreRoles.map((role) => role.role_id),
      support_roles: supportRoles.map((role) => role.role_id),
    }),
    semantic_plan_version: CONCERN_SEMANTIC_PLAN_VERSION,
    intent_mode: 'generic_concern',
    primary_concern: primaryConcern,
    core_roles: coreRoles,
    support_roles: supportRoles,
    ingredient_hypotheses: ingredientHypotheses,
    product_type_hypotheses: productTypeHypotheses,
    frequency_policy: routineShell.frequency,
    routine_shell: routineShell,
    selection_constraints: {
      first_turn_mode: 'framework_plus_products',
      support_cannot_replace_core: true,
      allow_price_tiers: false,
      support_role_budgeted: true,
    },
    selection_owner_source: 'rule_concern_planner_fallback',
    selection_owner_state: 'fallback',
    framework_summary: {
      concern_text: normalizeQueryToken(text || focus),
      headline: isCn
        ? '先明确核心护理角色，再匹配对应商品'
        : 'Start with the core care roles, then match products inside each role',
      prioritized_roles: coreRoles.map((role) => ({
        role_id: role.role_id,
        label: role.label,
        why_this_role: role.why_this_role,
        rank: role.rank,
      })),
      support_roles: supportRoles.map((role) => ({
        role_id: role.role_id,
        label: role.label,
        why_this_role: role.why_this_role,
      })),
      ingredient_hypotheses: ingredientHypotheses,
    },
    concern_signals: signals,
  };
}

function buildConcernTargetContextFromSemanticPlan(plan, { text = '', focus = '', entryType = 'chat' } = {}) {
  const semanticPlan = isPlainObject(plan) ? plan : buildConcernSemanticPlanFallback({ text, focus });
  const coreRoles = Array.isArray(semanticPlan.core_roles) ? semanticPlan.core_roles.filter((role) => isPlainObject(role)) : [];
  const supportRoles = Array.isArray(semanticPlan.support_roles) ? semanticPlan.support_roles.filter((role) => isPlainObject(role)) : [];
  return {
    resolved_target_step: null,
    resolved_target_step_confidence: 'none',
    resolved_target_step_source: 'concern_semantic_plan',
    framework_id: String(semanticPlan.plan_id || '').trim() || null,
    framework_owner_source: String(semanticPlan.selection_owner_source || 'llm_concern_planner').trim() || 'llm_concern_planner',
    framework_owner_state: String(semanticPlan.selection_owner_state || 'trusted').trim() || 'trusted',
    framework_roles: coreRoles,
    support_roles: supportRoles,
    primary_role_id: coreRoles[0]?.role_id || null,
    framework_summary: isPlainObject(semanticPlan.framework_summary) ? semanticPlan.framework_summary : null,
    concern_signals: isPlainObject(semanticPlan.concern_signals)
      ? semanticPlan.concern_signals
      : collectConcernFrameworkSignals({ text, focus }),
    semantic_plan: semanticPlan,
    semantic_plan_version: String(semanticPlan.semantic_plan_version || CONCERN_SEMANTIC_PLAN_VERSION).trim() || CONCERN_SEMANTIC_PLAN_VERSION,
    selection_owner_source: String(semanticPlan.selection_owner_source || 'llm_concern_planner').trim() || 'llm_concern_planner',
    selection_owner_state: String(semanticPlan.selection_owner_state || 'trusted').trim() || 'trusted',
    routine_shell: isPlainObject(semanticPlan.routine_shell) ? semanticPlan.routine_shell : null,
    entry_type: String(entryType || 'chat').trim().toLowerCase() || 'chat',
    step_aware_intent: false,
    mainline_mode: 'framework',
    intent_mode: 'generic_concern',
    concern_framework_policy_version: CONCERN_FRAMEWORK_POLICY_V1,
  };
}

function buildConcernFrameworkRoles({ text = '', focus = '', profileSummary = null } = {}) {
  const semanticPlan = buildConcernSemanticPlanFallback({ text, focus, profileSummary });
  return {
    framework_id: semanticPlan.plan_id,
    framework_owner_source: 'generic_concern_framework_resolver',
    framework_owner_state: 'trusted',
    roles: semanticPlan.core_roles,
    support_roles: semanticPlan.support_roles,
    primary_role_id: semanticPlan.core_roles[0]?.role_id || null,
    concern_signals: semanticPlan.concern_signals,
    framework_summary: semanticPlan.framework_summary,
    semantic_plan: semanticPlan,
  };
}

function resolveRecommendationTargetContext({
  explicitStep = '',
  focus = '',
  text = '',
  entryType = 'chat',
  profileSummary = null,
} = {}) {
  let resolved = resolveRecoTargetStepIntent({
    explicitStep,
    focus,
    text,
  });
  const normalizedEntryType = String(entryType || 'chat').trim().toLowerCase() || 'chat';
  if (
    normalizedEntryType === 'chat'
    && String(resolved.resolved_target_step_confidence || 'none').trim().toLowerCase() === 'none'
    && !normalizeRecoTargetStep(explicitStep)
    && looksLikeGenericSingleProductAsk(text)
  ) {
    const framework = buildConcernFrameworkRoles({
      text,
      focus,
      profileSummary,
    });
    resolved = {
      ...resolved,
      resolved_target_step: null,
      resolved_target_step_confidence: 'none',
      resolved_target_step_source: 'generic_concern_framework',
      framework_id: framework.framework_id,
      framework_owner_source: framework.framework_owner_source,
      framework_owner_state: framework.framework_owner_state,
      framework_roles: framework.roles,
      support_roles: framework.support_roles,
      primary_role_id: framework.primary_role_id,
      framework_summary: framework.framework_summary,
      concern_signals: framework.concern_signals,
      semantic_plan: framework.semantic_plan,
      intent_mode: 'generic_concern',
    };
  }
  const confidence = String(resolved.resolved_target_step_confidence || 'none').trim().toLowerCase() || 'none';
  const step = normalizeRecoTargetStep(resolved.resolved_target_step);
  const hasFrameworkRoles = Array.isArray(resolved.framework_roles) && resolved.framework_roles.length > 0;
  const stepAwareIntent = !hasFrameworkRoles && Boolean(step) && (confidence === 'high' || confidence === 'medium');
  const mainlineMode =
    hasFrameworkRoles
      ? 'framework'
      : confidence === 'high'
      ? 'hard_target'
      : confidence === 'medium'
        ? 'soft_target'
        : 'generic';
  return {
    ...resolved,
    resolved_target_step: step,
    entry_type: normalizedEntryType,
    step_aware_intent: stepAwareIntent,
    mainline_mode: hasFrameworkRoles ? 'framework' : stepAwareIntent ? mainlineMode : 'generic',
    intent_mode: pickFirstTrimmed(resolved.intent_mode, hasFrameworkRoles ? 'generic_concern' : '') || (stepAwareIntent ? 'explicit_role' : 'generic'),
    framework_roles: hasFrameworkRoles ? resolved.framework_roles : [],
    primary_role_id: hasFrameworkRoles ? resolved.primary_role_id || resolved.framework_roles[0]?.role_id || null : null,
    framework_id: hasFrameworkRoles ? resolved.framework_id || null : null,
    framework_owner_source: hasFrameworkRoles ? resolved.framework_owner_source || 'generic_concern_framework_resolver' : null,
    framework_owner_state: hasFrameworkRoles ? resolved.framework_owner_state || 'trusted' : null,
    framework_summary: hasFrameworkRoles ? resolved.framework_summary || null : null,
    semantic_plan: hasFrameworkRoles ? resolved.semantic_plan || null : null,
    support_roles: hasFrameworkRoles && Array.isArray(resolved.support_roles) ? resolved.support_roles : [],
    concern_framework_policy_version: hasFrameworkRoles ? CONCERN_FRAMEWORK_POLICY_V1 : null,
  };
}

function buildSameFamilyQueryLevels({
  targetContext,
  profileSummary,
  ingredientContext,
  recoContext = null,
  lang = 'EN',
  seedTerms = [],
} = {}) {
  const step = normalizeRecoTargetStep(targetContext && targetContext.resolved_target_step);
  if (!step) return [];
  const rawAliases = STEP_QUERY_ALIASES[step] || [step];
  const aliases = uniqCaseInsensitiveStrings(
    (Array.isArray(rawAliases) ? rawAliases : [rawAliases]).filter((alias) => {
      const normalized = normalizeQueryToken(alias).toLowerCase();
      if (!normalized) return false;
      if (step === 'sunscreen' && (normalized === 'sun screen' || normalized === 'spf')) return false;
      return true;
    }),
    8,
  );
  const stepPrimary = aliases[0] || step;
  const rawGoalTerms = collectProfileGoalTerms(profileSummary, recoContext).slice(0, 2);
  const goalTerms = step === 'sunscreen'
    ? []
    : rawGoalTerms;
  const ingredientTerms = collectIngredientTerms(ingredientContext, recoContext).slice(0, 2);
  const profileSkinType = normalizeQueryToken(
    profileSummary?.skin_type || profileSummary?.skinType || profileSummary?.skin_type_tendency,
  ).toLowerCase();
  const sunscreenSkinTypeTerms =
    step === 'sunscreen' && profileSkinType
      ? [/\bskin\b/.test(profileSkinType) ? profileSkinType : `${profileSkinType} skin`]
      : [];
  const concernTerms = uniqCaseInsensitiveStrings(
    [
      ...collectConcernTerms(profileSummary, ingredientContext, recoContext),
      ...sunscreenSkinTypeTerms,
    ]
      .map((item) => normalizeQueryToken(item))
      .filter((item) => {
        const normalized = String(item || '').trim().toLowerCase();
        if (!normalized) return false;
        if (step === 'sunscreen' && /\b(acne|breakout|blemish|spot|spots|pore|pores)\b/.test(normalized)) return false;
        return true;
      }),
    4,
  ).slice(0, 2);
  const normalizedSeedTerms = uniqCaseInsensitiveStrings(
    (Array.isArray(seedTerms) ? seedTerms : [])
      .map((item) => normalizeQueryToken(item))
      .filter((item) => {
        if (!isSeedTermCompatibleWithTargetStep(item, step)) return false;
        if (step === 'sunscreen' && /\b(acne|breakout|blemish|spot|spots|pore|pores)\b/i.test(String(item || ''))) return false;
        return true;
      }),
    4,
  );

  const levels = [
    {
      ladder_level: 'step_goal_ingredient_concern',
      queries: uniqCaseInsensitiveStrings([
        ...goalTerms.flatMap((goal) => ingredientTerms.flatMap((ingredient) => concernTerms.length
          ? concernTerms.map((concern) => joinUniqueQueryParts(stepPrimary, goal, ingredient, concern))
          : [joinUniqueQueryParts(stepPrimary, goal, ingredient)])),
        ...normalizedSeedTerms.flatMap((seed) => goalTerms.flatMap((goal) => [joinUniqueQueryParts(stepPrimary, seed, goal)])),
      ], 8),
    },
    {
      ladder_level: 'step_goal',
      queries: uniqCaseInsensitiveStrings([
        ...goalTerms.map((goal) => joinUniqueQueryParts(stepPrimary, goal)),
      ], 8),
    },
    {
      ladder_level: 'step_concern',
      queries: uniqCaseInsensitiveStrings([
        ...concernTerms.map((concern) => joinUniqueQueryParts(stepPrimary, concern)),
        ...normalizedSeedTerms.map((seed) => joinUniqueQueryParts(stepPrimary, seed)),
      ], 8),
    },
    {
      ladder_level: 'step_only',
      queries: uniqCaseInsensitiveStrings([
        stepPrimary,
      ], 8),
    },
    {
      ladder_level: 'step_alias_expansion',
      queries: uniqCaseInsensitiveStrings(step === 'sunscreen' ? aliases.slice(1, 2) : aliases, 8),
    },
  ];

  const slot = inferSlotForStep(step);
  const seenQueries = new Set();
  return levels
    .map((level, index) => ({
      level_index: index,
      ladder_level: level.ladder_level,
      queries: level.queries
        .map((query) => normalizeQueryToken(query))
        .filter(Boolean)
        .slice(0, 8)
        .map((query) => ({
          query,
          step: String(lang || '').trim().toUpperCase() === 'CN' ? stepPrimary : stepPrimary,
          slot,
          ladder_level: level.ladder_level,
        })),
    }))
    .map((level) => {
      const uniqueQueries = level.queries.filter((row) => {
        const key = normalizeQueryToken(row?.query).toLowerCase();
        if (!key || seenQueries.has(key)) return false;
        seenQueries.add(key);
        return true;
      });
      return {
        ...level,
        queries: uniqueQueries,
      };
    })
    .filter((level) => Array.isArray(level.queries) && level.queries.length > 0);
}

function productKey(product) {
  const row = isPlainObject(product) ? product : {};
  const productId = pickFirstTrimmed(row.product_id, row.productId, row.id);
  const merchantId = pickFirstTrimmed(row.merchant_id, row.merchantId);
  const name = pickFirstTrimmed(row.brand, row.name, row.display_name, row.displayName);
  return `${productId}::${merchantId}::${name}`.toLowerCase();
}

function buildCandidateResolutionFragments(product) {
  const row = isPlainObject(product) ? product : {};
  const fragments = [
    ['title', pickFirstTrimmed(row.display_name, row.displayName, row.name, row.title)],
    ['structured_category', pickFirstTrimmed(row.category, row.category_name, row.categoryName, row.product_type, row.productType, row.type)],
    ...[...(Array.isArray(row.search_aliases) ? row.search_aliases : []), ...(Array.isArray(row.searchAliases) ? row.searchAliases : []), ...(Array.isArray(row.aliases) ? row.aliases : [])].map((value) => ['alias', value]),
    ...[...(Array.isArray(row.benefit_tokens) ? row.benefit_tokens : []), ...(Array.isArray(row.benefit_tags) ? row.benefit_tags : []), ...(Array.isArray(row.benefitTags) ? row.benefitTags : []), ...(Array.isArray(row.benefit_tags_list) ? row.benefit_tags_list : []), ...(Array.isArray(row.benefitTagsList) ? row.benefitTagsList : []), ...(Array.isArray(row.skin_type_tags) ? row.skin_type_tags : [])].map((value) => ['benefit', value]),
    ...[...(Array.isArray(row.tags) ? row.tags : []), ...(Array.isArray(row.tag_tokens) ? row.tag_tokens : [])].map((value) => ['tag', value]),
    ...(Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : []).map((value) => ['ingredient', value]),
    ...[...(Array.isArray(row.description_tokens) ? row.description_tokens : []), pickFirstTrimmed(row.short_description, row.shortDescription, row.description, row.summary, row.subtitle, row.seed_description, row.seedDescription)].map((value) => ['description', value]),
    ['brand', pickFirstTrimmed(row.brand)],
  ];
  return uniqCaseInsensitiveStrings(
    fragments
      .map(([source, value]) => {
        const normalized = normalizeQueryToken(value);
        return normalized ? `${source}::${normalized}` : '';
      })
      .filter(Boolean),
    48,
  ).map((token) => {
    const sepIndex = token.indexOf('::');
    return {
      source: sepIndex > -1 ? token.slice(0, sepIndex) : 'unknown',
      value: sepIndex > -1 ? token.slice(sepIndex + 2) : token,
    };
  });
}

function buildCandidateResolutionText(product) {
  return buildCandidateResolutionFragments(product)
    .map((item) => item.value)
    .join(' ');
}

function hasExplicitSunscreenSignal(text) {
  return EXPLICIT_SUNSCREEN_SIGNAL_RE.test(String(text || '').trim().toLowerCase());
}

function normalizeCandidateStep(product, { targetContext } = {}) {
  const row = isPlainObject(product) ? product : {};
  const stepAwareIntent = Boolean(targetContext?.step_aware_intent && targetContext?.resolved_target_step);
  const resolutionText = buildCandidateResolutionText(row);
  const structuredRaw = pickFirstTrimmed(
    row.product_type,
    row.productType,
    row.category,
    row.category_name,
    row.categoryName,
    row.step,
    row.type,
  );
  const semanticStepText = joinUniqueQueryParts(
    structuredRaw,
    resolutionText,
  );
  if (hasExplicitSunscreenSignal(semanticStepText)) {
    return {
      candidate_step: 'sunscreen',
      candidate_step_source: normalizeProductType(structuredRaw) === 'sunscreen' ? 'structured_category' : 'title_or_tag_alias',
      candidate_step_confidence: normalizeProductType(structuredRaw) === 'sunscreen' ? 'high' : 'medium',
    };
  }
  const structuredStep = normalizeProductType(structuredRaw);
  if (structuredStep) {
    return {
      candidate_step: structuredStep,
      candidate_step_source: 'structured_category',
      candidate_step_confidence: 'high',
    };
  }
  const retrievalStep = normalizeRecoTargetStep(
    pickFirstTrimmed(
      row.retrieval_step,
      row.retrievalStep,
      row.retrieval_slot_step,
      row.retrievalSlotStep,
    ),
  );
  if (retrievalStep && !stepAwareIntent) {
    return {
      candidate_step: retrievalStep,
      candidate_step_source: 'retrieval_step',
      candidate_step_confidence:
        retrievalStep === normalizeRecoTargetStep(targetContext?.resolved_target_step)
          ? 'high'
          : 'medium',
    };
  }
  const resolutionFragments = buildCandidateResolutionFragments(row);
  for (const fragment of resolutionFragments) {
    const fragmentStep = normalizeRecoTargetStep(fragment.value);
    if (!fragmentStep) continue;
    return {
      candidate_step: fragmentStep,
      candidate_step_source:
        fragment.source === 'description'
          ? 'description_alias'
          : fragment.source === 'retrieval_trace'
            ? 'retrieval_trace'
            : fragment.source === 'structured_category'
              ? 'structured_category'
              : 'title_or_tag_alias',
      candidate_step_confidence:
        fragment.source === 'description'
          ? 'medium'
          : fragment.source === 'retrieval_trace'
            ? 'low'
            : 'high',
    };
  }
  const textResolution = resolutionText
    ? resolveRecoTargetStepIntent({
      text: resolutionText,
    })
    : {
      resolved_target_step: null,
      resolved_target_step_confidence: 'none',
      resolved_target_step_source: 'none',
    };
  if (textResolution.resolved_target_step) {
    return {
      candidate_step: normalizeRecoTargetStep(textResolution.resolved_target_step),
      candidate_step_source:
        textResolution.resolved_target_step_source === 'message_alias'
          ? 'title_or_tag_alias'
          : textResolution.resolved_target_step_source === 'message_concept'
            ? 'title_or_tag_concept'
            : textResolution.resolved_target_step_source || 'title_or_tag',
      candidate_step_confidence: textResolution.resolved_target_step_confidence || 'medium',
    };
  }
  const retrievalQuery = normalizeQueryToken(row.retrieval_query || row.query);
  if (retrievalQuery && targetContext?.resolved_target_step && !stepAwareIntent) {
    const retrievalResolution = resolveRecoTargetStepIntent({
      text: retrievalQuery,
    });
    if (normalizeRecoTargetStep(retrievalResolution.resolved_target_step) === normalizeRecoTargetStep(targetContext.resolved_target_step)) {
      return {
        candidate_step: normalizeRecoTargetStep(retrievalResolution.resolved_target_step),
        candidate_step_source: 'retrieval_trace',
        candidate_step_confidence: retrievalResolution.resolved_target_step_confidence || 'low',
      };
    }
  }
  return {
    candidate_step: null,
    candidate_step_source: 'none',
    candidate_step_confidence: 'none',
  };
}

function resolveCandidateFamilyRelation(targetStep, candidateStep) {
  const target = normalizeRecoTargetStep(targetStep);
  const candidate = normalizeRecoTargetStep(candidateStep);
  if (!target) return 'same_family';
  if (!candidate) return 'unknown';
  return getRecoTargetFamilyRelation(target, candidate);
}

function buildCandidateTextSearch(product) {
  const row = isPlainObject(product) ? product : {};
  return [
    pickFirstTrimmed(row.brand),
    pickFirstTrimmed(row.display_name, row.displayName, row.name, row.title),
    pickFirstTrimmed(row.category, row.category_name, row.categoryName, row.product_type, row.productType),
    ...(Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : []),
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.tag_tokens) ? row.tag_tokens : []),
  ]
    .map((item) => normalizeQueryToken(item).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function arrayIncludesPhrase(text, values = []) {
  const haystack = String(text || '').trim().toLowerCase();
  if (!haystack) return false;
  return (Array.isArray(values) ? values : []).some((raw) => {
    const token = normalizeQueryToken(raw).toLowerCase();
    return token && haystack.includes(token);
  });
}

function clampScore(value, min = 0, max = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function scoreGoalContext(goal, productText) {
  const token = normalizeQueryToken(goal).toLowerCase();
  if (!token) return 0;
  if (/barrier|repair|修护/.test(token)) {
    return /(barrier|repair|ceramide|cica|soothing|calming|gel cream|cream|lotion|面霜|保湿)/i.test(productText) ? 0.28 : 0;
  }
  if (/hydrat|dry|保湿|补水/.test(token)) {
    return /(hydrat|moist|cream|lotion|emulsion|gel cream|保湿|补水|乳液|面霜)/i.test(productText) ? 0.2 : 0;
  }
  if (/acne|breakout|痘/.test(token)) {
    return /(niacinamide|salicylic|azelaic|blemish|acne|spot)/i.test(productText) ? 0.16 : 0;
  }
  return 0;
}

function computeCandidateContextSignals(product, recoContext = null) {
  const row = isPlainObject(product) ? product : {};
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  const productText = buildCandidateTextSearch(row);
  const ingredientTokens = (Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : [])
    .map((item) => normalizeQueryToken(item).toLowerCase())
    .filter(Boolean);
  const hardAvoid = normalizeStringArray(hard.ingredient_avoid, 12).map((item) => item.toLowerCase());
  const targetTerms = normalizeStringArray([
    ...(Array.isArray(hard.ingredient_targets) ? hard.ingredient_targets : []),
    ...(Array.isArray(soft.ingredient_targets) ? soft.ingredient_targets : []),
  ], 12);
  const goals = normalizeStringArray([
    ...(Array.isArray(hard.active_goals) ? hard.active_goals : []),
    ...(Array.isArray(soft.background_goals) ? soft.background_goals : []),
  ], 8);
  const barrierStatus = pickFirstTrimmed(hard.barrier_status, soft.barrier_status).toLowerCase();
  const sensitivity = pickFirstTrimmed(hard.sensitivity, soft.sensitivity).toLowerCase();
  const strongActivePattern = /\b(retinol|retinoid|aha|bha|acid|peel|exfoliat|benzoyl)\b/i;
  let constraintConflict = false;
  let contextFitScore = 0;

  if (hardAvoid.length && (arrayIncludesPhrase(productText, hardAvoid) || ingredientTokens.some((token) => hardAvoid.some((avoid) => token.includes(avoid))))) {
    constraintConflict = true;
  }
  if (!constraintConflict && (barrierStatus === 'impaired' || barrierStatus === 'reactive') && strongActivePattern.test(productText)) {
    constraintConflict = true;
  }
  if (!constraintConflict && sensitivity === 'high' && strongActivePattern.test(productText)) {
    constraintConflict = true;
  }
  if (constraintConflict) {
    return {
      context_fit_score: 0,
      constraint_conflict: true,
      artifact_context_applied: goals.length > 0 || targetTerms.length > 0 || Boolean(barrierStatus || sensitivity || hardAvoid.length),
    };
  }

  for (const goal of goals) {
    contextFitScore += scoreGoalContext(goal, productText);
  }
  if (barrierStatus === 'impaired' || barrierStatus === 'reactive') {
    if (/(barrier|repair|ceramide|cica|soothing|calming|cream|lotion|面霜|保湿)/i.test(productText)) contextFitScore += 0.24;
  }
  if (sensitivity === 'high' || sensitivity === 'medium') {
    if (/(gentle|fragrance free|fragrance-free|for sensitive|sensitive skin|soothing|calming|无香|敏感)/i.test(productText)) contextFitScore += 0.18;
  }
  if (targetTerms.length) {
    for (const term of targetTerms) {
      if (arrayIncludesPhrase(productText, [term]) || ingredientTokens.some((token) => token.includes(term.toLowerCase()))) {
        contextFitScore += 0.18;
      }
    }
  }

  return {
    context_fit_score: clampScore(contextFitScore, 0, 1),
    constraint_conflict: false,
    artifact_context_applied: goals.length > 0 || targetTerms.length > 0 || Boolean(barrierStatus || sensitivity || hardAvoid.length),
  };
}

function normalizeViabilityScore({ relation, candidateStep, targetStep }) {
  if (!targetStep) return 0.75;
  if (relation === 'same_family') {
    return candidateStep === targetStep ? 1 : 0.9;
  }
  if (relation === 'adjacent_family') return 0.58;
  if (relation === 'unknown') return 0.42;
  return 0;
}

function classifyRecommendationCandidate(product, { targetContext, recoContext } = {}) {
  const row = isPlainObject(product) ? product : null;
  if (!row) return null;
  const skincareDomainClass = classifySkincareCandidateDomain(row);
  const skincare = skincareDomainClass !== 'explicit_non_skincare';
  const domainPenalty = skincareDomainClass === 'ambiguous' ? 0.08 : 0;
  const stepResolution = normalizeCandidateStep(row, { targetContext });
  const candidateStep = stepResolution.candidate_step;
  const stepAwareIntent = Boolean(targetContext && targetContext.step_aware_intent && targetContext.resolved_target_step);
  const resolvedTargetStep = normalizeRecoTargetStep(targetContext && targetContext.resolved_target_step);
  const relation = stepAwareIntent
    ? resolveCandidateFamilyRelation(resolvedTargetStep, candidateStep)
    : 'same_family';
  const contextSignals = computeCandidateContextSignals(row, recoContext);
  const stepFitScore = normalizeViabilityScore({
    relation,
    candidateStep,
    targetStep: resolvedTargetStep,
  });
  const selectionScore = clampScore(
    stepFitScore + Number(contextSignals.context_fit_score || 0) - domainPenalty,
    0,
    2,
  );

  let bucket = 'viable';
  let reason = 'generic_viable';
  if (!skincare) {
    bucket = 'hard_reject';
    reason = 'non_skincare_or_blacklisted';
  } else if (contextSignals.constraint_conflict) {
    bucket = 'hard_reject';
    reason = 'hard_constraint_conflict';
  } else if (stepAwareIntent && relation === 'incompatible_family') {
    bucket = 'hard_reject';
    reason = 'incompatible_family';
  } else if (stepAwareIntent && (relation === 'adjacent_family' || relation === 'unknown')) {
    bucket = 'soft_mismatch';
    reason = relation === 'adjacent_family' ? 'adjacent_family' : 'step_unresolved';
  } else if (stepAwareIntent && relation === 'same_family') {
    bucket = 'viable';
    reason = candidateStep === resolvedTargetStep ? 'exact_step_match' : 'same_family_match';
  }

  const itemTargetFidelity =
    bucket === 'viable'
      ? clampScore(
        Math.max(
          stepFitScore,
          (stepFitScore * 0.7) + (Number(contextSignals.context_fit_score || 0) * 0.3),
        ),
        0,
        1,
      )
      : bucket === 'soft_mismatch'
        ? 0.5
        : 0;

  return {
    product: row,
    candidate_step: candidateStep,
    candidate_step_source: stepResolution.candidate_step_source || 'none',
    candidate_step_confidence: stepResolution.candidate_step_confidence || 'none',
    family_relation: relation,
    bucket,
    reason,
    score: stepFitScore,
    skincare_domain_class: skincareDomainClass,
    skincare_domain_penalty: domainPenalty,
    step_fit_score: stepFitScore,
    context_fit_score: Number(contextSignals.context_fit_score || 0),
    constraint_conflict: Boolean(contextSignals.constraint_conflict),
    artifact_context_applied: Boolean(contextSignals.artifact_context_applied),
    selection_score: selectionScore,
    item_target_fidelity: itemTargetFidelity,
  };
}

function summarizePrimaryDisplayGroups(selected) {
  const items = Array.isArray(selected) ? selected : [];
  if (!items.length) return [];
  const groupTargetFidelity = items.reduce((min, item) => Math.min(min, Number(item.item_target_fidelity || 0)), 1);
  return [
    {
      group_id: 'primary',
      group_target_fidelity: groupTargetFidelity,
      items: items.map((item) => ({
        product_id: pickFirstTrimmed(item.product?.product_id, item.product?.productId),
        candidate_step: item.candidate_step || null,
        item_target_fidelity: Number(item.item_target_fidelity || 0),
      })),
    },
  ];
}

function finalizeRecommendationCandidatePools(rawCandidates, { targetContext, recoContext = null } = {}) {
  const deduped = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const row = isPlainObject(raw) ? raw : null;
    if (!row) continue;
    const key = productKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const classified = deduped
    .map((row) => classifyRecommendationCandidate(row, { targetContext, recoContext }))
    .filter(Boolean);

  const viable = classified
    .filter((row) => row.bucket === 'viable')
    .sort((left, right) => right.selection_score - left.selection_score || right.step_fit_score - left.step_fit_score);
  const softMismatch = classified
    .filter((row) => row.bucket === 'soft_mismatch')
    .sort((left, right) => right.selection_score - left.selection_score || right.step_fit_score - left.step_fit_score);
  const hardReject = classified.filter((row) => row.bucket === 'hard_reject');
  const thresholds = getStepPolicy(targetContext && targetContext.resolved_target_step);
  const exactStepViableCount = viable.filter((row) => row.candidate_step && row.candidate_step === targetContext?.resolved_target_step).length;
  const sameFamilyViableCount = viable.length;
  const averageContextFit = viable.length
    ? viable.reduce((sum, row) => sum + Number(row.context_fit_score || 0), 0) / viable.length
    : 0;
  const sameFamilySuccessThresholdMet = Boolean(
    sameFamilyViableCount >= Number(thresholds.min_viable_count_for_step || 1)
      && viable.some((row) => Number(row.selection_score || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72)),
  );
  const sameFamilyStrongViableExists = viable.some((row) => Number(row.selection_score || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72));
  const selected = viable.slice(0, 3);
  const selectedFamilies = uniqCaseInsensitiveStrings(selected.map((row) => row.candidate_step || row.family_relation || 'unknown'), 3);
  const topCandidatesConverged = selectedFamilies.length <= 1;
  const primaryDisplayGroups = summarizePrimaryDisplayGroups(selected);
  const overallTargetFidelitySatisfied = primaryDisplayGroups.length > 0
    && primaryDisplayGroups.every((group) => Number(group.group_target_fidelity || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72));
  const hardConstraintConflict = viable.some((row) => row.constraint_conflict === true) || selected.some((row) => row.constraint_conflict === true);
  const weakViablePool = Boolean(targetContext?.step_aware_intent) && selected.length === 0 && softMismatch.length > 0;
  const softTargetSuccessAllowed =
    targetContext?.mainline_mode === 'soft_target'
      ? Boolean(
        (exactStepViableCount > 0 || sameFamilyStrongViableExists)
          && topCandidatesConverged
          && !hardConstraintConflict
          && overallTargetFidelitySatisfied,
      )
      : null;
  const hardTargetSuccessAllowed =
    targetContext?.mainline_mode === 'hard_target'
      ? Boolean(exactStepViableCount > 0 && !hardConstraintConflict && overallTargetFidelitySatisfied)
      : null;
  const terminalSuccess = Boolean(
    !targetContext?.step_aware_intent
      ? selected.length > 0
      : targetContext.mainline_mode === 'soft_target'
        ? softTargetSuccessAllowed
        : hardTargetSuccessAllowed,
  );
  const familyMatchType = !targetContext?.step_aware_intent
    ? null
    : exactStepViableCount > 0
      ? 'exact_step'
      : sameFamilyViableCount > 0
        ? 'same_family'
        : softMismatch.length > 0
          ? 'adjacent_family'
          : 'incompatible_family';
  const targetFidelityLevel = overallTargetFidelitySatisfied
    ? 'satisfied'
    : selected.length > 0 || viable.length > 0 || softMismatch.length > 0
      ? 'partial'
      : 'failed';
  const viablePoolStrength = selected.length > 0
    ? (terminalSuccess ? 'strong' : 'weak')
    : (softMismatch.length > 0 || viable.length > 0 ? 'weak' : 'empty');
  const artifactContextApplied = classified.some((row) => row.artifact_context_applied === true);

  return {
    raw_candidate_pool: deduped,
    viable_candidate_pool: viable.map((row) => row.product),
    selected_recommendations: selected.map((row) => row.product),
    primary_display_groups: primaryDisplayGroups,
    auxiliary_groups: [],
    debug_only_groups: [],
    raw_candidate_count: deduped.length,
    viable_candidate_count: viable.length,
    exact_step_viable_count: exactStepViableCount,
    same_family_viable_count: sameFamilyViableCount,
    soft_mismatch_count: softMismatch.length,
    hard_reject_count: hardReject.length,
    pre_llm_selected_candidate_count: selected.length,
    final_selected_candidate_count: selected.length,
    selected_candidate_count: selected.length,
    hard_reject: hardReject,
    soft_mismatch: softMismatch,
    viable,
    viable_pool_strength: viablePoolStrength,
    weak_viable_pool: weakViablePool,
    family_match_type: familyMatchType,
    item_target_fidelity: selected.map((row) => row.item_target_fidelity),
    group_target_fidelity: primaryDisplayGroups.map((group) => group.group_target_fidelity),
    target_fidelity_level: targetFidelityLevel,
    overall_target_fidelity_satisfied: overallTargetFidelitySatisfied,
    target_fidelity_satisfied: overallTargetFidelitySatisfied,
    top_candidates_converged: topCandidatesConverged,
    same_family_strong_viable_exists: sameFamilyStrongViableExists,
    same_family_success_threshold_met: sameFamilySuccessThresholdMet,
    hard_constraint_conflict: hardConstraintConflict,
    constraint_conflict: hardConstraintConflict,
    average_context_fit_score: Number(averageContextFit.toFixed(4)),
    artifact_context_applied: artifactContextApplied,
    terminal_success: terminalSuccess,
    reco_policy_version: RECOMMENDATION_RECO_POLICY_V1,
    raw_candidate_pool_debug_signature: makeSignature('rawpool', {
      version: RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION,
      ids: deduped.map((row) => productKey(row)).filter(Boolean).sort(),
      target_step: targetContext?.resolved_target_step || null,
    }),
    candidate_pool_signature: makeSignature('viablepool', {
      version: CANDIDATE_POOL_SIGNATURE_VERSION,
      ids: viable.map((row) => productKey(row.product)).filter(Boolean).sort(),
      target_step: targetContext?.resolved_target_step || null,
      viable_candidate_count: viable.length,
      soft_mismatch_count: softMismatch.length,
      hard_reject_count: hardReject.length,
    }),
  };
}

function shouldStopStepAwareBroadening(poolState, { targetContext } = {}) {
  if (!targetContext?.step_aware_intent) return false;
  const thresholds = getStepPolicy(targetContext.resolved_target_step);
  const viableCount = Number(poolState?.same_family_viable_count || 0);
  const sameFamilyStrongViableExists = Boolean(poolState?.same_family_strong_viable_exists);
  return viableCount >= Number(thresholds.min_viable_count_for_step || 1) && sameFamilyStrongViableExists;
}

function deriveStepAwareEmptyReason(targetContext, poolState) {
  if (poolState?.weak_viable_pool) return 'weak_viable_pool_for_target';
  if (targetContext?.step_aware_intent) return 'no_viable_candidates_for_target';
  return 'upstream_missing_or_empty';
}

module.exports = {
  RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  RECOMMENDATION_STEP_QUERY_POLICY_V1,
  RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1,
  RECOMMENDATION_RECO_POLICY_V1,
  CONCERN_FRAMEWORK_POLICY_V1,
  CONCERN_SEMANTIC_PLAN_VERSION,
  CANDIDATE_POOL_SIGNATURE_VERSION,
  RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION,
  GROUP_SEMANTICS_VERSION,
  STEP_THRESHOLDS,
  classifySkincareCandidateDomain,
  isSkincareCandidate,
  classifySkincareCandidate,
  resolveRecommendationTargetContext,
  buildConcernSemanticPlanFallback,
  buildConcernTargetContextFromSemanticPlan,
  buildConcernFrameworkRoles,
  buildSameFamilyQueryLevels,
  finalizeRecommendationCandidatePools,
  shouldStopStepAwareBroadening,
  deriveStepAwareEmptyReason,
  inferSlotForStep,
  normalizeCandidateStep,
};
