const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const recoHybridResolver = require('../src/auroraBff/usecases/recoHybridResolveCandidates');

const routesModuleId = require.resolve('../src/auroraBff/routes');
const chatRoutesModuleId = require.resolve('../src/auroraBff/routes/chat');
const schemasModuleId = require.resolve('../src/auroraBff/schemas');

function resetAuroraModules() {
  delete require.cache[routesModuleId];
  delete require.cache[chatRoutesModuleId];
  delete require.cache[schemasModuleId];
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  resetAuroraModules();
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuroraModules();
  }
}

function createApp() {
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });
  return app;
}

function buildHeaders() {
  return {
    'X-Aurora-UID': 'uid_v1_chat_rollout',
    'X-Trace-ID': 'trace_v1_chat_rollout',
    'X-Brief-ID': 'brief_v1_chat_rollout',
    'X-Lang': 'EN',
  };
}

test('V1ChatRequestSchema accepts optional context on legacy /v1/chat bodies', () => {
  resetAuroraModules();
  const { V1ChatRequestSchema } = require('../src/auroraBff/schemas');
  const parsed = V1ChatRequestSchema.safeParse({
    message: 'what ingredient is best for acne?',
    context: {
      locale: 'en',
      profile: {},
    },
  });

  assert.equal(parsed.success, true);
});

test('V1ChatRequestSchema accepts current frontend action payload shape with id/type aliases', () => {
  resetAuroraModules();
  const { V1ChatRequestSchema } = require('../src/auroraBff/schemas');
  const parsed = V1ChatRequestSchema.safeParse({
    message: 'im oily skin, what product should i use?',
    language: 'EN',
    client_state: { state: 'IDLE_CHAT' },
    action: {
      id: 'chip.start.reco_products',
      type: 'chip.start.reco_products',
      data: {
        reply_text: 'im oily skin, what product should i use?',
        profile_patch: {
          skin_type: 'oily',
        },
      },
    },
  });

  assert.equal(parsed.success, true);
});

test('V1ChatRequestSchema normalizes lowercase and locale language tags for current frontend chat payloads', () => {
  resetAuroraModules();
  const { V1ChatRequestSchema } = require('../src/auroraBff/schemas');
  const parsedEn = V1ChatRequestSchema.safeParse({
    message: 'im oily skin, what product should i use?',
    language: 'en',
  });
  const parsedZh = V1ChatRequestSchema.safeParse({
    message: '我想要适合油皮的产品',
    language: 'zh-CN',
  });

  assert.equal(parsedEn.success, true);
  assert.equal(parsedZh.success, true);
  assert.equal(parsedEn.data.language, 'EN');
  assert.equal(parsedZh.data.language, 'CN');
});

test('extractPrimaryChatRequestMessage falls back to the last user message in messages[] for standard chat payloads', () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const message = __internal.extractPrimaryChatRequestMessage({
    messages: [
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'what sunscreen for oily skin?' },
    ],
    language: 'EN',
  });

  assert.equal(message, 'what sunscreen for oily skin?');
});

test('travel canonical intent preserves Seattle -> Shanghai route and returning date', () => {
  resetAuroraModules();
  const { inferCanonicalIntent } = require('../src/auroraBff/intentCanonical');

  const intent = inferCanonicalIntent({
    message: 'I am taking a 5-day business trip from Seattle to Shanghai next Monday, 2026-04-20, returning 2026-04-24.',
    language: 'EN',
  });

  assert.equal(intent.intent, 'travel_planning');
  assert.equal(intent.entities.departure_region, 'Seattle');
  assert.equal(intent.entities.destination, 'Shanghai');
  assert.deepEqual(intent.entities.date_range, {
    start: '2026-04-20',
    end: '2026-04-24',
  });
});

test('request context profile patch carries travel plan and current routine into main chat profile', () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const patch = __internal.extractProfilePatchFromRequestContextPayload({
    context: {
      profile: {
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'stable',
      },
      travel_plan: {
        destination: 'Shanghai',
        departure_region: 'Seattle',
        start_date: '2026-04-20',
        end_date: '2026-04-24',
      },
      current_routine: {
        am: ['cleanser', 'moisturizer', 'sunscreen'],
        pm: ['cleanser', 'barrier cream'],
      },
    },
  });

  assert.equal(patch.skinType, 'combination');
  assert.equal(patch.travel_plan.destination, 'Shanghai');
  assert.equal(patch.travel_plan.departure_region, 'Seattle');
  assert.equal(patch.travel_plan.end_date, '2026-04-24');
  assert.ok(patch.currentRoutine);
});

test('stripInternalRefsDeep sanitizes shared subtrees and breaks cycles without throwing', () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');
  const shared = {
    answer: 'See kb://internal/doc/123 for context.',
    citations: ['kb://internal/doc/123', 'https://example.com/public-source'],
  };
  const payload = { primary: shared, secondary: shared };
  payload.self = payload;

  const sanitized = __internal.stripInternalRefsDeep(payload);

  assert.equal(typeof sanitized, 'object');
  assert.equal(sanitized.self, null);
  assert.equal(typeof sanitized.primary.answer, 'string');
  assert.deepEqual(sanitized.primary.citations, ['https://example.com/public-source']);
  assert.equal(sanitized.primary, sanitized.secondary);
});

test('GET /v1/session/bootstrap degrades instead of hanging when profile storage read times out', async () => {
  await withEnv(
    {
      AURORA_STORAGE_READ_TIMEOUT_MS: '40',
      AURORA_BOOTSTRAP_ARTIFACT_TIMEOUT_MS: '40',
    },
    async () => {
      const routes = require('../src/auroraBff/routes');
      routes.__internal.__setRouteDependencyOverridesForTest({
        getProfileForIdentity: () => new Promise(() => {}),
        getRecentSkinLogsForIdentity: async () => [],
        loadLatestDiagnosisArtifactForRoute: async () => null,
      });
      try {
        const app = createApp();
        const response = await supertest(app)
          .get('/v1/session/bootstrap')
          .set(buildHeaders())
          .expect(200);

        assert.equal(response.body.cards?.[0]?.type, 'session_bootstrap');
        assert.equal(response.body.cards?.[0]?.payload?.db_ready, false);
        assert.deepEqual(response.body.session_patch?.recent_logs, []);
      } finally {
        routes.__internal.__resetRouteDependencyOverridesForTest();
      }
    },
  );
});

test('POST /v1/profile/update returns a bounded timeout envelope when profile persistence hangs', async () => {
  await withEnv(
    {
      AURORA_STORAGE_WRITE_TIMEOUT_MS: '40',
    },
    async () => {
      const routes = require('../src/auroraBff/routes');
      routes.__internal.__setRouteDependencyOverridesForTest({
        upsertProfileForIdentity: () => new Promise(() => {}),
      });
      try {
        const app = createApp();
        const response = await supertest(app)
          .post('/v1/profile/update')
          .set(buildHeaders())
          .send({ skinType: 'oily' })
          .expect(504);

        assert.equal(response.body.cards?.[0]?.type, 'error');
        assert.equal(response.body.cards?.[0]?.payload?.error, 'PROFILE_UPDATE_TIMEOUT');
        assert.equal(response.body.cards?.[0]?.payload?.code, 'AURORA_PROFILE_UPDATE_TIMEOUT');
      } finally {
        routes.__internal.__resetRouteDependencyOverridesForTest();
      }
    },
  );
});

