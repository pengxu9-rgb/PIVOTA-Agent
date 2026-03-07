const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NON_IMAGE_GEMINI_FLOOR_MODEL,
  isGeminiImageGenerationModel,
  resolveNonImageGeminiModel,
  resetGeminiModelFloorWarningsForTest,
} = require('../src/lib/geminiModelFloor');

test('resolveNonImageGeminiModel auto-upgrades legacy non-image Gemini models to the 3.x floor', () => {
  resetGeminiModelFloorWarningsForTest();
  const resolved = resolveNonImageGeminiModel({
    model: 'gemini-2.0-flash',
    fallbackModel: 'gemini-3-pro-preview',
    envSource: 'TEST_MODEL',
    callPath: 'unit_test',
  });

  assert.equal(resolved.adjusted, true);
  assert.equal(resolved.effectiveModel, NON_IMAGE_GEMINI_FLOOR_MODEL);
  assert.equal(resolved.configuredModel, 'gemini-2.0-flash');
});

test('resolveNonImageGeminiModel keeps Gemini 3+ models unchanged', () => {
  resetGeminiModelFloorWarningsForTest();
  const resolved = resolveNonImageGeminiModel({
    model: 'gemini-3-pro-preview',
    fallbackModel: NON_IMAGE_GEMINI_FLOOR_MODEL,
    envSource: 'TEST_MODEL',
    callPath: 'unit_test',
  });

  assert.equal(resolved.adjusted, false);
  assert.equal(resolved.effectiveModel, 'gemini-3-pro-preview');
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
