const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLLOUT_VARIANT,
  computeAuroraChatRolloutContext,
  __internal,
} = require('../src/auroraBff/rollout');

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function makeReq(headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    get(name) {
      return map.get(String(name || '').toLowerCase()) || undefined;
    },
  };
}

test('hash bucket is deterministic for same key', () => {
  const a = __internal.hashToBucket0to99('session:abc');
  const b = __internal.hashToBucket0to99('session:abc');
  const c = __internal.hashToBucket0to99('session:def');

  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 99);
  assert.ok(c >= 0 && c <= 99);
});

test('rollout disabled preserves global flags (no forced legacy downgrade)', () => {
  return withEnv(
    {
      AURORA_ROLLOUT_ENABLED: 'false',
      AURORA_ROLLOUT_V2_CORE_PCT: undefined,
      AURORA_ROLLOUT_V2_SAFETY_PCT: undefined,
      AURORA_ROLLOUT_V2_WEATHER_PCT: undefined,
    },
    () => {
      const out = computeAuroraChatRolloutContext({
        req: makeReq(),
        ctx: { request_id: 'r1' },
        body: { session: { session_id: 'sess_1' } },
        globalFlags: {
          profile_v2: true,
          qa_planner_v1: true,
          safety_engine_v1: true,
          travel_weather_live_v1: false,
          loop_breaker_v2: true,
          chat_response_meta: false,
        },
        policyVersion: 'aurora_chat_v2_p0',
      });

      assert.equal(out.applied, false);
      assert.equal(out.variant, ROLLOUT_VARIANT.V2_SAFETY);
      assert.equal(out.effective_flags.profile_v2, true);
      assert.equal(out.effective_flags.qa_planner_v1, true);
      assert.equal(out.effective_flags.safety_engine_v1, true);
      assert.equal(out.effective_flags.travel_weather_live_v1, false);
      assert.equal(out.effective_flags.loop_breaker_v2, true);
      assert.equal(out.policy_version, 'aurora_chat_v2_p0');
    },
  );
});

test('variant boundary mapping follows weather->safety->core->legacy', () => {
  const cfg = {
    v2_weather_pct: 1,
    v2_safety_pct: 1,
    v2_core_pct: 5,
  };
  assert.equal(__internal.pickVariantForBucket(0, cfg), ROLLOUT_VARIANT.V2_WEATHER);
  assert.equal(__internal.pickVariantForBucket(1, cfg), ROLLOUT_VARIANT.V2_SAFETY);
  assert.equal(__internal.pickVariantForBucket(2, cfg), ROLLOUT_VARIANT.V2_CORE);
  assert.equal(__internal.pickVariantForBucket(6, cfg), ROLLOUT_VARIANT.V2_CORE);
  assert.equal(__internal.pickVariantForBucket(7, cfg), ROLLOUT_VARIANT.LEGACY);
});

test('forced variant in production requires debug key when configured', () => {
  return withEnv(
    {
      NODE_ENV: 'production',
      AURORA_FORCE_VARIANT_ENABLED: 'true',
      AURORA_FORCE_VARIANT_DEBUG_KEY: 'secret',
    },
    () => {
      const blocked = __internal.resolveForcedVariant({
        req: makeReq({ 'x-aurora-force-variant': 'v2_weather', 'x-aurora-debug-key': 'wrong' }),
      });
      const allowed = __internal.resolveForcedVariant({
        req: makeReq({ 'x-aurora-force-variant': 'v2_weather', 'x-aurora-debug-key': 'secret' }),
      });

      assert.equal(blocked, null);
      assert.equal(allowed, ROLLOUT_VARIANT.V2_WEATHER);
    },
  );
});

test('forced variant applies capability gating when rollout split is active', () => {
  return withEnv(
    {
      NODE_ENV: 'development',
      AURORA_ROLLOUT_ENABLED: 'true',
      AURORA_ROLLOUT_V2_CORE_PCT: '5',
      AURORA_ROLLOUT_V2_SAFETY_PCT: '1',
      AURORA_ROLLOUT_V2_WEATHER_PCT: '1',
    },
    () => {
      const out = computeAuroraChatRolloutContext({
        req: makeReq({ 'x-aurora-force-variant': 'v2_core' }),
        ctx: { request_id: 'r2' },
        body: { session: { session_id: 'sess_2' } },
        globalFlags: {
          profile_v2: true,
          qa_planner_v1: true,
          safety_engine_v1: true,
          travel_weather_live_v1: true,
          loop_breaker_v2: true,
          chat_response_meta: false,
        },
        policyVersion: 'aurora_chat_v2_p0',
      });

      assert.equal(out.applied, true);
      assert.equal(out.variant, ROLLOUT_VARIANT.V2_CORE);
      assert.equal(out.effective_flags.profile_v2, true);
      assert.equal(out.effective_flags.qa_planner_v1, true);
      assert.equal(out.effective_flags.loop_breaker_v2, true);
      assert.equal(out.effective_flags.safety_engine_v1, false);
      assert.equal(out.effective_flags.travel_weather_live_v1, false);
      assert.equal(out.effective_flags.chat_response_meta, true);
    },
  );
});
