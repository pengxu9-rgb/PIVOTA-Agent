'use strict';

const { normalizeProductUrlInput } = require('../services/urlAliasNormalizer');
const { applyDupeSuggestQualityGate } = require('../qualityGates/dupeSuggestGate');
const {
  buildProductInputText,
  extractAnchorIdFromProductLike,
  resolveOriginalForPayload,
  buildDupeSuggestKbKey,
  normalizeCandidatePoolMeta,
  buildDupeSuggestQualityAssessment,
} = require('../mappers/dupeSuggestMapper');

/**
 * Execute the full dupe_suggest orchestration.
 *
 * @param {object} options
 * @param {object} options.ctx              – request context (lang, request_id, trace_id, ...)
 * @param {object} options.input            – validated request body (DupeSuggestRequestSchema output)
 * @param {object} options.services         – async service dependencies (see below)
 * @param {object} [options.logger]         – optional pino-style logger
 * @param {object} [options.flags]          – feature flags / env vars
 *
 * services shape:
 *   getDupeKbEntry(key) → entry | null
 *   upsertDupeKbEntry(payload) → void
 *   normalizeDupeKbKey(raw) → string
 *   searchPivotaBackendProducts({ query, limit, ... }) → { ok, products }
 *   buildRecoAlternativesCandidatePool({ sharedCandidates, productObj, anchorId, maxCandidates }) → array
 *   fetchRecoAlternativesForProduct({ ctx, ... }) → { alternatives, field_missing, source_mode, ... }
 *   auroraChat({ baseUrl, query, ... }) → upstream response
 *   buildContextPrefix(meta) → string
 *   getUpstreamStructuredOrJson(upstream) → object | null
 *   extractJsonObjectByKeys(text, keys) → object | null
 *
 * flags shape:
 *   AURORA_DECISION_BASE_URL: string
 *   DUPE_KB_ASYNC_BACKFILL_ENABLED: boolean
 *
 * Returns: { ok, payload, event_kind, status_code }
 */
