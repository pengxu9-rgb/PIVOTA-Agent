const { z } = require('zod');
const {
  checkLoginGate,
  checkPhotoGate,
  runStage1,
  runDiagnosisV2,
} = require('./diagnosisV2Orchestrator');
const { DIAGNOSIS_V2_ENABLED } = require('./gating');
const { ThinkingStepEvent } = require('./diagnosisV2Schema');

const StartRequestSchema = z.object({
  goals: z.array(z.string()).min(1),
  custom_input: z.string().optional(),
  skip_login: z.boolean().default(false),
  language: z.enum(['EN', 'CN']).default('EN'),
});

const AnswerRequestSchema = z.object({
  goals: z.array(z.string()).min(1),
  custom_input: z.string().optional(),
  followup_answers: z.record(z.string(), z.any()).default({}),
  photo_findings: z.record(z.string(), z.any()).optional(),
  skip_photo: z.boolean().default(false),
  language: z.enum(['EN', 'CN']).default('EN'),
});

function extractAuroraUid(req) {
  return String(req.get('X-Aurora-UID') || req.get('x-aurora-uid') || '').trim() || null;
}

function extractAuthToken(req) {
  const auth = String(req.get('Authorization') || '').trim();
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return auth || null;
}

function buildCtxFromRequest(req, body) {
  return {
    userId: extractAuroraUid(req),
    authToken: extractAuthToken(req),
    language: body.language || 'EN',
    goals: body.goals,
    skipLogin: body.skip_login === true,
    profile: req._auroraProfile || {},
    recentLogs: req._auroraRecentLogs || [],
    currentRoutine: req._auroraCurrentRoutine || 'none',
    travelPlans: req._auroraTravelPlans || [],
    hasPhoto: Boolean(body.photo_findings && Object.keys(body.photo_findings).length > 0),
    hasExistingArtifact: Boolean(req._auroraLatestDiagnosisArtifact),
  };
}

function providerUnavailable(llmProvider) {
  return !llmProvider || typeof llmProvider.generate !== 'function' || llmProvider.isAvailable?.() === false;
}

function isProviderUnavailableError(err) {
  return err && (err.code === 'LLM_PROVIDER_UNAVAILABLE' || err.name === 'LlmProviderUnavailableError');
}

function classifyError(err) {
  if (!err) return { code: 'INTERNAL_ERROR', reason: 'unknown' };
  if (err.code === 'LLM_PROVIDER_UNAVAILABLE' || err.name === 'LlmProviderUnavailableError') {
    return { code: 'LLM_PROVIDER_UNAVAILABLE', reason: err.message };
  }
  if (err.code === 'LLM_PROVIDER_TIMEOUT') {
    return { code: 'LLM_TIMEOUT', reason: err.message };
  }
  if (err.validationErrors) {
    return { code: 'VALIDATION_FAILED', reason: 'result_schema_mismatch', details: err.validationErrors };
  }
  if (err.message?.includes('stage1') || err.message?.includes('Stage 1')) {
    return { code: 'STAGE1_FAILED', reason: err.message };
  }
  if (err.message?.includes('stage2') || err.message?.includes('Stage 2')) {
    return { code: 'STAGE2_FAILED', reason: err.message };
  }
  if (err.message?.includes('stage3') || err.message?.includes('Stage 3')) {
    return { code: 'STAGE3_FAILED', reason: err.message };
  }
  return { code: 'INTERNAL_ERROR', reason: err.message || 'unknown' };
}

