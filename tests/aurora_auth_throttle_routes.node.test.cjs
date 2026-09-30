'use strict';

// The Aurora sign-in doors over HTTP: the attempt cap end to end, and the per-IP / per-email throttles
// in front of /v1/auth/start, /v1/auth/verify and /v1/auth/password/login.
//
// The routes run against the real authStore on pg-mem (migration 013's DDL), so a 401 or 429 here is
// what the gateway would send. Client IPs are given the way the load balancer delivers them: the
// client's address followed by the forwarding-rule address (2 trusted hops, gatewayGuardrails).

process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.AURORA_CHAT_V2_STUB_RESPONSES = '1';
process.env.AURORA_DECISION_BASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supertest = require('supertest');
const { makeAuroraAuthDb } = require('./fixtures/auroraAuthPgMem.cjs');

const DB_MODULE = require('../src/db');
const LB_HOP = '35.190.0.1';

const BASE_ENV = {
  AURORA_BFF_AUTH_ENABLED: 'true',
  AURORA_BFF_AUTH_PEPPER: 'test-pepper',
  AURORA_BFF_AUTH_EMAIL_PROVIDER: 'none',
  AURORA_BFF_AUTH_DEBUG_RETURN_CODE: 'true',
  AURORA_BFF_AUTH_THROTTLE_ENABLED: '',
  AURORA_BFF_AUTH_OTP_START_MAX_PER_EMAIL: '',
  GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS: '',
};

const MODULE_IDS = [
  '../src/auroraBff/authStore',
  '../src/auroraBff/authThrottle',
  '../src/auroraBff/memoryStore',
  '../src/auroraBff/routes/chat',
  '../src/auroraBff/routes',
].map((id) => require.resolve(id));

function buildApp(envOverrides = {}, { logger = null } = {}) {
  const env = { ...BASE_ENV, ...envOverrides };
  const previous = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === '' || v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const { query, withClient } = makeAuroraAuthDb();
  const originalQuery = DB_MODULE.query;
  const originalWithClient = DB_MODULE.withClient;
  DB_MODULE.query = query;
  DB_MODULE.withClient = withClient;
  for (const id of MODULE_IDS) delete require.cache[id];
  const chatRoutes = require('../src/auroraBff/routes/chat');
  chatRoutes.__resetRouterForTests();
  const routes = require('../src/auroraBff/routes');
  const expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));
  routes.mountAuroraBffRoutes(expressApp, { logger });
  // Bound to 127.0.0.1 explicitly: supertest(app) listens on '::' and dials 127.0.0.1, so a process
  // elsewhere on the machine holding the same port number on IPv4 can answer instead (seen: a stray
  // 404 / 500 / ECONNRESET under parallel test load).
  const app = http.createServer(expressApp);
  const listening = new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));

  const cleanup = async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    chatRoutes.__resetRouterForTests();
    DB_MODULE.query = originalQuery;
    DB_MODULE.withClient = originalWithClient;
    for (const id of MODULE_IDS) delete require.cache[id];
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return listening.then(() => ({ app, query, cleanup }));
}

function headers(ip, uid = 'uid_auth_test') {
  return {
    'X-Aurora-UID': uid,
    'X-Lang': 'EN',
    'X-Forwarded-For': `${ip}, ${LB_HOP}`,
  };
}

function errorCard(res) {
  const cards = Array.isArray(res.body?.cards) ? res.body.cards : [];
  return cards.find((c) => c && c.type === 'error')?.payload || null;
}

async function start(app, email, ip) {
  return supertest(app).post('/v1/auth/start').set(headers(ip)).send({ email });
}

async function verify(app, email, code, ip) {
  return supertest(app).post('/v1/auth/verify').set(headers(ip)).send({ email, code });
}

function debugCode(res) {
  const card = (res.body?.cards || []).find((c) => c && c.type === 'auth_challenge');
  return card?.payload?.debug_code || null;
}

function wrongCodeFor(code) {
  return code === '123456' ? '654321' : '123456';
}

