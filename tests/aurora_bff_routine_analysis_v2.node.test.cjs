const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  seedCompleteProfile,
  parseCards,
  findCard,
} = require('./aurora_bff_test_harness.cjs');

function buildAuditProduct(productRef, overrides = {}) {
  const inputLabel = overrides.input_label || overrides.inputLabel || 'Foaming cleanser';
  const inferredProductType = overrides.inferred_product_type || overrides.inferredProductType || 'cleanser';
  const likelyRole = overrides.likely_role || overrides.likelyRole || 'cleansing';
  return {
    product_ref: productRef,
    slot: overrides.slot || 'am',
    original_step_label: overrides.original_step_label || overrides.originalStepLabel || 'cleanser',
    input_label: inputLabel,
    resolved_name_or_null: Object.prototype.hasOwnProperty.call(overrides, 'resolved_name_or_null') ? overrides.resolved_name_or_null : null,
    evidence_basis: overrides.evidence_basis || ['step_label'],
    inferred_product_type: inferredProductType,
    likely_role: likelyRole,
    likely_key_ingredients_or_signals: overrides.likely_key_ingredients_or_signals || overrides.likelyKeyIngredientsOrSignals || [`${inferredProductType} signal`],
    fit_for_skin_type: overrides.fit_for_skin_type || {
      verdict: 'mixed',
      reason: 'This looks usable for oily skin, but a foaming texture can feel stronger on a stressed barrier.',
    },
    fit_for_goals: overrides.fit_for_goals || [
      {
        goal: 'acne',
        verdict: 'mixed',
        reason: 'Cleansing can help reduce excess oil, but this is not a dedicated acne treatment step.',
      },
      {
        goal: 'pores',
        verdict: 'mixed',
        reason: 'It can help remove surface oil, but pore appearance usually depends on leave-on treatment support too.',
      },
    ],
    fit_for_season_or_climate: overrides.fit_for_season_or_climate || {
      verdict: 'good',
      reason: 'This category usually stays workable across seasons unless the cleanser feels stripping.',
    },
    potential_concerns: overrides.potential_concerns || [],
    suggested_action: overrides.suggested_action || 'keep',
    confidence: Object.prototype.hasOwnProperty.call(overrides, 'confidence') ? overrides.confidence : 0.72,
    missing_info: overrides.missing_info || [],
    concise_reasoning_en: overrides.concise_reasoning_en || 'This reads like a standard cleanser, so the main question is whether it feels too strong for the current barrier state.',
  };
}

function buildStageAResult(products, overrides = {}) {
  return {
    schema_version: 'aurora.routine_product_audit.v1',
    products,
    additional_items_needing_verification: overrides.additional_items_needing_verification || [],
    missing_info: overrides.missing_info || [],
    confidence: Object.prototype.hasOwnProperty.call(overrides, 'confidence') ? overrides.confidence : 0.72,
    ...overrides,
  };
}

function buildStageBResult(overrides = {}) {
  return {
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: {
      summary: 'The routine is directionally workable but needs a small adjustment.',
      main_strengths: ['It already covers cleansing and moisturizing.'],
      main_issues: ['Daytime protection still needs attention.'],
    },
    per_step_order_am: [],
    per_step_order_pm: [],
    overlap_or_gaps: [],
    top_3_adjustments: [
      {
        adjustment_id: 'adj_spf',
        priority_rank: 1,
        title: 'Add a clear AM sunscreen step',
        action_type: 'add_step',
        affected_products: [],
        why_this_first: 'AM protection is still missing.',
        expected_outcome: 'More complete daytime protection.',
      },
    ],
    improved_am_routine: [
      {
        step_order: 1,
        what_to_use: 'Sunscreen',
        frequency: 'daily',
        note: 'Place it at the end of the AM routine.',
        source_type: 'step_placeholder',
      },
    ],
    improved_pm_routine: [],
    rationale_for_each_adjustment: [
      {
        adjustment_id: 'adj_spf',
        reasoning: 'The routine still lacks a dedicated sunscreen step.',
        evidence: ['No audited AM product clearly reads as sunscreen.'],
        tradeoff_or_caution: 'Keep the texture wearable enough for daily use.',
      },
    ],
    recommendation_needs: [
      {
        adjustment_id: 'adj_spf',
        need_state: 'fill_gap',
        target_step: 'sunscreen',
        why: 'AM protection is still missing.',
        required_attributes: ['broad-spectrum protection'],
        avoid_attributes: ['unclear SPF claims'],
        timing: 'am',
        texture_or_format: 'fluid',
        priority: 'high',
      },
    ],
    recommendation_queries: [
      {
        adjustment_id: 'adj_spf',
        query_en: 'broad-spectrum sunscreen fluid daily',
      },
    ],
    confidence: 0.74,
    missing_info: [],
    ...overrides,
  };
}

test('/v1/analysis/skin: routine analysis v2 emits product-first cards with compatibility meta', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'false',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_analysis_v2');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'CeraVe Hydrating Cleanser',
                treatment: 'Vitamin C serum',
                moisturizer: 'Light gel cream',
              },
              pm: {
                cleanser: 'CeraVe Hydrating Cleanser',
                treatment: 'Retinol serum',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.equal(cards[0] && cards[0].type, 'routine_product_audit_v1');
        assert.equal(cards[1] && cards[1].type, 'routine_adjustment_plan_v1');
        assert.equal(Boolean(findCard(cards, 'analysis_summary')), false);
        assert.equal(Boolean(findCard(cards, 'analysis_story_v2')), false);
        assert.equal(Boolean(findCard(cards, 'routine_fit_summary')), false);

        const auditCard = findCard(cards, 'routine_product_audit_v1');
        assert.ok(auditCard, 'routine_product_audit_v1 should exist');
        assert.ok(Array.isArray(auditCard.payload && auditCard.payload.products));
        assert.ok(auditCard.payload.products.length >= 1, 'audit card should include products');

        const adjustmentCard = findCard(cards, 'routine_adjustment_plan_v1');
        assert.ok(adjustmentCard, 'routine_adjustment_plan_v1 should exist');
        assert.ok(Array.isArray(adjustmentCard.payload && adjustmentCard.payload.top_3_adjustments));

        const sessionPatch = resp.body && resp.body.session_patch && typeof resp.body.session_patch === 'object'
          ? resp.body.session_patch
          : {};
        assert.equal(sessionPatch.next_state, 'ROUTINE_REVIEW');
        const meta = sessionPatch.meta && typeof sessionPatch.meta === 'object' ? sessionPatch.meta : {};
        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.analysis_mode, 'routine_v2');
        assert.equal(typeof analysisMeta.reco_artifact_eligible, 'boolean');
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_payload_shape'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_product_enrichment_deferred'), false);
        assert.equal(Boolean(meta.routine_analysis_v2 && meta.routine_analysis_v2.enabled), true);
        assert.equal(meta.routine_analysis_legacy_compat && meta.routine_analysis_legacy_compat.source, 'routine_analysis_v2');
        assert.equal(meta.analysis_contract && meta.analysis_contract.analysis_mode, 'routine_v2');
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: routine analysis v2 stays enabled when env flag is absent', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: undefined,
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'false',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_analysis_v2_default_on');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Foaming cleanser',
                moisturizer: 'Gel moisturizer',
              },
              pm: {
                cleanser: 'Foaming cleanser',
                treatment: 'Retinol serum',
              },
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.equal(cards[0] && cards[0].type, 'routine_product_audit_v1');
        assert.equal(cards[1] && cards[1].type, 'routine_adjustment_plan_v1');
        assert.equal(Boolean(findCard(cards, 'analysis_story_v2')), false);
        assert.equal(Boolean(findCard(cards, 'routine_fit_summary')), false);

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.routine_analysis_version, 'v2');
        assert.equal(analysisMeta.analysis_mode, 'routine_v2');
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: routine analysis v2 failure stays explicit and does not fall back to routine_fit_summary', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'false',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const routineAnalysisModuleId = require.resolve('../src/auroraBff/routineAnalysisV2');
      delete require.cache[routineAnalysisModuleId];
      const routineAnalysisModule = require('../src/auroraBff/routineAnalysisV2');
      const originalRunRoutineAnalysisV2 = routineAnalysisModule.runRoutineAnalysisV2;
      routineAnalysisModule.runRoutineAnalysisV2 = async () => {
        const err = new Error('routine analysis v2 upstream unavailable');
        err.code = 'ROUTINE_V2_TEST_FAILURE';
        throw err;
      };

      const capturedCalls = [];
      const harness = createAppWithPatchedAuroraChat(async (args = {}) => {
        capturedCalls.push(args);
        return { answer: '{}', intent: 'chat', cards: [] };
      });
      try {
        const uid = buildTestUid('routine_analysis_v2_failure');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'CeraVe Hydrating Cleanser',
                treatment: 'Vitamin C serum',
                moisturizer: 'Light gel cream',
              },
              pm: {
                cleanser: 'CeraVe Hydrating Cleanser',
                treatment: 'Retinol serum',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.ok(findCard(cards, 'analysis_summary'));
        assert.equal(Boolean(findCard(cards, 'routine_fit_summary')), false);

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.routine_analysis_version, 'v2_failed');
        assert.equal(analysisMeta.routine_analysis_v2_failure_class, 'upstream_error');
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_payload_shape'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_product_enrichment_deferred'), false);

        const sessionPatch = resp.body && resp.body.session_patch && typeof resp.body.session_patch === 'object'
          ? resp.body.session_patch
          : {};
        const meta = sessionPatch.meta && typeof sessionPatch.meta === 'object' ? sessionPatch.meta : {};
        assert.equal(meta?.routine_analysis_v2?.attempted, true);
        assert.equal(meta?.routine_analysis_v2?.failed, true);
        assert.equal(meta?.routine_analysis_v2?.guardrail_bypass, true);
        assert.equal(meta?.routine_analysis_v2?.enabled, false);

        const events = Array.isArray(resp.body && resp.body.events) ? resp.body.events : [];
        const failureEvent = events.find((event) => event && event.event_name === 'analysis_substage_failed');
        assert.ok(failureEvent);
        assert.equal(failureEvent?.data?.stage, 'routine_analysis_v2');

        const routineFitCalls = capturedCalls.filter(
          (row) => String(row?.intent_hint || '').trim() === 'routine_fit_summary',
        );
        assert.equal(routineFitCalls.length, 0);
      } finally {
        harness.restore();
        routineAnalysisModule.runRoutineAnalysisV2 = originalRunRoutineAnalysisV2;
        delete require.cache[routineAnalysisModuleId];
      }
    },
  );
});

