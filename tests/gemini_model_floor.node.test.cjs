const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NON_IMAGE_GEMINI_FLOOR_MODEL,
  TEMPORARY_UNIFIED_GEMINI_MODEL,
  TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL,
  isGeminiImageGenerationModel,
  isTemporaryUnifiedGeminiModelEnabled,
  resolveNonImageGeminiModel,
  resolveGeminiRuntimeModelName,
  resetGeminiModelFloorWarningsForTest,
} = require('../src/lib/geminiModelFloor');

function withTemporaryUnifiedModelEnabled(fn) {
  const previous = process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
  process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = 'true';
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
    else process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = previous;
  }
}

test('resolveNonImageGeminiModel unifies legacy non-image Gemini models to the temporary production model', () => {
  const resolved = withTemporaryUnifiedModelEnabled(() => {
    resetGeminiModelFloorWarningsForTest();
    return resolveNonImageGeminiModel({
      model: 'gemini-2.0-flash',
      fallbackModel: 'gemini-3-pro-preview',
      envSource: 'TEST_MODEL',
      callPath: 'unit_test',
    });
  });

  assert.equal(resolved.adjusted, true);
  assert.equal(resolved.effectiveModel, TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL);
  assert.equal(resolved.configuredModel, 'gemini-2.0-flash');
});

test('resolveNonImageGeminiModel also unifies Gemini 3+ models while the temporary policy is enabled', () => {
  const resolved = withTemporaryUnifiedModelEnabled(() => {
    resetGeminiModelFloorWarningsForTest();
    return resolveNonImageGeminiModel({
      model: 'gemini-3-pro-preview',
      fallbackModel: NON_IMAGE_GEMINI_FLOOR_MODEL,
      envSource: 'TEST_MODEL',
      callPath: 'unit_test',
    });
  });

  assert.equal(resolved.adjusted, true);
  assert.equal(resolved.effectiveModel, TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL);
});

test('bare temporary Gemini preview alias is canonicalized to the API runtime model', () => {
  assert.equal(resolveGeminiRuntimeModelName(TEMPORARY_UNIFIED_GEMINI_MODEL), TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL);
  const resolved = withTemporaryUnifiedModelEnabled(() => {
    resetGeminiModelFloorWarningsForTest();
    return resolveNonImageGeminiModel({
      model: TEMPORARY_UNIFIED_GEMINI_MODEL,
      fallbackModel: NON_IMAGE_GEMINI_FLOOR_MODEL,
      envSource: 'TEST_MODEL',
      callPath: 'unit_test',
    });
  });
  assert.equal(resolved.configuredModel, TEMPORARY_UNIFIED_GEMINI_MODEL);
  assert.equal(resolved.effectiveModel, TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL);
});

test('temporary unified Gemini model policy is enabled by explicit env', () => {
  withTemporaryUnifiedModelEnabled(() => {
    assert.equal(isTemporaryUnifiedGeminiModelEnabled(), true);
  });
});

test('temporary unified Gemini model policy is enabled by production-like runtime env', () => {
  const previous = process.env.NODE_ENV;
  delete process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
  delete process.env.PIVOTA_TEMP_GEMINI_25_FLASH_ENABLED;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(isTemporaryUnifiedGeminiModelEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('resolveNonImageGeminiModel falls back when shared model config points at a non-Gemini model', () => {
  resetGeminiModelFloorWarningsForTest();
  const resolved = resolveNonImageGeminiModel({
    model: 'gpt-5.1-mini',
    fallbackModel: NON_IMAGE_GEMINI_FLOOR_MODEL,
    envSource: 'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI',
    callPath: 'unit_test',
  });

  assert.equal(resolved.adjusted, true);
  assert.equal(resolved.configuredModel, 'gpt-5.1-mini');
  assert.equal(resolved.effectiveModel, TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL);
});

test('resolveNonImageGeminiModel can disable the temporary unified model policy via env', () => {
  resetGeminiModelFloorWarningsForTest();
  const previous = process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
  process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = 'false';
  try {
    const resolved = resolveNonImageGeminiModel({
      model: 'gemini-3-pro-preview',
      fallbackModel: NON_IMAGE_GEMINI_FLOOR_MODEL,
      envSource: 'TEST_MODEL',
      callPath: 'unit_test',
    });
    assert.equal(resolved.adjusted, false);
    assert.equal(resolved.effectiveModel, 'gemini-3-pro-preview');
  } finally {
    if (previous === undefined) delete process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED;
    else process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED = previous;
  }
});

test('image-generation Gemini models are excluded from the non-image floor logic', () => {
  resetGeminiModelFloorWarningsForTest();
  assert.equal(isGeminiImageGenerationModel('gemini-3.1-flash-image-preview'), true);

  const resolved = resolveNonImageGeminiModel({
    model: 'gemini-2.5-flash-image-preview',
    fallbackModel: NON_IMAGE_GEMINI_FLOOR_MODEL,
    envSource: 'TEST_MODEL',
    callPath: 'unit_test',
  });

  assert.equal(resolved.adjusted, false);
  assert.equal(resolved.effectiveModel, 'gemini-2.5-flash-image-preview');
});
