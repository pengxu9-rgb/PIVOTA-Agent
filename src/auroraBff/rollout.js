const crypto = require('crypto');

const ROLLOUT_VARIANT = Object.freeze({
  LEGACY: 'legacy',
  V2_CORE: 'v2_core',
  V2_SAFETY: 'v2_safety',
  V2_WEATHER: 'v2_weather',
});

const VALID_VARIANTS = new Set(Object.values(ROLLOUT_VARIANT));

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeVariant(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (VALID_VARIANTS.has(value)) return value;
  return '';
}

function hashToBucket0to99(key) {
  const stable = String(key || '').trim();
  if (!stable) return 0;
  const digest = crypto.createHash('sha256').update(stable).digest();
  const value = digest.readUInt32BE(0);
  return value % 100;
}

function firstNonEmpty(...values) {
  for (const raw of values) {
    const text = raw == null ? '' : String(raw).trim();
    if (text) return text;
  }
  return '';
}

function resolveBucketKey({ req, ctx, body, identity }) {
  const session = body && typeof body.session === 'object' && !Array.isArray(body.session) ? body.session : {};
  const headers = req && typeof req.get === 'function'
    ? {
      deviceId: req.get('X-Device-ID') || req.get('x-device-id') || '',
      anonId: req.get('X-Aurora-Anon-ID') || req.get('x-aurora-anon-id') || req.get('X-Anon-ID') || req.get('x-anon-id') || '',
      forwardedFor: req.get('X-Forwarded-For') || req.get('x-forwarded-for') || '',
      userAgent: req.get('User-Agent') || req.get('user-agent') || '',
    }
    : { deviceId: '', anonId: '', forwardedFor: '', userAgent: '' };

  const userId = firstNonEmpty(identity && identity.userId);
  if (userId) return { key: `user:${userId}`, source: 'user_id' };

  const sessionId = firstNonEmpty(
    session.session_id,
    session.sessionId,
    session.id,
    body && body.session_id,
    body && body.sessionId,
  );
  if (sessionId) return { key: `session:${sessionId}`, source: 'session_id' };

  const anonId = firstNonEmpty(
    body && body.anon_id,
    body && body.anonId,
    body && body.device_id,
    body && body.deviceId,
    session.anon_id,
    session.anonId,
    session.device_id,
    session.deviceId,
    headers.anonId,
    headers.deviceId,
    ctx && ctx.aurora_uid,
  );
  if (anonId) return { key: `anon:${anonId}`, source: 'anon_id' };

  const requestScoped = firstNonEmpty(
    headers.forwardedFor && headers.userAgent ? `${headers.forwardedFor}|${headers.userAgent}` : '',
    ctx && ctx.request_id,
  );
  return { key: `request:${requestScoped || 'unknown'}`, source: 'request_id' };
}

function resolveForcedVariant({ req }) {
  const forced = normalizeVariant(req && typeof req.get === 'function' ? req.get('x-aurora-force-variant') : '');
  if (!forced) return null;

  const envName = String(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || '').trim().toLowerCase();
  const isProduction = envName === 'production';
  if (!isProduction) return forced;

  if (!toBool(process.env.AURORA_FORCE_VARIANT_ENABLED, false)) return null;
  const expectedDebugKey = String(process.env.AURORA_FORCE_VARIANT_DEBUG_KEY || '').trim();
  if (!expectedDebugKey) return forced;
  const actualDebugKey = req && typeof req.get === 'function' ? String(req.get('x-aurora-debug-key') || '').trim() : '';
  if (!actualDebugKey || actualDebugKey !== expectedDebugKey) return null;
  return forced;
}

function resolveRolloutConfig() {
  const enabled = toBool(process.env.AURORA_ROLLOUT_ENABLED, false);
  const weatherPctRaw = clampInt(toInt(process.env.AURORA_ROLLOUT_V2_WEATHER_PCT, 1), 0, 100);
  const safetyPctRaw = clampInt(toInt(process.env.AURORA_ROLLOUT_V2_SAFETY_PCT, 1), 0, 100);
  const corePctRaw = clampInt(toInt(process.env.AURORA_ROLLOUT_V2_CORE_PCT, 5), 0, 100);

  const weatherPct = weatherPctRaw;
  const safetyPct = Math.min(safetyPctRaw, 100 - weatherPct);
  const corePct = Math.min(corePctRaw, 100 - weatherPct - safetyPct);
  return {
    enabled,
    v2_weather_pct: weatherPct,
    v2_safety_pct: safetyPct,
    v2_core_pct: corePct,
  };
}

function pickVariantForBucket(bucket, cfg) {
  const b = clampInt(toInt(bucket, 0), 0, 99);
  const weatherUpper = clampInt(cfg.v2_weather_pct, 0, 100);
  const safetyUpper = clampInt(weatherUpper + cfg.v2_safety_pct, 0, 100);
  const coreUpper = clampInt(safetyUpper + cfg.v2_core_pct, 0, 100);
  if (b < weatherUpper) return ROLLOUT_VARIANT.V2_WEATHER;
  if (b < safetyUpper) return ROLLOUT_VARIANT.V2_SAFETY;
  if (b < coreUpper) return ROLLOUT_VARIANT.V2_CORE;
  return ROLLOUT_VARIANT.LEGACY;
}