test('/v1/analysis/skin: routine audit v1 emits the 4-card surface and suppresses preview/story cards', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_AUDIT_V1_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_audit_v1_surface');
        const headers = headersFor(uid, 'EN');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headers)
          .send({
            use_photo: false,
            skinType: 'combination',
            sensitivity: 'high',
            barrierStatus: 'impaired',
            goals: ['acne', 'dark_spots'],
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                treatment: 'Vitamin C serum',
                moisturizer: 'Barrier cream',
                sunscreen: 'Daily SPF 50',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum and glycolic acid toner',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.deepEqual(
          cards.map((card) => card && card.type),
          ['routine_verdict_v1', 'routine_product_audit_v1', 'routine_user_fit_v1', 'routine_adjustment_plan_v1'],
        );
        assert.equal(Boolean(findCard(cards, 'analysis_summary')), false);
        assert.equal(Boolean(findCard(cards, 'analysis_story_v2')), false);
        assert.equal(Boolean(findCard(cards, 'routine_products_preview')), false);
        assert.equal(Boolean(findCard(cards, 'routine_fit_summary')), false);

        const verdictCard = findCard(cards, 'routine_verdict_v1');
        const auditCard = findCard(cards, 'routine_product_audit_v1');
        const userFitCard = findCard(cards, 'routine_user_fit_v1');
        const adjustmentCard = findCard(cards, 'routine_adjustment_plan_v1');
        assert.ok(verdictCard?.payload?.overall_verdict);
        assert.ok(Array.isArray(verdictCard?.payload?.top_3_actions) && verdictCard.payload.top_3_actions.length > 0);
        assert.ok(Array.isArray(auditCard?.payload?.products) && auditCard.payload.products.every((row) => row.evidence_mode && typeof row.confidence === 'number'));
        assert.ok(typeof userFitCard?.payload?.overall_user_fit_score === 'number');
        assert.ok(adjustmentCard?.payload?.minimal_viable_routine?.am_minimal);
        assert.ok(adjustmentCard?.payload?.minimal_viable_routine?.pm_minimal);

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.analysis_mode, 'routine_audit_v1');
        assert.equal(analysisMeta.execution_path, 'routine_audit_fast_path');
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_payload_shape'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_product_enrichment_deferred'), false);

        const sessionPatch = resp.body && resp.body.session_patch && typeof resp.body.session_patch === 'object'
          ? resp.body.session_patch
          : {};
        assert.equal(sessionPatch.next_state, 'ROUTINE_REVIEW');
        assert.equal(sessionPatch?.meta?.analysis_contract?.analysis_mode, 'routine_audit_v1');
        assert.equal(sessionPatch?.meta?.analysis_contract?.card_contract, 'aurora.routine_audit_v1');
        assert.equal(sessionPatch?.meta?.analysis_contract?.execution_path, 'routine_audit_fast_path');
        assert.ok(String(sessionPatch?.state?.latest_artifact_id || '').trim());
        assert.equal(sessionPatch?.state?.latest_reco_context?.context_origin, 'routine_audit_v1');
        assert.equal(sessionPatch?.state?.latest_reco_context?.resolved_target_step, 'moisturizer');
        assert.ok(String(sessionPatch?.state?.latest_reco_context?.artifact_id || '').trim());
        assert.equal(analysisMeta.artifact_usable, true);
        const { getLatestDiagnosisArtifact } = require('../src/auroraBff/diagnosisArtifactStore');
        const { hasUsableArtifactForRecommendations } = require('../src/auroraBff/gating');
        const latestArtifact = await getLatestDiagnosisArtifact({
          auroraUid: uid,
          sessionId: headers['X-Brief-ID'],
          maxAgeDays: 30,
          preferArtifactId: sessionPatch?.state?.latest_artifact_id,
          artifactUse: 'reco_context',
        });
        const latestArtifactPayload =
          latestArtifact && latestArtifact.artifact_json && typeof latestArtifact.artifact_json === 'object'
            ? { ...latestArtifact.artifact_json, artifact_id: latestArtifact.artifact_id }
            : latestArtifact;
        assert.equal(String(latestArtifactPayload?.artifact_id || ''), String(sessionPatch?.state?.latest_artifact_id || ''));
        assert.equal(hasUsableArtifactForRecommendations(latestArtifactPayload).ok, true);

        const events = Array.isArray(resp.body && resp.body.events) ? resp.body.events : [];
        const eventNames = events.map((event) => event && event.event_name).filter(Boolean);
        assert.ok(eventNames.includes('routine_audit_fast_path_started'));
        assert.ok(eventNames.includes('routine_audit_fast_path_completed'));
        assert.equal(eventNames.includes('analysis_timeout_degraded'), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: profile-backed no-photo routine request uses routine audit fast path', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_AUDIT_V1_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_audit_v1_profile_fast_path');
        const headers = headersFor(uid, 'EN');
        await seedCompleteProfile(harness.request, uid, 'EN', {
          skinType: 'combination',
          sensitivity: 'medium',
          barrierStatus: 'impaired',
          goals: ['acne', 'dark_spots'],
        });

        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headers)
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                treatment: 'Vitamin C serum',
                moisturizer: 'Barrier cream',
                sunscreen: 'Daily SPF 50',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum and glycolic acid toner',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.deepEqual(
          cards.map((card) => card && card.type),
          ['routine_verdict_v1', 'routine_product_audit_v1', 'routine_user_fit_v1', 'routine_adjustment_plan_v1'],
        );
        assert.equal(Boolean(findCard(cards, 'analysis_story_v2')), false);
        assert.equal(Boolean(findCard(cards, 'routine_products_preview')), false);
        assert.equal(Boolean(findCard(cards, 'ingredient_plan')), false);
        assert.equal(Boolean(findCard(cards, 'ingredient_plan_v2')), false);

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.analysis_mode, 'routine_audit_v1');
        assert.equal(analysisMeta.execution_path, 'routine_audit_fast_path');
        assert.equal(analysisMeta.detector_source, 'rule_based');
        assert.equal(analysisMeta.artifact_gate?.tier, 'eligible_strong');
        assert.equal(analysisMeta.artifact_gate?.reason, 'eligible_strong');
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_payload_shape'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(analysisMeta, 'routine_product_enrichment_deferred'), false);

        const sessionPatch = resp.body && resp.body.session_patch && typeof resp.body.session_patch === 'object'
          ? resp.body.session_patch
          : {};
        assert.equal(sessionPatch.next_state, 'ROUTINE_REVIEW');
        assert.equal(sessionPatch?.meta?.analysis_contract?.card_contract, 'aurora.routine_audit_v1');
        assert.ok(String(sessionPatch?.state?.latest_artifact_id || '').trim());
        assert.equal(analysisMeta.artifact_usable, true);
        const { getLatestDiagnosisArtifact } = require('../src/auroraBff/diagnosisArtifactStore');
        const { hasUsableArtifactForRecommendations } = require('../src/auroraBff/gating');
        const latestArtifact = await getLatestDiagnosisArtifact({
          auroraUid: uid,
          sessionId: headers['X-Brief-ID'],
          maxAgeDays: 30,
          preferArtifactId: sessionPatch?.state?.latest_artifact_id,
          artifactUse: 'reco_context',
        });
        const latestArtifactPayload =
          latestArtifact && latestArtifact.artifact_json && typeof latestArtifact.artifact_json === 'object'
            ? { ...latestArtifact.artifact_json, artifact_id: latestArtifact.artifact_id }
            : latestArtifact;
        assert.equal(String(latestArtifactPayload?.artifact_id || ''), String(sessionPatch?.state?.latest_artifact_id || ''));
        assert.equal(hasUsableArtifactForRecommendations(latestArtifactPayload).ok, true);

        const events = Array.isArray(resp.body && resp.body.events) ? resp.body.events : [];
        const eventNames = events.map((event) => event && event.event_name).filter(Boolean);
        assert.ok(eventNames.includes('routine_audit_fast_path_started'));
        assert.ok(eventNames.includes('routine_audit_fast_path_completed'));
        assert.equal(eventNames.includes('analysis_timeout_degraded'), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: routine audit fast path exposes artifact gate reason when profile core is missing', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_AUDIT_V1_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_audit_v1_missing_core_gate');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                serum: 'Vitamin C serum',
                moisturizer: 'Barrier cream',
                spf: 'SPF50',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.analysis_mode, 'routine_audit_v1');
        assert.equal(analysisMeta.execution_path, 'routine_audit_fast_path');
        assert.equal(analysisMeta.artifact_usable, false);
        assert.equal(analysisMeta.reco_artifact_eligible, false);
        assert.equal(analysisMeta.artifact_gate?.tier, 'ineligible');
        assert.equal(analysisMeta.artifact_gate?.reason, 'artifact_missing_core');
        assert.deepEqual(
          analysisMeta.artifact_gate?.missing_core,
          ['skinType', 'sensitivity', 'barrierStatus', 'goals'],
        );
        assert.equal(analysisMeta.artifact_gate?.eligible, false);
        assert.equal(analysisMeta.artifact_gate?.ok, false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin -> /v1/chat reco: routine audit fast path persists usable artifact handoff without degrading to artifact_missing', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_AUDIT_V1_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_audit_v1_reco_handoff');
        const headers = headersFor(uid, 'EN');
        await seedCompleteProfile(harness.request, uid, 'EN', {
          skinType: 'combination',
          sensitivity: 'medium',
          barrierStatus: 'impaired',
          goals: ['acne', 'dark_spots'],
        });

        const analysisResp = await harness.request
          .post('/v1/analysis/skin')
          .set(headers)
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                treatment: 'Niacinamide serum',
                moisturizer: 'Barrier cream',
                sunscreen: 'Daily SPF 50',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum and glycolic acid toner',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const analysisSession = analysisResp.body && analysisResp.body.session_patch && typeof analysisResp.body.session_patch === 'object'
          ? analysisResp.body.session_patch
          : {};
        assert.ok(String(analysisSession?.state?.latest_artifact_id || '').trim());

        const recoResp = await harness.request
          .post('/v1/chat')
          .set(headers)
          .send({
            action: {
              action_id: 'chip.start.reco_products',
              kind: 'chip',
              data: {
                reply_text: 'Show me product recommendations',
                force_route: 'reco_products',
              },
            },
            session: analysisSession,
            language: 'EN',
          })
          .expect(200);

        const recoEvent =
          (Array.isArray(recoResp.body?.events) ? recoResp.body.events : []).find((evt) => evt && evt.event_name === 'recos_requested')
          || (Array.isArray(recoResp.body?.ops?.experiment_events) ? recoResp.body.ops.experiment_events.find((evt) => evt && evt.event_type === 'recos_requested') : null);
        assert.ok(recoEvent);
        if (recoEvent && (recoEvent.data || recoEvent.event_data)) {
          const eventData = recoEvent.data || recoEvent.event_data || {};
          const groundedCount = Number(eventData.grounded_count || 0);
          const ungroundedCount = Number(eventData.ungrounded_count || 0);
          assert.equal(
            String(eventData.reason || '') !== 'artifact_missing' || groundedCount > 0 || ungroundedCount > 0,
            true,
          );
          assert.notEqual(String(eventData.telemetry_reason || ''), 'artifact_missing');
        }
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: legacy string currentRoutine with persisted profile still uses routine audit fast path', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_AUDIT_V1_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_audit_v1_legacy_string_profile_fast_path');
        await seedCompleteProfile(harness.request, uid, 'EN', {
          skinType: 'oily',
          sensitivity: 'high',
          barrierStatus: 'impaired',
          goals: ['acne', 'pores'],
        });

        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: 'AM\nCleanser: Gentle cleanser\nTreatment: Vitamin C serum\nSPF: Daily SPF 50\nPM\nCleanser: Gentle cleanser\nTreatment: Retinol serum\nMoisturizer: Barrier cream',
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.deepEqual(
          cards.map((card) => card && card.type),
          ['routine_verdict_v1', 'routine_product_audit_v1', 'routine_user_fit_v1', 'routine_adjustment_plan_v1'],
        );

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.analysis_mode, 'routine_audit_v1');
        assert.equal(analysisMeta.execution_path, 'routine_audit_fast_path');
        assert.equal(analysisMeta.profile_context_source, 'db_only_profile');
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: explicit photo-first request stays off routine audit fast path', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_AUDIT_V1_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_audit_v1_photo_request_stays_mainline');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: true,
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                treatment: 'Vitamin C serum',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum',
              },
            },
          })
          .expect(200);

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.notEqual(analysisMeta.execution_path, 'routine_audit_fast_path');

        const cards = parseCards(resp.body);
        assert.equal(
          cards.some((card) => card && card.type === 'routine_products_preview') || cards.some((card) => card && card.type === 'analysis_story_v2'),
          true,
        );

        const events = Array.isArray(resp.body && resp.body.events) ? resp.body.events : [];
        const eventNames = events.map((event) => event && event.event_name).filter(Boolean);
        assert.equal(eventNames.includes('routine_audit_fast_path_started'), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('routineAnalysisV2 recommendation groups: empty pool degrades to category guidance instead of empty products', async () => {
  const { resolveRecommendationGroups } = require('../src/auroraBff/routineAnalysisV2');
  const groups = await resolveRecommendationGroups({
    recommendationNeeds: [
      {
        adjustment_id: 'adj_gap_spf',
        need_state: 'fill_gap',
        target_step: 'sunscreen',
        why: 'AM protection is missing.',
        required_attributes: ['broad-spectrum daily UV protection'],
        avoid_attributes: ['unclear SPF claims'],
        timing: 'am',
        texture_or_format: 'fluid',
        priority: 'high',
      },
    ],
    recommendationQueries: [
      {
        adjustment_id: 'adj_gap_spf',
        query_en: 'sunscreen broad-spectrum daily UV protection fluid',
      },
    ],
    context: {
      language: 'EN',
      goals: ['wrinkles', 'dehydration'],
      skinType: 'combination',
      sensitivity: 'medium',
    },
    deps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 1 }),
    },
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].adjustment_id, 'adj_gap_spf');
  assert.equal(Array.isArray(groups[0].candidate_pool), true);
  assert.equal(groups[0].candidate_pool.length, 0);
  assert.equal(groups[0].unresolved_reason, 'no_grounded_candidates');
  assert.ok(groups[0].category_guidance, 'guidance should exist when candidate pool is empty');
});

