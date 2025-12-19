const { extractIntent } = require('./intentLlm');
const { injectPivotaAttributes, buildProductText, isToyLikeText } = require('./productTagger');

const DEBUG_STATS_ENABLED = process.env.FIND_PRODUCTS_MULTI_DEBUG_STATS === '1';
const POLICY_VERSION = 'find_products_multi_policy_v25';

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

function isExplicitAdultOrLingerieQuery(rawQuery) {
  const q = String(rawQuery || '');
  if (!q) return false;
  // Only treat explicit lingerie/adult terms as opt-in (avoid "sleepwear" etc).
  const patterns = [
    /\b(lingerie|underwear)\b/i,
    /\b(bra|bras)\b/i,
    /\b(panty|panties|thong)\b/i,
    /\b(sex\s*toy|adult)\b/i,
    /\b(lencer[ií]a|ropa\s+interior|sujetador|bragas|tanga)\b/i,
    /\b(sous[-\s]?v[eê]tement|soutien[-\s]?gorge)\b/i,
    /下着|内衣|情趣|成人用品/,
  ];
  return patterns.some((re) => re.test(q));
}

function isLingerieLikeProduct(product) {
  const text = buildProductText(product);
  if (!text) return false;
  return LINGERIE_PATTERNS.some((re) => re.test(text));
}

function hasPetSignalInProduct(product) {
  const text = buildProductText(product);
  // Do not "short-circuit" to CJK-only checks: many Shopify products include CJK
  // option labels (e.g. 尺寸/颜色) even when the title/description is English.
  const cjkHit =
    /[\u4e00-\u9fff\u3040-\u30ff]/.test(text) &&
    ['宠物', '狗', '狗狗', '猫', '犬', 'ペット', '犬服', '猫服', '狗衣服', '宠物衣服'].some((k) =>
      text.includes(k)
    );
  // Word-boundary checks to avoid false positives like "catsuit".
  const latinHit =
    /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets)\b/.test(text) ||
    /\b(perro|perros|perrita|cachorro|mascota|mascotas|gato|gatos)\b/.test(text) ||
    /\b(chien|chiens|chienne|chiot|animal|animaux|chat|chats)\b/.test(text);
  return cjkHit || latinHit;
}

function clamp01(n) {
  if (Number.isNaN(n) || n == null) return 0;
  return Math.max(0, Math.min(1, n));
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
  const explicit = isExplicitAdultOrLingerieQuery(rawQuery || '');
  // TODO: if we later extend intent schema with an explicit adult_intent object,
  // read it here instead of relying only on query text.
  const conf = explicit ? 0.9 : 0.0;
  return { is_explicit: explicit, conf };
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
      riskLevel = 'hard_block';
      reasonCodes.add(REASON_CODES.ADULT_UNREQUESTED);
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

  const price = Number(product.price ?? product.price_amount ?? NaN);
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

  const isSensitive = evalMeta.reason_codes.includes(REASON_CODES.COMPAT_UNKNOWN);
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
    requiredDomains.push('human_apparel');
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
      return '我没找到适合这次山上保暖的成人外套/大衣（当前货盘里可能缺少相关品类）。你可以试试改搜：羽绒服 / 冲锋衣 / 抓绒 / 保暖外套，或告诉我最低温度和预算，我再帮你缩小范围。';
    }
    if (matchTier === 'weak') {
      if ((intent?.target_object?.type || '') === 'pet') {
        return '我只找到少量勉强相关的狗狗/宠物衣服（匹配度不高），所以先不强行推荐不相关的商品。你可以补充：狗狗体型/胸围、最低温度、是否需要防风防水，我再帮你精准筛。';
      }
      return '我只找到了少量勉强相关的结果（匹配度不高），所以先不强行推荐。你可以补充：最低温度、预算、是否需要防风/防水，以及更偏好羽绒服还是冲锋衣。';
    }
    return '我找到了几件更符合你需求的选择。';
  }

  if (isNone) {
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
  return 'Here are some more suitable picks based on your request.';
}

