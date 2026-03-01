const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateReportStrategy,
  finalizeSkinAnalysisContract,
  buildFactLayer,
  mergeFinalContractIntoAnalysis,
} = require('../src/auroraBff/skinAnalysisContract');

test('skin contract: report strategy schema rejects features key', () => {
  const out = validateReportStrategy({
    strategy: 'AM: cleanse PM: moisturize',
    needs_risk_check: false,
    primary_question: '',
    conditional_followups: [],
    routine_expert: '',
    features: [],
  });
  assert.equal(out.ok, false);
  assert.ok(Array.isArray(out.errors));
  assert.ok(out.errors.some((item) => String(item).includes('/features')));
});

test('skin contract: finalizer always outputs 6 required keys', () => {
  const factLayer = buildFactLayer({
    deterministicAnalysis: {
      features: [{ observation: 'mild redness around cheeks', confidence: 'somewhat_sure' }],
      needs_risk_check: true,
    },
  });
  const finalContract = finalizeSkinAnalysisContract({
    factLayer,
    reportLayer: {
      strategy: 'AM: gentle cleanse + sunscreen. PM: cleanse + moisturizer.',
      needs_risk_check: false,
      primary_question: 'Any recent stinging?',
      conditional_followups: ['Any tightness after cleansing?'],
      routine_expert: '',
    },
    quality: { grade: 'pass' },
    lang: 'EN',
    deterministicFallback: {
      features: [{ observation: 'fallback signal', confidence: 'somewhat_sure' }],
      strategy: 'fallback strategy',
      needs_risk_check: false,
    },
  });

  const merged = mergeFinalContractIntoAnalysis({ analysis: { plan: { today: {} } }, finalContract });

  for (const key of [
    'features',
    'strategy',
    'needs_risk_check',
    'primary_question',
    'conditional_followups',
    'routine_expert',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(merged, key), true);
  }
  assert.equal(Array.isArray(merged.features), true);
  assert.ok(merged.features.length >= 2);
  assert.equal(typeof merged.strategy, 'string');
  assert.equal(typeof merged.needs_risk_check, 'boolean');
  assert.equal(Array.isArray(merged.conditional_followups), true);
});

test('skin contract: poor quality enforces conservative deterministic template', () => {
  const finalContract = finalizeSkinAnalysisContract({
    factLayer: {
      features: [{ observation: 'strong oil shine', confidence: 'pretty_sure' }],
      needs_risk_check: false,
    },
    reportLayer: {
      strategy: 'aggressive treatment text that should be replaced',
      needs_risk_check: false,
      primary_question: '',
      conditional_followups: [],
      routine_expert: '',
    },
    quality: { grade: 'fail' },
    lang: 'EN',
    deterministicFallback: {
      features: [{ observation: 'fallback', confidence: 'somewhat_sure' }],
      strategy: 'fallback',
      needs_risk_check: false,
    },
  });

  assert.ok(String(finalContract.primary_question || '').toLowerCase().includes('retake'));
  assert.ok(String(finalContract.strategy || '').toLowerCase().includes('gentle cleanse'));
  assert.equal(finalContract.features.every((item) => item.confidence === 'not_sure'), true);
});
