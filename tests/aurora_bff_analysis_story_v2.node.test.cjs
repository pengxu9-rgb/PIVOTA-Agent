const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROUTES_PATH = path.join(__dirname, '..', 'src', 'auroraBff', 'routes.js');
const SKIN_LLM_POLICY_PATH = path.join(__dirname, '..', 'src', 'auroraBff', 'skinLlmPolicy.js');

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
  assert.equal(Object.prototype.hasOwnProperty.call(output, 'routine_bridge'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(output, 'existing_products_optimization'), false);
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
  assert.equal(Object.prototype.hasOwnProperty.call(storyCard?.payload || {}, 'routine_bridge'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(storyCard?.payload || {}, 'existing_products_optimization'), false);

  const planCard = out.find((card) => card.type === 'ingredient_plan_v2');
  assert.equal(planCard.payload.preview_only, true);
  assert.equal(planCard.payload.preview_reason, 'routine_missing');
  assert.deepEqual(planCard.payload.targets[0].products.competitors, []);
  assert.deepEqual(planCard.payload.targets[0].products.dupes, []);
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
  generated.existing_products_optimization = { keep: ['legacy'] };
  const reviewed = internal.reviewAnalysisStoryV2Json({ story: generated, evidence });
  const coerced = internal.coerceAnalysisStoryV2(reviewed.repaired, fallback);
  assert.equal(Array.isArray(evidence.finding_evidence), true);
  assert.equal(coerced.disclaimer_non_medical, true);
  assert.equal(Object.prototype.hasOwnProperty.call(coerced, 'routine_bridge'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(coerced, 'existing_products_optimization'), false);
  assert.equal(typeof coerced.ui_card_v1, 'object');
  assert.equal(typeof coerced.ui_card_v1.headline, 'string');
});

test('routine_fit_summary helpers: prompt/context/chips/message stay analysis-first', () => {
  const internal = loadInternalWithFlags({});
  const prompt = internal.buildRoutineFitSummaryPrompt({
    prefix: 'profile={"skinType":"oily"}\n\n',
    skinProfile: { skin_type_tendency: 'oily', sensitivity_tendency: 'high' },
    ingredientPlan: {
      targets: [{ ingredient_id: 'niacinamide', ingredient_name: 'Niacinamide', role: 'barrier' }],
      avoid: [{ ingredient_id: 'ascorbic_acid', ingredient_name: 'Vitamin C (Ascorbic Acid)' }],
    },
    routineProducts: [{ slot: 'am', step: 'serum', product_text: 'Brightening serum' }],
    language: 'EN',
  });
  assert.match(prompt, /recommended_ingredients: Niacinamide \(barrier\)/);
  assert.match(prompt, /avoid: Vitamin C \(Ascorbic Acid\)/);
  assert.match(prompt, /Current routine \(1 products\):/);

  const card = internal.buildRoutineFitSummaryCard(
    {
      overall_fit: 'unsupported_value',
      fit_score: 9,
      highlights: ['A', '', 'B', 'C', 'D'],
      concerns: ['X', 'Y', 'Z', 'W'],
      dimension_scores: { ingredient_match: { score: -2, note: 'Needs work' } },
      next_questions: ['Q1', 'Q2', 'Q3', 'Q4'],
    },
    'req_1',
  );
  assert.equal(card.payload.overall_fit, 'partial_match');
  assert.equal(card.payload.fit_score, 1);
  assert.equal(card.payload.highlights.length, 3);
  assert.equal(card.payload.concerns.length, 3);
  assert.equal(card.payload.dimension_scores.ingredient_match.score, 0);
  assert.equal(card.payload.next_questions.length, 3);

  const chips = internal.buildAnalysisSuggestedChips({
    language: 'EN',
    lowConfidence: false,
    hasIngredientPlan: true,
    hasRoutineFit: true,
  });
  assert.equal(chips.some((chip) => chip.chip_id === 'chip.aurora.next_action.routine_deep_dive'), true);
  assert.equal(chips.some((chip) => /recommend/i.test(String(chip.label || ''))), false);

  const assistantText = internal.buildAnalysisAssistantMessage({
    language: 'EN',
    skinProfile: { skin_type_tendency: 'oily', sensitivity_tendency: 'medium' },
    routineFit: { overall_fit: 'good_match', concerns: [] },
  });
  assert.match(assistantText, /good match/i);
  assert.doesNotMatch(assistantText, /product/i);
});

test('routine_fit_summary helpers: structured parsing retries on clarify/missing JSON and tolerates partial dimensions', () => {
  const internal = loadInternalWithFlags({});

  const parsedStructured = internal.parseRoutineFitUpstreamResult({
    structured: {
      overall_fit: 'good_match',
      fit_score: 0.81,
      summary: 'Mostly aligned.',
      highlights: ['Barrier support is present.'],
      concerns: ['Morning actives may overlap.'],
      dimension_scores: {
        ingredient_match: { score: 0.8, note: 'Aligned.' },
      },
      next_questions: ['What should I simplify first?'],
    },
  });
  assert.equal(parsedStructured.ok, true);
  assert.equal(parsedStructured.partial_structured, true);
  assert.deepEqual(parsedStructured.partial_dimensions.sort(), ['conflict_risk', 'routine_completeness', 'sensitivity_safety']);

  const parsedAnswerJson = internal.parseRoutineFitUpstreamResult({
    answer: JSON.stringify({
      overall_fit: 'partial_match',
      fit_score: 0.62,
      summary: 'A few layers need adjustment.',
      highlights: ['Core steps are covered.'],
      concerns: ['Retinoid and acids may stack.'],
      dimension_scores: {
        ingredient_match: { score: 0.72, note: 'Mostly aligned.' },
        routine_completeness: { score: 0.68, note: 'Core routine exists.' },
        conflict_risk: { score: 0.41, note: 'Watch actives.' },
        sensitivity_safety: { score: 0.55, note: 'Monitor irritation.' },
      },
      next_questions: ['Which step should I reduce first?'],
    }),
  });
  assert.equal(parsedAnswerJson.ok, true);
  assert.equal(parsedAnswerJson.failure_reason, null);

  const clarifyLike = internal.parseRoutineFitUpstreamResult({
    intent: 'clarify',
    answer: 'Can you share more routine details first?',
    clarification: { questions: [{ id: 'routine', question: 'Share more routine details' }] },
  });
  assert.equal(clarifyLike.ok, false);
  assert.equal(clarifyLike.failure_reason, 'clarify_like_response');

  const missingKeys = internal.parseRoutineFitUpstreamResult({
    answer: JSON.stringify({ overall_fit: 'partial_match', fit_score: 0.4 }),
  });
  assert.equal(missingKeys.ok, false);
  assert.equal(missingKeys.failure_reason, 'missing_required_keys');
  assert.equal(missingKeys.missing_keys.includes('summary'), true);

  const badJson = internal.parseRoutineFitUpstreamResult({
    answer: 'not-json-at-all',
  });
  assert.equal(badJson.ok, false);
  assert.equal(badJson.failure_reason, 'json_parse_failed');
});

test('routine_fit_summary helpers: backfill stays enabled in low-confidence mode and chat prefix includes analysis context', () => {
  const internal = loadInternalWithFlags({});
  const plan = internal.resolveRoutineFitAnalysisPlan({
    routineProductCandidates: [{ product_text: 'Cleanser' }],
    lowConfidenceRuleBased: true,
  });
  assert.deepEqual(plan, {
    shouldEvaluateRoutineFit: false,
    shouldQueueKbBackfill: true,
  });

  const skinAnalysisContext = internal.buildSkinAnalysisContextForPrefix({
    lastAnalysis: {
      skin_profile: {
        skin_type_tendency: 'combination',
        sensitivity_tendency: 'high',
        current_strengths: ['steady barrier', 'low congestion'],
      },
      priority_findings: [{ title: 'Mild redness on cheeks' }],
      confidence_overall: { level: 'medium', score: 0.68 },
      ingredient_plan: {
        targets: [{ ingredient_name: 'Ceramide', role: 'barrier' }],
        avoid: [{ ingredient_name: 'Vitamin C', reason: ['sensitivity flare risk'] }],
      },
      routine_fit: {
        overall_fit: 'partial_match',
        fit_score: 0.48,
        summary: 'Mostly okay but crowded.',
        highlights: ['Barrier support present'],
        concerns: ['Morning actives overlap'],
        dimension_scores: {
          ingredient_match: { score: 0.66, note: 'Mostly aligned' },
          routine_completeness: { score: 0.72, note: 'Core routine covered' },
          conflict_risk: { score: 0.31, note: 'Too many actives' },
          sensitivity_safety: { score: 0.44, note: 'Watch irritation' },
        },
        next_questions: ['What should I simplify first?'],
      },
    },
  });
  assert.match(skinAnalysisContext, /skin_type=combination/);
  assert.match(skinAnalysisContext, /Key findings: Mild redness on cheeks/);
  assert.match(skinAnalysisContext, /Ingredient targets: Ceramide \(barrier\)/);
  assert.match(skinAnalysisContext, /Avoid: Vitamin C \(sensitivity flare risk\)/);
  assert.match(skinAnalysisContext, /Routine fit: partial_match/);
  assert.match(skinAnalysisContext, /Lowest routine-fit dimensions: conflict_risk=31%/);
});

test('routine_fit_summary helpers: structured routine-only context is treated as medium confidence', () => {
  delete require.cache[require.resolve(SKIN_LLM_POLICY_PATH)];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const policy = require(SKIN_LLM_POLICY_PATH);
  const routine = {
    am: {
      cleanser: 'Gentle cleanser',
      serum: 'Vitamin C serum',
      moisturizer: 'Barrier cream',
      spf: 'SPF 50',
    },
    pm: {
      cleanser: 'Gentle cleanser',
      treatment: 'Retinol serum',
      moisturizer: 'Barrier cream',
    },
  };
  const routineSignals = policy.summarizeRoutineConfidenceSignals(routine);
  assert.equal(routineSignals.supports_medium_confidence, true);
  assert.equal(routineSignals.has_am_pm, true);
  assert.equal(routineSignals.has_actives, true);

  const detectorConfidence = policy.inferDetectorConfidence({
    profileSummary: { currentRoutine: JSON.stringify(routine) },
    recentLogsSummary: [],
    routineCandidate: routine,
  });
  assert.equal(detectorConfidence.level, 'medium');
  assert.equal(detectorConfidence.signals.includes('routine_structure'), true);
});

test('routine_fit_summary helpers: nested profile fields inside routine payload are promoted into profile patch', () => {
  const internal = loadInternalWithFlags({});
  const patch = internal.extractProfilePatchFromRoutinePayload({
    profile: {
      skin_type: 'combination',
      barrier_status: 'impaired',
      sensitivity: 'high',
    },
    goal_profile: {
      selected_goals: ['brightening', 'barrier_repair'],
      custom_input: 'reduce redness',
    },
    am: {
      cleanser: 'Gentle cleanser',
      serum: 'Vitamin C serum',
    },
    pm: {
      cleanser: 'Gentle cleanser',
      treatment: 'Retinol serum',
    },
  });
  assert.deepEqual(patch, {
    skinType: 'combination',
    sensitivity: 'high',
    barrierStatus: 'impaired',
    goals: ['brightening', 'barrier_repair', 'reduce redness'],
  });
});

test('analysis follow-up helpers: use lastAnalysis context and emit deterministic cards', () => {
  const internal = loadInternalWithFlags({});
  const lastAnalysis = {
    skin_profile: {
      skin_type_tendency: 'combination',
      sensitivity_tendency: 'high',
      current_strengths: ['steady barrier'],
    },
    priority_findings: [{ title: 'Cheek redness' }, { detail: 'Mild dehydration' }],
    confidence_overall: { level: 'medium', score: 0.71 },
    ingredient_plan: {
      targets: [{ ingredient_name: 'Ceramide', role: 'barrier' }],
      avoid: [{ ingredient_name: 'Vitamin C', reason: ['stinging risk'] }],
      conflicts: [{ title: 'Do not stack acids with retinoid' }],
    },
    routine_fit: {
      overall_fit: 'partial_match',
      fit_score: 0.52,
      summary: 'Routine is close but crowded.',
      highlights: ['Barrier layer is present'],
      concerns: ['Morning stack is too active'],
      dimension_scores: {
        ingredient_match: { score: 0.7, note: 'Mostly aligned' },
        routine_completeness: { score: 0.64, note: 'Core routine present' },
        conflict_risk: { score: 0.28, note: 'Active overlap' },
        sensitivity_safety: { score: 0.42, note: 'Monitor irritation' },
      },
      next_questions: ['What should I simplify first?'],
    },
  };

  const routineFollowup = internal.buildAnalysisFollowupContent({
    actionId: 'chip.aurora.next_action.routine_deep_dive',
    lastAnalysis,
    language: 'EN',
    requestId: 'req_1',
    replyText: 'What should I simplify first?',
  });
  assert.equal(routineFollowup.missing_context, false);
  assert.equal(routineFollowup.cards.some((card) => card.type === 'routine_fit_summary'), true);
  assert.doesNotMatch(routineFollowup.assistant_text, /nudge/i);

  const ingredientFollowup = internal.buildAnalysisFollowupContent({
    actionId: 'chip.aurora.next_action.ingredient_plan',
    lastAnalysis,
    language: 'EN',
    requestId: 'req_2',
  });
  assert.equal(ingredientFollowup.cards.some((card) => card.type === 'ingredient_plan'), true);

  const safetyFollowup = internal.buildAnalysisFollowupContent({
    actionId: 'chip.aurora.next_action.safety_concerns',
    lastAnalysis,
    language: 'EN',
    requestId: 'req_3',
  });
  assert.equal(safetyFollowup.cards.some((card) => card.type === 'confidence_notice'), true);
  assert.match(safetyFollowup.assistant_text, /watchouts|safety|risk/i);
});