async function buildFindProductsMultiContext({ payload, metadata }) {
  const search = payload?.search || {};
  const recentQueries = payload?.user?.recent_queries || [];
  const recentMessages = payload?.messages || [];

  // Some clients (chat-style UIs) may send the user utterance only in `messages`
  // and leave `search.query` empty. If so, derive query from the last user message.
  const queryFromSearch = String(search.query || '').trim();
  const queryFromMessages = extractLatestUserTextFromMessages(recentMessages);
  const latestUserQuery = looksLikeRealQuery(queryFromSearch)
    ? queryFromSearch
    : looksLikeRealQuery(queryFromMessages)
      ? queryFromMessages
      : queryFromSearch;

  const intent = await extractIntent(latestUserQuery, recentQueries, recentMessages);
  const pruned = pruneRecentQueries(latestUserQuery, recentQueries, intent);

  const expandedQuery = (() => {
    const q = latestUserQuery;
    if (!q) return q;
    const lang = intent?.language || 'en';
    const target = intent?.target_object?.type || 'unknown';
    const scenario = intent?.scenario?.name || 'general';

    const extra = [];
    if (target === 'pet') {
      extra.push('dog jacket', 'pet apparel');
      if (scenario.includes('hiking')) extra.push('hiking', 'cold weather');
      // Also expand for Chinese queries against English-heavy catalogs.
      if (lang === 'zh') extra.push('dog', 'pet', 'coat');
      if (lang === 'es') extra.push('perro', 'ropa');
      if (lang === 'fr') extra.push('chien', 'vêtement');
      if (lang === 'ja') extra.push('犬', '犬服');
    } else if (target === 'human' && intent?.primary_domain === 'human_apparel') {
      extra.push('coat', 'jacket', 'outerwear');
      if (scenario.includes('cold') || scenario.includes('mountain')) extra.push('down jacket', 'winter');
      if (lang === 'es') extra.push('abrigo', 'chaqueta');
      if (lang === 'fr') extra.push('manteau', 'veste');
      if (lang === 'zh') extra.push('coat', 'jacket');
    } else if (intent?.primary_domain === 'toy_accessory') {
      extra.push('labubu', 'doll clothes', 'outfit');
    }

    if (!extra.length) return q;
    const combined = `${q} ${extra.join(' ')}`.trim();
    return combined.length > 240 ? combined.slice(0, 240) : combined;
  })();

  const adjustedPayload = {
    ...(payload || {}),
    user: {
      ...(payload?.user || {}),
      ...(pruned ? { recent_queries: pruned } : {}),
    },
    search: {
      ...(payload?.search || {}),
      ...(expandedQuery ? { query: expandedQuery } : {}),
    },
  };

  return { intent, adjustedPayload, rawUserQuery: latestUserQuery };
}

function applyFindProductsMultiPolicy({ response, intent, requestPayload, metadata, rawUserQuery }) {
  const { key, list } = getResponseProductList(response);
  const before = Array.isArray(list) ? list.length : 0;
  const rawQuery =
    String(rawUserQuery || '').trim() ||
    String(requestPayload?.search?.query || '').trim() ||
    '';

  const filteredResult = filterProductsByIntent(list, intent, { rawQuery });
  const { filtered, reason_codes: filterReasonCodes } = filteredResult;
  const after = filtered.length;

  // By default, keep ordering. LLM rerank (optional) can be added later.
  const stats = computeMatchStats(filtered, intent, { rawQuery });

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

  const augmented = setResponseProductList(response, key, filtered);
  const filtersApplied = buildFiltersApplied(intent);
  const existingMeta =
    augmented && augmented.metadata && typeof augmented.metadata === 'object' ? augmented.metadata : {};
  const existingRouteDebug =
    existingMeta.route_debug && typeof existingMeta.route_debug === 'object'
      ? existingMeta.route_debug
      : null;
  const policyDebug = filteredResult?.debug || null;
  const mergedMetadata =
    DEBUG_STATS_ENABLED || existingRouteDebug
      ? {
          ...existingMeta,
          route_debug: {
            ...(existingRouteDebug || {}),
            policy: {
              ...(existingRouteDebug?.policy || {}),
              ...(policyDebug ? { filter_debug: policyDebug } : {}),
            },
          },
        }
      : existingMeta;

  const shouldOverrideReply =
    !augmented.reply ||
    typeof augmented.reply !== 'string' ||
    augmented.reply.trim().length === 0 ||
    !stats.has_good_match;

  const reply = shouldOverrideReply
    ? buildReply(intent, stats.match_tier, Array.from(reasonCodes), {
        creatorName: metadata?.creator_name || metadata?.creatorName || null,
        creatorId: metadata?.creator_id || metadata?.creatorId || null,
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
    ...(mergedMetadata !== existingMeta ? { metadata: mergedMetadata } : {}),
    policy_version: POLICY_VERSION,
    reply,
    intent,
    filters_applied: filtersApplied,
    match_confidence: stats.match_confidence,
    has_good_match: stats.has_good_match,
    match_tier: stats.match_tier,
    reason_codes: Array.from(reasonCodes),
    ...(debugStats ? { debug_stats: debugStats } : {}),
  };
}

module.exports = {
  buildFindProductsMultiContext,
  applyFindProductsMultiPolicy,
  pruneRecentQueries,
};
