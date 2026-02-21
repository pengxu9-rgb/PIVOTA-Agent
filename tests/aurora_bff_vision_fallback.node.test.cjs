const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadRoutesModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return function OpenAIStub() {
        return {};
      };
    }
    if (request === 'busboy') {
      return function BusboyStub() {
        return {};
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const moduleId = require.resolve('../src/auroraBff/routes');
  try {
    delete require.cache[moduleId];
    const mod = require('../src/auroraBff/routes');
    return { moduleId, mod };
  } finally {
    Module._load = originalLoad;
  }
}

test('vision fallback: gemini failure falls back to openai once when allowed', async (t) => {
  const { moduleId, mod } = loadRoutesModule();
  const { __internal } = mod;
  let geminiCalls = 0;
  let openaiCalls = 0;

  __internal.__setVisionRunnersForTest({
    gemini: async () => {
      geminiCalls += 1;
      return {
        ok: false,
        provider: 'gemini',
        reason: 'VISION_TIMEOUT',
      };
    },
    openai: async () => {
      openaiCalls += 1;
      return {
        ok: true,
        provider: 'openai',
        analysis: {
          summary: 'fallback analysis',
          findings: [],
          confidence: 0.62,
        },
      };
    },
  });

  t.after(() => {
    __internal.__resetVisionRunnersForTest();
    delete require.cache[moduleId];
  });

  const out = await __internal.runVisionSkinAnalysis({
    provider: 'gemini',
    llmKillSwitch: false,
    photoQuality: { grade: 'pass' },
    language: 'EN',
    imageBuffer: Buffer.from('x'),
  });

  assert.equal(geminiCalls, 1);
  assert.equal(openaiCalls, 1);
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'openai');
  assert.equal(out.fallback_from, 'gemini');
  assert.deepEqual(out.attempted_providers, ['gemini', 'openai']);
});

test('vision fallback: kill switch prevents openai fallback', async (t) => {
  const { moduleId, mod } = loadRoutesModule();
  const { __internal } = mod;
  let geminiCalls = 0;
  let openaiCalls = 0;

  __internal.__setVisionRunnersForTest({
    gemini: async () => {
      geminiCalls += 1;
      return {
        ok: false,
        provider: 'gemini',
        reason: 'VISION_TIMEOUT',
      };
    },
    openai: async () => {
      openaiCalls += 1;
      return {
        ok: true,
        provider: 'openai',
        analysis: { summary: 'should not be called', findings: [], confidence: 0.6 },
      };
    },
  });

  t.after(() => {
    __internal.__resetVisionRunnersForTest();
    delete require.cache[moduleId];
  });

  const out = await __internal.runVisionSkinAnalysis({
    provider: 'gemini',
    llmKillSwitch: true,
    photoQuality: { grade: 'pass' },
    language: 'EN',
    imageBuffer: Buffer.from('x'),
  });

  assert.equal(geminiCalls, 1);
  assert.equal(openaiCalls, 0);
  assert.equal(out.ok, false);
  assert.equal(out.provider, 'gemini');
  assert.deepEqual(out.attempted_providers, ['gemini']);
});

test('vision fallback: photo quality fail prevents openai fallback', async (t) => {
  const { moduleId, mod } = loadRoutesModule();
  const { __internal } = mod;
  let geminiCalls = 0;
  let openaiCalls = 0;

  __internal.__setVisionRunnersForTest({
    gemini: async () => {
      geminiCalls += 1;
      return {
        ok: false,
        provider: 'gemini',
        reason: 'VISION_UPSTREAM_5XX',
      };
    },
    openai: async () => {
      openaiCalls += 1;
      return {
        ok: true,
        provider: 'openai',
        analysis: { summary: 'should not be called', findings: [], confidence: 0.6 },
      };
    },
  });

  t.after(() => {
    __internal.__resetVisionRunnersForTest();
    delete require.cache[moduleId];
  });

  const out = await __internal.runVisionSkinAnalysis({
    provider: 'gemini',
    llmKillSwitch: false,
    photoQuality: { grade: 'fail' },
    language: 'EN',
    imageBuffer: Buffer.from('x'),
  });

  assert.equal(geminiCalls, 1);
  assert.equal(openaiCalls, 0);
  assert.equal(out.ok, false);
  assert.equal(out.provider, 'gemini');
  assert.deepEqual(out.attempted_providers, ['gemini']);
});