function mountDiagnosisV2Routes(app, { logger, llmProvider }) {
  app.post('/v1/diagnosis/start', async (req, res) => {
    if (!DIAGNOSIS_V2_ENABLED) {
      return res.status(404).json({ ok: false, error: 'DIAGNOSIS_V2_NOT_ENABLED' });
    }

    const t0 = Date.now();
    try {
      const parsed = StartRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', details: parsed.error.issues });
      }

      const body = parsed.data;
      const ctx = buildCtxFromRequest(req, body);
      const loginCheck = checkLoginGate(ctx);
      if (loginCheck.needsLogin) {
        return res.status(200).json({
          ok: true,
          stage: 'login_prompt',
          card: {
            type: 'diagnosis_v2_login_prompt',
            payload: loginCheck.loginPromptPayload,
          },
        });
      }

      if (providerUnavailable(llmProvider)) {
        return res.status(503).json({ ok: false, error: 'LLM_PROVIDER_UNAVAILABLE' });
      }

      const stage1Result = await runStage1({
        goals: body.goals,
        customInput: body.custom_input,
        ctx,
        llmProvider,
      });

      logger?.info({ elapsed_ms: Date.now() - t0 }, 'diagnosis v2 start OK');
      return res.status(200).json({
        ok: true,
        stage: 'intro',
        card: {
          type: 'diagnosis_v2_intro',
          payload: stage1Result.introPayload,
        },
        is_cold_start: stage1Result.isColdStart,
      });
    } catch (err) {
      const classified = classifyError(err);
      logger?.error({ err: err.message, stack: err.stack, elapsed_ms: Date.now() - t0, ...classified }, 'diagnosis v2 start failed');
      if (isProviderUnavailableError(err)) {
        return res.status(503).json({ ok: false, error: 'LLM_PROVIDER_UNAVAILABLE' });
      }
      return res.status(500).json({ ok: false, error: classified.code, reason: classified.reason });
    }
  });

  app.post('/v1/diagnosis/answer', async (req, res) => {
    if (!DIAGNOSIS_V2_ENABLED) {
      return res.status(404).json({ ok: false, error: 'DIAGNOSIS_V2_NOT_ENABLED' });
    }

    const t0 = Date.now();
    try {
      const parsed = AnswerRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', details: parsed.error.issues });
      }

      const body = parsed.data;
      const ctx = buildCtxFromRequest(req, body);

      if (!body.skip_photo && !body.photo_findings) {
        const photoCheck = checkPhotoGate(ctx);
        if (photoCheck.needsPhoto) {
          return res.status(200).json({
            ok: true,
            stage: 'photo_prompt',
            card: {
              type: 'diagnosis_v2_photo_prompt',
              payload: photoCheck.photoPromptPayload,
            },
          });
        }
      }

      if (providerUnavailable(llmProvider)) {
        return res.status(503).json({ ok: false, error: 'LLM_PROVIDER_UNAVAILABLE' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendSse = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const onThinkingStep = (step) => {
        const validation = ThinkingStepEvent.safeParse(step);
        if (validation.success) {
          sendSse('thinking_step', validation.data);
        }
      };

      const result = await runDiagnosisV2({
        goals: body.goals,
        customInput: body.custom_input,
        followupAnswers: body.followup_answers,
        photoFindings: body.photo_findings || null,
        ctx,
        llmProvider,
        onThinkingStep,
      });

      sendSse('result', {
        ok: true,
        stage: 'result',
        card: {
          type: 'diagnosis_v2_result',
          payload: result.resultPayload,
        },
        session_patch: {
          meta: result.analysisContextSnapshot
            ? { analysis_context_snapshot: result.analysisContextSnapshot }
            : {},
        },
        warnings: result.warnings,
        prompt_version: result.promptVersion,
      });

      logger?.info({ elapsed_ms: Date.now() - t0 }, 'diagnosis v2 answer OK');
      res.write('event: done\ndata: {}\n\n');
      res.end();
    } catch (err) {
      const classified = classifyError(err);
      logger?.error({ err: err.message, stack: err.stack, elapsed_ms: Date.now() - t0, ...classified }, 'diagnosis v2 answer failed');

      if (isProviderUnavailableError(err)) {
        if (!res.headersSent) {
          return res.status(503).json({ ok: false, error: 'LLM_PROVIDER_UNAVAILABLE' });
        }
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'LLM_PROVIDER_UNAVAILABLE' })}\n\n`);
        res.end();
        return;
      }

      const ssePayload = { error: classified.code, reason: classified.reason };
      if (!res.headersSent) {
        return res.status(500).json({ ok: false, ...ssePayload });
      }

      try {
        res.write(`event: error\ndata: ${JSON.stringify(ssePayload)}\n\n`);
        res.end();
      } catch (_) {
        // Connection may already be closed.
      }
    }
  });

  app.post('/v1/diagnosis/blueprint-to-routine', async (req, res) => {
    if (!DIAGNOSIS_V2_ENABLED) {
      return res.status(404).json({ ok: false, error: 'DIAGNOSIS_V2_NOT_ENABLED' });
    }

    try {
      const body = req.body || {};
      const blueprint = body.routine_blueprint;
      const diagnosisId = body.diagnosis_id;

      if (!blueprint || !Array.isArray(blueprint.am_steps) || !Array.isArray(blueprint.pm_steps)) {
        return res.status(400).json({ ok: false, error: 'MISSING_BLUEPRINT' });
      }

      const routineSkeleton = {
        version: 'v2_from_diagnosis',
        diagnosis_id: diagnosisId || null,
        am: blueprint.am_steps.map((step, index) => ({
          position: index + 1,
          step_label: step,
          product: null,
          locked: false,
        })),
        pm: blueprint.pm_steps.map((step, index) => ({
          position: index + 1,
          step_label: step,
          product: null,
          locked: false,
        })),
        conflict_rules: blueprint.conflict_rules || [],
        created_at: new Date().toISOString(),
      };

      return res.status(200).json({
        ok: true,
        routine_skeleton: routineSkeleton,
        session_patch: {
          routine: routineSkeleton,
          diagnosis_id: diagnosisId || null,
          diagnosis_version: 'v2',
        },
        ops: {
          routine_patch: [{ op: 'replace', path: '/routine', value: routineSkeleton }],
        },
      });
    } catch (err) {
      logger?.error({ err: err.message }, 'blueprint-to-routine failed');
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  });

  app.post('/v1/diagnosis/route-action', async (req, res) => {
    if (!DIAGNOSIS_V2_ENABLED) {
      return res.status(404).json({ ok: false, error: 'DIAGNOSIS_V2_NOT_ENABLED' });
    }

    try {
      const { action_type, diagnosis_id, goal_profile, routine_blueprint, routine_skeleton } = req.body || {};
      if (!action_type) {
        return res.status(400).json({ ok: false, error: 'MISSING_ACTION_TYPE' });
      }

      const routeMap = {
        direct_reco: {
          redirect_to: '/v1/chat',
          action: {
            action_id: 'chip.start.reco_products',
            kind: 'chip',
            data: {
              trigger_source: 'diagnosis_v2',
              diagnosis_id,
              goal_profile,
              routine_blueprint,
              force_route: 'reco_products',
            },
          },
        },
        intake_optimize: {
          redirect_to: '/v1/chat',
          action: {
            action_id: 'chip.start.routine',
            kind: 'chip',
            data: {
              trigger_source: 'diagnosis_v2_intake',
              diagnosis_id,
              mode: 'intake_then_optimize',
            },
          },
        },
        setup_routine: {
          redirect_to: '/v1/chat',
          action: {
            action_id: 'chip.start.routine',
            kind: 'chip',
            data: {
              trigger_source: 'diagnosis_v2',
              diagnosis_id,
              routine_blueprint,
              routine_skeleton,
            },
          },
        },
        start_checkin: {
          redirect_to: '/v1/chat',
          action: {
            action_id: 'chip.start.checkin',
            kind: 'chip',
            data: {
              trigger_source: 'diagnosis_v2',
              diagnosis_id,
              setup_tracking: true,
            },
          },
        },
      };

      const route = routeMap[action_type];
      if (!route) {
        return res.status(400).json({ ok: false, error: 'UNKNOWN_ACTION_TYPE', action_type });
      }

      return res.status(200).json({ ok: true, ...route });
    } catch (err) {
      logger?.error({ err: err.message }, 'diagnosis route-action failed');
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  });

  app.post('/v1/diagnosis/bind-checkin', async (req, res) => {
    if (!DIAGNOSIS_V2_ENABLED) {
      return res.status(404).json({ ok: false, error: 'DIAGNOSIS_V2_NOT_ENABLED' });
    }

    try {
      const { diagnosis_id, routine_version_id, checkin_config } = req.body || {};
      if (!diagnosis_id) {
        return res.status(400).json({ ok: false, error: 'MISSING_DIAGNOSIS_ID' });
      }

      const binding = {
        diagnosis_id,
        routine_version_id: routine_version_id || null,
        created_at: new Date().toISOString(),
        checkin_schedule: {
          frequency_days: 1,
          duration_days: checkin_config?.duration_days || 7,
          indicators: ['redness', 'acne', 'dryness'],
          optional_indicators: ['sensation'],
          start_date: new Date().toISOString().split('T')[0],
        },
        actions_on_checkin: [
          { trigger: 'worsened_3_days', action: 'suggest_frequency_adjust' },
          { trigger: 'completed_7_days', action: 'suggest_rediagnosis' },
          { trigger: 'severe_report', action: 'suggest_product_swap' },
        ],
      };

      return res.status(200).json({
        ok: true,
        binding,
        session_patch: {
          checkin_binding: binding,
          last_checkin_setup_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger?.error({ err: err.message }, 'diagnosis bind-checkin failed');
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  });

  app.post('/v1/diagnosis/telemetry', async (req, res) => {
    if (!DIAGNOSIS_V2_ENABLED) {
      return res.status(404).json({ ok: false, error: 'DIAGNOSIS_V2_NOT_ENABLED' });
    }

    try {
      const events = Array.isArray(req.body?.events) ? req.body.events : [];
      const auroraUid = extractAuroraUid(req);
      const accepted = events
        .filter((event) => event && typeof event.event_name === 'string')
        .map((event) => ({
          event_name: event.event_name,
          diagnosis_id: event.diagnosis_id || null,
          aurora_uid: auroraUid,
          timestamp: event.timestamp || Date.now(),
          data: event.data || {},
        }));

      logger?.info({ count: accepted.length, user: auroraUid }, 'diagnosis v2 telemetry events received');
      return res.status(200).json({ ok: true, accepted: accepted.length });
    } catch (err) {
      logger?.error({ err: err.message }, 'diagnosis telemetry failed');
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  });
}

module.exports = { mountDiagnosisV2Routes };
