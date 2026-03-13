const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __resetRouterForTests,
  __setRouterForTests,
  __setTravelPipelineForTests,
  buildSkillRequest,
  handleChatStream,
} = require('../src/auroraBff/routes/chat');

test('buildSkillRequest bridges diagnosis direct reco goals into explicit lane and synthesized reco prompt', () => {
  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.start.reco_products',
        kind: 'chip',
        data: {
          trigger_source: 'diagnosis_v2',
          reply_text: 'See product recommendations',
          goal_profile: {
            selected_goals: ['barrier_repair', 'brightening'],
          },
          routine_blueprint: {
            am_steps: ['cleanser', 'sunscreen'],
            pm_steps: ['cleanser', 'serum'],
          },
          force_route: 'reco_products',
        },
      },
      session: { profile: {} },
      language: 'EN',
    },
    headers: {},
  });

  assert.deepEqual(skillRequest.context.profile.goals, ['barrier_repair', 'brightening']);
  assert.deepEqual(skillRequest.context.profile.concerns, ['barrier_repair', 'brightening']);
  assert.deepEqual(skillRequest.params._extracted_concerns, ['barrier_repair', 'brightening']);
  assert.match(String(skillRequest.params.message || ''), /based on my diagnosis/i);
  assert.match(String(skillRequest.params.message || ''), /barrier repair/i);
  assert.match(String(skillRequest.params.message || ''), /brightening/i);
});

test('handleChatStream forwards diagnosis direct reco context to reco.step_based without mutating snapshot state', async () => {
  const writes = [];
  const fakeResponse = {
    writeHead() {},
    write(chunk) {
      writes.push(String(chunk));
    },
    end() {},
  };

  __setTravelPipelineForTests(async () => null);
  __setRouterForTests({
    async routeStream(skillRequest, onEvent) {
      assert.equal(skillRequest.params.entry_source, 'chip.start.reco_products');
      assert.deepEqual(skillRequest.context.profile.goals, ['barrier_repair', 'brightening']);
      assert.deepEqual(skillRequest.params._extracted_concerns, ['barrier_repair', 'brightening']);
      assert.match(String(skillRequest.params.message || ''), /based on my diagnosis/i);
      onEvent({
        type: 'result',
        data: {
          cards: [],
          ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
          quality: {
            schema_valid: true,
            quality_ok: true,
            issues: [],
            preconditions_met: true,
            precondition_failures: [],
          },
          telemetry: {
            call_id: 'call_diag_reco_handoff',
            skill_id: 'reco.step_based',
            skill_version: '2.0.0',
            prompt_hash: 'stub_hash',
            task_mode: 'recommendation',
            elapsed_ms: 0,
            llm_calls: 0,
          },
          next_actions: [],
        },
      });
      return {
        cards: [],
        ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
        quality: { schema_valid: true, quality_ok: true, issues: [], preconditions_met: true, precondition_failures: [] },
        telemetry: { skill_id: 'reco.step_based' },
        next_actions: [],
      };
    },
  });

  try {
    await handleChatStream(
      {
        body: {
          action: {
            action_id: 'chip.start.reco_products',
            kind: 'chip',
            data: {
              trigger_source: 'diagnosis_v2',
              reply_text: 'See product recommendations',
              goal_profile: {
                selected_goals: ['barrier_repair', 'brightening'],
              },
              force_route: 'reco_products',
            },
          },
          session: { profile: {}, meta: {} },
          language: 'EN',
        },
        headers: {},
        get() { return null; },
      },
      fakeResponse,
    );
  } finally {
    __resetRouterForTests();
  }

  const output = writes.join('');
  assert.match(output, /event: result/);
  assert.match(output, /reco\.step_based/);
  assert.match(output, /event: done/);
});
