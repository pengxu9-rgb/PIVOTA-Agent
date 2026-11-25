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
  PIVOTA_API_BASE: 'https://web-sbx0example-uw.a.run.app',
  AGENT_AUTH_INTROSPECT_URL: 'https://web-sbx0example-uw.a.run.app/agent/internal/auth/introspect',
  CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED: 'false',
  PIVOTA_API_KEY: KEY_TEST,
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
  // Hosts that merely resemble prod are not prod.
  for (const url of ['https://sandbox-api.pivota.cc', 'https://web-sbx0example-uw.a.run.app', 'https://api.pivota.cc.example.org']) {
    assert.equal(refusalOf({ ...SAFE_SANDBOX, PIVOTA_API_BASE: url }), null, url);
  }
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
