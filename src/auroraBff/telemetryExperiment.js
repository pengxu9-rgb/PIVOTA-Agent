function normalizeMetricToken(value, fallback = 'unknown') {
  const token = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || fallback;
}

function emitSkillTelemetry({ logger, requestContext, result } = {}) {
  if (!logger || typeof logger.info !== 'function') return;
  const telemetry = result && result.telemetry && typeof result.telemetry === 'object' ? result.telemetry : null;
  if (!telemetry) return;

  const skill = normalizeMetricToken(telemetry.skill_name);
  const status = result && result.ok ? 'ok' : 'fail';
  const provider = normalizeMetricToken(telemetry.provider, 'none');
  const traceId = requestContext && requestContext.trace_id ? String(requestContext.trace_id) : null;
  const requestId = requestContext && requestContext.request_id ? String(requestContext.request_id) : null;

  logger.info(
    {
      kind: 'metric',
      name: `aurora.skill.${skill}.latency_ms`,
      value: Number.isFinite(Number(telemetry.latency_ms)) ? Number(telemetry.latency_ms) : 0,
    },
    'metric',
  );
  logger.info(
    {
      kind: 'metric',
      name: `aurora.skill.${skill}.${status}`,
      value: 1,
    },
    'metric',
  );
  logger.info(
    {
      kind: 'metric',
      name: `aurora.skill.${skill}.provider.${provider}.${status}`,
      value: 1,
    },
    'metric',
  );

  logger.info(
    {
      kind: 'skill_trace',
      request_id: requestId,
      trace_id: traceId,
      skill_name: skill,
      status,
      provider: telemetry.provider || null,
      latency_ms: Number.isFinite(Number(telemetry.latency_ms)) ? Number(telemetry.latency_ms) : 0,
      timeout_ms: telemetry.timeout_ms || null,
      fallback_used: Boolean(telemetry.fallback_used),
      error_code: result && result.error && result.error.code ? String(result.error.code) : null,
      degrade_to: result && result.error && result.error.degrade_to ? String(result.error.degrade_to) : null,
    },
    'aurora skills: telemetry',
  );
}

module.exports = {
  emitSkillTelemetry,
};

