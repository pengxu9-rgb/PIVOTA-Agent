function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora product intel routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora product intel routes missing schema: ${name}`);
}

function mountProductIntelRoutes(app, deps = {}) {
  const annotateProductIntelRelaxedProvenance = ensureFunction('annotateProductIntelRelaxedProvenance', deps.annotateProductIntelRelaxedProvenance);
  const appendProductIntelSourceChain = ensureFunction('appendProductIntelSourceChain', deps.appendProductIntelSourceChain);
  const applyProductAnalysisGapContract = ensureFunction('applyProductAnalysisGapContract', deps.applyProductAnalysisGapContract);
  const applyProductAnalysisSocialProvenance = ensureFunction('applyProductAnalysisSocialProvenance', deps.applyProductAnalysisSocialProvenance);
  const applyUnknownVerdictQualityGateToEnvelope = ensureFunction('applyUnknownVerdictQualityGateToEnvelope', deps.applyUnknownVerdictQualityGateToEnvelope);
  const attachProductIntelLlmRouteProvenance = ensureFunction('attachProductIntelLlmRouteProvenance', deps.attachProductIntelLlmRouteProvenance);
  const augmentEnvelopeProductAnalysisCardsForDogfood = ensureFunction('augmentEnvelopeProductAnalysisCardsForDogfood', deps.augmentEnvelopeProductAnalysisCardsForDogfood);
  const augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions = ensureFunction('augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions', deps.augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions);
  const auroraChat = ensureFunction('auroraChat', deps.auroraChat);
  const buildContextPrefix = ensureFunction('buildContextPrefix', deps.buildContextPrefix);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const buildHeuristicProductFromInput = ensureFunction('buildHeuristicProductFromInput', deps.buildHeuristicProductFromInput);
  const buildInciStatus = ensureFunction('buildInciStatus', deps.buildInciStatus);
  const buildIngredientConsensus = ensureFunction('buildIngredientConsensus', deps.buildIngredientConsensus);
  const buildProductAnalysisFromUrlIngredients = ensureFunction('buildProductAnalysisFromUrlIngredients', deps.buildProductAnalysisFromUrlIngredients);
  const buildProductDeepScanPrompt = ensureFunction('buildProductDeepScanPrompt', deps.buildProductDeepScanPrompt);
  const buildProductInputText = ensureFunction('buildProductInputText', deps.buildProductInputText);
  const buildProductIntelKbKey = ensureFunction('buildProductIntelKbKey', deps.buildProductIntelKbKey);
  const buildProductIntelKbReadCandidates = ensureFunction('buildProductIntelKbReadCandidates', deps.buildProductIntelKbReadCandidates);
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const canonicalizeIngredientCandidates = ensureFunction('canonicalizeIngredientCandidates', deps.canonicalizeIngredientCandidates);
  const classifyProductType = ensureFunction('classifyProductType', deps.classifyProductType);
  const collectNarrativeRetryCodes = ensureFunction('collectNarrativeRetryCodes', deps.collectNarrativeRetryCodes);
  const collectProductGuardrailFlags = ensureFunction('collectProductGuardrailFlags', deps.collectProductGuardrailFlags);
  const enrichProductAnalysisPayload = ensureFunction('enrichProductAnalysisPayload', deps.enrichProductAnalysisPayload);
  const evaluateAnchorTrustForProductIntel = ensureFunction('evaluateAnchorTrustForProductIntel', deps.evaluateAnchorTrustForProductIntel);
  const extractJsonObjectByKeys = ensureFunction('extractJsonObjectByKeys', deps.extractJsonObjectByKeys);
  const finalizeProductAnalysisRecoContract = ensureFunction('finalizeProductAnalysisRecoContract', deps.finalizeProductAnalysisRecoContract);
  const getProductAnalysisInternalMissingCodes = ensureFunction('getProductAnalysisInternalMissingCodes', deps.getProductAnalysisInternalMissingCodes);
  const getProductIntelKbEntry = ensureFunction('getProductIntelKbEntry', deps.getProductIntelKbEntry);
  const getProfileForIdentity = ensureFunction('getProfileForIdentity', deps.getProfileForIdentity);
  const getRecentSkinLogsForIdentity = ensureFunction('getRecentSkinLogsForIdentity', deps.getRecentSkinLogsForIdentity);
  const getRecoDogfoodSessionId = ensureFunction('getRecoDogfoodSessionId', deps.getRecoDogfoodSessionId);
  const getUpstreamStructuredOrJson = ensureFunction('getUpstreamStructuredOrJson', deps.getUpstreamStructuredOrJson);
  const hasLowCoverageCompetitorsInPayload = ensureFunction('hasLowCoverageCompetitorsInPayload', deps.hasLowCoverageCompetitorsInPayload);
  const hasValidNarrativeQuality = ensureFunction('hasValidNarrativeQuality', deps.hasValidNarrativeQuality);
  const isPlainObject = ensureFunction('isPlainObject', deps.isPlainObject);
  const isProductIntelPayloadCandidateBetter = ensureFunction('isProductIntelPayloadCandidateBetter', deps.isProductIntelPayloadCandidateBetter);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const mapAuroraProductParse = ensureFunction('mapAuroraProductParse', deps.mapAuroraProductParse);
  const mapCatalogParseMissingReason = ensureFunction('mapCatalogParseMissingReason', deps.mapCatalogParseMissingReason);
  const mapCatalogProductToAnchorProduct = ensureFunction('mapCatalogProductToAnchorProduct', deps.mapCatalogProductToAnchorProduct);
  const maybeSyncRepairLowCoverageCompetitors = ensureFunction('maybeSyncRepairLowCoverageCompetitors', deps.maybeSyncRepairLowCoverageCompetitors);
  const mergeFieldMissing = ensureFunction('mergeFieldMissing', deps.mergeFieldMissing);
  const normalizeProductAnalysis = ensureFunction('normalizeProductAnalysis', deps.normalizeProductAnalysis);
  const normalizeProductAnalysisFromUpstream = ensureFunction('normalizeProductAnalysisFromUpstream', deps.normalizeProductAnalysisFromUpstream);
  const normalizeProductParse = ensureFunction('normalizeProductParse', deps.normalizeProductParse);
  const pickFirstTrimmed = ensureFunction('pickFirstTrimmed', deps.pickFirstTrimmed);
  const reconcileProductAnalysisConsistency = ensureFunction('reconcileProductAnalysisConsistency', deps.reconcileProductAnalysisConsistency);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const resolveCatalogProductForProductInput = ensureFunction('resolveCatalogProductForProductInput', deps.resolveCatalogProductForProductInput);
  const resolveIdentity = ensureFunction('resolveIdentity', deps.resolveIdentity);
  const resolveNextStateFromSessionPatch = ensureFunction('resolveNextStateFromSessionPatch', deps.resolveNextStateFromSessionPatch);
  const resolvePrimaryAnalyzeAnchorForProductInput = ensureFunction('resolvePrimaryAnalyzeAnchorForProductInput', deps.resolvePrimaryAnalyzeAnchorForProductInput);
  const resolveProductAnalysisConfidenceBand = ensureFunction('resolveProductAnalysisConfidenceBand', deps.resolveProductAnalysisConfidenceBand);
  const resolveProductAnalysisQualityBand = ensureFunction('resolveProductAnalysisQualityBand', deps.resolveProductAnalysisQualityBand);
  const resolveProductAnalysisSocialState = ensureFunction('resolveProductAnalysisSocialState', deps.resolveProductAnalysisSocialState);
  const resolveProductIntelEscalationRoute = ensureFunction('resolveProductIntelEscalationRoute', deps.resolveProductIntelEscalationRoute);
  const resolveProductIntelLlmRoute = ensureFunction('resolveProductIntelLlmRoute', deps.resolveProductIntelLlmRoute);
  const sanitizeCompetitorsInPayload = ensureFunction('sanitizeCompetitorsInPayload', deps.sanitizeCompetitorsInPayload);
  const scheduleProductIntelCompetitorEnrichBackfill = ensureFunction('scheduleProductIntelCompetitorEnrichBackfill', deps.scheduleProductIntelCompetitorEnrichBackfill);
  const scheduleProductIntelKbBackfill = ensureFunction('scheduleProductIntelKbBackfill', deps.scheduleProductIntelKbBackfill);
  const shouldRefreshCompetitorSnapshot = ensureFunction('shouldRefreshCompetitorSnapshot', deps.shouldRefreshCompetitorSnapshot);
  const shouldRepairCompetitorCoverage = ensureFunction('shouldRepairCompetitorCoverage', deps.shouldRepairCompetitorCoverage);
  const shouldRetryForNarrativeQuality = ensureFunction('shouldRetryForNarrativeQuality', deps.shouldRetryForNarrativeQuality);
  const shouldServeProductIntelKbEntry = ensureFunction('shouldServeProductIntelKbEntry', deps.shouldServeProductIntelKbEntry);
  const shouldServeProductIntelKbPayload = ensureFunction('shouldServeProductIntelKbPayload', deps.shouldServeProductIntelKbPayload);
  const shouldTriggerProductIntelEscalation = ensureFunction('shouldTriggerProductIntelEscalation', deps.shouldTriggerProductIntelEscalation);
  const summarizeProfileForContext = ensureFunction('summarizeProfileForContext', deps.summarizeProfileForContext);
  const uniqCaseInsensitiveStrings = ensureFunction('uniqCaseInsensitiveStrings', deps.uniqCaseInsensitiveStrings);
  const ProductAnalyzeRequestSchema = ensureSchema('ProductAnalyzeRequestSchema', deps.ProductAnalyzeRequestSchema);
  const ProductParseRequestSchema = ensureSchema('ProductParseRequestSchema', deps.ProductParseRequestSchema);
  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const AURORA_BFF_RECO_BLOCKS_BUDGET_MS = deps.AURORA_BFF_RECO_BLOCKS_BUDGET_MS;
  const AURORA_BFF_RECO_BLOCKS_TIMEOUT_CATALOG_ANN_MS = deps.AURORA_BFF_RECO_BLOCKS_TIMEOUT_CATALOG_ANN_MS;
  const AURORA_CHAT_UPSTREAM_TIMEOUT_MS = deps.AURORA_CHAT_UPSTREAM_TIMEOUT_MS;
  const AURORA_DECISION_BASE_URL = deps.AURORA_DECISION_BASE_URL;
  const AURORA_KB_SERVE_POLICY = deps.AURORA_KB_SERVE_POLICY;
  const AURORA_KB_WRITE_POLICY = deps.AURORA_KB_WRITE_POLICY;
  const AURORA_PRODUCT_STRICT_SKINCARE_FILTER = deps.AURORA_PRODUCT_STRICT_SKINCARE_FILTER;
  const AURORA_RULE_RELAX_AGGRESSIVE = deps.AURORA_RULE_RELAX_AGGRESSIVE;
  const AURORA_RULE_RELAX_MODE = deps.AURORA_RULE_RELAX_MODE;
  const CATALOG_AVAIL_SEARCH_TIMEOUT_MS = deps.CATALOG_AVAIL_SEARCH_TIMEOUT_MS;
  const PRODUCT_INTEL_CATALOG_FALLBACK_ENABLED = deps.PRODUCT_INTEL_CATALOG_FALLBACK_ENABLED;
  const PRODUCT_PARSE_ANSWER_JSON_KEYS = deps.PRODUCT_PARSE_ANSWER_JSON_KEYS;
  const PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED = deps.PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED;
  const PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES = deps.PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES;
  const PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT = deps.PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT;
  const PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_MAX_QUERIES = deps.PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_MAX_QUERIES;
  const PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS = deps.PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS;
  const PRODUCT_URL_REALTIME_COMPETITOR_TIMEOUT_MS = deps.PRODUCT_URL_REALTIME_COMPETITOR_TIMEOUT_MS;
  const skin_fit_heavy_async = deps.skin_fit_heavy_async;
  const social_enrich_async = deps.social_enrich_async;

    app.post('/v1/product/parse', async (req, res) => {
      const ctx = buildRequestContext(req, {});
      try {
        requireAuroraUid(ctx);
        const parsed = ProductParseRequestSchema.safeParse(req.body || {});
        if (!parsed.success) {
          const envelope = buildEnvelope(ctx, {
            assistant_message: makeAssistantMessage('Invalid request.'),
            suggested_chips: [],
            cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
            session_patch: {},
            events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
          });
          return res.status(400).json(envelope);
        }
        const productIntelLlmRoute = resolveProductIntelLlmRoute({
          req,
          requestedProvider: parsed.data.llm_provider,
          requestedModel: parsed.data.llm_model,
        });
        let llmRouteMeta = {
          stage: 'stage_1',
          provider: productIntelLlmRoute.llm_provider || null,
          model: productIntelLlmRoute.llm_model || null,
          trigger_reason: 'primary',
        };
  
        const input = parsed.data.url || parsed.data.text;
        const query = `Task: Parse the user's product input into a normalized product entity.\n` +
          `Return ONLY a JSON object with keys: product (object), confidence (0..1), missing_info (string[]).\n` +
          `Input: ${input}`;
        const recoveryPath = [];
        let parseSource = 'none';
  
        let upstream = null;
        try {
          upstream = await auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query,
            timeoutMs: AURORA_CHAT_UPSTREAM_TIMEOUT_MS,
            ...(productIntelLlmRoute.llm_provider ? { llm_provider: productIntelLlmRoute.llm_provider } : {}),
            ...(productIntelLlmRoute.llm_model ? { llm_model: productIntelLlmRoute.llm_model } : {}),
          });
        } catch (err) {
          // ignore; fall back below
        }
  
        const upstreamStructured =
          upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
            ? upstream.structured
            : null;
        const structured = getUpstreamStructuredOrJson(upstream, { answerRequiredKeys: PRODUCT_PARSE_ANSWER_JSON_KEYS });
        if (upstreamStructured) {
          parseSource = 'upstream_structured';
          recoveryPath.push('upstream_structured');
        } else if (structured) {
          parseSource = 'answer_json';
          recoveryPath.push('upstream_structured_miss', 'answer_json');
        } else {
          recoveryPath.push('upstream_structured_miss', 'answer_json_miss');
        }
        const mapped =
          structured && typeof structured === 'object' && !Array.isArray(structured)
            ? mapAuroraProductParse(structured)
            : structured;
        const norm = normalizeProductParse(mapped);
        let payload = norm.payload;
        let fieldMissing = Array.isArray(norm.field_missing) ? norm.field_missing.slice() : [];
        const parseInputText = String(parsed.data.text || input || '').trim();
        const parseInputUrl = String(parsed.data.url || '').trim();
        let parseAnchorTrust = {
          trusted_anchor: null,
          display_anchor: null,
          usable_for_anchor_id: false,
          trust_level: 'none',
          reason_codes: [],
          source: 'none',
          candidate_quality: 'none',
          url_consistency: null,
        };
        const applyParseAnchorTrust = ({ source = 'parse_candidate' } = {}) => {
          const candidate = payload && payload.product && typeof payload.product === 'object' ? payload.product : null;
          parseAnchorTrust = evaluateAnchorTrustForProductIntel({
            candidate,
            inputText: parseInputText,
            inputUrl: parseInputUrl,
            source,
            strictFilter: AURORA_PRODUCT_STRICT_SKINCARE_FILTER,
          });
          const trustCodes = Array.isArray(parseAnchorTrust.reason_codes) ? parseAnchorTrust.reason_codes : [];
          const nonSkincareSoftBlocked = !AURORA_RULE_RELAX_AGGRESSIVE && trustCodes.includes('anchor_soft_blocked_non_skincare');
          const existingMissing = Array.isArray(payload.missing_info) ? payload.missing_info : [];
          payload = {
            ...payload,
            product: nonSkincareSoftBlocked ? null : parseAnchorTrust.display_anchor || null,
            missing_info: uniqCaseInsensitiveStrings(
              [
                ...existingMissing,
                ...trustCodes,
                ...((!nonSkincareSoftBlocked && parseAnchorTrust.display_anchor) && !parseAnchorTrust.usable_for_anchor_id
                  ? ['anchor_id_not_used_due_to_low_trust']
                  : []),
              ],
              16,
            ),
            anchor_trust: {
              level: parseAnchorTrust.trust_level || 'none',
              usable_for_anchor_id: parseAnchorTrust.usable_for_anchor_id === true,
              reasons: trustCodes.slice(0, 6),
            },
            anchor_resolution: {
              source: String(source || 'unknown'),
              candidate_quality: String(parseAnchorTrust.candidate_quality || 'none'),
              ...(Number.isFinite(Number(parseAnchorTrust.url_consistency))
                ? { url_consistency: Number(parseAnchorTrust.url_consistency) }
                : {}),
            },
          };
          if (!AURORA_RULE_RELAX_AGGRESSIVE && trustCodes.includes('anchor_soft_blocked_non_skincare')) {
            fieldMissing = fieldMissing.filter((item) => String(item && item.field ? item.field : '').trim() !== 'product');
            fieldMissing.push({ field: 'product', reason: 'non_skincare_filtered_anchor_soft_blocked_non_skincare' });
            recoveryPath.push(`${source}_anchor_soft_blocked_non_skincare`);
          } else if (trustCodes.length) {
            recoveryPath.push(`${source}_anchor_soft_blocked`);
          }
        };
        applyParseAnchorTrust({ source: 'upstream_parse' });
        if (!payload.product && input) {
          const heuristicProduct = buildHeuristicProductFromInput({
            inputText: parsed.data.text || input,
            inputUrl: parsed.data.url || null,
          });
          recoveryPath.push(heuristicProduct ? 'heuristic_url' : 'heuristic_url_miss');
          if (heuristicProduct) {
            const existingMissing = Array.isArray(payload.missing_info) ? payload.missing_info : [];
            payload = {
              ...payload,
              product: heuristicProduct,
              confidence:
                Number.isFinite(Number(payload.confidence)) && Number(payload.confidence) > 0
                  ? Number(payload.confidence)
                  : 0.32,
              missing_info: Array.from(new Set([...existingMissing, 'heuristic_url_parse'])),
            };
            parseSource = 'heuristic_url';
            fieldMissing = fieldMissing.filter((item) => String(item && item.field ? item.field : '').trim() !== 'product');
            fieldMissing.push({ field: 'parse.fallback', reason: 'heuristic_url' });
            applyParseAnchorTrust({ source: 'heuristic_url' });
          }
        }
  
        // URL-first semantics: if we already have a display anchor from URL but trust is soft-blocked,
        // avoid forcing catalog fallback to manufacture an ID (prevents category drift).
        const parseInputIsUrl = /^https?:\/\//i.test(parseInputUrl);
        const parseHasSoftBlockedAnchor =
          String(parseAnchorTrust.trust_level || '').trim().toLowerCase() === 'soft_blocked' &&
          Array.isArray(parseAnchorTrust.reason_codes) &&
          parseAnchorTrust.reason_codes.length > 0;
        const shouldTryCatalogFallback =
          (!payload.product && !(parseInputIsUrl && parseHasSoftBlockedAnchor)) ||
          (
            parseAnchorTrust.display_anchor &&
            !parseAnchorTrust.usable_for_anchor_id &&
            !parseInputIsUrl
          ) ||
          (
            payload.product &&
            parseAnchorTrust.usable_for_anchor_id &&
            !pickFirstTrimmed(payload?.product?.product_id, payload?.product?.sku_id)
          );
        if (shouldTryCatalogFallback && input) {
          const catalogFallback = await resolveCatalogProductForProductInput({
            inputText: input,
            inputUrl: parsed.data.url || null,
            parsedProduct: null,
            lang: ctx.lang,
            logger,
          });
          const fallbackReasonCode = mapCatalogParseMissingReason(catalogFallback && catalogFallback.reason);
          const catalogRecoveryToken = (() => {
            const reasonToken = String(catalogFallback?.reason || 'fallback_miss').toLowerCase();
            if (!reasonToken) return 'catalog_fallback_miss';
            return reasonToken.startsWith('catalog_') ? reasonToken : `catalog_${reasonToken}`;
          })();
          if (catalogFallback.ok && catalogFallback.product) {
            const fallbackAnchor = mapCatalogProductToAnchorProduct(catalogFallback.product, { fallbackName: String(input || '') });
            if (fallbackAnchor) {
              const existingMissing = Array.isArray(payload.missing_info) ? payload.missing_info : [];
              payload = {
                ...payload,
                product: fallbackAnchor,
                confidence:
                  Number.isFinite(Number(payload.confidence)) && Number(payload.confidence) > 0
                    ? Number(payload.confidence)
                    : 0.55,
                missing_info: Array.from(new Set([...existingMissing, 'catalog_fallback_used'])),
              };
              fieldMissing = fieldMissing.filter((item) => String(item && item.field ? item.field : '').trim() !== 'product');
              parseSource = catalogFallback.source === 'search' ? 'catalog_search' : 'catalog_resolve';
              recoveryPath.push(parseSource);
              fieldMissing.push({ field: 'parse.fallback', reason: `catalog_${catalogFallback.source || 'resolve'}` });
              applyParseAnchorTrust({ source: parseSource });
            } else if (fallbackReasonCode) {
              recoveryPath.push(catalogRecoveryToken);
              fieldMissing.push({ field: 'parse.fallback', reason: fallbackReasonCode });
            }
          } else {
            recoveryPath.push(catalogRecoveryToken);
            if (fallbackReasonCode) fieldMissing.push({ field: 'parse.fallback', reason: fallbackReasonCode });
            const existingMissing = Array.isArray(payload.missing_info) ? payload.missing_info : [];
            payload = {
              ...payload,
              missing_info: Array.from(
                new Set([
                  ...existingMissing,
                  fallbackReasonCode || null,
                  fallbackReasonCode === 'catalog_backend_not_configured' ? 'pivota_backend_not_configured' : null,
                ].filter(Boolean)),
              ),
            };
          }
        }
        if (!payload?.anchor_trust) {
          applyParseAnchorTrust({ source: parseSource || 'parse_candidate' });
        }
        if (!payload.product) {
          const existingMissing = Array.isArray(payload.missing_info) ? payload.missing_info : [];
          payload = {
            ...payload,
            missing_info: Array.from(new Set(['upstream_missing_or_unstructured', ...existingMissing])),
          };
          parseSource = 'none';
        }
        payload = {
          ...payload,
          parse_source: parseSource,
          recovery_path: Array.from(new Set(recoveryPath.filter(Boolean))).slice(0, 12),
        };
        const parseReasonCounts = (() => {
          const counts = {};
          for (const code of Array.isArray(payload?.missing_info) ? payload.missing_info : []) {
            const key = String(code || '').trim().toLowerCase();
            if (!key) continue;
            counts[key] = Number(counts[key] || 0) + 1;
          }
          return counts;
        })();
        logger?.info?.(
          {
            event: 'aurora_product_parse_diagnostics',
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            parse_source: parseSource,
            attempted_sources: Array.isArray(payload?.recovery_path) ? payload.recovery_path : [],
            reason_counts: parseReasonCounts,
            budget_profile: {
              upstream_timeout_ms: AURORA_CHAT_UPSTREAM_TIMEOUT_MS,
              catalog_search_timeout_ms: CATALOG_AVAIL_SEARCH_TIMEOUT_MS,
              catalog_fallback_enabled: PRODUCT_INTEL_CATALOG_FALLBACK_ENABLED,
            },
          },
          'aurora bff: product parse diagnostics',
        );
  
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `parse_${ctx.request_id}`,
              type: 'product_parse',
              payload,
              ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
            },
          ],
          session_patch: {
            meta: {
              retrieval_path_version: 'aurora_retrieval_v2',
            },
          },
          events: [makeEvent(ctx, 'value_moment', { kind: 'product_parse' })],
        });
        return res.json(envelope);
      } catch (err) {
        const status = err.status || 500;
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to parse product.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_PARSE_FAILED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_PARSE_FAILED' })],
        });
        return res.status(status).json(envelope);
      }
    });
  
    app.post('/v1/product/analyze', async (req, res) => {
      const ctx = buildRequestContext(req, {});
      const productAnalyzeSessionId = getRecoDogfoodSessionId(
        req,
        ctx,
        pickFirstTrimmed(
          req?.body?.session?.session_id,
          req?.body?.session?.sessionId,
          req?.body?.session?.id,
        ),
      );
      const sendProductAnalyzeEnvelope = async (envelope, statusCode = 200, mode = 'main_path') => {
        const qualityGated = applyUnknownVerdictQualityGateToEnvelope(envelope, {
          lang: ctx.lang,
        });
        let augmented = augmentEnvelopeProductAnalysisCardsForDogfood({
          envelope: qualityGated,
          req,
          ctx,
          mode,
          sessionId: productAnalyzeSessionId,
          logger,
        });
        augmented = await augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions({
          envelope: augmented,
          logger,
        });
        const sessionPatchBase =
          augmented && augmented.session_patch && typeof augmented.session_patch === 'object' && !Array.isArray(augmented.session_patch)
            ? augmented.session_patch
            : {};
        const sessionPatchMeta =
          sessionPatchBase.meta && typeof sessionPatchBase.meta === 'object' && !Array.isArray(sessionPatchBase.meta)
            ? sessionPatchBase.meta
            : {};
        augmented = {
          ...augmented,
          session_patch: {
            ...sessionPatchBase,
            meta: {
              ...sessionPatchMeta,
              retrieval_path_version: 'aurora_retrieval_v2',
            },
          },
        };
        try {
          const productCard = Array.isArray(augmented?.cards)
            ? augmented.cards.find((card) => card && card.type === 'product_analysis')
            : null;
          const payload =
            productCard && productCard.payload && typeof productCard.payload === 'object' && !Array.isArray(productCard.payload)
              ? productCard.payload
              : null;
          if (payload) {
            const reasonCounts = {};
            for (const code of Array.isArray(payload.missing_info) ? payload.missing_info : []) {
              const key = String(code || '').trim().toLowerCase();
              if (!key) continue;
              reasonCounts[key] = Number(reasonCounts[key] || 0) + 1;
            }
            const retrievalDegradation =
              payload.provenance &&
              typeof payload.provenance === 'object' &&
              !Array.isArray(payload.provenance) &&
              payload.provenance.retrieval_degradation &&
              typeof payload.provenance.retrieval_degradation === 'object' &&
              !Array.isArray(payload.provenance.retrieval_degradation)
                ? payload.provenance.retrieval_degradation
                : {};
            logger?.info?.(
              {
                event: 'aurora_product_analyze_diagnostics',
                request_id: ctx.request_id,
                trace_id: ctx.trace_id,
                mode,
                attempted_sources: Array.isArray(retrievalDegradation.attempted_sources)
                  ? retrievalDegradation.attempted_sources
                  : [],
                reason_counts: reasonCounts,
                budget_profile:
                  retrievalDegradation.budget_profile &&
                  typeof retrievalDegradation.budget_profile === 'object' &&
                  !Array.isArray(retrievalDegradation.budget_profile)
                    ? retrievalDegradation.budget_profile
                    : {
                      reco_blocks_budget_ms: AURORA_BFF_RECO_BLOCKS_BUDGET_MS,
                      reco_catalog_timeout_ms: AURORA_BFF_RECO_BLOCKS_TIMEOUT_CATALOG_ANN_MS,
                      product_url_competitor_timeout_ms: PRODUCT_URL_REALTIME_COMPETITOR_TIMEOUT_MS,
                    },
                degraded: retrievalDegradation.degraded === true,
                resolver_first_applied: retrievalDegradation.resolver_first_applied === true,
              },
              'aurora bff: product analyze diagnostics',
            );
          }
        } catch (_) {
          // ignore diagnostics logging failures
        }
        if (statusCode >= 400) return res.status(statusCode).json(augmented);
        return res.json(augmented);
      };
      try {
        requireAuroraUid(ctx);
        const parsed = ProductAnalyzeRequestSchema.safeParse(req.body || {});
        if (!parsed.success) {
          const envelope = buildEnvelope(ctx, {
            assistant_message: makeAssistantMessage('Invalid request.'),
            suggested_chips: [],
            cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
            session_patch: {},
            events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
          });
          return sendProductAnalyzeEnvelope(envelope, 400, 'main_path');
        }
        const productIntelLlmRoute = resolveProductIntelLlmRoute({
          req,
          requestedProvider: parsed.data.llm_provider,
          requestedModel: parsed.data.llm_model,
        });
        let llmRouteMeta = {
          stage: 'stage_1',
          provider: productIntelLlmRoute.llm_provider || null,
          model: productIntelLlmRoute.llm_model || null,
          trigger_reason: 'primary',
        };
  
        const incomingSession =
          parsed.data.session && typeof parsed.data.session === 'object' && !Array.isArray(parsed.data.session)
            ? parsed.data.session
            : null;
        if (incomingSession) {
          const sessionStateAsObject =
            incomingSession.state && typeof incomingSession.state === 'object' && !Array.isArray(incomingSession.state)
              ? incomingSession.state
              : null;
          const resumedState = resolveNextStateFromSessionPatch({
            next_state:
              typeof incomingSession.state === 'string'
                ? incomingSession.state
                : typeof incomingSession.next_state === 'string'
                  ? incomingSession.next_state
                  : '',
            state: sessionStateAsObject,
          });
          if (resumedState) ctx.state = resumedState;
        }
  
        const identity = await resolveIdentity(req, ctx);
        const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
        const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
        const profileSummary = summarizeProfileForContext(profile);
        const commonMeta = {
          profile: profileSummary,
          recentLogs,
          lang: ctx.lang,
          state: ctx.state || 'idle',
          trigger_source: ctx.trigger_source,
        };
        const parsePrefix = buildContextPrefix({ ...commonMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
        const prefix = buildContextPrefix({ ...commonMeta, intent: 'product_analyze', action_id: 'chip.action.analyze_product' });
  
        const input = parsed.data.url || parsed.data.name || JSON.stringify(parsed.data.product || {});
        const anchorTrustDiagnostics = [];
        const collectAnchorTrust = (trustResult) => {
          if (!trustResult || typeof trustResult !== 'object') return;
          anchorTrustDiagnostics.push({
            source: String(trustResult.source || 'unknown'),
            trust_level: String(trustResult.trust_level || 'none'),
            usable_for_anchor_id: trustResult.usable_for_anchor_id === true,
            reason_codes: Array.isArray(trustResult.reason_codes) ? trustResult.reason_codes : [],
            candidate_quality: String(trustResult.candidate_quality || 'none'),
            ...(Number.isFinite(Number(trustResult.url_consistency))
              ? { url_consistency: Number(trustResult.url_consistency) }
              : {}),
          });
        };
        let parsedProduct = null;
        let anchorId = '';
        let anchorTrustContext = {
          level: 'none',
          usable_for_anchor_id: false,
          reasons: [],
          source: 'none',
          candidate_quality: 'none',
          url_consistency: null,
        };
        const applyAnchorCandidateGuard = (candidate, source, { preferDisplay = false } = {}) => {
          const trust = evaluateAnchorTrustForProductIntel({
            candidate,
            inputText: String(parsed.data.name || input || '').trim(),
            inputUrl: String(parsed.data.url || '').trim(),
            source,
            strictFilter: AURORA_PRODUCT_STRICT_SKINCARE_FILTER,
          });
          collectAnchorTrust(trust);
          const trustCodes = Array.isArray(trust.reason_codes) ? trust.reason_codes : [];
          const nonSkincareSoftBlocked = !AURORA_RULE_RELAX_AGGRESSIVE && trustCodes.includes('anchor_soft_blocked_non_skincare');
          if (trust.display_anchor && !nonSkincareSoftBlocked && (!parsedProduct || preferDisplay || trust.usable_for_anchor_id)) {
            parsedProduct = trust.display_anchor;
          }
          if (trust.usable_for_anchor_id && trust.trusted_anchor) {
            parsedProduct = trust.trusted_anchor;
            anchorId = pickFirstTrimmed(trust.trusted_anchor.sku_id, trust.trusted_anchor.product_id) || anchorId;
          }
          if (trust.trust_level === 'trusted' || (anchorTrustContext.level !== 'trusted' && trust.trust_level !== 'none')) {
            anchorTrustContext = {
              level: trust.trust_level || 'none',
              usable_for_anchor_id: trust.usable_for_anchor_id === true,
              reasons: Array.isArray(trust.reason_codes) ? trust.reason_codes.slice(0, 6) : [],
              source: String(source || 'unknown'),
              candidate_quality: String(trust.candidate_quality || 'none'),
              url_consistency: Number.isFinite(Number(trust.url_consistency)) ? Number(trust.url_consistency) : null,
            };
          }
          return trust;
        };
        applyAnchorCandidateGuard(parsed.data.product || null, 'client_payload', { preferDisplay: true });
        const anchorReasonCodes = uniqCaseInsensitiveStrings(
          anchorTrustDiagnostics.flatMap((item) => {
            const reasonCodes = Array.isArray(item?.reason_codes) ? item.reason_codes : [];
            return reasonCodes.map((reason) => String(reason || '').trim()).filter(Boolean);
          }),
          12,
        );
        const anchorFilterCodes = uniqCaseInsensitiveStrings(
          anchorTrustDiagnostics.flatMap((item) => {
            const reasonCodes = Array.isArray(item?.reason_codes) ? item.reason_codes : [];
            return reasonCodes.map((reason) => `anchor_filtered_${String(item.source || 'unknown').toLowerCase()}_${String(reason || 'unknown').toLowerCase()}`);
          }),
          16,
        );
        const buildAnalyzeAnchorTrustPayload = () => ({
          level: String(anchorTrustContext.level || 'none'),
          usable_for_anchor_id: anchorTrustContext.usable_for_anchor_id === true,
          reasons: uniqCaseInsensitiveStrings(
            [
              ...(Array.isArray(anchorTrustContext.reasons) ? anchorTrustContext.reasons : []),
              ...anchorReasonCodes,
            ],
            8,
          ),
          source: String(anchorTrustContext.source || 'unknown'),
          candidate_quality: String(anchorTrustContext.candidate_quality || 'none'),
          ...(Number.isFinite(Number(anchorTrustContext.url_consistency))
            ? { url_consistency: Number(anchorTrustContext.url_consistency) }
            : {}),
        });
        const applyAnalyzeDiagnosticsToPayload = (rawPayload) => {
          const basePayload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : rawPayload;
          if (!basePayload || typeof basePayload !== 'object' || Array.isArray(basePayload)) return rawPayload;
          const hasDisplayAnchor = Boolean(
            parsedProduct && (
              pickFirstTrimmed(parsedProduct.product_id, parsedProduct.sku_id, parsedProduct.display_name, parsedProduct.name, parsedProduct.url)
            ),
          );
          const missingInfo = uniqCaseInsensitiveStrings(
            [
              ...(Array.isArray(basePayload.missing_info) ? basePayload.missing_info : []),
              ...anchorReasonCodes,
              ...(hasDisplayAnchor && anchorTrustContext.usable_for_anchor_id !== true ? ['anchor_id_not_used_due_to_low_trust'] : []),
              ...(kbQuarantineMeta.hit ? ['kb_entry_quarantined'] : []),
            ],
            24,
          );
          const internalCodes = uniqCaseInsensitiveStrings(
            [
              ...getProductAnalysisInternalMissingCodes(basePayload),
              ...anchorFilterCodes,
              ...(kbQuarantineMeta.hit ? ['kb_entry_quarantined'] : []),
            ],
            32,
          );
          const withGap = applyProductAnalysisGapContract({
            ...basePayload,
            missing_info: missingInfo,
            internal_debug_codes: internalCodes,
          });
          const provenance = withGap && withGap.provenance && typeof withGap.provenance === 'object' && !Array.isArray(withGap.provenance)
            ? withGap.provenance
            : {};
          const withDiag = {
            ...withGap,
            provenance: {
              ...provenance,
              gate_relax_mode: AURORA_RULE_RELAX_MODE,
              kb_write_policy: AURORA_KB_WRITE_POLICY,
              kb_serve_policy: AURORA_KB_SERVE_POLICY,
              quality_band: resolveProductAnalysisQualityBand(withGap),
              confidence_band: resolveProductAnalysisConfidenceBand(withGap),
              guardrail_flags: uniqCaseInsensitiveStrings(
                [
                  ...(Array.isArray(provenance.guardrail_flags) ? provenance.guardrail_flags : []),
                  ...collectProductGuardrailFlags(withGap),
                ],
                20,
              ),
              anchor_trust: buildAnalyzeAnchorTrustPayload(),
              ...(kbQuarantineMeta.hit
                ? {
                  kb_quarantine: {
                    hit: true,
                    reason: String(kbQuarantineMeta.reason || 'quarantined'),
                    reasons: Array.isArray(kbQuarantineMeta.reasons) ? kbQuarantineMeta.reasons.slice(0, 8) : [],
                    refreshed: kbQuarantineMeta.refreshed === true,
                  },
                }
                : {}),
            },
          };
          return annotateProductIntelRelaxedProvenance(withDiag, {
            quarantineReasons: kbQuarantineMeta.hit
              ? (Array.isArray(kbQuarantineMeta.reasons) && kbQuarantineMeta.reasons.length
                ? kbQuarantineMeta.reasons
                : [String(kbQuarantineMeta.reason || 'kb_entry_quarantined')])
              : [],
          });
        };
        let primaryAnchorResolution = null;
        let catalogFallback = null;
        let realtimeUrlNormMeta = null;
        let kbQuarantineMeta = { hit: false, reason: '', reasons: [], refreshed: false };
        const realtimeUrlInput = String(parsed.data.url || '').trim();
        const forceRefresh = parsed.data.force_refresh === true;
        const shouldRunRealtimeUrlFirst = PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED && /^https?:\/\//i.test(realtimeUrlInput);
  
        if (shouldRunRealtimeUrlFirst) {
          const kbAnchorProductHint = anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null;
          const kbKeys = [];
          const primaryKbKeys = buildProductIntelKbReadCandidates({
            productUrl: realtimeUrlInput,
            parsedProduct: kbAnchorProductHint,
            lang: ctx.match_lang || ctx.lang,
          });
          const urlOnlyKbKeys = buildProductIntelKbReadCandidates({
            productUrl: realtimeUrlInput,
            parsedProduct: null,
            lang: ctx.match_lang || ctx.lang,
          });
          for (const key of [...primaryKbKeys, ...urlOnlyKbKeys]) {
            const kbKey = String(key || '').trim();
            if (!kbKey) continue;
            if (kbKeys.includes(kbKey)) continue;
            kbKeys.push(kbKey);
          }
          for (const kbKey of kbKeys) {
            if (forceRefresh) break;
            // eslint-disable-next-line no-await-in-loop
            const kbEntry = await getProductIntelKbEntry(kbKey);
            const kbAnalysis =
              kbEntry && kbEntry.analysis && typeof kbEntry.analysis === 'object' && !Array.isArray(kbEntry.analysis)
                ? kbEntry.analysis
                : null;
            const kbAnalysisSanitized = sanitizeCompetitorsInPayload(kbAnalysis, {
              max: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
            });
            if (!kbAnalysisSanitized) continue;
            const kbServeDecision = shouldServeProductIntelKbEntry({
              kbEntry,
              payload: kbAnalysisSanitized,
              productUrl: realtimeUrlInput,
              anchorTrustContext,
            });
            if (kbServeDecision.quarantined) {
              kbQuarantineMeta = {
                hit: true,
                reason: String(kbServeDecision.reason || 'kb_entry_quarantined'),
                reasons: Array.isArray(kbServeDecision.reasons) ? kbServeDecision.reasons.slice(0, 8) : [],
                refreshed: true,
              };
            }
            if (!kbServeDecision.serve || !shouldServeProductIntelKbPayload(kbAnalysisSanitized)) continue;
            let kbPayload = enrichProductAnalysisPayload(kbAnalysisSanitized, { lang: ctx.lang, profileSummary });
            if (kbPayload && typeof kbPayload === 'object' && !Array.isArray(kbPayload)) {
              const internalCodes = getProductAnalysisInternalMissingCodes(kbPayload);
              const cleanedInternalCodes = uniqCaseInsensitiveStrings(
                internalCodes.filter((raw) => String(raw || '').trim().toLowerCase() !== 'competitor_sync_enrich_used'),
                16,
              );
              if (cleanedInternalCodes.length !== internalCodes.length) {
                kbPayload = applyProductAnalysisGapContract({
                  ...kbPayload,
                  internal_debug_codes: cleanedInternalCodes,
                });
              }
            }
            let syncCoverageRepairApplied = false;
  
            if (
              shouldRepairCompetitorCoverage(kbPayload, { preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT })
            ) {
              // Fast main-path repair for stale low-coverage KB entries: keep latency bounded.
              const syncRepair = await maybeSyncRepairLowCoverageCompetitors({
                productUrl: realtimeUrlInput,
                payload: kbPayload,
                parsedProduct: kbAnchorProductHint,
                profileSummary,
                lang: ctx.lang,
                logger,
              });
              if (syncRepair && syncRepair.enhanced && syncRepair.payload) {
                kbPayload = enrichProductAnalysisPayload(syncRepair.payload, { lang: ctx.lang, profileSummary });
                syncCoverageRepairApplied = true;
              }
            }
  
            const kbAssessment = kbPayload?.assessment && typeof kbPayload.assessment === 'object' ? kbPayload.assessment : null;
            const kbBackfillAnchor =
              kbAssessment && typeof kbAssessment.anchor_product === 'object' && !Array.isArray(kbAssessment.anchor_product)
                ? kbAssessment.anchor_product
                : kbAnchorProductHint;
            if (syncCoverageRepairApplied) {
              scheduleProductIntelKbBackfill({
                productUrl: realtimeUrlInput,
                parsedProduct: kbBackfillAnchor,
                payload: kbPayload,
                lang: ctx.lang,
                source: 'url_realtime_product_intel_kb_sync_enrich',
                sourceMeta: {
                  ...(kbEntry && typeof kbEntry.source_meta === 'object' && !Array.isArray(kbEntry.source_meta) ? kbEntry.source_meta : {}),
                  competitor_sync_enriched: true,
                  competitor_sync_timeout_ms: PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS,
                  competitor_sync_max_queries: PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_MAX_QUERIES,
                },
                logger,
              });
            }
            scheduleProductIntelCompetitorEnrichBackfill({
              productUrl: realtimeUrlInput,
              parsedProduct: kbBackfillAnchor,
              payload: kbPayload,
              lang: ctx.lang,
              profileSummary,
              source: 'url_realtime_product_intel',
              sourceMeta: kbEntry && typeof kbEntry.source_meta === 'object' ? kbEntry.source_meta : null,
              forceEnhance: shouldRepairCompetitorCoverage(kbPayload, {
                preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT,
              }),
              refreshSnapshot: shouldRefreshCompetitorSnapshot(
                kbPayload,
                kbEntry && typeof kbEntry.source_meta === 'object' ? kbEntry.source_meta : null,
              ),
              logger,
            });
            kbPayload = finalizeProductAnalysisRecoContract(kbPayload, {
              logger,
              requestId: ctx.request_id,
              mode: syncCoverageRepairApplied ? 'sync_repair' : 'main_path',
            });
            const kbSocialState = resolveProductAnalysisSocialState(kbPayload);
            kbPayload = applyProductAnalysisSocialProvenance(kbPayload, {
              social_fetch_mode: kbSocialState.fetchMode,
              ...(kbSocialState.socialFreshUntil ? { social_fresh_until: kbSocialState.socialFreshUntil } : {}),
              ...(kbSocialState.socialChannels.length ? { social_channels_used: kbSocialState.socialChannels } : {}),
            });
            kbPayload = appendProductIntelSourceChain(kbPayload, ['llm_extraction']);
            kbPayload = attachProductIntelLlmRouteProvenance(kbPayload, {
              ...llmRouteMeta,
              trigger_reason: 'url_realtime_kb_hit',
            });
            kbPayload = applyAnalyzeDiagnosticsToPayload(kbPayload);
            kbPayload = reconcileProductAnalysisConsistency(kbPayload, { lang: ctx.lang });
            const envelope = buildEnvelope(ctx, {
              assistant_message: null,
              suggested_chips: [],
              cards: [
                {
                  card_id: `analyze_${ctx.request_id}`,
                  type: 'product_analysis',
                  payload: kbPayload,
                },
              ],
              session_patch: {},
              events: [
                makeEvent(ctx, 'value_moment', {
                  kind: 'product_analyze',
                  mode: syncCoverageRepairApplied ? 'url_realtime_product_intel_kb_hit_sync_enriched' : 'url_realtime_product_intel_kb_hit',
                }),
              ],
            });
            if (kbSocialState.shouldRefresh) {
              social_enrich_async({
                logger,
                mode: syncCoverageRepairApplied ? 'sync_repair' : 'main_path',
                product_url: realtimeUrlInput,
                payload: kbPayload,
                lang: ctx.lang,
                profile_summary: profileSummary,
                anchor_product: kbBackfillAnchor,
                kb_key: kbKey,
                source: syncCoverageRepairApplied ? 'url_realtime_product_intel_kb_sync_enrich' : 'url_realtime_product_intel_kb_hit',
                source_meta:
                  kbEntry && typeof kbEntry.source_meta === 'object' && !Array.isArray(kbEntry.source_meta)
                    ? kbEntry.source_meta
                    : null,
              });
            }
            skin_fit_heavy_async({
              logger,
              mode: syncCoverageRepairApplied ? 'sync_repair' : 'main_path',
              product_url: realtimeUrlInput,
            });
            return sendProductAnalyzeEnvelope(
              envelope,
              200,
              syncCoverageRepairApplied ? 'sync_repair' : 'main_path',
            );
          }
  
          const realtimeUrlAnchorForEvidence = anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null;
          const realtimeNorm = await buildProductAnalysisFromUrlIngredients({
            productUrl: realtimeUrlInput,
            lang: ctx.lang,
            profileSummary,
            parsedProduct: realtimeUrlAnchorForEvidence,
            logger,
          });
          if (realtimeNorm && realtimeNorm.payload && realtimeNorm.payload.assessment) {
            realtimeUrlNormMeta = realtimeNorm.source_meta || null;
            let realtimePayload = enrichProductAnalysisPayload(realtimeNorm.payload, { lang: ctx.lang, profileSummary });
            if (realtimePayload && typeof realtimePayload === 'object') {
              const internalCodes = getProductAnalysisInternalMissingCodes(realtimePayload);
              const existingMissingInfo = Array.isArray(realtimePayload.missing_info) ? realtimePayload.missing_info : [];
              realtimePayload = applyProductAnalysisGapContract({
                ...realtimePayload,
                missing_info: Array.from(
                  new Set([
                    ...existingMissingInfo,
                  ]),
                ),
                internal_debug_codes: Array.from(new Set([
                  ...internalCodes,
                  ...anchorFilterCodes,
                  'url_realtime_product_intel_used',
                ])),
              });
            }
            const assessment = realtimePayload?.assessment && typeof realtimePayload.assessment === 'object'
              ? realtimePayload.assessment
              : null;
            if (assessment && !assessment.anchor_product && !assessment.anchorProduct && realtimeUrlAnchorForEvidence) {
              realtimePayload = { ...realtimePayload, assessment: { ...assessment, anchor_product: realtimeUrlAnchorForEvidence } };
            }
  
            const kbBackfillAnchor =
              assessment && typeof assessment.anchor_product === 'object' && !Array.isArray(assessment.anchor_product)
                ? assessment.anchor_product
                : realtimeUrlAnchorForEvidence;
            let realtimeSyncRepairApplied = false;
            if (
              shouldRepairCompetitorCoverage(realtimePayload, {
                preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT,
              })
            ) {
              const syncRepair = await maybeSyncRepairLowCoverageCompetitors({
                productUrl: realtimeUrlInput,
                payload: realtimePayload,
                parsedProduct: kbBackfillAnchor,
                profileSummary,
                lang: ctx.lang,
                logger,
              });
              if (syncRepair && syncRepair.enhanced && syncRepair.payload) {
                realtimePayload = enrichProductAnalysisPayload(syncRepair.payload, { lang: ctx.lang, profileSummary });
                realtimeSyncRepairApplied = true;
                realtimeUrlNormMeta = {
                  ...(realtimeUrlNormMeta && typeof realtimeUrlNormMeta === 'object' && !Array.isArray(realtimeUrlNormMeta)
                    ? realtimeUrlNormMeta
                    : {}),
                  competitor_sync_enriched: true,
                  competitor_sync_timeout_ms: PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS,
                  competitor_sync_max_queries: PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_MAX_QUERIES,
                };
              }
            }
            scheduleProductIntelKbBackfill({
              productUrl: realtimeUrlInput,
              parsedProduct: kbBackfillAnchor,
              payload: realtimePayload,
              lang: ctx.lang,
              source: realtimeSyncRepairApplied ? 'url_realtime_product_intel_sync_enrich' : 'url_realtime_product_intel',
              sourceMeta: realtimeUrlNormMeta,
              logger,
            });
            scheduleProductIntelCompetitorEnrichBackfill({
              productUrl: realtimeUrlInput,
              parsedProduct: kbBackfillAnchor,
              payload: realtimePayload,
              lang: ctx.lang,
              profileSummary,
              source: 'url_realtime_product_intel',
              sourceMeta: realtimeUrlNormMeta,
              forceEnhance: shouldRepairCompetitorCoverage(realtimePayload, {
                preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT,
              }),
              refreshSnapshot: shouldRefreshCompetitorSnapshot(realtimePayload, realtimeUrlNormMeta),
              logger,
            });
            realtimePayload = finalizeProductAnalysisRecoContract(realtimePayload, {
              logger,
              requestId: ctx.request_id,
              mode: realtimeSyncRepairApplied ? 'sync_repair' : 'main_path',
            });
            realtimePayload = applyProductAnalysisSocialProvenance(realtimePayload, {
              social_fetch_mode: 'async_refresh',
            });
            realtimePayload = appendProductIntelSourceChain(realtimePayload, ['llm_extraction']);
            realtimePayload = attachProductIntelLlmRouteProvenance(realtimePayload, {
              ...llmRouteMeta,
              trigger_reason: 'url_realtime_main_path',
            });
            realtimePayload = applyAnalyzeDiagnosticsToPayload(realtimePayload);
            realtimePayload = reconcileProductAnalysisConsistency(realtimePayload, { lang: ctx.lang });
  
            const envelope = buildEnvelope(ctx, {
              assistant_message: null,
              suggested_chips: [],
              cards: [
                {
                  card_id: `analyze_${ctx.request_id}`,
                  type: 'product_analysis',
                  payload: realtimePayload,
                  ...(realtimeNorm.field_missing?.length ? { field_missing: realtimeNorm.field_missing.slice(0, 8) } : {}),
                },
              ],
              session_patch: {},
              events: [
                makeEvent(ctx, 'value_moment', {
                  kind: 'product_analyze',
                  mode: realtimeSyncRepairApplied
                    ? 'url_realtime_product_intel_sync_enriched'
                    : 'url_realtime_product_intel',
                }),
              ],
            });
            social_enrich_async({
              logger,
              mode: realtimeSyncRepairApplied ? 'sync_repair' : 'main_path',
              product_url: realtimeUrlInput,
              payload: realtimePayload,
              lang: ctx.lang,
              profile_summary: profileSummary,
              anchor_product: kbBackfillAnchor,
              kb_key: buildProductIntelKbKey({
                productUrl: realtimeUrlInput,
                parsedProduct: kbBackfillAnchor,
                lang: ctx.lang,
              }),
              source: 'url_realtime_product_intel',
              source_meta: realtimeUrlNormMeta,
            });
            skin_fit_heavy_async({
              logger,
              mode: realtimeSyncRepairApplied ? 'sync_repair' : 'main_path',
              product_url: realtimeUrlInput,
            });
            return sendProductAnalyzeEnvelope(
              envelope,
              200,
              realtimeSyncRepairApplied ? 'sync_repair' : 'main_path',
            );
          }
        }
  
        // If caller only provided a name/url, try to parse into an anchor product first to improve KB hit rate.
        if (!anchorId && input) {
          try {
            const parseQuery = `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
              `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
              `Input: ${input}`;
  
            const parseUpstream = await auroraChat({
              baseUrl: AURORA_DECISION_BASE_URL,
              query: parseQuery,
              timeoutMs: AURORA_CHAT_UPSTREAM_TIMEOUT_MS,
              ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
              ...(productIntelLlmRoute.llm_provider ? { llm_provider: productIntelLlmRoute.llm_provider } : {}),
              ...(productIntelLlmRoute.llm_model ? { llm_model: productIntelLlmRoute.llm_model } : {}),
            });
  
            const parseStructured = (() => {
              if (parseUpstream && parseUpstream.structured && typeof parseUpstream.structured === 'object' && !Array.isArray(parseUpstream.structured)) {
                return parseUpstream.structured;
              }
              const a =
                parseUpstream && typeof parseUpstream.answer === 'string'
                  ? extractJsonObjectByKeys(parseUpstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
                  : null;
              return a;
            })();
            const parseMapped =
              parseStructured && typeof parseStructured === 'object' && !Array.isArray(parseStructured)
                ? mapAuroraProductParse(parseStructured)
                : parseStructured;
            const parseNorm = normalizeProductParse(parseMapped);
            const parseCandidate = parseNorm.payload.product || null;
            applyAnchorCandidateGuard(parseCandidate, 'upstream_parse');
          } catch (err) {
            // ignore; continue without anchor id
          }
        }
  
        // Main-chain anchor resolution: if parse did not yield an ID, try catalog resolve once (fast path).
        if (!anchorId && input) {
          primaryAnchorResolution = await resolvePrimaryAnalyzeAnchorForProductInput({
            inputText: input,
            inputUrl: parsed.data.url || null,
            parsedProduct: anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null,
            lang: ctx.lang,
            logger,
          });
          if (primaryAnchorResolution.ok && primaryAnchorResolution.product) {
            const resolvedAnchor = mapCatalogProductToAnchorProduct(primaryAnchorResolution.product, {
              fallbackName: String(input || ''),
            });
            applyAnchorCandidateGuard(resolvedAnchor, 'catalog_primary_resolve');
          }
        }
  
        // Second-stage fallback: reuse catalog resolve/search when upstream parse cannot provide anchor.
        if (PRODUCT_INTEL_CATALOG_FALLBACK_ENABLED && !anchorId && input) {
          catalogFallback = await resolveCatalogProductForProductInput({
            inputText: input,
            inputUrl: parsed.data.url || null,
            parsedProduct: anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null,
            lang: ctx.lang,
            logger,
          });
          if (catalogFallback.ok && catalogFallback.product) {
            const fallbackAnchor = mapCatalogProductToAnchorProduct(catalogFallback.product, { fallbackName: String(input || '') });
            applyAnchorCandidateGuard(fallbackAnchor, 'catalog_fallback');
          }
        }
  
        const descriptorAnchor = anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null;
        const productDescriptor = buildProductInputText(descriptorAnchor, null) || parsed.data.name || input;
        const collectInciCandidates = (sourceObj) => {
          const src = isPlainObject(sourceObj) ? sourceObj : null;
          if (!src) return [];
          const out = [];
          const pushText = (value) => {
            const text = String(value || '').trim();
            if (!text) return;
            const parts = text.split(/[|,;\n•]+/);
            for (const part of parts) {
              const token = String(part || '').trim();
              if (token) out.push(token);
            }
          };
          const pushArray = (value) => {
            if (!Array.isArray(value)) return;
            for (const item of value) {
              if (typeof item === 'string') {
                pushText(item);
                continue;
              }
              if (item == null) continue;
              if (isPlainObject(item)) {
                pushText(item.name || item.ingredient || item.inci);
                continue;
              }
              pushText(String(item));
            }
          };
          pushText(src.inci);
          pushText(src.ingredients);
          pushText(src.ingredient_list);
          pushText(src.ingredientList);
          pushText(src.inci_list);
          pushText(src.inciList);
          pushText(src.full_ingredients);
          pushText(src.fullIngredients);
          pushArray(src.ingredients);
          pushArray(src.inci_list);
          pushArray(src.inciList);
          pushArray(src.full_ingredients);
          pushArray(src.fullIngredients);
          return canonicalizeIngredientCandidates(out, { max: 180 });
        };
        const collectInciGapCodes = (sourceObj) => {
          const src = isPlainObject(sourceObj) ? sourceObj : null;
          if (!src) return [];
          const out = [];
          const pushList = (value) => {
            for (const item of Array.isArray(value) ? value : []) {
              const code = String(item || '').trim();
              if (code) out.push(code);
            }
          };
          pushList(src.missing_info);
          pushList(src.internal_debug_codes);
          if (isPlainObject(src.evidence)) pushList(src.evidence.missing_info);
          return out;
        };
        const collectInciSources = (sourceObj) => {
          const src = isPlainObject(sourceObj) ? sourceObj : null;
          if (!src) return [];
          const out = [];
          const pushSources = (items) => {
            for (const row of Array.isArray(items) ? items : []) {
              if (!isPlainObject(row)) continue;
              const type = String(row.type || row.source_type || '').trim();
              const url = String(row.url || row.source_url || '').trim();
              if (!type && !url) continue;
              out.push({
                type,
                url,
                confidence: row.confidence,
                ingredient_count: row.ingredient_count,
              });
            }
          };
          pushSources(src.sources);
          if (isPlainObject(src.evidence)) pushSources(src.evidence.sources);
          return out;
        };
        const clientProduct = isPlainObject(parsed.data.product) ? parsed.data.product : null;
        const queryInciList = canonicalizeIngredientCandidates(
          [...collectInciCandidates(clientProduct), ...collectInciCandidates(descriptorAnchor)],
          { max: 220 },
        );
        const queryGapCodes = uniqCaseInsensitiveStrings(
          [...collectInciGapCodes(clientProduct), ...collectInciGapCodes(descriptorAnchor)],
          24,
        );
        const queryEvidenceSources = [...collectInciSources(clientProduct), ...collectInciSources(descriptorAnchor)];
        const queryInciConsensus = queryInciList.length
          ? buildIngredientConsensus({ official: queryInciList })
          : null;
        const anchorInciStatus = isPlainObject(descriptorAnchor?.inci_status)
          ? descriptorAnchor.inci_status
          : (isPlainObject(clientProduct?.inci_status) ? clientProduct.inci_status : null);
        const reliableGapCodesForStatus = queryGapCodes.filter((code) =>
          /(on_page_fetch_blocked|regulatory_source_used|incidecoder_source_used|retail_source_used|version_verification_needed|evidence_missing)/i
            .test(String(code || '')),
        );
        const hasInciEvidenceForPrompt =
          queryInciList.length > 0 || reliableGapCodesForStatus.length > 0 || queryEvidenceSources.length > 0;
        const v4InciStatus =
          anchorInciStatus ||
          (hasInciEvidenceForPrompt
            ? buildInciStatus({
              gapCodes: reliableGapCodesForStatus,
              consensusResult: queryInciConsensus,
              sources: queryEvidenceSources,
            })
            : null);
        const v4ProductClassification = classifyProductType({
          name: String(descriptorAnchor?.name || descriptorAnchor?.display_name || parsed.data.name || ''),
          url: String(parsed.data.url || descriptorAnchor?.url || ''),
          inciList: queryInciList,
        });
        const deepScanPromptOptions = {
          productType: v4ProductClassification.product_type,
          usageOverrides: v4ProductClassification.usage_overrides,
          ...(v4InciStatus ? { inciStatus: v4InciStatus } : {}),
        };
        const query = buildProductDeepScanPrompt({
          prefix,
          productDescriptor,
          ...deepScanPromptOptions,
        });
  
        const runDeepScan = async ({ queryText, timeoutMs, llmRouteOverride = null }) => {
          const effectiveRoute =
            llmRouteOverride && typeof llmRouteOverride === 'object' && !Array.isArray(llmRouteOverride)
              ? llmRouteOverride
              : productIntelLlmRoute;
          try {
            return await auroraChat({
              baseUrl: AURORA_DECISION_BASE_URL,
              query: queryText,
              timeoutMs,
              ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
              ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
              ...(effectiveRoute.llm_provider ? { llm_provider: effectiveRoute.llm_provider } : {}),
              ...(effectiveRoute.llm_model ? { llm_model: effectiveRoute.llm_model } : {}),
            });
          } catch {
            return null;
          }
        };
  
        const shouldTryNoAnchorDegradedDeepScan =
          !anchorId && !PRODUCT_INTEL_CATALOG_FALLBACK_ENABLED && !(PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED && parsed.data.url);
        let upstream = null;
        if (shouldTryNoAnchorDegradedDeepScan) {
          upstream = await runDeepScan({
            queryText: query,
            timeoutMs: Math.max(8000, Math.min(16000, AURORA_CHAT_UPSTREAM_TIMEOUT_MS)),
          });
          const degradedNorm = normalizeProductAnalysisFromUpstream(upstream);
          if (!degradedNorm.payload.assessment) {
            const isCn = String(ctx.lang || '').toUpperCase() === 'CN';
            const anchorResolveReason =
              primaryAnchorResolution && primaryAnchorResolution.reason
                ? `anchor_resolve_${String(primaryAnchorResolution.reason || '').toLowerCase()}`
                : null;
            const missingInfo = Array.from(
              new Set(
                [
                  'anchor_product_missing',
                  'catalog_product_missing',
                  'anchor_missing_deepscan_degraded',
                  parsed.data.url ? 'url_not_indexed_in_catalog' : null,
                  anchorResolveReason,
                ].filter(Boolean),
              ),
            );
            const fallbackUnknownPayload = {
              assessment: {
                verdict: isCn ? '未知' : 'Unknown',
                reasons: isCn
                  ? [
                      '该产品尚未建立稳定的 catalog/KB 锚点，我们已尝试一次无锚点 Deep Scan，但证据仍不足。',
                      '请提供完整 INCI 成分表，或先把该产品入库后再分析。',
                    ]
                  : [
                      'This product does not have a stable catalog/KB anchor yet; we attempted one no-anchor deep scan, but evidence is still insufficient.',
                      'Please share the full INCI list, or index this product first and then re-run analysis.',
                    ],
                ...(descriptorAnchor && typeof descriptorAnchor === 'object' ? { anchor_product: descriptorAnchor } : {}),
              },
              evidence: {
                science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
                social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
                expert_notes: [],
                confidence: null,
                missing_info: ['evidence_missing'],
              },
              confidence: null,
              missing_info: missingInfo,
            };
            const normNoAnchor = normalizeProductAnalysis(fallbackUnknownPayload);
            const payloadNoAnchor = finalizeProductAnalysisRecoContract(
              enrichProductAnalysisPayload(normNoAnchor.payload, { lang: ctx.lang, profileSummary }),
              { logger, requestId: ctx.request_id, mode: 'main_path' },
            );
            const payloadNoAnchorWithRoute = reconcileProductAnalysisConsistency(
              attachProductIntelLlmRouteProvenance(
                appendProductIntelSourceChain(payloadNoAnchor, ['llm_extraction']),
                {
                  ...llmRouteMeta,
                  trigger_reason: 'anchor_missing_deepscan_degraded',
                },
              ),
              { lang: ctx.lang },
            );
            const payloadNoAnchorWithDiagnostics = reconcileProductAnalysisConsistency(
              applyAnalyzeDiagnosticsToPayload(payloadNoAnchorWithRoute),
              { lang: ctx.lang },
            );
            scheduleProductIntelKbBackfill({
              productUrl: parsed.data.url || '',
              parsedProduct: descriptorAnchor,
              productHint: String(input || ''),
              payload: payloadNoAnchorWithDiagnostics,
              lang: ctx.lang,
              source: parsed.data.url ? 'url_realtime_product_intel_anchor_missing' : 'product_analyze_anchor_missing',
              sourceMeta: {
                anchor_missing: true,
                reason: 'anchor_missing_deepscan_degraded',
              },
              logger,
            });
            const envelope = buildEnvelope(ctx, {
              assistant_message: null,
              suggested_chips: [],
              cards: [
                {
                  card_id: `analyze_${ctx.request_id}`,
                  type: 'product_analysis',
                  payload: payloadNoAnchorWithDiagnostics,
                  ...(normNoAnchor.field_missing?.length ? { field_missing: normNoAnchor.field_missing.slice(0, 8) } : {}),
                },
              ],
              session_patch: {},
              events: [makeEvent(ctx, 'value_moment', { kind: 'product_analyze', mode: 'anchor_missing_deepscan_degraded' })],
            });
            return sendProductAnalyzeEnvelope(envelope, 200, 'main_path');
          }
        }
  
        if (!upstream) upstream = await runDeepScan({ queryText: query, timeoutMs: 16000 });
  
        let norm = normalizeProductAnalysisFromUpstream(upstream);
  
        // If personalized scan fails (often due to upstream echoing context or dropping analysis),
        // retry once with a minimal prefix to improve reliability. Mark the payload as less personalized.
        if (!norm.payload.assessment && profileSummary && input) {
          const minimalPrefix = buildContextPrefix({
            lang: ctx.lang,
            state: ctx.state || 'idle',
            trigger_source: ctx.trigger_source,
            intent: 'product_analyze_fallback',
            action_id: 'chip.action.analyze_product_fallback',
          });
          const minimalQuery = buildProductDeepScanPrompt({
            prefix: minimalPrefix,
            productDescriptor: input,
            ...deepScanPromptOptions,
          });
          const upstream2 = await runDeepScan({ queryText: minimalQuery, timeoutMs: 14000 });
          const norm2 = normalizeProductAnalysisFromUpstream(upstream2);
          if (norm2 && norm2.payload && norm2.payload.assessment) {
            const internalCodes = getProductAnalysisInternalMissingCodes(norm2.payload);
            norm = {
              payload: applyProductAnalysisGapContract({
                ...norm2.payload,
                internal_debug_codes: Array.from(new Set([...internalCodes, 'profile_context_dropped_for_reliability'])),
              }),
              field_missing: norm2.field_missing,
            };
          }
        }
  
        if (shouldRetryForNarrativeQuality(norm.payload)) {
          const formulaRetryQuery = buildProductDeepScanPrompt({
            prefix,
            productDescriptor: input,
            strictNarrative: true,
            ...deepScanPromptOptions,
          });
          const formulaRetryUpstream = await runDeepScan({
            queryText: formulaRetryQuery,
            timeoutMs: Math.max(9000, Math.min(17000, AURORA_CHAT_UPSTREAM_TIMEOUT_MS)),
          });
          const formulaRetryNorm = normalizeProductAnalysisFromUpstream(formulaRetryUpstream);
          const retryCodes = collectNarrativeRetryCodes(norm.payload, formulaRetryNorm.payload);
          if (
            hasValidNarrativeQuality(formulaRetryNorm.payload) &&
            (retryCodes.length || isProductIntelPayloadCandidateBetter(formulaRetryNorm.payload, norm.payload))
          ) {
            norm = {
              payload: applyProductAnalysisGapContract({
                ...formulaRetryNorm.payload,
                internal_debug_codes: uniqCaseInsensitiveStrings(
                  [...getProductAnalysisInternalMissingCodes(formulaRetryNorm.payload), ...retryCodes],
                  32,
                ),
              }),
              field_missing: mergeFieldMissing(formulaRetryNorm.field_missing, norm.field_missing),
            };
          }
        }
  
        const escalationRoute = resolveProductIntelEscalationRoute({ req });
        const escalationRouteAvailable =
          escalationRoute &&
          escalationRoute.llm_provider &&
          escalationRoute.llm_model &&
          (
            String(escalationRoute.llm_provider || '').trim().toLowerCase() !==
              String(productIntelLlmRoute.llm_provider || '').trim().toLowerCase() ||
            String(escalationRoute.llm_model || '').trim() !== String(productIntelLlmRoute.llm_model || '').trim()
          );
        if (escalationRouteAvailable && shouldTriggerProductIntelEscalation(norm.payload)) {
          const escalatedUpstream = await runDeepScan({
            queryText: query,
            timeoutMs: Math.max(9000, Math.min(18000, AURORA_CHAT_UPSTREAM_TIMEOUT_MS)),
            llmRouteOverride: escalationRoute,
          });
          const escalatedNorm = normalizeProductAnalysisFromUpstream(escalatedUpstream);
          if (isProductIntelPayloadCandidateBetter(escalatedNorm.payload, norm.payload)) {
            const escalatedInternalCodes = getProductAnalysisInternalMissingCodes(escalatedNorm.payload);
            norm = {
              payload: applyProductAnalysisGapContract({
                ...escalatedNorm.payload,
                internal_debug_codes: uniqCaseInsensitiveStrings(
                  [...escalatedInternalCodes, 'llm_escalation_stage2_used'],
                  32,
                ),
              }),
              field_missing: mergeFieldMissing(escalatedNorm.field_missing, norm.field_missing),
            };
            llmRouteMeta = {
              stage: String(escalationRoute.stage || 'stage_2'),
              provider: escalationRoute.llm_provider || null,
              model: escalationRoute.llm_model || null,
              trigger_reason: String(escalationRoute.trigger_reason || 'unknown_low_evidence'),
            };
          }
        }
  
        const needsUrlIngredientAnalysis = (() => {
          const assessment = norm && norm.payload && typeof norm.payload === 'object' ? norm.payload.assessment : null;
          if (!assessment || typeof assessment !== 'object') return true;
          const verdict = String(assessment.verdict || '').trim().toLowerCase();
          return !verdict || verdict === 'unknown' || verdict === '未知';
        })();
        if (PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED && needsUrlIngredientAnalysis && parsed.data.url) {
          const urlNorm = await buildProductAnalysisFromUrlIngredients({
            productUrl: parsed.data.url,
            lang: ctx.lang,
            profileSummary,
            parsedProduct: anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null,
            logger,
          });
          if (urlNorm && urlNorm.payload && urlNorm.payload.assessment) {
            realtimeUrlNormMeta = urlNorm.source_meta || realtimeUrlNormMeta;
            const mergedMissingInfo = Array.from(
              new Set([
                ...(Array.isArray(norm?.payload?.missing_info) ? norm.payload.missing_info : []),
                ...(Array.isArray(urlNorm.payload.missing_info) ? urlNorm.payload.missing_info : []),
              ]),
            );
            const mergedInternalCodes = Array.from(
              new Set([
                ...getProductAnalysisInternalMissingCodes(norm?.payload),
                ...getProductAnalysisInternalMissingCodes(urlNorm.payload),
              ]),
            );
            norm = {
              payload: applyProductAnalysisGapContract({
                ...urlNorm.payload,
                missing_info: mergedMissingInfo,
                internal_debug_codes: mergedInternalCodes,
              }),
              field_missing: mergeFieldMissing(urlNorm.field_missing, norm.field_missing),
            };
          }
        }
  
        let payload = enrichProductAnalysisPayload(norm.payload, { lang: ctx.lang, profileSummary });
        payload = applyAnalyzeDiagnosticsToPayload(payload);
        if (catalogFallback && catalogFallback.ok && payload && typeof payload === 'object') {
          const internalCodes = getProductAnalysisInternalMissingCodes(payload);
          payload = applyProductAnalysisGapContract({
            ...payload,
            internal_debug_codes: Array.from(new Set([...internalCodes, `catalog_anchor_fallback_${catalogFallback.source || 'used'}`])),
          });
        }
        if (anchorTrustContext.usable_for_anchor_id === true && parsedProduct && payload && typeof payload === 'object') {
          const a = payload.assessment && typeof payload.assessment === 'object' ? payload.assessment : null;
          if (a && !a.anchor_product && !a.anchorProduct) {
            payload = { ...payload, assessment: { ...a, anchor_product: parsedProduct } };
          }
        }
        payload = finalizeProductAnalysisRecoContract(payload, {
          logger,
          requestId: ctx.request_id,
          mode: 'main_path',
        });
        if (realtimeUrlNormMeta && parsed.data.url) {
          payload = applyProductAnalysisSocialProvenance(payload, {
            social_fetch_mode: 'async_refresh',
          });
        }
        payload = appendProductIntelSourceChain(payload, ['llm_extraction']);
        payload = attachProductIntelLlmRouteProvenance(payload, llmRouteMeta);
        payload = applyAnalyzeDiagnosticsToPayload(payload);
        payload = reconcileProductAnalysisConsistency(payload, { lang: ctx.lang });
        payload = annotateProductIntelRelaxedProvenance(payload);
  
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const assessment = payload.assessment && typeof payload.assessment === 'object' ? payload.assessment : null;
          const kbBackfillAnchor =
            assessment && typeof assessment.anchor_product === 'object' && !Array.isArray(assessment.anchor_product)
              ? assessment.anchor_product
              : (anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null);
          scheduleProductIntelKbBackfill({
            productUrl: parsed.data.url || '',
            parsedProduct: kbBackfillAnchor,
            productHint: String(input || ''),
            payload,
            lang: ctx.lang,
            source: parsed.data.url ? 'url_realtime_product_intel' : 'product_analyze_structured',
            sourceMeta: realtimeUrlNormMeta,
            logger,
          });
          if (parsed.data.url) {
            scheduleProductIntelCompetitorEnrichBackfill({
              productUrl: parsed.data.url,
              parsedProduct: kbBackfillAnchor,
              payload,
              lang: ctx.lang,
              profileSummary,
              source: 'url_realtime_product_intel',
              sourceMeta: realtimeUrlNormMeta,
              forceEnhance: hasLowCoverageCompetitorsInPayload(payload, {
                preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT,
              }),
              refreshSnapshot: shouldRefreshCompetitorSnapshot(payload, realtimeUrlNormMeta),
              logger,
            });
          }
        }
  
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `analyze_${ctx.request_id}`,
              type: 'product_analysis',
              payload,
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'product_analyze' })],
        });
        if (realtimeUrlNormMeta && parsed.data.url) {
          const socialAnchorAssessment =
            payload && typeof payload === 'object' && payload.assessment && typeof payload.assessment === 'object'
              ? payload.assessment
              : null;
          const socialAnchorProduct =
            socialAnchorAssessment &&
            socialAnchorAssessment.anchor_product &&
            typeof socialAnchorAssessment.anchor_product === 'object' &&
            !Array.isArray(socialAnchorAssessment.anchor_product)
              ? socialAnchorAssessment.anchor_product
              : (anchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null);
          social_enrich_async({
            logger,
            mode: 'main_path',
            product_url: String(parsed.data.url || '').trim(),
            payload,
            lang: ctx.lang,
            profile_summary: profileSummary,
            anchor_product: socialAnchorProduct,
            kb_key: buildProductIntelKbKey({
              productUrl: String(parsed.data.url || '').trim(),
              parsedProduct: socialAnchorProduct,
              lang: ctx.lang,
            }),
            source: 'url_realtime_product_intel',
            source_meta: realtimeUrlNormMeta,
          });
          skin_fit_heavy_async({
            logger,
            mode: 'main_path',
            product_url: String(parsed.data.url || '').trim(),
          });
        }
        return sendProductAnalyzeEnvelope(envelope, 200, 'main_path');
      } catch (err) {
        logger.error({
          event: 'aurora_product_analyze_failed',
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          path: '/v1/product/analyze',
          error: err?.message || String(err),
          stack: err?.stack || null,
        });
        const status = err.status || 500;
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to analyze product.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_ANALYZE_FAILED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_ANALYZE_FAILED' })],
        });
        return res.status(status).json(envelope);
      }
    });
  
}

module.exports = {
  mountProductIntelRoutes,
};