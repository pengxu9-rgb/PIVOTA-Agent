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

test('handleChat answers routine-analysis priority follow-up without product-analyze router', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'false',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest({
        headers: {
          'x-aurora-uid': 'routine-followup-user',
          'x-lang': 'CN',
        },
        body: {
          message: '这个分析里最该先改哪一步？',
          language: 'CN',
          session: {
            next_state: 'ROUTINE_REVIEW',
            profile: {
              currentRoutine: JSON.stringify({
                am: [
                  { name: 'Gentle Gel Cleanser', step: 'cleanser' },
                  { name: 'Niacinamide Serum', step: 'serum' },
                  { name: 'Lightweight Moisturizer', step: 'moisturizer' },
                ],
                pm: [
                  { name: 'Gentle Gel Cleanser', step: 'cleanser' },
                  { name: '2% Salicylic Acid Serum', step: 'treatment' },
                ],
              }),
            },
            meta: {
              analysis_contract: { analysis_mode: 'routine_audit_v1' },
              routine_expert: {
                snapshot: { risk_flags: ['缺防晒'] },
                key_issues: [{ id: 'missing_spf', title: 'AM 缺少防晒步骤' }],
              },
            },
          },
        },
      });
      const res = makeResponseCapture();

      __setRouterForTests({
        async route() {
          throw new Error('routine analysis follow-up should not reach skill router');
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      const cards = Array.isArray(res.body?.cards) ? res.body.cards : [];
      assert.equal(cards.some((card) => card.card_type === 'routine_audit_plan'), true);
      assert.match(JSON.stringify(cards), /防晒 SPF|SPF30-50/);
      assert.equal(res.body?.meta?.flags_effective?.skill_router_v2, true);
    },
  );
});

test('handleChat answers vitamin C product-fit alternative follow-up without dupe router', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'false',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest({
        headers: {
          'x-aurora-uid': 'vitc-fit-followup-user',
          'x-lang': 'CN',
        },
        body: {
          message: '那我该买什么替代？',
          language: 'CN',
          session: {
            meta: {
              product_fit_context: {
                product_name: '15% L-AA Vitamin C Serum with Alcohol and Fragrance',
                safety_flags: [],
              },
              pivot_product_fit_context: {
                product_name: '15% L-AA Vitamin C Serum with Alcohol and Fragrance',
                safety_flags: [],
              },
            },
            profile: {
              skinType: 'dry_sensitive',
              sensitivity: 'high',
              preferences: { fragrance_free: true },
            },
          },
        },
      });
      const res = makeResponseCapture();

      __setRouterForTests({
        async route() {
          throw new Error('product-fit alternative follow-up should not reach skill router');
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      const text = JSON.stringify(res.body?.cards || []);
      assert.match(text, /替代方向不要继续追高浓度 L-AA/);
      assert.match(text, /烟酰胺|壬二酸|传明酸/);
      assert.doesNotMatch(text, /请粘贴产品链接|Please share a product link/);
    },
  );
});

test('handleChat answers low-budget beginner routine follow-up without freeform router', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'false',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest({
        headers: {
          'x-aurora-uid': 'low-budget-routine-user',
          'x-lang': 'CN',
        },
        body: {
          message: '哪些产品可以买平价，哪些不用买？',
          language: 'CN',
          session: {
            case_id: 'routine_beginner_dry_low_budget',
            profile: {
              skinType: 'dry',
              sensitivity: 'medium',
              barrierStatus: 'slightly_impaired',
              budget: 'low',
              goals: ['hydration', 'basic_routine'],
            },
          },
        },
      });
      const res = makeResponseCapture();

      __setRouterForTests({
        async route() {
          throw new Error('low-budget routine follow-up should not reach freeform router');
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      const text = JSON.stringify(res.body?.cards || []);
      assert.match(text, /洁面/);
      assert.match(text, /保湿/);
      assert.match(text, /防晒|SPF/);
      assert.match(text, /不用先买|Skip|skip|爽肤水|精华叠加/);
      assert.doesNotMatch(text, /增加预算的是精华|补水喷雾最适合买平价|必须使用补水精华/);
    },
  );
});

