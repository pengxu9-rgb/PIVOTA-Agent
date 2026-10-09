'use strict';

// WHO CALLED reaches the completion log lines, through the real auth code (src/attribution/callerLogFields.js).
//
// The fields are only worth having if they name the caller the gateway actually resolved, so the end-to-end
// cases drive the real producers of req.invokeAuth -- api-key introspection on the invoke route, the MCP OAuth
// front door, the api-key channel on /mcp -- and read the line the real logger was handed. Nothing between
// the credential and the log line is stubbed except the network edges (introspection, the Python backend).

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';
const INTROSPECT_BASE = 'https://auth.caller-log.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const AGENT_KEY = `ak_live_${'c'.repeat(64)}`;
// A second key: the gateway caches an introspection result per key, so one key cannot stand for two agents.
const PARTNER_KEY = `ak_live_${'d'.repeat(64)}`;

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.PIVOTA_API_BASE = 'http://backend.caller-log.test';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '1200';
// The real auth path, not the test bypass: the bypass would log auth_mode 'test_bypass' and prove nothing.
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ISSUERS_JSON;

const app = require('../src/server');
const logger = require('../src/logger');
const { callerLogFields, isLoopbackSelfCall } = require('../src/attribution/callerLogFields');

// Spy on the real logger rather than replacing it (a spread copy of a pino instance loses its symbols).
const captured = [];
const realInfo = logger.info.bind(logger);
logger.info = (obj, msg, ...rest) => {
  if (msg === 'invoke request complete' || msg === 'mcp tools/call complete') {
    captured.push({ msg, obj });
    return undefined;
  }
  return realInfo(obj, msg, ...rest);
};

test.after(() => {
  logger.info = realInfo;
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

function linesFor(msg) {
  return captured.filter((c) => c.msg === msg).map((c) => c.obj);
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function introspectAs(agentId, key = AGENT_KEY) {
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body && body.api_key === key)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
}

async function tokenFor(claims) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'as-1';
  pub.alg = 'RS256';
  process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
  require('../src/commerceMcpOAuth.js').__resetVerifierCache();
  return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('buyer-1').setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
}

function getOffersCall() {
  return {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_offers', arguments: { merchant_id: 'm_1', product_id: 'p_1' } },
  };
}

function backendOffersResolve() {
  nock(process.env.PIVOTA_API_BASE)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'offers.resolve')
    .reply(200, { status: 'success', offers: [] });
}

// ---- the helper, on the exact req.invokeAuth shapes src/server.js writes ----

test('an introspected api-key caller logs its agent and auth source, never its key', () => {
  const fields = callerLogFields({
    invokeAuth: {
      key_fingerprint: 'fp', auth_source: 'x-agent-api-key', auth_mode: 'api_key', agent_id: 'agent_minds',
      raw_token: AGENT_KEY, cache_hit: false, introspect_auth_source: 'api_keys', auth_degraded: false,
    },
    headers: { 'x-forwarded-for': '203.0.113.9' },
    socket: { remoteAddress: '169.254.1.1' },
  });
  assert.deepEqual(fields, {
    caller_auth_mode: 'api_key', caller_agent_id: 'agent_minds', caller_auth_source: 'api_keys',
  });
  assert.ok(!JSON.stringify(fields).includes(AGENT_KEY));
});

