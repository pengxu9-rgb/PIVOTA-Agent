const { extractIntent } = require('./intentLlm');
const { injectPivotaAttributes, buildProductText, isToyLikeText } = require('./productTagger');
const { recommendToolKits } = require('./toolRecommender');
const { buildEyeShadowBrushReply } = require('./eyeShadowBrushAdvisor');
const { buildClarification } = require('./clarification');
const { buildScenarioAssociationPlan } = require('./scenarioAssociation');

const DEBUG_STATS_ENABLED = process.env.FIND_PRODUCTS_MULTI_DEBUG_STATS === '1';
const POLICY_VERSION = 'find_products_multi_policy_v39';
const STRATEGY_VERSION = 'ambiguity_gate_v1';
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
const SEARCH_EXTERNAL_FILL_GATED =
  String(process.env.SEARCH_EXTERNAL_FILL_GATED || 'true').toLowerCase() !== 'false';
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
  if (!text) return 'other';

  const isToolLike =
    /\b(brush|brushes|sponge|puff|applicator|curler|tweezer|tool|tools|brush set)\b/i.test(text) ||
    /(化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|睫毛夹|睫毛夾|工具)/.test(text);
  if (isToolLike) {
    return 'tools';
  }

  if (
    /\b(foundation|concealer|primer|powder|cushion|bb cream|cc cream|setting spray)\b/i.test(text) ||
    /(粉底|遮瑕|妆前|妝前|定妆|定妝|气垫|氣墊|散粉|粉饼|粉餅)/.test(text)
  ) {
    return 'base_makeup';
  }
  if (
    /\b(eyeshadow|eye shadow|eyeliner|mascara|brow|eyebrow)\b/i.test(text) ||
    /(眼影|眼线|眼線|睫毛膏|眉笔|眉筆|眉粉)/.test(text)
  ) {
    return 'eye_makeup';
  }
  if (
    /\b(lipstick|lip gloss|lip tint|lip balm|lip liner)\b/i.test(text) ||
    /(口红|口紅|唇釉|唇膏|唇蜜|唇线|唇線)/.test(text)
  ) {
    return 'lip_makeup';
  }
  if (
    /\b(toner|serum|essence|lotion|moisturizer|sunscreen|cleanser|cream)\b/i.test(text) ||
    /(化妆水|化妝水|精华|精華|乳液|面霜|防晒|防曬|洁面|潔面|面膜)/.test(text)
  ) {
    return 'skincare';
  }
  return 'other';
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

