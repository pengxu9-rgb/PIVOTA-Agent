const { SkillRouter } = require('../orchestrator/skill_router');
const LlmGateway = require('../services/llm_gateway');
const { mapSkillResponseToChatCardsV1, mapSkillResponseToStreamEnvelope } = require('../mappers/card_mapper');
const {
  extractTravelPlanFromMessage,
  hasCompleteTravelPlan,
  hasTravelCue,
  normalizeTravelPlan,
  resolveTravelPlanFromSources,
} = require('../travelPlanUtils');
const { normalizeRoutineInputWithPmShortcut } = require('../routineState');
const { buildChatCardsResponse } = require('../chatCardsAssembler');
const { runTravelPipeline } = require('../travelSkills/contracts');

let routerSingleton = null;
let travelPipelineImpl = runTravelPipeline;

const ANALYSIS_FOLLOWUP_ACTION_IDS_V2 = new Set([
  'chip.aurora.next_action.deep_dive_skin',
  'chip.aurora.next_action.ingredient_plan',
  'chip.aurora.next_action.routine_deep_dive',
  'chip.aurora.next_action.safety_concerns',
]);

const IMPLICIT_DEEP_DIVE_MESSAGES = new Set([
  'tell me more about my skin',
  'dive deeper into skin',
  'deep dive into skin',
  '深入了解我的皮肤状态',
  '深入了解皮肤状态',
]);

function toBool(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function createRouter() {
  const llmGateway = new LlmGateway({
    stubResponses: toBool(process.env.AURORA_CHAT_V2_STUB_RESPONSES),
  });
  return new SkillRouter(llmGateway);
}

function getRouter() {
  if (!routerSingleton) {
    routerSingleton = createRouter();
  }
  return routerSingleton;
}

function __resetRouterForTests() {
  routerSingleton = null;
  travelPipelineImpl = runTravelPipeline;
}

function __setRouterForTests(router) {
  routerSingleton = router || null;
}

function __setTravelPipelineForTests(fn) {
  travelPipelineImpl = typeof fn === 'function' ? fn : runTravelPipeline;
}

function normalizeLocaleToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const normalized = raw.replace(/_/g, '-');
  const lower = normalized.toLowerCase();

  if (lower === 'cn' || lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') {
    return 'zh-CN';
  }
  if (lower === 'en' || lower === 'en-us') {
    return 'en-US';
  }
  if (lower.startsWith('zh-') || lower.startsWith('en-')) {
    return normalized;
  }
  return raw;
}

function resolveRequestLocale(body, headers, bodyContext) {
  const rawLocale =
    (bodyContext && bodyContext.locale) ||
    body.locale ||
    body.language ||
    headers['accept-language']?.split(',')[0] ||
    'en';
  return normalizeLocaleToken(rawLocale) || 'en';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function compactStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function extractLastUserMessageFromMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!isPlainObject(row)) continue;
    const role = String(row.role || '').trim().toLowerCase();
    if (role && role !== 'user') continue;
    const content = pickFirstTrimmed(row.content, row.text, row.message);
    if (content) return content;
  }
  return null;
}

function extractLatestArtifactIdFromSession(session) {
  const state = isPlainObject(session && session.state) ? session.state : null;
  return pickFirstTrimmed(state && state.latest_artifact_id);
}

function omitLegacyActionAliases(value) {
  if (!isPlainObject(value)) return {};
  const next = { ...value };
  delete next.anchor;
  delete next.targets;
  return next;
}