test('HTTP: five wrong codes close the code, the right one then fails, a new /start works', async () => {
  const warnings = [];
  const logger = { warn: (obj, msg) => warnings.push({ obj, msg }), info() {}, error() {}, debug() {} };
  const { app, cleanup } = await buildApp({}, { logger });
  try {
    const email = 'http-cap@example.com';
    const first = await start(app, email, '198.51.100.10');
    assert.equal(first.status, 200);
    const code = debugCode(first);
    assert.match(code, /^\d{6}$/);

    for (let i = 1; i <= 4; i += 1) {
      const res = await verify(app, email, wrongCodeFor(code), '198.51.100.10');
      assert.equal(res.status, 401);
      assert.equal(errorCard(res)?.reason, 'invalid_or_expired');
    }
    const fifth = await verify(app, email, wrongCodeFor(code), '198.51.100.10');
    assert.equal(fifth.status, 401);
    // The guess that closes the code answers exactly like any wrong code.
    assert.equal(errorCard(fifth)?.reason, 'invalid_or_expired');
    assert.equal(fifth.body.assistant_message.content, 'Invalid or expired code.');
    // ...and the cap is recorded server-side only.
    assert.equal(warnings.filter((w) => w.obj?.event === 'aurora_otp_attempt_cap_reached').length, 1);
    assert.ok(!JSON.stringify(fifth.body).includes('attempt_cap'));

    const right = await verify(app, email, code, '198.51.100.10');
    assert.equal(right.status, 401, 'the capped code no longer signs in');

    const second = await start(app, email, '198.51.100.10');
    const ok = await verify(app, email, debugCode(second), '198.51.100.10');
    assert.equal(ok.status, 200);
    assert.ok((ok.body.cards || []).some((c) => c.type === 'auth_session' && c.payload?.token));
  } finally {
    await cleanup();
  }
});

test('per-IP: /start admits 20 an hour from one client address, then 429 with Retry-After', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const ip = '203.0.113.5';
    for (let i = 0; i < 20; i += 1) {
      const res = await start(app, `ip-start-${i}@example.com`, ip);
      assert.equal(res.status, 200, `start ${i + 1}`);
    }
    const blocked = await start(app, 'ip-start-over@example.com', ip);
    assert.equal(blocked.status, 429);
    assert.equal(errorCard(blocked)?.error, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers['retry-after']) >= 1);

    // Mutant killed: keying on the LEFT-most X-Forwarded-For entry, which the caller writes itself.
    const spoofed = await supertest(app)
      .post('/v1/auth/start')
      .set({ ...headers(ip), 'X-Forwarded-For': `9.9.9.9, ${ip}, ${LB_HOP}` })
      .send({ email: 'ip-start-spoof@example.com' });
    assert.equal(spoofed.status, 429);

    // Another client is untouched.
    assert.equal((await start(app, 'ip-start-other@example.com', '203.0.113.6')).status, 200);
  } finally {
    await cleanup();
  }
});

test('per-email: /start for one address from many IPs is throttled by the address', async () => {
  // Raise the database bound so the process-local email bucket is the one under test.
  const { app, cleanup } = await buildApp({ AURORA_BFF_AUTH_OTP_START_MAX_PER_EMAIL: '20' });
  try {
    const email = 'email-start@example.com';
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await start(app, email, `192.0.2.${10 + i}`)).status, 200, `start ${i + 1}`);
    }
    const blocked = await start(app, email, '192.0.2.99');
    assert.equal(blocked.status, 429);
    assert.equal(errorCard(blocked)?.error, 'RATE_LIMITED');
    assert.equal((await start(app, 'email-start-other@example.com', '192.0.2.99')).status, 200);
  } finally {
    await cleanup();
  }
});

