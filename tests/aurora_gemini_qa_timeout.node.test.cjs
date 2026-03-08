const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('runtime QA story generation uses dedicated flash model and structured schema even when diag force model is pro', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-pro-preview',
      AURORA_RUNTIME_QA_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_LLM_QA_MODE: 'single',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      let captured = null;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          captured = args;
          return {
            ok: true,
            json: {
              schema_version: 'aurora.analysis_story.v2',
              confidence_overall: { level: 'medium' },
              skin_profile: { current_strengths: [] },
              priority_findings: [],
              target_state: [],
              core_principles: [],
              am_plan: [],
              pm_plan: [],
              timeline: { first_4_weeks: [], week_8_12_expectation: [] },
              ui_card_v1: {
                headline: 'Barrier support first.',
                key_points: [],
                actions_now: [],
                avoid_now: [],
                confidence_label: 'medium',
                next_checkin: 'Re-check in 2 weeks.',
              },
              safety_notes: [],
              disclaimer_non_medical: true,
            },
          };
        });

        const generated = await __internal.generateAnalysisStoryV2JsonWithLlm({
          evidence: { language: 'EN', finding_evidence: [] },
          fallbackStory: {
            schema_version: 'aurora.analysis_story.v2',
            confidence_overall: { level: 'low' },
            skin_profile: { current_strengths: [] },
            priority_findings: [],
            target_state: [],
            core_principles: [],
            am_plan: [],
            pm_plan: [],
            timeline: { first_4_weeks: [], week_8_12_expectation: [] },
            ui_card_v1: {
              headline: 'Fallback headline',
              key_points: [],
              actions_now: [],
              avoid_now: [],
              confidence_label: 'low',
              next_checkin: 'Re-check in 2 weeks.',
            },
            safety_notes: [],
            disclaimer_non_medical: true,
          },
          qaMode: 'single',
          singleProvider: 'gemini',
        });

        assert.equal(generated.schema_version, 'aurora.analysis_story.v2');
        assert.equal(captured.model, 'gemini-3-flash-preview');
        assert.equal(captured.route, 'aurora_qa_story_generate');
        assert.equal(captured.ignoreForceModel, true);
        assert.equal(typeof captured.responseSchema, 'object');
        assert.equal(captured.maxOutputTokens > 0, true);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('routes module loads when product intel model env is set under force-gemini', () => {
  withEnv(
    {
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-pro-preview',
      AURORA_PRODUCT_INTEL_LLM_MODEL: 'gemini-3-flash-preview',
      AURORA_PRODUCT_INTEL_ESCALATION_MODEL: 'gemini-3-flash-preview',
    },
    () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      assert.doesNotThrow(() => require('../src/auroraBff/routes'));
      delete require.cache[moduleId];
    },
  );
});

test('runtime QA product relevance uses structured schema and flash model', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-pro-preview',
      AURORA_RUNTIME_QA_GEMINI_MODEL: 'gemini-3-flash-preview',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      let captured = null;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          captured = args;
          return {
            ok: true,
            json: { relevant: true, category: 'serum', reason: 'Skincare serum candidate.' },
          };
        });
        const result = await __internal.callRuntimeQaJson({
          kind: 'product_relevance',
          systemPrompt: 'Return strict JSON only.',
          userPrompt: 'Candidate: {"name":"Glow supplement serum"}',
        });
        assert.equal(result.ok, true);
        assert.equal(captured.model, 'gemini-3-flash-preview');
        assert.equal(captured.route, 'aurora_qa_product_relevance');
        assert.equal(captured.maxOutputTokens, 520);
        assert.equal(typeof captured.responseSchema, 'object');
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('runtime QA can explicitly keep preview model when allow-preview override is enabled', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-pro-preview',
      AURORA_RUNTIME_QA_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_PRODUCT_RELEVANCE_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_RUNTIME_QA_ALLOW_PREVIEW: 'true',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      let captured = null;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          captured = args;
          return { ok: true, json: { relevant: true, category: 'serum', reason: 'preview allowed' } };
        });
        const result = await __internal.callRuntimeQaJson({
          kind: 'product_relevance',
          systemPrompt: 'Return strict JSON only.',
          userPrompt: 'Candidate: {"name":"Preview Serum"}',
        });
        assert.equal(result.ok, true);
        assert.equal(captured.model, 'gemini-3-flash-preview');
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('runtime QA story review auto-upgrades legacy Gemini env to the 3.x floor', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-pro-preview',
      AURORA_RUNTIME_QA_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_ANALYSIS_STORY_REVIEW_GEMINI_MODEL: 'gemini-2.0-flash',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      let captured = null;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          captured = args;
          return { ok: true, json: { approved: true, issues: [], patch_ops: [] } };
        });
        const result = await __internal.callRuntimeQaJson({
          kind: 'story_review',
          systemPrompt: 'Return strict JSON only.',
          userPrompt: 'StoryDigest={\"ui_card_v1\":{\"headline\":\"Generic headline\"}}',
        });
        assert.equal(result.ok, true);
        assert.equal(captured.model, 'gemini-3-flash-preview');
        assert.equal(captured.route, 'aurora_qa_story_review');
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('story review applies patch ops locally instead of requiring patched_story payload', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_RUNTIME_QA_GEMINI_MODEL: 'gemini-3-flash-preview',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      try {
        const story = {
          schema_version: 'aurora.analysis_story.v2',
          confidence_overall: { level: 'low' },
          skin_profile: { current_strengths: [] },
          priority_findings: [],
          target_state: [],
          core_principles: [],
          am_plan: [],
          pm_plan: [],
          timeline: { first_4_weeks: [], week_8_12_expectation: [] },
          ui_card_v1: {
            headline: 'Generic headline',
            key_points: [],
            actions_now: [],
            avoid_now: [],
            confidence_label: 'low',
            next_checkin: 'Re-check in 2 weeks.',
          },
          safety_notes: [],
          disclaimer_non_medical: false,
          routine_bridge: { deprecated: true },
        };
        const patched = __internal.applyAnalysisStoryReviewPatchOps({
          story,
          patchOps: [
            { op: 'replace', path: 'ui_card_v1.headline', value: 'Barrier support first.' },
            { op: 'replace', path: 'ui_card_v1.actions_now', value: ['Keep routine gentle.'] },
          ],
        });
        assert.equal(patched.ui_card_v1.headline, 'Barrier support first.');
        assert.deepEqual(patched.ui_card_v1.actions_now, ['Keep routine gentle.']);
        const reviewed = __internal.reviewAnalysisStoryV2Json({
          story: patched,
          evidence: { language: 'EN', finding_evidence: [] },
        });
        assert.equal(reviewed.ok, true);
        assert.equal(reviewed.repaired.disclaimer_non_medical, true);
        assert.equal(Object.prototype.hasOwnProperty.call(reviewed.repaired, 'routine_bridge'), false);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});
