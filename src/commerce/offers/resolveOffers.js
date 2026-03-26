const OFFERS_RESOLVE_REASON_CODE_SET = new Set([
  'subject_direct',
  'canonical_ref_direct',
  'stable_alias_ref',
  'mapped_hit',
  'db_timeout',
  'upstream_timeout',
  'no_candidates',
  'fallback_external',
]);

function offersResolveIsRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function offersResolvePickFirstTrimmed(...values) {
  for (const raw of values) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s) return s;
  }
  return '';
}

function offersResolveIsUuidLike(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.trim());
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeOffersResolveReasonCode(raw, fallback = 'no_candidates') {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return fallback;
  if (OFFERS_RESOLVE_REASON_CODE_SET.has(token)) return token;
  if (
    token === 'db_error' ||
    token === 'db_query_timeout' ||
    token === 'products_cache_missing' ||
    token.startsWith('db_') ||
    token.includes('database') ||
    token.includes('postgres')
  ) {
    return 'db_timeout';
  }
  if (
    token === 'timeout' ||
    token === 'upstream_error' ||
    token.startsWith('upstream_') ||
    token.includes('timed out') ||
    token.includes('timeout')
  ) {
    return 'upstream_timeout';
  }
  if (
    token === 'no_result' ||
    token === 'no_results' ||
    token === 'not_found' ||
    token === 'not_found_in_cache' ||
    token === 'low_confidence' ||
    token === 'empty_query'
  ) {
    return 'no_candidates';
  }
  if (token === 'mapped' || token === 'mapped_direct' || token === 'cache_hit') return 'mapped_hit';
  if (token === 'subject_hit' || token === 'subject_match') return 'subject_direct';
  if (token === 'canonical_direct' || token === 'canonical_ref_hit') return 'canonical_ref_direct';
  if (
    token === 'stable_alias' ||
    token === 'stable_alias_ref' ||
    token === 'stable_alias_match' ||
    token === 'alias_exact' ||
    token === 'alias_fuzzy'
  ) {
    return 'stable_alias_ref';
  }
  if (token === 'external_fallback') return 'fallback_external';
  return fallback;
}

