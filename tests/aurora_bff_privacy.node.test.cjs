const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Privacy mode: never persist to DB/disk.
process.env.AURORA_BFF_RETENTION_DAYS = '0';
delete process.env.DATABASE_URL;

// Keep tests offline and deterministic.
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  mountAuroraBffRoutes(app, { logger });
  return app;
}

function findRouteHandler(app, { method, path }) {
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  const m = String(method || 'GET').toLowerCase();
  for (const layer of stack) {
    const route = layer && layer.route ? layer.route : null;
    if (!route || route.path !== path) continue;
    if (!route.methods || !route.methods[m]) continue;
    const routeStack = Array.isArray(route.stack) ? route.stack : [];
    const last = routeStack[routeStack.length - 1];
    if (last && typeof last.handle === 'function') return last.handle;
  }
  return null;
}

function buildMockReq({ method, path, headers, body }) {
  const raw = headers && typeof headers === 'object' ? headers : {};
  const headerMap = {};
  for (const [k, v] of Object.entries(raw)) headerMap[String(k).toLowerCase()] = v;
  return {
    method,
    path,
    headers: headerMap,
    body,
    get(name) {
      return headerMap[String(name).toLowerCase()] ?? undefined;
    },
  };
}

function buildMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invoke(app, { method, path, headers, body }) {
  const handler = findRouteHandler(app, { method, path });
  assert.ok(handler, `route handler not found: ${method} ${path}`);
  const req = buildMockReq({ method, path, headers, body });
  const res = buildMockRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

function firstCard(respBody, type) {
  return (respBody.cards || []).find((c) => c && c.type === type) || null;
}

test('Retention=0: profile update succeeds without DATABASE_URL (no persistence)', async () => {
  const app = makeApp();
  const uid = `uid_privacy_${Date.now()}_1`;

  const res = await invoke(app, {
    method: 'POST',
    path: '/v1/profile/update',
    headers: { 'X-Aurora-UID': uid, 'X-Lang': 'EN' },
    body: {
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'healthy',
      goals: ['brightening'],
      region: 'CN',
    },
  });
  assert.equal(res.status, 200);

  const profileCard = firstCard(res.body, 'profile');
  assert.ok(profileCard);
  assert.equal(profileCard.payload.profile.skinType, 'oily');
  assert.equal(profileCard.payload.profile.sensitivity, 'low');
  assert.equal(profileCard.payload.profile.barrierStatus, 'healthy');
});

test('Delete endpoint: deleting profile removes bootstrap/profile + tracker logs (retention=0)', async () => {
  const app = makeApp();
  const uid = `uid_privacy_${Date.now()}_2`;

  {
    const res = await invoke(app, {
      method: 'POST',
      path: '/v1/profile/update',
      headers: { 'X-Aurora-UID': uid, 'X-Lang': 'EN' },
      body: { skinType: 'oily', sensitivity: 'low', barrierStatus: 'healthy', goals: ['pores'] },
    });
    assert.equal(res.status, 200);
  }

  const trackerRes = await invoke(app, {
    method: 'POST',
    path: '/v1/tracker/log',
    headers: { 'X-Aurora-UID': uid, 'X-Lang': 'EN' },
    body: { date: '2026-02-06', redness: 2, acne: 1, hydration: 3, notes: 'test' },
  });
  assert.equal(trackerRes.status, 200);
  const trackerCard = firstCard(trackerRes.body, 'tracker_log');
  assert.ok(trackerCard);
  assert.equal(Array.isArray(trackerCard.payload.recent_logs), true);
  assert.ok(trackerCard.payload.recent_logs.length >= 1);

  const bootstrapBefore = await invoke(app, {
    method: 'GET',
    path: '/v1/session/bootstrap',
    headers: { 'X-Aurora-UID': uid, 'X-Lang': 'EN' },
  });
  assert.equal(bootstrapBefore.status, 200);
  const bootCardBefore = firstCard(bootstrapBefore.body, 'session_bootstrap');
  assert.ok(bootCardBefore);
  assert.equal(bootCardBefore.payload.db_ready, true);
  assert.ok(bootCardBefore.payload.profile);
  assert.ok(Array.isArray(bootCardBefore.payload.recent_logs));
  assert.ok(bootCardBefore.payload.recent_logs.length >= 1);

  const delRes = await invoke(app, {
    method: 'POST',
    path: '/v1/profile/delete',
    headers: { 'X-Aurora-UID': uid, 'X-Lang': 'EN' },
    body: {},
  });
  assert.equal(delRes.status, 200);
  const delCard = firstCard(delRes.body, 'profile_deleted');
  assert.ok(delCard);
  assert.equal(delCard.payload.deleted, true);

  const bootstrapAfter = await invoke(app, {
    method: 'GET',
    path: '/v1/session/bootstrap',
    headers: { 'X-Aurora-UID': uid, 'X-Lang': 'EN' },
  });
  assert.equal(bootstrapAfter.status, 200);
  const bootCardAfter = firstCard(bootstrapAfter.body, 'session_bootstrap');
  assert.ok(bootCardAfter);
  assert.equal(bootCardAfter.payload.db_ready, true);
  assert.equal(bootCardAfter.payload.profile, null);
  assert.deepEqual(bootCardAfter.payload.recent_logs, []);
});
