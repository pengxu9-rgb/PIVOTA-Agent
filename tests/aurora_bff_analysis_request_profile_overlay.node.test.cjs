const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  parseCards,
} = require('./aurora_bff_test_harness.cjs');

test('/v1/analysis/skin: top-level request profile fields overlay routine analysis context', async () => {
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
        const uid = buildTestUid('analysis_request_profile_overlay');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            skinType: 'oily',
            sensitivity: 'medium',
            barrierStatus: 'impaired',
            goals: ['acne', 'pores'],
            currentRoutine: {
              am: {
                cleanser: 'Foaming cleanser',
              },
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.equal(cards[0] && cards[0].type, 'routine_product_audit_v1');
        assert.equal(cards[1] && cards[1].type, 'routine_adjustment_plan_v1');

        const sessionPatch = resp.body && resp.body.session_patch && typeof resp.body.session_patch === 'object'
          ? resp.body.session_patch
          : {};
        const sessionProfile = sessionPatch.profile && typeof sessionPatch.profile === 'object'
          ? sessionPatch.profile
          : {};
        assert.equal(sessionProfile.skinType, 'oily');
        assert.equal(sessionProfile.sensitivity, 'medium');
        assert.equal(sessionProfile.barrierStatus, 'impaired');
        assert.deepEqual(sessionProfile.goals, ['acne', 'pores']);

        const meta = sessionPatch.meta && typeof sessionPatch.meta === 'object' ? sessionPatch.meta : {};
        const routineMeta = meta.routine_analysis_v2 && typeof meta.routine_analysis_v2 === 'object'
          ? meta.routine_analysis_v2
          : {};
        assert.equal(routineMeta.profile_context_source, 'request_overlay_applied');
        assert.equal(routineMeta.request_profile_overlay_applied, true);
        assert.deepEqual(routineMeta.request_profile_overlay_keys, ['barrierStatus', 'goals', 'sensitivity', 'skinType']);

        const analysisMeta = resp.body && resp.body.analysis_meta && typeof resp.body.analysis_meta === 'object'
          ? resp.body.analysis_meta
          : {};
        assert.equal(analysisMeta.profile_context_source, 'request_overlay_applied');
        assert.equal(analysisMeta.request_profile_overlay_applied, true);
        assert.deepEqual(analysisMeta.request_profile_overlay_keys, ['barrierStatus', 'goals', 'sensitivity', 'skinType']);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: top-level request profile overlay is ephemeral and not persisted', async () => {
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
        const uid = buildTestUid('analysis_request_profile_ephemeral');
        await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            skinType: 'dry',
            sensitivity: 'high',
            goals: ['dehydration'],
            currentRoutine: {
              am: {
                cleanser: 'Cream cleanser',
              },
            },
          })
          .expect(200);

        const bootstrap = await harness.request
          .get('/v1/session/bootstrap')
          .set(headersFor(uid, 'EN'))
          .expect(200);

        const bootstrapPatch = bootstrap.body && bootstrap.body.session_patch && typeof bootstrap.body.session_patch === 'object'
          ? bootstrap.body.session_patch
          : {};
        const bootstrapProfile = bootstrapPatch.profile && typeof bootstrapPatch.profile === 'object'
          ? bootstrapPatch.profile
          : {};

        assert.ok(bootstrapProfile.currentRoutine, 'routine should still persist through the analysis path');
        assert.equal(bootstrapProfile.skinType, null);
        assert.equal(bootstrapProfile.sensitivity, null);
        assert.deepEqual(Array.isArray(bootstrapProfile.goals) ? bootstrapProfile.goals : [], []);
      } finally {
        harness.restore();
      }
    },
  );
});