test('the database /start bound holds with the process throttle switched off, and answers 429', async () => {
  const { app, cleanup } = await buildApp({ AURORA_BFF_AUTH_THROTTLE_ENABLED: 'false' });
  try {
    const email = 'db-bound@example.com';
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await start(app, email, `192.0.2.${40 + i}`)).status, 200, `start ${i + 1}`);
    }
    const blocked = await start(app, email, '192.0.2.60');
    // Mutant killed: mapping AUTH_RATE_LIMITED to the generic 500 path.
    assert.equal(blocked.status, 429);
    assert.equal(errorCard(blocked)?.error, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
  } finally {
    await cleanup();
  }
});

test('per-IP: /verify admits 30 an hour from one client address, then 429', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const ip = '203.0.113.20';
    for (let i = 0; i < 30; i += 1) {
      const res = await verify(app, `ip-verify-${i}@example.com`, '123456', ip);
      assert.equal(res.status, 401, `verify ${i + 1}`);
    }
    const blocked = await verify(app, 'ip-verify-over@example.com', '123456', ip);
    assert.equal(blocked.status, 429);
    assert.equal(errorCard(blocked)?.error, 'RATE_LIMITED');
    assert.equal((await verify(app, 'ip-verify-over@example.com', '123456', '203.0.113.21')).status, 401);
  } finally {
    await cleanup();
  }
});

test('per-email: /verify for one address from many IPs is throttled after 10', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const email = 'email-verify@example.com';
    for (let i = 0; i < 10; i += 1) {
      const res = await verify(app, email, '123456', `192.0.2.${100 + i}`);
      assert.equal(res.status, 401, `verify ${i + 1}`);
    }
    const blocked = await verify(app, email, '123456', '192.0.2.200');
    assert.equal(blocked.status, 429);
    assert.equal(errorCard(blocked)?.error, 'RATE_LIMITED');
  } finally {
    await cleanup();
  }
});

test('per-IP: /password/login admits 30 an hour from one client address, then 429', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const ip = '203.0.113.40';
    for (let i = 0; i < 30; i += 1) {
      const res = await supertest(app)
        .post('/v1/auth/password/login')
        .set(headers(ip))
        .send({ email: `pw-${i}@example.com`, password: 'not-the-password' });
      assert.equal(res.status, 401, `login ${i + 1}: ${JSON.stringify(res.body)}`);
    }
    const blocked = await supertest(app)
      .post('/v1/auth/password/login')
      .set(headers(ip))
      .send({ email: 'pw-over@example.com', password: 'not-the-password' });
    assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
    assert.equal(errorCard(blocked)?.error, 'RATE_LIMITED');
  } finally {
    await cleanup();
  }
});

test('per-email: /password/login for one address from many IPs is throttled after 10', async () => {
  const { app, cleanup } = await buildApp();
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await supertest(app)
        .post('/v1/auth/password/login')
        .set(headers(`192.0.2.${150 + i}`))
        .send({ email: 'pw-email@example.com', password: 'not-the-password' });
      assert.equal(res.status, 401, `login ${i + 1}`);
    }
    const blocked = await supertest(app)
      .post('/v1/auth/password/login')
      .set(headers('192.0.2.250'))
      .send({ email: 'PW-Email@example.com', password: 'not-the-password' });
    assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
    assert.equal(errorCard(blocked)?.error, 'RATE_LIMITED');
  } finally {
    await cleanup();
  }
});

test('a throttled answer is the same for an address with an account and one without', async () => {
  const { app, query, cleanup } = await buildApp({ AURORA_BFF_AUTH_OTP_START_MAX_PER_EMAIL: '20' });
  try {
    await query('INSERT INTO aurora_users (user_id, email) VALUES ($1, $2)', ['usr_known', 'known@example.com']);
    const shape = async (email) => {
      const statuses = [];
      let last = null;
      for (let i = 0; i < 6; i += 1) {
        last = await start(app, email, `198.51.100.${email.startsWith('known') ? 50 + i : 70 + i}`);
        statuses.push(last.status);
      }
      return { statuses, error: errorCard(last), message: last.body.assistant_message?.content };
    };
    assert.deepEqual(await shape('known@example.com'), await shape('unknown@example.com'));
  } finally {
    await cleanup();
  }
});
