const { z } = require('zod');

const INTENT_VERSION = '1.0';

const LanguageEnum = z.enum(['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'other']);
const DomainEnum = z.enum([
  'human_apparel',
  'toy_accessory',
  'home',
  'electronics',
  'beauty',
  'sports_outdoor',
  'other',
]);
const TargetTypeEnum = z.enum(['human', 'toy', 'pet', 'unknown']);
const AgeGroupEnum = z.enum(['adult', 'teen', 'kid', 'baby', 'all', 'unknown']);

const PivotaIntentV1Zod = z
  .object({
    intent_version: z.literal(INTENT_VERSION),
    language: LanguageEnum,
    primary_domain: DomainEnum,
    secondary_domains: z.array(DomainEnum).max(2).optional(),
    target_object: z
      .object({
        type: TargetTypeEnum,
        age_group: AgeGroupEnum,
        notes: z.string().max(200).optional(),
      })
      .strict(),
    category: z
      .object({
        required: z.array(z.string().max(64)).max(5),
        optional: z.array(z.string().max(64)).max(8),
      })
      .strict(),
    scenario: z
      .object({
        name: z.string().max(64),
        signals: z.array(z.string().max(48)).max(8),
      })
      .strict(),
    hard_constraints: z
      .object({
        temperature_c: z
          .object({
            min: z.number().nullable().optional(),
            max: z.number().nullable().optional(),
          })
          .strict()
          .optional(),
        must_include_keywords: z.array(z.string().max(32)).max(8).optional(),
        must_exclude_domains: z.array(z.string().max(32)).max(8).optional(),
        must_exclude_keywords: z.array(z.string().max(32)).max(16).optional(),
        in_stock_only: z.boolean().nullable().optional(),
        price: z
          .object({
            currency: z.string().max(8).nullable().optional(),
            min: z.number().nullable().optional(),
            max: z.number().nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    soft_preferences: z
      .object({
        style: z.array(z.string().max(32)).max(6).optional(),
        colors: z.array(z.string().max(24)).max(6).optional(),
        brands: z.array(z.string().max(32)).max(6).optional(),
        materials: z.array(z.string().max(24)).max(6).optional(),
      })
      .strict(),
    confidence: z
      .object({
        overall: z.number().min(0).max(1),
        domain: z.number().min(0).max(1),
        target_object: z.number().min(0).max(1),
        category: z.number().min(0).max(1),
        notes: z.string().max(200).optional(),
      })
      .strict(),
    ambiguity: z
      .object({
        needs_clarification: z.boolean(),
        missing_slots: z.array(z.string().max(48)).max(6),
        clarifying_questions: z.array(z.string().max(120)).max(3).optional(),
      })
      .strict(),
    history_usage: z
      .object({
        used: z.boolean(),
        reason: z.string().max(200),
        used_queries: z.array(z.string().max(80)).max(5).optional(),
        ignored_queries: z.array(z.string().max(80)).max(5).optional(),
      })
      .strict(),
  })
  .strict();

function detectLanguage(text) {
  if (!text) return 'other';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  return 'en';
}

const TOY_KEYWORDS = [
  'labubu',
  'pop mart',
  'doll',
  'vinyl face doll',
  'doll clothes',
  'doll outfit',
  'toy',
  'figure',
  'plush',
  'blind box',
  '盲盒',
  '公仔',
  '娃娃',
  '娃衣',
  '玩具',
];

const OUTERWEAR_KEYWORDS_ZH = [
  '外套',
  '大衣',
  '羽绒服',
  '冲锋衣',
  '风衣',
  '棉服',
  '夹克',
  '保暖',
  '御寒',
];

const OUTERWEAR_KEYWORDS_EN = [
  'coat',
  'jacket',
  'parka',
  'puffer',
  'down jacket',
  'outerwear',
  'shell',
  'windbreaker',
];

const COLD_SCENARIO_SIGNALS_ZH = ['山上', '登山', '徒步', '爬山', '露营', '很冷', '降温', '低温', '下雪'];
const COLD_SCENARIO_SIGNALS_EN = ['mountain', 'hiking', 'camping', 'cold', 'snow', 'freezing', 'winter'];

const GREETING_SIGNALS_ZH = ['你好', '嗨', '哈喽', '在吗', 'hello', 'hi', 'hey'];
const GREETING_SIGNALS_EN = ['hi', 'hello', 'hey', 'yo', 'sup', 'how are you', "what's up"];
const CHITCHAT_SIGNALS_ZH = ['聊聊', '随便聊', '唠嗑', '无聊', '陪我聊', '想聊天'];
const CHITCHAT_SIGNALS_EN = ['just chat', 'chat', 'talk', 'bored', 'kill time'];

const BROWSE_SIGNALS_ZH = ['随便看看', '逛逛', '看看有什么', '推荐点', '推荐一些', '热门', '有什么好物'];
const BROWSE_SIGNALS_EN = [
  'recommend something',
  'show me popular',
  'popular items',
  'browse',
  'show me something',
  'surprise me',
];

function includesAny(haystack, needles) {
  if (!haystack) return false;
  const lowered = haystack.toLowerCase();
  return needles.some((k) => lowered.includes(String(k).toLowerCase()));
}

function wantsUseHistory(latestUserQuery) {
  const q = String(latestUserQuery || '').toLowerCase();
  return (
    q.includes('same as before') ||
    q.includes('like before') ||
    q.includes('as before') ||
    q.includes('同之前') ||
    q.includes('跟之前一样') ||
    q.includes('和之前一样')
  );
}

function buildNoResultClarifiers(language) {
  if (language === 'zh') {
    return [
      '是给自己/送礼，还是给 Labubu/娃娃/公仔配件？',
      '你要的主要场景是什么（通勤/约会/登山/室内）？',
      '你更偏好“羽绒服 / 冲锋衣 / 大衣”哪一类？',
      '需要防风/防水吗？大概最低温度是多少？',
    ];
  }
  return [
    'Is this for you, a gift, or for a doll/toy like Labubu?',
    'What’s the main scenario (commute, date, hiking, indoor)?',
    'Do you prefer a down jacket, a shell, or a coat?',
    'Do you need it windproof/waterproof, and what’s the lowest temperature?',
  ];
}

function extractIntentRuleBased(latest_user_query, recent_queries = [], recent_messages = []) {
  const latest = String(latest_user_query || '').trim();
  const language = detectLanguage(latest);

  const isGreeting =
    includesAny(latest, GREETING_SIGNALS_ZH) || includesAny(latest, GREETING_SIGNALS_EN);
  const isChitchat =
    includesAny(latest, CHITCHAT_SIGNALS_ZH) || includesAny(latest, CHITCHAT_SIGNALS_EN);
  const isBrowse =
    latest.length === 0 ||
    includesAny(latest, BROWSE_SIGNALS_ZH) ||
    includesAny(latest, BROWSE_SIGNALS_EN) ||
    // common generic intents from UI
    includesAny(latest, ['推荐一些好物', '热门商品', 'show me popular items', 'recommend some products']);

  const hasToySignal =
    includesAny(latest, TOY_KEYWORDS) ||
    recent_queries.some((q) => includesAny(q, TOY_KEYWORDS));

  const hasOuterwearSignal =
    includesAny(latest, OUTERWEAR_KEYWORDS_ZH) || includesAny(latest, OUTERWEAR_KEYWORDS_EN);

  const hasColdScenario =
    includesAny(latest, COLD_SCENARIO_SIGNALS_ZH) || includesAny(latest, COLD_SCENARIO_SIGNALS_EN);

  let primary_domain = 'other';
  let targetType = 'unknown';
  let categoryRequired = [];
  let scenarioName = 'general';
  let scenarioSignals = [];

  if ((isGreeting || isChitchat) && !hasOuterwearSignal && !hasColdScenario && !includesAny(latest, TOY_KEYWORDS)) {
    // Discovery / chitchat mode: user has not expressed a shopping goal yet.
    primary_domain = 'other';
    targetType = 'unknown';
    categoryRequired = [];
    scenarioName = 'discovery';
    scenarioSignals = [];
  } else if (isBrowse && !hasOuterwearSignal && !hasColdScenario && !includesAny(latest, TOY_KEYWORDS)) {
    // Generic browse: user wants to see what's available, without a clear category.
    primary_domain = 'other';
    targetType = 'unknown';
    categoryRequired = [];
    scenarioName = 'browse';
    scenarioSignals = [];
  } else if (hasOuterwearSignal || hasColdScenario) {
    primary_domain = 'human_apparel';
    targetType = 'human';
    categoryRequired = ['outerwear', 'coat', 'down_jacket'].slice(0, 3);
    scenarioName = hasColdScenario ? 'cold_weather_mountain' : 'human_apparel_general';
    scenarioSignals = hasColdScenario
      ? (language === 'zh' ? COLD_SCENARIO_SIGNALS_ZH : COLD_SCENARIO_SIGNALS_EN).filter((s) =>
          includesAny(latest, [s])
        )
      : [];
  } else if (includesAny(latest, TOY_KEYWORDS) || (hasToySignal && !latest)) {
    primary_domain = 'toy_accessory';
    targetType = 'toy';
    categoryRequired = ['toy_accessory', 'doll_clothing'].slice(0, 2);
    scenarioName = 'toy_accessory_general';
  } else if (latest) {
    primary_domain = 'other';
    targetType = 'unknown';
    scenarioName = 'general';
  }

  const useHistory = wantsUseHistory(latest);
  const ignored = !useHistory ? recent_queries.slice(-5) : [];
  const used = useHistory ? recent_queries.slice(-5) : [];

  const mustExcludeKeywords =
    targetType === 'human'
      ? ['Labubu', 'doll', 'toy', '娃娃', '公仔', '娃衣', '玩具'].slice(0, 16)
      : [];
  const mustExcludeDomains = targetType === 'human' ? ['toy_accessory'] : [];

  const needsClarification =
    scenarioName === 'discovery' ||
    (scenarioName === 'browse' && latest.length > 0) ||
    targetType === 'unknown' ||
    primary_domain === 'other';
  const missingSlots = [];
  if (scenarioName === 'discovery') {
    missingSlots.push('shopping_goal', 'target_object');
  } else if (scenarioName === 'browse') {
    missingSlots.push('category', 'scenario');
  } else {
    if (primary_domain === 'human_apparel' && categoryRequired.length === 0) missingSlots.push('category');
    if (primary_domain === 'human_apparel' && !hasColdScenario) missingSlots.push('scenario_temperature');
  }

  const confidenceDomain =
    scenarioName === 'discovery'
      ? 0.3
      : primary_domain === 'human_apparel'
      ? hasOuterwearSignal || hasColdScenario
        ? 0.9
        : 0.6
      : primary_domain === 'toy_accessory'
        ? includesAny(latest, TOY_KEYWORDS)
          ? 0.9
          : 0.6
        : 0.5;
  const confidenceTarget = scenarioName === 'discovery' ? 0.3 : targetType === 'unknown' ? 0.4 : 0.9;
  const confidenceCategory = scenarioName === 'discovery' ? 0.3 : categoryRequired.length ? 0.8 : 0.4;
  const overall = Math.max(0, Math.min(1, (confidenceDomain + confidenceTarget + confidenceCategory) / 3));

  const intent = {
    intent_version: INTENT_VERSION,
    language,
    primary_domain,
    target_object: {
      type: targetType,
      age_group: targetType === 'human' ? 'adult' : targetType === 'toy' ? 'all' : 'unknown',
      notes: '',
    },
    category: {
      required: categoryRequired.slice(0, 5),
      optional: [],
    },
    scenario: {
      name: scenarioName,
      signals: scenarioSignals.slice(0, 8),
    },
    hard_constraints: {
      temperature_c: hasColdScenario ? { min: null, max: 10 } : { min: null, max: null },
      must_include_keywords: [],
      must_exclude_domains: mustExcludeDomains,
      must_exclude_keywords: mustExcludeKeywords,
      in_stock_only: null,
      price: { currency: null, min: null, max: null },
    },
    soft_preferences: {
      style: [],
      colors: [],
      brands: [],
      materials: [],
    },
    confidence: {
      overall,
      domain: confidenceDomain,
      target_object: confidenceTarget,
      category: confidenceCategory,
      notes: '',
    },
    ambiguity: {
      needs_clarification: Boolean(needsClarification),
      missing_slots: missingSlots.slice(0, 6),
      clarifying_questions: needsClarification ? buildNoResultClarifiers(language).slice(0, 3) : [],
    },
    history_usage: {
      used: Boolean(useHistory),
      reason: useHistory
        ? 'User explicitly referenced previous preferences.'
        : 'Latest query is treated as authoritative; recent history not applied to domain/target decisions.',
      ...(useHistory ? { used_queries: used } : {}),
      ...(!useHistory ? { ignored_queries: ignored } : {}),
    },
  };

  return PivotaIntentV1Zod.parse(intent);
}

module.exports = {
  PivotaIntentV1Zod,
  extractIntentRuleBased,
  detectLanguage,
  TOY_KEYWORDS,
  INTENT_VERSION,
};
