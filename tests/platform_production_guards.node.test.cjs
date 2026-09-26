'use strict';

/**
 * The production guards that used to be spelled `RAILWAY_ENVIRONMENT === 'production'`,
 * driven through all three deployment shapes.
 *
 * Production sets NO NODE_ENV, so for each of these `RAILWAY_ENVIRONMENT` was the arm
 * actually carrying the guard. On Cloud Run that variable is unset, and a missed read
 * does not fail loudly — it silently answers "not production" and turns the guard OFF
 * exactly where it matters. These cases exist so a future edit cannot do that quietly.
 *
 * Every guard is asserted in three environments:
 *   (a) RAILWAY_ENVIRONMENT=production            — today's production
 *   (b) K_SERVICE + PIVOTA_ENV=production, no RAILWAY_* — the Cloud Run target
 *   (c) K_SERVICE alone, nothing naming the env   — the misconfigured deploy; FAIL CLOSED
 * ...and, as the other side of the contract, in a plain local environment where the guard
 * must NOT fire. Without that fourth case a guard hard-wired to `true` would pass (a)-(c).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resetPlatformWarnings } = require('../src/config/platform');

/** Every var any of these guards can read. Cleared before each case. */
const PLATFORM_KEYS = [
  'PIVOTA_ENV', 'PIVOTA_PLATFORM',
  'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_NAME',
  'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_GIT_COMMIT_SHA',
  'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION',
  'NODE_ENV', 'APP_ENV', 'VERCEL_ENV',
];

/** (a) Railway production, as prod actually looks — note the absent NODE_ENV. */
const RAILWAY_PRODUCTION = { RAILWAY_ENVIRONMENT: 'production', RAILWAY_SERVICE_NAME: 'PIVOTA-Agent' };
/** (b) Cloud Run production. Nothing here starts with RAILWAY_. */
const CLOUD_RUN_PRODUCTION = { K_SERVICE: 'pivota-agent-gateway', PIVOTA_ENV: 'production' };
/** (c) Cloud Run, environment unnamed. The guard must still fire. */
const CLOUD_RUN_UNNAMED = { K_SERVICE: 'pivota-agent-gateway' };
/** The negative control: a laptop. The guard must NOT fire. */
const LOCAL_DEV = {};

const PRODUCTION_SHAPES = [
  ['(a) Railway production', RAILWAY_PRODUCTION],
  ['(b) Cloud Run + PIVOTA_ENV=production, no RAILWAY_*', CLOUD_RUN_PRODUCTION],
  ['(c) Cloud Run alone, environment unnamed (fail closed)', CLOUD_RUN_UNNAMED],
];

function withEnv(overrides, fn) {
  const saved = new Map();
  const keys = new Set([...PLATFORM_KEYS, ...Object.keys(overrides)]);
  for (const key of keys) saved.set(key, process.env[key]);
  for (const key of PLATFORM_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPlatformWarnings();
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPlatformWarnings();
  }
}

/** Re-evaluate a module's top level under the current env (its guards run at import). */
function freshRequire(relativePath) {
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  try {
    return require(resolved);
  } finally {
    delete require.cache[resolved];
  }
}

// ---------------------------------------------------------------------------
// auroraBff/rollout.js — the forced-variant header refusal.
//
// The strongest of these, because it is asserted through real behaviour rather than
// through the predicate: outside production `x-aurora-force-variant` is honoured, and in
// production it is refused unless AURORA_FORCE_VARIANT_ENABLED is set. If this guard goes
// quiet, any caller can pin their own rollout variant in production by sending a header.
// ---------------------------------------------------------------------------

const { __internal: rolloutInternal } = require('../src/auroraBff/rollout');

function reqWithForcedVariant(variant, debugKey) {
  const headers = { 'x-aurora-force-variant': variant };
  if (debugKey !== undefined) headers['x-aurora-debug-key'] = debugKey;
  return { get: (name) => headers[String(name).toLowerCase()] };
}

for (const [label, shape] of PRODUCTION_SHAPES) {
  test(`rollout forced-variant header is REFUSED in production ${label}`, () => {
    withEnv({ ...shape, AURORA_FORCE_VARIANT_ENABLED: undefined }, () => {
      assert.equal(
        rolloutInternal.resolveForcedVariant({ req: reqWithForcedVariant('v2_core') }),
        null,
        'a forced variant must not be honoured in production without an explicit enable',
      );
    });
  });
}

