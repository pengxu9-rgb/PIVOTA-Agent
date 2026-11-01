'use strict';

// SYNTHETIC CALLERS end to end over the real /mcp door (src/guardrails/syntheticCallers.js): an OAuth token
// shaped like our authorization server mints it, the door's classification and allowlist, the outcome line,
// and what leaves the process for the backend. Only network edges are stubbed (the backend, via nock); for
// search the loopback is a REAL socket into this same server, because that hop is where the marker used to
// be lost: the backend writes for search are made from the loopback request, not from the door's.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';
const BACKEND = 'http://backend.synthetic-door.test';
const SYN_SECRET = 'synthetic-assertion-secret';
const EVAL_CID = 'mcpc_eval_1';
const GATEWAY_KEY = 'gateway-service-key';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = GATEWAY_KEY;
process.env.PIVOTA_API_BASE = BACKEND;
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ISSUERS_JSON;
delete process.env.MCP_CALLER_LIMITS_MODE;
delete process.env.DATABASE_URL;

const app = require('../src/server');
const logger = require('../src/logger');
const { keyFingerprint } = require('../src/guardrails/syntheticCallers');

const lines = [];
for (const level of ['info', 'warn']) {
  const real = logger[level].bind(logger);
  logger[level] = (obj, msg, ...rest) => {
    if (obj && typeof obj === 'object') lines.push({ level, msg, ...obj });
    return real(obj, msg, ...rest);
  };
}

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

function setSynthetic({ mode = 'enforce', secret = SYN_SECRET, callers = [{ iss: ISS, client_id: EVAL_CID }] } = {}) {
  process.env.SYNTHETIC_TRAFFIC_MODE = mode;
  process.env.SYNTHETIC_CALLERS_JSON = JSON.stringify(callers);
  if (secret) process.env.SYNTHETIC_ASSERTION_SECRET = secret;
  else delete process.env.SYNTHETIC_ASSERTION_SECRET;
}

