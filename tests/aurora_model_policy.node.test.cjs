const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AURORA_MODEL_POLICY_VERSION,
  resolveAuroraGeminiMainlineModel,
  resolveAuroraPublicLlmRoute,
  validateAuroraModelSelection,
} = require('../src/auroraBff/auroraModelPolicy');

test('aurora model policy unifies explicit Gemini models to the temporary production model', () => {
  const previous = process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
  process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = 'true';
  const resolved = resolveAuroraGeminiMainlineModel({
    configuredModel: 'gemini-2.0-flash',
    fallbackModel: 'gemini-3-flash-preview',
    envSource: 'TEST_GEMINI_MODEL',
    callPath: 'aurora_mainline_test',
  });
  if (previous === undefined) delete process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
  else process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = previous;

  assert.equal(resolved.requested_model, 'gemini-2.5-flash-preview');
  assert.equal(resolved.effective_model, 'gemini-2.5-flash-preview');
  assert.equal(resolved.configured_model, 'gemini-2.0-flash');
  assert.equal(resolved.selection_source, 'temporary_unified_gemini_model');
  assert.equal(resolved.policy_version, AURORA_MODEL_POLICY_VERSION);
});

test('aurora model policy blocks public llm override in production-like mode', () => {
  const previous = process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
  process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = 'true';
  const resolved = resolveAuroraPublicLlmRoute({
    requestedProvider: 'openai',
    requestedModel: 'gpt-4o-mini',
    headerProvider: 'gemini',
    headerModel: 'gemini-2.5-flash',
    defaultProvider: 'gemini',
    defaultModel: 'gemini-3-flash-preview',
    productionLike: true,
  });
  if (previous === undefined) delete process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
  else process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = previous;

  assert.equal(resolved.override_allowed, false);
  assert.equal(resolved.llm_provider, 'gemini');
  assert.equal(resolved.llm_model, 'gemini-2.5-flash-preview');
  assert.equal(resolved.selection_source, 'configured_default');
});

test('aurora model policy reports requested/effective mismatches as policy violations', () => {
  const result = validateAuroraModelSelection({
    requestedProvider: 'gemini',
    requestedModel: 'gemini-3-flash-preview',
    effectiveProvider: 'gemini',
    effectiveModel: 'gemini-3-pro-preview',
    selectionSource: 'upstream_response',
  });

  assert.equal(result.ok, false);
  assert.equal(result.selection_source, 'policy_violation_blocked');
  assert.equal(result.requested_model, 'gemini-3-flash-preview');
  assert.equal(result.effective_model, 'gemini-3-pro-preview');
});
