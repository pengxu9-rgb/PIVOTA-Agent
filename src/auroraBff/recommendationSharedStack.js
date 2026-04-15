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
const CONCERN_SEMANTIC_PLAN_VERSION = 'concern_semantic_plan_v2';
const REQUEST_CONTEXT_SIGNATURE_VERSION = 'request_context_signature_v1';
const CANDIDATE_POOL_SIGNATURE_VERSION = 'recommendation_viable_pool_signature_v1';
const RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION = 'recommendation_raw_pool_debug_signature_v1';
const GROUP_SEMANTICS_VERSION = 'recommendation_group_semantics_v1';
const MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION = 'minimum_recommendation_context_v1';

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

const STEP_QUERY_LADDER_EXPANSIONS = Object.freeze({
  sunscreen: Object.freeze(['daily sunscreen', 'broad spectrum sunscreen']),
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
    /\b(?:what|which)\s+(?:skincare\s+)?product\s+should\s+i\s+(?:use|buy|get)(?:\s+first)?\b/.test(normalized)
    || /\b(?:what|which)\s+(?:skincare\s+)?products\s+should\s+i\s+(?:use|buy|get)(?:\s+first)?\b/.test(normalized)
    || /\bwhat should i use\b/.test(normalized)
    || /\bwhat do you recommend\b/.test(normalized)
    || /\bwhat should i get\b/.test(normalized)
    || /\bwhat should i buy\b/.test(normalized)
    || /\bwhat can i use\b/.test(normalized)
  );
}

