const {
  extractIntentWithMeta,
  buildDeterministicIntentWithMeta,
  _debug: intentLlmDebug = {},
} = require('./intentLlm');
const { injectPivotaAttributes, buildProductText, isToyLikeText } = require('./productTagger');
const { recommendToolKits } = require('./toolRecommender');
const { buildEyeShadowBrushReply } = require('./eyeShadowBrushAdvisor');
const { buildClarification } = require('./clarification');
const { buildScenarioAssociationPlan } = require('./scenarioAssociation');
const {
  detectBrandEntities,
  buildBrandQueryVariants,
  hasExplicitCategoryHint,
} = require('./brandLexicon');
const {
  buildBeautyQueryProfile,
  classifyBeautyBucketFromText,
  isBeautyBucketCompatibleForQuery,
} = require('./beautyQueryProfile');
const {
  createStrictFindProductsMultiRuntime,
} = require('../modules/decisioning/shopping_agent/strictFindProductsMulti');
const {
  summarizeCandidateSources,
} = require('../shared/beautyRecoCoarseClassifier');
const {
  _internals: productGroundingResolverInternals = {},
} = require('../services/productGroundingResolver');

const normalizeResolverLookupText =
  typeof productGroundingResolverInternals.normalizeTextForResolver === 'function'
    ? productGroundingResolverInternals.normalizeTextForResolver
    : (value) => String(value || '').trim().toLowerCase();
const tokenizeResolverLookupQuery =
  typeof productGroundingResolverInternals.tokenizeNormalizedResolverQuery === 'function'
    ? productGroundingResolverInternals.tokenizeNormalizedResolverQuery
    : (value) =>
        String(value || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
const resolveKnownStableLookupAlias =
  typeof productGroundingResolverInternals.resolveKnownStableProductRef === 'function'
    ? productGroundingResolverInternals.resolveKnownStableProductRef
    : null;
const strictFindProductsMultiRuntime = createStrictFindProductsMultiRuntime({
  buildBeautyQueryProfile,
});

const DEBUG_STATS_ENABLED = process.env.FIND_PRODUCTS_MULTI_DEBUG_STATS === '1';
const POLICY_VERSION = 'find_products_multi_policy_v40';
const BEAUTY_SEMANTIC_CONTRACT_VERSION = 'beauty_semantic_contract_v1';
const BEAUTY_DISCOVERY_CONTRACT_OWNER = 'shopping_agent_beauty_contract_builder';
const BEAUTY_DISCOVERY_MAINLINE_OWNER = 'shopping_agent_beauty_mainline';
const BEAUTY_DISCOVERY_PUBLIC_SURFACE = 'shopping_agent_public_beauty';
const STRATEGY_VERSION = 'ambiguity_gate_v2';
const SEARCH_AMBIGUITY_GATE_ENABLED =
  String(process.env.SEARCH_AMBIGUITY_GATE_ENABLED || 'true').toLowerCase() !== 'false';
const SEARCH_CLARIFY_ON_MEDIUM_AMBIGUITY =
  String(process.env.SEARCH_CLARIFY_ON_MEDIUM_AMBIGUITY || 'true').toLowerCase() !== 'false';
const SEARCH_SCENARIO_ASSOCIATION_ENABLED =
  String(process.env.SEARCH_SCENARIO_ASSOCIATION_ENABLED || 'true').toLowerCase() !== 'false';
const SEARCH_AGGRESSIVE_REWRITE_ENABLED =
  String(process.env.SEARCH_AGGRESSIVE_REWRITE_ENABLED || 'false').toLowerCase() === 'true';
const SEARCH_DOMAIN_HARD_FILTER_ENABLED =
  String(process.env.SEARCH_DOMAIN_HARD_FILTER_ENABLED || 'true').toLowerCase() !== 'false';
const SEARCH_DOMAIN_HARD_FILTER_MODE = ['strict', 'balanced'].includes(
  String(process.env.SEARCH_DOMAIN_HARD_FILTER_MODE || 'strict').toLowerCase(),
)
  ? String(process.env.SEARCH_DOMAIN_HARD_FILTER_MODE || 'strict').toLowerCase()
  : 'strict';
const SEARCH_DOMAIN_BALANCED_MIN_DROP_RATIO = Math.max(
  0,
  Math.min(1, Number(process.env.SEARCH_DOMAIN_BALANCED_MIN_DROP_RATIO || 0.4)),
);
const SEARCH_DOMAIN_FILTER_K_MIN = Math.max(
  1,
  Number(process.env.SEARCH_DOMAIN_FILTER_K_MIN || 6) || 6,
);
const SEARCH_DOMAIN_BEAUTY_FAIL_OPEN =
  String(process.env.SEARCH_DOMAIN_BEAUTY_FAIL_OPEN || 'false').toLowerCase() === 'true';
const SEARCH_EXTERNAL_FILL_GATED =
  String(process.env.SEARCH_EXTERNAL_FILL_GATED || 'true').toLowerCase() !== 'false';
const SEARCH_ANCHOR_ALIAS_V2 =
  String(process.env.SEARCH_ANCHOR_ALIAS_V2 || 'false').toLowerCase() === 'true';
const SEARCH_CLARIFY_MIN_RECALL_CANDIDATES = Math.max(
  1,
  Number(process.env.SEARCH_CLARIFY_MIN_RECALL_CANDIDATES || 6) || 6,
);
const SEARCH_CLARIFY_MIN_ANCHOR_RATIO = Math.max(
  0,
  Math.min(1, Number(process.env.SEARCH_CLARIFY_MIN_ANCHOR_RATIO || 0.12)),
);
const SEARCH_CLARIFY_MAX_DOMAIN_ENTROPY = Math.max(
  0,
  Math.min(1, Number(process.env.SEARCH_CLARIFY_MAX_DOMAIN_ENTROPY || 0.5)),
);

const BEAUTY_EXACT_TITLE_FORM_FACTOR_TOKENS = new Set([
  'serum',
  'essence',
  'ampoule',
  'toner',
  'lotion',
  'cleanser',
  'cleanse',
  'wash',
  'cream',
  'moisturizer',
  'moisturiser',
  'mask',
  'balm',
  'oil',
  'sunscreen',
  'sunblock',
  'gel',
  'mist',
  'treatment',
]);

const BEAUTY_EXACT_TITLE_GENERIC_TOKENS = new Set([
  'face',
  'facial',
  'skin',
  'skincare',
  'care',
  'body',
  'eye',
  'hand',
  'travel',
  'size',
  'jumbo',
  'mini',
  'daily',
  'gentle',
  'repair',
  'hydrating',
  'hydration',
  'barrier',
  'foam',
  'foaming',
  'with',
  'and',
  'plus',
  'default',
  'title',
  ...BEAUTY_EXACT_TITLE_FORM_FACTOR_TOKENS,
]);
const SEARCH_SCENARIO_ANCHOR_MODE = ['raw', 'derived', 'off'].includes(
  String(process.env.SEARCH_SCENARIO_ANCHOR_MODE || 'raw').toLowerCase(),
)
  ? String(process.env.SEARCH_SCENARIO_ANCHOR_MODE || 'raw').toLowerCase()
  : 'raw';
const SEARCH_SCENARIO_DERIVED_MIN_RECALL_CANDIDATES = Math.max(
  1,
  Number(process.env.SEARCH_SCENARIO_DERIVED_MIN_RECALL_CANDIDATES || 4) || 4,
);
const SEARCH_SCENARIO_DERIVED_MIN_ANCHOR_RATIO = Math.max(
  0,
  Math.min(1, Number(process.env.SEARCH_SCENARIO_DERIVED_MIN_ANCHOR_RATIO || 0.1)),
);
const SEARCH_SCENARIO_DERIVED_MAX_DOMAIN_ENTROPY = Math.max(
  0,
  Math.min(1, Number(process.env.SEARCH_SCENARIO_DERIVED_MAX_DOMAIN_ENTROPY || 0.6)),
);
const SEARCH_DOMAIN_CONDENSER_ENABLED =
  String(process.env.SEARCH_DOMAIN_CONDENSER_ENABLED || 'false').toLowerCase() === 'true';
const SEARCH_DOMAIN_CONDENSER_ENTROPY_TH = Math.max(
  0,
  Math.min(1, Number(process.env.SEARCH_DOMAIN_CONDENSER_ENTROPY_TH || 0.8)),
);
const SEARCH_DOMAIN_CONDENSER_MIN_CANDS_BEFORE = Math.max(
  1,
  Number(process.env.SEARCH_DOMAIN_CONDENSER_MIN_CANDS_BEFORE || 8) || 8,
);
const SEARCH_DOMAIN_CONDENSER_MIN_CANDS_AFTER = Math.max(
  1,
  Number(process.env.SEARCH_DOMAIN_CONDENSER_MIN_CANDS_AFTER || 4) || 4,
);
const FPM_GATE_SIMPLIFY_V1 =
  String(process.env.FPM_GATE_SIMPLIFY_V1 || 'true').toLowerCase() !== 'false';
const FPM_CLARIFY_NEVER_EMPTY =
  String(process.env.FPM_CLARIFY_NEVER_EMPTY || 'true').toLowerCase() !== 'false';
const FPM_DOMAIN_CONDENSER_REORDER_ONLY =
  String(process.env.FPM_DOMAIN_CONDENSER_REORDER_ONLY || 'true').toLowerCase() !== 'false';
const AMBIGUITY_THRESHOLD_CLARIFY = Math.max(
  0,
  Math.min(1, Number(process.env.SEARCH_AMBIGUITY_THRESHOLD_CLARIFY || 0.35)),
);
const AMBIGUITY_THRESHOLD_STRICT_EMPTY = Math.max(
  AMBIGUITY_THRESHOLD_CLARIFY,
  Math.min(1, Number(process.env.SEARCH_AMBIGUITY_THRESHOLD_STRICT_EMPTY || 0.55)),
);
const BEAUTY_DIVERSITY_ENABLED =
  String(process.env.FIND_PRODUCTS_MULTI_BEAUTY_DIVERSITY_ENABLED || 'true').toLowerCase() !==
  'false';
const BEAUTY_DIVERSITY_TOPN = Math.max(
  4,
  Math.min(20, Number(process.env.FIND_PRODUCTS_MULTI_BEAUTY_DIVERSITY_TOPN || 10) || 10),
);
const BEAUTY_DIVERSITY_MIN_BUCKETS = Math.max(
  2,
  Math.min(5, Number(process.env.FIND_PRODUCTS_MULTI_BEAUTY_DIVERSITY_MIN_BUCKETS || 3) || 3),
);
const BEAUTY_DIVERSITY_TOOLS_MAX_RATIO = Math.max(
  0,
  Math.min(1, Number(process.env.FIND_PRODUCTS_MULTI_BEAUTY_TOOLS_MAX_RATIO || 0.4)),
);
const FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_TIMEOUT_MS = Math.max(
  800,
  Math.min(
    15000,
    Number(process.env.FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_TIMEOUT_MS || 4500) || 4500,
  ),
);
const FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_STRICT_TIMEOUT_MS = Math.max(
  FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_TIMEOUT_MS,
  Math.min(
    15000,
    Number(process.env.FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_STRICT_TIMEOUT_MS || 5500) || 5500,
  ),
);
const BEAUTY_DIVERSITY_STRICT_EMPTY_ON_FAILURE =
  String(process.env.FIND_PRODUCTS_MULTI_BEAUTY_DIVERSITY_STRICT_EMPTY_ON_FAILURE || 'true').toLowerCase() !==
  'false';

// Feature flags / tunables for the global three-layer policy.
const ENABLE_WEAK_TIER = process.env.FIND_PRODUCTS_MULTI_ENABLE_WEAK_TIER !== 'false';
const OBJECT_CONF_THRESHOLD = Number(
  process.env.FIND_PRODUCTS_MULTI_OBJECT_CONF_THRESHOLD || '0.75',
);
const OBJECT_CONF_LOWER = Number(
  process.env.FIND_PRODUCTS_MULTI_OBJECT_CONF_LOWER || '0.45',
);
const ADULT_UNREQUESTED_BLOCK =
  process.env.FIND_PRODUCTS_MULTI_ADULT_UNREQUESTED_BLOCK !== 'false';
const COMPAT_CRITICAL_STRICT =
  process.env.FIND_PRODUCTS_MULTI_COMPAT_CRITICAL_STRICT !== 'false';
const WEAK_QUOTA_DEFAULT = Number(
  process.env.FIND_PRODUCTS_MULTI_WEAK_QUOTA_DEFAULT || '2',
);
const DEFAULT_BUDGET_FX_USD_RATES = Object.freeze({
  USD: 1,
  EUR: 1.09,
  GBP: 1.27,
  CNY: 0.14,
  JPY: 0.0067,
});
const FIND_PRODUCTS_MULTI_BUDGET_FX_USD_RATES = (() => {
  const raw = String(process.env.FIND_PRODUCTS_MULTI_BUDGET_FX_USD_RATES || '').trim();
  if (!raw) {
    return DEFAULT_BUDGET_FX_USD_RATES;
  }
  try {
    const parsed = JSON.parse(raw);
    const normalized = Object.entries(parsed || {}).reduce((acc, [key, value]) => {
      const currency = String(key || '').trim().toUpperCase();
      const rate = Number(value);
      if (currency && Number.isFinite(rate) && rate > 0) {
        acc[currency] = rate;
      }
      return acc;
    }, {});
    return Object.freeze({
      ...DEFAULT_BUDGET_FX_USD_RATES,
      ...normalized,
    });
  } catch (_error) {
    return DEFAULT_BUDGET_FX_USD_RATES;
  }
})();
const FIND_PRODUCTS_MULTI_BUDGET_FX_SOURCE =
  String(process.env.FIND_PRODUCTS_MULTI_BUDGET_FX_SOURCE || '').trim() ||
  (String(process.env.FIND_PRODUCTS_MULTI_BUDGET_FX_USD_RATES || '').trim().length > 0
    ? 'env_usd_base_rates'
    : 'static_default');

function resolveSemanticRewriteTimeoutMs(semanticContract = null) {
  const contract = normalizeSearchSemanticContract(semanticContract);
  if (contract?.request_class === 'exact_lookup') return 0;
  if (contract?.source_surface === 'aurora_beauty_strict') {
    return FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_STRICT_TIMEOUT_MS;
  }
  return FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_TIMEOUT_MS;
}

// Reason codes (atomic; safe to log/aggregate).
const REASON_CODES = {
  OBJ_EXACT: 'OBJ_EXACT',
  OBJ_COMPATIBLE: 'OBJ_COMPATIBLE',
  OBJ_MISMATCH: 'OBJ_MISMATCH',
  OBJ_UNCERTAIN: 'OBJ_UNCERTAIN',

  CAT_EXACT: 'CAT_EXACT',
  CAT_SIBLING: 'CAT_SIBLING',
  CAT_PARENT: 'CAT_PARENT',
  CAT_ANCESTOR: 'CAT_ANCESTOR',
  CAT_FAR: 'CAT_FAR',

  MISSING_SIZE: 'MISSING_SIZE',
  MISSING_MODEL: 'MISSING_MODEL',
  MISSING_INTERFACE: 'MISSING_INTERFACE',
  MISSING_WEIGHT_RANGE: 'MISSING_WEIGHT_RANGE',
  CONSTRAINT_PARTIAL: 'CONSTRAINT_PARTIAL',
  PREFERENCE_MISMATCH: 'PREFERENCE_MISMATCH',

  SCENE_MISMATCH: 'SCENE_MISMATCH',
  SEASON_MISMATCH: 'SEASON_MISMATCH',

  ADULT_UNREQUESTED: 'ADULT_UNREQUESTED',
  ADULT_NEEDS_CONFIRMATION: 'ADULT_NEEDS_CONFIRMATION',
  NOT_TOOL_PRODUCT: 'NOT_TOOL_PRODUCT',
  NOT_EYE_BRUSH_PRODUCT: 'NOT_EYE_BRUSH_PRODUCT',
  COMPAT_INCOMPATIBLE: 'COMPAT_INCOMPATIBLE',
  COMPAT_UNKNOWN: 'COMPAT_UNKNOWN',
  SAFETY_RISK: 'SAFETY_RISK',
  TOY_ONLY_LEFT: 'TOY_ONLY_LEFT',
  ALL_HARD_BLOCKED: 'ALL_HARD_BLOCKED',
};

const LINGERIE_KEYWORDS = [
  // Deprecated: kept for compatibility with older code paths.
];

// Be careful with substring matching: tokens like "bra" appear in unrelated words
// (e.g. "breathable"). Use word boundaries for short latin terms.
const LINGERIE_PATTERNS = [
  // EN
  /\b(lingerie|underwear)\b/i,
  /\b(bra|bras)\b/i,
  /\b(panty|panties|thong|briefs)\b/i,
  /\b(sex\s*toy|adult)\b/i,
  // ES
  /\b(lencer[ií]a|ropa\s+interior|sujetador|bragas|tanga)\b/i,
  // FR
  /\b(sous[-\s]?v[eê]tement|soutien[-\s]?gorge|culotte|string)\b/i,
  // ZH
  /内衣|文胸|胸罩|丁字裤|情趣|成人用品/,
  // JA
  /下着|ブラ|パンティ|ランジェリー/,
];

const FRAGRANCE_QUERY_REGEX =
  /\b(perfume|fragrance|parfum|cologne|eau de parfum|eau de toilette|body mist)\b|香水|香氛|古龙|古龍|香體|香体/i;
const BRAND_TERM_SUFFIXES = new Set([
  'beauty',
  'cosmetic',
  'cosmetics',
  'fragrance',
  'perfume',
  'parfum',
  'makeup',
]);

function hasFragranceFreeSkincareSignal(rawQuery = '') {
  return /\b(fragrance(?:\s|-)?free|fragranceless|unscented|without fragrance|no fragrance|sans parfum)\b/i.test(
    String(rawQuery || ''),
  );
}

function inferFragranceSemanticClass(rawQuery = '') {
  if (hasFragranceFreeSkincareSignal(rawQuery)) return 'fragrance_free_skincare';
  return FRAGRANCE_QUERY_REGEX.test(String(rawQuery || '')) ? 'fragrance' : '';
}

function hasFragranceQuerySignal(rawQuery) {
  return inferFragranceSemanticClass(rawQuery) === 'fragrance';
}

function isExternalSeedProduct(product) {
  if (!product || typeof product !== 'object') return false;
  const merchantId = String(product.merchant_id || product.merchantId || '').trim().toLowerCase();
  const source = String(product.source || '').trim().toLowerCase();
  return merchantId === 'external_seed' || source === 'external_seed';
}

function normalizeBrandTerms(terms) {
  if (!Array.isArray(terms)) return [];
  const out = [];
  const seen = new Set();
  for (const term of terms) {
    const normalized = normalizeWordTokens(term).join(' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function hasBrandTermMatchInText(text, term) {
  const normalizedText = String(text || '').toLowerCase();
  const normalizedTerm = String(term || '').toLowerCase().trim();
  if (!normalizedText || !normalizedTerm) return false;
  if (normalizedText.includes(normalizedTerm)) return true;

  const compactText = normalizedText.replace(/\s+/g, '');
  const compactTerm = normalizedTerm.replace(/\s+/g, '');
  if (compactTerm && compactText.includes(compactTerm)) return true;

  const tokens = normalizeWordTokens(normalizedTerm).filter((token) => !BRAND_TERM_SUFFIXES.has(token));
  if (!tokens.length) return false;
  if (tokens.length === 1) return normalizedText.includes(tokens[0]);
  return tokens.every((token) => normalizedText.includes(token));
}

function includesAny(haystack, needles) {
  if (!haystack) return false;
  const lowered = String(haystack).toLowerCase();
  return needles.some((k) => lowered.includes(String(k).toLowerCase()));
}

function detectAdultIntentStrength(rawQuery) {
  const q = String(rawQuery || '');
  if (!q) return 'none';

  // Strong: explicitly lingerie/underwear.
  const strong = [
    /\b(lingerie|underwear)\b/i,
    /\b(bra|bras)\b/i,
    /\b(panty|panties|thong)\b/i,
    /\b(sex\s*toy|adult)\b/i,
    /\b(lencer[ií]a|ropa\s+interior|sujetador|bragas|tanga)\b/i,
    /\b(sous[-\s]?v[eê]tement|soutien[-\s]?gorge)\b/i,
    /下着|内衣|情趣|成人用品/,
  ];
  if (strong.some((re) => re.test(q))) return 'strong';

  // Soft: "sexy" requests are adult-adjacent and should allow lingerie results,
  // otherwise we end up filtering the whole candidate set and showing irrelevant items.
  const soft = [
    /\bsexy\b/i,
    /性感/,
    /セクシー/,
    /\ber[oó]tico\b/i,
  ];
  if (soft.some((re) => re.test(q))) return 'soft';

  return 'none';
}

function isLingerieLikeProduct(product) {
  const text = buildProductText(product);
  if (!text) return false;
  return LINGERIE_PATTERNS.some((re) => re.test(text));
}

function isBeautyToolLikeProduct(product) {
  const text = buildProductText(product);
  if (!text) return false;
  // EN/Latin keywords
  if (/\b(brush|brushes|puff|sponge|beauty blender|curler|tweezer|applicator|cleaning pad|brush cleaner|cleaner)\b/.test(text)) {
    return true;
  }
  // CJK keywords
  return /化妆刷|刷具|粉底刷|散粉刷|腮红刷|修容刷|遮瑕刷|眼影刷|晕染刷|美妆蛋|海绵蛋|粉扑|气垫扑|睫毛夹|清洁垫|清洁剂|メイクブラシ|化粧筆|ブラシセット/.test(text);
}

function isEyeBrushLikeProduct(product) {
  const text = buildProductText(product);
  if (!text) return false;
  // Must include an eye-specific signal; avoid generic "brush set" that might be full-face.
  const eyeSignals =
    /\b(eye\s*shadow|eyeshadow|eye\s*brush|blending brush|crease brush|pencil brush|smudger|eyeliner brush|tightline)\b/i.test(text) ||
    /眼影刷|眼部刷|眼妆刷|晕染刷|过渡刷|铺色刷|铅笔刷|烟熏刷|眼线刷|下眼睑刷|卧蚕刷|眼窝刷/.test(text) ||
    /アイシャドウブラシ|ブレンディングブラシ|クリースブラシ|鉛筆ブラシ|スマッジャー|アイライナーブラシ|下まぶた/.test(text) ||
    /\b(pinceau\s+(?:fard|paupi[eè]res)|pinceau\s+estompeur|pinceau\s+crayon|pinceau\s+eye-?liner)\b/i.test(text) ||
    /\b(pincel\s+de\s+(?:sombra|ojos)|pincel\s+difuminador|pincel\s+l[aá]piz|pincel\s+delineador)\b/i.test(text);
  if (!eyeSignals) return false;
  // Exclude clearly non-eye face roles when no eye signal exists (handled above).
  return true;
}

function hasPetSignalInProduct(product) {
  const text = buildProductText(product);
  // Do not "short-circuit" to CJK-only checks: many Shopify products include CJK
  // option labels (e.g. 尺寸/颜色) even when the title/description is English.
  const cjkHit =
    /[\u4e00-\u9fff\u3040-\u30ff]/.test(text) &&
    ['宠物', '狗', '狗狗', '猫', '犬', 'ペット', '犬服', '猫服', '狗衣服', '宠物衣服', '狗背带', '宠物背带', '胸背'].some((k) =>
      text.includes(k)
    );
  // Word-boundary checks to avoid false positives like "catsuit".
  const latinHit =
    /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets)\b/.test(text) ||
    /\b(dog\s+harness|pet\s+harness|cat\s+harness)\b/.test(text) ||
    /\b(perro|perros|perrita|cachorro|mascota|mascotas|gato|gatos)\b/.test(text) ||
    /\b(chien|chiens|chienne|chiot|animal|animaux|chat|chats)\b/.test(text);
  return cjkHit || latinHit;
}

function getProductPriceMajor(product) {
  if (!product) return NaN;

  const majorCandidates = [
    product.price,
    product.price_amount,
    product.priceAmount,
    product.amount,
    product.amount_total,
    product.amountTotal,
  ];
  for (const raw of majorCandidates) {
    if (raw == null) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const m = raw.match(/(\d+(?:\.\d+)?)/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  const minorCandidates = [
    product.price_minor,
    product.priceMinor,
    product.price_cents,
    product.priceCents,
    product.amount_minor,
    product.amountMinor,
  ];
  for (const raw of minorCandidates) {
    if (raw == null) continue;
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (Number.isFinite(n)) return n / 100;
  }

  return NaN;
}

function normalizePriceCurrencyCode(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return String(fallback || '').trim().toUpperCase();
  const upper = text.toUpperCase();
  if (upper === '$' || upper === 'USD' || /USD|DOLLAR|美元|美金/.test(upper)) return 'USD';
  if (upper === '€' || upper === 'EUR' || /EUR|EURO|欧元/.test(upper)) return 'EUR';
  if (upper === '£' || upper === 'GBP' || /GBP|POUND|英镑/.test(upper)) return 'GBP';
  if (
    upper === '¥' ||
    upper === '￥' ||
    upper === 'CNY' ||
    upper === 'RMB' ||
    /人民币|元/.test(String(value || ''))
  ) {
    return 'CNY';
  }
  if (upper === 'JPY' || /YEN|円|日元|日圆/.test(String(value || ''))) return 'JPY';
  return upper || String(fallback || '').trim().toUpperCase();
}

function getProductPriceCurrency(product, fallback = 'USD') {
  if (!product || typeof product !== 'object') {
    return normalizePriceCurrencyCode(fallback, 'USD') || 'USD';
  }
  return (
    normalizePriceCurrencyCode(
      product.currency ||
        product.price_currency ||
        product.priceCurrency ||
        product.price?.currency ||
        product.price?.currency_code,
      fallback,
    ) || normalizePriceCurrencyCode(fallback, 'USD') || 'USD'
  );
}

function formatBudgetAmountForHint(currency, amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return '';
  const value = Number(amount);
  const normalizedCurrency = normalizePriceCurrencyCode(currency, '');
  const formattedValue = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (normalizedCurrency === 'USD') return `$${formattedValue}`;
  if (normalizedCurrency === 'EUR') return `€${formattedValue}`;
  if (normalizedCurrency === 'GBP') return `£${formattedValue}`;
  if (normalizedCurrency === 'CNY') return `CNY ${formattedValue}`;
  if (normalizedCurrency === 'JPY') return `JPY ${formattedValue}`;
  return normalizedCurrency ? `${formattedValue} ${normalizedCurrency}` : formattedValue;
}

function resolveBudgetConstraintForCurrency(priceConstraint, candidateCurrency, fallbackCurrency = 'USD') {
  if (
    !priceConstraint ||
    (priceConstraint.min == null && priceConstraint.max == null)
  ) {
    return {
      constraint: null,
      metadata: null,
    };
  }

  const targetCurrency = normalizePriceCurrencyCode(candidateCurrency, fallbackCurrency) || 'USD';
  const sourceCurrency = normalizePriceCurrencyCode(priceConstraint.currency, '');
  const baseConstraint = {
    currency: sourceCurrency || null,
    min: priceConstraint.min == null ? null : Number(priceConstraint.min),
    max: priceConstraint.max == null ? null : Number(priceConstraint.max),
  };

  if (!sourceCurrency) {
    return {
      constraint: {
        currency: targetCurrency,
        min: baseConstraint.min,
        max: baseConstraint.max,
      },
      metadata: {
        budget_fx_applied: false,
        budget_fx_rate: null,
        budget_fx_source: null,
        budget_fx_candidate_currency: targetCurrency,
        budget_fx_unresolved: false,
      },
    };
  }

  if (sourceCurrency === targetCurrency) {
    return {
      constraint: {
        currency: targetCurrency,
        min: baseConstraint.min,
        max: baseConstraint.max,
      },
      metadata: {
        budget_fx_applied: true,
        budget_fx_rate: 1,
        budget_fx_source: 'direct_currency_match',
        budget_fx_candidate_currency: targetCurrency,
        budget_fx_unresolved: false,
      },
    };
  }

  const sourceRate = FIND_PRODUCTS_MULTI_BUDGET_FX_USD_RATES[sourceCurrency];
  const targetRate = FIND_PRODUCTS_MULTI_BUDGET_FX_USD_RATES[targetCurrency];
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    return {
      constraint: null,
      metadata: {
        budget_fx_applied: false,
        budget_fx_rate: null,
        budget_fx_source: FIND_PRODUCTS_MULTI_BUDGET_FX_SOURCE,
        budget_fx_candidate_currency: targetCurrency,
        budget_fx_unresolved: true,
      },
    };
  }

  const fxRate = sourceRate / targetRate;
  const convertBound = (value) =>
    value == null || !Number.isFinite(Number(value))
      ? null
      : Math.round(Number(value) * fxRate * 100) / 100;

  return {
    constraint: {
      currency: targetCurrency,
      min: convertBound(baseConstraint.min),
      max: convertBound(baseConstraint.max),
    },
    metadata: {
      budget_fx_applied: true,
      budget_fx_rate: Math.round(fxRate * 1000000) / 1000000,
      budget_fx_source: FIND_PRODUCTS_MULTI_BUDGET_FX_SOURCE,
      budget_fx_candidate_currency: targetCurrency,
      budget_fx_unresolved: false,
    },
  };
}

function buildBudgetFxMetadata(priceConstraint, products = [], fallbackProducts = []) {
  if (
    !priceConstraint ||
    (priceConstraint.min == null && priceConstraint.max == null)
  ) {
    return null;
  }
  const candidateProduct =
    (Array.isArray(products) ? products : []).find((product) => getProductPriceCurrency(product, '')) ||
    (Array.isArray(fallbackProducts) ? fallbackProducts : []).find((product) =>
      getProductPriceCurrency(product, ''),
    ) ||
    null;
  const candidateCurrency = getProductPriceCurrency(
    candidateProduct,
    normalizePriceCurrencyCode(priceConstraint.currency, 'USD') || 'USD',
  );
  return resolveBudgetConstraintForCurrency(priceConstraint, candidateCurrency).metadata;
}

function isWithinPriceConstraint(price, constraint) {
  if (!constraint) return true;
  if (!Number.isFinite(price)) return false;
  const minOk = constraint.min == null || price >= Number(constraint.min);
  const maxOk = constraint.max == null || price <= Number(constraint.max);
  return minOk && maxOk;
}

function detectHarnessSignal(rawQuery) {
  const q = String(rawQuery || '');
  if (!q) return false;
  return (
    /背带|胸背|牵引|牵引绳|遛狗绳|狗链|项圈|胸背带|宠物背带|狗背带/.test(q) ||
    /\b(harness|dog\s+harness|pet\s+harness|no-?pull|leash|dog\s+leash|pet\s+leash|collar|lead)\b/i.test(q) ||
    /\b(harnais)\b/i.test(q) ||
    /\b(arn[eé]s)\b/i.test(q) ||
    /ハーネス|胴輪/.test(q)
  );
}

function detectLeashSignal(rawQuery) {
  const q = String(rawQuery || '');
  if (!q) return false;
  return (
    /牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|狗绳|狗繩|项圈|項圈/.test(q) ||
    /\b(leash|dog\s+leash|pet\s+leash|lead|collar|training\s+leash)\b/i.test(q) ||
    /\b(laisse|collier)\b/i.test(q) ||
    /\b(correa|collar)\b/i.test(q) ||
    /リード|首輪/.test(q)
  );
}

function detectPetApparelSignal(rawQuery) {
  const q = String(rawQuery || '');
  if (!q) return false;
  return (
    /衣服|外套|毛衣|雨衣|睡衣|背心|夹克|狗衣服|宠物衣服|犬服|猫服/.test(q) ||
    /\b(jacket|coat|sweater|hoodie|raincoat|clothes|clothing|apparel|outfit|overalls)\b/i.test(q) ||
    /\b(chaqueta|abrigo|su[eé]ter|ropa|impermeable)\b/i.test(q) ||
    /\b(veste|manteau|pull|v[eê]tement|imperm[eé]able)\b/i.test(q) ||
    /服|コート|ジャケット|犬服/.test(q)
  );
}

function containsAliasStopword(rawQuery) {
  const q = String(rawQuery || '').toLowerCase();
  if (!q) return false;
  return /\b(recommend|suggest|anything|something|random|gift|checklist)\b/.test(q) || /推荐|随便|什么|东西|好物|礼物|清单/.test(q);
}

function buildAnchorAliasTerms(rawQuery, intent, queryClass) {
  if (!SEARCH_ANCHOR_ALIAS_V2) return [];
  const q = String(rawQuery || '');
  if (!q) return [];
  if (containsAliasStopword(q) && !['gift', 'mission', 'scenario'].includes(normalizeQueryClass(queryClass, { defaultValue: null }))) {
    return [];
  }

  const terms = [];
  const normalizedClass = normalizeQueryClass(queryClass, { defaultValue: null });
  const domain = inferSearchDomainKey(intent, rawQuery);

  if (detectLeashSignal(q)) {
    terms.push('dog leash', 'pet leash', 'dog collar', 'dog harness', 'lead');
  }
  if (/\b(makeup brush|foundation brush|powder brush|brush set)\b/i.test(q) || /化妆刷|化妝刷|刷具|粉底刷|散粉刷/.test(q)) {
    terms.push('makeup brush', 'foundation brush', 'powder brush', 'brush set');
  }
  if (normalizedClass === 'scenario' || normalizedClass === 'mission') {
    if (domain === 'travel') {
      terms.push('packing cubes', 'travel adapter', 'toiletry bag', 'carry-on organizer');
    }
    if (domain === 'beauty' && /约会|約會|date/.test(q.toLowerCase())) {
      terms.push('foundation', 'mascara', 'lipstick', 'setting spray');
    }
  }

  return Array.from(new Set(terms.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 10);
}

function detectLargeDogSignal(rawQuery) {
  const q = String(rawQuery || '');
  if (!q) return false;
  return (
    /大型犬|大狗|中大型|大码/.test(q) ||
    /金毛|拉布拉多|德牧|哈士奇|萨摩耶|阿拉斯加|罗威纳|秋田/.test(q) ||
    /\b(golden\s+retriever|labrador|german\s+shepherd|husky|samoyed|alaskan|rottweiler|akita)\b/i.test(
      q,
    )
  );
}

function hasDogMeasurementsInQuery(rawQuery) {
  const q = String(rawQuery || '');
  if (!q) return false;
  // chest/back/neck measurements, or explicit size codes.
  return (
    /\b\d{2,3}\s*(cm|mm|in|inch|inches)\b/i.test(q) ||
    /胸围|胸圍|背长|背長|颈围|頸圍|胴回り|背丈|首回り/.test(q) ||
      /\b(XXL|2XL|3XL|4XL|5XL|XL)\b/i.test(q)
  );
}

const FASHION_VISIBLE_CATEGORY_RULES = [
  { label: 'sweater', query: /\b(sweater|jumper)\b|毛衣|针织衫/i, match: /\b(sweater|jumper|knit sweater)\b|毛衣|针织/i },
  { label: 'hoodie', query: /\bhoodie\b|卫衣/i, match: /\bhoodie\b|卫衣/i },
  { label: 'vest', query: /\bvest\b|背心/i, match: /\bvest\b|背心/i },
  { label: 'dress', query: /\bdress\b|连衣裙|洋装/i, match: /\bdress\b|连衣裙|洋装/i },
  { label: 'skirt', query: /\bskirt\b|半身裙|短裙/i, match: /\bskirt\b|半身裙|短裙/i },
];

const FASHION_VISIBLE_ATTRIBUTE_RULES = [
  { label: 'striped', query: /\bstriped\b|条纹/i, match: /\bstriped\b|条纹/i },
  { label: 'sleeveless', query: /\bsleeveless\b|无袖/i, match: /\bsleeveless\b|无袖/i },
  { label: 'fleece', query: /\b(polar\s+fleece|fleece)\b|抓绒|摇粒绒/i, match: /\b(polar\s+fleece|fleece)\b|抓绒|摇粒绒/i },
  { label: 'color_block', query: /\bcolor[\s-]?block\b|撞色/i, match: /\bcolor[\s-]?block\b|撞色/i },
  { label: 'knitted', query: /\b(knitted|knit)\b|针织/i, match: /\b(knitted|knit)\b|针织/i },
  { label: 'waterproof', query: /\bwaterproof\b|防水/i, match: /\bwaterproof\b|防水/i },
  { label: 'wool', query: /\bwool\b|羊毛/i, match: /\bwool\b|羊毛/i },
  { label: 'cotton', query: /\bcotton\b|棉/i, match: /\bcotton\b|纯棉|全棉/i },
];

const FASHION_VISIBLE_COLOR_OPTION_RULES = [
  { label: 'color_black', query: /\bblack\b|黑/i, match: /\bblack\b|黑/i },
  { label: 'color_blue', query: /\bblue\b|蓝/i, match: /\bblue\b|蓝/i },
  { label: 'color_gray', query: /\b(gray|grey)\b|灰/i, match: /\b(gray|grey)\b|灰/i },
  { label: 'color_pink', query: /\bpink\b|粉/i, match: /\bpink\b|粉/i },
  { label: 'color_red', query: /\bred\b|红/i, match: /\bred\b|红/i },
  { label: 'color_white', query: /\bwhite\b|白/i, match: /\bwhite\b|白/i },
];

const FASHION_VISIBLE_SIZE_OPTION_RULES = [
  {
    label: 'size_xs',
    query: /\bsize[\s:-]*xs\b|\bextra\s+small\b|尺码[\s:-]*xs|尺碼[\s:-]*xs/i,
    match: /\b(extra\s+small|xs)\b/i,
  },
  {
    label: 'size_s',
    query: /\bsize[\s:-]*s\b|\bsmall\b|尺码[\s:-]*s|尺碼[\s:-]*s/i,
    match: /\b(small|s)\b/i,
  },
  {
    label: 'size_m',
    query: /\bsize[\s:-]*m\b|\bmedium\b|尺码[\s:-]*m|尺碼[\s:-]*m/i,
    match: /\b(medium|m)\b/i,
  },
  {
    label: 'size_l',
    query: /\bsize[\s:-]*l\b|\blarge\b|尺码[\s:-]*l|尺碼[\s:-]*l/i,
    match: /\b(large|l)\b/i,
  },
  {
    label: 'size_xl',
    query: /\bsize[\s:-]*xl\b|\bx-?large\b|尺码[\s:-]*xl|尺碼[\s:-]*xl/i,
    match: /\b(x-?large|xl)\b/i,
  },
  {
    label: 'size_xxl',
    query: /\bsize[\s:-]*(xxl|2xl)\b|\b(xx-?large|2x-?large)\b|尺码[\s:-]*(xxl|2xl)|尺碼[\s:-]*(xxl|2xl)/i,
    match: /\b(xx-?large|2x-?large|xxl|2xl)\b/i,
  },
];

function extractPatternLabels(rawQuery, rules) {
  const text = String(rawQuery || '');
  const labels = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || !rule.label || !(rule.query instanceof RegExp)) continue;
    if (rule.query.test(text)) labels.push(String(rule.label));
  }
  return Array.from(new Set(labels));
}

function collectProductOptionText(product) {
  const fragments = [];
  const variants = Array.isArray(product?.variants)
    ? product.variants
    : Array.isArray(product?.product_data?.variants)
      ? product.product_data.variants
      : [];
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') continue;
    if (variant.title) fragments.push(String(variant.title));
    if (variant.name) fragments.push(String(variant.name));
    const options = variant.options;
    if (Array.isArray(options)) {
      for (const item of options) {
        if (item == null) continue;
        if (typeof item === 'string' || typeof item === 'number') {
          fragments.push(String(item));
        } else if (typeof item === 'object') {
          if (item.name) fragments.push(String(item.name));
          if (item.value) fragments.push(String(item.value));
          if (item.option_name) fragments.push(String(item.option_name));
          if (item.option_value) fragments.push(String(item.option_value));
        }
      }
    } else if (options && typeof options === 'object') {
      for (const [name, value] of Object.entries(options)) {
        if (name) fragments.push(String(name));
        if (value != null) fragments.push(String(value));
      }
    }
  }
  if (Array.isArray(product?.visible_option_labels)) {
    fragments.push(...product.visible_option_labels.map((item) => String(item || '')));
  }
  if (Array.isArray(product?.attributes?.pivota?.visible_option_labels)) {
    fragments.push(...product.attributes.pivota.visible_option_labels.map((item) => String(item || '')));
  }
  return fragments.join(' ').toLowerCase();
}

function matchLabelsFromProducts(products, labels, rules, textGetter) {
  const list = Array.isArray(products) ? products : [];
  const out = [];
  for (const label of Array.isArray(labels) ? labels : []) {
    const rule = (Array.isArray(rules) ? rules : []).find((item) => String(item?.label || '') === String(label));
    if (!rule || !(rule.match instanceof RegExp)) continue;
    const matched = list.some((product) => {
      const text = String(textGetter(product) || '');
      return text.length > 0 && rule.match.test(text);
    });
    if (matched) out.push(String(label));
  }
  return out;
}

function buildFashionConstraintState(rawQuery, existingMetadata) {
  const existingMeta =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? existingMetadata
      : {};

  const derivedVisibleCategoryIntents = extractPatternLabels(rawQuery, FASHION_VISIBLE_CATEGORY_RULES);
  const derivedVisibleAttributeIntents = extractPatternLabels(rawQuery, FASHION_VISIBLE_ATTRIBUTE_RULES);
  const derivedVisibleOptionIntents = [
    ...extractPatternLabels(rawQuery, FASHION_VISIBLE_SIZE_OPTION_RULES),
    ...extractPatternLabels(rawQuery, FASHION_VISIBLE_COLOR_OPTION_RULES),
  ];

  const visibleCategoryIntents = Array.isArray(existingMeta.visible_category_intents)
    ? existingMeta.visible_category_intents.map((item) => String(item || '')).filter(Boolean)
    : derivedVisibleCategoryIntents;
  const visibleAttributeIntents = Array.isArray(existingMeta.visible_attribute_intents)
    ? existingMeta.visible_attribute_intents.map((item) => String(item || '')).filter(Boolean)
    : derivedVisibleAttributeIntents;
  const visibleOptionIntents = Array.isArray(existingMeta.visible_option_intents)
    ? existingMeta.visible_option_intents.map((item) => String(item || '')).filter(Boolean)
    : derivedVisibleOptionIntents;

  return {
    visibleCategoryIntents,
    visibleAttributeIntents,
    visibleOptionIntents,
    hasFashionConstraintSignal:
      visibleCategoryIntents.length > 0 &&
      (visibleAttributeIntents.length > 0 || visibleOptionIntents.length > 0),
  };
}

function hasFashionConstraintQuerySignal(rawQuery, existingMetadata) {
  return Boolean(buildFashionConstraintState(rawQuery, existingMetadata)?.hasFashionConstraintSignal);
}

function productMatchesAllRuleLabels(product, labels, rules, textGetter) {
  const text = String(textGetter(product) || '');
  if (!Array.isArray(labels) || labels.length === 0) return true;
  if (!text) return false;
  return labels.every((label) => {
    const rule = (Array.isArray(rules) ? rules : []).find((item) => String(item?.label || '') === String(label));
    return rule && rule.match instanceof RegExp ? rule.match.test(text) : false;
  });
}

function filterProductsByFashionConstraints(products, state) {
  const list = Array.isArray(products) ? products : [];
  if (!state?.hasFashionConstraintSignal || list.length === 0) return list;

  return list.filter((product) => {
    const productText = buildProductText(product);
    const optionText = collectProductOptionText(product);
    return (
      productMatchesAllRuleLabels(product, state.visibleCategoryIntents, FASHION_VISIBLE_CATEGORY_RULES, () => productText) &&
      productMatchesAllRuleLabels(product, state.visibleAttributeIntents, FASHION_VISIBLE_ATTRIBUTE_RULES, () => productText) &&
      productMatchesAllRuleLabels(
        product,
        state.visibleOptionIntents.filter((label) => String(label || '').startsWith('size_')),
        FASHION_VISIBLE_SIZE_OPTION_RULES,
        () => optionText,
      ) &&
      productMatchesAllRuleLabels(
        product,
        state.visibleOptionIntents.filter((label) => String(label || '').startsWith('color_')),
        FASHION_VISIBLE_COLOR_OPTION_RULES,
        () => `${productText} ${optionText}`,
      )
    );
  });
}

function buildFashionConstraintMetadata({ rawQuery, products, existingMetadata }) {
  const existingMeta =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? existingMetadata
      : {};
  const {
    visibleCategoryIntents,
    visibleAttributeIntents,
    visibleOptionIntents,
    hasFashionConstraintSignal,
  } = buildFashionConstraintState(rawQuery, existingMeta);
  if (!hasFashionConstraintSignal) return {};

  const matchedVisibleCategories = Array.isArray(existingMeta.matched_visible_categories)
    ? existingMeta.matched_visible_categories.map((item) => String(item || '')).filter(Boolean)
    : matchLabelsFromProducts(products, visibleCategoryIntents, FASHION_VISIBLE_CATEGORY_RULES, (product) =>
        buildProductText(product),
      );
  const matchedVisibleAttributeLabels = Array.isArray(existingMeta.matched_visible_attribute_labels)
    ? existingMeta.matched_visible_attribute_labels.map((item) => String(item || '')).filter(Boolean)
    : matchLabelsFromProducts(products, visibleAttributeIntents, FASHION_VISIBLE_ATTRIBUTE_RULES, (product) =>
        buildProductText(product),
      );
  const matchedVisibleOptionLabels = Array.isArray(existingMeta.matched_visible_option_labels)
    ? existingMeta.matched_visible_option_labels.map((item) => String(item || '')).filter(Boolean)
    : [
        ...matchLabelsFromProducts(products, visibleOptionIntents, FASHION_VISIBLE_SIZE_OPTION_RULES, (product) =>
          collectProductOptionText(product),
        ),
        ...matchLabelsFromProducts(products, visibleOptionIntents, FASHION_VISIBLE_COLOR_OPTION_RULES, (product) =>
          `${buildProductText(product)} ${collectProductOptionText(product)}`,
        ),
      ];

  return {
    visible_category_intents: visibleCategoryIntents,
    visible_attribute_intents: visibleAttributeIntents,
    visible_option_intents: visibleOptionIntents,
    matched_visible_categories: Array.from(new Set(matchedVisibleCategories)),
    matched_visible_attribute_labels: Array.from(new Set(matchedVisibleAttributeLabels)),
    matched_visible_option_labels: Array.from(new Set(matchedVisibleOptionLabels)),
  };
}

function isPetHarnessProduct(product) {
  const text = buildProductText(product);
  return (
    /\b(harness|no-?pull|leash|collar|lead)\b/i.test(text) ||
    /背带|胸背|牵引|牵引绳|狗链|项圈|胸背带|胴輪|ハーネス/.test(text) ||
    /\b(harnais)\b/i.test(text) ||
    /\b(arn[eé]s)\b/i.test(text)
  );
}

function isPetApparelProduct(product) {
  const text = buildProductText(product);
  return (
    /\b(jacket|coat|sweater|raincoat|hoodie|overalls|parka|vest|clothes|clothing|apparel)\b/i.test(text) ||
    /衣服|外套|毛衣|雨衣|卫衣|睡衣|背心|犬服|猫服|ペット.*服|犬服/.test(text)
  );
}

function getLargeDogSizeScore(product) {
  const text = buildProductText(product);
  const positive =
    /\b(XXL|2XL|3XL|4XL|5XL|XL)\b/i.test(text) ||
    /\b(large\s+breed|big\s+dog)\b/i.test(text) ||
    /大型犬|中大型|大码|加大/.test(text);
  const negative =
    /\b(XXS|XS)\b/i.test(text) ||
    /\b(small\s+breed|toy\s+dog)\b/i.test(text) ||
    /小型犬|茶杯/.test(text);
  if (positive && !negative) return 1;
  if (negative && !positive) return -1;
  return 0;
}

function interleavePetHarnessAndApparel(products) {
  const harness = [];
  const apparel = [];
  const rest = [];
  for (const p of products) {
    if (isPetHarnessProduct(p)) harness.push(p);
    else if (isPetApparelProduct(p)) apparel.push(p);
    else rest.push(p);
  }

  const out = [];
  let i = 0;
  let j = 0;
  let toggle = 0; // 0 apparel, 1 harness
  while (i < apparel.length || j < harness.length) {
    if (toggle === 0) {
      if (i < apparel.length) out.push(apparel[i++]);
      else if (j < harness.length) out.push(harness[j++]);
    } else {
      if (j < harness.length) out.push(harness[j++]);
      else if (i < apparel.length) out.push(apparel[i++]);
    }
    toggle = 1 - toggle;
  }
  return out.concat(rest);
}

function reorderProductsForConstraints(products, intent, rawQuery) {
  const arr = Array.isArray(products) ? products : [];
  if (!arr.length) return arr;

  const priceConstraint = intent?.hard_constraints?.price || null;
  const hasPriceConstraint =
    priceConstraint && (priceConstraint.min != null || priceConstraint.max != null);

  const isPet = (intent?.target_object?.type || '') === 'pet';
  const wantsHarness = isPet && detectHarnessSignal(rawQuery);
  const wantsApparel = isPet && detectPetApparelSignal(rawQuery);
  const wantsMix = wantsHarness && wantsApparel;
  const preferLargeDog = isPet && detectLargeDogSignal(rawQuery);

  if (!hasPriceConstraint && !wantsMix && !preferLargeDog) return arr;

  const annotated = arr.map((p, idx) => {
    const price = getProductPriceMajor(p);
    const priceKnown = Number.isFinite(price);
    const within = hasPriceConstraint ? isWithinPriceConstraint(price, priceConstraint) : true;
    const priceGroup = !hasPriceConstraint ? 0 : within ? 0 : priceKnown ? 2 : 1;
    const sizeScore = preferLargeDog ? getLargeDogSizeScore(p) : 0;
    return { p, idx, priceGroup, sizeScore };
  });

  annotated.sort((a, b) => {
    if (a.priceGroup !== b.priceGroup) return a.priceGroup - b.priceGroup;
    if (a.sizeScore !== b.sizeScore) return b.sizeScore - a.sizeScore;
    return a.idx - b.idx;
  });

  const sorted = annotated.map((x) => x.p);
  if (!wantsMix) return sorted;

  const groups = [[], [], []];
  for (const x of annotated) groups[x.priceGroup].push(x.p);
  return [
    ...interleavePetHarnessAndApparel(groups[0]),
    ...interleavePetHarnessAndApparel(groups[1]),
    ...interleavePetHarnessAndApparel(groups[2]),
  ];
}

function classifyBeautyBucketForDiversity(product) {
  const text = buildProductText(product);
  return classifyBeautyBucketFromText(text);
}

function computeBeautyCategoryMixTopN(products, topN = 10) {
  const out = {};
  const list = Array.isArray(products) ? products.slice(0, Math.max(1, Number(topN) || 10)) : [];
  for (const product of list) {
    const bucket = classifyBeautyBucketForDiversity(product);
    out[bucket] = (out[bucket] || 0) + 1;
  }
  return out;
}

function isBeautyLookupLikeQuery(rawQuery) {
  const q = String(rawQuery || '').trim().toLowerCase();
  if (!q) return false;
  const hasBrand = /\b(ipsa|winona|fenty|tom\s*ford|nars|dior|chanel|ysl|armani)\b/.test(q) || /茵芙莎|薇诺娜|汤姆福特|圣罗兰|迪奥/.test(q);
  const hasAvailabilityCue =
    /\b(available|in stock|where to buy|availability)\b/.test(q) ||
    /有货|库存|有没有|哪里买|能买|能买吗/.test(q);
  return hasBrand && (hasAvailabilityCue || q.length <= 32);
}

function isBeautySkincareSpecificQuery(rawQuery) {
  return buildBeautyQueryProfile({ rawQuery }).bucket === 'skincare';
}

function shouldApplyBeautyDiversity(intent, rawQuery, queryClassInput = null) {
  if (!BEAUTY_DIVERSITY_ENABLED) return false;
  const queryClass = normalizeQueryClass(queryClassInput ?? intent?.query_class, {
    defaultValue: null,
  });
  const beautyQueryProfile = buildBeautyQueryProfile({
    rawQuery,
    queryClass,
    intent,
  });
  if (!beautyQueryProfile?.isBeautyQuery) return false;
  if (isBeautyLookupLikeQuery(rawQuery)) return false;
  return beautyQueryProfile.allowBeautyDiversity;
}

function isBeautyToolAnchoredQuery(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return false;
  return (
    /\b(brush|brushes|makeup\s*tools?|cosmetic\s*tools?|sponge|puff|applicator|tool\s*kit)\b/i.test(q) ||
    /化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|工具|刷子|メイクブラシ|ブラシ/.test(q)
  );
}

function applyBeautyDiversityPolicy(products, options = {}) {
  const input = Array.isArray(products) ? products : [];
  if (input.length <= 1) {
    return {
      products: input,
      strict_empty: false,
      debug: {
        applied: false,
        penalty_applied: false,
        reason: 'insufficient_candidates',
        top_n: options.topN || BEAUTY_DIVERSITY_TOPN,
        min_buckets: options.minBuckets || BEAUTY_DIVERSITY_MIN_BUCKETS,
        tools_max_ratio: options.toolsMaxRatio ?? BEAUTY_DIVERSITY_TOOLS_MAX_RATIO,
        category_mix_topN: computeBeautyCategoryMixTopN(input, options.topN || BEAUTY_DIVERSITY_TOPN),
      },
    };
  }

  const topN = Math.max(1, Number(options.topN || BEAUTY_DIVERSITY_TOPN));
  const minBuckets = Math.max(1, Number(options.minBuckets || BEAUTY_DIVERSITY_MIN_BUCKETS));
  const toolsMaxRatio = Math.max(0, Math.min(1, Number(options.toolsMaxRatio ?? BEAUTY_DIVERSITY_TOOLS_MAX_RATIO)));
  const strictEmptyOnFailure =
    options.strictEmptyOnFailure == null
      ? BEAUTY_DIVERSITY_STRICT_EMPTY_ON_FAILURE
      : Boolean(options.strictEmptyOnFailure);
  const preservePrimaryOnFailure =
    options.preservePrimaryOnFailure == null
      ? true
      : Boolean(options.preservePrimaryOnFailure);

  const annotated = input.map((product, idx) => ({
    product,
    idx,
    bucket: classifyBeautyBucketForDiversity(product),
  }));
  const priorityBuckets = ['base_makeup', 'eye_makeup', 'lip_makeup', 'skincare', 'tools', 'other'];
  const queues = new Map(priorityBuckets.map((bucket) => [bucket, []]));
  for (const item of annotated) {
    if (!queues.has(item.bucket)) queues.set(item.bucket, []);
    queues.get(item.bucket).push(item);
  }

  const interleaved = [];
  let remaining = annotated.length;
  while (remaining > 0) {
    let took = false;
    for (const bucket of priorityBuckets) {
      const queue = queues.get(bucket);
      if (!queue || !queue.length) continue;
      interleaved.push(queue.shift());
      remaining -= 1;
      took = true;
      if (remaining <= 0) break;
    }
    if (!took) break;
  }

  const toolsCap = Math.max(0, Math.floor(topN * toolsMaxRatio));
  const topSegment = interleaved.slice(0, topN);
  const restSegment = interleaved.slice(topN);
  const topTools = topSegment.filter((item) => item.bucket === 'tools');
  const topNonTools = topSegment.filter((item) => item.bucket !== 'tools');
  const overflowTools = topTools.slice(toolsCap);
  const keptTools = topTools.slice(0, toolsCap);
  const topRebalanced = topNonTools.concat(keptTools);
  const rebalancedAnnotated = topRebalanced.concat(restSegment);
  const reordered = rebalancedAnnotated.map((item) => item.product);
  const orderChanged =
    rebalancedAnnotated.length !== annotated.length ||
    rebalancedAnnotated.some((item, idx) => item !== annotated[idx]);

  const mixTopN = computeBeautyCategoryMixTopN(reordered, topN);
  const distinctBeautyBuckets = Object.entries(mixTopN).filter(
    ([bucket, count]) => bucket !== 'other' && Number(count || 0) > 0,
  ).length;
  const meetsDiversity = distinctBeautyBuckets >= minBuckets;
  const toolsInTopN = Number(mixTopN.tools || 0);
  const toolCapViolated = toolsInTopN > toolsCap;

  const requirementUnmet = !meetsDiversity;
  const strictEmpty = strictEmptyOnFailure && requirementUnmet && !preservePrimaryOnFailure;
  const penaltyApplied = orderChanged || toolCapViolated || requirementUnmet || overflowTools.length > 0;
  return {
    products: strictEmpty ? [] : reordered,
    strict_empty: strictEmpty,
    debug: {
      applied: true,
      penalty_applied: penaltyApplied,
      reason: strictEmpty
        ? 'beauty_diversity_not_met'
        : requirementUnmet
          ? 'beauty_diversity_not_met_kept_primary'
          : toolCapViolated
          ? 'beauty_tools_cap_enforced'
          : orderChanged
            ? 'beauty_diversity_reordered'
            : 'beauty_diversity_ok',
      top_n: topN,
      min_buckets: minBuckets,
      tools_max_ratio: toolsMaxRatio,
      tools_cap: toolsCap,
      overflow_tools_dropped: overflowTools.length,
      category_mix_topN: mixTopN,
      distinct_beauty_buckets: distinctBeautyBuckets,
      requirement_unmet: requirementUnmet,
      strict_empty: strictEmpty,
      preserve_primary_on_failure: preservePrimaryOnFailure,
    },
  };
}

function clamp01(n) {
  if (Number.isNaN(n) || n == null) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeQueryClass(value, options = {}) {
  const defaultValue = Object.prototype.hasOwnProperty.call(options, 'defaultValue')
    ? options.defaultValue
    : 'exploratory';
  const normalized = String(value || '').trim().toLowerCase();
  if (
    [
      'lookup',
      'category',
      'attribute',
      'mission',
      'scenario',
      'gift',
      'exploratory',
      'non_shopping',
    ].includes(normalized)
  ) {
    return normalized;
  }
  if (defaultValue == null) return null;
  const normalizedDefault = String(defaultValue || '').trim().toLowerCase();
  if (
    [
      'lookup',
      'category',
      'attribute',
      'mission',
      'scenario',
      'gift',
      'exploratory',
      'non_shopping',
    ].includes(normalizedDefault)
  ) {
    return normalizedDefault;
  }
  return 'exploratory';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSemanticStepFamily(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'cream' || normalized === 'gel cream') return 'moisturizer';
  if (normalized === 'sun care' || normalized === 'sun protection') return 'sunscreen';
  return normalized;
}

function normalizeSemanticStringList(values, max = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = String(raw || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(max) || 1)) break;
  }
  return out;
}

