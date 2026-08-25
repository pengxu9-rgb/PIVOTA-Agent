/**
 * The internal-key gate on /v1/recommendations/* must refuse, not fall open.
 *
 * MEASURED on the production gateway 2026-08-25: NODE_ENV and APP_ENV are both ABSENT, while
 * PIVOTA_ENV=production is what is actually set. The guard decided production from
 * `NODE_ENV || APP_ENV` alone, so its CONFIG_MISSING branch was unreachable there and an empty
 * RECOMMENDATIONS_INTERNAL_KEY would have fallen through to `return true` — an open internal route.
 * It is armed today only because the secret happens to be mounted non-empty.
 *
 * These drive the REAL route through the REAL express app. A test that called requireInternalKey
 * directly would not prove the route consults it.
 */
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { mountRecommendationRoutes } = require('../src/recommendations/routes');

const ENV_KEYS = [
  'RECOMMENDATIONS_INTERNAL_KEY',
  'NODE_ENV',
  'APP_ENV',
  'PIVOTA_ENV',
  'K_SERVICE',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_NAME',
  'VERCEL_ENV',
];

const ROUTE = '/v1/recommendations/roles/normalize';
const BODY = { roleHints: ['cleanser'] };

/** Start the real app with exactly `patch` set, call the route, return {status, body}. */
async function callRoute(patch, headers = {}) {
  const previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.entries(patch).forEach(([k, v]) => {
    process.env[k] = String(v);
  });
  try {
    const app = express();
    app.use(express.json());
    mountRecommendationRoutes(app);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(BODY),
      });
      let body = null;
      try {
        body = await resp.json();
      } catch {
        body = null;
      }
      return { status: resp.status, body };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('PIVOTA_ENV=production with no key REFUSES (the unreachable branch)', async () => {
  // The regression. NODE_ENV and APP_ENV are absent here exactly as they are in production.
  const { status, body } = await callRoute({ PIVOTA_ENV: 'production' });
  assert.strictEqual(status, 500, 'an unkeyed internal route answered instead of refusing');
  assert.strictEqual(body && body.error, 'CONFIG_MISSING');
});

test('a deployed revision that LOST its environment label still refuses', async () => {
  // Cloud Run injects K_SERVICE unconditionally, and isProduction() fails closed on it. Without
  // that, dropping PIVOTA_ENV would silently re-open this route.
  const { status, body } = await callRoute({ K_SERVICE: 'gateway' });
  assert.strictEqual(status, 500);
  assert.strictEqual(body && body.error, 'CONFIG_MISSING');
});

test('NODE_ENV=production with no key still refuses', async () => {
  const { status } = await callRoute({ NODE_ENV: 'production' });
  assert.strictEqual(status, 500);
});

test('local development with no key stays open', async () => {
  // No platform markers and no production token: the permissive branch is deliberate, and
  // removing it would break every local run.
  const { status } = await callRoute({});
  assert.strictEqual(status, 200, 'local development must not require a key');
});

test('a configured key rejects a wrong value', async () => {
  const { status, body } = await callRoute(
    { PIVOTA_ENV: 'production', RECOMMENDATIONS_INTERNAL_KEY: 'correct-horse' },
    { 'X-Internal-Key': 'wrong-horse' },
  );
  assert.strictEqual(status, 401);
  assert.strictEqual(body && body.error, 'UNAUTHORIZED');
});

test('a configured key rejects a MISSING header', async () => {
  const { status } = await callRoute({
    PIVOTA_ENV: 'production',
    RECOMMENDATIONS_INTERNAL_KEY: 'correct-horse',
  });
  assert.strictEqual(status, 401);
});

test('a configured key accepts the right value', async () => {
  const { status } = await callRoute(
    { PIVOTA_ENV: 'production', RECOMMENDATIONS_INTERNAL_KEY: 'correct-horse' },
    { 'X-Internal-Key': 'correct-horse' },
  );
  assert.strictEqual(status, 200, 'a correct key was rejected — the guard is now too strict');
});

test('a length-mismatched key does not crash the route', async () => {
  // crypto.timingSafeEqual THROWS on differing buffer lengths. Comparing without the length guard
  // would turn any wrong-length key into a 500 — both a crash and a length oracle.
  const { status } = await callRoute(
    { PIVOTA_ENV: 'production', RECOMMENDATIONS_INTERNAL_KEY: 'correct-horse' },
    { 'X-Internal-Key': 'x' },
  );
  assert.strictEqual(status, 401, 'a wrong-length key produced something other than 401');
});

test('a multi-byte key does not crash the route', async () => {
  const { status } = await callRoute(
    { PIVOTA_ENV: 'production', RECOMMENDATIONS_INTERNAL_KEY: 'correct-horse' },
    { 'X-Internal-Key': Buffer.from('café', 'latin1').toString('latin1') },
  );
  assert.strictEqual(status, 401);
});

/**
 * The comparison itself.
 *
 * A functional test cannot observe constant-timeness — reverting timingSafeEqualString to `===`
 * leaves every case above green, which is exactly the "surviving mutant" that means a missing row
 * rather than an equivalent change. So this asserts on the SOURCE of the guard: it must route the
 * secret through the constant-time helper and must not compare it with a plain equality operator.
 *
 * Reading the function body rather than the whole file on purpose — the file legitimately contains
 * `===` elsewhere, and a substring check over all of it would pass on any of them.
 */
test('the guard compares the secret in constant time, not with ===', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'recommendations', 'routes.js'), 'utf8');

  const start = src.indexOf('function requireInternalKey(req, res) {');
  assert.notStrictEqual(start, -1, 'requireInternalKey not found — this test is testing nothing');
  const end = src.indexOf('\n  }', start);
  assert.ok(end > start, 'could not delimit the guard body');
  const body = src.slice(start, end);

  assert.match(
    body,
    /timingSafeEqualString\(provided, expected\)/,
    'the guard must compare the secret with the constant-time helper',
  );
  assert.doesNotMatch(
    body,
    /provided\s*===\s*expected|expected\s*===\s*provided/,
    'the guard compares the secret with ===, which leaks a timing signal proportional to the '
      + 'shared prefix',
  );
});
