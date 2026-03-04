const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateVisionObservation,
  validateReportStrategy,
  finalizeSkinAnalysisContract,
  buildFactLayer,
  mergeFinalContractIntoAnalysis,
} = require('../src/auroraBff/skinAnalysisContract');

test('skin contract: vision validator accepts legacy and new observation schema', () => {
  const legacy = validateVisionObservation({
    features: [
      { observation: 'Mild redness on cheeks', confidence: 'somewhat_sure' },
      { observation: 'Visible shine in T-zone', confidence: 'pretty_sure' },
    ],
    needs_risk_check: false,
  });
  assert.equal(legacy.ok, true);

  const modern = validateVisionObservation({
    quality_note: 'strong light near forehead',
    observations: [
      {
        cue: 'redness',
        where: 'cheeks',
        severity: 'mild',
        confidence: 'med',
        evidence: 'diffuse pink tone',
      },
    ],
    limits: ['warm lighting'],
  });
  assert.equal(modern.ok, true);
});

test('skin contract: report validator accepts new fields and routine_expert object', () => {
  const out = validateReportStrategy({
    strategy: 'AM: cleanser + moisturizer + SPF. PM: cleanser + moisturizer.',
    needs_risk_check: false,
    primary_question: 'Any stinging after moisturizer?',
    conditional_followups: ['When does stinging happen?'],
    routine_expert: {
      contract: 'aurora.routine_expert.v1',
      snapshot: { summary: 'basic routine', am_steps: [], pm_steps: [], active_families: [], risk_flags: [] },
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
    guidance_brief: ['Keep routine simple for 2 weeks'],
    next_step_options: [{ id: 'analysis_get_recommendations', label: 'Get recommendations' }],
    two_week_focus: ['Barrier-first routine stability'],
  });
  assert.equal(out.ok, true);
});

test('skin contract: final contract preserves additive analysis fields and routine_expert object', () => {
  const factLayer = buildFactLayer({
    deterministicAnalysis: {
      features: [{ observation: 'mild redness around cheeks', confidence: 'somewhat_sure' }],
      needs_risk_check: true,
    },
    visionLayer: {
      observations: [
        {
          cue: 'shine',
          where: 'forehead',
          severity: 'moderate',
          confidence: 'high',
          evidence: 'specular highlight concentration',
        },
      ],
    },
  });

  const finalContract = finalizeSkinAnalysisContract({
    factLayer,
    reportLayer: {
      strategy: 'AM: gentle cleanse + sunscreen. PM: cleanse + moisturizer.',
      needs_risk_check: false,
      primary_question: 'Any recent stinging?',
      conditional_followups: ['Any tightness after cleansing?'],
      routine_expert: {
        contract: 'aurora.routine_expert.v1',
        snapshot: { summary: 'stable', am_steps: [], pm_steps: [], active_families: [], risk_flags: [] },
      },
      quality: {
        grade: 'degraded',
        message: 'Strong lighting may hide redness; focusing on texture and distribution.',
        issues: ['strong_light'],
      },
      findings: [
        { cue: 'pores', where: 'nose', severity: 'mild', confidence: 'med', evidence: 'visible pore contrast' },
      ],
      guidance_brief: ['Keep routine simple for 2 weeks'],
      next_step_options: [{ id: 'analysis_get_recommendations', label: 'Get recommendations' }],
      two_week_focus: ['Barrier-first routine stability'],
      insufficient_visual_detail: false,
    },
    quality: { grade: 'degraded' },
    lang: 'EN',
    deterministicFallback: {
      features: [{ observation: 'fallback signal', confidence: 'somewhat_sure' }],
      strategy: 'fallback strategy',
      needs_risk_check: false,
    },
  });

  const merged = mergeFinalContractIntoAnalysis({ analysis: { plan: { today: {} } }, finalContract });
  assert.equal(typeof merged.routine_expert, 'object');
  assert.equal(merged.quality?.grade, 'degraded');
  assert.equal(Array.isArray(merged.findings), true);
  assert.equal(merged.findings.length > 0, true);
  assert.equal(Array.isArray(merged.guidance_brief), true);
  assert.equal(Array.isArray(merged.next_step_options), true);
  assert.equal(Array.isArray(merged.two_week_focus), true);
});