test('buildSkillRequest normalizes frontend language, camelCase profile fields, and routine slot maps', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      message: 'Recommend a calming mask',
      language: 'CN',
      session: {
        profile: {
          skinType: 'dry',
          goals: ['hydration'],
          budgetTier: '$50',
          currentRoutine: {
            routine_id: 'routine_map_123',
            am: {
              cleanser: 'Gentle Cleanser',
              sunscreen: 'SPF 50',
            },
            pm: {
              moisturizer: 'Barrier Cream',
            },
          },
        },
      },
      messages: [
        { role: 'assistant', content: 'Welcome back.' },
        { role: 'user', content: 'I want something calming.' },
      ],
    },
    headers: {},
  });

  assert.equal(skillRequest.context.locale, 'zh-CN');
  assert.equal(skillRequest.context.profile.skinType, 'dry');
  assert.equal(skillRequest.context.profile.skin_type, 'dry');
  assert.deepEqual(skillRequest.context.profile.goals, ['hydration']);
  assert.deepEqual(skillRequest.context.profile.concerns, ['hydration']);
  assert.equal(skillRequest.context.profile.budget_tier, '$50');
  assert.equal(skillRequest.context.current_routine?.routine_id, 'routine_map_123');
  assert.equal(skillRequest.context.current_routine?.am_steps?.length, 2);
  assert.equal(skillRequest.context.current_routine?.am_steps?.[0]?.products?.[0]?.name, 'Gentle Cleanser');
  assert.equal(skillRequest.context.current_routine?.pm_steps?.length, 1);
  assert.deepEqual(skillRequest.params.messages, [
    { role: 'assistant', content: 'Welcome back.' },
    { role: 'user', content: 'I want something calming.' },
  ]);
});

test('buildSkillRequest derives action params, reply_text, and normalized current routine from session profile', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.action.add_to_routine',
        kind: 'chip',
        data: {
          reply_text: 'Add this to my routine',
          product_anchor: {
            brand: 'Lab Series',
            name: 'Defense Lotion SPF 35',
            product_type: 'sunscreen',
          },
        },
      },
      anchor_product_id: 'prod_123',
      anchor_product_url: 'https://example.com/products/prod_123',
      session: {
        profile: {
          skin_type: 'dry',
          currentRoutine: {
            routine_id: 'routine_123',
            am_steps: [{ step_id: 'am_cleanser', products: [{ name: 'Gentle Cleanser' }] }],
            pm_steps: [{ step_id: 'pm_moisturizer', products: [{ name: 'Barrier Cream' }] }],
          },
        },
      },
    },
    headers: {},
  });

  assert.equal(skillRequest.params.entry_source, 'chip.action.add_to_routine');
  assert.equal(skillRequest.params.message, 'Add this to my routine');
  assert.deepEqual(skillRequest.params.product_anchor, {
    brand: 'Lab Series',
    name: 'Defense Lotion SPF 35',
    product_type: 'sunscreen',
  });
  assert.equal(skillRequest.params.anchor_product_id, 'prod_123');
  assert.equal(skillRequest.params.anchor_product_url, 'https://example.com/products/prod_123');
  assert.equal(skillRequest.context.current_routine?.routine_id, 'routine_123');
  assert.equal(Array.isArray(skillRequest.context.current_routine?.am_steps), true);
  assert.equal(skillRequest.context.current_routine?.am_steps?.length, 1);
});

test('buildSkillRequest lifts session.profile.travel_plan into context.travel_plan with normalized dates', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.start.travel',
        kind: 'chip',
        data: {
          reply_text: 'Open travel plan',
        },
      },
      session: {
        state: 'IDLE_CHAT',
        profile: {
          travel_plan: {
            trip_id: 'trip_tokyo_1',
            destination: 'Tokyo',
            departure_region: 'San Francisco',
            start_date: '2026-03-10',
            end_date: '2026-03-15',
          },
        },
      },
      language: 'EN',
    },
    headers: buildHeaders(),
  });

  assert.equal(skillRequest.params.entry_source, 'chip.start.travel');
  assert.equal(skillRequest.context.travel_plan.destination, 'Tokyo');
  assert.equal(skillRequest.context.travel_plan.start_date, '2026-03-10');
  assert.equal(skillRequest.context.travel_plan.end_date, '2026-03-15');
  assert.deepEqual(skillRequest.context.travel_plan.dates, {
    start: '2026-03-10',
    start_date: '2026-03-10',
    end: '2026-03-15',
    end_date: '2026-03-15',
  });
});

test('buildSkillRequest does not coerce dupe compare chip anchor/targets fallbacks into canonical params', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      skill_id: 'dupe.compare',
      action: {
        action_id: 'chip.action.dupe_compare',
        kind: 'chip',
        data: {
          reply_text: 'Compare these two products',
          anchor: {
            brand: 'Anchor Brand',
            name: 'Anchor Serum',
          },
          targets: [
            { brand: 'Target Brand', name: 'Target Serum' },
          ],
        },
      },
    },
    headers: {},
  });

  assert.equal(skillRequest.params.entry_source, 'chip.action.dupe_compare');
  assert.equal(skillRequest.params.message, 'Compare these two products');
  assert.equal(Object.prototype.hasOwnProperty.call(skillRequest.params, 'product_anchor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(skillRequest.params, 'comparison_targets'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(skillRequest.params, 'anchor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(skillRequest.params, 'targets'), false);
});

test('enrichSkillRequestForCompat hydrates dupe suggest candidate pool when product_anchor is present', async () => {
  resetAuroraModules();
  const { buildSkillRequest, enrichSkillRequestForCompat } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.start.dupes',
        kind: 'chip',
        data: {
          reply_text: 'Find dupes for this cream',
          product_anchor: {
            brand: 'Glow Lab',
            name: 'Barrier Cloud Cream',
            product_id: 'anchor_1',
            candidates: [
              {
                product_id: 'dupe_1',
                brand: 'Budget Lab',
                name: 'Barrier Daily Cream',
              },
            ],
          },
        },
      },
    },
    headers: {},
  });

  const enriched = await enrichSkillRequestForCompat(
    { body: {}, headers: {} },
    skillRequest,
    {
      buildProductInputText: () => 'Glow Lab Barrier Cloud Cream',
      buildRecoAlternativesCandidatePool: () => ([
        {
          product_id: 'dupe_1',
          brand: 'Budget Lab',
          name: 'Barrier Daily Cream',
        },
      ]),
      searchPivotaBackendProducts: async () => ({ ok: true, products: [] }),
    },
  );

  assert.equal(Array.isArray(enriched.params._candidate_pool), true);
  assert.equal(enriched.params._candidate_pool.length, 1);
  assert.equal(enriched.params._candidate_pool[0].product_id, 'dupe_1');
  assert.deepEqual(enriched.params.product_anchor, skillRequest.params.product_anchor);
});

test('enrichSkillRequestForCompat derives URL-based catalog queries for dupe suggest url-only anchors', async () => {
  resetAuroraModules();
  const { buildSkillRequest, enrichSkillRequestForCompat } = require('../src/auroraBff/routes/chat');

  const anchorUrl = 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one';
  const seenQueries = [];
  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.start.dupes',
        kind: 'chip',
        data: {
          reply_text: 'Find dupes for this lotion',
          anchor_product_url: anchorUrl,
          product_anchor: {
            url: anchorUrl,
          },
        },
      },
    },
    headers: {},
  });

  const enriched = await enrichSkillRequestForCompat(
    { body: {}, headers: {} },
    skillRequest,
    {
      buildProductInputText: () => anchorUrl,
      buildRecoAlternativesCandidatePool: () => [],
      searchPivotaBackendProducts: async ({ query }) => {
        seenQueries.push(query);
        if (String(query).toLowerCase().includes('all in one defense lotion moisturizer spf 35')) {
          return {
            ok: true,
            products: [
              {
                product_id: 'dupe_url_1',
                brand: 'Budget Lab',
                name: 'Defense Lotion Alternative',
                url: 'https://example.com/products/defense-lotion-alternative',
              },
            ],
          };
        }
        return { ok: true, products: [] };
      },
    },
  );

  assert.equal(Array.isArray(enriched.params._candidate_pool), true);
  assert.equal(enriched.params._candidate_pool.length, 1);
  assert.equal(enriched.params._candidate_pool[0].product_id, 'dupe_url_1');
  assert.equal(
    seenQueries.some((query) => String(query).toLowerCase().includes('all in one defense lotion moisturizer spf 35')),
    true,
  );
  assert.equal(
    seenQueries.some((query) => String(query).toLowerCase() === 'all in one defense lotion moisturizer spf 35'),
    true,
  );
});

