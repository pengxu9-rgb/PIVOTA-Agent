'use strict';

/**
 * PARTNER SANDBOX v0, gateway side (src/config/sandbox.js; partner sandbox design steps 4, 5, decision 4).
 *
 * What every test here pins:
 *   - `PIVOTA_ENV=sandbox` is its own label: deployed, not production. Named by PIVOTA_ENV only.
 *   - Production, staging, development and test answer EXACTLY as before: same labels, same guards, today's key
 *     pattern (so `ak_test_` stays refused there), no boot refusal, no `sandbox` mark, the 7-day stale flag kept.
 *   - In the sandbox: only `ak_test_<64 hex>`; the boot check refuses each unsafe setting by NAME, never value;
 *     copied prices are never stale by age; every MCP tool answer carries `sandbox: true`.
 *
 * Every env is an explicit object or is set and restored around the one call, so the runner's own env
 * (NODE_ENV, a proxy, a CI PIVOTA_ENV) cannot change an answer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const platform = require('../src/config/platform');
const sandbox = require('../src/config/sandbox');

// STAND-IN Cloud Run project parts. The real prod and staging ones are not written in this public repo
// (src/config/sandbox.js ships only their scrypt digests); every host test below refuses these instead, through
// the test-only override, so the matching logic is tested with the same digest code that runs in a deploy.
const STAND_IN_PROJECT_PARTS = Object.freeze(['zq7stand1n', '900000000001', 'zq7stand2n', '900000000002']);
test.before(() => sandbox.setRefusedProjectDigestsForTests(STAND_IN_PROJECT_PARTS.map(sandbox.projectPartDigest)));
test.after(() => sandbox.setRefusedProjectDigestsForTests());
// STAND-IN prod/staging private IPs, for the same reason (the real ones ship only as digests).
const STAND_IN_IPS = Object.freeze(['10.250.250.1', '10.250.250.2', '10.250.250.3']);
test.before(() => sandbox.setRefusedIpDigestsForTests(STAND_IN_IPS.map(sandbox.projectPartDigest)));
test.after(() => sandbox.setRefusedIpDigestsForTests());

const HEX64 = 'a'.repeat(64);
const KEY_TEST = `ak_test_${HEX64}`;
const KEY_LIVE = `ak_live_${HEX64}`;
const KEY_BARE = `ak_${HEX64}`;

/** A sandbox revision on Cloud Run that is safe to serve. Each refusal test breaks exactly one thing. */
const SAFE_SANDBOX = Object.freeze({
  PIVOTA_ENV: 'sandbox',
  K_SERVICE: 'gateway',
  K_REVISION: 'gateway-00001-abc',
  AGENPAS_RAILS: 'reap',
  AGENPAS_CONSENT_ENABLED: 'true',
  PIVOTA_API_BASE: 'https://web-sbx0exampl-uw.a.run.app',
  AGENT_AUTH_INTROSPECT_URL: 'https://web-sbx0exampl-uw.a.run.app/agent/internal/auth/introspect',
  CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED: 'false',
  PIVOTA_API_KEY: KEY_TEST,
  SKIP_DB_MIGRATIONS: 'true',
  DB_AUTO_MIGRATE: 'false',
  GOOGLE_CLOUD_PROJECT: 'zz-sandbox-standin',
  LLM_KILL_SWITCH: 'true',
});

/** Today's deployed environments plus the local defaults. None names the sandbox. */
const NON_SANDBOX_ENVS = Object.freeze({
  production_cloud_run: { PIVOTA_ENV: 'production', K_SERVICE: 'gateway' },
  staging_cloud_run: { PIVOTA_ENV: 'staging', K_SERVICE: 'gateway' },
  unnamed_cloud_run_fail_closed: { K_SERVICE: 'gateway' },
  railway_production: { RAILWAY_ENVIRONMENT: 'production' },
  local_default: {},
  node_test: { NODE_ENV: 'test' },
  development: { PIVOTA_ENV: 'development' },
});

function withProcessEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

// --------------------------------------------------------------------------------------------------------------
// 1. The label.
// --------------------------------------------------------------------------------------------------------------

test('PIVOTA_ENV=sandbox resolves to its own label: deployed, resolved, not production, not staging', () => {
  for (const raw of ['sandbox', 'SANDBOX', ' Sandbox ']) {
    const env = { PIVOTA_ENV: raw, K_SERVICE: 'gateway' };
    assert.deepEqual(platform.resolvePlatformEnv(env), { env: 'sandbox', source: 'PIVOTA_ENV', raw: raw.trim(), resolved: true });
    assert.equal(platform.platformEnv(env), 'sandbox');
    assert.equal(platform.isProduction(env), false);
    assert.equal(platform.isStaging(env), false);
    assert.equal(platform.isSandbox(env), true);
    assert.equal(platform.isManagedPlatform(env), true);
    assert.equal(platform.requirePlatformEnv(env).env, 'sandbox');
  }
  assert.equal(platform.PLATFORM_ENVS.SANDBOX, 'sandbox');
});

test('only PIVOTA_ENV names the sandbox: the word anywhere else resolves exactly as it did before', () => {
  platform.resetPlatformWarnings();
  for (const key of ['NODE_ENV', 'APP_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'VERCEL_ENV']) {
    // On a managed platform an unrecognized name fails closed to production, as before the label existed.
    const managed = { [key]: 'sandbox', K_SERVICE: 'gateway' };
    assert.equal(platform.platformEnv(managed), 'production', key);
    assert.equal(platform.isSandbox(managed), false, key);
    assert.equal(platform.resolvePlatformEnv(managed).resolved, false, key);
    // Off any platform it is development, as before (unless the key itself is a Railway marker).
    if (!key.startsWith('RAILWAY_')) {
      assert.equal(platform.platformEnv({ [key]: 'sandbox' }), 'development', key);
    }
  }
  // Synonyms are not the sandbox.
  for (const raw of ['sbx', 'sand', 'sandbox-1', 'partner-sandbox']) {
    assert.equal(platform.isSandbox({ PIVOTA_ENV: raw, K_SERVICE: 'gateway' }), false, raw);
    assert.equal(platform.platformEnv({ PIVOTA_ENV: raw, K_SERVICE: 'gateway' }), 'production', raw);
  }
});

test('a sandbox label beside a production signal is production to every guard, and not sandbox', () => {
  const env = { PIVOTA_ENV: 'sandbox', NODE_ENV: 'production', K_SERVICE: 'gateway' };
  assert.equal(platform.isProduction(env), true);
  assert.equal(platform.isSandbox(env), false);
  assert.equal(platform.namesSandbox(env), true);
  assert.equal(sandbox.agentApiKeyFormatOk(KEY_TEST, env), false, 'production keys rule');
  assert.equal(sandbox.agentApiKeyFormatOk(KEY_LIVE, env), true);
});

test('production, staging and the local labels answer exactly as before (label, guards, metadata keys)', () => {
  const expected = {
    production_cloud_run: { env: 'production', production: true, staging: false },
    staging_cloud_run: { env: 'staging', production: false, staging: true },
    unnamed_cloud_run_fail_closed: { env: 'production', production: true, staging: false },
    railway_production: { env: 'production', production: true, staging: false },
    local_default: { env: 'development', production: false, staging: false },
    node_test: { env: 'test', production: false, staging: false },
    development: { env: 'development', production: false, staging: false },
  };
  platform.resetPlatformWarnings();
  for (const [name, env] of Object.entries(NON_SANDBOX_ENVS)) {
    assert.equal(platform.platformEnv(env), expected[name].env, name);
    assert.equal(platform.isProduction(env), expected[name].production, name);
    assert.equal(platform.isStaging(env), expected[name].staging, name);
    assert.equal(platform.isSandbox(env), false, name);
    assert.equal(platform.namesSandbox(env), false, name);
    assert.deepEqual(Object.keys(platform.platformMetadata(env)), [
      'platform', 'env', 'env_source', 'env_resolved', 'managed', 'production', 'service', 'commit_sha',
      'commit_sha_short', 'deployment_id', 'revision', 'git_branch',
    ], name);
  }
});

// --------------------------------------------------------------------------------------------------------------
// 2. Keys.
// --------------------------------------------------------------------------------------------------------------

test('key format: the sandbox accepts only ak_test_<64 hex>; it refuses ak_live_ and bare ak_', () => {
  const env = SAFE_SANDBOX;
  assert.equal(sandbox.agentApiKeyFormatOk(KEY_TEST, env), true);
  for (const bad of [
    KEY_LIVE, KEY_BARE, `ak_test_${'a'.repeat(63)}`, `ak_test_${'a'.repeat(65)}`, `ak_test_${'A'.repeat(64)}`,
    `ak_test_${'g'.repeat(64)}`, ` ${KEY_TEST}`, `${KEY_TEST}\n`, 'ak_test_', '', null, undefined, 42,
  ]) {
    assert.equal(sandbox.agentApiKeyFormatOk(bad, env), false, String(bad));
  }
});

test('key format: every other environment keeps today\'s pattern exactly, so ak_test_ stays refused there', () => {
  const TODAY = /^ak_(live_)?[0-9a-f]{64}$/;
  const samples = [KEY_TEST, KEY_LIVE, KEY_BARE, `ak_live_${'a'.repeat(63)}`, `ak_${'A'.repeat(64)}`, 'x', ''];
  for (const [name, env] of Object.entries(NON_SANDBOX_ENVS)) {
    assert.equal(String(sandbox.agentApiKeyPattern(env)), String(TODAY), name);
    for (const key of samples) assert.equal(sandbox.agentApiKeyFormatOk(key, env), TODAY.test(key), `${name} ${key}`);
    assert.equal(sandbox.agentApiKeyFormatOk(KEY_TEST, env), false, name);
  }
});

function reqWith(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, get: (h) => lower[String(h).toLowerCase()] };
}