test('handleChat keeps missing-SPF routine analysis out of low-budget routine shortcut', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'false',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest({
        headers: {
          'x-aurora-uid': 'missing-spf-routine-user',
          'x-lang': 'CN',
        },
        body: {
          message: '这个分析里最该先改哪一步？',
          language: 'CN',
          session: {
            case_id: 'skin_analysis_routine_only_missing_spf',
            next_state: 'ROUTINE_REVIEW',
            meta: {
              routine_analysis_v2: { enabled: true },
              routine_analysis_legacy_compat: {
                concerns: ['Add a clear AM sunscreen step'],
              },
            },
            profile: {
              skinType: 'combination_oily',
              sensitivity: 'medium',
              budget: 'mid',
              currentRoutine: JSON.stringify({
                am: [
                  { name: 'Gentle Gel Cleanser', step: 'cleanser' },
                  { name: 'Lightweight Moisturizer', step: 'moisturizer' },
                ],
                pm: [
                  { name: 'Gentle Gel Cleanser', step: 'cleanser' },
                  { name: '2% Salicylic Acid Serum', step: 'treatment' },
                ],
              }),
            },
          },
        },
      });
      const res = makeResponseCapture();

      __setRouterForTests({
        async route() {
          throw new Error('missing-SPF routine follow-up should be handled before freeform router');
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      const text = JSON.stringify(res.body?.cards || []);
      assert.match(text, /防晒|SPF/);
      assert.match(text, /缺|加|补/);
      assert.doesNotMatch(text, /从 0 开始先做最小 routine|预算低时先不买/);
    },
  );
});

test('handleChat answers pregnancy retinol low-dose follow-up without freeform router', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'false',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest({
        headers: {
          'x-aurora-uid': 'pregnancy-retinol-followup-user',
          'x-lang': 'CN',
        },
        body: {
          message: '低浓度也不行吗？',
          language: 'CN',
          session: {
            meta: {
              product_fit_context: {
                product_name: 'Retinol Anti-Aging Face Cream',
                safety_flags: ['pregnancy_avoid_retinoids'],
              },
              pivot_product_fit_context: {
                product_name: 'Retinol Anti-Aging Face Cream',
                safety_flags: ['pregnancy_avoid_retinoids'],
              },
            },
            profile: {
              pregnant_or_breastfeeding: true,
              skinType: 'combination_dry',
              sensitivity: 'medium',
            },
          },
        },
      });
      const res = makeResponseCapture();

      __setRouterForTests({
        async route() {
          throw new Error('pregnancy retinol follow-up should not reach skill router');
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      const text = JSON.stringify(res.body?.cards || []);
      assert.match(text, /低浓度也先不要当作安全/);
      assert.match(text, /备孕|怀孕|维 A 类|医生/);
      assert.doesNotMatch(text, /建立耐受的良好开端/);
    },
  );
});

test('handleChat appends orchestration prompt meta for new shopping requests', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest({
        body: {
          message: '有什么适合今晚约会的',
          language: 'CN',
        },
        headers: {
          'x-lang': 'CN',
        },
      });
      const res = makeResponseCapture();

      __setRouterForTests({
        async route() {
          return makeSkillResult();
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.meta.prompt_intent, 'shopping_request');
      assert.equal(res.body.meta.conversation_progress, 'new_request');
      assert.equal(res.body.meta.early_decision, 'delegate_to_decisioning');
      assert.equal(res.body.meta.decision_owner, 'aurora_orchestration');
    },
  );
});

test('handleChat appends orchestration prompt meta for follow-up scenario selection', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
    },
    async () => {
      const { handleChat, __setRouterForTests, __resetRouterForTests } = loadChatRoutesFresh();
      const req = makeRequest({
        body: {
          message: '约会',
          messages: [
            { role: 'user', content: '帮我买一款 serum' },
            { role: 'assistant', content: '你更偏哪种场景？' },
          ],
          language: 'CN',
        },
        headers: {
          'x-lang': 'CN',
        },
      });
      const res = makeResponseCapture();

      __setRouterForTests({
        async route() {
          return makeSkillResult();
        },
      });

      try {
        await handleChat(req, res);
      } finally {
        __resetRouterForTests();
      }

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.meta.prompt_intent, 'follow_up_refinement');
      assert.equal(res.body.meta.conversation_progress, 'follow_up');
      assert.equal(res.body.meta.early_decision, 'resume_prior_goal');
      assert.equal(res.body.meta.decision_owner, 'aurora_orchestration');
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