test('enrichSkillRequestForCompat builds category-aware dupe candidate queries without duplicating brand tokens', async () => {
  resetAuroraModules();
  const { buildSkillRequest, enrichSkillRequestForCompat } = require('../src/auroraBff/routes/chat');

  const seenQueries = [];
  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.start.dupes',
        kind: 'chip',
        data: {
          reply_text: 'Find dupes: Nivea Creme',
          product_anchor: {
            brand: 'Nivea',
            name: 'Creme',
            display_name: 'Nivea Creme',
            product_type: 'moisturizer',
          },
        },
      },
    },
    headers: buildHeaders(),
  });

  const enriched = await enrichSkillRequestForCompat(
    {
      body: {
        action: {
          action_id: 'chip.start.dupes',
          kind: 'chip',
          data: {
            reply_text: 'Find dupes: Nivea Creme',
            product_anchor: {
              brand: 'Nivea',
              name: 'Creme',
              display_name: 'Nivea Creme',
              product_type: 'moisturizer',
            },
          },
        },
      },
      headers: buildHeaders(),
      get: () => null,
    },
    skillRequest,
    {
      buildProductInputText: () => 'Nivea Creme',
      buildRecoAlternativesCandidatePool: () => [],
      searchPivotaBackendProducts: async ({ query }) => {
        seenQueries.push(query);
        const normalized = String(query || '').trim().toLowerCase();
        if (
          normalized === 'nivea cream' ||
          normalized === 'nivea moisturizing cream' ||
          normalized === 'nivea creme moisturizer' ||
          normalized === 'nivea moisturizer'
        ) {
          return {
            ok: true,
            products: [
              {
                product_id: 'dupe_nivea_1',
                brand: 'Budget Lab',
                name: 'Barrier Daily Cream',
                url: 'https://example.com/products/barrier-daily-cream',
              },
            ],
          };
        }
        return { ok: true, products: [] };
      },
    },
  );

  assert.equal(Array.isArray(enriched.params._candidate_pool), true);
  assert.equal(enriched.params._candidate_pool.length, 1);
  assert.equal(enriched.params._candidate_pool[0].product_id, 'dupe_nivea_1');
  assert.equal(
    seenQueries.some((query) => String(query).trim().toLowerCase() === 'nivea creme moisturizer'),
    true,
  );
  assert.equal(
    seenQueries.some((query) => String(query).trim().toLowerCase() === 'nivea moisturizer'),
    true,
  );
  assert.equal(
    seenQueries.some((query) => String(query).trim().toLowerCase() === 'nivea cream'),
    true,
  );
  assert.equal(
    seenQueries.some((query) => String(query).trim().toLowerCase() === 'nivea moisturizing cream'),
    true,
  );
  assert.equal(
    seenQueries.some((query) => String(query).trim().toLowerCase() === 'nivea nivea creme'),
    false,
  );
});

test('enrichSkillRequestForCompat does not fall back to reco alternatives when dupe search candidate pool stays empty', async () => {
  resetAuroraModules();
  const { buildSkillRequest, enrichSkillRequestForCompat } = require('../src/auroraBff/routes/chat');

  const anchorUrl = 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one';
  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.start.dupes',
        kind: 'chip',
        data: {
          reply_text: `Find dupes: ${anchorUrl}`,
          anchor_product_url: anchorUrl,
          product_anchor: {
            url: anchorUrl,
          },
        },
      },
      anchor_product_url: anchorUrl,
      session: {
        state: 'IDLE_CHAT',
      },
    },
    headers: buildHeaders(),
  });

  const enriched = await enrichSkillRequestForCompat(
    {
      body: {
        action: {
          action_id: 'chip.start.dupes',
          kind: 'chip',
          data: {
            reply_text: `Find dupes: ${anchorUrl}`,
            product_anchor: { url: anchorUrl },
          },
        },
      },
      headers: buildHeaders(),
      get: () => null,
    },
    skillRequest,
    {
      buildProductInputText: () => anchorUrl,
      buildRecoAlternativesCandidatePool: () => [],
      searchPivotaBackendProducts: async () => ({ ok: true, products: [] }),
      fetchRecoAlternativesForProduct: async () => ({
        ok: true,
        alternatives: [
          {
            kind: 'dupe',
            similarity: 78,
            product: {
              brand: 'Budget Lab',
              name: 'Defense Lotion Alternative',
              url: 'https://example.com/products/defense-lotion-alternative',
            },
            reasons: ['fallback_reco'],
            tradeoffs: ['slightly lighter texture'],
          },
        ],
      }),
    },
  );

  assert.equal(Array.isArray(enriched.params._candidate_pool), false);
  assert.equal(Object.prototype.hasOwnProperty.call(enriched.params, '_candidate_pool'), false);
  assert.equal(enriched.params.product_anchor.url, anchorUrl);
});

test('buildSkillRequest preserves same_as_am routine semantics in current routine context', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      message: 'Optimize my routine',
      context: {
        profile: {
          currentRoutine: {
            routine_id: 'routine_same_as_am',
            am: [
              { step: 'cleanser', product: 'Gentle Cleanser' },
            ],
            pm: 'same_as_am',
          },
        },
      },
    },
    headers: {},
  });

  assert.equal(skillRequest.context.current_routine?.routine_id, 'routine_same_as_am');
  assert.equal(skillRequest.context.current_routine?.am_steps?.length, 1);
  assert.equal(skillRequest.context.current_routine?.pm_steps?.length, 1);
  assert.equal(skillRequest.context.current_routine?.pm_steps?.[0]?.products?.[0]?.name, 'Gentle Cleanser');
});

test('legacy and v2 routine normalization keep the same slot/product semantics for same_as_am payloads', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');
  const { normalizeRoutineInputWithPmShortcut, normalizeRoutineStateValue } = require('../src/auroraBff/routineState');

  const rawRoutine = {
    routine_id: 'routine_parity_same_as_am',
    notes: 'keep it gentle',
    am: [
      { step: 'cleanser', product: 'Gentle Cleanser' },
      { step: 'treatment', product: 'Azelaic Acid 10%' },
    ],
    pm: 'same_as_am',
  };

  const legacyStructured = normalizeRoutineStateValue(
    normalizeRoutineInputWithPmShortcut(rawRoutine),
  ).current_routine_struct;
  const skillRequest = buildSkillRequest({
    body: {
      context: {
        profile: {
          currentRoutine: rawRoutine,
        },
      },
    },
    headers: {},
  });

  const flattenLegacy = (slot) =>
    (Array.isArray(legacyStructured?.[slot]) ? legacyStructured[slot] : []).map((row) => ({
      step: row.step,
      product: row.product,
    }));
  const flattenV2 = (slot) =>
    (Array.isArray(skillRequest.context.current_routine?.[`${slot}_steps`]) ? skillRequest.context.current_routine[`${slot}_steps`] : [])
      .flatMap((step) =>
        (Array.isArray(step?.products) ? step.products : []).map((product) => ({
          step: step.step_id,
          product: product.name,
        })));

  assert.deepEqual(flattenV2('am'), flattenLegacy('am'));
  assert.deepEqual(flattenV2('pm'), flattenLegacy('pm'));
});

test('/v1/chat delegates v2-compatible message+context bodies when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          message: 'what ingredient is best for acne?',
          context: { locale: 'en', profile: {} },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.ok(Array.isArray(response.body.next_actions));
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'text_response'), true);
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'type')), false);
    },
  );
});

