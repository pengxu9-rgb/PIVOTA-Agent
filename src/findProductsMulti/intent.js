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
  // Japanese (Hiragana/Katakana) and Korean (Hangul)
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';

  // Chinese (Han characters without kana/hangul)
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';

  const lower = String(text).toLowerCase();

  // Spanish / French (lightweight heuristic via common stopwords)
  const esHits = [' por ', ' por favor', ' voy ', ' ir ', ' con ', ' mi ', ' perro', ' ropa', ' frío', ' senderismo']
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => lower.includes(s));
  if (esHits || /[¿¡ñáéíóúü]/i.test(text)) return 'es';

  const frHits = [' bonjour', ' je ', ' avec ', ' mon ', ' chien', ' vêtements', ' froid', ' randonnée']
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => lower.includes(s));
  if (frHits || /[çœàâæéèêëîïôœùûüÿ]/i.test(text)) return 'fr';

  return 'en';
}

// "toy" is ambiguous (e.g. "toy breeds" for dogs). Avoid treating it as a strong signal.
const TOY_KEYWORDS_STRONG = [
  'labubu',
  'pop mart',
  'doll',
  'vinyl face doll',
  'doll clothes',
  'doll outfit',
  'toy accessory',
  'toy accessories',
  'figure',
  'plush',
  'blind box',
  '盲盒',
  '公仔',
  '娃娃',
  '娃衣',
  '玩具配饰',
  '玩具配件',
];

const TOY_KEYWORDS_WEAK = ['toy', 'toys', '玩具'];
const TOY_KEYWORDS = [...TOY_KEYWORDS_STRONG, ...TOY_KEYWORDS_WEAK];

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

// "衣服" is too generic and appears in many contexts (including "sexy outfit").
// Keep this list focused on gendered signals and common women clothing terms.
const WOMEN_CLOTHING_SIGNALS_ZH = ['女生', '女装', '女士', '女人', '女孩', '穿搭', '裙子', '连衣裙', '上衣', '裤子'];
const WOMEN_CLOTHING_SIGNALS_EN = [
  'women',
  "women's",
  'womens',
  'girl',
  "girl's",
  'girls',
  'clothes',
  'clothing',
  'outfit',
  'dress',
  'skirt',
  'top',
  'blouse',
  'shirt',
  'pants',
  'jeans',
  'hoodie',
  'sweater',
];

const PET_SIGNALS_ZH = ['狗', '狗狗', '小狗', '猫', '猫猫', '宠物', '遛狗', '狗衣服', '宠物衣服'];
const PET_SIGNALS_EN = [
  'dog',
  "dog's",
  'puppy',
  'cat',
  "cat's",
  'pet',
  'pets',
  'dog coat',
  'dog jacket',
  'dog sweater',
  'pet apparel',
];
const PET_SIGNALS_ES = [
  'perro',
  'perros',
  'perrita',
  'cachorro',
  'mascota',
  'mascotas',
  'gato',
  'gatos',
  'ropa para perro',
  'abrigo para perro',
  'chaqueta para perro',
  'ropa de perro',
];
const PET_SIGNALS_FR = [
  'chien',
  'chiens',
  'chienne',
  'chiot',
  'animal',
  'animaux',
  'chat',
  'chats',
  'vêtement pour chien',
  'manteau pour chien',
  'vêtements pour chien',
];
const PET_SIGNALS_JA = ['犬', 'わんちゃん', '猫', 'ペット', '犬服', '猫服'];

const GREETING_SIGNALS_ZH = ['你好', '嗨', '哈喽', '在吗', 'hello', 'hi', 'hey'];
const GREETING_SIGNALS_EN = ['hi', 'hello', 'hey', 'yo', 'sup', 'how are you', "what's up"];
const CHITCHAT_SIGNALS_ZH = ['聊聊', '随便聊', '唠嗑', '无聊', '陪我聊', '想聊天'];
const CHITCHAT_SIGNALS_EN = ['just chat', 'chat', 'talk', 'bored', 'kill time'];

