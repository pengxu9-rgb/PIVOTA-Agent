const { SkillRouter } = require('../orchestrator/skill_router');
const LlmGateway = require('../services/llm_gateway');
const { mapSkillResponseToChatCardsV1, mapSkillResponseToStreamEnvelope } = require('../mappers/card_mapper');
const { normalizeRoutineInputWithPmShortcut } = require('../routineState');
const { buildRequestContext } = require('../requestContext');

let routerSingleton = null;

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
}

function hasAuthorizationHeader(req) {
  const header =
    (typeof req?.get === 'function' ? req.get('authorization') || req.get('Authorization') : null) ||
    req?.headers?.authorization;
  return typeof header === 'string' && header.trim().length > 0;
}

function getRoutesInternal() {
  try {
    const routes = require('../routes');
    return routes && routes.__internal ? routes.__internal : {};
  } catch {
    return {};
  }
}

function mergeResponseMeta(payload, authMeta) {
  if (!isPlainObject(authMeta)) return payload;
  const base = isPlainObject(payload) ? { ...payload } : {};
  const meta = isPlainObject(base.meta) ? { ...base.meta } : {};
  meta.auth = authMeta;
  return {
    ...base,
    meta,
  };
}

async function resolveRequestIdentity(req) {
  const body = isPlainObject(req.body) ? req.body : {};
  const ctx = buildRequestContext(req, body);
  const helpers = hasAuthorizationHeader(req) ? getRoutesInternal() : {};
  if (!hasAuthorizationHeader(req) || typeof helpers.resolveIdentity !== 'function') {
    return { ctx };
  }
  try {
    req._identity = await helpers.resolveIdentity(req, ctx);
  } catch {
    // Ignore auth resolution failures here and let the route continue as guest.
  }
  return { ctx };
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

async function handleChat(req, res) {
  try {
    const auth = await resolveRequestIdentity(req);
    const skillRequest = buildSkillRequest(req);
    const skillResponse = await getRouter().route(skillRequest);
    res.json(mergeResponseMeta(mapSkillResponseToChatCardsV1(skillResponse), auth.ctx.auth_meta));
  } catch (error) {
    console.error('[chat] skill execution error:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'An error occurred processing your request.',
    });
  }
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
    const auth = await resolveRequestIdentity(req);
    const skillRequest = buildSkillRequest(req);
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
        sendEvent('result', mergeResponseMeta(mapSkillResponseToStreamEnvelope(event.data, thinkingSteps), auth.ctx.auth_meta));
      }
    });

    if (!resultSent) {
      sendEvent('result', mergeResponseMeta(mapSkillResponseToStreamEnvelope(skillResponse, thinkingSteps), auth.ctx.auth_meta));
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
      travel_plan: bodyContext.travel_plan || null,
      current_routine: currentRoutine,
      inventory: bodyContext.inventory || [],
      locale,
      safety_flags: bodyContext.safety_flags || [],
    },
    thread_state: body.thread_state || req._threadState || {},
  };
}

module.exports = {
  buildSkillRequest,
  handleChat,
  handleChatStream,
  __resetRouterForTests,
};