test('shouldDelegateV1ChatToV2 keeps anchorless fit-check prompts on the legacy path', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const delegated = await __internal.shouldDelegateV1ChatToV2({
    message: 'Is this toner good for me?',
    language: 'EN',
    session: { state: 'idle' },
  });

  assert.equal(delegated, false);
});

test('shouldDelegateV1ChatToV2 keeps compatibility conflict prompts on the legacy path', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const delegated = await __internal.shouldDelegateV1ChatToV2({
    message: 'Can I use retinol and glycolic acid in the same night?',
    language: 'EN',
    session: { state: 'S7_PRODUCT_RECO' },
  });

  assert.equal(delegated, false);
});

test('shouldDelegateV1ChatToV2 keeps beauty reco free-text on the beauty mainline path', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const delegated = await __internal.shouldDelegateV1ChatToV2({
    message: 'im oily skin, what products should i use?',
    language: 'EN',
    session: {
      state: 'idle',
      profile: {
        skin_type: 'oily',
      },
    },
  });

  assert.equal(delegated, false);
});

test('buildChatIntentContract locks beauty reco free-text before v2 delegation', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: 'im oily skin, what products should i use?',
    language: 'EN',
    session: {
      state: 'idle',
      profile: {
        skin_type: 'oily',
      },
    },
  });

  assert.equal(contract.contract_version, 'chat_intent_v1');
  assert.equal(contract.ownership_domain, 'beauty_mainline');
  assert.equal(contract.request_class, 'beauty_discovery');
  assert.equal(contract.delegate_target, 'beauty_mainline');
  assert.equal(contract.primary_lane, 'beauty_discovery_mainline');
  assert.equal(contract.reply_mode, 'reco_framework');
  assert.equal(contract.should_search, true);
});

test('buildChatIntentContract keeps explicit travel skincare on the travel/weather owner', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');
  const { inferCanonicalIntent } = require('../src/auroraBff/intentCanonical');

  const message = 'I will travel to Paris and need AM/PM weather-aware skincare.';
  const contract = await __internal.buildChatIntentContract({
    message,
    language: 'EN',
    session: {
      state: 'idle',
      profile: {
        skinType: 'dry',
        travel_plan: {
          destination: 'Paris',
          start_date: '2026-02-25',
          end_date: '2026-03-01',
        },
      },
    },
  });

  assert.equal(contract.contract_version, 'chat_intent_v1');
  assert.equal(contract.ownership_domain, 'travel_weather');
  assert.equal(contract.request_class, 'travel_planning');
  assert.equal(contract.delegate_target, 'v1');
  assert.equal(contract.reply_mode, 'travel_weather');
  assert.equal(contract.should_search, false);
  assert.equal(
    __internal.shouldEarlyLockBeautyOwnedChatReco({
      ingressChatIntentContract: {
        contract_version: 'chat_intent_v1',
        ownership_domain: 'beauty_mainline',
        request_class: 'beauty_discovery',
        delegate_target: 'beauty_mainline',
      },
      message,
      canonicalIntent: inferCanonicalIntent({ message, language: 'EN' }),
    }),
    false,
  );
});

test('buildChatIntentContract resolves beauty reco free-text before legacy ingredient runtime checks can hang', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');
  __internal.__setGetBestIngredientReferenceMatchForTest(() => new Promise(() => {}));
  __internal.__setGetBestIngredientSignalMatchForTest(() => new Promise(() => {}));

  try {
    const contract = await Promise.race([
      __internal.buildChatIntentContract({
        message: 'im oily skin, what products should i use?',
        language: 'EN',
        session: {
          state: 'IDLE_CHAT',
          profile: {
            skinType: 'oily',
            goals: ['oil control'],
          },
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('beauty reco contract timeout')), 200)),
    ]);

    assert.equal(contract.ownership_domain, 'beauty_mainline');
    assert.equal(contract.request_class, 'beauty_discovery');
    assert.equal(contract.delegate_target, 'beauty_mainline');
  } finally {
    __internal.__resetGetBestIngredientReferenceMatchForTest();
    __internal.__resetGetBestIngredientSignalMatchForTest();
  }
});

test('buildChatIntentContract locks greasy-by-noon product asks onto the beauty mainline', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: 'My face gets greasy by noon. What skincare product should I use first?',
    language: 'EN',
    session: { state: 'idle' },
  });

  assert.equal(contract.contract_version, 'chat_intent_v1');
  assert.equal(contract.ownership_domain, 'beauty_mainline');
  assert.equal(contract.request_class, 'beauty_discovery');
  assert.equal(contract.delegate_target, 'beauty_mainline');
  assert.equal(contract.should_search, true);
});

test('buildChatIntentContract keeps buy-wording beauty reco asks on the beauty mainline', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: "i'm oily skin. what product should i buy?",
    language: 'EN',
    session: { state: 'idle' },
  });

  assert.equal(contract.contract_version, 'chat_intent_v1');
  assert.equal(contract.ownership_domain, 'beauty_mainline');
  assert.equal(contract.request_class, 'beauty_discovery');
  assert.equal(contract.delegate_target, 'beauty_mainline');
  assert.equal(contract.should_search, true);
});

test('buildChatIntentContract keeps analysis-context next-product followups on the beauty mainline', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: "Given the skin analysis and what I'm already using, what should I add next? I don't want another active.",
    language: 'EN',
    session: {
      state: {
        latest_reco_context: {
          intent: 'reco_products',
          source_detail: 'analysis_handoff',
          trigger_source: 'analysis_handoff',
          context_origin: 'routine_audit_v1',
          primary_target_id: 'adj_pm_cleanser_replace',
          ranked_targets: [
            {
              target_id: 'adj_pm_cleanser_replace',
              target_role: 'primary',
              ingredient_query: 'cleanser',
              resolved_target_step: 'cleanser',
            },
          ],
        },
      },
      profile: {
        skinType: 'dry',
        sensitivity: 'high',
        barrierStatus: 'impaired',
        goals: ['barrier support'],
      },
    },
  });

  assert.equal(contract.contract_version, 'chat_intent_v1');
  assert.equal(contract.ownership_domain, 'beauty_mainline');
  assert.equal(contract.request_class, 'beauty_discovery');
  assert.equal(contract.delegate_target, 'beauty_mainline');
  assert.equal(contract.should_search, true);
});

test('buildChatIntentContract keeps reco context answers with climate constraints on the beauty mainline', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: 'I am in Phoenix with dry heat and high UV, fragrance usually stings, and my budget is about $40. Should the first buy change? Compare the options plainly.',
    language: 'EN',
    session: {
      state: {
        latest_reco_context: {
          intent: 'reco_products',
          source_detail: 'typed_reco',
          trigger_source: 'typed_reco',
          primary_target_id: 'barrier_moisturizer',
          ranked_targets: [{ target_id: 'barrier_moisturizer', target_role: 'primary' }],
        },
      },
      profile: {
        skinType: 'sensitive',
        sensitivity: 'high',
        goals: ['redness support', 'barrier support'],
      },
    },
  });

  assert.equal(contract.contract_version, 'chat_intent_v1');
  assert.equal(contract.ownership_domain, 'beauty_mainline');
  assert.equal(contract.request_class, 'beauty_discovery');
  assert.equal(contract.delegate_target, 'beauty_mainline');
  assert.equal(contract.should_search, true);
  assert.equal(contract.contextual_reco_continuation, true);
});