function shouldApplyBeautyDiversity(intent, rawQuery) {
  if (!BEAUTY_DIVERSITY_ENABLED) return false;
  if (intent?.primary_domain !== 'beauty') return false;
  if (isBeautyLookupLikeQuery(rawQuery)) return false;
  const scenario = String(intent?.scenario?.name || '');
  if (scenario === 'beauty_tools' || scenario === 'eye_shadow_brush') return false;
  return true;
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

function inferQueryClassFromIntentAndQuery(intent, rawQuery) {
  const explicit = normalizeQueryClass(intent?.query_class, { defaultValue: null });
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

function inferSearchDomainKey(intent, rawQuery) {
  const target = String(intent?.target_object?.type || '').toLowerCase();
  const primaryDomain = String(intent?.primary_domain || '').toLowerCase();
  const query = String(rawQuery || '').toLowerCase();
  if (target === 'pet') return 'pet';
  if (primaryDomain === 'beauty') return 'beauty';
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
    /\b(foundation|concealer|mascara|lipstick|serum|toner|moisturizer|makeup|cosmetic)\b/i.test(text) ||
    /化妆|美妆|护肤|精华|口红|粉底|防晒/.test(text)
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

function computeAnchorRatio(rawQuery, products) {
  const anchors = normalizeWordTokens(rawQuery)
    .filter((token) => token.length >= 2)
    .slice(0, 10);
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

function computeAmbiguityScorePost({ ambiguityPre, products, rawQuery, intent, queryClassInput = null }) {
  const list = Array.isArray(products) ? products : [];
  const queryClass = normalizeQueryClass(queryClassInput ?? intent?.query_class, {
    defaultValue: null,
  });
  const candidateSparsity = clamp01(list.length === 0 ? 1 : (3 - Math.min(list.length, 3)) / 3);
  const domainEntropy = computeDomainEntropy(list);
  const anchorRatio = computeAnchorRatio(rawQuery, list);
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

function matchesDomainAllowlist(product, domainKey) {
  if (!SEARCH_DOMAIN_HARD_FILTER_ENABLED) return true;
  if (!domainKey || domainKey === 'general') return true;
  const productDomain = inferProductDomainKey(product);
  if (domainKey === 'pet') return productDomain === 'pet';
  if (domainKey === 'beauty') return productDomain === 'beauty';
  if (domainKey === 'travel') return productDomain === 'travel';
  if (domainKey === 'hiking') return productDomain === 'hiking';
  return true;
}

function applyDomainHardFilter(products, intent, rawQuery) {
  if (!SEARCH_DOMAIN_HARD_FILTER_ENABLED) return { products: Array.isArray(products) ? products : [], dropped: 0 };
  const list = Array.isArray(products) ? products : [];
  const domainKey = inferSearchDomainKey(intent, rawQuery);
  if (domainKey === 'general') return { products: list, dropped: 0 };
  const filtered = list.filter((product) => matchesDomainAllowlist(product, domainKey));
  return {
    products: filtered,
    dropped: Math.max(0, list.length - filtered.length),
    domain_key: domainKey,
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

  // Fallback: light-weight heuristic from text.
  const text = buildProductText(product);
  if (hasPetSignalInProduct(product)) return 'pet';
  if (isToyLikeText(text)) return 'toy';
  // If explicitly human apparel in domain, treat as human.
  const domain = String(pivota?.domain?.value || '').toLowerCase();
  if (domain === 'human_apparel') return 'human';

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

  return {
    risk_level: riskLevel,
    reason_codes: Array.from(reasonCodes),
    // Expose derived classification for scoring.
    product_object: productObject,
    target_object: target,
    target_conf: targetConf,
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
  if (hard.price && (hard.price.min != null || hard.price.max != null)) {
    required += 1;
    const withinMin = hard.price.min == null || (Number.isFinite(price) && price >= hard.price.min);
    const withinMax = hard.price.max == null || (Number.isFinite(price) && price <= hard.price.max);
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
  const price = intent?.hard_constraints?.price || null;
  const priceHintZh =
    price && price.currency === 'USD'
      ? price.min != null
        ? `（优先 ≥$${price.min}）`
        : price.max != null
          ? `（预算 ≤$${price.max}）`
          : ''
      : '';
  const priceHintEn =
    price && price.currency === 'USD'
      ? price.min != null
        ? `(prioritizing $${price.min}+)`
        : price.max != null
          ? `(budget ≤$${price.max})`
          : ''
      : '';
  const priceHintJa =
    price && price.currency === 'USD'
      ? price.min != null
        ? `（$${price.min}以上を優先）`
        : price.max != null
          ? `（予算は$${price.max}以内）`
          : ''
      : '';
  const priceHintFr =
    price && price.currency === 'USD'
      ? price.min != null
        ? `(priorité $${price.min}+)`
        : price.max != null
          ? `(budget ≤$${price.max})`
          : ''
      : '';
  const priceHintEs =
    price && price.currency === 'USD'
      ? price.min != null
        ? `(priorizando $${price.min}+)`
        : price.max != null
          ? `(presupuesto ≤$${price.max})`
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

  const intent = await extractIntent(latestUserQuery, recentQueries, recentMessages);
  const pruned = pruneRecentQueries(latestUserQuery, recentQueries, intent);

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
  const queryClass = inferQueryClassFromIntentAndQuery(intent, latestUserQuery);
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

  const expandedQuery = (() => {
    const q = latestUserQuery;
    if (!q) return q;
    const expansionMode = baseExpansionMode;
    if (expansionMode === 'off') return q;
    const lang = intent?.language || 'en';
    const target = intent?.target_object?.type || 'unknown';
    const scenario = intent?.scenario?.name || 'general';

    const extra = [];
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
	      const wantsSkincare =
	        /护肤|護膚|skincare|skin\s*care|serum|toner|essence|moisturizer|cleanser|sunscreen|cream/i.test(
	          q,
	        );
	      const wantsDateLook = /约会|約會|\bdate\b|\bnight\s*out\b/i.test(q);
	      if (wantsSkincare) {
	        extra.push('skincare', 'serum', 'toner', 'moisturizer', 'sunscreen', 'cleanser');
	        if (lang === 'zh') extra.push('护肤', '精华', '化妆水', '乳液', '面霜', '防晒');
	        if (lang === 'es') extra.push('cuidado de la piel', 'suero', 'tónico', 'hidratante');
	        if (lang === 'fr') extra.push('soin de la peau', 'sérum', 'tonique', 'hydratant');
	        if (lang === 'ja') extra.push('スキンケア', '美容液', '化粧水', '乳液');
	      } else {
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

  const adjustedPayload = {
    ...(payload || {}),
    user: {
      ...(payload?.user || {}),
      ...(pruned ? { recent_queries: pruned } : {}),
    },
    search: {
      ...topLevelSearchCompat,
      ...(payload?.search || {}),
      ...(expandedWithAssociation ? { query: expandedWithAssociation } : {}),
    },
  };

  const expansionMeta = {
    mode: rewriteGate.mode,
    strategy_version: STRATEGY_VERSION,
    raw_query: latestUserQuery,
    expanded_query: expandedWithAssociation,
    applied: Boolean(expandedWithAssociation && String(expandedWithAssociation) !== String(latestUserQuery)),
    query_class: queryClass,
    rewrite_gate: rewriteGate,
    association_plan: associationPlan,
    ambiguity_score_pre: ambiguityScorePre,
    external_fill_gated: SEARCH_EXTERNAL_FILL_GATED,
  };

  return { intent, adjustedPayload, rawUserQuery: latestUserQuery, expansion_meta: expansionMeta };
}

function applyFindProductsMultiPolicy({ response, intent, requestPayload, metadata, rawUserQuery }) {
  const { key, list } = getResponseProductList(response);
  const before = Array.isArray(list) ? list.length : 0;
  const rawQuery =
    String(rawUserQuery || '').trim() ||
    String(requestPayload?.search?.query || '').trim() ||
    '';

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
    filtered = [];
  }

  const skipConstraintReorder =
    intent?.primary_domain === 'beauty' &&
    (intent?.scenario?.name === 'beauty_tools' || intent?.scenario?.name === 'eye_shadow_brush');
  if (!skipConstraintReorder) {
    filtered = reorderProductsForConstraints(filtered, intent, rawQuery);
  }
  const domainFilterResult = applyDomainHardFilter(filtered, intent, rawQuery);
  filtered = Array.isArray(domainFilterResult.products) ? domainFilterResult.products : [];
  let diversityDebug = null;
  if (shouldApplyBeautyDiversity(intent, rawQuery)) {
    const diversityResult = applyBeautyDiversityPolicy(filtered, {
      topN: BEAUTY_DIVERSITY_TOPN,
      minBuckets: BEAUTY_DIVERSITY_MIN_BUCKETS,
      toolsMaxRatio: BEAUTY_DIVERSITY_TOOLS_MAX_RATIO,
      strictEmptyOnFailure: BEAUTY_DIVERSITY_STRICT_EMPTY_ON_FAILURE,
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
        filtered = [];
        diversityDebug = {
          ...diversityDebug,
          reason: 'beauty_non_tool_min_not_met',
          strict_empty: true,
          requirement_unmet: true,
          preserve_primary_on_failure: false,
          required_non_tool_buckets: 2,
          non_tool_distinct_buckets: nonToolDistinctBuckets,
        };
      }
    }
  }
  let after = filtered.length;

  const queryClass = inferQueryClassFromIntentAndQuery(intent, rawQuery);
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
  });

  const ambiguitySensitiveClass = isAmbiguitySensitiveQueryClass(queryClass);
  const clarifyEligible =
    SEARCH_AMBIGUITY_GATE_ENABLED &&
    SEARCH_CLARIFY_ON_MEDIUM_AMBIGUITY &&
    ambiguitySensitiveClass;
  const strictEmptyByAmbiguity =
    SEARCH_AMBIGUITY_GATE_ENABLED &&
    ambiguitySensitiveClass &&
    ambiguityScorePre > AMBIGUITY_THRESHOLD_STRICT_EMPTY &&
    ambiguityScorePost > AMBIGUITY_THRESHOLD_STRICT_EMPTY &&
    (!baselineStats.has_good_match || filtered.length === 0);
  const keepProductsForDirectedClass =
    filtered.length > 0 && ['mission', 'scenario', 'gift'].includes(queryClass);
  const clarifyByAmbiguity =
    clarifyEligible &&
    !strictEmptyByAmbiguity &&
    !keepProductsForDirectedClass &&
    ambiguityScorePost > AMBIGUITY_THRESHOLD_CLARIFY &&
    (!baselineStats.has_good_match ||
      queryClass === 'exploratory' ||
      queryClass === 'non_shopping' ||
      ambiguityScorePre > AMBIGUITY_THRESHOLD_CLARIFY);

  let clarification = null;
  let finalDecision = 'products_returned';
  if (strictEmptyByAmbiguity) {
    filtered = [];
    finalDecision = 'strict_empty';
  } else if (clarifyByAmbiguity) {
    clarification = buildClarification({
      queryClass,
      intent,
      language: intent?.language,
    });
    filtered = [];
    finalDecision = 'clarify';
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
  if (domainFilterResult?.dropped > 0) reasonCodes.add('DOMAIN_HARD_FILTERED');

  const augmented = setResponseProductList(response, key, filtered);
  const filtersApplied = buildFiltersApplied(intent);
  const existingMeta =
    augmented && augmented.metadata && typeof augmented.metadata === 'object' ? augmented.metadata : {};
  const existingRouteDebug =
    existingMeta.route_debug && typeof existingMeta.route_debug === 'object'
      ? existingMeta.route_debug
      : null;
  const policyDebug = filteredResult?.debug || null;
  const shouldAttachPolicyDebug = DEBUG_STATS_ENABLED || existingRouteDebug || diversityDebug;
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
              ambiguity: {
                score_pre: ambiguityScorePre,
                score_post: ambiguityScorePost,
                clarify_triggered: Boolean(clarification),
                strict_empty_triggered: Boolean(strictEmptyByAmbiguity),
                query_class: queryClass,
                domain_filter_dropped: Number(domainFilterResult?.dropped || 0),
                domain_filter_key: domainFilterResult?.domain_key || null,
              },
            },
          },
        }
      : existingMeta;

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

  return {
    ...augmented,
    ...(mergedMetadata !== existingMeta
      ? {
          metadata: {
            ...mergedMetadata,
            strategy_version: STRATEGY_VERSION,
            search_decision: {
              query_class: queryClass,
              ambiguity_score_pre: ambiguityScorePre,
              ambiguity_score_post: ambiguityScorePost,
              clarify_triggered: Boolean(clarification),
              strict_empty_triggered: Boolean(strictEmptyByAmbiguity),
              final_decision: finalDecision,
            },
          },
        }
      : {
          metadata: {
            ...(augmented?.metadata && typeof augmented.metadata === 'object' ? augmented.metadata : {}),
            strategy_version: STRATEGY_VERSION,
            search_decision: {
              query_class: queryClass,
              ambiguity_score_pre: ambiguityScorePre,
              ambiguity_score_post: ambiguityScorePost,
              clarify_triggered: Boolean(clarification),
              strict_empty_triggered: Boolean(strictEmptyByAmbiguity),
              final_decision: finalDecision,
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
          },
        }
      : {}),
    ...(toolRec?.tool_kits ? { tool_kits: toolRec.tool_kits } : {}),
    ...(toolRec?.user_summary ? { user_summary: toolRec.user_summary } : {}),
    ...(toolRec?.follow_up_questions ? { follow_up_questions: toolRec.follow_up_questions } : {}),
    ...(debugStats ? { debug_stats: debugStats } : {}),
  };
}

module.exports = {
  buildFindProductsMultiContext,
  applyFindProductsMultiPolicy,
  pruneRecentQueries,
};
