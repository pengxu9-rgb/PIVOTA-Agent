function registerAuroraOpsRoutes({
  app,
  logger,
  buildRequestContext,
  renderVisionMetricsPrometheus,
  renderRecoPdpFallbackMetricsPrometheus,
  renderChatQualityMetricsPrometheus,
  renderGeminiQaMetricsPrometheus,
  auroraBffQaGateAdminKey,
  hasQaGateAdminAccess,
  getGeminiGlobalGate,
  getQaRouteObservabilitySnapshot,
  auroraBffPdpHotsetPrewarmAdminKey,
  hasPdpHotsetPrewarmAdminAccess,
  getPdpPrefetchStateSnapshot,
  normalizePdpPrefetchReason,
  runPdpHotsetPrewarmBatch,
  recoDogfoodConfig,
  auroraBffRecoPrelabelAdminKey,
  hasRecoPrelabelAdminAccess,
  InternalPrelabelRequestSchema,
  PrelabelSuggestionsQuerySchema,
  LabelQueueQuerySchema,
  generatePrelabelsForAnchor,
  loadSuggestionsForAnchor,
  buildPrelabelKbReadCandidates,
  getProductIntelKbEntry,
  sanitizeProductAnalysisPayloadForPrelabel,
  attachPrelabelSuggestionsToPayload,
  mapSuggestionForResponse,
  parseIntQueryValue,
  parseBoolQueryValue,
  listQueueCandidatesWithSuggestions,
  buildLabelQueue,
  normalizeBlockToken,
  recordPrelabelRequest,
  recordPrelabelSuccess,
  recordPrelabelInvalidJson,
  recordPrelabelCacheHit,
  observePrelabelGeminiLatency,
  recordSuggestionsGeneratedPerBlock,
  setPrelabelCacheHitRate,
  recordQueueItemsServed,
  prelabelPromptVersion,
  pickFirstTrimmed = (...values) => {
    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    return '';
  },
  isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
} = {}) {
  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    const visionMetrics = String(renderVisionMetricsPrometheus() || '');
    const recoMetrics = renderRecoPdpFallbackMetricsPrometheus();
    const qualityMetrics = renderChatQualityMetricsPrometheus();
    const qaMetrics = renderGeminiQaMetricsPrometheus();
    return res.status(200).send(`${visionMetrics}${recoMetrics}${qualityMetrics}${qaMetrics}`);
  });

  app.get('/v1/ops/gemini-qa-gate/state', (req, res) => {
    if (!auroraBffQaGateAdminKey) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    if (!hasQaGateAdminAccess(req)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    const gate = getGeminiGlobalGate();
    return res.status(200).json({
      ok: true,
      data: {
        gate: gate && typeof gate.snapshot === 'function' ? gate.snapshot() : null,
        qa_observability: getQaRouteObservabilitySnapshot(),
      },
    });
  });

  app.get('/v1/ops/pdp-prefetch/state', (req, res) => {
    if (!auroraBffPdpHotsetPrewarmAdminKey) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    if (!hasPdpHotsetPrewarmAdminAccess(req)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    return res.status(200).json({
      ok: true,
      data: getPdpPrefetchStateSnapshot(),
    });
  });

  app.post('/v1/ops/pdp-prefetch/run', async (req, res) => {
    if (!auroraBffPdpHotsetPrewarmAdminKey) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    if (!hasPdpHotsetPrewarmAdminAccess(req)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    const reason = normalizePdpPrefetchReason(
      pickFirstTrimmed(req?.body?.reason, 'hotset_prewarm_manual'),
    );
    const result = await runPdpHotsetPrewarmBatch({
      logger,
      reason,
      allowWhenDisabled: true,
    });
    return res.status(200).json({
      ok: true,
      result,
      data: getPdpPrefetchStateSnapshot(),
    });
  });

  app.post('/internal/prelabel', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    if (
      !recoDogfoodConfig.dogfood_mode ||
      !recoDogfoodConfig.prelabel?.enabled ||
      !auroraBffRecoPrelabelAdminKey
    ) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    if (!hasRecoPrelabelAdminAccess(req)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }

    const parsed = InternalPrelabelRequestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST', details: parsed.error.format() });
    }

    try {
      const blocks =
        Array.isArray(parsed.data.blocks) && parsed.data.blocks.length
          ? parsed.data.blocks
          : ['competitors', 'dupes', 'related_products'];
      const out = await generatePrelabelsForAnchor({
        anchor_product_id: parsed.data.anchor_product_id,
        blocks,
        max_candidates_per_block: {
          ...(recoDogfoodConfig.prelabel?.max_candidates_per_block || {}),
          ...(isPlainObject(parsed.data.max_candidates_per_block)
            ? parsed.data.max_candidates_per_block
            : {}),
        },
        force_refresh: parsed.data.force_refresh === true,
        snapshot_payload: isPlainObject(parsed.data.snapshot_payload) ? parsed.data.snapshot_payload : null,
        lang: ctx.lang,
        request_id: pickFirstTrimmed(parsed.data.request_id, ctx.request_id),
        session_id: pickFirstTrimmed(parsed.data.session_id, ctx.aurora_uid),
        logger,
        model_name: process.env.AURORA_BFF_RECO_PRELABEL_MODEL || 'gemini-3-flash-preview',
        prompt_version: prelabelPromptVersion,
        ttl_ms: recoDogfoodConfig.prelabel?.ttl_ms,
        gemini_timeout_ms: recoDogfoodConfig.prelabel?.timeout_ms,
      });

      for (const block of ['competitors', 'dupes', 'related_products']) {
        recordPrelabelRequest({ block, mode: 'main_path', delta: Number(out?.requested_by_block?.[block] || 0) });
        recordPrelabelSuccess({ block, mode: 'main_path', delta: Number(out?.generated_by_block?.[block] || 0) });
        recordPrelabelInvalidJson({ block, mode: 'main_path', delta: Number(out?.invalid_json_by_block?.[block] || 0) });
        recordPrelabelCacheHit({ block, mode: 'main_path', delta: Number(out?.cache_hit_by_block?.[block] || 0) });
        recordSuggestionsGeneratedPerBlock({
          block,
          mode: 'main_path',
          delta: Number(out?.suggestions_by_block?.[block]?.length || 0),
        });
      }
      for (const latency of Array.isArray(out?.gemini_latency_ms) ? out.gemini_latency_ms : []) {
        observePrelabelGeminiLatency({ latencyMs: latency });
      }
      const totalRequested = Number(out?.candidates_total || 0);
      const totalHits = Number(out?.cache_hit_count || 0);
      if (totalRequested > 0) setPrelabelCacheHitRate(totalHits / totalRequested);

      return res.status(200).json({
        ok: true,
        data: out,
      });
    } catch (err) {
      logger?.warn?.(
        { err: err?.message || String(err), request_id: ctx.request_id },
        'aurora bff: internal prelabel failed',
      );
      return res.status(500).json({ ok: false, error: 'PRELABEL_FAILED' });
    }
  });

  app.get('/internal/prelabel/suggestions', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    if (
      !recoDogfoodConfig.dogfood_mode ||
      !recoDogfoodConfig.prelabel?.enabled ||
      !auroraBffRecoPrelabelAdminKey
    ) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    if (!hasRecoPrelabelAdminAccess(req)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }

    const parsed = PrelabelSuggestionsQuerySchema.safeParse({
      anchor_product_id: req.query.anchor_product_id || req.query.anchor,
      block: req.query.block,
      limit: req.query.limit,
    });
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST', details: parsed.error.format() });
    }

    try {
      const limit = parseIntQueryValue(parsed.data.limit, 200, 1, 500);
      const suggestions = await loadSuggestionsForAnchor({
        anchor_product_id: parsed.data.anchor_product_id,
        block: parsed.data.block || '',
        limit,
      });
      let payload = null;
      const kbReadCandidates = buildPrelabelKbReadCandidates(
        parsed.data.anchor_product_id,
        ctx.match_lang || ctx.lang,
      );
      if (kbReadCandidates.length > 0) {
        for (const kbKey of kbReadCandidates) {
          // eslint-disable-next-line no-await-in-loop
          const kbEntry = await getProductIntelKbEntry(kbKey);
          if (!isPlainObject(kbEntry?.analysis)) continue;
          payload = kbEntry.analysis;
          break;
        }
      }

      const payloadWithSuggestions = payload
        ? sanitizeProductAnalysisPayloadForPrelabel(
            attachPrelabelSuggestionsToPayload(payload, suggestions),
          )
        : null;

      return res.status(200).json({
        ok: true,
        anchor_product_id: parsed.data.anchor_product_id,
        block: parsed.data.block || null,
        suggestions: suggestions.map(mapSuggestionForResponse).filter(Boolean),
        payload: payloadWithSuggestions,
      });
    } catch (err) {
      logger?.warn?.(
        { err: err?.message || String(err), request_id: ctx.request_id },
        'aurora bff: prelabel suggestions fetch failed',
      );
      return res.status(500).json({ ok: false, error: 'PRELABEL_SUGGESTIONS_FAILED' });
    }
  });

  app.get('/internal/label-queue', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    if (
      !recoDogfoodConfig.dogfood_mode ||
      !recoDogfoodConfig.prelabel?.enabled ||
      !auroraBffRecoPrelabelAdminKey
    ) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    if (!hasRecoPrelabelAdminAccess(req)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }

    const parsed = LabelQueueQuerySchema.safeParse({
      block: req.query.block,
      limit: req.query.limit,
      anchor_product_id: req.query.anchor_product_id || req.query.anchor,
      low_confidence: req.query.low_confidence,
      wrong_block_only: req.query.wrong_block_only,
      exploration_only: req.query.exploration_only,
      missing_info_only: req.query.missing_info_only,
    });
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST', details: parsed.error.format() });
    }

    try {
      const limit = parseIntQueryValue(parsed.data.limit, 50, 1, 500);
      const lowConfidence = parseBoolQueryValue(parsed.data.low_confidence, false);
      const wrongBlockOnly = parseBoolQueryValue(parsed.data.wrong_block_only, false);
      const explorationOnly = parseBoolQueryValue(parsed.data.exploration_only, false);
      const missingInfoOnly = parseBoolQueryValue(parsed.data.missing_info_only, false);

      const rows = await listQueueCandidatesWithSuggestions({
        block: parsed.data.block || '',
        limit: Math.max(limit * 3, 120),
        anchorProductId: parsed.data.anchor_product_id || '',
        confidenceLte: lowConfidence ? 0.45 : null,
        wrongBlockOnly,
      });

      const queue = buildLabelQueue(rows, {
        limit,
        filters: {
          block: parsed.data.block || '',
          anchor_product_id: parsed.data.anchor_product_id || '',
          low_confidence: lowConfidence,
          wrong_block_only: wrongBlockOnly,
          exploration_only: explorationOnly,
          missing_info_only: missingInfoOnly,
        },
      });

      const countsByBlock = { competitors: 0, dupes: 0, related_products: 0 };
      for (const item of queue) {
        const block = normalizeBlockToken(item?.block);
        if (!block) continue;
        countsByBlock[block] += 1;
      }
      for (const block of ['competitors', 'dupes', 'related_products']) {
        if (countsByBlock[block] > 0) recordQueueItemsServed({ block, delta: countsByBlock[block] });
      }

      return res.status(200).json({
        ok: true,
        items: queue.map((row) => ({
          suggestion_id: row.id,
          anchor_product_id: row.anchor_product_id,
          block: row.block,
          candidate_product_id: row.candidate_product_id,
          suggested_label: row.suggested_label,
          wrong_block_target: row.wrong_block_target,
          confidence: row.confidence,
          rationale_user_visible: row.rationale_user_visible,
          flags: Array.isArray(row.flags) ? row.flags : [],
          priority_score: row.priority_score,
          review_url: `/chat/label-queue?anchor_product_id=${encodeURIComponent(String(row.anchor_product_id || ''))}`,
          updated_at: row.updated_at || null,
        })),
      });
    } catch (err) {
      logger?.warn?.(
        { err: err?.message || String(err), request_id: ctx.request_id },
        'aurora bff: label queue fetch failed',
      );
      return res.status(500).json({ ok: false, error: 'LABEL_QUEUE_FAILED' });
    }
  });
}

module.exports = {
  registerAuroraOpsRoutes,
};
