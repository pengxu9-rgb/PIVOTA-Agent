const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAnalysisContextSnapshotV1,
  resolveAnalysisContextForTask,
  buildRoutineAnalysisContextFromSnapshot,
  buildProductAnalysisContextFromSnapshot,
  buildIngredientAnalysisContextFromSnapshot,
  buildRecommendationAnalysisContextFromSnapshot,
  buildTravelAnalysisContextFromSnapshot,
  buildAnalysisContextPromptBlock,
} = require('../src/auroraBff/analysisContextSnapshot');
const { runRoutineAnalysisV2 } = require('../src/auroraBff/routineAnalysisV2');

function buildDiagnosisArtifact(overrides = {}) {
  return {
    artifact_id: 'artifact_diag_001',
    schema: 'aurora.skin_diagnosis.v2',
    created_at: '2026-03-12T12:00:00.000Z',
    data: {
      goal_profile: {
        selected_goals: ['acne', 'pores'],
      },
      inferred_state: {
        axes: [
          { axis: 'sensitivity_level', level: 'high', confidence: 0.88 },
          { axis: 'barrier_irritation_risk', level: 'moderate', confidence: 0.82 },
          { axis: 'uv_sensitivity', level: 'high', confidence: 0.76 },
        ],
      },
      data_quality: {
        overall: 'high',
      },
      ...overrides.data,
    },
    ...overrides,
  };
}

function buildSnapshotFixture() {
  const profile = {
    skinType: 'combination',
    sensitivity: 'medium',
    barrierStatus: 'healthy',
    goals: ['wrinkles'],
    contraindications: ['fragrance'],
  };
  const snapshot = buildAnalysisContextSnapshotV1({
    latestArtifact: buildDiagnosisArtifact(),
    profile,
    recentLogs: [
      { note: 'Redness and tightness after actives this week.' },
    ],
  });
  return { profile, snapshot };
}

test('analysisContextSnapshot: explicit profile stays in snapshot while request override remains request-scoped', () => {
  const { profile, snapshot } = buildSnapshotFixture();
  assert.ok(snapshot, 'snapshot should be created');
  assert.match(String(snapshot.snapshot_id), /^acs_/);
  assert.deepEqual(snapshot.derived_from_artifact_ids, ['artifact_diag_001']);
  assert.equal(typeof snapshot.derived_from_artifact_signature, 'string');
  assert.equal(snapshot.goals.active_goals.items[0].value, 'wrinkles');
  assert.ok(
    !snapshot.goals.active_goals.items.some((item) => item && item.value === 'dehydration'),
    'request-scoped override goals must not enter stored snapshot',
  );

  const resolved = resolveAnalysisContextForTask({
    task: 'product_analyze',
    snapshot,
    profile,
    requestOverride: {
      goals: ['dehydration'],
      sensitivity: 'high',
      contraindications: ['essential oils'],
    },
  });
  const taskContext = buildProductAnalysisContextFromSnapshot(resolved);
  assert.deepEqual(taskContext.task_hard_context.active_goals, ['dehydration']);
  assert.equal(taskContext.task_hard_context.sensitivity, 'high');
  assert.deepEqual(taskContext.task_hard_context.ingredient_avoid, ['essential oils']);
  assert.equal(taskContext.explicit_override_applied, true);
});

test('analysisContextSnapshot: resolved context distinguishes artifact, explicit_only, compat fallback, and none', () => {
  const explicitOnly = resolveAnalysisContextForTask({
    task: 'recommendation',
    snapshot: buildAnalysisContextSnapshotV1({
      latestArtifact: null,
      profile: { goals: ['hydration'], sensitivity: 'high' },
      recentLogs: [],
    }),
    profile: { goals: ['hydration'], sensitivity: 'high' },
    requestOverride: null,
    recentLogs: [],
  });
  assert.equal(explicitOnly.snapshot_present, false);
  assert.equal(explicitOnly.context_source_mode, 'explicit_only');
  assert.equal(explicitOnly.analysis_context_available, true);

  const compatFallback = resolveAnalysisContextForTask({
    task: 'recommendation',
    snapshot: buildAnalysisContextSnapshotV1({
      latestArtifact: null,
      profile: {},
      lastAnalysis: {
        skin_profile: { skin_type_tendency: 'combination' },
      },
      recentLogs: [],
    }),
    profile: {
      lastAnalysis: {
        skin_profile: { skin_type_tendency: 'combination' },
      },
    },
    requestOverride: null,
    recentLogs: [],
  });
  assert.equal(compatFallback.snapshot_present, true);
  assert.equal(compatFallback.context_source_mode, 'artifact_compat_fallback');
  assert.equal(compatFallback.analysis_context_available, true);

  const none = resolveAnalysisContextForTask({
    task: 'recommendation',
    snapshot: null,
    profile: null,
    requestOverride: null,
    recentLogs: [],
  });
  assert.equal(none.snapshot_present, false);
  assert.equal(none.context_source_mode, 'none');
  assert.equal(none.analysis_context_available, false);
});