test('normalizeFallbackAuditOutput: quality gate replaces low-value cleanser reasoning with category-level fallback', () => {
  const { normalizeFallbackAuditOutput } = require('../src/auroraBff/routineAnalysisV2');

  const candidates = [
    {
      product_ref: 'prod_cleanser_1',
      slot: 'am',
      step: 'cleanser',
      product_text: 'Foaming cleanser',
    },
  ];

  const audit = normalizeFallbackAuditOutput(candidates, {
    products: [
      {
        product_ref: 'prod_cleanser_1',
        slot: 'am',
        original_step_label: 'cleanser',
        input_label: 'Foaming cleanser',
        resolved_name_or_null: null,
        evidence_basis: ['step_label'],
        inferred_product_type: 'cleanser',
        likely_role: 'cleansing',
        likely_key_ingredients_or_signals: ['cleanser signal'],
        fit_for_skin_type: {
          verdict: 'unknown',
          reason: 'Without knowing the ingredients, it is hard to assess this cleanser for oily skin.',
        },
        fit_for_goals: [
          {
            goal: 'acne',
            verdict: 'unknown',
            reason: 'Without knowing the ingredients, it is hard to assess its impact on acne.',
          },
          {
            goal: 'pores',
            verdict: 'unknown',
            reason: 'Without knowing the ingredients, it is hard to assess its impact on pores.',
          },
        ],
        fit_for_season_or_climate: {
          verdict: 'unknown',
          reason: 'Need climate information to assess.',
        },
        potential_concerns: [],
        suggested_action: 'keep',
        confidence: 0.62,
        missing_info: ['No ingredient list was provided.'],
        concise_reasoning_en: 'This is a cleanser, which is a routine basic. Without an ingredients list, it is hard to assess its acne and pore fit.',
      },
    ],
    confidence: 0.62,
  }, {
    goals: ['acne', 'pores'],
    skinType: 'oily',
    sensitivity: 'medium',
    barrierStatus: 'impaired',
  });

  const product = audit.products[0];
  assert.ok(product, 'expected a normalized product');
  assert.doesNotMatch(product.fit_for_skin_type.reason, /without knowing the ingredients|hard to assess/i);
  assert.doesNotMatch(product.fit_for_season_or_climate.reason, /need climate information to assess/i);
  assert.doesNotMatch(product.concise_reasoning_en, /without an ingredients list|routine basic/i);
  assert.equal(product.fit_for_goals.length, 2);
  assert.notEqual(
    String(product.fit_for_goals[0].reason).toLowerCase(),
    String(product.fit_for_goals[1].reason).toLowerCase(),
    'goal reasons should not stay duplicated boilerplate',
  );
  assert.equal(audit.quality_gate_meta.quality_gate_applied_count, 1);
  assert.deepEqual(audit.quality_gate_meta.product_reason_sources, [
    {
      product_ref: 'prod_cleanser_1',
      reason_source: 'quality_gate_replaced',
    },
  ]);
});