test('rollout forced-variant header IS honoured outside production (the negative control)', () => {
  withEnv(LOCAL_DEV, () => {
    assert.equal(
      rolloutInternal.resolveForcedVariant({ req: reqWithForcedVariant('v2_core') }),
      'v2_core',
    );
  });
  withEnv({ RAILWAY_ENVIRONMENT: 'staging' }, () => {
    assert.equal(
      rolloutInternal.resolveForcedVariant({ req: reqWithForcedVariant('v2_safety') }),
      'v2_safety',
    );
  });
});

test('rollout forced-variant escape hatch still works in production when explicitly enabled', () => {
  // The guard is a refusal, not a ban: an operator who sets the flag and the debug key
  // keeps the override. Pinning this stops a "fix" that simply removes the escape hatch.
  withEnv(
    { ...CLOUD_RUN_PRODUCTION, AURORA_FORCE_VARIANT_ENABLED: 'true', AURORA_FORCE_VARIANT_DEBUG_KEY: 's3cret' },
    () => {
      assert.equal(
        rolloutInternal.resolveForcedVariant({ req: reqWithForcedVariant('v2_core', 's3cret') }),
        'v2_core',
      );
      assert.equal(
        rolloutInternal.resolveForcedVariant({ req: reqWithForcedVariant('v2_core', 'wrong') }),
        null,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// auroraBff/auroraDecisionClient.js — mock upstreams must never serve production.
//
// USE_AURORA_MOCK is a module-level const and is not exported, so the guard is observed
// through the warning the module emits at import time when it refuses the request. The
// module is re-required per case so its top level re-evaluates under that environment.
// ---------------------------------------------------------------------------

const DECISION_CLIENT = path.join('..', 'src', 'auroraBff', 'auroraDecisionClient');

function captureImportWarnings(relativePath) {
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { messages.push(args.map(String).join(' ')); };
  try {
    freshRequire(relativePath);
  } finally {
    console.warn = originalWarn;
  }
  return messages;
}

for (const [label, shape] of PRODUCTION_SHAPES) {
  test(`aurora decision client REFUSES the mock upstream in production ${label}`, () => {
    withEnv({ ...shape, AURORA_BFF_USE_MOCK: 'true', NODE_TEST_CONTEXT: 'child-v8' }, () => {
      const warnings = captureImportWarnings(DECISION_CLIENT);
      assert.ok(
        warnings.some((m) => m.includes('Ignoring AURORA_BFF_USE_MOCK in production-like environment')),
        `expected the production refusal warning; got ${JSON.stringify(warnings)}`,
      );
    });
  });
}

test('aurora decision client ACCEPTS the mock under a plain test runtime (the negative control)', () => {
  withEnv({ AURORA_BFF_USE_MOCK: 'true', NODE_ENV: 'test' }, () => {
    const warnings = captureImportWarnings(DECISION_CLIENT);
    assert.equal(
      warnings.some((m) => m.includes('in production-like environment')),
      false,
      'a test runtime with no production signal must not trip the production refusal',
    );
  });
});

// ---------------------------------------------------------------------------
// auroraBff/routes.js — the same refusal for the BFF's own mock, plus the
// shared-truth self-base default that flips on in production.
// ---------------------------------------------------------------------------

const { __internal: routesInternal } = require('../src/auroraBff/routes');

for (const [label, shape] of PRODUCTION_SHAPES) {
  test(`aurora BFF production predicate fires in production ${label}`, () => {
    withEnv(shape, () => {
      assert.equal(routesInternal.isProductionLikeAuroraBffEnv(), true);
    });
  });

  test(`aurora BFF shared-truth self-base defaults ON in production ${label}`, () => {
    // Unset flag => the default is "whatever production says". If the production
    // predicate goes quiet, this silently defaults OFF in prod and the self-base URL
    // derivation stops.
    withEnv({ ...shape, AURORA_BFF_BEAUTY_SHARED_TRUTH_SELF_BASE_ENABLED: undefined }, () => {
      assert.equal(routesInternal.isAuroraBeautySharedTruthSelfBaseEnabled(), true);
    });
  });
}

test('aurora BFF production predicate does NOT fire locally, and the explicit flag still wins', () => {
  withEnv(LOCAL_DEV, () => {
    assert.equal(routesInternal.isProductionLikeAuroraBffEnv(), false);
    assert.equal(routesInternal.isAuroraBeautySharedTruthSelfBaseEnabled(), false);
  });
  withEnv({ RAILWAY_ENVIRONMENT: 'staging' }, () => {
    assert.equal(routesInternal.isProductionLikeAuroraBffEnv(), false);
  });
  // An explicit flag outranks the environment default in both directions.
  withEnv({ AURORA_BFF_BEAUTY_SHARED_TRUTH_SELF_BASE_ENABLED: 'true' }, () => {
    assert.equal(routesInternal.isAuroraBeautySharedTruthSelfBaseEnabled(), true);
  });
  withEnv({ ...RAILWAY_PRODUCTION, AURORA_BFF_BEAUTY_SHARED_TRUTH_SELF_BASE_ENABLED: 'false' }, () => {
    assert.equal(routesInternal.isAuroraBeautySharedTruthSelfBaseEnabled(), false);
  });
});

test('aurora BFF test-runtime predicate tracks the runner, not the platform', () => {
  withEnv({ NODE_ENV: 'test' }, () => {
    assert.equal(routesInternal.isTestLikeAuroraBffEnv(), true);
  });
  // NODE_TEST_CONTEXT is set by the node:test runner itself and is a legitimate
  // test-runtime signal, so it must be cleared to observe the non-test answer.
  withEnv({ ...RAILWAY_PRODUCTION, NODE_TEST_CONTEXT: undefined }, () => {
    assert.equal(routesInternal.isTestLikeAuroraBffEnv(), false);
  });
});

// ---------------------------------------------------------------------------
// lib/geminiModelFloor.js — the model-floor policy's production default.
// ---------------------------------------------------------------------------

const geminiModelFloor = require('../src/lib/geminiModelFloor');

for (const [label, shape] of PRODUCTION_SHAPES) {
  test(`gemini model floor reads production ${label}`, () => {
    withEnv(shape, () => {
      assert.equal(geminiModelFloor.isProductionLikeRuntime(), true);
      // The observable consequence: the unified model policy defaults ON in production.
      withEnv({ ...shape, PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED: undefined }, () => {
        assert.equal(geminiModelFloor.isTemporaryUnifiedGeminiModelEnabled(), true);
      });
    });
  });
}

test('gemini model floor does not read production locally, and keeps its APP_ENV arm', () => {
  withEnv(LOCAL_DEV, () => {
    assert.equal(geminiModelFloor.isProductionLikeRuntime(), false);
    assert.equal(geminiModelFloor.isTemporaryUnifiedGeminiModelEnabled(), false);
  });
  // APP_ENV and PIVOTA_ENV were arms of this predicate before the shim; they must remain.
  withEnv({ APP_ENV: 'prod' }, () => {
    assert.equal(geminiModelFloor.isProductionLikeRuntime(), true);
  });
  withEnv({ PIVOTA_ENV: 'production' }, () => {
    assert.equal(geminiModelFloor.isProductionLikeRuntime(), true);
  });
  withEnv({ RAILWAY_ENVIRONMENT_NAME: 'production' }, () => {
    assert.equal(geminiModelFloor.isProductionLikeRuntime(), true);
  });
});

// ---------------------------------------------------------------------------
// The boot assertion.
// ---------------------------------------------------------------------------

test('requirePlatformEnv passes on both platforms and throws only on the unnamed deploy', () => {
  const { requirePlatformEnv } = require('../src/config/platform');
  withEnv(RAILWAY_PRODUCTION, () => {
    assert.equal(requirePlatformEnv().env, 'production');
  });
  withEnv(CLOUD_RUN_PRODUCTION, () => {
    assert.equal(requirePlatformEnv().env, 'production');
    assert.equal(requirePlatformEnv().platform, 'cloud_run');
  });
  withEnv(LOCAL_DEV, () => {
    assert.equal(requirePlatformEnv().env, 'development');
  });
  withEnv(CLOUD_RUN_UNNAMED, () => {
    assert.throws(() => requirePlatformEnv(), /PLATFORM_ENV_UNRESOLVED/);
  });
});
