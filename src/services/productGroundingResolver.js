const axios = require('axios');
const { withClient } = require('../db');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const LATIN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'have',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'with',
  'you',
  'your',
]);
const SUPPORTED_SCORING_VERSIONS = new Set(['v1', 'v2']);
const DEFAULT_SCORING_VERSION = normalizeScoringVersion(
  process.env.PRODUCT_GROUNDING_SCORING_VERSION || process.env.AURORA_PRODUCT_GROUNDING_SCORING_VERSION,
  'v1',
);
const V2_QUERY_NOISE_TOKENS = new Set([
  'any',
  'available',
  'buy',
  'can',
  'could',
  'did',
  'do',
  'does',
  'find',
  'in',
  'instock',
  'need',
  'please',
  'product',
  'products',
  'sell',
  'selling',
  'stock',
  'where',
  'with',
]);
const HAS_HAN_RE = /[\u4E00-\u9FFF]/;
const CJK_QUERY_PREFIX_RE = /^(?:有没有|有无|有沒|有没|是否有|请问|能不能|可以|想买|想要|哪里买|怎么买)/;
const CJK_QUERY_SUFFIX_RE = /(?:吗|呢|呀|吧|嘛)$/;
const NUMERIC_ONLY_RE = /^\d+(?:\.\d+)?$/;
const NUMERIC_WITH_UNIT_RE = /^(\d+(?:\.\d+)?)(ml|l|g|kg|oz)$/i;
const SPF_COMPACT_RE = /^spf(\d{1,3})$/i;
const ALNUM_MODEL_RE = /^(?=.*[a-z])(?=.*\d)[a-z0-9]{4,16}$/i;
const V2_BRAND_ALIAS_RULES = [
  { canonical: 'la roche posay', aliases: ['la roche posay', 'larocheposay', 'lrp', '理肤泉'] },
  { canonical: 'sk ii', aliases: ['sk ii', 'sk2', 'skii', '神仙水'] },
  { canonical: 'the ordinary', aliases: ['the ordinary', 'ordinary', 'to'] },
  { canonical: 'paulas choice', aliases: ['paulas choice', 'paulaschoice', '宝拉珍选'] },
  { canonical: 'cerave', aliases: ['cerave', 'cera ve', '适乐肤'] },
  { canonical: 'winona', aliases: ['winona', '薇诺娜', 'wei nuo na'] },
];
let V2_BRAND_ALIAS_INDEX = null;

function normalizeScoringVersion(raw, fallback = 'v1') {
  const normalized = String(raw || '').trim().toLowerCase();
  if (SUPPORTED_SCORING_VERSIONS.has(normalized)) return normalized;
  return fallback;
}

function resolveScoringVersionFromOptions(options, fallback = DEFAULT_SCORING_VERSION) {
  const opt = options && typeof options === 'object' ? options : {};
  const raw = opt.scoring_version ?? opt.scoringVersion ?? fallback;
  return normalizeScoringVersion(raw, fallback);
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function firstNonEmptyString(...values) {
  for (const raw of values) {
    const s = String(raw || '').trim();
    if (s) return s;
  }
  return '';
}

function isUuidLike(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.trim());
}

function extractResolverHints(hints) {
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
    return {
      product_ref: null,
      aliases: [],
      brand: null,
    };
  }

  const hintObj = hints;
  const hintRefRaw =
    (hintObj.product_ref && typeof hintObj.product_ref === 'object' ? hintObj.product_ref : null) ||
    (hintObj.productRef && typeof hintObj.productRef === 'object' ? hintObj.productRef : null) ||
    (hintObj.target && typeof hintObj.target === 'object' ? hintObj.target : null);

  const hintProductId = firstNonEmptyString(
    hintRefRaw?.product_id,
    hintRefRaw?.productId,
    hintObj.product_id,
    hintObj.productId,
    hintObj.id,
  );
  const hintMerchantId = firstNonEmptyString(
    hintRefRaw?.merchant_id,
    hintRefRaw?.merchantId,
    hintObj.merchant_id,
    hintObj.merchantId,
    hintObj.merchant && typeof hintObj.merchant === 'object' ? hintObj.merchant.merchant_id : null,
  );
  const productRef = hintProductId
    ? {
        product_id: hintProductId,
        ...(hintMerchantId ? { merchant_id: hintMerchantId } : {}),
      }
    : null;

  const brand = firstNonEmptyString(hintObj.brand, hintObj.vendor) || null;
  const name = firstNonEmptyString(
    hintObj.name,
    hintObj.title,
    hintObj.display_name,
    hintObj.displayName,
    hintObj.product_name,
    hintObj.productName,
  );
  const explicitQuery = firstNonEmptyString(hintObj.query);

  const aliases = [];
  const seen = new Set();
  const pushAlias = (value) => {
    const s = String(value || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(s);
  };

  pushAlias(name);
  if (brand && name) pushAlias(`${brand} ${name}`);
  pushAlias(explicitQuery);

  if (Array.isArray(hintObj.aliases)) {
    for (const alias of hintObj.aliases) {
      pushAlias(alias);
      if (aliases.length >= 8) break;
    }
  }

  return {
    product_ref: productRef,
    aliases: aliases.slice(0, 8),
    brand,
  };
}

function normalizeTextForResolver(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  // Normalizations:
  // - NFKC collapses full-width variants (e.g. Chinese punctuation, full-width digits).
  // - Map common symbols to lexical tokens so "+" and "%" can match across variants.
  // - Keep unicode letters/numbers (including CJK), drop other punctuation.
  const normalized = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[＋+]/g, ' plus ')
    .replace(/[%％]/g, ' percent ')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

