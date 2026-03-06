const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSkinAnalysisContent } = require('../src/auroraBff/skinLlmGateway');
const {
  validateVisionObservation,
  validateReportStrategy,
  normalizeVisionObservationLayer,
  normalizeReportStrategyLayer,
} = require('../src/auroraBff/skinAnalysisContract');

test('skin llm gateway contract: accepts and normalizes legacy vision output shape', () => {
  const payload = {
    features: [
      { observation: 'Mild cheek redness', confidence: 'somewhat_sure' },
      { observation: 'Shine in T-zone', confidence: 'pretty_sure' },
    ],
    needs_risk_check: false,
  };
  const validation = validateVisionObservation(payload);
  assert.equal(validation.ok, true);

  const normalized = normalizeVisionObservationLayer(payload);
  assert.equal(Array.isArray(normalized.features), true);
  assert.equal(normalized.features.length >= 2, true);
  assert.equal(typeof normalized.needs_risk_check, 'boolean');
});

test('skin llm gateway contract: accepts and normalizes new vision output shape', () => {
  const payload = {
    quality_note: 'slight blur around edges',
    observations: [
      {
        cue: 'texture',
        where: 'cheeks',
        severity: 'mild',
        confidence: 'med',
        evidence: 'uneven fine texture',
      },
      {
        cue: 'shine',
        where: 'forehead',
        severity: 'moderate',
        confidence: 'high',
        evidence: 'specular highlights in T-zone',
      },
    ],
    limits: ['warm indoor lighting'],
  };
  const validation = validateVisionObservation(payload);
  assert.equal(validation.ok, true);

  const normalized = normalizeVisionObservationLayer(payload);
  assert.equal(Array.isArray(normalized.features), true);
  assert.equal(normalized.features.length >= 2, true);
  assert.equal(Array.isArray(normalized.observations), true);
  assert.equal(normalized.observations.length, 2);
  assert.equal(validateVisionObservation(normalized).ok, true);
});

test('skin llm gateway contract: accepts and normalizes legacy + new report output shape', () => {
  const payload = {
    strategy: 'AM gentle cleanse + SPF. PM gentle cleanse + moisturizer.',
    needs_risk_check: false,
    primary_question: 'Any stinging after moisturizer?',
    conditional_followups: ['How long does it last?'],
    routine_expert: {
      contract: 'aurora.routine_expert.v1',
      snapshot: { summary: 'minimal routine', am_steps: [], pm_steps: [], active_families: [], risk_flags: [] },
    },
    findings: [
      {
        cue: 'pores',
        where: 'nose',
        severity: 'mild',
        confidence: 'med',
        evidence: 'visible pore contrast',
      },
    ],
    guidance_brief: ['Avoid stacking multiple strong actives on the same night'],
    two_week_focus: ['Barrier-first consistency'],
    next_step_options: [{ id: 'analysis_get_recommendations', label: 'Get recommendations' }],
  };

  const validation = validateReportStrategy(payload);
  assert.equal(validation.ok, true);

  const normalized = normalizeReportStrategyLayer(payload, { lang: 'EN' });
  assert.equal(typeof normalized.strategy, 'string');
  assert.equal(typeof normalized.routine_expert, 'object');
  assert.equal(Array.isArray(normalized.findings), true);
  assert.equal(Array.isArray(normalized.guidance_brief), true);
  assert.equal(Array.isArray(normalized.next_step_options), true);
});

test('skin llm gateway safety text validation handles routine_expert object', () => {
  const safeLayer = {
    strategy: 'Keep routine simple and monitor tolerance.',
    primary_question: 'Any stinging after moisturizer?',
    routine_expert: {
      plan_7d: { am: ['gentle cleanse'], pm: ['moisturizer'] },
    },
  };
  const safe = validateSkinAnalysisContent(safeLayer, { lang: 'EN' });
  assert.equal(safe.ok, true);

  const unsafeLayer = {
    ...safeLayer,
    strategy: 'Use antibiotic cream and cure dermatitis quickly.',
  };
  const unsafe = validateSkinAnalysisContent(unsafeLayer, { lang: 'EN' });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.violations.includes('safety_keyword_violation'), true);
});
