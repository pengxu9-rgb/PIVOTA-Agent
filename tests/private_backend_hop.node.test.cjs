'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { createPrivateBackendHop } = require('../src/services/privateBackendHop');
const { METADATA_IDENTITY_URL } = require('../src/services/cloudRunIdentityToken');
const AUD = 'https://reap-fixture-123.us-west1.run.app';
const TARGET = 'https://candidate---reap-fixture-123.us-west1.run.app';
const env = { GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: AUD, GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN: TARGET };
const clock = Date.now();
const jwt = (aud = AUD, exp = clock / 1000 + 3600) => `e30.${Buffer.from(JSON.stringify({ aud, exp })).toString('base64url')}.signature`;
function metadata(calls, token = jwt()) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, text: async () => token };
  };
}
const appHeaders = { Authorization: 'Bearer synthetic-agent', 'X-API-Key': 'synthetic-agent', 'X-Agent-User-JWT': 'synthetic-buyer' };

test('stable receiving audience + tag target preserves application auth, replaces injected platform header and collapses metadata calls', async () => {
  const calls = [];
  const hop = createPrivateBackendHop({ env, metadataFetch: metadata(calls), now: () => clock });
  const results = await Promise.all(Array.from({ length: 10 }, () => hop.headers(`${TARGET}/agent/read`, { ...appHeaders, 'x-serverless-authorization': 'untrusted' })));
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, METADATA_IDENTITY_URL);
  assert.equal(url.searchParams.get('audience'), AUD);
  assert.equal(calls[0].init.redirect, 'error');
  for (const headers of results) {
    for (const [key, value] of Object.entries(appHeaders)) assert.equal(headers[key], value);
    assert.equal(headers['X-Serverless-Authorization'], `Bearer ${jwt()}`);
    assert.equal(headers['x-serverless-authorization'], undefined);
  }
});

test('invalid configuration rejects path/port/userinfo/custom domain/tag audience and unrelated tag destination', () => {
  const invalid = [
    { ...env, GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: `${AUD}/agent` },
    { ...env, GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: `${AUD}:8443` },
    { ...env, GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: AUD.replace('https://', 'https://user@') },
    { ...env, GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: 'https://backend.example' },
    { ...env, GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: TARGET },
    { ...env, GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN: 'https://different-123.us-west1.run.app' },
    { ...env, GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN: '' },
    { ...env, GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: '' },
  ];
  for (const config of invalid) assert.throws(() => createPrivateBackendHop({ env: config }), /backend_iam_configuration_invalid/);
});

test('untrusted destination cannot receive app credentials or trigger metadata; trusted fetch refuses redirects', async () => {
  const meta = []; const sent = [];
  const hop = createPrivateBackendHop({ env, metadataFetch: metadata(meta) });
  const fetch = hop.wrapFetch(async (url, init) => { sent.push({ url, init }); return { status: 200 }; });
  for (const url of ['https://evil.example/agent', `${AUD}/agent`, `${TARGET}:8443/agent`, TARGET.replace('https://', 'https://user@'), `${TARGET}/agent#fragment`]) {
    await assert.rejects(fetch(url, { headers: appHeaders }), /backend_iam_destination_refused/);
  }
  assert.equal(meta.length, 0); assert.equal(sent.length, 0);
  await fetch(`${TARGET}/agent`, { headers: appHeaders, redirect: 'follow' });
  assert.equal(sent[0].init.redirect, 'error');
});

test('cache refresh failure never sends a stale token or falls back, and a later healthy refresh recovers', async () => {
  let now = clock; let count = 0; let healthy = true; let sent = 0;
  const hop = createPrivateBackendHop({ env, now: () => now, metadataFetch: async () => {
    count++; return { ok: healthy, text: async () => jwt(AUD, now / 1000 + 3600) };
  } });
  const fetch = hop.wrapFetch(async () => { sent++; });
  await fetch(`${TARGET}/agent`, { headers: appHeaders });
  now += 56 * 60 * 1000; healthy = false;
  await assert.rejects(fetch(`${TARGET}/agent`), /backend_iam_token_unavailable/);
  assert.equal(sent, 1); assert.equal(count, 2);
  healthy = true; await fetch(`${TARGET}/agent`);
  assert.equal(sent, 2); assert.equal(count, 3);
});