test('normalizeFallbackAuditOutput: moisturizer fallback stays useful when season context is missing', () => {
  const { normalizeFallbackAuditOutput } = require('../src/auroraBff/routineAnalysisV2');

  const audit = normalizeFallbackAuditOutput([
    {
      product_ref: 'prod_moisturizer_1',
      slot: 'pm',
      step: 'moisturizer',
      product_text: 'Barrier cream',
    },
  ], null, {
    goals: ['dehydration'],
    skinType: 'dry',
    sensitivity: 'medium',
    barrierStatus: 'impaired',
  });

  const product = audit.products[0];
  assert.ok(product, 'expected a fallback product audit');
  assert.match(product.fit_for_skin_type.reason, /barrier-support step|barrier support/i);
  assert.match(product.fit_for_goals[0].reason, /hydrating|dehydration/i);
  assert.equal(product.fit_for_season_or_climate.verdict, 'unknown');
  assert.doesNotMatch(product.fit_for_skin_type.reason, /hard to assess/i);
  assert.deepEqual(audit.quality_gate_meta.product_reason_sources, [
    {
      product_ref: 'prod_moisturizer_1',
      reason_source: 'fallback_substituted',
    },
  ]);
});

test('runRoutineAnalysisV2: debug meta records quality-gate replacements without changing recommendation behavior', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async call({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        return {
          parsed: {
            schema_version: 'aurora.routine_product_audit.v1',
            products: [
              {
                product_ref: 'routine_am_01',
                slot: 'am',
                original_step_label: 'cleanser',
                input_label: 'Foaming cleanser',
                resolved_name_or_null: null,
                evidence_basis: ['step_label'],
                inferred_product_type: 'cleanser',
                likely_role: 'cleansing',
                likely_key_ingredients_or_signals: ['cleanser signal'],
                fit_for_skin_type: {
                  verdict: 'unknown',
                  reason: 'Without knowing the ingredients, it is hard to assess.',
                },
                fit_for_goals: [
                  {
                    goal: 'acne',
                    verdict: 'unknown',
                    reason: 'Without knowing the ingredients, it is hard to assess.',
                  },
                  {
                    goal: 'pores',
                    verdict: 'unknown',
                    reason: 'Without knowing the ingredients, it is hard to assess.',
                  },
                ],
                fit_for_season_or_climate: {
                  verdict: 'unknown',
                  reason: 'Need climate information to assess.',
                },
                potential_concerns: [],
                suggested_action: 'keep',
                confidence: 0.61,
                missing_info: [],
                concise_reasoning_en: 'This is a routine basic and hard to assess without ingredients.',
              },
            ],
            additional_items_needing_verification: [],
            missing_info: [],
            confidence: 0.61,
          },
        };
      }
      return { parsed: null };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_quality_gate',
    language: 'EN',
    profileSummary: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['acne', 'pores'],
    },
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.debug_meta.stage_a.quality_gate_applied_count, 1);
  assert.deepEqual(result.debug_meta.stage_a.product_reason_sources, [
      {
        product_ref: 'routine_am_01',
        reason_source: 'quality_gate_replaced',
      },
  ]);
  assert.equal(result.cards[0].type, 'routine_product_audit_v1');
  assert.ok(Array.isArray(result.recommendation_groups), 'recommendation groups should still be emitted consistently');
});

test('runRoutineAnalysisV2: routine audit v1 builds anchored conflict, user-fit, and adjustment payloads', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async call({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        return {
          parsed: buildStageAResult([
            buildAuditProduct('prod_spf', {
              slot: 'am',
              original_step_label: 'sunscreen',
              input_label: 'Daily SPF 50',
              inferred_product_type: 'sunscreen',
              likely_role: 'UV protection',
              likely_key_ingredients_or_signals: ['UV filter signal'],
              fit_for_goals: [
                { goal: 'dark_spots', verdict: 'good', reason: 'Daily UV protection supports spot-fading work.' },
              ],
            }),
            buildAuditProduct('prod_retinol', {
              slot: 'pm',
              original_step_label: 'treatment',
              input_label: 'Retinol serum',
              inferred_product_type: 'retinoid serum',
              likely_role: 'anti-aging treatment',
              likely_key_ingredients_or_signals: ['retinoid signal'],
              fit_for_goals: [
                { goal: 'acne', verdict: 'mixed', reason: 'Retinoid can support acne, but cadence matters.' },
                { goal: 'dark_spots', verdict: 'mixed', reason: 'Retinoid can help tone over time if tolerated.' },
              ],
              potential_concerns: ['Can push irritation if paired with another strong active in the same PM routine.'],
            }),
            buildAuditProduct('prod_acid', {
              slot: 'pm',
              original_step_label: 'treatment',
              input_label: 'Glycolic acid toner',
              inferred_product_type: 'exfoliant treatment',
              likely_role: 'exfoliation',
              likely_key_ingredients_or_signals: ['exfoliant signal'],
              fit_for_goals: [
                { goal: 'acne', verdict: 'mixed', reason: 'Exfoliation can help congestion, but it is not barrier-neutral.' },
                { goal: 'dark_spots', verdict: 'mixed', reason: 'Acid exfoliation can help texture and tone if not overused.' },
              ],
              potential_concerns: ['Adds another strong active into the same PM window.'],
            }),
            buildAuditProduct('prod_barrier', {
              slot: 'pm',
              original_step_label: 'moisturizer',
              input_label: 'Barrier cream',
              inferred_product_type: 'moisturizer',
              likely_role: 'barrier support',
              likely_key_ingredients_or_signals: ['ceramide signal', 'hydration signal'],
              fit_for_goals: [
                { goal: 'acne', verdict: 'mixed', reason: 'Barrier support helps tolerance, but it is not the main acne mechanism.' },
                { goal: 'dark_spots', verdict: 'mixed', reason: 'Barrier support keeps the routine tolerable, but it does not replace targeted brightening.' },
              ],
            }),
          ]),
        };
      }
      if (templateId === 'routine_synthesis_v1') {
        return {
          parsed: buildStageBResult({
            current_routine_assessment: {
              summary: 'The routine has real treatment coverage but the PM active stack is too aggressive for the current barrier state.',
              main_strengths: ['Daily sunscreen protects the brightening / anti-aging work.', 'Barrier cream gives the routine a repair anchor.'],
              main_issues: ['Retinol and glycolic acid are stacked in the same PM window.'],
            },
            overlap_or_gaps: [
              {
                issue_type: 'conflict',
                title: 'Retinol serum and glycolic acid toner are stacked in the same PM window.',
                evidence: ['Both are strong leave-on actives.', 'User context includes high sensitivity and impaired barrier.'],
                affected_products: ['Retinol serum', 'Glycolic acid toner'],
              },
              {
                issue_type: 'goal_mismatch',
                title: 'The routine tries to push treatment speed faster than the current barrier can support.',
                evidence: ['Barrier is already impaired.', 'Tolerance is the limiting factor right now.'],
                affected_products: ['Retinol serum', 'Glycolic acid toner', 'Barrier cream'],
              },
            ],
            top_3_adjustments: [
              {
                adjustment_id: 'adj_split_pm_actives',
                priority_rank: 1,
                title: 'Stop same-night retinol + glycolic stacking',
                action_type: 'remove',
                affected_products: ['Retinol serum', 'Glycolic acid toner'],
                why_this_first: 'This is the highest-risk mismatch for the current barrier and sensitivity context.',
                expected_outcome: 'Lower irritation risk and a routine that is easier to tolerate consistently.',
              },
              {
                adjustment_id: 'adj_keep_barrier_anchor',
                priority_rank: 2,
                title: 'Keep the barrier cream as the PM anchor',
                action_type: 'keep',
                affected_products: ['Barrier cream'],
                why_this_first: 'The repair step is what makes any future active work sustainable.',
                expected_outcome: 'Better tolerance and less rebound irritation.',
              },
              {
                adjustment_id: 'adj_reduce_retinol_frequency',
                priority_rank: 3,
                title: 'Reduce retinol to alternate PM use first',
                action_type: 'reduce_frequency',
                affected_products: ['Retinol serum'],
                why_this_first: 'It keeps acne / texture work alive without forcing the barrier to absorb everything at once.',
                expected_outcome: 'Keeps progress while lowering flare risk.',
              },
            ],
            rationale_for_each_adjustment: [
              {
                adjustment_id: 'adj_split_pm_actives',
                reasoning: 'Strong actives should not be stacked in the same PM window while the barrier is impaired.',
                evidence: ['Retinoid + acid overlap', 'Sensitivity is high'],
                tradeoff_or_caution: 'Progress may feel slower for 1-2 weeks, but tolerance should improve.',
              },
            ],
            recommendation_needs: [],
            recommendation_queries: [],
          }),
        };
      }
      return { parsed: null };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_routine_audit_v1',
    language: 'EN',
    profileSummary: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['acne', 'dark_spots'],
    },
    routineProductCandidates: [
      { product_ref: 'prod_spf', slot: 'am', step: 'sunscreen', product_text: 'Daily SPF 50' },
      { product_ref: 'prod_retinol', slot: 'pm', step: 'treatment', product_text: 'Retinol serum' },
      { product_ref: 'prod_acid', slot: 'pm', step: 'treatment', product_text: 'Glycolic acid toner' },
      { product_ref: 'prod_barrier', slot: 'pm', step: 'moisturizer', product_text: 'Barrier cream' },
    ],
    llmGateway,
    surfaceMode: 'routine_audit_v1',
    routineExpert: {
      plan_7d: { am: ['Keep cleanser + SPF'], pm: ['Do not stack retinol and acids'], observe_metrics: [], stop_conditions: [] },
      phase_plan: { phase_1_14d: ['Stabilize barrier'], phase_2_3_6w: ['Reintroduce one active at a time'] },
      key_issues: [{ id: 'stacked_strong_actives' }],
    },
    routineLifecycleContext: { stage: 'optimization' },
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.surface_mode, 'routine_audit_v1');
  assert.deepEqual(
    result.cards.map((card) => card && card.type),
    ['routine_verdict_v1', 'routine_product_audit_v1', 'routine_user_fit_v1', 'routine_adjustment_plan_v1'],
  );

  const verdictCard = result.cards[0];
  const auditCard = result.cards[1];
  const userFitCard = result.cards[2];
  const adjustmentCard = result.cards[3];

  assert.equal(verdictCard.payload.overall_verdict, 'high_conflict_or_irritation_risk');
  assert.ok(Array.isArray(auditCard.payload.conflicts) && auditCard.payload.conflicts.length > 0);
  assert.deepEqual(auditCard.payload.conflicts[0].items_involved, ['Retinol serum', 'Glycolic acid toner']);
  assert.ok(Array.isArray(userFitCard.payload.risk_mismatches) && userFitCard.payload.risk_mismatches.length > 0);
  assert.equal(userFitCard.payload.barrier_fit.state, 'helps');
  assert.equal(userFitCard.payload.sensitivity_fit.state, 'hurts');
  assert.ok(Array.isArray(adjustmentCard.payload.pause_or_remove) && adjustmentCard.payload.pause_or_remove.length > 0);
  assert.ok(adjustmentCard.payload.minimal_viable_routine.pm_minimal.length >= 2);
  assert.ok(adjustmentCard.payload.execution_burden);
  assert.ok(typeof adjustmentCard.payload.complexity_score === 'number');
});

