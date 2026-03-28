function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function defaultPickFirstTrimmed(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function createRecoDogfoodEnvelopeRuntime({
  pickFirstTrimmed = defaultPickFirstTrimmed,
  isPlainObject = defaultIsPlainObject,
  RECO_DOGFOOD_CONFIG = {},
  social_enrich_async = () => {},
  applyAsyncBlockPatch = () => {},
  recordRecoAsyncUpdate = () => {},
  registerRecoTrackingSnapshot = () => {},
  createAsyncTicket = () => ({ ticketId: '' }),
  recordRecoExplorationSlot = () => {},
  loadSuggestionsForAnchor = async () => [],
  attachPrelabelSuggestionsToPayload = (payload) => payload,
  setTimeoutImpl = setTimeout,
} = {}) {
  const safePickFirstTrimmed = typeof pickFirstTrimmed === 'function' ? pickFirstTrimmed : defaultPickFirstTrimmed;
  const safeIsPlainObject = typeof isPlainObject === 'function' ? isPlainObject : defaultIsPlainObject;
  const config = safeIsPlainObject(RECO_DOGFOOD_CONFIG) ? RECO_DOGFOOD_CONFIG : {};

  function getRecoDogfoodSessionId(req, ctx, explicitSessionId = '') {
    const fromBody = safePickFirstTrimmed(explicitSessionId);
    if (fromBody) return fromBody;
    const fromHeader = safePickFirstTrimmed(
      req?.get?.('X-Session-ID'),
      req?.get?.('x-session-id'),
      req?.headers?.['x-session-id'],
    );
    if (fromHeader) return fromHeader;
    return safePickFirstTrimmed(ctx?.aurora_uid, ctx?.trace_id, ctx?.request_id, 'anonymous');
  }

  function normalizeDogfoodFeaturesEffective(raw = null, { autoRollback = false } = {}) {
    const src = safeIsPlainObject(raw) ? raw : {};
    const dogfoodMode = Boolean(config.dogfood_mode);
    const baseline = {
      interleave: Boolean(dogfoodMode && config.interleave?.enabled),
      exploration: Boolean(dogfoodMode && config.exploration?.enabled),
      async_rerank: Boolean(dogfoodMode && config.ui?.allow_block_internal_rerank_on_async),
      show_employee_feedback_controls: Boolean(dogfoodMode && config.ui?.show_employee_feedback_controls),
    };
    const merged = {
      interleave: src.interleave == null ? baseline.interleave : Boolean(src.interleave),
      exploration: src.exploration == null ? baseline.exploration : Boolean(src.exploration),
      async_rerank: src.async_rerank == null ? baseline.async_rerank : Boolean(src.async_rerank),
      show_employee_feedback_controls:
        src.show_employee_feedback_controls == null
          ? baseline.show_employee_feedback_controls
          : Boolean(src.show_employee_feedback_controls),
    };
    if (!autoRollback) return merged;
    return {
      ...merged,
      interleave: false,
      exploration: false,
      async_rerank: false,
      show_employee_feedback_controls: false,
    };
  }

  function getRecoBlockCandidates(payload, block) {
    const obj = safeIsPlainObject(payload?.[block]) ? payload[block] : {};
    return Array.isArray(obj.candidates) ? obj.candidates : [];
  }

  function scheduleDogfoodAsyncBlockPatches({
    ticketId,
    payload,
    mode = 'main_path',
    logger,
    allowAsyncRerank = false,
    lang = 'EN',
  } = {}) {
    if (!config.dogfood_mode) return;
    if (!allowAsyncRerank) return;
    const ticket = String(ticketId || '').trim();
    if (!ticket) return;
    const sourcePayload = safeIsPlainObject(payload) ? payload : {};
    setTimeoutImpl(() => {
      social_enrich_async({
        logger,
        mode,
        lang,
        payload: sourcePayload,
        skip_kb_write: true,
        apply_async_patch: ({ block, next_candidates }) =>
          applyAsyncBlockPatch({
            ticketId: ticket,
            block,
            nextCandidates: Array.isArray(next_candidates) ? next_candidates : [],
          }),
        on_async_update: ({ block, result, changed_count }) => {
          const changedCount = Number.isFinite(Number(changed_count))
            ? Math.max(0, Math.trunc(Number(changed_count)))
            : 0;
          const normalizedResult = String(result || '').trim().toLowerCase() || 'skipped';
          recordRecoAsyncUpdate({
            block,
            result: normalizedResult,
            mode,
            changedCount,
          });
          logger?.info?.(
            {
              event_name: 'reco_async_update',
              ticket_id: ticket,
              block,
              mode,
              result: normalizedResult,
              changed_count: changedCount,
            },
            'aurora bff: reco async update',
          );
        },
      });
    }, 180);
  }

  function augmentProductAnalysisPayloadForDogfood({
    payload,
    req,
    ctx,
    mode = 'main_path',
    cardId = '',
    sessionId = '',
    logger,
  } = {}) {
    const p = safeIsPlainObject(payload) ? payload : null;
    if (!p) return payload;

    const provenance = safeIsPlainObject(p.provenance) ? { ...p.provenance } : {};
    const autoRollback = provenance.auto_rollback_flag === true || provenance.guardrail_circuit_open === true;
    const featuresEffective = normalizeDogfoodFeaturesEffective(provenance.dogfood_features_effective, {
      autoRollback,
    });
    provenance.dogfood_mode = Boolean(config.dogfood_mode);
    provenance.dogfood_features_effective = featuresEffective;
    provenance.interleave = safeIsPlainObject(provenance.interleave)
      ? provenance.interleave
      : {
          enabled: featuresEffective.interleave,
          rankerA: config.interleave?.rankerA,
          rankerB: config.interleave?.rankerB,
        };
    provenance.lock_top_n_on_first_paint = config.ui?.lock_top_n_on_first_paint;

    const anchorProductId = safePickFirstTrimmed(
      p?.assessment?.anchor_product?.product_id,
      p?.assessment?.anchor_product?.sku_id,
      p?.assessment?.anchor_product?.name,
    );
    const blocks = {
      competitors: getRecoBlockCandidates(p, 'competitors'),
      related_products: getRecoBlockCandidates(p, 'related_products'),
      dupes: getRecoBlockCandidates(p, 'dupes'),
    };

    const trackingPayload = safeIsPlainObject(p.candidate_tracking)
      ? p.candidate_tracking
      : safeIsPlainObject(p.tracking)
        ? p.tracking
        : null;
    const trackingByBlock = safeIsPlainObject(trackingPayload?.by_block) ? trackingPayload.by_block : null;
    const interleaveAttributionByBlock = safeIsPlainObject(trackingPayload?.interleave_attribution_by_block)
      ? trackingPayload.interleave_attribution_by_block
      : null;
    const explorationKeysByBlock = safeIsPlainObject(trackingPayload?.exploration_keys_by_block)
      ? trackingPayload.exploration_keys_by_block
      : null;

    if (config.dogfood_mode) {
      registerRecoTrackingSnapshot({
        requestId: ctx?.request_id,
        sessionId: getRecoDogfoodSessionId(req, ctx, sessionId),
        anchorProductId,
        blocks,
        trackingByBlock,
        interleaveAttribution: interleaveAttributionByBlock,
        explorationKeys: explorationKeysByBlock,
        ttlMs: config.async?.poll_ttl_ms,
      });

      const ticket = createAsyncTicket({
        requestId: ctx?.request_id,
        cardId,
        lockTopN: config.ui?.lock_top_n_on_first_paint,
        initialPayload: {
          competitors: p.competitors,
          related_products: p.related_products,
          dupes: p.dupes,
          provenance,
        },
        ttlMs: config.async?.poll_ttl_ms,
      });
      provenance.async_ticket_id = ticket.ticketId;
      scheduleDogfoodAsyncBlockPatches({
        ticketId: ticket.ticketId,
        payload: p,
        mode,
        logger,
        allowAsyncRerank: featuresEffective.async_rerank === true,
        lang: ctx?.lang,
      });
    }

    for (const block of ['competitors', 'related_products', 'dupes']) {
      const map = safeIsPlainObject(trackingByBlock?.[block]) ? trackingByBlock[block] : null;
      if (!map) continue;
      const explorationCount = Object.values(map).reduce(
        (sum, entry) => sum + (safeIsPlainObject(entry) && entry.was_exploration_slot === true ? 1 : 0),
        0,
      );
      if (explorationCount > 0) {
        recordRecoExplorationSlot({
          block,
          mode,
          delta: explorationCount,
        });
      }
    }

    const nextPayload = {
      ...p,
      provenance,
    };
    delete nextPayload.candidate_tracking;
    delete nextPayload.candidate_tracking_internal;
    delete nextPayload.internal_attribution;
    delete nextPayload.tracking;
    if (safeIsPlainObject(nextPayload.provenance)) {
      nextPayload.provenance = { ...nextPayload.provenance };
      delete nextPayload.provenance.candidate_tracking;
      delete nextPayload.provenance.candidate_tracking_internal;
      delete nextPayload.provenance.internal_attribution;
      delete nextPayload.provenance.internal_reason_codes;
    }
    return nextPayload;
  }

  function augmentEnvelopeProductAnalysisCardsForDogfood({
    envelope,
    req,
    ctx,
    mode = 'main_path',
    sessionId = '',
    logger,
  } = {}) {
    const env = safeIsPlainObject(envelope) ? { ...envelope } : envelope;
    if (!safeIsPlainObject(env)) return envelope;
    const cards = Array.isArray(env.cards) ? env.cards : [];
    env.cards = cards.map((card) => {
      if (!safeIsPlainObject(card)) return card;
      const type = String(card.type || '').trim().toLowerCase();
      if (type !== 'product_analysis') return card;
      return {
        ...card,
        payload: augmentProductAnalysisPayloadForDogfood({
          payload: card.payload,
          req,
          ctx,
          mode,
          cardId: card.card_id,
          sessionId,
          logger,
        }),
      };
    });
    return env;
  }

  async function augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions({
    envelope,
    logger,
  } = {}) {
    if (!config.dogfood_mode || !config.prelabel?.enabled) return envelope;
    const env = safeIsPlainObject(envelope) ? { ...envelope } : envelope;
    if (!safeIsPlainObject(env)) return envelope;
    const cards = Array.isArray(env.cards) ? env.cards : [];
    if (!cards.length) return env;

    env.cards = await Promise.all(
      cards.map(async (card) => {
        if (!safeIsPlainObject(card)) return card;
        const type = String(card.type || '').trim().toLowerCase();
        if (type !== 'product_analysis') return card;
        const payload = safeIsPlainObject(card.payload) ? card.payload : null;
        if (!payload) return card;

        const anchorProductId = safePickFirstTrimmed(
          payload?.assessment?.anchor_product?.product_id,
          payload?.assessment?.anchor_product?.sku_id,
          payload?.assessment?.anchorProduct?.product_id,
          payload?.assessment?.anchorProduct?.sku_id,
        );
        if (!anchorProductId) return card;

        try {
          const suggestions = await loadSuggestionsForAnchor({
            anchor_product_id: anchorProductId,
            limit: 220,
          });
          if (!Array.isArray(suggestions) || !suggestions.length) return card;
          return {
            ...card,
            payload: attachPrelabelSuggestionsToPayload(payload, suggestions),
          };
        } catch (err) {
          logger?.warn?.(
            {
              err: err?.message || String(err),
              anchor_product_id: anchorProductId,
            },
            'aurora bff: attach prelabel suggestions failed',
          );
          return card;
        }
      }),
    );
    return env;
  }

  return {
    getRecoDogfoodSessionId,
    normalizeDogfoodFeaturesEffective,
    getRecoBlockCandidates,
    scheduleDogfoodAsyncBlockPatches,
    augmentProductAnalysisPayloadForDogfood,
    augmentEnvelopeProductAnalysisCardsForDogfood,
    augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions,
  };
}

module.exports = {
  createRecoDogfoodEnvelopeRuntime,
};