test('buildChatIntentContract keeps card-comparison followups on reco context instead of compatibility parse', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: 'I use foundation, want less white cast and no greasy slip, and I commute in LA sun. Compare the cards and tell me which one you would start with.',
    language: 'EN',
    session: {
      state: {
        latest_reco_context: {
          intent: 'reco_products',
          source_detail: 'typed_reco',
          trigger_source: 'typed_reco',
          primary_target_id: 'daily_sunscreen_finish_fit',
          ranked_targets: [{ target_id: 'daily_sunscreen_finish_fit', target_role: 'primary' }],
        },
      },
      profile: {
        skinType: 'oily',
        goals: ['sun protection', 'oil control'],
      },
    },
  });

  assert.equal(contract.contract_version, 'chat_intent_v1');
  assert.equal(contract.ownership_domain, 'beauty_mainline');
  assert.equal(contract.request_class, 'beauty_discovery');
  assert.equal(contract.delegate_target, 'beauty_mainline');
  assert.equal(contract.should_search, true);
  assert.equal(contract.contextual_reco_continuation, true);
});

test('shouldEarlyLockBeautyOwnedChatReco locks current frontend beauty reco freeform payloads onto the bounded mainline path', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: 'im oily skin, what products should i use?',
    language: 'EN',
    session: {
      state: 'IDLE_CHAT',
      profile: {
        skinType: 'oily',
        goals: ['oil control'],
      },
    },
    client_state: { state: 'IDLE_CHAT' },
    messages: [{ role: 'user', content: 'im oily skin, what products should i use?' }],
  });

  assert.equal(
    __internal.shouldEarlyLockBeautyOwnedChatReco({
      ingressChatIntentContract: contract,
      normalizedActionPayload: null,
      actionId: '',
      actionLabel: '',
      message: 'im oily skin, what products should i use?',
    }),
    true,
  );
});

test('shouldEarlyLockBeautyOwnedChatReco allows contextual reco continuation even when canonical intent sees weather terms', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');
  const { inferCanonicalIntent } = require('../src/auroraBff/intentCanonical');

  const message = 'I am in Phoenix with dry heat and high UV, fragrance usually stings, and my budget is about $40. Should the first buy change?';

  assert.equal(
    __internal.shouldEarlyLockBeautyOwnedChatReco({
      ingressChatIntentContract: {
        contract_version: 'chat_intent_v1',
        ownership_domain: 'beauty_mainline',
        request_class: 'beauty_discovery',
        delegate_target: 'beauty_mainline',
        contextual_reco_continuation: true,
      },
      message,
      canonicalIntent: inferCanonicalIntent({ message, language: 'EN' }),
    }),
    true,
  );
});

test('shouldEarlyLockBeautyOwnedChatReco does not steal action-driven reco payloads from the chip path', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');

  const contract = await __internal.buildChatIntentContract({
    message: 'im oily skin, what products should i use?',
    language: 'EN',
    action: {
      id: 'chip.start.reco_products',
      type: 'chip.start.reco_products',
      data: {
        reply_text: 'im oily skin, what products should i use?',
        profile_patch: {
          skin_type: 'oily',
        },
      },
    },
    client_state: { state: 'IDLE_CHAT' },
  });

  assert.equal(
    __internal.shouldEarlyLockBeautyOwnedChatReco({
      ingressChatIntentContract: contract,
      normalizedActionPayload: {
        action_id: 'chip.start.reco_products',
        kind: 'action',
        data: {
          reply_text: 'im oily skin, what products should i use?',
        },
      },
      actionId: 'chip.start.reco_products',
      actionLabel: '',
      message: 'im oily skin, what products should i use?',
    }),
    false,
  );
});

test('shouldDelegateV1ChatToV2 keeps reviewed signal terms on the legacy ingredient path', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');
  __internal.__setGetBestIngredientSignalMatchForTest(async (input) => {
    const raw = String(input || '').trim();
    if (raw !== 'Miracle Broth™' && raw !== 'Miracle Broth') return null;
    return {
      signal_bucket: 'marketing_or_blend_signal',
      signal_key: 'miracle_broth',
      display_signal_name: 'Miracle Broth (sea kelp, vitamins, minerals, and other nutrients)',
      raw_token_variants_list: ['Miracle Broth'],
      normalized_token_variants_list: ['miraclebroth'],
    };
  });

  try {
    const delegated = await __internal.shouldDelegateV1ChatToV2({
      message: 'Miracle Broth™',
      language: 'EN',
      session: { state: 'idle' },
    });

    assert.equal(delegated, false);
  } finally {
    __internal.__resetGetBestIngredientSignalMatchForTest();
  }
});

test('shouldDelegateV1ChatToV2 keeps signal-like trademark text on the legacy ingredient path even if signal lookup is unavailable', async () => {
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');
  __internal.__setGetBestIngredientSignalMatchForTest(async () => null);
  __internal.__setGetBestIngredientReferenceMatchForTest(async () => null);

  try {
    const delegated = await __internal.shouldDelegateV1ChatToV2({
      message: 'Miracle Broth™',
      language: 'EN',
      session: { state: 'idle' },
    });

    assert.equal(delegated, false);
  } finally {
    __internal.__resetGetBestIngredientSignalMatchForTest();
    __internal.__resetGetBestIngredientReferenceMatchForTest();
  }
});

test('/v1/chat delegates free-text fit-check with a meaningful product anchor into v2 product verdict cards', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          message: 'Is this suitable for me: The Ordinary Niacinamide 10% + Zinc 1%?',
          language: 'EN',
          session: {
            state: 'IDLE_CHAT',
            profile: {
              skin_type: 'combination',
              sensitivity: 'medium',
            },
          },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'product_verdict'), true);
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'text_response'), false);
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), false);
      assert.ok(Array.isArray(response.body.next_actions));
    },
  );
});

test('/v1/chat keeps bare ingredient alias messages on the legacy ingredient path when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      const routes = require('../src/auroraBff/routes');
      __resetRouterForTests();
      routes.__internal.__setGetBestIngredientReferenceMatchForTest(async (input) => {
        const token = String(input || '').trim();
        if (token !== 'MCI' && token !== 'Methylchloroisothiazolinone') return null;
        return {
          record_id: 'ING-0400',
          normalized_key: 'methylchloroisothiazolinone',
          canonical_inci_name: 'Methylchloroisothiazolinone',
          canonical_display_name: 'Methylchloroisothiazolinone',
          ingredient_family: 'preservative',
          primary_bucket: 'preservative',
          aliases_common_list: ['MCI'],
          deprecated_aliases_list: [],
          benefit_tags_list: ['formula_stability'],
          function_tags_list: ['preservative'],
          risk_flags_list: ['sensitizer'],
          flags: { is_preservative: true },
        };
      });

      try {
        const response = await supertest(createApp())
          .post('/v1/chat')
          .set(buildHeaders())
          .send({
            message: 'MCI',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        assert.ok(Array.isArray(response.body.cards));
        assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), true);
        assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'card_type')), false);

        const report = response.body.cards.find((card) => card && card.type === 'aurora_ingredient_report')?.payload || {};
        assert.equal(report.ingredient?.inci, 'Methylchloroisothiazolinone');
        assert.equal(report.report_state?.reason_code, 'reference_seed_hit');
      } finally {
        routes.__internal.__resetGetBestIngredientReferenceMatchForTest();
      }
    },
  );
});

test('/v1/chat answers dryness questions even when profile says oily', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          message: 'My skin feels dry and tight lately. What should I do?',
          context: {
            locale: 'en',
            profile: { skin_type: 'oily' },
          },
        })
        .expect(200);

      const textAnswer = response.body.cards?.[0]?.sections?.find((section) => section.type === 'text_answer')?.text_en || '';
      assert.equal(response.body.cards?.[0]?.card_type, 'text_response');
      assert.match(textAnswer, /dry|tight|gentle|barrier|hydr/i);
      assert.match(textAnswer, /oily|greasy|occlusive|congest/i);
      assert.doesNotMatch(textAnswer, /cannot assist with dryness because your profile indicates oily skin/i);
    },
  );
});