test('MCP OAuth routing: a Bearer key is an API key by the same per-environment format', async () => {
  const glue = require('../src/commerceMcpOAuth.js');
  const oauthEnv = {
    MCP_OAUTH_ENABLED: '1',
    MCP_OAUTH_RESOURCE: 'https://agent.test.example/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVERS: 'https://auth.test.example',
  };
  const modeFor = (env, key) => withProcessEnv({ ...oauthEnv, PIVOTA_ENV: undefined, K_SERVICE: undefined, NODE_ENV: undefined, ...env }, async () => {
    glue.__resetVerifierCache();
    return (await glue.resolveMcpOAuthIdentity(reqWith({ Authorization: `Bearer ${key}` }))).mode;
  });
  // Sandbox: ak_test_ is the API-key channel; a live key is not (it goes to OAuth and fails verification there).
  assert.equal(await modeFor({ PIVOTA_ENV: 'sandbox' }, KEY_TEST), 'apikey');
  assert.notEqual(await modeFor({ PIVOTA_ENV: 'sandbox' }, KEY_LIVE), 'apikey');
  assert.notEqual(await modeFor({ PIVOTA_ENV: 'sandbox' }, KEY_BARE), 'apikey');
  // Production and staging: as today.
  for (const env of [{ PIVOTA_ENV: 'production' }, { PIVOTA_ENV: 'staging' }]) {
    assert.equal(await modeFor(env, KEY_LIVE), 'apikey');
    assert.equal(await modeFor(env, KEY_BARE), 'apikey');
    assert.notEqual(await modeFor(env, KEY_TEST), 'apikey');
  }
});

// --------------------------------------------------------------------------------------------------------------
// 3. Boot check.
// --------------------------------------------------------------------------------------------------------------

function refusalOf(env) {
  try {
    sandbox.assertSandboxConfig(env);
    return null;
  } catch (err) {
    return err.message;
  }
}

test('boot check: a safe sandbox passes, and every non-sandbox environment is a no-op whatever it sets', () => {
  assert.deepEqual(sandbox.assertSandboxConfig(SAFE_SANDBOX), { sandbox: true });
  assert.deepEqual(sandbox.sandboxConfigProblems(SAFE_SANDBOX), []);
  const unsafe = {
    A2A_RAIL_PILOT_AGENT_IDS: 'agent_x', AGENPAS_RAILS: 'a2a', PIVOTA_API_BASE: 'https://api.pivota.cc',
    UCP_LIVE_OFFER_READ: 'enforce', PIVOTA_API_KEY: KEY_LIVE,
  };
  for (const [name, env] of Object.entries(NON_SANDBOX_ENVS)) {
    assert.deepEqual(sandbox.assertSandboxConfig({ ...env, ...unsafe }), { sandbox: false }, name);
    assert.deepEqual(sandbox.sandboxConfigProblems({ ...env, ...unsafe }), [], name);
  }
});

test('boot check: refuses a sandbox label beside a production signal, naming the setting', () => {
  const msg = refusalOf({ ...SAFE_SANDBOX, NODE_ENV: 'production' });
  assert.match(msg, /^SANDBOX_CONFIG_REFUSED: /);
  assert.match(msg, /NODE_ENV\(names production\)/);
});

test('boot check: AGENPAS_RAILS must be exactly reap, and must actually mint reap (consent on)', () => {
  for (const raw of [undefined, '', 'a2a', 'reap,a2a', 'a2a,reap', 'REAP', 'reap,', 'reapx']) {
    const env = { ...SAFE_SANDBOX, AGENPAS_RAILS: raw };
    if (raw === undefined) delete env.AGENPAS_RAILS;
    assert.match(refusalOf(env) || '', /AGENPAS_RAILS\(must be exactly reap\)/, String(raw));
  }
  // `reap` with consent off: AgenPas would fall back to a2a (src/agenpas/config.js rails), so it is refused.
  const noConsent = { ...SAFE_SANDBOX };
  delete noConsent.AGENPAS_CONSENT_ENABLED;
  assert.deepEqual(require('../src/agenpas/config').rails(noConsent, () => {}), ['a2a'], 'the real producer falls back');
  assert.match(refusalOf(noConsent), /AGENPAS_CONSENT_ENABLED\(must be on for the reap rail\)/);
});

test('boot check: any A2A_RAIL_* setting is refused by name, even an empty one', () => {
  for (const key of ['A2A_RAIL_PILOT_AGENT_IDS', 'A2A_RAIL_BASE_URL', 'A2A_RAIL_ENABLED', 'A2A_RAIL_']) {
    for (const value of ['x', '']) {
      const msg = refusalOf({ ...SAFE_SANDBOX, [key]: value });
      assert.ok(msg && msg.includes(`${key}(no A2A rail setting may be set)`), `${key}=${JSON.stringify(value)}: ${msg}`);
    }
  }
});

test('boot check: the backend base URL must be set, a URL, and not a prod or staging host', () => {
  const unset = { ...SAFE_SANDBOX };
  delete unset.PIVOTA_API_BASE;
  assert.match(refusalOf(unset), /PIVOTA_API_BASE\(must be set\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, PIVOTA_API_BASE: 'not a url' }), /PIVOTA_API_BASE\(not a URL\)/);
  for (const url of [
    'https://api.pivota.cc', 'https://API.PIVOTA.CC.', 'https://api.pivota.cc:443/v1',
    'https://web-zq7stand1n-uw.a.run.app', 'https://refresh-1fa77019be32---web-zq7stand1n-uw.a.run.app',
    'https://web-900000000001.us-west1.run.app', 'https://web-production-fedb.up.railway.app',
    'https://web-zq7stand2n-uw.a.run.app', 'https://web-900000000002.us-west1.run.app',
    'https://api.staging.pivota.cc',
  ]) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, PIVOTA_API_BASE: url }) || '', /PIVOTA_API_BASE\(prod or staging host\)/, url);
  }
  // Hosts that merely resemble prod are not prod (with the introspect URL on the same backend).
  for (const url of ['https://sandbox-api.pivota.cc', 'https://web-sbx0exampl-uw.a.run.app']) {
    assert.equal(refusalOf({ ...SAFE_SANDBOX, PIVOTA_API_BASE: url, AGENT_AUTH_INTROSPECT_URL: `${url}/agent/internal/auth/introspect` }), null, url);
  }
  // ...but the ALLOW list refuses a backend that is neither the sandbox's run.app project nor a sandbox host.
  assert.match(refusalOf({ ...SAFE_SANDBOX, PIVOTA_API_BASE: 'https://api.pivota.cc.example.org', AGENT_AUTH_INTROSPECT_URL: undefined }) || '',
    /PIVOTA_API_BASE\(must be the sandbox backend: a run\.app host or a sandbox host\)/);
});

test('boot check: every backend URL setting, and any other setting, naming a prod or staging service is refused', () => {
  for (const key of sandbox.BACKEND_URL_SETTINGS) {
    const msg = refusalOf({ ...SAFE_SANDBOX, [key]: 'https://web-zq7stand1n-uw.a.run.app/x' });
    assert.ok(msg && msg.includes(`${key}(prod or staging host)`), `${key}: ${msg}`);
    assert.equal(msg.split(`${key}(`).length - 1, 1, `${key} named once`);
  }
  // A setting the check does not know by name: the scan still finds a prod Cloud Run service in it.
  assert.match(refusalOf({ ...SAFE_SANDBOX, CATALOG_INTELLIGENCE_BASE_URL: 'https://catalog-intelligence-zq7stand1n-uw.a.run.app' }),
    /CATALOG_INTELLIGENCE_BASE_URL\(prod or staging host\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, SOME_LIST: 'https://a.example, https://api.pivota.cc' }), /SOME_LIST\(prod or staging host\)/);
});

test('boot check: a refusal names the setting and never prints its value', () => {
  const SECRET = 'S3CRETvalue9f8e7d';
  const msg = refusalOf({
    ...SAFE_SANDBOX,
    PIVOTA_API_BASE: `https://user:${SECRET}@api.pivota.cc/x?k=${SECRET}`,
    A2A_RAIL_TOKEN: SECRET,
    PIVOTA_API_KEY: `ak_live_${HEX64}`,
    UCP_LIVE_OFFER_READ: `enforce${SECRET}`,
  });
  assert.ok(msg);
  for (const leaked of [SECRET, 'api.pivota.cc', HEX64, 'enforce']) assert.equal(msg.includes(leaked), false, leaked);
  for (const name of ['PIVOTA_API_BASE', 'A2A_RAIL_TOKEN', 'PIVOTA_API_KEY', 'UCP_LIVE_OFFER_READ']) assert.ok(msg.includes(`${name}(`), name);
});

