const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function buildPlaceRow({
  name,
  latitude,
  longitude,
  country = 'Japan',
  country_code = 'JP',
  admin1 = name,
  timezone = 'Asia/Tokyo',
  population = 1000000,
  feature_code = 'PPLA',
}) {
  return {
    name,
    latitude,
    longitude,
    country,
    country_code,
    admin1,
    timezone,
    population,
    feature_code,
  };
}

function buildDestinationResolverFetch(overrides = {}) {
  const defaultRows = {
    Tokyo: [
      buildPlaceRow({
        name: 'Tokyo',
        latitude: 35.6895,
        longitude: 139.69171,
        population: 13929286,
        feature_code: 'PPLC',
      }),
    ],
    Osaka: [
      buildPlaceRow({
        name: 'Osaka',
        latitude: 34.6937,
        longitude: 135.5023,
        population: 2691000,
      }),
    ],
    'Osaka, JP': [
      buildPlaceRow({
        name: 'Osaka',
        latitude: 34.6937,
        longitude: 135.5023,
        population: 2691000,
      }),
    ],
    Seoul: [
      {
        name: 'Seoul',
        latitude: 37.5665,
        longitude: 126.978,
        country: 'South Korea',
        country_code: 'KR',
        admin1: 'Seoul',
        timezone: 'Asia/Seoul',
        population: 9498000,
        feature_code: 'PPLC',
      },
    ],
  };
  const lookup = { ...defaultRows, ...overrides };

  return async (url) => {
    const parsed = new URL(String(url));
    if (!parsed.hostname.includes('geocoding-api.open-meteo.com')) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const query = parsed.searchParams.get('name') || '';
    const rows = Object.prototype.hasOwnProperty.call(lookup, query) ? lookup[query] : [];
    return jsonResponse({ results: rows });
  };
}

async function withMockFetch(fetchImpl, fn) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

