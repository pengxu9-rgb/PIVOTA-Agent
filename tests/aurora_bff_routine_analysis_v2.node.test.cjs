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
