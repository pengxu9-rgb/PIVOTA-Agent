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

test('/v1/chat routine: empty upstream routine result degrades without 500 when chip.start.routine is used', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_CHAT_SKILL_ROUTER_V2_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', context: {} }));

      try {
        const uid = buildTestUid('routine_empty_upstream_degraded');
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            action: {
              action_id: 'chip.start.routine',
              kind: 'chip',
              data: {
                reply_text: 'Build an AM/PM routine',
                profile_patch: {
                  skinType: 'oily',
                  sensitivity: 'low',
                  barrierStatus: 'healthy',
                  goals: ['pores'],
                },
              },
            },
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.equal(findCard(cards, 'error'), null, 'error card should not be returned');
        const notice = findCard(cards, 'confidence_notice');
        assert.ok(notice, 'confidence_notice should exist');
        assert.equal(notice.payload && notice.payload.reason, 'artifact_missing');
      } finally {
        harness.restore();
      }
    },
  );
});