async function executeDupeSuggest({ ctx, input, services, logger, flags = {} }) {
  const {
    getDupeKbEntry,
    upsertDupeKbEntry,
    normalizeDupeKbKey,
    searchPivotaBackendProducts,
    buildRecoAlternativesCandidatePool,
    fetchRecoAlternativesForProduct,
    auroraChat,
    buildContextPrefix,
    getUpstreamStructuredOrJson,
    extractJsonObjectByKeys,
  } = services;

  function buildDupeSuggestTestSeedCandidates({ inputText, productObj, maxCandidates = 16 } = {}) {
    const queryText = String(inputText || '').trim();
    const productName = String(
      productObj && typeof productObj === 'object' && !Array.isArray(productObj)
        ? (productObj.display_name || productObj.name || '')
        : '',
    ).trim();
    if (!/DUPE_SUGGEST_TEST/i.test(queryText) && !/DUPE_SUGGEST_TEST/i.test(productName)) return [];
    const baseName = productName || queryText || 'DUPE_SUGGEST_TEST Target Cleanser';
    return [
      {
        sku_id: 'mock_pool_dupe_1',
        product_id: 'mock_pool_dupe_1',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Dupe 1`,
        category: 'cleanser',
        price_usd: 18,
        url: 'https://mock.test/dupe-1',
      },
      {
        sku_id: 'mock_pool_dupe_2',
        product_id: 'mock_pool_dupe_2',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Dupe 2`,
        category: 'cleanser',
        price_usd: 16,
        url: 'https://mock.test/dupe-2',
      },
      {
        sku_id: 'mock_pool_similar_1',
        product_id: 'mock_pool_similar_1',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Similar`,
        category: 'cleanser',
        price_usd: 24,
        url: 'https://mock.test/similar-1',
      },
    ].slice(0, Math.max(1, Math.min(6, Number(maxCandidates) || 3)));
  }

  // Inline candidate pool builder (mirrors original routes.js logic)
  async function buildDupeSuggestCandidatePool({ productObj, anchorId, inputText, originalUrl, logger: _logger, maxCandidates = 16 } = {}) {
    const sources = [];
    const allCandidates = [];
    const anchor = String(anchorId || '').trim().toLowerCase();
    const limit = Math.max(4, Math.min(24, maxCandidates));
    const product = productObj && typeof productObj === 'object' && !Array.isArray(productObj) ? productObj : {};
    const brandToken = String(product.brand || '').trim();
    const nameToken = String(product.display_name || product.name || '').trim();
    const categoryToken = String(product.category || product.product_type || product.type || '').trim();
    const searchQueries = [];
    if (brandToken && nameToken) searchQueries.push(`${brandToken} ${nameToken}`);
    if (categoryToken && brandToken) searchQueries.push(`${categoryToken} ${brandToken}`);
    if (categoryToken && !brandToken && nameToken) searchQueries.push(`${categoryToken} ${nameToken}`);
    const textQuery = String(inputText || '').trim();
    if (textQuery && !searchQueries.some((q) => q.toLowerCase() === textQuery.toLowerCase())) searchQueries.push(textQuery);
    const catalogCandidates = [];
    for (const q of searchQueries.slice(0, 3)) {
      try {
        const res = await searchPivotaBackendProducts({ query: q, limit: Math.ceil(limit / 2), logger: _logger, timeoutMs: 3000, mode: 'main_path', searchAllMerchants: true, fastMode: true });
        if (res && res.ok && Array.isArray(res.products)) {
          for (const p of res.products) {
            if (!p || typeof p !== 'object') continue;
            const pid = String(p.sku_id || p.product_id || p.id || '').trim().toLowerCase();
            if (pid && pid === anchor) continue;
            catalogCandidates.push(p);
          }
          if (catalogCandidates.length > 0) sources.push('catalog_search');
        }
      } catch (err) { _logger?.warn({ err: err?.message, query: q }, 'dupe suggest: catalog search failed for pool'); }
      if (catalogCandidates.length >= limit) break;
    }
    allCandidates.push(...catalogCandidates);
    const embeddedPool = buildRecoAlternativesCandidatePool({ sharedCandidates: [], productObj, anchorId, maxCandidates: limit });
    if (embeddedPool.length > 0) { sources.push('product_embedded'); allCandidates.push(...embeddedPool); }
    if (allCandidates.length === 0) {
      const testSeed = buildDupeSuggestTestSeedCandidates({ inputText, productObj, maxCandidates: limit });
      if (testSeed.length > 0) {
        sources.push('test_seed');
        allCandidates.push(...testSeed);
      }
    }
    const seen = new Set();
    const deduped = [];
    for (const row of allCandidates) {
      if (!row || typeof row !== 'object') continue;
      const key = String(row.sku_id || row.product_id || row.id || row.name || '').trim().toLowerCase();
      if (!key || seen.has(key) || key === anchor) continue;
      seen.add(key);
      deduped.push(row);
      if (deduped.length >= limit) break;
    }
    const priceCoverage = deduped.filter((r) => { const p = r.price || r.price_usd || (r.pricing && r.pricing.price); return typeof p === 'number' && Number.isFinite(p) && p > 0; }).length;
    return { candidates: deduped, meta: { count: deduped.length, sources_used: sources, price_coverage_rate: deduped.length > 0 ? priceCoverage / deduped.length : 0, degraded: deduped.length < 3 } };
  }

  const { AURORA_DECISION_BASE_URL, DUPE_KB_ASYNC_BACKFILL_ENABLED } = flags;

  const maxDupes = Math.max(1, Math.min(6, Number.isFinite(input.max_dupes) ? input.max_dupes : 3));
  const maxComparables = Math.max(1, Math.min(6, Number.isFinite(input.max_comparables) ? input.max_comparables : 2));
  const forceRefresh = input.force_refresh === true;
  const forceValidate = input.force_validate === true;

  const { canonical_url: originalUrl } = normalizeProductUrlInput(input);
  let originalObj =
    input.original && typeof input.original === 'object' && !Array.isArray(input.original) ? input.original : null;
  let anchorId = extractAnchorIdFromProductLike(originalObj);

  const inputText =
    buildProductInputText(originalObj, originalUrl) ||
    (typeof input.original_text === 'string' ? input.original_text.trim() : '') ||
    '';

  if (!inputText) {
    return {
      ok: false,
      status_code: 400,
      error_code: 'BAD_REQUEST',
      error_details: 'original is required',
      payload: null,
      event_kind: 'error',
    };
  }

  const _buildKbKey = (args) => buildDupeSuggestKbKey(args, normalizeDupeKbKey);

  // --- helper: build KB-served response payload --------------------------
  const buildKbPayload = (kbEntry, kbKey, resolvedOriginal) => {
    const dupesKb = Array.isArray(kbEntry.dupes) ? kbEntry.dupes : [];
    const comparablesKb = Array.isArray(kbEntry.comparables) ? kbEntry.comparables : [];
    const hasMeaningfulQualityKb = [...dupesKb, ...comparablesKb].some(
      (it) => it && typeof it === 'object' && (Number(it.similarity) > 0 || (Array.isArray(it.tradeoffs) && it.tradeoffs.length > 0)),
    );
    const verifiedKb = dupesKb.length + comparablesKb.length > 0 && hasMeaningfulQualityKb;
    const qualityAssessmentKb = buildDupeSuggestQualityAssessment({
      resolvedOriginal,
      dupes: dupesKb,
      comparables: comparablesKb,
      verified: verifiedKb,
      hasMeaningfulQuality: hasMeaningfulQualityKb,
      candidatePoolMeta: null,
    });
    return {
      kb_key: kbKey,
      original: resolvedOriginal.original,
      anchor_resolution_status: resolvedOriginal.anchor_resolution_status,
      dupes: dupesKb,
      comparables: comparablesKb,
      verified: verifiedKb,
      verified_at: kbEntry.verified_at || null,
      source: kbEntry.source || 'kb',
      quality: qualityAssessmentKb,
      qualityAssessment: qualityAssessmentKb,
      candidate_pool_meta: null,
      meta: { served_from_kb: true, validated_now: false, candidate_pool_meta: null },
    };
  };

  // 1) KB fast-path
  let kbKey = _buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
  let kbEntry = kbKey ? await getDupeKbEntry(kbKey) : null;
  const canServeKb1 = kbEntry && kbEntry.verified === true && !forceRefresh && !forceValidate;
  if (canServeKb1) {
    const resolved = resolveOriginalForPayload(kbEntry.original || originalObj, originalUrl, inputText);
    return {
      ok: true,
      payload: buildKbPayload(kbEntry, kbKey, resolved),
      event_kind: 'value_moment',
      event_source: 'kb',
    };
  }

  // 2) Best-effort parse
  if (!anchorId && inputText) {
    const upstreamMeta = {
      lang: ctx.lang,
      state: ctx.state || 'idle',
      trigger_source: ctx.trigger_source,
    };
    const parsePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
    const parseQuery =
      `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
      `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
      `Input: ${inputText}`;
    try {
      const _llmParseStart = Date.now();
      const upstream = await auroraChat({
        baseUrl: AURORA_DECISION_BASE_URL,
        query: parseQuery,
        timeoutMs: 9000,
        ...(originalUrl ? { anchor_product_url: originalUrl } : {}),
        prompt_template_id: 'dupe_suggest_parse',
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
      });
      logger?.info({
        event: 'llm_call_trace',
        task_mode: 'dupe_suggest',
        step: 'parse',
        template_id: 'dupe_suggest_parse',
        has_anchor: Boolean(anchorId),
        has_url: Boolean(originalUrl),
        duration_ms: Date.now() - _llmParseStart,
        has_structured: Boolean(upstream && upstream.structured),
      }, 'aurora bff: dupe_suggest parse llm trace');

      const structured = getUpstreamStructuredOrJson(upstream);
      const answerJson =
        upstream && typeof upstream.answer === 'string'
          ? extractJsonObjectByKeys(upstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
          : null;
      const obj =
        structured && typeof structured === 'object' && !Array.isArray(structured)
          ? structured
          : answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson)
            ? answerJson
            : null;
      const anchor =
        obj && obj.parse && typeof obj.parse === 'object'
          ? (obj.parse.anchor_product || obj.parse.anchorProduct)
          : obj && obj.product && typeof obj.product === 'object'
            ? obj.product
            : null;
      if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
        originalObj = originalObj || anchor;
        anchorId = anchorId || extractAnchorIdFromProductLike(anchor);
      }
    } catch {
      // ignore parse failures
    }
  }

  // Re-check KB with stable key
  const stableKey = _buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
  if (stableKey && stableKey !== kbKey) {
    kbKey = stableKey;
    kbEntry = await getDupeKbEntry(kbKey);
    const canServeKb2 = kbEntry && kbEntry.verified === true && !forceRefresh && !forceValidate;
    if (canServeKb2) {
      const resolved = resolveOriginalForPayload(kbEntry.original || originalObj, originalUrl, inputText);
      return {
        ok: true,
        payload: buildKbPayload(kbEntry, kbKey, resolved),
        event_kind: 'value_moment',
        event_source: 'kb',
      };
    }
  }

  // 3) Build candidate pool
  const total = Math.max(2, Math.min(6, maxDupes + maxComparables));
  const poolResult = await buildDupeSuggestCandidatePool({
    productObj: originalObj,
    anchorId,
    inputText,
    originalUrl,
    logger,
    maxCandidates: Math.max(12, total * 3),
  });

  // P0-B: Hard gate — empty pool
  if (!poolResult.candidates || poolResult.candidates.length === 0) {
    const resolvedOriginalEmpty = resolveOriginalForPayload(originalObj, originalUrl, inputText);
    const poolMeta = normalizeCandidatePoolMeta(poolResult && poolResult.meta);
    return {
      ok: true,
      payload: {
        kb_key: kbKey,
        original: resolvedOriginalEmpty.original,
        anchor_resolution_status: resolvedOriginalEmpty.anchor_resolution_status,
        dupes: [],
        comparables: [],
        verified: false,
        source: 'empty_pool',
        empty_state_reason: 'candidate_pool_empty',
        quality: {
          validated_schema: true,
          verified_anchor: resolvedOriginalEmpty.anchor_resolution_status === 'confirmed',
          verified_prices: false,
          quality_ok: false,
          quality_issues: ['candidate_pool_empty'],
        },
        qualityAssessment: {
          validated_schema: true,
          verified_anchor: resolvedOriginalEmpty.anchor_resolution_status === 'confirmed',
          verified_prices: false,
          quality_ok: false,
          quality_issues: ['candidate_pool_empty'],
        },
        candidate_pool_meta: poolMeta,
        action_hint: ctx.lang === 'CN'
          ? '未找到匹配候选，请提供产品链接或更完整的名称'
          : 'No matching candidates found. Please provide a product link or more complete name.',
        meta: {
          served_from_kb: false,
          validated_now: true,
          quality_gate_enforced: true,
          quality_gate_reason: 'candidate_pool_empty',
          candidate_pool_meta: poolMeta,
        },
      },
      event_kind: 'empty_state',
      event_reason: 'candidate_pool_empty',
    };
  }

  // 4) Fetch alternatives from LLM
  const _llmAltsStart = Date.now();
  const upstreamOut = await fetchRecoAlternativesForProduct({
    ctx,
    profileSummary: null,
    recentLogs: [],
    productInput: inputText,
    productObj: originalObj,
    anchorId,
    maxTotal: total,
    candidatePool: poolResult.candidates,
    debug: false,
    logger,
  });

  const mapped = Array.isArray(upstreamOut.alternatives) ? upstreamOut.alternatives : [];
  const kindOf = (it) => String(it && typeof it === 'object' ? it.kind : '').trim().toLowerCase();
  const dupes = mapped.filter((it) => kindOf(it) === 'dupe').slice(0, maxDupes);
  const comparables = mapped.filter((it) => kindOf(it) !== 'dupe').slice(0, maxComparables);

  const hasResults = dupes.length > 0 || comparables.length > 0;
  const hasMeaningfulQuality = mapped.some(
    (it) => it && typeof it === 'object' && (Number(it.similarity) > 0 || (Array.isArray(it.tradeoffs) && it.tradeoffs.length > 0)),
  );
  const verified = hasResults && hasMeaningfulQuality;

  // LLM trace
  const _maxConf = mapped.reduce((mx, it) => {
    const c = it && typeof it === 'object' ? Number(it.confidence) : 0;
    return Number.isFinite(c) && c > mx ? c : mx;
  }, 0);
  logger?.info({
    event: 'llm_call_trace',
    task_mode: 'dupe_suggest',
    step: 'alternatives',
    template_id: 'reco_alternatives_v1_0',
    has_candidates: poolResult.candidates.length > 0,
    candidate_count: poolResult.candidates.length,
    has_anchor: Boolean(anchorId),
    duration_ms: Date.now() - _llmAltsStart,
    output_item_count: mapped.length,
    output_dupe_count: dupes.length,
    output_comparable_count: comparables.length,
    output_max_confidence: _maxConf,
    has_meaningful_quality: hasMeaningfulQuality,
    source_mode: upstreamOut.source_mode || null,
    fallback_source: upstreamOut.fallback_source || null,
  }, 'aurora bff: dupe_suggest alternatives llm trace');

  // 5) KB backfill
  if (kbKey) {
    const kbWritePayload = {
      kb_key: kbKey,
      original: resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
      dupes,
      comparables,
      verified,
      verified_at: verified ? new Date().toISOString() : null,
      verified_by: verified ? 'aurora_llm' : null,
      source: verified ? 'llm_generate' : 'llm_generate_empty',
      source_meta: {
        generated_at: new Date().toISOString(),
        max_dupes: maxDupes,
        max_comparables: maxComparables,
      },
    };
    if (DUPE_KB_ASYNC_BACKFILL_ENABLED) {
      upsertDupeKbEntry(kbWritePayload).catch((err) => {
        logger?.warn(
          { err: err?.message || String(err), kb_key: kbKey },
          'aurora bff: async dupe kb backfill failed',
        );
      });
    } else {
      await upsertDupeKbEntry(kbWritePayload);
    }
  }

  // 6) Assemble payload + quality gate
  const resolvedOriginalFinal = resolveOriginalForPayload(originalObj, originalUrl, inputText);
  const candidatePoolMeta = normalizeCandidatePoolMeta(poolResult && poolResult.meta);
  const qualityAssessmentFinal = buildDupeSuggestQualityAssessment({
    resolvedOriginal: resolvedOriginalFinal,
    dupes,
    comparables,
    verified,
    hasMeaningfulQuality,
    candidatePoolMeta,
  });

  const payload = {
    kb_key: kbKey,
    original: resolvedOriginalFinal.original,
    anchor_resolution_status: resolvedOriginalFinal.anchor_resolution_status,
    dupes,
    comparables,
    verified,
    verified_at: verified ? new Date().toISOString() : null,
    source: verified ? 'llm_generate' : 'llm_generate_empty',
    quality: qualityAssessmentFinal,
    qualityAssessment: qualityAssessmentFinal,
    candidate_pool_meta: candidatePoolMeta,
    meta: {
      served_from_kb: false,
      validated_now: true,
      force_refresh: forceRefresh,
      force_validate: forceValidate,
      kb_backfill_mode: DUPE_KB_ASYNC_BACKFILL_ENABLED ? 'async' : 'sync',
      candidate_pool_meta: candidatePoolMeta,
      llm_trace: {
        task_mode: 'dupe_suggest',
        template_id: 'reco_alternatives_v1_0',
        candidate_count: poolResult.candidates.length,
        has_anchor: Boolean(anchorId),
        output_item_count: mapped.length,
        output_max_confidence: _maxConf,
        quality_flags: qualityAssessmentFinal.quality_issues,
      },
    },
    ...(Array.isArray(upstreamOut.field_missing) && upstreamOut.field_missing.length ? { field_missing: upstreamOut.field_missing } : {}),
  };

  // P0-C: Hard quality gate
  const qualityGateResult = applyDupeSuggestQualityGate(payload, { lang: ctx.lang });
  const finalPayload = qualityGateResult.gated ? qualityGateResult.payload : payload;
  if (qualityGateResult.gated) {
    logger?.info(
      { event: 'dupe_suggest_quality_gate', request_id: ctx.request_id, reason: qualityGateResult.reason },
      'aurora bff: dupe_suggest quality gate enforced',
    );
  }

  return {
    ok: true,
    payload: finalPayload,
    event_kind: qualityGateResult.gated ? 'empty_state' : 'value_moment',
    event_source: 'llm',
    quality_gated: qualityGateResult.gated,
    field_missing: Array.isArray(upstreamOut.field_missing) ? upstreamOut.field_missing : [],
  };
}

module.exports = { executeDupeSuggest };
