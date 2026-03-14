const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const { __internal: activityRouteInternal } = require('../src/auroraBff/routes/activityRoutes');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

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

function buildHeaders(uid, token = null) {
  return {
    'X-Aurora-UID': uid,
    'X-Trace-ID': `trace_${uid}`,
    'X-Brief-ID': `brief_${uid}`,
    'X-Lang': 'EN',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function buildApp({ authSessionsByToken = null } = {}) {
  const memoryStoreId = require.resolve('../src/auroraBff/memoryStore');
  const authStoreId = require.resolve('../src/auroraBff/authStore');
  const routesId = require.resolve('../src/auroraBff/routes');
  delete require.cache[memoryStoreId];
  delete require.cache[authStoreId];
  delete require.cache[routesId];

  const authStore = require('../src/auroraBff/authStore');
  const originalResolveSessionFromToken = authStore.resolveSessionFromToken;
  if (authSessionsByToken && typeof authSessionsByToken === 'object') {
    authStore.resolveSessionFromToken = async (token) => {
      const key = String(token || '').trim();
      return authSessionsByToken[key] || null;
    };
  }

  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  return {
    app,
    cleanup() {
      authStore.resolveSessionFromToken = originalResolveSessionFromToken;
      delete require.cache[routesId];
      delete require.cache[memoryStoreId];
      delete require.cache[authStoreId];
    },
  };
}

test('/v1/activity: log -> list -> pagination -> filter -> validation', async () => {
  await withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
    },
    async () => {
      const { app, cleanup } = buildApp();
      const uid = `activity_${Date.now()}`;
      const headers = buildHeaders(uid);

      try {
        const events = [
          { event_type: 'chat_started', occurred_at_ms: 1000, payload: { entry: 'home' } },
          { event_type: 'tracker_logged', occurred_at_ms: 2000, payload: { date: '2099-01-01' } },
          { event_type: 'profile_updated', occurred_at_ms: 3000, payload: { fields: ['skinType'] } },
        ];

        for (const evt of events) {
          const resp = await supertest(app).post('/v1/activity/log').set(headers).send(evt).expect(200);
          assert.equal(resp.body?.ok, true);
          assert.equal(typeof resp.body?.activity_id, 'string');
          assert.ok(resp.body.activity_id.length > 0);
        }

        const firstPage = await supertest(app).get('/v1/activity?limit=2').set(headers).expect(200);
        assert.equal(Array.isArray(firstPage.body?.items), true);
        assert.equal(firstPage.body.items.length, 2);
        assert.equal(firstPage.body.items[0]?.event_type, 'profile_updated');
        assert.equal(firstPage.body.items[1]?.event_type, 'tracker_logged');
        assert.equal(typeof firstPage.body?.next_cursor, 'string');
        assert.ok(firstPage.body.next_cursor.length > 0);

        const secondPage = await supertest(app)
          .get(`/v1/activity?limit=2&cursor=${encodeURIComponent(firstPage.body.next_cursor)}`)
          .set(headers)
          .expect(200);
        assert.equal(Array.isArray(secondPage.body?.items), true);
        assert.equal(secondPage.body.items.length, 1);
        assert.equal(secondPage.body.items[0]?.event_type, 'chat_started');
        assert.equal(secondPage.body?.next_cursor, null);

        const filtered = await supertest(app)
          .get('/v1/activity?types=tracker_logged')
          .set(headers)
          .expect(200);
        assert.equal(filtered.body.items.length, 1);
        assert.equal(filtered.body.items[0]?.event_type, 'tracker_logged');

        await supertest(app).get('/v1/activity?limit=999').set(headers).expect(400);
        await supertest(app).get('/v1/activity?cursor=bad_cursor').set(headers).expect(400);
        await supertest(app)
          .post('/v1/activity/log')
          .set(headers)
          .send({ event_type: 'unknown_event_type' })
          .expect(400);
      } finally {
        cleanup();
      }
    },
  );
});

