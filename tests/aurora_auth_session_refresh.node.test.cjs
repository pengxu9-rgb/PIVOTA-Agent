const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_V2_STUB_RESPONSES = '1';
process.env.AURORA_DECISION_BASE_URL = '';

function buildHeaders(uid, token = null) {
  return {
    'X-Aurora-UID': uid,
    'X-Trace-ID': `trace_${uid}`,
    'X-Brief-ID': `brief_${uid}`,
    'X-Lang': 'EN',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function parseSse(responseText) {
  return String(responseText || '')
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event:\s*(\w+)/m)?.[1] || null;
      const dataText = block.match(/^data:\s*(.+)$/m)?.[1] || '{}';
      return {
        event,
        data: JSON.parse(dataText),
      };
    });
}

function loadRoutesHarness(authResolver) {
  const memoryStoreId = require.resolve('../src/auroraBff/memoryStore');
  const authStoreId = require.resolve('../src/auroraBff/authStore');
  const chatRoutesId = require.resolve('../src/auroraBff/routes/chat');
  const routesId = require.resolve('../src/auroraBff/routes');

  delete require.cache[memoryStoreId];
  delete require.cache[authStoreId];
  delete require.cache[chatRoutesId];
  delete require.cache[routesId];

  const authStore = require('../src/auroraBff/authStore');
  const originalResolveSessionFromToken = authStore.resolveSessionFromToken;
  authStore.resolveSessionFromToken = authResolver;

  const chatRoutes = require('../src/auroraBff/routes/chat');
  chatRoutes.__resetRouterForTests();
  const routes = require('../src/auroraBff/routes');

  const cleanup = () => {
    authStore.resolveSessionFromToken = originalResolveSessionFromToken;
    chatRoutes.__resetRouterForTests();
    delete require.cache[routesId];
    delete require.cache[chatRoutesId];
    delete require.cache[memoryStoreId];
    delete require.cache[authStoreId];
  };

  return { routes, cleanup };
}

function buildApp(authResolver) {
  const harness = loadRoutesHarness(authResolver);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  harness.routes.mountAuroraBffRoutes(app, { logger: null });
  return {
    app,
    cleanup: harness.cleanup,
  };
}

test('resolveIdentity annotates auth_meta for valid and invalid tokens', async () => {
  const expiresAt = '2026-03-14T00:00:00.000Z';
  const { routes, cleanup } = loadRoutesHarness(async (token) =>
    String(token || '').trim() === 'live_token'
      ? { userId: 'user_123', email: 'user@example.com', expiresAt }
      : null,
  );

  try {
    const validCtx = { aurora_uid: null };
    const validReq = {
      get(name) {
        return String(name).toLowerCase() === 'authorization' ? 'Bearer live_token' : null;
      },
    };

    const identity = await routes.__internal.resolveIdentity(validReq, validCtx);
    assert.equal(identity.userId, 'user_123');
    assert.equal(identity.userEmail, 'user@example.com');
    assert.deepEqual(validCtx.auth_meta, {
      state: 'authenticated',
      user: { email: 'user@example.com' },
      expires_at: expiresAt,
    });

    const invalidCtx = { aurora_uid: null };
    const invalidReq = {
      get(name) {
        return String(name).toLowerCase() === 'authorization' ? 'Bearer dead_token' : null;
      },
    };

    const invalidIdentity = await routes.__internal.resolveIdentity(invalidReq, invalidCtx);
    assert.equal(invalidIdentity.auth_invalid, true);
    assert.deepEqual(invalidCtx.auth_meta, {
      state: 'invalid',
      user: { email: null },
      expires_at: null,
    });
  } finally {
    cleanup();
  }
});

test('/v1/session/bootstrap includes refreshed auth metadata', async () => {
  const expiresAt = '2026-03-14T02:00:00.000Z';
  const { app, cleanup } = buildApp(async (token) =>
    String(token || '').trim() === 'bootstrap_token'
      ? { userId: 'user_bootstrap', email: 'bootstrap@example.com', expiresAt }
      : null,
  );

  try {
    const response = await supertest(app)
      .get('/v1/session/bootstrap')
      .set(buildHeaders('uid_bootstrap', 'bootstrap_token'))
      .expect(200);

    assert.deepEqual(response.body?.meta?.auth, {
      state: 'authenticated',
      user: { email: 'bootstrap@example.com' },
      expires_at: expiresAt,
    });
  } finally {
    cleanup();
  }
});

test('/v2/chat includes refreshed auth metadata when bearer auth resolves', async () => {
  const expiresAt = '2026-03-14T04:00:00.000Z';
  const { app, cleanup } = buildApp(async (token) =>
    String(token || '').trim() === 'chat_token'
      ? { userId: 'user_chat', email: 'chat@example.com', expiresAt }
      : null,
  );

  try {
    const response = await supertest(app)
      .post('/v2/chat')
      .set(buildHeaders('uid_chat', 'chat_token'))
      .send({
        message: 'Tell me about retinol',
        context: { locale: 'en', profile: {} },
      })
      .expect(200);

    assert.deepEqual(response.body?.meta?.auth, {
      state: 'authenticated',
      user: { email: 'chat@example.com' },
      expires_at: expiresAt,
    });
  } finally {
    cleanup();
  }
});

test('/v1/chat/stream alias carries refreshed auth metadata in its single result event', async () => {
  const expiresAt = '2026-03-14T06:00:00.000Z';
  const { app, cleanup } = buildApp(async (token) =>
    String(token || '').trim() === 'stream_token'
      ? { userId: 'user_stream', email: 'stream@example.com', expiresAt }
      : null,
  );

  try {
    const response = await supertest(app)
      .post('/v1/chat/stream')
      .set(buildHeaders('uid_stream', 'stream_token'))
      .send({
        message: 'how do I start a simple skincare routine?',
        context: { locale: 'en', profile: {} },
      })
      .expect(200);

    const events = parseSse(response.text);
    const resultEvents = events.filter((event) => event.event === 'result');
    assert.equal(resultEvents.length, 1);
    assert.deepEqual(resultEvents[0]?.data?.meta?.auth, {
      state: 'authenticated',
      user: { email: 'stream@example.com' },
      expires_at: expiresAt,
    });
    assert.equal(events.at(-1)?.event, 'done');
  } finally {
    cleanup();
  }
});

test('/v2/chat/stream reports invalid auth state without breaking result delivery', async () => {
  const { app, cleanup } = buildApp(async () => null);

  try {
    const response = await supertest(app)
      .post('/v2/chat/stream')
      .set(buildHeaders('uid_invalid_stream', 'expired_token'))
      .send({
        message: 'how do I start a simple skincare routine?',
        context: { locale: 'en', profile: {} },
      })
      .expect(200);

    const events = parseSse(response.text);
    const resultEvents = events.filter((event) => event.event === 'result');
    assert.equal(resultEvents.length, 1);
    assert.deepEqual(resultEvents[0]?.data?.meta?.auth, {
      state: 'invalid',
      user: { email: null },
      expires_at: null,
    });
    assert.equal(events.at(-1)?.event, 'done');
  } finally {
    cleanup();
  }
});
