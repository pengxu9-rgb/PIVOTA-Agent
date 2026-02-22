const test = require('node:test');
const assert = require('node:assert/strict');

const { INTENT_ENUM, inferCanonicalIntent } = require('../src/auroraBff/intentCanonical');
const { resolveQaPlan } = require('../src/auroraBff/qaPlanner');
const { BLOCK_LEVEL, evaluateSafety, __internal: safetyEngineInternal } = require('../src/auroraBff/safetyEngineV1');
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

test('intent canonical maps fit-check phrasing to evaluate intent', () => {
  const out = inferCanonicalIntent({
    message: 'Is this toner good for me?',
  });
  assert.equal(out.intent, INTENT_ENUM.EVALUATE_PRODUCT);
  assert.equal(out.source, 'heuristic_regex');
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

test('safety engine blocks retinoid when pregnancy context is explicit in message only', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Can I use retinol during pregnancy?',
    profile: {},
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

test('safety engine warns for travel + high UV + acids', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.TRAVEL_PLANNING,
    message: 'I am traveling to a beach with high UV. Can I keep using glycolic acid exfoliation?',
    profile: { pregnancy_status: 'not_pregnant', age_band: 'adult' },
    language: 'EN',
  });

  assert.equal(result.block_level, BLOCK_LEVEL.WARN);
  assert.ok(Array.isArray(result.matched_rules));
  assert.ok(result.matched_rules.some((rule) => /travel|uv|acid|legacy:i4|kb_v0:/i.test(String(rule.id || ''))));
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

test('safety engine blocks isotretinoin + benzoyl peroxide', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'I use oral isotretinoin and benzoyl peroxide daily.',
    profile: { high_risk_medications: ['isotretinoin'] },
    language: 'EN',
  });

  assert.equal(result.block_level, BLOCK_LEVEL.BLOCK);
  assert.equal(result.decision_source, 'kb_v0');
  assert.ok(Array.isArray(result.triggered_by));
  assert.ok(result.triggered_by.includes('medications'));
});

test('safety engine promotes MEDICATION_ISOTRETINOIN concept to medications_any for KB rule match', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Can I use benzoyl peroxide daily?',
    profile: {
      pregnancy_status: 'not_pregnant',
      lactation_status: 'not_lactating',
      age_band: 'adult',
    },
    language: 'EN',
    matched_concepts: ['MEDICATION_ISOTRETINOIN', 'BENZOYL_PEROXIDE'],
  });

  assert.equal(result.block_level, BLOCK_LEVEL.BLOCK);
  assert.equal(result.decision_source, 'kb_v0');
  assert.ok(Array.isArray(result.triggered_by));
  assert.ok(result.triggered_by.includes('medications'));
  assert.ok(Array.isArray(result.matched_rules));
  assert.ok(result.matched_rules.some((rule) => String(rule.id || '').startsWith('kb_v0:MED_ISOTRETINOIN_X_BPO_WARN')));
});

test('safety engine does not promote topical retinoid mentions to isotretinoin medication context', () => {
  const ctx = safetyEngineInternal.buildCtx({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'I am using adapalene gel and tretinoin cream.',
    profile: {
      pregnancy_status: 'not_pregnant',
      lactation_status: 'not_lactating',
      age_band: 'adult',
    },
    language: 'EN',
    conceptIds: [],
    contraindicationTags: [],
    hasProductAnchor: false,
  });
  assert.equal(Boolean(ctx && ctx.meds && ctx.meds.isotretinoin), false);
  assert.equal(Array.isArray(ctx && ctx.medications_any) ? ctx.medications_any.includes('isotretinoin') : false, false);

  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'I am using adapalene gel and tretinoin cream.',
    profile: {
      pregnancy_status: 'not_pregnant',
      lactation_status: 'not_lactating',
      age_band: 'adult',
    },
    language: 'EN',
  });

  assert.ok(Array.isArray(result.matched_rules));
  assert.equal(
    result.matched_rules.some((rule) => /MED_ISOTRETINOIN/i.test(String(rule.id || ''))),
    false,
  );
});

test('safety engine requires age info for unknown age + strong actives', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Need the strongest anti-aging routine with high-strength retinoid',
    profile: { age_band: 'unknown' },
    language: 'EN',
  });

  assert.equal(result.block_level, BLOCK_LEVEL.REQUIRE_INFO);
  assert.ok(result.required_fields.includes('age_band') || result.required_questions.length > 0);
});

test('safety engine blocks infant/toddler + fragrance or essential oil', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Can my toddler use a fragrance essential oil cream?',
    profile: { age_band: 'toddler' },
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

test('weather adapter returns climate fallback when destination is missing', async () => {
  const out = await getTravelWeather({
    destination: '',
    startDate: '2026-03-01',
    endDate: '2026-03-05',
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'climate_fallback');
  assert.equal(out.reason, 'destination_missing');
  assert.ok(out.raw && typeof out.raw === 'object');
  assert.ok(out.raw.climate_profile && typeof out.raw.climate_profile === 'object');
  assert.ok(['user_locale', 'month', 'default'].includes(String(out.raw.climate_profile.archetype_selected_by || '')));
});
