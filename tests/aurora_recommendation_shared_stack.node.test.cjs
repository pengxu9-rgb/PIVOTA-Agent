const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRecommendationIntent,
  buildRecommendationRequestContext,
  runRecommendationSharedStack,
} = require('../src/auroraBff/recommendationSharedStack');
const RecoStepBasedSkill = require('../src/auroraBff/skills/reco_step_based');
const { mapSkillResponseToStreamEnvelope } = require('../src/auroraBff/mappers/card_mapper');
const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

test('normalizeRecommendationIntent falls back to unknown exploratory contract', () => {
  const result = normalizeRecommendationIntent({ entryType: 'direct', message: '', directRequest: {} });
  assert.equal(result.need_id, 'unknown');
  assert.equal(result.need_type, 'exploratory');
  assert.equal(result.target_need, null);
  assert.equal(result.needs_clarification, true);
});

test('buildRecommendationRequestContext produces stable signature and explicit-first hard context', () => {
  const intent = normalizeRecommendationIntent({
    entryType: 'direct',
    directRequest: { focus: 'Recommend a gentle cleanser' },
  });
  const context = buildRecommendationRequestContext({
    intent,
    profile: {
      skinType: 'oily',
      sensitivity: 'high',
      goals: ['acne', 'pores'],
    },
    recentLogs: [],
    requestOverride: { goals: ['acne'] },
  });

  assert.equal(context.need_id, 'recommend_a_gentle_cleanser');
  assert.equal(context.strictness_mode, 'strict');
  assert.ok(context.request_context_signature);
  assert.deepEqual(context.snapshot_hard_context.active_goals, ['acne']);
  assert.equal(context.context_usage.explicit_override_applied, true);
});

test('runRecommendationSharedStack keeps generic reco runnable without target_need', async () => {
  const out = await runRecommendationSharedStack({
    entryType: 'chat',
    message: 'Recommend a few products',
    profile: { goals: ['hydration'] },
    coreRunner: async (input) => {
      assert.ok(input.sharedRequestContext);
      return {
        norm: {
          payload: {
            recommendations: [{ brand: 'CeraVe', name: 'Hydrating Cleanser' }],
            recommendation_meta: {
              source_mode: 'catalog_grounded',
              analysis_context_usage: input.sharedRequestContext.context_usage,
            },
          },
        },
        mainlineStatus: 'grounded_success',
        candidatePool: [{ product_id: 'sku_1', brand: 'CeraVe', name: 'Hydrating Cleanser' }],
        poolSource: 'catalog_candidates',
      };
    },
    coreInput: {},
  });

  assert.equal(out.needs_more_context, false);
  assert.ok(out.request_context.request_context_signature);
  assert.ok(out.candidate_pool.candidate_pool_signature);
  assert.equal(out.core_result.debug_meta.mainline_status, 'grounded_success');
});

test('RecoStepBasedSkill uses shared core and exposes shared-stack meta', async () => {
  RecoStepBasedSkill.__setSharedRecoCoreRunnerForTest(async (input) => ({
    norm: {
      payload: {
        recommendations: [{ brand: 'CeraVe', name: 'Hydrating Cleanser' }],
        recommendation_meta: {
          source_mode: 'catalog_grounded',
          grounding_status: 'grounded',
          analysis_context_usage: input.sharedRequestContext.context_usage,
          llm_trace: { prompt_hash: 'prompt_hash_123' },
        },
      },
    },
    mainlineStatus: 'grounded_success',
    candidatePool: [{ product_id: 'sku_1', brand: 'CeraVe', name: 'Hydrating Cleanser' }],
    poolSource: 'catalog_candidates',
  }));

  try {
    const skill = new RecoStepBasedSkill();
    const response = await skill.run({
      params: {
        entry_source: 'chip.start.reco_products',
        user_message: 'Recommend a few products',
      },
      context: {
        locale: 'en-US',
        profile: { goals: ['hydration'] },
        recent_logs: [],
      },
      thread_state: {},
    }, null);

    const envelope = mapSkillResponseToStreamEnvelope(response, []);
    assert.equal(envelope.meta.skill_id, 'reco.step_based');
    assert.ok(envelope.meta.request_context_signature);
    assert.ok(envelope.meta.candidate_pool_signature);
    assert.equal(envelope.meta.mainline_status, 'grounded_success');
    assert.equal(envelope.meta.analysis_context_usage.context_mode, 'snapshot_hard');
    const recoCard = envelope.cards.find((card) => card.card_type === 'recommendations');
    assert.ok(recoCard);
    assert.equal(recoCard.metadata.recommendations[0].name, 'Hydrating Cleanser');
  } finally {
    RecoStepBasedSkill.__resetSharedRecoCoreRunnerForTest();
  }
});

test('buildSkillRequest carries session analysis_context_snapshot into skill context', () => {
  const request = buildSkillRequest({
    body: {
      message: 'Recommend products',
      session: {
        profile: { goals: ['hydration'] },
        meta: {
          analysis_context_snapshot: {
            snapshot_id: 'snap_1',
          },
        },
      },
    },
    headers: {},
    _recentLogs: [],
    _userProfile: null,
  });

  assert.deepEqual(request.context.analysis_context_snapshot, { snapshot_id: 'snap_1' });
});
