const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyPhotoQuality,
  shouldCallLlm,
  downgradeSkinAnalysisConfidence,
  enforceQualityNarrative,
  shouldFireDeepening,
  capConfidenceByGrade,
  applyConfidenceCaps,
  detectInsufficientVisualDetail,
} = require('../src/auroraBff/skinLlmPolicy');

const {
  buildQualityObject,
  mapPhotoQuality,
  buildVisionSignalsDto,
  buildReportSignalsDto,
} = require('../src/auroraBff/skinSignalsDto');

const {
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
} = require('../src/auroraBff/skinLlmPrompts');

const {
  dedupeAndCapOutput,
  OUTPUT_CAPS,
} = require('../src/auroraBff/chatCardFactory');

// ---------------------------------------------------------------------------
// Phase 1: QC grading – two-strikes logic
// ---------------------------------------------------------------------------

test('two-strikes: single slightly-low metric does NOT degrade', () => {
  const quality = buildQualityObject({
    grade: 'pass',
    reasons: [],
    metrics: { blur_factor: 0.8, exposure_factor: 0.8, wb_factor: 0.8, coverage_factor: 0.8 },
  });
  assert.equal(quality.grade, 'pass');
  assert.equal(quality.issues.length, 0);
});

test('two-strikes: buildQualityObject maps degraded correctly', () => {
  const quality = buildQualityObject({
    grade: 'degraded',
    reasons: ['blur', 'too_bright'],
    metrics: { blur_factor: 0.3, exposure_factor: 0.3, wb_factor: 0.9, coverage_factor: 0.2 },
  });
  assert.equal(quality.grade, 'degraded');
  assert.ok(quality.issues.includes('motion_blur'));
  assert.ok(quality.issues.includes('strong_light'));
  assert.equal(quality.confidence_penalty, 0.2);
});

test('buildQualityObject: fail grade sets penalty to 1.0', () => {
  const quality = buildQualityObject({ grade: 'fail', reasons: ['low_skin_coverage'] });
  assert.equal(quality.grade, 'fail');
  assert.equal(quality.confidence_penalty, 1.0);
});

// ---------------------------------------------------------------------------
// Phase 2: Unified quality object in DTOs
// ---------------------------------------------------------------------------

test('buildVisionSignalsDto includes quality object', () => {
  const dto = buildVisionSignalsDto({
    lang: 'en-US',
    photoQuality: { grade: 'pass', reasons: [], metrics: {} },
  });
  assert.ok(dto.quality);
  assert.equal(dto.quality.grade, 'pass');
  assert.ok(dto.photo_quality, 'legacy photo_quality still present');
});

test('buildReportSignalsDto includes quality object', () => {
  const dto = buildReportSignalsDto({
    lang: 'en-US',
    photoQuality: { grade: 'degraded', reasons: ['blur'], metrics: { blur_factor: 0.3 } },
  });
  assert.ok(dto.quality);
  assert.equal(dto.quality.grade, 'degraded');
  assert.ok(dto.quality.issues.includes('motion_blur'));
});

// ---------------------------------------------------------------------------
// Phase 3: Issue-specific messaging
// ---------------------------------------------------------------------------

test('downgradeSkinAnalysisConfidence uses issue-specific message', () => {
  const analysis = {
    features: [{ observation: 'mild redness', confidence: 'pretty_sure' }],
    strategy: 'Gentle cleansing twice daily.',
  };
  const result = downgradeSkinAnalysisConfidence(analysis, {
    language: 'EN',
    qualityObject: { issues: ['strong_light'] },
  });
  assert.ok(result.quality_message);
  assert.ok(result.quality_message.includes('lighting'));
  assert.ok(!result.quality_message.includes('conservative'));
  assert.equal(result.features[0].confidence, 'somewhat_sure');
});

test('downgradeSkinAnalysisConfidence: no generic "keep expectations conservative"', () => {
  const analysis = {
    features: [{ observation: 'oily shine', confidence: 'somewhat_sure' }],
    strategy: 'Photo quality is degraded. Keep expectations conservative.\nUse lightweight moisturizer.',
  };
  const result = downgradeSkinAnalysisConfidence(analysis, {
    language: 'EN',
    qualityObject: { issues: ['motion_blur'] },
  });
  assert.ok(!result.strategy.includes('keep expectations conservative'));
  assert.ok(!result.strategy.toLowerCase().includes('degraded'));
  assert.ok(result.quality_message.toLowerCase().includes('blur'));
});