function tokenizeNormalizedResolverQuery(normalized) {
  const s = String(normalized || '').trim();
  if (!s) return [];
  const parts = s.split(/\s+/g).filter(Boolean);
  if (!parts.length) return [];

  const out = [];
  const seen = new Set();
  for (const tok of parts) {
    const t = String(tok || '').trim();
    if (!t) continue;

    const isNumeric = /^[0-9]+$/.test(t);
    const isLatin = /^[a-z0-9]+$/.test(t);
    if (isLatin && !isNumeric) {
      if (LATIN_STOPWORDS.has(t)) continue;
      if (t.length < 2) continue;
    }

    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }

  return out;
}

function compactNoSpaces(s) {
  return String(s || '').replace(/\s+/g, '');
}

function stripCommonCjkQueryAffixes(compact) {
  const s = String(compact || '');
  if (!s) return '';
  return s.replace(CJK_QUERY_PREFIX_RE, '').replace(CJK_QUERY_SUFFIX_RE, '').replace(/的/g, '');
}

function buildV2BrandAliasIndex() {
  return V2_BRAND_ALIAS_RULES.map((rule) => {
    const canonical = normalizeTextForResolver(rule.canonical);
    const aliases = (Array.isArray(rule.aliases) ? rule.aliases : [])
      .map((alias) => normalizeTextForResolver(alias))
      .filter(Boolean);
    return { canonical, aliases };
  }).filter((entry) => entry.canonical && entry.aliases.length > 0);
}

function getV2BrandAliasIndex() {
  if (V2_BRAND_ALIAS_INDEX) return V2_BRAND_ALIAS_INDEX;
  V2_BRAND_ALIAS_INDEX = buildV2BrandAliasIndex();
  return V2_BRAND_ALIAS_INDEX;
}

function collectCanonicalBrandsFromText(normalizedText) {
  const text = String(normalizedText || '').trim();
  if (!text) return new Set();

  const tokens = new Set(tokenizeNormalizedResolverQuery(text));
  const compactText = compactNoSpaces(text);
  const padded = ` ${text} `;
  const out = new Set();
  for (const rule of getV2BrandAliasIndex()) {
    for (const alias of rule.aliases) {
      if (!alias) continue;
      const aliasHasHan = HAS_HAN_RE.test(alias);
      if (alias.includes(' ')) {
        if (padded.includes(` ${alias} `)) {
          out.add(rule.canonical);
          break;
        }
      } else if (
        tokens.has(alias) ||
        (aliasHasHan && (text.includes(alias) || compactText.includes(compactNoSpaces(alias))))
      ) {
        out.add(rule.canonical);
        break;
      }
    }
  }
  return out;
}

function normalizeNumericValue(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded);
}

function extractNumericSignalsFromTokens(tokens) {
  const signal = {
    volume: new Set(),
    spf: new Set(),
    percent: new Set(),
    model: new Set(),
  };
  const list = Array.isArray(tokens) ? tokens : [];
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i] || '').trim().toLowerCase();
    if (!token) continue;

    const compactSpf = token.match(SPF_COMPACT_RE);
    if (compactSpf && compactSpf[1]) {
      signal.spf.add(compactSpf[1]);
      continue;
    }

    if (token === 'spf' && i + 1 < list.length) {
      const maybeSpf = String(list[i + 1] || '').trim().toLowerCase();
      if (NUMERIC_ONLY_RE.test(maybeSpf)) {
        signal.spf.add(normalizeNumericValue(Number(maybeSpf)));
      }
      continue;
    }

    const unitMatch = token.match(NUMERIC_WITH_UNIT_RE);
    if (unitMatch) {
      signal.volume.add(`${normalizeNumericValue(Number(unitMatch[1]))}${unitMatch[2].toLowerCase()}`);
      continue;
    }

    if (NUMERIC_ONLY_RE.test(token)) {
      const numeric = normalizeNumericValue(Number(token));
      if (i + 1 < list.length && String(list[i + 1] || '').trim().toLowerCase() === 'percent') {
        signal.percent.add(numeric);
      }
      continue;
    }

    if (ALNUM_MODEL_RE.test(token)) {
      signal.model.add(token);
      const prevToken = i > 0 ? String(list[i - 1] || '').trim().toLowerCase() : '';
      if (/^[a-z]{1,4}$/.test(prevToken) && /^\d+[a-z]/.test(token)) {
        const merged = `${prevToken}${token}`;
        if (ALNUM_MODEL_RE.test(merged)) {
          signal.model.add(merged);
        }
      }
    }
  }
  return signal;
}

