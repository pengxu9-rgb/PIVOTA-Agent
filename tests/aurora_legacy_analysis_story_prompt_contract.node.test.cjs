const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('legacy analysis-story generation prompt encodes structured contract and evidence boundaries', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildAnalysisStoryGenerationPrompt({
      evidence: {
        language: 'EN',
        profile: {
          skinType: 'oily',
          sensitivity: 'high',
          barrierStatus: 'impaired',
          goals: ['dark_spots', 'texture'],
        },
        missing_routine_fields: ['currentRoutine.am', 'currentRoutine.pm'],
        finding_evidence: [{ rank: 1, observation: 'post-acne marks with irritation risk' }],
      },
      fallbackStory: { schema_version: 'aurora.analysis_story.v2' },
    });

    assert.equal(__internal.ANALYSIS_STORY_GENERATION_PROMPT_VERSION, 'aurora.analysis_story.v2.generate_v2');
    assert.match(prompt, /\[SYSTEM\]\[version=aurora\.analysis_story\.v2\.generate_v2\]/i);
    assert.match(prompt, /single valid JSON object/i);
    assert.match(prompt, /schema_version MUST be "aurora\.analysis_story\.v2"/i);
    assert.match(prompt, /am_plan and pm_plan MUST be customized/i);
    assert.match(prompt, /Do NOT use the same placeholder plan for every user/i);
    assert.match(prompt, /Do NOT recommend branded products or claim evidence that is not present in Evidence JSON/i);
    assert.match(prompt, /If missing_routine_fields is non-empty, include routine_bridge/i);
    assert.match(prompt, /disclaimer_non_medical MUST be true/i);
    assert.match(prompt, /Schema reference \(structure only, do NOT copy content\):/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('legacy analysis-story review prompt encodes reviewer-patcher constraints', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildAnalysisStoryReviewPrompt({
      evidence: {
        language: 'EN',
        missing_routine_fields: ['currentRoutine.am'],
        finding_evidence: [{ rank: 1, observation: 'redness around cheeks' }],
      },
      story: {
        schema_version: 'aurora.analysis_story.v2',
        disclaimer_non_medical: false,
        routine_bridge: {},
      },
    });

    assert.equal(__internal.ANALYSIS_STORY_REVIEW_PROMPT_VERSION, 'aurora.analysis_story.v2.review_v2');
    assert.match(prompt, /\[SYSTEM\]\[version=aurora\.analysis_story\.v2\.review_v2\]/i);
    assert.match(prompt, /strict JSON reviewer/i);
    assert.match(prompt, /single valid JSON object/i);
    assert.match(prompt, /patched_story must stay within evidence boundaries/i);
    assert.match(prompt, /Do NOT introduce new findings, causes, products, or brands/i);
    assert.match(prompt, /Keep disclaimer_non_medical true/i);
    assert.match(prompt, /If routine is missing in evidence, keep or repair routine_bridge/i);
    assert.match(prompt, /If a safe patch is not possible, set approved=false/i);
    assert.match(prompt, /Review output schema \(structure only\):/i);
  } finally {
    delete require.cache[moduleId];
  }
});