// The REAL readers, so "off" here is what each feature itself reads as off (not what this test thinks it is).
const REAL_READERS = {
  UCP_LIVE_OFFER_READ: (env) => require('../src/services/ucpLiveOfferRead').readMode(env, 'UCP_LIVE_OFFER_READ') !== 'off',
  UCP_LIVE_SEARCH_READ: (env) => require('../src/services/ucpLiveOfferRead').readMode(env, 'UCP_LIVE_SEARCH_READ') !== 'off',
  UCP_LIVE_PRODUCT_READ: (env) => require('../src/services/ucpLiveOfferRead').readMode(env, 'UCP_LIVE_PRODUCT_READ') !== 'off',
  UCP_LIVE_PDP_READ: (env) => require('../src/services/ucpLiveOfferRead').readMode(env, 'UCP_LIVE_PDP_READ') !== 'off',
  GET_OFFERS_LIVE_CART: (env) => require('../src/services/offerLiveVerification').liveCartMode(env) !== 'off',
  SERVE_LIVE_MERCHANT_PRICE: (env) => require('../src/api/gateway/access/invokeAuthEmergencyFallback').parseBooleanEnv(env.SERVE_LIVE_MERCHANT_PRICE, false),
  CAFE24_CATALOG_SEARCH: (env) => require('../src/services/cafe24GlobalCatalog').readMode(env) !== 'off',
  CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED: (env) => require('../src/services/externalSeedImageCacheBootstrap').buildBootstrapConfig(env).enabled,
  CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED: (env) => require('../src/services/externalSeedImageCacheJobRunner').buildRunnerConfig(env).enabled,
};
const ON_VALUES = ['shadow', 'enforce', 'on', 'true', '1', 'yes', 'ON', ' enforce '];

test('boot check: every live-read / store-fetch flag the real reader would arm is refused by name', () => {
  for (const { name } of sandbox.LIVE_READ_FLAGS) {
    for (const value of ON_VALUES) {
      const msg = refusalOf({ ...SAFE_SANDBOX, [name]: value });
      assert.ok(msg && msg.includes(`${name}(must be off`), `${name}=${value}`);
    }
    // A typo the reader would read as off still fails loudly here.
    assert.ok((refusalOf({ ...SAFE_SANDBOX, [name]: 'enforcee' }) || '').includes(`${name}(`), `${name} typo`);
    // And every reader we can reach agrees that each value the check lets through is OFF.
    const reader = REAL_READERS[name];
    if (!reader) continue;
    for (const value of ON_VALUES) {
      if (reader({ [name]: value })) assert.ok(refusalOf({ ...SAFE_SANDBOX, [name]: value }), `${name}=${value} armed but passed`);
    }
  }
  for (const [name, reader] of Object.entries(REAL_READERS)) {
    for (const value of sandbox.OFF_SPELLINGS) {
      assert.equal(refusalOf({ ...SAFE_SANDBOX, [name]: value }), null, `${name}=${value}`);
      assert.equal(reader({ [name]: value }), false, `the real reader reads ${name}=${value} as off`);
    }
  }
  assert.deepEqual(Object.keys(REAL_READERS).filter((n) => !sandbox.LIVE_READ_FLAGS.some((f) => f.name === n)), []);
});

test('boot check: the image cache job runner defaults ON, so the sandbox must set it off explicitly', () => {
  const env = { ...SAFE_SANDBOX };
  delete env.CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED;
  assert.equal(REAL_READERS.CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED(env), true, 'the real default is on');
  assert.match(refusalOf(env), /CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED\(must be off, set explicitly\)/);
  // The others default off: unset passes.
  const others = { ...SAFE_SANDBOX };
  for (const { name, requireExplicit } of sandbox.LIVE_READ_FLAGS) if (!requireExplicit) delete others[name];
  assert.equal(refusalOf(others), null);
});

test('boot check: a live-format key in any of the gateway\'s own key settings is refused; ak_test_ passes', () => {
  for (const key of sandbox.SERVICE_KEY_SETTINGS) {
    for (const value of [KEY_LIVE, KEY_BARE, `${KEY_TEST},${KEY_LIVE}`, ` ${KEY_BARE} `]) {
      const msg = refusalOf({ ...SAFE_SANDBOX, [key]: value });
      assert.ok(msg && msg.includes(`${key}(live-format key)`), `${key}`);
    }
    assert.equal(refusalOf({ ...SAFE_SANDBOX, [key]: `${KEY_TEST}, ak_test_${'b'.repeat(64)}` }), null, key);
    assert.equal(refusalOf({ ...SAFE_SANDBOX, [key]: 'some-non-ak-service-token' }), null, key);
  }
});

test('boot check: the server may never run its own DB migrations in the sandbox (boot or first use)', () => {
  for (const v of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes']) {
    const env = { ...SAFE_SANDBOX, SKIP_DB_MIGRATIONS: v };
    if (v === undefined) delete env.SKIP_DB_MIGRATIONS;
    assert.ok((refusalOf(env) || '').includes('SKIP_DB_MIGRATIONS(must be exactly true)'), JSON.stringify(v));
  }
  for (const v of [undefined, '', 'true', '0', 'off', 'no', ' false']) {
    const env = { ...SAFE_SANDBOX, DB_AUTO_MIGRATE: v };
    if (v === undefined) delete env.DB_AUTO_MIGRATE;
    assert.ok((refusalOf(env) || '').includes('DB_AUTO_MIGRATE(must be false)'), JSON.stringify(v));
  }
  assert.equal(refusalOf({ ...SAFE_SANDBOX, DB_AUTO_MIGRATE: 'FALSE' }), null, 'the boot reader lowercases');
  // Outside the sandbox nothing about migrations changes.
  for (const [name, env] of Object.entries(NON_SANDBOX_ENVS)) {
    assert.deepEqual(sandbox.sandboxConfigProblems({ ...env, DB_AUTO_MIGRATE: 'true' }), [], name);
  }
});

test('boot check: the migration spellings it requires are exactly the ones the real readers test', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  // The four first-use callers: each skips runMigrations() only on the exact string 'true'.
  for (const f of ['src/services/taxonomyStore.js', 'src/telemetry/outcomeStore.js',
    'src/layer1/storage/compatibilitySamplesUS.js', 'src/layer1/storage/layer1BundleSamplesUS.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(src.includes("process.env.SKIP_DB_MIGRATIONS === 'true'"), f);
  }
  // And nothing else in src/ runs the migrations but those four, the boot path and the CLI.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
    return /\.(c|m)?js$/.test(d.name) && fs.readFileSync(p, 'utf8').includes('await runMigrations()') ? [path.relative(root, p)] : [];
  });
  const callers = walk(path.join(root, 'src')).sort();
  assert.deepEqual(callers, ['src/db/cli.js', 'src/layer1/storage/compatibilitySamplesUS.js', 'src/layer1/storage/layer1BundleSamplesUS.js',
    'src/server.js', 'src/services/taxonomyStore.js', 'src/telemetry/outcomeStore.js']);
  const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  assert.ok(server.includes("String(process.env.DB_AUTO_MIGRATE || '').toLowerCase() === 'false'"), 'the boot reader');
});

test('boot check: a test runtime (which can bypass invoke auth) is refused in the sandbox', () => {
  assert.match(refusalOf({ ...SAFE_SANDBOX, NODE_ENV: 'test' }), /NODE_ENV\(test disables auth\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, JEST_WORKER_ID: '1' }), /JEST_WORKER_ID\(test disables auth\)/);
});

test('isRefusedHost: the prod and staging projects and hosts, nothing that only resembles them', () => {
  for (const h of ['api.pivota.cc', 'API.pivota.cc.', 'x-zq7stand1n-uw.a.run.app', 'x-900000000001.europe-west1.run.app',
    'x-zq7stand2n-uw.a.run.app', 'x-900000000002.us-west1.run.app', 'a.staging.pivota.cc', 'staging.pivota.cc',
    'web-production-fedb.up.railway.app']) assert.equal(sandbox.isRefusedHost(h), true, h);
  for (const h of ['', 'pivota.cc', 'sandbox.mcp.pivota.cc', 'sandbox-api.pivota.cc', 'zq7stand1n.example.com',
    'x-zq7stand1n-uw.a.run.app.example.com', 'x-sbx0example-uw.a.run.app', 'stagingpivota.cc']) {
    assert.equal(sandbox.isRefusedHost(h), false, h);
  }
});

// --------------------------------------------------------------------------------------------------------------
// 4. Decision 4: fresh copied prices, and the sandbox mark.
// --------------------------------------------------------------------------------------------------------------

const { offersToSignals } = require('../src/agentSignals/offerToSignal');