function countSetIntersection(setA, setB) {
  if (!setA || !setB || setA.size <= 0 || setB.size <= 0) return 0;
  let count = 0;
  for (const v of setA) {
    if (setB.has(v)) count += 1;
  }
  return count;
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function buildV2QueryContext({ normalizedQuery, queryTokens }) {
  const baseTokens = Array.isArray(queryTokens) ? queryTokens : [];
  const filteredTokens = baseTokens.filter((token) => !V2_QUERY_NOISE_TOKENS.has(String(token || '').trim().toLowerCase()));
  const effectiveTokens = filteredTokens.length ? filteredTokens : baseTokens;

  const compactQuery = compactNoSpaces(normalizedQuery);
  const strippedCompactQuery = HAS_HAN_RE.test(compactQuery) ? stripCommonCjkQueryAffixes(compactQuery) : compactQuery;
  const effectiveCompactQuery = String(strippedCompactQuery || compactQuery || '').trim();

  const tokenSet = new Set(effectiveTokens);
  return {
    normalizedQuery,
    queryTokens: effectiveTokens,
    queryTokenSet: tokenSet,
    queryCompact: effectiveCompactQuery,
    queryNumericSignals: extractNumericSignalsFromTokens(effectiveTokens),
    queryCanonicalBrands: collectCanonicalBrandsFromText(normalizedQuery),
  };
}

function buildV2CandidateProfile(product) {
  const title = getCandidateTitle(product);
  const brand = getCandidateBrand(product);
  const combined = `${brand} ${title}`.trim();

  const normalizedTitle = normalizeTextForResolver(title);
  const normalizedBrand = normalizeTextForResolver(brand);
  const normalizedCombined = normalizeTextForResolver(combined);
  const tokenList = tokenizeNormalizedResolverQuery(normalizedCombined);
  const tokenSet = new Set(tokenList);

  return {
    normalizedTitle,
    normalizedBrand,
    normalizedCombined,
    compactCombined: compactNoSpaces(normalizedCombined),
    tokenSet,
    numericSignals: extractNumericSignalsFromTokens(tokenList),
    canonicalBrands: collectCanonicalBrandsFromText(`${normalizedBrand} ${normalizedCombined}`.trim()),
  };
}

function isExternalProduct(product) {
  const mid = String(product?.merchant_id || product?.merchantId || '').trim();
  if (mid === EXTERNAL_SEED_MERCHANT_ID) return true;
  const platform = String(product?.platform || '').trim().toLowerCase();
  if (platform === 'external') return true;
  const source = String(product?.source || product?.source_type || '').trim().toLowerCase();
  if (source === 'external_seed' || source === 'external') return true;
  const pid = String(product?.product_id || product?.productId || product?.id || '').trim();
  return pid.startsWith('ext_');
}

function getCandidateTitle(product) {
  return (
    product?.title ||
    product?.name ||
    product?.display_name ||
    product?.displayName ||
    product?.product_title ||
    product?.productTitle ||
    ''
  );
}

function getCandidateBrand(product) {
  return (
    (product?.brand && typeof product.brand === 'object' ? product.brand.name : null) ||
    product?.brand ||
    product?.vendor ||
    product?.vendor_name ||
    product?.manufacturer ||
    ''
  );
}

function extractProductRef(product) {
  const productId = String(product?.product_id || product?.productId || product?.id || '').trim();
  const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
  if (!productId) return null;
  return {
    product_id: productId,
    ...(merchantId ? { merchant_id: merchantId } : {}),
  };
}

function computeTokenOverlapScore(queryTokens, candidateText) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;
  const blob = normalizeTextForResolver(candidateText);
  if (!blob) return 0;

  const tokens = tokenizeNormalizedResolverQuery(blob);
  if (tokens.length === 0) return 0;
  return computeTokenOverlapScoreFromTokenSet(queryTokens, new Set(tokens));
}

function computeTokenOverlapScoreFromTokenSet(queryTokens, tokenSet) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;
  if (!tokenSet || typeof tokenSet.size !== 'number' || tokenSet.size <= 0) return 0;

  let common = 0;
  for (const t of queryTokens) {
    if (tokenSet.has(t)) common += 1;
  }

  const recall = common / queryTokens.length;
  const precision = common / tokenSet.size;
  const denom = recall + precision;
  const f1 = denom > 0 ? (2 * recall * precision) / denom : 0;

  // F1 is stable for "name-heavy" queries; also preserve recall as a fallback.
  return Math.max(f1, recall * 0.9);
}

function computeCandidateTextScoreV1({ normalizedQuery, queryTokens, product }) {
  if (!normalizedQuery) return 0;

  const title = getCandidateTitle(product);
  const normTitle = normalizeTextForResolver(title);
  if (normTitle && normTitle === normalizedQuery) return { score: 1, reason: 'exact_title' };
  if (normTitle && normTitle.includes(normalizedQuery)) return { score: 0.95, reason: 'title_contains_query' };

  const brand = getCandidateBrand(product);
  const combined = `${brand} ${title}`.trim();
  const normCombined = normalizeTextForResolver(combined);
  if (normCombined && normCombined.includes(normalizedQuery)) return { score: 0.9, reason: 'brand_title_contains_query' };

  const tokens = tokenizeNormalizedResolverQuery(normCombined);
  const score = computeTokenOverlapScoreFromTokenSet(queryTokens, new Set(tokens));
  return { score, reason: 'token_overlap' };
}

function scoreNumericSignalsV2(querySignals, candidateSignals) {
  const specs = [
    { key: 'volume', match: 0.18, mismatch: -0.22, missing: -0.04 },
    { key: 'spf', match: 0.14, mismatch: -0.16, missing: -0.03 },
    { key: 'percent', match: 0.1, mismatch: -0.12, missing: -0.02 },
    { key: 'model', match: 0.08, mismatch: -0.1, missing: 0 },
  ];
  let delta = 0;
  let signal = 0;
  let matched = 0;
  for (const spec of specs) {
    const querySet = querySignals?.[spec.key];
    if (!querySet || querySet.size <= 0) continue;
    const candidateSet = candidateSignals?.[spec.key];
    if (!candidateSet || candidateSet.size <= 0) {
      delta += spec.missing;
      signal += spec.missing;
      continue;
    }
    const common = countSetIntersection(querySet, candidateSet);
    if (common > 0) {
      delta += spec.match;
      signal += spec.match;
      matched += 1;
      continue;
    }
    delta += spec.mismatch;
    signal += spec.mismatch;
  }
  return { delta, signal, matched };
}

