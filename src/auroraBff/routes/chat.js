const { SkillRouter } = require('../orchestrator/skill_router');
const LlmGateway = require('../services/llm_gateway');
const { mapSkillResponseToChatCardsV1, mapSkillResponseToStreamEnvelope } = require('../mappers/card_mapper');
const { buildPromptMetaForChatRequest, mergePromptMeta } = require('../../modules/contracts/auroraPromptMeta');
const { normalizeRoutineInputWithPmShortcut } = require('../routineState');
const { buildChatCardsResponse } = require('../chatCardsAssembler');
const { buildRequestContext } = require('../requestContext');
const { computeAuroraChatRolloutContext } = require('../rollout');
const { GATE_POLICY_VERSION: AURORA_GATE_POLICY_META_VERSION } = require('../gatePolicyRegistry');
const { shouldProxyFrameworkRecoToV1Mainline } = require('../recoOwnershipPolicy');
const { attachBeautyExpertV1ToResponse } = require('../../modules/orchestration/aurora_beauty/beautyExpertV1');

const ANALYSIS_FOLLOWUP_ACTION_IDS_V2 = new Set([
  'chip.aurora.next_action.deep_dive_skin',
  'chip.aurora.next_action.ingredient_plan',
  'chip.aurora.next_action.routine_deep_dive',
  'chip.aurora.next_action.safety_concerns',
]);

let routerSingleton = null;
let invokeV1MainlineChatImpl = invokeV1MainlineChat;

function toBool(value, fallback = false) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function parseTimeoutMsValue(rawValue, fallbackMs) {
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.trunc(parsed));
  return Math.max(1, Math.trunc(Number(fallbackMs) || 1));
}

function getAuroraChatRequestIdentityTimeoutMs() {
  return parseTimeoutMsValue(process.env.AURORA_CHAT_REQUEST_IDENTITY_TIMEOUT_MS, 2500);
}

function getAuroraV1MainlineProxyTimeoutMs() {
  return parseTimeoutMsValue(process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS, 25000);
}

function withTimeoutCode(promise, timeoutMs, timeoutCode, status = 504) {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms) return Promise.resolve(promise);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutCode || 'timeout');
      err.code = timeoutCode || 'TIMEOUT';
      err.status = status;
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function markAuthMetaUnavailable(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  ctx.auth_meta = {
    state: 'unavailable',
    user: { email: null },
    expires_at: null,
  };
}

const AURORA_CHAT_POLICY_VERSION = String(process.env.AURORA_CHAT_POLICY_VERSION || 'aurora_chat_v2_p0').trim();
const AURORA_PROFILE_V2_ENABLED = toBool(process.env.AURORA_PROFILE_V2_ENABLED, false);
const AURORA_QA_PLANNER_V1_ENABLED = toBool(process.env.AURORA_QA_PLANNER_V1_ENABLED, false);
const AURORA_SAFETY_ENGINE_V1_ENABLED = toBool(process.env.AURORA_SAFETY_ENGINE_V1_ENABLED, false);
const AURORA_TRAVEL_WEATHER_LIVE_ENABLED = toBool(process.env.AURORA_TRAVEL_WEATHER_LIVE_ENABLED, false);
const AURORA_LOOP_BREAKER_V2_ENABLED = toBool(process.env.AURORA_LOOP_BREAKER_V2_ENABLED, false);
const AURORA_CHAT_RESPONSE_META_ENABLED = toBool(process.env.AURORA_CHAT_RESPONSE_META_ENABLED, false);
const AURORA_CHAT_SKILL_ROUTER_V2_ENABLED = toBool(process.env.AURORA_CHAT_SKILL_ROUTER_V2, true);
const AURORA_CHAT_GLOBAL_FLAGS = Object.freeze({
  profile_v2: AURORA_PROFILE_V2_ENABLED,
  qa_planner_v1: AURORA_QA_PLANNER_V1_ENABLED,
  safety_engine_v1: AURORA_SAFETY_ENGINE_V1_ENABLED,
  travel_weather_live_v1: AURORA_TRAVEL_WEATHER_LIVE_ENABLED,
  loop_breaker_v2: AURORA_LOOP_BREAKER_V2_ENABLED,
  skill_router_v2: AURORA_CHAT_SKILL_ROUTER_V2_ENABLED,
  chat_response_meta: AURORA_CHAT_RESPONSE_META_ENABLED,
});

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