test('/v1/activity: signed-in identity can read both user_id and historical aurora_uid events', async () => {
  await withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
    },
    async () => {
      const token = 'token_activity_login';
      const userId = `user_${Date.now()}`;
      const { app, cleanup } = buildApp({
        authSessionsByToken: {
          [token]: {
            userId,
            email: 'activity-user@example.com',
          },
        },
      });
      const uid = `activity_merge_${Date.now()}`;
      const guestHeaders = buildHeaders(uid);
      const signedHeaders = buildHeaders(uid, token);

      try {
        await supertest(app)
          .post('/v1/activity/log')
          .set(guestHeaders)
          .send({
            event_type: 'chat_started',
            payload: { entry: 'home' },
            occurred_at_ms: 1000,
          })
          .expect(200);

        await supertest(app)
          .post('/v1/activity/log')
          .set(signedHeaders)
          .send({
            event_type: 'profile_updated',
            payload: { fields: ['goals'] },
            occurred_at_ms: 2000,
          })
          .expect(200);

        const resp = await supertest(app).get('/v1/activity?limit=20').set(signedHeaders).expect(200);
        const items = Array.isArray(resp.body?.items) ? resp.body.items : [];
        assert.equal(items.length, 2);
        assert.equal(items[0]?.event_type, 'profile_updated');
        assert.equal(items[1]?.event_type, 'chat_started');
      } finally {
        cleanup();
      }
    },
  );
});

test('/v1/activity: retention=0 path keeps read/write available without database', async () => {
  await withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
    },
    async () => {
      const { app, cleanup } = buildApp();
      const uid = `activity_ret0_${Date.now()}`;
      const headers = buildHeaders(uid);

      try {
        await supertest(app)
          .post('/v1/activity/log')
          .set(headers)
          .send({
            event_type: 'travel_plan_created',
            payload: { destination: 'Tokyo' },
            occurred_at_ms: 12345,
          })
          .expect(200);

        const resp = await supertest(app).get('/v1/activity?limit=5').set(headers).expect(200);
        assert.equal(Array.isArray(resp.body?.items), true);
        assert.equal(resp.body.items.length, 1);
        assert.equal(resp.body.items[0]?.event_type, 'travel_plan_created');
      } finally {
        cleanup();
      }
    },
  );
});

test('/v1/activity/:activity_id returns chat_started detail without persisted snapshot rows', async () => {
  await withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
    },
    async () => {
      const { app, cleanup } = buildApp();
      const uid = `activity_detail_chat_${Date.now()}`;
      const headers = buildHeaders(uid);

      try {
        const logResp = await supertest(app)
          .post('/v1/activity/log')
          .set(headers)
          .send({
            event_type: 'chat_started',
            payload: { title: 'Skin Diagnosis', chip_id: 'chip.start.diagnosis' },
            deeplink: '/chat?chip_id=chip.start.diagnosis',
            occurred_at_ms: 1234,
          })
          .expect(200);

        const detailResp = await supertest(app)
          .get(`/v1/activity/${encodeURIComponent(logResp.body.activity_id)}`)
          .set(headers)
          .expect(200);

        assert.equal(detailResp.body?.detail?.kind, 'chat_started');
        assert.equal(detailResp.body?.detail?.snapshot?.title, 'Skin Diagnosis');
        assert.equal(Array.isArray(detailResp.body?.detail?.actions), true);
        assert.ok(detailResp.body.detail.actions.length >= 1);
      } finally {
        cleanup();
      }
    },
  );
});