test('wrong audience, expired and malformed metadata tokens refuse before backend transport', async () => {
  for (const token of [jwt('https://other.run.app'), jwt(AUD, clock / 1000 - 1), 'not-a-token']) {
    let sent = false;
    const hop = createPrivateBackendHop({ env, metadataFetch: metadata([], token), now: () => clock });
    await assert.rejects(hop.wrapFetch(async () => { sent = true; })(`${TARGET}/agent`), /backend_iam_token_unavailable/);
    assert.equal(sent, false);
  }
});

test('actual Axios interceptor preserves internal/agent auth, disables redirects and never tokens a merchant origin', async () => {
  const meta = []; const seen = [];
  const hop = createPrivateBackendHop({ env, metadataFetch: metadata(meta) });
  const client = axios.create({ adapter: async (config) => { seen.push(config); return { status: 200, data: {}, headers: {}, config }; } });
  hop.installAxios(client, { backendBaseUrl: TARGET, introspectUrl: `${TARGET}/agent/internal/api-key/introspect` });
  await client.post(`${TARGET}/agent/internal/api-key/introspect`, {}, { headers: { 'X-Internal-Key': 'synthetic-internal', ...appHeaders } });
  assert.equal(seen[0].headers.get('X-Internal-Key'), 'synthetic-internal');
  assert.equal(seen[0].headers.get('Authorization'), appHeaders.Authorization);
  assert.equal(seen[0].headers.get('X-Serverless-Authorization'), `Bearer ${jwt()}`);
  assert.equal(seen[0].maxRedirects, 0);
  await client.get('https://merchant.example/products/one');
  assert.equal(seen[1].headers.get('X-Serverless-Authorization'), undefined);
  assert.equal(meta.length, 1);
  assert.throws(() => hop.installAxios(client, { backendBaseUrl: TARGET, introspectUrl: 'https://evil.example/introspect' }), /destination_refused/);
});

test('actual server wiring: caller-context Reap start/recover/GET and introspection use the same private hop', async () => {
  Object.assign(process.env, env, {
    PIVOTA_API_BASE: TARGET,
    AGENT_AUTH_INTROSPECT_URL: `${TARGET}/agent/internal/api-key/introspect`,
    AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'synthetic-internal',
    PIVOTA_API_KEY: 'synthetic-unused-internal',
  });
  const originalFetch = globalThis.fetch;
  const originalAdapter = axios.defaults.adapter;
  const meta = []; const requests = []; const introspections = [];
  globalThis.fetch = metadata(meta);
  axios.defaults.adapter = async (config) => {
    introspections.push(config);
    return { status: 200, data: { valid: true, agent_id: 'synthetic-agent-id' }, headers: {}, config };
  };
  try {
    const server = require('../src/server');
    const strict = server._debug.__agentCheckoutStrict;
    assert.equal(strict.privateBackendHop.audience, AUD);
    const id = 'rp_0123456789abcdef01234567';
    const client = strict.buildReapAgenticPurchaseClient(null, { fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { status: url.endsWith('/purchases') ? 202 : 200, text: async () => JSON.stringify({ id, purchase_id: id, status: 'completed', state: 'completed' }) };
    } });
    await strict.runInInvokeAuthContextForTest({ api_key: 'synthetic-agent', agent_user_jwt: 'synthetic-buyer' }, async () => {
      assert.equal((await client.startPurchase({ idempotency_key: 'same-key' })).kind, 'accepted');
      assert.equal((await client.recoverPurchase({ idempotency_key: 'same-key' })).kind, 'accepted');
      assert.equal((await client.getPurchase(id)).kind, 'accepted');
    });
    for (const { init } of requests) {
      for (const [key, value] of Object.entries(appHeaders)) assert.equal(init.headers[key], value);
      assert.equal(init.headers['X-Serverless-Authorization'], `Bearer ${jwt()}`);
      assert.equal(init.redirect, 'error');
    }
    await server._debug.introspectInvokeApiKey('synthetic-new-introspection-key');
    assert.equal(introspections.length, 1);
    assert.equal(introspections[0].headers.get('X-Internal-Key'), 'synthetic-internal');
    assert.equal(introspections[0].headers.get('X-Serverless-Authorization'), `Bearer ${jwt()}`);
    assert.equal(meta.length, 1);
    axios.defaults.adapter = async (config) => ({ status: 403, data: {}, headers: {}, config });
    await assert.rejects(server._debug.introspectInvokeApiKey('synthetic-iam-denied-key'), { code: 'AUTH_INTROSPECT_IAM_FAILED' });
    const supertest = require('supertest');
    const staleKey = `ak_live_${'b'.repeat(64)}`;
    server._debug.putCachedInvokeAuthResult(staleKey, { valid: true, is_active: true, agent_id: 'synthetic-agent-id' }, Date.now() - 61_000);
    const response = await supertest(server).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', staleKey).send({});
    assert.equal(response.status, 503, 'IAM denial must not authenticate from a stale verdict');
    assert.equal(response.body.error, 'AUTH_INTROSPECT_UNAVAILABLE');
    const registryCalls = [];
    globalThis.fetch = async (url, init) => {
      registryCalls.push({ url, init });
      return { status: 200, ok: true, json: async () => ({ issuers: [] }) };
    };
    await strict.getAgentIdentityIssuerRegistry().refresh();
    assert.equal(registryCalls.length, 1);
    assert.equal(registryCalls[0].url, `${TARGET}/agent/internal/identity-issuers`);
    assert.equal(registryCalls[0].init.headers['X-Internal-Key'], 'synthetic-internal');
    assert.equal(registryCalls[0].init.headers['X-Serverless-Authorization'], `Bearer ${jwt()}`);
    assert.equal(registryCalls[0].init.redirect, 'error');
    const platformMissing = strict.buildReapAgenticPurchaseClient(null, { fetchImpl: async () => ({ status: 404, text: async () => '<html>service missing</html>' }) });
    await strict.runInInvokeAuthContextForTest({ api_key: 'synthetic-agent', agent_user_jwt: 'synthetic-buyer' }, async () => {
      assert.equal((await platformMissing.startPurchase({})).kind, 'unavailable');
      assert.equal((await platformMissing.recoverPurchase({})).kind, 'refused');
      assert.notEqual((await platformMissing.recoverPurchase({})).kind, 'not_found');
    });
    const unsafe = strict.buildReapAgenticPurchaseClient(null, { baseUrl: 'https://evil.example', fetchImpl: async () => { throw Error('must not send'); } });
    const result = await strict.runInInvokeAuthContextForTest({ api_key: 'synthetic-agent', agent_user_jwt: 'synthetic-buyer' }, () => unsafe.recoverPurchase({}));
    assert.equal(result.kind, 'unavailable');
  } finally {
    globalThis.fetch = originalFetch; axios.defaults.adapter = originalAdapter;
  }
});