const NOW = Date.parse('2026-11-25T12:00:00Z');
function contractOffers() {
  return [
    // A copied catalog price read 30 days ago: the backend flags it stale by age.
    { offer_id: 'o_old', merchant_id: 'm1', price: 10, currency: 'USD', in_stock: true, price_comparable: true,
      price_stale: true, price_checked_at: '2026-10-26T12:00:00Z' },
    // A seed held for live verification: stale for a reason that is not age (it has no cart).
    { offer_id: 'o_held', merchant_id: 'm2', price: 9, currency: 'USD', in_stock: true, price_stale: true,
      requires_live_verification: { lookup_variant_id: 'v1' } },
    // The gateway's live read found this market unpriced.
    { offer_id: 'o_unpriced', merchant_id: 'm3', price: 8, currency: 'USD', in_stock: true, price_comparable: true,
      live_read: { status: 'currency_mismatch' } },
  ];
}
const staleIds = (out) => out.signals.filter((s) => s.value.price_stale === true).map((s) => s.value.merchant_id);

test('decision 4: in the sandbox a copied price is never stale by age; non-age staleness stands', () => {
  const out = withProcessEnv({ PIVOTA_ENV: 'sandbox', NODE_ENV: undefined },
    () => offersToSignals(contractOffers(), { productId: 'p1', bestPriceOfferId: 'o_old', now: () => NOW }));
  assert.deepEqual(staleIds(out), ['m2', 'm3']);
  // The old copied price can now be the best price (it was excluded as stale before).
  assert.equal(out.best_price.offer_id, 'o_old');
});

test('decision 4: production and staging still flag the old price stale, byte-identical to before', () => {
  for (const env of [{ PIVOTA_ENV: 'production', K_SERVICE: 'gateway' }, { PIVOTA_ENV: 'staging', K_SERVICE: 'gateway' }, { PIVOTA_ENV: undefined, K_SERVICE: undefined }]) {
    const out = withProcessEnv({ NODE_ENV: undefined, ...env },
      () => offersToSignals(contractOffers(), { productId: 'p1', bestPriceOfferId: 'o_old', now: () => NOW }));
    assert.deepEqual(staleIds(out), ['m1', 'm2', 'm3'], JSON.stringify(env));
    assert.equal(out.best_price.offer_id, null);
    assert.equal(out.best_price.reason, 'no_fresh_comparable_price');
  }
});

test('decision 4: the list staleness demote is off in the sandbox whatever its flag; unchanged elsewhere', () => {
  const { priceStalenessMode } = require('../src/services/listPriceTiers');
  for (const v of ['on', 'shadow', 'true']) {
    assert.equal(priceStalenessMode({ PIVOTA_ENV: 'sandbox', PRICE_STALENESS_DEMOTE: v }), 'off', v);
    assert.equal(priceStalenessMode({ PIVOTA_ENV: 'production', PRICE_STALENESS_DEMOTE: v }), v === 'shadow' ? 'shadow' : 'on', v);
    assert.equal(priceStalenessMode({ PIVOTA_ENV: 'staging', PRICE_STALENESS_DEMOTE: v }), v === 'shadow' ? 'shadow' : 'on', v);
  }
});

