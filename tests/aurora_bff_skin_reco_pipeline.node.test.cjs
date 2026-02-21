const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  saveDiagnosisArtifact,
  getLatestDiagnosisArtifact,
  getDiagnosisArtifactById,
  saveIngredientPlan,
  getIngredientPlanByArtifactId,
  saveRecoRun,
} = require('../src/auroraBff/diagnosisArtifactStore');
const { hasUsableArtifactForRecommendations } = require('../src/auroraBff/gating');
const { buildIngredientPlan } = require('../src/auroraBff/ingredientMapperV1');
const { buildProductRecommendationsBundle, toLegacyRecommendationsPayload } = require('../src/auroraBff/productMatcherV1');
const { evaluateSafetyBoundary } = require('../src/auroraBff/safetyBoundary');

function makeArtifact({
  usePhoto = true,
  score = 0.8,
  skinType = 'oily',
  barrierStatus = 'healthy',
  sensitivity = 'low',
  goals = ['acne'],
  concerns = [],
} = {}) {
  return {
    artifact_id: `da_test_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: new Date().toISOString(),
    use_photo: usePhoto,
    skinType: { value: skinType, confidence: { score, level: score > 0.75 ? 'high' : 'medium', rationale: ['test'] }, evidence: [] },
    barrierStatus: { value: barrierStatus, confidence: { score, level: score > 0.75 ? 'high' : 'medium', rationale: ['test'] }, evidence: [] },
    sensitivity: { value: sensitivity, confidence: { score, level: score > 0.75 ? 'high' : 'medium', rationale: ['test'] }, evidence: [] },
    goals: { values: goals, confidence: { score, level: score > 0.75 ? 'high' : 'medium', rationale: ['test'] }, evidence: [] },
    concerns,
    overall_confidence: { score, level: score > 0.75 ? 'high' : score >= 0.55 ? 'medium' : 'low', rationale: ['test'] },
  };
}

test('artifact store: in-memory persistence works when retention is disabled', async (t) => {
  const prev = process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
  process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '0';
  t.after(() => {
    if (prev === undefined) delete process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
    else process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = prev;
  });

  const auroraUid = `uid_store_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const artifact = makeArtifact();
  const saved = await saveDiagnosisArtifact({ auroraUid, artifact });

  assert.ok(saved && saved.artifact_id);
  const latest = await getLatestDiagnosisArtifact({ auroraUid, maxAgeDays: 30 });
  assert.equal(latest && latest.artifact_id, saved.artifact_id);

  const byId = await getDiagnosisArtifactById({ artifactId: saved.artifact_id, auroraUid });
  assert.equal(byId && byId.artifact_id, saved.artifact_id);

  const planSaved = await saveIngredientPlan({
    artifactId: saved.artifact_id,
    auroraUid,
    plan: { plan_id: 'ip_local', intensity: 'balanced', targets: [], avoid: [], conflicts: [] },
  });
  assert.ok(planSaved && planSaved.plan_id);

  const planLoaded = await getIngredientPlanByArtifactId({ artifactId: saved.artifact_id });
  assert.equal(planLoaded && planLoaded.plan_id, planSaved.plan_id);

  const recoRun = await saveRecoRun({
    artifactId: saved.artifact_id,
    planId: planSaved.plan_id,
    auroraUid,
    requestContext: { test: true },
    reco: { ok: true },
    overallConfidence: 0.72,
  });
  assert.ok(recoRun && recoRun.reco_run_id);
});

