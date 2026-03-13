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