async function adapterAnswer({ callTool, formatResult } = {}) {
  const { createRemoteMcpAdapter } = await import('../mcp-server/src/remoteMcpAdapter.js');
  const surface = { tools: [{ name: 'search_catalog' }], callTool };
  const adapter = createRemoteMcpAdapter(surface, { allowUnauthenticated: true, ...(formatResult ? { formatResult } : {}) });
  const out = await adapter.handleJsonRpc({ headers: {}, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_catalog', arguments: {} } } });
  return out.body.result;
}

test('sandbox mark: every MCP tool answer carries top-level sandbox:true and _meta.sandbox, in one place', async () => {
  const value = { products: [{ id: 'p1', price: 10 }], metadata: { lane: 'x' } };
  await withProcessEnv({ PIVOTA_ENV: 'sandbox', NODE_ENV: undefined }, async () => {
    const result = await adapterAnswer({ callTool: async () => value });
    assert.deepEqual(JSON.parse(result.content[0].text), { ...value, sandbox: true });
    assert.deepEqual(result._meta, { sandbox: true });
    assert.equal('sandbox' in value, false, 'the surface value is not mutated');
    // An error answer is marked too.
    const err = await adapterAnswer({ callTool: async () => { throw new Error('boom'); } });
    assert.equal(err.isError, true);
    assert.deepEqual(err._meta, { sandbox: true });
    // A structured formatter's answer gets it in structuredContent, and an existing _meta is kept.
    const structured = await adapterAnswer({
      callTool: async () => value,
      formatResult: (v) => ({ content: [{ type: 'text', text: 'summary' }], structuredContent: { products: v.products }, _meta: { a: 1 } }),
    });
    assert.deepEqual(structured.structuredContent, { products: value.products, sandbox: true });
    assert.deepEqual(structured._meta, { a: 1, sandbox: true });
  });
});

test('sandbox mark: outside the sandbox the answer is byte-identical to the unmarked one', async () => {
  const value = { products: [{ id: 'p1', price: 10 }] };
  const { toToolResult, toToolError } = await import('../mcp-server/src/commerceToolSurface.js');
  for (const env of [{ PIVOTA_ENV: 'production', K_SERVICE: 'gateway' }, { PIVOTA_ENV: 'staging', K_SERVICE: 'gateway' }, { PIVOTA_ENV: undefined, K_SERVICE: undefined }]) {
    await withProcessEnv({ NODE_ENV: undefined, ...env }, async () => {
      const result = await adapterAnswer({ callTool: async () => value });
      assert.equal(JSON.stringify(result), JSON.stringify(toToolResult(value)), JSON.stringify(env));
      const err = await adapterAnswer({ callTool: async () => { throw new Error('boom'); } });
      assert.equal(JSON.stringify(err), JSON.stringify(toToolError(new Error('boom'))), JSON.stringify(env));
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// 5. The two guards that would otherwise open on a public, non-production deploy.
// --------------------------------------------------------------------------------------------------------------

test('recommendations internal route: an empty key refuses in the sandbox as in production', async () => {
  const { mountRecommendationRoutes } = require('../src/recommendations/routes');
  const app = express();
  app.use(express.json());
  mountRecommendationRoutes(app);
  const call = (env) => withProcessEnv({ RECOMMENDATIONS_INTERNAL_KEY: undefined, NODE_ENV: undefined, APP_ENV: undefined, K_SERVICE: undefined, ...env },
    // `await` inside: supertest sends on .then, which must happen while the env is still set.
    async () => supertest(app).post('/v1/recommendations/roles/normalize').send({ roleHints: ['cleanser'] }).then((r) => r));
  const sbx = await call({ PIVOTA_ENV: 'sandbox', K_SERVICE: 'gateway' });
  assert.equal(sbx.status, 500);
  assert.equal(sbx.body.error, 'CONFIG_MISSING');
  const prod = await call({ PIVOTA_ENV: 'production' });
  assert.equal(prod.status, 500);
  // Staging: unchanged (it falls through today, as it did before this change).
  const staging = await call({ PIVOTA_ENV: 'staging' });
  assert.notEqual(staging.body.error, 'CONFIG_MISSING');
});

test('aurora forced-variant header: guarded in the sandbox as in production; free on staging as before', () => {
  const { __internal } = require('../src/auroraBff/rollout');
  const req = { get: (h) => ({ 'x-aurora-force-variant': 'v2_weather' })[String(h).toLowerCase()] };
  const forced = (env) => withProcessEnv({ AURORA_FORCE_VARIANT_ENABLED: undefined, NODE_ENV: undefined, K_SERVICE: undefined, ...env },
    () => __internal.resolveForcedVariant({ req }));
  assert.equal(forced({ PIVOTA_ENV: 'sandbox', K_SERVICE: 'gateway' }), null);
  assert.equal(forced({ PIVOTA_ENV: 'production' }), null);
  assert.notEqual(forced({ PIVOTA_ENV: 'staging' }), null);
});

// --------------------------------------------------------------------------------------------------------------
// 6. The shipped project digests.
// --------------------------------------------------------------------------------------------------------------

test('shipped project digests: four distinct 64-hex scrypt digests, and the stand-ins are not among them', () => {
  const shipped = sandbox.SHIPPED_REFUSED_PROJECT_DIGESTS;
  assert.equal(shipped.length, 4);
  assert.equal(new Set(shipped).size, 4);
  for (const d of shipped) assert.match(d, /^[0-9a-f]{64}$/);
  for (const part of STAND_IN_PROJECT_PARTS) assert.equal(shipped.includes(sandbox.projectPartDigest(part)), false, part);
  // With the shipped list restored, a stand-in host is no longer refused: the override is what refused it above.
  sandbox.setRefusedProjectDigestsForTests();
  try {
    assert.equal(sandbox.isRefusedHost('web-zq7stand1n-uw.a.run.app'), false);
    assert.equal(sandbox.isRefusedHost('web-900000000001.us-west1.run.app'), false);
  } finally {
    sandbox.setRefusedProjectDigestsForTests(STAND_IN_PROJECT_PARTS.map(sandbox.projectPartDigest));
  }
});

test('shipped project digests match the REAL project parts (only when they are given locally; never commit them)', (t) => {
  const raw = String(process.env.SANDBOX_REFUSED_PROJECT_PARTS_FOR_TEST || '').trim();
  if (!raw) {
    t.skip('SANDBOX_REFUSED_PROJECT_PARTS_FOR_TEST not set: prod hash, prod number, staging hash, staging number');
    return;
  }
  const parts = raw.split(',').map((x) => x.trim());
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map(sandbox.projectPartDigest), [...sandbox.SHIPPED_REFUSED_PROJECT_DIGESTS]);
  sandbox.setRefusedProjectDigestsForTests();
  try {
    const [prodHash, prodNumber, stagingHash, stagingNumber] = parts;
    for (const host of [
      `web-${prodHash}-uw.a.run.app`, `refresh-1fa77019be32---web-${prodHash}-uw.a.run.app`,
      `catalog-intelligence-${prodHash}-uw.a.run.app`, `web-${prodNumber}.us-west1.run.app`,
      `gateway-${stagingHash}-uw.a.run.app`, `web-${stagingNumber}.us-west1.run.app`,
    ]) {
      assert.equal(sandbox.isRefusedHost(host), true, 'a real prod or staging host is refused');
      assert.match(refusalOf({ ...SAFE_SANDBOX, PIVOTA_API_BASE: `https://${host}` }) || '', /PIVOTA_API_BASE\(prod or staging host\)/);
    }
  } finally {
    sandbox.setRefusedProjectDigestsForTests(STAND_IN_PROJECT_PARTS.map(sandbox.projectPartDigest));
  }
});

// --------------------------------------------------------------------------------------------------------------
// 7. Review fixes: digest known answers, the override guard, test runtimes, the response marks.
// --------------------------------------------------------------------------------------------------------------

test('project digest known answers: CI pins the salt and scrypt parameters (stand-in inputs only)', () => {
  // If the salt, N/r/p or output length change, these change, and so would every shipped digest.
  assert.equal(sandbox.projectPartDigest('zq7stand1n'), '4e14c7a7a1e6129e0072909c790c9d679b505b60e286bfa9c12ba719253b0529');
  assert.equal(sandbox.projectPartDigest('900000000001'), 'f116f9d8e548ed10a6dd16cef7a68155a31b2d3ee0f922b51e75e081f7247ca4');
});

test('the refused-project override throws outside a test runtime', () => {
  withProcessEnv({ NODE_ENV: undefined, NODE_TEST_CONTEXT: undefined, JEST_WORKER_ID: undefined }, () => {
    assert.throws(() => sandbox.setRefusedProjectDigestsForTests([]), /test-only/);
  });
  // Inside one it still works (the suite relies on it).
  sandbox.setRefusedProjectDigestsForTests(STAND_IN_PROJECT_PARTS.map(sandbox.projectPartDigest));
});

test('boot check: every spelling of a test runtime is refused (NODE_ENV any case, NODE_TEST_CONTEXT)', () => {
  for (const v of ['test', 'TEST', 'Test', ' test ']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, NODE_ENV: v }) || '', /NODE_ENV\(test disables auth\)/, v);
  }
  assert.match(refusalOf({ ...SAFE_SANDBOX, NODE_TEST_CONTEXT: 'child-v8' }) || '', /NODE_TEST_CONTEXT\(test runtime\)/);
  // Every value the platform's own reader calls a test runtime is refused.
  for (const extra of [{ NODE_ENV: 'test' }, { NODE_ENV: 'TEST' }, { NODE_TEST_CONTEXT: 'x' }]) {
    const env = { ...SAFE_SANDBOX, ...extra };
    if (platform.isTestRuntime(env)) assert.ok(refusalOf(env), JSON.stringify(extra));
  }
});

test('response marks: JSON-RPC results, JSON-RPC errors, batches and plain bodies', () => {
  const m = sandbox.markSandboxResponseBody;
  assert.deepEqual(m({ jsonrpc: '2.0', id: 1, result: { content: [], isError: true } }),
    { jsonrpc: '2.0', id: 1, result: { content: [], isError: true, _meta: { sandbox: true } } });
  assert.deepEqual(m({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error.' } }),
    { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error.', data: { sandbox: true } } });
  assert.deepEqual(m({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'x', data: { a: 1 } } }).error.data, { a: 1, sandbox: true });
  assert.deepEqual(m([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'm' } }]),
    [{ jsonrpc: '2.0', id: 1, result: { _meta: { sandbox: true } } }, { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'm', data: { sandbox: true } } }]);
  assert.deepEqual(m({ error: 'mcp_unavailable' }), { error: 'mcp_unavailable', sandbox: true });
  assert.equal(m('text'), 'text');
  assert.equal(m(null), null);
  const body = { a: 1 };
  m(body);
  assert.deepEqual(body, { a: 1 }, 'never mutates');
  // The conditional helpers are identities outside the sandbox.
  const out = { status: 200, headers: {}, body: { jsonrpc: '2.0', id: 1, result: {} } };
  for (const [name, env] of Object.entries(NON_SANDBOX_ENVS)) {
    assert.equal(sandbox.markSandboxRpcOutcome(out, env), out, name);
    assert.equal(sandbox.markSandboxRpcBody(out.body, env), out.body, name);
  }
  assert.deepEqual(sandbox.markSandboxRpcOutcome(out, SAFE_SANDBOX).body.result, { _meta: { sandbox: true } });
  assert.deepEqual(sandbox.markSandboxRpcBody({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'm' } }, SAFE_SANDBOX).error.data, { sandbox: true });
});

test('response marks middleware: header on every path, bodies only on marked paths, nothing outside the sandbox', async () => {
  const app = express();
  app.use(sandbox.sandboxResponseMarks((req) => req.path === '/marked'));
  app.get('/marked', (req, res) => res.status(401).json({ error: 'UNAUTHORIZED' }));
  app.get('/other', (req, res) => res.json({ ok: true }));
  const call = (env, p) => withProcessEnv({ PIVOTA_ENV: undefined, NODE_ENV: undefined, K_SERVICE: undefined, ...env },
    async () => supertest(app).get(p).then((r) => r));
  const sbxMarked = await call({ PIVOTA_ENV: 'sandbox' }, '/marked');
  assert.equal(sbxMarked.headers['x-pivota-env'], 'sandbox');
  assert.deepEqual(sbxMarked.body, { error: 'UNAUTHORIZED', sandbox: true });
  assert.equal(sbxMarked.status, 401);
  const sbxOther = await call({ PIVOTA_ENV: 'sandbox' }, '/other');
  assert.equal(sbxOther.headers['x-pivota-env'], 'sandbox');
  assert.deepEqual(sbxOther.body, { ok: true });
  for (const env of [{ PIVOTA_ENV: 'production' }, { PIVOTA_ENV: 'staging' }, {}]) {
    const r = await call(env, '/marked');
    assert.equal(r.headers['x-pivota-env'], undefined, JSON.stringify(env));
    assert.deepEqual(r.body, { error: 'UNAUTHORIZED' }, JSON.stringify(env));
  }
});

// --------------------------------------------------------------------------------------------------------------
// 8. Pre-deploy hardening: the ALLOW list, the second sandbox signal, private endpoints, marked paths.
//
// The env-gated real-ID test (section 6) runs under `node --test`, e.g.
//   SANDBOX_REFUSED_PROJECT_PARTS_FOR_TEST=<prod hash>,<prod number>,<staging hash>,<staging number> \
//     node --test tests/partner_sandbox_config.node.test.cjs
// Never commit those values.
// --------------------------------------------------------------------------------------------------------------

test('allow list: every run.app host must be in the sandbox backend\'s own Cloud Run project', () => {
  // Same project, other services and forms of the same hash: allowed.
  for (const url of ['https://gateway-sbx0exampl-uw.a.run.app', 'https://tag1---web-sbx0exampl-uw.a.run.app/x']) {
    assert.equal(refusalOf({ ...SAFE_SANDBOX, SOME_SERVICE_URL: url }), null, url);
  }
  // Any other project, listed anywhere or not: refused (a prod project nobody listed is still refused).
  for (const url of ['https://web-zz9unknown-uw.a.run.app', 'https://web-123456789012.us-west1.run.app', 'https://odd.run.app']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, SOME_SERVICE_URL: url }) || '', /SOME_SERVICE_URL\(names a Cloud Run host outside the sandbox project\)/, url);
  }
  // A backend on a sandbox custom domain: then no run.app host is allowed at all.
  const custom = { ...SAFE_SANDBOX, PIVOTA_API_BASE: 'https://sandbox-api.pivota.cc', AGENT_AUTH_INTROSPECT_URL: 'https://sandbox-api.pivota.cc/x' };
  assert.equal(refusalOf(custom), null);
  assert.match(refusalOf({ ...custom, SOME_SERVICE_URL: 'https://gateway-sbx0exampl-uw.a.run.app' }) || '', /SOME_SERVICE_URL\(names a Cloud Run host/);
});