function computeCandidateTextScoreV2({ queryContext, candidateProfile }) {
  const normalizedQuery = String(queryContext?.normalizedQuery || '').trim();
  if (!normalizedQuery) return { score: 0, reason: 'empty_query', signal_score: 0 };

  if (candidateProfile.normalizedTitle && candidateProfile.normalizedTitle === normalizedQuery) {
    return { score: 1, reason: 'exact_title_v2', signal_score: 1 };
  }
  if (candidateProfile.normalizedCombined && candidateProfile.normalizedCombined === normalizedQuery) {
    return { score: 1, reason: 'exact_combined_v2', signal_score: 1 };
  }

  let score = computeTokenOverlapScoreFromTokenSet(queryContext.queryTokens, candidateProfile.tokenSet);
  let signalScore = 0;
  let reason = 'token_overlap_v2';

  const commonTokens = countSetIntersection(queryContext.queryTokenSet, candidateProfile.tokenSet);
  if (candidateProfile.normalizedTitle && candidateProfile.normalizedTitle.includes(normalizedQuery) && normalizedQuery.length >= 4) {
    score = Math.max(score, 0.9);
    signalScore += 0.25;
    reason = 'title_contains_query_v2';
  } else if (
    candidateProfile.normalizedCombined &&
    candidateProfile.normalizedCombined.includes(normalizedQuery) &&
    normalizedQuery.length >= 4
  ) {
    score = Math.max(score, 0.84);
    signalScore += 0.2;
    reason = 'combined_contains_query_v2';
  }

  if (
    queryContext.queryCompact.length >= 2 &&
    candidateProfile.compactCombined &&
    candidateProfile.compactCombined.includes(queryContext.queryCompact)
  ) {
    score = Math.max(score, 0.82);
    signalScore += 0.18;
    reason = 'compact_contains_query_v2';
  }

  const numeric = scoreNumericSignalsV2(queryContext.queryNumericSignals, candidateProfile.numericSignals);
  score += numeric.delta;
  signalScore += numeric.signal;

  if (queryContext.queryCanonicalBrands.size > 0) {
    const matchedBrands = countSetIntersection(queryContext.queryCanonicalBrands, candidateProfile.canonicalBrands);
    if (matchedBrands > 0) {
      score += 0.14;
      signalScore += 0.14;
    } else if (candidateProfile.canonicalBrands.size > 0) {
      score -= 0.06;
      signalScore -= 0.06;
    }
  }

  if (queryContext.queryTokens.length >= 3 && commonTokens <= 1) {
    score -= 0.1;
    signalScore -= 0.1;
  } else if (queryContext.queryTokens.length >= 2 && commonTokens === 0) {
    score -= 0.18;
    signalScore -= 0.18;
  }

  if (
    queryContext.queryTokens.length <= 1 &&
    commonTokens === 0 &&
    !(queryContext.queryCompact && candidateProfile.compactCombined.includes(queryContext.queryCompact))
  ) {
    score -= 0.08;
    signalScore -= 0.08;
  }

  return {
    score: clamp01(score),
    reason,
    signal_score: signalScore,
  };
}

function computeInventoryBoost(product) {
  const inStock =
    typeof product?.in_stock === 'boolean'
      ? product.in_stock
      : typeof product?.inStock === 'boolean'
        ? product.inStock
        : null;
  if (inStock === true) return 0.05;

  const invRaw =
    product?.inventory_quantity ??
    product?.inventoryQuantity ??
    (product?.inventory && product.inventory.quantity) ??
    null;
  if (invRaw == null) return 0;
  const inv = Number(invRaw);
  if (Number.isFinite(inv) && inv > 0) return 0.05;
  return 0;
}

function computeOrderablePenalty(product) {
  const raw = product?.orderable ?? product?.is_orderable ?? product?.isOrderable ?? null;
  if (raw == null) return 0;
  const v = typeof raw === 'boolean' ? raw : String(raw).trim().toLowerCase() === 'true';
  return v ? 0 : -0.25;
}

function productRefSortKey(ref) {
  const merchant = String(ref?.merchant_id || '').trim();
  const product = String(ref?.product_id || '').trim();
  return `${merchant}::${product}`;
}

