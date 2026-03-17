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

async function requestRoutine(harness, uid) {
  return harness.request
    .post('/v1/chat')
    .set(headersFor(uid, 'EN'))
    .send({
      action: {
        action_id: 'chip.start.routine',
        kind: 'chip',
        data: {
          reply_text: 'Build an AM/PM skincare routine',
          profile_patch: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            goals: ['barrier'],
          },
        },
      },
      session: { state: 'idle' },
      language: 'EN',
    })
    .expect(200);
}

function assertRoutineRecoResponse(resp, { expectedCount }) {
  const cards = parseCards(resp.body);
  const reco = findCard(cards, 'recommendations');
  assert.ok(reco, 'recommendations card should exist');

  const recommendations = Array.isArray(reco?.payload?.recommendations) ? reco.payload.recommendations : [];
  assert.equal(recommendations.length, expectedCount);
  assert.equal(recommendations.every((row) => String(row?.grounding_status || '').trim().toLowerCase() === 'ungrounded'), true);

  const confidenceNotice = findCard(cards, 'confidence_notice');
  assert.equal(confidenceNotice, null, 'artifact_missing fallback should not be present');

  assert.equal(String(reco?.payload?.grounding_status || ''), 'ungrounded');
  assert.equal(Number(reco?.payload?.grounded_count || 0), 0);
  assert.equal(Number(reco?.payload?.ungrounded_count || 0), expectedCount);
  assert.equal(String(reco?.payload?.mainline_status || ''), 'ungrounded_success');

  const recoEvent = Array.isArray(resp.body?.ops?.experiment_events)
    ? resp.body.ops.experiment_events.find((evt) => evt && evt.event_type === 'recos_requested')
    : null;
  assert.ok(recoEvent, 'recos_requested event should exist');
  assert.equal(String(recoEvent?.event_data?.reason || ''), '');
  assert.equal(String(recoEvent?.event_data?.mainline_status || ''), 'ungrounded_success');
  assert.equal(String(recoEvent?.event_data?.grounding_status || ''), 'ungrounded');
  assert.equal(Number(recoEvent?.event_data?.grounded_count || 0), 0);
  assert.equal(Number(recoEvent?.event_data?.ungrounded_count || 0), expectedCount);
}

test('/v1/chat routine: recommended_routine am_steps/pm_steps survives as editorial recommendations', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({
        answer: 'Mock routine generated.',
        intent: 'routine',
        cards: [],
        context: {
          recommended_routine: {
            am_steps: [{ step: 'cleanser', product: 'Cloud Cleanser' }],
            pm_steps: [{ step: 'moisturizer', product: 'Barrier Cream' }],
          },
        },
      }));

      try {
        const resp = await requestRoutine(harness, buildTestUid('routine_alias_shape'));
        assertRoutineRecoResponse(resp, { expectedCount: 2 });
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/chat routine: context.routine.routine_steps survives as ungrounded routine recommendations', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({
        answer: 'Mock routine generated.',
        intent: 'routine',
        cards: [],
        context: {
          routine: {
            routine_steps: [
              { time: 'am', step_type: 'cleanser', target: 'barrier', cadence: 'daily' },
              { time: 'pm', step_type: 'moisturizer', target: 'repair', cadence: 'daily' },
            ],
          },
        },
      }));

      try {
        const resp = await requestRoutine(harness, buildTestUid('routine_flat_steps'));
        assertRoutineRecoResponse(resp, { expectedCount: 2 });

        const cards = parseCards(resp.body);
        const reco = findCard(cards, 'recommendations');
        const recommendations = Array.isArray(reco?.payload?.recommendations) ? reco.payload.recommendations : [];
        assert.equal(String(recommendations[0]?.slot || ''), 'am');
        assert.equal(String(recommendations[1]?.slot || ''), 'pm');
        assert.equal(String(recommendations[0]?.display_name || recommendations[0]?.name || ''), 'Gentle Cleanser');
        assert.equal(String(recommendations[1]?.display_name || recommendations[1]?.name || ''), 'Repair Moisturizer');
      } finally {
        harness.restore();
      }
    },
  );
});
