const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createDiagnosisArtifactFixture,
  seedDiagnosisArtifactForUid,
} = require('./aurora_bff_test_harness.cjs');

function createApp() {
  const moduleIds = [
    require.resolve('../src/auroraBff/routes'),
    require.resolve('../src/auroraBff/memoryStore'),
    require.resolve('../src/auroraBff/diagnosisArtifactStore'),
    require.resolve('../src/auroraBff/activityStore'),
  ];
  for (const id of moduleIds) delete require.cache[id];

  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  return {
    app,
    cleanup() {
      for (const id of moduleIds) delete require.cache[id];
    },
  };
}

function findCardByType(cards, type) {
  return (Array.isArray(cards) ? cards : []).find((item) => item && item.type === type) || null;
}

test('/v1/profile/update -> /v1/session/bootstrap round-trip keeps safety fields', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_PROFILE_V2_ENABLED: 'true',
      AURORA_CHAT_RESPONSE_FORMAT: 'chatcards',
    },
    async () => {
      const { app, cleanup } = createApp();
      const uid = buildTestUid('profile_safety_roundtrip');
      const headers = headersFor(uid, 'EN');

      try {
        await supertest(app)
          .post('/v1/profile/update')
          .set(headers)
          .send({
            skinType: 'combination',
            sensitivity: 'medium',
            barrierStatus: 'stable',
            goals: ['hydration'],
            age_band: 'unknown',
            pregnancy_status: 'trying',
            pregnancy_due_date: '2030-01-02',
            lactation_status: 'unknown',
            high_risk_medications: [],
          })
          .expect(200);

        const bootstrapResp = await supertest(app)
          .get('/v1/session/bootstrap')
          .set(headers)
          .expect(200);
        const bootstrapCard = findCardByType(bootstrapResp.body && bootstrapResp.body.cards, 'session_bootstrap');
        const profile = bootstrapCard && bootstrapCard.payload ? bootstrapCard.payload.profile : null;
        assert.ok(profile);
        assert.equal(profile.age_band, 'unknown');
        assert.equal(profile.pregnancy_status, 'trying');
        assert.equal(profile.pregnancy_due_date, '2030-01-02');
        assert.equal(profile.lactation_status, 'unknown');
        assert.deepEqual(profile.high_risk_medications, []);

        const uidWithoutDueDate = buildTestUid('profile_safety_null');
        const headersWithoutDueDate = headersFor(uidWithoutDueDate, 'EN');
        await supertest(app)
          .post('/v1/profile/update')
          .set(headersWithoutDueDate)
          .send({
            skinType: 'dry',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            goals: ['barrier'],
            age_band: 'unknown',
            pregnancy_status: 'unknown',
            lactation_status: 'unknown',
            high_risk_medications: [],
          })
          .expect(200);
        const bootstrapWithoutDueDate = await supertest(app)
          .get('/v1/session/bootstrap')
          .set(headersWithoutDueDate)
          .expect(200);
        const bootstrapCardWithoutDueDate = findCardByType(
          bootstrapWithoutDueDate.body && bootstrapWithoutDueDate.body.cards,
          'session_bootstrap',
        );
        const profileWithoutDueDate =
          bootstrapCardWithoutDueDate && bootstrapCardWithoutDueDate.payload
            ? bootstrapCardWithoutDueDate.payload.profile
            : null;
        assert.ok(profileWithoutDueDate);
        assert.equal(profileWithoutDueDate.pregnancy_due_date, null);
        assert.deepEqual(profileWithoutDueDate.high_risk_medications, []);
      } finally {
        cleanup();
      }
    },
  );
});