function scoreAndRankCandidates({ query, lang, products, options }) {
  const opt = options && typeof options === 'object' ? options : {};
  const scoringVersion = resolveScoringVersionFromOptions(opt, DEFAULT_SCORING_VERSION);
  const normalizedQuery =
    typeof opt.normalized_query === 'string' && opt.normalized_query.trim()
      ? String(opt.normalized_query).trim()
      : normalizeTextForResolver(query);
  const queryTokens =
    Array.isArray(opt.query_tokens) && opt.query_tokens.length
      ? opt.query_tokens
      : tokenizeNormalizedResolverQuery(normalizedQuery);

  const preferMerchantsRaw = Array.isArray(opt.prefer_merchants) ? opt.prefer_merchants : [];
  const preferMerchantsSet = new Set(preferMerchantsRaw.map((m) => String(m || '').trim()).filter(Boolean));
  const allowExternalSeed = options?.allow_external_seed === true;
  const v2QueryContext = scoringVersion === 'v2' ? buildV2QueryContext({ normalizedQuery, queryTokens }) : null;

  const scored = [];
  for (const p of products || []) {
    if (!p || typeof p !== 'object') continue;
    if (!allowExternalSeed && isExternalProduct(p)) continue;
    const ref = extractProductRef(p);
    if (!ref) continue;

    const base =
      scoringVersion === 'v2'
        ? computeCandidateTextScoreV2({
            queryContext: v2QueryContext,
            candidateProfile: buildV2CandidateProfile(p),
          })
        : computeCandidateTextScoreV1({ normalizedQuery, queryTokens, product: p });
    const isPreferredMerchant = Boolean(ref.merchant_id && preferMerchantsSet.has(ref.merchant_id));
    const merchantBoost = isPreferredMerchant ? 0.18 : 0;
    const invBoost = computeInventoryBoost(p);
    const orderablePenalty = computeOrderablePenalty(p);
    const signalScore = Number(base.signal_score || 0);

    const rankScore =
      base.score + merchantBoost + invBoost + orderablePenalty + (scoringVersion === 'v2' ? signalScore * 0.02 : 0);
    let final = rankScore;
    if (final < 0) final = 0;
    if (final > 1) final = 1;

    scored.push({
      product_ref: ref,
      title: String(getCandidateTitle(p) || '').trim() || null,
      brand: String(getCandidateBrand(p) || '').trim() || null,
      merchant_name: String(p?.merchant_name || p?.merchantName || p?.store_name || p?.storeName || '').trim() || null,
      score: Number(final.toFixed(4)),
      _rank_score: Number(rankScore.toFixed(6)),
      _preferred_merchant: isPreferredMerchant,
      _signal_score: Number(signalScore.toFixed(6)),
      _ref_sort_key: productRefSortKey(ref),
      score_reason: base.reason,
      _raw: p,
    });
  }

  if (scoringVersion === 'v2') {
    scored.sort((a, b) => {
      const ds = (b._rank_score || 0) - (a._rank_score || 0);
      if (ds) return ds;
      const ss = (b._signal_score || 0) - (a._signal_score || 0);
      if (ss) return ss;
      const dp = (b._preferred_merchant ? 1 : 0) - (a._preferred_merchant ? 1 : 0);
      if (dp) return dp;
      const dscore = (b.score || 0) - (a.score || 0);
      if (dscore) return dscore;
      return String(a._ref_sort_key || '').localeCompare(String(b._ref_sort_key || ''));
    });
  } else {
    scored.sort((a, b) => {
      const ds = (b._rank_score || 0) - (a._rank_score || 0);
      if (ds) return ds;
      const dp = (b._preferred_merchant ? 1 : 0) - (a._preferred_merchant ? 1 : 0);
      if (dp) return dp;
      return (b.score || 0) - (a.score || 0);
    });
  }
  return {
    normalized_query: normalizedQuery,
    query_tokens: queryTokens,
    scoring_version: scoringVersion,
    scored,
  };
}

function resolveFromRankedCandidates({ ranked, options }) {
  const scoringVersion = resolveScoringVersionFromOptions(options, DEFAULT_SCORING_VERSION);
  const defaultThreshold = scoringVersion === 'v2' ? 0.68 : 0.72;
  const threshold = typeof options?.min_confidence === 'number' ? options.min_confidence : defaultThreshold;
  const top = Array.isArray(ranked) ? ranked[0] : null;
  if (!top) {
    return {
      resolved: false,
      product_ref: null,
      confidence: 0,
      reason: 'no_candidates',
    };
  }

  if (top.score < threshold) {
    return {
      resolved: false,
      product_ref: null,
      confidence: top.score,
      reason: 'low_confidence',
    };
  }

  return {
    resolved: true,
    product_ref: top.product_ref,
    confidence: top.score,
    reason: top.score_reason || 'matched',
  };
}

function extractProductsFromAgentSearchResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.products)) return raw.products;
    if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.products)) return raw.data.products;
    if (Array.isArray(raw.items)) return raw.items;
    if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.items)) return raw.data.items;
    if (Array.isArray(raw.results)) return raw.results;
    if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.results)) return raw.data.results;
  }
  return [];
}

function buildUpstreamHeaders({ pivotaApiKey, checkoutToken }) {
  const token = String(checkoutToken || '').trim();
  if (token) return { 'X-Checkout-Token': token };
  const key = String(pivotaApiKey || '').trim();
  if (!key) return {};
  return {
    'X-API-Key': key,
    Authorization: `Bearer ${key}`,
  };
}