test('allow list: brand-zone hosts must be sandbox hosts; Railway, prod project names and prod IPs are refused', () => {
  for (const [value, why] of [
    ['https://gateway.pivota.cc', 'names a non-sandbox pivota.cc host'],
    ['https://agent.pivota.cc/api/gateway', 'names a non-sandbox pivota.cc host'],
    ['https://commerce.mcp.pivota.cc/mcp', 'names a non-sandbox pivota.cc host'],
    ['https://mcp.pivota.cc', 'names a non-sandbox pivota.cc host'],
    ['https://pivota.cc', 'names a non-sandbox pivota.cc host'],
    ['https://pay.agenpaz.com', 'names a non-sandbox agenpaz.com host'],
    ['https://api.reap.global', 'names a non-sandbox reap.global host'],
    ['https://pivota-agent-production.up.railway.app', 'names a Railway host'],
    ['redis.railway.internal:6379', 'names a Railway host'],
    ['pivota-prod:us-west1:pivota-pg', 'names a prod or staging GCP project'],
    ['projects/pivota-staging/secrets/x', 'names a prod or staging GCP project'],
    ['10.250.250.1', 'names a prod or staging database/Redis address'],
    ['redis://10.250.250.2:6379', 'names a prod or staging database/Redis address'],
  ]) {
    assert.ok((refusalOf({ ...SAFE_SANDBOX, SOME_SETTING: value }) || '').includes(`SOME_SETTING(${why})`), value);
  }
  for (const value of ['https://sandbox.mcp.pivota.cc', 'https://sandbox.agenpaz.com', 'https://sandbox.api.reap.global',
    'pivota-sandbox', 'pivota-prodx', '10.250.250.10', 'https://sandbox.collect.prava.space', 'https://sandbox-api.pivota.cc']) {
    assert.equal(refusalOf({ ...SAFE_SANDBOX, SOME_SETTING: value }), null, value);
  }
  // The display-only legal-link hosts: allowed in AGENPAS_LEGAL_HOSTS only, and only those two.
  assert.equal(refusalOf({ ...SAFE_SANDBOX, AGENPAS_LEGAL_HOSTS: 'pivota.cc,merchant.pivota.cc' }), null);
  assert.match(refusalOf({ ...SAFE_SANDBOX, AGENPAS_LEGAL_HOSTS: 'pivota.cc,agent.pivota.cc' }) || '', /AGENPAS_LEGAL_HOSTS\(names a non-sandbox pivota\.cc host\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, OTHER_LINKS: 'pivota.cc' }) || '', /OTHER_LINKS\(names a non-sandbox/);
});

test('GOOGLE_CLOUD_PROJECT must be a sandbox-shaped project id (pattern, no environment word)', () => {
  for (const ok of ['pivota-sandbox', 'zz-sandbox-standin', 'acme-partner-sbx']) {
    assert.equal(sandbox.sandboxProjectProblem(ok), null, ok);
    assert.equal(refusalOf({ ...SAFE_SANDBOX, GOOGLE_CLOUD_PROJECT: ok }), null, ok);
  }
  for (const [bad, why] of [[undefined, 'must be set'], ['', 'must be set'], ['pivota-prod', 'names another environment'],
    ['pivota-staging', 'names another environment'], ['pivota-shared', 'names another environment'], ['x-stg-1', 'names another environment'],
    ['Pivota-Sandbox', 'not a GCP project id'], ['abc', 'not a GCP project id'], ['pivota_sandbox', 'not a GCP project id']]) {
    const env = { ...SAFE_SANDBOX, GOOGLE_CLOUD_PROJECT: bad };
    if (bad === undefined) delete env.GOOGLE_CLOUD_PROJECT;
    assert.ok((refusalOf(env) || '').includes(`GOOGLE_CLOUD_PROJECT(${why})`), String(bad));
  }
  // The project-naming settings must name the same project.
  assert.equal(refusalOf({ ...SAFE_SANDBOX, PRICE_CACHE_FIRESTORE_PROJECT: 'zz-sandbox-standin' }), null);
  assert.match(refusalOf({ ...SAFE_SANDBOX, PRICE_CACHE_FIRESTORE_PROJECT: 'zz-other-project' }) || '', /PRICE_CACHE_FIRESTORE_PROJECT\(must be the sandbox project\)/);
  // The Vertex project settings are refused outright now (round 3): see the lexical-only tests.
});

test('private endpoints: DATABASE_URL / PGHOST / REDIS_* only on a private IP or the sandbox project\'s Cloud SQL socket', () => {
  const SECRET = 'pwS3cret0value';
  for (const ok of [`postgresql://u:${SECRET}@10.61.0.5:5432/pivota`, 'postgresql://u@/x?host=/cloudsql/zz-sandbox-standin:us-west1:pg',
    'postgresql://u@172.20.1.2/x', 'postgresql://u@192.168.4.4/x']) {
    assert.equal(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: ok }), null, ok.replace(SECRET, '***'));
  }
  for (const [bad, why] of [
    ['postgresql://u@db.example.com/x', 'not a private address'],
    ['postgresql://u@34.1.2.3/x', 'not a private address'],
    ['postgresql://u@/x?host=/cloudsql/zz-other-project:us-west1:pg', 'Cloud SQL socket outside the sandbox project'],
  ]) {
    assert.ok((refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: bad }) || '').includes(`DATABASE_URL(${why})`), bad);
  }
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: `postgresql://u:${SECRET}@10.250.250.3/x` }) || '', /DATABASE_URL\(names a prod or staging database\/Redis address\)/);
  assert.equal((refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: `postgresql://u:${SECRET}@db.example.com/x` }) || '').includes(SECRET), false, 'never the value');
  assert.match(refusalOf({ ...SAFE_SANDBOX, PGHOST: 'db.example.com' }) || '', /PGHOST\(not a private address\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, REDIS_URL: 'redis://cache.example.com:6379' }) || '', /REDIS_URL\(not a private address\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, REDIS_HOST: 'cache.example.com' }) || '', /REDIS_HOST\(not a private address\)/);
  assert.equal(refusalOf({ ...SAFE_SANDBOX, REDIS_HOST: '10.61.0.9' }), null);
});

test('Aurora: its fail-closed switches are refused in the sandbox (the BFF is not loaded there)', () => {
  for (const key of ['AURORA_ROUTES_FAIL_CLOSED', 'AURORA_BFF_FAIL_CLOSED']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, [key]: 'true' }) || '', new RegExp(`${key}\\(the Aurora BFF is not loaded in the sandbox\\)`));
    assert.equal(refusalOf({ ...SAFE_SANDBOX, [key]: 'false' }), null, key);
  }
});

test('marked paths: the MCP doors and invoke routes in every spelling Express routes to them, nothing else', () => {
  for (const base of sandbox.SANDBOX_MARKED_PATHS) {
    for (const p of [base, `${base}/`, `${base}//`, base.toUpperCase(), `${base.toUpperCase()}/`]) assert.equal(sandbox.isSandboxMarkedPath(p), true, p);
  }
  assert.deepEqual([...sandbox.SANDBOX_MARKED_PATHS].sort(), ['/agent/creator/v1/invoke', '/agent/shop/v1/invoke', '/mcp', '/ucp/mcp']);
  for (const p of ['/', '/version', '/health', '/mcpx', '/mcp/extra', '/ucp', '/agent/shop/v1', '/agent/shop/v1/invokes', '', null]) {
    assert.equal(sandbox.isSandboxMarkedPath(p), false, String(p));
  }
});

// --------------------------------------------------------------------------------------------------------------
// 9. Review round 2: IP digests, every DB host, strict socket paths, whole sandbox labels.
// --------------------------------------------------------------------------------------------------------------

test('IP digests: known answer pins the scheme; three distinct shipped digests; stand-ins are not among them', () => {
  assert.equal(sandbox.projectPartDigest('10.250.250.1'), '8bfbb316913fa42a4e6d52b91ae5c13dc01290c83d25da4303ee2f8180b17538');
  const shipped = sandbox.SHIPPED_REFUSED_IP_DIGESTS;
  assert.equal(shipped.length, 3);
  assert.equal(new Set(shipped).size, 3);
  for (const d of shipped) assert.match(d, /^[0-9a-f]{64}$/);
  for (const ip of STAND_IN_IPS) assert.equal(shipped.includes(sandbox.projectPartDigest(ip)), false, ip);
  withProcessEnv({ NODE_ENV: undefined, NODE_TEST_CONTEXT: undefined, JEST_WORKER_ID: undefined }, () => {
    assert.throws(() => sandbox.setRefusedIpDigestsForTests([]), /test-only/);
  });
});

