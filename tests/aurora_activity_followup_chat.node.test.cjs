const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  seedDiagnosisArtifactForUid,
  findCard,
  parseCards,
} = require('./aurora_bff_test_harness.cjs');
const { __internal } = require('../src/auroraBff/routes');

test('resolveImplicitAnalysisFollowupActionId upgrades saved-analysis solution asks into solution_next_steps', () => {
  const actionId = __internal.resolveImplicitAnalysisFollowupActionId({
    message: 'solve my acne problems',
    sessionMeta: {
      source_activity_id: 'artifact:da_saved_1',
    },
    sessionAnalysisContext: {
      followup_mode: 'saved_analysis',
      analysis_story_snapshot: {
        schema_version: 'aurora.analysis_story.v2',
        priority_findings: [{ title: 'Recurring breakouts' }],
        ui_card_v1: { headline: 'Focus on breakouts first' },
      },
    },
    latestArtifactId: 'da_saved_1',
  });

  assert.equal(actionId, 'chip.aurora.next_action.solution_next_steps');
});

test('resolveImplicitAnalysisFollowupActionId keeps tell-me-more prompts on deep_dive_skin', () => {
  const actionId = __internal.resolveImplicitAnalysisFollowupActionId({
    message: 'Tell me more about my skin',
    sessionMeta: {
      source_activity_id: 'artifact:da_saved_1',
    },
    sessionAnalysisContext: {
      followup_mode: 'saved_analysis',
      analysis_story_snapshot: {
        schema_version: 'aurora.analysis_story.v2',
        priority_findings: [{ title: 'Recurring breakouts' }],
        ui_card_v1: { headline: 'Focus on breakouts first' },
      },
    },
    latestArtifactId: 'da_saved_1',
  });

  assert.equal(actionId, 'chip.aurora.next_action.deep_dive_skin');
});

test('resolveImplicitAnalysisFollowupActionId does not hijack product URL requests inside saved-analysis chats', () => {
  const actionId = __internal.resolveImplicitAnalysisFollowupActionId({
    message: 'https://www.sephora.com/product/example-serum',
    sessionMeta: {
      source_activity_id: 'artifact:da_saved_1',
    },
    sessionAnalysisContext: {
      followup_mode: 'saved_analysis',
      analysis_story_snapshot: {
        schema_version: 'aurora.analysis_story.v2',
        priority_findings: [{ title: 'Recurring breakouts' }],
        ui_card_v1: { headline: 'Focus on breakouts first' },
      },
    },
    latestArtifactId: 'da_saved_1',
  });

  assert.equal(actionId, null);
});