function normalizeSearchSemanticContract(raw) {
  const contract = isPlainObject(raw) ? raw : null;
  if (!contract) return null;
  const version = String(contract.version || BEAUTY_SEMANTIC_CONTRACT_VERSION).trim();
  const requestClass = String(contract.request_class || contract.requestClass || '').trim().toLowerCase();
  const plannerMode = String(contract.planner_mode || contract.plannerMode || '').trim().toLowerCase();
  if (!requestClass || !plannerMode) return null;
  return {
    version,
    owner: String(contract.owner || 'aurora_reco_planner').trim() || 'aurora_reco_planner',
    planner_mode: plannerMode,
    request_class: requestClass,
    target_step_family: normalizeSemanticStepFamily(
      contract.target_step_family || contract.targetStepFamily,
    ),
    primary_role_id: String(contract.primary_role_id || contract.primaryRoleId || '').trim() || null,
    support_role_ids: normalizeSemanticStringList(
      contract.support_role_ids || contract.supportRoleIds,
      6,
    ),
    semantic_family: String(contract.semantic_family || contract.semanticFamily || '').trim().toLowerCase() || null,
    allowed_step_families: normalizeSemanticStringList(
      (Array.isArray(contract.allowed_step_families) ? contract.allowed_step_families : contract.allowedStepFamilies) || [],
      6,
    ).map((value) => normalizeSemanticStepFamily(value)).filter(Boolean),
    blocked_step_families: normalizeSemanticStringList(
      (Array.isArray(contract.blocked_step_families) ? contract.blocked_step_families : contract.blockedStepFamilies) || [],
      6,
    ).map((value) => normalizeSemanticStepFamily(value)).filter(Boolean),
    ingredient_hypotheses: normalizeSemanticStringList(
      contract.ingredient_hypotheses || contract.ingredientHypotheses,
      8,
    ),
    source_surface: String(contract.source_surface || contract.sourceSurface || '').trim().toLowerCase() || null,
  };
}

