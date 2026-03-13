const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
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
        assert.equal(Boolean(meta.routine_analysis_v2 && meta.routine_analysis_v2.enabled), true);
        assert.equal(meta.routine_analysis_legacy_compat && meta.routine_analysis_legacy_compat.source, 'routine_analysis_v2');
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