test('/v1/chat keeps typed skincare reco questions on the v1 framework-first mainline', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const routes = require('../src/auroraBff/routes');
      assert.equal(
        await routes.__internal.shouldDelegateV1ChatToV2({
          message: 'im oily skin, what product should i use?',
          context: {
            locale: 'en',
            profile: {
              skinType: 'oily',
              goals: ['oil control'],
            },
          },
        }),
        false,
      );
      assert.equal(
        routes.__internal.shouldKeepTypedRecoRequestOnV1Mainline({
          message: 'im oily skin, what product should i use?',
          context: {
            locale: 'en',
            profile: {
              skinType: 'oily',
              goals: ['oil control'],
            },
          },
        }),
        true,
      );
      assert.equal(
        routes.__internal.shouldKeepTypedRecoRequestOnV1Mainline({
          action: {
            action_id: 'chip.start.reco_products',
            kind: 'chip',
            data: {
              reply_text: 'im oily skin, what product should i use?',
              profile_patch: {
                skinType: 'oily',
                goals: ['oil control'],
              },
            },
          },
          context: {
            locale: 'en',
          },
        }),
        true,
      );
      assert.equal(
        await routes.__internal.shouldDelegateV1ChatToV2({
          message: 'what sunscreen for oily skin should i use?',
          context: {
            locale: 'en',
            profile: {
              skinType: 'oily',
            },
          },
        }),
        false,
      );
      assert.equal(
        routes.__internal.shouldKeepTypedRecoRequestOnV1Mainline({
          message: 'what products should i use for oily skin?',
          context: {
            locale: 'en',
            profile: {
              skinType: 'oily',
              goals: ['oil control'],
            },
          },
        }),
        true,
      );
      assert.equal(
        await routes.__internal.shouldDelegateV1ChatToV2({
          message: 'what products should i use for oily skin?',
          context: {
            locale: 'en',
            profile: {
              skinType: 'oily',
              goals: ['oil control'],
            },
          },
        }),
        false,
      );
    },
  );
});

test('/v1/chat keeps current frontend reco freeform payload compatible with the v1 mainline request shape', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      const { V1ChatRequestSchema } = require('../src/auroraBff/schemas');
      const routes = require('../src/auroraBff/routes');
      const originalResolve = recoHybridResolver.runRecoHybridResolveCandidates;
      recoHybridResolver.runRecoHybridResolveCandidates = async () => ({
        rows: [
          {
            product_id: 'prod_mask_1',
            merchant_id: 'merchant_mask_1',
            brand: 'Winona',
            name: 'Hydrating Repair Mask',
            reasons: ['Supports hydration and barrier comfort.'],
            match_state: 'exact',
          },
        ],
        recommendation_meta: {
          source_mode: 'llm_catalog_hybrid',
          llm_seed_count: 6,
          exact_match_count: 1,
          fuzzy_match_count: 0,
          unresolved_seed_count: 0,
        },
      });
      __resetRouterForTests();
      try {
        const payload = {
          session: {
            state: 'IDLE_CHAT',
            profile: {
              skinType: 'combination',
              goals: ['hydration', 'brightening'],
              currentRoutine: {
                am: {
                  cleanser: 'Gentle Cleanser',
                  sunscreen: 'SPF 50',
                },
                pm: {
                  moisturizer: 'Barrier Cream',
                },
              },
            },
          },
          message: 'Recommend a facial mask that suits me.',
          language: 'CN',
          client_state: { state: 'IDLE_CHAT' },
          messages: [{ role: 'user', content: 'I want something hydrating.' }],
        };
        const parsed = V1ChatRequestSchema.safeParse(payload);
        assert.equal(parsed.success, true);
        assert.equal(await routes.__internal.shouldDelegateV1ChatToV2(payload), false);

        const response = await supertest(createApp())
          .post('/v1/chat')
          .set({
            ...buildHeaders(),
            'X-Lang': 'CN',
          })
          .send(payload)
          .expect(200);

        assert.equal(response.status, 200);
        assert.equal(response.body?.version, '1.0');
        assert.ok(Array.isArray(response.body?.cards));
        assert.equal(Object.prototype.hasOwnProperty.call(response.body || {}, 'assistant_message'), true);
      } finally {
        recoHybridResolver.runRecoHybridResolveCandidates = originalResolve;
      }
    },
  );
});

test('/v1/chat keeps current frontend action id/type reco payload compatible with the v1 mainline request shape', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      const { V1ChatRequestSchema } = require('../src/auroraBff/schemas');
      const routes = require('../src/auroraBff/routes');
      const originalResolve = recoHybridResolver.runRecoHybridResolveCandidates;
      recoHybridResolver.runRecoHybridResolveCandidates = async () => ({
        rows: [
          {
            product_id: 'prod_oil_control_1',
            merchant_id: 'merchant_oil_control_1',
            brand: 'Fenty Skin',
            name: 'Oil Control Serum',
            reasons: ['Matches oil-control treatment for oily skin.'],
            match_state: 'exact',
          },
        ],
        recommendation_meta: {
          source_mode: 'catalog_grounded',
          exact_match_count: 1,
        },
      });
      __resetRouterForTests();
      try {
        const payload = {
          session: {
            state: 'IDLE_CHAT',
            profile: {
              skinType: 'oily',
              goals: ['oil control'],
            },
          },
          language: 'EN',
          client_state: { state: 'IDLE_CHAT' },
          action: {
            id: 'chip.start.reco_products',
            type: 'chip.start.reco_products',
            data: {
              reply_text: 'im oily skin, what product should i use?',
              profile_patch: {
                skin_type: 'oily',
                goals: ['oil control'],
              },
            },
          },
          messages: [{ role: 'user', content: 'im oily skin, what product should i use?' }],
        };
        const parsed = V1ChatRequestSchema.safeParse(payload);
        assert.equal(parsed.success, true);
        assert.equal(await routes.__internal.shouldDelegateV1ChatToV2(payload), false);

        const response = await supertest(createApp())
          .post('/v1/chat')
          .set(buildHeaders())
          .send(payload)
          .expect(200);

        assert.equal(response.status, 200);
        assert.equal(response.body?.version, '1.0');
        assert.ok(Array.isArray(response.body?.cards));
      } finally {
        recoHybridResolver.runRecoHybridResolveCandidates = originalResolve;
      }
    },
  );
});

test('/v1/chat early-locks freeform beauty reco before identity resolution', async () => {
  await withEnv({}, async () => {
    const routes = require('../src/auroraBff/routes');
    let captured = null;
    routes.__internal.__setRouteDependencyOverridesForTest({
      resolveIdentity: () => new Promise(() => {}),
      maybeHandleBeautyOwnedChatReco: async (args) => {
        captured = args;
        return {
          handled: true,
          envelope: {
            assistant_message: { role: 'assistant', format: 'text', content: 'early beauty lock' },
            suggested_chips: [],
            cards: [],
            session_patch: {},
            events: [],
          },
        };
      },
    });
    try {
      const response = await supertest(createApp())
        .post('/v1/chat')
        .timeout({ deadline: 1500, response: 1500 })
        .set(buildHeaders())
        .send({
          session: {
            state: 'IDLE_CHAT',
            profile: {
              skinType: 'oily',
              goals: ['oil control'],
            },
          },
          message: 'im oily skin, what products should i use?',
          language: 'EN',
          client_state: { state: 'IDLE_CHAT' },
          messages: [{ role: 'user', content: 'im oily skin, what products should i use?' }],
        })
        .expect(200);

      assert.equal(response.status, 200);
      assert.equal(captured?.message, 'im oily skin, what products should i use?');
      assert.equal(captured?.typedRecoOwnershipKeepsV1Mainline, true);
      assert.equal(captured?.profile?.skinType, 'oily');
      assert.deepEqual(captured?.profile?.goals, ['oil control']);
      assert.deepEqual(captured?.recentLogs, []);
    } finally {
      routes.__internal.__resetRouteDependencyOverridesForTest();
    }
  });
});