// Browse signals should be truly "browse" (no clear shopping goal). Avoid triggering
// browse for common request phrasing like “推荐一些XX”.
const BROWSE_SIGNALS_ZH = ['随便看看', '逛逛', '看看有什么', '热门', '有什么好物', '就先看看'];
const BROWSE_SIGNALS_EN = [
  'recommend something',
  'show me popular',
  'popular items',
  'browse',
  'show me something',
  'surprise me',
];

const LINGERIE_SIGNALS_ZH = ['内衣', '性感内衣', '文胸', '胸罩', '丁字裤', '情趣', '情趣内衣', '成人用品'];
const LINGERIE_SIGNALS_EN = ['lingerie', 'underwear', 'bra', 'panties', 'panty', 'thong', 'sexy lingerie'];
const LINGERIE_SIGNALS_ES = ['lenceria', 'lencería', 'ropa interior', 'sujetador', 'bragas', 'tanga'];
const LINGERIE_SIGNALS_FR = ['lingerie', 'sous-vetement', 'sous-vêtement', 'soutien-gorge', 'culotte', 'string'];
const LINGERIE_SIGNALS_JA = ['下着', 'ランジェリー', 'ブラ', 'パンティ', 'セクシー'];

// Beauty / makeup tools (Tool-first). Keep broad enough for multilingual queries.
const BEAUTY_TOOL_SIGNALS_ZH = [
  '化妆工具',
  '美妆工具',
  '化妆刷',
  '刷具',
  '刷子',
  '粉底刷',
  '散粉刷',
  '腮红刷',
  '修容刷',
  '遮瑕刷',
  '眼影刷',
  '晕染刷',
  '眉刷',
  '唇刷',
  '美妆蛋',
  '海绵蛋',
  '粉扑',
  '气垫扑',
  '睫毛夹',
  '清洁垫',
  '刷具清洁',
  '刷具清洗',
  '刷具套装',
];
const BEAUTY_TOOL_SIGNALS_EN = [
  'cosmetic tools',
  'makeup tools',
  'makeup brush',
  'brush set',
  'makeup brush set',
  'foundation brush',
  'powder brush',
  'blush brush',
  'contour brush',
  'concealer brush',
  'eyeshadow brush',
  'blending brush',
  'makeup sponge',
  'beauty blender',
  'powder puff',
  'cushion puff',
  'eyelash curler',
  'brush cleaner',
  'cleaning pad',
];
const BEAUTY_TOOL_SIGNALS_ES = [
  'brocha',
  'brochas',
  'brocha de base',
  'brocha para base',
  'brocha para polvo',
  'brocha para rubor',
  'esponja de maquillaje',
  'borla',
  'rizador de pestañas',
  'kit de brochas',
];
const BEAUTY_TOOL_SIGNALS_FR = [
  'pinceau',
  'pinceaux',
  'pinceau fond de teint',
  'pinceau poudre',
  'pinceau blush',
  'éponge maquillage',
  'houppette',
  'recourbe-cils',
  'set de pinceaux',
];
const BEAUTY_TOOL_SIGNALS_JA = [
  'メイクブラシ',
  'ブラシ',
  '化粧筆',
  'ブラシセット',
  'ファンデーションブラシ',
  'パウダーブラシ',
  'チークブラシ',
  'コンシーラーブラシ',
  'アイシャドウブラシ',
  'ブレンディングブラシ',
  'メイクスポンジ',
  'パフ',
  'ビューラー',
];

function includesAny(haystack, needles) {
  if (!haystack) return false;
  const lowered = haystack.toLowerCase();
  return needles.some((k) => lowered.includes(String(k).toLowerCase()));
}

function isToyBreedContext(text) {
  return /\btoy\s+(?:poodle|breed|dog|puppy)\b/i.test(String(text || ''));
}