test('artifact store: session pointer preference and explicit artifact pointer behave as expected', async (t) => {
  const prev = process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
  process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '0';
  t.after(() => {
    if (prev === undefined) delete process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
    else process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = prev;
  });

  const auroraUid = `uid_pointer_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const sessionA = `brief_a_${Date.now()}`;
  const sessionB = `brief_b_${Date.now()}`;

  const artifactA = await saveDiagnosisArtifact({
    auroraUid,
    sessionId: sessionA,
    artifact: makeArtifact({ score: 0.78, goals: ['redness'] }),
  });
  const artifactB = await saveDiagnosisArtifact({
    auroraUid,
    sessionId: sessionB,
    artifact: makeArtifact({ score: 0.82, goals: ['acne'] }),
  });

  assert.ok(artifactA && artifactA.artifact_id);
  assert.ok(artifactB && artifactB.artifact_id);

  // Session-specific lookup should return the matching session artifact even if it's not the latest one.
  const bySession = await getLatestDiagnosisArtifact({
    auroraUid,
    sessionId: sessionA,
    maxAgeDays: 30,
  });
  assert.equal(bySession && bySession.artifact_id, artifactA.artifact_id);

  // Explicit pointer (latest_artifact_id) should override normal latest/session ordering when present.
  const byPointer = await getLatestDiagnosisArtifact({
    auroraUid,
    sessionId: sessionB,
    preferArtifactId: artifactA.artifact_id,
    maxAgeDays: 30,
  });
  assert.equal(byPointer && byPointer.artifact_id, artifactA.artifact_id);
});

test('artifact store: stale preferArtifactId is ignored when it falls outside max age window', async (t) => {
  const prev = process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
  process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '0';
  const realDateNow = Date.now;
  t.after(() => {
    Date.now = realDateNow;
    if (prev === undefined) delete process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
    else process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = prev;
  });

  const auroraUid = `uid_stale_pointer_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const artifact = await saveDiagnosisArtifact({
    auroraUid,
    sessionId: `brief_${Date.now()}`,
    artifact: makeArtifact({ score: 0.74, goals: ['pores'] }),
  });
  assert.ok(artifact && artifact.artifact_id);

  // Simulate lookup in the future so saved artifacts are outside maxAgeDays.
  Date.now = () => realDateNow() + (2 * 24 * 60 * 60 * 1000);

  const latest = await getLatestDiagnosisArtifact({
    auroraUid,
    preferArtifactId: artifact.artifact_id,
    maxAgeDays: 1,
  });
  assert.equal(latest, null);
});

test('gating: artifact gate blocks missing core4 and allows complete artifact', () => {
  const missingCore = hasUsableArtifactForRecommendations({
    skinType: { value: 'oily' },
    sensitivity: { value: 'medium' },
    barrierStatus: { value: '' },
    goals: { values: [] },
    overall_confidence: { score: 0.82 },
  });
  assert.equal(missingCore.ok, false);
  assert.equal(Array.isArray(missingCore.missing_core), true);
  assert.equal(missingCore.missing_core.includes('barrierStatus'), true);
  assert.equal(missingCore.missing_core.includes('goals'), true);

  const complete = hasUsableArtifactForRecommendations(makeArtifact({ score: 0.7 }));
  assert.equal(complete.ok, true);
  assert.equal(complete.confidence_level, 'medium');
});

test('ingredient mapper: low confidence forces gentle baseline and avoids strong actives', () => {
  const artifact = makeArtifact({
    usePhoto: false,
    score: 0.35,
    skinType: 'combination',
    barrierStatus: 'impaired',
    sensitivity: 'high',
    goals: ['redness'],
  });

  const plan = buildIngredientPlan({ artifact, profile: { currentRoutine: 'retinol nightly' } });
  assert.equal(plan.intensity, 'gentle');
  assert.equal(Array.isArray(plan.targets), true);
  assert.equal(plan.targets.some((t) => t.ingredient_id === 'ceramide_np'), true);
  assert.equal(plan.avoid.some((a) => a.ingredient_id === 'retinol'), true);
});