test('/v1/activity/:activity_id returns structured detail for profile, tracker, and travel activities', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
    },
    async () => {
      const { app, cleanup } = buildApp();
      const uid = `activity_detail_structured_${Date.now()}`;
      const headers = buildHeaders(uid);

      try {
        await supertest(app)
          .post('/v1/profile/update')
          .set(headers)
          .send({
            skinType: 'combination',
            sensitivity: 'medium',
            barrierStatus: 'stable',
            goals: ['hydration'],
          })
          .expect(200);

        await supertest(app)
          .post('/v1/tracker/log')
          .set(headers)
          .send({
            date: '2099-03-01',
            redness: 2,
            acne: 1,
            hydration: 4,
            notes: 'Skin felt calmer than last week.',
            routine_id: 'routine_alpha',
          })
          .expect(200);

        await supertest(app)
          .post('/v1/travel-plans')
          .set(headers)
          .send({
            destination: 'Tokyo',
            departure_region: 'Shanghai',
            start_date: '2099-04-01',
            end_date: '2099-04-06',
          })
          .expect(200);

        const listResp = await supertest(app).get('/v1/activity?limit=20').set(headers).expect(200);
        const items = Array.isArray(listResp.body?.items) ? listResp.body.items : [];

        const profileItem = items.find((item) => item && item.event_type === 'profile_updated');
        const trackerItem = items.find((item) => item && item.event_type === 'tracker_logged');
        const travelItem = items.find((item) => item && String(item.event_type || '').startsWith('travel_plan_'));
        assert.ok(profileItem);
        assert.ok(trackerItem);
        assert.ok(travelItem);

        const profileDetail = await supertest(app)
          .get(`/v1/activity/${encodeURIComponent(profileItem.activity_id)}`)
          .set(headers)
          .expect(200);
        assert.equal(profileDetail.body?.detail?.kind, 'profile_updated');
        assert.deepEqual(profileDetail.body?.detail?.snapshot?.changed_fields, ['skinType', 'sensitivity', 'barrierStatus', 'goals']);
        assert.equal(profileDetail.body?.detail?.snapshot?.values?.skinType, 'combination');

        const trackerDetail = await supertest(app)
          .get(`/v1/activity/${encodeURIComponent(trackerItem.activity_id)}`)
          .set(headers)
          .expect(200);
        assert.equal(trackerDetail.body?.detail?.kind, 'tracker_logged');
        assert.equal(trackerDetail.body?.detail?.snapshot?.redness, 2);
        assert.equal(trackerDetail.body?.detail?.snapshot?.routine_id, 'routine_alpha');

        const travelDetail = await supertest(app)
          .get(`/v1/activity/${encodeURIComponent(travelItem.activity_id)}`)
          .set(headers)
          .expect(200);
        assert.equal(travelDetail.body?.detail?.kind, 'travel_plan');
        assert.ok(['Tokyo', 'Tokyo, Japan'].includes(travelDetail.body?.detail?.snapshot?.destination));
        assert.equal(travelDetail.body?.detail?.snapshot?.start_date, '2099-04-01');
      } finally {
        cleanup();
      }
    },
  );
});

test('activity detail snapshot helpers normalize concern objects and preserve null ratio', () => {
  const skinSnapshot = activityRouteInternal.buildSkinAnalysisSnapshot({
    item: {
      payload: {},
    },
    artifactRow: {
      artifact_id: 'da_helper',
      artifact_json: {
        concerns: [
          { type: 'dryness', evidence_text: 'Visible dehydration around cheeks' },
          { type: 'barrier_damage' },
        ],
      },
    },
    ingredientPlanRow: null,
    storedSnapshot: null,
  });
  assert.deepEqual(skinSnapshot.concerns, [
    'Visible dehydration around cheeks',
    'Barrier Damage',
  ]);

  const travelSnapshot = activityRouteInternal.buildTravelPlanSnapshot(
    {
      payload: {
        destination: 'Seoul',
        indoor_outdoor_ratio: null,
      },
    },
    null,
  );
  assert.equal(travelSnapshot.indoor_outdoor_ratio, null);
});

test('activity detail helpers route skin analysis continue chat through explicit solution-next-steps action', () => {
  const actions = activityRouteInternal.buildSkinAnalysisActions(
    'EN',
    { activity_id: 'act_skin_1' },
    { artifact_id: 'da_skin_1' },
  );

  const continueChat = Array.isArray(actions)
    ? actions.find((action) => action && action.action_id === 'continue_chat')
    : null;

  assert.ok(continueChat);
  assert.match(String(continueChat.deeplink || ''), /chip_id=chip\.aurora\.next_action\.solution_next_steps/);
  assert.match(String(continueChat.deeplink || ''), /artifact_id=da_skin_1/);
  assert.match(String(continueChat.deeplink || ''), /Do\+not\+ask\+me\+to\+restate\+my\+goals/i);
});