test('runRoutineAnalysisV2: routine audit v1 skips stage B LLM and recommendation resolve', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  let searchCallCount = 0;
  const stageCalls = [];
  const llmGateway = {
    async callWithSchemaDiagnostics(args = {}) {
      stageCalls.push({
        templateId: args.templateId,
        retryStructuredFailure: args.retryStructuredFailure === true,
      });
      if (args.templateId === 'routine_product_audit_v1') {
        return {
          parsed: buildStageAResult([
            buildAuditProduct('prod_retinol', {
              slot: 'pm',
              original_step_label: 'treatment',
              input_label: 'Retinol serum',
              inferred_product_type: 'retinoid serum',
              likely_role: 'anti-aging treatment',
              likely_key_ingredients_or_signals: ['retinoid signal'],
            }),
          ]),
          parsedCandidate: buildStageAResult([
            buildAuditProduct('prod_retinol', {
              slot: 'pm',
              original_step_label: 'treatment',
              input_label: 'Retinol serum',
              inferred_product_type: 'retinoid serum',
              likely_role: 'anti-aging treatment',
              likely_key_ingredients_or_signals: ['retinoid signal'],
            }),
          ]),
          raw: '{}',
          provider: 'stub',
          schemaValid: true,
          validationErrors: [],
          attemptCount: 1,
          retried: false,
        };
      }
      return {
        parsed: null,
        parsedCandidate: buildStageBResult({
          recommendation_needs: [
            {
              adjustment_id: 'adj_replace_retinol',
              need_state: 'replace_current',
              target_step: 'serum',
              why: 'Use a gentler PM treatment first.',
              required_attributes: ['lower irritation risk'],
              avoid_attributes: ['stacked exfoliants'],
              timing: 'pm',
              priority: 'high',
            },
          ],
          recommendation_queries: [
            {
              adjustment_id: 'adj_replace_retinol',
              query_en: 'gentle pm serum lower irritation risk',
            },
          ],
        }),
        raw: '{}',
        provider: 'stub',
        schemaValid: false,
        validationErrors: [{ path: '$.improved_pm_routine[0].note', reason: 'type_mismatch' }],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_routine_audit_v1_skip_reco',
    language: 'EN',
    profileSummary: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['acne'],
    },
    routineProductCandidates: [
      { product_ref: 'prod_retinol', slot: 'pm', step: 'treatment', product_text: 'Retinol serum' },
    ],
    llmGateway,
    surfaceMode: 'routine_audit_v1',
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => {
        searchCallCount += 1;
        return { ok: true, transient: false, products: [], queryCount: 0 };
      },
    },
  });

  assert.equal(searchCallCount, 0);
  assert.deepEqual(
    stageCalls.map((row) => [row.templateId, row.retryStructuredFailure]),
    [
      ['routine_product_audit_v1', true],
    ],
  );
  assert.deepEqual(result.recommendation_groups, []);
  assert.equal(result.debug_meta.stage_b.llm_status, 'skipped');
  assert.equal(result.debug_meta.stage_b.retry_count, 0);
  assert.equal(result.debug_meta.stage_b.attempt_count, 0);
});

