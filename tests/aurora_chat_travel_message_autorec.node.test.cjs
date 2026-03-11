const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __resetRouterForTests,
  __setRouterForTests,
  buildSkillRequest,
  extractTravelPlanFromMessage,
  handleChatStream,
} = require('../src/auroraBff/routes/chat');
const { SkillRouter } = require('../src/auroraBff/orchestrator/skill_router');
const TravelApplyModeSkill = require('../src/auroraBff/skills/travel_apply_mode');

const MESSAGE = 'Please adjust my skincare based on this travel plan. Destination: Singapore. Dates: 2026-03-13 to 2026-03-26.';
const EXPECTED_PLAN = {
  destination: 'Singapore',
  start_date: '2026-03-13',
  end_date: '2026-03-26',
  dates: '2026-03-13 to 2026-03-26',
};

test('extractTravelPlanFromMessage parses canonical create-new-plan text', () => {
  assert.deepEqual(extractTravelPlanFromMessage(MESSAGE), EXPECTED_PLAN);
});

test('buildSkillRequest auto-populates context and thread_state travel_plan from message-only payload', () => {
  const skillRequest = buildSkillRequest({
    body: {
      session: { state: 'idle' },
      client_state: 'IDLE_CHAT',
      language: 'EN',
      message: MESSAGE,
      messages: [{ role: 'assistant', content: 'Hi there' }],
    },
    headers: {},
  });

  assert.deepEqual(skillRequest.context.travel_plan, EXPECTED_PLAN);
  assert.deepEqual(skillRequest.thread_state.travel_plan, EXPECTED_PLAN);
});

test('handleChatStream forwards create-new-plan payload as structured travel_plan', async () => {
  const writes = [];
  const fakeResponse = {
    writeHead() {},
    write(chunk) {
      writes.push(String(chunk));
    },
    end() {},
  };
  const fakeResult = {
    cards: [{ card_type: 'travel', sections: [{ type: 'travel_structured', ...EXPECTED_PLAN, climate: 'humid', adjustments: [], packing_list: [] }] }],
    ops: {
      thread_ops: [{ op: 'set', key: 'travel_plan', value: EXPECTED_PLAN }],
      profile_patch: {},
      routine_patch: {},
      experiment_events: [],
    },
    quality: {
      schema_valid: true,
      quality_ok: true,
      issues: [],
      preconditions_met: true,
      precondition_failures: [],
    },
    telemetry: {
      call_id: 'call_travel_stream',
      skill_id: 'travel.apply_mode',
      skill_version: '1.0.0',
      prompt_hash: 'stub_hash',
      task_mode: 'travel',
      elapsed_ms: 0,
      llm_calls: 0,
    },
    next_actions: [],
  };

  __setRouterForTests({
    async routeStream(skillRequest, onEvent) {
      assert.deepEqual(skillRequest.context.travel_plan, EXPECTED_PLAN);
      assert.deepEqual(skillRequest.thread_state.travel_plan, EXPECTED_PLAN);
      onEvent({ type: 'result', data: fakeResult });
      return fakeResult;
    },
  });

  try {
    await handleChatStream(
      {
        body: {
          session: { state: 'idle' },
          client_state: 'IDLE_CHAT',
          language: 'EN',
          message: MESSAGE,
          messages: [{ role: 'assistant', content: 'Hi there' }],
        },
        headers: {},
      },
      fakeResponse,
    );
  } finally {
    __resetRouterForTests();
  }

  const output = writes.join('');
  assert.match(output, /event: result/);
  assert.match(output, /travel\.apply_mode/);
  assert.match(output, /Singapore/);
  assert.match(output, /event: done/);
});

test('SkillRouter short-circuits complete travel-plan messages into travel.apply_mode', async () => {
  const router = new SkillRouter({
    async call() {
      return {
        parsed: {
          uv_level: 'high',
          humidity: 'high',
          reduce_irritation: false,
          packing_list: ['sunscreen'],
          inferred_climate: 'humid',
        },
        promptHash: 'travel_prompt_hash',
      };
    },
  });

  router._classifyIntent = async () => {
    throw new Error('classifier should not run for deterministic travel-plan routing');
  };

  const result = await router.route({
    skill_id: null,
    intent: null,
    params: { user_message: MESSAGE },
    context: {
      profile: {},
      travel_plan: EXPECTED_PLAN,
      current_routine: null,
      inventory: [],
      locale: 'en',
      safety_flags: [],
    },
    thread_state: {
      travel_plan: EXPECTED_PLAN,
    },
  });

  assert.equal(result.telemetry.skill_id, 'travel.apply_mode');
  assert.equal(result.cards[0]?.card_type, 'travel');
});

test('travel_apply_mode accepts start_date and end_date without legacy dates field', async () => {
  const skill = new TravelApplyModeSkill();
  const gateway = {
    async call() {
      return {
        parsed: {
          uv_level: 'high',
          humidity: 'high',
          reduce_irritation: false,
          packing_list: ['sunscreen'],
          inferred_climate: 'humid',
        },
        promptHash: 'travel_prompt_hash',
      };
    },
  };

  const response = await skill.run(
    {
      skill_id: 'travel.apply_mode',
      context: {
        profile: {},
        recent_logs: [],
        travel_plan: {
          destination: 'Singapore',
          start_date: '2026-03-13',
          end_date: '2026-03-26',
        },
        current_routine: null,
        inventory: [],
        locale: 'en',
        safety_flags: [],
      },
      params: {},
      thread_state: {},
    },
    gateway,
  );

  const section = response.cards[0].sections.find((item) => item.type === 'travel_structured');
  assert.equal(section?.dates, '2026-03-13 to 2026-03-26');
  assert.equal(section?.env_payload?.schema_version, 'aurora.ui.env_stress.v1');
  assert.equal(section?.env_payload?.travel_readiness?.destination_context?.destination, 'Singapore');
  assert.ok(Array.isArray(section?.env_payload?.travel_readiness?.categorized_kit));
  assert.ok(section?.env_payload?.travel_readiness?.categorized_kit?.length > 0);
  assert.ok(
    response.ops.thread_ops.some(
      (op) => op.key === 'travel_plan' && op.value?.dates === '2026-03-13 to 2026-03-26',
    ),
  );
});