function normalizeProfileShape(value) {
  if (!isPlainObject(value)) return {};

  const normalized = { ...value };
  const skinType = pickFirstTrimmed(value.skin_type, value.skinType);
  const concerns = compactStringArray(Array.isArray(value.concerns) ? value.concerns : value.goals);
  const goals = compactStringArray(Array.isArray(value.goals) ? value.goals : value.concerns);
  const sensitivity = pickFirstTrimmed(value.sensitivity, value.sensitivityLevel);
  const barrierStatus = pickFirstTrimmed(value.barrier_status, value.barrierStatus);
  const budgetTier = pickFirstTrimmed(value.budget_tier, value.budgetTier);
  const pregnancyStatus = pickFirstTrimmed(value.pregnancy_status, value.pregnancyStatus);

  if (skinType) {
    normalized.skin_type = skinType;
    normalized.skinType = normalized.skinType || skinType;
  }
  if (concerns.length > 0) normalized.concerns = concerns;
  if (goals.length > 0) normalized.goals = goals;
  if (sensitivity) normalized.sensitivity = sensitivity;
  if (barrierStatus) {
    normalized.barrier_status = barrierStatus;
    normalized.barrierStatus = normalized.barrierStatus || barrierStatus;
  }
  if (budgetTier) {
    normalized.budget_tier = budgetTier;
    normalized.budgetTier = normalized.budgetTier || budgetTier;
  }
  if (pregnancyStatus) {
    normalized.pregnancy_status = pregnancyStatus;
    normalized.pregnancyStatus = normalized.pregnancyStatus || pregnancyStatus;
  }

  return normalized;
}

function normalizeRoutineProducts(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeRoutineProducts(item))
      .flat()
      .filter((item) => isPlainObject(item));
  }

  if (typeof value === 'string') {
    const name = value.trim();
    return name ? [{ name }] : [];
  }

  if (!isPlainObject(value)) return [];

  if (Array.isArray(value.products)) {
    return normalizeRoutineProducts(value.products);
  }

  const name = pickFirstTrimmed(value.name, value.display_name, value.product_name, value.label, value.title, value.product);
  return name ? [{ ...value, name }] : [];
}

function coerceRoutineStepsFromSlots(value) {
  if (!isPlainObject(value)) return [];

  return Object.entries(value)
    .map(([stepId, rawValue]) => {
      const products = normalizeRoutineProducts(rawValue);
      if (products.length === 0) return null;
      return {
        step_id: stepId,
        products,
      };
    })
    .filter(Boolean);
}

function coerceRoutineStepsFromList(value, slot = 'am') {
  if (!Array.isArray(value)) return [];

  const steps = [];
  const byStepId = new Map();

  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const row = isPlainObject(entry) ? entry : null;
    const stepId = pickFirstTrimmed(
      row?.step_id,
      row?.step,
      row?.category,
      row?.routine_step,
      row?.routineStep,
      row?.type,
      `${slot}_step_${index + 1}`,
    );
    const products = normalizeRoutineProducts(row && Array.isArray(row.products) ? row.products : entry);
    if (!stepId || products.length === 0) continue;

    if (!byStepId.has(stepId)) {
      const step = { step_id: stepId, products: [] };
      byStepId.set(stepId, step);
      steps.push(step);
    }
    byStepId.get(stepId).products.push(...products);
  }

  return steps;
}

