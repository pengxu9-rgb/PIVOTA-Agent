const axios = require('axios');
const crypto = require('crypto');

const PIVOTA_BACKEND_BASE_URL = String(process.env.PIVOTA_BACKEND_BASE_URL || '').trim().replace(/\/+$/, '');
const PIVOTA_BACKEND_AGENT_API_KEY = String(process.env.PIVOTA_BACKEND_AGENT_API_KEY || '').trim();

const MAX_SEEDS = 6;
const SEARCH_LIMIT = 8;
const RESOLVE_TIMEOUT_MS = 1800;
const SEARCH_TIMEOUT_MS = 1800;
const SHOP_INVOKE_TIMEOUT_MS = 2200;
const FUZZY_THRESHOLD = 0.45;

const STEP_ALIASES = Object.freeze({
  cleanser: ['cleanser', 'face wash', 'facial wash', 'cleansing gel', 'cleansing foam', '洁面', '洗面奶', '清洁'],
  toner: ['toner', 'mist', 'skin toner', '爽肤水', '化妆水', '喷雾'],
  essence: ['essence', 'first essence', '精粹', '精华水'],
  serum: ['serum', 'ampoule', 'booster serum', '精华', '安瓶', '原液'],
  moisturizer: ['moisturizer', 'moisturiser', 'cream', 'lotion', 'gel cream', '面霜', '乳液', '保湿霜', '保湿乳'],
  sunscreen: ['sunscreen', 'sun screen', 'spf', 'sunblock', '防晒', '隔离防晒'],
  treatment: ['treatment', 'spot treatment', 'retinol', 'retinoid', 'acid treatment', 'aha', 'bha', '刷酸', '维a', '祛痘'],
  mask: ['mask', 'sheet mask', 'sleeping mask', 'overnight mask', 'wash off mask', 'wash-off mask', 'clay mask', 'mud mask', 'facial mask', 'face mask', '面膜', '泥膜', '冻膜', '睡眠面膜'],
  oil: ['face oil', 'facial oil', 'oil serum', 'skin oil', '护肤油', '面油'],
});

const SKINCARE_ALLOW_RE = /\b(cleanser|face wash|cleansing|toner|mist|essence|serum|ampoule|booster|moistur|cream|lotion|gel cream|gel-cream|sunscreen|sun screen|spf|sunblock|treatment|retinol|retinoid|acid|aha|bha|mask|sheet mask|sleeping mask|overnight mask|clay mask|mud mask|face oil|facial oil|barrier|repair|hydrating|hydration|soothing|calming|blemish|acne|niacinamide|azelaic|ceramide|peptide|vitamin c|洁面|洗面奶|化妆水|爽肤水|精华|精华水|面霜|乳液|保湿|防晒|面膜|修护|屏障|舒缓|祛痘|烟酰胺|壬二酸|神经酰胺|胜肽|维c|护肤油)\b/i;
const SKINCARE_BLOCK_RE = /\b(brush|applicator|blender|tool|makeup|eyeshadow|blush|lipstick|foundation|concealer|palette|mascara|brow|nail|perfume|hair|comb|razor|shaver|accessor|化妆刷|彩妆|眼影|粉底|口红|睫毛膏|眉笔|指甲|香水|梳子|剃须|配件)\b/i;

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