const STRICT_SEMANTIC_OWNER = BEAUTY_DISCOVERY_MAINLINE_OWNER;

function normalizeSemanticQueryLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeSemanticContractIdentifier(value, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized) return normalized;
  return String(fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || null;
}

function inferBeautyIngredientHypotheses(rawQuery = '') {
  const normalized = String(rawQuery || '').toLowerCase();
  const out = [];
  const push = (value) => {
    if (!value) return;
    if (out.includes(value)) return;
    out.push(value);
  };
  if (/\bsalicylic(?:\s+acid)?\b|水杨酸|水楊酸/.test(normalized)) push('salicylic acid');
  if (/\bniacinamide\b|烟酰胺|煙酰胺/.test(normalized)) push('niacinamide');
  if (/\bretinol\b|\bretinoid\b|视黄醇|視黃醇/.test(normalized)) push('retinol');
  if (/\bvitamin\s*c\b|抗坏血酸|抗壞血酸/.test(normalized)) push('vitamin c');
  if (/\bceramide\b|神经酰胺|神經醯胺/.test(normalized)) push('ceramide');
  if (/\bpanthenol\b|泛醇/.test(normalized)) push('panthenol');
  if (/\bcica\b|积雪草|積雪草/.test(normalized)) push('cica');
  if (/\bhyaluronic\b|透明质酸|透明質酸|玻尿酸/.test(normalized)) push('hyaluronic acid');
  return out.slice(0, 8);
}

function inferBeautySemanticFamily(rawQuery = '', targetStepFamily = null) {
  const normalized = String(rawQuery || '').toLowerCase();
  if (!normalized) return targetStepFamily || null;
  if (
    /\b(oily skin|oil control|shine control|mattify|mattifying|anti-shine|sebum|pore|pores|acne|blemish|breakout)\b/.test(
      normalized,
    ) || /控油|祛痘|痘痘|闭口|閉口|毛孔|出油/.test(normalized)
  ) {
    return 'oil_control';
  }
  if (
    /\b(barrier|repair|soothing|sensitive|ceramide|panthenol|cica|calming)\b/.test(normalized) ||
    /屏障|修护|修護|舒缓|舒緩|敏感肌|神经酰胺|神經醯胺|泛醇/.test(normalized)
  ) {
    return 'barrier_repair';
  }
  if (
    /\b(brightening|dark spot|vitamin c|tone|glow)\b/.test(normalized) ||
    /提亮|淡斑|暗沉|焕亮|煥亮/.test(normalized)
  ) {
    return 'brightening';
  }
  if (
    /\b(retinol|retinoid|wrinkle|firming|anti-aging|anti aging)\b/.test(normalized) ||
    /抗老|抗皱|抗皺|紧致|緊緻|视黄醇|視黃醇/.test(normalized)
  ) {
    return 'anti_aging';
  }
  if (targetStepFamily === 'sunscreen') return 'sunscreen';
  if (targetStepFamily === 'moisturizer') return 'moisturizer';
  if (targetStepFamily === 'cleanser') return 'cleanser';
  if (targetStepFamily === 'toner') return 'toner';
  return targetStepFamily || null;
}

function inferBeautyTargetStepFamily({
  rawQuery = '',
  explicitTargetStepFamily = null,
  explicitSemanticFamily = null,
  profile = null,
} = {}) {
  const explicitStep = normalizeSemanticStepFamily(explicitTargetStepFamily);
  if (explicitStep) {
    if (explicitStep === 'serum') return 'treatment';
    return explicitStep;
  }
  const normalized = String(rawQuery || '').toLowerCase();
  if (!normalized) return null;
  if (
    /\b(sunscreen|spf\b|sunblock|sun protection|uv|broad spectrum)\b/.test(normalized) ||
    /防晒|防曬|日焼け止め/.test(normalized)
  ) {
    return 'sunscreen';
  }
  const hasTreatmentSignal =
    /\b(serum|treatment|ampoule|niacinamide|salicylic|retinol|vitamin c|peptide|azelaic|aha|bha|acne|blemish|breakout|oily skin|oil control|shine control|mattify)\b/.test(
      normalized,
    ) || /精华|精華|美容液|祛痘|痘痘|控油|水杨酸|水楊酸|烟酰胺|煙酰胺/.test(normalized);
  if (
    (
      /\b(moisturi(?:z|s)er|gel cream|barrier cream|face cream|cream|lotion)\b/.test(normalized) ||
      /保湿|保濕|面霜|乳液|霜/.test(normalized)
    ) &&
    !hasTreatmentSignal
  ) {
    return 'moisturizer';
  }
  if (
    /\b(cleanser|face wash|cleansing|wash)\b/.test(normalized) ||
    /洁面|潔面|洗面奶|洗面乳|洗顔料/.test(normalized)
  ) {
    return 'cleanser';
  }
  if (
    /\b(toner|face mist|essence lotion)\b/.test(normalized) ||
    /化妆水|化妝水|爽肤水|爽膚水/.test(normalized)
  ) {
    return 'toner';
  }
  if (hasTreatmentSignal) return 'treatment';
  if (String(explicitSemanticFamily || '').trim()) return 'treatment';
  if (String(profile?.bucket || '').trim().toLowerCase() === 'skincare') return 'treatment';
  return null;
}

function resolveBeautyPrimaryRoleId({
  targetStepFamily = null,
  semanticFamily = null,
  rawQuery = '',
} = {}) {
  const normalizedStep = normalizeSemanticStepFamily(targetStepFamily);
  const normalizedFamily = normalizeSemanticContractIdentifier(semanticFamily, normalizedStep || 'beauty');
  const normalizedQuery = String(rawQuery || '').toLowerCase();
  if (normalizedStep === 'sunscreen') return 'daily_sunscreen';
  if (normalizedStep === 'moisturizer') {
    if (
      /\b(barrier|repair|ceramide|soothing|sensitive|panthenol|cica)\b/.test(normalizedQuery) ||
      /屏障|修护|修護|神经酰胺|神經醯胺|舒缓|舒緩|泛醇/.test(normalizedQuery)
    ) {
      return 'barrier_moisturizer';
    }
    return 'lightweight_moisturizer';
  }
  if (normalizedStep === 'treatment') return `${normalizedFamily || 'general'}_treatment`;
  if (normalizedStep === 'cleanser') return 'daily_cleanser';
  if (normalizedStep === 'toner') return 'daily_toner';
  return `${normalizedStep || 'beauty'}_primary`;
}

function shouldForceBeautyDiscoveryContract({
  rawQuery = '',
  targetStepFamily = null,
  semanticFamily = null,
  ingredientHypotheses = [],
  guidanceOnlyDiscovery = false,
} = {}) {
  const normalizedQuery = String(rawQuery || '').trim().toLowerCase();
  if (!normalizedQuery || !targetStepFamily) return false;
  const brandLike = Boolean(detectBrandEntities(rawQuery, { candidateProducts: [] })?.brand_like);
  if (brandLike) return false;

  const hasRoleSignal =
    /\b(serum|treatment|ampoule|essence|moisturi(?:z|s)er|cream|gel cream|lotion|cleanser|face wash|toner|mist|sunscreen|spf\b|sunblock)\b/.test(
      normalizedQuery,
    ) || /精华|精華|美容液|面霜|乳液|洁面|潔面|化妆水|化妝水|防晒|防曬|日焼け止め/.test(normalizedQuery);
  const hasConcernSignal =
    /\b(barrier|repair|oily skin|oil control|shine control|mattify|mattifying|sensitive|soothing|calming|hydrating|acne|blemish|breakout|dark spot|brightening|firming|anti-aging|anti aging)\b/.test(
      normalizedQuery,
    ) ||
    /屏障|修护|修護|控油|出油|敏感肌|舒缓|舒緩|补水|補水|祛痘|痘痘|淡斑|提亮|抗老/.test(normalizedQuery);

  if (guidanceOnlyDiscovery && hasRoleSignal) return true;
  return hasRoleSignal && (hasConcernSignal || ingredientHypotheses.length > 0 || Boolean(semanticFamily));
}