function inferRecentMissionFromHistory(recent_queries = [], recent_messages = []) {
  const classify = (t) => {
    if (!t) return null;
    const isToy = includesAny(t, TOY_KEYWORDS) && !isToyBreedContext(t);
    if (isToy) return 'toy_accessory';
    const isBeauty =
      includesAny(t, BEAUTY_TOOL_SIGNALS_ZH) ||
      includesAny(t, BEAUTY_TOOL_SIGNALS_EN) ||
      includesAny(t, BEAUTY_TOOL_SIGNALS_ES) ||
      includesAny(t, BEAUTY_TOOL_SIGNALS_FR) ||
      includesAny(t, BEAUTY_TOOL_SIGNALS_JA);
    if (isBeauty) return 'beauty_tools';
    return null;
  };

  // Prefer explicit mission signals in chat messages (most recent turn) over
  // aggregated "recent_queries", which may include older sessions.
  if (Array.isArray(recent_messages) && recent_messages.length) {
    for (let i = recent_messages.length - 1; i >= 0; i -= 1) {
      const m = recent_messages[i];
      if (!m || m.role !== 'user' || !m.content) continue;
      const mission = classify(String(m.content));
      if (mission) return mission;
    }
  }

  if (Array.isArray(recent_queries) && recent_queries.length) {
    for (let i = recent_queries.length - 1; i >= 0; i -= 1) {
      const q = recent_queries[i];
      if (!q) continue;
      const mission = classify(String(q));
      if (mission) return mission;
    }
  }

  return null;
}