test('/v1/chat exposes v1-mainline routing headers for beauty reco ingress', async () => {
  await withEnv({}, async () => {
    const routes = require('../src/auroraBff/routes');
    routes.__internal.__setRouteDependencyOverridesForTest({
      resolveIdentity: () => new Promise(() => {}),
      maybeHandleBeautyOwnedChatReco: async () => ({
        handled: true,
        envelope: {
          assistant_message: { role: 'assistant', format: 'text', content: 'debug beauty lock' },
          suggested_chips: [],
          cards: [],
          session_patch: {},
          events: [],
        },
      }),
    });
    try {
      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          message: 'im oily skin. what product should i buy?',
          client_state: 'IDLE_CHAT',
          session: { state: 'idle' },
          context: {
            locale: 'en',
            profile: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
          language: 'EN',
        })
        .expect(200);

      assert.equal(response.headers['x-aurora-chat-handler'], 'v1_mainline');
      assert.equal(response.headers['x-aurora-chat-ingress-delegate-target'], 'beauty_mainline');
      assert.equal(response.headers['x-aurora-chat-ingress-request-class'], 'beauty_discovery');
      assert.equal(response.headers['x-aurora-chat-early-beauty-lock'], 'true');
      assert.equal(response.body?.beauty_expert_v1?.contract_version, 'beauty_expert_v1');
      assert.equal(response.body?.beauty_expert_v1?.delegation_trace?.projection_type, 'aurora_cards');
    } finally {
      routes.__internal.__resetRouteDependencyOverridesForTest();
    }
  });
});

test('/v1/chat early-locks beauty reco action payload before identity resolution', async () => {
  await withEnv({}, async () => {
    const routes = require('../src/auroraBff/routes');
    let captured = null;
    routes.__internal.__setRouteDependencyOverridesForTest({
      resolveIdentity: () => new Promise(() => {}),
      maybeHandleBeautyOwnedChatReco: async (args) => {
        captured = args;
        return {
          handled: true,
          envelope: {
            assistant_message: { role: 'assistant', format: 'text', content: 'early beauty lock action' },
            suggested_chips: [],
            cards: [],
            session_patch: {},
            events: [],
          },
        };
      },
    });
    try {
      const response = await supertest(createApp())
        .post('/v1/chat')
        .timeout({ deadline: 1500, response: 1500 })
        .set(buildHeaders())
        .send({
          session: {
            state: 'IDLE_CHAT',
            profile: {
              skinType: 'combination',
              goals: ['hydration'],
            },
          },
          language: 'EN',
          client_state: { state: 'IDLE_CHAT' },
          action: {
            id: 'chip.start.reco_products',
            type: 'chip.start.reco_products',
            data: {
              reply_text: 'im oily skin, what product should i use?',
              profile_patch: {
                skin_type: 'oily',
                goals: ['oil control'],
              },
            },
          },
          messages: [{ role: 'user', content: 'im oily skin, what product should i use?' }],
        })
        .expect(200);

      assert.equal(response.status, 200);
      assert.equal(captured?.message, 'im oily skin, what products should i use?');
      assert.equal(captured?.actionId, 'chip.start.reco_products');
      assert.equal(captured?.typedRecoOwnershipKeepsV1Mainline, true);
      assert.equal(captured?.profile?.skinType, 'oily');
      assert.deepEqual(captured?.profile?.goals, ['oil control']);
      assert.deepEqual(captured?.recentLogs, []);
    } finally {
      routes.__internal.__resetRouteDependencyOverridesForTest();
    }
  });
});

test('/v1/chat keeps explicit target_step reco requests on the v1 mainline even without profile', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const routes = require('../src/auroraBff/routes');
      assert.equal(
        await routes.__internal.shouldDelegateV1ChatToV2({
          message: 'Recommend a facial mask that suits me.',
          context: { locale: 'en', profile: {} },
        }),
        false,
      );
    },
  );
});

test('/v1/chat delegates chip.action.add_to_routine to v2 when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.action.add_to_routine',
            kind: 'chip',
            data: {
              reply_text: 'Add this to my routine',
              product_anchor: {
                brand: 'Lab Series',
                name: 'Defense Lotion SPF 35',
                product_type: 'sunscreen',
              },
            },
          },
          session: {
            state: 'IDLE_CHAT',
            profile: {
              currentRoutine: {
                routine_id: 'routine_123',
                am_steps: [{ step_id: 'am_cleanser', products: [{ name: 'Gentle Cleanser' }] }],
                pm_steps: [{ step_id: 'pm_moisturizer', products: [{ name: 'Barrier Cream' }] }],
              },
            },
          },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'card_type')), true);
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), false);
      assert.ok(Array.isArray(response.body.next_actions));
    },
  );
});

test('/v1/chat delegates chip.start.ingredients.entry to v2 and returns ingredient_hub in v2 card shape', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.start.ingredients.entry',
            kind: 'chip',
            data: {
              reply_text: 'Open ingredient hub',
              trigger_source: 'chip',
            },
          },
          session: {
            state: 'S6_BUDGET',
          },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'ingredient_hub'), true);
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), false);
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'text_response'), true);
    },
  );
});

test('/v1/chat delegates chip.start.travel to v2 and keeps session travel plan context', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.start.travel',
            kind: 'chip',
            data: {
              reply_text: 'Open travel skincare plan',
              trigger_source: 'chip',
            },
          },
          session: {
            state: 'IDLE_CHAT',
            profile: {
              travel_plan: {
                trip_id: 'trip_tokyo_1',
                destination: 'Tokyo',
                departure_region: 'San Francisco',
                start_date: '2026-03-10',
                end_date: '2026-03-15',
              },
            },
          },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'travel'), true);
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), false);
      assert.ok(Array.isArray(response.body.next_actions));
    },
  );
});

test('/v1/chat delegates chip.action.analyze_product to v2 when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.action.analyze_product',
            kind: 'chip',
            data: {
              reply_text: 'Analyze this product',
              product_anchor: {
                brand: 'Lab Series',
                name: 'Defense Lotion SPF 35',
                product_type: 'sunscreen',
              },
            },
          },
          session: {
            state: 'IDLE_CHAT',
            profile: {
              skin_type: 'dry',
            },
          },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'product_verdict'), true);
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), false);
      assert.ok(Array.isArray(response.body.next_actions));
    },
  );
});

test('/v1/chat delegates chip.action.analyze_product with a url-only product anchor to v2', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.action.analyze_product',
            kind: 'chip',
            data: {
              reply_text: 'Analyze this product',
              anchor_product_url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
              product_anchor: {
                url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
              },
            },
          },
          session: {
            state: 'IDLE_CHAT',
            profile: {
              skin_type: 'dry',
            },
          },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'product_verdict'), true);
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), false);
    },
  );
});

test('/v1/chat delegates chip.start.dupes to v2 and returns the dupe-suggest anchor precondition', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.start.dupes',
            kind: 'chip',
            data: {
              reply_text: 'Find dupes and compare tradeoffs',
            },
          },
        })
        .expect(200);

      assert.equal(response.body.cards?.[0]?.card_type, 'empty_state');
      assert.equal(response.body.cards?.[0]?.sections?.[0]?.message_en, 'No anchor product provided');
      assert.equal(response.body.next_actions?.[0]?.action_type, 'request_input');
      assert.equal(response.body.next_actions?.[0]?.label?.en, 'Please share a product link or name so I can find alternatives.');
    },
  );
});