async function fetchCandidatesViaAgentSearch({
  pivotaApiBase,
  pivotaApiKey,
  checkoutToken,
  query,
  merchantIds,
  searchAllMerchants,
  limit,
  timeoutMs,
  maxRetries,
  retryBackoffMs,
}) {
  const baseUrl = String(pivotaApiBase || '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, products: [], reason: 'pivota_api_base_missing' };

  const q = String(query || '').trim();
  if (!q) return { ok: false, products: [], reason: 'query_missing' };

  const safeLimit = clampInt(limit, { min: 1, max: 50, fallback: 20 });
  const safeTimeout = clampInt(timeoutMs, { min: 50, max: 15000, fallback: 1500 });
  const safeMaxRetries = clampInt(maxRetries, { min: 0, max: 3, fallback: 1 });
  const safeRetryBackoff = clampInt(retryBackoffMs, { min: 25, max: 1000, fallback: 90 });

  const params = {
    query: q,
    in_stock_only: false,
    limit: safeLimit,
    offset: 0,
    ...(searchAllMerchants ? { search_all_merchants: true } : {}),
    ...(Array.isArray(merchantIds) && merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
  };

  let attempts = 0;
  while (attempts <= safeMaxRetries) {
    attempts += 1;
    try {
      const resp = await axios.get(`${baseUrl}/agent/v1/products/search`, {
        params,
        headers: buildUpstreamHeaders({ pivotaApiKey, checkoutToken }),
        timeout: safeTimeout,
        validateStatus: () => true,
      });

      if (resp.status === 200) {
        const products = extractProductsFromAgentSearchResponse(resp.data);
        return { ok: true, products, attempts };
      }

      const reason = `upstream_status_${resp.status}`;
      const retryable = resp.status === 429 || resp.status >= 500;
      if (retryable && attempts <= safeMaxRetries) {
        await sleep(safeRetryBackoff * attempts);
        continue;
      }
      return { ok: false, products: [], reason, status: resp.status, attempts };
    } catch (err) {
      const msg = String(err?.message || err || '');
      const isTimeout = /timeout|aborted|ECONNABORTED/i.test(msg);
      const reason = isTimeout ? 'upstream_timeout' : 'upstream_error';
      if (attempts <= safeMaxRetries) {
        await sleep(safeRetryBackoff * attempts);
        continue;
      }
      return { ok: false, products: [], reason, attempts };
    }
  }

  return { ok: false, products: [], reason: 'upstream_error', attempts };
}

async function fetchCandidatesViaProductsCache({
  merchantIds,
  query,
  limit,
  timeoutMs,
  searchAllMerchants = false,
}) {
  const mids = Array.isArray(merchantIds)
    ? merchantIds.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const useMerchantScope = !searchAllMerchants;
  if (useMerchantScope && mids.length === 0) return { ok: false, products: [], reason: 'merchant_ids_missing' };
  if (!process.env.DATABASE_URL) return { ok: false, products: [], reason: 'db_not_configured' };

  const normalizedQuery = normalizeTextForResolver(query);
  const tokens = tokenizeNormalizedResolverQuery(normalizedQuery);
  if (tokens.length === 0) return { ok: true, products: [] };

  const safeLimit = clampInt(limit, { min: 1, max: 100, fallback: 40 });
  const fetchLimit = Math.min(350, Math.max(safeLimit * 8, 120));
  const safeTimeout = clampInt(timeoutMs, { min: 50, max: 15000, fallback: 1500 });

  const matchFields = [
    "lower(coalesce(product_data->>'title',''))",
    "lower(coalesce(product_data->>'name',''))",
    "lower(coalesce(product_data->>'description',''))",
    "lower(coalesce(product_data->>'product_type',''))",
    "lower(coalesce(product_data->>'sku',''))",
    "lower(coalesce(product_data->>'vendor',''))",
    "lower(coalesce(product_data->>'brand',''))",
  ];

  const whereParts = [];
  const params = [];
  let idx = 1;

  for (const t of tokens.slice(0, 10)) {
    params.push(`%${t}%`);
    const ors = matchFields.map((f) => `${f} LIKE $${idx}`).join(' OR ');
    whereParts.push(`(${ors})`);
    idx += 1;
  }

  const tokenWhere = whereParts.length ? `(${whereParts.join(' OR ')})` : 'TRUE';
  const merchantScopeWhere = useMerchantScope ? `merchant_id = ANY($${idx})` : 'TRUE';
  if (useMerchantScope) {
    params.push(mids);
    idx += 1;
  }
  const limitParam = idx;
  params.push(fetchLimit);

  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (merchant_id, cache_product_id)
        merchant_id,
        cache_product_id,
        product_data,
        cached_at
      FROM (
        SELECT
          merchant_id,
          COALESCE(
            NULLIF(platform_product_id, ''),
            NULLIF(product_data->>'id', ''),
            NULLIF(product_data->>'product_id', ''),
            NULLIF(product_data->>'productId', '')
          ) AS cache_product_id,
          product_data,
          cached_at
        FROM products_cache
        WHERE ${merchantScopeWhere}
          AND (expires_at IS NULL OR expires_at > now())
          AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
          AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
          AND ${tokenWhere}
      ) t
      WHERE cache_product_id IS NOT NULL
      ORDER BY merchant_id, cache_product_id, cached_at DESC
    )
    SELECT merchant_id, cache_product_id, product_data
    FROM latest
    ORDER BY cached_at DESC
    LIMIT $${limitParam}
  `;

  try {
    const res = await withClient(async (client) => {
      const ms = Math.max(25, safeTimeout);
      // Note: Postgres does not reliably accept bind params in `SET statement_timeout`.
      // `ms` is clamped to a small integer range, so string interpolation is safe here.
      await client.query(`SET statement_timeout = ${Math.trunc(ms)}`);
      try {
        return await client.query(sql, params);
      } finally {
        await client.query('SET statement_timeout = 0');
      }
    });

    const rows = Array.isArray(res?.rows) ? res.rows : [];
    const products = rows
      .map((r) => {
        const productData = r?.product_data;
        if (!productData || typeof productData !== 'object') return null;
        const merchantId = String(r?.merchant_id || '').trim();
        const productId = String(r?.cache_product_id || '').trim() ||
          String(productData.product_id || productData.id || '').trim();
        if (!merchantId || !productId) return null;
        return {
          ...productData,
          merchant_id: merchantId,
          product_id: productId,
          source_type: productData.source_type || productData.source || 'products_cache',
        };
      })
      .filter(Boolean);

    return { ok: true, products: products.slice(0, fetchLimit), reason: null };
  } catch (err) {
    const code = String(err?.code || '');
    // 42P01: undefined_table
    if (code === '42P01') return { ok: false, products: [], reason: 'products_cache_missing' };
    return { ok: false, products: [], reason: 'db_error' };
  }
}

function dedupeByProductRef(candidates) {
  const out = [];
  const seen = new Set();
  for (const item of candidates || []) {
    const ref = item && item.product_ref ? item.product_ref : null;
    const merchantKey = ref?.merchant_id ? String(ref.merchant_id).trim() : '_';
    const productKey = ref?.product_id ? String(ref.product_id).trim() : '';
    const key = productKey ? `${merchantKey}::${productKey}` : null;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function createProductGroundingResolver(deps = {}) {
  const fetchProductsCache =
    typeof deps.fetchCandidatesViaProductsCache === 'function'
      ? deps.fetchCandidatesViaProductsCache
      : fetchCandidatesViaProductsCache;
  const fetchAgentSearch =
    typeof deps.fetchCandidatesViaAgentSearch === 'function'
      ? deps.fetchCandidatesViaAgentSearch
      : fetchCandidatesViaAgentSearch;
  const rankCandidates =
    typeof deps.scoreAndRankCandidates === 'function' ? deps.scoreAndRankCandidates : scoreAndRankCandidates;
  const decide =
    typeof deps.resolveFromRankedCandidates === 'function'
      ? deps.resolveFromRankedCandidates
      : resolveFromRankedCandidates;
  const defaultScoringVersion = normalizeScoringVersion(
    deps.defaultScoringVersion || deps.default_scoring_version || DEFAULT_SCORING_VERSION,
    DEFAULT_SCORING_VERSION,
  );

  return async function resolveProductRef({
    query,
    lang,
    hints,
    options,
    pivotaApiBase,
    pivotaApiKey,
    checkoutToken,
  }) {
    const startMs = Date.now();
    const scoringVersion = resolveScoringVersionFromOptions(options, defaultScoringVersion);
    const timeoutMs = clampInt(options?.timeout_ms, { min: 100, max: 15000, fallback: 1600 });
    const deadlineMs = startMs + timeoutMs;

    const rawQuery = String(query || '').trim();
    const hintData = extractResolverHints(hints);
    const hintedQuery = hintData.aliases[0] || '';
    const q = isUuidLike(rawQuery) && hintedQuery ? hintedQuery : rawQuery;
    const normalizedQuery = normalizeTextForResolver(q);
    const queryTokens = tokenizeNormalizedResolverQuery(normalizedQuery);
    if (!normalizedQuery || queryTokens.length === 0) {
      return {
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'empty_query',
        candidates: [],
        normalized_query: normalizedQuery,
        scoring_version: scoringVersion,
      };
    }

    const preferMerchantsRaw =
    options?.prefer_merchants ||
    options?.preferMerchants ||
    options?.prefer_merchant_ids ||
    options?.preferMerchantIds ||
    [];
    const preferMerchantsList = Array.isArray(preferMerchantsRaw)
    ? preferMerchantsRaw
    : typeof preferMerchantsRaw === 'string' && preferMerchantsRaw.trim()
      ? [preferMerchantsRaw.trim()]
      : [];
    const preferMerchants = Array.from(
    new Set(preferMerchantsList.map((m) => String(m || '').trim()).filter(Boolean)),
  ).slice(0, 20);
    const allowExternalSeed = options?.allow_external_seed === true || options?.allowExternalSeed === true;
    const searchAllMerchants =
    options?.search_all_merchants === true || options?.searchAllMerchants === true || (!preferMerchants.length && options?.search_all_merchants !== false);
    const limit = clampInt(options?.limit, { min: 1, max: 50, fallback: 20 });
    const upstreamRetries = clampInt(options?.upstream_retries, { min: 0, max: 3, fallback: 1 });
    const upstreamRetryBackoffMs = clampInt(options?.upstream_retry_backoff_ms, { min: 25, max: 1000, fallback: 90 });

    const products = [];
    const sources = [];
    let scopedCacheFailedInfra = false;

    if (hintData.product_ref && (hintedQuery || isUuidLike(rawQuery))) {
      products.push({
        product_id: hintData.product_ref.product_id,
        merchant_id: hintData.product_ref.merchant_id,
        title: hintedQuery || rawQuery,
        ...(hintData.brand ? { brand: hintData.brand } : {}),
        source: 'hint_product_ref',
      });
      sources.push({ source: 'hints_product_ref', ok: true, count: 1 });
    }

    function remainingMs() {
      return Math.max(0, deadlineMs - Date.now());
    }

    function stageTimeout({ capMs, reserveMs = 0, floorMs = 50 }) {
      const remaining = remainingMs();
      if (remaining <= floorMs) return 0;
      const keep = Math.max(0, Number(reserveMs) || 0);
      const cap = Math.max(floorMs, Number(capMs) || floorMs);
      const budgeted = Math.max(floorMs, remaining - keep);
      return Math.max(floorMs, Math.min(cap, budgeted));
    }

  // 1) Prefer: products_cache (merchant inventory) for prefer_merchants.
    const scopedCacheTimeout = stageTimeout({ capMs: 650, reserveMs: 900, floorMs: 60 });
    if (preferMerchants.length > 0 && scopedCacheTimeout >= 60) {
      const cacheResp = await fetchProductsCache({
      merchantIds: preferMerchants,
      query: q,
      limit,
      timeoutMs: scopedCacheTimeout,
      searchAllMerchants: false,
    });
      if (cacheResp.ok && Array.isArray(cacheResp.products) && cacheResp.products.length) {
        products.push(...cacheResp.products);
        sources.push({ source: 'products_cache', ok: true, count: cacheResp.products.length });
      } else {
        const reason = String(cacheResp.reason || 'no_results');
        if (reason === 'db_error' || reason === 'db_not_configured' || reason === 'products_cache_missing') {
          scopedCacheFailedInfra = true;
        }
        sources.push({ source: 'products_cache', ok: false, reason: cacheResp.reason || 'no_results' });
      }
    }

  // 2) Fallback: agent search scoped to prefer_merchants (fast).
    const scopedUpstreamTimeout = stageTimeout({ capMs: 900, reserveMs: 850, floorMs: 80 });
    if (products.length === 0 && preferMerchants.length > 0 && scopedUpstreamTimeout >= 80) {
      const scopedRetries = scopedUpstreamTimeout >= 700 ? upstreamRetries : 0;
      const upstreamScoped = await fetchAgentSearch({
      pivotaApiBase,
      pivotaApiKey,
      checkoutToken,
      query: q,
      merchantIds: preferMerchants,
      searchAllMerchants: false,
      limit,
      timeoutMs: scopedUpstreamTimeout,
      maxRetries: scopedRetries,
      retryBackoffMs: upstreamRetryBackoffMs,
    });
      if (upstreamScoped.ok && Array.isArray(upstreamScoped.products) && upstreamScoped.products.length) {
        products.push(...upstreamScoped.products);
        sources.push({
          source: 'agent_search_scoped',
          ok: true,
          count: upstreamScoped.products.length,
          attempts: upstreamScoped.attempts || 1,
        });
      } else {
        sources.push({
          source: 'agent_search_scoped',
          ok: false,
          reason: upstreamScoped.reason || 'no_results',
          ...(upstreamScoped.status ? { status: upstreamScoped.status } : {}),
          attempts: upstreamScoped.attempts || 1,
        });
      }
    }

  // 3) Optional: global products_cache fallback (avoids network timeouts).
    const globalCacheTimeout = stageTimeout({ capMs: 850, reserveMs: 300, floorMs: 60 });
    const shouldTryGlobalCache =
    globalCacheTimeout >= 60 &&
    !scopedCacheFailedInfra &&
    (searchAllMerchants === true || (!preferMerchants.length && searchAllMerchants !== false)) &&
    products.length < Math.max(6, Math.min(14, limit));
    if (shouldTryGlobalCache) {
      const cacheGlobal = await fetchProductsCache({
      query: q,
      limit: Math.max(limit, 24),
      timeoutMs: globalCacheTimeout,
      searchAllMerchants: true,
    });
      if (cacheGlobal.ok && Array.isArray(cacheGlobal.products) && cacheGlobal.products.length) {
        products.push(...cacheGlobal.products);
        sources.push({ source: 'products_cache_global', ok: true, count: cacheGlobal.products.length });
      } else {
        sources.push({ source: 'products_cache_global', ok: false, reason: cacheGlobal.reason || 'no_results' });
      }
    }

  // 4) Optional: global agent search (no external_seed by default).
    const globalUpstreamTimeout = stageTimeout({ capMs: 1400, reserveMs: 0, floorMs: 120 });
    const shouldTryGlobal =
    globalUpstreamTimeout >= 120 &&
    (searchAllMerchants === true || (!preferMerchants.length && searchAllMerchants !== false)) &&
    // Avoid a second network call when we already have plenty of candidates.
    products.length < Math.max(6, Math.min(14, limit));
    if (shouldTryGlobal) {
      const globalRetries = globalUpstreamTimeout >= 900 ? upstreamRetries : 0;
      const upstreamGlobal = await fetchAgentSearch({
      pivotaApiBase,
      pivotaApiKey,
      checkoutToken,
      query: q,
      merchantIds: undefined,
      searchAllMerchants: true,
      limit: Math.max(limit, 18),
      timeoutMs: globalUpstreamTimeout,
      maxRetries: globalRetries,
      retryBackoffMs: upstreamRetryBackoffMs,
    });
      if (upstreamGlobal.ok && Array.isArray(upstreamGlobal.products) && upstreamGlobal.products.length) {
        products.push(...upstreamGlobal.products);
        sources.push({
          source: 'agent_search_global',
          ok: true,
          count: upstreamGlobal.products.length,
          attempts: upstreamGlobal.attempts || 1,
        });
      } else {
        sources.push({
          source: 'agent_search_global',
          ok: false,
          reason: upstreamGlobal.reason || 'no_results',
          ...(upstreamGlobal.status ? { status: upstreamGlobal.status } : {}),
          attempts: upstreamGlobal.attempts || 1,
        });
      }
    }

    const rankOptions = {
      ...options,
      scoring_version: scoringVersion,
      prefer_merchants: preferMerchants,
      allow_external_seed: allowExternalSeed,
      normalized_query: normalizedQuery,
      query_tokens: queryTokens,
    };

    const { scored, normalized_query } = rankCandidates({
      query: q,
      lang,
      products,
      options: rankOptions,
    });

    const unique = dedupeByProductRef(scored);
    const topN = unique.slice(0, clampInt(options?.candidates_limit, { min: 1, max: 12, fallback: 6 }));

    const decision = decide({
      ranked: unique,
      options: {
        ...options,
        scoring_version: scoringVersion,
      },
    });

    const latencyMs = Date.now() - startMs;

    return {
      resolved: decision.resolved,
      product_ref: decision.product_ref,
      confidence: decision.confidence,
      reason: decision.reason,
      candidates: topN.map((c) => ({
        product_ref: c.product_ref,
        title: c.title,
        score: c.score,
        ...(c.merchant_name ? { merchant_name: c.merchant_name } : {}),
      })),
      normalized_query,
      scoring_version: scoringVersion,
      metadata: {
        lang: String(lang || '').toLowerCase() === 'cn' ? 'cn' : 'en',
        timeout_ms: timeoutMs,
        latency_ms: latencyMs,
        scoring_version: scoringVersion,
        sources,
        ...(q !== rawQuery ? { query_from_hints: true, effective_query: q, original_query: rawQuery } : {}),
        ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
        ...(allowExternalSeed ? { allow_external_seed: true } : {}),
      },
    };
  };
}

const resolveProductRef = createProductGroundingResolver();

module.exports = {
  resolveProductRef,
  createProductGroundingResolver,
  _internals: {
    normalizeTextForResolver,
    tokenizeNormalizedResolverQuery,
    scoreAndRankCandidates,
    resolveFromRankedCandidates,
    isExternalProduct,
    isUuidLike,
    extractResolverHints,
    fetchCandidatesViaProductsCache,
    fetchCandidatesViaAgentSearch,
    computeTokenOverlapScoreFromTokenSet,
  },
};