// ---------------------------------------------------------------------------
// Phase 5: Vision prompt enforces observations-only JSON
// ---------------------------------------------------------------------------

test('vision prompt: EN contains observations-only output contract', () => {
  const bundle = buildSkinVisionPromptBundle({ language: 'en-US', dto: { quality: { grade: 'pass' } } });
  assert.ok(bundle.userPrompt.includes('output_contract'));
  assert.ok(bundle.userPrompt.includes('"observations"'));
  assert.ok(bundle.userPrompt.includes('No routines'));
  assert.ok(bundle.systemInstruction.includes('Do NOT provide routines'));
});

test('vision prompt: CN contains observations-only output contract', () => {
  const bundle = buildSkinVisionPromptBundle({ language: 'zh-CN', dto: { quality: { grade: 'pass' } } });
  assert.ok(bundle.userPrompt.includes('output_contract'));
  assert.ok(bundle.userPrompt.includes('observations'));
  assert.ok(bundle.userPrompt.includes('禁止输出护肤建议'));
});

test('vision prompt: pass grade says do NOT mention degraded', () => {
  const bundle = buildSkinVisionPromptBundle({
    language: 'en-US',
    dto: { quality: { grade: 'pass', issues: [] } },
  });
  assert.ok(bundle.userPrompt.includes('Do NOT mention degraded'));
});

test('vision prompt: fail grade says return NO findings', () => {
  const bundle = buildSkinVisionPromptBundle({
    language: 'en-US',
    dto: { quality: { grade: 'fail', issues: [] } },
  });
  assert.ok(bundle.userPrompt.includes('Return NO findings'));
});

// ---------------------------------------------------------------------------
// Phase 6: Report prompt enforces separation
// ---------------------------------------------------------------------------

test('report prompt: EN contains separation_rule and routine_step_schema', () => {
  const bundle = buildSkinReportPromptBundle({ language: 'en-US', dto: { quality: { grade: 'pass' } } });
  assert.ok(bundle.userPrompt.includes('separation_rule'));
  assert.ok(bundle.userPrompt.includes('routine_step_schema'));
  assert.ok(bundle.userPrompt.includes('two_week_focus'));
  assert.ok(bundle.userPrompt.includes('findings_rule'));
  assert.ok(bundle.userPrompt.includes('guidance_brief_rule'));
});

test('report prompt: CN contains separation and findings rules', () => {
  const bundle = buildSkinReportPromptBundle({ language: 'zh-CN', dto: { quality: { grade: 'pass' } } });
  assert.ok(bundle.userPrompt.includes('separation_rule'));
  assert.ok(bundle.userPrompt.includes('findings_rule'));
  assert.ok(bundle.userPrompt.includes('two_week_focus'));
});

// ---------------------------------------------------------------------------
// Phase 7: Deepening gating
// ---------------------------------------------------------------------------

test('shouldFireDeepening: does not fire when pass + high confidence', () => {
  const result = shouldFireDeepening({
    qualityObject: { grade: 'pass' },
    observations: [
      { cue: 'redness', confidence: 'high' },
      { cue: 'shine', confidence: 'med' },
    ],
    userReportedSymptoms: [],
  });
  assert.equal(result.fire, false);
});

test('shouldFireDeepening: fires when quality is degraded', () => {
  const result = shouldFireDeepening({
    qualityObject: { grade: 'degraded' },
    observations: [],
    userReportedSymptoms: [],
  });
  assert.equal(result.fire, true);
  assert.equal(result.reason, 'quality_not_pass');
});

test('shouldFireDeepening: fires when 2+ low confidence observations', () => {
  const result = shouldFireDeepening({
    qualityObject: { grade: 'pass' },
    observations: [
      { cue: 'redness', confidence: 'low' },
      { cue: 'texture', confidence: 'low' },
      { cue: 'shine', confidence: 'high' },
    ],
    userReportedSymptoms: [],
  });
  assert.equal(result.fire, true);
  assert.equal(result.reason, 'multiple_low_confidence_observations');
});

