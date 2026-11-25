'use strict';

/**
 * PARTNER SANDBOX v0 through the REAL gateway (src/server.js): the invoke route's key check, /version, and the boot
 * refusal. The pure rules are pinned in tests/partner_sandbox_config.node.test.cjs; these prove src/server.js uses
 * them (a test that called the helpers directly would not show the route consults them).
 *
 * PIVOTA_ENV is set per test, after src/server.js has loaded: the key check and /version read it per request, and
 * the boot check (module scope) is driven in a child process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const supertest = require('supertest');
const nock = require('nock');

const INTROSPECT_BASE = 'https://auth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const BACKEND_BASE = 'https://backend.test';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
// Generous: the introspect reply is an in-process nock, so only a stalled event loop (a loaded machine) could reach it.
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '5000';
process.env.AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED = 'false';
process.env.PIVOTA_API_BASE = BACKEND_BASE;
process.env.PIVOTA_API_KEY = 'test-token';
delete process.env.PIVOTA_ENV;

const app = require('../src/server');
const { invokeAuthCache, clearInvokeAuthIntrospectCooldown } = app._debug;

const HEX = (c) => c.repeat(64);
const ORDER_STATUS = { operation: 'get_order_status', payload: { status: { order_id: 'ord_1' } } };

nock.disableNetConnect();
nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);

test.afterEach(() => {
  nock.cleanAll();
  invokeAuthCache.clear();
  if (typeof clearInvokeAuthIntrospectCooldown === 'function') clearInvokeAuthIntrospectCooldown();
  delete process.env.PIVOTA_ENV;
  delete process.env.K_SERVICE;
});

test.after(() => {
  nock.enableNetConnect();
});

/** Send one invoke call with `key`; report the status and how many times the gateway asked the backend about it. */
async function invokeWith(key, env = {}) {
  Object.assign(process.env, env);
  const dials = [];
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => {
      dials.push(body);
      return body?.api_key === key;
    })
    .optionally()
    .reply(200, { valid: true, agent_id: 'agent_sbx', is_active: true, auth_source: 'api_keys' });
  nock(BACKEND_BASE).get(/\/agent\/v2\/orders\/ord_1/).optionally().reply(200, { order_id: 'ord_1' });
  const res = await supertest(app).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', key).send(ORDER_STATUS);
  return { status: res.status, body: res.body, dials: dials.length };
}

const isFormatRefusal = (r) => r.status === 401 && r.body?.message === 'Missing or invalid API key' && r.dials === 0;

test('sandbox invoke: an ak_test_ key reaches the backend; ak_live_ and bare ak_ are refused before any dial', async () => {
  const sbx = { PIVOTA_ENV: 'sandbox' };
  const ok = await invokeWith(`ak_test_${HEX('1')}`, sbx);
  assert.equal(ok.dials, 1, JSON.stringify(ok));
  assert.notEqual(ok.status, 401, JSON.stringify(ok));
  assert.equal(isFormatRefusal(await invokeWith(`ak_live_${HEX('2')}`, sbx)), true);
  assert.equal(isFormatRefusal(await invokeWith(`ak_${HEX('3')}`, sbx)), true);
});

for (const [label, env] of [['production', { PIVOTA_ENV: 'production' }], ['staging', { PIVOTA_ENV: 'staging' }], ['unset', {}]]) {
  test(`${label} invoke: unchanged; ak_live_ and bare ak_ reach the backend, ak_test_ is refused before any dial`, async () => {
    const live = await invokeWith(`ak_live_${HEX('4')}`, env);
    assert.equal(live.dials, 1, JSON.stringify(live));
    assert.notEqual(live.status, 401);
    const bare = await invokeWith(`ak_${HEX('5')}`, env);
    assert.equal(bare.dials, 1, JSON.stringify(bare));
    assert.equal(isFormatRefusal(await invokeWith(`ak_test_${HEX('6')}`, env)), true);
  });
}

const VERSION_KEYS = ['ok', 'service', 'commit', 'full_sha', 'build_id', 'branch', 'deployment_id', 'started_at'];

test('/version: env:"sandbox" in the sandbox, after the fields it always had', async () => {
  process.env.PIVOTA_ENV = 'sandbox';
  const res = await supertest(app).get('/version');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), [...VERSION_KEYS, 'env']);
  assert.equal(res.body.env, 'sandbox');
});

test('/version: production, staging and unset answer exactly the fields they did before (no env)', async () => {
  for (const env of [{ PIVOTA_ENV: 'production' }, { PIVOTA_ENV: 'staging' }, {}]) {
    delete process.env.PIVOTA_ENV;
    Object.assign(process.env, env);
    const res = await supertest(app).get('/version');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), VERSION_KEYS, JSON.stringify(env));
  }
});

// --------------------------------------------------------------------------------------------------------------
// The boot refusal: loading src/server.js under an unsafe sandbox config throws before it serves anything.
// --------------------------------------------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '..');
const SAFE_SANDBOX = {
  PIVOTA_ENV: 'sandbox',
  AGENPAS_RAILS: 'reap',
  AGENPAS_CONSENT_ENABLED: 'true',
  PIVOTA_API_BASE: 'https://web-sbx0example-uw.a.run.app',
  CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED: 'false',
};

/** Require src/server.js in a child with exactly `extra` over a scrubbed env; it never listens (require.main). */
function loadServerWith(extra) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'LOWGUARD_LOG', 'LOWGUARD_TAG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, extra);
  return spawnSync(process.execPath, ['-e', "require('./src/server'); process.exit(0)"], {
    cwd: REPO, env, encoding: 'utf8', timeout: 90_000,
  });
}

test('boot: src/server.js refuses to load an unsafe sandbox config, naming the settings, never the values', () => {
  const SECRET = 'S3CRETbootvalue';
  const r = loadServerWith({ ...SAFE_SANDBOX, A2A_RAIL_PILOT_AGENT_IDS: SECRET, PIVOTA_API_BASE: `https://${SECRET}@api.pivota.cc` });
  assert.notEqual(r.status, 0, 'the load must fail');
  assert.match(r.stderr, /SANDBOX_CONFIG_REFUSED: /);
  assert.match(r.stderr, /A2A_RAIL_PILOT_AGENT_IDS\(no A2A rail setting may be set\)/);
  assert.match(r.stderr, /PIVOTA_API_BASE\(prod or staging host\)/);
  assert.equal(`${r.stdout}${r.stderr}`.includes(SECRET), false);
});

test('boot: a safe sandbox config, and production with the same unsafe settings, both load', () => {
  const safe = loadServerWith(SAFE_SANDBOX);
  assert.equal(safe.status, 0, safe.stderr.slice(-2000));
  const prod = loadServerWith({ PIVOTA_ENV: 'production', A2A_RAIL_PILOT_AGENT_IDS: 'x', PIVOTA_API_BASE: 'https://api.pivota.cc' });
  assert.equal(prod.status, 0, prod.stderr.slice(-2000));
  assert.equal(prod.stderr.includes('SANDBOX_CONFIG_REFUSED'), false);
});
