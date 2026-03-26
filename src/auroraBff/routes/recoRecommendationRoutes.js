function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora reco recommendation routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora reco recommendation routes missing schema: ${name}`);
}

function mountRecoRecommendationRoutes(app, deps = {}) {
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const resolveIdentity = ensureFunction('resolveIdentity', deps.resolveIdentity);
  const getProfileForIdentity = ensureFunction('getProfileForIdentity', deps.getProfileForIdentity);
  const getRecentSkinLogsForIdentity = ensureFunction('getRecentSkinLogsForIdentity', deps.getRecentSkinLogsForIdentity);
  const summarizeProfileForContext = ensureFunction('summarizeProfileForContext', deps.summarizeProfileForContext);
  const shouldDiagnosisGate = ensureFunction('shouldDiagnosisGate', deps.shouldDiagnosisGate);
  const buildDiagnosisPrompt = ensureFunction('buildDiagnosisPrompt', deps.buildDiagnosisPrompt);
  const buildDiagnosisChips = ensureFunction('buildDiagnosisChips', deps.buildDiagnosisChips);
  const buildConfidenceNoticeCardPayload = ensureFunction(
    'buildConfidenceNoticeCardPayload',
    deps.buildConfidenceNoticeCardPayload,
  );
  const buildRecoGenerateUserAsk = ensureFunction('buildRecoGenerateUserAsk', deps.buildRecoGenerateUserAsk);
  const generateProductRecommendations = ensureFunction(
    'generateProductRecommendations',
    deps.generateProductRecommendations,
  );
  const normalizeRecoGenerate = ensureFunction('normalizeRecoGenerate', deps.normalizeRecoGenerate);
  const enrichRecommendationsWithAlternatives = ensureFunction(
    'enrichRecommendationsWithAlternatives',
    deps.enrichRecommendationsWithAlternatives,
  );
  const mergeFieldMissing = ensureFunction('mergeFieldMissing', deps.mergeFieldMissing);
  const isPlainObject = ensureFunction('isPlainObject', deps.isPlainObject);
  const buildRecoEntryChips = ensureFunction('buildRecoEntryChips', deps.buildRecoEntryChips);
  const deriveRecoEmptyReason = ensureFunction('deriveRecoEmptyReason', deps.deriveRecoEmptyReason);
  const applyRecommendationOutputGuardrailsForRoute = ensureFunction(
    'applyRecommendationOutputGuardrailsForRoute',
    deps.applyRecommendationOutputGuardrailsForRoute,
  );
  const persistRejectedCatalogCandidates = ensureFunction(
    'persistRejectedCatalogCandidates',
    deps.persistRejectedCatalogCandidates,
  );
  const buildProductInputText = ensureFunction('buildProductInputText', deps.buildProductInputText);
  const extractAnchorIdFromProductLike = ensureFunction(
    'extractAnchorIdFromProductLike',
    deps.extractAnchorIdFromProductLike,
  );
  const coerceBoolean = ensureFunction('coerceBoolean', deps.coerceBoolean);
  const fetchRecoAlternativesForProduct = ensureFunction(
    'fetchRecoAlternativesForProduct',
    deps.fetchRecoAlternativesForProduct,
  );

  const RecoGenerateRequestSchema = ensureSchema('RecoGenerateRequestSchema', deps.RecoGenerateRequestSchema);
  const RecoAlternativesRequestSchema = ensureSchema(
    'RecoAlternativesRequestSchema',
    deps.RecoAlternativesRequestSchema,
  );

  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const auroraRecoGenerateGuardrailV1 = deps.auroraRecoGenerateGuardrailV1 !== false;

  app.post('/v1/reco/generate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RecoGenerateRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', details: parsed.error.format() },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
      }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        7,
      ).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);

      const gate = shouldDiagnosisGate({ message: 'recommend', triggerSource: 'action', profile });
      let gateAdvisoryCard = null;
      let gateAdvisoryChips = [];
      if (gate.gated) {
        const prompt = buildDiagnosisPrompt(ctx.lang, gate.missing);
        const chips = buildDiagnosisChips(ctx.lang, gate.missing);
        gateAdvisoryCard = {
          card_id: `diag_advisory_${ctx.request_id}`,
          type: 'confidence_notice',
          payload: buildConfidenceNoticeCardPayload({
            language: ctx.lang,
            reason: 'diagnosis_first',
            confidence: { score: 0.45, level: 'low', rationale: ['profile_incomplete_assumptions_used'] },
            non_blocking: true,
            details: [
              ...(Array.isArray(gate.missing) ? gate.missing.map((field) => `missing_${field}`) : []),
              prompt,
            ].slice(0, 6),
            actions: ['refine_profile'],
          }),
        };
        gateAdvisoryChips = chips;
      }

      const requestText = buildRecoGenerateUserAsk({
        focus: parsed.data.focus,
        constraints: parsed.data.constraints || {},
        lang: ctx.lang,
      });
      const upstreamReco = await generateProductRecommendations({
        ctx,
        profile,
        recentLogs,
        message: requestText,
        includeAlternatives: false,
        logger,
        recoTriggerSource: 'goal_driven',
      });
      const norm =
        upstreamReco && upstreamReco.norm && typeof upstreamReco.norm === 'object'
          ? upstreamReco.norm
          : normalizeRecoGenerate(null);
      if (parsed.data.include_alternatives) {
        const alt = await enrichRecommendationsWithAlternatives({
          ctx,
          profileSummary,
          recentLogs,
          recommendations: norm.payload.recommendations,
          logger,
        });
        norm.payload = { ...norm.payload, recommendations: alt.recommendations };
        norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
      }
      const payload = norm.payload;
      if (
        isPlainObject(payload) &&
        !(Array.isArray(payload.recommendations) && payload.recommendations.length > 0) &&
        Array.isArray(payload.plan_only_recommendations) &&
        payload.plan_only_recommendations.length > 0 &&
        String(payload.products_empty_reason || '').trim() === 'strict_filter_fallback_only'
      ) {
        payload.recommendations = payload.plan_only_recommendations;
        payload.grounding_status = 'plan_only';
        payload.mainline_status = 'plan_only_fallback';
        logger?.info?.(
          { request_id: ctx.request_id, plan_count: payload.recommendations.length },
          'aurora bff: /v1/reco/generate strict filter cleared grounded recs, falling back to plan_only recommendations',
        );
      }
      const recoMeta = isPlainObject(payload?.recommendation_meta) ? payload.recommendation_meta : {};
      const hasPayloadRecommendations = Array.isArray(payload?.recommendations) && payload.recommendations.length > 0;

      const suggestedChips = hasPayloadRecommendations ? [] : buildRecoEntryChips(ctx.lang);
      if (gateAdvisoryChips.length > 0) {
        const existing = new Set(
          suggestedChips.map((chip) => String(chip && chip.chip_id ? chip.chip_id : '').trim()).filter(Boolean),
        );
        for (const chip of gateAdvisoryChips) {
          const chipId = String(chip && chip.chip_id ? chip.chip_id : '').trim();
          if (!chipId || existing.has(chipId)) continue;
          existing.add(chipId);
          suggestedChips.push(chip);
          if (suggestedChips.length >= 12) break;
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: suggestedChips,
        cards: [
          {
            card_id: `reco_${ctx.request_id}`,
            type: 'recommendations',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
          ...(gateAdvisoryCard ? [gateAdvisoryCard] : []),
        ],
        session_patch: payload.recommendations && payload.recommendations.length ? { next_state: 'S7_PRODUCT_RECO' } : {},
        events: [
          makeEvent({ ...ctx, trigger_source: 'action' }, 'recos_requested', {
            explicit: true,
            source: String(payload?.source || recoMeta.source_mode || 'catalog_grounded_v1'),
            source_mode: String(recoMeta.source_mode || ''),
            grounding_status: String(payload?.grounding_status || recoMeta.grounding_status || ''),
            grounded_count: Number.isFinite(Number(payload?.grounded_count)) ? Number(payload.grounded_count) : 0,
            ungrounded_count: Number.isFinite(Number(payload?.ungrounded_count)) ? Number(payload.ungrounded_count) : 0,
            mainline_status: String(payload?.mainline_status || recoMeta.mainline_status || ''),
            catalog_skip_reason: String(payload?.catalog_skip_reason || recoMeta.catalog_skip_reason || ''),
            telemetry_reason: String(payload?.telemetry_reason || recoMeta.telemetry_failure_reason || ''),
            ...(recoMeta.prompt_template_id ? { prompt_template_id: recoMeta.prompt_template_id } : {}),
            ...(() => {
              const emptyReason = deriveRecoEmptyReason({
                hasRecs: hasPayloadRecommendations,
                productsEmptyReason: payload?.products_empty_reason,
                groundedCount: Number.isFinite(Number(payload?.grounded_count)) ? Number(payload.grounded_count) : 0,
                artifactGateOk: true,
              });
              return emptyReason ? { reason: emptyReason } : {};
            })(),
          }),
        ],
      });
      if (!auroraRecoGenerateGuardrailV1) return res.json(envelope);

      const guardrailResult = await applyRecommendationOutputGuardrailsForRoute({
        envelope,
        ctx,
        logger,
      });
      if (Array.isArray(guardrailResult.rejected) && guardrailResult.rejected.length > 0) {
        persistRejectedCatalogCandidates(ctx, guardrailResult.rejected);
      }
      const guardedEnvelope = isPlainObject(guardrailResult.envelope) ? guardrailResult.envelope : envelope;
      const guardedCards = Array.isArray(guardedEnvelope.cards) ? guardedEnvelope.cards : [];
      const guardedRecoCard = guardedCards.find(
        (card) => isPlainObject(card) && String(card.type || '').trim().toLowerCase() === 'recommendations',
      );
      const guardedRecommendations =
        Array.isArray(guardedRecoCard && guardedRecoCard.payload && guardedRecoCard.payload.recommendations)
          ? guardedRecoCard.payload.recommendations
          : [];
      const hasGuardedRecommendations = guardedRecommendations.length > 0;
      const nextSessionPatch = isPlainObject(guardedEnvelope.session_patch) ? { ...guardedEnvelope.session_patch } : {};
      if (hasGuardedRecommendations) {
        nextSessionPatch.next_state = 'S7_PRODUCT_RECO';
      } else {
        delete nextSessionPatch.next_state;
        if (!Array.isArray(guardedEnvelope.suggested_chips) || guardedEnvelope.suggested_chips.length === 0) {
          guardedEnvelope.suggested_chips = buildRecoEntryChips(ctx.lang);
        }
      }
      guardedEnvelope.session_patch = nextSessionPatch;
      return res.json(guardedEnvelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to generate recommendations.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: { error: err.code || 'RECO_GENERATE_FAILED' },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'RECO_GENERATE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/reco/alternatives', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RecoAlternativesRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          ok: false,
          error: 'BAD_REQUEST',
          details: parsed.error.format(),
        });
      }

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
      }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        7,
      ).catch(() => []);
      const productObj =
        parsed.data.product && typeof parsed.data.product === 'object' && !Array.isArray(parsed.data.product)
          ? parsed.data.product
          : null;
      const productInput = String(parsed.data.product_input || '').trim() || buildProductInputText(productObj, null);
      const anchorId = String(parsed.data.anchor_product_id || '').trim() || extractAnchorIdFromProductLike(productObj);
      const debugHeaderRaw = req.get('X-Debug') ?? req.get('X-Aurora-Debug');
      const includeDebugFromHeader = debugHeaderRaw == null || debugHeaderRaw === '' ? null : coerceBoolean(debugHeaderRaw);
      const includeDebug = includeDebugFromHeader == null ? Boolean(parsed.data.include_debug) : includeDebugFromHeader;
      const maxTotal = Number.isFinite(Number(parsed.data.max_total))
        ? Math.max(1, Math.min(8, Math.trunc(Number(parsed.data.max_total))))
        : 6;

      if (!productInput && !anchorId) {
        return res.status(400).json({
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          ok: false,
          error: 'PRODUCT_IDENTITY_MISSING',
          field_missing: [{ field: 'product_input', reason: 'product_identity_missing' }],
        });
      }

      const out = await fetchRecoAlternativesForProduct({
        ctx,
        profileSummary: summarizeProfileForContext(profile),
        recentLogs,
        productInput,
        productObj,
        anchorId,
        maxTotal,
        debug: includeDebug,
        logger,
      });

      return res.json({
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        ok: out && out.ok !== false,
        alternatives: Array.isArray(out && out.alternatives) ? out.alternatives : [],
        field_missing: Array.isArray(out && out.field_missing) ? out.field_missing : [],
        source_mode: out && typeof out.source_mode === 'string' ? out.source_mode : 'llm',
        fallback_source: out && typeof out.fallback_source === 'string' ? out.fallback_source : null,
        refresh_pending: Boolean(out && out.refresh_pending === true),
        refresh_after_ms: Number.isFinite(Number(out && out.refresh_after_ms))
          ? Number(out && out.refresh_after_ms)
          : 0,
        failure_class: out && typeof out.failure_class === 'string' ? out.failure_class : null,
        attempt_count: Number.isFinite(Number(out && out.attempt_count))
          ? Math.max(0, Math.trunc(Number(out && out.attempt_count)))
          : 0,
        prompt_contract_ok: out && out.prompt_contract_ok !== false,
        prompt_contract_issues: Array.isArray(out && out.prompt_contract_issues) ? out.prompt_contract_issues : [],
        no_result_reason: out && out.no_result_reason ? String(out.no_result_reason) : null,
        timeout_root_cause: out && out.timeout_root_cause ? String(out.timeout_root_cause) : null,
        llm_trace: out && out.llm_trace && typeof out.llm_trace === 'object' ? out.llm_trace : null,
        ...(includeDebug && out && out.debug && typeof out.debug === 'object' ? { debug: out.debug } : {}),
      });
    } catch (err) {
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'aurora bff: reco alternatives endpoint failed',
      );
      return res.status(500).json({
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        ok: false,
        error: err && err.code ? err.code : 'RECO_ALTERNATIVES_FAILED',
      });
    }
  });
}

module.exports = {
  mountRecoRecommendationRoutes,
};
