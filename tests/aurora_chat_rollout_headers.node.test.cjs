const test = require('node:test');
const assert = require('node:assert/strict');

const CHAT_ROUTES_PATH = require.resolve('../src/auroraBff/routes/chat');

function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch || {})) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

function loadChatRoutesFresh() {
  delete require.cache[CHAT_ROUTES_PATH];
  return require('../src/auroraBff/routes/chat');
}

function makeRequest(overrides = {}) {
  const headers = {
    'x-aurora-uid': 'rollout-user-123',
    'x-lang': 'EN',
    ...(overrides.headers || {}),
  };
  return {
    body: {
      message: 'Travel next week skincare plan please',
      session: { state: 'idle' },
      language: 'EN',
      ...(overrides.body || {}),
    },
    headers,
    get(name) {
      return this.headers[String(name || '').toLowerCase()] || null;
    },
    ...overrides,
  };
}

function makeResponseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

function makeSkillResult() {
  return {
    cards: [
      {
        card_type: 'text_response',
        text: 'Travel mode active.',
      },
    ],
    ops: {
      thread_ops: [],
      profile_patch: {},
      routine_patch: {},
      experiment_events: [
        {
          event: 'skill_executed',
          skill_id: 'travel.apply_mode',
          version: '1.0.0',
        },
      ],
    },
    quality: {
      schema_valid: true,
      quality_ok: true,
      issues: [],
      preconditions_met: true,
      precondition_failures: [],
    },
    telemetry: {
      call_id: 'call_travel_rollout_headers',
      skill_id: 'travel.apply_mode',
      skill_version: '1.0.0',
      prompt_hash: 'stub_hash',
      task_mode: 'travel',
      elapsed_ms: 0,
      llm_calls: 0,
    },
    next_actions: [],
  };
}

test('handleChat adds rollout meta and headers for skill-router responses', async () => {
  await withEnv(
    {
      AURORA_ROLLOUT_ENABLED: 'true',
      AURORA_ROLLOUT_V2_WEATHER_PCT: '100',
      AURORA_ROLLOUT_V2_SAFETY_PCT: '0',
      AURORA_ROLLOUT_V2_CORE_PCT: '0',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'true',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'false',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest();
      const res = makeResponseCapture();

      __setRouterForTests({
        async route(skillRequest) {
          assert.equal(skillRequest.params.message, 'Travel next week skincare plan please');
          return makeSkillResult();
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      assert.ok(res.body);
      assert.equal(res.body.meta.rollout_variant, 'v2_weather');
      assert.match(String(res.body.meta.policy_version || ''), /^aurora_chat_v2_p0$/);
      assert.ok(Number.isInteger(res.body.meta.rollout_bucket));
      assert.ok(res.body.meta.rollout_bucket >= 0 && res.body.meta.rollout_bucket <= 99);
      assert.equal(res.headers['x-aurora-variant'], res.body.meta.rollout_variant);
      assert.equal(Number(res.headers['x-aurora-bucket']), res.body.meta.rollout_bucket);
      assert.equal(res.headers['x-aurora-policy-version'], res.body.meta.policy_version);
    },
  );
});

test('handleChatStream mirrors rollout meta into result envelope', async () => {
  await withEnv(
    {
      AURORA_ROLLOUT_ENABLED: 'true',
      AURORA_ROLLOUT_V2_WEATHER_PCT: '100',
      AURORA_ROLLOUT_V2_SAFETY_PCT: '0',
      AURORA_ROLLOUT_V2_CORE_PCT: '0',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'true',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'false',
    },
    async () => {
      const { handleChatStream, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest();
      const writes = [];
      const res = {
        writeHead() {},
        write(chunk) {
          writes.push(String(chunk));
        },
        end() {},
      };

      __setRouterForTests({
        async routeStream(_skillRequest, onEvent) {
          const result = makeSkillResult();
          onEvent({ type: 'result', data: result });
          return result;
        },
      });

      try {
        await handleChatStream(req, res);
      } finally {
        __resetRouterForTests();
      }

      const resultFrame = writes.find((chunk) => chunk.includes('event: result'));
      assert.ok(resultFrame);
      const jsonLine = resultFrame
        .split('\n')
        .find((line) => line.startsWith('data: '));
      assert.ok(jsonLine);
      const payload = JSON.parse(jsonLine.slice(6));

      assert.equal(payload.meta.rollout_variant, 'v2_weather');
      assert.ok(Number.isInteger(payload.meta.rollout_bucket));
      assert.ok(payload.meta.rollout_bucket >= 0 && payload.meta.rollout_bucket <= 99);
      assert.equal(payload.meta.policy_version, 'aurora_chat_v2_p0');
    },
  );
});