function parseBudgetToPriceConstraint(latestUserQuery) {
  const q = String(latestUserQuery || '');
  if (!q) return null;

  // Normalize full-width digits and currency symbols if present.
  const normalized = q.replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)));
  const hasUsd =
    /(?:\$|usd|dollars?|美金|美元)/i.test(normalized);
  const m = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;

  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;

  const within = /左右|around|about|approx/i.test(normalized);
  const maxOnly = /以内|以下|不超过|at most|under|<=/i.test(normalized);

  const currency = hasUsd ? 'USD' : null;
  const max = maxOnly ? val : within ? Math.round(val * 1.25 * 100) / 100 : val;
  const min = within && !maxOnly ? Math.round(val * 0.75 * 100) / 100 : null;

  return { currency, min, max };
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
  const isShortFollowup = latest.length > 0 && latest.length <= 80;
  const historyMission = inferRecentMissionFromHistory(recent_queries, recent_messages);

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

  const hasPetSignal =
    includesAny(latest, PET_SIGNALS_ZH) ||
    includesAny(latest, PET_SIGNALS_EN) ||
    includesAny(latest, PET_SIGNALS_ES) ||
    includesAny(latest, PET_SIGNALS_FR) ||
    includesAny(latest, PET_SIGNALS_JA);

  const hasLingerieSignal =
    includesAny(latest, LINGERIE_SIGNALS_ZH) ||
    includesAny(latest, LINGERIE_SIGNALS_EN) ||
    includesAny(latest, LINGERIE_SIGNALS_ES) ||
    includesAny(latest, LINGERIE_SIGNALS_FR) ||
    includesAny(latest, LINGERIE_SIGNALS_JA);

  const hasSexySignal = includesAny(latest, ['sexy', '性感', 'セクシー']);

  const hasBeautyToolSignalLocal =
    includesAny(latest, BEAUTY_TOOL_SIGNALS_ZH) ||
    includesAny(latest, BEAUTY_TOOL_SIGNALS_EN) ||
    includesAny(latest, BEAUTY_TOOL_SIGNALS_ES) ||
    includesAny(latest, BEAUTY_TOOL_SIGNALS_FR) ||
    includesAny(latest, BEAUTY_TOOL_SIGNALS_JA);

  const hasWomenClothingSignal =
    includesAny(latest, WOMEN_CLOTHING_SIGNALS_ZH) ||
    includesAny(latest, WOMEN_CLOTHING_SIGNALS_EN) ||
    // Spanish/French basic gender words
    includesAny(latest, ['mujer', 'mujeres', 'ropa', 'femme', 'femmes', 'vêtement', 'vetement']);

  const hasToySignalStrongLocal = includesAny(latest, TOY_KEYWORDS_STRONG) && !isToyBreedContext(latest);
  const hasToySignalWeakLocal = includesAny(latest, TOY_KEYWORDS_WEAK) && !isToyBreedContext(latest);
  const hasToySignalLocal = hasToySignalStrongLocal || hasToySignalWeakLocal;

  const hasOuterwearSignal =
    includesAny(latest, OUTERWEAR_KEYWORDS_ZH) || includesAny(latest, OUTERWEAR_KEYWORDS_EN);

  const hasColdScenario =
    includesAny(latest, COLD_SCENARIO_SIGNALS_ZH) || includesAny(latest, COLD_SCENARIO_SIGNALS_EN);

  const hasBeautyToolSignal =
    hasBeautyToolSignalLocal ||
    (historyMission === 'beauty_tools' &&
      isShortFollowup &&
      // Do not let prior makeup/beauty history override a clearly different new mission.
      !hasToySignalLocal &&
      !hasPetSignal &&
      !hasOuterwearSignal &&
      !hasColdScenario &&
      !hasWomenClothingSignal &&
      !hasLingerieSignal);

  let primary_domain = 'other';
  let targetType = 'unknown';
  let categoryRequired = [];
  let scenarioName = 'general';
  let scenarioSignals = [];

  if (
    (isGreeting || isChitchat) &&
    !hasOuterwearSignal &&
    !hasColdScenario &&
    !hasLingerieSignal &&
    !hasToySignalLocal
  ) {
    // Discovery / chitchat mode: user has not expressed a shopping goal yet.
    primary_domain = 'other';
    targetType = 'unknown';
    categoryRequired = [];
    scenarioName = 'discovery';
    scenarioSignals = [];
  } else if (
    isBrowse &&
    !hasOuterwearSignal &&
    !hasColdScenario &&
    !hasLingerieSignal &&
    !hasToySignalLocal
  ) {
    // Generic browse: user wants to see what's available, without a clear category.
    primary_domain = 'other';
    targetType = 'unknown';
    categoryRequired = [];
    scenarioName = 'browse';
    scenarioSignals = [];
  } else if (hasPetSignal) {
    // Pet apparel intent should override cold/hiking keywords (e.g. "dog jacket for hiking").
    primary_domain = 'sports_outdoor';
    targetType = 'pet';
    categoryRequired = ['pet_apparel', 'dog_jacket', 'dog_sweater'].slice(0, 3);
    scenarioName = includesAny(latest, ['hiking', 'trail', 'camping', '徒步', '登山', '爬山'])
      ? 'pet_hiking'
      : 'pet_apparel_general';
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
  } else if (hasBeautyToolSignal) {
    primary_domain = 'beauty';
    targetType = 'human';
    scenarioName = 'beauty_tools';
    scenarioSignals = [];

    const lowered = latest.toLowerCase();
    const cats = ['cosmetic_tools'];
    if (/粉底刷|foundation brush/.test(latest)) cats.push('foundation_brush');
    if (/散粉刷|powder brush/.test(latest)) cats.push('powder_brush');
    if (/腮红刷|blush brush/.test(latest)) cats.push('blush_brush');
    if (/修容刷|contour brush/.test(latest)) cats.push('contour_brush');
    if (/遮瑕刷|concealer brush/.test(latest)) cats.push('concealer_brush');
    if (/眼影刷|eyeshadow brush/.test(latest)) cats.push('eyeshadow_brush');
    if (/晕染刷|blending brush/.test(latest)) cats.push('blending_brush');
    if (/美妆蛋|海绵蛋|makeup sponge|beauty blender/.test(lowered)) cats.push('makeup_sponge');
    if (/粉扑|puff|houppette/.test(lowered) || /粉扑/.test(latest)) cats.push('powder_puff');
    if (/睫毛夹|eyelash curler|recourbe-cils|ビューラー/.test(lowered) || /睫毛夹/.test(latest))
      cats.push('eyelash_curler');
    if (/套装|set|kit|\b\d+\s*(?:pcs|pieces|piece)\b/.test(lowered)) cats.push('brush_set');
    categoryRequired = cats.slice(0, 5);
  } else if (hasWomenClothingSignal) {
    primary_domain = 'human_apparel';
    targetType = 'human';
    categoryRequired = ['apparel'].slice(0, 1);
    scenarioName = 'women_clothing';
    scenarioSignals = [];
  } else if (hasLingerieSignal) {
    primary_domain = 'human_apparel';
    targetType = 'human';
    categoryRequired = ['lingerie', 'underwear'].slice(0, 2);
    scenarioName = 'lingerie';
    scenarioSignals = [];
  } else if (hasSexySignal && latest) {
    // "Sexy outfit" is often ambiguous (dress vs lingerie). Keep it as human apparel,
    // but mark a dedicated scenario so downstream retrieval can avoid wrong expansions.
    primary_domain = 'human_apparel';
    targetType = 'human';
    categoryRequired = [];
    scenarioName = 'sexy_outfit';
    scenarioSignals = [];
  } else if (
    // Direct toy request, or short follow-up that should stay on toy mission.
    hasToySignalLocal ||
    (isShortFollowup &&
      !hasBeautyToolSignalLocal &&
      !hasPetSignal &&
      !hasOuterwearSignal &&
      !hasColdScenario &&
      !hasWomenClothingSignal &&
      !hasLingerieSignal &&
      historyMission === 'toy_accessory')
  ) {
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
  const historySlice = recent_queries.slice(-5);
  const sanitizedHistory = historySlice
    .map((q) => String(q || '').trim())
    .filter((q) => q.length > 0)
    .map((q) => (q.length > 80 ? q.slice(0, 80) : q));
  const ignored = !useHistory ? sanitizedHistory : [];
  const used = useHistory ? sanitizedHistory : [];

  const mustExcludeKeywords =
    targetType === 'human' || targetType === 'pet'
      ? ['Labubu', 'doll', 'vinyl face doll', '娃娃', '公仔', '娃衣', '盲盒', 'pop mart'].slice(0, 16)
      : [];
  const mustExcludeDomains = targetType === 'human' || targetType === 'pet' ? ['toy_accessory'] : [];

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
    if (primary_domain === 'beauty' && scenarioName === 'beauty_tools') {
      missingSlots.push('makeup_goal', 'skin_type', 'base_product_type', 'budget');
    }
  }

  const confidenceDomain =
    scenarioName === 'discovery'
      ? 0.3
      : primary_domain === 'human_apparel'
      ? hasOuterwearSignal || hasColdScenario
        ? 0.9
        : 0.6
      : primary_domain === 'beauty'
        ? hasBeautyToolSignal
          ? 0.85
          : 0.6
      : primary_domain === 'toy_accessory'
        ? includesAny(latest, TOY_KEYWORDS)
          ? 0.9
          : 0.6
        : 0.5;
  const confidenceTarget =
    scenarioName === 'discovery'
      ? 0.3
      : targetType === 'unknown'
        ? 0.4
        : 0.9;
  const confidenceCategory =
    scenarioName === 'discovery'
      ? 0.3
      : categoryRequired.length
        ? 0.8
        : 0.4;
  const overall = Math.max(0, Math.min(1, (confidenceDomain + confidenceTarget + confidenceCategory) / 3));

  const budget = parseBudgetToPriceConstraint(latest);

  const intent = {
    intent_version: INTENT_VERSION,
    language,
    primary_domain,
    target_object: {
      type: targetType,
      age_group:
        targetType === 'human'
          ? 'adult'
          : targetType === 'toy'
            ? 'all'
            : targetType === 'pet'
              ? 'all'
              : 'unknown',
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
      price: budget || { currency: null, min: null, max: null },
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
  TOY_KEYWORDS_STRONG,
  TOY_KEYWORDS_WEAK,
  INTENT_VERSION,
};