function uniqCaseInsensitiveStrings(items, max = 80) {
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

function joinBrandAndName(brandRaw, nameRaw) {
  const brand = String(brandRaw || '').trim();
  const name = String(nameRaw || '').trim();
  if (!brand) return name;
  if (!name) return brand;
  const brandLower = brand.toLowerCase();
  const nameLower = name.toLowerCase();
  if (nameLower === brandLower || nameLower.startsWith(`${brandLower} `)) return name;
  return `${brand} ${name}`.trim();
}

function normalizeLang(locale) {
  const raw = String(locale || '').trim().toLowerCase();
  return raw === 'cn' || raw === 'zh' || raw.startsWith('zh-') ? 'CN' : 'EN';
}

function localizeText(value, lang = 'EN') {
  if (typeof value === 'string') return value.trim();
  if (!isPlainObject(value)) return '';
  if (String(lang || '').toUpperCase() === 'CN') {
    return pickFirstTrimmed(value.zh, value.cn, value.en);
  }
  return pickFirstTrimmed(value.en, value.zh, value.cn);
}

function normalizeScore(value, fallback = 0.72) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function isUuidLikeString(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function normalizeCanonicalProductRef(input, { requireMerchant = true, allowOpaqueProductId = false } = {}) {
  const ref = isPlainObject(input) ? input : null;
  if (!ref) return null;
  const productId = pickFirstTrimmed(ref.product_id, ref.productId);
  const merchantId = pickFirstTrimmed(ref.merchant_id, ref.merchantId);
  if (!productId) return null;
  if (!allowOpaqueProductId && isUuidLikeString(productId)) return null;
  if (requireMerchant && !merchantId) return null;
  return {
    product_id: productId,
    ...(merchantId ? { merchant_id: merchantId } : {}),
  };
}

function normalizeResolveReasonCode(raw, fallback = 'no_candidates') {
  const code = String(raw || '').trim().toLowerCase();
  if (code === 'db_error' || code === 'upstream_timeout' || code === 'no_candidates') return code;
  return fallback;
}

function mapResolveFailureCode({ resolveBody, statusCode, error } = {}) {
  const explicit = normalizeResolveReasonCode(
    resolveBody?.reason_code || resolveBody?.reasonCode || resolveBody?.metadata?.resolve_reason_code,
    '',
  );
  const reason = String(resolveBody?.reason || '').trim().toLowerCase();
  const sources = Array.isArray(resolveBody?.metadata?.sources) ? resolveBody.metadata.sources : [];
  const sourceReasons = sources
    .map((item) => String(item?.reason || '').trim().toLowerCase())
    .filter(Boolean);

  if (explicit === 'db_error' || explicit === 'upstream_timeout') return explicit;
  if (sourceReasons.some((token) => token.startsWith('db_') || token === 'products_cache_missing')) return 'db_error';
  if (sourceReasons.some((token) => token.includes('timeout') || token.startsWith('upstream_'))) return 'upstream_timeout';
  if (explicit === 'no_candidates') return explicit;
  if (reason === 'no_candidates' || reason === 'low_confidence' || reason === 'empty_query') return 'no_candidates';
  if (reason.startsWith('db_') || reason === 'products_cache_missing') return 'db_error';
  if (reason.includes('timeout') || reason.startsWith('upstream_') || reason === 'upstream_error') return 'upstream_timeout';

  const status = Number(statusCode || 0);
  if (status >= 500 || status === 429 || status === 408) return 'upstream_timeout';

  const errText = String(error?.code || error?.message || error || '').trim().toLowerCase();
  if (errText.includes('timeout') || errText.includes('econnaborted') || errText.includes('etimedout')) return 'upstream_timeout';
  if (errText.includes('db_') || errText.includes('database') || errText.includes('postgres')) return 'db_error';
  return 'no_candidates';
}

function mapOfferResolveFailureCode({ responseBody, statusCode, error } = {}) {
  const explicit = normalizeResolveReasonCode(
    responseBody?.reason_code || responseBody?.reasonCode || responseBody?.metadata?.reason_code || responseBody?.metadata?.resolve_reason_code,
    '',
  );
  if (explicit) return explicit;

  const reason = String(
    responseBody?.reason ||
    responseBody?.error ||
    responseBody?.code ||
    responseBody?.message ||
    '',
  )
    .trim()
    .toLowerCase();
  if (reason.startsWith('db_') || reason.includes('database') || reason.includes('postgres')) return 'db_error';
  if (reason.includes('timeout') || reason.startsWith('upstream_') || reason === 'upstream_error') return 'upstream_timeout';
  if (reason === 'no_candidates' || reason === 'not_found' || reason === 'not_found_in_cache') return 'no_candidates';

  const status = Number(statusCode || 0);
  if (status >= 500 || status === 429 || status === 408) return 'upstream_timeout';

  const errText = String(error?.code || error?.message || error || '').trim().toLowerCase();
  if (errText.includes('timeout') || errText.includes('econnaborted') || errText.includes('etimedout')) return 'upstream_timeout';
  if (errText.includes('db_') || errText.includes('database') || errText.includes('postgres')) return 'db_error';
  return 'no_candidates';
}

function extractCanonicalFromOffersResolveBody(body) {
  const payload = isPlainObject(body) ? body : null;
  const mapping = isPlainObject(payload?.mapping) ? payload.mapping : null;
  let canonicalProductGroupId = pickFirstTrimmed(
    mapping?.canonical_product_group_id,
    mapping?.canonicalProductGroupId,
    mapping?.canonical_product_group?.id,
    mapping?.canonical_product_group?.product_group_id,
  );

  const canonicalRefCandidates = [
    mapping?.canonical_ref,
    mapping?.canonical_product_ref,
    payload?.canonical_product_ref,
  ];
  let canonicalProductRef = null;
  for (const candidate of canonicalRefCandidates) {
    const normalized = normalizeCanonicalProductRef(candidate, {
      requireMerchant: true,
      allowOpaqueProductId: false,
    });
    if (normalized) {
      canonicalProductRef = normalized;
      break;
    }
  }

  if (!canonicalProductRef) {
    const canonicalProduct = isPlainObject(mapping?.canonical_product) ? mapping.canonical_product : null;
    const fallbackRef = normalizeCanonicalProductRef(
      {
        product_id: pickFirstTrimmed(canonicalProduct?.product_id, canonicalProduct?.id),
        merchant_id: pickFirstTrimmed(
          canonicalProduct?.merchant_id,
          canonicalProduct?.merchantId,
          canonicalProduct?.merchant?.merchant_id,
        ),
      },
      { requireMerchant: true, allowOpaqueProductId: false },
    );
    if (fallbackRef) canonicalProductRef = fallbackRef;
  }

  const pdpTargets = [
    payload?.pdp_target?.v1,
    payload?.pdpTarget?.v1,
    mapping?.pdp_target?.v1,
    mapping?.pdpTarget?.v1,
  ].filter((candidate) => isPlainObject(candidate));

  for (const target of pdpTargets) {
    if (!canonicalProductGroupId) {
      const fromSubject = pickFirstTrimmed(
        target?.subject?.product_group_id,
        target?.subject?.productGroupId,
        target?.subject?.id,
        target?.product_group_id,
        target?.productGroupId,
      );
      if (fromSubject) canonicalProductGroupId = fromSubject;
    }
    if (!canonicalProductRef) {
      const fromTargetRef =
        normalizeCanonicalProductRef(target?.canonical_product_ref, {
          requireMerchant: true,
          allowOpaqueProductId: false,
        }) ||
        normalizeCanonicalProductRef(target?.product_ref, {
          requireMerchant: true,
          allowOpaqueProductId: false,
        });
      if (fromTargetRef) canonicalProductRef = fromTargetRef;
    }
  }

  return { canonicalProductRef, canonicalProductGroupId };
}

function tokenize(value) {
  return uniqCaseInsensitiveStrings(
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\+/g, ' plus ')
      .replace(/%/g, ' percent ')
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .split(/\s+/),
    120,
  );
}

function overlapScore(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits += 1;
  }
  return hits / Math.max(1, Math.min(a.size, b.size));
}

