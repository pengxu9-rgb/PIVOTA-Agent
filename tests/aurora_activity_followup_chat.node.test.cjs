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

test('/v1/chat: activity follow-up reads latest_artifact_id from session.meta and avoids diagnosis gate on saved-analysis follow-ups', async () => {
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
        const response = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'solve my acne problems',
            language: 'EN',
            session: {
              state: 'idle',
              meta: {
                latest_artifact_id: artifactId,
                source_activity_id: 'act_saved_skin_1',
              },
            },
          })
          .expect(200);

        const query = String(llmCalls[0]?.query || '');
        assert.equal(llmCalls.length, 1);
        assert.match(query, /saved skin analysis|skin analysis context|analysis context/i);
        assert.match(query, /oily/i);
        assert.match(query, /medium/i);
        assert.match(query, /healthy/i);
        assert.match(query, /acne/i);
        assert.equal(Boolean(findCard(parseCards(response.body), 'diagnosis_gate')), false);
      } finally {
        harness.restore();
      }
    },
  );
});
