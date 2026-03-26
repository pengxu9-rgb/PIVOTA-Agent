function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora reco dogfood routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora reco dogfood routes missing schema: ${name}`);
}

function mountRecoDogfoodRoutes(app, deps = {}) {
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const getRecoDogfoodSessionId = ensureFunction('getRecoDogfoodSessionId', deps.getRecoDogfoodSessionId);
  const pickFirstTrimmed = ensureFunction('pickFirstTrimmed', deps.pickFirstTrimmed);
  const getRecoTrackingMetadata = ensureFunction('getRecoTrackingMetadata', deps.getRecoTrackingMetadata);
  const writeRecoEmployeeFeedbackEvent = ensureFunction('writeRecoEmployeeFeedbackEvent', deps.writeRecoEmployeeFeedbackEvent);
  const setLlmSuggestionOverturnedRate = ensureFunction('setLlmSuggestionOverturnedRate', deps.setLlmSuggestionOverturnedRate);
  const recordRecoEmployeeFeedback = ensureFunction('recordRecoEmployeeFeedback', deps.recordRecoEmployeeFeedback);
  const recordRecoInterleaveClick = ensureFunction('recordRecoInterleaveClick', deps.recordRecoInterleaveClick);
  const recordRecoInterleaveWin = ensureFunction('recordRecoInterleaveWin', deps.recordRecoInterleaveWin);
  const getAsyncUpdates = ensureFunction('getAsyncUpdates', deps.getAsyncUpdates);
  const recordRecoAsyncUpdate = ensureFunction('recordRecoAsyncUpdate', deps.recordRecoAsyncUpdate);

  const RecoEmployeeFeedbackRequestSchema = ensureSchema(
    'RecoEmployeeFeedbackRequestSchema',
    deps.RecoEmployeeFeedbackRequestSchema,
  );
  const RecoInterleaveClickRequestSchema = ensureSchema(
    'RecoInterleaveClickRequestSchema',
    deps.RecoInterleaveClickRequestSchema,
  );
  const RecoAsyncUpdatesRequestSchema = ensureSchema(
    'RecoAsyncUpdatesRequestSchema',
    deps.RecoAsyncUpdatesRequestSchema,
  );

  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const recoDogfoodConfig =
    deps && deps.recoDogfoodConfig && typeof deps.recoDogfoodConfig === 'object'
      ? deps.recoDogfoodConfig
      : {};

  app.post('/v1/reco/employee-feedback', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    if (!recoDogfoodConfig.dogfood_mode) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    try {
      const parsed = RecoEmployeeFeedbackRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          details: parsed.error.format(),
        });
      }
      const sessionId = getRecoDogfoodSessionId(req, ctx, parsed.data.session_id);
      const requestId = pickFirstTrimmed(parsed.data.request_id, ctx.request_id);
      const metadata = getRecoTrackingMetadata({
        requestId,
        sessionId,
        block: parsed.data.block,
        candidateProductId: parsed.data.candidate_product_id,
        candidateName: parsed.data.candidate_name,
      });
      const event = writeRecoEmployeeFeedbackEvent(
        {
          anchor_product_id: parsed.data.anchor_product_id,
          block: parsed.data.block,
          candidate_product_id: parsed.data.candidate_product_id || '',
          candidate_name: parsed.data.candidate_name || '',
          feedback_type: parsed.data.feedback_type,
          wrong_block_target: parsed.data.wrong_block_target || null,
          reason_tags: Array.isArray(parsed.data.reason_tags) ? parsed.data.reason_tags : [],
          was_exploration_slot:
            parsed.data.was_exploration_slot == null
              ? Boolean(metadata?.was_exploration_slot)
              : Boolean(parsed.data.was_exploration_slot),
          rank_position:
            parsed.data.rank_position == null
              ? Number(metadata?.rank_position || 1)
              : Number(parsed.data.rank_position),
          pipeline_version: parsed.data.pipeline_version || recoDogfoodConfig.interleave?.rankerA,
          models: parsed.data.models || 'unknown',
          suggestion_id: parsed.data.suggestion_id || null,
          llm_suggested_label: parsed.data.llm_suggested_label || null,
          llm_confidence: parsed.data.llm_confidence == null ? null : Number(parsed.data.llm_confidence),
          request_id: requestId,
          session_id: sessionId,
          timestamp: parsed.data.timestamp || Date.now(),
        },
        { logger },
      );
      if (event.llm_suggested_label) {
        const suggested = String(event.llm_suggested_label || '').trim().toLowerCase();
        const finalLabel = String(event.feedback_type || '').trim().toLowerCase();
        if (suggested && finalLabel) {
          if (!global.__auroraPrelabelFeedbackStats) {
            global.__auroraPrelabelFeedbackStats = { total: 0, overturned: 0 };
          }
          global.__auroraPrelabelFeedbackStats.total += 1;
          if (suggested !== finalLabel) global.__auroraPrelabelFeedbackStats.overturned += 1;
          if (global.__auroraPrelabelFeedbackStats.total > 0) {
            const rate =
              global.__auroraPrelabelFeedbackStats.overturned / global.__auroraPrelabelFeedbackStats.total;
            setLlmSuggestionOverturnedRate(rate);
          }
        }
      }
      recordRecoEmployeeFeedback({
        block: event.block,
        feedbackType: event.feedback_type,
        mode: 'main_path',
      });
      return res.status(200).json({
        ok: true,
        event,
      });
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err) }, 'aurora bff: reco employee feedback failed');
      return res.status(500).json({ ok: false, error: 'RECO_EMPLOYEE_FEEDBACK_FAILED' });
    }
  });

  app.post('/v1/reco/interleave/click', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    if (!recoDogfoodConfig.dogfood_mode) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    try {
      const parsed = RecoInterleaveClickRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          details: parsed.error.format(),
        });
      }
      const sessionId = getRecoDogfoodSessionId(req, ctx, parsed.data.session_id);
      const requestId = pickFirstTrimmed(parsed.data.request_id, ctx.request_id);
      const metadata = getRecoTrackingMetadata({
        requestId,
        sessionId,
        block: parsed.data.block,
        candidateProductId: parsed.data.candidate_product_id,
        candidateName: parsed.data.candidate_name,
      });
      const attribution = String(metadata?.attribution || 'both');
      recordRecoInterleaveClick({
        block: parsed.data.block,
        attribution,
        mode: 'main_path',
      });
      if (attribution === 'A' || attribution === 'B') {
        recordRecoInterleaveWin({
          block: parsed.data.block,
          ranker: attribution === 'A' ? recoDogfoodConfig.interleave?.rankerA : recoDogfoodConfig.interleave?.rankerB,
          categoryBucket: parsed.data.category_bucket || 'unknown',
          priceBand: parsed.data.price_band || 'unknown',
          mode: 'main_path',
        });
      } else {
        recordRecoInterleaveWin({
          block: parsed.data.block,
          ranker: 'tie',
          categoryBucket: parsed.data.category_bucket || 'unknown',
          priceBand: parsed.data.price_band || 'unknown',
          mode: 'main_path',
        });
      }
      logger?.info?.(
        {
          event_name: 'reco_interleave_click',
          request_id: requestId,
          session_id: sessionId,
          block: parsed.data.block,
          attribution,
          candidate_product_id: parsed.data.candidate_product_id || '',
          was_exploration_slot: Boolean(metadata?.was_exploration_slot),
          rank_position: Number(metadata?.rank_position || 0),
        },
        'aurora bff: reco interleave click',
      );
      return res.status(200).json({
        ok: true,
        attribution,
        was_exploration_slot: Boolean(metadata?.was_exploration_slot),
        rank_position: Number(metadata?.rank_position || 0),
      });
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err) }, 'aurora bff: reco interleave click failed');
      return res.status(500).json({ ok: false, error: 'RECO_INTERLEAVE_CLICK_FAILED' });
    }
  });

  app.get('/v1/reco/async-updates', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    if (!recoDogfoodConfig.dogfood_mode) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    try {
      const parsed = RecoAsyncUpdatesRequestSchema.safeParse({
        ticket_id: req.query.ticket_id,
        since_version: req.query.since_version,
      });
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          details: parsed.error.format(),
        });
      }
      const sinceVersionRaw = parsed.data.since_version;
      const sinceVersion = Number.isFinite(Number(sinceVersionRaw))
        ? Math.max(0, Math.trunc(Number(sinceVersionRaw)))
        : 0;
      const out = getAsyncUpdates({
        ticketId: parsed.data.ticket_id,
        sinceVersion,
      });
      if (!out.ok) {
        return res.status(404).json({
          ok: false,
          error: out.reason || 'TICKET_NOT_FOUND',
          version: Number(out.version || 0),
        });
      }
      const mode = 'main_path';
      for (const block of ['competitors', 'related_products', 'dupes']) {
        const patchRows = Array.isArray(out?.payload_patch?.[block]?.candidates)
          ? out.payload_patch[block].candidates
          : [];
        recordRecoAsyncUpdate({
          block,
          result: out.has_update ? 'applied' : 'noop',
          mode,
          changedCount: out.has_update ? patchRows.length : 0,
        });
      }
      return res.status(200).json(out);
    } catch (err) {
      logger?.warn?.(
        { err: err?.message || String(err), request_id: ctx.request_id },
        'aurora bff: reco async updates failed',
      );
      return res.status(500).json({ ok: false, error: 'RECO_ASYNC_UPDATES_FAILED' });
    }
  });
}

module.exports = {
  mountRecoDogfoodRoutes,
};
