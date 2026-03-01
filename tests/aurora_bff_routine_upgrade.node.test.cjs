const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sleep,
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  parseCards,
  findCard,
} = require('./aurora_bff_test_harness.cjs');

test('/v1/chat routine: timeout degrades to confidence_notice(timeout_degraded) with routine recovery chips', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_BFF_CHAT_ROUTINE_V2_ENABLED: 'true',
      AURORA_BFF_CHAT_ROUTINE_BUDGET_MS: '1000',
      AURORA_BFF_RECO_ROUTINE_TIMEOUT_MS: '8000',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => {
        await sleep(1600);
        return {
          answer: '{}',
          intent: 'chat',
          recommendations: [
            {
              step: 'Moisturizer',
              slot: 'pm',
              category: 'moisturizer',
              sku: { sku_id: 'sku_timeout_1', name: 'Timeout Cream' },
            },
          ],
        };
      });

      try {
        const uid = buildTestUid('routine_timeout');
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
            session: { state: 'S2_DIAGNOSIS' },
            language: 'EN',
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const notice = findCard(cards, 'confidence_notice');
        assert.ok(notice, 'confidence_notice should exist');
        assert.equal(notice.payload && notice.payload.reason, 'timeout_degraded');

        const chips = Array.isArray(resp.body && resp.body.suggested_chips) ? resp.body.suggested_chips : [];
        const chipIds = chips.map((c) => String(c && c.chip_id ? c.chip_id : ''));
        assert.ok(chipIds.includes('chip.intake.paste_routine'));
        assert.ok(chipIds.includes('chip.start.routine'));
        assert.equal(Boolean(findCard(cards, 'recommendations')), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: returns routine_expert contract when routine intake is provided', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_EXPERT_HARDSTOP_ENABLED: 'true',
      AURORA_ROUTINE_EVIDENCE_REFS_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_expert_contract');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Biotherm Force Cleanser',
                moisturizer: 'Aquasource Hydra Barrier Cream',
              },
              pm: {
                cleanser: 'Biotherm Force Cleanser',
                treatment: 'retinol serum',
                moisturizer: 'Aquasource Hydra Barrier Cream',
              },
              notes: 'Wash feels tight after cleansing; moisturizer stings for 45 seconds.',
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const analysisSummary = findCard(cards, 'analysis_summary');
        assert.ok(analysisSummary, 'analysis_summary should exist');

        const expert =
          analysisSummary &&
          analysisSummary.payload &&
          analysisSummary.payload.analysis &&
          analysisSummary.payload.analysis.routine_expert
            ? analysisSummary.payload.analysis.routine_expert
            : null;
        assert.ok(expert, 'routine_expert should exist');
        assert.equal(expert.contract, 'aurora.routine_expert.v1');
        assert.ok(Array.isArray(expert.key_issues) && expert.key_issues.length > 0);
        assert.equal(String(expert.key_issues[0] && expert.key_issues[0].id), 'hard_stop_cleanser');
        assert.ok(expert.key_issues.some((item) => String(item && item.id) === 'moisturizer_stinging_threshold'));
        assert.ok(expert.plan_7d && Array.isArray(expert.plan_7d.am) && expert.plan_7d.am.length > 0);
        assert.ok(/stop|停用/i.test(String(expert.plan_7d.am[0] || '')));
        assert.ok(
          Array.isArray(expert.plan_7d.pm) &&
            expert.plan_7d.pm.some((line) => /gentle remover|温和卸除|暴力清洁/.test(String(line || ''))),
        );
        assert.ok(expert.phase_plan && Array.isArray(expert.phase_plan.phase_1_14d) && expert.phase_plan.phase_1_14d.length > 0);
        assert.ok(expert.phase_plan && Array.isArray(expert.phase_plan.phase_2_3_6w) && expert.phase_plan.phase_2_3_6w.length > 0);
        assert.ok(Array.isArray(expert.evidence_refs) && expert.evidence_refs.length > 0);
        assert.ok(
          expert.evidence_refs.some((item) =>
            ['biotherm_force_cleanser_micro_particles', 'cleanser_ph_barrier_review'].includes(String(item && item.id)),
          ),
        );
        assert.ok(typeof expert.primary_question === 'string' && expert.primary_question.trim().length > 0);
        assert.ok(Array.isArray(expert.conditional_followups));
        assert.ok(Array.isArray(expert.ask_3_questions) && expert.ask_3_questions.length === 3);
        assert.equal(expert.ask_3_questions[0], expert.primary_question);
      } finally {
        harness.restore();
      }
    },
  );
});