test('an MCP OAuth caller logs its client and issuer, and no agent', () => {
  const fields = callerLogFields({
    invokeAuth: {
      key_fingerprint: null, auth_source: 'mcp_oauth_bearer', auth_mode: 'mcp_oauth', agent_id: null,
      raw_token: null, oauth_issuer: ISS, oauth_client_id: 'mcpc_install_42',
    },
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
  assert.deepEqual(fields, {
    caller_auth_mode: 'mcp_oauth', caller_oauth_client_id: 'mcpc_install_42', caller_oauth_issuer: ISS,
  });
});

test('no auth record is counted as unauthenticated, and a degraded fallback says so', () => {
  assert.deepEqual(callerLogFields({ headers: {} }), { caller_auth_mode: 'unauthenticated' });
  assert.deepEqual(callerLogFields(undefined), { caller_auth_mode: 'unauthenticated' });
  const degraded = callerLogFields({
    invokeAuth: {
      auth_mode: 'api_key', agent_id: 'agent_emergency_fallback', introspect_auth_source: 'emergency_fallback',
      auth_degraded: true,
    },
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
  assert.equal(degraded.caller_auth_degraded, true);
  assert.equal(degraded.caller_auth_source, 'emergency_fallback');
});

test('loopback means a loopback socket AND no X-Forwarded-For', () => {
  assert.equal(isLoopbackSelfCall({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), true);
  assert.equal(isLoopbackSelfCall({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }), true);
  assert.equal(isLoopbackSelfCall({ socket: { remoteAddress: '::1' }, headers: {} }), true);
  // Routed in by Cloud Run: it always sets X-Forwarded-For, whatever the socket says.
  assert.equal(
    isLoopbackSelfCall({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } }),
    false,
  );
  assert.equal(isLoopbackSelfCall({ socket: { remoteAddress: '169.254.8.1' }, headers: {} }), false);
});

test('an oversized or non-string field is dropped, never truncated into a different identity', () => {
  const fields = callerLogFields({ invokeAuth: { auth_mode: 'api_key', agent_id: 'a'.repeat(300) }, headers: {} });
  assert.equal(fields.caller_agent_id, undefined);
  assert.equal(callerLogFields({ invokeAuth: { auth_mode: 42 } }).caller_auth_mode, 'unauthenticated');
});

// ---- end to end ----

test('the invoke completion line names the agent introspection resolved', async () => {
  captured.length = 0;
  introspectAs('agent_minds');
  const res = await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', AGENT_KEY)
    .set('X-Forwarded-For', '203.0.113.9')
    .send({ operation: 'no_such_operation', payload: {} });
  await settle();
  nock.cleanAll();
  const lines = linesFor('invoke request complete');
  assert.equal(lines.length, 1, `status ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  const line = lines[0];
  assert.equal(line.caller_auth_mode, 'api_key');
  assert.equal(line.caller_agent_id, 'agent_minds');
  assert.equal(line.caller_auth_source, 'api_keys');
  assert.equal(line.caller_loopback, undefined, 'a request routed in with X-Forwarded-For is not a self-call');
  assert.ok(line.key_fingerprint, 'the key fingerprint is still logged beside it');
  assert.ok(!JSON.stringify(line).includes(AGENT_KEY), 'the key itself never reaches the log');
});

test('a request without X-Forwarded-For over loopback is marked as a self-call', async () => {
  captured.length = 0;
  introspectAs('agent_minds');
  await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', AGENT_KEY)
    .send({ operation: 'no_such_operation', payload: {} });
  await settle();
  nock.cleanAll();
  const [line] = linesFor('invoke request complete');
  assert.ok(line, 'the completion line is logged');
  assert.equal(line.caller_loopback, true);
});

test('an OAuth connector calling a tool over /mcp is logged with the tool and its client', async () => {
  captured.length = 0;
  const token = await tokenFor({ client_id: 'mcpc_install_42' });
  backendOffersResolve();
  const res = await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('X-Forwarded-For', '203.0.113.9')
    .send(getOffersCall());
  await settle();
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const lines = linesFor('mcp tools/call complete');
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.door, 'mcp');
  assert.equal(line.tool, 'get_offers');
  assert.equal(line.status, 200);
  assert.equal(line.caller_auth_mode, 'mcp_oauth');
  assert.equal(line.caller_oauth_client_id, 'mcpc_install_42');
  assert.equal(line.caller_oauth_issuer, ISS);
  assert.ok(!JSON.stringify(line).includes('m_1'), 'tool arguments are never logged');
});

test('an api-key agent calling a tool over /mcp is logged with its agent', async () => {
  captured.length = 0;
  introspectAs('agent_partner', PARTNER_KEY);
  backendOffersResolve();
  const res = await supertest(app)
    .post('/mcp')
    .set('X-Agent-API-Key', PARTNER_KEY)
    .set('Accept', 'application/json, text/event-stream')
    .set('X-Forwarded-For', '203.0.113.9')
    .send(getOffersCall());
  await settle();
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const [line] = linesFor('mcp tools/call complete');
  assert.ok(line, 'the tools/call line is logged');
  assert.equal(line.caller_auth_mode, 'api_key');
  assert.equal(line.caller_agent_id, 'agent_partner');
});

test('a non-tools/call MCP method logs no tools/call line', async () => {
  captured.length = 0;
  const token = await tokenFor({ client_id: 'mcpc_install_42' });
  await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await settle();
  assert.equal(linesFor('mcp tools/call complete').length, 0);
});

// ---- the caller-declared surface (2026-10-09) ----
//
// Pivota's own UI, its CI gates and its loopback self-calls share one service key, so the auth
// fields above cannot tell them apart. `metadata.source` and `metadata.invoked_by` are what the
// caller DECLARED; logged verbatim (bounded) so a census of market-less find_products_multi
// traffic reads the surface off the line instead of joining IP ranges to request logs.

test('the completion line carries the caller-declared source and invoked_by, bounded', async () => {
  captured.length = 0;
  introspectAs('agent_minds');
  await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', AGENT_KEY)
    .set('X-Forwarded-For', '203.0.113.9')
    .send({
      operation: 'no_such_operation',
      payload: {},
      metadata: { source: 'shopping_agent', invoked_by: `ci:${'x'.repeat(200)}` },
    });
  await settle();
  nock.cleanAll();
  const [line] = linesFor('invoke request complete');
  assert.ok(line, 'the completion line is logged');
  assert.equal(line.request_source, 'shopping_agent');
  assert.equal(line.invoked_by.length, 65, 'capped at 64 chars plus the ellipsis');
  assert.ok(line.invoked_by.startsWith('ci:xxx'));
});

test('a caller that declares no surface logs no surface keys at all', async () => {
  captured.length = 0;
  introspectAs('agent_minds');
  await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', AGENT_KEY)
    .set('X-Forwarded-For', '203.0.113.9')
    .send({ operation: 'no_such_operation', payload: {}, metadata: { source: '   ', invoked_by: 7 } });
  await settle();
  nock.cleanAll();
  const [line] = linesFor('invoke request complete');
  assert.ok(line, 'the completion line is logged');
  assert.equal('request_source' in line, false, 'blank is absent, not null');
  assert.equal('invoked_by' in line, false, 'a non-string is absent, not stringified');
});