test('shouldFireDeepening: fires on actionable symptoms', () => {
  const result = shouldFireDeepening({
    qualityObject: { grade: 'pass' },
    observations: [{ cue: 'redness', confidence: 'high' }],
    userReportedSymptoms: ['stinging after applying serum'],
  });
  assert.equal(result.fire, true);
  assert.equal(result.reason, 'user_symptoms_may_change_plan');
});

// ---------------------------------------------------------------------------
// Phase 8: Confidence capping
// ---------------------------------------------------------------------------

test('capConfidenceByGrade: pass allows high', () => {
  assert.equal(capConfidenceByGrade('high', 'pass'), 'high');
});

test('capConfidenceByGrade: degraded caps at med', () => {
  assert.equal(capConfidenceByGrade('high', 'degraded'), 'med');
  assert.equal(capConfidenceByGrade('med', 'degraded'), 'med');
  assert.equal(capConfidenceByGrade('low', 'degraded'), 'low');
});

test('capConfidenceByGrade: fail returns null', () => {
  assert.equal(capConfidenceByGrade('high', 'fail'), null);
});

test('applyConfidenceCaps: fail clears all findings', () => {
  const result = applyConfidenceCaps(
    { findings: [{ cue: 'redness', confidence: 'high' }], features: [{ observation: 'x', confidence: 'pretty_sure' }] },
    'fail',
  );
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.features, []);
  assert.equal(result.insufficient_visual_detail, true);
});

test('applyConfidenceCaps: degraded caps features', () => {
  const result = applyConfidenceCaps(
    { features: [{ observation: 'x', confidence: 'pretty_sure' }], findings: [{ cue: 'shine', confidence: 'high' }] },
    'degraded',
  );
  assert.equal(result.features[0].confidence, 'somewhat_sure');
  assert.equal(result.findings[0].confidence, 'med');
});

test('detectInsufficientVisualDetail: true when 80%+ low confidence', () => {
  assert.equal(detectInsufficientVisualDetail([
    { confidence: 'low' },
    { confidence: 'low' },
    { confidence: 'low' },
    { confidence: 'low' },
    { confidence: 'med' },
  ]), true);
});

test('detectInsufficientVisualDetail: false when mixed confidence', () => {
  assert.equal(detectInsufficientVisualDetail([
    { confidence: 'high' },
    { confidence: 'med' },
    { confidence: 'low' },
  ]), false);
});

// ---------------------------------------------------------------------------
// Phase 9: Dedupe and caps
// ---------------------------------------------------------------------------

test('dedupeAndCapOutput: caps findings at max', () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({
    cue: `cue_${i}`,
    where: `region_${i}`,
    severity: 'mild',
    confidence: 'med',
    evidence: `evidence ${i}`,
  }));
  const result = dedupeAndCapOutput({ findings, guidance_brief: [], features: [] });
  assert.ok(result.findings.length <= OUTPUT_CAPS.findings);
});

test('dedupeAndCapOutput: removes duplicate findings by cue+where', () => {
  const findings = [
    { cue: 'redness', where: 'cheeks', severity: 'mild', confidence: 'med', evidence: 'pink' },
    { cue: 'redness', where: 'cheeks', severity: 'moderate', confidence: 'high', evidence: 'rosy' },
    { cue: 'shine', where: 'forehead', severity: 'moderate', confidence: 'high', evidence: 'oily' },
  ];
  const result = dedupeAndCapOutput({ findings, guidance_brief: [], features: [] });
  assert.equal(result.findings.length, 2);
});

test('dedupeAndCapOutput: removes near-duplicate guidance bullets', () => {
  const result = dedupeAndCapOutput({
    findings: [],
    features: [],
    guidance_brief: [
      'Avoid stacking multiple strong actives on the same night.',
      'Avoid stacking strong actives on the same night to prevent irritation.',
      'Keep routine simple for 2 weeks.',
    ],
  });
  assert.ok(result.guidance_brief.length <= 2, `Expected <=2 after dedup, got ${result.guidance_brief.length}: ${JSON.stringify(result.guidance_brief)}`);
});

test('dedupeAndCapOutput: caps AM/PM steps', () => {
  const amSteps = Array.from({ length: 10 }, (_, i) => `step_am_${i}`);
  const pmSteps = Array.from({ length: 10 }, (_, i) => `step_pm_${i}`);
  const result = dedupeAndCapOutput({
    findings: [],
    features: [],
    guidance_brief: [],
    routine_expert: { snapshot: { am_steps: amSteps, pm_steps: pmSteps } },
  });
  assert.ok(result.routine_expert.snapshot.am_steps.length <= OUTPUT_CAPS.am_steps);
  assert.ok(result.routine_expert.snapshot.pm_steps.length <= OUTPUT_CAPS.pm_steps);
});