test('analysisContextSnapshot: adapter consistency keeps hard/soft/exclude boundaries stable across tasks', () => {
  const { profile, snapshot } = buildSnapshotFixture();
  const resolved = resolveAnalysisContextForTask({
    task: 'shared',
    snapshot,
    profile,
    requestOverride: null,
  });

  const routineContext = buildRoutineAnalysisContextFromSnapshot(resolved);
  const productContext = buildProductAnalysisContextFromSnapshot(resolved);
  const ingredientContext = buildIngredientAnalysisContextFromSnapshot(resolved);
  const recommendationContext = buildRecommendationAnalysisContextFromSnapshot(resolved);
  const travelContext = buildTravelAnalysisContextFromSnapshot(resolved);

  assert.equal(routineContext.snapshot_present, true);
  assert.equal(routineContext.context_source_mode, 'artifact');
  assert.equal(routineContext.analysis_context_available, true);
  assert.deepEqual(routineContext.task_hard_context.active_goals, ['wrinkles']);
  assert.equal(routineContext.task_hard_context.sensitivity, 'medium');
  assert.equal(routineContext.task_hard_context.barrier_status, 'healthy');
  assert.ok(Array.isArray(routineContext.task_hard_context.risk_axes));

  assert.equal(productContext.snapshot_present, true);
  assert.equal(productContext.context_source_mode, 'artifact');
  assert.equal(productContext.analysis_context_available, true);
  assert.deepEqual(productContext.task_hard_context.active_goals, ['wrinkles']);
  assert.equal(productContext.task_hard_context.skin_type, 'combination');
  assert.deepEqual(productContext.task_hard_context.ingredient_avoid, ['fragrance']);

  assert.equal(ingredientContext.snapshot_present, true);
  assert.equal(ingredientContext.context_source_mode, 'artifact');
  assert.equal(ingredientContext.analysis_context_available, true);
  assert.deepEqual(ingredientContext.task_hard_context.active_goals, ['wrinkles']);
  assert.equal(ingredientContext.task_hard_context.sensitivity, 'medium');
  assert.equal(ingredientContext.task_hard_context.barrier_status, 'healthy');
  assert.deepEqual(ingredientContext.task_hard_context.ingredient_avoid, ['fragrance']);
  assert.equal(
    Object.prototype.hasOwnProperty.call(ingredientContext.task_hard_context, 'photo_findings'),
    false,
    'ingredient adapter should not promote photo findings into hard context',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(ingredientContext.task_soft_context, 'photo_findings'),
    false,
    'ingredient adapter should exclude photo findings from ingredient analysis context',
  );

  assert.deepEqual(recommendationContext.task_hard_context.ingredient_avoid, ['fragrance']);
  assert.equal(
    Object.prototype.hasOwnProperty.call(recommendationContext.task_soft_context, 'ingredient_avoid'),
    false,
    'recommendation adapter should not keep heuristic/soft avoid values as soft exclusions list',
  );
  assert.equal(recommendationContext.snapshot_present, true);
  assert.equal(recommendationContext.context_source_mode, 'artifact');
  assert.equal(recommendationContext.analysis_context_available, true);

  assert.equal(travelContext.snapshot_present, true);
  assert.equal(travelContext.context_source_mode, 'artifact');
  assert.equal(travelContext.analysis_context_available, true);
  assert.deepEqual(travelContext.task_hard_context.active_goals, ['wrinkles']);
  assert.ok(Array.isArray(travelContext.task_hard_context.risk_axes));
  assert.ok(
    travelContext.task_hard_context.risk_axes.some((item) => String(item).includes('uv_sensitivity')),
    'travel should keep UV-related risk axes in hard context',
  );
});