function buildPivotaHeaders() {
  if (!PIVOTA_BACKEND_AGENT_API_KEY) return {};
  return {
    'X-API-Key': PIVOTA_BACKEND_AGENT_API_KEY,
    Authorization: `Bearer ${PIVOTA_BACKEND_AGENT_API_KEY}`,
  };
}

function extractProductsFromSearchResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.products)) return raw.products;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.results)) return raw.results;
  if (isPlainObject(raw.data)) {
    if (Array.isArray(raw.data.products)) return raw.data.products;
    if (Array.isArray(raw.data.items)) return raw.data.items;
    if (Array.isArray(raw.data.results)) return raw.data.results;
  }
  return [];
}

function normalizeProductType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const aliasMap = {
    cleanser: 'cleanser',
    toner: 'toner',
    essence: 'essence',
    serum: 'serum',
    ampoule: 'serum',
    moisturizer: 'moisturizer',
    moisturiser: 'moisturizer',
    cream: 'moisturizer',
    lotion: 'moisturizer',
    sunscreen: 'sunscreen',
    spf: 'sunscreen',
    treatment: 'treatment',
    retinol: 'treatment',
    mask: 'mask',
    oil: 'oil',
  };
  if (aliasMap[raw]) return aliasMap[raw];
  for (const [step, aliases] of Object.entries(STEP_ALIASES)) {
    if (aliases.some((alias) => raw.includes(String(alias).toLowerCase()))) return step;
  }
  return null;
}

function inferSlotForStep(step) {
  const normalized = normalizeProductType(step);
  if (normalized === 'sunscreen') return 'am';
  if (normalized === 'mask' || normalized === 'treatment') return 'pm';
  return 'other';
}

function normalizeSeed(rawSeed, index) {
  const seed = isPlainObject(rawSeed) ? rawSeed : {};
  const brand = pickFirstTrimmed(seed.brand);
  const name = pickFirstTrimmed(seed.name, seed.product_name, seed.title, seed.display_name, seed.displayName);
  if (!name) return null;
  const productType = normalizeProductType(seed.product_type) || normalizeProductType(seed.step) || pickFirstTrimmed(seed.product_type, seed.step) || null;
  const why = isPlainObject(seed.why)
    ? {
        en: pickFirstTrimmed(seed.why.en, seed.why.text_en, seed.why.text) || 'Suggested for this request.',
        zh: pickFirstTrimmed(seed.why.zh, seed.why.text_zh) || null,
      }
    : {
        en: pickFirstTrimmed(seed.why) || 'Suggested for this request.',
        zh: null,
      };
  const searchAliases = uniqCaseInsensitiveStrings([
    joinBrandAndName(brand, name),
    name,
    ...(Array.isArray(seed.search_aliases) ? seed.search_aliases : []),
  ], 10);
  const seedId = `seed_${index + 1}_${crypto.createHash('sha1').update(searchAliases.join('|') || name).digest('hex').slice(0, 10)}`;
  return {
    seed_id: seedId,
    brand: brand || null,
    name,
    product_type: productType,
    why,
    suitability_score: normalizeScore(seed.suitability_score, 0.72),
    price_tier: pickFirstTrimmed(seed.price_tier) || null,
    search_aliases: searchAliases,
  };
}