function buildApp() {
  const memoryStoreId = require.resolve('../src/auroraBff/memoryStore');
  delete require.cache[memoryStoreId];
  const memoryStore = require('../src/auroraBff/memoryStore');
  const { normalizeTravelProfilePatch } = require('../src/auroraBff/travelPlans');
  const profileStore = new Map();
  const keyOf = (identity) => `${String(identity?.auroraUid || '').trim()}::${String(identity?.userId || '').trim()}`;

  memoryStore.getProfileForIdentity = async (identity) => {
    return profileStore.get(keyOf(identity)) || null;
  };

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

test('/v1/travel-plans: create -> list -> archive flow', async () => {
  await withMockFetch(buildDestinationResolverFetch(), async () => {
    const { app, moduleId, memoryStoreId } = buildApp();
    const uid = `travel_flow_${Date.now()}`;
    const headers = buildHeaders(uid);
    try {
      const createResp = await supertest(app)
        .post('/v1/travel-plans')
        .set(headers)
        .send({
          destination: 'Tokyo',
          start_date: '2099-03-01',
          end_date: '2099-03-05',
          indoor_outdoor_ratio: 0.4,
          itinerary: 'Mostly outdoor daytime and one red-eye flight.',
        })
        .expect(200);

      const createdPlan = createResp.body?.plan;
      assert.ok(createdPlan);
      assert.equal(createdPlan.destination, 'Tokyo, Japan');
      assert.equal(createdPlan.destination_place?.canonical_name, 'Tokyo');
      assert.equal(createdPlan.destination_place?.country_code, 'JP');
      assert.equal(createdPlan.status, 'upcoming');
      assert.equal(typeof createdPlan.trip_id, 'string');
      assert.ok(createdPlan.trip_id.length > 0);

      const tripId = createdPlan.trip_id;

      const listResp = await supertest(app).get('/v1/travel-plans').set(headers).expect(200);
      const listPlans = Array.isArray(listResp.body?.plans) ? listResp.body.plans : [];
      assert.ok(listPlans.some((plan) => plan && plan.trip_id === tripId));

      await supertest(app).post(`/v1/travel-plans/${encodeURIComponent(tripId)}/archive`).set(headers).send({}).expect(200);

      const listDefaultResp = await supertest(app).get('/v1/travel-plans').set(headers).expect(200);
      const listDefault = Array.isArray(listDefaultResp.body?.plans) ? listDefaultResp.body.plans : [];
      assert.equal(listDefault.some((plan) => plan && plan.trip_id === tripId), false);

      const listWithArchivedResp = await supertest(app)
        .get('/v1/travel-plans?include_archived=true')
        .set(headers)
        .expect(200);
      const listWithArchived = Array.isArray(listWithArchivedResp.body?.plans) ? listWithArchivedResp.body.plans : [];
      const archivedPlan = listWithArchived.find((plan) => plan && plan.trip_id === tripId);
      assert.ok(archivedPlan);
      assert.equal(archivedPlan.status, 'archived');
      assert.ok(Number(listWithArchivedResp.body?.summary?.counts?.archived || 0) >= 1);
    } finally {
      delete require.cache[moduleId];
      delete require.cache[memoryStoreId];
    }
  });
});

test('/v1/travel-plans: missing X-Aurora-UID returns MISSING_AURORA_UID (not route 404)', async () => {
  const { app, moduleId, memoryStoreId } = buildApp();
  try {
    const resp = await supertest(app).get('/v1/travel-plans').expect(400);
    assert.equal(resp.body?.error, 'MISSING_AURORA_UID');
  } finally {
    delete require.cache[moduleId];
    delete require.cache[memoryStoreId];
  }
});

test('/v1/travel-plans/:trip_id: patch keeps created_at_ms and updates fields', async () => {
  await withMockFetch(buildDestinationResolverFetch(), async () => {
    const { app, moduleId, memoryStoreId } = buildApp();
    const uid = `travel_patch_${Date.now()}`;
    const headers = buildHeaders(uid);
    try {
      const createResp = await supertest(app)
        .post('/v1/travel-plans')
        .set(headers)
        .send({
          destination: 'Osaka',
          start_date: '2099-04-01',
          end_date: '2099-04-03',
        })
        .expect(200);

      const plan = createResp.body?.plan;
      const tripId = String(plan?.trip_id || '');
      assert.ok(tripId);
      const createdAtMs = Number(plan?.created_at_ms || 0);
      assert.ok(Number.isFinite(createdAtMs) && createdAtMs > 0);

      const patchResp = await supertest(app)
        .patch(`/v1/travel-plans/${encodeURIComponent(tripId)}`)
        .set(headers)
        .send({
          destination: 'Osaka, JP',
          itinerary: 'Mostly indoor conference with short outdoor commute.',
          indoor_outdoor_ratio: 0.2,
        })
        .expect(200);

      const updated = patchResp.body?.plan;
      assert.ok(updated);
      assert.equal(updated.destination, 'Osaka, Japan');
      assert.equal(updated.destination_place?.canonical_name, 'Osaka');
      assert.equal(updated.itinerary, 'Mostly indoor conference with short outdoor commute.');
      assert.equal(Number(updated.created_at_ms || 0), createdAtMs);
      assert.ok(Number(updated.updated_at_ms || 0) >= createdAtMs);
    } finally {
      delete require.cache[moduleId];
      delete require.cache[memoryStoreId];
    }
  });
});

test('/v1/travel-plans/:trip_id: empty patch body returns BAD_REQUEST (route hit sentinel)', async () => {
  await withMockFetch(buildDestinationResolverFetch(), async () => {
    const { app, moduleId, memoryStoreId } = buildApp();
    const uid = `travel_empty_patch_${Date.now()}`;
    const headers = buildHeaders(uid);
    try {
      const createResp = await supertest(app)
        .post('/v1/travel-plans')
        .set(headers)
        .send({
          destination: 'Seoul',
          start_date: '2099-04-10',
          end_date: '2099-04-12',
        })
        .expect(200);

      const tripId = String(createResp.body?.plan?.trip_id || '');
      assert.ok(tripId);

      const patchResp = await supertest(app)
        .patch(`/v1/travel-plans/${encodeURIComponent(tripId)}`)
        .set(headers)
        .send({})
        .expect(400);
      assert.equal(patchResp.body?.error, 'BAD_REQUEST');
    } finally {
      delete require.cache[moduleId];
      delete require.cache[memoryStoreId];
    }
  });
});

test('/v1/travel-plans: invalid date range returns BAD_REQUEST', async () => {
  const { app, moduleId, memoryStoreId } = buildApp();
  const uid = `travel_bad_range_${Date.now()}`;
  const headers = buildHeaders(uid);
  try {
    const resp = await supertest(app)
      .post('/v1/travel-plans')
      .set(headers)
      .send({
        destination: 'Paris',
        start_date: '2099-05-20',
        end_date: '2099-05-10',
      })
      .expect(400);

    assert.equal(resp.body?.error, 'BAD_REQUEST');
  } finally {
    delete require.cache[moduleId];
    delete require.cache[memoryStoreId];
  }
});

test('/v1/travel-plans/:trip_id: missing trip returns PLAN_NOT_FOUND', async () => {
  const { app, moduleId, memoryStoreId } = buildApp();
  const uid = `travel_missing_${Date.now()}`;
  const headers = buildHeaders(uid);
  try {
    const patchResp = await supertest(app)
      .patch('/v1/travel-plans/trip_not_found')
      .set(headers)
      .send({ destination: 'Berlin' })
      .expect(404);
    assert.equal(patchResp.body?.error, 'PLAN_NOT_FOUND');

    const archiveResp = await supertest(app)
      .post('/v1/travel-plans/trip_not_found/archive')
      .set(headers)
      .send({})
      .expect(404);
    assert.equal(archiveResp.body?.error, 'PLAN_NOT_FOUND');
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

test('/v1/travel-plans: ambiguous destination returns 409 with candidates', async () => {
  await withMockFetch(
    buildDestinationResolverFetch({
      Paris: [
        {
          name: 'Paris',
          latitude: 48.85341,
          longitude: 2.3488,
          country: 'France',
          country_code: 'FR',
          admin1: 'Ile-de-France',
          timezone: 'Europe/Paris',
          population: 2148000,
          feature_code: 'PPLA',
        },
        {
          name: 'Paris',
          latitude: 33.66094,
          longitude: -95.55551,
          country: 'United States',
          country_code: 'US',
          admin1: 'Texas',
          timezone: 'America/Chicago',
          population: 24900,
          feature_code: 'PPLA2',
        },
      ],
    }),
    async () => {
      const { app, moduleId, memoryStoreId } = buildApp();
      const uid = `travel_ambiguous_${Date.now()}`;
      const headers = buildHeaders(uid);
      try {
        const resp = await supertest(app)
          .post('/v1/travel-plans')
          .set(headers)
          .send({
            destination: 'Paris',
            start_date: '2099-07-10',
            end_date: '2099-07-15',
          })
          .expect(409);

        assert.equal(resp.body?.error, 'DESTINATION_AMBIGUOUS');
        assert.equal(resp.body?.normalized_query, 'Paris');
        assert.equal(Array.isArray(resp.body?.candidates), true);
        assert.ok(resp.body.candidates.length >= 2);
      } finally {
        delete require.cache[moduleId];
        delete require.cache[memoryStoreId];
      }
    },
  );
});

test('/v1/travel-plans/:trip_id: patch returns 409 when new destination is ambiguous', async () => {
  await withMockFetch(
    buildDestinationResolverFetch({
      Paris: [
        {
          name: 'Paris',
          latitude: 48.85341,
          longitude: 2.3488,
          country: 'France',
          country_code: 'FR',
          admin1: 'Ile-de-France',
          timezone: 'Europe/Paris',
          population: 2148000,
          feature_code: 'PPLA',
        },
        {
          name: 'Paris',
          latitude: 33.66094,
          longitude: -95.55551,
          country: 'United States',
          country_code: 'US',
          admin1: 'Texas',
          timezone: 'America/Chicago',
          population: 24900,
          feature_code: 'PPLA2',
        },
      ],
    }),
    async () => {
      const { app, moduleId, memoryStoreId } = buildApp();
      const uid = `travel_patch_ambiguous_${Date.now()}`;
      const headers = buildHeaders(uid);
      try {
        const createResp = await supertest(app)
          .post('/v1/travel-plans')
          .set(headers)
          .send({
            destination: 'Tokyo',
            start_date: '2099-08-10',
            end_date: '2099-08-15',
          })
          .expect(200);
        const tripId = String(createResp.body?.plan?.trip_id || '');
        assert.ok(tripId);

        const patchResp = await supertest(app)
          .patch(`/v1/travel-plans/${encodeURIComponent(tripId)}`)
          .set(headers)
          .send({ destination: 'Paris' })
          .expect(409);

        assert.equal(patchResp.body?.error, 'DESTINATION_AMBIGUOUS');
        assert.ok(Array.isArray(patchResp.body?.candidates));
      } finally {
        delete require.cache[moduleId];
        delete require.cache[memoryStoreId];
      }
    },
  );
});