async function tokenFor(claims) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'as-1';
  pub.alg = 'RS256';
  process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
  require('../src/commerceMcpOAuth.js').__resetVerifierCache();
  return new SignJWT({ scope: 'pivota.read', token_type: 'access', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('eval-harness').setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

// Every request that reaches the backend host, with its headers. Answers are just enough to complete a call.
function captureBackend() {
  const seen = [];
  nock.cleanAll();
  const record = function record(uri, body) {
    seen.push({ method: this.req.method, path: uri, headers: this.req.headers, body });
    return [200, { status: 'success', offers: [], products: [], total: 0 }];
  };
  nock(BACKEND).persist().post(/.*/).reply(record);
  nock(BACKEND).persist().get(/.*/).reply(record);
  return seen;
}

function decodeAssertion(value) {
  const [version, body, mac] = String(value).split('.');
  assert.equal(version, 'v1');
  assert.equal(mac, crypto.createHmac('sha256', SYN_SECRET).update(`${version}.${body}`).digest('base64url'), 'signed with the shared secret');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

function outcomeLine(tool) {
  const found = lines.filter((l) => l.msg === 'mcp tools/call complete' && l.tool === tool);
  assert.ok(found.length > 0, `an outcome line for ${tool}`);
  return found[found.length - 1];
}

async function call(agent, token, body) {
  const res = await agent
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  return res;
}

const toolErrorCode = (res) => {
  const text = res.body?.result?.content?.[0]?.text;
  return res.body?.result?.isError === true && text ? JSON.parse(text).error.code : null;
};

const GET_OFFERS = rpc('tools/call', { name: 'get_offers', arguments: { merchant_id: 'm_1', product_id: 'p_1' } });

test('enforce: a listed caller\'s get_offers reaches the backend with a signed synthetic assertion', async () => {
  setSynthetic();
  const seen = captureBackend();
  lines.length = 0;
  await call(supertest(app), await tokenFor({ client_id: EVAL_CID }), GET_OFFERS);
  nock.cleanAll();
  const resolves = seen.filter((r) => r.body?.operation === 'offers.resolve');
  assert.ok(resolves.length > 0, 'get_offers reached offers.resolve');
  const line = outcomeLine('get_offers');
  assert.equal(line.synthetic, true);
  assert.match(line.gateway_request_id, /^[0-9a-f-]{36}$/);
  for (const r of seen) {
    const p = decodeAssertion(r.headers['x-pivota-synthetic-assertion']);
    assert.equal(p.c, `${ISS}|${EVAL_CID}`);
    assert.equal(p.r, line.gateway_request_id, 'one id names the call on the outcome line and the backend hop');
    assert.equal(p.kfp, keyFingerprint(GATEWAY_KEY), 'bound to the key the hop authenticates with');
    assert.equal(r.headers['x-api-key'], GATEWAY_KEY);
  }
});

test('a caller that is not listed sends no assertion, and its outcome line is unmarked', async () => {
  setSynthetic();
  const seen = captureBackend();
  lines.length = 0;
  await call(supertest(app), await tokenFor({ client_id: 'mcpc_partner_7' }), GET_OFFERS);
  nock.cleanAll();
  assert.ok(seen.length > 0);
  for (const r of seen) assert.equal(r.headers['x-pivota-synthetic-assertion'], undefined);
  const line = outcomeLine('get_offers');
  assert.equal(line.synthetic, undefined);
  assert.equal(line.synthetic_classified, undefined);
  assert.match(line.gateway_request_id, /^[0-9a-f-]{36}$/, 'every commerce-door call gets an id');
});

test('azp alone never makes a call synthetic: our issuer naming the eval client only as azp is refused', async () => {
  setSynthetic();
  const seen = captureBackend();
  const res = await call(supertest(app), await tokenFor({ azp: EVAL_CID }), GET_OFFERS);
  nock.cleanAll();
  assert.equal(toolErrorCode(res), 'OPERATION_NOT_ALLOWED');
  assert.equal(seen.length, 0, 'nothing was dispatched');
});

for (const mode of ['off', 'observe', 'enforce']) {
  test(`${mode}: a listed caller cannot reach a money or order tool, and nothing is dispatched`, async () => {
    setSynthetic({ mode });
    const token = await tokenFor({ client_id: EVAL_CID });
    for (const name of ['create_checkout_session', 'complete_checkout_session', 'create_payment_link', 'request_after_sales', 'start_purchase', 'get_order', 'recommend_products']) {
      const seen = captureBackend();
      const res = await call(supertest(app), token, rpc('tools/call', { name, arguments: { order_id: 'o_1', items: [] } }));
      nock.cleanAll();
      assert.equal(toolErrorCode(res), 'OPERATION_NOT_ALLOWED', name);
      assert.equal(seen.length, 0, `${name}: no backend call`);
    }
  });
}

test('a listed caller sees only the five read tools in tools/list; anyone else sees the full list', async () => {
  setSynthetic();
  const listedRes = await call(supertest(app), await tokenFor({ client_id: EVAL_CID }), rpc('tools/list'));
  assert.deepEqual(
    listedRes.body.result.tools.map((t) => t.name).sort(),
    ['get_alternatives', 'get_intel', 'get_offers', 'get_product', 'search_catalog'],
  );
  const otherRes = await call(supertest(app), await tokenFor({ client_id: 'mcpc_partner_7' }), rpc('tools/list'));
  const names = otherRes.body.result.tools.map((t) => t.name);
  assert.ok(names.includes('create_checkout_session') && names.length > 5, 'the full surface for a real caller');
});

test('a batch body from a listed caller is refused before anything reads it', async () => {
  setSynthetic();
  const seen = captureBackend();
  const res = await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${await tokenFor({ client_id: EVAL_CID })}`)
    .set('Accept', 'application/json, text/event-stream')
    .send([GET_OFFERS]);
  nock.cleanAll();
  assert.equal(res.status, 200);
  assert.equal(toolErrorCode(res), 'OPERATION_NOT_ALLOWED');
  assert.equal(seen.length, 0);
});

test('enforce without the assertion secret refuses the call: the backend would see it as real', async () => {
  setSynthetic({ secret: null });
  const seen = captureBackend();
  lines.length = 0;
  const res = await call(supertest(app), await tokenFor({ client_id: EVAL_CID }), GET_OFFERS);
  nock.cleanAll();
  assert.equal(toolErrorCode(res), 'OPERATION_NOT_ALLOWED');
  assert.equal(seen.length, 0);
  assert.ok(lines.some((l) => l.msg === 'synthetic caller request refused' && l.reason === 'carrier_not_ready'));
});

test('enforce with a self-invoke base that is not this host\'s loopback refuses the call: the marker would be lost', async () => {
  setSynthetic();
  const saved = process.env.SELF_INVOKE_BASE;
  process.env.SELF_INVOKE_BASE = 'http://gateway-internal.synthetic-door.test';
  try {
    const seen = captureBackend();
    lines.length = 0;
    const res = await call(supertest(app), await tokenFor({ client_id: EVAL_CID }), GET_OFFERS);
    nock.cleanAll();
    assert.equal(toolErrorCode(res), 'OPERATION_NOT_ALLOWED');
    assert.equal(seen.length, 0);
    assert.ok(lines.some((l) => l.msg === 'synthetic caller request refused' && l.reason === 'carrier_not_ready'));
  } finally {
    if (saved === undefined) delete process.env.SELF_INVOKE_BASE;
    else process.env.SELF_INVOKE_BASE = saved;
  }
});

test('listing is per (iss, client_id): a valid entry is served synthetic, and an entry on another issuer does not list our issuer\'s client', async () => {
  setSynthetic({ callers: [{ iss: ISS, client_id: EVAL_CID }] });
  process.env.SYNTHETIC_CALLERS_JSON = JSON.stringify([{ iss: 'https://not-ours.test', client_id: EVAL_CID }, { iss: ISS, client_id: 'mcpc_eval_2' }]);
  // The eval_2 entry is valid; the foreign one does not match our issuer's token for EVAL_CID, so that caller
  // is ordinary. A token for eval_2 is listed and served.
  const seen = captureBackend();
  lines.length = 0;
  await call(supertest(app), await tokenFor({ client_id: 'mcpc_eval_2' }), GET_OFFERS);
  nock.cleanAll();
  assert.ok(seen.length > 0 && seen.every((r) => r.headers['x-pivota-synthetic-assertion']));
  // Our own issuer, but the only entry for this client is on another issuer: listed-invalid is decided per
  // (iss, client_id), so this token is NOT listed and runs as an ordinary caller with no marker.
  const seen2 = captureBackend();
  await call(supertest(app), await tokenFor({ client_id: EVAL_CID }), GET_OFFERS);
  nock.cleanAll();
  assert.ok(seen2.length > 0 && seen2.every((r) => r.headers['x-pivota-synthetic-assertion'] === undefined));
});

test('observe: the call runs as a real one (no assertion) and is logged as classified', async () => {
  setSynthetic({ mode: 'observe' });
  const seen = captureBackend();
  lines.length = 0;
  await call(supertest(app), await tokenFor({ client_id: EVAL_CID }), GET_OFFERS);
  nock.cleanAll();
  assert.ok(seen.length > 0);
  for (const r of seen) assert.equal(r.headers['x-pivota-synthetic-assertion'], undefined);
  assert.equal(outcomeLine('get_offers').synthetic_classified, true);
  assert.ok(lines.some((l) => l.msg === 'synthetic_classified'));
});

test('enforce, real loopback: every backend hop of a synthetic search carries the door\'s id', async () => {
  setSynthetic();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const savedBase = process.env.SELF_INVOKE_BASE;
  process.env.SELF_INVOKE_BASE = `http://127.0.0.1:${server.address().port}`;
  nock.enableNetConnect('127.0.0.1');
  try {
    const seen = captureBackend();
    lines.length = 0;
    await call(supertest(server), await tokenFor({ client_id: EVAL_CID }), rpc('tools/call', {
      name: 'search_catalog',
      arguments: { query: 'stainless steel water bottle' },
    }));
    nock.cleanAll();
    const line = outcomeLine('search_catalog');
    assert.equal(line.synthetic, true);
    assert.ok(seen.length > 0, 'the search reached the backend from the loopback request');
    for (const r of seen) {
      const value = r.headers['x-pivota-synthetic-assertion'];
      assert.ok(value, `${r.method} ${r.path} carries the assertion`);
      assert.equal(decodeAssertion(value).r, line.gateway_request_id, `${r.path}: the door's id`);
    }
    // The body's request id is the door's too, so a backend row that stores it names the same call.
    const search = seen.find((r) => String(r.path).startsWith('/agent/v2/products/search'));
    assert.ok(search, 'the search hop is the v2 search');
    assert.equal(search.body?.request_context?.request_id, line.gateway_request_id);
  } finally {
    nock.cleanAll();
    nock.disableNetConnect();
    if (savedBase === undefined) delete process.env.SELF_INVOKE_BASE;
    else process.env.SELF_INVOKE_BASE = savedBase;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