test('/v1/chat: saved-analysis follow-up persists snapshot context and turns second free-text into a solution follow-up', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_CHAT_SKILL_ROUTER_V2: 'false',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
    },
    async () => {
      const uid = buildTestUid('activity_followup_chat');
      const artifactId = `da_${uid}`;
      const llmCalls = [];

      await seedDiagnosisArtifactForUid(uid, {
        artifact_id: artifactId,
        created_at: new Date().toISOString(),
        use_photo: true,
        overall_confidence: { level: 'high', score: 0.86 },
        skinType: { value: 'oily', confidence: { score: 0.84, level: 'high' } },
        sensitivity: { value: 'medium', confidence: { score: 0.82, level: 'high' } },
        barrierStatus: { value: 'healthy', confidence: { score: 0.8, level: 'high' } },
        goals: {
          values: ['acne', 'hydration'],
          confidence: { score: 0.83, level: 'high' },
        },
        concerns: [{ type: 'breakouts', title: 'Recurring breakouts' }],
        analysis_context: {
          analysis_source: 'vision_gemini',
          used_photos: true,
          quality_grade: 'pass',
        },
        source_mix: ['photo', 'profile'],
      });

      const harness = createAppWithPatchedAuroraChat({
        auroraChatImpl: async (request) => {
          llmCalls.push(request);
          return {
            answer: 'Based on your saved skin analysis, focus on acne-safe next steps first.',
            intent: 'chat',
            cards: [],
          };
        },
      });

      try {
        const deepDiveResponse = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            language: 'EN',
            session: {
              state: 'idle',
              meta: {
                latest_artifact_id: artifactId,
                source_activity_id: 'act_saved_skin_1',
              },
            },
            action: {
              action_id: 'chip.aurora.next_action.deep_dive_skin',
              data: {
                reply_text: 'Continue from my saved skin analysis and tell me the next best steps.',
              },
            },
          })
          .expect(200);

        const persistedMeta = deepDiveResponse.body?.session_patch?.meta || {};
        assert.ok(String(persistedMeta.latest_artifact_id || '').trim());
        assert.equal(persistedMeta.source_activity_id, 'act_saved_skin_1');
        assert.equal(persistedMeta.analysis_context?.followup_mode, 'saved_analysis');
        assert.ok(persistedMeta.analysis_context?.analysis_story_snapshot);

        const response = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'solve my acne problems',
            language: 'EN',
            session: {
              state: 'idle',
              meta: persistedMeta,
            },
          })
          .expect(200);

        assert.equal(llmCalls.length, 0);
        const cards = parseCards(response.body);
        assert.equal(Boolean(findCard(cards, 'diagnosis_gate')), false);
        const summaryCard = findCard(cards, 'analysis_summary');
        assert.ok(summaryCard, 'saved-analysis solution should return analysis_summary');
        assert.match(
          String(summaryCard?.payload?.title || ''),
          /Acne next steps from your saved analysis|基于历史分析的控痘下一步/i,
        );
        assert.match(
          String(summaryCard?.payload?.primary_cta_label || ''),
          /acne-safe product recommendations|控痘产品推荐/i,
        );
        assert.equal(summaryCard?.payload?.primary_action_id, 'analysis_continue_products');
        assert.equal(
          Array.isArray(summaryCard?.payload?.analysis?.features) && summaryCard.payload.analysis.features.length > 0,
          true,
        );
        assert.match(
          String(response.body?.assistant_message?.content || response.body?.assistant_text || ''),
          /ingredients to prioritize|product recommendations next/i,
        );
        const quickReplies = Array.isArray(response.body?.suggested_quick_replies) ? response.body.suggested_quick_replies : [];
        assert.equal(quickReplies.some((item) => String(item?.id || '') === 'chip.start.reco_products'), true);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/chat: saved-analysis free-text stays on analysis-followup path even when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
    },
    async () => {
      const uid = buildTestUid('activity_followup_chat_v2');
      const artifactId = `da_${uid}`;

      await seedDiagnosisArtifactForUid(uid, {
        artifact_id: artifactId,
        created_at: new Date().toISOString(),
        use_photo: false,
        overall_confidence: { level: 'medium', score: 0.75 },
        skinType: { value: 'oily', confidence: { score: 0.84, level: 'high' } },
        sensitivity: { value: 'medium', confidence: { score: 0.82, level: 'high' } },
        barrierStatus: { value: 'healthy', confidence: { score: 0.8, level: 'high' } },
        goals: {
          values: ['acne', 'pores'],
          confidence: { score: 0.83, level: 'high' },
        },
        concerns: [{ type: 'breakouts', title: 'Recurring breakouts' }],
        analysis_context: {
          analysis_source: 'rule_based',
          used_photos: false,
          quality_grade: 'unknown',
        },
        source_mix: ['rule', 'profile'],
      });

      const harness = createAppWithPatchedAuroraChat();

      try {
        const deepDiveResponse = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            language: 'EN',
            session: {
              state: 'idle',
              meta: {
                latest_artifact_id: artifactId,
                source_activity_id: 'artifact:da_saved_skin_v2',
              },
            },
            action: {
              action_id: 'chip.aurora.next_action.deep_dive_skin',
              data: {
                reply_text: 'Continue from my saved skin analysis.',
              },
            },
          })
          .expect(200);

        const persistedMeta = deepDiveResponse.body?.session_patch?.meta || {};
        assert.equal(persistedMeta.analysis_context?.followup_mode, 'saved_analysis');

        const response = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'solve my acne problems',
            language: 'EN',
            session: {
              state: 'idle',
              meta: persistedMeta,
            },
          })
          .expect(200);

        const cards = parseCards(response.body);
        assert.equal(Boolean(findCard(cards, 'diagnosis_gate')), false);
        const summaryCard = findCard(cards, 'analysis_summary');
        assert.ok(summaryCard, 'saved-analysis solution should return analysis_summary under router v2');
        assert.equal(summaryCard?.payload?.primary_action_id, 'analysis_continue_products');
        assert.match(
          String(response.body?.assistant_message?.content || response.body?.assistant_text || ''),
          /ingredients to prioritize|product recommendations next/i,
        );
        const quickReplies = Array.isArray(response.body?.suggested_quick_replies) ? response.body.suggested_quick_replies : [];
        assert.equal(quickReplies.some((item) => String(item?.id || '') === 'chip.start.reco_products'), true);
      } finally {
        harness.restore();
      }
    },
  );
});