test('private IAM HTTP 401/403 is unavailable for Reap creates, never a deterministic spending fallback', async () => {
  const { createReapAgenticPurchaseClient } = require('../src/services/reapAgenticPurchaseClient');
  for (const status of [401, 403]) {
    const hop = createPrivateBackendHop({ env, metadataFetch: metadata([]) });
    const client = createReapAgenticPurchaseClient({ baseUrl: TARGET, authHeaders: () => appHeaders,
      fetchImpl: hop.wrapFetch(async () => ({ status, text: async () => '<html>platform denied</html>' })) });
    assert.equal((await client.startPurchase({})).kind, 'unavailable');
    assert.equal((await client.recoverPurchase({})).kind, 'unavailable');
    assert.equal((await client.getPurchase('rp_0123456789abcdef01234567')).kind, 'unavailable');
  }
});

test('issuer registry cannot reuse stale trust after an explicit private IAM failure', async () => {
  const { createAgentIdentityIssuerRegistry } = require('../src/services/agentIdentityIssuerRegistry');
  let now = clock; let deny = false;
  const hop = createPrivateBackendHop({ env, metadataFetch: metadata([]), now: () => now });
  const registry = createAgentIdentityIssuerRegistry({ baseUrl: TARGET, internalKey: 'synthetic-internal', now: () => now,
    fetchImpl: hop.wrapFetch(async (_url, init) => {
      assert.equal(init.headers['X-Internal-Key'], 'synthetic-internal');
      assert.equal(init.headers['X-Serverless-Authorization'], `Bearer ${jwt()}`);
      return { status: deny ? 403 : 200, ok: !deny, json: async () => ({ issuers: [{ agent_id: 'agent', iss: 'https://buyer.example', aud: 'buyer', jwksUri: 'https://buyer.example/jwks' }] }) };
    }), createVerifier: () => async () => ({ user_ref: 'buyer' }) });
  const buyerToken = `e30.${Buffer.from(JSON.stringify({ iss: 'https://buyer.example' })).toString('base64url')}.sig`;
  assert.equal((await registry.verifyForAgent(buyerToken, 'agent')).user_ref, 'buyer');
  now += 61_000; deny = true;
  await assert.rejects(registry.verifyForAgent(buyerToken, 'agent'), { code: 'REGISTRY_UNAVAILABLE' });
});


