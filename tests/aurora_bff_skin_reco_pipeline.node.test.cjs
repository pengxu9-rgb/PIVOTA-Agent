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
const { buildAnalysisContextSnapshotV1 } = require('../src/auroraBff/analysisContextSnapshot');
const { hasUsableArtifactForRecommendations } = require('../src/auroraBff/gating');
const { buildIngredientPlan } = require('../src/auroraBff/ingredientMapperV1');
const { buildProductRecommendationsBundle, toLegacyRecommendationsPayload } = require('../src/auroraBff/productMatcherV1');
const { evaluateSafetyBoundary } = require('../src/auroraBff/safetyBoundary');
const { __internal: routesInternal } = require('../src/auroraBff/routes');

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

test('artifact store: reco-context latest readback ignores async kb backfill artifacts', async (t) => {
  const prev = process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
  process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '0';
  t.after(() => {
    if (prev === undefined) delete process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
    else process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = prev;
  });

  const auroraUid = `uid_reco_context_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const sessionId = `brief_reco_context_${Date.now()}`;
  const recoArtifact = await saveDiagnosisArtifact({
    auroraUid,
    sessionId,
    artifact: makeArtifact({
      score: 0.86,
      skinType: 'dry',
      barrierStatus: 'impaired',
      sensitivity: 'high',
      goals: ['barrier repair'],
    }),
  });
  await saveDiagnosisArtifact({
    auroraUid,
    sessionId,
    artifact: {
      artifact_use: 'kb_backfill',
      artifact_type: 'skin_analysis_kb_snapshot_v1',
      created_at: new Date().toISOString(),
      analysis_summary: { analysis: { summary: 'async backfill only' } },
      overall_confidence: { score: 0.91, level: 'high' },
    },
  });

  const latestReco = await getLatestDiagnosisArtifact({
    auroraUid,
    sessionId,
    maxAgeDays: 30,
    artifactUse: 'reco_context',
  });
  assert.equal(latestReco && latestReco.artifact_id, recoArtifact.artifact_id);
  assert.equal(latestReco && latestReco.artifact_use, 'reco_context');
  const snapshot = buildAnalysisContextSnapshotV1({
    latestArtifact: latestReco
      ? {
        ...latestReco.artifact_json,
        artifact_id: latestReco.artifact_id,
        created_at: latestReco.created_at,
      }
      : null,
  });
  assert.ok(snapshot);
  assert.equal(snapshot.barrier_status_tendency?.winner?.value, 'impaired');
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

test('gating: artifact gate exposes minimal/strong eligibility tiers', () => {
  const missingCore = hasUsableArtifactForRecommendations({
    skinType: { value: 'oily' },
    sensitivity: { value: 'medium' },
    barrierStatus: { value: '' },
    goals: { values: [] },
    overall_confidence: { score: 0.82 },
  });
  assert.equal(missingCore.ok, false);
  assert.equal(missingCore.tier, 'ineligible');
  assert.equal(Array.isArray(missingCore.missing_core), true);
  assert.equal(missingCore.missing_core.includes('barrierStatus'), true);
  assert.equal(missingCore.missing_core.includes('goals'), true);

  const minimal = hasUsableArtifactForRecommendations({
    skinType: { value: 'oily' },
    sensitivity: { value: '' },
    barrierStatus: { value: '' },
    goals: { values: ['barrier repair'] },
    overall_confidence: { score: 0.7 },
  });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.tier, 'eligible_minimal');

  const complete = hasUsableArtifactForRecommendations(makeArtifact({ score: 0.7 }));
  assert.equal(complete.ok, true);
  assert.equal(complete.tier, 'eligible_strong');
  assert.equal(complete.confidence_level, 'medium');
});

test('gating: diagnosis artifact rows must be flattened before recommendation gate check', () => {
  const artifact = makeArtifact({ score: 0.68 });
  const artifactRow = {
    artifact_id: artifact.artifact_id,
    created_at: artifact.created_at,
    artifact_json: artifact,
  };

  const rawRowGate = hasUsableArtifactForRecommendations(artifactRow);
  assert.equal(rawRowGate.ok, false);
  assert.equal(rawRowGate.reason, 'artifact_missing_core');

  const flattened = {
    ...artifactRow.artifact_json,
    artifact_id: artifactRow.artifact_id,
    created_at: artifactRow.created_at,
  };
  const flattenedGate = hasUsableArtifactForRecommendations(flattened);
  assert.equal(flattenedGate.ok, true);
  assert.equal(flattenedGate.tier, 'eligible_strong');
  assert.equal(flattenedGate.confidence_level, 'medium');
});

test('analysis guidance-only mode strips concrete product payloads before UI rendering', () => {
  const plan = {
    targets: [
      {
        ingredient_id: 'ceramide_np',
        products: [{ product_id: 'sku_1' }],
        product_rows: [{ product_id: 'sku_2' }],
        competitors: [{ product_id: 'sku_3' }],
        dupes: [{ product_id: 'sku_4' }],
      },
    ],
  };
  const mode = routesInternal.resolveAnalysisProductSurfaceMode({
    analysisMode: 'analysis_summary',
    recoArtifactEligible: false,
  });
  const stripped = routesInternal.stripIngredientPlanConcreteProducts(plan);

  assert.equal(mode, 'guidance_only');
  assert.equal(Array.isArray(stripped.targets), true);
  assert.equal(stripped.targets[0]?.products?.mode, 'guidance_only');
  assert.equal(Array.isArray(stripped.targets[0]?.products?.example_product_types), true);
  assert.equal(stripped.targets[0]?.products?.example_product_types.length > 0, true);
  assert.equal(Array.isArray(stripped.targets[0]?.products?.example_product_discovery_items), true);
  assert.equal(stripped.targets[0]?.products?.example_product_discovery_items.length > 0, true);
  assert.equal(typeof stripped.targets[0]?.products?.example_product_discovery_items[0]?.search_query, 'string');
  assert.equal(stripped.targets[0]?.products?.note, 'Tap a product type to browse top matching products.');
  assert.equal('product_rows' in stripped.targets[0], false);
  assert.equal('competitors' in stripped.targets[0], false);
  assert.equal('dupes' in stripped.targets[0], false);
});

test('guidance-only ingredient plan cards never rehydrate concrete sku payloads after v2 upgrade', () => {
  const card = routesInternal.buildIngredientPlanCard({
    schema_version: 'aurora.ingredient_plan.v2',
    targets: [
      {
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
        why: ['Barrier support'],
        products: {
          competitors: [{ product_id: 'sku_1' }],
          dupes: [{ product_id: 'sku_2' }],
        },
        external_fallback_used: true,
      },
    ],
    avoid: [],
    conflicts: [],
  }, 'req_test', null, { product_surface_mode: 'guidance_only' });

  assert.equal(card.type, 'ingredient_plan_v2');
  assert.equal(card.payload.product_surface_mode, 'guidance_only');
  assert.equal(Array.isArray(card.payload.targets), true);
  assert.equal(card.payload.targets[0]?.products?.mode, 'guidance_only');
  assert.equal(Array.isArray(card.payload.targets[0]?.products?.example_product_types), true);
  assert.equal(card.payload.targets[0]?.products?.example_product_types.length > 0, true);
  assert.equal(Array.isArray(card.payload.targets[0]?.products?.example_product_discovery_items), true);
  assert.equal(card.payload.targets[0]?.products?.example_product_discovery_items.length > 0, true);
  assert.equal(typeof card.payload.targets[0]?.products?.example_product_discovery_items[0]?.search_query, 'string');
  assert.equal(Array.isArray(card.payload.targets[0]?.products?.competitors), false);
  assert.equal(Array.isArray(card.payload.targets[0]?.products?.dupes), false);
  assert.equal('external_fallback_used' in card.payload.targets[0], false);
});

test('latest reco context canonicalizes seeds, limits carry-over, and keeps current-turn priority', () => {
  const payload = routesInternal.buildLatestRecoContextPayload({
    baseContext: {
      reco_context_version: 'aurora.reco_context.v1',
      seed_terms: ['barrier support', 'ceramide', 'fragrance free', 'panthenol'],
      diagnosis_goal: 'barrier repair',
      target_step: 'moisturizer',
    },
    message: 'Recommend a moisturizer for barrier repair with ceramides',
    explicitSeedTerms: ['repair skin barrier', 'ceramide', 'panthenol', 'sensitive skin', 'extra seed'],
    recommendationTaskContext: {
      task_hard_context: {
        ingredient_targets: ['panthenol'],
      },
      task_soft_context: {
        background_goals: ['hydration'],
        ingredient_targets: ['uv filters'],
      },
    },
  });

  assert.equal(payload.reco_context_version, 'aurora.reco_context.v2');
  assert.equal(payload.diagnosis_goal, 'barrier repair');
  assert.equal(payload.target_step, 'moisturizer');
  assert.deepEqual(payload.seed_terms, ['barrier repair', 'ceramide', 'panthenol', 'sensitive skin']);
});

test('analysis clarification pack does not synthesize legacy profile questions for diagnosis v2', () => {
  const pack = routesInternal.buildAnalysisClarificationPack({
    language: 'EN',
    artifactGate: {
      tier: 'ineligible',
      reason: 'artifact_missing_core',
      missing_core: ['barrierStatus', 'sensitivity', 'skinType'],
    },
    hasCurrentRoutine: false,
    diagnosisGoal: 'Repair skin barrier',
    targetStep: 'moisturizer',
  });

  assert.equal(pack, null);
});

test('step reco context strength flags contexts that are too weak even when search is valid', () => {
  const weak = routesInternal.evaluateStepRecoContextStrength({
    latestRecoContext: {
      reco_artifact_eligible: false,
      diagnosis_goal: 'barrier repair',
      target_step: 'moisturizer',
    },
    recommendationTaskContext: {
      task_hard_context: {},
      task_soft_context: {},
    },
    targetContext: { resolved_target_step: '' },
    recoArtifactEligible: false,
  });
  const strong = routesInternal.evaluateStepRecoContextStrength({
    latestRecoContext: {
      reco_artifact_eligible: false,
      diagnosis_goal: 'barrier repair',
    },
    recommendationTaskContext: {
      task_hard_context: {
        barrier_status: 'impaired',
        ingredient_targets: ['ceramide'],
      },
      task_soft_context: {},
    },
    targetContext: { resolved_target_step: '' },
    recoArtifactEligible: false,
  });

  assert.equal(weak.context_too_weak, true);
  assert.equal(strong.context_too_weak, false);
  assert.equal(strong.has_durable_hard_field, true);
  assert.equal(strong.has_ingredient_signals, true);
});

test('analysis snapshot hash is canonical across equivalent payload shapes', () => {
  const snapshotA = {
    skin_type_tendency: { winner: { value: 'dry' } },
    barrier_status_tendency: { winner: { value: 'impaired' } },
    recent_log_signals: [],
  };
  const snapshotB = {
    barrier_status_tendency: { winner: { value: 'impaired' } },
    recent_log_signals: [],
    skin_type_tendency: { winner: { value: 'dry' } },
  };

  assert.equal(
    routesInternal.buildAnalysisContextSnapshotHash(snapshotA),
    routesInternal.buildAnalysisContextSnapshotHash(snapshotB),
  );
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

test('product matcher: default seed catalog is disabled unless explicitly allowed', (t) => {
  const prevAllowSeed = process.env.AURORA_PRODUCT_REC_ALLOW_SEED_CATALOG;
  const prevInternalMode = process.env.INTERNAL_TEST_MODE;
  t.after(() => {
    if (prevAllowSeed === undefined) delete process.env.AURORA_PRODUCT_REC_ALLOW_SEED_CATALOG;
    else process.env.AURORA_PRODUCT_REC_ALLOW_SEED_CATALOG = prevAllowSeed;
    if (prevInternalMode === undefined) delete process.env.INTERNAL_TEST_MODE;
    else process.env.INTERNAL_TEST_MODE = prevInternalMode;
  });

  const ingredientPlan = {
    plan_id: 'ip_seed_gate_test',
    confidence: { score: 0.74 },
    intensity: 'balanced',
    targets: [{ ingredient_id: 'ceramide_np', priority: 92, role: 'hero' }],
    avoid: [],
  };
  const profile = {
    skinType: 'dry',
    barrierStatus: 'compromised',
    sensitivity: 'high',
    budgetTier: 'mid',
    region: 'US',
  };
  const artifact = makeArtifact({ score: 0.78, skinType: 'dry', barrierStatus: 'compromised', sensitivity: 'high' });
  const countCandidates = (bundle) =>
    Object.values(bundle && bundle.products_by_slot ? bundle.products_by_slot : {}).reduce(
      (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
      0,
    );

  process.env.AURORA_PRODUCT_REC_ALLOW_SEED_CATALOG = 'false';
  process.env.INTERNAL_TEST_MODE = 'false';
  const blocked = buildProductRecommendationsBundle({
    ingredientPlan,
    artifact,
    profile,
    language: 'EN',
  });
  assert.equal(countCandidates(blocked), 0);

  process.env.AURORA_PRODUCT_REC_ALLOW_SEED_CATALOG = 'true';
  const allowed = buildProductRecommendationsBundle({
    ingredientPlan,
    artifact,
    profile,
    language: 'EN',
  });
  assert.equal(countCandidates(allowed) > 0, true);
});

test('product matcher: legacy payload de-duplicates repeated product ids across AM/PM rows', () => {
  const bundle = {
    products_by_slot: {
      cleanser: [],
      moisturizer: [
        {
          product_id: 'prod_repeat_1',
          routine_slot: 'moisturizer',
          name: 'Repeat Moisturizer',
          brand: 'Pivota Labs',
          score: 89,
          price_band: 'mid',
          matched_ingredients: [{ ingredient_id: 'ceramide_np', contribution: 80 }],
          fit_explanations: ['Good barrier fit'],
        },
        {
          product_id: 'prod_repeat_2',
          routine_slot: 'moisturizer',
          name: 'Second Moisturizer',
          brand: 'Pivota Labs',
          score: 82,
          price_band: 'mid',
          matched_ingredients: [{ ingredient_id: 'panthenol', contribution: 75 }],
          fit_explanations: ['Secondary barrier support'],
        },
      ],
      sunscreen: [],
      treatment: [],
      toner: [],
      optional: [],
    },
    confidence: { score: 0.71, level: 'medium', rationale: ['test_payload'] },
    top_messages: [],
  };

  const legacy = toLegacyRecommendationsPayload(bundle, { language: 'EN' });
  const ids = legacy.recommendations.map((row) => String(row && row.product_id ? row.product_id : '').trim()).filter(Boolean);

  assert.deepEqual(ids, ['prod_repeat_1', 'prod_repeat_2']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(legacy.recommendations.every((row) => row && (row.slot === 'am' || row.slot === 'pm')), true);
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

  const negated = evaluateSafetyBoundary({
    message: "No bleeding and no fever now, just mild dryness after cleanser.",
    language: 'EN',
    profile: { barrierStatus: 'healthy', sensitivity: 'low' },
  });
  assert.equal(negated.block, false);

  const cnBlocked = evaluateSafetyBoundary({
    message: '这两天突然扩散并且有渗液，还发烧了。',
    language: 'CN',
    profile: { barrierStatus: 'healthy', sensitivity: 'low' },
  });
  assert.equal(cnBlocked.block, true);
});