function normalizeGlobalFlags(flags) {
  const src = flags && typeof flags === 'object' ? flags : {};
  return {
    profile_v2: Boolean(src.profile_v2),
    qa_planner_v1: Boolean(src.qa_planner_v1),
    safety_engine_v1: Boolean(src.safety_engine_v1),
    travel_weather_live_v1: Boolean(src.travel_weather_live_v1),
    loop_breaker_v2: Boolean(src.loop_breaker_v2),
    chat_response_meta: Boolean(src.chat_response_meta),
  };
}

function capabilityFlagsForVariant(variant) {
  if (variant === ROLLOUT_VARIANT.V2_WEATHER) {
    return {
      profile_v2: true,
      qa_planner_v1: true,
      safety_engine_v1: true,
      travel_weather_live_v1: true,
      loop_breaker_v2: true,
    };
  }
  if (variant === ROLLOUT_VARIANT.V2_SAFETY) {
    return {
      profile_v2: true,
      qa_planner_v1: true,
      safety_engine_v1: true,
      travel_weather_live_v1: false,
      loop_breaker_v2: true,
    };
  }
  if (variant === ROLLOUT_VARIANT.V2_CORE) {
    return {
      profile_v2: true,
      qa_planner_v1: true,
      safety_engine_v1: false,
      travel_weather_live_v1: false,
      loop_breaker_v2: true,
    };
  }
  return {
    profile_v2: false,
    qa_planner_v1: false,
    safety_engine_v1: false,
    travel_weather_live_v1: false,
    loop_breaker_v2: false,
  };
}

function inferVariantFromGlobals(globals) {
  const flags = normalizeGlobalFlags(globals);
  if (flags.travel_weather_live_v1) return ROLLOUT_VARIANT.V2_WEATHER;
  if (flags.safety_engine_v1) return ROLLOUT_VARIANT.V2_SAFETY;
  if (flags.qa_planner_v1 || flags.profile_v2 || flags.loop_breaker_v2) return ROLLOUT_VARIANT.V2_CORE;
  return ROLLOUT_VARIANT.LEGACY;
}

function resolveBuildSha() {
  const candidates = [
    process.env.AURORA_CHAT_BUILD_SHA,
    process.env.RAILWAY_GIT_COMMIT_SHA,
    process.env.SOURCE_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA,
  ];
  for (const raw of candidates) {
    const value = String(raw || '').trim();
    if (value) return value;
  }
  return null;
}

function computeAuroraChatRolloutContext({ req, ctx, body, identity, globalFlags, policyVersion } = {}) {
  const globals = normalizeGlobalFlags(globalFlags);
  const cfg = resolveRolloutConfig();
  const bucketInfo = resolveBucketKey({ req, ctx, body, identity });
  const bucket = hashToBucket0to99(bucketInfo.key);
  const forcedVariant = resolveForcedVariant({ req });
  const rolloutApplied = cfg.enabled || Boolean(forcedVariant);
  const variant = forcedVariant || (cfg.enabled ? pickVariantForBucket(bucket, cfg) : inferVariantFromGlobals(globals));
  const capabilityFlags = capabilityFlagsForVariant(variant);
  const effectiveFlags = rolloutApplied
    ? {
      profile_v2: globals.profile_v2 && capabilityFlags.profile_v2,
      qa_planner_v1: globals.qa_planner_v1 && capabilityFlags.qa_planner_v1,
      safety_engine_v1: globals.safety_engine_v1 && capabilityFlags.safety_engine_v1,
      travel_weather_live_v1: globals.travel_weather_live_v1 && capabilityFlags.travel_weather_live_v1,
      loop_breaker_v2: globals.loop_breaker_v2 && capabilityFlags.loop_breaker_v2,
      chat_response_meta: globals.chat_response_meta || rolloutApplied,
    }
    : { ...globals };
  const policy =
    variant === ROLLOUT_VARIANT.LEGACY
      ? String(rolloutApplied ? 'legacy' : policyVersion || 'legacy')
      : String(policyVersion || 'aurora_chat_v2_p0');
  return {
    enabled: cfg.enabled,
    applied: rolloutApplied,
    variant,
    bucket,
    bucket_key_source: bucketInfo.source,
    forced_variant: forcedVariant || null,
    policy_version: policy,
    build_sha: resolveBuildSha(),
    config: cfg,
    effective_flags: effectiveFlags,
  };
}

module.exports = {
  ROLLOUT_VARIANT,
  computeAuroraChatRolloutContext,
  __internal: {
    toBool,
    toInt,
    clampInt,
    normalizeVariant,
    hashToBucket0to99,
    resolveBucketKey,
    resolveForcedVariant,
    resolveRolloutConfig,
    pickVariantForBucket,
    capabilityFlagsForVariant,
    normalizeGlobalFlags,
    resolveBuildSha,
    inferVariantFromGlobals,
  },
};