function normalizeProduct(raw) {
  const base = isPlainObject(raw) ? raw : {};
  const productId = pickFirstTrimmed(
    base.product_id,
    base.productId,
    base.id,
    base.product?.product_id,
    base.product?.productId,
  );
  const merchantId = pickFirstTrimmed(
    base.merchant_id,
    base.merchantId,
    isPlainObject(base.merchant) ? base.merchant.merchant_id : '',
    isPlainObject(base.merchant) ? base.merchant.id : '',
    base.product?.merchant_id,
    base.product?.merchantId,
    isPlainObject(base.product?.merchant) ? base.product.merchant.merchant_id : '',
  );
  const brand = pickFirstTrimmed(
    base.brand,
    base.brand_name,
    base.brandName,
    base.vendor,
    isPlainObject(base.vendor) ? base.vendor.name : '',
    base.product?.brand,
    base.product?.brand_name,
    base.product?.brandName,
  );
  const name = pickFirstTrimmed(
    base.name,
    base.title,
    base.display_name,
    base.displayName,
    base.product?.name,
    base.product?.title,
    base.product?.display_name,
    base.product?.displayName,
  );
  const displayName = pickFirstTrimmed(base.display_name, base.displayName, name);
  const productGroupId = pickFirstTrimmed(
    base.product_group_id,
    base.productGroupId,
    isPlainObject(base.subject) ? base.subject.product_group_id : '',
    isPlainObject(base.subject) ? base.subject.id : '',
    base.product?.product_group_id,
    base.product?.productGroupId,
  );
  const categoryPath = Array.isArray(base.category_path)
    ? base.category_path.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const category = pickFirstTrimmed(
    base.category,
    base.category_name,
    base.categoryName,
    base.product_type,
    base.productType,
    isPlainObject(base.subject) ? base.subject.category : '',
    base.product?.category,
    base.product?.product_type,
    base.product?.productType,
    categoryPath[categoryPath.length - 1],
  );
  const imageUrl = pickFirstTrimmed(
    base.image_url,
    base.imageUrl,
    base.thumbnail_url,
    base.thumbnailUrl,
    base.product?.image_url,
    base.product?.imageUrl,
    base.product?.thumbnail_url,
    base.product?.thumbnailUrl,
  );
  const pdpUrl = pickFirstTrimmed(
    base.canonical_pdp_url,
    base.canonicalPdpUrl,
    base.pdp_url,
    base.pdpUrl,
    base.url,
    base.product_url,
    base.productUrl,
    base.link,
    base.purchase_path,
    base.purchasePath,
    base.product?.canonical_pdp_url,
    base.product?.canonicalPdpUrl,
    base.product?.pdp_url,
    base.product?.pdpUrl,
    base.product?.url,
    base.product?.product_url,
    base.product?.productUrl,
  );
  const canonicalProductRef = normalizeCanonicalProductRef(
    isPlainObject(base.canonical_product_ref)
      ? base.canonical_product_ref
      : isPlainObject(base.canonicalProductRef)
        ? base.canonicalProductRef
        : isPlainObject(base.product_ref)
          ? base.product_ref
          : isPlainObject(base.productRef)
            ? base.productRef
            : isPlainObject(base.product?.canonical_product_ref)
              ? base.product.canonical_product_ref
              : isPlainObject(base.product?.canonicalProductRef)
                ? base.product.canonicalProductRef
                : isPlainObject(base.pdp_open?.product_ref)
                  ? base.pdp_open.product_ref
      : { product_id: productId, merchant_id: merchantId },
    { requireMerchant: true, allowOpaqueProductId: false },
  );
  const tags = uniqCaseInsensitiveStrings([
    ...(Array.isArray(base.tags) ? base.tags : []),
    ...(Array.isArray(base.skin_type_tags) ? base.skin_type_tags : []),
    ...(Array.isArray(base.topic_keywords) ? base.topic_keywords : []),
  ], 16);
  const ingredients = uniqCaseInsensitiveStrings([
    ...(Array.isArray(base.ingredients) ? base.ingredients : []),
    ...(Array.isArray(base.inci_list) ? base.inci_list : []),
    ...(Array.isArray(base.inciList) ? base.inciList : []),
    ...(Array.isArray(base.ingredient_tokens) ? base.ingredient_tokens : []),
  ], 32);

  if (!name && !displayName && !productId && !productGroupId && !canonicalProductRef) return null;
  return {
    product_id: productId || canonicalProductRef?.product_id || '',
    merchant_id: merchantId || canonicalProductRef?.merchant_id || '',
    brand: brand || null,
    name: name || displayName || '',
    display_name: displayName || name || '',
    ...(productGroupId ? { product_group_id: productGroupId } : {}),
    category: category || null,
    product_type: normalizeProductType(category) || pickFirstTrimmed(base.product_type, base.productType) || null,
    category_path: categoryPath,
    image_url: imageUrl || null,
    pdp_url: pdpUrl || null,
    canonical_product_ref: canonicalProductRef,
    tags,
    ingredients,
    ...(isPlainObject(base.pdp_open) ? { pdp_open: base.pdp_open } : {}),
    ...(pickFirstTrimmed(base.source, base.source_type, base.sourceType) ? { source: pickFirstTrimmed(base.source, base.source_type, base.sourceType) } : {}),
    ...(pickFirstTrimmed(base.retrieval_source, base.retrievalSource) ? { retrieval_source: pickFirstTrimmed(base.retrieval_source, base.retrievalSource) } : {}),
    ...(pickFirstTrimmed(base.retrieval_reason, base.retrievalReason) ? { retrieval_reason: pickFirstTrimmed(base.retrieval_reason, base.retrievalReason) } : {}),
  };
}

function normalizeConcernTerms(rawValues) {
  return uniqCaseInsensitiveStrings(
    (Array.isArray(rawValues) ? rawValues : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .flatMap((value) => value.split(/[|,/;]+/g).map((token) => token.trim()).filter(Boolean)),
    8,
  );
}

function collectSeedSignalTerms(seed, { targetIngredient, concerns = [] } = {}) {
  return uniqCaseInsensitiveStrings([
    ...(targetIngredient ? [targetIngredient] : []),
    ...normalizeConcernTerms(concerns),
    localizeText(seed?.why, 'EN'),
    localizeText(seed?.why, 'CN'),
    seed?.product_type,
    seed?.name,
    ...(Array.isArray(seed?.search_aliases) ? seed.search_aliases : []),
  ], 16);
}

function productText(product) {
  const row = isPlainObject(product) ? product : {};
  return [
    row.brand,
    row.name,
    row.display_name,
    row.category,
    row.product_type,
    ...(Array.isArray(row.category_path) ? row.category_path : []),
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.ingredients) ? row.ingredients : []),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
}

function isSkincareCandidate(product) {
  const joined = productText(product);
  if (!joined) return false;
  if (SKINCARE_BLOCK_RE.test(joined)) return false;
  return SKINCARE_ALLOW_RE.test(joined);
}

