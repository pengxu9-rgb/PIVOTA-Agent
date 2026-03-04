const test = require('node:test');
const assert = require('node:assert/strict');

const { createSkillRequestContext } = require('../src/auroraBff/skills/contracts');
const { runDiagnosisOrchestrator } = require('../src/auroraBff/diagnosisOrchestrator');
const { evaluatePolicySafetyGuard } = require('../src/auroraBff/policySafetyGuard');

function makeReq() {
  return {
    get() {
      return null;
    },
  };
}

function makeCtx() {
  return {
    request_id: 'req_skill_test',
    trace_id: 'trace_skill_test',
    aurora_uid: 'uid_skill_test',
    lang: 'EN',
  };
}

test('skills: request context carries trace and timeout defaults', () => {
  const context = createSkillRequestContext({
    req: makeReq(),
    ctx: makeCtx(),
    stage: 'analysis_skin',
  });

  assert.equal(context.request_id, 'req_skill_test');
  assert.equal(context.trace_id, 'trace_skill_test');
  assert.equal(context.stage, 'analysis_skin');
  assert.equal(typeof context.timeout_ms, 'number');
  assert.ok(context.timeout_ms > 0);
});

test('skills: orchestrator runs configured skills and reports summary', async () => {
  const context = createSkillRequestContext({
    req: makeReq(),
    ctx: makeCtx(),
    stage: 'analysis_skin',
  });

  const output = await runDiagnosisOrchestrator({
    requestContext: context,
    logger: null,
    mode: 'analysis_preflight',
    input: {
      skinStateSelection: {
        profile: { skinType: 'oily', sensitivity: 'high', barrierStatus: 'impaired', goals: ['acne'] },
        selections: {},
      },
      photoCaptureQuality: {
        photos: [{ photo_id: 'p1', slot_id: 'daylight', qc_status: 'passed' }],
      },
      ingredientRecommendation: {
        issues: [{ issue_type: 'redness' }],
        language: 'EN',
        barrierStatus: 'impaired',
        sensitivity: 'high',
        market: 'US',
      },
      productRecommendation: {
        mode: 'module',
        input: {
          moduleId: 'test_module',
          issues: [{ issue_type: 'redness', severity_0_4: 2 }],
          actions: [{ ingredient_id: 'panthenol' }],
          market: 'US',
          lang: 'EN',
          riskTier: 'sensitive',
          qualityGrade: 'degraded',
        },
      },
      analysisSummaryBuilder: {
        analysis: { findings: [] },
        lowConfidence: false,
        photosProvided: true,
        usedPhotos: false,
        analysisSource: 'rule_based',
      },
      photoRegionSelection: {
        analysis: { findings: [] },
        options: { enabled: false },
      },
    },
  });

  assert.equal(output.mode, 'analysis_preflight');
  assert.ok(output.summary.total >= 4);
  assert.ok(output.summary.succeeded >= 4);
  assert.ok(Array.isArray(output.execution_order));
  assert.ok(output.execution_order.includes('skin_state_selection'));
  assert.ok(output.execution_order.includes('photo_capture_quality'));
  assert.ok(output.execution_order.includes('ingredient_recommendation'));
  assert.ok(output.execution_order.includes('product_recommendation'));

  const skinState = output.skills.skin_state_selection;
  assert.equal(skinState.ok, true);
  assert.deepEqual(skinState.data.missing_fields, []);

  const quality = output.skills.photo_capture_quality;
  assert.equal(quality.ok, true);
  assert.equal(quality.data.quality_grade, 'pass');

  const productReco = output.skills.product_recommendation;
  assert.equal(productReco.ok, true);
  assert.ok(Array.isArray(productReco.data.recommendations));
});

test('skills: photo skin analysis fails safely when image is missing', async () => {
  const context = createSkillRequestContext({
    req: makeReq(),
    ctx: makeCtx(),
    stage: 'analysis_skin',
  });

  const output = await runDiagnosisOrchestrator({
    requestContext: context,
    logger: null,
    mode: 'analysis_photo',
    input: {
      photoSkinAnalysis: {
        imageBuffer: null,
        language: 'EN',
      },
    },
  });

  assert.equal(output.summary.total, 1);
  assert.equal(output.summary.failed, 1);
  assert.equal(output.skills.photo_skin_analysis.ok, false);
  assert.equal(output.skills.photo_skin_analysis.error.degrade_to, 'rule_based');
});

test('skills: policy safety guard blocks on safety boundary and degrades on low confidence', () => {
  const blocked = evaluatePolicySafetyGuard({
    phase: 'chat_reco',
    boundaryDecision: { block: true },
    confidenceLevel: 'medium',
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'safety_boundary');

  const degraded = evaluatePolicySafetyGuard({
    phase: 'chat_reco',
    confidenceLevel: 'low',
  });
  assert.equal(degraded.blocked, false);
  assert.equal(degraded.degrade, true);
  assert.equal(degraded.reason, 'low_confidence');
});
