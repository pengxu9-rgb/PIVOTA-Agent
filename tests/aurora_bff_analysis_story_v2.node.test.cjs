const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROUTES_PATH = path.join(__dirname, '..', 'src', 'auroraBff', 'routes.js');

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides || {});
  const prev = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function loadInternalWithFlags(flags) {
  return withEnv(flags, () => {
    delete require.cache[require.resolve(ROUTES_PATH)];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(ROUTES_PATH);
    return mod.__internal;
  });
}

test('analysis_story_v2: default QA mode resolves to single', () => {
  const internal = loadInternalWithFlags({
    AURORA_LLM_QA_MODE: '',
    AURORA_PRODUCT_RELEVANCE_DUAL_LLM_QA: 'false',
  });
  assert.equal(internal.resolveQaMode(undefined), 'single');
  assert.equal(internal.resolveQaSingleProvider(undefined), 'gemini');
});

test('analysis_story_v2: coerce fallback returns schema-complete payload', () => {
  const internal = loadInternalWithFlags({});
  const fallback = {
    schema_version: 'aurora.analysis_story.v2',
    confidence_overall: { level: 'low' },
    skin_profile: { current_strengths: ['baseline stable skin'] },
    priority_findings: [],
    target_state: ['improve tone consistency'],
    core_principles: ['stability first'],
    am_plan: [{ step: 'Gentle cleanse', purpose: 'Low irritation baseline' }],
    pm_plan: [{ step: 'Barrier moisturizer', purpose: 'Night recovery' }],
    routine_bridge: {
      missing_fields: ['currentRoutine.am', 'currentRoutine.pm'],
      why_now: 'Need routine details to personalize recommendations.',
      cta_label: 'Add AM/PM routine',
      cta_action: 'open_routine_intake',
    },
    existing_products_optimization: { keep: [], add: [], replace: [], remove: [] },
    timeline: { first_4_weeks: ['Week1 baseline'], week_8_12_expectation: ['Observe improvements'] },
    ui_card_v1: {
      headline: 'Stabilize first.',
      key_points: ['baseline stable skin'],
      actions_now: ['AM: Gentle cleanse'],
      avoid_now: ['Do not stack strong actives'],
      confidence_label: 'low',
      next_checkin: 'Re-check in 2 weeks.',
    },
    safety_notes: ['Pause actives if irritation persists'],
    disclaimer_non_medical: true,
  };
  const output = internal.coerceAnalysisStoryV2({ bad: true }, fallback);
  assert.equal(output.schema_version, 'aurora.analysis_story.v2');
  assert.equal(Array.isArray(output.am_plan), true);
  assert.equal(Array.isArray(output.pm_plan), true);
  assert.equal(Array.isArray(output.core_principles), true);
  assert.equal(typeof output.routine_bridge, 'object');
  assert.equal(typeof output.ui_card_v1, 'object');
  assert.equal(typeof output.ui_card_v1.headline, 'string');
});

test('analysis_story_v2: routine soft gate adds story/prompt and delays ingredient products when routine missing', async () => {
  const internal = loadInternalWithFlags({
    AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
    AURORA_ROUTINE_SOFT_GATE_DELAY_RECO: 'true',
  });

  const cards = [
    {
      card_id: 'pm_1',
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'pass',
        modules: [{ module_id: 'forehead', issues: [] }],
      },
    },
    {
      card_id: 'analysis_1',
      type: 'analysis_summary',
      payload: {
        analysis_source: 'vision_gemini',
        analysis: { features: [{ observation: 'mild redness around cheek' }] },
        low_confidence: false,
      },
    },
    {
      card_id: 'plan_1',
      type: 'ingredient_plan_v2',
      payload: {
        targets: [
          {
            ingredient: 'UV filters',
            products: {
              competitors: [{ name: 'UV Fluid SPF50', pdp_url: 'https://example.com/pdp/uv-fluid' }],
              dupes: [{ name: 'Daily UV Gel', pdp_url: 'https://example.com/pdp/uv-gel' }],
            },
          },
        ],
      },
    },
    {
      card_id: 'reco_legacy',
      type: 'recommendations',
      payload: {
        recommendations: [{ name: 'Legacy reco', pdp_url: 'https://example.com/pdp/legacy' }],
      },
    },
  ];

  const out = await internal.applyAnalysisStoryAndRoutineSoftGate(cards, {
    ctx: { request_id: 'req_story_1' },
    profile: {},
    language: 'EN',
  });

  const types = out.map((card) => card.type);
  assert.equal(types.includes('analysis_story_v2'), true);
  assert.equal(types.includes('analysis_summary'), false);
  assert.equal(types.includes('routine_prompt'), true);
  assert.equal(types.includes('recommendations'), false);
  const storyCard = out.find((card) => card.type === 'analysis_story_v2');
  assert.equal(typeof storyCard?.payload?.ui_card_v1, 'object');
  assert.equal(Array.isArray(storyCard?.payload?.ui_card_v1?.actions_now), true);

  const planCard = out.find((card) => card.type === 'ingredient_plan_v2');
  assert.equal(planCard.payload.preview_only, true);
  assert.equal(planCard.payload.preview_reason, 'routine_missing');
  assert.deepEqual(planCard.payload.targets[0].products.competitors, []);
  assert.deepEqual(planCard.payload.targets[0].products.dupes, []);
});