// ---------------------------------------------------------------------------
// Phase 10: next_step_options in report prompt
// ---------------------------------------------------------------------------

test('report prompt: includes next_step_rule', () => {
  const bundle = buildSkinReportPromptBundle({ language: 'en-US', dto: {} });
  assert.ok(bundle.userPrompt.includes('next_step_rule'));
  assert.ok(bundle.userPrompt.includes('analysis_get_recommendations'));
  assert.ok(bundle.userPrompt.includes('analysis_optimize_existing'));
  assert.ok(bundle.userPrompt.includes('analysis_both_reco_optimize'));
});

// ---------------------------------------------------------------------------
// Phase 13: PASS must never show degraded text
// ---------------------------------------------------------------------------

test('PASS grade: downgradeSkinAnalysisConfidence is not called (contract)', () => {
  const analysis = {
    features: [{ observation: 'mild shine on T-zone', confidence: 'pretty_sure' }],
    strategy: 'Photo quality is degraded and conservative mode is on.\nLightweight moisturizer AM, no actives PM.',
  };
  const qualityObj = buildQualityObject({ grade: 'pass', reasons: [] });
  assert.equal(qualityObj.grade, 'pass');
  assert.equal(qualityObj.confidence_penalty, 0);
  const normalized = enforceQualityNarrative(analysis, { language: 'EN', qualityObject: qualityObj });
  assert.ok(!normalized.strategy.toLowerCase().includes('degraded'));
  assert.ok(!normalized.strategy.toLowerCase().includes('conservative'));
  assert.equal(typeof normalized.quality_message, 'undefined');
});

test('DEGRADED: exactly 1 short issue-specific banner message', () => {
  const analysis = {
    features: [{ observation: 'mild redness', confidence: 'pretty_sure' }],
    strategy: 'Soothing moisturizer, barrier focus.',
  };
  const result = enforceQualityNarrative(analysis, {
    language: 'EN',
    qualityObject: { grade: 'degraded', issues: ['specular_shine'] },
  });
  assert.ok(result.quality_message);
  const sentences = result.quality_message.split(/[.!?]+/).filter(Boolean);
  assert.ok(sentences.length <= 2, `Expected 1-2 sentences, got ${sentences.length}`);
  assert.ok(result.quality_message.includes('oiliness'));
});

test('FAIL: applyConfidenceCaps removes all findings', () => {
  const result = applyConfidenceCaps(
    { findings: [{ cue: 'x', confidence: 'high' }], features: [{ observation: 'x', confidence: 'pretty_sure' }] },
    'fail',
  );
  assert.equal(result.findings.length, 0);
  assert.equal(result.features.length, 0);
});

test('FAIL grade: enforceQualityNarrative outputs retake-only guidance', () => {
  const result = enforceQualityNarrative(
    {
      findings: [{ cue: 'x', where: 'cheek', severity: 'mild', confidence: 'med', evidence: 'x' }],
      features: [{ observation: 'x', confidence: 'somewhat_sure' }],
      strategy: 'Old strategy',
    },
    { language: 'EN', qualityObject: { grade: 'fail', issues: ['motion_blur'] } },
  );
  assert.equal(Array.isArray(result.findings), true);
  assert.equal(result.findings.length, 0);
  assert.equal(Array.isArray(result.features), true);
  assert.equal(result.features.length, 0);
  assert.ok(String(result.strategy || '').toLowerCase().includes('retake'));
});

// ---------------------------------------------------------------------------
// Grounding: report routine references observed cues
// ---------------------------------------------------------------------------

test('report prompt instructs referencing observed cues', () => {
  const bundle = buildSkinReportPromptBundle({ language: 'en-US', dto: {} });
  assert.ok(bundle.userPrompt.includes('reference at least 1 observed cue'));
});

test('skin type rule: report prompt treats it as prior', () => {
  const bundle = buildSkinReportPromptBundle({ language: 'en-US', dto: {} });
  assert.ok(bundle.userPrompt.includes('PRIOR'));
  assert.ok(bundle.userPrompt.includes('not ground truth'));
});