function inferOffersResolveFailureReasonCode({ responseBody, statusCode, error } = {}) {
  const explicit = normalizeOffersResolveReasonCode(
    responseBody?.reason_code ||
      responseBody?.reasonCode ||
      responseBody?.metadata?.reason_code ||
      responseBody?.metadata?.resolve_reason_code,
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
  if (reason) {
    const mapped = normalizeOffersResolveReasonCode(reason, '');
    if (mapped) return mapped;
  }

  const sourceReasons = Array.isArray(responseBody?.metadata?.sources)
    ? responseBody.metadata.sources
        .map((s) => String(s?.reason || '').trim().toLowerCase())
        .filter(Boolean)
    : [];
  for (const sourceReason of sourceReasons) {
    const mapped = normalizeOffersResolveReasonCode(sourceReason, '');
    if (mapped) return mapped;
  }

  const status = Number(statusCode || 0);
  if (status === 408 || status === 429 || status >= 500) return 'upstream_timeout';

  const errText = String(error?.code || error?.message || error || '').trim().toLowerCase();
  if (
    errText.includes('timeout') ||
    errText.includes('econnaborted') ||
    errText.includes('etimedout')
  ) {
    return 'upstream_timeout';
  }
  if (errText.includes('database') || errText.includes('postgres') || errText.includes('db_')) {
    return 'db_timeout';
  }

  return 'no_candidates';
}

function normalizeOffersResolveCanonicalProductRef(input, { allowOpaqueProductId = false } = {}) {
  const ref = offersResolveIsRecord(input) ? input : null;
  if (!ref) return null;
  const productId = offersResolvePickFirstTrimmed(ref.product_id, ref.productId);
  const merchantId = offersResolvePickFirstTrimmed(ref.merchant_id, ref.merchantId);
  if (!productId || !merchantId) return null;
  if (!allowOpaqueProductId && offersResolveIsUuidLike(productId)) return null;
  return {
    product_id: productId,
    merchant_id: merchantId,
  };
}

function extractOffersResolveSubjectProductGroupId(input) {
  const subject = offersResolveIsRecord(input) ? input : null;
  if (!subject) return '';
  const type = offersResolvePickFirstTrimmed(subject.type).toLowerCase();
  const id = offersResolvePickFirstTrimmed(subject.id);
  if (type === 'product_group' && id) return id;
  return offersResolvePickFirstTrimmed(subject.product_group_id, subject.productGroupId, id);
}

function normalizeCommerceSurface(raw, fallback = 'agent_api') {
  const token = String(raw || '').trim().toLowerCase();
  if (token === 'ucp' || token === 'acp' || token === 'agent_api') return token;
  return fallback;
}

function extractCommerceSurfaceFromPayload(payload, metadata, { fallback = 'agent_api' } = {}) {
  const body = offersResolveIsRecord(payload) ? payload : {};
  const search = offersResolveIsRecord(body.search) ? body.search : {};
  const offersPayload =
    offersResolveIsRecord(body.offers) && Object.keys(body.offers).length > 0 ? body.offers : body;
  const offersProduct = offersResolveIsRecord(offersPayload.product) ? offersPayload.product : {};
  const meta = offersResolveIsRecord(metadata) ? metadata : {};
  return normalizeCommerceSurface(
    offersResolvePickFirstTrimmed(
      body.commerce_surface,
      body.commerceSurface,
      search.commerce_surface,
      search.commerceSurface,
      search.catalog_surface,
      search.catalogSurface,
      offersPayload.commerce_surface,
      offersPayload.commerceSurface,
      offersProduct.commerce_surface,
      offersProduct.commerceSurface,
      meta.commerce_surface,
      meta.commerceSurface,
    ),
    fallback,
  );
}

function buildOffersResolveExternalSearchUrl(query) {
  const q = String(query || '').trim();
  if (!q) return 'https://www.google.com/';
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function buildOffersResolvePdpTargetGroup(productGroupId, canonicalProductRef = null) {
  const pgid = offersResolvePickFirstTrimmed(productGroupId);
  if (!pgid) return null;
  return {
    schema: 'pdp_target.v1',
    type: 'internal',
    path: 'group',
    subject: {
      type: 'product_group',
      id: pgid,
      product_group_id: pgid,
    },
    ...(canonicalProductRef ? { canonical_product_ref: canonicalProductRef } : {}),
    get_pdp_v2_payload: {
      subject: {
        type: 'product_group',
        id: pgid,
      },
    },
  };
}

function buildOffersResolvePdpTargetRef(canonicalProductRef, { path = 'ref' } = {}) {
  const ref = normalizeOffersResolveCanonicalProductRef(canonicalProductRef, {
    allowOpaqueProductId: false,
  });
  if (!ref) return null;
  const normalizedPath = String(path || '').trim().toLowerCase() === 'resolve' ? 'resolve' : 'ref';
  return {
    schema: 'pdp_target.v1',
    type: 'internal',
    path: normalizedPath,
    product_ref: ref,
    canonical_product_ref: ref,
    get_pdp_v2_payload: {
      product_ref: ref,
    },
  };
}

function buildOffersResolvePdpTargetExternal(query, reasonCode = null) {
  const normalizedReason = reasonCode
    ? normalizeOffersResolveReasonCode(reasonCode, 'fallback_external')
    : null;
  return {
    schema: 'pdp_target.v1',
    type: 'external',
    path: 'external',
    external: {
      provider: 'google',
      target: '_blank',
      url: buildOffersResolveExternalSearchUrl(query),
      query: String(query || '').trim() || null,
    },
    ...(normalizedReason ? { reason_code: normalizedReason } : {}),
  };
}

function normalizeOffersResolvePdpTargetV1(rawTarget, { fallbackQuery = '' } = {}) {
  const target = offersResolveIsRecord(rawTarget) ? rawTarget : null;
  if (!target) return null;

  const rawPath = offersResolvePickFirstTrimmed(target.path, target.mode).toLowerCase();
  const rawSubject = offersResolveIsRecord(target.subject) ? target.subject : null;
  const subjectProductGroupId =
    extractOffersResolveSubjectProductGroupId(rawSubject) ||
    offersResolvePickFirstTrimmed(target.product_group_id, target.productGroupId);
  const canonicalProductRef =
    normalizeOffersResolveCanonicalProductRef(target.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(target.product_ref, {
      allowOpaqueProductId: false,
    });

  if (rawPath === 'group' && subjectProductGroupId) {
    return buildOffersResolvePdpTargetGroup(subjectProductGroupId, canonicalProductRef || null);
  }
  if ((rawPath === 'ref' || rawPath === 'resolve') && canonicalProductRef) {
    return buildOffersResolvePdpTargetRef(canonicalProductRef, { path: rawPath });
  }
  if (rawPath === 'external') {
    const query = offersResolvePickFirstTrimmed(
      target?.external?.query,
      target?.external?.search_query,
      fallbackQuery,
    );
    return buildOffersResolvePdpTargetExternal(query, target.reason_code);
  }

  if (subjectProductGroupId) {
    return buildOffersResolvePdpTargetGroup(subjectProductGroupId, canonicalProductRef || null);
  }
  if (canonicalProductRef) {
    return buildOffersResolvePdpTargetRef(canonicalProductRef, { path: 'ref' });
  }
  return null;
}

function extractOffersResolvePdpTargetFromResponse(responseBody, { fallbackQuery = '' } = {}) {
  const body = offersResolveIsRecord(responseBody) ? responseBody : null;
  if (!body) return null;

  const explicitTargets = [
    body?.pdp_target?.v1,
    body?.pdpTarget?.v1,
    body?.mapping?.pdp_target?.v1,
    body?.mapping?.pdpTarget?.v1,
  ];
  for (const candidateTarget of explicitTargets) {
    const normalized = normalizeOffersResolvePdpTargetV1(candidateTarget, { fallbackQuery });
    if (normalized) return normalized;
  }

  const subjectProductGroupId = offersResolvePickFirstTrimmed(
    extractOffersResolveSubjectProductGroupId(body.subject),
    extractOffersResolveSubjectProductGroupId(body.mapping?.subject),
    body.product_group_id,
    body.productGroupId,
    body.mapping?.product_group_id,
    body.mapping?.productGroupId,
  );
  const canonicalProductRef =
    normalizeOffersResolveCanonicalProductRef(body.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(body.product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(body.mapping?.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(body.mapping?.product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(
      {
        product_id: offersResolvePickFirstTrimmed(
          body.canonical_product?.product_id,
          body.canonical_product?.productId,
          body.canonical_product?.id,
          body.mapping?.canonical_product?.product_id,
          body.mapping?.canonical_product?.productId,
          body.mapping?.canonical_product?.id,
          body.mapping?.canonicalProduct?.product_id,
          body.mapping?.canonicalProduct?.productId,
          body.mapping?.canonicalProduct?.id,
        ),
        merchant_id: offersResolvePickFirstTrimmed(
          body.canonical_product?.merchant_id,
          body.canonical_product?.merchantId,
          body.canonical_product?.merchant?.merchant_id,
          body.mapping?.canonical_product?.merchant_id,
          body.mapping?.canonical_product?.merchantId,
          body.mapping?.canonical_product?.merchant?.merchant_id,
          body.mapping?.canonicalProduct?.merchant_id,
          body.mapping?.canonicalProduct?.merchantId,
          body.mapping?.canonicalProduct?.merchant?.merchant_id,
        ),
      },
      {
        allowOpaqueProductId: false,
      },
    );

  if (subjectProductGroupId) {
    return buildOffersResolvePdpTargetGroup(subjectProductGroupId, canonicalProductRef || null);
  }
  if (canonicalProductRef) {
    return buildOffersResolvePdpTargetRef(canonicalProductRef, { path: 'ref' });
  }

  return null;
}

function normalizeOffersResolveInput(rawPayload, metadata) {
  const payload = offersResolveIsRecord(rawPayload) ? rawPayload : {};
  const offersPayload =
    offersResolveIsRecord(payload.offers) && Object.keys(payload.offers).length > 0
      ? payload.offers
      : payload;
  const product = offersResolveIsRecord(offersPayload.product) ? offersPayload.product : {};
  const subject =
    (offersResolveIsRecord(offersPayload.subject) ? offersPayload.subject : null) ||
    (offersResolveIsRecord(product.subject) ? product.subject : null);

  const subjectProductGroupId = offersResolvePickFirstTrimmed(
    extractOffersResolveSubjectProductGroupId(subject),
    offersPayload.product_group_id,
    offersPayload.productGroupId,
    product.product_group_id,
    product.productGroupId,
  );

  const canonicalProductRef =
    normalizeOffersResolveCanonicalProductRef(offersPayload.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(offersPayload.product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(product.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(product.product_ref, {
      allowOpaqueProductId: false,
    });

  const rawProductId = offersResolvePickFirstTrimmed(
    product.product_id,
    product.productId,
    offersPayload.product_id,
    offersPayload.productId,
  );
  const rawSkuId = offersResolvePickFirstTrimmed(
    product.sku_id,
    product.skuId,
    offersPayload.sku_id,
    offersPayload.skuId,
  );
  const rawMerchantId = offersResolvePickFirstTrimmed(
    product.merchant_id,
    product.merchantId,
    offersPayload.merchant_id,
    offersPayload.merchantId,
  );
  const brand = offersResolvePickFirstTrimmed(product.brand, offersPayload.brand);
  const name = offersResolvePickFirstTrimmed(product.name, product.title, offersPayload.name, offersPayload.title);
  const displayName = offersResolvePickFirstTrimmed(
    product.display_name,
    product.displayName,
    offersPayload.display_name,
    offersPayload.displayName,
    name,
  );

  let queryText = offersResolvePickFirstTrimmed(
    offersPayload.query,
    product.query,
    offersPayload.search_query,
    product.search_query,
  );
  if (!queryText) {
    if (brand && displayName) queryText = `${brand} ${displayName}`.trim();
    else {
      queryText = offersResolvePickFirstTrimmed(
        displayName,
        name,
        brand,
        rawProductId,
        rawSkuId,
      );
    }
  }

  const limitRaw = offersPayload.limit ?? payload.limit;
  const limit = Math.min(Math.max(1, Number(limitRaw || 10) || 10), 50);
  const market = offersResolvePickFirstTrimmed(offersPayload.market, payload.market) || null;
  const tool = offersResolvePickFirstTrimmed(offersPayload.tool, payload.tool) || null;
  const commerceSurface = extractCommerceSurfaceFromPayload(payload, metadata, {
    fallback: 'agent_api',
  });

  return {
    offers_payload: offersPayload,
    product,
    subject_product_group_id: subjectProductGroupId || null,
    canonical_product_ref: canonicalProductRef || null,
    raw_product_id: rawProductId || null,
    raw_sku_id: rawSkuId || null,
    raw_merchant_id: rawMerchantId || null,
    legacy_opaque_id:
      (rawProductId && offersResolveIsUuidLike(rawProductId)) ||
      (rawSkuId && offersResolveIsUuidLike(rawSkuId)),
    market,
    tool,
    commerce_surface: commerceSurface,
    limit,
    query_text: queryText || '',
    brand: brand || null,
    name: name || null,
    display_name: displayName || null,
    has_any_identifier: Boolean(
      subjectProductGroupId ||
        canonicalProductRef ||
        rawProductId ||
        rawSkuId ||
        queryText,
    ),
  };
}

function hasStrongOffersResolveLookupInput(normalizedInput) {
  const input = offersResolveIsRecord(normalizedInput) ? normalizedInput : {};
  if (offersResolvePickFirstTrimmed(input.raw_merchant_id)) return true;

  const rawProductId = offersResolvePickFirstTrimmed(input.raw_product_id);
  if (rawProductId && !offersResolveIsUuidLike(rawProductId)) return true;

  const rawSkuId = offersResolvePickFirstTrimmed(input.raw_sku_id);
  if (rawSkuId && !offersResolveIsUuidLike(rawSkuId)) return true;

  return false;
}

function buildOffersResolveResponse({
  upstreamBody,
  reasonCode,
  pdpTargetV1,
  sourceTrace,
  queryText,
  startedAtMs,
  failReasonCode = null,
  commerceSurface = 'agent_api',
}) {
  const base = offersResolveIsRecord(upstreamBody) ? { ...upstreamBody } : {};
  const nestedData = offersResolveIsRecord(base.data) ? base.data : {};
  const offers = Array.isArray(base.offers)
    ? base.offers
    : Array.isArray(nestedData.offers)
      ? nestedData.offers
      : [];
  const mappingBase = offersResolveIsRecord(base.mapping) ? { ...base.mapping } : {};
  const metadataBase = offersResolveIsRecord(base.metadata) ? { ...base.metadata } : {};
  const normalizedReasonCode = normalizeOffersResolveReasonCode(
    reasonCode,
    failReasonCode ? normalizeOffersResolveReasonCode(failReasonCode, 'no_candidates') : 'no_candidates',
  );
  const normalizedFailReason = failReasonCode
    ? normalizeOffersResolveReasonCode(failReasonCode, 'no_candidates')
    : null;
  const totalLatencyMs = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
  const normalizedPdpTarget = offersResolveIsRecord(pdpTargetV1) ? pdpTargetV1 : null;
  const pdpPath = normalizedPdpTarget
    ? offersResolvePickFirstTrimmed(normalizedPdpTarget.path).toLowerCase() || null
    : null;

  const response = {
    ...base,
    status: base.status || 'success',
    offers,
    offers_count:
      Number.isFinite(Number(base.offers_count)) && Number(base.offers_count) >= 0
        ? Number(base.offers_count)
        : offers.length,
    reason_code: normalizedReasonCode,
    reason: base.reason || normalizedReasonCode,
    pdp_target: {
      ...(offersResolveIsRecord(base.pdp_target) ? base.pdp_target : {}),
      v1: normalizedPdpTarget,
    },
    mapping: {
      ...mappingBase,
      pdp_target: {
        ...(offersResolveIsRecord(mappingBase.pdp_target) ? mappingBase.pdp_target : {}),
        v1: normalizedPdpTarget,
      },
      source_trace: Array.isArray(sourceTrace) ? sourceTrace : [],
    },
    metadata: {
      ...metadataBase,
      source: 'offers.resolve',
      commerce_surface: normalizeCommerceSurface(commerceSurface),
      time_to_pdp_ms: totalLatencyMs,
      sources: Array.isArray(sourceTrace) ? sourceTrace : [],
      ...(pdpPath ? { pdp_open_path: pdpPath } : {}),
      ...(queryText ? { query: queryText } : {}),
      ...(normalizedFailReason
        ? {
            fail_reason: normalizedFailReason,
            resolve_fail_reason: normalizedFailReason,
            resolve_reason_code: normalizedFailReason,
          }
        : {}),
    },
  };

  if (response.status === 'success' && offers.length === 0 && !response.reason_code) {
    response.reason_code = 'no_candidates';
    response.reason = response.reason || 'no_candidates';
  }

  return response;
}

function createOffersResolveOwner({
  axiosClient,
  pivotaApiBase,
  buildInvokeUpstreamAuthHeaders,
  resolveStableAliasByQuery = null,
  normalizeResolverText = (value) => String(value || '').trim().toLowerCase(),
  tokenizeResolverQuery = () => [],
  config = {},
} = {}) {
  const axios = axiosClient;
  const buildUpstreamHeaders =
    typeof buildInvokeUpstreamAuthHeaders === 'function'
      ? buildInvokeUpstreamAuthHeaders
      : () => ({});

  const {
    subjectTimeoutMs = 1200,
    cacheSearchTimeoutMs = 1200,
    subjectRetryMax = 0,
    cacheSearchRetryMax = 0,
    subjectRetryBackoffMs = 120,
    cacheSearchRetryBackoffMs = 120,
    circuitFailureThreshold = 1,
    circuitOpenMs = 30000,
    skipCacheSearchOnSubjectTimeout = true,
    skipCacheSearchOnSubjectNoCandidates = true,
  } = config;

  const circuits = {
    subject_resolve: { failure_count: 0, last_reason: null, open_until_ms: 0 },
    cache_search: { failure_count: 0, last_reason: null, open_until_ms: 0 },
  };

  function resolveOffersResolveStableAliasRef(normalizedInput) {
    if (!resolveStableAliasByQuery) return null;
    const input = normalizedInput || {};
    const composedBrandTitle = offersResolvePickFirstTrimmed(
      input.brand && input.display_name ? `${input.brand} ${input.display_name}` : '',
      input.brand && input.name ? `${input.brand} ${input.name}` : '',
    );
    const candidateQueries = [
      input.query_text,
      input.display_name,
      input.name,
      composedBrandTitle,
      input.raw_product_id,
      input.raw_sku_id,
    ];
    const seen = new Set();

    for (const rawCandidate of candidateQueries) {
      const query = String(rawCandidate || '').trim();
      if (!query) continue;
      const dedupeKey = query.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const normalizedQuery = normalizeResolverText(query);
      const queryTokens = tokenizeResolverQuery(normalizedQuery);
      if (!normalizedQuery || !Array.isArray(queryTokens) || queryTokens.length === 0) continue;

      const matched = resolveStableAliasByQuery({
        query,
        normalizedQuery,
        queryTokens,
      });
      if (
        matched &&
        matched.product_ref &&
        matched.product_ref.product_id &&
        matched.product_ref.merchant_id
      ) {
        return {
          product_ref: {
            product_id: String(matched.product_ref.product_id).trim(),
            merchant_id: String(matched.product_ref.merchant_id).trim(),
          },
          match_id: String(matched.id || '').trim() || null,
          match_reason: String(matched.reason || '').trim() || null,
          matched_alias: String(matched.matched_alias || query).trim() || query,
        };
      }
    }
    return null;
  }

  function buildOffersResolveCacheSearchPayload(normalizedInput) {
    const input = normalizedInput || {};
    const product = {};

    const canonicalRef = normalizeOffersResolveCanonicalProductRef(input.canonical_product_ref, {
      allowOpaqueProductId: false,
    });
    if (canonicalRef) product.canonical_product_ref = canonicalRef;
    if (input.subject_product_group_id) product.product_group_id = String(input.subject_product_group_id).trim();
    if (input.raw_merchant_id) product.merchant_id = String(input.raw_merchant_id).trim();

    const rawProductId = offersResolvePickFirstTrimmed(input.raw_product_id);
    const rawSkuId = offersResolvePickFirstTrimmed(input.raw_sku_id);
    if (rawProductId && !offersResolveIsUuidLike(rawProductId)) product.product_id = rawProductId;
    if (rawSkuId) product.sku_id = rawSkuId;
    if (input.brand) product.brand = input.brand;
    if (input.name) product.name = input.name;
    if (input.display_name) product.display_name = input.display_name;

    return {
      product,
      ...(input.market ? { market: input.market } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.commerce_surface ? { commerce_surface: input.commerce_surface } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.query_text ? { query: input.query_text } : {}),
    };
  }

  function getOffersResolveCircuitState(sourceKey) {
    const key = sourceKey === 'cache_search' ? 'cache_search' : 'subject_resolve';
    return circuits[key];
  }

  function markOffersResolveCircuitSuccess(sourceKey) {
    const state = getOffersResolveCircuitState(sourceKey);
    state.failure_count = 0;
    state.last_reason = null;
    state.open_until_ms = 0;
  }

  function shouldTripOffersResolveCircuit({ reason, status } = {}) {
    if (reason === 'upstream_timeout' || reason === 'upstream_error') return true;
    const code = Number(status || 0);
    return code === 408 || code === 429 || code >= 500;
  }

  function markOffersResolveCircuitFailure(sourceKey, reason, status) {
    const state = getOffersResolveCircuitState(sourceKey);
    if (!shouldTripOffersResolveCircuit({ reason, status })) return;
    state.failure_count += 1;
    state.last_reason = reason || null;
    if (state.failure_count >= circuitFailureThreshold) {
      state.failure_count = 0;
      state.open_until_ms = Date.now() + circuitOpenMs;
    }
  }

  async function callOffersResolveSourceWithRetry({
    sourceKey,
    url,
    body,
    checkoutToken,
    timeoutMs,
    maxRetries,
    retryBackoffMs,
  }) {
    const source = sourceKey === 'cache_search' ? 'cache_search' : 'subject_resolve';
    const state = getOffersResolveCircuitState(source);
    if (state.open_until_ms > Date.now()) {
      return {
        ok: false,
        source_trace: {
          source,
          ok: false,
          attempts: 0,
          latency_ms: 0,
          reason: 'circuit_open',
        },
        reason: 'circuit_open',
        status: 503,
        response_body: null,
      };
    }

    const startedAt = Date.now();
    const safeTimeoutMs = Math.max(100, Number(timeoutMs) || 1000);
    const safeRetries = Math.max(0, Math.min(3, Number(maxRetries) || 0));
    const safeBackoffMs = Math.max(25, Number(retryBackoffMs) || 100);
    const headers = {
      'Content-Type': 'application/json',
      ...buildUpstreamHeaders({ checkoutToken }),
    };

    let attempts = 0;
    let lastStatus = null;
    let lastReason = 'upstream_timeout';
    let lastBody = null;
    let lastError = null;

    while (attempts <= safeRetries) {
      attempts += 1;
      try {
        const resp = await axios.post(url, body, {
          headers,
          timeout: safeTimeoutMs,
          validateStatus: () => true,
        });
        lastStatus = Number(resp?.status || 0) || null;
        lastBody = offersResolveIsRecord(resp?.data) ? resp.data : null;
        if (lastStatus >= 200 && lastStatus < 300) {
          markOffersResolveCircuitSuccess(source);
          return {
            ok: true,
            response_body: lastBody,
            status: lastStatus,
            attempts,
            source_trace: {
              source,
              ok: true,
              attempts,
              latency_ms: Math.max(0, Date.now() - startedAt),
              status: lastStatus,
            },
          };
        }

        lastReason = inferOffersResolveFailureReasonCode({
          responseBody: lastBody,
          statusCode: lastStatus,
        });
        const retryable = lastStatus === 408 || lastStatus === 429 || lastStatus >= 500;
        if (!retryable || attempts > safeRetries) break;
        await sleepMs(safeBackoffMs * attempts);
      } catch (err) {
        lastError = err;
        lastReason = inferOffersResolveFailureReasonCode({ error: err });
        const errText = String(err?.code || err?.message || err || '').toLowerCase();
        const retryable =
          errText.includes('timeout') ||
          errText.includes('econnaborted') ||
          errText.includes('etimedout');
        if (!retryable || attempts > safeRetries) break;
        await sleepMs(safeBackoffMs * attempts);
      }
    }

    markOffersResolveCircuitFailure(source, lastReason, lastStatus);
    return {
      ok: false,
      response_body: lastBody,
      status: lastStatus,
      attempts,
      reason: lastReason,
      error: lastError,
      source_trace: {
        source,
        ok: false,
        attempts,
        latency_ms: Math.max(0, Date.now() - startedAt),
        ...(lastStatus ? { status: lastStatus } : {}),
        reason: lastReason,
      },
    };
  }

  function shouldSkipOffersResolveCacheSearch(subjectResult, normalizedInput) {
    if (!subjectResult || subjectResult.ok) return false;

    const rawReason = String(subjectResult.reason || '').trim().toLowerCase();
    if (rawReason === 'circuit_open') return true;

    const normalizedReason = normalizeOffersResolveReasonCode(rawReason, '');
    if (normalizedReason === 'upstream_timeout') {
      return skipCacheSearchOnSubjectTimeout;
    }
    if (normalizedReason === 'no_candidates') {
      if (!skipCacheSearchOnSubjectNoCandidates) return false;
      return !hasStrongOffersResolveLookupInput(normalizedInput);
    }
    return false;
  }

  async function handleOffersResolveOperation({
    payload,
    metadata,
    checkoutToken,
  }) {
    const startedAt = Date.now();
    const sourceTrace = [];
    const normalizedInput = normalizeOffersResolveInput(payload, metadata);

    if (!normalizedInput.has_any_identifier) {
      return {
        statusCode: 400,
        response: {
          error: 'MISSING_PARAMETERS',
          message:
            'offers.resolve requires product.sku_id, product.product_id, subject.product_group_id, canonical_product_ref, or query',
        },
      };
    }

    if (normalizedInput.subject_product_group_id) {
      const pdpTarget = buildOffersResolvePdpTargetGroup(
        normalizedInput.subject_product_group_id,
        normalizedInput.canonical_product_ref,
      );
      sourceTrace.push({
        source: 'stable_input',
        ok: true,
        attempts: 0,
        latency_ms: 0,
        reason: 'subject_direct',
      });
      return {
        statusCode: 200,
        response: buildOffersResolveResponse({
          upstreamBody: {
            status: 'success',
            offers: [],
            offers_count: 0,
            input: {
              product_id: normalizedInput.raw_product_id,
              sku_id: normalizedInput.raw_sku_id,
            },
          },
          reasonCode: 'subject_direct',
          pdpTargetV1: pdpTarget,
          sourceTrace,
          queryText: normalizedInput.query_text,
          startedAtMs: startedAt,
          commerceSurface: normalizedInput.commerce_surface,
        }),
      };
    }

    if (normalizedInput.canonical_product_ref) {
      const pdpTarget = buildOffersResolvePdpTargetRef(normalizedInput.canonical_product_ref, {
        path: 'ref',
      });
      sourceTrace.push({
        source: 'stable_input',
        ok: true,
        attempts: 0,
        latency_ms: 0,
        reason: 'canonical_ref_direct',
      });
      return {
        statusCode: 200,
        response: buildOffersResolveResponse({
          upstreamBody: {
            status: 'success',
            offers: [],
            offers_count: 0,
            input: {
              product_id: normalizedInput.raw_product_id,
              sku_id: normalizedInput.raw_sku_id,
            },
          },
          reasonCode: 'canonical_ref_direct',
          pdpTargetV1: pdpTarget,
          sourceTrace,
          queryText: normalizedInput.query_text,
          startedAtMs: startedAt,
          commerceSurface: normalizedInput.commerce_surface,
        }),
      };
    }

    const directRawProductRef =
      normalizedInput.raw_merchant_id && (normalizedInput.raw_product_id || normalizedInput.raw_sku_id)
        ? normalizeOffersResolveCanonicalProductRef(
            {
              merchant_id: normalizedInput.raw_merchant_id,
              product_id: normalizedInput.raw_product_id || normalizedInput.raw_sku_id,
            },
            { allowOpaqueProductId: false },
          )
        : null;
    if (directRawProductRef) {
      const pdpTarget = buildOffersResolvePdpTargetRef(directRawProductRef, { path: 'ref' });
      sourceTrace.push({
        source: 'stable_input',
        ok: true,
        attempts: 0,
        latency_ms: 0,
        reason: 'raw_ref_direct',
      });
      return {
        statusCode: 200,
        response: buildOffersResolveResponse({
          upstreamBody: {
            status: 'success',
            offers: [],
            offers_count: 0,
            input: {
              product_id: normalizedInput.raw_product_id,
              sku_id: normalizedInput.raw_sku_id,
            },
            mapping: {
              canonical_product_ref: directRawProductRef,
            },
          },
          reasonCode: 'canonical_ref_direct',
          pdpTargetV1: pdpTarget,
          sourceTrace,
          queryText: normalizedInput.query_text,
          startedAtMs: startedAt,
          commerceSurface: normalizedInput.commerce_surface,
        }),
      };
    }

    const stableAliasRef = resolveOffersResolveStableAliasRef(normalizedInput);
    if (stableAliasRef?.product_ref) {
      const pdpTarget = buildOffersResolvePdpTargetRef(stableAliasRef.product_ref, {
        path: 'ref',
      });
      sourceTrace.push({
        source: 'stable_alias_ref',
        ok: true,
        attempts: 0,
        latency_ms: 0,
        reason: stableAliasRef.match_reason || 'stable_alias_ref',
        ...(stableAliasRef.match_id ? { match_id: stableAliasRef.match_id } : {}),
        ...(stableAliasRef.matched_alias ? { matched_alias: stableAliasRef.matched_alias } : {}),
      });
      return {
        statusCode: 200,
        response: buildOffersResolveResponse({
          upstreamBody: {
            status: 'success',
            offers: [],
            offers_count: 0,
            input: {
              product_id: normalizedInput.raw_product_id,
              sku_id: normalizedInput.raw_sku_id,
            },
            mapping: {
              canonical_product_ref: stableAliasRef.product_ref,
            },
            metadata: {
              source: 'offers.resolve',
              resolve_source: 'stable_alias_ref',
              stable_alias_match_id: stableAliasRef.match_id || null,
              stable_alias_match_query: stableAliasRef.matched_alias || null,
            },
          },
          reasonCode: 'stable_alias_ref',
          pdpTargetV1: pdpTarget,
          sourceTrace,
          queryText: normalizedInput.query_text,
          startedAtMs: startedAt,
          commerceSurface: normalizedInput.commerce_surface,
        }),
      };
    }

    const subjectResolvePayload = {
      product: {
        ...(normalizedInput.raw_product_id ? { product_id: normalizedInput.raw_product_id } : {}),
        ...(normalizedInput.raw_sku_id ? { sku_id: normalizedInput.raw_sku_id } : {}),
        ...(normalizedInput.raw_merchant_id ? { merchant_id: normalizedInput.raw_merchant_id } : {}),
        ...(normalizedInput.brand ? { brand: normalizedInput.brand } : {}),
        ...(normalizedInput.name ? { name: normalizedInput.name } : {}),
        ...(normalizedInput.display_name ? { display_name: normalizedInput.display_name } : {}),
        ...(normalizedInput.query_text ? { query: normalizedInput.query_text } : {}),
      },
      ...(normalizedInput.query_text ? { query: normalizedInput.query_text } : {}),
      ...(normalizedInput.market ? { market: normalizedInput.market } : {}),
      ...(normalizedInput.tool ? { tool: normalizedInput.tool } : {}),
      source: 'offers.resolve',
      metadata: {
        ...(offersResolveIsRecord(metadata) ? metadata : {}),
        commerce_surface: normalizedInput.commerce_surface,
      },
    };

    const subjectResult = await callOffersResolveSourceWithRetry({
      sourceKey: 'subject_resolve',
      url: `${pivotaApiBase}/v1/subject/resolve`,
      body: subjectResolvePayload,
      checkoutToken,
      timeoutMs: subjectTimeoutMs,
      maxRetries: subjectRetryMax,
      retryBackoffMs: subjectRetryBackoffMs,
    });
    sourceTrace.push(subjectResult.source_trace);

    if (subjectResult.ok) {
      const subjectTarget = extractOffersResolvePdpTargetFromResponse(subjectResult.response_body, {
        fallbackQuery: normalizedInput.query_text,
      });
      if (subjectTarget && subjectTarget.path !== 'external') {
        return {
          statusCode: 200,
          response: buildOffersResolveResponse({
            upstreamBody: {
              ...(offersResolveIsRecord(subjectResult.response_body)
                ? subjectResult.response_body
                : { status: 'success' }),
              offers: [],
              offers_count: 0,
              input: {
                product_id: normalizedInput.raw_product_id,
                sku_id: normalizedInput.raw_sku_id,
              },
            },
            reasonCode: 'subject_direct',
            pdpTargetV1: subjectTarget,
            sourceTrace,
            queryText: normalizedInput.query_text,
            startedAtMs: startedAt,
            commerceSurface: normalizedInput.commerce_surface,
          }),
        };
      }
    }

    if (shouldSkipOffersResolveCacheSearch(subjectResult, normalizedInput)) {
      const failReasonCode = normalizeOffersResolveReasonCode(
        subjectResult.reason,
        'upstream_timeout',
      );
      return {
        statusCode: 200,
        response: buildOffersResolveResponse({
          upstreamBody: {
            status: 'success',
            offers: [],
            offers_count: 0,
            input: {
              product_id: normalizedInput.raw_product_id,
              sku_id: normalizedInput.raw_sku_id,
            },
          },
          reasonCode: failReasonCode,
          pdpTargetV1: null,
          sourceTrace,
          queryText: normalizedInput.query_text,
          startedAtMs: startedAt,
          failReasonCode,
          commerceSurface: normalizedInput.commerce_surface,
        }),
      };
    }

    const cacheSearchPayload = {
      operation: 'offers.resolve',
      payload: buildOffersResolveCacheSearchPayload(normalizedInput),
      metadata: {
        ...(offersResolveIsRecord(metadata) ? metadata : {}),
        commerce_surface: normalizedInput.commerce_surface,
      },
    };

    const cacheSearchResult = await callOffersResolveSourceWithRetry({
      sourceKey: 'cache_search',
      url: `${pivotaApiBase}/agent/shop/v1/invoke`,
      body: cacheSearchPayload,
      checkoutToken,
      timeoutMs: cacheSearchTimeoutMs,
      maxRetries: cacheSearchRetryMax,
      retryBackoffMs: cacheSearchRetryBackoffMs,
    });
    sourceTrace.push(cacheSearchResult.source_trace);

    if (cacheSearchResult.ok) {
      const upstreamBody = cacheSearchResult.response_body;
      const pdpTarget = extractOffersResolvePdpTargetFromResponse(upstreamBody, {
        fallbackQuery: normalizedInput.query_text,
      });

      const offers = Array.isArray(upstreamBody?.offers)
        ? upstreamBody.offers
        : Array.isArray(upstreamBody?.data?.offers)
          ? upstreamBody.data.offers
          : [];
      const explicitReasonCode = normalizeOffersResolveReasonCode(
        upstreamBody?.reason_code ||
          upstreamBody?.reasonCode ||
          upstreamBody?.metadata?.reason_code ||
          upstreamBody?.metadata?.resolve_reason_code,
        '',
      );
      const inferredFailureCode =
        !pdpTarget || pdpTarget.path === 'external'
          ? inferOffersResolveFailureReasonCode({
              responseBody: upstreamBody,
              statusCode: cacheSearchResult.status,
            })
          : null;
      const pdpPath = offersResolvePickFirstTrimmed(pdpTarget?.path).toLowerCase();
      const internalPdp = pdpPath === 'group' || pdpPath === 'ref' || pdpPath === 'resolve';
      const resolvedReasonCode = internalPdp
        ? explicitReasonCode && explicitReasonCode !== 'no_candidates'
          ? explicitReasonCode
          : 'mapped_hit'
        : explicitReasonCode || inferredFailureCode || (offers.length ? 'mapped_hit' : 'no_candidates');

      return {
        statusCode: 200,
        response: buildOffersResolveResponse({
          upstreamBody,
          reasonCode: resolvedReasonCode,
          pdpTargetV1: pdpTarget,
          sourceTrace,
          queryText: normalizedInput.query_text,
          startedAtMs: startedAt,
          failReasonCode: !pdpTarget || pdpTarget.path === 'external' ? inferredFailureCode : null,
          commerceSurface: normalizedInput.commerce_surface,
        }),
      };
    }

    const failReasonCode = inferOffersResolveFailureReasonCode({
      responseBody: cacheSearchResult.response_body,
      statusCode: cacheSearchResult.status,
      error: cacheSearchResult.error,
    });
    return {
      statusCode: 200,
      response: buildOffersResolveResponse({
        upstreamBody: {
          status: 'success',
          offers: [],
          offers_count: 0,
          input: {
            product_id: normalizedInput.raw_product_id,
            sku_id: normalizedInput.raw_sku_id,
          },
        },
        reasonCode: failReasonCode || 'fallback_external',
        pdpTargetV1: null,
        sourceTrace,
        queryText: normalizedInput.query_text,
        startedAtMs: startedAt,
        failReasonCode: failReasonCode || 'fallback_external',
        commerceSurface: normalizedInput.commerce_surface,
      }),
    };
  }

  return {
    handleOffersResolveOperation,
    inferOffersResolveFailureReasonCode,
    buildOffersResolvePdpTargetExternal,
    buildOffersResolveResponse,
    normalizeOffersResolveReasonCode,
  };
}

module.exports = {
  createOffersResolveOwner,
  normalizeOffersResolveReasonCode,
  inferOffersResolveFailureReasonCode,
  buildOffersResolvePdpTargetExternal,
  buildOffersResolveResponse,
};