test('runRoutineAnalysisV2: routine audit v1 deterministic synthesis keeps support-step redundancies actionable', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async callWithSchemaDiagnostics(args = {}) {
      if (args.templateId !== 'routine_product_audit_v1') {
        throw new Error(`unexpected template ${args.templateId}`);
      }
      return {
        parsed: buildStageAResult([
          buildAuditProduct('routine_am_01', {
            slot: 'am',
            original_step_label: 'cleanser',
            input_label: 'Gentle cleanser',
            inferred_product_type: 'cleanser',
            likely_role: 'cleansing',
          }),
          buildAuditProduct('routine_am_02', {
            slot: 'am',
            original_step_label: 'serum',
            input_label: 'Vitamin C serum',
            inferred_product_type: 'vitamin c serum',
            likely_role: 'antioxidant serum',
            potential_concerns: ['potential irritation depending on formulation and concentration'],
            fit_for_skin_type: {
              verdict: 'unknown',
              reason: 'Need to know skin type to assess suitability. Some vitamin C formulations can be irritating.',
            },
          }),
          buildAuditProduct('routine_am_03', {
            slot: 'am',
            original_step_label: 'moisturizer',
            input_label: 'Barrier cream',
            inferred_product_type: 'moisturizer',
            likely_role: 'barrier support',
          }),
          buildAuditProduct('routine_am_04', {
            slot: 'am',
            original_step_label: 'spf',
            input_label: 'SPF50',
            inferred_product_type: 'sunscreen',
            likely_role: 'uv protection',
          }),
          buildAuditProduct('routine_pm_05', {
            slot: 'pm',
            original_step_label: 'cleanser',
            input_label: 'Gentle cleanser',
            inferred_product_type: 'cleanser',
            likely_role: 'cleansing',
          }),
          buildAuditProduct('routine_pm_06', {
            slot: 'pm',
            original_step_label: 'treatment',
            input_label: 'Retinol serum',
            inferred_product_type: 'retinoid serum',
            likely_role: 'anti-aging treatment',
            potential_concerns: ['potential irritation and dryness'],
            fit_for_skin_type: {
              verdict: 'unknown',
              reason: 'Need to know skin type and sensitivity to assess suitability. Retinol can be irritating, especially when starting.',
            },
          }),
          buildAuditProduct('routine_pm_07', {
            slot: 'pm',
            original_step_label: 'moisturizer',
            input_label: 'Barrier cream',
            inferred_product_type: 'moisturizer',
            likely_role: 'barrier support',
          }),
        ], {
          missing_info: ['Exact SKU / ingredient detail missing for inferred products.'],
          confidence: 0.657,
        }),
        parsedCandidate: null,
        raw: '{}',
        provider: 'stub',
        schemaValid: true,
        validationErrors: [],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_routine_audit_v1_support_redundancy',
    language: 'EN',
    profileSummary: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['texture', 'brightening'],
    },
    routineProductCandidates: [
      { product_ref: 'routine_am_01', slot: 'am', step: 'cleanser', product_text: 'Gentle cleanser' },
      { product_ref: 'routine_am_02', slot: 'am', step: 'serum', product_text: 'Vitamin C serum' },
      { product_ref: 'routine_am_03', slot: 'am', step: 'moisturizer', product_text: 'Barrier cream' },
      { product_ref: 'routine_am_04', slot: 'am', step: 'spf', product_text: 'SPF50' },
      { product_ref: 'routine_pm_05', slot: 'pm', step: 'cleanser', product_text: 'Gentle cleanser' },
      { product_ref: 'routine_pm_06', slot: 'pm', step: 'treatment', product_text: 'Retinol serum' },
      { product_ref: 'routine_pm_07', slot: 'pm', step: 'moisturizer', product_text: 'Barrier cream' },
    ],
    llmGateway,
    surfaceMode: 'routine_audit_v1',
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  const verdictCard = result.cards.find((card) => card && card.type === 'routine_verdict_v1');
  const auditCard = result.cards.find((card) => card && card.type === 'routine_product_audit_v1');
  const adjustmentCard = result.cards.find((card) => card && card.type === 'routine_adjustment_plan_v1');

  assert.equal(result.debug_meta.stage_b.llm_status, 'skipped');
  assert.ok(Array.isArray(auditCard.payload.redundancies) && auditCard.payload.redundancies.length >= 2);
  assert.ok(auditCard.payload.redundancies.some((row) => Array.isArray(row.items_involved) && row.items_involved.includes('Gentle cleanser')));
  assert.ok(auditCard.payload.redundancies.some((row) => Array.isArray(row.items_involved) && row.items_involved.includes('Barrier cream')));
  assert.ok(Array.isArray(adjustmentCard.payload.replace) && adjustmentCard.payload.replace.length >= 2);
  assert.ok(adjustmentCard.payload.replace.some((row) => row.title === 'Consider a different cleanser for PM'));
  assert.ok(adjustmentCard.payload.replace.some((row) => row.title === 'Consider a different moisturizer for PM'));
  assert.ok(Array.isArray(adjustmentCard.payload.top_3_adjustments) && adjustmentCard.payload.top_3_adjustments.length >= 2);
  assert.ok(Array.isArray(adjustmentCard.payload.rationale_for_each_adjustment) && adjustmentCard.payload.rationale_for_each_adjustment.length >= 2);
  assert.ok(Array.isArray(adjustmentCard.payload.missing_info) && adjustmentCard.payload.missing_info.length >= 1);
  assert.ok(Array.isArray(verdictCard.payload.top_3_actions) && verdictCard.payload.top_3_actions.length >= 2);
  assert.ok(verdictCard.payload.top_3_actions.some((row) => row.title === 'Consider a different cleanser for PM'));
});

test('runRoutineAnalysisV2: stage A debug meta captures schema-validation fallback diagnostics', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const { LlmQualityError } = require('../src/auroraBff/services/llm_gateway');
  const llmGateway = {
    async call({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        throw new LlmQualityError('LLM output failed schema validation: RoutineProductAuditOutput', {
          provider: 'gemini',
          rawPresent: true,
          rawLength: 742,
          validationErrors: [
            { path: '$.products[0].fit_for_skin_type.reason', reason: 'minLength' },
            { path: '$.products[0].fit_for_goals[0].reason', reason: 'required' },
          ],
        });
      }
      return { parsed: null, raw: '{}', provider: 'stub' };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_a_validation',
    language: 'EN',
    profileSummary: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['acne'],
    },
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
  });

  assert.equal(result.debug_meta.stage_a.llm_status, 'fallback');
  assert.equal(result.debug_meta.stage_a.fallback_reason, 'schema_validation_failed');
  assert.equal(result.debug_meta.stage_a.validation_error_count, 2);
  assert.equal(result.debug_meta.stage_a.raw_present, true);
  assert.equal(result.debug_meta.stage_a.raw_length, 742);
  assert.equal(result.debug_meta.stage_a.provider, 'gemini');
  assert.deepEqual(result.debug_meta.stage_a.validation_errors_preview, [
    {
      path: '$.products[0].fit_for_skin_type.reason',
      reason: 'minLength',
    },
    {
      path: '$.products[0].fit_for_goals[0].reason',
      reason: 'required',
    },
  ]);
});

test('runRoutineAnalysisV2: stage A debug meta captures upstream error diagnostics', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async call({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        const err = new Error('Gemini API error: 503');
        err.code = 'UPSTREAM_503';
        err.statusCode = 503;
        throw err;
      }
      return { parsed: null, raw: '{}', provider: 'stub' };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_a_upstream',
    language: 'EN',
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
  });

  assert.equal(result.debug_meta.stage_a.llm_status, 'fallback');
  assert.equal(result.debug_meta.stage_a.fallback_reason, 'upstream_error');
  assert.equal(result.debug_meta.stage_a.error_code, 'UPSTREAM_503');
  assert.equal(result.debug_meta.stage_a.status_code, 503);
  assert.equal(result.debug_meta.stage_a.validation_error_count, 0);
  assert.equal(result.debug_meta.stage_a.raw_present, false);
});

test('LlmGateway.callWithSchemaDiagnostics retries invalid JSON once before succeeding', async () => {
  const LlmGateway = require('../src/auroraBff/services/llm_gateway');
  const gateway = new LlmGateway({ stubResponses: false });
  let callCount = 0;
  gateway._callStructuredProvider = async () => {
    callCount += 1;
    if (callCount === 1) return { text: '{"schema_version":' };
    return {
      text: JSON.stringify(buildStageAResult([
        buildAuditProduct('routine_am_01'),
      ])),
    };
  };

  const result = await gateway.callWithSchemaDiagnostics({
    templateId: 'routine_product_audit_v1',
    taskMode: 'routine',
    params: {
      profile_context_json: { skin_type: 'oily' },
      goal_context_json: { goals: ['acne'] },
      season_climate_context_json: {},
      deterministic_signals_json: { product_count: 1 },
      routine_products_json: [
        {
          product_ref: 'routine_am_01',
          slot: 'am',
          original_step_label: 'cleanser',
          input_label: 'Foaming cleanser',
        },
      ],
    },
    schema: 'RoutineProductAuditOutput',
    maxOutputTokens: 2800,
    retryStructuredFailure: true,
  });

  assert.equal(callCount, 2);
  assert.equal(result.schemaValid, true);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.retried, true);
  assert.equal(result.parsed.products[0].product_ref, 'routine_am_01');
});

test('runRoutineAnalysisV2: one-product valid Stage A stays on the main path', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async callWithSchemaDiagnostics({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        return {
          parsed: buildStageAResult([buildAuditProduct('routine_am_01')]),
          parsedCandidate: buildStageAResult([buildAuditProduct('routine_am_01')]),
          raw: '{}',
          provider: 'stub',
          schemaValid: true,
          validationErrors: [],
          attemptCount: 1,
          retried: false,
        };
      }
      return {
        parsed: buildStageBResult(),
        parsedCandidate: buildStageBResult(),
        raw: '{}',
        provider: 'stub',
        schemaValid: true,
        validationErrors: [],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_a_success',
    language: 'EN',
    profileSummary: {
      skinType: 'oily',
      goals: ['acne'],
    },
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.debug_meta.stage_a.llm_status, 'success');
  assert.equal(result.debug_meta.stage_a.fallback_reason, null);
  assert.equal(result.debug_meta.stage_a.attempt_count, 1);
  assert.equal(result.audit.products[0].product_ref, 'routine_am_01');
});

