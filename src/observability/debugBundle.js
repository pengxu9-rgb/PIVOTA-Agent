const RESULT_TYPE_VALUES = Object.freeze(['product_list', 'clarify', 'strict_empty']);
const REASON_CODE_VALUES = Object.freeze([
  'CACHE_HIT',
  'AMBIGUOUS_EARLY',
  'AMBIGUOUS_MEDIUM',
  'NO_CANDIDATES',
  'CROSS_DOMAIN',
  'LOW_SCORE',
  'UPSTREAM_DEGRADED',
  'CLARIFY_REQUIRED',
  'UNKNOWN',
]);

const DEFAULT_K_MIN = 6;

function clamp01(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.min(1, Number(value)));
}

function toInt(value, fallback = 0) {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.max(0, Math.round(Number(value)));
}

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeQuery(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted_email]')
    .replace(/\b(?:\+?\d[\d\s().-]{6,}\d)\b/g, '[redacted_phone]');
}

function tokenizeAnchors(query) {
  const normalized = normalizeText(query);
  const stop = new Set([
    '有',
    '有没有',
    '推荐',
    '商品',
    'products',
    'recommend',
    'recommendation',
    'show',
    'me',
    'for',
    'with',
    'the',
    'a',
    'an',
  ]);
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stop.has(token))
    .slice(0, 10);
}