function coerceRoutineShape(value) {
  if (!value) return null;
  const resolved = normalizeRoutineInputWithPmShortcut(value);
  const candidate = resolved == null ? value : resolved;
  const routineId = pickFirstTrimmed(
    isPlainObject(candidate) ? candidate.routine_id : null,
    isPlainObject(value) ? value.routine_id : null,
  );
  const notesValue =
    isPlainObject(candidate) && candidate.notes != null
      ? candidate.notes
      : isPlainObject(value) && value.notes != null
        ? value.notes
        : null;

  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    try {
      return coerceRoutineShape(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  if (!isPlainObject(candidate)) return null;

  if (Array.isArray(candidate.am_steps) || Array.isArray(candidate.pm_steps)) {
    const amSource = Array.isArray(candidate.am_steps) && candidate.am_steps.length > 0
      ? candidate.am_steps
      : candidate.am;
    const pmSource = Array.isArray(candidate.pm_steps) && candidate.pm_steps.length > 0
      ? candidate.pm_steps
      : candidate.pm;
    return {
      ...candidate,
      ...(routineId ? { routine_id: routineId } : {}),
      am_steps: coerceRoutineStepsFromList(amSource, 'am'),
      pm_steps: coerceRoutineStepsFromList(pmSource, 'pm'),
      ...(notesValue != null ? { notes: notesValue } : {}),
    };
  }

  if (Array.isArray(candidate.am) || Array.isArray(candidate.pm)) {
    return {
      ...(routineId ? { routine_id: routineId } : {}),
      am_steps: coerceRoutineStepsFromList(candidate.am, 'am'),
      pm_steps: coerceRoutineStepsFromList(candidate.pm, 'pm'),
      ...(notesValue != null ? { notes: notesValue } : {}),
    };
  }

  if (isPlainObject(candidate.am) || isPlainObject(candidate.pm)) {
    return {
      ...(routineId ? { routine_id: routineId } : {}),
      am_steps: coerceRoutineStepsFromSlots(candidate.am),
      pm_steps: coerceRoutineStepsFromSlots(candidate.pm),
      ...(notesValue != null ? { notes: notesValue } : {}),
    };
  }

  return null;
}

function resolveCurrentRoutine(bodyContext, profileSources) {
  const directRoutine = coerceRoutineShape(bodyContext.current_routine);
  if (directRoutine) return directRoutine;

  for (const profile of profileSources) {
    const routine = coerceRoutineShape(
      isPlainObject(profile) ? (profile.currentRoutine ?? profile.current_routine ?? null) : null,
    );
    if (routine) return routine;
  }

  return null;
}

function resolveHeader(req, name) {
  if (req && typeof req.get === 'function') return req.get(name);
  const headers = req && req.headers && typeof req.headers === 'object' ? req.headers : {};
  return headers[name] || headers[name.toLowerCase()] || null;
}

function normalizeUiLanguage(value) {
  return String(value || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function buildTravelPipelineCanonicalIntent(skillRequest) {
  const travelPlan = normalizeTravelPlan(skillRequest?.context?.travel_plan);
  return {
    intent: 'travel_adjust',
    confidence: 1,
    entities: {
      destination: travelPlan?.destination || null,
      date_range: {
        start: travelPlan?.start_date || null,
        end: travelPlan?.end_date || null,
      },
    },
  };
}

function buildTravelPipelineResponse({ req, skillRequest, pipelineOut }) {
  const body = req.body || {};
  const requestId =
    pickFirstTrimmed(resolveHeader(req, 'x-request-id'), resolveHeader(req, 'x-requestid'))
    || `travel_${Date.now()}`;
  const traceId = pickFirstTrimmed(resolveHeader(req, 'x-trace-id')) || requestId;
  const lang = normalizeUiLanguage(body.language);
  const travelPlan = normalizeTravelPlan(skillRequest?.context?.travel_plan);
  const pendingTravelClarification =
    pipelineOut?.pending_clarification &&
    typeof pipelineOut.pending_clarification === 'object' &&
    !Array.isArray(pipelineOut.pending_clarification)
      ? pipelineOut.pending_clarification
      : null;
  const pipelinePatch =
    pipelineOut?.env_stress_patch &&
    typeof pipelineOut.env_stress_patch === 'object' &&
    !Array.isArray(pipelineOut.env_stress_patch)
      ? pipelineOut.env_stress_patch
      : {};
  const pipelineEpi = Number(pipelinePatch.epi);
  const envStressUi = {
    ...pipelinePatch,
    schema_version: 'aurora.ui.env_stress.v1',
    ess: Number.isFinite(pipelineEpi) ? pipelineEpi : null,
  };

  if (
    !pendingTravelClarification &&
    !envStressUi.travel_readiness &&
    pipelineOut?.travel_readiness &&
    typeof pipelineOut.travel_readiness === 'object' &&
    !Array.isArray(pipelineOut.travel_readiness)
  ) {
    envStressUi.travel_readiness = pipelineOut.travel_readiness;
  }

  const travelReadiness =
    envStressUi.travel_readiness &&
    typeof envStressUi.travel_readiness === 'object' &&
    !Array.isArray(envStressUi.travel_readiness)
      ? envStressUi.travel_readiness
      : null;

  const sessionPatch = {
    meta: {
      travel_skills_version: pipelineOut?.travel_skills_version || 'travel_skills_dag_v1',
      travel_skills_trace: Array.isArray(pipelineOut?.travel_skills_trace)
        ? pipelineOut.travel_skills_trace.slice(0, 24)
        : [],
      travel_kb_hit: Boolean(pipelineOut?.travel_kb_hit),
      travel_kb_write_queued: Boolean(pipelineOut?.travel_kb_write_queued),
      travel_skill_invocation_matrix:
        pipelineOut?.travel_skill_invocation_matrix &&
        typeof pipelineOut.travel_skill_invocation_matrix === 'object' &&
        !Array.isArray(pipelineOut.travel_skill_invocation_matrix)
          ? pipelineOut.travel_skill_invocation_matrix
          : {},
      env_source: pipelineOut?.env_source || null,
      degraded: Boolean(pipelineOut?.degraded),
      ...(pipelineOut?.travel_followup_state &&
      typeof pipelineOut.travel_followup_state === 'object' &&
      !Array.isArray(pipelineOut.travel_followup_state) &&
      !pendingTravelClarification
        ? { travel_followup: pipelineOut.travel_followup_state }
        : {}),
      ...(pendingTravelClarification ? { travel_pending_clarification: pendingTravelClarification } : {}),
    },
  };

  if (travelReadiness && !pendingTravelClarification) {
    sessionPatch.last_travel_readiness = {
      destination: travelReadiness.destination_context?.destination || null,
      start_date: travelReadiness.destination_context?.start_date || null,
      end_date: travelReadiness.destination_context?.end_date || null,
      reco_bundle: Array.isArray(travelReadiness.reco_bundle) ? travelReadiness.reco_bundle.slice(0, 5) : [],
      shopping_preview: travelReadiness.shopping_preview || null,
    };
  }

  const envelope = {
    request_id: requestId,
    trace_id: traceId,
    assistant_message: {
      role: 'assistant',
      content:
        typeof pipelineOut?.assistant_text === 'string' && pipelineOut.assistant_text.trim()
          ? pipelineOut.assistant_text.trim()
          : '',
      format: 'markdown',
    },
    suggested_chips:
      pendingTravelClarification && Array.isArray(pipelineOut?.suggested_chips)
        ? pipelineOut.suggested_chips.slice(0, 10)
        : [],
    cards:
      envStressUi && !pendingTravelClarification
        ? [{ card_id: `env_${requestId}`, type: 'env_stress', payload: envStressUi }]
        : [],
    session_patch: sessionPatch,
    events: [
      {
        event_name: 'travel_pipeline_routed',
        data: {
          env_source: pipelineOut?.env_source || null,
          degraded: Boolean(pipelineOut?.degraded),
          pending_clarification: Boolean(pendingTravelClarification),
        },
      },
    ],
    telemetry: {
      env_source: pipelineOut?.env_source || null,
      degraded: Boolean(pipelineOut?.degraded),
      intent_source: 'travel_pipeline_short_circuit',
      route_decision: 'travel_pipeline',
    },
  };

  return buildChatCardsResponse({
    envelope,
    ctx: {
      request_id: requestId,
      trace_id: traceId,
      lang,
      ui_lang: lang,
      match_lang: lang,
    },
    intent: 'travel_adjust',
    intentConfidence: 1,
    entities: [buildTravelPipelineCanonicalIntent(skillRequest).entities],
    safetyDecision: null,
    threadOps: [],
  });
}

async function maybeRunTravelPipeline(req, skillRequest) {
  const travelPlan = normalizeTravelPlan(skillRequest?.context?.travel_plan);
  const userMessage = pickFirstTrimmed(
    skillRequest?.params?.user_message,
    skillRequest?.params?.message,
    skillRequest?.params?.text,
  );

  if (!travelPlan || !hasCompleteTravelPlan(travelPlan) || !hasTravelCue(userMessage)) {
    return null;
  }

  const body = req.body || {};
  const session = isPlainObject(body.session) ? body.session : {};
  const sessionMeta = isPlainObject(session.meta) ? session.meta : {};
  const travelWeatherLiveEnabled = toBool(process.env.AURORA_TRAVEL_WEATHER_LIVE_ENABLED, false);
  const pipelineOut = await travelPipelineImpl({
    message: userMessage,
    language: normalizeUiLanguage(body.language),
    profile: skillRequest.context?.profile || {},
    recentLogs: skillRequest.context?.recent_logs || [],
    canonicalIntent: buildTravelPipelineCanonicalIntent(skillRequest),
    plannerDecision: {},
    chatContext: sessionMeta,
    travelWeatherLiveEnabled,
    openaiClient: null,
    logger: console,
    nowMs: Date.now(),
    userLocale: skillRequest.context?.locale || null,
    hasSafetyConflict: false,
  });

  if (!pipelineOut || pipelineOut.ok !== true) {
    return null;
  }

  return buildTravelPipelineResponse({ req, skillRequest, pipelineOut });
}

async function handleChat(req, res) {
  try {
    const skillRequest = buildSkillRequest(req);
    const travelResponse = await maybeRunTravelPipeline(req, skillRequest);
    if (travelResponse) {
      res.json(travelResponse);
      return;
    }
    const skillResponse = await getRouter().route(skillRequest);
    res.json(mapSkillResponseToChatCardsV1(skillResponse));
  } catch (error) {
    console.error('[chat] skill execution error:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'An error occurred processing your request.',
    });
  }
}

function resolveAnalysisFollowupActionId(req, internal = {}) {
  const body = req.body || {};
  const action = isPlainObject(body.action) ? body.action : {};
  const actionData = isPlainObject(action.data) ? action.data : {};
  const explicitActionId = pickFirstTrimmed(body.action_id, action.action_id, actionData.action_id);
  if (explicitActionId && ANALYSIS_FOLLOWUP_ACTION_IDS_V2.has(explicitActionId.trim())) {
    return { actionId: explicitActionId.trim(), routingMode: 'explicit' };
  }
  const session = isPlainObject(body.session) ? body.session : {};
  const sessionMeta = isPlainObject(session.meta) ? session.meta : {};
  const sessionAnalysisContext = isPlainObject(sessionMeta.analysis_context) ? sessionMeta.analysis_context : null;
  const message = pickFirstTrimmed(
    body.message,
    body.query,
    body.text,
    actionData.reply_text,
    actionData.replyText,
    extractLastUserMessageFromMessages(body.messages),
  );
  if (typeof internal.resolveImplicitAnalysisFollowupActionId === 'function') {
    const implicitActionId = internal.resolveImplicitAnalysisFollowupActionId({
      actionId: explicitActionId,
      message,
      sessionAnalysisContext,
      lastAnalysis: isPlainObject(session.profile) ? session.profile.lastAnalysis || null : null,
      latestArtifactId: extractLatestArtifactIdFromSession(session),
    });
    if (implicitActionId && ANALYSIS_FOLLOWUP_ACTION_IDS_V2.has(String(implicitActionId).trim())) {
      return { actionId: String(implicitActionId).trim(), routingMode: 'implicit' };
    }
  }
  return { actionId: null, routingMode: null };
}

async function handleChatStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (eventType, payload) => {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    let routes;
    try { routes = require('../routes'); } catch { routes = null; }
    const internal = routes && routes.__internal ? routes.__internal : {};
    const followupResolution = resolveAnalysisFollowupActionId(req, internal);
    const analysisFollowupActionId = followupResolution.actionId;
    if (analysisFollowupActionId) {
      sendEvent('thinking', { step: 'routing', message: 'Preparing follow-up analysis...' });
      const body = req.body || {};
      const action = isPlainObject(body.action) ? body.action : {};
      const actionData = isPlainObject(action.data) ? action.data : {};
      const session = isPlainObject(body.session) ? body.session : {};
      const sessionProfile = isPlainObject(session.profile) ? session.profile : {};
      const replyText = pickFirstTrimmed(
        actionData.reply_text,
        actionData.replyText,
        body.message,
        body.query,
        extractLastUserMessageFromMessages(body.messages),
      );

      const isDeepDive = analysisFollowupActionId === 'chip.aurora.next_action.deep_dive_skin';
      let followupResult;

      if (isDeepDive && typeof internal.buildAnalysisDeepDiveContentWithLlm === 'function') {
        const lastAnalysis = sessionProfile.lastAnalysis || null;
        const sessionMeta = isPlainObject(session.meta) ? session.meta : {};
        const sessionAnalysisContext = isPlainObject(sessionMeta.analysis_context) ? sessionMeta.analysis_context : null;
        let diagnosisArtifact = null;
        if (typeof internal.loadLatestDiagnosisArtifactForRoute === 'function') {
          diagnosisArtifact = await internal.loadLatestDiagnosisArtifactForRoute({
            identity: req._identity || {},
            session,
            ctx: { brief_id: session.brief_id || null, request_id: req.get?.('x-request-id') || null },
            logger: console,
          });
        }
        followupResult = await internal.buildAnalysisDeepDiveContentWithLlm({
          lastAnalysis,
          diagnosisArtifact,
          profile: sessionProfile,
          language: body.language || 'EN',
          requestId: req.get?.('x-request-id') || 'stream',
          replyText,
          actionData,
          sessionAnalysisContext,
          logger: console,
        });
      } else if (typeof internal.buildAnalysisFollowupContent === 'function') {
        followupResult = internal.buildAnalysisFollowupContent({
          actionId: analysisFollowupActionId,
          lastAnalysis: sessionProfile.lastAnalysis || null,
          language: body.language || 'EN',
          requestId: req.get?.('x-request-id') || 'stream',
          replyText,
        });
      }

      if (followupResult) {
        const requestId = pickFirstTrimmed(req.get?.('x-request-id'), req.get?.('x-requestid')) || `stream_${Date.now()}`;
        const traceId = pickFirstTrimmed(req.get?.('x-trace-id')) || requestId;
        const lang = pickFirstTrimmed(body.language) || 'EN';
        const legacyEnvelope = {
          request_id: requestId,
          trace_id: traceId,
          assistant_message: {
            role: 'assistant',
            content: followupResult.assistant_text || '',
            format: 'text',
          },
          suggested_chips: Array.isArray(followupResult.suggested_chips) ? followupResult.suggested_chips : [],
          cards: Array.isArray(followupResult.cards) ? followupResult.cards : [],
          session_patch: {},
          events: [
            {
              event_name: 'analysis_followup_action_routed',
              data: {
                action_id: analysisFollowupActionId,
                routing_mode: followupResolution.routingMode || 'explicit',
                used_last_analysis: Boolean(followupResult.used_last_analysis),
                missing_context: Boolean(followupResult.missing_context),
                fell_back_to_generic: false,
                ...(isDeepDive ? {
                  analysis_origin: followupResult.analysis_origin || null,
                  photo_ref_count: Number(followupResult.photo_ref_count || 0),
                  used_diagnosis_artifact: Boolean(followupResult.used_diagnosis_artifact),
                  used_analysis_story_snapshot: Boolean(followupResult.used_analysis_story_snapshot),
                  fell_back_to_snapshot: Boolean(followupResult.fell_back_to_snapshot),
                  llm_used: Boolean(followupResult.llm_used),
                } : {}),
              },
            },
          ],
        };
        const ctx = {
          request_id: requestId,
          trace_id: traceId,
          lang: lang === 'CN' ? 'CN' : 'EN',
          ui_lang: lang === 'CN' ? 'CN' : 'EN',
          match_lang: lang === 'CN' ? 'CN' : 'EN',
        };
        const v1Response = buildChatCardsResponse({
          envelope: legacyEnvelope,
          ctx,
          intent: 'analysis_followup',
          intentConfidence: 1,
          entities: [],
          safetyDecision: null,
          threadOps: [],
        });
        sendEvent('result', v1Response);
        sendEvent('done', {});
        return;
      }
    }
    const skillRequest = buildSkillRequest(req);
    const travelResponse = await maybeRunTravelPipeline(req, skillRequest);
    if (travelResponse) {
      sendEvent('thinking', { step: 'travel_context', message: 'Checking destination conditions...' });
      sendEvent('result', travelResponse);
      sendEvent('done', {});
      return;
    }
    const thinkingSteps = [];
    let resultSent = false;

    const skillResponse = await getRouter().routeStream(skillRequest, (event) => {
      if (event.type === 'thinking') {
        thinkingSteps.push({ step: event.step, message: event.message });
        sendEvent('thinking', { step: event.step, message: event.message });
        return;
      }
      if (event.type === 'chunk') {
        sendEvent('chunk', { text: event.text });
        return;
      }
      if (event.type === 'result') {
        resultSent = true;
        sendEvent('result', mapSkillResponseToStreamEnvelope(event.data, thinkingSteps));
      }
    });

    if (!resultSent) {
      sendEvent('result', mapSkillResponseToStreamEnvelope(skillResponse, thinkingSteps));
    }
    sendEvent('done', {});
  } catch (error) {
    console.error('[chat/stream] error:', error);
    sendEvent('error', { message: 'An error occurred processing your request.' });
    sendEvent('done', {});
  } finally {
    res.end();
  }
}

function buildSkillRequest(req) {
  const body = req.body || {};
  const bodyContext = isPlainObject(body.context) ? body.context : {};
  const bodyParams = isPlainObject(body.params) ? body.params : {};
  const session = isPlainObject(body.session) ? body.session : {};
  const sessionProfile = isPlainObject(session.profile) ? session.profile : null;
  const action = isPlainObject(body.action) ? body.action : {};
  const actionData = isPlainObject(action.data) ? action.data : {};
  const normalizedActionData = omitLegacyActionAliases(actionData);
  const actionId = pickFirstTrimmed(body.action_id, action.action_id);
  const userMessage = pickFirstTrimmed(
    body.message,
    body.text,
    bodyParams.user_message,
    bodyParams.message,
    bodyParams.text,
    actionData.reply_text,
    actionData.replyText,
  );
  const priorMessages = Array.isArray(body.messages) ? body.messages : [];
  const locale = resolveRequestLocale(body, req.headers || {}, bodyContext);
  const resolvedProfile = normalizeProfileShape(bodyContext.profile || req._userProfile || sessionProfile || {});
  const currentRoutine = resolveCurrentRoutine(bodyContext, [
    bodyContext.profile,
    req._userProfile,
    sessionProfile,
  ]);
  const resolvedTravelPlan = resolveTravelPlanFromSources(
    bodyContext.travel_plan,
    session.travel_plan,
    sessionProfile?.travel_plan,
    extractTravelPlanFromMessage(userMessage),
  );
  const anchorProductId = pickFirstTrimmed(
    body.anchor_product_id,
    body.anchorProductId,
    bodyParams.anchor_product_id,
    normalizedActionData.anchor_product_id,
  );
  const anchorProductUrl = pickFirstTrimmed(
    body.anchor_product_url,
    body.anchorProductUrl,
    bodyParams.anchor_product_url,
    normalizedActionData.anchor_product_url,
  );
  const productAnchor = isPlainObject(bodyParams.product_anchor)
    ? bodyParams.product_anchor
    : isPlainObject(normalizedActionData.product_anchor)
      ? normalizedActionData.product_anchor
      : null;

  const baseThreadState = body.thread_state || req._threadState || {};
  const threadState = resolvedTravelPlan
    ? { ...baseThreadState, travel_plan: resolvedTravelPlan }
    : baseThreadState;
  const comparisonTargets =
    Array.isArray(bodyParams.comparison_targets) ? bodyParams.comparison_targets
    : Array.isArray(normalizedActionData.comparison_targets) ? normalizedActionData.comparison_targets
    : null;

  const normalizedBodyParams = omitLegacyActionAliases(bodyParams);

  return {
    skill_id: body.skill_id || null,
    skill_version: body.skill_version || '1.0.0',
    intent: body.intent || body.canonical_intent || null,
    params: {
      ...normalizedActionData,
      ...normalizedBodyParams,
      entry_source: body.entry_source || body.trigger_source || bodyParams.entry_source || actionId || null,
      user_message: userMessage,
      message: userMessage,
      text: userMessage,
      ...(productAnchor ? { product_anchor: productAnchor } : {}),
      ...(comparisonTargets ? { comparison_targets: comparisonTargets } : {}),
      ...(anchorProductId ? { anchor_product_id: anchorProductId } : {}),
      ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
      ...(priorMessages.length > 0 ? { messages: priorMessages } : {}),
    },
    context: {
      profile: resolvedProfile,
      recent_logs: bodyContext.recent_logs || req._recentLogs || [],
      travel_plan: resolvedTravelPlan,
      current_routine: currentRoutine,
      inventory: bodyContext.inventory || [],
      locale,
      safety_flags: bodyContext.safety_flags || [],
    },
    thread_state: threadState,
  };
}

module.exports = {
  buildSkillRequest,
  buildTravelPipelineResponse,
  extractTravelPlanFromMessage,
  handleChat,
  handleChatStream,
  __resetRouterForTests,
  __setRouterForTests,
  __setTravelPipelineForTests,
  normalizeTravelPlan,
};