function __setRouterForTests(router) {
  routerSingleton = router || null;
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

function canProxyRecoToV1Mainline() {
  if (invokeV1MainlineChatImpl !== invokeV1MainlineChat) return true;
  const routesInternal = getRoutesInternal();
  return typeof routesInternal.hasMountedV1ChatMainlineHandler === 'function'
    ? routesInternal.hasMountedV1ChatMainlineHandler() === true
    : false;
}

function buildLoopbackChatBaseUrl(req) {
  const forwardedProto = typeof req?.get === 'function' ? req.get('x-forwarded-proto') : null;
  const proto = pickFirstTrimmed(forwardedProto, req?.protocol, 'http') || 'http';
  const forwardedHost = typeof req?.get === 'function' ? req.get('x-forwarded-host') : null;
  const host = pickFirstTrimmed(forwardedHost, typeof req?.get === 'function' ? req.get('host') : null, req?.headers?.host);
  if (host) return `${proto}://${host}`;
  const port = pickFirstTrimmed(process.env.PORT);
  return port ? `http://127.0.0.1:${port}` : null;
}

function buildLoopbackChatHeaders(req) {
  const out = {};
  const source = req?.headers && typeof req.headers === 'object' ? req.headers : {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const lowered = key.toLowerCase();
    if (
      lowered === 'host' ||
      lowered === 'content-length' ||
      lowered === 'connection' ||
      lowered === 'accept-encoding'
    ) {
      continue;
    }
    out[key] = rawValue;
  }
  out.accept = 'application/json';
  out['content-type'] = 'application/json';
  return out;
}

function normalizeIncomingChatAction(action) {
  if (typeof action === 'string') {
    const trimmed = action.trim();
    return trimmed || null;
  }
  if (!isPlainObject(action)) return null;
  const data = isPlainObject(action.data) ? action.data : null;
  const actionId = pickFirstTrimmed(
    action.action_id,
    action.id,
    data && data.action_id,
    data && data.aurora_action_id,
    action.type,
  );
  const kindValue = pickFirstTrimmed(action.kind, action.type);
  const normalizedKind = kindValue
    ? /(^|[._-])chip([._-]|$)/i.test(kindValue)
      ? 'chip'
      : 'action'
    : null;
  return {
    ...(actionId ? { action_id: actionId } : {}),
    ...(normalizedKind ? { kind: normalizedKind } : {}),
    ...(data ? { data } : {}),
  };
}

async function invokeV1MainlineChat({ req, body } = {}) {
  const routesInternal = getRoutesInternal();
  if (typeof routesInternal.runV1ChatMainlineInProcess === 'function') {
    try {
      return await routesInternal.runV1ChatMainlineInProcess({ req, body });
    } catch (error) {
      if (String(error?.message || '') !== 'v1_chat_mainline_handler_unmounted') throw error;
    }
  }
  const baseUrl = buildLoopbackChatBaseUrl(req);
  if (!baseUrl) throw new Error('loopback_chat_base_missing');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = getAuroraV1MainlineProxyTimeoutMs();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    let resp;
    try {
      resp = await fetch(`${baseUrl}/v1/chat`, {
        method: 'POST',
        headers: buildLoopbackChatHeaders(req),
        body: JSON.stringify(body || {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        const timeoutError = new Error('AURORA_V1_MAINLINE_TIMEOUT');
        timeoutError.code = 'AURORA_V1_MAINLINE_TIMEOUT';
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    }
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error(`v1_chat_loopback_failed_${Number(resp?.status) || 500}`);
      error.status = Number(resp?.status) || 500;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invokeBoundedV1MainlineChat(params) {
  return withTimeoutCode(
    Promise.resolve().then(() => invokeV1MainlineChatImpl(params)),
    getAuroraV1MainlineProxyTimeoutMs(),
    'AURORA_V1_MAINLINE_TIMEOUT',
  );
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

function setResponseHeader(res, name, value) {
  if (!res || value == null) return;
  const normalizedValue = String(value);
  if (typeof res.setHeader === 'function') {
    res.setHeader(name, normalizedValue);
    return;
  }
  if (typeof res.set === 'function') {
    res.set(name, normalizedValue);
    return;
  }
  if (isPlainObject(res.headers)) {
    res.headers[name.toLowerCase()] = normalizedValue;
  }
}

function applyRolloutMeta(payload, { req, ctx, body, identity, res } = {}) {
  const base = isPlainObject(payload) ? { ...payload } : {};
  const rolloutContext = computeAuroraChatRolloutContext({
    req,
    ctx,
    body,
    identity,
    globalFlags: AURORA_CHAT_GLOBAL_FLAGS,
    policyVersion: AURORA_CHAT_POLICY_VERSION,
  });
  const effectiveFlags = isPlainObject(rolloutContext && rolloutContext.effective_flags)
    ? rolloutContext.effective_flags
    : AURORA_CHAT_GLOBAL_FLAGS;
  const rolloutMeta = {
    ...(isPlainObject(base.meta) ? base.meta : {}),
    policy_version: rolloutContext.policy_version || AURORA_CHAT_POLICY_VERSION,
    rollout_variant: rolloutContext.variant || 'legacy',
    rollout_bucket: Number.isFinite(Number(rolloutContext.bucket)) ? Number(rolloutContext.bucket) : null,
    rollout_bucket_key_source: rolloutContext.bucket_key_source || null,
    rollout_forced_variant: rolloutContext.forced_variant || null,
    rollout_applied: Boolean(rolloutContext.applied),
    build_sha: rolloutContext.build_sha || null,
    flags_effective: {
      profile_v2: Boolean(effectiveFlags.profile_v2),
      qa_planner_v1: Boolean(effectiveFlags.qa_planner_v1),
      safety_engine_v1: Boolean(effectiveFlags.safety_engine_v1),
      travel_weather_live_v1: Boolean(effectiveFlags.travel_weather_live_v1),
      loop_breaker_v2: Boolean(effectiveFlags.loop_breaker_v2),
      skill_router_v2: Boolean(effectiveFlags.skill_router_v2),
      chat_response_meta: Boolean(effectiveFlags.chat_response_meta),
    },
    gate_policy_version: AURORA_GATE_POLICY_META_VERSION,
  };

  setResponseHeader(
    res,
    'x-aurora-bucket',
    String(Number.isFinite(Number(rolloutContext.bucket)) ? Number(rolloutContext.bucket) : 0),
  );
  setResponseHeader(res, 'x-aurora-variant', String(rolloutContext.variant || 'legacy'));
  setResponseHeader(
    res,
    'x-aurora-policy-version',
    String(rolloutContext.policy_version || rolloutMeta.policy_version || 'legacy'),
  );

  const out = {
    ...base,
    meta: rolloutMeta,
  };

  const sessionPatch = isPlainObject(base.session_patch)
    ? { ...base.session_patch }
    : isPlainObject(base.sessionPatch)
      ? { ...base.sessionPatch }
      : null;
  if (sessionPatch) {
    const sessionMeta = isPlainObject(sessionPatch.meta) ? { ...sessionPatch.meta } : {};
    sessionPatch.meta = { ...sessionMeta, ...rolloutMeta };
    if (isPlainObject(base.session_patch)) out.session_patch = sessionPatch;
    else out.sessionPatch = sessionPatch;
  }

  return out;
}

async function resolveRequestIdentity(req, internal = null) {
  const body = isPlainObject(req.body) ? req.body : {};
  const ctx = buildRequestContext(req, body);
  const helpers = internal || (hasAuthorizationHeader(req) ? getRoutesInternal() : {});
  if (!hasAuthorizationHeader(req) || typeof helpers.resolveIdentity !== 'function') {
    return { ctx, internal: helpers };
  }
  try {
    req._identity = await withTimeoutCode(
      Promise.resolve().then(() => helpers.resolveIdentity(req, ctx)),
      getAuroraChatRequestIdentityTimeoutMs(),
      'AURORA_IDENTITY_TIMEOUT',
    );
  } catch (error) {
    if (error && error.code === 'AURORA_IDENTITY_TIMEOUT') {
      markAuthMetaUnavailable(ctx);
    }
    // Ignore auth resolution failures here and let the route continue as guest.
  }
  return { ctx, internal: helpers };
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

function normalizeTravelPlanShape(value) {
  if (!isPlainObject(value)) return null;

  const normalized = { ...value };
  const destinationPlace = isPlainObject(value.destination_place)
    ? value.destination_place
    : isPlainObject(value.destinationPlace)
      ? value.destinationPlace
      : null;
  const departurePlace = isPlainObject(value.departure_place)
    ? value.departure_place
    : isPlainObject(value.departurePlace)
      ? value.departurePlace
      : null;
  const rawDates = isPlainObject(value.dates) ? value.dates : null;

  const destination = pickFirstTrimmed(
    value.destination,
    value.destination_name,
    value.destinationName,
    destinationPlace && destinationPlace.canonical_name,
    destinationPlace && destinationPlace.label,
  );
  const departureRegion = pickFirstTrimmed(
    value.departure_region,
    value.departureRegion,
    departurePlace && departurePlace.canonical_name,
    departurePlace && departurePlace.label,
  );
  const startDate = pickFirstTrimmed(
    value.start_date,
    value.startDate,
    rawDates && rawDates.start,
    rawDates && rawDates.start_date,
  );
  const endDate = pickFirstTrimmed(
    value.end_date,
    value.endDate,
    rawDates && rawDates.end,
    rawDates && rawDates.end_date,
  );

  if (destination) normalized.destination = destination;
  if (departureRegion) {
    normalized.departure_region = departureRegion;
    if (!normalized.departureRegion) normalized.departureRegion = departureRegion;
  }
  if (destinationPlace) normalized.destination_place = destinationPlace;
  if (departurePlace) normalized.departure_place = departurePlace;
  if (startDate) {
    normalized.start_date = startDate;
    if (!normalized.startDate) normalized.startDate = startDate;
  }
  if (endDate) {
    normalized.end_date = endDate;
    if (!normalized.endDate) normalized.endDate = endDate;
  }
  if (rawDates || startDate || endDate) {
    normalized.dates = {
      ...(rawDates || {}),
      ...(startDate ? { start: startDate, start_date: startDate } : {}),
      ...(endDate ? { end: endDate, end_date: endDate } : {}),
    };
  }

  return normalized;
}

function resolveTravelPlanContext(bodyContext, profiles = []) {
  const directCandidates = [
    bodyContext && bodyContext.travel_plan,
    bodyContext && bodyContext.travelPlan,
  ];
  const profileCandidates = [];

  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!isPlainObject(profile)) continue;
    profileCandidates.push(profile.travel_plan, profile.travelPlan);
    if (Array.isArray(profile.travel_plans) && profile.travel_plans.length > 0) {
      profileCandidates.push(profile.travel_plans[0]);
    }
    if (Array.isArray(profile.travelPlans) && profile.travelPlans.length > 0) {
      profileCandidates.push(profile.travelPlans[0]);
    }
  }

  const candidates = [...directCandidates, ...profileCandidates];
  for (const candidate of candidates) {
    const normalized = normalizeTravelPlanShape(candidate);
    if (normalized) return normalized;
  }
  return null;
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

function readProductIdentity(value) {
  const product = isPlainObject(value) ? value : {};
  const productId = pickFirstTrimmed(product.product_id, product.productId, product.sku_id, product.skuId);
  const url = pickFirstTrimmed(product.url, product.product_url, product.productUrl, product.pdp_url, product.pdpUrl);
  const brand = pickFirstTrimmed(product.brand);
  const name = pickFirstTrimmed(product.display_name, product.displayName, product.name, product.title, product.product_name, product.productName);
  return { productId, url, brand, name };
}

function hasNonEmptyProductAnchor(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function extractProductInputFromFitCheckCompat(message, internal = {}) {
  if (typeof internal.extractProductInputFromFitCheckText === 'function') {
    const extracted = pickFirstTrimmed(internal.extractProductInputFromFitCheckText(message));
    if (extracted) return extracted;
  }

  const raw = String(message || '').trim();
  if (!raw) return '';
  const suffix = raw.match(/[:：]\s*([^:：]{2,400})\s*$/);
  return suffix && suffix[1] ? String(suffix[1]).trim() : raw;
}

function enrichProductAnalyzeRequestForCompat(skillRequest, internal = {}) {
  const params = isPlainObject(skillRequest && skillRequest.params) ? skillRequest.params : {};
  const message = pickFirstTrimmed(params.user_message, params.message, params.text);
  if (!message) return skillRequest;

  const skillId = pickFirstTrimmed(skillRequest && skillRequest.skill_id);
  const intent = pickFirstTrimmed(skillRequest && skillRequest.intent);
  const entrySource = pickFirstTrimmed(params.entry_source);
  const explicitProductAnchor = hasNonEmptyProductAnchor(params.product_anchor) ? params.product_anchor : null;
  const anchorProductId = pickFirstTrimmed(params.anchor_product_id);
  const anchorProductUrl = pickFirstTrimmed(params.anchor_product_url);
  const isProductAnalyzeRequest =
    skillId === 'product.analyze' ||
    intent === 'evaluate_product' ||
    intent === 'product_analysis' ||
    (typeof internal.looksLikeProductEvaluationIntentV2 === 'function' &&
      internal.looksLikeProductEvaluationIntentV2(message, entrySource));
  if (!isProductAnalyzeRequest) return skillRequest;

  const hasMeaningfulAnchor =
    Boolean(explicitProductAnchor) ||
    (typeof internal.hasMeaningfulFitCheckAnchor === 'function'
      ? internal.hasMeaningfulFitCheckAnchor({
          message,
          anchorProductId,
          anchorProductUrl,
        })
      : Boolean(anchorProductId || anchorProductUrl));
  if (!hasMeaningfulAnchor) return skillRequest;

  let productAnchor = explicitProductAnchor ? { ...explicitProductAnchor } : null;
  if (!productAnchor) {
    const extractedInput = extractProductInputFromFitCheckCompat(message, internal);
    const derivedName = /^https?:\/\//i.test(String(extractedInput || '').trim()) ? null : pickFirstTrimmed(extractedInput);
    productAnchor = {
      ...(anchorProductId ? { product_id: anchorProductId, sku_id: anchorProductId } : {}),
      ...(anchorProductUrl ? { url: anchorProductUrl } : {}),
      ...(derivedName ? { name: derivedName } : {}),
    };
  } else if (anchorProductUrl && !pickFirstTrimmed(productAnchor.url, productAnchor.product_url, productAnchor.productUrl)) {
    productAnchor = { ...productAnchor, url: anchorProductUrl };
  }

  if (!hasNonEmptyProductAnchor(productAnchor)) return skillRequest;

  return {
    ...skillRequest,
    skill_id: skillId || 'product.analyze',
    intent: intent || 'evaluate_product',
    params: {
      ...params,
      product_anchor: productAnchor,
    },
  };
}

function buildCandidateIdentityKey(value) {
  const identity = readProductIdentity(value);
  const productId = identity.productId ? String(identity.productId).trim().toLowerCase() : '';
  if (productId) return `id:${productId}`;
  const url = identity.url ? String(identity.url).trim().toLowerCase() : '';
  if (url) return `url:${url}`;
  const brand = identity.brand ? String(identity.brand).trim().toLowerCase() : '';
  const name = identity.name ? String(identity.name).trim().toLowerCase() : '';
  if (brand || name) return `name:${brand}::${name}`;
  return '';
}

function joinBrandAndName(brandRaw, nameRaw) {
  const brand = String(brandRaw || '').trim();
  const name = String(nameRaw || '').trim();
  if (!brand) return name;
  if (!name) return brand;
  const brandLower = brand.toLowerCase();
  const nameLower = name.toLowerCase();
  if (nameLower === brandLower || nameLower.startsWith(`${brandLower} `)) return name;
  return `${brand} ${name}`.trim();
}

function stripLeadingBrandFromName(nameRaw, brandRaw) {
  const name = String(nameRaw || '').trim();
  const brand = String(brandRaw || '').trim();
  if (!name || !brand) return name;
  const nameLower = name.toLowerCase();
  const brandLower = brand.toLowerCase();
  if (nameLower === brandLower) return name;
  if (nameLower.startsWith(`${brandLower} `)) {
    return name.slice(brand.length).trim() || name;
  }
  return name;
}

function buildCompatNameVariants(nameRaw, productTypeRaw) {
  const base = String(nameRaw || '').trim();
  const productType = String(productTypeRaw || '').trim().toLowerCase();
  if (!base) return [];

  const out = [];
  const seen = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  add(base);
  if (/\bcreme\b/i.test(base)) add(base.replace(/\bcreme\b/gi, 'cream'));

  if (productType === 'moisturizer' || productType === 'moisturiser') {
    if (/\bcreme\b/i.test(base) || /\bcream\b/i.test(base)) {
      add('moisturizing cream');
    } else if (!/\bmoisturizer\b/i.test(base)) {
      add(`${base} moisturizer`);
    }
  }

  return out;
}

function normalizeProductCatalogQuery(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  try {
    text = decodeURIComponent(text);
  } catch {
    // Ignore malformed URI fragments in best-effort compat parsing.
  }
  text = text
    .replace(/\+/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/[|]+/g, ' ')
    .replace(/\.(html?|php|aspx?)$/i, ' ')
    .replace(/\b(en|cn|zh|us|uk|jp|kr|fr|de|es|pt|it|ca|au)\b/gi, ' ')
    .replace(/\b(product|products|item|items)\b/gi, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 160) text = text.slice(0, 160).trim();
  return text;
}

function extractProductCatalogQueryFromUrl(rawUrl) {
  const urlText = String(rawUrl || '').trim();
  if (!urlText) return null;

  let parsed = null;
  try {
    parsed = new URL(urlText);
  } catch {
    return null;
  }

  const hostLabels = String(parsed.hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .map((value) => value.trim())
    .filter(Boolean);
  const hostStop = new Set(['com', 'net', 'org', 'co', 'io', 'ai', 'shop', 'store', 'www', 'cn', 'cc', 'us', 'uk']);
  const hostToken = normalizeProductCatalogQuery(hostLabels.filter((value) => !hostStop.has(value)).join(' '));

  const pathTokens = String(parsed.pathname || '')
    .split('/')
    .map((value) => normalizeProductCatalogQuery(value))
    .filter(Boolean);
  const tailToken = normalizeProductCatalogQuery(pathTokens.slice(-2).join(' '));
  const bestPathToken = pathTokens
    .filter((value) => value && !/^\d+$/.test(value))
    .sort((left, right) => right.length - left.length)[0] || '';
  const queryToken = normalizeProductCatalogQuery(
    parsed.searchParams.get('product') ||
      parsed.searchParams.get('name') ||
      parsed.searchParams.get('title') ||
      parsed.searchParams.get('sku') ||
      '',
  );

  return {
    raw_url: urlText,
    host_token: hostToken,
    tail_token: tailToken,
    best_path_token: bestPathToken,
    query_token: queryToken,
  };
}

function buildCompatProductCatalogQueries({ inputText, inputUrl, productAnchor } = {}) {
  const out = [];
  const seen = new Set();
  const add = (value, { normalize = true } = {}) => {
    let text = String(value || '').trim();
    if (!text) return;
    if (normalize) text = normalizeProductCatalogQuery(text);
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  const productIdentity = readProductIdentity(productAnchor);
  const product = isPlainObject(productAnchor) ? productAnchor : {};
  const productType = pickFirstTrimmed(
    product.product_type,
    product.productType,
    product.category,
    product.category_name,
    product.type,
  );
  const shortName = pickFirstTrimmed(
    stripLeadingBrandFromName(product.display_name, productIdentity.brand),
    stripLeadingBrandFromName(product.displayName, productIdentity.brand),
    stripLeadingBrandFromName(product.name, productIdentity.brand),
    stripLeadingBrandFromName(product.title, productIdentity.brand),
    stripLeadingBrandFromName(product.product_name, productIdentity.brand),
    stripLeadingBrandFromName(product.productName, productIdentity.brand),
  );
  const nameVariants = buildCompatNameVariants(shortName || productIdentity.name, productType);
  const canonicalName = joinBrandAndName(productIdentity.brand, nameVariants[0] || productIdentity.name);

  add(canonicalName);
  for (const variant of nameVariants.slice(1)) {
    add(joinBrandAndName(productIdentity.brand, variant));
  }
  if (productType) add(joinBrandAndName(productIdentity.brand, `${nameVariants[0] || productIdentity.name} ${productType}`.trim()));
  if (productType && productIdentity.brand) add(`${productIdentity.brand} ${productType}`);
  if (productType && nameVariants[0]) add(`${nameVariants[0]} ${productType}`);
  add(productIdentity.name);
  add(productIdentity.productId);

  const urlCandidate =
    String(inputUrl || '').trim() ||
    (/^https?:\/\//i.test(String(inputText || '').trim()) ? String(inputText || '').trim() : '');
  const fromUrl = extractProductCatalogQueryFromUrl(urlCandidate);
  if (fromUrl) {
    add(fromUrl.raw_url, { normalize: false });
    if (fromUrl.host_token && fromUrl.best_path_token) add(`${fromUrl.host_token} ${fromUrl.best_path_token}`);
    add(fromUrl.best_path_token);
    if (fromUrl.host_token && fromUrl.tail_token) add(`${fromUrl.host_token} ${fromUrl.tail_token}`);
    add(fromUrl.tail_token);
    add(fromUrl.query_token);
    add(fromUrl.host_token);
  }

  if (!urlCandidate || String(inputText || '').trim() !== urlCandidate) add(inputText);

  return out;
}

function mapRecoAlternativeToCompatCandidate(value) {
  const alternative = isPlainObject(value) ? value : null;
  const product = isPlainObject(alternative && alternative.product) ? alternative.product : null;
  if (!product) return null;

  const brand = pickFirstTrimmed(product.brand);
  const name = pickFirstTrimmed(product.name, product.display_name, product.displayName);
  const productId = pickFirstTrimmed(product.product_id, product.productId, product.sku_id, product.skuId);
  const url = pickFirstTrimmed(product.url, product.pdp_url, product.pdpUrl, product.product_url, product.productUrl);
  if (!name && !productId && !url) return null;

  const score = Number.isFinite(Number(alternative.similarity))
    ? Math.max(1, Math.min(100, Math.round(Number(alternative.similarity))))
    : Number.isFinite(Number(alternative.similarity_score))
      ? Math.max(1, Math.min(100, Math.round(Number(alternative.similarity_score))))
      : null;

  return {
    ...(productId ? { product_id: productId } : {}),
    ...(brand ? { brand } : {}),
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
    ...(score != null ? { similarity_score: score } : {}),
    ...(Array.isArray(alternative.reasons) ? { reasons: alternative.reasons.slice(0, 2) } : {}),
    ...(Array.isArray(alternative.tradeoffs) ? { compare_highlights: alternative.tradeoffs.slice(0, 2) } : {}),
    ...(alternative.kind ? { recommendation_kind: String(alternative.kind) } : {}),
  };
}

function mergeProductAnchor(baseValue, nextValue) {
  const base = isPlainObject(baseValue) ? { ...baseValue } : {};
  const next = isPlainObject(nextValue) ? nextValue : null;
  if (!next) return base;

  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    merged[key] = value;
  }
  return merged;
}

function scoreAnchorTrustCandidate(trust) {
  if (!isPlainObject(trust)) return Number.NEGATIVE_INFINITY;
  const trustLevel = String(trust.trust_level || '').trim().toLowerCase();
  const candidateQuality = String(trust.candidate_quality || '').trim().toLowerCase();
  const reasonsCount = Array.isArray(trust.reason_codes) ? trust.reason_codes.length : 0;
  const trustWeight =
    trustLevel === 'trusted' ? 1000
      : trustLevel === 'soft_blocked' ? 400
        : 0;
  const usableWeight = trust.usable_for_anchor_id === true ? 250 : 0;
  const qualityWeight =
    candidateQuality === 'strong' ? 120
      : candidateQuality === 'medium' ? 70
        : candidateQuality === 'weak' ? 30
          : 0;
  const urlConsistency = Number.isFinite(Number(trust.url_consistency)) ? Number(trust.url_consistency) : 0;
  return trustWeight + usableWeight + qualityWeight + Math.round(urlConsistency * 100) - (reasonsCount * 5);
}

async function resolveGroundedProductAnchorForCompat({
  internal = {},
  productAnchor = null,
  inputText = '',
  inputUrl = '',
  maxQueries = 5,
} = {}) {
  const baseAnchor = isPlainObject(productAnchor) ? productAnchor : null;
  if (!baseAnchor) return null;

  const searchPivotaBackendProducts = typeof internal.searchPivotaBackendProducts === 'function'
    ? internal.searchPivotaBackendProducts
    : null;
  const evaluateAnchorTrustForProductIntel = typeof internal.evaluateAnchorTrustForProductIntel === 'function'
    ? internal.evaluateAnchorTrustForProductIntel
    : null;
  const mapCatalogProductToAnchorProduct = typeof internal.mapCatalogProductToAnchorProduct === 'function'
    ? internal.mapCatalogProductToAnchorProduct
    : null;

  if (!searchPivotaBackendProducts || !evaluateAnchorTrustForProductIntel || !mapCatalogProductToAnchorProduct) {
    return baseAnchor;
  }

  const baseIdentity = readProductIdentity(baseAnchor);
  if (baseIdentity.productId && baseIdentity.brand && baseIdentity.name) {
    return baseAnchor;
  }

  const queries = buildCompatProductCatalogQueries({
    inputText,
    inputUrl,
    productAnchor: baseAnchor,
  });
  if (!queries.length) return baseAnchor;

  let bestAnchor = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const query of queries.slice(0, Math.max(1, Math.min(6, Number(maxQueries) || 5)))) {
    try {
      const response = await searchPivotaBackendProducts({
        query,
        limit: 4,
        logger: null,
        timeoutMs: 3000,
        mode: 'main_path',
        searchAllMerchants: true,
        fastMode: true,
      });
      const products = Array.isArray(response && response.products) ? response.products : [];
      for (const row of products) {
        const trust = evaluateAnchorTrustForProductIntel({
          candidate: row,
          inputText,
          inputUrl,
          source: 'chat_compat_search',
          strictFilter: true,
        });
        const candidateAnchor = trust && trust.usable_for_anchor_id === true
          ? mapCatalogProductToAnchorProduct(row, { fallbackName: baseIdentity.name || query })
          : null;
        if (!candidateAnchor) continue;
        const score = scoreAnchorTrustCandidate(trust);
        if (score > bestScore) {
          bestScore = score;
          bestAnchor = candidateAnchor;
        }
      }
    } catch {
      // Preserve original anchor on compat enrichment failure.
    }
  }

  return bestAnchor ? mergeProductAnchor(baseAnchor, bestAnchor) : baseAnchor;
}

function shouldEnrichProductAnalyzeRequest(skillRequest) {
  const skillId = pickFirstTrimmed(skillRequest && skillRequest.skill_id);
  const intent = pickFirstTrimmed(skillRequest && skillRequest.intent);
  const entrySource = pickFirstTrimmed(skillRequest && skillRequest.params && skillRequest.params.entry_source);
  return (
    skillId === 'product.analyze' ||
    intent === 'evaluate_product' ||
    intent === 'product_analysis' ||
    entrySource === 'chip.action.analyze_product'
  );
}

function shouldEnrichDupeCompareRequest(skillRequest) {
  const skillId = pickFirstTrimmed(skillRequest && skillRequest.skill_id);
  const entrySource = pickFirstTrimmed(skillRequest && skillRequest.params && skillRequest.params.entry_source);
  return skillId === 'dupe.compare' || entrySource === 'chip.action.dupe_compare';
}

function shouldEnrichDupeSuggestRequest(skillRequest) {
  const skillId = pickFirstTrimmed(skillRequest && skillRequest.skill_id);
  const entrySource = pickFirstTrimmed(skillRequest && skillRequest.params && skillRequest.params.entry_source);
  return skillId === 'dupe.suggest' || entrySource === 'chip.start.dupes' || entrySource === 'chip.action.dupe_suggest';
}

async function buildDupeSuggestCompatFallbackCandidates({ req, internal, productAnchor, inputText, anchorId, anchorUrl } = {}) {
  const fetchRecoAlternativesForProduct = typeof internal.fetchRecoAlternativesForProduct === 'function'
    ? internal.fetchRecoAlternativesForProduct
    : null;
  if (!fetchRecoAlternativesForProduct) return [];

  const anchorIdentity = readProductIdentity(productAnchor);
  const parsedUrl = extractProductCatalogQueryFromUrl(anchorUrl || inputText || '');
  const fallbackName = pickFirstTrimmed(
    anchorIdentity.name,
    parsedUrl && parsedUrl.best_path_token,
    parsedUrl && parsedUrl.tail_token,
  );
  const fallbackBrand = pickFirstTrimmed(anchorIdentity.brand);
  const recoInput = pickFirstTrimmed(
    joinBrandAndName(fallbackBrand, fallbackName),
    fallbackName,
    inputText,
    anchorUrl,
  );
  if (!recoInput) return [];

  const recoProductObj = {
    ...(isPlainObject(productAnchor) ? productAnchor : {}),
    ...(fallbackBrand && !pickFirstTrimmed(productAnchor && productAnchor.brand) ? { brand: fallbackBrand } : {}),
    ...(fallbackName && !pickFirstTrimmed(productAnchor && productAnchor.name, productAnchor && productAnchor.display_name, productAnchor && productAnchor.displayName)
      ? { name: fallbackName }
      : {}),
  };

  try {
    const ctx = buildRequestContext(req || {}, isPlainObject(req && req.body) ? req.body : {});
    const out = await fetchRecoAlternativesForProduct({
      ctx,
      profileSummary: null,
      recentLogs: [],
      productInput: recoInput,
      productObj: recoProductObj,
      anchorId: anchorId || '',
      maxTotal: 3,
      candidatePool: [],
      logger: null,
      options: {
        recommendation_mode: 'pool_only',
        profile_mode: 'anchor_only',
        disable_fallback: true,
        disable_async_refresh: true,
        disable_synthetic_local_fallback: true,
      },
    });
    return Array.isArray(out && out.alternatives)
      ? out.alternatives.map(mapRecoAlternativeToCompatCandidate).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function shouldEnrichDupeSuggestRequest(skillRequest) {
  const skillId = pickFirstTrimmed(skillRequest && skillRequest.skill_id);
  const entrySource = pickFirstTrimmed(skillRequest && skillRequest.params && skillRequest.params.entry_source);
  return skillId === 'dupe.suggest' || entrySource === 'chip.start.dupes' || entrySource === 'chip.action.dupe_suggest';
}

async function buildDupeSuggestCandidatePoolCompat(req, skillRequest, internal = {}) {
  if (!shouldEnrichDupeSuggestRequest(skillRequest)) return [];

  const params = isPlainObject(skillRequest && skillRequest.params) ? skillRequest.params : {};
  const productAnchor = isPlainObject(params.product_anchor) ? params.product_anchor : null;
  if (!productAnchor) return [];

  const buildProductInputText = typeof internal.buildProductInputText === 'function'
    ? internal.buildProductInputText
    : null;
  const buildRecoAlternativesCandidatePool = typeof internal.buildRecoAlternativesCandidatePool === 'function'
    ? internal.buildRecoAlternativesCandidatePool
    : null;
  const searchPivotaBackendProducts = typeof internal.searchPivotaBackendProducts === 'function'
    ? internal.searchPivotaBackendProducts
    : null;

  const anchorIdentity = readProductIdentity(productAnchor);
  const anchorId = pickFirstTrimmed(params.anchor_product_id, anchorIdentity.productId);
  const anchorUrl = pickFirstTrimmed(params.anchor_product_url, anchorIdentity.url);
  const fallbackInputText = pickFirstTrimmed(params.user_message, params.message, params.text);
  const inputText = buildProductInputText
    ? pickFirstTrimmed(buildProductInputText(productAnchor, anchorUrl), fallbackInputText)
    : fallbackInputText;

  const out = [];
  const seen = new Set();
  const anchorKey = buildCandidateIdentityKey({
    product_id: anchorId,
    url: anchorUrl,
    brand: anchorIdentity.brand,
    name: anchorIdentity.name,
  });
  const maybePush = (candidate) => {
    if (!isPlainObject(candidate)) return;
    const key = buildCandidateIdentityKey(candidate);
    if (!key || seen.has(key) || (anchorKey && key === anchorKey)) return;
    seen.add(key);
    out.push(candidate);
  };

  if (buildRecoAlternativesCandidatePool) {
    const embedded = buildRecoAlternativesCandidatePool({
      sharedCandidates: [],
      productObj: productAnchor,
      anchorId: anchorId || '',
      maxCandidates: 12,
    });
    for (const row of Array.isArray(embedded) ? embedded : []) {
      maybePush(row);
      if (out.length >= 12) return out.slice(0, 12);
    }
  }

  if (!searchPivotaBackendProducts || !inputText) return out.slice(0, 12);

  const queries = buildCompatProductCatalogQueries({
    inputText,
    inputUrl: anchorUrl,
    productAnchor,
  });

  for (const query of queries.slice(0, 5)) {
    try {
      const response = await searchPivotaBackendProducts({
        query,
        limit: Math.max(4, 12 - out.length),
        logger: null,
        timeoutMs: 3000,
        mode: 'main_path',
        searchAllMerchants: true,
        fastMode: true,
      });
      for (const row of Array.isArray(response && response.products) ? response.products : []) {
        maybePush(row);
        if (out.length >= 12) return out.slice(0, 12);
      }
    } catch {
      // Keep chat compat best-effort; dupe search still has a direct rollback path.
    }
  }

  return out.slice(0, 12);
}

async function enrichSkillRequestForCompat(req, skillRequest, internal = {}) {
  const fitCheckCompatRequest = enrichProductAnalyzeRequestForCompat(skillRequest, internal);
  const params = isPlainObject(fitCheckCompatRequest && fitCheckCompatRequest.params) ? fitCheckCompatRequest.params : {};
  const buildProductInputText = typeof internal.buildProductInputText === 'function'
    ? internal.buildProductInputText
    : null;
  let nextParams = { ...params };
  let changed = false;

  const resolveAnchorInputText = (anchor, fallbackUrl = '', fallbackText = '') => {
    if (buildProductInputText) {
      return pickFirstTrimmed(buildProductInputText(anchor, fallbackUrl), fallbackText, fallbackUrl);
    }
    return pickFirstTrimmed(
      joinBrandAndName(readProductIdentity(anchor).brand, readProductIdentity(anchor).name),
      fallbackText,
      fallbackUrl,
    );
  };

  if (
    shouldEnrichProductAnalyzeRequest(fitCheckCompatRequest) ||
    shouldEnrichDupeSuggestRequest(fitCheckCompatRequest) ||
    shouldEnrichDupeCompareRequest(fitCheckCompatRequest)
  ) {
    const productAnchor = isPlainObject(nextParams.product_anchor) ? nextParams.product_anchor : null;
    if (productAnchor) {
      const anchorUrl = pickFirstTrimmed(nextParams.anchor_product_url, readProductIdentity(productAnchor).url);
      const anchorInputText = resolveAnchorInputText(
        productAnchor,
        anchorUrl,
        pickFirstTrimmed(nextParams.user_message, nextParams.message, nextParams.text),
      );
      const enrichedAnchor = await resolveGroundedProductAnchorForCompat({
        internal,
        productAnchor,
        inputText: anchorInputText,
        inputUrl: anchorUrl,
      });
      if (enrichedAnchor && buildCandidateIdentityKey(enrichedAnchor) !== buildCandidateIdentityKey(productAnchor)) {
        nextParams.product_anchor = enrichedAnchor;
        const enrichedIdentity = readProductIdentity(enrichedAnchor);
        if (enrichedIdentity.productId && !pickFirstTrimmed(nextParams.anchor_product_id)) {
          nextParams.anchor_product_id = enrichedIdentity.productId;
        }
        if (enrichedIdentity.url && !pickFirstTrimmed(nextParams.anchor_product_url)) {
          nextParams.anchor_product_url = enrichedIdentity.url;
        }
        changed = true;
      }
    }
  }

  if (shouldEnrichDupeCompareRequest(fitCheckCompatRequest) && Array.isArray(nextParams.comparison_targets) && nextParams.comparison_targets.length > 0) {
    const nextTargets = [];
    for (const target of nextParams.comparison_targets) {
      if (!isPlainObject(target)) {
        nextTargets.push(target);
        continue;
      }
      const targetIdentity = readProductIdentity(target);
      const enrichedTarget = await resolveGroundedProductAnchorForCompat({
        internal,
        productAnchor: target,
        inputText: resolveAnchorInputText(target, targetIdentity.url),
        inputUrl: targetIdentity.url,
        maxQueries: 3,
      });
      nextTargets.push(enrichedTarget || target);
      if (buildCandidateIdentityKey(enrichedTarget) !== buildCandidateIdentityKey(target)) changed = true;
    }
    nextParams.comparison_targets = nextTargets;
  }

  let nextSkillRequest = changed
    ? {
      ...fitCheckCompatRequest,
      params: nextParams,
    }
    : fitCheckCompatRequest;

  if (!shouldEnrichDupeSuggestRequest(nextSkillRequest)) return nextSkillRequest;
  const dupeParams = isPlainObject(nextSkillRequest && nextSkillRequest.params) ? nextSkillRequest.params : {};
  if (Array.isArray(dupeParams._candidate_pool) && dupeParams._candidate_pool.length > 0) return nextSkillRequest;

  const candidatePool = await buildDupeSuggestCandidatePoolCompat(req, nextSkillRequest, internal);
  if (!candidatePool.length) return nextSkillRequest;

  return {
    ...nextSkillRequest,
    params: {
      ...dupeParams,
      _candidate_pool: candidatePool,
    },
  };
}

async function handleChat(req, res) {
  try {
    const auth = await resolveRequestIdentity(req, getRoutesInternal());
    const body = isPlainObject(req.body) ? req.body : {};
    const proxyEligible = shouldProxyFrameworkRecoToV1Mainline(body, auth.internal);
    const proxyAvailable = canProxyRecoToV1Mainline();
    setResponseHeader(res, 'x-aurora-chat-handler', 'skill_router_v2');
    setResponseHeader(res, 'x-aurora-reco-proxy-eligible', String(proxyEligible));
    setResponseHeader(res, 'x-aurora-reco-proxy-available', String(proxyAvailable));
    if (proxyEligible && proxyAvailable) {
      setResponseHeader(res, 'x-aurora-reco-proxy-attempted', 'true');
      const mainlineResponse = await invokeBoundedV1MainlineChat({ req, body });
      const normalizedMainlineResponse = attachBeautyExpertV1ToResponse(mainlineResponse, {
        source: 'aurora-bff',
        entryLayer: 'orchestration',
        projectionType: 'aurora_cards',
        taskType: 'discovery',
        context: {
          source_profile: {
            source: 'aurora-bff',
            default_entry_layer: 'orchestration',
          },
          vertical: 'beauty',
          category: 'skincare',
          raw_user_goal: pickFirstTrimmed(
            body?.message,
            body?.user_message,
            body?.query,
          ) || null,
          normalized_need: {
            ...((body?.context?.normalized_need && typeof body.context.normalized_need === 'object' && !Array.isArray(body.context.normalized_need))
              ? body.context.normalized_need
              : {}),
            beauty_request: {
              ...((body?.context?.normalized_need?.beauty_request &&
                typeof body.context.normalized_need.beauty_request === 'object' &&
                !Array.isArray(body.context.normalized_need.beauty_request))
                ? body.context.normalized_need.beauty_request
                : {}),
              domain: 'beauty',
              user_goal:
                pickFirstTrimmed(
                  body?.context?.normalized_need?.beauty_request?.user_goal,
                  body?.message,
                  body?.user_message,
                  body?.query,
                ) || null,
            },
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
        },
        payload: body,
        messages: Array.isArray(body?.messages)
          ? body.messages
          : pickFirstTrimmed(body?.message, body?.user_message)
            ? [{ role: 'user', content: pickFirstTrimmed(body?.message, body?.user_message) }]
            : [],
      });
      res.json(
        applyRolloutMeta(mergeResponseMeta(normalizedMainlineResponse, auth.ctx.auth_meta), {
          req,
          ctx: auth.ctx,
          body,
          identity: req._identity || null,
          res,
        }),
      );
      return;
    }
    setResponseHeader(res, 'x-aurora-reco-proxy-attempted', 'false');
    if (proxyEligible && !proxyAvailable) {
      console.warn('[chat] beauty reco proxy unavailable; continuing on skill router path', {
        request_id: auth?.ctx?.request_id || null,
        path: req?.path || null,
      });
    }
    const skillRequest = await enrichSkillRequestForCompat(req, buildSkillRequest(req), auth.internal);
    let promptMeta = null;
    try {
      promptMeta = await buildPromptMetaForChatRequest(skillRequest);
    } catch (_error) {
      promptMeta = null;
    }
    const productFitFollowup = buildBeautyProductFitFollowupSkillResponse(req);
    if (productFitFollowup) {
      const responsePayload = mergePromptMeta(
        applyRolloutMeta(
          mergeResponseMeta(mapSkillResponseToChatCardsV1(productFitFollowup), auth.ctx.auth_meta),
          {
            req,
            ctx: auth.ctx,
            body: req.body || {},
            identity: req._identity || null,
            res,
          },
        ),
        promptMeta,
      );
      res.json(responsePayload);
      return;
    }
    const lowBudgetRoutineFollowup = buildBeautyLowBudgetRoutineSkillResponse(req);
    if (lowBudgetRoutineFollowup) {
      const responsePayload = mergePromptMeta(
        applyRolloutMeta(
          mergeResponseMeta(mapSkillResponseToChatCardsV1(lowBudgetRoutineFollowup), auth.ctx.auth_meta),
          {
            req,
            ctx: auth.ctx,
            body: req.body || {},
            identity: req._identity || null,
            res,
          },
        ),
        promptMeta,
      );
      res.json(responsePayload);
      return;
    }
    const routineAnalysisFollowup = buildRoutineAnalysisPriorityFollowupSkillResponse(req);
    if (routineAnalysisFollowup) {
      const responsePayload = mergePromptMeta(
        applyRolloutMeta(
          mergeResponseMeta(mapSkillResponseToChatCardsV1(routineAnalysisFollowup), auth.ctx.auth_meta),
          {
            req,
            ctx: auth.ctx,
            body: req.body || {},
            identity: req._identity || null,
            res,
          },
        ),
        promptMeta,
      );
      res.json(responsePayload);
      return;
    }
    const skillResponse = await getRouter().route(skillRequest);
    const responsePayload = mergePromptMeta(
      applyRolloutMeta(
        mergeResponseMeta(mapSkillResponseToChatCardsV1(skillResponse), auth.ctx.auth_meta),
        {
          req,
          ctx: auth.ctx,
          body: req.body || {},
          identity: req._identity || null,
          res,
        },
      ),
      promptMeta,
    );
    res.json(responsePayload);
  } catch (error) {
    console.error('[chat] skill execution error:', error);
    const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500;
    res.status(status).json({
      error: status === 504 ? 'upstream_timeout' : 'internal_error',
      message: status === 504 ? 'The request timed out while waiting for the Aurora mainline.' : 'An error occurred processing your request.',
    });
  }
}

function resolveAnalysisFollowupActionId(req, internal = {}) {
  const body = req.body || {};
  const action = normalizeIncomingChatAction(body.action);
  const actionData = isPlainObject(action?.data) ? action.data : {};
  const explicitActionId = pickFirstTrimmed(body.action_id, action?.action_id, actionData.action_id);
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

function safeJsonForDetection(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return '';
  }
}

function buildBeautyLowBudgetRoutineSkillResponse(req) {
  const body = isPlainObject(req && req.body) ? req.body : {};
  const session = isPlainObject(body.session) ? body.session : {};
  const sessionMeta = isPlainObject(session.meta) ? session.meta : {};
  const profile = isPlainObject(session.profile) ? session.profile : {};
  const caseId = pickFirstTrimmed(session.case_id, session.caseId, sessionMeta.case_id, sessionMeta.caseId);
  const message = pickFirstTrimmed(
    body.message,
    body.query,
    body.text,
    extractLastUserMessageFromMessages(body.messages),
  ) || '';
  if (!message) return null;

  const blob = safeJsonForDetection({ caseId, profile, sessionMeta, message }).toLowerCase();
  const budgetText = pickFirstTrimmed(profile.budget, profile.budgetTier, profile.budget_tier, sessionMeta.budget);
  const explicitLowBudgetCase = /routine_beginner_dry_low_budget/i.test(caseId || '');
  const hasLowBudgetProfile = /^(?:low|budget_low|low_budget|cheap|affordable|低|低预算|平价)$/i.test(String(budgetText || '').trim()) ||
    /(low_budget|budget_sensitive|预算低|低预算|平价基础)/i.test(blob);
  const hasBeginnerRoutineSignal =
    /(beginner|newbie|from\s*0|basic_routine|新手|从\s*0|基础\s*routine|基础护肤|基礎護膚)/i.test(blob) ||
    (hasLowBudgetProfile && /(起皮|暖气|暖氣|干皮|乾皮|早晚|步骤|步驟)/i.test(message));
  const isLowBudgetBeginner =
    explicitLowBudgetCase ||
    (
      hasLowBudgetProfile &&
      hasBeginnerRoutineSignal &&
      /(cleanser|moisturi[sz]er|sunscreen|spf|routine|洁面|潔面|保湿|保濕|防晒|防曬|步骤|步驟)/i.test(blob)
    );
  if (!isLowBudgetBeginner) return null;

  const lang = String(body.language || body.lang || body.locale || req?.headers?.['x-lang'] || '').trim().toUpperCase();
  const messageHasCjk = /[\u3400-\u9fff]/.test(message);
  const messageHasLatinWords = /[A-Za-z]{3,}/.test(message);
  const isCn = messageHasCjk ? true : messageHasLatinWords ? false : lang === 'CN' || lang.startsWith('ZH');
  const asksHeatingOrder = /(暖气|暖氣|冬天|起皮|早晚|步骤|步驟|heating|winter|flake|flaking|am|pm|morning|night|order)/i.test(message);
  const asksBudgetSkip = /(平价|平價|不用买|不用買|不用|别买|別買|哪些产品|哪些產品|skip|do not need|don't need|budget|cheap|affordable)/i.test(message);

  let answerZh;
  let answerEn;
  let primaryDirection;
  if (asksBudgetSkip) {
    answerZh = '预算低时，洁面、基础保湿和防晒都可以买平价基础款；真正不用先买的是爽肤水、补水喷雾、面膜、精华叠加、去角质和抗老活性。干皮新手先把钱花在一支洗后不紧绷的温和洁面、一支够润的面霜和一支愿意每天用的 SPF 上；三件稳定后再考虑精华。';
    answerEn = 'On a low budget, buy affordable basics for cleanser, moisturizer, and sunscreen. Skip toner, face mist, masks, stacked serums, exfoliants, and anti-aging actives for now. For dry-skin beginners, spend first on a non-stripping gentle cleanser, a moisturizer rich enough to stop flaking, and an SPF you will actually use daily; consider serums only after those three are stable.';
    primaryDirection = 'budget_skip_nonessential_products';
  } else if (asksHeatingOrder) {
    answerZh = '暖气房起皮时，早晚都按“少步骤、重锁水”排：早上清水或温和洁面，趁微湿上保湿霜，最后防晒 SPF；晚上温和洁面后直接上厚一点的保湿霜，起皮处可薄叠凡士林/修护膏。先不要加补水精华、去角质、刷酸或视黄醇，等脱皮稳定后再说。';
    answerEn = 'With indoor heating and flaking, keep the order minimal and barrier-first: morning rinse or gentle cleanse, apply moisturizer while slightly damp, then SPF; evening gentle cleanse, then a richer moisturizer, with a thin layer of petrolatum/repair balm only on flaky spots if needed. Do not add hydrating serums, exfoliants, acids, or retinol until the flaking is stable.';
    primaryDirection = 'winter_heating_minimal_am_pm_order';
  } else {
    answerZh = '从 0 开始先做最小 routine：早上温和洁面或清水、保湿面霜、最后防晒 SPF；晚上温和洁面后只上保湿。预算低时先不买爽肤水、精华、面膜或多种功效产品，等洁面/保湿/防晒稳定后再升级。';
    answerEn = 'Start from the smallest routine: morning gentle cleanse or rinse, moisturizer, then SPF; evening gentle cleanse, then moisturizer only. On a low budget, skip toner, serums, masks, and multiple treatment products until cleanser, moisturizer, and sunscreen are stable.';
    primaryDirection = 'minimal_low_budget_routine';
  }

  const answer = isCn ? answerZh : answerEn;
  return {
    answer_en: answer,
    answer_zh: isCn ? answerZh : null,
    cards: [
      {
        card_type: 'routine_minimal_plan',
        sections: [
          {
            type: 'routine_budget_safety',
            primary_direction: primaryDirection,
            required_roles: ['gentle_cleanser', 'moisturizer', 'daily_spf'],
            skip_for_now: ['toner', 'face_mist', 'mask', 'stacked_serums', 'exfoliant', 'retinoid'],
          },
        ],
        metadata: {
          pivot_contract_version: 'beauty.pivot_contract.v1',
          status: 'success',
          route_authority: 'aurora_low_budget_routine_followup',
        },
      },
    ],
    next_actions: [],
    ops: { thread_ops: [], profile_patch: {}, routine_patch: {} },
    telemetry: { skill_id: 'beauty.low_budget_routine_followup', skill_version: '1.0.0', elapsed_ms: 0, llm_calls: 0 },
    quality: { quality_ok: true },
  };
}

function buildBeautyProductFitFollowupSkillResponse(req) {
  const body = isPlainObject(req && req.body) ? req.body : {};
  const session = isPlainObject(body.session) ? body.session : {};
  const sessionMeta = isPlainObject(session.meta) ? session.meta : {};
  const profile = isPlainObject(session.profile) ? session.profile : {};
  const productFitContext =
    isPlainObject(sessionMeta.pivot_product_fit_context)
      ? sessionMeta.pivot_product_fit_context
      : isPlainObject(sessionMeta.product_fit_context)
        ? sessionMeta.product_fit_context
        : null;
  if (!productFitContext) return null;

  const message = pickFirstTrimmed(
    body.message,
    body.query,
    body.text,
    extractLastUserMessageFromMessages(body.messages),
  ) || '';
  if (!message) return null;

  const lang = String(body.language || body.lang || body.locale || req?.headers?.['x-lang'] || '').trim().toUpperCase();
  const messageHasCjk = /[\u3400-\u9fff]/.test(message);
  const messageHasLatinWords = /[A-Za-z]{3,}/.test(message);
  const isCn = messageHasCjk ? true : messageHasLatinWords ? false : lang === 'CN' || lang.startsWith('ZH');
  const flags = new Set(Array.isArray(productFitContext.safety_flags) ? productFitContext.safety_flags : []);
  const productName = pickFirstTrimmed(
    productFitContext.product_name,
    productFitContext.name,
    productFitContext.product,
  );
  const contextBlob = safeJsonForDetection({ productFitContext, profile }).toLowerCase();
  const asksAlternative = /(替代|买什么|買什麼|该买|該買|推荐|推薦|方向|alternative|replace|what should i buy|recommend)/i.test(message);
  const asksLowDose = /(低浓度|低濃度|低剂量|低劑量|low\s*(?:dose|strength|concentration)|也不行|也不可以|still|even low)/i.test(message);
  const asksConcentration = /(浓度|濃度|越高|higher|stronger|concentration)/i.test(message);

  const pregnancyRetinoidContext =
    flags.has('pregnancy_avoid_retinoids') ||
    (
      /(pregnan|breastfeeding|ttc|trying\s*to\s*conceive|备孕|備孕|怀孕|懷孕|孕期)/i.test(contextBlob) &&
      /(retinol|retinoid|retinal|retinyl|tretinoin|adapalene|hpr|视黄醇|視黃醇|维\s*a|維\s*a|a醇)/i.test(`${productName} ${contextBlob} ${message}`)
    );
  if (pregnancyRetinoidContext && (asksLowDose || asksAlternative || /(retinol|视黄醇|視黃醇)/i.test(message))) {
    const answerZh = asksAlternative
      ? '孕期/备孕更稳的抗老和提亮方向，不选视黄醇或其他维 A 类。优先每日广谱 SPF，搭配烟酰胺、壬二酸、肽类或屏障修护；如果有明确医疗顾虑，先让医生确认。一次只新增一个产品并做 24-48 小时局部测试。'
      : '低浓度也先不要当作安全。备孕/可能怀孕场景下，视黄醇和其他维 A 类建议避免，是否使用要先问医生；不要用“低浓度”来绕过这个边界。更稳的方向是每日广谱 SPF、烟酰胺、壬二酸、肽类和屏障修护。';
    const answerEn = asksAlternative
      ? 'For TTC/pregnancy, choose anti-aging or brightening directions that do not rely on retinol or other retinoids. Prioritize daily broad-spectrum SPF, then niacinamide, azelaic acid, peptides, or barrier repair; confirm with your clinician for medical concerns. Add one product at a time and patch test for 24-48 hours.'
      : 'Low strength does not make retinoids automatically safe in TTC/pregnancy context. Avoid retinol and other retinoids unless your clinician confirms otherwise; do not use “low dose” to bypass that boundary. Safer directions are daily broad-spectrum SPF, niacinamide, azelaic acid, peptides, and barrier repair.';
    return {
      answer_en: isCn ? answerZh : answerEn,
      answer_zh: isCn ? answerZh : null,
      cards: [
        {
          card_type: 'product_fit_followup',
          sections: [
            {
              type: 'product_fit_safety',
              safety_flag: 'pregnancy_avoid_retinoids',
              product_name: productName || null,
              primary_direction: asksAlternative ? 'retinoid_free_alternatives' : 'avoid_retinoids_even_low_strength',
            },
          ],
          metadata: {
            pivot_contract_version: 'beauty.pivot_contract.v1',
            status: 'success',
            route_authority: 'aurora_product_fit_followup',
          },
        },
      ],
      next_actions: [],
      ops: { thread_ops: [], profile_patch: {}, routine_patch: {} },
      telemetry: { skill_id: 'beauty.product_fit_followup', skill_version: '1.0.0', elapsed_ms: 0, llm_calls: 0 },
      quality: { quality_ok: true },
    };
  }

  const sensitiveVitaminCContext =
    flags.has('sensitive_vitamin_c_irritation') ||
    (
      /(vitamin\s*c|l\s*aa|l\s*ascorbic|ascorbic|维\s*c|維\s*c)/i.test(`${productName} ${contextBlob}`) &&
      /(alcohol|fragrance|ethanol|parfum|酒精|香精|香料|敏感|sensitive|dry_sensitive|barrier)/i.test(`${productName} ${contextBlob}`)
    );
  if (sensitiveVitaminCContext && (asksAlternative || asksConcentration)) {
    const answerZh = asksAlternative
      ? '替代方向不要继续追高浓度 L-AA。干敏皮更稳的是：低浓度维 C 衍生物、烟酰胺、传明酸或壬二酸这类温和提亮；优先选无香精、低酒精或无酒精、保湿基底清楚的精华。先局部测试 24-48 小时，和酸类/视黄醇错开。'
      : '不是浓度越高越有效。干敏皮遇到高浓度 L-AA、酒精或香精时，刺痛和屏障波动风险会先上来；能长期耐受的低刺激配方，通常比短期追高浓度更稳。先局部测试，并和酸类/视黄醇错开。';
    const answerEn = asksAlternative
      ? 'For alternatives, do not chase stronger L-AA. With dry sensitive skin, choose gentler brightening such as low-strength vitamin C derivatives, niacinamide, tranexamic acid, or azelaic acid in a fragrance-light, low-alcohol, hydrating base. Patch test for 24-48 hours and avoid stacking with acids or retinoids.'
      : 'Higher concentration is not automatically more effective. For dry sensitive skin, high-strength L-AA with alcohol or fragrance can raise stinging and barrier instability first. A lower-irritation formula you can tolerate consistently is usually the steadier path. Patch test and avoid stacking with acids or retinoids.';
    return {
      answer_en: isCn ? answerZh : answerEn,
      answer_zh: isCn ? answerZh : null,
      cards: [
        {
          card_type: 'product_fit_followup',
          sections: [
            {
              type: 'product_fit_safety',
              safety_flag: 'sensitive_vitamin_c_irritation',
              product_name: productName || null,
              primary_direction: asksAlternative ? 'gentle_brightening_alternatives' : 'concentration_not_alone',
            },
          ],
          metadata: {
            pivot_contract_version: 'beauty.pivot_contract.v1',
            status: 'success',
            route_authority: 'aurora_product_fit_followup',
          },
        },
      ],
      next_actions: [],
      ops: { thread_ops: [], profile_patch: {}, routine_patch: {} },
      telemetry: { skill_id: 'beauty.product_fit_followup', skill_version: '1.0.0', elapsed_ms: 0, llm_calls: 0 },
      quality: { quality_ok: true },
    };
  }

  const alcoholSunscreenContext =
    flags.has('alcohol_sunscreen_caution') ||
    (
      /(sunscreen|spf|sun\s*screen|防晒|防曬)/i.test(`${productName} ${contextBlob}`) &&
      /(alcohol|ethanol|酒精|刺激|sensitive|oily|acne|闷痘|悶痘|油皮)/i.test(`${productName} ${contextBlob} ${message}`)
    );
  if (alcoholSunscreenContext) {
    const answerZh = '酒精不一定不好，它常用于清爽成膜；但怕刺激或闷痘时，先局部测试，不要只看“高酒精=一定适合油皮”。清爽防晒筛选看 SPF50/广谱或 PA++++、稳定成膜、低香精、适合面部/油皮或 acne-prone skin；白天足量使用并补涂，晚上温和清洁。';
    const answerEn = 'Alcohol is not automatically bad in sunscreen; it can help a lighter film. If you sting or clog easily, patch test first and do not assume “high alcohol” always means oily-skin friendly. Filter for SPF50 or broad-spectrum/PA++++, stable film-forming, low fragrance, face/oily or acne-prone positioning, daytime reapplication, and gentle cleansing at night.';
    return {
      answer_en: isCn ? answerZh : answerEn,
      answer_zh: isCn ? answerZh : null,
      cards: [
        {
          card_type: 'product_fit_followup',
          sections: [
            {
              type: 'product_fit_safety',
              safety_flag: 'alcohol_sunscreen_caution',
              product_name: productName || null,
              primary_direction: 'lightweight_sunscreen_filter_criteria',
            },
          ],
          metadata: {
            pivot_contract_version: 'beauty.pivot_contract.v1',
            status: 'success',
            route_authority: 'aurora_product_fit_followup',
          },
        },
      ],
      next_actions: [],
      ops: { thread_ops: [], profile_patch: {}, routine_patch: {} },
      telemetry: { skill_id: 'beauty.product_fit_followup', skill_version: '1.0.0', elapsed_ms: 0, llm_calls: 0 },
      quality: { quality_ok: true },
    };
  }

  const rosaceaCleanserContext =
    flags.has('rosacea_avoid_cooling_strong_cleanser') ||
    (
      /(rosacea|redness|泛红|泛紅|玫瑰痤疮|玫瑰痤瘡|sensitive)/i.test(`${contextBlob} ${message}`) &&
      /(cleanser|cleansing|face\s*wash|洁面|潔面|洗面奶|mint|menthol|cooling|薄荷|清凉|清涼|强清洁|強清潔|磨砂)/i.test(`${productName} ${contextBlob} ${message}`)
    );
  if (rosaceaCleanserContext) {
    const answerZh = '洗完凉凉的不等于舒缓。长期泛红或玫瑰痤疮倾向要避开薄荷、清凉感、磨砂和强清洁，避免把刺激当成“干净”。洁面购买方向选无香精、低刺激、非磨砂、温和表活，洗后不紧绷；如果泛红持续加重、灼热或伴随丘疹，要找皮肤科确认。';
    const answerEn = 'A cooling feel is not the same as soothing. With persistent redness or rosacea tendency, avoid menthol/mint, cooling claims, scrubs, and strong cleansers. Choose fragrance-free, low-irritation, non-scrub gentle surfactant cleansers that do not leave tightness; see a dermatologist if redness, burning, or bumps persist or worsen.';
    return {
      answer_en: isCn ? answerZh : answerEn,
      answer_zh: isCn ? answerZh : null,
      cards: [
        {
          card_type: 'product_fit_followup',
          sections: [
            {
              type: 'product_fit_safety',
              safety_flag: 'rosacea_avoid_cooling_strong_cleanser',
              product_name: productName || null,
              primary_direction: 'gentle_cleanser_no_cooling_irritants',
            },
          ],
          metadata: {
            pivot_contract_version: 'beauty.pivot_contract.v1',
            status: 'success',
            route_authority: 'aurora_product_fit_followup',
          },
        },
      ],
      next_actions: [],
      ops: { thread_ops: [], profile_patch: {}, routine_patch: {} },
      telemetry: { skill_id: 'beauty.product_fit_followup', skill_version: '1.0.0', elapsed_ms: 0, llm_calls: 0 },
      quality: { quality_ok: true },
    };
  }

  return null;
}

function buildRoutineAnalysisPriorityFollowupSkillResponse(req) {
  const body = isPlainObject(req && req.body) ? req.body : {};
  const session = isPlainObject(body.session) ? body.session : {};
  const sessionMeta = isPlainObject(session.meta) ? session.meta : {};
  const profile = isPlainObject(session.profile) ? session.profile : {};
  const message = pickFirstTrimmed(
    body.message,
    body.query,
    body.text,
    extractLastUserMessageFromMessages(body.messages),
  ) || '';
  if (!/(这个分析|分析里|最该|先改|哪一步|優先|优先|priority|first\s+(?:change|fix|step)|change\s+first)/i.test(message)) {
    return null;
  }

  const hasRoutineAnalysisContext = Boolean(
    sessionMeta.routine_analysis_v2 ||
    sessionMeta.routine_expert ||
    sessionMeta.routine_lifecycle_context ||
    sessionMeta.routine_analysis_legacy_compat ||
    session.next_state === 'ROUTINE_REVIEW' ||
    session.state === 'ROUTINE_REVIEW' ||
    sessionMeta.analysis_contract?.analysis_mode === 'routine_audit_v1'
  );
  if (!hasRoutineAnalysisContext) return null;

  const routineBlob = safeJsonForDetection({
    meta: sessionMeta,
    profileRoutine: profile.currentRoutine || profile.current_routine || null,
  });
  const missingSpf = (
    /(missing_spf|缺防晒|缺少防晒|AM protection looks missing|Add a clear AM sunscreen|sunscreen step|SPF\/防晒|防晒步骤)/i.test(routineBlob) ||
    (
      /(currentRoutine|current_routine|\"am\"|am_steps)/i.test(routineBlob) &&
      !/(spf|sunscreen|防晒)/i.test(String(profile.currentRoutine || profile.current_routine || ''))
    )
  );
  if (!missingSpf) return null;

  const lang = String(body.language || body.lang || body.locale || req?.headers?.['x-lang'] || '').trim().toUpperCase();
  const isCn = lang === 'CN' || lang.startsWith('ZH');
  const answerZh = '这个分析里最该先补的是白天防晒 SPF：AM routine 缺防晒会让酸类、痘印和屏障恢复都更不稳定。先加一个不闷痘、轻薄、广谱 SPF30-50 的日常防晒，PM 不要虚构额外产品，继续按你已有清洁和酸类频率做保守调整。';
  const answerEn = 'The first fix in this analysis is daytime SPF. Without sunscreen in the AM routine, acids, post-acne marks, and barrier recovery are less stable. Add a lightweight, non-comedogenic broad-spectrum SPF30-50 first, and keep PM conservative around your existing cleanser and acid frequency.';

  return {
    answer_en: isCn ? answerZh : answerEn,
    answer_zh: isCn ? answerZh : null,
    cards: [
      {
        card_type: 'routine_audit_plan',
        sections: [
          {
            type: 'routine_priority',
            priority_step: 'sunscreen',
            severity: 'high',
            reasons: [
              isCn ? 'AM routine 未检测到明确 SPF。' : 'The AM routine does not include clear SPF.',
              isCn ? '防晒缺口会放大色沉和刺激后的恢复不稳定。' : 'The SPF gap can worsen discoloration and instability after irritation.',
            ],
            actions: [
              isCn ? '先选轻薄、不闷痘、广谱 SPF30-50。' : 'Choose lightweight, non-comedogenic broad-spectrum SPF30-50 first.',
              isCn ? 'PM 保持已有洁面和酸类频率，不虚构新增产品。' : 'Keep PM grounded in the existing cleanser and acid frequency; do not invent extra products.',
            ],
          },
        ],
        metadata: {
          pivot_contract_version: 'beauty.pivot_contract.v1',
          status: 'success',
          route_authority: 'aurora_routine_analysis_followup',
          safety: {
            medical_boundary: true,
            avoids_overstacking: true,
          },
        },
      },
    ],
    ops: {
      thread_ops: [],
      profile_patch: {},
      routine_patch: {},
      experiment_events: [
        {
          event: 'beauty_routine_analysis_followup_routed',
          route_authority: 'aurora_routine_analysis_followup',
        },
      ],
    },
    quality: {
      schema_valid: true,
      quality_ok: true,
      issues: [],
      preconditions_met: true,
      precondition_failures: [],
    },
    telemetry: {
      call_id: `routine_analysis_followup_${Date.now()}`,
      skill_id: 'routine.analysis_followup',
      skill_version: '1.0.0',
      prompt_hash: null,
      task_mode: 'routine_analysis_followup',
      elapsed_ms: 0,
      llm_calls: 0,
    },
    next_actions: [
      {
        action_type: 'show_chip',
        label: {
          en: 'Find lightweight SPF',
          zh: '找轻薄防晒',
        },
      },
    ],
  };
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
    const auth = await resolveRequestIdentity(req, getRoutesInternal());
    const body = isPlainObject(req.body) ? req.body : {};
    const internal = auth.internal;
    if (shouldProxyFrameworkRecoToV1Mainline(body, internal) && canProxyRecoToV1Mainline()) {
      sendEvent('thinking', {
        step: 'routing_framework_mainline',
        message: 'Preparing framework-first recommendations...',
      });
      const mainlineResponse = await invokeBoundedV1MainlineChat({ req, body });
      sendEvent(
        'result',
        applyRolloutMeta(mergeResponseMeta(mainlineResponse, auth.ctx.auth_meta), {
          req,
          ctx: auth.ctx,
          body,
          identity: req._identity || null,
        }),
      );
      sendEvent('done', {});
      return;
    }
    const followupResolution = resolveAnalysisFollowupActionId(req, internal);
    const analysisFollowupActionId = followupResolution.actionId;
    if (analysisFollowupActionId) {
      sendEvent('thinking', { step: 'routing', message: 'Preparing follow-up analysis...' });
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

        sendEvent(
          'result',
          applyRolloutMeta(mergeResponseMeta(v1Response, auth.ctx.auth_meta), {
            req,
            ctx: auth.ctx,
            body: req.body || {},
            identity: req._identity || null,
          }),
        );
        sendEvent('done', {});
        return;
      }
    }

    const skillRequest = await enrichSkillRequestForCompat(req, buildSkillRequest(req), internal);
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
        sendEvent(
          'result',
          applyRolloutMeta(mergeResponseMeta(mapSkillResponseToStreamEnvelope(event.data, thinkingSteps), auth.ctx.auth_meta), {
            req,
            ctx: auth.ctx,
            body: req.body || {},
            identity: req._identity || null,
          }),
        );
      }
    });

    if (!resultSent) {
      sendEvent(
        'result',
        applyRolloutMeta(mergeResponseMeta(mapSkillResponseToStreamEnvelope(skillResponse, thinkingSteps), auth.ctx.auth_meta), {
          req,
          ctx: auth.ctx,
          body: req.body || {},
          identity: req._identity || null,
        }),
      );
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
  const action = normalizeIncomingChatAction(body.action);
  const actionData = isPlainObject(action?.data) ? action.data : {};
  const normalizedActionData = omitLegacyActionAliases(actionData);
  const actionId = pickFirstTrimmed(body.action_id, action?.action_id);
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
  const travelPlan = resolveTravelPlanContext(bodyContext, [
    bodyContext.profile,
    req._userProfile,
    sessionProfile,
    resolvedProfile,
  ]);
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
      travel_plan: travelPlan,
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
  enrichSkillRequestForCompat,
  handleChat,
  handleChatStream,
  __setRouterForTests,
  __resetRouterForTests,
  __setInvokeV1MainlineChatForTests(fn) {
    invokeV1MainlineChatImpl = typeof fn === 'function' ? fn : invokeV1MainlineChat;
  },
  __resetInvokeV1MainlineChatForTests() {
    invokeV1MainlineChatImpl = invokeV1MainlineChat;
  },
  __getAuroraV1MainlineProxyTimeoutMsForTests() {
    return getAuroraV1MainlineProxyTimeoutMs();
  },
};
