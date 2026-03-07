const crypto = require('crypto');

const DEFAULT_SKILL_TIMEOUT_MS = 4500;

function clampTimeoutMs(value, fallback = DEFAULT_SKILL_TIMEOUT_MS) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(200, Math.min(15000, Math.trunc(num)));
}

function normalizeSkillName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown_skill';
}

function withTimeout(promise, timeoutMs, timeoutCode = 'SKILL_TIMEOUT') {
  const ms = clampTimeoutMs(timeoutMs);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutCode);
      err.code = timeoutCode;
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createSkillRequestContext({ req, ctx, stage = 'unknown', timeoutMs, traceId, featureFlags } = {}) {
  const resolvedTraceId =
    String(traceId || '').trim() ||
    (ctx && typeof ctx.trace_id === 'string' && ctx.trace_id.trim()) ||
    `skill_${crypto.randomBytes(6).toString('hex')}`;

  return {
    request_id:
      (ctx && typeof ctx.request_id === 'string' && ctx.request_id.trim()) ||
      `skill_req_${Date.now()}`,
    trace_id: resolvedTraceId,
    aurora_uid: ctx && typeof ctx.aurora_uid === 'string' ? ctx.aurora_uid : null,
    language: ctx && String(ctx.lang || '').toUpperCase() === 'CN' ? 'CN' : 'EN',
    stage: String(stage || 'unknown').trim() || 'unknown',
    timeout_ms: clampTimeoutMs(timeoutMs),
    feature_flags:
      featureFlags && typeof featureFlags === 'object' && !Array.isArray(featureFlags)
        ? { ...featureFlags }
        : {},
    has_request: Boolean(req),
  };
}

function createSkillError({
  code = 'SKILL_FAILED',
  stage = 'unknown',
  retryable = false,
  degrade_to = 'none',
  message = '',
  details = null,
} = {}) {
  const out = {
    code: String(code || 'SKILL_FAILED').trim().toUpperCase() || 'SKILL_FAILED',
    stage: String(stage || 'unknown').trim() || 'unknown',
    retryable: Boolean(retryable),
    degrade_to: String(degrade_to || 'none').trim() || 'none',
  };
  if (message) out.message = String(message).trim().slice(0, 400);
  if (details && typeof details === 'object') out.details = details;
  return out;
}

function createSkillTelemetry({
  skill_name,
  latency_ms,
  provider = null,
  fallback_used = false,
  trace_id = '',
  success = false,
  timeout_ms = DEFAULT_SKILL_TIMEOUT_MS,
} = {}) {
  const out = {
    skill_name: normalizeSkillName(skill_name),
    latency_ms: Number.isFinite(Number(latency_ms)) ? Math.max(0, Math.round(Number(latency_ms))) : 0,
    provider: provider ? String(provider).trim().slice(0, 64) : null,
    fallback_used: Boolean(fallback_used),
    trace_id: String(trace_id || '').trim() || null,
    success: Boolean(success),
    timeout_ms: clampTimeoutMs(timeout_ms),
  };
  return out;
}

function createSkillResult({ ok, data = null, error = null, telemetry = null } = {}) {
  return {
    ok: Boolean(ok),
    data: data == null ? null : data,
    error: error && typeof error === 'object' ? error : null,
    telemetry: telemetry && typeof telemetry === 'object' ? telemetry : null,
  };
}

function normalizeThrownError(err, { stage = 'unknown' } = {}) {
  if (err && typeof err === 'object' && err.code && err.stage && err.degrade_to) {
    return createSkillError(err);
  }
  const message = err && err.message ? String(err.message) : String(err || 'unknown error');
  const code = err && err.code ? String(err.code) : 'SKILL_FAILED';
  const degradeTo = err && err.degrade_to ? String(err.degrade_to) : 'none';
  const retryable =
    Boolean(err && err.retryable) ||
    code === 'SKILL_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    /timeout/i.test(message);
  return createSkillError({
    code,
    stage,
    retryable,
    degrade_to: degradeTo,
    message,
  });
}

async function runSkill({
  skillName,
  stage,
  requestContext,
  logger = null,
  timeoutMs,
  provider = null,
  run,
} = {}) {
  const normalizedSkillName = normalizeSkillName(skillName);
  const startedAt = Date.now();
  const effectiveTimeoutMs = clampTimeoutMs(
    timeoutMs != null ? timeoutMs : requestContext && requestContext.timeout_ms,
  );

  if (typeof run !== 'function') {
    const error = createSkillError({
      code: 'SKILL_RUNNER_MISSING',
      stage: stage || normalizedSkillName,
      retryable: false,
      degrade_to: 'none',
      message: `Runner missing for ${normalizedSkillName}`,
    });
    const telemetry = createSkillTelemetry({
      skill_name: normalizedSkillName,
      latency_ms: Date.now() - startedAt,
      provider,
      success: false,
      timeout_ms: effectiveTimeoutMs,
      trace_id: requestContext && requestContext.trace_id,
    });
    return createSkillResult({ ok: false, error, telemetry });
  }

  try {
    const data = await withTimeout(
      Promise.resolve(run()),
      effectiveTimeoutMs,
      'SKILL_TIMEOUT',
    );
    const telemetry = createSkillTelemetry({
      skill_name: normalizedSkillName,
      latency_ms: Date.now() - startedAt,
      provider,
      success: true,
      timeout_ms: effectiveTimeoutMs,
      trace_id: requestContext && requestContext.trace_id,
    });
    return createSkillResult({ ok: true, data, telemetry });
  } catch (err) {
    const error = normalizeThrownError(err, { stage: stage || normalizedSkillName });
    const telemetry = createSkillTelemetry({
      skill_name: normalizedSkillName,
      latency_ms: Date.now() - startedAt,
      provider,
      success: false,
      timeout_ms: effectiveTimeoutMs,
      trace_id: requestContext && requestContext.trace_id,
      fallback_used: String(error.degrade_to || 'none') !== 'none',
    });
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        {
          skill_name: normalizedSkillName,
          code: error.code,
          stage: error.stage,
          retryable: error.retryable,
          degrade_to: error.degrade_to,
          trace_id: requestContext && requestContext.trace_id,
        },
        'aurora skills: runSkill failed',
      );
    }
    return createSkillResult({ ok: false, error, telemetry });
  }
}

module.exports = {
  DEFAULT_SKILL_TIMEOUT_MS,
  clampTimeoutMs,
  createSkillRequestContext,
  createSkillError,
  createSkillTelemetry,
  createSkillResult,
  runSkill,
};

