const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __resetRouterForTests,
  __setRouterForTests,
  __setTravelPipelineForTests,
  buildSkillRequest,
  extractTravelPlanFromMessage,
  handleChat,
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

  __setTravelPipelineForTests(async () => null);
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

test('handleChat uses travel pipeline and returns env_stress response for complete travel message', async () => {
  let payload = null;
  const fakeResponse = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
    },
  };

  __setTravelPipelineForTests(async (input) => {
    assert.equal(input.message, MESSAGE);
    assert.equal(input.canonicalIntent?.entities?.destination, 'Singapore');
    assert.equal(input.canonicalIntent?.entities?.date_range?.start, '2026-03-13');
    return {
      ok: true,
      assistant_text: 'Live weather travel guidance.',
      env_source: 'weather_api',
      degraded: false,
      env_stress_patch: {
        epi: 68,
        env_source: 'weather_api',
      },
      travel_readiness: {
        destination_context: {
          destination: 'Singapore',
          start_date: '2026-03-13',
          end_date: '2026-03-26',
          env_source: 'weather_api',
          weather_reason: 'weather_api_ok',
        },
        delta_vs_home: {
          summary_tags: ['humid', 'high_uv'],
        },
        forecast_window: [
          {
            date: '2026-03-13',
            temp_low_c: 27,
            temp_high_c: 32,
            condition_text: 'Humid',
          },
        ],
        categorized_kit: [
          {
            id: 'sun_protection',
            title: 'Sun protection',
            preparations: [{ name: 'SPF 50+', detail: 'Reapply every 2 hours outdoors' }],
          },
        ],
        confidence: {
          level: 'high',
          missing_inputs: [],
          improve_by: [],
        },
      },
      travel_skills_version: 'travel_skills_dag_v1',
      travel_skills_trace: [],
      travel_kb_hit: false,
      travel_kb_write_queued: false,
      travel_skill_invocation_matrix: {},
      travel_followup_state: {},
    };
  });
  __setRouterForTests({
    async route() {
      throw new Error('router should not run when travel pipeline handles the request');
    },
  });

  try {
    await handleChat(
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

  assert.equal(fakeResponse.statusCode, 200);
  assert.ok(payload);
  assert.equal(payload.assistant_text, 'Live weather travel guidance.');
  assert.ok(Array.isArray(payload.cards));
  assert.ok(payload.cards.some((card) => card.type === 'travel'));
  const travelCard = payload.cards.find((card) => card.type === 'travel');
  const structured = travelCard.sections.find((section) => section.kind === 'travel_structured');
  assert.equal(structured?.env_payload?.schema_version, 'aurora.ui.env_stress.v1');
  assert.equal(structured?.env_payload?.travel_readiness?.destination_context?.env_source, 'weather_api');
  assert.equal(structured?.env_payload?.travel_readiness?.forecast_window?.[0]?.date, '2026-03-13');
});

test('handleChatStream uses travel pipeline and streams weather-backed travel card for complete travel message', async () => {
  const writes = [];
  const fakeResponse = {
    writeHead() {},
    write(chunk) {
      writes.push(String(chunk));
    },
    end() {},
  };

  __setTravelPipelineForTests(async (input) => {
    assert.equal(input.message, MESSAGE);
    return {
      ok: true,
      assistant_text: 'Live weather travel guidance.',
      env_source: 'weather_api',
      degraded: false,
      env_stress_patch: {
        epi: 68,
        env_source: 'weather_api',
      },
      travel_readiness: {
        destination_context: {
          destination: 'Singapore',
          start_date: '2026-03-13',
          end_date: '2026-03-26',
          env_source: 'weather_api',
        },
        forecast_window: [
          {
            date: '2026-03-13',
            temp_low_c: 27,
            temp_high_c: 32,
            condition_text: 'Humid',
          },
        ],
        categorized_kit: [
          {
            id: 'sun_protection',
            title: 'Sun protection',
            preparations: [{ name: 'SPF 50+', detail: 'Reapply every 2 hours outdoors' }],
          },
        ],
      },
      travel_skills_version: 'travel_skills_dag_v1',
      travel_skills_trace: [],
      travel_kb_hit: false,
      travel_kb_write_queued: false,
      travel_skill_invocation_matrix: {},
      travel_followup_state: {},
    };
  });
  __setRouterForTests({
    async routeStream() {
      throw new Error('router should not run when travel pipeline handles the stream request');
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
        get() {
          return null;
        },
      },
      fakeResponse,
    );
  } finally {
    __resetRouterForTests();
  }

  const output = writes.join('');
  assert.match(output, /event: thinking/);
  assert.match(output, /Checking destination conditions/);
  assert.match(output, /event: result/);
  assert.match(output, /weather_api/);
  assert.match(output, /travel_structured/);
  assert.match(output, /2026-03-13/);
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