test('private create requires exact house refusal; recover accepts only authoritative owner404 as namespace miss', async () => {
  const { createReapAgenticPurchaseClient } = require('../src/services/reapAgenticPurchaseClient');
  for (const body of [{}, { error: 'service_not_found' }, { error: 'purchase_not_found' }, { detail: { error: { code: 'merchant_not_eligible' } } }]) {
    const client = createReapAgenticPurchaseClient({ baseUrl: TARGET, authHeaders: () => appHeaders, requireAuthoritativeRefusal: true,
      fetchImpl: async () => ({ status: 404, text: async () => JSON.stringify(body) }) });
    assert.equal((await client.startPurchase({})).kind, 'unavailable');
    assert.equal((await client.recoverPurchase({})).kind, body.error === 'purchase_not_found' ? 'not_found' : 'refused');
  }
  const client = createReapAgenticPurchaseClient({ baseUrl: TARGET, authHeaders: () => appHeaders, requireAuthoritativeRefusal: true,
    fetchImpl: async () => ({ status: 409, text: async () => JSON.stringify({ detail: { error: 'merchant_not_eligible' } }) }) });
  assert.equal((await client.startPurchase({})).kind, 'refused');
});


test('private create rejects unknown/mismatched/conflicting and explicit gate envelopes; exact canonical flat backend refusals remain readable', async () => {
  const { createReapAgenticPurchaseClient } = require('../src/services/reapAgenticPurchaseClient');
  for (const [status, body] of [
    [409,{detail:{error:'invented_refusal'}}], [400,{error:'merchant_not_eligible'}],
    [409,{error:'merchant_disabled',detail:{error:'merchant_not_eligible'}}],
    [404,{error:'create_disabled'}], [404,{error:'not_available_on_this_rail'}],
    [404,{error:'pilot_scope_refused'}], [400,{error:'invalid_request',detail:null}],
  ]) {
    const client = createReapAgenticPurchaseClient({ baseUrl: TARGET, authHeaders: () => appHeaders, requireAuthoritativeRefusal: true,
      fetchImpl: async () => ({ status, text: async () => JSON.stringify(body) }) });
    assert.equal((await client.startPurchase({})).kind, 'unavailable');
  }
  for (const [status, code] of [[400,'consent_required'],[409,'merchant_not_eligible'],[409,'idempotency_conflict']]) {
    const client = createReapAgenticPurchaseClient({ baseUrl: TARGET, authHeaders: () => appHeaders, requireAuthoritativeRefusal: true,
      fetchImpl: async () => ({ status, text: async () => JSON.stringify({ error: code }) }) });
    const result = await client.startPurchase({});
    assert.equal(result.kind, 'refused'); assert.equal(result.code, code);
  }
});


test('stored catalog suppression callback refuses remote catalog before metadata in real Axios ordering', async () => {
  const meta=[];let sent=0;const order=[];
  const hop=createPrivateBackendHop({env,metadataFetch:metadata(meta)});
  const instance=axios.create({adapter:async(config)=>{sent++;return {status:200,data:{},headers:{},config};}});
  instance.interceptors.request.use(config=>{order.push('earlier-interceptor');return config;});
  hop.installAxios(instance,{backendBaseUrl:TARGET,introspectUrl:`${TARGET}/agent/internal/auth/introspect`,
    requestGuard:(config)=> {order.push('suppression');if(!config.url.endsWith('/agent/internal/auth/introspect'))throw Error('stored-only-refused');return config;}});
  await assert.rejects(instance.get(`${TARGET}/agent/v1/products/search`),/stored-only-refused/);
  assert.equal(meta.length,0);assert.equal(sent,0);assert.deepEqual(order,['suppression']);
  await instance.post(`${TARGET}/agent/internal/auth/introspect`,{}, {headers:{'X-Internal-Key':'synthetic-internal'}});
  assert.equal(meta.length,1);assert.equal(sent,1);assert.deepEqual(order,['suppression','suppression','earlier-interceptor']);
});
