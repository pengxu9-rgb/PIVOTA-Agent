const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const axios = require('axios');
const { resetVisionMetrics, snapshotVisionMetrics } = require('../src/auroraBff/visionMetrics');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
    'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
    'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
    '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
  'base64',
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function getLabeledCounterValue(entries, expectedLabels) {
  const rows = Array.isArray(entries) ? entries : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const [key, value] = row;
    let labels = null;
    try {
      labels = JSON.parse(key);
    } catch (_err) {
      labels = null;
    }
    if (!labels || typeof labels !== 'object') continue;
    let matched = true;
    for (const [k, v] of Object.entries(expectedLabels || {})) {
      if (String(labels[k]) !== String(v)) {
        matched = false;
        break;
      }
    }
    if (matched) return Number(value) || 0;
  }
  return 0;
}

function buildTestUid(seed) {
  return `uid_fault_${seed}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function headersFor(uid, lang = 'EN') {
  return {
    'X-Aurora-UID': uid,
    'X-Trace-ID': `trace_${uid}`,
    'X-Brief-ID': `brief_${uid}`,
    'X-Lang': lang,
  };
}

function createAppWithPatchedAuroraChat(auroraChatImpl) {
  const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
  delete require.cache[clientModuleId];
  const clientMod = require(clientModuleId);
  const originalAuroraChat = clientMod.auroraChat;
  if (typeof auroraChatImpl === 'function') {
    clientMod.auroraChat = auroraChatImpl;
  }

  const routesModuleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[routesModuleId];
  const routesMod = require(routesModuleId);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  routesMod.mountAuroraBffRoutes(app, { logger: null });
  return {
    app,
    routesMod,
    restore() {
      clientMod.auroraChat = originalAuroraChat;
      delete require.cache[routesModuleId];
      delete require.cache[clientModuleId];
    },
  };
}

function patchPhotoDownloadAxios({
  signedDownloadUrl = 'https://signed-download.test/fault-injection-photo',
  mode = 'ok',
} = {}) {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const originalRequest = axios.request;

  axios.post = originalPost;
  axios.request = originalRequest;
  axios.get = async (url) => {
    const u = String(url || '');
    if (u.endsWith('/photos/download-url')) {
      return {
        status: 200,
        data: {
          download: {
            url: signedDownloadUrl,
            expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
          },
          content_type: 'image/png',
        },
      };
    }
    if (u === signedDownloadUrl) {
      if (mode === 'reset') {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      if (mode === 'timeout') {
        const err = new Error('timeout of 1200ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return {
        status: 200,
        data: PNG_BYTES,
        headers: { 'content-type': 'image/png' },
      };
    }
    throw new Error(`Unexpected axios.get url: ${u}`);
  };

  return () => {
    axios.get = originalGet;
    axios.post = originalPost;
    axios.request = originalRequest;
  };
}

async function seedCompleteProfile(request, uid, lang = 'EN') {
  await request
    .post('/v1/profile/update')
    .set(headersFor(uid, lang))
    .send({
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'healthy',
      goals: ['acne', 'hydration'],
      budgetTier: '$50',
      region: 'US',
    })
    .expect(200);
}

function parseCards(body) {
  return Array.isArray(body && body.cards) ? body.cards : [];
}

function findCard(cards, type) {
  return (Array.isArray(cards) ? cards : []).find((c) => c && c.type === type) || null;
}

test('P0-1 fault injection harness: upstream behaviors are injectable and return structured envelopes', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_BFF_CHAT_RECO_BUDGET_MS: '1000',
    },
    async () => {
      const behaviors = [
        {
          name: 'delay',
          impl: async () => {
            await sleep(1300);
            return { answer: 'slow', intent: 'chat', recommendations: [] };
          },
          expectedReason: 'timeout_degraded',
        },
        {
          name: 'reset',
          impl: async () => {
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            throw err;
          },
          expectedReason: 'timeout_degraded',
        },
        {
          name: 'http_503',
          impl: async () => {
            const err = new Error('Upstream status 503');
            err.status = 503;
            throw err;
          },
          expectedReason: 'artifact_missing',
        },
        {
          name: 'invalid_json_like',
          impl: async () => ({ raw: '<html>invalid</html>' }),
          expectedReason: 'artifact_missing',
        },
        {
          name: 'empty_cards',
          impl: async () => ({ answer: '{}', intent: 'chat', cards: [] }),
          expectedReason: 'artifact_missing',
        },
      ];

      for (const behavior of behaviors) {
        resetVisionMetrics();
        const harness = createAppWithPatchedAuroraChat(behavior.impl);
        try {
          const request = supertest(harness.app);
          const uid = buildTestUid(`p01_${behavior.name}`);
          await seedCompleteProfile(request, uid, 'EN');

          const resp = await request
            .post('/v1/chat')
            .set(headersFor(uid, 'EN'))
            .send({
              message: `recommend products ${behavior.name}`,
              action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
              language: 'EN',
              session: { state: 'idle' },
            })
            .expect(200);

          const cards = parseCards(resp.body);
          assert.ok(cards.length > 0);
          const conf = findCard(cards, 'confidence_notice');
          assert.ok(conf);
          assert.equal(conf.payload && conf.payload.reason, behavior.expectedReason);
        } finally {
          harness.restore();
        }
      }
    },
  );
});

test('P0-2 /v1/analysis/skin timeout -> confidence_notice(timeout_degraded) + actions (no 5xx)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SKIN_VISION_ENABLED: 'true',
      AURORA_SKIN_FORCE_VISION_CALL: 'true',
      AURORA_BFF_ANALYSIS_BUDGET_MS: '1000',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    },
    async () => {
      resetVisionMetrics();
      const restoreAxios = patchPhotoDownloadAxios({ mode: 'ok' });
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: 'ok', intent: 'chat', cards: [] }));
      try {
        harness.routesMod.__internal.__setVisionRunnersForTest({
          gemini: async () => {
            await sleep(1600);
            return {
              ok: true,
              provider: 'gemini',
              analysis: {
                summary: 'slow vision result',
                findings: [],
                confidence: 0.62,
              },
            };
          },
          openai: async () => ({
            ok: true,
            provider: 'openai',
            analysis: { summary: 'unused openai', findings: [], confidence: 0.6 },
          }),
        });

        const request = supertest(harness.app);
        const uid = buildTestUid('p02_timeout');
        const resp = await request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: true,
            currentRoutine: 'AM cleanser + SPF; PM moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_fault_timeout', qc_status: 'passed' }],
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const summary = findCard(cards, 'analysis_summary');
        const conf = findCard(cards, 'confidence_notice');
        assert.ok(summary);
        assert.ok(conf);
        assert.equal(conf.payload && conf.payload.reason, 'timeout_degraded');
        assert.ok(Array.isArray(conf.payload && conf.payload.actions));
        assert.ok((conf.payload.actions || []).length > 0);

        const snap = snapshotVisionMetrics();
        const timeoutHits = getLabeledCounterValue(snap.auroraSkinFlow, {
          stage: 'analysis_timeout_degraded',
          outcome: 'hit',
        });
        assert.ok(timeoutHits >= 1);
      } finally {
        harness.routesMod.__internal.__resetVisionRunnersForTest();
        restoreAxios();
        harness.restore();
      }
    },
  );
});

test('P0-2 /v1/analysis/skin conn reset under strict budget -> confidence_notice(timeout_degraded)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SKIN_VISION_ENABLED: 'true',
      AURORA_SKIN_FORCE_VISION_CALL: 'true',
      AURORA_BFF_ANALYSIS_BUDGET_MS: '1000',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    },
    async () => {
      resetVisionMetrics();
      const restoreAxios = patchPhotoDownloadAxios({ mode: 'ok' });
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: 'ok', intent: 'chat', cards: [] }));
      try {
        harness.routesMod.__internal.__setVisionRunnersForTest({
          gemini: async () => {
            await sleep(1300);
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            throw err;
          },
          openai: async () => {
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            throw err;
          },
        });

        const request = supertest(harness.app);
        const uid = buildTestUid('p02_reset');
        const resp = await request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: true,
            currentRoutine: 'AM cleanser + SPF; PM moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_fault_reset', qc_status: 'passed' }],
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const conf = findCard(cards, 'confidence_notice');
        assert.ok(conf);
        assert.equal(conf.payload && conf.payload.reason, 'timeout_degraded');
        assert.ok(Array.isArray(conf.payload && conf.payload.actions));
      } finally {
        harness.routesMod.__internal.__resetVisionRunnersForTest();
        restoreAxios();
        harness.restore();
      }
    },
  );
});

test('P0-3 /v1/chat reco timeout -> confidence_notice(timeout_degraded) + actions; no empty cards', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_BFF_CHAT_RECO_BUDGET_MS: '1000',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => {
        await sleep(1500);
        return {
          answer: '{}',
          intent: 'chat',
          recommendations: [
            { step: 'Moisturizer', slot: 'pm', sku: { sku_id: 'sku_timeout_1', name: 'Slow Moisturizer' } },
          ],
        };
      });
      try {
        const request = supertest(harness.app);
        const uid = buildTestUid('p03_timeout');
        await seedCompleteProfile(request, uid, 'EN');

        const resp = await request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'please recommend products',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.ok(cards.length > 0);
        const conf = findCard(cards, 'confidence_notice');
        assert.ok(conf);
        assert.equal(conf.payload && conf.payload.reason, 'timeout_degraded');
        assert.ok(Array.isArray(conf.payload && conf.payload.actions));
        assert.ok((conf.payload.actions || []).length > 0);
        assert.equal(Boolean(findCard(cards, 'recommendations')), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('P0-3 /v1/chat reco conn reset -> confidence_notice(timeout_degraded)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_BFF_CHAT_RECO_BUDGET_MS: '1000',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      });
      try {
        const request = supertest(harness.app);
        const uid = buildTestUid('p03_reset');
        await seedCompleteProfile(request, uid, 'EN');

        const resp = await request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'give me recommendation list',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const conf = findCard(cards, 'confidence_notice');
        assert.ok(conf);
        assert.equal(conf.payload && conf.payload.reason, 'timeout_degraded');
        assert.equal(Boolean(findCard(cards, 'recommendations')), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('P0-4 reco upstream empty/invalid output -> guard fallback confidence_notice(artifact_missing) + actions + metric', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_BFF_CHAT_RECO_BUDGET_MS: '1000',
    },
    async () => {
      const variants = [
        { name: 'empty_cards', impl: async () => ({ answer: '{}', intent: 'chat', cards: [] }) },
        { name: 'invalid_schema', impl: async () => ({ answer: '{"foo":1}', intent: 'chat', structured: { foo: 'bar' } }) },
      ];

      for (const variant of variants) {
        resetVisionMetrics();
        const harness = createAppWithPatchedAuroraChat(variant.impl);
        try {
          const request = supertest(harness.app);
          const uid = buildTestUid(`p04_${variant.name}`);
          await seedCompleteProfile(request, uid, 'EN');

          const resp = await request
            .post('/v1/chat')
            .set(headersFor(uid, 'EN'))
            .send({
              message: `reco please ${variant.name}`,
              action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
              language: 'EN',
              session: { state: 'idle' },
            })
            .expect(200);

          const cards = parseCards(resp.body);
          const conf = findCard(cards, 'confidence_notice');
          assert.ok(conf);
          assert.equal(conf.payload && conf.payload.reason, 'artifact_missing');
          assert.ok(Array.isArray(conf.payload && conf.payload.actions));
          assert.ok((conf.payload.actions || []).length > 0);
          assert.equal(Boolean(findCard(cards, 'recommendations')), false);

          const snap = snapshotVisionMetrics();
          const fallbackHits = getLabeledCounterValue(snap.auroraSkinFlow, {
            stage: 'reco_output_guard_fallback',
            outcome: 'hit',
          });
          assert.ok(fallbackHits >= 1);
        } finally {
          harness.restore();
        }
      }
    },
  );
});

test('P0-5 low-confidence path filters treatment/high-irritation recs; empty after filter -> confidence_notice', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    },
    async () => {
      const harnessMixed = createAppWithPatchedAuroraChat(async () => ({
        answer: '{}',
        intent: 'chat',
        structured: {
          recommendations: [
            {
              step: 'Treatment',
              slot: 'pm',
              category: 'treatment',
              notes: ['retinol 0.3%', 'AHA/BHA resurfacing'],
              sku: { sku_id: 'sku_treat_1', name: 'Retinol Treatment' },
            },
            {
              step: 'Moisturizer',
              slot: 'pm',
              category: 'moisturizer',
              notes: ['ceramide barrier support'],
              sku: { sku_id: 'sku_moist_1', name: 'Barrier Cream' },
            },
          ],
          confidence: 0.72,
        },
      }));

      try {
        const request = supertest(harnessMixed.app);
        const uid = buildTestUid('p05_mixed');
        await seedCompleteProfile(request, uid, 'EN');

        const resp = await request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'recommend products now',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const reco = findCard(cards, 'recommendations');
        assert.ok(reco);
        const recs = Array.isArray(reco.payload && reco.payload.recommendations) ? reco.payload.recommendations : [];
        assert.ok(recs.length >= 1);
        const hasTreatment = recs.some((item) => harnessMixed.routesMod.__internal.isTreatmentLikeRecommendationForLowConfidence(item));
        assert.equal(hasTreatment, false);
      } finally {
        harnessMixed.restore();
      }

      const harnessOnlyTreatment = createAppWithPatchedAuroraChat(async () => ({
        answer: '{}',
        intent: 'chat',
        structured: {
          recommendations: [
            {
              step: 'Treatment',
              slot: 'pm',
              category: 'treatment',
              notes: ['retinoid', 'glycolic acid'],
              sku: { sku_id: 'sku_treat_only', name: 'Retinoid Night Peel' },
            },
          ],
          confidence: 0.7,
        },
      }));

      try {
        const request = supertest(harnessOnlyTreatment.app);
        const uid = buildTestUid('p05_empty_after_filter');
        await seedCompleteProfile(request, uid, 'EN');

        const resp = await request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'recommend products now',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const conf = findCard(cards, 'confidence_notice');
        assert.ok(conf);
        assert.equal(conf.payload && conf.payload.reason, 'artifact_missing');
        assert.equal(Boolean(findCard(cards, 'recommendations')), false);
      } finally {
        harnessOnlyTreatment.restore();
      }
    },
  );
});