test('analysisContextSnapshot: low-confidence heuristic avoid stays soft for recommendation', () => {
  const snapshot = {
    snapshot_id: 'acs_test',
    source_mix_summary: ['system_heuristic'],
    conflicts: [],
    goals: {
      active_goals: { items: [], primary_items: [], candidate_sources: [], conflict_state: 'resolved' },
      background_goals: { items: [], primary_items: [], candidate_sources: [], conflict_state: 'resolved' },
    },
    ingredient_avoid: {
      items: [
        {
          value: 'fragrance',
          source_class: 'heuristic',
          source_subclass: 'system_heuristic',
          source_ref: 'system_heuristic:fragrance',
          confidence: 0.42,
          freshness_bucket: 'fresh',
          derived_from_artifact_id: null,
        },
      ],
      primary_items: [
        {
          value: 'fragrance',
          source_class: 'heuristic',
          source_subclass: 'system_heuristic',
          source_ref: 'system_heuristic:fragrance',
          confidence: 0.42,
          freshness_bucket: 'fresh',
          derived_from_artifact_id: null,
        },
      ],
      candidate_sources: [],
      conflict_state: 'resolved',
    },
  };
  const context = buildRecommendationAnalysisContextFromSnapshot(resolveAnalysisContextForTask({
    task: 'recommendation',
    snapshot,
    profile: null,
    requestOverride: null,
  }));

  assert.equal(Object.prototype.hasOwnProperty.call(context.task_hard_context, 'ingredient_avoid'), false);
  assert.ok(
    context.task_exclusions.some((item) => item.field === 'ingredient_avoid.fragrance' && item.reason === 'low_confidence'),
    'heuristic-only avoid should be excluded from hard recommendation constraints',
  );
});

test('analysisContextSnapshot: prompt block carries task-shaped context and usage rules', () => {
  const block = buildAnalysisContextPromptBlock({
    taskLabel: 'product_analyze',
    taskContext: {
      task_hard_context: { active_goals: ['wrinkles'], sensitivity: 'high' },
      task_soft_context: { photo_findings: ['redness (cheeks)'] },
      evidence_summary: ['Recent diagnosis points to barrier reactivity.'],
      analysis_context_conflicts: [{ field: 'sensitivity_tendency', resolution: 'mixed' }],
      context_mode: 'snapshot_mixed',
    },
  });

  assert.match(block, /\[ANALYSIS CONTEXT FOR PRODUCT_ANALYZE\]/);
  assert.match(block, /analysis_context_hard_json=/);
  assert.match(block, /analysis_context_soft_json=/);
  assert.match(block, /analysis_context_conflicts_json=/);
  assert.match(block, /soft context must be treated as supportive or uncertainty-bearing context/i);
  assert.match(block, /explicit request\/profile input conflicts with snapshot, explicit input wins/i);
});

test('runRoutineAnalysisV2: snapshot context and request override are passed into Stage A and Stage B prompt params', async () => {
  const { profile, snapshot } = buildSnapshotFixture();
  const capturedCalls = [];
  const llmGateway = {
    async callWithSchemaDiagnostics(request) {
      capturedCalls.push(request);
      if (request.templateId === 'routine_product_audit_v1') {
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
                fit_for_skin_type: { verdict: 'mixed', reason: 'Usable, but can run strong on a stressed barrier.' },
                fit_for_goals: [{ goal: 'dehydration', verdict: 'mixed', reason: 'Cleansing supports tolerance, but hydration depends on the leave-on steps.' }],
                fit_for_season_or_climate: { verdict: 'good', reason: 'This category is usually usable year-round.' },
                potential_concerns: [],
                suggested_action: 'keep',
                confidence: 0.74,
                missing_info: [],
                concise_reasoning_en: 'This reads like a cleanser, so the main question is whether it strips a sensitive barrier.',
              },
            ],
            additional_items_needing_verification: [],
            missing_info: [],
            confidence: 0.74,
          },
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
        parsed: {
          schema_version: 'aurora.routine_synthesis.v1',
          current_routine_assessment: {
            summary: 'The routine mostly works but still needs stronger hydration support.',
            main_strengths: ['It already has a steady cleanse-moisturize structure.'],
            main_issues: ['Barrier support needs to stay gentle.'],
          },
          per_step_order_am: [],
          per_step_order_pm: [],
          overlap_or_gaps: [],
          top_3_adjustments: [],
          improved_am_routine: [],
          improved_pm_routine: [],
          rationale_for_each_adjustment: [],
          recommendation_needs: [],
          recommendation_queries: [],
          confidence: 0.78,
          missing_info: [],
        },
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
    requestId: 'req_snapshot_prompt',
    language: 'EN',
    profile,
    routineProductCandidates: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        step: 'cleanser',
        product_text: 'Foaming cleanser',
      },
    ],
    analysisContextSnapshot: snapshot,
    requestProfileOverride: {
      goals: ['dehydration'],
      sensitivity: 'high',
    },
    llmGateway,
  });

  assert.equal(capturedCalls.length, 2);
  for (const call of capturedCalls) {
    assert.ok(call.params, 'structured request params should exist');
    assert.deepEqual(call.params.analysis_context_hard_json.active_goals, ['dehydration']);
    assert.equal(call.params.analysis_context_hard_json.sensitivity, 'high');
    assert.ok(Array.isArray(call.params.analysis_context_evidence_json));
    assert.ok(Array.isArray(call.params.analysis_context_conflicts_json));
  }
  assert.equal(result.debug_meta.analysis_context.snapshot_present, true);
  assert.equal(result.debug_meta.analysis_context.explicit_override_applied, true);
});