test('/v1/chat delegates chip.start.dupes with product_anchor into a dupe result instead of the precondition empty state', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.start.dupes',
            kind: 'chip',
            data: {
              reply_text: 'Find dupes for Barrier Cloud Cream',
              product_anchor: {
                brand: 'Glow Lab',
                name: 'Barrier Cloud Cream',
                product_id: 'anchor_1',
                candidates: [
                  {
                    product_id: 'dupe_1',
                    brand: 'Budget Lab',
                    name: 'Barrier Daily Cream',
                    similarity_score: 84,
                  },
                  {
                    product_id: 'dupe_2',
                    brand: 'Calm Lab',
                    name: 'Barrier Water Cream',
                    similarity_score: 76,
                  },
                ],
              },
            },
          },
        })
        .expect(200);

      assert.equal(response.body.cards?.[0]?.card_type, 'dupe_suggest');
      assert.equal(response.body.cards?.[0]?.sections?.[0]?.type, 'dupe_suggest_structured');
      assert.equal(response.body.cards?.[0]?.metadata?.original?.name, 'Barrier Cloud Cream');
      assert.equal(Array.isArray(response.body.cards?.[0]?.metadata?.dupes), true);
    },
  );
});

test('/v1/chat delegates chip.start.dupes with a url-only product anchor into a dupe result when compat search finds candidates', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const routes = require('../src/auroraBff/routes');
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      const originalBuildRecoAlternativesCandidatePool = routes.__internal.buildRecoAlternativesCandidatePool;
      const originalSearchPivotaBackendProducts = routes.__internal.searchPivotaBackendProducts;
      const seenQueries = [];

      routes.__internal.buildRecoAlternativesCandidatePool = () => [];
      routes.__internal.searchPivotaBackendProducts = async ({ query }) => {
        seenQueries.push(query);
        if (String(query).toLowerCase().includes('all in one defense lotion moisturizer spf 35')) {
          return {
            ok: true,
            products: [
              {
                product_id: 'anchor_url_1',
                brand: 'Lab Series',
                name: 'All-In-One Defense Lotion Moisturizer SPF 35',
                url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
              },
              {
                product_id: 'dupe_url_1',
                brand: 'Budget Lab',
                name: 'Defense Lotion Alternative',
                url: 'https://example.com/products/defense-lotion-alternative',
              },
              {
                product_id: 'dupe_url_2',
                brand: 'Calm Lab',
                name: 'Daily Shield Lotion SPF 30',
                url: 'https://example.com/products/daily-shield-lotion-spf-30',
              },
            ],
          };
        }
        return { ok: true, products: [] };
      };

      try {
        __resetRouterForTests();

        const response = await supertest(createApp())
          .post('/v1/chat')
          .set(buildHeaders())
          .send({
            action: {
              action_id: 'chip.start.dupes',
              kind: 'chip',
              data: {
                reply_text: 'Find dupes for this lotion',
                anchor_product_url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
                product_anchor: {
                  url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
                },
              },
            },
          })
          .expect(200);

        assert.equal(response.body.cards?.[0]?.card_type, 'dupe_suggest');
        assert.equal(
          seenQueries.some((query) => String(query).toLowerCase().includes('all in one defense lotion moisturizer spf 35')),
          true,
        );
        assert.equal(
          seenQueries.some((query) => String(query).toLowerCase() === 'all in one defense lotion moisturizer spf 35'),
          true,
        );
      } finally {
        routes.__internal.buildRecoAlternativesCandidatePool = originalBuildRecoAlternativesCandidatePool;
        routes.__internal.searchPivotaBackendProducts = originalSearchPivotaBackendProducts;
        __resetRouterForTests();
      }
    },
  );
});

test('/v1/chat returns an explicit empty state when dupe search stays empty instead of using reco fallback', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const routes = require('../src/auroraBff/routes');
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      const originalBuildRecoAlternativesCandidatePool = routes.__internal.buildRecoAlternativesCandidatePool;
      const originalSearchPivotaBackendProducts = routes.__internal.searchPivotaBackendProducts;
      const originalFetchRecoAlternativesForProduct = routes.__internal.fetchRecoAlternativesForProduct;

      routes.__internal.buildRecoAlternativesCandidatePool = () => [];
      routes.__internal.searchPivotaBackendProducts = async () => ({ ok: true, products: [] });
      routes.__internal.fetchRecoAlternativesForProduct = async () => ({
        ok: true,
        alternatives: [
          {
            kind: 'dupe',
            similarity: 78,
            product: {
              brand: 'Budget Lab',
              name: 'Defense Lotion Alternative',
              url: 'https://example.com/products/defense-lotion-alternative',
            },
            reasons: ['fallback_reco'],
            tradeoffs: ['slightly lighter texture'],
          },
        ],
      });

      try {
        __resetRouterForTests();

        const response = await supertest(createApp())
          .post('/v1/chat')
          .set(buildHeaders())
          .send({
            action: {
              action_id: 'chip.start.dupes',
              kind: 'chip',
              data: {
                reply_text: 'Find dupes for this lotion',
                anchor_product_url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
                product_anchor: {
                  url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
                },
              },
            },
          })
          .expect(200);

        assert.equal(response.body.cards?.[0]?.card_type, 'empty_state');
        assert.equal(response.body.cards?.[0]?.sections?.[0]?.message_en, 'Candidate pool is empty');
      } finally {
        routes.__internal.buildRecoAlternativesCandidatePool = originalBuildRecoAlternativesCandidatePool;
        routes.__internal.searchPivotaBackendProducts = originalSearchPivotaBackendProducts;
        routes.__internal.fetchRecoAlternativesForProduct = originalFetchRecoAlternativesForProduct;
        __resetRouterForTests();
      }
    },
  );
});

test('/v1/chat delegates chip.action.dupe_compare to v2 and rejects non-canonical anchor/targets payloads', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.action.dupe_compare',
            kind: 'chip',
            data: {
              reply_text: 'Compare these two products',
              anchor: {
                brand: 'Anchor Brand',
                name: 'Anchor Serum',
              },
              targets: [
                { brand: 'Target Brand', name: 'Target Serum' },
              ],
            },
          },
        })
        .expect(200);

      assert.equal(response.body.cards?.[0]?.card_type, 'empty_state');
      assert.equal(response.body.cards?.[0]?.sections?.[0]?.message_en, 'No anchor product provided');
      assert.equal(response.body.next_actions?.[0]?.action_type, 'request_input');
      assert.equal(response.body.next_actions?.[0]?.label?.en, 'Please share a product to compare.');
    },
  );
});

test('/v1/chat delegates chip.action.dupe_compare to v2 when canonical compare params are provided', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.action.dupe_compare',
            kind: 'chip',
            data: {
              reply_text: 'Compare these two products',
              product_anchor: {
                brand: 'Anchor Brand',
                name: 'Anchor Serum',
              },
              comparison_targets: [
                { brand: 'Target Brand', name: 'Target Serum' },
              ],
            },
          },
        })
        .expect(200);

      assert.equal(response.body.cards?.[0]?.card_type, 'compatibility');
      assert.equal(response.body.cards?.[0]?.sections?.[0]?.type, 'compatibility_structured');
      assert.equal(response.body.cards?.[0]?.sections?.[0]?.anchor?.name, 'Anchor Serum');
      assert.equal(response.body.cards?.[0]?.sections?.[0]?.comparisons?.[0]?.target?.name, 'Target Serum');
      assert.equal(response.body.next_actions?.[0]?.target_skill_id, 'explore.add_to_routine');
    },
  );
});

test('/v1/chat keeps legacy contract for message+context bodies when skill_router_v2 is disabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_SKILL_ROUTER_V2: 'false',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          message: 'Tell me about niacinamide',
          context: { locale: 'en', profile: {} },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'type')), true);
      assert.equal(Object.prototype.hasOwnProperty.call(response.body, 'next_actions'), false);
      assert.notEqual(String(response.body.assistant_message?.content || '').trim(), 'Invalid request.');
    },
  );
});

test('/v1/chat keeps legacy interactive action/session flows even when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.start.reco_products',
            kind: 'chip',
            data: { reply_text: 'Recommend products now', include_alternatives: false },
          },
          session: { state: 'S2_DIAGNOSIS' },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'type')), true);
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'card_type')), false);
    },
  );
});