function isBeautyExactTitleLookupQuery(rawQuery = '', intent = null) {
  if (String(intent?.primary_domain || '').toLowerCase() !== 'beauty') return false;
  const raw = String(rawQuery || '').trim();
  if (!raw || raw.length > 96) return false;
  if (/[?？]/.test(raw)) return false;
  const lower = raw.toLowerCase();
  if (
    /推荐|best|for\s|适合|怎么|如何|教程|guide|tips|budget|under\s|above\s|at least|gift|礼物|清单|what to buy|need to buy|checklist/i.test(
      lower,
    )
  ) {
    return false;
  }
  const normalizedResolverQuery = normalizeResolverLookupText(raw);
  const resolverQueryTokens = tokenizeResolverLookupQuery(normalizedResolverQuery);
  if (resolverQueryTokens.length < 3 || resolverQueryTokens.length > 8) return false;
  const hasFormFactor = resolverQueryTokens.some((token) =>
    BEAUTY_EXACT_TITLE_FORM_FACTOR_TOKENS.has(String(token || '').toLowerCase()),
  );
  if (!hasFormFactor) return false;
  const informativeTokens = resolverQueryTokens.filter((token) => {
    const normalized = String(token || '').trim().toLowerCase();
    return normalized && !BEAUTY_EXACT_TITLE_GENERIC_TOKENS.has(normalized) && normalized.length >= 3;
  });
  if (!informativeTokens.length) return false;
  const hasStrongTitleSignal =
    /[-/+]/.test(raw) ||
    /\d/.test(raw) ||
    ((raw.match(/\b[A-Z][A-Za-z0-9'’+-]*\b/g) || []).length >= 2);
  if (hasStrongTitleSignal) return informativeTokens.length >= 1;
  return informativeTokens.length >= 2;
}

function buildBeautyDiscoverySemanticContract({
  rawQuery = '',
  search = null,
  metadata = null,
  intent = null,
} = {}) {
  const normalizedQuery = String(rawQuery || '').trim();
  if (!normalizedQuery) return null;
  const searchObj = isPlainObject(search) ? search : {};
  const metadataObj = isPlainObject(metadata) ? metadata : {};
  const catalogSurface = String(
    searchObj.catalog_surface || searchObj.catalogSurface || metadataObj.catalog_surface || '',
  ).trim().toLowerCase();
  const source = String(metadataObj.source || searchObj.source || '').trim().toLowerCase();
  const uiSurface = String(
    searchObj.ui_surface || searchObj.uiSurface || metadataObj.ui_surface || '',
  ).trim().toLowerCase();
  const decisionMode = String(
    searchObj.decision_mode || searchObj.decisionMode || metadataObj.decision_mode || '',
  ).trim().toLowerCase();
  const guidanceOnlyDiscovery =
    uiSurface === 'ingredient_plan_guidance_only' || decisionMode === 'guidance_only';

  const syntheticIntent = {
    ...(isPlainObject(intent) ? intent : {}),
    primary_domain: 'beauty',
  };
  if (isBeautyExactTitleLookupQuery(normalizedQuery, syntheticIntent)) {
    return null;
  }
  const profile = buildBeautyQueryProfile({
    rawQuery: normalizedQuery,
    queryClass: syntheticIntent?.query_class || null,
    intent: syntheticIntent,
  });
  const beautyScoped =
    catalogSurface === 'beauty' ||
    source === 'aurora-bff' ||
    source === 'shopping-agent' ||
    profile?.isBeautyQuery === true;
  if (!beautyScoped || profile?.isBeautyQuery !== true) return null;

  const explicitTargetStepFamily = searchObj.target_step_family || searchObj.targetStepFamily;
  const explicitSemanticFamily = String(
    searchObj.semantic_family || searchObj.semanticFamily || '',
  ).trim().toLowerCase() || null;
  const targetStepFamily = inferBeautyTargetStepFamily({
    rawQuery: normalizedQuery,
    explicitTargetStepFamily,
    explicitSemanticFamily,
    profile,
  });
  if (!targetStepFamily) return null;

  const semanticFamily = explicitSemanticFamily || inferBeautySemanticFamily(normalizedQuery, targetStepFamily);
  const ingredientHypotheses = inferBeautyIngredientHypotheses(normalizedQuery);
  const queryClass = inferQueryClassFromIntentAndQuery(syntheticIntent, normalizedQuery);
  const forceDiscoveryContract = shouldForceBeautyDiscoveryContract({
    rawQuery: normalizedQuery,
    targetStepFamily,
    semanticFamily,
    ingredientHypotheses,
    guidanceOnlyDiscovery,
  });
  if (queryClass === 'non_shopping') return null;
  if (queryClass === 'lookup' && !forceDiscoveryContract) return null;
  const supportRoleIds =
    targetStepFamily === 'treatment'
      ? ['lightweight_moisturizer', 'daily_sunscreen']
      : targetStepFamily === 'moisturizer'
        ? ['daily_sunscreen']
        : [];
  const allowedStepFamilies = normalizeSemanticStringList(
    targetStepFamily === 'treatment'
      ? ['treatment', 'serum']
      : [targetStepFamily],
    6,
  ).map((value) => normalizeSemanticStepFamily(value)).filter(Boolean);
  const blockedStepFamilies = normalizeSemanticStringList(
    targetStepFamily === 'sunscreen'
      ? ['treatment', 'moisturizer', 'cleanser', 'toner']
      : targetStepFamily === 'moisturizer'
        ? ['treatment']
        : [],
    6,
  ).map((value) => normalizeSemanticStepFamily(value)).filter(Boolean);

  return {
    version: BEAUTY_SEMANTIC_CONTRACT_VERSION,
    owner: BEAUTY_DISCOVERY_CONTRACT_OWNER,
    planner_mode: targetStepFamily === 'sunscreen' ? 'step_aware' : 'framework_generic',
    request_class: targetStepFamily === 'sunscreen' ? 'sunscreen' : 'generic_concern',
    target_step_family: targetStepFamily,
    primary_role_id: resolveBeautyPrimaryRoleId({
      targetStepFamily,
      semanticFamily,
      rawQuery: normalizedQuery,
    }),
    support_role_ids: supportRoleIds,
    semantic_family: semanticFamily,
    allowed_step_families: allowedStepFamilies,
    blocked_step_families: blockedStepFamilies,
    ingredient_hypotheses: ingredientHypotheses,
    source_surface: BEAUTY_DISCOVERY_PUBLIC_SURFACE,
  };
}

function isBeautyDiscoverySemanticContract(semanticContract = null) {
  const contract = normalizeSearchSemanticContract(semanticContract);
  if (!contract) return false;
  if (contract.request_class === 'exact_lookup') return false;
  const owner = String(contract.owner || '').trim().toLowerCase();
  const sourceSurface = String(contract.source_surface || '').trim().toLowerCase();
  const ownerAllowed =
    owner === 'aurora_reco_planner' || owner === BEAUTY_DISCOVERY_CONTRACT_OWNER;
  const sourceAllowed =
    sourceSurface === 'aurora_beauty_strict' ||
    sourceSurface === BEAUTY_DISCOVERY_PUBLIC_SURFACE;
  return ownerAllowed && sourceAllowed;
}

function buildBeautyDiscoveryQueryPackFromContract({
  rawQuery = '',
  semanticContract = null,
  ambiguityScorePre = null,
} = {}) {
  return buildDeterministicStrictSemanticQueryPack({
    rawQuery,
    semanticContract,
    ambiguityScorePre,
  });
}

function buildDeterministicStrictSemanticQueryPack({
  rawQuery = '',
  semanticContract = null,
  ambiguityScorePre = null,
} = {}) {
  const contract = normalizeSearchSemanticContract(semanticContract);
  const out = [];
  const push = (value) => {
    const normalized = normalizeSemanticQueryLabel(value);
    if (!normalized) return;
    if (out.some((item) => item === normalized || item.includes(normalized) || normalized.includes(item))) {
      return;
    }
    out.push(normalized);
  };
  const pushExactUnique = (value) => {
    const normalized = normalizeSemanticQueryLabel(value);
    if (!normalized) return;
    if (out.includes(normalized)) return;
    out.push(normalized);
  };

  const raw = normalizeSemanticQueryLabel(rawQuery);
  const targetStepFamily = normalizeSemanticStepFamily(contract?.target_step_family);
  const primaryRoleLabel = normalizeSemanticQueryLabel(contract?.primary_role_id);
  const semanticFamily = normalizeSemanticQueryLabel(contract?.semantic_family);
  const ingredientHypotheses = normalizeSemanticStringList(contract?.ingredient_hypotheses, 8)
    .map((value) => normalizeSemanticQueryLabel(value))
    .filter(Boolean);
  const allowedStepFamilies = normalizeSemanticStringList(contract?.allowed_step_families, 6)
    .map((value) => normalizeSemanticStepFamily(value))
    .filter(Boolean);

  if (targetStepFamily !== 'sunscreen') {
    push(primaryRoleLabel);
  }

  if (targetStepFamily === 'sunscreen') {
    const sunscreenSignalText = `${raw} ${semanticFamily}`.trim();
    const oilySunscreenSignal =
      /\b(oily skin|oil control|shine control|mattify|mattifying|non-greasy|non greasy|sebum)\b/.test(
        sunscreenSignalText,
      );
    const sensitiveSunscreenSignal =
      /\b(sensitive|barrier|redness|soothing|calming|fragrance free|fragrance-free)\b/.test(
        sunscreenSignalText,
      );
    const explicitSunscreenSpecificity =
      /\b(spf(?:\s*\d{1,3}\+?)?|broad spectrum|mineral|tinted|water resistant|uv|pa\+{1,4}|face sunscreen|sunblock)\b/.test(
        raw,
      );

    if (explicitSunscreenSpecificity) pushExactUnique(raw);

    if (oilySunscreenSignal) {
      pushExactUnique('lightweight sunscreen oily skin');
      pushExactUnique('oil control sunscreen');
      pushExactUnique('spf oily skin');
    } else if (sensitiveSunscreenSignal) {
      pushExactUnique('sensitive skin sunscreen');
      pushExactUnique('barrier sunscreen');
      pushExactUnique('spf sensitive skin');
    } else {
      pushExactUnique('broad spectrum sunscreen');
      pushExactUnique('daily sunscreen');
      pushExactUnique('face sunscreen');
    }

    pushExactUnique(raw);
  } else if (targetStepFamily === 'treatment') {
    if (ingredientHypotheses[0]) push(`${ingredientHypotheses[0]} treatment`);
    if (semanticFamily) {
      push(
        /\b(oil control|shine control|mattify|mattifying|balancing)\b/.test(semanticFamily)
          ? `${semanticFamily} serum`
          : `${semanticFamily} treatment`,
      );
    }
    if (allowedStepFamilies.includes('serum')) push('oil control serum');
    push(raw);
  } else if (targetStepFamily === 'moisturizer') {
    push('lightweight moisturizer');
    push('face moisturizer');
    push(raw);
  } else if (targetStepFamily) {
    push(targetStepFamily);
    push(raw);
  } else {
    push(raw);
  }

  if (
    contract?.request_class === 'generic_concern' &&
    Number.isFinite(Number(ambiguityScorePre)) &&
    Number(ambiguityScorePre) >= 0.7 &&
    targetStepFamily
  ) {
    push(targetStepFamily);
  }

  return out.slice(0, 3);
}

function buildStrictSemanticRewriteResult({
  rawQuery,
  rewriteMeta = null,
  rewriteOutput = null,
  semanticContract = null,
  ambiguityScorePre = null,
} = {}) {
  const llmMeta = isPlainObject(rewriteMeta)
    ? {
        provider: String(rewriteMeta.provider || '').trim() || null,
        enable_owner: String(rewriteMeta.enable_owner || '').trim() || null,
        provider_owner: String(rewriteMeta.provider_owner || '').trim() || null,
        fallback_owner: String(rewriteMeta.fallback_owner || '').trim() || null,
        llm_provider_chain: Array.isArray(rewriteMeta.llm_provider_chain) ? rewriteMeta.llm_provider_chain : [],
        llm_primary_provider: String(rewriteMeta.llm_primary_provider || '').trim() || null,
        llm_fallback_provider: String(rewriteMeta.llm_fallback_provider || '').trim() || null,
        llm_model: String(rewriteMeta.llm_model || '').trim() || null,
        llm_model_owner: String(rewriteMeta.llm_model_owner || '').trim() || null,
        llm_error_class: String(rewriteMeta.llm_error_class || '').trim() || null,
        llm_error_stage: String(rewriteMeta.llm_error_stage || '').trim() || null,
        llm_error_provider: String(rewriteMeta.llm_error_provider || '').trim() || null,
        llm_error_message: String(rewriteMeta.llm_error_message || '').trim() || null,
        llm_finish_reason: String(rewriteMeta.llm_finish_reason || '').trim() || null,
        llm_raw_preview: String(rewriteMeta.llm_raw_preview || '').trim() || null,
        llm_candidate_count:
          Number.isFinite(Number(rewriteMeta.llm_candidate_count)) && Number(rewriteMeta.llm_candidate_count) >= 0
            ? Number(rewriteMeta.llm_candidate_count)
            : null,
        llm_upstream_status:
          Number.isFinite(Number(rewriteMeta.llm_upstream_status)) && Number(rewriteMeta.llm_upstream_status) > 0
            ? Number(rewriteMeta.llm_upstream_status)
            : null,
        llm_upstream_error_code: String(rewriteMeta.llm_upstream_error_code || '').trim() || null,
        llm_upstream_error_message: String(rewriteMeta.llm_upstream_error_message || '').trim() || null,
        single_provider_locked: Boolean(rewriteMeta.single_provider_locked),
        fallback_reason: String(rewriteMeta.fallback_reason || '').trim() || null,
        llm_enrichment_attempted: Boolean(rewriteMeta.llm_enrichment_attempted),
        llm_enrichment_applied: Boolean(rewriteMeta.llm_enrichment_applied),
        llm_enrichment_status: String(rewriteMeta.llm_enrichment_status || '').trim() || null,
        llm_enrichment_mode: String(rewriteMeta.llm_enrichment_mode || '').trim() || null,
      }
    : {
        provider: null,
        enable_owner: null,
        provider_owner: null,
        fallback_owner: null,
        llm_provider_chain: [],
        llm_primary_provider: null,
        llm_fallback_provider: null,
        llm_model: null,
        llm_model_owner: null,
        llm_error_class: null,
        llm_error_stage: null,
        llm_error_provider: null,
        llm_error_message: null,
        llm_finish_reason: null,
        llm_raw_preview: null,
        llm_candidate_count: null,
        llm_upstream_status: null,
        llm_upstream_error_code: null,
        llm_upstream_error_message: null,
        single_provider_locked: false,
        fallback_reason: null,
        llm_enrichment_attempted: false,
        llm_enrichment_applied: false,
        llm_enrichment_status: null,
        llm_enrichment_mode: null,
      };
  const contract = normalizeSearchSemanticContract(semanticContract);
  const normalizedRawQuery = String(rawQuery || '').trim();
  const normalizedRewriteOutput =
    rewriteOutput && typeof rewriteOutput === 'object' && !Array.isArray(rewriteOutput)
      ? rewriteOutput
      : null;
  const strictSemanticOwner = shouldUseSemanticContractQueryOwner(contract);
  if (!contract) {
    return {
      owner: 'shopping_agent_semantic_rewrite',
      applied: false,
      mode: String(rewriteMeta?.mode || 'deterministic_fallback'),
      ...llmMeta,
      normalized_query_pack: normalizedRawQuery ? [normalizedRawQuery] : [],
      hard_filters: {},
      soft_filters: {},
      latency_ms: null,
      needs_broadening: false,
    };
  }

  const normalizedQueryPack = normalizeSemanticStringList(
    strictSemanticOwner
      ? buildDeterministicStrictSemanticQueryPack({
          rawQuery: normalizedRawQuery,
          semanticContract: contract,
          ambiguityScorePre,
        })
      : Array.isArray(normalizedRewriteOutput?.normalized_query_pack) &&
          normalizedRewriteOutput.normalized_query_pack.length > 0
        ? normalizedRewriteOutput.normalized_query_pack
      : [
          normalizedRawQuery,
          contract.target_step_family && contract.semantic_family
            ? contract.semantic_family === contract.target_step_family
              ? contract.target_step_family
              : `${contract.semantic_family.replace(/_/g, ' ')} ${contract.target_step_family}`
            : '',
          contract.target_step_family === 'treatment' && contract.ingredient_hypotheses[0]
            ? `${contract.ingredient_hypotheses[0]} treatment`
            : '',
        ],
    3,
  ).map((value) => String(value || '').trim()).filter(Boolean);
  const applied = contract.request_class !== 'exact_lookup';
  const targetStepFamily = contract.target_step_family || null;
  const allowedStepFamilies = normalizeSemanticStringList([
    ...(Array.isArray(contract.allowed_step_families) ? contract.allowed_step_families : []),
    targetStepFamily,
  ], 6).map((value) => normalizeSemanticStepFamily(value)).filter(Boolean);
  const blockedStepFamilies = normalizeSemanticStringList(
    contract.blocked_step_families,
    6,
  ).map((value) => normalizeSemanticStepFamily(value)).filter(Boolean);

  return {
    owner: strictSemanticOwner ? STRICT_SEMANTIC_OWNER : 'shopping_agent_semantic_rewrite',
    applied,
    mode: strictSemanticOwner
      ? 'deterministic_contract'
      : String(rewriteMeta?.mode || 'deterministic_fallback'),
    ...llmMeta,
    ...(strictSemanticOwner
      ? {
          provider: 'rule_based',
          fallback_reason: null,
        }
      : {}),
    normalized_query_pack: normalizedQueryPack,
    hard_filters: {
      target_step_family: targetStepFamily,
      allowed_step_families: allowedStepFamilies,
      blocked_step_families: blockedStepFamilies,
      ingredient_hypotheses: contract.ingredient_hypotheses,
    },
    soft_filters: {
      primary_role_id: contract.primary_role_id,
      support_role_ids: contract.support_role_ids,
      semantic_family: contract.semantic_family,
      planner_mode: contract.planner_mode,
      request_class: contract.request_class,
    },
    latency_ms: null,
    needs_broadening: Boolean(
      normalizedRewriteOutput?.needs_broadening === true ||
        (applied &&
          !targetStepFamily &&
          Number.isFinite(Number(ambiguityScorePre)) &&
          Number(ambiguityScorePre) >= 0.7)
    ),
  };
}

function shouldUseSemanticContractQueryOwner(semanticContract = null) {
  return isBeautyDiscoverySemanticContract(semanticContract);
}

function buildSemanticOwnerSearchQuery({
  semanticRewriteResult = null,
  fallbackQuery = '',
} = {}) {
  const normalizedQueryPack = Array.isArray(semanticRewriteResult?.normalized_query_pack)
    ? semanticRewriteResult.normalized_query_pack
    : [];
  const primaryQuery = normalizedQueryPack
    .map((value) => String(value || '').trim())
    .find(Boolean);
  if (!primaryQuery) return String(fallbackQuery || '').trim();
  return primaryQuery.length > 220 ? primaryQuery.slice(0, 220).trim() : primaryQuery;
}

function inferQueryClassFromIntentAndQuery(intent, rawQuery) {
  const normalizedResolverQuery = normalizeResolverLookupText(rawQuery);
  const resolverQueryTokens = tokenizeResolverLookupQuery(normalizedResolverQuery);
  const looksLikeBeautyExactTitleLookupQuery = isBeautyExactTitleLookupQuery(rawQuery, intent);
  const stableAliasLookupMatch =
    resolveKnownStableLookupAlias && normalizedResolverQuery && resolverQueryTokens.length >= 3
      ? resolveKnownStableLookupAlias({
          query: rawQuery,
          normalizedQuery: normalizedResolverQuery,
          queryTokens: resolverQueryTokens,
        })
      : null;
  const stableAliasLookupClassified =
    stableAliasLookupMatch &&
    stableAliasLookupMatch.product_ref &&
    String(stableAliasLookupMatch.product_ref.product_id || '').trim() &&
    String(stableAliasLookupMatch.product_ref.merchant_id || '').trim();
  const explicit = normalizeQueryClass(intent?.query_class, { defaultValue: null });
  if (
    looksLikeBeautyExactTitleLookupQuery &&
    (!explicit || explicit === 'exploratory' || explicit === 'category')
  ) {
    return 'lookup';
  }
  if (stableAliasLookupClassified && (!explicit || explicit === 'exploratory' || explicit === 'category')) {
    return 'lookup';
  }
  if (explicit) return explicit;

  const scenarioName = String(intent?.scenario?.name || '').toLowerCase();
  const primaryDomain = String(intent?.primary_domain || '').toLowerCase();
  const targetType = String(intent?.target_object?.type || '').toLowerCase();
  const categoryRequired = Array.isArray(intent?.category?.required) ? intent.category.required : [];
  const query = String(rawQuery || '').toLowerCase();
  const hasPriceConstraint =
    intent?.hard_constraints?.price &&
    (intent.hard_constraints.price.min != null || intent.hard_constraints.price.max != null);

  if (
    /how to|tutorial|guide|return policy|refund policy|after sales|怎么用|教程|退货|售后/.test(query)
  ) {
    return 'non_shopping';
  }
  if (/gift|present|送礼|礼物|生日/.test(query)) return 'gift';
  if (
    /要买|需要|清单|准备|带什么|买什么|need to buy|checklist|what to bring|starter kit/.test(
      query,
    )
  ) {
    return 'mission';
  }
  if (/约会|通勤|面试|露营|登山|徒步|出差|旅行|date|commute|interview|camping|hiking|travel/.test(query)) {
    return 'scenario';
  }
  if (stableAliasLookupClassified) {
    return 'lookup';
  }
  if (
    detectBrandEntities(rawQuery, { candidateProducts: [] }).brand_like &&
    !hasExplicitCategoryHint(rawQuery, intent)
  ) {
    return 'exploratory';
  }
  if (
    /\bsku\b|\bmodel\b|型号|型號/.test(query) ||
    /\b[a-z]{1,6}\d{2,}\b/i.test(query) ||
    (/^(ipsa|茵芙莎|winona|薇诺娜|the ordinary|sk[\s-]?ii)$/i.test(String(rawQuery || '').trim()) &&
      String(rawQuery || '').trim().length <= 24)
  ) {
    return 'lookup';
  }
  if (scenarioName === 'discovery' || scenarioName === 'browse') return 'exploratory';
  if (hasPriceConstraint || /预算|預算|以内|以内|以上|不超过|under|above|at least|waterproof|windproof|fragrance/.test(query)) {
    return 'attribute';
  }
  if (categoryRequired.length > 0) return 'category';
  if (scenarioName && scenarioName !== 'general') return 'scenario';
  if ((primaryDomain === 'other' && targetType === 'unknown') || !rawQuery) return 'exploratory';
  return 'category';
}

function isAmbiguitySensitiveQueryClass(queryClass) {
  return ['mission', 'scenario', 'gift', 'exploratory', 'non_shopping'].includes(
    normalizeQueryClass(queryClass, { defaultValue: null }),
  );
}

function normalizeWordTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isAnchorTokenAllowed(token) {
  const stopwords = new Set([
    '有',
    '吗',
    '推薦',
    '推荐',
    '推荐点',
    '推薦點',
    '什么',
    '什麼',
    '商品',
    'products',
    'recommend',
    'recommendation',
    'need',
    'needs',
    'for',
    'the',
    'and',
    'with',
  ]);
  return !stopwords.has(String(token || '').toLowerCase());
}

function normalizeAnchorTokens(input, maxTokens = 20) {
  const values = Array.isArray(input) ? input : [input];
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    for (const token of normalizeWordTokens(value)) {
      if (token.length < 2) continue;
      if (!isAnchorTokenAllowed(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      normalized.push(token);
      if (normalized.length >= maxTokens) return normalized;
    }
  }
  return normalized;
}

function resolvePostAnchorBasis({ rawQuery, intent, queryClass, associationPlan }) {
  const normalizedClass = normalizeQueryClass(queryClass ?? intent?.query_class, {
    defaultValue: null,
  });
  const rawTokens = normalizeAnchorTokens(rawQuery, 20);
  if (SEARCH_SCENARIO_ANCHOR_MODE === 'off') {
    return {
      mode: 'off',
      source: 'disabled',
      tokens: [],
    };
  }
  if (
    SEARCH_SCENARIO_ANCHOR_MODE !== 'derived' ||
    !['scenario', 'mission'].includes(String(normalizedClass || ''))
  ) {
    return {
      mode: 'raw',
      source: 'raw_query',
      tokens: rawTokens,
    };
  }
  const planKeywords = Array.isArray(associationPlan?.category_keywords)
    ? associationPlan.category_keywords
    : [];
  const intentTokens = extractCategoryTokensFromIntent(intent, rawQuery);
  const derivedTokens = normalizeAnchorTokens([...planKeywords, ...intentTokens], 20);
  if (!derivedTokens.length) {
    return {
      mode: 'raw_fallback',
      source: 'derived_empty_fallback_raw',
      tokens: rawTokens,
    };
  }
  return {
    mode: 'derived',
    source: 'scenario_association_and_intent',
    tokens: derivedTokens,
  };
}

function inferSearchDomainKey(intent, rawQuery) {
  const target = String(intent?.target_object?.type || '').toLowerCase();
  const primaryDomain = String(intent?.primary_domain || '').toLowerCase();
  const query = String(rawQuery || '').toLowerCase();
  if (target === 'pet') return 'pet';
  if (primaryDomain === 'beauty') return 'beauty';
  if (hasFragranceQuerySignal(query)) return 'beauty';
  if (
    /travel|trip|business trip|packing|luggage|toiletry|出差|旅行|旅游|差旅/.test(query)
  ) {
    return 'travel';
  }
  if (/hiking|trail|camping|outdoor|徒步|登山|露营|户外/.test(query)) {
    return 'hiking';
  }
  if (primaryDomain === 'sports_outdoor') return 'hiking';
  return 'general';
}

function inferProductDomainKey(product) {
  const pivotaDomain = String(product?.attributes?.pivota?.domain || '').toLowerCase();
  if (pivotaDomain) {
    if (pivotaDomain === 'beauty') return 'beauty';
    if (pivotaDomain === 'pet' || pivotaDomain === 'pet_supplies') return 'pet';
    if (pivotaDomain === 'travel') return 'travel';
    if (pivotaDomain === 'hiking' || pivotaDomain === 'outdoor') return 'hiking';
    if (pivotaDomain === 'sports_outdoor') {
      const target = String(product?.attributes?.pivota?.target_object || '').toLowerCase();
      if (target === 'pet') return 'pet';
      const text = buildProductText(product);
      if (
        /\b(dog|dogs|cat|cats|pet|harness|leash|collar|puppy|kitten)\b/i.test(text || '') ||
        /宠物|狗|猫|牵引|狗链|背带|项圈/.test(text || '')
      ) {
        return 'pet';
      }
      return 'hiking';
    }
  }

  const text = buildProductText(product);
  if (!text) {
    if (pivotaDomain === 'beauty') return 'beauty';
    if (pivotaDomain === 'travel') return 'travel';
    if (pivotaDomain === 'hiking' || pivotaDomain === 'outdoor') return 'hiking';
    if (pivotaDomain === 'pet' || pivotaDomain === 'pet_supplies') return 'pet';
    return 'general';
  }
  if (
    /\b(dog|cat|pet|harness|leash|collar|puppy|kitten)\b/i.test(text) ||
    /宠物|狗|猫|牵引|狗链|背带|项圈/.test(text)
  ) {
    return 'pet';
  }
  if (
    /\b(foundation|concealer|mascara|lipstick|serum|toner|moisturizer|makeup|cosmetic|fragrance|perfume|parfum|cologne|eau de parfum|eau de toilette|body mist|scent|aroma)\b/i.test(text) ||
    /化妆|美妆|护肤|精华|口红|粉底|防晒|香水|香氛/.test(text)
  ) {
    return 'beauty';
  }
  if (
    /\b(hiking|outdoor|camping|trekking|trail|parka|shell)\b/i.test(text) ||
    /徒步|登山|露营|冲锋衣|户外/.test(text)
  ) {
    return 'hiking';
  }
  if (
    /\b(luggage|packing|travel|toiletry|carry-on|adapter)\b/i.test(text) ||
    /行李|收纳|旅行|出差|分装/.test(text)
  ) {
    return 'travel';
  }
  return 'general';
}

function computeDomainEntropy(products) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return 1;
  const counts = new Map();
  for (const product of list.slice(0, 20)) {
    const key = inferProductDomainKey(product);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 1;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log(p);
  }
  const maxEntropy = counts.size > 1 ? Math.log(counts.size) : 1;
  return clamp01(maxEntropy > 0 ? entropy / maxEntropy : 0);
}

function computeAnchorRatio(rawQuery, products, options = {}) {
  const overrideTokens = Array.isArray(options?.anchorTokens)
    ? normalizeAnchorTokens(options.anchorTokens, 20)
    : null;
  const anchors = (overrideTokens || normalizeAnchorTokens(rawQuery, 20)).slice(0, 10);
  if (!anchors.length) return 1;
  const list = Array.isArray(products) ? products.slice(0, 10) : [];
  if (!list.length) return 0;
  let matchedCount = 0;
  for (const product of list) {
    const text = buildProductText(product);
    if (!text) continue;
    const overlap = anchors.filter((token) => text.includes(token)).length;
    if (overlap > 0) matchedCount += 1;
  }
  return clamp01(matchedCount / list.length);
}

function inferSuperDomainKey(domainKey) {
  const key = String(domainKey || '').toLowerCase();
  if (key === 'beauty') return 'beauty';
  if (key === 'pet') return 'pet';
  if (key === 'hiking') return 'outdoor';
  if (key === 'travel') return 'travel';
  return 'general';
}

function inferSuperDomainFromToken(token) {
  const t = String(token || '').toLowerCase();
  if (!t) return null;
  if (
    /(beauty|makeup|cosmetic|lip|foundation|mascara|skincare|化妆|美妆|护肤|口红|粉底|眼影|睫毛)/.test(t)
  ) {
    return 'beauty';
  }
  if (
    /(dog|cat|pet|leash|harness|collar|puppy|kitten|宠物|狗链|牵引|背带|项圈|猫砂|遛狗)/.test(t)
  ) {
    return 'pet';
  }
  if (
    /(hiking|outdoor|camping|trekking|trail|backpack|hydration|pole|徒步|登山|露营|户外)/.test(t)
  ) {
    return 'outdoor';
  }
  if (
    /(travel|trip|business|packing|luggage|toiletry|adapter|carryon|carry-on|出差|旅行|差旅|行李|分装)/.test(
      t,
    )
  ) {
    return 'travel';
  }
  return null;
}

function resolveDomainCondenserTargetSuperDomain({ intent, rawQuery, anchorTokens }) {
  const tokens = normalizeAnchorTokens(anchorTokens, 40);
  const scoreByDomain = new Map();
  for (const token of tokens) {
    const superDomain = inferSuperDomainFromToken(token);
    if (!superDomain) continue;
    scoreByDomain.set(superDomain, (scoreByDomain.get(superDomain) || 0) + 1);
  }
  if (scoreByDomain.size > 0) {
    let bestDomain = null;
    let bestScore = -1;
    for (const [domain, score] of scoreByDomain.entries()) {
      if (score > bestScore) {
        bestDomain = domain;
        bestScore = score;
      }
    }
    if (bestDomain) return bestDomain;
  }
  const inferredDomain = inferSearchDomainKey(intent, rawQuery);
  const inferredSuper = inferSuperDomainKey(inferredDomain);
  if (inferredSuper !== 'general') return inferredSuper;
  const primary = inferSuperDomainKey(intent?.primary_domain);
  return primary === 'general' ? null : primary;
}

function applyScenarioDomainCondenser({
  products,
  fallbackProducts,
  intent,
  rawQuery,
  queryClass,
  anchorTokens,
  sourceCandidateCount,
}) {
  const list = Array.isArray(products) ? products : [];
  const fallbackList = Array.isArray(fallbackProducts) ? fallbackProducts : [];
  const normalizedClass = normalizeQueryClass(queryClass ?? intent?.query_class, {
    defaultValue: null,
  });
  const debug = {
    enabled: SEARCH_DOMAIN_CONDENSER_ENABLED,
    applied: false,
    query_class: normalizedClass,
    source_candidates: Number.isFinite(Number(sourceCandidateCount))
      ? Number(sourceCandidateCount)
      : Math.max(list.length, fallbackList.length),
    candidates_before: list.length,
    entropy_before: computeDomainEntropy(list),
    min_candidates_before: SEARCH_DOMAIN_CONDENSER_MIN_CANDS_BEFORE,
    min_candidates_after: SEARCH_DOMAIN_CONDENSER_MIN_CANDS_AFTER,
    entropy_threshold: SEARCH_DOMAIN_CONDENSER_ENTROPY_TH,
  };
  if (!SEARCH_DOMAIN_CONDENSER_ENABLED) {
    return { products: list, debug: { ...debug, reason: 'disabled' } };
  }
  if (!['scenario', 'mission'].includes(String(normalizedClass || ''))) {
    return { products: list, debug: { ...debug, reason: 'query_class_not_supported' } };
  }
  const effectiveSourceCount = debug.source_candidates;
  const triggerByEmpty = list.length === 0 && effectiveSourceCount >= SEARCH_DOMAIN_CONDENSER_MIN_CANDS_BEFORE;
  const triggerByEntropy =
    list.length > 0 &&
    effectiveSourceCount >= SEARCH_DOMAIN_CONDENSER_MIN_CANDS_BEFORE &&
    debug.entropy_before >= SEARCH_DOMAIN_CONDENSER_ENTROPY_TH;
  if (!triggerByEmpty && !triggerByEntropy) {
    return {
      products: list,
      debug: {
        ...debug,
        reason: 'gate_not_met',
        trigger_by_empty: triggerByEmpty,
        trigger_by_entropy: triggerByEntropy,
      },
    };
  }

  const targetSuperDomain = resolveDomainCondenserTargetSuperDomain({
    intent,
    rawQuery,
    anchorTokens,
  });
  if (!targetSuperDomain) {
    return { products: list, debug: { ...debug, reason: 'target_super_domain_unknown' } };
  }
  const pool = list.length > 0 ? list : fallbackList;
  if (!pool.length) {
    return { products: list, debug: { ...debug, reason: 'no_candidate_pool', target_super_domain: targetSuperDomain } };
  }
  const allowTokens = normalizeAnchorTokens(
    [
      ...(Array.isArray(anchorTokens) ? anchorTokens : []),
      ...extractCategoryTokensFromIntent(intent, rawQuery),
    ],
    40,
  );
  if (!allowTokens.length) {
    return { products: list, debug: { ...debug, reason: 'allow_tokens_empty', target_super_domain: targetSuperDomain } };
  }
  const condensed = [];
  for (const product of pool) {
    const productDomain = inferProductDomainKey(product);
    const productSuperDomain = inferSuperDomainKey(productDomain);
    const taxonomyDistance = computeTaxonomyDistanceToAllowSet(product, allowTokens);
    const nearTaxonomy = taxonomyDistance <= 1;
    const superDomainMatch =
      productSuperDomain === targetSuperDomain ||
      (productSuperDomain === 'general' && nearTaxonomy);
    if (!superDomainMatch || !nearTaxonomy) continue;
    condensed.push(product);
  }
  if (condensed.length < SEARCH_DOMAIN_CONDENSER_MIN_CANDS_AFTER) {
    return {
      products: list,
      debug: {
        ...debug,
        reason: 'insufficient_condensed_candidates',
        target_super_domain: targetSuperDomain,
        candidates_after: condensed.length,
        entropy_after: computeDomainEntropy(condensed),
      },
    };
  }
  return {
    products: condensed,
    debug: {
      ...debug,
      applied: true,
      reason: triggerByEmpty ? 'applied_on_empty_candidates' : 'applied_on_high_entropy',
      target_super_domain: targetSuperDomain,
      candidates_after: condensed.length,
      entropy_after: computeDomainEntropy(condensed),
      trigger_by_empty: triggerByEmpty,
      trigger_by_entropy: triggerByEntropy,
    },
  };
}

function extractCategoryTokensFromIntent(intent, rawQuery) {
  const base = [];
  if (Array.isArray(intent?.category?.required)) base.push(...intent.category.required);
  if (Array.isArray(intent?.category?.optional)) base.push(...intent.category.optional);
  if (Array.isArray(intent?.hard_constraints?.must_include_keywords)) {
    base.push(...intent.hard_constraints.must_include_keywords);
  }
  const q = String(rawQuery || '').toLowerCase();
  for (const token of normalizeWordTokens(q)) {
    if (token.length >= 2) base.push(token);
  }
  if (/dog leash|pet leash|harness|collar|狗链|牵引|背带|项圈|遛狗/.test(q)) {
    base.push('leash', 'harness', 'collar', 'pet');
  }
  if (/化妆刷|makeup brush|brush set|foundation brush|powder brush/.test(q)) {
    base.push('brush', 'beauty_tools', 'makeup');
  }
  if (/hiking|徒步|登山|露营|camping|trail|outdoor/.test(q)) {
    base.push('hiking', 'outdoor', 'camping', 'trekking');
  }
  if (/travel|出差|旅行|差旅|packing|luggage|toiletry/.test(q)) {
    base.push('travel', 'packing', 'luggage', 'toiletry');
  }
  const normalized = new Set();
  for (const item of base) {
    const tokens = normalizeWordTokens(item);
    for (const token of tokens) {
      if (token.length >= 2) normalized.add(token);
    }
  }
  return Array.from(normalized).slice(0, 30);
}

function extractCategoryTokensFromProduct(product) {
  const tokens = new Set();
  const categoryPath = Array.isArray(product?.category_path) ? product.category_path : [];
  for (const pathItem of categoryPath) {
    for (const token of normalizeWordTokens(pathItem)) {
      if (token.length >= 2) tokens.add(token);
    }
  }
  for (const token of normalizeWordTokens(product?.category || '')) {
    if (token.length >= 2) tokens.add(token);
  }
  for (const token of normalizeWordTokens(product?.category_name || '')) {
    if (token.length >= 2) tokens.add(token);
  }
  for (const token of normalizeWordTokens(buildProductText(product) || '')) {
    if (token.length >= 2) tokens.add(token);
  }
  return tokens;
}

function computeTaxonomyDistanceToAllowSet(product, allowTokens) {
  const allow = Array.isArray(allowTokens) ? allowTokens : [];
  if (!allow.length) return 1;
  const allowSet = new Set(allow);
  const productTokens = extractCategoryTokensFromProduct(product);
  if (!productTokens.size) return 2;
  for (const token of productTokens) {
    if (allowSet.has(token)) return 0;
  }
  for (const token of productTokens) {
    for (const allowToken of allowSet) {
      if (token.includes(allowToken) || allowToken.includes(token)) return 1;
    }
  }
  return 2;
}

function computeAmbiguityScorePre(intent, queryClassInput = null) {
  const queryClass = normalizeQueryClass(queryClassInput ?? intent?.query_class, {
    defaultValue: null,
  });
  const overall = clamp01(intent?.confidence?.overall);
  const domain = clamp01(intent?.confidence?.domain);
  const category = clamp01(intent?.confidence?.category);
  const confidenceMean = clamp01((overall + domain + category) / 3);
  const missingSlots = Array.isArray(intent?.ambiguity?.missing_slots)
    ? intent.ambiguity.missing_slots.length
    : 0;
  const missingRatio = clamp01(missingSlots / 6);
  const clarifySignal = intent?.ambiguity?.needs_clarification ? 1 : 0;
  let score = clamp01(0.55 * (1 - confidenceMean) + 0.3 * missingRatio + 0.15 * clarifySignal);
  if (queryClass === 'lookup') score *= 0.55;
  else if (['category', 'attribute'].includes(queryClass)) score *= 0.75;
  else if (isAmbiguitySensitiveQueryClass(queryClass)) score = clamp01(score + 0.05);
  return clamp01(score);
}

function computeAmbiguityScorePost({
  ambiguityPre,
  products,
  rawQuery,
  intent,
  queryClassInput = null,
  anchorTokens = null,
  anchorMode = 'raw',
}) {
  const list = Array.isArray(products) ? products : [];
  const queryClass = normalizeQueryClass(queryClassInput ?? intent?.query_class, {
    defaultValue: null,
  });
  const candidateSparsity = clamp01(list.length === 0 ? 1 : (3 - Math.min(list.length, 3)) / 3);
  const domainEntropy = computeDomainEntropy(list);
  const anchorRatio =
    anchorMode === 'off'
      ? 1
      : computeAnchorRatio(rawQuery, list, {
          anchorTokens,
        });
  const domainKey = inferSearchDomainKey(intent, rawQuery);
  const inDomainCount = list.filter((product) => inferProductDomainKey(product) === domainKey).length;
  const inDomainRatio = list.length > 0 ? clamp01(inDomainCount / list.length) : 0;
  let score = clamp01(
    0.35 * clamp01(ambiguityPre) +
      0.25 * candidateSparsity +
      0.2 * domainEntropy +
      0.15 * (1 - anchorRatio) +
      0.05 * (1 - inDomainRatio),
  );
  if (['lookup', 'category', 'attribute'].includes(queryClass) && list.length > 0) {
    score *= 0.8;
  }
  return clamp01(score);
}

function estimateRewriteDriftRisk(rawQuery, terms = []) {
  const queryTokens = new Set(normalizeWordTokens(rawQuery));
  const termTokens = new Set(normalizeWordTokens(Array.isArray(terms) ? terms.join(' ') : terms));
  if (!queryTokens.size || !termTokens.size) return 0;
  let overlap = 0;
  for (const token of termTokens) {
    if (queryTokens.has(token)) overlap += 1;
  }
  const anchorRatio = overlap / Math.max(1, termTokens.size);
  return clamp01(1 - anchorRatio);
}

function shouldUseAggressiveRewrite({
  expansionMode,
  intent,
  queryClass,
  driftRisk,
  associationPlan,
}) {
  if (!SEARCH_AGGRESSIVE_REWRITE_ENABLED) return false;
  if (String(expansionMode || '').toLowerCase() !== 'aggressive') return false;
  if (!['mission', 'scenario', 'gift'].includes(normalizeQueryClass(queryClass))) return false;
  if (clamp01(intent?.confidence?.overall) < 0.75) return false;
  if (clamp01(intent?.confidence?.domain) < 0.65) return false;
  if (clamp01(driftRisk) > 0.3) return false;
  return Boolean(associationPlan?.applied);
}

function matchesDomainAllowlist(product, domainKey, options = {}) {
  if (!SEARCH_DOMAIN_HARD_FILTER_ENABLED) return true;
  if (!domainKey || domainKey === 'general') return true;
  const mode = String(options.mode || 'strict').toLowerCase();
  const allowTokens = Array.isArray(options.allowTokens) ? options.allowTokens : [];
  const productDomain = inferProductDomainKey(product);
  let strictMatch = false;
  if (domainKey === 'pet') strictMatch = productDomain === 'pet';
  else if (domainKey === 'beauty') strictMatch = productDomain === 'beauty';
  else if (domainKey === 'travel') strictMatch = productDomain === 'travel';
  else if (domainKey === 'hiking') strictMatch = productDomain === 'hiking';
  else strictMatch = true;
  if (strictMatch) return true;
  if (mode === 'balanced') {
    const querySuperDomain = inferSuperDomainKey(domainKey);
    const productSuperDomain = inferSuperDomainKey(productDomain);
    const taxonomyDistance = computeTaxonomyDistanceToAllowSet(product, allowTokens);
    const nearTaxonomy = taxonomyDistance <= 1;
    if (productDomain === 'general' && nearTaxonomy) return true;
    if (querySuperDomain === productSuperDomain && nearTaxonomy) return true;
  }
  return false;
}

function applyDomainHardFilter(products, intent, rawQuery, options = {}) {
  const list = Array.isArray(products) ? products : [];
  const _ = options;
  // Recall-first policy: domain filter is telemetry-only and never drops products.
  return {
    products: list,
    dropped: 0,
    dropped_external: 0,
    domain_key: inferSearchDomainKey(intent, rawQuery),
    mode_used: 'disabled',
    pass2_triggered: false,
    strict_kept: list.length,
    strict_dropped: 0,
  };
}

function applyBeautyBucketBackstop(products, intent, rawQuery, queryClass) {
  const list = Array.isArray(products) ? products : [];
  const beautyQueryProfile = buildBeautyQueryProfile({
    rawQuery,
    queryClass,
    intent,
  });
  const bucket = beautyQueryProfile?.bucket || null;
  const bucketMixBefore = computeBeautyCategoryMixTopN(list, Math.max(1, list.length || 1));

  if (!beautyQueryProfile?.isSpecificBeautyQuery || !bucket) {
    return {
      products: list,
      applied: false,
      dropped: 0,
      bucket,
      bucket_mix_before: bucketMixBefore,
      bucket_mix_after: bucketMixBefore,
      emptied: false,
      reason: 'not_applicable',
    };
  }

  const filtered = list.filter((product) =>
    isBeautyBucketCompatibleForQuery(classifyBeautyBucketForDiversity(product), bucket),
  );
  return {
    products: filtered,
    applied: true,
    dropped: Math.max(0, list.length - filtered.length),
    bucket,
    bucket_mix_before: bucketMixBefore,
    bucket_mix_after: computeBeautyCategoryMixTopN(filtered, Math.max(1, filtered.length || 1)),
    emptied: list.length > 0 && filtered.length === 0,
    reason: filtered.length < list.length ? 'beauty_bucket_filtered' : 'pass',
  };
}

function normalizeStringArray(arr, maxItems, maxLen) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s) continue;
    out.push(s.length > maxLen ? s.slice(0, maxLen) : s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractLatestUserTextFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || '').toLowerCase();
    if (role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function looksLikeRealQuery(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length < 2) return false;
  // Require at least one alnum or CJK character to avoid pure punctuation.
  return /[a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/i.test(t);
}

function shouldDropHistoryByIntent(intent) {
  // Default: only use history when explicitly requested by user (intent.history_usage.used=true)
  return !intent?.history_usage?.used;
}

function pruneRecentQueries(latestQuery, recentQueries, intent) {
  const trimmed = normalizeStringArray(recentQueries, 5, 80);
  if (!trimmed.length) return [];
  if (!intent) return trimmed;

  if (!shouldDropHistoryByIntent(intent)) return trimmed;

  // If we are dropping history, do not forward it upstream to avoid cross-domain bias.
  return [];
}

function getResponseProductList(response) {
  if (!response || typeof response !== 'object') return { key: null, list: [] };
  if (Array.isArray(response.products)) return { key: 'products', list: response.products };
  if (Array.isArray(response.items)) return { key: 'items', list: response.items };
  if (response.data && Array.isArray(response.data.products)) return { key: 'data.products', list: response.data.products };
  if (response.output && Array.isArray(response.output.products)) return { key: 'output.products', list: response.output.products };
  return { key: null, list: [] };
}

function setResponseProductList(response, key, list) {
  if (!response || typeof response !== 'object' || !key) return response;
  if (key === 'products') return { ...response, products: list };
  if (key === 'items') return { ...response, items: list };
  if (key === 'data.products') return { ...response, data: { ...(response.data || {}), products: list } };
  if (key === 'output.products') return { ...response, output: { ...(response.output || {}), products: list } };
  return response;
}

function syncResponsePaginationCounts(response, listCount) {
  if (!response || typeof response !== 'object') return response;
  const count = Math.max(0, Number(listCount || 0) || 0);
  const next = { ...response };

  if (typeof next.total === 'number') next.total = count;
  if (typeof next.page_size === 'number') next.page_size = count;

  if (next.pagination && typeof next.pagination === 'object' && !Array.isArray(next.pagination)) {
    next.pagination = {
      ...next.pagination,
      ...(typeof next.pagination.total_count === 'number' ? { total_count: count } : {}),
    };
  }

  const sourceList = (() => {
    const { list } = getResponseProductList(next);
    return Array.isArray(list) ? list : [];
  })();
  const sourceSummary = summarizeCandidateSources(sourceList);
  const metadata =
    next.metadata && typeof next.metadata === 'object' && !Array.isArray(next.metadata)
      ? { ...next.metadata }
      : null;
  if (metadata) {
    const existingBreakdown =
      metadata.source_breakdown &&
      typeof metadata.source_breakdown === 'object' &&
      !Array.isArray(metadata.source_breakdown)
        ? metadata.source_breakdown
        : {};
    metadata.source_breakdown = {
      ...existingBreakdown,
      internal_count: Math.max(0, Number(sourceSummary.internal_live || 0) || 0),
      external_seed_count: Math.max(0, Number(sourceSummary.external_supplement || 0) || 0),
      stable_prior_count: Math.max(0, Number(sourceSummary.stable_prior || 0) || 0),
      stale_cache_used:
        Number(sourceSummary.source_tier_counts?.cache_stale || 0) > 0,
      source_channel_counts:
        sourceSummary.source_channel_counts && typeof sourceSummary.source_channel_counts === 'object'
          ? sourceSummary.source_channel_counts
          : {},
      source_tier_counts:
        sourceSummary.source_tier_counts && typeof sourceSummary.source_tier_counts === 'object'
          ? sourceSummary.source_tier_counts
          : {},
      source_quality_counts:
        sourceSummary.source_quality_counts && typeof sourceSummary.source_quality_counts === 'object'
          ? sourceSummary.source_quality_counts
          : {},
      cache_owner_paths: Array.isArray(sourceSummary.cache_owner_paths)
        ? sourceSummary.cache_owner_paths
        : [],
      top_candidate_provenance:
        sourceSummary.top_candidate_provenance &&
        typeof sourceSummary.top_candidate_provenance === 'object'
          ? sourceSummary.top_candidate_provenance
          : null,
    };
    next.metadata = metadata;
  }

  return next;
}

function productHasCategorySignal(product, requiredCategories) {
  if (!requiredCategories || !requiredCategories.length) return true;
  const text = buildProductText(product);
  const loweredRequired = requiredCategories.map((c) => String(c || '').toLowerCase()).filter(Boolean);
  if (!loweredRequired.length) return true;

  const hasAny = (patterns) =>
    patterns.some((p) => {
      if (!p) return false;
      if (p instanceof RegExp) return p.test(text);
      return text.includes(String(p).toLowerCase());
    });

  // Category IDs in intent are *semantic*, but product text is natural language.
  // Map common category tokens to multilingual keyword sets (MVP, rule-based).
  const categoryMatchers = {
    // Human apparel
    outerwear: [
      /\b(coat|jacket|parka|puffer|outerwear|shell|windbreaker)\b/i,
      'down jacket',
      '羽绒',
      '羽绒服',
      '外套',
      '大衣',
      '冲锋衣',
      '风衣',
      '夹克',
      'abrigo',
      'chaqueta',
      'manteau',
      'veste',
      'コート',
      'ジャケット',
    ],
    coat: [
      /\b(coat|parka)\b/i,
      '大衣',
      '外套',
      'abrigo',
      'manteau',
      'コート',
    ],
    down_jacket: [
      /\b(down|puffer)\b/i,
      'down jacket',
      '羽绒',
      '羽绒服',
      'plumífero',
      'doudoune',
    ],

    // Pet apparel (and close accessories that are often acceptable for hiking)
    pet_apparel: [
      /\b(jacket|coat|sweater|raincoat|overalls|hoodie|parka|shell|vest|boots|booties|clothes|clothing|apparel|outfit)\b/i,
      /\b(chaqueta|abrigo|su[eé]ter|impermeable|overol|ropa|vestido)\b/i,
      /\b(veste|manteau|pull|imperm[eé]able|salopette|v[eê]tement|v[eê]tements)\b/i,
      '犬服',
      '猫服',
      'ペット',
      '服',
      '衣服',
      '外套',
      '雨衣',
      '毛衣',
    ],
    // Generic human apparel (non-outerwear; used for broad "women's clothes" queries)
    apparel: [
      /\b(dress|skirt|top|blouse|shirt|pants|jeans|hoodie|sweater|cardigan|tee|t-shirt)\b/i,
      /\b(outfit|clothes|clothing|apparel)\b/i,
      /\b(lingerie|underwear)\b/i,
      '衣服',
      '穿搭',
      '女装',
      '女生',
      '女士',
      '裙',
      '连衣裙',
      '上衣',
      '裤',
      '卫衣',
      '毛衣',
      '内衣',
      '下着',
      'vêtement',
      'vetement',
      'robe',
      'jupe',
      'ropa',
      'vestido',
      'falda',
    ],
    dog_jacket: [
      /\b(jacket|coat|parka|raincoat|shell|windbreaker)\b/i,
      /\b(chaqueta|abrigo|impermeable)\b/i,
      /\b(veste|manteau|imperm[eé]able)\b/i,
      '外套',
      '雨衣',
      'ジャケット',
      'コート',
    ],
    dog_sweater: [
      /\b(sweater|hoodie|knit|pullover)\b/i,
      /\b(su[eé]ter)\b/i,
      /\b(pull)\b/i,
      '毛衣',
      'ニット',
    ],
    pet_harness: [
      /\b(harness|no-?pull|tactical\s+harness)\b/i,
      /\b(harnais)\b/i,
      /\b(arn[eé]s)\b/i,
      '背带',
      '胸背',
      '牵引',
      'ハーネス',
      '胴輪',
    ],

    // Adult/intimate apparel (human)
    lingerie: [
      /\b(lingerie|underwear)\b/i,
      /\b(bra|bras|panty|panties|thong|briefs)\b/i,
      /\b(lencer[ií]a|ropa\s+interior|sujetador|bragas|tanga)\b/i,
      /\b(sous[-\s]?v[eê]tement|soutien[-\s]?gorge|culotte|string)\b/i,
      '内衣',
      '文胸',
      '胸罩',
      '丁字裤',
      '情趣',
      '下着',
      'ランジェリー',
    ],
    underwear: [
      /\b(underwear|lingerie)\b/i,
      /\b(bra|bras|panty|panties|briefs)\b/i,
      /\b(ropa\s+interior|sous[-\s]?v[eê]tement)\b/i,
      '内衣',
      '下着',
    ],
  };

  for (const c of loweredRequired) {
    if (categoryMatchers[c]) {
      if (hasAny(categoryMatchers[c])) return true;
      continue;
    }
    if (text.includes(c)) return true;
  }
  return false;
}

function getProductObject(product) {
  const pivota = product?.attributes?.pivota;
  const tagged = String(pivota?.target_object?.value || '').toLowerCase();
  if (tagged === 'human' || tagged === 'pet' || tagged === 'toy') return tagged;

  const domain = String(pivota?.domain?.value || '').toLowerCase();
  if (domain === 'human_apparel') return 'human';
  if (domain === 'toy_accessory') return 'toy';

  // Fallback: light-weight heuristic from text.
  const text = buildProductText(product);
  if (hasPetSignalInProduct(product)) return 'pet';
  if (isToyLikeText(text)) return 'toy';

  return 'unknown';
}

function isAdultProduct(product) {
  return isLingerieLikeProduct(product);
}

function getAdultIntent(intent, rawQuery) {
  const strength = detectAdultIntentStrength(rawQuery || '');
  // TODO: if we later extend intent schema with an explicit adult_intent object,
  // read it here instead of relying only on query text.
  if (strength === 'strong') return { is_explicit: true, conf: 0.9 };
  if (strength === 'soft') return { is_explicit: true, conf: 0.65 };
  return { is_explicit: false, conf: 0.0 };
}

function getCompatMeta(intent, product) {
  // MVP: compatibility is opt-in via attributes.
  // If not present, we treat as non-critical.
  const hard = intent?.hard_constraints || {};
  const model = hard.model || null;

  const compat =
    product?.attributes?.pivota?.compat ||
    product?.attributes?.compat ||
    product?.attributes?.model_compat ||
    null;

  const compatModels = Array.isArray(compat?.models)
    ? compat.models
    : Array.isArray(compat)
      ? compat
      : [];

  if (!model || !compatModels.length) {
    if (!model && !compatModels.length) {
      return { critical: false, state: 'none' };
    }
    return { critical: true, state: 'unknown' };
  }

  const match = compatModels.map(String).includes(String(model));
  return { critical: true, state: match ? 'ok' : 'incompatible' };
}

function evaluateProductForIntent(product, intent, ctx = {}) {
  const rawQuery = String(ctx?.rawQuery || '').trim();
  const target = intent?.target_object?.type || 'unknown';
  const targetConf = Number(intent?.confidence?.target_object ?? 0.5);
  const scenario = String(intent?.scenario?.name || '');

  const productObject = getProductObject(product);
  const adultIntent = getAdultIntent(intent, rawQuery);
  const compatMeta = getCompatMeta(intent, product);

  const reasonCodes = new Set();
  let riskLevel = 'ok'; // ok | soft_block | hard_block

  // ---------- Object mismatch hard gate ----------
  const objPair = `${target}:${productObject}`;
  const isCompatibleObject =
    target === 'unknown' ||
    productObject === 'unknown' ||
    target === productObject ||
    // Toy intent can accept generic toy/pet accessories when confidence is low.
    (target === 'toy' && productObject === 'unknown');

  if (!isCompatibleObject) {
    if (targetConf >= OBJECT_CONF_THRESHOLD) {
      riskLevel = 'hard_block';
      reasonCodes.add(REASON_CODES.OBJ_MISMATCH);
    } else if (targetConf >= OBJECT_CONF_LOWER) {
      // Do not hard block when we are uncertain about the user's object.
      reasonCodes.add(REASON_CODES.OBJ_UNCERTAIN);
    }
  } else if (target !== 'unknown' && productObject === target) {
    reasonCodes.add(REASON_CODES.OBJ_EXACT);
  } else if (target !== 'unknown' && productObject === 'unknown') {
    reasonCodes.add(REASON_CODES.OBJ_UNCERTAIN);
  } else if (target !== 'unknown' && productObject !== 'unknown') {
    reasonCodes.add(REASON_CODES.OBJ_COMPATIBLE);
  }

  // ---------- Adult / lingerie hard gate ----------
  if (
    riskLevel !== 'hard_block' &&
    ADULT_UNREQUESTED_BLOCK &&
    target !== 'toy' &&
    intent?.primary_domain !== 'toy_accessory'
  ) {
    if (isAdultProduct(product) && (!adultIntent.is_explicit || adultIntent.conf < 0.6)) {
      // For broad "women's clothing" queries, lingerie can be a reasonable subset.
      // Don't hard-block; allow as soft_block and ask for confirmation in reply.
      if (scenario === 'women_clothing') {
        if (riskLevel === 'ok') riskLevel = 'soft_block';
        reasonCodes.add(REASON_CODES.ADULT_NEEDS_CONFIRMATION);
      } else {
        riskLevel = 'hard_block';
        reasonCodes.add(REASON_CODES.ADULT_UNREQUESTED);
      }
    }
  }

  // ---------- Beauty tools guard rails ----------
  if (
    riskLevel !== 'hard_block' &&
    intent?.primary_domain === 'beauty' &&
    scenario === 'beauty_tools'
  ) {
    if (!isBeautyToolLikeProduct(product)) {
      // For tool-first requests, block non-tool products (e.g., lingerie/apparel)
      // to avoid confusing outputs.
      riskLevel = 'hard_block';
      reasonCodes.add(REASON_CODES.NOT_TOOL_PRODUCT);
    }
  }

  // ---------- Eye shadow brush guard rails ----------
  if (
    riskLevel !== 'hard_block' &&
    intent?.primary_domain === 'beauty' &&
    scenario === 'eye_shadow_brush'
  ) {
    if (!isEyeBrushLikeProduct(product)) {
      riskLevel = 'hard_block';
      reasonCodes.add(REASON_CODES.NOT_EYE_BRUSH_PRODUCT);
    }
  }

  // ---------- Compatibility / safety gates (MVP) ----------
  if (riskLevel !== 'hard_block' && compatMeta.critical) {
    if (compatMeta.state === 'incompatible') {
      if (COMPAT_CRITICAL_STRICT) {
        riskLevel = 'hard_block';
      } else {
        riskLevel = 'soft_block';
      }
      reasonCodes.add(REASON_CODES.COMPAT_INCOMPATIBLE);
    } else if (compatMeta.state === 'unknown') {
      // Allow but flag as soft block.
      riskLevel = riskLevel === 'ok' ? 'soft_block' : riskLevel;
      reasonCodes.add(REASON_CODES.COMPAT_UNKNOWN);
    }
  }

  // Safety-critical hook (not widely used yet).
  const safetyRisk =
    product?.attributes?.pivota?.risk?.safety_critical === true &&
    intent?.hard_constraints?.safety &&
    intent.hard_constraints.safety === 'violation';
  if (safetyRisk) {
    riskLevel = 'hard_block';
    reasonCodes.add(REASON_CODES.SAFETY_RISK);
  }

  // ---------- Pet-specific guard rails ----------
  if (riskLevel !== 'hard_block' && target === 'pet') {
    // For pet apparel, we always exclude toy/doll-style products.
    const text = buildProductText(product);
    if (isToyLikeText(text)) {
      riskLevel = 'hard_block';
      reasonCodes.add(REASON_CODES.OBJ_MISMATCH);
    }
    // Pet-signal requirement: avoid "featured" human-only items.
    if (!hasPetSignalInProduct(product)) {
      // Treat as soft block if intent confidence is low; hard block otherwise.
      if (targetConf >= OBJECT_CONF_THRESHOLD) {
        riskLevel = 'hard_block';
      } else if (riskLevel === 'ok') {
        riskLevel = 'soft_block';
      }
      reasonCodes.add(REASON_CODES.OBJ_UNCERTAIN);
    }
  }

  // ---------- in_stock_only ----------
  const inStockOnly = intent?.hard_constraints?.in_stock_only;
  if (riskLevel !== 'hard_block' && inStockOnly === true) {
    const qty = Number(
      product.inventory_quantity ?? product.inventoryQuantity ?? product.quantity ?? 0,
    );
    if (!Number.isFinite(qty) || qty <= 0) {
      riskLevel = 'hard_block';
      reasonCodes.add(REASON_CODES.CONSTRAINT_PARTIAL);
    }
  }

  const hardPrice = intent?.hard_constraints?.price || null;
  const hasPriceConstraint = hardPrice && (hardPrice.min != null || hardPrice.max != null);
  const priceConstraintResolution = hasPriceConstraint
    ? resolveBudgetConstraintForCurrency(hardPrice, getProductPriceCurrency(product))
    : { constraint: null, metadata: null };
  if (riskLevel !== 'hard_block' && hasPriceConstraint) {
    const price = getProductPriceMajor(product);
    if (
      !priceConstraintResolution.constraint ||
      !isWithinPriceConstraint(price, priceConstraintResolution.constraint)
    ) {
      riskLevel = 'hard_block';
      reasonCodes.add(REASON_CODES.CONSTRAINT_PARTIAL);
    }
  }

  return {
    risk_level: riskLevel,
    reason_codes: Array.from(reasonCodes),
    // Expose derived classification for scoring.
    product_object: productObject,
    target_object: target,
    target_conf: targetConf,
    price_constraint_resolution: priceConstraintResolution,
  };
}

function computeProductRelevance(product, intent, evalMeta) {
  const target = evalMeta.target_object;
  const productObject = evalMeta.product_object;
  const reasonCodes = new Set(evalMeta.reason_codes || []);

  // ---------- Object score ----------
  let objectScore = 0.5;
  if (target === 'unknown' || productObject === 'unknown') {
    objectScore = 0.5;
  } else if (target === productObject) {
    objectScore = 1.0;
    reasonCodes.add(REASON_CODES.OBJ_EXACT);
  } else {
    // In practice, incompatible objects should have been hard-blocked already.
    objectScore = 0.0;
    reasonCodes.add(REASON_CODES.OBJ_MISMATCH);
  }

  // ---------- Category score ----------
  const requiredCats = intent?.category?.required || [];
  let catScore = 0.6;
  if (!requiredCats.length) {
    // No explicit category → treat as parent-level.
    catScore = 0.6;
    reasonCodes.add(REASON_CODES.CAT_PARENT);
  } else if (productHasCategorySignal(product, requiredCats)) {
    catScore = 1.0;
    reasonCodes.add(REASON_CODES.CAT_EXACT);
  } else {
    // We know the user cares about category but the product does not strongly match.
    catScore = 0.4;
    reasonCodes.add(REASON_CODES.CAT_PARENT);
  }

  // ---------- Hard constraint coverage (MVP) ----------
  const hard = intent?.hard_constraints || {};
  let required = 0;
  let satisfied = 0;

  const price = getProductPriceMajor(product);
  const resolvedPriceConstraint =
    evalMeta?.price_constraint_resolution && evalMeta.price_constraint_resolution.constraint
      ? evalMeta.price_constraint_resolution.constraint
      : hard.price;
  if (resolvedPriceConstraint && (resolvedPriceConstraint.min != null || resolvedPriceConstraint.max != null)) {
    required += 1;
    const withinMin =
      resolvedPriceConstraint.min == null ||
      (Number.isFinite(price) && price >= resolvedPriceConstraint.min);
    const withinMax =
      resolvedPriceConstraint.max == null ||
      (Number.isFinite(price) && price <= resolvedPriceConstraint.max);
    if (withinMin && withinMax) {
      satisfied += 1;
    } else {
      reasonCodes.add(REASON_CODES.CONSTRAINT_PARTIAL);
    }
  }

  if (hard.in_stock_only === true) {
    required += 1;
    const qty = Number(
      product.inventory_quantity ?? product.inventoryQuantity ?? product.quantity ?? 0,
    );
    if (Number.isFinite(qty) && qty > 0) {
      satisfied += 1;
    } else {
      reasonCodes.add(REASON_CODES.MISSING_SIZE);
    }
  }

  const hardCoverage = required > 0 ? clamp01(satisfied / required) : 1.0;

  // ---------- Soft preference coverage (placeholder) ----------
  // We do not yet model style/colors/brands deeply; treat as neutral.
  const softCoverage = 0.5;

  const isSensitive =
    evalMeta.risk_level === 'soft_block' ||
    evalMeta.reason_codes.includes(REASON_CODES.COMPAT_UNKNOWN);
  const baseScore =
    0.35 * objectScore + 0.3 * catScore + 0.3 * hardCoverage + 0.05 * softCoverage;
  const sensitiveScore =
    0.3 * objectScore + 0.2 * catScore + 0.45 * hardCoverage + 0.05 * softCoverage;

  const finalScore = clamp01(isSensitive ? sensitiveScore : baseScore);

  // ---------- Tier classification ----------
  let matchTier = 'none';
  if (finalScore >= 0.78 && hardCoverage >= (isSensitive ? 0.9 : 0.75)) {
    matchTier = 'strong';
  } else if (
    finalScore >= 0.58 &&
    finalScore < 0.78 &&
    hardCoverage >= (isSensitive ? 0.7 : 0.5)
  ) {
    matchTier = 'medium';
  } else if (finalScore >= 0.35) {
    matchTier = 'weak';
  } else {
    matchTier = 'none';
  }

  // Soft-block items (e.g., adult needs confirmation / compat unknown) must never be strong/medium.
  if (evalMeta.risk_level === 'soft_block' && matchTier !== 'none') {
    matchTier = 'weak';
  }

  return {
    match_tier: matchTier,
    final_score: finalScore,
    object_score: objectScore,
    cat_score: catScore,
    hard_coverage: hardCoverage,
    soft_coverage: softCoverage,
    reason_codes: Array.from(reasonCodes),
  };
}

function satisfiesHardConstraints(product, intent, ctx = {}) {
  if (!product || !intent) return true;
  const evalMeta = evaluateProductForIntent(product, intent, ctx);
  return evalMeta.risk_level !== 'hard_block';
}

function filterProductsByIntent(products, intent, ctx = {}) {
  if (!Array.isArray(products) || !intent) return { filtered: products || [], reason_codes: [] };
  const before = products.length;

  // Inject pivota tags for all candidates first (for observability and filtering)
  const tagged = products.map(injectPivotaAttributes);
  const rawQuery = String(ctx?.rawQuery || '').trim();
  const filtered = [];
  let hardBlocked = 0;
  let hardBlockedToyLike = 0;
  const hardBlockedSamples = [];

  for (const p of tagged) {
    const evalMeta = evaluateProductForIntent(p, intent, { rawQuery });

    // Attach relevance metadata under attributes.pivota for downstream consumers.
    const existingAttrs = p.attributes && typeof p.attributes === 'object' ? p.attributes : {};
    const existingPivota =
      existingAttrs.pivota && typeof existingAttrs.pivota === 'object'
        ? existingAttrs.pivota
        : {};
    const relevance = {
      ...(existingPivota.relevance || {}),
      risk_level: evalMeta.risk_level,
      reason_codes: evalMeta.reason_codes,
      product_object: evalMeta.product_object,
      target_object: evalMeta.target_object,
      target_conf: evalMeta.target_conf,
    };
    const annotated = {
      ...p,
      attributes: {
        ...existingAttrs,
        pivota: {
          ...existingPivota,
          relevance,
        },
      },
    };

    if (evalMeta.risk_level === 'hard_block') {
      hardBlocked += 1;
      const text = buildProductText(p);
      const toyLike = isToyLikeText(text);
      if (toyLike) hardBlockedToyLike += 1;
      if (hardBlockedSamples.length < 8) {
        const pivota = p?.attributes?.pivota || {};
        hardBlockedSamples.push({
          id: p.id || p.product_id || p.productId || null,
          title: p.title || p.name || null,
          pivota_target: pivota?.target_object || null,
          pivota_domain: pivota?.domain || null,
          toy_like: toyLike,
          lingerie_like: isLingerieLikeProduct(p),
          pet_signal: hasPetSignalInProduct(p),
          eval_reason_codes: evalMeta.reason_codes,
          eval_product_object: evalMeta.product_object,
        });
      }
      continue;
    }
    filtered.push(annotated);
  }

  const reason_codes = [];
  if (before > 0 && filtered.length === 0) {
    reason_codes.push('NO_DOMAIN_MATCH', 'FILTERED_TO_EMPTY');
    if (hardBlocked === before) {
      reason_codes.push(REASON_CODES.ALL_HARD_BLOCKED);
      // Preserve legacy code but only emit it when it's literally all toy-like.
      if (hardBlockedToyLike === hardBlocked) {
        reason_codes.push(REASON_CODES.TOY_ONLY_LEFT);
      }
    }
  }
  return {
    filtered,
    reason_codes,
    debug: {
      before,
      after: filtered.length,
      hard_blocked: hardBlocked,
      hard_blocked_toy_like: hardBlockedToyLike,
      hard_blocked_samples: hardBlockedSamples,
    },
  };
}

function computeMatchStats(sortedProducts, intent, ctx = {}) {
  const arr = Array.isArray(sortedProducts) ? sortedProducts : [];
  const M = Math.min(arr.length, 20);
  let inStockNonNoneCount = 0;
  let strongCount = 0;
  let mediumCount = 0;
  let weakCount = 0;
  let distractorCount = 0;

  const rawQuery = String(ctx?.rawQuery || '').trim();

  for (let i = 0; i < arr.length; i += 1) {
    const p = arr[i];
    const evalMeta = evaluateProductForIntent(p, intent, { rawQuery });
    if (evalMeta.risk_level === 'hard_block') {
      if (i < M) distractorCount += 1;
      continue;
    }
    const relevance = computeProductRelevance(p, intent, evalMeta);

    // Attach scoring info to pivota.relevance for downstream usage.
    const attrs = p.attributes && typeof p.attributes === 'object' ? p.attributes : {};
    const pivota = attrs.pivota && typeof attrs.pivota === 'object' ? attrs.pivota : {};
    const mergedRelevance = {
      ...(pivota.relevance || {}),
      risk_level: evalMeta.risk_level,
      reason_codes: relevance.reason_codes,
      product_object: evalMeta.product_object,
      target_object: evalMeta.target_object,
      target_conf: evalMeta.target_conf,
      match_tier: relevance.match_tier,
      final_score: relevance.final_score,
      object_score: relevance.object_score,
      cat_score: relevance.cat_score,
      hard_coverage: relevance.hard_coverage,
      soft_coverage: relevance.soft_coverage,
    };
    // Mutate in-place on the original array so the caller sees scoring metadata.
    // eslint-disable-next-line no-param-reassign
    arr[i] = {
      ...p,
      attributes: {
        ...attrs,
        pivota: {
          ...pivota,
          relevance: mergedRelevance,
        },
      },
    };

    if (i < M) {
      const tier = relevance.match_tier;
      if (tier === 'strong') strongCount += 1;
      else if (tier === 'medium') mediumCount += 1;
      else if (tier === 'weak') weakCount += 1;
      else distractorCount += 1;

      const qty = Number(
        p.inventory_quantity ?? p.inventoryQuantity ?? p.quantity ?? 0,
      );
      if (tier !== 'none' && Number.isFinite(qty) && qty > 0) inStockNonNoneCount += 1;
    }
  }

  const distractorRatio = M > 0 ? distractorCount / M : 1;
  const domainPurity = 1 - distractorRatio;
  const effectiveCount = strongCount + mediumCount;
  const hardCoverage = clamp01(effectiveCount / 3);
  const availability = clamp01(inStockNonNoneCount / 3);
  const matchConfidence = clamp01(
    0.4 * domainPurity + 0.4 * hardCoverage + 0.2 * availability,
  );

  let matchTier = 'none';
  if (M === 0 || effectiveCount === 0) {
    matchTier = weakCount > 0 ? 'weak' : 'none';
  } else if (effectiveCount >= 3 && strongCount >= 1) {
    matchTier = 'strong';
  } else if (effectiveCount >= 3 && mediumCount >= 1) {
    matchTier = 'medium';
  } else if (weakCount > 0 || effectiveCount > 0) {
    // Fewer than 3 non-distractor matches → treat as weak overall,
    // even if individual items look strong.
    matchTier = 'weak';
  }

  const hasGoodMatch = effectiveCount >= 3 && distractorRatio <= 0.5;

  return {
    hard_match_count_top20: effectiveCount,
    in_stock_hard_match_count_top20: inStockNonNoneCount,
    distractor_ratio_top20: distractorRatio,
    match_confidence: matchConfidence,
    has_good_match: hasGoodMatch,
    match_tier: matchTier,
  };
}

function buildFiltersApplied(intent) {
  const requiredDomains = [];
  const excludedDomains = [];
  const excludedKeywords = normalizeStringArray(intent?.hard_constraints?.must_exclude_keywords, 16, 32);

  if (intent?.target_object?.type === 'human') {
    if (intent?.primary_domain === 'human_apparel') requiredDomains.push('human_apparel');
    excludedDomains.push('toy_accessory');
  }
  if (intent?.target_object?.type === 'pet') {
    excludedDomains.push('toy_accessory');
  }

  const requiredCategoryPaths = [];
  const requiredCats = normalizeStringArray(intent?.category?.required, 5, 64);
  if (requiredCats.length) {
    // Represent as paths to match UI expectations; MVP is coarse.
    const prefix =
      intent?.target_object?.type === 'pet'
        ? 'pet_apparel'
        : intent?.primary_domain === 'beauty'
          ? 'beauty'
          : intent?.target_object?.type === 'human'
            ? 'human_apparel'
            : 'other';
    requiredCategoryPaths.push([prefix, ...requiredCats.slice(0, 2)]);
  }

  return {
    required_domains: requiredDomains,
    required_target_object: intent?.target_object?.type || 'unknown',
    required_category_paths: requiredCategoryPaths,
    excluded_domains: excludedDomains,
    excluded_keywords: excludedKeywords,
  };
}

function buildReply(intent, matchTier, reasonCodes, creatorContext) {
  const lang = intent?.language || 'en';
  const isZh = lang === 'zh';
  const isNone = matchTier === 'none';
  const scenario = intent?.scenario?.name || 'general';
  const creatorName = creatorContext?.creatorName || creatorContext?.creatorId || null;
  const isEs = lang === 'es';
  const isFr = lang === 'fr';
  const isJa = lang === 'ja';
  const rawUserQuery = String(creatorContext?.rawUserQuery || '');
  const isPet = (intent?.target_object?.type || '') === 'pet';
  const requiredCategories = Array.isArray(intent?.category?.required)
    ? intent.category.required.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const isHumanApparelIntent = String(intent?.primary_domain || '').trim().toLowerCase() === 'human_apparel';
  const isColdWeatherApparelIntent =
    String(scenario || '').toLowerCase().includes('cold') ||
    String(scenario || '').toLowerCase().includes('mountain');
  const isActivewearApparelIntent = requiredCategories.includes('activewear');
  const isFootwearApparelIntent = requiredCategories.includes('footwear');
  const isGeneralApparelIntent =
    isHumanApparelIntent && !isColdWeatherApparelIntent && !isActivewearApparelIntent && !isFootwearApparelIntent;
  const price = intent?.hard_constraints?.price || null;
  const priceMinHint = formatBudgetAmountForHint(price?.currency, price?.min);
  const priceMaxHint = formatBudgetAmountForHint(price?.currency, price?.max);
  const priceHintZh =
    price && price?.currency
      ? price.min != null && priceMinHint
        ? `（优先 ≥${priceMinHint}）`
        : price.max != null && priceMaxHint
          ? `（预算 ≤${priceMaxHint}）`
          : ''
      : '';
  const priceHintEn =
    price && price?.currency
      ? price.min != null && priceMinHint
        ? `(prioritizing ${priceMinHint}+)`
        : price.max != null && priceMaxHint
          ? `(budget ≤${priceMaxHint})`
          : ''
      : '';
  const priceHintJa =
    price && price?.currency
      ? price.min != null && priceMinHint
        ? `（${priceMinHint}以上を優先）`
        : price.max != null && priceMaxHint
          ? `（予算は${priceMaxHint}以内）`
          : ''
      : '';
  const priceHintFr =
    price && price?.currency
      ? price.min != null && priceMinHint
        ? `(priorité ${priceMinHint}+)`
        : price.max != null && priceMaxHint
          ? `(budget ≤${priceMaxHint})`
          : ''
      : '';
  const priceHintEs =
    price && price?.currency
      ? price.min != null && priceMinHint
        ? `(priorizando ${priceMinHint}+)`
        : price.max != null && priceMaxHint
          ? `(presupuesto ≤${priceMaxHint})`
          : ''
      : '';

  const needsLargeDogSizingHelp =
    isPet && detectLargeDogSignal(rawUserQuery) && !hasDogMeasurementsInQuery(rawUserQuery);

  if (scenario === 'eye_shadow_brush') {
    return buildEyeShadowBrushReply({ rawQuery: creatorContext?.rawUserQuery || '', language: lang }).reply;
  }

  if (scenario === 'sleepwear') {
    if (isZh) {
      if (isNone) {
        return '我暂时没在当前货盘里找到足够匹配的睡衣/家居服（可能品类覆盖不足）。你可以告诉我：春秋/冬季、长袖还是短袖、偏宽松还是修身、以及尺码范围，我再帮你精准筛。';
      }
      if (matchTier === 'weak') {
        return '我先按“睡衣/家居服”给你挑了一些候选（匹配度一般）。你更想要：春秋/冬季、长袖/短袖、以及大概尺码？我再帮你收敛到更贴近的款。';
      }
      return '我按你要的睡衣/家居服场景整理了几件更合适的选择。';
    }
    if (isJa) {
      if (isNone) {
        return '今の在庫では、睡衣/ルームウェアが十分に見つからなかったので、関係ない商品はおすすめしません。季節（春秋/冬）、袖丈（長袖/半袖）、サイズ感を教えてください。';
      }
      if (matchTier === 'weak') {
        return 'ルームウェア候補は少なめでした。季節（春秋/冬）と袖丈（長袖/半袖）、サイズを教えてくれたら絞り込みます。';
      }
      return '睡衣/ルームウェアとして合いそうな候補をまとめました。';
    }
    if (isFr) {
      if (isNone) {
        return "Je n’ai pas trouvé assez de pyjamas/tenues d’intérieur dans l’inventaire actuel, donc je ne vais pas recommander des articles hors sujet. Dis-moi la saison (mi-saison/hiver), manches (longues/courtes) et la taille.";
      }
      if (matchTier === 'weak') {
        return 'J’ai trouvé quelques options de pyjama/tenue d’intérieur mais la correspondance est faible. Saison (mi-saison/hiver), manches, taille ?';
      }
      return 'Voici des options de pyjama/tenue d’intérieur plus adaptées.';
    }
    if (isEs) {
      if (isNone) {
        return 'No encontré suficientes pijamas/ropa de dormir en el inventario actual, así que no voy a recomendar artículos fuera de tema. Dime temporada (entretiempo/invierno), manga (larga/corta) y talla.';
      }
      if (matchTier === 'weak') {
        return 'Encontré pocas opciones de pijama/ropa de dormir (match débil). ¿Temporada, manga y talla?';
      }
      return 'Aquí van opciones de pijama/ropa de dormir más adecuadas.';
    }
    if (isNone) {
      return "I couldn’t find enough sleepwear/loungewear in the current inventory, so I won’t recommend unrelated items. Tell me season (spring/fall vs winter), sleeve length, and your size range.";
    }
    if (matchTier === 'weak') {
      return 'I found a few sleepwear options but the match is weak. What season, sleeve length, and size range do you want?';
    }
    return 'Here are some more suitable sleepwear/loungewear picks.';
  }

  if (scenario === 'beauty_tools') {
    if (isZh) {
      if (isNone) {
        return '我暂时没在当前货盘里找到足够匹配的化妆工具/刷具（可能库存覆盖不足）。你可以告诉我：你最想解决什么（底妆服帖/持妆控油/遮瑕/新手不翻车/眼妆更干净）？以及常用底妆类型（粉底液/气垫/粉饼）和肤质（油/干/混）。';
      }
      if (matchTier === 'weak') {
        return '我先给你配了一些“工具优先”的组合（匹配度一般，主要是信息还不够）。你更想解决哪一个：底妆服帖 / 持妆控油 / 遮瑕 / 新手不翻车 / 眼妆更干净？';
      }
      return '我按“工具优先”给你配好了几套更合适的化妆工具组合。';
    }
    if (isNone) {
      return 'I couldn’t find enough solid matches for makeup tools in the current inventory. Tell me your goal (smooth base / longwear / coverage / beginner-safe / eye blending) and your base type (liquid/cushion/powder).';
    }
    if (matchTier === 'weak') {
      return 'I assembled a few tool-first picks, but it’s a weak match because key details are missing. What’s your main goal (smooth base / longwear / coverage / beginner-safe / eye blending)?';
    }
    return 'Here are some more suitable tool-first makeup picks based on your request.';
  }

  if (scenario === 'discovery') {
    if (isZh) {
      const who = creatorName ? `我是「${creatorName}」` : '我在这';
      return [
        `嗨～${who}。想先随便逛逛，还是你其实有一个“想买/想找”的目标？`,
        '给我一个方向就行（选 1 个）：',
        '1）给自己穿（外套/鞋/通勤/约会）',
        '2）送礼（告诉我对象 + 预算）',
        '3）给 Labubu/娃娃/公仔（衣服/配饰）',
        '4）我也不确定，就想随便看看',
      ].join('\n');
    }
    if (isEs) {
      const who = creatorName ? `Soy ${creatorName}` : 'Estoy aquí';
      return [
        `Hola—${who}. ¿Quieres echar un vistazo o estás buscando algo específico?`,
        'Elige una opción para empezar:',
        '1) Para mí (abrigo / zapatos / oficina / cita)',
        '2) Un regalo (para quién + presupuesto)',
        '3) Para mi perro/gato/mascota (ropa / accesorios)',
        '4) No estoy seguro—muéstrame lo popular',
      ].join('\n');
    }
    if (isFr) {
      const who = creatorName ? `Je suis ${creatorName}` : 'Je suis là';
      return [
        `Salut—${who}. Tu veux juste parcourir, ou tu cherches quelque chose de précis ?`,
        'Choisis une option pour commencer :',
        '1) Pour moi (manteau / chaussures / bureau / rendez-vous)',
        '2) Un cadeau (pour qui + budget)',
        '3) Pour mon chien/chat/animal (vêtements / accessoires)',
        '4) Je ne sais pas—montre-moi le populaire',
      ].join('\n');
    }
    if (isJa) {
      const who = creatorName ? `私は${creatorName}です` : 'ここにいるよ';
      return [
        `こんにちは—${who}。まずは「見て回る」？それとも何か探してる？`,
        'まずは1つ選んで：',
        '1) 自分用（アウター/靴/通勤/デート）',
        '2) ギフト（相手 + 予算）',
        '3) 犬/猫/ペット用（服/アクセ）',
        '4) まだ未定—人気から見たい',
      ].join('\n');
    }
    const who = creatorName ? `I’m ${creatorName}` : "I’m here";
    return [
      `Hey—${who}. Want to browse casually, or are you looking for something specific?`,
      'Pick one to start:',
      '1) For me (outerwear / shoes / commute / date)',
      '2) A gift (tell me who + budget)',
      '3) For a doll/toy like Labubu (outfits / accessories)',
      "4) Not sure—surprise me with what's available",
    ].join('\n');
  }

  if (scenario === 'browse') {
    if (isZh) {
      const who = creatorName ? `（${creatorName}）` : '';
      return [
        `我先给你上${who}的“随便逛逛”精选～你更想往哪边收？`,
        '1）保暖外套/出门穿搭',
        '2）送礼',
        '3）玩具/公仔相关',
        '4）就先看看热门',
      ].join('\n');
    }
    if (isEs) {
      const who = creatorName ? ` (${creatorName})` : '';
      return [
        `Aquí tienes algunas selecciones destacadas${who}. ¿Hacia dónde lo enfocamos?`,
        '1) Abrigos / outfits',
        '2) Regalos',
        '3) Mascotas (ropa/accesorios)',
        '4) Ver lo más popular',
      ].join('\n');
    }
    if (isFr) {
      const who = creatorName ? ` (${creatorName})` : '';
      return [
        `Voici quelques sélections à parcourir${who}. Tu veux plutôt :`,
        '1) Manteaux / tenues',
        '2) Cadeaux',
        '3) Animaux (vêtements/accessoires)',
        '4) Le plus populaire',
      ].join('\n');
    }
    if (isJa) {
      const who = creatorName ? `（${creatorName}）` : '';
      return [
        `まずはおすすめ${who}を出すね。どの方向がいい？`,
        '1) アウター/コーデ',
        '2) ギフト',
        '3) ペット（服/アクセ）',
        '4) 人気だけ見たい',
      ].join('\n');
    }
    const who = creatorName ? ` (${creatorName})` : '';
    return [
      `Here are some featured picks${who} to browse. Which direction should I lean into?`,
      '1) Outerwear / outfits',
      '2) Gifts',
      '3) Toys / collectibles',
      '4) Just show popular items',
    ].join('\n');
  }

  if (isZh) {
    if (isNone) {
      if (intent?.primary_domain === 'beauty') {
        return '我没在当前货盘里凑出足够可靠的彩妆清单（为了避免误导，这次不展示无关商品）。你可以改成更明确的需求，比如：底妆 + 眼妆 + 唇妆（预算区间），或直接给我品牌/产品名。';
      }
      if ((intent?.scenario?.name || '') === 'women_clothing') {
        return '我没在当前货盘里找到足够匹配的女生衣服（可能品类覆盖不足）。你可以告诉我：更想要裙子/上衣/裤子/卫衣哪一类？尺码和预算（例如 ≤$20）也可以，我再帮你更精准地筛。';
      }
      if ((intent?.scenario?.name || '') === 'sexy_outfit') {
        return '我没在当前货盘里找到足够匹配的“性感风”女生衣服。你更偏好：内衣套装 / 小礼裙 / 约会穿搭 哪一类？也可以给我预算和尺码。';
      }
      return '我没找到足够匹配的商品（当前货盘里可能缺少相关品类）。你可以换个关键词，或告诉我预算/尺码/场景，我再帮你缩小范围。';
    }
    if (matchTier === 'weak') {
      if (intent?.primary_domain === 'beauty') {
        return '我找到了一些美妆候选，但还不够稳。我建议你补充 1–2 个条件：预算、肤质（油/干/混）、以及你更看重底妆/眼妆/唇妆哪两类，我会按多品类清单重排。';
      }
      if ((intent?.target_object?.type || '') === 'pet') {
        const sizeHint = needsLargeDogSizingHelp ? '胸围/背长（cm）或常穿尺码（L/XL/XXL）' : '体型/胸围';
        return `我只找到少量勉强相关的狗狗/宠物衣服（匹配度不高），所以先不强行推荐不相关的商品。你可以补充：狗狗${sizeHint}、最低温度、是否需要防风防水，我再帮你精准筛。`;
      }
      if ((intent?.scenario?.name || '') === 'women_clothing') {
        const p = intent?.hard_constraints?.price;
        const budgetHint =
          p && p.max != null && p.currency
            ? `（预算大约 ≤${p.currency}${p.max}）`
            : '';
        return [
          `我找到了一些可能合适的女生衣服${budgetHint}（匹配度一般，我把更接近你预算的先放前面）。`,
          '你更想要哪一类：裙子 / 上衣 / 裤子 / 卫衣？尺码和风格也可以说一下。',
          '另外要确认下：这次“女生衣服”是否也包括内衣/内搭类？如果不包括我可以帮你过滤掉。',
        ].join('\n');
      }
      if ((intent?.scenario?.name || '') === 'sexy_outfit') {
        return [
          '我找到了一些“性感风”相关的候选（匹配度一般，我先把可能合适的放前面）。',
          '你更偏好：1) 内衣套装 2) 小礼裙/约会穿搭 3) 居家睡衣？',
          '如果你不想看内衣类，我也可以帮你过滤只留“可外穿”的款式。',
        ].join('\n');
      }
      return '我只找到了少量勉强相关的结果（匹配度不高）。你可以补充：预算、尺码、想要的品类（裙子/上衣/裤子）和风格（简约/甜酷/通勤/约会）。';
    }
    const sizingHint = needsLargeDogSizingHelp
      ? '为了更准（尤其是大型犬），告诉我狗狗的胸围+背长（cm）或常穿尺码（L/XL/XXL）。'
      : '';
    return ['我找到了几件更符合你需求的选择。' + (priceHintZh || ''), sizingHint].filter(Boolean).join('\n');
  }

  if (isNone) {
    if (intent?.primary_domain === 'beauty') {
      if (isEs) {
        return 'No encontré un set de belleza suficientemente consistente en el inventario actual, así que no mostraré productos irrelevantes. Prueba con requisitos más concretos (base + ojos + labios, rango de precio) o una marca/producto exacto.';
      }
      if (isFr) {
        return "Je n’ai pas trouvé un panier beauté assez cohérent dans l’inventaire actuel, donc je n’affiche pas d’articles hors sujet. Donne un besoin plus précis (teint + yeux + lèvres, budget) ou une marque/produit exact.";
      }
      if (isJa) {
        return '現在の在庫では、十分に一貫したビューティー候補を組めなかったため、無関係な商品は表示しません。ベース/アイ/リップの希望と予算、またはブランド名を教えてください。';
      }
      return "I couldn't build a reliable beauty set from current inventory, so I won't show unrelated products. Try specifying base + eye + lip needs with budget, or give an exact brand/product anchor.";
    }
    if ((intent?.target_object?.type || '') === 'pet') {
      if (isEs) {
        return 'No encontré opciones realmente adecuadas de ropa de senderismo para tu perro/mascota en el inventario actual, así que no voy a recomendar cosas que no correspondan. Prueba con: "chaqueta para perro", "abrigo para perro", "impermeable para perro" o dime la talla de tu perro y la temperatura.';
      }
      if (isFr) {
        return 'Je n’ai pas trouvé de bonnes options de vêtements de randonnée pour ton chien/animal dans l’inventaire actuel, donc je ne vais pas recommander des articles hors sujet. Essaie : "manteau pour chien", "veste pour chien", "imperméable pour chien" ou donne-moi la taille et la température.';
      }
      if (isJa) {
        return '今の在庫では、ハイキング向けの犬/ペット用ウェアが十分に見つからなかったので、関係ない商品はおすすめしません。例：犬用ジャケット、犬用レインコート、ペット用防寒。犬のサイズと気温も教えてね。';
      }
      return "I couldn’t find solid matches for hiking-ready dog/pet apparel in the current inventory, so I won’t recommend unrelated items. Try searching for: dog jacket, dog raincoat, pet hiking gear, or tell me your dog’s size and the weather.";
    }
    if (isActivewearApparelIntent) {
      return "I couldn’t find enough activewear matches in the current inventory, so I won’t recommend unrelated items. Tell me whether you want a sports bra, leggings, or a matching set, plus your size and budget.";
    }
    if (isFootwearApparelIntent) {
      return "I couldn’t find enough footwear matches in the current inventory, so I won’t recommend unrelated items. Tell me the shoe type, your size, and whether this is for walking, running, or everyday wear.";
    }
    if (isGeneralApparelIntent) {
      return "I couldn’t find enough apparel matches in the current inventory, so I won’t recommend unrelated items. Tell me the exact category you want, plus your size and budget, and I’ll narrow it down.";
    }
    return "I couldn’t find solid matches for adult cold-weather outerwear in the current inventory, so I won’t recommend unrelated items. Try searching for: down jacket, hiking shell, parka, or share your lowest temperature and budget.";
  }
  if (matchTier === 'weak') {
    if (intent?.primary_domain === 'beauty') {
      if (isEs) {
        return 'Encontré algunas opciones de belleza, pero la relevancia aún es débil. Dime 1–2 condiciones (presupuesto, tipo de piel, y prioridad entre base/ojos/labios) y lo reordeno con mezcla de categorías.';
      }
      if (isFr) {
        return "J’ai trouvé quelques options beauté, mais la pertinence reste faible. Donne 1–2 contraintes (budget, type de peau, priorité teint/yeux/lèvres) et je réordonne en mix multi-catégories.";
      }
      if (isJa) {
        return '美容候補はいくつかありますが、まだ一致度が弱めです。予算・肌質・優先（ベース/アイ/リップ）を1〜2点教えてくれれば、多カテゴリで再構成します。';
      }
      return 'I found a few beauty options but relevance is still weak. Share 1–2 constraints (budget, skin type, and priority among base/eye/lip) and I will rerank into a multi-category list.';
    }
    if ((intent?.target_object?.type || '') === 'pet') {
      if (isEs) {
        return 'Solo encontré unas pocas opciones flojas para ropa de perro/mascota, así que no voy a recomendar artículos fuera de tema. Dime la talla de tu perro (pecho/espalda), la temperatura y si necesitas impermeable/cortaviento.';
      }
      if (isFr) {
        return 'Je n’ai trouvé que quelques options faibles pour des vêtements de chien/animal, donc je ne vais pas recommander des articles hors sujet. Donne-moi la taille (poitrine/dos), la température et si tu veux coupe-vent/imperméable.';
      }
      if (isJa) {
        return '犬/ペット用の候補が少なく、関連の薄い商品はおすすめしません。サイズ（胴回り/背丈）、気温、雨対策（防水/防風）が必要か教えてください。';
      }
      return "I only found a few weak matches for dog/pet apparel, so I won’t recommend unrelated items. Tell me your dog’s size, the temperature, and whether you need waterproof/windproof.";
    }
    if (isActivewearApparelIntent) {
      return 'I only found a few weak activewear matches, so I won’t force unrelated recommendations. Tell me whether you want a sports bra, leggings, or a matching set, plus your size and budget.';
    }
    if (isFootwearApparelIntent) {
      return 'I only found a few weak footwear matches, so I won’t force unrelated recommendations. Tell me the shoe type, your size, and whether this is for walking, running, or everyday wear.';
    }
    if (isGeneralApparelIntent) {
      return 'I only found a few weak apparel matches, so I won’t force unrelated recommendations. Share the exact category you want, plus your size and budget, and I’ll rerank around that.';
    }
    return "I only found a few weak matches, so I won’t force unrelated recommendations. Share your budget, the lowest temperature, and whether you need windproof/waterproof.";
  }
  if (isJa) {
    const sizingHint = needsLargeDogSizingHelp
      ? '大型犬だとサイズ差が大きいので、胴回り＋背丈（cm）か普段のサイズ（L/XL/XXL）を教えてください。'
      : '';
    return ['リクエストに合いそうな候補をまとめました。' + (priceHintJa || ''), sizingHint].filter(Boolean).join('\n');
  }
  if (isFr) {
    const sizingHint = needsLargeDogSizingHelp
      ? 'Pour un grand chien, la taille varie beaucoup : donne-moi le tour de poitrine + la longueur de dos (cm) ou la taille habituelle (L/XL/XXL).'
      : '';
    return ['Voici des options plus adaptées.' + (priceHintFr || ''), sizingHint].filter(Boolean).join('\n');
  }
  if (isEs) {
    const sizingHint = needsLargeDogSizingHelp
      ? 'Para un perro grande la talla varía mucho: dime pecho + espalda (cm) o la talla habitual (L/XL/XXL).'
      : '';
    return ['Aquí tienes opciones más adecuadas.' + (priceHintEs || ''), sizingHint].filter(Boolean).join('\n');
  }
  const sizingHint = needsLargeDogSizingHelp
    ? "For a large dog, sizing varies a lot—share chest + back length (cm/in) or your usual size (L/XL/XXL)."
    : '';
  return ['Here are some more suitable picks based on your request.' + (priceHintEn || ''), sizingHint]
    .filter(Boolean)
    .join('\n');
}

async function buildFindProductsMultiContext({ payload, metadata }) {
  const search = payload?.search || {};
  const topLevelSearchCompat = {
    ...(payload?.query != null ? { query: payload.query } : {}),
    ...(payload?.page != null ? { page: payload.page } : {}),
    ...(payload?.limit != null ? { limit: payload.limit } : {}),
    ...(payload?.page_size != null ? { page_size: payload.page_size } : {}),
    ...(payload?.in_stock_only != null ? { in_stock_only: payload.in_stock_only } : {}),
    ...(payload?.category != null ? { category: payload.category } : {}),
    ...(payload?.merchant_id != null ? { merchant_id: payload.merchant_id } : {}),
    ...(payload?.merchant_ids != null ? { merchant_ids: payload.merchant_ids } : {}),
    ...(payload?.search_all_merchants != null ? { search_all_merchants: payload.search_all_merchants } : {}),
    ...(payload?.price_min != null ? { price_min: payload.price_min } : {}),
    ...(payload?.price_max != null ? { price_max: payload.price_max } : {}),
    ...(payload?.min_price != null ? { min_price: payload.min_price } : {}),
    ...(payload?.max_price != null ? { max_price: payload.max_price } : {}),
  };
  const recentQueries = payload?.user?.recent_queries || [];
  const recentMessages = payload?.messages || [];

  // Some clients (chat-style UIs) may send the user utterance only in `messages`
  // and leave `search.query` empty. If so, derive query from the last user message.
  const queryFromSearch = String(search.query || '').trim();
  const queryFromPayload = String(payload?.query || '').trim();
  const queryFromMessages = extractLatestUserTextFromMessages(recentMessages);
  const latestUserQuery = looksLikeRealQuery(queryFromSearch)
    ? queryFromSearch
    : looksLikeRealQuery(queryFromPayload)
      ? queryFromPayload
    : looksLikeRealQuery(queryFromMessages)
      ? queryFromMessages
      : queryFromSearch;
  const normalizedSearchInput = {
    ...topLevelSearchCompat,
    ...(search && typeof search === 'object' ? search : {}),
  };
  const requestedCatalogSurface = String(
    normalizedSearchInput?.catalog_surface ||
      normalizedSearchInput?.catalogSurface ||
      metadata?.catalog_surface ||
      metadata?.catalogSurface ||
      '',
  )
    .trim()
    .toLowerCase();
  const explicitStrictCatalogSurface = ['agent_api', 'acp', 'ucp'].includes(requestedCatalogSurface);
  const normalizedSource = String(metadata?.source || normalizedSearchInput?.source || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');
  const strictQueryOwnerSourceEligible = ['shopping-agent', 'aurora-bff'].includes(normalizedSource);
  const strictQueryOwnerDecision = latestUserQuery
    ? strictFindProductsMultiRuntime.getStrictFindProductsMultiConstraintDecision({
        search: {
          ...normalizedSearchInput,
          query: latestUserQuery,
        },
        metadata,
      })
    : {
        enabled: false,
        catalogSurface: null,
        strictConstraintQuery: false,
        strictConstraintReason: null,
      };
  const preserveStrictQueryOwner =
    Boolean(strictQueryOwnerDecision.enabled) &&
    (explicitStrictCatalogSurface || strictQueryOwnerSourceEligible);
  let semanticContract = normalizeSearchSemanticContract(
    search?.semantic_contract ||
      search?.semanticContract ||
      metadata?.semantic_contract ||
      metadata?.semanticContract,
  );
  const allowDerivedBeautySemanticContract =
    !semanticContract &&
    Boolean(latestUserQuery) &&
    (
      !normalizedSource ||
      normalizedSource === 'aurora-bff' ||
      requestedCatalogSurface === 'beauty' ||
      explicitStrictCatalogSurface ||
      Boolean(strictQueryOwnerDecision.enabled)
    );
  if (allowDerivedBeautySemanticContract) {
    const derivedBeautySemanticContract = buildBeautyDiscoverySemanticContract({
      rawQuery: latestUserQuery,
      search: normalizedSearchInput,
      metadata,
    });
    if (derivedBeautySemanticContract) {
      semanticContract = derivedBeautySemanticContract;
    }
  }
  const semanticContractIsBeautyDiscovery = isBeautyDiscoverySemanticContract(semanticContract);
  const strictOwnerCatalogSurface = preserveStrictQueryOwner
    ? String(strictQueryOwnerDecision.catalogSurface || 'agent_api').trim().toLowerCase() || 'agent_api'
    : '';
  const effectiveCatalogSurface =
    strictOwnerCatalogSurface ||
    String(
      search?.catalog_surface ||
        search?.catalogSurface ||
        topLevelSearchCompat?.catalog_surface ||
        '',
    ).trim().toLowerCase() || (semanticContractIsBeautyDiscovery ? 'beauty' : '');
  const effectiveCommerceSurface =
    strictOwnerCatalogSurface ||
    String(search?.commerce_surface || search?.commerceSurface || '').trim().toLowerCase() ||
    effectiveCatalogSurface;
  const effectiveTargetStepFamily =
    String(search?.target_step_family || search?.targetStepFamily || '').trim() ||
    String(semanticContract?.target_step_family || '').trim();
  const effectiveSemanticFamily =
    String(search?.semantic_family || search?.semanticFamily || '').trim() ||
    String(semanticContract?.semantic_family || '').trim();
  const semanticRewriteTimeoutMs = resolveSemanticRewriteTimeoutMs(semanticContract);
  const resolveIntentLlmExecutionPlan =
    typeof intentLlmDebug.resolveIntentLlmExecutionPlan === 'function'
      ? intentLlmDebug.resolveIntentLlmExecutionPlan
      : null;
  const intentExecutionPlan = resolveIntentLlmExecutionPlan
    ? resolveIntentLlmExecutionPlan({ semanticContract })
    : null;
  const strictSemanticRewritePath =
    !preserveStrictQueryOwner && shouldUseSemanticContractQueryOwner(semanticContract);
  const buildSemanticRewritePlanMeta = (fallbackReason = null) => ({
    enable_owner:
      String(intentExecutionPlan?.enableOwner || '').trim() || null,
    provider_owner:
      String(intentExecutionPlan?.providerOwner || '').trim() || null,
    fallback_owner:
      String(intentExecutionPlan?.fallbackOwner || '').trim() || null,
    llm_provider_chain: Array.isArray(intentExecutionPlan?.providerChain)
      ? intentExecutionPlan.providerChain
      : [],
    llm_primary_provider:
      String(intentExecutionPlan?.primaryProvider || '').trim() || null,
    llm_fallback_provider:
      String(intentExecutionPlan?.fallbackProvider || '').trim() || null,
    llm_model: String(intentExecutionPlan?.primaryModel || '').trim() || null,
    llm_model_owner:
      String(intentExecutionPlan?.primaryModelOwner || '').trim() || null,
    single_provider_locked: Boolean(intentExecutionPlan?.singleProviderLocked),
    fallback_reason: String(fallbackReason || '').trim() || null,
  });

  const intentStartedAt = Date.now();
  let semanticRewriteTimer = null;
  const semanticRewriteAbort =
    semanticRewriteTimeoutMs > 0 && typeof AbortController === 'function'
      ? new AbortController()
      : null;
  let intentWithMeta = null;
  let semanticRewriteWithMeta = null;
  if (strictSemanticRewritePath) {
    intentWithMeta = buildDeterministicIntentWithMeta(
      latestUserQuery,
      recentQueries,
      recentMessages,
      'semantic_contract_owner',
    );
    semanticRewriteWithMeta = {
      rewrite: null,
      meta: {
        applied: true,
        mode: 'deterministic_contract',
        provider: 'rule_based',
        ...buildSemanticRewritePlanMeta(null),
        llm_enrichment_attempted: false,
        llm_enrichment_applied: false,
        llm_enrichment_status: 'skipped_strict_contract_owner',
        llm_enrichment_mode: null,
      },
    };
  } else {
    intentWithMeta =
      semanticRewriteTimeoutMs <= 0
        ? buildDeterministicIntentWithMeta(
            latestUserQuery,
            recentQueries,
            recentMessages,
            'semantic_rewrite_skipped_exact_lookup',
          )
        : await Promise.race([
            extractIntentWithMeta(latestUserQuery, recentQueries, recentMessages, {
              timeoutMs: semanticRewriteTimeoutMs,
              signal: semanticRewriteAbort?.signal || null,
              semanticContract,
            }),
            new Promise((resolve) => {
              semanticRewriteTimer = setTimeout(() => {
                if (semanticRewriteAbort) semanticRewriteAbort.abort();
                const fallback = buildDeterministicIntentWithMeta(
                  latestUserQuery,
                  recentQueries,
                  recentMessages,
                  'semantic_rewrite_timeout',
                );
                fallback.meta = {
                  ...(fallback.meta || {}),
                  ...buildSemanticRewritePlanMeta('semantic_rewrite_timeout'),
                };
                resolve(fallback);
              }, semanticRewriteTimeoutMs);
            }),
          ]);
  }
  if (semanticRewriteTimer) clearTimeout(semanticRewriteTimer);
  const intent = intentWithMeta?.intent || null;
  const intentMeta = isPlainObject(intentWithMeta?.meta) ? intentWithMeta.meta : null;
  const semanticRewriteMeta = strictSemanticRewritePath
    ? isPlainObject(semanticRewriteWithMeta?.meta)
      ? semanticRewriteWithMeta.meta
      : null
    : intentMeta;
  const semanticRewriteOutput = strictSemanticRewritePath
    ? isPlainObject(semanticRewriteWithMeta?.rewrite)
      ? semanticRewriteWithMeta.rewrite
      : null
    : null;
  const effectiveSemanticRewriteTimeoutMs = strictSemanticRewritePath ? 0 : semanticRewriteTimeoutMs;
  const intentParseLatencyMs = Math.max(0, Date.now() - intentStartedAt);
  const pruned = pruneRecentQueries(latestUserQuery, recentQueries, intent);
  const brandDetection = detectBrandEntities(latestUserQuery, { candidateProducts: [] });
  const brandQueryDetected = Boolean(brandDetection?.brand_like);
  const brandEntities = Array.isArray(brandDetection?.brands) ? brandDetection.brands : [];
  const explicitCategoryHint = hasExplicitCategoryHint(latestUserQuery, intent);
  const brandQueryWithoutCategory = brandQueryDetected && !explicitCategoryHint;
  const brandScope = brandQueryDetected
    ? brandQueryWithoutCategory
      ? 'broad'
      : 'category_scoped'
    : null;
  const brandQueryVariants = brandQueryWithoutCategory
    ? buildBrandQueryVariants(latestUserQuery, brandEntities)
    : [];

  const normalizeExpansionMode = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'none' || raw === 'disabled') return 'off';
    if (raw === 'aggressive') return 'aggressive';
    return 'conservative';
  };
  const requestedExpansionMode = normalizeExpansionMode(
    metadata?.expansion_mode ||
      payload?.search?.expansion_mode ||
      payload?.search?.expansionMode ||
      payload?.expansion_mode ||
      payload?.expansionMode,
  );
  let queryClass = inferQueryClassFromIntentAndQuery(intent, latestUserQuery);
  if (semanticContract?.request_class === 'exact_lookup') {
    queryClass = 'lookup';
  }
  if (
    brandQueryWithoutCategory &&
    (!queryClass || ['lookup', 'attribute'].includes(String(queryClass || '')))
  ) {
    queryClass = 'exploratory';
  }
  const ambiguityScorePre = computeAmbiguityScorePre(intent, queryClass);
  const associationPlan = SEARCH_SCENARIO_ASSOCIATION_ENABLED
    ? buildScenarioAssociationPlan({
        query: latestUserQuery,
        intent,
        queryClass,
      })
    : {
        applied: false,
        blocked_reason: 'association_disabled',
        domain_key: null,
        scenario_key: null,
        category_keywords: [],
      };
  const associationTerms = Array.isArray(associationPlan?.category_keywords)
    ? associationPlan.category_keywords
    : [];
  const rewriteDriftRisk = estimateRewriteDriftRisk(latestUserQuery, associationTerms);
  const aggressiveGatePassed = shouldUseAggressiveRewrite({
    expansionMode: requestedExpansionMode,
    intent,
    queryClass,
    driftRisk: rewriteDriftRisk,
    associationPlan,
  });
  let rewriteBlockedReason = null;
  if (requestedExpansionMode === 'aggressive' && !aggressiveGatePassed) {
    if (!SEARCH_AGGRESSIVE_REWRITE_ENABLED) rewriteBlockedReason = 'aggressive_flag_disabled';
    else if (!['mission', 'scenario', 'gift'].includes(queryClass)) {
      rewriteBlockedReason = 'query_class_not_supported';
    } else if (clamp01(intent?.confidence?.overall) < 0.75) {
      rewriteBlockedReason = 'low_overall_confidence';
    } else if (clamp01(intent?.confidence?.domain) < 0.65) {
      rewriteBlockedReason = 'low_domain_confidence';
    } else if (clamp01(rewriteDriftRisk) > 0.3) {
      rewriteBlockedReason = 'rewrite_drift_risk_high';
    } else if (!associationPlan?.applied) {
      rewriteBlockedReason = String(associationPlan?.blocked_reason || 'association_plan_unavailable');
    } else {
      rewriteBlockedReason = 'aggressive_gate_blocked';
    }
  }
  const baseExpansionMode = requestedExpansionMode === 'off' ? 'off' : 'conservative';
  const rewriteGate = {
    requested_mode: requestedExpansionMode,
    mode:
      requestedExpansionMode === 'off'
        ? 'off'
        : aggressiveGatePassed
          ? 'aggressive'
          : 'conservative',
    blocked_reason: rewriteBlockedReason,
    rewrite_drift_risk: clamp01(rewriteDriftRisk),
    use_association_only: Boolean(aggressiveGatePassed),
  };
  const semanticRewriteResult = buildStrictSemanticRewriteResult({
    rawQuery: latestUserQuery,
    rewriteMeta: semanticRewriteMeta,
    rewriteOutput: semanticRewriteOutput,
    semanticContract,
    ambiguityScorePre,
  });
  semanticRewriteResult.latency_ms = strictSemanticRewritePath ? 0 : intentParseLatencyMs;
  const semanticOwnerLocked = shouldUseSemanticContractQueryOwner(semanticContract);
  const semanticOwnerLockedEffective = preserveStrictQueryOwner ? false : semanticOwnerLocked;
  const adjustedSemanticContract = preserveStrictQueryOwner ? null : semanticContract;

  const expandedQuery = (() => {
    const q = latestUserQuery;
    if (!q) return q;
    const expansionMode = baseExpansionMode;
    if (expansionMode === 'off') return q;
    const lang = intent?.language || 'en';
    const target = intent?.target_object?.type || 'unknown';
    const scenario = intent?.scenario?.name || 'general';
    const normalizedQueryClass = normalizeQueryClass(queryClass, { defaultValue: null });

    if (
      intent?.primary_domain === 'beauty' &&
      normalizedQueryClass === 'lookup' &&
      scenario !== 'beauty_tools' &&
      scenario !== 'eye_shadow_brush'
    ) {
      return q;
    }

    const extra = [];
    extra.push(...buildAnchorAliasTerms(q, intent, queryClass));
    if (target === 'pet') {
      const wantsHarness = detectHarnessSignal(q);
      const wantsLeash = detectLeashSignal(q);
      const wantsApparel = detectPetApparelSignal(q);
      if (wantsLeash) {
        extra.push('dog leash', 'pet leash', 'lead', 'dog collar', 'dog harness');
        if (expansionMode === 'aggressive') {
          extra.push('training leash', 'hands free leash', 'reflective leash');
        }
      } else if (wantsHarness) {
        extra.push('dog harness', 'dog leash', 'dog collar');
        if (expansionMode === 'aggressive') {
          extra.push('pet harness', 'pet leash');
        }
      }
      if (wantsApparel && expansionMode === 'aggressive') {
        extra.push('dog jacket', 'pet apparel');
      } else if (wantsApparel) {
        extra.push('dog apparel');
      } else if (expansionMode === 'aggressive' && !wantsHarness && !wantsLeash) {
        extra.push('dog jacket', 'pet apparel');
      }
      if (scenario.includes('hiking') && expansionMode === 'aggressive') {
        extra.push('hiking', 'cold weather');
      }
      // Also expand for Chinese queries against English-heavy catalogs.
      if (lang === 'zh') {
        extra.push('dog');
        if (expansionMode === 'aggressive') {
          extra.push('pet');
        }
        if (wantsLeash) {
          extra.push('leash', 'collar', 'harness');
        } else if (wantsHarness) {
          extra.push('leash');
          if (expansionMode === 'aggressive') {
            extra.push('harness', 'collar');
          }
        } else if (expansionMode === 'aggressive') {
          extra.push('coat');
        }
      }
      if (lang === 'es') {
        extra.push('perro');
        if (wantsLeash) extra.push('correa');
        if (expansionMode === 'aggressive' && !wantsHarness && !wantsLeash) extra.push('ropa');
      }
      if (lang === 'fr') {
        extra.push('chien');
        if (wantsLeash) extra.push('laisse');
        if (expansionMode === 'aggressive' && !wantsHarness && !wantsLeash) extra.push('vêtement');
      }
      if (lang === 'ja') {
        extra.push('犬');
        if (wantsLeash) extra.push('リード');
        if (expansionMode === 'aggressive' && !wantsHarness && !wantsLeash) extra.push('犬服');
      }
	    } else if (target === 'human' && intent?.primary_domain === 'human_apparel') {
      const requiredCats = Array.isArray(intent?.category?.required) ? intent.category.required : [];
      const isLingerie = requiredCats.includes('lingerie') || requiredCats.includes('underwear') || scenario === 'lingerie';
      const isSexy =
        scenario === 'sexy_outfit' ||
        /\bsexy\b/i.test(q) ||
        /性感/.test(q) ||
        /セクシー/.test(q);
      const isSleepwear =
        scenario === 'sleepwear' ||
        requiredCats.includes('sleepwear') ||
        requiredCats.includes('pajamas');
      const isWomenClothing = scenario === 'women_clothing' || requiredCats.includes('apparel');
      const isOuterwear =
        requiredCats.includes('outerwear') ||
        requiredCats.includes('coat') ||
        requiredCats.includes('down_jacket') ||
        scenario.includes('cold') ||
        scenario.includes('mountain');

      if (isLingerie) {
        extra.push('lingerie', 'underwear', 'bra', 'panties');
        if (lang === 'es') extra.push('lenceria', 'ropa interior');
        if (lang === 'fr') extra.push('lingerie', 'sous vetement');
        if (lang === 'ja') extra.push('下着', 'ランジェリー');
        if (lang === 'zh') extra.push('lingerie', 'underwear');
      } else if (isSexy) {
        // Avoid pulling pet coats via generic "coat/jacket" expansions.
        // "Sexy clothes" commonly maps to lingerie, party dresses, nightwear.
        extra.push('sexy', 'lingerie', 'party dress', 'bodycon', 'nightwear');
        if (lang === 'es') extra.push('sexy', 'lenceria', 'vestido');
        if (lang === 'fr') extra.push('sexy', 'lingerie', 'robe');
        if (lang === 'ja') extra.push('セクシー', '下着', 'ドレス');
        if (lang === 'zh') extra.push('sexy', 'lingerie', 'dress');
      } else if (isSleepwear) {
        extra.push('sleepwear', 'pajamas', 'loungewear');
        if (lang === 'es') extra.push('pijama', 'ropa de dormir');
        if (lang === 'fr') extra.push('pyjama', 'vetement de nuit');
        if (lang === 'ja') extra.push('パジャマ', 'ルームウェア');
        if (lang === 'zh') extra.push('sleepwear', 'pajama');
      } else if (isOuterwear) {
        extra.push('coat', 'jacket', 'outerwear');
        if (scenario.includes('cold') || scenario.includes('mountain')) extra.push('down jacket', 'winter');
        if (lang === 'es') extra.push('abrigo', 'chaqueta');
        if (lang === 'fr') extra.push('manteau', 'veste');
        if (lang === 'zh') extra.push('coat', 'jacket');
      } else if (isWomenClothing) {
        extra.push('women clothing', 'dress', 'top', 'skirt', 'outfit');
        if (lang === 'es') extra.push('ropa mujer', 'vestido', 'falda');
        if (lang === 'fr') extra.push('vetement femme', 'robe', 'jupe');
        if (lang === 'ja') extra.push('レディース', '服', 'ワンピース');
        if (lang === 'zh') extra.push('women', 'dress');
      } else {
        // Generic human apparel: keep expansions lightweight and avoid category over-commit.
        extra.push('outfit');
        if (expansionMode === 'aggressive') extra.push('dress');
        if (lang === 'es') extra.push('ropa', 'vestido');
        if (lang === 'fr') extra.push('tenue', 'robe');
        if (lang === 'ja') extra.push('服', 'コーデ');
      }
	    } else if (intent?.primary_domain === 'toy_accessory') {
	      extra.push('labubu', 'doll clothes', 'outfit');
	    }

	    if (intent?.primary_domain === 'beauty' && scenario === 'eye_shadow_brush') {
	      extra.push(
	        'eyeshadow brush',
	        'eye brush',
	        'blending brush',
	        'crease brush',
	        'pencil brush',
	        'smudger',
	        'eyeliner brush',
	      );
	      if (lang === 'zh') extra.push('眼影刷', '晕染刷', '铺色刷', '眼线刷', '下眼睑刷');
	      if (lang === 'es') extra.push('pincel de sombra', 'pincel difuminador', 'pincel delineador');
	      if (lang === 'fr') extra.push('pinceau fard à paupières', 'pinceau estompeur', 'pinceau eye-liner');
	      if (lang === 'ja') extra.push('アイシャドウブラシ', 'ブレンディングブラシ', 'アイライナーブラシ', '下まぶた');
	      } else if (intent?.primary_domain === 'beauty' && scenario === 'beauty_tools') {
	      if (expansionMode === 'aggressive') {
	        extra.push(
	          'makeup tools',
	          'cosmetic tools',
	          'makeup brush',
	          'brush set',
	          'foundation brush',
	          'powder brush',
	          'makeup sponge',
	          'powder puff',
	        );
	        if (lang === 'zh') extra.push('化妆刷', '粉底刷', '散粉刷', '美妆蛋', '粉扑', '刷具套装');
	        if (lang === 'es') extra.push('brochas', 'esponja de maquillaje', 'borla');
	        if (lang === 'fr') extra.push('pinceaux', 'éponge maquillage', 'houppette');
	        if (lang === 'ja') extra.push('メイクブラシ', 'ブラシセット', 'メイクスポンジ', 'パフ');
	      } else {
	        extra.push('makeup tools', 'makeup brush', 'foundation brush', 'powder brush');
	        if (lang === 'zh') extra.push('化妆刷', '粉底刷');
	        if (lang === 'es') extra.push('brochas');
	        if (lang === 'fr') extra.push('pinceaux');
	        if (lang === 'ja') extra.push('メイクブラシ');
	      }
      } else if (intent?.primary_domain === 'beauty') {
      const fragranceQueryDetected = hasFragranceQuerySignal(q);
	      const wantsSkincare =
	        /护肤|護膚|skincare|skin\s*care|serum|toner|essence|moisturizer|cleanser|sunscreen|cream/i.test(
	          q,
	        );
        const wantsSunscreen =
          /\b(sunscreen|spf\b|sunblock|broad spectrum|uv)\b/i.test(q) ||
          /防晒|防曬|日焼け止め/.test(q);
        const wantsMoisturizer =
          /\b(moisturi(?:z|s)er|cream|face moisturizer|barrier moisturizer|barrier cream)\b/i.test(q) ||
          /保湿|保濕|乳液|面霜|クリーム/.test(q);
        const wantsSerum =
          /\b(serum|essence|ampoule|niacinamide|retinol|vitamin c|peptide|ceramide|cica|hyaluronic|salicylic|azelaic|aha|bha)\b/i.test(
            q,
          ) || /精华|精華|美容液/.test(q);
        const wantsToner =
          /\b(toner|lotion|face mist)\b/i.test(q) || /化妆水|化妝水/.test(q);
        const wantsCleanser =
          /\b(cleanser|face wash|cleansing)\b/i.test(q) || /洁面|潔面|洗面奶|洗顔料/.test(q);
	      const wantsDateLook = /约会|約會|\bdate\b|\bnight\s*out\b/i.test(q);
      if (fragranceQueryDetected) {
        extra.push(
          'fragrance',
          'perfume',
          'parfum',
          'cologne',
          'eau de parfum',
          'eau de toilette',
          'body mist',
        );
        if (lang === 'zh') extra.push('香水', '香氛');
        if (lang === 'es') extra.push('fragancia', 'perfume');
        if (lang === 'fr') extra.push('parfum', 'fragrance');
        if (lang === 'ja') extra.push('香水', 'フレグランス');
      } else if (!brandQueryWithoutCategory && wantsSkincare) {
        extra.push('skincare');
        if (wantsSunscreen) {
          extra.push('face sunscreen', 'spf', 'broad spectrum', 'sun protection');
          if (lang === 'zh') extra.push('护肤', '防晒', '面部防晒');
          if (lang === 'es') extra.push('cuidado de la piel', 'protector solar', 'spf');
          if (lang === 'fr') extra.push('soin de la peau', 'crème solaire', 'spf');
          if (lang === 'ja') extra.push('スキンケア', '日焼け止め', '顔用日焼け止め');
        } else if (wantsMoisturizer) {
          extra.push('face moisturizer', 'barrier moisturizer', 'barrier cream', 'cream');
          if (lang === 'zh') extra.push('护肤', '保湿', '乳液', '面霜', '屏障面霜');
          if (lang === 'es') extra.push('cuidado de la piel', 'hidratante facial', 'crema barrera');
          if (lang === 'fr') extra.push('soin de la peau', 'hydratant visage', 'crème barrière');
          if (lang === 'ja') extra.push('スキンケア', '保湿', '乳液', 'クリーム');
        } else if (wantsSerum) {
          extra.push('serum', 'treatment serum', 'face serum');
          if (lang === 'zh') extra.push('护肤', '精华', '面部精华');
          if (lang === 'es') extra.push('cuidado de la piel', 'suero', 'sérum facial');
          if (lang === 'fr') extra.push('soin de la peau', 'sérum', 'sérum visage');
          if (lang === 'ja') extra.push('スキンケア', '美容液', 'フェイスセラム');
        } else if (wantsToner) {
          extra.push('toner', 'face toner', 'lotion');
          if (lang === 'zh') extra.push('护肤', '化妆水');
          if (lang === 'es') extra.push('cuidado de la piel', 'tónico');
          if (lang === 'fr') extra.push('soin de la peau', 'tonique');
          if (lang === 'ja') extra.push('スキンケア', '化粧水');
        } else if (wantsCleanser) {
          extra.push('cleanser', 'face wash', 'gentle cleanser');
          if (lang === 'zh') extra.push('护肤', '洁面', '洗面奶');
          if (lang === 'es') extra.push('cuidado de la piel', 'limpiador', 'limpiador facial');
          if (lang === 'fr') extra.push('soin de la peau', 'nettoyant', 'nettoyant visage');
          if (lang === 'ja') extra.push('スキンケア', '洗顔料');
        } else {
          extra.push('serum', 'toner', 'moisturizer', 'sunscreen', 'cleanser');
          if (lang === 'zh') extra.push('护肤', '精华', '化妆水', '乳液', '面霜', '防晒');
          if (lang === 'es') extra.push('cuidado de la piel', 'suero', 'tónico', 'hidratante');
          if (lang === 'fr') extra.push('soin de la peau', 'sérum', 'tonique', 'hydratant');
          if (lang === 'ja') extra.push('スキンケア', '美容液', '化粧水', '乳液');
        }
	      } else if (!brandQueryWithoutCategory) {
	        extra.push('makeup', 'foundation', 'concealer', 'mascara', 'lipstick');
	        if (wantsDateLook) extra.push('date makeup', 'longwear', 'natural glow');
	        if (lang === 'zh') extra.push('彩妆', '底妆', '眼妆', '唇妆');
	        if (lang === 'es') extra.push('maquillaje', 'base', 'máscara', 'labial');
	        if (lang === 'fr') extra.push('maquillage', 'fond de teint', 'mascara', 'rouge à lèvres');
	        if (lang === 'ja') extra.push('メイク', 'ファンデーション', 'マスカラ', 'リップ');
	      }
	    }

    if (!extra.length) return q;
    const dedupedExtra = Array.from(new Set(extra.map((item) => String(item || '').trim()).filter(Boolean)));
    const combined = `${q} ${dedupedExtra.join(' ')}`.trim();
    const maxCombinedLength = expansionMode === 'aggressive' ? 240 : 160;
    return combined.length > maxCombinedLength ? combined.slice(0, maxCombinedLength).trim() : combined;
  })();

  const expandedWithAssociation = (() => {
    if (!aggressiveGatePassed || !associationTerms.length) return expandedQuery;
    const rawParts = [expandedQuery, ...associationTerms]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (!rawParts.length) return expandedQuery;
    const deduped = Array.from(new Set(rawParts.join(' ').split(/\s+/).map((token) => token.trim()).filter(Boolean)));
    const candidate = deduped.join(' ').trim();
    const maxCombinedLength = 240;
    return candidate.length > maxCombinedLength ? candidate.slice(0, maxCombinedLength).trim() : candidate;
  })();

  const effectiveExpandedQuery = preserveStrictQueryOwner
    ? latestUserQuery
    : semanticOwnerLocked
    ? buildSemanticOwnerSearchQuery({
        semanticRewriteResult,
        fallbackQuery: expandedWithAssociation || latestUserQuery,
      })
    : expandedWithAssociation;

  const adjustedPayload = {
    ...(payload || {}),
    user: {
      ...(payload?.user || {}),
      ...(pruned ? { recent_queries: pruned } : {}),
    },
    search: {
      ...topLevelSearchCompat,
      ...(payload?.search || {}),
      ...(effectiveExpandedQuery ? { query: effectiveExpandedQuery } : {}),
      ...(effectiveCatalogSurface ? { catalog_surface: effectiveCatalogSurface } : {}),
      ...(effectiveCommerceSurface ? { commerce_surface: effectiveCommerceSurface } : {}),
      ...(effectiveTargetStepFamily ? { target_step_family: effectiveTargetStepFamily } : {}),
      ...(effectiveSemanticFamily ? { semantic_family: effectiveSemanticFamily } : {}),
      ...(adjustedSemanticContract ? { semantic_contract: adjustedSemanticContract } : {}),
    },
  };

  const querySemanticClass = inferFragranceSemanticClass(latestUserQuery) || null;
  const expansionMeta = {
    mode: rewriteGate.mode,
    strategy_version: STRATEGY_VERSION,
    raw_query: latestUserQuery,
    expanded_query: effectiveExpandedQuery,
    applied: Boolean(effectiveExpandedQuery && String(effectiveExpandedQuery) !== String(latestUserQuery)),
    query_class: queryClass,
    semantic_contract: adjustedSemanticContract,
    semantic_rewrite_result: semanticRewriteResult,
    semantic_owner:
      !preserveStrictQueryOwner && semanticRewriteResult.applied ? semanticRewriteResult.owner : null,
    semantic_owner_locked: semanticOwnerLockedEffective,
    semantic_rewrite_timeout_ms: effectiveSemanticRewriteTimeoutMs,
    intent_parse_latency_ms: intentParseLatencyMs,
    rewrite_gate: rewriteGate,
    association_plan: associationPlan,
    ambiguity_score_pre: ambiguityScorePre,
    query_semantic_class: querySemanticClass,
    brand_query_detected: brandQueryDetected,
    brand_entities: brandEntities,
    brand_detection_mode: brandDetection?.detection_mode || null,
    brand_query_without_category: brandQueryWithoutCategory,
    brand_scope: brandScope,
    brand_query_variants: brandQueryVariants,
    external_fill_gated: SEARCH_EXTERNAL_FILL_GATED,
    flags_snapshot: {
      search_domain_hard_filter_mode: SEARCH_DOMAIN_HARD_FILTER_MODE,
      search_clarify_min_recall_candidates: SEARCH_CLARIFY_MIN_RECALL_CANDIDATES,
      search_clarify_min_anchor_ratio: SEARCH_CLARIFY_MIN_ANCHOR_RATIO,
      search_clarify_max_domain_entropy: SEARCH_CLARIFY_MAX_DOMAIN_ENTROPY,
      search_scenario_anchor_mode: SEARCH_SCENARIO_ANCHOR_MODE,
      search_scenario_derived_min_recall_candidates: SEARCH_SCENARIO_DERIVED_MIN_RECALL_CANDIDATES,
      search_scenario_derived_min_anchor_ratio: SEARCH_SCENARIO_DERIVED_MIN_ANCHOR_RATIO,
      search_scenario_derived_max_domain_entropy: SEARCH_SCENARIO_DERIVED_MAX_DOMAIN_ENTROPY,
      search_domain_condenser_enabled: SEARCH_DOMAIN_CONDENSER_ENABLED,
      search_domain_condenser_entropy_th: SEARCH_DOMAIN_CONDENSER_ENTROPY_TH,
      search_domain_condenser_min_cands_before: SEARCH_DOMAIN_CONDENSER_MIN_CANDS_BEFORE,
      search_domain_condenser_min_cands_after: SEARCH_DOMAIN_CONDENSER_MIN_CANDS_AFTER,
      search_anchor_alias_v2: SEARCH_ANCHOR_ALIAS_V2,
    },
  };

  return { intent, adjustedPayload, rawUserQuery: latestUserQuery, expansion_meta: expansionMeta };
}

function applyFindProductsMultiPolicy({ response, intent, requestPayload, metadata, rawUserQuery }) {
  const gateTrace = [];
  const pushGateTrace = (gateId, applied, decision, reason, costMsEstimate, queryClassValue = null) => {
    gateTrace.push({
      gate_id: gateId,
      applied: Boolean(applied),
      decision: String(decision || 'pass'),
      reason: reason ? String(reason) : null,
      cost_ms_estimate: Math.max(0, Number(costMsEstimate || 0) || 0),
      query_class: queryClassValue ? String(queryClassValue) : null,
    });
  };
  const { key, list } = getResponseProductList(response);
  const before = Array.isArray(list) ? list.length : 0;
  const rawQuery =
    String(rawUserQuery || '').trim() ||
    String(requestPayload?.search?.query || '').trim() ||
    '';
  const semanticContract = normalizeSearchSemanticContract(
    requestPayload?.search?.semantic_contract ||
      requestPayload?.search?.semanticContract ||
      metadata?.semantic_contract ||
      metadata?.semanticContract,
  );
  const beautyDiscoveryMainline = isBeautyDiscoverySemanticContract(semanticContract);
  const metadataBrandEntities = Array.isArray(metadata?.brand_entities)
    ? metadata.brand_entities.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const metadataBrandDetected = Boolean(metadata?.brand_query_detected);
  const metadataBrandWithoutCategory = Boolean(metadata?.brand_query_without_category);
  const categoryHintDetected = hasExplicitCategoryHint(rawQuery, intent);
  const detectedBrandEntities = detectBrandEntities(rawQuery, {
    candidateProducts: Array.isArray(list) ? list : [],
  });
  const brandQueryDetected = Boolean(
    metadataBrandDetected || metadataBrandWithoutCategory || detectedBrandEntities?.brand_like,
  );
  const brandEntities = Array.from(
    new Set(
      [
        ...metadataBrandEntities,
        ...(Array.isArray(detectedBrandEntities?.brands) ? detectedBrandEntities.brands : []),
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
  const brandScope = brandQueryDetected
    ? metadata?.brand_scope || (categoryHintDetected ? 'category_scoped' : 'broad')
    : null;
  const metadataQueryClass = normalizeQueryClass(
    metadata?.query_class ??
      metadata?.queryClass ??
      metadata?.search_decision?.query_class ??
      metadata?.searchDecision?.queryClass,
    { defaultValue: null },
  );
  let queryClass = metadataQueryClass || inferQueryClassFromIntentAndQuery(intent, rawQuery);
  if (
    brandQueryDetected &&
    !categoryHintDetected &&
    !['mission', 'scenario', 'gift', 'non_shopping'].includes(String(queryClass || ''))
  ) {
    queryClass = 'exploratory';
  }

  const filteredResult = filterProductsByIntent(list, intent, { rawQuery });
  let { filtered, reason_codes: filterReasonCodes } = filteredResult;

  // Tool-first: for beauty tools queries, assemble 3 kits and reorder products accordingly.
  const toolRec = recommendToolKits({ rawQuery, intent, products: filtered });
  if (toolRec && Array.isArray(toolRec.ordered_product_ids) && toolRec.ordered_product_ids.length > 0) {
    const byId = new Map();
    for (const p of filtered) {
      const pid = String(p?.id || p?.product_id || p?.productId || '');
      if (!pid) continue;
      if (!byId.has(pid)) byId.set(pid, p);
    }

    const ordered = [];
    const seen = new Set();
    for (const pid of toolRec.ordered_product_ids) {
      const p = byId.get(String(pid));
      if (!p) continue;
      const k = String(pid);
      if (seen.has(k)) continue;
      seen.add(k);
      ordered.push(p);
    }
    for (const p of filtered) {
      const pid = String(p?.id || p?.product_id || p?.productId || '');
      if (pid && seen.has(pid)) continue;
      ordered.push(p);
    }
    filtered = ordered;
  }

  // If we couldn't reliably match beauty tools, avoid showing unrelated products.
  // We still keep toolRec so the agent can provide a tool-first template reply.
  if (
    intent?.primary_domain === 'beauty' &&
    intent?.scenario?.name === 'beauty_tools' &&
    toolRec?.stats &&
    String(toolRec.stats.match_tier || '') === 'none' &&
    Number(toolRec.stats.tool_candidates_count || 0) === 0
  ) {
    // Keep recall for downstream rerank/clarify instead of hard-empty.
    filtered = Array.isArray(filtered) ? filtered : [];
  }

  const metadataSemanticClass = String(
    metadata?.query_semantic_class ??
      metadata?.querySemanticClass ??
      metadata?.search_decision?.query_semantic_class ??
      metadata?.searchDecision?.querySemanticClass ??
      '',
  )
    .trim()
    .toLowerCase();
  const querySemanticClass = metadataSemanticClass || inferFragranceSemanticClass(rawQuery) || null;

  const skipConstraintReorder =
    intent?.primary_domain === 'beauty' &&
    (intent?.scenario?.name === 'beauty_tools' || intent?.scenario?.name === 'eye_shadow_brush');
  if (!skipConstraintReorder) {
    filtered = reorderProductsForConstraints(filtered, intent, rawQuery);
  }
  const fashionConstraintState = buildFashionConstraintState(rawQuery, metadata);
  const fashionConstraintBefore = filtered.length;
  filtered = filterProductsByFashionConstraints(filtered, fashionConstraintState);
  const fashionConstraintDropped =
    Boolean(fashionConstraintState?.hasFashionConstraintSignal) && filtered.length < fashionConstraintBefore;
  const preDomainFilterCandidates = Array.isArray(filtered) ? filtered.slice() : [];
  const domainFilterResult = applyDomainHardFilter(filtered, intent, rawQuery, {
    brandQueryDetected,
    brandTerms: brandEntities,
    querySemanticClass,
  });
  filtered = Array.isArray(domainFilterResult.products) ? domainFilterResult.products : [];
  pushGateTrace(
    'domain_hard_filter',
    Boolean(domainFilterResult?.applied),
    Number(domainFilterResult?.dropped || 0) > 0 ? 'filtered' : 'pass',
    Number(domainFilterResult?.dropped || 0) > 0 ? 'domain_filtered' : null,
    90,
    queryClass,
  );
  let diversityDebug = null;
  if (shouldApplyBeautyDiversity(intent, rawQuery, queryClass) && !brandQueryDetected) {
    const diversityResult = applyBeautyDiversityPolicy(filtered, {
      topN: BEAUTY_DIVERSITY_TOPN,
      minBuckets: BEAUTY_DIVERSITY_MIN_BUCKETS,
      toolsMaxRatio: BEAUTY_DIVERSITY_TOOLS_MAX_RATIO,
      strictEmptyOnFailure: false,
      preservePrimaryOnFailure: true,
    });
    filtered = Array.isArray(diversityResult.products) ? diversityResult.products : [];
    diversityDebug = diversityResult.debug || null;

    const enforceNonToolMinimum =
      intent?.primary_domain === 'beauty' &&
      intent?.scenario?.name === 'general' &&
      !isBeautyToolAnchoredQuery(rawQuery);
    if (enforceNonToolMinimum && diversityDebug) {
      const mix = diversityDebug.category_mix_topN && typeof diversityDebug.category_mix_topN === 'object'
        ? diversityDebug.category_mix_topN
        : {};
      const nonToolDistinctBuckets = ['base_makeup', 'eye_makeup', 'lip_makeup', 'skincare'].filter(
        (bucket) => Number(mix[bucket] || 0) > 0,
      ).length;
      if (nonToolDistinctBuckets < 2) {
        const isFragranceFlow = querySemanticClass === 'fragrance';
        if (!isFragranceFlow) {
          filtered = [];
        }
        diversityDebug = {
          ...diversityDebug,
          reason: isFragranceFlow
            ? 'beauty_non_tool_min_not_met_fragrance_exempt'
            : 'beauty_non_tool_min_not_met',
          strict_empty: !isFragranceFlow,
          requirement_unmet: true,
          preserve_primary_on_failure: isFragranceFlow,
          required_non_tool_buckets: 2,
          non_tool_distinct_buckets: nonToolDistinctBuckets,
          fragrance_exempt: Boolean(isFragranceFlow),
        };
      }
    }
  }
  let after = filtered.length;
  const associationPlanFromMeta =
    metadata?.association_plan && typeof metadata.association_plan === 'object'
      ? metadata.association_plan
      : null;
  const requestContext =
    requestPayload?.context && typeof requestPayload.context === 'object'
      ? requestPayload.context
      : null;
  const slotStateFromContext =
    requestContext &&
    (Array.isArray(requestContext.asked_slots) ||
      (requestContext.resolved_slots && typeof requestContext.resolved_slots === 'object'))
      ? {
          asked_slots: Array.isArray(requestContext.asked_slots)
            ? requestContext.asked_slots
                .map((value) => String(value || '').trim())
                .filter(Boolean)
            : [],
          resolved_slots:
            requestContext.resolved_slots && typeof requestContext.resolved_slots === 'object'
              ? Object.fromEntries(
                  Object.entries(requestContext.resolved_slots)
                    .map(([key, value]) => [String(key || '').trim(), value])
                    .filter(([key, value]) => key && String(value || '').trim()),
                )
              : {},
        }
      : null;
  const slotStateFromMeta =
    metadata?.slot_state && typeof metadata.slot_state === 'object'
      ? metadata.slot_state
      : metadata?.search_trace?.slot_state &&
          typeof metadata.search_trace.slot_state === 'object'
        ? metadata.search_trace.slot_state
        : metadata?.search_decision?.slot_state &&
            typeof metadata.search_decision.slot_state === 'object'
          ? metadata.search_decision.slot_state
          : null;
  const slotState = {
    asked_slots: Array.from(
      new Set(
        [
          ...(Array.isArray(slotStateFromContext?.asked_slots) ? slotStateFromContext.asked_slots : []),
          ...(Array.isArray(slotStateFromMeta?.asked_slots) ? slotStateFromMeta.asked_slots : []),
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ),
    resolved_slots: {
      ...(slotStateFromContext?.resolved_slots && typeof slotStateFromContext.resolved_slots === 'object'
        ? slotStateFromContext.resolved_slots
        : {}),
      ...(slotStateFromMeta?.resolved_slots && typeof slotStateFromMeta.resolved_slots === 'object'
        ? slotStateFromMeta.resolved_slots
        : {}),
    },
  };
  const hasSlotState =
    slotState.asked_slots.length > 0 || Object.keys(slotState.resolved_slots).length > 0;
  const clarifyBudgetContext =
    requestContext?.clarify_budget && typeof requestContext.clarify_budget === 'object'
      ? requestContext.clarify_budget
      : null;
  const postAnchorBasis = resolvePostAnchorBasis({
    rawQuery,
    intent,
    queryClass,
    associationPlan: associationPlanFromMeta,
  });
  const domainCondenserResult = applyScenarioDomainCondenser({
    products: filtered,
    fallbackProducts: preDomainFilterCandidates,
    intent,
    rawQuery,
    queryClass,
    anchorTokens: postAnchorBasis?.tokens,
    sourceCandidateCount: before,
  });
  const condenserProducts = Array.isArray(domainCondenserResult.products)
    ? domainCondenserResult.products
    : filtered;
  const condenserWouldDrop =
    Array.isArray(condenserProducts) &&
    Array.isArray(filtered) &&
    condenserProducts.length < filtered.length;
  const condenserApplied =
    Boolean(domainCondenserResult?.debug?.applied) &&
    (!FPM_GATE_SIMPLIFY_V1 || !FPM_DOMAIN_CONDENSER_REORDER_ONLY || !condenserWouldDrop);
  if (condenserApplied) {
    filtered = condenserProducts;
  }
  pushGateTrace(
    'domain_condenser',
    Boolean(domainCondenserResult?.debug?.applied),
    condenserApplied ? 'reordered' : 'pass',
    condenserWouldDrop && FPM_GATE_SIMPLIFY_V1 && FPM_DOMAIN_CONDENSER_REORDER_ONLY
      ? 'drop_prevented_reorder_only'
      : domainCondenserResult?.debug?.reason || null,
    120,
    null,
  );
  const beautyBucketFilterResult = applyBeautyBucketBackstop(
    filtered,
    intent,
    rawQuery,
    queryClass,
  );
  filtered = Array.isArray(beautyBucketFilterResult.products)
    ? beautyBucketFilterResult.products
    : filtered;
  pushGateTrace(
    'beauty_bucket_backstop',
    Boolean(beautyBucketFilterResult?.applied),
    Number(beautyBucketFilterResult?.dropped || 0) > 0 ? 'filtered' : 'pass',
    beautyBucketFilterResult?.reason || null,
    40,
    queryClass,
  );
  const scenarioDerivedAnchorActive =
    SEARCH_SCENARIO_ANCHOR_MODE === 'derived' &&
    ['scenario', 'mission'].includes(String(queryClass || ''));
  const ambiguityScorePre = Number.isFinite(Number(metadata?.ambiguity_score_pre))
    ? clamp01(Number(metadata.ambiguity_score_pre))
    : computeAmbiguityScorePre(intent, queryClass);
  const baselineStats = computeMatchStats(filtered, intent, { rawQuery });
  const ambiguityScorePost = computeAmbiguityScorePost({
    ambiguityPre: ambiguityScorePre,
    products: filtered,
    rawQuery,
    intent,
    queryClassInput: queryClass,
    anchorTokens: postAnchorBasis.mode === 'off' ? null : postAnchorBasis.tokens,
    anchorMode: postAnchorBasis.mode,
  });

  const ambiguitySensitiveClass = isAmbiguitySensitiveQueryClass(queryClass);
  const clarifyEligible =
    SEARCH_AMBIGUITY_GATE_ENABLED &&
    SEARCH_CLARIFY_ON_MEDIUM_AMBIGUITY &&
    ambiguitySensitiveClass;
  const intentNeedsClarification = Boolean(intent?.ambiguity?.needs_clarification);
  const ambiguitySignalOnly =
    intentNeedsClarification || queryClass === 'exploratory' || queryClass === 'non_shopping';
  const clarifyIntentGate = ambiguitySignalOnly || ambiguityScorePre > AMBIGUITY_THRESHOLD_CLARIFY;
  const enforcePostQualityGate = clarifyEligible && clarifyIntentGate;
  const hasCategoryHint = Array.isArray(intent?.category?.required) && intent.category.required.length > 0;
  const hasPriceConstraint =
    Number.isFinite(Number(intent?.hard_constraints?.price?.min)) ||
    Number.isFinite(Number(intent?.hard_constraints?.price?.max));
  const hasBrandHint =
    Array.isArray(intent?.soft_preferences?.brands) && intent.soft_preferences.brands.length > 0;
  const hasStructuredHint = hasCategoryHint || hasPriceConstraint || hasBrandHint;
  let effectiveMinRecallCandidates =
    !intentNeedsClarification && hasStructuredHint
      ? Math.min(SEARCH_CLARIFY_MIN_RECALL_CANDIDATES, 1)
      : !intentNeedsClarification && ['scenario', 'mission', 'gift'].includes(queryClass)
        ? Math.min(SEARCH_CLARIFY_MIN_RECALL_CANDIDATES, 3)
        : SEARCH_CLARIFY_MIN_RECALL_CANDIDATES;
  if (scenarioDerivedAnchorActive) {
    effectiveMinRecallCandidates = Math.min(
      effectiveMinRecallCandidates,
      SEARCH_SCENARIO_DERIVED_MIN_RECALL_CANDIDATES,
    );
  }
  if (brandQueryDetected) {
    effectiveMinRecallCandidates = Math.min(effectiveMinRecallCandidates, 2);
  }
  const effectiveMinAnchorRatio = !intentNeedsClarification && hasStructuredHint
    ? 0
    : scenarioDerivedAnchorActive
      ? SEARCH_SCENARIO_DERIVED_MIN_ANCHOR_RATIO
      : SEARCH_CLARIFY_MIN_ANCHOR_RATIO;
  const effectiveMaxDomainEntropy = scenarioDerivedAnchorActive
    ? SEARCH_SCENARIO_DERIVED_MAX_DOMAIN_ENTROPY
    : SEARCH_CLARIFY_MAX_DOMAIN_ENTROPY;
  let postCandidateCount = Array.isArray(filtered) ? filtered.length : 0;
  const anchorRatioPost =
    postAnchorBasis.mode === 'off'
      ? 1
      : computeAnchorRatio(rawQuery, filtered, {
          anchorTokens: postAnchorBasis.tokens,
        });
  const domainEntropyPost = computeDomainEntropy(filtered);
  const postQuality = {
    candidates: postCandidateCount,
    anchor_ratio: anchorRatioPost,
    domain_entropy: domainEntropyPost,
    min_recall_candidates: effectiveMinRecallCandidates,
    min_anchor_ratio: effectiveMinAnchorRatio,
    max_domain_entropy: effectiveMaxDomainEntropy,
    anchor_mode: postAnchorBasis.mode,
    anchor_source: postAnchorBasis.source,
    anchor_basis_size: Array.isArray(postAnchorBasis.tokens) ? postAnchorBasis.tokens.length : 0,
    candidates_ok: postCandidateCount >= effectiveMinRecallCandidates,
    anchor_ok:
      anchorRatioPost >= effectiveMinAnchorRatio ||
      (clamp01(intent?.confidence?.domain) >= 0.75 && domainEntropyPost <= effectiveMaxDomainEntropy),
    entropy_ok: domainEntropyPost <= effectiveMaxDomainEntropy,
  };
  const postQualityOk =
    postQuality.candidates_ok && postQuality.anchor_ok && postQuality.entropy_ok;
  const postQualityHardFail = enforcePostQualityGate && !postQualityOk;
  const postQualityTriggered = postQualityHardFail;
  const lowConfidenceReasons = [];
  if (postQualityHardFail) {
    lowConfidenceReasons.push('post_quality_low_confidence');
  }
  const strictEmptyByAmbiguityBase =
    SEARCH_AMBIGUITY_GATE_ENABLED &&
    ambiguitySensitiveClass &&
    ambiguityScorePre > AMBIGUITY_THRESHOLD_STRICT_EMPTY &&
    ambiguityScorePost > AMBIGUITY_THRESHOLD_STRICT_EMPTY &&
    (!baselineStats.has_good_match || filtered.length === 0);
  const highRiskNonShopping = queryClass === 'non_shopping';
  const strictEmptyByAmbiguityBaseConstrained =
    strictEmptyByAmbiguityBase &&
    (!FPM_GATE_SIMPLIFY_V1 || (before === 0 && postCandidateCount === 0 && highRiskNonShopping));
  const clarifyByAmbiguityBase =
    clarifyEligible &&
    clarifyIntentGate &&
    (postQualityTriggered ||
      postCandidateCount === 0 ||
      (ambiguitySignalOnly && ambiguityScorePost > AMBIGUITY_THRESHOLD_CLARIFY));
  const brandQueryBypassAmbiguity =
    brandQueryDetected &&
    postCandidateCount > 0 &&
    (strictEmptyByAmbiguityBaseConstrained || clarifyByAmbiguityBase);
  const strictEmptyByAmbiguity = false;
  const clarifyByAmbiguity = clarifyByAmbiguityBase && !brandQueryBypassAmbiguity;
  pushGateTrace(
    'ambiguity_gate',
    Boolean(clarifyEligible || strictEmptyByAmbiguityBaseConstrained),
    strictEmptyByAmbiguity ? 'strict_empty' : clarifyByAmbiguity ? 'clarify' : 'pass',
    strictEmptyByAmbiguity
      ? 'ambiguity_strict_empty'
      : clarifyByAmbiguity
        ? 'ambiguity_clarify'
        : null,
    140,
    queryClass,
  );

  let clarification = null;
  let finalDecision = 'products_returned';
  let clarifyBudgetExhausted = false;
  let contextFailOpenApplied = false;
  if (clarifyByAmbiguity) {
    const clarifyBudgetMaxRounds = Number(clarifyBudgetContext?.max_rounds);
    const clarifyBudgetUsedRounds = Number(clarifyBudgetContext?.used_rounds);
    clarifyBudgetExhausted =
      Number.isFinite(clarifyBudgetMaxRounds) &&
      Number.isFinite(clarifyBudgetUsedRounds) &&
      clarifyBudgetMaxRounds >= 0 &&
      clarifyBudgetUsedRounds >= clarifyBudgetMaxRounds;
    const resolvedScenarioFromContext = String(slotState.resolved_slots?.scenario || '').trim();
    const canApplyContextFailOpen =
      resolvedScenarioFromContext.length > 0 &&
      (postCandidateCount > 0 || preDomainFilterCandidates.length > 0 || before > 0) &&
      !clarifyBudgetExhausted &&
      ['mission', 'scenario', 'category'].includes(String(queryClass || ''));
    if (canApplyContextFailOpen) {
      if (postCandidateCount === 0) {
        filtered = preDomainFilterCandidates.length > 0 ? preDomainFilterCandidates.slice() : list.slice();
        postCandidateCount = filtered.length;
        postQuality.candidates = postCandidateCount;
        postQuality.candidates_ok = postCandidateCount >= effectiveMinRecallCandidates;
      }
      contextFailOpenApplied = true;
      postQuality.context_fail_open_applied = true;
      lowConfidenceReasons.push('context_fail_open');
    } else {
      postQuality.context_fail_open_applied = false;
    }
    const beautyMainlineNonBlockingClarify =
      beautyDiscoveryMainline && postCandidateCount > 0;
    const forceClearForAmbiguousRecommend =
      intentNeedsClarification &&
      String(queryClass || '') === 'exploratory' &&
      !beautyMainlineNonBlockingClarify;
    const shouldClearProductsForClarify =
      !beautyMainlineNonBlockingClarify &&
      !contextFailOpenApplied &&
      !clarifyBudgetExhausted &&
      (forceClearForAmbiguousRecommend ||
        (!brandQueryBypassAmbiguity &&
          (
            ['scenario', 'mission', 'gift'].includes(String(queryClass || '')) ||
            (!FPM_CLARIFY_NEVER_EMPTY &&
              ['exploratory', 'category', 'attribute'].includes(String(queryClass || '')))
          ) &&
          (postQualityHardFail || postCandidateCount === 0)));
    if (!clarifyBudgetExhausted && !contextFailOpenApplied) {
      if (shouldClearProductsForClarify) {
        filtered = [];
        postCandidateCount = 0;
      }
      clarification = buildClarification({
        queryClass,
        intent,
        language: intent?.language,
        rawQuery,
        associationPlan: associationPlanFromMeta,
        slotState: hasSlotState ? slotState : null,
        hints: {
          post_candidates: postCandidateCount,
          match_tier: baselineStats?.match_tier || null,
        },
      });
      finalDecision = postCandidateCount > 0 ? 'products_returned_with_clarification' : 'clarify';
      lowConfidenceReasons.push('clarification_attached_non_blocking');
      if (beautyMainlineNonBlockingClarify) {
        lowConfidenceReasons.push('beauty_mainline_clarify_observed');
      }
    } else if (clarifyBudgetExhausted) {
      postQuality.context_fail_open_applied = false;
      finalDecision = postCandidateCount > 0 ? 'products_returned' : 'clarify_skipped_budget_exhausted';
      lowConfidenceReasons.push('clarify_budget_exhausted');
    }
  } else {
    postQuality.context_fail_open_applied = false;
  }
  after = filtered.length;

  let stats = computeMatchStats(filtered, intent, { rawQuery });
  if (toolRec?.stats && finalDecision === 'products_returned') {
    stats = {
      ...stats,
      has_good_match: Boolean(toolRec.stats.has_good_match),
      match_tier: String(toolRec.stats.match_tier || stats.match_tier),
      match_confidence: Number.isFinite(toolRec.stats.match_confidence)
        ? toolRec.stats.match_confidence
        : stats.match_confidence,
    };
  }

  const reasonCodes = new Set([...(filterReasonCodes || [])]);
  if (intent?.ambiguity?.needs_clarification) {
    reasonCodes.add('NEEDS_CLARIFICATION');
    const scen = intent?.scenario?.name || '';
    if (scen === 'discovery') reasonCodes.add('CHITCHAT_ROUTED');
    if (scen === 'browse') reasonCodes.add('BROWSE_ROUTED');
  }
  if (!stats.has_good_match) {
    if (stats.match_tier === 'none' && after === 0) {
      reasonCodes.add('FILTERED_TO_EMPTY');
    } else if (stats.match_tier === 'weak') {
      reasonCodes.add('WEAK_RELEVANCE');
    }
  }
  if (diversityDebug?.requirement_unmet) reasonCodes.add('BEAUTY_DIVERSITY_NOT_MET');
  if (diversityDebug?.penalty_applied) reasonCodes.add('BEAUTY_DIVERSITY_REORDERED');
  if (diversityDebug?.reason === 'beauty_non_tool_min_not_met') {
    reasonCodes.add('BEAUTY_NON_TOOL_MIN_NOT_MET');
  }
  if (strictEmptyByAmbiguity) reasonCodes.add('AMBIGUITY_STRICT_EMPTY');
  if (clarifyByAmbiguity) reasonCodes.add('AMBIGUITY_CLARIFY');
  if (clarifyBudgetExhausted) reasonCodes.add('CLARIFY_BUDGET_EXHAUSTED');
  if (contextFailOpenApplied) reasonCodes.add('CONTEXT_FAIL_OPEN');
  if (postQualityHardFail) reasonCodes.add('LOW_CONF_POST');
  if (brandQueryBypassAmbiguity) reasonCodes.add('BRAND_QUERY_BYPASS_AMBIGUITY');
  if (domainFilterResult?.dropped > 0) reasonCodes.add('DOMAIN_HARD_FILTERED');
  if (fashionConstraintDropped) reasonCodes.add('FASHION_VISIBLE_CONSTRAINT_FILTERED');
  if (beautyBucketFilterResult?.dropped > 0) reasonCodes.add('BEAUTY_BUCKET_FILTERED');
  if (domainCondenserResult?.debug?.applied) reasonCodes.add('DOMAIN_CONDENSED');

  const augmented = setResponseProductList(response, key, filtered);
  const filtersApplied = buildFiltersApplied(intent);
  const existingMeta =
    augmented && augmented.metadata && typeof augmented.metadata === 'object' ? augmented.metadata : {};
  const existingRouteDebug =
    existingMeta.route_debug && typeof existingMeta.route_debug === 'object'
      ? existingMeta.route_debug
      : null;
  const computedBudgetFxMetadata = buildBudgetFxMetadata(
    intent?.hard_constraints?.price || null,
    filtered,
    Array.isArray(list) ? list : [],
  );
  const hasBudgetFxMetadata =
    computedBudgetFxMetadata ||
    existingMeta.budget_fx_applied != null ||
    existingMeta.budget_fx_rate != null ||
    existingMeta.budget_fx_source != null ||
    existingMeta.budget_fx_candidate_currency != null ||
    existingMeta.budget_fx_unresolved != null;
  const budgetFxMetadata = hasBudgetFxMetadata
    ? {
        budget_fx_applied:
          computedBudgetFxMetadata?.budget_fx_applied ??
          (existingMeta.budget_fx_applied === true),
        budget_fx_rate:
          computedBudgetFxMetadata?.budget_fx_rate ??
          (existingMeta.budget_fx_rate ?? null),
        budget_fx_source:
          computedBudgetFxMetadata?.budget_fx_source ??
          (existingMeta.budget_fx_source ?? null),
        budget_fx_candidate_currency:
          computedBudgetFxMetadata?.budget_fx_candidate_currency ??
          (existingMeta.budget_fx_candidate_currency ?? null),
        budget_fx_unresolved:
          computedBudgetFxMetadata?.budget_fx_unresolved ??
          (existingMeta.budget_fx_unresolved === true),
      }
    : null;
  const policyDebug = filteredResult?.debug || null;
  const shouldAttachPolicyDebug =
    DEBUG_STATS_ENABLED ||
    existingRouteDebug ||
    diversityDebug ||
    beautyBucketFilterResult?.applied;
  const mergedMetadata =
    shouldAttachPolicyDebug
      ? {
          ...existingMeta,
          route_debug: {
            ...(existingRouteDebug || {}),
            policy: {
              ...(existingRouteDebug?.policy || {}),
              ...(policyDebug ? { filter_debug: policyDebug } : {}),
              ...(diversityDebug ? { diversity: diversityDebug } : {}),
              ...(beautyBucketFilterResult?.applied
                ? { beauty_bucket_filter: beautyBucketFilterResult }
                : {}),
              ambiguity: {
                score_pre: ambiguityScorePre,
                score_post: ambiguityScorePost,
                clarify_triggered: Boolean(clarification),
                strict_empty_triggered: Boolean(strictEmptyByAmbiguity),
                brand_query_detected: Boolean(brandQueryDetected),
                brand_query_bypass_ambiguity: Boolean(brandQueryBypassAmbiguity),
                brand_entities: brandEntities,
                brand_scope: brandScope,
                query_class: queryClass,
                query_semantic_class: querySemanticClass,
                domain_filter_dropped: Number(domainFilterResult?.dropped || 0),
                domain_filter_dropped_external: Number(domainFilterResult?.dropped_external || 0),
                domain_filter_key: domainFilterResult?.domain_key || null,
                domain_filter_mode: domainFilterResult?.mode_used || null,
                domain_filter_pass2: Boolean(domainFilterResult?.pass2_triggered),
                beauty_query_bucket: beautyBucketFilterResult?.bucket || null,
                beauty_bucket_filter_dropped: Number(beautyBucketFilterResult?.dropped || 0),
                post_quality: postQuality,
              },
            },
          },
        }
      : existingMeta;
  const fashionConstraintMetadata = buildFashionConstraintMetadata({
    rawQuery,
    products: filtered,
    existingMetadata: mergedMetadata,
  });

  const shouldOverrideReply =
    !augmented.reply ||
    typeof augmented.reply !== 'string' ||
    augmented.reply.trim().length === 0 ||
    !stats.has_good_match;

  const toolFirstReply = (() => {
    if (!toolRec) return null;
    if (toolRec.reply_override) return String(toolRec.reply_override);
    const lang = intent?.language || 'en';
    const mode = String(toolRec.mode || 'tiered');
    const kits = Array.isArray(toolRec.tool_kits) ? toolRec.tool_kits : [];
    if (!kits.length) return null;

    const qs = Array.isArray(toolRec.follow_up_questions) ? toolRec.follow_up_questions : [];

    const roleLabelsByLang = {
      zh: {
        foundation_brush: '粉底刷',
        sponge: '美妆蛋/海绵',
        powder_brush: '散粉刷',
        powder_puff: '粉扑',
        concealer_brush: '遮瑕刷',
        multi_face_brush: '多功能面部刷',
        blush_brush: '腮红刷',
        contour_brush: '修容刷',
        highlight_brush: '高光刷',
        eye_brush_set: '眼影刷/晕染刷（眼妆刷）',
        eyelash_curler: '睫毛夹',
        cleaner: '清洁工具',
        brush_set: '刷具套装',
      },
      ja: {
        foundation_brush: 'ファンデーションブラシ',
        sponge: 'メイクスポンジ',
        powder_brush: 'パウダーブラシ',
        powder_puff: 'パフ',
        concealer_brush: 'コンシーラーブラシ',
        multi_face_brush: 'マルチフェイスブラシ',
        blush_brush: 'チークブラシ',
        contour_brush: 'シェーディングブラシ',
        highlight_brush: 'ハイライトブラシ',
        eye_brush_set: 'アイブラシ（セット）',
        eyelash_curler: 'ビューラー',
        cleaner: 'クリーニング用品',
        brush_set: 'ブラシセット',
      },
      fr: {
        foundation_brush: 'pinceau fond de teint',
        sponge: 'éponge maquillage',
        powder_brush: 'pinceau poudre',
        powder_puff: 'houppette',
        concealer_brush: 'pinceau anti-cernes',
        multi_face_brush: 'pinceau visage multi-usage',
        blush_brush: 'pinceau blush',
        contour_brush: 'pinceau contour',
        highlight_brush: 'pinceau enlumineur',
        eye_brush_set: 'pinceaux yeux',
        eyelash_curler: 'recourbe-cils',
        cleaner: 'nettoyant',
        brush_set: 'set de pinceaux',
      },
      es: {
        foundation_brush: 'brocha de base',
        sponge: 'esponja de maquillaje',
        powder_brush: 'brocha de polvo',
        powder_puff: 'borla',
        concealer_brush: 'brocha de corrector',
        multi_face_brush: 'brocha multiuso',
        blush_brush: 'brocha de rubor',
        contour_brush: 'brocha de contorno',
        highlight_brush: 'brocha iluminador',
        eye_brush_set: 'brochas de ojos',
        eyelash_curler: 'rizador de pestañas',
        cleaner: 'limpiador',
        brush_set: 'set de brochas',
      },
      en: {
        foundation_brush: 'foundation brush',
        sponge: 'makeup sponge',
        powder_brush: 'powder brush',
        powder_puff: 'powder puff',
        concealer_brush: 'concealer brush',
        multi_face_brush: 'multi face brush',
        blush_brush: 'blush brush',
        contour_brush: 'contour brush',
        highlight_brush: 'highlight brush',
        eye_brush_set: 'eye brushes',
        eyelash_curler: 'eyelash curler',
        cleaner: 'cleaner',
        brush_set: 'brush set',
      },
    };

    const roleLabel = roleLabelsByLang[lang] || roleLabelsByLang.en;
    const joiner = lang === 'zh' || lang === 'ja' ? '、' : ', ';
    const prefix =
      lang === 'zh'
        ? '包含：'
        : lang === 'ja'
          ? '内容：'
          : lang === 'fr'
            ? 'Inclus : '
            : lang === 'es'
              ? 'Incluye: '
              : 'Includes: ';

    const fmtKit = (k) => {
      const items = Array.isArray(k?.items) ? k.items : [];
      const roles = items.map((it) => String(it?.role || '')).filter(Boolean);
      const missingRoles = Array.isArray(k?.missing_roles) ? k.missing_roles.map((r) => String(r || '')).filter(Boolean) : [];
      const allRoles = Array.from(new Set([...roles, ...missingRoles].filter(Boolean)));
      const labels = allRoles.map((r) => roleLabel[r] || r);
      const uniq = Array.from(new Set(labels));
      return `${k.kit_name}\n${prefix}${uniq.join(joiner)}`;
    };

    const header =
      mode === 'focused'
        ? lang === 'zh'
          ? '我先按你当前需求整理成一份精简清单：'
          : lang === 'ja'
            ? 'まずは要件に合わせてミニマルに整理しました：'
            : lang === 'fr'
              ? 'Je te propose d’abord une liste minimale selon ton besoin :'
              : lang === 'es'
                ? 'Primero te dejo una lista mínima según tu necesidad:'
                : 'Here’s a focused minimal list based on your needs:'
        : lang === 'zh'
          ? '我按“工具优先”给你配了 3 套组合（A→B→C）：'
          : lang === 'ja'
            ? '「ツール優先」で 3 つのセット（A→B→C）を用意しました：'
            : lang === 'fr'
              ? 'J’ai assemblé 3 kits “tool-first” (A→B→C) :'
              : lang === 'es'
                ? 'Armé 3 kits “tool-first” (A→B→C):'
                : 'I assembled 3 tool-first kits (A→B→C):';

    const kitLines = (mode === 'focused' ? kits.slice(0, 1) : kits.slice(0, 3)).map(fmtKit);
    const qLines = qs.length
      ? [
          lang === 'zh'
            ? '\n想更精准的话，回答 1–2 个就行：'
            : lang === 'ja'
              ? '\nもっと絞り込むなら、1〜2個だけ答えて：'
              : lang === 'fr'
                ? '\nPour affiner, réponds à 1–2 questions :'
                : lang === 'es'
                  ? '\nPara afinar, responde 1–2 preguntas:'
                  : '\nTo refine, answer 1–2 quick questions:',
          ...qs.slice(0, 2).map((q) => `- ${q}`),
        ]
      : [];
    return [header, ...kitLines, ...qLines].join('\n');
  })();

  const reply = toolFirstReply
    ? toolFirstReply
    : clarification &&
      String(intent?.scenario?.name || '').toLowerCase() === 'discovery' &&
      (metadata?.creator_name || metadata?.creatorName)
      ? buildReply(intent, stats.match_tier, Array.from(reasonCodes), {
          creatorName: metadata?.creator_name || metadata?.creatorName || null,
          creatorId: metadata?.creator_id || metadata?.creatorId || null,
          rawUserQuery: rawQuery,
        })
    : clarification
      ? `${clarification.question}\n${(clarification.options || []).map((option, index) => `${index + 1}) ${option}`).join('\n')}`
    : shouldOverrideReply
      ? buildReply(intent, stats.match_tier, Array.from(reasonCodes), {
          creatorName: metadata?.creator_name || metadata?.creatorName || null,
          creatorId: metadata?.creator_id || metadata?.creatorId || null,
          rawUserQuery: rawQuery,
        })
      : augmented.reply;

  const debugStats = DEBUG_STATS_ENABLED
    ? {
        candidate_count_before_filter: before,
        candidate_count_after_filter: after,
        hard_match_count_top20: stats.hard_match_count_top20,
        distractor_ratio_top20: stats.distractor_ratio_top20,
      }
    : undefined;

  const clarificationSlotState =
    clarification && String(clarification.slot || '').trim()
      ? {
          asked_slots: Array.from(
            new Set([
              ...(hasSlotState ? slotState.asked_slots : []),
              String(clarification.slot).trim(),
            ]),
          ),
          resolved_slots: hasSlotState ? { ...slotState.resolved_slots } : {},
        }
      : hasSlotState
        ? slotState
        : null;

  const responsePayload = {
    ...augmented,
    ...(mergedMetadata !== existingMeta
      ? {
          metadata: {
            ...mergedMetadata,
            ...fashionConstraintMetadata,
            strategy_version: STRATEGY_VERSION,
            brand_query_bypass_ambiguity: Boolean(brandQueryBypassAmbiguity),
            search_decision: {
              query_class: queryClass,
              query_semantic_class: querySemanticClass,
              brand_query_detected: Boolean(brandQueryDetected),
              brand_entities: brandEntities,
              brand_scope: brandScope,
              brand_query_bypass_ambiguity: Boolean(brandQueryBypassAmbiguity),
              ambiguity_score_pre: ambiguityScorePre,
              ambiguity_score_post: ambiguityScorePost,
              clarify_triggered: Boolean(clarification),
              strict_empty_triggered: Boolean(strictEmptyByAmbiguity),
              final_decision: finalDecision,
              domain_condenser: domainCondenserResult?.debug || null,
              post_quality: postQuality,
              low_confidence: lowConfidenceReasons.length > 0,
              low_confidence_reasons: lowConfidenceReasons,
              domain_filter_dropped_external: Number(domainFilterResult?.dropped_external || 0),
              ...(clarificationSlotState ? { slot_state: clarificationSlotState } : {}),
            },
            query_semantic_class: querySemanticClass,
            domain_filter_dropped_external: Number(domainFilterResult?.dropped_external || 0),
            ...(budgetFxMetadata || {}),
            gate_trace: gateTrace,
            gate_summary: {
              applied_count: gateTrace.filter((item) => item.applied).length,
              blocked_count: gateTrace.filter((item) => String(item.decision) === 'strict_empty').length,
              total_cost_ms_estimate: gateTrace.reduce(
                (sum, item) => sum + Math.max(0, Number(item.cost_ms_estimate || 0) || 0),
                0,
              ),
            },
          },
        }
      : {
          metadata: {
            ...(augmented?.metadata && typeof augmented.metadata === 'object' ? augmented.metadata : {}),
            ...fashionConstraintMetadata,
            strategy_version: STRATEGY_VERSION,
            brand_query_bypass_ambiguity: Boolean(brandQueryBypassAmbiguity),
            search_decision: {
              query_class: queryClass,
              query_semantic_class: querySemanticClass,
              brand_query_detected: Boolean(brandQueryDetected),
              brand_entities: brandEntities,
              brand_scope: brandScope,
              brand_query_bypass_ambiguity: Boolean(brandQueryBypassAmbiguity),
              ambiguity_score_pre: ambiguityScorePre,
              ambiguity_score_post: ambiguityScorePost,
              clarify_triggered: Boolean(clarification),
              strict_empty_triggered: Boolean(strictEmptyByAmbiguity),
              final_decision: finalDecision,
              domain_condenser: domainCondenserResult?.debug || null,
              post_quality: postQuality,
              low_confidence: lowConfidenceReasons.length > 0,
              low_confidence_reasons: lowConfidenceReasons,
              domain_filter_dropped_external: Number(domainFilterResult?.dropped_external || 0),
              ...(clarificationSlotState ? { slot_state: clarificationSlotState } : {}),
            },
            query_semantic_class: querySemanticClass,
            domain_filter_dropped_external: Number(domainFilterResult?.dropped_external || 0),
            ...(budgetFxMetadata || {}),
            gate_trace: gateTrace,
            gate_summary: {
              applied_count: gateTrace.filter((item) => item.applied).length,
              blocked_count: gateTrace.filter((item) => String(item.decision) === 'strict_empty').length,
              total_cost_ms_estimate: gateTrace.reduce(
                (sum, item) => sum + Math.max(0, Number(item.cost_ms_estimate || 0) || 0),
                0,
              ),
            },
          },
        }),
    policy_version: POLICY_VERSION,
    reply,
    intent,
    filters_applied: filtersApplied,
    match_confidence: stats.match_confidence,
    has_good_match: stats.has_good_match,
    match_tier: stats.match_tier,
    reason_codes: Array.from(reasonCodes),
    ...(clarification
      ? {
          clarification: {
            question: clarification.question,
            options: clarification.options,
            reason_code: clarification.reason_code,
            ...(clarification.slot ? { slot: clarification.slot } : {}),
            ...(clarification.dedup_key ? { dedup_key: clarification.dedup_key } : {}),
          },
        }
      : {}),
    ...(toolRec?.tool_kits ? { tool_kits: toolRec.tool_kits } : {}),
    ...(toolRec?.user_summary ? { user_summary: toolRec.user_summary } : {}),
    ...(toolRec?.follow_up_questions ? { follow_up_questions: toolRec.follow_up_questions } : {}),
    ...(debugStats ? { debug_stats: debugStats } : {}),
  };

  return syncResponsePaginationCounts(
    responsePayload,
    Array.isArray(filtered) ? filtered.length : 0,
  );
}

module.exports = {
  buildFindProductsMultiContext,
  applyFindProductsMultiPolicy,
  BEAUTY_DISCOVERY_CONTRACT_OWNER,
  BEAUTY_DISCOVERY_MAINLINE_OWNER,
  buildBeautyDiscoverySemanticContract,
  buildBeautyDiscoveryQueryPackFromContract,
  isBeautyDiscoverySemanticContract,
  hasFashionConstraintQuerySignal,
  pruneRecentQueries,
};