test('/v1/activity/log + /v1/activity list returns explicit events', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_CHAT_RESPONSE_FORMAT: 'chatcards',
    },
    async () => {
      const { app, cleanup } = createApp();
      const uid = buildTestUid('activity_log');
      const headers = headersFor(uid, 'EN');
      try {
        const logResp = await supertest(app)
          .post('/v1/activity/log')
          .set(headers)
          .send({
            event_type: 'chat_started',
            payload: { title: 'Skin Diagnosis' },
            deeplink: '/chat?brief_id=brief_activity_log',
            source: 'test_case',
          })
          .expect(200);
        assert.equal(logResp.body && logResp.body.ok, true);
        assert.equal(typeof (logResp.body && logResp.body.activity_id), 'string');

        const listResp = await supertest(app)
          .get('/v1/activity?limit=10')
          .set(headers)
          .expect(200);
        const items = Array.isArray(listResp.body && listResp.body.items) ? listResp.body.items : [];
        assert.ok(items.length >= 1);
        const chatStarted = items.find((item) => item && item.event_type === 'chat_started');
        assert.ok(chatStarted);
        assert.equal(chatStarted.source, 'test_case');
      } finally {
        cleanup();
      }
    },
  );
});

test('/v1/activity backfills historical skin_analysis from diagnosis artifact', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_CHAT_RESPONSE_FORMAT: 'chatcards',
    },
    async () => {
      const { app, cleanup } = createApp();
      const uid = buildTestUid('activity_backfill');
      const headers = headersFor(uid, 'EN');

      try {
        const artifact = createDiagnosisArtifactFixture({
          confidenceScore: 0.52,
          analysisSource: 'rule_based_with_photo_qc',
          qualityGrade: 'fail',
          usePhoto: true,
        });
        artifact.analysis_context = {
          analysis_source: 'rule_based_with_photo_qc',
          used_photos: false,
          quality_grade: 'fail',
        };
        artifact.photo_input = {
          requested: true,
          provided: true,
          used: false,
          photo_failure_code: 'DOWNLOAD_URL_TIMEOUT',
          photo_notice: 'Photo download timed out',
          quality_grade: 'fail',
          photos_count: 1,
        };
        artifact.photos = [{ slot: 'daylight', photo_id: 'photo_timeout_1', qc_status: 'failed' }];
        await seedDiagnosisArtifactForUid(uid, artifact);

        const listResp = await supertest(app)
          .get('/v1/activity?types=skin_analysis&limit=10')
          .set(headers)
          .expect(200);
        const items = Array.isArray(listResp.body && listResp.body.items) ? listResp.body.items : [];
        assert.ok(items.length >= 1);
        const skinAnalysisItem = items.find((item) => item && item.event_type === 'skin_analysis');
        assert.ok(skinAnalysisItem);
        const payload = skinAnalysisItem.payload && typeof skinAnalysisItem.payload === 'object'
          ? skinAnalysisItem.payload
          : {};
        assert.equal(typeof payload.artifact_id, 'string');
        assert.ok(payload.artifact_id.startsWith('da_'));
        assert.equal(payload.used_photos, false);
        assert.equal(payload.photo_failure_code, 'DOWNLOAD_URL_TIMEOUT');
        assert.equal(payload.quality_grade, 'fail');
      } finally {
        cleanup();
      }
    },
  );
});

test('/v1/analysis/skin success emits skin_analysis activity event', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_CHAT_RESPONSE_FORMAT: 'chatcards',
      AURORA_DIAG_ARTIFACT_ENABLED: 'true',
    },
    async () => {
      const { app, cleanup } = createApp();
      const uid = buildTestUid('analysis_emit_activity');
      const headers = headersFor(uid, 'EN');

      try {
        await supertest(app)
          .post('/v1/analysis/skin')
          .set(headers)
          .send({
            use_photo: false,
            currentRoutine: {
              am: [{ name: 'cleanser' }],
              pm: [{ name: 'moisturizer' }],
            },
          })
          .expect(200);

        const listResp = await supertest(app)
          .get('/v1/activity?types=skin_analysis&limit=10')
          .set(headers)
          .expect(200);
        const items = Array.isArray(listResp.body && listResp.body.items) ? listResp.body.items : [];
        assert.ok(items.length >= 1);
        const emitted = items.find((item) => item && item.event_type === 'skin_analysis');
        assert.ok(emitted);
        const payload = emitted.payload && typeof emitted.payload === 'object' ? emitted.payload : {};
        assert.equal(typeof payload.used_photos, 'boolean');
        assert.equal(typeof payload.photos_provided, 'boolean');
        assert.equal(typeof payload.quality_grade, 'string');
      } finally {
        cleanup();
      }
    },
  );
});