test('ingredient mapper: medium-high confidence acne profile emits acne-oriented targets', () => {
  const artifact = makeArtifact({
    usePhoto: true,
    score: 0.82,
    skinType: 'oily',
    barrierStatus: 'healthy',
    sensitivity: 'low',
    goals: ['acne'],
    concerns: [{ id: 'acne', confidence: { score: 0.9 }, evidence: [] }],
  });

  const plan = buildIngredientPlan({ artifact, profile: { currentRoutine: 'gentle cleanser + moisturizer' } });
  const targetIds = new Set((plan.targets || []).map((t) => String(t.ingredient_id || '')));

  assert.equal(plan.intensity === 'balanced' || plan.intensity === 'active', true);
  assert.equal(targetIds.has('sunscreen_filters'), true);
  assert.equal(targetIds.has('salicylic_acid') || targetIds.has('azelaic_acid'), true);
});

test('product matcher: filters avoid/risky products and returns explainable slot bundles', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora_pm_'));
  const catalogPath = path.join(tempDir, 'catalog.json');
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    catalogPath,
    JSON.stringify(
      [
        {
          product_id: 'prod_spf_1',
          name: 'Daily UV Shield SPF 50',
          brand: 'Pivota Labs',
          market_scope: ['US'],
          ingredient_ids: ['sunscreen_filters', 'niacinamide'],
          risk_tags: ['sunscreen', 'lightweight'],
          price_band: 'mid',
        },
        {
          product_id: 'prod_moist_1',
          name: 'Barrier Restore Cream',
          brand: 'Pivota Labs',
          market_scope: ['US'],
          ingredient_ids: ['ceramide_np', 'panthenol', 'glycerin'],
          risk_tags: ['repair'],
          price_band: 'mid',
        },
        {
          product_id: 'prod_treat_1',
          name: 'Night Retinol Booster',
          brand: 'Pivota Labs',
          market_scope: ['US'],
          ingredient_ids: ['retinol'],
          risk_tags: ['retinoid', 'strong'],
          price_band: 'mid',
        },
      ],
      null,
      2,
    ),
    'utf8',
  );

  const ingredientPlan = {
    plan_id: 'ip_matcher_test',
    confidence: { score: 0.72 },
    intensity: 'gentle',
    targets: [
      { ingredient_id: 'sunscreen_filters', priority: 95, role: 'hero' },
      { ingredient_id: 'ceramide_np', priority: 88, role: 'hero' },
    ],
    avoid: [{ ingredient_id: 'retinol', severity: 'avoid', reason: ['fragile profile'] }],
  };

  const bundle = buildProductRecommendationsBundle({
    ingredientPlan,
    artifact: makeArtifact({ score: 0.72, barrierStatus: 'compromised', sensitivity: 'high' }),
    profile: { skinType: 'dry', barrierStatus: 'compromised', sensitivity: 'high', budgetTier: 'mid', region: 'US' },
    language: 'EN',
    catalogPath,
    disallowTreatment: true,
    maxPerSlot: 4,
  });

  assert.ok(bundle && bundle.products_by_slot);
  assert.equal(Array.isArray(bundle.products_by_slot.sunscreen), true);
  assert.equal(bundle.products_by_slot.sunscreen.length > 0, true);
  assert.equal(bundle.products_by_slot.moisturizer.length > 0, true);
  assert.equal(bundle.products_by_slot.treatment.length, 0);

  const legacy = toLegacyRecommendationsPayload(bundle, { language: 'EN' });
  assert.equal(Array.isArray(legacy.recommendations), true);
  assert.equal(legacy.recommendations.length > 0, true);
});

test('safety boundary: red-flag messages block recommendations', () => {
  const blocked = evaluateSafetyBoundary({
    message: 'I have severe pain, oozing pus and fever around my eye.',
    language: 'EN',
    profile: { barrierStatus: 'healthy', sensitivity: 'low' },
  });
  assert.equal(blocked.block, true);
  assert.equal(Array.isArray(blocked.flags), true);
  assert.equal(blocked.flags.length > 0, true);

  const normal = evaluateSafetyBoundary({
    message: 'My skin feels dry after cleansing, please suggest a gentle routine.',
    language: 'EN',
    profile: { barrierStatus: 'healthy', sensitivity: 'low' },
  });
  assert.equal(normal.block, false);
});