test('analysis_story_v2: dual response contract keeps analysis_summary and analysis_story_v2 together', async () => {
  const internal = loadInternalWithFlags({
    AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
    AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    AURORA_ROUTINE_SOFT_GATE_DELAY_RECO: 'false',
    AURORA_LLM_QA_MODE: 'off',
  });

  const cards = [
    {
      card_id: 'analysis_dual_1',
      type: 'analysis_summary',
      payload: {
        analysis_source: 'rule_based_with_photo_qc',
        analysis: { features: [{ observation: 'baseline observation' }] },
        low_confidence: false,
      },
    },
  ];

  const out = await internal.applyAnalysisStoryAndRoutineSoftGate(cards, {
    ctx: { request_id: 'req_story_dual' },
    profile: {},
    language: 'EN',
  });

  const types = out.map((card) => card.type);
  assert.equal(types.includes('analysis_summary'), true);
  assert.equal(types.includes('analysis_story_v2'), true);
});

test('analysis_story_v2: story-only contract removes analysis_summary but keeps analysis_story_v2', async () => {
  const internal = loadInternalWithFlags({
    AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
    AURORA_ANALYSIS_CARD_CONTRACT_MODE: 'story_only',
    AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    AURORA_ROUTINE_SOFT_GATE_DELAY_RECO: 'false',
    AURORA_LLM_QA_MODE: 'off',
  });

  const cards = [
    {
      card_id: 'analysis_story_only_1',
      type: 'analysis_summary',
      payload: {
        analysis_source: 'rule_based_with_photo_qc',
        analysis: { features: [{ observation: 'baseline observation' }] },
        low_confidence: false,
      },
    },
  ];

  const out = await internal.applyAnalysisStoryAndRoutineSoftGate(cards, {
    ctx: { request_id: 'req_story_only' },
    profile: {},
    language: 'EN',
  });

  const types = out.map((card) => card.type);
  assert.equal(types.includes('analysis_summary'), false);
  assert.equal(types.includes('analysis_story_v2'), true);
});

test('analysis_story_v2: evidence -> generate -> review pipeline enforces routine bridge and disclaimer', () => {
  const internal = loadInternalWithFlags({});
  const fallback = {
    schema_version: 'aurora.analysis_story.v2',
    confidence_overall: { level: 'medium' },
    skin_profile: { current_strengths: ['stable baseline'] },
    priority_findings: [],
    target_state: ['tone consistency'],
    core_principles: ['stability first'],
    am_plan: [{ step: 'Cleanse', purpose: 'baseline' }],
    pm_plan: [{ step: 'Moisturize', purpose: 'recovery' }],
    routine_bridge: {
      missing_fields: ['currentRoutine.am', 'currentRoutine.pm'],
      why_now: 'Need AM/PM routine.',
      cta_label: 'Add AM/PM routine',
      cta_action: 'open_routine_intake',
    },
    existing_products_optimization: { keep: [], add: [], replace: [], remove: [] },
    timeline: { first_4_weeks: [], week_8_12_expectation: [] },
    ui_card_v1: {
      headline: 'Tone consistency first.',
      key_points: ['stable baseline'],
      actions_now: ['AM: Cleanse'],
      avoid_now: ['No over-exfoliation'],
      confidence_label: 'medium',
      next_checkin: 'Re-check in 2 weeks.',
    },
    safety_notes: [],
    disclaimer_non_medical: true,
  };
  const evidence = internal.buildAnalysisEvidence({
    analysisSummaryPayload: {
      analysis_source: 'vision_gemini',
      analysis: { features: [{ observation: 'mild redness' }] },
    },
    profile: {},
    language: 'EN',
    fallbackStory: fallback,
  });
  const generated = internal.generateAnalysisStoryV2Json({
    evidence,
    fallbackStory: fallback,
  });
  generated.disclaimer_non_medical = false;
  generated.routine_bridge = {};
  const reviewed = internal.reviewAnalysisStoryV2Json({ story: generated, evidence });
  const coerced = internal.coerceAnalysisStoryV2(reviewed.repaired, fallback);
  assert.equal(Array.isArray(evidence.finding_evidence), true);
  assert.equal(coerced.disclaimer_non_medical, true);
  assert.deepEqual(coerced.routine_bridge.missing_fields, ['currentRoutine.am', 'currentRoutine.pm']);
  assert.equal(typeof coerced.ui_card_v1, 'object');
  assert.equal(typeof coerced.ui_card_v1.headline, 'string');
});