test('IP digests match the REAL prod/staging IPs (only when given locally; never commit them)', (t) => {
  const raw = String(process.env.SANDBOX_REFUSED_IPS_FOR_TEST || '').trim();
  if (!raw) {
    t.skip('SANDBOX_REFUSED_IPS_FOR_TEST not set: prod SQL, prod Redis, staging SQL');
    return;
  }
  const ips = raw.split(',').map((x) => x.trim());
  assert.deepEqual(ips.map(sandbox.projectPartDigest), [...sandbox.SHIPPED_REFUSED_IP_DIGESTS]);
  sandbox.setRefusedIpDigestsForTests();
  try {
    for (const ip of ips) {
      assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: `postgresql://u@${ip}:5432/x` }) || '', /DATABASE_URL\(names a prod or staging database\/Redis address\)/);
      assert.match(refusalOf({ ...SAFE_SANDBOX, REDIS_HOST: ip }) || '', /REDIS_HOST\(names a prod or staging database\/Redis address\)/);
    }
  } finally {
    sandbox.setRefusedIpDigestsForTests(STAND_IN_IPS.map(sandbox.projectPartDigest));
  }
});

test('DB URL: every host it could connect to is checked (duplicate host= and the standard socket form)', () => {
  // pg-connection-string takes the LAST host=, libpq another: all of them must be private.
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u:p@10.9.0.5/db?host=10.9.0.5&host=34.1.2.3' }) || '', /DATABASE_URL\(not a private address\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u:p@34.1.2.3/db?host=10.9.0.5' }) || '', /DATABASE_URL\(not a private address\)/);
  // A bad host in the MIDDLE of three host= values: neither the first nor pg-connection-string's last is it.
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u:p@10.9.0.5/db?host=10.9.0.5&host=34.1.2.3&host=10.9.0.6' }) || '', /DATABASE_URL\(not a private address\)/);
  // The socket: form: only pg-connection-string resolves its host (the WHATWG URL has none).
  assert.equal(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'socket:/cloudsql/zz-sandbox-standin:us-west1:pg?db=x' }), null);
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'socket:/cloudsql/zz-other-project:us-west1:pg?db=x' }) || '', /DATABASE_URL\(Cloud SQL socket outside the sandbox project\)/);
  // The standard Cloud SQL socket form has no authority host.
  assert.equal(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u:p@/db?host=/cloudsql/zz-sandbox-standin:us-west1:pg' }), null);
  // Strict socket path: exactly /cloudsql/<project>:<region>:<instance>.
  for (const bad of ['/cloudsql/zz-sandbox-standin:us-west1:pg/../../x', '/cloudsql/zz-sandbox-standin:us-west1', '/tmp/x', '/cloudsql/zz-sandbox-standin:a:b:c']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: `postgresql://u@/db?host=${bad}` }) || '', /DATABASE_URL\(not a Cloud SQL socket path\)/, bad);
  }
  assert.match(refusalOf({ ...SAFE_SANDBOX, PGHOST: '/cloudsql/zz-other-project:us-west1:pg' }) || '', /PGHOST\(Cloud SQL socket outside the sandbox project\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'not a url' }) || '', /DATABASE_URL\(not a parsable URL\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql:///db' }) || '', /DATABASE_URL\((no host|not a private address)\)/);
  // An authority host beside a socket host=: both are checked (the authority one is not private here).
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u@localhost/x?host=/cloudsql/zz-sandbox-standin:us-west1:pg' }) || '', /DATABASE_URL\(not a private address\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u:p@/db?host=10.9.0.5&host=34.1.2.3' }) || '', /DATABASE_URL\(not a private address\)/);
  // PRIVATE_IP_RE is anchored: a hostname that merely starts like a private IP is not one.
  for (const bad of ['10.1.2.3.example.com', '10.1.2.3x', '192.168.1.1.nip.io']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, PGHOST: bad }) || '', /PGHOST\(not a (private|canonical IP) address\)/, bad);
  }
});

test('brand zones: the sandbox label must be a whole label (sandbox or sandbox-...), never a substring', () => {
  for (const ok of ['https://sandbox.mcp.pivota.cc', 'https://sandbox-api.pivota.cc', 'https://a.sandbox.agenpaz.com']) {
    assert.equal(refusalOf({ ...SAFE_SANDBOX, SOME_SETTING: ok }), null, ok);
  }
  for (const bad of ['https://nosandbox.pivota.cc', 'https://pay-sandbox.agenpaz.com', 'https://sandboxed.pivota.cc', 'https://xsandbox-api.pivota.cc']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, SOME_SETTING: bad }) || '', /SOME_SETTING\(names a non-sandbox /, bad);
  }
});

test('lexical-only: Vertex is refused in any truthy spelling, and the LLM kill switch must be exactly true', () => {
  const { vertexEnabled } = require('../src/llm/vertexGemini');
  for (const v of ['true', 'TRUE', ' true ', '1', 'yes', 'on', 'Y']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, VERTEX_AI_ENABLED: v }) || '', /VERTEX_AI_ENABLED\(must be off in the sandbox\)/, v);
  }
  for (const v of [undefined, '', 'false', '0', 'off']) {
    const env = { ...SAFE_SANDBOX, VERTEX_AI_ENABLED: v };
    if (v === undefined) delete env.VERTEX_AI_ENABLED;
    assert.equal(refusalOf(env), null, String(v));
  }
  // Every value the REAL reader calls enabled is refused.
  for (const v of ['true', 'TRUE', ' True ', '1', 'yes']) {
    const on = withProcessEnv({ VERTEX_AI_ENABLED: v }, () => vertexEnabled());
    if (on) assert.ok(refusalOf({ ...SAFE_SANDBOX, VERTEX_AI_ENABLED: v }), v);
  }
  for (const v of [undefined, '', 'false', 'TRUE', ' true', '1', 'yes']) {
    const env = { ...SAFE_SANDBOX, LLM_KILL_SWITCH: v };
    if (v === undefined) delete env.LLM_KILL_SWITCH;
    assert.match(refusalOf(env) || '', /LLM_KILL_SWITCH\(must be exactly true in the sandbox\)/, String(v));
  }
  // Outside the sandbox neither flag matters to the check.
  for (const [name, env] of Object.entries(NON_SANDBOX_ENVS)) {
    assert.deepEqual(sandbox.sandboxConfigProblems({ ...env, VERTEX_AI_ENABLED: 'true' }), [], name);
  }
});

test('lexical-only (hard): no LLM provider key may be present in the sandbox, not even empty', () => {
  const KEYS = ['GEMINI_API_KEY', 'PIVOTA_GEMINI_API_KEY', 'FALLBACK_GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY', 'LLM_API_KEY', 'AURORA_DIAG_GEMINI_API_KEY', 'AURORA_RECO_GEMINI_API_KEY', 'AURORA_SKIN_GEMINI_API_KEY',
    'AURORA_TRAVEL_GEMINI_API_KEY', 'AURORA_VISION_GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'SOME_NEW_CLAUDE_TOKEN'];
  for (const key of KEYS) {
    for (const value of ['x', '']) {
      assert.ok((refusalOf({ ...SAFE_SANDBOX, [key]: value }) || '').includes(`${key}(no LLM key may be set in the sandbox)`), `${key}=${JSON.stringify(value)}`);
    }
  }
  for (const key of ['LLM_KILL_SWITCH', 'GEMINI_JSON_TIMEOUT', 'FIND_PRODUCTS_MULTI_INTENT_LLM_GEMINI_MAX_OUTPUT_TOKENS', 'PIVOTA_INTENT_LLM_ENABLED', 'GOOGLE_CLOUD_PROJECT']) {
    assert.equal(sandbox.LLM_KEY_SETTING_RE.test(key), false, key);
  }
  for (const [name, env] of Object.entries(NON_SANDBOX_ENVS)) {
    assert.deepEqual(sandbox.sandboxConfigProblems({ ...env, GEMINI_API_KEY: 'x', OPENAI_API_KEY: 'y' }), [], name);
  }
});

test('lexical-only (hard): every provider key name src/ reads is caught by the pattern (a new one cannot slip past)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
    return /\.(c|m)?js$/.test(d.name) ? [p] : [];
  });
  const names = new Set();
  for (const f of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'mcp-server', 'src'))]) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b([A-Z0-9_]*(?:GEMINI|OPENAI|ANTHROPIC|CLAUDE)[A-Z0-9_]*_(?:API_KEY|KEY|TOKEN|SECRET))\b/g)) names.add(m[1]);
  }
  names.delete('MISSING_GEMINI_KEY'); // an error code string, not a setting
  for (const must of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PIVOTA_GEMINI_API_KEY']) assert.ok(names.has(must), `the scan should see ${must}`);
  for (const n of names) assert.equal(sandbox.LLM_KEY_SETTING_RE.test(n), true, n);
});

// --------------------------------------------------------------------------------------------------------------
// 10. Review round 3: canonical IPs, ioredis hosts, every DB/Redis setting, Vertex paths, LLM key names, decoded hosts.
// --------------------------------------------------------------------------------------------------------------

