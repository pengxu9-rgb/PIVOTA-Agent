const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function buildApp() {
  const memoryStoreId = require.resolve('../src/auroraBff/memoryStore');
  delete require.cache[memoryStoreId];
  const memoryStore = require('../src/auroraBff/memoryStore');
  const { normalizeTravelProfilePatch } = require('../src/auroraBff/travelPlans');
  const profileStore = new Map();
  const keyOf = (identity) => `${String(identity?.auroraUid || '').trim()}::${String(identity?.userId || '').trim()}`;

  memoryStore.getProfileForIdentity = async (identity) => profileStore.get(keyOf(identity)) || null;
  memoryStore.upsertProfileForIdentity = async (identity, patch = {}) => {
    const key = keyOf(identity);
    const current = profileStore.get(key) || {};
    const normalizedPatch = normalizeTravelProfilePatch({ baseProfile: current, patch });
    const next = { ...current, ...(normalizedPatch || {}) };
    profileStore.set(key, next);
    return next;
  };

  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });
  return { app, moduleId, memoryStoreId };
}

function buildHeaders(uid) {
  return {
    'X-Aurora-UID': uid,
    'X-Trace-ID': `trace_${uid}`,
    'X-Brief-ID': `brief_${uid}`,
    'X-Lang': 'EN',
  };
}

test('/v1/travel-plans endpoints are not mounted in current mainline routes', async () => {
  const { app, moduleId, memoryStoreId } = buildApp();
  const uid = `travel_routes_absent_${Date.now()}`;
  const headers = buildHeaders(uid);
  try {
    await supertest(app).get('/v1/travel-plans').set(headers).expect(404);
    await supertest(app).post('/v1/travel-plans').set(headers).send({ destination: 'Tokyo' }).expect(404);
    await supertest(app).patch('/v1/travel-plans/trip_any').set(headers).send({ destination: 'Paris' }).expect(404);
    await supertest(app).post('/v1/travel-plans/trip_any/archive').set(headers).send({}).expect(404);
  } finally {
    delete require.cache[moduleId];
    delete require.cache[memoryStoreId];
  }
});

test('/v1/profile/update continues to accept travel_plans payload', async () => {
  const { app, moduleId, memoryStoreId } = buildApp();
  const uid = `travel_profile_patch_${Date.now()}`;
  const headers = buildHeaders(uid);
  try {
    const resp = await supertest(app)
      .post('/v1/profile/update')
      .set(headers)
      .send({
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'stable',
        goals: ['hydration'],
        travel_plans: [
          {
            destination: 'Tokyo',
            start_date: '2099-03-01',
            end_date: '2099-03-05',
            itinerary: 'Mostly outdoor daytime and one red-eye flight.',
          },
        ],
      })
      .expect(200);

    assert.equal(Boolean(resp.body && typeof resp.body === 'object'), true);
    assert.equal(resp.body?.status || 'ok', 'ok');
  } finally {
    delete require.cache[moduleId];
    delete require.cache[memoryStoreId];
  }
});
