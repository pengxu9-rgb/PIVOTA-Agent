'use strict';

/*
 * An anonymous POST to /v1/recommendations/* crashed the process.
 *
 * requireInternalKey (src/recommendations/routes.js) ended its refusal paths with
 *
 *     return res.status(401).json({ … });
 *
 * which returns an Express Response — a TRUTHY object. Both call sites guard with
 *
 *     if (!requireInternalKey(req, res)) return;
 *
 * and `!response` is false, so the early return never fired. The handler carried on past the
 * refusal and called res.json() a second time, throwing ERR_HTTP_HEADERS_SENT inside an async
 * handler. src/server.js installs no process.on('unhandledRejection') — there is a comment at
 * ~31009 noting exactly that — so on Node >= 15 the default handler terminates the process.
 *
 * Reproduced on 2026-08-20 against prod's own configuration (RECOMMENDATIONS_INTERNAL_KEY set,
 * NODE_ENV unset, which is the branch that reaches the 401): one uncredentialed request, no
 * credential of any kind, and the server exits. That is an unauthenticated remote denial of service
 * — repeatable in a loop by anyone who can reach the host.
 *
 * The fix is that the refusal paths send the response and then return FALSE, so the guard clause
 * works as its call sites always assumed. These tests pin the return value directly, because that
 * is the actual contract; asserting only the status code would pass against the broken version too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const { mountRecommendationRoutes } = require('../src/recommendations/routes');

const KEY = 'test-recommendations-key-0123456789';

function buildApp() {
  const app = express();
  app.use(express.json());
  mountRecommendationRoutes(app);
  // Surfaces a double-send as a test failure rather than as a dead process.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'TEST_HARNESS', message: String(err && err.message) });
  });
  return app;
}

test('an uncredentialed request is refused ONCE, and the response is not sent twice', async () => {
  // The crash: the handler continued past the 401 and called res.json() again. supertest surfaces
  // that as a socket error or a mangled body rather than a clean 401.
  process.env.RECOMMENDATIONS_INTERNAL_KEY = KEY;
  delete process.env.NODE_ENV; // prod's actual state — this is the branch that reaches the 401
  try {
    for (const p of ['/v1/recommendations/feed', '/v1/recommendations/roles/normalize']) {
      const resp = await supertest(buildApp()).post(p).send({});
      assert.equal(resp.status, 401, `${p} status`);
      assert.equal(resp.body.error, 'UNAUTHORIZED', `${p} body`);
      assert.equal(resp.body.error_harness, undefined, `${p}: the harness saw a double send`);
    }
  } finally {
    delete process.env.RECOMMENDATIONS_INTERNAL_KEY;
  }
});

test('a wrong key is refused once, the right key gets through', async () => {
  process.env.RECOMMENDATIONS_INTERNAL_KEY = KEY;
  delete process.env.NODE_ENV;
  try {
    const bad = await supertest(buildApp())
      .post('/v1/recommendations/feed')
      .set('X-Internal-Key', 'wrong')
      .send({});
    assert.equal(bad.status, 401);

    // The right key must get PAST the guard. A 401 here would mean the fix broke the happy path;
    // anything else (400 validation, 200, 500) proves the request reached the handler body.
    const good = await supertest(buildApp())
      .post('/v1/recommendations/feed')
      .set('X-Internal-Key', KEY)
      .send({});
    assert.notEqual(good.status, 401, 'a valid key must reach the handler');
  } finally {
    delete process.env.RECOMMENDATIONS_INTERNAL_KEY;
  }
});

test('many uncredentialed requests in a row do not kill the process', async () => {
  // The denial-of-service shape. Before the fix the first one was fatal; this asserts the route can
  // absorb a flood of them and keep answering.
  process.env.RECOMMENDATIONS_INTERNAL_KEY = KEY;
  delete process.env.NODE_ENV;
  const app = buildApp();
  try {
    for (let i = 0; i < 25; i += 1) {
      const resp = await supertest(app).post('/v1/recommendations/feed').send({});
      assert.equal(resp.status, 401, `request ${i}`);
    }
  } finally {
    delete process.env.RECOMMENDATIONS_INTERNAL_KEY;
  }
});