test('IPs: every libc spelling of a refused IP is refused (zero-padded, octal, hex, short forms)', () => {
  // The stand-in refused IPs are 10.250.250.1/2/3 (see STAND_IN_IPS).
  for (const spelled of ['10.250.250.01', '012.0372.0372.1', '0x0a.250.250.1', '10.250.0xfa.1', '10.16448001']) {
    assert.equal(sandbox.canonicalIpv4(spelled), '10.250.250.1', spelled);
    assert.match(refusalOf({ ...SAFE_SANDBOX, SOME_SETTING: `host=${spelled}` }) || '', /SOME_SETTING\(names a prod or staging database\/Redis address\)/, spelled);
  }
  // Database / Redis endpoints accept only a canonical dotted quad.
  for (const bad of ['10.9.0.05', '010.9.0.5', '0x0a.9.0.5', '10.9.5', '167772162']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, PGHOST: bad }) || '', /PGHOST\(not a canonical IP address\)/, bad);
    assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: `postgresql://u@${bad}:5432/x` }) || '', /DATABASE_URL\(not a canonical IP address\)/, bad);
  }
  assert.equal(sandbox.canonicalIpv4('1.2.3'), '1.2.0.3');
  for (const notIp of ['08.1.1.1', '999.1.1.1', '10.1.2.3x', 'abc', '']) assert.equal(sandbox.canonicalIpv4(notIp), null, notIp);
  // PRIVATE_IP_RE is anchored at the start too.
  assert.match(refusalOf({ ...SAFE_SANDBOX, PGHOST: '110.1.2.3' }) || '', /PGHOST\(not a private address\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, PGHOST: '210.1.2.3' }) || '', /PGHOST\(not a private address\)/);
});

test('Redis: the host ioredis connects to is checked (userinfo tricks), for every Redis setting', () => {
  assert.match(refusalOf({ ...SAFE_SANDBOX, REDIS_URL: 'redis://34.1.2.3\\@10.9.0.5:6379' }) || '', /REDIS_URL\(not a private address\)/);
  assert.equal(refusalOf({ ...SAFE_SANDBOX, REDIS_URL: 'redis://10.9.0.5:6379/0' }), null);
  assert.match(refusalOf({ ...SAFE_SANDBOX, REDIS_CACHE_URL: 'redis://cache.example.com:6379' }) || '', /REDIS_CACHE_URL\(not a private address\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, REDIS_CACHE_HOST: 'cache.example.com' }) || '', /REDIS_CACHE_HOST\(not a private address\)/);
});

test('every *DATABASE_URL setting is a private endpoint (each opens its own Pool)', () => {
  for (const key of ['PCI_KB_DATABASE_URL', 'INGREDIENT_SIGNAL_DATABASE_URL', 'INGREDIENT_REFERENCE_DATABASE_URL', 'PIVOTA_KB_DATABASE_URL']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, [key]: 'postgresql://u@db.example.com/x' }) || '', new RegExp(`${key}\\(not a private address\\)`), key);
    assert.equal(refusalOf({ ...SAFE_SANDBOX, [key]: 'postgresql://u@10.61.0.7/x' }), null, key);
  }
  // The hand fallback (non-WHATWG URL) still reads every host=.
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u:p@/db?host=/cloudsql/zz-sandbox-standin:us-west1:pg&host=34.1.2.3' }) || '', /DATABASE_URL\(not a private address\)/);
  // ...including a bad host in the MIDDLE (pg-connection-string takes the last, which is fine here).
  assert.match(refusalOf({ ...SAFE_SANDBOX, DATABASE_URL: 'postgresql://u:p@/db?host=/cloudsql/zz-sandbox-standin:us-west1:pg&host=34.1.2.3&host=/cloudsql/zz-sandbox-standin:us-west1:pg' }) || '', /DATABASE_URL\(not a private address\)/);
});

test('lexical-only: any Vertex project / region setting is refused when present, whatever its value', () => {
  for (const key of ['PIVOTA_AGENT_CENTER_GEMINI_VERTEX_PROJECT', 'MERCHANT_AUDIT_GEMINI_VERTEX_PROJECT', 'ANTHROPIC_VERTEX_REGION',
    'PIVOTA_AGENT_CENTER_ANTHROPIC_VERTEX_REGION', 'SOME_VERTEX_LOCATION']) {
    for (const value of ['zz-sandbox-standin', '']) {
      assert.ok((refusalOf({ ...SAFE_SANDBOX, [key]: value }) || '').includes(`${key}(no Vertex path may be configured in the sandbox)`), `${key}=${JSON.stringify(value)}`);
    }
  }
  assert.equal(sandbox.VERTEX_PATH_SETTING_RE.test('VERTEX_AI_ENABLED'), false);
  assert.equal(sandbox.VERTEX_PATH_SETTING_RE.test('GOOGLE_CLOUD_LOCATION'), false);
});

test('lexical-only: the LLM key pattern refuses a fixed list of names and none of the non-credentials', () => {
  const MUST_REFUSE = ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'OPENAI_API_KEY', 'OPENAI_APIKEY', 'AZURE_OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'CLAUDE_API_KEY', 'LLM_API_KEY', 'GENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APIKEY',
    'OPENROUTER_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZHIPU_API_KEY',
    'MINIMAX_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY', 'GROQ_API_KEY', 'PERPLEXITY_API_KEY', 'XAI_API_KEY',
    'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'REPLICATE_API_TOKEN', 'HUGGINGFACE_TOKEN', 'BEDROCK_ACCESS_KEY',
    'PIVOTA_GEMINI_API_KEY', 'AURORA_SKIN_GEMINI_API_KEY', 'FALLBACK_GEMINI_API_KEY', 'OPENAI_SECRET'];
  for (const key of MUST_REFUSE) {
    assert.equal(sandbox.LLM_KEY_SETTING_RE.test(key), true, key);
    assert.ok((refusalOf({ ...SAFE_SANDBOX, [key]: '' }) || '').includes(`${key}(no LLM key may be set in the sandbox)`), key);
  }
  for (const key of ['LLM_KILL_SWITCH', 'GEMINI_JSON_TIMEOUT', 'FIND_PRODUCTS_MULTI_INTENT_LLM_GEMINI_MAX_OUTPUT_TOKENS',
    'PIVOTA_INTENT_LLM_ENABLED', 'LLM_TOKEN_BUDGET', 'MISSING_GEMINI_KEY', 'GOOGLE_CLOUD_PROJECT', 'VERTEX_AI_ENABLED']) {
    assert.equal(sandbox.LLM_KEY_SETTING_RE.test(key), false, key);
  }
});

test('hosts are checked as fetch decodes them: percent-encoded dots do not hide a prod host', () => {
  for (const value of ['https://api%2Epivota%2Ecc/agent/internal/auth/introspect', 'https://gateway%2epivota%2ecc', 'api%2Epivota%2Ecc']) {
    assert.match(refusalOf({ ...SAFE_SANDBOX, AGENT_AUTH_INTROSPECT_URL: value }) || '', /AGENT_AUTH_INTROSPECT_URL\((prod or staging host|names a non-sandbox pivota\.cc host)\)/, value);
  }
  assert.match(refusalOf({ ...SAFE_SANDBOX, SOME_URL: 'https://web-zq7stand1n-uw%2Ea%2Erun%2Eapp' }) || '', /SOME_URL\(prod or staging host\)/);
  assert.equal(refusalOf({ ...SAFE_SANDBOX, SOME_URL: 'https://sandbox%2Emcp%2Epivota%2Ecc' }), null);
  // Only the URL parser normalises IDNA dots (U+3002, U+FF0E): the raw and decoded tokens never see these hosts.
  assert.match(refusalOf({ ...SAFE_SANDBOX, SOME_URL: 'https://api\u3002pivota\u3002cc/x' }) || '', /SOME_URL\((prod or staging host|names a non-sandbox pivota\.cc host)\)/);
  assert.match(refusalOf({ ...SAFE_SANDBOX, SOME_URL: 'https://web-zq7stand1n-uw\uFF0Ea\uFF0Erun\uFF0Eapp' }) || '', /SOME_URL\(prod or staging host\)/);
});

// --------------------------------------------------------------------------------------------------------------
// 11. The repo never names a refused private IP, in ANY spelling libc would read (the canonical-form scrub).
// --------------------------------------------------------------------------------------------------------------

test('repo scrub: no file names a refused prod/staging private IP, in any spelling (canonical-form scan)', { timeout: 120000 }, () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures', 'datasets']);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return SKIP_DIRS.has(d.name) ? [] : walk(p);
    return /\.((c|m)?(js|ts)|json|md|sql|sh|ya?ml|py|txt)$/.test(d.name) ? [p] : [];
  });
  const RFC1918 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  const shipped = new Set(sandbox.SHIPPED_REFUSED_IP_DIGESTS);
  const seen = new Map();
  const hits = [];
  for (const dir of ['src', 'mcp-server/src', 'tests', 'scripts', 'docs', 'infra', 'ops']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const text = fs.readFileSync(f, 'utf8');
      if (text.length > 2e6) continue;
      for (const m of text.toLowerCase().matchAll(/(?<![0-9a-z.])(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){1,3}(?![0-9a-z])/g)) {
        const c = sandbox.canonicalIpv4(m[0]);
        if (!c || !RFC1918.test(c)) continue;
        if (!seen.has(c)) seen.set(c, shipped.has(sandbox.projectPartDigest(c)));
        if (seen.get(c)) hits.push(path.relative(root, f)); // the path only, never the value
      }
    }
  }
  assert.deepEqual(hits, [], `files naming a refused IP: ${[...new Set(hits)].join(', ')}`);
});