test('fallback decision helper: only pass/degraded and kill switch off can fallback', async () => {
  const { moduleId, mod } = loadRoutesModule();
  const { __internal } = mod;
  try {
    assert.equal(__internal.shouldAttemptOpenAiFallbackFromGemini({ photoQuality: { grade: 'pass' }, llmKillSwitch: false }), true);
    assert.equal(
      __internal.shouldAttemptOpenAiFallbackFromGemini({ photoQuality: { grade: 'degraded' }, llmKillSwitch: false }),
      true,
    );
    assert.equal(__internal.shouldAttemptOpenAiFallbackFromGemini({ photoQuality: { grade: 'fail' }, llmKillSwitch: false }), false);
    assert.equal(__internal.shouldAttemptOpenAiFallbackFromGemini({ photoQuality: { grade: 'pass' }, llmKillSwitch: true }), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('vision fallback: gemini + openai both fail returns fallback_failure contract fields', async (t) => {
  const { moduleId, mod } = loadRoutesModule();
  const { __internal } = mod;
  let geminiCalls = 0;
  let openaiCalls = 0;

  __internal.__setVisionRunnersForTest({
    gemini: async () => {
      geminiCalls += 1;
      return {
        ok: false,
        provider: 'gemini',
        reason: 'VISION_TIMEOUT',
      };
    },
    openai: async () => {
      openaiCalls += 1;
      return {
        ok: false,
        provider: 'openai',
        reason: 'VISION_UPSTREAM_5XX',
      };
    },
  });

  t.after(() => {
    __internal.__resetVisionRunnersForTest();
    delete require.cache[moduleId];
  });

  const out = await __internal.runVisionSkinAnalysis({
    provider: 'gemini',
    llmKillSwitch: false,
    photoQuality: { grade: 'pass' },
    language: 'EN',
    imageBuffer: Buffer.from('x'),
  });

  assert.equal(geminiCalls, 1);
  assert.equal(openaiCalls, 1);
  assert.equal(out.ok, false);
  assert.equal(out.provider, 'openai');
  assert.equal(out.fallback_from, 'gemini');
  assert.equal(out.primary_failure_reason, 'VISION_TIMEOUT');
  assert.deepEqual(out.attempted_providers, ['gemini', 'openai']);
});

test('vision fallback: explicit openai provider does not call gemini', async (t) => {
  const { moduleId, mod } = loadRoutesModule();
  const { __internal } = mod;
  let geminiCalls = 0;
  let openaiCalls = 0;

  __internal.__setVisionRunnersForTest({
    gemini: async () => {
      geminiCalls += 1;
      return {
        ok: true,
        provider: 'gemini',
        analysis: { summary: 'should not be used', findings: [], confidence: 0.8 },
      };
    },
    openai: async () => {
      openaiCalls += 1;
      return {
        ok: true,
        provider: 'openai',
        analysis: { summary: 'openai direct', findings: [], confidence: 0.66 },
      };
    },
  });

  t.after(() => {
    __internal.__resetVisionRunnersForTest();
    delete require.cache[moduleId];
  });

  const out = await __internal.runVisionSkinAnalysis({
    provider: 'openai',
    llmKillSwitch: false,
    photoQuality: { grade: 'pass' },
    language: 'EN',
    imageBuffer: Buffer.from('x'),
  });

  assert.equal(geminiCalls, 0);
  assert.equal(openaiCalls, 1);
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'openai');
  assert.deepEqual(out.attempted_providers, ['openai']);
});
