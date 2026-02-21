const test = require('node:test');
const assert = require('node:assert/strict');

const { INTENT_ENUM, inferCanonicalIntent } = require('../src/auroraBff/intentCanonical');
const { resolveQaPlan } = require('../src/auroraBff/qaPlanner');
const { BLOCK_LEVEL, evaluateSafety } = require('../src/auroraBff/safetyEngineV1');
const { buildEpiPayload } = require('../src/auroraBff/epiCalculator');
const { getTravelWeather } = require('../src/auroraBff/weatherAdapter');

test('intent canonical prefers action_id over text', () => {
  const out = inferCanonicalIntent({
    message: 'I want ingredient science please',
    actionId: 'chip.start.reco_products',
  });
  assert.equal(out.intent, INTENT_ENUM.RECO_PRODUCTS);
  assert.equal(out.source, 'action_id');
});

test('intent canonical detects ingredient science from bilingual patterns', () => {
  const out = inferCanonicalIntent({
    message: 'Analyze ingredient Copper Tripeptide-1 benefits and watchouts',
  });
  assert.equal(out.intent, INTENT_ENUM.INGREDIENT_SCIENCE);
});

test('intent canonical maps "Send a link" to evaluate intent (anchor collect)', () => {
  const out = inferCanonicalIntent({
    message: 'Send a link',
  });
  assert.equal(out.intent, INTENT_ENUM.EVALUATE_PRODUCT);
  assert.equal(out.source, 'known_option_text');
});

test('intent canonical prefers travel_planning when travel cue and weather words coexist', () => {
  const out = inferCanonicalIntent({
    message: 'Travel next week skincare: weather and UV advice please',
  });
  assert.equal(out.intent, INTENT_ENUM.TRAVEL_PLANNING);
});

test('qa planner produces hard gate for recommendation with missing core profile', () => {
  const plan = resolveQaPlan({
    intent: INTENT_ENUM.RECO_PRODUCTS,
    profile: { skinType: 'oily' },
    message: 'recommend products',
    language: 'EN',
    hasAnchor: false,
    session: {},
  });

  assert.equal(plan.gate_type, 'hard');
  assert.equal(plan.next_step, 'ask');
  assert.equal(plan.question_budget, 1);
  assert.ok(plan.required_fields.includes('sensitivity'));
});

test('qa planner loop breaker escalates after repeated same ask', () => {
  const baseline = resolveQaPlan({
    intent: INTENT_ENUM.RECO_PRODUCTS,
    profile: { skinType: 'oily', sensitivity: 'high', goals: ['acne'] },
    message: 'recommend products',
    language: 'EN',
    hasAnchor: false,
    session: {},
  });
  const session = { state: { qa_planner_v2: { signature: baseline.loop_signature, count: 2 } } };
  const plan = resolveQaPlan({
    intent: INTENT_ENUM.RECO_PRODUCTS,
    profile: { skinType: 'oily', sensitivity: 'high', goals: ['acne'] },
    message: 'recommend products',
    language: 'EN',
    hasAnchor: false,
    session,
  });
  assert.equal(plan.break_applied, 'conservative_defaults');
  assert.equal(plan.loop_count, 3);
});

test('qa planner enforces one-question ask when safety requires info', () => {
  const plan = resolveQaPlan({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    profile: { skinType: 'oily' },
    message: 'Can I use retinol?',
    language: 'EN',
    hasAnchor: false,
    session: {},
    safetyDecision: {
      block_level: BLOCK_LEVEL.REQUIRE_INFO,
      required_fields: ['pregnancy_status'],
      required_questions: ['Are you currently pregnant or trying to conceive?'],
    },
  });

  assert.equal(plan.gate_type, 'hard');
  assert.equal(plan.next_step, 'ask');
  assert.equal(plan.question_budget, 1);
  assert.deepEqual(plan.required_fields, ['pregnancy_status']);
});

test('safety engine blocks pregnancy + retinoid', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Can I use retinol while pregnant?',
    profile: { pregnancy_status: 'pregnant' },
    language: 'EN',
  });

  assert.equal(result.block_level, BLOCK_LEVEL.BLOCK);
  assert.ok(result.reasons.length > 0);
});

test('safety engine requires info when pregnancy unknown + retinoid', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'How to use adapalene?',
    profile: {},
    language: 'EN',
  });

  assert.equal(result.block_level, BLOCK_LEVEL.REQUIRE_INFO);
  assert.ok(result.required_fields.includes('pregnancy_status'));
  assert.ok(result.required_questions.length > 0);
});

test('safety engine blocks lactating + oral isotretinoin', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'I am breastfeeding and on accutane',
    profile: { lactation_status: 'lactating' },
    language: 'EN',
  });

  assert.equal(result.block_level, BLOCK_LEVEL.BLOCK);
});

test('epi calculator outputs bounded components and score', () => {
  const payload = buildEpiPayload({
    weather: {
      source: 'weather_api',
      summary: {
        uv_index_max: 9,
        humidity_mean: 78,
        temp_swing_c: 11,
        wind_kph_max: 26,
      },
    },
    profile: {
      barrierStatus: 'impaired',
      sensitivity: 'high',
      goals: ['dark_spots'],
    },
    language: 'EN',
  });

  assert.equal(payload.env_source, 'weather_api');
  assert.ok(payload.epi >= 0 && payload.epi <= 100);
  for (const value of Object.values(payload.components)) {
    assert.ok(value >= 0 && value <= 1);
  }
});

test('weather adapter degrades to climate fallback when fetch is unavailable', async () => {
  const out = await getTravelWeather({
    destination: 'Tokyo',
    startDate: '2026-03-01',
    endDate: '2026-03-05',
    fetchImpl: null,
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'climate_fallback');
  assert.ok(out.summary && typeof out.summary === 'object');
});
