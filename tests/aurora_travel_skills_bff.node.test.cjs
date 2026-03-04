const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

function withEnv(patch, fn) {
  const keys = Object.keys(patch || {});
  const previous = {};
  for (const key of keys) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    const next = patch[key];
    if (next === undefined || next === null) delete process.env[key];
    else process.env[key] = String(next);
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function buildHeaders(uid, suffix = 'a') {
  return {
    'X-Aurora-UID': uid,
    'X-Trace-ID': `trace_${suffix}_${Date.now()}`,
    'X-Brief-ID': `brief_${suffix}_${Date.now()}`,
    'X-Lang': 'EN',
  };
}

async function seedTravelProfile(app, headers, destination = 'Tokyo') {
  const travelPlan = { destination, start_date: '2026-03-10', end_date: '2026-03-15' };
  await supertest(app)
    .post('/v1/profile/update')
    .set(headers)
    .send({
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['hydration'],
      region: 'San Francisco, CA',
      travel_plan: travelPlan,
      travel_plans: [travelPlan],
    })
    .expect(200);
}

test('/v1/chat: travel skills meta fields are attached when DAG path is used', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const headers = buildHeaders(`uid_meta_${Date.now()}`, 'meta');
      await seedTravelProfile(app, headers, 'Cusco');

      const resp = await supertest(app)
        .post('/v1/chat')
        .set(headers)
        .send({
          message: 'How is weather there? Will it be humid?',
          session: { state: 'idle' },
          language: 'EN',
        })
        .expect(200);

      const meta = resp.body?.session_patch?.meta || {};
      assert.equal(meta.travel_skills_version, 'travel_skills_dag_v1');
      assert.equal(Array.isArray(meta.travel_skills_trace), true);
      assert.equal(typeof meta.travel_kb_hit, 'boolean');
      assert.equal(typeof meta.travel_kb_write_queued, 'boolean');
      delete require.cache[routesModuleId];
    },
  );
});

test('/v1/chat: KB meta fields stay populated across repeated travel requests', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'true',
      TRAVEL_KB_WRITE_CONFIDENCE_MIN: '0',
      TRAVEL_KB_WRITE_MAX_IN_FLIGHT: '32',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const travelKbPolicyModuleId = require.resolve('../src/auroraBff/travelKbPolicy');
      delete require.cache[routesModuleId];
      delete require.cache[travelKbPolicyModuleId];
      const travelKbPolicy = require('../src/auroraBff/travelKbPolicy');
      const originalEvaluateTravelKbBackfill = travelKbPolicy.evaluateTravelKbBackfill;
      travelKbPolicy.evaluateTravelKbBackfill = () => ({ eligible: true, reason: 'eligible', confidence_score: 0.98 });

      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const destination = 'Cusco';
        const headers1 = buildHeaders(`uid_kb_first_${Date.now()}`, 'kb1');
        await seedTravelProfile(app, headers1, destination);
        const first = await supertest(app)
          .post('/v1/chat')
          .set(headers1)
          .send({
            message: 'How is weather there? Will it be humid?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);
        const firstMeta = first.body?.session_patch?.meta || {};
        assert.equal(firstMeta.travel_kb_hit, false);
        assert.equal(typeof firstMeta.travel_kb_write_queued, 'boolean');

        await new Promise((resolve) => setTimeout(resolve, 40));

        const headers2 = buildHeaders(`uid_kb_second_${Date.now()}`, 'kb2');
        await seedTravelProfile(app, headers2, destination);
        const second = await supertest(app)
          .post('/v1/chat')
          .set(headers2)
          .send({
            message: 'How is weather there? Will it be humid?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);
        const secondMeta = second.body?.session_patch?.meta || {};
        assert.equal(typeof secondMeta.travel_kb_hit, 'boolean');
        assert.equal(typeof secondMeta.travel_kb_write_queued, 'boolean');
      } finally {
        travelKbPolicy.evaluateTravelKbBackfill = originalEvaluateTravelKbBackfill;
        delete require.cache[routesModuleId];
        delete require.cache[travelKbPolicyModuleId];
      }
    },
  );
});

test('/v1/chat: pipeline ok=false falls back to local weather path', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const contractsModuleId = require.resolve('../src/auroraBff/travelSkills/contracts');
      delete require.cache[routesModuleId];
      delete require.cache[contractsModuleId];
      const contracts = require('../src/auroraBff/travelSkills/contracts');
      const originalRunTravelPipeline = contracts.runTravelPipeline;
      contracts.runTravelPipeline = async () => ({ ok: false, quality_reason: 'core_signals_missing' });

      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = buildHeaders(`uid_fallback_${Date.now()}`, 'fallback');
        await seedTravelProfile(app, headers, 'Tokyo');
        const resp = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            message: 'How is weather there? Will it be humid?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const text = String(resp.body?.assistant_text || '');
        assert.equal(text.length > 0, true);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.equal(cards.some((c) => c && (c.type === 'travel' || c.type === 'env_stress')), true);
        const meta = resp.body?.session_patch?.meta || {};
        assert.equal(meta.env_source, 'local_template');
      } finally {
        contracts.runTravelPipeline = originalRunTravelPipeline;
        delete require.cache[routesModuleId];
        delete require.cache[contractsModuleId];
      }
    },
  );
});

test('/v1/chat: chat context persists travel_followup after identity resolution', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const memoryStoreModuleId = require.resolve('../src/auroraBff/memoryStore');
      delete require.cache[routesModuleId];
      delete require.cache[memoryStoreModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const { getChatContextForIdentity } = require('../src/auroraBff/memoryStore');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const uid = `uid_ctx_${Date.now()}`;
      const headers = buildHeaders(uid, 'ctx');
      await seedTravelProfile(app, headers, 'Tokyo');

      const first = await supertest(app)
        .post('/v1/chat')
        .set(headers)
        .send({
          message: 'How is weather there? Will it be humid?',
          session: { state: 'idle' },
          language: 'EN',
        })
        .expect(200);
      assert.equal(first.body?.session_patch?.meta?.travel_skills_version, 'travel_skills_dag_v1');

      const stored = await getChatContextForIdentity({ auroraUid: uid, userId: null });
      assert.equal(Boolean(stored), true);
      assert.equal(Boolean(stored && stored.travel_followup && typeof stored.travel_followup === 'object'), true);

      const second = await supertest(app)
        .post('/v1/chat')
        .set(headers)
        .send({
          message: 'What about flight day strategy?',
          session: { state: 'idle' },
          language: 'EN',
        })
        .expect(200);
      assert.equal(String(second.body?.assistant_text || '').length > 0, true);

      delete require.cache[routesModuleId];
      delete require.cache[memoryStoreModuleId];
    },
  );
});