test('runRoutineAnalysisV2: Stage A salvages valid rows and only falls back malformed products', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const stageAProducts = [
    buildAuditProduct('routine_am_01', { inputLabel: 'AM cleanser 1' }),
    buildAuditProduct('routine_am_02', { inputLabel: 'AM cleanser 2' }),
    buildAuditProduct('routine_am_03', { inputLabel: 'AM cleanser 3' }),
    buildAuditProduct('routine_am_04', { inputLabel: 'AM cleanser 4' }),
    buildAuditProduct('routine_pm_05', { slot: 'pm', inputLabel: 'PM serum 1', inferredProductType: 'serum', likelyRole: 'treatment' }),
  ];
  let stageACallCount = 0;
  const llmGateway = {
    async callWithSchemaDiagnostics({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        stageACallCount += 1;
        if (stageACallCount === 1) {
          return {
            parsed: buildStageAResult(stageAProducts.slice(0, 4)),
            parsedCandidate: buildStageAResult(stageAProducts.slice(0, 4)),
            raw: '{}',
            provider: 'stub',
            schemaValid: true,
            validationErrors: [],
            attemptCount: 1,
            retried: false,
          };
        }
        return {
          parsed: null,
          parsedCandidate: buildStageAResult([
            stageAProducts[4],
            {
              slot: 'pm',
              input_label: 'PM serum 2',
              inferred_product_type: 'serum',
            },
          ], { unexpected_top_level: true }),
          raw: '{"schema_version":"aurora.routine_product_audit.v1"}',
          provider: 'stub',
          schemaValid: false,
          validationErrors: [
            { path: '$.products[1].product_ref', reason: 'missing_required_key' },
          ],
          attemptCount: 1,
          retried: false,
        };
      }
      return {
        parsed: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        parsedCandidate: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        raw: '{}',
        provider: 'stub',
        schemaValid: true,
        validationErrors: [],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_a_partial',
    language: 'EN',
    profileSummary: {
      skinType: 'oily',
      goals: ['acne', 'pores'],
    },
    routineProductCandidates: [
      { product_ref: 'routine_am_01', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 1' },
      { product_ref: 'routine_am_02', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 2' },
      { product_ref: 'routine_am_03', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 3' },
      { product_ref: 'routine_am_04', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 4' },
      { product_ref: 'routine_pm_05', slot: 'pm', step: 'treatment', product_text: 'PM serum 1' },
      { product_ref: 'routine_pm_06', slot: 'pm', step: 'treatment', product_text: 'PM serum 2' },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(stageACallCount, 2, 'Stage A should chunk the routine into two calls');
  assert.equal(result.debug_meta.stage_a.llm_status, 'partial');
  assert.equal(result.debug_meta.stage_a.chunk_count, 2);
  assert.equal(result.debug_meta.stage_a.successful_chunk_count, 1);
  assert.equal(result.debug_meta.stage_a.partial_chunk_count, 1);
  assert.equal(result.debug_meta.stage_a.fallback_chunk_count, 0);
  assert.equal(result.audit.products.length, 6);
  assert.deepEqual(result.debug_meta.stage_a.product_reason_sources.slice(-2), [
    { product_ref: 'routine_pm_05', reason_source: 'raw_llm_verbatim' },
    { product_ref: 'routine_pm_06', reason_source: 'fallback_substituted' },
  ]);
});

test('runRoutineAnalysisV2: Stage A keeps partial raw rows when schema only fails on extra properties', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const parsedCandidate = buildStageAResult([buildAuditProduct('routine_am_01')], {
    extra_debug: { note: 'should not force full fallback' },
  });
  const llmGateway = {
    async callWithSchemaDiagnostics({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        return {
          parsed: null,
          parsedCandidate,
          raw: JSON.stringify(parsedCandidate),
          provider: 'stub',
          schemaValid: false,
          validationErrors: [
            { path: '$.extra_debug', reason: 'unexpected_property' },
          ],
          attemptCount: 1,
          retried: false,
        };
      }
      return {
        parsed: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        parsedCandidate: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        raw: '{}',
        provider: 'stub',
        schemaValid: true,
        validationErrors: [],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_a_extra_prop',
    language: 'EN',
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.debug_meta.stage_a.llm_status, 'partial');
  assert.deepEqual(result.debug_meta.stage_a.product_reason_sources, [
    {
      product_ref: 'routine_am_01',
      reason_source: 'raw_llm_verbatim',
    },
  ]);
});

test('runRoutineAnalysisV2: Stage B salvages valid sections when one section fails schema', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async callWithSchemaDiagnostics({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        return {
          parsed: buildStageAResult([buildAuditProduct('routine_am_01')]),
          parsedCandidate: buildStageAResult([buildAuditProduct('routine_am_01')]),
          raw: '{}',
          provider: 'stub',
          schemaValid: true,
          validationErrors: [],
          attemptCount: 1,
          retried: false,
        };
      }
      const parsedCandidate = buildStageBResult({
        improved_am_routine: [
          {
            step_order: 1,
            frequency: 'daily',
          },
        ],
      });
      return {
        parsed: null,
        parsedCandidate,
        raw: JSON.stringify(parsedCandidate),
        provider: 'stub',
        schemaValid: false,
        validationErrors: [
          { path: '$.improved_am_routine[0].what_to_use', reason: 'missing_required_key' },
        ],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_b_partial',
    language: 'EN',
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.debug_meta.stage_b.llm_status, 'partial');
  assert.match(
    result.synthesis.current_routine_assessment.summary,
    /directionally workable but needs a small adjustment|clearest first fix is "Add a clear AM sunscreen step"/i,
  );
  assert.equal(result.synthesis.top_3_adjustments[0].title, 'Add a clear AM sunscreen step');
  assert.ok(result.synthesis.improved_am_routine.length >= 1, 'fallback synthesis should backfill the malformed section');
});

test('runRoutineAnalysisV2: invalid JSON after one retry still falls back cleanly', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async callWithSchemaDiagnostics({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        return {
          parsed: null,
          parsedCandidate: null,
          raw: '{"schema_version":',
          provider: 'stub',
          schemaValid: false,
          validationErrors: [{ path: '$', reason: 'invalid_json' }],
          attemptCount: 2,
          retried: true,
        };
      }
      return {
        parsed: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        parsedCandidate: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        raw: '{}',
        provider: 'stub',
        schemaValid: true,
        validationErrors: [],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_a_invalid_json',
    language: 'EN',
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.debug_meta.stage_a.llm_status, 'fallback');
  assert.equal(result.debug_meta.stage_a.fallback_reason, 'invalid_json');
  assert.equal(result.debug_meta.stage_a.attempt_count, 2);
  assert.equal(result.debug_meta.stage_a.retry_count, 1);
  assert.equal(result.debug_meta.stage_a.product_reason_sources[0].reason_source, 'fallback_substituted');
});

test('runRoutineAnalysisV2: stage A chunk calls run in parallel when routine exceeds one chunk', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  let inFlightStageA = 0;
  let maxInFlightStageA = 0;
  const llmGateway = {
    async callWithSchemaDiagnostics({ templateId, params }) {
      if (templateId === 'routine_product_audit_v1') {
        inFlightStageA += 1;
        maxInFlightStageA = Math.max(maxInFlightStageA, inFlightStageA);
        const chunkIndex = Number(params?.deterministic_signals_json?.stage_a_chunk_index || 1);
        const products = chunkIndex === 1
          ? [
              buildAuditProduct('routine_am_01', { inputLabel: 'AM cleanser 1' }),
              buildAuditProduct('routine_am_02', { inputLabel: 'AM cleanser 2' }),
              buildAuditProduct('routine_am_03', { inputLabel: 'AM cleanser 3' }),
              buildAuditProduct('routine_am_04', { inputLabel: 'AM cleanser 4' }),
            ]
          : [
              buildAuditProduct('routine_pm_05', {
                slot: 'pm',
                inputLabel: 'PM serum 1',
                inferredProductType: 'serum',
                likelyRole: 'treatment',
              }),
            ];
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlightStageA -= 1;
        return {
          parsed: buildStageAResult(products),
          parsedCandidate: buildStageAResult(products),
          raw: '{}',
          provider: 'stub',
          schemaValid: true,
          validationErrors: [],
          attemptCount: 1,
          retried: false,
        };
      }
      return {
        parsed: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        parsedCandidate: buildStageBResult({
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        raw: '{}',
        provider: 'stub',
        schemaValid: true,
        validationErrors: [],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_stage_a_parallel',
    language: 'EN',
    routineProductCandidates: [
      { product_ref: 'routine_am_01', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 1' },
      { product_ref: 'routine_am_02', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 2' },
      { product_ref: 'routine_am_03', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 3' },
      { product_ref: 'routine_am_04', slot: 'am', step: 'cleanser', product_text: 'AM cleanser 4' },
      { product_ref: 'routine_pm_05', slot: 'pm', step: 'treatment', product_text: 'PM serum 1' },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.debug_meta.stage_a.chunk_count, 2);
  assert.equal(maxInFlightStageA >= 2, true);
});

test('runRoutineAnalysisV2: routine audit v1 bypasses deterministic support steps and keeps active steps on stage A LLM', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmStageAInputs = [];
  const llmGateway = {
    async callWithSchemaDiagnostics({ templateId, params }) {
      if (templateId === 'routine_product_audit_v1') {
        const products = Array.isArray(params?.routine_products_json) ? params.routine_products_json : [];
        llmStageAInputs.push(products.map((row) => row.input_label));
        return {
          parsed: buildStageAResult(products.map((product) => buildAuditProduct(product.product_ref, {
            slot: product.slot,
            originalStepLabel: product.original_step_label,
            inputLabel: product.input_label,
            inferredProductType: product.inferred_product_type_hint || 'serum',
            likelyRole: /retinol/i.test(product.input_label) ? 'anti-aging treatment' : 'antioxidant protection',
            likelyKeySignals: /retinol/i.test(product.input_label) ? ['retinoid signal'] : ['vitamin C signal'],
          }))),
          parsedCandidate: null,
          raw: '{}',
          provider: 'stub',
          schemaValid: true,
          validationErrors: [],
          attemptCount: 1,
          retried: false,
        };
      }
      return {
        parsed: buildStageBResult({
          top_3_adjustments: [],
          improved_am_routine: [],
          improved_pm_routine: [],
          rationale_for_each_adjustment: [],
          recommendation_needs: [],
          recommendation_queries: [],
        }),
        parsedCandidate: null,
        raw: '{}',
        provider: 'stub',
        schemaValid: true,
        validationErrors: [],
        attemptCount: 1,
        retried: false,
      };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_routine_audit_v1_selective_stage_a',
    language: 'EN',
    profileSummary: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['texture'],
    },
    routineProductCandidates: [
      { product_ref: 'routine_am_01', slot: 'am', step: 'cleanser', product_text: 'Gentle cleanser' },
      { product_ref: 'routine_am_02', slot: 'am', step: 'treatment', product_text: 'Vitamin C serum' },
      { product_ref: 'routine_am_03', slot: 'am', step: 'moisturizer', product_text: 'Barrier cream' },
      { product_ref: 'routine_am_04', slot: 'am', step: 'spf', product_text: 'SPF50' },
      { product_ref: 'routine_pm_05', slot: 'pm', step: 'cleanser', product_text: 'Gentle cleanser' },
      { product_ref: 'routine_pm_06', slot: 'pm', step: 'treatment', product_text: 'Retinol serum' },
      { product_ref: 'routine_pm_07', slot: 'pm', step: 'moisturizer', product_text: 'Barrier cream' },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
    surfaceMode: 'routine_audit_v1',
  });

  assert.deepEqual(llmStageAInputs, [['Vitamin C serum', 'Retinol serum']]);
  assert.equal(result.debug_meta.stage_a.chunk_count, 1);
  assert.equal(result.debug_meta.stage_a.attempt_count, 1);
  assert.equal(result.debug_meta.stage_a.deterministic_product_count, 5);
  assert.deepEqual(
    result.cards.map((card) => card.type),
    ['routine_verdict_v1', 'routine_product_audit_v1', 'routine_user_fit_v1', 'routine_adjustment_plan_v1'],
  );
  assert.equal(result.cards[1].payload.products.length, 7);
  assert.deepEqual(
    result.debug_meta.stage_a.product_reason_sources.map((row) => row.reason_source),
    [
      'fallback_substituted',
      'raw_llm_verbatim',
      'fallback_substituted',
      'fallback_substituted',
      'fallback_substituted',
      'raw_llm_verbatim',
      'fallback_substituted',
    ],
  );
});

test('normalizeFallbackAuditOutput: quality gate replaces low-value cleanser reasoning with category-level fallback', () => {
  const { normalizeFallbackAuditOutput } = require('../src/auroraBff/routineAnalysisV2');

  const candidates = [
    {
      product_ref: 'prod_cleanser_1',
      slot: 'am',
      step: 'cleanser',
      product_text: 'Foaming cleanser',
    },
  ];

  const audit = normalizeFallbackAuditOutput(candidates, {
    products: [
      {
        product_ref: 'prod_cleanser_1',
        slot: 'am',
        original_step_label: 'cleanser',
        input_label: 'Foaming cleanser',
        resolved_name_or_null: null,
        evidence_basis: ['step_label'],
        inferred_product_type: 'cleanser',
        likely_role: 'cleansing',
        likely_key_ingredients_or_signals: ['cleanser signal'],
        fit_for_skin_type: {
          verdict: 'unknown',
          reason: 'Without knowing the ingredients, it is hard to assess this cleanser for oily skin.',
        },
        fit_for_goals: [
          {
            goal: 'acne',
            verdict: 'unknown',
            reason: 'Without knowing the ingredients, it is hard to assess its impact on acne.',
          },
          {
            goal: 'pores',
            verdict: 'unknown',
            reason: 'Without knowing the ingredients, it is hard to assess its impact on pores.',
          },
        ],
        fit_for_season_or_climate: {
          verdict: 'unknown',
          reason: 'Need climate information to assess.',
        },
        potential_concerns: [],
        suggested_action: 'keep',
        confidence: 0.62,
        missing_info: ['No ingredient list was provided.'],
        concise_reasoning_en: 'This is a cleanser, which is a routine basic. Without an ingredients list, it is hard to assess its acne and pore fit.',
      },
    ],
    confidence: 0.62,
  }, {
    goals: ['acne', 'pores'],
    skinType: 'oily',
    sensitivity: 'medium',
    barrierStatus: 'impaired',
  });

  const product = audit.products[0];
  assert.ok(product, 'expected a normalized product');
  assert.doesNotMatch(product.fit_for_skin_type.reason, /without knowing the ingredients|hard to assess/i);
  assert.doesNotMatch(product.fit_for_season_or_climate.reason, /need climate information to assess/i);
  assert.doesNotMatch(product.concise_reasoning_en, /without an ingredients list|routine basic/i);
  assert.equal(product.fit_for_goals.length, 2);
  assert.notEqual(
    String(product.fit_for_goals[0].reason).toLowerCase(),
    String(product.fit_for_goals[1].reason).toLowerCase(),
    'goal reasons should not stay duplicated boilerplate',
  );
  assert.equal(audit.quality_gate_meta.quality_gate_applied_count, 1);
  assert.deepEqual(audit.quality_gate_meta.product_reason_sources, [
    {
      product_ref: 'prod_cleanser_1',
      reason_source: 'quality_gate_replaced',
    },
  ]);
});

test('normalizeFallbackAuditOutput: moisturizer fallback stays useful when season context is missing', () => {
  const { normalizeFallbackAuditOutput } = require('../src/auroraBff/routineAnalysisV2');

  const audit = normalizeFallbackAuditOutput([
    {
      product_ref: 'prod_moisturizer_1',
      slot: 'pm',
      step: 'moisturizer',
      product_text: 'Barrier cream',
    },
  ], null, {
    goals: ['dehydration'],
    skinType: 'dry',
    sensitivity: 'medium',
    barrierStatus: 'impaired',
  });

  const product = audit.products[0];
  assert.ok(product, 'expected a fallback product audit');
  assert.match(product.fit_for_skin_type.reason, /barrier-support step|barrier support/i);
  assert.match(product.fit_for_goals[0].reason, /hydrating|dehydration/i);
  assert.equal(product.fit_for_season_or_climate.verdict, 'unknown');
  assert.doesNotMatch(product.fit_for_skin_type.reason, /hard to assess/i);
  assert.deepEqual(audit.quality_gate_meta.product_reason_sources, [
    {
      product_ref: 'prod_moisturizer_1',
      reason_source: 'fallback_substituted',
    },
  ]);
});

test('runRoutineAnalysisV2: debug meta records quality-gate replacements without changing recommendation behavior', async () => {
  const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');
  const llmGateway = {
    async call({ templateId }) {
      if (templateId === 'routine_product_audit_v1') {
        return {
          parsed: {
            schema_version: 'aurora.routine_product_audit.v1',
            products: [
              {
                product_ref: 'routine_am_01',
                slot: 'am',
                original_step_label: 'cleanser',
                input_label: 'Foaming cleanser',
                resolved_name_or_null: null,
                evidence_basis: ['step_label'],
                inferred_product_type: 'cleanser',
                likely_role: 'cleansing',
                likely_key_ingredients_or_signals: ['cleanser signal'],
                fit_for_skin_type: {
                  verdict: 'unknown',
                  reason: 'Without knowing the ingredients, it is hard to assess.',
                },
                fit_for_goals: [
                  {
                    goal: 'acne',
                    verdict: 'unknown',
                    reason: 'Without knowing the ingredients, it is hard to assess.',
                  },
                  {
                    goal: 'pores',
                    verdict: 'unknown',
                    reason: 'Without knowing the ingredients, it is hard to assess.',
                  },
                ],
                fit_for_season_or_climate: {
                  verdict: 'unknown',
                  reason: 'Need climate information to assess.',
                },
                potential_concerns: [],
                suggested_action: 'keep',
                confidence: 0.61,
                missing_info: [],
                concise_reasoning_en: 'This is a routine basic and hard to assess without ingredients.',
              },
            ],
            additional_items_needing_verification: [],
            missing_info: [],
            confidence: 0.61,
          },
        };
      }
      return { parsed: null };
    },
  };

  const result = await runRoutineAnalysisV2({
    requestId: 'req_quality_gate',
    language: 'EN',
    profileSummary: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['acne', 'pores'],
    },
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    llmGateway,
    recommendationResolverDeps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 0 }),
    },
  });

  assert.equal(result.debug_meta.stage_a.quality_gate_applied_count, 1);
  assert.deepEqual(result.debug_meta.stage_a.product_reason_sources, [
    {
      product_ref: 'routine_am_01',
      reason_source: 'quality_gate_replaced',
    },
  ]);
  assert.equal(result.cards[0].type, 'routine_product_audit_v1');
  assert.ok(Array.isArray(result.recommendation_groups), 'recommendation groups should still be emitted consistently');
});