function calcLexicalAnchorRatioTopK(query, products, topK = 5) {
  if (!Array.isArray(products) || !products.length) return null;
  const anchors = tokenizeAnchors(query);
  if (!anchors.length) return null;
  const top = products.slice(0, Math.max(1, Number(topK) || 5));
  if (!top.length) return null;
  let matched = 0;
  for (const product of top) {
    const text = normalizeText(
      [
        product?.title,
        product?.name,
        product?.description,
        product?.brand,
        product?.vendor,
        product?.category,
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (!text) continue;
    if (anchors.some((token) => text.includes(token))) matched += 1;
  }
  return clamp01(matched / top.length);
}

function calcEntropy(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const counts = new Map();
  for (const value of values) {
    const key = String(value || '').trim().toLowerCase() || 'unknown';
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }
  const total = values.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(6));
}

function inferResultType(responseBody) {
  const body = responseBody && typeof responseBody === 'object' ? responseBody : {};
  const products = Array.isArray(body.products) ? body.products : [];
  const hasClarification = Boolean(
    body?.clarification && typeof body.clarification === 'object' && body.clarification.question,
  );
  const strictEmpty = Boolean(body?.metadata?.strict_empty);

  if (hasClarification) return 'clarify';
  if (strictEmpty || products.length === 0) return 'strict_empty';
  return 'product_list';
}

function inferReasonCode({ responseBody, resultType, routeHealth, searchTrace }) {
  const body = responseBody && typeof responseBody === 'object' ? responseBody : {};
  const reasonCodes = Array.isArray(body.reason_codes) ? body.reason_codes : [];
  if (reasonCodes.length > 0 && typeof reasonCodes[0] === 'string') {
    return String(reasonCodes[0]).toUpperCase();
  }

  const fallbackReason = String(routeHealth?.fallback_reason || '').toLowerCase();
  const finalDecision = String(searchTrace?.final_decision || '').toLowerCase();
  const querySource = String(body?.metadata?.query_source || '').toLowerCase();
  const strictReason = String(body?.metadata?.strict_empty_reason || '').toLowerCase();

  if (resultType === 'clarify') {
    return routeHealth?.ambiguity_score_pre != null ? 'AMBIGUOUS_MEDIUM' : 'CLARIFY_REQUIRED';
  }
  if (resultType === 'strict_empty') {
    if (strictReason.includes('cross_domain')) return 'CROSS_DOMAIN';
    if (strictReason.includes('low_score')) return 'LOW_SCORE';
    if (
      fallbackReason.includes('timeout') ||
      fallbackReason.includes('degraded') ||
      querySource === 'agent_products_error_fallback'
    ) {
      return 'UPSTREAM_DEGRADED';
    }
    if (strictReason.includes('ambiguous')) return 'AMBIGUOUS_EARLY';
    return 'NO_CANDIDATES';
  }
  if (finalDecision === 'cache_returned' || querySource.startsWith('cache_')) return 'CACHE_HIT';
  if (finalDecision === 'resolver_returned') return 'CACHE_HIT';
  return 'UNKNOWN';
}

function inferProductDomain(product) {
  const pivotaDomain = String(product?.attributes?.pivota?.domain || '').trim().toLowerCase();
  if (pivotaDomain) return pivotaDomain;
  return (
    String(product?.domain || product?.category_domain || product?.catalog_domain || '')
      .trim()
      .toLowerCase() || null
  );
}

function inferProductCategory(product) {
  const categoryPath = Array.isArray(product?.category_path) ? product.category_path : null;
  if (categoryPath && categoryPath.length) return String(categoryPath[categoryPath.length - 1] || '').trim() || null;
  return String(product?.category || product?.category_name || '').trim() || null;
}

function inferTopItemSource(product, querySource) {
  const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
  if (merchantId === 'external_seed' || String(product?.source || '').toLowerCase() === 'external_seed') {
    return 'external';
  }
  if (String(querySource || '').startsWith('cache_')) return 'cache';
  return 'internal';
}

function computeRewriteList(rawQuery, expandedQuery) {
  const raw = new Set(normalizeText(rawQuery).split(' ').filter(Boolean));
  const expandedTokens = normalizeText(expandedQuery).split(' ').filter(Boolean);
  if (!expandedTokens.length) return [];
  const rewrites = [];
  for (const token of expandedTokens) {
    if (raw.has(token)) continue;
    if (rewrites.includes(token)) continue;
    rewrites.push(token);
    if (rewrites.length >= 20) break;
  }
  return rewrites;
}

function pickRequestIp(req) {
  const xff = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (xff.length) return xff[0];
  return String(req?.ip || req?.socket?.remoteAddress || '').trim();
}

function normalizeIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

function isPrivateIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return false;
  if (value === '127.0.0.1' || value === '::1' || value === 'localhost') return true;
  if (value.startsWith('10.')) return true;
  if (value.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  return false;
}

function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesAllowlist(ip, allowlist) {
  if (!allowlist.length) return false;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  for (const rule of allowlist) {
    if (rule === '*') return true;
    if (rule === normalized) return true;
    if (rule.endsWith('*') && normalized.startsWith(rule.slice(0, -1))) return true;
  }
  return false;
}

function isDebugRequested(req) {
  const header = String(req?.headers?.['x-debug'] || '').trim().toLowerCase();
  const query = String(req?.query?.debug || '').trim().toLowerCase();
  return header === '1' || header === 'true' || query === '1' || query === 'true';
}

function shouldExposeDebugBundle(req) {
  if (!isDebugRequested(req)) return false;
  const enabled = String(process.env.SEARCH_DEBUG_BUNDLE_RESPONSE_ENABLED || 'true')
    .trim()
    .toLowerCase();
  if (enabled === 'false') return false;

  const ip = pickRequestIp(req);
  const allowlist = parseAllowlist(process.env.SEARCH_DEBUG_BUNDLE_ALLOWLIST || '');
  if (allowlist.length > 0) return matchesAllowlist(ip, allowlist);
  const allowPrivate = String(process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP || 'false')
    .trim()
    .toLowerCase();
  if (allowPrivate === 'true') return isPrivateIp(ip);
  return false;
}

function shouldLogDebugBundle(req) {
  if (shouldExposeDebugBundle(req)) return true;
  const sampleRate = clamp01(process.env.SEARCH_DEBUG_BUNDLE_LOG_SAMPLE_RATE || 0.01);
  if (sampleRate == null || sampleRate <= 0) return false;
  return Math.random() < sampleRate;
}

function buildSearchDebugBundle({
  requestId,
  req,
  responseBody,
  context = {},
}) {
  if (!responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) return null;
  const metadata =
    responseBody.metadata && typeof responseBody.metadata === 'object' ? responseBody.metadata : {};
  const routeHealth =
    metadata.route_health && typeof metadata.route_health === 'object' ? metadata.route_health : {};
  const searchTrace =
    metadata.search_trace && typeof metadata.search_trace === 'object' ? metadata.search_trace : {};
  const routeDebug =
    metadata.route_debug && typeof metadata.route_debug === 'object' ? metadata.route_debug : {};
  const searchDecision =
    metadata.search_decision && typeof metadata.search_decision === 'object'
      ? metadata.search_decision
      : {};
  const products = Array.isArray(responseBody.products) ? responseBody.products : [];

  const query =
    sanitizeQuery(
      context.rawUserQuery ||
        searchTrace.raw_query ||
        req?.body?.payload?.search?.query ||
        req?.body?.payload?.query ||
        '',
    );
  const locale =
    String(
      context.intent?.language ||
        responseBody?.intent?.language ||
        req?.headers?.['x-locale'] ||
        req?.headers?.['accept-language'] ||
        '',
    ).trim() || 'unknown';

  const resultType = inferResultType(responseBody);
  const reasonCode = inferReasonCode({
    responseBody,
    resultType,
    routeHealth,
    searchTrace,
  });

  const topItems = products.slice(0, 10).map((product) => ({
    pid: String(product?.product_id || product?.id || product?.productId || '').trim() || null,
    domain: inferProductDomain(product),
    cat: inferProductCategory(product),
    source: inferTopItemSource(product, metadata.query_source),
    final_score:
      Number.isFinite(Number(product?.final_score)) ? Number(product.final_score) : null,
  }));
  const topDomains = topItems.map((item) => String(item.domain || '').trim().toLowerCase() || 'unknown');
  const domainEntropyTopK = calcEntropy(topDomains);
  const lexicalAnchorRatioTopK = calcLexicalAnchorRatioTopK(query, products, 10);

  const degradeFlags =
    routeHealth.degrade_flags && typeof routeHealth.degrade_flags === 'object'
      ? routeHealth.degrade_flags
      : {};
  const crossMerchantDebug =
    routeDebug.cross_merchant_cache && typeof routeDebug.cross_merchant_cache === 'object'
      ? routeDebug.cross_merchant_cache
      : {};
  const policyDebug =
    routeDebug.policy && typeof routeDebug.policy === 'object' ? routeDebug.policy : {};
  const filterDebug =
    policyDebug.filter_debug && typeof policyDebug.filter_debug === 'object'
      ? policyDebug.filter_debug
      : {};
  const ambiguityDebug =
    policyDebug.ambiguity && typeof policyDebug.ambiguity === 'object'
      ? policyDebug.ambiguity
      : {};

  const totalLatencyMs = toInt(
    context.totalLatencyMs ??
      routeHealth.primary_latency_ms ??
      (context.invokeStartedAtMs ? Date.now() - Number(context.invokeStartedAtMs) : 0),
    0,
  );
  const lexicalLatencyMs = toInt(crossMerchantDebug.latency_ms, 0);

  const nluSlots = context.intent?.hard_constraints && typeof context.intent.hard_constraints === 'object'
    ? context.intent.hard_constraints
    : responseBody?.intent?.hard_constraints && typeof responseBody.intent.hard_constraints === 'object'
      ? responseBody.intent.hard_constraints
      : {};

  const bundle = {
    schema_version: 'v1',
    build_sha:
      String(
        process.env.BUILD_SHA ||
          process.env.GIT_COMMIT_SHA ||
          process.env.RAILWAY_GIT_COMMIT_SHA ||
          process.env.VERCEL_GIT_COMMIT_SHA ||
          '',
      ).trim() || null,
    req_id: String(requestId || searchTrace.trace_id || '').trim() || null,
    ts: new Date().toISOString(),
    query,
    locale,
    result_type: resultType,
    reason_code: reasonCode,
    latency_ms: {
      total: totalLatencyMs,
      nlu: toInt(context.nluLatencyMs, 0),
      lexical: lexicalLatencyMs,
      vector: toInt(context.vectorLatencyMs, 0),
      behavior: toInt(context.behaviorLatencyMs, 0),
      rank: toInt(context.rankLatencyMs, 0),
    },
    degrade: {
      nlu_degraded: Boolean(degradeFlags.nlu_degraded),
      vector_skipped: Boolean(degradeFlags.vector_skipped),
      behavior_skipped: Boolean(degradeFlags.behavior_skipped),
    },
    nlu: {
      intent_top1: String(context.intent?.query_class || responseBody?.intent?.query_class || '').trim() || null,
      intent_probs:
        context.intent?.confidence && typeof context.intent.confidence === 'object'
          ? {
              domain: clamp01(context.intent.confidence.domain),
              category: clamp01(context.intent.confidence.category),
              target_object: clamp01(context.intent.confidence.target_object),
              overall: clamp01(context.intent.confidence.overall),
            }
          : null,
      intent_entropy: null,
      slots: {
        domain: String(context.intent?.primary_domain || responseBody?.intent?.primary_domain || '').trim() || null,
        scenario: String(context.intent?.scenario?.name || responseBody?.intent?.scenario?.name || '').trim() || null,
        budget:
          nluSlots?.price && typeof nluSlots.price === 'object'
            ? {
                currency: nluSlots.price.currency ?? null,
                min: nluSlots.price.min ?? null,
                max: nluSlots.price.max ?? null,
              }
            : null,
        brand: null,
        constraints: {
          in_stock_only: nluSlots?.in_stock_only ?? null,
          must_include_keywords: Array.isArray(nluSlots?.must_include_keywords)
            ? nluSlots.must_include_keywords
            : [],
          must_exclude_domains: Array.isArray(nluSlots?.must_exclude_domains)
            ? nluSlots.must_exclude_domains
            : [],
          must_exclude_keywords: Array.isArray(nluSlots?.must_exclude_keywords)
            ? nluSlots.must_exclude_keywords
            : [],
        },
      },
      slot_conf: null,
      overall_conf: clamp01(context.intent?.confidence?.overall ?? responseBody?.intent?.confidence?.overall),
      U_pre: clamp01(searchDecision.ambiguity_score_pre ?? routeHealth.ambiguity_score_pre),
    },
    rewrite: {
      mode: String(searchTrace.expansion_mode || context.expansionMode || 'none'),
      rewrites: computeRewriteList(searchTrace.raw_query || query, searchTrace.expanded_query || query),
      drift_risk: clamp01(searchTrace?.rewrite_gate?.rewrite_drift_risk),
      category_plan:
        Array.isArray(searchTrace?.association_plan?.category_keywords) &&
        searchTrace.association_plan.category_keywords.length
          ? searchTrace.association_plan.category_keywords.map((keyword) => ({ keyword }))
          : null,
    },
    recall: {
      counts_raw: {
        lexical: toInt(
          Array.isArray(crossMerchantDebug.retrieval_sources)
            ? crossMerchantDebug.retrieval_sources.reduce(
                (sum, item) => sum + (item?.source === 'lexical_cache' ? Number(item?.candidate_count || 0) : 0),
                0,
              )
            : 0,
          0,
        ),
        alias: toInt(searchTrace?.resolver_stage?.hit ? 1 : 0, 0),
        vector: toInt(context.recallVectorCount, 0),
        behavior: toInt(context.recallBehaviorCount, 0),
        assoc: toInt(context.recallAssociationCount, 0),
        external_seed: toInt(crossMerchantDebug.external_products_count, 0),
      },
      counts_after_dedup: toInt(crossMerchantDebug.products_count ?? products.length, products.length),
      drops: {
        domain_filter: toInt(ambiguityDebug.domain_filter_dropped, 0),
        constraints_filter: toInt(filterDebug.hard_blocked, 0),
        safety_filter: toInt(filterDebug.hard_blocked_toy_like, 0),
        inventory_filter: toInt(context.inventoryDroppedCount, 0),
      },
    },
    post: {
      candidates: toInt(products.length, 0),
      U_post: clamp01(searchDecision.ambiguity_score_post ?? routeHealth.ambiguity_score_post),
      domain_entropy_topK: domainEntropyTopK,
      lexical_anchor_ratio_topK: lexicalAnchorRatioTopK,
      top_score: Number.isFinite(Number(topItems[0]?.final_score)) ? Number(topItems[0].final_score) : null,
    },
    top_items: topItems,
  };

  if (bundle.post.candidates < DEFAULT_K_MIN && bundle.result_type === 'product_list' && bundle.reason_code === 'CACHE_HIT') {
    bundle.reason_code = 'LOW_SCORE';
  }
  return bundle;
}

module.exports = {
  RESULT_TYPE_VALUES,
  REASON_CODE_VALUES,
  inferResultType,
  inferReasonCode,
  buildSearchDebugBundle,
  isDebugRequested,
  shouldExposeDebugBundle,
  shouldLogDebugBundle,
};
