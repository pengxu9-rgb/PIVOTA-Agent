/**
 * credentialProbeState() - the readiness answer /healthz/gemini depends on.
 *
 * This exercises the REAL exported function. An earlier version of this file re-implemented the
 * endpoint's predicate as a local helper and asserted against that, which proved only that the
 * test agreed with itself: reverting the shipped code left all of it green. A test that cannot
 * fail when the thing it names is broken is worse than no test, because it is counted as coverage.
 *
 * The case that matters most is CLOUD_RUN_MARKER_ONLY. credentialSourceConfigured() returns true
 * on the bare presence of K_SERVICE, which Cloud Run injects into every container, so a service
 * with no credential whatsoever looks configured. If this function ever answers 'ok' there,
 * /healthz/gemini reports green on a gateway whose every Gemini call 403s.
 */
const test = require('node:test');
const assert = require('node:assert');

const vertexGemini = require('../src/llm/vertexGemini');

const ENV_KEYS = [
  'VERTEX_AI_ENABLED',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'K_SERVICE',
  'GAE_SERVICE',
  'GCE_METADATA_HOST',
];

/** Run fn with exactly `patch` set and every other credential-shaped var cleared. */
function withEnv(patch, fn) {
  const previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(patch)) process.env[key] = String(value);
  // The module memoises the auth client and the probe result across calls; without this a
  // resolved probe from one case would answer every later one.
  vertexGemini.resetCredentialsCache();
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
    vertexGemini.resetCredentialsCache();
  }
}

test('vertex off is not applicable, whatever else is set', () => {
  const state = withEnv({ GOOGLE_CLOUD_PROJECT: 'p', K_SERVICE: 'gateway' }, () =>
    vertexGemini.credentialProbeState(),
  );
  assert.strictEqual(state, 'not_applicable');
});

test('vertex on with no project fails rather than waiting on a probe', () => {
  const state = withEnv({ VERTEX_AI_ENABLED: 'true' }, () => vertexGemini.credentialProbeState());
  assert.strictEqual(state, 'failed');
});

test('a malformed inline credential fails synchronously', () => {
  const state = withEnv(
    {
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'pivota-prod',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: '{not json',
    },
    () => vertexGemini.credentialProbeState(),
  );
  assert.strictEqual(state, 'failed');
});

test('CLOUD_RUN_MARKER_ONLY: K_SERVICE with no credential is never ok', () => {
  // The regression this file exists for. K_SERVICE alone satisfies
  // credentialSourceConfigured(), so anything deriving readiness from configuration reports
  // healthy here - on a container that cannot mint a token.
  const state = withEnv(
    { VERTEX_AI_ENABLED: 'true', GOOGLE_CLOUD_PROJECT: 'pivota-prod', K_SERVICE: 'gateway' },
    () => vertexGemini.credentialProbeState(),
  );
  assert.notStrictEqual(state, 'ok');
  assert.strictEqual(state, 'pending');
});

test('the call gate still says available there - the two answer different questions', () => {
  // Not a redundant assertion: it pins the reason credentialProbeState() had to exist. If
  // credentialsAvailable() is ever "fixed" to fail closed here it would gate off every Gemini
  // call on Cloud Run, so the divergence is deliberate and must stay visible.
  const available = withEnv(
    { VERTEX_AI_ENABLED: 'true', GOOGLE_CLOUD_PROJECT: 'pivota-prod', K_SERVICE: 'gateway' },
    () => vertexGemini.credentialsAvailable(null),
  );
  assert.strictEqual(available, true);
});

test('missingCredentialMessage names the Vertex problem, not GEMINI_API_KEY', () => {
  const message = withEnv({ VERTEX_AI_ENABLED: 'true' }, () =>
    vertexGemini.missingCredentialMessage(),
  );
  assert.match(message, /GOOGLE_CLOUD_PROJECT/);
  assert.doesNotMatch(message, /GEMINI_API_KEY/);
});