function stepCompatibilityScore(product, targetStep, seedStep) {
  const desired = normalizeProductType(targetStep) || normalizeProductType(seedStep);
  if (!desired) return isSkincareCandidate(product) ? 0.5 : 0;
  const joined = productText(product).toLowerCase();
  const aliases = STEP_ALIASES[desired] || [];
  if (normalizeProductType(product.product_type) === desired) return 1;
  if (normalizeProductType(product.category) === desired) return 1;
  if (aliases.some((alias) => joined.includes(String(alias).toLowerCase()))) return 1;
  return 0;
}

function ingredientSignalScore(product, targetIngredient) {
  const query = String(targetIngredient || '').trim().toLowerCase();
  if (!query) return 0.2;
  const joined = productText(product).toLowerCase();
  if (!joined) return 0;
  return joined.includes(query) ? 1 : 0;
}

function concernSignalScore(product, concernTerms = []) {
  const joined = productText(product).toLowerCase();
  if (!joined) return 0;
  const terms = normalizeConcernTerms(concernTerms);
  if (!terms.length) return 0.15;
  let best = 0;
  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (!normalized) continue;
    if (joined.includes(normalized)) return 1;
    best = Math.max(best, overlapScore(normalized, joined));
  }
  return best;
}

function scoreFuzzyCandidate({ seed, product, targetStep, targetIngredient, concerns = [] }) {
  if (!product || !isSkincareCandidate(product)) return 0;
  const stepScore = stepCompatibilityScore(product, targetStep, seed.product_type);
  if (targetStep && stepScore <= 0) return 0;

  const desiredName = joinBrandAndName(seed.brand, seed.name);
  const nameScore = Math.max(
    overlapScore(desiredName, joinBrandAndName(product.brand, product.name)),
    ...seed.search_aliases.map((alias) => overlapScore(alias, joinBrandAndName(product.brand, product.name))),
  );
  const ingredientScore = ingredientSignalScore(product, targetIngredient);
  const concernScore = concernSignalScore(product, concerns);
  const brandScore = seed.brand && product.brand && String(seed.brand).trim().toLowerCase() === String(product.brand).trim().toLowerCase() ? 1 : 0;
  const score = (stepScore * 0.35) + (nameScore * 0.25) + (ingredientScore * 0.2) + (concernScore * 0.15) + (brandScore * 0.05);
  return Math.max(0, Math.min(1, score));
}

function buildResolveQueries(seed) {
  return uniqCaseInsensitiveStrings([
    joinBrandAndName(seed.brand, seed.name),
    seed.name,
    ...seed.search_aliases,
  ], 8);
}

function buildSearchQueries(seed, { targetStep, targetIngredient, concerns = [] } = {}) {
  const desiredStep = normalizeProductType(targetStep) || normalizeProductType(seed.product_type);
  const stepAliases = desiredStep ? (STEP_ALIASES[desiredStep] || []).slice(0, 4) : [];
  const concernTerms = normalizeConcernTerms(concerns).slice(0, 3);
  const signalTerms = collectSeedSignalTerms(seed, { targetIngredient, concerns })
    .filter((term) => String(term || '').trim().split(/\s+/).length <= 4)
    .slice(0, 4);
  return uniqCaseInsensitiveStrings([
    seed.name,
    joinBrandAndName(seed.brand, seed.name),
    ...seed.search_aliases,
    ...signalTerms,
    ...(seed.brand && desiredStep ? [`${seed.brand} ${desiredStep}`] : []),
    ...stepAliases,
    ...(targetIngredient && desiredStep ? [`${targetIngredient} ${desiredStep}`, `${desiredStep} ${targetIngredient}`] : []),
    ...concernTerms.flatMap((term) => desiredStep ? [`${term} ${desiredStep}`] : [term]),
  ], 8);
}

