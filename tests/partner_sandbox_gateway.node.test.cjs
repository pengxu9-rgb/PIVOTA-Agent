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

test('/version: every environment reports its label as `env`, after the fields it always had, read per request', async () => {
  // NODE_ENV=test is set for this file (it would otherwise win below PIVOTA_ENV), so the unset case reads `test`.
  const cases = [
    [{ PIVOTA_ENV: 'sandbox' }, 'sandbox'],
    [{ PIVOTA_ENV: 'production' }, 'production'],
    [{ PIVOTA_ENV: 'staging' }, 'staging'],
    [{ PIVOTA_ENV: 'development' }, 'development'],
    [{}, 'test'],
    // A Cloud Run revision with no environment name: the fail-closed answer, said out loud.
    [{ K_SERVICE: 'gateway', NODE_ENV: '' }, 'production'],
    // The production UNION wins over the label: staging beside a production signal reports production.
    [{ PIVOTA_ENV: 'staging', NODE_ENV: 'production' }, 'production'],
  ];
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    for (const [env, label] of cases) {
      delete process.env.PIVOTA_ENV;
      delete process.env.K_SERVICE;
      process.env.NODE_ENV = savedNodeEnv;
      Object.assign(process.env, env);
      const res = await supertest(app).get('/version');
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body), [...VERSION_KEYS, 'env'], JSON.stringify(env));
      assert.equal(res.body.env, label, JSON.stringify(env));
    }
  } finally {
    process.env.NODE_ENV = savedNodeEnv;
  }
});

test('sandbox marks through the real server: invoke bodies and the header on every response; none outside the sandbox', async () => {
  // The REST invoke route: its format refusal carries the mark in the sandbox (and the header).
  // Outside the sandbox, ak_test_ is the key the format check refuses (before any backend dial).
  const sbx = await supertest(app).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', `ak_test_${HEX('7')}`)
    .send(ORDER_STATUS).then((r) => r);
  process.env.PIVOTA_ENV = 'sandbox';
  const sbxInvoke = await supertest(app).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', `ak_live_${HEX('7')}`).send(ORDER_STATUS);
  assert.equal(sbxInvoke.status, 401);
  assert.equal(sbxInvoke.body.sandbox, true);
  assert.equal(sbxInvoke.headers['x-pivota-env'], 'sandbox');
  const sbxVersion = await supertest(app).get('/version');
  assert.equal(sbxVersion.headers['x-pivota-env'], 'sandbox');
  assert.equal('sandbox' in sbxVersion.body, false, '/version is not a marked path');
  delete process.env.PIVOTA_ENV;
  // Outside the sandbox the same call is unchanged: no mark, no header.
  assert.equal(sbx.status, 401);
  assert.equal('sandbox' in sbx.body, false);
  assert.equal(sbx.headers['x-pivota-env'], undefined);
});

test('sandbox marks: a tools/call refused BEFORE the adapter (blocked money op) is marked in the sandbox only', async () => {
  const call = async (env, key) => {
    Object.assign(process.env, { AGENT_CHECKOUT_STRICT: '1', ...env });
    delete process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED;
    nock(INTROSPECT_BASE).post(INTROSPECT_PATH, (b) => b?.api_key === key)
      .reply(200, { valid: true, agent_id: 'agent_sbx', is_active: true, auth_source: 'api_keys' });
    try {
      return await supertest(app).post('/mcp').set('X-Agent-API-Key', key)
        .send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_payment_link', arguments: {} } });
    } finally {
      delete process.env.AGENT_CHECKOUT_STRICT;
    }
  };
  const sbx = await call({ PIVOTA_ENV: 'sandbox' }, `ak_test_${HEX('8')}`);
  assert.equal(sbx.status, 200, JSON.stringify(sbx.body));
  assert.equal(sbx.body.result?.isError, true, JSON.stringify(sbx.body));
  assert.match(JSON.stringify(sbx.body.result.content), /OPERATION_NOT_ALLOWED/);
  assert.deepEqual(sbx.body.result._meta, { sandbox: true });
  delete process.env.PIVOTA_ENV;
  invokeAuthCache.clear();
  const prod = await call({ PIVOTA_ENV: 'production' }, `ak_live_${HEX('9')}`);
  assert.equal(prod.status, 200, JSON.stringify(prod.body));
  assert.match(JSON.stringify(prod.body.result.content), /OPERATION_NOT_ALLOWED/);
  assert.equal(prod.body.result._meta, undefined);
});

// --------------------------------------------------------------------------------------------------------------
// The boot refusal: loading src/server.js under an unsafe sandbox config throws before it serves anything.
// --------------------------------------------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '..');
const SAFE_SANDBOX = {
  PIVOTA_ENV: 'sandbox',
  AGENPAS_RAILS: 'reap',
  AGENPAS_CONSENT_ENABLED: 'true',
  PIVOTA_API_BASE: 'https://web-sbx0exampl-uw.a.run.app',
  CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED: 'false',
  SKIP_DB_MIGRATIONS: 'true',
  DB_AUTO_MIGRATE: 'false',
  GOOGLE_CLOUD_PROJECT: 'zz-sandbox-standin',
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

test('boot: the Aurora BFF module is not loaded in the sandbox; production loads it as before', () => {
  const probe = (extra) => {
    const env = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'LOWGUARD_LOG', 'LOWGUARD_TAG']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, extra);
    const script = "require('./src/server'); const loaded = Object.keys(require.cache).some((k) => k.endsWith('/src/auroraBff/routes.js')); console.log('AURORA_LOADED=' + loaded); process.exit(0)";
    return spawnSync(process.execPath, ['-e', script], { cwd: REPO, env, encoding: 'utf8', timeout: 90_000 });
  };
  const sbx = probe(SAFE_SANDBOX);
  assert.equal(sbx.status, 0, sbx.stderr.slice(-1500));
  assert.match(sbx.stdout, /AURORA_LOADED=false/);
  const prod = probe({ PIVOTA_ENV: 'production' });
  assert.equal(prod.status, 0, prod.stderr.slice(-1500));
  assert.match(prod.stdout, /AURORA_LOADED=true/);
});

test('boot: in the sandbox the Aurora skip logs at info with its code, no error and no stack', () => {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'LOWGUARD_LOG', 'LOWGUARD_TAG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, SAFE_SANDBOX);
  const r = spawnSync(process.execPath, ['-e', "require('./src/server'); process.exit(0)"], { cwd: REPO, env, encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => l.includes('aurora'));
  const skip = lines.find((l) => l.includes('aurora_skipped_in_sandbox'));
  assert.ok(skip, lines.join('\n'));
  assert.match(skip, /"level":30/);
  assert.equal(lines.some((l) => l.includes('failed to load')), false);
});