function canonicalizeGenericConcernQuery(text) {
  const normalized = normalizeQueryToken(text);
  if (!normalized) return '';
  if (!looksLikeGenericSingleProductAsk(normalized)) return normalized;
  return normalizeQueryToken(
    normalized
      .replace(/\b(?:what|which)\s+skincare\s+product\s+should\s+i\s+use(?:\s+first)?\b/gi, 'what skincare products should i use')
      .replace(/\b(?:what|which)\s+skincare\s+product\s+should\s+i\s+buy(?:\s+first)?\b/gi, 'what skincare products should i buy')
      .replace(/\b(?:what|which)\s+skincare\s+product\s+should\s+i\s+get(?:\s+first)?\b/gi, 'what skincare products should i get')
      .replace(/\bwhat product should i use\b/gi, 'what products should i use')
      .replace(/\bwhich product should i use\b/gi, 'what products should i use')
      .replace(/\bwhat product should i buy(?:\s+first)?\b/gi, 'what products should i buy')
      .replace(/\bwhich product should i buy(?:\s+first)?\b/gi, 'what products should i buy')
      .replace(/\bwhat product should i get(?:\s+first)?\b/gi, 'what products should i get')
      .replace(/\bwhich product should i get(?:\s+first)?\b/gi, 'what products should i get')
      .replace(/\bwhat product should i use(?:\s+first)?\b/gi, 'what products should i use')
      .replace(/\bwhich product should i use(?:\s+first)?\b/gi, 'what products should i use')
      .replace(/\bwhat should i use\b/gi, 'what products should i use')
      .replace(/\bwhat can i use\b/gi, 'what products can i use')
      .replace(/\bwhat do you recommend\b/gi, 'what products do you recommend')
      .replace(/\bwhat should i get\b/gi, 'what products should i get')
      .replace(/\bwhat should i buy\b/gi, 'what products should i buy'),
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
    oily: /\boily\b|oil control|oil[-\s]?balance|mattify|mattifying|anti-shine|出油|油皮|控油|sebum|shine|greasy/.test(haystack),
    acne: /\bacne\b|\bbreakout\b|blemish|spot|pore|痘|闭口|粉刺|毛孔/.test(haystack),
    dry: /\bdry\b|dehydrat|干燥|缺水|起皮|脱皮/.test(haystack),
    dehydrated: /dehydrat|缺水|tight|thirsty skin|water[-\s]?light|水润/.test(haystack),
    dull: /\bdull\b|brightness|brighten|radiance|glow|uneven tone|暗沉|提亮|透亮/.test(haystack),
    tone_marks: /post[-\s]?(?:breakout|acne)|acne mark|breakout mark|dark spot|hyperpigmentation|uneven tone|tone mark|marks?|痘印|色沉|斑/.test(haystack),
    redness: /redness|flush|泛红|发红|红血丝/.test(haystack),
    sensitive: /\bsensitive\b|敏感|刺激|stinging|reactive/.test(haystack),
    barrier: /barrier|repair|修护|屏障|受损|impaired/.test(haystack),
    sunscreen: /sunscreen|spf|uv|sun protection|防晒|通勤|commute/.test(haystack),
    makeup_layering: /under makeup|makeup|pilling|pill\b|balls up|rolls off|layering|layers?|妆前|搓泥|卡粉/.test(haystack),
    humid: /humid|humidity|hot weather|sweat|commute|闷热|潮湿|出汗/.test(haystack),
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

function buildCanonicalConcernRoleOntology({ isCn = false } = {}) {
  return [
    buildConcernRoleDescriptor({
      roleId: 'oil_control_treatment',
      rank: 10,
      preferredStep: 'treatment',
      labelEn: 'Oil-control treatment',
      labelZh: '控油功效产品',
      whyEn: 'Use a targeted treatment to manage excess shine, sebum, congestion, or clogged pores.',
      whyZh: '用针对性的功效步骤处理出油、油光、堵塞和毛孔问题。',
      queryTerms: ['oil control serum', 'oil balance serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin', 'niacinamide serum oily skin'],
      alternateSteps: ['serum'],
      fitKeywords: ['oil control', 'oil balance', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'clarifying', 'pores'],
      ingredientHypotheses: ['Niacinamide', 'Zinc PCA', 'Salicylic acid'],
      productTypeHypotheses: ['treatment', 'serum'],
      frequency: 'daily_once_or_twice',
      routineSlots: ['am', 'pm'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'acne_clogged_pore_treatment',
      rank: 11,
      preferredStep: 'treatment',
      labelEn: 'Acne and clogged-pore treatment',
      labelZh: '痘痘与堵塞毛孔功效产品',
      whyEn: 'Prioritize a blemish or clogged-pore treatment when the ask is about breakouts, congestion, or clogged pores.',
      whyZh: '当主诉是痘痘、闭口或毛孔堵塞时，优先用针对堵塞和瑕疵的功效产品。',
      queryTerms: ['salicylic acid serum clogged pores', 'acne treatment serum', 'blemish treatment', 'clarifying serum clogged pores', 'pore clearing serum'],
      alternateSteps: ['serum'],
      fitKeywords: ['salicylic acid', 'bha', 'blemish', 'acne', 'clogged pores', 'congestion', 'pore clearing', 'clarifying'],
      ingredientHypotheses: ['Salicylic acid', 'Niacinamide', 'Zinc PCA'],
      productTypeHypotheses: ['treatment', 'serum'],
      frequency: 'daily_or_alternate_nights',
      routineSlots: ['pm'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'lightweight_moisturizer',
      rank: 20,
      preferredStep: 'moisturizer',
      labelEn: 'Lightweight moisturizer',
      labelZh: '轻薄保湿',
      whyEn: 'Keep hydration light and breathable so skin stays balanced without feeling heavy.',
      whyZh: '保湿需要轻薄透气，维持水油平衡但不要厚重闷脸。',
      queryTerms: ['lightweight moisturizer oily skin', 'gel cream oily skin', 'barrier lotion oily skin', 'oil free gel moisturizer'],
      fitKeywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free', 'non-greasy'],
      ingredientHypotheses: ['Glycerin', 'Ceramide NP', 'Panthenol'],
      productTypeHypotheses: ['moisturizer'],
      frequency: 'daily_twice',
      routineSlots: ['am', 'pm'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'daily_sunscreen',
      rank: 30,
      preferredStep: 'sunscreen',
      labelEn: 'Daily sunscreen',
      labelZh: '日常防晒',
      whyEn: 'Use daily UV protection as the daytime support step for most routines.',
      whyZh: '把日常防晒作为多数护理流程的白天支持步骤。',
      queryTerms: ['daily sunscreen skincare', 'broad spectrum sunscreen', 'lightweight sunscreen'],
      fitKeywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight', 'non-greasy'],
      ingredientHypotheses: ['UV filters'],
      productTypeHypotheses: ['sunscreen'],
      frequency: 'daily_am',
      routineSlots: ['am'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'daily_sunscreen_finish_fit',
      rank: 31,
      preferredStep: 'sunscreen',
      labelEn: 'Daily sunscreen with finish fit',
      labelZh: '妆效友好的日常防晒',
      whyEn: 'Make sunscreen the lead role when the user asks about SPF, commute, humidity, makeup layering, white cast, or greasy finish.',
      whyZh: '当用户问 SPF、通勤、闷热、妆前叠加、泛白或油腻肤感时，让防晒成为主角色。',
      queryTerms: ['sunscreen under makeup', 'lightweight sunscreen oily skin', 'non greasy sunscreen', 'invisible fluid sunscreen', 'serum sunscreen spf', 'matte sunscreen humid weather'],
      alternateSteps: ['serum'],
      fitKeywords: ['under makeup', 'lightweight', 'non-greasy', 'no white cast', 'invisible', 'fluid', 'serum sunscreen', 'humidity', 'matte', 'sweat'],
      ingredientHypotheses: ['UV filters'],
      productTypeHypotheses: ['sunscreen', 'serum'],
      frequency: 'daily_am',
      routineSlots: ['am'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'hydrating_barrier_moisturizer',
      rank: 40,
      preferredStep: 'moisturizer',
      labelEn: 'Hydrating barrier moisturizer',
      labelZh: '补水屏障保湿',
      whyEn: 'Use a moisturizer that supports hydration, comfort, and barrier recovery for dry, flaky, or sensitized skin.',
      whyZh: '针对干燥、起皮或不耐受，优先选择兼顾补水、舒适度和屏障支持的保湿产品。',
      queryTerms: ['hydrating moisturizer dry skin', 'barrier repair moisturizer', 'ceramide cream sensitive skin', 'winter flaky skin moisturizer', 'soothing moisturizer'],
      fitKeywords: ['hydrating', 'barrier repair', 'ceramide', 'soothing', 'sensitive skin', 'fragrance free', 'flaky', 'dry skin'],
      ingredientHypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin', 'Squalane'],
      productTypeHypotheses: ['moisturizer'],
      frequency: 'daily_twice',
      routineSlots: ['am', 'pm'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'barrier_moisturizer',
      rank: 41,
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
    buildConcernRoleDescriptor({
      roleId: 'hydrating_serum_or_essence',
      rank: 42,
      preferredStep: 'serum',
      labelEn: 'Hydrating serum or essence',
      labelZh: '补水精华或精华水',
      whyEn: 'Use a hydration layer when skin feels dehydrated, dull, tight, or water-deficient.',
      whyZh: '当皮肤缺水、暗沉或紧绷时，加入补水型精华或精华水。',
      queryTerms: ['hydrating serum dehydrated skin', 'hyaluronic acid serum', 'hydrating essence dull skin', 'water fit serum', 'plumping hydrating serum'],
      alternateSteps: ['treatment'],
      fitKeywords: ['hydrating', 'dehydrated', 'hyaluronic acid', 'essence', 'plumping', 'water fit', 'dull skin'],
      ingredientHypotheses: ['Hyaluronic acid', 'Glycerin', 'Panthenol'],
      productTypeHypotheses: ['serum', 'treatment'],
      frequency: 'daily_once_or_twice',
      routineSlots: ['am', 'pm'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'tone_mark_treatment',
      rank: 50,
      preferredStep: 'treatment',
      labelEn: 'Tone and post-breakout mark treatment',
      labelZh: '肤色与痘印功效产品',
      whyEn: 'Use a tone-support treatment when the ask is post-breakout marks, uneven tone, dark spots, or dullness.',
      whyZh: '当主诉是痘印、肤色不均、色沉或暗沉时，优先选肤色支持类功效产品。',
      queryTerms: ['post acne marks serum', 'dark spot serum', 'tone correcting serum', 'brightening serum', 'uneven tone treatment'],
      alternateSteps: ['serum'],
      fitKeywords: ['post acne marks', 'dark spots', 'hyperpigmentation', 'uneven tone', 'brightening', 'tone correcting', 'marks'],
      ingredientHypotheses: ['Azelaic acid', 'Niacinamide', 'Vitamin C', 'Tranexamic acid'],
      productTypeHypotheses: ['treatment', 'serum'],
      frequency: 'daily_once',
      routineSlots: ['pm'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'layering_compatible_moisturizer_or_spf',
      rank: 60,
      preferredStep: 'moisturizer',
      labelEn: 'Layering-compatible moisturizer or SPF',
      labelZh: '适合叠加妆前的保湿或防晒',
      whyEn: 'Prioritize a non-pilling, makeup-compatible moisturizer or SPF when the complaint is product rolling, pilling, or bad layering.',
      whyZh: '当用户主诉搓泥、叠加不顺或妆前不服帖时，优先选妆前兼容的保湿或防晒角色。',
      queryTerms: ['lightweight moisturizer under makeup', 'non pilling moisturizer', 'sunscreen under makeup', 'gel cream under makeup', 'makeup compatible spf'],
      alternateSteps: ['sunscreen'],
      fitKeywords: ['under makeup', 'non-pilling', 'pilling', 'layering', 'lightweight', 'gel cream', 'makeup compatible', 'smooth finish'],
      ingredientHypotheses: ['Glycerin', 'Panthenol', 'UV filters'],
      productTypeHypotheses: ['moisturizer', 'sunscreen'],
      frequency: 'daily_am',
      routineSlots: ['am'],
      isCn,
    }),
    buildConcernRoleDescriptor({
      roleId: 'soothing_treatment',
      rank: 70,
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
    buildConcernRoleDescriptor({
      roleId: 'supporting_moisturizer',
      rank: 80,
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
    buildConcernRoleDescriptor({
      roleId: 'targeted_treatment',
      rank: 90,
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
    buildConcernRoleDescriptor({
      roleId: 'hydrating_mask_support',
      rank: 100,
      preferredStep: 'mask',
      labelEn: 'Optional hydrating mask',
      labelZh: '可选补水面膜',
      whyEn: 'Only add an occasional mask if skin also feels dehydrated or tight.',
      whyZh: '只有在同时缺水或紧绷时，才补充偶尔使用的补水面膜。',
      queryTerms: ['hydrating mask dehydrated skin', 'smoothing mask dehydrated skin'],
      fitKeywords: ['hydrating mask', 'soothing mask', 'smoothing mask', 'overnight mask'],
      ingredientHypotheses: ['Hyaluronic acid', 'Panthenol'],
      productTypeHypotheses: ['mask'],
      frequency: 'optional_weekly',
      routineSlots: ['optional', 'pm'],
      supportOnly: true,
      isCn,
    }),
  ];
}

function cloneConcernRoleForPlan(role, { rank = null, supportOnly = null } = {}) {
  if (!role || typeof role !== 'object' || Array.isArray(role)) return null;
  return {
    ...role,
    ...(Number.isFinite(Number(rank)) ? { rank: Number(rank) } : {}),
    ...(supportOnly != null ? { support_only: supportOnly === true } : {}),
  };
}

function pickConcernRole(roleById, roleId, options = {}) {
  const role = roleById.get(String(roleId || '').trim());
  return cloneConcernRoleForPlan(role, options);
}

function buildConcernSemanticPlanFallback({ text = '', focus = '', profileSummary = null } = {}) {
  const signals = collectConcernFrameworkSignals({ text, focus, profileSummary });
  const isCn = /[\u4e00-\u9fff]/.test(`${text} ${focus}`);
  const roleOntology = buildCanonicalConcernRoleOntology({ isCn });
  const roleById = new Map(roleOntology.map((role) => [String(role?.role_id || '').trim(), role]));
  const coreRoles = [];
  const supportRoles = [];
  const addCoreRole = (roleId, rank) => {
    const role = pickConcernRole(roleById, roleId, { rank, supportOnly: false });
    if (role && !coreRoles.some((item) => item.role_id === role.role_id)) coreRoles.push(role);
  };
  const addSupportRole = (roleId, rank) => {
    const role = pickConcernRole(roleById, roleId, { rank, supportOnly: true });
    if (role && !supportRoles.some((item) => item.role_id === role.role_id)) supportRoles.push(role);
  };

  if (signals.sunscreen) {
    addCoreRole('daily_sunscreen_finish_fit', 1);
    addCoreRole(signals.makeup_layering ? 'layering_compatible_moisturizer_or_spf' : signals.oily || signals.humid ? 'lightweight_moisturizer' : 'hydrating_barrier_moisturizer', 2);
    if (signals.oily || signals.acne) addCoreRole('oil_control_treatment', 3);
  } else if (signals.makeup_layering) {
    addCoreRole('layering_compatible_moisturizer_or_spf', 1);
    addCoreRole(signals.oily ? 'lightweight_moisturizer' : 'hydrating_barrier_moisturizer', 2);
    addCoreRole('daily_sunscreen_finish_fit', 3);
  } else if (signals.tone_marks) {
    addCoreRole('tone_mark_treatment', 1);
    addCoreRole('daily_sunscreen', 2);
    addCoreRole(signals.oily ? 'lightweight_moisturizer' : 'hydrating_barrier_moisturizer', 3);
  } else if (signals.dull || signals.dehydrated) {
    addCoreRole('hydrating_serum_or_essence', 1);
    addCoreRole('hydrating_barrier_moisturizer', 2);
    addCoreRole(signals.dull ? 'tone_mark_treatment' : 'daily_sunscreen', 3);
    if (signals.dull) addSupportRole('daily_sunscreen', 1);
  } else if (signals.oily || signals.acne) {
    addCoreRole(signals.acne && !signals.oily ? 'acne_clogged_pore_treatment' : 'oil_control_treatment', 1);
    addCoreRole('lightweight_moisturizer', 2);
    addCoreRole('daily_sunscreen', 3);
    if (signals.dry || signals.barrier) {
      addSupportRole('hydrating_mask_support', 1);
    }
  } else if (signals.barrier || signals.sensitive || signals.redness || signals.dry) {
    addCoreRole('hydrating_barrier_moisturizer', 1);
    addCoreRole('soothing_treatment', 2);
    addCoreRole('daily_sunscreen', 3);
  } else {
    addCoreRole('targeted_treatment', 1);
    addCoreRole('supporting_moisturizer', 2);
    addCoreRole('daily_sunscreen', 3);
  }

  const primaryConcern = signals.makeup_layering
    ? (isCn ? '叠加与妆前兼容' : 'layering and makeup compatibility')
    : signals.sunscreen
      ? (isCn ? '防晒肤感与日间适配' : 'sunscreen finish and daytime fit')
      : signals.tone_marks
        ? (isCn ? '肤色与痘印支持' : 'tone and post-breakout mark support')
        : signals.dull || signals.dehydrated
          ? (isCn ? '补水与提亮支持' : 'hydration and brightness support')
          : signals.oily || signals.acne
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
    role_ontology: {
      version: 'beauty_canonical_role_ontology_v2',
      roles: roleOntology,
    },
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
  const requestText = pickFirstTrimmed(text, focus, semanticPlan.framework_summary?.concern_text);
  const constraintText = [
    requestText,
    ...(Array.isArray(semanticPlan.must_satisfy_constraints) ? semanticPlan.must_satisfy_constraints : []),
  ].join(' ');
  const explicitSingleProductRequest = /\b(?:one product|single product|just one|only one)\b/i.test(constraintText);
  const budgetCeilingMatch =
    constraintText.match(/\b(?:under|below|less than|max(?:imum)?|no more than)\s*(?:usd\s*)?\$?\s*([0-9]+(?:\.[0-9]{1,2})?)\b/i) ||
    constraintText.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)\s*(?:or less|and under|max|maximum)?\b/i);
  const budgetCeilingAmount = budgetCeilingMatch ? Number(budgetCeilingMatch[1]) : null;
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
    request_text: requestText || null,
    focus_text: pickFirstTrimmed(focus) || null,
    explicit_single_product_request: explicitSingleProductRequest,
    ...(Number.isFinite(budgetCeilingAmount) && budgetCeilingAmount > 0
      ? { budget_ceiling: { amount: budgetCeilingAmount, currency: 'USD', source: 'request_text' } }
      : {}),
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
      queries: uniqCaseInsensitiveStrings(
        step === 'sunscreen'
          ? [...(STEP_QUERY_LADDER_EXPANSIONS.sunscreen || []), ...aliases.slice(1)]
          : aliases,
        8,
      ),
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
  const sku = isPlainObject(row.sku) ? row.sku : {};
  const fragments = [
    ['title', pickFirstTrimmed(row.display_name, row.displayName, row.name, row.title)],
    ['sku_title', pickFirstTrimmed(sku.display_name, sku.displayName, sku.name, sku.title)],
    ['structured_category', pickFirstTrimmed(sku.product_type, sku.productType, sku.category, sku.category_name, sku.categoryName, sku.type)],
    ['structured_category', pickFirstTrimmed(row.product_type, row.productType, row.category, row.category_name, row.categoryName, row.type)],
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

function buildCandidateNonStructuredStepText(product) {
  return buildCandidateResolutionFragments(product)
    .filter((item) => item && item.source !== 'structured_category' && item.source !== 'ingredient' && item.source !== 'brand')
    .map((item) => item.value)
    .join(' ');
}

function buildCandidateNonDescriptionStepText(product) {
  return buildCandidateResolutionFragments(product)
    .filter((item) => item && item.source !== 'structured_category' && item.source !== 'ingredient' && item.source !== 'brand' && item.source !== 'description')
    .map((item) => item.value)
    .join(' ');
}

function hasExplicitSunscreenSignal(text) {
  return EXPLICIT_SUNSCREEN_SIGNAL_RE.test(String(text || '').trim().toLowerCase());
}

function normalizeCandidateStep(product, { targetContext } = {}) {
  const row = isPlainObject(product) ? product : {};
  const sku = isPlainObject(row.sku) ? row.sku : {};
  const stepAwareIntent = Boolean(targetContext?.step_aware_intent && targetContext?.resolved_target_step);
  const resolutionText = buildCandidateResolutionText(row);
  const nonStructuredStepText = buildCandidateNonStructuredStepText(row);
  const nonDescriptionStepText = buildCandidateNonDescriptionStepText(row);
  const skuStructuredRaw = pickFirstTrimmed(
    sku.product_type,
    sku.productType,
    sku.category,
    sku.category_name,
    sku.categoryName,
    sku.step,
    sku.type,
  );
  const structuredRaw = pickFirstTrimmed(
    skuStructuredRaw,
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
  const nonStructuredStep = normalizeRecoTargetStep(nonStructuredStepText);
  const nonDescriptionStep = normalizeRecoTargetStep(nonDescriptionStepText);
  if (structuredStep) {
    if (
      structuredStep === 'serum'
      && nonDescriptionStep
      && nonDescriptionStep !== 'serum'
      && nonDescriptionStep !== 'treatment'
    ) {
      return {
        candidate_step: nonDescriptionStep,
        candidate_step_source: 'title_or_tag_alias',
        candidate_step_confidence: 'medium',
      };
    }
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
  if (
    retrievalStep
    && (
      !stepAwareIntent
      || retrievalStep === normalizeRecoTargetStep(targetContext?.resolved_target_step)
    )
  ) {
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
  const facialSkincareCandidate =
    skincareDomainClass !== 'explicit_non_skincare'
    && skincareDomainClass !== 'explicit_non_face_supportive';
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
  if (!facialSkincareCandidate) {
    bucket = 'hard_reject';
    reason =
      skincareDomainClass === 'explicit_non_face_supportive'
        ? 'non_face_supportive'
        : 'non_skincare_or_blacklisted';
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
  const exactStepViableCount = viable.filter((row) => row.candidate_step && row.candidate_step === targetContext?.resolved_target_step).length;
  const sameFamilyViableCount = viable.length;
  const averageContextFit = viable.length
    ? viable.reduce((sum, row) => sum + Number(row.context_fit_score || 0), 0) / viable.length
    : 0;
  const sameFamilySuccessThresholdMet = sameFamilyViableCount > 0;
  const sameFamilyStrongViableExists = viable.length > 0;
  const selected = viable.slice(0, 3);
  const selectedFamilies = uniqCaseInsensitiveStrings(selected.map((row) => row.candidate_step || row.family_relation || 'unknown'), 3);
  const topCandidatesConverged = selectedFamilies.length <= 1;
  const primaryDisplayGroups = summarizePrimaryDisplayGroups(selected);
  const overallTargetFidelitySatisfied = primaryDisplayGroups.length > 0;
  const hardConstraintConflict = viable.some((row) => row.constraint_conflict === true) || selected.some((row) => row.constraint_conflict === true);
  const weakViablePool = Boolean(targetContext?.step_aware_intent) && selected.length === 0 && (softMismatch.length > 0 || viable.length > 0);
  const terminalSuccess = Boolean(selected.length > 0 && !hardConstraintConflict);
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
  const viableCount = Number(poolState?.same_family_viable_count || 0);
  return viableCount > 0;
}

function deriveStepAwareEmptyReason(targetContext, poolState) {
  if (poolState?.weak_viable_pool) return 'weak_viable_pool';
  if (targetContext?.step_aware_intent) return 'no_viable_candidates_for_target';
  return 'upstream_missing_or_empty';
}

function buildSharedRecommendationRequestContext({ entryType = 'chat', message = '', profile = null } = {}) {
  const profileObj = isPlainObject(profile) ? profile : {};
  const activeGoals = normalizeStringArray(
    [
      ...(Array.isArray(profileObj.goals) ? profileObj.goals : []),
      ...(Array.isArray(profileObj.active_goals) ? profileObj.active_goals : []),
      pickFirstTrimmed(profileObj.goal),
    ],
    8,
  );
  const skinType = pickFirstTrimmed(profileObj.skinType, profileObj.skin_type);
  const sensitivity = pickFirstTrimmed(profileObj.sensitivity);
  const barrierStatus = pickFirstTrimmed(profileObj.barrierStatus, profileObj.barrier_status);
  const hardContextFieldsUsed = [];
  if (activeGoals.length > 0) hardContextFieldsUsed.push('active_goals');
  if (skinType) hardContextFieldsUsed.push('skin_type');
  if (sensitivity) hardContextFieldsUsed.push('sensitivity');
  if (barrierStatus) hardContextFieldsUsed.push('barrier_status');
  const analysisContextAvailable = hardContextFieldsUsed.length > 0;
  const supportCount = [skinType, sensitivity, barrierStatus].filter(Boolean).length;
  const minimumRecommendationContextSatisfied = activeGoals.length > 0 && supportCount >= 1;
  const requestContextSignature = makeSignature('reqctx', {
    version: REQUEST_CONTEXT_SIGNATURE_VERSION,
    entry_type: String(entryType || '').trim().toLowerCase() || 'chat',
    message: normalizeQueryToken(message),
    active_goals: activeGoals,
    skin_type: skinType || null,
    sensitivity: sensitivity || null,
    barrier_status: barrierStatus || null,
  });
  const candidatePoolSignature = makeSignature('sharedpool', {
    version: CANDIDATE_POOL_SIGNATURE_VERSION,
    request_context_signature: requestContextSignature,
    entry_type: String(entryType || '').trim().toLowerCase() || 'chat',
  });
  const requestContext = {
    snapshot_present: false,
    context_source_mode: analysisContextAvailable ? 'explicit_only' : 'none',
    analysis_context_available: analysisContextAvailable,
    snapshot_fields_used: [],
    hard_context_fields_used: hardContextFieldsUsed,
    soft_context_fields_used: [],
    explicit_override_applied: false,
    context_mode: analysisContextAvailable ? 'explicit_only' : 'no_context',
    adapter_version: 'shared_request_context_v1',
    request_context_signature: requestContextSignature,
    request_context_signature_version: REQUEST_CONTEXT_SIGNATURE_VERSION,
    minimum_recommendation_context_satisfied: minimumRecommendationContextSatisfied,
  };
  const contextUsage = {
    ...requestContext,
    candidate_pool_signature: candidatePoolSignature,
    candidate_pool_signature_version: CANDIDATE_POOL_SIGNATURE_VERSION,
    strictness_source: 'entry_default',
    min_context_rule_version: MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION,
  };
  return {
    request_context: requestContext,
    context_usage: contextUsage,
    request_context_signature: requestContextSignature,
    request_context_signature_version: REQUEST_CONTEXT_SIGNATURE_VERSION,
    candidate_pool_signature: candidatePoolSignature,
    candidate_pool_signature_version: CANDIDATE_POOL_SIGNATURE_VERSION,
    minimum_recommendation_context_satisfied: minimumRecommendationContextSatisfied,
  };
}

async function runRecommendationSharedStack({
  entryType = 'chat',
  message = '',
  profile = null,
  coreRunner = null,
  coreInput = null,
} = {}) {
  const sharedRequestContext = buildSharedRecommendationRequestContext({
    entryType,
    message,
    profile,
  });
  const candidatePool = {
    candidate_pool_signature: sharedRequestContext.candidate_pool_signature,
    candidate_pool_signature_version: sharedRequestContext.candidate_pool_signature_version,
  };
  if (
    String(entryType || '').trim().toLowerCase() === 'chat'
    && sharedRequestContext.minimum_recommendation_context_satisfied !== true
  ) {
    return {
      needs_more_context: true,
      request_context: sharedRequestContext.request_context,
      candidate_pool: candidatePool,
      core_result: {
        fallback_mode: 'chat_clarify_needed_for_missing_target_need',
        debug_meta: {
          mainline_status: 'needs_more_context',
        },
      },
      raw: {
        norm: {
          payload: {
            recommendation_meta: {
              analysis_context_usage: sharedRequestContext.context_usage,
            },
          },
        },
      },
    };
  }
  const runnerInput = {
    ...(isPlainObject(coreInput) ? coreInput : {}),
    sharedRequestContext: {
      ...sharedRequestContext.request_context,
      context_usage: sharedRequestContext.context_usage,
      candidate_pool_signature: sharedRequestContext.candidate_pool_signature,
      candidate_pool_signature_version: sharedRequestContext.candidate_pool_signature_version,
      minimum_recommendation_context_satisfied:
        sharedRequestContext.minimum_recommendation_context_satisfied,
    },
  };
  const raw = typeof coreRunner === 'function' ? await coreRunner(runnerInput) : null;
  if (isPlainObject(raw?.norm?.payload)) {
    const payloadMeta = isPlainObject(raw.norm.payload.recommendation_meta)
      ? raw.norm.payload.recommendation_meta
      : {};
    raw.norm.payload.recommendation_meta = {
      ...payloadMeta,
      analysis_context_usage: isPlainObject(payloadMeta.analysis_context_usage)
        ? payloadMeta.analysis_context_usage
        : sharedRequestContext.context_usage,
    };
  }
  return {
    needs_more_context: false,
    request_context: sharedRequestContext.request_context,
    candidate_pool: {
      ...candidatePool,
      pool_source: pickFirstTrimmed(raw?.poolSource) || null,
    },
    core_result: {
      fallback_mode: pickFirstTrimmed(raw?.fallbackMode) || 'executed',
      debug_meta: {
        mainline_status:
          pickFirstTrimmed(
            raw?.mainlineStatus,
            raw?.norm?.payload?.recommendation_meta?.mainline_status,
          ) || null,
      },
    },
    raw,
  };
}

module.exports = {
  REQUEST_CONTEXT_SIGNATURE_VERSION,
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
  canonicalizeGenericConcernQuery,
  resolveRecommendationTargetContext,
  buildConcernSemanticPlanFallback,
  buildConcernTargetContextFromSemanticPlan,
  buildConcernFrameworkRoles,
  buildSameFamilyQueryLevels,
  finalizeRecommendationCandidatePools,
  runRecommendationSharedStack,
  shouldStopStepAwareBroadening,
  deriveStepAwareEmptyReason,
  inferSlotForStep,
  normalizeCandidateStep,
};