async function defaultResolveProduct({ query, lang, hints }) {
  if (!PIVOTA_BACKEND_BASE_URL) {
    return { ok: false, reason: 'pivota_backend_not_configured', transient: false, product: null };
  }
  const hintBrand = pickFirstTrimmed(hints?.brand);
  const hintTitle = pickFirstTrimmed(hints?.title, hints?.name);
  const hintDisplayName = joinBrandAndName(hintBrand, hintTitle) || hintTitle || query;
  const resolvePayload = {
    query,
    lang: String(lang || 'EN').toUpperCase() === 'CN' ? 'zh' : 'en',
    options: {
      search_all_merchants: true,
      timeout_ms: RESOLVE_TIMEOUT_MS,
      upstream_retries: 0,
      stable_alias_short_circuit: true,
      allow_stable_alias_for_uuid: true,
    },
    ...(isPlainObject(hints) ? { hints } : {}),
    caller: 'aurora_chatbox',
  };

  if (PIVOTA_BACKEND_AGENT_API_KEY) {
    let offerResp = null;
    let offerErr = null;
    try {
      offerResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/agent/shop/v1/invoke`,
        {
          operation: 'offers.resolve',
          payload: {
            product: {
              ...(hintBrand ? { brand: hintBrand } : {}),
              ...(hintTitle ? { name: hintTitle, display_name: hintDisplayName } : {}),
              ...(query ? { query } : {}),
            },
            ...(query ? { query } : {}),
          },
        },
        {
          headers: buildPivotaHeaders(),
          timeout: SHOP_INVOKE_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
    } catch (error) {
      offerErr = error;
    }

    const offerBody = isPlainObject(offerResp?.data) ? offerResp.data : null;
    const offerStatus = Number.isFinite(Number(offerResp?.status)) ? Math.trunc(Number(offerResp.status)) : 0;
    if (offerStatus === 200 && String(offerBody?.status || '').trim().toLowerCase() === 'success') {
      const { canonicalProductRef, canonicalProductGroupId } = extractCanonicalFromOffersResolveBody(offerBody);
      if (canonicalProductRef || canonicalProductGroupId) {
        return {
          ok: true,
          reason: null,
          transient: false,
          product: {
            ...(canonicalProductRef ? {
              product_id: canonicalProductRef.product_id,
              merchant_id: canonicalProductRef.merchant_id,
              canonical_product_ref: canonicalProductRef,
            } : {}),
            ...(canonicalProductGroupId ? { product_group_id: canonicalProductGroupId } : {}),
            ...(hintBrand ? { brand: hintBrand } : {}),
            name: hintTitle || query,
            display_name: hintDisplayName,
          },
        };
      }
    }

    const offerReason = mapOfferResolveFailureCode({
      responseBody: offerBody,
      statusCode: offerStatus,
      error: offerErr,
    });
    if (offerReason === 'upstream_timeout' || offerReason === 'db_error') {
      return { ok: false, reason: offerReason, transient: true, product: null };
    }
  }

  try {
    const resp = await axios.post(`${PIVOTA_BACKEND_BASE_URL}/agent/v1/products/resolve`, resolvePayload, {
      headers: buildPivotaHeaders(),
      timeout: RESOLVE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const body = isPlainObject(resp.data) ? resp.data : {};
    const normalized = normalizeProduct(
      body.product || body.candidate || (Array.isArray(body.candidates) ? body.candidates[0] : null),
    );
    const ref = normalizeCanonicalProductRef(
      body.product_ref || body.canonical_product_ref || normalized?.canonical_product_ref || null,
      { requireMerchant: true, allowOpaqueProductId: false },
    );
    if (resp.status === 200 && body.resolved === true && ref) {
      return {
        ok: true,
        reason: null,
        transient: false,
        product: {
          ...(normalized || {}),
          ...(ref ? { product_id: ref.product_id, merchant_id: ref.merchant_id, canonical_product_ref: ref } : {}),
        },
      };
    }
    const failureReason = mapResolveFailureCode({ resolveBody: body, statusCode: resp.status });
    const transient = failureReason === 'upstream_timeout' || failureReason === 'db_error';
    return { ok: false, reason: failureReason, transient, product: null };
  } catch (error) {
    const failureReason = mapResolveFailureCode({ error });
    const transient = failureReason === 'upstream_timeout' || failureReason === 'db_error';
    return { ok: false, reason: failureReason, transient, product: null };
  }
}

async function defaultSearchProducts({ query }) {
  if (!PIVOTA_BACKEND_BASE_URL) {
    return { ok: false, reason: 'pivota_backend_not_configured', transient: false, products: [] };
  }

  const paths = ['/agent/v1/beauty/products/search', '/agent/v1/products/search'];
  for (const path of paths) {
    try {
      const resp = await axios.get(`${PIVOTA_BACKEND_BASE_URL}${path}`, {
        headers: buildPivotaHeaders(),
        timeout: SEARCH_TIMEOUT_MS,
        validateStatus: () => true,
        params: {
          query,
          search_all_merchants: true,
          in_stock_only: false,
          limit: SEARCH_LIMIT,
          offset: 0,
          source: 'aurora-bff',
          allow_external_seed: false,
          fast_mode: true,
        },
      });
      if (resp.status === 404) continue;
      if (resp.status !== 200) {
        const transient = resp.status === 408 || resp.status === 429 || resp.status === 500 || resp.status === 502 || resp.status === 503 || resp.status === 504;
        return { ok: false, reason: transient ? 'search_transient' : 'search_error', transient, products: [] };
      }
      const products = extractProductsFromSearchResponse(resp.data)
        .map((product) => normalizeProduct(product))
        .filter(Boolean);
      return { ok: true, reason: null, transient: false, products };
    } catch (error) {
      const message = String(error?.message || '');
      const transient = /timeout|econnaborted|network|socket/i.test(message);
      return { ok: false, reason: transient ? 'search_transient' : 'search_error', transient, products: [] };
    }
  }
  return { ok: true, reason: null, transient: false, products: [] };
}

function buildRawSeedRow(seed, { lang, targetStep }) {
  const query = joinBrandAndName(seed.brand, seed.name) || seed.search_aliases[0] || seed.name;
  const step = normalizeProductType(targetStep) || seed.product_type || 'other';
  return {
    ...(seed.brand ? { brand: seed.brand } : {}),
    name: seed.name,
    display_name: joinBrandAndName(seed.brand, seed.name) || seed.name,
    category: seed.product_type || step,
    step,
    slot: inferSlotForStep(step),
    reasons: [localizeText(seed.why, lang) || (lang === 'CN' ? '基于你的问题给出的候选。' : 'Suggested for your request.')],
    match_state: 'llm_seed',
    llm_suggestion: {
      brand: seed.brand,
      name: seed.name,
      product_type: seed.product_type,
      why: seed.why,
      suitability_score: seed.suitability_score,
      price_tier: seed.price_tier,
      search_aliases: seed.search_aliases,
    },
    pdp_open: {
      path: 'external',
      resolve_reason_code: 'NO_CANDIDATES',
      external: { query, url: null },
    },
    metadata: {
      match_state: 'llm_seed',
      llm_seed_id: seed.seed_id,
      pdp_open_path: 'external',
      resolve_reason_code: 'NO_CANDIDATES',
      source_mode: 'llm_catalog_hybrid',
    },
  };
}

function buildInternalRow(seed, product, { lang, targetStep, matchState }) {
  const step = normalizeProductType(targetStep) || seed.product_type || normalizeProductType(product.product_type) || normalizeProductType(product.category) || 'other';
  const why = localizeText(seed.why, lang);
  const exactLabel = String(matchState || '').toLowerCase() === 'exact'
    ? (lang === 'CN' ? 'Pivota 商品库精确匹配' : 'Exact Pivota catalog match')
    : (lang === 'CN' ? 'Pivota 商品库相似匹配' : 'Similar Pivota catalog match');
  const canonicalProductRef = normalizeCanonicalProductRef(product.canonical_product_ref || product.product_ref || null, {
    requireMerchant: true,
    allowOpaqueProductId: false,
  });
  const subjectProductGroupId = pickFirstTrimmed(product.product_group_id, product.subject_product_group_id);
  const pdpOpen = isPlainObject(product.pdp_open)
    ? product.pdp_open
    : subjectProductGroupId
      ? {
          path: 'group',
          subject: { type: 'product_group', id: subjectProductGroupId, product_group_id: subjectProductGroupId },
          get_pdp_v2_payload: { subject: { type: 'product_group', id: subjectProductGroupId } },
        }
      : canonicalProductRef
        ? {
            path: 'ref',
            product_ref: canonicalProductRef,
            get_pdp_v2_payload: { product_ref: canonicalProductRef },
          }
        : null;
  return {
    ...(product.product_id ? { product_id: product.product_id } : {}),
    ...(product.merchant_id ? { merchant_id: product.merchant_id } : {}),
    ...(subjectProductGroupId ? { subject_product_group_id: subjectProductGroupId, product_group_id: subjectProductGroupId } : {}),
    ...(canonicalProductRef ? { canonical_product_ref: canonicalProductRef } : {}),
    ...(product.brand ? { brand: product.brand } : {}),
    name: product.name || seed.name,
    display_name: joinBrandAndName(product.brand, product.name || seed.name) || product.display_name || seed.name,
    ...(product.image_url ? { image_url: product.image_url } : {}),
    ...(product.pdp_url ? { pdp_url: product.pdp_url, url: product.pdp_url } : {}),
    category: product.category || seed.product_type || step,
    step,
    slot: inferSlotForStep(step),
    reasons: uniqCaseInsensitiveStrings([why, exactLabel], 4),
    match_state: matchState,
    llm_suggestion: {
      brand: seed.brand,
      name: seed.name,
      product_type: seed.product_type,
      why: seed.why,
      suitability_score: seed.suitability_score,
      price_tier: seed.price_tier,
      search_aliases: seed.search_aliases,
    },
    metadata: {
      match_state: matchState,
      llm_seed_id: seed.seed_id,
      source_mode: 'llm_catalog_hybrid',
    },
    ...(pdpOpen ? { pdp_open: pdpOpen } : {}),
  };
}

function makeProductKey(product) {
  if (!product) return '';
  const productGroupId = pickFirstTrimmed(product.product_group_id, product.subject_product_group_id);
  if (productGroupId) return `group:${productGroupId}`;
  const ref = normalizeCanonicalProductRef(product.canonical_product_ref || product.canonicalProductRef || null, {
    requireMerchant: true,
    allowOpaqueProductId: false,
  });
  if (ref) return `${ref.product_id}:${ref.merchant_id}`;
  const productId = pickFirstTrimmed(product.product_id, product.productId);
  const merchantId = pickFirstTrimmed(product.merchant_id, product.merchantId);
  if (productId && merchantId && !isUuidLikeString(productId)) return `${productId}:${merchantId}`;
  const nameKey = joinBrandAndName(product.brand, product.name || product.display_name);
  if (nameKey) return `name:${nameKey.toLowerCase()}`;
  return '';
}

function seedSeemsCompatible(seed, { targetStep }) {
  const desired = normalizeProductType(targetStep);
  if (!desired) return true;
  const joined = [
    seed.product_type,
    seed.name,
    seed.brand,
    ...seed.search_aliases,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const aliases = STEP_ALIASES[desired] || [];
  return (
    normalizeProductType(seed.product_type) === desired ||
    aliases.some((alias) => joined.includes(String(alias).toLowerCase()))
  );
}

async function resolveExactMatch(seed, { lang, resolveProduct, targetStep }) {
  for (const query of buildResolveQueries(seed)) {
    const result = await resolveProduct({
      query,
      lang,
      hints: {
        ...(seed.brand ? { brand: seed.brand } : {}),
        ...(seed.name ? { title: seed.name } : {}),
      },
    });
    if (result?.ok && result.product && isSkincareCandidate(result.product) && stepCompatibilityScore(result.product, targetStep, seed.product_type) > 0) {
      return { product: result.product, transientFailure: false };
    }
    if (result?.transient) {
      return { product: null, transientFailure: true };
    }
  }
  return { product: null, transientFailure: false };
}

async function resolveFuzzyMatches(seed, { lang, searchProducts, targetStep, targetIngredient, concerns = [] }) {
  const candidates = [];
  const seen = new Set();
  let queryCount = 0;
  for (const query of buildSearchQueries(seed, { targetStep, targetIngredient, concerns })) {
    queryCount += 1;
    const result = await searchProducts({ query, lang, limit: SEARCH_LIMIT });
    if (result?.transient) {
      return { products: [], transientFailure: true, queryCount };
    }
    if (!result?.ok) continue;
    for (const raw of Array.isArray(result.products) ? result.products : []) {
      const product = normalizeProduct(raw);
      if (!product || !isSkincareCandidate(product)) continue;
      const key = makeProductKey(product);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const score = scoreFuzzyCandidate({ seed, product, targetStep, targetIngredient, concerns });
      if (score < FUZZY_THRESHOLD) continue;
      candidates.push({ product, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  return {
    transientFailure: false,
    products: candidates.slice(0, 2).map((item) => item.product),
    queryCount,
  };
}

async function runRecoHybridResolveCandidates({ request, candidateOutput, logger, deps } = {}) {
  const lang = normalizeLang(request?.context?.locale);
  const targetStep = String(request?.params?.target_step || '').trim();
  const targetIngredient = String(request?.params?.target_ingredient || '').trim();
  const concerns = normalizeConcernTerms([
    ...(Array.isArray(request?.params?._extracted_concerns) ? request.params._extracted_concerns : []),
    ...(Array.isArray(request?.context?.profile?.concerns) ? request.context.profile.concerns : []),
    ...(Array.isArray(request?.context?.profile?.goals) ? request.context.profile.goals : []),
  ]);
  const resolveProduct = typeof deps?.resolveProduct === 'function' ? deps.resolveProduct : defaultResolveProduct;
  const searchProducts = typeof deps?.searchProducts === 'function' ? deps.searchProducts : defaultSearchProducts;
  const rawSeeds = Array.isArray(candidateOutput?.products) ? candidateOutput.products : [];
  const seeds = rawSeeds
    .map((seed, index) => normalizeSeed(seed, index))
    .filter(Boolean)
    .filter((seed) => seedSeemsCompatible(seed, { targetStep }))
    .slice(0, MAX_SEEDS);

  const rows = [];
  const seenKeys = new Set();
  let exactMatchCount = 0;
  let fuzzyMatchCount = 0;
  let unresolvedSeedCount = 0;
  let queryCount = 0;

  for (const seed of seeds) {
    let exact = null;
    let exactTransientFailure = false;
    try {
      const resolved = await resolveExactMatch(seed, { lang, resolveProduct, targetStep });
      exact = resolved.product;
      exactTransientFailure = resolved.transientFailure;
    } catch (error) {
      logger?.warn?.({ err: error?.message || String(error), seed: seed.name }, 'aurora reco hybrid exact resolve failed');
      exactTransientFailure = true;
    }

    if (exact) {
      const exactRow = buildInternalRow(seed, exact, { lang, targetStep, matchState: 'exact' });
      const key = makeProductKey(exactRow);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        rows.push(exactRow);
        exactMatchCount += 1;
      }
      continue;
    }

    if (exactTransientFailure) {
      rows.push(buildRawSeedRow(seed, { lang, targetStep }));
      unresolvedSeedCount += 1;
      continue;
    }

    let fuzzyProducts = [];
    let fuzzyTransientFailure = false;
    try {
      const fuzzy = await resolveFuzzyMatches(seed, { lang, searchProducts, targetStep, targetIngredient, concerns });
      fuzzyProducts = fuzzy.products;
      fuzzyTransientFailure = fuzzy.transientFailure;
      queryCount += Number.isFinite(Number(fuzzy.queryCount)) ? Math.trunc(Number(fuzzy.queryCount)) : 0;
    } catch (error) {
      logger?.warn?.({ err: error?.message || String(error), seed: seed.name }, 'aurora reco hybrid fuzzy search failed');
      fuzzyTransientFailure = true;
    }

    if (fuzzyTransientFailure) {
      rows.push(buildRawSeedRow(seed, { lang, targetStep }));
      unresolvedSeedCount += 1;
      continue;
    }

    if (fuzzyProducts.length > 0) {
      const primary = buildInternalRow(seed, fuzzyProducts[0], { lang, targetStep, matchState: 'fuzzy' });
      const key = makeProductKey(primary);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        rows.push(primary);
        fuzzyMatchCount += 1;
      }
      rows.push(buildRawSeedRow(seed, { lang, targetStep }));
      continue;
    }

    rows.push(buildRawSeedRow(seed, { lang, targetStep }));
    unresolvedSeedCount += 1;
  }

  return {
    rows: rows.slice(0, 12),
    recommendation_meta: {
      source_mode: 'llm_catalog_hybrid',
      llm_seed_count: seeds.length,
      exact_match_count: exactMatchCount,
      fuzzy_match_count: fuzzyMatchCount,
      unresolved_seed_count: unresolvedSeedCount,
      target_step: targetStep || null,
      target_ingredient: targetIngredient || null,
      query_count: queryCount,
    },
  };
}

module.exports = {
  runRecoHybridResolveCandidates,
  __internal: {
    normalizeLang,
    normalizeSeed,
    normalizeProduct,
    normalizeProductType,
    normalizeCanonicalProductRef,
    isSkincareCandidate,
    scoreFuzzyCandidate,
    buildRawSeedRow,
    buildInternalRow,
    makeProductKey,
    resolveExactMatch,
    resolveFuzzyMatches,
    seedSeemsCompatible,
  },
};
